//! Worktree hooks (worktree/worktree-hooks.ts): `roamgate.json` or
//! `paseo.json` in the checkout or its source names a shell command per
//! lifecycle event; each runs in the checkout on the connection's host,
//! with the paths in its environment (Paseo's, Roamgate's and the legacy
//! herdr-gui names).

use std::sync::Arc;
use std::time::Duration;

use roamgate_base::settings::{js_trim, workspace_repo_settings_key};
use roamgate_git::{Invocation, shell_quote};
use serde_json::{Map, Value, json};

use crate::connection::{BoxFuture, WorkspaceConnection, WorkspaceError};
use crate::worktree::paths::{
    checkout_path, field, id_param, is_linked_worktree, source_checkout_path, unique_strings,
};

/// What runs a hook: TS's `runProcessWithCode`, which had no deadline.
const HOOK_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
/// Reading a hook file over SSH.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The changed target's error.
pub const TARGET_CHANGED: &str = "The worktree target changed.";

/// The hook names, in the order a configuration lists them.
pub const HOOKS: [Hook; 4] = [Hook::Setup, Hook::Opened, Hook::Teardown, Hook::Removed];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hook {
    Setup,
    Opened,
    Teardown,
    Removed,
}

impl Hook {
    pub fn name(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Opened => "opened",
            Self::Teardown => "teardown",
            Self::Removed => "removed",
        }
    }

    /// The GUI notice event the hook reports as.
    pub fn event(self) -> &'static str {
        match self {
            Self::Setup => "worktree.created",
            Self::Opened => "worktree.opened",
            Self::Teardown => "worktree.before_remove",
            Self::Removed => "worktree.removed",
        }
    }
}

/// A hook's run, as the browser gets it (`WorktreeHookRunResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookRun {
    pub event: &'static str,
    /// `skipped`, `succeeded` or `failed`.
    pub status: &'static str,
    /// `setup_hook_changed` or `hooks_enabled_changed`.
    pub reason: Option<&'static str>,
    pub exit_code: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
}

impl HookRun {
    pub fn skipped(event: &'static str) -> Self {
        Self {
            event,
            status: "skipped",
            ..Self::default()
        }
    }

    fn skipped_because(event: &'static str, reason: &'static str) -> Self {
        Self {
            reason: Some(reason),
            ..Self::skipped(event)
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("event".into(), self.event.into());
        out.insert("status".into(), self.status.into());
        if let Some(reason) = self.reason {
            out.insert("reason".into(), reason.into());
        }
        if let Some(code) = self.exit_code {
            out.insert("exit_code".into(), code.into());
        }
        if let Some(stdout) = &self.stdout {
            out.insert("stdout".into(), stdout.clone().into());
        }
        if let Some(stderr) = &self.stderr {
            out.insert("stderr".into(), stderr.clone().into());
        }
        if let Some(error) = &self.error {
            out.insert("error".into(), error.clone().into());
        }
        Value::Object(out)
    }
}

/// What a confirmation saw of the setup hook (Ranger's preview).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookExpectation {
    pub command: Option<String>,
    pub enabled: bool,
}

/// A hook configuration as read: its file, which name it had, the hooks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedHooks {
    pub path: String,
    /// `roamgate` or `paseo`.
    pub source: &'static str,
    /// The hooks it sets, by name.
    pub config: Vec<(Hook, String)>,
}

impl LoadedHooks {
    pub fn command(&self, hook: Hook) -> Option<&str> {
        self.config
            .iter()
            .find(|(name, _)| *name == hook)
            .map(|(_, command)| command.as_str())
    }

    /// The hooks as the settings dialog shows them.
    pub fn config_value(&self) -> Value {
        let mut out = Map::new();
        for (hook, command) in &self.config {
            out.insert(hook.name().into(), command.clone().into());
        }
        Value::Object(out)
    }
}

/// A configuration that exists but cannot be used (`WorktreeHookConfigError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Failed to read worktree hooks from {path}: {cause}")]
pub struct HookConfigError {
    pub path: String,
    pub source_name: &'static str,
    pub cause: String,
}

