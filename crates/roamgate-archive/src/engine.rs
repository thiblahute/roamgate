//! The archive's operations (archive/engine.ts): sync, ingest, push,
//! rebuild. The CLI and tests call these.

use std::path::{Path, PathBuf};
use std::time::Instant;

use indexmap::IndexMap;
use roamgate_agents::Agent;
use roamgate_agents::extract::UnknownTypes;
use rusqlite::params;
use serde::Serialize;

use crate::hosts::{
    ArchiveRuntime, Exec, ResolvedHost, SAFE_HOST, UnreachableHost, enabled_adapters, local_root,
    local_roots, mirror_dir, pull_agent, push_agent, remote_home, remote_ingest, resolve_hosts,
};
use crate::lock::acquire_host_lock;
use crate::settings::{ArchiveSettings, PathStyle, RuleSubject, index_level_for};
use crate::store::{
    ArchiveDb, Result, get_meta, open_archive_db, read_kept_meta, remove_archive_db, set_meta,
};
use crate::sync::{
    FileKind, Known, ScanTarget, SyncContext, SyncSource, SyncStats, file_meta, record_sync,
    scan_lines, sync_source,
};
use crate::zstd_frames::read_archived;
use crate::{PullError, iso_now};

/// What a sync of one host did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostReport {
    pub host: String,
    /// synced, skipped, locked or unreachable.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub agents: IndexMap<String, SyncStats>,
}

impl HostReport {
    fn new(host: &str) -> Self {
        Self {
            host: host.to_owned(),
            status: "synced".into(),
            message: None,
            agents: IndexMap::new(),
        }
    }

