//! Find an archived session, read it back, put it back for its agent
//! (archive/session.ts).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use roamgate_agents::{Agent, map_cwd};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::hosts::{ArchiveRuntime, ResolvedHost, SSH_OPTIONS, local_root, sh_quote};
use crate::lines::CompleteLines;
use crate::store::Result;
use crate::sync::zst_path;
use crate::zstd_frames::read_archived;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionFileInfo {
    pub relpath: String,
    pub subagent: bool,
    pub archived_size: u64,
    pub src_size: Option<u64>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCopy {
    pub host: String,
    pub project: String,
    pub main_size: u64,
    pub last_ts: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candidate {
    pub session: String,
    pub agent: String,
    pub title: Option<String>,
}

/// What the archive holds of a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLookup {
    pub session: String,
    pub found: bool,
    pub agent: Option<String>,
    pub host: Option<String>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
    pub files: Vec<SessionFileInfo>,
    /// Every host holding a copy; the first is the one described above.
    pub copies: Vec<SessionCopy>,
    /// The session exists in this machine's agent directory already.
    pub live: bool,
    pub restorable: bool,
    /// What to run to continue it (after restoring), if the agent can.
    pub resume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Candidate>>,
}

impl SessionLookup {
    fn empty(session: &str) -> Self {
        Self {
            session: session.to_owned(),
            found: false,
            agent: None,
            host: None,
            project: None,
            cwd: None,
            title: None,
            first_ts: None,
            last_ts: None,
            files: Vec::new(),
            copies: Vec::new(),
            live: false,
            restorable: false,
            resume: None,
            candidates: None,
        }
    }
}

#[derive(Debug, Clone)]
struct LookupRow {
    host: String,
    agent: String,
    relpath: String,
    project: Option<String>,
    session: String,
    subagent: bool,
    title: Option<String>,
    cwd: Option<String>,
    src_size: Option<i64>,
    archived_size: i64,
    first_ts: Option<String>,
    last_ts: Option<String>,
}

/// Filters of a lookup, and this machine, to tell whether the session is
/// live here.
#[derive(Default)]
pub struct LookupOptions<'a> {
    pub agent: Option<String>,
    pub host: Option<String>,
    pub runtime: Option<&'a ArchiveRuntime>,
    pub self_host: Option<&'a ResolvedHost>,
}

static SESSION_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-z-]{4,80}$").unwrap());

fn non_empty(value: &Option<String>) -> Option<&String> {
    value.as_ref().filter(|value| !value.is_empty())
}

