//! The Rust front (contract/wire/core-channel.md, Stage 2): Rust holds the
//! port, the auth gate and its logins, the web app's files and the `/ws`
//! transport; every other route, and every browser socket, is the core's
//! (the Bun server, or the standalone `roamgate core`), reached over the
//! core channel. The core runs its own routing on
//! what it gets, gate included, so a route keeps its checks whichever side
//! answers it.
//!
//! The listener is axum over hyper; [`Front::handle`] is the whole router,
//! so the tests drive it without a socket.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use bytes::Bytes;
use futures_util::StreamExt;
use http::request::Parts;
use roamgate_sidecar::peer::{Handler, HttpReply, HttpRequest, Peer, WsOpen};
use roamgate_sidecar::protocol::{Ctx, Message};
use roamgate_ws::socket::{Config as SocketConfig, Event, SocketHandle};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::auth::{Auth, unauthenticated_login_redirect};
use crate::response::{self, header};
use crate::static_files::{StaticFiles, StaticRequest};

mod rust_core;
mod sidecar;

pub use rust_core::{RustCoreLinkConfig, link_token, run_rust_core_link};
pub use sidecar::{SidecarCommand, SidecarConfig, StandaloneCore, run_sidecar};

/// The prefix of a rendered page's frame (shared/renderedPage.ts).
const RENDERED_PREFIX: &str = "/rendered/";

/// Where the core is: the peer while one is connected.
pub type CoreLink = watch::Receiver<Option<Peer>>;

/// The Rust core's link (contract/wire/core-channel.md, The Rust core's
/// link to the Rust front): its peer and the number of its connection.
pub type RustCoreLink = watch::Receiver<Option<(u64, Peer)>>;

/// The browser sockets the Rust core is asked for first: the voice
/// family's. It serves them while it owns the family, else they are the
/// Bun core's.
const RUST_CORE_SOCKETS: [&str; 2] = ["/api/voice/ws", "/api/voice/call/signalling"];

/// A browser socket the core serves, by the front's number.
enum Socket {
    /// Accepted by the core, the handshake not done: what it sent so far.
    Pending(Vec<Message>),
    Open(SocketHandle),
}

struct SocketEntry {
    socket: Socket,
    /// The login's cookie, for a logout to close its sockets.
    session: Option<String>,
    /// `ws`: through the flow; `raw`: as it is.
    flow: bool,
    /// Served by the Rust core's link of this number; None: the Bun core.
    rust: Option<u64>,
}

/// The browser sockets, shared with the core's handler.
#[derive(Default, Clone)]
pub struct Sockets(Arc<Mutex<HashMap<u64, SocketEntry>>>);

impl Sockets {
    fn apply(handle: &SocketHandle, flow: bool, message: &Message) {
        match message {
            Message::WsSend {
                data,
                context,
                key,
                binary,
                ..
            } => {
                if *binary {
                    use base64::Engine;
                    match base64::engine::general_purpose::STANDARD.decode(data) {
                        Ok(bytes) => handle.send_binary(bytes),
                        Err(_) => tracing::warn!(
                            target: "bridge.front",
                            "a binary message of the core that is not base64, dropped"
                        ),
                    }
                    return;
                }
                if flow {
                    handle.send(
                        data.clone(),
                        context.as_deref().unwrap_or("message"),
                        key.as_deref(),
                    );
                } else {
                    handle.send(data.clone(), "message", None);
                }
            }
            Message::WsDrop { key, .. } => handle.drop_coalesced(key),
            Message::WsEnd { code, reason, .. } => {
                handle.close(code.map(|code| (code, reason.as_deref().unwrap_or(""))))
            }
            _ => {}
        }
    }

    /// A `ws_send`, `ws_drop` or `ws_end` of the core.
    pub fn from_core(&self, message: Message) {
        let socket_id = match &message {
            Message::WsSend { socket_id, .. }
            | Message::WsDrop { socket_id, .. }
            | Message::WsEnd { socket_id, .. } => *socket_id,
            _ => return,
        };
        let mut sockets = self.0.lock().unwrap();
        let Some(entry) = sockets.get_mut(&socket_id) else {
            return;
        };
        match &mut entry.socket {
            Socket::Pending(held) => held.push(message),
            Socket::Open(handle) => Self::apply(handle, entry.flow, &message),
        }
    }

