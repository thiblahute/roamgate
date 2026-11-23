//! The activity recorder (server/src/activity/recorder.ts): turns what the
//! server sees into the activity log. It records, per connection,
//!
//! - agent states from Herdr's per-pane status events, consecutive
//!   identical states once, with each `pane.list` reconcile catching missed
//!   changes; for the agents Roamgate runs itself (`owned_agents`), their
//!   state as Roamgate knows it, never Herdr's;
//! - attention spans: a browser's presence reports (`activity.presence`)
//!   become `workspace.focus` / `workspace.blur` pairs, and Herdr's own TUI
//!   focus becomes low-confidence spans with `source: "herdr"`;
//! - the periods a connection was not ready, and those the recorder itself
//!   was not running.
//!
//! Every signal carries the time it arrived (in stage 1 the Bun front
//! stamps what it forwards) and is applied in order by one task that owns
//! the store: the actor. Only a person opens a browser span; every focus
//! gets a blur with a reason. No terminal content is ever recorded.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use regex::Regex;
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger};
use roamgate_base::paths::DataContext;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, mpsc, oneshot, watch};

use crate::BoxFuture;
use crate::day_input::ActivitySettings;
use crate::protocol::agent_state;
use crate::repo_info::{RepoInfo, RunHostScript, read_repo_info};
use crate::store::{ActivityStore, AgentFields, Client, NewEvent, WorkspaceRow};

pub const PRESENCE_TIMEOUT_MS: i64 = 150_000;
pub const ALIVE_INTERVAL_MS: i64 = 60_000;
pub const RETENTION_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// A Herdr workspace still unknown after a listing is not re-listed sooner.
const MISS_REFRESH_MS: i64 = 5_000;
/// How often a workspace's branch and remote are read again.
pub const REPO_INFO_INTERVAL_MS: i64 = 10 * 60_000;
/// At most this many paths per host command.
const REPO_INFO_BATCH: usize = 24;
pub const STOP_DRAIN_MS: u64 = 2_000;
const MAX_INPUT_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// An agent Roamgate runs in a Herdr pane itself (conversation mode's
/// headless claude): Herdr's state for that pane does not follow it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedAgent {
    pub pane_id: String,
    pub session_id: Option<String>,
    pub agent_status: String,
}

/// What the recorder asks of the server: Herdr's listings, the agents
/// Roamgate runs itself, and git on a connection's host.
pub trait RecorderHost: RunHostScript {
    fn herdr_call(
        &self,
        connection_id: &str,
        method: &str,
        params: Value,
    ) -> BoxFuture<Result<Value, String>>;
    fn owned_agents(&self, connection_id: &str) -> BoxFuture<Vec<OwnedAgent>>;
    /// False where there is no POSIX shell to read repositories with.
    fn reads_repositories(&self) -> bool {
        true
    }
}

pub struct RecorderOptions {
    pub settings: ActivitySettings,
    pub context: DataContext,
    pub directory: PathBuf,
    pub host: Arc<dyn RecorderHost>,
    pub clock: SharedClock,
    pub logger: Logger,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceClient {
    pub id: String,
    pub kind: String,
}

/// A browser's presence report, checked (`parsePresence`).
#[derive(Debug, Clone, PartialEq)]
pub struct Presence {
    pub client: PresenceClient,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub visible: bool,
    pub focused: bool,
    /// None: no input since the page loaded.
    pub input_age_ms: Option<f64>,
    /// None from pages older than causes.
    pub cause: Option<String>,
}

fn id_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn optional_id(value: Option<&Value>, field: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if id_ok(text) => Ok(Some(text.clone())),
        _ => Err(format!("invalid {field}")),
    }
}

