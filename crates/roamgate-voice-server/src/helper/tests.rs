use std::sync::atomic::{AtomicBool, Ordering};

use roamgate_base::clock::TestClock;
use serde_json::json;

use super::*;
use crate::config::tests::config;
use crate::profiles::{VoiceProfiles, VoiceRole};
use crate::testdata::{near, person};

type Answer = Arc<dyn Fn(&Map<String, Value>) -> Vec<Value> + Send + Sync>;

/// A helper answering each JSON request with `answer`'s replies until
/// `exit()`, keeping every frame it is sent (voice-helper.test.ts
/// fakeHelper).
pub(crate) struct FakeChild {
    pub frames: Mutex<Vec<(u8, Vec<u8>)>>,
    out: Mutex<Option<mpsc::UnboundedSender<FrameItem>>>,
    reader: Mutex<FrameReader>,
    output: Mutex<FrameReader>,
    exit: watch::Sender<bool>,
    killed: AtomicBool,
    answer: Answer,
}

impl FakeChild {
    pub fn say(&self, message: Value) {
        self.raw(&frames::encode(
            frames::JSON,
            js::stringify(&message).as_bytes(),
        ));
    }

    pub fn raw(&self, bytes: &[u8]) {
        let mut output = lock(&self.output);
        let frames = output.push(bytes);
        let error = output.error.clone();
        drop(output);
        let out = lock(&self.out);
        if let Some(out) = out.as_ref() {
            for frame in frames {
                let _ = out.send(Ok(frame));
            }
            if let Some(error) = error {
                let _ = out.send(Err(error));
            }
        }
    }

    pub fn exit(&self) {
        lock(&self.out).take();
        let _ = self.exit.send(true);
    }

    pub fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    pub fn requests(&self) -> Vec<Value> {
        requests(&lock(&self.frames))
    }
}

pub(crate) fn requests(frames: &[(u8, Vec<u8>)]) -> Vec<Value> {
    frames
        .iter()
        .filter(|(kind, _)| *kind == frames::JSON)
        .map(|(_, payload)| serde_json::from_slice(payload).unwrap())
        .collect()
}

struct FakeProcess(Arc<FakeChild>);

impl HelperProcess for FakeProcess {
    fn write(&self, bytes: Vec<u8>) {
        let frames = lock(&self.0.reader).push(&bytes);
        for frame in frames {
            lock(&self.0.frames).push(frame.clone());
            if frame.0 != frames::JSON {
                continue;
            }
            let request: Value = serde_json::from_slice(&frame.1).unwrap();
            for reply in (self.0.answer)(request.as_object().unwrap()) {
                self.0.say(reply);
            }
        }
    }

    fn kill(&self) {
        self.0.killed.store(true, Ordering::SeqCst);
        self.0.exit();
    }
}

#[derive(Clone)]
pub(crate) struct Fake {
    pub spawned: Arc<Mutex<Vec<Arc<FakeChild>>>>,
    answer: Answer,
}

impl Fake {
    pub fn new(answer: impl Fn(&Map<String, Value>) -> Vec<Value> + Send + Sync + 'static) -> Self {
        Self {
            spawned: Arc::default(),
            answer: Arc::new(answer),
        }
    }

    pub fn silent() -> Self {
        Self::new(|_| Vec::new())
    }

    pub fn spawn(&self) -> Spawn {
        let fake = self.clone();
        Arc::new(move |_config: &VoiceConfig| {
            let (out, frames) = mpsc::unbounded_channel();
            let (exit, exited) = watch::channel(false);
            let child = Arc::new(FakeChild {
                frames: Mutex::default(),
                out: Mutex::new(Some(out)),
                reader: Mutex::default(),
                output: Mutex::default(),
                exit,
                killed: AtomicBool::new(false),
                answer: fake.answer.clone(),
            });
            lock(&fake.spawned).push(child.clone());
            Ok(Spawned {
                process: Arc::new(FakeProcess(child)),
                frames,
                exited,
            })
        })
    }

    pub fn child(&self, index: usize) -> Arc<FakeChild> {
        lock(&self.spawned)[index].clone()
    }

    pub fn count(&self) -> usize {
        lock(&self.spawned).len()
    }
}

pub(crate) fn source(config: VoiceConfig) -> ConfigSource {
    Arc::new(move || Ok(config.clone()))
}

fn errors() -> (ErrorSink, Arc<Mutex<Vec<String>>>) {
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = lines.clone();
    (
        Arc::new(move |line: &str| lock(&kept).push(line.to_owned())),
        lines,
    )
}

fn joined(lines: &Arc<Mutex<Vec<String>>>) -> String {
    lock(lines).join("\n")
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
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

fn ogg() -> String {
    base64::engine::general_purpose::STANDARD.encode("ogg")
}

fn speak_answer(
    language: &'static str,
) -> impl Fn(&Map<String, Value>) -> Vec<Value> + Send + Sync {
    move |request| {
        if request["op"] == "speak" {
            vec![json!({"id": request["id"], "audio": "", "language": language})]
        } else {
            vec![]
        }
    }
}

fn call_background() -> CallBackground {
    CallBackground {
        background: String::new(),
        volume: 0.6,
        ducked: 0.15,
        release_ms: 3000.0,
        muted: true,
        reply_loudness: Some(-16.0),
    }
}

fn models(value: Value) -> Option<Vec<TtsModel>> {
    Some(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|each| each.as_object().unwrap().clone())
            .collect(),
    )
}

