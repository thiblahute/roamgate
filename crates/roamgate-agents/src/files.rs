//! `session-file-access.ts`: how transcripts are read, on this machine or
//! over a connection's SSH (through a runner the caller gives: in the core,
//! the front's `host.run`).

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};

use regex::Regex;
use roamgate_base::assets::{self, TemplateValue};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::js;
use crate::session::SessionFile;
use crate::utils::basename;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

const SESSION_FILE_TIMEOUT_MS: u64 = 15_000;
const SESSION_READ_TIMEOUT_MS: u64 = 60_000;
const KEPT_TEXT_BYTES: usize = 64 * 1024 * 1024;
const KEPT_TEXT_OVERLAP: usize = 4096;
/// How long stats wait for others to share one SSH command with.
pub const STAT_BATCH_WINDOW_MS: u64 = 25;
const STAT_BATCH_PATHS: usize = 64;

/// How a transcript is read (`AgentSessionFileAccess`).
pub trait SessionFiles: Send + Sync {
    fn remote(&self) -> bool;
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>>;
    fn read_text<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<String>>;
    fn read_prefix<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>>;
    fn read_tail<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>>;
    /// Whether large transcripts are read in ranges (`readRange`).
    fn has_range(&self) -> bool {
        true
    }
    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>>;
    fn read_download<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>>;
    fn find_pi_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>>;
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        cwd: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>>;
    fn find_claude_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>>;
    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>>;
    fn find_codex_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>>;
}

pub fn other(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

/// A Codex session id, whole.
pub fn validate_codex_session_id(id: &str) -> io::Result<()> {
    static ID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap());
    if ID.is_match(id) {
        Ok(())
    } else {
        Err(other("Enter a complete Codex session ID."))
    }
}

fn valid_claude_session_id(id: &str) -> bool {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").unwrap());
    ID.is_match(id)
}

/// The directory Pi keeps a working directory's sessions in.
pub fn pi_session_directory_name(cwd: &str) -> Option<String> {
    if !cwd.starts_with('/') || cwd.contains(['"', '$', '`', '\\', '\n']) {
        return None;
    }
    Some(format!("--{}--", cwd[1..].replace('/', "-")))
}

/// The environment the readers look agents' homes up in.
#[derive(Debug, Clone, Default)]
pub struct AgentEnv {
    pub home: PathBuf,
    pub vars: HashMap<String, String>,
}

impl AgentEnv {
    pub fn from_process() -> Self {
        Self {
            home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default(),
            vars: std::env::vars().collect(),
        }
    }

    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    /// A configured directory (`~` and `~/` taken from home), or `default`.
    pub fn dir(&self, name: &str, default: impl FnOnce(&Path) -> PathBuf) -> PathBuf {
        let configured = self.var(name).map(js::trim).unwrap_or("");
        if configured.is_empty() {
            return default(&self.home);
        }
        if configured == "~" {
            return self.home.clone();
        }
        if let Some(rest) = configured.strip_prefix("~/") {
            return self.home.join(rest);
        }
        crate::paths::resolve(configured)
    }

    pub fn codex_home(&self) -> PathBuf {
        self.dir("CODEX_HOME", |home| home.join(".codex"))
    }

    pub fn pi_agent_dir(&self) -> PathBuf {
        self.dir("PI_CODING_AGENT_DIR", |home| home.join(".pi").join("agent"))
    }
}

/// A file's facts as Node's stat gives them.
pub fn session_file_of(path: &str, meta: &std::fs::Metadata) -> SessionFile {
    #[cfg(unix)]
    let (identity, change) = {
        use std::os::unix::fs::MetadataExt;
        let ctime = meta.ctime() as f64 * 1000.0 + meta.ctime_nsec() as f64 / 1e6;
        (
            format!("{}:{}", meta.dev(), meta.ino()),
            js::number_text(ctime),
        )
    };
    // The change time, as Node's ctimeMs; the modification time where it
    // cannot be read.
    #[cfg(not(unix))]
    let (identity, change) = (
        String::from("0:0"),
        js::number_text(
            roamgate_base::paths::change_time_ms(Path::new(path))
                .unwrap_or_else(|| crate::paths::mtime_ms(meta)),
        ),
    );
    SessionFile {
        path: path.to_owned(),
        mtime_ms: crate::paths::mtime_ms(meta),
        size: Some(meta.len() as f64),
        identity: Some(identity),
        change_token: Some(change),
        ..Default::default()
    }
}

/// A local file's facts, or None when it is not a file.
pub fn local_stat(path: &str) -> Option<SessionFile> {
    let meta = std::fs::metadata(path).ok()?;
    meta.is_file().then(|| session_file_of(path, &meta))
}

