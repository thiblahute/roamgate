//! The browser RPCs Bun answered with its own code and no family declares
//! (index.ts `handleRpc`, S25 step 1 item 2), answered by a standalone
//! core's `front` family:
//!
//! - Machine-wide: `connections.agent_sessions` (every ready connection's
//!   topology and agents, seen marks laid over, answered as changes from
//!   the version the socket holds) and `connections.agent_tasks`.
//! - A connection's: `workspace.path`, `workspace.create` with a `cwd`
//!   (the path checked on the connection's host first), `agent.list`
//!   (agents with their durable activity and seen marks), and Herdr's own
//!   methods passed through with what Bun laid over them: conversation
//!   mode's and the Claude mods' panes, the conversations stopped as shell
//!   jobs, typed input refused while conversation mode switches and noted
//!   as the user's turn, integration versions from the host's CLI, and a
//!   workspace list's worktree parents, git status and terminal modes.
//!
//! The topology lists' `since` stamps are the front family's (per socket).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::env::ProcessEnv;
use roamgate_channel::family::FamilyContext;
use roamgate_channel::protocol::RpcError;
use roamgate_connections::agent_summaries::{
    SummaryRuntime, TasksRuntime, read_connection_agent_tasks, read_connection_summary,
};
use roamgate_connections::routing::CONNECTION_CHANGED_DURING_REQUEST;
use roamgate_herdr::integration_versions::{
    CLI_TIMEOUT_MS, CliRun, SSH_STATUS_COMMAND, enrich_integration_versions,
};
use serde_json::{Map, Value, json};

use super::connections::{SshRun, run_local, run_ssh};
use super::{Layer, Lease, text};

/// A browser call's answer and the context its reply is logged with.
pub(crate) struct Reply {
    pub result: Result<Value, RpcError>,
    pub context: String,
}

impl Reply {
    fn ok(result: Value, context: impl Into<String>) -> Self {
        Self {
            result: Ok(result),
            context: context.into(),
        }
    }

    fn error(error: impl Into<RpcError>, context: impl Into<String>) -> Self {
        Self {
            result: Err(error.into()),
            context: context.into(),
        }
    }
}

/// Whether the request's connection is still the one it was routed to.
pub(crate) type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;

/// A connection's call, routed.
pub(crate) struct Request {
    pub method: String,
    pub params: Value,
    pub connection_id: String,
    pub generation: u64,
    pub is_current: IsCurrent,
    /// The browser socket asking.
    pub socket_id: u64,
}

/// The `connections.agent_sessions` answers each socket was given (two).
#[derive(Default)]
pub(crate) struct SessionVersions(Mutex<HashMap<u64, Vec<(String, Value)>>>);

impl SessionVersions {
    pub(crate) fn socket_closed(&self, socket_id: u64) {
        self.0.lock().unwrap().remove(&socket_id);
    }
}

/// A connection's summary is read again when older than this, Herdr
/// having said nothing: what Herdr does not tell of (git status, the
/// transcripts' activity times) is at most this old. The browsers read
/// the summaries every 15 s and after Herdr's events.
pub(crate) const SNAPSHOT_MAX_AGE_MS: f64 = 10_000.0;

/// The least time between two reads of a connection's summary: Herdr's
/// events come in bursts, and each browser reads after them.
const SNAPSHOT_MIN_GAP: std::time::Duration = std::time::Duration::from_millis(1000);

/// A connection's summary (`read_connection_summary`), shared by every
/// browser (`connections.agent_sessions`, `agent.list`): read once for
/// all, again only when Herdr's read generation moved (an event, a change
/// made through its client) or it is [`SNAPSHOT_MAX_AGE_MS`] old. A reader
/// that finds it stale joins the read in flight when that read started
/// after what made it stale, else waits for the next one, which every
/// other reader then shares.
#[derive(Default)]
pub(crate) struct SessionSnapshots(Mutex<HashMap<String, SnapshotState>>);

type SharedSummary = Arc<Map<String, Value>>;

/// A flight's Herdr read generation before it starts.
const NOT_STARTED: u64 = u64::MAX;

#[derive(Default)]
struct SnapshotState {
    /// The connection's generation these are of.
    generation: u64,
    kept: Option<Kept>,
    flight: Option<Flight>,
    /// When the last read started.
    last_start: Option<std::time::Instant>,
}

