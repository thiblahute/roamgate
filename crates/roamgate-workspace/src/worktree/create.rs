//! Worktree creation (worktree/create.ts), shared by the workspace UI and
//! Ranger's confirmed operations: origin's default branch refreshed, the
//! repository's settings found, the configured command (or Herdr's own
//! worktree) run, the parent recorded and the setup hook run, each step
//! dropped once the request's target changed.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use regex::Regex;
use roamgate_base::settings::{Settings, js_trim, repo_settings_key, workspace_repo_settings_key};
use roamgate_git::default_branch::fetch_origin_default_branch;
use roamgate_git::exec::{RunFuture, Runner, SharedRunner};
use roamgate_git::{
    GIT_DIFF_TIMEOUT, GIT_PULL_TIMEOUT, GitContext, Invocation, Ran, Request, RunError, shell_quote,
};
use serde_json::{Map, Value, json};

use crate::connection::{SettingsAccess, WorkspaceError};
use crate::worktree::Guard;
use crate::worktree::command_template::{
    WorktreeCommandValues, missing_worktree_command, validate_worktree_branch_name,
    worktree_command_script, worktree_shell_invocation,
};
use crate::worktree::hooks::{HookExpectation, HookRun, TARGET_CHANGED, unix_only_message};
use crate::worktree::remove::last_chars;

/// A worktree command may check out a large tree and its nested
/// repositories.
pub const WORKTREE_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

/// What the refresh of origin's default branch gave (`base_sync`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncedBase {
    pub workspace_id: String,
    pub root: String,
    pub base: String,
    pub commit: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
}

impl SyncedBase {
    pub fn to_value(&self) -> Value {
        json!({
            "workspace_id": self.workspace_id,
            "root": self.root,
            "base": self.base,
            "commit": self.commit,
            "command": self.command,
            "stdout": self.stdout,
            "stderr": self.stderr,
        })
    }
}

/// Finds the checkout of a workspace (`resolveGitRoot`).
pub type GitRootResolver<'a, 'r> =
    &'a (dyn Fn(String) -> BoxFuture<'r, Result<String, WorkspaceError>> + Send + Sync + 'a);

fn git_line(root: &str, args: &str) -> String {
    format!("GIT_TERMINAL_PROMPT=0 git -C {} {args}", shell_quote(root))
}

fn git_invocation(host: Option<&str>, command: &str) -> Invocation {
    match host {
        Some(host) => Invocation::ssh(host, command, None),
        None => Invocation::local(["sh", "-lc", command]),
    }
}

/// Refreshes origin's default branch without changing the source
/// checkout; a repository without origin gives its checked out commit.
pub async fn sync_worktree_base(
    workspace_id: &str,
    resolve_git_root: GitRootResolver<'_, '_>,
    cx: &GitContext,
) -> Result<SyncedBase, WorkspaceError> {
    let root = resolve_git_root(workspace_id.to_owned()).await?;
    let run_git = |args: String| -> BoxFuture<'_, Result<Ran, RunError>> {
        let invocation = git_invocation(cx.host(), &git_line(&root, &args));
        Box::pin(async move { cx.run(invocation, GIT_PULL_TIMEOUT).await })
    };
    match fetch_origin_default_branch(&run_git).await {
        Ok(fetched) => Ok(SyncedBase {
            workspace_id: workspace_id.to_owned(),
            root: root.clone(),
            base: fetched.base,
            commit: fetched.commit,
            command: fetched.command,
            stdout: fetched.stdout,
            stderr: fetched.stderr,
        }),
        Err(error) => {
            // Without an origin there is nothing to refresh: the commit
            // checked out is the base. Git quotes the remote's name in
            // every language it speaks.
            if !error.to_string().contains("'origin'") {
                return Err(error.into());
            }
            let probe = async {
                let url = run_git("remote get-url origin".into()).await.ok()?;
                if url.code == 0 {
                    return None;
                }
                let head = run_git("rev-parse --verify 'HEAD^{commit}'".into())
                    .await
                    .ok()?;
                (head.code == 0).then(|| js_trim(&head.stdout).to_owned())
            };
            let Some(commit) = probe.await else {
                return Err(error.into());
            };
            Ok(SyncedBase {
                workspace_id: workspace_id.to_owned(),
                root: root.clone(),
                base: "HEAD".into(),
                commit,
                command: String::new(),
                stdout: String::new(),
                stderr: String::new(),
            })
        }
    }
}

