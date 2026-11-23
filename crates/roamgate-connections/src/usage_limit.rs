//! The usage-limit module (shared/limitResume.ts): the `limit_resume`
//! settings, how a stop is read from Claude Code's records, and what the
//! browsers are told of each paused session. Held to
//! contract/vectors/limit-resume.json, as the TS side is.

use roamgate_base::log::{parse_iso_millis, slice_utf16, utf16_len};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The `limit_resume` settings (settings.json), defaults included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitResumeSettings {
    /// Sessions a usage limit stopped are sent `message` once it resets.
    pub enabled: bool,
    /// What a resumed session is sent, as if the user typed it.
    pub message: String,
    /// Seconds after the reset before it is sent.
    pub margin_seconds: i64,
}

pub const DEFAULT_LIMIT_RESUME_MESSAGE: &str = "The usage limit has reset. Continue where you stopped, and restart any background agents or workflows that failed because of the limit (resume workflows from their run id).";
pub const DEFAULT_LIMIT_RESUME_MARGIN_SECONDS: i64 = 60;
pub const MAX_LIMIT_RESUME_MARGIN_SECONDS: i64 = 3600;
pub const MAX_LIMIT_RESUME_MESSAGE_LENGTH: usize = 4000;

impl Default for LimitResumeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            message: DEFAULT_LIMIT_RESUME_MESSAGE.into(),
            margin_seconds: DEFAULT_LIMIT_RESUME_MARGIN_SECONDS,
        }
    }
}

const SETTING_KEYS: [&str; 3] = ["enabled", "message", "margin_seconds"];

/// Why `raw` is not a valid (partial) `limit_resume` update, or None.
/// Every key is optional; unknown keys are refused.
pub fn limit_resume_settings_error(raw: &Map<String, Value>) -> Option<String> {
    let unknown: Vec<&str> = raw
        .keys()
        .filter(|key| !SETTING_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Some(format!(
            "limit_resume takes enabled, message and margin_seconds, not {}",
            unknown.join(", ")
        ));
    }
    if let Some(enabled) = raw.get("enabled")
        && !enabled.is_boolean()
    {
        return Some("limit_resume.enabled must be true or false".into());
    }
    if let Some(message) = raw.get("message") {
        match message.as_str() {
            Some(text) if !text.trim().is_empty() => {
                if utf16_len(text) > MAX_LIMIT_RESUME_MESSAGE_LENGTH {
                    return Some(format!(
                        "limit_resume.message must be at most {MAX_LIMIT_RESUME_MESSAGE_LENGTH} characters"
                    ));
                }
            }
            _ => return Some("limit_resume.message must be some text".into()),
        }
    }
    if let Some(margin) = raw.get("margin_seconds") {
        let valid = margin.as_f64().is_some_and(|seconds| {
            seconds.fract() == 0.0
                && (0.0..=MAX_LIMIT_RESUME_MARGIN_SECONDS as f64).contains(&seconds)
        });
        if !valid {
            return Some(format!(
                "limit_resume.margin_seconds must be a whole number of seconds from 0 to {MAX_LIMIT_RESUME_MARGIN_SECONDS}"
            ));
        }
    }
    None
}

/// The stored settings' valid keys (what settings.json keeps); None for
/// what is not an object.
pub fn normalize_limit_resume_settings(raw: &Value) -> Option<Map<String, Value>> {
    let raw = raw.as_object()?;
    let mut kept = Map::new();
    for key in SETTING_KEYS {
        let Some(value) = raw.get(key) else {
            continue;
        };
        let mut one = Map::new();
        one.insert(key.into(), value.clone());
        if limit_resume_settings_error(&one).is_some() {
            continue;
        }
        let value = match (key, value.as_str()) {
            ("message", Some(text)) => Value::String(text.trim().into()),
            _ => value.clone(),
        };
        kept.insert(key.into(), value);
    }
    Some(kept)
}

/// The settings in effect: the stored ones over the defaults.
pub fn limit_resume_settings_of(stored: Option<&Map<String, Value>>) -> LimitResumeSettings {
    let mut settings = LimitResumeSettings::default();
    let Some(stored) = stored else {
        return settings;
    };
    if let Some(enabled) = stored.get("enabled").and_then(Value::as_bool) {
        settings.enabled = enabled;
    }
    if let Some(message) = stored.get("message").and_then(Value::as_str) {
        settings.message = message.into();
    }
    if let Some(margin) = stored.get("margin_seconds").and_then(Value::as_f64) {
        settings.margin_seconds = margin as i64;
    }
    settings
}

