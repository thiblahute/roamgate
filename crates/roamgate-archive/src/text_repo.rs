//! The conversation text repo (archive/text-repo.ts): `<archive>/text.git`,
//! a bare git repo holding the conversation text of every archived
//! transcript, one line per message, searched with `git grep HEAD`. It is
//! derived: raw/ is the record, and `rebuild-text` builds it again.
//!
//! A pass renders what raw/ gained since the last one, from the byte
//! offsets the archive records (`files.archived_size` and `zst_size`, also
//! the zstd frame boundaries, so a grown file is decompressed from its last
//! frame only), and writes one commit with `git fast-import`. What the pass
//! knows about every file is `.roamgate/state.json` in the same commit.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Instant;

use indexmap::IndexMap;
use roamgate_agents::Agent;
use roamgate_agents::js::{js_trim, utf16_prefix};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::lines::CompleteLines;
use crate::lock::acquire_host_lock;
use crate::settings::{ArchiveSettings, IndexLevel, RuleSubject, index_level_for};
use crate::store::{Result, existing_archive_db};
use crate::sync::{FileKind, file_meta};
use crate::text_render::{
    DEFAULT_TOOL_CALL_CHARS, RENDER_VERSION, RenderOptions, RenderState, TextFileSubject,
    TextRenderer, header_line, suffixed_path, text_path,
};

pub const TEXT_REPO: &str = "text.git";
pub const STATE_PATH: &str = ".roamgate/state.json";
const BRANCH: &str = "refs/heads/main";
/// The lock name; host ids start with a letter or digit, so it never meets
/// one.
const LOCK: &str = "@text";
const REPACK_EVERY_MS: i64 = 24 * 60 * 60 * 1000;

pub fn text_repo_path(archive_dir: &Path) -> PathBuf {
    archive_dir.join(TEXT_REPO)
}

/// What the repo knows about one raw/ file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextFileState {
    pub path: String,
    /// Source bytes rendered: the end of the last complete line.
    #[serde(rename = "textBytes")]
    pub text_bytes: u64,
    /// A zstd frame boundary at or before textBytes.
    #[serde(rename = "seekSrc")]
    pub seek_src: u64,
    #[serde(rename = "seekZst")]
    pub seek_zst: u64,
    /// The .zst's inode when rendered: a shrunk source starts a new file.
    pub ino: u64,
    /// Lines in the text file, header included.
    pub lines: u64,
    pub render: RenderState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextState {
    pub version: u64,
    pub options: RenderOptions,
    pub files: IndexMap<String, TextFileState>,
    /// Secret-looking values replaced so far.
    pub redactions: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextRepoStatus {
    pub exists: bool,
    pub path: String,
    pub head: Option<String>,
    pub last_commit: Option<String>,
    pub last_repack: Option<String>,
    pub files: u64,
    pub redactions: u64,
    pub pack_bytes: u64,
    pub stale_render: bool,
}

/// What a pass did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextPassReport {
    /// committed, unchanged, locked, deferred (or failed, from the CLI).
    pub status: String,
    pub files: u64,
    pub lines: u64,
    pub redactions: u64,
    pub commit: Option<String>,
    pub repacked: bool,
    pub seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl TextPassReport {
    fn empty(status: &str, message: &str) -> Self {
        Self {
            status: status.into(),
            files: 0,
            lines: 0,
            redactions: 0,
            commit: None,
            repacked: false,
            seconds: 0.0,
            message: Some(message.into()),
        }
    }
}

/// What a pass works with.
pub struct TextPassOptions<'a> {
    pub archive_dir: &'a Path,
    pub settings: &'a ArchiveSettings,
    /// This machine's archive host id, for the committer.
    pub host: &'a str,
    pub log: &'a mut dyn FnMut(&str),
    /// Asked first: true defers the pass (GameMode runs).
    pub busy: Option<&'a dyn Fn() -> bool>,
    /// Milliseconds since the epoch (tests set it).
    pub now_ms: Option<i64>,
    /// Run the daily repack when due (default true).
    pub repack: bool,
}

pub fn render_options_for(settings: &ArchiveSettings) -> RenderOptions {
    RenderOptions {
        tool_call_chars: settings.text_tool_chars.unwrap_or(DEFAULT_TOOL_CALL_CHARS),
        thinking: settings.thinking,
    }
}

