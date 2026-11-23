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
