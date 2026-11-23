//! What one notification says (notifications/web-push.ts `taskPushPayload`
//! and `notificationPreference`, and the feed's `groupOf`, `kindOf` and
//! `notificationPath`): the message a device's service worker renders and
//! the feed keeps, built once for every sink.
//!
//! A notification is a JSON object as the Bun server hands it on: a task
//! (`PushTask`: `kind`, `connectionId`, `runtimeGeneration`, labels and ids)
//! or a Ranger task's (`task_id`, `run_id`, `status`, `title`, `body`).
//! Absent and `null` fields are alike, as JavaScript's `??` reads them.

use roamgate_base::log::slice_utf16;
use roamgate_base::settings::js_trim;
use serde_json::{Map, Value, json};

/// A field that is there (not absent, not null).
fn field<'a>(task: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    task.get(name).filter(|value| !value.is_null())
}

fn text<'a>(task: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    field(task, name).and_then(Value::as_str)
}

/// A Ranger task's notification (`"task_id" in task`).
pub fn is_ranger(task: &Map<String, Value>) -> bool {
    task.contains_key("task_id")
}

/// `JSON.stringify(value)` for the arrays and objects built here.
pub fn stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The text of a string, a number or a boolean as JavaScript's template
/// literals write it (`String(value)`), for the ids a task carries.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// JavaScript's truthiness of a value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `value?.trim()`, when the field is a string.
fn trimmed<'a>(task: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    text(task, name).map(js_trim)
}

/// The JSON message the service worker renders for one device delivery.
/// `path` is the page path a click opens when it is not the task's pane (a
/// work item's `/#roamgate-work=ID`).
pub fn task_push_payload(task: &Map<String, Value>, path: Option<&str>) -> Map<String, Value> {
    let mut payload = Map::new();
    if is_ranger(task) {
        let task_id = field(task, "task_id").cloned().unwrap_or(Value::Null);
        let run_id = field(task, "run_id").cloned().unwrap_or(Value::Null);
        payload.insert(
            "title".into(),
            field(task, "title").cloned().unwrap_or(Value::Null),
        );
        payload.insert(
            "body".into(),
            field(task, "body").cloned().unwrap_or(Value::Null),
        );
        payload.insert(
            "tag".into(),
            Value::String(stringify(&json!(["roamgate-ranger-task", task_id, run_id]))),
        );
        payload.insert(
            "target".into(),
            json!({ "type": "ranger_task", "taskId": task_id, "runId": run_id }),
        );
    } else {
        let connection_id = field(task, "connectionId").cloned().unwrap_or(Value::Null);
        let generation = field(task, "runtimeGeneration")
            .cloned()
            .unwrap_or(Value::Null);
        let target = if truthy(field(task, "workspaceId")) && truthy(field(task, "paneId")) {
            json!({
                "connectionId": connection_id,
                "runtimeGeneration": generation,
                "workspaceId": field(task, "workspaceId"),
                "paneId": field(task, "paneId"),
            })
        } else {
            Value::Null
        };
        // Status-derived tasks carry labels resolved by the runtime, with
        // ID fallbacks.
        let or = |label: Option<&str>, id: &str| -> Option<String> {
            match label {
                Some(label) if !label.is_empty() => Some(label.to_owned()),
                _ => text(task, id).map(str::to_owned),
            }
        };
        let tab = match trimmed(task, "tabLabel") {
            Some(label) if !label.is_empty() => Some(label.to_owned()),
            _ => text(task, "tabId")
                .filter(|id| !id.is_empty())
                .or_else(|| text(task, "paneId"))
                .map(str::to_owned),
        };
        let parts = [
            text(task, "agent").map(str::to_owned),
            trimmed(task, "connectionLabel").map(str::to_owned),
            or(trimmed(task, "workspaceLabel"), "workspaceId"),
            tab,
        ];
        let fallback_body = parts
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .map(|part| slice_utf16(&part, 80).to_owned())
            .collect::<Vec<_>>()
            .join(" \u{b7} ");
        let blocked = text(task, "kind") == Some("blocked");
        let title = field(task, "title").cloned().unwrap_or_else(|| {
            Value::String(
                if blocked {
                    "Roamgate agent needs input"
                } else {
                    "Roamgate task completed"
                }
                .into(),
            )
        });
        let body = field(task, "body")
            .cloned()
            .unwrap_or(Value::String(fallback_body));
        let last = field(task, "paneId")
            .or_else(|| field(task, "title"))
            .or_else(|| field(task, "kind"))
            .cloned()
            .unwrap_or(Value::Null);
        payload.insert("title".into(), title);
        payload.insert("body".into(), body);
        payload.insert(
            "tag".into(),
            Value::String(stringify(&json!([
                "roamgate-task",
                connection_id,
                generation,
                last
            ]))),
        );
        payload.insert("target".into(), target);
    }
    if let Some(path) = path.filter(|path| !path.is_empty()) {
        payload.insert("path".into(), Value::String(path.into()));
    }
    payload
}

