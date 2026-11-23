//! call-handoff.test.ts's "the handoff's redeem route" (its other cases
//! are the voice socket's).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use roamgate_base::clock::TokioClock;
use serde_json::{Value, json};

use super::*;

fn post(body: Value) -> Request {
    Request::new("POST", CALL_HANDOFF_PATH).json(&body)
}

#[tokio::test]
async fn exchanges_a_valid_token_for_the_call_and_a_login_once() {
    let valid = Arc::new(Mutex::new(HashSet::from(["good".to_owned()])));
    let redeem = CallHandoffRedeem::new(
        Arc::new(move |token: &Value| {
            let token = token.as_str()?;
            valid
                .lock()
                .unwrap()
                .remove(token)
                .then(|| (3, "carrier-token".to_owned()))
        }),
        Arc::new(|| Some("herdr_auth=signed; HttpOnly".into())),
        Arc::new(TokioClock::starting_at(0)),
    );
    let ok = redeem.handle(&post(json!({"handoff": "good"})), "1.2.3.4");
    assert_eq!(ok.status, 200);
    assert_eq!(
        ok.body_json(),
        json!({"call": 3, "carrier": "carrier-token"})
    );
    assert_eq!(ok.get("set-cookie"), Some("herdr_auth=signed; HttpOnly"));
    assert_eq!(ok.get("cache-control"), Some("no-store"));
    let again = redeem.handle(&post(json!({"handoff": "good"})), "1.2.3.4");
    assert_eq!(again.status, 410);
    assert_eq!(again.get("set-cookie"), None);
}

#[tokio::test(start_paused = true)]
async fn refuses_other_methods_other_sites_and_too_many_failures() {
    let redeem = CallHandoffRedeem::new(
        Arc::new(|_: &Value| None),
        Arc::new(|| Some("herdr_auth=x".into())),
        Arc::new(TokioClock::starting_at(0)),
    );
    let get = Request::new("GET", CALL_HANDOFF_PATH);
    assert_eq!(redeem.handle(&get, "ip").status, 405);
    let cross = post(json!({"handoff": "x"})).header("sec-fetch-site", "cross-site");
    assert_eq!(redeem.handle(&cross, "ip").status, 403);
    for _ in 0..HANDOFF_MAX_FAILURES {
        assert_eq!(
            redeem.handle(&post(json!({"handoff": "x"})), "ip").status,
            410
        );
    }
    let limited = redeem.handle(&post(json!({"handoff": "x"})), "ip");
    assert_eq!(limited.status, 429);
    assert_eq!(limited.get("retry-after"), Some("600"));
    assert_eq!(
        redeem
            .handle(&post(json!({"handoff": "x"})), "other")
            .status,
        410
    );
    tokio::time::advance(std::time::Duration::from_millis(10 * 60_000 + 1)).await;
    assert_eq!(
        redeem.handle(&post(json!({"handoff": "x"})), "ip").status,
        410
    );
}
