//! Worktree removal (worktree/remove.ts): one removal per workspace at a
//! time, the configured remove command, and the recovery of a checkout Git
//! no longer knows (its processes stopped, its files kept aside, Herdr's
//! removal forced).

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::assets::{TemplateValue, WORKTREE_STATE_SH, fill_template};
use roamgate_base::settings::js_trim;
use roamgate_git::{GitContext, Invocation, shell_quote};
use serde_json::{Map, Value};

use crate::worktree::command_template::{
    WorktreeCommandValues, missing_worktree_command, worktree_command_script,
    worktree_shell_invocation,
};

/// What is at a checkout's path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutState {
    Missing,
    Clean,
    Dirty,
    Residual,
    Unknown,
}

impl CheckoutState {
    pub fn name(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Clean => "clean",
            Self::Dirty => "dirty",
            Self::Residual => "residual",
            Self::Unknown => "unknown",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "missing" => Self::Missing,
            "clean" => Self::Clean,
            "dirty" => Self::Dirty,
            "residual" => Self::Residual,
            _ => Self::Unknown,
        }
    }
}

/// What a removal cleaned up (`WorktreeRemovalCleanup`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemovalCleanup {
    pub terminated_processes: usize,
    pub recovered_stale_checkout: bool,
    pub preserved_path: Option<String>,
    pub warning: Option<String>,
}

impl RemovalCleanup {
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "terminated_processes".into(),
            self.terminated_processes.into(),
        );
        if self.recovered_stale_checkout {
            out.insert("recovered_stale_checkout".into(), true.into());
        }
        if let Some(path) = &self.preserved_path {
            out.insert("preserved_path".into(), path.clone().into());
        }
        if let Some(warning) = &self.warning {
            out.insert("warning".into(), warning.clone().into());
        }
        Value::Object(out)
    }
}

/// A removal's end.
#[derive(Debug, Clone, PartialEq)]
pub struct RemovalOutcome {
    pub result: Value,
    pub cleanup: Option<RemovalCleanup>,
    /// Why the configured remove command was not used, when it was not.
    pub command_fallback: Option<String>,
}

/// The checkout's host, as a removal's recovery sees it.
pub trait RemovalRuntime: Send + Sync {
    fn inspect_checkout<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<CheckoutState, String>>;
    fn stop_checkout_processes<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, String>>;
    fn preserve_checkout<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, String>>;
}

const PROCESS_SCAN_TIMEOUT: Duration = Duration::from_millis(10_000);
const PROCESS_STOP_GRACE: Duration = Duration::from_millis(500);
/// Large ignored build trees can make Git deletion legitimately take
/// minutes.
pub const WORKTREE_REMOVE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn path_within_checkout(path: &str, checkout: &str) -> bool {
    let path = path.strip_suffix(" (deleted)").unwrap_or(path);
    let path = path.trim_end_matches('/');
    let checkout = checkout.trim_end_matches('/');
    path == checkout || path.starts_with(&format!("{checkout}/"))
}

/// Node's `path.resolve` of an absolute POSIX path.
fn resolve_posix(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

fn safe_checkout_path(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let normalized = resolve_posix(path);
    // Not the root: it has a last component and a parent other than itself.
    (normalized != "/").then_some(normalized)
}

/// The processes of a scan (`p<pid>` then `n<cwd>` lines) whose cwd is in
/// the checkout, sorted.
pub fn parse_checkout_process_ids(output: &str, checkout: &str) -> Vec<u32> {
    let mut ids = BTreeSet::new();
    let mut current: Option<u32> = None;
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(pid) = line.strip_prefix('p') {
            current = pid.parse::<u32>().ok().filter(|pid| *pid > 0);
            continue;
        }
        if let (Some(cwd), Some(pid)) = (line.strip_prefix('n'), current)
            && path_within_checkout(cwd, checkout)
        {
            ids.insert(pid);
        }
    }
    ids.into_iter().collect()
}

/// Whether Herdr's (or the remove command's) failure says Git no longer
/// knows the checkout as a worktree.
pub fn is_not_working_tree_remove_error(message: &str) -> bool {
    let message = message.to_lowercase();
    (message.contains("worktree_remove_failed:")
        || message.starts_with("worktree remove command failed"))
        && (message.contains("is not a working tree") || message.contains("is not a worktree"))
}

type Pending = Shared<BoxFuture<'static, Result<Value, String>>>;

