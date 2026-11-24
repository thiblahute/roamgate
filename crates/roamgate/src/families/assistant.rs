//! The assistant family in the core: Ranger (`roamgate-assistant`'s
//! service on its live context), its effects mapped onto the channel
//! (contract/wire/core-channel.md, The assistant family).
//!
//! - Browser calls: `bridge.assistant.*`. The front keeps what is its
//!   transport: `bridge.assistant.get`'s `since` stamp and each socket's
//!   state deltas, made from the core's `{assistant}` pushes.
//! - The front's own calls: `internal.assistant.connections` (the
//!   connection table, after each change), `.resume`, `.deliver_chat_comments`,
//!   `.release` (Bun takes Ranger back: the core's service is disposed
//!   first).
//! - Reverse calls: `assistant.release` (Bun disposes its own service
//!   before the core starts its), `assistant.connections`, `assistant.host`
//!   (what the context reads of the runtimes Bun owns, by `op`) and
//!   `assistant.chat_thread_reply`. The archive and Workspaces tools run
//!   here, on the archive and workspace families' code.
//! - Pushes: `{assistant: snapshot}` (key `assistant`) and
//!   `{assistant_notification}`.
//!
//! A dispatch gate (`beforeSend`, `beforeDispatch`) is a closure of the
//! core's; Bun calls its own copy synchronously right before it sends. The
//! core evaluates each gate before the reverse call that carries it and
//! again after every change of Ranger's state or of the connections, and
//! tells Bun of one that no longer holds (`gate_revoke`), so Bun's copy
//! refuses from then on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_assistant::archive_tools::{ArchiveToolDeps, archive_tool_handler};
use roamgate_assistant::context::live::{BeforeSend, ContextHost, IsCurrent, Lease, LiveContext};
use roamgate_assistant::errors::{AssistantError, AssistantResult};
use roamgate_assistant::ranger_driver::RangerDriver;
use roamgate_assistant::service::{AssistantService, ServiceOptions};
use roamgate_assistant::tools::{BoxFuture, ToolResult};
use roamgate_assistant::tree_tools::{
    TreeBackendError, TreeBackendResult, TreeConnectionManager, TreeConnectionRuntime,
    TreeToolConnection, WorkspaceTreeToolBackend, create_workspace_tree_tool_handler,
    read_workspace_tree_connections,
};
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_connections::usage_limit::LimitPause;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::IncomingCall;
use roamgate_sidecar::protocol::{Push, RpcError};
use serde_json::{Value, json};

pub const FAMILY: &str = "assistant";

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(AssistantFamily::default()))
}

/// A reverse call's error as Ranger knows it: a message it may show keeps
/// its kind (the codes Bun's `assistantReverse` sets).
fn assistant_error(error: RpcError) -> AssistantError {
    match error.code.as_deref() {
        Some("assistant_user") => AssistantError::User(error.message),
        Some("unsupported_platform") => AssistantError::Platform(error.message),
        _ => AssistantError::Internal(error.message),
    }
}

fn rpc_error(error: AssistantError) -> RpcError {
    RpcError::new(error.message().to_owned())
}

async fn reverse(cx: &FamilyContext, target: &str, args: Value) -> AssistantResult<Value> {
    cx.reverse(target, args).await.map_err(assistant_error)
}

// ------------------------------------------------------- connection table

/// What Bun said of a connection: its ready runtime's generation (None
/// while not ready) and its state (`{label, state, error?}`).
#[derive(Clone, Default, PartialEq)]
struct Connection {
    generation: Option<u64>,
    status: Option<Value>,
}

type Listener = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Table {
    /// In the order Bun's manager lists them.
    connections: Mutex<Vec<(String, Connection)>>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next: AtomicU64,
}

impl Table {
    /// Replaces the table with `[{id, generation, status}]`; tells the
    /// listeners when anything changed.
    fn set(&self, list: &Value) {
        let mut next: Vec<(String, Connection)> = Vec::new();
        for each in list.as_array().into_iter().flatten() {
            let Some(id) = each.get("id").and_then(Value::as_str) else {
                continue;
            };
            next.push((
                id.to_owned(),
                Connection {
                    generation: each.get("generation").and_then(Value::as_u64),
                    status: each
                        .get("status")
                        .filter(|value| value.is_object())
                        .cloned(),
                },
            ));
        }
        let changed = {
            let mut connections = self.connections.lock().unwrap();
            let changed = *connections != next;
            *connections = next;
            changed
        };
        if changed {
            let listeners: Vec<Listener> = self
                .listeners
                .lock()
                .unwrap()
                .iter()
                .map(|(_, listener)| listener.clone())
                .collect();
            for listener in listeners {
                listener();
            }
        }
    }

