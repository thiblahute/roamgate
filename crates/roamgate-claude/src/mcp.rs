//! A turn's tools for Claude Code (`assistant/claude-mcp.ts`): a Streamable
//! HTTP MCP server on loopback, plain HTTP whatever the bridge serves, so
//! the CLI needs no certificate. Each turn gets its own bearer token, valid
//! only while the turn runs: a call from a turn that ended, or from
//! anything else, is refused.
//!
//! The server is generic: Ranger, the reviews agent and voice's tool
//! servers each open one under their own name, with their tools as
//! [`McpTool`]s. Its answers are the TS server's byte for byte (JSON-RPC
//! 2.0, `Response.json`'s content type).
//!
//! Contract recording: the TS wraps the listener in
//! `recordServe(contractRecorder(), "mcp")`. The Rust side has no recorder
//! of served HTTP yet (`roamgate-base::record` records, but nothing wraps
//! an axum app); the default listener records nothing until one exists.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures_util::future::BoxFuture;
use roamgate_agents::js;
use roamgate_base::paths::random_uuid;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

/// The MCP server name: Claude Code calls its tools `mcp__ranger__<name>`.
pub const RANGER_MCP_SERVER: &str = "ranger";
/// What a tool failure that is not the user's becomes.
pub const MASKED_TOOL_ERROR: &str =
    "Workspace tool unavailable, stale, or outside the authorized scope.";
/// The protocol version answered to a client that names none.
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
/// `Response.json`'s content type.
const JSON_CONTENT_TYPE: &str = "application/json;charset=utf-8";
/// Bun's default `maxRequestBodySize`.
const MAX_BODY: usize = 128 * 1024 * 1024;

/// A failure of a tool, or of a turn: whether its message may be shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeError {
    /// `AssistantUserError` (and the platform refusals): shown as it is.
    User(String),
    /// Any other failure: a tool's is masked, a turn's is the caller's to
    /// mask or log.
    Internal(String),
}

impl ClaudeError {
    pub fn user(message: impl Into<String>) -> Self {
        Self::User(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::User(message) | Self::Internal(message) => message,
        }
    }

    /// Whether the message may be shown as it is.
    pub fn surfaced(&self) -> bool {
        matches!(self, Self::User(_))
    }
}

impl std::fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ClaudeError {}

impl From<io::Error> for ClaudeError {
    fn from(error: io::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

/// What a tool gives the model: its text, and the sources it read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct McpToolResult {
    pub text: String,
    pub sources: Option<Vec<Value>>,
}

impl McpToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            sources: None,
        }
    }
}

/// A tool's call: its arguments (`{}` when the client sent none) and the
/// turn's cancellation.
pub type McpToolCall = Arc<
    dyn Fn(Value, CancellationToken) -> BoxFuture<'static, Result<McpToolResult, ClaudeError>>
        + Send
        + Sync,
>;

/// A tool the server lists and runs (`RangerTool`'s MCP side).
#[derive(Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    /// Its JSON Schema, listed as `inputSchema`.
    pub parameters: Value,
    pub call: McpToolCall,
}

impl std::fmt::Debug for McpTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpTool")
            .field("name", &self.name)
            .field("description", &self.description)
            .finish_non_exhaustive()
    }
}

/// Sources a tool cited, as it returns them.
pub type SourcesSink = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

/// One Claude Code turn's view of the tools.
pub struct McpTurn {
    pub tools: Vec<McpTool>,
    /// Ends the tool calls still queued when the turn stops.
    pub cancel: CancellationToken,
    pub sources: Option<SourcesSink>,
}

/// A request as the listener got it.
#[derive(Debug, Clone, Default)]
pub struct McpRequest {
    pub method: String,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

impl McpRequest {
    /// A POST with this `Authorization` and JSON body.
    pub fn post(authorization: Option<&str>, body: &Value) -> Self {
        Self {
            method: "POST".to_owned(),
            authorization: authorization.map(str::to_owned),
            body: js::stringify(body).into_bytes(),
        }
    }
}

/// An answer: status, headers and body (none for 202, 401 and 405).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
}

impl McpResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: None,
        }
    }

    fn json(value: &Value) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type", JSON_CONTENT_TYPE.to_owned())],
            body: Some(js::stringify(value).into_bytes()),
        }
    }

    /// The body as JSON, for tests and callers.
    pub fn body_json(&self) -> Option<Value> {
        self.body
            .as_deref()
            .and_then(|body| serde_json::from_slice(body).ok())
    }
}

/// A started listener: its `/mcp` URL and how to stop it.
pub struct McpListener {
    pub url: String,
    pub stop: Box<dyn FnOnce() + Send>,
}

