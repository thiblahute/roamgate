//! Conversation mode on one connection (`service.ts` and its
//! `service-*.ts` parts): the sessions it owns (each with its headless
//! agent), the handovers to and from the panes' terminals, the panes'
//! holders, and the browsers watching each pane. The parts live in the
//! submodules; this wires them and answers the RPCs ([`crate::rpc`]).
//!
//! Leases, suspended jobs and the holders' saved state are written as
//! Bun writes them (the same JSON text); events reach the browsers as
//! `AgentChatEventEnvelope` values in Bun's order.

mod auxiliary;
mod continuity;
mod holders;
mod recover;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use indexmap::IndexSet;
use roamgate_agents::js;
use roamgate_base::paths::{DataContext, random_uuid};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::auto_start::{AutoStartDeps, AutoStarter};
use crate::driver::{BoxFuture, ConversationDriver, Drivers, StartProfile, Transcript};
use crate::handover::{
    ExitSwallowed, Handover, HandoverDeps, HandoverTimes, LaunchCommand, ResumeCommand,
    SuspendedSpec, TerminalTasks, ToTerminal,
};
use crate::headless::SpawnHeadless;
use crate::herdr::{AgentReport, ConversationHerdr};
use crate::holder::{HolderRegistry, hold_reply};
use crate::idle_stop::{IdleStopFacts, idle_stop_refusal};
use crate::lease::LeaseStore;
use crate::session::{
    AskFn, ConversationPrompt, ConversationSession, ReadImageFn, SessionOptions, is_spoken_stop,
};
use crate::shared::{AgentCommand, Lease, LogFn, Obj, PaneFn, PaneQuery, lease_str, refuse};
use crate::shell::ShellRunner;
use crate::suspended::{SuspendedStore, foreground_command, shell_name};
use crate::time::{SharedClock, sleep_ms};

pub use holders::{HolderSideInput, parse_holder_shell_value, parse_holder_status_value};

/// A browser socket, as the transport names it.
pub type SocketId = u64;
/// Sends one envelope (`{event, data}`) to one subscribed browser.
pub type SendFn = Arc<dyn Fn(SocketId, Obj) + Send + Sync>;
/// The browser's prompt card for a pane: the answer, None when denied.
pub type PaneAsk = Arc<
    dyn Fn(String, ConversationPrompt) -> BoxFuture<'static, Result<Option<Value>, String>>
        + Send
        + Sync,
>;
/// The transcript of a pane's session (None: unknown).
pub type PaneTranscript =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<Transcript>, String>> + Send + Sync>;
/// When a pane session's transcript last changed (epoch ms); None: unknown.
pub type TranscriptStat = Arc<dyn Fn(String) -> BoxFuture<'static, Option<f64>> + Send + Sync>;
/// The command a session's agent starts with; Err: the profile cannot be
/// used (a secret file gone).
pub type CommandFor = Arc<dyn Fn(&str) -> Result<AgentCommand, String> + Send + Sync>;

/// /model's list and memory (`options.models`).
#[allow(clippy::type_complexity)]
#[derive(Clone)]
pub struct ModelsDeps {
    /// What the session's profile offers: (models, error).
    pub offered:
        Arc<dyn Fn(String) -> BoxFuture<'static, (Vec<String>, Option<String>)> + Send + Sync>,
    /// The model the pane's transcript last answered with.
    pub last_answered:
        Option<Arc<dyn Fn(String) -> BoxFuture<'static, Option<String>> + Send + Sync>>,
    /// The choice the session's next starts use.
    pub chosen: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// (session, model, resolved).
    pub choose: Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>,
}

/// What a service is given (`ConversationServiceOptions`).
#[allow(clippy::type_complexity)]
#[derive(Clone)]
pub struct ServiceOptions {
    pub connection_id: String,
    pub herdr: Arc<dyn ConversationHerdr>,
    pub leases: LeaseStore,
    pub drivers: Drivers,
    pub clock: SharedClock,
    /// Starts (or reads) the headless agent; by default the pane's holder.
    pub spawn: Option<Arc<dyn SpawnHeadless>>,
    pub ask: PaneAsk,
    pub read_image: ReadImageFn,
    /// Runs a chat's `!` lines on the pane's host; none: refused.
    pub run_shell: Option<Arc<dyn ShellRunner>>,
    pub read_transcript: Option<PaneTranscript>,
    pub send: SendFn,
    pub holder_command: Arc<dyn Fn(&str) -> String + Send + Sync>,
    pub resume_command: Option<ResumeCommand>,
    pub command_for: Option<CommandFor>,
    pub launch_command: Option<LaunchCommand>,
    pub models: Option<ModelsDeps>,
    pub log: Option<LogFn>,
    /// Changes each session's options (tests: timings).
    pub session_tweak: Option<Arc<dyn Fn(&mut SessionOptions) + Send + Sync>>,
    pub handover_times: Option<HandoverTimes>,
    pub terminal_tasks: Option<TerminalTasks>,
    pub exact_status: Option<PaneQuery<String>>,
    pub exit_swallowed: Option<ExitSwallowed>,
    pub hold_poll_ms: u64,
    pub holder_watch_ms: u64,
    pub carried_queue_delay_ms: u64,
    pub reattach_limit: usize,
    pub holder_save_ms: u64,
    pub on_lease_changed: Option<PaneFn>,
    /// A report to Herdr of an owned agent went out (`withStatusReports`).
    pub on_owned_status: Option<PaneFn>,
    pub suspended_file: Option<PathBuf>,
    /// Directory for durable cross-agent work session files; None keeps them in memory.
    pub continuity_dir: Option<PathBuf>,
    pub data: Option<DataContext>,
    pub suspended_watch_ms: u64,
    pub recover_wait_ms: u64,
    pub recover_retry_ms: u64,
    pub recover_attempts: usize,
    pub stuck_after_ms: i64,
    pub stuck_tool_after_ms: i64,
    pub stuck_check_ms: u64,
    pub stop_answer_ms: i64,
    pub transcript_stat: Option<TranscriptStat>,
    pub idle_stop_minutes: Option<Arc<dyn Fn() -> BoxFuture<'static, f64> + Send + Sync>>,
    /// How long a permission request waits for an answer before it is
    /// denied, in seconds (0: never), read as each one comes; None: the
    /// session's own `permission_timeout_ms`.
    pub permission_timeout_seconds: Option<Arc<dyn Fn() -> BoxFuture<'static, u64> + Send + Sync>>,
    pub idle_check_ms: u64,
    pub peer_quiet_ms: Option<i64>,
    /// Why a pane's process must stay up now (a voice call); None: none.
    pub keep_awake: Option<Arc<dyn Fn(String) -> BoxFuture<'static, Option<String>> + Send + Sync>>,
}

impl ServiceOptions {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        connection_id: &str,
        herdr: Arc<dyn ConversationHerdr>,
        leases: LeaseStore,
        drivers: Drivers,
        clock: SharedClock,
        ask: PaneAsk,
        read_image: ReadImageFn,
        send: SendFn,
        holder_command: Arc<dyn Fn(&str) -> String + Send + Sync>,
    ) -> Self {
        Self {
            connection_id: connection_id.into(),
            herdr,
            leases,
            drivers,
            clock,
            spawn: None,
            ask,
            read_image,
            run_shell: None,
            read_transcript: None,
            send,
            holder_command,
            resume_command: None,
            command_for: None,
            launch_command: None,
            models: None,
            log: None,
            session_tweak: None,
            handover_times: None,
            terminal_tasks: None,
            exact_status: None,
            exit_swallowed: None,
            hold_poll_ms: 25_000,
            holder_watch_ms: 30_000,
            carried_queue_delay_ms: 3000,
            reattach_limit: 8,
            holder_save_ms: 1000,
            on_lease_changed: None,
            on_owned_status: None,
            suspended_file: None,
            continuity_dir: None,
            data: None,
            suspended_watch_ms: 30_000,
            recover_wait_ms: 15_000,
            recover_retry_ms: 5000,
            recover_attempts: 12,
            stuck_after_ms: 10 * 60_000,
            stuck_tool_after_ms: 45 * 60_000,
            stuck_check_ms: 60_000,
            stop_answer_ms: 10_000,
            transcript_stat: None,
            idle_stop_minutes: None,
            permission_timeout_seconds: None,
            idle_check_ms: 60_000,
            peer_quiet_ms: None,
            keep_awake: None,
        }
    }
}

/// A lease this runtime dropped, lately: its holder may have missed it.
#[derive(Clone, Debug)]
pub(crate) struct Released {
    session_id: String,
    cwd: String,
    at: i64,
}

pub(crate) struct Inner {
    pub(crate) options: ServiceOptions,
    me: Weak<Inner>,
    disposed: AtomicBool,
    pub(crate) holders: HolderRegistry,
    pub(crate) handover: Handover,
    auto_starter: AutoStarter,
    pub(crate) sessions: Mutex<HashMap<String, ConversationSession>>,
    subscribers: Mutex<HashMap<String, IndexSet<SocketId>>>,
    model_notices: Mutex<HashMap<String, Obj>>,
    pub(crate) suspended: SuspendedStore,
    pub(crate) released: Mutex<HashMap<String, Released>>,
    /// Held around each read-modify-write of a lease: tasks run in
    /// parallel here, where Bun's event loop ran one change at a time.
    pub(crate) lease_lock: Arc<Mutex<()>>,
    /// Each pane's lease as last told to the browsers (to note releases
    /// the handover made).
    known: Mutex<HashMap<String, (String, String)>>,
    pub(crate) aux: auxiliary::AuxState,
    pub(crate) continuity: crate::continuity::WorkSessionStore,
    pub(crate) continuity_rt: continuity::ContinuityRuntime,
    pub(crate) holder_side: holders::HolderSideState,
    pub(crate) recovery: recover::RecoveryState,
    timers: Mutex<Vec<JoinHandle<()>>>,
}