    fn current(&self, lease: &Lease) -> bool {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _)| *id == lease.connection_id)
            .map(|(_, connection)| connection)
            .is_some_and(|connection| connection.generation == Some(lease.generation))
    }

    fn status(&self, id: &str) -> Option<Value> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .find(|(each, _)| each == id)
            .map(|(_, connection)| connection)
            .and_then(|connection| connection.status.clone())
    }

    /// `[(id, label, ready)]`, in the manager's order.
    fn list(&self) -> Vec<(String, String, bool)> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .map(|(id, connection)| {
                let label = connection
                    .status
                    .as_ref()
                    .and_then(|status| status.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_owned();
                (id.clone(), label, connection.generation.is_some())
            })
            .collect()
    }

    fn watch(self: &Arc<Self>, listener: Listener) -> Box<dyn FnOnce() + Send> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.listeners.lock().unwrap().push((id, listener));
        let table = self.clone();
        Box::new(move || {
            table
                .listeners
                .lock()
                .unwrap()
                .retain(|(each, _)| *each != id)
        })
    }
}

// ------------------------------------------------------------------ gates

type Gate = Arc<dyn Fn() -> AssistantResult<()> + Send + Sync>;

/// The dispatch gates of the reverse calls in flight, by token.
#[derive(Default)]
struct Gates {
    open: Mutex<HashMap<u64, Gate>>,
    next: AtomicU64,
}

impl Gates {
    /// Registers `gate` if it holds now; its token, removed when the guard
    /// drops.
    fn open(self: &Arc<Self>, gate: Gate) -> AssistantResult<GateGuard> {
        gate()?;
        let token = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().unwrap().insert(token, gate);
        Ok(GateGuard {
            gates: self.clone(),
            token,
        })
    }

    /// Checks every open gate; tells Bun of each that no longer holds.
    fn check(&self, cx: &FamilyContext) {
        let failed: Vec<(u64, AssistantError)> = {
            let mut open = self.open.lock().unwrap();
            let failed: Vec<(u64, AssistantError)> = open
                .iter()
                .filter_map(|(token, gate)| gate().err().map(|error| (*token, error)))
                .collect();
            for (token, _) in &failed {
                open.remove(token);
            }
            failed
        };
        for (token, error) in failed {
            let cx = cx.clone();
            tokio::spawn(async move {
                let _ = cx
                    .reverse(
                        "assistant.host",
                        json!({
                            "op": "gate_revoke",
                            "token": token,
                            "message": error.message(),
                            "user": error.surfaced(),
                        }),
                    )
                    .await;
            });
        }
    }
}

struct GateGuard {
    gates: Arc<Gates>,
    token: u64,
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        self.gates.open.lock().unwrap().remove(&self.token);
    }
}

// ------------------------------------------------------------------- host

/// The live context's host: the runtimes Bun owns, through
/// `assistant.host`; the connection table for the synchronous queries.
struct ReverseHost {
    cx: FamilyContext,
    table: Arc<Table>,
    gates: Arc<Gates>,
}

impl ReverseHost {
    fn op(&self, op: &'static str, mut args: Value) -> BoxFuture<AssistantResult<Value>> {
        let cx = self.cx.clone();
        args["op"] = json!(op);
        Box::pin(async move { reverse(&cx, "assistant.host", args).await })
    }

    fn leased(
        &self,
        op: &'static str,
        lease: &Lease,
        mut args: Value,
    ) -> BoxFuture<AssistantResult<Value>> {
        args["lease"] = json!(lease);
        self.op(op, args)
    }

    /// An op that carries a gate: refused at once when it does not hold.
    fn gated(
        &self,
        op: &'static str,
        lease: &Lease,
        mut args: Value,
        gate: Gate,
    ) -> BoxFuture<AssistantResult<Value>> {
        let guard = match self.gates.open(gate) {
            Ok(guard) => guard,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        args["gate"] = json!(guard.token);
        let call = self.leased(op, lease, args);
        Box::pin(async move {
            let result = call.await;
            drop(guard);
            result
        })
    }

    fn fire(&self, op: &'static str, mut args: Value) {
        let cx = self.cx.clone();
        args["op"] = json!(op);
        tokio::spawn(async move {
            let _ = cx.reverse("assistant.host", args).await;
        });
    }
}

fn optional<T: serde::de::DeserializeOwned>(value: Value) -> AssistantResult<Option<T>> {
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| AssistantError::internal(error.to_string()))
}