/// The session whose id starts with `prefix`, with every copy of it.
pub fn lookup_session(
    db: &Connection,
    prefix: &str,
    options: &LookupOptions<'_>,
) -> Result<SessionLookup> {
    let clean = roamgate_agents::js::js_lower(roamgate_agents::js::js_trim(prefix));
    let result = SessionLookup::empty(&clean);
    if !SESSION_PREFIX.is_match(&clean) {
        return Ok(result);
    }
    let mut filters = vec![
        "kind = 'transcript'".to_owned(),
        "lower(session) LIKE ?1 || '%'".to_owned(),
    ];
    let mut params: Vec<String> = vec![clean.clone()];
    if let Some(agent) = &options.agent {
        params.push(agent.clone());
        filters.push(format!("agent = ?{}", params.len()));
    }
    if let Some(host) = &options.host {
        params.push(host.clone());
        filters.push(format!("host = ?{}", params.len()));
    }
    let mut statement = db.prepare(&format!(
        "SELECT id, host, agent, relpath, project, session, subagent, title, cwd, src_size, archived_size, first_ts, last_ts
         FROM files WHERE {} ORDER BY subagent, relpath",
        filters.join(" AND ")
    ))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(LookupRow {
                host: row.get(1)?,
                agent: row.get(2)?,
                relpath: row.get(3)?,
                project: row.get(4)?,
                session: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                subagent: row.get::<_, i64>(6)? != 0,
                title: row.get(7)?,
                cwd: row.get(8)?,
                src_size: row.get(9)?,
                archived_size: row.get(10)?,
                first_ts: row.get(11)?,
                last_ts: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut sessions: IndexMap<String, Vec<LookupRow>> = IndexMap::new();
    for row in rows {
        let key = format!(
            "{}:{}",
            row.agent,
            roamgate_agents::js::js_lower(&row.session)
        );
        sessions.entry(key).or_default().push(row);
    }
    if sessions.is_empty() {
        return Ok(result);
    }
    if sessions.len() > 1 {
        let suffix = format!(":{clean}");
        let exact = sessions
            .iter()
            .find(|(key, _)| key.ends_with(&suffix))
            .map(|(k, v)| (k.clone(), v.clone()));
        match exact {
            None => {
                return Ok(SessionLookup {
                    candidates: Some(
                        sessions
                            .values()
                            .take(10)
                            .map(|group| Candidate {
                                session: group[0].session.clone(),
                                agent: group[0].agent.clone(),
                                title: group.iter().find_map(|r| non_empty(&r.title).cloned()),
                            })
                            .collect(),
                    ),
                    ..result
                });
            }
            Some((key, group)) => {
                sessions.clear();
                sessions.insert(key, group);
            }
        }
    }
    let group = sessions.into_values().next().unwrap();
    let agent_id = group[0].agent.clone();
    let mut by_host: IndexMap<String, Vec<LookupRow>> = IndexMap::new();
    for row in &group {
        by_host
            .entry(row.host.clone())
            .or_default()
            .push(row.clone());
    }
    let mut copies: Vec<SessionCopy> = by_host
        .iter()
        .map(|(host, list)| {
            let main_size = list
                .iter()
                .filter(|r| !r.subagent)
                .map(|r| r.archived_size.max(0) as u64)
                .max()
                .unwrap_or(0);
            let last_ts = list
                .iter()
                .map(|r| r.last_ts.clone().unwrap_or_default())
                .max_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()))
                .filter(|ts| !ts.is_empty());
            SessionCopy {
                host: host.clone(),
                project: list[0].project.clone().unwrap_or_default(),
                main_size,
                last_ts,
            }
        })
        .collect();
    copies.sort_by(|a, b| {
        b.main_size.cmp(&a.main_size).then_with(|| {
            b.last_ts
                .as_deref()
                .unwrap_or("")
                .cmp(a.last_ts.as_deref().unwrap_or(""))
        })
    });
    let best = copies[0].clone();
    let rows_of_best = &by_host[&best.host];
    let main = rows_of_best
        .iter()
        .find(|r| !r.subagent)
        .unwrap_or(&rows_of_best[0]);
    let agent = Agent::from_id(&agent_id);
    let files: Vec<SessionFileInfo> = rows_of_best
        .iter()
        .map(|r| SessionFileInfo {
            relpath: r.relpath.clone(),
            subagent: r.subagent,
            archived_size: r.archived_size.max(0) as u64,
            src_size: r.src_size.map(|size| size.max(0) as u64),
            complete: r.src_size == Some(r.archived_size),
        })
        .collect();
    let mut live = false;
    if let (Some(runtime), Some(me), Some(agent)) = (options.runtime, options.self_host, agent)
        && !main.subagent
    {
        let target = agent.restore_relpath(&main.relpath, &runtime.home_dir.to_string_lossy());
        live = local_root(agent, me, runtime).join(target).exists();
    }
    let has_main = rows_of_best.iter().any(|r| !r.subagent);
    let cwd = rows_of_best.iter().find_map(|r| non_empty(&r.cwd).cloned());
    let session = main.session.clone();
    Ok(SessionLookup {
        session: session.clone(),
        found: true,
        agent: Some(agent_id),
        host: Some(best.host.clone()),
        project: main.project.clone(),
        cwd: cwd.clone(),
        title: rows_of_best
            .iter()
            .rev()
            .find_map(|r| non_empty(&r.title).cloned()),
        first_ts: {
            let mut stamps: Vec<String> = rows_of_best
                .iter()
                .filter_map(|r| non_empty(&r.first_ts).cloned())
                .collect();
            stamps.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            stamps.into_iter().next()
        },
        last_ts: best.last_ts.clone(),
        files,
        copies,
        live,
        restorable: agent.is_some_and(Agent::supports_resume) && has_main && !live,
        resume: agent.and_then(|agent| agent.resume_command(&session)),
        candidates: None,
    })
}

