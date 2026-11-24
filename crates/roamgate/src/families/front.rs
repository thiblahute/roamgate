//! The `front` family of a standalone core (contract/wire/core-channel.md,
//! The standalone core): what the Bun server answered itself, in the core
//! of a Rust front that runs no Bun.
//!
//! - `/ws`: each socket's browser (hello, the forwards registry), its RPCs
//!   checked and routed to their connection (roamgate-connections routing,
//!   roamgate-http browser_rpc), then to the family that declares the
//!   method; `bridge.ping`, `bridge.status` and `bridge.pause_others`; the
//!   other methods of a connection pass through to its Herdr, topology
//!   lists as deltas (roamgate-http list_delta). The methods Bun answered
//!   with its own code and no family declares yet are refused as
//!   `standalone_unported`, named in the served log.
//! - HTTP: `/api/health`, and the connection-scoped routes
//!   (`/api/connections/<id>/...` and their legacy paths): `herdr-info`
//!   from the connection's Herdr, the file and agent-session routes from
//!   their families at their legacy paths.
//! - The core's pushes, delivered to the `/ws` sockets.
//! - Reverse targets in the process: the handovers' (a family taken from
//!   Bun has it let go of its part first: nothing to let go of here), and
//!   what the host family asks of the front for each generation (`host.runtime_start`, `host.runtime_stop`,
//!   `host.events`, `host.status`, `host.master_ready`). The generation's
//!   composition root (terminal bridge, task events, Last steps...) is not
//!   built yet: a generation runs with the core's part only, its Herdr
//!   events reaching the browsers.
//! - The front's calls: `internal.front.start` (the server's configuration;
//!   the connections start) and `internal.front.stop` (they stop, at the
//!   front's shutdown).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use roamgate_base::clock::SharedClock;
use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_base::log::{
    LogFields, LogLevel, Logger, LoggerOptions, RecoveryReporter, parse_log_level,
};
use roamgate_connections::host_runtime::HostRuntime;
use roamgate_connections::manager::{ConnectionManager, LEGACY_DEFAULT_CONNECTION_ID};
use roamgate_connections::routing::{
    HttpEndpoint, LegacyRoutingLogger, Resolved, RoutingError, RpcRoute,
    parse_connection_http_route, raw_request_pathname, requested_http_generation,
    resolve_connection_http_route, serialize_herdr_event_envelope,
};
use roamgate_http::browser_rpc::{
    BrowserClients, ClientSink, Hello, Outgoing, ReplyPublisher, RpcMeta, RpcOutcome, log_rpc,
    parse_request, route_request,
};
use roamgate_http::list_delta::{ListDeltas, shape_of};
use roamgate_sidecar::core::{FRONT_FAMILY, note_served};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::owners::families as declared_families;
use roamgate_sidecar::peer::{
    BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall, Peer, WsOpen,
};
use roamgate_sidecar::protocol::{Ctx, Message, RpcError, family_of};
use roamgate_sidecar::standalone::Standalone;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::host::HostHandle;

/// How long a request waits for the connections to start (hostSettling).
const SETTLE_WAIT: Duration = Duration::from_secs(10);

/// The methods the Bun server answered with its own code that no family
/// declares and the standalone core does not serve yet (S25 step 1,
/// item 2): exact names, or prefixes ending in a dot.
const UNPORTED: &[&str] = &[
    "agent.list",
    "connections.agent_sessions",
    "connections.agent_tasks",
    "forge.status",
    "forge.session",
    "forward.",
    "integration.list",
    "pane.send_input",
    "pane.send_text",
    "pane.send_keys",
    "settings.",
    "tab.create",
    "tab.rename",
    "terminal.",
    "workspace.create",
    "workspace.list",
    "workspace.path",
];

fn unported(method: &str) -> bool {
    UNPORTED.iter().any(|entry| {
        if entry.ends_with('.') {
            method.starts_with(entry)
        } else {
            method == *entry
        }
    })
}