/// Why the hooks could not be read: their configuration, or the host
/// (a Windows host refuses the hook runner).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReadHooksError {
    #[error(transparent)]
    Config(#[from] HookConfigError),
    #[error("{0}")]
    Host(String),
}

/// Whether a repository's hooks run (the repository's settings key).
pub type HooksEnabled = Arc<dyn Fn(Option<String>) -> BoxFuture<'static, bool> + Send + Sync>;

/// The checkout a removal's hooks run for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveHookContext {
    pub checkout_path: String,
    pub source_checkout_path: String,
    pub repo_settings_key: Option<String>,
}

/// One hook to run (`runWorktreeHook`'s arguments).
pub struct HookCall<'a> {
    pub hook: Hook,
    pub checkout_path: String,
    pub source_checkout_path: Option<String>,
    pub cwd_path: Option<String>,
    pub repo_settings_key: Option<String>,
    pub expected: Option<HookExpectation>,
    pub is_current: Option<&'a (dyn Fn() -> bool + Send + Sync)>,
}

impl<'a> HookCall<'a> {
    pub fn new(hook: Hook, checkout_path: impl Into<String>) -> Self {
        Self {
            hook,
            checkout_path: checkout_path.into(),
            source_checkout_path: None,
            cwd_path: None,
            repo_settings_key: None,
            expected: None,
            is_current: None,
        }
    }
}

/// `unixOnlyMessage`.
pub fn unix_only_message(operation: &str) -> String {
    format!("{operation} requires a Unix SSH host and is unavailable on Windows.")
}

const HOOK_ACCESS: &str = "Worktree hook access";

/// The hook runner of a connection (`createWorktreeHookRunner`).
#[derive(Clone, Default)]
pub struct HookRunner {
    /// Overrides the repository settings' `worktree_hooks_enabled`.
    pub hooks_enabled: Option<HooksEnabled>,
}

