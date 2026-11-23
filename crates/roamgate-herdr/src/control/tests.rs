//! bridge/herdr-client.test.ts, against a unix socket server per test.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::log::{LogLevel, Logger, LoggerOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

struct Server {
    _dir: tempfile::TempDir,
    path: String,
}

/// A server calling `on_data` with each connection's first chunk.
fn start_server<F>(on_data: F) -> Server
where
    F: Fn(UnixStream, Vec<u8>) -> futures_util::future::BoxFuture<'static, ()>
        + Send
        + Sync
        + 'static,
{
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("herdr.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let on_data = Arc::new(on_data);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let on_data = on_data.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 64 * 1024];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                if read == 0 {
                    return;
                }
                on_data(stream, buffer[..read].to_vec()).await;
            });
        }
    });
    Server {
        path: path.to_str().unwrap().to_owned(),
        _dir: dir,
    }
}

/// A server reading whole request lines (for requests over one write).
fn start_line_server() -> Server {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("herdr.sock");
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut received = Vec::new();
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    received.extend_from_slice(&buffer[..read]);
                    if let Some(end) = received.iter().position(|byte| *byte == b'\n') {
                        let request: Value = serde_json::from_slice(&received[..end]).unwrap();
                        let text = request["params"]["text"].as_str().unwrap();
                        let answer = json!({
                            "id": request["id"],
                            "result": { "length": text.encode_utf16().count() },
                        });
                        let _ = stream.write_all(format!("{answer}\n").as_bytes()).await;
                        return;
                    }
                }
            });
        }
    });
    Server {
        path: path.to_str().unwrap().to_owned(),
        _dir: dir,
    }
}

fn answer(stream: UnixStream, line: String) -> futures_util::future::BoxFuture<'static, ()> {
    Box::pin(async move {
        let mut stream = stream;
        let _ = stream.write_all(line.as_bytes()).await;
        let _ = stream.shutdown().await;
    })
}

/// Answers each request after `delay` with the methods received so far.
fn start_counting_server(delay_ms: u64) -> (Server, Arc<Mutex<Vec<String>>>) {
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = received.clone();
    let server = start_server(move |stream, data| {
        let seen = seen.clone();
        Box::pin(async move {
            let request: Value = serde_json::from_slice(&data).unwrap();
            let n = {
                let mut seen = seen.lock().unwrap();
                seen.push(request["method"].as_str().unwrap().to_owned());
                seen.len()
            };
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let line = json!({
                "id": request["id"],
                "result": { "n": n, "method": request["method"], "params": request["params"] },
            });
            answer(stream, format!("{line}\n")).await;
        })
    });
    (server, received)
}

fn client(path: &str) -> HerdrClient {
    HerdrClient::new(path, HerdrClientOptions::default())
}

fn reusing(path: &str, reuse_ms: f64) -> HerdrClient {
    HerdrClient::new(
        path,
        HerdrClientOptions {
            read_reuse_ms: Some(reuse_ms),
            ..HerdrClientOptions::default()
        },
    )
}

/// Params of pane.send_input sized so the request line is `line_bytes`.
fn sized_text(line_bytes: usize) -> String {
    // r_<base36 ms>_<4 chars>: the id's length varies with the time only.
    let probe = json!({
        "id": format!("r_{}_abcd", crate::client::radix36_now_for_tests()),
        "method": "pane.send_input",
        "params": { "text": "" },
    })
    .to_string();
    "x".repeat(line_bytes - probe.len())
}

#[tokio::test]
async fn rechecks_authorization_after_socket_connection_and_sends_no_revoked_request() {
    let received = Arc::new(AtomicBool::new(false));
    let seen = received.clone();
    let server = start_server(move |_stream, _data| {
        seen.store(true, Ordering::SeqCst);
        Box::pin(async {})
    });
    let client = client(&server.path);
    let allowed = Arc::new(AtomicBool::new(true));
    let checked = Arc::new(AtomicBool::new(false));
    let (allow, check) = (allowed.clone(), checked.clone());
    let pending = tokio::spawn(async move {
        client
            .call(
                "workspace.create",
                json!({}),
                8000,
                Some(Box::new(move || {
                    check.store(true, Ordering::SeqCst);
                    if allow.load(Ordering::SeqCst) {
                        Ok(())
                    } else {
                        Err("Approval revoked".into())
                    }
                })),
                false,
            )
            .await
    });
    allowed.store(false, Ordering::SeqCst);
    assert_eq!(pending.await.unwrap(), Err("Approval revoked".into()));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(checked.load(Ordering::SeqCst));
    assert!(!received.load(Ordering::SeqCst));
}