/// Conversation mode on one connection (`createConversationService`).
/// Cheap to clone.
#[derive(Clone)]
pub struct ConversationService {
    pub(crate) inner: Arc<Inner>,
}

const HANDED_BACK_MS: i64 = 60_000;

pub(crate) fn sv(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn herdr_state(status: &str) -> Option<&'static str> {
    match status {
        "stopped" | "idle" => Some("idle"),
        "working" => Some("working"),
        "blocked" => Some("blocked"),
        _ => None,
    }
}

/// Why a profile switch cannot restart the conversation now, for the user.
pub fn restart_refusal(refusal: &str) -> String {
    match refusal {
        "it works" => "The agent is working; switch once its turn ends, or stop it first".into(),
        "it asks the user something" => {
            "The agent is waiting for your answer; answer it, then switch".into()
        }
        "the API key question waits" => {
            "The agent waits for the API key question; answer it, then switch".into()
        }
        "messages wait in its queue" => {
            "Messages wait in the agent's queue; switch once they are sent, or take them back"
                .into()
        }
        "background work runs" => "The agent runs background tasks that a restart would stop; switch once they end, or stop them".into(),
        "a shell line runs" => "A shell line still runs; switch once it ends".into(),
        other => format!("The agent cannot switch now: {other}"),
    }
}

fn not_owned_reason(lease: &Option<Lease>) -> String {
    if lease.is_some() {
        "This session is being handed over; try again shortly".into()
    } else {
        "The terminal owns this session".into()
    }
}

fn fail(reason: impl Into<String>) -> Value {
    json!({"ok": false, "reason": reason.into()})
}

