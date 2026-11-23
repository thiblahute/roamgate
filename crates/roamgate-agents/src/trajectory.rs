//! `session-trajectory.ts`: a transcript of each of the eight agents as an
//! ATIF trajectory (Codex, Claude, Kimi, Pi and OMP, Grok, Muse,
//! Antigravity), the one projection every reader works from.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::codex_injected::{CodexInjectedState, CodexUserPart, codex_user_parts};
use crate::grok::{grok_reasoning_text, grok_user_message_text};
use crate::js::{self, Obj, put, sv};
use crate::rewind::REWOUND_PROMPT;
use crate::session::SessionFile;
use crate::shared::bash_mode::{BashModePart, split_bash_mode};
use crate::shared::file_edits::file_edit_from_result;
use crate::shared::injected::parse_injected_message;
use crate::shared::slash_command::{local_command_output, parse_slash_command, slash_command_text};
use crate::token_usage::{
    TokenUsageReader, summarize_token_usage, token_usage_for_record, token_usage_from,
    token_usage_to_metrics,
};
use crate::utils::{
    basename, clean_message_text, message_time, text_from_content, timestamp_ms, without_extension,
};

type Step = Obj;

fn model_name_from_record(record: &Obj) -> String {
    js::truthy(sv(record.get("model")))
        .or(js::truthy(sv(record.get("model_name"))))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            sv(js::rec(record.get("message")).and_then(|m| m.get("model"))).to_owned()
        })
}

fn agent_version_from_records(agent: &str, records: &[Obj]) -> String {
    for record in records {
        let payload = js::rec(record.get("payload"));
        let own_version =
            if (agent == "pi" || agent == "omp") && sv(record.get("type")) == "session" {
                ""
            } else {
                sv(record.get("version"))
            };
        let version = js::truthy(sv(record.get("cli_version")))
            .or(js::truthy(own_version))
            .or(js::truthy(sv(record.get("originator"))))
            .or_else(|| {
                payload.and_then(|p| {
                    js::truthy(sv(p.get("cli_version")))
                        .or(js::truthy(sv(p.get("version"))))
                        .or(js::truthy(sv(p.get("originator"))))
                })
            });
        if let Some(version) = version {
            return version.to_owned();
        }
    }
    match agent {
        "kimi" => "kimi-code".into(),
        "agy" => "antigravity-cli".into(),
        _ => "unknown".into(),
    }
}

fn session_id_from_records(file: &SessionFile, records: &[Obj]) -> String {
    if let Some(id) = file.session_id() {
        return id.to_owned();
    }
    for record in records {
        let payload = js::rec(record.get("payload"));
        let id = js::truthy(sv(record.get("session_id")))
            .or(js::truthy(sv(record.get("sessionId"))))
            .or(js::truthy(sv(record.get("conversation_id"))))
            .or(if sv(record.get("type")) == "session" {
                js::truthy(sv(record.get("id")))
            } else {
                None
            })
            .or_else(|| {
                payload.and_then(|p| {
                    js::truthy(sv(p.get("session_id")))
                        .or(js::truthy(sv(p.get("sessionId"))))
                        .or(js::truthy(sv(p.get("id"))))
                })
            });
        if let Some(id) = id {
            return id.to_owned();
        }
    }
    without_extension(basename(&file.path)).to_owned()
}

fn step_kept(step: &Step) -> bool {
    !js::trim(sv(step.get("message"))).is_empty()
        || extra_images(step) > 0.0
        || step
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|r| !js::trim(r).is_empty())
        || step
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|c| !c.is_empty())
        || step
            .get("observation")
            .and_then(|o| o.get("results"))
            .and_then(Value::as_array)
            .is_some_and(|r| !r.is_empty())
}

fn extra_images(step: &Step) -> f64 {
    step.get("extra")
        .and_then(|e| e.get("images"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn create_trajectory(
    agent: &str,
    file: &SessionFile,
    records: &[Obj],
    steps: Vec<Step>,
    prompt_includes_cached: bool,
) -> Value {
    let usage = summarize_token_usage(records);
    let mut metrics = token_usage_to_metrics(usage.as_ref());
    if prompt_includes_cached
        && let Some(m) = metrics.as_mut()
        && let (Some(p), Some(c)) = (
            m.get("prompt_tokens").and_then(Value::as_f64),
            m.get("cached_tokens").and_then(Value::as_f64),
        )
    {
        m.insert("prompt_tokens".into(), js::number(p + c));
    }
    let session_id = session_id_from_records(file, records);
    let steps: Vec<Value> = steps
        .into_iter()
        .filter(step_kept)
        .enumerate()
        .map(|(index, mut step)| {
            step.insert("step_id".into(), js::int(index as i64 + 1));
            Value::Object(step)
        })
        .collect();
    let total = steps.len();
    let name = match agent {
        "muse" => "muse-code",
        "kimi" => "kimi-code",
        "claude" => "claude-code",
        "grok" => "grok-build",
        "agy" => "antigravity-cli",
        other => other,
    };
    let trajectory_id = file.session_id().map(str::to_owned).unwrap_or_else(|| {
        if agent == "pi" || agent == "omp" {
            session_id.clone()
        } else {
            without_extension(basename(&file.path)).to_owned()
        }
    });
    let version = file
        .agent_version
        .clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| agent_version_from_records(agent, records));
    let m = |key: &str| metrics.as_ref().and_then(|m| m.get(key)).cloned();
    Value::Object(obj! {
        "schema_version" => "ATIF-v1.7",
        "session_id" => session_id,
        "trajectory_id" => trajectory_id,
        "agent" => obj! {
            "name" => name,
            "version" => version,
            "model_name" => file.model_name.clone().filter(|m| !m.is_empty()),
        },
        "steps" => steps,
        "final_metrics" => obj! {
            "total_prompt_tokens" => m("prompt_tokens"),
            "total_completion_tokens" => m("completion_tokens"),
            "total_cached_tokens" => m("cached_tokens"),
            "total_steps" => total,
            "extra" => m("extra"),
        },
        "extra" => obj! {
            "source_path" => file.path.clone(),
            "source_records" => records.len(),
            "projection" => "roamgate-lightweight",
        },
    })
}

fn codex_content_text(value: Option<&Value>) -> String {
    let Some(Value::Array(items)) = value else {
        return text_from_content(value);
    };
    items
        .iter()
        .map(|item| match item {
            Value::Object(map) => match (map.get("text"), map.get("content")) {
                (Some(Value::String(t)), _) => t.clone(),
                (_, Some(Value::String(c))) => c.clone(),
                _ => text_from_content(Some(item)),
            },
            other => text_from_content(Some(other)),
        })
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_output_text(value: Option<&Value>) -> String {
    if let Some(Value::String(text)) = value {
        return text.clone();
    }
    let text = text_from_content(value);
    if !text.is_empty() {
        return text;
    }
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => js::stringify_pretty(other),
    }
}

fn tool_result_extra(value: &Obj) -> Obj {
    let error = js::is_true(value.get("is_error"))
        || js::is_true(value.get("isError"))
        || matches!(sv(value.get("status")), "error" | "failed");
    obj! { "is_error" => error.then_some(true) }
}

fn tool_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) => match js::parse(text) {
            Some(Value::Object(parsed)) => Value::Object(parsed),
            _ => Value::Object(obj! { "value" => text.clone() }),
        },
        _ => Value::Object(Obj::new()),
    }
}

