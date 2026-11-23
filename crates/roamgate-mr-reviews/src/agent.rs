//! The reviews agent (`mr-reviews/agent.ts`): a chat in the Reviews panel
//! with a headless Claude Code agent, as Ranger's: each question is one
//! `claude -p` turn resumed from the chat's session, with only this
//! module's tools over a turn-scoped loopback MCP server
//! ([`crate::agent_tools`]). Not a pane session. The session id and the
//! chat are kept in `<data>/mr-reviews/agent.json`, the Claude Code
//! session's own folder in `<data>/mr-reviews/agent/claude`.
//!
//! The turns run through a [`ReviewsAgentDriver`]. The production one is
//! `roamgate-claude`'s `ClaudeCodeDriver` with a `ClaudeMcp("reviews")`
//! serving the turn's [`ReviewsAgentTools`] (S23, on `rust/s23-adapters`
//! until it lands on `rust/main`), the integration wave's to plug in; until
//! then Bun runs the agent.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::js::{self, Obj};
use roamgate_assistant::driver::RunEvent;
use roamgate_assistant::ranger_driver::is_claude_code_pointer;
use roamgate_base::paths::{DataContext, random_uuid};
use roamgate_base::private::create_dir_all_mode;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::agent_tools::{
    FORGE_CALLS_PER_TURN, MrAgentToolDeps, ReviewsAgentTools, Seen, reviews_agent_system_prompt,
};
use crate::connection::BoxFuture;

/// The model measured best for the job (docs/ARCHITECTURE.md).
pub const REVIEWS_AGENT_MODEL: &str = "opus";
/// Messages kept in the chat.
const MESSAGES_KEPT: usize = 120;
/// Questions waiting behind the running one, at most.
const QUEUE_MAX: usize = 5;
const TEXT_MAX: usize = 32_000;
const QUESTION_MAX: usize = 8_000;
/// A change is written this long after the last one, unless said now.
const SAVE_DELAY: Duration = Duration::from_millis(1_000);

/// `mrAgentPath`: `<data>/mr-reviews/agent.json`.
pub fn mr_agent_path(data_root: &Path) -> PathBuf {
    data_root.join("mr-reviews").join("agent.json")
}

/// Where the Claude Code session lives (its cwd's parent): `agent` beside
/// the chat's file.
pub fn mr_agent_directory(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join("agent")
}

/// One question's turn, as the driver runs it (`driver.run`'s input).
#[derive(Clone)]
pub struct AgentTurn {
    pub model: String,
    /// The Claude Code session resumed (`--resume`); none for a new one.
    pub resume: Option<String>,
    pub text: String,
    pub system_prompt: String,
    /// The turn's tools, served over the loopback MCP server.
    pub tools: Arc<ReviewsAgentTools>,
    /// What the turn reports: text, messages, thinking, tools, an error.
    pub events: Arc<dyn Fn(RunEvent) + Send + Sync>,
    /// The entries to keep: a Claude Code pointer
    /// (`{type: "ranger-claude", session}`).
    pub checkpoint: Arc<dyn Fn(Vec<Value>) + Send + Sync>,
}

/// Runs the agent's turns (`createClaudeCodeDriver` with the reviews
/// agent's tools and system prompt, its MCP server named `reviews`, and
/// `ROAMGATE_REVIEWS_AGENT_COMMAND` as a stand-in for `claude`).
pub trait ReviewsAgentDriver: Send + Sync + 'static {
    /// A turn; an error is a failure to run it at all.
    fn run(
        &self,
        turn: AgentTurn,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<(), String>>;
    /// Stops the running turn.
    fn stop(&self) -> BoxFuture<'static, ()>;
    /// Stops it and frees what the driver holds (its MCP server).
    fn dispose(&self) -> BoxFuture<'static, ()>;
}

/// What the agent needs (`MrAgentDeps`).
#[derive(Clone)]
pub struct MrAgentDeps {
    pub tools: MrAgentToolDeps,
    pub context: DataContext,
    /// The chat's file ([`mr_agent_path`]).
    pub path: PathBuf,
    /// [`REVIEWS_AGENT_MODEL`] unless told otherwise.
    pub model: String,
    pub driver: Arc<dyn ReviewsAgentDriver>,
}

