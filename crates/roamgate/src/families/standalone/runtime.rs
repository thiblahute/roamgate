//! Each connection generation's layer that Bun built on the host family's
//! runtime (index.ts `hostReverseTargets`, runtime.ts `hostEvents`,
//! `onConnectionStatus`), as far as it fed the core's other families: the
//! workspace family's runtime (`internal.workspace.runtime_start`, its
//! events in order, `runtime_stop`), conversation mode (`attach`, a closed
//! pane, a sweep after each subscription start), the activity log's
//! signals, the usage limit resumer's pokes, the notifications a pane's
//! events withdraw, Ranger's connection table and resume, the claude start
//! hook, and the browsers' events. The terminal bridge, task events, Last
//! steps' tab renamer, forwards and review agents are not built here yet.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::log::RecoveryReporter;
use roamgate_connections::routing::serialize_herdr_event_envelope;
use roamgate_conversation::herdr::{CloseEvent, conversation_close_event};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::{Layer, Target, call, fields, logger, tell, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("host.runtime_start", |layer, cx, args| {
        Box::pin(async move { runtime_start(&layer, &cx, &args) })
    }),
    ("host.runtime_stop", |layer, cx, args| {
        Box::pin(async move { runtime_stop(&layer, &cx, &args).await })
    }),
    ("host.events", |layer, cx, args| {
        Box::pin(async move { host_events(&layer, &cx, &args).await })
    }),
    ("host.status", |layer, cx, args| {
        Box::pin(async move { host_status(&layer, &cx, &args).await })
    }),
    // The review agents' sockets over the master are the composition
    // root's (a later package); nothing else hears of a master.
    ("host.master_ready", |_, _, _| {
        Box::pin(async { Ok(json!({"ok": true})) })
    }),
];

/// How long a runtime's stop waits for the core's workspace part
/// (workspace/front.ts CORE_STOP_MS).
const CORE_STOP: Duration = Duration::from_secs(5);

/// The current generations, by connection.
#[derive(Default)]
pub(crate) struct Runtimes {
    current: Mutex<HashMap<String, Generation>>,
    /// Each connection's failures and the generation last logged ready.
    statuses: Mutex<HashMap<String, ConnectionLog>>,
}

impl Runtimes {
    /// Each connection's current generation.
    pub(super) fn generations(&self) -> Vec<(String, u64)> {
        self.current
            .lock()
            .unwrap()
            .iter()
            .map(|(id, runtime)| (id.clone(), runtime.generation))
            .collect()
    }
}

/// One generation's layer.
struct Generation {
    generation: u64,
    /// The workspace part's ops, in order.
    workspace: mpsc::UnboundedSender<WorkspaceOp>,
    /// When each agent status listing started, by its number.
    lists: HashMap<i64, i64>,
}

enum WorkspaceOp {
    Events(Vec<Value>),
    Stop(oneshot::Sender<()>),
}

/// What the log said of a connection (onConnectionStatus).
struct ConnectionLog {
    failures: RecoveryReporter,
    ready_generation: Option<u64>,
}

fn ids(args: &Value) -> Result<(String, u64), RpcError> {
    match (
        text(args, "connection_id"),
        args.get("generation").and_then(Value::as_u64),
    ) {
        (Some(id), Some(generation)) => Ok((id.to_owned(), generation)),
        _ => Err(RpcError::new("needs a connection_id and a generation")),
    }
}

/// The workspace part of a generation, one op at a time: the core takes
/// the runtime first, then its events, batched as they queue.
async fn workspace_part(
    cx: FamilyContext,
    id: String,
    generation: u64,
    start: Value,
    mut ops: mpsc::UnboundedReceiver<WorkspaceOp>,
) {
    let log = logger(&cx.clock, "bridge");
    let started = match call(&cx, "internal.workspace.runtime_start", start).await {
        Ok(_) => true,
        Err(error) => {
            log.warn(
                "the core did not take a workspace runtime",
                Some(&fields(json!({"connection": id, "error": error.message}))),
            );
            false
        }
    };
    while let Some(op) = ops.recv().await {
        let mut events = Vec::new();
        let mut stop = None;
        match op {
            WorkspaceOp::Events(batch) => events.extend(batch),
            WorkspaceOp::Stop(done) => stop = Some(done),
        }
        while stop.is_none()
            && let Ok(next) = ops.try_recv()
        {
            match next {
                WorkspaceOp::Events(batch) => events.extend(batch),
                WorkspaceOp::Stop(done) => stop = Some(done),
            }
        }
        if started && !events.is_empty() {
            let params = json!({"connection_id": id, "generation": generation, "events": events});
            if let Err(error) = call(&cx, "internal.workspace.events", params).await {
                log.warn(
                    "workspace events did not reach the core",
                    Some(&fields(json!({"connection": id, "error": error.message}))),
                );
            }
        }
        if let Some(done) = stop {
            if started {
                let params = json!({"connection_id": id, "generation": generation});
                let _ = tokio::time::timeout(
                    CORE_STOP,
                    call(&cx, "internal.workspace.runtime_stop", params),
                )
                .await;
            }
            let _ = done.send(());
            return;
        }
    }
}

