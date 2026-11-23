//! Agent sessions messaging each other through Roamgate
//! (`server/src/agent/agent-messenger.ts`; `roamgate-review sessions` and
//! `message`): the sessions Roamgate manages on every ready connection,
//! and messages delivered to them framed as another agent's, never as the
//! user's. A session in conversation mode gets one through Roamgate's
//! queue; a terminal Claude running Roamgate's mod through the mod, which
//! submits it once Claude is idle; any other terminal session through
//! Herdr's `agent.prompt`, once it is idle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::files::BoxFut;
use crate::js::{self, Obj};
use crate::shared::agent_message::{
    AGENT_MESSAGE_MAX_CHARS, AgentMessageSender, agent_address, clean_agent_message_text,
    frame_agent_message, parse_agent_address,
};

/// What a connection gives of its agents, as Herdr lists them.
#[derive(Clone, Debug, Default)]
pub struct MessengerSnapshot {
    pub workspaces: Vec<Value>,
    pub tabs: Vec<Value>,
    pub panes: Vec<Value>,
    pub agents: Vec<Value>,
}

/// A ready connection, as the messenger uses it.
pub trait MessengerRuntime: Send + Sync {
    /// Whether conversation mode holds the pane's session (any phase).
    fn holds<'a>(&'a self, pane_id: &'a str) -> BoxFut<'a, bool>;
    /// Its chat's status: idle, working, blocked, starting or stopped.
    fn status<'a>(&'a self, pane_id: &'a str) -> BoxFut<'a, String>;
    /// A message for the agent, queued or written now; false when the
    /// terminal owns the session.
    fn prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFut<'a, Result<bool, String>>;
    /// Whether the pane's Claude runs a live Claude mod to deliver through.
    fn has_claude_mod(&self) -> bool {
        false
    }
    /// Hands the text to the pane's Claude mod: false when it has none
    /// live (`ClaudeModDelivery.deliver` answering null).
    fn mod_deliver<'a>(
        &'a self,
        _pane_id: &'a str,
        _text: &'a str,
        _kind: &'a str,
    ) -> BoxFut<'a, bool> {
        Box::pin(async { false })
    }
    /// Whether the pane's Claude has the mod's tools (it said so lately).
    fn mod_has_tools<'a>(&'a self, _pane_id: &'a str) -> BoxFut<'a, bool> {
        Box::pin(async { false })
    }
    fn herdr_call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> BoxFut<'a, Result<Value, String>>;
    fn read(&self) -> BoxFut<'_, Result<MessengerSnapshot, String>>;
}

/// Where the turns a message starts are noted (`voice/turn-causes.ts`):
/// `{by: "companion"}` or `{by: "agent", name}`.
pub trait TurnCauseSink: Send + Sync {
    fn note(&self, connection_id: &str, pane_id: &str, cause: Value);
}

/// A refusal, with the HTTP status the agent socket answers it with.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentMessageError {
    pub message: String,
    pub status: u16,
}

impl AgentMessageError {
    fn new(message: impl Into<String>) -> Self {
        Self::with_status(message, 400)
    }

    fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

impl std::fmt::Display for AgentMessageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentMessageError {}

type MsgResult<T> = Result<T, AgentMessageError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Source {
    Message,
    Companion,
}

#[derive(Clone, Debug)]
struct Pending {
    id: u64,
    text: String,
    from: String,
    /// The sender's name, for the turn it starts.
    from_name: String,
    queued_at: f64,
    /// Who the Claude mod is told it comes from.
    source: Source,
}

const RATE_WINDOW_MS: f64 = 10.0 * 60_000.0;

pub type Log = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub type Now = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type Connections = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub type RuntimeOf = Arc<dyn Fn(&str) -> Option<Arc<dyn MessengerRuntime>> + Send + Sync>;

pub struct MessengerOptions {
    /// The ready connections, by id.
    pub connections: Connections,
    pub runtime: RuntimeOf,
    pub log: Option<Log>,
    pub now: Option<Now>,
    /// How often a terminal session is checked for idle while one waits.
    pub poll: Duration,
    /// How long a message waits for a busy terminal session.
    pub wait_limit_ms: f64,
    /// Messages a sender may send in ten minutes.
    pub sender_limit: usize,
    /// Messages between two sessions, both ways, in ten minutes.
    pub pair_limit: usize,
    /// Messages that may wait for one terminal session.
    pub waiting_limit: usize,
    /// Where the turns a message starts are noted as another agent's.
    pub causes: Option<Arc<dyn TurnCauseSink>>,
}

impl MessengerOptions {
    pub fn new(connections: Connections, runtime: RuntimeOf) -> Self {
        Self {
            connections,
            runtime,
            log: None,
            now: None,
            poll: Duration::from_millis(3000),
            wait_limit_ms: 30.0 * 60_000.0,
            sender_limit: 20,
            pair_limit: 8,
            waiting_limit: 5,
            causes: None,
        }
    }
}

#[derive(Default)]
struct State {
    sent: HashMap<String, Vec<f64>>,
    pairs: HashMap<String, Vec<f64>>,
    waiting: HashMap<String, Vec<Pending>>,
    timers: HashMap<String, JoinHandle<()>>,
    next_id: u64,
    disposed: bool,
}

struct Inner {
    options: MessengerOptions,
    log: Log,
    now: Now,
    state: Mutex<State>,
}

/// The messenger (`createAgentMessenger`), cheap to clone.
#[derive(Clone)]
pub struct AgentMessenger {
    inner: Arc<Inner>,
}

fn records(values: &[Value]) -> Vec<&Obj> {
    values.iter().filter_map(Value::as_object).collect()
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| js::trim(text).to_owned())
        .unwrap_or_default()
}

fn or(first: String, second: impl FnOnce() -> String) -> String {
    if first.is_empty() { second() } else { first }
}

/// A title worth showing: not a path, a number, or the agent's own name.
fn meaningful(value: &str, agent: &str) -> Option<String> {
    let stripped = js::trim(
        value.trim_start_matches(|c: char| js::is_js_space(c) || matches!(c, '✳' | '*' | '•')),
    );
    if stripped.is_empty()
        || stripped.starts_with(['~', '/'])
        || stripped.chars().all(|c| c.is_ascii_digit())
        || stripped.to_lowercase() == agent.to_lowercase()
    {
        return None;
    }
    let lower = stripped.to_ascii_lowercase();
    if [
        "zsh",
        "bash",
        "fish",
        "sh",
        "claude",
        "codex",
        "pi",
        "roamgate-hold",
    ]
    .contains(&lower.as_str())
    {
        return None;
    }
    Some(js::head16(stripped, 120))
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::Message => "message",
        Source::Companion => "companion",
    }
}

impl AgentMessenger {
    pub fn new(options: MessengerOptions) -> Self {
        let log = options.log.clone().unwrap_or_else(|| Arc::new(|_, _| {}));
        let now = options.now.clone().unwrap_or_else(|| Arc::new(js::now_ms));
        Self {
            inner: Arc::new(Inner {
                options,
                log,
                now,
                state: Mutex::new(State {
                    next_id: 1,
                    ..State::default()
                }),
            }),
        }
    }

    fn note_cause(&self, connection_id: &str, pane_id: &str, from_name: &str, source: Source) {
        let Some(causes) = &self.inner.options.causes else {
            return;
        };
        // The voice companion's work is its own turn, the others an
        // agent's.
        let cause = match source {
            Source::Companion => json!({ "by": "companion" }),
            Source::Message => json!({ "by": "agent", "name": from_name }),
        };
        causes.note(connection_id, pane_id, cause);
    }

