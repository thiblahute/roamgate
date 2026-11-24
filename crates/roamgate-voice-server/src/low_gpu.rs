//! The low-GPU voice profile (server/src/voice/voice-low-gpu.ts): while
//! something else needs the GPU (a game, another job), the voice helper
//! starts with a lighter set of models, the setup assistant's light tier
//! among the models already here. voice.json is never written: the set is
//! put over it (config_patch) on the configuration the helper starts with.
//!
//! It is on while a holder holds it (`roamgate voice profile low-gpu on
//! --by <name>`, the settings' switch) or GameMode runs as a call starts.
//! The holders are kept in the voice's data directory (low_gpu_path): the
//! CLI writes them there, the server watches the file. A helper running
//! with the other set stops once nothing needs it, the next request
//! starting it with the right one; `--now` restarts it at once, its call
//! made again after a short notice. On for a game, the helper also yields
//! the CPU to it (yield_cpu).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use roamgate_base::clock::{BoxFuture, SharedClock, SystemClock};
use roamgate_base::json::js_value;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::task::AbortHandle;

use crate::config::VoiceConfig;
use crate::hardware::{Cpu, VoiceHardware};
use crate::helper::{BeforeCall, ConfigSource, ErrorSink, Reload, VoiceHelper};
use crate::models::{
    CUSTOM_MODEL, ModelPackage, NO_MODEL, POCKET_MODEL, PackageRoots, VOICE_COMPONENTS,
    VoiceChoices, choices_json, components, config_patch, normalize_choices, option_of, options,
    packages, recommended_choices, voice_data_dir,
};
use crate::setup::{current_choices, locate_packages};

/// Who holds the profile on when nobody names themselves.
pub const MANUAL_HOLDER: &str = "manual";
/// The holder `roamgate voice gaming` uses.
pub const GAMING_HOLDER: &str = "gaming";
/// Said for GameMode found running as a call starts (`gamemoded -s`).
pub const GAMEMODE_REASON: &str = "GameMode";
/// The ONNX threads of a helper yielding the CPU to a game, unless
/// voice.json's gaming_cpu_threads says otherwise.
pub const GAMING_CPU_THREADS: f64 = 4.0;
/// How often a switch waiting for a call's end tries again, by default.
pub const RETRY_MS: u64 = 15_000;
/// How long the switch notice may take on a call.
const NOTICE_MS: u64 = 10_000;

/// Said on the call before its helper restarts for the other set.
pub fn switch_notice(wanted: &str) -> &'static str {
    if wanted == "low-gpu" {
        "Switching to the light voice, one moment."
    } else {
        "Switching back to the full voice, one moment."
    }
}

/// low-gpu.json: who holds it on and since when (ms since the epoch), the
/// parts set by hand over the light tier, and the last ask to switch now.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LowGpuFile {
    pub holders: Map<String, Value>,
    pub models: Option<Map<String, Value>>,
    pub now: Option<f64>,
}

impl LowGpuFile {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("holders".into(), Value::Object(self.holders.clone()));
        if let Some(models) = &self.models {
            out.insert("models".into(), Value::Object(models.clone()));
        }
        if let Some(now) = self.now {
            out.insert("now".into(), json!(now));
        }
        js_value(Value::Object(out))
    }

    /// The parts set by hand, as choices.
    pub fn overrides(&self) -> VoiceChoices {
        self.models
            .iter()
            .flatten()
            .filter_map(|(part, id)| Some((part.clone(), id.as_str()?.to_owned())))
            .collect()
    }
}

pub fn low_gpu_path(home: &Path, platform: &str, app_data: Option<&Path>) -> PathBuf {
    voice_data_dir(home, platform, app_data).join("low-gpu.json")
}

