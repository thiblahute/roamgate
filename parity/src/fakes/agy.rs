//! fake-agy: the Antigravity CLI.
//!
//! - `agy acp` speaks ACP's JSON-RPC on stdio: `initialize` answers, a
//!   `session/new` gets the script's `session_id` (default below), a
//!   `session/resume` or `session/load` the id it asked for, and each
//!   `session/prompt` the script's next turn of `turns` (then
//!   `default_turn`, else a bare end of turn). A turn's entries are lines
//!   written as they are, after `{{session_id}}`, `{{prompt_id}}` (the
//!   prompt's request id) and `{{user_text}}` are filled in; except
//!   `{"$await_response": true}` (waits for the answer to a request the
//!   turn made, a permission's), `{"$await_cancel": true}` (waits for
//!   `session/cancel`) and `{"$delay_ms": n}`. A turn that does not answer
//!   its prompt itself ends with `{"stopReason": "end_turn"}` (or
//!   `"cancelled"` after a cancel). `session/set_model` and
//!   `session/set_mode` answer `{}`.
//! - Run by a fake Herdr terminal pane (`PARITY_CLAUDE_TUI`), the TUI:
//!   it stays until killed or its stdin closes.
//! - Otherwise (`agy -p /usage ...`) a rule's answer, as every fake.

use std::collections::VecDeque;
use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

use super::respond;
use super::script::{Answer, Script};

const DEFAULT_SESSION: &str = "00000000-0000-4000-8000-0000000000a1";

fn fill(value: &Value, vars: &[(&str, &str)]) -> Value {
    match value {
        Value::String(text) => {
            // A whole-string `{{prompt_id}}` keeps the id's JSON type.
            for (name, with) in vars {
                if text == &format!("{{{{{name}}}}}") {
                    return Value::String((*with).to_owned());
                }
            }
            let mut out = text.clone();
            for (name, with) in vars {
                out = out.replace(&format!("{{{{{name}}}}}"), with);
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, vars)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), fill(item, vars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn write(out: &mut impl Write, value: &Value) {
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn answer(out: &mut impl Write, id: &Value, result: Value) {
    write(out, &json!({"jsonrpc": "2.0", "id": id, "result": result}));
}

fn prompt_text(message: &Value) -> String {
    message
        .pointer("/params/prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub fn run(args: &[String], script: &Script, picked: Option<Answer>) -> i32 {
    if std::env::var_os("PARITY_CLAUDE_TUI").is_some() {
        let mut sink = String::new();
        while std::io::stdin()
            .read_line(&mut sink)
            .map(|n| n > 0)
            .unwrap_or(false)
        {
            sink.clear();
        }
        return 0;
    }
    if let Some(answer) = &picked {
        return respond(answer, &std::env::current_dir().unwrap_or_default());
    }
    if args.first().map(String::as_str) != Some("acp") {
        return match &script.default {
            Some(default) => respond(default, &std::env::current_dir().unwrap_or_default()),
            None => 0,
        };
    }
    acp(script)
}

fn acp(script: &Script) -> i32 {
    let turns: Vec<Value> = script
        .extra
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_turn = script.extra.get("default_turn").cloned();
    let fresh = script
        .extra
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_SESSION)
        .to_owned();
    let model = script
        .extra
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("gemini-fake")
        .to_owned();
    let (sender, lines) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Ok(message) = serde_json::from_str::<Value>(&line)
                && sender.send(message).is_err()
            {
                break;
            }
        }
    });
    let mut out = std::io::stdout().lock();
    let mut session = fresh.clone();
    let mut waiting: VecDeque<Value> = VecDeque::new();
    let mut next = 0;
    loop {
        let message = match waiting.pop_front() {
            Some(message) => message,
            None => match lines.recv() {
                Ok(message) => message,
                Err(_) => return 0,
            },
        };
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match message.get("method").and_then(Value::as_str) {
            Some("initialize") => answer(
                &mut out,
                &id,
                json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": true}}),
            ),
            Some("session/new") => {
                session = fresh.clone();
                answer(
                    &mut out,
                    &id,
                    json!({"sessionId": session, "models": {"currentModelId": model}}),
                );
            }
            Some("session/resume" | "session/load") => {
                session = message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&fresh)
                    .to_owned();
                answer(
                    &mut out,
                    &id,
                    json!({"sessionId": session, "models": {"currentModelId": model}}),
                );
            }
            Some("session/set_model" | "session/set_mode") => answer(&mut out, &id, json!({})),
            Some("session/prompt") => {
                let turn = match turns.get(next) {
                    Some(Value::Array(turn)) => turn.clone(),
                    _ => match &default_turn {
                        Some(Value::Array(turn)) => turn.clone(),
                        _ => Vec::new(),
                    },
                };
                next += 1;
                let prompt_id = match &id {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                let text = prompt_text(&message);
                let vars = [
                    ("session_id", session.as_str()),
                    ("prompt_id", prompt_id.as_str()),
                    ("user_text", text.as_str()),
                ];
                let mut cancelled = false;
                let mut answered = false;
                for entry in &turn {
                    if let Some(delay) = entry.get("$delay_ms").and_then(Value::as_u64) {
                        std::thread::sleep(Duration::from_millis(delay));
                        continue;
                    }
                    let awaits_response = entry.get("$await_response").is_some();
                    if awaits_response || entry.get("$await_cancel").is_some() {
                        loop {
                            let Ok(incoming) = lines.recv() else { return 0 };
                            let method = incoming.get("method").and_then(Value::as_str);
                            let found = if awaits_response {
                                method.is_none() && incoming.get("id").is_some()
                            } else {
                                method == Some("session/cancel")
                            };
                            if found {
                                cancelled |= !awaits_response;
                                break;
                            }
                            waiting.push_back(incoming);
                        }
                        continue;
                    }
                    let line = fill(entry, &vars);
                    answered |= line.get("id").is_some_and(|line_id| *line_id == id)
                        && line.get("method").is_none();
                    write(&mut out, &line);
                }
                if !answered {
                    let reason = if cancelled { "cancelled" } else { "end_turn" };
                    answer(&mut out, &id, json!({"stopReason": reason}));
                }
            }
            _ => {}
        }
    }
}