/// One removal per workspace at a time: a second request for the same
/// workspace shares the first's end.
#[derive(Clone, Default)]
pub struct RemovalCoordinator {
    in_flight: Arc<Mutex<HashMap<String, (u64, Pending)>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}

impl RemovalCoordinator {
    pub async fn run<F>(
        &self,
        workspace_id: &str,
        operation: impl FnOnce() -> F,
    ) -> Result<Value, String>
    where
        F: Future<Output = Result<Value, String>> + Send + 'static,
    {
        if workspace_id.is_empty() {
            return Err("worktree.remove requires workspace_id".into());
        }
        let pending = {
            let mut in_flight = self.in_flight.lock().unwrap();
            if let Some((_, active)) = in_flight.get(workspace_id) {
                active.clone()
            } else {
                let id = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let map = self.in_flight.clone();
                let key = workspace_id.to_owned();
                let operation = operation();
                let pending: Pending = async move {
                    let result = operation.await;
                    let mut in_flight = map.lock().unwrap();
                    if in_flight.get(&key).is_some_and(|(at, _)| *at == id) {
                        in_flight.remove(&key);
                    }
                    result
                }
                .boxed()
                .shared();
                in_flight.insert(workspace_id.to_owned(), (id, pending.clone()));
                pending
            }
        };
        pending.await
    }
}

