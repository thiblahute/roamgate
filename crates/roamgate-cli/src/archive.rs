//! `roamgate archive` (cli/archive): sync, ingest, search, session, cat,
//! resume, health, status, rebuild-text, fetch-text and rebuild-db, with the
//! CLI's error conventions; the work is roamgate-archive's.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roamgate_archive::dir::resolve_archive_dir;
use roamgate_archive::engine::{
    HostReport, SyncOptions, open_or_rebuild, rebuild_archive_db, run_ingest, run_push, run_sync,
};
use roamgate_archive::health::archive_health;
use roamgate_archive::hosts::{
    ArchiveRuntime, Exec, ResolvedHost, SSH_OPTIONS, local_root, resolve_hosts, sh_quote,
};
use roamgate_archive::search::{SearchOptions, SearchQuery, SearchResult, search_archive};
use roamgate_archive::session::{
    LocalFileSource, LookupOptions, ResumeOptions, SessionLookup, SshFileSource, cat_file,
    cat_lines, lookup_session, resume_session,
};
use roamgate_archive::settings::{ArchiveSettings, normalize_archive_settings};
use roamgate_archive::store::{archive_db_path, existing_archive_db};
use roamgate_archive::text_repo::{
    TextPassOptions, TextPassReport, fetch_text_repo, rebuild_text_repo, text_repo_age_ms,
    text_repo_path, text_repo_status, update_text_repo,
};
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::{DataContext, Platform};
use serde::Serialize;
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::args::{Kind, Parsed, Spec, flag, many, text};
use crate::service::{ServiceRuntime, read_service_environment};

/// `roamgate archive --help`, as printed (console.log adds the last
/// newline).
pub fn archive_help() -> &'static str {
    r#"Archive agent sessions (Claude Code, Codex, Pi), searchable, without the server.

Usage:
  roamgate archive sync [--host H] [--agent A] [--local-only] [--push] [--json]
  roamgate archive ingest <host> [--json]
  roamgate archive search <terms...> [--agent A] [--host H] [--project P]
                          [--role R] [--kind K] [--since D] [--until D]
                          [--recent] [--history] [--regex] [--tool-output]
                          [-n N] [--json]
  roamgate archive session <id> [--agent A] [--host H] [--json]
  roamgate archive cat <id> [--agent A] [--host H] [--file RELPATH]
                       [--from-line N --limit N]
  roamgate archive resume <id> [--agent A] [--host H] [--remote SSH]
                          [--dry-run] [--json]
  roamgate archive health [--check] [--json]
  roamgate archive status [--json]
  roamgate archive rebuild-text [--now] [--json]
  roamgate archive fetch-text [--remote SSH] [--json]
  roamgate archive rebuild-db

sync copies, compresses and indexes this machine's agent sessions, then
pulls every configured ssh host (unreachable hosts are recorded and skipped).
With --push (or archive.push in settings) it sends this machine's files to the
archive home and has it index them. Files under raw/ are the source of truth
and are never deleted; archive.sqlite (what each file holds, when each host
synced) is rebuilt from them by rebuild-db. After
each sync the conversation text goes into text.git (one commit, deferred while
GameMode runs); rebuild-text builds it again from raw/, status shows it.
search greps that text: substrings, case-insensitive, every word in one
message ("phrases", OR, NOT), or a Perl regex with --regex; one line per
session, most matching messages first (--recent: newest first), including
this machine's sessions grown since the last commit. Tool output is only
searched with --tool-output, which reads all of raw/ (slow). fetch-text
copies the archive home's text repo (archive.remote) for local search. cat
prints a session byte-identical to the original. resume restores a session into this
machine's agent directory only where it does not exist, never overwriting.
health reports the last sync per host and agent and warns when stale
(--check exits 1 on any warning). Settings live under "archive" in
settings.json; --dir or ROAMGATE_ARCHIVE_DIR overrides the archive location.
"#
}

/// Where a command's output goes: lines as console.log and console.error
/// write them, and raw bytes for `cat`.
pub trait Output {
    fn log(&mut self, line: &str);
    fn error(&mut self, line: &str);
    fn write(&mut self, bytes: &[u8]);
}

/// This process's stdout and stderr, written as it goes.
pub struct ProcessOutput;

impl Output for ProcessOutput {
    fn log(&mut self, line: &str) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    fn error(&mut self, line: &str) {
        use std::io::Write;
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(line.as_bytes());
        let _ = err.write_all(b"\n");
    }

    fn write(&mut self, bytes: &[u8]) {
        use std::io::Write;
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(bytes);
        let _ = out.flush();
    }
}

/// What a test reads back.
#[derive(Debug, Default)]
pub struct Captured {
    pub output: Vec<String>,
    pub errors: Vec<String>,
    pub bytes: Vec<u8>,
}

impl Output for Captured {
    fn log(&mut self, line: &str) {
        self.output.push(line.to_owned());
    }

    fn error(&mut self, line: &str) {
        self.errors.push(line.to_owned());
    }

    fn write(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }
}

/// What `roamgate archive` works with (tests swap the effects).
pub struct ArchiveCli {
    pub env: Arc<dyn Env>,
    pub platform: String,
    pub home: PathBuf,
    pub app_data: Option<PathBuf>,
    pub hostname: String,
    pub exec: Arc<dyn Exec>,
    /// Whether GameMode runs (None: cannot tell).
    pub game_mode: Arc<dyn Fn() -> BoxFuture<Option<bool>> + Send + Sync>,
    /// The ssh program of fetch-text (tests run a local stand-in).
    pub ssh_program: String,
    /// Lowers this process's priority before a rebuild.
    pub lower_priority: Arc<dyn Fn() + Send + Sync>,
}

const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_USAGE: i32 = 2;
/// sysexits' EX_TEMPFAIL: try again later.
const EXIT_TEMPFAIL: i32 = 75;
/// Between two fetches of the archive home's text repo, at most.
const TEXT_FETCH_EVERY_MS: f64 = 10.0 * 60.0 * 1000.0;

enum Failure {
    Failed(String),
    Usage(String),
}

