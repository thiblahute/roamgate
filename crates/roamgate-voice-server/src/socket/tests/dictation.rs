//! voice-socket.dictation.test.ts: dictation on the voice socket. The
//! cleaner's prompts and its own timeout are the companion layer's
//! (voice-dictation.ts); here the socket gives it the listen request and
//! takes what it answers.

use std::future::pending;

use roamgate_base::clock::Clock;

use serde_json::json;

use super::*;

/// The model's time to clean a dictation (voice-dictation.ts
/// DICTATION_CLEAN_MS), as the fake cleaner's timeout.
const DICTATION_CLEAN_MS: u64 = 8000;

struct Dictating {
    clock: Arc<TestClock>,
    helper: Arc<FakeHelper>,
    socket: VoiceSocket,
}

fn dictating(cleaner: Option<Arc<FakeDictation>>) -> Dictating {
    dictating_with(cleaner, |_| {})
}

fn dictating_with(
    cleaner: Option<Arc<FakeDictation>>,
    change: impl FnOnce(&mut VoiceSocketOptions),
) -> Dictating {
    let clock = clock();
    let helper = FakeHelper::new(false);
    let mut options = options(&clock);
    // The voice chat's own cleaner: never used by a dictation.
    options.companion = Arc::new(FakeCompanion {
        chat: Some(Arc::new(FakeCleaner {
            refuses: true,
            ..FakeCleaner::default()
        })),
        dictation: cleaner,
        fronted: false,
    });
    change(&mut options);
    let socket = VoiceSocket::new(helper.clone(), options);
    Dictating {
        clock,
        helper,
        socket,
    }
}

fn listen(extra: Value) -> Value {
    let mut request = json!({"op": "listen", "mode": "dictation"});
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        request[&key] = value;
    }
    request
}

fn finals(ws: &Socket) -> usize {
    ws.count("final")
}

#[tokio::test]
async fn partials_show_the_whole_dictation_finish_gives_the_cleaned_text_with_its_timing() {
    let cleaner = FakeDictation::new();
    let Dictating { helper, socket, .. } = dictating(Some(cleaner.clone()));
    let ws = Socket::new();
    say(
        &socket,
        &ws,
        listen(json!({
            "language": "fr",
            "field": {"app": "com.whatsapp", "kind": "chat", "hint": "Message"},
            "before": "Salut Gwenaëlle, ",
            "after": "",
        })),
    );
    let first = ws.sent()[0].clone();
    assert_eq!(first["event"], "listening");
    assert_eq!(first["session"], 1);
    assert_eq!(first["mode"], "dictation");
    assert!(first["resume"].is_string());
    // No turn models cutting in: the longest pause, no new speaker.
    let options = &helper.session(0).options;
    assert_eq!(options.language.as_deref(), Some("fr"));
    assert_eq!(options.end_silence_ms, Some(10_000.0));
    assert!(!options.new_speaker && !options.hold && options.call.is_none());
    helper.emit(json!({"event": "speech_start"}));
    helper.emit(json!({"event": "partial", "text": "euh on se voit"}));
    // A pause ends the helper's utterance, not the dictation: it listens
    // again at once, and the client is told nothing ended.
    helper.emit(json!({"event": "final", "text": "euh on se voit", "for_agent": false}));
    assert_eq!(helper.count(), 2);
    assert_eq!(helper.session(0).calls(), ["stop"]);
    helper.emit(json!({"event": "speech_start"}));
    helper.emit(json!({"event": "partial", "text": "demain"}));
    say(&socket, &ws, json!({"op": "finish"}));
    assert_eq!(helper.session(1).calls(), ["finish"]);
    helper.emit(json!({"event": "final", "text": "demain"}));
    settle().await;
    let sent = ws.sent();
    assert_eq!(
        sent[1..5],
        [
            json!({"event": "speech_start", "session": 1}),
            json!({"event": "partial", "session": 1, "text": "euh on se voit"}),
            json!({"event": "speech_start", "session": 1}),
            json!({"event": "partial", "session": 1, "text": "euh on se voit demain"}),
        ]
    );
    let last = &sent[5];
    assert_eq!(sent.len(), 6);
    assert_eq!(last["event"], "final");
    assert_eq!(last["session"], 1);
    assert_eq!(last["text"], "On se voit demain.");
    assert_eq!(last["raw"], "euh on se voit demain");
    assert_eq!(last["cleaned"], true);
    assert!(last["timing"]["stt_ms"].is_number() && last["timing"]["clean_ms"].is_number());
    // The cleaner is given where the text goes, as the client said it.
    let request = lock(&cleaner.requests)[0].clone();
    assert_eq!(request["field"]["app"], "com.whatsapp");
    assert_eq!(request["before"], "Salut Gwenaëlle, ");
}