#[derive(Clone)]
struct Flight {
    /// Herdr's read generation when the read started ([`NOT_STARTED`]
    /// while it waits).
    herdr_generation: Arc<std::sync::atomic::AtomicU64>,
    result: Shared<BoxFuture<'static, SharedSummary>>,
}

struct Kept {
    /// Herdr's read generation when its read started.
    herdr_generation: u64,
    /// The clock's monotonic time when its read started.
    at: f64,
    value: SharedSummary,
}

impl SnapshotState {
    fn of<'a>(states: &'a mut HashMap<String, SnapshotState>, lease: &Lease) -> &'a mut Self {
        let state = states.entry(lease.connection_id.clone()).or_default();
        if state.generation != lease.generation {
            *state = SnapshotState {
                generation: lease.generation,
                ..SnapshotState::default()
            };
        }
        state
    }
}

impl SessionSnapshots {
    /// The connection's summary, read after anything Herdr said before
    /// this call came, unless the kept one still holds.
    async fn read(
        &self,
        layer: &Arc<Layer>,
        cx: &FamilyContext,
        lease: &Lease,
        this: &Arc<Self>,
    ) -> SharedSummary {
        use std::sync::atomic::Ordering;
        let herdr = lease.runtime.herdr();
        let arrival = herdr.read_generation();
        loop {
            let (flight, joined) = {
                let mut states = self.0.lock().unwrap();
                let state = SnapshotState::of(&mut states, lease);
                if let Some(kept) = &state.kept
                    && kept.herdr_generation >= arrival
                    && kept.herdr_generation == herdr.read_generation()
                    && layer.clock.monotonic() - kept.at < SNAPSHOT_MAX_AGE_MS
                {
                    return kept.value.clone();
                }
                match &state.flight {
                    Some(flight) => {
                        let started = flight.herdr_generation.load(Ordering::SeqCst);
                        (flight.clone(), started == NOT_STARTED || started >= arrival)
                    }
                    None => {
                        let wait = state
                            .last_start
                            .map(|last| SNAPSHOT_MIN_GAP.saturating_sub(last.elapsed()))
                            .unwrap_or_default();
                        state.last_start = Some(std::time::Instant::now() + wait);
                        let herdr_generation =
                            Arc::new(std::sync::atomic::AtomicU64::new(NOT_STARTED));
                        let task = tokio::spawn(read_snapshot(
                            layer.clone(),
                            cx.clone(),
                            lease.clone(),
                            this.clone(),
                            herdr_generation.clone(),
                            wait,
                        ));
                        let flight = Flight {
                            herdr_generation,
                            result: async move { task.await.unwrap_or_default() }
                                .boxed()
                                .shared(),
                        };
                        state.flight = Some(flight.clone());
                        (flight, true)
                    }
                }
            };
            let value = flight.result.await;
            if joined {
                return value;
            }
        }
    }
}

/// One read of a connection's summary, kept for the next readers.
async fn read_snapshot(
    layer: Arc<Layer>,
    cx: FamilyContext,
    lease: Lease,
    snapshots: Arc<SessionSnapshots>,
    started: Arc<std::sync::atomic::AtomicU64>,
    wait: std::time::Duration,
) -> SharedSummary {
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    let herdr_generation = lease.runtime.herdr().read_generation();
    started.store(herdr_generation, std::sync::atomic::Ordering::SeqCst);
    let at = layer.clock.monotonic();
    let runtime = Summary {
        cx,
        lease: lease.clone(),
    };
    let value =
        Arc::new(read_connection_summary(&lease.connection_id, lease.generation, &runtime).await);
    let mut states = snapshots.0.lock().unwrap();
    // Not kept for a connection connected again meanwhile.
    if let Some(state) = states
        .get_mut(&lease.connection_id)
        .filter(|state| state.generation == lease.generation)
    {
        if state
            .flight
            .as_ref()
            .is_some_and(|flight| Arc::ptr_eq(&flight.herdr_generation, &started))
        {
            state.flight = None;
        }
        if state.kept.as_ref().is_none_or(|kept| kept.at <= at) {
            state.kept = Some(Kept {
                herdr_generation,
                at,
                value: value.clone(),
            });
        }
    }
    value
}

const PANE_INPUT_METHODS: &[&str] = &["pane.send_input", "pane.send_text", "pane.send_keys"];

