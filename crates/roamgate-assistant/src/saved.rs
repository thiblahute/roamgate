//! The validators of Ranger's saved tasks (`assistant/tasks.ts`:
//! `validateTaskInput`, `validateSavedTasks` and their helpers). A saved
//! state is the JavaScript value Bun keeps (`{tasks, proposals, requests}`,
//! keys in insertion order), so what one side saves the other reads.

use std::collections::HashSet;

use roamgate_agents::js;
use serde_json::{Map, Value};

use crate::errors::AssistantError;
use crate::task_schedule::validate_task_schedule;
use crate::wire::{
    ASSISTANT_MAX_MENTIONS, ASSISTANT_MAX_WORKSPACES, is_hex64, is_mention_target,
    is_thinking_level, is_uuid,
};

pub const MAX_TASK_STATE_BYTES: usize = 32_000_000;
pub const MAX_TASKS: usize = 50;
pub const MAX_RUNS: usize = 20;
pub const MAX_PROPOSALS: usize = 50;
pub const MAX_NOTIFICATIONS: usize = 100;

pub const UNFINISHED: [&str; 3] = ["queued", "running", "waiting"];
const RUN_STATUSES: [&str; 6] = [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "stopped",
];

/// `String(value)`, `"undefined"` for a missing one.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => js::to_text(other),
    }
}

/// `${ref.connection_id}\0${ref.workspace_id}`.
pub fn ref_key(value: &Value) -> String {
    format!(
        "{}\0{}",
        js_string(value.get("connection_id")),
        js_string(value.get("workspace_id"))
    )
}

/// `UUID.test(value)` (the value as a string).
fn uuid(value: Option<&Value>) -> bool {
    is_uuid(&js_string(value))
}

/// `Number.isFinite(Date.parse(value))`.
fn date(value: Option<&Value>) -> bool {
    js::date_parse(&js_string(value)).is_finite()
}

fn invalid_input() -> AssistantError {
    AssistantError::user("Invalid task input")
}

fn text(value: Option<&Value>, limit: usize) -> Result<Value, AssistantError> {
    match value {
        Some(Value::String(text)) if !js::trim(text).is_empty() && js::len16(text) <= limit => {
            Ok(Value::String(text.clone()))
        }
        _ => Err(invalid_input()),
    }
}

/// `validateTaskInput`: the fields a task may have, in Bun's order.
pub fn validate_task_input(value: &Value) -> Result<Value, AssistantError> {
    const FIELDS: [&str; 7] = [
        "title",
        "prompt",
        "scope",
        "schedule",
        "notification_mode",
        "mentions",
        "all_workspaces",
    ];
    let Some(map) = value.as_object() else {
        return Err(invalid_input());
    };
    let scope_list = map.get("scope").and_then(Value::as_array);
    if map.keys().any(|field| !FIELDS.contains(&field.as_str()))
        || map
            .get("all_workspaces")
            .is_some_and(|v| v != &Value::Bool(true))
        || map
            .get("notification_mode")
            .is_some_and(|v| v != "status" && v != "agent")
        || scope_list.is_none_or(|scope| scope.is_empty() || scope.len() > ASSISTANT_MAX_WORKSPACES)
    {
        return Err(invalid_input());
    }
    let mut scope = Vec::new();
    for entry in scope_list.unwrap() {
        let Some(entry) = entry.as_object() else {
            return Err(AssistantError::user("Invalid task scope"));
        };
        if entry
            .keys()
            .any(|field| field != "connection_id" && field != "workspace_id")
        {
            return Err(AssistantError::user("Invalid task scope"));
        }
        let mut item = Map::new();
        item.insert(
            "connection_id".into(),
            text(entry.get("connection_id"), 500)?,
        );
        item.insert("workspace_id".into(), text(entry.get("workspace_id"), 500)?);
        scope.push(Value::Object(item));
    }
    let keys: HashSet<String> = scope.iter().map(ref_key).collect();
    if keys.len() != scope.len() {
        return Err(AssistantError::user("Duplicate task scope"));
    }
    let mut mentions = None;
    if let Some(value) = map.get("mentions") {
        let Some(list) = value.as_array().filter(|list| {
            list.len() <= ASSISTANT_MAX_MENTIONS && list.iter().all(is_mention_target)
        }) else {
            return Err(AssistantError::user("Invalid task mentions"));
        };
        if list.iter().any(|mention| !keys.contains(&ref_key(mention))) {
            return Err(AssistantError::user("Task mention outside task scope"));
        }
        let identities: Vec<String> = list.iter().map(mention_identity).collect();
        if identities.iter().collect::<HashSet<_>>().len() != identities.len() {
            return Err(AssistantError::user("Duplicate task mention"));
        }
        mentions = Some(value.clone());
    }
    let mut result = Map::new();
    result.insert("title".into(), text(map.get("title"), 100)?);
    result.insert("prompt".into(), text(map.get("prompt"), 32_000)?);
    result.insert("scope".into(), Value::Array(scope));
    result.insert(
        "schedule".into(),
        validate_task_schedule(map.get("schedule").unwrap_or(&Value::Null))?,
    );
    if let Some(mode) = map.get("notification_mode") {
        result.insert("notification_mode".into(), mode.clone());
    }
    if let Some(mentions) = mentions {
        result.insert("mentions".into(), mentions);
    }
    if map.get("all_workspaces") == Some(&Value::Bool(true)) {
        result.insert("all_workspaces".into(), Value::Bool(true));
    }
    Ok(Value::Object(result))
}

