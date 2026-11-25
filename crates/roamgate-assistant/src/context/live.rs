//! `createAssistantContext` (`assistant/context.ts`) on a [`ContextHost`]:
//! the workspaces a turn may read and act on, checked against the live
//! connections at every boundary, read through what Bun still owns.
//!
//! A lease (`RuntimeLease`) is data here, [`Lease`]: the connection, the
//! generation of its runtime and the runtime's fixed properties. Whether it
//! is still current is [`ContextHost::is_current`], asked as often as the
//! TS asks `lease.isCurrent()` (before and after every read), so it is the
//! one host query answered synchronously, from the connection table the
//! adapter keeps (Bun pushes each connection change); every other host
//! method is a reverse call.
//!
//! The TS keeps a turn's leases, workspace identities and mention guards in
//! WeakMaps keyed by the captured array; here they are the scope's private
//! part ([`ScopeState`]), which only the context that made it reads.

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::FutureExt;
use futures_util::future::{Shared, join_all};
use roamgate_agents::js;
use roamgate_base::clock::SharedClock;
use roamgate_base::paths::random_uuid;
use roamgate_base::settings::overlay_tab_ids_in;
use roamgate_connections::usage_limit::{LimitPause, limit_kind_label};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::actions::{self, ActionRequest, Prepared};
use super::ported::{assert_unix_host, sanitize_explorer_path, validate_connection_id};
use super::{AssistantContext, CapturedScope, PreparedAction, Scope};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{
    ASSISTANT_DEFAULT_TERMINAL_LINES, ASSISTANT_MAX_TERMINAL_LINES, BoxFuture, ToolResult,
};
use crate::wire::{ASSISTANT_MAX_MENTIONS, ASSISTANT_MAX_WORKSPACES, is_hex64, is_mention_target};

const MAX_SCOPE_READS: usize = 8;
const MAX_ITEMS: usize = 80;
const MAX_TEXT: usize = 32_000;
const INCOMPLETE_NOTICE: &str = "Some data was truncated. This is partial evidence; do not infer that omitted records do not exist.";
const NOT_APPROVED: &str = "Ranger workspace scope was not approved";
const SESSION_CHANGED: &str = "Mentioned agent session changed; select it again";

/// A connection's runtime a turn holds (`RuntimeLease`): what it was when
/// the context took it. `remote_platform` and `ssh_host` are the
/// runtime's `remotePlatform` and `sshHost()`, fixed for a runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub connection_id: String,
    pub generation: u64,
    /// `"windows"` for a Windows SSH host, else None.
    #[serde(default)]
    pub remote_platform: Option<String>,
    #[serde(default)]
    pub ssh_host: Option<String>,
}

/// `beforeSend` / `beforeDispatch`: the host calls it right before the
/// write leaves (after connecting); an error means nothing may be sent,
/// and the host gives that error (or its own) without sending.
pub type BeforeSend = Arc<dyn Fn() -> AssistantResult<()> + Send + Sync>;

/// `isCurrent` as worktree creation gets it: the lease, and the action's
/// live permission.
pub type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;

/// What the live context reads through: what Bun still owns. Every
/// argument and result is JSON (or a small serde struct) but the dispatch
/// gates ([`BeforeSend`], [`IsCurrent`]), which the host calls back at the
/// moment the TS calls them. Runtime reads take the [`Lease`] they are
/// made under; a host error's message is the runtime's (Herdr's
/// `code: message` included), which the context matches and masks.
pub trait ContextHost: Send + Sync + 'static {
    /// `args.catalog()`: the configured connections, `[{id, label}]`.
    fn catalog(&self) -> BoxFuture<AssistantResult<Vec<Value>>>;

    /// `args.lease(connectionId)`: the connection's ready runtime, or None.
    fn lease(&self, connection_id: &str) -> BoxFuture<AssistantResult<Option<Lease>>>;

    /// `lease.isCurrent()`: the connection still runs that generation.
    fn is_current(&self, lease: &Lease) -> bool;

    /// `args.recoveryFingerprint?.(connectionId)`: SHA-256 hex of the
    /// configured endpoint, None when the host has none.
    fn recovery_fingerprint(
        &self,
        connection_id: &str,
    ) -> BoxFuture<AssistantResult<Option<String>>>;

    /// `args.connectionStatus?.(connectionId)`: `{label, state, error?}`.
    fn connection_status(&self, _connection_id: &str) -> Option<Value> {
        None
    }

    /// `args.watchConnections?.(listener)`: the unsubscribe.
    fn watch_connections(
        &self,
        _listener: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }

    /// `args.limitPauses?.(connectionId)`: its sessions a usage limit
    /// paused.
    fn limit_pauses(&self, connection_id: &str) -> BoxFuture<AssistantResult<Vec<LimitPause>>>;

    /// Whether `args.createWorktree` exists.
    fn can_create_worktree(&self) -> bool;

    /// `args.createWorktree(runtime, params, isCurrent, beforeDispatch)`:
    /// the shared worktree flow, its result as JSON.
    fn create_worktree(
        &self,
        lease: &Lease,
        params: Value,
        is_current: IsCurrent,
        before_dispatch: BeforeSend,
    ) -> BoxFuture<AssistantResult<Value>>;

    /// `args.onAgentPrompted?.(input)`: `{connectionId, paneId, terminalId,
    /// seq, status}`.
    fn agent_prompted(&self, input: Value);

    /// `args.onWorkspaceCreated?.(input)`: `{connectionId, workspaceId,
    /// sourceWorkspaceId}`.
    fn workspace_created(&self, input: Value) -> BoxFuture<AssistantResult<()>>;

    /// `runtime.herdr.call(method, params, timeoutMs, beforeSend?)`.
    fn herdr_call(
        &self,
        lease: &Lease,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.files.readGitDiffFile(query)`.
    fn read_git_diff_file(&self, lease: &Lease, query: Value) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.files.readGitDiffSummary(query)`.
    fn read_git_diff_summary(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.files.resolveWorkspaceGitRoot({workspace_id})`.
    fn resolve_workspace_git_root(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.agentSessions.readHistory({pane_id, workspace_id})`.
    fn read_history(&self, lease: &Lease, query: Value) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.agentSessions?.readSummary?.({pane_id, workspace_id})`:
    /// None when the runtime has no reader.
    fn read_summary(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Option<Value>>>;

    /// `runtime.conversation?.ownedSession(paneId)`: `{session_id, ...}`
    /// of the session conversation mode drives in the pane, or None.
    fn owned_session(
        &self,
        lease: &Lease,
        pane_id: &str,
    ) -> BoxFuture<AssistantResult<Option<Value>>>;

    /// `runtime.conversation.prompt(paneId, prompt, beforeSend)`: true
    /// when conversation mode holds the pane and took the prompt.
    fn conversation_prompt(
        &self,
        lease: &Lease,
        pane_id: &str,
        prompt: &str,
        before_send: BeforeSend,
    ) -> BoxFuture<AssistantResult<bool>>;

    /// `runtime.worktreeHooks.readWorktreeHooks(cwd)`: null, or
    /// `{config: {setup?}, ...}`.
    fn read_worktree_hooks(&self, lease: &Lease, cwd: &str) -> BoxFuture<AssistantResult<Value>>;

    /// `runtime.recoveryIdentity(signal)`: Herdr's boot identity, None when
    /// the runtime cannot tell (or has no such reader).
    fn recovery_identity(&self, lease: &Lease) -> BoxFuture<AssistantResult<Option<String>>>;

    /// `readGuiSettings()`: settings.json as normalised.
    fn read_gui_settings(&self) -> BoxFuture<AssistantResult<Value>>;

    /// `resolveRepoSettingsKey({workspace, root, host: runtime.sshHost(),
    /// connectionId, settings})`: `{key, commonDir}`; `input` is
    /// `{workspace, root, settings}`, the rest from the lease.
    fn resolve_repo_settings_key(
        &self,
        lease: &Lease,
        input: Value,
    ) -> BoxFuture<AssistantResult<Value>>;

    /// `inspectWorkspacePath(cwd, {host: runtime.sshHost(), remotePlatform},
    /// false)`: `{error?, ...}`.
    fn inspect_workspace_path(&self, lease: &Lease, cwd: &str)
    -> BoxFuture<AssistantResult<Value>>;

    /// `turnCauses.note(connectionId, paneId, cause)`.
    fn note_turn_cause(&self, connection_id: &str, pane_id: &str, cause: Value);
}

// ------------------------------------------------------------ JS helpers

pub(crate) fn err(message: impl Into<String>) -> AssistantError {
    AssistantError::internal(message)
}

/// What a stopped signal throws when it carries no reason of its own
/// (a [`CancellationToken`] carries none), as the tool wrappers say it.
pub(crate) fn aborted() -> AssistantError {
    err("aborted")
}

/// `a === b`, undefined (None) included.
pub(crate) fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Object(_) | Value::Array(_)), _)
        | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        _ => a == b,
    }
}

/// `value === "text"`.
pub(crate) fn is(value: Option<&Value>, text: &str) -> bool {
    value.and_then(Value::as_str) == Some(text)
}

/// JavaScript truthiness.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)`, undefined included.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::to_text)
}

/// Sets `key` unless the value is undefined, as an object literal that
/// `JSON.stringify` writes.
pub(crate) fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.clone());
    }
}

