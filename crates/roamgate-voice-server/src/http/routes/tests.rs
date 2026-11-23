//! http/voice.test.ts (its cases that are not the companion's),
//! voice-helper.test.ts's "voice routes" and call-audio.test.ts's "call
//! music".

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::config::VoiceConfig;
use crate::config::tests::config;
use crate::helper::tests::Fake;
use crate::http::{Answer, AnswerBody, Request};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A sentence the fake said: text, language, models, rate.
type Said = (String, Option<String>, Option<Vec<TtsModel>>, Option<f64>);

/// The helper of voice.test.ts: set up, reads at 1.2, pauses 8 s, speaks
/// "ogg" in the language asked.
#[derive(Default)]
struct FakeSpeaker {
    spoken: Mutex<Vec<Said>>,
    /// The language each sentence is said in (None: the one asked).
    language: Option<&'static str>,
    /// max_pause_ms kept (voice.json's 8000 before).
    saved_pauses: Mutex<Vec<f64>>,
}

impl VoiceSpeaker for FakeSpeaker {
    fn status(&self) -> Value {
        json!({"available": true})
    }

    fn speech_rate(&self) -> f64 {
        1.2
    }

    fn set_speech_rate(&self, _rate: f64) -> Result<(), String> {
        Ok(())
    }

    fn max_pause_ms(&self) -> f64 {
        lock(&self.saved_pauses).last().copied().unwrap_or(8000.0)
    }

    fn set_max_pause_ms(&self, ms: f64) -> Result<(), String> {
        lock(&self.saved_pauses).push(ms);
        Ok(())
    }

    fn running_profile(&self) -> Option<&'static str> {
        None
    }

    fn low_gpu_reason(&self) -> Option<String> {
        None
    }

    fn speak(
        &self,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> BoxFuture<Result<Speech, String>> {
        lock(&self.spoken).push((text, language.clone(), models, rate));
        let language = self
            .language
            .map(str::to_owned)
            .unwrap_or_else(|| language.unwrap_or_else(|| "undefined".into()));
        Box::pin(async move {
            Ok(Speech {
                audio: b"ogg".to_vec(),
                language,
                native_rate: 1.0,
            })
        })
    }

    fn speak_in_call(
        &self,
        call: u64,
        _text: String,
        _language: Option<String>,
        _models: Option<Vec<TtsModel>>,
        _rate: Option<f64>,
    ) -> BoxFuture<Result<QueuedSpeech, String>> {
        Box::pin(async move { Err(format!("no call {call}")) })
    }
}

fn models_of(voice: &str) -> Vec<TtsModel> {
    vec![
        json!({"model": "qwen3-tts", "voice": voice})
            .as_object()
            .unwrap()
            .clone(),
    ]
}

/// A library that records what it is asked; `fail` makes it refuse
/// (fakeLibrary).
struct FakeLibrary {
    calls: Mutex<Vec<Value>>,
    fail: Option<VoiceError>,
    surprise: Mutex<Option<bool>>,
    voices: Value,
}

impl FakeLibrary {
    fn new(fail: Option<VoiceError>) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            fail,
            surprise: Mutex::new(None),
            voices: json!([{"id": "lea", "name": "Léa", "languages": ["fr"]}]),
        })
    }

    /// The library of "surprise voices": three voices, Surprise `on`.
    fn surprising(on: bool) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            fail: None,
            surprise: Mutex::new(Some(on)),
            voices: json!([
                {"id": "elo", "name": "Éloïse", "languages": ["fr"]},
                {"id": "oli", "name": "Oli", "languages": ["fr"]},
                {"id": "tib2", "name": "tib2", "languages": ["en"]},
            ]),
        })
    }

    fn calls(&self) -> Vec<Value> {
        lock(&self.calls).clone()
    }

    fn failed<T>(&self, done: T) -> Result<T, VoiceError> {
        match &self.fail {
            Some(error) => Err(error.clone()),
            None => Ok(done),
        }
    }
}

impl Voices for FakeLibrary {
    fn state(&self) -> Result<Value, VoiceError> {
        Ok(match *lock(&self.surprise) {
            Some(surprise) => json!({"voices": self.voices, "surprise": surprise}),
            None => json!({
                "voices": self.voices,
                "stock": [{"id": "qwen3-tts:ryan", "speaker": "ryan", "name": "Ryan", "native": "en"}],
                "assignments": {"all": "lea", "languages": {}},
                "kokoro": true,
                "can_clone": true,
            }),
        })
    }

