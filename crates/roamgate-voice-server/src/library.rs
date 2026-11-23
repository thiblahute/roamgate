//! The voices replies can be read with, and which reads what
//! (server/src/voice/voice-library.ts).
//!
//! A voice is an any-tts voice embedding (JSON) for Qwen3-TTS: those
//! recorded from the page live in the voices directory (`voices_dir` in
//! voice.json, ~/.local/share/roamgate/voices by default) as `<id>.json`,
//! with their recording as `<id>.wav`; `voices.json` there lists every voice
//! with its name and languages, those made elsewhere included (the
//! `voice_embedding` files voice.json reads with are added the first time
//! they are seen, so they stay listed once no longer used).
//!
//! Qwen3-TTS's stock speakers (stock.rs) read too, with its CustomVoice
//! model: their ids are `qwen3-tts:<speaker>`.
//!
//! Which voice reads which language is voice.json's `tts_models`, the order
//! the helper picks from: a Qwen3-TTS entry per language with a voice of its
//! own (`languages`), then one for every other language, then the other
//! models (Kokoro) as they were, reading whatever no voice does.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use roamgate_agents::js::{iso, slice16, trim};
use roamgate_base::clock::BoxFuture;
use roamgate_base::paths::resolve;
use serde_json::{Map, Value, json};

use crate::config::{TtsModel, VoiceConfig, read_voice_config};
use crate::helper::{ClonedVoice, ConfigSource};
use crate::reading::{
    choose_transcript, clean_voice_name, is_voice_language, unique_voice_id, voice_slug,
};
use crate::stock::{
    StockVoice, entry_speaker, is_stock_voice_id, stock_model, stock_voice_id, stock_voices,
};

pub const KOKORO: &str = "kokoro";
const QWEN: &str = "qwen3-tts";

/// A refused request, with the HTTP status that says why; None for an
/// error that is not one (a plain Error in Bun).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceError {
    pub status: Option<u16>,
    pub message: String,
}

impl VoiceError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: Some(status),
            message: message.into(),
        }
    }

    fn plain(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

type Result<T> = std::result::Result<T, VoiceError>;

/// A clone request (VoiceCloneRequest): the recording, the Qwen3-TTS Base
/// model directory, where to keep the recording as cut, its language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceCloneRequest {
    pub audio: String,
    pub model: String,
    pub reference: String,
    pub language: String,
}

impl VoiceCloneRequest {
    /// As the helper's clone_voice takes it.
    pub fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("audio".into(), json!(self.audio));
        map.insert("model".into(), json!(self.model));
        map.insert("reference".into(), json!(self.reference));
        map.insert("language".into(), json!(self.language));
        map
    }
}

pub fn default_voices_dir(home: &Path, platform: &str, app_data: Option<&Path>) -> PathBuf {
    if platform == "win32" {
        let base = app_data.map_or_else(|| home.join("AppData").join("Roaming"), Path::to_path_buf);
        base.join("roamgate").join("voices")
    } else {
        home.join(".local")
            .join("share")
            .join("roamgate")
            .join("voices")
    }
}

fn plain_error(error: impl std::fmt::Display) -> VoiceError {
    VoiceError::plain(error.to_string())
}

fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).map_err(plain_error)?;
    serde_json::from_str(&text)
        .map(roamgate_base::json::js_value)
        .map_err(|error| VoiceError::plain(crate::config::json_parse_error(&error)))
}

/// Written whole then moved into place: a reader never sees half of it.
fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(plain_error)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    std::fs::write(
        &temporary,
        format!("{}\n", crate::js::stringify_pretty(value)),
    )
    .map_err(plain_error)?;
    std::fs::rename(&temporary, path).map_err(plain_error)
}

