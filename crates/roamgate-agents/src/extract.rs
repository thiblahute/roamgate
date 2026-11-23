//! One transcript record as documents (archive/extract.ts): the messages,
//! titles and links a record carries, clipped, with mega-tokens dropped.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js::{json_string, stringify, strip_long, take_chars, utf16_len};

/// Caps, in characters. Tool output is the biggest body, so it is clipped.
pub const TEXT_CAP: usize = 20_000;
const RESULT_HEAD: usize = 6_000;
const RESULT_TAIL: usize = 2_000;
const INPUT_CAP: usize = 2_000;

/// Record types that carry no searchable text.
const IGNORED: &[&str] = &[
    "mode",
    "file-history-snapshot",
    "file-history-delta",
    "atis-latch",
    "api-request",
    "api-request-shape",
    "api-request-blob",
    "last-prompt",
    "attachment",
    "cost-state",
    "session-owner",
    "tools-used",
    "permission-mode",
    "bridge-session",
    "artifact-comment-monitor",
    "artifact-autoreact-ledger",
    "continued-in",
    "isolation-latch",
    "history-suppression",
    "fork-context-ref",
    "launched",
    "failed",
];

/// One searchable document of a record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Doc {
    /// user, assistant, tool, system, meta or agent.
    pub role: String,
    pub kind: String,
    pub tool: Option<String>,
    pub text: String,
}

impl Doc {
    pub fn new(role: &str, kind: &str, tool: Option<String>, text: String) -> Self {
        Self {
            role: role.into(),
            kind: kind.into(),
            tool,
            text,
        }
    }
}

/// Record types seen but not recognised, with their counts, in the order
/// first seen.
pub type UnknownTypes = IndexMap<String, u64>;

/// Counts one more record of `kind`.
pub fn count_unknown(unknown: &mut UnknownTypes, kind: &str) {
    *unknown.entry(kind.to_owned()).or_insert(0) += 1;
}

/// `clip`: mega-tokens dropped, then the first `cap` characters.
pub fn clip(text: &str, cap: usize) -> String {
    take_chars(&strip_long(text), cap).to_owned()
}

/// Tool output: the head and the tail of a long one.
pub fn clip_result(text: &str) -> String {
    let stripped = strip_long(text);
    if utf16_len(&stripped) <= RESULT_HEAD + RESULT_TAIL {
        return stripped;
    }
    let chars: Vec<char> = stripped.chars().collect();
    if chars.len() <= RESULT_HEAD + RESULT_TAIL {
        return stripped;
    }
    let head: String = chars[..RESULT_HEAD].iter().collect();
    let tail: String = chars[chars.len() - RESULT_TAIL..].iter().collect();
    format!("{head}\n[...]\n{tail}")
}

/// JSON with sorted keys, as serde_json prints a Value (`stableStringify`).
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            // Array.prototype.sort: by UTF-16 code units.
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!("{}:{}", json_string(key), stable_stringify(&object[*key])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => stringify(other),
    }
}

pub(crate) fn string_field<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

const INPUT_KEYS: &[&str] = &[
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
    "subject",
    "skill",
    "args",
    "old_string",
    "new_string",
];

/// Searchable summary of a tool call input.
fn tool_input_text(input: Option<&Value>) -> String {
    let Some(Value::Object(object)) = input else {
        return clip(&input.map(stable_stringify).unwrap_or_default(), INPUT_CAP);
    };
    let mut parts: Vec<String> = INPUT_KEYS
        .iter()
        .filter_map(|key| string_field(object, key))
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    if parts.is_empty() {
        parts.push(stable_stringify(input.unwrap()));
    }
    clip(&parts.join(" "), INPUT_CAP)
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_object)
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| string_field(part, "text"))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn display(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(stable_stringify(other)),
    }
}

