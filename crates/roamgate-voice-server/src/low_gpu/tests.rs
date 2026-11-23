use std::sync::atomic::{AtomicBool, Ordering};

use roamgate_base::clock::TestClock;

use super::*;
use crate::config::read_voice_config;
use crate::hardware::GIB;
use crate::setup::{InstallOptions, install_voice_models};
use crate::testing::{ModelServer, SetupHome, nvidia_desktop, serve_models, setup_home};

struct Home {
    server: ModelServer,
    home: SetupHome,
    path: PathBuf,
}

async fn home() -> Home {
    let server = serve_models().await;
    let home = setup_home(&server, nvidia_desktop());
    let path = home
        .home
        .path()
        .join(".local")
        .join("share")
        .join("roamgate")
        .join("voice")
        .join("low-gpu.json");
    Home { server, home, path }
}

/// Every package installed, as on the desktop: roots for low_gpu_choices.
fn all(server: &ModelServer) -> PackageRoots {
    server
        .packages
        .iter()
        .map(|entry| (entry.id.clone(), PathBuf::from(format!("/m/{}", entry.id))))
        .collect()
}

/// All but these packages.
fn without(server: &ModelServer, ids: &[&str]) -> PackageRoots {
    all(server)
        .into_iter()
        .filter(|(id, _)| !ids.contains(&id.as_str()))
        .collect()
}

fn pick(pairs: &[(&str, &str)]) -> VoiceChoices {
    pairs
        .iter()
        .map(|(part, id)| ((*part).to_owned(), (*id).to_owned()))
        .collect()
}

fn hold(on: bool, holder: Option<&str>) -> HoldChange {
    HoldChange {
        on,
        holder: holder.map(str::to_owned),
        now: false,
    }
}

fn holders(path: &Path) -> Value {
    Value::Object(read_low_gpu(path).holders)
}

fn none() -> VoiceChoices {
    VoiceChoices::new()
}

#[tokio::test]
async fn holders_hold_it_on_each_one_lets_go_off_alone_lets_all_go() {
    let home = home().await;
    let path = &home.path;
    assert_eq!(read_low_gpu(path), LowGpuFile::default());
    hold_low_gpu(path, &hold(true, Some("gaming")), 10.0).unwrap();
    hold_low_gpu(path, &hold(true, None), 20.0).unwrap();
    // Holding again keeps the first time.
    hold_low_gpu(path, &hold(true, Some("gaming")), 30.0).unwrap();
    assert_eq!(holders(path), json!({"gaming": 10, "manual": 20}));
    hold_low_gpu(path, &hold(false, Some("gaming")), 0.0).unwrap();
    assert_eq!(holders(path), json!({"manual": 20}));
    let now = HoldChange {
        now: true,
        ..hold(true, Some("render"))
    };
    hold_low_gpu(path, &now, 40.0).unwrap();
    let file = read_low_gpu(path);
    assert_eq!(
        Value::Object(file.holders.clone()),
        json!({"manual": 20, "render": 40})
    );
    assert_eq!(file.now, Some(40.0));
    assert_eq!(file.models, None);
    hold_low_gpu(path, &hold(false, None), 0.0).unwrap();
    assert_eq!(holders(path), json!({}));
    let error = hold_low_gpu(path, &hold(true, Some("a b")), 0.0).unwrap_err();
    assert!(error.contains("a holder is letters"), "{error}");
}

#[tokio::test]
async fn parts_set_by_hand_are_checked_and_kept_reset_goes_back() {
    let home = home().await;
    let path = &home.path;
    set_low_gpu_models(path, json!({"tts": "kokoro-82m"}).as_object()).unwrap();
    set_low_gpu_models(path, json!({"text_turn": NO_MODEL}).as_object()).unwrap();
    assert_eq!(
        read_low_gpu(path).models.map(Value::Object),
        Some(json!({"tts": "kokoro-82m", "text_turn": NO_MODEL}))
    );
    let error = set_low_gpu_models(path, json!({"tts": "nope"}).as_object()).unwrap_err();
    assert!(
        error.contains("no reading voice model named nope"),
        "{error}"
    );
    set_low_gpu_models(path, None).unwrap();
    assert_eq!(read_low_gpu(path).models, None);
}

