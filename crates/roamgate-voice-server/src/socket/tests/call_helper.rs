//! call-audio.test.ts: a call, helper side ([`VoiceHelper`]'s calls), and
//! the call background's settings in voice.json.

use serde_json::json;

use super::call::{background, mixing};
use super::*;
use crate::config::read_voice_config;
use crate::config::tests::config;
use crate::helper::VoiceHelper;
use crate::helper::tests::{Fake, source};

fn helper(fake: &Fake) -> VoiceHelper {
    VoiceHelper::new(source(config(json!({}))), fake.spawn())
}

fn last_request(fake: &Fake) -> Value {
    fake.child(0).requests().last().cloned().unwrap()
}

fn collector() -> (EventSink, Arc<Mutex<Vec<Value>>>) {
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let kept = heard.clone();
    (
        Arc::new(move |event| lock(&kept).push(Value::Object(event))),
        heard,
    )
}

#[tokio::test]
async fn starts_a_webrtc_call_speaks_into_it_and_points_its_microphone() {
    let fake = Fake::new(mixing);
    let helper = helper(&fake);
    let errors: Arc<Mutex<Vec<Value>>> = Arc::default();
    let kept = errors.clone();
    let call = helper
        .start_call(
            background(),
            Arc::new(move |event| {
                if event["event"] == "call_error" {
                    lock(&kept).push(event["error"].clone());
                }
            }),
        )
        .await
        .unwrap();
    let start = fake.child(0).requests()[0].clone();
    assert_eq!(start["op"], "call_start");
    assert_eq!(start["call"], call.id);
    assert_eq!(start["background"], "audiotestsrc is-live=true");
    assert_eq!(start["volume"], 0.6);
    assert_eq!(start["ducked"], 0.15);
    assert_eq!(start["release_ms"], 3000);
    // Off until asked for.
    assert_eq!(start["muted"], true);
    assert!(call.music);
    assert_eq!(call.signalling_port(), 41234);
    fake.child(0)
        .say(json!({"event": "call_error", "call": call.id, "error": "no music"}));
    settle().await;
    assert_eq!(*lock(&errors), [json!("no music")]);
    call.microphone("peer-1", false).await.unwrap();
    let asked = last_request(&fake);
    assert_eq!(asked["op"], "call_microphone");
    assert_eq!(asked["call"], call.id);
    assert_eq!(asked["peer"], "peer-1");
    assert!(asked.get("echo").is_none());
    // The page plays the replies without its echo canceller: the helper's.
    call.microphone("peer-1", true).await.unwrap();
    assert_eq!(last_request(&fake)["echo"], "here");
    let queued = helper
        .speak_in_call(call.id, "Hello.", Some("en"), None, Some(1.5))
        .await
        .unwrap();
    let speak = last_request(&fake);
    assert_eq!(speak["op"], "speak");
    assert_eq!(speak["call"], call.id);
    assert_eq!(speak["rate"], 1.5);
    assert_eq!(queued.start_ms, 1035.0);
    assert_eq!(queued.duration_ms, 1970.0);
    assert_eq!(queued.now_ms, 1200.0);
    call.hush();
    call.stop();
    let all = fake.child(0).requests();
    assert_eq!(all[all.len() - 2]["op"], "call_hush");
    assert_eq!(all[all.len() - 1]["op"], "call_stop");
    assert!(
        call.microphone("peer-2", false)
            .await
            .unwrap_err()
            .contains("no call")
    );
}

#[tokio::test]
async fn a_listening_session_on_the_call_hears_its_microphone_and_its_progress() {
    let fake = Fake::new(mixing);
    let helper = helper(&fake);
    let (sink, heard) = collector();
    let session = helper
        .listen(
            sink,
            ListenOptions {
                call: Some(3),
                ..ListenOptions::default()
            },
        )
        .unwrap();
    let start = fake.child(0).requests()[0].clone();
    assert_eq!(start["op"], "listen_start");
    assert_eq!(start["session"], session.id);
    assert_eq!(start["call"], 3);
    fake.child(0)
        .say(json!({"event": "audio", "session": session.id, "bytes": 6400}));
    settle().await;
    assert_eq!(
        *lock(&heard),
        [json!({"event": "audio", "session": session.id, "bytes": 6400})]
    );
}