/// Documents for one Claude record; unrecognised record types are counted.
pub fn extract(record: &Value, thinking: bool, unknown: &mut UnknownTypes) -> Vec<Doc> {
    let mut out = Vec::new();
    let Some(record) = record.as_object() else {
        return out;
    };
    let kind = string_field(record, "type").unwrap_or("");
    match kind {
        "ai-title" | "custom-title" | "agent-name" => {
            let value = ["aiTitle", "customTitle", "agentName"]
                .iter()
                .filter_map(|key| string_field(record, key))
                .find(|entry| !entry.is_empty());
            if let Some(value) = value {
                out.push(Doc::new("meta", "title", None, value.to_owned()));
            }
        }
        "pr-link" => {
            let text = [
                display(record.get("prRepository")),
                display(record.get("prNumber")),
                display(record.get("prUrl")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            if !text.is_empty() {
                out.push(Doc::new("meta", "pr", None, text));
            }
        }
        "frame-link" => {
            let text = [
                string_field(record, "title"),
                string_field(record, "frameUrl"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            if !text.is_empty() {
                out.push(Doc::new("meta", "artifact", None, text));
            }
        }
        "result" => {
            if let Some(result) = record.get("result") {
                out.push(Doc::new(
                    "agent",
                    "workflow_result",
                    None,
                    clip_result(&stable_stringify(result)),
                ));
            }
        }
        "started" => {
            let text = [string_field(record, "label"), string_field(record, "phase")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            if !text.is_empty() {
                out.push(Doc::new("agent", "workflow", None, text));
            }
        }
        "queue-operation" => {
            if let Some(content) = string_field(record, "content").filter(|c| !c.is_empty()) {
                out.push(Doc::new("user", "queued", None, clip(content, TEXT_CAP)));
            }
        }
        "system" => {
            if let Some(content) = string_field(record, "content")
                && !crate::js::js_trim(content).is_empty()
            {
                out.push(Doc::new("system", "text", None, clip(content, TEXT_CAP)));
            }
        }
        "user" | "assistant" => {
            let role = kind;
            let content = record
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("content"));
            match content {
                Some(Value::String(content)) => {
                    if !crate::js::js_trim(content).is_empty() {
                        out.push(Doc::new(role, "text", None, clip(content, TEXT_CAP)));
                    }
                }
                Some(Value::Array(blocks)) => {
                    for block in blocks.iter().filter_map(Value::as_object) {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = string_field(block, "text")
                                    && !crate::js::js_trim(text).is_empty()
                                {
                                    out.push(Doc::new(role, "text", None, clip(text, TEXT_CAP)));
                                }
                            }
                            Some("tool_use") => out.push(Doc::new(
                                role,
                                "tool_use",
                                string_field(block, "name").map(str::to_owned),
                                tool_input_text(block.get("input")),
                            )),
                            Some("tool_result") => {
                                let text = result_text(block.get("content"));
                                let trimmed = crate::js::js_trim(&text);
                                if !trimmed.is_empty() {
                                    out.push(Doc::new(
                                        "tool",
                                        "tool_result",
                                        None,
                                        clip_result(trimmed),
                                    ));
                                }
                            }
                            Some("thinking") => {
                                if let Some(text) = string_field(block, "thinking")
                                    && thinking
                                    && !text.is_empty()
                                {
                                    out.push(Doc::new(
                                        role,
                                        "thinking",
                                        None,
                                        clip(text, TEXT_CAP),
                                    ));
                                }
                            }
                            // Images and other block types are not indexed.
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        other => {
            if !IGNORED.contains(&other) {
                count_unknown(unknown, other);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_records_become_documents() {
        let mut unknown = UnknownTypes::new();
        let docs = extract(
            &json!({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "hello"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls", "x": 1}},
                {"type": "thinking", "thinking": "hmm"}
            ]}}),
            false,
            &mut unknown,
        );
        assert_eq!(
            docs,
            vec![
                Doc::new("assistant", "text", None, "hello".into()),
                Doc::new("assistant", "tool_use", Some("Bash".into()), "ls".into()),
            ]
        );
        assert!(extract(&json!({"type": "mode"}), false, &mut unknown).is_empty());
        extract(&json!({"type": "brand-new"}), false, &mut unknown);
        assert_eq!(unknown.get("brand-new"), Some(&1));
        let docs = extract(
            &json!({"type": "pr-link", "prNumber": 12, "prUrl": "u"}),
            false,
            &mut unknown,
        );
        assert_eq!(docs[0].text, "12 u");
    }

    #[test]
    fn stable_stringify_sorts_keys_and_prints_doubles() {
        assert_eq!(
            stable_stringify(&json!({"b": [1.0, "x"], "a": {"d": null, "c": true}})),
            "{\"a\":{\"c\":true,\"d\":null},\"b\":[1,\"x\"]}"
        );
    }

    #[test]
    fn long_results_keep_head_and_tail() {
        let text = "w ".repeat(5000);
        let clipped = clip_result(&text);
        assert!(clipped.contains("\n[...]\n"));
        assert_eq!(clipped.chars().count(), 6000 + 2000 + 7);
    }
}