fn obj_of(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl Inner {
    pub(crate) fn me(&self) -> Arc<Inner> {
        self.me.upgrade().expect("the service")
    }

    pub(crate) fn closed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    pub(crate) fn now(&self) -> i64 {
        self.options.clock.now()
    }

    pub(crate) fn iso_now(&self) -> String {
        js::iso(self.now() as f64)
    }

    pub(crate) fn log(&self, message: &str, fields: Value) {
        if let Some(log) = &self.options.log {
            log(message, obj_of(fields));
        }
    }

    pub(crate) fn lease(&self, pane_id: &str) -> Option<Lease> {
        self.options.leases.get(pane_id)
    }

    pub(crate) fn phase(&self, pane_id: &str) -> Option<String> {
        self.lease(pane_id)
            .and_then(|lease| lease_str(&lease, "phase").map(str::to_owned))
    }

    pub(crate) fn owns(&self, pane_id: &str) -> bool {
        self.phase(pane_id).as_deref() == Some("conversation")
    }

    /// Sets a lease, unless the service is closing (`releasingLeases`).
    pub(crate) fn set_lease(&self, lease: Lease) -> bool {
        if self.closed() {
            return false;
        }
        if let Some(pane) = lease_str(&lease, "pane_id") {
            self.released.lock().unwrap().remove(pane);
        }
        self.options.leases.set(lease);
        true
    }

    pub(crate) fn delete_lease(&self, pane_id: &str) -> bool {
        if self.closed() {
            return false;
        }
        if let Some(lease) = self.lease(pane_id) {
            self.released.lock().unwrap().insert(
                pane_id.to_owned(),
                Released {
                    session_id: lease_str(&lease, "session_id").unwrap_or("").into(),
                    cwd: lease_str(&lease, "cwd").unwrap_or("").into(),
                    at: self.now(),
                },
            );
        }
        self.options.leases.delete(pane_id);
        true
    }

    pub(crate) fn driver_of(&self, pane_id: &str) -> ConversationDriver {
        let lease = self.lease(pane_id);
        self.options
            .drivers
            .of(lease.as_ref().and_then(|lease| lease_str(lease, "agent")))
            .clone()
    }

    pub(crate) fn session(&self, pane_id: &str) -> Option<ConversationSession> {
        self.sessions.lock().unwrap().get(pane_id).cloned()
    }

    pub(crate) fn emit(&self, pane_id: &str, event: Obj) {
        let watchers: Vec<SocketId> = match self.subscribers.lock().unwrap().get(pane_id) {
            Some(watchers) if !watchers.is_empty() => watchers.iter().copied().collect(),
            _ => return,
        };
        let kind = sv(event.get("type")).to_owned();
        let mut data = event;
        let has_session = data.contains_key("session_id");
        data.insert("pane_id".into(), Value::String(pane_id.into()));
        if !has_session {
            let session = self
                .lease(pane_id)
                .and_then(|lease| lease_str(&lease, "session_id").map(str::to_owned));
            data.insert(
                "session_id".into(),
                session.map(Value::String).unwrap_or(Value::Null),
            );
        }
        let mut envelope = Map::new();
        envelope.insert("event".into(), Value::String(format!("agent_chat.{kind}")));
        envelope.insert("data".into(), Value::Object(data));
        for socket in watchers {
            (self.options.send)(socket, envelope.clone());
        }
    }

    pub(crate) fn emit_lease(&self, pane_id: &str) {
        if let Some(changed) = &self.options.on_lease_changed {
            changed(pane_id);
        }
        let lease = self.lease(pane_id);
        {
            let mut known = self.known.lock().unwrap();
            match &lease {
                Some(lease) => {
                    known.insert(
                        pane_id.to_owned(),
                        (
                            lease_str(lease, "session_id").unwrap_or("").into(),
                            lease_str(lease, "cwd").unwrap_or("").into(),
                        ),
                    );
                }
                None => {
                    // A lease the handover dropped: its holder may poll late.
                    if let Some((session_id, cwd)) = known.remove(pane_id) {
                        self.released
                            .lock()
                            .unwrap()
                            .entry(pane_id.to_owned())
                            .or_insert(Released {
                                session_id,
                                cwd,
                                at: self.now(),
                            });
                    }
                }
            }
        }
        if lease.is_none() {
            let stale = self.sessions.lock().unwrap().remove(pane_id);
            if let Some(stale) = stale {
                stale.dispose(false);
            }
            self.drop_channel(pane_id);
            self.recovery.lost.lock().unwrap().remove(pane_id);
            self.model_notices.lock().unwrap().remove(pane_id);
        }
        let mut event = Map::new();
        event.insert("type".into(), json!("lease"));
        event.insert(
            "owner".into(),
            json!(
                lease
                    .as_ref()
                    .and_then(|lease| lease_str(lease, "owner"))
                    .unwrap_or("terminal")
            ),
        );
        event.insert(
            "phase".into(),
            json!(
                lease
                    .as_ref()
                    .and_then(|lease| lease_str(lease, "phase"))
                    .unwrap_or("terminal")
            ),
        );
        event.insert(
            "session_id".into(),
            lease
                .as_ref()
                .and_then(|lease| lease_str(lease, "session_id"))
                .map(|id| json!(id))
                .unwrap_or(Value::Null),
        );
        self.emit(pane_id, event);
    }

    /// Records whether a turn runs on the pane's lease, or that one was cut
    /// short (`markTurn`): "running", "ended", or the interruption's reason.
    pub(crate) fn mark_turn(&self, pane_id: &str, mark: &str) {
        if self.closed() {
            return;
        }
        let guard = self.lease_lock.lock().unwrap();
        let Some(current) = self.lease(pane_id) else {
            return;
        };
        if lease_str(&current, "phase") != Some("conversation") {
            return;
        }
        let started = current.contains_key("turn_started_at");
        let interrupted = current.contains_key("interrupted");
        if mark == "ended" && !started {
            return;
        }
        if mark == "running" && started && !interrupted {
            return;
        }
        if mark == "process_exited" && !started {
            return;
        }
        let mut next = current.clone();
        next.shift_remove("turn_started_at");
        next.shift_remove("interrupted");
        if mark == "running" {
            next.insert("turn_started_at".into(), json!(self.iso_now()));
        } else if mark != "ended" {
            next.insert(
                "interrupted".into(),
                json!({"at": self.iso_now(), "reason": mark}),
            );
        }
        let now_interrupted = next.get("interrupted").cloned();
        self.set_lease(next);
        drop(guard);
        if now_interrupted.is_some() || interrupted {
            let mut event = Map::new();
            event.insert("type".into(), json!("interrupted"));
            event.insert("interrupted".into(), now_interrupted.unwrap_or(Value::Null));
            self.emit(pane_id, event);
        }
    }

    /// The session's profile, for a start (`profileOf`), restricted to `agent`.
    pub(crate) fn profile_of_for(
        &self,
        session_id: &str,
        agent: &str,
    ) -> Result<Option<StartProfile>, String> {
        let Some(command_for) = &self.options.command_for else {
            return Ok(None);
        };
        let command = command_for(session_id)?;
        if command.plain || (!command.agent.is_empty() && command.agent != agent) {
            return Ok(None);
        }
        self.log(
            "the conversation process starts with a profile",
            json!({"session": session_id, "profile": command.profile, "program": command.program}),
        );
        Ok(Some(StartProfile {
            program: command.program.clone(),
            env: command.env.clone(),
            unset: command.unset.clone(),
        }))
    }

    /// The profile a session resumes with in the terminal (`resumeProfile`).
    pub(crate) fn resume_profile(&self, session_id: &str) -> Option<AgentCommand> {
        let command_for = self.options.command_for.as_ref()?;
        match command_for(session_id) {
            Ok(command) => Some(command),
            Err(error) => {
                self.log(
                    "the session's profile cannot be used; claude resumes plain",
                    json!({"session": session_id, "error": error}),
                );
                None
            }
        }
    }

    /// The profile a session resumes with, only when it targets `agent`.
    pub(crate) fn resume_profile_for(&self, session_id: &str, agent: &str) -> Option<AgentCommand> {
        self.resume_profile(session_id)
            .filter(|command| command.agent.is_empty() || command.agent == agent)
    }

    fn restart_refusal_of(&self, pane_id: &str, session: &ConversationSession) -> Option<String> {
        let live = session.state();
        let status = sv(live.get("status"));
        idle_stop_refusal(&IdleStopFacts {
            limit_ms: 1,
            now: i64::MAX,
            idle_since: 0,
            last_peer_at: None,
            peer_quiet_ms: None,
            conversation: true,
            alive: true,
            status: if status == "stopped" {
                "idle".into()
            } else {
                status.into()
            },
            busy: session.busy(),
            queued: live
                .get("queue")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
            background_tasks: session.background_tasks(),
            shell_running: self.shells_running(pane_id),
            api_key_question: self.api_key_waits(pane_id),
            kept_awake: None,
        })
    }

    fn set_model_notice(&self, pane_id: &str, notice: Option<Obj>) {
        if self.closed() {
            return;
        }
        match &notice {
            None => {
                if self.model_notices.lock().unwrap().remove(pane_id).is_none() {
                    return;
                }
            }
            Some(notice) => {
                self.model_notices
                    .lock()
                    .unwrap()
                    .insert(pane_id.to_owned(), notice.clone());
            }
        }
        let mut event = Map::new();
        event.insert("type".into(), json!("model_notice"));
        event.insert(
            "model_notice".into(),
            notice.map(Value::Object).unwrap_or(Value::Null),
        );
        self.emit(pane_id, event);
    }

    pub(crate) fn clear_interrupted(&self, pane_id: &str) {
        if self.closed() {
            return;
        }
        {
            let _guard = self.lease_lock.lock().unwrap();
            let Some(current) = self.lease(pane_id) else {
                return;
            };
            if !current.contains_key("interrupted") {
                return;
            }
            let mut next = current;
            next.shift_remove("interrupted");
            self.set_lease(next);
        }
        self.emit(
            pane_id,
            obj_of(json!({"type": "interrupted", "interrupted": null})),
        );
    }

    pub(crate) fn report(&self, pane_id: &str, status: &str) {
        let Some(lease) = self.lease(pane_id) else {
            return;
        };
        let Some(state) = herdr_state(status) else {
            return;
        };
        if lease_str(&lease, "phase") != Some("conversation") {
            return;
        }
        let report = AgentReport {
            pane_id: pane_id.into(),
            state: state.into(),
            session_id: lease_str(&lease, "session_id").unwrap_or("").into(),
            message: Some("conversation mode".into()),
            agent: Some(
                self.options
                    .drivers
                    .of(lease_str(&lease, "agent"))
                    .terminal
                    .herdr_agent()
                    .to_owned(),
            ),
        };
        let me = self.me();
        let pane = pane_id.to_owned();
        tokio::spawn(async move {
            match me.options.herdr.report_agent(report).await {
                Ok(()) => {
                    if let Some(owned) = &me.options.on_owned_status {
                        owned(&pane);
                    }
                }
                Err(error) => me.log(
                    "could not report the conversation to Herdr",
                    json!({"pane": pane, "error": error}),
                ),
            }
        });
    }

    /// The pane's session, made when conversation mode owns it
    /// (`sessionFor`).
    pub(crate) fn session_for(&self, pane_id: &str) -> Result<ConversationSession, String> {
        if self.closed() {
            return Err("The connection is closing".into());
        }
        let lease = self.lease(pane_id);
        let Some(lease) = lease.filter(|lease| lease_str(lease, "phase") == Some("conversation"))
        else {
            return Err(if self.lease(pane_id).is_some() {
                "This session is being handed over; try again shortly".into()
            } else {
                "The terminal owns this session; show the chat to take it over".into()
            });
        };
        if let Some(session) = self.session(pane_id) {
            return Ok(session);
        }
        let carried: Vec<Obj> = lease
            .get("queue")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_object().cloned())
                    .collect()
            })
            .unwrap_or_default();
        if !carried.is_empty() {
            let mut rest = lease.clone();
            rest.shift_remove("queue");
            self.set_lease(rest);
        }
        let me = self.me.clone();
        let pane = pane_id.to_owned();
        let weak = |run: fn(&Arc<Inner>, &str)| {
            let me = me.clone();
            let pane = pane.clone();
            move || {
                if let Some(me) = me.upgrade() {
                    run(&me, &pane);
                }
            }
        };
        let emit_me = me.clone();
        let emit_pane = pane.clone();
        let ask_me = me.clone();
        let ask_pane = pane.clone();
        let ask: AskFn = Arc::new(move |prompt: ConversationPrompt| {
            let ask_me = ask_me.clone();
            let pane = ask_pane.clone();
            Box::pin(async move {
                match ask_me.upgrade() {
                    Some(me) => (me.options.ask)(pane, prompt).await,
                    None => Ok(None),
                }
            })
        });
        let driver = self.driver_of(pane_id).protocol;
        let mut options = SessionOptions::new(
            pane_id,
            lease_str(&lease, "session_id").unwrap_or(""),
            lease_str(&lease, "cwd").unwrap_or(""),
            Arc::new(holders::GuardedSpawn {
                service: me.clone(),
                pane_id: pane.clone(),
            }),
            Arc::new(move |event: Obj| {
                if let Some(me) = emit_me.upgrade() {
                    me.observe_session_event(&emit_pane, &event);
                    me.emit(&emit_pane, event);
                }
            }),
            ask,
            self.options.read_image.clone(),
            self.options.clock.clone(),
            driver,
        );
        options.log = self.options.log.clone();
        if let Some(seconds) = self.options.permission_timeout_seconds.clone() {
            options.permission_timeout = Some(Arc::new(move || {
                let seconds = seconds();
                Box::pin(async move { seconds.await.saturating_mul(1000) })
            }));
        }
        options.queue = carried;
        options.asleep = lease.contains_key("asleep_at");
        {
            let me = me.clone();
            let pane = pane.clone();
            options.prelude = Some(Arc::new(move || {
                me.upgrade().and_then(|me| me.take_shells(&pane))
            }));
        }
        if let Some(read) = &self.options.read_transcript {
            let read = read.clone();
            let pane = pane.clone();
            options.read_transcript = Some(Arc::new(move || read(pane.clone())));
        }
        {
            let me = me.clone();
            let pane = pane.clone();
            options.on_session_id = Some(Arc::new(move |session_id: &str, _previous: &str| {
                let Some(me) = me.upgrade() else { return };
                if me.closed() {
                    return;
                }
                let work_session = {
                    let _guard = me.lease_lock.lock().unwrap();
                    let Some(mut current) = me.lease(&pane) else {
                        return;
                    };
                    current.insert("session_id".into(), json!(session_id));
                    let work_session = lease_str(&current, "work_session_id").map(str::to_owned);
                    me.set_lease(current);
                    work_session
                };
                if let Some(work_session) = work_session {
                    me.continuity
                        .set_active_native_session(&work_session, session_id);
                }
                me.holders.send(&pane, &hold_reply(session_id));
                me.report(&pane, "idle");
                me.emit_lease(&pane);
            }));
        }
        {
            let me = me.clone();
            let pane = pane.clone();
            options.on_status = Some(Arc::new(move |status: &str| {
                let Some(me) = me.upgrade() else { return };
                if status != "working" {
                    me.clear_stuck(&pane);
                }
                me.report(&pane, status);
            }));
        }
        options.on_output = Some(Arc::new(weak(|me, pane| me.stuck_output(pane))));
        {
            let me = me.clone();
            let pane = pane.clone();
            options.on_asleep = Some(Arc::new(move |asleep: bool| {
                if let Some(me) = me.upgrade() {
                    me.set_asleep(&pane, asleep);
                }
            }));
        }
        options.on_peer = Some(Arc::new(weak(|me, pane| me.note_peer(pane))));
        {
            let me = me.clone();
            let pane = pane.clone();
            options.on_turn = Some(Arc::new(move |running: bool| {
                if let Some(me) = me.upgrade() {
                    me.mark_turn(&pane, if running { "running" } else { "ended" });
                }
            }));
        }
        {
            let me = me.clone();
            let pane = pane.clone();
            options.on_process = Some(Arc::new(move |pid: Option<u32>, resumed: Option<&str>| {
                let Some(me) = me.upgrade() else { return };
                if me.closed() {
                    return;
                }
                if pid.is_none() {
                    me.mark_turn(&pane, "process_exited");
                }
                let _guard = me.lease_lock.lock().unwrap();
                let Some(current) = me.lease(&pane) else {
                    return;
                };
                if lease_str(&current, "phase") != Some("conversation") {
                    return;
                }
                let mut next = current.clone();
                match pid {
                    None => {
                        next.shift_remove("headless_pid");
                    }
                    Some(pid) => {
                        next.insert("headless_pid".into(), json!(pid));
                    }
                }
                if let Some(resumed) = resumed {
                    let mut ids: Vec<Value> = current
                        .get("headless_session_ids")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|id| id.as_str() != Some(resumed))
                        .collect();
                    ids.push(json!(resumed));
                    let skip = ids.len().saturating_sub(4);
                    next.insert(
                        "headless_session_ids".into(),
                        Value::Array(ids.into_iter().skip(skip).collect()),
                    );
                }
                me.set_lease(next);
            }));
        }
        if let Some(tweak) = &self.options.session_tweak {
            tweak(&mut options);
        }
        let session = ConversationSession::new(options);
        self.sessions
            .lock()
            .unwrap()
            .insert(pane_id.to_owned(), session.clone());
        Ok(session)
    }

    /// The chat's state of a pane (`state`).
    pub(crate) fn state(&self, pane_id: &str) -> Obj {
        let lease = self.lease(pane_id);
        let session = self.session(pane_id);
        let live = session.as_ref().map(|session| session.state());
        let protocol = lease.as_ref().map(|lease| {
            self.options
                .drivers
                .of(lease_str(lease, "agent"))
                .protocol
                .clone()
        });
        let lost = self.recovery.lost.lock().unwrap().get(pane_id).cloned();
        let stuck = self.stuck_of(pane_id);
        let api_key = self.api_key_question(pane_id);
        let shells = self.shell_list(pane_id);
        let get = |key: &str| lease.as_ref().and_then(|lease| lease.get(key)).cloned();
        let mut state = Map::new();
        state.insert("pane_id".into(), json!(pane_id));
        state.insert("owner".into(), get("owner").unwrap_or(json!("terminal")));
        state.insert("phase".into(), get("phase").unwrap_or(json!("terminal")));
        state.insert(
            "session_id".into(),
            get("session_id").unwrap_or(Value::Null),
        );
        state.insert("cwd".into(), get("cwd").unwrap_or(Value::Null));
        state.insert(
            "status".into(),
            live.as_ref()
                .and_then(|live| live.get("status").cloned())
                .unwrap_or(json!("stopped")),
        );
        if let Some(protocol) = &protocol {
            state.insert("agent".into(), json!(protocol.agent()));
            state.insert("capabilities".into(), protocol.capabilities());
        }
        let live_get = |key: &str| live.as_ref().and_then(|live| live.get(key)).cloned();
        state.insert(
            "tools_running".into(),
            live_get("tools_running").unwrap_or(json!(false)),
        );
        state.insert(
            "running_tools".into(),
            live_get("running_tools").unwrap_or(json!([])),
        );
        state.insert(
            "activity".into(),
            live_get("activity").unwrap_or(Value::Null),
        );
        let queue = live_get("queue")
            .or_else(|| get("queue"))
            .or_else(|| {
                self.recovery
                    .parked
                    .lock()
                    .unwrap()
                    .get(pane_id)
                    .map(|items| Value::Array(items.iter().cloned().map(Value::Object).collect()))
            })
            .unwrap_or(json!([]));
        state.insert("queue".into(), queue);
        state.insert(
            "interrupted".into(),
            get("interrupted").unwrap_or(Value::Null),
        );
        if lease.is_some() {
            if let Some(lost) = lost {
                state.insert("lost".into(), Value::Object(lost));
            }
            if let Some(stuck) = stuck {
                state.insert("stuck".into(), Value::Object(stuck));
            }
        }
        if let Some(since) = get("asleep_at").filter(|value| !value.is_null()) {
            state.insert("asleep".into(), json!({"since": since}));
        }
        if let Some(question) = api_key {
            state.insert("api_key_question".into(), Value::Object(question));
        }
        if let Some(next) = live_get("next_prompt").filter(|value| !value.is_null()) {
            state.insert("next_prompt".into(), next);
        }
        if lease.is_some()
            && let Some(notice) = self.model_notices.lock().unwrap().get(pane_id)
        {
            state.insert("model_notice".into(), Value::Object(notice.clone()));
        }
        if !shells.is_empty() {
            state.insert(
                "shells".into(),
                Value::Array(shells.into_iter().map(Value::Object).collect()),
            );
        }
        self.populate_continuity_state(pane_id, &mut state);
        state
    }

    /// Warms the process for the next turn; a failure shows on that turn.
    pub(crate) fn warm(&self, pane_id: &str) {
        if self.closed() {
            return;
        }
        let me = self.me();
        let pane = pane_id.to_owned();
        tokio::spawn(async move {
            let result = match me.session_for(&pane) {
                Ok(session) => session.warm().await,
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                me.log(
                    "conversation process did not start",
                    json!({"pane": pane, "error": error}),
                );
            }
        });
    }

    /// The pane is gone: its lease goes, and the headless process with it.
    pub(crate) fn pane_closed(&self, pane_id: &str) {
        if self.closed() {
            return;
        }
        self.auto_starter.cancel(pane_id);
        self.forget_peer(pane_id);
        let session = self.sessions.lock().unwrap().remove(pane_id);
        if let Some(session) = session {
            session.dispose(false);
        }
        self.holders.forget(pane_id);
        self.drop_channel(pane_id);
        self.clear_stuck(pane_id);
        self.drop_suspended(pane_id, "pane closed");
        if self.lease(pane_id).is_none() {
            return;
        }
        self.log(
            "the pane of a conversation closed; its lease goes",
            json!({"pane": pane_id}),
        );
        self.delete_lease(pane_id);
        self.emit_lease(pane_id);
    }

    pub(crate) fn drop_suspended(&self, pane_id: &str, why: &str) {
        if !self.suspended.delete(pane_id) {
            return;
        }
        self.log(
            "stopped conversation gone",
            json!({"pane": pane_id, "why": why}),
        );
        if let Some(changed) = &self.options.on_lease_changed {
            changed(pane_id);
        }
    }

    async fn check_suspended(&self, entry: Obj) {
        if self.closed() {
            return;
        }
        let pane = sv(entry.get("pane_id")).to_owned();
        if self.options.herdr.pane_exists(&pane).await == Ok(false) {
            return self.drop_suspended(&pane, "pane closed");
        }
        if let Some(pid) = entry.get("holder_pid").and_then(Value::as_u64)
            && pid > 0
            && !self.options.herdr.pid_alive(pid as u32).await
            && self.suspended.get(&pane).as_ref() == Some(&entry)
        {
            self.drop_suspended(&pane, "holder gone");
        }
    }

    // The switches (service-handover.ts).

    pub(crate) async fn to_conversation(
        &self,
        pane_id: &str,
        session_id: Option<&str>,
        quit_writer: Option<&str>,
    ) -> Obj {
        if let Some(other) = quit_writer {
            self.log(
                "quitting the other claude on the session first",
                json!({"pane": pane_id, "other": other}),
            );
        }
        let result = self
            .handover
            .to_conversation(pane_id, session_id, quit_writer)
            .await
            .unwrap_or_else(refuse);
        self.emit_lease(pane_id);
        if result.get("ok") != Some(&Value::Bool(true)) {
            self.log(
                "conversation mode refused",
                json!({"pane": pane_id, "reason": result.get("reason")}),
            );
            return result;
        }
        if self.closed() {
            return refuse("The connection is closing");
        }
        self.carry_parked(pane_id);
        self.report(pane_id, "idle");
        self.warm(pane_id);
        result
    }

    pub(crate) async fn to_terminal(
        &self,
        pane_id: &str,
        interrupt: bool,
        confirm: Option<bool>,
        suspend: Option<Option<String>>,
    ) -> Obj {
        // One writer at a time: the switch to another agent ends first.
        if self
            .lease(pane_id)
            .is_some_and(|lease| lease.contains_key("handoff_phase"))
        {
            return refuse("The conversation is moving to another agent; try again once it has");
        }
        self.settle_api_key(
            pane_id,
            None,
            Some("The session went back to the terminal".into()),
        );
        let held = self.lease(pane_id);
        if held
            .as_ref()
            .is_some_and(|lease| lease_str(lease, "phase") == Some("conversation"))
            && !self.holders.connected(pane_id, None, None)
            && self.recover_later(pane_id).await
        {
            let held = held.unwrap();
            return obj_of(json!({
                "ok": true,
                "owner": "terminal",
                "session_id": lease_str(&held, "session_id"),
            }));
        }
        let mut session = self.session(pane_id);
        if session.is_none() && self.owns(pane_id) {
            session = self.session_for(pane_id).ok();
        }
        let attached = match &session {
            Some(session) => session.attach().await.is_ok(),
            None => false,
        };
        if !attached
            && self.holders.connected(pane_id, None, None)
            && self
                .channel(pane_id)
                .is_some_and(|channel| channel.child_alive())
        {
            return refuse(
                "Roamgate is still reading the conversation process the pane runs; try again in a moment",
            );
        }
        let (holder_pid, job) = self.holders.shell(pane_id);
        let headless: Option<Arc<dyn crate::handover::HeadlessSide>> =
            session.clone().map(|session| {
                Arc::new(SessionSide(session)) as Arc<dyn crate::handover::HeadlessSide>
            });
        let title = suspend.clone().flatten();
        let result = self
            .handover
            .to_terminal(
                pane_id,
                headless,
                ToTerminal {
                    interrupt,
                    confirm,
                    suspend,
                },
            )
            .await
            .unwrap_or_else(refuse);
        let ok = result.get("ok") == Some(&Value::Bool(true));
        if ok
            && let Some(session) = &session
            && self.lease(pane_id).is_none()
        {
            self.sessions.lock().unwrap().remove(pane_id);
            session.dispose(false);
        }
        if ok
            && result.get("suspended") == Some(&Value::Bool(true))
            && let Some(held) = &held
        {
            let mut entry = Map::new();
            entry.insert("pane_id".into(), json!(pane_id));
            entry.insert("session_id".into(), json!(lease_str(held, "session_id")));
            if let Some(title) = title {
                entry.insert("title".into(), json!(title));
            }
            if let Some(agent) = held.get("agent") {
                entry.insert("agent".into(), agent.clone());
            }
            entry.insert("suspended_at".into(), json!(self.iso_now()));
            if let Some(pid) = holder_pid {
                entry.insert("holder_pid".into(), json!(pid));
            }
            if let Some(job) = job {
                entry.insert("job".into(), json!(job));
            }
            self.suspended.set(entry);
            self.log(
                "conversation stopped as a shell job",
                json!({"pane": pane_id}),
            );
        }
        self.emit_lease(pane_id);
        if !ok {
            self.log(
                "hand back refused",
                json!({"pane": pane_id, "reason": result.get("reason")}),
            );
        }
        result
    }

    #[allow(clippy::wrong_self_convention)]
    pub(crate) async fn from_suspended(
        &self,
        pane_id: &str,
        spec: SuspendedSpec,
        attach: impl FnOnce(),
    ) -> Obj {
        let session_id = spec.session_id.clone();
        let result = self
            .handover
            .from_suspended(pane_id, spec)
            .await
            .unwrap_or_else(refuse);
        self.emit_lease(pane_id);
        if result.get("ok") != Some(&Value::Bool(true)) {
            self.log(
                "fg refused",
                json!({"pane": pane_id, "reason": result.get("reason")}),
            );
            return result;
        }
        if self.closed() {
            return refuse("The connection is closing");
        }
        attach();
        if self
            .suspended
            .get(pane_id)
            .is_some_and(|entry| sv(entry.get("session_id")) == session_id)
        {
            self.suspended.delete(pane_id);
        }
        self.log(
            "conversation back from the shell (fg)",
            json!({"pane": pane_id}),
        );
        self.carry_parked(pane_id);
        self.report(pane_id, "idle");
        self.warm(pane_id);
        self.emit_lease(pane_id);
        result
    }
}

