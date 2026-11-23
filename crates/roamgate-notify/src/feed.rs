//! The notification feed's events (notifications/notification-feed.ts):
//! numbered notifications and clears, kept in `<data>/notifications.json`
//! for a day and at most 200, so a client that reconnects, or a server that
//! restarts, replays what it missed. In stage 1 the sockets stay with the
//! Bun front (contract/wire/core-channel.md): the feed answers each change
//! with the events to send, and the front delivers them.
//!
//! Events are kept as the JSON objects the file holds (fields in the order
//! Bun writes them, unknown ones kept), so a file goes back to Bun as Bun
//! would have written it.

use std::path::{Path, PathBuf};

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::json::js_value;
use roamgate_base::log::slice_utf16;
use roamgate_base::paths::DataContext;
use serde_json::{Map, Value, json};

use crate::payload::{
    group_of, is_ranger, kind_of, notification_path, notification_preference, task_push_payload,
};

pub const MAX_EVENTS: usize = 200;
pub const MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const TITLE_CHARS: usize = 200;
const BODY_CHARS: usize = 1000;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `<data>/notifications.json`, or `ROAMGATE_NOTIFICATIONS_PATH`.
pub fn notification_feed_path(env: &dyn Env, root: &Path) -> PathBuf {
    roamgate_env(env, "NOTIFICATIONS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("notifications.json"))
}

/// One stored event (`notification` or `notification_clear`).
pub type Event = Map<String, Value>;

/// The feed as saved.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Saved {
    pub last: i64,
    pub events: Vec<Event>,
}

impl Saved {
    /// `{version: 1, last, events}`, as the file and the front's copy hold it.
    pub fn to_value(&self) -> Value {
        json!({ "version": 1, "last": self.last, "events": self.events })
    }
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

fn is_text(event: &Event, name: &str) -> bool {
    event.get(name).is_some_and(Value::is_string)
}

/// The feed as saved (the file), or None when it is not a valid one.
pub fn parse_saved(value: &Value) -> Option<Saved> {
    let value = value.as_object()?;
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let last = safe_integer(value.get("last"))?;
    let events = value.get("events")?.as_array()?;
    let events = events
        .iter()
        .filter_map(Value::as_object)
        .filter(|event| {
            let kind = event.get("event").and_then(Value::as_str);
            let notification = kind == Some("notification");
            (notification || kind == Some("notification_clear"))
                && safe_integer(event.get("id")).is_some()
                && event
                    .get("at")
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
                && is_text(event, "tag")
                && (!notification
                    || (is_text(event, "title")
                        && is_text(event, "body")
                        && is_text(event, "path")
                        && is_text(event, "group")
                        && matches!(
                            event.get("pref").and_then(Value::as_str),
                            Some("completed" | "blocked")
                        )))
        })
        .cloned()
        .collect();
    Some(Saved { last, events })
}

/// The file's feed: empty when it is missing, too large or not a valid one.
pub fn load(context: &DataContext, path: &Path) -> Saved {
    let read = || -> Option<Saved> {
        context.assert_safe_data_path(path).ok()?;
        let metadata = std::fs::metadata(path).ok()?;
        if metadata.len() > MAX_FILE_BYTES {
            return None;
        }
        let text = std::fs::read_to_string(path).ok()?;
        let value: Value = serde_json::from_str(&text).ok()?;
        parse_saved(&js_value(value))
    };
    read().unwrap_or_default()
}

/// What a publisher adds to a notification (the feed's `extra`).
#[derive(Debug, Clone, Default)]
pub struct Extra {
    /// Overrides the kind the notification implies.
    pub kind: Option<Value>,
    pub actions: Option<Value>,
    pub prompt: Option<Value>,
    /// The page path a click opens, when not the task's pane.
    pub path: Option<String>,
}

/// What a change gives the front: the ids of the events to send to the
/// sockets now (in order), and whether the file could not be written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    pub deliver: Vec<i64>,
    pub save_failed: bool,
}

impl Change {
    pub fn changed(&self) -> bool {
        !self.deliver.is_empty()
    }
}

/// The feed's events and their file.
pub struct Feed {
    context: DataContext,
    path: PathBuf,
    saved: Saved,
}