/// This machine's transcripts.
#[derive(Debug, Clone, Default)]
pub struct LocalSessionFiles {
    pub env: AgentEnv,
}

fn read_range_sync(path: &str, start: u64, end: u64) -> io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    if end <= start {
        return Ok(Vec::new());
    }
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut out = Vec::new();
    file.take(end - start).read_to_end(&mut out)?;
    Ok(out)
}

fn blocking<'a, T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> BoxFut<'a, io::Result<T>> {
    Box::pin(async move {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(io::Error::other)?
    })
}

impl SessionFiles for LocalSessionFiles {
    fn remote(&self) -> bool {
        false
    }

    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let path = path.to_owned();
        blocking(move || Ok(local_stat(&path)))
    }

    fn read_text<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<String>> {
        let path = path.to_owned();
        blocking(move || Ok(String::from_utf8_lossy(&std::fs::read(&path)?).into_owned()))
    }

    fn read_prefix<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let path = path.to_owned();
        blocking(move || read_range_sync(&path, 0, limit))
    }

    fn read_tail<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let path = path.to_owned();
        blocking(move || {
            let size = match std::fs::metadata(&path) {
                Ok(meta) => meta.len(),
                // A missing file reads as empty, as Bun's does.
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(error),
            };
            read_range_sync(&path, size.saturating_sub(limit), size)
        })
    }

    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let path = path.to_owned();
        blocking(move || read_range_sync(&path, start, end))
    }

    fn read_download<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let path = path.to_owned();
        blocking(move || std::fs::read(&path))
    }

    fn find_pi_session_by_id<'a>(
        &'a self,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }

    fn find_pi_session_for_cwd<'a>(
        &'a self,
        cwd: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let dir = pi_session_directory_name(cwd)
            .map(|name| self.env.pi_agent_dir().join("sessions").join(name));
        blocking(move || {
            let Some(dir) = dir else { return Ok(None) };
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return Ok(None);
            };
            let mut newest: Option<SessionFile> = None;
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let path = dir.join(&name).to_string_lossy().into_owned();
                if let Some(file) = local_stat(&path)
                    && newest.as_ref().is_none_or(|n| file.mtime_ms > n.mtime_ms)
                {
                    newest = Some(file);
                }
            }
            Ok(newest)
        })
    }

    fn find_claude_session_by_id<'a>(
        &'a self,
        _id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }

    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        let (path, id) = (path.to_owned(), id.to_owned());
        Box::pin(async move {
            if cfg!(windows) || !valid_claude_session_id(&id) {
                return Ok(None);
            }
            let output = tokio::time::timeout(
                std::time::Duration::from_millis(SESSION_FILE_TIMEOUT_MS),
                tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(assets::CLAUDE_SUCCESSOR_SH)
                    .env("f", &path)
                    .env("id", &id)
                    .stdin(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| other("claude successor search timed out"))??;
            let found = js::trim(&String::from_utf8_lossy(&output.stdout)).to_owned();
            Ok((!found.is_empty()).then_some(found))
        })
    }

    fn find_codex_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let id = id.to_owned();
        let home = self.env.codex_home();
        blocking(move || {
            validate_codex_session_id(&id)?;
            let suffix = format!("-{id}.jsonl");
            let mut found: Option<PathBuf> = None;
            for directory in ["sessions", "archived_sessions"] {
                let root = home.join(directory);
                let mut stack = vec![root];
                while let Some(dir) = stack.pop() {
                    let Ok(entries) = std::fs::read_dir(&dir) else {
                        continue;
                    };
                    for entry in entries.filter_map(Result::ok) {
                        let Ok(kind) = entry.file_type() else {
                            continue;
                        };
                        if kind.is_dir() {
                            stack.push(entry.path());
                        } else if kind.is_file()
                            && entry.file_name().to_string_lossy().ends_with(&suffix)
                        {
                            if found.is_some() {
                                return Err(other(
                                    "Multiple transcripts match this Codex session ID.",
                                ));
                            }
                            found = Some(entry.path());
                        }
                    }
                }
            }
            Ok(found.and_then(|p| local_stat(&p.to_string_lossy())))
        })
    }
}

// ---------------------------------------------------------------- remote

/// What a command run on the host gave.
#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Runs a command on the connection's host (its SSH): in the core, the
/// front's `host.run`.
pub trait HostRunner: Send + Sync {
    fn run(&self, argv: Vec<String>, timeout_ms: u64) -> BoxFut<'_, Result<RunOutput, String>>;
}

