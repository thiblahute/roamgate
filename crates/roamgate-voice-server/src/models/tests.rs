use regex::Regex;

use super::*;
use crate::testing::{cpu_laptop, nvidia_desktop};

fn pocket() -> Vec<Value> {
    vec![
        json!({"model": "pocket-tts", "path": at("pocket-tts-fr/languages/french"), "languages": "fr", "voice": "estelle"}),
        json!({"model": "pocket-tts", "path": at("pocket-tts-en/languages/english"), "languages": "en", "voice": "alba"}),
    ]
}

/// A path under the tests' `/models`, joined as the platform joins.
fn at(relative: &str) -> String {
    join_relative(Path::new("/models"), relative)
        .display()
        .to_string()
}

fn roots() -> PackageRoots {
    packages()
        .iter()
        .map(|entry| (entry.id.clone(), PathBuf::from(at(&entry.dir))))
        .collect()
}

pub(crate) fn pick(pairs: &[(&str, &str)]) -> VoiceChoices {
    choices(pairs)
}

fn patch_json(patch: &ConfigPatch) -> Map<String, Value> {
    patch
        .iter()
        .map(|(key, value)| (key.clone(), value.clone().unwrap_or(Value::Null)))
        .collect()
}

#[test]
fn every_option_s_packages_exist_with_pinned_files_and_checksums() {
    let ids: BTreeSet<&str> = packages().iter().map(|entry| entry.id.as_str()).collect();
    for option in options() {
        for id in &option.packages {
            assert!(ids.contains(id.as_str()), "{id}");
        }
    }
    let sha = Regex::new(r"^[0-9a-f]{64}$").unwrap();
    let url = Regex::new(r"^https://(huggingface\.co|github\.com)/").unwrap();
    for entry in packages() {
        for file in &entry.files {
            assert!(sha.is_match(&file.sha256));
            assert!(url.is_match(&file.url));
            assert!(file.size > 0.0);
        }
    }
}

#[test]
fn the_heavy_desktop_set_is_about_the_size_the_desktop_holds() {
    let heavy = recommended_choices(&nvidia_desktop())["heavy"].clone();
    let bytes: f64 = packages_for(&heavy)
        .unwrap()
        .iter()
        .map(|id| package_bytes(package_by_id(id, packages()).unwrap()))
        .sum();
    assert!(bytes / GIB > 6.0 && bytes / GIB < 8.0);
}

#[test]
fn the_models_directory_windows_under_appdata() {
    assert_eq!(
        default_models_dir(Path::new("/home/u"), "linux", None),
        PathBuf::from("/home/u/.local/share/roamgate/voice/models")
    );
    assert_eq!(
        default_helper_path(Path::new("/home/u"), "darwin", None),
        PathBuf::from("/home/u/.local/share/roamgate/voice/roamgate-voice")
    );
    assert!(
        default_helper_path(
            Path::new("C:\\Users\\u"),
            "win32",
            Some(Path::new("C:\\Users\\u\\AppData\\Roaming"))
        )
        .display()
        .to_string()
        .contains("roamgate-voice.exe")
    );
}

#[test]
fn an_8_gb_nvidia_card_is_heavy_with_qwen3_tts_1_7b() {
    assert_eq!(tier_for(&nvidia_desktop()), "heavy");
    assert_eq!(
        recommended_choices(&nvidia_desktop())["heavy"]["tts"],
        "qwen3-tts-1.7b"
    );
}

#[test]
fn a_6_gb_card_is_heavy_with_the_0_6b_model() {
    let mut hardware = nvidia_desktop();
    hardware.gpu_bytes = 6.0 * GIB;
    assert_eq!(tier_for(&hardware), "heavy");
    assert_eq!(
        recommended_choices(&hardware)["heavy"]["tts"],
        "qwen3-tts-0.6b"
    );
}

#[test]
fn a_4_gb_card_or_no_usable_gpu_is_light() {
    let mut small = nvidia_desktop();
    small.gpu_bytes = 4.0 * GIB;
    assert_eq!(tier_for(&small), "light");
    assert_eq!(tier_for(&cpu_laptop()), "light");
    let mut unused = cpu_laptop();
    unused.gpus = nvidia_desktop().gpus;
    unused.gpu_bytes = 8.0 * GIB;
    assert_eq!(tier_for(&unused), "light");
}

