//! call-audio.test.ts, a stuck speaker: the helper's speak watch, its
//! pings and restarts, and the calls it makes again. Time on the test
//! clock; the helpers are faked here, each told apart by its number.

use roamgate_base::log::Logger;
use roamgate_protocol::frames::{self, FrameError, FrameReader};
use serde_json::json;
use tokio::sync::{mpsc, watch};

use super::call::background;
use super::*;
use crate::config::VoiceConfig;
use crate::config::tests::config;
use crate::helper::tests::source;
use crate::helper::{
    FrameItem, HelperProcess, PING_MS, SPEAK_COLD_MS, SPEAK_STUCK_MS, Spawn, Spawned, VoiceHelper,
};

fn qwen_and_kokoro() -> VoiceConfig {
    config(json!({"tts_models": [
        {"model": "qwen3-tts", "path": "/models/qwen"},
        {"model": "kokoro", "path": "/models/kokoro"},
    ]}))
}

type Answers = Arc<dyn Fn(usize, &Map<String, Value>) -> bool + Send + Sync>;
type Refuses = Arc<dyn Fn(usize) -> bool + Send + Sync>;

#[derive(Default)]
struct Made {
    spawned: usize,
    killed: usize,
    requests: Vec<Value>,
    /// The newest helper's output is not read: nothing, pings included.
    deaf: bool,
    /// Holds the newest helper's call_start answers until let go.
    hold_starts: bool,
    held: Vec<Value>,
    outs: Vec<Option<mpsc::UnboundedSender<FrameItem>>>,
    exits: Vec<watch::Sender<bool>>,
}

/// Helpers that answer `speak` only when `answers(helper, request)`, and
/// `call_start` unless `refuses(helper)`; pings while not deaf.
#[derive(Clone)]
struct Helpers {
    made: Arc<Mutex<Made>>,
    answers: Answers,
    refuses: Refuses,
}

struct Process {
    number: usize,
    helpers: Helpers,
    reader: Mutex<FrameReader>,
}

impl Helpers {
    fn new(answers: impl Fn(usize, &Map<String, Value>) -> bool + Send + Sync + 'static) -> Self {
        Self::refusing(answers, |_| false)
    }

    fn refusing(
        answers: impl Fn(usize, &Map<String, Value>) -> bool + Send + Sync + 'static,
        refuses: impl Fn(usize) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            made: Arc::default(),
            answers: Arc::new(answers),
            refuses: Arc::new(refuses),
        }
    }

    fn spawn(&self) -> Spawn {
        let helpers = self.clone();
        Arc::new(move |_config: &VoiceConfig| {
            let (out, frames) = mpsc::unbounded_channel();
            let (exit, exited) = watch::channel(false);
            let number = {
                let mut made = lock(&helpers.made);
                made.spawned += 1;
                made.deaf = false;
                made.outs.push(Some(out));
                made.exits.push(exit);
                made.spawned
            };
            Ok(Spawned {
                process: Arc::new(Process {
                    number,
                    helpers: helpers.clone(),
                    reader: Mutex::default(),
                }),
                frames,
                exited,
            })
        })
    }

    fn spawned(&self) -> usize {
        lock(&self.made).spawned
    }

    fn killed(&self) -> usize {
        lock(&self.made).killed
    }

    fn requests(&self) -> Vec<Value> {
        lock(&self.made).requests.clone()
    }

    fn set_deaf(&self) {
        lock(&self.made).deaf = true;
    }

    fn hold_starts(&self) {
        lock(&self.made).hold_starts = true;
    }

    /// Helper `number` says `message`, unless it is the newest and deaf.
    fn reply(&self, number: usize, message: Value) {
        let made = lock(&self.made);
        if made.deaf && number == made.spawned {
            return;
        }
        if let Some(Some(out)) = made.outs.get(number - 1) {
            let _ = out.send(Ok((frames::JSON, js::stringify(&message).into_bytes())));
        }
    }

    /// The newest helper says `message` (its progress).
    fn say(&self, message: Value) {
        let newest = self.spawned();
        self.reply(newest, message);
    }

    /// The newest helper writes these bytes on its output as they are.
    fn raw(&self, bytes: &[u8]) {
        let mut reader = FrameReader::default();
        let read = reader.push(bytes);
        let made = lock(&self.made);
        if let Some(Some(out)) = made.outs.last() {
            for frame in read {
                let _ = out.send(Ok(frame));
            }
            if let Some(error) = reader.error.take() {
                let _ = out.send(Err::<(u8, Vec<u8>), FrameError>(error));
            }
        }
    }

    fn let_starts_go(&self) {
        let (number, held) = {
            let mut made = lock(&self.made);
            (made.spawned, std::mem::take(&mut made.held))
        };
        for answer in held {
            self.reply(number, answer);
        }
    }
}