    fn open(&self, socket_id: u64, handle: SocketHandle) {
        let mut sockets = self.0.lock().unwrap();
        if let Some(entry) = sockets.get_mut(&socket_id) {
            if let Socket::Pending(held) = &entry.socket {
                for message in held {
                    Self::apply(&handle, entry.flow, message);
                }
            }
            entry.socket = Socket::Open(handle);
        }
    }

    /// Closes the sockets the Rust core's link `link` served: it went.
    fn drop_rust(&self, link: u64) {
        for entry in self.0.lock().unwrap().values() {
            if entry.rust == Some(link)
                && let Socket::Open(handle) = &entry.socket
            {
                handle.close(Some((1012, "Service Restart")));
            }
        }
    }

    /// Closes the sockets of a login that logged out.
    fn close_session(&self, token: &str) {
        for entry in self.0.lock().unwrap().values() {
            if entry.session.as_deref() == Some(token)
                && let Socket::Open(handle) = &entry.socket
            {
                handle.close(Some((4001, "Logged out")));
            }
        }
    }
}

/// What the front does when its standalone core asks it to exit.
pub type ScheduleExit = Arc<dyn Fn() + Send + Sync>;

/// A new login's cookie (`Auth::new_session_cookie`), for a standalone
/// core's `voice.session_cookie`.
pub type SessionCookie = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The front's handler of the core's messages.
pub struct FrontHandler {
    pub sockets: Sockets,
    /// Set for a standalone core: `server.scheduleExit` (after an install
    /// the supervisor starts the new one) is the front's to do.
    pub schedule_exit: Option<ScheduleExit>,
    /// Set for a standalone core: a call handed to another device gets a
    /// login of the front's auth (`voice.session_cookie`).
    pub session_cookie: Option<SessionCookie>,
}

impl Handler for FrontHandler {
    fn socket(&self, _peer: &Peer, message: Message) {
        self.sockets.from_core(message);
    }

    fn reverse_call(
        &self,
        _peer: &Peer,
        target: String,
        _args: Value,
        _ctx: Ctx,
    ) -> roamgate_sidecar::peer::BoxFuture<Result<Value, roamgate_sidecar::protocol::RpcError>>
    {
        let exit = self
            .schedule_exit
            .clone()
            .filter(|_| target == "server.scheduleExit");
        let cookie = self
            .session_cookie
            .clone()
            .filter(|_| target == "voice.session_cookie");
        Box::pin(async move {
            if let Some(exit) = exit {
                exit();
                return Ok(serde_json::json!({"scheduled": true}));
            }
            if let Some(cookie) = cookie {
                return Ok(serde_json::json!({"cookie": cookie()}));
            }
            Err(roamgate_sidecar::protocol::RpcError::with_code(
                format!("unknown target {target}"),
                "unknown_target",
            ))
        })
    }
}

/// What the router needs.
pub struct Front {
    pub auth: Auth,
    pub static_files: StaticFiles,
    /// The instance's title suffix, read on each request as Bun does.
    pub title_suffix: Box<dyn Fn() -> String + Send + Sync>,
    pub core: CoreLink,
    /// The Rust core's link, while one is connected.
    pub rust_core: RustCoreLink,
    pub sockets: Sockets,
    /// How long a request waits for the core to connect (its start, a
    /// restart) before a 503.
    pub core_wait: std::time::Duration,
    next_socket: AtomicU64,
}

fn into_axum(response: response::Response) -> http::Response<Body> {
    response.map(Body::from)
}

fn plain(status: u16, text: &'static str) -> http::Response<Body> {
    into_axum(response::text(status, &[], text))
}