impl ContextHost for ReverseHost {
    fn catalog(&self) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let call = self.op("catalog", json!({}));
        Box::pin(async move { Ok(call.await?.as_array().cloned().unwrap_or_default()) })
    }

    fn lease(&self, connection_id: &str) -> BoxFuture<AssistantResult<Option<Lease>>> {
        let call = self.op("lease", json!({"connection_id": connection_id}));
        Box::pin(async move { optional(call.await?) })
    }

    fn is_current(&self, lease: &Lease) -> bool {
        self.table.current(lease)
    }

    fn recovery_fingerprint(
        &self,
        connection_id: &str,
    ) -> BoxFuture<AssistantResult<Option<String>>> {
        let call = self.op(
            "recovery_fingerprint",
            json!({"connection_id": connection_id}),
        );
        Box::pin(async move { optional(call.await?) })
    }

    fn connection_status(&self, connection_id: &str) -> Option<Value> {
        self.table.status(connection_id)
    }

    fn watch_connections(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        self.table.watch(listener)
    }

    fn limit_pauses(&self, connection_id: &str) -> BoxFuture<AssistantResult<Vec<LimitPause>>> {
        let call = self.op("limit_pauses", json!({"connection_id": connection_id}));
        Box::pin(async move { Ok(optional(call.await?)?.unwrap_or_default()) })
    }

    fn can_create_worktree(&self) -> bool {
        true
    }

    fn create_worktree(
        &self,
        lease: &Lease,
        params: Value,
        is_current: IsCurrent,
        before_dispatch: BeforeSend,
    ) -> BoxFuture<AssistantResult<Value>> {
        // Bun checks the lease's generation itself (`isCurrent`); the
        // action's own permission is the gate's.
        let gate: Gate = Arc::new(move || {
            if !is_current() {
                return Err(AssistantError::internal("The worktree target changed."));
            }
            before_dispatch()
        });
        self.gated("create_worktree", lease, json!({"params": params}), gate)
    }

    fn agent_prompted(&self, input: Value) {
        self.fire("agent_prompted", json!({"input": input}));
    }

    fn workspace_created(&self, input: Value) -> BoxFuture<AssistantResult<()>> {
        let call = self.op("workspace_created", json!({"input": input}));
        Box::pin(async move { call.await.map(|_| ()) })
    }

    fn herdr_call(
        &self,
        lease: &Lease,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> BoxFuture<AssistantResult<Value>> {
        let args = json!({"method": method, "params": params, "timeout_ms": timeout_ms});
        match before_send {
            Some(gate) => self.gated("herdr_call", lease, args, gate),
            None => self.leased("herdr_call", lease, args),
        }
    }

    fn read_git_diff_file(&self, lease: &Lease, query: Value) -> BoxFuture<AssistantResult<Value>> {
        self.leased("read_git_diff_file", lease, json!({"query": query}))
    }

    fn read_git_diff_summary(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.leased("read_git_diff_summary", lease, json!({"query": query}))
    }

    fn resolve_workspace_git_root(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.leased("resolve_workspace_git_root", lease, json!({"query": query}))
    }

    fn read_history(&self, lease: &Lease, query: Value) -> BoxFuture<AssistantResult<Value>> {
        self.leased("read_history", lease, json!({"query": query}))
    }

    fn read_summary(
        &self,
        lease: &Lease,
        query: Value,
    ) -> BoxFuture<AssistantResult<Option<Value>>> {
        let call = self.leased("read_summary", lease, json!({"query": query}));
        Box::pin(async move { optional(call.await?) })
    }

    fn owned_session(
        &self,
        lease: &Lease,
        pane_id: &str,
    ) -> BoxFuture<AssistantResult<Option<Value>>> {
        let call = self.leased("owned_session", lease, json!({"pane_id": pane_id}));
        Box::pin(async move { optional(call.await?) })
    }

    fn conversation_prompt(
        &self,
        lease: &Lease,
        pane_id: &str,
        prompt: &str,
        before_send: BeforeSend,
    ) -> BoxFuture<AssistantResult<bool>> {
        let call = self.gated(
            "conversation_prompt",
            lease,
            json!({"pane_id": pane_id, "prompt": prompt}),
            before_send,
        );
        Box::pin(async move { Ok(call.await?.as_bool() == Some(true)) })
    }

    fn read_worktree_hooks(&self, lease: &Lease, cwd: &str) -> BoxFuture<AssistantResult<Value>> {
        self.leased("read_worktree_hooks", lease, json!({"cwd": cwd}))
    }

    fn recovery_identity(&self, lease: &Lease) -> BoxFuture<AssistantResult<Option<String>>> {
        let call = self.leased("recovery_identity", lease, json!({}));
        Box::pin(async move { optional(call.await?) })
    }

    fn read_gui_settings(&self) -> BoxFuture<AssistantResult<Value>> {
        self.op("read_gui_settings", json!({}))
    }

    fn resolve_repo_settings_key(
        &self,
        lease: &Lease,
        input: Value,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.leased("resolve_repo_settings_key", lease, json!({"input": input}))
    }

    fn inspect_workspace_path(
        &self,
        lease: &Lease,
        cwd: &str,
    ) -> BoxFuture<AssistantResult<Value>> {
        self.leased("inspect_workspace_path", lease, json!({"cwd": cwd}))
    }

    fn note_turn_cause(&self, connection_id: &str, pane_id: &str, cause: Value) {
        self.fire(
            "note_turn_cause",
            json!({"connection_id": connection_id, "pane_id": pane_id, "cause": cause}),
        );
    }
}

