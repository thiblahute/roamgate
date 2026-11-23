//! `session-history.ts`: a trajectory as the chat's History entries, their
//! redacted wire form, and updates between two revisions.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::artifacts::published_artifact;
use crate::js::{self, Obj, put, sv};
use crate::messages::is_conversation_step;
use crate::session::SessionFile;
use crate::shared::agent_message::outgoing_agent_message;
use crate::shared::file_edits::{file_edit_from_arguments, is_file_edit_tool};
use crate::shared::history_window::history_window_entries;
use crate::shared::is_dismissed_result;
use crate::shared::tool_summary::{
    TOOL_SUMMARY_LIMIT, ToolSummaryNotes, roamgate_write, tool_call_summary,
};

const SHELL_SHOWN: usize = 8000;
pub const HISTORY_WINDOW_LIMIT: usize = 200;

/// The last window of a trajectory's entries.
pub fn history_entries_from_trajectory(file: &SessionFile, trajectory: &Value) -> Vec<Value> {
    history_window_entries(
        &all_history_entries(file, trajectory, false),
        HISTORY_WINDOW_LIMIT as f64,
    )
}

fn sha_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
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

struct EditResult {
    failed: bool,
    edit: Option<Value>,
}

/// Every entry of a trajectory. `by_record`: a message's identity is its
/// record's (uuid and block) when it has one.
pub fn all_history_entries(file: &SessionFile, trajectory: &Value, by_record: bool) -> Vec<Value> {
    let empty = Vec::new();
    let steps: Vec<&Obj> = trajectory
        .get("steps")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(Value::as_object)
        .collect();
    let results_of = |step: &Obj| -> Vec<Obj> {
        step.get("observation")
            .and_then(|o| o.get("results"))
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_object).cloned().collect())
            .unwrap_or_default()
    };
    let calls_of = |step: &Obj| -> Vec<Obj> {
        step.get("tool_calls")
            .and_then(Value::as_array)
            .map(|c| c.iter().filter_map(Value::as_object).cloned().collect())
            .unwrap_or_default()
    };
    let mut edit_results: HashMap<String, EditResult> = HashMap::new();
    let mut result_texts: HashMap<String, String> = HashMap::new();
    for step in &steps {
        for result in results_of(step) {
            let Some(id) = js::truthy(sv(result.get("source_call_id"))) else {
                continue;
            };
            let extra = js::rec(result.get("extra"));
            edit_results.insert(
                id.to_owned(),
                EditResult {
                    failed: js::is_true(extra.and_then(|e| e.get("is_error"))),
                    edit: extra
                        .and_then(|e| e.get("file_edit"))
                        .filter(|e| truthy(e))
                        .cloned(),
                },
            );
            if let Some(Value::String(content)) = result.get("content") {
                result_texts.insert(id.to_owned(), content.clone());
            }
        }
    }
    let mut notes = ToolSummaryNotes::default();
    for step in &steps {
        if sv(step.get("source")) == "user"
            && let Some(Value::String(message)) = step.get("message")
        {
            notes.note_message(message);
        }
        for call in calls_of(step) {
            let id = sv(call.get("tool_call_id"));
            notes.note_call(
                sv(call.get("function_name")),
                call.get("arguments"),
                result_texts.get(id).map(String::as_str),
            );
        }
    }
    let mut names: HashMap<String, String> = HashMap::new();
    let mut artifact_calls: HashMap<String, Obj> = HashMap::new();
    let mut create_calls: HashSet<String> = HashSet::new();
    let mut message_calls: HashMap<String, (String, String)> = HashMap::new();
    for step in &steps {
        for call in calls_of(step) {
            let id = sv(call.get("tool_call_id")).to_owned();
            let name = sv(call.get("function_name")).to_owned();
            names.insert(id.clone(), name.clone());
            let args_text = js::stringify(
                call.get("arguments")
                    .filter(|a| !a.is_null())
                    .unwrap_or(&Value::Object(Obj::new())),
            );
            if let Some(message) = outgoing_agent_message(Some(&name), &args_text) {
                message_calls.insert(id.clone(), message);
            }
            if name == "Artifact"
                && let Some(Value::Object(args)) = call.get("arguments")
            {
                artifact_calls.insert(id.clone(), args.clone());
            }
            if creates_request(call.get("arguments").and_then(|a| a.get("command"))) {
                create_calls.insert(id);
            }
        }
    }
    let mut entries: Vec<Value> = Vec::new();
    let mut occurrences: HashMap<String, usize> = HashMap::new();
    let mut add = |entry: Obj| {
        let identity = if let Some(call) = js::truthy(sv(entry.get("source_call_id"))) {
            vec![
                entry.get("kind").cloned().unwrap_or(Value::Null),
                Value::String(call.into()),
            ]
        } else if by_record && js::truthy(sv(entry.get("uuid"))).is_some() {
            vec![
                entry.get("kind").cloned().unwrap_or(Value::Null),
                entry.get("role").cloned().unwrap_or(Value::Null),
                entry.get("uuid").cloned().unwrap_or(Value::Null),
                entry.get("block_index").cloned().unwrap_or(js::int(0)),
            ]
        } else {
            vec![
                entry.get("kind").cloned().unwrap_or(Value::Null),
                entry.get("role").cloned().unwrap_or(Value::Null),
                entry.get("text").cloned().unwrap_or(Value::Null),
            ]
        };
        let hash = sha_hex(&js::stringify(&Value::Array(identity)))[..24].to_owned();
        let occurrence = occurrences.get(&hash).copied().unwrap_or(0);
        occurrences.insert(hash.clone(), occurrence + 1);
        let mut with_id = entry;
        with_id.insert("id".into(), Value::String(format!("{hash}:{occurrence}")));
        entries.push(Value::Object(with_id));
    };
    for step in &steps {
        let sent_at = match step.get("timestamp") {
            Some(Value::String(at)) => at.clone(),
            _ => js::iso(file.mtime_ms),
        };
        let extra = js::rec(step.get("extra"));
        let ex = |key: &str| extra.and_then(|e| e.get(key));
        if step.get("observation").is_none_or(Value::is_null) && is_conversation_step(step) {
            let source = sv(step.get("source"));
            let mut entry = obj! {
                "kind" => "message",
                "role" => if source == "user" { "user" } else { "assistant" },
                "text" => sv(step.get("message")),
                "sent_at" => sent_at.clone(),
                "queued" => js::is_true(ex("queued")).then_some(true),
                "compact_summary" => js::is_true(ex("compact_summary")).then_some(true),
                "turn_end" => js::is_true(ex("turn_end")).then_some(true),
                "message_id" => ex("message_id").filter(|v| v.is_string()).cloned(),
                "block_index" => ex("block_index").filter(|v| v.is_number()).cloned(),
                "uuid" => ex("uuid").filter(|v| v.is_string()).cloned(),
                "images" => (source == "user").then(|| ex("images").filter(|v| v.as_f64().is_some_and(|n| n > 0.0)).cloned()).flatten(),
            };
            put(&mut entry, "injected", injected_field(ex("injected")));
            put(&mut entry, "rewound", rewound_field(ex("rewound")));
            put(&mut entry, "command", command_field(ex("command")));
            put(
                &mut entry,
                "command_output",
                js::is_true(ex("command_output")).then_some(true),
            );
            put(&mut entry, "shell", shell_field(ex("shell")));
            put(
                &mut entry,
                "created_request",
                shell_created_request(ex("shell")),
            );
            add(entry);
        }
        for call in calls_of(step) {
            let id = sv(call.get("tool_call_id")).to_owned();
            let name = sv(call.get("function_name")).to_owned();
            let arguments = call.get("arguments").cloned().unwrap_or(Value::Null);
            let result_text = result_texts.get(&id).map(String::as_str);
            let empty_args = Value::Object(Obj::new());
            let args_text = js::stringify(if arguments.is_null() {
                &empty_args
            } else {
                &arguments
            });
            let summary = tool_call_summary(
                &name,
                &args_text,
                &notes.context(result_text),
                TOOL_SUMMARY_LIMIT,
            );
            let mut entry = obj! {
                "kind" => "tool_call",
                "role" => "tool",
                "tool_name" => name.clone(),
                "source_call_id" => id.clone(),
                "text" => js::stringify_pretty(&arguments),
                "summary" => (!summary.is_empty() && summary != "{}").then_some(summary),
                "sent_at" => sent_at.clone(),
            };
            if let Some((to, text)) = message_calls.get(&id) {
                entry.insert(
                    "agent_message".into(),
                    Value::Object(obj! { "to" => to.clone(), "text" => text.clone() }),
                );
            }
            if is_file_edit_tool(&name) {
                let result = edit_results.get(&id);
                if !result.is_some_and(|r| r.failed) {
                    let edit = result
                        .and_then(|r| r.edit.clone())
                        .or_else(|| file_edit_from_arguments(Some(&name), Some(&arguments)));
                    put(&mut entry, "file_edit", edit);
                }
            }
            let failed = edit_results.get(&id).is_some_and(|r| r.failed);
            let write_args = if arguments.is_null() {
                Value::Object(Obj::new())
            } else {
                arguments.clone()
            };
            put(
                &mut entry,
                "roamgate_write",
                roamgate_write(&name, &write_args, Some(result_text.unwrap_or("")), failed),
            );
            add(entry);
        }
        for result in results_of(step) {
            let call_id = sv(result.get("source_call_id")).to_owned();
            let extra = js::rec(result.get("extra"));
            let is_error = js::is_true(extra.and_then(|e| e.get("is_error")));
            let content = result.get("content").and_then(Value::as_str);
            let text = content
                .map(str::to_owned)
                .unwrap_or_else(|| sv(step.get("message")).to_owned());
            let tool_name = match extra.and_then(|e| e.get("tool_name")) {
                Some(Value::String(name)) => Some(name.clone()),
                _ => names.get(&call_id).cloned(),
            };
            let mut entry = obj! {
                "kind" => "tool_result",
                "role" => "tool",
                "tool_name" => tool_name,
                "source_call_id" => result.get("source_call_id").cloned(),
                "text" => text.clone(),
                "is_error" => is_error,
                "sent_at" => sent_at.clone(),
            };
            if let Some(args) = artifact_calls.get(&call_id)
                && let Some(artifact) =
                    published_artifact(args, if is_error { "" } else { content.unwrap_or("") })
            {
                entry.insert("artifact".into(), Value::Object(artifact));
            }
            if create_calls.contains(&call_id) && !is_error {
                put(
                    &mut entry,
                    "created_request",
                    created_request(content.unwrap_or("")),
                );
            }
            if is_error && is_dismissed_result(Some(&text)) {
                entry.insert("dismissed".into(), Value::Bool(true));
            }
            if message_calls.contains_key(&call_id) {
                entry.insert(
                    "agent_message_result".into(),
                    agent_message_result(content.unwrap_or(""), is_error),
                );
            }
            add(entry);
        }
        if let Some(Value::String(error)) = ex("error_message") {
            add(obj! {
                "kind" => "error",
                "role" => "assistant",
                "text" => error.clone(),
                "is_error" => true,
                "sent_at" => sent_at.clone(),
            });
        }
    }
    entries
}