async fn stop_and_preserve_residual_checkout(
    path: &str,
    runtime: &dyn RemovalRuntime,
    terminated: &mut BTreeSet<u32>,
) -> Result<Option<String>, String> {
    terminated.extend(runtime.stop_checkout_processes(path).await?);
    match runtime.preserve_checkout(path).await {
        Ok(preserved) => Ok(Some(preserved)),
        Err(error) => {
            // The last process may remove the directory while it stops.
            let state = runtime
                .inspect_checkout(path)
                .await
                .unwrap_or(CheckoutState::Unknown);
            if state == CheckoutState::Missing {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

struct Finalize<'a> {
    result: Value,
    remover: &'a str,
    cleanup_path: Option<&'a str>,
    runtime: &'a dyn RemovalRuntime,
    terminated: &'a mut BTreeSet<u32>,
    recovered: bool,
    preserved_path: Option<String>,
    log: &'a (dyn Fn(&str) + Send + Sync),
}

async fn finalize_successful_removal(finalize: Finalize<'_>) -> RemovalOutcome {
    let Finalize {
        result,
        remover,
        cleanup_path,
        runtime,
        terminated,
        mut recovered,
        mut preserved_path,
        log,
    } = finalize;
    let mut warning = None;
    if let Some(path) = cleanup_path {
        let state = runtime
            .inspect_checkout(path)
            .await
            .unwrap_or(CheckoutState::Unknown);
        match state {
            CheckoutState::Residual => {
                match stop_and_preserve_residual_checkout(path, runtime, terminated).await {
                    Ok(preserved) => {
                        preserved_path = preserved.or(preserved_path);
                        recovered = true;
                    }
                    Err(error) => {
                        let text = format!(
                            "{remover} removed the worktree, but stale checkout cleanup failed: {error}"
                        );
                        log(&format!("[bridge] {text}"));
                        warning = Some(text);
                    }
                }
            }
            CheckoutState::Clean | CheckoutState::Dirty => {
                let text = format!(
                    "{remover} reported success, but the checkout is still a {} working tree at {path}",
                    state.name()
                );
                log(&format!("[bridge] {text}"));
                warning = Some(text);
            }
            CheckoutState::Unknown => {
                let text = format!(
                    "{remover} reported success, but the checkout removal could not be verified at {path}"
                );
                log(&format!("[bridge] {text}"));
                warning = Some(text);
            }
            CheckoutState::Missing => {}
        }
    }
    let cleanup =
        (!terminated.is_empty() || recovered || warning.is_some()).then_some(RemovalCleanup {
            terminated_processes: terminated.len(),
            recovered_stale_checkout: recovered,
            preserved_path,
            warning,
        });
    RemovalOutcome {
        result,
        cleanup,
        command_fallback: None,
    }
}

/// The script that runs a removal template: `{path}` and `{repo}` become
/// the exported `$ROAMGATE_WORKTREE_PATH` and `$ROAMGATE_WORKTREE_REPO`,
/// `{force}` is `--force` or nothing.
pub fn render_worktree_remove_command(
    template: &str,
    path: &str,
    repo: &str,
    force: bool,
) -> Result<String, String> {
    let script = worktree_command_script(
        template,
        &WorktreeCommandValues {
            path: Some(path.into()),
            repo: Some(repo.into()),
            force,
            ..WorktreeCommandValues::default()
        },
    )?;
    Ok(format!(
        "{}; cd \"$ROAMGATE_WORKTREE_REPO\" && {}",
        script.exports, script.command
    ))
}

/// Removes a checkout with the configured command, from its source
/// repository on the workspace's host: None once removed, or a sentence
/// saying the command is not installed there (then nothing runs); its
/// output as the error when it fails.
pub async fn run_worktree_remove_command(
    template: &str,
    checkout_path: &str,
    source_checkout_path: &str,
    force: bool,
    cx: &GitContext,
) -> Result<Option<String>, String> {
    run_worktree_remove_command_where(
        template,
        checkout_path,
        source_checkout_path,
        force,
        cx,
        || missing_worktree_command(template, cx).boxed(),
    )
    .await
}

async fn run_worktree_remove_command_where<'a>(
    template: &str,
    checkout_path: &str,
    source_checkout_path: &str,
    force: bool,
    cx: &GitContext,
    missing: impl FnOnce() -> BoxFuture<'a, Result<Option<String>, String>>,
) -> Result<Option<String>, String> {
    if let Some(missing) = missing().await? {
        return Ok(Some(missing));
    }
    let shell_command =
        render_worktree_remove_command(template, checkout_path, source_checkout_path, force)?;
    let ran = cx
        .run(
            worktree_shell_invocation(cx.host(), &shell_command),
            WORKTREE_REMOVE_TIMEOUT,
        )
        .await
        .map_err(|error| error.0)?;
    if ran.code != 0 {
        let output = match js_trim(&ran.stderr) {
            "" => js_trim(&ran.stdout),
            stderr => stderr,
        };
        let output = last_chars(output, 2000);
        return Err(if output.is_empty() {
            format!("Worktree remove command failed (exit {}).", ran.code)
        } else {
            format!(
                "Worktree remove command failed (exit {}): {output}",
                ran.code
            )
        });
    }
    Ok(None)
}

/// `text.slice(-count)` in UTF-16 units.
pub(crate) fn last_chars(text: &str, count: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units.len().saturating_sub(count);
    String::from_utf16_lossy(&units[start..])
}

/// What the configured remove command did: removed the checkout (an
/// answer shaped like Herdr's `worktree.remove`), or why it was not used.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandRemoval {
    Removed(Value),
    Fallback(String),
}

/// A removal (`removeWorktreeWithRecovery`).
pub struct Removal<'a> {
    /// Herdr's `worktree.remove` with its params.
    pub call: &'a (dyn Fn(Value) -> BoxFuture<'a, Result<Value, String>> + Send + Sync),
    pub params: Value,
    pub checkout_path: Option<String>,
    pub runtime: &'a dyn RemovalRuntime,
    pub remove_with_command: Option<BoxFuture<'a, Result<CommandRemoval, String>>>,
    pub log: &'a (dyn Fn(&str) + Send + Sync),
}

/// The default log of a removal: a warning of the worktree scope.
pub fn log_cleanup_warning(message: &str) {
    tracing::warn!(
        scope = "worktree",
        detail = message.strip_prefix("[bridge] ").unwrap_or(message),
        "cleanup warning"
    );
}