#[tokio::test]
async fn a_broken_file_reads_as_off() {
    let home = home().await;
    let path = &home.path;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "{not json").unwrap();
    assert_eq!(read_low_gpu(path), LowGpuFile::default());
    std::fs::write(
        path,
        json!({"holders": {"bad name": 1, "ok": "x", "fine": 2}}).to_string(),
    )
    .unwrap();
    assert_eq!(holders(path), json!({"fine": 2}));
}

#[test]
fn only_for_the_gaming_holder_or_gamemode() {
    assert!(for_gaming("gaming"));
    assert!(for_gaming("GameMode"));
    assert!(for_gaming("render, GameMode"));
    assert!(!for_gaming("render"));
    assert!(!for_gaming("manual, gaming-ish"));
}

#[test]
fn a_few_onnx_threads_as_many_as_voice_json_says_0_for_no_limit() {
    let config = |value: Value| value.as_object().unwrap().clone();
    assert_eq!(
        yield_cpu(&config(json!({})), "gaming"),
        Some(json!({"threads": 4}))
    );
    assert_eq!(
        yield_cpu(&config(json!({"gaming_cpu_threads": 2})), "GameMode"),
        Some(json!({"threads": 2}))
    );
    assert_eq!(
        yield_cpu(&config(json!({"gaming_cpu_threads": 0})), "gaming"),
        Some(json!({"threads": 0}))
    );
    assert_eq!(yield_cpu(&config(json!({})), "render"), None);
}

#[tokio::test]
async fn is_the_light_tier_among_what_is_here_parakeet_pocket_tts_on_the_cpu() {
    let server = serve_models().await;
    let choices = low_gpu_choices(&all(&server), &none(), 64.0 * GIB, &none()).unwrap();
    assert_eq!(choices, recommended_choices(&nvidia_desktop())["light"]);
    assert_eq!(choices["tts"], "pocket-tts");
    assert_eq!(choices["reread"], NO_MODEL);
    assert_eq!(choices["text_turn"], "qwen3-0.6b");
    assert_eq!(gpu_bytes_for(&choices), 0.0);
    // The full set, for comparison: Whisper and Qwen3-TTS on the GPU.
    assert_eq!(
        gpu_bytes_for(&recommended_choices(&nvidia_desktop())["heavy"]),
        7.1 * GIB
    );
}

#[tokio::test]
async fn takes_the_lightest_one_here_when_the_light_tier_s_is_not() {
    let server = serve_models().await;
    let tts = |roots: PackageRoots| {
        low_gpu_choices(&roots, &none(), 64.0 * GIB, &none()).unwrap()["tts"].clone()
    };
    // Pocket TTS needs both its languages; then Kokoro on the CPU, the
    // other Kokoro on the CPU, then Kokoro on the GPU.
    assert_eq!(tts(without(&server, &["pocket-tts-en"])), "kokoro-onnx");
    assert_eq!(
        tts(without(&server, &["pocket-tts-fr", "kokoro-onnx"])),
        "kokoro-onnx-int8"
    );
    assert_eq!(
        tts(without(
            &server,
            &["pocket-tts-fr", "kokoro-onnx", "kokoro-onnx-int8"]
        )),
        "kokoro-82m"
    );
    let no_text_turn = without(&server, &["qwen3-0.6b-onnx"]);
    assert_eq!(
        low_gpu_choices(&no_text_turn, &none(), 64.0 * GIB, &none()).unwrap()["text_turn"],
        NO_MODEL
    );
    // With less memory, the light tier has no text turn model.
    assert_eq!(
        low_gpu_choices(&all(&server), &none(), 8.0 * GIB, &none()).unwrap()["text_turn"],
        NO_MODEL
    );
}