impl From<roamgate_archive::Error> for Failure {
    fn from(error: roamgate_archive::Error) -> Self {
        Failure::Failed(error.message)
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Failure::Failed(roamgate_archive::io_message(&error))
    }
}

type Outcome = Result<i32, Failure>;

/// node:util parseArgs with the CLI's usage errors.
fn parse_args(args: &[String], specs: &[Spec], max_positionals: usize) -> Result<Parsed, Failure> {
    crate::args::parse_args(args, specs, max_positionals).map_err(Failure::Usage)
}

const COMMON: [Spec; 2] = [text("dir"), flag("json")];

fn with_common(extra: &[Spec]) -> Vec<Spec> {
    COMMON
        .iter()
        .chain(extra)
        .map(|spec| Spec {
            name: spec.name,
            kind: spec.kind,
            short: spec.short,
        })
        .collect()
}

// ----------------------------------------------------------- helpers

fn wants_help(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("help")
        || args.iter().any(|arg| arg == "--help" || arg == "-h")
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &impl Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}

fn megabytes(bytes: u64) -> String {
    format!("{} MB", (bytes as f64 / 1e6 + 0.5).floor() as i64)
}

/// `n.toFixed(1)`.
fn fixed1(value: f64) -> String {
    format!("{value:.1}")
}

fn describe_text(report: &Result<TextPassReport, String>) -> String {
    match report {
        Err(message) => format!("text repo: failed: {message}"),
        Ok(report) if report.status != "committed" => format!(
            "text repo: {}{}",
            report.status,
            report
                .message
                .as_ref()
                .map(|m| format!(" ({m})"))
                .unwrap_or_default()
        ),
        Ok(report) => format!(
            "text repo: {} file(s), {} line(s) committed{}{} in {}s",
            report.files,
            report.lines,
            if report.redactions > 0 {
                format!(", {} secret(s) redacted", report.redactions)
            } else {
                String::new()
            },
            if report.repacked { ", repacked" } else { "" },
            fixed1(report.seconds)
        ),
    }
}

fn text_json(report: &Result<TextPassReport, String>) -> Value {
    match report {
        Ok(report) => serde_json::to_value(report).unwrap_or(Value::Null),
        Err(message) => json!({"status": "failed", "message": message}),
    }
}

fn describe_host(report: &HostReport) -> String {
    let mut lines = vec![format!(
        "{}: {}{}",
        report.host,
        report.status,
        report
            .message
            .as_ref()
            .map(|m| format!(" ({m})"))
            .unwrap_or_default()
    )];
    for (agent, s) in &report.agents {
        lines.push(format!(
            "  {agent} new {} grown {} same {} shrunk {} replaced {} errors {} docs {}",
            s.new, s.grown, s.same, s.shrunk, s.replaced, s.error, s.docs
        ));
    }
    let unknown: Vec<String> = report
        .agents
        .values()
        .flat_map(|s| s.unknown.iter().map(|(k, n)| format!("{k}={n}")))
        .collect();
    if !unknown.is_empty() {
        lines.push(format!(
            "  unrecognised record types (not indexed): {}",
            unknown.join(", ")
        ));
    }
    lines.join("\n")
}

fn describe_lookup(lookup: &SessionLookup) -> String {
    if !lookup.found {
        return match &lookup.candidates {
            Some(candidates) => format!(
                "ambiguous: {}",
                candidates
                    .iter()
                    .map(|c| format!("{}:{}", c.agent, c.session))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => format!("session {} not found", lookup.session),
        };
    }
    [
        format!(
            "{} {}{}",
            lookup.agent.as_deref().unwrap_or("undefined"),
            lookup.session,
            lookup
                .title
                .as_ref()
                .map(|t| format!("  {t}"))
                .unwrap_or_default()
        ),
        format!(
            "  host {}, project {}, cwd {}",
            lookup.host.as_deref().unwrap_or("null"),
            lookup.project.as_deref().unwrap_or("null"),
            lookup.cwd.as_deref().unwrap_or("?")
        ),
        format!(
            "  {} to {}, {} file(s), {} copy(ies)",
            lookup.first_ts.as_deref().unwrap_or("?"),
            lookup.last_ts.as_deref().unwrap_or("?"),
            lookup.files.len(),
            lookup.copies.len()
        ),
        format!(
            "  live here: {}, restorable: {}{}",
            lookup.live,
            lookup.restorable,
            lookup
                .resume
                .as_ref()
                .map(|r| format!(", resume: {r}"))
                .unwrap_or_default()
        ),
    ]
    .join("\n")
}

fn db_bytes(dir: &Path) -> u64 {
    let path = existing_archive_db(dir).unwrap_or_else(|| archive_db_path(dir));
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    [path, wal]
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok())
        .map(|metadata| metadata.len())
        .sum()
}

/// `str.slice(-n)` by characters' UTF-16 units.
fn js_tail(text: &str, units: usize) -> &str {
    let total = roamgate_agents_utf16_len(text);
    if total <= units {
        return text;
    }
    let skip = total - units;
    let mut taken = 0;
    for (index, c) in text.char_indices() {
        if taken >= skip {
            return &text[index..];
        }
        taken += c.len_utf16();
    }
    ""
}

fn roamgate_agents_utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

impl ArchiveCli {
    /// This process's.
    pub fn system(env: Arc<dyn Env>) -> Self {
        let home = if cfg!(windows) {
            env.var("USERPROFILE").or_else(|| env.var("HOME"))
        } else {
            env.var("HOME")
        }
        .map(PathBuf::from)
        .unwrap_or_default();
        let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .map(|name| name.trim().to_owned())
            .or_else(|| env.var("HOSTNAME"))
            .unwrap_or_else(|| "host".into());
        Self {
            app_data: env.var("APPDATA").map(PathBuf::from),
            env,
            platform: roamgate_exec::service::node_platform().into(),
            home,
            hostname,
            exec: Arc::new(roamgate_archive::hosts::SystemExec),
            game_mode: Arc::new(|| {
                Box::pin(async {
                    let runner = roamgate_exec::process::ProcessRunner::system();
                    roamgate_exec::gamemode::game_mode_active(
                        &runner,
                        roamgate_exec::gamemode::default_game_mode_command(),
                        Duration::from_secs(3),
                    )
                    .await
                })
            }),
            ssh_program: "ssh".into(),
            lower_priority: Arc::new(|| {
                #[cfg(unix)]
                let _ = rustix::process::setpriority_process(None, 19);
            }),
        }
    }

