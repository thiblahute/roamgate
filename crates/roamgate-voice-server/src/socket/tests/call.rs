//! call-audio.test.ts: a call, socket side, and its signalling, fronted.

use roamgate_base::log::Logger;
use serde_json::json;

use super::*;
use crate::config::tests::config;
use crate::helper::VoiceHelper;
use crate::helper::tests::{Fake, source};

pub(super) fn background() -> CallBackground {
    CallBackground {
        background: "audiotestsrc is-live=true".into(),
        volume: 0.6,
        ducked: 0.15,
        release_ms: 3000.0,
        muted: true,
        reply_loudness: Some(-16.0),
    }
}

/// A helper that makes WebRTC calls (call.rs).
pub(super) fn mixing(request: &Map<String, Value>) -> Vec<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request["op"].as_str() {
        Some("call_start") => vec![json!({
            "id": id, "ok": true, "rate": 48000, "channels": 2, "music": true,
            "signalling_port": 41234,
        })],
        Some("call_microphone") => vec![json!({"id": id, "ok": true})],
        Some("speak") => vec![json!({
            "id": id, "queued": true, "start_ms": 1035, "duration_ms": 1970, "now_ms": 1200,
            "language": "en", "rate": 1.5,
        })],
        Some("call_music") => vec![json!({
            "id": id, "ok": true,
            "volume": request.get("volume").filter(|volume| volume.is_number()).cloned().unwrap_or(json!(0.6)),
            "muted": request.get("muted") == Some(&json!(true)),
        })],
        _ => vec![],
    }
}

fn requests(fake: &Fake) -> Vec<Value> {
    fake.child(0).requests()
}

fn ops(fake: &Fake, op: &str) -> Vec<Value> {
    requests(fake)
        .into_iter()
        .filter(|request| request["op"] == op)
        .collect()
}

struct Started {
    clock: Arc<TestClock>,
    fake: Fake,
    socket: VoiceSocket,
    page: Socket,
    upstreams: Upstreams,
    token: String,
}

/// How the fake helper answers each request.
type Answering = Arc<dyn Fn(&Map<String, Value>) -> Vec<Value> + Send + Sync>;

struct Setup {
    answer: Option<Answering>,
    ice_address: Option<&'static str>,
    background: Option<CallBackground>,
    errors: Option<ErrorSink>,
    ended: Option<Arc<AtomicUsize>>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            answer: None,
            ice_address: Some("100.71.231.65"),
            background: Some(background()),
            errors: None,
            ended: None,
        }
    }
}

async fn started(setup: Setup) -> Started {
    let clock = clock();
    let fake = match setup.answer {
        Some(answer) => Fake::new(move |request| answer(request)),
        None => Fake::new(mixing),
    };
    let helper = VoiceHelper::with(
        source(config(json!({}))),
        fake.spawn(),
        clock.clone(),
        Logger::silent(),
    );
    let upstreams = Upstreams::default();
    let mut options = options(&clock);
    options.connect_upstream = upstreams.connect();
    let ice = setup.ice_address.map(str::to_owned);
    options.ice_address = Arc::new(move || ice.clone());
    let wanted = setup.background;
    options.background = Arc::new(move || wanted.clone());
    if let Some(errors) = setup.errors {
        options.errors = errors;
    }
    if let Some(ended) = setup.ended {
        options.on_call_ended = Arc::new(move || {
            ended.fetch_add(1, Ordering::SeqCst);
        });
    }
    let socket = VoiceSocket::new(Arc::new(helper), options);
    let page = Socket::new();
    say(&socket, &page, json!({"op": "call_audio", "on": true}));
    settle().await;
    let token = page.sent()[0]["resume"].as_str().unwrap_or("").to_owned();
    Started {
        clock,
        fake,
        socket,
        page,
        upstreams,
        token,
    }
}

#[tokio::test]
async fn starts_a_webrtc_call_for_its_page() {
    let ready = started(Setup::default()).await;
    let first = ready.page.sent()[0].clone();
    assert!(first["resume"].is_string());
    assert_eq!(
        first,
        json!({
            "event": "call_audio", "call": 1, "resume": first["resume"], "music": true,
            "waiting": false, "webrtc": true,
        })
    );
    assert_eq!(ready.socket.current_call().unwrap().id(), 1);
}

