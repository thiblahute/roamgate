//! The standalone core (contract/wire/core-channel.md, The standalone
//! core): a Rust front's own `roamgate core`, with no Bun server anywhere.
//! What the families asked the Bun side for is answered in this process:
//!
//! - reverse targets: a registry the binary fills ([`Standalone::register`]);
//!   a target nobody registered fails with `unknown_target`, naming it,
//!   and a debug build notes it in `ROAMGATE_CORE_SERVED_LOG` as
//!   `reverse-missing <target>`;
//! - pushes: to the browser sockets the core holds, through the sink the
//!   binary sets ([`Standalone::set_push_sink`]);
//! - a family's call or HTTP request to another family, routed by the
//!   core as it routes the front's ([`Standalone::call`],
//!   [`Standalone::http`]).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};

use serde_json::Value;

use crate::family::FamilyContext;
use crate::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use crate::protocol::{Ctx, Push, RpcError};

/// `ROAMGATE_CORE_STANDALONE=1`: set by a Rust front that runs its own
/// executable as its core (no `ROAMGATE_SIDECAR_BIN`).
pub const STANDALONE_ENV: &str = "ROAMGATE_CORE_STANDALONE";

/// A reverse target answered in the process.
pub type ReverseTarget =
    Arc<dyn Fn(&FamilyContext, Value, Ctx) -> BoxFuture<Result<Value, RpcError>> + Send + Sync>;

/// Where the core's pushes go.
pub type PushSink = Arc<dyn Fn(Push) + Send + Sync>;

