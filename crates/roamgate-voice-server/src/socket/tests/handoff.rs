//! call-handoff.test.ts: a call handed to the Android app, and the
//! replies' producer it is told. (Its redeem route is the HTTP layer's.)

use roamgate_base::log::Logger;
use serde_json::json;

use super::*;
use crate::config::tests::config;
use crate::helper::VoiceHelper;
use crate::helper::tests::{Fake, source};

/// A helper that makes WebRTC calls and listens to any microphone.
fn fake_helper() -> Fake {
    Fake::new(|request| match request["op"].as_str() {
        Some("call_start") => vec![json!({
            "id": request["id"], "ok": true, "rate": 48000, "channels": 2,
            "music": false, "signalling_port": 41234,
        })],
        Some("call_microphone") => vec![json!({"id": request["id"], "ok": true})],
        _ => vec![],
    })
}

/// A call started by a page, and the app's way in.
struct Started {
    clock: Arc<TestClock>,
    fake: Fake,
    socket: VoiceSocket,
    page: Socket,
    token: String,
    upstreams: Upstreams,
}

impl Started {
    fn handoff(&self) -> Value {
        say(
            &self.socket,
            &self.page,
            json!({"op": "call_handoff", "call": 1}),
        );
        self.page.last()["handoff"].clone()
    }

    /// The app redeems a handoff and carries `legs` on its own socket.
    fn carry(&self, legs: &[&str]) -> (Socket, String) {
        let taken = self.socket.redeem_handoff(&self.handoff()).unwrap();
        let app = Socket::new();
        say(
            &self.socket,
            &app,
            json!({"op": "call_carry", "call": taken.call, "carrier": taken.carrier, "legs": legs}),
        );
        (app, taken.carrier)
    }
}

async fn started_with(ended: Option<Arc<AtomicUsize>>) -> Started {
    let clock = clock();
    let fake = fake_helper();
    let helper = VoiceHelper::with(
        source(config(json!({}))),
        fake.spawn(),
        clock.clone(),
        Logger::silent(),
    );
    let upstreams = Upstreams::default();
    let mut options = options(&clock);
    options.connect_upstream = upstreams.connect();
    if let Some(ended) = ended {
        options.on_call_ended = Arc::new(move || {
            ended.fetch_add(1, Ordering::SeqCst);
        });
    }
    let socket = VoiceSocket::new(Arc::new(helper), options);
    let page = Socket::new();
    say(&socket, &page, json!({"op": "call_audio", "on": true}));
    settle().await;
    let token = page.sent()[0]["resume"].as_str().unwrap().to_owned();
    Started {
        clock,
        fake,
        socket,
        page,
        token,
        upstreams,
    }
}

async fn started() -> Started {
    started_with(None).await
}

#[tokio::test]
async fn only_the_owning_page_gets_a_handoff_token_single_use() {
    let ready = started().await;
    let other = Socket::new();
    say(
        &ready.socket,
        &other,
        json!({"op": "call_handoff", "call": 1}),
    );
    assert_eq!(
        other.sent(),
        [json!({"event": "call_handoff", "call": 1, "error": "No such call"})]
    );
    let token = ready.handoff();
    assert_eq!(
        ready.page.last(),
        json!({"event": "call_handoff", "call": 1, "handoff": token, "expires_ms": HANDOFF_MS})
    );
    let text = token.as_str().unwrap();
    assert_eq!(text.len(), 43);
    assert!(
        text.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    );
    let taken = ready.socket.redeem_handoff(&token).unwrap();
    assert_eq!(taken.call, 1);
    assert!(ready.socket.redeem_handoff(&token).is_none());
    assert!(ready.socket.redeem_handoff(&json!("guess")).is_none());
    assert!(ready.socket.redeem_handoff(&Value::Null).is_none());
}

#[tokio::test]
async fn a_handoff_expires_and_a_newer_one_replaces_it() {
    let ready = started().await;
    let first = ready.handoff();
    let second = ready.handoff();
    assert!(ready.socket.redeem_handoff(&first).is_none());
    ready.clock.advance(HANDOFF_MS + 1).await;
    assert!(ready.socket.redeem_handoff(&second).is_none());
}

#[tokio::test]
async fn a_calls_end_voids_its_handoff() {
    let ready = started().await;
    let token = ready.handoff();
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    assert!(ready.socket.redeem_handoff(&token).is_none());
}

