//! The `/ws` socket's RPCs and pushes as the server answers them (index.ts
//! `handleRpc`, its `websocket` handlers and `deliverCorePush`), over any
//! transport: the browsers connected (each with its label, login and
//! address), the hello a new socket gets, a request's envelope checked and
//! routed to its connection (connections/rpc-routing.ts), its replies in
//! that connection's envelope (a stale one said once), pushes fanned out
//! with their filters and coalescing keys, and the RPC log lines.
//!
//! What a call does once routed is the caller's: the standalone core's
//! `front` family dispatches it to the family that declares it.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_base::log::{LogFields, LogLevel, Logger, rpc_log_level};
use roamgate_connections::manager::sanitize_connection_error;
use roamgate_connections::routing::{
    CONNECTION_CHANGED_DURING_REQUEST, LegacyRoutingLogger, ReadyConnections, RouteError, RpcRoute,
    is_bridge_global_method, resolve_rpc_route, serialize_connection_envelope,
    validate_connection_generation, validate_connection_id,
};
use roamgate_sidecar::protocol::Push;
use serde_json::{Map, Value, json};

/// Where the server's messages to one browser socket go.
pub trait ClientSink: Send + Sync + 'static {
    /// A text message through the socket's flow, with Bun's
    /// `sendWebSocketMessage` context and coalescing key.
    fn send(&self, socket_id: u64, payload: String, context: &str, key: Option<&str>);
    /// Closes the socket.
    fn end(&self, socket_id: u64, code: u16, reason: &str);
    /// Forgets a message held under backpressure with that coalescing key.
    fn drop_coalesced(&self, _socket_id: u64, _key: &str) {}
}

/// A browser connected on `/ws`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    pub socket_id: u64,
    /// `c<n>`, as the log names it.
    pub label: String,
    /// The login's session id (`ctx.session_id`).
    pub session_id: Option<String>,
    pub client_ip: Option<String>,
}

/// The browsers connected on `/ws` (index.ts `clients`).
pub struct BrowserClients {
    clients: Mutex<BTreeMap<u64, ClientInfo>>,
    next_label: AtomicU64,
    sink: Arc<dyn ClientSink>,
}

impl BrowserClients {
    pub fn new(sink: Arc<dyn ClientSink>) -> Self {
        Self {
            clients: Mutex::default(),
            next_label: AtomicU64::new(1),
            sink,
        }
    }

    /// A socket opened: its label.
    pub fn add(
        &self,
        socket_id: u64,
        session_id: Option<String>,
        client_ip: Option<String>,
    ) -> ClientInfo {
        let label = format!("c{}", self.next_label.fetch_add(1, Ordering::Relaxed));
        let info = ClientInfo {
            socket_id,
            label,
            session_id,
            client_ip,
        };
        self.clients.lock().unwrap().insert(socket_id, info.clone());
        info
    }

    /// A socket closed: what it was.
    pub fn remove(&self, socket_id: u64) -> Option<ClientInfo> {
        self.clients.lock().unwrap().remove(&socket_id)
    }

    pub fn get(&self, socket_id: u64) -> Option<ClientInfo> {
        self.clients.lock().unwrap().get(&socket_id).cloned()
    }