#[tokio::test]
async fn parts_set_by_hand_win_when_they_are_here() {
    let server = serve_models().await;
    let tts = |roots: &PackageRoots, wanted: &str| {
        low_gpu_choices(roots, &none(), 64.0 * GIB, &pick(&[("tts", wanted)])).unwrap()["tts"]
            .clone()
    };
    assert_eq!(tts(&all(&server), "kokoro-82m"), "kokoro-82m");
    assert_eq!(tts(&all(&server), "kokoro-onnx"), "kokoro-onnx");
    assert_eq!(
        tts(&without(&server, &["kokoro-82m"]), "kokoro-82m"),
        "pocket-tts"
    );
}

#[tokio::test]
async fn takes_pocket_tts_once_voice_json_reads_with_it_or_by_hand() {
    let server = serve_models().await;
    let all = all(&server);
    let qwen = json!({"model": "qwen3-tts", "path": "/q"});
    let pocket = json!({"model": "pocket-tts", "path": "/p/fr", "languages": "fr"});
    let config = |models: Value| json!({"tts_models": models}).as_object().unwrap().clone();
    // Its files alone: an older helper would hand it to any-tts.
    let before = low_gpu_roots(&all, &config(json!([qwen])), &none());
    assert!(!before.contains_key("pocket-tts-fr"));
    assert_eq!(before.get("kokoro-onnx"), all.get("kokoro-onnx"));
    assert_eq!(
        low_gpu_choices(&before, &none(), 64.0 * GIB, &none()).unwrap()["tts"],
        "kokoro-onnx"
    );
    assert_eq!(
        low_gpu_roots(&all, &config(json!([qwen, pocket])), &none()),
        all
    );
    assert_eq!(
        low_gpu_roots(&all, &Map::new(), &pick(&[("tts", "pocket-tts")])),
        all
    );
}

#[test]
fn keeps_voice_json_s_own_model_when_nothing_lighter_is_here() {
    let choices = low_gpu_choices(
        &PackageRoots::new(),
        &pick(&[("tts", "custom")]),
        64.0 * GIB,
        &none(),
    )
    .unwrap();
    assert_eq!(choices["tts"], "custom");
}

/// The desktop's models installed: light first, then heavy over it.
async fn desktop(home: &Home) {
    let deps = &home.home.deps;
    std::fs::create_dir_all(deps.helper_path.parent().unwrap()).unwrap();
    std::fs::write(&deps.helper_path, "").unwrap();
    let tiers = recommended_choices(&nvidia_desktop());
    for tier in ["light", "heavy"] {
        install_voice_models(&tiers[tier], deps, &InstallOptions::default())
            .await
            .unwrap();
    }
    let mut config: Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(&deps.config_path).unwrap()).unwrap();
    // voice.json's own settings, which the profile keeps.
    config.insert("front_model".into(), json!("opus"));
    config.insert("helper_idle_exit_minutes".into(), json!(10));
    std::fs::write(&deps.config_path, Value::Object(config).to_string()).unwrap();
}

#[derive(Default)]
struct FakeHelper {
    calls: Mutex<Vec<String>>,
    running: Mutex<Option<&'static str>>,
    busy: AtomicBool,
}

impl FakeHelper {
    fn new() -> Arc<Self> {
        let helper = Arc::new(Self::default());
        helper.set_running(Some("full"));
        helper
    }

    fn set_running(&self, running: Option<&'static str>) {
        *lock(&self.running) = running;
    }

    fn calls(&self) -> Vec<String> {
        lock(&self.calls).clone()
    }

    fn reload(&self, call: &str) -> Reload {
        lock(&self.calls).push(call.into());
        let mut running = lock(&self.running);
        if running.is_none() {
            return Reload::NotRunning;
        }
        if self.busy.load(Ordering::SeqCst) {
            return Reload::AfterCall;
        }
        *running = None;
        Reload::Now
    }
}

