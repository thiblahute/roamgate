//! The low-GPU voice profile, for the Voice settings
//! (http/voice-low-gpu.ts):
//!
//!   GET  /api/voice/low-gpu  its status: on or off, for whom, the set
//!   POST /api/voice/low-gpu  {on, holder?, now?}: hold it on or let it go
//!                            (off without a holder: every holder);
//!                            {now: true} alone: a call going on switches
//!                            now rather than when it ends
//!
//! The CLI (`roamgate voice profile low-gpu`) writes the same state file,
//! which the server follows. The POST needs the voice header, as the other
//! voice changes do. Every answer is sent `cache-control: no-store`.

use roamgate_base::clock::BoxFuture;
use serde_json::{Map, Value, json};

use super::{Answer, Request, needs_header};
use crate::low_gpu::{HoldChange, VoiceLowGpu, is_holder_name};

pub const LOW_GPU_PATH: &str = "/api/voice/low-gpu";

/// What the route asks of the profile ([`VoiceLowGpu`]; tests give a
/// fake).
pub trait LowGpuProfile: Send + Sync + 'static {
    fn status(&self) -> Value;
    /// Holds or lets go, then applies it: what the running helper does.
    fn hold(&self, change: HoldChange) -> BoxFuture<Result<&'static str, String>>;
    /// Applies the profile as it is: what the running helper does.
    fn apply(&self, now: bool) -> BoxFuture<&'static str>;
}

impl LowGpuProfile for VoiceLowGpu {
    fn status(&self) -> Value {
        VoiceLowGpu::status(self)
    }

    fn hold(&self, change: HoldChange) -> BoxFuture<Result<&'static str, String>> {
        let profile = self.clone();
        Box::pin(async move { VoiceLowGpu::hold(&profile, &change).await })
    }

    fn apply(&self, now: bool) -> BoxFuture<&'static str> {
        VoiceLowGpu::apply(self, now)
    }
}

/// `{...profile.status(), applied}`.
fn with_applied(status: Value, applied: &str) -> Value {
    let mut status = match status {
        Value::Object(status) => status,
        _ => Map::new(),
    };
    status.insert("applied".into(), json!(applied));
    Value::Object(status)
}

/// The route (createVoiceLowGpuRoute): None for another path.
pub async fn low_gpu_route(profile: &dyn LowGpuProfile, request: &Request) -> Option<Answer> {
    if request.path != LOW_GPU_PATH {
        return None;
    }
    if request.method == "GET" {
        return Some(Answer::json(200, profile.status()).no_store());
    }
    if request.method != "POST" {
        return Some(Answer::error(405, "method not allowed").no_store());
    }
    if !request.has_voice_header() {
        return Some(needs_header().no_store());
    }
    let body = request.json_body();
    let field = |key: &str| {
        body.as_ref()
            .and_then(Value::as_object)
            .and_then(|body| body.get(key))
    };
    if field("on").is_none() && field("now") == Some(&Value::Bool(true)) {
        let applied = profile.apply(true).await;
        return Some(Answer::json(200, with_applied(profile.status(), applied)).no_store());
    }
    let Some(on) = field("on").and_then(Value::as_bool) else {
        return Some(Answer::error(400, "on must be true or false").no_store());
    };
    let holder = match field("holder") {
        None => None,
        Some(Value::String(holder)) if is_holder_name(holder) => Some(holder.clone()),
        Some(_) => {
            return Some(
                Answer::error(
                    400,
                    "holder is letters, digits, dots, dashes or underscores",
                )
                .no_store(),
            );
        }
    };
    let change = HoldChange {
        on,
        holder,
        now: field("now") == Some(&Value::Bool(true)),
    };
    Some(
        match profile.hold(change).await {
            Ok(applied) => Answer::json(200, with_applied(profile.status(), applied)),
            // A state file that cannot be written: thrown in Bun, the
            // server's 500.
            Err(message) => Answer::error(500, message),
        }
        .no_store(),
    )
}

#[cfg(test)]
mod tests;
