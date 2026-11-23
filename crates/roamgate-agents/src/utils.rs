//! `session-utils.ts`: what every transcript reader shares.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj, sv};

/// An agent's name as Herdr or a user may spell it, as Roamgate names it.
pub fn normalize_agent_name(value: &str) -> String {
    let normalized = js::trim(value).to_lowercase();
    match normalized.as_str() {
        "omp" | "oh-my-pi" => "omp".into(),
        "pi-agent" | "pi-coding-agent" => "pi".into(),
        "claude-code" => "claude".into(),
        "muse-code" | "muse code" => "muse".into(),
        "kimi-code" | "kimi code" => "kimi".into(),
        "grok-build" | "grok build" => "grok".into(),
        "antigravity" | "antigravity-cli" | "antigravity cli" => "agy".into(),
        _ => normalized,
    }
}

/// The command that installs Herdr's integration of an agent.
pub fn integration_install_command(agent: &str) -> String {
    if agent == "agy" {
        return "herdr integration install antigravity-cli".into();
    }
    format!("herdr integration install {agent}")
}

/// The text of a message's content: strings, text parts, nested content;
/// never tool calls, results or thinking.
pub fn text_from_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| text_from_content(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(map)) => {
            let kind = sv(map.get("type"));
            if matches!(
                kind,
                "tool_result"
                    | "tool_use"
                    | "function_call"
                    | "function_call_output"
                    | "thinking"
                    | "think"
            ) {
                return String::new();
            }
            if let Some(Value::String(text)) = map.get("text") {
                return text.clone();
            }
            match map.get("content") {
                Some(content @ (Value::String(_) | Value::Array(_))) => {
                    text_from_content(Some(content))
                }
                _ => String::new(),
            }
        }
        _ => String::new(),
    }
}

/// A message's text without Claude Code's tags and notes.
pub fn clean_message_text(value: &str) -> String {
    static TAGS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"<command-message>[\s\S]*?</command-message>",
            r"<command-name>[\s\S]*?</command-name>",
            r"<command-args>[\s\S]*?</command-args>",
            r"<local-command-stdout>[\s\S]*?</local-command-stdout>",
            r"<task-notification>[\s\S]*?</task-notification>",
            r"<system-reminder>[\s\S]*?</system-reminder>",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).unwrap())
        .collect()
    });
    let mut text = value.to_owned();
    for pattern in TAGS.iter() {
        if pattern.is_match(&text) {
            text = pattern.replace_all(&text, "").into_owned();
        }
    }
    let text = text.replace("\r\n", "\n");
    let text = js::trim(&text);
    if text == "[Request interrupted by user]" {
        return String::new();
    }
    text.to_owned()
}

/// The last part of a path (`basename`).
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.starts_with('/') { "" } else { path };
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// The directory of a path (`dirname`).
pub fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(at) => trimmed[..at].trim_end_matches('/').to_owned(),
        None if path.starts_with('/') => "/".into(),
        None => ".".into(),
    }
}

/// A path's name without its extension (`.replace(/\.[^.]+$/, "")`).
pub fn without_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(at) if at + 1 < name.len() => &name[..at],
        _ => name,
    }
}

/// An entry's id that stays the same for the same place in the file.
pub fn stable_message_id(path: &str, index: i64) -> String {
    format!("{}:{index}", basename(path))
}

/// When a record was written, as ISO, else the file's time plus its index.
pub fn message_time(record: &Obj, fallback_ms: f64, index: usize) -> String {
    js::iso(timestamp_ms(record, fallback_ms, index))
}

fn timestamp_value_ms(value: Option<&Value>) -> f64 {
    let raw = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if !js::trim(s).is_empty() => js::number_from_text(s),
        _ => f64::NAN,
    };
    if raw.is_finite() && raw > 0.0 {
        return if raw > 1_000_000_000_000.0 {
            raw
        } else {
            raw * 1000.0
        };
    }
    match value {
        Some(Value::String(s)) if !js::trim(s).is_empty() => js::date_parse(s),
        _ => f64::NAN,
    }
}

/// `a || b` on numbers: NaN and 0 are falsy.
fn or_number(a: f64, b: impl FnOnce() -> f64) -> f64 {
    if a.is_nan() || a == 0.0 { b() } else { a }
}

/// The record's time in ms, else the fallback plus its index.
pub fn timestamp_ms(record: &Obj, fallback_ms: f64, index: usize) -> f64 {
    let parsed = or_number(timestamp_value_ms(record.get("ts")), || {
        or_number(timestamp_value_ms(record.get("timestamp")), || {
            or_number(timestamp_value_ms(record.get("time")), || {
                or_number(timestamp_value_ms(record.get("created_at")), || {
                    timestamp_value_ms(record.get("createdAt"))
                })
            })
        })
    });
    if parsed.is_finite() {
        parsed
    } else {
        fallback_ms + index as f64
    }
}

/// The objects of a JSONL text, skipping what does not parse.
pub fn parse_jsonl(text: &str) -> Vec<Obj> {
    let mut records = Vec::new();
    for line in text.split('\n') {
        let trimmed = js::trim(line);
        if trimmed.is_empty() {
            continue;
        }
        if let Some(Value::Object(record)) = js::parse(trimmed) {
            records.push(record);
        }
    }
    records
}

/// `readJsonl`: a file's JSONL records.
pub fn read_jsonl(path: &std::path::Path) -> std::io::Result<Vec<Obj>> {
    let bytes = std::fs::read(path)?;
    Ok(parse_jsonl(&String::from_utf8_lossy(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        assert_eq!(normalize_agent_name(" Claude-Code "), "claude");
        assert_eq!(normalize_agent_name("oh-my-pi"), "omp");
        assert_eq!(normalize_agent_name("antigravity cli"), "agy");
        assert_eq!(basename("/a/b/c.jsonl"), "c.jsonl");
        assert_eq!(dirname("/a/b/c.jsonl"), "/a/b");
        assert_eq!(without_extension("c.jsonl"), "c");
        assert_eq!(stable_message_id("/x/s.jsonl", 3), "s.jsonl:3");
    }
}