impl LowGpuHelper for FakeHelper {
    fn reload_models(&self) -> Reload {
        self.reload("reload")
    }

    fn reload_models_and_wait(&self) -> BoxFuture<Reload> {
        let result = self.reload("reload-and-wait");
        Box::pin(async move { result })
    }

    fn restart_models(&self) -> bool {
        lock(&self.calls).push("restart".into());
        true
    }

    fn running_profile(&self) -> Option<&'static str> {
        *lock(&self.running)
    }

    fn current_call_id(&self) -> Option<u64> {
        self.busy.load(Ordering::SeqCst).then_some(7)
    }

    fn speak_in_call(
        &self,
        call: u64,
        text: &str,
        _language: &str,
    ) -> BoxFuture<Result<(), String>> {
        lock(&self.calls).push(format!("say {call}: {text}"));
        Box::pin(async { Ok(()) })
    }
}

fn profile(
    home: &Home,
    helper: &Arc<FakeHelper>,
    game_mode: Option<bool>,
    clock: SharedClock,
) -> VoiceLowGpu {
    let config_path = home.home.deps.config_path.clone();
    let mut deps = LowGpuDeps::new(
        home.path.clone(),
        Arc::new(move || read_voice_config(&config_path)),
        home.home.deps.models_dir.clone(),
        helper.clone(),
    );
    deps.game_mode = Some(Arc::new(move || Box::pin(async move { game_mode })));
    deps.ram_bytes = Some(64.0 * GIB);
    deps.packages = Some(home.server.packages.clone());
    deps.retry_ms = Some(15_000);
    deps.clock = clock;
    VoiceLowGpu::new(deps)
}

fn system() -> SharedClock {
    Arc::new(SystemClock)
}