#[test]
fn framereader_rejects_what_is_not_a_frame_and_still_parses_split_frames() {
    let valid = frames::encode(frames::JSON, br#"{"ok":true}"#);
    let mut pieces = FrameReader::default();
    let parsed: Vec<(u8, Vec<u8>)> = valid
        .iter()
        .flat_map(|byte| pieces.push(&[*byte]))
        .collect();
    assert_eq!(
        parsed.iter().map(|frame| frame.0).collect::<Vec<_>>(),
        vec![frames::JSON]
    );
    assert!(pieces.error.is_none());
    let line = b"\x1b[2m2026-11-07T03:53:24Z\x1b[0m WARN any_tts::models::kokoro::style_encoder: Style encoder weights not found\n";
    let mut reader = FrameReader::default();
    let frames_read = reader.push(&[valid.clone(), line.to_vec()].concat());
    assert_eq!(frames_read.len(), 1);
    let error = reader.error.clone().unwrap();
    assert!(error.bytes.starts_with("\\x1b[2m2026-11-07T03:53:24Z"));
    assert!(error.bytes.contains("any_tts::models::kokoro"));
    assert!(reader.push(&valid).is_empty());
    let length = |value: u32, kind: u8| {
        let mut bytes = value.to_le_bytes().to_vec();
        bytes.push(kind);
        bytes.push(0);
        bytes
    };
    for bad in [
        length(frames::MAX_FRAME as u32 + 1, 0),
        length(0, 0),
        length(2, 9),
    ] {
        let mut broken = FrameReader::default();
        assert!(broken.push(&bad).is_empty());
        assert!(broken.error.is_some());
    }
    assert_eq!(
        frames::escape_bytes(&[0x41, 0x0a, 0x5c], 200),
        "A\\x0a\\x5c"
    );
    assert_eq!(
        frames::escape_bytes(&[0x41; 300], 200),
        format!("{}...", "A".repeat(200))
    );
}

#[test]
fn a_large_frame_in_many_chunks_is_read_once_whole() {
    let payload = vec![7u8; 1024 * 1024];
    let frame = frames::encode(frames::AUDIO, &payload);
    let mut reader = FrameReader::default();
    let mut read = Vec::new();
    for chunk in frame.chunks(4096) {
        read.extend(reader.push(chunk));
    }
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].1.len(), payload.len());
    assert!(read[0].1.iter().all(|byte| *byte == 7));
}