#[tokio::test]
async fn a_calls_error_reaches_no_listening_session() {
    let fake = Fake::new(mixing);
    let helper = helper(&fake);
    let (sink, heard) = collector();
    let _session = helper.listen(sink, ListenOptions::default()).unwrap();
    let call = helper
        .start_call(background(), Arc::new(|_| {}))
        .await
        .unwrap();
    fake.child(0)
        .say(json!({"event": "call_error", "call": call.id, "error": "x"}));
    settle().await;
    assert!(lock(&heard).is_empty());
}

#[tokio::test]
async fn muted_call_music_is_not_on_until_call_music_puts_it_on() {
    let fake = Fake::new(mixing);
    let helper = helper(&fake);
    // Off at the start (no call_music_at_start): configured, not playing.
    let call = helper
        .start_call(background(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(call.music);
    assert!(!call.music_on());
    let unmute = MusicChange {
        volume: None,
        muted: Some(false),
    };
    call.music_level(unmute).await.unwrap();
    assert!(call.music_on());
    call.music_level(MusicChange {
        volume: Some(0.3),
        muted: None,
    })
    .await
    .unwrap();
    assert!(call.music_on());
    call.music_level(MusicChange {
        volume: None,
        muted: Some(true),
    })
    .await
    .unwrap();
    assert!(!call.music_on());
    let playing = helper
        .start_call(
            CallBackground {
                muted: false,
                ..background()
            },
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert!(playing.music_on());
}

#[tokio::test]
async fn call_music_waits_for_a_voice_while_the_helper_says_so() {
    let playing = CallBackground {
        muted: false,
        ..background()
    };
    let fake = Fake::new(mixing);
    let helper = helper(&fake);
    let (sink, events) = collector();
    let call = helper.start_call(playing.clone(), sink).await.unwrap();
    assert!(!call.music_waiting());
    // An event already newer than call_start's answer is kept.
    let waiting = Fake::new(|request| {
        if request["op"] != "call_start" {
            return mixing(request);
        }
        let mut answer = mixing(request)[0].clone();
        answer["waiting"] = json!(true);
        vec![
            json!({"event": "call_music", "call": request["call"], "waiting": false}),
            answer,
        ]
    });
    let told = VoiceHelper::new(source(config(json!({}))), waiting.spawn())
        .start_call(playing.clone(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(!told.music_waiting());
    let answering = Fake::new(|request| {
        let mut answer = mixing(request);
        if request["op"] == "call_start" {
            answer[0]["waiting"] = json!(true);
        }
        answer
    });
    let answered = VoiceHelper::new(source(config(json!({}))), answering.spawn())
        .start_call(playing, Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(answered.music_waiting());
    fake.child(0)
        .say(json!({"event": "call_music", "call": call.id, "waiting": true}));
    settle().await;
    assert!(call.music_on());
    assert!(call.music_waiting());
    assert_eq!(
        *lock(&events),
        [json!({"event": "call_music", "call": call.id, "waiting": true})]
    );
    // Off, it waits for nothing: there is nothing to play.
    call.music_level(MusicChange {
        volume: None,
        muted: Some(true),
    })
    .await
    .unwrap();
    assert!(!call.music_waiting());
    call.music_level(MusicChange {
        volume: None,
        muted: Some(false),
    })
    .await
    .unwrap();
    assert!(call.music_waiting());
    fake.child(0)
        .say(json!({"event": "call_music", "call": call.id, "waiting": false}));
    settle().await;
    assert!(!call.music_waiting());
}

#[tokio::test]
async fn an_older_helper_without_call_start_refuses_it() {
    let fake = Fake::new(|request| {
        vec![json!({
            "id": request["id"],
            "error": format!("unknown op {}", request["op"].as_str().unwrap_or("")),
        })]
    });
    let error = helper(&fake)
        .start_call(background(), Arc::new(|_| {}))
        .await
        .err()
        .unwrap();
    assert!(error.contains("unknown op call_start"), "{error}");
}

#[tokio::test]
async fn a_helper_that_mixes_but_makes_no_webrtc_call_is_not_used() {
    let fake = Fake::new(|request| {
        if request["op"] == "call_start" {
            vec![json!({"id": request["id"], "ok": true, "music": true})]
        } else {
            vec![]
        }
    });
    let error = helper(&fake)
        .start_call(background(), Arc::new(|_| {}))
        .await
        .err()
        .unwrap();
    assert!(error.contains("no WebRTC call"), "{error}");
    assert_eq!(last_request(&fake)["op"], "call_stop");
}

// Call background settings.

/// voice.json with Kokoro reading and `extra`, in a directory of its own.
fn written(extra: Value) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice.json");
    let mut raw = json!({"helper": "/bin/sh", "tts_models": [{"model": "kokoro"}]});
    for (key, value) in extra.as_object().unwrap() {
        raw[key] = value.clone();
    }
    std::fs::write(&path, raw.to_string()).unwrap();
    (dir, path)
}

fn read(extra: Value) -> Result<crate::config::VoiceConfig, String> {
    let (_dir, path) = written(extra);
    read_voice_config(&path)
}

#[test]
fn default_to_no_background_0_6_0_15_3_s_and_the_music_off_at_first() {
    assert_eq!(
        config(json!({})).call_background(),
        CallBackground {
            background: String::new(),
            volume: 0.6,
            ducked: 0.15,
            release_ms: 3000.0,
            muted: true,
            reply_loudness: Some(-16.0),
        }
    );
    assert!(
        !config(json!({"call_music_at_start": true}))
            .call_background()
            .muted
    );
}

#[test]
fn brings_the_replies_to_call_reply_loudness_or_leaves_them_on_false() {
    assert_eq!(
        config(json!({"call_reply_loudness": -14}))
            .call_background()
            .reply_loudness,
        Some(-14.0)
    );
    assert_eq!(
        config(json!({"call_reply_loudness": false}))
            .call_background()
            .reply_loudness,
        None
    );
    for loudness in [json!(-3), json!(-50), json!("loud"), json!(true)] {
        let error = read(json!({"whisper_model": "/bin/sh", "call_reply_loudness": loudness}))
            .err()
            .unwrap();
        assert!(error.contains("call_reply_loudness"), "{error}");
    }
    let kept = read(json!({"whisper_model": "/bin/sh", "call_reply_loudness": false})).unwrap();
    assert_eq!(kept.raw["call_reply_loudness"], false);
}

#[test]
fn voice_json_takes_call_music_at_start_as_a_boolean_only() {
    let error = read(json!({"whisper_model": "/bin/sh", "call_music_at_start": "yes"}))
        .err()
        .unwrap();
    assert!(error.contains("call_music_at_start"), "{error}");
}

#[test]
fn voice_json_takes_call_music_device_as_a_string_only() {
    let error = read(json!({"whisper_model": "/bin/sh", "call_music_device": 3}))
        .err()
        .unwrap();
    assert!(error.contains("call_music_device"), "{error}");
    let kept =
        read(json!({"whisper_model": "/bin/sh", "call_music_device": "amd-desktop"})).unwrap();
    assert_eq!(kept.raw["call_music_device"], "amd-desktop");
}

#[test]
fn voice_json_refuses_levels_out_of_range() {
    let error = read(json!({"whisper_model": "/bin/sh", "call_background_ducked": 2}))
        .err()
        .unwrap();
    assert!(error.contains("call_background_ducked"), "{error}");
    let fine = read(json!({
        "whisper_model": "/bin/sh",
        "call_background": "osxprocesstapsrc bundle-id=com.spotify.client",
        "call_background_volume": 0.5,
    }))
    .unwrap();
    assert_eq!(fine.raw["call_background_volume"], 0.5);
}