    fn create(&self, input: CreateInput) -> BoxFuture<Result<Value, VoiceError>> {
        let audio = std::fs::read_to_string(&input.audio).unwrap();
        lock(&self.calls).push(json!([
            "create",
            {"name": input.name, "language": input.language, "text": input.text, "audio": input.audio, "cut": input.cut},
            audio,
        ]));
        let done = self.failed(json!({"voice": {"id": "tom"}, "heard": "hi", "kind": "shown"}));
        Box::pin(async move { done })
    }

    fn assign(
        &self,
        voice: Option<String>,
        language: Value,
    ) -> BoxFuture<Result<Value, VoiceError>> {
        lock(&self.calls).push(json!(["assign", voice, language]));
        Box::pin(async { Ok(json!({"assigned": true})) })
    }

    fn rename(&self, id: &str, name: &Value) -> Result<Value, VoiceError> {
        lock(&self.calls).push(json!(["rename", id, name]));
        self.failed(json!({"id": "lea", "name": name}))
    }

    fn delete(&self, id: &str) -> Result<(), VoiceError> {
        lock(&self.calls).push(json!(["delete", id]));
        self.failed(())
    }

    fn sample_models(&self, id: &str) -> Result<Vec<TtsModel>, VoiceError> {
        Ok(models_of(id))
    }

    fn set_surprise(&self, on: bool) -> Result<Value, VoiceError> {
        *lock(&self.surprise) = Some(on);
        Ok(json!({"voices": self.voices, "surprise": on}))
    }

    fn surprise_voices(&self) -> Result<Option<Vec<Value>>, VoiceError> {
        Ok((*lock(&self.surprise) == Some(true)).then(|| self.voices.as_array().unwrap().clone()))
    }
}

fn routes(speaker: Arc<dyn VoiceSpeaker>, options: RoutesOptions) -> VoiceRoutes {
    VoiceRoutes::new(
        speaker,
        RoutesOptions {
            debug: Arc::new(|| false),
            errors: Arc::new(|_| {}),
            ..options
        },
    )
}

fn with_library(speaker: Arc<dyn VoiceSpeaker>, library: Arc<FakeLibrary>) -> VoiceRoutes {
    routes(
        speaker,
        RoutesOptions {
            library: Some(library),
            ..RoutesOptions::default()
        },
    )
}

fn voice(request: Request) -> Request {
    request.header("x-roamgate-voice", "1")
}

fn post(path: &str, body: Value) -> Request {
    voice(Request::new("POST", path).json(&body))
}

async fn answer(routes: &VoiceRoutes, request: Request) -> Answer {
    routes.handle(&request).await.expect("an answer")
}

fn bytes(answer: &Answer) -> &[u8] {
    match &answer.body {
        AnswerBody::Bytes(bytes) => bytes,
        _ => panic!("not bytes: {answer:?}"),
    }
}

// ------------------------------------------------- voice-helper.test.ts

/// The real helper with a fake process speaking "ogg" in Spanish, its
/// voice.json `config` (voice-helper.test.ts "voice routes").
fn helper_routes(config: Arc<Mutex<VoiceConfig>>) -> VoiceRoutes {
    let fake = Fake::new(|request| {
        if request["op"] == "speak" {
            vec![json!({"id": request["id"], "audio": "b2dn", "language": "es"})]
        } else {
            vec![]
        }
    });
    let read = config.clone();
    let helper = VoiceHelper::new(Arc::new(move || Ok(lock(&read).clone())), fake.spawn())
        .with_savers(
            Arc::new(move |rate| {
                lock(&config).set("speech_rate", json!(rate));
                Ok(())
            }),
            Arc::new(|_| Ok(())),
        );
    routes(Arc::new(helper), RoutesOptions::default())
}

#[tokio::test]
async fn report_whether_voice_is_set_up() {
    let routes = helper_routes(Arc::new(Mutex::new(config(json!({})))));
    let status = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(
        status.body,
        AnswerBody::Json(json!({"available": true, "speech_rate": 1.2, "max_pause_ms": 8000}))
    );
}

