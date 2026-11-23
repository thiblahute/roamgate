//! voice-socket.test.ts: the voice chat's listening, its resume, stalls and
//! the pauses that end a turn.

use serde_json::{Value, json};

use super::*;
use crate::config::{LONGEST_PAUSE_MS, MAX_PAUSE_MS};
use crate::speakers::parse_voice_tag;

fn socket_with(
    helper: &Arc<FakeHelper>,
    clock: &Arc<TestClock>,
    change: impl FnOnce(&mut VoiceSocketOptions),
) -> VoiceSocket {
    let mut options = options(clock);
    change(&mut options);
    VoiceSocket::new(helper.clone(), options)
}

fn cleaning(chat: &Arc<FakeCleaner>, fronted: bool) -> Arc<dyn Companion> {
    Arc::new(FakeCompanion {
        chat: Some(chat.clone()),
        dictation: None,
        fronted,
    })
}

/// Words read `pause_ms` into a pause, with the turn models' scores.
fn reading(helper: &FakeHelper, text: &str, pause_ms: u64, turn: Option<(f64, f64)>) {
    let mut event = json!({
        "event": "partial",
        "session": 1,
        "text": text,
        "pause": true,
        "pause_ms": pause_ms,
    });
    if let Some((turn, words)) = turn {
        event["turn"] = json!(turn);
        event["words"] = json!(words);
    }
    helper.emit(event);
}

/// `ms` of quiet audio, streamed as it comes.
async fn pause(socket: &VoiceSocket, ws: &Socket, clock: &TestClock, ms: u64) {
    let mut at = 0;
    while at < ms {
        let chunk = 40.min(ms - at);
        socket.audio(&ws.peer, &audio(chunk as usize));
        clock.advance(chunk).await;
        at += 40;
    }
}

#[tokio::test]
async fn without_a_context_events_pass_as_they_are() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let chat = Arc::new(FakeCleaner::default());
    let socket = socket_with(&helper, &clock, |options| {
        options.companion = cleaning(&chat, false);
    });
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    // The listening models' loading is a dictation's news only.
    helper.emit(json!({"event": "listen_loading", "session": 1}));
    helper.emit(json!({"event": "listen_ready", "session": 1}));
    helper.emit(json!({"event": "final", "session": 1, "text": "Do um it.", "speech_ms": 900}));
    let sent = ws.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["event"], "listening");
    assert_eq!(sent[0]["session"], 1);
    assert!(sent[0]["resume"].is_string());
    assert_eq!(
        sent[1],
        json!({"event": "final", "session": 1, "text": "Do um it.", "speech_ms": 900})
    );
}

#[tokio::test]
async fn with_a_context_the_final_text_is_cleaned_in_order() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let chat = Arc::new(FakeCleaner::default());
    let socket = socket_with(&helper, &clock, |options| {
        options.companion = cleaning(&chat, false);
    });
    let ws = Socket::new();
    say(
        &socket,
        &ws,
        json!({"op": "listen", "context": "Agent: Ready?"}),
    );
    helper.emit(json!({"event": "speech_end", "session": 1}));
    helper.emit(json!({"event": "final", "session": 1, "text": "Do um it.", "speech_ms": 900}));
    helper
        .emit(json!({"event": "final", "session": 1, "text": "Pass the salt.", "speech_ms": 800}));
    settle().await;
    assert_eq!(
        ws.sent()[1..],
        [
            json!({"event": "speech_end", "session": 1}),
            json!({
                "event": "final", "session": 1, "text": "Do it.", "raw": "Do um it.",
                "for_agent": true, "speech_ms": 900,
            }),
            json!({
                "event": "final", "session": 1, "text": "Pass the salt.",
                "raw": "Pass the salt.", "for_agent": false, "speech_ms": 800,
            }),
        ]
    );
    assert!(lock(&chat.contexts)[0].contains("Agent: Ready?"));
}