/// Starts the listener serving a handler (the default: [`loopback_listen`]).
pub type Listen = Box<dyn Fn(McpHandler) -> io::Result<McpListener> + Send + Sync>;

struct ActiveTurn {
    tools: Vec<McpTool>,
    cancel: CancellationToken,
    sources: Option<SourcesSink>,
    /// The whole tool round runs under it: no call overlaps another of the
    /// same turn. Tokio's mutex is fair, so calls run in their order.
    queue: tokio::sync::Mutex<()>,
    closed: AtomicBool,
}

struct Inner {
    name: String,
    listen: Listen,
    turns: Mutex<HashMap<String, Arc<ActiveTurn>>>,
    listener: Mutex<Option<McpListener>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(listener) = self.listener.get_mut().ok().and_then(Option::take) {
            (listener.stop)();
        }
    }
}

/// The handler a listener serves; it holds the server weakly, so a
/// dropped server answers nothing more.
#[derive(Clone)]
pub struct McpHandler(Weak<Inner>);

impl McpHandler {
    pub async fn handle(&self, request: McpRequest) -> McpResponse {
        match self.0.upgrade() {
            Some(inner) => handle(&inner, request).await,
            None => McpResponse::empty(401),
        }
    }
}

/// The server (`createRangerMcp`): cheap to clone, shared by the turns of
/// one agent.
#[derive(Clone)]
pub struct ClaudeMcp(Arc<Inner>);

impl ClaudeMcp {
    /// A server on loopback named `name` (`createRangerMcp(undefined,
    /// name)`).
    pub fn new(name: impl Into<String>) -> Self {
        Self::with_listen(name, Box::new(loopback_listen))
    }

    /// A server on the listener `listen` starts (tests: none at all).
    pub fn with_listen(name: impl Into<String>, listen: Listen) -> Self {
        Self(Arc::new(Inner {
            name: name.into(),
            listen,
            turns: Mutex::new(HashMap::new()),
            listener: Mutex::new(None),
        }))
    }

    /// Claude Code calls its tools `mcp__<name>__<tool>`.
    pub fn name(&self) -> &str {
        &self.0.name
    }

    /// Serves `turn`'s tools until the lease is closed (or dropped). The
    /// listener starts with the first lease.
    pub fn open(&self, turn: McpTurn) -> io::Result<McpLease> {
        let url = {
            let mut listener = self.0.listener.lock().unwrap();
            if listener.is_none() {
                *listener = Some((self.0.listen)(McpHandler(Arc::downgrade(&self.0)))?);
            }
            listener.as_ref().unwrap().url.clone()
        };
        let token = random_uuid();
        let active = Arc::new(ActiveTurn {
            tools: turn.tools,
            cancel: turn.cancel,
            sources: turn.sources,
            queue: tokio::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
        });
        self.0
            .turns
            .lock()
            .unwrap()
            .insert(token.clone(), active.clone());
        let mut server = Map::new();
        server.insert(
            self.0.name.clone(),
            json!({
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {token}") },
            }),
        );
        Ok(McpLease {
            config: js::stringify(&json!({ "mcpServers": server })),
            token,
            turn: active,
            server: Arc::downgrade(&self.0),
            closed: false,
        })
    }

    /// The handler the listener serves (for tests, and custom listeners).
    pub fn handler(&self) -> McpHandler {
        McpHandler(Arc::downgrade(&self.0))
    }

    /// Answers one request.
    pub async fn handle(&self, request: McpRequest) -> McpResponse {
        handle(&self.0, request).await
    }

    /// Ends every turn and stops the listener; the next lease starts
    /// another.
    pub fn stop(&self) {
        for (_, turn) in self.0.turns.lock().unwrap().drain() {
            turn.closed.store(true, Ordering::SeqCst);
        }
        if let Some(listener) = self.0.listener.lock().unwrap().take() {
            (listener.stop)();
        }
    }
}

/// A turn's hold on the server.
pub struct McpLease {
    /// The `--mcp-config` value naming this turn's server.
    pub config: String,
    token: String,
    turn: Arc<ActiveTurn>,
    server: Weak<Inner>,
    closed: bool,
}

impl McpLease {
    /// The turn's calls are refused from now on; a queued one runs no tool.
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.turn.closed.store(true, Ordering::SeqCst);
        if let Some(server) = self.server.upgrade() {
            server.turns.lock().unwrap().remove(&self.token);
        }
    }
}