#[tokio::test]
async fn the_app_carries_the_legs_it_says_and_the_page_is_told() {
    let ready = started().await;
    let (app, _) = ready.carry(&["microphone", "bogus"]);
    assert_eq!(
        app.sent(),
        [
            json!({
                "event": "call_carry", "call": 1, "ok": true, "legs": ["microphone"],
                "restarts": 0, "waiting": false, "replies_peer": null,
            }),
            json!({"event": "call_mute", "call": 1, "muted": false}),
        ]
    );
    assert_eq!(
        ready.page.last(),
        json!({
            "event": "call_carrier", "call": 1, "state": "joined", "legs": ["microphone"],
            "heard": false,
        })
    );
    // A wrong carrier token carries nothing.
    let intruder = Socket::new();
    say(
        &ready.socket,
        &intruder,
        json!({"op": "call_carry", "call": 1, "carrier": "guess"}),
    );
    assert_eq!(
        intruder.sent(),
        [json!({"event": "call_carry", "call": 1, "error": "No such call"})]
    );
}

#[tokio::test]
async fn the_apps_microphone_is_listened_to_the_pages_no_longer() {
    let ready = started().await;
    let (app, _) = ready.carry(&["microphone"]);
    say(
        &ready.socket,
        &app,
        json!({"op": "call_microphone", "peer": "app-peer", "echo": "here"}),
    );
    settle().await;
    assert_eq!(
        app.last(),
        json!({"event": "call_microphone", "call": 1, "ok": true})
    );
    let told = ready.page.last();
    assert_eq!(told["event"], "call_carrier");
    assert_eq!(told["state"], "joined");
    assert_eq!(told["heard"], true);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_microphone", "peer": "page-peer"}),
    );
    settle().await;
    assert_eq!(
        ready.page.last(),
        json!({
            "event": "call_microphone", "call": 1,
            "error": "The Roamgate app carries the microphone",
        })
    );
    let peers: Vec<Value> = ready
        .fake
        .child(0)
        .requests()
        .into_iter()
        .filter(|request| request["op"] == "call_microphone")
        .map(|request| request["peer"].clone())
        .collect();
    assert_eq!(peers, [json!("app-peer")]);
}

#[tokio::test]
async fn the_carrier_token_opens_the_calls_signalling_its_leaving_closes_it() {
    let ready = started().await;
    let (app, carrier) = ready.carry(&["microphone"]);
    assert!(ready.socket.owns_call(&json!(1), &json!(carrier)));
    let (app_signalling, app_closed) = signalling();
    let (page_signalling, page_closed) = signalling();
    ready.socket.open_signalling(&app_signalling, 1, &carrier);
    ready
        .socket
        .open_signalling(&page_signalling, 1, &ready.token);
    say(&ready.socket, &app, json!({"op": "call_carry_end"}));
    assert_eq!(
        app_closed.closed(),
        [(4000, "The Roamgate app gave the call back".to_owned())]
    );
    assert!(page_closed.closed().is_empty());
    assert_eq!(
        ready.page.last(),
        json!({
            "event": "call_carrier", "call": 1, "state": "left",
            "why": "The Roamgate app gave the call back",
        })
    );
    assert!(!ready.socket.owns_call(&json!(1), &json!(carrier)));
    assert!(ready.socket.owns_call(&json!(1), &json!(ready.token)));
}

#[tokio::test]
async fn the_app_hanging_up_ends_the_call_for_the_page() {
    let ended = Arc::new(AtomicUsize::new(0));
    let ready = started_with(Some(ended.clone())).await;
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_handoff", "call": 1}),
    );
    let taken = ready
        .socket
        .redeem_handoff(&ready.page.last()["handoff"])
        .unwrap();
    let app = Socket::new();
    say(
        &ready.socket,
        &app,
        json!({"op": "call_carry", "call": 1, "carrier": taken.carrier}),
    );
    say(
        &ready.socket,
        &app,
        json!({"op": "call_audio", "on": false, "call": 1}),
    );
    assert_eq!(
        ready.page.last(),
        json!({"event": "call_audio", "call": 1, "error": "Hung up in the Roamgate app"})
    );
    assert_eq!(ended.load(Ordering::SeqCst), 1);
    assert!(ready.socket.current_call().is_none());
}

#[tokio::test]
async fn the_page_hanging_up_tells_the_app() {
    let ready = started().await;
    let (app, _) = ready.carry(&["microphone"]);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    assert_eq!(
        app.last(),
        json!({"event": "call_audio", "call": 1, "error": "The call ended"})
    );
}

