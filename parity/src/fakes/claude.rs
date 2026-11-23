//! fake-claude: Claude Code's headless CLI.
//!
//! - A rule's answer with `stream` (a list of stream-json values) prints
//!   them one per line and exits; a `{"$delay_ms": n}` entry waits.
//! - Otherwise the script's `turns` (a list of lists of values) drives a
//!   conversation on `--input-format stream-json`: each `user` line read
//!   on stdin is answered by the next turn; `control_request` lines (the
//!   control protocol: can_use_tool, models, MCP actions, interrupt) get a
//!   success `control_response`, or the script's `control` answer for that
//!   subtype. A turn's values may name `{{session_id}}`, the session id
//!   given with `--resume` or `--session-id`, else a fixed one.
//!   Turn entries may also be `{"$await_control": "<subtype>"}` (wait for
//!   that control request, answer it, then go on: an interrupt mid-turn;
//!   `"never"` waits until stdin closes, a turn that hangs),
//!   `{"$echo_user": true}` (the user line replayed, as
//!   `--replay-user-messages` does), `{"$exit": <code>}` (the process dies
//!   mid-turn); strings may name `{{user_text}}` and `{{user_uuid}}`.
//!   `answers` (a list of `{"match": <regex>, "turn": [...]}`) answers the
//!   user lines whose text matches before any turn is taken.
//!   After the last turn, `default_turn` answers, else a bare `result`. A
//!   `control` answer with `"$error": "<message>"` is an error response.
//! - Otherwise a rule's plain answer, or one `result` line.
//!
//! The argv and the Claude, Anthropic and Herdr variables are in the call
//! log (script.rs).

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

use super::respond;
use super::script::{Answer, Script};

const DEFAULT_SESSION: &str = "00000000-0000-4000-8000-000000000001";

fn session_id(args: &[String]) -> String {
    args.windows(2)
        .find(|pair| pair[0] == "--resume" || pair[0] == "--session-id" || pair[0] == "-r")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| DEFAULT_SESSION.to_owned())
}

/// `{{repeat:<text>:<count>}}` as the text repeated (a line past the
/// agent socket's body limit, without a megabyte in the scenario).
fn repeat(text: &str) -> String {
    let Some(inner) = text
        .strip_prefix("{{repeat:")
        .and_then(|rest| rest.strip_suffix("}}"))
    else {
        return text.to_owned();
    };
    match inner
        .rsplit_once(':')
        .and_then(|(unit, count)| Some((unit, count.parse::<usize>().ok()?)))
    {
        Some((unit, count)) => unit.repeat(count),
        None => text.to_owned(),
    }
}

fn fill(value: &Value, session: &str) -> Value {
    match value {
        Value::String(text) => Value::String(repeat(&text.replace("{{session_id}}", session))),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, session)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), fill(item, session)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn emit(out: &mut impl Write, lines: &[Value], session: &str) {
    for line in lines {
        if let Some(delay) = line.get("$delay_ms").and_then(Value::as_u64) {
            let _ = out.flush();
            std::thread::sleep(Duration::from_millis(delay));
            continue;
        }
        let _ = writeln!(out, "{}", fill(line, session));
    }
    let _ = out.flush();
}

pub fn run(args: &[String], script: &Script, picked: Option<Answer>) -> i32 {
    // The TUI of a fake Herdr terminal pane (herdr_panes.rs): it stays
    // until killed or its stdin closes.
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
    let session = session_id(args);
    let mut out = std::io::stdout().lock();
    if let Some(answer) = &picked {
        if let Some(Value::Array(stream)) = answer.extra.get("stream") {
            emit(&mut out, stream, &session);
            return answer.exit.unwrap_or(0);
        }
        return respond(answer, &std::env::current_dir().unwrap_or_default());
    }
    let streaming_input = args
        .windows(2)
        .any(|pair| pair[0] == "--input-format" && pair[1] == "stream-json");
    if streaming_input
        && (script.extra.contains_key("turns")
            || script.extra.contains_key("default_turn")
            || script.extra.contains_key("answers"))
    {
        let turns = script
            .extra
            .get("turns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        return converse(&turns, script, &session, &mut out);
    }
    if let Some(default) = &script.default {
        return respond(default, &std::env::current_dir().unwrap_or_default());
    }
    emit(
        &mut out,
        &[json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "",
            "session_id": session,
        })],
        &session,
    );
    0
}

