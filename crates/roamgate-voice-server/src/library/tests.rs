use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::reading::READING_TEXTS;

struct Setup {
    _root: tempfile::TempDir,
    root: PathBuf,
    base: PathBuf,
    elsewhere: PathBuf,
    config_path: PathBuf,
    library: VoiceLibrary,
    cloned: Arc<Mutex<Vec<VoiceCloneRequest>>>,
    applied: Arc<AtomicUsize>,
    answer: Arc<Mutex<std::result::Result<ClonedVoice, String>>>,
}

impl Setup {
    fn read_config(&self) -> Map<String, Value> {
        serde_json::from_str(&std::fs::read_to_string(&self.config_path).unwrap()).unwrap()
    }

    fn answer(&self, next: std::result::Result<ClonedVoice, String>) {
        *self.answer.lock().unwrap() = next;
    }

    fn state(&self) -> Value {
        self.library.state().unwrap()
    }

    fn ids(&self) -> Vec<String> {
        self.state()["voices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|voice| voice["id"].as_str().unwrap().to_owned())
            .collect()
    }

    async fn create(&self, name: &str, language: &str, text: &str, audio: &str) -> Created {
        self.library
            .create(CreateInput {
                name: json!(name),
                language: json!(language),
                text: json!(text),
                audio: audio.into(),
                cut: false,
            })
            .await
            .unwrap()
    }
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

fn cloned_voice(embedding: Value, codes: Value, heard: &str, seconds: f64) -> ClonedVoice {
    ClonedVoice {
        embedding: embedding.as_array().unwrap().clone(),
        codes: codes.as_array().unwrap().clone(),
        heard: heard.into(),
        seconds,
    }
}

/// A voice.json with a Qwen3-TTS Base model, a French voice and an English
/// one made elsewhere, then Kokoro; the voices directory empty.
fn setup(models: Option<Value>) -> Setup {
    let dir = tempfile::Builder::new()
        .prefix("voice-library-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_path_buf();
    let base = root.join("Qwen3-TTS-Base");
    std::fs::create_dir_all(base.join("speech_tokenizer")).unwrap();
    std::fs::write(
        base.join("config.json"),
        json!({"speaker_encoder_config": {"enc_dim": 2048}}).to_string(),
    )
    .unwrap();
    std::fs::write(base.join("speech_tokenizer").join("model.safetensors"), "").unwrap();
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    for name in ["papa-fr", "papa"] {
        std::fs::write(elsewhere.join(format!("{name}.json")), "{}").unwrap();
    }
    let config_path = root.join("voice.json");
    let models = models.unwrap_or_else(|| {
        json!([
            {
                "model": "qwen3-tts",
                "path": text(&base),
                "voice_embedding": text(&elsewhere.join("papa-fr.json")),
                "languages": "fr",
                "temperature": 0.7,
            },
            {
                "model": "qwen3-tts",
                "path": text(&base),
                "voice_embedding": text(&elsewhere.join("papa.json")),
            },
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    });
    let config = json!({
        "helper": "/bin/true",
        "parakeet_model": "/models/parakeet",
        "voices_dir": text(&root.join("voices")),
        "tts_models": models,
    });
    std::fs::write(&config_path, config.to_string()).unwrap();
    let cloned: Arc<Mutex<Vec<VoiceCloneRequest>>> = Arc::default();
    let applied = Arc::new(AtomicUsize::new(0));
    let answer = Arc::new(Mutex::new(Ok(cloned_voice(
        json!([0.5, -0.25]),
        json!([[1, 2], [3, 4]]),
        "",
        12.0,
    ))));
    let read_path = config_path.clone();
    let library = VoiceLibrary::new(LibraryOptions {
        read_config: Some(Arc::new(move || {
            Ok(VoiceConfig {
                raw: serde_json::from_str(&std::fs::read_to_string(&read_path).unwrap()).unwrap(),
            })
        })),
        config_path: config_path.clone(),
        default_voices_dir: root.join("default-voices"),
        clone: {
            let cloned = cloned.clone();
            let answer = answer.clone();
            Arc::new(move |request| {
                cloned.lock().unwrap().push(request);
                let answer = answer.lock().unwrap().clone();
                Box::pin(async move { answer })
            })
        },
        applied: Some({
            let applied = applied.clone();
            Arc::new(move || {
                applied.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            })
        }),
        now: Arc::new(|| roamgate_agents::js::date_parse("2026-10-30T12:00:00Z")),
    });
    Setup {
        _root: dir,
        root,
        base,
        elsewhere,
        config_path,
        library,
        cloned,
        applied,
        answer,
    }
}

fn kokoro_only() -> Option<Value> {
    Some(json!([{"model": "kokoro", "path": "/models/Kokoro-82M"}]))
}

fn assignments(all: &str, languages: Value) -> Value {
    json!({"all": all, "languages": languages})
}

#[test]
fn voices_go_to_local_share_roamgate_voices() {
    assert_eq!(
        default_voices_dir(Path::new("/home/kid"), "linux", None),
        PathBuf::from("/home/kid/.local/share/roamgate/voices")
    );
}

#[tokio::test]
async fn the_voices_voice_json_reads_with_are_listed_and_stay_listed() {
    let t = setup(None);
    let state = t.state();
    let listed: Vec<(String, bool)> = state["voices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|voice| {
            (
                voice["id"].as_str().unwrap().to_owned(),
                voice["owned"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        [("papa-fr".to_owned(), false), ("papa".to_owned(), false)]
    );
    assert_eq!(state["voices"][0]["languages"], json!(["fr"]));
    assert_eq!(
        state["assignments"],
        assignments("papa", json!({"fr": "papa-fr"}))
    );
    assert_eq!(state["kokoro"], true);
    assert_eq!(state["can_clone"], true);
    // Once Kokoro reads, they are still there to choose again.
    t.library.assign(Some(KOKORO), &Value::Null).await.unwrap();
    assert_eq!(t.ids(), ["papa-fr", "papa"]);
    assert_eq!(t.state()["assignments"], assignments(KOKORO, json!({})));
}

#[tokio::test]
async fn a_recording_becomes_a_voice_with_the_text_shown_when_read() {
    let t = setup(None);
    let shown = READING_TEXTS[0].1[0];
    t.answer(Ok(cloned_voice(
        json!([0.5]),
        json!([[7, 8]]),
        &shown.to_lowercase().replace([',', '.'], ""),
        11.0,
    )));
    let created = t.create(" Léa ", "en", shown, "/tmp/rec.wav").await;
    assert_eq!(created.kind, "shown");
    assert_eq!(created.transcript, shown);
    for (key, want) in [
        ("id", json!("lea")),
        ("name", json!("Léa")),
        ("languages", json!(["en"])),
        ("owned", json!(true)),
        ("created", json!("2026-10-30T12:00:00.000Z")),
    ] {
        assert_eq!(created.voice[key], want, "{key}");
    }
    assert_eq!(
        *t.cloned.lock().unwrap(),
        [VoiceCloneRequest {
            audio: "/tmp/rec.wav".into(),
            model: text(&t.base),
            reference: text(&t.root.join("voices").join("lea.wav")),
            language: "en".into(),
        }]
    );
    // any-tts's VoiceEmbedding.
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(t.root.join("voices").join("lea.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved,
        json!({"data": [0.5], "shape": [1], "model_type": "qwen3-tts", "prompt": {"codes": [[7, 8]], "text": shown}})
    );
    // A second Léa does not replace the first.
    let second = t
        .create("Léa", "fr", READING_TEXTS[1].1[0], "/tmp/rec2.wav")
        .await;
    assert_eq!(second.voice["id"], "lea-2");
    assert_eq!(t.ids(), ["papa-fr", "papa", "lea", "lea-2"]);
}

fn prompt_text(voice: &Value) -> Value {
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(voice["path"].as_str().unwrap()).unwrap())
            .unwrap();
    saved["prompt"]["text"].clone()
}

#[tokio::test]
async fn what_was_heard_is_kept_when_it_is_not_the_text_shown() {
    let t = setup(None);
    let heard = "Arr, I am a pirate and I love treasure.";
    t.answer(Ok(cloned_voice(json!([1]), json!([[1]]), heard, 6.0)));
    let created = t
        .create("Pirate", "en", READING_TEXTS[0].1[1], "/tmp/rec.wav")
        .await;
    assert_eq!(created.kind, "heard");
    assert_eq!(prompt_text(&created.voice), heard);
}

#[tokio::test]
async fn a_recording_cut_mid_speech_keeps_only_what_it_says() {
    let t = setup(None);
    let shown = READING_TEXTS[0].1[0];
    t.answer(Ok(cloned_voice(json!([1]), json!([[1]]), shown, 29.0)));
    let created = t
        .library
        .create(CreateInput {
            name: json!("Oli"),
            language: json!("en"),
            text: json!(shown),
            audio: "/tmp/rec.wav".into(),
            cut: true,
        })
        .await
        .unwrap();
    assert_eq!(created.kind, "partial");
    assert_eq!(prompt_text(&created.voice), shown.trim_end_matches('.'));
}

#[tokio::test]
async fn a_recording_that_fails_to_clone_leaves_nothing() {
    let t = setup(None);
    t.answer(Err("No speech in the recording".into()));
    let error = t
        .library
        .create(CreateInput {
            name: json!("Tom"),
            language: json!("en"),
            text: json!("hi"),
            audio: "/tmp/rec.wav".into(),
            cut: false,
        })
        .await
        .unwrap_err();
    assert_eq!(error, VoiceError::new(422, "No speech in the recording"));
    assert!(!t.root.join("voices").join("tom.json").exists());
    assert_eq!(t.ids().len(), 2);
}

#[tokio::test]
async fn bad_names_and_languages_are_refused() {
    let t = setup(None);
    let input = |name: &str, language: &str| CreateInput {
        name: json!(name),
        language: json!(language),
        text: json!(""),
        audio: "x".into(),
        cut: false,
    };
    let error = t.library.create(input(" ", "en")).await.unwrap_err();
    assert!(error.message.contains("name"), "{error}");
    let error = t.library.create(input("Tom", "xx")).await.unwrap_err();
    assert!(error.message.contains("language"), "{error}");
}

#[tokio::test]
async fn choosing_a_voice_for_all_languages_drops_their_own_voices() {
    let t = setup(None);
    let lea = t.create("Léa", "fr", "", "/tmp/rec.wav").await;
    let state = t.library.assign(Some("lea"), &Value::Null).await.unwrap();
    assert_eq!(state["assignments"], assignments("lea", json!({})));
    assert_eq!(t.applied.load(Ordering::SeqCst), 1);
    assert_eq!(
        t.read_config()["tts_models"],
        json!([
            {"model": "qwen3-tts", "path": text(&t.base), "voice_embedding": lea.voice["path"]},
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    );
    // The rest of voice.json stays.
    assert_eq!(t.read_config()["parakeet_model"], "/models/parakeet");
}

#[tokio::test]
async fn a_language_gets_a_voice_of_its_own_and_gives_it_back() {
    let t = setup(None);
    t.create("Pirate", "en", "", "/tmp/rec.wav").await;
    t.library
        .assign(Some("pirate"), &json!("en"))
        .await
        .unwrap();
    assert_eq!(
        t.state()["assignments"],
        assignments("papa", json!({"fr": "papa-fr", "en": "pirate"}))
    );
    // The French entry keeps its temperature; languages first, then all.
    let kept: Vec<(Value, Value)> = t.read_config()["tts_models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| {
            (
                model.get("languages").cloned().unwrap_or(Value::Null),
                model.get("temperature").cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    assert_eq!(
        kept,
        [
            (json!("fr"), json!(0.7)),
            (json!("en"), Value::Null),
            (Value::Null, Value::Null),
            (Value::Null, Value::Null),
        ]
    );
    t.library.assign(None, &json!("en")).await.unwrap();
    assert_eq!(
        t.state()["assignments"]["languages"],
        json!({"fr": "papa-fr"})
    );
    // The voice of all languages for a language: nothing of its own.
    t.library.assign(Some("papa"), &json!("fr")).await.unwrap();
    assert_eq!(t.state()["assignments"]["languages"], json!({}));
}

#[tokio::test]
async fn kokoro_reads_every_language_or_none() {
    let t = setup(None);
    let error = t
        .library
        .assign(Some(KOKORO), &json!("fr"))
        .await
        .unwrap_err();
    assert!(error.message.contains("Kokoro"), "{error}");
    let error = t
        .library
        .assign(Some("nobody"), &Value::Null)
        .await
        .unwrap_err();
    assert!(error.message.contains("No such voice"), "{error}");
    t.library.assign(Some(KOKORO), &Value::Null).await.unwrap();
    assert_eq!(
        t.read_config()["tts_models"],
        json!([{"model": "kokoro", "path": "/models/Kokoro-82M"}])
    );
}

fn values(models: Vec<TtsModel>) -> Value {
    Value::Array(models.into_iter().map(Value::Object).collect())
}

#[test]
fn a_voice_to_hear_reads_everything_before_kokoro() {
    let t = setup(None);
    assert_eq!(
        values(t.library.sample_models("papa-fr").unwrap()),
        json!([
            {"model": "qwen3-tts", "path": text(&t.base), "voice_embedding": text(&t.elsewhere.join("papa-fr.json"))},
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    );
    assert_eq!(
        values(t.library.sample_models(KOKORO).unwrap()),
        json!([{"model": "kokoro", "path": "/models/Kokoro-82M"}])
    );
}

#[tokio::test]
async fn renaming_keeps_the_files_deleting_removes_only_recorded_ones() {
    let t = setup(None);
    let lea = t.create("Léa", "fr", "", "/tmp/rec.wav").await;
    let reference = PathBuf::from(lea.voice["reference"].as_str().unwrap());
    let path = PathBuf::from(lea.voice["path"].as_str().unwrap());
    std::fs::write(&reference, "wav").unwrap();
    assert_eq!(
        t.library.rename("lea", &json!("Léa la pirate")).unwrap()["name"],
        "Léa la pirate"
    );
    let state = t.state();
    let renamed = state["voices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|voice| voice["id"] == "lea")
        .unwrap();
    assert_eq!(renamed["name"], "Léa la pirate");
    t.library.delete("lea").unwrap();
    assert!(!path.exists());
    assert!(!reference.exists());
    // In use: choose another first.
    let error = t.library.delete("papa").unwrap_err();
    assert!(error.message.contains("choose another voice"), "{error}");
    t.library.assign(Some(KOKORO), &Value::Null).await.unwrap();
    t.library.delete("papa").unwrap();
    // Made elsewhere: forgotten, not deleted.
    assert!(t.elsewhere.join("papa.json").exists());
    assert_eq!(t.ids(), ["papa-fr"]);
}

#[test]
fn without_a_base_model_voices_cannot_be_recorded() {
    let t = setup(kokoro_only());
    let state = t.state();
    assert_eq!(state["can_clone"], false);
    assert!(state["clone_detail"].as_str().unwrap().contains("Base"));
    let config = VoiceConfig {
        raw: json!({"helper": "", "clone_model": text(&t.base)})
            .as_object()
            .unwrap()
            .clone(),
    };
    assert_eq!(cloning_model(&config), Some(text(&t.base)));
}

#[test]
fn assignments_and_models_read_each_other() {
    let models: Vec<TtsModel> = [
        json!({"model": "qwen3-tts", "path": "/base", "voice_embedding": "/v/a.json", "languages": "fr,es"}),
        json!({"model": "kokoro", "path": "/k"}),
    ]
    .into_iter()
    .map(|model| model.as_object().unwrap().clone())
    .collect();
    let assignments = assignments_from(&models, |path| {
        (path == "/v/a.json").then(|| "a".to_owned())
    });
    assert_eq!(
        assignments.to_json(),
        json!({"all": KOKORO, "languages": {"fr": "a", "es": "a"}})
    );
    assert_eq!(
        values(models_for(
            &models,
            &assignments,
            |id| Some(VoiceReader::Embedding(format!("/v/{id}.json"))),
            "/base",
        )),
        json!([
            {"model": "qwen3-tts", "path": "/base", "voice_embedding": "/v/a.json", "languages": "fr"},
            {"model": "qwen3-tts", "path": "/base", "voice_embedding": "/v/a.json", "languages": "es"},
            {"model": "kokoro", "path": "/k"},
        ])
    );
}

#[tokio::test]
async fn is_kept_in_voice_json_and_choosing_a_voice_turns_it_off() {
    let t = setup(None);
    assert_eq!(t.state()["surprise"], false);
    assert_eq!(t.library.surprise_voices().unwrap(), None);
    assert_eq!(t.library.set_surprise(true).unwrap()["surprise"], true);
    assert_eq!(t.read_config()["voice_surprise"], true);
    // Every voice is picked from, those made elsewhere included.
    let picked: Vec<Value> = t
        .library
        .surprise_voices()
        .unwrap()
        .unwrap()
        .iter()
        .map(|voice| voice["id"].clone())
        .collect();
    assert_eq!(picked, [json!("papa-fr"), json!("papa")]);
    // Who reads every language: Surprise off.
    t.library.assign(Some("papa"), &json!("fr")).await.unwrap();
    assert_eq!(t.read_config().get("voice_surprise"), None);
    t.library.set_surprise(true).unwrap();
    t.library.assign(None, &json!("fr")).await.unwrap();
    assert_eq!(t.read_config()["voice_surprise"], true);
    assert_eq!(t.library.set_surprise(false).unwrap()["surprise"], false);
    assert!(!t.read_config().contains_key("voice_surprise"));
    t.library.set_surprise(true).unwrap();
    t.library.assign(Some(KOKORO), &Value::Null).await.unwrap();
    assert_eq!(t.state()["surprise"], false);
}

#[test]
fn needs_voices_and_a_model_to_read_them_with() {
    let t = setup(kokoro_only());
    assert_eq!(
        t.library.set_surprise(true).unwrap_err().message,
        "No Qwen3-TTS model to read with."
    );
    assert_eq!(t.library.set_surprise(false).unwrap()["surprise"], false);
}

/// A Qwen3-TTS CustomVoice model with three stock speakers, next to `dir`.
fn custom_voice(dir: &Path) -> PathBuf {
    let path = dir.join("Qwen3-TTS-CustomVoice");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(
        path.join("config.json"),
        json!({"tts_model_type": "custom_voice", "talker_config": {"spk_id": {"vivian": 3065, "Ryan": 3061, "newbie": 1}}})
            .to_string(),
    )
    .unwrap();
    path
}

#[test]
fn are_those_of_the_customvoice_model_next_to_the_base_one() {
    let t = setup(None);
    assert_eq!(t.state()["stock"], json!([]));
    assert!(
        t.state()["stock_detail"]
            .as_str()
            .unwrap()
            .contains("CustomVoice")
    );
    let custom = custom_voice(&t.root);
    let state = t.state();
    assert_eq!(state.get("stock_detail"), None);
    assert_eq!(
        state["stock"],
        json!([
            {"id": "qwen3-tts:ryan", "speaker": "ryan", "name": "Ryan", "native": "en", "description": "Lively man, strong rhythm"},
            {"id": "qwen3-tts:vivian", "speaker": "vivian", "name": "Vivian", "native": "zh", "description": "Bright young woman, a little edgy"},
            {"id": "qwen3-tts:newbie", "speaker": "newbie", "name": "Newbie", "native": "", "description": ""},
        ])
    );
    // A sample reads with the CustomVoice model and that speaker.
    assert_eq!(
        values(t.library.sample_models("qwen3-tts:ryan").unwrap()),
        json!([
            {"model": "qwen3-tts", "path": text(&custom), "voice": "ryan"},
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    );
    let error = t.library.sample_models("qwen3-tts:nobody").unwrap_err();
    assert!(error.message.contains("No such voice"), "{error}");
}

#[tokio::test]
async fn read_every_language_or_one_and_the_cloned_voices_still_can() {
    let t = setup(None);
    let custom = custom_voice(&t.root);
    let state = t
        .library
        .assign(Some("qwen3-tts:ryan"), &Value::Null)
        .await
        .unwrap();
    assert_eq!(
        state["assignments"],
        assignments("qwen3-tts:ryan", json!({}))
    );
    assert_eq!(
        t.read_config()["tts_models"],
        json!([
            {"model": "qwen3-tts", "path": text(&custom), "voice": "ryan"},
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    );
    // The Base model is no longer read with: kept, to record voices with.
    assert_eq!(t.read_config()["clone_model"], json!(text(&t.base)));
    assert_eq!(t.state()["can_clone"], true);
    // French in a cloned voice, the rest in Ryan's.
    let state = t
        .library
        .assign(Some("papa-fr"), &json!("fr"))
        .await
        .unwrap();
    assert_eq!(
        state["assignments"],
        assignments("qwen3-tts:ryan", json!({"fr": "papa-fr"}))
    );
    assert_eq!(
        t.read_config()["tts_models"],
        json!([
            {"model": "qwen3-tts", "path": text(&t.base), "voice_embedding": text(&t.elsewhere.join("papa-fr.json")), "languages": "fr"},
            {"model": "qwen3-tts", "path": text(&custom), "voice": "ryan"},
            {"model": "kokoro", "path": "/models/Kokoro-82M"},
        ])
    );
    // Back to a cloned voice for everything: the stock model stays known.
    t.library.assign(Some("papa"), &Value::Null).await.unwrap();
    assert_eq!(
        t.read_config()["tts_models"][0],
        json!({"model": "qwen3-tts", "path": text(&t.base), "voice_embedding": text(&t.elsewhere.join("papa.json"))})
    );
    assert_eq!(t.read_config()["stock_model"], json!(text(&custom)));
    assert_eq!(t.state()["stock"].as_array().unwrap().len(), 3);
    let error = t
        .library
        .assign(Some("qwen3-tts:nobody"), &Value::Null)
        .await
        .unwrap_err();
    assert!(error.message.contains("No such voice"), "{error}");
}

#[test]
fn named_with_speaker_or_voice_in_voice_json() {
    let t = setup(Some(json!([
        {"model": "qwen3-tts", "path": "/cv", "speaker": "Vivian", "languages": "zh"},
        {"model": "qwen3-tts", "path": "/cv", "voice": "ryan"},
        {"model": "kokoro", "path": "/k"},
    ])));
    assert_eq!(
        t.state()["assignments"],
        assignments("qwen3-tts:ryan", json!({"zh": "qwen3-tts:vivian"}))
    );
}

#[test]
fn a_stock_model_that_is_not_a_customvoice_model_gives_none() {
    let t = setup(None);
    custom_voice(&t.root);
    let mut raw = t.read_config();
    raw.insert("stock_model".into(), json!(text(&t.base)));
    std::fs::write(&t.config_path, Value::Object(raw).to_string()).unwrap();
    assert_eq!(t.state()["stock"], json!([]));
}