#[tokio::test]
async fn words_not_surely_the_speakers_stay_not_for_the_agent_cleaned_or_not() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let chat = Arc::new(FakeCleaner::default());
    let socket = socket_with(&helper, &clock, |options| {
        options.companion = cleaning(&chat, false);
    });
    let ws = Socket::new();
    say(
        &socket,
        &ws,
        json!({"op": "listen", "context": "Agent: Ready?"}),
    );
    // The cleaner takes it for the agent; the helper's speaker check did
    // not take it as the speaker's voice.
    helper.emit(json!({
        "event": "final", "session": 1, "text": "Et um puis je disais.",
        "speech_ms": 680, "for_agent": false,
    }));
    settle().await;
    assert_eq!(
        ws.last(),
        json!({
            "event": "final", "session": 1, "text": "Et puis je disais.",
            "raw": "Et um puis je disais.", "for_agent": false, "speech_ms": 680,
        })
    );
}

fn tag(id: &str, similarity: Value) -> Value {
    json!({
        "voices": 3,
        "id": id,
        "share": 1,
        "mixed": false,
        "mix": [{"id": id, "share": 1}],
        "similarity": similarity,
    })
}

#[tokio::test]
async fn a_final_carries_its_voices_label_clearly_another_voice_is_not_for_the_agent_without_a_companion()
 {
    for fronted in [false, true] {
        let clock = clock();
        let helper = FakeHelper::new(true);
        let mut learnt = parse_voice_tag(&tag("A", json!({"A": 0.6}))).unwrap();
        lock(&helper.speakers).learn(Some(&mut learnt), "self", None);
        let chat = Arc::new(FakeCleaner::default());
        let socket = socket_with(&helper, &clock, |options| {
            options.companion = cleaning(&chat, fronted);
        });
        let ws = Socket::new();
        say(
            &socket,
            &ws,
            json!({"op": "listen", "context": "Agent: Ready?"}),
        );
        helper.emit(json!({
            "event": "final", "session": 1, "text": "Bonjour à tous.", "speech_ms": 900,
            "voice": tag("B", json!({"A": 0.04, "B": 0.7})),
        }));
        helper.emit(json!({
            "event": "final", "session": 1, "text": "Do it.", "speech_ms": 900,
            "voice": tag("A", json!({"A": 0.58, "B": 0.1})),
        }));
        settle().await;
        let finals: Vec<(Value, Value)> = ws
            .sent()
            .into_iter()
            .filter(|event| event["event"] == "final")
            .map(|event| (event["voice_label"].clone(), event["for_agent"].clone()))
            .collect();
        assert_eq!(
            finals,
            [
                // A companion judges another voice by its label.
                (json!("voice B, 0.04 like you"), json!(fronted)),
                (json!("you 0.58"), json!(true)),
            ]
        );
    }
}

#[tokio::test]
async fn a_session_outlives_its_socket_a_new_one_resumes_it_missing_nothing() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    let token = first.sent()[0]["resume"].clone();
    helper.emit(json!({"event": "speech_start", "session": 1}));
    socket.audio(&first.peer, &audio(400));
    socket.close(&first.peer);
    // Heard while no socket was there.
    helper.emit(json!({"event": "partial", "session": 1, "text": "I was saying the"}));
    clock.advance(DETACHED_MS - 1000).await;
    assert!(helper.calls().is_empty());
    let second = Socket::new();
    say(
        &socket,
        &second,
        json!({"op": "resume", "session": 1, "resume": token}),
    );
    assert_eq!(
        second.sent(),
        [
            json!({"event": "resumed", "session": 1, "received": 400 * 32}),
            json!({"event": "partial", "session": 1, "text": "I was saying the"}),
        ]
    );
    socket.audio(&second.peer, &audio(400));
    assert_eq!(helper.latest().bytes(), 800 * 32);
    helper.emit(json!({"event": "final", "session": 1, "text": "I was saying the end."}));
    assert_eq!(
        second.last(),
        json!({"event": "final", "session": 1, "text": "I was saying the end."})
    );
    // The old timer is gone: nothing ends it meanwhile.
    clock.advance(DETACHED_MS * 2).await;
    assert!(helper.calls().is_empty());
}

#[tokio::test]
async fn a_resume_with_the_wrong_token_is_refused() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    socket.close(&first.peer);
    let second = Socket::new();
    say(
        &socket,
        &second,
        json!({"op": "resume", "session": 1, "resume": "guess"}),
    );
    assert_eq!(
        second.sent(),
        [json!({"event": "resume_failed", "session": 1})]
    );
}