#[tokio::test]
async fn keep_a_new_reading_speed_with_their_header_only() {
    let routes = helper_routes(Arc::new(Mutex::new(config(json!({})))));
    let body = json!({"speech_rate": 1.5});
    let unsigned = Request::new("POST", "/api/voice/settings").json(&body);
    assert_eq!(answer(&routes, unsigned).await.status, 403);
    let fast = post("/api/voice/settings", json!({"speech_rate": 4}));
    assert_eq!(answer(&routes, fast).await.status, 400);
    let saved = answer(&routes, post("/api/voice/settings", body)).await;
    assert_eq!(saved.body_json(), json!({"speech_rate": 1.5}));
    let status = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(
        status.body_json(),
        json!({"available": true, "speech_rate": 1.5, "max_pause_ms": 8000})
    );
}

#[tokio::test]
async fn speak_text_with_their_header_only() {
    let routes = helper_routes(Arc::new(Mutex::new(config(json!({})))));
    let unsigned = Request::new("POST", "/api/voice/speak").json(&json!({"text": "Hola."}));
    assert_eq!(answer(&routes, unsigned).await.status, 403);
    let spoken = answer(&routes, post("/api/voice/speak", json!({"text": "Hola."}))).await;
    assert_eq!(spoken.get("content-type"), Some("audio/ogg"));
    assert_eq!(spoken.get("x-voice-language"), Some("es"));
    assert_eq!(spoken.get("x-voice-native-rate"), Some("1"));
    assert_eq!(bytes(&spoken), b"ogg");
    let blank = post("/api/voice/speak", json!({"text": " "}));
    assert_eq!(answer(&routes, blank).await.status, 400);
}

#[tokio::test]
async fn leave_other_paths_alone() {
    let routes = helper_routes(Arc::new(Mutex::new(config(json!({})))));
    assert!(
        routes
            .handle(&Request::new("GET", "/api/other"))
            .await
            .is_none()
    );
}

// ------------------------------------------------------ voice.test.ts

fn settings(body: Value) -> Request {
    post("/api/voice/settings", body)
}

#[tokio::test]
async fn keeps_what_the_front_does_with_answers_reported_with_it() {
    let mode = Arc::new(Mutex::new(FrontMode::Companion));
    let (read, write) = (mode.clone(), mode.clone());
    let routes = routes(
        Arc::new(FakeSpeaker::default()),
        RoutesOptions {
            // A front is set up (voice-front.ts, the companion layer's).
            companion: Arc::new(|| CompanionStatus {
                route: true,
                front: true,
                epoch: None,
            }),
            mode: Arc::new(move || Some(*lock(&read))),
            save_mode: Arc::new(move |next| {
                *lock(&write) = next;
                Ok(())
            }),
            ..RoutesOptions::default()
        },
    );
    let refused = answer(&routes, settings(json!({"front_mode": "aloud"}))).await;
    assert_eq!(refused.status, 400);
    let kept = answer(&routes, settings(json!({"front_mode": "relay"}))).await;
    assert_eq!(kept.body_json(), json!({"front_mode": "relay"}));
    let status = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(status.body_json()["front_mode"], "relay");
}

#[tokio::test]
async fn keeps_the_longest_pause_reported_with_the_rest() {
    let speaker = Arc::new(FakeSpeaker::default());
    let routes = routes(speaker.clone(), RoutesOptions::default());
    let short = answer(&routes, settings(json!({"max_pause_ms": 100}))).await;
    assert_eq!(short.status, 400);
    let words = answer(&routes, settings(json!({"max_pause_ms": "long"}))).await;
    assert_eq!(words.status, 400);
    let kept = answer(&routes, settings(json!({"max_pause_ms": 12_000}))).await;
    assert_eq!(kept.body_json(), json!({"max_pause_ms": 12_000}));
    assert_eq!(*lock(&speaker.saved_pauses), vec![12_000.0]);
    let status = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(status.body_json()["max_pause_ms"], 12_000);
}

/// A call with a background: `music` playing or not, at `volume`.
struct FakeCall {
    music: bool,
    on: bool,
    waiting: bool,
    volume: Mutex<f64>,
    changes: Mutex<Vec<MusicChange>>,
}

impl FakeCall {
    fn new(music: bool, on: bool, waiting: bool) -> Self {
        Self {
            music,
            on,
            waiting,
            volume: Mutex::new(0.6),
            changes: Mutex::default(),
        }
    }

    fn last(&self) -> (Option<f64>, Option<bool>) {
        let change = *lock(&self.changes).last().unwrap();
        (change.volume, change.muted)
    }
}