impl HelperProcess for Process {
    fn write(&self, bytes: Vec<u8>) {
        let read = lock(&self.reader).push(&bytes);
        for (kind, payload) in read {
            if kind != frames::JSON {
                continue;
            }
            let request: Map<String, Value> = serde_json::from_slice(&payload).unwrap();
            lock(&self.helpers.made)
                .requests
                .push(Value::Object(request.clone()));
            let id = request.get("id").cloned().unwrap_or(Value::Null);
            let number = self.number;
            match request["op"].as_str().unwrap_or("") {
                "ping" => self.helpers.reply(number, json!({"id": id, "ok": true})),
                "call_start" => {
                    let answer = if (self.helpers.refuses)(number) {
                        json!({"id": id, "error": "the call did not start"})
                    } else {
                        json!({
                            "id": id, "ok": true, "music": true,
                            "signalling_port": 41000 + number,
                        })
                    };
                    let mut made = lock(&self.helpers.made);
                    if made.hold_starts {
                        made.held.push(answer);
                    } else {
                        drop(made);
                        self.helpers.reply(number, answer);
                    }
                }
                "call_music" => self.helpers.reply(
                    number,
                    json!({
                        "id": id, "ok": true, "volume": 0.6,
                        "muted": request.get("muted") == Some(&json!(true)),
                    }),
                ),
                "speak" if (self.helpers.answers)(number, &request) => {
                    let answer = if request.contains_key("call") {
                        json!({
                            "id": id, "queued": true, "start_ms": 100, "duration_ms": 900,
                            "language": "en",
                        })
                    } else {
                        json!({"id": id, "audio": "", "language": "en"})
                    };
                    self.helpers.reply(number, answer);
                }
                _ => {}
            }
        }
    }

    fn kill(&self) {
        let mut made = lock(&self.helpers.made);
        made.killed += 1;
        made.outs[self.number - 1] = None;
        let _ = made.exits[self.number - 1].send(true);
    }
}

fn speaks(helpers: &Helpers) -> Vec<Value> {
    helpers
        .requests()
        .into_iter()
        .filter(|request| request["op"] == "speak")
        .collect()
}

struct Setup {
    clock: Arc<TestClock>,
    helper: VoiceHelper,
    logged: Arc<Mutex<Vec<String>>>,
}

fn setup(helpers: &Helpers, voice: VoiceConfig) -> Setup {
    let clock = clock();
    let (sink, logged) = lines();
    let helper = VoiceHelper::with(
        source(voice),
        helpers.spawn(),
        clock.clone(),
        Logger::silent(),
    )
    .with_errors(sink);
    Setup {
        clock,
        helper,
        logged,
    }
}

fn collector() -> (EventSink, Arc<Mutex<Vec<Value>>>) {
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let kept = heard.clone();
    (
        Arc::new(move |event| lock(&kept).push(Value::Object(event))),
        heard,
    )
}

/// The helper's frame that is not one: a log line on its output.
const LOG_LINE: &[u8] = b"\x1b[2m2026-11-07T03:44:05.099012Z\x1b[0m \x1b[33m WARN\x1b[0m any_tts::models::kokoro::style_encoder: Style encoder weights not found (voice cloning unavailable)\n";