#[tokio::test]
async fn hanging_up_tells_the_end_of_the_call_a_newer_call_does_not() {
    let ended = Arc::new(AtomicUsize::new(0));
    let ready = started(Setup {
        ice_address: None,
        ended: Some(ended.clone()),
        ..Setup::default()
    })
    .await;
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": true}),
    );
    settle().await;
    assert_eq!(ended.load(Ordering::SeqCst), 0);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    settle().await;
    assert_eq!(ended.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_call_without_music_is_a_call_all_the_same() {
    let ready = started(Setup {
        background: None,
        ..Setup::default()
    })
    .await;
    assert_eq!(ready.page.sent()[0]["event"], "call_audio");
    assert_eq!(ready.page.sent()[0]["call"], 1);
    let start = &requests(&ready.fake)[0];
    assert_eq!(start["op"], "call_start");
    assert_eq!(start["background"], "");
}

#[tokio::test]
async fn the_calls_answer_and_a_resumes_say_whether_its_music_waits() {
    let ready = started(Setup {
        answer: Some(Arc::new(|request| {
            let mut answer = mixing(request);
            if request["op"] == "call_start" {
                answer[0]["waiting"] = json!(true);
            }
            answer
        })),
        background: Some(CallBackground {
            muted: false,
            ..background()
        }),
        ..Setup::default()
    })
    .await;
    let first = ready.page.sent()[0].clone();
    assert_eq!(first["call"], 1);
    assert_eq!(first["music"], true);
    assert_eq!(first["waiting"], true);
    // A voice taken while no socket holds the call: its resume says so.
    ready.socket.close(&ready.page.peer);
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_music", "call": 1, "waiting": false}));
    settle().await;
    let again = Socket::new();
    say(
        &ready.socket,
        &again,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    let resumed = again.sent()[0].clone();
    assert_eq!(resumed["event"], "call_audio");
    assert_eq!(resumed["resumed"], true);
    assert_eq!(resumed["waiting"], false);
    say(
        &ready.socket,
        &again,
        json!({"op": "call_audio", "on": false}),
    );
}

#[tokio::test]
async fn only_the_page_owning_the_call_points_its_microphone() {
    let ready = started(Setup::default()).await;
    let other = Socket::new();
    say(
        &ready.socket,
        &other,
        json!({"op": "call_microphone", "peer": "intruder"}),
    );
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_microphone", "peer": "peer-7"}),
    );
    settle().await;
    let asked = ops(&ready.fake, "call_microphone");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["call"], 1);
    assert_eq!(asked[0]["peer"], "peer-7");
    assert!(asked[0]["id"].is_number());
    assert!(asked[0].get("echo").is_none());
    assert_eq!(
        ready.page.last(),
        json!({"event": "call_microphone", "call": 1, "ok": true})
    );
    assert!(other.sent().is_empty());
}

#[tokio::test]
async fn the_pages_ice_lines_are_logged_always_its_own_calls_only() {
    let (errors, logged) = lines();
    let ready = started(Setup {
        errors: Some(errors),
        ..Setup::default()
    })
    .await;
    let other = Socket::new();
    say(
        &ready.socket,
        &other,
        json!({"op": "call_ice", "line": "not this one's"}),
    );
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_ice", "line": "replies: ICE failed\nhost udp (vpn) -> host udp"}),
    );
    assert_eq!(
        *lock(&logged),
        ["[voice] call 1 (page): replies: ICE failed | host udp (vpn) -> host udp"]
    );
    for _ in 0..CALL_ICE_LINES + 5 {
        say(
            &ready.socket,
            &ready.page,
            json!({"op": "call_ice", "line": "x"}),
        );
    }
    assert_eq!(lock(&logged).len(), CALL_ICE_LINES);
}