#[tokio::test]
async fn with_no_resume_the_utterance_ends_with_what_was_heard_kept_for_later() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    let token = first.sent()[0]["resume"].clone();
    helper.emit(json!({"event": "speech_start", "session": 1}));
    socket.close(&first.peer);
    clock.advance(DETACHED_MS).await;
    assert_eq!(helper.calls(), ["finish"]);
    helper.emit(json!({"event": "final", "session": 1, "text": "Pretty decent."}));
    clock.advance(60_000).await;
    let late = Socket::new();
    say(
        &socket,
        &late,
        json!({"op": "resume", "session": 1, "resume": token}),
    );
    assert_eq!(
        late.last(),
        json!({"event": "final", "session": 1, "text": "Pretty decent."})
    );
}

#[tokio::test]
async fn a_stalled_stream_is_not_silence_it_is_taken_as_a_gone_socket() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    helper.emit(json!({"event": "partial", "session": 1, "text": "pretty g"}));
    socket.audio(&first.peer, &audio(200));
    // No audio: no pause is counted, and nothing ends at once.
    clock.advance(STALL_MS).await;
    assert!(helper.calls().is_empty());
    let missed = json!({"event": "text", "session": 1, "text": "missed"});
    helper.emit(missed.clone());
    assert_ne!(first.last(), missed);
    // The stream comes back on the same socket: what it missed comes.
    socket.audio(&first.peer, &audio(40));
    assert_eq!(first.last(), missed);
    assert!(helper.calls().is_empty());
}

#[tokio::test]
async fn its_socket_speaking_again_brings_a_stalled_session_what_it_missed() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    socket.audio(&first.peer, &audio(200));
    clock.advance(STALL_MS).await;
    helper.emit(json!({"event": "final", "session": 1, "text": "Kept meanwhile."}));
    assert_ne!(first.last()["event"], "final");
    // A message, not audio: the socket is there.
    say(&socket, &first, json!({"op": "release"}));
    assert_eq!(
        first.last(),
        json!({"event": "final", "session": 1, "text": "Kept meanwhile."})
    );
}

#[tokio::test]
async fn a_helper_exit_ends_each_listening_on_its_own_session_told_never_finished() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let first = Socket::new();
    say(&socket, &first, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    let stopped = json!({
        "event": "error",
        "session": 1,
        "error": "The voice helper stopped",
        "recoverable": true,
    });
    helper.emit(stopped.clone());
    assert_eq!(first.last(), stopped);
    // Over: dropped, and no finish for a session of a helper gone.
    assert_eq!(helper.calls(), ["stop"]);
    clock.advance(DETACHED_MS + KEPT_MS).await;
    socket.close(&first.peer);
    clock.advance(DETACHED_MS + KEPT_MS).await;
    assert_eq!(helper.calls(), ["stop"]);

    // Its socket away meanwhile: kept for a resume, told then.
    let away = FakeHelper::new(true);
    let other = socket_with(&away, &clock, |_| {});
    let second = Socket::new();
    say(&other, &second, json!({"op": "listen"}));
    let token = second.sent()[0]["resume"].clone();
    other.close(&second.peer);
    away.emit(stopped.clone());
    clock.advance(DETACHED_MS).await;
    assert!(away.calls().is_empty());
    let third = Socket::new();
    say(
        &other,
        &third,
        json!({"op": "resume", "session": 1, "resume": token}),
    );
    assert_eq!(third.last(), stopped);
}

#[tokio::test]
async fn a_finished_voice_the_words_veto_ends_at_the_cap_a_search_for_a_word_does_not() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    // Looking for a word: nothing read, the voice sounds unfinished.
    reading(&helper, "", 500, None);
    reading(&helper, "", 1500, Some((0.01, 0.4)));
    pause(&socket, &ws, &clock, 1000).await;
    reading(&helper, "", 2500, Some((0.16, 0.4)));
    reading(&helper, "", 3500, Some((0.12, 0.4)));
    pause(&socket, &ws, &clock, LONGEST_PAUSE_MS as u64 - 3500 - 100).await;
    assert!(helper.calls().is_empty());
    // The word comes, then the sentence ends; its words read unfinished.
    helper.emit(json!({"event": "partial", "session": 1, "text": "I would like the"}));
    let words = "I would like the blue one";
    reading(&helper, words, 500, None);
    reading(&helper, words, 1500, Some((0.34, 0.013)));
    pause(&socket, &ws, &clock, 1000).await;
    reading(&helper, words, 2500, Some((0.67, 0.013)));
    pause(&socket, &ws, &clock, 1000).await;
    reading(&helper, words, 3500, Some((0.86, 0.013)));
    pause(&socket, &ws, &clock, MAX_PAUSE_MS as u64 - 3500 - 40).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, 40).await;
    assert_eq!(helper.calls(), ["finish"]);
}

