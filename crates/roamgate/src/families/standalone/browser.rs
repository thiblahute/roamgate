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

use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_connections::agent_summaries::{
    SummaryRuntime, TasksRuntime, read_connection_agent_sessions_with, read_connection_agent_tasks,
};
use roamgate_connections::routing::CONNECTION_CHANGED_DURING_REQUEST;
use roamgate_herdr::integration_versions::{
    CLI_TIMEOUT_MS, CliRun, SSH_STATUS_COMMAND, enrich_integration_versions,
};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
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
}

/// The `connections.agent_sessions` answers each socket was given (two).
#[derive(Default)]
pub(crate) struct SessionVersions(Mutex<HashMap<u64, Vec<(String, Value)>>>);

impl SessionVersions {
    pub(crate) fn socket_closed(&self, socket_id: u64) {
        self.0.lock().unwrap().remove(&socket_id);
    }
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
    // A terminal or workspace made from the browser's own terminal: the
    // terminal bridge's (not built here yet).
    if (method == "tab.create" || method == "workspace.create")
        && request
            .params
            .as_object()
            .is_some_and(|params| params.contains_key("browser_source"))
    {
        return unported(&format!("{method} browser_source"), &method);
    }
    if method == "agent.list" {
        return match agent_list(layer, cx, &lease, windows, request.params).await {
            Ok(result) => Reply::ok(result, "agent-list"),
            Err(error) => Reply::error(error, "agent-list-error"),
        };
    }
    pass_through(layer, &lease, windows, request).await
}

/// What Bun answered with code a standalone core does not have yet:
/// refused as `standalone_unported`, named in the served log.
pub(crate) fn unported(what: &str, method: &str) -> Reply {
    roamgate_sidecar::core::note_served(&ProcessEnv, "unported", what);
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
    let summary_cx = cx.clone();
    let sessions = read_connection_agent_sessions_with(&manager, |lease| {
        Arc::new(Summary {
            cx: summary_cx.clone(),
            lease: lease.clone(),
        }) as Arc<dyn SummaryRuntime>
    })
    .await;
    let snapshots = sessions["connections"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let reads = snapshots.into_iter().map(|snapshot| async move {
        let agents = match snapshot.get("agents") {
            Some(agents) if truthy(agents) => agents.clone(),
            _ => return Ok(snapshot),
        };
        let id = text(&snapshot, "connection_id").unwrap_or("").to_owned();
        let boot = match layer.ready(&id).ok().flatten() {
            Some(lease) => layer.herdr_boot(&lease, false).await,
            None => None,
        };
        let agents = annotate(cx, &id, agents, boot).await?;
        let mut snapshot = snapshot;
        if let Some(object) = snapshot.as_object_mut() {
            object.insert("agents".into(), agents);
        }
        Ok::<Value, RpcError>(snapshot)
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

/// The connection's Herdr protocol, read once per generation (the
/// terminal bridge's `bridgeProtocol`), refused when unsupported.
async fn herdr_protocol(layer: &Layer, lease: &Lease) -> Result<i64, RpcError> {
    let key = lease.connection_id.clone();
    if let Some((generation, protocol)) = layer.protocols.lock().unwrap().get(&key)
        && *generation == lease.generation
    {
        return Ok(*protocol);
    }
    let ping = lease
        .runtime
        .herdr()
        .call("ping", json!({}), 5_000, None, false)
        .await
        .map_err(RpcError::new)?;
    let protocol = ping.get("protocol").cloned().unwrap_or(Value::Null);
    roamgate_herdr::protocol::assert_supported_herdr_protocol(&protocol).map_err(RpcError::new)?;
    let protocol = protocol.as_i64().unwrap_or_default();
    layer
        .protocols
        .lock()
        .unwrap()
        .insert(key, (lease.generation, protocol));
    Ok(protocol)
}

/// What a workspace list adds of the connection's terminals: how the
/// browser navigates (`browser-local` on an endpoint Herdr), whether tabs
/// move, and the endpoint sessions open (the terminal bridge's).
async fn terminal_modes(layer: &Layer, lease: &Lease) -> Result<Map<String, Value>, RpcError> {
    let protocol = herdr_protocol(layer, lease).await?;
    let local = roamgate_herdr::thin::is_terminal_hello_protocol(protocol)
        && roamgate_env(&ProcessEnv, "DISABLE_ENDPOINT").as_deref() != Some("1");
    let mut modes = Map::new();
    modes.insert(
        "navigation_mode".into(),
        json!(if local { "browser-local" } else { "shared" }),
    );
    modes.insert(
        "tab_move_supported".into(),
        json!(
            roamgate_herdr::protocol::is_supported_herdr_protocol(&json!(protocol))
                && protocol >= 16
        ),
    );
    // The terminal bridge's endpoint sessions: none built here yet.
    modes.insert("endpoint_availability".into(), json!({}));
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
    let before_send: Option<roamgate_herdr::control::BeforeSend> =
        if PANE_INPUT_METHODS.contains(&method) {
            let is_current = request.is_current.clone();
            let connection = id.to_owned();
            let params = request.params.clone();
            Some(Box::new(move || {
                if !is_current() {
                    return Err(CONNECTION_CHANGED_DURING_REQUEST.to_owned());
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