    pub fn len(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `safeSend` to one socket.
    pub fn send(&self, socket_id: u64, payload: String, context: &str, key: Option<&str>) {
        self.sink.send(socket_id, payload, context, key);
    }

    /// `dropCoalescedMessage`: a held message of that key is not sent.
    pub fn drop_coalesced(&self, socket_id: u64, key: &str) {
        self.sink.drop_coalesced(socket_id, key);
    }

    /// The same line to every socket but `except`.
    pub fn broadcast(&self, line: &str, context: &str, except: Option<u64>) {
        let ids: Vec<u64> = self.clients.lock().unwrap().keys().copied().collect();
        for socket_id in ids.into_iter().filter(|id| Some(*id) != except) {
            self.sink.send(socket_id, line.to_owned(), context, None);
        }
    }

    /// A push of the core's to the browsers it names (deliverCorePush):
    /// in its connection's envelope when it names one, to one socket or
    /// one login's sockets when it says so, with its coalescing key.
    pub fn deliver(&self, push: &Push) {
        let line = match (&push.connection_id, push.message.as_object()) {
            (Some(connection_id), Some(message)) => {
                match serialize_connection_envelope(
                    connection_id,
                    message,
                    push.connection_generation,
                ) {
                    Ok(line) => line,
                    Err(error) => {
                        tracing::warn!(scope = "bridge", "dropped a core push: {error}");
                        return;
                    }
                }
            }
            _ => json_text(&push.message),
        };
        let targets: Vec<u64> = self
            .clients
            .lock()
            .unwrap()
            .values()
            .filter(|client| push.socket_id.is_none_or(|id| id == client.socket_id))
            .filter(|client| {
                push.session_id.is_none()
                    || client.session_id.as_deref() == push.session_id.as_deref()
            })
            .map(|client| client.socket_id)
            .collect();
        for socket_id in targets {
            self.sink
                .send(socket_id, line.clone(), "core-push", push.key.as_deref());
        }
    }

    /// `bridge.pause_others`: every other socket told to pause; how many.
    pub fn pause_others(&self, except: u64) -> usize {
        let line = json!({
            "control": {
                "type": "pause_connection",
                "reason": "Another Roamgate client paused this connection. Resume when you want this browser to sync again.",
            }
        })
        .to_string();
        let ids: Vec<u64> = self.clients.lock().unwrap().keys().copied().collect();
        let mut paused = 0;
        for socket_id in ids.into_iter().filter(|id| *id != except) {
            self.sink
                .send(socket_id, line.clone(), "pause-other-client", None);
            paused += 1;
        }
        paused
    }

    /// Closes the sockets of a login (a logout): 4001 `Logged out`.
    pub fn close_session(&self, session_id: &str) {
        let ids: Vec<u64> = self
            .clients
            .lock()
            .unwrap()
            .values()
            .filter(|client| client.session_id.as_deref() == Some(session_id))
            .map(|client| client.socket_id)
            .collect();
        for socket_id in ids {
            self.sink.end(socket_id, 4001, "Logged out");
        }
    }
}

/// What a socket's hello says (the `open` handler's first message).
pub struct Hello<'a> {
    /// The legacy connection's Herdr socket (`config.socketPath`).
    pub socket: &'a str,
    pub default_connection_id: &'a str,
    /// The browser may open a file manager (a loopback browser with
    /// `ROAMGATE_ALLOW_FILE_REVEAL=1`).
    pub file_reveal: bool,
    /// Task notifications come from Herdr's semantic stream.
    pub herdr_task_notifications: bool,
}

impl Hello<'_> {
    pub fn line(&self) -> String {
        json!({
            "hello": true,
            "socket": self.socket,
            "bridge_protocol_version": 2,
            "default_connection_id": self.default_connection_id,
            "capabilities": {
                "connection_id": true,
                "connection_scoped_http": true,
                "file_reveal": self.file_reveal,
                "connection_runtime_generation": true,
                "embedded_assistant": true,
                "flow_control": true,
                "list_delta": true,
                "herdr_task_notifications": self.herdr_task_notifications,
            },
        })
        .to_string()
    }
}

/// What the log line of an RPC needs, read before it runs (parseRpcMeta).
#[derive(Debug, Clone, PartialEq)]
pub struct RpcMeta {
    pub id: Option<String>,
    pub method: Option<String>,
    pub connection_id: Option<Value>,
    pub connection_generation: Option<Value>,
    /// `background` when the browser marks it so (badges, polls).
    pub background: bool,
}

impl RpcMeta {
    pub fn parse(raw: &str) -> Self {
        let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let object = parsed.as_object();
        let text = |key: &str| {
            object
                .and_then(|object| object.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        Self {
            id: text("id"),
            method: text("method"),
            connection_id: object.and_then(|object| object.get("connection_id").cloned()),
            connection_generation: object
                .and_then(|object| object.get("connection_generation").cloned()),
            background: text("lane").as_deref() == Some("background"),
        }
    }

    /// The connection a reply goes out in, and the one the log names
    /// (`invalid` for a malformed id).
    pub fn connections(&self, default_id: &str) -> (Option<String>, Option<String>) {
        let Some(method) = self.method.as_deref() else {
            return (None, None);
        };
        if is_bridge_global_method(method) {
            return (None, None);
        }
        match &self.connection_id {
            None => (Some(default_id.to_owned()), Some(default_id.to_owned())),
            Some(value) => match validate_connection_id(value) {
                Ok(id) => (Some(id.clone()), Some(id)),
                Err(_) => (None, Some("invalid".into())),
            },
        }
    }
}

/// A frame the socket sent, as `handleRpc` takes it.
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
    pub envelope: Map<String, Value>,
}

/// A frame refused before routing: what to send back.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub payload: String,
    pub context: &'static str,
    /// The request's id and the error it is marked with, when it had one.
    pub marked: Option<(String, String)>,
}

