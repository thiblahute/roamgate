//! Roamgate's side of its Claude Code mod (server/claude-mod;
//! server/src/agent/claude-mod.ts): the inbox of each pane whose Claude
//! runs the mod, and what the mod says of the session.
//!
//! The mod long-polls `mod_poll` on the review socket and gets every
//! message for its pane it has not acknowledged, oldest first; it submits
//! each as a prompt once Claude is idle and acknowledges it (`mod_ack`)
//! once its turn started. A message leaves the inbox only then, so a mod
//! that restarts gets again what it had not submitted. The inbox is kept in
//! a file: a Roamgate restart loses nothing a busy session had not taken.
//!
//! A pane's mod is live while it polls. Delivery goes to the mod only then;
//! everything else is typed as before. Messages left when a mod goes away
//! are typed through Herdr once the pane's agent is idle, unless a mod comes
//! back first.
//!
//! The mod also reports turns, waits on the user, the model and usage
//! (`mod_event`): Roamgate lays that over Herdr's screen-detected status.
//!
//! A session with the mod's tools says so (`mod_tools`, every few minutes,
//! in conversation mode's headless claude too): what Roamgate sends that
//! pane then names the tools instead of the review client's commands.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use roamgate_agents::js::{date_parse, head16, stringify};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

/// `new Date(ms).toISOString()`.
fn iso(ms: i64) -> String {
    roamgate_agents::js::iso(ms as f64)
}

pub const CLAUDE_MOD_PROTOCOL: i64 = 1;
const STORE_VERSION: i64 = 1;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What a live mod says Claude is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeModStatus {
    Idle,
    Working,
    Blocked,
}

impl ClaudeModStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked => "blocked",
        }
    }
}

/// A mod's request Roamgate refuses, with the HTTP status to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeModError {
    pub message: String,
    pub status: u16,
}

impl ClaudeModError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 400,
        }
    }
}

impl std::fmt::Display for ClaudeModError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ClaudeModError {}

/// What typing an orphaned message did: typed, not yet (busy), or never.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeModTypeResult {
    Typed,
    Wait,
    Gone,
}

/// What changed of a pane's mod (`onChange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeModChange {
    Attach,
    Detach,
    Status,
    Usage,
    TurnComplete,
}

impl ClaudeModChange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Detach => "detach",
            Self::Status => "status",
            Self::Usage => "usage",
            Self::TurnComplete => "turn_complete",
        }
    }
}

/// Types a message whose mod went away (connection, pane, text).
pub type TypeFn = Arc<
    dyn Fn(String, String, String) -> BoxFuture<Result<ClaudeModTypeResult, String>> + Send + Sync,
>;
/// A pane's mod came, went, or said something new.
pub type ChangeFn = Arc<dyn Fn(&str, &str, ClaudeModChange) + Send + Sync>;
/// A log line and its fields.
pub type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;
/// What to run once the state's lock is released.
type After = Box<dyn FnOnce(&ClaudeModHub) + Send>;
/// Epoch milliseconds.
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

/// How the hub is made (`createClaudeModHub`'s arguments).
#[derive(Clone)]
pub struct ClaudeModOptions {
    /// Where the inbox is kept; None keeps it in memory.
    pub file: Option<PathBuf>,
    pub now: NowFn,
    pub log: Option<LogFn>,
    /// Each event a mod reports (debug level).
    pub debug: Option<LogFn>,
    pub type_message: Option<TypeFn>,
    pub on_change: Option<ChangeFn>,
    /// Longest hold of a poll (the mod's fetch gives up at 30 s).
    pub max_hold_ms: i64,
    /// A mod is live this long after its last poll ended.
    pub live_ms: i64,
    /// Its messages are typed instead after this long without a poll.
    pub orphan_ms: i64,
    /// How often orphaned messages are tried.
    pub sweep_ms: u64,
    /// How long an orphaned message may wait for an idle agent.
    pub orphan_limit_ms: i64,
    /// Messages older than this are dropped (a day).
    pub max_age_ms: i64,
    /// Messages a pane's inbox may hold.
    pub max_per_pane: usize,
    /// A terminal session has the tools this long after it last said so.
    pub tools_live_ms: i64,
    /// A headless one, stopped when idle and started again: this long.
    pub tools_headless_ms: i64,
}

impl Default for ClaudeModOptions {
    fn default() -> Self {
        Self {
            file: None,
            now: Arc::new(|| roamgate_base::clock::Clock::now(&roamgate_base::clock::SystemClock)),
            log: None,
            debug: None,
            type_message: None,
            on_change: None,
            max_hold_ms: 25_000,
            live_ms: 45_000,
            orphan_ms: 90_000,
            sweep_ms: 5_000,
            orphan_limit_ms: 30 * 60_000,
            max_age_ms: 24 * 60 * 60_000,
            max_per_pane: 50,
            tools_live_ms: 10 * 60_000,
            tools_headless_ms: 7 * 24 * 60 * 60_000,
        }
    }
}

#[derive(Debug, Clone)]
struct Item {
    id: i64,
    connection_id: String,
    pane_id: String,
    text: String,
    /// Who it is from, for the logs: review, message, companion, ...
    kind: String,
    queued_at: i64,
    held: bool,
}

#[derive(Debug, Clone)]
struct Attachment {
    client: String,
    session_id: String,
    claude: String,
    protocol: i64,
    /// Polls in flight; live while one is.
    polls: u32,
    last_seen: i64,
    since: i64,
    status: ClaudeModStatus,
    turn_reason: Option<String>,
    usage: Option<Value>,
    updated_at: i64,
    /// Clients this pane's newer mod replaced.
    superseded: HashSet<String>,
    /// It said goodbye: what it left is typed at once.
    gone: bool,
}