fn metrics_value(usage: Option<&crate::token_usage::TokenUsage>) -> Option<Obj> {
    token_usage_to_metrics(usage)
}

fn pi_token_usage_to_metrics(value: Option<&Value>) -> Option<Obj> {
    let mut metrics = token_usage_to_metrics(token_usage_from(value).as_ref());
    if let Some(m) = metrics.as_mut()
        && let (Some(p), Some(c)) = (
            m.get("prompt_tokens").and_then(Value::as_f64),
            m.get("cached_tokens").and_then(Value::as_f64),
        )
    {
        m.insert("prompt_tokens".into(), js::number(p + c));
    }
    metrics
}

fn extra_of(step: &mut Step) -> &mut Obj {
    if !matches!(step.get("extra"), Some(Value::Object(_))) {
        step.insert("extra".into(), Value::Object(Obj::new()));
    }
    step.get_mut("extra")
        .and_then(Value::as_object_mut)
        .unwrap()
}

// ---------------------------------------------------------------- Codex

fn codex_user_steps(
    steps: &mut Vec<Step>,
    payload: &Obj,
    timestamp: &str,
    state: &mut CodexInjectedState,
) {
    for part in codex_user_parts(payload, state) {
        match part {
            CodexUserPart::Text(text) => {
                let text = clean_message_text(&text);
                if !text.is_empty() {
                    steps.push(obj! {
                        "timestamp" => timestamp,
                        "source" => "user",
                        "message" => text,
                        "metrics" => token_usage_to_metrics(token_usage_from(payload.get("usage")).as_ref()),
                    });
                }
            }
            CodexUserPart::Notice { kind, label, body } => {
                let message = if js::trim(&body).is_empty() {
                    label.clone()
                } else {
                    js::trim(&body).to_owned()
                };
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "user",
                    "message" => message,
                    "extra" => obj! { "injected" => obj! { "kind" => kind, "label" => label } },
                });
            }
        }
    }
}

fn project_codex(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let is_message = |record: &Obj, role: &str| {
        sv(record.get("type")) == "response_item"
            && js::rec(record.get("payload"))
                .is_some_and(|p| sv(p.get("type")) == "message" && sv(p.get("role")) == role)
    };
    let has_user = records.iter().any(|r| is_message(r, "user"));
    let has_assistant = records.iter().any(|r| is_message(r, "assistant"));
    let mut state = CodexInjectedState::default();
    for (index, record) in records.iter().enumerate() {
        let timestamp = message_time(record, file.mtime_ms, index);
        if sv(record.get("type")) == "event_msg"
            && let Some(payload) = js::rec(record.get("payload"))
        {
            match sv(payload.get("type")) {
                "user_message" => {
                    if has_user {
                        continue;
                    }
                    let text = clean_message_text(sv(payload.get("message")));
                    if !text.is_empty() {
                        steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text });
                    }
                    continue;
                }
                "agent_message" => {
                    if has_assistant {
                        continue;
                    }
                    let text = clean_message_text(sv(payload.get("message")));
                    if !text.is_empty() {
                        steps.push(obj! { "timestamp" => timestamp, "source" => "agent", "message" => text });
                    }
                    continue;
                }
                "token_count" if js::rec(payload.get("info")).is_some() => {
                    let info = js::rec(payload.get("info")).unwrap();
                    if let Some(metrics) = token_usage_to_metrics(
                        token_usage_from(info.get("total_token_usage")).as_ref(),
                    ) {
                        steps.push(obj! {
                            "timestamp" => timestamp,
                            "source" => "system",
                            "message" => "Token usage",
                            "metrics" => metrics,
                            "extra" => obj! { "record_type" => "token_count" },
                        });
                    }
                    continue;
                }
                _ => {}
            }
        }
        if sv(record.get("type")) != "response_item" {
            continue;
        }
        let Some(payload) = js::rec(record.get("payload")) else {
            continue;
        };
        let kind = sv(payload.get("type"));
        if kind == "message" {
            let role = sv(payload.get("role"));
            if role == "user" {
                codex_user_steps(&mut steps, payload, &timestamp, &mut state);
                continue;
            }
            let text = clean_message_text(&codex_content_text(payload.get("content")));
            if text.is_empty() {
                continue;
            }
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => if role == "assistant" { "agent" } else { "system" },
                "message" => text,
                "metrics" => token_usage_to_metrics(token_usage_from(payload.get("usage")).as_ref()),
            });
        } else if kind == "reasoning" {
            let summary = codex_content_text(payload.get("summary"));
            let text = clean_message_text(&if summary.is_empty() {
                codex_content_text(payload.get("content"))
            } else {
                summary
            });
            if text.is_empty() {
                continue;
            }
            if let Some(last) = steps.last_mut()
                && sv(last.get("extra").and_then(|e| e.get("record_type"))) == "reasoning"
                && let Some(Value::String(reasoning)) = last.get("reasoning_content")
                && !reasoning.is_empty()
            {
                let joined = format!("{reasoning}\n\n{text}");
                last.insert("reasoning_content".into(), Value::String(joined));
                continue;
            }
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "agent",
                "message" => "Reasoning",
                "reasoning_content" => text,
                "extra" => obj! { "record_type" => kind },
            });
        } else if kind.contains("output") || kind.contains("result") {
            steps.push(codex_result_step(payload, kind, &timestamp));
        } else if kind.contains("tool_call") || kind.contains("function_call") {
            let name = js::truthy(sv(payload.get("name")))
                .or(js::truthy(sv(payload.get("call_name"))))
                .or(js::truthy(sv(payload.get("function_name"))))
                .unwrap_or(kind)
                .to_owned();
            let id = js::truthy(sv(payload.get("call_id")))
                .or(js::truthy(sv(payload.get("id"))))
                .map(str::to_owned)
                .unwrap_or_else(|| index.to_string());
            let args = match payload.get("arguments") {
                None | Some(Value::Null) => payload.get("input"),
                other => other,
            };
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "agent",
                "message" => format!("Tool call: {name}"),
                "tool_calls" => vec![Value::Object(obj! {
                    "tool_call_id" => id,
                    "function_name" => name,
                    "arguments" => tool_arguments(args),
                    "extra" => obj! { "record_type" => kind },
                })],
            });
        } else if kind.contains("tool") {
            steps.push(codex_result_step(payload, kind, &timestamp));
        }
    }
    create_trajectory("codex", file, records, steps, false)
}

fn codex_result_step(payload: &Obj, kind: &str, timestamp: &str) -> Step {
    let source = match payload.get("output") {
        None | Some(Value::Null) => payload.get("content"),
        other => other,
    };
    let content = tool_output_text(source);
    let id = js::truthy(sv(payload.get("call_id")))
        .unwrap_or(sv(payload.get("id")))
        .to_owned();
    let shown = if content.is_empty() {
        js::truthy(sv(payload.get("status")))
            .unwrap_or(kind)
            .to_owned()
    } else {
        content.clone()
    };
    obj! {
        "timestamp" => timestamp,
        "source" => "system",
        "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
        "observation" => obj! { "results" => vec![Value::Object(obj! {
            "source_call_id" => id,
            "content" => shown,
            "extra" => tool_result_extra(payload),
        })] },
        "extra" => obj! { "record_type" => kind },
    }
}