/// Removes the worktree (with the command, else through Herdr) and
/// recovers a checkout Git no longer knows as a worktree.
pub async fn remove_worktree_with_recovery(removal: Removal<'_>) -> Result<RemovalOutcome, String> {
    let Removal {
        call,
        params,
        checkout_path,
        runtime,
        remove_with_command,
        log,
    } = removal;
    let mut terminated = BTreeSet::new();
    let cleanup_path = checkout_path.as_deref().and_then(safe_checkout_path);
    if let Some(path) = &checkout_path
        && cleanup_path.is_none()
    {
        log(&format!(
            "[bridge] refusing worktree cleanup for unsafe path: {path}"
        ));
    }
    let mut command_fallback = None;
    let first: Result<RemovalOutcome, String> = async {
        let command = match remove_with_command {
            Some(command) => Some(command.await?),
            None => None,
        };
        let (result, remover) = match command {
            Some(CommandRemoval::Removed(result)) => (result, "The worktree remove command"),
            other => {
                if let Some(CommandRemoval::Fallback(fallback)) = other {
                    command_fallback = Some(fallback);
                }
                (call(params.clone()).await?, "Herdr")
            }
        };
        Ok(finalize_successful_removal(Finalize {
            result,
            remover,
            cleanup_path: cleanup_path.as_deref(),
            runtime,
            terminated: &mut terminated,
            recovered: false,
            preserved_path: None,
            log,
        })
        .await)
    }
    .await;
    let error = match first {
        Ok(mut outcome) => {
            outcome.command_fallback = command_fallback;
            return Ok(outcome);
        }
        Err(error) => error,
    };
    let Some(path) = cleanup_path.as_deref() else {
        return Err(error);
    };
    if !is_not_working_tree_remove_error(&error) {
        return Err(error);
    }
    let state = runtime
        .inspect_checkout(path)
        .await
        .unwrap_or(CheckoutState::Unknown);
    if matches!(
        state,
        CheckoutState::Clean | CheckoutState::Dirty | CheckoutState::Unknown
    ) {
        return Err(error);
    }
    let mut preserved_path = None;
    if state == CheckoutState::Residual {
        // A detached watcher can recreate a checkout after Git removed
        // its metadata: every process rooted there stops first.
        preserved_path = stop_and_preserve_residual_checkout(path, runtime, &mut terminated)
            .await
            .map_err(|stop| format!("{error}; unable to preserve the stale checkout: {stop}"))?;
    }
    let mut forced = params.clone();
    if let Value::Object(map) = &mut forced {
        map.insert("force".into(), true.into());
    }
    match call(forced).await {
        Ok(result) => {
            let mut outcome = finalize_successful_removal(Finalize {
                result,
                remover: "Herdr",
                cleanup_path: Some(path),
                runtime,
                terminated: &mut terminated,
                recovered: true,
                preserved_path,
                log,
            })
            .await;
            outcome.command_fallback = command_fallback;
            Ok(outcome)
        }
        Err(retry) => {
            let preserved = preserved_path
                .map(|path| format!("; stale files were preserved at {path}"))
                .unwrap_or_default();
            Err(format!("{error}{preserved}; recovery failed: {retry}"))
        }
    }
}

/// This machine's processes and their cwds, as the scan script prints
/// them, read from /proc; None without /proc (macOS, Windows).
async fn local_process_cwds() -> Option<String> {
    tokio::task::spawn_blocking(|| {
        let entries = std::fs::read_dir("/proc").ok()?;
        let mut out = String::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(pid) = name
                .to_str()
                .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
            else {
                continue;
            };
            if let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
                out.push_str(&format!("p{pid}\nn{}\n", cwd.to_string_lossy()));
            }
        }
        Some(out)
    })
    .await
    .ok()
    .flatten()
}

/// The checkout's host for a removal (`createWorktreeRemovalRuntime`).
#[derive(Clone)]
pub struct HostRemovalRuntime {
    pub cx: GitContext,
}

impl HostRemovalRuntime {
    fn shell(&self, script: &str) -> Invocation {
        match self.cx.host() {
            Some(host) => Invocation::ssh(host, script, None),
            None => Invocation::local(["sh", "-lc", script]),
        }
    }

    async fn run_shell(&self, script: &str) -> Result<roamgate_git::Ran, String> {
        self.cx
            .run(self.shell(script), PROCESS_SCAN_TIMEOUT)
            .await
            .map_err(|error| error.0)
    }

    async fn list_checkout_processes(&self, path: &str) -> Result<Vec<u32>, String> {
        let host = self.cx.host();
        let mut canonical = path.to_owned();
        if host.is_some() {
            let resolved = self
                .run_shell(&format!("cd {} 2>/dev/null && pwd -P", shell_quote(path)))
                .await?;
            if resolved.code == 0 && !js_trim(&resolved.stdout).is_empty() {
                canonical = js_trim(&resolved.stdout).to_owned();
            }
        } else if let Ok(real) = tokio::fs::canonicalize(path).await {
            canonical = real.to_string_lossy().into_owned();
        }
        let own = std::process::id();
        if host.is_none()
            && let Some(local) = local_process_cwds().await
        {
            return Ok(parse_checkout_process_ids(&local, &canonical)
                .into_iter()
                .filter(|pid| *pid != own)
                .collect());
        }
        let ran = self
            .run_shell(js_trim(roamgate_base::assets::PROCESS_CWDS_SH))
            .await?;
        if ran.code != 0 {
            return Err(match js_trim(&ran.stderr) {
                "" => format!("process scan exited {}", ran.code),
                stderr => stderr.to_owned(),
            });
        }
        Ok(parse_checkout_process_ids(&ran.stdout, &canonical)
            .into_iter()
            .filter(|pid| host.is_some() || *pid != own)
            .collect())
    }