/// A pane whose Claude said it has the mod's tools.
#[derive(Debug, Clone)]
struct ToolsSession {
    session_id: String,
    client: String,
    seen_at: i64,
    /// Conversation mode's: Roamgate starts it again with the same tools.
    headless: bool,
    /// Its mod has the Work board's tools (`work_*`).
    work: bool,
    /// Its mod puts Roamgate's rules in the system prompt.
    rules: bool,
}

#[derive(Default)]
struct State {
    epoch: String,
    next_id: i64,
    items: Vec<Item>,
    /// By pane key, in the order they came (a Map's order).
    attachments: indexmap_lite::OrderedMap<Attachment>,
    tools: indexmap_lite::OrderedMap<ToolsSession>,
    /// Panes whose orphaned messages are being typed now.
    typing: HashSet<String>,
    disposed: bool,
    save_pending: bool,
}

/// A small insertion-ordered map by string key (a JS Map's iteration order).
mod indexmap_lite {
    #[derive(Debug, Clone)]
    pub struct OrderedMap<V> {
        entries: Vec<(String, V)>,
    }

    impl<V> Default for OrderedMap<V> {
        fn default() -> Self {
            Self {
                entries: Vec::new(),
            }
        }
    }

    impl<V> OrderedMap<V> {
        pub fn get(&self, key: &str) -> Option<&V> {
            self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }
        pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
            self.entries
                .iter_mut()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
        }
        pub fn set(&mut self, key: &str, value: V) {
            match self.get_mut(key) {
                Some(slot) => *slot = value,
                None => self.entries.push((key.to_owned(), value)),
            }
        }
        pub fn remove(&mut self, key: &str) -> Option<V> {
            let at = self.entries.iter().position(|(k, _)| k == key)?;
            Some(self.entries.remove(at).1)
        }
        pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
            self.entries.iter().map(|(k, v)| (k, v))
        }
        pub fn keys(&self) -> Vec<String> {
            self.entries.iter().map(|(k, _)| k.clone()).collect()
        }
    }
}

fn key(connection_id: &str, pane_id: &str) -> String {
    format!("{connection_id}\n{pane_id}")
}