// ---------------------------------------------------------------- Claude

struct Queued {
    content: String,
    timestamp: String,
    shown: bool,
}

fn queued_key(content: &str) -> String {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*<([a-z-]+)[\s>]").unwrap());
    match TAG.captures(content) {
        Some(caps) => {
            let after = content.find('>').map_or(content, |at| &content[at + 1..]);
            format!("{}\u{0}{after}", &caps[1])
        }
        None => content.to_owned(),
    }
}

fn take_queued(queue: &mut Vec<Queued>, content: &str) -> bool {
    let mut at = queue.iter().position(|q| q.content == content);
    if at.is_none() {
        let key = queued_key(content);
        at = queue.iter().position(|q| queued_key(&q.content) == key);
    }
    match at {
        Some(at) => {
            queue.remove(at);
            true
        }
        None => false,
    }
}

fn collapse_spaces(text: &str) -> String {
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    js::trim(&SPACES.replace_all(text, " ")).to_owned()
}

fn dequeue_queued(queue: &mut Vec<Queued>, dequeued: usize, text: &str) {
    let mut left = if take_queued(queue, text) {
        dequeued as i64 - 1
    } else {
        dequeued as i64
    };
    let words = collapse_spaces(text);
    while left > 0 {
        let at = queue.iter().position(|q| {
            let content = collapse_spaces(&q.content);
            !content.is_empty() && words.contains(&content)
        });
        let at = at.unwrap_or(0);
        if at < queue.len() {
            queue.remove(at);
        }
        left -= 1;
    }
}

fn has_tool_parts(parts: &[&Obj]) -> bool {
    parts
        .iter()
        .any(|p| matches!(sv(p.get("type")), "tool_use" | "tool_result"))
}

