//! The models the voice helper loads, as the setup assistant offers them
//! (server/src/voice/voice-models.ts and the shared rules of
//! shared/voiceSetup.ts): the catalog of contract/assets/data/
//! voice-models.json, the choices made consistent, each tier's choices,
//! and what each writes to voice.json.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::config::TtsModel;
use crate::hardware::{GIB, VoiceHardware};
use crate::js;

pub const NO_MODEL: &str = "none";
pub const CUSTOM_MODEL: &str = "custom";

/// The parts of the voice helper a model is chosen for, in order.
pub const VOICE_COMPONENTS: [&str; 7] = [
    "speech",
    "reread",
    "tts",
    "stock_voices",
    "speaker",
    "turn",
    "text_turn",
];

/// An option id, NO_MODEL or CUSTOM_MODEL for each part (VoiceChoices).
pub type VoiceChoices = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub component: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelFile {
    pub path: String,
    pub url: String,
    pub size: f64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelPackage {
    pub id: String,
    pub name: String,
    pub dir: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentSpec {
    pub id: String,
    pub title: String,
    pub description: String,
    pub optional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requirement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub component: String,
    pub name: String,
    pub description: String,
    pub packages: Vec<String>,
    pub speed: String,
    pub runs_on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_bytes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Requirement>,
}

#[derive(Deserialize)]
struct Catalog {
    packages: Vec<CatalogPackage>,
    files: BTreeMap<String, Vec<ModelFile>>,
    components: Vec<ComponentSpec>,
    options: Vec<CatalogOption>,
}

#[derive(Deserialize)]
struct CatalogPackage {
    id: String,
    name: String,
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogOption {
    id: String,
    component: String,
    name: String,
    description: String,
    packages: Vec<String>,
    speed: String,
    runs_on: String,
    #[serde(default)]
    gpu_gib: Option<f64>,
    #[serde(default)]
    requires: Option<Requirement>,
}

/// The catalog, embedded (both servers read the same file).
pub const VOICE_MODELS_JSON: &str = include_str!("../../../contract/assets/data/voice-models.json");

static CATALOG: LazyLock<(Vec<ModelPackage>, Vec<ComponentSpec>, Vec<ModelOption>)> =
    LazyLock::new(|| {
        let catalog: Catalog = serde_json::from_str(VOICE_MODELS_JSON).expect("voice-models.json");
        let packages = catalog
            .packages
            .into_iter()
            .map(|entry| {
                let files = catalog
                    .files
                    .get(&entry.id)
                    .cloned()
                    .unwrap_or_else(|| panic!("no files for the voice model {}", entry.id));
                ModelPackage {
                    id: entry.id,
                    name: entry.name,
                    dir: entry.dir,
                    files,
                }
            })
            .collect();
        let options = catalog
            .options
            .into_iter()
            .map(|option| ModelOption {
                id: option.id,
                component: option.component,
                name: option.name,
                description: option.description,
                packages: option.packages,
                speed: option.speed,
                runs_on: option.runs_on,
                gpu_bytes: option.gpu_gib.map(|gib| gib * GIB),
                requires: option.requires,
            })
            .collect();
        (packages, catalog.components, options)
    });

/// The catalog's packages.
pub fn packages() -> &'static [ModelPackage] {
    &CATALOG.0
}

pub fn components() -> &'static [ComponentSpec] {
    &CATALOG.1
}

pub fn options() -> &'static [ModelOption] {
    &CATALOG.2
}

pub fn package_by_id<'a>(
    id: &str,
    packages: &'a [ModelPackage],
) -> Result<&'a ModelPackage, String> {
    packages
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("unknown voice model package: {id}"))
}

pub fn package_bytes(entry: &ModelPackage) -> f64 {
    entry.files.iter().map(|file| file.size).sum()
}

/// Where each package is, or goes.
pub type PackageRoots = BTreeMap<String, PathBuf>;

/// The voice.json keys the assistant writes.
pub const SETUP_KEYS: [&str; 10] = [
    "whisper_model",
    "parakeet_model",
    "kokoro_model",
    "kokoro_voices",
    "tts_models",
    "clone_model",
    "stock_model",
    "speaker_model",
    "turn_model",
    "text_turn_model",
];