fn empty_state(options: RenderOptions) -> TextState {
    TextState {
        version: RENDER_VERSION,
        options,
        files: IndexMap::new(),
        redactions: 0,
    }
}

// ---------------------------------------------------------------- git

/// What git gave.
pub struct GitResult {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// The environment of every text repo git: none of the user's git config
/// or GIT_* variables, UTF-8, never prompting.
pub fn git_env() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| !key.starts_with("GIT_"))
        .filter(|(key, _)| !matches!(key.as_str(), "LC_ALL"))
        .collect();
    out.extend(
        [
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("LC_ALL", "C.UTF-8"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned())),
    );
    out
}

fn git_command(repo: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--git-dir")
        .arg(repo)
        .env_clear()
        .envs(git_env());
    command
}

/// Runs git on the bare repo, never prompting, never reading user hooks.
pub fn git(repo: &Path, args: &[&str], input: Option<&[u8]>) -> GitResult {
    let mut command = git_command(repo);
    command
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let Ok(mut child) = command.spawn() else {
        return GitResult {
            code: 1,
            stdout: Vec::new(),
            stderr: "git: not found".into(),
        };
    };
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    match child.wait_with_output() {
        Ok(output) => GitResult {
            code: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => GitResult {
            code: 1,
            stdout: Vec::new(),
            stderr: error.to_string(),
        },
    }
}

fn git_ok(repo: &Path, args: &[&str]) -> Result<String> {
    let result = git(repo, args, None);
    if result.code != 0 {
        return Err(crate::Error::msg(format!(
            "git {}: exit {} {}",
            args[0],
            result.code,
            utf16_prefix(js_trim(&result.stderr), 300)
        )));
    }
    Ok(js_trim(&String::from_utf8_lossy(&result.stdout)).to_owned())
}

pub fn init_text_repo(repo: &Path) -> Result<()> {
    roamgate_base::private::create_dir_all_mode(repo)?;
    if !repo.join("HEAD").exists() {
        git_ok(
            repo,
            &["init", "--bare", "--quiet", "--initial-branch=main"],
        )?;
    }
    for (key, value) in [
        ("gc.auto", "0"),
        ("core.commitGraph", "true"),
        ("fetch.writeCommitGraph", "true"),
        ("uploadpack.allowFilter", "true"),
    ] {
        git_ok(repo, &["config", key, value])?;
    }
    Ok(())
}

pub fn head_commit(repo: &Path) -> Option<String> {
    if !repo.join("HEAD").exists() {
        return None;
    }
    let result = git(repo, &["rev-parse", "--verify", "--quiet", BRANCH], None);
    (result.code == 0).then(|| js_trim(&String::from_utf8_lossy(&result.stdout)).to_owned())
}

/// A file of HEAD, or None.
pub fn read_head_file(repo: &Path, path: &str) -> Option<Vec<u8>> {
    let result = git(
        repo,
        &["cat-file", "blob", &format!("{BRANCH}:{path}")],
        None,
    );
    (result.code == 0).then_some(result.stdout)
}

pub fn read_text_state(repo: &Path) -> Option<TextState> {
    let raw = read_head_file(repo, STATE_PATH)?;
    serde_json::from_slice::<TextState>(&raw).ok()
}

// ------------------------------------------------------------ sources

/// One raw/ file the repo renders.
#[derive(Debug, Clone)]
pub struct TextSource {
    pub key: String,
    pub host: String,
    pub agent: Agent,
    pub relpath: String,
    pub history: bool,
    pub zst: PathBuf,
    /// Decompressed bytes archived, when the archive knows (a frame
    /// boundary).
    pub archived: Option<u64>,
    /// The .zst's size at that point.
    pub zst_size: Option<u64>,
}

fn renderable(agent: Option<Agent>, history: bool) -> Option<Agent> {
    agent.filter(|agent| agent.indexable() || history)
}

/// The raw/ files to render: from the archive database when it exists
/// (its offsets are frame boundaries), else every .zst under raw/. Files
/// whose index level is "none" are left out.
pub fn text_sources(archive_dir: &Path, settings: &ArchiveSettings) -> Result<Vec<TextSource>> {
    let raw = archive_dir.join("raw");
    let mut out = Vec::new();
    if let Some(db_path) = existing_archive_db(archive_dir) {
        let db = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(std::time::Duration::from_millis(30_000))?;
        let mut statement = db.prepare(
            "SELECT host, agent, relpath, kind, project, archived_size, zst_size, index_level
             FROM files ORDER BY host, agent, relpath",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        for row in rows {
            let (host, agent_id, relpath, kind, archived, zst_size, level) = row?;
            let history = kind == "history";
            let Some(agent) = renderable(Agent::from_id(&agent_id), history) else {
                continue;
            };
            if level == "none" {
                continue;
            }
            out.push(TextSource {
                key: format!("{host}/{agent_id}/{relpath}"),
                zst: raw
                    .join(&host)
                    .join(&agent_id)
                    .join(format!("{relpath}.zst")),
                host,
                agent,
                relpath,
                history,
                archived: Some(archived.max(0) as u64),
                zst_size: Some(zst_size.max(0) as u64),
            });
        }
        return Ok(out);
    }
    fn walk(raw: &Path, dir: &Path, settings: &ArchiveSettings, out: &mut Vec<TextSource>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(raw, &path, settings, out);
                continue;
            }
            if !kind.is_file() || !entry.file_name().to_string_lossy().ends_with(".zst") {
                continue;
            }
            let Ok(relative) = path.strip_prefix(raw) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            let mut parts = relative.split('/');
            let (Some(host), Some(agent_id)) = (parts.next(), parts.next()) else {
                continue;
            };
            let rest = parts.collect::<Vec<_>>().join("/");
            let relpath = rest.strip_suffix(".zst").unwrap_or(&rest).to_owned();
            if host.is_empty() || agent_id.is_empty() || relpath.is_empty() {
                continue;
            }
            let history = relpath.starts_with('@');
            let Some(agent) = renderable(Agent::from_id(agent_id), history) else {
                continue;
            };
            let project = if history {
                String::new()
            } else {
                agent.classify(&relpath).project
            };
            if index_level_for(
                settings,
                RuleSubject {
                    host,
                    agent: agent_id,
                    project: &project,
                },
            ) == IndexLevel::None
            {
                continue;
            }
            out.push(TextSource {
                key: format!("{host}/{agent_id}/{relpath}"),
                host: host.to_owned(),
                agent,
                relpath,
                history,
                zst: path.clone(),
                archived: None,
                zst_size: None,
            });
        }
    }
    walk(&raw, &raw, settings, &mut out);
    out.sort_by(|a, b| a.key.encode_utf16().cmp(b.key.encode_utf16()));
    Ok(out)
}