/// `host.runtime_start`: the generation's layer. The core's conversation
/// mode reads again what the holders run; the workspace family takes the
/// runtime (startBackground's `workspaceLink.ready()`).
fn runtime_start(layer: &Layer, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let (id, generation) = ids(args)?;
    let config = args.get("config").filter(|config| config.is_object());
    if args
        .get("identity")
        .and_then(|identity| identity.get("id"))
        .and_then(Value::as_str)
        != Some(id.as_str())
        || config.is_none()
    {
        return Err(RpcError::new(
            "host.runtime_start needs an identity and a config",
        ));
    }
    let config = config.cloned().unwrap_or_default();
    tell(
        cx,
        "internal.conversation.attach",
        json!({"connection_id": id}),
    );
    let (sender, ops) = mpsc::unbounded_channel();
    let start = json!({
        "connection_id": id,
        "generation": generation,
        "ssh_host": config.get("sshHost").filter(|host| host.is_string()),
        "remote_platform": config.get("remotePlatform").filter(|platform| platform.is_string()),
    });
    tokio::spawn(workspace_part(
        cx.clone(),
        id.clone(),
        generation,
        start,
        ops,
    ));
    let previous = layer.runtimes.current.lock().unwrap().insert(
        id,
        Generation {
            generation,
            workspace: sender,
            lists: HashMap::new(),
        },
    );
    if let Some(previous) = previous {
        let (done, _) = oneshot::channel();
        let _ = previous.workspace.send(WorkspaceOp::Stop(done));
    }
    Ok(json!({"ok": true}))
}

/// `host.runtime_stop`: the generation's layer goes, the core's workspace
/// part of it with it (5 s at most).
async fn runtime_stop(layer: &Layer, _cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let (id, generation) = ids(args)?;
    let gone = {
        let mut current = layer.runtimes.current.lock().unwrap();
        match current.get(&id) {
            Some(each) if each.generation == generation => current.remove(&id),
            _ => None,
        }
    };
    if let Some(gone) = gone {
        let (done, stopped) = oneshot::channel();
        if gone.workspace.send(WorkspaceOp::Stop(done)).is_ok() {
            let _ = tokio::time::timeout(CORE_STOP * 2, stopped).await;
        }
    }
    Ok(json!({"ok": true}))
}

/// The activity log reads these Herdr events (activity/front.ts
/// `recordedHerdrEvent`).
fn recorded(name: &str) -> bool {
    let name = name.replace('_', ".");
    name.starts_with("pane.agent.")
        || matches!(
            name.as_str(),
            "pane.closed" | "pane.exited" | "pane.moved" | "pane.focused"
        )
        || name.starts_with("workspace.")
        || name.starts_with("worktree.")
}

/// index.ts `withdrawPaneNotifications`: an agent no longer blocked, or a
/// pane gone, takes its notifications with it.
fn withdraw_notifications(cx: &FamilyContext, id: &str, name: &str, event: &Value) {
    let name = name.replace('_', ".");
    let data = &event["data"];
    let Some(pane) = text(data, "pane_id").filter(|pane| !pane.is_empty()) else {
        return;
    };
    let method = if name == "pane.agent.status.changed" {
        if data["agent_status"] == "blocked" {
            return;
        }
        "internal.notifications.clear_blocked_pane"
    } else if name == "pane.closed" || name == "pane.exited" {
        "internal.notifications.clear_pane"
    } else {
        return;
    };
    tell(cx, method, json!({"connection_id": id, "pane_id": pane}));
}