#[tokio::test]
async fn a_listening_on_the_call_hears_its_microphone_timed_by_what_came() {
    let ready = started(Setup::default()).await;
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "listen", "call": 1, "new_speaker": true}),
    );
    let start = ops(&ready.fake, "listen_start")[0].clone();
    assert_eq!(start["call"], 1);
    let session = start["session"].clone();
    // A pause read at its start, then the call's microphone comes: its
    // audio counts as the socket's did, and is never told to the page.
    let child = ready.fake.child(0);
    child.say(json!({
        "event": "partial", "session": session, "text": "and then", "pause": true,
        "pause_ms": 500, "turn": 0.9,
    }));
    for _ in 0..40 {
        child.say(json!({"event": "audio", "session": session, "bytes": 6400}));
    }
    settle().await;
    assert!(ready.page.events().iter().all(|event| event != "audio"));
    let last = requests(&ready.fake).last().cloned().unwrap();
    assert_eq!(last["op"], "listen_finish");
    assert_eq!(last["session"], session);
}

#[tokio::test]
async fn a_call_listening_whose_stream_stalls_stays_on_its_socket() {
    let ready = started(Setup::default()).await;
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "listen", "call": 1}),
    );
    let session = ops(&ready.fake, "listen_start")[0]["session"].clone();
    let child = ready.fake.child(0);
    child.say(json!({"event": "audio", "session": session, "bytes": 6400}));
    settle().await;
    ready.clock.advance(STALL_MS).await;
    // The socket is alive: told, and what is heard still comes.
    assert_eq!(
        ready.page.last(),
        json!({"event": "stalled", "session": session})
    );
    child.say(json!({"event": "speech_start", "session": session}));
    settle().await;
    assert_eq!(
        ready.page.last(),
        json!({"event": "speech_start", "session": session})
    );
    // Its stream back: the utterance goes on.
    child.say(json!({"event": "audio", "session": session, "bytes": 6400}));
    settle().await;
    ready.clock.advance(DETACHED_MS).await;
    assert!(ops(&ready.fake, "listen_finish").is_empty());
    // Stalled for good: it ends with what was heard, told on the socket.
    ready.clock.advance(STALL_MS).await;
    assert_eq!(
        ready.page.last(),
        json!({"event": "stalled", "session": session})
    );
    ready.clock.advance(DETACHED_MS).await;
    let last = requests(&ready.fake).last().cloned().unwrap();
    assert_eq!(last["op"], "listen_finish");
    assert_eq!(last["session"], session);
    child.say(json!({"event": "final", "session": session, "text": "Hello"}));
    settle().await;
    assert_eq!(
        ready.page.last(),
        json!({"event": "final", "session": session, "text": "Hello"})
    );
}

#[tokio::test]
async fn another_sockets_listening_or_another_calls_hears_the_socket() {
    let ready = started(Setup::default()).await;
    let other = Socket::new();
    say(&ready.socket, &other, json!({"op": "listen", "call": 1}));
    assert!(ops(&ready.fake, "listen_start")[0].get("call").is_none());
}

