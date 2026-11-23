//! A family the core serves (contract/wire/core-channel.md, Families in
//! the core). The family crates know nothing of the channel: the
//! `roamgate` binary wraps each in a [`CoreFamily`] that maps its calls,
//! HTTP paths, background work and reverse calls onto the channel.

use std::sync::Arc;

use roamgate_base::clock::SharedClock;
use serde_json::Value;

use crate::owners::Owners;
use crate::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall, Peer};
use crate::protocol::{Ctx, Push, RpcError};

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
}

impl FamilyContext {
    /// A call into what the front owns.
    pub async fn reverse(&self, target: &str, args: Value) -> Result<Value, RpcError> {
        self.peer.reverse_call(target, args, Ctx::default()).await
    }

    /// A push to browsers.
    pub fn push(&self, push: Push) {
        self.peer.push(push);
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

    /// An HTTP request on one of the family's paths.
    fn http(
        &self,
        _cx: &FamilyContext,
        _request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        Box::pin(async { Ok(HttpResponse::status(404)) })
    }

    /// The core started (`true`) or stopped (`false`) owning the family:
    /// its background work and its writers run only while it is owned.
    fn owned(&self, _cx: &FamilyContext, _owned: bool) {}
}

pub type Families = Vec<Arc<dyn CoreFamily>>;