fn same_path(a: &str, b: &str) -> bool {
    resolve(Path::new(a)) == resolve(Path::new(b))
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn models_of(config: &VoiceConfig) -> Vec<TtsModel> {
    config
        .get("tts_models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn is_model(model: &TtsModel, name: &str) -> bool {
    model.get("model").and_then(Value::as_str) == Some(name)
}

/// Whether the model directory `path` is a Qwen3-TTS Base, which clones.
pub fn is_cloning_model(path: &Path) -> bool {
    let Ok(config) = read_json(&path.join("config.json")) else {
        return false;
    };
    let encoder = config.get("speaker_encoder_config");
    let truthy = match encoder {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    truthy
        && path
            .join("speech_tokenizer")
            .join("model.safetensors")
            .exists()
}

/// The Qwen3-TTS Base model voices are cloned for, and read with:
/// `clone_model`, or the first Qwen3-TTS model voice.json reads with.
pub fn cloning_model(config: &VoiceConfig) -> Option<String> {
    std::iter::once(config.get("clone_model").cloned())
        .chain(
            models_of(config)
                .into_iter()
                .filter(|model| is_model(model, QWEN))
                .map(|model| model.get("path").cloned()),
        )
        .flatten()
        .filter_map(|candidate| candidate.as_str().map(str::to_owned))
        .find(|candidate| is_cloning_model(Path::new(candidate)))
}

/// Which voice reads what: a voice id, or "kokoro" for Kokoro's voices.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VoiceAssignments {
    /// Every language without a voice of its own; None when none is set.
    pub all: Option<String>,
    /// By language, in the order they were set.
    pub languages: Vec<(String, String)>,
}

impl VoiceAssignments {
    pub fn to_json(&self) -> Value {
        let languages: Map<String, Value> = self
            .languages
            .iter()
            .map(|(code, id)| (code.clone(), json!(id)))
            .collect();
        json!({"all": self.all, "languages": languages})
    }

    fn language(&self, code: &str) -> Option<&String> {
        self.languages
            .iter()
            .find(|(known, _)| known == code)
            .map(|(_, id)| id)
    }

    fn set_language(&mut self, code: &str, id: &str) {
        match self.languages.iter_mut().find(|(known, _)| known == code) {
            Some(slot) => slot.1 = id.to_owned(),
            None => self.languages.push((code.to_owned(), id.to_owned())),
        }
    }
}

/// Which voice reads what, as `tts_models` says.
pub fn assignments_from(
    models: &[TtsModel],
    id_of_path: impl Fn(&str) -> Option<String>,
) -> VoiceAssignments {
    let mut assignments = VoiceAssignments::default();
    for model in models {
        if !is_model(model, QWEN) {
            continue;
        }
        let id = match entry_speaker(model) {
            Some(speaker) => Some(stock_voice_id(&speaker)),
            None => model
                .get("voice_embedding")
                .and_then(Value::as_str)
                .and_then(&id_of_path),
        };
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            continue;
        };
        let languages: Vec<String> = match model.get("languages") {
            Some(Value::String(text)) => {
                text.split(',').map(|code| trim(code).to_owned()).collect()
            }
            _ => Vec::new(),
        };
        if languages.is_empty() && assignments.all.is_none() {
            assignments.all = Some(id.clone());
        }
        for code in languages {
            if is_voice_language(&code) && assignments.language(&code).is_none() {
                assignments.set_language(&code, &id);
            }
        }
    }
    if assignments.all.is_none() && models.iter().any(|model| is_model(model, KOKORO)) {
        assignments.all = Some(KOKORO.into());
    }
    assignments
}

/// What a Qwen3-TTS entry reads a voice with: a cloned voice's embedding
/// (on the Base model), or a stock speaker and its CustomVoice model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceReader {
    Embedding(String),
    Stock { path: String, voice: String },
}