#[tokio::test]
async fn rejects_mismatched_and_malformed_one_shot_response_envelopes() {
    let wrong = start_server(|stream, _| {
        answer(
            stream,
            format!("{}\n", json!({"id": "wrong", "result": {}})),
        )
    });
    let error = client(&wrong.path)
        .call_simple("ping", json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("invalid response envelope"), "{error}");
    let mixed = start_server(|stream, data| {
        let request: Value = serde_json::from_slice(&data).unwrap();
        answer(
            stream,
            format!(
                "{}\n",
                json!({"id": request["id"], "result": {}, "error": {}})
            ),
        )
    });
    let error = client(&mixed.path)
        .call_simple("ping", json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("invalid response envelope"), "{error}");
}

#[tokio::test]
async fn sends_a_request_too_large_for_one_socket_write() {
    let server = start_line_server();
    let text = "long message ".repeat(70_000);
    let result = client(&server.path)
        .call_simple("pane.send_input", json!({ "text": text }))
        .await
        .unwrap();
    assert_eq!(result, json!({ "length": text.len() }));
}

#[tokio::test]
async fn sends_a_request_line_of_exactly_herdrs_1_mib() {
    let server = start_line_server();
    let text = sized_text(HERDR_MAX_REQUEST_BYTES);
    let result = client(&server.path)
        .call_simple("pane.send_input", json!({ "text": text }))
        .await
        .unwrap();
    assert_eq!(result, json!({ "length": text.len() }));
}

#[tokio::test(start_paused = true)]
async fn refuses_a_request_line_one_byte_over_herdrs_1_mib_at_once() {
    let connected = Arc::new(AtomicBool::new(false));
    let seen = connected.clone();
    let server = start_server(move |_, _| {
        seen.store(true, Ordering::SeqCst);
        Box::pin(async {})
    });
    let text = sized_text(HERDR_MAX_REQUEST_BYTES + 1);
    // Rejects without the clock moving: the result is ready on first poll.
    let herdr = client(&server.path);
    let pending = herdr.call_simple("pane.send_input", json!({ "text": text }));
    let result = futures_util::FutureExt::now_or_never(pending).expect("refused at once");
    assert_eq!(
        result,
        Err("pane.send_input: too large for Herdr (1025 KiB, at most 1024)".into())
    );
    assert!(!connected.load(Ordering::SeqCst));
}

#[tokio::test]
async fn bounds_a_one_shot_response_without_a_newline() {
    let server = start_server(|mut stream, _| {
        Box::pin(async move {
            let _ = stream.write_all(&vec![b'x'; 1024 * 1024 + 1]).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        })
    });
    let error = client(&server.path)
        .call_simple("ping", json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("response line is too large"), "{error}");
}

#[tokio::test]
async fn destroys_a_half_open_socket_when_a_call_times_out() {
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let closed_tx = Arc::new(Mutex::new(Some(closed_tx)));
    let server = start_server(move |mut stream, _| {
        let closed_tx = closed_tx.clone();
        Box::pin(async move {
            let mut buffer = [0u8; 16];
            // Reads end once the client closes its side.
            while stream.read(&mut buffer).await.unwrap_or(0) > 0 {}
            if let Some(tx) = closed_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        })
    });
    let error = client(&server.path)
        .call("ping", json!({}), 25, None, false)
        .await
        .unwrap_err();
    assert_eq!(error, "timeout: ping");
    tokio::time::timeout(Duration::from_millis(500), closed_rx)
        .await
        .expect("server observed the client closing")
        .unwrap();
}