/// Decompressed bytes of a .zst from `seek_zst` (a frame boundary, at
/// source offset `seek_src`), skipping to `from`, up to `end` source bytes
/// when known.
struct RawRange {
    inner: Option<Box<dyn Read>>,
    offset: u64,
    from: u64,
    end: Option<u64>,
}

impl RawRange {
    fn open(
        zst: &Path,
        seek_zst: u64,
        seek_src: u64,
        from: u64,
        zst_end: Option<u64>,
        end: Option<u64>,
    ) -> std::io::Result<Self> {
        let inner = if zst_end.is_some_and(|zst_end| zst_end <= seek_zst) {
            None
        } else {
            Some(crate::zstd_frames::read_archived_range(
                zst, seek_zst, zst_end,
            )?)
        };
        Ok(Self {
            inner,
            offset: seek_src,
            from,
            end,
        })
    }
}

impl Read for RawRange {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let Some(inner) = self.inner.as_mut() else {
                return Ok(0);
            };
            if self.end.is_some_and(|end| self.offset >= end) {
                self.inner = None;
                return Ok(0);
            }
            let mut want = buf.len();
            if let Some(end) = self.end {
                want = want.min((end - self.offset) as usize);
            }
            let read = inner.read(&mut buf[..want])?;
            if read == 0 {
                self.inner = None;
                return Ok(0);
            }
            let start = self.offset;
            self.offset += read as u64;
            if self.offset <= self.from {
                continue;
            }
            if start < self.from {
                let skip = (self.from - start) as usize;
                buf.copy_within(skip..read, 0);
                return Ok(read - skip);
            }
            return Ok(read);
        }
    }
}

// ------------------------------------------------------------- render