#[test]
fn frames_survive_arriving_in_pieces() {
    let stream = [
        frames::encode(frames::JSON, br#"{"a":1}"#),
        frames::encode(frames::AUDIO, &[1, 2, 3]),
    ]
    .concat();
    let mut reader = FrameReader::default();
    let mut read = reader.push(&stream[..3]);
    read.extend(reader.push(&stream[3..15]));
    read.extend(reader.push(&stream[15..]));
    assert_eq!(
        read.iter().map(|frame| frame.0).collect::<Vec<_>>(),
        vec![frames::JSON, frames::AUDIO]
    );
    assert_eq!(read[1].1, vec![1, 2, 3]);
}

#[tokio::test]
async fn speaks_and_starts_the_helper_once() {
    let fake = Fake::new(|request| {
        if request["op"] == "speak" {
            vec![json!({"id": request["id"], "audio": ogg(), "language": "fr"})]
        } else {
            vec![]
        }
    });
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let speech = helper.speak("Bonjour.", None, None, None).await.unwrap();
    assert_eq!(speech.audio, b"ogg");
    assert_eq!(speech.language, "fr");
    assert_eq!(speech.native_rate, 1.0);
    helper.speak("Encore.", None, None, None).await.unwrap();
    assert_eq!(fake.count(), 1);
}

#[tokio::test]
async fn asks_the_helper_s_tempo_for_the_rate_the_model_does_not_make() {
    let fake = Fake::new(|request| {
        if request["op"] != "speak" {
            return vec![];
        }
        let mut reply = json!({"id": request["id"], "audio": ogg(), "language": "en"});
        if request["text"] != "Old." {
            reply["rate"] = request.get("rate").cloned().unwrap_or(json!(1));
        }
        vec![reply]
    });
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    assert_eq!(
        helper
            .speak("Fast.", Some("en"), None, Some(1.5))
            .await
            .unwrap()
            .native_rate,
        1.5
    );
    assert_eq!(
        helper
            .speak("Plain.", Some("en"), None, Some(1.0))
            .await
            .unwrap()
            .native_rate,
        1.0
    );
    assert_eq!(
        helper
            .speak("Old.", Some("en"), None, Some(1.5))
            .await
            .unwrap()
            .native_rate,
        1.0
    );
    let asked = fake.child(0).requests();
    assert_eq!(
        asked
            .iter()
            .map(|request| request.get("rate").cloned())
            .collect::<Vec<_>>(),
        vec![Some(json!(1.5)), None, Some(json!(1.5))]
    );
    let kokoro = VoiceHelper::new(
        source(config(
            json!({"speech_rate": 1.5, "tts_models": [{"model": "kokoro", "path": "/k"}]}),
        )),
        fake.spawn(),
    );
    assert_eq!(
        kokoro
            .speak("Hi.", Some("en"), None, Some(1.5))
            .await
            .unwrap()
            .native_rate,
        1.5
    );
    assert!(fake.child(1).requests()[0].get("rate").is_none());
}

#[tokio::test]
async fn a_session_s_audio_and_events_stay_its_own() {
    let fake = Fake::silent();
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let (sink, heard) = collector();
    let session = helper
        .listen(
            sink,
            ListenOptions {
                hold: true,
                language: Some("es".into()),
                ..Default::default()
            },
        )
        .unwrap();
    session.audio(&[9, 9]);
    let child = fake.child(0);
    assert_eq!(
        child.requests()[0],
        json!({"op": "listen_start", "session": session.id, "hold": true, "language": "es"})
    );
    let audio = lock(&child.frames)
        .iter()
        .find(|frame| frame.0 == frames::AUDIO)
        .cloned()
        .unwrap();
    assert_eq!(
        u32::from_le_bytes(audio.1[..4].try_into().unwrap()) as u64,
        session.id
    );
    assert_eq!(audio.1[4..].to_vec(), vec![9, 9]);
    child.say(json!({"event": "final", "session": session.id, "text": "hola"}));
    child.say(json!({"event": "final", "session": session.id + 1, "text": "other"}));
    settle().await;
    assert_eq!(
        *lock(&heard),
        vec![json!({"event": "final", "session": session.id, "text": "hola"})]
    );
    session.stop();
    assert_eq!(
        child.requests().last().unwrap(),
        &json!({"op": "listen_stop", "session": session.id})
    );
}

#[tokio::test]
async fn finals_say_whose_voice_they_are_and_the_helper_is_told_the_user_s() {
    let fake = Fake::silent();
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let (sink, heard) = collector();
    let first = helper
        .listen(
            sink,
            ListenOptions {
                new_speaker: true,
                ..Default::default()
            },
        )
        .unwrap();
    let child = fake.child(0);
    let voice = json!({
        "voices": 1763550000000u64,
        "id": "B",
        "share": 0.9,
        "mixed": false,
        "mix": [{"id": "B", "share": 0.9}],
        "similarity": {"A": 0.05, "B": 0.61, "<b>": 9},
        "seconds": 2.2,
    });
    child.say(json!({"event": "final", "session": first.id, "text": "Salut", "voice": voice}));
    child.say(json!({"event": "final", "session": first.id, "text": "?", "voice": "B"}));
    settle().await;
    let heard = lock(&heard).clone();
    assert_eq!(
        heard[0]["voice"],
        json!({
            "voices": 1763550000000u64,
            "id": "B",
            "share": 0.9,
            "mixed": false,
            "mix": [{"id": "B", "share": 0.9}],
            "similarity": {"A": 0.05, "B": 0.61},
            "seconds": 2.2,
        })
    );
    assert!(heard[1].get("voice").is_none());
    let mut tag = parse_voice_tag(&heard[0]["voice"]).unwrap();
    assert_eq!(helper.speakers().label(Some(&tag)), "voice B");
    helper.speakers().learn(Some(&mut tag), "self", None);
    let next = helper
        .listen(Arc::new(|_| {}), ListenOptions::default())
        .unwrap();
    assert_eq!(
        child.requests().last().unwrap(),
        &json!({"op": "listen_start", "session": next.id, "hold": false, "user_voice": {"voices": 1763550000000u64, "id": "B"}})
    );
    let call = helper
        .listen(
            Arc::new(|_| {}),
            ListenOptions {
                new_speaker: true,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        child.requests().last().unwrap(),
        &json!({"op": "listen_start", "session": call.id, "hold": false, "new_speaker": true})
    );
}

#[tokio::test]
async fn finals_prints_stay_on_the_server_a_new_call_is_told_the_user_s_kept_prints() {
    let root = tempfile::tempdir().unwrap();
    let mut library = VoiceProfiles::new(root.path().join("voice-profiles"));
    let me = library.create(Some("Thibault"), VoiceRole::User);
    library.learn(&me, 1.0, person(0), 30.0);
    let fake = Fake::silent();
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    helper.speakers().use_library(Some(library));
    let (sink, heard) = collector();
    let call = helper
        .listen(
            sink,
            ListenOptions {
                new_speaker: true,
                ..Default::default()
            },
        )
        .unwrap();
    let child = fake.child(0);
    let start = child.requests().last().unwrap().clone();
    assert!(start["user_voice"].get("id").is_none());
    assert_eq!(start["user_voice"]["prints"].as_array().unwrap().len(), 1);
    let print = near(&person(0), 0.02, 1);
    child.say(json!({
        "event": "final",
        "session": call.id,
        "text": "Salut",
        "voice": {
            "voices": 9,
            "id": "A",
            "share": 1,
            "mixed": false,
            "mix": [{"id": "A", "share": 1}],
            "similarity": {"A": 0.7},
            "seconds": 4,
            "print": print,
            "prints": {"A": print},
        },
    }));
    settle().await;
    let voice = lock(&heard)[0]["voice"].clone();
    assert!(voice.get("print").is_none() && voice.get("prints").is_none());
    assert_eq!(voice["utterance"], json!(1));
    let tag = parse_voice_tag(&voice).unwrap();
    assert_eq!(helper.speakers().label(Some(&tag)), "Thibault (you) 0.70");
    let next = helper
        .listen(Arc::new(|_| {}), ListenOptions::default())
        .unwrap();
    let last = child.requests().last().unwrap().clone();
    assert_eq!(last["session"], json!(next.id));
    assert_eq!(last["user_voice"]["voices"], json!(9));
    assert_eq!(last["user_voice"]["id"], json!("A"));
    assert!(last["user_voice"]["prints"].is_array());
}

#[tokio::test]
async fn a_helper_that_stops_ends_each_session_on_its_own_and_starts_again() {
    let fake = Fake::silent();
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let (first_sink, first) = collector();
    let (second_sink, second) = collector();
    let one = helper.listen(first_sink, ListenOptions::default()).unwrap();
    let two = helper
        .listen(second_sink, ListenOptions::default())
        .unwrap();
    fake.child(0).exit();
    settle().await;
    let stopped = |id: u64| json!({"event": "error", "session": id, "error": HELPER_STOPPED, "recoverable": true});
    assert_eq!(*lock(&first), vec![stopped(one.id)]);
    assert_eq!(*lock(&second), vec![stopped(two.id)]);
    one.finish();
    one.release();
    one.audio(&[1, 2]);
    one.stop();
    assert_eq!(fake.count(), 1);
    let three = helper
        .listen(Arc::new(|_| {}), ListenOptions::default())
        .unwrap();
    assert_eq!(fake.count(), 2);
    assert_eq!(
        fake.child(1).requests(),
        vec![json!({"op": "listen_start", "session": three.id, "hold": false})]
    );
}

#[tokio::test]
async fn a_helper_writing_something_not_a_frame_is_stopped_saying_what_it_wrote() {
    let (sink_errors, lines) = errors();
    let fake = Fake::silent();
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn()).with_errors(sink_errors);
    let (sink, heard) = collector();
    let session = helper.listen(sink, ListenOptions::default()).unwrap();
    let child = fake.child(0);
    child.say(json!({"event": "speech_start", "session": session.id}));
    child.raw(b"\x1b[2m2026-11-07T03:44:05Z\x1b[0m WARN any_tts::models::kokoro::style_encoder: Style encoder weights not found\n");
    settle().await;
    assert!(child.killed());
    assert!(joined(&lines).contains("not frames"));
    assert!(joined(&lines).contains("any_tts::models::kokoro"));
    assert_eq!(
        *lock(&heard),
        vec![
            json!({"event": "speech_start", "session": session.id}),
            json!({"event": "error", "session": session.id, "error": HELPER_STOPPED, "recoverable": true}),
        ]
    );
}

#[tokio::test]
async fn a_sentence_read_with_its_own_models_and_models_changed_live() {
    let fake = Fake::new(|request| {
        if request["op"] == "speak" {
            vec![json!({"id": request["id"], "audio": "", "language": "en"})]
        } else {
            vec![json!({"id": request["id"], "ok": true})]
        }
    });
    let current = Arc::new(Mutex::new(config(json!({
        "speech_rate": 1.3,
        "tts_models": [{"model": "qwen3-tts", "path": "/base", "voice_embedding": "/v/lea.json"}, {"model": "kokoro", "path": "/k"}],
    }))));
    let read = current.clone();
    let helper = VoiceHelper::new(Arc::new(move || Ok(lock(&read).clone())), fake.spawn());
    helper.apply_tts_models().await.unwrap();
    assert_eq!(fake.count(), 0);
    let kokoro = helper
        .speak(
            "Hi.",
            Some("en"),
            models(json!([{"model": "kokoro", "path": "/k"}])),
            None,
        )
        .await
        .unwrap();
    assert_eq!(kokoro.native_rate, 1.3);
    let child = fake.child(0);
    assert_eq!(
        child.requests()[0],
        json!({
            "op": "speak",
            "text": "Hi.",
            "language": "en",
            "tts_models": js::stringify(&json!([{"model": "kokoro", "path": "/k", "speed": 1.3}])),
            "id": 1,
        })
    );
    assert_eq!(
        helper
            .speak("Hi.", None, None, None)
            .await
            .unwrap()
            .native_rate,
        1.0
    );
    assert!(child.requests()[1].get("tts_models").is_none());
    *lock(&current) =
        config(json!({"speech_rate": 1.3, "tts_models": [{"model": "kokoro", "path": "/k"}]}));
    helper.apply_tts_models().await.unwrap();
    assert_eq!(
        child.requests()[2],
        json!({
            "op": "set_tts_models",
            "tts_models": js::stringify(&json!([{"model": "kokoro", "path": "/k", "speed": 1.3}])),
            "id": 3,
        })
    );
    assert_eq!(
        helper
            .speak("Hi.", None, None, None)
            .await
            .unwrap()
            .native_rate,
        1.3
    );
}

const OOM: &str = "Qwen3Tts speaking \"Oui.\" failed: Compute error: DriverError(CUDA_ERROR_OUT_OF_MEMORY, \"out of memory\")";

fn qwen_and_kokoro(extra: Value) -> VoiceConfig {
    let mut models = vec![
        json!({"model": "qwen3-tts", "path": "/base"}),
        json!({"model": "kokoro", "path": "/k"}),
    ];
    if let Some(more) = extra.as_array() {
        models.extend(more.iter().cloned());
    }
    config(json!({"tts_models": models}))
}

fn kokoro_fr() -> String {
    js::stringify(&json!([{"model": "kokoro", "path": "/k", "voice": "ff_siwis", "speed": 1.2}]))
}

fn models_sent(child: &FakeChild) -> Vec<String> {
    child
        .requests()
        .iter()
        .filter(|request| request["op"] == "speak")
        .map(|request| {
            request
                .get("tts_models")
                .and_then(Value::as_str)
                .unwrap_or("own")
                .to_owned()
        })
        .collect()
}

fn failing_unless_light() -> impl Fn(&Map<String, Value>) -> Vec<Value> + Send + Sync {
    |request| {
        if request["op"] != "speak" {
            vec![]
        } else if request.contains_key("tts_models") {
            vec![json!({"id": request["id"], "audio": "", "language": "fr"})]
        } else {
            vec![json!({"id": request["id"], "error": OOM})]
        }
    }
}

#[tokio::test]
async fn a_sentence_its_speaker_failed_is_said_by_kokoro_in_its_language_and_the_next_ones() {
    let (sink, lines) = errors();
    let fake = Fake::new(failing_unless_light());
    let helper =
        VoiceHelper::new(source(qwen_and_kokoro(json!([]))), fake.spawn()).with_errors(sink);
    helper.speak("Oui.", Some("fr"), None, None).await.unwrap();
    helper.speak("Non.", Some("fr"), None, None).await.unwrap();
    assert_eq!(
        models_sent(&fake.child(0)),
        vec!["own".to_owned(), kokoro_fr(), kokoro_fr()]
    );
    assert!(joined(&lines).contains("a sentence failed (Qwen3Tts speaking"));
    assert!(joined(&lines).contains("Kokoro says it again now, and the next ones for 30 s"));
}

#[tokio::test]
async fn with_pocket_tts_a_failed_sentence_is_said_by_pocket_tts_kokoro_reading_what_it_lacks() {
    let pocket_fr = json!({"model": "pocket-tts", "path": "/p/fr", "languages": "fr"});
    let pocket_en = json!({"model": "pocket-tts", "path": "/p/en", "languages": "en"});
    let (sink, lines) = errors();
    let fake = Fake::new(failing_unless_light());
    let helper = VoiceHelper::new(
        source(qwen_and_kokoro(json!([pocket_fr, pocket_en]))),
        fake.spawn(),
    )
    .with_errors(sink);
    helper.speak("Oui.", Some("fr"), None, None).await.unwrap();
    helper.speak("Sí.", Some("es"), None, None).await.unwrap();
    let failed = helper
        .speak("Ja.", Some("de"), None, None)
        .await
        .unwrap_err();
    assert!(failed.contains("out of memory"));
    let light = |voice: &str| {
        js::stringify(
            &json!([pocket_fr, pocket_en, {"model": "kokoro", "path": "/k", "voice": voice}]),
        )
    };
    assert_eq!(
        models_sent(&fake.child(0)),
        vec![
            "own".to_owned(),
            light("ff_siwis"),
            light("ef_dora"),
            "own".to_owned()
        ]
    );
    assert!(joined(&lines).contains("Pocket TTS says it again now, and the next ones for 30 s"));
}

#[tokio::test]
async fn in_a_call_a_sentence_failed_or_silent_is_said_again_by_kokoro_into_the_call() {
    for failure in ["silent", "error"] {
        let fake = Fake::new(move |request| {
            if request["op"] == "call_start" {
                return vec![json!({"id": request["id"], "signalling_port": 4242})];
            }
            if request["op"] != "speak" {
                return vec![];
            }
            if request.contains_key("tts_models") {
                vec![
                    json!({"id": request["id"], "queued": true, "start_ms": 100, "duration_ms": 900, "now_ms": 50, "language": "fr"}),
                ]
            } else if failure == "error" {
                vec![json!({"id": request["id"], "error": OOM})]
            } else {
                vec![
                    json!({"id": request["id"], "queued": true, "start_ms": 50, "duration_ms": 0, "now_ms": 50, "language": "fr"}),
                ]
            }
        });
        let (sink, lines) = errors();
        let helper =
            VoiceHelper::new(source(qwen_and_kokoro(json!([]))), fake.spawn()).with_errors(sink);
        let call = helper
            .start_call(call_background(), Arc::new(|_| {}))
            .await
            .unwrap();
        let said = helper
            .speak_in_call(call.id, "Oui.", Some("fr"), None, None)
            .await
            .unwrap();
        assert_eq!(said.duration_ms, 900.0);
        helper
            .speak_in_call(call.id, "Non.", Some("fr"), None, None)
            .await
            .unwrap();
        let sent: Vec<Value> = fake
            .child(0)
            .requests()
            .into_iter()
            .filter(|request| request["op"] == "speak")
            .collect();
        assert_eq!(
            sent.iter()
                .map(|request| request["call"].clone())
                .collect::<Vec<_>>(),
            vec![json!(call.id); 3]
        );
        assert_eq!(
            models_sent(&fake.child(0)),
            vec!["own".to_owned(), kokoro_fr(), kokoro_fr()]
        );
        let expected = if failure == "silent" {
            format!(
                "a sentence came out silent (4 chars) in call {}: Kokoro says it again now",
                call.id
            )
        } else {
            format!("in call {}: Kokoro says it again now", call.id)
        };
        assert!(joined(&lines).contains(&expected), "{}", joined(&lines));
    }
}

#[tokio::test]
async fn kokoro_reads_a_short_while_after_a_failure_then_the_speaker_is_tried_again() {
    let fail = Arc::new(AtomicBool::new(true));
    let failing = fail.clone();
    let fake = Fake::new(move |request| {
        if request["op"] != "speak" {
            vec![]
        } else if request.contains_key("tts_models") || !failing.load(Ordering::SeqCst) {
            vec![json!({"id": request["id"], "audio": "", "language": "fr"})]
        } else {
            vec![json!({"id": request["id"], "error": OOM})]
        }
    });
    let clock = TestClock::new(1_700_000_000_000);
    let (sink, _lines) = errors();
    let helper = VoiceHelper::with(
        source(qwen_and_kokoro(json!([]))),
        fake.spawn(),
        Arc::new(clock.clone()),
        Logger::silent(),
    )
    .with_errors(sink);
    helper.speak("Oui.", Some("fr"), None, None).await.unwrap();
    clock.advance(29_000).await;
    helper
        .speak("Encore.", Some("fr"), None, None)
        .await
        .unwrap();
    fail.store(false, Ordering::SeqCst);
    clock.advance(2_000).await;
    helper
        .speak("Revenu.", Some("fr"), None, None)
        .await
        .unwrap();
    assert_eq!(
        models_sent(&fake.child(0)),
        vec!["own".to_owned(), kokoro_fr(), kokoro_fr(), "own".to_owned()]
    );
}

#[tokio::test]
async fn in_a_call_a_sentence_hushed_is_not_said_again() {
    // The helper answers the sentence once the hush went (in the TS test,
    // its answer is read after the synchronous hush).
    let fake = Fake::new(|request| {
        if request["op"] == "call_start" {
            vec![json!({"id": request["id"], "signalling_port": 4242})]
        } else {
            vec![]
        }
    });
    let (sink, lines) = errors();
    let helper =
        VoiceHelper::new(source(qwen_and_kokoro(json!([]))), fake.spawn()).with_errors(sink);
    let call = helper
        .start_call(call_background(), Arc::new(|_| {}))
        .await
        .unwrap();
    let said = {
        let helper = helper.clone();
        let id = call.id;
        tokio::spawn(async move {
            helper
                .speak_in_call(id, "Oui.", Some("fr"), None, None)
                .await
        })
    };
    let mut asked = None;
    for _ in 0..100 {
        tokio::task::yield_now().await;
        asked = fake
            .child(0)
            .requests()
            .into_iter()
            .find(|request| request["op"] == "speak");
        if asked.is_some() {
            break;
        }
    }
    call.hush();
    let id = asked.unwrap()["id"].clone();
    fake.child(0).say(json!({"id": id, "queued": true, "start_ms": 50, "duration_ms": 0, "now_ms": 50, "language": "fr"}));
    said.await.unwrap().unwrap();
    let sent = fake
        .child(0)
        .requests()
        .into_iter()
        .filter(|request| request["op"] == "speak")
        .count();
    assert_eq!(sent, 1);
    assert!(!joined(&lines).contains("Kokoro"));
}

#[tokio::test]
async fn youtube_goes_to_the_call_running_its_events_to_the_player_only() {
    let fake = Fake::new(|request| match request["op"].as_str().unwrap() {
        "call_start" => vec![json!({"id": request["id"], "signalling_port": 4242, "music": true})],
        "call_music" => {
            vec![json!({"id": request["id"], "ok": true, "volume": 0.6, "muted": false})]
        }
        "call_youtube" => vec![json!({"id": request["id"], "state": "playing", "position": 0.1})],
        _ => vec![],
    });
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    assert!(!helper.in_call());
    assert_eq!(
        helper
            .call_youtube(object(json!({"action": "status"})), false)
            .await
            .unwrap_err(),
        "no call"
    );
    let (told_sink, told) = collector();
    let call = helper
        .start_call(call_background(), told_sink)
        .await
        .unwrap();
    assert!(helper.in_call());
    assert!(!call.music_on());
    let (heard_sink, heard) = collector();
    let stop = helper.on_youtube(heard_sink);
    let answer = helper
        .call_youtube(object(json!({"action": "play", "url": "https://x"})), true)
        .await
        .unwrap();
    assert_eq!(answer["state"], "playing");
    let sent = fake.child(0).requests()[1..].to_vec();
    assert_eq!(
        sent.iter()
            .map(|request| request["op"].clone())
            .collect::<Vec<_>>(),
        vec![json!("call_music"), json!("call_youtube")]
    );
    assert_eq!(
        (sent[0]["call"].clone(), sent[0]["muted"].clone()),
        (json!(call.id), json!(false))
    );
    assert_eq!(sent[1]["action"], "play");
    assert_eq!(sent[1]["url"], "https://x");
    assert_eq!(sent[1]["call"], json!(call.id));
    assert!(call.music_on());
    fake.child(0)
        .say(json!({"event": "call_youtube", "call": call.id, "state": "stopped", "why": "ended"}));
    settle().await;
    assert_eq!(
        *lock(&heard),
        vec![json!({"event": "call_youtube", "call": call.id, "state": "stopped", "why": "ended"})]
    );
    assert!(lock(&told).is_empty());
    helper.off_youtube(stop);
    call.stop();
    assert!(!helper.in_call());
}

#[tokio::test]
async fn an_older_helper_s_unknown_call_youtube_is_its_error() {
    let fake = Fake::new(|request| match request["op"].as_str().unwrap() {
        "call_start" => vec![json!({"id": request["id"], "signalling_port": 4242})],
        "call_youtube" => vec![json!({"id": request["id"], "error": "unknown op call_youtube"})],
        _ => vec![],
    });
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    helper
        .start_call(call_background(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(
        helper
            .call_youtube(object(json!({"action": "status"})), false)
            .await
            .unwrap_err(),
        "unknown op call_youtube"
    );
}

#[test]
fn only_a_speaker_s_own_failure_has_kokoro_say_a_sentence() {
    assert!(speaker_failed("Qwen3Tts speaking failed: Compute error"));
    assert!(!speaker_failed("no call 3"));
    assert!(!speaker_failed("nothing to say"));
    assert!(!speaker_failed("The voice helper stopped: exit 1"));
}

#[tokio::test]
async fn clones_a_voice_from_a_recording() {
    let fake = Fake::new(|request| {
        if request["op"] == "clone_voice" {
            vec![
                json!({"id": request["id"], "embedding": [0.5], "codes": [[1, 2]], "heard": "hello", "seconds": 9.5}),
            ]
        } else {
            vec![]
        }
    });
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let request = object(
        json!({"audio": "/tmp/rec.wav", "model": "/base", "reference": "/voices/lea.wav", "language": "fr"}),
    );
    let cloned = helper.clone_voice(request.clone()).await.unwrap();
    assert_eq!(
        cloned,
        ClonedVoice {
            embedding: vec![json!(0.5)],
            codes: vec![json!([1, 2])],
            heard: "hello".into(),
            seconds: 9.5,
        }
    );
    let mut expected = object(json!({"op": "clone_voice"}));
    expected.extend(request.clone());
    expected.insert("id".into(), json!(1));
    assert_eq!(fake.child(0).requests()[0], Value::Object(expected));
    let failing = Fake::new(|request| {
        vec![json!({"id": request["id"], "error": "No speech in the recording"})]
    });
    let other = VoiceHelper::new(source(config(json!({}))), failing.spawn());
    assert!(
        other
            .clone_voice(request)
            .await
            .unwrap_err()
            .contains("No speech")
    );
}

#[tokio::test]
async fn without_a_configuration_voice_is_unavailable() {
    let helper = VoiceHelper::new(
        Arc::new(|| Err("No voice configuration".into())),
        Fake::silent().spawn(),
    );
    assert_eq!(
        helper.status(),
        json!({"available": false, "detail": "No voice configuration"})
    );
    assert_eq!(
        helper.speak("hi", None, None, None).await.unwrap_err(),
        "No voice configuration"
    );
    assert_eq!(helper.speech_rate(), 1.2);
}

fn answers(request: &Map<String, Value>) -> Vec<Value> {
    match request["op"].as_str().unwrap() {
        "speak" => vec![json!({"id": request["id"], "audio": "", "language": "en"})],
        "call_start" => vec![json!({"id": request["id"], "signalling_port": 4242})],
        _ => vec![],
    }
}

#[tokio::test]
async fn the_helper_stops_after_helper_idle_exit_minutes_with_nothing_to_do() {
    let clock = TestClock::new(1_700_000_000_000);
    let (sink, lines) = errors();
    let fake = Fake::new(answers);
    let helper = VoiceHelper::with(
        source(config(json!({"helper_idle_exit_minutes": 10}))),
        fake.spawn(),
        Arc::new(clock.clone()),
        Logger::silent(),
    )
    .with_errors(sink);
    helper.speak("Hello.", None, None, None).await.unwrap();
    settle().await;
    clock.advance(10 * 60_000 - 1).await;
    assert!(!fake.child(0).killed());
    helper.speak("Again.", None, None, None).await.unwrap();
    settle().await;
    clock.advance(10 * 60_000 - 1).await;
    assert!(!fake.child(0).killed());
    clock.advance(1).await;
    settle().await;
    assert!(fake.child(0).killed());
    assert!(joined(&lines).contains("nothing for the voice helper in 10 min"));
    settle().await;
    helper.speak("Back.", None, None, None).await.unwrap();
    assert_eq!(fake.count(), 2);
}

#[tokio::test]
async fn a_call_or_a_listening_keeps_the_helper_however_quiet() {
    let clock = TestClock::new(1_700_000_000_000);
    let (sink, _lines) = errors();
    let fake = Fake::new(answers);
    let helper = VoiceHelper::with(
        source(config(json!({"helper_idle_exit_minutes": 10}))),
        fake.spawn(),
        Arc::new(clock.clone()),
        Logger::silent(),
    )
    .with_errors(sink);
    let session = helper
        .listen(Arc::new(|_| {}), ListenOptions::default())
        .unwrap();
    settle().await;
    clock.advance(60 * 60_000).await;
    assert!(!fake.child(0).killed());
    session.stop();
    let call = helper
        .start_call(call_background(), Arc::new(|_| {}))
        .await
        .unwrap();
    settle().await;
    clock.advance(60 * 60_000).await;
    assert!(!fake.child(0).killed());
    call.stop();
    settle().await;
    clock.advance(10 * 60_000).await;
    settle().await;
    assert!(fake.child(0).killed());
}

#[tokio::test]
async fn without_helper_idle_exit_minutes_the_helper_runs_until_stopped() {
    let clock = TestClock::new(1_700_000_000_000);
    let fake = Fake::new(answers);
    let helper = VoiceHelper::with(
        source(config(json!({}))),
        fake.spawn(),
        Arc::new(clock.clone()),
        Logger::silent(),
    );
    helper.speak("Hello.", None, None, None).await.unwrap();
    clock.advance(24 * 60 * 60_000).await;
    assert!(!fake.child(0).killed());
}

#[tokio::test]
async fn a_stock_speaker_goes_to_the_helper_as_the_element_s_voice() {
    let kokoro = json!({"model": "kokoro", "path": "/models/kokoro"});
    let stock = json!({"model": "qwen3-tts", "path": "/models/cv", "speaker": "ryan"});
    let with_stock = config(json!({"tts_models": [stock, kokoro]}));
    assert_eq!(
        Value::Array(
            with_stock
                .helper_tts_models()
                .unwrap()
                .into_iter()
                .map(Value::Object)
                .collect()
        ),
        json!([{"model": "qwen3-tts", "path": "/models/cv", "voice": "ryan"}, kokoro])
    );
    let own = config(
        json!({"tts_models": [{"model": "qwen3-tts", "path": "/models/cv", "speaker": "ryan", "voice": "aiden"}]}),
    );
    assert_eq!(
        Value::Array(
            own.helper_tts_models()
                .unwrap()
                .into_iter()
                .map(Value::Object)
                .collect()
        ),
        json!([{"model": "qwen3-tts", "path": "/models/cv", "voice": "aiden"}])
    );
    let fake = Fake::new(speak_answer("fr"));
    let helper = VoiceHelper::new(source(with_stock), fake.spawn());
    helper
        .speak(
            "Bonjour.",
            Some("fr"),
            models(json!([{"model": "qwen3-tts", "path": "/models/cv", "speaker": "serena"}])),
            None,
        )
        .await
        .unwrap();
    let speak = fake
        .child(0)
        .requests()
        .into_iter()
        .find(|request| request["op"] == "speak")
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(speak["tts_models"].as_str().unwrap()).unwrap(),
        json!([{"model": "qwen3-tts", "path": "/models/cv", "voice": "serena"}])
    );
}

#[tokio::test]
async fn speech_says_the_rate_the_running_helper_makes_it_at() {
    let fake = Fake::new(speak_answer("en"));
    let current = Arc::new(Mutex::new(config(json!({
        "speech_rate": 1.3,
        "tts_models": [{"model": "kokoro", "path": "/models/kokoro"}],
    }))));
    let read = current.clone();
    let helper = VoiceHelper::new(Arc::new(move || Ok(lock(&read).clone())), fake.spawn());
    assert_eq!(
        helper
            .speak("Hi.", None, None, None)
            .await
            .unwrap()
            .native_rate,
        1.3
    );
    lock(&current).set("speech_rate", json!(1.5));
    assert_eq!(
        helper
            .speak("Hi.", None, None, None)
            .await
            .unwrap()
            .native_rate,
        1.3
    );
}

fn said(request: &Map<String, Value>) -> Vec<Value> {
    match request["op"].as_str().unwrap() {
        "speak" => vec![json!({
            "id": request["id"],
            "audio": ogg(),
            "language": request.get("language").cloned().unwrap_or(json!("fr")),
        })],
        "call_start" => vec![json!({"id": request["id"], "signalling_port": 4242})],
        _ => vec![],
    }
}

fn speaks(child: &FakeChild) -> Vec<Value> {
    child
        .requests()
        .into_iter()
        .filter(|request| request["op"] == "speak")
        .collect()
}

#[tokio::test]
async fn kokoro_reads_french_and_english_as_they_are_in_their_language() {
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    helper
        .speak("Bonjour, je lance la partie.", Some("fr"), None, None)
        .await
        .unwrap();
    helper
        .speak("The build passed.", None, None, None)
        .await
        .unwrap();
    helper
        .speak("J'ai relancé le pipeline GitLab CI.", None, None, None)
        .await
        .unwrap();
    let pairs: Vec<(Value, Value)> = speaks(&fake.child(0))
        .into_iter()
        .map(|request| {
            (
                request["text"].clone(),
                request
                    .get("language")
                    .cloned()
                    .unwrap_or(json!("detected")),
            )
        })
        .collect();
    assert_eq!(
        pairs,
        vec![
            (json!("Bonjour, je lance la partie."), json!("fr")),
            (json!("The build passed."), json!("detected")),
            (
                json!("J'ai relancé le pipeline GitLab CI."),
                json!("detected")
            ),
        ]
    );
}

#[tokio::test]
async fn a_language_kokoro_has_no_voice_for_is_said_to_be_one_not_read_with_another_s_accent() {
    let (sink, lines) = errors();
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn()).with_errors(sink);
    helper
        .speak(
            "Ich habe den Build gestartet und er ist jetzt fertig.",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    helper
        .speak("Guten Tag.", Some("de"), None, None)
        .await
        .unwrap();
    let notice = "This reply is in German, which this voice cannot read.";
    let pairs: Vec<(Value, Value)> = speaks(&fake.child(0))
        .into_iter()
        .map(|request| (request["text"].clone(), request["language"].clone()))
        .collect();
    assert_eq!(
        pairs,
        vec![(json!(notice), json!("en")), (json!(notice), json!("en"))]
    );
    assert!(joined(&lines).contains("no Kokoro voice reads de"));
}

#[tokio::test]
async fn qwen3_tts_reads_what_kokoro_cannot_no_notice() {
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(
        source(config(
            json!({"tts_models": [{"model": "qwen3-tts", "path": "/b"}]}),
        )),
        fake.spawn(),
    );
    helper
        .speak("Guten Tag.", Some("de"), None, None)
        .await
        .unwrap();
    assert_eq!(speaks(&fake.child(0))[0]["text"], "Guten Tag.");
}

#[tokio::test]
async fn pocket_tts_reads_its_languages_kokoro_the_others_a_notice_the_rest() {
    let pocket = vec![
        json!({"model": "pocket-tts", "path": "/p/fr", "languages": "fr"}),
        json!({"model": "pocket-tts", "path": "/p/en", "languages": "en"}),
    ];
    let mut with_kokoro = pocket.clone();
    with_kokoro.push(json!({"model": "kokoro", "path": "/k"}));
    for (models, spanish) in [
        (with_kokoro, "¿Qué tal?"),
        (
            pocket,
            "This reply is in a language this voice cannot read.",
        ),
    ] {
        let (sink, lines) = errors();
        let fake = Fake::new(said);
        let helper = VoiceHelper::new(source(config(json!({"tts_models": models}))), fake.spawn())
            .with_errors(sink);
        helper
            .speak("Bonjour.", Some("fr"), None, None)
            .await
            .unwrap();
        helper
            .speak("¿Qué tal?", Some("es"), None, None)
            .await
            .unwrap();
        helper
            .speak("Guten Tag.", Some("de"), None, None)
            .await
            .unwrap();
        assert_eq!(
            speaks(&fake.child(0))
                .iter()
                .map(|request| request["text"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!("Bonjour."),
                json!(spanish),
                json!("This reply is in German, which this voice cannot read.")
            ]
        );
        assert!(joined(&lines).contains("no Pocket TTS voice reads de"));
    }
}

#[tokio::test]
async fn a_low_gpu_helper_reads_with_its_own_voice_a_chosen_one_left_aside() {
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(source(config(json!({"low_gpu": "gaming"}))), fake.spawn());
    helper
        .speak(
            "Bonjour.",
            Some("fr"),
            models(json!([{"model": "qwen3-tts", "path": "/base", "voice_embedding": "/me.json"}])),
            None,
        )
        .await
        .unwrap();
    assert!(speaks(&fake.child(0))[0].get("tts_models").is_none());
    assert_eq!(helper.running_profile(), Some("low-gpu"));
    assert_eq!(helper.low_gpu_reason().as_deref(), Some("gaming"));
}

#[tokio::test]
async fn a_call_waits_for_beforecall_then_starts() {
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    let order: Arc<Mutex<Vec<String>>> = Arc::default();
    let (kept, counted) = (order.clone(), fake.clone());
    helper.set_before_call(Some(Arc::new(move || {
        let kept = kept.clone();
        let count = counted.count();
        Box::pin(async move {
            lock(&kept).push(format!("before, {count} helpers"));
            Ok(())
        })
    })));
    helper
        .start_call(call_background(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(*lock(&order), vec!["before, 0 helpers".to_owned()]);
    assert_eq!(fake.child(0).requests()[0]["op"], "call_start");
}

#[tokio::test]
async fn restartmodels_makes_the_call_again_in_a_helper_with_the_new_models() {
    let fake = Fake::new(said);
    let current = Arc::new(Mutex::new(config(json!({}))));
    let read = current.clone();
    let (sink, _lines) = errors();
    let helper =
        VoiceHelper::new(Arc::new(move || Ok(lock(&read).clone())), fake.spawn()).with_errors(sink);
    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = events.clone();
    let call = helper
        .start_call(
            call_background(),
            Arc::new(move |event| lock(&kept).push(event["event"].as_str().unwrap().to_owned())),
        )
        .await
        .unwrap();
    assert_eq!(helper.running_profile(), Some("full"));
    *lock(&current) = config(json!({"low_gpu": "gaming"}));
    assert!(helper.restart_models());
    for _ in 0..200 {
        if lock(&events).iter().any(|event| event == "call_restarted") {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(fake.count(), 2);
    let first = fake.child(1).requests()[0].clone();
    assert_eq!(
        (first["op"].clone(), first["call"].clone()),
        (json!("call_start"), json!(call.id))
    );
    assert!(lock(&events).iter().any(|event| event == "call_restarted"));
    assert_eq!(helper.running_profile(), Some("low-gpu"));
}

#[tokio::test]
async fn reloadmodelsandwait_stops_a_free_helper_and_waits_for_it_to_end() {
    let fake = Fake::new(said);
    let helper = VoiceHelper::new(source(config(json!({}))), fake.spawn());
    assert_eq!(helper.reload_models_and_wait().await, Reload::NotRunning);
    helper.speak("Oui.", Some("fr"), None, None).await.unwrap();
    assert_eq!(helper.reload_models_and_wait().await, Reload::Now);
    assert!(fake.child(0).killed());
    assert_eq!(helper.running_profile(), None);
}

#[tokio::test]
async fn a_helper_stuck_on_a_sentence_is_restarted_kokoro_saying_it() {
    // Not in voice-helper.test.ts by name: the speak watch, held here.
    let clock = TestClock::new(1_700_000_000_000);
    let (sink, lines) = errors();
    let fake = Fake::new(|request| match request["op"].as_str().unwrap() {
        "ping" => vec![json!({"id": request["id"]})],
        "speak" if request.contains_key("tts_models") => {
            vec![json!({"id": request["id"], "audio": "", "language": "fr"})]
        }
        _ => vec![],
    });
    let helper = VoiceHelper::with(
        source(qwen_and_kokoro(json!([]))),
        fake.spawn(),
        Arc::new(clock.clone()),
        Logger::silent(),
    )
    .with_errors(sink);
    let speaking = {
        let helper = helper.clone();
        tokio::spawn(async move { helper.speak("Oui.", Some("fr"), None, None).await })
    };
    settle().await;
    clock.advance(SPEAK_COLD_MS).await;
    for _ in 0..20 {
        settle().await;
        if fake.count() == 2 {
            break;
        }
    }
    assert!(speaking.await.unwrap().is_ok());
    assert!(fake.child(0).killed());
    assert!(joined(&lines).contains("made no speech in 45 s"));
    assert_eq!(models_sent(&fake.child(1)), vec![kokoro_fr()]);
}
