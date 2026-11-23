//! A connection's workspace auto-sync (workspace/auto-sync.ts): every
//! [`AUTO_SYNC_POLL`] (and at once when a checkout's setting turns on),
//! each enabled checkout whose interval passed fetches origin's default
//! branch and merges it into a clean branch, and the result is kept in
//! settings.json's `workspace_auto_sync`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger, RecoveryReporter, iso_millis, parse_iso_millis};
use roamgate_base::settings::{
    DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES, connection_settings_prefix,
    workspace_auto_sync_settings_key,
};
use roamgate_git::default_branch::fetch_origin_default_branch;
use roamgate_git::shell::shell_command;
use roamgate_git::{GIT_PULL_TIMEOUT, GitContext, Ran, RunError, shell_quote};
use serde_json::{Map, Value, json};

use crate::connection::{WorkspaceConnection, WorkspaceError};

/// How often the enabled checkouts are looked at.
pub const AUTO_SYNC_POLL: Duration = Duration::from_millis(30_000);

/// What a sync did, as kept in settings.json.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncResult {
    pub last_status: Option<String>,
    pub last_message: Option<String>,
    pub last_branch: Option<String>,
}

impl SyncResult {
    fn new(status: &str, message: impl Into<String>, branch: Option<&str>) -> Self {
        Self {
            last_status: Some(status.into()),
            last_message: Some(message.into()),
            last_branch: branch.map(str::to_owned),
        }
    }
}

/// A workspace's checkout as a resolver finds it: the Herdr workspace and
/// its Git root (files.ts `resolveWorkspaceGitRoot`).
#[derive(Debug, Clone)]
pub struct ResolvedRoot {
    pub workspace: Value,
    pub root: String,
}

/// Resolves a workspace id to its Git root.
pub type GitRootResolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<ResolvedRoot, WorkspaceError>> + Send + Sync>;

/// Tells the status badges a checkout changed.
pub type Invalidate = Arc<dyn Fn(&str) + Send + Sync>;

/// Runs a sync of one checkout (`syncWorkspaceBranch` unless a test
/// replaces it): the checkout's runner and root.
pub type SyncBranch =
    Arc<dyn Fn(GitContext, String) -> BoxFuture<'static, Result<SyncResult, String>> + Send + Sync>;

fn process_message(result: &Ran, fallback: &str) -> String {
    let stderr = result.stderr.trim();
    let stdout = result.stdout.trim();
    let text = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback
    };
    roamgate_base::log::slice_utf16(text, 2_000).to_owned()
}

/// The checkout a setting's key names on this connection, "" when the key
/// is another connection's or host's.
fn configured_checkout_path(
    key: &str,
    entry: &Value,
    host: Option<&str>,
    connection_id: Option<&str>,
) -> String {
    let prefix = format!(
        "{}{}",
        connection_settings_prefix(connection_id),
        match host {
            Some(host) => format!("ssh:{host}:"),
            None => "local:".to_owned(),
        }
    );
    if !key.starts_with(&prefix) {
        return String::new();
    }
    if let Some(entry_host) = entry.get("host")
        && entry_host.as_str() != host
    {
        return String::new();
    }
    if let Some(path) = entry
        .get("checkout_path")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        return if workspace_auto_sync_settings_key(path, host, connection_id).as_deref()
            == Some(key)
        {
            path.to_owned()
        } else {
            String::new()
        };
    }
    key[prefix.len()..].to_owned()
}

fn path_is_within_root(path: &str, root: &str) -> bool {
    let normalized = if root == "/" {
        root
    } else {
        root.trim_end_matches('/')
    };
    path == normalized
        || path.starts_with(&if normalized == "/" {
            "/".to_owned()
        } else {
            format!("{normalized}/")
        })
}