/// A usage limit a session stopped on, from Claude Code's own fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageLimitStop {
    /// When the limit resets (epoch ms).
    pub resets_at: i64,
    /// Claude Code's rateLimitType ("five_hour", "seven_day", ...).
    pub kind: String,
    /// When the session stopped (the record's time, epoch ms), if said.
    pub stopped_at: Option<i64>,
    /// The stop record's uuid, if it has one.
    pub uuid: Option<String>,
    /// What Claude Code showed.
    pub message: String,
}

/// Epoch ms from Claude Code's resetsAt (unix seconds).
fn reset_ms(value: Option<&Value>) -> Option<i64> {
    let value = value?.as_f64()?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(if value < 1e12 {
        (value * 1000.0) as i64
    } else {
        value as i64
    })
}

fn message_text(message: Option<&Value>) -> String {
    let content = message
        .and_then(Value::as_object)
        .and_then(|m| m.get("content"));
    match content {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| {
                part.as_object()
                    .and_then(|part| part.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_owned(),
        _ => String::new(),
    }
}

/// The usage limit an assistant record stopped on, or None: read from the
/// structured fields Claude Code writes, in its transcript (camelCase) or
/// in stream-json (snake_case), never from the message's words.
pub fn usage_limit_stop_of(record: &Value) -> Option<UsageLimitStop> {
    let record = record.as_object()?;
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    if record.get("isApiErrorMessage") != Some(&Value::Bool(true))
        && record.get("is_api_error_message") != Some(&Value::Bool(true))
    {
        return None;
    }
    let api_error = record
        .get("apiError")
        .filter(|value| !value.is_null())
        .or_else(|| record.get("api_error"));
    if api_error.and_then(Value::as_str) != Some("usage_limit_reached")
        && record.get("error").and_then(Value::as_str) != Some("rate_limit")
    {
        return None;
    }
    // `??`: a present null falls through to the other spelling too.
    let params = record
        .get("apiErrorParams")
        .filter(|value| !value.is_null())
        .or_else(|| record.get("api_error_params"));
    let candidates = [
        params
            .and_then(Value::as_object)
            .and_then(|p| p.get("rate_limit_info")),
        record.get("quotaLimits"),
    ];
    for info in candidates.into_iter().flatten() {
        let Some(info) = info.as_object() else {
            continue;
        };
        if info.get("status").and_then(Value::as_str) != Some("rejected") {
            continue;
        }
        let Some(resets_at) = reset_ms(info.get("resetsAt")) else {
            continue;
        };
        let stopped_at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_millis);
        let kind = info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .unwrap_or("usage")
            .to_owned();
        let message = message_text(record.get("message"));
        return Some(UsageLimitStop {
            resets_at,
            kind,
            stopped_at,
            uuid: record
                .get("uuid")
                .and_then(Value::as_str)
                .map(str::to_owned),
            message: slice_utf16(&message, 400).to_owned(),
        });
    }
    None
}

/// Whether a transcript record is a turn of the conversation rather than
/// Claude Code's bookkeeping, a subagent's record, or a local command.
fn is_conversation_turn(record: &Map<String, Value>) -> bool {
    let kind = record.get("type").and_then(Value::as_str);
    if kind != Some("user") && kind != Some("assistant") {
        return false;
    }
    if record.get("isMeta") == Some(&Value::Bool(true))
        || record.get("isSidechain") == Some(&Value::Bool(true))
    {
        return false;
    }
    if kind == Some("user") {
        let content = record
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"));
        let text = match content {
            Some(Value::String(text)) => text.as_str(),
            Some(Value::Array(parts)) if parts.len() == 1 => parts[0]
                .as_object()
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            _ => "",
        };
        let text = text.trim_start();
        if text.starts_with("<local-command-") || text.starts_with("<command-name>") {
            return false;
        }
    }
    true
}

/// The usage limit a session is paused by, from the end of its transcript
/// (Claude Code's JSONL): its last turn is a usage-limit stop.
pub fn usage_limit_stop(transcript_tail: &str) -> Option<UsageLimitStop> {
    for line in transcript_tail.split('\n').rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(object) = record.as_object() else {
            continue;
        };
        if !is_conversation_turn(object) {
            continue;
        }
        return usage_limit_stop_of(&record);
    }
    None
}

/// A limit's kind as said to the user ("5-hour", "weekly").
pub fn limit_kind_label(kind: &str) -> String {
    match kind {
        "five_hour" => "5-hour".into(),
        "seven_day" => "weekly".into(),
        "seven_day_opus" => "weekly Opus".into(),
        "seven_day_sonnet" => "weekly Sonnet".into(),
        "usage" | "" => "usage".into(),
        other => other.replace('_', " "),
    }
}

