//! `session-tasks.ts`: the tasks a Claude transcript started (subagents,
//! teammates, workflows, background commands, monitors), and what their
//! own files say of them since.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj, sv};

const MAX_ENDED_TASKS: usize = 30;
const ENDED_KEPT_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const LOST_AFTER_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
pub const COMMAND_SILENT_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const COMMAND_SILENT_UNCHECKED_MS: f64 = 60.0 * 60.0 * 1000.0;
pub const SUBAGENT_STALE_MS: f64 = 30.0 * 60.0 * 1000.0;
const GREW_AFTER_END_MS: f64 = 2000.0;

static BACKGROUND_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:background(?:ed by user)? with ID: |moved to the background \(ID: )([A-Za-z0-9_]+)",
    )
    .unwrap()
});

fn tag(text: &str, name: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r"<{0}>([\s\S]*?)</{0}>", regex::escape(name))).unwrap();
    pattern
        .captures(text)
        .map(|c| js::trim(&c[1]).to_owned())
        .filter(|t| !t.is_empty())
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| js::sv(part.as_object().and_then(|p| p.get("text"))).to_owned())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn end_status(raw: Option<&str>) -> &'static str {
    let Some(raw) = raw else { return "completed" };
    let status = raw.to_lowercase();
    if status.contains("fail") || status.contains("error") {
        return "failed";
    }
    if status.contains("kill") || status.contains("stop") || status.contains("cancel") {
        return "stopped";
    }
    "completed"
}

fn set(task: &mut Obj, key: &str, value: impl js::IntoProp) {
    match value.into_prop() {
        Some(v) => {
            task.insert(key.to_owned(), v);
        }
        None => {
            // `task.x = undefined`: the key stays, with nothing in it.
            if task.contains_key(key) {
                task.insert(key.to_owned(), Value::Null);
                task.shift_remove(key);
            }
        }
    }
}

fn status(task: &Obj) -> &str {
    sv(task.get("status"))
}

struct Arena {
    tasks: Vec<Obj>,
}