#[tokio::test]
async fn falls_back_to_bun_connect_when_the_synchronous_connect_fails() {
    // One connect path in Rust: a missing socket and a path too long for a
    // unix socket both fail the call instead of hanging.
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.sock");
    let too_long = dir.path().join("x".repeat(120)).join("herdr.sock");
    for path in [missing, too_long] {
        assert!(
            client(path.to_str().unwrap())
                .call_simple("ping", json!({}))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn concurrent_identical_reads_share_one_request() {
    let (server, received) = start_counting_server(20);
    let client = client(&server.path);
    let results = futures_util::future::join_all([
        client.call_simple("pane.list", json!({})),
        client.call_simple("pane.list", json!({})),
        client.call_simple("agent.get", json!({"pane_id": "p1"})),
        client.call_simple("agent.get", json!({"pane_id": "p1"})),
        client.call_simple("agent.get", json!({"pane_id": "p2"})),
    ])
    .await
    .into_iter()
    .map(Result::unwrap)
    .collect::<Vec<_>>();
    let mut methods = received.lock().unwrap().clone();
    methods.sort();
    assert_eq!(methods, ["agent.get", "agent.get", "pane.list"]);
    assert_eq!(results[0], results[1]);
    assert_eq!(results[2], results[3]);
    assert_eq!(results[4]["params"], json!({"pane_id": "p2"}));
    // Each caller owns its copy.
    let mut first = results[0].clone();
    first["n"] = json!(-1);
    assert_ne!(results[1]["n"], json!(-1));
}

#[tokio::test]
async fn reuses_a_list_answer_briefly_but_not_a_get_answer() {
    let (server, received) = start_counting_server(0);
    let client = reusing(&server.path, 60_000.0);
    let first = client
        .call_simple("workspace.list", json!({}))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        client
            .call_simple("workspace.list", json!({}))
            .await
            .unwrap(),
        first
    );
    client
        .call_simple("pane.get", json!({"pane_id": "p1"}))
        .await
        .unwrap();
    client
        .call_simple("pane.get", json!({"pane_id": "p1"}))
        .await
        .unwrap();
    assert_eq!(
        *received.lock().unwrap(),
        ["workspace.list", "pane.get", "pane.get"]
    );
    let expiring = reusing(&server.path, 0.0);
    expiring.call_simple("tab.list", json!({})).await.unwrap();
    expiring.call_simple("tab.list", json!({})).await.unwrap();
    assert_eq!(
        received
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == "tab.list")
            .count(),
        2
    );
}

/// Lets the bookkeeping task of a finished shared read run.
async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn a_change_through_the_client_or_a_herdr_event_ends_reuse() {
    let (server, received) = start_counting_server(0);
    let client = reusing(&server.path, 60_000.0);
    client.call_simple("pane.list", json!({})).await.unwrap();
    settle().await;
    client
        .call_simple("pane.split", json!({"pane_id": "p1"}))
        .await
        .unwrap();
    client.call_simple("pane.list", json!({})).await.unwrap();
    settle().await;
    // Pings change nothing.
    client.call_simple("ping", json!({})).await.unwrap();
    client.call_simple("pane.list", json!({})).await.unwrap();
    assert_eq!(
        *received.lock().unwrap(),
        ["pane.list", "pane.split", "pane.list", "ping"]
    );
    client.invalidate_reads();
    client.call_simple("pane.list", json!({})).await.unwrap();
    let received = received.lock().unwrap();
    assert_eq!(received.last().unwrap(), "pane.list");
    assert_eq!(received.len(), 5);
}

#[tokio::test]
async fn a_read_in_flight_when_a_change_starts_is_not_joined_after_it() {
    let (server, received) = start_counting_server(30);
    let client = reusing(&server.path, 60_000.0);
    let before = tokio::spawn({
        let client = client.clone();
        async move { client.call_simple("pane.list", json!({})).await }
    });
    tokio::time::sleep(Duration::from_millis(5)).await;
    let change = tokio::spawn({
        let client = client.clone();
        async move { client.call_simple("tab.create", json!({})).await }
    });
    tokio::task::yield_now().await;
    let after = tokio::spawn({
        let client = client.clone();
        async move { client.call_simple("pane.list", json!({})).await }
    });
    let before = before.await.unwrap().unwrap();
    change.await.unwrap().unwrap();
    let after = after.await.unwrap().unwrap();
    assert_eq!(
        *received.lock().unwrap(),
        ["pane.list", "tab.create", "pane.list"]
    );
    assert!(after["n"].as_u64() > before["n"].as_u64());
    settle().await;
    // Neither read overlapping the change is reused once it ends.
    assert_eq!(
        client.call_simple("pane.list", json!({})).await.unwrap()["n"],
        4
    );
}

#[tokio::test]
async fn an_event_on_a_subscription_ends_reuse() {
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let (sub_tx, sub_rx) = tokio::sync::oneshot::channel::<UnixStream>();
    let sub_tx = Arc::new(Mutex::new(Some(sub_tx)));
    let seen = received.clone();
    let server = start_server(move |mut stream, data| {
        let seen = seen.clone();
        let sub_tx = sub_tx.clone();
        Box::pin(async move {
            let request: Value = serde_json::from_slice(&data).unwrap();
            seen.lock()
                .unwrap()
                .push(request["method"].as_str().unwrap().to_owned());
            let line = format!("{}\n", json!({"id": request["id"], "result": {}}));
            if request["method"] == "events.subscribe" {
                stream.write_all(line.as_bytes()).await.unwrap();
                if let Some(tx) = sub_tx.lock().unwrap().take() {
                    let _ = tx.send(stream);
                }
                return;
            }
            answer(stream, line).await;
        })
    });
    let client = reusing(&server.path, 60_000.0);
    let mut events = client.events();
    let subscription = client.subscribe(&["pane.created".into()], SUBSCRIPTION_ACK_TIMEOUT_MS);
    subscription.ready.clone().await.unwrap();
    client.call_simple("pane.list", json!({})).await.unwrap();
    settle().await;
    client.call_simple("pane.list", json!({})).await.unwrap();
    let mut subscriber = sub_rx.await.unwrap();
    subscriber
        .write_all(format!("{}\n", json!({"event": "pane.created", "data": {}})).as_bytes())
        .await
        .unwrap();
    loop {
        if let ClientEvent::Event(_) = events.recv().await.unwrap() {
            break;
        }
    }
    client.call_simple("pane.list", json!({})).await.unwrap();
    subscription.close();
    assert_eq!(
        *received.lock().unwrap(),
        ["events.subscribe", "pane.list", "pane.list"]
    );
}

#[tokio::test]
async fn a_fresh_read_neither_joins_nor_reuses_and_refreshes_reuse() {
    let (server, received) = start_counting_server(10);
    let client = reusing(&server.path, 60_000.0);
    let (shared, fresh) = tokio::join!(
        client.call_simple("workspace.list", json!({})),
        client.call("workspace.list", json!({}), 5000, None, true),
    );
    assert_eq!(
        *received.lock().unwrap(),
        ["workspace.list", "workspace.list"]
    );
    assert_eq!(fresh.unwrap()["n"], 2);
    assert_eq!(shared.unwrap()["n"], 1);
    settle().await;
    // The later answer is the one reused.
    assert_eq!(
        client
            .call_simple("workspace.list", json!({}))
            .await
            .unwrap()["n"],
        2
    );
    assert_eq!(
        client
            .call("workspace.list", json!({}), 5000, None, true)
            .await
            .unwrap()["n"],
        3
    );
}

#[tokio::test]
async fn checks_each_callers_before_send_for_that_caller_only() {
    let (server, received) = start_counting_server(10);
    let client = client(&server.path);
    let (refused, allowed) = tokio::join!(
        client.call(
            "pane.list",
            json!({}),
            5000,
            Some(Box::new(|| Err("Approval revoked".into()))),
            false
        ),
        client.call(
            "pane.list",
            json!({}),
            5000,
            Some(Box::new(|| Ok(()))),
            false
        ),
    );
    assert_eq!(refused, Err("Approval revoked".into()));
    assert_eq!(allowed.unwrap()["method"], "pane.list");
    assert_eq!(*received.lock().unwrap(), ["pane.list"]);
}

#[tokio::test]
async fn a_caller_joining_a_read_in_flight_keeps_its_own_timeout() {
    let (server, _) = start_counting_server(200);
    let client = client(&server.path);
    let (patient, hurried) = tokio::join!(
        client.call("pane.list", json!({}), 5000, None, false),
        client.call("pane.list", json!({}), 20, None, false),
    );
    assert_eq!(hurried, Err("timeout: pane.list".into()));
    assert_eq!(patient.unwrap()["method"], "pane.list");
}

#[tokio::test]
async fn close_before_acknowledgement_rejects_ready_and_resolves_closed() {
    let server = start_server(|stream, _| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(stream);
        })
    });
    let client = client(&server.path);
    let subscription = client.subscribe(&["pane.updated".into()], SUBSCRIPTION_ACK_TIMEOUT_MS);
    subscription.close();
    subscription.close();
    assert_eq!(
        subscription.ready.clone().await,
        Err("subscription closed before acknowledgement".into())
    );
    subscription.closed.clone().await;
}