/// A terminal agent's status changed: it may have stopped on a limit
/// (index.ts `pokeLimitResumer`).
fn poke_limit_resumer(cx: &FamilyContext, id: &str, name: &str, event: &Value) {
    if !matches!(
        name,
        "pane.agent_status_changed" | "pane.agent_detected" | "pane.exited" | "pane.closed"
    ) {
        return;
    }
    poke_limit(cx, id, text(&event["data"], "pane_id"));
}

/// The usage limit resumer looks shortly (index.ts `pokeLimit`).
pub(super) fn poke_limit(cx: &FamilyContext, id: &str, pane: Option<&str>) {
    let mut params = json!({"connection_id": id});
    if let Some(pane) = pane {
        params["pane_id"] = json!(pane);
    }
    tell(cx, "internal.limit_resume.poke", params);
}

/// What a generation's subscriptions saw (runtime.ts `hostEvents`, then
/// its `onHerdrEvent` and index.ts `onEvent`), for the current generation
/// only.
async fn host_events(layer: &Layer, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let signals = take_events(layer, cx, args)?;
    // In order with the next ones (one `host.events` at a time).
    if !signals.is_empty() {
        let _ = call(cx, "internal.activity.signals", json!({"signals": signals})).await;
    }
    Ok(json!({"ok": true}))
}

/// [`host_events`]' work, the activity signals it makes.
fn take_events(layer: &Layer, cx: &FamilyContext, args: &Value) -> Result<Vec<Value>, RpcError> {
    let (id, generation) = ids(args)?;
    let events = args
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::new("host.events needs events"))?;
    let mut current = layer.runtimes.current.lock().unwrap();
    let Some(runtime) = current
        .get_mut(&id)
        .filter(|runtime| runtime.generation == generation)
    else {
        return Ok(Vec::new());
    };
    let mut workspace = Vec::new();
    let mut signals = Vec::new();
    let now = cx.clock.now();
    let on_event = |event: &Value, signals: &mut Vec<Value>| {
        let name = roamgate_connections::agent_status::herdr_event_name(event).unwrap_or_default();
        withdraw_notifications(cx, &id, &name, event);
        poke_limit_resumer(cx, &id, &name, event);
        if recorded(&name) {
            signals.push(json!({
                "op": "herdr_event",
                "ts": now,
                "connection_id": id,
                "event": event,
            }));
        }
        match serialize_herdr_event_envelope(&id, event, Some(generation)) {
            Ok(line) => layer.clients.broadcast(&line, "event", None),
            Err(error) => tracing::warn!(
                scope = "bridge",
                connection = id.as_str(),
                "dropped invalid Herdr event: {error}"
            ),
        }
    };
    for each in events {
        match text(each, "kind") {
            Some("herdr") => {
                let event = &each["event"];
                // A closed pane takes its conversation lease (and process)
                // with it.
                match conversation_close_event(event) {
                    Some(CloseEvent::Pane(pane)) => tell(
                        cx,
                        "internal.conversation.pane_closed",
                        json!({"connection_id": id, "pane_id": pane}),
                    ),
                    Some(CloseEvent::Sweep) => tell(
                        cx,
                        "internal.conversation.sweep",
                        json!({"connection_id": id}),
                    ),
                    None => {}
                }
                workspace.push(json!({"kind": "herdr", "event": event}));
                on_event(event, &mut signals);
            }
            Some("ready") => {
                // Browser snapshots may start before the subscription's
                // ACK: they reconcile after each one.
                on_event(
                    &json!({"event": "session.resync_required", "data": {}}),
                    &mut signals,
                );
                // Panes closed while no event could come.
                tell(
                    cx,
                    "internal.conversation.sweep",
                    json!({"connection_id": id}),
                );
            }
            Some("pane_list_start") => {
                let Some(list) = each.get("list").and_then(Value::as_i64) else {
                    continue;
                };
                // A listing that never ends leaves no trace.
                if runtime.lists.len() > 32 {
                    runtime.lists.clear();
                }
                runtime.lists.insert(
                    list,
                    each.get("started_at")
                        .and_then(Value::as_i64)
                        .unwrap_or(now),
                );
                workspace.push(json!({"kind": "pane_list_start", "list": list}));
            }
            Some("pane_list") => {
                let Some(list) = each.get("list").and_then(Value::as_i64) else {
                    continue;
                };
                let Some(started_at) = runtime.lists.remove(&list) else {
                    continue;
                };
                let result = each.get("result").cloned().unwrap_or(Value::Null);
                workspace.push(json!({"kind": "pane_list", "list": list, "result": result}));
                signals.push(json!({
                    "op": "pane_list",
                    "ts": now,
                    "connection_id": id,
                    "result": result,
                    "started_at": started_at,
                }));
            }
            _ => {}
        }
    }
    if !workspace.is_empty() {
        let _ = runtime.workspace.send(WorkspaceOp::Events(workspace));
    }
    Ok(signals)
}

