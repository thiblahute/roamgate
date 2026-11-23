//! Copy, compress and record session files (archive/sync.ts). Never deletes
//! anything.

use std::io::Read;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use roamgate_agents::extract::UnknownTypes;
use roamgate_agents::js::parse_line;
use roamgate_agents::{Agent, Mode, ParseState};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::lines::{CompleteLines, file_range};
use crate::settings::{ArchiveSettings, RuleSubject, any_rule_matches, index_level_for};
use crate::store::{Result, set_meta};
use crate::zstd_frames::append_frame_at;

/// What one sync did to one agent's files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncStats {
    pub new: u64,
    pub grown: u64,
    pub same: u64,
    pub shrunk: u64,
    pub replaced: u64,
    pub error: u64,
    pub excluded: u64,
    pub docs: u64,
    /// Source bytes compressed in this run.
    pub bytes: u64,
    pub unknown: IndexMap<String, u64>,
}

/// One agent's files of one host.
#[derive(Debug, Clone)]
pub struct SyncSource {
    pub host: String,
    pub agent: Agent,
    /// The directory holding the session files.
    pub root: PathBuf,
    /// Single files outside the root (the Claude prompt history).
    pub extra: Vec<(PathBuf, String)>,
}

pub struct SyncContext<'a> {
    pub db: &'a Connection,
    pub archive_dir: &'a Path,
    pub settings: &'a ArchiveSettings,
    pub log: &'a mut dyn FnMut(&str),
}

pub fn zst_path(archive_dir: &Path, host: &str, agent: &str, relpath: &str) -> PathBuf {
    archive_dir
        .join("raw")
        .join(host)
        .join(agent)
        .join(format!("{relpath}.zst"))
}

const HUGE_LINE: usize = 100_000;

/// A session file found under a root.
#[derive(Debug, Clone)]
pub struct Listed {
    pub path: PathBuf,
    pub relpath: String,
    pub size: u64,
    /// Seconds (`mtimeMs / 1000`).
    pub mtime: f64,
}

/// Modification time in seconds, as `stat.mtimeMs / 1000`.
pub fn mtime_seconds(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_secs_f64())
}

/// Session files under `root`, as relative paths with `/`, sorted.
pub fn list_files(root: &Path, agent: Agent) -> Vec<Listed> {
    fn walk(root: &Path, dir: &Path, agent: Agent, out: &mut Vec<Listed>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                walk(root, &path, agent, out);
            } else if kind.is_file() {
                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let relpath = relative.to_string_lossy().replace('\\', "/");
                if !agent.accepts(&relpath) {
                    continue;
                }
                if let Ok(metadata) = std::fs::metadata(&path) {
                    out.push(Listed {
                        size: metadata.len(),
                        mtime: mtime_seconds(&metadata),
                        path,
                        relpath,
                    });
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, agent, &mut out);
    // `a.relpath < b.relpath`: UTF-16 order.
    out.sort_by(|a, b| a.relpath.encode_utf16().cmp(b.relpath.encode_utf16()));
    out
}

fn keep_old_copy(zst: &Path, mtime: f64) -> std::io::Result<()> {
    if !zst.exists() {
        return Ok(());
    }
    let base = format!("{}.{}", zst.display(), mtime.trunc() as i64);
    let mut keep = PathBuf::from(&base);
    let mut n = 1;
    while keep.exists() {
        keep = PathBuf::from(format!("{base}.{n}"));
        n += 1;
    }
    std::fs::rename(zst, keep)
}

/// File or prompt history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Transcript,
    History,
}

impl FileKind {
    pub fn name(self) -> &'static str {
        match self {
            FileKind::Transcript => "transcript",
            FileKind::History => "history",
        }
    }
}

pub struct ScanTarget<'a> {
    pub db: &'a Connection,
    pub file_id: i64,
    pub agent: Agent,
    pub kind: FileKind,
    pub thinking: bool,
    pub unknown: &'a mut UnknownTypes,
}

/// What the row knew before a scan.
#[derive(Debug, Clone, Default)]
pub struct Known {
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>,
}