/// A holder's name: letters, digits, dot, dash, underscore.
pub fn is_holder_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn read_low_gpu(path: &Path) -> LowGpuFile {
    let mut file = LowGpuFile::default();
    let Some(parsed) = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return file;
    };
    let Value::Object(raw) = js_value(parsed) else {
        return file;
    };
    if let Some(Value::Object(holders)) = raw.get("holders") {
        for (name, since) in holders {
            if is_holder_name(name) && since.is_number() {
                file.holders.insert(name.clone(), since.clone());
            }
        }
    }
    if let Some(Value::Object(models)) = raw.get("models") {
        let kept: Map<String, Value> = models
            .iter()
            .filter(|(part, id)| VOICE_COMPONENTS.contains(&part.as_str()) && id.is_string())
            .map(|(part, id)| (part.clone(), id.clone()))
            .collect();
        if !kept.is_empty() {
            file.models = Some(kept);
        }
    }
    file.now = raw.get("now").and_then(Value::as_f64);
    file
}

/// Writes `file` whole, so a reader never sees half of it.
pub fn write_low_gpu(path: &Path, file: &LowGpuFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::profiles::create_private_dirs(dir).map_err(|error| error.to_string())?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(
        &temporary,
        format!("{}\n", crate::js::stringify_pretty(&file.to_json())),
    )
    .map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// A holder holding the profile on, or letting it go.
#[derive(Debug, Clone, Default)]
pub struct HoldChange {
    pub on: bool,
    pub holder: Option<String>,
    pub now: bool,
}

/// `holder` holds the profile on, or lets it go; off without a holder lets
/// every holder go. With `now`, a call going on switches at once.
pub fn hold_low_gpu(path: &Path, change: &HoldChange, at: f64) -> Result<LowGpuFile, String> {
    let mut file = read_low_gpu(path);
    if let Some(holder) = &change.holder
        && !is_holder_name(holder)
    {
        return Err(format!(
            "{holder}: a holder is letters, digits, dots, dashes or underscores"
        ));
    }
    if change.on {
        let name = change.holder.as_deref().unwrap_or(MANUAL_HOLDER);
        if !file.holders.contains_key(name) {
            file.holders.insert(name.into(), json!(at));
        }
    } else if let Some(holder) = &change.holder {
        file.holders.shift_remove(holder);
    } else {
        file.holders.clear();
    }
    if change.now {
        file.now = Some(at);
    }
    write_low_gpu(path, &file)?;
    Ok(read_low_gpu(path))
}

/// Sets parts of the low-GPU set by hand; None goes back to the light tier.
pub fn set_low_gpu_models(
    path: &Path,
    models: Option<&Map<String, Value>>,
) -> Result<LowGpuFile, String> {
    let mut file = read_low_gpu(path);
    match models.filter(|models| !models.is_empty()) {
        None => file.models = None,
        Some(models) => {
            // Unknown options fail here, not when the helper starts.
            let choices: VoiceChoices = models
                .iter()
                .filter_map(|(part, id)| Some((part.clone(), id.as_str()?.to_owned())))
                .collect();
            normalize_choices(&choices)?;
            let mut merged = file.models.take().unwrap_or_default();
            for (part, id) in models {
                merged.insert(part.clone(), id.clone());
            }
            file.models = Some(merged);
        }
    }
    write_low_gpu(path, &file)?;
    Ok(read_low_gpu(path))
}

/// The machine as recommended_choices' light tier needs it: its memory.
fn machine(ram_bytes: f64) -> VoiceHardware {
    VoiceHardware {
        platform: crate::hardware::node_platform().into(),
        arch: crate::hardware::node_arch().into(),
        os_name: None,
        cpu: Cpu {
            model: String::new(),
            cores: 0.0,
        },
        ram_bytes,
        gpus: Vec::new(),
        acceleration: "cpu".into(),
        gpu_bytes: 0.0,
        note: None,
    }
}

fn installed(component: &str, id: &str, roots: &PackageRoots) -> bool {
    id == NO_MODEL
        || option_of(component, Some(id))
            .is_some_and(|option| option.packages.iter().all(|id| roots.contains_key(id)))
}

/// GPU memory an option takes: none on the CPU.
fn gpu_of(component: &str, id: Option<&str>) -> f64 {
    option_of(component, id)
        .filter(|option| option.runs_on != "cpu")
        .map_or(0.0, |option| option.gpu_bytes.unwrap_or(0.0))
}

/// The low-GPU set among the models at `roots`: for each part, the one set
/// by hand (`overrides`), else the light tier's, when it is here; else the
/// lightest one here (the CPU's first, then the least GPU memory); else
/// none for an optional part, or what voice.json has (`current`). Nothing
/// is downloaded.
pub fn low_gpu_choices(
    roots: &PackageRoots,
    current: &VoiceChoices,
    ram_bytes: f64,
    overrides: &VoiceChoices,
) -> Result<VoiceChoices, String> {
    let light = recommended_choices(&machine(ram_bytes))
        .remove("light")
        .unwrap_or_default();
    let mut choices = VoiceChoices::new();
    for spec in components() {
        let wanted = [overrides.get(&spec.id), light.get(&spec.id)]
            .into_iter()
            .flatten()
            .find(|id| installed(&spec.id, id, roots));
        if let Some(wanted) = wanted {
            choices.insert(spec.id.clone(), wanted.clone());
            continue;
        }
        let mut here: Vec<_> = options()
            .iter()
            .filter(|option| {
                option.component == spec.id
                    && installed(&spec.id, &option.id, roots)
                    // A heavy model is no lighter choice for an optional part.
                    && (!spec.optional || option.runs_on != "gpu")
            })
            .collect();
        here.sort_by(|a, b| {
            let key = |option: &crate::models::ModelOption| {
                (
                    f64::from(u8::from(option.runs_on == "gpu")),
                    gpu_of(&spec.id, Some(&option.id)),
                )
            };
            key(a)
                .partial_cmp(&key(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let chosen = match here.first() {
            Some(option) => option.id.clone(),
            None if spec.optional => NO_MODEL.into(),
            None => current
                .get(&spec.id)
                .cloned()
                .unwrap_or_else(|| CUSTOM_MODEL.into()),
        };
        choices.insert(spec.id.clone(), chosen);
    }
    normalize_choices(&choices)
}

/// The packages at `roots` the low-GPU set may take: Pocket TTS's only once
/// voice.json reads with it (its entries in `tts_models`) or the set names
/// it by hand. Its files alone are no sign the helper reads it: an older
/// helper hands its entries to any-tts, which fails, and the call would go
/// silent.
pub fn low_gpu_roots(
    roots: &PackageRoots,
    config: &Map<String, Value>,
    overrides: &VoiceChoices,
) -> PackageRoots {
    let reads_pocket = config
        .get("tts_models")
        .and_then(Value::as_array)
        .is_some_and(|models| {
            models
                .iter()
                .any(|model| model.get("model").and_then(Value::as_str) == Some(POCKET_MODEL))
        });
    if overrides.get("tts").map(String::as_str) == Some("pocket-tts") || reads_pocket {
        return roots.clone();
    }
    let pocket = option_of("tts", Some("pocket-tts"))
        .map(|option| option.packages.clone())
        .unwrap_or_default();
    roots
        .iter()
        .filter(|(id, _)| !pocket.contains(id))
        .map(|(id, root)| (id.clone(), root.clone()))
        .collect()
}

/// The GPU memory the choices take, as the catalog estimates it.
pub fn gpu_bytes_for(choices: &VoiceChoices) -> f64 {
    let mut counted: Vec<String> = Vec::new();
    let mut bytes = 0.0;
    for spec in components() {
        let id = choices.get(&spec.id).map(String::as_str);
        let Some(option) = option_of(&spec.id, id) else {
            continue;
        };
        // Whisper reading again is the same model as Whisper hearing.
        let key = option.packages.first().cloned().unwrap_or_default();
        if counted.contains(&key) {
            continue;
        }
        counted.push(key);
        bytes += gpu_of(&spec.id, id);
    }
    bytes
}

/// A part of the set for people (LowGpuModel).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LowGpuModel {
    pub component: String,
    /// The part, as the setup assistant names it ("Reading voice").
    pub title: String,
    /// The model, or "none".
    pub name: String,
    pub runs_on: String,
}

/// The choices for people: each part, its model and where it runs.
pub fn describe_choices(choices: &VoiceChoices) -> Vec<LowGpuModel> {
    components()
        .iter()
        .map(|spec| {
            let id = choices.get(&spec.id).map(String::as_str);
            let option = option_of(&spec.id, id);
            LowGpuModel {
                component: spec.id.clone(),
                title: spec.title.clone(),
                name: match option {
                    Some(option) => option.name.clone(),
                    None if id == Some(CUSTOM_MODEL) => "as in voice.json".into(),
                    None => id.unwrap_or(NO_MODEL).into(),
                },
                runs_on: option.map_or_else(|| "none".into(), |option| option.runs_on.clone()),
            }
        })
        .collect()
}

/// Whether the profile is on for a game: the gaming holder or GameMode.
pub fn for_gaming(reason: &str) -> bool {
    reason
        .split(", ")
        .any(|name| name == GAMING_HOLDER || name == GAMEMODE_REASON)
}

/// How the helper yields the CPU while the profile is on for `reason`: None
/// when it is not for a game.
pub fn yield_cpu(config: &Map<String, Value>, reason: &str) -> Option<Value> {
    if !for_gaming(reason) {
        return None;
    }
    let threads = match config.get("gaming_cpu_threads") {
        None | Some(Value::Null) => json!(GAMING_CPU_THREADS),
        Some(threads) => threads.clone(),
    };
    Some(js_value(json!({ "threads": threads })))
}

/// `config` with the low-GPU set's models in place of its own, `low_gpu`
/// saying why and, for a game, `yield_cpu`; its other settings as they are.
pub fn low_gpu_config(
    config: &VoiceConfig,
    choices: &VoiceChoices,
    roots: &PackageRoots,
    reason: &str,
    packages: &[ModelPackage],
) -> Result<VoiceConfig, String> {
    let mut patched = config.raw.clone();
    for (key, value) in config_patch(choices, roots, &config.raw, packages)? {
        match value {
            None => {
                patched.shift_remove(&key);
            }
            Some(value) => {
                patched.insert(key, value);
            }
        }
    }
    patched.insert("low_gpu".into(), json!(reason));
    if let Some(cpu) = yield_cpu(&config.raw, reason) {
        patched.insert("yield_cpu".into(), cpu);
    }
    Ok(VoiceConfig { raw: patched })
}

/// What the profile asks of the voice helper.
pub trait LowGpuHelper: Send + Sync + 'static {
    fn reload_models(&self) -> Reload;
    fn reload_models_and_wait(&self) -> BoxFuture<Reload>;
    fn restart_models(&self) -> bool;
    /// "low-gpu" or "full", None when none runs.
    fn running_profile(&self) -> Option<&'static str>;
    fn current_call_id(&self) -> Option<u64>;
    fn speak_in_call(&self, call: u64, text: &str, language: &str)
    -> BoxFuture<Result<(), String>>;
}

impl LowGpuHelper for VoiceHelper {
    fn reload_models(&self) -> Reload {
        VoiceHelper::reload_models(self)
    }

    fn reload_models_and_wait(&self) -> BoxFuture<Reload> {
        let helper = self.clone();
        Box::pin(async move { VoiceHelper::reload_models_and_wait(&helper).await })
    }

    fn restart_models(&self) -> bool {
        VoiceHelper::restart_models(self)
    }

    fn running_profile(&self) -> Option<&'static str> {
        VoiceHelper::running_profile(self)
    }

    fn current_call_id(&self) -> Option<u64> {
        VoiceHelper::current_call_id(self)
    }

    fn speak_in_call(
        &self,
        call: u64,
        text: &str,
        language: &str,
    ) -> BoxFuture<Result<(), String>> {
        let helper = self.clone();
        let text = text.to_owned();
        let language = language.to_owned();
        Box::pin(async move {
            VoiceHelper::speak_in_call(&helper, call, &text, Some(&language), None, None)
                .await
                .map(|_| ())
        })
    }
}

/// Whether GameMode runs, asked as a call starts.
pub type GameMode = Arc<dyn Fn() -> BoxFuture<Option<bool>> + Send + Sync>;

/// What the profile reads and drives (LowGpuDeps).
pub struct LowGpuDeps {
    pub path: PathBuf,
    /// voice.json, as the helper reads it.
    pub read_config: ConfigSource,
    /// The models directory, where the setup assistant downloads.
    pub models_dir: PathBuf,
    pub helper: Arc<dyn LowGpuHelper>,
    pub game_mode: Option<GameMode>,
    pub ram_bytes: Option<f64>,
    /// The catalog's packages; tests give small files.
    pub packages: Option<Vec<ModelPackage>>,
    /// How often a switch waiting for a call's end tries again.
    pub retry_ms: Option<u64>,
    pub clock: SharedClock,
    /// Where its notices go (Bun's console.error): stderr by default.
    pub errors: ErrorSink,
}

impl LowGpuDeps {
    pub fn new(
        path: PathBuf,
        read_config: ConfigSource,
        models_dir: PathBuf,
        helper: Arc<dyn LowGpuHelper>,
    ) -> Self {
        Self {
            path,
            read_config,
            models_dir,
            helper,
            game_mode: None,
            ram_bytes: None,
            packages: None,
            retry_ms: None,
            clock: Arc::new(SystemClock),
            errors: Arc::new(|line| eprintln!("{line}")),
        }
    }

    fn packages(&self) -> &[ModelPackage] {
        self.packages.as_deref().unwrap_or_else(|| packages())
    }
}

/// The profile's state (LowGpuStatus), as the wire has it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    active: bool,
    reason: Option<String>,
    holders: Vec<String>,
    game_mode: Option<bool>,
    running: Option<&'static str>,
    pending: bool,
    choices: Value,
    models: Vec<LowGpuModel>,
    gpu_bytes: f64,
    overrides: Value,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone)]
