//! The service's own helpers (`assistant/service.ts`'s top level): the
//! checks of saved and sent values, mentions, summaries and notes.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use roamgate_agents::js;
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::{DataContext, random_uuid};
use serde_json::{Map, Value, json};

use crate::errors::{AssistantError, AssistantResult};
use crate::saved::ref_key;
use crate::wire::{
    ASSISTANT_MAX_THINKING, ASSISTANT_MAX_THINKING_STEPS, ASSISTANT_MAX_WORKSPACES, is_queue,
    is_thinking_level,
};

pub const MAX_TEXT: usize = 32_000;
pub const MAX_MESSAGES: usize = 80;
pub const MAX_CONTEXT_BYTES: usize = 1_000_000;
pub const MAX_STATE_BYTES: usize = 3_000_000;
pub const MAX_STEERS: usize = 8;

/// How long a new task run waits for its connections that are down for
/// now (connecting, reconnecting or failed and retrying) before it runs
/// without their workspaces.
pub const TASK_CONNECTION_WAIT_MS: u64 = 5 * 60_000;

/// Connection states that may become ready on their own.
pub const PASSING_CONNECTION_STATES: [&str; 3] = ["connecting", "reconnecting", "error"];

/// `Buffer.byteLength(JSON.stringify(value), "utf8")`.
pub fn json_bytes(value: &Value) -> usize {
    js::stringify(value).len()
}

pub fn json_bytes_of(values: &[Value]) -> usize {
    let mut total = 2 + values.len().saturating_sub(1);
    for value in values {
        total += json_bytes(value);
    }
    total
}

/// A plain `Error`: its message reaches the caller, never shown as a
/// user error by the tools.
pub fn err(message: impl Into<String>) -> AssistantError {
    AssistantError::Internal(message.into())
}

pub fn user(message: impl Into<String>) -> AssistantError {
    AssistantError::User(message.into())
}

/// `signal.throwIfAborted()`.
pub fn aborted() -> AssistantError {
    err("The operation was aborted.")
}

/// The reasoning a message keeps (`boundAssistantThinking`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundThinking {
    pub steps: Vec<String>,
    pub skipped: usize,
    pub truncated: bool,
}

/// Keep the newest reasoning: drop whole early steps, then cut the start of
/// the oldest step that still fits.
pub fn bound_assistant_thinking(steps: &[String]) -> BoundThinking {
    let mut kept: Vec<String> = Vec::new();
    let mut remaining = ASSISTANT_MAX_THINKING as i64;
    for step in steps.iter().rev() {
        if remaining <= 0 || kept.len() >= ASSISTANT_MAX_THINKING_STEPS {
            break;
        }
        let length = js::len16(step) as i64;
        // A cut never starts with the low half of a pair: slice16 moves past
        // it, as the TS drops it.
        let value = if length > remaining {
            js::slice16(step, -remaining, None)
        } else {
            step.clone()
        };
        // A step reduced to nothing by that repair counts as skipped.
        if value.is_empty() {
            break;
        }
        let whole = value == *step;
        let value_length = js::len16(&value) as i64;
        kept.insert(0, value);
        // A cut step fills the budget, even after dropping a half pair.
        remaining = if whole { remaining - value_length } else { 0 };
    }
    let skipped = steps.len() - kept.len();
    let truncated = skipped > 0 || kept.first() != steps.get(skipped);
    BoundThinking {
        steps: kept,
        skipped,
        truncated,
    }
}

pub fn same_ref(a: &Value, b: &Value) -> bool {
    ref_key(a) == ref_key(b)
}

/// `refOf`: `{connection_id, workspace_id}` only.
pub fn ref_of(value: &Value) -> Value {
    let mut map = Map::new();
    map.insert(
        "connection_id".into(),
        value.get("connection_id").cloned().unwrap_or(Value::Null),
    );
    map.insert(
        "workspace_id".into(),
        value.get("workspace_id").cloned().unwrap_or(Value::Null),
    );
    Value::Object(map)
}

pub fn is_session_id(id: &str) -> bool {
    crate::wire::is_uuid(id)
}

// Provider errors can carry credentials: name the provider, not what it said.
pub fn models_unlisted(provider: &str) -> String {
    format!("The models of {provider} could not be listed. Check its sign-in in Ranger's settings.")
}

/// The step that refused a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnStep {
    Workspaces,
    Scope,
    Models,
    Model,
    Thinking,
    Capture,
    Mentions,
    Recovery,
    Task,
    Start,
}