/// Where an archived file's compressed copy lives.
pub fn archived_path(archive_dir: &Path, host: &str, agent: &str, relpath: &str) -> PathBuf {
    zst_path(archive_dir, host, agent, relpath)
}

/// The decompressed bytes of one of a session's files, exactly as archived.
pub fn cat_file(
    archive_dir: &Path,
    lookup: &SessionLookup,
    relpath: Option<&str>,
) -> Result<Box<dyn Read>> {
    let (true, Some(host), Some(agent)) = (lookup.found, &lookup.host, &lookup.agent) else {
        return Err(crate::Error::msg("session not found"));
    };
    let file = match relpath {
        Some(relpath) => lookup.files.iter().find(|f| f.relpath == relpath),
        None => lookup.files.iter().find(|f| !f.subagent),
    };
    let Some(file) = file else {
        return Err(crate::Error::msg(match relpath {
            Some(relpath) => format!("no such file in the session: {relpath}"),
            None => "the session has no main file".into(),
        }));
    };
    Ok(Box::new(read_archived(&archived_path(
        archive_dir,
        host,
        agent,
        &file.relpath,
    ))?))
}

/// Lines of a file read a piece at a time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineSlice {
    pub lines: Vec<String>,
    pub next: Option<u64>,
    pub truncated: bool,
}

/// Lines [from, from + limit) of a file (1-based), at most `max_bytes` of
/// them (counted in UTF-16 units, as `text.length`).
pub fn cat_lines(chunks: impl Read, from: u64, limit: usize, max_bytes: usize) -> LineSlice {
    let mut out = LineSlice {
        lines: Vec::new(),
        next: None,
        truncated: false,
    };
    let mut index = 0u64;
    let mut bytes = 0usize;
    let mut lines = CompleteLines::new(chunks);
    while let Some((line, _)) = lines.next_line() {
        index += 1;
        if index < from {
            continue;
        }
        if out.lines.len() >= limit {
            out.next = Some(index);
            return out;
        }
        let text = String::from_utf8_lossy(line).into_owned();
        let length = roamgate_agents::js::utf16_len(&text);
        if bytes + length > max_bytes {
            out.truncated = true;
            out.next = Some(index);
            return out;
        }
        bytes += length;
        out.lines.push(text);
    }
    out
}

/// The last record of a file that carries a uuid.
fn tail_record(path: &Path) -> Option<Map<String, Value>> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let length = size.min(4 * 1024 * 1024);
    file.seek(SeekFrom::Start(size - length)).ok()?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer);
    for line in text.split('\n').rev() {
        if roamgate_agents::js::js_trim(line).is_empty() {
            continue;
        }
        let Some(Value::Object(record)) = roamgate_agents::js::parse_line(line.as_bytes()) else {
            continue;
        };
        let typed = matches!(
            record.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        );
        if record.get("uuid").is_some_and(Value::is_string) && typed {
            return Some(record);
        }
    }
    None
}