struct Saved {
    instance_id: String,
    session: Option<String>,
    messages: Vec<Value>,
}

fn last(messages: Vec<Value>, kept: usize) -> Vec<Value> {
    let skip = messages.len().saturating_sub(kept);
    messages.into_iter().skip(skip).collect()
}

/// A message as written, kept when it has an id and a role; a turn cut by
/// a restart: its tools ran or not, nothing more.
fn loaded(message: &Obj) -> Option<Value> {
    if !message.get("id").is_some_and(Value::is_string)
        || !matches!(
            message.get("role").and_then(Value::as_str),
            Some("user" | "assistant")
        )
    {
        return None;
    }
    let mut message = message.clone();
    let tools: Vec<Value> = message
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut tool| {
            if tool.get("status").and_then(Value::as_str) == Some("running") {
                tool["status"] = json!("failed");
            }
            tool
        })
        .collect();
    message.insert("tools".into(), Value::Array(tools));
    if message.get("sources").is_none_or(Value::is_null) {
        message.insert("sources".into(), json!([]));
    }
    Some(Value::Object(message))
}

/// The chat as written, or a new one.
fn load(path: &Path) -> Saved {
    let raw = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(js::js_value);
    let Some(Value::Object(raw)) = raw else {
        return Saved {
            instance_id: random_uuid(),
            session: None,
            messages: vec![],
        };
    };
    let messages: Vec<Value> = raw
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(loaded)
        .collect();
    Saved {
        instance_id: raw
            .get("instance_id")
            .and_then(Value::as_str)
            .map_or_else(random_uuid, str::to_owned),
        session: raw
            .get("session")
            .and_then(Value::as_str)
            .map(str::to_owned),
        messages: last(messages, MESSAGES_KEPT),
    }
}

struct State {
    instance: String,
    session: Option<String>,
    messages: Vec<Value>,
    revision: u64,
    running: bool,
    error: Option<String>,
    queue: Vec<Value>,
    /// Per waiting question, the request id its answer carries.
    queued: Vec<(String, Option<String>)>,
    /// Requests read in this chat: their keys resolve without a call.
    seen: Arc<Mutex<Seen>>,
    cancel: Option<CancellationToken>,
    /// Bumped by each change: a delayed save writes only if still the last.
    save_generation: u64,
    save_pending: bool,
}

struct Inner {
    deps: MrAgentDeps,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a running turn is writing: its answer, and the text so far.
struct Draft {
    message: Obj,
    finalized: String,
    streamed: String,
    failed: bool,
}

/// The reviews agent's chat (`createMrAgent`): a cheap clone.
#[derive(Clone)]
pub struct MrAgent(Arc<Inner>);

impl MrAgent {
    pub fn new(deps: MrAgentDeps) -> MrAgent {
        let saved = load(&deps.path);
        MrAgent(Arc::new(Inner {
            deps,
            state: Mutex::new(State {
                instance: saved.instance_id,
                session: saved.session,
                messages: saved.messages,
                revision: 1,
                running: false,
                error: None,
                queue: vec![],
                queued: vec![],
                seen: Arc::default(),
                cancel: None,
                save_generation: 0,
                save_pending: false,
            }),
        }))
    }

    /// `MrAgentSnapshot`.
    pub fn snapshot(&self) -> Value {
        let state = lock(&self.0.state);
        let mut out = Obj::new();
        out.insert("instance_id".into(), json!(state.instance));
        out.insert("revision".into(), json!(state.revision));
        if let Some(session) = &state.session {
            out.insert("session_id".into(), json!(session));
        }
        out.insert("model".into(), json!(self.0.deps.model));
        out.insert("running".into(), json!(state.running));
        out.insert("error".into(), json!(state.error));
        out.insert("messages".into(), Value::Array(state.messages.clone()));
        out.insert("queue".into(), Value::Array(state.queue.clone()));
        Value::Object(out)
    }