    fn with(mut self, status: &str, message: impl Into<String>) -> Self {
        self.status = status.into();
        self.message = Some(message.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncReport {
    pub hosts: Vec<HostReport>,
    pub seconds: f64,
}

/// What a sync works with.
pub struct SyncOptions<'a> {
    pub settings: &'a ArchiveSettings,
    pub runtime: &'a ArchiveRuntime,
    pub archive_dir: &'a Path,
    /// Only these hosts; default: this machine and every pullable host.
    pub hosts: Option<Vec<String>>,
    pub agents: Option<Vec<String>>,
    /// Do not pull ssh hosts.
    pub local_only: bool,
    pub exec: &'a dyn Exec,
    pub log: &'a mut dyn FnMut(&str),
}

/// Opens the archive's database, rebuilding it from the raw files when its
/// version is unknown.
pub fn open_or_rebuild(
    runtime: &ArchiveRuntime,
    archive_dir: &Path,
    log: &mut dyn FnMut(&str),
    settings: Option<&ArchiveSettings>,
) -> Result<ArchiveDb> {
    let opened = open_archive_db(&runtime.context, archive_dir, false)?;
    if !opened.needs_rebuild {
        return Ok(opened);
    }
    log("the archive database has an unknown version: rebuilding it from the raw files");
    drop(opened);
    rebuild_archive_db(runtime, archive_dir, settings, log)
}

fn agent_sources(
    settings: &ArchiveSettings,
    host: &ResolvedHost,
    runtime: &ArchiveRuntime,
    archive_dir: &Path,
    only: Option<&[String]>,
) -> Vec<SyncSource> {
    enabled_adapters(settings)
        .into_iter()
        .filter(|agent| only.is_none_or(|only| only.iter().any(|id| id == agent.id())))
        .flat_map(|agent| {
            if host.self_host {
                // The agent's root with its extra files, then each root an
                // account profile keeps apart.
                local_roots(agent, host, runtime)
                    .into_iter()
                    .enumerate()
                    .map(|(index, root)| SyncSource {
                        host: host.id.clone(),
                        agent,
                        root,
                        extra: if index > 0 {
                            Vec::new()
                        } else {
                            agent
                                .extra_files()
                                .iter()
                                .map(|extra| {
                                    (
                                        runtime.home_dir.join(extra.home_path),
                                        extra.relpath.to_owned(),
                                    )
                                })
                                .collect()
                        },
                    })
                    .collect::<Vec<_>>()
            } else {
                let mirror = mirror_dir(archive_dir, &host.id, agent.id());
                vec![SyncSource {
                    host: host.id.clone(),
                    agent,
                    root: mirror.join("tree"),
                    extra: agent
                        .extra_files()
                        .iter()
                        .map(|extra| {
                            (
                                mirror.join("extra").join(extra.relpath),
                                extra.relpath.to_owned(),
                            )
                        })
                        .collect(),
                }]
            }
        })
        .collect()
}

struct HostRun<'a> {
    settings: &'a ArchiveSettings,
    runtime: &'a ArchiveRuntime,
    agents: Option<&'a [String]>,
    pull: bool,
}

fn sync_host(
    ctx: &mut SyncContext<'_>,
    host: &ResolvedHost,
    run: &HostRun<'_>,
    exec: &dyn Exec,
) -> Result<HostReport> {
    let mut report = HostReport::new(&host.id);
    let Some(_lock) = acquire_host_lock(ctx.archive_dir, &host.id)? else {
        return Ok(report.with("locked", "another sync of this host is running"));
    };
    if !host.self_host && run.pull {
        let pulled = (|| -> std::result::Result<(), PullError> {
            let mut home = host
                .home
                .clone()
                .or(get_meta(ctx.db, &format!("home:{}", host.id))
                    .map_err(|e| PullError::Other(e.to_string()))?);
            if home.is_none() {
                home = remote_home(exec, host.ssh.as_deref().unwrap_or(""));
            }
            let Some(home) = home else {
                return Err(PullError::Unreachable(UnreachableHost(format!(
                    "cannot reach {}",
                    host.ssh.as_deref().unwrap_or("undefined")
                ))));
            };
            set_meta(ctx.db, &format!("home:{}", host.id), &home)
                .map_err(|e| PullError::Other(e.to_string()))?;
            for agent in enabled_adapters(run.settings) {
                if run
                    .agents
                    .is_some_and(|only| !only.iter().any(|id| id == agent.id()))
                {
                    continue;
                }
                pull_agent(exec, ctx.archive_dir, host, agent, Some(&home))?;
            }
            Ok(())
        })();
        match pulled {
            Ok(()) => set_meta(ctx.db, &format!("last_error:{}", host.id), "")?,
            Err(error) => {
                let message = error.to_string();
                let unreachable = matches!(error, PullError::Unreachable(_))
                    || message.contains("ssh")
                    || message.contains("rsync");
                if !unreachable {
                    return Err(crate::Error::msg(message));
                }
                let stamp = iso_now();
                set_meta(ctx.db, &format!("last_attempt:{}", host.id), &stamp)?;
                set_meta(
                    ctx.db,
                    &format!("last_error:{}", host.id),
                    &format!("{stamp} {message}"),
                )?;
                return Ok(report.with("unreachable", message));
            }
        }
    }
    // An agent's sources (its root, the roots its accounts keep apart)
    // add up to one run of the agent.
    let mut runs: IndexMap<&'static str, SyncStats> = IndexMap::new();
    for source in agent_sources(run.settings, host, run.runtime, ctx.archive_dir, run.agents) {
        if !source.root.exists() && source.extra.iter().all(|(path, _)| !path.exists()) {
            continue;
        }
        let mut unknown = UnknownTypes::new();
        sync_source(
            ctx,
            &source,
            runs.entry(source.agent.id()).or_default(),
            &mut unknown,
        );
    }
    for (agent, stats) in runs {
        record_sync(ctx.db, &host.id, agent, &stats, &iso_now())?;
        report.agents.insert(agent.to_owned(), stats);
    }
    Ok(report)
}

/// Sync this machine's agents and pull every pullable ssh host. An
/// unreachable host is recorded and skipped; it never fails the run.
pub fn run_sync(options: SyncOptions<'_>) -> Result<SyncReport> {
    let started = Instant::now();
    let db = open_or_rebuild(
        options.runtime,
        options.archive_dir,
        options.log,
        Some(options.settings),
    )?;
    let hosts: Vec<ResolvedHost> = resolve_hosts(options.settings, options.runtime)
        .into_iter()
        .filter(|host| {
            options
                .hosts
                .as_ref()
                .is_none_or(|only| only.contains(&host.id))
                && (host.self_host || (host.enabled && !options.local_only))
        })
        .collect();
    let run = HostRun {
        settings: options.settings,
        runtime: options.runtime,
        agents: options.agents.as_deref(),
        pull: options.settings.push.is_none() && !options.local_only,
    };
    let mut ctx = SyncContext {
        db: &db.conn,
        archive_dir: options.archive_dir,
        settings: options.settings,
        log: options.log,
    };
    let mut reports = Vec::new();
    for host in &hosts {
        reports.push(sync_host(&mut ctx, host, &run, options.exec)?);
    }
    Ok(SyncReport {
        hosts: reports,
        seconds: started.elapsed().as_secs_f64(),
    })
}

/// Index what a host pushed into its mirror.
pub fn run_ingest(options: SyncOptions<'_>, host: &str) -> Result<HostReport> {
    if !SAFE_HOST.is_match(host) {
        return Err(crate::Error::msg(format!("invalid host name: {host}")));
    }
    let db = open_or_rebuild(
        options.runtime,
        options.archive_dir,
        options.log,
        Some(options.settings),
    )?;
    let resolved = ResolvedHost {
        id: host.to_owned(),
        self_host: false,
        ssh: None,
        home: None,
        path_style: PathStyle::Posix,
        roots: IndexMap::new(),
        enabled: true,
    };
    let run = HostRun {
        settings: options.settings,
        runtime: options.runtime,
        agents: options.agents.as_deref(),
        pull: false,
    };
    let mut ctx = SyncContext {
        db: &db.conn,
        archive_dir: options.archive_dir,
        settings: options.settings,
        log: options.log,
    };
    sync_host(&mut ctx, &resolved, &run, options.exec)
}

/// On a pushing machine: send this machine's files to the archive home,
/// then have it ingest them.
pub fn run_push(options: SyncOptions<'_>) -> Result<HostReport> {
    let Some(push) = &options.settings.push else {
        return Err(crate::Error::msg("no archive.push target is configured"));
    };
    let hosts = resolve_hosts(options.settings, options.runtime);
    let me = &hosts[0];
    let report = HostReport::new(&me.id);
    for agent in enabled_adapters(options.settings) {
        if options
            .agents
            .as_ref()
            .is_some_and(|only| !only.iter().any(|id| id == agent.id()))
        {
            continue;
        }
        if agent.snapshot_sqlite() {
            continue;
        }
        let extras: Vec<(PathBuf, String)> = agent
            .extra_files()
            .iter()
            .map(|extra| {
                (
                    options.runtime.home_dir.join(extra.home_path),
                    extra.relpath.to_owned(),
                )
            })
            .collect();
        if let Err(UnreachableHost(message)) = push_agent(
            options.exec,
            push,
            &me.id,
            agent,
            &local_root(agent, me, options.runtime),
            &extras,
        ) {
            return Ok(report.with("unreachable", message));
        }
    }
    let result = remote_ingest(options.exec, push, &me.id);
    if result.code != 0 {
        let stderr = roamgate_agents::js::js_trim(&result.stderr);
        return Ok(report.with(
            "unreachable",
            format!(
                "ingest failed: exit {} {}",
                result.code,
                roamgate_agents::js::utf16_prefix(stderr, 300)
            ),
        ));
    }
    let stdout = roamgate_agents::js::js_trim(&result.stdout);
    let mut report = report;
    report.message = Some(roamgate_agents::js::utf16_prefix(stdout, 2000).to_owned());
    Ok(report)
}

fn raw_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            raw_files(&path, out);
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".zst") {
            out.push(path);
        }
    }
}