#[tokio::test]
async fn outputs_the_apps_go_to_the_page_the_pages_choice_to_the_app() {
    let ready = started().await;
    let (app, _) = ready.carry(&["microphone", "replies"]);
    say(
        &ready.socket,
        &app,
        json!({
            "op": "call_output_state",
            "current": "speaker",
            "outputs": [
                {"id": "speaker", "kind": "speaker", "label": "Loudspeaker"},
                {"id": "bt:AA", "kind": "bluetooth", "label": "Car"},
                {"id": "music:AA", "kind": "bluetooth-music", "label": "Car (music)"},
                {"id": "x", "kind": "teleport", "label": "Nope"},
            ],
        }),
    );
    assert_eq!(
        ready.page.last(),
        json!({
            "event": "call_output_state", "call": 1, "current": "speaker",
            "outputs": [
                {"id": "speaker", "kind": "speaker", "label": "Loudspeaker"},
                {"id": "bt:AA", "kind": "bluetooth", "label": "Car"},
                {"id": "music:AA", "kind": "bluetooth-music", "label": "Car (music)"},
            ],
        })
    );
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_output", "call": 1, "output": "bt:AA"}),
    );
    assert_eq!(
        app.last(),
        json!({"event": "call_output", "call": 1, "output": "bt:AA"})
    );
    // A page's new socket learns who carries the call.
    ready.socket.close(&ready.page.peer);
    let again = Socket::new();
    say(
        &ready.socket,
        &again,
        json!({"op": "call_resume", "call": 1, "resume": ready.token}),
    );
    assert_eq!(
        again.events(),
        ["call_audio", "call_carrier", "call_output_state"]
    );
}

#[tokio::test]
async fn mute_the_pages_state_reaches_the_app_the_apps_mute_the_page() {
    let ready = started().await;
    let socket = &ready.socket;
    let page = &ready.page;
    // Muted before the app joined: the app learns it right after joining.
    say(
        socket,
        page,
        json!({"op": "call_mute_state", "call": 1, "muted": true}),
    );
    let (app, _) = ready.carry(&["microphone", "replies"]);
    assert_eq!(app.events(), ["call_carry", "call_mute"]);
    assert_eq!(
        app.last(),
        json!({"event": "call_mute", "call": 1, "muted": true})
    );
    // Each change of the page's is told to the app.
    say(
        socket,
        page,
        json!({"op": "call_mute_state", "call": 1, "muted": false}),
    );
    assert_eq!(
        app.last(),
        json!({"event": "call_mute", "call": 1, "muted": false})
    );
    // The app's Mute goes to the page, as the same event.
    let told = page.sent().len();
    say(
        socket,
        &app,
        json!({"op": "call_mute", "call": 1, "muted": true}),
    );
    assert_eq!(
        page.sent()[told..],
        [json!({"event": "call_mute", "call": 1, "muted": true})]
    );
    // Nothing for another call, a muted that is not a boolean, or a socket
    // that does not carry it; and a page's state from another socket is
    // not the call's.
    let app_told = app.sent().len();
    let stranger = Socket::new();
    say(
        socket,
        &app,
        json!({"op": "call_mute", "call": 2, "muted": false}),
    );
    say(
        socket,
        &app,
        json!({"op": "call_mute", "call": 1, "muted": "no"}),
    );
    say(
        socket,
        &stranger,
        json!({"op": "call_mute", "call": 1, "muted": false}),
    );
    say(
        socket,
        &stranger,
        json!({"op": "call_mute_state", "call": 1, "muted": true}),
    );
    say(
        socket,
        page,
        json!({"op": "call_mute_state", "call": 1, "muted": 1}),
    );
    say(
        socket,
        page,
        json!({"op": "call_mute_state", "call": 2, "muted": true}),
    );
    assert_eq!(page.sent().len(), told + 1);
    assert_eq!(app.sent().len(), app_told);
    assert!(stranger.sent().is_empty());
    // Once the app gave the call back, neither way goes on.
    say(socket, &app, json!({"op": "call_carry_end"}));
    let page_left = page.sent().len();
    say(
        socket,
        page,
        json!({"op": "call_mute_state", "call": 1, "muted": false}),
    );
    say(
        socket,
        &app,
        json!({"op": "call_mute", "call": 1, "muted": false}),
    );
    assert_eq!(app.sent().len(), app_told);
    assert_eq!(page.sent().len(), page_left);
}

#[tokio::test]
async fn restarts_and_music_reach_the_app_too() {
    let ready = started().await;
    let (app, _) = ready.carry(&["microphone"]);
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_restarted", "call": 1}));
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_music", "call": 1, "waiting": true}));
    settle().await;
    for sent in [ready.page.sent(), app.sent()] {
        assert_eq!(
            sent[sent.len() - 2..],
            [
                json!({"event": "call_restarted", "call": 1, "restarts": 1}),
                json!({"event": "call_music", "call": 1, "waiting": true}),
            ]
        );
    }
}

