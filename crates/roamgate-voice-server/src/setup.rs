//! The voice setup assistant (server/src/voice/voice-setup.ts, `roamgate
//! setup voice` and the Voice settings' "Set up voice"): the hardware, the
//! models it calls for, what voice.json uses now and which of those files
//! are here; then the chosen models downloaded into the models directory
//! (download.rs) and voice.json pointed at them, its other settings
//! untouched.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::json::js_value;
use roamgate_base::paths::{dirname, resolve};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::config::{read_voice_config, update_voice_config};
use crate::download::{Abort, DownloadOptions, DownloadTarget, Fetch, download_file, part_path};
use crate::hardware::VoiceHardware;
use crate::models::{
    CUSTOM_MODEL, ModelPackage, NO_MODEL, POCKET_MODEL, POCKET_VOICES, PackageRoots, VoiceChoices,
    choices_json, components, config_patch, normalize_choices, option_of, options, package_by_id,
    package_bytes, package_path, packages, packages_for, pocket_model_dir, recommended_choices,
    tier_for,
};

/// Free bytes where a directory is; None when unknown.
pub type FreeBytes = Arc<dyn Fn(&Path) -> Option<f64> + Send + Sync>;
/// The hardware, detected when asked.
pub type HardwareSource = Arc<dyn Fn() -> VoiceHardware + Send + Sync>;

/// What the setup reads and writes (VoiceSetupDeps).
#[derive(Clone)]
pub struct SetupDeps {
    pub models_dir: PathBuf,
    pub config_path: PathBuf,
    /// The helper as installed, written to voice.json when it names none.
    pub helper_path: PathBuf,
    pub hardware: HardwareSource,
    /// The catalog's packages; tests give small files served locally.
    pub packages: Option<Vec<ModelPackage>>,
    pub fetch: Option<Fetch>,
    pub free_bytes: Option<FreeBytes>,
    /// Retry delay for downloads, in ms.
    pub retry_delay_ms: Option<u64>,
    pub clock: SharedClock,
}

impl SetupDeps {
    pub fn new(
        models_dir: PathBuf,
        config_path: PathBuf,
        helper_path: PathBuf,
        hardware: HardwareSource,
    ) -> Self {
        Self {
            models_dir,
            config_path,
            helper_path,
            hardware,
            packages: None,
            fetch: None,
            free_bytes: None,
            retry_delay_ms: None,
            clock: Arc::new(SystemClock),
        }
    }

    fn packages(&self) -> &[ModelPackage] {
        self.packages.as_deref().unwrap_or_else(|| packages())
    }

    fn free(&self) -> Option<f64> {
        match &self.free_bytes {
            Some(free) => free(&self.models_dir),
            None => disk_free(&self.models_dir),
        }
    }
}

/// A package the models directory holds that voice.json does not use.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedModel {
    /// The package id, or "partial" for a download left unfinished.
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SetupFile {
    pub name: String,
    pub size: f64,
    pub done: f64,
}

/// A download and its state (VoiceSetupJob), its keys in the order Bun's
/// object has them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupJob {
    /// downloading, writing, done, failed or cancelled.
    pub state: &'static str,
    pub files: Vec<SetupFile>,
    pub total_bytes: f64,
    pub done_bytes: f64,
    pub bytes_per_second: f64,
    pub started_at: f64,
    /// The file downloading now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<f64>,
    /// now, after-call or not-running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reload: Option<&'static str>,
}

impl SetupJob {
    fn new(downloads: &[Download], now: f64) -> Self {
        Self {
            state: "downloading",
            files: downloads
                .iter()
                .map(|file| SetupFile {
                    name: file.name.clone(),
                    size: file.target.size,
                    done: 0.0,
                })
                .collect(),
            total_bytes: downloads.iter().map(|file| file.target.size).sum(),
            done_bytes: 0.0,
            bytes_per_second: 0.0,
            started_at: now,
            current: None,
            error: None,
            finished_at: None,
            reload: None,
        }
    }