fn error_message(id: Option<&str>, message: &str) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(id) = id {
        out.insert("id".into(), id.into());
    }
    out.insert("error".into(), json!({ "message": message }));
    out
}

/// The envelope checks of `handleRpc`: JSON, an object, an id and a method.
pub fn parse_request(raw: &str) -> Result<RpcRequest, Refusal> {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return Err(Refusal {
            payload: json!({"error": {"message": "bad json"}}).to_string(),
            context: "bad-json",
            marked: None,
        });
    };
    let Value::Object(envelope) = parsed else {
        return Err(Refusal {
            payload: json!({"error": {"message": "invalid request envelope"}}).to_string(),
            context: "invalid-request-envelope",
            marked: None,
        });
    };
    let id = envelope
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.is_empty());
    if let (Some(id), Some(method)) = (id, method) {
        return Ok(RpcRequest {
            id: id.to_owned(),
            method: method.to_owned(),
            params: envelope.get("params").cloned().unwrap_or(Value::Null),
            envelope: envelope.clone(),
        });
    }
    let connection = envelope.get("connection_id").map(validate_connection_id);
    let generation = envelope
        .get("connection_generation")
        .map(validate_connection_generation);
    let message = if matches!(connection, Some(Err(_))) {
        "invalid connection_id"
    } else if matches!(generation, Some(Err(_))) {
        "invalid connection_generation"
    } else {
        "missing id/method"
    };
    // An empty id is still the one the error is marked with, and sent
    // back as none.
    let any_id = envelope.get("id").and_then(Value::as_str);
    let reply_id = any_id.filter(|id| !id.is_empty());
    let body = error_message(reply_id, message);
    let payload = match connection {
        Some(Ok(connection_id)) => {
            serialize_connection_envelope(&connection_id, &body, generation.and_then(Result::ok))
                .unwrap_or_else(|_| Value::Object(body.clone()).to_string())
        }
        _ => json_text(&body),
    };
    Err(Refusal {
        payload,
        context: "invalid-request",
        marked: any_id.map(|id| (id.to_owned(), message.to_owned())),
    })
}

/// A request routed, or the reply its routing error gets.
pub fn route_request(
    request: &RpcRequest,
    registry: &dyn ReadyConnections,
    client: u64,
    legacy: Option<&LegacyRoutingLogger>,
) -> Result<RpcRoute, Refusal> {
    resolve_rpc_route(&request.envelope, &request.method, registry, client, legacy).map_err(
        |error| {
            let message = error.message().to_owned();
            let body = error_message(Some(&request.id), &message);
            let payload = match &error {
                RouteError::Routing(routing) => {
                    routing.connection_id.as_deref().and_then(|connection_id| {
                        serialize_connection_envelope(
                            connection_id,
                            &body,
                            routing.connection_generation,
                        )
                        .ok()
                    })
                }
                RouteError::Other(_) => None,
            }
            .unwrap_or_else(|| json_text(&body));
            Refusal {
                payload,
                context: "connection-routing-error",
                marked: Some((request.id.clone(), message)),
            }
        },
    )
}

/// One request's replies (createConnectionReplyPublisher): in its
/// connection's envelope while the connection's runtime is the one the
/// request was routed to, else once `connection changed during request`.
pub struct ReplyPublisher {
    route: RpcRoute,
    request_id: String,
    stale_sent: AtomicBool,
}

/// A reply to send.
#[derive(Debug, Clone, PartialEq)]
pub struct Outgoing {
    pub payload: String,
    pub context: String,
    /// The error the request is marked with, when it failed.
    pub error: Option<String>,
}