#[tokio::test]
async fn an_app_that_never_joins_or_whose_socket_goes_gives_the_call_back() {
    let ready = started().await;
    let unused = ready.socket.redeem_handoff(&ready.handoff()).unwrap();
    ready.clock.advance(DETACHED_MS + 1).await;
    assert!(!ready.socket.owns_call(&json!(1), &json!(unused.carrier)));
    let (app, carrier) = ready.carry(&["microphone"]);
    ready.socket.close(&app.peer);
    ready.clock.advance(DETACHED_MS - 1).await;
    // Back within DETACHED_MS on a new socket: still carried.
    let back = Socket::new();
    say(
        &ready.socket,
        &back,
        json!({"op": "call_carry", "call": 1, "carrier": carrier}),
    );
    assert_eq!(back.sent()[0]["event"], "call_carry");
    assert_eq!(back.sent()[0]["ok"], true);
    ready.socket.close(&back.peer);
    ready.clock.advance(DETACHED_MS + 1).await;
    assert_eq!(
        ready.page.last(),
        json!({
            "event": "call_carrier", "call": 1, "state": "left",
            "why": "The Roamgate app's link went",
        })
    );
}

#[tokio::test]
async fn a_newer_apps_handoff_drops_the_one_before() {
    let ready = started().await;
    let (first, first_carrier) = ready.carry(&["microphone"]);
    let (_, second_carrier) = ready.carry(&["microphone"]);
    assert_eq!(
        first.last(),
        json!({"event": "call_audio", "call": 1, "error": "The call went to another app"})
    );
    assert!(!ready.socket.owns_call(&json!(1), &json!(first_carrier)));
    assert!(ready.socket.owns_call(&json!(1), &json!(second_carrier)));
}

fn replies() -> Value {
    json!({"call": 1, "role": "replies"})
}

/// The app joins after redeeming; the bridge's watch is the first upstream.
fn joined(
    ready: &Started,
    before: impl FnOnce(&MadeUpstream),
) -> (Socket, Arc<MadeUpstream>, String) {
    let taken = ready.socket.redeem_handoff(&ready.handoff()).unwrap();
    assert_eq!(ready.upstreams.urls(), ["ws://127.0.0.1:41234"]);
    let watch = ready.upstreams.get(0);
    before(&watch);
    let app = Socket::new();
    say(
        &ready.socket,
        &app,
        json!({
            "op": "call_carry", "call": taken.call, "carrier": taken.carrier,
            "legs": ["microphone", "replies"],
        }),
    );
    (app, watch, taken.carrier)
}

#[tokio::test]
async fn call_carry_carries_the_helpers_replies_producer() {
    let ready = started().await;
    let (app, watch, _) = joined(&ready, |watch| {
        watch.say(json!({"type": "welcome", "peerId": "bridge"}));
        assert_eq!(
            watch.told(),
            [
                json!({
                    "type": "setPeerStatus", "roles": ["listener"],
                    "meta": {"call": 1, "role": "roamgate"},
                }),
                json!({"type": "list"}),
            ]
        );
        watch.say(json!({
            "type": "list",
            "producers": [
                {"id": "page-mic", "meta": {"call": 1, "role": "microphone"}},
                {"id": "old-replies", "meta": {"call": 0, "role": "replies"}},
                {"id": "replies-1", "meta": replies()},
            ],
        }));
    });
    assert_eq!(
        app.sent(),
        [
            json!({
                "event": "call_carry", "call": 1, "ok": true, "legs": ["microphone", "replies"],
                "restarts": 0, "waiting": false, "replies_peer": "replies-1",
            }),
            json!({"event": "call_mute", "call": 1, "muted": false}),
        ]
    );
    // The same producer registering again tells nothing new.
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "replies-1", "roles": ["producer"],
        "meta": replies(),
    }));
    assert_eq!(app.sent().len(), 2);
}

#[tokio::test]
async fn a_producer_known_later_or_a_new_one_is_told_as_call_replies_peer() {
    let ready = started().await;
    let (app, watch, _) = joined(&ready, |_| {});
    let sent = app.sent();
    assert_eq!(sent[sent.len() - 2]["event"], "call_carry");
    assert_eq!(sent[sent.len() - 2]["replies_peer"], Value::Null);
    watch.say(json!({"type": "welcome", "peerId": "bridge"}));
    watch.say(json!({"type": "list", "producers": []}));
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "replies-1", "roles": ["producer"],
        "meta": replies(),
    }));
    assert_eq!(
        app.last(),
        json!({"event": "call_replies_peer", "call": 1, "peer": "replies-1"})
    );
    // Its leaving, other calls' producers and microphones tell nothing.
    let told = app.sent().len();
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "replies-1", "roles": [], "meta": replies(),
    }));
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "app-mic", "roles": ["producer"],
        "meta": {"call": 1, "role": "microphone"},
    }));
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "elsewhere", "roles": ["producer"],
        "meta": {"call": 2, "role": "replies"},
    }));
    assert_eq!(app.sent().len(), told);
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "replies-2", "roles": ["producer"],
        "meta": replies(),
    }));
    assert_eq!(
        app.last(),
        json!({"event": "call_replies_peer", "call": 1, "peer": "replies-2"})
    );
}

