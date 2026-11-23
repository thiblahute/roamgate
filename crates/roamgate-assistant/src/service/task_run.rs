//! A task run's view of the workspaces: the context a child service reads
//! through, which checks the run's fixed scope against the global grant
//! around every read and action (service.ts's `context` for `taskRun`).

use std::sync::Arc;

use roamgate_agents::js;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::util::{aborted, err};
use crate::context::{
    ActionResult, AssistantContext, Authorized, ContextOp, PreparedAction, Scope,
};
use crate::errors::AssistantResult;
use crate::saved::ref_key;
use crate::tools::{BoxFuture, ToolResult};

pub type GlobalAllowed = Arc<dyn Fn() -> Vec<Value> + Send + Sync>;
pub type GlobalWorkspaceAllowed = Arc<dyn Fn(&Value) -> bool + Send + Sync>;
pub type RefreshGlobalScope = Arc<dyn Fn() -> BoxFuture<AssistantResult<()>> + Send + Sync>;

/// What a task run checks its scope against (the task run and the parent's
/// global grant).
pub(crate) struct TaskGuard {
    pub task_run: Option<Value>,
    pub base: Arc<dyn AssistantContext>,
    pub global_allowed: Option<GlobalAllowed>,
    pub global_workspace_allowed: Option<GlobalWorkspaceAllowed>,
    pub refresh_global_scope: Option<RefreshGlobalScope>,
}

fn removed() -> crate::errors::AssistantError {
    err("The task workspace permission was removed.")
}

fn throw_if(signal: &Option<CancellationToken>) -> AssistantResult<()> {
    if signal.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Err(aborted());
    }
    Ok(())
}

impl TaskGuard {
    pub fn targets(&self) -> Vec<Value> {
        self.task_run
            .as_ref()
            .and_then(|run| run["targets"].as_array().cloned())
            .unwrap_or_default()
    }

    /// `globallyAllowed(ref)`.
    pub fn globally_allowed(&self, item: &Value) -> bool {
        if let Some(allowed) = &self.global_workspace_allowed {
            return allowed(item);
        }
        if let Some(allowed) = &self.global_allowed {
            let key = ref_key(item);
            return allowed().iter().any(|entry| ref_key(entry) == key);
        }
        false
    }

    /// `assertTaskAllowed()`.
    pub fn assert_task_allowed(&self) -> AssistantResult<()> {
        if self.task_run.is_some()
            && self
                .targets()
                .iter()
                .any(|target| !self.globally_allowed(target))
        {
            return Err(removed());
        }
        Ok(())
    }

    /// `checkTaskScope(signal)`.
    pub async fn check(&self, signal: Option<CancellationToken>) -> AssistantResult<()> {
        if self.task_run.is_none() {
            return Ok(());
        }
        if let Some(refresh) = &self.refresh_global_scope {
            refresh().await?;
        }
        throw_if(&signal)?;
        let targets = self.targets();
        if targets.iter().any(|target| !self.globally_allowed(target))
            || !self.base.provides(ContextOp::RestoreScope)
        {
            return Err(removed());
        }
        self.base
            .restore_scope(Value::Array(targets.clone()), signal.clone())
            .await?;
        throw_if(&signal)?;
        if targets.iter().any(|target| !self.globally_allowed(target)) {
            return Err(removed());
        }
        Ok(())
    }
}

/// The context of a task run.
pub(crate) struct TaskRunContext(pub Arc<TaskGuard>);

impl AssistantContext for TaskRunContext {
    fn provides(&self, op: ContextOp) -> bool {
        match op {
            ContextOp::RestoreScope => true,
            other => self.0.base.provides(other),
        }
    }

    fn catalog(&self) -> BoxFuture<AssistantResult<Value>> {
        self.0.base.catalog()
    }

    fn connection_state(&self, connection_id: &str) -> Option<Value> {
        self.0.base.connection_state(connection_id)
    }

    fn watch_connections(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        self.0.base.watch_connections(listener)
    }

    fn capture_scope(
        &self,
        refs: Value,
        cancel: Option<CancellationToken>,
        _recovery_targets: Option<Value>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let guard = self.0.clone();
        Box::pin(async move {
            let sorted = |items: &Value| {
                let mut keys: Vec<String> = items
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(ref_key)
                    .collect();
                keys.sort();
                js::stringify(&Value::from(keys))
            };
            let targets = Value::Array(guard.targets());
            if sorted(&refs) != sorted(&targets) {
                return Err(err("Invalid scheduled task scope"));
            }
            guard.check(cancel.clone()).await?;
            guard.base.restore_scope(targets, cancel).await
        })
    }

    fn extend_scope(
        &self,
        captured: &Scope,
        refs: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let guard = self.0.clone();
        let captured = captured.clone();
        Box::pin(async move {
            guard.check(cancel.clone()).await?;
            guard.base.extend_scope(&captured, refs, cancel).await
        })
    }

    fn recovery_scope(
        &self,
        captured: &Scope,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.0.base.recovery_scope(captured, cancel)
    }

    fn restore_scope(
        &self,
        targets: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let guard = self.0.clone();
        Box::pin(async move {
            let saved = Value::Array(guard.targets());
            if js::stringify(&targets) != js::stringify(&saved) {
                return Err(err("The scheduled task identity changed."));
            }
            guard.check(cancel.clone()).await?;
            guard.base.restore_scope(saved, cancel).await
        })
    }

    fn mention_catalog(
        &self,
        captured: &Scope,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.0.base.mention_catalog(captured, cancel)
    }

    fn bind_mentions(
        &self,
        captured: &Scope,
        targets: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.0.base.bind_mentions(captured, targets, cancel)
    }

    fn read(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<ToolResult>> {
        let guard = self.0.clone();
        let captured = captured.clone();
        let kind = kind.to_owned();
        Box::pin(async move {
            guard.check(cancel.clone()).await?;
            let result = guard
                .base
                .read(&kind, &captured, params, cancel.clone())
                .await?;
            guard.check(cancel).await?;
            Ok(result)
        })
    }

    fn prepare_action(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<PreparedAction>> {
        let guard = self.0.clone();
        let captured = captured.clone();
        let kind = kind.to_owned();
        Box::pin(async move {
            guard.check(cancel.clone()).await?;
            let prepared = guard
                .base
                .prepare_action(&kind, &captured, params, cancel.clone())
                .await?;
            guard.check(cancel).await?;
            let execute = prepared.execute;
            let checked = guard.clone();
            Ok(PreparedAction {
                preview: prepared.preview,
                execute: Box::new(move |authorized: Option<Authorized>| {
                    Box::pin(async move {
                        checked.check(None).await?;
                        let result: ActionResult = execute(authorized).await?;
                        checked.check(None).await?;
                        Ok(result)
                    }) as BoxFuture<AssistantResult<ActionResult>>
                }),
            })
        })
    }
}