fn project_claude(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let mut queue: Vec<Queued> = Vec::new();
    let mut dequeued: usize = 0;
    let mut block_counts: HashMap<String, usize> = HashMap::new();
    let mut cut: Vec<(String, String)> = Vec::new();

    fn injected(steps: &mut Vec<Step>, text: &str, timestamp: &str, extra: &Obj) -> bool {
        let Some(parsed) = parse_injected_message(text) else {
            return false;
        };
        for notice in &parsed.notices {
            let message = if js::trim(&notice.body).is_empty() {
                notice.label.clone()
            } else {
                js::trim(&notice.body).to_owned()
            };
            let mut step_extra = extra.clone();
            step_extra.insert(
                "injected".into(),
                Value::Object(
                    obj! { "kind" => notice.kind.clone(), "label" => notice.label.clone() },
                ),
            );
            steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => message, "extra" => step_extra });
        }
        let rest = clean_message_text(&parsed.rest);
        if !rest.is_empty() {
            steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => rest, "extra" => extra.clone() });
        }
        true
    }

    fn shell_steps(
        steps: &mut Vec<Step>,
        parts: &[BashModePart],
        timestamp: &str,
        extra: &Obj,
        cwd: &str,
    ) {
        for part in parts {
            if part.command.is_none()
                && let Some(last) = steps.last_mut()
                && let Some(Value::Object(shell)) =
                    last.get_mut("extra").and_then(|e| e.get_mut("shell"))
                && !shell.contains_key("stdout")
            {
                shell.insert(
                    "stdout".into(),
                    Value::String(part.stdout.clone().unwrap_or_default()),
                );
                shell.insert(
                    "stderr".into(),
                    Value::String(part.stderr.clone().unwrap_or_default()),
                );
                continue;
            }
            let mut shell = part.to_obj();
            shell.insert(
                "command".into(),
                Value::String(part.command.clone().unwrap_or_default()),
            );
            if !cwd.is_empty() {
                shell.insert("cwd".into(), Value::String(cwd.to_owned()));
            }
            let message = part
                .command
                .as_deref()
                .map(js::trim)
                .filter(|c| !c.is_empty())
                .unwrap_or("!")
                .to_owned();
            let mut step_extra = extra.clone();
            step_extra.insert("shell".into(), Value::Object(shell));
            steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => message, "extra" => step_extra });
        }
    }

    fn flush_cut(steps: &mut Vec<Step>, cut: &mut Vec<(String, String)>) {
        if cut.is_empty() {
            return;
        }
        let label = if cut.len() == 1 {
            "Rewound: your message left the conversation".to_owned()
        } else {
            format!(
                "Rewound: {} of your messages left the conversation",
                cut.len()
            )
        };
        let message = cut
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let rewound: Vec<Value> = cut
            .iter()
            .map(|(text, at)| {
                Value::Object(obj! { "text" => text.clone(), "sent_at" => at.clone() })
            })
            .collect();
        steps.push(obj! {
            "timestamp" => cut[0].1.clone(),
            "source" => "user",
            "message" => message,
            "extra" => obj! {
                "record_type" => REWOUND_PROMPT,
                "injected" => obj! { "kind" => "rewound", "label" => label },
                "rewound" => rewound,
            },
        });
        cut.clear();
    }

    static IMAGE_NOTE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\[Image: original [0-9]+x[0-9]+").unwrap());
    static TAGGED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^\s*<[a-z-]+[\s>]").unwrap());

    for (index, record) in records.iter().enumerate() {
        let timestamp = message_time(record, file.mtime_ms, index);
        let kind = sv(record.get("type"));
        if !cut.is_empty() && record.get("uuid").is_some_and(Value::is_string) {
            flush_cut(&mut steps, &mut cut);
        }
        if kind == REWOUND_PROMPT {
            let text = text_from_content(record.get("content"));
            dequeue_queued(&mut queue, dequeued, &text);
            dequeued = 0;
            let parsed = parse_injected_message(&text);
            let words =
                clean_message_text(parsed.as_ref().map_or(text.as_str(), |p| p.rest.as_str()));
            if !words.is_empty() && split_bash_mode(&text).is_none() {
                cut.push((words, timestamp));
            }
            continue;
        }
        if kind == "last-prompt" && js::is_true(record.get("rewound")) {
            flush_cut(&mut steps, &mut cut);
            queue.clear();
            dequeued = 0;
            continue;
        }
        if kind == "queue-operation" {
            let content = sv(record.get("content")).to_owned();
            match sv(record.get("operation")) {
                "enqueue" => {
                    let shown = !js::trim(&content).is_empty() && !TAGGED.is_match(&content);
                    queue.push(Queued {
                        content,
                        timestamp,
                        shown,
                    });
                }
                "remove" | "popAll" => {
                    take_queued(&mut queue, &content);
                }
                "dequeue" => dequeued += 1,
                _ => {}
            }
            continue;
        }
        if kind == "attachment" {
            let empty = Obj::new();
            let attachment = js::rec(record.get("attachment")).unwrap_or(&empty);
            let origin = js::rec(attachment.get("origin"));
            let source_uuid = sv(attachment.get("source_uuid"));
            let human = match origin {
                Some(origin) => sv(origin.get("kind")) == "human",
                None => sv(attachment.get("commandMode")) == "prompt" && !source_uuid.is_empty(),
            };
            if sv(attachment.get("type")) != "queued_command" {
                continue;
            }
            let extra = obj! {
                "record_type" => "queued_command",
                "uuid" => js::truthy(source_uuid),
            };
            let prompt = text_from_content(attachment.get("prompt"));
            if !human {
                injected(&mut steps, &prompt, &timestamp, &extra);
                continue;
            }
            if injected(&mut steps, &prompt, &timestamp, &extra) {
                continue;
            }
            let text = clean_message_text(&prompt);
            if !text.is_empty() {
                steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text, "extra" => extra });
            }
            continue;
        }
        if kind != "user" && kind != "assistant" && kind != "system" {
            continue;
        }
        if kind == "system" && sv(record.get("subtype")) == "local_command" {
            let content = text_from_content(record.get("content"));
            let uuid = sv(record.get("uuid"));
            let command = parse_slash_command(&content);
            let output = if command.is_some() {
                None
            } else {
                local_command_output(&content)
            };
            if command.is_some() || output.is_some() {
                let mut extra = obj! { "record_type" => kind };
                match &command {
                    Some(c) => {
                        extra.insert("command".into(), c.to_value());
                    }
                    None => {
                        extra.insert("command_output".into(), Value::Bool(true));
                    }
                }
                put(&mut extra, "uuid", js::truthy(uuid));
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => if command.is_some() { "user" } else { "agent" },
                    "message" => command.as_ref().map(slash_command_text).or(output),
                    "extra" => extra,
                });
            }
            continue;
        }
        let message: &Obj = js::rec(record.get("message")).unwrap_or(record);
        let role = js::truthy(sv(message.get("role"))).unwrap_or(kind);
        let content = match message.get("content") {
            None | Some(Value::Null) => record.get("content"),
            other => other,
        };
        let content_text = text_from_content(content);
        let mut text = clean_message_text(&content_text);
        let usage = token_usage_for_record(record, "").0;
        let parts: Vec<&Obj> = match message.get("content") {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
            _ => Vec::new(),
        };
        let tool_parts = has_tool_parts(&parts);
        let is_meta = js::is_true(record.get("isMeta"));
        if kind == "user" && !is_meta && !tool_parts {
            dequeue_queued(&mut queue, dequeued, &content_text);
            dequeued = 0;
        }
        let api_message_id = if kind == "assistant" {
            sv(message.get("id")).to_owned()
        } else {
            String::new()
        };
        let first_block = if api_message_id.is_empty() {
            0
        } else {
            block_counts.get(&api_message_id).copied().unwrap_or(0)
        };
        if !api_message_id.is_empty() {
            block_counts.insert(api_message_id.clone(), first_block + parts.len().max(1));
        }
        let record_uuid = sv(record.get("uuid")).to_owned();
        let ids = |block: usize| {
            let mut out = Obj::new();
            if !api_message_id.is_empty() {
                out.insert("message_id".into(), Value::String(api_message_id.clone()));
                out.insert("block_index".into(), js::int((first_block + block) as i64));
            }
            if !record_uuid.is_empty() {
                out.insert("uuid".into(), Value::String(record_uuid.clone()));
            }
            out
        };
        if role == "user" && !tool_parts {
            if let Some((bash_parts, rest)) = split_bash_mode(&content_text) {
                shell_steps(
                    &mut steps,
                    &bash_parts,
                    &timestamp,
                    &obj! { "record_type" => kind },
                    sv(record.get("cwd")),
                );
                text = clean_message_text(&rest);
                if text.is_empty() && !parts.iter().any(|p| sv(p.get("type")) == "image") {
                    continue;
                }
            }
        }
        let command = if role == "user" && !is_meta && !tool_parts {
            parse_slash_command(&content_text)
        } else {
            None
        };
        if let Some(command) = command {
            let extra = js::spread(
                obj! { "record_type" => kind, "command" => command.to_value() },
                &ids(0),
            );
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "user",
                "message" => slash_command_text(&command),
                "extra" => extra,
            });
            continue;
        }
        if role == "user" && !tool_parts {
            let extra = js::spread(obj! { "record_type" => kind }, &ids(0));
            if injected(&mut steps, &content_text, &timestamp, &extra) {
                continue;
            }
        }
        if is_meta && !tool_parts {
            continue;
        }
        if tool_parts {
            let start = steps.len();
            let results = parts
                .iter()
                .filter(|p| sv(p.get("type")) == "tool_result")
                .count();
            let file_edit = if results == 1 {
                file_edit_from_result(record.get("toolUseResult"))
            } else {
                None
            };
            for (block, part) in parts.iter().enumerate() {
                let part_type = sv(part.get("type"));
                if part_type == "tool_use" {
                    let name = js::truthy(sv(part.get("name")))
                        .unwrap_or("tool")
                        .to_owned();
                    let id = js::truthy(sv(part.get("id")))
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{index}:{}", steps.len()));
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => "agent",
                        "message" => format!("Tool call: {name}"),
                        "tool_calls" => vec![Value::Object(obj! {
                            "tool_call_id" => id,
                            "function_name" => name,
                            "arguments" => tool_arguments(part.get("input")),
                        })],
                    });
                } else if part_type == "tool_result" {
                    let content = tool_output_text(part.get("content"));
                    let is_error = js::is_true(part.get("is_error"));
                    let truthy_error = part.get("is_error").is_some_and(truthy);
                    let shown = if !content.is_empty() {
                        content.clone()
                    } else if truthy_error {
                        "Tool failed".into()
                    } else {
                        "Tool result".into()
                    };
                    let mut extra = obj! { "is_error" => is_error.then_some(true) };
                    if let Some(edit) = &file_edit
                        && !is_error
                    {
                        extra.insert("file_edit".into(), edit.clone());
                    }
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => "system",
                        "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
                        "observation" => obj! { "results" => vec![Value::Object(obj! {
                            "source_call_id" => sv(part.get("tool_use_id")),
                            "content" => shown,
                            "extra" => extra,
                        })] },
                    });
                } else if part_type == "text"
                    && !clean_message_text(sv(part.get("text"))).is_empty()
                    && !IMAGE_NOTE.is_match(sv(part.get("text")))
                {
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => if role == "user" { "user" } else { "agent" },
                        "message" => clean_message_text(sv(part.get("text"))),
                        "extra" => ids(block),
                    });
                } else if part_type == "thinking" && !js::trim(sv(part.get("thinking"))).is_empty()
                {
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => "agent",
                        "message" => "Reasoning",
                        "reasoning_content" => sv(part.get("thinking")),
                    });
                }
            }
            if steps.len() > start {
                let model = js::truthy(&model_name_from_record(record)).map(str::to_owned);
                let last = steps.last_mut().unwrap();
                set_or_remove(
                    last,
                    "metrics",
                    metrics_value(usage.as_ref()).map(Value::Object),
                );
                let extra = extra_of(last);
                extra.insert("record_type".into(), Value::String(kind.to_owned()));
                set_or_remove(extra, "model", model.map(Value::String));
            }
            continue;
        }
        let images = if role == "user" {
            parts
                .iter()
                .filter(|p| sv(p.get("type")) == "image")
                .count()
        } else {
            0
        };
        if text.is_empty() && usage.is_none() && images == 0 {
            continue;
        }
        let text_block = parts
            .iter()
            .position(|p| sv(p.get("type")) == "text")
            .unwrap_or(0);
        let mut extra = obj! {
            "record_type" => kind,
            "images" => (images > 0).then_some(images as i64),
            "model" => js::truthy(&model_name_from_record(record)).map(str::to_owned),
        };
        extra = js::spread(extra, &ids(text_block));
        put(
            &mut extra,
            "compact_summary",
            js::is_true(record.get("isCompactSummary")).then_some(true),
        );
        put(
            &mut extra,
            "turn_end",
            (role == "assistant" && sv(message.get("stop_reason")) == "end_turn").then_some(true),
        );
        let message_text = if !text.is_empty() {
            text
        } else if images > 0 {
            String::new()
        } else {
            "Token usage".into()
        };
        steps.push(obj! {
            "timestamp" => timestamp,
            "source" => match role { "user" => "user", "assistant" => "agent", _ => "system" },
            "message" => message_text,
            "metrics" => metrics_value(usage.as_ref()),
            "extra" => extra,
        });
    }
    flush_cut(&mut steps, &mut cut);
    let take = dequeued.min(queue.len());
    queue.drain(..take);
    for queued in &queue {
        let text = if queued.shown {
            clean_message_text(&queued.content)
        } else {
            String::new()
        };
        if !text.is_empty() {
            steps.push(obj! {
                "timestamp" => queued.timestamp.clone(),
                "source" => "user",
                "message" => text,
                "extra" => obj! { "record_type" => "queue-operation", "queued" => true },
            });
        }
    }
    create_trajectory("claude", file, records, steps, false)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn set_or_remove(map: &mut Obj, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            map.insert(key.to_owned(), v);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

// ---------------------------------------------------------------- Kimi

fn project_kimi(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let mut by_model_step: HashMap<String, usize> = HashMap::new();
    let mut created_at = file.mtime_ms;
    for record in records {
        if sv(record.get("type")) != "metadata" {
            continue;
        }
        let raw = js::to_number(record.get("created_at"));
        if raw.is_finite() && raw > 0.0 {
            created_at = raw;
        }
    }
    for (index, record) in records.iter().enumerate() {
        let timestamp = js::iso(timestamp_ms(record, created_at, index));
        let kind = sv(record.get("type"));
        if kind == "context.append_message"
            && let Some(message) = js::rec(record.get("message"))
        {
            if sv(message.get("role")) != "user" {
                continue;
            }
            let text = clean_message_text(&text_from_content(message.get("content")));
            if text.is_empty() {
                continue;
            }
            steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text, "extra" => obj! { "record_type" => kind } });
            continue;
        }
        if kind != "context.append_loop_event" {
            continue;
        }
        let Some(event) = js::rec(record.get("event")) else {
            continue;
        };
        let event_type = sv(event.get("type"));
        let step_text = match event.get("step") {
            None | Some(Value::Null) => String::new(),
            Some(v) => js::to_text(v),
        };
        let key = format!("{}:{step_text}", sv(event.get("turnId")));
        let extra = obj! { "record_type" => kind, "event_type" => event_type };
        if event_type == "content.part"
            && let Some(part) = js::rec(event.get("part"))
        {
            match sv(part.get("type")) {
                "text" => {
                    let text = clean_message_text(sv(part.get("text")));
                    if !text.is_empty() {
                        steps.push(obj! { "timestamp" => timestamp, "source" => "agent", "message" => text, "extra" => extra });
                        by_model_step.insert(key, steps.len() - 1);
                    }
                }
                "think" => {
                    let reasoning = clean_message_text(sv(part.get("think")));
                    if !reasoning.is_empty() {
                        steps.push(obj! {
                            "timestamp" => timestamp,
                            "source" => "agent",
                            "message" => "Reasoning",
                            "reasoning_content" => reasoning,
                            "extra" => extra,
                        });
                        by_model_step.insert(key, steps.len() - 1);
                    }
                }
                _ => {}
            }
            continue;
        }
        if event_type == "tool.call" {
            let name = js::truthy(sv(event.get("name")))
                .unwrap_or("tool")
                .to_owned();
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "agent",
                "message" => format!("Tool call: {name}"),
                "tool_calls" => vec![Value::Object(obj! {
                    "tool_call_id" => js::truthy(sv(event.get("toolCallId"))).map(str::to_owned).unwrap_or_else(|| index.to_string()),
                    "function_name" => name,
                    "arguments" => tool_arguments(event.get("args")),
                    "extra" => obj! { "description" => js::truthy(sv(event.get("description"))) },
                })],
                "extra" => extra,
            });
            by_model_step.insert(key, steps.len() - 1);
            continue;
        }
        if event_type == "tool.result" {
            let empty = Obj::new();
            let result = js::rec(event.get("result")).unwrap_or(&empty);
            let content = tool_output_text(result.get("output"));
            let failed = result.get("isError").is_some_and(truthy);
            let shown = if !content.is_empty() {
                content.clone()
            } else if failed {
                "Tool failed".into()
            } else {
                "Tool result".into()
            };
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "system",
                "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
                "observation" => obj! { "results" => vec![Value::Object(obj! {
                    "source_call_id" => sv(event.get("toolCallId")),
                    "content" => shown,
                    "extra" => obj! { "is_error" => js::is_true(result.get("isError")).then_some(true) },
                })] },
                "extra" => extra,
            });
            continue;
        }
        if event_type == "step.end" {
            let metrics = token_usage_to_metrics(token_usage_from(event.get("usage")).as_ref());
            if let (Some(&at), Some(metrics)) = (by_model_step.get(&key), metrics) {
                steps[at].insert("metrics".into(), Value::Object(metrics));
            }
        }
    }
    create_trajectory("kimi", file, records, steps, false)
}

