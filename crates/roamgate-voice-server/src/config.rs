//! voice.json (server/src/voice/voice-helper.ts, VoiceConfig): where the
//! helper and its models are, and the voice's settings. Without it, voice
//! is unavailable. Read on each use, checked as the Bun server checks it,
//! with its messages; written back whole (replaced by rename), its other
//! settings untouched.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::js;
use crate::speech_rate::{is_speech_rate, speech_rate_or};

/// A `tts_models` entry: `model` and the element's own fields.
pub type TtsModel = Map<String, Value>;

/// voice.json as read: its keys as they are, with typed accessors.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VoiceConfig {
    pub raw: Map<String, Value>,
}

/// What a front does with the agents' answers on a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontMode {
    Companion,
    Relay,
}

impl FrontMode {
    pub fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "companion" => Some(Self::Companion),
            "relay" => Some(Self::Relay),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Companion => "companion",
            Self::Relay => "relay",
        }
    }
}

pub const MAX_PAUSE_MS: f64 = 8_000.0;
pub const MIN_PAUSE_MS: f64 = 2_000.0;
pub const LONGEST_PAUSE_MS: f64 = 15_000.0;
/// call_reply_loudness's default: broadcast speech's level.
pub const CALL_REPLY_LOUDNESS: f64 = -16.0;
pub const YIELD_CPU_NICE: i32 = 10;
pub const YIELD_CPU_WEIGHT: u32 = 20;
/// How long a wrapped helper has to end once its input closed.
pub const WRAPPED_EXIT_MS: u64 = 15_000;

/// `max_pause_ms` as voice.json may give it: MAX_PAUSE_MS when unusable.
pub fn max_pause_ms(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(ms) if ms.is_finite() && (MIN_PAUSE_MS..=LONGEST_PAUSE_MS).contains(&ms) => {
            js::round(ms)
        }
        _ => MAX_PAUSE_MS,
    }
}

/// A dotted IPv4 address, each part 0 to 255.
pub fn is_ipv4(address: &str) -> bool {
    let parts: Vec<&str> = address.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            (1..=3).contains(&part.len())
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok_and(|n| n <= 255)
        })
}

/// A call's background as the helper's call_start takes it.
#[derive(Debug, Clone, PartialEq)]
pub struct CallBackground {
    pub background: String,
    pub volume: f64,
    pub ducked: f64,
    pub release_ms: f64,
    pub muted: bool,
    pub reply_loudness: Option<f64>,
}

impl CallBackground {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("background".into(), json!(self.background));
        out.insert("volume".into(), js::number(self.volume));
        out.insert("ducked".into(), js::number(self.ducked));
        out.insert("release_ms".into(), js::number(self.release_ms));
        out.insert("muted".into(), Value::Bool(self.muted));
        out.insert(
            "reply_loudness".into(),
            self.reply_loudness.map_or(Value::Null, js::number),
        );
        out
    }
}

pub fn voice_config_path(root: &Path) -> PathBuf {
    root.join("voice.json")
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

/// JavaScriptCore's words for JSON it cannot parse, as far as serde tells
/// (the message after "JSON Parse error: " is not byte-identical).
pub fn json_parse_error(error: &serde_json::Error) -> String {
    use serde_json::error::Category;
    let reason = match error.classify() {
        Category::Eof => "Unexpected EOF".to_owned(),
        _ => {
            let text = error.to_string();
            let reason = text.split(" at line").next().unwrap_or(&text);
            if reason.contains("key must be a string") {
                "Property name must be a string literal".to_owned()
            } else if reason.contains("EOF while parsing a string") {
                "Unterminated string".to_owned()
            } else if reason.contains("trailing characters") {
                "Unable to parse JSON string".to_owned()
            } else {
                let mut chars = reason.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_uppercase().chain(chars).collect()
                })
            }
        }
    };
    format!("JSON Parse error: {reason}")
}

