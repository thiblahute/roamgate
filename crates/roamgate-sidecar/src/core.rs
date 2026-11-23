//! The core process (`roamgate core`): connects to the front named by
//! `ROAMGATE_CORE_CHANNEL`, proves itself with `ROAMGATE_CORE_TOKEN`, and
//! serves the families it is given (the `roamgate` binary's, see
//! [`crate::family`]) until the channel closes. The `test.echo` family
//! exists only for the channel's cross-language test, with
//! `ROAMGATE_CORE_TEST=1` on a debug build.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};

use roamgate_base::clock::TestClock;
use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::log::{LogLayer, LogLevel, Logger, LoggerOptions, parse_log_level};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::family::{CoreFamily, Families, FamilyContext, INTERNAL_PREFIX};
use crate::owners::{Owners, families as declared_families, implemented};
use crate::peer::{
    BodyReceiver, BoxFuture, Handler, HttpRequest, HttpResponse, IncomingCall, Peer, PeerOptions,
    say_hello,
};
use crate::protocol::{
    Message, PROTOCOL, Push, RpcError, ShadowSettings, Side, family_of, http_family_of,
};
use crate::transport;

pub const CHANNEL_ENV: &str = "ROAMGATE_CORE_CHANNEL";
pub const TOKEN_ENV: &str = "ROAMGATE_CORE_TOKEN";
pub const TEST_ENV: &str = "ROAMGATE_CORE_TEST";

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
        let _ = writeln!(file, "{family} {what}");
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
    });
    let peer = Peer::start(stream, handler.clone(), PeerOptions::core(clock));
    let _ = handler.context.set(FamilyContext {
        peer: peer.clone(),
        owners,
        clock: family_clock,
    });
    handler.ownership_changed();
    peer.closed().await;
    handler.stop_all();
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
}

fn unknown_method(method: &str) -> BoxFuture<Result<Value, RpcError>> {
    let message = format!("unknown method {method}");
    Box::pin(async move { Err(RpcError::with_code(message, "unknown_method")) })
}

impl CoreHandler {
    fn family(&self, name: &str) -> Option<&Arc<dyn CoreFamily>> {
        self.families.iter().find(|family| family.name() == name)
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
            return test_echo_call(peer.clone(), call);
        }
        if call.method == "internal.clock.advance" {
            return self.advance_clock(call.params);
        }
        let Some(cx) = self.context.get() else {
            return unknown_method(&call.method);
        };
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

    fn http(
        &self,
        _peer: &Peer,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let path = path_of(&request.url).to_owned();
        if self.test && path == "/api/test-echo/stream" {
            return Box::pin(async move { Ok(test_echo_http(&request, body)) });
        }
        let family =
            http_family_of(&path, declared_families()).and_then(|name| self.family(&name).cloned());
        match (family, self.context.get()) {
            (Some(family), Some(cx)) => {
                self.served(family.name(), &format!("{} {path}", request.method));
                family.http(cx, request, body)
            }
            _ => Box::pin(async { Ok(HttpResponse::status(404)) }),
        }
    }

    fn owner(&self, owners: BTreeMap<String, Side>, shadow: ShadowSettings) {
        self.owners.set(owners, shadow);
        self.ownership_changed();
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

/// The test family's calls.
fn test_echo_call(peer: Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
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
            "test.echo.reverse" => peer.reverse_call("test.echo", call.params, call.ctx).await,
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