/// Whether a line is one of the huge request mirrors that are skipped.
pub fn huge_request(line: &[u8]) -> bool {
    line.len() > HUGE_LINE && {
        let head: String = line[..400].iter().map(|&b| b as char).collect();
        head.contains("\"type\":\"api-request")
    }
}

/// Reads the complete lines of `chunks` (which start at byte `start` of the
/// source) for what the archive keeps about a session: its title, cost,
/// working directory, project and first and last time, and how far it was
/// read. Returns the new position and the messages seen.
pub fn scan_lines(
    target: ScanTarget<'_>,
    chunks: impl Read,
    start: u64,
    known: &Known,
) -> Result<(u64, u64)> {
    let mut state = ParseState::new(target.thinking);
    state.unknown = std::mem::take(target.unknown);
    state.cwd = known.cwd.clone().filter(|cwd| !cwd.is_empty());
    let mut title: Option<String> = None;
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut position = start;
    let mut docs = 0u64;
    let mut lines = CompleteLines::new(chunks);
    while let Some((line, length)) = lines.next_line() {
        position += length as u64;
        if target.kind == FileKind::History || line.is_empty() || huge_request(line) {
            continue;
        }
        let Some(record) = parse_line(line) else {
            continue;
        };
        if let Some(ts) = target
            .agent
            .timestamp_of(&record)
            .filter(|ts| !ts.is_empty())
        {
            if first_ts.is_none() {
                first_ts = Some(ts.clone());
            }
            last_ts = Some(ts);
        }
        for doc in target.agent.parse(&record, &mut state) {
            if doc.kind == "title" {
                title = Some(doc.text);
            }
            docs += 1;
        }
    }
    *target.unknown = std::mem::take(&mut state.unknown);
    if let Some(error) = lines.take_error() {
        return Err(error.into());
    }
    target.db.execute(
        "UPDATE files SET indexed_bytes = ?1, title = COALESCE(?2, title), cost_usd = COALESCE(?3, cost_usd),
           cwd = COALESCE(?4, cwd), project = COALESCE(NULLIF(project, ''), ?5, project),
           first_ts = COALESCE(first_ts, ?6), last_ts = COALESCE(?7, last_ts) WHERE id = ?8",
        params![
            position as i64,
            title.or_else(|| known.title.clone()),
            state.cost.as_ref().and_then(serde_json::Number::as_f64),
            state.cwd,
            state.project,
            first_ts,
            last_ts,
            target.file_id
        ],
    )?;
    Ok((position, docs))
}

/// A live SQLite file copied with `VACUUM INTO` into a temporary
/// directory, removed when dropped.
struct Snapshot {
    dir: tempfile::TempDir,
}

impl Snapshot {
    fn take(source: &Path) -> Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("roamgate-archive-")
            .tempdir()?;
        let copy = dir.path().join("snapshot.db");
        let live = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        live.execute("VACUUM INTO ?1", params![copy.to_string_lossy()])?;
        Ok(Self { dir })
    }

    fn path(&self) -> PathBuf {
        self.dir.path().join("snapshot.db")
    }
}

/// A file a sync looks at.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub relpath: String,
    pub size: u64,
    pub mtime: f64,
    pub kind: FileKind,
}

struct FileRow {
    id: i64,
    src_size: Option<i64>,
    src_mtime: Option<f64>,
    archived_size: i64,
    zst_size: i64,
    indexed_bytes: i64,
    title: Option<String>,
    cwd: Option<String>,
    project: Option<String>,
}

/// The project, session and subagent flag of a file of `kind`.
pub fn file_meta(agent: Agent, kind: FileKind, relpath: &str) -> roamgate_agents::FileMeta {
    match kind {
        FileKind::History => roamgate_agents::FileMeta {
            project: String::new(),
            session: "history".into(),
            subagent: false,
        },
        FileKind::Transcript => agent.classify(relpath),
    }
}