#[tokio::test]
async fn a_stuck_sentence_is_said_again_with_kokoro_by_a_new_helper() {
    // The first helper never speaks; the second does.
    let helpers = Helpers::new(|spawned, _| spawned > 1);
    let Setup { clock, helper, .. } = setup(&helpers, qwen_and_kokoro());
    let said = {
        let helper = helper.clone();
        tokio::spawn(async move { helper.speak("Hello", None, None, None).await })
    };
    settle().await;
    // Its first sentence may load the model.
    clock.advance(SPEAK_COLD_MS - 1).await;
    settle().await;
    assert_eq!(helpers.killed(), 0);
    clock.advance(1).await;
    // It answers a ping: its speaker is what is stuck.
    settle().await;
    assert!(
        helpers
            .requests()
            .iter()
            .any(|request| request["op"] == "ping")
    );
    assert_eq!(helpers.killed(), 1);
    settle().await;
    assert!(said.await.unwrap().is_ok());
    assert_eq!(helpers.spawned(), 2);
    let again = speaks(&helpers).last().unwrap()["tts_models"].to_string();
    assert!(
        again.contains("kokoro") && !again.contains("qwen"),
        "{again}"
    );
    // Kokoro reads the next ones too, for a while.
    helper.speak("Next", None, None, None).await.unwrap();
    let next = speaks(&helpers).last().unwrap()["tts_models"].to_string();
    assert!(next.contains("kokoro"), "{next}");
    helper.stop();
}

#[tokio::test]
async fn once_it_spoke_a_sentence_may_take_8_s() {
    // Answers the first sentence only.
    let answered = Arc::new(AtomicUsize::new(0));
    let counted = answered.clone();
    let helpers = Helpers::new(move |_, _| counted.fetch_add(1, Ordering::SeqCst) == 0);
    let Setup { clock, helper, .. } = setup(&helpers, config(json!({})));
    helper.speak("First", None, None, None).await.unwrap();
    let stuck = {
        let helper = helper.clone();
        tokio::spawn(async move { helper.speak("Second", None, None, None).await })
    };
    settle().await;
    clock.advance(SPEAK_STUCK_MS - 1).await;
    settle().await;
    assert_eq!(helpers.killed(), 0);
    clock.advance(1).await;
    settle().await;
    assert_eq!(helpers.killed(), 1);
    // No Kokoro in voice.json: it fails, the next one starts a helper.
    let error = stuck.await.unwrap().unwrap_err();
    assert!(error.contains("The voice helper stopped"), "{error}");
    helper.stop();
}

#[tokio::test]
async fn a_calls_first_sentence_may_load_its_model_even_after_one_outside_it() {
    // Speaks outside calls; never into one.
    let helpers = Helpers::new(|_, request| !request.contains_key("call"));
    let Setup { clock, helper, .. } = setup(&helpers, qwen_and_kokoro());
    helper.speak("Outside", None, None, None).await.unwrap();
    let handle = helper
        .start_call(background(), Arc::new(|_| {}))
        .await
        .unwrap();
    let inside = {
        let helper = helper.clone();
        tokio::spawn(async move {
            let _ = helper
                .speak_in_call(handle.id, "Inside", None, None, None)
                .await;
        })
    };
    settle().await;
    clock.advance(SPEAK_STUCK_MS).await;
    settle().await;
    assert_eq!(helpers.killed(), 0);
    clock.advance(SPEAK_COLD_MS - SPEAK_STUCK_MS).await;
    settle().await;
    assert_eq!(helpers.killed(), 1);
    helper.stop();
    inside.abort();
}