    fn data_root(&self) -> PathBuf {
        DataContext::new(
            self.home.clone(),
            if self.platform == "win32" {
                Platform::Windows
            } else {
                Platform::Unix
            },
            self.app_data.clone(),
        )
        .data_root()
    }

    fn settings_path(&self) -> PathBuf {
        let service = ServiceRuntime {
            platform: self.platform.clone(),
            home: self.home.clone(),
            app_data: self.app_data.clone(),
            exec_path: PathBuf::new(),
            uid: None,
        };
        let from_service = read_service_environment(&service)
            .ok()
            .and_then(|env| roamgate_env(&env, "SETTINGS_PATH"));
        from_service
            .or_else(|| roamgate_env(self.env.as_ref(), "SETTINGS_PATH"))
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_root().join("settings.json"))
    }

    /// The archive settings as the server finds them.
    pub fn load_settings(&self) -> ArchiveSettings {
        let path = self.settings_path();
        let Ok(text) = std::fs::read_to_string(&path) else {
            return normalize_archive_settings(None);
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(raw) => normalize_archive_settings(raw.get("archive")),
            Err(_) => normalize_archive_settings(None),
        }
    }

    pub fn runtime(&self) -> ArchiveRuntime {
        let env = self.env.clone();
        ArchiveRuntime {
            home_dir: self.home.clone(),
            platform: self.platform.clone(),
            env: Arc::new(move |name| env.var(name)),
            data_dir: self.data_root(),
            context: DataContext::new(
                self.home.clone(),
                if self.platform == "win32" {
                    Platform::Windows
                } else {
                    Platform::Unix
                },
                self.app_data.clone(),
            ),
            hostname: self.hostname.clone(),
        }
    }

    fn archive_dir(
        &self,
        settings: &ArchiveSettings,
        flag: Option<&str>,
        out: &mut dyn Output,
    ) -> PathBuf {
        let env_dir = self
            .env
            .var("ROAMGATE_ARCHIVE_DIR")
            .map(|dir| dir.trim().to_owned());
        // `flag ?? env?.trim() ?? settings.dir`: an empty variable wins.
        let explicit = flag
            .map(str::to_owned)
            .or(env_dir)
            .or_else(|| settings.dir.clone());
        resolve_archive_dir(explicit.as_deref(), &self.data_root(), &mut |line| {
            out.log(line)
        })
    }

    async fn gaming(&self) -> bool {
        (self.game_mode)().await == Some(true)
    }

    /// Runs `roamgate archive <args>`; returns the exit code.
    pub async fn run(&self, args: &[String], out: &mut dyn Output) -> i32 {
        let Some(action) = args.first() else {
            out.log(archive_help());
            return EXIT_OK;
        };
        if wants_help(args) {
            out.log(archive_help());
            return EXIT_OK;
        }
        let json = args.iter().any(|arg| arg == "--json");
        match self.action(action, &args[1..], out).await {
            Ok(code) => code,
            Err(Failure::Usage(message)) => {
                out.error(&format!("roamgate archive: {message}"));
                out.error("Run `roamgate archive --help` for usage.");
                EXIT_USAGE
            }
            Err(Failure::Failed(message)) if json => {
                out.error(&serde_json::to_string(&json!({"error": message})).unwrap_or_default());
                EXIT_FAILURE
            }
            Err(Failure::Failed(message)) => {
                out.error(&format!("roamgate archive: {message}"));
                EXIT_FAILURE
            }
        }
    }

    async fn text_pass(
        &self,
        archive_dir: &Path,
        settings: &ArchiveSettings,
        runtime: &ArchiveRuntime,
        log: &mut dyn FnMut(&str),
    ) -> Result<TextPassReport, String> {
        let gaming = self.gaming().await;
        let busy = move || gaming;
        let host = resolve_hosts(settings, runtime)
            .into_iter()
            .next()
            .map_or_else(|| "host".to_owned(), |host| host.id);
        update_text_repo(TextPassOptions {
            archive_dir,
            settings,
            host: &host,
            log,
            busy: Some(&busy),
            now_ms: None,
            repack: true,
        })
        .map_err(|error| error.message)
    }

    async fn action(&self, action: &str, rest: &[String], out: &mut dyn Output) -> Outcome {
        let settings = self.load_settings();
        let runtime = self.runtime();
        match action {
            "sync" => self.sync(rest, &settings, &runtime, out).await,
            "ingest" => {
                let parsed = parse_args(rest, &COMMON, 1)?;
                let Some(host) = parsed.positionals.first().cloned() else {
                    return Err(Failure::Usage("ingest needs a host name".into()));
                };
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                let quiet = parsed.flag("json");
                let mut errors: Vec<String> = Vec::new();
                let report = {
                    let mut log = |line: &str| {
                        if !quiet {
                            errors.push(line.to_owned());
                        }
                    };
                    run_ingest(
                        SyncOptions {
                            settings: &settings,
                            runtime: &runtime,
                            archive_dir: &archive_dir,
                            hosts: None,
                            agents: None,
                            local_only: false,
                            exec: self.exec.as_ref(),
                            log: &mut log,
                        },
                        &host,
                    )
                };
                for line in errors.drain(..) {
                    out.error(&line);
                }
                let report = report?;
                let mut lines = Vec::new();
                let text = self
                    .text_pass(&archive_dir, &settings, &runtime, &mut |line| {
                        if !quiet {
                            lines.push(line.to_owned())
                        }
                    })
                    .await;
                for line in lines {
                    out.error(&line);
                }
                if quiet {
                    let mut value = serde_json::to_value(&report).unwrap_or(Value::Null);
                    value["text"] = text_json(&text);
                    out.log(&pretty(&value));
                } else {
                    out.log(&format!(
                        "{}\n{}",
                        describe_host(&report),
                        describe_text(&text)
                    ));
                }
                Ok(EXIT_OK)
            }
            "search" => self.search(rest, &settings, &runtime, out).await,
            "status" => {
                let parsed = parse_args(rest, &COMMON, 0)?;
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                let status = text_repo_status(&archive_dir, &settings);
                if parsed.flag("json") {
                    out.log(&pretty(&json!({"text": status})));
                } else if !status.exists {
                    out.log(&format!(
                        "text repo: none yet at {} (built by the next sync, or `roamgate archive rebuild-text`)",
                        status.path
                    ));
                } else {
                    let mut lines = vec![
                        format!("text repo: {}", status.path),
                        format!(
                            "  {} file(s), {}, last commit {}, last repack {}",
                            status.files,
                            megabytes(status.pack_bytes),
                            status.last_commit.as_deref().unwrap_or("never"),
                            status.last_repack.as_deref().unwrap_or("never")
                        ),
                        format!("  secret-looking values redacted: {}", status.redactions),
                    ];
                    if status.stale_render {
                        lines.push(
                            "  the render settings changed: run `roamgate archive rebuild-text`"
                                .into(),
                        );
                    }
                    out.log(&lines.join("\n"));
                }
                Ok(EXIT_OK)
            }
            "rebuild-text" => {
                let parsed = parse_args(rest, &with_common(&[flag("now")]), 0)?;
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                if !parsed.flag("now") && self.gaming().await {
                    out.error(
                        "GameMode runs: the rebuild waits for the game to end (--now builds anyway, at the lowest priority)",
                    );
                    return Ok(EXIT_TEMPFAIL);
                }
                (self.lower_priority)();
                let quiet = parsed.flag("json");
                let host = resolve_hosts(&settings, &runtime)
                    .into_iter()
                    .next()
                    .map_or_else(|| "host".to_owned(), |host| host.id);
                let mut lines = Vec::new();
                let report = rebuild_text_repo(TextPassOptions {
                    archive_dir: &archive_dir,
                    settings: &settings,
                    host: &host,
                    log: &mut |line| {
                        if !quiet {
                            lines.push(line.to_owned())
                        }
                    },
                    busy: None,
                    now_ms: None,
                    repack: true,
                });
                for line in lines {
                    out.error(&line);
                }
                let report = report?;
                if quiet {
                    out.log(&pretty(&json!({"text": report})));
                } else {
                    out.log(&describe_text(&Ok(report.clone())));
                }
                Ok(if report.status == "locked" {
                    EXIT_FAILURE
                } else {
                    EXIT_OK
                })
            }
            "fetch-text" => {
                let parsed = parse_args(rest, &with_common(&[text("remote")]), 0)?;
                let remote = parsed
                    .text("remote")
                    .or_else(|| settings.remote.clone())
                    .or_else(|| settings.push.as_ref().map(|push| push.target.clone()));
                let Some(remote) = remote else {
                    return Err(Failure::Usage(
                        "fetch-text needs archive.remote (or --remote SSH): the archive home"
                            .into(),
                    ));
                };
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                let remote_dir = if parsed.text("remote").is_some() {
                    None
                } else {
                    settings.remote_dir.clone().or_else(|| {
                        settings
                            .push
                            .as_ref()
                            .and_then(|push| push.archive_dir.clone())
                    })
                };
                let report = fetch_text_repo(
                    &archive_dir,
                    &remote,
                    SSH_OPTIONS,
                    remote_dir.as_deref(),
                    &self.ssh_program,
                )?;
                if parsed.flag("json") {
                    out.log(&pretty(&json!({"fetch": report})));
                } else {
                    out.log(&format!(
                        "text repo from {remote}: {} ({})",
                        if report.updated {
                            "updated"
                        } else {
                            "unchanged"
                        },
                        report
                            .head
                            .as_deref()
                            .map(|head| roamgate_agents_prefix(head, 12))
                            .unwrap_or_else(|| "empty".into())
                    ));
                }
                Ok(EXIT_OK)
            }
            "session" | "cat" | "resume" => {
                self.session(action, rest, &settings, &runtime, out).await
            }
            "health" => {
                let parsed = parse_args(rest, &with_common(&[flag("check")]), 0)?;
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                let mut lines = Vec::new();
                let db = open_or_rebuild(
                    &runtime,
                    &archive_dir,
                    &mut |line| lines.push(line.to_owned()),
                    Some(&settings),
                );
                for line in lines {
                    out.error(&line);
                }
                let db = db?;
                let health = archive_health(
                    &db.conn,
                    &archive_dir,
                    &settings,
                    &runtime,
                    db_bytes(&archive_dir),
                    roamgate_archive::now_ms(),
                )?;
                if parsed.flag("json") {
                    out.log(&pretty(&health));
                } else {
                    for host in &health.hosts {
                        let agents: String = host
                            .agents
                            .iter()
                            .map(|a| {
                                format!(
                                    "\n  {}: {} files, {}",
                                    a.agent,
                                    a.files,
                                    a.last_sync.as_deref().unwrap_or("never")
                                )
                            })
                            .collect();
                        out.log(&format!(
                            "{}: {} files, {} sessions, last sync {}{}{agents}",
                            host.host,
                            host.files,
                            host.sessions,
                            host.last_sync.as_deref().unwrap_or("never"),
                            if host.stale { " (STALE)" } else { "" }
                        ));
                    }
                    out.log(&format!(
                        "{} sessions, raw {}, database {}, free {} GB",
                        health.totals.sessions,
                        megabytes(health.sizes.raw_bytes),
                        megabytes(health.sizes.db_bytes),
                        health
                            .disk
                            .free_gb
                            .as_ref()
                            .map_or_else(|| "?".into(), ToString::to_string)
                    ));
                    out.log(&if health.text.exists {
                        format!(
                            "text repo: {} file(s), {}, last commit {}",
                            health.text.files,
                            megabytes(health.text.pack_bytes),
                            health.text.last_commit.as_deref().unwrap_or("never")
                        )
                    } else {
                        "text repo: none yet (built by the next sync)".into()
                    });
                    for warning in &health.warnings {
                        out.log(&format!("warning: {warning}"));
                    }
                    if !health.unknown_types.is_empty() {
                        out.log(&format!(
                            "unrecognised record types (not indexed): {}",
                            health
                                .unknown_types
                                .iter()
                                .map(|(k, n)| format!("{k}={n}"))
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                    }
                }
                Ok(if parsed.flag("check") && !health.ok {
                    EXIT_FAILURE
                } else {
                    EXIT_OK
                })
            }
            "rebuild-db" | "rebuild-index" => {
                let parsed = parse_args(rest, &COMMON, 0)?;
                let archive_dir = self.archive_dir(&settings, parsed.text("dir").as_deref(), out);
                let quiet = parsed.flag("json");
                let mut lines = Vec::new();
                let rebuilt =
                    rebuild_archive_db(&runtime, &archive_dir, Some(&settings), &mut |line| {
                        if !quiet {
                            lines.push(line.to_owned())
                        }
                    });
                for line in lines {
                    out.error(&line);
                }
                drop(rebuilt?);
                out.log(if quiet {
                    "{\"rebuilt\":true}"
                } else {
                    "archive database rebuilt"
                });
                Ok(EXIT_OK)
            }
            other => Err(Failure::Usage(format!("unknown archive action: {other}"))),
        }
    }

    async fn sync(
        &self,
        rest: &[String],
        settings: &ArchiveSettings,
        runtime: &ArchiveRuntime,
        out: &mut dyn Output,
    ) -> Outcome {
        let parsed = parse_args(
            rest,
            &with_common(&[
                many("host"),
                many("agent"),
                flag("local-only"),
                flag("push"),
            ]),
            0,
        )?;
        let archive_dir = self.archive_dir(settings, parsed.text("dir").as_deref(), out);
        let quiet = parsed.flag("json");
        let local_only = parsed.flag("local-only");
        let started = std::time::Instant::now();
        let hosts = parsed.list("host");
        if parsed.flag("push") || (settings.push.is_some() && !local_only && hosts.is_none()) {
            let Some(push) = &settings.push else {
                return Err(Failure::Usage(
                    "--push needs archive.push in settings.json".into(),
                ));
            };
            let report = run_push(SyncOptions {
                settings,
                runtime,
                archive_dir: &archive_dir,
                hosts: hosts.clone(),
                agents: parsed.list("agent"),
                local_only,
                exec: self.exec.as_ref(),
                log: &mut |line| {
                    if !quiet {
                        out.error(line)
                    }
                },
            })?;
            let fetched = match fetch_text_repo(
                &archive_dir,
                &push.target,
                SSH_OPTIONS,
                push.archive_dir.as_deref(),
                &self.ssh_program,
            ) {
                Ok(result) => if result.updated {
                    "updated"
                } else {
                    "unchanged"
                }
                .to_owned(),
                Err(error) => format!("not fetched: {}", error.message),
            };
            if quiet {
                out.log(&pretty(&json!({
                    "push": report,
                    "text_fetch": fetched,
                    "seconds": started.elapsed().as_secs_f64(),
                })));
            } else {
                out.log(&format!(
                    "push to {}: {}{}\ntext repo: {fetched}",
                    push.target,
                    report.status,
                    report
                        .message
                        .as_ref()
                        .map(|m| format!(" {m}"))
                        .unwrap_or_default()
                ));
            }
            return Ok(EXIT_OK);
        }
        let report = run_sync(SyncOptions {
            settings,
            runtime,
            archive_dir: &archive_dir,
            hosts,
            agents: parsed.list("agent"),
            local_only,
            exec: self.exec.as_ref(),
            log: &mut |line| {
                if !quiet {
                    out.error(line)
                }
            },
        })?;
        let text = self
            .text_pass(&archive_dir, settings, runtime, &mut |line| {
                if !quiet {
                    out.error(line)
                }
            })
            .await;
        if quiet {
            let mut value = serde_json::to_value(&report).unwrap_or(Value::Null);
            value["text"] = text_json(&text);
            out.log(&pretty(&value));
        } else {
            for host in &report.hosts {
                out.log(&describe_host(host));
            }
            out.log(&describe_text(&text));
            out.log(&format!(
                "done in {}s",
                (report.seconds + 0.5).floor() as i64
            ));
        }
        let errors: u64 = report
            .hosts
            .iter()
            .flat_map(|h| h.agents.values())
            .map(|s| s.error)
            .sum();
        Ok(if errors > 0 { EXIT_FAILURE } else { EXIT_OK })
    }

    async fn search(
        &self,
        rest: &[String],
        settings: &ArchiveSettings,
        runtime: &ArchiveRuntime,
        out: &mut dyn Output,
    ) -> Outcome {
        let parsed = parse_args(
            rest,
            &with_common(&[
                text("agent"),
                text("host"),
                text("project"),
                text("role"),
                text("kind"),
                text("since"),
                text("until"),
                flag("recent"),
                flag("history"),
                flag("regex"),
                flag("tool-output"),
                Spec {
                    name: "limit",
                    kind: Kind::Text,
                    short: Some('n'),
                },
                text("remote"),
            ]),
            200,
        )?;
        if parsed.positionals.is_empty() {
            return Err(Failure::Usage("search needs terms".into()));
        }
        let limit = match parsed.text("limit") {
            Some(text) => js_number_of(&text),
            None => Some(15.0),
        };
        let Some(limit) = limit.filter(|n| n.fract() == 0.0 && (1.0..=500.0).contains(n)) else {
            return Err(Failure::Usage("-n must be 1 to 500".into()));
        };
        let quiet = parsed.flag("json");
        let tool_output = parsed.flag("tool-output");
        let remote = parsed.text("remote").or_else(|| settings.remote.clone());
        let archive_dir = self.archive_dir(settings, parsed.text("dir").as_deref(), out);
        let has_text = text_repo_path(&archive_dir).join("HEAD").exists();
        let has_index = existing_archive_db(&archive_dir).is_some();
        let without_remote = || -> Vec<String> {
            let mut kept = vec!["search".to_owned()];
            for (index, arg) in rest.iter().enumerate() {
                if arg != "--remote" && (index == 0 || rest[index - 1] != "--remote") {
                    kept.push(arg.clone());
                }
            }
            kept
        };
        if let Some(remote) = remote.as_deref() {
            if !has_index && !tool_output {
                // A machine without its own archive: the home's text repo.
                if text_repo_age_ms(&archive_dir) > TEXT_FETCH_EVERY_MS
                    && let Err(error) = fetch_text_repo(
                        &archive_dir,
                        remote,
                        SSH_OPTIONS,
                        settings.remote_dir.as_deref(),
                        &self.ssh_program,
                    )
                {
                    if !has_text {
                        out.error(&format!("could not fetch the text repo: {}", error.message));
                        return Ok(self.pass_through(out, remote, &without_remote()));
                    }
                    out.error(&format!(
                        "searching the last fetched text: {}",
                        error.message
                    ));
                }
            } else if !has_index && !has_text {
                return Ok(self.pass_through(out, remote, &without_remote()));
            }
        }
        let query = SearchQuery {
            terms: parsed.positionals.clone(),
            agent: parsed.text("agent").filter(|v| !v.is_empty()),
            host: parsed.text("host").filter(|v| !v.is_empty()),
            project: parsed.text("project").filter(|v| !v.is_empty()),
            role: parsed.text("role").filter(|v| !v.is_empty()),
            kind: parsed.text("kind").filter(|v| !v.is_empty()),
            since: parsed.text("since").filter(|v| !v.is_empty()),
            until: parsed.text("until").filter(|v| !v.is_empty()),
            recent: parsed.flag("recent"),
            history: parsed.flag("history"),
            regex: parsed.flag("regex"),
            tool_output,
            limit: limit as usize,
        };
        if tool_output && !quiet {
            out.error(
                "searching tool output reads every archived transcript in raw/: this is slow",
            );
        }
        let mut shown: i64 = -1;
        let mut progress_lines: Vec<String> = Vec::new();
        let mut progress = |done: usize, total: usize| {
            let percent = (done * 100 / total.max(1)) as i64;
            if quiet || percent < shown + 10 {
                return;
            }
            shown = percent;
            progress_lines.push(format!("  {percent}% of {total} files"));
        };
        let result: SearchResult = search_archive(
            &archive_dir,
            &query,
            settings,
            SearchOptions {
                runtime: Some(runtime),
                live: None,
                cancel: None,
                on_progress: Some(&mut progress),
            },
        )?;
        for line in progress_lines {
            out.error(&line);
        }
        if quiet {
            out.log(&pretty(&result));
            return Ok(EXIT_OK);
        }
        if let Some(warning) = &result.warning {
            out.error(&format!("warning: {warning}"));
        }
        for hit in &result.hits {
            out.log(&format!(
                "{}  {}{}  {}/{}  {}{}",
                roamgate_agents_prefix(hit.ts.as_deref().unwrap_or("-"), 19),
                roamgate_agents_prefix(&hit.session, 8),
                if hit.subagent { " (subagent)" } else { "" },
                hit.host,
                hit.agent,
                js_tail(&hit.project, 40),
                match hit.matches {
                    Some(n) if n > 0 => format!("  {n} match(es)"),
                    _ => String::new(),
                }
            ));
            if let Some(title) = hit.title.as_ref().filter(|t| !t.is_empty()) {
                out.log(&format!("    title: {title}"));
            }
            match hit.snippets.as_ref().filter(|s| !s.is_empty()) {
                Some(snippets) => {
                    for snippet in snippets {
                        out.log(&format!("    {snippet}"));
                    }
                }
                None => out.log(&format!(
                    "    {}/{}{}: {}",
                    hit.role,
                    hit.kind,
                    hit.tool
                        .as_ref()
                        .filter(|t| !t.is_empty())
                        .map(|t| format!("/{t}"))
                        .unwrap_or_default(),
                    hit.snippet
                )),
            }
        }
        for entry in result.history.iter().flatten() {
            out.log(&format!(
                "{}  history  {}  {}\n    {}",
                entry.ts.as_deref().unwrap_or("-"),
                entry.host,
                entry.project.as_deref().unwrap_or(""),
                entry.snippet
            ));
        }
        out.log(&match result.sessions {
            Some(sessions) => format!(
                "-- {} of {sessions} session(s), {} matching message(s)",
                result.hits.len(),
                result.total
            ),
            None => format!(
                "-- {} of {} hit(s){}",
                result.hits.len(),
                result.total,
                if result.truncated { " (truncated)" } else { "" }
            ),
        });
        Ok(EXIT_OK)
    }

    async fn session(
        &self,
        action: &str,
        rest: &[String],
        settings: &ArchiveSettings,
        runtime: &ArchiveRuntime,
        out: &mut dyn Output,
    ) -> Outcome {
        let parsed = parse_args(
            rest,
            &with_common(&[
                text("agent"),
                text("host"),
                text("file"),
                text("from-line"),
                text("limit"),
                flag("dry-run"),
                text("remote"),
            ]),
            1,
        )?;
        let Some(id) = parsed.positionals.first().cloned() else {
            return Err(Failure::Usage(format!("{action} needs a session id")));
        };
        let archive_dir = self.archive_dir(settings, parsed.text("dir").as_deref(), out);
        let me: ResolvedHost = resolve_hosts(settings, runtime).remove(0);
        let remote = parsed.text("remote").or_else(|| settings.remote.clone());
        let agent = parsed.text("agent").filter(|v| !v.is_empty());
        let host = parsed.text("host").filter(|v| !v.is_empty());
        let mut use_remote = false;
        let lookup =
            if existing_archive_db(&archive_dir).is_some() && parsed.text("remote").is_none() {
                let mut lines = Vec::new();
                let db = open_or_rebuild(
                    runtime,
                    &archive_dir,
                    &mut |line| lines.push(line.to_owned()),
                    Some(settings),
                );
                for line in lines {
                    out.error(&line);
                }
                let db = db?;
                lookup_session(
                    &db.conn,
                    &id,
                    &LookupOptions {
                        agent: agent.clone(),
                        host: host.clone(),
                        runtime: Some(runtime),
                        self_host: Some(&me),
                    },
                )?
            } else if let Some(remote) = remote.as_deref().filter(|_| action == "resume") {
                use_remote = true;
                self.remote_lookup(remote, &id, agent.as_deref(), host.as_deref(), runtime, &me)?
            } else {
                return Err(Failure::Failed(
                    "no archive here; set archive.remote or pass --remote SSH".into(),
                ));
            };
        if action == "session" {
            if parsed.flag("json") {
                out.log(&pretty(&lookup));
            } else {
                out.log(&describe_lookup(&lookup));
            }
            return Ok(if lookup.found { EXIT_OK } else { EXIT_FAILURE });
        }
        if !lookup.found {
            return Err(Failure::Failed(match &lookup.candidates {
                Some(candidates) => format!(
                    "ambiguous session id: {}",
                    candidates
                        .iter()
                        .map(|c| format!("{}:{}", c.agent, c.session))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                None => format!("session {id} not found in the archive"),
            }));
        }
        if action == "cat" {
            let chunks = cat_file(&archive_dir, &lookup, parsed.text("file").as_deref())?;
            if parsed.text("from-line").is_some() || parsed.text("limit").is_some() {
                let from = js_number_of(&parsed.text("from-line").unwrap_or_else(|| "1".into()));
                let limit = js_number_of(&parsed.text("limit").unwrap_or_else(|| "50".into()));
                let (Some(from), Some(limit)) = (from, limit) else {
                    return Err(Failure::Usage(
                        "--from-line and --limit must be positive integers".into(),
                    ));
                };
                if from.fract() != 0.0 || from < 1.0 || limit.fract() != 0.0 || limit < 1.0 {
                    return Err(Failure::Usage(
                        "--from-line and --limit must be positive integers".into(),
                    ));
                }
                let slice = cat_lines(chunks, from as u64, limit as usize, 1_000_000);
                let text: String = slice.lines.iter().map(|line| format!("{line}\n")).collect();
                out.write(text.as_bytes());
                return Ok(EXIT_OK);
            }
            let mut chunks = chunks;
            let mut buffer = vec![0u8; 1 << 20];
            loop {
                let read = chunks.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                out.write(&buffer[..read]);
            }
            return Ok(EXIT_OK);
        }
        let local = LocalFileSource(&archive_dir);
        let ssh = SshFileSource::new(remote.as_deref().unwrap_or(""));
        let result = resume_session(
            &lookup,
            &ResumeOptions {
                runtime,
                self_host: &me,
                source: if use_remote { &ssh } else { &local },
                dry_run: parsed.flag("dry-run"),
                now: roamgate_archive::iso_now(),
            },
        )?;
        if parsed.flag("json") {
            out.log(&pretty(&result));
        } else {
            out.log(&result.message);
        }
        Ok(EXIT_OK)
    }

    fn pass_through(&self, out: &mut dyn Output, ssh: &str, args: &[String]) -> i32 {
        let binary = "\"$HOME/.local/bin/roamgate\"";
        let command = format!(
            "exec {binary} archive {}",
            args.iter()
                .map(|arg| sh_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let argv: Vec<String> = std::iter::once("ssh".to_owned())
            .chain(SSH_OPTIONS.iter().map(|s| (*s).to_owned()))
            .chain([ssh.to_owned(), command])
            .collect();
        let result = self.exec.run(&argv, Duration::from_secs(120));
        if !result.stdout.is_empty() {
            out.log(result.stdout.strip_suffix('\n').unwrap_or(&result.stdout));
        }
        if result.code != 0 {
            out.error(result.stderr.trim());
        }
        if result.code == 0 {
            EXIT_OK
        } else {
            EXIT_FAILURE
        }
    }

    fn remote_lookup(
        &self,
        ssh: &str,
        id: &str,
        agent: Option<&str>,
        host: Option<&str>,
        runtime: &ArchiveRuntime,
        me: &ResolvedHost,
    ) -> Result<SessionLookup, Failure> {
        let mut args = vec!["session".to_owned(), id.to_owned(), "--json".to_owned()];
        if let Some(agent) = agent {
            args.extend(["--agent".to_owned(), agent.to_owned()]);
        }
        if let Some(host) = host {
            args.extend(["--host".to_owned(), host.to_owned()]);
        }
        let command = format!(
            "exec \"$HOME/.local/bin/roamgate\" archive {}",
            args.iter()
                .map(|arg| sh_quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let argv: Vec<String> = std::iter::once("ssh".to_owned())
            .chain(SSH_OPTIONS.iter().map(|s| (*s).to_owned()))
            .chain([ssh.to_owned(), command])
            .collect();
        let result = self.exec.run(&argv, Duration::from_secs(120));
        let Ok(mut lookup) = serde_json::from_str::<SessionLookup>(&result.stdout) else {
            return Err(Failure::Failed(format!(
                "ssh {ssh}: archive session failed: {}",
                roamgate_agents_prefix(result.stderr.trim(), 200)
            )));
        };
        // Liveness is about this machine, not the archive's.
        let agent = lookup
            .agent
            .as_deref()
            .and_then(roamgate_agents::Agent::from_id);
        let main = lookup.files.iter().find(|f| !f.subagent).cloned();
        if let (Some(agent), Some(main), true) = (agent, main, lookup.found) {
            let target = agent.restore_relpath(&main.relpath, &runtime.home_dir.to_string_lossy());
            lookup.live = local_root(agent, me, runtime).join(target).exists();
            lookup.restorable = agent.supports_resume() && !lookup.live;
        }
        Ok(lookup)
    }
}

/// `str.slice(0, n)`.
fn roamgate_agents_prefix(text: &str, units: usize) -> String {
    roamgate_agents::js::utf16_prefix(text, units).to_owned()
}

/// `Number(text)`: None when it is NaN.
fn js_number_of(text: &str) -> Option<f64> {
    let trimmed = roamgate_agents::js::js_trim(text);
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Machine {
        _dir: tempfile::TempDir,
        home: PathBuf,
    }

    fn machine(archive: Value) -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let data = home.join(".config/roamgate");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join("settings.json"),
            json!({"version": 1, "archive": archive}).to_string(),
        )
        .unwrap();
        Machine { _dir: dir, home }
    }

    fn cli(machine: &Machine, gaming: bool, ssh: Option<&Path>) -> ArchiveCli {
        let home = machine.home.clone();
        ArchiveCli {
            env: Arc::new(std::collections::BTreeMap::from([(
                "HOME".to_owned(),
                home.to_string_lossy().into_owned(),
            )])),
            platform: "linux".into(),
            home: machine.home.clone(),
            app_data: None,
            hostname: "testhost".into(),
            exec: Arc::new(roamgate_archive::hosts::SystemExec),
            game_mode: Arc::new(move || Box::pin(async move { Some(gaming) })),
            ssh_program: ssh.map_or_else(|| "ssh".into(), |ssh| ssh.to_string_lossy().into_owned()),
            lower_priority: Arc::new(|| {}),
        }
    }

    async fn run(cli: &ArchiveCli, list: &[&str]) -> (i32, Captured) {
        let mut out = Captured::default();
        let code = cli.run(&args(list), &mut out).await;
        (code, out)
    }

    fn json_of(out: &Captured) -> Value {
        serde_json::from_str(&out.output.join("\n")).unwrap()
    }

    const SESSION: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    #[tokio::test]
    async fn sync_writes_the_text_repo_search_status_and_rebuild_text_use_it() {
        let m = machine(json!({"host": "desk"}));
        let dir = m.home.join(".claude/projects/-home-t-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{SESSION}.jsonl")),
            format!("{}\n", json!({"type": "user", "timestamp": "2026-11-14T10:00:00Z", "cwd": "/home/t/proj", "message": {"content": "where is the zebra"}})),
        )
        .unwrap();
        let idle = cli(&m, false, None);
        let (code, out) = run(&idle, &["sync", "--local-only", "--json"]).await;
        assert_eq!(code, 0, "{:?}", out.errors);
        assert_eq!(json_of(&out)["text"]["status"], "committed");
        let (code, out) = run(&idle, &["search", "zebra", "--json"]).await;
        assert_eq!(code, 0);
        let result = json_of(&out);
        assert_eq!(
            (
                result["source"].as_str(),
                result["hits"][0]["session"].as_str()
            ),
            (Some("text"), Some(SESSION))
        );
        let (code, out) = run(&idle, &["search", "zebra"]).await;
        assert_eq!(code, 0);
        assert!(out.output.join("\n").contains("1 match(es)"));
        let (code, out) = run(&idle, &["health", "--json"]).await;
        assert_eq!(code, 0);
        assert_eq!(json_of(&out)["text"]["files"], 1);
        let (code, out) = run(&idle, &["status", "--json"]).await;
        assert_eq!(code, 0);
        assert_eq!(
            (
                json_of(&out)["text"]["exists"].as_bool(),
                json_of(&out)["text"]["files"].as_u64()
            ),
            (Some(true), Some(1))
        );
        let gaming = cli(&m, true, None);
        let (code, out) = run(&gaming, &["sync", "--local-only", "--json"]).await;
        assert_eq!(code, 0);
        assert_eq!(json_of(&out)["text"]["status"], "deferred");
        assert_eq!(run(&gaming, &["rebuild-text"]).await.0, 75);
        let (code, out) = run(&idle, &["rebuild-text", "--json"]).await;
        assert_eq!(code, 0);
        assert_eq!(json_of(&out)["text"]["status"], "committed");
    }

    #[tokio::test]
    async fn another_machine_fetches_the_home_s_text_repo_and_searches_it() {
        let home = machine(json!({"host": "desk"}));
        let dir = home.home.join(".claude/projects/-home-t-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{SESSION}.jsonl")),
            format!("{}\n", json!({"type": "user", "timestamp": "2026-11-14T10:00:00Z", "message": {"content": "the okapi plan"}})),
        )
        .unwrap();
        assert_eq!(
            run(&cli(&home, false, None), &["sync", "--local-only"])
                .await
                .0,
            0
        );
        let other = machine(json!({"host": "mac", "remote": "desk"}));
        let ssh = other.home.join("fake-ssh");
        std::fs::write(
            &ssh,
            format!(
                "#!/bin/sh\nfor last; do :; done\ncd '{}' && exec sh -c \"$last\"\n",
                home.home.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let other_cli = cli(&other, false, Some(&ssh));
        let (code, out) = run(&other_cli, &["fetch-text", "--json"]).await;
        assert_eq!(code, 0, "{:?}", out.errors);
        assert_eq!(json_of(&out)["fetch"]["updated"], true);
        let (code, out) = run(&other_cli, &["search", "okapi", "--json"]).await;
        assert_eq!(code, 0, "{:?}", out.errors);
        let hit = &json_of(&out)["hits"][0];
        assert_eq!(
            (hit["session"].as_str(), hit["host"].as_str()),
            (Some(SESSION), Some("desk"))
        );
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn arguments_parse_as_node_parse_args_does() {
        let specs = with_common(&[
            many("host"),
            Spec {
                name: "limit",
                kind: Kind::Text,
                short: Some('n'),
            },
        ]);
        let parsed = parse_args(
            &args(&["--host", "a", "--host=b", "-n5", "pos", "--", "--json"]),
            &specs,
            5,
        )
        .ok()
        .unwrap();
        assert_eq!(parsed.list("host").unwrap(), vec!["a", "b"]);
        assert_eq!(parsed.text("limit").as_deref(), Some("5"));
        assert_eq!(parsed.positionals, vec!["pos", "--json"]);
        let message = |list: &[&str]| match parse_args(&args(list), &specs, 0) {
            Err(Failure::Usage(message)) => message,
            _ => panic!("no usage error"),
        };
        assert!(message(&["--nope"]).starts_with("Unknown option '--nope'. To specify"));
        assert_eq!(
            message(&["--json=1"]),
            "Option '--json' does not take an argument"
        );
        assert_eq!(
            message(&["--dir"]),
            "Option '--dir <value>' argument missing"
        );
        assert!(message(&["--dir", "--json"]).starts_with("Option '--dir' argument is ambiguous."));
        assert_eq!(message(&["x"]), "unexpected argument: x");
    }

    #[test]
    fn the_help_is_the_contract_s() {
        let golden = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/cli/help/archive.txt"),
        )
        .unwrap();
        assert_eq!(format!("{}\n", archive_help()), golden);
    }
}