#[test]
fn light_is_all_cpu_int8_kokoro_and_no_text_turn_model_short_of_memory() {
    let light = recommended_choices(&cpu_laptop())["light"].clone();
    assert_eq!(light["speech"], "parakeet");
    assert_eq!(light["reread"], NO_MODEL);
    assert_eq!(light["tts"], "pocket-tts");
    assert_eq!(light["text_turn"], "qwen3-0.6b");
    let mut small_machine = cpu_laptop();
    small_machine.ram_bytes = 6.0 * GIB;
    let small = recommended_choices(&small_machine)["light"].clone();
    assert_eq!(small["tts"], "kokoro-onnx-int8");
    assert_eq!(small["text_turn"], NO_MODEL);
    for id in packages_for(&light).unwrap() {
        for option in options()
            .iter()
            .filter(|entry| entry.packages.contains(&id))
        {
            if light.get(&option.component) == Some(&option.id) {
                assert_ne!(option.runs_on, "gpu");
            }
        }
    }
}

#[test]
fn whisper_alone_has_no_second_reading_nor_text_turn_model() {
    assert_eq!(
        normalize_choices(&pick(&[
            ("speech", "whisper-small"),
            ("reread", "whisper-large-v3-turbo"),
            ("text_turn", "qwen3-0.6b"),
        ]))
        .unwrap(),
        pick(&[
            ("speech", "whisper-small"),
            ("reread", NO_MODEL),
            ("text_turn", NO_MODEL)
        ])
    );
}

#[test]
fn stock_voices_follow_the_reading_voice_s_size_none_without_qwen3_tts() {
    let stock = |tts: &str, voices: &str| {
        normalize_choices(&pick(&[("tts", tts), ("stock_voices", voices)])).unwrap()["stock_voices"]
            .clone()
    };
    assert_eq!(stock("qwen3-tts-0.6b", "customvoice"), "customvoice-0.6b");
    assert_eq!(
        stock("qwen3-tts-1.7b", "customvoice-0.6b"),
        "customvoice-1.7b"
    );
    assert_eq!(stock("kokoro-onnx", "customvoice"), NO_MODEL);
}

#[test]
fn a_part_voice_json_has_its_own_way_keeps_what_depends_on_it() {
    let choices = pick(&[("speech", CUSTOM_MODEL), ("text_turn", "qwen3-0.6b")]);
    assert_eq!(normalize_choices(&choices).unwrap(), choices);
}

#[test]
fn unknown_models_and_a_required_part_left_out_are_refused() {
    assert_eq!(
        normalize_choices(&pick(&[("speech", "whisper-huge")])).unwrap_err(),
        "no speech recognition model named whisper-huge"
    );
    assert_eq!(
        normalize_choices(&pick(&[("tts", NO_MODEL)])).unwrap_err(),
        "Reading voice needs a model"
    );
}

#[test]
fn heavy_parakeet_with_whisper_qwen3_tts_with_kokoro_beside_it() {
    let patch = config_patch(
        &recommended_choices(&nvidia_desktop())["heavy"],
        &roots(),
        &Map::new(),
        packages(),
    )
    .unwrap();
    let mut models = vec![json!({"model": "kokoro", "path": at("Kokoro-82M")})];
    models.extend(pocket());
    assert_eq!(
        Value::Object(patch_json(&patch)),
        json!({
            "parakeet_model": at("parakeet-tdt-0.6b-v3"),
            "whisper_model": at("ggml-large-v3-turbo-q5_0.bin"),
            "tts_models": models,
            "clone_model": at("Qwen3-TTS-1.7B-Base"),
            "stock_model": null,
            "speaker_model": at("wespeaker_en_voxceleb_resnet34.onnx"),
            "turn_model": at("smart-turn-v3.2-cpu.onnx"),
            "text_turn_model": at("qwen3-0.6b"),
        })
    );
}