pub(crate) fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub(crate) fn is_safe_integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(js::is_safe_integer)
}

fn identifier(value: Option<&Value>, name: &str) -> AssistantResult<String> {
    validate_connection_id(value).map_err(|_| err(format!("Invalid {name}")))
}

fn limited_text(value: Option<&Value>, limit: usize) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if js::len16(text) > limit => {
            format!("{} [truncated]", js::head16(text, limit))
        }
        Some(text) => text.to_owned(),
        None => String::new(),
    }
}

fn records(value: Option<&Value>) -> Vec<Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn count(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|v| {
            v.as_f64()
                .is_some_and(|n| js::is_safe_integer(n) && n >= 0.0)
        })
        .cloned()
}

fn has_control(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn relative_path(value: Option<&Value>) -> AssistantResult<String> {
    let invalid = || err("Diff path must be a relative workspace path");
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(invalid());
    };
    let bytes = text.as_bytes();
    if text.is_empty()
        || js::len16(text) > 1024
        || matches!(bytes[0], b'\\' | b'/' | b':')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || has_control(text)
    {
        return Err(invalid());
    }
    let path = sanitize_explorer_path(value)?;
    if path.is_empty() {
        return Err(invalid());
    }
    Ok(path)
}

/// `workspaceIdentity(workspace)`: what a recovery checks a workspace is
/// still the same by.
fn workspace_identity(workspace: &Value) -> String {
    let worktree = workspace.get("worktree").filter(|w| w.is_object());
    let field = |value: Option<&Value>| value.cloned().unwrap_or(Value::Null);
    sha256_hex(&js::stringify(&json!([
        field(workspace.get("cwd")),
        field(worktree.and_then(|w| w.get("repo_key"))),
        field(worktree.and_then(|w| w.get("repo_root"))),
        field(worktree.and_then(|w| w.get("checkout_path"))),
    ])))
}

/// What Ranger is told of a pane's session a usage limit paused.
fn limit_pause_field(pause: Option<&LimitPause>) -> Option<Value> {
    let pause = pause?;
    Some(json!({
        "paused_by": format!("{} usage limit", limit_kind_label(&pause.kind)),
        "resets_at": js::iso(pause.resets_at as f64),
        "resumes_at": pause.resume_at.map(|at| js::iso(at as f64)),
        "state": serde_json::to_value(pause.state).unwrap_or(Value::Null),
    }))
}

fn mention_label(value: Option<&Value>, fallback: &str) -> String {
    let label = match value.and_then(Value::as_str) {
        Some(text) => {
            let spaced: String = text
                .chars()
                .map(|c| {
                    if c <= '\u{1f}' || c == '\u{7f}' {
                        ' '
                    } else {
                        c
                    }
                })
                .collect();
            js::head16(js::trim(&spaced), 200)
        }
        None => String::new(),
    };
    if label.is_empty() {
        js::head16(fallback, 200)
    } else {
        label
    }
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn workspace_mention(target: &Value) -> Value {
    let workspace_id = text_of(target, "workspace_id");
    let label = mention_label(target.get("label"), workspace_id);
    json!({
        "kind": "workspace",
        "connection_id": target.get("connection_id").cloned().unwrap_or(Value::Null),
        "workspace_id": workspace_id,
        "runtime_generation": target.get("runtime_generation").cloned().unwrap_or(Value::Null),
        "connection_label": mention_label(target.get("connection_label"), text_of(target, "connection_id")),
        "workspace_label": label,
        "label": label,
    })
}

fn agent_key(connection_id: &str, workspace_id: &str, pane_id: &str) -> String {
    js::stringify(&json!([connection_id, workspace_id, pane_id]))
}

// ------------------------------------------------------------ signals

/// An `AbortSignal` with its reason: an external [`CancellationToken`]
/// (reason [`aborted`]), or a child the context aborts with an error.
#[derive(Clone)]
pub(crate) struct Stop {
    token: CancellationToken,
    reason: Arc<OnceLock<AssistantError>>,
    parent: Option<Arc<Stop>>,
}

impl Stop {
    fn root() -> Self {
        Self {
            token: CancellationToken::new(),
            reason: Arc::new(OnceLock::new()),
            parent: None,
        }
    }

    pub(crate) fn external(token: Option<CancellationToken>) -> Option<Self> {
        token.map(|token| Self {
            token,
            reason: Arc::new(OnceLock::new()),
            parent: None,
        })
    }

    fn child(&self) -> Self {
        Self {
            token: self.token.child_token(),
            reason: Arc::new(OnceLock::new()),
            parent: Some(Arc::new(self.clone())),
        }
    }

    pub(crate) fn is_aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    fn reason(&self) -> AssistantError {
        if let Some(reason) = self.reason.get() {
            return reason.clone();
        }
        match &self.parent {
            Some(parent) if parent.is_aborted() => parent.reason(),
            _ => aborted(),
        }
    }

    /// `signal.throwIfAborted()`.
    pub(crate) fn throw_if_aborted(&self) -> AssistantResult<()> {
        if self.is_aborted() {
            return Err(self.reason());
        }
        Ok(())
    }

    /// `controller.abort(reason)`: the first reason stays.
    fn abort(&self, reason: AssistantError) {
        if !self.is_aborted() {
            let _ = self.reason.set(reason);
            self.token.cancel();
        }
    }

    /// Resolves with the reason once aborted.
    pub(crate) async fn stopped(&self) -> AssistantError {
        self.token.cancelled().await;
        self.reason()
    }
}

fn throw_if_aborted(signal: Option<&Stop>) -> AssistantResult<()> {
    signal.map_or(Ok(()), Stop::throw_if_aborted)
}

/// Keeps admission reads bounded (eight at once), ordered and fail-closed:
/// the first failure aborts every read in flight and none queued starts.
async fn map_scope_reads<T, R, F, Fut>(
    items: Vec<T>,
    read: F,
    signal: Option<&Stop>,
) -> AssistantResult<Vec<R>>
where
    F: Fn(T, usize, Stop) -> Fut,
    Fut: Future<Output = AssistantResult<R>>,
{
    throw_if_aborted(signal)?;
    let controller = signal.map_or_else(Stop::root, Stop::child);
    let len = items.len();
    let queue = Mutex::new((0usize, items.into_iter().map(Some).collect::<Vec<_>>()));
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..len).map(|_| None).collect());
    let worker = || async {
        loop {
            if controller.is_aborted() {
                break;
            }
            let next = {
                let mut queue = queue.lock().unwrap();
                if queue.0 >= len {
                    None
                } else {
                    let index = queue.0;
                    queue.0 += 1;
                    queue.1[index].take().map(|item| (index, item))
                }
            };
            let Some((index, item)) = next else {
                break;
            };
            match read(item, index, controller.clone()).await {
                Ok(value) => results.lock().unwrap()[index] = Some(value),
                // Keep the first failure and stop every read and queued item.
                Err(error) => controller.abort(error),
            }
        }
    };
    join_all((0..len.min(MAX_SCOPE_READS)).map(|_| worker())).await;
    controller.throw_if_aborted()?;
    Ok(results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|value| value.expect("every read finished"))
        .collect())
}

// ------------------------------------------------------------ scopes

/// What the context keeps of a scope it captured, out of model data.
pub struct ScopeState {
    context: u64,
    /// The connections' leases, in the order the scope took them.
    leases: Vec<(String, Lease)>,
    identities: Vec<String>,
    /// The agents bound by mention, by `[connection, workspace, pane]`.
    guards: Mutex<Map<String, Value>>,
}

impl ScopeState {
    fn lease(&self, connection_id: &str) -> Option<&Lease> {
        self.leases
            .iter()
            .find(|(id, _)| id == connection_id)
            .map(|(_, lease)| lease)
    }
}

fn workspaces(scope: &Scope) -> &[Value] {
    scope.workspaces.as_array().map_or(&[], Vec::as_slice)
}

enum MentionError {
    /// A pane whose agent has no session to bind a mention to.
    Unavailable,
    Failed(AssistantError),
}

impl From<AssistantError> for MentionError {
    fn from(error: AssistantError) -> Self {
        Self::Failed(error)
    }
}

impl MentionError {
    fn into_error(self) -> AssistantError {
        match self {
            Self::Unavailable => err("Agent session is not available for mention"),
            Self::Failed(error) => error,
        }
    }
}

type BootProbe = Shared<BoxFuture<AssistantResult<Option<String>>>>;
type LeaseProbe = Shared<BoxFuture<AssistantResult<Option<Lease>>>>;

static NEXT_CONTEXT: AtomicU64 = AtomicU64::new(1);

/// `createAssistantContext(args)`.
#[derive(Clone)]
pub struct LiveContext {
    inner: Arc<Inner>,
}

struct Inner {
    host: Arc<dyn ContextHost>,
    clock: SharedClock,
    id: u64,
}

impl LiveContext {
    pub fn new(host: Arc<dyn ContextHost>, clock: SharedClock) -> Self {
        Self {
            inner: Arc::new(Inner {
                host,
                clock,
                id: NEXT_CONTEXT.fetch_add(1, Ordering::Relaxed),
            }),
        }
    }

