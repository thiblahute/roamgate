//! The archive's health (archive/health.ts): the last sync per host and
//! agent, stale ones, sizes, free disk, unknown record types and the text
//! repo's state.

use std::path::Path;

use indexmap::IndexMap;
use rusqlite::Connection;
use serde::Serialize;

use crate::dir::legacy_archive_warning;
use crate::hosts::{ArchiveRuntime, resolve_hosts};
use crate::settings::ArchiveSettings;
use crate::store::{Result, get_meta};
use crate::text_repo::{TextRepoStatus, text_repo_status};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentHealth {
    pub agent: String,
    pub files: u64,
    pub sessions: u64,
    pub last_sync: Option<String>,
    pub last_attempt: Option<String>,
    pub last_error: Option<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HostHealth {
    pub host: String,
    pub last_sync: Option<String>,
    pub last_attempt: Option<String>,
    pub last_error: Option<String>,
    pub age_hours: Option<serde_json::Number>,
    pub stale: bool,
    pub files: u64,
    pub sessions: u64,
    pub agents: Vec<AgentHealth>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Totals {
    pub files: u64,
    pub sessions: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sizes {
    pub raw_bytes: u64,
    pub db_bytes: u64,
    pub source_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Disk {
    pub free_gb: Option<serde_json::Number>,
    pub low: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArchiveHealth {
    pub ok: bool,
    pub archive_dir: String,
    pub now: String,
    pub stale_hours: serde_json::Number,
    pub hosts: Vec<HostHealth>,
    pub totals: Totals,
    pub sizes: Sizes,
    pub disk: Disk,
    pub unknown_types: IndexMap<String, serde_json::Number>,
    /// The conversation text repo search runs on.
    pub text: TextRepoStatus,
    pub warnings: Vec<String>,
}

/// A JavaScript number: integral doubles as integers.
pub fn js_num(value: f64) -> serde_json::Number {
    roamgate_agents::js::js_number(&serde_json::Number::from_f64(value).unwrap_or_else(|| 0.into()))
}

fn hours_since(stamp: Option<&str>, now_ms: i64) -> Option<f64> {
    let time = crate::parse_iso_ms(stamp?)?;
    Some((now_ms - time) as f64 / 3_600_000.0)
}

fn error_text(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

/// `Math.round(x)`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn free_gb(archive_dir: &Path) -> Option<f64> {
    let bytes = roamgate_base::paths::disk_free(archive_dir)?;
    Some(js_round(bytes / 1e8) / 10.0)
}

pub fn archive_health(
    db: &Connection,
    archive_dir: &Path,
    settings: &ArchiveSettings,
    runtime: &ArchiveRuntime,
    db_bytes: u64,
    now_ms: i64,
) -> Result<ArchiveHealth> {
    let mut warnings = Vec::new();
    let mut statement = db.prepare(
        "SELECT host, agent, count(*) AS files, count(DISTINCT session) AS sessions
         FROM files WHERE kind = 'transcript' GROUP BY host, agent",
    )?;
    let per_agent: Vec<(String, String, u64, u64)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, i64>(3)? as u64,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut host_ids: Vec<String> = Vec::new();
    for (host, ..) in &per_agent {
        if !host_ids.contains(host) {
            host_ids.push(host.clone());
        }
    }
    for host in resolve_hosts(settings, runtime) {
        if (host.self_host || host.enabled) && !host_ids.contains(&host.id) {
            host_ids.push(host.id);
        }
    }
    host_ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut hosts = Vec::new();
    for host in &host_ids {
        let mut agents = Vec::new();
        for (row_host, agent, files, sessions) in &per_agent {
            if row_host != host {
                continue;
            }
            let last_sync = get_meta(db, &format!("last_sync:{host}:{agent}"))?;
            let age = hours_since(last_sync.as_deref(), now_ms);
            agents.push(AgentHealth {
                agent: agent.clone(),
                files: *files,
                sessions: *sessions,
                last_attempt: get_meta(db, &format!("last_attempt:{host}:{agent}"))?,
                last_error: error_text(get_meta(db, &format!("last_error:{host}:{agent}"))?),
                stale: age.is_none_or(|age| age > settings.stale_hours),
                last_sync,
            });
        }
        let last_sync = get_meta(db, &format!("last_sync:{host}"))?;
        let age = hours_since(last_sync.as_deref(), now_ms);
        let stale = age.is_none_or(|age| age > settings.stale_hours);
        let last_error = error_text(get_meta(db, &format!("last_error:{host}"))?)
            .or_else(|| agents.iter().find_map(|a| a.last_error.clone()));
        if last_sync.is_none() {
            warnings.push(format!("{host}: never synced"));
        } else if stale {
            warnings.push(format!(
                "{host}: last sync {} hours ago (stale after {})",
                age.unwrap_or(0.0).floor() as i64,
                js_num(settings.stale_hours)
            ));
        }
        if let Some(error) = &last_error {
            warnings.push(format!("{host}: {error}"));
        }
        hosts.push(HostHealth {
            host: host.clone(),
            last_attempt: get_meta(db, &format!("last_attempt:{host}"))?,
            last_error,
            age_hours: age.map(|age| js_num(js_round(age * 10.0) / 10.0)),
            stale,
            files: agents.iter().map(|a| a.files).sum(),
            sessions: agents.iter().map(|a| a.sessions).sum(),
            last_sync,
            agents,
        });
    }
    let count = |sql: &str| -> Result<u64> {
        Ok(db.query_row(sql, [], |row| row.get::<_, i64>(0))? as u64)
    };
    let (raw_bytes, source_bytes): (Option<i64>, Option<i64>) = db.query_row(
        "SELECT sum(zst_size) AS n, sum(archived_size) AS s FROM files",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let free = free_gb(archive_dir);
    if let Some(legacy) = legacy_archive_warning(archive_dir) {
        warnings.push(legacy);
    }
    let low = free.is_some_and(|free| free < settings.min_free_gb);
    if low {
        warnings.push(format!(
            "only {} GB free under the archive (warning below {} GB)",
            js_num(free.unwrap_or(0.0)),
            js_num(settings.min_free_gb)
        ));
    }
    let text = text_repo_status(archive_dir, settings);
    if text.stale_render {
        warnings.push(
            "the text repo was rendered with other settings: run `roamgate archive rebuild-text`"
                .into(),
        );
    }
    let mut unknown: IndexMap<String, f64> = IndexMap::new();
    let mut statement = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'unknown:%'")?;
    let rows: Vec<Option<String>> = statement
        .query_map([], |row| row.get::<_, Option<String>>(1))?
        .collect::<rusqlite::Result<_>>()?;
    for value in rows.into_iter().flatten() {
        // A damaged entry is ignored.
        if let Ok(serde_json::Value::Object(map)) =
            serde_json::from_str::<serde_json::Value>(&value)
        {
            for (kind, n) in map {
                *unknown.entry(kind).or_insert(0.0) += n.as_f64().unwrap_or(f64::NAN);
            }
        }
    }
    Ok(ArchiveHealth {
        ok: warnings.is_empty(),
        archive_dir: archive_dir.to_string_lossy().into_owned(),
        now: crate::iso_ms(now_ms),
        stale_hours: js_num(settings.stale_hours),
        hosts,
        totals: Totals {
            files: count("SELECT count(*) AS n FROM files WHERE kind = 'transcript'")?,
            sessions: count(
                "SELECT count(*) AS n FROM (SELECT DISTINCT agent, session FROM files WHERE kind = 'transcript')",
            )?,
        },
        sizes: Sizes {
            raw_bytes: raw_bytes.unwrap_or(0).max(0) as u64,
            db_bytes,
            source_bytes: source_bytes.unwrap_or(0).max(0) as u64,
        },
        disk: Disk {
            free_gb: free.map(js_num),
            low,
        },
        unknown_types: unknown.into_iter().map(|(k, v)| (k, js_num(v))).collect(),
        text,
        warnings,
    })
}
