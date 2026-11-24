//! The core process (`roamgate core`): connects to the front named by
//! `ROAMGATE_CORE_CHANNEL`, proves itself with `ROAMGATE_CORE_TOKEN`, and
//! serves the families it is given (the `roamgate` binary's, see
//! [`crate::family`]) until the channel closes. The `test.echo` family
//! exists only for the channel's cross-language test, with
//! `ROAMGATE_CORE_TEST=1` on a debug build.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use roamgate_base::clock::TestClock;
use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::log::{LogLayer, LogLevel, Logger, LoggerOptions, parse_log_level};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::family::{CoreFamily, Families, FamilyContext, INTERNAL_PREFIX, pass_to_bun};
use crate::owners::{Owners, families as declared_families, implemented};
use crate::peer::{
    BodyReceiver, BoxFuture, Handler, HttpRequest, HttpResponse, IncomingCall, Peer, PeerOptions,
    WsOpen, say_hello,
};
use crate::protocol::{
    Message, PROTOCOL, Push, RpcError, ShadowSettings, Side, family_of, http_family_of,
};
use crate::standalone::{LocalRouter, STANDALONE_ENV, Standalone};
use crate::transport;

pub const CHANNEL_ENV: &str = "ROAMGATE_CORE_CHANNEL";
pub const TOKEN_ENV: &str = "ROAMGATE_CORE_TOKEN";
pub const TEST_ENV: &str = "ROAMGATE_CORE_TEST";
/// The Rust front's link for the core (contract/wire/core-channel.md, The
/// Rust core's link to the Rust front): set by the Rust front on its Bun
/// core, whose Rust core inherits them.
pub const FRONT_CHANNEL_ENV: &str = "ROAMGATE_FRONT_CHANNEL";
pub const FRONT_TOKEN_ENV: &str = "ROAMGATE_FRONT_TOKEN";

/// Exit codes of `roamgate core`.
pub mod exit {
    /// The channel closed: the front stopped.
    pub const CLOSED: u8 = 0;
    /// It could not connect, or the front broke the protocol.
    pub const FAILED: u8 = 1;
    /// Started without its channel variables.
    pub const USAGE: u8 = 2;
    /// The front refused it (wrong token or protocol).
    pub const REFUSED: u8 = 3;
}

/// The parity suite's proof that a family was served by Rust: a debug
/// build appends `<family> <what>` to the file this names.
pub const SERVED_LOG_ENV: &str = "ROAMGATE_CORE_SERVED_LOG";

/// Notes that the core served `what` of `family` (a debug build with
/// `ROAMGATE_CORE_SERVED_LOG` only; nothing otherwise).
pub fn note_served(env: &dyn Env, family: &str, what: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(path) = env.var(SERVED_LOG_ENV).filter(|path| !path.is_empty()) else {
        return;
    };
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        // One write of the whole line: two families noting at once never
        // interleave (an append of a short line is atomic).
        let _ = file.write_all(format!("{family} {what}\n").as_bytes());
    }
}

/// Whether the test family is on: the variable, on a debug build only.
pub fn test_family_on(env: &dyn Env) -> bool {
    cfg!(debug_assertions) && env.var(TEST_ENV).as_deref() == Some("1")
}

/// Logs as the Bun server does, at ROAMGATE_LOG_LEVEL, scope `core`.
fn install_logger(env: &dyn Env, clock: SharedClock) {
    let level = roamgate_env(env, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let logger = Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some("core".into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    });
    use tracing_subscriber::layer::SubscriberExt;
    let subscriber = tracing_subscriber::registry().with(LogLayer::new(logger));
    let _ = tracing::subscriber::set_global_default(subscriber);
}

/// Whether this core is a Rust front's own (`ROAMGATE_CORE_STANDALONE=1`):
/// no Bun anywhere, see [`crate::standalone`].
pub fn standalone_on(env: &dyn Env) -> bool {
    env.var(STANDALONE_ENV).as_deref() == Some("1")
}

/// The families whose paths are a connection's endpoints: a standalone
/// core's front family resolves their connection first.
const ROUTED_IN_PLACE: [&str; 2] = ["agent_sessions", "workspace"];

