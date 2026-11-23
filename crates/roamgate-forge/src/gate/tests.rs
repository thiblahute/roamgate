//! workspace/forge-calls.test.ts, the same cases on the Rust gate.

use super::*;
use roamgate_base::clock::Clock;
use roamgate_base::clock::TestClock;
use std::sync::atomic::{AtomicUsize, Ordering};

fn ok(body: &str) -> ProcessOutput {
    ProcessOutput {
        code: 0,
        stdout: format!("HTTP/2.0 200 OK\r\n\r\n{body}"),
        stderr: String::new(),
    }
}

fn call() -> ForgeCall {
    ForgeCall {
        host: "gitlab.example.com".into(),
        feature: "badge".into(),
        kind: "mr-list".into(),
        ..ForgeCall::default()
    }
}

fn argv() -> Vec<String> {
    [
        "glab",
        "api",
        "--hostname",
        "gitlab.example.com",
        "projects/1",
    ]
    .map(String::from)
    .to_vec()
}

fn spawn_with(
    answer: impl Fn(usize) -> ProcessOutput + Send + Sync + 'static,
) -> (Spawn, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let answer = Arc::new(answer);
    (
        Arc::new(move |_argv| {
            let n = counted.fetch_add(1, Ordering::SeqCst) + 1;
            let output = answer(n);
            Box::pin(async move { Ok(output) })
        }),
        calls,
    )
}

async fn turns() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn keeps_to_its_calls_per_minute_queueing_the_rest_in_order() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::with_limits(Arc::new(clock.clone()), 2, 4);
    let started: Arc<Mutex<Vec<i64>>> = Arc::default();
    let spawn: Spawn = {
        let started = started.clone();
        let clock = clock.clone();
        Arc::new(move |_| {
            started
                .lock()
                .unwrap()
                .push(roamgate_base::clock::Clock::now(&clock));
            Box::pin(async { Ok(ok("{}")) })
        })
    };
    let t0 = clock.now();
    let answers: Vec<_> = (0..3)
        .map(|_| tokio::spawn(gate.run("o", call(), argv(), spawn.clone())))
        .collect();
    turns().await;
    assert_eq!(started.lock().unwrap().len(), 2);
    clock.advance(59_000).await;
    turns().await;
    assert_eq!(started.lock().unwrap().len(), 2);
    clock.advance(1_000).await;
    for answer in answers {
        answer.await.unwrap().unwrap();
    }
    assert_eq!(started.lock().unwrap().len(), 3);
    assert_eq!(started.lock().unwrap()[2] - t0, 60_000);
    // Another forge host has its own budget.
    let github = ForgeCall {
        host: "github.com".into(),
        ..call()
    };
    gate.run("o", github, argv(), spawn).await.unwrap();
    assert_eq!(started.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn a_call_that_cannot_start_before_its_deadline_gives_up() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::with_limits(Arc::new(clock.clone()), 1, 4);
    let (spawn, _) = spawn_with(|_| ok("{}"));
    gate.run("o", call(), argv(), spawn.clone()).await.unwrap();
    let late = tokio::spawn(gate.run(
        "o",
        ForgeCall {
            deadline: Some(clock.now() + 5_000),
            ..call()
        },
        argv(),
        spawn,
    ));
    turns().await;
    clock.advance(5_000).await;
    assert_eq!(late.await.unwrap(), Err(GateError::Busy));
}

#[tokio::test]
async fn a_429_pauses_the_host_for_retry_after_then_calls_go_on() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::new(Arc::new(clock.clone()));
    let (limited, _) = spawn_with(|_| ProcessOutput {
        code: 1,
        stdout: "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n{}".into(),
        stderr: "glab: HTTP 429".into(),
    });
    let first = gate
        .run(
            "o",
            ForgeCall {
                include: true,
                ..call()
            },
            argv(),
            limited,
        )
        .await
        .unwrap();
    assert_eq!(first.status, Some(429));
    assert_eq!(first.code, 1);
    assert_eq!(
        gate.paused_until("o", "", "gitlab.example.com"),
        clock.now() + 30_000
    );
    let (spawn, calls) = spawn_with(|_| ok("{}"));
    let next = tokio::spawn(gate.run("o", call(), argv(), spawn));
    turns().await;
    clock.advance(29_000).await;
    turns().await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    clock.advance(1_000).await;
    next.await.unwrap().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn ratelimit_remaining_0_waits_for_the_reset_a_bare_429_a_minute() {
    let now = parse_http_date("Mon, 02 Nov 2026 19:00:00 GMT").unwrap();
    let headers = |pairs: &[(&str, String)]| -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect()
    };
    assert_eq!(
        rate_limit_pause(
            Some(200),
            &headers(&[
                ("ratelimit-remaining", "0".into()),
                ("ratelimit-reset", (now / 1000 + 120).to_string())
            ]),
            now
        ),
        Some(now + 120_000)
    );
    assert_eq!(
        rate_limit_pause(Some(429), &HashMap::new(), now),
        Some(now + 60_000)
    );
    assert_eq!(
        rate_limit_pause(
            Some(200),
            &headers(&[("x-ratelimit-remaining", "4000".into())]),
            now
        ),
        None
    );
    assert_eq!(
        rate_limit_pause(
            Some(429),
            &headers(&[("retry-after", "Mon, 02 Nov 2026 19:00:10 GMT".into())]),
            now
        ),
        Some(now + 10_000)
    );
}