impl VoiceCall for FakeCall {
    fn id(&self) -> u64 {
        1
    }

    fn music(&self) -> bool {
        self.music
    }

    fn music_on(&self) -> bool {
        self.on
    }

    fn music_waiting(&self) -> bool {
        self.waiting
    }

    fn music_level(&self, change: MusicChange) -> BoxFuture<Result<(f64, bool), String>> {
        lock(&self.changes).push(change);
        let mut volume = lock(&self.volume);
        if let Some(next) = change.volume {
            *volume = next;
        }
        let now = (*volume, change.muted == Some(true));
        Box::pin(async move { Ok(now) })
    }
}

#[test]
fn muted_call_music_is_not_described_as_playing() {
    assert_eq!(call_music(None), None);
    assert_eq!(call_music(Some(&FakeCall::new(false, false, false))), None);
    let music = |on, waiting| call_music(Some(&FakeCall::new(true, on, waiting)));
    assert_eq!(music(false, false), Some("off"));
    assert_eq!(music(true, false), Some("on"));
    // On, but silent until the user's voice is learnt: not playing.
    assert_eq!(music(true, true), Some("waiting"));
}

fn request(path: &str, method: &str) -> Request {
    voice(Request::new(method, path))
}

#[tokio::test]
async fn voices_are_listed_and_changed_only_with_the_voice_header() {
    let library = FakeLibrary::new(None);
    let routes = with_library(Arc::new(FakeSpeaker::default()), library.clone());
    let listed = answer(&routes, Request::new("GET", "/api/voice/voices")).await;
    assert_eq!(listed.body_json()["voices"][0]["name"], "Léa");
    let refused = answer(&routes, Request::new("DELETE", "/api/voice/voices/lea")).await;
    assert_eq!(refused.status, 403);
    assert!(library.calls().is_empty());
}

