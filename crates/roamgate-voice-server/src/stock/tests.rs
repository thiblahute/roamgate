use serde_json::json;

use super::*;

fn model(dir: &Path, name: &str, config: Value) -> PathBuf {
    let path = dir.join(name);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("config.json"), config.to_string()).unwrap();
    path
}

struct Models {
    dir: tempfile::TempDir,
    base: PathBuf,
    custom: PathBuf,
}

fn models() -> Models {
    let dir = tempfile::Builder::new()
        .prefix("voice-stock-")
        .tempdir()
        .unwrap();
    let base = model(
        dir.path(),
        "Qwen3-TTS-1.7B-Base",
        json!({"tts_model_type": "base", "talker_config": {"spk_id": {}}}),
    );
    let custom = model(
        dir.path(),
        "Qwen3-TTS-1.7B-CustomVoice",
        json!({"tts_model_type": "custom_voice", "talker_config": {"spk_id": {"sohee": 1, "aiden": 2, "Ryan": 3}}}),
    );
    Models { dir, base, custom }
}

fn config(value: Value) -> VoiceConfig {
    VoiceConfig {
        raw: value.as_object().unwrap().clone(),
    }
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

#[test]
fn are_the_speakers_of_a_customvoice_model_in_the_model_card_s_order() {
    let models = models();
    assert_eq!(model_speakers(&models.custom), ["ryan", "aiden", "sohee"]);
    assert_eq!(model_speakers(&models.base), Vec::<String>::new());
    assert_eq!(
        model_speakers(&models.dir.path().join("missing")),
        Vec::<String>::new()
    );
}

#[test]
fn the_model_is_the_one_named_read_with_or_next_to_the_base() {
    let models = models();
    let qwen = |path: &Path| {
        config(json!({"helper": "", "tts_models": [{"model": "qwen3-tts", "path": text(path)}]}))
    };
    assert_eq!(
        stock_model(&config(
            json!({"helper": "", "stock_model": text(&models.custom)})
        )),
        Some(models.custom.clone())
    );
    assert_eq!(
        stock_model(&config(
            json!({"helper": "", "stock_model": text(&models.base)})
        )),
        None
    );
    assert_eq!(
        stock_model(&qwen(&models.custom)),
        Some(models.custom.clone())
    );
    assert_eq!(
        stock_model(&qwen(&models.base)),
        Some(models.custom.clone())
    );
    assert_eq!(stock_model(&config(json!({"helper": ""}))), None);
}

#[test]
fn an_entry_names_its_speaker_with_voice_or_speaker_not_with_a_clone() {
    let entry = |value: Value| entry_speaker(value.as_object().unwrap());
    assert_eq!(
        entry(json!({"model": "qwen3-tts", "voice": "Ryan"})).as_deref(),
        Some("ryan")
    );
    assert_eq!(
        entry(json!({"model": "qwen3-tts", "speaker": "vivian"})).as_deref(),
        Some("vivian")
    );
    assert_eq!(
        entry(json!({"model": "qwen3-tts", "voice": "ryan", "voice_embedding": "me.json"})),
        None
    );
    assert_eq!(entry(json!({"model": "kokoro", "voice": "af_heart"})), None);
    assert_eq!(stock_voice_id("Ono_Anna"), "qwen3-tts:ono_anna");
    assert!(is_stock_voice_id("qwen3-tts:ryan"));
    assert!(!is_stock_voice_id("ryan"));
}

#[test]
fn stock_voices_are_named_as_the_model_card_says_or_from_their_speaker() {
    let models = models();
    let extra = model(
        models.dir.path(),
        "Other-CustomVoice",
        json!({"talker_config": {"spk_id": {"new_voice": 1, "ryan": 2}}}),
    );
    let voices = stock_voices(Some(&extra));
    assert_eq!(voices[0].name, "Ryan");
    assert_eq!(voices[0].native, "en");
    assert_eq!(voices[1].id, "qwen3-tts:new_voice");
    assert_eq!(voices[1].name, "New Voice");
    assert_eq!(voices[1].native, "");
    assert!(stock_voices(None).is_empty());
}