pub fn sync_one_file(
    ctx: &mut SyncContext<'_>,
    source: &SyncSource,
    file: &Candidate,
    stats: &mut SyncStats,
    unknown: &mut UnknownTypes,
) -> Result<()> {
    let db = ctx.db;
    let agent = source.agent;
    let host = source.host.as_str();
    let row = db
        .query_row(
            "SELECT id, src_size, src_mtime, archived_size, zst_size, indexed_bytes, title, cwd, project, index_level
             FROM files WHERE host = ?1 AND agent = ?2 AND relpath = ?3",
            params![host, agent.id(), file.relpath],
            |row| {
                Ok(FileRow {
                    id: row.get(0)?,
                    src_size: row.get(1)?,
                    src_mtime: row.get(2)?,
                    archived_size: row.get(3)?,
                    zst_size: row.get(4)?,
                    indexed_bytes: row.get(5)?,
                    title: row.get(6)?,
                    cwd: row.get(7)?,
                    project: row.get(8)?,
                })
            },
        )
        .optional()?;
    let size = file.size as i64;
    if let Some(row) = &row
        && row.src_size == Some(size)
        && row.src_mtime.unwrap_or(0.0).trunc() == file.mtime.trunc()
        && row.archived_size == size
    {
        stats.same += 1;
        return Ok(());
    }
    if let Some(row) = &row
        && agent.mode() == Mode::Append
        && row.archived_size == size
        && row.src_size == Some(size)
    {
        // Same bytes, new mtime (touched, or rebuilt from the raw files).
        db.execute(
            "UPDATE files SET src_mtime = ?1 WHERE id = ?2",
            params![file.mtime, row.id],
        )?;
        stats.same += 1;
        return Ok(());
    }
    let meta = file_meta(agent, file.kind, &file.relpath);
    let level = index_level_for(
        ctx.settings,
        RuleSubject {
            host,
            agent: agent.id(),
            project: &meta.project,
        },
    );
    let zst = zst_path(ctx.archive_dir, host, agent.id(), &file.relpath);
    #[derive(PartialEq)]
    enum Outcome {
        New,
        Grown,
        Shrunk,
        Replaced,
    }
    let file_id;
    let outcome;
    let mut from = 0u64;
    let mut keep = 0u64;
    let mut index_from = 0u64;
    match &row {
        None => {
            db.execute(
                "INSERT INTO files(host, agent, relpath, kind, project, session, subagent, index_level)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    host,
                    agent.id(),
                    file.relpath,
                    file.kind.name(),
                    meta.project,
                    meta.session,
                    meta.subagent as i64,
                    level.name()
                ],
            )?;
            file_id = db.last_insert_rowid();
            outcome = Outcome::New;
            if zst.exists() {
                keep_old_copy(&zst, 0.0)?;
            }
        }
        Some(row) => {
            file_id = row.id;
            if agent.mode() == Mode::Replace || size < row.archived_size {
                keep_old_copy(&zst, row.src_mtime.unwrap_or(0.0))?;
                db.execute(
                    "UPDATE files SET indexed_bytes = 0 WHERE id = ?1",
                    params![file_id],
                )?;
                outcome = if agent.mode() == Mode::Replace {
                    Outcome::Replaced
                } else {
                    Outcome::Shrunk
                };
            } else {
                from = row.archived_size as u64;
                keep = row.zst_size as u64;
                index_from = row.indexed_bytes as u64;
                outcome = Outcome::Grown;
            }
        }
    }
    let current = match (&row, &outcome) {
        (Some(row), Outcome::Grown) => Known {
            title: row.title.clone(),
            cwd: row.cwd.clone(),
            project: row.project.clone(),
        },
        _ => Known {
            title: None,
            cwd: None,
            project: Some(
                row.as_ref()
                    .and_then(|row| row.project.clone())
                    .unwrap_or_else(|| meta.project.clone()),
            ),
        },
    };
    let snapshot = if agent.snapshot_sqlite() {
        Some(Snapshot::take(&file.path)?)
    } else {
        None
    };
    let (source_path, source_size) = match &snapshot {
        Some(snapshot) => {
            let path = snapshot.path();
            let size = std::fs::metadata(&path)?.len();
            (path, size)
        }
        None => (file.path.clone(), file.size),
    };
    let frame = append_frame_at(&source_path, from, source_size, &zst, keep)?;
    db.execute(
        "UPDATE files SET src_size = ?1, src_mtime = ?2, archived_size = ?3, zst_size = ?4 WHERE id = ?5",
        params![
            size,
            file.mtime,
            source_size as i64,
            (keep + frame.zst_bytes) as i64,
            file_id
        ],
    )?;
    stats.bytes += frame.bytes;
    if agent.indexable() || file.kind == FileKind::History {
        let (_, docs) = scan_lines(
            ScanTarget {
                db,
                file_id,
                agent,
                kind: file.kind,
                thinking: ctx.settings.thinking,
                unknown,
            },
            file_range(&file.path, index_from, source_size)?,
            index_from,
            &current,
        )?;
        stats.docs += docs;
    }
    match outcome {
        Outcome::New => stats.new += 1,
        Outcome::Grown => stats.grown += 1,
        Outcome::Shrunk => stats.shrunk += 1,
        Outcome::Replaced => stats.replaced += 1,
    }
    drop(snapshot);
    Ok(())
}