// ---------------------------------------------------- Workspaces tools

/// Ranger's Workspaces arrangement tools on the workspace family's store
/// and runtimes (same process): the connections in the order and with the
/// labels Bun's manager gives, as the connection table holds them.
struct CoreTree {
    table: Arc<Table>,
}

struct CoreTreeRuntime(Arc<super::workspace::TreeRuntime>);

impl TreeConnectionRuntime for CoreTreeRuntime {
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> BoxFuture<AssistantResult<Value>> {
        let (runtime, method) = (self.0.clone(), method.to_owned());
        Box::pin(async move {
            runtime
                .herdr_call(&method, params, timeout)
                .await
                .map_err(AssistantError::Internal)
        })
    }

    fn enrich_worktree_parents(&self, listed: &Value) -> Option<BoxFuture<AssistantResult<Value>>> {
        let (runtime, listed) = (self.0.clone(), listed.clone());
        Some(Box::pin(async move {
            Ok(runtime.enrich_worktree_parents(listed).await)
        }))
    }

    fn enrich_git_status(&self, listed: &Value) -> Option<BoxFuture<AssistantResult<Value>>> {
        let (runtime, listed) = (self.0.clone(), listed.clone());
        Some(Box::pin(async move {
            Ok(runtime.enrich_git_status(listed).await)
        }))
    }

    fn remote_platform(&self) -> Option<String> {
        self.0.remote_platform()
    }
}

impl TreeConnectionManager for CoreTree {
    fn list(&self) -> Vec<(String, String)> {
        self.table
            .list()
            .into_iter()
            .map(|(id, label, _)| (id, label))
            .collect()
    }

    fn ready_runtime(&self, id: &str) -> Option<Arc<dyn TreeConnectionRuntime>> {
        let ready = self
            .table
            .list()
            .into_iter()
            .any(|(each, _, ready)| each == id && ready);
        if !ready {
            return None;
        }
        super::workspace::tree_runtime(id).map(|runtime| {
            Arc::new(CoreTreeRuntime(Arc::new(runtime))) as Arc<dyn TreeConnectionRuntime>
        })
    }
}

impl WorkspaceTreeToolBackend for CoreTree {
    fn connections(
        &self,
        _signal: Option<tokio_util::sync::CancellationToken>,
    ) -> BoxFuture<TreeBackendResult<Vec<TreeToolConnection>>> {
        let manager = CoreTree {
            table: self.table.clone(),
        };
        Box::pin(async move { Ok(read_workspace_tree_connections(&manager).await) })
    }

    fn read(&self) -> BoxFuture<TreeBackendResult<Value>> {
        Box::pin(async {
            super::workspace::tree_read()
                .await
                .map_err(TreeBackendError::Failed)
        })
    }

    fn apply(&self, ops: Vec<Value>) -> BoxFuture<TreeBackendResult<Value>> {
        Box::pin(async move {
            super::workspace::tree_apply(ops)
                .await
                .map_err(|(message, refused)| {
                    if refused {
                        TreeBackendError::Refused(message)
                    } else {
                        TreeBackendError::Failed(message)
                    }
                })
        })
    }
}

// --------------------------------------------------------------- the family