#[tokio::test]
async fn moves_to_a_new_socket_within_detached_ms_stops_past_it() {
    let ready = started(Setup::default()).await;
    ready.socket.close(&ready.page.peer);
    ready.clock.advance(DETACHED_MS - 1000).await;
    let again = Socket::new();
    say(
        &ready.socket,
        &again,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    assert_eq!(
        again.sent(),
        [json!({
            "event": "call_audio", "call": 1, "resumed": true, "restarts": 0, "waiting": false,
        })]
    );
    // Detached past DETACHED_MS: the call stops.
    ready.socket.close(&again.peer);
    ready.clock.advance(DETACHED_MS).await;
    assert_eq!(
        requests(&ready.fake).last().cloned().unwrap(),
        json!({"op": "call_stop", "call": 1})
    );
    let late = Socket::new();
    say(
        &ready.socket,
        &late,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    assert_eq!(late.sent()[0]["event"], "call_audio");
    assert!(late.sent()[0]["error"].is_string());
}

#[tokio::test]
async fn a_rebuilt_chats_new_socket_takes_the_call_over_the_old_ones_stop_and_close_leave_it() {
    let ready = started(Setup::default()).await;
    let again = Socket::new();
    say(
        &ready.socket,
        &again,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    assert_eq!(again.sent()[0]["event"], "call_audio");
    assert_eq!(again.sent()[0]["resumed"], true);
    // The old link lets go: its stop and its close end nothing.
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    ready.socket.close(&ready.page.peer);
    settle().await;
    assert!(ops(&ready.fake, "call_stop").is_empty());
    // The new owner points the microphone.
    say(
        &ready.socket,
        &again,
        json!({"op": "call_microphone", "peer": "peer-9", "echo": "here"}),
    );
    settle().await;
    let last = requests(&ready.fake).last().cloned().unwrap();
    assert_eq!(last["op"], "call_microphone");
    assert_eq!(last["peer"], "peer-9");
    assert_eq!(last["echo"], "here");
}

#[tokio::test]
async fn a_wrong_token_resumes_nothing() {
    let ready = started(Setup::default()).await;
    let other = Socket::new();
    say(
        &ready.socket,
        &other,
        json!({"op": "call_resume", "call": 1, "resume": "nope"}),
    );
    assert_eq!(other.sent()[0]["event"], "call_audio");
    assert!(other.sent()[0]["error"].is_string());
}

#[tokio::test]
async fn a_newer_call_ends_the_one_before_and_tells_its_page() {
    let ready = started(Setup::default()).await;
    let other = Socket::new();
    say(
        &ready.socket,
        &other,
        json!({"op": "call_audio", "on": true}),
    );
    settle().await;
    assert_eq!(
        ready.page.last(),
        json!({"event": "call_audio", "call": 1, "error": "Replaced by a newer call"})
    );
    assert_eq!(other.sent()[0]["event"], "call_audio");
    assert_eq!(other.sent()[0]["call"], 2);
    assert_eq!(
        ops(&ready.fake, "call_stop"),
        [json!({"op": "call_stop", "call": 1})]
    );
}

#[tokio::test]
async fn hush_and_stop_go_to_the_helper() {
    let ready = started(Setup::default()).await;
    say(&ready.socket, &ready.page, json!({"op": "call_hush"}));
    // Another call's end (a late answer's) leaves this one.
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false, "call": 2}),
    );
    assert_eq!(ready.socket.current_call().unwrap().id(), 1);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false, "call": 1}),
    );
    let all = requests(&ready.fake);
    let last: Vec<&Value> = all[all.len() - 2..]
        .iter()
        .map(|request| &request["op"])
        .collect();
    assert_eq!(last, [&json!("call_hush"), &json!("call_stop")]);
    assert!(ready.socket.current_call().is_none());
}

#[tokio::test]
async fn an_older_helper_the_page_plays_each_sentence_itself() {
    let ready = started(Setup {
        answer: Some(Arc::new(|request| {
            vec![json!({
                "id": request["id"],
                "error": format!("unknown op {}", request["op"].as_str().unwrap_or("")),
            })]
        })),
        ..Setup::default()
    })
    .await;
    assert_eq!(
        ready.page.sent(),
        [json!({"event": "call_audio", "error": "unknown op call_start"})]
    );
    assert!(ready.socket.current_call().is_none());
}

// A call's signalling, fronted.

#[tokio::test]
async fn only_the_token_of_the_page_owning_the_call_opens_it() {
    let ready = started(Setup::default()).await;
    let token = json!(ready.token);
    assert!(ready.socket.owns_call(&json!(1), &token));
    assert!(!ready.socket.owns_call(&json!(1), &json!("guess")));
    assert!(!ready.socket.owns_call(&json!(2), &token));
    assert!(!ready.socket.owns_call(&json!("1"), &token));
    let (late, late_fake) = signalling();
    say(
        &ready.socket,
        &Socket::new(),
        json!({"op": "call_audio", "on": true}),
    );
    settle().await;
    // A newer call replaced it: the old token opens nothing.
    assert!(!ready.socket.owns_call(&json!(1), &token));
    ready.socket.open_signalling(&late, 1, &ready.token);
    assert_eq!(late_fake.closed(), [(4004, "No such call".to_owned())]);
}

