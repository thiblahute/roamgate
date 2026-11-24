//! Both sides of the channel over real Unix sockets: the handshake, the
//! core of `roamgate core` (with its test family) against a front made of
//! this crate's peer, calls, cancels, pushes, streamed HTTP with its
//! window, reverse calls and liveness.
#![cfg(unix)]
// Tests wait on real time; the server code reads it through its Clock.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_sidecar::core::run_core;
use roamgate_sidecar::peer::{
    BoxFuture, Handler, HandshakeError, HttpRequest, IncomingCall, Peer, PeerOptions, accept_hello,
    say_hello,
};
use roamgate_sidecar::protocol::{
    BODY_WINDOW, Ctx, Message, PROTOCOL, Push, RpcError, ShadowSettings, Side,
};
use roamgate_sidecar::transport::{BoxStream, Listener};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn clock() -> SharedClock {
    Arc::new(SystemClock)
}

fn welcome(_: &Message) -> Message {
    Message::Welcome {
        protocol: PROTOCOL,
        side: Side::Bun,
        owners: BTreeMap::new(),
        shadow: ShadowSettings::default(),
        clock: None,
        raw_data: false,
    }
}

fn hello(token: &str, protocol: u32) -> Message {
    Message::Hello {
        protocol,
        token: token.into(),
        side: Side::Rust,
        version: "test".into(),
        pid: 1,
        families: vec![],
        test: false,
    }
}

fn pair() -> (BoxStream, BoxStream) {
    let (a, b) = tokio::net::UnixStream::pair().unwrap();
    (Box::new(a), Box::new(b))
}

/// The front of these tests: records pushes, answers `test.echo`.
#[derive(Default)]
struct Front {
    pushes: Mutex<Vec<Push>>,
    sent: Mutex<Vec<Message>>,
    pushed: tokio::sync::Notify,
}

impl Handler for Front {
    fn reverse_call(
        &self,
        _peer: &Peer,
        target: String,
        args: Value,
        ctx: Ctx,
    ) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            if target == "test.echo" {
                Ok(json!({"args": args, "ctx": ctx}))
            } else {
                Err(RpcError::with_code("no", "unknown_target"))
            }
        })
    }

    fn push(&self, push: Push) {
        self.pushes.lock().unwrap().push(push);
        self.pushed.notify_waiters();
    }

    fn socket(&self, _peer: &Peer, message: Message) {
        self.sent.lock().unwrap().push(message);
        self.pushed.notify_waiters();
    }
}

#[tokio::test]
async fn the_handshake_checks_the_token_and_the_protocol() {
    for (token, protocol, refusal) in [
        ("wrong", PROTOCOL, Some("wrong token")),
        (TOKEN, PROTOCOL + 1, Some("protocol 2, this side speaks 1")),
        (TOKEN, PROTOCOL, None),
    ] {
        let (mut front, mut core) = pair();
        let accepting = tokio::spawn(async move { accept_hello(&mut front, TOKEN, welcome).await });
        let said = say_hello(&mut core, &hello(token, protocol)).await;
        let accepted = accepting.await.unwrap();
        match refusal {
            Some(reason) => {
                assert!(matches!(said, Err(HandshakeError::Refused(ref r)) if r == reason));
                assert!(matches!(accepted, Err(HandshakeError::Refused(_))));
            }
            None => {
                assert!(matches!(said, Ok(Message::Welcome { .. })));
                assert!(matches!(accepted, Ok(Message::Hello { .. })));
            }
        }
    }
}

/// `roamgate core`'s code in this process, against a listening front.
struct Running {
    front: Peer,
    handler: Arc<Front>,
    hello: Message,
    core: tokio::task::JoinHandle<u8>,
    _dir: tempfile::TempDir,
}

async fn start_core(test: bool, token: &str) -> Result<Running, (HandshakeError, u8)> {
    start_core_with(test, token, Vec::new(), welcome).await
}