/// A session as the handover sees it.
struct SessionSide(ConversationSession);

impl crate::handover::HeadlessSide for SessionSide {
    fn busy(&self) -> bool {
        self.0.busy()
    }
    fn background_tasks(&self) -> usize {
        self.0.background_tasks()
    }
    fn queue_length(&self) -> usize {
        self.0.queue_length()
    }
    fn interrupt(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.0.interrupt().await.unwrap_or(false) })
    }
    fn wait_for_result(&self, timeout_ms: u64) -> BoxFuture<'_, bool> {
        Box::pin(self.0.wait_for_result(timeout_ms))
    }
    fn stop(&self) -> BoxFuture<'_, bool> {
        Box::pin(self.0.stop())
    }
    fn pid(&self) -> Option<u32> {
        self.0.pid()
    }
}

impl ConversationService {
    pub fn new(options: ServiceOptions) -> Self {
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| {
            let closed_me = me.clone();
            let closed: Arc<dyn Fn() -> bool + Send + Sync> =
                Arc::new(move || closed_me.upgrade().is_none_or(|me| me.closed()));
            let holders = HolderRegistry::new(options.clock.clone());
            // The handover's lease writes take it too.
            let lease_lock: Arc<Mutex<()>> = Arc::default();
            let mut deps = HandoverDeps::new(
                options.herdr.clone(),
                options.leases.clone(),
                holders.clone(),
                options.drivers.clone(),
                options.clock.clone(),
                options.holder_command.clone(),
            );
            deps.resume_command = options.resume_command.clone();
            deps.launch_command = options.launch_command.clone();
            deps.closed = Some(closed.clone());
            deps.lease_lock = Some(lease_lock.clone());
            deps.terminal_tasks = options.terminal_tasks.clone();
            deps.exact_status = options.exact_status.clone();
            deps.exit_swallowed = options.exit_swallowed.clone();
            if let Some(times) = &options.handover_times {
                deps.times = times.clone();
            }
            {
                let me = me.clone();
                deps.resume_profile = Some(Arc::new(move |session_id: &str| {
                    me.upgrade().and_then(|me| me.resume_profile(session_id))
                }));
            }
            {
                let me = me.clone();
                deps.on_lease = Some(Arc::new(move |pane: &str| {
                    if let Some(me) = me.upgrade() {
                        me.emit_lease(pane);
                    }
                }));
            }
            {
                let me = me.clone();
                deps.on_pane_gone = Some(Arc::new(move |pane: &str| {
                    if let Some(me) = me.upgrade() {
                        me.pane_closed(pane);
                    }
                }));
            }
            {
                let me = me.clone();
                deps.on_exit_dialog = Some(Arc::new(move |pane: &str, work: Option<&str>| {
                    if let Some(me) = me.upgrade() {
                        let mut fields = json!({"pane": pane});
                        if let Some(work) = work {
                            fields["work"] = json!(work);
                        }
                        me.log("claude asked before exiting; answered Stay", fields);
                    }
                }));
            }
            let handover = Handover::new(deps);
            let to_conv_me = me.clone();
            let owned_me = me.clone();
            let mut auto = AutoStartDeps::new(
                Arc::new(move |pane: String, session: String| {
                    let me = to_conv_me.clone();
                    Box::pin(async move {
                        match me.upgrade() {
                            Some(me) => Ok(me.to_conversation(&pane, Some(&session), None).await),
                            None => Err("The connection is closing".into()),
                        }
                    })
                }),
                Arc::new(move |pane: &str| {
                    owned_me
                        .upgrade()
                        .is_some_and(|me| me.lease(pane).is_some())
                }),
                closed,
                options.clock.clone(),
            );
            auto.log = options.log.clone();
            let suspended = SuspendedStore::new(
                &options.connection_id,
                options.suspended_file.clone(),
                options.data.clone(),
            );
            let continuity = crate::continuity::WorkSessionStore::new(
                &options.connection_id,
                options.continuity_dir.clone(),
                options.data.clone(),
                options.clock.clone(),
            );
            let unread: IndexSet<String> = options
                .leases
                .all()
                .iter()
                .filter(|lease| lease_str(lease, "phase") == Some("conversation"))
                .filter_map(|lease| lease_str(lease, "pane_id").map(str::to_owned))
                .collect();
            Inner {
                me: me.clone(),
                disposed: AtomicBool::new(false),
                holders,
                handover,
                auto_starter: AutoStarter::new(auto),
                sessions: Mutex::new(HashMap::new()),
                subscribers: Mutex::new(HashMap::new()),
                model_notices: Mutex::new(HashMap::new()),
                suspended,
                released: Mutex::new(HashMap::new()),
                lease_lock,
                known: Mutex::new(HashMap::new()),
                aux: auxiliary::AuxState::default(),
                continuity,
                continuity_rt: continuity::ContinuityRuntime::default(),
                holder_side: holders::HolderSideState::default(),
                recovery: recover::RecoveryState::new(unread, options.reattach_limit),
                timers: Mutex::new(Vec::new()),
                options,
            }
        });
        // A switch to another agent cut short: one agent writes.
        inner.recover_switches();
        // A handover cut short (a restart, or the runtime replaced).
        for lease in inner.options.leases.all() {
            let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
            match lease_str(&lease, "phase") {
                Some("to_terminal") => {
                    let mut next = lease.clone();
                    next.insert("phase".into(), json!("conversation"));
                    inner.set_lease(next);
                }
                Some("to_conversation") => {
                    inner.delete_lease(&pane);
                }
                _ => {}
            }
            if let Some(lease) = inner.lease(&pane) {
                inner.known.lock().unwrap().insert(
                    pane.clone(),
                    (
                        lease_str(&lease, "session_id").unwrap_or("").into(),
                        lease_str(&lease, "cwd").unwrap_or("").into(),
                    ),
                );
            }
        }
        let service = Self { inner };
        service.start_timers();
        service
    }

    fn every(&self, ms: u64, run: fn(Arc<Inner>) -> BoxFuture<'static, ()>) {
        if ms == 0 {
            return;
        }
        let me = Arc::downgrade(&self.inner);
        let clock = self.inner.options.clock.clone();
        let handle = tokio::spawn(async move {
            loop {
                sleep_ms(&*clock, ms).await;
                let Some(inner) = me.upgrade() else { return };
                if inner.closed() {
                    return;
                }
                run(inner).await;
            }
        });
        self.inner.timers.lock().unwrap().push(handle);
    }

    fn start_timers(&self) {
        let options = &self.inner.options;
        self.every(options.suspended_watch_ms, |inner| {
            Box::pin(async move {
                for entry in inner.suspended.all() {
                    inner.check_suspended(entry).await;
                }
            })
        });
        self.every(options.holder_watch_ms, |inner| {
            Box::pin(async move { inner.watch_holders().await })
        });
        self.every(options.stuck_check_ms, |inner| {
            Box::pin(async move { inner.check_stuck().await })
        });
        if options.idle_stop_minutes.is_some() {
            self.every(options.idle_check_ms, |inner| {
                Box::pin(async move { inner.check_idle().await })
            });
        }
        if !self.inner.recovery.unread.lock().unwrap().is_empty() {
            let me = Arc::downgrade(&self.inner);
            let clock = options.clock.clone();
            let delay = options.carried_queue_delay_ms;
            let handle = tokio::spawn(async move {
                sleep_ms(&*clock, delay).await;
                let Some(inner) = me.upgrade() else { return };
                let panes: Vec<String> = inner
                    .recovery
                    .unread
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect();
                for pane in panes {
                    inner.reattach(&pane);
                }
            });
            self.inner.timers.lock().unwrap().push(handle);
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.inner.options.connection_id
    }

    pub fn state(&self, pane_id: &str) -> Obj {
        self.inner.state(pane_id)
    }

    pub fn lease(&self, pane_id: &str) -> Option<Lease> {
        self.inner.lease(pane_id)
    }

    /// The durable cross-agent work session store for this connection.
    pub fn continuity(&self) -> &crate::continuity::WorkSessionStore {
        &self.inner.continuity
    }

    /// Switches an owned conversation pane to another backend (`claude` <-> `agy`)
    /// using the crash-safe single-writer handoff state machine.
    pub async fn switch_agent(
        &self,
        pane_id: &str,
        target_agent: &str,
        reason: &str,
        fresh_session: bool,
    ) -> Value {
        self.inner
            .switch_agent(pane_id, target_agent, reason, fresh_session)
            .await
    }

    /// Puts another session in a conversation-mode pane (`switchSession`).
    pub async fn switch_session(&self, pane_id: &str, session_id: &str) -> Value {
        let inner = &self.inner;
        let lease = inner.lease(pane_id);
        if !lease
            .as_ref()
            .is_some_and(|lease| lease_str(lease, "phase") == Some("conversation"))
            || inner.handover.running(pane_id)
        {
            return json!({"ok": false, "busy": false, "reason": "conversation mode does not own this pane"});
        }
        if lease_str(lease.as_ref().unwrap(), "session_id") == Some(session_id) {
            return json!({"ok": true});
        }
        if let Some(session) = inner.session(pane_id) {
            if let Some(refusal) = inner.restart_refusal_of(pane_id, &session) {
                return json!({"ok": false, "busy": true, "reason": refusal});
            }
            if session.alive() && !session.asleep() && !session.sleep_process().await {
                return json!({"ok": false, "busy": true, "reason": "it is not idle"});
            }
            inner.sessions.lock().unwrap().remove(pane_id);
            session.dispose(false);
        }
        inner.drop_channel(pane_id);
        inner.clear_lost(pane_id);
        inner.clear_stuck(pane_id);
        let Some(current) = inner.lease(pane_id) else {
            return json!({"ok": false, "busy": false, "reason": "the lease went"});
        };
        let mut next = current;
        next.insert("session_id".into(), json!(session_id));
        next.shift_remove("asleep_at");
        inner.set_lease(next);
        inner.log("conversation session switched", json!({"pane": pane_id}));
        inner.holders.send(pane_id, &hold_reply(session_id));
        inner.report(pane_id, "idle");
        inner.emit_lease(pane_id);
        match inner.start_again(pane_id).await {
            Ok(()) => json!({"ok": true}),
            Err(reason) => json!({"ok": false, "busy": false, "reason": reason}),
        }
    }

    /// Starts the pane's process again with the session's profile now.
    pub async fn restart_process(&self, pane_id: &str) -> Value {
        let inner = &self.inner;
        if !inner.owns(pane_id) || inner.handover.running(pane_id) {
            return fail("Conversation mode does not own this session");
        }
        if let Some(session) = inner.session(pane_id) {
            if let Some(refusal) = inner.restart_refusal_of(pane_id, &session) {
                return fail(restart_refusal(&refusal));
            }
            if session.alive() && !session.asleep() && !session.sleep_process().await {
                return fail("The agent is not idle; try again in a moment");
            }
            inner.sessions.lock().unwrap().remove(pane_id);
            session.dispose(false);
        }
        inner.clear_lost(pane_id);
        inner.clear_stuck(pane_id);
        if let Some(current) = inner.lease(pane_id)
            && current.contains_key("asleep_at")
        {
            let mut next = current;
            next.shift_remove("asleep_at");
            inner.set_lease(next);
        }
        inner.log(
            "conversation process restarts with the session's profile",
            json!({"pane": pane_id}),
        );
        inner.set_model_notice(pane_id, None);
        inner.emit_lease(pane_id);
        match inner.start_again(pane_id).await {
            Ok(()) => json!({"ok": true}),
            Err(reason) => fail(reason),
        }
    }

    pub async fn restart_terminal(&self, pane_id: &str, session_id: Option<&str>) -> Value {
        Value::Object(
            self.inner
                .handover
                .restart_terminal(pane_id, session_id)
                .await
                .unwrap_or_else(refuse),
        )
    }

    pub fn input_refusal(&self, pane_id: &str) -> Option<String> {
        let phase = self.inner.phase(pane_id);
        (self.inner.handover.running(pane_id)
            || matches!(phase.as_deref(), Some("to_conversation" | "to_terminal")))
        .then(|| "The session is being handed over; try again in a moment".into())
    }

    pub fn model(&self, pane_id: &str) -> Option<String> {
        self.inner
            .session(pane_id)
            .and_then(|session| session.model())
    }

    /// The session conversation mode owns in a pane: (session, cwd).
    pub fn owned_session(&self, pane_id: &str) -> Option<(String, String)> {
        let lease = self.inner.lease(pane_id)?;
        (lease_str(&lease, "owner") == Some("conversation")).then(|| {
            (
                lease_str(&lease, "session_id").unwrap_or("").into(),
                lease_str(&lease, "cwd").unwrap_or("").into(),
            )
        })
    }

    pub fn subscribe(&self, socket: SocketId, pane_id: &str) -> Obj {
        self.inner
            .subscribers
            .lock()
            .unwrap()
            .entry(pane_id.to_owned())
            .or_default()
            .insert(socket);
        let streamed = self
            .inner
            .session(pane_id)
            .map(|session| session.streamed())
            .unwrap_or_default();
        let mut state = self.inner.state(pane_id);
        if !streamed.is_empty() {
            state.insert(
                "streamed".into(),
                Value::Array(streamed.into_iter().map(Value::Object).collect()),
            );
        }
        state
    }

    pub fn unsubscribe(&self, socket: SocketId, pane_id: &str) {
        let mut subscribers = self.inner.subscribers.lock().unwrap();
        if let Some(watchers) = subscribers.get_mut(pane_id) {
            watchers.shift_remove(&socket);
            if watchers.is_empty() {
                subscribers.remove(pane_id);
            }
        }
    }

    pub fn cleanup_ws(&self, socket: SocketId) {
        let mut subscribers = self.inner.subscribers.lock().unwrap();
        subscribers.retain(|_, watchers| {
            watchers.shift_remove(&socket);
            !watchers.is_empty()
        });
    }

    /// A message typed in the chat: Ok `{status, id}`.
    pub async fn send(
        &self,
        pane_id: &str,
        text: &str,
        images: Vec<String>,
        uuid: Option<String>,
    ) -> Result<Value, String> {
        let inner = &self.inner;
        if let Some(queued) = inner.queue_during_switch(pane_id, text, &images, uuid.clone()) {
            return Ok(queued);
        }
        let session = inner.session_for(pane_id)?;
        let command = if images.is_empty() {
            crate::service::auxiliary::parse_model_command(text)
        } else {
            None
        };
        if let Some(model) = command
            && inner.driver_of(pane_id).protocol.models().is_some()
        {
            self.set_model(pane_id, &model).await;
            return Ok(json!({"status": "sent", "id": uuid.unwrap_or_else(random_uuid)}));
        }
        if images.is_empty()
            && let Some(notice) = session.command(text, inner.command_runner(pane_id)).await
        {
            inner.set_model_notice(
                pane_id,
                Some(obj_of(json!({
                    "at": inner.iso_now(),
                    "ok": notice.ok,
                    "requested": js::trim(text),
                    "model": session.model(),
                    "text": notice.text,
                }))),
            );
            return Ok(json!({"status": "sent", "id": uuid.unwrap_or_else(random_uuid)}));
        }
        inner.clear_interrupted(pane_id);
        inner.set_model_notice(pane_id, None);
        // Its id now: its images are kept for its record under it.
        let id = uuid.unwrap_or_else(random_uuid);
        inner.remember_images(&id, &images);
        match session.send(text, images.clone(), Some(id.clone())).await {
            Ok((status, id)) => Ok(json!({"status": status, "id": id})),
            Err(error) => {
                if error != holders::HOLDER_MISSING || !inner.recover_later(pane_id).await {
                    return Err(error);
                }
                if inner.owns(pane_id) {
                    let session = inner.session_for(pane_id)?;
                    let (status, id) = session.send(text, images, Some(id)).await?;
                    return Ok(json!({"status": status, "id": id}));
                }
                let item = obj_of(json!({
                    "id": id,
                    "text": js::trim(text),
                    "images": images,
                    "queued_at": inner.iso_now(),
                }));
                inner.park(pane_id, item);
                Ok(json!({"status": "queued", "id": id}))
            }
        }
    }

    /// Text for the agent from Roamgate itself (`prompt`): false when the
    /// terminal owns the session.
    pub async fn prompt(&self, pane_id: &str, text: &str, peer: bool) -> Result<bool, String> {
        let inner = &self.inner;
        let Some(lease) = inner.lease(pane_id) else {
            return Ok(false);
        };
        if lease_str(&lease, "phase") == Some("terminal") {
            return Ok(false);
        }
        if peer {
            inner.note_peer(pane_id);
        }
        let session = inner.session_for(pane_id)?;
        inner.clear_interrupted(pane_id);
        inner.set_model_notice(pane_id, None);
        session.send(text, Vec::new(), None).await?;
        Ok(true)
    }

    pub async fn voice(
        &self,
        pane_id: &str,
        text: &str,
        stop: bool,
        uuid: Option<String>,
    ) -> Result<Value, String> {
        let inner = &self.inner;
        let session = inner.session_for(pane_id)?;
        if !stop && !is_spoken_stop(text) {
            inner.clear_interrupted(pane_id);
            inner.set_model_notice(pane_id, None);
        }
        let (action, id) = session.voice(text, stop, uuid).await?;
        let mut result = json!({"action": action});
        if let Some(id) = id {
            result["id"] = json!(id);
        }
        Ok(result)
    }

    pub fn dismiss_interrupted(&self, pane_id: &str) {
        self.inner.clear_interrupted(pane_id);
    }

    pub fn dismiss_model_notice(&self, pane_id: &str) {
        self.inner.set_model_notice(pane_id, None);
    }

    /// /model: switches the pane's session to another model.
    pub async fn set_model(&self, pane_id: &str, value: &str) -> Value {
        let inner = &self.inner;
        let requested = js::trim(value).to_owned();
        let lease = inner.lease(pane_id);
        if inner.closed()
            || !lease
                .as_ref()
                .is_some_and(|lease| lease_str(lease, "phase") == Some("conversation"))
        {
            return fail(not_owned_reason(&lease));
        }
        let at = inner.iso_now();
        let refused = |reason: String| {
            inner.set_model_notice(
                pane_id,
                Some(obj_of(json!({
                    "at": at,
                    "ok": false,
                    "requested": requested,
                    "model": null,
                    "text": auxiliary::model_refusal_text(&requested, &reason),
                }))),
            );
            inner.log(
                "conversation model switch refused",
                json!({"pane": pane_id, "reason": reason}),
            );
            fail(reason)
        };
        if !auxiliary::is_model_name(&requested) {
            return refused("that is not a model name".into());
        }
        let session = match inner.session_for(pane_id) {
            Ok(session) => session,
            Err(error) => return refused(error),
        };
        let (model, next_turn) = match session.set_model(&requested).await {
            Ok(result) => result,
            Err(reason) => return refused(reason),
        };
        if let Some(models) = &inner.options.models {
            (models.choose)(&session.session_id(), &requested, model.as_deref());
        }
        if let Some(current) = inner.lease(pane_id) {
            let args = crate::shared::lease_terminal_args(&current);
            if args
                .iter()
                .any(|arg| arg == "--model" || arg.starts_with("--model="))
            {
                let mut next = current;
                next.insert(
                    "terminal_args".into(),
                    json!(crate::shared::without_model(&args)),
                );
                inner.set_lease(next);
            }
        }
        inner.set_model_notice(
            pane_id,
            Some(obj_of(json!({
                "at": at,
                "ok": true,
                "requested": requested,
                "model": model,
                "text": auxiliary::model_switch_text(&requested, model.as_deref(), next_turn),
            }))),
        );
        let mut fields = json!({"pane": pane_id, "model": requested});
        if let Some(model) = &model {
            fields["resolved"] = json!(model);
        }
        inner.log("conversation model switched", fields);
        json!({"ok": true, "model": model})
    }

    /// What /model offers (`listModels`).
    pub async fn models(&self, pane_id: &str) -> Result<Value, String> {
        let inner = &self.inner;
        let lease = inner.lease(pane_id);
        let Some(lease) = lease
            .clone()
            .filter(|lease| lease_str(lease, "phase") == Some("conversation") && !inner.closed())
        else {
            return Err(not_owned_reason(&lease));
        };
        let protocol = inner.driver_of(pane_id).protocol;
        if protocol.models().is_none() {
            return Err(format!("{} cannot switch models", protocol.display_name()));
        }
        let session = inner.session(pane_id);
        let session_id = lease_str(&lease, "session_id").unwrap_or("").to_owned();
        let known = session.as_ref().and_then(|session| session.model());
        let agent = match &session {
            Some(session) => session.list_models().await,
            None => None,
        };
        let offered = match &inner.options.models {
            Some(models) => Some((models.offered)(session_id.clone()).await),
            None => None,
        };
        let last = match (
            &known,
            inner
                .options
                .models
                .as_ref()
                .and_then(|m| m.last_answered.clone()),
        ) {
            (None, Some(last)) => last(pane_id.to_owned()).await,
            _ => None,
        };
        let offered_models = offered
            .as_ref()
            .map(|(models, _)| models.clone())
            .unwrap_or_default();
        let models = auxiliary::merge_models(agent.as_deref(), &offered_models);
        let agent_len = agent.as_ref().map_or(0, Vec::len);
        let chosen = session
            .as_ref()
            .and_then(|session| session.chosen_model())
            .or_else(|| {
                inner
                    .options
                    .models
                    .as_ref()
                    .and_then(|models| (models.chosen)(&session_id))
            });
        let mut result = json!({
            "models": models,
            "current": known.or(last),
            "chosen": chosen,
            "source": if agent_len > 0 {
                if models.len() > agent_len { "both" } else { "agent" }
            } else {
                "profile"
            },
        });
        if let Some((_, Some(error))) = offered {
            result["error"] = json!(error);
        }
        Ok(result)
    }

    fn mcp_refusal(&self, pane_id: &str) -> Option<String> {
        let inner = &self.inner;
        let lease = inner.lease(pane_id);
        if inner.closed()
            || !lease
                .as_ref()
                .is_some_and(|lease| lease_str(lease, "phase") == Some("conversation"))
        {
            return Some(not_owned_reason(&lease));
        }
        let protocol = inner.driver_of(pane_id).protocol;
        protocol
            .mcp()
            .is_none()
            .then(|| format!("{} has no MCP servers", protocol.display_name()))
    }

    pub async fn mcp(&self, pane_id: &str) -> Result<Value, String> {
        if let Some(refusal) = self.mcp_refusal(pane_id) {
            return Err(refusal);
        }
        let servers = self.inner.session_for(pane_id)?.mcp_status().await?;
        Ok(json!({"servers": servers}))
    }

    pub async fn mcp_action(&self, pane_id: &str, request: Value) -> Value {
        if let Some(refusal) = self.mcp_refusal(pane_id) {
            return fail(refusal);
        }
        let session = match self.inner.session_for(pane_id) {
            Ok(session) => session,
            Err(error) => return fail(error),
        };
        let result = session.mcp_action(request.clone()).await;
        let mut fields = json!({
            "pane": pane_id,
            "action": request.get("action"),
            "server": request.get("server"),
            "ok": result.get("ok"),
        });
        if result.get("ok") != Some(&Value::Bool(true)) {
            fields["reason"] = result.get("reason").cloned().unwrap_or(Value::Null);
        }
        self.inner.log("conversation mcp action", fields);
        result
    }

    pub async fn background(&self, pane_id: &str, tool_use_id: Option<&str>) -> Value {
        let inner = &self.inner;
        let session = inner.session(pane_id);
        let Some(session) = session.filter(|_| !inner.closed() && inner.owns(pane_id)) else {
            return fail("Nothing runs in the foreground");
        };
        let result = session.background(tool_use_id).await;
        let mut fields = json!({"pane": pane_id});
        if let Some(id) = tool_use_id {
            fields["tool_use"] = json!(id);
        }
        let value = match &result {
            Ok(backgrounded) => {
                fields["ok"] = json!(true);
                fields["backgrounded"] = json!(backgrounded);
                json!({"ok": true, "backgrounded": backgrounded})
            }
            Err(reason) => {
                fields["ok"] = json!(false);
                fields["reason"] = json!(reason);
                fail(reason.clone())
            }
        };
        inner.log("conversation background", fields);
        value
    }

    pub async fn stop_task(&self, pane_id: &str, task_id: &str) -> Value {
        let inner = &self.inner;
        let session = inner.session(pane_id);
        let Some(session) = session.filter(|_| !inner.closed() && inner.owns(pane_id)) else {
            return fail("Only a running conversation can stop its tasks");
        };
        let result = session.stop_task(task_id).await;
        let mut fields = json!({"pane": pane_id, "task": task_id, "ok": result.is_ok()});
        if let Err(reason) = &result {
            fields["reason"] = json!(reason);
        }
        inner.log("conversation task stop", fields);
        match result {
            Ok(()) => json!({"ok": true}),
            Err(reason) => fail(reason),
        }
    }

    pub async fn recover(&self, pane_id: &str) -> Value {
        match self.inner.recover(pane_id).await {
            Ok(()) => json!({"ok": true}),
            Err(reason) => fail(reason),
        }
    }

    /// The user's answer to the API key question.
    pub fn answer_api_key(&self, pane_id: &str, use_api_key: bool) -> Value {
        let answer = if use_api_key {
            crate::driver::ApiKeyAnswer::Approve
        } else {
            crate::driver::ApiKeyAnswer::Reject
        };
        if self.inner.settle_api_key(pane_id, Some(answer), None) {
            json!({"ok": true})
        } else {
            fail("No question about the API key waits here")
        }
    }

    pub fn shell(&self, pane_id: &str, command: &str, id: Option<String>) -> Result<Value, String> {
        self.inner.run_shell(pane_id, command, id)
    }

    pub fn stop_shell(&self, pane_id: &str, id: &str) -> bool {
        self.inner.stop_shell(pane_id, id)
    }

    /// Rewinds the session conversation mode owns (`service-rewind.ts`).
    pub async fn rewind(
        &self,
        pane_id: &str,
        uuid: &str,
        last_seen: Option<String>,
        mode: &str,
        interrupt: bool,
    ) -> Result<Value, String> {
        let inner = &self.inner;
        let lease = inner.lease(pane_id);
        if inner.closed()
            || !lease
                .as_ref()
                .is_some_and(|lease| lease_str(lease, "phase") == Some("conversation"))
        {
            return Ok(fail(not_owned_reason(&lease)));
        }
        let result = inner
            .session_for(pane_id)?
            .rewind(uuid, last_seen.as_deref(), mode, interrupt)
            .await?;
        if result.get("ok") == Some(&Value::Bool(true)) && mode != "code" {
            inner.clear_interrupted(pane_id);
        }
        Ok(result)
    }

    pub async fn rewind_check(&self, pane_id: &str, uuid: &str) -> Value {
        let inner = &self.inner;
        if let Some(session) = inner.session(pane_id) {
            return session.rewind_check(uuid).await;
        }
        let unknown = json!({"code": "unknown"});
        let Some(read) = inner
            .options
            .read_transcript
            .clone()
            .filter(|_| !inner.closed())
        else {
            return unknown;
        };
        let driver = inner.driver_of(pane_id).protocol;
        let Some(rewind) = driver.rewind() else {
            return unknown;
        };
        match read(pane_id.to_owned()).await {
            Ok(transcript) => rewind.check_transcript(transcript.as_ref(), uuid),
            Err(_) => unknown,
        }
    }

    pub async fn interrupt(&self, pane_id: &str) -> Result<bool, String> {
        self.inner.interrupt(pane_id).await
    }

    pub fn edit_queued(&self, pane_id: &str, id: &str, text: &str) -> bool {
        match self.inner.session(pane_id) {
            Some(session) => session.edit_queued(id, text),
            None => self.inner.edit_parked(pane_id, id, text),
        }
    }

    pub fn remove_queued(&self, pane_id: &str, id: &str) -> Value {
        match self.inner.session(pane_id) {
            Some(session) => session.remove_queued(id).map(Value::Object),
            None => self.inner.remove_parked(pane_id, id).map(Value::Object),
        }
        .unwrap_or(Value::Null)
    }

    /// The user's own switch, asked by a browser (`handover`).
    #[allow(clippy::too_many_arguments)]
    pub async fn handover(
        &self,
        pane_id: &str,
        to: &str,
        interrupt: bool,
        auto: bool,
        session_id: Option<&str>,
        quit_writer: Option<&str>,
        suspend: Option<Option<String>>,
    ) -> Obj {
        let inner = &self.inner;
        if inner.closed() {
            return refuse("The connection is closing");
        }
        if auto {
            inner.log(
                "automatic handover refused",
                json!({"pane": pane_id, "to": to}),
            );
            return refuse("Only the user's switch changes the mode; reload the page");
        }
        if to == "conversation" {
            inner
                .to_conversation(pane_id, session_id, quit_writer)
                .await
        } else {
            inner.to_terminal(pane_id, interrupt, None, suspend).await
        }
    }

    /// The user's fg from the page (`foreground`).
    pub async fn foreground(&self, pane_id: &str) -> Value {
        let inner = &self.inner;
        let Some(entry) = inner.suspended.get(pane_id) else {
            return fail("No conversation is stopped in this pane");
        };
        let info = match inner.options.herdr.process_info(pane_id).await {
            Ok(info) => info,
            Err(error) => return fail(format!("Herdr did not list the pane's processes: {error}")),
        };
        if info.shell_pid.is_none() || info.foreground_process_group_id != info.shell_pid {
            return fail(
                "Something runs in the pane's terminal; once its shell is back at the prompt, type fg there",
            );
        }
        let shell = info
            .foreground_processes
            .iter()
            .find(|process| Some(process.pid as f64) == info.shell_pid);
        let command = match foreground_command(
            sv(entry.get("session_id")),
            entry
                .get("holder_pid")
                .and_then(Value::as_u64)
                .map(|pid| pid as u32),
            entry.get("job").and_then(Value::as_str),
            &shell_name(shell),
        ) {
            Ok(command) => command,
            Err(error) => return fail(format!("Could not type fg into the pane: {error}")),
        };
        if let Err(error) = inner.options.herdr.send_text(pane_id, &command).await {
            return fail(format!("Could not type fg into the pane: {error}"));
        }
        inner.log(
            "fg typed for a stopped conversation",
            json!({"pane": pane_id}),
        );
        json!({"ok": true})
    }

    pub fn suspended_panes(&self) -> Vec<Obj> {
        self.inner.suspended.all()
    }

    pub fn cancel_handover(&self, pane_id: &str) -> Value {
        let cleared = self.inner.handover.cancel_exit(pane_id);
        if cleared {
            self.inner.log(
                "switch cancelled; exit no longer waited for",
                json!({"pane": pane_id}),
            );
        }
        json!({"ok": true, "cleared": cleared})
    }

    /// A claude the user just started in the pane (`autoStart`).
    pub fn auto_start(&self, pane_id: &str, session_id: &str) -> Value {
        let inner = &self.inner;
        if inner.closed() {
            return fail("The connection is closing");
        }
        if inner.lease(pane_id).is_some() {
            return fail("Conversation mode already has this pane");
        }
        if let Some(was) = inner.released.lock().unwrap().get(pane_id)
            && inner.now() - was.at < HANDED_BACK_MS
        {
            return fail("This pane's session just went back to the terminal");
        }
        inner.log(
            "claude started in the pane; conversation mode will take it",
            json!({"pane": pane_id, "session": session_id}),
        );
        let run = inner.auto_starter.start(pane_id, session_id);
        tokio::spawn(run);
        json!({"ok": true})
    }

    /// roamgate-hold's requests, from the review socket.
    pub async fn holder_hold(&self, input: HolderSideInput) -> Obj {
        self.inner.holder_hold(input).await
    }

    pub fn holder_output(
        &self,
        pane_id: &str,
        holder_id: &str,
        offset: i64,
        end: i64,
        data: &str,
    ) -> Value {
        self.inner
            .holder_output(pane_id, holder_id, offset, end, data)
    }

    pub async fn holder_fg(&self, input: HolderSideInput, spec: SuspendedSpec) -> Obj {
        self.inner.holder_fg(input, spec).await
    }

    pub async fn holder_handback(&self, pane_id: &str) -> Obj {
        self.inner.holder_handback(pane_id).await
    }

    pub fn pane_closed(&self, pane_id: &str) {
        self.inner.pane_closed(pane_id);
    }

    /// Drops the leases whose pane is gone.
    pub async fn sweep(&self) {
        let inner = &self.inner;
        for lease in inner.options.leases.all() {
            let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
            let exists = inner.options.herdr.pane_exists(&pane).await.unwrap_or(true);
            if !exists {
                inner.pane_closed(&pane);
            } else if lease_str(&lease, "phase") == Some("conversation")
                && !inner.holders.connected(&pane, None, None)
            {
                inner.recover_later(&pane).await;
            }
        }
    }

    pub async fn check_idle(&self) {
        self.inner.check_idle().await;
    }

    pub fn handing_over(&self) -> bool {
        self.inner.options.leases.all().iter().any(|lease| {
            let pane = lease_str(lease, "pane_id").unwrap_or("");
            self.inner.handover.running(pane)
                || matches!(
                    lease_str(lease, "phase"),
                    Some("to_conversation" | "to_terminal")
                )
        })
    }

    /// The panes conversation mode holds (`ownedPanes`).
    pub fn owned_panes(&self) -> Vec<Obj> {
        let inner = &self.inner;
        inner
            .options
            .leases
            .all()
            .iter()
            .map(|lease| {
                let pane = lease_str(lease, "pane_id").unwrap_or("");
                let status = inner
                    .session(pane)
                    .map(|session| sv(session.state().get("status")).to_owned());
                let phase = lease_str(lease, "phase").unwrap_or("");
                let agent_status = if phase != "conversation"
                    || matches!(status.as_deref(), Some("working" | "starting"))
                {
                    "working"
                } else if status.as_deref() == Some("blocked") {
                    "blocked"
                } else {
                    "idle"
                };
                obj_of(json!({
                    "pane_id": pane,
                    "session_id": lease_str(lease, "session_id"),
                    "cwd": lease_str(lease, "cwd"),
                    "phase": phase,
                    "agent": inner.options.drivers.of(lease_str(lease, "agent")).terminal.herdr_agent(),
                    "agent_status": agent_status,
                }))
            })
            .collect()
    }

    /// Ends this runtime: processes run on in the holders; leases stay,
    /// with what was queued, for the runtime after this one.
    pub fn dispose(&self) {
        let inner = &self.inner;
        for timer in inner.timers.lock().unwrap().drain(..) {
            timer.abort();
        }
        inner.dispose_aux();
        inner.auto_starter.dispose();
        if inner.closed() {
            return;
        }
        let sessions: Vec<(String, ConversationSession)> = inner
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(pane, session)| (pane.clone(), session.clone()))
            .collect();
        for (pane, session) in &sessions {
            let queued = session.take_queue();
            if let Some(lease) = inner.lease(pane)
                && !queued.is_empty()
            {
                let mut next = lease.clone();
                let mut queue = lease
                    .get("queue")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                queue.extend(queued.into_iter().map(Value::Object));
                next.insert("queue".into(), Value::Array(queue));
                inner.set_lease(next);
            }
        }
        inner.save_all_holders();
        inner.disposed.store(true, Ordering::SeqCst);
        inner.dispose_shells();
        for (_, session) in sessions {
            session.dispose(true);
        }
        inner.sessions.lock().unwrap().clear();
        inner.drop_all_channels();
        inner.subscribers.lock().unwrap().clear();
        let leases = inner.options.leases.clone();
        inner.holders.release_all(|pane| {
            hold_reply(
                leases
                    .get(pane)
                    .as_ref()
                    .and_then(|lease| lease_str(lease, "session_id"))
                    .unwrap_or(""),
            )
        });
    }
}

/// The panes whose lease names one of these (for tests and the adapter).
pub fn lease_panes(leases: &[Lease]) -> HashSet<String> {
    leases
        .iter()
        .filter_map(|lease| lease_str(lease, "pane_id").map(str::to_owned))
        .collect()
}