/// The family a standalone core gives what no family declares: the
/// `/ws` socket and its RPCs, and the routes Bun answered itself.
pub const FRONT_FAMILY: &str = "front";

/// Runs the core with `families`; returns its exit code.
pub async fn run_core(env: &dyn Env, version: &str, families: Families) -> u8 {
    let clock: SharedClock = Arc::new(SystemClock);
    install_logger(env, clock.clone());
    let (Some(address), Some(token)) = (
        env.var(CHANNEL_ENV).filter(|value| !value.is_empty()),
        env.var(TOKEN_ENV).filter(|value| !value.is_empty()),
    ) else {
        eprintln!(
            "roamgate core: {CHANNEL_ENV} and {TOKEN_ENV} are set by the server that runs it"
        );
        return exit::USAGE;
    };
    let test = test_family_on(env);
    let standalone = standalone_on(env).then(|| {
        Arc::new(Standalone::new(
            env.var(SERVED_LOG_ENV).filter(|_| cfg!(debug_assertions)),
        ))
    });
    let mut stream = match transport::connect(&address).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::error!(address, %error, "cannot reach the core channel");
            return exit::FAILED;
        }
    };
    let mut names: Vec<&str> = families.iter().map(|family| family.name()).collect();
    if test {
        names.push("test.echo");
    }
    let hello_families = implemented(test, &names);
    let hello = Message::Hello {
        protocol: PROTOCOL,
        token,
        side: Side::Rust,
        version: version.to_owned(),
        pid: std::process::id(),
        families: hello_families.clone(),
        test,
    };
    // Linked to the Rust front before the Bun core knows this core: by the
    // time the Bun core routes it a family, the front can give it that
    // family's sockets.
    let link = match (
        env.var(FRONT_CHANNEL_ENV).filter(|value| !value.is_empty()),
        env.var(FRONT_TOKEN_ENV).filter(|value| !value.is_empty()),
    ) {
        // A standalone core's front sends it every socket on the channel.
        (Some(address), Some(token)) if standalone.is_none() => {
            let hello = Message::Hello {
                protocol: PROTOCOL,
                token,
                side: Side::Rust,
                version: version.to_owned(),
                pid: std::process::id(),
                families: hello_families.clone(),
                test,
            };
            link_front(&address, &hello).await
        }
        _ => None,
    };
    let owners = Owners::new(Side::Rust, test);
    let followed = match say_hello(&mut stream, &hello).await {
        Ok(Message::Welcome {
            owners: table,
            shadow,
            clock,
            ..
        }) => {
            owners.set(table, shadow);
            clock
        }
        Ok(_) => return exit::FAILED,
        Err(crate::peer::HandshakeError::Refused(reason)) => {
            tracing::error!(reason, "the server refused this core");
            return exit::REFUSED;
        }
        Err(error) => {
            tracing::error!(%error, "core channel handshake failed");
            return exit::FAILED;
        }
    };
    // A debug core follows the front's test clock; a release core never
    // runs on a virtual one (contract/wire/test-clock.md).
    let test_clock = followed
        .filter(|_| cfg!(debug_assertions))
        .map(TestClock::new);
    let family_clock: SharedClock = match &test_clock {
        Some(test_clock) => Arc::new(test_clock.clone()),
        None => clock.clone(),
    };
    tracing::debug!(test, "core connected");
    let families: Families = families
        .into_iter()
        .filter(|family| hello_families.iter().any(|name| name == family.name()))
        .collect();
    let handler = Arc::new(CoreHandler {
        served_log: env.var(SERVED_LOG_ENV).filter(|_| cfg!(debug_assertions)),
        test,
        owners: owners.clone(),
        families,
        context: OnceLock::new(),
        owned: Mutex::default(),
        test_clock,
        ready: tokio::sync::watch::channel(false).0,
        me: OnceLock::new(),
        standalone: standalone.clone(),
        sockets: Arc::default(),
    });
    let _ = handler.me.set(Arc::downgrade(&handler));
    if let Some(standalone) = &standalone {
        let router: Arc<dyn LocalRouter> = handler.clone();
        standalone.set_router(Arc::downgrade(&router));
        // The test family's reverse target, answered as the Bun front does.
        if test {
            standalone.register(
                "test.echo",
                Arc::new(|_, args, ctx| {
                    Box::pin(async move { Ok(json!({"args": args, "ctx": ctx})) })
                }),
            );
        }
    }
    let peer = Peer::start(stream, handler.clone(), PeerOptions::core(clock.clone()));
    let _ = handler.context.set(FamilyContext {
        peer: peer.clone(),
        owners,
        clock: family_clock,
        standalone: standalone.clone(),
    });
    handler.ownership_changed();
    handler.ready.send_replace(true);
    // What the front sent on the link meanwhile waits in the stream.
    let link = link.map(|stream| {
        let handler = Arc::new(FrontLink {
            core: handler.clone(),
            sockets: Arc::default(),
        });
        Peer::start(stream, handler, PeerOptions::core(clock))
    });
    peer.closed().await;
    if let Some(link) = link {
        link.bye();
    }
    handler.stop_all();
    if let Some(standalone) = &standalone {
        let missing = standalone.missing();
        if !missing.is_empty() {
            tracing::info!(
                scope = "core",
                targets = ?missing,
                "reverse targets the standalone core was asked for and does not serve"
            );
        }
    }
    tracing::debug!("core channel closed: exiting");
    exit::CLOSED
}