/// `tts_models` reading as `assignments` says with the voices `reader_of`
/// gives: the Qwen3-TTS entries made again (keeping the other fields of the
/// one they replace, such as a temperature), the other models after them as
/// they were. Cloned voices read with the Base model at `qwen_path`.
pub fn models_for(
    models: &[TtsModel],
    assignments: &VoiceAssignments,
    reader_of: impl Fn(&str) -> Option<VoiceReader>,
    qwen_path: &str,
) -> Vec<TtsModel> {
    let qwen: Vec<&TtsModel> = models
        .iter()
        .filter(|model| is_model(model, QWEN))
        .collect();
    let entry = |languages: Option<&str>, reader: &VoiceReader| -> TtsModel {
        let previous = qwen
            .iter()
            .find(|model| match languages {
                Some(code) => model.get("languages").and_then(Value::as_str) == Some(code),
                None => !model.contains_key("languages"),
            })
            .or_else(|| qwen.iter().find(|model| !model.contains_key("languages")))
            .or_else(|| qwen.first());
        let mut made: TtsModel = previous.map_or_else(
            || {
                let mut model = Map::new();
                model.insert("model".into(), json!(QWEN));
                model
            },
            |model| (*model).clone(),
        );
        for key in ["languages", "voice_embedding", "voice", "speaker"] {
            made.shift_remove(key);
        }
        made.insert("model".into(), json!(QWEN));
        match reader {
            VoiceReader::Stock { path, voice } => {
                made.insert("path".into(), json!(path));
                made.insert("voice".into(), json!(voice));
            }
            VoiceReader::Embedding(embedding) => {
                // Cloned voices need the Base model, whatever read before.
                let path = if !qwen_path.is_empty() {
                    json!(qwen_path)
                } else {
                    match made.get("path") {
                        Some(path) if is_truthy(path) => path.clone(),
                        _ => json!(""),
                    }
                };
                made.insert("path".into(), path);
                made.insert("voice_embedding".into(), json!(embedding));
            }
        }
        made
    };
    let mut entries = Vec::new();
    for (language, id) in &assignments.languages {
        let Some(reader) = reader_of(id) else {
            continue;
        };
        let mut made = entry(Some(language), &reader);
        made.shift_remove("languages");
        made.insert("languages".into(), json!(language));
        entries.push(made);
    }
    if let Some(all) = assignments.all.as_deref().filter(|all| *all != KOKORO)
        && let Some(reader) = reader_of(all)
    {
        entries.push(entry(None, &reader));
    }
    entries.extend(
        models
            .iter()
            .filter(|model| !is_model(model, QWEN))
            .cloned(),
    );
    entries
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// Clones a voice from a recording (the helper's clone_voice).
pub type CloneVoice = Arc<
    dyn Fn(VoiceCloneRequest) -> BoxFuture<std::result::Result<ClonedVoice, String>> + Send + Sync,
>;
/// voice.json changed which models read: tell the running helper.
pub type Applied = Arc<dyn Fn() -> BoxFuture<()> + Send + Sync>;

/// What the library reads and calls.
#[derive(Clone)]
pub struct LibraryOptions {
    /// voice.json, as read; read_voice_config of config_path when None.
    pub read_config: Option<ConfigSource>,
    pub config_path: PathBuf,
    /// Where voices go when voice.json names no voices_dir.
    pub default_voices_dir: PathBuf,
    pub clone: CloneVoice,
    pub applied: Option<Applied>,
    /// Epoch milliseconds now.
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

/// A recording made a voice: the voice, what was heard, and the words kept
/// with it and where they come from (shown, partial or heard).
#[derive(Debug, Clone, PartialEq)]
pub struct Created {
    pub voice: Value,
    pub heard: String,
    pub transcript: String,
    pub kind: &'static str,
}

/// What `create` takes, as the request gave it.
#[derive(Debug, Clone, Default)]
pub struct CreateInput {
    pub name: Value,
    pub language: Value,
    pub text: Value,
    pub audio: String,
    pub cut: bool,
}

/// The voice library on disk, and voice.json's choice of voices.
#[derive(Clone)]
pub struct VoiceLibrary {
    options: LibraryOptions,
}

impl VoiceLibrary {
    pub fn new(options: LibraryOptions) -> Self {
        Self { options }
    }

    pub fn config(&self) -> Result<VoiceConfig> {
        let read = match &self.options.read_config {
            Some(read) => read(),
            None => read_voice_config(&self.options.config_path),
        };
        read.map_err(VoiceError::plain)
    }

    pub fn voices_dir(&self, config: &VoiceConfig) -> PathBuf {
        config
            .str("voices_dir")
            .map_or_else(|| self.options.default_voices_dir.clone(), PathBuf::from)
    }

    fn index_path(&self, config: &VoiceConfig) -> PathBuf {
        self.voices_dir(config).join("voices.json")
    }

    fn read_index(&self, config: &VoiceConfig) -> Result<Vec<Value>> {
        let path = self.index_path(config);
        if !path.exists() {
            return Ok(Vec::new());
        }
        Ok(match read_json(&path)?.get("voices") {
            Some(Value::Array(voices)) => voices.clone(),
            _ => Vec::new(),
        })
    }

    fn write_index(&self, config: &VoiceConfig, voices: Vec<Value>) -> Result<()> {
        write_json(&self.index_path(config), &json!({ "voices": voices }))
    }

    fn owned(&self, config: &VoiceConfig, path: &str) -> bool {
        let inside = format!(
            "{}{}",
            resolve(&self.voices_dir(config)).display(),
            std::path::MAIN_SEPARATOR
        );
        resolve(Path::new(path))
            .display()
            .to_string()
            .starts_with(&inside)
    }

    /// Every voice, those voice.json reads with added to the list if new
    /// (named after their file).
    pub fn list(&self, config: &VoiceConfig) -> Result<Vec<Value>> {
        let mut index = self.read_index(config)?;
        let mut changed = false;
        for model in models_of(config) {
            let Some(path) = model.get("voice_embedding").and_then(Value::as_str) else {
                continue;
            };
            if !is_model(&model, QWEN)
                || index
                    .iter()
                    .any(|voice| str_of(voice, "path").is_some_and(|known| same_path(known, path)))
            {
                continue;
            }
            let file = Path::new(path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stem = if file.to_lowercase().ends_with(".json") {
                file[..file.len() - 5].to_owned()
            } else {
                file
            };
            let id = unique_voice_id(&voice_slug(&stem), |id| {
                index.iter().any(|voice| str_of(voice, "id") == Some(id))
            });
            let languages: Vec<&str> = match model.get("languages") {
                Some(Value::String(text)) => text
                    .split(',')
                    .filter(|code| is_voice_language(code))
                    .collect(),
                _ => Vec::new(),
            };
            index.push(json!({"id": id, "name": stem, "languages": languages, "path": path}));
            changed = true;
        }
        if changed {
            self.write_index(config, index.clone())?;
        }
        Ok(index
            .into_iter()
            .filter(|voice| str_of(voice, "path").is_some_and(|path| Path::new(path).exists()))
            .map(|mut voice| {
                let owned = self.owned(config, str_of(&voice, "path").unwrap_or(""));
                if let Some(map) = voice.as_object_mut() {
                    map.insert("owned".into(), json!(owned));
                }
                voice
            })
            .collect())
    }

    /// The voices, grouped by model: those recorded (Qwen3-TTS Base), the
    /// stock ones (Qwen3-TTS CustomVoice) and Kokoro; which reads what, and
    /// whether new ones can be recorded.
    pub fn state(&self) -> Result<Value> {
        let config = self.config()?;
        let voices = self.list(&config)?;
        let models = models_of(&config);
        let model = cloning_model(&config);
        let stock = stock_voices(stock_model(&config).as_deref());
        let assignments = assignments_from(&models, |path| {
            voices
                .iter()
                .find(|voice| str_of(voice, "path").is_some_and(|known| same_path(known, path)))
                .and_then(|voice| str_of(voice, "id").map(str::to_owned))
        });
        let mut state = Map::new();
        state.insert("voices".into(), Value::Array(voices));
        state.insert(
            "stock".into(),
            serde_json::to_value(&stock).map_err(plain_error)?,
        );
        if stock.is_empty() {
            state.insert(
                "stock_detail".into(),
                json!(
                    "Stock voices need a Qwen3-TTS CustomVoice model (stock_model in voice.json)."
                ),
            );
        }
        state.insert(
            "kokoro".into(),
            json!(models.iter().any(|entry| is_model(entry, KOKORO))),
        );
        state.insert(
            "surprise".into(),
            json!(config.get("voice_surprise") == Some(&json!(true))),
        );
        state.insert("assignments".into(), assignments.to_json());
        state.insert("can_clone".into(), json!(model.is_some()));
        if model.is_none() {
            let detail = if config.get("tts_models").is_some_and(is_truthy) {
                "Recording voices needs a Qwen3-TTS Base model (clone_model in voice.json)."
            } else {
                "Recording voices needs any-tts models (tts_models in voice.json)."
            };
            state.insert("clone_detail".into(), json!(detail));
        }
        Ok(Value::Object(state))
    }

    /// A new voice from the recording at `audio`: cloned by the helper,
    /// which also hears what it says; the words kept are those it says
    /// (choose_transcript). `cut`: the recording ended mid-speech.
    pub async fn create(&self, input: CreateInput) -> Result<Created> {
        let Some(name) = clean_voice_name(input.name.as_str()) else {
            return Err(VoiceError::new(400, "The voice needs a name."));
        };
        let Some(language) = input
            .language
            .as_str()
            .filter(|code| is_voice_language(code))
        else {
            return Err(VoiceError::new(400, "Unknown language."));
        };
        let shown = input
            .text
            .as_str()
            .map_or_else(String::new, |text| slice16(text, 0, Some(2000)));
        let config = self.config()?;
        let Some(model) = cloning_model(&config) else {
            return Err(VoiceError::new(
                409,
                "Recording voices needs a Qwen3-TTS Base model (clone_model in voice.json).",
            ));
        };
        let dir = self.voices_dir(&config);
        std::fs::create_dir_all(&dir).map_err(plain_error)?;
        // Those voice.json reads with first, listed in the order they came.
        self.list(&config)?;
        let index = self.read_index(&config)?;
        let id = unique_voice_id(&voice_slug(&name), |taken| {
            index.iter().any(|voice| str_of(voice, "id") == Some(taken))
                || dir.join(format!("{taken}.json")).exists()
        });
        let path = dir.join(format!("{id}.json"));
        let reference = dir.join(format!("{id}.wav"));
        let request = VoiceCloneRequest {
            audio: input.audio.clone(),
            model,
            reference: reference.display().to_string(),
            language: language.to_owned(),
        };
        let cloned = match (self.options.clone)(request).await {
            Ok(cloned) => cloned,
            Err(message) => {
                let _ = std::fs::remove_file(&reference);
                return Err(VoiceError::new(422, message));
            }
        };
        let (text, kind) = choose_transcript(&shown, &cloned.heard, input.cut);
        let mut embedding = Map::new();
        embedding.insert("data".into(), Value::Array(cloned.embedding.clone()));
        embedding.insert("shape".into(), json!([cloned.embedding.len()]));
        embedding.insert("model_type".into(), json!(QWEN));
        if !text.is_empty() {
            embedding.insert(
                "prompt".into(),
                json!({"codes": cloned.codes, "text": text}),
            );
        }
        write_json(&path, &Value::Object(embedding))?;
        let voice = json!({
            "id": id,
            "name": name,
            "languages": [language],
            "path": path.display().to_string(),
            "reference": reference.display().to_string(),
            "created": iso((self.options.now)()),
        });
        // Read again: another voice may have been added while this one cloned.
        let mut latest = self.read_index(&config)?;
        latest.push(voice.clone());
        self.write_index(&config, latest)?;
        let mut owned = voice;
        owned["owned"] = json!(true);
        Ok(Created {
            voice: owned,
            heard: cloned.heard,
            transcript: text,
            kind: kind.as_str(),
        })
    }

    fn find(&self, config: &VoiceConfig, id: &str) -> Result<Value> {
        self.list(config)?
            .into_iter()
            .find(|voice| str_of(voice, "id") == Some(id))
            .ok_or_else(|| VoiceError::new(404, "No such voice."))
    }

    pub fn rename(&self, id: &str, name: &Value) -> Result<Value> {
        let Some(clean) = clean_voice_name(name.as_str()) else {
            return Err(VoiceError::new(400, "The voice needs a name."));
        };
        let config = self.config()?;
        let mut voice = self.find(&config, id)?;
        let mut index = self.read_index(&config)?;
        for entry in &mut index {
            if str_of(entry, "id") == Some(id) {
                entry["name"] = json!(clean);
            }
        }
        self.write_index(&config, index)?;
        voice["name"] = json!(clean);
        Ok(voice)
    }

    /// Forgets the voice, and deletes its files when recorded here. One
    /// reading replies is kept: another must be chosen first.
    pub fn delete(&self, id: &str) -> Result<()> {
        let config = self.config()?;
        let voice = self.find(&config, id)?;
        let path = str_of(&voice, "path").unwrap_or("").to_owned();
        if models_of(&config).iter().any(|model| {
            model
                .get("voice_embedding")
                .and_then(Value::as_str)
                .is_some_and(|embedding| same_path(embedding, &path))
        }) {
            return Err(VoiceError::new(
                409,
                format!(
                    "{} reads replies: choose another voice first.",
                    str_of(&voice, "name").unwrap_or("")
                ),
            ));
        }
        let index: Vec<Value> = self
            .read_index(&config)?
            .into_iter()
            .filter(|entry| str_of(entry, "id") != Some(id))
            .collect();
        self.write_index(&config, index)?;
        if voice.get("owned") == Some(&json!(true)) {
            let _ = std::fs::remove_file(&path);
            if let Some(reference) = str_of(&voice, "reference")
                && self.owned(&config, reference)
            {
                let _ = std::fs::remove_file(reference);
            }
        }
        Ok(())
    }

    /// The stock voice `id`, and how it reads; None when it is not one.
    fn stock(&self, config: &VoiceConfig, id: &str) -> Result<Option<(StockVoice, VoiceReader)>> {
        if !is_stock_voice_id(id) {
            return Ok(None);
        }
        let path = stock_model(config);
        let voice = stock_voices(path.as_deref())
            .into_iter()
            .find(|entry| entry.id == id);
        match (path, voice) {
            (Some(path), Some(voice)) => {
                let reader = VoiceReader::Stock {
                    path: path.display().to_string(),
                    voice: voice.speaker.clone(),
                };
                Ok(Some((voice, reader)))
            }
            _ => Err(VoiceError::new(404, "No such voice.")),
        }
    }

    /// `tts_models` with the voice `id` reading everything, for a sample.
    pub fn sample_models(&self, id: &str) -> Result<Vec<TtsModel>> {
        let config = self.config()?;
        let models = models_of(&config);
        if id == KOKORO {
            let kokoro: Vec<TtsModel> = models
                .into_iter()
                .filter(|model| is_model(model, KOKORO))
                .collect();
            if kokoro.is_empty() {
                return Err(VoiceError::new(404, "No Kokoro voice."));
            }
            return Ok(kokoro);
        }
        let all = VoiceAssignments {
            all: Some(id.to_owned()),
            languages: Vec::new(),
        };
        if let Some((_, reader)) = self.stock(&config, id)? {
            return Ok(models_for(
                &models,
                &all,
                |wanted| (wanted == id).then(|| reader.clone()),
                "",
            ));
        }
        let voice = self.find(&config, id)?;
        let Some(model) = cloning_model(&config) else {
            return Err(VoiceError::new(409, "No Qwen3-TTS model to read with."));
        };
        let path = str_of(&voice, "path").unwrap_or("").to_owned();
        Ok(models_for(
            &models,
            &all,
            |wanted| (wanted == id).then(|| VoiceReader::Embedding(path.clone())),
            &model,
        ))
    }

    fn raw_config(&self) -> Result<Map<String, Value>> {
        match read_json(&self.options.config_path)? {
            Value::Object(map) => Ok(map),
            _ => Ok(Map::new()),
        }
    }

    /// Has `voice` read `language` (or every language, its own voices
    /// dropped, when none), or stops giving `language` a voice of its own
    /// (`voice` None); kept in voice.json, and told to the running helper.
    pub async fn assign(&self, voice: Option<&str>, language: &Value) -> Result<Value> {
        let config = self.config()?;
        let code = language.as_str().filter(|code| is_voice_language(code));
        if !language.is_null() && code.is_none() {
            return Err(VoiceError::new(400, "Unknown language."));
        }
        let Some(Value::Array(_)) = config.get("tts_models") else {
            return Err(VoiceError::new(
                409,
                "Choosing voices needs any-tts models (tts_models in voice.json).",
            ));
        };
        let current_models = models_of(&config);
        let state = self.state()?;
        let voices: Vec<Value> = state["voices"].as_array().cloned().unwrap_or_default();
        let kokoro = state["kokoro"] == json!(true);
        let mut next = VoiceAssignments {
            all: state["assignments"]["all"].as_str().map(str::to_owned),
            languages: state["assignments"]["languages"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(code, id)| Some((code.clone(), id.as_str()?.to_owned())))
                .collect(),
        };
        match voice {
            Some(id) if is_stock_voice_id(id) => {
                self.stock(&config, id)?;
            }
            Some(id)
                if id != KOKORO && !voices.iter().any(|known| str_of(known, "id") == Some(id)) =>
            {
                return Err(VoiceError::new(404, "No such voice."));
            }
            _ => {}
        }
        if voice == Some(KOKORO) && !kokoro {
            return Err(VoiceError::new(404, "No Kokoro voice."));
        }
        // Kokoro reads what no cloned voice does: all of it, or nothing.
        if voice == Some(KOKORO) && code.is_some() {
            return Err(VoiceError::new(
                400,
                "Kokoro reads every language or none: choose it for all of them.",
            ));
        }
        match (code, voice) {
            (Some(code), voice) => {
                if voice.is_none() || voice.map(str::to_owned) == next.all {
                    next.languages.retain(|(known, _)| known != code);
                } else if let Some(voice) = voice {
                    next.set_language(code, voice);
                }
            }
            (None, None) => return Err(VoiceError::new(400, "Choose a voice.")),
            (None, Some(voice)) => {
                next.all = Some(voice.to_owned());
                next.languages.clear();
            }
        }
        let cloning = cloning_model(&config);
        let qwen: Option<Value> = cloning.clone().map(Value::String).or_else(|| {
            current_models
                .iter()
                .find(|model| is_model(model, QWEN))
                .and_then(|model| model.get("path").cloned())
        });
        let cloned = next
            .all
            .iter()
            .chain(next.languages.iter().map(|(_, id)| id))
            .any(|id| !id.is_empty() && id != KOKORO && !is_stock_voice_id(id));
        if !qwen.as_ref().is_some_and(Value::is_string) && cloned {
            return Err(VoiceError::new(409, "No Qwen3-TTS model to read with."));
        }
        let qwen_path = match &qwen {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(path)) => path.clone(),
            Some(other) => crate::js::stringify(other),
        };
        let stock_error = std::cell::RefCell::new(None);
        let models = models_for(
            &current_models,
            &next,
            |id| {
                if is_stock_voice_id(id) {
                    return match self.stock(&config, id) {
                        Ok(found) => found.map(|(_, reader)| reader),
                        Err(error) => {
                            stock_error.borrow_mut().get_or_insert(error);
                            None
                        }
                    };
                }
                voices
                    .iter()
                    .find(|entry| str_of(entry, "id") == Some(id))
                    .and_then(|entry| str_of(entry, "path"))
                    .map(|path| VoiceReader::Embedding(path.to_owned()))
            },
            &qwen_path,
        );
        if let Some(error) = stock_error.into_inner() {
            return Err(error);
        }
        if models.is_empty() {
            return Err(VoiceError::new(
                409,
                "That would leave no voice to read with.",
            ));
        }
        let mut raw = self.raw_config()?;
        raw.insert(
            "tts_models".into(),
            Value::Array(models.iter().cloned().map(Value::Object).collect()),
        );
        // The models found in `tts_models` stay known once no longer read
        // with: recording voices, and choosing them again, still work.
        let reads = |list: &[TtsModel], path: &str| {
            list.iter().any(|model| {
                model
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|known| same_path(known, path))
            })
        };
        let dropped = |path: &str| reads(&current_models, path) && !reads(&models, path);
        if let Some(cloning) = &cloning
            && !config.get("clone_model").is_some_and(is_truthy)
            && dropped(cloning)
        {
            raw.insert("clone_model".into(), json!(cloning));
        }
        if let Some(stock) = stock_model(&config) {
            let stock = stock.display().to_string();
            if !config.get("stock_model").is_some_and(is_truthy) && dropped(&stock) {
                raw.insert("stock_model".into(), json!(stock));
            }
        }
        // A voice chosen reads, not one at random.
        if voice.is_some() {
            raw.shift_remove("voice_surprise");
        }
        write_json(&self.options.config_path, &Value::Object(raw))?;
        if let Some(applied) = &self.options.applied {
            applied().await;
        }
        self.state()
    }

    /// Surprise on or off (`voice_surprise` in voice.json): each reply read
    /// by one of the voices at random.
    pub fn set_surprise(&self, on: bool) -> Result<Value> {
        let config = self.config()?;
        if on {
            if cloning_model(&config).is_none() {
                return Err(VoiceError::new(409, "No Qwen3-TTS model to read with."));
            }
            if self.list(&config)?.is_empty() {
                return Err(VoiceError::new(409, "Record a voice first."));
            }
        }
        let mut raw = self.raw_config()?;
        if on {
            raw.insert("voice_surprise".into(), json!(true));
        } else {
            raw.shift_remove("voice_surprise");
        }
        write_json(&self.options.config_path, &Value::Object(raw))?;
        self.state()
    }

    /// The voices Surprise picks from, with Surprise on and a model to read
    /// them with; else None.
    pub fn surprise_voices(&self) -> Result<Option<Vec<Value>>> {
        let config = self.config()?;
        if config.get("voice_surprise") != Some(&json!(true)) || cloning_model(&config).is_none() {
            return Ok(None);
        }
        let voices = self.list(&config)?;
        Ok((!voices.is_empty()).then_some(voices))
    }
}

#[cfg(test)]
mod tests;
