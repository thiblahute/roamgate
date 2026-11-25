//! Reads of session files that are gone from their agent's directory,
//! served from the archive (archive/file-access.ts): what the agent
//! session readers fall back to when a transcript was deleted by the
//! agent's own cleanup.

use std::io::Read;
use std::path::{Path, PathBuf};

use roamgate_agents::AGENTS;
use rusqlite::{OptionalExtension, params};

use crate::hosts::{ArchiveRuntime, resolve_hosts};
use crate::settings::{ArchiveSettings, RuleSubject, any_rule_matches};
use crate::store::{Result, existing_archive_db, open_archive_db};
use crate::sync::zst_path;
use crate::zstd_frames::read_archived;

/// An archived session file, as a stat sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchivedSessionFile {
    pub path: String,
    pub mtime_ms: f64,
    pub size: u64,
    pub identity: String,
    pub change_token: String,
}

struct Resolved {
    zst: PathBuf,
    size: u64,
    mtime_ms: f64,
    id: i64,
}

/// `path` under `root`, `/`-separated as the archive keeps it (Windows
/// paths come with `\`); None outside it.
fn relative_to(path: &str, root: &Path) -> Option<String> {
    let prefix = format!("{}/", root.to_string_lossy());
    if let Some(relpath) = path.strip_prefix(&prefix) {
        return Some(relpath.to_owned());
    }
    if cfg!(windows) {
        let relpath = Path::new(path).strip_prefix(root).ok()?;
        let relpath = relpath.to_string_lossy().replace('\\', "/");
        return (!relpath.is_empty()).then_some(relpath);
    }
    None
}

fn resolve(
    path: &str,
    settings: &ArchiveSettings,
    archive_dir: &Path,
    runtime: &ArchiveRuntime,
) -> Result<Option<Resolved>> {
    for agent in AGENTS {
        if !settings.agents.iter().any(|id| id == agent.id()) {
            continue;
        }
        let root = agent.root_for(&runtime.home_dir, &|name: &str| runtime.var(name));
        let Some(relpath) = relative_to(path, &root) else {
            continue;
        };
        let relpath = relpath.as_str();
        if existing_archive_db(archive_dir).is_none() {
            return Ok(None);
        }
        let db = open_archive_db(&runtime.context, archive_dir, true)?;
        if db.needs_rebuild {
            return Ok(None);
        }
        let me = resolve_hosts(settings, runtime)
            .into_iter()
            .next()
            .map(|host| host.id)
            .unwrap_or_default();
        let row = db
            .conn
            .query_row(
                "SELECT id, host, relpath, project, archived_size, src_mtime FROM files
                 WHERE agent = ?1 AND relpath = ?2 AND kind = 'transcript'
                 ORDER BY (host = ?3) DESC, archived_size DESC LIMIT 1",
                params![agent.id(), relpath, me],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<f64>>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, host, relpath, project, archived_size, src_mtime)) = row else {
            return Ok(None);
        };
        if any_rule_matches(
            &settings.hide,
            RuleSubject {
                host: &host,
                agent: agent.id(),
                project: project.as_deref().unwrap_or(""),
            },
        ) {
            return Ok(None);
        }
        return Ok(Some(Resolved {
            zst: zst_path(archive_dir, &host, agent.id(), &relpath),
            size: archived_size.max(0) as u64,
            mtime_ms: src_mtime.unwrap_or(0.0) * 1000.0,
            id,
        }));
    }
    Ok(None)
}

/// The archived copy of a session file, as a stat sees it; None when it
/// is not archived.
pub fn stat(
    path: &str,
    settings: &ArchiveSettings,
    archive_dir: &Path,
    runtime: &ArchiveRuntime,
) -> Result<Option<ArchivedSessionFile>> {
    Ok(
        resolve(path, settings, archive_dir, runtime)?.map(|found| ArchivedSessionFile {
            path: path.to_owned(),
            mtime_ms: found.mtime_ms,
            size: found.size,
            identity: format!("archive:{}", found.id),
            change_token: found.size.to_string(),
        }),
    )
}

/// Bytes [start, end) of the file as archived; None when it is not
/// archived.
pub fn range(
    path: &str,
    start: u64,
    end: u64,
    settings: &ArchiveSettings,
    archive_dir: &Path,
    runtime: &ArchiveRuntime,
) -> Result<Option<Vec<u8>>> {
    let Some(found) = resolve(path, settings, archive_dir, runtime)? else {
        return Ok(None);
    };
    let stop = end.min(found.size);
    let mut reader = read_archived(&found.zst)?;
    let mut out = Vec::new();
    let mut offset = 0u64;
    let mut chunk = vec![0u8; 1 << 20];
    while offset < stop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let from = start.saturating_sub(offset) as usize;
        let to = (stop - offset).min(read as u64) as usize;
        if to > from {
            out.extend_from_slice(&chunk[from..to]);
        }
        offset += read as u64;
    }
    Ok(Some(out))
}