/// The machine-wide calls; None: not one of them.
pub(crate) async fn bridge(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    socket_id: u64,
    method: &str,
    params: &Value,
) -> Option<Reply> {
    Some(match method {
        "connections.agent_tasks" => Reply::ok(
            agent_tasks(layer, cx, params).await,
            "connections-agent-tasks",
        ),
        "connections.agent_sessions" => match agent_sessions(layer, cx, socket_id, params).await {
            Ok(result) => Reply::ok(result, "connections-agent-sessions"),
            Err(error) => Reply::error(error, "connections-agent-sessions-error"),
        },
        _ => return None,
    })
}

/// A connection's call the families do not declare.
pub(crate) async fn connection(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    mut request: Request,
) -> Reply {
    let method = request.method.clone();
    let lease = match layer.ready(&request.connection_id) {
        Ok(Some(lease)) if lease.generation == request.generation => lease,
        Ok(_) => {
            return Reply::error(
                RpcError::new(CONNECTION_CHANGED_DURING_REQUEST),
                format!("{method}-error"),
            );
        }
        Err(error) => return Reply::error(error, format!("{method}-error")),
    };
    let windows = lease.runtime.remote_platform().is_some();
    if method == "workspace.path"
        || (method == "workspace.create"
            && request
                .params
                .get("cwd")
                .is_some_and(|cwd| !cwd.is_null() && cwd.as_str() != Some("")))
    {
        let checked = match check_path(&lease, &method, &request).await {
            Ok(checked) => checked,
            Err(error) => return Reply::error(error, format!("{method}-error")),
        };
        if method == "workspace.path" {
            return Reply::ok(checked, method);
        }
        if let Some(object) = request.params.as_object_mut() {
            object.insert("cwd".into(), checked);
        }
    }
    let composition = layer
        .runtimes
        .composition(&lease.connection_id, lease.generation);
    // The generation's terminal bridge: its terminals, and what is made
    // from the browser's own terminal.
    if method.starts_with("terminal.")
        || ((method == "tab.create" || method == "workspace.create")
            && request
                .params
                .as_object()
                .is_some_and(|params| params.contains_key("browser_source")))
    {
        let Some(composition) = composition else {
            return Reply::error(
                RpcError::new(CONNECTION_CHANGED_DURING_REQUEST),
                format!("{method}-error"),
            );
        };
        let is_current = request.is_current.clone();
        if method.starts_with("terminal.") {
            return match composition
                .bridge
                .handle_rpc(request.socket_id, &method, &request.params, is_current)
                .await
            {
                Ok(result) => Reply::ok(result, method),
                Err(error) => Reply::error(RpcError::new(error), format!("{method}-error")),
            };
        }
        // The checked directory is checked again right before Herdr is
        // asked.
        let cwd_given = method == "workspace.create"
            && request
                .params
                .get("cwd")
                .is_some_and(|cwd| !cwd.is_null() && cwd.as_str() != Some(""));
        let check = Arc::new(Request {
            method: method.clone(),
            params: request.params.clone(),
            connection_id: request.connection_id.clone(),
            generation: request.generation,
            is_current: request.is_current.clone(),
            socket_id: request.socket_id,
        });
        let checked_lease = lease.clone();
        let validate_path: Arc<
            dyn Fn() -> roamgate_http::terminal::BoxFuture<Result<(), String>> + Send + Sync,
        > = Arc::new(move || {
            let (check, lease) = (check.clone(), checked_lease.clone());
            Box::pin(async move {
                if cwd_given {
                    check_path(&lease, "workspace.create", &check)
                        .await
                        .map_err(|error| error.message)?;
                }
                Ok(())
            })
        });
        return match composition
            .bridge
            .create_from_terminal(
                request.socket_id,
                &method,
                super::composition::object(&request.params),
                is_current,
                validate_path,
            )
            .await
        {
            Ok(result) => Reply::ok(result, method),
            Err(error) => Reply::error(RpcError::new(error), format!("{method}-error")),
        };
    }
    if method == "tab.rename"
        && let Some(composition) = &composition
        && let Some(tab) = text(&request.params, "tab_id")
    {
        composition
            .renamer
            .mark_manual_rename(tab, text(&request.params, "label"));
    }
    if method == "agent.list" {
        return match agent_list(layer, cx, &lease, windows, request.params).await {
            Ok(result) => Reply::ok(result, "agent-list"),
            Err(error) => Reply::error(error, "agent-list-error"),
        };
    }
    if method == "forge.status" || method == "forge.session" {
        if windows {
            return Reply::error(
                RpcError::new(roamgate_workspace::worktree::hooks::unix_only_message(
                    "This operation",
                )),
                "unsupported-windows-operation",
            );
        }
        return match forge(layer, &lease, &method, &request.params).await {
            Ok(result) => Reply::ok(result, "forge"),
            Err(error) => Reply::error(error, "forge-error"),
        };
    }
    if method.starts_with("forward.") {
        let Some(forwards) = layer
            .runtimes
            .forwards(&lease.connection_id, lease.generation)
        else {
            return Reply::error(
                RpcError::new(CONNECTION_CHANGED_DURING_REQUEST),
                format!("{method}-error"),
            );
        };
        return super::forwards::call(&forwards, &method, &request.params, &request.is_current)
            .await;
    }
    if method.starts_with("settings.") {
        return settings(cx, &method, &request.params, &request.is_current).await;
    }
    pass_through(layer, &lease, windows, request).await
}