/// What becomes of a paused session (see shared/limitResume.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitPauseState {
    Scheduled,
    Off,
    Skipped,
    Missed,
    Resuming,
    Resumed,
    Failed,
}

/// A pane's owner: a terminal Claude, or conversation mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneOwner {
    Terminal,
    Conversation,
}

impl PaneOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Conversation => "conversation",
        }
    }
}

/// A session paused by a usage limit, as the browsers are told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitPause {
    pub connection_id: String,
    pub pane_id: String,
    pub session_id: String,
    pub owner: PaneOwner,
    pub kind: String,
    pub resets_at: i64,
    pub resume_at: Option<i64>,
    pub stopped_at: Option<i64>,
    pub state: LimitPauseState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub message: String,
}

/// The server's push of a connection's paused sessions.
pub const LIMIT_PAUSES_EVENT: &str = "roamgate.limit_pauses";

/// The well-formed pauses of `{pauses}` or a list.
pub fn parse_limit_pauses(value: &Value) -> Vec<Value> {
    let list = match value {
        Value::Object(object) => object.get("pauses"),
        other => Some(other),
    };
    let Some(Value::Array(list)) = list else {
        return Vec::new();
    };
    list.iter()
        .filter(|pause| {
            pause.as_object().is_some_and(|pause| {
                ["connection_id", "pane_id", "session_id", "state"]
                    .iter()
                    .all(|key| pause.get(*key).is_some_and(Value::is_string))
                    && pause.get("resets_at").is_some_and(Value::is_number)
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    fn arg(call: &vectors::Call, index: usize) -> Value {
        call.args.get(index).cloned().unwrap_or(Value::Null)
    }

    fn run(call: &vectors::Call) -> Value {
        match call.target().as_str() {
            "limitResume.usageLimitStop" => {
                let text = vectors::text(&arg(call, 0)).expect("a transcript");
                serde_json::to_value(usage_limit_stop(&text)).unwrap()
            }
            "limitResume.usageLimitStopOf" => {
                serde_json::to_value(usage_limit_stop_of(&arg(call, 0))).unwrap()
            }
            "limitResume.DEFAULT_LIMIT_RESUME" => {
                serde_json::to_value(LimitResumeSettings::default()).unwrap()
            }
            "limitResume.limitResumeSettingsOf" => {
                let stored = arg(call, 0);
                serde_json::to_value(limit_resume_settings_of(stored.as_object())).unwrap()
            }
            "limitResume.limitResumeSettingsError" => serde_json::to_value(
                limit_resume_settings_error(arg(call, 0).as_object().unwrap()),
            )
            .unwrap(),
            "limitResume.normalizeLimitResumeSettings" => {
                match normalize_limit_resume_settings(&arg(call, 0)) {
                    Some(kept) => Value::Object(kept),
                    None => serde_json::json!({"$undefined": true}),
                }
            }
            "limitResume.limitKindLabel" => {
                Value::String(limit_kind_label(arg(call, 0).as_str().unwrap()))
            }
            "limitResume.parseLimitPauses" => Value::Array(parse_limit_pauses(&arg(call, 0))),
            other => panic!("unknown function {other}"),
        }
    }

    /// Every case of contract/vectors/limit-resume.json.
    #[test]
    fn limit_resume_vectors() {
        let file = vectors::load("limit-resume");
        assert!(!file.cases.is_empty());
        for case in &file.cases {
            for call in &case.calls {
                let expected = call.result.clone().unwrap_or(Value::Null);
                assert_eq!(run(call), expected, "{}", case.title());
            }
        }
    }

    #[test]
    fn a_pause_says_its_fields_in_the_browsers_order() {
        let pause = LimitPause {
            connection_id: "local".into(),
            pane_id: "w1:p1".into(),
            session_id: "s".into(),
            owner: PaneOwner::Terminal,
            kind: "five_hour".into(),
            resets_at: 1,
            resume_at: None,
            stopped_at: Some(2),
            state: LimitPauseState::Resumed,
            resumed_at: Some(3),
            reason: None,
            message: "m".into(),
        };
        assert_eq!(
            serde_json::to_string(&pause).unwrap(),
            r#"{"connection_id":"local","pane_id":"w1:p1","session_id":"s","owner":"terminal","kind":"five_hour","resets_at":1,"resume_at":null,"stopped_at":2,"state":"resumed","resumed_at":3,"message":"m"}"#
        );
    }
}