impl TurnStep {
    pub fn name(self) -> &'static str {
        match self {
            Self::Workspaces => "workspaces",
            Self::Scope => "scope",
            Self::Models => "models",
            Self::Model => "model",
            Self::Thinking => "thinking",
            Self::Capture => "capture",
            Self::Mentions => "mentions",
            Self::Recovery => "recovery",
            Self::Task => "task",
            Self::Start => "start",
        }
    }

    /// What the user is told when a turn cannot start, by the step that
    /// refused it (`TURN_STEP_ERRORS`). Fixed texts: an unexpected error's
    /// own message may carry socket paths, provider replies or credentials.
    pub fn error(self, provider: &str) -> String {
        match self {
            Self::Workspaces => {
                "Ranger could not list the workspaces. Check the server connections and try again."
                    .into()
            }
            Self::Scope => {
                "Ranger's workspace permissions changed. Choose the workspaces it may read again."
                    .into()
            }
            Self::Model => {
                "Ranger's selected model is not available. Choose a model in its settings.".into()
            }
            Self::Thinking => "The selected thinking effort is not supported by this model. Choose another in Ranger's settings.".into(),
            Self::Capture => "A workspace Ranger may read could not be opened: its server may be offline or restarting. Try again.".into(),
            Self::Mentions => "A referenced workspace or agent session changed or is unavailable. Select it again.".into(),
            Self::Recovery => "Ranger could not prepare this turn's workspaces. Try again.".into(),
            Self::Task => "The task's workspace permission changed. Check the task's workspaces.".into(),
            Self::Start => "Ranger could not start this turn. Try again.".into(),
            Self::Models => models_unlisted(provider),
        }
    }
}