/// The tasks a transcript's records started. `rewound` names the records
/// a rewind took back.
pub fn parse_session_tasks(records: &[Obj], rewound: Option<&HashSet<String>>) -> Vec<Value> {
    let mut arena = Arena { tasks: Vec::new() };
    // tasks: by tool call id, in insertion order.
    let mut tasks: Vec<(String, usize)> = Vec::new();
    let mut foreground: Vec<(String, usize)> = Vec::new();
    let mut called_in: HashMap<String, String> = HashMap::new();
    let mut last_message: Option<String> = None;
    let mut by_task_id: Vec<(String, usize)> = Vec::new();
    let mut idle: HashSet<usize> = HashSet::new();
    let mut teammates: HashMap<String, usize> = HashMap::new();
    let mut stops: HashMap<String, String> = HashMap::new();
    let mut sends: HashSet<String> = HashSet::new();

    fn lookup(list: &[(String, usize)], key: &str) -> Option<usize> {
        list.iter().find(|(k, _)| k == key).map(|(_, i)| *i)
    }
    fn upsert(list: &mut Vec<(String, usize)>, key: &str, index: usize) {
        match list.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = index,
            None => list.push((key.to_owned(), index)),
        }
    }

    let ended = |arena: &mut Arena,
                 idle: &mut HashSet<usize>,
                 task: usize,
                 notice: &str,
                 at: Option<&str>| {
        let status = tag(notice, "status");
        let summary = tag(notice, "summary");
        static EXIT: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)exit code (-?[0-9]+)").unwrap());
        let exit = summary
            .as_deref()
            .and_then(|s| EXIT.captures(s).map(|c| c[1].to_owned()));
        let t = &mut arena.tasks[task];
        set(t, "status", end_status(status.as_deref()));
        idle.remove(&task);
        if let Some(exit) = exit {
            let code = js::number_from_text(&exit);
            set(t, "exitCode", code);
            if code != 0.0 && status_of(t) == "completed" {
                set(t, "status", "failed");
            }
        }
        if let Some(summary) = &summary {
            set(t, "summary", js::head16(summary, 500));
        }
        let ended_at = at
            .map(str::to_owned)
            .or_else(|| t.get("endedAt").and_then(Value::as_str).map(str::to_owned));
        set(t, "endedAt", ended_at);
        let output = tag(notice, "output-file").or_else(|| {
            t.get("outputFile")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        set(t, "outputFile", output);
    };
    fn status_of(task: &Obj) -> String {
        sv(task.get("status")).to_owned()
    }

    static TEAMMATE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"<teammate-message teammate_id="([^"]+)"[^>]*>([\s\S]*?)</teammate-message>"#)
            .unwrap()
    });
    static NOTIFICATION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<task-notification>[\s\S]*?</task-notification>").unwrap());

    macro_rules! notified {
        ($text:expr, $at:expr) => {{
            let text: &str = $text;
            let at: Option<&str> = $at;
            for caps in TEAMMATE.captures_iter(text) {
                let Some(&task) = teammates.get(&caps[1]) else {
                    continue;
                };
                let Some(Value::Object(body)) = js::parse(js::trim(&caps[2])) else {
                    continue;
                };
                if sv(body.get("type")) != "idle_notification" {
                    continue;
                }
                let t = &mut arena.tasks[task];
                set(t, "status", "completed");
                idle.insert(task);
                let ended_at = at
                    .map(str::to_owned)
                    .or_else(|| t.get("endedAt").and_then(Value::as_str).map(str::to_owned));
                set(t, "endedAt", ended_at);
                let said = sv(body.get("result"));
                if !said.is_empty() {
                    set(t, "summary", js::head16(said, 500));
                }
            }
            for found in NOTIFICATION.find_iter(text) {
                let notice = found.as_str();
                let tool_use_id = tag(notice, "tool-use-id");
                let task_id = tag(notice, "task-id");
                let task = tool_use_id
                    .as_deref()
                    .and_then(|id| lookup(&tasks, id))
                    .or_else(|| task_id.as_deref().and_then(|id| lookup(&by_task_id, id)));
                if let Some(task) = task {
                    ended(&mut arena, &mut idle, task, notice, at);
                }
            }
        }};
    }

    let request_types = ["api-request", "api-request-blob", "api-request-shape"];
    for (index, record) in records.iter().enumerate() {
        if let Some(Value::String(kind)) = record.get("type")
            && request_types.contains(&kind.as_str())
        {
            continue;
        }
        let at_owned = js::truthy(sv(record.get("timestamp"))).map(str::to_owned);
        let at = at_owned.as_deref();
        let is_rewound = match record.get("uuid") {
            Some(Value::String(uuid)) => rewound.is_some_and(|r| r.contains(uuid)),
            _ => false,
        };
        let attachment = js::rec(record.get("attachment"));
        if let Some(attachment) = attachment
            && sv(attachment.get("type")) == "queued_command"
        {
            notified!(&content_text(attachment.get("prompt")), at);
        }
        let Some(message) = js::rec(record.get("message")) else {
            continue;
        };
        let message_id =
            if sv(record.get("type")) == "assistant" && !js::is_true(record.get("isSidechain")) {
                js::truthy(sv(message.get("id")))
                    .or_else(|| js::truthy(sv(record.get("uuid"))))
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("#{index}"))
            } else {
                String::new()
            };
        if !message_id.is_empty() {
            last_message = Some(message_id.clone());
        }
        if let Some(Value::String(content)) = message.get("content") {
            notified!(content, at);
            continue;
        }
        let Some(Value::Array(parts)) = message.get("content") else {
            continue;
        };
        for part in parts {
            let Some(part) = part.as_object() else {
                continue;
            };
            let part_type = sv(part.get("type"));
            if part_type == "text"
                && let Some(Value::String(text)) = part.get("text")
            {
                notified!(text, at);
            }
            if part_type == "tool_use" {
                let id = sv(part.get("id")).to_owned();
                let name = sv(part.get("name"));
                let empty = Obj::new();
                let input = js::rec(part.get("input")).unwrap_or(&empty);
                let description = sv(input.get("description"));
                if id.is_empty() {
                    continue;
                }
                if matches!(name, "TaskStop" | "KillShell" | "KillBash") {
                    let target =
                        js::truthy(sv(input.get("task_id"))).unwrap_or(sv(input.get("shell_id")));
                    if !target.is_empty() {
                        stops.insert(id, target.to_owned());
                    }
                    continue;
                }
                if name == "SendMessage" {
                    sends.insert(id);
                    if let Some(&teammate) = teammates.get(sv(input.get("to")))
                        && idle.contains(&teammate)
                    {
                        let t = &mut arena.tasks[teammate];
                        set(t, "status", "running");
                        idle.remove(&teammate);
                        t.shift_remove("endedAt");
                    }
                    continue;
                }
                let command = sv(input.get("command"));
                let detail = js::truthy(&js::head16(command, 2000)).map(str::to_owned);
                let title_of = |fallback: String| {
                    js::truthy(description)
                        .map(str::to_owned)
                        .unwrap_or(fallback)
                };
                let mut started: Option<Obj> = None;
                if name == "Agent" || name == "Task" {
                    let teammate = sv(input.get("name"));
                    let title = js::truthy(description)
                        .or(js::truthy(teammate))
                        .unwrap_or("Subagent")
                        .to_owned();
                    started = Some(obj! {
                        "id" => id.clone(),
                        "kind" => if teammate.is_empty() { "agent" } else { "teammate" },
                        "title" => title,
                        "detail" => js::truthy(sv(input.get("subagent_type"))),
                        "name" => js::truthy(teammate),
                        "status" => "running",
                        "startedAt" => at,
                    });
                    if !teammate.is_empty() {
                        let teammate = teammate.to_owned();
                        let index = push_task(&mut arena, &mut tasks, &id, started.take().unwrap());
                        teammates.insert(teammate, index);
                    }
                } else if name == "Workflow" {
                    started = Some(obj! {
                        "id" => id.clone(),
                        "kind" => "workflow",
                        "title" => title_of(js::truthy(sv(input.get("name"))).unwrap_or("Workflow").to_owned()),
                        "status" => "running",
                        "startedAt" => at,
                    });
                } else if name == "Bash" && js::is_true(input.get("run_in_background")) {
                    started = Some(obj! {
                        "id" => id.clone(),
                        "kind" => "command",
                        "title" => title_of(js::head16(command, 120)),
                        "detail" => detail.clone(),
                        "status" => "running",
                        "startedAt" => at,
                    });
                } else if name == "Bash" {
                    let task = obj! {
                        "id" => id.clone(),
                        "kind" => "command",
                        "title" => title_of(js::head16(command, 120)),
                        "detail" => detail.clone(),
                        "status" => "running",
                        "startedAt" => at,
                        "rewound" => is_rewound.then_some(true),
                    };
                    arena.tasks.push(task);
                    let index = arena.tasks.len() - 1;
                    upsert(&mut foreground, &id, index);
                    called_in.insert(id.clone(), message_id.clone());
                } else if name == "Monitor" {
                    started = Some(obj! {
                        "id" => id.clone(),
                        "kind" => "monitor",
                        "title" => js::truthy(description).unwrap_or("Monitor"),
                        "detail" => detail.clone(),
                        "status" => "running",
                        "startedAt" => at,
                    });
                }
                if let Some(task) = started {
                    push_task(&mut arena, &mut tasks, &id, task);
                }
                if is_rewound && let Some(index) = lookup(&tasks, &id) {
                    set(&mut arena.tasks[index], "rewound", true);
                }
            }
            if part_type == "tool_result" {
                let use_id = sv(part.get("tool_use_id")).to_owned();
                if let Some(stopped) = stops.get(&use_id) {
                    if let Some(target) = lookup(&by_task_id, stopped)
                        && status(&arena.tasks[target]) == "running"
                        && !js::is_true(part.get("is_error"))
                    {
                        let t = &mut arena.tasks[target];
                        set(t, "status", "stopped");
                        set(t, "endedAt", at);
                    }
                    continue;
                }
                let empty = Obj::new();
                let result = js::rec(record.get("toolUseResult")).unwrap_or(&empty);
                if sends.contains(&use_id) {
                    if js::is_true(part.get("is_error")) {
                        continue;
                    }
                    static RESUMED: LazyLock<Regex> = LazyLock::new(|| {
                        Regex::new(r#""resumedAgentId"\s*:\s*"([A-Za-z0-9_-]+)""#).unwrap()
                    });
                    static RESUMING: LazyLock<Regex> =
                        LazyLock::new(|| Regex::new(r"Resuming agent ([A-Za-z0-9_-]+)").unwrap());
                    let text = content_text(part.get("content"));
                    let resumed = js::truthy(sv(result.get("resumedAgentId")))
                        .or(js::truthy(sv(result.get("revivedAgentId"))))
                        .map(str::to_owned)
                        .or_else(|| RESUMED.captures(&text).map(|c| c[1].to_owned()))
                        .or_else(|| RESUMING.captures(&text).map(|c| c[1].to_owned()))
                        .filter(|r| !r.is_empty());
                    let task = resumed.as_deref().and_then(|id| {
                        if let Some(exact) = lookup(&by_task_id, id) {
                            return Some(exact);
                        }
                        if js::len16(id) < 7 {
                            return None;
                        }
                        by_task_id
                            .iter()
                            .find(|(key, task)| {
                                arena.tasks[*task].get("agentId").and_then(Value::as_str)
                                    == Some(key.as_str())
                                    && key.starts_with(id)
                            })
                            .map(|(_, task)| *task)
                    });
                    if let Some(task) = task
                        && status(&arena.tasks[task]) != "running"
                    {
                        let t = &mut arena.tasks[task];
                        set(t, "status", "running");
                        set(t, "resumedAt", at);
                        idle.remove(&task);
                        t.shift_remove("endedAt");
                        t.shift_remove("exitCode");
                    }
                    continue;
                }
                let text = content_text(part.get("content"));
                static TASK_ID: LazyLock<Regex> =
                    LazyLock::new(|| Regex::new(r"Task ID: ([A-Za-z0-9_]+)").unwrap());
                static AGENT_ID: LazyLock<Regex> =
                    LazyLock::new(|| Regex::new(r"agentId: ([A-Za-z0-9_]+)").unwrap());
                static OUTPUT: LazyLock<Regex> = LazyLock::new(|| {
                    Regex::new(r"Output is being written to: (\S+?)\.?(?:\s|$)").unwrap()
                });
                let task_id = js::truthy(sv(result.get("backgroundTaskId")))
                    .or(js::truthy(sv(result.get("taskId"))))
                    .map(str::to_owned)
                    .or_else(|| BACKGROUND_ID.captures(&text).map(|c| c[1].to_owned()))
                    .or_else(|| TASK_ID.captures(&text).map(|c| c[1].to_owned()))
                    .filter(|t| !t.is_empty());
                let mut task = lookup(&tasks, &use_id);
                let moved = lookup(&foreground, &use_id);
                foreground.retain(|(k, _)| *k != use_id);
                if task.is_none()
                    && let Some(moved) = moved
                    && task_id.is_some()
                    && !js::is_true(part.get("is_error"))
                {
                    upsert(&mut tasks, &use_id, moved);
                    task = Some(moved);
                }
                let Some(task) = task else { continue };
                let agent_id = js::truthy(sv(result.get("agentId")))
                    .map(str::to_owned)
                    .or_else(|| AGENT_ID.captures(&text).map(|c| c[1].to_owned()))
                    .filter(|a| !a.is_empty());
                if let Some(task_id) = &task_id {
                    set(&mut arena.tasks[task], "taskId", task_id.as_str());
                    upsert(&mut by_task_id, task_id, task);
                }
                if let Some(agent_id) = &agent_id {
                    set(&mut arena.tasks[task], "agentId", agent_id.as_str());
                    upsert(&mut by_task_id, agent_id, task);
                }
                let t = &mut arena.tasks[task];
                let run_id = sv(result.get("runId"));
                if !run_id.is_empty() {
                    set(t, "runId", run_id);
                    let title = js::truthy(sv(result.get("summary")))
                        .or(js::truthy(sv(result.get("workflowName"))))
                        .map(str::to_owned)
                        .unwrap_or_else(|| sv(t.get("title")).to_owned());
                    set(t, "title", title);
                    let detail = js::truthy(sv(result.get("workflowName")))
                        .map(str::to_owned)
                        .or_else(|| t.get("detail").and_then(Value::as_str).map(str::to_owned));
                    set(t, "detail", detail);
                }
                let output = js::truthy(sv(result.get("outputFile")))
                    .map(str::to_owned)
                    .or_else(|| OUTPUT.captures(&text).map(|c| c[1].to_owned()))
                    .filter(|o| !o.is_empty())
                    .or_else(|| {
                        t.get("outputFile")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    });
                set(t, "outputFile", output);
                let refused = matches!(record.get("toolUseResult"), Some(Value::String(s)) if s.starts_with("Error:"));
                let kind = sv(t.get("kind")).to_owned();
                if js::is_true(part.get("is_error")) || (refused && task_id.is_none()) {
                    set(t, "status", "failed");
                    let raw = if text.is_empty() {
                        record
                            .get("toolUseResult")
                            .map_or("undefined".into(), js::to_text)
                    } else {
                        text.clone()
                    };
                    set(t, "summary", js::head16(&raw, 500));
                    set(t, "endedAt", at);
                } else if (kind == "agent" || kind == "teammate")
                    && !js::is_true(result.get("isAsync"))
                    && sv(result.get("status")) != "async_launched"
                    && sv(result.get("status")) != "teammate_spawned"
                {
                    set(t, "status", "completed");
                    set(t, "summary", js::head16(&text, 500));
                    set(t, "endedAt", at);
                }
            }
        }
    }
    let mut latest = f64::NAN;
    for record in records.iter().rev() {
        if latest.is_finite() {
            break;
        }
        latest = js::date_parse(sv(record.get("timestamp")));
    }
    let mut running: Vec<usize> = Vec::new();
    let mut done: Vec<usize> = Vec::new();
    let mut lost_at: HashMap<usize, f64> = HashMap::new();
    for &(_, task) in &tasks {
        let t = &arena.tasks[task];
        let since = t
            .get("resumedAt")
            .and_then(Value::as_str)
            .or(t.get("startedAt").and_then(Value::as_str));
        let started = since.map_or(f64::NAN, js::date_parse);
        let old = started.is_finite() && latest.is_finite() && latest - started > LOST_AFTER_MS;
        if status(t) == "running" && old {
            lost_at.insert(task, started + LOST_AFTER_MS);
            let t = &mut arena.tasks[task];
            set(t, "status", "lost");
            set(
                t,
                "summary",
                "No end notice a day later: it probably ended with its session.",
            );
        }
        let t = &arena.tasks[task];
        if js::is_true(t.get("rewound"))
            && status(t) != "running"
            && !(idle.contains(&task) && !old)
        {
            continue;
        }
        if status(t) == "running" || idle.contains(&task) {
            running.push(task);
        } else {
            done.push(task);
        }
    }
    let recent: Vec<usize> = done
        .into_iter()
        .filter(|task| {
            let t = &arena.tasks[*task];
            let at = lost_at.get(task).copied().unwrap_or_else(|| {
                let when = t
                    .get("endedAt")
                    .and_then(Value::as_str)
                    .or(t.get("startedAt").and_then(Value::as_str))
                    .unwrap_or("");
                js::date_parse(when)
            });
            !at.is_finite() || !latest.is_finite() || latest - at <= ENDED_KEPT_MS
        })
        .collect();
    let recent = &recent[recent.len().saturating_sub(MAX_ENDED_TASKS)..];
    let kept: HashSet<usize> = running.iter().chain(recent.iter()).copied().collect();
    let mut seen_index = HashSet::new();
    let listed: Vec<usize> = tasks
        .iter()
        .map(|(_, t)| *t)
        .filter(|t| kept.contains(t) && seen_index.insert(*t))
        .collect();
    let mut out: Vec<Value> = Vec::new();
    if let Some(last) = &last_message {
        for (id, task) in &foreground {
            let t = &arena.tasks[*task];
            if !js::is_true(t.get("rewound")) && called_in.get(id) == Some(last) {
                let mut copy = t.clone();
                copy.insert("foreground".into(), Value::Bool(true));
                out.push(Value::Object(copy));
            }
        }
    }
    for task in listed.into_iter().rev() {
        out.push(Value::Object(arena.tasks[task].clone()));
    }
    out
}