/// What a render of a range gave.
#[derive(Debug, Clone)]
pub struct Rendered {
    pub lines: Vec<String>,
    pub text_bytes: u64,
    /// All source bytes read (the frame end when the read reached it).
    pub read_to: u64,
    pub render: RenderState,
    pub redactions: u64,
}

struct Counted<R> {
    inner: R,
    read: u64,
}

impl<R: Read> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.read += read as u64;
        Ok(read)
    }
}

/// Render the complete lines of `chunks` (starting at source byte `from`).
pub fn render_chunks(
    agent: Agent,
    history: bool,
    options: RenderOptions,
    saved: Option<&RenderState>,
    chunks: impl Read,
    from: u64,
) -> Result<Rendered> {
    let mut renderer = TextRenderer::new(agent, history, options, saved);
    let mut position = from;
    let mut counted = Counted {
        inner: chunks,
        read: 0,
    };
    let mut lines = CompleteLines::new(&mut counted);
    while let Some((line, length)) = lines.next_line() {
        position += length as u64;
        renderer.line(line);
    }
    if let Some(error) = lines.take_error() {
        return Err(error.into());
    }
    drop(lines);
    Ok(Rendered {
        render: renderer.save(),
        redactions: renderer.redactions,
        lines: std::mem::take(&mut renderer.lines),
        text_bytes: position,
        read_to: from + counted.read,
    })
}

// ------------------------------------------------------------ the pass

/// Paths are safe components joined with `/`; quoted only if ever needed.
fn quote_path(path: &str) -> String {
    let safe = path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '/' | '-'));
    if safe && !path.is_empty() {
        path.to_owned()
    } else {
        roamgate_agents::js::json_string(path)
    }
}

fn data_block(text: &str) -> String {
    format!("data {}\n{text}\n", text.len())
}

/// A `git fast-import` started at the first change.
struct FastImport {
    repo: PathBuf,
    header: String,
    child: Option<(Child, ChildStdin, std::thread::JoinHandle<String>)>,
}

impl FastImport {
    fn open(&mut self) -> Result<&mut ChildStdin> {
        if self.child.is_none() {
            let mut child = git_command(&self.repo)
                .args(["fast-import", "--quiet", "--done", "--force"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()?;
            let mut stdin = child.stdin.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let errors = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            });
            stdin.write_all(self.header.as_bytes())?;
            self.child = Some((child, stdin, errors));
        }
        Ok(&mut self.child.as_mut().unwrap().1)
    }

    fn used(&self) -> bool {
        self.child.is_some()
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        let line = format!("D {}\n", quote_path(path));
        self.open()?.write_all(line.as_bytes())?;
        Ok(())
    }

    fn write(&mut self, path: &str, content: &[u8]) -> Result<()> {
        let head = format!(
            "M 100644 inline {}\ndata {}\n",
            quote_path(path),
            content.len()
        );
        let sink = self.open()?;
        sink.write_all(head.as_bytes())?;
        sink.write_all(content)?;
        sink.write_all(b"\n")?;
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let line = format!("R {} {}\n", quote_path(from), quote_path(to));
        self.open()?.write_all(line.as_bytes())?;
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        let Some((mut child, mut stdin, errors)) = self.child.take() else {
            return Ok(());
        };
        stdin.write_all(b"\ndone\n")?;
        drop(stdin);
        let status = child.wait()?;
        let stderr = errors.join().unwrap_or_default();
        let code = crate::hosts::exit_code(status);
        if code != 0 {
            return Err(crate::Error::msg(format!(
                "git fast-import: exit {code} {}",
                utf16_prefix(js_trim(&stderr), 300)
            )));
        }
        Ok(())
    }

