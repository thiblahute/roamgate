//! `session-messages.ts`: the readable conversation of a trajectory.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj, sv};
use crate::session::SessionFile;
use crate::utils::stable_message_id;

/// Whether a step is part of the conversation (not reasoning, a tool call,
/// an error or token accounting the agent did not present).
pub fn is_conversation_step(step: &Obj) -> bool {
    let message = sv(step.get("message"));
    let extra = js::rec(step.get("extra"));
    let source = sv(step.get("source"));
    if source == "user" {
        return !js::trim(message).is_empty()
            || extra
                .and_then(|e| e.get("images"))
                .and_then(Value::as_f64)
                .is_some_and(|n| n > 0.0);
    }
    if source != "agent" || js::trim(message).is_empty() {
        return false;
    }
    if step.get("metrics").is_some_and(|m| !m.is_null()) && message == "Token usage" {
        return false;
    }
    if step
        .get("reasoning_content")
        .is_some_and(|r| r.as_str().is_some_and(|s| !s.is_empty()))
        && message == "Reasoning"
    {
        return false;
    }
    static TOOL_CALLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Tool calls?:").unwrap());
    if step
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|c| !c.is_empty())
        && TOOL_CALLS.is_match(message)
    {
        return false;
    }
    if extra
        .and_then(|e| e.get("error_message"))
        .is_some_and(truthy)
        && message.starts_with("Error:")
    {
        return false;
    }
    true
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The conversation messages of a trajectory.
pub fn conversation_messages_from_trajectory(file: &SessionFile, trajectory: &Value) -> Vec<Value> {
    let Some(steps) = trajectory.get("steps").and_then(Value::as_array) else {
        return Vec::new();
    };
    steps
        .iter()
        .filter_map(Value::as_object)
        .filter(|step| {
            let extra = js::rec(step.get("extra"));
            is_conversation_step(step)
                && !extra.and_then(|e| e.get("injected")).is_some_and(truthy)
                && !extra
                    .and_then(|e| e.get("command_output"))
                    .is_some_and(truthy)
        })
        .map(|step| {
            let step_id = step.get("step_id").and_then(Value::as_f64).unwrap_or(0.0);
            let sent_at = match step.get("timestamp") {
                Some(Value::String(at)) => at.clone(),
                _ => js::iso(file.mtime_ms + step_id.max(0.0)),
            };
            Value::Object(obj! {
                "id" => stable_message_id(&file.path, step_id as i64),
                "role" => if sv(step.get("source")) == "user" { "user" } else { "assistant" },
                "text" => sv(step.get("message")),
                "sent_at" => sent_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file() -> SessionFile {
        SessionFile {
            path: "/tmp/session.jsonl".into(),
            mtime_ms: js::date_parse("2026-07-28T00:00:00.000Z"),
            ..Default::default()
        }
    }

    fn trajectory(steps: Value) -> Value {
        json!({ "schema_version": "ATIF-v1.7", "agent": { "name": "pi", "version": "1" }, "steps": steps })
    }

    #[test]
    fn keeps_user_and_presented_assistant_text_in_chronological_order() {
        let messages = conversation_messages_from_trajectory(
            &file(),
            &trajectory(json!([
                { "step_id": 1, "timestamp": "2026-07-28T00:00:01.000Z", "source": "user", "message": "Inspect the repository" },
                { "step_id": 2, "timestamp": "2026-07-28T00:00:02.000Z", "source": "agent", "message": "I will inspect it.",
                  "tool_calls": [{ "tool_call_id": "call-1", "function_name": "read", "arguments": { "path": "README.md" } }] },
                { "step_id": 3, "timestamp": "2026-07-28T00:00:03.000Z", "source": "agent", "message": "Done" },
            ])),
        );
        let got: Vec<(String, String)> = messages
            .iter()
            .map(|m| (sv(m.get("role")).to_owned(), sv(m.get("text")).to_owned()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("user".into(), "Inspect the repository".into()),
                ("assistant".into(), "I will inspect it.".into()),
                ("assistant".into(), "Done".into()),
            ]
        );
    }

    #[test]
    fn omits_reasoning_generated_tool_labels_errors_and_token_records() {
        let messages = conversation_messages_from_trajectory(
            &file(),
            &trajectory(json!([
                { "step_id": 1, "source": "agent", "message": "Reasoning", "reasoning_content": "Inspect files" },
                { "step_id": 2, "source": "agent", "message": "Tool call: read",
                  "tool_calls": [{ "tool_call_id": "call-1", "function_name": "read", "arguments": {} }] },
                { "step_id": 3, "source": "system", "message": "Tool result" },
                { "step_id": 4, "source": "system", "message": "Token usage", "metrics": { "prompt_tokens": 10 } },
                { "step_id": 5, "source": "agent", "message": "Error: rate limited", "extra": { "error_message": "rate limited" } },
            ])),
        );
        assert!(messages.is_empty());
    }
}