/// `forge.status` (a request's chip) and `forge.session` (a chat's
/// repositories and their requests): read only, what they say never goes
/// to an agent.
async fn forge(
    layer: &Arc<Layer>,
    lease: &Lease,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let path = text(params, "path")
        .filter(|path| roamgate_git::review::is_host_path(path))
        .unwrap_or("");
    let host = lease.runtime.ssh_host();
    let fresh = params.get("fresh") == Some(&Value::Bool(true));
    let cache = super::forge::forge_cache(layer);
    if method == "forge.status" {
        let reference = roamgate_forge::review::status::parse_forge_ref_param(&params["ref"])
            .ok_or_else(|| RpcError::new("invalid merge request reference"))?;
        return cache
            .status(&super::forge::context(layer, path, host), &reference, fresh)
            .await
            .map_err(RpcError::new);
    }
    let root = if path.is_empty() {
        let runtime = super::super::workspace::ranger_runtime(&lease.connection_id)
            .filter(|runtime| runtime.generation() == lease.generation)
            .ok_or_else(|| {
                RpcError::new(format!("connection not ready: {}", lease.connection_id))
            })?;
        let mut query = serde_json::Map::new();
        if let Some(workspace) = params.get("workspace_id") {
            query.insert("workspace_id".into(), workspace.clone());
        }
        let resolved = runtime.git_root(&Value::Object(query)).await?;
        resolved["root"].as_str().unwrap_or("").to_owned()
    } else {
        path.to_owned()
    };
    let agent_path =
        text(params, "agent_path").filter(|path| roamgate_git::review::is_host_path(path));
    cache
        .session(
            &super::forge::context(layer, &root, host),
            agent_path,
            fresh,
        )
        .await
        .map_err(RpcError::new)
}

/// The settings methods no family declares (bridge/settings-rpc.ts): the
/// agent profiles, on the settings family's writer.
async fn settings(
    cx: &FamilyContext,
    method: &str,
    params: &Value,
    is_current: &IsCurrent,
) -> Reply {
    let fail = |message: String| {
        let message = if is_current() {
            message
        } else {
            CONNECTION_CHANGED_DURING_REQUEST.to_owned()
        };
        Reply::error(RpcError::new(message), format!("{method}-error"))
    };
    if !is_current() {
        return fail(String::new());
    }
    let home = std::env::home_dir().unwrap_or_default();
    let result = match method {
        "settings.profiles.get" => {
            let settings = super::super::settings::read_shared(cx).await;
            roamgate_http::settings::profiles_reply(&settings, &home)
        }
        "settings.profiles.update" => {
            let profiles = match roamgate_http::settings::profiles_update(params) {
                Ok(profiles) => profiles,
                Err(error) => return fail(error),
            };
            let written =
                super::super::settings::update_shared(cx, json!({"method": method}), |current| {
                    Some(current.with("profiles", Some(profiles)))
                })
                .await;
            match written {
                Ok(settings) => roamgate_http::settings::profiles_reply(&settings, &home),
                Err(error) => return fail(error.message),
            }
        }
        "settings.profiles.models" => {
            let name = text(params, "name").unwrap_or("");
            let settings = super::super::settings::read_shared(cx).await;
            let raw = Value::Object(settings.as_map().clone());
            let profiles = roamgate_connections::agent_profiles::store::profiles_of(Some(&raw));
            let list = roamgate_connections::agent_profiles::store::profiles_list(&profiles);
            let Some(profile) =
                roamgate_connections::agent_profiles::shared::profile_named(&list, Some(name))
            else {
                return fail(format!("No profile is named {name}"));
            };
            super::conversation::discovery(cx)
                .models(&profile, params.get("refresh") == Some(&Value::Bool(true)))
                .await
        }
        _ => return fail(format!("unknown settings method: {method}")),
    };
    if !is_current() {
        return fail(String::new());
    }
    Reply::ok(result, method)
}