fn split_key(at: &str) -> (String, String) {
    let mut parts = at.splitn(2, '\n');
    let connection = parts.next().unwrap_or("").to_owned();
    let pane = parts.next().unwrap_or("").to_owned();
    (connection, pane)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn number(value: f64) -> Value {
    roamgate_agents::js::number(value)
}

/// The usage a mod reported, kept to the fields Roamgate reads.
pub fn parse_mod_usage(event: &Map<String, Value>, at: &str) -> Value {
    let mut usage = Map::new();
    usage.insert("at".into(), json!(at));
    if let Some(model) = event.get("model").and_then(Value::as_str)
        && !model.is_empty()
    {
        usage.insert("model".into(), json!(head16(model, 200)));
    }
    if let Some(context) = event.get("context").and_then(Value::as_object) {
        let mut out = Map::new();
        for field in ["tokens", "window", "percent"] {
            if let Some(n) = finite(context.get(field)) {
                out.insert(field.into(), number(n));
            }
        }
        usage.insert("context".into(), Value::Object(out));
    }
    if let Some(limits) = event.get("rate_limits").and_then(Value::as_array) {
        let kept: Vec<Value> = limits
            .iter()
            .take(8)
            .filter_map(|each| {
                let each = each.as_object()?;
                let kind = each.get("kind")?.as_str()?;
                let used = finite(each.get("percent_used"))?;
                let mut out = Map::new();
                out.insert("kind".into(), json!(head16(kind, 40)));
                out.insert("percent_used".into(), number(used));
                if let Some(resets) = each.get("resets_at").and_then(Value::as_str)
                    && !date_parse(resets).is_nan()
                {
                    out.insert("resets_at".into(), json!(resets));
                }
                Some(Value::Object(out))
            })
            .collect();
        usage.insert("rate_limits".into(), Value::Array(kept));
    }
    if let Some(cost) = finite(event.get("cost_usd")) {
        usage.insert("cost_usd".into(), number(cost));
    }
    Value::Object(usage)
}

/// A mod's `mod_poll`.
#[derive(Debug, Clone, Default)]
pub struct PollInput {
    pub connection_id: String,
    pub pane_id: String,
    pub session_id: String,
    pub client: String,
    pub claude: String,
    /// The protocol the mod speaks (`Number(form.protocol)`: NaN as None).
    pub protocol: f64,
    pub after: f64,
    pub wait_ms: f64,
}

/// A mod's `mod_ack`.
#[derive(Debug, Clone, Default)]
pub struct AckInput {
    pub connection_id: String,
    pub pane_id: String,
    pub client: String,
    pub id: f64,
    pub outcome: String,
    pub reason: String,
}

/// A mod's `mod_event`.
#[derive(Debug, Clone, Default)]
pub struct EventInput {
    pub connection_id: String,
    pub pane_id: String,
    pub client: String,
    pub session_id: String,
    pub event: Map<String, Value>,
}

/// A session saying it has the mod's tools (`mod_tools`), or no longer.
#[derive(Debug, Clone, Default)]
pub struct ToolsInput {
    pub connection_id: String,
    pub pane_id: String,
    pub session_id: String,
    pub client: String,
    pub headless: bool,
    pub gone: bool,
    pub work: bool,
    pub rules: bool,
}

struct Inner {
    options: ClaudeModOptions,
    started_at: i64,
    state: Mutex<State>,
    /// Polls waiting for a message, by pane.
    waiters: Mutex<HashMap<String, Arc<Notify>>>,
    sweeper: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The hub (`createClaudeModHub`): cheap to clone.
#[derive(Clone)]
pub struct ClaudeModHub(Arc<Inner>);

/// Counts a poll in flight until it ends, however it ends.
struct PollGuard {
    hub: ClaudeModHub,
    at: String,
    client: String,
}

impl Drop for PollGuard {
    fn drop(&mut self) {
        let now = self.hub.now();
        let mut state = self.hub.lock();
        if let Some(attachment) = state.attachments.get_mut(&self.at)
            && attachment.client == self.client
        {
            attachment.polls = attachment.polls.saturating_sub(1);
            attachment.last_seen = now;
        }
    }
}

impl ClaudeModHub {
    pub fn new(options: ClaudeModOptions) -> Self {
        let started_at = (options.now)();
        let mut epoch = [0u8; 8];
        rand::Rng::fill(&mut rand::rng(), &mut epoch);
        let hub = Self(Arc::new(Inner {
            started_at,
            state: Mutex::new(State {
                epoch: hex::encode(epoch),
                next_id: 1,
                ..State::default()
            }),
            waiters: Mutex::default(),
            sweeper: Mutex::default(),
            options,
        }));
        hub.load();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let weak: Weak<Inner> = Arc::downgrade(&hub.0);
            let every = Duration::from_millis(hub.0.options.sweep_ms.max(1));
            let task = handle.spawn(async move {
                loop {
                    tokio::time::sleep(every).await;
                    let Some(inner) = weak.upgrade() else { return };
                    ClaudeModHub(inner).sweep().await;
                }
            });
            *hub.0.sweeper.lock().unwrap() = Some(task);
        }
        hub
    }

    fn now(&self) -> i64 {
        (self.0.options.now)()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn log(&self, message: &str, fields: Value) {
        match &self.0.options.log {
            Some(log) => log(message, fields),
            None => tracing::info!(fields = %fields, "{message}"),
        }
    }

    fn debug(&self, message: &str, fields: Value) {
        if let Some(debug) = &self.0.options.debug {
            debug(message, fields);
        }
    }

    fn changed(&self, connection_id: &str, pane_id: &str, change: ClaudeModChange) {
        if let Some(on_change) = &self.0.options.on_change {
            on_change(connection_id, pane_id, change);
        }
    }

    fn load(&self) {
        let Some(file) = &self.0.options.file else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(file) else {
            return;
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        if raw.get("version").and_then(Value::as_f64) != Some(STORE_VERSION as f64) {
            return;
        }
        let oldest = self.now() - self.0.options.max_age_ms;
        let mut state = self.lock();
        if let Some(epoch) = raw.get("epoch").and_then(Value::as_str)
            && !epoch.is_empty()
        {
            state.epoch = epoch.to_owned();
        }
        for each in raw
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(each) = each.as_object() else {
                continue;
            };
            let (Some(id), Some(connection), Some(pane), Some(text), Some(queued)) = (
                each.get("id").and_then(Value::as_f64),
                each.get("connection_id").and_then(Value::as_str),
                each.get("pane_id").and_then(Value::as_str),
                each.get("text").and_then(Value::as_str),
                each.get("queued_at").and_then(Value::as_f64),
            ) else {
                continue;
            };
            if queued < oldest as f64 {
                continue;
            }
            state.items.push(Item {
                id: id as i64,
                connection_id: connection.to_owned(),
                pane_id: pane.to_owned(),
                text: text.to_owned(),
                kind: each
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                queued_at: queued as i64,
                held: false,
            });
        }
        state.items.sort_by_key(|item| item.id);
        for each in raw
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(each) = each.as_object() else {
                continue;
            };
            let (Some(connection), Some(pane), Some(session), Some(client), Some(seen)) = (
                each.get("connection_id").and_then(Value::as_str),
                each.get("pane_id").and_then(Value::as_str),
                each.get("session_id").and_then(Value::as_str),
                each.get("client").and_then(Value::as_str),
                each.get("seen_at").and_then(Value::as_f64),
            ) else {
                continue;
            };
            state.tools.set(
                &key(connection, pane),
                ToolsSession {
                    session_id: session.to_owned(),
                    client: client.to_owned(),
                    work: each.get("work") == Some(&Value::Bool(true)),
                    rules: each.get("rules") == Some(&Value::Bool(true)),
                    seen_at: seen as i64,
                    headless: each.get("headless") == Some(&Value::Bool(true)),
                },
            );
        }
        let highest = state.items.last().map_or(0, |item| item.id);
        let stored = raw.get("next_id").and_then(Value::as_f64).unwrap_or(1.0) as i64;
        state.next_id = stored.max(highest + 1);
    }

    fn save(&self, state: &mut State) {
        if self.0.options.file.is_none() || state.save_pending || state.disposed {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                state.save_pending = true;
                let hub = self.clone();
                handle.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let mut state = hub.lock();
                    if !state.save_pending {
                        return;
                    }
                    state.save_pending = false;
                    hub.write_now(&state);
                });
            }
            Err(_) => self.write_now(state),
        }
    }

    fn tools_fresh(&self, entry: &ToolsSession) -> bool {
        let limit = if entry.headless {
            self.0.options.tools_headless_ms
        } else {
            self.0.options.tools_live_ms
        };
        self.now() - entry.seen_at < limit
    }

    fn write_now(&self, state: &State) {
        let Some(file) = &self.0.options.file else {
            return;
        };
        let items: Vec<Value> = state
            .items
            .iter()
            .map(|each| {
                json!({
                    "id": each.id,
                    "connection_id": each.connection_id,
                    "pane_id": each.pane_id,
                    "text": each.text,
                    "kind": each.kind,
                    "queued_at": each.queued_at,
                })
            })
            .collect();
        let tools: Vec<Value> = state
            .tools
            .iter()
            .filter(|(_, each)| self.tools_fresh(each))
            .map(|(at, each)| {
                let (connection, pane) = split_key(at);
                let mut out = Map::new();
                out.insert("connection_id".into(), json!(connection));
                out.insert("pane_id".into(), json!(pane));
                out.insert("session_id".into(), json!(each.session_id));
                out.insert("client".into(), json!(each.client));
                out.insert("seen_at".into(), json!(each.seen_at));
                if each.work {
                    out.insert("work".into(), json!(true));
                }
                if each.rules {
                    out.insert("rules".into(), json!(true));
                }
                out.insert("headless".into(), json!(each.headless));
                Value::Object(out)
            })
            .collect();
        let body = stringify(&json!({
            "version": STORE_VERSION,
            "epoch": state.epoch,
            "next_id": state.next_id,
            "items": items,
            "tools": tools,
        }));
        let written = (|| -> std::io::Result<()> {
            if let Some(parent) = file.parent() {
                create_private_dir(parent)?;
            }
            let temp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
            write_mode(&temp, body.as_bytes(), 0o600)?;
            std::fs::rename(&temp, file)
        })();
        if let Err(error) = written {
            self.log(
                "claude mod inbox not saved",
                json!({"error": error.to_string()}),
            );
        }
    }

    fn pane_count(state: &State, at: &str) -> (usize, usize) {
        let mut waiting = 0;
        let mut held = 0;
        for each in &state.items {
            if key(&each.connection_id, &each.pane_id) == at {
                waiting += 1;
                if each.held {
                    held += 1;
                }
            }
        }
        (waiting, held)
    }

    fn notify_of(&self, at: &str) -> Arc<Notify> {
        self.0
            .waiters
            .lock()
            .unwrap()
            .entry(at.to_owned())
            .or_default()
            .clone()
    }

    fn wake(&self, at: &str) {
        let notify = self.0.waiters.lock().unwrap().remove(at);
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn is_live(&self, attachment: Option<&Attachment>) -> bool {
        attachment.is_some_and(|attachment| {
            !attachment.gone
                && (attachment.polls > 0
                    || self.now() - attachment.last_seen < self.0.options.live_ms)
        })
    }

    /// A session says it has the mod's tools (`mod_tools`), or no longer
    /// (`gone`, its claude exits). Kept in the inbox's file: conversation
    /// mode's claude is stopped when idle and started again with them.
    pub fn tools(&self, input: ToolsInput) -> Result<Value, ClaudeModError> {
        if input.client.is_empty() {
            return Err(ClaudeModError::new("the mod sent no client id"));
        }
        let at = key(&input.connection_id, &input.pane_id);
        let now = self.now();
        let mut state = self.lock();
        let known = state.tools.get(&at).cloned();
        if input.gone {
            // Only the session that said it: a newer one in the pane stays.
            if known.is_some_and(|known| known.client == input.client) {
                state.tools.remove(&at);
                self.save(&mut state);
            }
            return Ok(json!({"ok": true}));
        }
        let fresh = known.is_none_or(|known| {
            known.client != input.client
                || known.session_id != input.session_id
                || known.headless != input.headless
                || known.work != input.work
                || known.rules != input.rules
        });
        state.tools.set(
            &at,
            ToolsSession {
                session_id: input.session_id.clone(),
                client: input.client.clone(),
                seen_at: now,
                headless: input.headless,
                work: input.work,
                rules: input.rules,
            },
        );
        // Each hello moves the time; the file only needs it for a headless one.
        if fresh || input.headless {
            self.save(&mut state);
        }
        drop(state);
        if fresh {
            self.debug(
                "claude mod tools",
                json!({
                    "connection": input.connection_id,
                    "pane": input.pane_id,
                    "session": input.session_id,
                    "headless": input.headless,
                }),
            );
        }
        Ok(json!({"ok": true}))
    }

    fn snapshot(&self, state: &State, at: &str, attachment: &Attachment) -> Value {
        let (connection, pane) = split_key(at);
        let (waiting, held) = Self::pane_count(state, at);
        let mut out = Map::new();
        out.insert("connection_id".into(), json!(connection));
        out.insert("pane_id".into(), json!(pane));
        out.insert("session_id".into(), json!(attachment.session_id));
        out.insert("claude".into(), json!(attachment.claude));
        out.insert("protocol".into(), json!(attachment.protocol));
        out.insert("status".into(), json!(attachment.status.as_str()));
        if let Some(reason) = attachment.turn_reason.as_deref().filter(|r| !r.is_empty()) {
            out.insert("turn_reason".into(), json!(reason));
        }
        if let Some(usage) = &attachment.usage {
            out.insert("usage".into(), usage.clone());
        }
        out.insert("waiting".into(), json!(waiting));
        out.insert("held".into(), json!(held));
        out.insert("since".into(), json!(iso(attachment.since)));
        out.insert("updated_at".into(), json!(iso(attachment.updated_at)));
        Value::Object(out)
    }

    fn messages_for(state: &State, at: &str, after: i64) -> Vec<Value> {
        state
            .items
            .iter()
            .filter(|each| key(&each.connection_id, &each.pane_id) == at && each.id > after)
            .take(20)
            .map(|each| json!({"id": each.id, "text": each.text}))
            .collect()
    }

    /// The pane's attachment for this client, made when it is new (its first
    /// poll or event: the newest client takes the pane); false for a client a
    /// newer one replaced. Changes to report come back in `changes`.
    #[allow(clippy::too_many_arguments)]
    fn attach(
        &self,
        state: &mut State,
        at: &str,
        connection_id: &str,
        pane_id: &str,
        session_id: &str,
        client: &str,
        claude: Option<&str>,
        protocol: Option<i64>,
        after: &mut Vec<After>,
    ) -> bool {
        let now = self.now();
        if let Some(attachment) = state.attachments.get_mut(at) {
            if attachment.superseded.contains(client) {
                return false;
            }
            if attachment.client == client && !attachment.gone {
                if let Some(claude) = claude.filter(|c| !c.is_empty()) {
                    attachment.claude = head16(claude, 80);
                }
                if let Some(protocol) = protocol.filter(|p| *p != 0) {
                    attachment.protocol = protocol;
                }
                if !session_id.is_empty() && session_id != attachment.session_id {
                    attachment.session_id = session_id.to_owned();
                    attachment.updated_at = now;
                    let (c, p) = (connection_id.to_owned(), pane_id.to_owned());
                    after.push(Box::new(move |hub| {
                        hub.changed(&c, &p, ClaudeModChange::Status)
                    }));
                }
                return true;
            }
        }
        let existing = state.attachments.get(at);
        let previous = existing
            .filter(|attachment| attachment.client != client)
            .map(|attachment| attachment.client.clone());
        let mut superseded: HashSet<String> = existing
            .map(|attachment| attachment.superseded.clone())
            .unwrap_or_default();
        if let Some(previous) = &previous {
            superseded.insert(previous.clone());
        }
        let attachment = Attachment {
            client: client.to_owned(),
            session_id: session_id.to_owned(),
            claude: head16(claude.unwrap_or(""), 80),
            protocol: protocol.unwrap_or(CLAUDE_MOD_PROTOCOL),
            polls: 0,
            last_seen: now,
            since: now,
            status: ClaudeModStatus::Idle,
            turn_reason: None,
            usage: None,
            updated_at: now,
            superseded,
            gone: false,
        };
        let claude_text = attachment.claude.clone();
        state.attachments.set(at, attachment);
        // The replaced mod's waiting poll answers now: superseded.
        let at_owned = at.to_owned();
        let (c, p, s) = (
            connection_id.to_owned(),
            pane_id.to_owned(),
            session_id.to_owned(),
        );
        let replaced = previous.is_some();
        after.push(Box::new(move |hub| {
            hub.wake(&at_owned);
            let mut fields = json!({"connection": c, "pane": p, "session": s});
            if !claude_text.is_empty() {
                fields["claude"] = json!(claude_text);
            }
            if replaced {
                fields["replaced"] = json!(true);
            }
            hub.log("claude mod attached", fields);
            hub.changed(&c, &p, ClaudeModChange::Attach);
        }));
        true
    }

    fn run_after(&self, after: Vec<After>) {
        for each in after {
            each(self);
        }
    }

    /// Says hello and waits for messages (`mod_poll`). Dropping the future
    /// (the request went away) ends the wait, as the TS abort signal does.
    pub async fn poll(&self, input: PollInput) -> Result<Value, ClaudeModError> {
        if input.client.is_empty() {
            return Err(ClaudeModError::new("the mod sent no client id"));
        }
        if !roamgate_agents::js::is_safe_integer(input.protocol) || input.protocol < 1.0 {
            return Err(ClaudeModError::new("the mod sent no protocol version"));
        }
        let at = key(&input.connection_id, &input.pane_id);
        let mut after = Vec::new();
        let (mut messages, floor, _guard) = {
            let mut state = self.lock();
            let attached = self.attach(
                &mut state,
                &at,
                &input.connection_id,
                &input.pane_id,
                &input.session_id,
                &input.client,
                Some(&input.claude),
                Some(input.protocol as i64),
                &mut after,
            );
            if !attached {
                drop(state);
                self.run_after(after);
                return Ok(json!({"protocol": CLAUDE_MOD_PROTOCOL, "superseded": true}));
            }
            let now = self.now();
            let attachment = state.attachments.get_mut(&at).expect("attached");
            attachment.polls += 1;
            attachment.last_seen = now;
            let guard = PollGuard {
                hub: self.clone(),
                at: at.clone(),
                client: input.client.clone(),
            };
            let floor = if input.after.is_finite() {
                input.after.floor().max(0.0) as i64
            } else {
                0
            };
            let messages = Self::messages_for(&state, &at, floor);
            (messages, floor, guard)
        };
        // A new attachment wakes the poll it replaced before this one waits.
        self.run_after(after);
        let waiter = self.notify_of(&at);
        let wait = if input.wait_ms.is_finite() {
            input.wait_ms
        } else {
            0.0
        };
        let hold = (wait.max(0.0) as i64).min(self.0.options.max_hold_ms);
        if messages.is_empty() && hold > 0 {
            let notified = waiter.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // A message may have come between the read and the registration.
            let again = Self::messages_for(&self.lock(), &at, floor);
            let woke = !again.is_empty()
                || self.lock().attachments.get(&at).map(|a| a.client.as_str())
                    != Some(input.client.as_str());
            if !woke && !self.lock().disposed {
                tokio::select! {
                    _ = &mut notified => {}
                    _ = tokio::time::sleep(Duration::from_millis(hold as u64)) => {}
                }
            }
            let state = self.lock();
            if state.attachments.get(&at).map(|a| a.client.as_str()) != Some(input.client.as_str())
            {
                return Ok(json!({"protocol": CLAUDE_MOD_PROTOCOL, "superseded": true}));
            }
            messages = Self::messages_for(&state, &at, floor);
        }
        let epoch = self.lock().epoch.clone();
        Ok(json!({"protocol": CLAUDE_MOD_PROTOCOL, "epoch": epoch, "messages": messages}))
    }

    /// The mod submitted a message, holds it, or could not (`mod_ack`).
    pub fn ack(&self, input: AckInput) -> Result<Value, ClaudeModError> {
        let at = key(&input.connection_id, &input.pane_id);
        let now = self.now();
        let mut state = self.lock();
        let Some(index) = state.items.iter().position(|each| {
            key(&each.connection_id, &each.pane_id) == at && each.id as f64 == input.id
        }) else {
            return Ok(json!({"ok": true, "known": false}));
        };
        let item = state.items[index].clone();
        let fields = json!({
            "connection": input.connection_id,
            "pane": input.pane_id,
            "id": item.id,
            "kind": item.kind,
        });
        let with = |extra: Value| {
            let mut fields = fields.clone();
            for (k, v) in extra.as_object().into_iter().flatten() {
                fields[k] = v.clone();
            }
            fields
        };
        match input.outcome.as_str() {
            "submitted" => {
                state.items.remove(index);
                self.save(&mut state);
                drop(state);
                self.log(
                    "claude mod submitted a message",
                    with(json!({"waited_ms": now - item.queued_at})),
                );
            }
            "held" => {
                if !item.held {
                    state.items[index].held = true;
                    drop(state);
                    self.log(
                        "claude mod holds a message until the user's next turn",
                        with(json!({"reason": head16(&input.reason, 200)})),
                    );
                }
            }
            "failed" => {
                state.items.remove(index);
                self.save(&mut state);
                drop(state);
                self.log(
                    "claude mod could not submit a message",
                    with(json!({"reason": head16(&input.reason, 300)})),
                );
            }
            other => {
                return Err(ClaudeModError::new(format!("unknown outcome: {other}")));
            }
        }
        Ok(json!({"ok": true, "known": true}))
    }

    /// What the mod says of its session (`mod_event`).
    pub fn event(&self, input: EventInput) -> Result<Value, ClaudeModError> {
        let at = key(&input.connection_id, &input.pane_id);
        let kind = match input.event.get("type") {
            None | Some(Value::Null) => String::new(),
            Some(value) => roamgate_agents::js::to_text(value),
        };
        if input.client.is_empty() {
            return Err(ClaudeModError::new("the mod sent no client id"));
        }
        let unknown = json!({"ok": true, "known": false});
        let mut after = Vec::new();
        let mut state = self.lock();
        // A goodbye from a mod Roamgate does not know changes nothing.
        let known = state.attachments.get(&at);
        if kind == "bye" && known.is_none_or(|known| known.client != input.client || known.gone) {
            return Ok(unknown);
        }
        // A mod's event before its first poll answers (or after a restart)
        // says hello too; one a newer mod replaced speaks for nothing.
        if !self.attach(
            &mut state,
            &at,
            &input.connection_id,
            &input.pane_id,
            &input.session_id,
            &input.client,
            None,
            None,
            &mut after,
        ) {
            drop(state);
            self.run_after(after);
            return Ok(unknown);
        }
        let now = self.now();
        let reason = |field: &str| match input.event.get(field) {
            None | Some(Value::Null) => String::new(),
            Some(value) => head16(&roamgate_agents::js::to_text(value), 40),
        };
        let mut change: Option<ClaudeModChange> = None;
        let mut wake = false;
        let mut bye_log: Option<Value> = None;
        {
            let waiting = Self::pane_count(&state, &at).0;
            let State {
                attachments, items, ..
            } = &mut *state;
            let attachment = attachments.get_mut(&at).expect("attached");
            attachment.last_seen = attachment.last_seen.max(now);
            match kind.as_str() {
                "turn_start" => {
                    attachment.status = ClaudeModStatus::Working;
                    attachment.turn_reason = None;
                    // A turn started: what a stop held goes after it.
                    for each in items.iter_mut() {
                        if key(&each.connection_id, &each.pane_id) == at {
                            each.held = false;
                        }
                    }
                    change = Some(ClaudeModChange::Status);
                }
                "turn_complete" => {
                    attachment.status = ClaudeModStatus::Idle;
                    attachment.turn_reason = Some(reason("reason"));
                    // The usage after the turn comes with it.
                    if input.event.contains_key("model") || input.event.contains_key("context") {
                        attachment.usage = Some(parse_mod_usage(&input.event, &iso(now)));
                    }
                    change = Some(ClaudeModChange::TurnComplete);
                }
                "blocked" => {
                    attachment.status = ClaudeModStatus::Blocked;
                    change = Some(ClaudeModChange::Status);
                }
                "unblocked" => {
                    if attachment.status == ClaudeModStatus::Blocked {
                        attachment.status = ClaudeModStatus::Working;
                        change = Some(ClaudeModChange::Status);
                    }
                }
                "usage" => {
                    attachment.usage = Some(parse_mod_usage(&input.event, &iso(now)));
                    change = Some(ClaudeModChange::Usage);
                }
                "bye" => {
                    attachment.gone = true;
                    wake = true;
                    bye_log = Some(json!({
                        "connection": input.connection_id,
                        "pane": input.pane_id,
                        "reason": reason("reason"),
                        "waiting": waiting,
                    }));
                    change = Some(ClaudeModChange::Detach);
                }
                _ => {
                    drop(state);
                    self.run_after(after);
                    return Ok(unknown);
                }
            }
            if change.is_some() {
                attachment.updated_at = now;
            }
        }
        let debug = {
            let attachment = state.attachments.get(&at).expect("attached");
            let mut fields = json!({
                "connection": input.connection_id,
                "pane": input.pane_id,
                "type": kind,
                "status": attachment.status.as_str(),
            });
            if let Some(reason) = attachment.turn_reason.as_deref().filter(|r| !r.is_empty()) {
                fields["reason"] = json!(reason);
            }
            if let Some(usage) = attachment.usage.as_ref().filter(|_| kind != "turn_start") {
                fields["model"] = usage.get("model").cloned().unwrap_or(Value::Null);
                fields["context_percent"] = usage
                    .pointer("/context/percent")
                    .cloned()
                    .unwrap_or(Value::Null);
                fields["limits"] = usage
                    .get("rate_limits")
                    .and_then(Value::as_array)
                    .map(|limits| {
                        json!(
                            limits
                                .iter()
                                .map(|each| format!(
                                    "{}:{}",
                                    each["kind"].as_str().unwrap_or(""),
                                    each["percent_used"]
                                ))
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    })
                    .unwrap_or(Value::Null);
            }
            fields
        };
        drop(state);
        self.run_after(after);
        if wake {
            self.wake(&at);
        }
        if let Some(fields) = bye_log {
            self.log("claude mod left", fields);
        }
        if let Some(change) = change {
            self.changed(&input.connection_id, &input.pane_id, change);
        }
        self.debug("claude mod event", debug);
        Ok(json!({"ok": true, "known": true}))
    }

    /// A message for a pane's Claude, when its mod is live: its id, or None
    /// (type it as before).
    pub fn deliver(
        &self,
        connection_id: &str,
        pane_id: &str,
        text: &str,
        kind: &str,
    ) -> Result<Option<i64>, ClaudeModError> {
        let at = key(connection_id, pane_id);
        let now = self.now();
        let mut state = self.lock();
        if state.disposed {
            return Ok(None);
        }
        if !self.is_live(state.attachments.get(&at)) {
            return Ok(None);
        }
        if roamgate_agents::js::trim(text).is_empty() {
            return Ok(None);
        }
        let max = self.0.options.max_per_pane;
        if Self::pane_count(&state, &at).0 >= max {
            return Err(ClaudeModError {
                message: format!("{max} messages already wait for that session"),
                status: 429,
            });
        }
        let id = state.next_id;
        state.next_id += 1;
        state.items.push(Item {
            id,
            connection_id: connection_id.to_owned(),
            pane_id: pane_id.to_owned(),
            text: text.to_owned(),
            kind: kind.to_owned(),
            queued_at: now,
            held: false,
        });
        self.save(&mut state);
        drop(state);
        self.wake(&at);
        self.log(
            "message queued for a claude mod",
            json!({"connection": connection_id, "pane": pane_id, "id": id, "kind": kind}),
        );
        Ok(Some(id))
    }

    fn remove_item(&self, id: i64) {
        let mut state = self.lock();
        if let Some(index) = state.items.iter().position(|each| each.id == id) {
            state.items.remove(index);
        }
        self.save(&mut state);
    }

    /// Types what a mod left behind, once its pane's agent is idle.
    pub async fn sweep(&self) {
        let options = &self.0.options;
        let now = self.now();
        let mut changes = Vec::new();
        let mut panes = Vec::new();
        {
            let mut state = self.lock();
            if state.disposed {
                return;
            }
            let oldest = now - options.max_age_ms;
            let expired: Vec<Item> = state
                .items
                .iter()
                .filter(|each| each.queued_at < oldest)
                .cloned()
                .collect();
            for each in expired {
                state.items.retain(|item| item.id != each.id);
                self.save(&mut state);
                self.log(
                    "claude mod message expired",
                    json!({"connection": each.connection_id, "pane": each.pane_id, "id": each.id}),
                );
            }
            // Mods silent for long are gone; gone ones with nothing left forgotten.
            for at in state.attachments.keys() {
                let live = self.is_live(state.attachments.get(&at));
                let attachment = state.attachments.get_mut(&at).expect("listed");
                if !attachment.gone && !live {
                    if now - attachment.last_seen < options.orphan_ms {
                        continue;
                    }
                    attachment.gone = true;
                    changes.push(at.clone());
                }
                if attachment.gone && Self::pane_count(&state, &at).0 == 0 {
                    state.attachments.remove(&at);
                }
            }
            let mut seen = HashSet::new();
            for each in &state.items {
                let at = key(&each.connection_id, &each.pane_id);
                if seen.insert(at.clone()) {
                    panes.push(at);
                }
            }
        }
        for at in changes {
            let (connection, pane) = split_key(&at);
            self.changed(&connection, &pane, ClaudeModChange::Detach);
        }
        for at in panes {
            let next = {
                let mut state = self.lock();
                let attachment = state.attachments.get(&at);
                if self.is_live(attachment) || state.typing.contains(&at) {
                    continue;
                }
                if attachment.is_some_and(|attachment| !attachment.gone) {
                    continue;
                }
                // Since a restart, its mod may yet come back.
                if attachment.is_none() && self.now() - self.0.started_at < options.orphan_ms {
                    continue;
                }
                let Some(next) = state
                    .items
                    .iter()
                    .find(|each| key(&each.connection_id, &each.pane_id) == at)
                    .cloned()
                else {
                    continue;
                };
                if options.type_message.is_none() {
                    continue;
                }
                if self.now() - next.queued_at > options.orphan_limit_ms + options.orphan_ms {
                    state.items.retain(|item| item.id != next.id);
                    self.save(&mut state);
                    drop(state);
                    self.log(
                        "claude mod message dropped: its session stayed busy",
                        json!({"connection": next.connection_id, "pane": next.pane_id, "id": next.id}),
                    );
                    continue;
                }
                state.typing.insert(at.clone());
                next
            };
            let type_message = options.type_message.clone().expect("checked");
            let result = type_message(
                next.connection_id.clone(),
                next.pane_id.clone(),
                next.text.clone(),
            )
            .await;
            match result {
                // A mod came back meanwhile: it has the message (if not typed).
                Ok(result @ (ClaudeModTypeResult::Typed | ClaudeModTypeResult::Gone)) => {
                    self.remove_item(next.id);
                    self.log(
                        if result == ClaudeModTypeResult::Typed {
                            "claude mod message typed instead"
                        } else {
                            "claude mod message dropped: no agent in its pane"
                        },
                        json!({"connection": next.connection_id, "pane": next.pane_id, "id": next.id}),
                    );
                }
                Ok(ClaudeModTypeResult::Wait) => {}
                Err(error) => self.log(
                    "claude mod message not typed yet",
                    json!({"connection": next.connection_id, "pane": next.pane_id, "error": error}),
                ),
            }
            self.lock().typing.remove(&at);
        }
    }

    /// Whether the pane's Claude has the mod's Work board tools (`work_*`).
    pub fn has_work_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        let state = self.lock();
        state
            .tools
            .get(&key(connection_id, pane_id))
            .is_some_and(|entry| entry.work && self.tools_fresh(entry))
    }

    /// Whether the pane's Claude has Roamgate's rules in its system prompt.
    pub fn has_rules(&self, connection_id: &str, pane_id: &str) -> bool {
        let state = self.lock();
        state
            .tools
            .get(&key(connection_id, pane_id))
            .is_some_and(|entry| entry.rules && self.tools_fresh(entry))
    }

    /// Whether the pane's Claude has the mod's tools (it said so lately).
    pub fn has_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        let state = self.lock();
        state
            .tools
            .get(&key(connection_id, pane_id))
            .is_some_and(|entry| self.tools_fresh(entry))
    }

    /// Whether the pane's Claude runs a live mod.
    pub fn live(&self, connection_id: &str, pane_id: &str) -> bool {
        self.is_live(self.lock().attachments.get(&key(connection_id, pane_id)))
    }

    /// What the pane's live mod says; None without one.
    pub fn pane(&self, connection_id: &str, pane_id: &str) -> Option<Value> {
        let at = key(connection_id, pane_id);
        let state = self.lock();
        let attachment = state.attachments.get(&at)?;
        self.is_live(Some(attachment))
            .then(|| self.snapshot(&state, &at, attachment))
    }

    /// Every live mod of a connection.
    pub fn panes(&self, connection_id: &str) -> Vec<Value> {
        let prefix = format!("{connection_id}\n");
        let state = self.lock();
        state
            .attachments
            .iter()
            .filter(|(at, attachment)| at.starts_with(&prefix) && self.is_live(Some(attachment)))
            .map(|(at, attachment)| self.snapshot(&state, at, attachment))
            .collect()
    }

    /// Messages waiting for a pane, live mod or not.
    pub fn waiting(&self, connection_id: &str, pane_id: &str) -> usize {
        Self::pane_count(&self.lock(), &key(connection_id, pane_id)).0
    }

    /// Writes the inbox now (shutdown).
    pub fn flush(&self) {
        let mut state = self.lock();
        state.save_pending = false;
        self.write_now(&state);
    }

    pub fn dispose(&self) {
        let mut state = self.lock();
        if state.disposed {
            return;
        }
        if let Some(task) = self.0.sweeper.lock().unwrap().take() {
            task.abort();
        }
        if state.save_pending {
            state.save_pending = false;
            self.write_now(&state);
        }
        state.disposed = true;
        drop(state);
        let all: Vec<String> = self.0.waiters.lock().unwrap().keys().cloned().collect();
        for at in all {
            self.wake(&at);
        }
    }
}

fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// Writes `bytes` to `path` with `mode` (a new file's, as writeFileSync).
pub(crate) fn write_mode(path: &std::path::Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options.open(path)?.write_all(bytes)
}

fn overlay_status(herdr: Option<&Value>, status: &str) -> &'static str {
    let herdr = herdr.and_then(Value::as_str);
    match status {
        "idle" => {
            if herdr == Some("done") {
                "done"
            } else {
                "idle"
            }
        }
        "working" => {
            if herdr == Some("blocked") {
                "blocked"
            } else {
                "working"
            }
        }
        _ => "blocked",
    }
}

fn overlay_agent(item: &Map<String, Value>, module: &Value) -> Map<String, Value> {
    // Only a Claude Herdr sees there: the mod runs inside it.
    if item.get("agent").and_then(Value::as_str) != Some("claude") {
        return item.clone();
    }
    let session = item.get("agent_session").and_then(Value::as_object);
    let mut out = item.clone();
    out.insert(
        "agent_status".into(),
        json!(overlay_status(
            item.get("agent_status"),
            module["status"].as_str().unwrap_or("")
        )),
    );
    let mod_session = module["session_id"].as_str().unwrap_or("");
    if !mod_session.is_empty()
        && session.and_then(|s| s.get("value")) != Some(&Value::String(mod_session.into()))
    {
        let mut next = session.cloned().unwrap_or_default();
        next.insert("source".into(), json!("roamgate:mod"));
        next.insert("agent".into(), json!("claude"));
        next.insert("kind".into(), json!("id"));
        next.insert("value".into(), json!(mod_session));
        out.insert("agent_session".into(), Value::Object(next));
    }
    out
}