fn push_task(arena: &mut Arena, tasks: &mut Vec<(String, usize)>, id: &str, task: Obj) -> usize {
    arena.tasks.push(task);
    let index = arena.tasks.len() - 1;
    match tasks.iter_mut().find(|(k, _)| k == id) {
        Some(entry) => entry.1 = index,
        None => tasks.push((id.to_owned(), index)),
    }
    index
}

fn started_ms(task: &Obj) -> f64 {
    let when = task
        .get("resumedAt")
        .and_then(Value::as_str)
        .or(task.get("startedAt").and_then(Value::as_str))
        .unwrap_or("");
    js::date_parse(when)
}

/// The output files of running commands silent long enough to look at.
pub fn command_outputs_to_watch(tasks: &[Value], now: f64) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for task in tasks.iter().filter_map(Value::as_object) {
        if sv(task.get("kind")) != "command" || status(task) != "running" {
            continue;
        }
        let Some(output) = js::truthy(sv(task.get("outputFile"))) else {
            continue;
        };
        let started = started_ms(task);
        if started.is_finite() && now - started < COMMAND_SILENT_MS {
            continue;
        }
        if !paths.iter().any(|p| p == output) {
            paths.push(output.to_owned());
        }
    }
    paths
}

/// Running commands silent past the limit that no process holds open are
/// taken as lost. `held` answers Some(true/false) or None (cannot tell).
pub fn with_command_activity(
    tasks: &[Value],
    activity: &HashMap<String, Option<f64>>,
    now: f64,
    held: &dyn Fn(&str) -> Option<bool>,
) -> Vec<Value> {
    tasks
        .iter()
        .map(|value| {
            let Some(task) = value.as_object() else {
                return value.clone();
            };
            if sv(task.get("kind")) != "command" || status(task) != "running" {
                return value.clone();
            }
            let Some(output) = js::truthy(sv(task.get("outputFile"))) else {
                return value.clone();
            };
            let Some(Some(mtime)) = activity.get(output).copied() else {
                return value.clone();
            };
            if !mtime.is_finite() {
                return value.clone();
            }
            let silent = now - mtime;
            if silent < COMMAND_SILENT_MS {
                return value.clone();
            }
            let open = held(output);
            if open == Some(true) || (open.is_none() && silent < COMMAND_SILENT_UNCHECKED_MS) {
                return value.clone();
            }
            let minutes = (silent / 60_000.0).round();
            let mut copy = task.clone();
            copy.insert("status".into(), Value::String("lost".into()));
            copy.insert("endedAt".into(), Value::String(js::iso(mtime)));
            copy.insert(
                "summary".into(),
                Value::String(format!(
                    "No output for {} minutes and no process writes it: it ended without a result.",
                    js::number_text(minutes)
                )),
            );
            Value::Object(copy)
        })
        .collect()
}