/// What Bun answered with code a standalone core does not have yet:
/// refused as `standalone_unported`, named in the served log.
pub(crate) fn unported(what: &str, method: &str) -> Reply {
    roamgate_channel::core::note_served(&ProcessEnv, "unported", what);
    Reply::error(
        RpcError::with_code(
            format!("{method} is not served by the standalone core"),
            "standalone_unported",
        ),
        format!("{method}-error"),
    )
}

/// `inspectWorkspacePath` on the connection's host: `workspace.path`'s
/// answer, or the checked `cwd` a creation goes on with.
async fn check_path(lease: &Lease, method: &str, request: &Request) -> Result<Value, RpcError> {
    let runtime = super::super::workspace::ranger_runtime(&lease.connection_id)
        .filter(|runtime| runtime.generation() == lease.generation)
        .ok_or_else(|| RpcError::new(format!("connection not ready: {}", lease.connection_id)))?;
    let path = method == "workspace.path";
    let value = request.params.get(if path { "path" } else { "cwd" });
    let info = roamgate_workspace::path::inspect_workspace_path(
        value,
        runtime.git(),
        runtime.is_windows(),
        path,
    )
    .await
    .map_err(|error| RpcError::new(error.message))?;
    if path {
        return Ok(serde_json::to_value(info).unwrap_or(Value::Null));
    }
    if let Some(error) = &info.error {
        return Err(RpcError::new(format!("{error} {}", info.path)));
    }
    if !(request.is_current)() {
        return Err(RpcError::new(
            "Creation connection changed. Reconnect and retry.",
        ));
    }
    Ok(json!(info.path))
}

/// The seen marks laid over an agent list (`annotateAgentSeen`, the
/// agent_sessions family's).
async fn annotate(
    cx: &FamilyContext,
    connection_id: &str,
    list: Value,
    boot: Option<String>,
) -> Result<Value, RpcError> {
    super::call(
        cx,
        "internal.agent_sessions.annotate",
        json!({"connection_id": connection_id, "result": list, "boot": boot}),
    )
    .await
}

/// `agent.list`: Herdr's agents with their durable activity (Herdr's own
/// list on a Windows host) and the seen marks.
async fn agent_list(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    lease: &Lease,
    windows: bool,
    params: Value,
) -> Result<Value, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    let list = async {
        if windows {
            return lease
                .runtime
                .herdr()
                .call(
                    "agent.list",
                    params.clone(),
                    roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS,
                    None,
                    false,
                )
                .await
                .map_err(RpcError::new);
        }
        // The whole list: the connection's shared summary has it.
        if params.as_object().is_some_and(Map::is_empty) {
            let snapshot = layer
                .session_snapshots
                .read(layer, cx, lease, &layer.session_snapshots)
                .await;
            if let Some(agents) = snapshot.get("agents").filter(|agents| !agents.is_null()) {
                return Ok(agents.clone());
            }
        }
        let (readers, _) =
            super::super::agent_sessions::owned_readers(cx, &lease.connection_id).await?;
        readers
            .list_with_activity(params.clone())
            .await
            .map_err(|error| RpcError::new(error.message))
    };
    let (list, boot) = tokio::join!(list, layer.herdr_boot(lease, false));
    annotate(cx, &lease.connection_id, list?, boot).await
}

/// `connections.agent_tasks`: the side tasks of agents on any connection,
/// in one batch.
async fn agent_tasks(layer: &Arc<Layer>, cx: &FamilyContext, params: &Value) -> Value {
    let params = if params.is_null() {
        json!({})
    } else {
        params.clone()
    };
    read_connection_agent_tasks(
        |id| {
            let lease = layer.ready(id).ok().flatten()?;
            Some(Arc::new(Tasks {
                cx: cx.clone(),
                connection_id: id.to_owned(),
                windows: lease.runtime.remote_platform().is_some(),
            }))
        },
        &params,
    )
    .await
}

