//! A connection generation's worktrees: the browser RPCs `worktree.create`,
//! `worktree.open` and `worktree.remove` (index.ts's flows around
//! create.ts, the hooks and remove.ts) and the worktree settings, with the
//! removal coordinator, the parent store and the hook runner they share.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use crate::connection::{
    HerdrCallOptions, RpcResult, SettingsAccess, WorkspaceConnection, WorkspaceError,
};
use crate::worktree::Guard;
use crate::worktree::create::{CreateOptions, CreateRuntime, create_workspace_worktree};
use crate::worktree::hooks::{Hook, HookCall, HookExpectation, HookRun, HookRunner};
use crate::worktree::parents::WorktreeParents;
use crate::worktree::paths::id_param;
use crate::worktree::remove::{
    CheckoutState, CommandRemoval, HostRemovalRuntime, Removal, RemovalCoordinator, RemovalRuntime,
    WORKTREE_REMOVE_TIMEOUT, log_cleanup_warning, remove_worktree_with_recovery,
    run_worktree_remove_command,
};
use crate::worktree::settings_rpc::settings_rpc;

/// The checkout of a workspace (files.ts's `resolveWorkspaceGitRoot`, the
/// files module's).
pub type ResolveGitRoot =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<String, WorkspaceError>> + Send + Sync>;

/// Places a workspace Herdr created under the one it came from in the
/// workspace tree (`placeCreatedWorkspaceUnder`): the created answer and
/// the source workspace id.
pub type PlaceCreated = Arc<
    dyn Fn(Value, Option<String>) -> BoxFuture<'static, Result<(), WorkspaceError>> + Send + Sync,
>;

/// What the worktree RPCs need of the rest of the workspace family.
#[derive(Clone)]
pub struct WorktreeCallbacks {
    pub resolve_git_root: ResolveGitRoot,
    /// None: created workspaces stay where Herdr put them.
    pub place_created: Option<PlaceCreated>,
}

/// The browser RPCs [`Worktrees::rpc`] answers.
pub const WORKTREE_METHODS: [&str; 3] = ["worktree.create", "worktree.open", "worktree.remove"];

/// A connection generation's worktrees.
#[derive(Clone, Default)]
pub struct Worktrees {
    pub hooks: HookRunner,
    pub parents: WorktreeParents,
    pub removals: RemovalCoordinator,
}

fn warn_unless_retired(is_current: &Guard, conn: &WorkspaceConnection, message: &str, error: &str) {
    if is_current() {
        tracing::warn!(scope = "bridge", connection = %conn.id, error, "{message}");
    }
}

/// Creation's view of a connection.
struct ConnectionCreate<'a> {
    conn: &'a WorkspaceConnection,
    worktrees: &'a Worktrees,
    callbacks: &'a WorktreeCallbacks,
}

impl CreateRuntime for ConnectionCreate<'_> {
    fn is_windows(&self) -> bool {
        self.conn.is_windows()
    }

    fn connection_id(&self) -> Option<&str> {
        Some(&self.conn.id)
    }

    fn git(&self) -> &roamgate_git::GitContext {
        &self.conn.git
    }

    fn settings(&self) -> &dyn SettingsAccess {
        &*self.conn.settings
    }

    fn resolve_git_root(
        &self,
        workspace_id: String,
    ) -> BoxFuture<'_, Result<String, WorkspaceError>> {
        (self.callbacks.resolve_git_root)(workspace_id)
    }

    fn herdr(&self, method: &str, params: Value) -> BoxFuture<'_, Result<Value, String>> {
        self.conn
            .herdr
            .call(method, params, HerdrCallOptions::default())
    }

    fn source_workspace<'a>(
        &'a self,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<Option<Value>, WorkspaceError>> {
        Box::pin(
            self.worktrees
                .hooks
                .source_workspace_for_worktree_create(self.conn, params),
        )
    }

    fn remember_parent<'a>(
        &'a self,
        result: &'a Value,
        parent: &'a str,
        is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(
            self.worktrees
                .parents
                .remember_worktree_parent(self.conn, result, parent, is_current),
        )
    }

    fn run_setup_hook<'a>(
        &'a self,
        result: &'a Value,
        source: Value,
        expected: Option<HookExpectation>,
        is_current: &'a Guard,
    ) -> BoxFuture<'a, Result<HookRun, WorkspaceError>> {
        Box::pin(async move {
            self.worktrees
                .hooks
                .run_worktree_setup_hook(
                    self.conn,
                    result,
                    Some(&source),
                    expected,
                    Some(&**is_current),
                )
                .await
        })
    }
}