#[tokio::test]
async fn a_restarted_helpers_new_server_is_watched_again() {
    let ready = started().await;
    let (app, watch, _) = joined(&ready, |watch| {
        watch.say(json!({"type": "welcome", "peerId": "bridge"}));
        watch.say(json!({"type": "list", "producers": [{"id": "replies-1", "meta": replies()}]}));
    });
    ready
        .fake
        .child(0)
        .say(json!({"event": "call_restarted", "call": 1}));
    settle().await;
    assert!(watch.closed());
    assert_eq!(
        app.last(),
        json!({"event": "call_restarted", "call": 1, "restarts": 1})
    );
    let again = ready.upstreams.last();
    assert!(!Arc::ptr_eq(&again, &watch));
    // The old server's late words are not taken.
    watch.say(json!({
        "type": "peerStatusChanged", "peerId": "stale", "roles": ["producer"], "meta": replies(),
    }));
    again.say(json!({"type": "welcome", "peerId": "bridge"}));
    again.say(json!({"type": "list", "producers": [{"id": "replies-2", "meta": replies()}]}));
    assert_eq!(
        app.last(),
        json!({"event": "call_replies_peer", "call": 1, "peer": "replies-2"})
    );
}

#[tokio::test]
async fn a_watch_whose_server_closed_is_opened_again_the_calls_end_closes_it() {
    let ready = started().await;
    let (_, watch, _) = joined(&ready, |_| {});
    watch.gone();
    assert_eq!(ready.upstreams.len(), 1);
    ready.clock.advance(REPLIES_WATCH_RETRY_MS).await;
    assert_eq!(ready.upstreams.len(), 2);
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    assert!(ready.upstreams.get(1).closed());
}

#[tokio::test]
async fn the_apps_two_signalling_sockets_are_each_proxied_on_their_own() {
    let ready = started().await;
    let (_, _, carrier) = joined(&ready, |_| {});
    // The app's webrtcsink (its microphone) and webrtcsrc (the replies).
    let (sink, sink_fake) = signalling();
    let (source_ws, source_fake) = signalling();
    ready.socket.open_signalling(&sink, 1, &carrier);
    ready.socket.open_signalling(&source_ws, 1, &carrier);
    assert!(sink_fake.closed().is_empty());
    assert!(source_fake.closed().is_empty());
    assert_eq!(
        ready.upstreams.urls(),
        [
            "ws://127.0.0.1:41234",
            "ws://127.0.0.1:41234",
            "ws://127.0.0.1:41234"
        ]
    );
    let sink_up = ready.upstreams.get(1);
    sink_up.open();
    let source_up = ready.upstreams.get(2);
    source_up.open();
    let producer = json!({
        "type": "setPeerStatus", "roles": ["producer"], "meta": {"call": 1, "role": "microphone"},
    });
    let consumer = json!({"type": "startSession", "peerId": "replies-1"});
    ready
        .socket
        .signalling_message(&sink, &producer.to_string());
    ready
        .socket
        .signalling_message(&source_ws, &consumer.to_string());
    assert_eq!(sink_up.told(), [producer]);
    assert_eq!(source_up.told(), [consumer]);
    sink_up.say(json!({"type": "welcome", "peerId": "app-mic"}));
    source_up.say(json!({"type": "sessionStarted", "peerId": "replies-1", "sessionId": "s1"}));
    assert_eq!(
        sink_fake.got(),
        [json!({"type": "welcome", "peerId": "app-mic"})]
    );
    assert_eq!(
        source_fake.got(),
        [json!({"type": "sessionStarted", "peerId": "replies-1", "sessionId": "s1"})]
    );
    // One closing leaves the other, and the app leaving closes both.
    ready.socket.close_signalling(&source_ws);
    assert!(source_up.closed());
    assert!(!sink_up.closed());
    say(
        &ready.socket,
        &ready.page,
        json!({"op": "call_audio", "on": false}),
    );
    assert_eq!(sink_fake.closed(), [(4000, "The call ended".to_owned())]);
}