/// A multipart/form-data body as FormData sends it.
fn form(parts: &[(&str, Option<&str>, &str)]) -> (String, Vec<u8>) {
    let boundary = "----roamgate-form-boundary";
    let mut body = String::new();
    for (name, filename, value) in parts {
        body.push_str(&format!("--{boundary}\r\n"));
        match filename {
            Some(filename) => body.push_str(&format!(
                "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n"
            )),
            None => body.push_str(&format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n")),
        }
        body.push_str(value);
        body.push_str("\r\n");
    }
    body.push_str(&format!("--{boundary}--\r\n"));
    (
        format!("multipart/form-data; boundary={boundary}"),
        body.into_bytes(),
    )
}

#[tokio::test]
async fn a_recording_is_uploaded_cloned_then_removed() {
    let library = FakeLibrary::new(None);
    let temp = tempfile::tempdir().unwrap();
    let routes = routes(
        Arc::new(FakeSpeaker::default()),
        RoutesOptions {
            library: Some(library.clone()),
            temp_dir: temp.path().into(),
            ..RoutesOptions::default()
        },
    );
    let (kind, body) = form(&[
        ("name", None, "Tom"),
        ("language", None, "en"),
        ("text", None, "Once upon a time"),
        ("cut", None, "1"),
        ("audio", Some("rec.wav"), "RIFF"),
    ]);
    let upload = request("/api/voice/voices", "POST")
        .header("content-type", &kind)
        .bytes(body);
    let created = answer(&routes, upload).await;
    assert_eq!(created.status, 201);
    assert_eq!(
        created.body_json(),
        json!({"voice": {"id": "tom"}, "heard": "hi", "kind": "shown"})
    );
    let calls = library.calls();
    let [call] = calls.as_slice() else {
        panic!("one call: {calls:?}");
    };
    assert_eq!(call[0], "create");
    let input = &call[1];
    assert_eq!(input["name"], "Tom");
    assert_eq!(input["language"], "en");
    assert_eq!(input["text"], "Once upon a time");
    assert_eq!(input["cut"], true);
    assert_eq!(call[2], "RIFF");
    assert!(!std::path::Path::new(input["audio"].as_str().unwrap()).exists());
    let (kind, body) = form(&[]);
    let empty = request("/api/voice/voices", "POST")
        .header("content-type", &kind)
        .bytes(body);
    assert_eq!(answer(&routes, empty).await.status, 400);
}

#[tokio::test]
async fn a_refused_change_says_why_with_its_status() {
    let library = FakeLibrary::new(Some(VoiceError::new(
        409,
        "Léa reads replies: choose another voice first.",
    )));
    let routes = with_library(Arc::new(FakeSpeaker::default()), library);
    let refused = answer(&routes, request("/api/voice/voices/lea", "DELETE")).await;
    assert_eq!(refused.status, 409);
    assert!(
        refused.body_json()["error"]
            .as_str()
            .unwrap()
            .contains("choose another voice")
    );
}

#[tokio::test]
async fn choose_rename_delete_and_hear_voices() {
    let library = FakeLibrary::new(None);
    let speaker = Arc::new(FakeSpeaker::default());
    let routes = with_library(speaker.clone(), library.clone());
    answer(
        &routes,
        post(
            "/api/voice/voices/assign",
            json!({"voice": "lea", "language": "fr"}),
        ),
    )
    .await;
    let rename =
        voice(Request::new("PATCH", "/api/voice/voices/l%C3%A9a").json(&json!({"name": "Lou"})));
    answer(&routes, rename).await;
    let deleted = answer(&routes, request("/api/voice/voices/lea", "DELETE")).await;
    assert_eq!(deleted.status, 204);
    assert_eq!(
        library.calls(),
        vec![
            json!(["assign", "lea", "fr"]),
            json!(["rename", "léa", "Lou"]),
            json!(["delete", "lea"]),
        ]
    );
    let sample = answer(
        &routes,
        post("/api/voice/voices/sample", json!({"voice": "lea"})),
    )
    .await;
    assert_eq!(bytes(&sample), b"ogg");
    assert_eq!(sample.get("x-voice-language"), Some("fr"));
    // In the voice's own language, with its models.
    assert_eq!(
        lock(&speaker.spoken).last().cloned().unwrap(),
        (
            "Bonjour ! Voici ma voix. On part à l'aventure ensemble ?".to_owned(),
            Some("fr".to_owned()),
            Some(models_of("lea")),
            None,
        )
    );
}

#[tokio::test]
async fn a_stock_voice_is_heard_in_its_own_language_or_the_one_asked() {
    let library = FakeLibrary::new(None);
    let speaker = Arc::new(FakeSpeaker::default());
    let routes = with_library(speaker.clone(), library);
    answer(
        &routes,
        post(
            "/api/voice/voices/sample",
            json!({"voice": "qwen3-tts:ryan"}),
        ),
    )
    .await;
    assert_eq!(
        lock(&speaker.spoken).last().cloned().unwrap(),
        (
            "Hello! This is my voice. Shall we have an adventure together?".to_owned(),
            Some("en".to_owned()),
            Some(models_of("qwen3-tts:ryan")),
            None,
        )
    );
    let french = answer(
        &routes,
        post(
            "/api/voice/voices/sample",
            json!({"voice": "qwen3-tts:ryan", "language": "fr"}),
        ),
    )
    .await;
    assert_eq!(french.get("x-voice-language"), Some("fr"));
    assert_eq!(
        lock(&speaker.spoken).last().unwrap().1.as_deref(),
        Some("fr")
    );
}

/// "surprise voices": the routes, and what the helper was asked to say.
fn surprising(on: bool) -> (VoiceRoutes, Arc<FakeSpeaker>) {
    let speaker = Arc::new(FakeSpeaker {
        language: Some("fr"),
        ..FakeSpeaker::default()
    });
    let routes = with_library(speaker.clone(), FakeLibrary::surprising(on));
    (routes, speaker)
}

async fn say(routes: &VoiceRoutes, text: &str, reading: Option<&str>) -> Answer {
    let mut body = json!({"text": text});
    if let Some(reading) = reading {
        body["reading"] = json!(reading);
    }
    answer(routes, post("/api/voice/speak", body)).await
}

#[tokio::test]
async fn surprise_is_reported_and_turned_on_and_off_with_the_voice_header() {
    let (routes, _) = surprising(false);
    let status = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(status.body_json()["surprise"], false);
    let unsigned = Request::new("POST", "/api/voice/voices/surprise").json(&json!({"on": true}));
    assert_eq!(answer(&routes, unsigned).await.status, 403);
    let words = post("/api/voice/voices/surprise", json!({"on": "yes"}));
    assert_eq!(answer(&routes, words).await.status, 400);
    let on = answer(
        &routes,
        post("/api/voice/voices/surprise", json!({"on": true})),
    )
    .await;
    assert_eq!(on.body_json()["surprise"], true);
    let again = answer(&routes, Request::new("GET", "/api/voice")).await;
    assert_eq!(again.body_json()["surprise"], true);
}

#[tokio::test]
async fn a_reply_is_read_by_one_voice_the_next_by_another() {
    let (routes, speaker) = surprising(true);
    let first = say(&routes, "Bonjour, je suis là.", Some("r1")).await;
    let name = decode_uri_component(first.get("x-voice-name").unwrap()).unwrap();
    let ids = [("elo", "Éloïse"), ("oli", "Oli"), ("tib2", "tib2")];
    // Any of the voices, whatever the reply's language.
    let (id, _) = ids.iter().find(|(_, each)| *each == name).unwrap();
    assert_eq!(
        lock(&speaker.spoken)[0],
        (
            "Bonjour, je suis là.".to_owned(),
            None,
            Some(models_of(id)),
            Some(1.2),
        )
    );
    let second = say(&routes, "Et la suite de la réponse.", Some("r1")).await;
    assert_eq!(second.get("x-voice-name"), first.get("x-voice-name"));
    let next = say(&routes, "Une autre réponse.", Some("r2")).await;
    assert_ne!(next.get("x-voice-name"), first.get("x-voice-name"));
}

#[tokio::test]
async fn off_replies_are_read_as_voice_json_says() {
    let (routes, speaker) = surprising(false);
    let spoken = say(&routes, "Bonjour.", Some("r1")).await;
    assert_eq!(spoken.get("x-voice-name"), None);
    assert_eq!(
        lock(&speaker.spoken)[0],
        ("Bonjour.".to_owned(), None, None, Some(1.2))
    );
}

#[tokio::test]
async fn speech_is_made_at_the_page_s_rate_else_voice_json_s() {
    let (routes, speaker) = surprising(false);
    answer(
        &routes,
        post("/api/voice/speak", json!({"text": "Vite.", "rate": 1.5})),
    )
    .await;
    answer(
        &routes,
        post("/api/voice/speak", json!({"text": "Trop vite.", "rate": 9})),
    )
    .await;
    let rates: Vec<Option<f64>> = lock(&speaker.spoken).iter().map(|said| said.3).collect();
    assert_eq!(rates, vec![Some(1.5), Some(1.2)]);
}

// ---------------------------------------------------- call-audio.test.ts

fn music(music: &str, reply: Option<&str>) -> Value {
    let mut route = json!({"to": "music", "music": music});
    if let Some(reply) = reply {
        route["reply"] = json!(reply);
    }
    route
}

fn quiet() -> ErrorSink {
    Arc::new(|_| {})
}

#[tokio::test]
async fn down_up_off_and_on_change_the_call_s_music() {
    let call = FakeCall::new(true, true, false);
    assert_eq!(
        music_route(&music("down", Some("Je baisse.")), Some(&call), &quiet()).await,
        json!({"to": "self", "reply": "Je baisse."})
    );
    assert_eq!(call.last(), (Some(0.6 / 1.6), Some(false)));
    music_route(&music("up", None), Some(&call), &quiet()).await;
    assert!((call.last().0.unwrap() - 0.6).abs() < 0.005);
    music_route(&music("off", None), Some(&call), &quiet()).await;
    assert_eq!(call.last(), (None, Some(true)));
    music_route(&music("on", None), Some(&call), &quiet()).await;
    assert_eq!(call.last(), (None, Some(false)));
}

#[tokio::test]
async fn each_change_is_logged_the_music_before_and_after() {
    let call = FakeCall::new(true, true, false);
    let logged: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = logged.clone();
    let errors: ErrorSink = Arc::new(move |line| lock(&kept).push(line.to_owned()));
    music_route(&music("up", None), Some(&call), &errors).await;
    music_route(&music("off", None), Some(&call), &errors).await;
    assert_eq!(
        *lock(&logged),
        vec![
            "[voice] the call's music up: volume 0.60 -> volume 0.96",
            "[voice] the call's music off: volume 0.96 -> off",
        ]
    );
}

#[tokio::test]
async fn with_no_music_it_says_so() {
    let silent = FakeCall::new(false, false, false);
    assert_eq!(
        music_route(&music("off", Some("Ok.")), Some(&silent), &quiet()).await,
        json!({"to": "self", "reply": "No music is playing on this call."})
    );
    assert_eq!(
        music_route(&music("off", None), None, &quiet()).await["to"],
        "self"
    );
}
