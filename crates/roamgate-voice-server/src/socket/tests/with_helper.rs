//! voice-helper.test.ts, its voice socket: the socket on a real
//! [`VoiceHelper`], the helper process faked (helper::tests::Fake).

use roamgate_base::log::Logger;
use serde_json::json;

use super::*;
use crate::config::tests::config;
use crate::helper::VoiceHelper;
use crate::helper::tests::{Fake, source};

fn listens(fake: &Fake, child: usize) -> Vec<Value> {
    fake.child(child)
        .requests()
        .into_iter()
        .filter(|request| {
            request["op"]
                .as_str()
                .is_some_and(|op| op.starts_with("listen_"))
        })
        .collect()
}

#[tokio::test]
async fn streams_a_browsers_microphone_and_forwards_what_was_heard() {
    let clock = clock();
    let fake = Fake::silent();
    let helper = VoiceHelper::with(
        source(config(json!({}))),
        fake.spawn(),
        clock.clone(),
        Logger::silent(),
    );
    let socket = VoiceSocket::new(Arc::new(helper), options(&clock));
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen", "end_silence_ms": 800}));
    let first = ws.sent()[0].clone();
    let id = first["session"].as_u64().unwrap();
    assert_eq!(first["event"], "listening");
    assert!(first["resume"].is_string());
    socket.audio(&ws.peer, &[1, 0]);
    say(&socket, &ws, json!({"op": "finish"}));
    assert_eq!(
        listens(&fake, 0),
        [
            json!({"op": "listen_start", "session": id, "hold": false, "end_silence_ms": 800}),
            json!({"op": "listen_finish", "session": id}),
        ]
    );
    fake.child(0)
        .say(json!({"event": "final", "session": id, "text": "done"}));
    settle().await;
    assert_eq!(
        ws.last(),
        json!({"event": "final", "session": id, "text": "done"})
    );
    // A new session ends the one before; closing keeps the last for a
    // resume.
    say(&socket, &ws, json!({"op": "listen"}));
    socket.close(&ws.peer);
    let stops = listens(&fake, 0)
        .into_iter()
        .filter(|request| request["op"] == "listen_stop")
        .count();
    assert_eq!(stops, 1);
}

#[tokio::test]
async fn a_helper_exit_ends_each_listening_on_its_own_session_and_keeps_the_link() {
    let clock = clock();
    let fake = Fake::silent();
    let helper = VoiceHelper::with(
        source(config(json!({}))),
        fake.spawn(),
        clock.clone(),
        Logger::silent(),
    );
    let socket = VoiceSocket::new(Arc::new(helper), options(&clock));
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    let id = ws.sent()[0]["session"].as_u64().unwrap();
    let resume = ws.sent()[0]["resume"].clone();
    fake.child(0).exit();
    settle().await;
    assert_eq!(
        ws.last(),
        json!({
            "event": "error", "session": id, "error": "The voice helper stopped",
            "recoverable": true,
        })
    );
    // Over: neither the page's finish nor time sends a finish for it, to
    // the dead helper or a new one.
    say(&socket, &ws, json!({"op": "finish"}));
    clock.advance(DETACHED_MS + KEPT_MS).await;
    assert_eq!(fake.count(), 1);
    assert!(
        listens(&fake, 0)
            .iter()
            .all(|request| request["op"] != "listen_finish")
    );
    // Nothing to resume; the socket listens again, in a new helper.
    let other = Socket::new();
    say(
        &socket,
        &other,
        json!({"op": "resume", "session": id, "resume": resume}),
    );
    assert_eq!(
        other.last(),
        json!({"event": "resume_failed", "session": id})
    );
    say(&socket, &ws, json!({"op": "listen"}));
    assert_eq!(fake.count(), 2);
    assert_eq!(ws.last()["event"], "listening");
}