struct Tasks {
    cx: FamilyContext,
    connection_id: String,
    windows: bool,
}

impl TasksRuntime for Tasks {
    fn read_tasks(&self, params: Value) -> roamgate_connections::BoxFuture<Result<Value, String>> {
        let cx = self.cx.clone();
        let id = self.connection_id.clone();
        Box::pin(async move {
            let (readers, _) = super::super::agent_sessions::owned_readers(&cx, &id)
                .await
                .map_err(|error| error.message)?;
            readers
                .read_tasks(&params)
                .await
                .map_err(|error| error.message)
        })
    }

    fn remote_platform(&self) -> Option<String> {
        self.windows.then(|| "windows".to_owned())
    }
}

/// A connection's runtime as the agent summaries read it.
struct Summary {
    cx: FamilyContext,
    lease: Lease,
}

impl SummaryRuntime for Summary {
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> roamgate_connections::BoxFuture<Result<Value, String>> {
        let lease = self.lease.clone();
        let method = method.to_owned();
        Box::pin(async move {
            lease
                .runtime
                .herdr()
                .call(&method, params, timeout_ms, None, false)
                .await
        })
    }

    fn remote_platform(&self) -> Option<String> {
        self.lease
            .runtime
            .remote_platform()
            .map(|_| "windows".to_owned())
    }

    fn enrich_worktree_parents(
        &self,
        result: Value,
    ) -> Option<roamgate_connections::BoxFuture<Result<Value, String>>> {
        let runtime = super::super::workspace::tree_runtime(&self.lease.connection_id)?;
        Some(Box::pin(async move {
            Ok(runtime.enrich_worktree_parents(result).await)
        }))
    }

    fn enrich_git_status(
        &self,
        result: Value,
    ) -> roamgate_connections::BoxFuture<Result<Value, String>> {
        let runtime = super::super::workspace::tree_runtime(&self.lease.connection_id);
        Box::pin(async move {
            Ok(match runtime {
                Some(runtime) => runtime.enrich_git_status(result).await,
                None => result,
            })
        })
    }

    fn list_with_activity(
        &self,
        params: Value,
    ) -> roamgate_connections::BoxFuture<Result<Value, String>> {
        let cx = self.cx.clone();
        let id = self.lease.connection_id.clone();
        Box::pin(async move {
            let (readers, _) = super::super::agent_sessions::owned_readers(&cx, &id)
                .await
                .map_err(|error| error.message)?;
            readers
                .list_with_activity(params)
                .await
                .map_err(|error| error.message)
        })
    }
}