static UNSAFE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").unwrap());
static NAME_ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-.]+|-+$").unwrap());
static NOT_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9]+").unwrap());
static DASH_ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-+|-+$").unwrap());

/// The checkout path of `branch` inside the repository's directory.
pub fn worktree_checkout_path(directory: &str, branch: &str) -> Result<String, String> {
    let name = UNSAFE_NAME.replace_all(js_trim(branch), "-");
    let name = NAME_ENDS.replace_all(&name, "");
    if name.is_empty() {
        return Err("Worktree branch name is empty.".into());
    }
    Ok(format!("{}/{name}", directory.trim_end_matches('/')))
}

/// Herdr's `worktree.create` default, `~/.herdr/worktrees/<repo>/<slug>`.
pub fn herdr_default_checkout_path(repo_name: &str, branch: &str) -> String {
    let slug = NOT_ALNUM.replace_all(branch, "-").to_lowercase();
    let slug = DASH_ENDS.replace_all(&slug, "");
    let slug = if slug.is_empty() { "worktree" } else { &slug };
    format!("~/.herdr/worktrees/{repo_name}/{slug}")
}

/// Herdr's repo_name for a git common directory: `roamgate` for
/// `roamgate/.git`.
pub fn repo_name_from_common_dir(common_dir: &str) -> String {
    let parts: Vec<&str> = common_dir.split('/').filter(|p| !p.is_empty()).collect();
    match parts.last() {
        Some(&".git") => parts
            .len()
            .checked_sub(2)
            .map(|at| parts[at].to_owned())
            .unwrap_or_default(),
        Some(last) => (*last).to_owned(),
        None => String::new(),
    }
}

/// The repository a checkout belongs to, as Herdr names it: its absolute
/// git common directory. None when git cannot tell.
pub async fn git_common_dir(root: &str, cx: &GitContext) -> Option<String> {
    let command = git_line(root, "rev-parse --path-format=absolute --git-common-dir");
    let ran = cx
        .run(git_invocation(cx.host(), &command), GIT_DIFF_TIMEOUT)
        .await
        .ok()?;
    let dir = if ran.code == 0 {
        js_trim(&ran.stdout)
    } else {
        ""
    };
    dir.starts_with('/')
        .then(|| dir.trim_end_matches('/').to_owned())
}