impl VoiceConfig {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.raw.get(key)
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str)
    }

    pub fn f64(&self, key: &str) -> Option<f64> {
        self.raw.get(key).and_then(Value::as_f64)
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.raw.get(key).and_then(Value::as_bool)
    }

    pub fn helper(&self) -> &str {
        self.str("helper").unwrap_or("")
    }

    pub fn strings(&self, key: &str) -> Option<Vec<String>> {
        self.raw.get(key)?.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
    }

    pub fn helper_wrapper(&self) -> Vec<String> {
        self.strings("helper_wrapper").unwrap_or_default()
    }

    pub fn tts_models(&self) -> Option<Vec<TtsModel>> {
        self.raw.get("tts_models")?.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.raw.insert(key.into(), value);
    }

    pub fn speech_rate(&self) -> f64 {
        speech_rate_or(self.raw.get("speech_rate"))
    }

    pub fn low_gpu(&self) -> Option<&str> {
        self.str("low_gpu")
    }

    /// `yield_cpu.threads`, when the helper yields the CPU to a game.
    pub fn yield_cpu(&self) -> Option<f64> {
        self.raw
            .get("yield_cpu")
            .and_then(|value| value.get("threads"))
            .and_then(Value::as_f64)
    }

    /// What the front does with the answers; None without a front.
    pub fn front_mode(&self) -> Option<FrontMode> {
        self.str("front_model").filter(|model| !model.is_empty())?;
        Some(
            self.raw
                .get("front_mode")
                .and_then(FrontMode::parse)
                .unwrap_or(FrontMode::Companion),
        )
    }

    pub fn call_background(&self) -> CallBackground {
        CallBackground {
            background: self
                .str("call_background")
                .map(|text| js::trim(text).to_owned())
                .unwrap_or_default(),
            volume: self.f64("call_background_volume").unwrap_or(0.6),
            ducked: self.f64("call_background_ducked").unwrap_or(0.15),
            release_ms: self.f64("call_background_release_ms").unwrap_or(3000.0),
            muted: self.bool("call_music_at_start") != Some(true),
            reply_loudness: match self.raw.get("call_reply_loudness") {
                Some(Value::Bool(false)) => None,
                Some(value) => value.as_f64().or(Some(CALL_REPLY_LOUDNESS)),
                None => Some(CALL_REPLY_LOUDNESS),
            },
        }
    }

    /// The rate the helper's voice model speaks at by itself.
    pub fn native_speech_rate(&self) -> f64 {
        match self.tts_models() {
            Some(models)
                if !models.is_empty()
                    && models.iter().all(|model| {
                        model.get("model").and_then(Value::as_str) == Some("kokoro")
                            && !model.contains_key("speed")
                    }) =>
            {
                self.speech_rate()
            }
            _ => 1.0,
        }
    }

    /// `tts_models` as the helper gets them.
    pub fn helper_tts_models(&self) -> Option<Vec<TtsModel>> {
        let rate = self.native_speech_rate();
        self.tts_models().map(|models| {
            models
                .into_iter()
                .map(|mut entry| {
                    let speaker = entry.shift_remove("speaker");
                    if let Some(speaker) = speaker
                        && !entry.contains_key("voice")
                    {
                        entry.insert("voice".into(), speaker);
                    }
                    if rate != 1.0 {
                        entry.insert("speed".into(), js::number(rate));
                    }
                    entry
                })
                .collect()
        })
    }

    /// helper_idle_exit_minutes in milliseconds: 0 for never.
    pub fn idle_exit_ms(&self) -> f64 {
        (self.f64("helper_idle_exit_minutes").unwrap_or(0.0) * 60_000.0).max(0.0)
    }

    /// `helper_wrapper` for a helper yielding the CPU.
    pub fn yield_cpu_wrapper(&self) -> Vec<String> {
        let wrapper = self.helper_wrapper();
        if self.yield_cpu().is_none() || !is_systemd_run(&wrapper) {
            return wrapper;
        }
        let mut out = vec![
            wrapper[0].clone(),
            "-p".into(),
            format!("Nice={YIELD_CPU_NICE}"),
            "-p".into(),
            format!("CPUWeight={YIELD_CPU_WEIGHT}"),
            "-p".into(),
            "IOSchedulingClass=idle".into(),
        ];
        out.extend(wrapper[1..].iter().cloned());
        out
    }

    /// The niceness the spawned process is given, for a helper yielding
    /// the CPU that systemd-run does not start.
    pub fn yield_cpu_priority(&self) -> Option<i32> {
        (self.yield_cpu().is_some() && !is_systemd_run(&self.helper_wrapper()))
            .then_some(YIELD_CPU_NICE)
    }

    /// The helper's command line.
    pub fn helper_command(&self) -> Vec<String> {
        let mut out = self.yield_cpu_wrapper();
        out.push(self.helper().to_owned());
        out.extend(transcriber_args(
            self.str("parakeet_model"),
            self.str("whisper_model"),
        ));
        let tts = self.helper_tts_models();
        if let Some(models) = &tts {
            out.push("--tts-models".into());
            out.push(js::stringify(&Value::Array(
                models.iter().cloned().map(Value::Object).collect(),
            )));
        }
        let kokoro_model = self.raw.get("kokoro_model");
        let kokoro_voices = self.raw.get("kokoro_voices");
        if tts.is_none() || (kokoro_model.is_some() && kokoro_voices.is_some()) {
            out.push("--kokoro-model".into());
            out.push(self.str("kokoro_model").unwrap_or("").into());
            out.push("--kokoro-voices".into());
            out.push(self.str("kokoro_voices").unwrap_or("").into());
        }
        let speaker_model = self.str("speaker_model").filter(|model| !model.is_empty());
        if let Some(model) = speaker_model {
            out.push("--speaker-model".into());
            out.push(model.into());
        }
        let drop = self.bool("drop_other_voices") == Some(true);
        if speaker_model.is_some() && drop {
            out.push("--drop-other-voices".into());
        }
        if speaker_model.is_some()
            && drop
            && self
                .raw
                .get("speaker_reference")
                .and_then(Value::as_array)
                .is_some_and(|items| !items.is_empty())
        {
            out.push("--speaker-reference".into());
            out.push(js::stringify(&self.raw["speaker_reference"]));
        }
        if let Some(model) = self.str("turn_model").filter(|model| !model.is_empty()) {
            out.push("--turn-model".into());
            out.push(model.into());
        }
        let text_turn = self
            .str("text_turn_model")
            .filter(|model| !model.is_empty());
        if let Some(model) = text_turn {
            out.push("--text-turn-model".into());
            out.push(model.into());
        }
        if text_turn.is_some()
            && self
                .str("parakeet_model")
                .is_some_and(|model| !model.is_empty())
        {
            out.push("--turn-give-up-ms".into());
            out.push(js::number_text(LONGEST_PAUSE_MS));
        }
        if let Some(threads) = self
            .yield_cpu()
            .filter(|threads| *threads != 0.0 && !threads.is_nan())
        {
            out.push("--cpu-threads".into());
            out.push(js::number_text(threads));
        }
        out
    }
}

