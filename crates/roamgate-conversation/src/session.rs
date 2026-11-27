//! One conversation-owned session (`session.ts`): its long-lived headless
//! agent (started on demand through the holder, living until handback,
//! stop or the pane closes), the turn state its stream gives, Roamgate's
//! queue of messages typed while it works, and the bridge from the agent's
//! permission requests and questions to the browser's prompt cards.
//!
//! The service (fork E2: `service*.ts`, `rpc.ts`) makes one
//! [`ConversationSession`] per owned pane with [`SessionOptions`] and
//! drives it through:
//!
//! - starting and reading: [`ConversationSession::warm`] (start ahead of a
//!   turn), [`ConversationSession::attach`] (take the process a holder
//!   already runs, reading again what an earlier runtime handled), and
//!   [`ConversationSession::resume_state`] (what to save on the holder's
//!   state so the next runtime reads on from there);
//! - turns: [`ConversationSession::send`] (written now, or queued),
//!   [`ConversationSession::voice`] (the barge-in mix: queue, steer, or
//!   interrupt then send), [`ConversationSession::interrupt`],
//!   [`ConversationSession::wait_for_result`], the queue's edits;
//! - prompts: asked through [`SessionOptions::ask`], answered by its
//!   future (None: denied);
//! - the agent's own requests: [`ConversationSession::rewind`] and
//!   [`ConversationSession::rewind_check`], models, MCP servers, background
//!   tasks;
//! - ending: [`ConversationSession::sleep`] (idle stop),
//!   [`ConversationSession::stop`] (hand-back), and
//!   [`ConversationSession::dispose`] (`detach`: the process runs on in the
//!   holder for the next runtime).
//!
//! Events for the browsers (`AgentChatEvent`, Bun's objects with their keys
//! in Bun's order) go to [`SessionOptions::emit`] in the order Bun sends
//! them; deltas are coalesced about once a frame ([`stream`]).
//!
//! The state is one mutex, never held across an await nor while a callback
//! runs: what a change tells (events, callbacks, tasks to start) is
//! collected while it is held and run in order right after, as Bun's
//! synchronous handlers run between two awaits.

pub mod resume;
pub mod stream;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use roamgate_agents::js;
use roamgate_base::paths::random_uuid;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::driver::{
    BoxFuture, CommandContext, CommandNotice, CommandOutput, ControlAnswer, DriverCodec,
    DriverEvent, DriverImage, DriverMessage, HeadlessProcess, ModelContext, Object, ProtocolDriver,
    RewindContext, RewindInput, Transcript,
};
use crate::headless::{HeadlessSpawnOptions, SpawnHeadless};
use crate::images::ConversationImage;
use crate::shared::{LogFn, Obj};
use crate::time::SharedClock;

use self::resume::{kept_resume_state, resume_state_of};
use self::stream::ReplyStream;

pub type Proc = Arc<dyn HeadlessProcess>;
type Fx = Vec<Box<dyn FnOnce() + Send>>;
type Started = Result<Option<Proc>, String>;
type Starting = Shared<BoxFuture<'static, Started>>;
type Waiter = Shared<BoxFuture<'static, ()>>;

/// A permission or a question for the user, answered in the browser.
pub struct ConversationPrompt {
    pub tool: String,
    pub input: Value,
    pub can_always: bool,
    /// `AgentQuestion[]`.
    pub questions: Option<Vec<Value>>,
    pub timeout_ms: u64,
    /// Cancelled when the agent no longer asks (an interrupt, a cancel).
    pub signal: CancellationToken,
}

/// What goes before the next message's own text: the `!` lines run since
/// the last one, in the agent's bash-mode format; `commit` once written.
pub struct Prelude {
    pub texts: Vec<String>,
    pub commit: Box<dyn FnOnce() + Send>,
}

/// Asks the user: the browser's `AgentPromptAnswer`, None when nobody
/// answered (the tool is denied).
pub type AskFn = Arc<
    dyn Fn(ConversationPrompt) -> BoxFuture<'static, Result<Option<Value>, String>> + Send + Sync,
>;
pub type ReadImageFn =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<ConversationImage, String>> + Send + Sync>;
pub type ReadTranscriptFn =
    Arc<dyn Fn() -> BoxFuture<'static, Result<Option<Transcript>, String>> + Send + Sync>;

/// /clear moved the conversation: (new, previous).
pub type SessionIdFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// What Herdr is told of the agent's state.
pub type StatusFn = Arc<dyn Fn(&str) + Send + Sync>;
/// The process started (pid, resumed session id) or exited.
pub type ProcessFn = Arc<dyn Fn(Option<u32>, Option<&str>) + Send + Sync>;

pub struct SessionOptions {
    pub pane_id: String,
    pub session_id: String,
    pub cwd: String,
    pub spawn: Arc<dyn SpawnHeadless>,
    /// An `AgentChatEvent` for the browsers.
    pub emit: Arc<dyn Fn(Obj) + Send + Sync>,
    pub ask: AskFn,
    pub read_image: ReadImageFn,
    pub prelude: Option<Arc<dyn Fn() -> Option<Prelude> + Send + Sync>>,
    /// /clear moved the conversation to a new session id (new, previous).
    pub on_session_id: Option<SessionIdFn>,
    pub on_status: Option<StatusFn>,
    /// The process started (its pid, and the session id its argv resumes,
    /// which a probe looks for) or exited (None, None).
    pub on_process: Option<ProcessFn>,
    /// A turn was written to the process (true), or ended (false).
    pub on_turn: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    /// The process said something new (not a line read again).
    pub on_output: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Stopped for being idle (true), or a new process started since.
    pub on_asleep: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    /// Another session's message reached it.
    pub on_peer: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Stopped for being idle by a runtime before this one.
    pub asleep: bool,
    pub clock: SharedClock,
    pub log: Option<LogFn>,
    /// Messages left queued by an earlier process (`AgentChatQueued`).
    pub queue: Vec<Obj>,
    pub coalesce_ms: u64,
    pub permission_timeout_ms: u64,
    pub question_timeout_ms: u64,
    pub interrupt_wait_ms: u64,
    pub stop_wait_ms: u64,
    pub rewind_wait_ms: u64,
    pub mcp_wait_ms: u64,
    pub read_transcript: Option<ReadTranscriptFn>,
    pub driver: Arc<dyn ProtocolDriver>,
}

impl SessionOptions {
    /// The options with Bun's defaults for what is not given.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pane_id: &str,
        session_id: &str,
        cwd: &str,
        spawn: Arc<dyn SpawnHeadless>,
        emit: Arc<dyn Fn(Obj) + Send + Sync>,
        ask: AskFn,
        read_image: ReadImageFn,
        clock: SharedClock,
        driver: Arc<dyn ProtocolDriver>,
    ) -> Self {
        Self {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            cwd: cwd.into(),
            spawn,
            emit,
            ask,
            read_image,
            prelude: None,
            on_session_id: None,
            on_status: None,
            on_process: None,
            on_turn: None,
            on_output: None,
            on_asleep: None,
            on_peer: None,
            asleep: false,
            clock,
            log: None,
            queue: Vec::new(),
            coalesce_ms: 16,
            permission_timeout_ms: 15 * 60_000,
            question_timeout_ms: 30 * 60_000,
            interrupt_wait_ms: 3000,
            stop_wait_ms: 10_000,
            rewind_wait_ms: 30_000,
            mcp_wait_ms: 45_000,
            read_transcript: None,
            driver,
        }
    }
}

/// What [`ConversationSession::resume_state`] says.
#[derive(Clone, Debug, PartialEq)]
pub enum ResumeState {
    /// Not known yet (attaching, replaying): an earlier save still holds.
    Unknown,
    /// No process is read.
    None,
    /// Where its lines were handled to, and the state they left.
    Saved {
        position: crate::driver::HolderPosition,
        state: Obj,
    },
}

impl ResumeState {
    /// Bun's value: `{child, epoch_offset, offset, state}`, null, or
    /// None for undefined.
    pub fn to_value(&self) -> Option<Value> {
        match self {
            ResumeState::Unknown => None,
            ResumeState::None => Some(Value::Null),
            ResumeState::Saved { position, state } => Some(json!({
                "child": position.child,
                "epoch_offset": position.epoch_offset,
                "offset": position.offset,
                "state": state,
            })),
        }
    }
}

/// What a turn's state says to the stuck and idle watches.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TurnActivity {
    /// A turn runs, with nothing asked of the user.
    pub running: bool,
    /// Since when nothing came from it (epoch ms).
    pub since: i64,
    pub tools: bool,
}

/// A user line carrying another Claude session's or a teammate's message.
fn peer_line() -> &'static Regex {
    static PEER: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    PEER.get_or_init(|| {
        Regex::new(
            r#"^\{"type":"user".*(?:<cross-session-message(?-u:\b)|<teammate-message(?-u:\b)|"origin":\{"kind":"peer")"#,
        )
        .expect("the peer line pattern")
    })
}

/// A spoken "stop": always an interrupt, never a message
/// (`isSpokenStop`).
pub fn is_spoken_stop(text: &str) -> bool {
    static STOP: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    STOP.get_or_init(|| {
        Regex::new(r"(?i)^[\t\n\x0B\x0C\r \u{a0}\u{feff}\p{Zs}\u{2028}\u{2029}]*(?:stop|stop it|stop now|arr[eê]te|halt)[\t\n\x0B\x0C\r \u{a0}\u{feff}\p{Zs}\u{2028}\u{2029}]*[.!]*[\t\n\x0B\x0C\r \u{a0}\u{feff}\p{Zs}\u{2028}\u{2029}]*$")
            .expect("the stop words")
    })
    .is_match(text)
}

fn same(a: &Proc, b: &Proc) -> bool {
    std::ptr::eq(Arc::as_ptr(a) as *const (), Arc::as_ptr(b) as *const ())
}