/// Reads a file on the host: None when it does not exist (a missing file
/// differs from an empty one).
async fn read_text_file_maybe(
    conn: &WorkspaceConnection,
    path: &str,
) -> Result<Option<String>, String> {
    if let Some(host) = conn.ssh_host() {
        let quoted = shell_quote(path);
        let command =
            format!("if [ -e {quoted} ] || [ -L {quoted} ]; then printf '1'; cat {quoted}; fi");
        let ran = conn
            .git
            .run(Invocation::ssh(host, &command, None), READ_TIMEOUT)
            .await
            .map_err(|error| error.0)?;
        if ran.code != 0 {
            let detail = match js_trim(&ran.stderr) {
                "" => js_trim(&ran.stdout),
                stderr => stderr,
            };
            return Err(format!("ssh exited {}: {detail}", ran.code));
        }
        let mut chars = ran.stdout.chars();
        return Ok(chars.next().map(|_| chars.as_str().to_owned()));
    }
    match tokio::fs::symlink_metadata(path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn parse_hooks(text: &str) -> Result<Vec<(Hook, String)>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let raw: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let Value::Object(raw) = raw else {
        return Err("configuration must be an object".into());
    };
    let mut config = Vec::new();
    if let Some(worktree) = raw.get("worktree") {
        let Value::Object(worktree) = worktree else {
            return Err("worktree must be an object".into());
        };
        for hook in HOOKS {
            let Some(value) = worktree.get(hook.name()) else {
                continue;
            };
            let Value::String(command) = value else {
                return Err(format!("worktree.{} must be a string", hook.name()));
            };
            config.push((hook, command.clone()));
        }
    }
    Ok(config)
}

fn shell_env_assignments(env: &[(&str, &str)]) -> String {
    env.iter()
        .map(|(key, value)| format!("{key}={}", shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn target_changed() -> WorkspaceError {
    WorkspaceError::new(TARGET_CHANGED)
}

impl HookRunner {
    fn refuse_windows(conn: &WorkspaceConnection) -> Result<(), WorkspaceError> {
        if conn.is_windows() {
            return Err(WorkspaceError::new(unix_only_message(HOOK_ACCESS)));
        }
        Ok(())
    }

    /// The repository's settings key of a workspace, on this connection.
    pub fn repo_settings_key(conn: &WorkspaceConnection, workspace: &Value) -> Option<String> {
        workspace_repo_settings_key(workspace, conn.ssh_host(), Some(&conn.id))
    }

    async fn enabled(&self, conn: &WorkspaceConnection, key: Option<&String>) -> bool {
        match &self.hooks_enabled {
            Some(enabled) => enabled(key.cloned()).await,
            None => conn
                .settings
                .read()
                .await
                .repo_worktree_hooks_enabled(key.map(String::as_str)),
        }
    }

    /// The first configuration found: `roamgate.json` before `paseo.json`,
    /// the checkout before its source. None when there is none.
    pub async fn read_worktree_hooks(
        &self,
        conn: &WorkspaceConnection,
        checkout_path: &str,
        source_checkout_path: Option<&str>,
    ) -> Result<Option<LoadedHooks>, ReadHooksError> {
        if conn.is_windows() {
            return Err(ReadHooksError::Host(unix_only_message(HOOK_ACCESS)));
        }
        for source in ["roamgate", "paseo"] {
            for base in unique_strings([Some(checkout_path), source_checkout_path]) {
                let path = format!("{}/{source}.json", base.trim_end_matches('/'));
                let config_error = |cause: String| HookConfigError {
                    path: path.clone(),
                    source_name: source,
                    cause,
                };
                let text = read_text_file_maybe(conn, &path)
                    .await
                    .map_err(config_error)?;
                let Some(text) = text else {
                    continue;
                };
                let config = parse_hooks(&text).map_err(config_error)?;
                return Ok(Some(LoadedHooks {
                    path,
                    source,
                    config,
                }));
            }
        }
        Ok(None)
    }

    /// Runs a hook inside the target checkout and keeps its output.
    pub async fn run_worktree_hook(
        &self,
        conn: &WorkspaceConnection,
        call: HookCall<'_>,
    ) -> Result<HookRun, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let event = call.hook.event();
        let assert_current = || match call.is_current {
            Some(current) if !current() => Err(target_changed()),
            _ => Ok(()),
        };
        assert_current()?;
        if call.checkout_path.is_empty() {
            return Ok(HookRun::skipped(event));
        }
        let key = call.repo_settings_key.as_ref();
        let enabled = self.enabled(conn, key).await;
        assert_current()?;
        if let Some(expected) = &call.expected
            && enabled != expected.enabled
        {
            return Ok(HookRun::skipped_because(event, "hooks_enabled_changed"));
        }
        if !enabled && call.expected.is_none() {
            return Ok(HookRun::skipped(event));
        }
        let loaded = match self
            .read_worktree_hooks(
                conn,
                &call.checkout_path,
                call.source_checkout_path.as_deref(),
            )
            .await
        {
            Ok(loaded) => loaded,
            Err(_) if call.expected.is_some() => {
                return Ok(HookRun::skipped_because(event, "setup_hook_changed"));
            }
            Err(error) => {
                return Ok(HookRun {
                    error: Some(error.to_string()),
                    status: "failed",
                    ..HookRun::skipped(event)
                });
            }
        };
        assert_current()?;
        let command = loaded
            .as_ref()
            .and_then(|loaded| loaded.command(call.hook))
            .map(str::to_owned);
        if let Some(expected) = &call.expected
            && command != expected.command
        {
            return Ok(HookRun::skipped_because(event, "setup_hook_changed"));
        }
        let (Some(loaded), Some(command)) = (loaded, command) else {
            return Ok(HookRun::skipped(event));
        };
        if !enabled || js_trim(&command).is_empty() {
            return Ok(HookRun::skipped(event));
        }
        if let Some(expected) = &call.expected
            && self.enabled(conn, key).await != expected.enabled
        {
            return Ok(HookRun::skipped_because(event, "hooks_enabled_changed"));
        }
        assert_current()?;

        let source = call.source_checkout_path.as_deref().unwrap_or("");
        let checkout = call.checkout_path.as_str();
        let env = shell_env_assignments(&[
            ("PASEO_HOOK", call.hook.name()),
            ("PASEO_CHECKOUT_PATH", checkout),
            ("PASEO_SOURCE_CHECKOUT_PATH", source),
            ("ROAMGATE_HOOK_EVENT", event),
            ("ROAMGATE_HOOK_CHECKOUT_PATH", checkout),
            ("ROAMGATE_HOOK_SOURCE_CHECKOUT_PATH", source),
            ("HERDR_GUI_HOOK_EVENT", event),
            ("HERDR_GUI_HOOK_CHECKOUT_PATH", checkout),
            ("HERDR_GUI_HOOK_SOURCE_CHECKOUT_PATH", source),
        ]);
        let cwd = call.cwd_path.as_deref().unwrap_or(checkout);
        let script = format!(
            "cd {} && {env} sh -c {}",
            shell_quote(cwd),
            shell_quote(js_trim(&command))
        );
        let invocation = match conn.ssh_host() {
            Some(host) => Invocation::ssh(host, &script, None),
            None => Invocation::local(["sh", "-c", script.as_str()]),
        };
        let ran = conn
            .git
            .run(invocation, HOOK_TIMEOUT)
            .await
            .map_err(|error| WorkspaceError::new(error.0))?;
        let mut prefix = vec![
            format!("worktree {} hook", call.hook.name()),
            format!("config: {}", loaded.path),
            format!("checkout: {checkout}"),
        ];
        if cwd != checkout {
            prefix.push(format!("cwd: {cwd}"));
        }
        if !source.is_empty() {
            prefix.push(format!("source: {source}"));
        }
        let prefix = prefix.join("\n");
        let output = js_trim(&ran.stdout);
        let stdout = if output.is_empty() {
            prefix
        } else {
            format!("{prefix}\n{output}")
        };
        Ok(HookRun {
            event,
            status: if ran.code == 0 { "succeeded" } else { "failed" },
            reason: None,
            exit_code: Some(ran.code),
            stdout: Some(stdout),
            stderr: Some(ran.stderr),
            error: None,
        })
    }

    /// The checkout a removal's hooks are about: None unless the workspace
    /// is a linked worktree.
    pub async fn worktree_remove_hook_context(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
    ) -> Result<Option<RemoveHookContext>, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let workspace_id = id_param(params, "workspace_id");
        if workspace_id.is_empty() {
            return Ok(None);
        }
        let result = conn
            .herdr_call(
                "workspace.get",
                json!({ "workspace_id": workspace_id }),
                None,
            )
            .await
            .map_err(WorkspaceError::new)?;
        let workspace = result.get("workspace").cloned().unwrap_or(Value::Null);
        if workspace
            .pointer("/worktree/is_linked_worktree")
            .is_none_or(|linked| !js_truthy(linked))
        {
            return Ok(None);
        }
        Ok(Some(RemoveHookContext {
            checkout_path: checkout_path(&workspace),
            source_checkout_path: source_checkout_path(&workspace),
            repo_settings_key: Self::repo_settings_key(conn, &workspace),
        }))
    }

    /// The `removed` hook, from the source checkout (the checkout is gone).
    pub async fn run_worktree_removed_hook(
        &self,
        conn: &WorkspaceConnection,
        context: Option<&RemoveHookContext>,
    ) -> Result<HookRun, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let Some(context) = context else {
            return Ok(HookRun::skipped(Hook::Removed.event()));
        };
        self.run_worktree_hook(
            conn,
            HookCall {
                source_checkout_path: Some(context.source_checkout_path.clone()),
                cwd_path: Some(context.source_checkout_path.clone()),
                repo_settings_key: context.repo_settings_key.clone(),
                ..HookCall::new(Hook::Removed, context.checkout_path.clone())
            },
        )
        .await
    }

    /// The `opened` hook of a worktree Herdr opened.
    pub async fn run_worktree_opened_hook(
        &self,
        conn: &WorkspaceConnection,
        result: &Value,
        source_workspace: Option<&Value>,
    ) -> Result<HookRun, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let workspace = match result.get("workspace").filter(|value| js_truthy(value)) {
            Some(workspace) => Some(workspace.clone()),
            None => self.resolve_created_worktree_workspace(conn, result).await,
        };
        let Some(workspace) = workspace.filter(is_linked_truthy) else {
            return Ok(HookRun::skipped(Hook::Opened.event()));
        };
        let from_source = source_workspace.map(checkout_path).unwrap_or_default();
        let source = if from_source.is_empty() {
            source_checkout_path(&workspace)
        } else {
            from_source
        };
        self.run_worktree_hook(
            conn,
            HookCall {
                source_checkout_path: Some(source),
                repo_settings_key: Self::repo_settings_key(conn, &workspace),
                ..HookCall::new(Hook::Opened, checkout_path(&workspace))
            },
        )
        .await
    }

    /// The source workspace, read before Herdr moves focus while creating.
    pub async fn source_workspace_for_worktree_create(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
    ) -> Result<Option<Value>, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let workspace_id = id_param(params, "workspace_id");
        if workspace_id.is_empty() {
            return Ok(None);
        }
        Ok(conn
            .herdr_call(
                "workspace.get",
                json!({ "workspace_id": workspace_id }),
                None,
            )
            .await
            .ok()
            .and_then(|result| result.get("workspace").cloned())
            .filter(js_truthy))
    }

    /// The workspace Herdr made, from its create (or open) answer.
    pub async fn resolve_created_worktree_workspace(
        &self,
        conn: &WorkspaceConnection,
        result: &Value,
    ) -> Option<Value> {
        if let Some(workspace) = result.get("workspace").filter(|value| js_truthy(value)) {
            return Some(workspace.clone());
        }
        let workspace_id = result
            .get("workspace_id")
            .filter(|value| js_truthy(value))
            .or_else(|| {
                result
                    .pointer("/worktree/workspace_id")
                    .filter(|value| js_truthy(value))
            })
            .cloned();
        if let Some(workspace_id) = workspace_id
            && let Ok(found) = conn
                .herdr_call(
                    "workspace.get",
                    json!({ "workspace_id": workspace_id }),
                    None,
                )
                .await
            && let Some(workspace) = found.get("workspace").filter(|value| js_truthy(value))
        {
            return Some(workspace.clone());
        }
        let path = field(result, "/worktree/checkout_path")
            .or_else(|| field(result, "/worktree/path"))
            .or_else(|| field(result, "/checkout_path"))
            .or_else(|| field(result, "/path"))?;
        let list = conn
            .herdr_call("workspace.list", json!({}), None)
            .await
            .ok()?;
        list.get("workspaces")?
            .as_array()?
            .iter()
            .find(|workspace| checkout_path(workspace) == path)
            .cloned()
    }

    /// The setup hook, once Herdr created and opened the worktree.
    pub async fn run_worktree_setup_hook(
        &self,
        conn: &WorkspaceConnection,
        result: &Value,
        source_workspace: Option<&Value>,
        expected: Option<HookExpectation>,
        is_current: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> Result<HookRun, WorkspaceError> {
        Self::refuse_windows(conn)?;
        let workspace = self.resolve_created_worktree_workspace(conn, result).await;
        if let Some(current) = is_current
            && !current()
        {
            return Err(target_changed());
        }
        let Some(workspace) = workspace.filter(is_linked_truthy) else {
            return Ok(HookRun::skipped(Hook::Setup.event()));
        };
        let source = match source_workspace {
            Some(source) => checkout_path(source),
            None => source_checkout_path(&workspace),
        };
        self.run_worktree_hook(
            conn,
            HookCall {
                source_checkout_path: Some(source),
                repo_settings_key: Self::repo_settings_key(conn, &workspace),
                expected,
                is_current,
                ..HookCall::new(Hook::Setup, checkout_path(&workspace))
            },
        )
        .await
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn is_linked_truthy(workspace: &Value) -> bool {
    workspace
        .pointer("/worktree/is_linked_worktree")
        .is_some_and(js_truthy)
        || is_linked_worktree(workspace)
}

#[cfg(test)]
mod tests;