/// The settings key of the repository a workspace belongs to, shared by
/// creation and the settings dialogs; git names it from `root` when Herdr
/// does not, and a key saved under the checkout path before still applies.
pub async fn resolve_repo_settings_key(
    workspace: Option<&Value>,
    root: Option<&str>,
    connection_id: Option<&str>,
    settings: &Settings,
    cx: &GitContext,
) -> (Option<String>, Option<String>) {
    let host = cx.host();
    let fallback = workspace.and_then(|w| workspace_repo_settings_key(w, host, connection_id));
    if workspace
        .and_then(|w| w.pointer("/worktree/repo_key"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty())
    {
        return (fallback, None);
    }
    let common_dir = match root.filter(|root| !root.is_empty()) {
        Some(root) => git_common_dir(root, cx).await,
        None => None,
    };
    let common_key = common_dir
        .as_deref()
        .map(|dir| repo_settings_key(dir, host, connection_id));
    let has = |key: &str| {
        settings
            .get("repositories")
            .and_then(|repos| repos.get(key))
            .is_some()
    };
    let key = match common_key {
        Some(common)
            if has(&common) || fallback.is_none() || !fallback.as_deref().is_some_and(has) =>
        {
            Some(common)
        }
        _ => fallback,
    };
    (key, common_dir)
}

/// The first of `base`, `base-<suffix>`, `base-<suffix>-2`... that is
/// nothing yet on the host: no file there and no worktree of the
/// repository registered at it. Absolute, `~` resolved on the host.
pub async fn free_worktree_path(
    base: &str,
    suffix: &str,
    repo: &str,
    cx: &GitContext,
) -> Result<String, String> {
    let trimmed = base.trim_end_matches('/');
    let mut candidates = vec![trimmed.to_owned(), format!("{trimmed}-{suffix}")];
    candidates.extend((2..10).map(|at| format!("{trimmed}-{suffix}-{at}")));
    let quoted: Vec<String> = candidates.iter().map(|c| shell_quote(c)).collect();
    let script = [
        format!(
            "listed=$(git -C {} worktree list --porcelain 2>/dev/null | sed -n \"s/^worktree //p\")",
            shell_quote(repo)
        ),
        format!("for p in {}; do", quoted.join(" ")),
        r#"  case "$p" in "~/"*) p="$HOME/${p#"~/"}" ;; esac"#.to_owned(),
        r#"  [ -e "$p" ] || [ -L "$p" ] && continue"#.to_owned(),
        r#"  printf "%s\n" "$listed" | grep -qxF -- "$p" && continue"#.to_owned(),
        r#"  printf "%s\n" "$p"; exit 0"#.to_owned(),
        "done".to_owned(),
        "exit 3".to_owned(),
    ]
    .join("\n");
    let ran = cx
        .run(
            worktree_shell_invocation(cx.host(), &script),
            GIT_DIFF_TIMEOUT,
        )
        .await
        .map_err(|error| error.0)?;
    let path = if ran.code == 0 {
        js_trim(&ran.stdout).split('\n').next_back().unwrap_or("")
    } else {
        ""
    };
    // A POSIX path, or a drive path on a Windows machine (Git Bash).
    if !roamgate_git::review::is_host_path(path) {
        let stderr = js_trim(&ran.stderr);
        return Err(if ran.code == 3 {
            format!(
                "{trimmed} and its {suffix} variants are all taken: remove one or name another branch"
            )
        } else if stderr.is_empty() {
            format!("cannot tell whether {trimmed} is free")
        } else {
            format!("cannot tell whether {trimmed} is free: {stderr}")
        });
    }
    Ok(path.to_owned())
}

/// What creation needs of its connection (the runtime TS was handed).
pub trait CreateRuntime: Send + Sync {
    fn is_windows(&self) -> bool;
    fn connection_id(&self) -> Option<&str>;
    /// Where its commands run.
    fn git(&self) -> &GitContext;
    fn settings(&self) -> &dyn SettingsAccess;
    /// The checkout of a workspace (files' `resolveWorkspaceGitRoot`).
    fn resolve_git_root(
        &self,
        workspace_id: String,
    ) -> BoxFuture<'_, Result<String, WorkspaceError>>;
    fn herdr(&self, method: &str, params: Value) -> BoxFuture<'_, Result<Value, String>>;
    fn source_workspace<'a>(
        &'a self,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<Option<Value>, WorkspaceError>>;
    fn remember_parent<'a>(
        &'a self,
        result: &'a Value,
        parent: &'a str,
        is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<(), String>>;
    fn run_setup_hook<'a>(
        &'a self,
        result: &'a Value,
        source: Value,
        expected: Option<HookExpectation>,
        is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<HookRun, WorkspaceError>>;
}

/// The refresh of the base, replaceable by the tests.
pub type SyncBase = Arc<
    dyn for<'a> Fn(
            &'a str,
            GitRootResolver<'a, 'a>,
            &'a GitContext,
        ) -> BoxFuture<'a, Result<SyncedBase, WorkspaceError>>
        + Send
        + Sync,
>;

/// Told why a created worktree's parent could not be recorded.
pub type ParentWarning = Box<dyn Fn(&str) + Send + Sync>;

/// Creation's options.
#[derive(Default)]
pub struct CreateOptions {
    /// Never a path that exists: the first free one with this suffix.
    pub fresh_path: Option<String>,
    /// Told why the parent could not be recorded.
    pub parent_warning: Option<ParentWarning>,
    /// Runs just before anything reaches the host or Herdr; its error
    /// (the action no longer allowed) stops the creation there.
    pub before_dispatch: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    pub sync_base: Option<SyncBase>,
}

/// Runs each command after `before`, then checks `after`.
struct GuardedRunner {
    inner: SharedRunner,
    before: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    after: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
}

impl Runner for GuardedRunner {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            (self.before)().map_err(RunError)?;
            let ran = self.inner.run(request).await?;
            (self.after)().map_err(RunError)?;
            Ok(ran)
        })
    }
}

fn has(params: &Value, key: &str) -> bool {
    params.get(key).is_some()
}

fn changed(message: &str) -> WorkspaceError {
    WorkspaceError::new(message)
}