/// `connections.agent_sessions`: every ready connection's lists, their
/// agents with the seen marks; the stamp alone when the socket holds this
/// version, or its changes from the version it holds.
async fn agent_sessions(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    socket_id: u64,
    params: &Value,
) -> Result<Value, RpcError> {
    let manager = layer
        .host
        .manager_now()
        .ok_or_else(|| RpcError::new("the connections are not started"))?;
    // Each ready connection's summary, shared by every browser; those
    // still current once read.
    let snapshots = &layer.session_snapshots;
    let manager = &manager;
    let reads = manager.list().into_iter().map(|connection| async move {
        let lease = manager.ready_runtime_lease(&connection.id).ok().flatten()?;
        let snapshot = snapshots.read(layer, cx, &lease, snapshots).await;
        Some((lease, snapshot))
    });
    let snapshots: Vec<SharedSummary> = futures_util::future::join_all(reads)
        .await
        .into_iter()
        .flatten()
        .filter(|(lease, _)| lease.is_current())
        .map(|(_, snapshot)| snapshot)
        .collect();
    let reads = snapshots.into_iter().map(|snapshot| async move {
        let agents = match snapshot.get("agents") {
            Some(agents) if truthy(agents) => agents.clone(),
            _ => return Ok(Value::Object((*snapshot).clone())),
        };
        let id = snapshot
            .get("connection_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let boot = match layer.ready(&id).ok().flatten() {
            Some(lease) => layer.herdr_boot(&lease, false).await,
            None => None,
        };
        let agents = annotate(cx, &id, agents, boot).await?;
        let mut snapshot = (*snapshot).clone();
        snapshot.insert("agents".into(), agents);
        Ok::<Value, RpcError>(Value::Object(snapshot))
    });
    let connections = futures_util::future::try_join_all(reads).await?;
    let result = json!({ "connections": connections });
    let version = roamgate_review::list_since::stamp(&result);
    let since = params.get("since");
    let base = {
        let mut kept = layer.session_versions.0.lock().unwrap();
        let entry = kept.entry(socket_id).or_default();
        let base = since
            .and_then(Value::as_str)
            .and_then(|since| entry.iter().find(|(stamp, _)| stamp == since))
            .cloned();
        entry.retain(|(stamp, _)| *stamp != version);
        entry.insert(0, (version.clone(), result.clone()));
        entry.truncate(2);
        base
    };
    if since.and_then(Value::as_str) == Some(version.as_str()) {
        return Ok(json!({"unchanged": true, "version": version}));
    }
    let empty = Map::new();
    let delta = base
        .as_ref()
        .filter(|(stamp, _)| *stamp != version)
        .and_then(|(_, before)| {
            roamgate_protocol::state_delta::diff_state(
                before.as_object().unwrap_or(&empty),
                result.as_object().unwrap_or(&empty),
            )
        });
    if let (Some(delta), Some((stamp, _))) = (delta, base) {
        return Ok(json!({"sessions_delta": delta, "base": stamp, "version": version}));
    }
    let mut whole = result.as_object().cloned().unwrap_or_default();
    whole.insert("version".into(), json!(version));
    Ok(Value::Object(whole))
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// The user's input through the pane API (the composer, a paste, words
/// said to the session on screen): a turn they start when it submits.
fn note_pane_input(connection_id: &str, pane_id: &str, params: &Value) {
    let keys: Vec<&Value> = match params.get("keys") {
        Some(Value::Array(keys)) => keys.iter().collect(),
        Some(key) => vec![key],
        None => vec![&Value::Null],
    };
    let submits = params
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.ends_with('\r') || text.ends_with('\n'))
        || keys.iter().any(|key| {
            key.as_str()
                .is_some_and(|key| key.eq_ignore_ascii_case("enter"))
        });
    if submits {
        super::super::voice::note_turn_cause(
            connection_id,
            pane_id,
            &json!({"by": "user", "via": "terminal"}),
        );
    } else {
        super::super::voice::note_user_turn(connection_id, pane_id);
    }
}

/// What a workspace list adds of the connection's terminals: how the
/// browser navigates (`browser-local` on an endpoint Herdr), whether tabs
/// move, and the endpoint sessions attached (the terminal bridge's).
async fn terminal_modes(layer: &Layer, lease: &Lease) -> Result<Map<String, Value>, RpcError> {
    let bridge = layer
        .runtimes
        .composition(&lease.connection_id, lease.generation)
        .map(|composition| composition.bridge.clone())
        .ok_or_else(|| RpcError::new(CONNECTION_CHANGED_DURING_REQUEST))?;
    let mut modes = Map::new();
    modes.insert(
        "navigation_mode".into(),
        json!(bridge.navigation_mode().await.map_err(RpcError::new)?),
    );
    modes.insert(
        "tab_move_supported".into(),
        json!(bridge.tab_move_supported().await.map_err(RpcError::new)?),
    );
    modes.insert(
        "endpoint_availability".into(),
        bridge.endpoint_availability(),
    );
    Ok(modes)
}