/// Whether `wrapper` is systemd-run.
pub fn is_systemd_run(wrapper: &[String]) -> bool {
    wrapper
        .first()
        .and_then(|program| Path::new(program).file_name())
        .is_some_and(|name| name == "systemd-run")
}

/// The speech to text models the helper is given.
pub fn transcriber_args(parakeet: Option<&str>, whisper: Option<&str>) -> Vec<String> {
    match parakeet.filter(|model| !model.is_empty()) {
        None => vec!["--whisper-model".into(), whisper.unwrap_or("").into()],
        Some(parakeet) => {
            let mut out = vec!["--parakeet-model".into(), parakeet.into()];
            if let Some(whisper) = whisper.filter(|model| !model.is_empty()) {
                out.push("--whisper-model".into());
                out.push(whisper.into());
            }
            out
        }
    }
}

fn is_nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

/// Reads and checks voice.json; the error is the Bun server's message.
pub fn read_voice_config(path: &Path) -> Result<VoiceConfig, String> {
    let shown = path.display().to_string();
    if !path.exists() {
        return Err(format!("No voice configuration ({shown})"));
    }
    let text = fs::read_to_string(path).map_err(|error| format!("{shown}: {error}"))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{shown}: {}", json_parse_error(&error)))?;
    let Value::Object(config) = parsed else {
        // null and primitives; JSON.parse's arrays are objects to the TS
        // check, and fail on the helper below.
        if let Value::Array(_) = parsed {
            return Err(format!("{shown}: helper is required"));
        }
        return Err(format!("{shown}: not an object"));
    };
    check(&shown, config)
}

