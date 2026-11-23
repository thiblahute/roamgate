//! What conversation mode shares with the web (`shared/agentChat.ts`) and
//! the agent profiles (`server/src/profiles/profiles.ts`) that its layers
//! need: the lease's shape, the other writer's words, the command a
//! session runs with.

use serde_json::{Map, Value};

/// A JavaScript object.
pub type Obj = Map<String, Value>;

/// The variable that keeps an agent in the terminal (`CLAUDE_START_ENV`).
pub const CLAUDE_START_ENV: &str = "ROAMGATE_CLAUDE_START";

/// A lease (`AgentChatLease`): who owns a pane's session. Bun's object as
/// it is, its keys in their order (its JSON text is the file's).
pub type Lease = Obj;

/// The lease's string field, if it is one.
pub fn lease_str<'a>(lease: &'a Lease, key: &str) -> Option<&'a str> {
    lease.get(key).and_then(Value::as_str)
}

/// The lease's `terminal_args`, its strings.
pub fn lease_terminal_args(lease: &Lease) -> Vec<String> {
    strings(lease.get("terminal_args"))
}

/// The lease's `headless_session_ids`.
pub fn lease_headless_ids(lease: &Lease) -> Vec<String> {
    strings(lease.get("headless_session_ids"))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Where the other writer is, by Herdr's names: "roamgate / Tab 2"
/// (`otherWriterPlace`).
pub fn other_writer_place(writer: &Obj) -> String {
    let names: Vec<&str> = ["workspace_label", "tab_label"]
        .iter()
        .filter_map(|key| writer.get(*key).and_then(Value::as_str))
        .filter(|name| !name.is_empty())
        .collect();
    if names.is_empty() {
        format!(
            "pane {}",
            writer.get("pane_id").and_then(Value::as_str).unwrap_or("")
        )
    } else {
        names.join(" / ")
    }
}

/// What the other writer does, said after where it is (`otherWriterDoing`).
pub fn other_writer_doing(writer: &Obj) -> String {
    let name = writer
        .get("agent_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    match writer.get("status").and_then(Value::as_str) {
        Some("idle") => format!(", where {name} is idle"),
        Some("working") => format!(", where {name} is working"),
        Some("blocked") => format!(", where {name} waits for an answer"),
        _ => String::new(),
    }
}

/// What a session runs with (`AgentCommand` of the agent profiles): its
/// profile, program and environment. Here until `roamgate-connections`
/// has the agent profiles.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentCommand {
    pub profile: String,
    pub agent: String,
    pub program: String,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    pub plain: bool,
    /// The model to start the session with this once.
    pub model: Option<String>,
}

impl AgentCommand {
    /// Plain `claude`, as before profiles (`PLAIN_CLAUDE`).
    pub fn plain_claude() -> Self {
        Self {
            profile: "default".into(),
            agent: "claude".into(),
            program: "claude".into(),
            plain: true,
            ..Self::default()
        }
    }

    /// Its environment as a JavaScript object, in its order.
    pub fn env_object(&self) -> Obj {
        self.env
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect()
    }
}

/// An agent start typed into a pane as a token (`LaunchSpec`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LaunchSpec {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    pub agent: String,
    /// Set ROAMGATE_CLAUDE_START=terminal (the agent stays in the terminal).
    pub terminal: bool,
}

/// Agent arguments without any `--model` (`withoutModel`).
pub fn without_model(args: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--model" {
            index += 2;
            continue;
        }
        if !arg.starts_with("--model=") {
            kept.push(arg.clone());
        }
        index += 1;
    }
    kept
}

/// Agent arguments with `--model` set to `model`, any earlier one dropped
/// (`withModel`); the same arguments when there is none.
pub fn with_model(args: &[String], model: Option<&str>) -> Vec<String> {
    match model {
        Some(model) if !model.is_empty() => {
            let mut kept = without_model(args);
            kept.push("--model".into());
            kept.push(model.into());
            kept
        }
        _ => args.to_vec(),
    }
}

/// A refused handover (`{ok: false, reason}`).
pub fn refuse(reason: impl Into<String>) -> Obj {
    let mut result = Obj::new();
    result.insert("ok".into(), Value::Bool(false));
    result.insert("reason".into(), Value::String(reason.into()));
    result
}

/// An accepted handover (`{ok: true, owner, session_id}`).
pub fn accepted(owner: &str, session_id: &str) -> Obj {
    let mut result = Obj::new();
    result.insert("ok".into(), Value::Bool(true));
    result.insert("owner".into(), Value::String(owner.into()));
    result.insert("session_id".into(), Value::String(session_id.into()));
    result
}

/// Whether a handover result says ok.
pub fn is_ok(result: &Obj) -> bool {
    result.get("ok").and_then(Value::as_bool) == Some(true)
}

/// A handover result's reason, or "".
pub fn reason(result: &Obj) -> &str {
    result.get("reason").and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_model_replaces_any_model() {
        let args: Vec<String> = ["--model", "opus", "--x", "--model=haiku"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            with_model(&args, Some("sonnet")),
            ["--x", "--model", "sonnet"]
        );
        assert_eq!(with_model(&args, None), args);
    }
}