/// Herdr's own methods with what Bun laid over them.
async fn pass_through(layer: &Arc<Layer>, lease: &Lease, windows: bool, request: Request) -> Reply {
    let method = request.method.as_str();
    let id = lease.connection_id.as_str();
    let pane = if PANE_INPUT_METHODS.contains(&method) {
        text(&request.params, "pane_id").map(str::to_owned)
    } else {
        None
    };
    let mirror = layer.mirror(id);
    // While Claude exits for conversation mode (or the holder resumes it),
    // text would land in the dying TUI or the bare shell.
    if let Some(pane) = &pane
        && let Some(refusal) = mirror["refusals"].get(pane).and_then(Value::as_str)
    {
        return Reply::error(RpcError::new(refusal), "pane-input-refused");
    }
    // The recipient is known before input can make a clipboard write.
    let input_terminal = match &pane {
        Some(pane) => lease
            .runtime
            .herdr()
            .call("pane.get", json!({"pane_id": pane}), 2000, None, false)
            .await
            .ok()
            .and_then(|result| result["pane"]["terminal_id"].as_str().map(str::to_owned)),
        None => None,
    };
    let composition = layer
        .runtimes
        .composition(&lease.connection_id, lease.generation);
    let before_send: Option<roamgate_herdr::control::BeforeSend> =
        if PANE_INPUT_METHODS.contains(&method) {
            let is_current = request.is_current.clone();
            let connection = id.to_owned();
            let params = request.params.clone();
            let socket = request.socket_id;
            Some(Box::new(move || {
                if !is_current() {
                    return Err(CONNECTION_CHANGED_DURING_REQUEST.to_owned());
                }
                if let (Some(terminal), Some(composition)) = (&input_terminal, &composition) {
                    composition.bridge.note_terminal_input(socket, terminal);
                }
                if let Some(pane) = &pane {
                    note_pane_input(&connection, pane, &params);
                }
                Ok(())
            }))
        } else {
            None
        };
    let params = if request.params.is_null() {
        json!({})
    } else {
        request.params.clone()
    };
    let result = match layer
        .agent_herdr_call(lease, method, params, None, before_send)
        .await
    {
        Ok(result) => result,
        Err(error) => return Reply::error(RpcError::new(error), format!("{method}-error")),
    };
    // The conversations stopped as shell jobs (Ctrl+Z), on their panes.
    let suspended = mirror["suspended"].as_array().cloned().unwrap_or_default();
    let mut result =
        roamgate_agents::owned_panes::overlay_suspended_panes(method, result, &suspended);
    if method == "integration.list" && !windows {
        result = integration_versions(layer, lease, result).await;
    }
    if method == "workspace.list" {
        if !windows && let Some(runtime) = super::super::workspace::tree_runtime(id) {
            result = runtime.enrich_worktree_parents(result).await;
            result = runtime.enrich_git_status(result).await;
        }
        let modes = match terminal_modes(layer, lease).await {
            Ok(modes) => modes,
            Err(error) => return Reply::error(error, format!("{method}-error")),
        };
        if let Some(object) = result.as_object_mut() {
            object.extend(modes);
        } else {
            result = Value::Object(modes);
        }
    }
    Reply::ok(result, method)
}

/// `enrichIntegrationVersions` on the connection's host: over SSH through
/// the core's session slots, else this machine's herdr.
async fn integration_versions(layer: &Arc<Layer>, lease: &Lease, result: Value) -> Value {
    let host = lease.runtime.ssh_host().map(str::to_owned);
    let ping = async {
        lease
            .runtime
            .herdr()
            .call("ping", json!({}), 5_000, None, false)
            .await
    };
    let binary = || {
        let env = ProcessEnv;
        use roamgate_base::env::Env;
        let home = std::env::home_dir().unwrap_or_default();
        roamgate_herdr::bootstrap::find_herdr_binary(&roamgate_herdr::bootstrap::Locations {
            platform: if cfg!(windows) {
                "win32".into()
            } else if cfg!(target_os = "macos") {
                "darwin".into()
            } else {
                "linux".into()
            },
            home,
            app_data: env.var("APPDATA").map(std::path::PathBuf::from),
            path_env: env.var("PATH").unwrap_or_default(),
        })
    };
    let run = |run: CliRun| {
        let layer = layer.clone();
        let host = host.clone();
        let connection = lease.connection_id.clone();
        async move {
            match run {
                CliRun::Ssh => {
                    let host = host.ok_or_else(|| "no SSH host".to_owned())?;
                    let command = format!(
                        "bash -lc {}",
                        roamgate_exec::quote::shell_quote(SSH_STATUS_COMMAND)
                    );
                    let ran = run_ssh(
                        &layer,
                        &host,
                        &command,
                        SshRun {
                            read: true,
                            tag: "herdr integration status",
                            connection: Some(&connection),
                            stdin: None,
                            timeout_ms: CLI_TIMEOUT_MS,
                            lane: roamgate_exec::lanes::current_lane(),
                        },
                    )
                    .await?;
                    Ok((ran.code, String::from_utf8_lossy(&ran.stdout).into_owned()))
                }
                CliRun::Local(argv) => run_local(&layer, argv, CLI_TIMEOUT_MS, None)
                    .await
                    .map(|(code, stdout, _)| (code, stdout)),
            }
        }
    };
    enrich_integration_versions(result, host.is_some(), ping, binary, run).await
}