fn truthy_text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Creates a worktree of the workspace `params.workspace_id` (or of the
/// main checkout `params.cwd`).
pub async fn create_workspace_worktree(
    runtime: &dyn CreateRuntime,
    params: &Value,
    is_current: &Guard,
    options: &CreateOptions,
) -> Result<Value, WorkspaceError> {
    let assert_current = || {
        if is_current() {
            Ok(())
        } else {
            Err(changed(TARGET_CHANGED))
        }
    };
    let before_send = || {
        assert_current()?;
        if let Some(before) = &options.before_dispatch {
            before().map_err(WorkspaceError::new)?;
        }
        Ok::<(), WorkspaceError>(())
    };
    assert_current()?;
    if runtime.is_windows() {
        return Err(WorkspaceError::new(unix_only_message("Worktree creation")));
    }
    if let Some(branch) = params.get("branch") {
        let Value::String(branch) = branch else {
            return Err(WorkspaceError::new(
                "worktree.create branch must be a string",
            ));
        };
        validate_worktree_branch_name(branch).map_err(WorkspaceError::new)?;
    }
    let mut create_params = params.as_object().cloned().unwrap_or_default();
    let expected_command = create_params.remove("expected_setup_hook");
    let expected_enabled = create_params.remove("expected_hooks_enabled");
    let expected_root = create_params.remove("expected_source_root");
    let expected_worktree_command = create_params.remove("expected_worktree_command");
    let guarded_command = has(params, "expected_worktree_command");
    if guarded_command
        && !matches!(
            expected_worktree_command,
            Some(Value::String(_)) | Some(Value::Null)
        )
    {
        return Err(WorkspaceError::new(
            "Confirmed worktree command is invalid.",
        ));
    }
    let expected_root = match expected_root {
        None => None,
        Some(Value::String(root)) if !js_trim(&root).is_empty() => Some(root),
        Some(_) => {
            return Err(WorkspaceError::new(
                "Confirmed source repository is invalid.",
            ));
        }
    };
    let expected = if has(params, "expected_setup_hook") || has(params, "expected_hooks_enabled") {
        match (expected_command, expected_enabled) {
            (Some(Value::String(command)), Some(Value::Bool(enabled))) => Some(HookExpectation {
                command: Some(command),
                enabled,
            }),
            (Some(Value::Null), Some(Value::Bool(enabled))) => Some(HookExpectation {
                command: None,
                enabled,
            }),
            _ => {
                return Err(WorkspaceError::new(
                    "Confirmed setup hook configuration is invalid.",
                ));
            }
        }
    } else {
        None
    };
    let create_params = Value::Object(create_params);
    let source_workspace = runtime.source_workspace(&create_params).await?;
    assert_current()?;
    let workspace_id = match create_params.get("workspace_id") {
        None | Some(Value::Null) => String::new(),
        Some(value) => crate::worktree::js_string(value),
    };
    let source_cwd = match create_params.get("cwd") {
        Some(Value::String(cwd)) if workspace_id.is_empty() => js_trim(cwd).to_owned(),
        _ => String::new(),
    };
    let resolve_git_root = |id: String| -> BoxFuture<'_, Result<String, WorkspaceError>> {
        let (source_cwd, expected_root) = (&source_cwd, &expected_root);
        Box::pin(async move {
            assert_current()?;
            if id.is_empty() && source_cwd.is_empty() {
                return Err(WorkspaceError::new(
                    "worktree.create requires workspace_id or cwd",
                ));
            }
            let root = if id.is_empty() {
                source_cwd.clone()
            } else {
                runtime.resolve_git_root(id).await?
            };
            assert_current()?;
            if let Some(expected) = expected_root
                && &root != expected
            {
                return Err(changed("The worktree source repository changed."));
            }
            Ok(root)
        })
    };
    let cx = runtime.git();
    let (guard_before, guard_after) = (is_current.clone(), is_current.clone());
    let dispatch = options.before_dispatch.clone();
    let guarded = GitContext::new(
        cx.host().map(str::to_owned),
        Arc::new(GuardedRunner {
            inner: cx.runner.clone(),
            before: Arc::new(move || {
                if !guard_before() {
                    return Err(TARGET_CHANGED.into());
                }
                if let Some(dispatch) = &dispatch {
                    dispatch()?;
                }
                Ok(())
            }),
            after: Arc::new(move || {
                if guard_after() {
                    Ok(())
                } else {
                    Err(TARGET_CHANGED.into())
                }
            }),
        }),
    );
    let base_sync = match &options.sync_base {
        Some(sync) => sync(&workspace_id, &resolve_git_root, &guarded).await,
        None => sync_worktree_base(&workspace_id, &resolve_git_root, &guarded).await,
    };
    let base_sync = base_sync?;
    assert_current()?;
    let mut rpc_params = create_params.as_object().cloned().unwrap_or_default();
    rpc_params.insert("base".into(), base_sync.commit.clone().into());
    let settings = runtime.settings().read().await;
    assert_current()?;
    let (key, common_dir) = resolve_repo_settings_key(
        source_workspace.as_ref(),
        Some(&base_sync.root),
        runtime.connection_id(),
        &settings,
        cx,
    )
    .await;
    assert_current()?;
    let command = settings.worktree_command_for(key.as_deref());
    if guarded_command
        && command.as_deref().map(Value::from).unwrap_or(Value::Null)
            != expected_worktree_command.unwrap_or(Value::Null)
    {
        return Err(changed("The worktree command changed."));
    }
    let branch = rpc_params
        .get("branch")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if rpc_params
        .get("path")
        .is_none_or(|path| !crate::worktree::hooks::js_truthy(path))
        && let Some(branch) = &branch
        && let Some(directory) = settings.repo_worktree_directory(key.as_deref())
    {
        rpc_params.insert(
            "path".into(),
            worktree_checkout_path(&directory, branch)
                .map_err(WorkspaceError::new)?
                .into(),
        );
    }
    let repo_name = truthy_text(
        source_workspace
            .as_ref()
            .and_then(|w| w.pointer("/worktree/repo_name")),
    )
    .map(str::to_owned)
    .or_else(|| {
        common_dir
            .as_deref()
            .map(repo_name_from_common_dir)
            .filter(|name| !name.is_empty())
    })
    .or_else(|| {
        base_sync
            .root
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    })
    .unwrap_or_default();
    if let (Some(suffix), Some(branch)) = (&options.fresh_path, &branch) {
        before_send()?;
        let base = match truthy_text(rpc_params.get("path")) {
            Some(path) => path.to_owned(),
            None => herdr_default_checkout_path(&repo_name, branch),
        };
        let free = free_worktree_path(&base, suffix, &base_sync.root, cx)
            .await
            .map_err(WorkspaceError::new)?;
        rpc_params.insert("path".into(), free.into());
        assert_current()?;
    }
    if let Some(expected) = &expected_root {
        if &base_sync.root != expected {
            return Err(changed("The worktree source repository changed."));
        }
        resolve_git_root(workspace_id.clone()).await?;
        rpc_params.remove("workspace_id");
        rpc_params.insert("cwd".into(), expected.clone().into());
    }
    assert_current()?;
    // A command missing on this host falls back to Herdr's own worktree,
    // and the reply says so.
    let mut command_fallback = None;
    if let Some(command) = &command {
        before_send()?;
        command_fallback = missing_worktree_command(command, cx)
            .await
            .map_err(WorkspaceError::new)?;
        assert_current()?;
        // The install probe may await SSH: a command changed or disabled
        // meanwhile is not dispatched.
        let latest = runtime
            .settings()
            .read()
            .await
            .worktree_command_for(key.as_deref());
        assert_current()?;
        if latest.as_deref() != Some(command.as_str()) {
            return Err(changed("The worktree command changed."));
        }
    }
    let rpc_params = Value::Object(rpc_params);
    let result = match (&command, &command_fallback) {
        (Some(command), None) => {
            run_worktree_command(
                runtime,
                command,
                &rpc_params,
                &base_sync,
                &repo_name,
                &before_send,
                &assert_current,
            )
            .await?
        }
        _ => {
            before_send()?;
            runtime
                .herdr("worktree.create", rpc_params.clone())
                .await
                .map_err(WorkspaceError::new)?
        }
    };
    assert_current()?;
    let mut parent_tracking_failed = false;
    if let Err(error) = runtime
        .remember_parent(&result, &workspace_id, is_current)
        .await
    {
        parent_tracking_failed = true;
        if let Some(warning) = &options.parent_warning {
            warning(&error);
        }
    }
    assert_current()?;
    let hook_source = match &source_workspace {
        Some(source) => {
            let cwd = truthy_text(source.pointer("/worktree/checkout_path"))
                .or_else(|| truthy_text(source.get("cwd")))
                .unwrap_or(&base_sync.root)
                .to_owned();
            let mut source = source.clone();
            if let Value::Object(map) = &mut source {
                map.insert("cwd".into(), cwd.into());
            }
            source
        }
        None => json!({ "cwd": base_sync.root }),
    };
    let setup_hook = runtime
        .run_setup_hook(&result, hook_source, expected, is_current)
        .await?;
    assert_current()?;
    let mut out: Map<String, Value> = result.as_object().cloned().unwrap_or_default();
    out.insert("base_sync".into(), base_sync.to_value());
    out.insert("setup_hook".into(), setup_hook.to_value());
    if parent_tracking_failed {
        out.insert("parent_tracking_failed".into(), true.into());
    }
    if let Some(fallback) = command_fallback {
        out.insert(
            "command_fallback".into(),
            format!("{fallback} Herdr created the worktree.").into(),
        );
    }
    Ok(Value::Object(out))
}