pub fn restored_note(host: &str, cwd: Option<&str>) -> String {
    let at = cwd
        .filter(|c| !c.is_empty())
        .map(|cwd| format!(" in {cwd}"))
        .unwrap_or_default();
    format!(
        "[Roamgate] This session was restored from another computer ({host}) by the session archive. It was recorded there{at}: file paths, installed tools and the environment may differ on this machine. Check before relying on them."
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreAction {
    pub relpath: String,
    pub path: String,
    /// restored or exists.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResumeResult {
    pub session: String,
    pub agent: String,
    pub from_host: String,
    pub cwd: Option<String>,
    pub note_appended: bool,
    pub restored: Vec<RestoreAction>,
    /// Run in `cwd` to continue the session.
    pub command: Option<String>,
    pub message: String,
}

/// Where a session file reads from: this archive, or another machine's.
pub trait FileSource {
    fn open(&self, lookup: &SessionLookup, relpath: &str) -> Result<Box<dyn Read>>;
}

/// This archive.
pub struct LocalFileSource<'a>(pub &'a Path);

impl FileSource for LocalFileSource<'_> {
    fn open(&self, lookup: &SessionLookup, relpath: &str) -> Result<Box<dyn Read>> {
        cat_file(self.0, lookup, Some(relpath))
    }
}

/// Files of an archive on another machine, streamed through `roamgate
/// archive cat`.
pub struct SshFileSource {
    pub ssh: String,
    pub binary: String,
}

impl SshFileSource {
    pub fn new(ssh: &str) -> Self {
        Self {
            ssh: ssh.to_owned(),
            binary: "\"$HOME/.local/bin/roamgate\"".into(),
        }
    }
}

struct ChildOutput {
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    ssh: String,
    done: bool,
}

impl Read for ChildOutput {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.stdout.read(buf)?;
        if read == 0 && !self.done {
            self.done = true;
            let status = self.child.wait()?;
            let code = crate::hosts::exit_code(status);
            if code != 0 {
                return Err(std::io::Error::other(format!(
                    "ssh {}: archive cat exited {code}",
                    self.ssh
                )));
            }
        }
        Ok(read)
    }
}

impl FileSource for SshFileSource {
    fn open(&self, lookup: &SessionLookup, relpath: &str) -> Result<Box<dyn Read>> {
        let command = format!(
            "exec {} archive cat {} --agent {} --host {} --file {}",
            self.binary,
            sh_quote(&lookup.session),
            sh_quote(lookup.agent.as_deref().unwrap_or("")),
            sh_quote(lookup.host.as_deref().unwrap_or("")),
            sh_quote(relpath)
        );
        let mut child = std::process::Command::new("ssh")
            .args(SSH_OPTIONS)
            .arg(&self.ssh)
            .arg(command)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        Ok(Box::new(ChildOutput {
            child,
            stdout,
            ssh: self.ssh.clone(),
            done: false,
        }))
    }
}

/// Writes a new file, never replacing one: false when it exists.
fn write_new(dest: &Path, mut chunks: Box<dyn Read>) -> Result<bool> {
    let dir = dest.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(".{}.restoring", uuid::Uuid::new_v4()));
    let result = (|| -> Result<bool> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        std::io::copy(&mut chunks, &mut file)?;
        file.flush()?;
        drop(file);
        match std::fs::hard_link(&temporary, dest) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.into()),
        }
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

/// What a resume works with.
pub struct ResumeOptions<'a> {
    pub runtime: &'a ArchiveRuntime,
    pub self_host: &'a ResolvedHost,
    pub source: &'a dyn FileSource,
    pub dry_run: bool,
    /// The note's time, `toISOString()`.
    pub now: String,
}