async fn start_core_with(
    test: bool,
    token: &str,
    families: roamgate_sidecar::family::Families,
    welcome: fn(&Message) -> Message,
) -> Result<Running, (HandshakeError, u8)> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let mut listener = Listener::bind(path.to_str().unwrap()).unwrap();
    let env: HashMap<String, String> = HashMap::from([
        ("ROAMGATE_CORE_CHANNEL".into(), path.display().to_string()),
        ("ROAMGATE_CORE_TOKEN".into(), token.into()),
        (
            "ROAMGATE_CORE_TEST".into(),
            if test { "1" } else { "0" }.into(),
        ),
        ("ROAMGATE_LOG_LEVEL".into(), "error".into()),
    ]);
    let core = tokio::spawn(async move { run_core(&env, "9.9.9", families).await });
    let mut stream = listener.accept().await.unwrap();
    match accept_hello(&mut stream, TOKEN, welcome).await {
        Ok(hello) => {
            let handler = Arc::new(Front::default());
            let front = Peer::start(stream, handler.clone(), PeerOptions::front(clock()));
            Ok(Running {
                front,
                handler,
                hello,
                core,
                _dir: dir,
            })
        }
        Err(error) => Err((error, core.await.unwrap())),
    }
}

#[tokio::test]
async fn a_refused_core_exits_3() {
    let Err((error, code)) = start_core(false, "not the token").await else {
        panic!("accepted");
    };
    assert!(matches!(error, HandshakeError::Refused(_)));
    assert_eq!(code, 3);
}

#[tokio::test]
async fn without_the_test_family_the_core_has_no_family() {
    let Ok(running) = start_core(false, TOKEN).await else {
        panic!("refused");
    };
    let Message::Hello {
        families,
        test,
        side,
        version,
        ..
    } = &running.hello
    else {
        panic!()
    };
    assert_eq!((families.len(), *test, *side), (0, false, Side::Rust));
    assert_eq!(version, "9.9.9");
    let error = running
        .front
        .call("test.echo.read", json!({}), Ctx::default(), false)
        .await
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("unknown_method"));
    let reply = running
        .front
        .http(
            HttpRequest {
                method: "GET".into(),
                url: "/api/test-echo/stream?bytes=3".into(),
                ..HttpRequest::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 404);
    running.front.bye();
    assert_eq!(running.core.await.unwrap(), 0);
}

#[tokio::test]
async fn the_test_family_over_the_channel() {
    let Ok(running) = start_core(true, TOKEN).await else {
        panic!("refused");
    };
    let Message::Hello { families, test, .. } = &running.hello else {
        panic!()
    };
    assert_eq!(families, &vec!["test.echo".to_owned()]);
    assert!(*test);
    let front = &running.front;
    let ctx = Ctx {
        connection_id: Some("c1".into()),
        connection_generation: Some(2),
        socket_id: Some(7),
        ..Ctx::default()
    };

    // A call and its context.
    let read = front
        .call("test.echo.read", json!({"x": 1}), ctx.clone(), false)
        .await
        .unwrap();
    assert_eq!(
        read,
        json!({"params": {"x": 1}, "ctx": {"connection_id": "c1", "connection_generation": 2, "socket_id": 7}})
    );

    // A reverse call made while answering a call.
    let reverse = front
        .call("test.echo.reverse", json!({"y": 2}), ctx.clone(), false)
        .await
        .unwrap();
    assert_eq!(reverse["args"], json!({"y": 2}));
    assert_eq!(reverse["ctx"]["socket_id"], 7);

    // Pushes: the reply comes after them, the last one always arrives.
    let pushed = front
        .call(
            "test.echo.push",
            json!({"key": "k", "count": 200, "message": {"kind": "t"}, "socket_id": 3}),
            Ctx::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(pushed, json!({"pushed": 200}));
    let pushes = running.handler.pushes.lock().unwrap().clone();
    assert!(!pushes.is_empty() && pushes.len() <= 200);
    let last = pushes.last().unwrap();
    assert_eq!(last.message, json!({"test_echo": 199, "kind": "t"}));
    assert_eq!((last.key.as_deref(), last.socket_id), (Some("k"), Some(3)));
    let indices: Vec<u64> = pushes
        .iter()
        .map(|push| push.message["test_echo"].as_u64().unwrap())
        .collect();
    assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));

    // A download larger than the window: the core stalls at 4 MiB until
    // the front reads.
    let size = 10 * 1024 * 1024;
    let reply = front
        .http(
            HttpRequest {
                method: "GET".into(),
                url: format!("/api/test-echo/stream?bytes={size}"),
                ..HttpRequest::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(
        reply.headers,
        vec![(
            "content-type".to_owned(),
            "application/octet-stream".to_owned()
        )]
    );
    let body = reply.body.unwrap();
    let mut buffered = 0;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        buffered = body.buffered();
        if buffered >= BODY_WINDOW {
            break;
        }
    }
    assert_eq!(buffered, BODY_WINDOW);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(body.buffered(), BODY_WINDOW, "past the window");
    let all = body.read_all().await;
    assert_eq!(all.len(), size);
    assert!(all.iter().all(|byte| *byte == b'x'));

    // An upload, echoed back.
    let (tx, rx) = mpsc::channel(4);
    let sent: Vec<u8> = (0..(1024 * 1024 + 17)).map(|i| (i % 251) as u8).collect();
    let feeding = {
        let sent = sent.clone();
        tokio::spawn(async move {
            for piece in sent.chunks(100_000) {
                tx.send(piece.to_vec()).await.unwrap();
            }
        })
    };
    let reply = front
        .http(
            HttpRequest {
                method: "POST".into(),
                url: "/api/test-echo/stream".into(),
                ..HttpRequest::default()
            },
            Some(rx),
        )
        .await
        .unwrap();
    assert_eq!(reply.body.unwrap().read_all().await, sent);
    feeding.await.unwrap();

    // The front stops: the core exits 0.
    front.bye();
    front.closed().await;
    assert_eq!(running.core.await.unwrap(), 0);
}