impl ReplyPublisher {
    pub fn new(route: RpcRoute, request_id: &str) -> Self {
        Self {
            route,
            request_id: request_id.to_owned(),
            stale_sent: AtomicBool::new(false),
        }
    }

    /// The route the request took.
    pub fn route(&self) -> &RpcRoute {
        &self.route
    }

    /// `message` as sent, or None once the stale reply went.
    pub fn publish(&self, message: Map<String, Value>, context: &str) -> Option<Outgoing> {
        let error = message
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let RpcRoute::Connection(resolved) = &self.route else {
            return Some(Outgoing {
                payload: json_text(&message),
                context: context.to_owned(),
                error,
            });
        };
        let lease = &resolved.lease;
        if lease.is_current() {
            return Some(Outgoing {
                payload: serialize_connection_envelope(
                    &lease.connection_id,
                    &message,
                    Some(lease.generation),
                )
                .unwrap_or_else(|_| json_text(&message)),
                context: context.to_owned(),
                error,
            });
        }
        if self.stale_sent.swap(true, Ordering::SeqCst) {
            return None;
        }
        let body = error_message(Some(&self.request_id), CONNECTION_CHANGED_DURING_REQUEST);
        Some(Outgoing {
            payload: serialize_connection_envelope(
                &lease.connection_id,
                &body,
                Some(lease.generation),
            )
            .unwrap_or_else(|_| json_text(&body)),
            context: format!("{context}-stale"),
            error: Some(CONNECTION_CHANGED_DURING_REQUEST.to_owned()),
        })
    }

    /// `{id, result}`.
    pub fn result(&self, result: Value, context: &str) -> Option<Outgoing> {
        let mut message = Map::new();
        message.insert("id".into(), self.request_id.clone().into());
        message.insert("result".into(), result);
        self.publish(message, context)
    }

    /// `{id, error: {message, code?}}`.
    pub fn error(&self, message: &str, code: Option<&str>, context: &str) -> Option<Outgoing> {
        let mut error = Map::new();
        error.insert("message".into(), message.into());
        if let Some(code) = code {
            error.insert("code".into(), code.into());
        }
        let mut out = Map::new();
        out.insert("id".into(), self.request_id.clone().into());
        out.insert("error".into(), Value::Object(error));
        self.publish(out, context)
    }
}

/// Methods logged whatever their time (IMPORTANT_RPC_METHODS).
const IMPORTANT_RPC_METHODS: [&str; 26] = [
    "bridge.pause_others",
    "agent_history.get",
    "agent_history.entry",
    "agent_history.older",
    "agent_session.get",
    "file.read",
    "git.diff_file",
    "git.diff_files",
    "git.commit_file",
    "git.commit_preview",
    "git.file_action",
    "git.pull",
    "git.repo_action",
    "settings.update_repo",
    "settings.workspace_auto_sync.get",
    "settings.workspace_auto_sync.list",
    "settings.workspace_auto_sync.update",
    "settings.workspace_auto_sync.update_key",
    "settings.worktree_hooks.get",
    "settings.worktree_directory.get",
    "popup.close",
    "plugin.action.invoke",
    "terminal.watch_popup",
    "worktree.create",
    "worktree.open",
    "worktree.remove",
];

/// Review methods asked every few seconds: logged only when slow.
const REVIEW_POLL_METHODS: [&str; 5] = [
    "review.state",
    "review.prompts",
    "review.list",
    "review.snapshots",
    "review.activity",
];

const SLOW_RPC_LOG_MS: u64 = 750;
const LARGE_RPC_REPLY_CHARS: usize = 256 * 1024;

fn important(method: &str) -> bool {
    IMPORTANT_RPC_METHODS.contains(&method)
        || (method.starts_with("agent_chat.")
            && method != "agent_chat.state"
            && method != "agent_chat.subscribe")
}

/// shouldLogRpc.
pub fn should_log_rpc(method: Option<&str>, elapsed_ms: u64, failed: bool) -> bool {
    let Some(method) = method else {
        return failed;
    };
    if failed {
        return true;
    }
    if matches!(
        method,
        "bridge.ping" | "bridge.status" | "terminal.input" | "terminal.scroll"
    ) {
        return false;
    }
    if method == "terminal.resize" && elapsed_ms < SLOW_RPC_LOG_MS {
        return false;
    }
    important(method)
        || (method.starts_with("review.") && !REVIEW_POLL_METHODS.contains(&method))
        || elapsed_ms >= SLOW_RPC_LOG_MS
}