/// Put a session back into this machine's agent directory, only for files
/// that do not exist there (never an overwrite), mapping the project
/// directory to this machine's home, and say so in the conversation.
pub fn resume_session(lookup: &SessionLookup, options: &ResumeOptions<'_>) -> Result<ResumeResult> {
    let (true, Some(agent_id), Some(host)) = (lookup.found, &lookup.agent, &lookup.host) else {
        return Err(crate::Error::msg("session not found in the archive"));
    };
    let Some(agent) = Agent::from_id(agent_id) else {
        return Err(crate::Error::msg(format!("unknown agent: {agent_id}")));
    };
    let home = options.runtime.home_dir.to_string_lossy().into_owned();
    let cwd = lookup
        .cwd
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|cwd| map_cwd(cwd, &home));
    let mut result = ResumeResult {
        session: lookup.session.clone(),
        agent: agent_id.clone(),
        from_host: host.clone(),
        cwd: cwd.clone(),
        note_appended: false,
        restored: Vec::new(),
        command: None,
        message: String::new(),
    };
    if !agent.supports_resume() {
        result.message = format!(
            "{} sessions are archived but cannot be restored automatically; read one with: roamgate archive cat {} --agent {agent_id}",
            agent.label(),
            lookup.session
        );
        return Ok(result);
    }
    let root = local_root(agent, options.self_host, options.runtime);
    let mut main_path: Option<PathBuf> = None;
    for file in &lookup.files {
        let relpath = agent.restore_relpath(&file.relpath, &home);
        let path = root.join(&relpath);
        if path.exists() {
            result.restored.push(RestoreAction {
                relpath,
                path: path.to_string_lossy().into_owned(),
                status: "exists".into(),
            });
            continue;
        }
        if !options.dry_run {
            write_new(&path, options.source.open(lookup, &file.relpath)?)?;
        }
        result.restored.push(RestoreAction {
            relpath,
            path: path.to_string_lossy().into_owned(),
            status: "restored".into(),
        });
        if !file.subagent {
            main_path = Some(path);
        }
    }
    if let Some(main_path) = main_path.filter(|_| !options.dry_run && agent == Agent::Claude) {
        let last = tail_record(&main_path);
        let field = |key: &str| {
            last.as_ref()
                .and_then(|l| l.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let mut record = Map::new();
        record.insert(
            "parentUuid".into(),
            field("uuid").map_or(Value::Null, Value::String),
        );
        record.insert("isSidechain".into(), Value::Bool(false));
        record.insert("userType".into(), Value::String("external".into()));
        record.insert(
            "cwd".into(),
            Value::String(
                cwd.clone()
                    .or_else(|| field("cwd"))
                    .unwrap_or_else(|| home.clone()),
            ),
        );
        record.insert("sessionId".into(), Value::String(lookup.session.clone()));
        if let Some(version) = field("version") {
            record.insert("version".into(), Value::String(version));
        }
        if let Some(branch) = field("gitBranch") {
            record.insert("gitBranch".into(), Value::String(branch));
        }
        record.insert("type".into(), Value::String("user".into()));
        let mut message = Map::new();
        message.insert("role".into(), Value::String("user".into()));
        message.insert(
            "content".into(),
            Value::String(restored_note(host, lookup.cwd.as_deref())),
        );
        record.insert("message".into(), Value::Object(message));
        record.insert(
            "uuid".into(),
            Value::String(uuid::Uuid::new_v4().to_string()),
        );
        record.insert("timestamp".into(), Value::String(options.now.clone()));
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .append(true)
            .open(&main_path)?;
        let existing = file.metadata()?.len();
        let mut prefix = "";
        if existing > 0 {
            let mut last_byte = [0u8; 1];
            let mut reader = std::fs::File::open(&main_path)?;
            reader.seek(SeekFrom::Start(existing - 1))?;
            reader.read_exact(&mut last_byte)?;
            if last_byte[0] != b'\n' {
                prefix = "\n";
            }
        }
        file.write_all(
            format!(
                "{prefix}{}\n",
                serde_json::to_string(&Value::Object(record))?
            )
            .as_bytes(),
        )?;
        result.note_appended = true;
    }
    let command = agent.resume_command(&lookup.session);
    let here = result
        .restored
        .iter()
        .filter(|r| r.status == "restored")
        .count();
    result.message = if here == 0 {
        "everything is here already: nothing was restored".into()
    } else {
        let continue_with = match &command {
            Some(command) => format!(
                "; continue with: {}{command}",
                cwd.as_deref()
                    .map(|cwd| format!("cd {cwd} && "))
                    .unwrap_or_default()
            ),
            None => String::new(),
        };
        format!("restored {here} file(s) from {host}{continue_with}")
    };
    result.command = command;
    Ok(result)
}