#[tokio::test]
async fn a_429_seen_only_on_stderr_pauses_the_host_too() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::new(Arc::new(clock.clone()));
    let (spawn, _) = spawn_with(|_| ProcessOutput {
        code: 1,
        stdout: String::new(),
        stderr: "glab: 429 Too Many Requests (HTTP 429)".into(),
    });
    gate.run("o", call(), argv(), spawn).await.unwrap();
    assert_eq!(
        gate.paused_until("o", "", "gitlab.example.com"),
        clock.now() + 60_000
    );
}

#[tokio::test]
async fn gets_come_back_with_if_none_match_a_304_answers_with_what_was_known() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::new(Arc::new(clock.clone()));
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let spawn: Spawn = {
        let seen = seen.clone();
        Arc::new(move |argv: Vec<String>| {
            let first = seen.lock().unwrap().is_empty();
            seen.lock().unwrap().push(argv);
            Box::pin(async move {
                Ok(ProcessOutput {
                    code: 0,
                    stdout: if first {
                        "HTTP/2.0 200 OK\r\nETag: \"e1\"\r\n\r\n[1]".into()
                    } else {
                        "HTTP/2.0 304 Not Modified\r\n\r\n".into()
                    },
                    stderr: String::new(),
                })
            })
        })
    };
    let conditional = ForgeCall {
        conditional: true,
        ..call()
    };
    let first = gate
        .run("o", conditional.clone(), argv(), spawn.clone())
        .await
        .unwrap();
    assert_eq!(first.stdout, "[1]");
    let second = gate.run("o", conditional, argv(), spawn).await.unwrap();
    assert!(second.not_modified);
    assert_eq!(second.stdout, "[1]");
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0][2], "--include");
    assert_eq!(
        &seen[1][2..5],
        ["--include", "--header", "If-None-Match: \"e1\""]
    );
    assert_eq!(without_gate_flags(&seen[1]), argv());
}

#[tokio::test]
async fn identical_calls_share_one_in_flight_and_its_answer_for_a_while_failures_are_not_kept() {
    let clock = TestClock::new(1_000_000);
    let gate = ForgeGate::new(Arc::new(clock.clone()));
    let (spawn, calls) = spawn_with(|n| ok(&format!("{{\"n\":{n}}}")));
    let reuse = ForgeCall {
        reuse_ms: Some(10_000),
        ..call()
    };
    let (a, b) = tokio::join!(
        gate.run("o", reuse.clone(), argv(), spawn.clone()),
        gate.run("o", reuse.clone(), argv(), spawn.clone())
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(a, b);
    // Another feature asking the same thing shares it too.
    gate.run(
        "o",
        ForgeCall {
            feature: "chip".into(),
            ..reuse.clone()
        },
        argv(),
        spawn.clone(),
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    clock.advance(10_000).await;
    gate.run("o", reuse.clone(), argv(), spawn).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let (failing, failures) = spawn_with(|_| ProcessOutput {
        code: 1,
        stdout: String::new(),
        stderr: "HTTP 500".into(),
    });
    let mut other = argv();
    other.push("x".into());
    gate.run("o", reuse.clone(), other.clone(), failing.clone())
        .await
        .unwrap();
    gate.run("o", reuse, other, failing).await.unwrap();
    assert_eq!(failures.load(Ordering::SeqCst), 2);
}

#[test]
fn the_response_headers_are_cut_off_the_body() {
    let split = split_included("HTTP/1.1 100 Continue\r\n\r\nHTTP/2.0 201 Created\nETag: x\n\n[1]");
    assert_eq!(split.status, Some(201));
    assert_eq!(
        split.headers,
        HashMap::from([("etag".to_owned(), "x".to_owned())])
    );
    assert_eq!(split.body, "[1]");
    assert_eq!(split_included("[1]").body, "[1]");
    assert_eq!(split_included("[1]").status, None);
}
