use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::*;
use crate::testing::{
    ModelServer, SetupHome, cpu_laptop, nvidia_desktop, serve_models, setup_home,
};

async fn home() -> (ModelServer, SetupHome) {
    let server = serve_models().await;
    let home = setup_home(&server, nvidia_desktop());
    (server, home)
}

fn read_config(home: &SetupHome) -> Map<String, Value> {
    serde_json::from_str(&std::fs::read_to_string(&home.deps.config_path).unwrap()).unwrap()
}

fn write_config(home: &SetupHome, config: &Map<String, Value>) {
    std::fs::create_dir_all(home.deps.config_path.parent().unwrap()).unwrap();
    std::fs::write(
        &home.deps.config_path,
        serde_json::to_string(&Value::Object(config.clone())).unwrap(),
    )
    .unwrap();
}

fn light() -> VoiceChoices {
    recommended_choices(&cpu_laptop())["light"].clone()
}

fn heavy() -> VoiceChoices {
    recommended_choices(&nvidia_desktop())["heavy"].clone()
}

/// The light tier as it was, Kokoro's ONNX model reading.
fn kokoro_light() -> VoiceChoices {
    let mut choices = light();
    choices.insert("tts".into(), "kokoro-onnx".into());
    choices
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

/// Pocket TTS's entries, in the models directory `models`.
fn pocket_entries(models: &Path) -> Vec<Value> {
    vec![
        json!({
            "model": "pocket-tts",
            "path": text(&models.join("pocket-tts-fr").join("languages").join("french")),
            "languages": "fr",
            "voice": "estelle",
        }),
        json!({
            "model": "pocket-tts",
            "path": text(&models.join("pocket-tts-en").join("languages").join("english")),
            "languages": "en",
            "voice": "alba",
        }),
    ]
}

async fn install(choices: &VoiceChoices, deps: &SetupDeps) -> SetupJob {
    install_voice_models(choices, deps, &InstallOptions::default())
        .await
        .unwrap()
        .0
}

fn state(home: &SetupHome) -> Value {
    voice_setup_state(&home.deps, None).unwrap()
}

fn current(home: &SetupHome) -> Value {
    state(home)["current"].clone()
}

fn unused_ids(home: &SetupHome) -> Vec<String> {
    state(home)["unused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_fresh_machine_nothing_installed_the_hardware_s_tier_proposed() {
    let (_server, home) = home().await;
    let state = state(&home);
    assert_eq!(state["tier"], "heavy");
    assert_eq!(state["current"], json!({}));
    assert_eq!(
        state["helper"],
        json!({"path": text(&home.deps.helper_path), "found": false})
    );
    assert_eq!(state["unused"], json!([]));
    let tts = state["components"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "tts")
        .unwrap();
    let qwen = tts["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["id"] == "qwen3-tts-1.7b")
        .unwrap();
    assert_eq!(qwen["installed"], false);
    assert_eq!(qwen["downloadBytes"], qwen["sizeBytes"]);
    assert!(qwen["sizeBytes"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn models_put_in_place_by_hand_elsewhere_are_found_where_voice_json_says() {
    let (_server, home) = home().await;
    // Install to the models directory, then move voice.json's view of it.
    install(&light(), &home.deps).await;
    assert_eq!(
        current(&home),
        json!({
            "speech": "parakeet",
            "reread": NO_MODEL,
            "tts": "pocket-tts",
            "stock_voices": NO_MODEL,
            "speaker": "wespeaker",
            "turn": "smart-turn",
            "text_turn": "qwen3-0.6b",
        })
    );
    let mut config = read_config(&home);
    config.insert("speaker_model".into(), json!("/elsewhere/mine.onnx"));
    write_config(&home, &config);
    assert_eq!(current(&home)["speaker"], "custom");
}

#[tokio::test]
async fn pocket_tts_is_the_light_voice_kokoro_s_onnx_model_beside_it_and_the_full_set_s_fallback() {
    let (_server, home) = home().await;
    install(&kokoro_light(), &home.deps).await;
    install(&light(), &home.deps).await;
    let models = home.deps.models_dir.clone();
    let mut expected = pocket_entries(&models);
    expected.push(json!({"model": "kokoro", "path": text(&models.join("kokoro-v1.0.onnx"))}));
    assert_eq!(read_config(&home)["tts_models"], Value::Array(expected));
    assert_eq!(current(&home)["tts"], "pocket-tts");
    install(&heavy(), &home.deps).await;
    let mut expected = vec![json!({"model": "kokoro", "path": text(&models.join("Kokoro-82M"))})];
    expected.extend(pocket_entries(&models));
    assert_eq!(read_config(&home)["tts_models"], Value::Array(expected));
    assert_eq!(current(&home)["tts"], "qwen3-tts-1.7b");
    // A Pocket TTS model elsewhere is voice.json's own.
    let mut config = read_config(&home);
    let mut french = pocket_entries(&models)[0].clone();
    french["path"] = json!("/elsewhere/fr");
    config.insert("tts_models".into(), json!([french]));
    write_config(&home, &config);
    assert_eq!(current(&home)["tts"], "custom");
}

#[tokio::test]
async fn downloads_the_chosen_models_and_writes_voice_json_keeping_the_rest() {
    let (_server, home) = home().await;
    write_config(
        &home,
        json!({"helper": "/opt/roamgate-voice", "speech_rate": 1.3, "front_model": "opus"})
            .as_object()
            .unwrap(),
    );
    let progress: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let seen = progress.clone();
    let options = InstallOptions {
        on_progress: Some(Arc::new(move |job: &SetupJob| {
            seen.lock().unwrap().push(job.state)
        })),
        ..InstallOptions::default()
    };
    let (job, _) = install_voice_models(&light(), &home.deps, &options)
        .await
        .unwrap();
    assert_eq!(job.state, "done");
    assert_eq!(job.done_bytes, job.total_bytes);
    let progress = progress.lock().unwrap().clone();
    assert_eq!(progress.first(), Some(&"downloading"));
    assert_eq!(progress.last(), Some(&"done"));
    let models = &home.deps.models_dir;
    assert_eq!(
        Value::Object(read_config(&home)),
        json!({
            "helper": "/opt/roamgate-voice",
            "speech_rate": 1.3,
            "front_model": "opus",
            "parakeet_model": text(&models.join("parakeet-tdt-0.6b-v3")),
            "tts_models": pocket_entries(models),
            "speaker_model": text(&models.join("wespeaker_en_voxceleb_resnet34.onnx")),
            "turn_model": text(&models.join("smart-turn-v3.2-cpu.onnx")),
            "text_turn_model": text(&models.join("qwen3-0.6b")),
        })
    );
    assert!(
        models
            .join("qwen3-0.6b")
            .join("onnx")
            .join("model_int8.onnx")
            .exists()
    );
}

#[tokio::test]
async fn the_installed_helper_is_named_when_voice_json_has_none() {
    let (_server, home) = home().await;
    std::fs::create_dir_all(home.deps.helper_path.parent().unwrap()).unwrap();
    std::fs::write(&home.deps.helper_path, "").unwrap();
    install(&light(), &home.deps).await;
    assert_eq!(
        read_config(&home)["helper"],
        json!(text(&home.deps.helper_path))
    );
}

#[tokio::test]
async fn running_it_again_downloads_nothing_and_changes_nothing() {
    let (server, home) = home().await;
    install(&light(), &home.deps).await;
    let before = std::fs::read_to_string(&home.deps.config_path).unwrap();
    server.clear();
    let job = install(&light(), &home.deps).await;
    assert_eq!(job.total_bytes, 0.0);
    assert_eq!(server.requests(), Vec::new());
    assert_eq!(
        std::fs::read_to_string(&home.deps.config_path).unwrap(),
        before
    );
}

#[tokio::test]
async fn switching_tier_the_light_models_become_unused_then_removed() {
    let (_server, home) = home().await;
    install(&kokoro_light(), &home.deps).await;
    install(&heavy(), &home.deps).await;
    let models = home.deps.models_dir.clone();
    assert_eq!(current(&home)["tts"], "qwen3-tts-1.7b");
    let mut expected = vec![json!({"model": "kokoro", "path": text(&models.join("Kokoro-82M"))})];
    expected.extend(pocket_entries(&models));
    assert_eq!(read_config(&home)["tts_models"], Value::Array(expected));
    // Kokoro's ONNX keys stay beside tts_models: still referenced, kept.
    assert_eq!(unused_ids(&home), Vec::<String>::new());
    let mut config = read_config(&home);
    config.shift_remove("kokoro_model");
    config.shift_remove("kokoro_voices");
    write_config(&home, &config);
    assert_eq!(unused_ids(&home), ["kokoro-onnx", "kokoro-onnx-voices"]);
    let (_, freed) = remove_unused_models(None, &home.deps).unwrap();
    assert!(freed > 0.0);
    assert!(!models.join("kokoro-v1.0.onnx").exists());
    assert!(models.join("parakeet-tdt-0.6b-v3").exists());
    assert_eq!(state(&home)["unused"], json!([]));
}

#[tokio::test]
async fn unfinished_downloads_are_listed_and_removed() {
    let (_server, home) = home().await;
    let dir = home.deps.models_dir.join("Kokoro-82M");
    std::fs::create_dir_all(&dir).unwrap();
    let part = part_path(&dir.join("kokoro-v1_0.pth"));
    std::fs::write(&part, "half").unwrap();
    assert_eq!(
        state(&home)["unused"],
        json!([{"id": "partial", "name": "Unfinished download", "path": text(&part), "sizeBytes": 4}])
    );
    remove_unused_models(Some(&["partial".to_owned()]), &home.deps).unwrap();
    assert!(!part.exists());
}

#[tokio::test]
async fn nothing_outside_the_models_directory_is_ever_removed() {
    let (_server, home) = home().await;
    install(&light(), &home.deps).await;
    let outside = home.home.path().join("mine");
    std::fs::create_dir(&outside).unwrap();
    let mut config = read_config(&home);
    config.shift_remove("turn_model");
    write_config(&home, &config);
    // The turn model in the models directory is unused now.
    assert_eq!(unused_ids(&home), ["smart-turn-v3.2"]);
    remove_unused_models(None, &home.deps).unwrap();
    assert!(outside.exists());
}

#[tokio::test]
async fn too_little_room_stops_it_before_downloading() {
    let (server, home) = home().await;
    let mut deps = home.deps.clone();
    deps.free_bytes = Some(Arc::new(|_| Some(10.0)));
    let error = install_voice_models(&light(), &deps, &InstallOptions::default())
        .await
        .unwrap_err();
    assert!(error.message.contains("MB free"), "{}", error.message);
    assert_eq!(server.requests(), Vec::new());
    assert!(!home.deps.config_path.exists());
}

#[tokio::test]
async fn a_failed_download_leaves_voice_json_alone() {
    let (_server, home) = home().await;
    write_config(
        &home,
        json!({"helper": "/opt/roamgate-voice"})
            .as_object()
            .unwrap(),
    );
    let mut broken = home.deps.clone();
    broken.packages = Some(
        home.deps
            .packages
            .clone()
            .unwrap()
            .into_iter()
            .map(|mut entry| {
                if entry.id == "smart-turn-v3.2" {
                    for file in &mut entry.files {
                        file.sha256 = "0".repeat(64);
                    }
                }
                entry
            })
            .collect(),
    );
    let error = install_voice_models(&light(), &broken, &InstallOptions::default())
        .await
        .unwrap_err();
    assert!(error.message.contains("checksum"), "{}", error.message);
    assert_eq!(
        Value::Object(read_config(&home)),
        json!({"helper": "/opt/roamgate-voice"})
    );
}

async fn wait_done(runner: &VoiceSetupRunner) {
    while runner.running() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn runs_one_download_reports_it_reloads_the_helper() {
    let (_server, home) = home().await;
    let reloads = Arc::new(AtomicUsize::new(0));
    let counted = reloads.clone();
    let runner = VoiceSetupRunner::new(
        home.deps.clone(),
        Some(Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            "now"
        })),
    );
    let started = runner.start(&light()).unwrap();
    assert_eq!(started.state, "downloading");
    let error = runner.start(&light()).unwrap_err();
    assert!(error.contains("already downloading"), "{error}");
    wait_done(&runner).await;
    let job = runner.job().unwrap();
    assert_eq!(job.state, "done");
    assert_eq!(job.reload, Some("now"));
    assert_eq!(reloads.load(Ordering::SeqCst), 1);
    assert_eq!(runner.state().unwrap()["current"]["tts"], "pocket-tts");
}

#[tokio::test]
async fn an_unknown_model_fails_at_once() {
    let (_server, home) = home().await;
    let runner = VoiceSetupRunner::new(home.deps.clone(), None);
    let choices = VoiceChoices::from([("tts".to_owned(), "nope".to_owned())]);
    let error = runner.start(&choices).unwrap_err();
    assert!(
        error.contains("no reading voice model named nope"),
        "{error}"
    );
    assert!(!runner.running());
}

#[tokio::test]
async fn cancelled_the_job_says_so_and_voice_json_is_untouched() {
    let (_server, home) = home().await;
    let runner = VoiceSetupRunner::new(home.deps.clone(), None);
    runner.start(&heavy()).unwrap();
    assert!(runner.cancel());
    wait_done(&runner).await;
    assert_eq!(runner.job().unwrap().state, "cancelled");
    assert!(!home.deps.config_path.exists());
}