/// A user message being answered: what `{{user_text}}` and `{{user_uuid}}`
/// stand for.
struct Current {
    text: String,
    uuid: String,
    message: Value,
}

fn fill_user(value: &Value, current: &Current) -> Value {
    match value {
        Value::String(text) => Value::String(
            text.replace("{{user_text}}", &current.text)
                .replace("{{user_uuid}}", &current.uuid),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| fill_user(item, current)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), fill_user(item, current)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn control_answer(out: &mut impl Write, controls: &Value, message: &Value, session: &str) {
    let request = message.get("request").cloned().unwrap_or(json!({}));
    let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("");
    let request_id = message.get("request_id").cloned().unwrap_or(Value::Null);
    let answer = controls.get(subtype).cloned().unwrap_or(json!({}));
    let line = match answer.get("$error").and_then(Value::as_str) {
        Some(error) => json!({
            "type": "control_response",
            "response": {"subtype": "error", "request_id": request_id, "error": error}
        }),
        None => json!({
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request_id, "response": answer}
        }),
    };
    emit(out, &[line], session);
}

fn subtype_of(message: &Value) -> Option<&str> {
    message.get("request")?.get("subtype")?.as_str()
}

/// The stream-json conversation of `turns` (see the module's comment).
fn converse(turns: &[Value], script: &Script, session: &str, out: &mut impl Write) -> i32 {
    let controls = script.extra.get("control").cloned().unwrap_or(json!({}));
    let default_turn = script.extra.get("default_turn").cloned();
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
    let mut waiting: std::collections::VecDeque<Value> = std::collections::VecDeque::new();
    let mut next = 0;
    loop {
        let message = match waiting.pop_front() {
            Some(message) => message,
            None => match lines.recv() {
                Ok(message) => message,
                Err(_) => return 0,
            },
        };
        match message.get("type").and_then(Value::as_str) {
            Some("control_request") => control_answer(out, &controls, &message, session),
            Some("user") => {
                let content = message.get("message").and_then(|m| m.get("content"));
                let text = match content {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                let current = Current {
                    text,
                    uuid: message
                        .get("uuid")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    message: message.get("message").cloned().unwrap_or(Value::Null),
                };
                // `answers`: the first whose `match` (a regex) finds the
                // user text answers it, without taking a turn.
                let answered = script
                    .extra
                    .get("answers")
                    .and_then(Value::as_array)
                    .and_then(|answers| {
                        answers.iter().find_map(|answer| {
                            let pattern = answer.get("match")?.as_str()?;
                            let regex = regex::Regex::new(pattern).ok()?;
                            regex
                                .is_match(&current.text)
                                .then(|| answer.get("turn")?.as_array().cloned())
                                .flatten()
                        })
                    });
                let turn = match answered {
                    Some(turn) => turn,
                    None => {
                        let turn = match turns.get(next) {
                            Some(Value::Array(turn)) => turn.clone(),
                            _ => match &default_turn {
                                Some(Value::Array(turn)) => turn.clone(),
                                _ => vec![
                                    json!({"type": "result", "subtype": "success", "is_error": false, "result": "", "session_id": "{{session_id}}"}),
                                ],
                            },
                        };
                        next += 1;
                        turn
                    }
                };
                for entry in &turn {
                    if let Some(subtype) = entry.get("$await_control").and_then(Value::as_str) {
                        let _ = out.flush();
                        loop {
                            let Ok(incoming) = lines.recv() else { return 0 };
                            if incoming.get("type").and_then(Value::as_str)
                                == Some("control_request")
                            {
                                let matched = subtype_of(&incoming) == Some(subtype);
                                control_answer(out, &controls, &incoming, session);
                                if matched {
                                    break;
                                }
                            } else {
                                waiting.push_back(incoming);
                            }
                        }
                        continue;
                    }
                    if entry.get("$echo_user").is_some() {
                        let line = json!({"type": "user", "isReplay": true, "uuid": current.uuid, "message": current.message, "session_id": session});
                        emit(out, &[line], session);
                        continue;
                    }
                    if let Some(code) = entry.get("$exit").and_then(Value::as_i64) {
                        let _ = out.flush();
                        std::process::exit(code as i32);
                    }
                    emit(out, &[fill_user(entry, &current)], session);
                }
            }
            _ => {}
        }
    }
}