/// Merges origin's default branch into the checkout's branch when it is
/// clean and stays so while the fetch runs (`syncWorkspaceBranch`).
pub async fn sync_workspace_branch<'a>(
    cx: &'a GitContext,
    root: &'a str,
) -> Result<SyncResult, String> {
    let run_git = move |args: String| -> BoxFuture<'a, Result<Ran, RunError>> {
        let command = format!("GIT_TERMINAL_PROMPT=0 git -C {} {args}", shell_quote(root));
        async move {
            let invocation = shell_command(&command, cx.host()).map_err(RunError)?;
            cx.run(invocation, GIT_PULL_TIMEOUT).await
        }
        .boxed()
    };
    let git = |args: &str| run_git(args.to_owned());
    let repository = git("rev-parse --is-inside-work-tree")
        .await
        .map_err(|e| e.0)?;
    if repository.code != 0 || repository.stdout.trim() != "true" {
        return Ok(SyncResult {
            last_status: Some("failed".into()),
            last_message: Some(process_message(
                &repository,
                "Workspace is no longer inside a Git repository.",
            )),
            last_branch: None,
        });
    }
    let branch_result = git("symbolic-ref --quiet --short HEAD")
        .await
        .map_err(|e| e.0)?;
    if branch_result.code != 0 {
        return Ok(SyncResult {
            last_status: Some("skipped".into()),
            last_message: Some("Skipped because the workspace is on a detached HEAD.".into()),
            last_branch: None,
        });
    }
    let branch = branch_result.stdout.trim().to_owned();
    let branch = branch.as_str();
    // Automated merges are only safe when no user changes can be
    // overwritten or mixed into conflict recovery.
    let status = git("status --porcelain=v1 --untracked-files=normal")
        .await
        .map_err(|e| e.0)?;
    if status.code != 0 {
        return Ok(SyncResult::new(
            "failed",
            process_message(&status, "git status failed"),
            Some(branch),
        ));
    }
    if !status.stdout.trim().is_empty() {
        return Ok(SyncResult::new(
            "skipped",
            "Skipped because the workspace has uncommitted changes.",
            Some(branch),
        ));
    }
    let before = git("rev-parse HEAD").await.map_err(|e| e.0)?;
    if before.code != 0 {
        return Ok(SyncResult::new(
            "failed",
            process_message(&before, "Unable to read HEAD"),
            Some(branch),
        ));
    }
    let base = match fetch_origin_default_branch(&|args| run_git(args)).await {
        Ok(base) => base,
        Err(error) => {
            return Ok(SyncResult::new(
                "failed",
                roamgate_base::log::slice_utf16(&error.to_string(), 2_000),
                Some(branch),
            ));
        }
    };
    // Fetch can take long enough for a user or agent to change branches,
    // commit, or edit files. Never merge into a checkout that changed after
    // preflight.
    let branch_after = git("symbolic-ref --quiet --short HEAD")
        .await
        .map_err(|e| e.0)?;
    let status_after = git("status --porcelain=v1 --untracked-files=normal")
        .await
        .map_err(|e| e.0)?;
    let head_after = git("rev-parse HEAD").await.map_err(|e| e.0)?;
    if branch_after.code != 0 || status_after.code != 0 || head_after.code != 0 {
        let failed = if branch_after.code != 0 {
            &branch_after
        } else if status_after.code != 0 {
            &status_after
        } else {
            &head_after
        };
        return Ok(SyncResult::new(
            "failed",
            process_message(
                failed,
                &format!(
                    "Unable to verify the workspace after fetching {}",
                    base.base
                ),
            ),
            Some(branch),
        ));
    }
    if branch_after.stdout.trim() != branch
        || !status_after.stdout.trim().is_empty()
        || head_after.stdout.trim() != before.stdout.trim()
    {
        let now = branch_after.stdout.trim();
        return Ok(SyncResult::new(
            "skipped",
            format!(
                "Skipped because the workspace changed while {} was being fetched.",
                base.base
            ),
            Some(if now.is_empty() { branch } else { now }),
        ));
    }
    let merge = run_git(format!(
        "-c commit.gpgsign=false merge --no-edit --no-stat {}",
        shell_quote(&base.commit)
    ))
    .await
    .map_err(|e| e.0)?;
    if merge.code != 0 {
        // A failed merge may leave conflict state behind. Since the
        // preflight required a clean worktree, aborting restores the exact
        // pre-sync state.
        git("merge --abort").await.map_err(|e| e.0)?;
        return Ok(SyncResult::new(
            "failed",
            process_message(
                &merge,
                &format!("{} could not be merged; the merge was aborted", base.base),
            ),
            Some(branch),
        ));
    }
    let after = git("rev-parse HEAD").await.map_err(|e| e.0)?;
    if after.code != 0 {
        return Ok(SyncResult::new(
            "failed",
            process_message(&after, "Unable to read updated HEAD"),
            Some(branch),
        ));
    }
    let updated = before.stdout.trim() != after.stdout.trim();
    Ok(if updated {
        SyncResult::new(
            "updated",
            format!("Merged {} into {branch}.", base.base),
            Some(branch),
        )
    } else {
        SyncResult::new(
            "up_to_date",
            format!("{branch} is already up to date with {}.", base.base),
            Some(branch),
        )
    })
}