pub fn options_of(component: &str) -> Vec<&'static ModelOption> {
    options()
        .iter()
        .filter(|option| option.component == component)
        .collect()
}

pub fn option_of(component: &str, id: Option<&str>) -> Option<&'static ModelOption> {
    let id = id?;
    options()
        .iter()
        .find(|option| option.component == component && option.id == id)
}

/// Whether `requires` holds.
pub fn requirement_holds(requires: Option<&Requirement>, choices: &VoiceChoices) -> bool {
    let Some(requires) = requires else {
        return true;
    };
    let chosen = choices.get(&requires.component).map(String::as_str);
    chosen == Some(CUSTOM_MODEL)
        || requires
            .options
            .iter()
            .any(|option| Some(option.as_str()) == chosen.or(Some("")))
}

/// A part's rules for settle_choices.
#[derive(Debug, Clone)]
pub struct ChoiceRule {
    pub id: String,
    pub optional: bool,
    pub requires: Option<Requirement>,
    pub options: Vec<(String, Option<Requirement>)>,
}

/// The catalog as rules.
pub fn catalog_rules() -> Vec<ChoiceRule> {
    components()
        .iter()
        .map(|spec| ChoiceRule {
            id: spec.id.clone(),
            optional: spec.optional,
            requires: spec.requires.clone(),
            options: options_of(&spec.id)
                .into_iter()
                .map(|option| (option.id.clone(), option.requires.clone()))
                .collect(),
        })
        .collect()
}

/// The choices made consistent (settleChoices).
pub fn settle_choices(rules: &[ChoiceRule], choices: &VoiceChoices) -> VoiceChoices {
    let mut settled = choices.clone();
    for part in rules {
        let Some(id) = settled.get(&part.id).cloned() else {
            continue;
        };
        if id == NO_MODEL || id == CUSTOM_MODEL {
            continue;
        }
        if !requirement_holds(part.requires.as_ref(), &settled) {
            if part.optional {
                settled.insert(part.id.clone(), NO_MODEL.into());
            }
            continue;
        }
        let option = part.options.iter().find(|(option, _)| *option == id);
        if requirement_holds(option.and_then(|(_, requires)| requires.as_ref()), &settled) {
            continue;
        }
        let sibling = part
            .options
            .iter()
            .find(|(_, requires)| requirement_holds(requires.as_ref(), &settled))
            .map(|(id, _)| id.clone());
        settled.insert(part.id.clone(), sibling.unwrap_or_else(|| NO_MODEL.into()));
    }
    settled
}

/// The choices to start from (startingChoices): `tier`'s when given,
/// else what voice.json uses (`current`), the proposed tier's for the
/// rest.
pub fn starting_choices(
    recommended: &BTreeMap<&'static str, VoiceChoices>,
    proposed: &str,
    current: &VoiceChoices,
    tier: Option<&str>,
) -> VoiceChoices {
    let rules = catalog_rules();
    if let Some(tier) = tier {
        return settle_choices(&rules, &recommended.get(tier).cloned().unwrap_or_default());
    }
    let mut choices = recommended.get(proposed).cloned().unwrap_or_default();
    choices.extend(current.iter().map(|(part, id)| (part.clone(), id.clone())));
    settle_choices(&rules, &choices)
}

/// Whether a part applies, given the others.
pub fn applies(component: &str, choices: &VoiceChoices) -> bool {
    let spec = components().iter().find(|entry| entry.id == component);
    requirement_holds(spec.and_then(|spec| spec.requires.as_ref()), choices)
}

/// The choices checked and made consistent.
pub fn normalize_choices(choices: &VoiceChoices) -> Result<VoiceChoices, String> {
    let mut named = choices.clone();
    for spec in components() {
        let Some(id) = named.get(&spec.id).cloned() else {
            continue;
        };
        if id == CUSTOM_MODEL {
            continue;
        }
        if id == NO_MODEL {
            if !spec.optional {
                return Err(format!("{} needs a model", spec.title));
            }
            continue;
        }
        if spec.id == "stock_voices" && id == "customvoice" {
            match options_of("stock_voices").first() {
                Some(first) => named.insert(spec.id.clone(), first.id.clone()),
                None => named.remove(&spec.id),
            };
            continue;
        }
        if option_of(&spec.id, Some(&id)).is_none() {
            return Err(format!("no {} model named {id}", spec.title.to_lowercase()));
        }
    }
    Ok(settle_choices(&catalog_rules(), &named))
}

