//! server/src/profiles/rpc.ts: `agent_profile.get` (the pane session's
//! profile, the others, the usage limit it stopped on and the model it
//! runs), `agent_profile.switch` (runs the session with another profile
//! now: same session, resumed), `agent_profile.launch` (what to type to
//! start a new session with a profile), `agent_profile.retry` (goes on
//! after a usage limit), and the return to the default profile once a
//! limit reset.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use fancy_regex::Regex;
use serde_json::{Map, Value, json};

use super::shared::{
    ModelChoice, all_profiles, chosen_model_answered, is_plain_profile, latest_session_answer,
    latest_session_model, latest_transcript_model, latest_usage_limit, profile_agent,
    profile_model_label, profile_name, profile_named, switch_model,
};
use super::store::{
    LaunchSpec, NowMs, SessionProfiles, profile_command, profile_for_session, profiles_list,
    profiles_of,
};
use roamgate_base::log::iso_millis;

/// A future borrowing its host.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A restart's outcome: Ok, or why not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Restart {
    pub ok: bool,
    pub reason: Option<String>,
}

impl Restart {
    pub fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }

    pub fn refused(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
        }
    }

    /// From Bun's `{ok, reason?}`.
    pub fn from_value(value: &Value) -> Self {
        Self {
            ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

/// What the session RPCs need of a connection (`ProfileRpcDeps`).
pub trait ProfileRpcHost: Send + Sync {
    /// settings.json as the server holds it (`GuiSettings`).
    fn read_settings(&self) -> HostFuture<'_, Result<Value, String>>;
    /// Herdr's agent in the pane (agent.get, the Claude mod's word laid
    /// over it), or None.
    fn agent_get<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<Value>>;
    /// The session conversation mode owns in the pane, if it does.
    fn conversation_session<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>>;
    /// The model conversation mode's running agent last named, if any.
    fn conversation_model<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>>;
    fn restart_process<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Restart>;
    fn restart_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        session_id: Option<&'a str>,
    ) -> HostFuture<'a, Restart>;
    /// The end of the pane session's transcript, or None.
    fn transcript_tail<'a>(&'a self, pane_id: &'a str) -> HostFuture<'a, Option<String>>;
    /// What to type into the pane to start `spec` (a one-use token).
    fn typed_launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> HostFuture<'a, Result<String, String>>;
    /// Sends a message to the session: conversation mode's queue.
    fn send_conversation<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>>;
    /// A prompt for the terminal's Claude (its Claude mod, else typed once
    /// idle).
    fn prompt_terminal<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> HostFuture<'a, Result<(), String>>;
    /// What the pane's live Claude mod last said of usage, if it runs one.
    fn mod_usage<'a>(&'a self, _pane_id: &'a str) -> HostFuture<'a, Option<Value>> {
        Box::pin(async { None })
    }
    fn log(&self, _message: &str, _fields: Value) {}
}

/// What the RPCs keep: the session choices, the clock, the home secret
/// files are read from.
#[derive(Clone)]
pub struct ProfileRpcContext {
    pub store: Arc<SessionProfiles>,
    pub now: NowMs,
    pub home: PathBuf,
}

/// An RPC refused with a message (`ProfileRpcError`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileRpcError(pub String);

impl std::fmt::Display for ProfileRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProfileRpcError {}

/// What a retry sends: Claude Code's own word for going on.
pub const RETRY_TEXT: &str = "continue";

/// The methods of the family.
pub const PROFILE_RPC_METHODS: &[&str] = &[
    "agent_profile.get",
    "agent_profile.switch",
    "agent_profile.launch",
    "agent_profile.retry",
];

/// A refusal said of the agent, not of its program; commands stay.
pub fn agent_neutral(reason: &str) -> String {
    static POSSESSIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bClaude's\b").unwrap());
    static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bClaude\b(?! Code)").unwrap());
    let text = POSSESSIVE.replace_all(reason, "the agent's");
    let text = NAME.replace_all(&text, "the agent").into_owned();
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn session_of(agent: &Value) -> Option<String> {
    let session = agent.get("agent_session")?.as_object()?;
    (session.get("kind").and_then(Value::as_str) == Some("id"))
        .then(|| {
            session
                .get("value")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Owner {
    Conversation,
    Terminal,
}

impl Owner {
    fn as_str(self) -> &'static str {
        match self {
            Owner::Conversation => "conversation",
            Owner::Terminal => "terminal",
        }
    }
}

struct PaneSession {
    session_id: String,
    owner: Owner,
    status: String,
}

/// The pane's Claude session and who runs it; None when none.
async fn pane_session(host: &dyn ProfileRpcHost, pane_id: &str) -> Option<PaneSession> {
    if let Some(owned) = host.conversation_session(pane_id).await {
        return Some(PaneSession {
            session_id: owned,
            owner: Owner::Conversation,
            status: String::new(),
        });
    }
    let agent = host.agent_get(pane_id).await?;
    if agent.get("agent").and_then(Value::as_str) != Some("claude") {
        return None;
    }
    Some(PaneSession {
        session_id: session_of(&agent)?,
        owner: Owner::Terminal,
        status: agent
            .get("agent_status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    })
}

/// The model a Claude session runs now, the surest first.
pub fn running_model(
    live: Option<&str>,
    chosen: Option<&str>,
    transcript_tail: Option<&str>,
    profile_model: Option<&Value>,
) -> Option<String> {
    let some = |text: Option<&str>| text.filter(|text| !text.is_empty()).map(str::to_owned);
    some(live)
        .or_else(|| some(chosen))
        .or_else(|| {
            transcript_tail
                .filter(|tail| !tail.is_empty())
                .and_then(|tail| latest_session_model(tail, |_| true))
        })
        .or_else(|| {
            profile_model
                .and_then(Value::as_str)
                .map(roamgate_base::settings::js_trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
        })
}

fn text_of<'a>(choice: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    choice.get(key).and_then(Value::as_str)
}

fn err(message: impl Into<String>) -> ProfileRpcError {
    ProfileRpcError(message.into())
}

/// One `agent_profile.*` call.
pub async fn handle_profile_rpc(
    method: &str,
    params: &Map<String, Value>,
    host: &dyn ProfileRpcHost,
    context: &ProfileRpcContext,
) -> Result<Value, ProfileRpcError> {
    let now = || (context.now)();
    let store = &context.store;
    let settings = host.read_settings().await.map_err(err)?;
    let profiles = profiles_of(Some(&settings));
    let list = profiles_list(&profiles);
    let offered = all_profiles(&list);
    let default_name = profile_named(&list, profiles.get("default").and_then(Value::as_str))
        .map(|profile| profile_name(&profile).to_owned())
        .unwrap_or_else(|| profile_name(&offered[0]).to_owned());
    let listed: Vec<Value> = offered
        .iter()
        .map(|profile| {
            json!({
                "name": profile_name(profile),
                "agent": profile_agent(profile),
                "label": profile_model_label(profile),
                "default": profile_name(profile) == default_name,
            })
        })
        .collect();
    let pane_id = match params.get("pane_id") {
        Some(Value::String(pane_id)) if !pane_id.is_empty() => pane_id.clone(),
        _ => return Err(err("pane_id is required")),
    };

    if method == "agent_profile.launch" {
        let wanted = match params.get("profile") {
            Some(Value::String(profile)) => profile.clone(),
            _ => default_name.clone(),
        };
        let profile = profile_named(&list, Some(&wanted))
            .ok_or_else(|| err(format!("No profile is named {wanted}")))?;
        if is_plain_profile(&profile) {
            return Ok(json!({"text": null, "profile": profile_name(&profile)}));
        }
        let command = profile_command(&profile, &context.home).map_err(err)?;
        let typed = host
            .typed_launch(
                &pane_id,
                LaunchSpec {
                    argv: vec![command.program.clone()],
                    env: command.env.clone(),
                    unset: command.unset.clone(),
                    agent: command.agent.clone(),
                    terminal: false,
                },
            )
            .await
            .map_err(err)?;
        return Ok(json!({
            "text": roamgate_base::settings::js_trim(&typed),
            "profile": profile_name(&profile),
        }));
    }

    let pane = pane_session(host, &pane_id).await;
    if method == "agent_profile.get" {
        let tail = host.transcript_tail(&pane_id).await;
        let Some(pane) = pane else {
            // Another agent (Pi, Codex): the model its transcript names.
            let model = tail.as_deref().and_then(latest_transcript_model);
            let mut result = Map::new();
            result.insert("session_id".into(), Value::Null);
            result.insert("profiles".into(), Value::Array(listed));
            result.insert("default".into(), json!(default_name));
            if let Some(model) = model {
                result.insert("model".into(), json!(model));
            }
            return Ok(Value::Object(result));
        };
        let profile = profile_for_session(Some(&settings), Some(&pane.session_id), Some(store));
        let mut limit = Value::Null;
        if params.get("limit") != Some(&Value::Bool(false)) {
            limit = tail
                .as_deref()
                .filter(|tail| !tail.is_empty())
                .and_then(|tail| latest_usage_limit(tail, now()))
                .unwrap_or(Value::Null);
            // Started with a model of its own: once it answered with it,
            // Claude Code resumes on that by itself.
            if let Some(chosen) = store.get(Some(&pane.session_id))
                && let Some(model) = text_of(&chosen, "model").filter(|model| !model.is_empty())
                && let Some(answer) = tail
                    .as_deref()
                    .filter(|tail| !tail.is_empty())
                    .and_then(|tail| latest_session_answer(tail, |_| true))
            {
                let choice = ModelChoice {
                    model: model.to_owned(),
                    resolved: text_of(&chosen, "model_resolved")
                        .filter(|resolved| !resolved.is_empty())
                        .map(str::to_owned),
                    at: text_of(&chosen, "model_at")
                        .or_else(|| text_of(&chosen, "at"))
                        .unwrap_or("")
                        .to_owned(),
                };
                if chosen_model_answered(&answer, &choice, &profile) {
                    store.settle_model(&pane.session_id);
                }
            }
        }
        let choice = store.get(Some(&pane.session_id));
        let usage = host.mod_usage(&pane_id).await;
        let live = match pane.owner {
            Owner::Conversation => host.conversation_model(&pane_id).await,
            // A terminal's Claude mod: the model its status line shows.
            Owner::Terminal => usage
                .as_ref()
                .and_then(|usage| usage.get("model"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let chosen = choice.as_ref().and_then(|choice| {
            text_of(choice, "model")
                .filter(|model| !model.is_empty())
                .map(|model| {
                    text_of(choice, "model_resolved")
                        .filter(|resolved| !resolved.is_empty())
                        .unwrap_or(model)
                        .to_owned()
                })
        });
        let model = running_model(
            live.as_deref(),
            chosen.as_deref(),
            tail.as_deref(),
            profile
                .get("env")
                .and_then(|env| env.get("ANTHROPIC_MODEL")),
        );
        let mut result = Map::new();
        result.insert("session_id".into(), json!(pane.session_id));
        result.insert("owner".into(), json!(pane.owner.as_str()));
        result.insert("profile".into(), json!(profile_name(&profile)));
        result.insert("label".into(), json!(profile_model_label(&profile)));
        if let Some(model) = model {
            result.insert("model".into(), json!(model));
        }
        result.insert("default".into(), json!(default_name));
        result.insert("profiles".into(), Value::Array(listed));
        result.insert("limit".into(), limit);
        // Exact context and plan usage, from the session's Claude mod.
        if let Some(usage) = usage.filter(|usage| !usage.is_null()) {
            result.insert("usage".into(), usage);
        }
        if let Some(choice) = &choice
            && choice
                .get("return_at")
                .is_some_and(|at| at.as_f64().is_some_and(|at| at != 0.0))
            && profiles.get("return_after_reset") == Some(&Value::Bool(true))
        {
            result.insert("returns_at".into(), choice["return_at"].clone());
            result.insert(
                "returns_to".into(),
                choice.get("return_to").cloned().unwrap_or(Value::Null),
            );
        }
        return Ok(Value::Object(result));
    }

    if method == "agent_profile.retry" {
        // After a usage limit (or a change of account): the same profile
        // tries again, as typing "continue" would.
        let pane = pane.ok_or_else(|| err("No agent session runs in this pane"))?;
        if pane.owner == Owner::Conversation {
            host.send_conversation(&pane_id, RETRY_TEXT)
                .await
                .map_err(err)?;
        } else {
            if !pane.status.is_empty() && pane.status != "idle" && pane.status != "done" {
                return Ok(json!({"ok": false, "reason": "The agent is not idle in the terminal"}));
            }
            host.prompt_terminal(&pane_id, RETRY_TEXT)
                .await
                .map_err(err)?;
        }
        host.log(
            "session retried after a usage limit",
            json!({"pane": pane_id, "session": pane.session_id, "owner": pane.owner.as_str()}),
        );
        return Ok(json!({"ok": true, "at": now()}));
    }

    if method == "agent_profile.switch" {
        let pane = pane.ok_or_else(|| err("No agent session runs in this pane"))?;
        if let Some(Value::String(asked)) = params.get("session_id")
            && *asked != pane.session_id
        {
            return Err(err("The pane now runs another session"));
        }
        let wanted = match params.get("profile") {
            Some(Value::String(profile)) => profile.clone(),
            _ => String::new(),
        };
        let profile = profile_named(&list, Some(&wanted))
            .ok_or_else(|| err(format!("No profile is named {wanted}")))?;
        let name = profile_name(&profile).to_owned();
        // A secret that cannot be read refuses here, before Claude exits.
        profile_command(&profile, &context.home).map_err(err)?;
        let previous = store.get(Some(&pane.session_id));
        let resets_at = params
            .get("resets_at")
            .and_then(Value::as_f64)
            .filter(|at| *at > now() as f64)
            .map(|at| at as i64);
        let back = resets_at
            .filter(|_| name != default_name)
            .map(|at| (at, default_name.clone()));
        // Claude Code resumes a session on the model it last answered
        // with: one this profile's endpoint lacks is replaced.
        let tail = host.transcript_tail(&pane_id).await;
        let model = switch_model(tail.as_deref(), &profile);
        store.set(
            &pane.session_id,
            (name != default_name).then_some(name.as_str()),
            back.as_ref().map(|(at, to)| (*at, to.as_str())),
            model.as_deref(),
        );
        let result = match pane.owner {
            Owner::Conversation => host.restart_process(&pane_id).await,
            Owner::Terminal => {
                host.restart_terminal(&pane_id, Some(&pane.session_id))
                    .await
            }
        };
        if !result.ok {
            // Nothing changed: the session keeps what it ran with.
            let previous_profile = previous
                .as_ref()
                .and_then(|choice| text_of(choice, "profile"));
            let previous_back = previous.as_ref().and_then(|choice| {
                let at = choice.get("return_at")?.as_f64()? as i64;
                let to = text_of(choice, "return_to").filter(|to| !to.is_empty())?;
                Some((at, to))
            });
            store.set(
                &pane.session_id,
                previous_profile,
                previous_back,
                previous
                    .as_ref()
                    .and_then(|choice| text_of(choice, "model")),
            );
            return Ok(json!({
                "ok": false,
                "reason": agent_neutral(result.reason.as_deref().unwrap_or("The switch was refused")),
            }));
        }
        let mut fields = json!({
            "pane": pane_id,
            "session": pane.session_id,
            "profile": name,
            "owner": pane.owner.as_str(),
        });
        if let Some((at, _)) = &back {
            fields["returns_at"] = json!(iso_millis(*at));
        }
        host.log("session switched profile", fields);
        return Ok(json!({
            "ok": true,
            "session_id": pane.session_id,
            "profile": name,
            "label": profile_model_label(&profile),
        }));
    }
    Err(err(format!("unknown method {method}")))
}

/// A connection as the return after a reset sees it: the panes and
/// sessions Herdr knows there, and a switch.
pub trait ResetConnection: Send + Sync {
    /// `(pane_id, session_id)` pairs; an error counts as none.
    fn panes(&self) -> HostFuture<'_, Vec<(String, String)>>;
    fn switch_pane<'a>(&'a self, pane_id: &'a str, profile: &'a str) -> HostFuture<'a, Restart>;
}

/// Sessions sent to another profile by a usage limit go back to their
/// default once it resets (when the setting says so): each pane running
/// one is switched, if idle; otherwise its next start uses the default.
pub async fn return_after_reset(
    settings: &Value,
    store: &SessionProfiles,
    connections: &[Arc<dyn ResetConnection>],
    log: &(dyn Fn(&str, Value) + Send + Sync),
) {
    if profiles_of(Some(settings)).get("return_after_reset") != Some(&Value::Bool(true)) {
        return;
    }
    let due = store.due();
    for each in due {
        let mut found = false;
        for connection in connections {
            let panes = connection.panes().await;
            let Some((pane_id, _)) = panes
                .iter()
                .find(|(_, session_id)| *session_id == each.session_id)
            else {
                continue;
            };
            found = true;
            let result = connection.switch_pane(pane_id, &each.to).await;
            // Refused (it works now): tried again at the next check.
            let mut fields = json!({"pane": pane_id, "session": each.session_id, "ok": result.ok});
            if !result.ok {
                fields["reason"] = json!(result.reason);
            }
            log("usage limit reset: back to the default profile", fields);
            break;
        }
        // Running nowhere: its next start is on the default.
        if !found {
            store.set(&each.session_id, None, None, None);
        }
    }
}

#[cfg(test)]
mod tests;