/// Which of a device's switches lets this notification through.
pub fn notification_preference(task: &Map<String, Value>) -> &'static str {
    if is_ranger(task) {
        if text(task, "status") == Some("succeeded") {
            "completed"
        } else {
            "blocked"
        }
    } else if text(task, "kind") == Some("blocked") {
        "blocked"
    } else {
        "completed"
    }
}

/// The feed's kind of a notification when its publisher gives none.
pub fn kind_of(task: &Map<String, Value>) -> Value {
    if is_ranger(task) {
        Value::String("ranger_task".into())
    } else {
        field(task, "kind").cloned().unwrap_or(Value::Null)
    }
}

/// What the notification is about, for the client to group by.
pub fn group_of(task: &Map<String, Value>) -> String {
    if is_ranger(task) {
        return "Ranger".into();
    }
    let candidates = [
        trimmed(task, "workspaceLabel").map(str::to_owned),
        field(task, "workspaceId").map(js_string),
        trimmed(task, "connectionLabel").map(str::to_owned),
    ];
    let group = candidates
        .into_iter()
        .flatten()
        .find(|text| !text.is_empty())
        .or_else(|| field(task, "connectionId").map(js_string))
        .unwrap_or_else(|| "undefined".into());
    slice_utf16(&group, 80).to_owned()
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The page a click on the notification opens: what the service worker
/// does.
pub fn notification_path(target: Option<&Value>) -> String {
    match target {
        Some(target) if truthy(Some(target)) => {
            format!(
                "/#roamgate-task={}",
                encode_uri_component(&stringify(target))
            )
        }
        _ => "/".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn blocked() -> Map<String, Value> {
        task(json!({
            "kind": "blocked",
            "connectionId": "alpha",
            "runtimeGeneration": 3,
            "workspaceId": "w1",
            "workspaceLabel": "roamgate",
            "paneId": "p1",
            "agent": "Claude",
        }))
    }

    /// web-push.test.ts: "push payload keeps the status wording and target".
    #[test]
    fn push_payload_keeps_the_status_wording_and_target() {
        let payload = task_push_payload(&blocked(), None);
        assert_eq!(
            Value::Object(payload),
            json!({
                "title": "Roamgate agent needs input",
                "body": "Claude \u{b7} roamgate \u{b7} p1",
                "tag": "[\"roamgate-task\",\"alpha\",3,\"p1\"]",
                "target": {
                    "connectionId": "alpha",
                    "runtimeGeneration": 3,
                    "workspaceId": "w1",
                    "paneId": "p1",
                },
            })
        );
        let mut completed = blocked();
        completed.insert("kind".into(), json!("completed"));
        assert_eq!(
            task_push_payload(&completed, None)["title"],
            "Roamgate task completed"
        );
        assert_eq!(notification_preference(&completed), "completed");
        assert_eq!(notification_preference(&blocked()), "blocked");
    }

    /// web-push.test.ts: "push body uses labels with ID fallbacks: %j".
    #[test]
    fn push_body_uses_labels_with_id_fallbacks() {
        let cases = [
            (
                json!({ "connectionLabel": " Desk ", "workspaceLabel": " ", "tabLabel": "", "tabId": "t1" }),
                "Claude \u{b7} Desk \u{b7} w1 \u{b7} t1",
            ),
            (
                json!({ "workspaceLabel": "x".repeat(100), "tabLabel": "Tab" }),
                &*format!("Claude \u{b7} {} \u{b7} Tab", "x".repeat(80)),
            ),
            (
                json!({ "workspaceLabel": null }),
                "Claude \u{b7} w1 \u{b7} p1",
            ),
        ];
        for (extra, body) in cases {
            let mut value = blocked();
            value.remove("workspaceLabel");
            for (key, field) in extra.as_object().unwrap() {
                value.insert(key.clone(), field.clone());
            }
            assert_eq!(task_push_payload(&value, None)["body"], body, "{extra}");
        }
    }

    /// web-push.test.ts: "push payload uses Herdr text and tolerates
    /// pane-less alerts".
    #[test]
    fn push_payload_uses_herdr_text_and_tolerates_pane_less_alerts() {
        let alert = task(json!({
            "kind": "completed",
            "connectionId": "alpha",
            "runtimeGeneration": 1,
            "agent": "Agent",
            "title": "Build done",
            "body": "All green",
        }));
        assert_eq!(
            Value::Object(task_push_payload(&alert, None)),
            json!({
                "title": "Build done",
                "body": "All green",
                "tag": "[\"roamgate-task\",\"alpha\",1,\"Build done\"]",
                "target": null,
            })
        );
        assert_eq!(notification_path(Some(&Value::Null)), "/");
    }

    /// web-push.test.ts: "Ranger push preserves notification text and
    /// links to the durable task run".
    #[test]
    fn ranger_push_preserves_notification_text_and_links_to_the_durable_task_run() {
        let ranger = task(json!({
            "task_id": "t-1",
            "run_id": "r-1",
            "status": "succeeded",
            "title": "Ranger task completed",
            "body": "Check agent progress",
        }));
        let payload = task_push_payload(&ranger, Some("/#roamgate-work=9"));
        assert_eq!(
            Value::Object(payload.clone()),
            json!({
                "title": "Ranger task completed",
                "body": "Check agent progress",
                "tag": "[\"roamgate-ranger-task\",\"t-1\",\"r-1\"]",
                "target": { "type": "ranger_task", "taskId": "t-1", "runId": "r-1" },
                "path": "/#roamgate-work=9",
            })
        );
        assert_eq!(group_of(&ranger), "Ranger");
        assert_eq!(kind_of(&ranger), "ranger_task");
        assert_eq!(
            notification_path(payload.get("target")),
            "/#roamgate-task=%7B%22type%22%3A%22ranger_task%22%2C%22taskId%22%3A%22t-1%22%2C%22runId%22%3A%22r-1%22%7D"
        );
    }

    /// web-push.test.ts: "Ranger success uses completion preferences;
    /// failures and waiting use attention preferences".
    #[test]
    fn ranger_success_uses_completion_preferences_failures_and_waiting_use_attention_preferences() {
        for (status, preference) in [
            ("succeeded", "completed"),
            ("failed", "blocked"),
            ("waiting", "blocked"),
        ] {
            let ranger = task(json!({ "task_id": "t", "run_id": "r", "status": status }));
            assert_eq!(notification_preference(&ranger), preference);
        }
    }

    #[test]
    fn groups_by_workspace_then_connection() {
        let mut value = blocked();
        assert_eq!(group_of(&value), "roamgate");
        value.insert("workspaceLabel".into(), json!("  "));
        assert_eq!(group_of(&value), "w1");
        value.remove("workspaceId");
        value.insert("connectionLabel".into(), json!(" Desk "));
        assert_eq!(group_of(&value), "Desk");
        value.remove("connectionLabel");
        assert_eq!(group_of(&value), "alpha");
        assert_eq!(encode_uri_component("a b/é~'"), "a%20b%2F%C3%A9~'");
    }
}
