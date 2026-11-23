//! The limit_resume family's shadow read on a slow connection: while Bun
//! owns the family, `limit_resume.list` is answered by the core's observer
//! within its wait, from its last look when the current one is slow, and
//! the next read gets what that look found.
#![cfg(unix)]
// Tests wait on tokio's paused time.
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::time::Duration;

use roamgate_base::clock::{SharedClock, TokioClock};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::owners::Owners;
use roamgate_sidecar::peer::{BoxFuture, Handler, IncomingCall, Peer, PeerOptions};
use roamgate_sidecar::protocol::{Ctx, RpcError, Side};
use serde_json::{Value, json};

const STOP: &str = r#"{"type":"assistant","uuid":"a1","timestamp":"2025-12-31T23:59:30.000Z","isApiErrorMessage":true,"apiError":"usage_limit_reached","apiErrorParams":{"rate_limit_info":{"status":"rejected","resetsAt":1767229200,"rateLimitType":"five_hour"}},"message":{"role":"assistant","content":[{"type":"text","text":"limit"}]}}"#;

/// Bun, as the observer sees it: one Claude pane whose transcript takes
/// 20 s to read.
struct SlowFront;

impl Handler for SlowFront {
    fn reverse_call(
        &self,
        _peer: &Peer,
        target: String,
        _args: Value,
        _ctx: Ctx,
    ) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            Ok(match target.as_str() {
                "connections.ready" => json!([{"id": "desktop", "generation": 1}]),
                "settings.limit_resume.get" => {
                    json!({"enabled": true, "message": "Go on.", "margin_seconds": 60})
                }
                "herdr.call" => json!({"agents": [{
                    "pane_id": "p1", "agent": "claude", "agent_status": "idle",
                    "agent_session": {"kind": "id", "value": "s1"},
                }]}),
                "conversation.owned_panes" | "claude_mod.panes" => json!([]),
                "agent.transcript_tail" => {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                    json!(format!("{STOP}\n"))
                }
                other => return Err(RpcError::new(format!("unknown target {other}"))),
            })
        })
    }
}

struct Nothing;
impl Handler for Nothing {}

#[tokio::test(start_paused = true)]
async fn a_shadow_read_answers_within_its_wait_and_the_next_one_sees_the_slow_look() {
    let (a, b) = tokio::net::UnixStream::pair().unwrap();
    let clock: SharedClock = Arc::new(TokioClock::starting_at(1_767_225_600_000));
    let _front = Peer::start(
        Box::new(a),
        Arc::new(SlowFront),
        PeerOptions::front(clock.clone()),
    );
    let core = Peer::start(
        Box::new(b),
        Arc::new(Nothing),
        PeerOptions::core(clock.clone()),
    );
    let cx = FamilyContext {
        peer: core,
        // Bun owns every family: the observer answers.
        owners: Owners::new(Side::Rust, false),
        clock,
    };
    let family = roamgate::families::limit_resume::family().unwrap();
    let list = || {
        family.call(
            &cx,
            IncomingCall {
                id: 1,
                method: "limit_resume.list".into(),
                params: json!({}),
                ctx: Ctx {
                    connection_id: Some("desktop".into()),
                    ..Ctx::default()
                },
                shadow: true,
            },
        )
    };
    let started = tokio::time::Instant::now();
    let first = list().await.unwrap();
    let waited = started.elapsed();
    assert_eq!(first, json!({"pauses": []}));
    assert!(
        waited <= roamgate::families::limit_resume::SHADOW_LOOK_WAIT,
        "{waited:?}"
    );
    // The look goes on after the answer; the next read gets it at once.
    tokio::time::sleep(Duration::from_secs(30)).await;
    let started = tokio::time::Instant::now();
    let second = list().await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(second["pauses"][0]["pane_id"], "p1");
    assert_eq!(second["pauses"][0]["resets_at"], 1_767_229_200_000i64);
}