fn failure(output: &RunOutput, what: &str) -> io::Error {
    let text = if !output.stderr.is_empty() {
        output.stderr.clone()
    } else if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        format!("{what} exited {}", output.code)
    };
    other(js::head16(js::trim(&text), 1000))
}

fn parse_remote_metadata(text: &str) -> Option<SessionFile> {
    let line = js::trim(text);
    let mut parts = line.split('\t');
    let (size, mtime, raw_path) = (parts.next()?, parts.next()?, parts.next()?);
    let identity = parts.next().map(str::to_owned);
    let change = parts.next().map(str::to_owned);
    if raw_path.is_empty() {
        return None;
    }
    let decoded = base64_decode(raw_path)?;
    let path = String::from_utf8_lossy(&decoded).into_owned();
    if path.is_empty() {
        return None;
    }
    let size = js::number_from_text(size);
    let mtime = js::number_from_text(mtime);
    if !size.is_finite() || !mtime.is_finite() {
        return None;
    }
    Some(SessionFile {
        path,
        size: Some(size),
        mtime_ms: mtime * 1000.0,
        identity,
        change_token: change,
        ..Default::default()
    })
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

type StatWaiter = oneshot::Sender<io::Result<Option<SessionFile>>>;

struct StatBatch {
    /// Which batch this is: a timer sends only its own.
    id: u64,
    paths: Vec<(String, Vec<StatWaiter>)>,
}

struct Kept {
    identity: String,
    bytes: Vec<u8>,
}

/// A connection's transcripts over its SSH.
pub struct RemoteSessionFiles {
    runner: Arc<dyn HostRunner>,
    kept_budget: usize,
    batch: Arc<Mutex<Option<StatBatch>>>,
    batches: std::sync::atomic::AtomicU64,
    kept: Mutex<(Vec<(String, Kept)>, usize)>,
}

impl RemoteSessionFiles {
    pub fn new(runner: Arc<dyn HostRunner>) -> Arc<Self> {
        Self::with_budget(runner, KEPT_TEXT_BYTES)
    }

    /// With `kept_budget` bytes of transcripts kept in all.
    pub fn with_budget(runner: Arc<dyn HostRunner>, kept_budget: usize) -> Arc<Self> {
        Arc::new(Self {
            runner,
            kept_budget,
            batch: Arc::new(Mutex::new(None)),
            batches: std::sync::atomic::AtomicU64::new(0),
            kept: Mutex::new((Vec::new(), 0)),
        })
    }

    async fn run_remote(&self, command: String, timeout_ms: u64) -> io::Result<Vec<u8>> {
        let output = self
            .runner
            .run(vec!["bash".into(), "-lc".into(), command], timeout_ms)
            .await
            .map_err(other)?;
        if output.code != 0 {
            return Err(failure(&output, "remote session command"));
        }
        Ok(output.stdout)
    }

    async fn flush_stats(runner: Arc<dyn HostRunner>, batch: StatBatch) {
        let mut argv = vec![
            "bash".into(),
            "-c".into(),
            assets::STAT_BATCH_SH.into(),
            "stat".into(),
        ];
        argv.extend(batch.paths.iter().map(|(path, _)| path.clone()));
        let result = runner.run(argv, SESSION_FILE_TIMEOUT_MS).await;
        match result {
            Ok(output) if output.code == 0 => {
                let text = String::from_utf8_lossy(&output.stdout).into_owned();
                let lines: Vec<&str> = text.split('\n').collect();
                for (index, (path, waiters)) in batch.paths.into_iter().enumerate() {
                    let line = lines.get(index).copied().unwrap_or("");
                    let answer = || -> io::Result<Option<SessionFile>> {
                        if line == "-" {
                            return Ok(None);
                        }
                        if let Some(rest) = line.strip_prefix('+') {
                            return match parse_remote_metadata(rest) {
                                Some(file) if file.path == path => Ok(Some(file)),
                                _ => Err(other("remote session stat answered badly")),
                            };
                        }
                        Err(other(format!("remote session stat failed: {path}")))
                    };
                    for waiter in waiters {
                        let _ = waiter.send(answer());
                    }
                }
            }
            Ok(output) => {
                let message = failure(&output, "remote session stat").to_string();
                for (_, waiters) in batch.paths {
                    for waiter in waiters {
                        let _ = waiter.send(Err(other(message.clone())));
                    }
                }
            }
            Err(error) => {
                for (_, waiters) in batch.paths {
                    for waiter in waiters {
                        let _ = waiter.send(Err(other(error.clone())));
                    }
                }
            }
        }
    }

    async fn find_remote(
        &self,
        id: &str,
        root: &str,
        names: &str,
        label: &str,
    ) -> io::Result<Option<SessionFile>> {
        let quote = roamgate_exec::quote::shell_quote;
        let command = assets::fill_template(
            assets::FIND_SESSION_SH,
            &[
                ("id", TemplateValue::from(quote(id))),
                ("root", TemplateValue::from(root.to_owned())),
                ("names", TemplateValue::from(names.to_owned())),
            ],
        )
        .map_err(|e| other(e.to_string()))?;
        let output = self
            .runner
            .run(
                vec!["bash".into(), "-lc".into(), command],
                SESSION_FILE_TIMEOUT_MS,
            )
            .await
            .map_err(other)?;
        if output.code == 44 {
            return Ok(None);
        }
        if output.code != 0 {
            return Err(failure(&output, &format!("remote {label} session search")));
        }
        Ok(parse_remote_metadata(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    fn forget(kept: &mut (Vec<(String, Kept)>, usize), path: &str) {
        if let Some(at) = kept.0.iter().position(|(p, _)| p == path) {
            let (_, old) = kept.0.remove(at);
            kept.1 -= old.bytes.len();
        }
    }

    async fn read_remote_bytes(&self, path: &str) -> io::Result<Vec<u8>> {
        for _ in 0..2 {
            let old = {
                let kept = self.kept.lock().unwrap();
                kept.0
                    .iter()
                    .find(|(p, _)| p == path)
                    .map(|(_, k)| (k.identity.clone(), k.bytes.clone()))
            };
            let overlap = old
                .as_ref()
                .map_or(0, |(_, b)| KEPT_TEXT_OVERLAP.min(b.len()));
            let quote = roamgate_exec::quote::shell_quote;
            let known_bytes = old.as_ref().map_or(0, |(_, b)| b.len());
            let command = assets::fill_template(
                assets::READ_SESSION_TAIL_SH,
                &[
                    ("path", TemplateValue::from(quote(path))),
                    (
                        "known",
                        TemplateValue::from(quote(match &old {
                            Some((identity, _)) if overlap > 0 => identity,
                            _ => "",
                        })),
                    ),
                    ("known_bytes", TemplateValue::from(known_bytes.to_string())),
                    (
                        "known_sha256",
                        TemplateValue::from(quote(
                            &old.as_ref()
                                .map_or(String::new(), |(_, b)| hex::encode(Sha256::digest(b))),
                        )),
                    ),
                    (
                        "tail_from",
                        TemplateValue::from((known_bytes as i64 - overlap as i64 + 1).to_string()),
                    ),
                ],
            )
            .map_err(|e| other(e.to_string()))?;
            let output = self.run_remote(command, SESSION_READ_TIMEOUT_MS).await?;
            let newline = output.iter().position(|&b| b == b'\n');
            let head = String::from_utf8_lossy(&output[..newline.unwrap_or(0)]).into_owned();
            let mut fields = head.split('\t');
            let identity = fields.next().unwrap_or("").to_owned();
            let mode = fields.next().unwrap_or("");
            let body = &output[newline.map_or(0, |n| n + 1)..];
            let bytes = if mode == "tail" {
                let Some((_, old_bytes)) = &old else {
                    Self::forget(&mut self.kept.lock().unwrap(), path);
                    continue;
                };
                let seen = &old_bytes[old_bytes.len() - overlap..];
                if body.len() < overlap || &body[..overlap] != seen {
                    Self::forget(&mut self.kept.lock().unwrap(), path);
                    continue;
                }
                let mut all = old_bytes.clone();
                all.extend_from_slice(&body[overlap..]);
                all
            } else {
                body.to_vec()
            };
            let mut kept = self.kept.lock().unwrap();
            Self::forget(&mut kept, path);
            if !identity.is_empty() && bytes.len() <= self.kept_budget {
                kept.1 += bytes.len();
                kept.0.push((
                    path.to_owned(),
                    Kept {
                        identity,
                        bytes: bytes.clone(),
                    },
                ));
                while kept.1 > self.kept_budget && !kept.0.is_empty() {
                    let (_, gone) = kept.0.remove(0);
                    kept.1 -= gone.bytes.len();
                }
            }
            return Ok(bytes);
        }
        Err(other("remote transcript changed while reading"))
    }
}

impl SessionFiles for RemoteSessionFiles {
    fn remote(&self) -> bool {
        true
    }

    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let (send, receive) = oneshot::channel();
        {
            let mut slot = self.batch.lock().unwrap();
            if slot.is_none() {
                let id = self
                    .batches
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                *slot = Some(StatBatch {
                    id,
                    paths: Vec::new(),
                });
                let batch = self.batch.clone();
                let runner = self.runner.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(STAT_BATCH_WINDOW_MS))
                        .await;
                    let taken = {
                        let mut slot = batch.lock().unwrap();
                        if slot.as_ref().is_some_and(|b| b.id == id) {
                            slot.take()
                        } else {
                            None
                        }
                    };
                    if let Some(taken) = taken {
                        Self::flush_stats(runner, taken).await;
                    }
                });
            }
            let batch = slot.as_mut().unwrap();
            match batch.paths.iter_mut().find(|(p, _)| p == path) {
                Some((_, waiters)) => waiters.push(send),
                None => batch.paths.push((path.to_owned(), vec![send])),
            }
            if batch.paths.len() >= STAT_BATCH_PATHS {
                let full = slot.take().unwrap();
                let runner = self.runner.clone();
                tokio::spawn(Self::flush_stats(runner, full));
            }
        }
        Box::pin(async move {
            receive
                .await
                .map_err(|_| other("remote session stat dropped"))?
        })
    }

    fn read_text<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<String>> {
        Box::pin(async move {
            Ok(String::from_utf8_lossy(&self.read_remote_bytes(path).await?).into_owned())
        })
    }

    fn read_prefix<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let quote = roamgate_exec::quote::shell_quote;
        let command = format!("set -eu\nhead -c {} {}", limit.max(1), quote(path));
        Box::pin(self.run_remote(command, SESSION_FILE_TIMEOUT_MS))
    }

    fn read_tail<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let quote = roamgate_exec::quote::shell_quote;
        let command = format!("set -eu\ntail -c {} {}", limit.max(1), quote(path));
        Box::pin(self.run_remote(command, SESSION_FILE_TIMEOUT_MS))
    }

    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let quote = roamgate_exec::quote::shell_quote;
        let length = end as i64 - start as i64;
        let command = format!(
            "set -eu\ntail -c +{} {} | head -c {length}",
            start + 1,
            quote(path)
        );
        Box::pin(async move {
            if length <= 0 {
                return Ok(Vec::new());
            }
            self.run_remote(command, SESSION_READ_TIMEOUT_MS).await
        })
    }

    fn read_download<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let quote = roamgate_exec::quote::shell_quote;
        Box::pin(self.run_remote(
            format!("set -eu\ncat {}", quote(path)),
            SESSION_FILE_TIMEOUT_MS,
        ))
    }

    fn find_pi_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(self.find_remote(
            id,
            "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions",
            "-name \"$id.jsonl\" -o -name \"*_$id.jsonl\"",
            "Pi",
        ))
    }

    fn find_pi_session_for_cwd<'a>(
        &'a self,
        cwd: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async move {
            let Some(name) = pi_session_directory_name(cwd) else {
                return Ok(None);
            };
            self.find_remote(
                "",
                &format!("${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions/{name}"),
                "-name \"*.jsonl\"",
                "Pi",
            )
            .await
        })
    }

    fn find_claude_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async move {
            if !valid_claude_session_id(id) {
                return Ok(None);
            }
            self.find_remote(
                id,
                "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects",
                "-name \"$id.jsonl\"",
                "Claude",
            )
            .await
        })
    }

    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        Box::pin(async move {
            if !valid_claude_session_id(id) {
                return Ok(None);
            }
            let quote = roamgate_exec::quote::shell_quote;
            let command = format!(
                "f={}\nid={}\n{}",
                quote(path),
                quote(id),
                assets::CLAUDE_SUCCESSOR_SH
            );
            let found = self.run_remote(command, SESSION_FILE_TIMEOUT_MS).await?;
            let found = js::trim(&String::from_utf8_lossy(&found)).to_owned();
            Ok((!found.is_empty()).then_some(found))
        })
    }

    fn find_codex_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async move {
            validate_codex_session_id(id)?;
            let quote = roamgate_exec::quote::shell_quote;
            let command = format!(
                "python3 -c {} {}",
                quote(assets::CODEX_SESSION_FIND_PY),
                quote(id)
            );
            let path = self.run_remote(command, SESSION_FILE_TIMEOUT_MS).await?;
            let path = js::trim(&String::from_utf8_lossy(&path)).to_owned();
            if path.is_empty() {
                return Ok(None);
            }
            self.stat_file(&path).await
        })
    }
}

/// The base name of a transcript without `.jsonl`.
pub fn session_name(path: &str) -> String {
    basename(path)
        .strip_suffix(".jsonl")
        .unwrap_or(basename(path))
        .to_owned()
}

#[cfg(test)]
mod tests;