/// Tells the model which workspaces a turn left out, by connection.
pub fn unreachable_note(refs: &[Value]) -> String {
    if refs.is_empty() {
        return String::new();
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for item in refs {
        let connection = js::sv(item.get("connection_id")).to_owned();
        match counts.iter_mut().find(|(id, _)| *id == connection) {
            Some((_, count)) => *count += 1,
            None => counts.push((connection, 1)),
        }
    }
    let parts: Vec<String> = counts
        .iter()
        .map(|(connection, count)| {
            format!(
                "{count} workspace{} on connection {}",
                if *count == 1 { "" } else { "s" },
                js::quote(connection)
            )
        })
        .collect();
    format!(
        "\n\nUnreachable now, left out of this turn: {}. Their server is offline or its workspace list failed; say so if the user asks about them.",
        parts.join(", ")
    )
}

/// `string(value, name, max)`.
pub fn string(value: Option<&Value>, name: &str, max: usize) -> AssistantResult<String> {
    match value {
        Some(Value::String(text)) if !js::trim(text).is_empty() && js::len16(text) <= max => {
            Ok(text.clone())
        }
        _ => Err(err(format!("Invalid {name}"))),
    }
}

pub fn string500(value: Option<&Value>, name: &str) -> AssistantResult<String> {
    string(value, name, 500)
}

/// `refs(value)`: a workspace scope, checked.
pub fn refs(value: Option<&Value>) -> AssistantResult<Vec<Value>> {
    let invalid = || err("Invalid workspace scope");
    let Some(Value::Array(items)) = value else {
        return Err(invalid());
    };
    if items.len() > ASSISTANT_MAX_WORKSPACES {
        return Err(invalid());
    }
    let mut result = Vec::with_capacity(items.len());
    for entry in items {
        if !(entry.is_object() || entry.is_array()) {
            return Err(invalid());
        }
        let connection = string500(entry.get("connection_id"), "connection identifier")?;
        let workspace = string500(entry.get("workspace_id"), "workspace identifier")?;
        result.push(json!({"connection_id": connection, "workspace_id": workspace}));
    }
    let keys: HashSet<String> = result.iter().map(ref_key).collect();
    if keys.len() != result.len() {
        return Err(err("Duplicate workspace scope"));
    }
    Ok(result)
}

/// `config(value)`: a Ranger configuration, checked, in Bun's key order.
pub fn config(value: &Value) -> AssistantResult<Value> {
    let get = |key: &str| value.get(key);
    let source = get("credential_source");
    if source != Some(&json!("assistant")) && source != Some(&json!("pi")) {
        return Err(err("Invalid credential source"));
    }
    let approval = get("approval_mode");
    if approval.is_some() && approval != Some(&json!("manual")) && approval != Some(&json!("auto"))
    {
        return Err(err("Invalid approval mode"));
    }
    let scope = get("workspace_scope");
    if scope.is_some() && scope != Some(&json!("all")) {
        return Err(err("Invalid workspace permission mode"));
    }
    let thinking = get("thinking_level");
    if thinking.is_some_and(|level| !is_thinking_level(level)) {
        return Err(err("Invalid thinking effort"));
    }
    let mut out = Map::new();
    if let Some(level) = thinking {
        out.insert("thinking_level".into(), level.clone());
    }
    let provider = if get("provider") == Some(&json!("")) {
        String::new()
    } else {
        string500(get("provider"), "provider")?
    };
    let model = if get("model") == Some(&json!("")) {
        String::new()
    } else {
        string500(get("model"), "model")?
    };
    out.insert("provider".into(), json!(provider));
    out.insert("model".into(), json!(model));
    out.insert("credential_source".into(), source.cloned().unwrap());
    out.insert(
        "allowed_workspaces".into(),
        Value::Array(refs(get("allowed_workspaces"))?),
    );
    if scope.is_some() {
        out.insert("workspace_scope".into(), json!("all"));
    }
    if let Some(approval) = approval {
        out.insert("approval_mode".into(), approval.clone());
    }
    Ok(Value::Object(out))
}

/// Whether two Ranger configurations are the same, whatever the order of
/// their fields: a configuration saved after a permission change keeps its
/// fields in another order than one read back from disk.
pub fn same_assistant_config(a: &Value, b: &Value) -> bool {
    match (config(a), config(b)) {
        (Ok(a), Ok(b)) => js::stringify(&a) == js::stringify(&b),
        _ => false,
    }
}

/// `assistantDirectory()`.
pub fn assistant_directory(env: &dyn Env, data: &DataContext) -> PathBuf {
    roamgate_env(env, "ASSISTANT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data.data_root().join("assistant"))
}

/// `sessionSummary(id, messages)`.
pub fn session_summary(id: Option<String>, messages: &[Value], now: &str) -> Value {
    let id = id.unwrap_or_else(random_uuid);
    let first = messages.iter().find(|message| message["role"] == "user");
    let title = first
        .map(|message| {
            let text = js::trim(js::sv(message.get("text")));
            let line = text.split('\n').next().unwrap_or("");
            let line = line.strip_suffix('\r').unwrap_or(line);
            js::head16(js::trim(line), 72)
        })
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "New chat".into());
    let created = first
        .and_then(|message| message.get("sent_at"))
        .filter(|sent| js::date_parse(&js::to_text(sent)).is_finite() && sent.is_string())
        .cloned()
        .unwrap_or_else(|| json!(now));
    json!({
        "id": id,
        "title": title,
        "created_at": created,
        "updated_at": now,
        "message_count": messages.len(),
    })
}

/// `savedSteers(value)`.
pub fn saved_steers(value: &Value) -> AssistantResult<Vec<Value>> {
    let invalid = || err("Invalid saved steers");
    let Some(items) = value.as_array() else {
        return Err(invalid());
    };
    if items.len() > MAX_STEERS {
        return Err(invalid());
    }
    items
        .iter()
        .map(|steer| {
            let Some(map) = steer.as_object() else {
                return Err(invalid());
            };
            let (message, draft) = (map.get("message_id"), map.get("draft_id"));
            if message.is_none() != draft.is_none() {
                return Err(invalid());
            }
            let mut out = Map::new();
            out.insert(
                "request_id".into(),
                json!(string500(map.get("request_id"), "request identifier")?),
            );
            out.insert(
                "text".into(),
                json!(string(map.get("text"), "saved prompt", MAX_CONTEXT_BYTES)?),
            );
            if message.is_some() {
                out.insert(
                    "message_id".into(),
                    json!(string500(message, "message identifier")?),
                );
                out.insert(
                    "draft_id".into(),
                    json!(string500(draft, "draft identifier")?),
                );
            }
            Ok(Value::Object(out))
        })
        .collect()
}

/// `savedQueue(value)`.
pub fn saved_queue(value: Option<&Value>) -> AssistantResult<Vec<Value>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if !is_queue(value) {
        return Err(err("Invalid saved queue"));
    }
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            let mut item = item.clone();
            if let Some(scope) = item.get("scope").cloned() {
                item["scope"] = Value::Array(refs(Some(&scope))?);
            }
            Ok(item)
        })
        .collect()
}

/// `mentionTargetKey(target)`.
pub fn mention_target_key(target: &Value) -> String {
    let field = |key: &str| target.get(key).cloned().unwrap_or(Value::Null);
    let mut parts = vec![field("kind"), json!(ref_key(target))];
    if target.get("kind") == Some(&json!("agent")) {
        parts.extend([
            field("pane_id"),
            field("terminal_id"),
            field("agent_identity"),
        ]);
    }
    js::stringify(&Value::Array(parts))
}

/// `new Map(pairs).values()`: the first key's place, the last value.
pub fn unique_by_key(pairs: impl IntoIterator<Item = (String, Value)>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut values: HashMap<String, Value> = HashMap::new();
    for (key, value) in pairs {
        if !values.contains_key(&key) {
            order.push(key.clone());
        }
        values.insert(key, value);
    }
    order
        .into_iter()
        .map(|key| values.remove(&key).unwrap())
        .collect()
}