fn tool_result(value: Value) -> ToolResult {
    ToolResult {
        text: value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        sources: value.get("sources").and_then(Value::as_array).cloned(),
    }
}

type Starting = Shared<BoxFuture<Option<AssistantService>>>;

#[derive(Default)]
struct AssistantFamily {
    table: Arc<Table>,
    gates: Arc<Gates>,
    /// The service while the core owns the family (once started).
    running: Mutex<Option<Starting>>,
    /// The last service's disposal, which `internal.assistant.release`
    /// waits for.
    stopping: Mutex<Option<Shared<BoxFuture<()>>>>,
}

impl AssistantFamily {
    fn start(&self, cx: &FamilyContext) -> Starting {
        let (cx, table, gates) = (cx.clone(), self.table.clone(), self.gates.clone());
        let stopping = self.stopping.lock().unwrap().clone();
        let started: BoxFuture<Option<AssistantService>> = Box::pin(async move {
            if let Some(stopping) = stopping {
                stopping.await;
            }
            // Bun's own service stops first: one writer of state.json and
            // tasks.sqlite.
            if let Err(error) = cx.reverse("assistant.release", json!({})).await {
                tracing::warn!("Bun did not release Ranger: {}", error.message);
            }
            match cx.reverse("assistant.connections", json!({})).await {
                Ok(list) => table.set(&list),
                Err(error) => tracing::warn!("connections unknown: {}", error.message),
            }
            let host = Arc::new(ReverseHost {
                cx: cx.clone(),
                table: table.clone(),
                gates: gates.clone(),
            });
            let context = Arc::new(LiveContext::new(host, cx.clock.clone()));
            let data = DataContext::from_env(&ProcessEnv);
            let publish = {
                let (cx, gates) = (cx.clone(), gates.clone());
                Arc::new(move |snapshot: Value| {
                    cx.push(Push {
                        message: json!({"assistant": snapshot}),
                        key: Some("assistant".into()),
                        ..Push::default()
                    });
                    // Ranger's state changed: a gate may no longer hold.
                    gates.check(&cx);
                })
            };
            let driver_data = data.clone();
            let mut options = ServiceOptions::new(
                context,
                publish,
                data,
                cx.clock.clone(),
                Arc::new(move |directory, credentials| {
                    Arc::new(RangerDriver::for_directory(
                        &directory,
                        &credentials,
                        driver_data.clone(),
                    ))
                }),
            );
            options.notify = Some({
                let cx = cx.clone();
                Arc::new(move |notification: Value| {
                    cx.push(Push {
                        message: json!({"assistant_notification": notification}),
                        ..Push::default()
                    });
                    Ok(())
                })
            });
            // The Workspaces arrangement, the workspace family's here.
            options.workspace_tree = Some(create_workspace_tree_tool_handler(Arc::new(CoreTree {
                table: table.clone(),
            })));
            // The session archive, read here: the core owns it.
            options.archive = Some(archive_tool_handler(ArchiveToolDeps {
                settings: Arc::new(|| super::archive::settings(&ProcessEnv)),
                archive_dir: Arc::new(|settings| {
                    super::archive::archive_dir(settings, &super::archive::runtime())
                }),
                runtime: Arc::new(super::archive::runtime),
            }));
            options.chat_threads = Some({
                let cx = cx.clone();
                Arc::new(move |session_id, params, _cancel| {
                    let cx = cx.clone();
                    Box::pin(async move {
                        let value = reverse(
                            &cx,
                            "assistant.chat_thread_reply",
                            json!({"session_id": session_id, "params": params}),
                        )
                        .await?;
                        Ok(tool_result(value))
                    })
                })
            });
            let service = AssistantService::new(options);
            if let Err(error) = service.resume().await {
                tracing::warn!("Ranger recovery could not be started: {}", error.message());
            }
            Some(service)
        });
        started.shared()
    }

    fn running(&self) -> Option<Starting> {
        self.running.lock().unwrap().clone()
    }

    /// Stops the service, if one runs; its disposal is kept for `release`.
    fn stop(&self) {
        let Some(running) = self.running.lock().unwrap().take() else {
            return;
        };
        let disposal: BoxFuture<()> = Box::pin(async move {
            if let Some(service) = running.await {
                service.dispose().await;
            }
        });
        let disposal = disposal.shared();
        tokio::spawn(disposal.clone());
        *self.stopping.lock().unwrap() = Some(disposal);
    }
}

