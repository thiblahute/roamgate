//! Task events (notifications/task-events.ts and the mapping of
//! herdr-notification-listener.ts): an agent finishing or blocking, from
//! Roamgate's own status tracker (working, then idle, done or blocked) or
//! from Herdr's semantic notifications. In stage 1 the Herdr connections are
//! the Bun front's: it runs both and hands each event on to the feed
//! (`internal.notifications.publish`); this is their Rust side for the host
//! layer's move (Phase 5), held to the same tests.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// Where task notifications come from: Herdr's semantic notifications
/// (`herdr`, the default) or Roamgate's own status tracker (`status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskNotificationSource {
    Herdr,
    Status,
}

/// `ROAMGATE_NOTIFICATION_SOURCE` read as Bun reads it.
pub fn parse_task_notification_source(
    value: Option<&str>,
) -> Result<TaskNotificationSource, String> {
    let given = value.unwrap_or("herdr");
    match roamgate_base::settings::js_trim(given)
        .to_lowercase()
        .as_str()
    {
        "herdr" => Ok(TaskNotificationSource::Herdr),
        "status" => Ok(TaskNotificationSource::Status),
        _ => Err(format!(
            "Invalid notification source \"{given}\" (expected herdr or status)"
        )),
    }
}

fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}

/// A Herdr semantic notification (`kind`, `title`, `body`, `sound`,
/// `agent`, `workspaceId`, `tabId`, `paneId`) as a task event, or None for
/// Herdr's own update notices.
pub fn task_event_from_semantic_notification(notification: &Value) -> Option<Value> {
    let kind = match text(notification, "kind")? {
        "finished" => "completed",
        "needs_attention" => "blocked",
        // `herdr notification show` carries no kind; its sound says which.
        "custom" if text(notification, "sound") == Some("request") => "blocked",
        "custom" => "completed",
        _ => return None,
    };
    let mut event = Map::new();
    event.insert("kind".into(), json!(kind));
    event.insert(
        "agent".into(),
        json!(text(notification, "agent").unwrap_or("Agent")),
    );
    event.insert(
        "title".into(),
        notification.get("title").cloned().unwrap_or(Value::Null),
    );
    for (field, key) in [
        ("body", "body"),
        ("workspaceId", "workspaceId"),
        ("tabId", "tabId"),
        ("paneId", "paneId"),
    ] {
        if let Some(value) = text(notification, field).filter(|value| !value.is_empty()) {
            event.insert(key.into(), json!(value));
        }
    }
    Some(Value::Object(event))
}