    /// As the wire has it.
    pub fn to_json(&self) -> Value {
        js_value(serde_json::to_value(self).unwrap_or(Value::Null))
    }
}

/// voice.json as written, whatever read_voice_config thinks of it.
pub fn raw_voice_config(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Free bytes on the disk of `dir`, or of its nearest existing parent (the
/// models directory may not exist yet).
pub fn disk_free(dir: &Path) -> Option<f64> {
    let mut at = resolve(dir);
    while !at.exists() && dirname(&at) != at {
        at = dirname(&at);
    }
    free_at(&at)
}

#[cfg(unix)]
fn free_at(path: &Path) -> Option<f64> {
    let stats = rustix::fs::statvfs(path).ok()?;
    Some(stats.f_bavail as f64 * stats.f_bsize as f64)
}

// The one Win32 call the voice setup makes; the workspace denies unsafe
// code everywhere else.
#[cfg(windows)]
#[allow(unsafe_code)]
fn free_at(path: &Path) -> Option<f64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    // SAFETY: a NUL-terminated path and a u64 to write; the other outputs
    // are optional and left null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available as f64)
}

#[cfg(not(any(unix, windows)))]
fn free_at(_path: &Path) -> Option<f64> {
    None
}

fn size_at(path: &Path) -> Option<f64> {
    std::fs::metadata(path).ok().map(|meta| meta.len() as f64)
}

/// The package's directory, or the loose files', in the models directory.
pub fn default_root(entry: &ModelPackage, models_dir: &Path) -> PathBuf {
    if entry.dir.is_empty() {
        models_dir.to_path_buf()
    } else {
        models_dir.join(&entry.dir)
    }
}

/// Whether every file of `entry` is under `root`, of the right size.
fn complete_at(entry: &ModelPackage, root: &Path) -> bool {
    entry
        .files
        .iter()
        .all(|file| size_at(&root.join(&file.path)) == Some(file.size))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn tts_models(config: &Map<String, Value>) -> Vec<&Map<String, Value>> {
    config
        .get("tts_models")
        .and_then(Value::as_array)
        .map(|models| models.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

/// The paths voice.json names that a package may be at.
fn configured_paths(config: &Map<String, Value>) -> Vec<String> {
    let keys = [
        "whisper_model",
        "parakeet_model",
        "kokoro_model",
        "kokoro_voices",
        "clone_model",
        "stock_model",
        "speaker_model",
        "turn_model",
        "text_turn_model",
    ];
    keys.iter()
        .map(|key| config.get(*key))
        .chain(
            tts_models(config)
                .into_iter()
                .map(|model| model.get("path")),
        )
        .filter_map(|value| value.and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Where each package is complete: where voice.json points at it first (the
/// desktop's models were put in place by hand), else in the models directory.
pub fn locate_packages(
    config: &Map<String, Value>,
    models_dir: &Path,
    packages: &[ModelPackage],
) -> PackageRoots {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for path in configured_paths(config) {
        let path = resolve(Path::new(&path));
        for candidate in [path.clone(), dirname(&path)] {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }
    let mut roots = PackageRoots::new();
    for entry in packages {
        let fallback = default_root(entry, models_dir);
        if let Some(root) = candidates
            .iter()
            .chain(std::iter::once(&fallback))
            .find(|candidate| complete_at(entry, candidate))
        {
            roots.insert(entry.id.clone(), root.clone());
        }
    }
    roots
}

fn same(a: Option<&Value>, b: Option<&Path>) -> bool {
    match (a.and_then(Value::as_str), b) {
        (Some(a), Some(b)) => resolve(Path::new(a)) == resolve(b),
        _ => false,
    }
}

/// What voice.json uses now, as the catalog's options.
pub fn current_choices(
    config: &Map<String, Value>,
    roots: &PackageRoots,
    packages: &[ModelPackage],
) -> VoiceChoices {
    let at = |id: &str| -> Option<PathBuf> {
        roots.get(id)?;
        package_path(roots, id, packages).ok()
    };
    let matching = |component: &str, path: Option<&Value>| -> String {
        options()
            .iter()
            .find(|option| {
                option.component == component
                    && option
                        .packages
                        .first()
                        .is_some_and(|first| same(path, at(first).as_deref()))
            })
            .map_or_else(|| CUSTOM_MODEL.to_owned(), |option| option.id.clone())
    };
    let mut choices = VoiceChoices::new();
    // No model set up yet: nothing is in use, the tier's choices stand.
    if configured_paths(config).is_empty() {
        return choices;
    }
    let get = |key: &str| config.get(key);
    if truthy(get("parakeet_model")) {
        choices.insert("speech".into(), matching("speech", get("parakeet_model")));
        choices.insert(
            "reread".into(),
            if truthy(get("whisper_model")) {
                matching("reread", get("whisper_model"))
            } else {
                NO_MODEL.into()
            },
        );
    } else if truthy(get("whisper_model")) {
        choices.insert("speech".into(), matching("speech", get("whisper_model")));
    }

    let models = tts_models(config);
    let has_models = get("tts_models")
        .and_then(Value::as_array)
        .is_some_and(|models| !models.is_empty());
    if has_models {
        let model_is = |model: &Map<String, Value>, name: &str| {
            model.get("model").and_then(Value::as_str) == Some(name)
        };
        let qwen: Vec<Value> = std::iter::once(get("clone_model"))
            .chain(
                models
                    .iter()
                    .filter(|model| model_is(model, "qwen3-tts"))
                    .map(|model| model.get("path")),
            )
            .flatten()
            .filter(|path| path.is_string())
            .cloned()
            .collect();
        let kokoro = models.iter().find(|model| model_is(model, "kokoro"));
        let kokoro_ok =
            kokoro.is_none_or(|kokoro| same(kokoro.get("path"), at("kokoro-82m").as_deref()));
        // Pocket TTS's entries, each its language's model in the catalog.
        let pocket: Vec<&&Map<String, Value>> = models
            .iter()
            .filter(|model| model_is(model, POCKET_MODEL))
            .collect();
        let pocket_ok = pocket.iter().all(|model| {
            POCKET_VOICES.iter().any(|voice| {
                model.get("languages").and_then(Value::as_str) == Some(voice.language)
                    && roots.get(voice.package).is_some_and(|root| {
                        same(model.get("path"), Some(&pocket_model_dir(root, voice)))
                    })
            })
        });
        // The light set: Pocket TTS, Kokoro's ONNX model beside it.
        let kokoro_path = get("kokoro_model")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let light = !pocket.is_empty()
            && qwen.is_empty()
            && kokoro.is_none_or(|kokoro| same(kokoro.get("path"), kokoro_path.as_deref()));
        let others = models.iter().any(|model| {
            !model_is(model, "qwen3-tts")
                && !model_is(model, "kokoro")
                && !model_is(model, POCKET_MODEL)
        });
        let base = ["qwen3-tts-1.7b", "qwen3-tts-0.6b"].into_iter().find(|id| {
            let first = option_of("tts", Some(id))
                .and_then(|option| option.packages.first())
                .map_or("", String::as_str);
            qwen.iter()
                .any(|path| same(Some(path), at(first).as_deref()))
        });
        let tts = if others || !pocket_ok {
            CUSTOM_MODEL
        } else if light {
            "pocket-tts"
        } else if !kokoro_ok {
            CUSTOM_MODEL
        } else if let Some(base) = base {
            base
        } else if !qwen.is_empty() {
            CUSTOM_MODEL
        } else if kokoro.is_some() {
            "kokoro-82m"
        } else {
            CUSTOM_MODEL
        };
        choices.insert("tts".into(), tts.into());
        choices.insert(
            "stock_voices".into(),
            if truthy(get("stock_model")) {
                matching("stock_voices", get("stock_model"))
            } else {
                NO_MODEL.into()
            },
        );
    } else if truthy(get("kokoro_model")) {
        let found = matching("tts", get("kokoro_model"));
        let mut tts = if found == "kokoro-onnx" || found == "kokoro-onnx-int8" {
            found
        } else {
            CUSTOM_MODEL.into()
        };
        if tts != CUSTOM_MODEL && !same(get("kokoro_voices"), at("kokoro-onnx-voices").as_deref()) {
            tts = CUSTOM_MODEL.into();
        }
        choices.insert("tts".into(), tts);
        choices.insert("stock_voices".into(), NO_MODEL.into());
    }

    for (component, key) in [
        ("speaker", "speaker_model"),
        ("turn", "turn_model"),
        ("text_turn", "text_turn_model"),
    ] {
        let chosen = if truthy(get(key)) {
            matching(component, get(key))
        } else {
            NO_MODEL.into()
        };
        choices.insert(component.into(), chosen);
    }
    choices
}

/// The packages the models directory holds that voice.json does not use.
pub fn unused_models(
    config: &Map<String, Value>,
    roots: &PackageRoots,
    models_dir: &Path,
    packages: &[ModelPackage],
) -> Vec<UnusedModel> {
    // An option voice.json names that the catalog lost: nothing known used.
    let used: BTreeSet<String> = packages_for(&current_choices(config, roots, packages))
        .map(|ids| ids.into_iter().collect())
        .unwrap_or_default();
    let referenced: Vec<PathBuf> = configured_paths(config)
        .iter()
        .map(|path| resolve(Path::new(path)))
        .collect();
    let mut unused = Vec::new();
    for entry in packages {
        let Some(root) = roots.get(&entry.id) else {
            continue;
        };
        if used.contains(&entry.id) || resolve(root) != resolve(&default_root(entry, models_dir)) {
            continue;
        }
        let Ok(path) = package_path(roots, &entry.id, packages) else {
            continue;
        };
        if referenced.contains(&resolve(&path)) {
            continue;
        }
        unused.push(UnusedModel {
            id: entry.id.clone(),
            name: entry.name.clone(),
            path: path.display().to_string(),
            size_bytes: package_bytes(entry),
        });
    }
    for part in partial_downloads(models_dir, 3) {
        unused.push(UnusedModel {
            id: "partial".into(),
            name: "Unfinished download".into(),
            size_bytes: size_at(&part).unwrap_or(0.0),
            path: part.display().to_string(),
        });
    }
    unused
}

/// The .part files left in the models directory, two levels deep, in
/// readdir's order (libuv sorts the names).
fn partial_downloads(models_dir: &Path, depth: u32) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return found;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        let path = models_dir.join(&name);
        if name.ends_with(".part") {
            found.push(path);
        } else if depth > 1 && path.is_dir() {
            found.extend(partial_downloads(&path, depth - 1));
        }
    }
    found
}

fn requirement_json(requires: &crate::models::Requirement) -> Value {
    json!({"component": requires.component, "options": requires.options})
}

/// The assistant's view: hardware, choices, what is here (VoiceSetupState).
pub fn voice_setup_state(deps: &SetupDeps, job: Option<&SetupJob>) -> Result<Value, String> {
    let packages = deps.packages();
    let hardware = (deps.hardware)();
    let config = raw_voice_config(&deps.config_path);
    let config_error = if deps.config_path.exists() {
        read_voice_config(&deps.config_path).err()
    } else {
        None
    };
    let roots = locate_packages(&config, &deps.models_dir, packages);
    let current = current_choices(&config, &roots, packages);
    let bytes_of = |id: &str| package_by_id(id, packages).map(package_bytes);
    let mut component_list = Vec::new();
    for spec in components() {
        let mut info = Map::new();
        info.insert("id".into(), json!(spec.id));
        info.insert("title".into(), json!(spec.title));
        info.insert("description".into(), json!(spec.description));
        info.insert("optional".into(), json!(spec.optional));
        if let Some(requires) = &spec.requires {
            info.insert("requires".into(), requirement_json(requires));
        }
        let mut option_list = Vec::new();
        for option in options()
            .iter()
            .filter(|option| option.component == spec.id)
        {
            let mut size = 0.0;
            let mut missing = 0.0;
            for id in &option.packages {
                let bytes = bytes_of(id)?;
                size += bytes;
                if !roots.contains_key(id) {
                    missing += bytes;
                }
            }
            let mut entry = Map::new();
            entry.insert("id".into(), json!(option.id));
            entry.insert("packages".into(), json!(option.packages));
            entry.insert("name".into(), json!(option.name));
            entry.insert("description".into(), json!(option.description));
            entry.insert("sizeBytes".into(), json!(size));
            entry.insert("downloadBytes".into(), json!(missing));
            entry.insert("speed".into(), json!(option.speed));
            entry.insert("runsOn".into(), json!(option.runs_on));
            if let Some(gpu) = option.gpu_bytes.filter(|gpu| *gpu != 0.0) {
                entry.insert("gpuBytes".into(), json!(gpu));
            }
            if let Some(requires) = &option.requires {
                entry.insert("requires".into(), requirement_json(requires));
            }
            entry.insert(
                "installed".into(),
                json!(option.packages.iter().all(|id| roots.contains_key(id))),
            );
            option_list.push(Value::Object(entry));
        }
        info.insert("options".into(), Value::Array(option_list));
        component_list.push(Value::Object(info));
    }
    let helper_path = match config.get("helper").and_then(Value::as_str) {
        Some(helper) if !helper.is_empty() => PathBuf::from(helper),
        _ => deps.helper_path.clone(),
    };
    let free = deps.free();
    let mut recommended = Map::new();
    for (tier, choices) in recommended_choices(&hardware) {
        recommended.insert(tier.into(), choices_json(&choices));
    }
    let mut state = Map::new();
    state.insert(
        "hardware".into(),
        serde_json::to_value(&hardware).map_err(|error| error.to_string())?,
    );
    state.insert("tier".into(), json!(tier_for(&hardware)));
    state.insert("recommended".into(), Value::Object(recommended));
    state.insert("current".into(), choices_json(&current));
    state.insert("components".into(), Value::Array(component_list));
    state.insert(
        "modelsDir".into(),
        json!(deps.models_dir.display().to_string()),
    );
    state.insert(
        "configPath".into(),
        json!(deps.config_path.display().to_string()),
    );
    if let Some(error) = config_error {
        state.insert("configError".into(), json!(error));
    }
    state.insert(
        "helper".into(),
        json!({"path": helper_path.display().to_string(), "found": helper_path.exists()}),
    );
    if let Some(free) = free {
        state.insert("freeBytes".into(), json!(free));
    }
    let mut sizes = Map::new();
    for entry in packages {
        let bytes = package_bytes(entry);
        sizes.insert(
            entry.id.clone(),
            json!({
                "sizeBytes": bytes,
                "downloadBytes": if roots.contains_key(&entry.id) { 0.0 } else { bytes },
            }),
        );
    }
    state.insert("packages".into(), Value::Object(sizes));
    state.insert(
        "unused".into(),
        serde_json::to_value(unused_models(&config, &roots, &deps.models_dir, packages))
            .map_err(|error| error.to_string())?,
    );
    state.insert("job".into(), job.map_or(Value::Null, SetupJob::to_json));
    Ok(js_value(Value::Object(state)))
}

/// One file to download.
#[derive(Debug, Clone, PartialEq)]
pub struct Download {
    pub name: String,
    pub target: DownloadTarget,
}

/// What a choice downloads, file by file, and the roots it ends with.
pub struct SetupPlan {
    pub choices: VoiceChoices,
    pub config: Map<String, Value>,
    pub roots: PackageRoots,
    pub downloads: Vec<Download>,
}

/// What `choices` downloads (setupPlan); an unknown option fails here.
pub fn setup_plan(choices: &VoiceChoices, deps: &SetupDeps) -> Result<SetupPlan, String> {
    let packages = deps.packages();
    let normalized = normalize_choices(choices)?;
    let config = raw_voice_config(&deps.config_path);
    let mut roots = locate_packages(&config, &deps.models_dir, packages);
    let mut downloads = Vec::new();
    for id in packages_for(&normalized)? {
        if roots.contains_key(&id) {
            continue;
        }
        let entry = package_by_id(&id, packages)?;
        let root = default_root(entry, &deps.models_dir);
        for file in &entry.files {
            downloads.push(Download {
                name: if entry.files.len() > 1 {
                    format!("{}: {}", entry.name, file.path)
                } else {
                    entry.name.clone()
                },
                target: DownloadTarget {
                    url: file.url.clone(),
                    path: root.join(&file.path),
                    size: file.size,
                    sha256: file.sha256.clone(),
                },
            });
        }
        roots.insert(id, root);
    }
    Ok(SetupPlan {
        choices: normalized,
        config,
        roots,
        downloads,
    })
}

/// Told the job as it goes.
pub type JobProgress = Arc<dyn Fn(&SetupJob) + Send + Sync>;

#[derive(Clone, Default)]
pub struct InstallOptions {
    pub signal: Option<Abort>,
    /// The job as it goes, for progress.
    pub on_progress: Option<JobProgress>,
    /// Hash files already in place.
    pub verify: bool,
    /// Set voice.json's helper, whatever it names.
    pub helper: Option<String>,
}

/// A failed install: the job as it stood, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct InstallError {
    pub message: String,
    pub cancelled: bool,
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for InstallError {
    fn from(message: String) -> Self {
        Self {
            message,
            cancelled: false,
        }
    }
}

/// Downloads what `choices` needs and points voice.json at it; fails before
/// downloading when the disk has too little room. Gives the finished job
/// and the keys written.
pub async fn install_voice_models(
    choices: &VoiceChoices,
    deps: &SetupDeps,
    options: &InstallOptions,
) -> Result<(SetupJob, Map<String, Value>), InstallError> {
    let plan = setup_plan(choices, deps)?;
    let clock = deps.clock.clone();
    let now = move || clock.now() as f64;
    let job = Arc::new(Mutex::new(SetupJob::new(&plan.downloads, now())));
    let report = {
        let job = job.clone();
        let on_progress = options.on_progress.clone();
        move || {
            if let Some(on_progress) = &on_progress {
                let copy = lock(&job).clone();
                on_progress(&copy);
            }
        }
    };
    let total = lock(&job).total_bytes;
    let partial: f64 = plan
        .downloads
        .iter()
        .map(|file| size_at(&part_path(&file.target.path)).unwrap_or(0.0))
        .sum();
    if let Some(free) = deps.free()
        && free < total - partial
    {
        return Err(format!(
            "{} has {} MB free, the models need {} MB",
            deps.models_dir.display(),
            crate::js::number_text((free / 1e6).floor()),
            crate::js::number_text(((total - partial) / 1e6).ceil()),
        )
        .into());
    }
    report();
    let last_report = Arc::new(Mutex::new(0.0f64));
    let speed_from = Arc::new(Mutex::new((now(), 0.0f64)));
    let report = Arc::new(report);
    for (index, file) in plan.downloads.iter().enumerate() {
        let before = {
            let mut job = lock(&job);
            job.current = Some(file.name.clone());
            job.done_bytes
        };
        let on_progress: crate::download::Progress = {
            let job = job.clone();
            let last_report = last_report.clone();
            let speed_from = speed_from.clone();
            let report = report.clone();
            let now = now.clone();
            Arc::new(move |done: f64| {
                let at = now();
                let due = {
                    let mut job = lock(&job);
                    if let Some(entry) = job.files.get_mut(index) {
                        entry.done = done;
                    }
                    job.done_bytes = before + done;
                    let mut from = lock(&speed_from);
                    if at - from.0 >= 1000.0 {
                        job.bytes_per_second =
                            ((job.done_bytes - from.1) * 1000.0 / (at - from.0)).max(0.0);
                        *from = (at, job.done_bytes);
                    }
                    let mut last = lock(&last_report);
                    let due = at - *last >= 250.0;
                    if due {
                        *last = at;
                    }
                    due
                };
                if due {
                    report();
                }
            })
        };
        let download = DownloadOptions {
            fetch: deps.fetch.clone(),
            signal: options.signal.clone(),
            on_progress: Some(on_progress),
            verify: options.verify,
            attempts: None,
            retry_delay_ms: deps.retry_delay_ms,
            clock: Some(deps.clock.clone()),
        };
        if let Err(error) = download_file(&file.target, &download).await {
            return Err(InstallError {
                cancelled: matches!(error, crate::download::DownloadError::Aborted),
                message: error.to_string(),
            });
        }
        lock(&job).done_bytes = before + file.target.size;
    }
    {
        let mut job = lock(&job);
        job.current = None;
        job.state = "writing";
    }
    report();
    let patch = config_patch(&plan.choices, &plan.roots, &plan.config, deps.packages())?;
    let mut written: Vec<(String, Option<Value>)> = patch;
    let helper = match &options.helper {
        Some(helper) if !helper.is_empty() => Some(helper.clone()),
        _ if !truthy(plan.config.get("helper")) && deps.helper_path.exists() => {
            Some(deps.helper_path.display().to_string())
        }
        _ => None,
    };
    if let Some(helper) = helper {
        written.retain(|(key, _)| key != "helper");
        written.push(("helper".into(), Some(json!(helper))));
    }
    let borrowed: Vec<(&str, Option<Value>)> = written
        .iter()
        .map(|(key, value)| (key.as_str(), value.clone()))
        .collect();
    update_voice_config(&borrowed, &deps.config_path)?;
    {
        let mut job = lock(&job);
        job.state = "done";
        job.finished_at = Some(now());
    }
    report();
    let finished = lock(&job).clone();
    let patch = written
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect();
    Ok((finished, patch))
}

/// Deletes unused models (unused_models' ids, "partial" for unfinished
/// downloads; None for all), only ever inside the models directory. Gives
/// what it removed and the bytes freed.
pub fn remove_unused_models(
    ids: Option<&[String]>,
    deps: &SetupDeps,
) -> Result<(Vec<UnusedModel>, f64), String> {
    let packages = deps.packages();
    let config = raw_voice_config(&deps.config_path);
    let roots = locate_packages(&config, &deps.models_dir, packages);
    let inside = format!(
        "{}{}",
        resolve(&deps.models_dir).display(),
        std::path::MAIN_SEPARATOR
    );
    let mut removed = Vec::new();
    for model in unused_models(&config, &roots, &deps.models_dir, packages) {
        if ids.is_some_and(|ids| !ids.contains(&model.id)) {
            continue;
        }
        let entry = if model.id == "partial" {
            None
        } else {
            Some(package_by_id(&model.id, packages)?)
        };
        let paths: Vec<PathBuf> = match entry {
            Some(entry) if !entry.dir.is_empty() => {
                roots.get(&entry.id).cloned().into_iter().collect()
            }
            Some(entry) => entry
                .files
                .iter()
                .map(|file| deps.models_dir.join(&file.path))
                .collect(),
            None => vec![PathBuf::from(&model.path)],
        };
        for path in paths {
            if !resolve(&path).display().to_string().starts_with(&inside) {
                return Err(format!(
                    "{} is not in {}",
                    path.display(),
                    deps.models_dir.display()
                ));
            }
            remove_path(&path).map_err(|error| error.to_string())?;
        }
        removed.push(model);
    }
    let freed = removed.iter().map(|model| model.size_bytes).sum();
    Ok((removed, freed))
}

/// `rmSync(path, {recursive: true, force: true})`.
fn remove_path(path: &Path) -> std::io::Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    };
    match result {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// voice.json changed: the running helper takes the new models; says
/// whether it stopped now (now), will once a call ends (after-call), or was
/// not running (not-running).
pub type Reload = Arc<dyn Fn() -> &'static str + Send + Sync>;

#[derive(Default)]
struct RunnerState {
    current: Option<SetupJob>,
    /// The running download's number and its stop.
    abort: Option<(u64, watch::Sender<bool>)>,
    next: u64,
}

/// The one download the server runs at a time, for the Voice settings'
/// assistant: started, followed by polling, cancelled (VoiceSetupRunner).
#[derive(Clone)]
pub struct VoiceSetupRunner {
    deps: Arc<SetupDeps>,
    reload: Reload,
    state: Arc<Mutex<RunnerState>>,
}

impl VoiceSetupRunner {
    pub fn new(deps: SetupDeps, reload: Option<Reload>) -> Self {
        Self {
            deps: Arc::new(deps),
            reload: reload.unwrap_or_else(|| Arc::new(|| "not-running")),
            state: Arc::default(),
        }
    }

    pub fn job(&self) -> Option<SetupJob> {
        lock(&self.state).current.clone()
    }

    pub fn running(&self) -> bool {
        lock(&self.state).abort.is_some()
    }

    pub fn state(&self) -> Result<Value, String> {
        let job = self.job();
        voice_setup_state(&self.deps, job.as_ref())
    }

    /// Starts installing `choices`; fails when one already runs, or at once
    /// for an unknown option.
    pub fn start(&self, choices: &VoiceChoices) -> Result<SetupJob, String> {
        if self.running() {
            return Err("A voice setup is already downloading".into());
        }
        let plan = setup_plan(choices, &self.deps)?;
        let (stop, signal) = watch::channel(false);
        let job = SetupJob::new(&plan.downloads, self.deps.clock.now() as f64);
        let id = {
            let mut state = lock(&self.state);
            state.next += 1;
            let id = state.next;
            state.abort = Some((id, stop));
            state.current = Some(job.clone());
            id
        };
        let runner = self.clone();
        let choices = choices.clone();
        let on_progress: JobProgress = {
            let state = self.state.clone();
            Arc::new(move |job: &SetupJob| {
                let mut state = lock(&state);
                if state
                    .abort
                    .as_ref()
                    .is_some_and(|(running, _)| *running == id)
                {
                    state.current = Some(job.clone());
                }
            })
        };
        let install = async move {
            let options = InstallOptions {
                signal: Some(signal.clone()),
                on_progress: Some(on_progress),
                ..InstallOptions::default()
            };
            let result = install_voice_models(&choices, &runner.deps, &options).await;
            let finished = match result {
                Ok((mut job, _)) => {
                    job.reload = Some((runner.reload)());
                    job
                }
                Err(error) => {
                    let aborted = *signal.borrow() || error.cancelled;
                    let mut job = lock(&runner.state)
                        .current
                        .clone()
                        .unwrap_or_else(|| SetupJob {
                            state: "failed",
                            ..SetupJob::new(&[], runner.deps.clock.now() as f64)
                        });
                    job.state = if aborted { "cancelled" } else { "failed" };
                    if !aborted {
                        job.error = Some(error.message);
                    }
                    job.current = None;
                    job.finished_at = Some(runner.deps.clock.now() as f64);
                    job
                }
            };
            let mut state = lock(&runner.state);
            state.current = Some(finished);
            if state
                .abort
                .as_ref()
                .is_some_and(|(running, _)| *running == id)
            {
                state.abort = None;
            }
        };
        // As Bun's start runs the install up to its first wait before it
        // answers: a setup with nothing to download is done at once.
        let mut install = Box::pin(install);
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        if std::future::Future::poll(install.as_mut(), &mut context).is_pending() {
            // Spawned tasks are polled at once: the real waker takes over.
            tokio::spawn(install);
        }
        let current = lock(&self.state).current.clone();
        Ok(current.unwrap_or(job))
    }

    pub fn cancel(&self) -> bool {
        match &lock(&self.state).abort {
            Some((_, stop)) => {
                let _ = stop.send(true);
                true
            }
            None => false,
        }
    }

    pub fn remove_unused(&self, ids: Option<&[String]>) -> Result<(Vec<UnusedModel>, f64), String> {
        if self.running() {
            return Err("Wait for the download to end before removing models".into());
        }
        remove_unused_models(ids, &self.deps)
    }
}

#[cfg(test)]
mod tests;