// ---------------------------------------------------------------- Pi, OMP

fn project_pi(file: &SessionFile, records: &[Obj], agent: &str) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let mut model_name = file.model_name.clone().unwrap_or_default();
    for (index, record) in records.iter().enumerate() {
        let kind = sv(record.get("type"));
        if kind == "model_change" {
            if let Some(model) = js::truthy(sv(record.get("modelId"))) {
                model_name = model.to_owned();
            }
            continue;
        }
        if agent == "omp"
            && kind == "custom_message"
            && sv(record.get("customType")) == "skill-prompt"
            && sv(record.get("attribution")) == "user"
        {
            let empty = Obj::new();
            let details = js::rec(record.get("details")).unwrap_or(&empty);
            let name = sv(details.get("name"));
            let args = sv(details.get("args"));
            let prompt = js::trim(sv(details.get("prompt")));
            let text = if !prompt.is_empty() {
                prompt.to_owned()
            } else if !name.is_empty() {
                format!(
                    "/skill:{name}{}",
                    if args.is_empty() {
                        String::new()
                    } else {
                        format!(" {args}")
                    }
                )
            } else {
                String::new()
            };
            if !text.is_empty() {
                steps.push(obj! {
                    "timestamp" => message_time(record, file.mtime_ms, index),
                    "source" => "user",
                    "message" => text,
                    "extra" => obj! { "record_type" => kind },
                });
            }
            continue;
        }
        if kind != "message" {
            continue;
        }
        let Some(message) = js::rec(record.get("message")) else {
            continue;
        };
        let role = sv(message.get("role"));
        let timestamp = message_time(record, file.mtime_ms, index);
        if role == "user" {
            let text = clean_message_text(&text_from_content(message.get("content")));
            if !text.is_empty() {
                steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text, "extra" => obj! { "record_type" => kind } });
            }
            continue;
        }
        if role == "toolResult" {
            let content = tool_output_text(message.get("content"));
            let failed = message.get("isError").is_some_and(truthy);
            let shown = if !content.is_empty() {
                content.clone()
            } else if failed {
                "Tool failed".to_owned()
            } else {
                "Tool result".to_owned()
            };
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "system",
                "message" => shown.clone(),
                "observation" => obj! { "results" => vec![Value::Object(obj! {
                    "source_call_id" => sv(message.get("toolCallId")),
                    "content" => shown,
                    "extra" => obj! {
                        "tool_name" => js::truthy(sv(message.get("toolName"))),
                        "is_error" => js::is_true(message.get("isError")).then_some(true),
                    },
                })] },
                "extra" => obj! { "record_type" => kind },
            });
            continue;
        }
        if role == "bashExecution" || role == "pythonExecution" {
            let is_bash = role == "bashExecution";
            let command = sv(message.get("command"));
            let code = sv(message.get("code"));
            let output = tool_output_text(message.get("output"));
            let exit_code = message.get("exitCode").and_then(Value::as_f64);
            let cancelled = js::is_true(message.get("cancelled"));
            let execution = if is_bash { "Command" } else { "Execution" };
            let failed = cancelled || exit_code.is_some_and(|c| c != 0.0);
            let status = if cancelled {
                format!("{execution} cancelled")
            } else if let Some(code) = exit_code.filter(|c| *c != 0.0) {
                format!("{execution} exited with code {}", js::number_text(code))
            } else {
                String::new()
            };
            let source_text = if is_bash {
                format!("Ran `{command}`")
            } else {
                format!("Ran Python:\n```python\n{code}\n```")
            };
            let output_text = if output.is_empty() {
                "(no output)".to_owned()
            } else {
                format!("Output:\n{output}")
            };
            let content = [source_text, output_text, status]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            steps.push(obj! {
                "timestamp" => timestamp,
                "source" => "system",
                "message" => content.clone(),
                "observation" => obj! { "results" => vec![Value::Object(obj! {
                    "content" => content,
                    "extra" => obj! {
                        "tool_name" => if is_bash { "bash" } else { "python" },
                        "command" => is_bash.then(|| command.to_owned()),
                        "code" => (!is_bash).then(|| code.to_owned()),
                        "exit_code" => exit_code,
                        "cancelled" => cancelled.then_some(true),
                        "is_error" => failed.then_some(true),
                    },
                })] },
                "extra" => obj! { "record_type" => kind, "role" => role },
            });
            continue;
        }
        if role != "assistant" {
            continue;
        }
        if let Some(model) = js::truthy(sv(message.get("model"))) {
            model_name = model.to_owned();
        }
        let parts: Vec<&Obj> = match message.get("content") {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
            _ => Vec::new(),
        };
        let join = |kind: &str, key: &str| {
            parts
                .iter()
                .filter(|p| sv(p.get("type")) == kind)
                .map(|p| sv(p.get(key)))
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let text = clean_message_text(&join("text", "text"));
        let reasoning = clean_message_text(&join("thinking", "thinking"));
        let tool_calls: Vec<Value> = parts
            .iter()
            .filter(|p| sv(p.get("type")) == "toolCall")
            .enumerate()
            .map(|(call_index, part)| {
                Value::Object(obj! {
                    "tool_call_id" => js::truthy(sv(part.get("id"))).map(str::to_owned).unwrap_or_else(|| format!("{index}:{call_index}")),
                    "function_name" => js::truthy(sv(part.get("name"))).unwrap_or("tool"),
                    "arguments" => tool_arguments(part.get("arguments")),
                })
            })
            .collect();
        let error_message = if sv(message.get("stopReason")) == "error" {
            js::head16(&clean_message_text(sv(message.get("errorMessage"))), 4096)
        } else {
            String::new()
        };
        let tail_extra = |extra: &mut Obj| {
            extra.insert("record_type".into(), Value::String(kind.to_owned()));
            set_or_remove(
                extra,
                "provider",
                js::truthy(sv(message.get("provider"))).map(|s| Value::String(s.into())),
            );
            set_or_remove(
                extra,
                "model",
                js::truthy(sv(message.get("model"))).map(|s| Value::String(s.into())),
            );
            set_or_remove(
                extra,
                "stop_reason",
                js::truthy(sv(message.get("stopReason"))).map(|s| Value::String(s.into())),
            );
        };
        let first_call = parts.iter().position(|p| sv(p.get("type")) == "toolCall");
        if let Some(first_call) = first_call
            && parts[first_call + 1..]
                .iter()
                .any(|p| sv(p.get("type")) == "text" && !js::trim(sv(p.get("text"))).is_empty())
        {
            let mut call_index = 0;
            let start = steps.len();
            for part in &parts {
                match sv(part.get("type")) {
                    "toolCall" => {
                        let call = tool_calls[call_index].clone();
                        call_index += 1;
                        let name = sv(call.get("function_name")).to_owned();
                        steps.push(obj! {
                            "timestamp" => timestamp.clone(),
                            "source" => "agent",
                            "message" => format!("Tool call: {name}"),
                            "tool_calls" => vec![call],
                        });
                    }
                    "text" => {
                        let content = clean_message_text(sv(part.get("text")));
                        if !content.is_empty() {
                            steps.push(obj! { "timestamp" => timestamp.clone(), "source" => "agent", "message" => content });
                        }
                    }
                    "thinking" => {
                        let content = clean_message_text(sv(part.get("thinking")));
                        if !content.is_empty() {
                            steps.push(obj! {
                                "timestamp" => timestamp.clone(),
                                "source" => "agent",
                                "message" => "Reasoning",
                                "reasoning_content" => content,
                            });
                        }
                    }
                    _ => {}
                }
            }
            if !error_message.is_empty() {
                steps.push(obj! {
                    "timestamp" => timestamp.clone(),
                    "source" => "agent",
                    "message" => format!("Error: {error_message}"),
                    "extra" => obj! { "error_message" => error_message.clone() },
                });
            }
            if steps.len() > start {
                let last = steps.last_mut().unwrap();
                set_or_remove(
                    last,
                    "metrics",
                    pi_token_usage_to_metrics(message.get("usage")).map(Value::Object),
                );
                tail_extra(extra_of(last));
            }
            continue;
        }
        if text.is_empty()
            && reasoning.is_empty()
            && tool_calls.is_empty()
            && error_message.is_empty()
        {
            continue;
        }
        let message_text = if !text.is_empty() {
            text.clone()
        } else if !tool_calls.is_empty() {
            format!(
                "Tool call{}: {}",
                if tool_calls.len() == 1 { "" } else { "s" },
                tool_calls
                    .iter()
                    .map(|c| sv(c.get("function_name")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else if !reasoning.is_empty() {
            "Reasoning".to_owned()
        } else {
            format!("Error: {error_message}")
        };
        let mut extra = Obj::new();
        tail_extra(&mut extra);
        put(&mut extra, "error_message", js::truthy(&error_message));
        steps.push(obj! {
            "timestamp" => timestamp,
            "source" => "agent",
            "message" => message_text,
            "reasoning_content" => js::truthy(&reasoning),
            "tool_calls" => (!tool_calls.is_empty()).then_some(tool_calls),
            "metrics" => pi_token_usage_to_metrics(message.get("usage")),
            "extra" => extra,
        });
    }
    let file = if model_name.is_empty() {
        file.clone()
    } else {
        SessionFile {
            model_name: Some(model_name),
            ..file.clone()
        }
    };
    create_trajectory(agent, &file, records, steps, true)
}

// ---------------------------------------------------------------- Grok

fn project_grok(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let created = file.created_at_ms.unwrap_or(file.mtime_ms);
    for (index, record) in records.iter().enumerate() {
        let timestamp = message_time(record, created, index);
        let kind = sv(record.get("type"));
        match kind {
            "user" => {
                let text = grok_user_message_text(record);
                if !text.is_empty() {
                    steps.push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text, "extra" => obj! { "record_type" => kind } });
                }
            }
            "system" => {
                let text = clean_message_text(&text_from_content(record.get("content")));
                if !text.is_empty() {
                    steps.push(obj! { "timestamp" => timestamp, "source" => "system", "message" => text, "extra" => obj! { "record_type" => kind } });
                }
            }
            "reasoning" => {
                let reasoning = grok_reasoning_text(record);
                if reasoning.is_empty() {
                    continue;
                }
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "agent",
                    "message" => "Reasoning",
                    "reasoning_content" => reasoning,
                    "extra" => obj! { "record_type" => kind, "status" => js::truthy(sv(record.get("status"))) },
                });
            }
            "assistant" => {
                let text = clean_message_text(&text_from_content(record.get("content")));
                let calls = list_tool_calls(record, index);
                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "agent",
                    "message" => if text.is_empty() { calls_message(&calls) } else { text },
                    "tool_calls" => (!calls.is_empty()).then_some(calls),
                    "metrics" => token_usage_to_metrics(token_usage_for_record(record, "").0.as_ref()),
                    "extra" => obj! { "record_type" => kind, "model" => file.model_name.clone() },
                });
            }
            "tool_result" => {
                let content = tool_output_text(record.get("content"));
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "system",
                    "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
                    "observation" => obj! { "results" => vec![Value::Object(obj! {
                        "source_call_id" => sv(record.get("tool_call_id")),
                        "content" => if content.is_empty() { "Tool result".to_owned() } else { content },
                        "extra" => tool_result_extra(record),
                    })] },
                    "extra" => obj! { "record_type" => kind },
                });
            }
            _ => {}
        }
    }
    create_trajectory("grok", file, records, steps, false)
}