/// Answers `slow` never, and says when it was dropped (cancelled).
struct Slow {
    dropped: Arc<AtomicBool>,
}

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Handler for Slow {
    fn call(&self, _peer: &Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let flag = SetOnDrop(self.dropped.clone());
        Box::pin(async move {
            let _flag = flag;
            if call.method == "slow" {
                std::future::pending::<()>().await;
            }
            Ok(json!(call.method))
        })
    }
}

struct Nothing;

impl Handler for Nothing {}

#[tokio::test]
async fn a_dropped_call_is_cancelled_on_the_other_side() {
    let (a, b) = pair();
    let dropped = Arc::new(AtomicBool::new(false));
    let caller = Peer::start(a, Arc::new(Nothing), PeerOptions::core(clock()));
    let _callee = Peer::start(
        b,
        Arc::new(Slow {
            dropped: dropped.clone(),
        }),
        PeerOptions::core(clock()),
    );
    let gave_up = tokio::time::timeout(
        Duration::from_millis(100),
        caller.call("slow", Value::Null, Ctx::default(), false),
    )
    .await;
    assert!(gave_up.is_err());
    for _ in 0..100 {
        if dropped.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(dropped.load(Ordering::SeqCst));
    // The channel still answers.
    assert_eq!(
        caller
            .call("fast", Value::Null, Ctx::default(), true)
            .await
            .unwrap(),
        json!("fast")
    );
    // A closed channel fails what waits and what comes.
    caller.bye();
    caller.closed().await;
    let error = caller
        .call("fast", Value::Null, Ctx::default(), false)
        .await
        .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("channel_closed"));
}

#[tokio::test(flavor = "current_thread")]
async fn queued_pushes_with_a_key_coalesce_to_the_newest() {
    let (a, b) = pair();
    let receiver = Arc::new(Front::default());
    let sender = Peer::start(a, Arc::new(Nothing), PeerOptions::core(clock()));
    let _peer = Peer::start(b, receiver.clone(), PeerOptions::core(clock()));
    // No await between them: the writer has not run, all are queued.
    for index in 0..100 {
        sender.push(Push {
            message: json!({"n": index}),
            key: Some("review".into()),
            ..Push::default()
        });
        sender.push(Push {
            message: json!({"other": index}),
            key: Some("work".into()),
            ..Push::default()
        });
    }
    sender.push(Push {
        message: json!({"unkeyed": true}),
        ..Push::default()
    });
    let (done_tx, done_rx) = oneshot::channel::<()>();
    let waiting = {
        let receiver = receiver.clone();
        tokio::spawn(async move {
            loop {
                let notified = receiver.pushed.notified();
                if receiver.pushes.lock().unwrap().len() >= 3 {
                    break;
                }
                notified.await;
            }
            let _ = done_tx.send(());
        })
    };
    done_rx.await.unwrap();
    waiting.await.unwrap();
    let messages: Vec<Value> = receiver
        .pushes
        .lock()
        .unwrap()
        .iter()
        .map(|push| push.message.clone())
        .collect();
    assert_eq!(
        messages,
        vec![
            json!({"n": 99}),
            json!({"other": 99}),
            json!({"unkeyed": true})
        ]
    );
}