#[tokio::test]
async fn a_pause_never_finishes_a_dictation_however_long() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    helper.emit(json!({"event": "speech_start"}));
    helper.emit(json!({"event": "partial", "text": "I think.", "pause": true, "turn": 0.99}));
    for _ in 0..40 {
        socket.audio(&ws.peer, &audio(500));
    }
    assert!(helper.calls().is_empty());
    assert_eq!(helper.latest().bytes(), 40 * 500 * 32);
}

#[tokio::test]
async fn a_helper_that_never_answers_finish_still_gives_a_final_as_heard() {
    let Dictating {
        clock,
        helper,
        socket,
    } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    helper.emit(json!({"event": "partial", "text": "hello there"}));
    say(&socket, &ws, json!({"op": "finish"}));
    // Done sending audio: waiting for the final is not a stall.
    clock.advance(STALL_MS + 1).await;
    assert_eq!(ws.last()["event"], "partial");
    clock.advance(FINISH_DEADLINE_MS).await;
    assert_eq!(
        ws.last(),
        json!({
            "event": "final", "session": 1, "text": "hello there", "raw": "hello there",
            "cleaned": false, "timing": {"stt_ms": FINISH_DEADLINE_MS, "clean_ms": 0},
        })
    );
    // A late final from the helper adds nothing.
    helper.emit(json!({"event": "final", "text": "hello there"}));
    settle().await;
    assert_eq!(finals(&ws), 1);
}

#[tokio::test]
async fn a_cleaner_that_never_answers_gives_the_words_as_heard_in_time() {
    let clock = clock();
    let timing = clock.clone();
    // The model never answers: the cleaning gives the words as heard at
    // its own deadline.
    let cleaner = FakeDictation::answering(Arc::new(move |heard: String| {
        let deadline = timing.sleep(Duration::from_millis(DICTATION_CLEAN_MS));
        Box::pin(async move {
            tokio::select! {
                () = pending::<()>() => unreachable!(),
                () = deadline => Dictated { text: heard, cleaned: false },
            }
        })
    }));
    let helper = FakeHelper::new(false);
    let mut options = options(&clock);
    options.companion = Arc::new(FakeCompanion {
        chat: None,
        dictation: Some(cleaner),
        fronted: false,
    });
    let socket = VoiceSocket::new(helper.clone(), options);
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    say(&socket, &ws, json!({"op": "finish"}));
    helper.emit(json!({"event": "final", "text": "euh hello"}));
    settle().await;
    clock.advance(DICTATION_CLEAN_MS).await;
    settle().await;
    let last = ws.last();
    assert_eq!(last["event"], "final");
    assert_eq!(last["text"], "euh hello");
    assert_eq!(last["raw"], "euh hello");
    assert_eq!(last["cleaned"], false);
    assert_eq!(finals(&ws), 1);
    clock.advance(FINISH_DEADLINE_MS).await;
    assert_eq!(finals(&ws), 1);
}

#[tokio::test]
async fn a_failing_cleaner_or_none_types_the_words_as_heard() {
    let failing = FakeDictation::answering(Arc::new(|heard: String| {
        Box::pin(async move {
            Dictated {
                text: heard,
                cleaned: false,
            }
        })
    }));
    for cleaner in [Some(failing), None] {
        let Dictating { helper, socket, .. } = dictating(cleaner);
        let ws = Socket::new();
        say(&socket, &ws, listen(json!({})));
        say(&socket, &ws, json!({"op": "finish"}));
        helper.emit(json!({"event": "final", "text": "euh hello"}));
        settle().await;
        let last = ws.last();
        assert_eq!(last["event"], "final");
        assert_eq!(last["text"], "euh hello");
        assert_eq!(last["cleaned"], false);
        assert!(last.get("for_agent").is_none());
    }
}