/// A mention's identity within a task (two of the same are refused).
fn mention_identity(mention: &Value) -> String {
    let mut parts = vec![
        mention.get("kind").cloned().unwrap_or(Value::Null),
        mention.get("connection_id").cloned().unwrap_or(Value::Null),
        mention.get("workspace_id").cloned().unwrap_or(Value::Null),
    ];
    if mention.get("kind") == Some(&Value::from("agent")) {
        parts.push(mention.get("pane_id").cloned().unwrap_or(Value::Null));
        parts.push(mention.get("terminal_id").cloned().unwrap_or(Value::Null));
    }
    js::stringify(&Value::Array(parts))
}

fn valid_notification_input(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    matches!(
        map.get("kind").and_then(Value::as_str),
        Some("completed" | "attention")
    ) && [("event_key", 200), ("title", 200), ("body", 400)]
        .iter()
        .all(|(key, limit)| {
            map.get(*key)
                .and_then(Value::as_str)
                .is_some_and(|t| !js::trim(t).is_empty() && js::len16(t) <= *limit)
        })
}

/// A notification's custom content (`validNotificationInput`).
pub fn is_notification_input(value: &Value) -> bool {
    valid_notification_input(value)
}

fn valid_notifications(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Some(list) = value.as_array() else {
        return false;
    };
    list.len() <= MAX_NOTIFICATIONS
        && list.iter().all(|notification| {
            notification.is_object()
                && valid_notification_input(notification)
                && notification
                    .get("run_id")
                    .and_then(Value::as_str)
                    .is_some_and(is_uuid)
                && notification
                    .get("created_at")
                    .and_then(Value::as_str)
                    .is_some_and(|t| js::date_parse(t).is_finite())
                && notification
                    .get("scope_key")
                    .and_then(Value::as_str)
                    .is_some_and(is_hex64)
        })
        && list
            .iter()
            .map(|n| {
                js::stringify(&Value::Array(vec![
                    n.get("scope_key").cloned().unwrap_or(Value::Null),
                    n.get("event_key").cloned().unwrap_or(Value::Null),
                ]))
            })
            .collect::<HashSet<_>>()
            .len()
            == list.len()
}

/// The keys of a list of references, and whether they are all distinct
/// and of the scope.
fn same_refs(list: Option<&Value>, refs: &HashSet<String>) -> Option<Vec<Value>> {
    let list = list?.as_array()?;
    let keys: HashSet<String> = list.iter().map(ref_key).collect();
    (list.len() == refs.len() && keys.len() == refs.len()).then(|| list.clone())
}