fn shell_field(value: Option<&Value>) -> Option<Obj> {
    let shell = js::rec(value)?;
    let command = js::str_of(shell.get("command"))?;
    let stdout = js::str_of(shell.get("stdout"));
    let stderr = js::str_of(shell.get("stderr"));
    let long = [stdout, stderr]
        .iter()
        .flatten()
        .any(|each| js::len16(each) > SHELL_SHOWN);
    let cwd = js::str_of(shell.get("cwd")).filter(|c| !c.is_empty());
    Some(obj! {
        "command" => command,
        "stdout" => stdout.map(|s| js::head16(s, SHELL_SHOWN)),
        "stderr" => stderr.map(|s| js::head16(s, SHELL_SHOWN)),
        "truncated" => long.then_some(true),
        "cwd" => cwd,
    })
}

fn rewound_field(value: Option<&Value>) -> Option<Vec<Value>> {
    let items = value?.as_array()?;
    let messages: Vec<Value> = items
        .iter()
        .filter_map(|each| {
            let text = each.get("text")?.as_str()?;
            let sent_at = each.get("sent_at")?.as_str()?;
            Some(Value::Object(obj! { "text" => text, "sent_at" => sent_at }))
        })
        .collect();
    (!messages.is_empty()).then_some(messages)
}