/// What the core answers.
struct CoreHandler {
    /// [`SERVED_LOG_ENV`], on a debug build.
    served_log: Option<String>,
    test: bool,
    owners: Owners,
    families: Families,
    /// Set once the peer runs.
    context: OnceLock<FamilyContext>,
    /// The families the core owns, as last told to them.
    owned: Mutex<BTreeSet<&'static str>>,
    /// The front's test clock, followed.
    test_clock: Option<TestClock>,
    /// True once the families heard the welcome's table: what the peer
    /// reads before waits for it (a call or a clock advance never
    /// overtakes the families' start).
    ready: tokio::sync::watch::Sender<bool>,
    me: OnceLock<Weak<CoreHandler>>,
    /// A standalone core: what it answers in its own process.
    standalone: Option<Arc<Standalone>>,
    /// A standalone core's browser sockets (the front sends them on the
    /// channel), by the front's number.
    sockets: SocketMap,
}

type SocketMap = Arc<Mutex<std::collections::HashMap<u64, Arc<dyn CoreFamily>>>>;

fn unknown_method(method: &str) -> BoxFuture<Result<Value, RpcError>> {
    let message = format!("unknown method {method}");
    Box::pin(async move { Err(RpcError::with_code(message, "unknown_method")) })
}

impl CoreHandler {
    fn family(&self, name: &str) -> Option<&Arc<dyn CoreFamily>> {
        self.families.iter().find(|family| family.name() == name)
    }

    /// The family serving an HTTP path or a socket: the one that declares
    /// it, else, in a standalone core, the front family.
    fn path_family(&self, path: &str) -> Option<Arc<dyn CoreFamily>> {
        http_family_of(path, declared_families())
            .and_then(|name| self.family(&name).cloned())
            .or_else(|| {
                self.standalone
                    .as_ref()
                    .and_then(|_| self.family(FRONT_FAMILY).cloned())
            })
    }

    /// A call routed to the family that declares its method (or the
    /// family an `internal.<family>.` call names).
    fn route_call(&self, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let Some(cx) = self.context.get() else {
            return unknown_method(&call.method);
        };
        // A standalone core's front family routes the test family's calls
        // here.
        if self.test && call.method.starts_with("test.echo.") {
            return test_echo_call(Echo::Local(cx.clone()), call);
        }
        let name = match call.method.strip_prefix(INTERNAL_PREFIX) {
            Some(rest) => rest.split('.').next().map(str::to_owned),
            None => family_of(&call.method, declared_families()),
        };
        match name.as_deref().and_then(|name| self.family(name)) {
            Some(family) => {
                if !call.shadow && !call.method.starts_with(INTERNAL_PREFIX) {
                    self.served(family.name(), &call.method);
                }
                family.call(cx, call)
            }
            None => unknown_method(&call.method),
        }
    }