fn is_upgrade(parts: &Parts) -> bool {
    header(&parts.headers, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn path_and_query(parts: &Parts) -> String {
    parts.uri.path_and_query().map_or_else(
        || parts.uri.path().to_owned(),
        |value| value.as_str().to_owned(),
    )
}

fn channel_headers(parts: &Parts) -> Vec<(String, String)> {
    parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect()
}

fn session_id_of(token: Option<&str>) -> Option<String> {
    use sha2::{Digest, Sha256};
    token.map(|token| hex::encode(&Sha256::digest(token.as_bytes())[..8]))
}

fn reply_into_axum(reply: HttpReply) -> http::Response<Body> {
    let mut builder = http::Response::builder().status(reply.status);
    for (name, value) in &reply.headers {
        builder = builder.header(name, value);
    }
    let body = match reply.body {
        Some(receiver) => Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async move {
                let chunk = receiver.chunk().await?;
                Some((Ok::<_, std::io::Error>(Bytes::from(chunk)), receiver))
            },
        )),
        None => Body::empty(),
    };
    builder
        .body(body)
        .unwrap_or_else(|_| plain(502, "bad response from the core"))
}

impl Front {
    pub fn new(
        auth: Auth,
        static_files: StaticFiles,
        title_suffix: Box<dyn Fn() -> String + Send + Sync>,
        core: CoreLink,
        sockets: Sockets,
    ) -> Self {
        Self {
            auth,
            static_files,
            title_suffix,
            core,
            rust_core: watch::channel(None).1,
            sockets,
            core_wait: std::time::Duration::from_secs(30),
            next_socket: AtomicU64::new(1),
        }
    }

    /// Serves the voice family's sockets from the Rust core's link while
    /// it owns the family.
    pub fn with_rust_core(mut self, link: RustCoreLink) -> Self {
        self.rust_core = link;
        self
    }

    async fn peer(&self) -> Option<Peer> {
        let mut core = self.core.clone();
        let connected = core.wait_for(|peer| peer.as_ref().is_some_and(|peer| !peer.is_closed()));
        match tokio::time::timeout(self.core_wait, connected).await {
            Ok(Ok(peer)) => peer.clone(),
            _ => None,
        }
    }

    /// The whole router.
    pub async fn handle(
        self: &Arc<Self>,
        request: http::Request<Body>,
        client_ip: String,
    ) -> http::Response<Body> {
        let (parts, body) = request.into_parts();
        let path = parts.uri.path().to_owned();
        let method = parts.method.as_str().to_owned();
        let cross_site = header(&parts.headers, "sec-fetch-site").as_deref() == Some("cross-site");

        // A rendered page's frame, and anything its sandboxed frames ask
        // for: the core's, before any login.
        if path.starts_with(RENDERED_PREFIX) || (cross_site && !is_upgrade(&parts)) {
            return self.forward(parts, body, client_ip).await;
        }
        if let Some(response) = self.auth.handle_token_login(&parts, &client_ip) {
            return into_axum(response);
        }
        if path == "/health" || path == "/healthz" {
            return into_axum(response::text(
                200,
                &[("content-type", "text/plain; charset=utf-8")],
                "Ok",
            ));
        }
        if path == "/api/voice/call/handoff" {
            return self.forward(parts, body, client_ip).await;
        }
        if path == "/api/login/pin" && method == "POST" {
            return into_axum(
                self.auth
                    .handle_pin_login(&parts, Some(body.into_data_stream()), &client_ip)
                    .await,
            );
        }
        if path == "/api/login" && method == "POST" {
            return into_axum(
                self.auth
                    .handle_login(&parts, Some(body.into_data_stream()), &client_ip)
                    .await,
            );
        }
        if path == "/login" {
            return into_axum(self.auth.login_page(Some(&parts.headers)));
        }
        if path == "/roamgate-icon-192.png" {
            return self.serve_static(&parts).await;
        }
        if path == "/api/logout" {
            let response = self.auth.handle_logout(&parts);
            let token = self.auth.session_token(&parts.headers);
            if response.status().is_success()
                && self.auth.config().auth_required
                && let Some(token) = token
            {
                self.sockets.close_session(&token);
            }
            return into_axum(response);
        }
        if !self.auth.is_authed(&parts.headers) {
            let accept = header(&parts.headers, "accept").unwrap_or_default();
            if method == "GET" && accept.contains("text/html") {
                return into_axum(unauthenticated_login_redirect());
            }
            return plain(401, "unauthorized");
        }
        if is_upgrade(&parts) {
            return self.upgrade(parts, body, client_ip).await;
        }
        if path.starts_with("/api/") || path == "/api" || path == "/ws" {
            return self.forward(parts, body, client_ip).await;
        }
        self.serve_static(&parts).await
    }