fn models_of(config: &VoiceConfig) -> Vec<String> {
    config.raw["tts_models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["model"].as_str().unwrap().to_owned())
        .collect()
}

fn text(path: PathBuf) -> Value {
    json!(path.display().to_string())
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn puts_its_set_over_voice_json_while_on_voice_json_untouched() {
    let home = home().await;
    desktop(&home).await;
    let deps = &home.home.deps;
    let before = std::fs::read_to_string(&deps.config_path).unwrap();
    let helper = FakeHelper::new();
    let low = profile(&home, &helper, None, system());
    let full = low.config().unwrap();
    // Qwen3-TTS reads, Kokoro-82M beside it, on the GPU, and Pocket TTS
    // last, when Qwen3-TTS fails.
    assert!(
        full.raw["clone_model"]
            .as_str()
            .unwrap()
            .contains("Qwen3-TTS-1.7B-Base")
    );
    assert_eq!(models_of(&full), ["kokoro", "pocket-tts", "pocket-tts"]);
    assert_eq!(full.raw.get("low_gpu"), None);

    hold_low_gpu(&home.path, &hold(true, Some("gaming")), 1.0).unwrap();
    let light = low.config().unwrap();
    assert_eq!(light.raw["low_gpu"], "gaming");
    assert_eq!(light.raw["yield_cpu"], json!({"threads": 4}));
    // Pocket TTS reads French and English, on the CPU (no Kokoro ONNX
    // model here for the other languages).
    let models = &deps.models_dir;
    assert_eq!(
        light.raw["tts_models"],
        json!([
            {
                "model": "pocket-tts",
                "path": text(models.join("pocket-tts-fr").join("languages").join("french")),
                "languages": "fr",
                "voice": "estelle",
            },
            {
                "model": "pocket-tts",
                "path": text(models.join("pocket-tts-en").join("languages").join("english")),
                "languages": "en",
                "voice": "alba",
            },
        ])
    );
    for gone in ["clone_model", "whisper_model", "kokoro_model"] {
        assert_eq!(light.raw.get(gone), None, "{gone}");
    }
    for kept in ["parakeet_model", "speaker_model", "text_turn_model"] {
        assert_eq!(light.raw.get(kept), full.raw.get(kept), "{kept}");
    }
    // Its other settings stay.
    assert_eq!(light.raw["front_model"], "opus");
    assert_eq!(light.raw["helper_idle_exit_minutes"], 10);
    assert_eq!(light.raw["helper"], text(deps.helper_path.clone()));
    assert_eq!(std::fs::read_to_string(&deps.config_path).unwrap(), before);

    // Another holder than a game: the GPU is freed, the CPU not yielded.
    hold_low_gpu(&home.path, &hold(false, Some("gaming")), 2.0).unwrap();
    hold_low_gpu(&home.path, &hold(true, Some("render")), 3.0).unwrap();
    let render = low.config().unwrap();
    assert_eq!(render.raw["low_gpu"], "render");
    assert_eq!(render.raw.get("yield_cpu"), None);
    hold_low_gpu(&home.path, &hold(false, Some("render")), 4.0).unwrap();
    hold_low_gpu(&home.path, &hold(true, Some("gaming")), 5.0).unwrap();

    let status = low.status();
    assert_eq!(status["active"], true);
    assert_eq!(status["reason"], "gaming");
    assert_eq!(status["holders"], json!(["gaming"]));
    assert_eq!(status["running"], "full");
    assert_eq!(status["gpuBytes"], 0);
    let tts = status["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["component"] == "tts")
        .unwrap();
    assert_eq!(tts["name"], "Pocket TTS");
    assert_eq!(tts["runsOn"], "cpu");
}

#[tokio::test]
async fn kokoro_s_onnx_model_when_here_reads_beside_pocket_tts() {
    let home = home().await;
    desktop(&home).await;
    let deps = &home.home.deps;
    let tiers = recommended_choices(&nvidia_desktop());
    let mut onnx_light = tiers["light"].clone();
    onnx_light.insert("tts".into(), "kokoro-onnx".into());
    install_voice_models(&onnx_light, deps, &InstallOptions::default())
        .await
        .unwrap();
    install_voice_models(&tiers["heavy"], deps, &InstallOptions::default())
        .await
        .unwrap();
    hold_low_gpu(&home.path, &hold(true, Some("gaming")), 1.0).unwrap();
    let light = profile(&home, &FakeHelper::new(), None, system())
        .config()
        .unwrap();
    let onnx = text(deps.models_dir.join("kokoro-v1.0.onnx"));
    assert_eq!(light.raw["kokoro_model"], onnx);
    assert_eq!(
        light.raw["kokoro_voices"],
        text(deps.models_dir.join("voices-v1.0.bin"))
    );
    assert_eq!(models_of(&light), ["pocket-tts", "pocket-tts", "kokoro"]);
    assert_eq!(
        light.raw["tts_models"][2],
        json!({"model": "kokoro", "path": onnx})
    );
}

#[tokio::test]
async fn a_free_helper_with_the_other_set_stops_at_once() {
    let home = home().await;
    desktop(&home).await;
    let helper = FakeHelper::new();
    let low = profile(&home, &helper, None, system());
    assert_eq!(low.apply(false).await, "in-effect");
    hold_low_gpu(&home.path, &hold(true, Some("gaming")), 1.0).unwrap();
    assert_eq!(low.apply(false).await, "now");
    assert_eq!(helper.calls(), ["reload"]);
    assert_eq!(low.apply(false).await, "not-running");
}

#[tokio::test]
async fn a_call_keeps_its_set_until_it_ends_then_the_helper_stops() {
    let home = home().await;
    desktop(&home).await;
    let clock = TestClock::new(1_700_000_000_000);
    let helper = FakeHelper::new();
    helper.busy.store(true, Ordering::SeqCst);
    let low = profile(&home, &helper, None, Arc::new(clock.clone()));
    assert_eq!(
        low.hold(&hold(true, Some("gaming"))).await.unwrap(),
        "after-call"
    );
    assert_eq!(low.status()["pending"], true);
    clock.advance(15_000).await;
    settle().await;
    assert_eq!(helper.calls(), ["reload", "reload"]);
    assert_eq!(helper.running_profile(), Some("full"));
    // The call ends: the next try stops the helper, and the tries end.
    helper.busy.store(false, Ordering::SeqCst);
    clock.advance(15_000).await;
    settle().await;
    assert_eq!(helper.running_profile(), None);
    assert_eq!(low.status()["pending"], false);
    clock.advance(60_000).await;
    settle().await;
    assert_eq!(helper.calls(), ["reload", "reload", "reload"]);
}

#[tokio::test]
async fn let_go_before_the_call_ends_nothing_switches() {
    let home = home().await;
    desktop(&home).await;
    let clock = TestClock::new(1_700_000_000_000);
    let helper = FakeHelper::new();
    helper.busy.store(true, Ordering::SeqCst);
    let low = profile(&home, &helper, None, Arc::new(clock.clone()));
    low.hold(&hold(true, Some("gaming"))).await.unwrap();
    low.hold(&hold(false, Some("gaming"))).await.unwrap();
    assert_eq!(low.status()["pending"], false);
    helper.busy.store(false, Ordering::SeqCst);
    clock.advance(60_000).await;
    settle().await;
    assert_eq!(helper.running_profile(), Some("full"));
}

#[tokio::test]
async fn now_switches_a_call_at_once_after_a_notice_on_it() {
    let home = home().await;
    desktop(&home).await;
    let helper = FakeHelper::new();
    helper.busy.store(true, Ordering::SeqCst);
    let low = profile(&home, &helper, None, system());
    let now = HoldChange {
        now: true,
        ..hold(true, Some("gaming"))
    };
    assert_eq!(low.hold(&now).await.unwrap(), "now");
    assert_eq!(
        helper.calls(),
        [
            "reload".to_owned(),
            format!("say 7: {}", switch_notice("low-gpu")),
            "restart".to_owned(),
        ]
    );
}

#[tokio::test]
async fn gamemode_at_a_call_s_start_turns_it_on_and_a_free_helper_is_restarted_for_the_call() {
    let home = home().await;
    desktop(&home).await;
    let helper = FakeHelper::new();
    let low = profile(&home, &helper, Some(true), system());
    assert!(!low.active());
    low.before_call().await;
    assert_eq!(low.reason().as_deref(), Some("GameMode"));
    assert_eq!(helper.calls(), ["reload-and-wait"]);
    assert_eq!(low.config().unwrap().raw["low_gpu"], "GameMode");
    assert_eq!(
        low.config().unwrap().raw["yield_cpu"],
        json!({"threads": 4})
    );
    // A helper with the right set is left alone.
    helper.set_running(Some("low-gpu"));
    low.before_call().await;
    assert_eq!(helper.calls(), ["reload-and-wait"]);
}

#[tokio::test]
async fn gamemode_gone_at_the_next_call_the_full_set_comes_back() {
    let home = home().await;
    desktop(&home).await;
    let helper = FakeHelper::new();
    helper.set_running(Some("low-gpu"));
    profile(&home, &helper, Some(false), system())
        .before_call()
        .await;
    assert_eq!(helper.calls(), ["reload-and-wait"]);
}

#[tokio::test]
async fn a_voice_json_in_error_is_left_as_it_is() {
    let home = home().await;
    hold_low_gpu(&home.path, &hold(true, None), 1.0).unwrap();
    let low = profile(&home, &FakeHelper::new(), None, system());
    assert_eq!(
        low.config().unwrap_err(),
        format!(
            "No voice configuration ({})",
            home.home.deps.config_path.display()
        )
    );
}
