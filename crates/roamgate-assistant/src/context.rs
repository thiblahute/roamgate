//! Ranger's view of the workspaces (`assistant/context.ts`): the trait the
//! service reads through, and the scope a turn captured. The live context
//! (`context::live`) reads Herdr and the connections through a
//! [`live::ContextHost`], which the core's adapter answers with reverse
//! calls into what Bun still owns.

use std::any::Any;
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{BoxFuture, ToolResult};

pub mod actions;
#[cfg(test)]
mod fake;
pub mod live;
pub mod ported;

/// A turn's captured workspaces (`AssistantWorkspace[]`) with what the
/// context keeps of them out of model data (its leases and identities),
/// which the TS keeps in WeakMaps keyed by the array: here the scope is
/// the key, compared by [`Arc::ptr_eq`].
pub struct CapturedScope {
    /// The `AssistantWorkspace[]` the model and the snapshot see.
    pub workspaces: Value,
    /// The implementation's private part.
    pub private: Box<dyn Any + Send + Sync>,
}

pub type Scope = Arc<CapturedScope>;

impl CapturedScope {
    pub fn new(workspaces: Value, private: impl Any + Send + Sync) -> Scope {
        Arc::new(Self {
            workspaces,
            private: Box::new(private),
        })
    }

    /// A scope with no private part (tests, fakes).
    pub fn plain(workspaces: Value) -> Scope {
        Self::new(workspaces, ())
    }

    pub fn len(&self) -> usize {
        self.workspaces.as_array().map_or(0, Vec::len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The outcome of an action (`AssistantActionResult`):
/// `{status: succeeded|failed|uncertain, detail, created?}`.
pub type ActionResult = Value;

/// Whether the action may still run, checked right before it is sent
/// (`authorized?`).
pub type Authorized = Arc<dyn Fn() -> bool + Send + Sync>;

/// A prepared action (`PreparedAssistantAction`): what the user confirms,
/// and what runs it.
pub struct PreparedAction {
    /// `AssistantActionPreview`.
    pub preview: Value,
    pub execute:
        Box<dyn FnOnce(Option<Authorized>) -> BoxFuture<AssistantResult<ActionResult>> + Send>,
}

/// The optional members of `AssistantContext` (the TS type's `Partial`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextOp {
    ConnectionState,
    WatchConnections,
    ExtendScope,
    PrepareAction,
    RecoveryScope,
    RestoreScope,
    MentionCatalog,
    BindMentions,
}

fn absent<T: Send + 'static>(name: &str) -> BoxFuture<AssistantResult<T>> {
    let message = format!("{name} is not available");
    Box::pin(async move { Err(AssistantError::internal(message)) })
}

/// `AssistantContext`. Every value is the TS one as JSON.
pub trait AssistantContext: Send + Sync + 'static {
    /// Whether an optional member exists; every one does by default.
    fn provides(&self, _op: ContextOp) -> bool {
        true
    }

    /// `catalog()`: `AssistantWorkspaceCatalog`.
    fn catalog(&self) -> BoxFuture<AssistantResult<Value>>;

    /// `connectionState(id)`: `{label, state, error?}`, or None for one no
    /// longer configured.
    fn connection_state(&self, _connection_id: &str) -> Option<Value> {
        None
    }

    /// `watchConnections(listener)`: the unsubscribe.
    fn watch_connections(
        &self,
        _listener: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }

    /// `captureScope(refs, signal, recoveryTargets?)`.
    fn capture_scope(
        &self,
        refs: Value,
        cancel: Option<CancellationToken>,
        recovery_targets: Option<Value>,
    ) -> BoxFuture<AssistantResult<Scope>>;

    /// `extendScope(captured, refs, signal)`.
    fn extend_scope(
        &self,
        _captured: &Scope,
        _refs: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        absent("extendScope")
    }

    /// `recoveryScope(captured, signal)`: `RecoveryTarget[]`.
    fn recovery_scope(
        &self,
        _captured: &Scope,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        absent("recoveryScope")
    }

    /// `restoreScope(targets, signal)`.
    fn restore_scope(
        &self,
        _targets: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        absent("restoreScope")
    }

    /// `mentionCatalog(captured, signal)`: `AssistantMentionCatalog`.
    fn mention_catalog(
        &self,
        _captured: &Scope,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        absent("mentionCatalog")
    }

    /// `bindMentions(captured, targets, signal)`: the targets bound.
    fn bind_mentions(
        &self,
        _captured: &Scope,
        _targets: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        absent("bindMentions")
    }

    /// `read(kind, captured, params, signal)`.
    fn read(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<ToolResult>>;

    /// `prepareAction(kind, captured, params, signal)`.
    fn prepare_action(
        &self,
        _kind: &str,
        _captured: &Scope,
        _params: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<PreparedAction>> {
        absent("prepareAction")
    }
}