    /// A question: answered now (`Ok(false)`), or after the running one
    /// when `when_busy_queue` (`Ok(true)`); refused otherwise.
    pub fn send(
        &self,
        raw: &str,
        request_id: Option<&str>,
        when_busy_queue: bool,
    ) -> Result<bool, String> {
        let text = js::head16(js::trim(raw), QUESTION_MAX);
        if text.is_empty() {
            return Err("the question is empty".into());
        }
        let mut state = lock(&self.0.state);
        if !state.running {
            self.0
                .begin(&mut state, text, request_id.map(str::to_owned));
            return Ok(false);
        }
        if !when_busy_queue {
            return Err("the reviews agent is answering".into());
        }
        if state.queue.len() >= QUEUE_MAX {
            return Err("too many questions waiting".into());
        }
        let id = request_id.map_or_else(random_uuid, str::to_owned);
        state.queue.push(json!({
            "id": id,
            "mode": "follow_up",
            "text": text,
            "sent_at": js::iso(js::now_ms()),
        }));
        state.queued.push((id, request_id.map(str::to_owned)));
        self.0.changed(&mut state, false);
        Ok(true)
    }

    /// Takes a waiting question back.
    pub fn unqueue(&self, id: &str) -> bool {
        let mut state = lock(&self.0.state);
        let before = state.queue.len();
        state.queue.retain(|entry| js::sv(entry.get("id")) != id);
        state.queued.retain(|(each, _)| each != id);
        let removed = state.queue.len() != before;
        if removed {
            self.0.changed(&mut state, false);
        }
        removed
    }

    fn abort(&self) {
        let mut state = lock(&self.0.state);
        state.queue.clear();
        state.queued.clear();
        if let Some(cancel) = &state.cancel {
            cancel.cancel();
        }
    }

    /// Stops the running answer; the waiting questions are dropped.
    pub async fn stop(&self) {
        self.abort();
        self.0.deps.driver.stop().await;
        let mut state = lock(&self.0.state);
        self.0.changed(&mut state, false);
    }

    /// A new chat: a new session, an empty conversation.
    pub async fn reset(&self) {
        self.abort();
        self.0.deps.driver.stop().await;
        let mut state = lock(&self.0.state);
        state.instance = random_uuid();
        state.session = None;
        state.messages.clear();
        state.seen = Arc::default();
        state.error = None;
        self.0.changed(&mut state, true);
    }

    pub async fn dispose(&self) {
        self.stop().await;
        self.0.deps.driver.dispose().await;
        let mut state = lock(&self.0.state);
        if state.save_pending {
            state.save_pending = false;
            state.save_generation += 1;
            self.0.save(&state);
        }
    }
}

impl Inner {
    fn save(&self, state: &State) {
        let path = &self.deps.path;
        if let Some(dir) = path.parent()
            && let Err(error) = create_dir_all_mode(dir)
        {
            tracing::warn!(target: "bridge.mr-reviews", "{}: {error}", dir.display());
            return;
        }
        let mut out = Obj::new();
        out.insert("instance_id".into(), json!(state.instance));
        if let Some(session) = &state.session {
            out.insert("session".into(), json!(session));
        }
        out.insert(
            "messages".into(),
            Value::Array(last(state.messages.clone(), MESSAGES_KEPT)),
        );
        let text = format!("{}\n", js::stringify(&Value::Object(out)));
        if let Err(error) = self
            .deps
            .context
            .replace_data_file(path, text.as_bytes(), 0o600)
        {
            tracing::warn!(target: "bridge.mr-reviews", "{}: {error}", path.display());
        }
    }