    /// An HTTP request routed to the family that declares its path.
    fn route_http(
        &self,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let path = path_of(&request.url).to_owned();
        // A connection's endpoints (a file, an agent session's download)
        // are routed, their connection resolved, by the front family
        // first, which hands them on with the connection in their context
        // (Bun's routing in place).
        let family = match (&self.standalone, request.ctx.connection_id.as_deref()) {
            (Some(_), None)
                if http_family_of(&path, declared_families())
                    .is_some_and(|family| ROUTED_IN_PLACE.contains(&family.as_str())) =>
            {
                self.family(FRONT_FAMILY).cloned()
            }
            _ => self.path_family(&path),
        };
        match (family, self.context.get()) {
            (Some(family), Some(cx)) => {
                self.served(family.name(), &format!("{} {path}", request.method));
                family.http(cx, request, body)
            }
            _ => Box::pin(async { Ok(HttpResponse::status(404)) }),
        }
    }

    fn served(&self, family: &str, what: &str) {
        if let Some(path) = &self.served_log {
            note_served(&[(SERVED_LOG_ENV, path.as_str())], family, what);
        }
    }

    /// Tells each family whether the core owns it now, when that changed.
    fn ownership_changed(&self) {
        let Some(cx) = self.context.get() else {
            return;
        };
        let mut owned = self.owned.lock().unwrap();
        for family in &self.families {
            let now = self.owners.owner(family.name()) == Side::Rust;
            if now != owned.contains(family.name()) {
                if now {
                    owned.insert(family.name());
                } else {
                    owned.remove(family.name());
                }
                tracing::info!(
                    family = family.name(),
                    "{} the {} family",
                    if now { "serving" } else { "no longer serving" },
                    family.name()
                );
                family.owned(cx, now);
            }
        }
    }

    /// The channel closed: every family stops its background work.
    fn stop_all(&self) {
        let Some(cx) = self.context.get() else {
            return;
        };
        let owned = std::mem::take(&mut *self.owned.lock().unwrap());
        for family in &self.families {
            if owned.contains(family.name()) {
                family.owned(cx, false);
            }
        }
    }

    /// `internal.clock.advance {to}`: the front's test clock moved.
    fn advance_clock(&self, params: Value) -> BoxFuture<Result<Value, RpcError>> {
        let clock = self.test_clock.clone();
        Box::pin(async move {
            let Some(clock) = clock else {
                return Err(RpcError::with_code(
                    "this core runs on the real clock",
                    "no_test_clock",
                ));
            };
            let to = params.get("to").and_then(Value::as_i64).unwrap_or(0);
            let ms = (to - roamgate_base::clock::Clock::now(&clock)).max(0) as u64;
            let now = clock.advance(ms).await;
            Ok(json!({ "now": now }))
        })
    }
}

impl Handler for CoreHandler {
    fn call(&self, peer: &Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        if self.test && call.method.starts_with("test.echo.") {
            return test_echo_call(Echo::Peer(peer.clone()), call);
        }
        if !*self.ready.borrow()
            && let Some(me) = self.me.get().and_then(Weak::upgrade)
        {
            let mut ready = self.ready.subscribe();
            let peer = peer.clone();
            return Box::pin(async move {
                let _ = ready.wait_for(|ready| *ready).await;
                Handler::call(&*me, &peer, call).await
            });
        }
        if call.method == "internal.clock.advance" {
            return self.advance_clock(call.params);
        }
        self.route_call(call)
    }

    fn http(
        &self,
        peer: &Peer,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        if !*self.ready.borrow()
            && let Some(me) = self.me.get().and_then(Weak::upgrade)
        {
            let mut ready = self.ready.subscribe();
            let peer = peer.clone();
            return Box::pin(async move {
                let _ = ready.wait_for(|ready| *ready).await;
                Handler::http(&*me, &peer, request, body).await
            });
        }
        let path = path_of(&request.url).to_owned();
        if self.test && path == "/api/test-echo/stream" {
            return Box::pin(async move { Ok(test_echo_http(&request, body)) });
        }
        self.route_http(request, body)
    }