    async fn signal(&self, signal: &str, ids: &[u32]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = ids.iter().map(u32::to_string).collect();
        let command = format!("kill -{signal} {} 2>/dev/null || true", ids.join(" "));
        self.run_shell(&command).await.map(|_| ())
    }

    async fn stop(&self, path: &str) -> Result<Vec<u32>, String> {
        let candidates = self.list_checkout_processes(path).await?;
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        // A PID must survive a second scan: that leaves out the scanner's
        // own shell and narrows PID reuse before a signal.
        let confirmed: BTreeSet<u32> = self
            .list_checkout_processes(path)
            .await?
            .into_iter()
            .collect();
        let initial: Vec<u32> = candidates
            .into_iter()
            .filter(|pid| confirmed.contains(pid))
            .collect();
        if initial.is_empty() {
            return Ok(Vec::new());
        }
        self.signal("TERM", &initial).await?;
        tokio::time::sleep(PROCESS_STOP_GRACE).await;
        let remaining = self.list_checkout_processes(path).await?;
        self.signal("KILL", &remaining).await?;
        if !remaining.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let survivors = self.list_checkout_processes(path).await?;
            if !survivors.is_empty() {
                let list: Vec<String> = survivors.iter().map(u32::to_string).collect();
                return Err(format!(
                    "processes still use the checkout after termination: {}",
                    list.join(", ")
                ));
            }
        }
        Ok(initial)
    }

    async fn preserve(&self, path: &str) -> Result<String, String> {
        let stamp: String = roamgate_git::steps::iso_time(now_ms())
            .chars()
            .filter(|c| !"-:TZ.".contains(*c))
            .take(14)
            .collect();
        let (dir, name) = match path.rfind('/') {
            Some(0) => ("/", &path[1..]),
            Some(at) => (&path[..at], &path[at + 1..]),
            None => (".", path),
        };
        let destination = format!(
            "{}/{name}.recovered-{stamp}-{}",
            dir.trim_end_matches('/'),
            random_hex(3)
        );
        let Some(host) = self.cx.host() else {
            tokio::fs::rename(path, &destination)
                .await
                .map_err(|error| error.to_string())?;
            return Ok(destination);
        };
        let command = format!(
            "mv_bin=$(command -v mv 2>/dev/null || true); [ -n \"$mv_bin\" ] || mv_bin=/bin/mv; \"$mv_bin\" {} {}",
            shell_quote(path),
            shell_quote(&destination)
        );
        let ran = self
            .cx
            .run(Invocation::ssh(host, &command, None), PROCESS_SCAN_TIMEOUT)
            .await
            .map_err(|error| error.0)?;
        if ran.code != 0 {
            return Err(match js_trim(&ran.stderr) {
                "" => format!("mv exited {}", ran.code),
                stderr => stderr.to_owned(),
            });
        }
        Ok(destination)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> String {
    use std::hash::{BuildHasher as _, Hasher as _};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(now_ms() as u128);
    let value = hasher.finish();
    format!("{value:016x}")[..bytes * 2].to_owned()
}

impl RemovalRuntime for HostRemovalRuntime {
    fn inspect_checkout<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<CheckoutState, String>> {
        async move {
            let script = fill_template(
                WORKTREE_STATE_SH,
                &[("path", TemplateValue::Text(shell_quote(path)))],
            )
            .map_err(|error| error.to_string())?;
            let ran = self.run_shell(js_trim(&script)).await?;
            Ok(CheckoutState::parse(js_trim(&ran.stdout)))
        }
        .boxed()
    }

    fn stop_checkout_processes<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, String>> {
        self.stop(path).boxed()
    }

    fn preserve_checkout<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, String>> {
        self.preserve(path).boxed()
    }
}

#[cfg(test)]
mod tests;