impl Feed {
    /// The feed of the file now.
    pub fn open(context: DataContext, path: PathBuf) -> Self {
        let saved = load(&context, &path);
        Self {
            context,
            path,
            saved,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn saved(&self) -> &Saved {
        &self.saved
    }

    fn prune(&mut self, now: i64) {
        let oldest = (now - MAX_AGE_MS) as f64;
        self.saved
            .events
            .retain(|event| event.get("at").and_then(Value::as_f64).unwrap_or(f64::NAN) >= oldest);
        let excess = self.saved.events.len().saturating_sub(MAX_EVENTS);
        self.saved.events.drain(..excess);
    }

    fn save(&mut self, now: i64) -> bool {
        self.prune(now);
        let mut text = serde_json::to_string(&self.saved.to_value()).unwrap_or_default();
        text.push('\n');
        self.context
            .replace_data_file(&self.path, text.as_bytes(), 0o600)
            .is_ok()
    }

    fn append(&mut self, event: Event, now: i64, change: &mut Change) {
        let id = safe_integer(event.get("id")).unwrap_or(0);
        self.saved.events.push(event);
        if !self.save(now) {
            change.save_failed = true;
        }
        change.deliver.push(id);
    }

    fn live(&self, tag: &str) -> bool {
        self.saved.events.iter().any(|event| {
            event.get("event").and_then(Value::as_str) == Some("notification")
                && event.get("tag").and_then(Value::as_str) == Some(tag)
        })
    }

    fn clear_into(&mut self, tag: &str, now: i64, change: &mut Change) {
        if !self.live(tag) {
            return;
        }
        self.saved
            .events
            .retain(|event| event.get("tag").and_then(Value::as_str) != Some(tag));
        self.saved.last += 1;
        let mut clear = Map::new();
        clear.insert("event".into(), json!("notification_clear"));
        clear.insert("id".into(), json!(self.saved.last));
        clear.insert("at".into(), json!(now));
        clear.insert("tag".into(), json!(tag));
        self.append(clear, now, change);
    }

    /// Withdraws the notifications with this tag, if any is still out.
    pub fn clear_tag(&mut self, tag: &str, now: i64) -> Change {
        let mut change = Change::default();
        self.clear_into(tag, now, &mut change);
        change
    }

    fn clear_where(&mut self, now: i64, matches: impl Fn(&Event) -> bool) -> Change {
        let mut tags: Vec<String> = Vec::new();
        for event in &self.saved.events {
            if event.get("event").and_then(Value::as_str) == Some("notification")
                && matches(event)
                && let Some(tag) = event.get("tag").and_then(Value::as_str)
                && !tags.iter().any(|known| known == tag)
            {
                tags.push(tag.to_owned());
            }
        }
        let mut change = Change::default();
        for tag in tags {
            self.clear_into(&tag, now, &mut change);
        }
        change
    }

    /// The user looked at the pane: its notifications are done with.
    pub fn clear_pane(&mut self, connection_id: &str, pane_id: &str, now: i64) -> Change {
        let pane = format!("{connection_id}\n{pane_id}");
        self.clear_where(now, |event| {
            event.get("pane").and_then(Value::as_str) == Some(&pane)
        })
    }

    /// The pane's agent stopped waiting on the user; a permission prompt's
    /// notification goes with the prompt instead.
    pub fn clear_blocked_pane(&mut self, connection_id: &str, pane_id: &str, now: i64) -> Change {
        let pane = format!("{connection_id}\n{pane_id}");
        self.clear_where(now, |event| {
            event.get("pane").and_then(Value::as_str) == Some(&pane)
                && event.get("kind").and_then(Value::as_str) == Some("blocked")
                && !truthy(event.get("prompt"))
        })
    }

    /// The prompt was answered, or went back to the terminal.
    pub fn clear_prompt(&mut self, prompt_id: &str, now: i64) -> Change {
        self.clear_where(now, |event| {
            event
                .get("prompt")
                .and_then(|prompt| prompt.get("promptId"))
                .and_then(Value::as_str)
                == Some(prompt_id)
        })
    }

    /// Keeps one notification (replacing one with its tag) and gives what to
    /// send; the caller pushes the same payload to Web Push.
    pub fn publish(
        &mut self,
        task: &Map<String, Value>,
        extra: &Extra,
        now: i64,
    ) -> (Event, Map<String, Value>, Change) {
        let payload = task_push_payload(task, extra.path.as_deref());
        self.saved.last += 1;
        let text = |name: &str, limit: usize| -> Value {
            match payload.get(name) {
                Some(Value::String(text)) => Value::String(slice_utf16(text, limit).to_owned()),
                Some(other) => other.clone(),
                None => Value::Null,
            }
        };
        let mut event = Map::new();
        event.insert("event".into(), json!("notification"));
        event.insert("id".into(), json!(self.saved.last));
        event.insert("at".into(), json!(now));
        event.insert(
            "kind".into(),
            extra.kind.clone().unwrap_or_else(|| kind_of(task)),
        );
        event.insert("title".into(), text("title", TITLE_CHARS));
        event.insert("body".into(), text("body", BODY_CHARS));
        event.insert(
            "tag".into(),
            payload.get("tag").cloned().unwrap_or(Value::Null),
        );
        event.insert("group".into(), Value::String(group_of(task)));
        event.insert(
            "path".into(),
            Value::String(
                extra
                    .path
                    .clone()
                    .unwrap_or_else(|| notification_path(payload.get("target"))),
            ),
        );
        let has_actions = extra
            .actions
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|actions| !actions.is_empty());
        if has_actions && truthy(extra.prompt.as_ref()) {
            event.insert(
                "actions".into(),
                extra.actions.clone().unwrap_or(Value::Null),
            );
            event.insert("prompt".into(), extra.prompt.clone().unwrap_or(Value::Null));
        }
        event.insert(
            "pref".into(),
            Value::String(notification_preference(task).into()),
        );
        let pane_id = task.get("paneId").filter(|id| truthy(Some(id)));
        if let (false, Some(pane_id)) = (is_ranger(task), pane_id) {
            let connection = task
                .get("connectionId")
                .map(js_text)
                .unwrap_or_else(|| "undefined".into());
            event.insert(
                "pane".into(),
                Value::String(format!("{connection}\n{}", js_text(pane_id))),
            );
        }
        // A newer notification replaces one with its tag, as on the device;
        // an agent still waiting on a permission prompt keeps its actions.
        let tag = event.get("tag").and_then(Value::as_str).map(str::to_owned);
        let waiting = self
            .saved
            .events
            .iter()
            .find(|each| {
                each.get("event").and_then(Value::as_str) == Some("notification")
                    && each.get("tag").and_then(Value::as_str) == tag.as_deref()
            })
            .cloned();
        if let Some(waiting) = waiting
            && !truthy(event.get("prompt"))
            && truthy(waiting.get("prompt"))
            && truthy(waiting.get("actions"))
        {
            event.insert("prompt".into(), waiting["prompt"].clone());
            event.insert("actions".into(), waiting["actions"].clone());
        }
        self.saved
            .events
            .retain(|each| each.get("tag").and_then(Value::as_str) != tag.as_deref());
        let mut change = Change::default();
        self.append(event.clone(), now, &mut change);
        (event, payload, change)
    }
}

/// `String(value)` for the ids a task carries.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests;