impl Drop for McpLease {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Debug)]
struct RpcError {
    code: i64,
    message: &'static str,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle(inner: &Inner, request: McpRequest) -> McpResponse {
    if request.method != "POST" {
        let mut response = McpResponse::empty(405);
        response.headers.push(("allow", "POST".to_owned()));
        return response;
    }
    let token = request
        .authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty() && !token.contains(['\n', '\r']));
    let turn = token.and_then(|token| inner.turns.lock().unwrap().get(token).cloned());
    let Some(turn) = turn else {
        return McpResponse::empty(401);
    };
    let Some(message) = js::parse(&String::from_utf8_lossy(&request.body)) else {
        return McpResponse::json(&rpc_error(Value::Null, -32700, "Parse error"));
    };
    let Value::Object(message) = message else {
        return McpResponse::json(&rpc_error(Value::Null, -32600, "Invalid request"));
    };
    // Notifications get no answer.
    let Some(id) = message.get("id").cloned() else {
        return McpResponse::empty(202);
    };
    match call(&inner.name, &turn, &message).await {
        Ok(result) => McpResponse::json(&json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err(error) => McpResponse::json(&rpc_error(id, error.code, error.message)),
    }
}

async fn call(
    name: &str,
    turn: &ActiveTurn,
    message: &Map<String, Value>,
) -> Result<Value, RpcError> {
    let empty = Map::new();
    // `message.params ?? {}`: a property of anything else is undefined.
    let params = message
        .get("params")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    match message.get("method").and_then(Value::as_str) {
        Some("initialize") => Ok(json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(MCP_PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": name, "version": "1" },
        })),
        Some("ping") => Ok(json!({})),
        Some("tools/list") => Ok(json!({
            "tools": turn
                .tools
                .iter()
                .map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.parameters,
                }))
                .collect::<Vec<_>>(),
        })),
        Some("tools/call") => {
            let wanted = params.get("name").and_then(Value::as_str);
            let Some(tool) = turn
                .tools
                .iter()
                .find(|tool| Some(tool.name.as_str()) == wanted)
            else {
                return Err(RpcError {
                    code: -32602,
                    message: "Unknown tool",
                });
            };
            // Serialize the entire tool round, including readers. A
            // sequential operation must never overlap any other call in
            // this turn.
            let _round = turn.queue.lock().await;
            let result = if turn.closed.load(Ordering::SeqCst) {
                Err(ClaudeError::internal("The Ranger turn ended"))
            } else if turn.cancel.is_cancelled() {
                Err(ClaudeError::internal("This operation was aborted"))
            } else {
                let arguments = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(arguments) => arguments.clone(),
                };
                (tool.call)(arguments, turn.cancel.clone()).await
            };
            Ok(match result {
                Ok(result) => {
                    let sources = result.sources.unwrap_or_default();
                    let text = if sources.is_empty() {
                        result.text
                    } else {
                        if let Some(sink) = &turn.sources {
                            sink(sources.clone());
                        }
                        format!(
                            "{}\n\nSources: {}",
                            result.text,
                            js::stringify(&Value::Array(sources))
                        )
                    };
                    json!({ "content": [{ "type": "text", "text": text }] })
                }
                Err(error) => {
                    let text = if error.surfaced() {
                        error.message()
                    } else {
                        MASKED_TOOL_ERROR
                    };
                    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
                }
            })
        }
        _ => Err(RpcError {
            code: -32601,
            message: "Method not found",
        }),
    }
}

/// The default listener: `http://127.0.0.1:<port>/mcp` (any path answers,
/// as Bun's `fetch` does), stopped gracefully. Needs a Tokio runtime.
pub fn loopback_listen(handler: McpHandler) -> io::Result<McpListener> {
    use axum::body::{Body, Bytes};
    use axum::extract::DefaultBodyLimit;
    use axum::http::{HeaderMap, Method, StatusCode, header};

    let socket = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    socket.set_nonblocking(true)?;
    let port = socket.local_addr()?.port();
    let listener = tokio::net::TcpListener::from_std(socket)?;
    let app = axum::Router::new()
        .fallback(move |method: Method, headers: HeaderMap, body: Bytes| {
            let handler = handler.clone();
            async move {
                let request = McpRequest {
                    method: method.as_str().to_owned(),
                    authorization: headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                    body: body.to_vec(),
                };
                let answer = handler.handle(request).await;
                let mut response = axum::http::Response::builder()
                    .status(StatusCode::from_u16(answer.status).unwrap_or(StatusCode::OK));
                for (name, value) in answer.headers {
                    response = response.header(name, value);
                }
                response
                    .body(answer.body.map(Body::from).unwrap_or_else(Body::empty))
                    .unwrap_or_default()
            }
        })
        .layer(DefaultBodyLimit::max(MAX_BODY));
    let shutdown = CancellationToken::new();
    let stopped = shutdown.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(stopped.cancelled_owned())
            .await;
    });
    Ok(McpListener {
        url: format!("http://127.0.0.1:{port}/mcp"),
        stop: Box::new(move || shutdown.cancel()),
    })
}

#[cfg(test)]
mod tests;