/// Checks a presence report.
pub fn parse_presence(params: &Value) -> Result<Presence, String> {
    let input = params.as_object().ok_or("invalid presence")?;
    let client_id = input
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or("invalid client_id")?;
    let kind = input
        .get("client_kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "desktop" | "phone"))
        .ok_or("invalid client_kind")?;
    let (Some(visible), Some(focused)) = (
        input.get("visible").and_then(Value::as_bool),
        input.get("focused").and_then(Value::as_bool),
    ) else {
        return Err("invalid visibility".into());
    };
    let age = match input.get("input_age_ms") {
        Some(Value::Null) => None,
        Some(Value::Number(number)) => match number.as_f64() {
            Some(age) if age.is_finite() && age >= 0.0 => Some(age.min(MAX_INPUT_AGE_MS)),
            _ => return Err("invalid input_age_ms".into()),
        },
        _ => return Err("invalid input_age_ms".into()),
    };
    let cause = match input.get("cause") {
        None | Some(Value::Null) => None,
        Some(Value::String(cause))
            if matches!(
                cause.as_str(),
                "user_input" | "user_focus" | "page_load" | "follow_herdr" | "app" | "repeat"
            ) =>
        {
            Some(cause.clone())
        }
        _ => return Err("invalid cause".into()),
    };
    Ok(Presence {
        client: PresenceClient {
            id: client_id.to_owned(),
            kind: kind.to_owned(),
        },
        workspace_id: optional_id(input.get("workspace_id"), "workspace_id")?,
        tab_id: optional_id(input.get("tab_id"), "tab_id")?,
        pane_id: optional_id(input.get("pane_id"), "pane_id")?,
        visible,
        focused,
        input_age_ms: age,
        cause,
    })
}

/// Connection plus checkout path (or name when Herdr gives no path).
pub fn stable_workspace_id(connection_id: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{connection_id}\0{key}").as_bytes());
    format!("ws_{}", &hex::encode(digest)[..24])
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// A session file path identifies its session by name; ids are themselves.
fn session_id(value: Option<&Value>) -> Option<String> {
    let session = value?.as_object()?;
    let raw = text(session.get("value"))?;
    if session.get("kind").and_then(Value::as_str) == Some("path") {
        let name = raw.rsplit(['/', '\\']).next().unwrap_or("");
        let extension = Regex::new(r"\.[^.]+$").expect("valid regex");
        return Some(extension.replace(name, "").into_owned());
    }
    Some(raw)
}

#[derive(Debug, Clone)]
struct PaneInfo {
    workspace_id: String,
    tab_id: Option<String>,
    agent: Option<String>,
    session_id: Option<String>,
    title: Option<String>,
    focused: bool,
}

fn pane_info_from(value: &Value) -> Option<(String, PaneInfo)> {
    let pane = value.as_object()?;
    let pane_id = text(pane.get("pane_id"))?;
    let workspace_id = text(pane.get("workspace_id"))?;
    Some((
        pane_id,
        PaneInfo {
            workspace_id,
            tab_id: text(pane.get("tab_id")),
            agent: text(pane.get("agent")),
            session_id: session_id(pane.get("agent_session")),
            title: text(pane.get("title")),
            focused: pane.get("focused") == Some(&Value::Bool(true)),
        },
    ))
}

fn listed_panes(result: &Value) -> Vec<(String, PaneInfo, Option<Value>)> {
    let Some(panes) = result.get("panes").and_then(Value::as_array) else {
        return Vec::new();
    };
    panes
        .iter()
        .filter_map(|pane| {
            let (id, info) = pane_info_from(pane)?;
            Some((id, info, pane.get("agent_status").cloned()))
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Span {
    seq: i64,
    start: i64,
    connection_id: String,
    workspace_id: String,
    herdr_workspace_id: Option<String>,
    tab_id: Option<String>,
    pane_id: Option<String>,
    client: Option<Client>,
    source: &'static str,
}

#[derive(Debug, Clone)]
struct Resolved {
    stable_id: String,
    path: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentRecord {
    name: String,
    state: &'static str,
    session_id: Option<String>,
    workspace_id: String,
    /// Stable id it was recorded under: the workspace may be gone at the end.
    stable_id: Option<String>,
    tab_id: Option<String>,
    at: i64,
}

#[derive(Debug, Default)]
struct Connection {
    ready: bool,
    gap: Option<i64>,
    workspaces: IndexMap<String, Resolved>,
    stale: bool,
    refreshed_at: Option<i64>,
    panes: IndexMap<String, PaneInfo>,
    agents: IndexMap<String, AgentRecord>,
    herdr_focus: Option<Span>,
    was_ready: bool,
}

#[derive(Debug)]
struct PresenceState {
    client: Client,
    connection_id: Option<String>,
    attentive: Option<bool>,
    idle: bool,
    last_presence_at: i64,
    span: Option<Span>,
    timeout: Option<tokio::task::JoinHandle<()>>,
    /// Bumped with each armed timeout: a stale one does nothing.
    timeout_token: u64,
    armed_after: i64,
    unarmed_cause: &'static str,
}

/// What the actor is told.
enum Signal {
    Status {
        connection_id: String,
        state: String,
    },
    HerdrEvent {
        connection_id: String,
        event: Value,
    },
    PaneList {
        connection_id: String,
        result: Value,
        started_at: i64,
    },
    OwnedAgent {
        connection_id: String,
        pane_id: String,
    },
    SocketClosed {
        socket: u64,
    },
}

/// A look at the open store, in order with the signals.
type Inspection = Box<dyn FnOnce(Option<&ActivityStore>) + Send>;

enum Msg {
    Signal {
        ts: i64,
        signal: Signal,
    },
    Presence {
        ts: i64,
        socket: u64,
        connection_id: String,
        presence: Presence,
        reply: oneshot::Sender<bool>,
    },
    Timeout {
        socket: u64,
        token: u64,
    },
    Alive {
        at: i64,
    },
    Retention {
        at: i64,
    },
    RepoDone {
        connection_id: String,
        results: Vec<(String, Option<RepoInfo>)>,
    },
    Flush(oneshot::Sender<usize>),
    Inspect(Inspection),
    Stop(oneshot::Sender<()>),
}

/// The recorder: one actor task owning the store.
pub struct ActivityRecorder {
    tx: mpsc::UnboundedSender<Msg>,
    actor: tokio::task::JoinHandle<()>,
    ready: watch::Receiver<Option<bool>>,
    done: watch::Receiver<bool>,
    stopped: AtomicBool,
    stop_now: Arc<Notify>,
    clock: SharedClock,
    idle_seconds: i64,
}

impl ActivityRecorder {
    /// Starts recording (when `settings.enabled`), on the current runtime.
    pub fn start(options: RecorderOptions) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready) = watch::channel(None);
        let (done_tx, done) = watch::channel(false);
        let stop_now = Arc::new(Notify::new());
        let clock = options.clock.clone();
        let idle_seconds = options.settings.idle_seconds;
        let actor = Actor {
            settings: options.settings,
            context: options.context,
            directory: options.directory,
            host: options.host,
            clock: options.clock,
            logger: options.logger,
            store: None,
            session: 0,
            finished: false,
            connections: IndexMap::new(),
            clients: IndexMap::new(),
            repo_read_at: HashMap::new(),
            repo_reading: HashSet::new(),
            repo_pending: 0,
            tx: tx.downgrade(),
            tickers: Vec::new(),
        };
        let notify = stop_now.clone();
        let actor = tokio::spawn(actor.run(rx, ready_tx, done_tx, notify));
        Self {
            tx,
            actor,
            ready,
            done,
            stopped: AtomicBool::new(false),
            stop_now,
            clock,
            idle_seconds,
        }
    }

    /// True once recording, false when off or the log could not be opened.
    pub async fn ready(&self) -> bool {
        let mut ready = self.ready.clone();
        loop {
            if let Some(value) = *ready.borrow_and_update() {
                return value;
            }
            if ready.changed().await.is_err() {
                return false;
            }
        }
    }

    pub fn now(&self) -> i64 {
        self.clock.now()
    }

    fn signal(&self, ts: Option<i64>, signal: Signal) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let ts = ts.unwrap_or_else(|| self.clock.now());
        let _ = self.tx.send(Msg::Signal { ts, signal });
    }

    pub fn connection_status(&self, connection_id: &str, state: &str, ts: Option<i64>) {
        self.signal(
            ts,
            Signal::Status {
                connection_id: connection_id.into(),
                state: state.into(),
            },
        );
    }

    pub fn herdr_event(&self, connection_id: &str, event: Value, ts: Option<i64>) {
        self.signal(
            ts,
            Signal::HerdrEvent {
                connection_id: connection_id.into(),
                event,
            },
        );
    }

    /// A `pane.list` result, and when that listing was started.
    pub fn pane_list(&self, connection_id: &str, result: Value, started_at: i64, ts: Option<i64>) {
        self.signal(
            ts,
            Signal::PaneList {
                connection_id: connection_id.into(),
                result,
                started_at,
            },
        );
    }

    /// An agent Roamgate runs itself changed state.
    pub fn owned_agent_changed(&self, connection_id: &str, pane_id: &str, ts: Option<i64>) {
        self.signal(
            ts,
            Signal::OwnedAgent {
                connection_id: connection_id.into(),
                pane_id: pane_id.into(),
            },
        );
    }

    pub fn socket_closed(&self, socket: u64, ts: Option<i64>) {
        self.signal(ts, Signal::SocketClosed { socket });
    }

    /// A browser's presence report (`activity.presence`): the reply
    /// `{recording, idle_seconds, attention}`.
    pub async fn presence(
        &self,
        socket: u64,
        connection_id: &str,
        params: &Value,
        ts: Option<i64>,
    ) -> Result<Value, String> {
        let presence = parse_presence(params)?;
        let recording = self.ready().await && !self.stopped.load(Ordering::SeqCst);
        if !recording {
            return Ok(
                json!({ "recording": false, "idle_seconds": self.idle_seconds, "attention": false }),
            );
        }
        let ts = ts.unwrap_or_else(|| self.clock.now());
        let (reply, answer) = oneshot::channel();
        let _ = self.tx.send(Msg::Presence {
            ts,
            socket,
            connection_id: connection_id.into(),
            presence,
            reply,
        });
        let attention = answer.await.unwrap_or(false);
        Ok(json!({ "recording": true, "idle_seconds": self.idle_seconds, "attention": attention }))
    }

    /// Resolves once every signal received so far is applied, and the
    /// repository reads they started are done.
    pub async fn flush(&self) {
        self.ready().await;
        loop {
            let (reply, answer) = oneshot::channel();
            if self.tx.send(Msg::Flush(reply)).is_err() {
                return;
            }
            match answer.await {
                Ok(0) | Err(_) => return,
                Ok(_) => tokio::task::yield_now().await,
            }
        }
    }

    /// Runs `inspect` on the open store, in order with the signals.
    pub async fn inspect<T: Send + 'static>(
        &self,
        inspect: impl FnOnce(Option<&ActivityStore>) -> T + Send + 'static,
    ) -> Option<T> {
        let (reply, answer) = oneshot::channel();
        let _ = self.tx.send(Msg::Inspect(Box::new(move |store| {
            let _ = reply.send(inspect(store));
        })));
        answer.await.ok()
    }

    /// The events of the open log (tests).
    pub async fn read_events(&self) -> Vec<Value> {
        self.inspect(|store| {
            store
                .map(|s| s.read_events(None, None).unwrap_or_default())
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default()
    }

    /// Applies pending signals (at most 2 s), then ends every span and the
    /// session.
    pub async fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            self.finished().await;
            return;
        }
        let (reply, answer) = oneshot::channel();
        let _ = self.tx.send(Msg::Stop(reply));
        let drained = roamgate_base::clock::timeout(
            &*self.clock,
            Duration::from_millis(STOP_DRAIN_MS),
            answer,
        )
        .await;
        if drained.is_err() {
            self.stop_now.notify_one();
        }
        self.finished().await;
    }

    /// Ends every span and the session at once, without waiting for what
    /// is pending.
    pub fn stop_now(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stop_now.notify_one();
    }

    /// Stops the actor without closing anything, as a crash would (tests of
    /// the recovery a next recorder does).
    pub fn abandon(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.actor.abort();
    }

    async fn finished(&self) {
        let mut done = self.done.clone();
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                return;
            }
        }
    }
}