    fn owner(&self, owners: BTreeMap<String, Side>, shadow: ShadowSettings) {
        self.owners.set(owners, shadow);
        self.ownership_changed();
    }

    /// A standalone core's browser sockets come on the channel.
    fn ws_open(&self, peer: &Peer, open: WsOpen) -> BoxFuture<Result<Value, RpcError>> {
        match self.me.get().and_then(Weak::upgrade) {
            Some(core) if self.standalone.is_some() => {
                open_socket(core, self.sockets.clone(), peer.clone(), open)
            }
            _ => Box::pin(async {
                Err(RpcError::with_code(
                    "this side serves no browser socket",
                    "unknown_method",
                ))
            }),
        }
    }

    fn socket(&self, peer: &Peer, message: Message) {
        if self.standalone.is_some() {
            socket_message(self, &self.sockets, peer, message);
        }
    }
}

impl LocalRouter for CoreHandler {
    fn call(&self, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        self.route_call(call)
    }

    fn http(
        &self,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        self.route_http(request, body)
    }
}

/// A browser socket the front asks the core to take (on the channel of a
/// standalone core, or on the link of a hybrid one): the family that
/// serves its path answers, once the families heard the welcome.
fn open_socket(
    core: Arc<CoreHandler>,
    sockets: SocketMap,
    link: Peer,
    open: WsOpen,
) -> BoxFuture<Result<Value, RpcError>> {
    Box::pin(async move {
        let _ = core.ready.subscribe().wait_for(|ready| *ready).await;
        let path = path_of(&open.url).to_owned();
        let family = core
            .path_family(&path)
            .filter(|family| core.owned.lock().unwrap().contains(family.name()));
        let (Some(family), Some(cx)) = (family, core.context.get()) else {
            return Ok(pass_to_bun());
        };
        let socket_id = open.socket_id;
        // Known before the answer: its first messages follow it at once.
        sockets.lock().unwrap().insert(socket_id, family.clone());
        let answer = family.ws_open(cx, &link, open).await;
        match &answer {
            Ok(result) if result["accepted"] == Value::Bool(true) => {
                core.served(family.name(), &format!("ws {path}"));
            }
            _ => {
                sockets.lock().unwrap().remove(&socket_id);
            }
        }
        answer
    })
}

/// A `ws_message` or `ws_close` of a socket a family took.
fn socket_message(core: &CoreHandler, sockets: &SocketMap, peer: &Peer, message: Message) {
    let (socket_id, closed) = match &message {
        Message::WsMessage { socket_id, .. } => (*socket_id, false),
        Message::WsClose { socket_id, .. } => (*socket_id, true),
        _ => return,
    };
    let family = if closed {
        sockets.lock().unwrap().remove(&socket_id)
    } else {
        sockets.lock().unwrap().get(&socket_id).cloned()
    };
    if let (Some(family), Some(cx)) = (family, core.context.get()) {
        family.ws_socket(cx, peer, message);
    }
}

/// Connects to the Rust front's link and says hello; None when it cannot
/// (the front then gives every socket to the Bun core).
async fn link_front(address: &str, hello: &Message) -> Option<transport::BoxStream> {
    let mut stream = match transport::connect(address).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::warn!(address, %error, "cannot reach the Rust front's link");
            return None;
        }
    };
    if let Err(error) = say_hello(&mut stream, hello).await {
        tracing::warn!(%error, "the Rust front's link refused this core");
        return None;
    }
    tracing::debug!("linked to the Rust front");
    Some(stream)
}

/// The core's side of the Rust front's link: the browser sockets of the
/// families the core owns, by the front's number.
struct FrontLink {
    core: Arc<CoreHandler>,
    sockets: SocketMap,
}