/// Drop the archive's database and build it again from the raw files.
pub fn rebuild_archive_db(
    runtime: &ArchiveRuntime,
    archive_dir: &Path,
    settings: Option<&ArchiveSettings>,
    log: &mut dyn FnMut(&str),
) -> Result<ArchiveDb> {
    let kept = match open_archive_db(&runtime.context, archive_dir, false) {
        Ok(old) => read_kept_meta(&old.conn).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    remove_archive_db(archive_dir);
    let db = open_archive_db(&runtime.context, archive_dir, false)?;
    for (key, value) in &kept {
        set_meta(&db.conn, key, value)?;
    }
    let default_settings;
    let config = match settings {
        Some(settings) => settings,
        None => {
            default_settings = ArchiveSettings::default();
            &default_settings
        }
    };
    let raw = archive_dir.join("raw");
    let mut files = Vec::new();
    raw_files(&raw, &mut files);
    let mut count = 0usize;
    for path in files {
        let Ok(relative) = path.strip_prefix(&raw) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let mut parts = relative.split('/');
        let (Some(host), Some(agent)) = (parts.next(), parts.next()) else {
            continue;
        };
        let rest = parts.collect::<Vec<_>>().join("/");
        let relpath = rest.strip_suffix(".zst").unwrap_or(&rest).to_owned();
        let Some(adapter) = Agent::from_id(agent) else {
            continue;
        };
        if host.is_empty() || relpath.is_empty() {
            continue;
        }
        let kind = if relpath.starts_with('@') {
            FileKind::History
        } else {
            FileKind::Transcript
        };
        let meta = file_meta(adapter, kind, &relpath);
        let level = index_level_for(
            config,
            RuleSubject {
                host,
                agent: adapter.id(),
                project: &meta.project,
            },
        );
        db.conn.execute(
            "INSERT INTO files(host, agent, relpath, kind, project, session, subagent, index_level, zst_size)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                host,
                adapter.id(),
                relpath,
                kind.name(),
                meta.project,
                meta.session,
                meta.subagent as i64,
                level.name(),
                std::fs::metadata(&path)?.len() as i64
            ],
        )?;
        let file_id = db.conn.last_insert_rowid();
        let scanned = (|| -> Result<u64> {
            let mut counter = Counter {
                inner: read_archived(&path)?,
                total: 0,
            };
            if adapter.indexable() || kind == FileKind::History {
                let mut unknown = UnknownTypes::new();
                scan_lines(
                    ScanTarget {
                        db: &db.conn,
                        file_id,
                        agent: adapter,
                        kind,
                        thinking: config.thinking,
                        unknown: &mut unknown,
                    },
                    &mut counter,
                    0,
                    &Known {
                        title: None,
                        cwd: None,
                        project: Some(meta.project.clone()),
                    },
                )?;
            }
            std::io::copy(&mut counter, &mut std::io::sink())?;
            Ok(counter.total)
        })();
        match scanned {
            Ok(total) => {
                db.conn.execute(
                    "UPDATE files SET src_size = ?1, archived_size = ?1, src_mtime = 0 WHERE id = ?2",
                    params![total as i64, file_id],
                )?;
            }
            Err(error) => log(&format!("rebuild: {relpath}: {error}")),
        }
        count += 1;
        if count.is_multiple_of(200) {
            log(&format!("  rebuilt {count} files"));
        }
    }
    log(&format!(
        "rebuilt the archive database from {count} archived file(s)"
    ));
    Ok(db)
}

/// Counts what passes through.
struct Counter<R> {
    inner: R,
    total: u64,
}

impl<R: std::io::Read> std::io::Read for Counter<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.total += read as u64;
        Ok(read)
    }
}