/// Creates the checkout with the configured command on the host, then
/// opens it in Herdr: an answer of the shape of Herdr's `worktree.create`.
async fn run_worktree_command(
    runtime: &dyn CreateRuntime,
    template: &str,
    rpc_params: &Value,
    base_sync: &SyncedBase,
    repo_name: &str,
    before_send: &(dyn Fn() -> Result<(), WorkspaceError> + Send + Sync),
    assert_current: &(dyn Fn() -> Result<(), WorkspaceError> + Send + Sync),
) -> Result<Value, WorkspaceError> {
    let branch = rpc_params
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or("");
    if js_trim(branch).is_empty() {
        return Err(WorkspaceError::new("worktree.create requires branch"));
    }
    let path = match rpc_params.get("path").and_then(Value::as_str).map(js_trim) {
        Some(path) if !path.is_empty() => path.to_owned(),
        _ => herdr_default_checkout_path(repo_name, branch),
    };
    if !path.starts_with('/') && !path.starts_with("~/") {
        return Err(WorkspaceError::new("Worktree path must be absolute."));
    }
    // The values reach the command as exported variables, never as text;
    // then the checkout's absolute path, `~` resolved on its host.
    let script = worktree_command_script(
        template,
        &WorktreeCommandValues {
            path: Some(path),
            branch: Some(branch.to_owned()),
            base: Some(base_sync.commit.clone()),
            repo: Some(base_sync.root.clone()),
            force: false,
        },
    )
    .map_err(WorkspaceError::new)?;
    let shell_command = format!(
        r#"{}; cd "$ROAMGATE_WORKTREE_REPO" && {} && cd "$ROAMGATE_WORKTREE_PATH" && printf '\n%s\n' "$PWD""#,
        script.exports, script.command
    );
    let cx = runtime.git();
    before_send()?;
    let ran = cx
        .run(
            worktree_shell_invocation(cx.host(), &shell_command),
            WORKTREE_COMMAND_TIMEOUT,
        )
        .await
        .map_err(|error| WorkspaceError::new(error.0))?;
    assert_current()?;
    if ran.code != 0 {
        let output = match js_trim(&ran.stderr) {
            "" => js_trim(&ran.stdout),
            stderr => stderr,
        };
        let output = last_chars(output, 2000);
        return Err(WorkspaceError::new(if output.is_empty() {
            format!("Worktree command failed (exit {}).", ran.code)
        } else {
            format!("Worktree command failed (exit {}): {output}", ran.code)
        }));
    }
    let created = js_trim(js_trim(&ran.stdout).split('\n').next_back().unwrap_or(""));
    if !created.starts_with('/') {
        return Err(WorkspaceError::new(
            "The worktree command left no checkout at its path.",
        ));
    }
    let mut open = Map::new();
    open.insert("path".into(), created.into());
    for name in ["workspace_id", "cwd", "focus", "label", "trust_repository"] {
        if let Some(value) = rpc_params.get(name) {
            open.insert(name.into(), value.clone());
        }
    }
    before_send()?;
    let mut opened = runtime
        .herdr("worktree.open", Value::Object(open))
        .await
        .map_err(WorkspaceError::new)?;
    // A checkout Herdr already had open was not created by this command:
    // its setup hook ran when it was created.
    if opened.get("already_open") == Some(&Value::Bool(true)) {
        return Err(WorkspaceError::new(format!(
            "The worktree command left {created}, which was already open in Herdr; the setup hook was not run again."
        )));
    }
    if let Value::Object(map) = &mut opened {
        map.remove("already_open");
    }
    Ok(opened)
}

#[cfg(test)]
mod tests;