fn default_sync_branch() -> SyncBranch {
    Arc::new(|cx: GitContext, root: String| {
        async move { sync_workspace_branch(&cx, &root).await }.boxed()
    })
}

/// `formatError`'s default: one line, 2000 characters at most.
fn format_error(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    roamgate_base::log::slice_utf16(&joined, 2_000).to_owned()
}

/// What the auto-sync needs besides its connection.
pub struct AutoSyncArgs {
    pub conn: WorkspaceConnection,
    pub clock: SharedClock,
    pub logger: Logger,
    pub invalidate_git_status: Invalidate,
    pub resolve_git_root: GitRootResolver,
    /// None: [`sync_workspace_branch`].
    pub sync_branch: Option<SyncBranch>,
}

type Task = Shared<BoxFuture<'static, ()>>;

#[derive(Default)]
struct State {
    started: bool,
    generation: u64,
    timer: Option<tokio::task::JoinHandle<()>>,
    running: Option<(u64, Task)>,
    tasks: u64,
    stopping: Option<Task>,
    rerun: bool,
    running_keys: BTreeSet<String>,
    forced_keys: BTreeSet<String>,
}

struct Inner {
    conn: WorkspaceConnection,
    clock: SharedClock,
    logger: Logger,
    invalidate: Invalidate,
    resolve: GitRootResolver,
    sync_branch: SyncBranch,
    tick_failures: RecoveryReporter,
    sync_failures: Mutex<BTreeMap<String, Arc<RecoveryReporter>>>,
    state: Mutex<State>,
}

/// One connection generation's auto-sync.
#[derive(Clone)]
pub struct AutoSync(Arc<Inner>);

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

impl AutoSync {
    pub fn new(args: AutoSyncArgs) -> Self {
        let clock = args.clock.clone();
        let now: roamgate_base::log::NowFn = Arc::new(move || clock.now());
        Self(Arc::new(Inner {
            tick_failures: RecoveryReporter::new(
                args.logger.clone(),
                "workspace auto-sync tick failed",
                "workspace auto-sync tick recovered",
                now,
            ),
            conn: args.conn,
            clock: args.clock,
            logger: args.logger,
            invalidate: args.invalidate_git_status,
            resolve: args.resolve_git_root,
            sync_branch: args.sync_branch.unwrap_or_else(default_sync_branch),
            sync_failures: Mutex::new(BTreeMap::new()),
            state: Mutex::new(State::default()),
        }))
    }

    fn connection_id(&self) -> &str {
        &self.0.conn.id
    }

    fn current(&self, generation: u64) -> bool {
        let state = self.0.state.lock().unwrap();
        state.started && state.generation == generation
    }