/// Every package the choices need, in the catalog's order of parts.
pub fn packages_for(choices: &VoiceChoices) -> Result<Vec<String>, String> {
    let normalized = normalize_choices(choices)?;
    let mut ids: Vec<String> = Vec::new();
    for spec in components() {
        if let Some(option) = option_of(&spec.id, normalized.get(&spec.id).map(String::as_str)) {
            for id in &option.packages {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    Ok(ids)
}

const BIG_TTS_GPU: f64 = 7.5 * GIB;
const HEAVY_GPU: f64 = 5.5 * GIB;

pub fn tier_for(hardware: &VoiceHardware) -> &'static str {
    if hardware.acceleration != "cpu" && hardware.gpu_bytes >= HEAVY_GPU {
        "heavy"
    } else {
        "light"
    }
}

fn choices(pairs: &[(&str, &str)]) -> VoiceChoices {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// Each tier's choices on this hardware.
pub fn recommended_choices(hardware: &VoiceHardware) -> BTreeMap<&'static str, VoiceChoices> {
    let ram = hardware.ram_bytes;
    let heavy = choices(&[
        ("speech", "parakeet"),
        ("reread", "whisper-large-v3-turbo"),
        (
            "tts",
            if hardware.gpu_bytes >= BIG_TTS_GPU {
                "qwen3-tts-1.7b"
            } else {
                "qwen3-tts-0.6b"
            },
        ),
        ("stock_voices", NO_MODEL),
        ("speaker", "wespeaker"),
        ("turn", "smart-turn"),
        ("text_turn", "qwen3-0.6b"),
    ]);
    let light = choices(&[
        ("speech", "parakeet"),
        ("reread", NO_MODEL),
        (
            "tts",
            if ram < 8.0 * GIB {
                "kokoro-onnx-int8"
            } else {
                "pocket-tts"
            },
        ),
        ("stock_voices", NO_MODEL),
        ("speaker", "wespeaker"),
        ("turn", "smart-turn"),
        (
            "text_turn",
            if ram >= 12.0 * GIB {
                "qwen3-0.6b"
            } else {
                NO_MODEL
            },
        ),
    ]);
    BTreeMap::from([("heavy", heavy), ("light", light)])
}

/// The choices of a part, as JSON in the order of VOICE_COMPONENTS (the
/// order the TS object literals have).
pub fn choices_json(choices: &VoiceChoices) -> Value {
    let mut out = Map::new();
    for component in VOICE_COMPONENTS {
        if let Some(id) = choices.get(component) {
            out.insert(component.into(), json!(id));
        }
    }
    for (key, id) in choices {
        if !out.contains_key(key) {
            out.insert(key.clone(), json!(id));
        }
    }
    Value::Object(out)
}

/// Where the voice's files live.
pub fn voice_data_dir(home: &Path, platform: &str, app_data: Option<&Path>) -> PathBuf {
    if platform == "win32" {
        let base = app_data.map_or_else(|| home.join("AppData").join("Roaming"), Path::to_path_buf);
        base.join("roamgate").join("voice")
    } else {
        home.join(".local")
            .join("share")
            .join("roamgate")
            .join("voice")
    }
}

pub fn default_models_dir(home: &Path, platform: &str, app_data: Option<&Path>) -> PathBuf {
    voice_data_dir(home, platform, app_data).join("models")
}

pub fn default_helper_path(home: &Path, platform: &str, app_data: Option<&Path>) -> PathBuf {
    voice_data_dir(home, platform, app_data).join(if platform == "win32" {
        "roamgate-voice.exe"
    } else {
        "roamgate-voice"
    })
}

/// The path of a package's main thing, as voice.json names it.
pub fn package_path(
    roots: &PackageRoots,
    id: &str,
    packages: &[ModelPackage],
) -> Result<PathBuf, String> {
    let entry = package_by_id(id, packages)?;
    let Some(root) = roots.get(id) else {
        return Err(format!("{} is not installed", entry.name));
    };
    Ok(if entry.dir.is_empty() {
        root.join(entry.files.first().map_or("", |file| file.path.as_str()))
    } else {
        root.clone()
    })
}

/// Pocket TTS's languages in the catalog.
pub struct PocketVoice {
    pub language: &'static str,
    pub package: &'static str,
    pub dir: &'static str,
    pub voice: &'static str,
}

pub const POCKET_VOICES: [PocketVoice; 2] = [
    PocketVoice {
        language: "fr",
        package: "pocket-tts-fr",
        dir: "languages/french",
        voice: "estelle",
    },
    PocketVoice {
        language: "en",
        package: "pocket-tts-en",
        dir: "languages/english",
        voice: "alba",
    },
];

pub const POCKET_MODEL: &str = "pocket-tts";

pub fn pocket_model_dir(root: &Path, voice: &PocketVoice) -> PathBuf {
    root.join(voice.dir)
}

/// voice.json's keys to set (Some) or remove (None), in the order set.
pub type ConfigPatch = Vec<(String, Option<Value>)>;

fn set(patch: &mut ConfigPatch, key: &str, value: Option<Value>) {
    match patch.iter_mut().find(|(existing, _)| existing == key) {
        Some(slot) => slot.1 = value,
        None => patch.push((key.to_owned(), value)),
    }
}

fn text(path: PathBuf) -> Value {
    Value::String(path.display().to_string())
}

/// voice.json's setup keys for the choices (configPatch).
pub fn config_patch(
    choices: &VoiceChoices,
    roots: &PackageRoots,
    config: &Map<String, Value>,
    packages: &[ModelPackage],
) -> Result<ConfigPatch, String> {
    let chosen = normalize_choices(choices)?;
    let get = |component: &str| chosen.get(component).map(String::as_str);
    let mut patch: ConfigPatch = Vec::new();
    let path_of = |id: &str| package_path(roots, id, packages);
    if get("speech") == Some("parakeet") {
        set(
            &mut patch,
            "parakeet_model",
            Some(text(path_of("parakeet-tdt-0.6b-v3")?)),
        );
        if let Some(reread) = option_of("reread", get("reread")) {
            set(
                &mut patch,
                "whisper_model",
                Some(text(path_of(&reread.packages[0])?)),
            );
        } else if get("reread") == Some(NO_MODEL) {
            set(&mut patch, "whisper_model", None);
        }
    } else if let Some(whisper) = option_of("speech", get("speech")) {
        set(&mut patch, "parakeet_model", None);
        set(
            &mut patch,
            "whisper_model",
            Some(text(path_of(&whisper.packages[0])?)),
        );
    }

    let tts = option_of("tts", get("tts"));
    let previous: Vec<TtsModel> = config
        .get("tts_models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    let model_of = |entry: &TtsModel| {
        entry
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let pocket_entries = |ids: &[String]| -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        for voice in POCKET_VOICES
            .iter()
            .filter(|voice| ids.iter().any(|id| id == voice.package))
        {
            let mut entry = Map::new();
            entry.insert("voice".into(), json!(voice.voice));
            if let Some(kept) = previous.iter().find(|model| {
                model_of(model).as_deref() == Some(POCKET_MODEL)
                    && model.get("languages").and_then(Value::as_str) == Some(voice.language)
            }) {
                for (key, value) in kept {
                    entry.insert(key.clone(), value.clone());
                }
            }
            entry.insert("model".into(), json!(POCKET_MODEL));
            entry.insert(
                "path".into(),
                text(pocket_model_dir(&path_of(voice.package)?, voice)),
            );
            entry.insert("languages".into(), json!(voice.language));
            out.push(Value::Object(entry));
        }
        Ok(out)
    };
    match tts.map(|tts| tts.id.as_str()) {
        Some("pocket-tts") => {
            let tts = tts.expect("tts");
            let onnx = ["kokoro-onnx", "kokoro-onnx-int8"]
                .into_iter()
                .find(|id| roots.contains_key(*id));
            let mut kokoro = Vec::new();
            if let Some(onnx) = onnx
                && roots.contains_key("kokoro-onnx-voices")
            {
                set(&mut patch, "kokoro_model", Some(text(path_of(onnx)?)));
                set(
                    &mut patch,
                    "kokoro_voices",
                    Some(text(path_of("kokoro-onnx-voices")?)),
                );
                kokoro.push(json!({"model": "kokoro", "path": text(path_of(onnx)?)}));
            }
            let mut models = pocket_entries(&tts.packages)?;
            models.extend(kokoro);
            set(&mut patch, "tts_models", Some(Value::Array(models)));
            set(&mut patch, "clone_model", None);
            set(&mut patch, "stock_model", None);
        }
        Some("kokoro-onnx" | "kokoro-onnx-int8") => {
            let tts = tts.expect("tts");
            set(
                &mut patch,
                "kokoro_model",
                Some(text(path_of(&tts.packages[0])?)),
            );
            set(
                &mut patch,
                "kokoro_voices",
                Some(text(path_of("kokoro-onnx-voices")?)),
            );
            set(&mut patch, "tts_models", None);
            set(&mut patch, "clone_model", None);
            set(&mut patch, "stock_model", None);
        }
        Some(_) => {
            let tts = tts.expect("tts");
            let base = tts.packages.iter().find(|id| id.contains("-base"));
            let base_path = match base {
                Some(base) => Some(path_of(base)?.display().to_string()),
                None => None,
            };
            let stock = option_of("stock_voices", get("stock_voices"))
                .map(|option| option.packages[0].clone());
            let stock_path = match &stock {
                Some(stock) => Some(path_of(stock)?.display().to_string()),
                None if get("stock_voices") == Some(CUSTOM_MODEL) => config
                    .get("stock_model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                None => None,
            };
            let mut models: Vec<Value> = previous
                .iter()
                .filter(|model| {
                    model_of(model).as_deref() == Some("qwen3-tts")
                        && model
                            .get("path")
                            .and_then(Value::as_str)
                            .is_some_and(|path| {
                                Some(path) == base_path.as_deref()
                                    || Some(path) == stock_path.as_deref()
                            })
                })
                .cloned()
                .map(Value::Object)
                .collect();
            let mut kokoro = previous
                .iter()
                .find(|model| model_of(model).as_deref() == Some("kokoro"))
                .cloned()
                .unwrap_or_default();
            kokoro.insert("model".into(), json!("kokoro"));
            kokoro.insert("path".into(), text(path_of("kokoro-82m")?));
            models.push(Value::Object(kokoro));
            models.extend(pocket_entries(&tts.packages)?);
            set(&mut patch, "tts_models", Some(Value::Array(models)));
            set(&mut patch, "clone_model", base_path.map(Value::String));
            if let Some(stock_choice) = get("stock_voices")
                && stock_choice != CUSTOM_MODEL
            {
                set(&mut patch, "stock_model", stock_path.map(Value::String));
            }
        }
        None => {}
    }

    for (component, key) in [
        ("speaker", "speaker_model"),
        ("turn", "turn_model"),
        ("text_turn", "text_turn_model"),
    ] {
        if let Some(option) = option_of(component, get(component)) {
            set(&mut patch, key, Some(text(path_of(&option.packages[0])?)));
        } else if get(component) == Some(NO_MODEL) {
            set(&mut patch, key, None);
        }
    }
    Ok(patch)
}

/// "4.2 GB", "180 MB".
pub fn format_bytes(bytes: f64) -> String {
    let gib = GIB;
    let mib = 1024.0 * 1024.0;
    if bytes >= gib {
        format!("{} GB", js::to_fixed(bytes / gib, 1))
    } else if bytes >= mib {
        format!("{} MB", js::number_text(js::round(bytes / mib)))
    } else if bytes >= 1024.0 {
        format!("{} KB", js::number_text(js::round(bytes / 1024.0)))
    } else {
        format!("{} B", js::number_text(bytes))
    }
}

/// The ids among `ids`, as a set.
pub fn id_set(ids: &[String]) -> BTreeSet<String> {
    ids.iter().cloned().collect()
}

#[cfg(test)]
mod tests;