#[tokio::test]
async fn a_restart_during_a_call_makes_it_again_with_its_new_signalling_and_says_the_reply_there_with_kokoro()
 {
    // The first helper never speaks; the second does.
    let helpers = Helpers::new(|spawned, _| spawned > 1);
    let Setup { clock, helper, .. } = setup(&helpers, qwen_and_kokoro());
    let (sink, events) = collector();
    let handle = helper.start_call(background(), sink).await.unwrap();
    // The user put the music on: the call is made again with it on.
    handle
        .music_level(MusicChange {
            volume: None,
            muted: Some(false),
        })
        .await
        .unwrap();
    let said = {
        let helper = helper.clone();
        let id = handle.id;
        tokio::spawn(async move {
            helper
                .speak_in_call(id, "Yes, I'm here", None, None, None)
                .await
        })
    };
    settle().await;
    clock.advance(SPEAK_COLD_MS).await;
    for _ in 0..5 {
        settle().await;
    }
    let queued = said.await.unwrap().unwrap();
    assert_eq!(queued.start_ms, 100.0);
    assert_eq!(
        *lock(&events),
        [json!({"event": "call_restarted", "call": handle.id})]
    );
    // Its new signalling server, in the new helper.
    assert_eq!(handle.signalling_port(), 41002);
    // In the new helper: the call first, under its number, then the
    // sentence into it, with Kokoro.
    let all = helpers.requests();
    let ping = all
        .iter()
        .position(|request| request["op"] == "ping")
        .unwrap();
    let second = &all[ping + 1..];
    let ops: Vec<&Value> = second.iter().map(|request| &request["op"]).collect();
    assert_eq!(ops, [&json!("call_start"), &json!("speak")]);
    assert_eq!(second[0]["call"], handle.id);
    assert_eq!(second[0]["muted"], false);
    assert_eq!(second[1]["call"], handle.id);
    assert!(second[1]["tts_models"].to_string().contains("kokoro"));
    helper.stop();
}

#[tokio::test]
async fn a_helper_writing_something_not_a_frame_is_restarted_at_once_and_says_what_it_wrote() {
    let helpers = Helpers::new(|_, _| true);
    let Setup { helper, logged, .. } = setup(&helpers, qwen_and_kokoro());
    let (sink, events) = collector();
    let handle = helper.start_call(background(), sink).await.unwrap();
    helpers.raw(LOG_LINE);
    settle().await;
    assert_eq!(helpers.killed(), 1);
    assert_eq!(helpers.spawned(), 2);
    // Made again at once, in the new helper.
    assert_eq!(
        *lock(&events),
        [json!({"event": "call_restarted", "call": handle.id})]
    );
    let last = helpers.requests().last().cloned().unwrap();
    assert_eq!(last["op"], "call_start");
    assert_eq!(last["call"], handle.id);
    helper.stop();
    let log = lock(&logged).join("\n");
    assert!(log.contains("not frames"), "{log}");
    assert!(
        log.contains("any_tts::models::kokoro::style_encoder"),
        "{log}"
    );
    assert!(!log.contains("made no speech"), "{log}");
}

#[tokio::test]
async fn a_deaf_helper_is_told_from_a_stuck_speaker_restarted_its_sentence_said_again_as_it_was() {
    // Speaks only once restarted.
    let helpers = Helpers::new(|spawned, _| spawned > 1);
    let Setup {
        clock,
        helper,
        logged,
    } = setup(&helpers, qwen_and_kokoro());
    helper.set_sample_hangs(false);
    let said = {
        let helper = helper.clone();
        tokio::spawn(async move { helper.speak("Hello", None, None, None).await })
    };
    settle().await;
    // Its output is lost from here: not even a ping comes back.
    helpers.set_deaf();
    clock.advance(SPEAK_COLD_MS).await;
    settle().await;
    assert_eq!(helpers.killed(), 0);
    clock.advance(PING_MS).await;
    settle().await;
    assert_eq!(helpers.killed(), 1);
    settle().await;
    assert!(said.await.unwrap().is_ok());
    assert_eq!(helpers.spawned(), 2);
    // Said again as it was, with Qwen3-TTS: nothing was stuck.
    assert!(speaks(&helpers).last().unwrap().get("tts_models").is_none());
    helper.stop();
    let log = lock(&logged).join("\n");
    assert!(log.contains("answered no ping"), "{log}");
    assert!(log.contains("unreadable"), "{log}");
    assert!(!log.contains("made no speech"), "{log}");
}