/// A Herdr event's name (`event`, else `data.type`), as
/// utils/herdr-events.ts finds it.
pub fn herdr_event_name(event: &Value) -> Option<&str> {
    let object = event.as_object()?;
    if let Some(name) = object
        .get("event")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
    {
        return Some(name);
    }
    object
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("type"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
}

#[derive(Debug, Clone)]
struct Pane {
    /// The pane's fields as last seen (later ones over earlier ones).
    fields: Map<String, Value>,
}

impl Pane {
    fn status(&self) -> Option<&str> {
        self.fields.get("agent_status").and_then(Value::as_str)
    }
}

fn pane_info(value: &Value) -> Option<Map<String, Value>> {
    let pane = value.as_object()?;
    let id_ok = |name: &str| {
        pane.get(name)
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    };
    (id_ok("pane_id")
        && id_ok("workspace_id")
        && pane.get("agent_status").is_some_and(Value::is_string))
    .then(|| pane.clone())
}

fn merged(previous: Option<&Pane>, next: &Map<String, Value>) -> Pane {
    let mut fields = previous.map(|pane| pane.fields.clone()).unwrap_or_default();
    for (key, value) in next {
        fields.insert(key.clone(), value.clone());
    }
    Pane { fields }
}

/// One tracker per runtime: initial snapshots seed state without
/// notifying; an agent that was working and is now blocked, done or idle
/// gives one task event.
pub struct TaskEventTracker {
    panes: HashMap<String, Pane>,
    revision: u64,
    stopped: bool,
}

impl Default for TaskEventTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskEventTracker {
    pub fn new() -> Self {
        Self {
            panes: HashMap::new(),
            revision: 0,
            stopped: false,
        }
    }

    fn observe(&mut self, pane: Pane, out: &mut Vec<Value>) {
        let id = pane.fields["pane_id"].as_str().unwrap_or("").to_owned();
        let previous = self.panes.insert(id, pane.clone());
        let Some(previous) = previous else {
            return;
        };
        if previous.status() != Some("working") {
            return;
        }
        let status = pane.status().unwrap_or("");
        if !matches!(status, "blocked" | "done" | "idle") {
            return;
        }
        let mut event = Map::new();
        event.insert(
            "kind".into(),
            json!(if status == "blocked" {
                "blocked"
            } else {
                "completed"
            }),
        );
        event.insert("workspaceId".into(), pane.fields["workspace_id"].clone());
        event.insert("paneId".into(), pane.fields["pane_id"].clone());
        if let Some(tab) = pane.fields.get("tab_id").filter(|tab| tab.is_string()) {
            event.insert("tabId".into(), tab.clone());
        }
        let agent = match pane.fields.get("agent").and_then(Value::as_str) {
            Some(agent) => agent.to_owned(),
            None => previous
                .fields
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("Agent")
                .to_owned(),
        };
        event.insert("agent".into(), json!(agent));
        out.push(Value::Object(event));
    }

    /// A pane list is about to be asked for: its answer is applied only if
    /// no event came meanwhile.
    pub fn begin_pane_list(&self) -> u64 {
        self.revision
    }

    /// A pane list's answer (`{panes: [...]}`), begun at `started_at`.
    pub fn reconcile_pane_list(&mut self, result: &Value, started_at: u64) -> Vec<Value> {
        let mut out = Vec::new();
        if self.stopped || started_at != self.revision {
            return out;
        }
        let Some(listed) = result.get("panes").and_then(Value::as_array) else {
            return out;
        };
        let mut live = Vec::new();
        for value in listed {
            let Some(pane) = pane_info(value) else {
                continue;
            };
            live.push(pane["pane_id"].as_str().unwrap_or("").to_owned());
            self.observe(Pane { fields: pane }, &mut out);
        }
        self.panes.retain(|id, _| live.contains(id));
        out
    }

    /// One Herdr event: the task events it gives.
    pub fn handle_herdr_event(&mut self, event: &Value) -> Vec<Value> {
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        let name = herdr_event_name(event).map(|name| name.replace('_', "."));
        let Some(data) = event.get("data").and_then(Value::as_object) else {
            return out;
        };
        let id_of = |key: &str| match data.get(key) {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        match name.as_deref() {
            Some("pane.agent.status.changed") => {
                let Some(pane) = pane_info(&Value::Object(data.clone())) else {
                    return out;
                };
                self.revision += 1;
                let id = pane["pane_id"].as_str().unwrap_or("").to_owned();
                let next = merged(self.panes.get(&id), &pane);
                self.observe(next, &mut out);
            }
            Some("pane.closed" | "pane.exited") => {
                self.revision += 1;
                self.panes.remove(&id_of("pane_id"));
            }
            Some(closed @ ("workspace.closed" | "tab.closed")) => {
                self.revision += 1;
                let (field, key) = if closed == "workspace.closed" {
                    ("workspace_id", "workspace_id")
                } else {
                    ("tab_id", "tab_id")
                };
                let target = data.get(key).cloned();
                self.panes
                    .retain(|_, pane| pane.fields.get(field).cloned() != target);
            }
            Some("pane.moved") => {
                self.revision += 1;
                let previous = self.panes.remove(&id_of("previous_pane_id"));
                if let Some(pane) = data.get("pane").and_then(pane_info) {
                    let id = pane["pane_id"].as_str().unwrap_or("").to_owned();
                    self.panes.insert(id, merged(previous.as_ref(), &pane));
                }
            }
            _ => {}
        }
        out
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.panes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane() -> Value {
        json!({ "pane_id": "p1", "workspace_id": "w1", "tab_id": "t1", "agent": "Example agent", "agent_status": "working" })
    }

    fn event(status: &str) -> Value {
        let mut data = pane();
        data["agent_status"] = json!(status);
        json!({ "event": "pane.agent_status_changed", "data": data })
    }

    fn kinds(events: &[Value]) -> Vec<&str> {
        events
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect()
    }

    /// task-events.test.ts: "initial snapshots seed, transitions notify
    /// once, and stale snapshots cannot replay events".
    #[test]
    fn initial_snapshots_seed_transitions_notify_once_and_stale_snapshots_cannot_replay_events() {
        let mut tracker = TaskEventTracker::new();
        let mut events = Vec::new();
        let begun = tracker.begin_pane_list();
        events.extend(tracker.reconcile_pane_list(&json!({ "panes": [pane()] }), begun));
        assert!(events.is_empty());
        let revision = tracker.begin_pane_list();
        events.extend(tracker.handle_herdr_event(&event("blocked")));
        events.extend(tracker.handle_herdr_event(&event("blocked")));
        events.extend(tracker.reconcile_pane_list(&json!({ "panes": [pane()] }), revision));
        events.extend(tracker.handle_herdr_event(&event("idle")));
        assert_eq!(kinds(&events), ["blocked"]);
        events.extend(tracker.handle_herdr_event(&event("working")));
        let mut done = pane();
        done["agent_status"] = json!("done");
        let begun = tracker.begin_pane_list();
        events.extend(tracker.reconcile_pane_list(&json!({ "panes": [done] }), begun));
        events.extend(tracker.handle_herdr_event(&event("idle")));
        assert_eq!(kinds(&events), ["blocked", "completed"]);
        assert_eq!(
            events[0],
            json!({ "kind": "blocked", "workspaceId": "w1", "paneId": "p1", "tabId": "t1", "agent": "Example agent" })
        );
    }

    /// task-events.test.ts: "partial status events retain the tab from the
    /// pane snapshot".
    #[test]
    fn partial_status_events_retain_the_tab_from_the_pane_snapshot() {
        let mut tracker = TaskEventTracker::new();
        tracker.reconcile_pane_list(&json!({ "panes": [pane()] }), 0);
        let events = tracker.handle_herdr_event(&json!({
            "event": "pane.agent_status_changed",
            "data": { "pane_id": "p1", "workspace_id": "w1", "agent_status": "done" },
        }));
        assert_eq!(events[0]["tabId"], "t1");
        assert_eq!(events[0]["agent"], "Example agent");
    }

    /// task-events.test.ts: "moves, closures, malformed lists and stopped
    /// runtimes do not fabricate tasks".
    #[test]
    fn moves_closures_malformed_lists_and_stopped_runtimes_do_not_fabricate_tasks() {
        let mut tracker = TaskEventTracker::new();
        let mut events = Vec::new();
        tracker.reconcile_pane_list(&json!({ "panes": [pane()] }), 0);
        tracker.reconcile_pane_list(&json!({}), 0);
        let mut moved = pane();
        moved["pane_id"] = json!("p2");
        moved["workspace_id"] = json!("w2");
        tracker.handle_herdr_event(
            &json!({ "event": "pane_moved", "data": { "previous_pane_id": "p1", "pane": moved } }),
        );
        let mut blocked = moved.clone();
        blocked["agent_status"] = json!("blocked");
        events.extend(
            tracker.handle_herdr_event(
                &json!({ "event": "pane_agent_status_changed", "data": blocked }),
            ),
        );
        assert_eq!(
            (
                events[0]["paneId"].clone(),
                events[0]["workspaceId"].clone()
            ),
            (json!("p2"), json!("w2"))
        );
        events.extend(tracker.handle_herdr_event(&event("idle")));
        assert_eq!(events.len(), 1);
        events.extend(tracker.handle_herdr_event(&event("working")));
        tracker.handle_herdr_event(
            &json!({ "event": "workspace.closed", "data": { "workspace_id": "w1" } }),
        );
        events.extend(tracker.handle_herdr_event(&event("done")));
        assert_eq!(events.len(), 1);
        tracker.stop();
        events.extend(tracker.handle_herdr_event(&event("working")));
        events.extend(tracker.handle_herdr_event(&event("blocked")));
        let begun = tracker.begin_pane_list();
        events.extend(tracker.reconcile_pane_list(&json!({ "panes": [pane()] }), begun));
        assert_eq!(events.len(), 1);
    }

    fn notification(fields: Value) -> Value {
        let mut base = json!({ "kind": "finished", "title": "t", "body": null, "sound": null, "agent": null, "workspaceId": null, "tabId": null, "paneId": null });
        for (key, value) in fields.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    /// herdr-notification-listener.test.ts: "uses the sound to classify
    /// pane-less custom alerts".
    #[test]
    fn uses_the_sound_to_classify_pane_less_custom_alerts() {
        assert_eq!(
            task_event_from_semantic_notification(&notification(
                json!({ "kind": "custom", "title": "codex idle", "sound": "done" })
            )),
            Some(json!({ "kind": "completed", "agent": "Agent", "title": "codex idle" }))
        );
        assert_eq!(
            task_event_from_semantic_notification(&notification(
                json!({ "kind": "custom", "title": "codex asks", "sound": "request" })
            ))
            .unwrap()["kind"],
            "blocked"
        );
        assert_eq!(
            task_event_from_semantic_notification(&notification(
                json!({ "kind": "custom", "title": "hello" })
            ))
            .unwrap()["kind"],
            "completed"
        );
        assert_eq!(
            task_event_from_semantic_notification(&notification(
                json!({ "kind": "needs_attention", "agent": "codex", "body": "b", "paneId": "p1", "workspaceId": "w1" })
            )),
            Some(
                json!({ "kind": "blocked", "agent": "codex", "title": "t", "body": "b", "workspaceId": "w1", "paneId": "p1" })
            )
        );
    }

    /// herdr-notification-listener.test.ts: "drops Herdr update notices".
    #[test]
    fn drops_herdr_update_notices() {
        assert_eq!(
            task_event_from_semantic_notification(&notification(
                json!({ "kind": "update_installed" })
            )),
            None
        );
    }

    /// herdr-notification-listener.test.ts: "defaults to herdr and accepts
    /// status".
    #[test]
    fn defaults_to_herdr_and_accepts_status() {
        assert_eq!(
            parse_task_notification_source(None),
            Ok(TaskNotificationSource::Herdr)
        );
        assert_eq!(
            parse_task_notification_source(Some(" Status ")),
            Ok(TaskNotificationSource::Status)
        );
        assert!(
            parse_task_notification_source(Some("both"))
                .unwrap_err()
                .contains("Invalid notification source")
        );
    }
}