/// The subagents whose own conversation tells more than the transcript.
pub fn subagents_to_watch(tasks: &[Value], now: f64, limit: usize) -> Vec<String> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
    let mut ids = Vec::new();
    let mut ended: Vec<(String, f64)> = Vec::new();
    for task in tasks.iter().filter_map(Value::as_object) {
        let kind = sv(task.get("kind"));
        if kind != "agent" && kind != "teammate" {
            continue;
        }
        let Some(agent_id) = js::truthy(sv(task.get("agentId"))) else {
            continue;
        };
        if !ID.is_match(agent_id) {
            continue;
        }
        if status(task) == "running" {
            if js::truthy(sv(task.get("resumedAt"))).is_some() {
                ids.push(agent_id.to_owned());
            }
            continue;
        }
        let when = task
            .get("endedAt")
            .and_then(Value::as_str)
            .or(task.get("startedAt").and_then(Value::as_str))
            .unwrap_or("");
        let at = js::date_parse(when);
        if at.is_finite() && now - at < LOST_AFTER_MS {
            ended.push((agent_id.to_owned(), at));
        }
    }
    ended.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ids.extend(ended.into_iter().take(limit).map(|(id, _)| id));
    ids
}

/// The tasks with what their subagents' conversations say.
pub fn with_subagent_activity(
    tasks: &[Value],
    activity: &HashMap<String, Option<f64>>,
    now: f64,
) -> Vec<Value> {
    tasks
        .iter()
        .map(|value| {
            let Some(task) = value.as_object() else {
                return value.clone();
            };
            let file = js::truthy(sv(task.get("agentId"))).and_then(|id| activity.get(id).copied());
            let Some(Some(mtime)) = file else {
                return value.clone();
            };
            if !mtime.is_finite() {
                return value.clone();
            }
            let fresh = now - mtime < SUBAGENT_STALE_MS;
            if status(task) == "running" {
                let Some(resumed_at) = js::truthy(sv(task.get("resumedAt"))) else {
                    return value.clone();
                };
                let resumed = js::date_parse(resumed_at);
                let last = if resumed.is_nan() {
                    f64::NAN
                } else {
                    mtime.max(resumed)
                };
                if !last.is_finite() || now - last < SUBAGENT_STALE_MS {
                    return value.clone();
                }
                let mut copy = task.clone();
                copy.insert("status".into(), Value::String("completed".into()));
                copy.insert("endedAt".into(), Value::String(js::iso(last)));
                copy.insert(
                    "summary".into(),
                    Value::String(format!(
                        "No activity for {} minutes after it was resumed: taken as done.",
                        js::number_text(SUBAGENT_STALE_MS / 60_000.0)
                    )),
                );
                return Value::Object(copy);
            }
            let ended = js::date_parse(sv(task.get("endedAt")));
            let grew = ended.is_finite() && mtime > ended + GREW_AFTER_END_MS;
            if !grew || !fresh {
                return value.clone();
            }
            let mut copy = task.clone();
            copy.insert("status".into(), Value::String("running".into()));
            match task.get("endedAt") {
                Some(at) => copy.insert("resumedAt".into(), at.clone()),
                None => copy.shift_remove("resumedAt"),
            };
            copy.shift_remove("endedAt");
            copy.shift_remove("exitCode");
            Value::Object(copy)
        })
        .collect()
}