fn list_tool_calls(record: &Obj, index: usize) -> Vec<Value> {
    match record.get("tool_calls") {
        Some(Value::Array(calls)) => calls
            .iter()
            .filter_map(Value::as_object)
            .enumerate()
            .map(|(call_index, call)| {
                Value::Object(obj! {
                    "tool_call_id" => js::truthy(sv(call.get("id"))).map(str::to_owned).unwrap_or_else(|| format!("{index}:{call_index}")),
                    "function_name" => js::truthy(sv(call.get("name"))).unwrap_or("tool"),
                    "arguments" => tool_arguments(call.get("arguments")),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn calls_message(calls: &[Value]) -> String {
    format!(
        "Tool call{}: {}",
        if calls.len() == 1 { "" } else { "s" },
        calls
            .iter()
            .map(|c| sv(c.get("function_name")))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

// ---------------------------------------------------------------- Muse

fn project_muse(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let mut accepted: HashSet<String> = HashSet::new();
    let mut materialized: HashMap<String, String> = HashMap::new();
    let mut failed_tools: HashSet<String> = HashSet::new();
    let mut reader = TokenUsageReader::default();
    let mut session_id = file.session_id.clone();
    let mut model_name = file.model_name.clone();
    let mut agent_version = file.agent_version.clone();
    let pair = |a: &str, b: &str| {
        js::stringify(&Value::Array(vec![
            Value::String(a.into()),
            Value::String(b.into()),
        ]))
    };
    for record in records {
        let Some(payload) = js::rec(record.get("payload")) else {
            continue;
        };
        let kind = sv(record.get("payload_type"));
        if kind == "runtime.user_intent.materialized"
            && let Some(outcome) = js::rec(payload.get("outcome"))
        {
            materialized.insert(
                sv(outcome.get("run_id")).to_owned(),
                sv(payload.get("intent_id")).to_owned(),
            );
        }
        if kind == "tool_batch.effect.terminal"
            && let Some(inner) = js::rec(payload.get("record"))
            && let Some(outcome) = js::rec(inner.get("outcome"))
            && sv(outcome.get("kind")) == "failed"
        {
            failed_tools.insert(pair(sv(payload.get("run_id")), sv(inner.get("call_id"))));
        }
    }
    for (index, record) in records.iter().enumerate() {
        let usage = reader.read(record).0;
        let Some(payload) = js::rec(record.get("payload")) else {
            continue;
        };
        let kind = sv(record.get("payload_type"));
        if let Some(stream) = js::rec(record.get("stream"))
            && sv(stream.get("kind")) == "session"
            && session_id.as_deref().is_none_or(str::is_empty)
        {
            session_id = Some(sv(stream.get("id")).to_owned());
        }
        if kind == "runtime.session.metadata"
            && let Some(inner) = js::rec(payload.get("record"))
        {
            if let Some(model) = js::truthy(sv(inner.get("model_id"))) {
                model_name = Some(model.to_owned());
            }
            if let Some(build) = js::rec(inner.get("build"))
                && let Some(semver) = js::truthy(sv(build.get("semver")))
            {
                agent_version = Some(semver.to_owned());
            }
            continue;
        }
        let ms = match record.get("recorded_at") {
            Some(Value::Number(n)) => (n.as_f64().unwrap_or(f64::NAN) / 1000.0).floor(),
            _ => f64::NAN,
        };
        let timestamp = if ms.is_finite() && ms.abs() <= 8.64e15 {
            js::iso(ms)
        } else {
            message_time(record, file.mtime_ms, index)
        };
        if kind == "runtime.user_intent.accepted" {
            let text = clean_message_text(&text_from_content(payload.get("model_messages")));
            if !text.is_empty() {
                steps
                    .push(obj! { "timestamp" => timestamp, "source" => "user", "message" => text });
                let id = sv(payload.get("intent_id"));
                if !id.is_empty() {
                    accepted.insert(id.to_owned());
                }
            }
            continue;
        }
        if kind != "runtime.session" || sv(payload.get("kind")) != "run" {
            continue;
        }
        let Some(event) = js::rec(payload.get("event")) else {
            continue;
        };
        let run_id = sv(payload.get("run_id"));
        match sv(event.get("kind")) {
            "started" => {
                if accepted.contains(run_id)
                    || accepted.contains(materialized.get(run_id).map_or("", String::as_str))
                {
                    continue;
                }
                let text = clean_message_text(sv(event.get("prompt")));
                if !text.is_empty() {
                    steps.push(
                        obj! { "timestamp" => timestamp, "source" => "user", "message" => text },
                    );
                }
            }
            "assistant_message_committed" => {
                let text = clean_message_text(sv(event.get("text")));
                if !text.is_empty() {
                    steps.push(
                        obj! { "timestamp" => timestamp, "source" => "agent", "message" => text },
                    );
                }
            }
            "reasoning_committed" => {
                let text = clean_message_text(sv(event.get("text")));
                if !text.is_empty() {
                    steps.push(obj! { "timestamp" => timestamp, "source" => "agent", "message" => "Reasoning", "reasoning_content" => text });
                }
            }
            "assistant_tool_calls_committed" => {
                let Some(Value::Array(calls)) = event.get("tool_calls") else {
                    continue;
                };
                for call in calls.iter().filter_map(Value::as_object) {
                    let name = js::truthy(sv(call.get("name")))
                        .unwrap_or("tool")
                        .to_owned();
                    let id = js::truthy(sv(call.get("call_id")))
                        .or(js::truthy(sv(call.get("id"))))
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{index}:{}", steps.len()));
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => "agent",
                        "message" => format!("Tool call: {name}"),
                        "tool_calls" => vec![Value::Object(obj! {
                            "tool_call_id" => id,
                            "function_name" => name,
                            "arguments" => tool_arguments(call.get("args")),
                        })],
                    });
                }
            }
            "tool_result_batch_committed" => {
                let Some(Value::Array(results)) = event.get("results") else {
                    continue;
                };
                for result in results.iter().filter_map(Value::as_object) {
                    let content = sv(result.get("text")).to_owned();
                    let call_id = sv(result.get("tool_call_id"));
                    let failed = failed_tools.contains(&pair(run_id, call_id));
                    let is_error = if failed {
                        Some(true)
                    } else {
                        tool_result_extra(result)
                            .get("is_error")
                            .and_then(Value::as_bool)
                    };
                    steps.push(obj! {
                        "timestamp" => timestamp.clone(),
                        "source" => "system",
                        "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
                        "observation" => obj! { "results" => vec![Value::Object(obj! {
                            "source_call_id" => call_id,
                            "content" => content,
                            "extra" => obj! { "is_error" => is_error },
                        })] },
                    });
                }
            }
            "terminal" if sv(event.get("terminal")) == "failed" => {
                let reason = clean_message_text(sv(event.get("reason")));
                let error = if reason.is_empty() {
                    "Muse run failed".to_owned()
                } else {
                    reason
                };
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "agent",
                    "message" => format!("Error: {error}"),
                    "extra" => obj! { "error_message" => error },
                });
            }
            "model_completed" => {
                if let Some(model) = js::truthy(sv(event.get("model"))) {
                    model_name = Some(model.to_owned());
                }
                if let Some(metrics) = token_usage_to_metrics(usage.as_ref()) {
                    steps.push(obj! { "timestamp" => timestamp, "source" => "system", "message" => "Token usage", "metrics" => metrics });
                }
            }
            _ => {}
        }
    }
    let file = SessionFile {
        session_id,
        model_name,
        agent_version,
        ..file.clone()
    };
    create_trajectory("muse", &file, records, steps, false)
}

// ---------------------------------------------------------------- Antigravity

fn project_antigravity(file: &SessionFile, records: &[Obj]) -> Value {
    let mut steps: Vec<Step> = Vec::new();
    let created = file.created_at_ms.unwrap_or(file.mtime_ms);
    for (index, record) in records.iter().enumerate() {
        let timestamp = message_time(record, created, index);
        let kind = sv(record.get("type"));
        match kind {
            "user" | "system" => {
                let text = clean_message_text(&text_from_content(record.get("content")));
                if !text.is_empty() {
                    steps.push(obj! { "timestamp" => timestamp, "source" => kind, "message" => text, "extra" => obj! { "record_type" => kind } });
                }
            }
            "reasoning" => {
                let source = match record.get("summary") {
                    None | Some(Value::Null) => record.get("content"),
                    other => other,
                };
                let reasoning = clean_message_text(&text_from_content(source));
                if reasoning.is_empty() {
                    continue;
                }
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "agent",
                    "message" => "Reasoning",
                    "reasoning_content" => reasoning,
                    "metrics" => token_usage_to_metrics(token_usage_for_record(record, "").0.as_ref()),
                    "extra" => obj! { "record_type" => kind, "model" => file.model_name.clone() },
                });
            }
            "assistant" => {
                let text = clean_message_text(&text_from_content(record.get("content")));
                let calls = list_tool_calls(record, index);
                let reasoning = clean_message_text(&text_from_content(record.get("reasoning")));
                let error_message = sv(record.get("error_message")).to_owned();
                if text.is_empty()
                    && calls.is_empty()
                    && reasoning.is_empty()
                    && error_message.is_empty()
                {
                    continue;
                }
                let message = if !text.is_empty() {
                    text
                } else if !calls.is_empty() {
                    calls_message(&calls)
                } else if !error_message.is_empty() {
                    error_message.clone()
                } else {
                    "Assistant message".into()
                };
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "agent",
                    "message" => message,
                    "reasoning_content" => js::truthy(&reasoning),
                    "tool_calls" => (!calls.is_empty()).then_some(calls),
                    "metrics" => token_usage_to_metrics(token_usage_for_record(record, "").0.as_ref()),
                    "extra" => obj! {
                        "record_type" => kind,
                        "model" => file.model_name.clone(),
                        "error_message" => js::truthy(&error_message),
                    },
                });
            }
            "tool_result" => {
                let content = tool_output_text(record.get("content"));
                steps.push(obj! {
                    "timestamp" => timestamp,
                    "source" => "system",
                    "message" => if content.is_empty() { "Tool result".to_owned() } else { content.clone() },
                    "observation" => obj! { "results" => vec![Value::Object(obj! {
                        "source_call_id" => sv(record.get("tool_call_id")),
                        "content" => if content.is_empty() { "Tool result".to_owned() } else { content },
                        "extra" => obj! {
                            "tool_name" => js::truthy(sv(record.get("tool_name"))),
                            "is_error" => js::is_true(record.get("is_error")),
                        },
                    })] },
                    "extra" => obj! { "record_type" => kind },
                });
            }
            _ => {}
        }
    }
    create_trajectory("agy", file, records, steps, false)
}

/// A transcript of `agent` as an ATIF trajectory.
pub fn project_agent_trajectory(agent: &str, file: &SessionFile, records: &[Obj]) -> Value {
    match agent {
        "codex" => project_codex(file, records),
        "claude" => project_claude(file, records),
        "kimi" => project_kimi(file, records),
        "grok" => project_grok(file, records),
        "pi" | "omp" => project_pi(file, records, agent),
        "muse" => project_muse(file, records),
        "agy" => project_antigravity(file, records),
        _ => create_trajectory(agent, file, records, Vec::new(), false),
    }
}