/// The review family's agents (index.ts `sendReviewAgents`): which
/// connections' agents can use the review client, the Claude mods' tools,
/// and the sockets it listens on. This machine's socket is the core's
/// (Unix only); an SSH host's, over its master, comes with the
/// composition root, so its agents have no channel yet. Told when it
/// changed, after each status change and every second.
pub(crate) fn send_review_agents(layer: &Arc<Layer>, cx: &FamilyContext) {
    let local = !cfg!(windows);
    let mut channels = serde_json::Map::new();
    if let Some(manager) = layer.host.manager_now() {
        for status in manager.list() {
            let channel = manager.ready_runtime(&status.id).is_some_and(|runtime| {
                runtime.remote_platform().is_none() && runtime.ssh_host().is_none() && local
            });
            channels.insert(status.id, json!(channel));
        }
    }
    let tools = super::super::claude_mod::current()
        .map(|hub| hub.tools_state())
        .unwrap_or_default();
    let keys: Vec<&str> = if local {
        vec![roamgate_review::agent_socket::LOCAL_SOCKET_KEY]
    } else {
        Vec::new()
    };
    let agents = json!({"channels": channels, "tools": tools, "socket_keys": keys});
    let state = agents.to_string();
    {
        let mut sent = layer.review_agents.lock().unwrap();
        if *sent == state {
            return;
        }
        *sent = state;
    }
    let (layer, cx) = (layer.clone(), cx.clone());
    tokio::spawn(async move {
        if call(&cx, "internal.review.agents", agents).await.is_err() {
            layer.review_agents.lock().unwrap().clear();
        }
    });
}