/// A shell command that opens a merge or pull request.
pub fn creates_request(command: Option<&Value>) -> bool {
    static CREATES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?-u:\b)(?:glab\s+mr\s+create|gh\s+pr\s+create)(?-u:\b)").unwrap()
    });
    command
        .and_then(Value::as_str)
        .is_some_and(|c| CREATES.is_match(c))
}

/// The request URL `glab mr create` or `gh pr create` printed.
pub fn created_request(output: &str) -> Option<String> {
    static URL: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
        fancy_regex::Regex::new(
            r#"https://[^\s"'<>()]+?/(?:-/merge_requests|pull)/[0-9]{1,9}(?![A-Za-z0-9_])"#,
        )
        .unwrap()
    });
    if output.is_empty() {
        return None;
    }
    let head = js::head16(output, 200_000);
    URL.find(&head)
        .ok()
        .flatten()
        .map(|m| m.as_str().to_owned())
}

fn shell_created_request(value: Option<&Value>) -> Option<String> {
    let shell = js::rec(value)?;
    if !creates_request(shell.get("command")) {
        return None;
    }
    created_request(js::str_of(shell.get("stdout"))?)
}

/// What `roamgate-review message` printed: sent, and to whom.
pub fn agent_message_result(output: &str, is_error: bool) -> Value {
    match js::parse(output) {
        Some(parsed) => {
            let sent = !is_error && parsed.get("sent") == Some(&Value::Bool(true));
            let name = parsed
                .get("to")
                .and_then(|to| to.get("name"))
                .and_then(Value::as_str);
            Value::Object(
                obj! { "sent" => sent, "name" => name.map_or(Value::Null, |n| Value::String(n.into())) },
            )
        }
        None => Value::Object(obj! { "sent" => false, "name" => Value::Null }),
    }
}