    /// The sessions Roamgate manages on every ready connection, by address
    /// (`AgentSessionInfo` objects).
    pub async fn list(&self) -> Vec<Value> {
        let connections = (self.inner.options.connections)();
        let reads = connections.into_iter().map(|connection_id| async move {
            let runtime = (self.inner.options.runtime)(&connection_id)?;
            let snapshot = match runtime.read().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    (self.inner.log)(
                        "agent sessions not read",
                        json!({ "connection": connection_id, "error": error }),
                    );
                    return None;
                }
            };
            Some(
                self.sessions_of(&connection_id, runtime.as_ref(), &snapshot)
                    .await,
            )
        });
        let mut found: Vec<Value> = futures_util::future::join_all(reads)
            .await
            .into_iter()
            .flatten()
            .flatten()
            .collect();
        found
            .sort_by(|a, b| js::locale_compare(js::sv(a.get("address")), js::sv(b.get("address"))));
        found
    }

    async fn sessions_of(
        &self,
        connection_id: &str,
        runtime: &dyn MessengerRuntime,
        snapshot: &MessengerSnapshot,
    ) -> Vec<Value> {
        let by = |values: &[Value], key: &str| -> HashMap<String, Obj> {
            let mut map = HashMap::new();
            for each in records(values) {
                map.insert(text(each.get(key)), each.clone());
            }
            map
        };
        let workspaces = by(&snapshot.workspaces, "workspace_id");
        let tabs = by(&snapshot.tabs, "tab_id");
        let panes = by(&snapshot.panes, "pane_id");
        let empty = Obj::new();
        let mut found = Vec::new();
        for agent_record in records(&snapshot.agents) {
            let pane_id = text(agent_record.get("pane_id"));
            let pane = panes.get(&pane_id).unwrap_or(&empty);
            let agent = or(text(agent_record.get("agent")), || text(pane.get("agent")));
            if pane_id.is_empty() || agent.is_empty() {
                continue;
            }
            let workspace_id = or(text(agent_record.get("workspace_id")), || {
                text(pane.get("workspace_id"))
            });
            let workspace = workspaces.get(&workspace_id).unwrap_or(&empty);
            let tab_id = or(text(agent_record.get("tab_id")), || {
                text(pane.get("tab_id"))
            });
            let tab = tabs.get(&tab_id).unwrap_or(&empty);
            let workspace_name = or(text(workspace.get("label")), || {
                or(workspace_id.clone(), || connection_id.to_owned())
            });
            let title = meaningful(&text(tab.get("label")), &agent).or_else(|| {
                meaningful(
                    &or(text(agent_record.get("terminal_title_stripped")), || {
                        text(pane.get("terminal_title_stripped"))
                    }),
                    &agent,
                )
            });
            let conversation = runtime.holds(&pane_id).await;
            let state = if conversation {
                runtime.status(&pane_id).await
            } else {
                or(text(agent_record.get("agent_status")), || {
                    or(text(pane.get("agent_status")), || "unknown".into())
                })
            };
            let cwd = or(text(agent_record.get("cwd")), || {
                or(text(pane.get("cwd")), || {
                    text(agent_record.get("foreground_cwd"))
                })
            });
            found.push(json!({
                "address": agent_address(connection_id, &pane_id),
                "name": title.clone().unwrap_or_else(|| workspace_name.clone()),
                "title": title,
                "workspace": workspace_name,
                "workspace_id": workspace_id,
                "connection": connection_id,
                "agent": agent,
                "mode": if conversation { "conversation" } else { "terminal" },
                "state": state,
                "cwd": if cwd.is_empty() { Value::Null } else { Value::String(cwd) },
            }));
        }
        found
    }

    fn recent(&self, map: &mut HashMap<String, Vec<f64>>, key: &str) -> Vec<f64> {
        let since = (self.inner.now)() - RATE_WINDOW_MS;
        let kept: Vec<f64> = map
            .get(key)
            .map(|times| times.iter().copied().filter(|at| *at > since).collect())
            .unwrap_or_default();
        if kept.is_empty() {
            map.remove(key);
        } else {
            map.insert(key.to_owned(), kept.clone());
        }
        kept
    }

    fn retry_in(&self, times: &[f64]) -> String {
        let now = (self.inner.now)();
        let first = times.first().copied().unwrap_or(now);
        let seconds = ((first + RATE_WINDOW_MS - now) / 1000.0).ceil().max(1.0);
        if seconds < 120.0 {
            format!("{} s", js::number_text(seconds))
        } else {
            format!("{} minutes", js::number_text((seconds / 60.0).ceil()))
        }
    }

    fn pair_key(from: &str, to: &str) -> String {
        let mut pair = [from, to];
        pair.sort();
        pair.join("\n")
    }

    /// Refuses a message past the limits: a sender sending too many, or
    /// two sessions going back and forth (a loop of agents answering each
    /// other).
    fn check_rate(&self, from: &str, to: &str) -> MsgResult<()> {
        let options = &self.inner.options;
        let mut state = self.inner.state.lock().unwrap();
        let by_sender = self.recent(&mut state.sent, from);
        if by_sender.len() >= options.sender_limit {
            return Err(AgentMessageError::with_status(
                format!(
                    "too many messages: at most {} in ten minutes; try again in {}",
                    options.sender_limit,
                    self.retry_in(&by_sender)
                ),
                429,
            ));
        }
        let between = self.recent(&mut state.pairs, &Self::pair_key(from, to));
        if between.len() >= options.pair_limit {
            return Err(AgentMessageError::with_status(
                format!(
                    "too many messages between these two sessions ({} in ten minutes, both ways): this looks like a loop; stop and tell your user, or try again in {}",
                    options.pair_limit,
                    self.retry_in(&between)
                ),
                429,
            ));
        }
        Ok(())
    }

    fn record(&self, from: &str, to: &str) {
        let at = (self.inner.now)();
        let mut state = self.inner.state.lock().unwrap();
        let mut sent = self.recent(&mut state.sent, from);
        sent.push(at);
        state.sent.insert(from.to_owned(), sent);
        let pair = Self::pair_key(from, to);
        let mut between = self.recent(&mut state.pairs, &pair);
        between.push(at);
        state.pairs.insert(pair, between);
    }

    /// Types what waits for a terminal session once it is idle.
    fn schedule(&self, address: &str) {
        let mut state = self.inner.state.lock().unwrap();
        if state.disposed || state.timers.contains_key(address) {
            return;
        }
        let deadline = tokio::time::Instant::now() + self.inner.options.poll;
        let this = self.clone();
        let key = address.to_owned();
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            this.inner.state.lock().unwrap().timers.remove(&key);
            this.flush(&key).await;
        });
        state.timers.insert(address.to_owned(), timer);
    }

    fn waiting(&self, address: &str) -> Vec<Pending> {
        self.inner
            .state
            .lock()
            .unwrap()
            .waiting
            .get(address)
            .cloned()
            .unwrap_or_default()
    }

    /// Takes a delivered message out of its queue (by id: a message queued
    /// meanwhile stays).
    fn delivered(&self, address: &str, id: u64) {
        let mut state = self.inner.state.lock().unwrap();
        if let Some(queue) = state.waiting.get_mut(address) {
            queue.retain(|each| each.id != id);
            if queue.is_empty() {
                state.waiting.remove(address);
            }
        }
    }

    fn flush(&self, address: &str) -> BoxFut<'_, ()> {
        let address = address.to_owned();
        Box::pin(async move { self.flush_now(&address).await })
    }

    async fn flush_now(&self, address: &str) {
        let limit = (self.inner.now)() - self.inner.options.wait_limit_ms;
        let left = {
            let mut state = self.inner.state.lock().unwrap();
            if state.disposed {
                return;
            }
            let Some(queue) = state.waiting.get_mut(address) else {
                return;
            };
            if queue.is_empty() {
                return;
            }
            for each in queue.iter().filter(|each| each.queued_at <= limit) {
                (self.inner.log)(
                    "agent message expired waiting for its session",
                    json!({ "to": address, "from": each.from, "id": each.id }),
                );
            }
            queue.retain(|each| each.queued_at > limit);
            if queue.is_empty() {
                state.waiting.remove(address);
                return;
            }
            queue.clone()
        };
        let Some((connection_id, pane_id)) = parse_agent_address(address) else {
            return;
        };
        let Some(runtime) = (self.inner.options.runtime)(&connection_id) else {
            return self.schedule(address);
        };
        if let Err(error) = self
            .deliver_waiting(address, &connection_id, &pane_id, runtime.as_ref(), left)
            .await
        {
            (self.inner.log)(
                "agent message not delivered yet",
                json!({ "to": address, "error": error }),
            );
        }
        if !self.waiting(address).is_empty() {
            self.schedule(address);
        }
    }

    async fn deliver_waiting(
        &self,
        address: &str,
        connection_id: &str,
        pane_id: &str,
        runtime: &dyn MessengerRuntime,
        mut left: Vec<Pending>,
    ) -> std::result::Result<(), String> {
        // Taken by conversation mode meanwhile: its queue has them.
        if runtime.holds(pane_id).await {
            while let Some(next) = left.first().cloned() {
                if !runtime.prompt(pane_id, &next.text).await? {
                    break;
                }
                self.note_cause(connection_id, pane_id, &next.from_name, next.source);
                self.delivered(address, next.id);
                left.remove(0);
            }
        } else if runtime.has_claude_mod() {
            // A Claude mod came up meanwhile: it takes them all, in order.
            while let Some(next) = left.first().cloned() {
                if !runtime
                    .mod_deliver(pane_id, &next.text, source_name(next.source))
                    .await
                {
                    break;
                }
                self.note_cause(connection_id, pane_id, &next.from_name, next.source);
                self.delivered(address, next.id);
                left.remove(0);
                (self.inner.log)(
                    "agent message handed to the session's Claude mod",
                    json!({ "to": address, "from": next.from, "id": next.id }),
                );
            }
        }
        if !left.is_empty() && !runtime.holds(pane_id).await {
            let info = runtime
                .herdr_call("agent.get", json!({ "target": pane_id }), Some(5000))
                .await?;
            let state = text(
                info.get("agent")
                    .and_then(|agent| agent.get("agent_status")),
            );
            if state == "idle" || state == "done" {
                let next = left.remove(0);
                self.note_cause(connection_id, pane_id, &next.from_name, next.source);
                // Out of the queue before it is typed, as Bun shifts it.
                self.delivered(address, next.id);
                runtime
                    .herdr_call(
                        "agent.prompt",
                        json!({ "target": pane_id, "text": next.text }),
                        Some(5000),
                    )
                    .await?;
                (self.inner.log)(
                    "agent message delivered to an idle terminal session",
                    json!({ "to": address, "from": next.from, "id": next.id }),
                );
            }
        }
        Ok(())
    }

    fn enqueue(&self, address: &str, item: Pending) -> MsgResult<()> {
        let mut state = self.inner.state.lock().unwrap();
        let queue = state.waiting.entry(address.to_owned()).or_default();
        if queue.len() >= self.inner.options.waiting_limit {
            let limit = self.inner.options.waiting_limit;
            if queue.is_empty() {
                state.waiting.remove(address);
            }
            return Err(AgentMessageError::with_status(
                format!(
                    "{limit} messages already wait for that session to be idle; try again later"
                ),
                429,
            ));
        }
        queue.push(item);
        Ok(())
    }

    fn next_id(&self) -> u64 {
        let mut state = self.inner.state.lock().unwrap();
        let id = state.next_id;
        state.next_id += 1;
        id
    }

    /// Sends `text` from the session at `from` (connection, pane) to the
    /// session at `to`: `{sent, to, delivery, note}`.
    pub async fn send(&self, from: (&str, &str), to: &str, text: &str) -> MsgResult<Value> {
        let body = clean_agent_message_text(text);
        if body.is_empty() {
            return Err(AgentMessageError::new("say something: the text is empty"));
        }
        if js::len16(&body) > AGENT_MESSAGE_MAX_CHARS {
            return Err(AgentMessageError::new(format!(
                "keep it under {AGENT_MESSAGE_MAX_CHARS} characters; point to a file for more"
            )));
        }
        let Some((connection_id, pane_id)) = parse_agent_address(to) else {
            return Err(AgentMessageError::new(
                "an address is CONNECTION/PANE, as `roamgate-review sessions` lists them",
            ));
        };
        let address = agent_address(&connection_id, &pane_id);
        let from_address = agent_address(from.0, from.1);
        if address == from_address {
            return Err(AgentMessageError::new("that is your own session"));
        }
        let sessions = self.list().await;
        let find = |wanted: &str| {
            sessions
                .iter()
                .find(|each| js::sv(each.get("address")) == wanted)
                .cloned()
        };
        let Some(sender) = find(&from_address) else {
            return Err(AgentMessageError::with_status(
                "only an agent session Roamgate manages can send messages, and this pane runs none it knows",
                403,
            ));
        };
        let Some(receiver) = find(&address) else {
            return Err(AgentMessageError::with_status(
                format!(
                    "no agent session Roamgate manages is at {address}; run `roamgate-review sessions`"
                ),
                404,
            ));
        };
        self.check_rate(&from_address, &address)?;
        let sender_name = js::sv(sender.get("name")).to_owned();
        let from_sender = AgentMessageSender {
            address: from_address.clone(),
            name: sender_name.clone(),
            workspace: js::sv(sender.get("workspace")).to_owned(),
            agent: js::sv(sender.get("agent")).to_owned(),
        };
        let Some(runtime) = (self.inner.options.runtime)(&connection_id) else {
            return Err(AgentMessageError::with_status(
                "its connection is not ready",
                503,
            ));
        };
        // Its reply named as it makes one: the mod's tool, else the client.
        let tool = runtime.has_claude_mod() && runtime.mod_has_tools(&pane_id).await;
        let framed = frame_agent_message(&from_sender, &body, tool);
        let failed = |error: String| AgentMessageError::with_status(error, 500);
        let delivery = if js::sv(receiver.get("mode")) == "conversation"
            && runtime.prompt(&pane_id, &framed).await.map_err(failed)?
        {
            self.note_cause(&connection_id, &pane_id, &sender_name, Source::Message);
            "conversation"
        } else if self.waiting(&address).is_empty()
            && runtime.has_claude_mod()
            && runtime.mod_deliver(&pane_id, &framed, "message").await
        {
            self.note_cause(&connection_id, &pane_id, &sender_name, Source::Message);
            "mod"
        } else {
            let id = self.next_id();
            self.enqueue(
                &address,
                Pending {
                    id,
                    text: framed,
                    from: from_address.clone(),
                    from_name: sender_name.clone(),
                    queued_at: (self.inner.now)(),
                    source: Source::Message,
                },
            )?;
            // Idle now (and nothing waits before it): typed at once.
            self.flush(&address).await;
            if self.waiting(&address).iter().any(|each| each.id == id) {
                "waiting"
            } else {
                "terminal"
            }
        };
        self.record(&from_address, &address);
        (self.inner.log)(
            "agent message sent",
            json!({
                "from": from_address,
                "to": address,
                "chars": js::len16(&body),
                "delivery": delivery,
            }),
        );
        let note = match delivery {
            "conversation" => {
                "In its queue: it reads it at once when idle, else when its turn ends."
            }
            "mod" => {
                "Handed to its Claude: it reads it at once when idle, else when its turn ends."
            }
            "terminal" => "Typed into its terminal: it was idle.",
            _ => {
                "Its terminal is busy: Roamgate types it in once the session is idle (for up to 30 minutes)."
            }
        };
        Ok(json!({ "sent": true, "to": receiver, "delivery": delivery, "note": note }))
    }

    /// Hands `text` as it is (no frame, no rate limit: the voice
    /// companion's work for the user) to the session at `address`, the way
    /// `send` does.
    pub async fn deliver(&self, address: &str, text: &str) -> MsgResult<()> {
        let Some((connection_id, pane_id)) = parse_agent_address(address) else {
            return Err(AgentMessageError::new("an address is CONNECTION/PANE"));
        };
        let key = agent_address(&connection_id, &pane_id);
        let Some(runtime) = (self.inner.options.runtime)(&connection_id) else {
            return Err(AgentMessageError::with_status(
                "its connection is not ready",
                503,
            ));
        };
        if runtime
            .prompt(&pane_id, text)
            .await
            .map_err(|error| AgentMessageError::with_status(error, 500))?
        {
            return Ok(());
        }
        if self.waiting(&key).is_empty()
            && runtime.has_claude_mod()
            && runtime.mod_deliver(&pane_id, text, "companion").await
        {
            return Ok(());
        }
        let id = self.next_id();
        self.enqueue(
            &key,
            Pending {
                id,
                text: text.to_owned(),
                from: "voice companion".into(),
                from_name: "voice companion".into(),
                queued_at: (self.inner.now)(),
                source: Source::Companion,
            },
        )?;
        // Idle now (and nothing waits before it): typed at once.
        self.flush(&key).await;
        Ok(())
    }

    /// Messages waiting for a busy terminal session, by address.
    pub fn waiting_for(&self, address: &str) -> usize {
        self.waiting(address).len()
    }

    pub fn dispose(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.disposed = true;
        for (_, timer) in state.timers.drain() {
            timer.abort();
        }
        state.waiting.clear();
    }
}

#[cfg(test)]
mod tests;