#[tokio::test]
async fn a_large_ws_send_goes_with_its_data_apart_to_a_front_that_reads_it() {
    let (a, b) = pair();
    let receiver = Arc::new(Front::default());
    let core = Peer::start(
        a,
        Arc::new(Nothing),
        PeerOptions {
            raw_data: true,
            ..PeerOptions::core(clock())
        },
    );
    let _front = Peer::start(b, receiver.clone(), PeerOptions::front(clock()));
    // Quotes, backslashes, newlines and characters past ASCII arrive as sent.
    let large = format!("{{\"result\":\"{}\"}}", "a\\\"b\né 🎉 ".repeat(2000));
    let sent = [
        Message::WsSend {
            socket_id: 7,
            data: large.clone(),
            binary: false,
            context: Some("core".into()),
            key: Some("review".into()),
        },
        Message::WsSend {
            socket_id: 7,
            data: "small".into(),
            binary: false,
            context: None,
            key: None,
        },
    ];
    for message in &sent {
        core.send(message);
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let notified = receiver.pushed.notified();
            if receiver.sent.lock().unwrap().len() >= 2 {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*receiver.sent.lock().unwrap(), sent.to_vec());
}

#[tokio::test(start_paused = true)]
async fn the_front_pings_and_drops_a_silent_core() {
    // Tokio's paused time, which moves by itself while the runtime idles.
    let clock = || -> SharedClock { Arc::new(roamgate_base::clock::TokioClock::starting_at(0)) };
    // A core that answers pings keeps the channel.
    let (a, b) = pair();
    let front = Peer::start(a, Arc::new(Nothing), PeerOptions::front(clock()));
    let _core = Peer::start(b, Arc::new(Nothing), PeerOptions::core(clock()));
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert!(!front.is_closed());

    // One that never answers is dropped after 30 s.
    let (a, silent) = pair();
    let front = Peer::start(a, Arc::new(Nothing), PeerOptions::front(clock()));
    tokio::time::sleep(Duration::from_secs(29)).await;
    assert!(!front.is_closed());
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(front.is_closed());
    drop(silent);
}

#[tokio::test]
async fn unknown_messages_are_ignored() {
    use tokio::io::AsyncWriteExt;
    let (a, mut raw) = pair();
    let peer = Peer::start(a, Arc::new(Nothing), PeerOptions::core(clock()));
    raw.write_all(&roamgate_sidecar::protocol::encode_message(
        &json!({"t": "from_the_future", "x": 1}),
    ))
    .await
    .unwrap();
    raw.write_all(&roamgate_sidecar::protocol::encode_message(
        &json!({"t": "ping", "n": 5}),
    ))
    .await
    .unwrap();
    let frame = roamgate_sidecar::frames::read_frame(&mut raw, 1 << 20)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.1, br#"{"t":"pong","n":5}"#);
    assert!(!peer.is_closed());
    // A frame of an unknown kind closes the channel.
    raw.write_all(&roamgate_protocol::frames::encode(9, b"?"))
        .await
        .unwrap();
    peer.closed().await;
}

/// A family that answers its calls, counts the internal ones, records its
/// ownership changes and reads the families' clock.
#[derive(Default)]
struct LimitFamily {
    owned: Mutex<Vec<bool>>,
}

impl roamgate_sidecar::family::CoreFamily for LimitFamily {
    fn name(&self) -> &'static str {
        "limit_resume"
    }

    fn call(
        &self,
        cx: &roamgate_sidecar::family::FamilyContext,
        call: IncomingCall,
    ) -> BoxFuture<Result<Value, RpcError>> {
        let now = cx.clock.now();
        Box::pin(async move { Ok(json!({"method": call.method, "now": now})) })
    }

    fn owned(&self, _cx: &roamgate_sidecar::family::FamilyContext, owned: bool) {
        self.owned.lock().unwrap().push(owned);
    }
}