fn check(path: &str, config: Map<String, Value>) -> Result<VoiceConfig, String> {
    let get = |key: &str| config.get(key);
    let bad = |message: String| Err(format!("{path}: {message}"));
    {
        let key = "helper";
        let Some(value) = get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return bad(format!("{key} is required"));
        };
        if !exists(value) {
            return Err(format!("{key} not found: {value}"));
        }
    }
    for key in [
        "clean_model",
        "dictation_model",
        "dictation_command",
        "route_model",
        "front_model",
        "research_model",
        "errand_folder",
        "claude_command",
        "voices_dir",
        "clone_model",
        "stock_model",
    ] {
        if get(key).is_some() && !is_nonempty_string(get(key)) {
            return bad(format!("{key} must be a string"));
        }
    }
    let boolean = |key: &str| get(key).is_none_or(Value::is_boolean);
    if !boolean("voice_surprise") {
        return bad("voice_surprise must be true or false".into());
    }
    if !boolean("drop_other_voices") {
        return bad("drop_other_voices must be true or false".into());
    }
    if get("call_background").is_some_and(|value| !value.is_string()) {
        return bad("call_background must be a string".into());
    }
    for key in ["call_background_volume", "call_background_ducked"] {
        if get(key).is_some_and(|value| !value.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n))) {
            return bad(format!("{key} must be a number from 0 to 1"));
        }
    }
    if get("call_background_release_ms").is_some_and(|value| {
        !value
            .as_f64()
            .is_some_and(|n| (0.0..=60_000.0).contains(&n))
    }) {
        return bad("call_background_release_ms must be 0 to 60000".into());
    }
    if !boolean("call_music_at_start") {
        return bad("call_music_at_start must be true or false".into());
    }
    if get("call_music_device").is_some_and(|value| !value.is_string()) {
        return bad("call_music_device must be a string".into());
    }
    if !boolean("call_music_full_volume") {
        return bad("call_music_full_volume must be true or false".into());
    }
    if let Some(loudness) = get("call_reply_loudness")
        && *loudness != Value::Bool(false)
        && !loudness
            .as_f64()
            .is_some_and(|n| (-40.0..=-6.0).contains(&n))
    {
        return bad("call_reply_loudness must be -40 to -6 (LUFS), or false".into());
    }
    if get("call_ice_address").is_some_and(|value| !value.as_str().is_some_and(is_ipv4)) {
        return bad("call_ice_address must be an IPv4 address".into());
    }
    let argv = |value: &Value, empty_ok: bool| {
        value.as_array().is_some_and(|items| {
            items.iter().all(Value::is_string)
                && match items.first() {
                    None => empty_ok,
                    Some(first) => first.as_str().is_some_and(|first| !first.is_empty()),
                }
        })
    };
    if get("helper_wrapper").is_some_and(|value| !argv(value, true)) {
        return bad("helper_wrapper must be a list of arguments, a program first".into());
    }
    if get("yt_dlp").is_some_and(|value| !argv(value, false)) {
        return bad("yt_dlp must be a list of arguments, a program first".into());
    }
    if !boolean("youtube") {
        return bad("youtube must be true or false".into());
    }
    if get("helper_idle_exit_minutes")
        .is_some_and(|value| !value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
    {
        return bad("helper_idle_exit_minutes must be a number of minutes, 0 for never".into());
    }
    if get("gaming_cpu_threads")
        .is_some_and(|value| !value.as_f64().is_some_and(|n| n.fract() == 0.0 && n >= 0.0))
    {
        return bad("gaming_cpu_threads must be a number of threads, 0 for no limit".into());
    }
    if let Some(mcp) = get("companion_mcp") {
        let Some(mcp) = mcp.as_object() else {
            return bad("companion_mcp must be an object".into());
        };
        for key in ["allow", "confirm"] {
            if mcp.get(key).is_some_and(|value| {
                !value.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .all(|tool| tool.as_str().is_some_and(|tool| !js::trim(tool).is_empty()))
                })
            }) {
                return bad(format!("companion_mcp.{key} must be a list of tool names"));
            }
        }
        if mcp.get("model").is_some() && !is_nonempty_string(mcp.get("model")) {
            return bad("companion_mcp.model must be a string".into());
        }
    }
    if get("front_mode").is_some_and(|value| FrontMode::parse(value).is_none()) {
        return bad("front_mode must be \"companion\" or \"relay\"".into());
    }
    if get("speech_rate").is_some_and(|value| !is_speech_rate(value)) {
        return bad("speech_rate must be a number from 0.5 to 2".into());
    }
    if get("whisper_model").is_none() && get("parakeet_model").is_none() {
        return bad("whisper_model or parakeet_model is required".into());
    }
    if let Some(models) = get("tts_models") {
        let ok = models.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|model| {
                    model.get("model").is_some_and(Value::is_string) && model.is_object()
                })
        });
        if !ok {
            return bad("tts_models must be a list of objects with a model name".into());
        }
        for model in models.as_array().into_iter().flatten() {
            if model.get("speaker").is_some() && !is_nonempty_string(model.get("speaker")) {
                return bad(format!(
                    "the speaker of a {} model must be a name",
                    model.get("model").and_then(Value::as_str).unwrap_or("")
                ));
            }
        }
    } else if get("kokoro_model").is_none() || get("kokoro_voices").is_none() {
        return bad("kokoro_model and kokoro_voices, or tts_models, are required".into());
    }
    for key in [
        "kokoro_model",
        "kokoro_voices",
        "whisper_model",
        "parakeet_model",
        "speaker_model",
        "turn_model",
        "text_turn_model",
    ] {
        if let Some(value) = get(key) {
            match value.as_str() {
                Some(file) if exists(file) => {}
                _ => return Err(format!("{key} not found: {}", js_string(value))),
            }
        }
    }
    if let Some(paths) = get("speaker_reference") {
        let ok = paths
            .as_array()
            .is_some_and(|items| items.iter().all(is_nonempty_string_value));
        if !ok {
            return bad("speaker_reference must be a list of files".into());
        }
        for file in paths
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !exists(file) {
                return Err(format!("speaker_reference not found: {file}"));
            }
        }
    }
    Ok(VoiceConfig { raw: config })
}