/// Sync one agent's files of one host. Per-file failures are counted, not
/// returned.
pub fn sync_source(
    ctx: &mut SyncContext<'_>,
    source: &SyncSource,
    stats: &mut SyncStats,
    unknown: &mut UnknownTypes,
) {
    let agent = source.agent;
    let host = source.host.as_str();
    let mut candidates = Vec::new();
    for file in list_files(&source.root, agent) {
        let project = agent.classify(&file.relpath).project;
        if any_rule_matches(
            &ctx.settings.exclude,
            RuleSubject {
                host,
                agent: agent.id(),
                project: &project,
            },
        ) {
            stats.excluded += 1;
            continue;
        }
        candidates.push(Candidate {
            path: file.path,
            relpath: file.relpath,
            size: file.size,
            mtime: file.mtime,
            kind: FileKind::Transcript,
        });
    }
    for (path, relpath) in &source.extra {
        if let Ok(metadata) = std::fs::metadata(path) {
            candidates.push(Candidate {
                path: path.clone(),
                relpath: relpath.clone(),
                size: metadata.len(),
                mtime: mtime_seconds(&metadata),
                kind: FileKind::History,
            });
        }
    }
    let total = candidates.len();
    for (done, file) in candidates.iter().enumerate() {
        if let Err(error) = sync_one_file(ctx, source, file, stats, unknown) {
            stats.error += 1;
            (ctx.log)(&format!(
                "error: {host}/{}/{}: {error}",
                agent.id(),
                file.relpath
            ));
        }
        if (done + 1) % 200 == 0 {
            (ctx.log)(&format!(
                "  {host}/{}: {}/{total} files",
                agent.id(),
                done + 1
            ));
        }
    }
    for (kind, count) in unknown.iter() {
        *stats
            .unknown
            .entry(format!("{}:{kind}", agent.id()))
            .or_insert(0) += count;
    }
}

/// The run reached the host and finished: its times, errors and unknown
/// record types.
pub fn record_sync(
    db: &Connection,
    host: &str,
    agent: &str,
    stats: &SyncStats,
    stamp: &str,
) -> Result<()> {
    set_meta(db, &format!("last_attempt:{host}"), stamp)?;
    set_meta(db, &format!("last_attempt:{host}:{agent}"), stamp)?;
    set_meta(db, &format!("last_sync:{host}"), stamp)?;
    set_meta(db, &format!("last_sync:{host}:{agent}"), stamp)?;
    set_meta(
        db,
        &format!("last_error:{host}:{agent}"),
        &if stats.error > 0 {
            format!("{stamp} {} file error(s)", stats.error)
        } else {
            String::new()
        },
    )?;
    set_meta(
        db,
        &format!("unknown:{host}:{agent}"),
        &serde_json::to_string(&stats.unknown).unwrap_or_else(|_| "{}".into()),
    )?;
    Ok(())
}