pub fn family(host: HostHandle) -> Arc<dyn CoreFamily> {
    Arc::new(FrontFamily(Arc::new(Inner {
        host,
        config: Mutex::default(),
        started: watch::channel(false).0,
        clients: OnceLock::new(),
        deltas: Mutex::default(),
        statuses: Mutex::default(),
        legacy: LegacyRoutingLogger::new(|line| {
            let mut fields = LogFields::new();
            fields.insert("detail".into(), line.into());
            bridge_logger().warn("deprecated request routing", Some(&fields));
        }),
    })))
}

/// The server's configuration, as the front gives it.
#[derive(Debug, Clone, Default)]
struct Config {
    socket_path: String,
    task_notification_source: String,
    auth_required: bool,
}

struct Inner {
    host: HostHandle,
    config: Mutex<Config>,
    /// The connections' start finished (or failed): requests wait for it.
    started: watch::Sender<bool>,
    clients: OnceLock<Arc<BrowserClients>>,
    /// The topology lists each socket was given.
    deltas: Mutex<HashMap<u64, ListDeltas>>,
    /// Each connection's failures and the generation last logged ready.
    statuses: Mutex<HashMap<String, ConnectionLog>>,
    legacy: LegacyRoutingLogger,
}

/// What the log said of a connection (onConnectionStatus).
struct ConnectionLog {
    failures: RecoveryReporter,
    ready_generation: Option<u64>,
}

struct FrontFamily(Arc<Inner>);

fn bridge_logger() -> Logger {
    logger_on(None)
}

/// The `bridge` logger, on the families' clock when given.
fn logger_on(clock: Option<SharedClock>) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some("bridge".into()),
        now: clock.map(|clock| Arc::new(move || clock.now()) as roamgate_base::log::NowFn),
        ..LoggerOptions::default()
    })
}

/// The front's sockets, over the channel.
struct PeerSink(Peer);

impl ClientSink for PeerSink {
    fn send(&self, socket_id: u64, payload: String, context: &str, key: Option<&str>) {
        self.0.send(&Message::WsSend {
            socket_id,
            data: payload,
            binary: false,
            context: Some(context.to_owned()),
            key: key.map(str::to_owned),
        });
    }

    fn end(&self, socket_id: u64, code: u16, reason: &str) {
        self.0.send(&Message::WsEnd {
            socket_id,
            code: Some(code),
            reason: Some(reason.to_owned()),
        });
    }
}

fn standalone(cx: &FamilyContext) -> Result<&Arc<Standalone>, RpcError> {
    cx.standalone
        .as_ref()
        .ok_or_else(|| RpcError::new("the front family runs in a standalone core only"))
}

fn json_response(status: u16, body: &Value, headers: Vec<(String, String)>) -> HttpResponse {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let _ = tx.try_send(serde_json::to_vec(body).unwrap_or_default());
    let mut all = vec![(
        "content-type".to_owned(),
        "application/json;charset=utf-8".to_owned(),
    )];
    all.extend(headers);
    HttpResponse {
        status,
        headers: all,
        body: Some(rx),
    }
}