/// What Herdr says of panes and agents, with the state of each pane's live
/// Claude mod laid over Herdr's screen detection: working and idle are the
/// mod's (Herdr's done stays: idle and unseen), blocked is either's, and the
/// session is the mod's.
pub fn overlay_mod_panes(
    method: &str,
    params: Option<&Value>,
    result: Value,
    mods: &[Value],
) -> Value {
    let Value::Object(result) = result else {
        return result;
    };
    if mods.is_empty() {
        return Value::Object(result);
    }
    let by_pane: HashMap<&str, &Value> = mods
        .iter()
        .filter_map(|each| Some((each.get("pane_id")?.as_str()?, each)))
        .collect();
    let over = |item: &Value| -> Value {
        let Some(object) = item.as_object() else {
            return item.clone();
        };
        let Some(pane) = object.get("pane_id").and_then(Value::as_str) else {
            return item.clone();
        };
        match by_pane.get(pane) {
            Some(mine) => Value::Object(overlay_agent(object, mine)),
            None => item.clone(),
        }
    };
    let mut result = result;
    match method {
        "agent.get" => {
            let pane = params
                .and_then(|p| p.get("target"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let (Some(mine), Some(agent)) = (
                by_pane.get(pane),
                result.get("agent").and_then(Value::as_object),
            ) else {
                return Value::Object(result);
            };
            let mut item = Map::new();
            item.insert("pane_id".into(), json!(pane));
            for (k, v) in agent {
                item.insert(k.clone(), v.clone());
            }
            result.insert("agent".into(), Value::Object(overlay_agent(&item, mine)));
        }
        "agent.list" | "pane.list" => {
            let field = if method == "agent.list" {
                "agents"
            } else {
                "panes"
            };
            if let Some(list) = result.get(field).and_then(Value::as_array) {
                let next: Vec<Value> = list.iter().map(over).collect();
                result.insert(field.into(), Value::Array(next));
            }
        }
        "pane.get" => {
            if let Some(pane) = result.get("pane").filter(|p| p.is_object()) {
                let next = over(pane);
                result.insert("pane".into(), next);
            }
        }
        _ => {}
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests;