#[tokio::test]
async fn nothing_heard_is_an_explicit_error_never_an_empty_final() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    say(&socket, &ws, json!({"op": "finish"}));
    helper.emit(json!({"event": "final", "text": "", "speech_ms": 0}));
    settle().await;
    assert_eq!(
        ws.last(),
        json!({
            "event": "error", "session": 1, "error": NOTHING_HEARD,
            "nothing_heard": true, "recoverable": false,
        })
    );
    assert_eq!(finals(&ws), 0);
    // Once: a late final from the helper adds nothing.
    helper.emit(json!({"event": "final", "text": "late"}));
    settle().await;
    assert_eq!(ws.count("error"), 1);
}

#[tokio::test]
async fn nothing_heard_by_the_deadline_is_the_same_explicit_error() {
    let Dictating { clock, socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    say(&socket, &ws, json!({"op": "finish"}));
    clock.advance(FINISH_DEADLINE_MS).await;
    let last = ws.last();
    assert_eq!(last["event"], "error");
    assert_eq!(last["nothing_heard"], true);
    assert_eq!(last["recoverable"], false);
}

#[tokio::test]
async fn a_helper_loading_its_models_hears_the_audio_sent_before_once_ready() {
    let Dictating {
        clock,
        helper,
        socket,
    } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    // A helper just started: its listening models load for seconds.
    helper.emit(json!({"event": "listen_loading"}));
    assert_eq!(
        ws.last(),
        json!({"event": "loading", "session": 1, "mode": "dictation"})
    );
    for _ in 0..150 {
        socket.audio(&ws.peer, &audio(20));
    }
    // All of it goes to the helper, which keeps it until they load.
    assert_eq!(helper.latest().bytes(), 150 * 20 * 32);
    say(&socket, &ws, json!({"op": "finish"}));
    assert_eq!(helper.calls(), ["finish"]);
    // The models take longer than the deadline after finish: the dictation
    // waits for them rather than ending with nothing.
    clock.advance(FINISH_DEADLINE_MS + 5_000).await;
    assert_eq!(ws.last()["event"], "loading");
    helper.emit(json!({"event": "listen_ready"}));
    assert_eq!(
        ws.last(),
        json!({"event": "ready", "session": 1, "mode": "dictation"})
    );
    // Then the audio sent meanwhile is heard.
    helper.emit(json!({"event": "speech_start"}));
    helper.emit(json!({"event": "partial", "text": "euh hello there"}));
    helper.emit(json!({"event": "final", "text": "euh hello there"}));
    settle().await;
    let last = ws.last();
    assert_eq!(last["event"], "final");
    assert_eq!(last["session"], 1);
    assert_eq!(last["text"], "Hello there.");
    assert_eq!(last["raw"], "euh hello there");
    assert_eq!(last["cleaned"], true);
}

#[tokio::test]
async fn once_ready_a_dictation_finished_while_loading_has_finish_deadline_ms() {
    let Dictating {
        clock,
        helper,
        socket,
    } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    helper.emit(json!({"event": "listen_loading"}));
    say(&socket, &ws, json!({"op": "finish"}));
    clock.advance(LOADING_DEADLINE_MS - 1).await;
    helper.emit(json!({"event": "listen_ready"}));
    helper.emit(json!({"event": "partial", "text": "hello"}));
    clock.advance(FINISH_DEADLINE_MS - 1).await;
    assert_eq!(finals(&ws), 0);
    clock.advance(1).await;
    let last = ws.last();
    assert_eq!(last["event"], "final");
    assert_eq!(last["text"], "hello");
    assert_eq!(last["cleaned"], false);
}

#[tokio::test]
async fn a_helper_that_stops_mid_dictation_ends_it_with_an_error_at_once() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    helper.emit(json!({"event": "partial", "text": "hello"}));
    helper.emit(json!({"event": "error", "error": "The helper stopped", "recoverable": true}));
    assert_eq!(
        ws.last(),
        json!({
            "event": "error", "session": 1, "error": "The helper stopped", "recoverable": true,
        })
    );
}