    /// `prepareAction`, its result callable again (the TS `execute` keeps
    /// its one execution; [`PreparedAction`] makes it one-shot).
    pub async fn prepare(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> AssistantResult<Prepared> {
        self.inner
            .prepare_action(kind, captured, params, Stop::external(cancel))
            .await
    }
}

impl Inner {
    fn state<'a>(&self, captured: &'a Scope) -> Option<&'a ScopeState> {
        captured
            .private
            .downcast_ref::<ScopeState>()
            .filter(|state| state.context == self.id)
    }

    async fn fingerprint(&self, connection_id: &str) -> AssistantResult<Option<String>> {
        let value = self.host.recovery_fingerprint(connection_id).await?;
        if value.as_deref().is_some_and(|value| !is_hex64(value)) {
            return Err(err("Ranger recovery endpoint identity is invalid"));
        }
        Ok(value)
    }

    fn assert_current(&self, lease: &Lease, signal: Option<&Stop>) -> AssistantResult<()> {
        throw_if_aborted(signal)?;
        if !self.host.is_current(lease) {
            return Err(err(STALE_LEASE));
        }
        Ok(())
    }

    async fn read_leased<T, Fut>(
        &self,
        lease: &Lease,
        action: impl FnOnce() -> Fut,
        description: impl FnOnce() -> String,
        signal: Option<&Stop>,
    ) -> AssistantResult<T>
    where
        Fut: Future<Output = AssistantResult<T>>,
    {
        self.assert_current(lease, signal)?;
        let action = action();
        let result = match signal {
            Some(signal) => tokio::select! {
                result = action => result,
                reason = signal.stopped() => Err(reason),
            },
            None => action.await,
        };
        if let Ok(value) = result
            && self.assert_current(lease, signal).is_ok()
        {
            return Ok(value);
        }
        self.assert_current(lease, signal)?;
        // Transport and filesystem errors can contain socket paths or credentials.
        Err(err(format!("Unable to read {}", description())))
    }

    async fn herdr(
        &self,
        lease: &Lease,
        method: &str,
        params: Value,
        timeout_ms: u64,
        description: impl FnOnce() -> String,
        signal: Option<&Stop>,
    ) -> AssistantResult<Value> {
        let call = || {
            self.host
                .herdr_call(lease, method, params, timeout_ms, None)
        };
        self.read_leased(lease, call, description, signal).await
    }

    async fn workspace(
        &self,
        lease: &Lease,
        workspace_id: &str,
        signal: Option<&Stop>,
    ) -> AssistantResult<Value> {
        let result = self
            .herdr(
                lease,
                "workspace.get",
                json!({ "workspace_id": workspace_id }),
                5000,
                || format!("workspace {workspace_id}"),
                signal,
            )
            .await?;
        let item = match result.get("workspace") {
            Some(workspace) if workspace.is_object() => workspace.clone(),
            _ => result,
        };
        if !item.is_object() || !is(item.get("workspace_id"), workspace_id) {
            return Err(err(format!(
                "Workspace {workspace_id} is no longer available"
            )));
        }
        Ok(item)
    }

    /// A conversation-mode session's title, when it has one; never an error.
    async fn session_title(
        &self,
        lease: &Lease,
        target: &Value,
        pane_id: &str,
        signal: Option<&Stop>,
    ) -> AssistantResult<Option<String>> {
        let query = json!({ "pane_id": pane_id, "workspace_id": target["workspace_id"] });
        let read = || self.host.read_summary(lease, query);
        match self
            .read_leased(
                lease,
                read,
                || format!("agent title for pane {pane_id}"),
                signal,
            )
            .await
        {
            Ok(summary) => Ok(summary.and_then(|summary| {
                summary
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })),
            Err(_) => {
                throw_if_aborted(signal)?;
                Ok(None)
            }
        }
    }

    async fn agent_mention(
        &self,
        target: &Value,
        lease: &Lease,
        pane_id: &str,
        signal: Option<&Stop>,
    ) -> Result<Value, MentionError> {
        let workspace_id = text_of(target, "workspace_id");
        let occupant = actions::read_pane_occupant(
            |method, params| async move {
                self.herdr(
                    lease,
                    method,
                    params,
                    5000,
                    || format!("agent identity for pane {pane_id}"),
                    signal,
                )
                .await
            },
            workspace_id,
            pane_id,
        )
        .await?;
        // Conversation mode holds the pane: Herdr names the agent but not
        // its session, so the session Roamgate drives there is the identity.
        let owned = self.host.owned_session(lease, pane_id).await?;
        let agent_name = occupant
            .agent
            .get("agent")
            .and_then(Value::as_str)
            .filter(|agent| !agent.is_empty())
            .map(str::to_owned);
        let agent_identity = occupant.agent_identity.clone().or_else(|| {
            let owned = owned.as_ref()?;
            let agent = agent_name.as_ref()?;
            let mut session = Map::new();
            session.insert("source".into(), json!("roamgate:conversation"));
            session.insert("kind".into(), json!("id"));
            put(&mut session, "value", owned.get("session_id"));
            let mut identity = Map::new();
            put(
                &mut identity,
                "terminal_id",
                occupant.pane.get("terminal_id"),
            );
            identity.insert("agent".into(), json!(agent));
            identity.insert("session".into(), Value::Object(session));
            Some(sha256_hex(&js::stringify(&Value::Object(identity))))
        });
        let (Some(agent_identity), Some(agent)) = (agent_identity, agent_name) else {
            return Err(MentionError::Unavailable);
        };
        // The session's title names it better than "claude" does.
        let title = if owned.is_some() {
            self.session_title(lease, target, pane_id, signal).await?
        } else {
            None
        };
        let name = occupant.agent.get("name");
        let pane_label = occupant.pane.get("label");
        let title = title.map(Value::String);
        let label_source = if truthy(name) {
            name
        } else if truthy(pane_label) {
            pane_label
        } else {
            title.as_ref()
        };
        let mut result = workspace_mention(target);
        let map = result.as_object_mut().expect("an object");
        map.insert("kind".into(), json!("agent"));
        map.insert(
            "pane_id".into(),
            json!(identifier(Some(&json!(pane_id)), "pane_id")?),
        );
        map.insert(
            "terminal_id".into(),
            json!(identifier(occupant.pane.get("terminal_id"), "terminal_id")?),
        );
        map.insert("agent".into(), json!(agent));
        map.insert("agent_identity".into(), json!(agent_identity));
        map.insert("label".into(), json!(mention_label(label_source, &agent)));
        if !is_mention_target(&result) {
            return Err(MentionError::Unavailable);
        }
        Ok(result)
    }

    async fn assert_mention_agent(
        &self,
        state: &ScopeState,
        target: &Value,
        pane_id: &str,
        signal: Option<&Stop>,
    ) -> AssistantResult<()> {
        let key = agent_key(
            text_of(target, "connection_id"),
            text_of(target, "workspace_id"),
            pane_id,
        );
        let expected = state.guards.lock().unwrap().get(&key).cloned();
        let Some(expected) = expected else {
            return Ok(());
        };
        let Some(lease) = state.lease(text_of(target, "connection_id")) else {
            return Err(err(NOT_APPROVED));
        };
        let current = self
            .agent_mention(target, lease, pane_id, signal)
            .await
            .map_err(MentionError::into_error)?;
        if ["terminal_id", "agent", "agent_identity"]
            .iter()
            .any(|key| current.get(*key) != expected.get(*key))
        {
            return Err(err(SESSION_CHANGED));
        }
        Ok(())
    }

    async fn overlay_tab_ids(&self, connection_id: &str) -> BTreeSet<String> {
        match self.host.read_gui_settings().await {
            Ok(settings) => match settings.get("ui").and_then(Value::as_object) {
                Some(ui) => overlay_tab_ids_in(ui, connection_id),
                None => overlay_tab_ids_in(&Map::new(), connection_id),
            },
            Err(_) => BTreeSet::new(),
        }
    }

    async fn mention_catalog(
        &self,
        captured: &Scope,
        signal: Option<&Stop>,
    ) -> AssistantResult<Value> {
        let items = workspaces(captured);
        let Some(state) = self.state(captured).filter(|_| !items.is_empty()) else {
            return Err(err(NOT_APPROVED));
        };
        let mut targets: Vec<Value> = items.iter().map(workspace_mention).collect();
        let errors = Mutex::new(Vec::<String>::new());
        let truncated = AtomicBool::new(items.len() > 64);
        // ponytail: scan 64 workspaces and 200 agents; add paged discovery when these limits matter.
        let lists = map_scope_reads(
            items.iter().take(64).cloned().collect(),
            |target, _index, read_signal| {
                let (errors, truncated) = (&errors, &truncated);
                async move {
                    let connection_id = text_of(&target, "connection_id").to_owned();
                    let workspace_id = text_of(&target, "workspace_id").to_owned();
                    let lease = state.lease(&connection_id).expect("a scope lease");
                    let listed: AssistantResult<Vec<(Value, String)>> = async {
                        self.workspace(lease, &workspace_id, Some(&read_signal))
                            .await?;
                        let result = self
                            .herdr(
                                lease,
                                "pane.list",
                                json!({ "workspace_id": workspace_id }),
                                5000,
                                || format!("panes for workspace {workspace_id}"),
                                Some(&read_signal),
                            )
                            .await?;
                        if !result.get("panes").is_some_and(Value::is_array) {
                            return Err(err("Invalid pane list"));
                        }
                        // Overlay tabs stay out of Ranger's lists, as out of Roamgate's.
                        let hidden = self.overlay_tab_ids(&connection_id).await;
                        let panes: Vec<_> = records(result.get("panes"))
                            .into_iter()
                            .filter(|pane| {
                                is(pane.get("workspace_id"), &workspace_id)
                                    && truthy(pane.get("agent"))
                                    && !hidden.contains(&js_string(pane.get("tab_id")))
                            })
                            .collect();
                        if panes.len() > 200 {
                            truncated.store(true, Ordering::Relaxed);
                        }
                        panes
                            .iter()
                            .take(200)
                            .map(|pane| {
                                Ok((target.clone(), identifier(pane.get("pane_id"), "pane_id")?))
                            })
                            .collect()
                    }
                    .await;
                    match listed {
                        Ok(listed) => Ok(listed),
                        Err(_) => {
                            read_signal.throw_if_aborted()?;
                            self.assert_current(lease, Some(&read_signal))?;
                            errors.lock().unwrap().push(format!(
                                "Agents unavailable in {}",
                                mention_label(target.get("label"), &workspace_id)
                            ));
                            Ok(Vec::new())
                        }
                    }
                }
            },
            signal,
        )
        .await?;
        let candidates: Vec<(Value, String)> = lists.into_iter().flatten().collect();
        if candidates.len() > 200 {
            truncated.store(true, Ordering::Relaxed);
        }
        let unreadable = AtomicUsize::new(0);
        let agents = map_scope_reads(
            candidates.into_iter().take(200).collect(),
            |(target, pane_id), _index, read_signal| {
                let unreadable = &unreadable;
                async move {
                    let lease = state
                        .lease(text_of(&target, "connection_id"))
                        .expect("a scope lease");
                    match self
                        .agent_mention(&target, lease, &pane_id, Some(&read_signal))
                        .await
                    {
                        Ok(mention) => Ok(Some(mention)),
                        Err(cause) => {
                            read_signal.throw_if_aborted()?;
                            self.assert_current(lease, Some(&read_signal))?;
                            // A pane with no session to bind is no failure: it is left out.
                            if !matches!(cause, MentionError::Unavailable) {
                                unreadable.fetch_add(1, Ordering::Relaxed);
                            }
                            Ok(None)
                        }
                    }
                }
            },
            signal,
        )
        .await?;
        for (_, lease) in &state.leases {
            self.assert_current(lease, signal)?;
        }
        targets.extend(agents.into_iter().flatten());
        let mut errors = errors.into_inner().unwrap();
        let unreadable = unreadable.into_inner();
        if unreadable > 0 {
            errors.push(format!(
                "{unreadable} agent{} could not be read",
                if unreadable == 1 { "" } else { "s" }
            ));
        }
        let mut catalog = json!({ "targets": targets, "errors": errors });
        if truncated.into_inner() {
            catalog["truncated"] = json!(true);
        }
        Ok(catalog)
    }

    async fn bind_mentions(
        &self,
        captured: &Scope,
        targets: Value,
        signal: Option<&Stop>,
    ) -> AssistantResult<Value> {
        let invalid = || err("Invalid Ranger mentions or unapproved workspace scope");
        let items = workspaces(captured);
        let (Some(state), Some(mentions)) = (self.state(captured), targets.as_array()) else {
            return Err(invalid());
        };
        if items.is_empty()
            || mentions.len() > ASSISTANT_MAX_MENTIONS
            || !mentions.iter().all(is_mention_target)
        {
            return Err(invalid());
        }
        let guards = Mutex::new(state.guards.lock().unwrap().clone());
        let canonical = map_scope_reads(
            mentions.clone(),
            |mention, _index, read_signal| {
                let guards = &guards;
                async move {
                    let Some(target) = items.iter().find(|item| {
                        same(item.get("connection_id"), mention.get("connection_id"))
                            && same(item.get("workspace_id"), mention.get("workspace_id"))
                            && same(
                                item.get("runtime_generation"),
                                mention.get("runtime_generation"),
                            )
                    }) else {
                        return Err(err(
                            "Mention is outside the approved scope or its connection changed",
                        ));
                    };
                    let lease = state
                        .lease(text_of(target, "connection_id"))
                        .expect("a scope lease");
                    let workspace_id = text_of(target, "workspace_id");
                    let current_workspace = self
                        .workspace(lease, workspace_id, Some(&read_signal))
                        .await?;
                    let mut current_target = target.clone();
                    current_target["label"] =
                        json!(mention_label(current_workspace.get("label"), workspace_id));
                    if is(mention.get("kind"), "workspace") {
                        return Ok(workspace_mention(&current_target));
                    }
                    let current = self
                        .agent_mention(
                            &current_target,
                            lease,
                            text_of(&mention, "pane_id"),
                            Some(&read_signal),
                        )
                        .await
                        .map_err(MentionError::into_error)?;
                    if ["terminal_id", "agent", "agent_identity"]
                        .iter()
                        .any(|key| current.get(*key) != mention.get(*key))
                    {
                        return Err(err(SESSION_CHANGED));
                    }
                    let key = agent_key(
                        text_of(&current, "connection_id"),
                        text_of(&current, "workspace_id"),
                        text_of(&current, "pane_id"),
                    );
                    let mut guards = guards.lock().unwrap();
                    if guards.get(&key).is_some_and(|previous| {
                        previous.get("agent_identity") != current.get("agent_identity")
                    }) {
                        return Err(err(SESSION_CHANGED));
                    }
                    guards.insert(key, current.clone());
                    Ok(current)
                }
            },
            signal,
        )
        .await?;
        for (_, lease) in &state.leases {
            self.assert_current(lease, signal)?;
        }
        let mut held = state.guards.lock().unwrap();
        let mut merged = held.clone();
        for (key, guard) in guards.into_inner().unwrap() {
            if merged
                .get(&key)
                .is_some_and(|old| old.get("agent_identity") != guard.get("agent_identity"))
            {
                return Err(err(SESSION_CHANGED));
            }
            merged.insert(key, guard);
        }
        *held = merged;
        Ok(Value::Array(canonical))
    }

    async fn catalog(&self) -> AssistantResult<Value> {
        struct Listed {
            connection_id: String,
            lease: Option<Lease>,
            endpoint: Option<String>,
            truncated: bool,
            workspaces: Vec<Value>,
            errors: Vec<String>,
        }
        let connections: Vec<Value> = self
            .host
            .catalog()
            .await?
            .into_iter()
            .map(|connection| {
                json!({
                    "id": connection.get("id").cloned().unwrap_or(Value::Null),
                    "label": connection.get("label").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        let settled = join_all(connections.iter().map(|connection| async move {
            let connection_id = identifier(connection.get("id"), "connection_id")?;
            let label = limited_text(connection.get("label"), 200);
            let Some(lease) = self.host.lease(&connection_id).await? else {
                return Ok(Listed {
                    connection_id,
                    lease: None,
                    endpoint: None,
                    truncated: false,
                    workspaces: Vec::new(),
                    errors: vec![format!("Connection {label} is not ready")],
                });
            };
            let endpoint = self.fingerprint(&connection_id).await?;
            let payload = self
                .herdr(
                    &lease,
                    "workspace.list",
                    json!({}),
                    5000,
                    || format!("workspace list for connection {connection_id}"),
                    None,
                )
                .await?;
            let Some(listed) = payload.get("workspaces").and_then(Value::as_array) else {
                return Err(err("Invalid workspace list"));
            };
            let mut seen = BTreeSet::new();
            let truncated = listed.len() > ASSISTANT_MAX_WORKSPACES;
            let mut workspaces = Vec::new();
            for item in listed.iter().take(ASSISTANT_MAX_WORKSPACES) {
                if !item.is_object() {
                    return Err(err("Invalid workspace list"));
                }
                let workspace_id = identifier(item.get("workspace_id"), "workspace_id")?;
                if !seen.insert(workspace_id.clone()) {
                    return Err(err("Invalid workspace list"));
                }
                workspaces.push(json!({
                    "connection_id": connection_id,
                    "workspace_id": workspace_id,
                    "connection_label": label,
                    "label": limited_text(item.get("label"), 200),
                    "runtime_generation": lease.generation,
                }));
            }
            let errors = if truncated {
                vec![format!(
                    "Workspace list for connection {label} was truncated to {ASSISTANT_MAX_WORKSPACES} entries"
                )]
            } else {
                Vec::new()
            };
            Ok(Listed {
                connection_id,
                lease: Some(lease),
                endpoint,
                truncated,
                workspaces,
                errors,
            })
        }))
        .await;
        // A new connection may have been configured while another list was
        // pending. Use the current snapshot so its saved selection cannot be
        // mistaken for a removed connection, and recheck every successful
        // lease at this boundary.
        let mut connection_ids: Vec<String> = Vec::new();
        for connection in self.host.catalog().await? {
            let id = identifier(connection.get("id"), "connection_id")?;
            if !connection_ids.contains(&id) {
                connection_ids.push(id);
            }
        }
        let mut workspaces = Vec::new();
        let mut errors = Vec::new();
        let mut complete = Vec::new();
        let mut truncated = false;
        for (index, result) in settled.into_iter().enumerate() {
            if let Ok(listed) = result {
                let Some(lease) = &listed.lease else {
                    errors.extend(listed.errors);
                    continue;
                };
                if connection_ids.contains(&listed.connection_id)
                    && self.host.is_current(lease)
                    && self.fingerprint(&listed.connection_id).await? == listed.endpoint
                {
                    workspaces.extend(listed.workspaces);
                    errors.extend(listed.errors);
                    truncated |= listed.truncated;
                    if !listed.truncated {
                        complete.push(listed.connection_id);
                    }
                    continue;
                }
            }
            errors.push(format!(
                "Unable to list workspaces for connection {}",
                limited_text(connections.get(index).and_then(|c| c.get("label")), 200)
            ));
        }
        if workspaces.len() > ASSISTANT_MAX_WORKSPACES {
            truncated = true;
            complete.clear();
            errors.push(format!(
                "Workspace catalog was truncated to {ASSISTANT_MAX_WORKSPACES} entries"
            ));
        }
        workspaces.truncate(ASSISTANT_MAX_WORKSPACES);
        Ok(json!({
            "workspaces": workspaces,
            "errors": errors,
            "connection_ids": connection_ids,
            "complete_connection_ids": complete,
            "truncated": truncated,
        }))
    }

    async fn recovery_identity(
        &self,
        lease: &Lease,
        signal: Option<&Stop>,
    ) -> AssistantResult<Option<String>> {
        let probe = || self.host.recovery_identity(lease);
        self.read_leased(
            lease,
            probe,
            || "Ranger recovery server identity".into(),
            signal,
        )
        .await
    }

    async fn capture_scope(
        self: &Arc<Self>,
        refs: Value,
        signal: Option<&Stop>,
        recovery_targets: Option<Vec<Value>>,
    ) -> AssistantResult<Scope> {
        throw_if_aborted(signal)?;
        let refs = match refs.as_array() {
            Some(refs) if !refs.is_empty() && refs.len() <= ASSISTANT_MAX_WORKSPACES => refs,
            _ => {
                return Err(err(format!(
                    "Choose between 1 and {ASSISTANT_MAX_WORKSPACES} workspaces for Ranger"
                )));
            }
        };
        let requested = refs
            .iter()
            .map(|item| {
                if !item.is_object() {
                    return Err(err("Invalid Ranger workspace scope"));
                }
                Ok((
                    identifier(item.get("connection_id"), "connection_id")?,
                    identifier(item.get("workspace_id"), "workspace_id")?,
                ))
            })
            .collect::<AssistantResult<Vec<_>>>()?;
        let connections = self.host.catalog().await?;
        let leases: Mutex<Vec<(String, Lease)>> = Mutex::new(Vec::new());
        let lease_probes: Mutex<HashMap<String, LeaseProbe>> = Mutex::new(HashMap::new());
        let boot_ids: Mutex<HashMap<String, BootProbe>> = Mutex::new(HashMap::new());
        let seen: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());
        let recovery = recovery_targets.as_ref();
        let validated = map_scope_reads(
            requested,
            |(connection_id, workspace_id), index, read_signal| {
                let (connections, leases, lease_probes, boot_ids, seen) =
                    (&connections, &leases, &lease_probes, &boot_ids, &seen);
                async move {
                    if !seen
                        .lock()
                        .unwrap()
                        .insert((connection_id.clone(), workspace_id.clone()))
                    {
                        return Err(err("Duplicate Ranger workspace scope"));
                    }
                    let Some(connection) = connections
                        .iter()
                        .find(|item| is(item.get("id"), &connection_id))
                    else {
                        return Err(err(format!("Unknown connection {connection_id}")));
                    };
                    let label = limited_text(connection.get("label"), 200);
                    let named = if label.is_empty() {
                        connection_id.clone()
                    } else {
                        label.clone()
                    };
                    let expected = recovery.and_then(|targets| targets.get(index));
                    if let Some(expected) = expected {
                        let fingerprint = self.fingerprint(&connection_id).await?;
                        if !same(
                            fingerprint.map(Value::String).as_ref(),
                            expected.get("endpoint_fingerprint"),
                        ) {
                            return Err(err(format!(
                                "Ranger recovery endpoint changed: connection {named} now points elsewhere"
                            )));
                        }
                    }
                    let held = leases
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|(id, _)| *id == connection_id)
                        .map(|(_, lease)| lease.clone());
                    let lease = match held {
                        Some(lease) => Some(lease),
                        None => {
                            // One lease per connection, as the TS takes it
                            // before its first await.
                            let probe = lease_probes
                                .lock()
                                .unwrap()
                                .entry(connection_id.clone())
                                .or_insert_with(|| self.host.lease(&connection_id).shared())
                                .clone();
                            probe.await?
                        }
                    };
                    let Some(lease) = lease else {
                        let message = format!("Connection {connection_id} is not ready");
                        return Err(if recovery.is_some() {
                            AssistantError::RecoveryNotReady(message)
                        } else {
                            err(message)
                        });
                    };
                    {
                        let mut leases = leases.lock().unwrap();
                        if !leases.iter().any(|(id, _)| *id == connection_id) {
                            leases.push((connection_id.clone(), lease.clone()));
                        }
                    }
                    if let Some(expected) = expected {
                        let probe = boot_ids
                            .lock()
                            .unwrap()
                            .entry(connection_id.clone())
                            .or_insert_with(|| {
                                let (inner, lease, read_signal) =
                                    (self.clone(), lease.clone(), read_signal.clone());
                                let probe: BoxFuture<_> = Box::pin(async move {
                                    inner.recovery_identity(&lease, Some(&read_signal)).await
                                });
                                probe.shared()
                            })
                            .clone();
                        let boot_id = probe.await?;
                        if boot_id.as_deref().is_none_or(str::is_empty)
                            || !same(
                                boot_id.map(Value::String).as_ref(),
                                expected.get("herdr_boot_id"),
                            )
                        {
                            return Err(AssistantError::server_restarted(&named));
                        }
                    }
                    let item = self
                        .workspace(&lease, &workspace_id, Some(&read_signal))
                        .await?;
                    let identity = workspace_identity(&item);
                    if expected
                        .is_some_and(|expected| !is(expected.get("workspace_identity"), &identity))
                    {
                        return Err(err("Ranger recovery workspace changed"));
                    }
                    Ok((
                        identity,
                        json!({
                            "connection_id": connection_id,
                            "workspace_id": workspace_id,
                            "connection_label": label,
                            "label": limited_text(item.get("label"), 200),
                            "runtime_generation": lease.generation,
                        }),
                    ))
                }
            },
            signal,
        )
        .await
        .map_err(|error| settling(error, recovery.is_some()))?;
        let leases = leases.into_inner().unwrap();
        for (_, lease) in &leases {
            self.assert_current(lease, signal)
                .map_err(|error| settling(error, recovery.is_some()))?;
        }
        for expected in recovery_targets.iter().flatten() {
            let fingerprint = self.fingerprint(text_of(expected, "connection_id")).await?;
            if !same(
                fingerprint.map(Value::String).as_ref(),
                expected.get("endpoint_fingerprint"),
            ) {
                return Err(err("Ranger recovery endpoint changed"));
            }
        }
        let (identities, captured): (Vec<String>, Vec<Value>) = validated.into_iter().unzip();
        Ok(CapturedScope::new(
            Value::Array(captured),
            ScopeState {
                context: self.id,
                leases,
                identities,
                guards: Mutex::new(Map::new()),
            },
        ))
    }

    /// A turn's scope with more workspaces: those it already holds keep
    /// their leases and mention guards, and only the added ones are read.
    async fn extend_scope(
        self: &Arc<Self>,
        captured: &Scope,
        refs: Value,
        signal: Option<&Stop>,
    ) -> AssistantResult<Scope> {
        let Some(state) = self.state(captured) else {
            return Err(err(NOT_APPROVED));
        };
        let key = |item: &Value| {
            format!(
                "{}\0{}",
                js_string(item.get("connection_id")),
                js_string(item.get("workspace_id"))
            )
        };
        let held: BTreeSet<String> = workspaces(captured).iter().map(key).collect();
        let Some(refs) = refs.as_array() else {
            return Err(err("Invalid Ranger workspace scope"));
        };
        let missing: Vec<Value> = refs
            .iter()
            .filter(|item| !held.contains(&key(item)))
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(captured.clone());
        }
        if captured.len() + missing.len() > ASSISTANT_MAX_WORKSPACES {
            return Err(err(format!(
                "Ranger uses at most {ASSISTANT_MAX_WORKSPACES} workspaces at once"
            )));
        }
        let added = self
            .capture_scope(Value::Array(missing), signal, None)
            .await?;
        let added_state = self.state(&added).expect("a scope this context made");
        let mut merged = state.leases.clone();
        for (connection_id, lease) in &added_state.leases {
            match merged.iter().find(|(id, _)| id == connection_id) {
                Some((_, old)) if old.generation != lease.generation => {
                    return Err(err(format!("Connection {connection_id} changed")));
                }
                Some(_) => {}
                None => merged.push((connection_id.clone(), lease.clone())),
            }
        }
        for (_, lease) in &merged {
            self.assert_current(lease, signal)?;
        }
        let mut widened = workspaces(captured).to_vec();
        widened.extend(workspaces(&added).iter().cloned());
        let mut identities = state.identities.clone();
        identities.extend(added_state.identities.iter().cloned());
        let guards = state.guards.lock().unwrap().clone();
        Ok(CapturedScope::new(
            Value::Array(widened),
            ScopeState {
                context: self.id,
                leases: merged,
                identities,
                guards: Mutex::new(guards),
            },
        ))
    }

    async fn recovery_scope(
        &self,
        captured: &Scope,
        signal: Option<&Stop>,
    ) -> AssistantResult<Value> {
        throw_if_aborted(signal)?;
        let items = workspaces(captured);
        let Some(state) = self.state(captured).filter(|_| !items.is_empty()) else {
            return Err(err(NOT_APPROVED));
        };
        let connection_identities = map_scope_reads(
            state.leases.clone(),
            |(connection_id, lease), _index, read_signal| async move {
                self.assert_current(&lease, Some(&read_signal))?;
                let endpoint = self.fingerprint(&connection_id).await?;
                let boot_id = if endpoint.is_some() {
                    self.recovery_identity(&lease, Some(&read_signal)).await?
                } else {
                    None
                };
                Ok((connection_id, endpoint, boot_id))
            },
            signal,
        )
        .await?;
        if connection_identities.iter().any(|(_, endpoint, boot_id)| {
            endpoint.as_deref().is_none_or(str::is_empty)
                || boot_id.as_deref().is_none_or(str::is_empty)
        }) {
            return Ok(json!([]));
        }
        let targets = map_scope_reads(
            items.to_vec(),
            |item, index, read_signal| {
                let connection_identities = &connection_identities;
                async move {
                    let connection_id = text_of(&item, "connection_id");
                    let lease = state.lease(connection_id).expect("a scope lease");
                    let (_, endpoint, boot_id) = connection_identities
                        .iter()
                        .find(|(id, ..)| id == connection_id)
                        .expect("a connection identity");
                    let workspace_id = text_of(&item, "workspace_id");
                    let current = self
                        .workspace(lease, workspace_id, Some(&read_signal))
                        .await?;
                    if workspace_identity(&current) != state.identities[index] {
                        return Err(err("Ranger recovery workspace changed"));
                    }
                    Ok(json!({
                        "connection_id": connection_id,
                        "workspace_id": workspace_id,
                        "endpoint_fingerprint": endpoint,
                        "herdr_boot_id": boot_id,
                        "workspace_identity": state.identities[index],
                    }))
                }
            },
            signal,
        )
        .await?;
        for (_, lease) in &state.leases {
            self.assert_current(lease, signal)?;
        }
        for target in &targets {
            let fingerprint = self.fingerprint(text_of(target, "connection_id")).await?;
            if !same(
                fingerprint.map(Value::String).as_ref(),
                target.get("endpoint_fingerprint"),
            ) {
                return Err(err("Ranger recovery endpoint changed"));
            }
        }
        Ok(Value::Array(targets))
    }

    async fn restore_scope(
        self: &Arc<Self>,
        targets: Value,
        signal: Option<&Stop>,
    ) -> AssistantResult<Scope> {
        throw_if_aborted(signal)?;
        let valid = |target: &Value| {
            target.is_object()
                && target
                    .get("endpoint_fingerprint")
                    .and_then(Value::as_str)
                    .is_some_and(is_hex64)
                && target
                    .get("workspace_identity")
                    .and_then(Value::as_str)
                    .is_some_and(is_hex64)
                && target
                    .get("herdr_boot_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty() && js::len16(id) <= 500)
        };
        // A copy before awaiting: persisted targets cannot change during admission.
        let expected = match targets.as_array() {
            Some(items)
                if !items.is_empty()
                    && items.len() <= ASSISTANT_MAX_WORKSPACES
                    && items.iter().all(valid) =>
            {
                items.clone()
            }
            _ => return Err(err("Invalid Ranger recovery scope")),
        };
        let mut connections: Vec<(String, String)> = Vec::new();
        for target in &expected {
            let connection_id = js_string(target.get("connection_id"));
            let identity = js::stringify(&json!([
                target["endpoint_fingerprint"],
                target["herdr_boot_id"]
            ]));
            match connections.iter().find(|(id, _)| *id == connection_id) {
                Some((_, held)) if *held != identity => {
                    let label = self
                        .host
                        .catalog()
                        .await?
                        .into_iter()
                        .find(|item| same(item.get("id"), target.get("connection_id")))
                        .and_then(|item| item.get("label").cloned());
                    let label = limited_text(label.as_ref(), 200);
                    let named = if label.is_empty() {
                        connection_id
                    } else {
                        label
                    };
                    return Err(err(format!(
                        "Inconsistent Ranger recovery connection identity: the workspaces on {named} were checked on different Herdr servers"
                    )));
                }
                Some(_) => {}
                None => connections.push((connection_id, identity)),
            }
        }
        self.capture_scope(Value::Array(expected.clone()), signal, Some(expected))
            .await
    }

    async fn read(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        signal: Option<&Stop>,
    ) -> AssistantResult<ToolResult> {
        let items = workspaces(captured);
        let Some(state) = self.state(captured).filter(|_| !items.is_empty()) else {
            return Err(err(NOT_APPROVED));
        };
        let allowed: &[&str] = match kind {
            "status" => &["connection_id", "workspace_id"],
            "history" => &["connection_id", "workspace_id", "pane_id"],
            "diff" => &[
                "connection_id",
                "workspace_id",
                "path",
                "old_path",
                "mode",
                "kind",
                "snapshot_id",
            ],
            "terminal" => &["connection_id", "workspace_id", "pane_id", "lines"],
            _ => return Err(err("Unknown Ranger read tool")),
        };
        let Some(params) = params
            .as_object()
            .filter(|params| params.keys().all(|key| allowed.contains(&key.as_str())))
        else {
            return Err(err("Unsupported Ranger read parameters"));
        };
        let selected: Vec<&Value> = if kind == "status" && params.is_empty() {
            items.iter().collect()
        } else {
            let connection_id = identifier(params.get("connection_id"), "connection_id")?;
            let mut selected = Vec::new();
            for item in items {
                if is(item.get("connection_id"), &connection_id)
                    && is(
                        item.get("workspace_id"),
                        &identifier(params.get("workspace_id"), "workspace_id")?,
                    )
                {
                    selected.push(item);
                }
            }
            selected
        };
        if selected.is_empty() {
            return Err(err("Workspace is outside the approved Ranger scope"));
        }
        let mut sources = Vec::new();
        let mut output: Vec<Map<String, Value>> = Vec::new();
        for target in selected {
            let connection_id = text_of(target, "connection_id");
            let workspace_id = text_of(target, "workspace_id");
            let lease = state.lease(connection_id).expect("a scope lease");
            self.assert_current(lease, signal)?;
            if kind == "history" || kind == "diff" {
                assert_unix_host(
                    lease.remote_platform.as_deref(),
                    &format!("Ranger {kind} read"),
                )?;
            }
            let current_workspace = self.workspace(lease, workspace_id, signal).await?;
            let mut pane_id: Option<String> = None;
            let mut data = Map::new();
            if kind == "status" {
                let payload = self
                    .herdr(
                        lease,
                        "pane.list",
                        json!({ "workspace_id": workspace_id }),
                        5000,
                        || format!("panes for workspace {workspace_id}"),
                        signal,
                    )
                    .await?;
                let panes: Vec<_> = records(payload.get("panes"))
                    .into_iter()
                    .filter(|pane| is(pane.get("workspace_id"), workspace_id))
                    .collect();
                let mut paused: HashMap<String, LimitPause> = HashMap::new();
                for pause in self.host.limit_pauses(connection_id).await? {
                    paused.insert(pause.pane_id.clone(), pause);
                }
                if lease.remote_platform.as_deref() == Some("windows") {
                    data.insert("remote_platform".into(), json!("windows"));
                }
                data.insert(
                    "agent_status".into(),
                    json!(limited_text(current_workspace.get("agent_status"), 200)),
                );
                put(
                    &mut data,
                    "pane_count",
                    count(current_workspace.get("pane_count")).as_ref(),
                );
                put(
                    &mut data,
                    "tab_count",
                    count(current_workspace.get("tab_count")).as_ref(),
                );
                let listed: Vec<Value> = panes
                    .iter()
                    .take(MAX_ITEMS)
                    .map(|pane| {
                        let mut entry = Map::new();
                        entry.insert(
                            "pane_id".into(),
                            json!(limited_text(pane.get("pane_id"), 128)),
                        );
                        entry.insert(
                            "tab_id".into(),
                            json!(limited_text(pane.get("tab_id"), 128)),
                        );
                        entry.insert("label".into(), json!(limited_text(pane.get("label"), 200)));
                        entry.insert("agent".into(), json!(limited_text(pane.get("agent"), 200)));
                        entry.insert(
                            "agent_status".into(),
                            json!(limited_text(pane.get("agent_status"), 200)),
                        );
                        put(
                            &mut entry,
                            "usage_limit",
                            limit_pause_field(paused.get(&js_string(pane.get("pane_id")))).as_ref(),
                        );
                        Value::Object(entry)
                    })
                    .collect();
                data.insert("panes".into(), Value::Array(listed));
                data.insert("truncated".into(), json!(panes.len() > MAX_ITEMS));
            } else if kind == "history" || kind == "terminal" {
                let pane = identifier(params.get("pane_id"), "pane_id")?;
                pane_id = Some(pane.clone());
                let payload = self
                    .herdr(
                        lease,
                        "pane.get",
                        json!({ "pane_id": pane }),
                        5000,
                        || format!("pane {pane}"),
                        signal,
                    )
                    .await?;
                let item = match payload.get("pane") {
                    Some(item) if item.is_object() => item,
                    _ => &payload,
                };
                if !item.is_object()
                    || !is(item.get("pane_id"), &pane)
                    || !is(item.get("workspace_id"), workspace_id)
                {
                    return Err(err(
                        "Pane is outside the approved workspace or is no longer available",
                    ));
                }
                self.assert_mention_agent(state, target, &pane, signal)
                    .await?;
                if kind == "history" {
                    let query = json!({ "pane_id": pane, "workspace_id": workspace_id });
                    let history = self
                        .read_leased(
                            lease,
                            || self.host.read_history(lease, query),
                            || format!("agent history for pane {pane}"),
                            signal,
                        )
                        .await?;
                    if !is(history.get("pane_id"), &pane)
                        || !is(history.get("workspace_id"), workspace_id)
                    {
                        return Err(err("Pane changed workspace during Ranger history read"));
                    }
                    let messages = records(history.get("messages"));
                    data.insert("pane_id".into(), json!(pane));
                    data.insert(
                        "agent".into(),
                        json!(limited_text(history.get("agent"), 200)),
                    );
                    put(&mut data, "status", history.get("status"));
                    data.insert(
                        "updated_at".into(),
                        json!(limited_text(history.get("updated_at"), 200)),
                    );
                    if !is(history.get("status"), "ok") {
                        data.insert(
                            "unavailable".into(),
                            json!("Agent transcript is not available"),
                        );
                    }
                    data.insert(
                        "history_window".into(),
                        json!(
                            "Recent conversation messages; tool calls, tool outputs and older messages are not included"
                        ),
                    );
                    let start = messages.len().saturating_sub(MAX_ITEMS);
                    data.insert(
                        "messages".into(),
                        Value::Array(
                            messages[start..]
                                .iter()
                                .map(|message| {
                                    json!({
                                        "role": limited_text(message.get("role"), 200),
                                        "sent_at": limited_text(message.get("sent_at"), 200),
                                        "text": limited_text(message.get("text"), 8000),
                                    })
                                })
                                .collect(),
                        ),
                    );
                    let long = messages.iter().any(|message| {
                        message
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| js::len16(text) > 8000)
                    });
                    data.insert(
                        "truncated".into(),
                        json!(messages.len() > MAX_ITEMS || long),
                    );
                } else {
                    let lines = params.get("lines");
                    if let Some(lines) = lines {
                        let valid = lines.as_f64().is_some_and(|n| {
                            n.is_finite()
                                && n.fract() == 0.0
                                && n >= 1.0
                                && n <= ASSISTANT_MAX_TERMINAL_LINES as f64
                        });
                        if !valid {
                            return Err(err(format!(
                                "Terminal lines must be between 1 and {ASSISTANT_MAX_TERMINAL_LINES}"
                            )));
                        }
                    }
                    let lines = lines
                        .cloned()
                        .unwrap_or_else(|| json!(ASSISTANT_DEFAULT_TERMINAL_LINES));
                    // Herdr can collect idle agents' application history and restore their viewport.
                    let result = self
                        .herdr(
                            lease,
                            "pane.read",
                            json!({
                                "pane_id": pane,
                                "source": "recent",
                                "lines": lines,
                                "format": "text",
                                "strip_ansi": true,
                            }),
                            25_000,
                            || {
                                format!(
                                    "terminal output for pane {pane}; this Herdr connection may not support pane.read"
                                )
                            },
                            signal,
                        )
                        .await?;
                    let terminal = result.get("read").filter(|read| read.is_object());
                    let text = terminal
                        .and_then(|read| read.get("text"))
                        .and_then(Value::as_str);
                    let (Some(terminal), Some(text)) = (terminal, text) else {
                        return Err(err(
                            "Terminal output unavailable or pane changed workspace during read",
                        ));
                    };
                    if !is(terminal.get("pane_id"), &pane)
                        || !is(terminal.get("workspace_id"), workspace_id)
                    {
                        return Err(err(
                            "Terminal output unavailable or pane changed workspace during read",
                        ));
                    }
                    data.insert("pane_id".into(), json!(pane));
                    data.insert("requested_lines".into(), lines);
                    data.insert(
                        "terminal_window".into(),
                        json!(
                            "Most recent available terminal output; older output outside the requested line window is not included. Application history recovery depends on Herdr support and agent state"
                        ),
                    );
                    data.insert(
                        "text".into(),
                        json!(js::slice16(text, -(MAX_TEXT as i64), None)),
                    );
                    data.insert(
                        "truncated".into(),
                        json!(js::is_true(terminal.get("truncated")) || js::len16(text) > MAX_TEXT),
                    );
                }
            } else {
                let mode = params
                    .get("mode")
                    .cloned()
                    .unwrap_or_else(|| json!("working"));
                if !["working", "branch-main", "last-step"]
                    .contains(&js_string(Some(&mode)).as_str())
                {
                    return Err(err("Invalid diff mode"));
                }
                if let Some(kind) = params.get("kind")
                    && ![
                        "staged",
                        "unstaged",
                        "untracked",
                        "conflicted",
                        "branch",
                        "last-step",
                    ]
                    .contains(&js_string(Some(kind)).as_str())
                {
                    return Err(err("Invalid diff kind"));
                }
                let mut query = Map::new();
                query.insert("workspace_id".into(), json!(workspace_id));
                query.insert("mode".into(), mode);
                put(&mut query, "kind", params.get("kind"));
                if params.get("old_path").is_some() {
                    query.insert(
                        "old_path".into(),
                        json!(relative_path(params.get("old_path"))?),
                    );
                }
                if params.get("snapshot_id").is_some() {
                    query.insert(
                        "snapshot_id".into(),
                        json!(identifier(params.get("snapshot_id"), "snapshot_id")?),
                    );
                }
                if params.get("path").is_some() {
                    query.insert("path".into(), json!(relative_path(params.get("path"))?));
                    let diff = self
                        .read_leased(
                            lease,
                            || self.host.read_git_diff_file(lease, Value::Object(query)),
                            || format!("diff for workspace {workspace_id}"),
                            signal,
                        )
                        .await?;
                    if !is(diff.get("workspace_id"), workspace_id) {
                        return Err(err("Workspace changed during Ranger diff read"));
                    }
                    let Some(text) = diff.get("diff").and_then(Value::as_str) else {
                        return Err(err("Invalid diff"));
                    };
                    data.insert("path".into(), json!(limited_text(diff.get("path"), 1024)));
                    put(&mut data, "kind", diff.get("kind"));
                    data.insert(
                        "diff".into(),
                        json!(limited_text(diff.get("diff"), MAX_TEXT)),
                    );
                    let truncated = if truthy(diff.get("truncated")) {
                        diff["truncated"].clone()
                    } else {
                        json!(js::len16(text) > MAX_TEXT)
                    };
                    data.insert("truncated".into(), truncated);
                } else {
                    let diff = self
                        .read_leased(
                            lease,
                            || self.host.read_git_diff_summary(lease, Value::Object(query)),
                            || format!("diff summary for workspace {workspace_id}"),
                            signal,
                        )
                        .await?;
                    if !is(diff.get("workspace_id"), workspace_id) {
                        return Err(err("Workspace changed during Ranger diff read"));
                    }
                    let (Some(counts), Some(entries)) = (
                        diff.get("counts")
                            .filter(|counts| counts.is_object() || counts.is_array()),
                        diff.get("entries").and_then(Value::as_array),
                    ) else {
                        return Err(err("Invalid diff summary"));
                    };
                    put(&mut data, "mode", diff.get("mode"));
                    put(
                        &mut data,
                        "baseline_available",
                        diff.get("baseline_available"),
                    );
                    put(&mut data, "snapshot_id", diff.get("snapshot_id"));
                    let mut counted = Map::new();
                    for key in [
                        "staged",
                        "unstaged",
                        "untracked",
                        "conflicted",
                        "branch",
                        "last-step",
                    ] {
                        put(&mut counted, key, count(counts.get(key)).as_ref());
                    }
                    data.insert("counts".into(), Value::Object(counted));
                    let listed = entries
                        .iter()
                        .take(MAX_ITEMS)
                        .map(|entry| {
                            let mut item = Map::new();
                            item.insert(
                                "path".into(),
                                json!(limited_text(entry.get("path"), 1024)),
                            );
                            item.insert(
                                "old_path".into(),
                                json!(limited_text(entry.get("old_path"), 1024)),
                            );
                            for key in ["kind", "status", "additions", "deletions"] {
                                put(&mut item, key, entry.get(key));
                            }
                            Value::Object(item)
                        })
                        .collect();
                    data.insert("entries".into(), Value::Array(listed));
                    data.insert("truncated".into(), json!(entries.len() > MAX_ITEMS));
                }
            }
            if let Some(pane) = &pane_id {
                self.assert_mention_agent(state, target, pane, signal)
                    .await?;
            }
            self.assert_current(lease, signal)?;
            let read_at = js::iso(self.clock.now() as f64);
            let mut entry = target.as_object().cloned().unwrap_or_default();
            entry.insert("read_at".into(), json!(read_at));
            let warn = js::is_true(data.get("truncated"));
            entry.extend(data);
            if warn {
                entry.insert("warning".into(), json!(INCOMPLETE_NOTICE));
            }
            output.push(entry);
            let mut source = target.as_object().cloned().unwrap_or_default();
            source.insert("id".into(), json!(random_uuid()));
            let suffix = pane_id
                .as_ref()
                .map_or(String::new(), |pane| format!(" / {pane}"));
            source.insert(
                "title".into(),
                json!(format!(
                    "{}{suffix}",
                    limited_text(target.get("label"), 200)
                )),
            );
            source.insert("kind".into(), json!(kind));
            if let Some(pane) = &pane_id {
                source.insert("pane_id".into(), json!(pane));
            }
            source.insert("read_at".into(), json!(read_at));
            sources.push(Value::Object(source));
        }
        for (_, lease) in &state.leases {
            self.assert_current(lease, signal)?;
        }
        let stringify = |output: &[Map<String, Value>]| {
            js::stringify(&Value::Array(
                output.iter().cloned().map(Value::Object).collect(),
            ))
        };
        let mut serialized = stringify(&output);
        if kind == "terminal" && js::len16(&serialized) > MAX_TEXT {
            // JSON escaping and metadata count against the budget; retain the newest evidence.
            let text = output[0]["text"].as_str().unwrap_or("").to_owned();
            output[0].insert("truncated".into(), json!(true));
            output[0].insert("warning".into(), json!(INCOMPLETE_NOTICE));
            let tail = |length: usize| {
                if length == 0 {
                    String::new()
                } else {
                    js::slice16(&text, -(length as i64), None)
                }
            };
            let (mut low, mut high) = (0usize, js::len16(&text));
            while low < high {
                let length = (low + high).div_ceil(2);
                output[0].insert("text".into(), json!(tail(length)));
                if js::len16(&stringify(&output)) <= MAX_TEXT {
                    low = length;
                } else {
                    high = length - 1;
                }
            }
            output[0].insert("text".into(), json!(tail(low)));
            serialized = stringify(&output);
        } else if kind == "history" && js::len16(&serialized) > MAX_TEXT {
            // Messages run oldest first: drop the oldest so the newest fit,
            // rather than cutting the serialized text and losing the latest turns.
            let messages = output[0]["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            output[0].insert("truncated".into(), json!(true));
            output[0].insert("warning".into(), json!(INCOMPLETE_NOTICE));
            let (mut low, mut high) = (0usize, messages.len());
            while low < high {
                let kept = (low + high).div_ceil(2);
                output[0].insert("messages".into(), json!(messages[messages.len() - kept..]));
                if js::len16(&stringify(&output)) <= MAX_TEXT {
                    low = kept;
                } else {
                    high = kept - 1;
                }
            }
            // At least the newest message, cut below if even it is too long.
            let kept = low.max(1).min(messages.len());
            output[0].insert("messages".into(), json!(messages[messages.len() - kept..]));
            serialized = stringify(&output);
        }
        let text = if js::len16(&serialized) > MAX_TEXT {
            let budget = MAX_TEXT - js::len16(INCOMPLETE_NOTICE) - 14;
            format!(
                "{}\n{INCOMPLETE_NOTICE}",
                limited_text(Some(&json!(serialized)), budget)
            )
        } else {
            serialized
        };
        Ok(ToolResult {
            text,
            sources: Some(sources),
        })
    }

    async fn prepare_action(
        self: &Arc<Self>,
        kind: &str,
        captured: &Scope,
        params: Value,
        signal: Option<Stop>,
    ) -> AssistantResult<Prepared> {
        let items = workspaces(captured);
        let Some(state) = self
            .state(captured)
            .filter(|_| !items.is_empty() && params.is_object())
        else {
            return Err(err(NOT_APPROVED));
        };
        let connection_id = identifier(params.get("connection_id"), "connection_id")?;
        let workspace_id = identifier(params.get("workspace_id"), "workspace_id")?;
        let Some(target) = items.iter().find(|item| {
            is(item.get("connection_id"), &connection_id)
                && is(item.get("workspace_id"), &workspace_id)
        }) else {
            return Err(err("Action is outside the approved Ranger scope"));
        };
        let lease = state.lease(&connection_id).expect("a scope lease").clone();
        self.assert_current(&lease, signal.as_ref())?;
        let pane_id = params
            .get("pane_id")
            .and_then(Value::as_str)
            .filter(|pane| !pane.is_empty())
            .map(str::to_owned);
        if let Some(pane) = &pane_id {
            self.assert_mention_agent(state, target, pane, signal.as_ref())
                .await?;
        }
        let prepared = actions::prepare_assistant_action(
            self.host.clone(),
            self.clock.clone(),
            ActionRequest {
                kind: kind.to_owned(),
                target: target.clone(),
                lease,
                params,
                signal: signal.clone(),
            },
        )
        .await?;
        if let Some(pane) = &pane_id {
            self.assert_mention_agent(state, target, pane, signal.as_ref())
                .await?;
        }
        let guarded = pane_id.filter(|pane| {
            state.guards.lock().unwrap().contains_key(&agent_key(
                &connection_id,
                &workspace_id,
                pane,
            ))
        });
        let Some(pane) = guarded else {
            return Ok(prepared);
        };
        let (inner, captured, target) = (self.clone(), captured.clone(), target.clone());
        Ok(prepared.guarded(move |run| {
            let (inner, captured, target, pane) =
                (inner.clone(), captured.clone(), target.clone(), pane.clone());
            Box::pin(async move {
                let state = inner.state(&captured).expect("a scope this context made");
                if inner
                    .assert_mention_agent(state, &target, &pane, None)
                    .await
                    .is_err()
                {
                    return json!({
                        "status": "failed",
                        "detail": "Mentioned agent session changed or is unavailable. Nothing was sent; select it again.",
                    });
                }
                run.await
            })
        }))
    }
}

impl AssistantContext for LiveContext {
    fn catalog(&self) -> BoxFuture<AssistantResult<Value>> {
        let inner = self.inner.clone();
        Box::pin(async move { inner.catalog().await })
    }

    fn connection_state(&self, connection_id: &str) -> Option<Value> {
        self.inner.host.connection_status(connection_id)
    }

    fn watch_connections(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        self.inner.host.watch_connections(listener)
    }

    fn capture_scope(
        &self,
        refs: Value,
        cancel: Option<CancellationToken>,
        recovery_targets: Option<Value>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let inner = self.inner.clone();
        Box::pin(async move {
            let targets = match recovery_targets {
                None => None,
                Some(Value::Array(targets)) => Some(targets),
                Some(_) => return Err(err("Invalid Ranger recovery scope")),
            };
            inner
                .capture_scope(refs, Stop::external(cancel).as_ref(), targets)
                .await
        })
    }

    fn extend_scope(
        &self,
        captured: &Scope,
        refs: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let (inner, captured) = (self.inner.clone(), captured.clone());
        Box::pin(async move {
            inner
                .extend_scope(&captured, refs, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn recovery_scope(
        &self,
        captured: &Scope,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let (inner, captured) = (self.inner.clone(), captured.clone());
        Box::pin(async move {
            inner
                .recovery_scope(&captured, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn restore_scope(
        &self,
        targets: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        let inner = self.inner.clone();
        Box::pin(async move {
            inner
                .restore_scope(targets, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn mention_catalog(
        &self,
        captured: &Scope,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let (inner, captured) = (self.inner.clone(), captured.clone());
        Box::pin(async move {
            inner
                .mention_catalog(&captured, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn bind_mentions(
        &self,
        captured: &Scope,
        targets: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let (inner, captured) = (self.inner.clone(), captured.clone());
        Box::pin(async move {
            inner
                .bind_mentions(&captured, targets, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn read(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<ToolResult>> {
        let (inner, captured, kind) = (self.inner.clone(), captured.clone(), kind.to_owned());
        Box::pin(async move {
            inner
                .read(&kind, &captured, params, Stop::external(cancel).as_ref())
                .await
        })
    }

    fn prepare_action(
        &self,
        kind: &str,
        captured: &Scope,
        params: Value,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<PreparedAction>> {
        let (inner, captured, kind) = (self.inner.clone(), captured.clone(), kind.to_owned());
        Box::pin(async move {
            let prepared = inner
                .prepare_action(&kind, &captured, params, Stop::external(cancel))
                .await?;
            Ok(prepared.into_action())
        })
    }
}

/// What a read answers when its connection's runtime changed under it
/// (the front says the same, standalone/assistant.rs).
pub(crate) const STALE_LEASE: &str = "Connection changed during Ranger read; start a new turn";

/// During a recovery, a connection that changed under the read is still
/// settling after the restart: the recovery waits for it, as for one not
/// ready yet, instead of giving the question up.
fn settling(error: AssistantError, recovering: bool) -> AssistantError {
    if recovering && error.message() == STALE_LEASE {
        AssistantError::RecoveryNotReady(error.message().to_owned())
    } else {
        error
    }
}

#[cfg(test)]
mod tests;