    fn abort(&mut self) {
        if let Some((mut child, stdin, _)) = self.child.take() {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct PassContext<'a> {
    repo: &'a Path,
    state: &'a mut TextState,
    /// Paths in HEAD: path to key, and each key's path in HEAD.
    owners: HashMap<String, String>,
    head_paths: HashMap<String, String>,
    out: FastImport,
    files: u64,
    lines: u64,
    redactions: u64,
    /// The state changed (offsets moved) even if no text did.
    dirty: bool,
}

fn head_content(ctx: &PassContext<'_>, key: &str) -> String {
    let Some(path) = ctx.head_paths.get(key) else {
        return String::new();
    };
    read_head_file(ctx.repo, path)
        .map(|raw| String::from_utf8_lossy(&raw).into_owned())
        .unwrap_or_default()
}

/// `a < b` on JavaScript strings.
fn js_less(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// Give `key` its path: the base path unless another raw/ file holds it.
/// Claimants are ordered by raw path; the first keeps the base, every
/// other takes the sha256 suffix, so a rebuild names every file the same.
fn claim(ctx: &mut PassContext<'_>, key: &str, base: &str) -> Result<String> {
    let holder = ctx.owners.get(base).cloned();
    match holder {
        None => {
            ctx.owners.insert(base.to_owned(), key.to_owned());
            Ok(base.to_owned())
        }
        Some(holder) if holder == key => Ok(base.to_owned()),
        Some(holder) if js_less(&holder, key) => {
            let mine = suffixed_path(base, key);
            ctx.owners.insert(mine.clone(), key.to_owned());
            Ok(mine)
        }
        Some(holder) => {
            let moved = suffixed_path(base, &holder);
            if let Some(held) = ctx.state.files.get_mut(&holder) {
                ctx.out.rename(base, &moved)?;
                held.path = moved.clone();
                ctx.owners.insert(moved, holder);
            }
            ctx.owners.insert(base.to_owned(), key.to_owned());
            Ok(base.to_owned())
        }
    }
}

#[cfg(unix)]
fn inode(metadata: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(metadata)
}

#[cfg(not(unix))]
fn inode(_metadata: &std::fs::Metadata) -> u64 {
    0
}

fn render_source(ctx: &mut PassContext<'_>, source: &TextSource) -> Result<()> {
    let Ok(metadata) = std::fs::metadata(&source.zst) else {
        return Ok(()); // Not archived yet.
    };
    let ino = inode(&metadata);
    let zst_now = metadata.len();
    let known = ctx.state.files.get(&source.key).cloned();
    let archived = source.archived;
    let fresh = match &known {
        None => true,
        Some(known) => {
            known.ino != ino
                || archived.is_some_and(|archived| archived < known.text_bytes)
                || zst_now < known.seek_zst
        }
    };
    if !fresh && archived.is_some() && archived == known.as_ref().map(|k| k.text_bytes) {
        return Ok(());
    }
    let zst_end = source.zst_size.unwrap_or(zst_now);
    if !fresh && archived.is_none() && Some(zst_end) == known.as_ref().map(|k| k.seek_zst) {
        return Ok(());
    }
    let (from, seek_src, seek_zst) = match (&known, fresh) {
        (Some(known), false) => (known.text_bytes, known.seek_src, known.seek_zst),
        _ => (0, 0, 0),
    };
    let rendered = (|| -> Result<Rendered> {
        let range = RawRange::open(
            &source.zst,
            seek_zst,
            seek_src,
            from,
            Some(zst_end),
            archived,
        )?;
        render_chunks(
            source.agent,
            source.history,
            ctx.state.options,
            if fresh {
                None
            } else {
                known.as_ref().map(|k| &k.render)
            },
            range,
            from,
        )
    })();
    // A frame being written, or damaged: the next pass retries.
    let Ok(rendered) = rendered else {
        return Ok(());
    };
    // The read reached the end of the last frame: a boundary to resume from.
    let end = archived.unwrap_or(rendered.read_to);
    let at_boundary = rendered.text_bytes == end;
    let kind = if source.history {
        FileKind::History
    } else {
        FileKind::Transcript
    };
    let meta = file_meta(source.agent, kind, &source.relpath);
    let subject = TextFileSubject {
        host: &source.host,
        agent: source.agent.id(),
        relpath: &source.relpath,
        history: source.history,
        project: &meta.project,
        session: &meta.session,
        subagent: meta.subagent,
    };
    let no_path = known.as_ref().is_some_and(|known| known.path.is_empty());
    if fresh || no_path {
        // A new file, or one with no text yet: its first lines get a path.
        if !fresh && Some(rendered.text_bytes) == known.as_ref().map(|k| k.text_bytes) {
            return Ok(());
        }
        let old = if fresh {
            known.as_ref().map(|k| k.path.clone()).unwrap_or_default()
        } else {
            String::new()
        };
        if !old.is_empty() {
            ctx.out.remove(&old)?;
            if ctx.owners.get(&old) == Some(&source.key) {
                ctx.owners.remove(&old);
            }
            ctx.head_paths.remove(&source.key);
        }
        let base = text_path(&subject, &rendered.render);
        let mut path = String::new();
        if let Some(base) = base.filter(|_| !rendered.lines.is_empty()) {
            path = claim(ctx, &source.key, &base)?;
            let body = format!(
                "{}\n{}\n",
                header_line(&source.key, &rendered.render),
                rendered.lines.join("\n")
            );
            ctx.out.write(&path, body.as_bytes())?;
        }
        let (seek_src, seek_zst) = if at_boundary {
            (end, zst_end)
        } else if fresh {
            (0, 0)
        } else {
            let known = known.as_ref().unwrap();
            (known.seek_src, known.seek_zst)
        };
        let lines = if path.is_empty() {
            0
        } else {
            rendered.lines.len() as u64 + 1
        };
        ctx.state.files.insert(
            source.key.clone(),
            TextFileState {
                path,
                text_bytes: rendered.text_bytes,
                seek_src,
                seek_zst,
                ino,
                lines,
                render: rendered.render.clone(),
            },
        );
    } else {
        let known = known.unwrap();
        if rendered.text_bytes == known.text_bytes {
            return Ok(());
        }
        let header = header_line(&source.key, &rendered.render);
        if !rendered.lines.is_empty() {
            let old = head_content(ctx, &source.key);
            let rest = match old.find('\n') {
                Some(index) => &old[index + 1..],
                None => old.as_str(),
            };
            let body = format!("{header}\n{rest}{}\n", rendered.lines.join("\n"));
            ctx.out.write(&known.path, body.as_bytes())?;
        }
        let entry = ctx.state.files.get_mut(&source.key).unwrap();
        entry.text_bytes = rendered.text_bytes;
        if at_boundary {
            entry.seek_src = end;
            entry.seek_zst = zst_end;
        }
        entry.lines += rendered.lines.len() as u64;
        entry.render = rendered.render.clone();
    }
    ctx.dirty = true;
    if !rendered.lines.is_empty() {
        ctx.files += 1;
    }
    ctx.lines += rendered.lines.len() as u64;
    ctx.redactions += rendered.redactions;
    Ok(())
}

fn commit_header(host: &str, message: &str, parent: Option<&str>, now_ms: i64) -> String {
    let when = format!("{} +0000", now_ms.div_euclid(1000));
    let mut out = format!(
        "commit {BRANCH}\ncommitter Roamgate <roamgate@{host}> {when}\n{}",
        data_block(message)
    );
    if let Some(parent) = parent {
        out.push_str(&format!("from {parent}\n"));
    }
    out
}

struct PassResult {
    files: u64,
    lines: u64,
    redactions: u64,
    commit: Option<String>,
}

fn run_pass(
    repo: &Path,
    host: &str,
    now_ms: i64,
    state: &mut TextState,
    sources: &[TextSource],
) -> Result<PassResult> {
    let parent = head_commit(repo);
    let mut owners = HashMap::new();
    let mut head_paths = HashMap::new();
    for (key, file) in &state.files {
        if file.path.is_empty() {
            continue;
        }
        owners.insert(file.path.clone(), key.clone());
        head_paths.insert(key.clone(), file.path.clone());
    }
    let mut ctx = PassContext {
        repo,
        state,
        owners,
        head_paths,
        out: FastImport {
            repo: repo.to_path_buf(),
            header: commit_header(host, "Archive text", parent.as_deref(), now_ms),
            child: None,
        },
        files: 0,
        lines: 0,
        redactions: 0,
        dirty: false,
    };
    let result = (|| -> Result<bool> {
        for source in sources {
            render_source(&mut ctx, source)?;
        }
        // A first pass commits even with nothing to render: the repo exists.
        if !ctx.dirty && !ctx.out.used() && parent.is_some() {
            return Ok(false);
        }
        ctx.state.redactions += ctx.redactions;
        let body = format!("{}\n", serde_json::to_string(&*ctx.state)?);
        ctx.out.write(STATE_PATH, body.as_bytes())?;
        ctx.out.finish()?;
        Ok(true)
    })();
    match result {
        Ok(false) => Ok(PassResult {
            files: 0,
            lines: 0,
            redactions: 0,
            commit: None,
        }),
        Ok(true) => Ok(PassResult {
            files: ctx.files,
            lines: ctx.lines,
            redactions: ctx.redactions,
            commit: head_commit(repo),
        }),
        Err(error) => {
            ctx.out.abort();
            Err(error)
        }
    }
}

fn repack_stamp(repo: &Path) -> PathBuf {
    repo.join("roamgate-repack")
}

/// `git repack -d --geometric=2` and the commit-graph, once a day.
pub fn maybe_repack(repo: &Path, now_ms: i64, force: bool) -> Result<bool> {
    let last = std::fs::read_to_string(repack_stamp(repo))
        .ok()
        .and_then(|text| crate::parse_iso_ms(js_trim(&text)))
        .unwrap_or(0);
    if !force && now_ms - last < REPACK_EVERY_MS {
        return Ok(false);
    }
    git_ok(repo, &["repack", "-d", "-q", "--geometric=2"])?;
    git_ok(repo, &["commit-graph", "write", "--reachable"])?;
    crate::write_private(
        &repack_stamp(repo),
        format!("{}\n", crate::iso_ms(now_ms)).as_bytes(),
    )?;
    Ok(true)
}

/// The hourly pass: render what raw/ gained into one commit, then the
/// daily repack. Deferred while `busy` says so; skipped while another
/// pass runs.
pub fn update_text_repo(options: TextPassOptions<'_>) -> Result<TextPassReport> {
    let started = Instant::now();
    if options.busy.is_some_and(|busy| busy()) {
        return Ok(TextPassReport::empty(
            "deferred",
            "deferred while GameMode runs",
        ));
    }
    let Some(_lock) = acquire_host_lock(options.archive_dir, LOCK)? else {
        return Ok(TextPassReport::empty(
            "locked",
            "another text pass is running",
        ));
    };
    let repo = text_repo_path(options.archive_dir);
    init_text_repo(&repo)?;
    let current = render_options_for(options.settings);
    let mut state = match read_text_state(&repo) {
        None => empty_state(current),
        Some(state) => {
            if state.version != RENDER_VERSION || state.options != current {
                (options.log)(
                    "archive text: the render settings changed; `roamgate archive rebuild-text` applies them",
                );
            }
            state
        }
    };
    let now_ms = options.now_ms.unwrap_or_else(crate::now_ms);
    let sources = text_sources(options.archive_dir, options.settings)?;
    let result = run_pass(&repo, options.host, now_ms, &mut state, &sources)?;
    let repacked = if options.repack {
        maybe_repack(&repo, options.now_ms.unwrap_or_else(crate::now_ms), false)?
    } else {
        false
    };
    Ok(TextPassReport {
        status: if result.commit.is_some() {
            "committed"
        } else {
            "unchanged"
        }
        .into(),
        files: result.files,
        lines: result.lines,
        redactions: result.redactions,
        commit: result.commit,
        repacked,
        seconds: started.elapsed().as_secs_f64(),
        message: None,
    })
}

/// Build the repo again from raw/ with the current render settings, beside
/// the old one, then swap it in. The old history is dropped: it is derived.
pub fn rebuild_text_repo(options: TextPassOptions<'_>) -> Result<TextPassReport> {
    let started = Instant::now();
    let Some(_lock) = acquire_host_lock(options.archive_dir, LOCK)? else {
        return Ok(TextPassReport::empty(
            "locked",
            "another text pass is running",
        ));
    };
    let repo = text_repo_path(options.archive_dir);
    let next = PathBuf::from(format!("{}.new", repo.display()));
    let old = PathBuf::from(format!("{}.old", repo.display()));
    let result = (|| -> Result<TextPassReport> {
        let _ = std::fs::remove_dir_all(&next);
        init_text_repo(&next)?;
        let mut state = empty_state(render_options_for(options.settings));
        let sources = text_sources(options.archive_dir, options.settings)?;
        (options.log)(&format!(
            "archive text: rendering {} file(s)",
            sources.len()
        ));
        let now_ms = options.now_ms.unwrap_or_else(crate::now_ms);
        let result = run_pass(&next, options.host, now_ms, &mut state, &sources)?;
        maybe_repack(&next, now_ms, true)?;
        let _ = std::fs::remove_dir_all(&old);
        if repo.exists() {
            std::fs::rename(&repo, &old)?;
        }
        std::fs::rename(&next, &repo)?;
        let _ = std::fs::remove_dir_all(&old);
        Ok(TextPassReport {
            status: if result.commit.is_some() {
                "committed"
            } else {
                "unchanged"
            }
            .into(),
            files: result.files,
            lines: result.lines,
            redactions: result.redactions,
            commit: result.commit,
            repacked: true,
            seconds: started.elapsed().as_secs_f64(),
            message: None,
        })
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&next);
    }
    result
}

fn pack_bytes(repo: &Path) -> u64 {
    fn walk(dir: &Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match entry.file_type() {
                Ok(kind) if kind.is_dir() => walk(&entry.path()),
                _ => std::fs::metadata(entry.path())
                    .map(|m| m.len())
                    .unwrap_or(0),
            })
            .sum()
    }
    walk(&repo.join("objects"))
}

pub fn text_repo_status(archive_dir: &Path, settings: &ArchiveSettings) -> TextRepoStatus {
    let repo = text_repo_path(archive_dir);
    let path = repo.to_string_lossy().into_owned();
    let Some(head) = head_commit(&repo) else {
        return TextRepoStatus {
            exists: false,
            path,
            head: None,
            last_commit: None,
            last_repack: None,
            files: 0,
            redactions: 0,
            pack_bytes: 0,
            stale_render: false,
        };
    };
    let state = read_text_state(&repo);
    let when = git(&repo, &["log", "-1", "--format=%cI", BRANCH], None);
    let last_repack = std::fs::read_to_string(repack_stamp(&repo))
        .ok()
        .map(|text| js_trim(&text).to_owned())
        .filter(|text| !text.is_empty());
    let current = render_options_for(settings);
    TextRepoStatus {
        exists: true,
        path,
        head: Some(head),
        last_commit: (when.code == 0)
            .then(|| js_trim(&String::from_utf8_lossy(&when.stdout)).to_owned()),
        last_repack,
        files: state.as_ref().map_or(0, |state| state.files.len() as u64),
        redactions: state.as_ref().map_or(0, |state| state.redactions),
        pack_bytes: pack_bytes(&repo),
        stale_render: state
            .as_ref()
            .is_some_and(|state| state.version != RENDER_VERSION || state.options != current),
    }
}

/// Where the archive home keeps its text repo, as an scp-like ssh path.
pub fn remote_text_repo(ssh: &str, remote_dir: Option<&str>) -> String {
    let dir = remote_dir.unwrap_or("~/.config/roamgate/archive");
    let dir = dir.strip_prefix("~/").unwrap_or(dir);
    format!("{ssh}:{}/{TEXT_REPO}", dir.trim_end_matches('/'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FetchReport {
    pub updated: bool,
    pub head: Option<String>,
}

/// Fetch the archive home's text repo over ssh (read-only, never pushed
/// back) into this machine's archive, for local search.
pub fn fetch_text_repo(
    archive_dir: &Path,
    ssh: &str,
    ssh_options: &[&str],
    remote_dir: Option<&str>,
    ssh_program: &str,
) -> Result<FetchReport> {
    let repo = text_repo_path(archive_dir);
    init_text_repo(&repo)?;
    let before = head_commit(&repo);
    let ssh_command = std::iter::once(ssh_program)
        .chain(ssh_options.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let config = format!("core.sshCommand={ssh_command}");
    let remote = remote_text_repo(ssh, remote_dir);
    let refspec = format!("+{BRANCH}:{BRANCH}");
    let result = git(
        &repo,
        &[
            "-c",
            &config,
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            &remote,
            &refspec,
        ],
        None,
    );
    if result.code != 0 {
        return Err(crate::Error::msg(format!(
            "git fetch {ssh}: exit {} {}",
            result.code,
            utf16_prefix(js_trim(&result.stderr), 300)
        )));
    }
    crate::write_private(
        &repo.join("roamgate-fetched"),
        format!("{}\n", crate::iso_ms(crate::now_ms())).as_bytes(),
    )?;
    let head = head_commit(&repo);
    Ok(FetchReport {
        updated: head != before,
        head,
    })
}

/// Since the last fetch from the archive home, in milliseconds.
pub fn text_repo_age_ms(archive_dir: &Path) -> f64 {
    std::fs::metadata(text_repo_path(archive_dir).join("roamgate-fetched"))
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| std::time::SystemTime::now().duration_since(modified).ok())
        .map_or(f64::INFINITY, |age| age.as_secs_f64() * 1000.0)
}
