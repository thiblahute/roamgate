//! http/voice-low-gpu.test.ts.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;

/// A profile that records what it is asked (stub).
#[derive(Default)]
struct Stub {
    calls: Mutex<Vec<Value>>,
}

impl Stub {
    fn calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
    }
}

impl LowGpuProfile for Stub {
    fn status(&self) -> Value {
        json!({"active": !self.calls.lock().unwrap().is_empty()})
    }

    fn hold(&self, change: HoldChange) -> BoxFuture<Result<&'static str, String>> {
        let mut call = json!({"on": change.on, "now": change.now});
        if let Some(holder) = change.holder {
            call["holder"] = json!(holder);
        }
        self.calls.lock().unwrap().push(call);
        Box::pin(async { Ok("after-call") })
    }

    fn apply(&self, now: bool) -> BoxFuture<&'static str> {
        self.calls.lock().unwrap().push(json!({"apply": now}));
        Box::pin(async { "now" })
    }
}

fn post(body: Value, header: bool) -> Request {
    let request = Request::new("POST", LOW_GPU_PATH).bytes(body.to_string().into_bytes());
    if header {
        request.header("x-roamgate-voice", "1")
    } else {
        request
    }
}

async fn answer(stub: &Stub, request: Request) -> Answer {
    low_gpu_route(stub, &request).await.expect("an answer")
}

#[tokio::test]
async fn get_says_its_status() {
    let stub = Stub::default();
    let response = answer(&stub, Request::new("GET", LOW_GPU_PATH)).await;
    assert_eq!(response.body_json(), json!({"active": false}));
    assert!(
        low_gpu_route(&stub, &Request::new("GET", "/api/voice"))
            .await
            .is_none()
    );
}

#[tokio::test]
async fn post_holds_it_or_lets_it_go_with_the_voice_header_only() {
    let stub = Arc::new(Stub::default());
    assert_eq!(
        answer(&stub, post(json!({"on": true}), false)).await.status,
        403
    );
    let held = answer(
        &stub,
        post(json!({"on": true, "holder": "gaming", "now": true}), true),
    )
    .await;
    assert_eq!(
        held.body_json(),
        json!({"active": true, "applied": "after-call"})
    );
    answer(&stub, post(json!({"on": false}), true)).await;
    assert_eq!(
        stub.calls(),
        vec![
            json!({"on": true, "holder": "gaming", "now": true}),
            json!({"on": false, "now": false}),
        ]
    );
}

#[tokio::test]
async fn now_alone_switches_a_call_without_holding() {
    let stub = Stub::default();
    let response = answer(&stub, post(json!({"now": true}), true)).await;
    assert_eq!(response.body_json()["applied"], "now");
    assert_eq!(stub.calls(), vec![json!({"apply": true})]);
}

#[tokio::test]
async fn refuses_a_bad_request() {
    let stub = Stub::default();
    assert_eq!(answer(&stub, post(json!({}), true)).await.status, 400);
    let spaced = post(json!({"on": true, "holder": "a b"}), true);
    assert_eq!(answer(&stub, spaced).await.status, 400);
}