impl CoreFamily for AssistantFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let method = call.method.clone();
        let params = call.params.clone();
        if method == "internal.assistant.connections" {
            self.table
                .set(params.get("connections").unwrap_or(&Value::Null));
            self.gates.check(cx);
            return Box::pin(async { Ok(json!({"ok": true})) });
        }
        if method == "internal.assistant.release" {
            self.stop();
            let stopping = self.stopping.lock().unwrap().clone();
            return Box::pin(async move {
                if let Some(stopping) = stopping {
                    stopping.await;
                }
                Ok(json!({}))
            });
        }
        let running = self.running();
        Box::pin(async move {
            let Some(service) = (match running {
                Some(running) => running.await,
                None => None,
            }) else {
                return Err(RpcError::with_code(
                    "Ranger runs in Bun".to_owned(),
                    "not_owner",
                ));
            };
            let params = if params.is_null() { json!({}) } else { params };
            let result = match method.as_str() {
                "internal.assistant.resume" => service.resume().await.map(|()| json!({"ok": true})),
                "internal.assistant.deliver_chat_comments" => {
                    let text = |key: &str| {
                        params
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned()
                    };
                    service
                        .deliver_chat_comments(&text("session_id"), &text("text"))
                        .await
                        .map(|()| json!({"ok": true}))
                }
                "bridge.assistant.context" => service.workspace_catalog().await,
                "bridge.assistant.mentions" => service.mention_catalog(params).await,
                "bridge.assistant.task.get" => service.task_detail(params).await,
                other if other.starts_with("bridge.assistant.") => {
                    service.handle(other, params).await
                }
                other => {
                    return Err(RpcError::with_code(
                        format!("unknown method {other}"),
                        "unknown_method",
                    ));
                }
            };
            result.map_err(rpc_error)
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        if owned {
            if self.running().is_none() {
                let started = self.start(cx);
                tokio::spawn(started.clone());
                *self.running.lock().unwrap() = Some(started);
            }
        } else {
            self.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(generation: u64) -> Lease {
        Lease {
            connection_id: "local".into(),
            generation,
            remote_platform: None,
            ssh_host: None,
        }
    }

    #[test]
    fn the_table_says_which_leases_are_current_and_tells_its_watchers_of_changes() {
        let table = Arc::new(Table::default());
        let seen = Arc::new(AtomicU64::new(0));
        let unwatch = table.watch({
            let seen = seen.clone();
            Arc::new(move || {
                seen.fetch_add(1, Ordering::Relaxed);
            })
        });
        let list = json!([{"id": "local", "generation": 2, "status": {"label": "Local", "state": "ready"}}]);
        table.set(&list);
        table.set(&list);
        assert_eq!(seen.load(Ordering::Relaxed), 1);
        assert!(table.current(&lease(2)));
        assert!(!table.current(&lease(1)));
        assert_eq!(
            table.status("local"),
            Some(json!({"label": "Local", "state": "ready"}))
        );
        table.set(&json!([{"id": "local", "generation": null, "status": {"label": "Local", "state": "reconnecting"}}]));
        assert!(!table.current(&lease(2)));
        assert_eq!(seen.load(Ordering::Relaxed), 2);
        unwatch();
        table.set(&json!([]));
        assert_eq!(seen.load(Ordering::Relaxed), 2);
        assert_eq!(table.status("local"), None);
    }

    #[test]
    fn a_gate_that_does_not_hold_refuses_before_any_call_and_closes_with_its_guard() {
        let gates = Arc::new(Gates::default());
        let refused = gates.open(Arc::new(|| Err(AssistantError::user("Revoked"))));
        assert_eq!(refused.err(), Some(AssistantError::user("Revoked")));
        let guard = gates.open(Arc::new(|| Ok(()))).unwrap();
        assert_eq!(gates.open.lock().unwrap().len(), 1);
        drop(guard);
        assert!(gates.open.lock().unwrap().is_empty());
    }

    #[test]
    fn reverse_errors_keep_whether_ranger_may_show_them() {
        let mut user = RpcError::new("Pick a workspace");
        user.code = Some("assistant_user".into());
        assert_eq!(
            assistant_error(user),
            AssistantError::User("Pick a workspace".into())
        );
        let mut platform = RpcError::new("Not on Windows");
        platform.code = Some("unsupported_platform".into());
        assert_eq!(
            assistant_error(platform),
            AssistantError::Platform("Not on Windows".into())
        );
        assert_eq!(
            assistant_error(RpcError::new("connect ENOENT /x.sock")),
            AssistantError::Internal("connect ENOENT /x.sock".into())
        );
    }
}