#[test]
fn light_pocket_tts_in_place_of_any_tts_kokoro_s_onnx_model_beside_it() {
    let old = json!({"tts_models": [{"model": "kokoro", "path": "/old"}], "clone_model": "/old/base", "whisper_model": "/old/whisper.bin"});
    let light = recommended_choices(&cpu_laptop())["light"].clone();
    let patch =
        patch_json(&config_patch(&light, &roots(), old.as_object().unwrap(), packages()).unwrap());
    assert_eq!(patch["parakeet_model"], at("parakeet-tdt-0.6b-v3"));
    assert_eq!(patch["kokoro_model"], at("kokoro-v1.0.onnx"));
    assert_eq!(patch["kokoro_voices"], at("voices-v1.0.bin"));
    let mut models = pocket();
    models.push(json!({"model": "kokoro", "path": at("kokoro-v1.0.onnx")}));
    assert_eq!(patch["tts_models"], Value::Array(models));
    for key in ["clone_model", "stock_model", "whisper_model"] {
        assert_eq!(patch.get(key), Some(&Value::Null), "{key}");
    }
    let no_onnx: PackageRoots = roots()
        .into_iter()
        .filter(|(id, _)| !id.starts_with("kokoro-onnx"))
        .collect();
    let mut older = old.as_object().unwrap().clone();
    older.insert("kokoro_model".into(), json!("/elsewhere/kokoro.onnx"));
    let alone = patch_json(&config_patch(&light, &no_onnx, &older, packages()).unwrap());
    assert_eq!(alone["tts_models"], Value::Array(pocket()));
    assert!(!alone.contains_key("kokoro_model"));
}

#[test]
fn light_as_before_kokoro_s_onnx_model_in_place_of_any_tts() {
    let mut light = recommended_choices(&cpu_laptop())["light"].clone();
    light.insert("tts".into(), "kokoro-onnx".into());
    let old = json!({"tts_models": [{"model": "kokoro", "path": "/old"}], "clone_model": "/old/base", "whisper_model": "/old/whisper.bin"});
    let patch =
        patch_json(&config_patch(&light, &roots(), old.as_object().unwrap(), packages()).unwrap());
    assert_eq!(patch["parakeet_model"], at("parakeet-tdt-0.6b-v3"));
    assert_eq!(patch["kokoro_model"], at("kokoro-v1.0.onnx"));
    assert_eq!(patch["kokoro_voices"], at("voices-v1.0.bin"));
    for key in ["tts_models", "clone_model", "stock_model", "whisper_model"] {
        assert_eq!(patch.get(key), Some(&Value::Null), "{key}");
    }
}

#[test]
fn a_recorded_voice_and_kokoro_s_own_fields_stay() {
    let base = at("Qwen3-TTS-1.7B-Base");
    let config = json!({"tts_models": [
        {"model": "qwen3-tts", "path": base, "voice_embedding": "/voices/me.json"},
        {"model": "qwen3-tts", "path": "/elsewhere/Qwen3-TTS-0.6B-Base"},
        {"model": "kokoro", "path": "/old/Kokoro-82M", "voice": "ff_siwis"},
        {"model": "pocket-tts", "path": "/old/pocket/fr", "languages": "fr", "voice": "lola"},
    ]});
    let patch = patch_json(
        &config_patch(
            &pick(&[("tts", "qwen3-tts-1.7b"), ("stock_voices", "customvoice")]),
            &roots(),
            config.as_object().unwrap(),
            packages(),
        )
        .unwrap(),
    );
    let mut french = pocket()[0].clone();
    french["voice"] = json!("lola");
    assert_eq!(
        patch["tts_models"],
        json!([
            {"model": "qwen3-tts", "path": base, "voice_embedding": "/voices/me.json"},
            {"model": "kokoro", "path": at("Kokoro-82M"), "voice": "ff_siwis"},
            french,
            pocket()[1],
        ])
    );
    assert_eq!(patch["stock_model"], at("Qwen3-TTS-1.7B-CustomVoice"));
}

#[test]
fn custom_parts_and_unset_ones_are_not_touched() {
    let patch = config_patch(
        &pick(&[
            ("speech", CUSTOM_MODEL),
            ("tts", CUSTOM_MODEL),
            ("speaker", NO_MODEL),
        ]),
        &roots(),
        &Map::new(),
        packages(),
    )
    .unwrap();
    assert_eq!(patch, vec![("speaker_model".to_owned(), None)]);
}