struct Cached {
    key: String,
    choices: VoiceChoices,
    roots: PackageRoots,
}

#[derive(Default)]
struct State {
    game_mode: Option<bool>,
    retry: Option<AbortHandle>,
    seen_now: f64,
    cache: Option<Cached>,
    last_error: Option<String>,
}

struct Inner {
    deps: LowGpuDeps,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn mtime_ms(path: &Path) -> f64 {
    std::fs::metadata(path)
        .map(|meta| roamgate_agents::paths::mtime_ms(&meta))
        .unwrap_or(0.0)
}

fn set_name(wanted: &str) -> &'static str {
    if wanted == "low-gpu" {
        "low-GPU"
    } else {
        "full"
    }
}

/// The low-GPU profile (VoiceLowGpu).
#[derive(Clone)]
pub struct VoiceLowGpu {
    inner: Arc<Inner>,
}

impl VoiceLowGpu {
    pub fn new(deps: LowGpuDeps) -> Self {
        let seen_now = read_low_gpu(&deps.path).now.unwrap_or(0.0);
        Self {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::new(State {
                    seen_now,
                    ..State::default()
                }),
            }),
        }
    }

    fn deps(&self) -> &LowGpuDeps {
        &self.inner.deps
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.inner.state)
    }

    fn file(&self) -> LowGpuFile {
        read_low_gpu(&self.deps().path)
    }

    fn reason_of(&self, file: &LowGpuFile) -> Option<String> {
        let mut names: Vec<String> = file.holders.keys().cloned().collect();
        if self.state().game_mode == Some(true) {
            names.push(GAMEMODE_REASON.into());
        }
        (!names.is_empty()).then(|| names.join(", "))
    }

    /// Who it is on for, None when off.
    pub fn reason(&self) -> Option<String> {
        self.reason_of(&self.file())
    }

    pub fn active(&self) -> bool {
        self.reason().is_some()
    }

    /// The set on this machine for voice.json `config`, and its roots.
    fn set(&self, config: &VoiceConfig, file: &LowGpuFile) -> Result<Cached, String> {
        let deps = self.deps();
        let models = Value::Object(file.models.clone().unwrap_or_default());
        let key = crate::js::stringify(&json!([
            Value::Object(config.raw.clone()),
            models,
            mtime_ms(&deps.models_dir)
        ]));
        if let Some(cached) = self
            .state()
            .cache
            .clone()
            .filter(|cached| cached.key == key)
        {
            return Ok(cached);
        }
        let overrides = file.overrides();
        let roots = low_gpu_roots(
            &locate_packages(&config.raw, &deps.models_dir, deps.packages()),
            &config.raw,
            &overrides,
        );
        let ram = deps
            .ram_bytes
            .unwrap_or_else(|| (crate::hardware::system_probe().ram_bytes)());
        let choices = low_gpu_choices(
            &roots,
            &current_choices(&config.raw, &roots, deps.packages()),
            ram,
            &overrides,
        )?;
        let cached = Cached {
            key,
            choices,
            roots,
        };
        self.state().cache = Some(cached.clone());
        Ok(cached)
    }

    /// The configuration the helper starts with: voice.json as it is, or
    /// with the low-GPU set while the profile is on. Its error, if any, as
    /// read_voice_config gives it; a set that cannot be made leaves
    /// voice.json's models (logged).
    pub fn config_of(&self, raw: Result<VoiceConfig, String>) -> Result<VoiceConfig, String> {
        let raw = raw?;
        let file = self.file();
        let Some(reason) = self.reason_of(&file) else {
            return Ok(raw);
        };
        let made = self.set(&raw, &file).and_then(|set| {
            low_gpu_config(
                &raw,
                &set.choices,
                &set.roots,
                &reason,
                self.deps().packages(),
            )
        });
        match made {
            Ok(config) => {
                self.state().last_error = None;
                Ok(config)
            }
            Err(message) => {
                let mut state = self.state();
                if state.last_error.as_deref() != Some(message.as_str()) {
                    (self.deps().errors)(&format!(
                        "[voice] the low-GPU set cannot be made ({message}): voice.json's models are used"
                    ));
                }
                state.last_error = Some(message);
                Ok(raw)
            }
        }
    }

    pub fn config(&self) -> Result<VoiceConfig, String> {
        self.config_of((self.deps().read_config)())
    }

    /// The configuration source the helper starts with.
    pub fn config_source(&self) -> ConfigSource {
        let profile = self.clone();
        Arc::new(move || profile.config())
    }

    pub fn status(&self) -> Value {
        let file = self.file();
        let reason = self.reason_of(&file);
        let mut choices = VoiceChoices::new();
        let mut error = None;
        match (self.deps().read_config)() {
            Err(message) => error = Some(message),
            Ok(raw) => match self.set(&raw, &file) {
                Ok(set) => choices = set.choices,
                Err(message) => error = Some(message),
            },
        }
        let (game_mode, pending) = {
            let state = self.state();
            (state.game_mode, state.retry.is_some())
        };
        let status = Status {
            active: reason.is_some(),
            reason,
            holders: file.holders.keys().cloned().collect(),
            game_mode,
            running: self.deps().helper.running_profile(),
            pending,
            choices: choices_json(&choices),
            models: describe_choices(&choices),
            gpu_bytes: gpu_bytes_for(&choices),
            overrides: Value::Object(file.models.clone().unwrap_or_default()),
            path: self.deps().path.display().to_string(),
            error,
        };
        js_value(serde_json::to_value(status).unwrap_or(Value::Null))
    }

    fn wanted(&self) -> &'static str {
        if self.active() { "low-gpu" } else { "full" }
    }

    fn stop_retry(&self) {
        if let Some(retry) = self.state().retry.take() {
            retry.abort();
        }
    }

    /// The running helper takes the profile as it is now: one with the
    /// other set stops when free (the next request starts the right one),
    /// else once its call ends, or with `now` restarts at once after a
    /// notice on the call. Answers in-effect, now, after-call or
    /// not-running.
    pub fn apply(&self, now: bool) -> BoxFuture<&'static str> {
        let profile = self.clone();
        Box::pin(async move { profile.applied(now).await })
    }

    async fn applied(&self, now: bool) -> &'static str {
        let wanted = self.wanted();
        let helper = self.deps().helper.clone();
        let running = helper.running_profile();
        if running.is_none() || running == Some(wanted) {
            self.stop_retry();
            return if running.is_none() {
                "not-running"
            } else {
                "in-effect"
            };
        }
        let result = helper.reload_models();
        if result != Reload::AfterCall {
            self.stop_retry();
            return result.as_str();
        }
        if now {
            self.stop_retry();
            self.notice(wanted).await;
            // The call may have ended while the notice was said.
            if helper.running_profile() == Some(wanted) {
                return "in-effect";
            }
            if !helper.restart_models() {
                return "not-running";
            }
            (self.deps().errors)(&format!(
                "[voice] restarting the voice helper now for its {} models",
                set_name(wanted)
            ));
            return "now";
        }
        let mut state = self.state();
        if state.retry.is_none() {
            (self.deps().errors)(&format!(
                "[voice] the voice helper switches to its {} models once the call ends",
                set_name(wanted)
            ));
            let period = Duration::from_millis(self.deps().retry_ms.unwrap_or(RETRY_MS));
            let mut interval = self.deps().clock.interval(period);
            let profile = self.clone();
            let task = tokio::spawn(async move {
                loop {
                    interval.tick().await;
                    profile.apply(false).await;
                }
            });
            state.retry = Some(task.abort_handle());
        }
        "after-call"
    }

    async fn notice(&self, wanted: &str) {
        let helper = self.deps().helper.clone();
        let Some(call) = helper.current_call_id() else {
            return;
        };
        let said = roamgate_base::clock::timeout(
            self.deps().clock.as_ref(),
            Duration::from_millis(NOTICE_MS),
            helper.speak_in_call(call, switch_notice(wanted), "en"),
        )
        .await;
        if let Ok(Err(message)) = said {
            (self.deps().errors)(&format!(
                "[voice] the switch notice was not said: {message}"
            ));
        }
    }

    /// Holds or lets go (the settings' switch), then applies it.
    pub async fn hold(&self, change: &HoldChange) -> Result<&'static str, String> {
        let at = self.deps().clock.now() as f64;
        let file = hold_low_gpu(&self.deps().path, change, at)?;
        if let Some(now) = file.now.filter(|now| *now != 0.0) {
            self.state().seen_now = now;
        }
        Ok(self.apply(change.now).await)
    }

    /// As a call starts (the helper's before-call hook): GameMode asked
    /// again, and a helper with the other set, now free, stopped and waited
    /// for so the call starts one with the right set.
    pub async fn before_call(&self) {
        if let Some(game_mode) = &self.deps().game_mode {
            let found = game_mode().await;
            self.state().game_mode = found;
        }
        let helper = self.deps().helper.clone();
        let running = helper.running_profile();
        if running.is_none() || running == Some(self.wanted()) {
            return;
        }
        if helper.reload_models_and_wait().await == Reload::Now {
            (self.deps().errors)(&format!(
                "[voice] a call starts: the voice helper restarts with its {} models",
                set_name(self.wanted())
            ));
        }
    }

    /// The helper's before-call hook.
    pub fn before_call_hook(&self) -> BeforeCall {
        let profile = self.clone();
        Arc::new(move || {
            let profile = profile.clone();
            Box::pin(async move {
                profile.before_call().await;
                Ok(())
            })
        })
    }

    /// The file changed (watch's listener): a change applies at once, `now`
    /// when it asks for it.
    pub async fn changed(&self) -> &'static str {
        let file = self.file();
        let now = {
            let mut state = self.state();
            let asked = file.now.unwrap_or(0.0) > state.seen_now;
            if let Some(at) = file.now.filter(|at| *at != 0.0) {
                state.seen_now = state.seen_now.max(at);
            }
            state.cache = None;
            asked
        };
        self.apply(now).await
    }

    /// Follows the file the CLI writes, polled every `interval_ms` as
    /// watchFile does; dropping the answer stops it.
    pub fn watch(&self, interval_ms: u64) -> LowGpuWatch {
        let stamp = |path: &Path| {
            std::fs::metadata(path)
                .ok()
                .map(|meta| (roamgate_agents::paths::mtime_ms(&meta), meta.len()))
        };
        let path = self.deps().path.clone();
        let mut seen = stamp(&path);
        let mut interval = self
            .deps()
            .clock
            .interval(Duration::from_millis(interval_ms));
        let profile = self.clone();
        let task = tokio::spawn(async move {
            loop {
                interval.tick().await;
                let now = stamp(&path);
                if now != seen {
                    seen = now;
                    profile.changed().await;
                }
            }
        });
        LowGpuWatch {
            task: task.abort_handle(),
        }
    }
}

/// Stops the watch when dropped.
pub struct LowGpuWatch {
    task: AbortHandle,
}

impl Drop for LowGpuWatch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests;