    async fn serve_static(&self, parts: &Parts) -> http::Response<Body> {
        let accept = header(&parts.headers, "accept");
        let request = StaticRequest {
            method: parts.method.as_str(),
            raw_path: parts.uri.path(),
            accept: accept.as_deref(),
        };
        into_axum(
            self.static_files
                .serve(request, &(self.title_suffix)())
                .await,
        )
    }

    fn ctx(&self, parts: &Parts, client_ip: String, socket_id: Option<u64>) -> Ctx {
        Ctx {
            session_id: session_id_of(self.auth.session_token(&parts.headers).as_deref()),
            client_ip: Some(client_ip),
            socket_id,
            ..Ctx::default()
        }
    }

    /// An `http` to the core, the request as the browser sent it.
    async fn forward(&self, parts: Parts, body: Body, client_ip: String) -> http::Response<Body> {
        let Some(peer) = self.peer().await else {
            return plain(503, "the server is starting");
        };
        let has_body = !matches!(parts.method, http::Method::GET | http::Method::HEAD);
        let receiver = has_body.then(|| {
            let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
            let mut stream = body.into_data_stream();
            tokio::spawn(async move {
                while let Some(Ok(chunk)) = stream.next().await {
                    if tx.send(chunk.to_vec()).await.is_err() {
                        break;
                    }
                }
            });
            rx
        });
        let request = HttpRequest {
            method: parts.method.as_str().to_owned(),
            url: path_and_query(&parts),
            headers: channel_headers(&parts),
            ctx: self.ctx(&parts, client_ip, None),
        };
        match peer.http(request, receiver).await {
            Ok(reply) => reply_into_axum(reply),
            Err(error) => {
                tracing::warn!(target: "bridge.front", "core request failed: {}", error.message);
                plain(502, "the server's core did not answer")
            }
        }
    }

    /// A browser socket: the core decides, the front terminates it.
    async fn upgrade(
        self: &Arc<Self>,
        parts: Parts,
        body: Body,
        client_ip: String,
    ) -> http::Response<Body> {
        let Some(bun) = self.peer().await else {
            return plain(503, "the server is starting");
        };
        let mut request = http::Request::from_parts(parts, body);
        let accepted = match roamgate_ws::upgrade::accept(&mut request, true) {
            Ok(accepted) => accepted,
            Err(refusal) => return *refusal,
        };
        let (parts, _) = request.into_parts();
        let socket_id = self.next_socket.fetch_add(1, Ordering::Relaxed);
        let session = self.auth.session_token(&parts.headers);
        self.sockets.0.lock().unwrap().insert(
            socket_id,
            SocketEntry {
                socket: Socket::Pending(Vec::new()),
                session,
                flow: parts.uri.path() == "/ws",
                rust: None,
            },
        );
        let open = WsOpen {
            socket_id,
            method: parts.method.as_str().to_owned(),
            url: path_and_query(&parts),
            headers: channel_headers(&parts),
            ctx: self.ctx(&parts, client_ip, Some(socket_id)),
        };
        let (peer, answer) = self.open_socket(bun, parts.uri.path(), open).await;
        let accepted_by_core = match &answer {
            Ok(result) => result["accepted"] == Value::Bool(true),
            Err(_) => false,
        };
        if !accepted_by_core {
            self.sockets.0.lock().unwrap().remove(&socket_id);
            return match answer {
                Ok(result) => refused_response(&result),
                Err(error) => {
                    tracing::warn!(target: "bridge.front", "core socket refused: {}", error.message);
                    plain(502, "the server's core did not answer")
                }
            };
        }
        let flow = answer
            .as_ref()
            .ok()
            .and_then(|result| result["transport"].as_str())
            .map_or(parts.uri.path() == "/ws", |transport| transport == "ws");
        if let Some(entry) = self.sockets.0.lock().unwrap().get_mut(&socket_id) {
            entry.flow = flow;
        }
        let front = self.clone();
        let on_upgrade = accepted.on_upgrade;
        let deflate = accepted.deflate;
        tokio::spawn(async move {
            let io = match roamgate_ws::upgrade::upgraded(on_upgrade).await {
                Ok(io) => io,
                Err(_) => {
                    front.socket_closed(&peer, socket_id, Some(1006), String::new());
                    return;
                }
            };
            let (handle, mut events) =
                roamgate_ws::socket::spawn(io, deflate, SocketConfig::default());
            front.sockets.open(socket_id, handle);
            while let Some(event) = events.recv().await {
                match event {
                    Event::Text { text, .. } => peer.send(&Message::WsMessage {
                        socket_id,
                        data: text,
                        binary: false,
                    }),
                    Event::Binary { data } => {
                        use base64::Engine;
                        peer.send(&Message::WsMessage {
                            socket_id,
                            data: base64::engine::general_purpose::STANDARD.encode(data),
                            binary: true,
                        })
                    }
                    Event::Closed { code, reason } => {
                        front.socket_closed(&peer, socket_id, code, reason);
                        return;
                    }
                }
            }
            front.socket_closed(&peer, socket_id, Some(1006), String::new());
        });
        accepted.response
    }