#[tokio::test]
async fn a_pause_that_never_sounds_finished_ends_at_the_longest_pause() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    helper.emit(json!({"event": "partial", "session": 1, "text": "the conversation was"}));
    // A stall mid-word reads unfinished, and sounds it.
    reading(&helper, "the conversation was pretty g", 500, None);
    pause(&socket, &ws, &clock, 1000).await;
    reading(
        &helper,
        "the conversation was pretty g",
        1500,
        Some((0.2, 0.001)),
    );
    pause(&socket, &ws, &clock, LONGEST_PAUSE_MS as u64 - 1500 - 40).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, 40).await;
    assert_eq!(helper.calls(), ["finish"]);
    pause(&socket, &ws, &clock, 4000).await;
    assert_eq!(helper.calls(), ["finish"]);
}

#[tokio::test]
async fn a_trailing_euh_holds_the_turn_past_the_cap_however_finished_it_sounds() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    reading(&helper, "on prend le train et puis euh", 500, None);
    pause(&socket, &ws, &clock, 1000).await;
    reading(
        &helper,
        "on prend le train et puis euh",
        1500,
        Some((0.9, 0.2)),
    );
    pause(&socket, &ws, &clock, 6000).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, LONGEST_PAUSE_MS as u64 - 7500 - 40).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, 40).await;
    assert_eq!(helper.calls(), ["finish"]);
}

#[tokio::test]
async fn a_filler_mid_pause_starts_the_count_again_and_holds_the_turn() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let socket = socket_with(&helper, &clock, |_| {});
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    reading(&helper, "and then", 500, None);
    reading(&helper, "and then", 3500, Some((0.7, 0.013)));
    pause(&socket, &ws, &clock, MAX_PAUSE_MS as u64 - 3500 - 1000).await;
    // "um", dropped by the transcriber: no new word, a reading early into
    // a new pause, which speechgate tells a thinking one.
    helper.emit(json!({
        "event": "partial", "session": 1, "text": "and then", "pause": true,
        "pause_ms": 500, "thinking": true,
    }));
    pause(&socket, &ws, &clock, 2000).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, LONGEST_PAUSE_MS as u64 - 2500 - 40).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, 40).await;
    assert_eq!(helper.calls(), ["finish"]);
}

#[tokio::test]
async fn the_longest_pause_is_read_from_the_settings_at_each_listen() {
    let clock = clock();
    let helper = FakeHelper::new(true);
    let setting = Arc::new(Mutex::new(json!(12_000)));
    let read = setting.clone();
    let socket = socket_with(&helper, &clock, |options| {
        options.max_pause = Arc::new(move || Some(lock(&read).clone()));
    });
    let ws = Socket::new();
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    reading(&helper, "that is all", 3500, Some((0.8, 0.01)));
    pause(&socket, &ws, &clock, 12_000 - 3500 - 40).await;
    assert!(helper.calls().is_empty());
    pause(&socket, &ws, &clock, 40).await;
    assert_eq!(helper.calls(), ["finish"]);
    // Unusable: the default.
    *lock(&setting) = json!("soon");
    say(&socket, &ws, json!({"op": "listen"}));
    helper.emit(json!({"event": "speech_start", "session": 1}));
    reading(&helper, "that is all", 3500, Some((0.8, 0.01)));
    pause(&socket, &ws, &clock, MAX_PAUSE_MS as u64 - 3500).await;
    assert_eq!(helper.calls(), ["finish"]);
}