/// `new Response(text, {status})`.
fn text_response(status: u16, text: &str) -> HttpResponse {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let _ = tx.try_send(text.as_bytes().to_vec());
    HttpResponse {
        status,
        headers: vec![(
            "content-type".to_owned(),
            "text/plain;charset=utf-8".to_owned(),
        )],
        body: Some(rx),
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next()?;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// `ws_open`'s refusal: the response the browser gets.
fn refused(status: u16, body: &str) -> Value {
    json!({
        "accepted": false,
        "status": status,
        "headers": [["content-type", "text/plain;charset=utf-8"]],
        "body": body,
    })
}

/// The connection's identity headers (withConnectionResponseHeader).
fn identity_headers(resolved: &Resolved) -> Vec<(String, String)> {
    vec![
        (
            "x-herdr-connection-id".into(),
            resolved.lease.connection_id.clone(),
        ),
        (
            "x-herdr-connection-generation".into(),
            resolved.lease.generation.to_string(),
        ),
    ]
}

/// connectionRoutingErrorResponse.
fn routing_error_response(error: &RoutingError) -> HttpResponse {
    let mut headers = Vec::new();
    if let Some(connection_id) = &error.connection_id {
        headers.push(("x-herdr-connection-id".into(), connection_id.clone()));
        if let Some(generation) = error.connection_generation {
            headers.push((
                "x-herdr-connection-generation".into(),
                generation.to_string(),
            ));
        }
    }
    json_response(error.status, &json!({ "error": error.message }), headers)
}

impl Inner {
    fn clients(&self) -> Option<&Arc<BrowserClients>> {
        self.clients.get()
    }

    /// The connections once their start settled (at most 10 s).
    async fn manager(&self) -> Option<ConnectionManager<HostRuntime>> {
        let mut started = self.started.subscribe();
        let deadline = Instant::now() + SETTLE_WAIT;
        let _ = tokio::time::timeout(SETTLE_WAIT, started.wait_for(|done| *done)).await;
        self.host
            .manager(deadline.saturating_duration_since(Instant::now()))
            .await
    }

    /// `internal.front.start`: the server's configuration, then the
    /// connections, started in the background.
    fn start(self: &Arc<Self>, cx: &FamilyContext, params: &Value) -> Result<Value, RpcError> {
        let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| params.get(key).and_then(Value::as_bool).unwrap_or(false);
        let socket_path =
            text("socket_path").ok_or_else(|| RpcError::new("front.start needs a socket_path"))?;
        *self.config.lock().unwrap() = Config {
            socket_path: socket_path.clone(),
            task_notification_source: text("task_notification_source").unwrap_or_default(),
            auth_required: flag("auth_required"),
        };
        let ssh_host = text("ssh_host");
        let session = text("session");
        let explicit_legacy_override = flag("has_explicit_socket_path")
            || flag("has_explicit_client_socket_path")
            || ssh_host.is_some()
            || session.is_some();
        let host_start = json!({
            "generations": params.get("generations").cloned().unwrap_or(json!({})),
            "legacy": {
                "socket_path": socket_path,
                "client_socket_path": text("client_socket_path").unwrap_or_default(),
                "ssh_host": ssh_host,
                "session": session,
                "has_explicit_socket_path": flag("has_explicit_socket_path"),
                "has_explicit_client_socket_path": flag("has_explicit_client_socket_path"),
            },
            "explicit_legacy_override": explicit_legacy_override,
        });
        let standalone = standalone(cx)?.clone();
        // No Bun recorder to stop first: the core's records now.
        let activity = standalone.call("internal.activity.start", json!({}), Ctx::default());
        let inner = self.clone();
        tokio::spawn(async move {
            if let Err(error) = standalone
                .call("internal.host.start", host_start, Ctx::default())
                .await
            {
                tracing::warn!(
                    scope = "connections",
                    "the connections did not start: {}",
                    error.message
                );
            }
            inner.started.send_replace(true);
        });
        tokio::spawn(async move {
            if let Err(error) = activity.await {
                tracing::warn!(
                    scope = "activity",
                    "the recorder did not start: {}",
                    error.message
                );
            }
        });
        Ok(json!({"ok": true}))
    }

    fn register(self: &Arc<Self>, cx: &FamilyContext) {
        let Some(standalone) = &cx.standalone else {
            return;
        };
        let clients = self
            .clients
            .get_or_init(|| Arc::new(BrowserClients::new(Arc::new(PeerSink(cx.peer.clone())))))
            .clone();
        let into = clients.clone();
        standalone.set_push_sink(Arc::new(move |push| into.deliver(&push)));
        // A family taken from Bun first has it let go of its part: with no
        // Bun, there is nothing to let go of.
        for target in [
            "assistant.release",
            "history.release",
            "mr_cache.release",
            "review.release",
            "review.socketsTaken",
            "voice.release",
        ] {
            standalone.register(
                target,
                Arc::new(|_, _, _| Box::pin(async { Ok(json!({"ok": true})) })),
            );
        }
        // The generation's composition root is the front's: not built yet.
        standalone.register(
            "host.runtime_start",
            Arc::new(|_, _, _| Box::pin(async { Ok(json!({"ok": true})) })),
        );
        standalone.register(
            "host.runtime_stop",
            Arc::new(|_, _, _| Box::pin(async { Ok(json!({"ok": true})) })),
        );
        standalone.register(
            "host.master_ready",
            Arc::new(|_, _, _| Box::pin(async { Ok(json!({"ok": true})) })),
        );
        let statuses = self.clone();
        standalone.register(
            "host.status",
            Arc::new(move |cx, args, _| {
                if let Some(status) = args.get("status").filter(|status| status.is_object()) {
                    statuses.connection_status(cx, status);
                }
                Box::pin(async { Ok(json!({"ok": true})) })
            }),
        );
        let events = clients;
        standalone.register(
            "host.events",
            Arc::new(move |_, args, _| {
                let clients = events.clone();
                Box::pin(async move {
                    host_events(&clients, &args)?;
                    Ok(json!({"ok": true}))
                })
            }),
        );
    }

    /// A connection's status changed (onConnectionStatus): a failure
    /// logged once per run of equal ones, a recovery, a new generation
    /// ready.
    fn connection_status(&self, cx: &FamilyContext, status: &Value) {
        let Some(id) = status["id"].as_str() else {
            return;
        };
        let state = status["state"].as_str().unwrap_or_default();
        let generation = status["generation"].as_u64().unwrap_or(0);
        let mut fields = LogFields::new();
        fields.insert("connection".into(), id.into());
        fields.insert("state".into(), state.into());
        fields.insert("generation".into(), generation.into());
        let logger = logger_on(Some(cx.clock.clone()));
        let mut debug = fields.clone();
        if let Some(error) = status["error"]["message"].as_str() {
            debug.insert("error".into(), error.into());
        }
        logger.debug("connection status", Some(&debug));
        let mut statuses = self.statuses.lock().unwrap();
        let entry = statuses.entry(id.to_owned()).or_insert_with(|| {
            let clock = cx.clock.clone();
            ConnectionLog {
                failures: RecoveryReporter::new(
                    logger.child("connections"),
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
            entry.failures.failure(error, Some(&fields));
            return;
        }
        if state != "ready" {
            return;
        }
        if entry.failures.recovered(Some(&fields)) {
            entry.ready_generation = Some(generation);
        } else if entry.ready_generation != Some(generation) {
            entry.ready_generation = Some(generation);
            logger.info("connection ready", Some(&fields));
        }
    }

    /// A `/ws` socket opened (the `open` handler).
    async fn open_ws(&self, open: &WsOpen) -> Value {
        if header(&open.headers, "sec-fetch-site") == Some("cross-site")
            || header(&open.headers, "origin") == Some("null")
        {
            return refused(403, "forbidden");
        }
        let Some(clients) = self.clients() else {
            return refused(503, "the server is starting");
        };
        let client_ip = open.ctx.client_ip.clone();
        let info = clients.add(
            open.socket_id,
            open.ctx.session_id.clone(),
            client_ip.clone(),
        );
        let mut fields = LogFields::new();
        fields.insert("client".into(), info.label.clone().into());
        fields.insert("clients".into(), clients.len().into());
        bridge_logger().debug("client connected", Some(&fields));
        let default_id = match self.manager().await {
            Some(manager) => manager.default_id(),
            None => LEGACY_DEFAULT_CONNECTION_ID.to_owned(),
        };
        let config = self.config.lock().unwrap().clone();
        let hello = Hello {
            socket: &config.socket_path,
            default_connection_id: &default_id,
            file_reveal: roamgate_workspace::file_manager::can_reveal_files(
                client_ip.as_deref().unwrap_or(""),
                &ProcessEnv,
            ),
            herdr_task_notifications: config.task_notification_source == "herdr",
        };
        clients.send(open.socket_id, hello.line(), "hello", None);
        // The forwards registry is the composition root's: none yet.
        clients.send(
            open.socket_id,
            json!({"forwards": []}).to_string(),
            "forwards",
            None,
        );
        json!({"accepted": true, "transport": "ws"})
    }

    fn closed_ws(&self, cx: &FamilyContext, socket_id: u64, code: Option<u16>, reason: &str) {
        self.deltas.lock().unwrap().remove(&socket_id);
        let Some(clients) = self.clients() else {
            return;
        };
        let Some(info) = clients.remove(socket_id) else {
            return;
        };
        let mut fields = LogFields::new();
        fields.insert("client".into(), info.label.into());
        fields.insert("clients".into(), clients.len().into());
        if let Some(code) = code {
            fields.insert("code".into(), code.into());
        }
        if !reason.is_empty() {
            fields.insert("reason".into(), reason.into());
        }
        bridge_logger().debug("client disconnected", Some(&fields));
        // The families' state of the socket goes with it.
        if let Some(standalone) = &cx.standalone {
            for family in ["agent_sessions", "conversation"] {
                let call = standalone.call(
                    &format!("internal.{family}.socket_closed"),
                    json!({"socket_id": socket_id}),
                    Ctx::default(),
                );
                tokio::spawn(async move {
                    let _ = call.await;
                });
            }
        }
    }

    /// One frame of a `/ws` socket: its RPC answered, then logged.
    async fn rpc(self: Arc<Self>, cx: FamilyContext, socket_id: u64, raw: String) {
        let Some(clients) = self.clients().cloned() else {
            return;
        };
        let started = Instant::now();
        let meta = RpcMeta::parse(&raw);
        let label = clients
            .get(socket_id)
            .map(|info| info.label)
            .unwrap_or_else(|| "unknown".into());
        let (chars, error) = self.answer(&cx, &clients, socket_id, &raw, &meta).await;
        let default_id = self
            .host
            .list()
            .and_then(|list| list["default_connection_id"].as_str().map(str::to_owned))
            .unwrap_or_else(|| LEGACY_DEFAULT_CONNECTION_ID.to_owned());
        let (_, log_connection) = meta.connections(&default_id);
        log_rpc(
            &bridge_logger(),
            &RpcOutcome {
                client: &label,
                method: meta.method.as_deref(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: error.as_deref(),
                connection: log_connection.as_deref(),
                reply_chars: chars,
            },
        );
    }

    /// handleRpc: the reply's size and the error the request failed with.
    async fn answer(
        &self,
        cx: &FamilyContext,
        clients: &BrowserClients,
        socket_id: u64,
        raw: &str,
        meta: &RpcMeta,
    ) -> (Option<usize>, Option<String>) {
        let request = match parse_request(raw) {
            Ok(request) => request,
            Err(refusal) => {
                clients.send(socket_id, refusal.payload, refusal.context, None);
                return (None, refusal.marked.map(|(_, message)| message));
            }
        };
        let Some(manager) = self.manager().await else {
            let message = "the connections are not started".to_owned();
            let payload = json!({"id": request.id, "error": {"message": message}}).to_string();
            clients.send(socket_id, payload, "connection-routing-error", None);
            return (None, Some(message));
        };
        let route = match route_request(&request, &manager, socket_id, Some(&self.legacy)) {
            Ok(route) => route,
            Err(refusal) => {
                clients.send(socket_id, refusal.payload, refusal.context, None);
                return (None, refusal.marked.map(|(_, message)| message));
            }
        };
        let info = clients.get(socket_id);
        let mut ctx = Ctx {
            socket_id: Some(socket_id),
            lane: Some(
                if meta.background {
                    "background"
                } else {
                    "interactive"
                }
                .into(),
            ),
            client_ip: info.as_ref().and_then(|info| info.client_ip.clone()),
            session_id: info.as_ref().and_then(|info| info.session_id.clone()),
            ..Ctx::default()
        };
        if let RpcRoute::Connection(resolved) = &route {
            ctx.connection_id = Some(resolved.lease.connection_id.clone());
            ctx.connection_generation = Some(resolved.lease.generation);
        }
        let publisher = ReplyPublisher::new(route, &request.id);
        let send = |outgoing: Option<Outgoing>| -> (Option<usize>, Option<String>) {
            match outgoing {
                Some(outgoing) => {
                    let chars = outgoing.payload.len();
                    clients.send(socket_id, outgoing.payload, &outgoing.context, None);
                    (Some(chars), outgoing.error)
                }
                None => (None, None),
            }
        };
        let method = request.method.as_str();
        let Ok(standalone) = standalone(cx) else {
            return send(publisher.error("no standalone core", None, "core-error"));
        };
        // A family's method: it answers.
        if family_of(method, declared_families()).is_some_and(|family| family != FRONT_FAMILY) {
            return match standalone.call(method, request.params, ctx).await {
                Ok(result) => {
                    if method == "bridge.ui_settings.update" {
                        let line = json!({"ui_settings": result}).to_string();
                        clients.broadcast(&line, "ui-settings", Some(socket_id));
                    }
                    send(publisher.result(result, "core"))
                }
                Err(error) => {
                    send(publisher.error(&error.message, error.code.as_deref(), "core-error"))
                }
            };
        }
        match method {
            "bridge.ping" => return send(publisher.result(json!({"ok": true}), "bridge-ping")),
            "bridge.status" => {
                let list = self.host.list().unwrap_or(Value::Null);
                return send(publisher.result(
                    json!({
                        "clients": clients.len(),
                        // The terminal bridge is the composition root's: none yet.
                        "terminals": [],
                        "default_connection_id": list["default_connection_id"],
                        "connections": list["connections"],
                    }),
                    "bridge-status",
                ));
            }
            "bridge.pause_others" => {
                let paused = clients.pause_others(socket_id);
                return send(publisher.result(
                    json!({"ok": true, "paused_clients": paused, "clients": clients.len()}),
                    "bridge-pause-others",
                ));
            }
            _ => {}
        }
        if unported(method) {
            note_served(&ProcessEnv, "unported", method);
            return send(publisher.error(
                &format!("{method} is not served by the standalone core"),
                Some("standalone_unported"),
                &format!("{method}-error"),
            ));
        }
        let RpcRoute::Connection(resolved) = publisher.route().clone() else {
            return send(publisher.error(
                &format!("unknown bridge-global method: {method}"),
                None,
                "unknown-bridge-method",
            ));
        };
        // The connection's Herdr answers; a page holding a topology list
        // sends its stamp, which Herdr never sees.
        let mut params = request.params;
        let since = match (&mut params, shape_of(method)) {
            (Value::Object(object), Some(_)) => object.remove("since"),
            _ => None,
        };
        let call = json!({
            "connection_id": resolved.lease.connection_id,
            "generation": resolved.lease.generation,
            "method": method,
            "params": params,
        });
        match standalone
            .call("internal.host.herdr_call", call, Ctx::default())
            .await
        {
            Ok(mut result) => {
                if let Some(since) = since {
                    result = self
                        .deltas
                        .lock()
                        .unwrap()
                        .entry(socket_id)
                        .or_default()
                        .reply(&resolved.lease.connection_id, method, result, &since);
                }
                send(publisher.result(result, method))
            }
            Err(error) => send(publisher.error(&error.message, None, &format!("{method}-error"))),
        }
    }

    /// `/api/health`, and the connection-scoped routes.
    async fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> Result<HttpResponse, RpcError> {
        let path = raw_request_pathname(&request.url).to_owned();
        // A socket's path asked without an upgrade: never from another
        // site nor a sandboxed page, else the upgrade failed.
        if path == "/ws" || path == "/api/notifications/ws" {
            let (status, text) = if header(&request.headers, "sec-fetch-site") == Some("cross-site")
                || header(&request.headers, "origin") == Some("null")
            {
                (403, "forbidden")
            } else {
                (400, "websocket upgrade failed")
            };
            return Ok(text_response(status, text));
        }
        if path == "/api/health" {
            let config = self.config.lock().unwrap().clone();
            return Ok(json_response(
                200,
                &json!({
                    "ok": true,
                    "version": crate::VERSION,
                    "socket": config.socket_path,
                    "auth_required": config.auth_required,
                }),
                Vec::new(),
            ));
        }
        let Some(route) = parse_connection_http_route(&path, &request.method) else {
            return Ok(HttpResponse::status(404));
        };
        let route = match route {
            Ok(route) => route,
            Err(error) => return Ok(routing_error_response(&error)),
        };
        let Some(manager) = self.manager().await else {
            return Ok(json_response(
                503,
                &json!({"error": "the connections are not started"}),
                Vec::new(),
            ));
        };
        let generation = requested_http_generation(
            query_param(&request.url, "connection_generation").as_deref(),
        );
        let resolved = match resolve_connection_http_route(
            &route,
            generation.as_ref(),
            &manager,
            Some(&self.legacy),
        ) {
            Ok(resolved) => resolved,
            Err(error) => return Ok(routing_error_response(&error)),
        };
        let response = match route.endpoint {
            HttpEndpoint::HerdrInfo => self.herdr_info(cx, &resolved).await?,
            HttpEndpoint::FileDownload
            | HttpEndpoint::FileUpload
            | HttpEndpoint::FileDelete
            | HttpEndpoint::AgentSessionDownload
            | HttpEndpoint::AgentSessionAtif => {
                // Under its legacy path, the connection in ctx: the
                // family's own route.
                let query = request
                    .url
                    .split_once('?')
                    .map(|(_, query)| format!("?{query}"))
                    .unwrap_or_default();
                let mut forwarded = request.clone();
                forwarded.url = format!("{}{query}", route.endpoint.legacy_path());
                forwarded.ctx.connection_id = Some(resolved.lease.connection_id.clone());
                forwarded.ctx.connection_generation = Some(resolved.lease.generation);
                match standalone(cx)?.http(forwarded, body).await {
                    Ok(response) => response,
                    Err(error) => json_response(500, &json!({"error": error.message}), Vec::new()),
                }
            }
            HttpEndpoint::UploadImage | HttpEndpoint::TerminalUpload => {
                note_served(
                    &ProcessEnv,
                    "unported",
                    &format!("{} {path}", request.method),
                );
                json_response(
                    501,
                    &json!({"error": format!("{path} is not served by the standalone core")}),
                    Vec::new(),
                )
            }
        };
        Ok(publish(&resolved, response))
    }

    /// `herdr-info`: the connection's Herdr identity.
    async fn herdr_info(
        &self,
        cx: &FamilyContext,
        resolved: &Resolved,
    ) -> Result<HttpResponse, RpcError> {
        let answer = standalone(cx)?
            .call(
                "internal.host.herdr_call",
                json!({
                    "connection_id": resolved.lease.connection_id,
                    "generation": resolved.lease.generation,
                    "method": "ping",
                    "params": {},
                }),
                Ctx::default(),
            )
            .await;
        Ok(
            match herdr_identity(answer.map_err(|error| error.message)) {
                Ok(identity) => json_response(200, &identity, Vec::new()),
                Err(message) => json_response(503, &json!({"error": message}), Vec::new()),
            },
        )
    }
}

/// createHerdrInfoHandler: `{version, protocol}` of a valid identity.
fn herdr_identity(answer: Result<Value, String>) -> Result<Value, String> {
    let info = answer?;
    let version = info["version"]
        .as_str()
        .filter(|version| !version.trim().is_empty());
    let protocol = info["protocol"].as_u64().filter(|protocol| *protocol >= 1);
    match (version, protocol) {
        (Some(version), Some(protocol)) => Ok(json!({"version": version, "protocol": protocol})),
        _ => Err("Herdr returned invalid server information".into()),
    }
}

/// publishConnectionHttpResponse: the connection's identity added, or 409
/// when the connection changed meanwhile.
fn publish(resolved: &Resolved, mut response: HttpResponse) -> HttpResponse {
    if !resolved.lease.is_current() {
        return json_response(
            409,
            &json!({"error": roamgate_connections::routing::CONNECTION_CHANGED_DURING_REQUEST}),
            identity_headers(resolved),
        );
    }
    response.headers.retain(|(name, _)| {
        !name.eq_ignore_ascii_case("x-herdr-connection-id")
            && !name.eq_ignore_ascii_case("x-herdr-connection-generation")
    });
    response.headers.extend(identity_headers(resolved));
    response
}

/// `host.events`: what a generation's subscriptions saw, to the browsers
/// (the Herdr events in the connection's envelope, a subscription's
/// (re)start as `session.resync_required`).
fn host_events(clients: &BrowserClients, args: &Value) -> Result<(), RpcError> {
    let connection_id = args["connection_id"]
        .as_str()
        .ok_or_else(|| RpcError::new("host.events needs a connection_id"))?;
    let generation = args["generation"].as_u64();
    let events = args["events"]
        .as_array()
        .ok_or_else(|| RpcError::new("host.events needs events"))?;
    for each in events {
        let event = match each["kind"].as_str() {
            Some("herdr") => each["event"].clone(),
            Some("ready") => json!({"event": "session.resync_required", "data": {}}),
            _ => continue,
        };
        match serialize_herdr_event_envelope(connection_id, &event, generation) {
            Ok(line) => clients.broadcast(&line, "event", None),
            Err(error) => tracing::warn!(
                scope = "bridge",
                connection = connection_id,
                "dropped invalid Herdr event: {error}"
            ),
        }
    }
    Ok(())
}

impl CoreFamily for FrontFamily {
    fn name(&self) -> &'static str {
        FRONT_FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let inner = self.0.clone();
        let cx = cx.clone();
        Box::pin(async move {
            match call.method.as_str() {
                "internal.front.start" => inner.start(&cx, &call.params),
                "internal.front.stop" => {
                    standalone(&cx)?
                        .call("internal.host.stop", json!({}), Ctx::default())
                        .await
                }
                method => Err(RpcError::with_code(
                    format!("unknown method {method}"),
                    "unknown_method",
                )),
            }
        })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let inner = self.0.clone();
        let cx = cx.clone();
        Box::pin(async move { inner.http(&cx, request, body).await })
    }

    fn ws_open(
        &self,
        _cx: &FamilyContext,
        _link: &Peer,
        open: WsOpen,
    ) -> BoxFuture<Result<Value, RpcError>> {
        let inner = self.0.clone();
        Box::pin(async move {
            let path = raw_request_pathname(&open.url).to_owned();
            Ok(match path.as_str() {
                "/ws" => inner.open_ws(&open).await,
                "/api/notifications/ws" => {
                    note_served(&ProcessEnv, "unported", "ws /api/notifications/ws");
                    refused(
                        503,
                        "the notification feed is not served by the standalone core",
                    )
                }
                _ => refused(404, "Not Found"),
            })
        })
    }

    fn ws_socket(&self, cx: &FamilyContext, _link: &Peer, message: Message) {
        match message {
            Message::WsMessage {
                socket_id,
                data,
                binary: false,
            } => {
                tokio::spawn(self.0.clone().rpc(cx.clone(), socket_id, data));
            }
            Message::WsClose {
                socket_id,
                code,
                reason,
            } => self.0.closed_ws(cx, socket_id, code, &reason),
            _ => {}
        }
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        if owned {
            self.0.register(cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_methods_bun_answered_itself_are_named() {
        for method in [
            "agent.list",
            "terminal.attach",
            "forward.open",
            "settings.profiles.get",
            "workspace.list",
        ] {
            assert!(unported(method), "{method}");
        }
        for method in ["pane.list", "tab.list", "workspace.focus", "terminal"] {
            assert!(!unported(method), "{method}");
        }
    }

    #[test]
    fn herdr_info_answers_a_valid_identity_only() {
        assert_eq!(
            herdr_identity(Ok(json!({"version": "0.9.0", "protocol": 3, "x": 1}))),
            Ok(json!({"version": "0.9.0", "protocol": 3}))
        );
        assert_eq!(
            herdr_identity(Ok(json!({"version": " ", "protocol": 3}))),
            Err("Herdr returned invalid server information".into())
        );
        assert_eq!(
            herdr_identity(Err("connect failed".into())),
            Err("connect failed".into())
        );
    }
}