fn log_detail(value: &str) -> String {
    let cleaned: String = sanitize_connection_error(value)
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) {
                '?'
            } else {
                c
            }
        })
        .collect();
    roamgate_base::log::slice_utf16(cleaned.trim(), 300).to_owned()
}

/// One RPC's outcome, for its log line (logRpc).
pub struct RpcOutcome<'a> {
    pub client: &'a str,
    pub method: Option<&'a str>,
    pub elapsed_ms: u64,
    pub error: Option<&'a str>,
    pub connection: Option<&'a str>,
    pub reply_chars: Option<usize>,
}

/// logRpc: `rpc completed` when it failed, was slow, large or important.
pub fn log_rpc(logger: &Logger, outcome: &RpcOutcome) {
    let failed = outcome.error.is_some();
    let large = outcome.reply_chars.unwrap_or(0) >= LARGE_RPC_REPLY_CHARS;
    if !large && !should_log_rpc(outcome.method, outcome.elapsed_ms, failed) {
        return;
    }
    let level = rpc_log_level(outcome.method, !failed, outcome.error);
    // The fields cost a pass of the sanitizer's patterns each: not for a
    // line the level drops.
    let emitted = match level {
        LogLevel::Warn => LogLevel::Warn,
        _ => LogLevel::Debug,
    };
    if !logger.enabled(emitted) {
        return;
    }
    let mut fields = LogFields::new();
    fields.insert("status".into(), if failed { "error" } else { "ok" }.into());
    fields.insert("client".into(), outcome.client.into());
    fields.insert(
        "method".into(),
        outcome
            .method
            .map_or_else(|| "unknown".to_owned(), log_detail)
            .into(),
    );
    if let Some(connection) = outcome.connection {
        fields.insert("connection".into(), log_detail(connection).into());
    }
    fields.insert("duration_ms".into(), outcome.elapsed_ms.into());
    if large && let Some(chars) = outcome.reply_chars {
        fields.insert("reply_chars".into(), chars.into());
    }
    if let Some(detail) = outcome.error {
        fields.insert("detail".into(), log_detail(detail).into());
    }
    match level {
        LogLevel::Warn => logger.warn("rpc completed", Some(&fields)),
        _ => logger.debug("rpc completed", Some(&fields)),
    }
}