#[tokio::test]
async fn rejects_a_mismatched_acknowledgement_and_an_acknowledgement_timeout() {
    let mismatched = start_server(|mut stream, _| {
        Box::pin(async move {
            let _ = stream
                .write_all(format!("{}\n", json!({"id": "wrong", "result": {}})).as_bytes())
                .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        })
    });
    let subscription =
        client(&mismatched.path).subscribe(&["pane.updated".into()], SUBSCRIPTION_ACK_TIMEOUT_MS);
    assert_eq!(
        subscription.ready.clone().await,
        Err("invalid subscription acknowledgement".into())
    );
    subscription.closed.clone().await;

    let silent = start_server(|stream, _| {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(stream);
        })
    });
    let subscription = client(&silent.path).subscribe(&["pane.updated".into()], 10);
    let error = subscription.ready.clone().await.unwrap_err();
    assert!(error.contains("acknowledgement timed out"), "{error}");
    subscription.closed.clone().await;
}

#[tokio::test]
async fn close_forcefully_resolves_closed_after_acknowledgement() {
    let server = start_server(|mut stream, _| {
        Box::pin(async move {
            let _ = stream
                .write_all(format!("{}\n", json!({"id": "sub", "result": {}})).as_bytes())
                .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        })
    });
    let subscription =
        client(&server.path).subscribe(&["pane.updated".into()], SUBSCRIPTION_ACK_TIMEOUT_MS);
    assert_eq!(subscription.ready.clone().await, Ok(()));
    subscription.close();
    subscription.close();
    subscription.closed.clone().await;
}