    fn sync_reporter(&self, key: &str) -> Arc<RecoveryReporter> {
        let clock = self.0.clock.clone();
        self.0
            .sync_failures
            .lock()
            .unwrap()
            .entry(key.to_owned())
            .or_insert_with(|| {
                Arc::new(RecoveryReporter::new(
                    self.0.logger.clone(),
                    "workspace auto-sync failed",
                    "workspace auto-sync recovered",
                    Arc::new(move || clock.now()),
                ))
            })
            .clone()
    }

    /// Starts the poll and runs a tick now.
    pub fn start(&self) {
        {
            let mut state = self.0.state.lock().unwrap();
            if state.started {
                return;
            }
            state.started = true;
            state.generation += 1;
            state.stopping = None;
            let this = self.clone();
            let mut interval = self.0.clock.interval(AUTO_SYNC_POLL);
            state.timer = Some(tokio::spawn(async move {
                loop {
                    interval.tick().await;
                    drop(this.tick());
                }
            }));
        }
        drop(self.tick());
    }

    /// Stops the poll and waits for a tick in flight; its results are not
    /// published.
    pub fn stop(&self) -> BoxFuture<'static, ()> {
        let mut state = self.0.state.lock().unwrap();
        if let Some(stopping) = &state.stopping {
            return stopping.clone().boxed();
        }
        if !state.started && state.running.is_none() {
            return async {}.boxed();
        }
        state.started = false;
        state.generation += 1;
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        state.rerun = false;
        state.forced_keys.clear();
        let drain = state.running.as_ref().map(|(_, task)| task.clone());
        let this = self.clone();
        let stopping: Task = async move {
            if let Some(drain) = drain {
                drain.await;
            }
            this.0.state.lock().unwrap().running_keys.clear();
        }
        .boxed()
        .shared();
        state.stopping = Some(stopping.clone());
        stopping.boxed()
    }

    /// A checkout's setting changed: on, it syncs now (after a tick in
    /// flight); off, a pending forced sync is dropped.
    pub fn settings_changed(&self, key: &str, enabled: bool) {
        {
            let mut state = self.0.state.lock().unwrap();
            if !state.started {
                return;
            }
            if !enabled {
                state.forced_keys.remove(key);
                return;
            }
            state.forced_keys.insert(key.to_owned());
            if state.running.is_some() {
                state.rerun = true;
                return;
            }
        }
        drop(self.tick());
    }

    /// Whether the checkout's sync runs now.
    pub fn is_running(&self, key: &str) -> bool {
        self.0.state.lock().unwrap().running_keys.contains(key)
    }

    /// One pass over the enabled checkouts, unless one runs already.
    fn tick(&self) -> BoxFuture<'static, ()> {
        let mut state = self.0.state.lock().unwrap();
        if !state.started {
            return async {}.boxed();
        }
        if let Some((_, task)) = &state.running {
            return task.clone().boxed();
        }
        let generation = state.generation;
        state.tasks += 1;
        let id = state.tasks;
        let this = self.clone();
        let handle = tokio::spawn(async move {
            this.run_tick(generation).await;
            let rerun = {
                let mut state = this.0.state.lock().unwrap();
                if state.running.as_ref().is_some_and(|(task, _)| *task == id) {
                    state.running = None;
                }
                let rerun = state.started && state.generation == generation && state.rerun;
                if rerun {
                    state.rerun = false;
                }
                rerun
            };
            if rerun {
                drop(this.tick());
            }
        });
        let task: Task = async move {
            let _ = handle.await;
        }
        .boxed()
        .shared();
        state.running = Some((id, task.clone()));
        task.boxed()
    }

    fn entries(settings: &roamgate_base::settings::Settings) -> Map<String, Value> {
        settings
            .get("workspace_auto_sync")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    async fn run_tick(&self, generation: u64) {
        let connection = self.connection_id().to_owned();
        match self.tick_body(generation).await {
            Ok(false) => {}
            Ok(true) => {
                self.0
                    .tick_failures
                    .recovered(Some(&fields(&[("connection", connection.into())])));
            }
            Err(error) => {
                if self.current(generation) {
                    self.0.tick_failures.failure(
                        &format_error(&error),
                        Some(&fields(&[("connection", connection.into())])),
                    );
                }
            }
        }
    }

    /// True when the pass got to its end.
    async fn tick_body(&self, generation: u64) -> Result<bool, String> {
        let conn = &self.0.conn;
        let connection_id = Some(conn.id.as_str());
        let settings = conn.settings.read().await;
        if !self.current(generation) {
            return Ok(false);
        }
        let host = conn.ssh_host().map(str::to_owned);
        let host = host.as_deref();
        let enabled: Vec<(String, Value)> = Self::entries(&settings)
            .into_iter()
            .filter(|(key, entry)| {
                entry.get("enabled") == Some(&Value::Bool(true))
                    && !configured_checkout_path(key, entry, host, connection_id).is_empty()
            })
            .collect();
        if enabled.is_empty() {
            return Ok(false);
        }
        let listed = conn.herdr_call("workspace.list", json!({}), None).await?;
        if !self.current(generation) {
            return Ok(false);
        }
        let workspaces = listed
            .get("workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let enabled_keys: BTreeSet<&str> = enabled.iter().map(|(key, _)| key.as_str()).collect();
        let mut enabled_roots: Vec<(String, String)> = enabled
            .iter()
            .map(|(key, entry)| {
                (
                    key.clone(),
                    configured_checkout_path(key, entry, host, connection_id),
                )
            })
            .filter(|(_, root)| !root.is_empty())
            .collect();
        // Longest root first (a stable sort, as Array.sort is).
        enabled_roots.sort_by_key(|(_, root)| std::cmp::Reverse(root.len()));
        let mut by_key: BTreeMap<String, (Value, String)> = BTreeMap::new();
        for workspace in &workspaces {
            if !self.current(generation) {
                return Ok(false);
            }
            if by_key.len() == enabled_roots.len() {
                break;
            }
            let candidates: Vec<&str> = [
                workspace
                    .get("worktree")
                    .and_then(|worktree| worktree.get("checkout_path")),
                workspace.get("cwd"),
            ]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|path| !path.is_empty())
            .collect();
            let direct = enabled_roots.iter().find(|(_, root)| {
                candidates
                    .iter()
                    .any(|path| path_is_within_root(path, root))
            });
            if let Some((key, root)) = direct
                && !by_key.contains_key(key)
            {
                by_key.insert(key.clone(), (workspace.clone(), root.clone()));
                continue;
            }
            if let Some(id) = workspace.get("workspace_id").and_then(Value::as_str)
                && !id.is_empty()
            {
                let Ok(resolved) = (self.0.resolve)(id.to_owned()).await else {
                    continue;
                };
                if !self.current(generation) {
                    return Ok(false);
                }
                if let Some(key) =
                    workspace_auto_sync_settings_key(&resolved.root, host, connection_id)
                    && enabled_keys.contains(key.as_str())
                    && !by_key.contains_key(&key)
                {
                    by_key.insert(key, (workspace.clone(), resolved.root));
                }
            }
        }
        for (key, _) in &enabled {
            if !self.current(generation) {
                return Ok(false);
            }
            let settings = conn.settings.read().await;
            if !self.current(generation) {
                return Ok(false);
            }
            let entry = Self::entries(&settings).get(key).cloned();
            let Some(entry) =
                entry.filter(|entry| entry.get("enabled") == Some(&Value::Bool(true)))
            else {
                self.0.state.lock().unwrap().forced_keys.remove(key);
                continue;
            };
            let forced = self.0.state.lock().unwrap().forced_keys.contains(key);
            let last_run = entry
                .get("last_run_at")
                .and_then(Value::as_str)
                .filter(|at| !at.is_empty())
                .and_then(parse_iso_millis);
            let minutes = entry
                .get("interval_minutes")
                .and_then(Value::as_f64)
                .filter(|minutes| *minutes != 0.0)
                .unwrap_or(DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES as f64);
            let interval_ms = minutes * 60_000.0;
            if !forced
                && let Some(last_run) = last_run
                && ((self.0.clock.now() - last_run) as f64) < interval_ms
            {
                continue;
            }
            let Some((workspace, root)) = by_key.get(key).cloned() else {
                continue;
            };
            let workspace_id = workspace
                .get("workspace_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .unwrap_or("unknown")
                .to_owned();
            {
                let mut state = self.0.state.lock().unwrap();
                state.forced_keys.remove(key);
                state.running_keys.insert(key.clone());
            }
            self.0.logger.debug(
                "workspace auto-sync started",
                Some(&fields(&[
                    ("connection", conn.id.clone().into()),
                    ("workspace", workspace_id.clone().into()),
                    ("path", root.clone().into()),
                ])),
            );
            let outcome = (self.0.sync_branch)(conn.git.clone(), root.clone()).await;
            self.0.state.lock().unwrap().running_keys.remove(key);
            if !self.current(generation) {
                return Ok(false);
            }
            let result = match outcome {
                Ok(result) => {
                    (self.0.invalidate)(&root);
                    result
                }
                Err(error) => SyncResult {
                    last_status: Some("failed".into()),
                    last_message: Some(format_error(&error)),
                    last_branch: None,
                },
            };
            self.record_result(generation, key, &root, host, &result)
                .await?;
            if !self.current(generation) {
                return Ok(false);
            }
            let status = result
                .last_status
                .clone()
                .unwrap_or_else(|| "failed".into());
            let detail = format_error(result.last_message.as_deref().unwrap_or(""));
            let result_fields = fields(&[
                ("connection", conn.id.clone().into()),
                ("workspace", workspace_id.into()),
                ("status", status.clone().into()),
                ("detail", detail.into()),
            ]);
            let reporter = self.sync_reporter(key);
            if result.last_status.as_deref() == Some("failed") {
                reporter.failure(
                    result.last_message.as_deref().unwrap_or("sync failed"),
                    Some(&result_fields),
                );
            } else {
                reporter.recovered(Some(&result_fields));
                self.0
                    .logger
                    .debug("workspace auto-sync finished", Some(&result_fields));
            }
        }
        Ok(true)
    }

    async fn record_result(
        &self,
        generation: u64,
        key: &str,
        root: &str,
        host: Option<&str>,
        result: &SyncResult,
    ) -> Result<(), String> {
        if !self.current(generation) {
            return Ok(());
        }
        let this = self.clone();
        let (key, root, host, result) = (
            key.to_owned(),
            root.to_owned(),
            host.map(str::to_owned),
            result.clone(),
        );
        let at = iso_millis(self.0.clock.now());
        self.0
            .conn
            .settings
            .update(Box::new(move |settings| {
                if !this.current(generation) {
                    return None;
                }
                let mut entries = Self::entries(settings);
                let existing = entries.get(&key)?.as_object()?.clone();
                let mut entry = existing;
                for (field, value) in [
                    ("last_status", &result.last_status),
                    ("last_message", &result.last_message),
                    ("last_branch", &result.last_branch),
                ] {
                    if let Some(value) = value {
                        entry.insert(field.into(), value.clone().into());
                    }
                }
                entry.insert("checkout_path".into(), root.into());
                match host {
                    Some(host) => {
                        entry.insert("host".into(), host.into());
                    }
                    None => {
                        entry.remove("host");
                    }
                }
                entry.insert("last_run_at".into(), at.into());
                entries.insert(key, Value::Object(entry));
                Some(settings.with("workspace_auto_sync", Some(Value::Object(entries))))
            }))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests;