fn injected_field(value: Option<&Value>) -> Option<Obj> {
    let map = js::rec(value)?;
    let kind = js::str_of(map.get("kind"))?;
    let label = js::str_of(map.get("label"))?;
    Some(obj! { "kind" => kind, "label" => label })
}

fn command_field(value: Option<&Value>) -> Option<Obj> {
    let map = js::rec(value)?;
    let name = js::str_of(map.get("name")).filter(|n| !n.is_empty())?;
    Some(obj! { "name" => name, "args" => js::str_of(map.get("args")).unwrap_or("") })
}

/// A short content hash of a tool payload.
pub fn history_text_hash(text: &str) -> String {
    sha_hex(text)[..16].to_owned()
}

/// A tool entry with its payload withheld (its size and hash kept).
pub fn redact_history_entry(entry: &Value) -> Value {
    let text = sv(entry.get("text"));
    if sv(entry.get("role")) != "tool" || text.is_empty() {
        return entry.clone();
    }
    let mut out = entry.as_object().cloned().unwrap_or_default();
    out.insert("text".into(), Value::String(String::new()));
    out.insert("text_bytes".into(), js::int(text.len() as i64));
    out.insert("text_hash".into(), Value::String(history_text_hash(text)));
    Value::Object(out)
}

/// An update with every tool payload withheld.
pub fn redact_history_update(update: &Value) -> Value {
    let mut out = update.as_object().cloned().unwrap_or_default();
    let key = if sv(update.get("mode")) == "snapshot" {
        "entries"
    } else {
        "upserts"
    };
    let redacted: Vec<Value> = update
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().map(redact_history_entry).collect())
        .unwrap_or_default();
    out.insert(key.into(), Value::Array(redacted));
    Value::Object(out)
}

/// The update from the revision the client has to the current one: a
/// snapshot, or a delta from a revision still known.
pub fn history_update(
    cursor: &Value,
    entries: &[Value],
    requested: Option<&Value>,
    versions: &HashMap<i64, Vec<Value>>,
) -> Value {
    let base = requested.and_then(Value::as_object);
    let epoch = cursor.get("epoch");
    let revision = cursor
        .get("revision")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let base_revision = base.and_then(|b| b.get("revision")).and_then(Value::as_f64);
    let previous = match (base, base_revision) {
        (Some(b), Some(r)) if b.get("epoch") == epoch && js::is_safe_integer(r) => {
            versions.get(&(r as i64))
        }
        _ => None,
    };
    let limit = js::int(HISTORY_WINDOW_LIMIT as i64);
    let Some(previous) = previous.filter(|_| base_revision.unwrap_or(f64::INFINITY) <= revision)
    else {
        return Value::Object(obj! {
            "history_version" => 2i64,
            "mode" => "snapshot",
            "cursor" => cursor.clone(),
            "window_limit" => limit,
            "entries" => entries.to_vec(),
        });
    };
    if base_revision == Some(revision) {
        return Value::Object(obj! {
            "history_version" => 2i64,
            "mode" => "delta",
            "cursor" => cursor.clone(),
            "base_revision" => js::number(revision),
            "window_limit" => limit,
            "upserts" => Vec::<Value>::new(),
            "removed" => Vec::<Value>::new(),
        });
    }
    let old: HashMap<&str, &Value> = previous.iter().map(|e| (sv(e.get("id")), e)).collect();
    let ids: HashSet<&str> = entries.iter().map(|e| sv(e.get("id"))).collect();
    let order: Vec<String> = entries.iter().map(|e| sv(e.get("id")).to_owned()).collect();
    let previous_order: Vec<&str> = previous.iter().map(|e| sv(e.get("id"))).collect();
    let upserts: Vec<Value> = entries
        .iter()
        .filter(|entry| {
            old.get(sv(entry.get("id")))
                .is_none_or(|before| js::stringify(before) != js::stringify(entry))
        })
        .cloned()
        .collect();
    let removed: Vec<Value> = previous
        .iter()
        .filter(|e| !ids.contains(sv(e.get("id"))))
        .map(|e| Value::String(sv(e.get("id")).to_owned()))
        .collect();
    let mut out = obj! {
        "history_version" => 2i64,
        "mode" => "delta",
        "cursor" => cursor.clone(),
        "base_revision" => js::number(base_revision.unwrap_or(0.0)),
        "window_limit" => limit,
        "upserts" => upserts,
        "removed" => removed,
    };
    if order.join(",") != previous_order.join(",") {
        out.insert(
            "order".into(),
            Value::Array(order.into_iter().map(Value::String).collect()),
        );
    }
    Value::Object(out)
}