impl Handler for FrontLink {
    fn ws_open(&self, peer: &Peer, open: WsOpen) -> BoxFuture<Result<Value, RpcError>> {
        open_socket(self.core.clone(), self.sockets.clone(), peer.clone(), open)
    }

    fn socket(&self, peer: &Peer, message: Message) {
        socket_message(&self.core, &self.sockets, peer, message);
    }
}

fn path_of(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or("")
}

fn query_param<'a>(url: &'a str, name: &str) -> Option<&'a str> {
    let query = url.split_once('?')?.1.split('#').next()?;
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

/// Where the test family's pushes and reverse calls go: the channel, or
/// a standalone core's own process.
enum Echo {
    Peer(Peer),
    Local(FamilyContext),
}

impl Echo {
    fn push(&self, push: Push) {
        match self {
            Self::Peer(peer) => peer.push(push),
            Self::Local(cx) => cx.push(push),
        }
    }

    async fn reverse(&self, args: Value, ctx: crate::protocol::Ctx) -> Result<Value, RpcError> {
        match self {
            Self::Peer(peer) => peer.reverse_call("test.echo", args, ctx).await,
            Self::Local(cx) => cx.reverse_with("test.echo", args, ctx).await,
        }
    }
}

/// The test family's calls.
fn test_echo_call(peer: Echo, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
    Box::pin(async move {
        match call.method.as_str() {
            "test.echo.read" => Ok(json!({"params": call.params, "ctx": call.ctx})),
            "test.echo.push" => {
                let params = call.params.as_object().cloned().unwrap_or_default();
                let count = params.get("count").and_then(Value::as_u64).unwrap_or(1);
                let key = params.get("key").and_then(Value::as_str).map(str::to_owned);
                let base = params
                    .get("message")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for index in 0..count {
                    let mut message = Map::new();
                    message.insert("test_echo".into(), index.into());
                    for (name, value) in &base {
                        if name != "test_echo" {
                            message.insert(name.clone(), value.clone());
                        }
                    }
                    peer.push(Push {
                        message: Value::Object(message),
                        key: key.clone(),
                        connection_id: params
                            .get("connection_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        connection_generation: params
                            .get("connection_generation")
                            .and_then(Value::as_u64),
                        socket_id: params.get("socket_id").and_then(Value::as_u64),
                        session_id: params
                            .get("session_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    });
                }
                Ok(json!({"pushed": count}))
            }
            "test.echo.reverse" => peer.reverse(call.params, call.ctx).await,
            other => Err(RpcError::with_code(
                format!("unknown method {other}"),
                "unknown_method",
            )),
        }
    })
}

/// POST echoes the body; GET `?bytes=N` streams N bytes of `x`.
fn test_echo_http(request: &HttpRequest, body: Option<BodyReceiver>) -> HttpResponse {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(4);
    if request.method.eq_ignore_ascii_case("POST") {
        if let Some(mut body) = body {
            tokio::spawn(async move {
                while let Some(chunk) = body.chunk().await {
                    if tx.send(chunk).await.is_err() {
                        return;
                    }
                }
            });
        }
    } else {
        let mut left: u64 = query_param(&request.url, "bytes")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        tokio::spawn(async move {
            while left > 0 {
                let piece = left.min(64 * 1024);
                if tx.send(vec![b'x'; piece as usize]).await.is_err() {
                    return;
                }
                left -= piece;
            }
        });
    }
    HttpResponse {
        status: 200,
        headers: vec![("content-type".into(), "application/octet-stream".into())],
        body: Some(rx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_and_query() {
        assert_eq!(
            path_of("/api/test-echo/stream?bytes=5"),
            "/api/test-echo/stream"
        );
        assert_eq!(query_param("/a?x=1&bytes=5", "bytes"), Some("5"));
        assert_eq!(query_param("/a", "bytes"), None);
    }

    #[test]
    fn the_test_family_needs_the_variable() {
        assert!(!test_family_on(&[("ROAMGATE_CORE_TEST", "0")]));
        assert_eq!(
            test_family_on(&[("ROAMGATE_CORE_TEST", "1")]),
            cfg!(debug_assertions)
        );
    }
}