fn welcome_on_a_test_clock(_: &Message) -> Message {
    Message::Welcome {
        protocol: PROTOCOL,
        side: Side::Bun,
        owners: BTreeMap::from([("limit_resume".into(), Side::Rust)]),
        shadow: ShadowSettings::default(),
        clock: Some(1_000_000),
        raw_data: false,
    }
}

#[tokio::test]
async fn families_get_their_calls_ownership_and_the_front_s_test_clock() {
    let family = Arc::new(LimitFamily::default());
    let Ok(running) = start_core_with(
        false,
        TOKEN,
        vec![family.clone() as Arc<dyn roamgate_sidecar::family::CoreFamily>],
        welcome_on_a_test_clock,
    )
    .await
    else {
        panic!("refused");
    };
    let Message::Hello { families, .. } = &running.hello else {
        panic!()
    };
    assert_eq!(families, &vec!["limit_resume".to_owned()]);
    let call = |method: &'static str, params: Value| {
        let front = running.front.clone();
        async move { front.call(method, params, Ctx::default(), false).await }
    };
    // Owned from the welcome on.
    let reply = call("limit_resume.list", json!({})).await.unwrap();
    assert_eq!(reply["method"], "limit_resume.list");
    // A debug core follows the front's test clock.
    if cfg!(debug_assertions) {
        assert_eq!(reply["now"], 1_000_000);
        let moved = call("internal.clock.advance", json!({"to": 1_060_000}))
            .await
            .unwrap();
        assert_eq!(moved, json!({"now": 1_060_000}));
        let reply = call("internal.limit_resume.poke", json!({})).await.unwrap();
        assert_eq!(
            reply,
            json!({"method": "internal.limit_resume.poke", "now": 1_060_000})
        );
    }
    // A method or internal call of no family the core has.
    for method in ["work.list", "internal.work.poke", "bridge.ping"] {
        let error = call(method, json!({})).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("unknown_method"), "{method}");
    }
    assert_eq!(*family.owned.lock().unwrap(), vec![true]);
    running
        .front
        .owner(BTreeMap::new(), ShadowSettings::default());
    for _ in 0..100 {
        if family.owned.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(*family.owned.lock().unwrap(), vec![true, false]);
    running.front.owner(
        BTreeMap::from([("limit_resume".into(), Side::Rust)]),
        ShadowSettings::default(),
    );
    running.front.bye();
    assert_eq!(running.core.await.unwrap(), 0);
    // Owned again, then the channel closed: told to stop.
    assert_eq!(family.owned.lock().unwrap().last(), Some(&false));
}

/// A core whose calls never answer (a family waiting on something slow).
struct Stuck;

impl Handler for Stuck {
    fn call(&self, _peer: &Peer, _call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn a_core_waiting_on_a_slow_call_keeps_the_channel_while_the_front_keeps_sending() {
    let clock = || -> SharedClock { Arc::new(roamgate_base::clock::TokioClock::starting_at(0)) };
    // The front sends a call every 5 s, so it never pings (it pings only
    // after 10 s without sending); each call hangs in the core.
    let run = |core_options: PeerOptions| async move {
        let (a, b) = pair();
        let front = Peer::start(a, Arc::new(Nothing), PeerOptions::front(clock()));
        let core = Peer::start(b, Arc::new(Stuck), core_options);
        for _ in 0..12 {
            let caller = front.clone();
            tokio::spawn(async move {
                let _ = caller
                    .call("limit_resume.list", json!({}), Ctx::default(), true)
                    .await;
            });
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        let closed = front.is_closed();
        drop(core);
        closed
    };
    // The core pings when it has said nothing for 10 s: the front hears
    // from it, 60 s on.
    assert!(!run(PeerOptions::core(clock())).await);
    // A core that only answered pings went 30 s silent and was dropped.
    let mute = PeerOptions {
        ping_after: None,
        ..PeerOptions::core(clock())
    };
    assert!(run(mute).await);
}