    /// Asks the Rust core first for a socket it may serve, then the Bun
    /// core: the peer that answered, and its answer.
    async fn open_socket(
        &self,
        bun: Peer,
        path: &str,
        open: WsOpen,
    ) -> (Peer, Result<Value, roamgate_sidecar::protocol::RpcError>) {
        let rust = RUST_CORE_SOCKETS
            .contains(&path)
            .then(|| self.rust_core.borrow().clone())
            .flatten()
            .filter(|(_, peer)| !peer.is_closed());
        if let Some((link, peer)) = rust {
            let socket_id = open.socket_id;
            if let Some(entry) = self.sockets.0.lock().unwrap().get_mut(&socket_id) {
                entry.rust = Some(link);
            }
            let answer = peer.ws_open(open.clone()).await;
            let passed = match &answer {
                Ok(result) => result["pass"] == Value::Bool(true),
                Err(error) => {
                    tracing::warn!(target: "bridge.front", "the Rust core did not answer a socket: {}", error.message);
                    true
                }
            };
            if !passed {
                return (peer, answer);
            }
            if let Some(entry) = self.sockets.0.lock().unwrap().get_mut(&socket_id) {
                entry.rust = None;
            }
        }
        let answer = bun.ws_open(open).await;
        (bun, answer)
    }

    fn socket_closed(&self, peer: &Peer, socket_id: u64, code: Option<u16>, reason: String) {
        if self.sockets.0.lock().unwrap().remove(&socket_id).is_some() {
            peer.send(&Message::WsClose {
                socket_id,
                code,
                reason,
            });
        }
    }
}

fn refused_response(result: &Value) -> http::Response<Body> {
    let status = result["status"].as_u64().unwrap_or(400) as u16;
    let mut builder = http::Response::builder().status(status);
    for pair in result["headers"].as_array().into_iter().flatten() {
        if let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) {
            builder = builder.header(name, value);
        }
    }
    let body = result["body"].as_str().unwrap_or("").to_owned();
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| plain(400, "websocket upgrade failed"))
}

/// axum's handler: every request goes to [`Front::handle`].
pub async fn route(
    State(front): State<Arc<Front>>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    request: http::Request<Body>,
) -> http::Response<Body> {
    front.handle(request, address.ip().to_string()).await
}

/// The router over [`Front`].
pub fn app(front: Arc<Front>) -> axum::Router {
    axum::Router::new().fallback(route).with_state(front)
}

/// The web app's directories: the configured one, then the build's.
pub fn static_dirs(public_dir: PathBuf, built: Option<PathBuf>) -> StaticFiles {
    StaticFiles {
        public_dir,
        built_public_dir: built,
    }
}

#[cfg(test)]
mod tests;