fn is_nonempty_string_value(value: &Value) -> bool {
    is_nonempty_string(Some(value))
}

/// `String(value)` for the messages that show a value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => roamgate_base::log::js_number(number),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Keeps `patch` in the voice.json at `path` (made when missing), its other
/// settings untouched; a key whose value is None is removed.
pub fn update_voice_config(patch: &[(&str, Option<Value>)], path: &Path) -> Result<(), String> {
    let mut config: Map<String, Value> = if path.exists() {
        let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
        match serde_json::from_str::<Value>(&text).map_err(|error| json_parse_error(&error))? {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    } else {
        Map::new()
    };
    for (key, value) in patch {
        match value {
            None => {
                config.shift_remove(*key);
            }
            Some(value) => {
                config.insert((*key).to_owned(), value.clone());
            }
        }
    }
    if let Some(dir) = path.parent() {
        crate::profiles::create_private_dirs(dir).map_err(|error| error.to_string())?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    fs::write(
        &temporary,
        format!("{}\n", js::stringify_pretty(&Value::Object(config))),
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// Keeps `rate` as `speech_rate`.
pub fn write_speech_rate(rate: f64, path: &Path) -> Result<(), String> {
    if !crate::speech_rate::is_rate(rate) {
        return Err("speech_rate must be 0.5 to 2".into());
    }
    update_voice_config(&[("speech_rate", Some(js::number(rate)))], path)
}

/// Keeps `ms` as `max_pause_ms`.
pub fn write_max_pause(ms: f64, path: &Path) -> Result<(), String> {
    if max_pause_ms(Some(&js::number(ms))) != ms {
        return Err(format!(
            "max_pause_ms must be {} to {} ms",
            js::number_text(MIN_PAUSE_MS),
            js::number_text(LONGEST_PAUSE_MS)
        ));
    }
    update_voice_config(&[("max_pause_ms", Some(js::number(ms)))], path)
}

/// Keeps `mode` as `front_mode`.
pub fn write_front_mode(mode: FrontMode, path: &Path) -> Result<(), String> {
    update_voice_config(&[("front_mode", Some(json!(mode.as_str())))], path)
}

#[cfg(test)]
pub(crate) mod tests;