#[tokio::test]
async fn relays_both_ways_to_the_calls_own_server_waiting_for_it_to_open() {
    let ready = started(Setup::default()).await;
    let (page, page_fake) = signalling();
    ready.socket.open_signalling(&page, 1, &ready.token);
    assert_eq!(ready.upstreams.urls(), ["ws://127.0.0.1:41234"]);
    ready
        .socket
        .signalling_message(&page, r#"{"type":"setPeerStatus"}"#);
    let upstream = ready.upstreams.get(0);
    assert!(upstream.told_text().is_empty());
    upstream.open();
    assert_eq!(upstream.told_text(), [r#"{"type":"setPeerStatus"}"#]);
    ready.socket.signalling_message(&page, r#"{"type":"list"}"#);
    assert_eq!(upstream.told_text().last().unwrap(), r#"{"type":"list"}"#);
    upstream.say(json!({"type": "welcome"}));
    assert_eq!(*lock(&page_fake.got), [r#"{"type":"welcome"}"#]);
}

#[tokio::test]
async fn gives_the_helpers_loopback_candidates_at_the_calls_address() {
    let ready = started(Setup::default()).await;
    let (page, page_fake) = signalling();
    ready.socket.open_signalling(&page, 1, &ready.token);
    let upstream = ready.upstreams.get(0);
    upstream.open();
    upstream.say(json!({
        "type": "peer", "sessionId": "s",
        "ice": {"candidate": "candidate:1 1 UDP 2015363327 127.0.0.1 40012 typ host", "sdpMLineIndex": 0},
    }));
    upstream.say(json!({
        "type": "peer", "sessionId": "s",
        "ice": {"candidate": "candidate:2 1 UDP 2015363327 192.168.1.82 40014 typ host", "sdpMLineIndex": 0},
    }));
    let candidates: Vec<Value> = page_fake
        .got()
        .into_iter()
        .map(|message| message["ice"]["candidate"].clone())
        .collect();
    assert_eq!(
        candidates,
        [
            json!("candidate:1 1 UDP 2015363327 100.71.231.65 40012 typ host"),
            json!("candidate:2 1 UDP 2015363327 192.168.1.82 40014 typ host"),
        ]
    );
}

#[tokio::test]
async fn the_helpers_socket_closing_closes_the_pages_and_the_other_way() {
    let ready = started(Setup::default()).await;
    let (first, first_fake) = signalling();
    ready.socket.open_signalling(&first, 1, &ready.token);
    ready.upstreams.get(0).open();
    ready.upstreams.get(0).gone();
    assert_eq!(
        first_fake.closed(),
        [(1011, "The call's signalling closed".to_owned())]
    );
    let (second, _) = signalling();
    ready.socket.open_signalling(&second, 1, &ready.token);
    ready.upstreams.get(1).open();
    ready.socket.close_signalling(&second);
    assert!(ready.upstreams.get(1).closed());
}

#[tokio::test]
async fn the_call_ending_or_its_helper_restarting_closes_its_signalling() {
    let ready = started(Setup::default()).await;
    let (first, first_fake) = signalling();
    ready.socket.open_signalling(&first, 1, &ready.token);
    ready.upstreams.last().open();
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_restarted", "call": 1}));
    settle().await;
    assert_eq!(
        first_fake.closed(),
        [(4000, "The voice helper restarted".to_owned())]
    );
    assert_eq!(
        ready.page.last(),
        json!({"event": "call_restarted", "call": 1, "restarts": 1})
    );
    let (again, again_fake) = signalling();
    ready.socket.open_signalling(&again, 1, &ready.token);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    assert_eq!(again_fake.closed(), [(4000, "The call ended".to_owned())]);
}

#[tokio::test]
async fn call_restarts_reach_the_page_even_across_a_socket_change_and_a_dead_call_is_not_owned() {
    let ready = started(Setup::default()).await;
    // The page's socket is gone when the helper makes the call again.
    ready.socket.close(&ready.page.peer);
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_restarted", "call": 1}));
    settle().await;
    assert_eq!(ready.page.count("call_restarted"), 0);
    // Its new socket learns it from the resume.
    let again = Socket::new();
    say(
        &ready.socket,
        &again,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    assert_eq!(
        again.sent(),
        [json!({
            "event": "call_audio", "call": 1, "resumed": true, "restarts": 1, "waiting": false,
        })]
    );
    // A helper that cannot make it again ends it: told, not owned, and its
    // signalling refused instead of dialled.
    let why = "The voice helper stopped: the call did not start";
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_ended", "call": 1, "error": why}));
    settle().await;
    assert_eq!(
        again.last(),
        json!({"event": "call_audio", "call": 1, "error": why})
    );
    assert!(!ready.socket.owns_call(&json!(1), &json!(ready.token)));
    assert!(ready.socket.current_call().is_none());
    let (late, late_fake) = signalling();
    ready.socket.open_signalling(&late, 1, &ready.token);
    assert_eq!(late_fake.closed(), [(4004, "No such call".to_owned())]);
}

#[test]
fn a_page_elsewhere_is_refused_this_sites_is_not() {
    use super::super::signalling::same_site_socket;
    assert!(!same_site_socket(Some("cross-site")));
    assert!(same_site_socket(Some("same-origin")));
    assert!(same_site_socket(None));
}

#[test]
fn rewrites_only_host_udp_candidates_on_127_0_0_1_in_sdp_too() {
    use super::super::signalling::rewrite_candidates;
    let sdp = [
        "v=0",
        "a=candidate:1 1 UDP 2015363327 127.0.0.1 40012 typ host",
        "a=candidate:2 1 TCP 1015022079 127.0.0.1 9 typ host tcptype active",
        "a=candidate:3 1 UDP 1677722111 127.0.0.1 40020 typ srflx raddr 0.0.0.0 rport 0",
        "",
    ]
    .join("\r\n");
    let message = json!({"type": "peer", "sessionId": "s", "sdp": {"type": "offer", "sdp": sdp}});
    let out: Value = serde_json::from_str(&rewrite_candidates(
        &message.to_string(),
        Some("100.71.231.65"),
    ))
    .unwrap();
    let lines: Vec<&str> = out["sdp"]["sdp"].as_str().unwrap().split("\r\n").collect();
    assert_eq!(
        lines[1..4],
        [
            "a=candidate:1 1 UDP 2015363327 100.71.231.65 40012 typ host",
            "a=candidate:2 1 TCP 1015022079 127.0.0.1 9 typ host tcptype active",
            "a=candidate:3 1 UDP 1677722111 127.0.0.1 40020 typ srflx raddr 0.0.0.0 rport 0",
        ]
    );
    // No address set: as it is.
    let plain = json!({"type": "peer", "sdp": {"type": "offer", "sdp": sdp}}).to_string();
    assert_eq!(rewrite_candidates(&plain, None), plain);
    assert_eq!(
        rewrite_candidates("not json", Some("100.71.231.65")),
        "not json"
    );
}

/// The real socket to the helper's signalling server, against a local
/// WebSocket server: it opens, relays both ways, and says when it closed.
#[tokio::test]
async fn the_upstream_client_relays_both_ways_and_tells_its_end() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    use super::super::signalling::{UpstreamEvent, connect_upstream};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        socket
            .send(Message::text(r#"{"type":"welcome"}"#))
            .await
            .unwrap();
        let heard = loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => break text.as_str().to_owned(),
                Some(Ok(_)) => continue,
                other => panic!("{other:?}"),
            }
        };
        socket.close(None).await.unwrap();
        heard
    });
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let upstream = connect_upstream()(
        &format!("ws://127.0.0.1:{port}"),
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
    )
    .unwrap();
    upstream.send(r#"{"type":"list"}"#.into());
    assert_eq!(events.recv().await, Some(UpstreamEvent::Open));
    assert_eq!(
        events.recv().await,
        Some(UpstreamEvent::Message(r#"{"type":"welcome"}"#.into()))
    );
    assert_eq!(server.await.unwrap(), r#"{"type":"list"}"#);
    assert_eq!(events.recv().await, Some(UpstreamEvent::Closed));
}