/// The core's routing, for a family's call to another family.
pub trait LocalRouter: Send + Sync + 'static {
    /// A call (`internal.<family>.<op>` or a browser method), routed to
    /// the family that declares it.
    fn call(&self, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>>;
    /// An HTTP request, routed to the family that declares its path.
    fn http(
        &self,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>>;
}

/// What a standalone core answers in its own process.
#[derive(Default)]
pub struct Standalone {
    targets: RwLock<HashMap<String, ReverseTarget>>,
    push: RwLock<Option<PushSink>>,
    router: OnceLock<Weak<dyn LocalRouter>>,
    /// `ROAMGATE_CORE_SERVED_LOG`, on a debug build.
    served_log: Option<String>,
    /// The targets asked for that nobody registered, with their counts.
    missing: Mutex<BTreeMap<String, u64>>,
}

impl Standalone {
    pub fn new(served_log: Option<String>) -> Self {
        Self {
            served_log,
            ..Self::default()
        }
    }

    /// Answers `target` with `handler` from now on.
    pub fn register(&self, target: &str, handler: ReverseTarget) {
        self.targets
            .write()
            .unwrap()
            .insert(target.to_owned(), handler);
    }

    /// Sends the core's pushes to `sink` from now on.
    pub fn set_push_sink(&self, sink: PushSink) {
        *self.push.write().unwrap() = Some(sink);
    }

    /// The core's routing; set once by the core.
    pub fn set_router(&self, router: Weak<dyn LocalRouter>) {
        let _ = self.router.set(router);
    }

    /// The targets asked for that nobody registered, with their counts.
    pub fn missing(&self) -> BTreeMap<String, u64> {
        self.missing.lock().unwrap().clone()
    }

    /// A reverse call answered in the process.
    pub async fn reverse(
        &self,
        cx: &FamilyContext,
        target: &str,
        args: Value,
        ctx: Ctx,
    ) -> Result<Value, RpcError> {
        let handler = self.targets.read().unwrap().get(target).cloned();
        match handler {
            Some(handler) => handler(cx, args, ctx).await,
            None => Err(self.missing_target(target)),
        }
    }

    fn missing_target(&self, target: &str) -> RpcError {
        let first = {
            let mut missing = self.missing.lock().unwrap();
            let count = missing.entry(target.to_owned()).or_insert(0);
            *count += 1;
            *count == 1
        };
        if first {
            tracing::warn!(
                scope = "core",
                target,
                "reverse target not served by the standalone core"
            );
        }
        if let Some(path) = &self.served_log {
            crate::core::note_served(
                &[(crate::core::SERVED_LOG_ENV, path.as_str())],
                "reverse-missing",
                target,
            );
        }
        RpcError::with_code(
            format!("reverse target {target} is not served by the standalone core"),
            "unknown_target",
        )
    }

    /// A push to the browser sockets the core holds; dropped while no
    /// sink is set (no socket can be open then).
    pub fn push(&self, push: Push) {
        let sink = self.push.read().unwrap().clone();
        if let Some(sink) = sink {
            sink(push);
        }
    }

    fn router(&self) -> Option<Arc<dyn LocalRouter>> {
        self.router.get().and_then(Weak::upgrade)
    }

    /// A call routed by the core to the family that declares it.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        ctx: Ctx,
    ) -> BoxFuture<Result<Value, RpcError>> {
        let call = IncomingCall {
            id: 0,
            method: method.to_owned(),
            params,
            ctx,
            shadow: false,
        };
        match self.router() {
            Some(router) => router.call(call),
            None => Box::pin(async { Err(RpcError::closed()) }),
        }
    }

    /// An HTTP request routed by the core to the family that declares its
    /// path.
    pub fn http(
        &self,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        match self.router() {
            Some(router) => router.http(request, body),
            None => Box::pin(async { Err(RpcError::closed()) }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owners::Owners;
    use crate::peer::{Handler, Peer, PeerOptions};
    use crate::protocol::Side;
    use roamgate_base::clock::{SharedClock, SystemClock};

    struct Nothing;
    impl Handler for Nothing {}

    fn context(standalone: Arc<Standalone>) -> (FamilyContext, Peer) {
        let (a, b) = tokio::io::duplex(1 << 16);
        let clock: SharedClock = Arc::new(SystemClock);
        let other = Peer::start(
            Box::new(a),
            Arc::new(Nothing),
            PeerOptions::front(clock.clone()),
        );
        let peer = Peer::start(
            Box::new(b),
            Arc::new(Nothing),
            PeerOptions::core(clock.clone()),
        );
        (
            FamilyContext {
                peer,
                owners: Owners::new(Side::Rust, false),
                clock,
                standalone: Some(standalone),
            },
            other,
        )
    }

    #[tokio::test]
    async fn a_registered_target_answers_and_another_names_itself() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let standalone = Arc::new(Standalone::new(Some(
            log.path().to_string_lossy().into_owned(),
        )));
        standalone.register(
            "herdr.call",
            Arc::new(|_cx, args, _ctx| Box::pin(async move { Ok(args) })),
        );
        let (cx, _other) = context(standalone.clone());
        assert_eq!(
            cx.reverse("herdr.call", serde_json::json!({"a": 1}))
                .await
                .unwrap(),
            serde_json::json!({"a": 1})
        );
        let error = cx.reverse("review.socket", Value::Null).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("unknown_target"));
        assert!(error.message.contains("review.socket"), "{}", error.message);
        let _ = cx.reverse("review.socket", Value::Null).await;
        assert_eq!(
            standalone.missing(),
            BTreeMap::from([("review.socket".to_owned(), 2)])
        );
        if cfg!(debug_assertions) {
            assert_eq!(
                std::fs::read_to_string(log.path()).unwrap(),
                "reverse-missing review.socket\nreverse-missing review.socket\n"
            );
        }
    }

    #[tokio::test]
    async fn pushes_go_to_the_sink_once_one_is_set() {
        let standalone = Arc::new(Standalone::default());
        let (cx, _other) = context(standalone.clone());
        let message = || Push {
            message: serde_json::json!({"x": 1}),
            key: None,
            connection_id: None,
            connection_generation: None,
            socket_id: None,
            session_id: None,
        };
        cx.push(message());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        standalone.set_push_sink(Arc::new(move |push| {
            into.lock().unwrap().push(push.message)
        }));
        cx.push(message());
        assert_eq!(*seen.lock().unwrap(), vec![serde_json::json!({"x": 1})]);
    }
}