/// `validPrepared`: a task's input with the permission it was admitted
/// under, one entry per workspace of its scope.
pub fn valid_prepared(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(config) = map.get("config").and_then(Value::as_object) else {
        return false;
    };
    let Ok(input) = validate_task_input(map.get("input").unwrap_or(&Value::Null)) else {
        return false;
    };
    let refs: HashSet<String> = input["scope"]
        .as_array()
        .unwrap()
        .iter()
        .map(ref_key)
        .collect();
    let nonempty = |key: &str| {
        config
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|t| !t.is_empty())
    };
    nonempty("provider")
        && nonempty("model")
        && config.get("thinking_level").is_none_or(is_thinking_level)
        && matches!(
            js_string(config.get("credential_source")).as_str(),
            "assistant" | "pi"
        )
        && config
            .get("approval_mode")
            .is_none_or(|mode| mode == "manual" || mode == "auto")
        && same_refs(config.get("allowed_workspaces"), &refs).is_some_and(|list| {
            list.iter()
                .all(|r| r.is_object() && refs.contains(&ref_key(r)))
        })
        && same_refs(map.get("workspaces"), &refs).is_some_and(|list| {
            list.iter().all(|r| {
                r.is_object()
                    && refs.contains(&ref_key(r))
                    && r.get("label").is_some_and(Value::is_string)
                    && r.get("connection_label").is_some_and(Value::is_string)
                    && r.get("runtime_generation")
                        .and_then(Value::as_f64)
                        .is_some_and(|g| js::is_safe_integer(g) && g >= 0.0)
            })
        })
        && same_refs(map.get("targets"), &refs).is_some_and(|list| {
            list.iter().all(|t| {
                t.is_object()
                    && refs.contains(&ref_key(t))
                    && t.get("endpoint_fingerprint")
                        .and_then(Value::as_str)
                        .is_some_and(is_hex64)
                    && t.get("workspace_identity")
                        .and_then(Value::as_str)
                        .is_some_and(is_hex64)
                    && t.get("herdr_boot_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty() && js::len16(id) <= 500)
            })
        })
}

/// `{...input, notification_mode: input.notification_mode ?? "status"}`
/// as JSON text.
fn with_default_mode(mut input: Value) -> String {
    let map = input.as_object_mut().unwrap();
    if !map.contains_key("notification_mode") {
        map.insert("notification_mode".into(), Value::from("status"));
    }
    js::stringify(&input)
}

fn valid_saved_proposal(entry: &Value) -> bool {
    let proposal = entry.get("proposal").unwrap_or(&Value::Null);
    if let Some(detail) = proposal.get("detail")
        && detail.as_str().is_none_or(|d| js::len16(d) > 2000)
    {
        return false;
    }
    if let Some(operation) = proposal.get("operation") {
        let known = operation.as_str().is_some_and(|op| {
            ["create", "update", "pause", "resume", "cancel", "delete"].contains(&op)
        });
        let task_id = match proposal.get("task_id") {
            None | Some(Value::Null) => String::new(),
            Some(other) => js_string(Some(other)),
        };
        if !known || (operation != "create" && !is_uuid(&task_id)) {
            return false;
        }
    }
    let mut fields = Map::new();
    for key in ["title", "prompt", "scope", "schedule"] {
        if let Some(value) = proposal.get(key) {
            fields.insert(key.into(), value.clone());
        }
    }
    for key in ["notification_mode", "mentions"] {
        if let Some(value) = proposal.get(key) {
            fields.insert(key.into(), value.clone());
        }
    }
    let Ok(input) = validate_task_input(&Value::Object(fields)) else {
        return false;
    };
    let prepared_input = entry
        .get("prepared")
        .and_then(|p| p.get("input"))
        .unwrap_or(&Value::Null);
    let Ok(expected) = validate_task_input(prepared_input) else {
        return false;
    };
    with_default_mode(input) == with_default_mode(expected)
}