fn merged(result: &Value, extra: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut out: Map<String, Value> = result.as_object().cloned().unwrap_or_default();
    for (key, value) in extra {
        out.insert(key.into(), value);
    }
    Value::Object(out)
}

impl Worktrees {
    /// Answers `worktree.*` and the worktree settings; None for another
    /// method. A request is current while `is_current` says so (its
    /// connection was not replaced).
    pub async fn rpc(
        &self,
        conn: &WorkspaceConnection,
        method: &str,
        params: &Value,
        is_current: &Guard,
        callbacks: &WorktreeCallbacks,
    ) -> Option<RpcResult> {
        match method {
            "worktree.create" => Some(self.create(conn, params, is_current, callbacks).await),
            "worktree.open" => Some(self.open(conn, params, is_current).await),
            "worktree.remove" => Some(self.remove(conn, params, is_current).await),
            _ => settings_rpc(conn, &self.hooks, method, params, is_current, callbacks).await,
        }
    }

    /// Herdr's `workspace.list` answer with the recorded parents.
    pub async fn enrich_workspace_list(&self, conn: &WorkspaceConnection, result: Value) -> Value {
        self.parents.enrich_workspace_list(conn, result).await
    }

    async fn create(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        is_current: &Guard,
        callbacks: &WorktreeCallbacks,
    ) -> RpcResult {
        self.create_dispatched(conn, params, is_current, callbacks, None)
            .await
    }

