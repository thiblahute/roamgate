//! POST /api/voice/call/handoff (http/call-handoff.ts), before the login
//! gate: the Android app gives the single-use token the page got from
//! `call_handoff` (the voice socket) and gets the call's number and
//! carrier token, and a login cookie (it is the user's phone, sent there by
//! their logged-in page). The token is the credential: unknown, used or
//! expired answers 410; [`HANDOFF_MAX_FAILURES`] failures from one address
//! answer 429 for a while.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use roamgate_base::clock::SharedClock;
use serde_json::{Value, json};

use super::{Answer, Body, Request};

/// Where the Android app redeems a call's handoff token.
pub const CALL_HANDOFF_PATH: &str = "/api/voice/call/handoff";
/// Failed redeems one address may make in FAILURE_WINDOW_MS.
pub const HANDOFF_MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW_MS: i64 = 10 * 60_000;
/// The largest body read: the plumbing may stop reading past it
/// ([`Body::TooLarge`]).
pub const HANDOFF_MAX_BODY_BYTES: usize = 1024;
const MAX_ADDRESSES: usize = 4096;

/// Takes a handoff token (as the body gives it, Null when it has none):
/// the call's number and carrier token, None when unknown, used or
/// expired.
pub type Redeem = Arc<dyn Fn(&Value) -> Option<(u64, String)> + Send + Sync>;
/// A new login's Set-Cookie value; None when no login is required.
pub type SessionCookie = Arc<dyn Fn() -> Option<String> + Send + Sync>;

struct Failures {
    count: u32,
    until: i64,
}

/// The redeem route (createCallHandoffRedeem).
pub struct CallHandoffRedeem {
    redeem: Redeem,
    session_cookie: SessionCookie,
    clock: SharedClock,
    failures: Mutex<IndexMap<String, Failures>>,
}

impl CallHandoffRedeem {
    pub fn new(redeem: Redeem, session_cookie: SessionCookie, clock: SharedClock) -> Self {
        Self {
            redeem,
            session_cookie,
            clock,
            failures: Mutex::default(),
        }
    }

    fn failed(&self, ip: &str) {
        let at = self.clock.now();
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match failures.get_mut(ip) {
            Some(entry) if entry.until > at => entry.count += 1,
            _ => {
                if failures.len() >= MAX_ADDRESSES {
                    failures.retain(|_, value| value.until > at);
                    if failures.len() >= MAX_ADDRESSES {
                        failures.clear();
                    }
                }
                // Map.set keeps an existing key where it is.
                let fresh = Failures {
                    count: 1,
                    until: at + FAILURE_WINDOW_MS,
                };
                match failures.get_mut(ip) {
                    Some(entry) => *entry = fresh,
                    None => {
                        failures.insert(ip.to_owned(), fresh);
                    }
                }
            }
        }
    }

    /// The answer to `request`, from the address `ip`.
    pub fn handle(&self, request: &Request, ip: &str) -> Answer {
        if request.method != "POST" {
            return Answer::text(405, "method not allowed")
                .with("allow", "POST")
                .no_store();
        }
        // The app sends no fetch metadata; a page of another site never
        // redeems.
        if request.get("sec-fetch-site").as_deref() == Some("cross-site") {
            return Answer::text(403, "forbidden").no_store();
        }
        let limited = {
            let failures = self
                .failures
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            failures
                .get(ip)
                .filter(|entry| {
                    entry.until > self.clock.now() && entry.count >= HANDOFF_MAX_FAILURES
                })
                .map(|entry| entry.until)
        };
        if let Some(until) = limited {
            let seconds = ((until - self.clock.now()) as f64 / 1000.0).ceil();
            return Answer::text(429, "too many attempts")
                .with("retry-after", crate::js::number_text(seconds))
                .no_store();
        }
        let body = match &request.body {
            Body::Bytes(bytes) if bytes.len() <= HANDOFF_MAX_BODY_BYTES => {
                std::str::from_utf8(bytes).ok().and_then(crate::js::parse)
            }
            _ => None,
        };
        let Some(body) = body else {
            self.failed(ip);
            return Answer::text(400, "bad request").no_store();
        };
        let token = match &body {
            Value::Object(body) => body.get("handoff").cloned().unwrap_or(Value::Null),
            _ => Value::Null,
        };
        let Some((call, carrier)) = (self.redeem)(&token) else {
            self.failed(ip);
            return Answer::error(410, "This call handoff is unknown, used or expired").no_store();
        };
        let mut answer = Answer::json(200, json!({ "call": call, "carrier": carrier })).no_store();
        if let Some(cookie) = (self.session_cookie)() {
            answer = answer.with("set-cookie", cookie);
        }
        answer
    }
}

#[cfg(test)]
mod tests;