/// A value's JSON text, as `JSON.stringify` writes it: written straight to
/// a buffer (`Value`'s `Display` goes through a formatter, slower on the
/// large replies).
fn json_text<T: serde::Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_connections::routing::Lease;

    /// What went to each socket: its id, the line, the context, the key.
    type SentLine = (u64, String, String, Option<String>);

    #[derive(Default)]
    struct Sent(Mutex<Vec<SentLine>>);

    impl ClientSink for Sent {
        fn send(&self, socket_id: u64, payload: String, context: &str, key: Option<&str>) {
            self.0.lock().unwrap().push((
                socket_id,
                payload,
                context.to_owned(),
                key.map(str::to_owned),
            ));
        }
        fn end(&self, socket_id: u64, code: u16, reason: &str) {
            self.0.lock().unwrap().push((
                socket_id,
                format!("end {code} {reason}"),
                String::new(),
                None,
            ));
        }
    }

    struct One(Arc<AtomicBool>);

    impl ReadyConnections for One {
        fn default_id(&self) -> String {
            "local".into()
        }
        fn has(&self, connection_id: &str) -> bool {
            connection_id == "local"
        }
        fn ready_lease(&self, connection_id: &str) -> Option<Lease> {
            let current = self.0.clone();
            Some(Lease::new(
                connection_id,
                3,
                Arc::new(move || current.load(Ordering::SeqCst)),
            ))
        }
    }

    #[test]
    fn pushes_reach_the_sockets_they_name_in_their_envelope() {
        let sent = Arc::new(Sent::default());
        let clients = BrowserClients::new(sent.clone());
        assert_eq!(clients.add(1, Some("s1".into()), None).label, "c1");
        clients.add(2, Some("s2".into()), None);
        let push = |connection: Option<&str>, socket: Option<u64>, session: Option<&str>| Push {
            message: json!({"event": "x"}),
            key: Some("k".into()),
            connection_id: connection.map(str::to_owned),
            connection_generation: connection.map(|_| 4),
            socket_id: socket,
            session_id: session.map(str::to_owned),
        };
        clients.deliver(&push(Some("local"), None, None));
        clients.deliver(&push(None, Some(2), None));
        clients.deliver(&push(None, None, Some("s1")));
        let sent = sent.0.lock().unwrap().clone();
        assert_eq!(
            sent.iter()
                .map(|(id, line, _, _)| (*id, line.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (
                    1,
                    r#"{"connection_id":"local","connection_generation":4,"event":"x"}"#
                ),
                (
                    2,
                    r#"{"connection_id":"local","connection_generation":4,"event":"x"}"#
                ),
                (2, r#"{"event":"x"}"#),
                (1, r#"{"event":"x"}"#),
            ]
        );
        assert!(
            sent.iter()
                .all(|(_, _, context, key)| context == "core-push" && key.as_deref() == Some("k"))
        );
    }

    #[test]
    fn requests_are_checked_and_refused_as_bun_refuses_them() {
        let refused = |raw: &str| parse_request(raw).err().unwrap();
        assert_eq!(refused("{").payload, r#"{"error":{"message":"bad json"}}"#);
        assert_eq!(refused("[]").context, "invalid-request-envelope");
        let missing = refused(r#"{"id":"7","connection_id":"local","connection_generation":2}"#);
        assert_eq!(
            missing.payload,
            r#"{"connection_id":"local","connection_generation":2,"id":"7","error":{"message":"missing id/method"}}"#
        );
        assert_eq!(
            refused(r#"{"method":"x","connection_id":"-"}"#).payload,
            r#"{"error":{"message":"invalid connection_id"}}"#
        );
        let request = parse_request(r#"{"id":"1","method":"pane.list","connection_id":"nope"}"#)
            .ok()
            .unwrap();
        let registry = One(Arc::new(AtomicBool::new(true)));
        let routed = route_request(&request, &registry, 1, None).err().unwrap();
        assert_eq!(
            routed.payload,
            r#"{"connection_id":"nope","id":"1","error":{"message":"unknown connection: nope"}}"#
        );
    }

    #[test]
    fn a_reply_after_the_connection_changed_says_so_once() {
        let current = Arc::new(AtomicBool::new(true));
        let registry = One(current.clone());
        let request = parse_request(r#"{"id":"1","method":"pane.list"}"#)
            .ok()
            .unwrap();
        let route = route_request(&request, &registry, 1, None).ok().unwrap();
        let publisher = ReplyPublisher::new(route, &request.id);
        assert_eq!(
            publisher.result(json!([]), "pane.list").unwrap().payload,
            r#"{"connection_id":"local","connection_generation":3,"id":"1","result":[]}"#
        );
        current.store(false, Ordering::SeqCst);
        let stale = publisher.result(json!([]), "pane.list").unwrap();
        assert_eq!(
            (stale.context.as_str(), stale.error.as_deref()),
            ("pane.list-stale", Some(CONNECTION_CHANGED_DURING_REQUEST))
        );
        assert!(publisher.result(json!([]), "pane.list").is_none());
    }

    #[test]
    fn the_log_keeps_polls_quiet() {
        assert!(!should_log_rpc(Some("bridge.ping"), 5000, false));
        assert!(should_log_rpc(Some("bridge.ping"), 1, true));
        assert!(should_log_rpc(Some("agent_chat.send"), 1, false));
        assert!(!should_log_rpc(Some("agent_chat.state"), 1, false));
        assert!(!should_log_rpc(Some("review.state"), 1, false));
        assert!(should_log_rpc(Some("review.get"), 1, false));
        assert!(should_log_rpc(Some("pane.list"), 750, false));
        let meta = RpcMeta::parse(r#"{"id":"1","method":"pane.list","lane":"background"}"#);
        assert!(meta.background);
        assert_eq!(
            meta.connections("local"),
            (Some("local".into()), Some("local".into()))
        );
    }
}