struct Actor {
    settings: ActivitySettings,
    context: DataContext,
    directory: PathBuf,
    host: Arc<dyn RecorderHost>,
    clock: SharedClock,
    logger: Logger,
    store: Option<ActivityStore>,
    session: i64,
    finished: bool,
    connections: IndexMap<String, Connection>,
    clients: IndexMap<u64, PresenceState>,
    repo_read_at: HashMap<String, i64>,
    repo_reading: HashSet<String>,
    repo_pending: usize,
    tx: mpsc::WeakUnboundedSender<Msg>,
    tickers: Vec<tokio::task::JoinHandle<()>>,
}

fn error_fields(error: impl std::fmt::Display) -> LogFields {
    let mut fields = Map::new();
    fields.insert("error".into(), json!(error.to_string()));
    fields
}

impl Actor {
    async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<Msg>,
        ready: watch::Sender<Option<bool>>,
        done: watch::Sender<bool>,
        stop_now: Arc<Notify>,
    ) {
        let recording = self.init();
        let _ = ready.send(Some(recording));
        let mut stop_reply: Option<oneshot::Sender<()>> = None;
        loop {
            let message = tokio::select! {
                biased;
                () = stop_now.notified() => break,
                message = rx.recv() => message,
            };
            let Some(message) = message else { break };
            if let Msg::Stop(reply) = message {
                stop_reply = Some(reply);
                break;
            }
            let cancelled = {
                let handle = self.handle(message, recording);
                tokio::select! {
                    biased;
                    () = stop_now.notified() => true,
                    () = handle => false,
                }
            };
            if cancelled {
                break;
            }
        }
        self.finish();
        // Pending presence replies and inspections see a closed log.
        rx.close();
        while let Ok(message) = rx.try_recv() {
            match message {
                Msg::Presence { reply, .. } => drop(reply),
                Msg::Inspect(inspect) => inspect(None),
                Msg::Stop(reply) => {
                    let _ = reply.send(());
                }
                _ => {}
            }
        }
        if let Some(reply) = stop_reply {
            let _ = reply.send(());
        }
        let _ = done.send(true);
    }

    fn init(&mut self) -> bool {
        if !self.settings.enabled {
            return false;
        }
        let opened = ActivityStore::open(&self.context, &self.directory)
            .map_err(|error| error.to_string())
            .and_then(|store| {
                self.store = Some(store);
                self.recover(self.clock.now())
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = opened {
            self.logger
                .warn("activity log unavailable", Some(&error_fields(error)));
            self.store = None;
            return false;
        }
        self.tickers
            .push(self.ticker(ALIVE_INTERVAL_MS, |at| Msg::Alive { at }));
        self.retention(self.clock.now());
        self.tickers
            .push(self.ticker(RETENTION_INTERVAL_MS, |at| Msg::Retention { at }));
        let mut fields = Map::new();
        fields.insert("retention_days".into(), json!(self.settings.retention_days));
        self.logger.info("recording activity", Some(&fields));
        true
    }

    /// `setInterval`: a message every `period` from now, stamped with the
    /// time it fired.
    fn ticker(&self, period: i64, message: fn(i64) -> Msg) -> tokio::task::JoinHandle<()> {
        let tx = self.tx.clone();
        let clock = self.clock.clone();
        let mut next = clock.now() + period;
        tokio::spawn(async move {
            loop {
                clock.sleep_until(next).await;
                next += period;
                let Some(tx) = tx.upgrade() else { return };
                if tx.send(message(clock.now())).is_err() {
                    return;
                }
            }
        })
    }

    async fn handle(&mut self, message: Msg, recording: bool) {
        match message {
            Msg::Flush(reply) => {
                let _ = reply.send(self.repo_pending);
            }
            Msg::Inspect(inspect) => inspect(if self.finished {
                None
            } else {
                self.store.as_ref()
            }),
            Msg::Presence {
                ts,
                socket,
                connection_id,
                presence,
                reply,
            } => {
                if !recording || self.finished {
                    return;
                }
                if let Err(error) = self
                    .handle_presence(socket, &connection_id, ts, &presence)
                    .await
                {
                    self.logger
                        .warn("activity signal dropped", Some(&error_fields(error)));
                }
                let _ = reply.send(
                    self.clients
                        .get(&socket)
                        .is_some_and(|state| state.span.is_some()),
                );
            }
            Msg::RepoDone {
                connection_id,
                results,
            } => {
                self.repo_reading.remove(&connection_id);
                self.repo_pending = self.repo_pending.saturating_sub(1);
                if self.finished {
                    return;
                }
                if let Some(store) = &self.store {
                    for (id, repo) in results {
                        let _ = store.set_repo(&id, repo.as_ref());
                    }
                }
            }
            _ if !recording || self.finished => {}
            Msg::Signal { ts, signal } => {
                let result = match signal {
                    Signal::Status {
                        connection_id,
                        state,
                    } => self.handle_status(&connection_id, ts, &state).await,
                    Signal::HerdrEvent {
                        connection_id,
                        event,
                    } => self.handle_herdr_event(&connection_id, ts, &event).await,
                    Signal::PaneList {
                        connection_id,
                        result,
                        started_at,
                    } => {
                        self.handle_pane_list(&connection_id, ts, &result, started_at)
                            .await
                    }
                    Signal::OwnedAgent {
                        connection_id,
                        pane_id,
                    } => self.handle_owned_agent(&connection_id, ts, &pane_id).await,
                    Signal::SocketClosed { socket } => self.handle_socket_closed(socket, ts),
                };
                if let Err(error) = result {
                    self.logger
                        .warn("activity signal dropped", Some(&error_fields(error)));
                }
            }
            Msg::Timeout { socket, token } => {
                let Some(state) = self.clients.get(&socket) else {
                    return;
                };
                if state.timeout_token != token {
                    return;
                }
                // Last seen at its last report; nothing is known after it.
                let at = state.last_presence_at;
                let result = self
                    .end_presence_span(socket, at, "timeout", None, None)
                    .and_then(|()| self.visibility(socket, at, false, None, None));
                if let Err(error) = result {
                    self.logger
                        .warn("activity signal dropped", Some(&error_fields(error)));
                }
            }
            Msg::Alive { at } => {
                if let Some(store) = &self.store
                    && let Err(error) = store.alive(self.session, at)
                {
                    self.logger
                        .warn("activity alive stamp failed", Some(&error_fields(error)));
                }
            }
            Msg::Retention { at } => self.retention(at),
            Msg::Stop(_) => {}
        }
    }

    fn store(&self) -> &ActivityStore {
        self.store.as_ref().expect("the recorder records")
    }

    fn append(&self, mut event: NewEvent) -> rusqlite::Result<i64> {
        event.session = self.session;
        self.store().append(&event)
    }

    fn open_span(
        &self,
        ts: i64,
        fields: Span,
        cause: &str,
        input_age_ms: Option<f64>,
    ) -> rusqlite::Result<Span> {
        let seq = self.append(NewEvent {
            ts,
            kind: "workspace.focus",
            connection_id: fields.connection_id.clone(),
            workspace_id: Some(fields.workspace_id.clone()),
            tab_id: fields.tab_id.clone(),
            pane_id: fields.pane_id.clone(),
            client: fields.client.clone(),
            source: Some(fields.source),
            cause: Some(cause.to_owned()),
            input_age_ms,
            ..Default::default()
        })?;
        Ok(Span {
            seq,
            start: ts,
            ..fields
        })
    }

    /// `cause` only for a switch or hidden blur: what made the change.
    fn close_span(
        &self,
        span: &Span,
        ts: i64,
        reason: &'static str,
        cause: Option<&str>,
        input_age_ms: Option<f64>,
    ) -> rusqlite::Result<()> {
        self.append(NewEvent {
            cause: cause.map(str::to_owned),
            input_age_ms,
            ts: ts.max(span.start),
            kind: "workspace.blur",
            connection_id: span.connection_id.clone(),
            workspace_id: Some(span.workspace_id.clone()),
            tab_id: span.tab_id.clone(),
            pane_id: span.pane_id.clone(),
            client: span.client.clone(),
            source: Some(span.source),
            reason: Some(reason),
            span: Some(span.seq),
            ..Default::default()
        })?;
        Ok(())
    }

    fn retention(&self, now: i64) {
        let Some(store) = &self.store else { return };
        let cutoff = now - self.settings.retention_days * 24 * 60 * 60 * 1000;
        if let Err(error) = store.purge(cutoff).and_then(|_| store.vacuum()) {
            self.logger
                .warn("activity retention failed", Some(&error_fields(error)));
        }
    }

    /// Ends what a previous recorder left open, at its last sign of life.
    fn recover(&mut self, ts: i64) -> rusqlite::Result<()> {
        let store = self.store();
        let mut ends: HashMap<i64, i64> = HashMap::new();
        for old in store.unfinished_sessions()? {
            store.stop_session(old.id, old.last_alive, false)?;
            ends.insert(old.id, old.last_alive);
        }
        let session = store.start_session(ts)?;
        self.session = session;
        let store = self.store();
        let previous = store.previous_session(session)?;
        let previous_end = previous
            .as_ref()
            .map_or(ts, |p| p.stopped_at.unwrap_or(p.last_alive));
        let end_of = |id: i64| ends.get(&id).copied().unwrap_or(previous_end);
        for span in store.open_spans()? {
            let client = match (&span.client_id, &span.client_kind) {
                (Some(id), Some(kind)) if !id.is_empty() && !kind.is_empty() => Some(Client {
                    id: id.clone(),
                    kind: kind.clone(),
                }),
                _ => None,
            };
            let source: &'static str = match span.source.as_deref() {
                Some("herdr") => "herdr",
                Some("browser") => "browser",
                _ => "browser",
            };
            let mut blur = NewEvent {
                ts: end_of(span.session).max(span.ts),
                kind: "workspace.blur",
                connection_id: span.connection_id.clone(),
                workspace_id: Some(span.workspace_id.clone().unwrap_or_default()),
                tab_id: span.tab_id.clone(),
                pane_id: span.pane_id.clone(),
                client,
                source: Some(source),
                reason: Some("recorder_stop"),
                span: Some(span.seq),
                ..Default::default()
            };
            // A focus row written without a source keeps none.
            if span.source.is_none() {
                blur.source = None;
            }
            self.append(blur)?;
        }
        let store = self.store();
        for client in store.visible_clients()? {
            self.append(NewEvent {
                ts: end_of(client.session),
                kind: "ui.visibility",
                connection_id: client.connection_id.clone(),
                client: Some(Client {
                    id: client.client_id.clone(),
                    kind: client.client_kind.clone(),
                }),
                visible: Some(false),
                ..Default::default()
            })?;
        }
        let store = self.store();
        for gap in store.open_gaps()? {
            store.close_gap(gap.id, previous_end)?;
        }
        if previous.is_some() {
            store.add_gap(None, previous_end, ts, "recorder")?;
        }
        Ok(())
    }

    fn connection(&mut self, id: &str) -> &mut Connection {
        self.connections
            .entry(id.to_owned())
            .or_insert_with(|| Connection {
                stale: true,
                ..Default::default()
            })
    }

    // --- Workspaces --------------------------------------------------------

    /// Lists the connection's workspaces and panes; returns Herdr's focus.
    async fn refresh(&mut self, id: &str) -> Result<Option<(String, Option<String>)>, String> {
        let now = self.clock.now();
        self.connection(id).refreshed_at = Some(now);
        let host = self.host.clone();
        let (workspaces, panes) = tokio::join!(
            host.herdr_call(id, "workspace.list", json!({})),
            host.herdr_call(id, "pane.list", json!({})),
        );
        let (workspaces, panes) = (workspaces?, panes?);
        if self.finished || !self.connection(id).ready {
            return Ok(None);
        }
        let listed = listed_panes(&panes);
        let mut first_cwd: HashMap<String, String> = HashMap::new();
        if let Some(records) = panes.get("panes").and_then(Value::as_array) {
            for pane in records {
                if let (Some(workspace), Some(cwd)) =
                    (text(pane.get("workspace_id")), text(pane.get("cwd")))
                {
                    first_cwd.entry(workspace).or_insert(cwd);
                }
            }
        }
        {
            let conn = self.connection(id);
            for (pane_id, info, _) in &listed {
                conn.panes.insert(pane_id.clone(), info.clone());
            }
        }
        let Some(list) = workspaces.get("workspaces").and_then(Value::as_array) else {
            return Ok(None);
        };
        let mut seen: HashSet<String> = HashSet::new();
        let mut focused: Option<String> = None;
        let at = self.clock.now();
        for workspace in list {
            let Some(object) = workspace.as_object() else {
                continue;
            };
            let Some(herdr_id) = text(object.get("workspace_id")) else {
                continue;
            };
            seen.insert(herdr_id.clone());
            let worktree = object.get("worktree").and_then(Value::as_object);
            let previous_path = self
                .connection(id)
                .workspaces
                .get(&herdr_id)
                .and_then(|r| r.path.clone());
            let name = text(object.get("label")).unwrap_or_else(|| herdr_id.clone());
            let checkout = text(worktree.and_then(|w| w.get("checkout_path")))
                .or_else(|| text(object.get("cwd")));
            // A pane's directory follows `cd`: once known, a path sticks.
            let path = checkout
                .or(previous_path)
                .or_else(|| first_cwd.get(&herdr_id).cloned());
            let key = path.clone().unwrap_or_else(|| format!("name:{name}"));
            let stable_id = stable_workspace_id(id, &key);
            self.connection(id).workspaces.insert(
                herdr_id.clone(),
                Resolved {
                    stable_id: stable_id.clone(),
                    path: path.clone(),
                },
            );
            self.store()
                .upsert_workspace(&WorkspaceRow {
                    id: stable_id,
                    connection_id: id.to_owned(),
                    name,
                    path,
                    herdr_workspace_id: Some(herdr_id.clone()),
                    repo_root: text(worktree.and_then(|w| w.get("repo_root"))),
                    repo_is_worktree: worktree
                        .and_then(|w| w.get("is_linked_worktree"))
                        .and_then(Value::as_bool),
                    seen_at: at,
                })
                .map_err(|e| e.to_string())?;
            if object.get("focused") == Some(&Value::Bool(true)) {
                focused = Some(herdr_id);
            }
        }
        let conn = self.connection(id);
        conn.workspaces
            .retain(|herdr_id, _| seen.contains(herdr_id));
        conn.stale = false;
        self.read_repos(id);
        let Some(focused) = focused else {
            return Ok(None);
        };
        let pane = listed
            .iter()
            .find(|(_, info, _)| info.workspace_id == focused && info.focused)
            .map(|(pane_id, _, _)| pane_id.clone());
        Ok(Some((focused, pane)))
    }

    /// Reads the branch and remote of the connection's workspaces now and
    /// then, off the signal queue: a slow host never holds up the log.
    fn read_repos(&mut self, id: &str) {
        if !self.host.reads_repositories() || self.repo_reading.contains(id) {
            return;
        }
        let at = self.clock.now();
        let mut due: Vec<(String, String)> = Vec::new();
        let workspaces: Vec<&Resolved> = self
            .connections
            .get(id)
            .map(|c| c.workspaces.values().collect())
            .unwrap_or_default();
        for workspace in workspaces {
            if let Some(path) = &workspace.path
                && self
                    .repo_read_at
                    .get(&workspace.stable_id)
                    .is_none_or(|last| at - last >= REPO_INFO_INTERVAL_MS)
                && !due.iter().any(|(stable, _)| stable == &workspace.stable_id)
            {
                due.push((workspace.stable_id.clone(), path.clone()));
            }
        }
        if due.is_empty() {
            return;
        }
        due.truncate(REPO_INFO_BATCH);
        for (stable, _) in &due {
            self.repo_read_at.insert(stable.clone(), at);
        }
        self.repo_reading.insert(id.to_owned());
        self.repo_pending += 1;
        let host = self.host.clone();
        let tx = self.tx.clone();
        let logger = self.logger.clone();
        let connection_id = id.to_owned();
        tokio::spawn(async move {
            let mut paths: Vec<String> = Vec::new();
            for (_, path) in &due {
                if !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
            let results = match read_repo_info(host.as_ref(), &connection_id, &paths).await {
                Ok(found) => due
                    .iter()
                    .filter_map(|(stable, path)| {
                        found.get(path).map(|repo| (stable.clone(), repo.clone()))
                    })
                    .collect(),
                Err(error) => {
                    let mut fields = error_fields(error);
                    fields.insert("connection".into(), json!(connection_id));
                    logger.debug("activity repository read failed", Some(&fields));
                    Vec::new()
                }
            };
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Msg::RepoDone {
                    connection_id,
                    results,
                });
            }
        });
    }

    /// Lists, and records Herdr's focus as found when `cause` is given.
    async fn refresh_and_follow_herdr(
        &mut self,
        id: &str,
        ts: i64,
        cause: Option<&'static str>,
    ) -> Result<(), String> {
        let focus = self.refresh(id).await?;
        if let (Some((workspace, pane)), Some(cause)) = (focus, cause) {
            self.herdr_focus(id, ts, &workspace, pane, None, cause)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// A Herdr workspace's stable id, listing first when needed.
    async fn resolve(
        &mut self,
        id: &str,
        herdr_id: Option<&str>,
        ts: i64,
        follow: bool,
    ) -> Option<Resolved> {
        let herdr_id = herdr_id?;
        let now = self.clock.now();
        let conn = self.connection(id);
        if !conn.ready {
            return None;
        }
        let known = conn.workspaces.contains_key(herdr_id);
        let due = conn
            .refreshed_at
            .is_none_or(|at| now - at >= MISS_REFRESH_MS);
        if conn.stale || (!known && due) {
            let cause = if follow { Some("herdr_listing") } else { None };
            if let Err(error) = self.refresh_and_follow_herdr(id, ts, cause).await {
                let mut fields = error_fields(error);
                fields.insert("connection".into(), json!(id));
                self.logger
                    .debug("activity workspace listing failed", Some(&fields));
            }
        }
        self.connection(id).workspaces.get(herdr_id).cloned()
    }

    // --- Herdr's own focus -------------------------------------------------

    fn herdr_focus(
        &mut self,
        id: &str,
        ts: i64,
        herdr_id: &str,
        pane_id: Option<String>,
        tab_id: Option<String>,
        cause: &'static str,
    ) -> rusqlite::Result<()> {
        let conn = self.connections.get(id).expect("known connection");
        if conn
            .herdr_focus
            .as_ref()
            .is_some_and(|f| f.herdr_workspace_id.as_deref() == Some(herdr_id))
        {
            return Ok(());
        }
        let resolved = conn.workspaces.get(herdr_id).cloned();
        let current = conn.herdr_focus.clone();
        let tab = tab_id.or_else(|| {
            conn.panes
                .get(pane_id.as_deref().unwrap_or(""))
                .and_then(|p| p.tab_id.clone())
        });
        if let Some(current) = &current {
            self.close_span(current, ts, "switch", Some(cause), None)?;
        }
        let next = match resolved {
            Some(resolved) => Some(self.open_span(
                ts,
                Span {
                    seq: 0,
                    start: ts,
                    connection_id: id.to_owned(),
                    workspace_id: resolved.stable_id,
                    herdr_workspace_id: Some(herdr_id.to_owned()),
                    tab_id: tab,
                    pane_id,
                    client: None,
                    source: "herdr",
                },
                cause,
                None,
            )?),
            None => None,
        };
        self.connection(id).herdr_focus = next;
        Ok(())
    }

    // --- Agents -----------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    async fn agent_changed(
        &mut self,
        id: &str,
        ts: i64,
        pane_id: &str,
        workspace_id: &str,
        tab_id: Option<String>,
        name: &str,
        status: Option<&Value>,
        session_id: Option<String>,
        title: Option<String>,
    ) -> rusqlite::Result<()> {
        let state = agent_state(status);
        let conn = self.connection(id);
        if let Some(previous) = conn.agents.get_mut(pane_id)
            && ((previous.name == name
                && previous.state == state
                && previous.session_id == session_id)
                || (previous.state == "unknown" && state == "unknown"))
        {
            previous.at = ts;
            return Ok(());
        }
        // An agent first seen in no known state says nothing yet.
        if !conn.agents.contains_key(pane_id) && state == "unknown" {
            return Ok(());
        }
        conn.agents.insert(
            pane_id.to_owned(),
            AgentRecord {
                name: name.to_owned(),
                state,
                session_id: session_id.clone(),
                workspace_id: workspace_id.to_owned(),
                stable_id: None,
                tab_id: tab_id.clone(),
                at: ts,
            },
        );
        let workspace = self.resolve(id, Some(workspace_id), ts, true).await;
        let stable = workspace.map(|w| w.stable_id);
        if let Some(entry) = self.connection(id).agents.get_mut(pane_id) {
            entry.stable_id = stable.clone();
        }
        self.append(NewEvent {
            ts,
            kind: "agent.state",
            connection_id: id.to_owned(),
            workspace_id: stable,
            tab_id,
            pane_id: Some(pane_id.to_owned()),
            agent: Some(AgentFields {
                name: name.to_owned(),
                state,
                task: if self.settings.record_agent_titles {
                    title
                } else {
                    None
                },
                session_id,
            }),
            ..Default::default()
        })?;
        Ok(())
    }

    fn agent_gone(&mut self, id: &str, ts: i64, pane_id: &str) -> rusqlite::Result<()> {
        let conn = self.connection(id);
        let Some(previous) = conn.agents.shift_remove(pane_id) else {
            return Ok(());
        };
        if previous.state == "unknown" {
            return Ok(());
        }
        let workspace = conn
            .workspaces
            .get(&previous.workspace_id)
            .map(|w| w.stable_id.clone())
            .or(previous.stable_id.clone());
        self.append(NewEvent {
            ts,
            kind: "agent.state",
            connection_id: id.to_owned(),
            workspace_id: workspace,
            tab_id: previous.tab_id,
            pane_id: Some(pane_id.to_owned()),
            agent: Some(AgentFields {
                name: previous.name,
                state: "unknown",
                task: None,
                session_id: previous.session_id,
            }),
            ..Default::default()
        })?;
        Ok(())
    }

    async fn owned_agents(&mut self, id: &str) -> HashMap<String, OwnedAgent> {
        let host = self.host.clone();
        host.owned_agents(id)
            .await
            .into_iter()
            .map(|agent| (agent.pane_id.clone(), agent))
            .collect()
    }

    async fn handle_herdr_event(&mut self, id: &str, ts: i64, event: &Value) -> Result<(), String> {
        if !self.connection(id).ready {
            return Ok(());
        }
        let name = event
            .get("event")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .or_else(|| {
                event
                    .get("data")
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())
            })
            .map(|n| n.replace('_', "."));
        let data = event.get("data").filter(|d| d.is_object());
        let (Some(name), Some(data)) = (name, data) else {
            return Ok(());
        };
        let pane_id = text(data.get("pane_id"));
        let workspace_id = text(data.get("workspace_id"));
        // Herdr's view of an agent Roamgate runs itself does not follow it.
        if let Some(pane) = &pane_id
            && (name == "pane.agent.status.changed" || name == "pane.agent.detected")
            && self.owned_agents(id).await.contains_key(pane)
        {
            return Ok(());
        }
        let sql = |e: rusqlite::Error| e.to_string();
        match name.as_str() {
            "pane.agent.status.changed" => {
                let (Some(pane_id), Some(workspace_id)) = (pane_id, workspace_id) else {
                    return Ok(());
                };
                let conn = self.connection(id);
                let pane = conn.panes.get(&pane_id).cloned();
                let agent = text(data.get("agent"))
                    .or_else(|| pane.as_ref().and_then(|p| p.agent.clone()))
                    .or_else(|| conn.agents.get(&pane_id).map(|a| a.name.clone()));
                let Some(agent) = agent else { return Ok(()) };
                self.agent_changed(
                    id,
                    ts,
                    &pane_id,
                    &workspace_id,
                    text(data.get("tab_id"))
                        .or_else(|| pane.as_ref().and_then(|p| p.tab_id.clone())),
                    &agent,
                    data.get("agent_status"),
                    pane.as_ref().and_then(|p| p.session_id.clone()),
                    text(data.get("title")).or_else(|| pane.as_ref().and_then(|p| p.title.clone())),
                )
                .await
                .map_err(sql)
            }
            "pane.agent.detected" => {
                if let Some(pane_id) = pane_id
                    && (text(data.get("agent")).is_none()
                        || data.get("released") == Some(&Value::Bool(true)))
                {
                    self.agent_gone(id, ts, &pane_id).map_err(sql)?;
                }
                Ok(())
            }
            "pane.closed" | "pane.exited" => {
                let Some(pane_id) = pane_id else {
                    return Ok(());
                };
                self.connection(id).panes.shift_remove(&pane_id);
                self.agent_gone(id, ts, &pane_id).map_err(sql)
            }
            "pane.moved" => {
                let previous_id = text(data.get("previous_pane_id"));
                let moved = data.get("pane").and_then(pane_info_from);
                let conn = self.connection(id);
                if let (Some(previous_id), Some((moved_id, moved_info))) = (previous_id, moved) {
                    let agent = conn.agents.shift_remove(&previous_id);
                    conn.panes.shift_remove(&previous_id);
                    conn.panes.insert(moved_id.clone(), moved_info.clone());
                    if let Some(agent) = agent {
                        let stable = conn
                            .workspaces
                            .get(&moved_info.workspace_id)
                            .map(|w| w.stable_id.clone())
                            .or(agent.stable_id.clone());
                        conn.agents.insert(
                            moved_id,
                            AgentRecord {
                                workspace_id: moved_info.workspace_id.clone(),
                                stable_id: stable,
                                tab_id: moved_info.tab_id.clone(),
                                ..agent
                            },
                        );
                    }
                }
                conn.stale = true;
                Ok(())
            }
            "workspace.focused" | "pane.focused" => {
                let Some(workspace_id) = workspace_id else {
                    return Ok(());
                };
                self.resolve(id, Some(&workspace_id), ts, false).await;
                self.herdr_focus(id, ts, &workspace_id, pane_id, None, "herdr_event")
                    .map_err(sql)
            }
            "workspace.closed" => {
                let conn = self.connection(id);
                if let Some(workspace_id) = workspace_id {
                    conn.workspaces.shift_remove(&workspace_id);
                }
                conn.stale = true;
                Ok(())
            }
            other => {
                if other.starts_with("workspace.") || other.starts_with("worktree.") {
                    self.connection(id).stale = true;
                }
                Ok(())
            }
        }
    }

    async fn handle_pane_list(
        &mut self,
        id: &str,
        ts: i64,
        result: &Value,
        started_at: i64,
    ) -> Result<(), String> {
        if !self.connection(id).ready || !result.get("panes").is_some_and(Value::is_array) {
            return Ok(());
        }
        let listed = listed_panes(result);
        let owned = self.owned_agents(id).await;
        let mut live: HashSet<String> = HashSet::new();
        let sql = |e: rusqlite::Error| e.to_string();
        for (pane_id, listed_info, listed_status) in listed {
            let mine = owned.get(&pane_id);
            // Herdr sees only the holder in a pane Roamgate runs claude in.
            let info = match mine {
                Some(mine) => PaneInfo {
                    agent: Some("claude".into()),
                    session_id: mine.session_id.clone(),
                    ..listed_info
                },
                None => listed_info,
            };
            let status = match mine {
                Some(mine) => Some(Value::String(mine.agent_status.clone())),
                None => listed_status,
            };
            let conn = self.connection(id);
            conn.panes.insert(pane_id.clone(), info.clone());
            live.insert(pane_id.clone());
            let previous_at = conn.agents.get(&pane_id).map(|a| a.at);
            // A status event newer than this listing wins over it.
            if previous_at.is_some_and(|at| at > started_at) {
                continue;
            }
            let Some(agent) = info.agent.clone() else {
                if previous_at.is_some() {
                    self.agent_gone(id, ts, &pane_id).map_err(sql)?;
                }
                continue;
            };
            self.agent_changed(
                id,
                ts,
                &pane_id,
                &info.workspace_id,
                info.tab_id.clone(),
                &agent,
                status.as_ref(),
                info.session_id.clone(),
                info.title.clone(),
            )
            .await
            .map_err(sql)?;
        }
        let gone: Vec<String> = self
            .connection(id)
            .agents
            .iter()
            .filter(|(pane, agent)| !live.contains(*pane) && agent.at <= started_at)
            .map(|(pane, _)| pane.clone())
            .collect();
        for pane in gone {
            self.agent_gone(id, ts, &pane).map_err(sql)?;
        }
        self.connection(id)
            .panes
            .retain(|pane, _| live.contains(pane));
        // Branches change without a workspace event.
        self.read_repos(id);
        Ok(())
    }

    /// An agent Roamgate runs itself, as Roamgate knows it now.
    async fn handle_owned_agent(&mut self, id: &str, ts: i64, pane_id: &str) -> Result<(), String> {
        if !self.connection(id).ready {
            return Ok(());
        }
        let owned = self.owned_agents(id).await;
        let mine = owned.get(pane_id);
        let conn = self.connection(id);
        let pane = conn.panes.get(pane_id).cloned();
        let workspace_id = pane
            .as_ref()
            .map(|p| p.workspace_id.clone())
            .or_else(|| conn.agents.get(pane_id).map(|a| a.workspace_id.clone()));
        // Not known yet: the next listing records it.
        let (Some(mine), Some(workspace_id)) = (mine, workspace_id) else {
            return Ok(());
        };
        let tab = pane
            .as_ref()
            .and_then(|p| p.tab_id.clone())
            .or_else(|| conn.agents.get(pane_id).and_then(|a| a.tab_id.clone()));
        self.agent_changed(
            id,
            ts,
            pane_id,
            &workspace_id,
            tab,
            "claude",
            Some(&Value::String(mine.agent_status.clone())),
            mine.session_id.clone(),
            pane.and_then(|p| p.title),
        )
        .await
        .map_err(|e| e.to_string())
    }

    // --- Connections ------------------------------------------------------

    async fn handle_status(&mut self, id: &str, ts: i64, state: &str) -> Result<(), String> {
        let sql = |e: rusqlite::Error| e.to_string();
        if state == "ready" {
            if let Some(gap) = self.connection(id).gap.take() {
                self.store().close_gap(gap, ts).map_err(sql)?;
            }
            let conn = self.connection(id);
            if conn.ready {
                return Ok(());
            }
            conn.ready = true;
            conn.stale = true;
            let cause = if conn.was_ready {
                "connection_ready"
            } else {
                "recorder_start"
            };
            conn.was_ready = true;
            if let Err(error) = self.refresh_and_follow_herdr(id, ts, Some(cause)).await {
                let mut fields = error_fields(error);
                fields.insert("connection".into(), json!(id));
                self.logger
                    .debug("activity workspace listing failed", Some(&fields));
            }
            return Ok(());
        }
        if self.connection(id).ready {
            self.connection(id).ready = false;
            let sockets: Vec<u64> = self
                .clients
                .iter()
                .filter(|(_, presence)| {
                    presence
                        .span
                        .as_ref()
                        .is_some_and(|s| s.connection_id == id)
                })
                .map(|(socket, _)| *socket)
                .collect();
            for socket in sockets {
                if let Some(span) = self.clients.get_mut(&socket).and_then(|p| p.span.take()) {
                    self.close_span(&span, ts, "disconnect", None, None)
                        .map_err(sql)?;
                }
            }
            if let Some(focus) = self.connection(id).herdr_focus.take() {
                self.close_span(&focus, ts, "disconnect", None, None)
                    .map_err(sql)?;
            }
            // Herdr may come back as another server: start from what it says then.
            let conn = self.connection(id);
            conn.workspaces.clear();
            conn.panes.clear();
            conn.agents.clear();
            conn.stale = true;
        }
        if self.connection(id).gap.is_none() {
            let gap = self.store().open_gap(Some(id), ts, state).map_err(sql)?;
            self.connection(id).gap = Some(gap);
        }
        Ok(())
    }

    // --- Presence ---------------------------------------------------------

    /// `cause` and `input_age_ms` only when a page's report says so.
    fn visibility(
        &mut self,
        socket: u64,
        ts: i64,
        visible: bool,
        cause: Option<&str>,
        input_age_ms: Option<f64>,
    ) -> rusqlite::Result<()> {
        let Some(state) = self.clients.get_mut(&socket) else {
            return Ok(());
        };
        let Some(connection_id) = state.connection_id.clone() else {
            return Ok(());
        };
        if state.attentive == Some(visible) {
            return Ok(());
        }
        state.attentive = Some(visible);
        let client = state.client.clone();
        self.append(NewEvent {
            ts,
            kind: "ui.visibility",
            connection_id,
            client: Some(client),
            visible: Some(visible),
            cause: cause.map(str::to_owned),
            input_age_ms,
            ..Default::default()
        })?;
        Ok(())
    }

    fn end_presence_span(
        &mut self,
        socket: u64,
        ts: i64,
        reason: &'static str,
        cause: Option<&str>,
        input_age_ms: Option<f64>,
    ) -> rusqlite::Result<()> {
        let Some(span) = self.clients.get_mut(&socket).and_then(|s| s.span.take()) else {
            return Ok(());
        };
        self.close_span(&span, ts, reason, cause, input_age_ms)
    }

    fn arm_timeout(&mut self, socket: u64) {
        let tx = self.tx.clone();
        let clock = self.clock.clone();
        let Some(state) = self.clients.get_mut(&socket) else {
            return;
        };
        if let Some(timeout) = state.timeout.take() {
            timeout.abort();
        }
        state.timeout_token += 1;
        if state.span.is_none() {
            return;
        }
        let token = state.timeout_token;
        state.timeout = Some(tokio::spawn(async move {
            clock
                .sleep(Duration::from_millis(PRESENCE_TIMEOUT_MS as u64))
                .await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Msg::Timeout { socket, token });
            }
        }));
    }

    /// What a report's change comes from (`reportCause`).
    fn report_cause(
        state: &mut PresenceState,
        ts: i64,
        presence: &Presence,
    ) -> (&'static str, bool) {
        match presence.cause.as_deref() {
            Some("follow_herdr") => {
                state.armed_after = ts;
                state.unarmed_cause = "follow_herdr";
                return ("follow_herdr", false);
            }
            Some("app") => {
                state.armed_after = ts;
                state.unarmed_cause = "app";
                return ("app", false);
            }
            _ => {}
        }
        let Some(age) = presence.input_age_ms else {
            state.unarmed_cause = "page_load";
            return ("page_load", false);
        };
        let last_input = ts as f64 - age;
        let armed_after = state.armed_after as f64;
        if last_input < armed_after || (presence.cause.is_none() && last_input == armed_after) {
            return (state.unarmed_cause, false);
        }
        (
            if presence.cause.as_deref() == Some("user_focus") {
                "user_focus"
            } else {
                "user_input"
            },
            true,
        )
    }

    async fn handle_presence(
        &mut self,
        socket: u64,
        connection_id: &str,
        ts: i64,
        presence: &Presence,
    ) -> Result<(), String> {
        let sql = |e: rusqlite::Error| e.to_string();
        let switched = self
            .clients
            .get(&socket)
            .is_some_and(|state| state.client.id != presence.client.id);
        if switched {
            self.end_presence_span(socket, ts, "switch", None, None)
                .map_err(sql)?;
            self.visibility(socket, ts, false, None, None)
                .map_err(sql)?;
            if let Some(timeout) = self.clients.get_mut(&socket).and_then(|s| s.timeout.take()) {
                timeout.abort();
            }
        }
        if switched || !self.clients.contains_key(&socket) {
            // A new state at the socket's place (a JavaScript Map's set).
            self.clients.insert(
                socket,
                PresenceState {
                    client: Client {
                        id: presence.client.id.clone(),
                        kind: presence.client.kind.clone(),
                    },
                    connection_id: None,
                    attentive: None,
                    idle: false,
                    last_presence_at: ts,
                    span: None,
                    timeout: None,
                    timeout_token: 0,
                    // A page's first report on a socket is a load or a
                    // reconnect: what it did before says nothing of now.
                    armed_after: ts,
                    unarmed_cause: "reconnect",
                },
            );
        }
        if self.clients[&socket].connection_id.as_deref() != Some(connection_id) {
            self.end_presence_span(socket, ts, "switch", None, None)
                .map_err(sql)?;
            // The UI's state moves with the browser to the other connection.
            let state = &self.clients[&socket];
            if state.attentive == Some(true) && state.connection_id.is_some() {
                self.visibility(socket, ts, false, None, None)
                    .map_err(sql)?;
            }
            let state = self.clients.get_mut(&socket).expect("inserted");
            state.attentive = None;
            state.connection_id = Some(connection_id.to_owned());
        }
        let state = self.clients.get_mut(&socket).expect("inserted");
        state.last_presence_at = ts;
        let (cause, armed) = Self::report_cause(state, ts, presence);
        let age = presence.input_age_ms;
        let attentive = presence.visible && presence.focused;
        self.visibility(socket, ts, attentive, Some(cause), age)
            .map_err(sql)?;
        if !attentive {
            self.end_presence_span(socket, ts, "hidden", Some(cause), age)
                .map_err(sql)?;
        } else if let Some(age) = age {
            let idle_ms = (self.settings.idle_seconds * 1000) as f64;
            let last_input = ts as f64 - age;
            let idle = age >= idle_ms;
            let was_idle = self.clients[&socket].idle;
            if idle && !was_idle {
                // Reading counted as attention until the threshold, not after it.
                let idle_at = (ts as f64).min(last_input + idle_ms).round() as i64;
                self.clients.get_mut(&socket).expect("inserted").idle = true;
                self.end_presence_span(socket, idle_at, "idle", None, None)
                    .map_err(sql)?;
                let client = self.clients[&socket].client.clone();
                self.append(NewEvent {
                    ts: idle_at,
                    kind: "session.idle",
                    connection_id: connection_id.to_owned(),
                    client: Some(client),
                    idle_after_seconds: Some(self.settings.idle_seconds),
                    ..Default::default()
                })
                .map_err(sql)?;
            } else if !idle && was_idle && armed {
                self.clients.get_mut(&socket).expect("inserted").idle = false;
                let client = self.clients[&socket].client.clone();
                self.append(NewEvent {
                    ts,
                    kind: "session.active",
                    connection_id: connection_id.to_owned(),
                    client: Some(client),
                    cause: Some("user_input".into()),
                    input_age_ms: Some(age),
                    ..Default::default()
                })
                .map_err(sql)?;
            }
            if !self.clients[&socket].idle {
                let workspace = self
                    .resolve(connection_id, presence.workspace_id.as_deref(), ts, true)
                    .await;
                let span = self.clients.get(&socket).and_then(|s| s.span.clone());
                if let Some(span) = &span
                    && (workspace
                        .as_ref()
                        .is_none_or(|w| span.workspace_id != w.stable_id)
                        || span.pane_id != presence.pane_id)
                {
                    self.end_presence_span(socket, ts, "switch", Some(cause), Some(age))
                        .map_err(sql)?;
                }
                let has_span = self.clients.get(&socket).is_some_and(|s| s.span.is_some());
                match workspace {
                    Some(workspace) if !has_span && armed => {
                        let client = self.clients[&socket].client.clone();
                        let span = self
                            .open_span(
                                ts,
                                Span {
                                    seq: 0,
                                    start: ts,
                                    connection_id: connection_id.to_owned(),
                                    workspace_id: workspace.stable_id,
                                    herdr_workspace_id: presence.workspace_id.clone(),
                                    tab_id: presence.tab_id.clone(),
                                    pane_id: presence.pane_id.clone(),
                                    client: Some(client),
                                    source: "browser",
                                },
                                cause,
                                Some(age),
                            )
                            .map_err(sql)?;
                        if let Some(state) = self.clients.get_mut(&socket) {
                            state.span = Some(span);
                        }
                    }
                    _ => {
                        if let Some(span) =
                            self.clients.get_mut(&socket).and_then(|s| s.span.as_mut())
                        {
                            span.tab_id = presence.tab_id.clone();
                        }
                    }
                }
            }
        }
        self.arm_timeout(socket);
        Ok(())
    }

    fn handle_socket_closed(&mut self, socket: u64, ts: i64) -> Result<(), String> {
        if !self.clients.contains_key(&socket) {
            return Ok(());
        }
        if let Some(timeout) = self.clients.get_mut(&socket).and_then(|s| s.timeout.take()) {
            timeout.abort();
        }
        let sql = |e: rusqlite::Error| e.to_string();
        self.end_presence_span(socket, ts, "disconnect", None, None)
            .map_err(sql)?;
        self.visibility(socket, ts, false, None, None)
            .map_err(sql)?;
        self.clients.shift_remove(&socket);
        Ok(())
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        for ticker in self.tickers.drain(..) {
            ticker.abort();
        }
        for state in self.clients.values_mut() {
            if let Some(timeout) = state.timeout.take() {
                timeout.abort();
            }
        }
        if self.store.is_none() {
            return;
        }
        let ts = self.clock.now();
        let result = (|| -> rusqlite::Result<()> {
            let sockets: Vec<u64> = self.clients.keys().copied().collect();
            for socket in sockets {
                self.end_presence_span(socket, ts, "recorder_stop", None, None)?;
                self.visibility(socket, ts, false, None, None)?;
            }
            let ids: Vec<String> = self.connections.keys().cloned().collect();
            for id in ids {
                if let Some(focus) = self.connection(&id).herdr_focus.take() {
                    self.close_span(&focus, ts, "recorder_stop", None, None)?;
                }
                if let Some(gap) = self.connection(&id).gap.take() {
                    self.store().close_gap(gap, ts)?;
                }
            }
            self.store().stop_session(self.session, ts, true)
        })();
        if let Err(error) = result {
            self.logger.warn(
                "activity log could not be closed cleanly",
                Some(&error_fields(error)),
            );
        }
        self.clients.clear();
        self.store = None;
    }
}

#[cfg(test)]
mod tests;