    /// A change: seen at once by the next read, written a moment later
    /// (now when `now`).
    fn changed(self: &Arc<Self>, state: &mut State, now: bool) {
        state.revision += 1;
        state.save_generation += 1;
        state.save_pending = false;
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) if !now => handle,
            _ => {
                self.save(state);
                return;
            }
        };
        state.save_pending = true;
        let generation = state.save_generation;
        let weak = Arc::downgrade(self);
        handle.spawn(async move {
            tokio::time::sleep(SAVE_DELAY).await;
            let Some(inner) = weak.upgrade() else { return };
            let mut state = lock(&inner.state);
            if state.save_generation == generation && state.save_pending {
                state.save_pending = false;
                inner.save(&state);
            }
        });
    }

    /// Starts a turn: the question and an empty answer in the chat at once,
    /// the turn itself in the background.
    fn begin(self: &Arc<Self>, state: &mut State, text: String, request_id: Option<String>) {
        state.running = true;
        state.error = None;
        let at = js::iso(js::now_ms());
        let message = |role: &str, text: &str| {
            let mut out = Obj::new();
            out.insert("id".into(), json!(random_uuid()));
            out.insert("role".into(), json!(role));
            out.insert("text".into(), json!(text));
            out.insert("sent_at".into(), json!(at));
            out.insert("tools".into(), json!([]));
            out.insert("sources".into(), json!([]));
            if let Some(id) = &request_id {
                out.insert("request_id".into(), json!(id));
            }
            out
        };
        state.messages.push(Value::Object(message("user", &text)));
        state.messages = last(std::mem::take(&mut state.messages), MESSAGES_KEPT);
        let draft = message("assistant", "");
        state.messages.push(Value::Object(draft.clone()));
        self.changed(state, true);
        let cancel = CancellationToken::new();
        state.cancel = Some(cancel.clone());
        let seen = state.seen.clone();
        let inner = self.clone();
        tokio::spawn(async move { inner.turn(text, draft, seen, cancel).await });
    }

    /// Writes the draft into the chat (unless a reset took it out).
    fn publish(self: &Arc<Self>, draft: &Obj) {
        let mut state = lock(&self.state);
        let id = draft.get("id");
        if let Some(slot) = state
            .messages
            .iter_mut()
            .find(|message| message.get("id") == id)
        {
            *slot = Value::Object(draft.clone());
        }
        self.changed(&mut state, false);
    }

    async fn turn(
        self: Arc<Self>,
        text: String,
        message: Obj,
        seen: Arc<Mutex<Seen>>,
        cancel: CancellationToken,
    ) {
        let draft = Arc::new(Mutex::new(Draft {
            message,
            finalized: String::new(),
            streamed: String::new(),
            failed: false,
        }));
        let budget = Arc::new(Mutex::new(FORGE_CALLS_PER_TURN));
        let show = {
            let (inner, draft) = (self.clone(), draft.clone());
            Arc::new(move |item: Obj| {
                let mut draft = lock(&draft);
                let mut opens = draft
                    .message
                    .get("opens")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                opens.push(Value::Object(item));
                draft.message.insert("opens".into(), Value::Array(opens));
                inner.publish(&draft.message);
            })
        };
        let tools = Arc::new(ReviewsAgentTools::new(
            self.deps.tools.clone(),
            seen,
            budget.clone(),
            show,
        ));
        let events: Arc<dyn Fn(RunEvent) + Send + Sync> = {
            let (inner, draft) = (self.clone(), draft.clone());
            Arc::new(move |event| {
                let mut draft = lock(&draft);
                if event_on(&mut draft, event) {
                    inner.publish(&draft.message);
                }
            })
        };
        let checkpoint: Arc<dyn Fn(Vec<Value>) + Send + Sync> = {
            let inner = self.clone();
            Arc::new(move |entries| {
                if is_claude_code_pointer(&entries) {
                    let mut state = lock(&inner.state);
                    state.session = entries[0]
                        .get("session")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    inner.changed(&mut state, true);
                }
            })
        };
        let run = |resume: Option<String>| {
            self.deps.driver.run(
                AgentTurn {
                    model: self.deps.model.clone(),
                    resume,
                    text: text.clone(),
                    system_prompt: reviews_agent_system_prompt(),
                    tools: tools.clone(),
                    events: events.clone(),
                    checkpoint: checkpoint.clone(),
                },
                cancel.clone(),
            )
        };
        let started = js::now_ms();
        let resumed = lock(&self.state).session.clone();
        let mut outcome = run(resumed.clone()).await;
        if outcome.is_ok() {
            let retry = {
                let mut draft = lock(&draft);
                // A session Claude Code no longer has (cleaned up): a new
                // one, once.
                let empty = js::sv(draft.message.get("text")).is_empty()
                    && draft
                        .message
                        .get("tools")
                        .and_then(Value::as_array)
                        .is_none_or(Vec::is_empty);
                let retry = draft.failed && resumed.is_some() && empty;
                if retry {
                    draft.failed = false;
                }
                retry
            };
            if retry {
                lock(&self.state).session = None;
                outcome = run(None).await;
            }
        }
        let (message, error) = {
            let mut draft = lock(&draft);
            let error = match outcome {
                Ok(()) if draft.failed && !cancel.is_cancelled() => {
                    Some("The reviews agent could not answer. Try again.".to_owned())
                }
                Err(message) if !cancel.is_cancelled() => Some(js::head16(&message, 300)),
                _ => None,
            };
            if error.is_some() {
                draft.message.insert("failed".into(), json!(true));
            }
            if let Some(tools) = draft.message.get_mut("tools").and_then(Value::as_array_mut) {
                for tool in tools {
                    if tool.get("status").and_then(Value::as_str) == Some("running") {
                        tool["status"] = json!("failed");
                    }
                }
            }
            (draft.message.clone(), error)
        };
        let tools_count = message
            .get("tools")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let forge_calls = FORGE_CALLS_PER_TURN - *lock(&budget);
        let ms = js::now_ms() - started;
        let mut state = lock(&self.state);
        let failed = error.is_some();
        if let Some(error) = error {
            state.error = Some(error);
        }
        if let Some(slot) = state
            .messages
            .iter_mut()
            .find(|each| each.get("id") == message.get("id"))
        {
            *slot = Value::Object(message);
        }
        state.cancel = None;
        state.running = false;
        self.changed(&mut state, true);
        if failed {
            tracing::info!(target: "bridge.mr-reviews", model = %self.deps.model, ms, tools = tools_count, forge_calls, failed = true, "reviews agent answered");
        } else {
            tracing::info!(target: "bridge.mr-reviews", model = %self.deps.model, ms, tools = tools_count, forge_calls, "reviews agent answered");
        }
        if !state.queue.is_empty() {
            let next = state.queue.remove(0);
            let id = js::sv(next.get("id")).to_owned();
            let request = state
                .queued
                .iter()
                .position(|(each, _)| *each == id)
                .and_then(|at| state.queued.remove(at).1);
            self.begin(&mut state, js::sv(next.get("text")).to_owned(), request);
        }
    }
}