/// `mentionTargets(mentions)`: the targets, without their places,
/// once each.
pub fn mention_targets(mentions: &[Value]) -> Vec<Value> {
    unique_by_key(mentions.iter().map(|mention| {
        let mut target = mention.clone();
        if let Some(map) = target.as_object_mut() {
            js::delete(map, "start");
            js::delete(map, "end");
        }
        let key = js::stringify(&Value::Array(vec![
            json!(mention_target_key(&target)),
            target
                .get("runtime_generation")
                .cloned()
                .unwrap_or(Value::Null),
        ]));
        (key, target)
    }))
}

/// The mention a message is addressed to: it opens the message and what
/// follows is a statement, not a question.
#[derive(Debug, Clone)]
pub struct Addressed {
    pub target: Value,
    pub text: String,
}

pub fn addressed_mention(mentions: &[Value], text: &str) -> Option<Addressed> {
    let first = mentions
        .iter()
        .find(|mention| mention.get("start").and_then(Value::as_f64) == Some(0.0))?;
    let end = first.get("end").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let rest = js::trim(&js::slice16(text, end, None)).to_owned();
    if rest.is_empty() || rest.ends_with('?') {
        return None;
    }
    Some(Addressed {
        target: mention_targets(std::slice::from_ref(first)).remove(0),
        text: rest,
    })
}

/// The turn instruction for a message addressed to a mention.
pub fn addressed_note(addressed: Option<&Addressed>, bound: &[Value]) -> String {
    let Some(addressed) = addressed else {
        return String::new();
    };
    let key = mention_target_key(&addressed.target);
    let target = bound
        .iter()
        .find(|mention| mention_target_key(mention) == key)
        .unwrap_or(&addressed.target);
    let text = js::quote(&addressed.text);
    let send = format!("call propose_agent_prompt with the exact prompt {text}");
    let label = js::to_text(target.get("label").unwrap_or(&Value::Null));
    let rest = if target.get("kind") == Some(&json!("agent")) {
        let mut chars = send.chars();
        let first = chars.next().unwrap().to_uppercase().collect::<String>();
        format!(
            "{first}{} for that Agent (connection_id, workspace_id and pane_id as referenced above), never answer in its place, and tell the user plainly whether it was sent or waits for their confirmation.",
            chars.as_str()
        )
    } else {
        format!(
            "Read workspace_status for that workspace: if exactly one Agent runs there, {send} for it and tell the user plainly whether it was sent or waits for their confirmation; otherwise ask which Agent is meant and send nothing. Never answer in an Agent's place."
        )
    };
    format!(
        "\n\nThis message is addressed to @{label}, the first referenced object: it is an instruction to send, not a question about it. {rest}"
    )
}

/// `restoredMentions(targets, captured)`: each with the generation of its
/// workspace now.
pub fn restored_mentions(targets: &[Value], captured: &Value) -> AssistantResult<Vec<Value>> {
    let workspaces = captured.as_array().cloned().unwrap_or_default();
    targets
        .iter()
        .map(|target| {
            let workspace = workspaces
                .iter()
                .find(|item| same_ref(item, target))
                .ok_or_else(|| err("A referenced object is outside the Ranger scope."))?;
            let mut target = target.clone();
            target["runtime_generation"] = workspace
                .get("runtime_generation")
                .cloned()
                .unwrap_or(Value::Null);
            Ok(target)
        })
        .collect()
}

/// `authUrl(value)`: an http(s) URL without credentials, as `href`.
pub fn auth_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    matches!(url.scheme(), "https" | "http").then(|| url.as_str().to_owned())
}

/// `namedList(names)`: at most 20, then how many more.
pub fn named_list(names: &[String]) -> String {
    let shown: Vec<&str> = names.iter().take(20).map(String::as_str).collect();
    if names.len() > shown.len() {
        format!(
            "{} and {} more",
            shown.join(", "),
            names.len() - shown.len()
        )
    } else {
        shown.join(", ")
    }
}

/// `connectionWhy(item)`.
pub fn connection_why(item: &Value) -> String {
    let state = js::sv(item.get("state"));
    match item.get("error").and_then(Value::as_str) {
        Some(error) if !error.is_empty() => {
            format!("connection: {state}, {}", js::head16(error, 200))
        }
        _ => format!("connection: {state}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_bytes_of_matches_stringify() {
        let values = vec![json!({"a": 1}), json!("é"), json!([])];
        assert_eq!(
            json_bytes_of(&values),
            json_bytes(&Value::Array(values.clone()))
        );
        assert_eq!(json_bytes_of(&[]), 2);
    }
}