fn capturing(level: LogLevel, scope: Option<&str>) -> (Logger, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    let logger = Logger::with(LoggerOptions {
        level: Some(level),
        scope: scope.map(Into::into),
        stdout: Some(Arc::new(move |line: &str| {
            sink.lock().unwrap().push(line.to_owned())
        })),
        ..LoggerOptions::default()
    });
    (logger, lines)
}

#[tokio::test]
async fn logs_method_sizes_and_round_trip_timings_for_each_call() {
    let server = start_server(|stream, data| {
        let request: Value = serde_json::from_slice(&data).unwrap();
        answer(
            stream,
            format!("{}\n", json!({"id": request["id"], "result": {"ok": true}})),
        )
    });
    let (logger, lines) = capturing(LogLevel::Debug, Some("herdr"));
    let client = HerdrClient::new(
        &server.path,
        HerdrClientOptions {
            logger: Some(logger),
            connection_id: Some("conn_1".into()),
            ..HerdrClientOptions::default()
        },
    );
    assert_eq!(
        client
            .call_simple("pane.list", json!({"workspace": "w1"}))
            .await,
        Ok(json!({"ok": true}))
    );
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 1);
    let pattern = regex_lite_match(&lines[0]);
    assert!(pattern, "{}", lines[0]);
}

/// The TS test's regular expression, by hand.
fn regex_lite_match(line: &str) -> bool {
    let Some(rest) =
        line.split_once(" DEBUG herdr herdr call connection=conn_1 method=pane.list status=ok ")
    else {
        return false;
    };
    let fields: Vec<&str> = rest.1.split(' ').collect();
    let names = [
        "req_bytes",
        "resp_bytes",
        "total_ms",
        "connect_ms",
        "first_byte_ms",
    ];
    fields.len() == names.len()
        && fields.iter().zip(names).all(|(field, name)| {
            field
                .strip_prefix(&format!("{name}="))
                .is_some_and(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        })
}

#[tokio::test]
async fn logs_failures_without_a_first_byte() {
    let server = start_server(|stream, _| {
        Box::pin(async move {
            drop(stream);
        })
    });
    let (logger, lines) = capturing(LogLevel::Debug, None);
    let client = HerdrClient::new(
        &server.path,
        HerdrClientOptions {
            logger: Some(logger),
            ..HerdrClientOptions::default()
        },
    );
    assert!(client.call_simple("ping", json!({})).await.is_err());
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].contains("method=ping status=error"),
        "{}",
        lines[0]
    );
    assert!(!lines[0].contains("first_byte_ms="));
    assert!(lines[0].contains("error="));
}