/// A turn's event on its draft; whether the chat changed.
fn event_on(draft: &mut Draft, event: RunEvent) -> bool {
    fn joined(parts: [&str; 2]) -> String {
        let parts: Vec<&str> = parts.into_iter().filter(|part| !part.is_empty()).collect();
        js::head16(&parts.join("\n\n"), TEXT_MAX)
    }
    match event {
        RunEvent::Delta(value) => {
            draft.streamed = js::head16(&format!("{}{value}", draft.streamed), TEXT_MAX);
        }
        RunEvent::Message(value) => {
            if !value.is_empty() {
                draft.finalized = joined([&draft.finalized, &value]);
            }
            draft.streamed.clear();
        }
        RunEvent::Thinking(steps) => {
            let skip = steps.len().saturating_sub(8);
            let steps: Vec<String> = steps
                .iter()
                .skip(skip)
                .map(|step| js::head16(step, 4000))
                .collect();
            draft.message.insert("thinking".into(), json!(steps));
            return true;
        }
        RunEvent::Tool {
            id,
            name,
            status,
            details,
        } => {
            let details = details
                .as_ref()
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let Some(tools) = draft.message.get_mut("tools").and_then(Value::as_array_mut) else {
                return false;
            };
            if let Some(tool) = tools
                .iter_mut()
                .find(|tool| tool.get("id").and_then(Value::as_str) == Some(id.as_str()))
            {
                tool["status"] = json!(status);
                if let Some(output) = details.get("output") {
                    tool["output"] = output.clone();
                }
            } else if tools.len() < 64 {
                let mut tool = Obj::new();
                tool.insert("id".into(), json!(id));
                tool.insert("name".into(), json!(name));
                tool.insert("status".into(), json!(status));
                for (key, value) in details {
                    tool.insert(key, value);
                }
                tools.push(Value::Object(tool));
            }
            return true;
        }
        RunEvent::Error => {
            draft.failed = true;
            return false;
        }
        RunEvent::Replace(_) | RunEvent::Sources(_) | RunEvent::Steered { .. } => return false,
    }
    let text = joined([&draft.finalized, &draft.streamed]);
    draft.message.insert("text".into(), json!(text));
    true
}

#[cfg(test)]
mod tests;