fn event(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn speech_in_the_pause_starts_the_count_again() {
    let mut cap = SilenceCap::new(4000.0);
    cap.event(&event(json!({"event": "speech_start"})));
    cap.event(&event(
        json!({"event": "partial", "text": "one two", "pause": true, "turn": 0.8}),
    ));
    assert!(!cap.audio(3000.0 * 32.0));
    // More words at the next pause: the person spoke meanwhile.
    cap.event(&event(
        json!({"event": "partial", "text": "one two three", "pause": true, "turn": 0.8}),
    ));
    assert!(!cap.audio(3000.0 * 32.0));
    assert!(cap.audio(500.0 * 32.0));
}

#[test]
fn the_same_words_at_each_check_of_a_pause_keep_its_count() {
    let mut cap = SilenceCap::new(4000.0);
    cap.event(&event(json!({"event": "speech_start"})));
    cap.event(&event(
        json!({"event": "partial", "text": "one two", "pause": true, "pause_ms": 500}),
    ));
    assert!(!cap.audio(1000.0 * 32.0));
    cap.event(&event(json!({
        "event": "partial", "text": "one two", "pause": true, "pause_ms": 1500, "turn": 0.6,
    })));
    assert!(cap.audio(2500.0 * 32.0));
}

#[test]
fn a_question_asked_whole_ends_soon_even_taken_for_thinking() {
    let mut cap = SilenceCap::new(8000.0);
    cap.event(&event(json!({"event": "speech_start"})));
    // A short noise in a car read as the speaker thinking.
    cap.event(&event(json!({
        "event": "partial", "text": "Compagnon, est-ce que tu m'entends?", "pause": true,
        "pause_ms": 1500, "turn": 0.97, "thinking": true,
    })));
    assert_eq!(cap.limit_ms(), QUESTION_PAUSE_MS);
    // Counted from its reading 1.5 s into the pause.
    assert!(!cap.audio(500.0 * 32.0));
    assert!(cap.audio(600.0 * 32.0));
    // Not in a voice that sounded unfinished.
    let mut unsure = SilenceCap::new(8000.0);
    unsure.event(&event(json!({"event": "speech_start"})));
    unsure.event(&event(json!({
        "event": "partial", "text": "Comment ça s'appelle déjà?", "pause": true,
        "pause_ms": 1500, "turn": 0.2,
    })));
    assert_eq!(unsure.limit_ms(), LONGEST_PAUSE_MS);
    assert!(ends_with_question("tu m'entends ?"));
    // A voice surely done ends soon too; never on a filler.
    let mut sure = SilenceCap::new(8000.0);
    sure.event(&event(json!({"event": "speech_start"})));
    sure.event(&event(json!({
        "event": "partial", "text": "Ouais, vas-y.", "pause": true, "pause_ms": 1500,
        "turn": 0.98, "thinking": true,
    })));
    assert_eq!(sure.limit_ms(), SURE_PAUSE_MS);
    let mut filler = SilenceCap::new(8000.0);
    filler.event(&event(json!({"event": "speech_start"})));
    filler.event(&event(json!({
        "event": "partial", "text": "et puis euh", "pause": true, "pause_ms": 1500, "turn": 0.98,
    })));
    assert_eq!(filler.limit_ms(), LONGEST_PAUSE_MS);
    // A lower setting of its own still applies.
    let mut short = SilenceCap::new(2000.0);
    short.event(&event(json!({"event": "speech_start"})));
    short.event(&event(json!({
        "event": "partial", "text": "Ouais, vas-y.", "pause": true, "pause_ms": 1500, "turn": 0.98,
    })));
    assert_eq!(short.limit_ms(), 2000.0);
    assert!(!ends_with_question("je me demande si. "));
}

#[test]
fn a_partial_while_speaking_stops_the_count_none_while_no_pause() {
    let mut cap = SilenceCap::new(4000.0);
    assert!(!cap.audio(20_000.0 * 32.0));
    cap.event(&event(json!({"event": "speech_start"})));
    cap.event(&event(
        json!({"event": "partial", "text": "one", "pause": true, "turn": 0.9}),
    ));
    cap.event(&event(json!({"event": "partial", "text": "one two"})));
    assert!(!cap.audio(20_000.0 * 32.0));
}

#[test]
fn fillers_end_the_words_um_euh_heu_hmm_ben_alors() {
    for text in [
        "and then um",
        "et puis euh",
        "c'est heu",
        "so hmm",
        "ben",
        "et alors",
        "Et puis, euh...",
        // Parakeet's "euh".
        "je pense que eux.",
    ] {
        assert!(ends_with_filler(text), "{text}");
    }
    for text in ["", "that is all", "the museum", "deuh"] {
        assert!(!ends_with_filler(text), "{text}");
    }
}