/// [`send_review_agents`] every second, from the server's start on.
pub(crate) fn start_review_agents(layer: &Arc<Layer>, cx: &FamilyContext) {
    let (layer, cx) = (layer.clone(), cx.clone());
    tokio::spawn(async move {
        loop {
            send_review_agents(&layer, &cx);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

/// `host.status`: a connection's status changed (index.ts
/// `onConnectionStatus`): Ranger's table, the activity log, the log, and
/// once ready the claude start hook and Ranger's recovery.
async fn host_status(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    args: &Value,
) -> Result<Value, RpcError> {
    if !args.get("connections").is_some_and(Value::is_array) {
        return Err(RpcError::new("host.status needs connections"));
    }
    let Some(status) = args.get("status").filter(|status| status.is_object()) else {
        return Ok(json!({"ok": true}));
    };
    let Some(id) = text(status, "id") else {
        return Ok(json!({"ok": true}));
    };
    let state = text(status, "state").unwrap_or_default();
    // In order with the next status change (one `host.status` at a time).
    let _ = call(
        cx,
        "internal.assistant.connections",
        json!({"connections": super::assistant::connections(layer)}),
    )
    .await;
    send_review_agents(layer, cx);
    let _ = call(
        cx,
        "internal.activity.signals",
        json!({"signals": [{
            "op": "connection_status",
            "ts": cx.clock.now(),
            "connection_id": id,
            "state": state,
        }]}),
    )
    .await;
    if connection_status(layer, cx, id, state, status) {
        tell(cx, "internal.assistant.resume", json!({}));
        let (layer, cx, id) = (layer.clone(), cx.clone(), id.to_owned());
        tokio::spawn(async move { ensure_claude_start_hook(&layer, &cx, &id).await });
    }
    Ok(json!({"ok": true}))
}

/// The log of a status change: a failure once per run of equal ones, a
/// recovery, a new generation ready. True once the connection is ready.
fn connection_status(
    layer: &Layer,
    cx: &FamilyContext,
    id: &str,
    state: &str,
    status: &Value,
) -> bool {
    let generation = status["generation"].as_u64().unwrap_or(0);
    let mut log_fields = roamgate_base::log::LogFields::new();
    log_fields.insert("connection".into(), id.into());
    log_fields.insert("state".into(), state.into());
    log_fields.insert("generation".into(), generation.into());
    let log = logger(&cx.clock, "bridge");
    let mut debug = log_fields.clone();
    if let Some(error) = status["error"]["message"].as_str() {
        debug.insert("error".into(), error.into());
    }
    log.debug("connection status", Some(&debug));
    let mut statuses = layer.runtimes.statuses.lock().unwrap();
    let entry = statuses.entry(id.to_owned()).or_insert_with(|| {
        let clock = cx.clock.clone();
        ConnectionLog {
            failures: RecoveryReporter::new(
                log.child("connections"),
                "connection degraded",
                "connection recovered",
                Arc::new(move || clock.now()),
            ),
            ready_generation: None,
        }
    });
    if matches!(state, "error" | "reconnecting")
        && let Some(error) = status["error"]["message"].as_str()
    {
        entry.failures.failure(error, Some(&log_fields));
        return false;
    }
    if state != "ready" {
        return false;
    }
    if entry.failures.recovered(Some(&log_fields)) {
        entry.ready_generation = Some(generation);
    } else if entry.ready_generation != Some(generation) {
        entry.ready_generation = Some(generation);
        log.info("connection ready", Some(&log_fields));
    }
    true
}

/// index.ts `ensureClaudeStartHook`: once per host and run, Claude's
/// settings get the hook that hands a `claude` started in a terminal to
/// conversation mode, while the setting says so.
pub(super) async fn ensure_claude_start_hook(layer: &Layer, cx: &FamilyContext, id: &str) {
    let Ok(Some(lease)) = layer.ready(id) else {
        return;
    };
    if lease.runtime.remote_platform().is_some() {
        return;
    }
    let host = lease.runtime.ssh_host().map(str::to_owned);
    if host.is_none() && cfg!(windows) {
        return;
    }
    let key = match &host {
        Some(host) => format!("ssh:{host}"),
        None => "local".to_owned(),
    };
    if layer.hooked.lock().unwrap().contains(&key) {
        return;
    }
    if super::super::settings::read_shared(cx)
        .await
        .claude_start_mode()
        != "conversation"
    {
        return;
    }
    if !layer.hooked.lock().unwrap().insert(key.clone()) {
        return;
    }
    let ran = match &host {
        Some(host) => super::connections::run_ssh(
            layer,
            host,
            &roamgate_conversation::claude_start_hook::claude_start_hook_install_command(),
            super::connections::SshRun {
                read: true,
                tag: "claude.start_hook",
                connection: None,
                stdin: None,
                timeout_ms: 20_000,
                lane: roamgate_exec::lanes::Lane::Interactive,
            },
        )
        .await
        .map(|ran| {
            (
                ran.code,
                String::from_utf8_lossy(&ran.stdout).into_owned(),
                ran.stderr,
            )
        }),
        None => {
            super::connections::run_local(
                layer,
                roamgate_conversation::claude_start_hook::claude_start_hook_install_argv(),
                20_000,
                None,
            )
            .await
        }
    };
    let (code, stdout, stderr) = ran.unwrap_or_else(|error| (-1, String::new(), error));
    let outcome = stdout.trim().to_owned();
    let log = logger(&cx.clock, "bridge");
    if code == 0 && ["installed", "present", "no-claude"].contains(&outcome.as_str()) {
        if outcome != "present" {
            log.info(
                "claude start hook",
                Some(&fields(json!({"connection": id, "outcome": outcome}))),
            );
        }
        return;
    }
    layer.hooked.lock().unwrap().remove(&key);
    let error = js_slice(stderr.trim(), 300);
    log.warn(
        "claude start hook not installed",
        Some(&fields(json!({
            "connection": id,
            "outcome": if outcome.is_empty() { format!("exit {code}") } else { outcome },
            "error": error,
        }))),
    );
}

/// JavaScript's `text.slice(0, units)`: the first UTF-16 code units.
pub(super) fn js_slice(text: &str, units: usize) -> String {
    let taken: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&taken)
}