#[tokio::test]
async fn a_resume_of_an_unknown_session_is_an_error_the_phone_stops_on() {
    let Dictating { socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(
        &socket,
        &ws,
        json!({"op": "resume", "mode": "dictation", "session": 42, "resume": "x"}),
    );
    say(
        &socket,
        &ws,
        json!({"op": "resume", "session": 42, "resume": "x"}),
    );
    assert_eq!(
        ws.sent(),
        [
            json!({
                "event": "error", "session": 42, "error": "unknown session", "recoverable": false,
            }),
            json!({"event": "resume_failed", "session": 42}),
        ]
    );
}

#[tokio::test]
async fn a_dictation_resumed_after_a_network_change_gets_its_final() {
    let Dictating {
        clock,
        helper,
        socket,
    } = dictating(Some(FakeDictation::new()));
    let first = Socket::new();
    say(&socket, &first, listen(json!({})));
    socket.audio(&first.peer, &audio(100));
    let token = first.sent()[0]["resume"].clone();
    say(&socket, &first, json!({"op": "finish"}));
    socket.close(&first.peer);
    helper.emit(json!({"event": "final", "text": "euh hello"}));
    settle().await;
    clock.advance(DETACHED_MS - 1000).await;
    let second = Socket::new();
    say(
        &socket,
        &second,
        json!({"op": "resume", "mode": "dictation", "session": 1, "resume": token}),
    );
    let sent = second.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0],
        json!({"event": "resumed", "session": 1, "received": 3200})
    );
    assert_eq!(sent[1]["event"], "final");
    assert_eq!(sent[1]["text"], "Hello.");
}

#[tokio::test]
async fn warm_starts_the_dictation_cleaner_and_says_whether_there_is_one() {
    let cleaner = FakeDictation::new();
    for using in [Some(cleaner.clone()), None] {
        let there = using.is_some();
        let Dictating { socket, .. } = dictating(using);
        let ws = Socket::new();
        say(&socket, &ws, json!({"op": "warm", "mode": "dictation"}));
        assert_eq!(
            ws.sent(),
            [json!({"event": "warm", "mode": "dictation", "cleaner": there})]
        );
    }
    assert_eq!(cleaner.warmed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn refused_while_a_voice_call_goes_on() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let caller = Socket::new();
    say(&socket, &caller, json!({"op": "call_audio", "on": true}));
    settle().await;
    assert_eq!(caller.sent()[0]["event"], "call_audio");
    assert_eq!(caller.sent()[0]["call"], 7);
    let phone = Socket::new();
    say(&socket, &phone, listen(json!({})));
    assert_eq!(
        phone.sent(),
        [json!({
            "event": "error", "session": null, "error": "A voice call is going on", "busy": true,
        })]
    );
    assert_eq!(helper.count(), 0);
}

#[tokio::test]
async fn voice_chat_taking_the_helper_ends_a_dictation_with_what_it_heard() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let phone = Socket::new();
    say(&socket, &phone, listen(json!({})));
    helper.emit(json!({"event": "partial", "text": "hello there"}));
    let page = Socket::new();
    say(&socket, &page, json!({"op": "listen"}));
    let last = phone.last();
    assert_eq!(last["event"], "final");
    assert_eq!(last["session"], 1);
    assert_eq!(last["text"], "hello there");
    assert_eq!(last["cleaned"], false);
    assert_eq!(page.sent()[0]["event"], "listening");
    assert_eq!(page.sent()[0]["session"], 2);
}

#[tokio::test]
async fn stop_cancels_nothing_is_typed() {
    let Dictating { helper, socket, .. } = dictating(Some(FakeDictation::new()));
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({})));
    helper.emit(json!({"event": "partial", "text": "hello"}));
    say(&socket, &ws, json!({"op": "stop"}));
    assert_eq!(helper.calls(), ["stop"]);
    helper.emit(json!({"event": "final", "text": "hello"}));
    settle().await;
    assert_eq!(finals(&ws), 0);
}

#[tokio::test]
async fn the_debug_log_has_timings_and_sizes_never_the_words() {
    let (debug, logged) = lines();
    let Dictating { helper, socket, .. } = dictating_with(Some(FakeDictation::new()), |options| {
        options.debug = Some(debug);
    });
    let ws = Socket::new();
    say(&socket, &ws, listen(json!({"before": "private thread"})));
    helper.emit(json!({"event": "partial", "text": "secret words"}));
    say(&socket, &ws, json!({"op": "finish"}));
    helper.emit(json!({"event": "final", "text": "secret words"}));
    settle().await;
    let logged = lock(&logged).join("\n");
    assert!(logged.contains("dictation 1"), "{logged}");
    assert!(!logged.contains("secret"));
    assert!(!logged.contains("private"));
}
