//! A family the core serves (contract/wire/core-channel.md, Families in
//! the core). The family crates know nothing of the channel: the
//! `roamgate` binary wraps each in a [`CoreFamily`] that maps its calls,
//! HTTP paths, background work and reverse calls onto the channel.

use std::sync::Arc;

use roamgate_base::clock::SharedClock;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::owners::Owners;
use crate::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall, Peer, WsOpen};
use crate::protocol::{Ctx, Message, Push, RpcError};
use crate::standalone::Standalone;

/// The prefix of the front's own calls to a family (`internal.<family>.<op>`):
/// no family of contract/owners/families.json declares it, so a browser
/// can never reach one.
pub const INTERNAL_PREFIX: &str = "internal.";

/// What a family gets from the core.
#[derive(Clone)]
pub struct FamilyContext {
    pub peer: Peer,
    pub owners: Owners,
    /// The families' clock: the real one, or the front's test clock
    /// followed (`welcome.clock` and `internal.clock.advance`).
    pub clock: SharedClock,
    /// Set in a standalone core (no Bun anywhere): reverse targets are
    /// answered in this process, pushes go to the browser sockets it
    /// holds, and a family may call another one.
    pub standalone: Option<Arc<Standalone>>,
}

impl FamilyContext {
    /// A call into what the front owns: in a standalone core, the target
    /// the binary registered in this process.
    pub async fn reverse(&self, target: &str, args: Value) -> Result<Value, RpcError> {
        self.reverse_with(target, args, Ctx::default()).await
    }

    /// A reverse call with the request's context.
    pub async fn reverse_with(
        &self,
        target: &str,
        args: Value,
        ctx: Ctx,
    ) -> Result<Value, RpcError> {
        match &self.standalone {
            Some(standalone) => standalone.reverse(self, target, args, ctx).await,
            None => self.peer.reverse_call(target, args, ctx).await,
        }
    }

    /// A push to browsers: in a standalone core, to the sockets it holds.
    pub fn push(&self, push: Push) {
        match &self.standalone {
            Some(standalone) => standalone.push(push),
            None => self.peer.push(push),
        }
    }
}

/// A family's answer to a call: a value, or its JSON text already
/// written, sent to the browser as is (no struct to [`Value`] to text on
/// the way; the text is what serialising the value would give).
#[derive(Debug)]
pub enum Reply {
    Value(Value),
    Text(Box<RawValue>),
}

impl Reply {
    /// The text of `value`, written once.
    pub fn text<T: serde::Serialize + ?Sized>(value: &T) -> Result<Self, RpcError> {
        serde_json::value::to_raw_value(value)
            .map(Reply::Text)
            .map_err(|error| RpcError::new(error.to_string()))
    }

    /// The answer as a value (a text parsed again), for a caller that
    /// reads it.
    pub fn into_value(self) -> Value {
        match self {
            Reply::Value(value) => value,
            Reply::Text(text) => serde_json::from_str(text.get()).unwrap_or(Value::Null),
        }
    }
}

impl From<Value> for Reply {
    fn from(value: Value) -> Self {
        Reply::Value(value)
    }
}

/// A family the core implements.
pub trait CoreFamily: Send + Sync + 'static {
    /// Its name in contract/owners/families.json.
    fn name(&self) -> &'static str;

    /// A browser RPC of the family (routed by the front only while Rust
    /// owns it, or a shadow read while Bun does), or the front's own
    /// `internal.<family>.<op>` call.
    fn call(&self, _cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            Err(RpcError::with_code(
                format!("unknown method {}", call.method),
                "unknown_method",
            ))
        })
    }

    /// [`CoreFamily::call`] for a browser's call in a standalone core: a
    /// family may answer the large reads with their text
    /// ([`Reply::Text`]). The answer is the one `call` gives.
    fn call_reply(
        &self,
        cx: &FamilyContext,
        call: IncomingCall,
    ) -> BoxFuture<Result<Reply, RpcError>> {
        let answer = self.call(cx, call);
        Box::pin(async move { answer.await.map(Reply::Value) })
    }

    /// An HTTP request on one of the family's paths.
    fn http(
        &self,
        _cx: &FamilyContext,
        _request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        Box::pin(async { Ok(HttpResponse::status(404)) })
    }

    /// Stage 2, on the Rust front's link (contract/wire/core-channel.md,
    /// The Rust core's link to the Rust front): a browser asks to upgrade
    /// a socket on one of the family's paths while the core owns it. The
    /// answer is `ws_open`'s: accepted (`{accepted: true, transport}`),
    /// refused with the response the browser gets, or [`pass_to_bun`].
    /// What the family sends the socket goes on `link`.
    fn ws_open(
        &self,
        _cx: &FamilyContext,
        _link: &Peer,
        _open: WsOpen,
    ) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async { Ok(pass_to_bun()) })
    }

    /// A `ws_message` or `ws_close` of a socket the family accepted.
    fn ws_socket(&self, _cx: &FamilyContext, _link: &Peer, _message: Message) {}

    /// The core started (`true`) or stopped (`false`) owning the family:
    /// its background work and its writers run only while it is owned.
    fn owned(&self, _cx: &FamilyContext, _owned: bool) {}
}

pub type Families = Vec<Arc<dyn CoreFamily>>;

/// `ws_open`'s answer on the Rust front's link for a socket the core does
/// not serve: the front asks the Bun core instead.
pub fn pass_to_bun() -> Value {
    json!({"accepted": false, "pass": true})
}