    /// `worktree.create` as Ranger's confirmed operation runs it:
    /// `before_dispatch` runs just before anything reaches the host or
    /// Herdr, and its error stops the creation.
    pub async fn create_dispatched(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        is_current: &Guard,
        callbacks: &WorktreeCallbacks,
        before_dispatch: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    ) -> RpcResult {
        let runtime = ConnectionCreate {
            conn,
            worktrees: self,
            callbacks,
        };
        let (guard, connection) = (is_current.clone(), conn.id.clone());
        let options = CreateOptions {
            parent_warning: Some(Box::new(move |error| {
                if guard() {
                    tracing::warn!(scope = "bridge", connection = %connection, error, "unable to persist worktree parent");
                }
            })),
            before_dispatch,
            ..CreateOptions::default()
        };
        let result = create_workspace_worktree(&runtime, params, is_current, &options).await?;
        if let Some(place) = &callbacks.place_created {
            let source = params
                .get("workspace_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            place(result.clone(), source).await?;
        }
        Ok(result)
    }

    async fn open(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        is_current: &Guard,
    ) -> RpcResult {
        let workspace_id = id_param(params, "workspace_id");
        let source = self
            .hooks
            .source_workspace_for_worktree_create(conn, params)
            .await?;
        let result = conn
            .herdr
            .call("worktree.open", params.clone(), HerdrCallOptions::default())
            .await
            .map_err(WorkspaceError::new)?;
        if let Err(error) = self
            .parents
            .remember_worktree_parent(conn, &result, &workspace_id, is_current)
            .await
        {
            warn_unless_retired(
                is_current,
                conn,
                "unable to persist opened worktree parent",
                &error,
            );
        }
        let opened = self
            .hooks
            .run_worktree_opened_hook(conn, &result, source.as_ref())
            .await?;
        Ok(merged(&result, [("opened_hook", opened.to_value())]))
    }

    async fn remove(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        is_current: &Guard,
    ) -> RpcResult {
        let workspace_id = id_param(params, "workspace_id");
        let (worktrees, conn_owned, params_owned, guard) = (
            self.clone(),
            conn.clone(),
            params.clone(),
            is_current.clone(),
        );
        let id = workspace_id.clone();
        self.removals
            .run(&workspace_id, move || async move {
                worktrees
                    .remove_now(&conn_owned, &params_owned, &guard, &id)
                    .await
                    .map_err(|error| error.message)
            })
            .await
            .map_err(WorkspaceError::new)
    }

    async fn remove_now(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        is_current: &Guard,
        workspace_id: &str,
    ) -> RpcResult {
        let context = self
            .hooks
            .worktree_remove_hook_context(conn, params)
            .await?;
        let runtime = HostRemovalRuntime {
            cx: conn.git.clone(),
        };
        let state = match &context {
            Some(context) => runtime
                .inspect_checkout(&context.checkout_path)
                .await
                .unwrap_or(CheckoutState::Unknown),
            None => CheckoutState::Unknown,
        };
        let before_remove = match &context {
            Some(context) if state != CheckoutState::Missing => {
                self.hooks
                    .run_worktree_hook(
                        conn,
                        HookCall {
                            source_checkout_path: Some(context.source_checkout_path.clone()),
                            repo_settings_key: context.repo_settings_key.clone(),
                            ..HookCall::new(Hook::Teardown, context.checkout_path.clone())
                        },
                    )
                    .await?
            }
            _ => HookRun::skipped(Hook::Teardown.event()),
        };
        if before_remove.status == "failed" {
            // The reply is an answer, logged as the request's error.
            let detail = before_remove
                .error
                .clone()
                .unwrap_or_else(|| "before-remove hook failed".into());
            tracing::warn!(scope = "bridge", connection = %conn.id, detail, "worktree before-remove hook failed");
            return Ok(json!({
                "ok": false,
                "skipped_remove": true,
                "before_remove_hook": before_remove.to_value(),
            }));
        }
        let remove_command = match &context {
            Some(context) => conn
                .settings
                .read()
                .await
                .worktree_remove_command_for(context.repo_settings_key.as_deref()),
            None => None,
        };
        let force = params.get("force") == Some(&Value::Bool(true));
        let call = |params: Value| -> BoxFuture<'_, Result<Value, String>> {
            conn.herdr.call(
                "worktree.remove",
                params,
                HerdrCallOptions::timeout(WORKTREE_REMOVE_TIMEOUT),
            )
        };
        // The command removes the checkout (git recworktree also its
        // nested ones); Herdr then only closes the workspace. Not
        // installed on this host: Herdr removes it.
        let with_command: Option<BoxFuture<'_, Result<CommandRemoval, String>>> =
            match (&remove_command, &context) {
                (Some(template), Some(context)) => Some(Box::pin(async move {
                    let fallback = run_worktree_remove_command(
                        template,
                        &context.checkout_path,
                        &context.source_checkout_path,
                        force,
                        &conn.git,
                    )
                    .await?;
                    if let Some(fallback) = fallback {
                        return Ok(CommandRemoval::Fallback(format!(
                            "{fallback} Herdr removed the worktree."
                        )));
                    }
                    conn.herdr_call(
                        "workspace.close",
                        json!({ "workspace_id": workspace_id }),
                        None,
                    )
                    .await?;
                    Ok(CommandRemoval::Removed(json!({
                        "forced": force,
                        "path": context.checkout_path,
                        "type": "worktree_removed",
                        "workspace_id": workspace_id,
                    })))
                })),
                _ => None,
            };
        let removal = remove_worktree_with_recovery(Removal {
            call: &call,
            params: params.clone(),
            checkout_path: context.as_ref().map(|c| c.checkout_path.clone()),
            runtime: &runtime,
            remove_with_command: with_command,
            log: &log_cleanup_warning,
        })
        .await
        .map_err(WorkspaceError::new)?;
        if let Some(path) = removal
            .cleanup
            .as_ref()
            .and_then(|cleanup| cleanup.preserved_path.as_deref())
        {
            tracing::warn!(scope = "bridge", connection = %conn.id, path, "preserved stale worktree files");
        }
        if let Some(context) = &context
            && !context.checkout_path.is_empty()
            && let Err(error) = self
                .parents
                .forget_worktree(conn, &context.checkout_path, is_current)
                .await
        {
            warn_unless_retired(is_current, conn, "unable to remove worktree parent", &error);
        }
        let removed = self
            .hooks
            .run_worktree_removed_hook(conn, context.as_ref())
            .await?;
        let mut extra = Vec::new();
        if let Some(cleanup) = &removal.cleanup {
            extra.push(("cleanup", cleanup.to_value()));
        }
        if let Some(fallback) = &removal.command_fallback {
            extra.push(("command_fallback", Value::from(fallback.clone())));
        }
        extra.push(("before_remove_hook", before_remove.to_value()));
        extra.push(("removed_hook", removed.to_value()));
        Ok(merged(&removal.result, extra))
    }
}

#[cfg(test)]
mod tests;
