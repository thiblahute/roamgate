//! Qwen3-TTS's stock speakers (server/src/voice/voice-stock.ts): the named
//! voices a CustomVoice model comes with (Ryan, Vivian, ...), read with its
//! `voice` field instead of a cloned `voice_embedding`, which needs the Base
//! model. Every speaker speaks all of Qwen3-TTS's languages; each sounds
//! most natural in its own.
//!
//! A stock voice's id is `qwen3-tts:<speaker>`, which no recorded voice's id
//! (a slug) can be.

use std::path::{Path, PathBuf};

use roamgate_agents::js::locale_compare;
use roamgate_base::paths::{dirname, resolve};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::VoiceConfig;

pub const STOCK_PREFIX: &str = "qwen3-tts:";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StockVoice {
    pub id: String,
    /// The model's name for it, as the helper takes it.
    pub speaker: String,
    pub name: String,
    /// The language it sounds most natural in (ISO 639-1).
    pub native: String,
    pub description: String,
}

/// What Qwen's model card says of the speakers it ships, in its order:
/// speaker, name, native language, description. Those a model adds later
/// are listed after them, by name.
const KNOWN: [(&str, &str, &str, &str); 9] = [
    ("ryan", "Ryan", "en", "Lively man, strong rhythm"),
    ("aiden", "Aiden", "en", "Sunny American man, clear midrange"),
    (
        "vivian",
        "Vivian",
        "zh",
        "Bright young woman, a little edgy",
    ),
    ("serena", "Serena", "zh", "Warm, gentle young woman"),
    ("uncle_fu", "Uncle Fu", "zh", "Seasoned man, low and mellow"),
    (
        "dylan",
        "Dylan",
        "zh",
        "Young Beijing man, clear and natural",
    ),
    ("eric", "Eric", "zh", "Lively Chengdu man, a little husky"),
    (
        "ono_anna",
        "Ono Anna",
        "ja",
        "Playful young woman, light and nimble",
    ),
    ("sohee", "Sohee", "ko", "Warm woman, full of feeling"),
];

pub fn is_stock_voice_id(id: &str) -> bool {
    id.starts_with(STOCK_PREFIX)
}

pub fn stock_voice_id(speaker: &str) -> String {
    format!("{STOCK_PREFIX}{}", speaker.to_lowercase())
}

fn read_model_config(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path.join("config.json")).ok()?;
    match roamgate_base::json::js_value(serde_json::from_str(&text).ok()?) {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The stock speakers of the model directory `path`; none when not one.
pub fn model_speakers(path: &Path) -> Vec<String> {
    let Some(config) = read_model_config(path) else {
        return Vec::new();
    };
    if config.get("tts_model_type").and_then(Value::as_str) == Some("base") {
        return Vec::new();
    }
    let Some(Value::Object(ids)) = config
        .get("talker_config")
        .and_then(|talker| talker.get("spk_id"))
    else {
        return Vec::new();
    };
    let rank = |name: &str| {
        KNOWN
            .iter()
            .position(|known| known.0 == name)
            .unwrap_or(KNOWN.len())
    };
    let mut names: Vec<String> = ids.keys().map(|name| name.to_lowercase()).collect();
    names.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| locale_compare(a, b)));
    names
}

/// Whether `path` is a Qwen3-TTS model with stock speakers (CustomVoice).
pub fn is_stock_model(path: &Path) -> bool {
    !model_speakers(path).is_empty()
}

/// The CustomVoice model stock voices read with: `stock_model`, else the
/// first Qwen3-TTS model of `tts_models` that is one, else one next to them
/// (Qwen3-TTS-1.7B-CustomVoice beside Qwen3-TTS-1.7B-Base).
pub fn stock_model(config: &VoiceConfig) -> Option<PathBuf> {
    if let Some(stock) = config.str("stock_model").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(stock);
        return is_stock_model(&path).then_some(path);
    }
    let qwen: Vec<String> = config
        .get("tts_models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| model.get("model").and_then(Value::as_str) == Some("qwen3-tts"))
        .map(|model| model.get("path"))
        .chain(std::iter::once(config.get("clone_model")))
        .filter_map(|path| path.and_then(Value::as_str))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(path) = qwen.iter().find(|path| is_stock_model(Path::new(path))) {
        return Some(PathBuf::from(path));
    }
    let mut parents: Vec<PathBuf> = Vec::new();
    for path in &qwen {
        let parent = dirname(&resolve(Path::new(path)));
        if !parents.contains(&parent) {
            parents.push(parent);
        }
    }
    for parent in parents {
        let Ok(entries) = std::fs::read_dir(&parent) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            let path = parent.join(&name);
            if name.to_lowercase().contains("customvoice")
                && path.join("config.json").exists()
                && is_stock_model(&path)
            {
                return Some(path);
            }
        }
    }
    None
}

/// The stock voices of the model at `path`.
pub fn stock_voices(path: Option<&Path>) -> Vec<StockVoice> {
    let Some(path) = path else {
        return Vec::new();
    };
    model_speakers(path)
        .into_iter()
        .map(|speaker| {
            let known = KNOWN.iter().find(|known| known.0 == speaker);
            StockVoice {
                id: stock_voice_id(&speaker),
                name: known.map_or_else(
                    || {
                        speaker
                            .split('_')
                            .map(|word| {
                                let mut chars = word.chars();
                                chars.next().map_or_else(String::new, |first| {
                                    first.to_uppercase().chain(chars).collect()
                                })
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    },
                    |known| known.1.to_owned(),
                ),
                native: known.map_or("", |known| known.2).to_owned(),
                description: known.map_or("", |known| known.3).to_owned(),
                speaker,
            }
        })
        .collect()
}

/// The stock speaker a Qwen3-TTS entry of `tts_models` names, if any.
pub fn entry_speaker(model: &Map<String, Value>) -> Option<String> {
    if model.get("model").and_then(Value::as_str) != Some("qwen3-tts")
        || model.get("voice_embedding").is_some_and(Value::is_string)
    {
        return None;
    }
    let speaker = match model.get("voice") {
        None | Some(Value::Null) => model.get("speaker"),
        voice => voice,
    };
    speaker
        .and_then(Value::as_str)
        .filter(|speaker| !speaker.is_empty())
        .map(str::to_lowercase)
}

#[cfg(test)]
mod tests;