#[tokio::test]
async fn a_call_whose_start_was_never_answered_is_not_made_again_after_a_restart_a_failed_re_make_ends_the_call()
 {
    // Its call_start never answered when the helper goes.
    let pending = Helpers::new(|_, _| true);
    let first = setup(&pending, config(json!({}))).helper;
    let (sink, told) = collector();
    pending.hold_starts();
    let starting = {
        let first = first.clone();
        tokio::spawn(async move { first.start_call(background(), sink).await })
    };
    settle().await;
    pending.raw(LOG_LINE);
    settle().await;
    let error = starting.await.unwrap().err().unwrap();
    assert!(error.contains("The voice helper stopped"), "{error}");
    // No helper is started for it, nor told to make it.
    assert_eq!(pending.spawned(), 1);
    assert!(lock(&told).is_empty());

    // Answered, then the restarted helper cannot make it again: it ends.
    let refused = Helpers::refusing(|_, _| true, |spawned| spawned > 1);
    let second = setup(&refused, config(json!({}))).helper;
    let (sink, ended) = collector();
    let handle = second.start_call(background(), sink).await.unwrap();
    refused.raw(LOG_LINE);
    settle().await;
    assert_eq!(
        *lock(&ended),
        [json!({
            "event": "call_ended", "call": handle.id,
            "error": "The voice helper stopped: the call did not start",
        })]
    );
    assert_eq!(handle.signalling_port(), 0);

    // Stopped while it was made again: not left in the new helper.
    let late = Helpers::new(|_, _| true);
    let third = setup(&late, config(json!({}))).helper;
    let (sink, heard) = collector();
    let going = third.start_call(background(), sink).await.unwrap();
    late.hold_starts();
    late.raw(LOG_LINE);
    settle().await;
    going.stop();
    late.let_starts_go();
    settle().await;
    assert!(lock(&heard).is_empty());
    let last = late.requests().last().cloned().unwrap();
    assert_eq!(last["op"], "call_stop");
    assert_eq!(last["call"], going.id);
    first.stop();
    second.stop();
    third.stop();
}

#[tokio::test]
async fn stopped_on_purpose_its_calls_end() {
    let helpers = Helpers::new(|_, _| true);
    let helper = setup(&helpers, config(json!({}))).helper;
    let (sink, events) = collector();
    let handle = helper.start_call(background(), sink).await.unwrap();
    helper.stop();
    settle().await;
    assert_eq!(
        *lock(&events),
        [json!({"event": "call_ended", "call": handle.id, "error": "The voice helper stopped"})]
    );
}

#[tokio::test]
async fn with_progress_a_sentence_may_go_15_s_without_any_45_s_while_a_model_loads() {
    let helpers = Helpers::new(|_, _| false);
    let Setup { clock, helper, .. } = setup(&helpers, qwen_and_kokoro());
    helper.set_sample_hangs(false);
    let said = {
        let helper = helper.clone();
        tokio::spawn(async move { helper.speak("Hello", None, None, None).await })
    };
    settle().await;
    let id = speaks(&helpers)[0]["id"].clone();
    helpers.say(json!({"event": "speak_progress", "stage": "ready"}));
    helpers.say(json!({"event": "speak_progress", "id": id, "stage": "started"}));
    settle().await;
    // Audio comes: the watch starts again from it.
    clock.advance(SPEAK_STUCK_MS - 1000).await;
    helpers.say(json!({"event": "speak_progress", "id": id, "stage": "audio"}));
    settle().await;
    clock.advance(SPEAK_STUCK_MS - 1000).await;
    assert_eq!(helpers.killed(), 0);
    // A voice loading: longer.
    helpers.say(json!({"event": "speak_progress", "id": id, "stage": "loading"}));
    settle().await;
    clock.advance(SPEAK_COLD_MS - 1000).await;
    assert_eq!(helpers.killed(), 0);
    helpers.say(json!({"event": "speak_progress", "id": id, "stage": "audio"}));
    settle().await;
    clock.advance(SPEAK_STUCK_MS).await;
    settle().await;
    assert_eq!(helpers.killed(), 1);
    helper.stop();
    let _ = said.await;
}