fn s(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn obj(value: Value) -> Obj {
    match value {
        Value::Object(object) => object,
        _ => Obj::new(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)`, "undefined" when absent.
fn text_of(value: Option<&Value>) -> String {
    value.map(js::to_text).unwrap_or_else(|| "undefined".into())
}

fn refuse(reason: impl Into<String>) -> Value {
    json!({"ok": false, "reason": reason.into()})
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LastStatus {
    status: &'static str,
    tools: bool,
}

struct St {
    session_id: String,
    last_activity: i64,
    asleep: bool,
    waking: bool,
    proc: Option<Proc>,
    ending: bool,
    starting: Option<(u64, Starting)>,
    spawn_abort: Option<(u64, CancellationToken)>,
    starts: u64,
    exited: Option<Waiter>,
    disposed: bool,
    stopping: bool,
    turn: bool,
    compacting: bool,
    delivering: i64,
    queued_on_start: bool,
    interrupting: bool,
    activity: Option<String>,
    next_prompt: Option<Obj>,
    last_block: Option<String>,
    tools: IndexSet<String>,
    tasks: IndexSet<String>,
    prompts: IndexMap<String, (u64, CancellationToken)>,
    prompt_ids: u64,
    asking: IndexMap<String, DriverEvent>,
    interrupts: IndexMap<String, oneshot::Sender<()>>,
    controls: IndexMap<String, oneshot::Sender<ControlAnswer>>,
    result_waiters: Vec<(u64, oneshot::Sender<()>)>,
    waiter_ids: u64,
    queue: Vec<Obj>,
    taken: Vec<String>,
    respawned_for_queue: bool,
    last_status: Option<(LastStatus, String, Option<String>)>,
    codec: Box<dyn DriverCodec>,
    muted: bool,
    attaching: bool,
    reported: Option<&'static str>,
    deferred: IndexMap<String, DriverEvent>,
    catching: bool,
    caught_up: Waiter,
    caught_up_tx: Option<(u64, oneshot::Sender<()>)>,
    reads: u64,
    recent: IndexMap<String, (String, Vec<String>)>,
    turn_uuid: Option<String>,
    model: Option<String>,
    chosen_model: Option<String>,
    context_usage: Option<(u64, u64)>,
    rewinding: bool,
    reply: ReplyStream,
}

struct Inner {
    o: SessionOptions,
    agent_name: String,
    st: Mutex<St>,
    /// What the changes tell, queued in the order the changes were made
    /// (under `st`), run by one caller at a time: two tasks' changes never
    /// tell their effects out of order.
    effects: Mutex<std::collections::VecDeque<Box<dyn FnOnce() + Send>>>,
    draining: std::sync::atomic::AtomicBool,
}

/// One conversation-owned session; cheap to clone (one actor).
#[derive(Clone)]
pub struct ConversationSession(Arc<Inner>);

fn ready_waiter() -> Waiter {
    async {}.boxed().shared()
}

impl ConversationSession {
    pub fn new(options: SessionOptions) -> Self {
        let codec = options.driver.create_codec();
        let queue: Vec<Obj> = options.queue.clone();
        let taken = queue
            .iter()
            .map(|item| s(item.get("id")).to_owned())
            .collect();
        let st = St {
            session_id: options.session_id.clone(),
            last_activity: options.clock.now(),
            asleep: options.asleep,
            waking: false,
            proc: None,
            ending: false,
            starting: None,
            spawn_abort: None,
            starts: 0,
            exited: None,
            disposed: false,
            stopping: false,
            turn: false,
            compacting: false,
            delivering: 0,
            queued_on_start: false,
            interrupting: false,
            activity: None,
            next_prompt: None,
            last_block: None,
            tools: IndexSet::new(),
            tasks: IndexSet::new(),
            prompts: IndexMap::new(),
            prompt_ids: 0,
            asking: IndexMap::new(),
            interrupts: IndexMap::new(),
            controls: IndexMap::new(),
            result_waiters: Vec::new(),
            waiter_ids: 0,
            queue,
            taken,
            respawned_for_queue: false,
            last_status: None,
            codec,
            muted: false,
            attaching: false,
            reported: None,
            deferred: IndexMap::new(),
            catching: false,
            caught_up: ready_waiter(),
            caught_up_tx: None,
            reads: 0,
            recent: IndexMap::new(),
            turn_uuid: None,
            model: None,
            chosen_model: None,
            context_usage: None,
            rewinding: false,
            reply: ReplyStream::new(),
        };
        let agent_name = options.driver.display_name().to_owned();
        Self(Arc::new(Inner {
            o: options,
            agent_name,
            st: Mutex::new(st),
            effects: Mutex::new(std::collections::VecDeque::new()),
            draining: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    fn o(&self) -> &SessionOptions {
        &self.0.o
    }

    /// Runs `f` on the state, then what it told, in order.
    fn with<R>(&self, f: impl FnOnce(&mut St, &mut Fx) -> R) -> R {
        let mut fx: Fx = Vec::new();
        let result = {
            let mut st = self.0.st.lock().unwrap_or_else(|e| e.into_inner());
            let result = f(&mut st, &mut fx);
            self.0
                .effects
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(fx);
            result
        };
        self.drain_effects();
        result
    }

    /// Runs the queued effects in order; another caller already running
    /// them runs these too (a callback's own change queues behind).
    fn drain_effects(&self) {
        use std::sync::atomic::Ordering;
        loop {
            if self.0.draining.swap(true, Ordering::SeqCst) {
                return;
            }
            loop {
                let next = self
                    .0
                    .effects
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pop_front();
                match next {
                    Some(effect) => effect(),
                    None => break,
                }
            }
            self.0.draining.store(false, Ordering::SeqCst);
            if self
                .0
                .effects
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
            {
                return;
            }
        }
    }

    fn log(&self, fx: &mut Fx, message: &str, fields: Obj) {
        if let Some(log) = self.o().log.clone() {
            let message = message.to_owned();
            fx.push(Box::new(move || log(&message, fields)));
        }
    }

    fn log_now(&self, message: &str, fields: Obj) {
        if let Some(log) = &self.o().log {
            log(message, fields);
        }
    }

    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        self.o().clock.sleep(Duration::from_millis(ms))
    }

    fn now(&self) -> i64 {
        self.o().clock.now()
    }

    fn iso_now(&self) -> String {
        js::iso(self.now() as f64)
    }

    fn spawn_task(fx: &mut Fx, task: BoxFuture<'static, ()>) {
        fx.push(Box::new(move || {
            tokio::spawn(task);
        }));
    }

    // ------------------------------------------------------------ status

    fn status(st: &St) -> &'static str {
        if st.proc.is_none() {
            if st.starting.is_none() {
                return "stopped";
            }
            return if st.turn || st.delivering > 0 || !st.queue.is_empty() {
                "starting"
            } else {
                "idle"
            };
        }
        if !st.prompts.is_empty() {
            return "blocked";
        }
        if st.turn || st.compacting || st.delivering > 0 {
            return "working";
        }
        if st.queued_on_start && !st.queue.is_empty() {
            "starting"
        } else {
            "idle"
        }
    }

    fn shown_activity(st: &St) -> Option<String> {
        if st.waking && Self::status(st) == "starting" {
            return Some("waking".into());
        }
        if st.turn || st.compacting {
            st.activity.clone()
        } else {
            None
        }
    }

    fn emit(&self, st: &mut St, fx: &mut Fx, event: Value) {
        let events = st.reply.emit(obj(event), st.muted);
        self.send_events(fx, events);
    }

    fn send_events(&self, fx: &mut Fx, events: Vec<Obj>) {
        if events.is_empty() {
            return;
        }
        let emit = self.o().emit.clone();
        fx.push(Box::new(move || {
            for event in events {
                emit(event);
            }
        }));
    }

    fn flush_deltas(&self, st: &mut St, fx: &mut Fx) {
        let events = st.reply.flush(st.muted);
        self.send_events(fx, events);
    }

    fn push_status(&self, st: &mut St, fx: &mut Fx) {
        let status = Self::status(st);
        let tools = !st.tools.is_empty();
        let running = st.tools.iter().cloned().collect::<Vec<_>>().join(" ");
        let activity = Self::shown_activity(st);
        self.report_status(st, fx, status);
        let now = (LastStatus { status, tools }, running, activity.clone());
        if st.last_status.as_ref() == Some(&now) {
            return;
        }
        st.last_status = Some(now);
        let running_tools: Vec<Value> = st.tools.iter().cloned().map(Value::from).collect();
        self.emit(
            st,
            fx,
            json!({
                "type": "status",
                "status": status,
                "tools_running": tools,
                "running_tools": running_tools,
                "activity": activity,
            }),
        );
    }

    /// Tells Herdr the agent's state when it changes; not while a
    /// replayed turn is read again (only the state the replay ends in).
    fn report_status(&self, st: &mut St, fx: &mut Fx, now: &'static str) {
        if st.muted || st.attaching || st.reported == Some(now) {
            return;
        }
        st.reported = Some(now);
        if let Some(on_status) = self.o().on_status.clone() {
            fx.push(Box::new(move || on_status(now)));
        }
    }

    fn set_next_prompt(&self, st: &mut St, fx: &mut Fx, next: Option<Obj>) {
        match (&next, &st.next_prompt) {
            (None, None) => return,
            (Some(next), Some(current)) if next.get("uuid") == current.get("uuid") => return,
            _ => {}
        }
        st.next_prompt = next.clone();
        self.emit(
            st,
            fx,
            json!({"type": "next_prompt", "next_prompt": next.map(Value::Object).unwrap_or(Value::Null)}),
        );
    }

    fn push_queue(&self, st: &mut St, fx: &mut Fx) {
        let queue: Vec<Value> = st.queue.iter().cloned().map(Value::Object).collect();
        self.emit(st, fx, json!({"type": "queue", "queue": queue}));
        self.push_status(st, fx);
    }

    fn on_turn(&self, fx: &mut Fx, running: bool) {
        if let Some(on_turn) = self.o().on_turn.clone() {
            fx.push(Box::new(move || on_turn(running)));
        }
    }

    fn write(st: &mut St, lines: &[String]) -> Result<(), String> {
        let proc = match (&st.proc, st.ending) {
            (Some(proc), false) => proc.clone(),
            _ => return Err("The conversation process is closing".into()),
        };
        for line in lines {
            proc.write(&format!("{line}\n"))?;
        }
        Ok(())
    }

    fn take(st: &mut St, id: &str) -> bool {
        if st.taken.iter().any(|each| each == id) {
            return false;
        }
        st.taken.push(id.to_owned());
        if st.taken.len() > 64 {
            st.taken.remove(0);
        }
        true
    }

    fn remember(st: &mut St, uuid: &str, text: &str, images: &[String]) {
        st.recent.shift_remove(uuid);
        st.recent
            .insert(uuid.to_owned(), (text.to_owned(), images.to_vec()));
        if st.recent.len() > 16 {
            st.recent.shift_remove_index(0);
        }
    }

    fn queued_item(&self, id: String, text: &str, images: Vec<String>) -> Obj {
        obj(json!({"id": id, "text": text, "images": images, "queued_at": self.iso_now()}))
    }

    // ------------------------------------------------------------ messages

    /// Builds a [`DriverMessage`], reading inline images when needed.
    async fn build_driver_message(
        &self,
        text: &str,
        images: &[String],
        uuid: &str,
        prelude: Vec<String>,
        steer: bool,
    ) -> Result<DriverMessage, String> {
        let inline = self
            .o()
            .driver
            .capabilities()
            .get("images")
            .and_then(Value::as_str)
            == Some("base64");
        let mut read = Vec::new();
        for path in images {
            if inline {
                let image = (self.o().read_image)(path.clone()).await?;
                read.push(DriverImage {
                    path: path.clone(),
                    media_type: Some(image.media_type),
                    data: Some(image.data),
                });
            } else {
                read.push(DriverImage {
                    path: path.clone(),
                    ..DriverImage::default()
                });
            }
        }
        Ok(DriverMessage {
            text: text.to_owned(),
            images: read,
            uuid: uuid.to_owned(),
            prelude,
            steer,
        })
    }

    /// The lines of a user message, its images read when sent inline.
    async fn user_message(
        &self,
        text: &str,
        images: &[String],
        uuid: &str,
        prelude: Vec<String>,
        steer: bool,
    ) -> Result<Vec<String>, String> {
        let message = self
            .build_driver_message(text, images, uuid, prelude, steer)
            .await?;
        Ok(self.with(|st, _| st.codec.message(&message)))
    }

    /// Writes a turn's message; the process starts first when it is not
    /// up. `counted`: the caller counted it as on its way already.
    async fn deliver(
        &self,
        text: String,
        images: Vec<String>,
        uuid: Option<String>,
        counted: bool,
    ) -> Result<String, String> {
        let uuid = uuid.unwrap_or_else(random_uuid);
        if !counted {
            self.with(|st, _| st.delivering += 1);
        }
        let written = self.deliver_inner(&text, &images, &uuid).await;
        self.with(|st, fx| {
            st.delivering -= 1;
            if written.is_err() {
                self.push_status(st, fx);
                return;
            }
            st.turn_uuid = Some(uuid.clone());
            st.turn = true;
            st.last_activity = self.now();
            st.activity = None;
            st.last_block = None;
            self.set_next_prompt(st, fx, None);
            self.on_turn(fx, true);
            self.push_status(st, fx);
        });
        written.map(|()| uuid)
    }

    async fn deliver_inner(&self, text: &str, images: &[String], uuid: &str) -> Result<(), String> {
        // The `!` lines run since the last message: the agent reads them
        // first, as in the terminal.
        let prelude = self.o().prelude.as_ref().and_then(|prelude| prelude());
        let (texts, commit) = match prelude {
            Some(prelude) => (prelude.texts, Some(prelude.commit)),
            None => (Vec::new(), None),
        };
        let driver_message = self
            .build_driver_message(text, images, uuid, texts, false)
            .await?;
        self.ensure_process(false).await?;
        self.with(|st, fx| {
            let lines = st.codec.message(&driver_message);
            Self::write(st, &lines)?;
            if let Some(commit) = commit {
                fx.push(commit);
            }
            Self::remember(st, uuid, text, images);
            Ok(())
        })
    }

    // ------------------------------------------------------------ the stream

    fn handle(&self, st: &mut St, fx: &mut Fx, item: DriverEvent) {
        match s(item.get("kind")) {
            "model" => st.model = Some(s(item.get("model")).to_owned()),
            "context_usage" => {
                if let (Some(used), Some(size)) = (
                    item.get("used").and_then(Value::as_f64),
                    item.get("size").and_then(Value::as_f64),
                ) && used >= 0.0
                    && size > 0.0
                {
                    st.context_usage = Some((used as u64, size as u64));
                }
            }
            "init" => {
                if let Some(model) = item.get("model").and_then(Value::as_str)
                    && !model.is_empty()
                {
                    st.model = Some(model.to_owned());
                }
                let id = s(item.get("session_id")).to_owned();
                if id != st.session_id {
                    self.switch_session(st, fx, id);
                }
            }
            "reset" => {
                let id = s(item.get("new_session_id")).to_owned();
                if id != st.session_id {
                    self.switch_session(st, fx, id);
                }
            }
            "status" => {
                if item.get("status").and_then(Value::as_str) == Some("requesting") {
                    st.turn = true;
                    self.set_next_prompt(st, fx, None);
                }
                st.compacting = item.get("status").and_then(Value::as_str) == Some("compacting");
                if st.compacting {
                    st.activity = Some("compacting".into());
                } else if st.activity.as_deref() == Some("compacting") {
                    st.activity = None;
                }
                self.push_status(st, fx);
            }
            "block_start" => {
                st.turn = true;
                self.set_next_prompt(st, fx, None);
                let block = s(item.get("block")).to_owned();
                st.activity = match block.as_str() {
                    "tool_use" => Some(
                        item.get("name")
                            .and_then(Value::as_str)
                            .filter(|name| !name.is_empty())
                            .unwrap_or("tool")
                            .to_owned(),
                    ),
                    "thinking" => Some("thinking".into()),
                    _ => None,
                };
                st.last_block = Some(block.clone());
                let mut event = obj(json!({
                    "type": "block_start",
                    "message_id": item["message_id"],
                    "index": item["index"],
                    "block": block,
                }));
                if truthy(item.get("tool_use_id")) {
                    event.insert("tool_use_id".into(), item["tool_use_id"].clone());
                }
                if truthy(item.get("name")) {
                    event.insert("name".into(), item["name"].clone());
                }
                self.emit(st, fx, Value::Object(event));
                self.push_status(st, fx);
            }
            "delta" => {
                let timer = st.reply.delta(
                    s(item.get("message_id")),
                    item.get("index").unwrap_or(&Value::Null),
                    s(item.get("text")),
                );
                if let Some(timer) = timer {
                    let session = self.clone();
                    let wait = self.sleep(self.o().coalesce_ms);
                    Self::spawn_task(
                        fx,
                        Box::pin(async move {
                            wait.await;
                            session.with(|st, fx| {
                                if st.reply.timer() == Some(timer) {
                                    session.flush_deltas(st, fx);
                                }
                            });
                        }),
                    );
                }
            }
            "block_stop" => self.emit(
                st,
                fx,
                json!({"type": "block_stop", "message_id": item["message_id"], "index": item["index"]}),
            ),
            "assistant_text" => {
                let mut event = obj(json!({
                    "type": "block_stop",
                    "message_id": item["message_id"],
                    "index": item["index"],
                    "text": item["text"],
                }));
                if truthy(item.get("command_output")) {
                    event.insert("command_output".into(), item["command_output"].clone());
                }
                self.emit(st, fx, Value::Object(event));
            }
            "abandoned" => {
                // An interrupt abandons the reply it cut: the agent keeps
                // that partial text in the transcript, so the chat too.
                if st.interrupting {
                    return;
                }
                let from = item.get("from_index").and_then(Value::as_f64).unwrap_or(0.0);
                st.reply.drop_pending(s(item.get("message_id")), from);
                self.emit(
                    st,
                    fx,
                    json!({"type": "abandoned", "message_id": item["message_id"], "from_index": item["from_index"]}),
                );
            }
            "thinking" => {
                if st.activity.is_none() && st.turn {
                    st.activity = Some("thinking".into());
                    self.push_status(st, fx);
                }
            }
            "tool_use" => {
                st.tools.insert(s(item.get("tool_use_id")).to_owned());
                self.emit(
                    st,
                    fx,
                    json!({
                        "type": "tool_use",
                        "tool_use_id": item["tool_use_id"],
                        "name": item["name"],
                        "input": item.get("input").cloned().unwrap_or(Value::Null),
                        "message_id": item["message_id"],
                        "index": item["index"],
                    }),
                );
                self.push_status(st, fx);
            }
            "tool_result" => {
                st.tools.shift_remove(s(item.get("tool_use_id")));
                self.emit(
                    st,
                    fx,
                    json!({
                        "type": "tool_result",
                        "tool_use_id": item["tool_use_id"],
                        "is_error": item["is_error"],
                        "text": item["text"],
                    }),
                );
                self.push_status(st, fx);
            }
            "user_replay" => {
                self.set_next_prompt(st, fx, None);
                self.emit(
                    st,
                    fx,
                    json!({"type": "user", "uuid": item["uuid"], "text": item["text"], "images": item["images"]}),
                );
            }
            "permission_request" => {
                let id = s(item.get("request_id")).to_owned();
                if st.catching {
                    st.deferred.insert(id, item);
                } else {
                    let session = self.clone();
                    Self::spawn_task(
                        fx,
                        Box::pin(async move { session.answer_permission(item).await }),
                    );
                }
            }
            "permission_cancel" => {
                let id = s(item.get("request_id"));
                st.deferred.shift_remove(id);
                st.asking.shift_remove(id);
                if let Some((_, token)) = st.prompts.get(id) {
                    token.cancel();
                }
            }
            "control_response" => {
                let id = s(item.get("request_id"));
                if let Some(done) = st.interrupts.shift_remove(id) {
                    let _ = done.send(());
                }
                if let Some(answered) = st.controls.shift_remove(id) {
                    let _ = answered.send(ControlAnswer {
                        error: item
                            .get("error")
                            .map(|error| error.as_str().map(str::to_owned).unwrap_or_else(|| js::to_text(error))),
                        response: item.get("response").and_then(Value::as_object).cloned(),
                    });
                }
            }
            "result" => {
                // A message steered in while the turn ended runs as a turn
                // of its own: still working (no handover may cut it).
                st.turn = item.get("queued_turns").and_then(Value::as_f64).unwrap_or(0.0) > 0.0;
                st.respawned_for_queue = false;
                st.compacting = false;
                st.interrupting = false;
                st.activity = None;
                st.last_block = None;
                st.tools.clear();
                self.on_turn(fx, st.turn);
                let mut event = obj(json!({
                    "type": "result",
                    "subtype": item["subtype"],
                    "is_error": item["is_error"],
                    "interrupted": item["interrupted"],
                    "text": item["text"],
                }));
                for key in ["cost_usd", "duration_ms"] {
                    if let Some(value) = item.get(key) {
                        event.insert(key.into(), value.clone());
                    }
                }
                self.emit(st, fx, Value::Object(event));
                for (_, done) in st.result_waiters.drain(..) {
                    let _ = done.send(());
                }
                self.push_status(st, fx);
                if !st.catching {
                    self.flush_queue(fx);
                }
            }
            "compact_boundary" => {
                let text = if truthy(item.get("pre_tokens")) && truthy(item.get("post_tokens")) {
                    format!(
                        "Compacted {} tokens to {}",
                        text_of(item.get("pre_tokens")),
                        text_of(item.get("post_tokens"))
                    )
                } else {
                    "Compacted".into()
                };
                self.emit(st, fx, json!({"type": "notice", "kind": "compact", "text": text}));
            }
            "api_retry" => {
                let error = if truthy(item.get("error")) {
                    format!(": {}", text_of(item.get("error")))
                } else {
                    String::new()
                };
                let text = format!(
                    "Retrying ({}/{}){error}",
                    text_of(item.get("attempt")),
                    text_of(item.get("max_retries"))
                );
                self.emit(st, fx, json!({"type": "notice", "kind": "api_retry", "text": text}));
            }
            "permission_denied" => self.emit(
                st,
                fx,
                json!({"type": "notice", "kind": "permission_denied", "text": item["message"]}),
            ),
            "task_started" => {
                st.tasks.insert(s(item.get("task_id")).to_owned());
            }
            "task_ended" => {
                st.tasks.shift_remove(s(item.get("task_id")));
            }
            "prompt_suggestion" => {
                // Only for a box with nothing on its way.
                if st.turn || st.compacting || st.delivering > 0 || !st.queue.is_empty() {
                    return;
                }
                let uuid = item
                    .get("uuid")
                    .and_then(Value::as_str)
                    .filter(|uuid| !uuid.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(random_uuid);
                let next = obj(json!({"uuid": uuid, "text": item["suggestion"]}));
                self.set_next_prompt(st, fx, Some(next));
            }
            _ => {}
        }
    }

    fn switch_session(&self, st: &mut St, fx: &mut Fx, id: String) {
        let previous = std::mem::replace(&mut st.session_id, id.clone());
        self.set_next_prompt(st, fx, None);
        self.emit(
            st,
            fx,
            json!({"type": "session", "session_id": id, "previous": previous}),
        );
        if let Some(on_session_id) = self.o().on_session_id.clone() {
            fx.push(Box::new(move || on_session_id(&id, &previous)));
        }
    }

    async fn answer_permission(&self, item: DriverEvent) {
        let id = s(item.get("request_id")).to_owned();
        let token = CancellationToken::new();
        let number = self.with(|st, fx| {
            st.prompt_ids += 1;
            let number = st.prompt_ids;
            st.prompts.insert(id.clone(), (number, token.clone()));
            st.asking.insert(id.clone(), item.clone());
            self.push_status(st, fx);
            number
        });
        let prompt = self.o().driver.prompt_of(&item);
        let timeout_ms = if prompt.questions.as_ref().is_some_and(|q| !q.is_empty()) {
            self.o().question_timeout_ms
        } else {
            self.o().permission_timeout_ms
        };
        let asked = (self.o().ask)(ConversationPrompt {
            tool: prompt.tool,
            input: prompt.input,
            can_always: prompt.can_always,
            questions: prompt.questions,
            timeout_ms,
            signal: token.clone(),
        })
        .await;
        let answer = match asked {
            Ok(answer) => answer,
            Err(error) => {
                self.log_now("permission prompt failed", obj(json!({"error": error})));
                None
            }
        };
        self.with(|st, fx| {
            if st.prompts.get(&id).map(|(n, _)| *n) != Some(number) {
                return;
            }
            st.prompts.shift_remove(&id);
            st.asking.shift_remove(&id);
            // Cancelled by the agent (an interrupt): it expects no answer.
            if !token.is_cancelled() && st.proc.is_some() {
                let lines = st.codec.answer(&item, answer.as_ref());
                if let Err(error) = Self::write(st, &lines) {
                    self.log(
                        fx,
                        "permission answer not written",
                        obj(json!({"error": error})),
                    );
                }
            }
            self.push_status(st, fx);
        });
    }

    /// Whether a message written now would start a turn at once.
    fn ready(st: &St) -> bool {
        !st.turn
            && !st.compacting
            && st.prompts.is_empty()
            && st.starting.is_none()
            && st.delivering == 0
            && !st.rewinding
    }

    /// Writes what waits in the queue, in order, as one turn; true once it
    /// is written. Undelivered, it goes back in the queue, first.
    fn drain_queue(&self, uuid: Option<String>) -> BoxFuture<'static, bool> {
        let session = self.clone();
        Box::pin(async move {
            let taken = session.with(|st, fx| {
                if st.queued_on_start {
                    st.queued_on_start = false;
                    if st.queue.is_empty() || !Self::ready(st) {
                        session.push_status(st, fx);
                    }
                }
                if st.queue.is_empty() || !Self::ready(st) {
                    return None;
                }
                let items: Vec<Obj> = std::mem::take(&mut st.queue);
                let text = items
                    .iter()
                    .map(|item| s(item.get("text")))
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let images: Vec<String> = items
                    .iter()
                    .flat_map(|item| {
                        item.get("images")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|image| image.as_str().map(str::to_owned))
                    })
                    .collect();
                let id = uuid.clone().unwrap_or_else(|| {
                    if items.len() == 1 {
                        s(items[0].get("id")).to_owned()
                    } else {
                        random_uuid()
                    }
                });
                // Under way before the queue is told empty: the status it
                // pushes is working, not idle.
                st.delivering += 1;
                session.push_queue(st, fx);
                Some((items, text, images, id))
            });
            let Some((items, text, images, id)) = taken else {
                return false;
            };
            match session.deliver(text, images, Some(id), true).await {
                Ok(_) => true,
                Err(error) => {
                    session.with(|st, fx| {
                        session.log(
                            fx,
                            "queued messages not delivered",
                            obj(json!({"error": error})),
                        );
                        let mut back = items;
                        back.append(&mut st.queue);
                        st.queue = back;
                        session.push_queue(st, fx);
                    });
                    false
                }
            }
        })
    }

    fn flush_queue(&self, fx: &mut Fx) {
        let drain = self.drain_queue(None);
        Self::spawn_task(
            fx,
            Box::pin(async move {
                drain.await;
            }),
        );
    }

    // ------------------------------------------------------------ the process

    /// The process, started when none runs (`attach_only`: only one that
    /// already runs is taken, None when nothing does).
    pub fn ensure_process(
        &self,
        attach_only: bool,
    ) -> BoxFuture<'static, Result<Option<Proc>, String>> {
        let session = self.clone();
        Box::pin(async move { session.ensure_process_inner(attach_only).await })
    }

    async fn ensure_process_inner(&self, attach_only: bool) -> Result<Option<Proc>, String> {
        enum Step {
            Wait(Starting),
            WaitExit(Waiter),
            Have(Proc),
            Start,
        }
        loop {
            let step = self.with(|st, _| {
                if st.disposed {
                    return Err("The conversation is closed".to_owned());
                }
                if st.stopping && !attach_only {
                    return Err("The session is being handed back to the terminal".into());
                }
                if let Some((_, starting)) = &st.starting {
                    return Ok(Step::Wait(starting.clone()));
                }
                let Some(proc) = st.proc.clone() else {
                    return Ok(Step::Start);
                };
                if !st.ending || attach_only {
                    return Ok(Step::Have(proc));
                }
                let exited = st.exited.clone().unwrap_or_else(|| {
                    let proc = proc.clone();
                    async move {
                        proc.exited().await;
                    }
                    .boxed()
                    .shared()
                });
                Ok(Step::WaitExit(exited))
            })?;
            match step {
                Step::Wait(starting) => {
                    let started = starting.await?;
                    if started.is_some() || attach_only {
                        return Ok(started);
                    }
                }
                Step::WaitExit(exited) => exited.await,
                Step::Have(proc) => return Ok(Some(proc)),
                Step::Start => break,
            }
        }
        let (go, gate) = oneshot::channel::<()>();
        let session = self.clone();
        let starting = self.with(|st, _| {
            st.starts += 1;
            let number = st.starts;
            let token = CancellationToken::new();
            st.spawn_abort = Some((number, token.clone()));
            let resumed = st.session_id.clone();
            // Asleep: this start wakes it.
            st.waking = st.asleep && !attach_only;
            let task = tokio::spawn(async move {
                let _ = gate.await;
                session.start(number, resumed, attach_only, token).await
            });
            let starting: Starting = async move {
                task.await
                    .unwrap_or_else(|error| Err(format!("the start failed: {error}")))
            }
            .boxed()
            .shared();
            st.starting = Some((number, starting.clone()));
            starting
        });
        let _ = go.send(());
        let started = starting.await;
        self.with(|st, fx| {
            st.queued_on_start = st.proc.is_some() && !st.queue.is_empty();
            self.push_status(st, fx);
        });
        started
    }

    async fn start(
        &self,
        number: u64,
        resumed: String,
        attach_only: bool,
        token: CancellationToken,
    ) -> Started {
        self.with(|st, fx| {
            st.attaching = attach_only;
            self.push_status(st, fx);
        });
        let spawned = self
            .o()
            .spawn
            .spawn(HeadlessSpawnOptions {
                pane_id: self.o().pane_id.clone(),
                session_id: resumed.clone(),
                cwd: self.o().cwd.clone(),
                attach_only,
                signal: Some(token),
                api_key_answer: None,
            })
            .await;
        self.with(|st, fx| {
            let result = match spawned {
                Err(error) => Err(error),
                Ok(None) => Ok(None),
                Ok(Some(child)) if st.disposed => {
                    child.detach();
                    Err("The conversation is closed".into())
                }
                Ok(Some(child)) => {
                    // Kept even while a stop waits for this start.
                    st.proc = Some(child.clone());
                    st.ending = false;
                    if st.asleep {
                        st.asleep = false;
                        if let Some(on_asleep) = self.o().on_asleep.clone() {
                            fx.push(Box::new(move || on_asleep(false)));
                        }
                    }
                    st.codec = self.o().driver.create_codec();
                    if let Some(on_process) = self.o().on_process.clone() {
                        let pid = child.pid();
                        let resumed = resumed.clone();
                        fx.push(Box::new(move || on_process(pid, Some(&resumed))));
                    }
                    self.log(
                        fx,
                        "conversation process started",
                        obj(json!({"session": st.session_id})),
                    );
                    self.begin_read(st, fx, child.clone());
                    if !attach_only && child.replayed() == 0 && child.resume().is_none() {
                        let init = st.codec.on_start(&resumed, &self.o().cwd);
                        if !init.is_empty()
                            && let Err(error) = Self::write(st, &init)
                        {
                            self.log(
                                fx,
                                "conversation startup handshake not written",
                                obj(json!({"error": error})),
                            );
                        }
                    }
                    Ok(Some(child))
                }
            };
            // Read from here: muted while it replays what ran before.
            st.attaching = false;
            st.waking = false;
            if st.starting.as_ref().map(|(n, _)| *n) == Some(number) {
                st.starting = None;
            }
            if st.spawn_abort.as_ref().map(|(n, _)| *n) == Some(number) {
                st.spawn_abort = None;
            }
            result
        })
    }

    /// The holder's note of what was written to the process.
    fn holder_note(&self, st: &mut St, fx: &mut Fx, line: &str) {
        let Some(Value::Object(note)) = js::parse(line) else {
            return;
        };
        // Dropped: the agent never got it.
        if truthy(note.get("dropped")) {
            return;
        }
        let kind = note.get("kind").and_then(Value::as_str);
        if kind == Some("user") && !st.turn {
            st.turn = true;
            self.set_next_prompt(st, fx, None);
            st.activity = None;
            st.last_block = None;
            self.on_turn(fx, true);
            self.push_status(st, fx);
        } else if kind == Some(self.o().driver.answer_kind())
            && let Some(id) = note.get("request_id").and_then(Value::as_str)
        {
            st.deferred.shift_remove(id);
            st.asking.shift_remove(id);
            // Answered by another runtime: the card asked again goes.
            if let Some((_, token)) = st.prompts.get(id) {
                token.cancel();
            }
        }
    }

    /// The replay is over: the browsers hear from here.
    fn unmute(&self, st: &mut St, fx: &mut Fx) {
        if !st.muted {
            return;
        }
        self.flush_deltas(st, fx);
        st.muted = false;
        st.last_status = None;
        self.push_status(st, fx);
    }

    /// Caught up with what was in when the process was taken.
    fn end_catch_up(&self, st: &mut St, fx: &mut Fx) {
        self.unmute(st, fx);
        if !st.catching {
            return;
        }
        st.catching = false;
        let open: Vec<DriverEvent> = std::mem::take(&mut st.deferred).into_values().collect();
        for item in open {
            let session = self.clone();
            Self::spawn_task(
                fx,
                Box::pin(async move { session.answer_permission(item).await }),
            );
        }
        if !st.turn {
            self.flush_queue(fx);
        }
    }

    fn resolve_caught_up(st: &mut St, read: u64) {
        if st.caught_up_tx.as_ref().map(|(n, _)| *n) == Some(read)
            && let Some((_, done)) = st.caught_up_tx.take()
        {
            let _ = done.send(());
        }
    }

    /// User messages the agent never got go back first in the queue.
    fn requeue(&self, st: &mut St, fx: &mut Fx, lines: Vec<String>) -> Vec<String> {
        let mut items = Vec::new();
        for line in lines {
            let Some(message) = self.o().driver.parse_written_message(&line) else {
                continue;
            };
            let uuid = message.uuid.unwrap_or_else(random_uuid);
            let (text, images) = match st.recent.get(&uuid) {
                Some((text, images)) => (text.clone(), images.clone()),
                None => (message.text, Vec::new()),
            };
            if text.is_empty() && images.is_empty() {
                continue;
            }
            items.push(self.queued_item(uuid, &text, images));
        }
        if !items.is_empty() {
            self.log(
                fx,
                &format!(
                    "messages {} never got go back in the queue",
                    self.o().driver.agent()
                ),
                obj(json!({"session": st.session_id, "count": items.len()})),
            );
            let ids = items
                .iter()
                .map(|item| s(item.get("id")).to_owned())
                .collect();
            let mut back = items;
            back.append(&mut st.queue);
            st.queue = back;
            self.push_queue(st, fx);
            return ids;
        }
        Vec::new()
    }

    /// Takes up the state a reader before this one saved.
    fn restore(&self, st: &mut St, fx: &mut Fx, value: &Value) -> bool {
        let Some(state) = resume_state_of(value) else {
            return false;
        };
        let strings = |key: &str| -> Vec<String> {
            state
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        st.turn = state.get("turn").and_then(Value::as_bool).unwrap_or(false);
        st.compacting = state.get("compacting").and_then(Value::as_bool) == Some(true);
        st.activity = state
            .get("activity")
            .and_then(Value::as_str)
            .map(str::to_owned);
        st.last_block = state
            .get("last_block")
            .and_then(Value::as_str)
            .map(str::to_owned);
        st.tools = strings("tools").into_iter().collect();
        st.tasks = strings("tasks").into_iter().collect();
        for item in state
            .get("prompts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(item) = item.as_object()
                && let Some(id) = item.get("request_id").and_then(Value::as_str)
            {
                st.deferred.insert(id.to_owned(), item.clone());
            }
        }
        st.next_prompt = state.get("next_prompt").and_then(Value::as_object).cloned();
        st.reply.restore(
            state
                .get("streamed")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        st.turn_uuid = state
            .get("turn_uuid")
            .and_then(Value::as_str)
            .map(str::to_owned);
        st.respawned_for_queue =
            state.get("respawned_for_queue").and_then(Value::as_bool) == Some(true);
        for id in strings("taken") {
            if !st.taken.contains(&id) {
                st.taken.push(id);
            }
        }
        while st.taken.len() > 64 {
            st.taken.remove(0);
        }
        for pair in state
            .get("recent")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(pair) = pair.as_array() else {
                continue;
            };
            let (Some(uuid), Some(message)) = (pair.first().and_then(Value::as_str), pair.get(1))
            else {
                continue;
            };
            if !truthy(Some(message)) {
                continue;
            }
            let text = message
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let images = message
                .get("images")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            st.recent.insert(uuid.to_owned(), (text, images));
        }
        st.codec
            .restore(state.get("parser").unwrap_or(&Value::Null));
        self.on_turn(fx, st.turn);
        self.log(
            fx,
            "conversation state taken up where it was saved",
            obj(json!({"session": st.session_id, "turn": st.turn})),
        );
        true
    }

    /// What `read` does before its first line (Bun's synchronous prefix),
    /// then the reading task.
    fn begin_read(&self, st: &mut St, fx: &mut Fx, child: Proc) {
        let restored = match child.resume() {
            Some(value) => self.restore(st, fx, &value),
            None => false,
        };
        let replayed = child.replayed();
        let catch_up = child.catch_up().max(replayed);
        st.reads += 1;
        let read = st.reads;
        let (done, caught) = oneshot::channel::<()>();
        st.caught_up = async move {
            let _ = caught.await;
        }
        .boxed()
        .shared();
        st.caught_up_tx = Some((read, done));
        st.muted = replayed > 0;
        // Restored prompts are asked once caught up, even with nothing to
        // read.
        st.catching = catch_up > 0 || restored;
        if !st.catching {
            Self::resolve_caught_up(st, read);
        } else if catch_up == 0 {
            self.end_catch_up(st, fx);
            Self::resolve_caught_up(st, read);
        }
        let session = self.clone();
        let task = tokio::spawn(async move { session.read(child, read, replayed, catch_up).await });
        st.exited = Some(
            async move {
                let _ = task.await;
            }
            .boxed()
            .shared(),
        );
    }

    async fn read(&self, child: Proc, read: u64, replayed: usize, catch_up: usize) {
        let mut index = 0usize;
        while let Some(line) = child.next_line().await {
            index += 1;
            self.with(|st, fx| {
                if line.starts_with("{\"type\":\"roamgate_input\"") {
                    self.holder_note(st, fx, &line);
                } else {
                    if !st.muted
                        && peer_line().is_match(&line)
                        && let Some(on_peer) = self.o().on_peer.clone()
                    {
                        fx.push(Box::new(move || on_peer()));
                    }
                    let items = st.codec.line(&line);
                    for item in items {
                        self.handle(st, fx, item);
                    }
                    // What the protocol answers to a line: a replayed line's
                    // answer went out with the reader that first had it.
                    let pending = st.codec.pending_writes();
                    if !st.muted
                        && !pending.is_empty()
                        && let Err(error) = Self::write(st, &pending)
                    {
                        self.log(
                            fx,
                            "protocol follow-up not written",
                            obj(json!({"error": error})),
                        );
                    }
                    if !st.catching && !st.muted {
                        st.last_activity = self.now();
                        if let Some(on_output) = self.o().on_output.clone() {
                            fx.push(Box::new(move || on_output()));
                        }
                    }
                }
                if index >= replayed {
                    self.unmute(st, fx);
                }
                if index >= catch_up && st.catching {
                    self.end_catch_up(st, fx);
                    Self::resolve_caught_up(st, read);
                }
            });
        }
        // Detached (this runtime goes): the process runs on in the holder.
        let disposed = self.with(|st, fx| {
            if st.disposed {
                Self::resolve_caught_up(st, read);
                return true;
            }
            self.end_catch_up(st, fx);
            Self::resolve_caught_up(st, read);
            false
        });
        if disposed {
            return;
        }
        let code = child.exited().await;
        self.with(|st, fx| {
            self.flush_deltas(st, fx);
            if !st.proc.as_ref().is_some_and(|proc| same(proc, &child)) {
                return;
            }
            // What it was written but never got: not a turn cut short,
            // and sent again to the next process.
            let lost = self.requeue(st, fx, child.undelivered().unwrap_or_default());
            if st.turn_uuid.as_ref().is_some_and(|uuid| lost.contains(uuid)) {
                st.turn = false;
                st.compacting = false;
                self.on_turn(fx, false);
            }
            st.proc = None;
            st.ending = false;
            st.interrupting = false;
            st.last_block = None;
            for (_, (_, token)) in st.prompts.drain(..) {
                token.cancel();
            }
            st.asking.clear();
            st.deferred.clear();
            for (_, done) in st.interrupts.drain(..) {
                let _ = done.send(());
            }
            let stopped = format!("{} stopped", self.0.agent_name);
            for (_, answered) in st.controls.drain(..) {
                let _ = answered.send(ControlAnswer {
                    error: Some(stopped.clone()),
                    response: None,
                });
            }
            st.tools.clear();
            st.tasks.clear();
            let was_turn = st.turn || st.compacting;
            st.turn = false;
            st.compacting = false;
            st.activity = None;
            if was_turn {
                let text = format!(
                    "{} stopped in the middle of the turn (exit {code})",
                    self.0.agent_name
                );
                self.emit(st, fx, json!({"type": "notice", "kind": "process_exited", "text": text}));
                self.emit(
                    st,
                    fx,
                    json!({"type": "result", "subtype": "process_exited", "is_error": true, "interrupted": true, "text": ""}),
                );
            }
            for (_, done) in st.result_waiters.drain(..) {
                let _ = done.send(());
            }
            if let Some(on_process) = self.o().on_process.clone() {
                fx.push(Box::new(move || on_process(None, None)));
            }
            self.log(
                fx,
                "conversation process exited",
                obj(json!({"session": st.session_id, "code": code})),
            );
            self.push_status(st, fx);
            // What waited for that turn goes to a new process, once.
            if !st.queue.is_empty() && !st.disposed && !st.stopping {
                if !st.respawned_for_queue {
                    st.respawned_for_queue = true;
                    self.flush_queue(fx);
                } else {
                    let text = format!(
                        "{} stopped again; the queued messages wait for the next one you send",
                        self.0.agent_name
                    );
                    self.emit(st, fx, json!({"type": "notice", "kind": "error", "text": text}));
                }
            }
        });
    }

    /// True once the turn's result came (at once when none runs), false
    /// past `timeout_ms`.
    pub async fn wait_for_result(&self, timeout_ms: u64) -> bool {
        let waiter = self.with(|st, _| {
            if !st.turn && !st.compacting {
                return None;
            }
            st.waiter_ids += 1;
            let (done, waiter) = oneshot::channel();
            st.result_waiters.push((st.waiter_ids, done));
            Some((st.waiter_ids, waiter))
        });
        let Some((id, waiter)) = waiter else {
            return true;
        };
        let timeout = self.sleep(timeout_ms);
        tokio::select! {
            _ = waiter => true,
            () = timeout => {
                self.with(|st, _| st.result_waiters.retain(|(each, _)| *each != id));
                false
            }
        }
    }

    /// Stops the turn; the process stays up and keeps the partial reply.
    pub async fn interrupt(&self) -> Result<bool, String> {
        let request_id = format!("roamgate-interrupt-{}", random_uuid());
        let confirmed = self.with(|st, fx| {
            if st.proc.is_none() || (!st.turn && !st.compacting && st.prompts.is_empty()) {
                return Ok::<_, String>(None);
            }
            let (done, confirmed) = oneshot::channel();
            st.interrupts.insert(request_id.clone(), done);
            for (_, token) in st.prompts.values() {
                token.cancel();
            }
            st.interrupting = true;
            // Stopped on purpose: the process exiting now cuts nothing.
            self.on_turn(fx, false);
            let lines = st.codec.interrupt(&request_id);
            Self::write(st, &lines)?;
            Ok(Some(confirmed))
        })?;
        let Some(confirmed) = confirmed else {
            return Ok(false);
        };
        let wait = self.sleep(self.o().interrupt_wait_ms);
        let ok = tokio::select! {
            _ = confirmed => true,
            () = wait => false,
        };
        self.with(|st, _| st.interrupts.shift_remove(&request_id));
        Ok(ok)
    }

    /// Asks the agent something over its control protocol; None: no
    /// answer in time.
    pub async fn control(
        &self,
        child: &Proc,
        kind: &str,
        params: Object,
        wait_ms: u64,
    ) -> Option<ControlAnswer> {
        let request_id = format!("roamgate-{kind}-{}", random_uuid());
        let closing = || ControlAnswer {
            error: Some("The conversation process is closing".into()),
            response: None,
        };
        let answer = self.with(|st, _| {
            if !st.proc.as_ref().is_some_and(|proc| same(proc, child)) || st.ending {
                return Err(closing());
            }
            let Some(lines) = st.codec.request(kind, &params, &request_id) else {
                return Err(ControlAnswer {
                    error: Some(format!("{} cannot do that", self.0.agent_name)),
                    response: None,
                });
            };
            let (done, answer) = oneshot::channel();
            st.controls.insert(request_id.clone(), done);
            if let Err(error) = Self::write(st, &lines) {
                st.controls.shift_remove(&request_id);
                return Err(ControlAnswer {
                    error: Some(error),
                    response: None,
                });
            }
            Ok(answer)
        });
        let answer = match answer {
            Ok(answer) => answer,
            Err(refused) => return Some(refused),
        };
        let wait = self.sleep(wait_ms);
        let answered = tokio::select! {
            answer = answer => answer.ok(),
            () = wait => None,
        };
        self.with(|st, _| st.controls.shift_remove(&request_id));
        answered
    }

    fn context(&self, child: Proc, wait_ms: u64) -> SessionControl {
        SessionControl {
            session: self.clone(),
            child,
            wait_ms,
        }
    }

    /// The models the running process offers (/model's picker); None when
    /// none runs or it cannot say.
    pub async fn list_models(&self) -> Option<Vec<Value>> {
        let driver = self.o().driver.clone();
        let models = driver.models()?;
        let child = self.with(|st, _| {
            if st.ending || st.stopping || st.disposed {
                None
            } else {
                st.proc.clone()
            }
        })?;
        let context = self.context(child, self.o().rewind_wait_ms.min(5000));
        models.list(&context).await
    }

    /// Switches the session's model (/model) for its next turns; the
    /// process starts when none runs. Ok: the model it runs then (None:
    /// it did not say), and whether a turn ran.
    pub async fn set_model(&self, value: &str) -> Result<(Option<String>, bool), String> {
        let driver = self.o().driver.clone();
        let Some(models) = driver.models() else {
            return Err(format!("{} cannot switch models", self.0.agent_name));
        };
        let (rewinding, stopping) = self.with(|st, _| (st.rewinding, st.stopping));
        if rewinding {
            return Err("A rewind is running; switch once it is done".into());
        }
        if stopping {
            return Err("The session is being handed back".into());
        }
        let child = match self.ensure_process(false).await {
            Ok(Some(child)) => child,
            Ok(None) => return Err(format!("{} did not start", self.0.agent_name)),
            Err(error) => return Err(format!("{} did not start ({error})", self.0.agent_name)),
        };
        let next_turn = self.with(|st, _| st.turn || st.compacting);
        let context = self.context(child, self.o().rewind_wait_ms);
        let result = models.set(&context, value).await;
        self.with(|st, fx| {
            if let Ok(model) = &result {
                if model.is_some() {
                    st.model = model.clone();
                }
                st.chosen_model = Some(value.to_owned());
            }
            // What waited for a process (a start that failed) goes now.
            if !st.queue.is_empty() && !st.disposed {
                self.flush_queue(fx);
            }
        });
        result.map(|model| (model, next_turn))
    }

    async fn mcp_child(&self) -> Result<Proc, String> {
        let (rewinding, stopping) = self.with(|st, _| (st.rewinding, st.stopping));
        if rewinding {
            return Err("A rewind is running; try once it is done".into());
        }
        if stopping {
            return Err("The session is being handed back".into());
        }
        let child = match self.ensure_process(false).await {
            Ok(Some(child)) => child,
            Ok(None) => return Err(format!("{} did not start", self.0.agent_name)),
            Err(error) => return Err(format!("{} did not start ({error})", self.0.agent_name)),
        };
        self.with(|st, _| st.last_activity = self.now());
        Ok(child)
    }

    fn after_mcp(&self) {
        self.with(|st, fx| {
            if !st.queue.is_empty() && !st.disposed {
                self.flush_queue(fx);
            }
        });
    }

    /// The session's MCP servers (/mcp), or why they cannot be told.
    pub async fn mcp_status(&self) -> Result<Vec<Value>, String> {
        let driver = self.o().driver.clone();
        let Some(mcp) = driver.mcp() else {
            return Err(format!(
                "{} has no MCP servers to manage",
                self.0.agent_name
            ));
        };
        let child = self.mcp_child().await?;
        let context = self.context(child, self.o().mcp_wait_ms.min(20_000));
        let result = mcp.status(&context).await;
        self.after_mcp();
        result
    }

    /// Acts on one of the session's MCP servers (/mcp):
    /// `AgentChatMcpResult`, or `{ok: false, reason}`.
    pub async fn mcp_action(&self, request: Value) -> Value {
        let driver = self.o().driver.clone();
        let Some(mcp) = driver.mcp() else {
            return refuse(format!(
                "{} has no MCP servers to manage",
                self.0.agent_name
            ));
        };
        let child = match self.mcp_child().await {
            Ok(child) => child,
            Err(reason) => return refuse(reason),
        };
        let context = self.context(child, self.o().mcp_wait_ms);
        let result = mcp.act(&context, request).await;
        self.after_mcp();
        result
    }

    fn background_tools(&self) -> bool {
        truthy(self.o().driver.capabilities().get("backgroundTools"))
    }

    /// Moves the running command or subagent `tool_use_id` started to the
    /// background (Ctrl+B); all of the turn's when none is named. Ok:
    /// whether a named call was found running in the foreground.
    pub async fn background(&self, tool_use_id: Option<&str>) -> Result<bool, String> {
        if !self.background_tools() {
            return Err(format!("{} cannot do that", self.0.agent_name));
        }
        let child = self.with(|st, _| {
            if st.ending || st.stopping || st.disposed || (!st.turn && !st.compacting) {
                None
            } else {
                st.proc.clone()
            }
        });
        let Some(child) = child else {
            return Err("Nothing runs in the foreground".into());
        };
        let mut params = Object::new();
        if let Some(id) = tool_use_id {
            params.insert("tool_use_id".into(), Value::from(id));
        }
        let answer = self
            .control(
                &child,
                "background_tasks",
                params,
                self.o().rewind_wait_ms.min(5000),
            )
            .await;
        let Some(answer) = answer else {
            return Err(format!("{} did not answer", self.0.agent_name));
        };
        if let Some(error) = answer.error {
            return Err(error);
        }
        self.with(|st, _| st.last_activity = self.now());
        Ok(match tool_use_id {
            Some(_) => {
                answer
                    .response
                    .as_ref()
                    .and_then(|response| response.get("backgrounded"))
                    != Some(&Value::Bool(false))
            }
            None => true,
        })
    }

    /// Stops one of the session's background tasks (its task or agent id).
    pub async fn stop_task(&self, task_id: &str) -> Result<(), String> {
        if !self.background_tools() {
            return Err(format!("{} cannot do that", self.0.agent_name));
        }
        let child = self.with(|st, _| {
            if st.ending || st.disposed {
                None
            } else {
                st.proc.clone()
            }
        });
        let Some(child) = child else {
            return Err(format!("{} is not running", self.0.agent_name));
        };
        let params = obj(json!({"task_id": task_id}));
        let answer = self
            .control(
                &child,
                "stop_task",
                params,
                self.o().rewind_wait_ms.min(5000),
            )
            .await;
        let Some(answer) = answer else {
            return Err(format!("{} did not answer", self.0.agent_name));
        };
        match answer.error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    // ------------------------------------------------------------ rewinds

    fn busy_now(st: &St) -> bool {
        st.turn || st.compacting || !st.prompts.is_empty() || st.delivering > 0 || st.rewinding
    }

    /// What a rewind to before `uuid` could do to the code
    /// (`AgentChatRewindCheck`), from the transcript alone.
    pub async fn rewind_check(&self, uuid: &str) -> Value {
        let driver = self.o().driver.clone();
        let Some(rewind) = driver.rewind() else {
            return json!({"code": "unknown"});
        };
        let context = RewindSession(self.clone());
        rewind.check(&context, uuid).await
    }

    /// Rewinds the session to before the user's message `uuid`
    /// (`AgentChatRewindResult`); `interrupt` stops a turn that runs first.
    pub async fn rewind(
        &self,
        uuid: &str,
        last_seen: Option<&str>,
        mode: &str,
        interrupt: bool,
    ) -> Result<Value, String> {
        let driver = self.o().driver.clone();
        let Some(rewind) = driver.rewind() else {
            return Ok(refuse(format!("{} cannot rewind", self.0.agent_name)));
        };
        let refused = self.with(|st, _| {
            if st.rewinding {
                Some("A rewind is running already")
            } else if st.stopping {
                Some("The session is being handed back")
            } else if !st.queue.is_empty() {
                Some("Messages wait in the queue; send them or take them back first")
            } else {
                None
            }
        });
        if let Some(reason) = refused {
            return Ok(refuse(reason));
        }
        let (busy, process) = self.with(|st, _| (Self::busy_now(st), st.proc.is_some()));
        if busy && interrupt && process {
            self.interrupt().await?;
            self.wait_for_result(self.o().interrupt_wait_ms).await;
        }
        let refused = self.with(|st, fx| {
            if Self::busy_now(st) {
                return Some(if st.prompts.is_empty() {
                    "A turn is running; stop it first"
                } else {
                    "A question or permission waits for an answer"
                });
            }
            st.rewinding = true;
            self.push_status(st, fx);
            None
        });
        if let Some(reason) = refused {
            return Ok(refuse(reason));
        }
        let context = RewindSession(self.clone());
        let result = rewind
            .run(
                &context,
                RewindInput {
                    uuid: uuid.to_owned(),
                    last_seen: last_seen.map(str::to_owned),
                    mode: mode.to_owned(),
                },
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => refuse(error),
        };
        self.with(|st, fx| {
            // Every browser drops what it streamed of the turns cut.
            if result.get("ok") == Some(&Value::Bool(true)) && mode != "code" {
                self.emit(st, fx, json!({"type": "rewound", "uuid": uuid}));
            }
            st.rewinding = false;
            self.push_status(st, fx);
            if !st.queue.is_empty() && !st.disposed {
                self.flush_queue(fx);
            }
        });
        Ok(result)
    }

    /// Closes stdin and waits for the process to exit, killing it if it
    /// does not. True once no process runs.
    pub fn stop_process(&self) -> BoxFuture<'static, bool> {
        let session = self.clone();
        Box::pin(async move {
            // A start waiting gives up; one that already spawned leaves its
            // process to be ended below.
            let starting = session.with(|st, _| {
                if let Some((_, token)) = &st.spawn_abort {
                    token.cancel();
                }
                st.starting.as_ref().map(|(_, starting)| starting.clone())
            });
            if let Some(starting) = starting {
                let _ = starting.await;
            }
            let ended = session.with(|st, _| {
                let child = st.proc.clone()?;
                let done = st.exited.clone().unwrap_or_else(|| {
                    let child = child.clone();
                    async move {
                        child.exited().await;
                    }
                    .boxed()
                    .shared()
                });
                st.ending = true;
                child.end();
                Some((child, done))
            });
            let Some((child, done)) = ended else {
                return true;
            };
            let wait = session.sleep(session.o().stop_wait_ms);
            let gone = tokio::select! {
                () = done.clone() => true,
                () = wait => false,
            };
            if gone {
                return true;
            }
            let id = session.with(|st, _| st.session_id.clone());
            session.log_now(
                "conversation process did not exit; killing it",
                obj(json!({"session": id})),
            );
            child.kill();
            let wait = session.sleep(session.o().stop_wait_ms);
            tokio::select! {
                () = done => true,
                () = wait => false,
            }
        })
    }

    // ------------------------------------------------------------ the API

    /// Whether both are the same session.
    pub fn same(&self, other: &ConversationSession) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub fn pane_id(&self) -> &str {
        &self.o().pane_id
    }

    pub fn cwd(&self) -> &str {
        &self.o().cwd
    }

    pub fn session_id(&self) -> String {
        self.with(|st, _| st.session_id.clone())
    }

    pub fn alive(&self) -> bool {
        self.with(|st, _| st.proc.is_some() || st.starting.is_some())
    }

    pub fn pid(&self) -> Option<u32> {
        self.with(|st, _| st.proc.as_ref().and_then(|proc| proc.pid()))
    }

    /// A turn runs, a prompt waits, a message is on its way, or a rewind
    /// runs: no handover now.
    pub fn busy(&self) -> bool {
        self.with(|st, _| Self::busy_now(st))
    }

    pub fn activity(&self) -> TurnActivity {
        self.with(|st, _| TurnActivity {
            running: (st.turn || st.compacting) && st.prompts.is_empty(),
            since: st.last_activity,
            tools: !st.tools.is_empty(),
        })
    }

    /// Tasks that may outlive their turn (background commands, agents).
    pub fn background_tasks(&self) -> usize {
        self.with(|st, _| st.tasks.len())
    }

    /// The chat's state (`status`, `tools_running`, `running_tools`,
    /// `activity`, `queue`, `next_prompt`).
    pub fn state(&self) -> Obj {
        self.with(|st, _| {
            let running: Vec<Value> = st.tools.iter().cloned().map(Value::from).collect();
            let queue: Vec<Value> = st.queue.iter().cloned().map(Value::Object).collect();
            obj(json!({
                "status": Self::status(st),
                "tools_running": !st.tools.is_empty(),
                "running_tools": running,
                "activity": Self::shown_activity(st),
                "queue": queue,
                "next_prompt": st.next_prompt.clone().map(Value::Object).unwrap_or(Value::Null),
            }))
        })
    }

    /// The reply text sent so far of the turn that runs, by block.
    pub fn streamed(&self) -> Vec<Obj> {
        self.with(|st, _| st.reply.streamed())
    }

    /// Starts the process ahead of the first turn. When it cannot start,
    /// what was typed meanwhile stays queued and the chat says so.
    pub async fn warm(&self) -> Result<(), String> {
        match self.ensure_process(false).await {
            Ok(_) => {
                self.with(|_, fx| self.flush_queue(fx));
                Ok(())
            }
            Err(error) => {
                self.with(|st, fx| {
                    if !st.queue.is_empty() {
                        let text = format!(
                            "{} did not start ({error}); the queued messages wait for the next one you send",
                            self.0.agent_name
                        );
                        self.emit(st, fx, json!({"type": "notice", "kind": "error", "text": text}));
                    }
                });
                Err(error)
            }
        }
    }

    /// A typed message: written now when the agent is idle, else held in
    /// Roamgate's queue until the turn ends. Ok: "sent" or "queued", and
    /// its id.
    pub async fn send(
        &self,
        text: &str,
        images: Vec<String>,
        uuid: Option<String>,
    ) -> Result<(&'static str, String), String> {
        let text = js::trim(text).to_owned();
        if text.is_empty() && images.is_empty() {
            return Err("Nothing to send".into());
        }
        enum Next {
            Done(&'static str, String),
            Drain(String),
            Deliver,
        }
        let next = self.with(|st, fx| {
            if let Some(uuid) = &uuid
                && !Self::take(st, uuid)
            {
                let queued = st.queue.iter().any(|each| s(each.get("id")) == uuid);
                return Next::Done(if queued { "queued" } else { "sent" }, uuid.clone());
            }
            let id = uuid.clone().unwrap_or_else(random_uuid);
            if !Self::ready(st) {
                let item = self.queued_item(id.clone(), &text, images.clone());
                st.queue.push(item);
                self.push_queue(st, fx);
                return Next::Done("queued", id);
            }
            if !st.queue.is_empty() {
                // Left from a start that failed: they go first, with this.
                let item = self.queued_item(id.clone(), &text, images.clone());
                st.queue.push(item);
                self.push_queue(st, fx);
                return Next::Drain(id);
            }
            Next::Deliver
        });
        match next {
            Next::Done(status, id) => Ok((status, id)),
            Next::Drain(id) => {
                let sent = self.drain_queue(Some(id.clone())).await;
                Ok((if sent { "sent" } else { "queued" }, id))
            }
            Next::Deliver => {
                let id = self.deliver(text, images, uuid, false).await?;
                Ok(("sent", id))
            }
        }
    }

    /// A spoken message, the barge-in mix (`session-voice.ts`): "stop"
    /// interrupts; while the agent writes reply text the turn is
    /// interrupted and the speech becomes the next turn; at any other
    /// point of a turn the speech steers it; a pending prompt leaves it
    /// queued. Ok: the action (`AgentChatVoiceAction`) and the message id.
    pub async fn voice(
        &self,
        text: &str,
        stop: bool,
        uuid: Option<String>,
    ) -> Result<(&'static str, Option<String>), String> {
        let text = js::trim(text).to_owned();
        if stop || is_spoken_stop(&text) {
            self.interrupt().await?;
            return Ok(("interrupted", None));
        }
        if text.is_empty() {
            return Err("Nothing to send".into());
        }
        enum Next {
            Done(&'static str, String),
            Deliver,
            Drain(String),
            Steer(String),
            Interrupt,
        }
        let next = self.with(|st, fx| {
            if let Some(uuid) = &uuid
                && !Self::take(st, uuid)
            {
                let queued = st.queue.iter().any(|each| s(each.get("id")) == uuid);
                return Next::Done(if queued { "queued" } else { "sent" }, uuid.clone());
            }
            if Self::ready(st) {
                if st.queue.is_empty() {
                    return Next::Deliver;
                }
                let id = uuid.clone().unwrap_or_else(random_uuid);
                let item = self.queued_item(id.clone(), &text, Vec::new());
                st.queue.push(item);
                self.push_queue(st, fx);
                return Next::Drain(id);
            }
            if !st.turn || !st.prompts.is_empty() || st.compacting {
                let id = uuid.clone().unwrap_or_else(random_uuid);
                let item = self.queued_item(id.clone(), &text, Vec::new());
                st.queue.push(item);
                self.push_queue(st, fx);
                return Next::Done("queued", id);
            }
            if !st.tools.is_empty() || st.last_block.as_deref() != Some("text") {
                let id = uuid.clone().unwrap_or_else(random_uuid);
                st.delivering += 1;
                return Next::Steer(id);
            }
            Next::Interrupt
        });
        match next {
            Next::Done(action, id) => Ok((action, Some(id))),
            Next::Deliver => {
                let id = self.deliver(text, Vec::new(), uuid, false).await?;
                Ok(("sent", Some(id)))
            }
            Next::Drain(id) => {
                let sent = self.drain_queue(Some(id.clone())).await;
                Ok((if sent { "sent" } else { "queued" }, Some(id)))
            }
            Next::Steer(id) => {
                let steered = self.steer(&text, &id).await;
                self.with(|st, _| st.delivering -= 1);
                steered
            }
            Next::Interrupt => {
                self.interrupt().await?;
                self.wait_for_result(self.o().interrupt_wait_ms).await;
                let id = self.deliver(text, Vec::new(), uuid, false).await?;
                Ok(("interrupted_then_sent", Some(id)))
            }
        }
    }

    async fn steer(&self, text: &str, id: &str) -> Result<(&'static str, Option<String>), String> {
        let message = self.user_message(text, &[], id, Vec::new(), true).await?;
        // The turn may have ended meanwhile: then it is a turn of its own.
        let running = self.with(|st, _| st.turn);
        if !running {
            let id = self
                .deliver(text.to_owned(), Vec::new(), Some(id.to_owned()), false)
                .await?;
            return Ok(("sent", Some(id)));
        }
        self.with(|st, _| {
            Self::write(st, &message)?;
            Self::remember(st, id, text, &[]);
            Ok::<_, String>(())
        })?;
        Ok(("steered", Some(id.to_owned())))
    }

    /// The model the process runs, as it last said.
    pub fn model(&self) -> Option<String> {
        self.with(|st, _| st.model.clone())
    }

    /// The name the user last switched it to (/model).
    pub fn chosen_model(&self) -> Option<String> {
        self.with(|st, _| st.chosen_model.clone())
    }

    /// The latest `(used_tokens, max_tokens)` context window usage reported by the agent.
    pub fn context_usage(&self) -> Option<(u64, u64)> {
        self.with(|st, _| st.context_usage)
    }

    /// A slash command the driver answers itself (`ProtocolDriver::command`),
    /// its notice; None: the line is the agent's. `run` runs a command
    /// line on the pane's host.
    pub async fn command(&self, text: &str, run: CommandRunner) -> Option<CommandNotice> {
        let driver = self.o().driver.clone();
        let context = SessionCommand {
            session: self.clone(),
            run,
        };
        let answer = driver.command(text, &context)?;
        Some(answer.await)
    }

    pub fn edit_queued(&self, id: &str, text: &str) -> bool {
        self.with(|st, fx| {
            let Some(item) = st.queue.iter_mut().find(|each| s(each.get("id")) == id) else {
                return false;
            };
            item.insert("text".into(), Value::from(js::trim(text)));
            self.push_queue(st, fx);
            true
        })
    }

    pub fn remove_queued(&self, id: &str) -> Option<Obj> {
        self.with(|st, fx| {
            let at = st.queue.iter().position(|each| s(each.get("id")) == id)?;
            let item = st.queue.remove(at);
            self.push_queue(st, fx);
            Some(item)
        })
    }

    pub fn queue_length(&self) -> usize {
        self.with(|st, _| st.queue.len())
    }

    /// The queue, emptied: kept elsewhere while no process holds it.
    pub fn take_queue(&self) -> Vec<Obj> {
        self.with(|st, _| std::mem::take(&mut st.queue))
    }

    /// Stops the process of an idle session (idle stop); false when it was
    /// not idle, or the process did not exit.
    pub async fn sleep_process(&self) -> bool {
        let idle = self.with(|st, fx| {
            if st.proc.is_none()
                || st.ending
                || st.starting.is_some()
                || st.stopping
                || st.disposed
                || Self::busy_now(st)
                || !st.queue.is_empty()
                || !st.tasks.is_empty()
            {
                return false;
            }
            st.asleep = true;
            if let Some(on_asleep) = self.o().on_asleep.clone() {
                fx.push(Box::new(move || on_asleep(true)));
            }
            true
        });
        if !idle {
            return false;
        }
        let stopped = self.stop_process().await;
        if !stopped {
            let id = self.session_id();
            self.log_now("an idle process did not stop", obj(json!({"session": id})));
        }
        stopped
    }

    /// Its process is stopped for being idle, until a message wakes it.
    pub fn asleep(&self) -> bool {
        self.with(|st, _| st.asleep)
    }

    /// When the process last said something, or a turn was written (ms).
    pub fn idle_since(&self) -> i64 {
        self.with(|st, _| st.last_activity)
    }

    /// Closes stdin and waits for the process to exit (a hand-back).
    pub async fn stop(&self) -> bool {
        self.with(|st, _| st.stopping = true);
        let stopped = self.stop_process().await;
        self.with(|st, _| st.stopping = false);
        stopped
    }

    /// Where the process's lines were handled to, with the state they
    /// left: what a runtime after this one takes up.
    pub fn resume_state(&self) -> ResumeState {
        self.with(|st, _| {
            if st.starting.is_some() || st.attaching || st.muted {
                return ResumeState::Unknown;
            }
            let Some(proc) = st.proc.clone() else {
                return ResumeState::None;
            };
            if st.ending || st.disposed {
                return ResumeState::None;
            }
            let Some(Some(position)) = proc.position() else {
                return ResumeState::None;
            };
            let prompts: Vec<Value> = st
                .deferred
                .values()
                .chain(st.asking.values())
                .cloned()
                .map(Value::Object)
                .collect();
            let recent: Vec<Value> = st
                .recent
                .iter()
                .map(|(uuid, (text, images))| json!([uuid, {"text": text, "images": images}]))
                .collect();
            let streamed: Vec<Value> = st.reply.snapshot().into_iter().map(Value::Object).collect();
            let state = obj(json!({
                "version": 1,
                "turn": st.turn,
                "compacting": st.compacting,
                "activity": st.activity,
                "last_block": st.last_block,
                "tools": st.tools.iter().collect::<Vec<_>>(),
                "tasks": st.tasks.iter().collect::<Vec<_>>(),
                "prompts": prompts,
                "next_prompt": st.next_prompt.clone().map(Value::Object).unwrap_or(Value::Null),
                "streamed": streamed,
                "turn_uuid": st.turn_uuid,
                "respawned_for_queue": st.respawned_for_queue,
                "taken": st.taken,
                "recent": recent,
                "parser": st.codec.save(),
            }));
            match kept_resume_state(state) {
                Some(state) => ResumeState::Saved { position, state },
                None => ResumeState::None,
            }
        })
    }

    /// Reads the process the holder runs for this session, if any; its
    /// turn, prompts and reply so far come back. False when none runs.
    pub async fn attach(&self) -> Result<bool, String> {
        if self.ensure_process(true).await?.is_none() {
            return Ok(false);
        }
        // Its state is known only once the lines that were in are handled.
        let caught_up = self.with(|st, _| st.caught_up.clone());
        caught_up.await;
        Ok(self.with(|st, fx| {
            if st.disposed {
                return false;
            }
            if !st.turn {
                self.flush_queue(fx);
            }
            true
        }))
    }

    /// `detach`: this runtime goes, but the process runs on in the holder.
    /// Otherwise it is ended.
    pub fn dispose(&self, detach: bool) {
        self.with(|st, fx| {
            st.disposed = true;
            if let Some((_, token)) = &st.spawn_abort {
                token.cancel();
            }
            self.flush_deltas(st, fx);
            for (_, token) in st.prompts.values() {
                token.cancel();
            }
            if let Some(proc) = &st.proc {
                if detach {
                    proc.detach();
                    return;
                }
                proc.end();
                proc.kill();
            }
        });
    }
}

/// The running process's control protocol, for the model and MCP drivers.
struct SessionControl {
    session: ConversationSession,
    child: Proc,
    wait_ms: u64,
}

impl ModelContext for SessionControl {
    fn control(&self, kind: &str, params: Object) -> BoxFuture<'_, Option<ControlAnswer>> {
        let kind = kind.to_owned();
        Box::pin(async move {
            self.session
                .control(&self.child, &kind, params, self.wait_ms)
                .await
        })
    }
}

/// What runs a command line for a driver's command: the line, its
/// timeout in ms.
pub type CommandRunner =
    Arc<dyn Fn(String, u64) -> BoxFuture<'static, Result<CommandOutput, String>> + Send + Sync>;

/// A driver's slash command in its session.
struct SessionCommand {
    session: ConversationSession,
    run: CommandRunner,
}

impl CommandContext for SessionCommand {
    fn control(&self, kind: &str, params: Object) -> BoxFuture<'_, Option<ControlAnswer>> {
        let kind = kind.to_owned();
        Box::pin(async move {
            let child = self.session.mcp_child().await.ok()?;
            let wait_ms = self.session.o().rewind_wait_ms;
            let answer = self.session.control(&child, &kind, params, wait_ms).await;
            self.session.after_mcp();
            answer
        })
    }

    fn run<'a>(
        &'a self,
        command: &'a str,
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<CommandOutput, String>> {
        (self.run)(command.to_owned(), timeout_ms)
    }

    fn context_usage(&self) -> Option<(u64, u64)> {
        self.session.context_usage()
    }

    fn model(&self) -> Option<String> {
        self.session.model()
    }
}

/// What a rewind needs of its session.
struct RewindSession(ConversationSession);

impl RewindContext for RewindSession {
    fn session_id(&self) -> String {
        self.0.session_id()
    }

    fn ensure_process(&self) -> BoxFuture<'_, Result<Arc<dyn HeadlessProcess>, String>> {
        Box::pin(async move {
            self.0
                .ensure_process(false)
                .await?
                .ok_or_else(|| format!("{} did not start", self.0.0.agent_name))
        })
    }

    fn stop_process(&self) -> BoxFuture<'_, bool> {
        self.0.stop_process()
    }

    fn control<'a>(
        &'a self,
        child: &'a Arc<dyn HeadlessProcess>,
        kind: &'a str,
        params: Object,
    ) -> BoxFuture<'a, Option<ControlAnswer>> {
        Box::pin(async move {
            self.0
                .control(child, kind, params, self.0.o().rewind_wait_ms)
                .await
        })
    }

    fn read_transcript(&self) -> Option<BoxFuture<'_, Result<Option<Transcript>, String>>> {
        self.0.o().read_transcript.as_ref().map(|read| read())
    }

    fn log(&self, message: &str, fields: Option<Object>) {
        self.0.log_now(message, fields.unwrap_or_default());
    }
}