fn valid_run(run: &Value, task_id: Option<&Value>) -> bool {
    let status = js_string(run.get("status"));
    (!UNFINISHED.contains(&status.as_str()) || valid_prepared(run))
        && uuid(run.get("id"))
        && run.get("task_id") == task_id
        && RUN_STATUSES.contains(&status.as_str())
        && run.get("manual").is_some_and(Value::is_boolean)
        && date(run.get("scheduled_at"))
        && ["started_at", "finished_at"]
            .iter()
            .all(|key| run.get(*key).is_none() || date(run.get(*key)))
        && run
            .get("error")
            .is_some_and(|error| error.is_null() || error.is_string())
        && run.get("notice").is_none_or(Value::is_string)
}

fn valid_task_entry(entry: &Value) -> bool {
    let task = entry.get("task");
    let runs = entry.get("runs").and_then(Value::as_array);
    valid_prepared(entry)
        && valid_notifications(entry.get("notifications"))
        && uuid(task.and_then(|t| t.get("id")))
        && task.is_some_and(|task| {
            ["active", "paused", "cancelled"].contains(&js_string(task.get("status")).as_str())
                && date(task.get("created_at"))
                && date(task.get("updated_at"))
                && (task.get("next_run_at") == Some(&Value::Null) || date(task.get("next_run_at")))
        })
        && runs.is_some_and(|runs| {
            let task_id = task.and_then(|t| t.get("id"));
            runs.len() <= MAX_RUNS
                && runs.iter().all(|run| valid_run(run, task_id))
                && runs
                    .iter()
                    .filter(|run| UNFINISHED.contains(&js_string(run.get("status")).as_str()))
                    .count()
                    <= 1
        })
}

/// `validateSavedTasks`: the whole state, or an error naming what is wrong.
pub fn validate_saved_tasks(saved: &Value) -> Result<(), String> {
    if js::stringify(saved).len() > MAX_TASK_STATE_BYTES {
        return Err("Saved tasks are too large".into());
    }
    let invalid = || Err("Invalid saved tasks".to_owned());
    let Some(map) = saved.as_object() else {
        return invalid();
    };
    let Some(tasks) = map.get("tasks").and_then(Value::as_array) else {
        return invalid();
    };
    if tasks.len() > MAX_TASKS || !tasks.iter().all(valid_task_entry) {
        return invalid();
    }
    let ids: HashSet<String> = tasks
        .iter()
        .map(|entry| js_string(entry.get("task").and_then(|t| t.get("id"))))
        .collect();
    if ids.len() != tasks.len() {
        return invalid();
    }
    let Some(proposals) = map.get("proposals").and_then(Value::as_array) else {
        return invalid();
    };
    if proposals.len() > MAX_PROPOSALS
        || !proposals.iter().all(|entry| {
            valid_prepared(entry.get("prepared").unwrap_or(&Value::Null))
                && valid_saved_proposal(entry)
                && uuid(entry.get("proposal").and_then(|p| p.get("id")))
                && ["pending", "confirmed", "cancelled"].contains(
                    &js_string(entry.get("proposal").and_then(|p| p.get("status"))).as_str(),
                )
        })
    {
        return invalid();
    }
    let Some(requests) = map.get("requests").and_then(Value::as_array) else {
        return invalid();
    };
    if requests.len() > 1000
        || !requests.iter().all(|request| {
            request
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| js::len16(id) <= 500)
                && uuid(request.get("task_id"))
        })
    {
        return invalid();
    }
    let runs: Vec<&Value> = tasks
        .iter()
        .flat_map(|entry| entry["runs"].as_array().unwrap().iter())
        .collect();
    if runs
        .iter()
        .filter(|run| run.get("status") == Some(&Value::from("running")))
        .count()
        > 1
    {
        return Err("Multiple saved task runs".into());
    }
    let run_ids: HashSet<String> = runs.iter().map(|run| js_string(run.get("id"))).collect();
    if run_ids.len() != runs.len() {
        return Err("Duplicate saved task run".into());
    }
    Ok(())
}
