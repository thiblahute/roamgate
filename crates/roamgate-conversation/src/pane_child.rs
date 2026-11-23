//! Roamgate's end of one pane holder (`pane-child.ts`): the commands it has
//! not confirmed, where Roamgate is in its log, and the children found
//! there. Each child becomes a [`HeadlessProcess`] the conversation session
//! reads and writes as if it were its own; reading it again after a new
//! runtime (or a Roamgate restart) starts where the earlier one stopped,
//! the lines before that handed over as already seen (`replayed`).
//!
//! The holder speaks through the agent socket's long polls: each poll
//! brings its status ([`HolderStatus`], [`parse_holder_status`]) and takes
//! the commands Roamgate has for it ([`HolderChannel::work`]); its log comes
//! in chunks ([`HolderChannel::receive`]). An older holder (no API key
//! word, no input notes) is read the same way.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use roamgate_agents::js;
use serde_json::Value;
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

use crate::driver::{BoxFuture, HeadlessProcess, HolderPosition, InputKind};
use crate::shared::{LogFn, Obj};

/// Roamgate has read a holder's log this far: (holder id, offset).
pub type OffsetFn = Arc<dyn Fn(&str, u64) + Send + Sync>;
use crate::time::{SharedClock, sleep_ms};

/// What Roamgate asks of a pane's holder, numbered (`HolderCommand`):
/// `{op: "start" | "input" | "end" | "kill", ..., seq}`. The holder
/// applies each once, in order, and says which it applied last; until
/// then every poll answer carries it again.
pub type HolderCommand = Obj;

fn command_seq(command: &HolderCommand) -> u64 {
    command.get("seq").and_then(Value::as_u64).unwrap_or(0)
}

fn command_child(command: &HolderCommand) -> Option<u64> {
    command.get("child").and_then(Value::as_u64)
}

fn command_op(command: &HolderCommand) -> &str {
    command.get("op").and_then(Value::as_str).unwrap_or("")
}

/// What Claude Code answered about the pane's API key, as the holder read
/// it on its host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderApiKey {
    /// No key in the pane.
    None,
    Approved,
    Rejected,
    /// Never answered: the chat asks before a start.
    New,
}

impl HolderApiKey {
    pub fn as_str(self) -> &'static str {
        match self {
            HolderApiKey::None => "none",
            HolderApiKey::Approved => "approved",
            HolderApiKey::Rejected => "rejected",
            HolderApiKey::New => "new",
        }
    }
}

/// What a holder says of itself with each poll (`HolderStatus`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HolderStatus {
    /// A new id each time a holder starts: its log starts over with it.
    pub holder_id: String,
    /// The last command it applied.
    pub applied: u64,
    /// Its latest child's number (1, 2...; 0 before the first).
    pub child: u64,
    pub child_alive: bool,
    pub child_pid: u64,
    /// How long its log is, in bytes.
    pub log_size: u64,
    /// Where its latest child's lines start in the log.
    pub epoch_offset: u64,
    /// Absent from an older holder, which drops the key.
    pub api_key: Option<HolderApiKey>,
}

/// A holder's request form (`URLSearchParams`): the first value of a name.
#[derive(Clone, Debug, Default)]
pub struct Form {
    pairs: Vec<(String, String)>,
}

impl Form {
    /// An `application/x-www-form-urlencoded` body.
    pub fn parse(body: &str) -> Self {
        Self {
            pairs: url::form_urlencoded::parse(body.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect(),
        }
    }

    /// The agent socket's JSON body (`formOf`): an object's scalars as
    /// strings, nulls left out; None when it is not one.
    pub fn from_json(body: &str) -> Option<Self> {
        let parsed = if body.is_empty() {
            Value::Object(Obj::new())
        } else {
            js::parse(body)?
        };
        let mut pairs = Vec::new();
        for (key, value) in parsed.as_object()? {
            match value {
                Value::Null => continue,
                Value::Object(_) | Value::Array(_) => return None,
                other => pairs.push((key.clone(), js::to_text(other))),
            }
        }
        Some(Self { pairs })
    }

    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self {
            pairs: pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// A non-negative safe integer of a form's value (`Number(value)`).
fn integer(value: Option<&str>) -> Option<u64> {
    let value = value.filter(|value| !value.is_empty())?;
    let number = js::number_from_text(value);
    (js::is_safe_integer(number) && number >= 0.0).then_some(number as u64)
}

fn is_holder_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A holder's status from its poll; None from a holder without a child.
pub fn parse_holder_status(form: &Form) -> Option<HolderStatus> {
    let holder_id = form.get("holder_id").unwrap_or("");
    if !is_holder_id(holder_id) {
        return None;
    }
    Some(HolderStatus {
        holder_id: holder_id.to_owned(),
        applied: integer(form.get("applied"))?,
        child: integer(form.get("child"))?,
        child_alive: form.get("child_alive") == Some("1"),
        child_pid: integer(form.get("child_pid")).unwrap_or(0),
        log_size: integer(form.get("log_size"))?,
        epoch_offset: integer(form.get("epoch_offset"))?,
        api_key: match form.get("api_key") {
            None => None,
            Some("") => Some(HolderApiKey::None),
            Some("approved") => Some(HolderApiKey::Approved),
            Some("rejected") => Some(HolderApiKey::Rejected),
            Some("new") => Some(HolderApiKey::New),
            Some(_) => None,
        },
    })
}

/// Where a reader had handled a child's lines to, and the state they left
/// the conversation in (`HolderResume`).
#[derive(Clone, Debug, PartialEq)]
pub struct HolderResume {
    pub child: u64,
    /// Where that child's lines start in the log (its start line).
    pub epoch_offset: u64,
    /// Where the last line handled ends (a line's start).
    pub offset: u64,
    /// The conversation's state there (the session's resume state).
    pub state: Value,
}

/// What Roamgate had read of a holder's log, kept on the lease
/// (`HolderSaved`: `{id, offset, pending?, resume?}`).
#[derive(Clone, Debug, PartialEq)]
pub struct HolderSaved {
    pub id: String,
    pub offset: u64,
    pub pending: Vec<HolderCommand>,
    pub resume: Option<HolderResume>,
}

impl HolderSaved {
    /// Its JSON object, keys in Bun's order.
    pub fn to_value(&self) -> Value {
        let mut saved = Obj::new();
        saved.insert("id".into(), Value::String(self.id.clone()));
        saved.insert("offset".into(), Value::from(self.offset));
        if !self.pending.is_empty() {
            saved.insert(
                "pending".into(),
                Value::Array(self.pending.iter().cloned().map(Value::Object).collect()),
            );
        }
        if let Some(resume) = &self.resume {
            let mut value = Obj::new();
            value.insert("child".into(), Value::from(resume.child));
            value.insert("epoch_offset".into(), Value::from(resume.epoch_offset));
            value.insert("offset".into(), Value::from(resume.offset));
            value.insert("state".into(), resume.state.clone());
            saved.insert("resume".into(), Value::Object(value));
        }
        Value::Object(saved)
    }

    /// From a lease's JSON; None when it is not one.
    pub fn from_value(value: &Value) -> Option<Self> {
        let saved = value.as_object()?;
        let resume = saved
            .get("resume")
            .and_then(Value::as_object)
            .and_then(|resume| {
                Some(HolderResume {
                    child: resume.get("child")?.as_u64()?,
                    epoch_offset: resume.get("epoch_offset")?.as_u64()?,
                    offset: resume.get("offset")?.as_u64()?,
                    state: resume.get("state").cloned().unwrap_or(Value::Null),
                })
            });
        Some(Self {
            id: saved.get("id")?.as_str()?.to_owned(),
            offset: saved.get("offset")?.as_u64()?,
            pending: saved
                .get("pending")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_object().cloned())
                        .collect()
                })
                .unwrap_or_default(),
            resume,
        })
    }
}

/// Why the channel could not do what was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HolderError {
    pub message: String,
    /// The holder did not say its child ended when told to end it
    /// (`HolderChildStuck`): an older holder whose reader stopped (a full
    /// disk) reports a child alive for good, and takes no new one. Only
    /// the holder resuming the agent clears it.
    pub stuck: bool,
}

impl HolderError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stuck: false,
        }
    }
}

impl std::fmt::Display for HolderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HolderError {}

/// `HolderChildStuck`'s message.
pub const HOLDER_CHILD_STUCK: &str = "The pane holder did not end its conversation process";

/// What a given-up wait says.
const GAVE_UP: &str = "Gave up waiting for the pane holder";

struct EpochState {
    n: u64,
    pid: u64,
    /// Where its start line starts in the log.
    start: i64,
    buffer: std::collections::VecDeque<(String, i64)>,
    /// Where the last line its reader handled ends.
    handled: i64,
    /// The end of the line given last, handled once the next is asked for.
    given: Option<i64>,
    /// The state a reader before this one left it in.
    resume: Option<Value>,
    /// Lines at the head of `buffer` an earlier reader handled already.
    replayed: usize,
    code: Option<i32>,
    /// Where its exit line ends in the log.
    end_offset: Option<i64>,
    taken: bool,
    detached: bool,
    /// The user messages written to it that the agent never got.
    undelivered: Vec<String>,
    /// Its reader closed its input.
    ended: bool,
}

struct Epoch {
    state: Mutex<EpochState>,
    wake: Notify,
    exit: watch::Sender<Option<i32>>,
}

impl Epoch {
    fn new(n: u64, pid: u64, start: i64) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(EpochState {
                n,
                pid,
                start,
                buffer: Default::default(),
                handled: start,
                given: None,
                resume: None,
                replayed: 0,
                code: None,
                end_offset: None,
                taken: false,
                detached: false,
                undelivered: Vec::new(),
                ended: false,
            }),
            wake: Notify::new(),
            exit: watch::channel(None).0,
        })
    }

    fn n(&self) -> u64 {
        self.state.lock().unwrap().n
    }

    fn code(&self) -> Option<i32> {
        self.state.lock().unwrap().code
    }
}

/// An input written to a child, until the holder notes it as applied.
struct SentInput {
    child: u64,
    line: String,
    kind: String,
    dropped: bool,
}

struct State {
    saved: Option<HolderSaved>,
    id: Option<String>,
    status: Option<HolderStatus>,
    /// 0 until the holder said which command it applied last.
    next_seq: u64,
    pending: Vec<HolderCommand>,
    /// Where the holder sends from next; None until synced.
    expected: Option<i64>,
    /// The start of a line longer than one chunk, until its end comes.
    carry: String,
    /// Lines ending at or before this were handled by an earlier reader.
    boundary: i64,
    /// How long the log was when this reader started: caught up past it.
    target: i64,
    /// The holder should hear at once where to send its log from.
    announce: bool,
    last_epoch: u64,
    refusal: Option<String>,
    epochs: Vec<Arc<Epoch>>,
    /// The inputs written to children, by sequence number, until the
    /// holder notes them applied.
    sent: BTreeMap<u64, SentInput>,
}

/// What a channel tells its owner.
#[derive(Clone)]
pub struct HolderChannelOptions {
    pub pane_id: String,
    /// What a runtime before this one had read, if it was this holder.
    pub saved: Option<HolderSaved>,
    /// New commands wait: the holder's poll is answered now.
    pub on_work: Arc<dyn Fn() + Send + Sync>,
    /// Roamgate has read the holder's log this far.
    pub on_offset: Option<OffsetFn>,
    /// A command was added: what is unconfirmed should be saved now.
    pub on_pending: Option<Arc<dyn Fn() + Send + Sync>>,
    /// What the holder notes of a line written to a child (the agent's
    /// protocol driver's `input_kind`).
    pub input_kind: Arc<dyn Fn(&str) -> InputKind + Send + Sync>,
    pub log: Option<LogFn>,
    pub clock: SharedClock,
}

struct Inner {
    options: HolderChannelOptions,
    state: Mutex<State>,
    /// Something changed: waits check again.
    changed: Notify,
}

/// Roamgate's end of one pane holder (`createHolderChannel`). Cheap to
/// clone.
#[derive(Clone)]
pub struct HolderChannel {
    inner: Arc<Inner>,
}

fn byte_len(text: &str) -> i64 {
    text.len() as i64
}

/// The work a poll answer carries: commands, and where to send from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HolderWork {
    pub commands: Option<Vec<HolderCommand>>,
    pub output_from: Option<i64>,
}

/// A chunk of the holder's log.
#[derive(Clone, Debug)]
pub struct HolderOutput<'a> {
    pub holder_id: &'a str,
    pub offset: i64,
    pub end: i64,
    pub data: &'a str,
}

/// What a holder's start is asked.
pub struct HolderSpawn {
    pub command: Obj,
    pub attach_only: bool,
    pub signal: Option<CancellationToken>,
    /// 30 s by default.
    pub timeout_ms: Option<u64>,
}

impl HolderChannel {
    pub fn new(options: HolderChannelOptions) -> Self {
        let saved = options.saved.clone();
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State {
                    saved,
                    id: None,
                    status: None,
                    next_seq: 0,
                    pending: Vec::new(),
                    expected: None,
                    carry: String::new(),
                    boundary: 0,
                    target: 0,
                    announce: false,
                    last_epoch: 0,
                    refusal: None,
                    epochs: Vec::new(),
                    sent: BTreeMap::new(),
                }),
                changed: Notify::new(),
            }),
        }
    }

    pub fn pane_id(&self) -> &str {
        &self.inner.options.pane_id
    }

    fn log(&self, message: &str, fields: Obj) {
        if let Some(log) = &self.inner.options.log {
            log(message, fields);
        }
    }

    fn changed(&self) {
        self.inner.changed.notify_waiters();
    }

    /// Waits until `check` holds (true), `timeout_ms` passed (false), or
    /// the signal gave up (an error).
    async fn wait_for(
        &self,
        check: impl Fn(&State) -> bool,
        timeout_ms: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<bool, HolderError> {
        let timer = sleep_ms(&*self.inner.options.clock, timeout_ms);
        tokio::pin!(timer);
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if check(&self.inner.state.lock().unwrap()) {
                return Ok(true);
            }
            if signal.is_some_and(CancellationToken::is_cancelled) {
                return Err(HolderError::new(GAVE_UP));
            }
            let cancelled = async {
                match signal {
                    Some(signal) => signal.cancelled().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                () = &mut notified => {}
                () = &mut timer => return Ok(false),
                () = cancelled => return Err(HolderError::new(GAVE_UP)),
            }
        }
    }

    /// `exited`: its exit line was read, so an input not noted before it
    /// is one the holder drops. Otherwise (its holder is gone) only the
    /// inputs it never confirmed count as not delivered.
    fn finish_epoch(
        state: &mut State,
        epoch: &Arc<Epoch>,
        code: i32,
        end_offset: Option<i64>,
        exited: bool,
    ) {
        let mut cell = epoch.state.lock().unwrap();
        if cell.code.is_some() {
            return;
        }
        let n = cell.n;
        let unconfirmed: Vec<u64> = state
            .pending
            .iter()
            .filter(|command| command_child(command) == Some(n))
            .map(command_seq)
            .collect();
        let seqs: Vec<u64> = state
            .sent
            .iter()
            .filter(|(_, input)| input.child == n)
            .map(|(seq, _)| *seq)
            .collect();
        for seq in seqs {
            let input = state.sent.remove(&seq).unwrap();
            if input.kind == "user" && (input.dropped || exited || unconfirmed.contains(&seq)) {
                cell.undelivered.push(input.line);
            }
        }
        // What is still to be sent to it would only be dropped.
        state
            .pending
            .retain(|command| command_op(command) == "start" || command_child(command) != Some(n));
        cell.code = Some(code);
        cell.end_offset = end_offset;
        let taken = cell.taken;
        drop(cell);
        epoch.exit.send_replace(Some(code));
        epoch.wake.notify_waiters();
        // Read to its end by its reader: nothing more is kept of it.
        if taken {
            state.epochs.retain(|each| !Arc::ptr_eq(each, epoch));
        }
    }

    /// Another holder in the pane: the earlier one's children are gone.
    fn reset(&self, state: &mut State, next: &HolderStatus) {
        for epoch in std::mem::take(&mut state.epochs) {
            Self::finish_epoch(state, &epoch, -1, None, false);
        }
        state.epochs.clear();
        let carried = state
            .saved
            .take()
            .filter(|saved| saved.id == next.holder_id);
        state.id = Some(next.holder_id.clone());
        state.pending = carried
            .as_ref()
            .map(|carried| {
                carried
                    .pending
                    .iter()
                    .filter(|command| command_seq(command) > next.applied)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        state.sent.clear();
        for command in &state.pending {
            if command_op(command) == "input"
                && let (Some(child), Some(line)) = (
                    command_child(command),
                    command.get("line").and_then(Value::as_str),
                )
            {
                state.sent.insert(
                    command_seq(command),
                    SentInput {
                        child,
                        line: line.to_owned(),
                        kind: command
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("other")
                            .to_owned(),
                        dropped: false,
                    },
                );
            }
        }
        state.next_seq = state
            .pending
            .iter()
            .map(command_seq)
            .fold(next.applied, u64::max)
            + 1;
        state.last_epoch = 0;
        state.refusal = None;
        // The latest child, still the one an earlier reader had handled to
        // a point: read on from that point, with the state it left.
        if let Some(resume) = carried.as_ref().and_then(|carried| carried.resume.as_ref())
            && resume.child == next.child
            && next.child > 0
            && resume.epoch_offset == next.epoch_offset
            && resume.offset >= next.epoch_offset
            && resume.offset <= next.log_size
        {
            let epoch = Epoch::new(resume.child, next.child_pid, resume.epoch_offset as i64);
            {
                let mut cell = epoch.state.lock().unwrap();
                cell.handled = resume.offset as i64;
                cell.resume = Some(resume.state.clone());
            }
            state.epochs.push(epoch);
            state.last_epoch = resume.child;
            state.expected = Some(resume.offset as i64);
            state.carry.clear();
            state.boundary = resume.offset as i64;
            state.target = next.log_size as i64;
            state.announce = true;
            let mut fields = Obj::new();
            fields.insert("pane".into(), Value::from(self.pane_id()));
            fields.insert("from".into(), Value::from(resume.offset));
            fields.insert("resumed".into(), Value::Bool(true));
            fields.insert("size".into(), Value::from(next.log_size));
            self.log("reading the pane holder's log", fields);
            return;
        }
        // Read again from the latest child's start (or from where an
        // earlier reader stopped, if before); what was read is replayed.
        let offset = carried
            .as_ref()
            .map(|carried| carried.offset.min(next.log_size))
            .unwrap_or(next.log_size) as i64;
        state.expected = Some(offset.min(next.epoch_offset as i64));
        state.carry.clear();
        state.boundary = offset;
        state.target = next.log_size as i64;
        state.announce = true;
        let mut fields = Obj::new();
        fields.insert("pane".into(), Value::from(self.pane_id()));
        fields.insert("from".into(), Value::from(state.expected.unwrap_or(0)));
        fields.insert("seen".into(), Value::from(offset));
        fields.insert("size".into(), Value::from(next.log_size));
        self.log("reading the pane holder's log", fields);
    }

    fn line(state: &mut State, text: &str, end: i64) {
        if text.starts_with("{\"type\":\"roamgate_child\"") {
            let Some(Value::Object(marker)) = js::parse(text) else {
                return;
            };
            let event = marker.get("event").and_then(Value::as_str);
            let child = marker.get("child").and_then(Value::as_f64);
            match event {
                Some("start") if child.is_some() => {
                    let child = child.unwrap_or(0.0) as u64;
                    let open: Vec<Arc<Epoch>> = state
                        .epochs
                        .iter()
                        .filter(|epoch| epoch.code().is_none())
                        .cloned()
                        .collect();
                    for epoch in open {
                        Self::finish_epoch(state, &epoch, -1, None, false);
                    }
                    let pid = marker.get("pid").and_then(Value::as_f64).unwrap_or(0.0) as u64;
                    let epoch = Epoch::new(child, pid, end - byte_len(text) - 1);
                    epoch.state.lock().unwrap().handled = end;
                    state.epochs.push(epoch);
                    state.last_epoch = state.last_epoch.max(child);
                }
                Some("exit") => {
                    let found = state
                        .epochs
                        .iter()
                        .find(|epoch| Some(epoch.n() as f64) == child)
                        .cloned();
                    if let Some(epoch) = found {
                        let code =
                            marker.get("code").and_then(Value::as_f64).unwrap_or(-1.0) as i32;
                        Self::finish_epoch(state, &epoch, code, Some(end), true);
                    }
                }
                Some("refused") if end > state.boundary => {
                    state.refusal = Some(
                        marker
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("The pane holder did not start Claude")
                            .to_owned(),
                    );
                }
                _ => {}
            }
            return;
        }
        if text.starts_with("{\"type\":\"roamgate_input\"") {
            Self::noted(state, text);
        }
        let last = state.last_epoch;
        let Some(epoch) = state
            .epochs
            .iter()
            .find(|epoch| {
                let cell = epoch.state.lock().unwrap();
                cell.n == last && cell.code.is_none()
            })
            .cloned()
        else {
            return;
        };
        let mut cell = epoch.state.lock().unwrap();
        cell.buffer.push_back((text.to_owned(), end));
        if end <= state.boundary && !cell.taken {
            cell.replayed += 1;
        }
        drop(cell);
        epoch.wake.notify_waiters();
    }

    /// The holder noted an input: written to its child, or dropped.
    fn noted(state: &mut State, text: &str) {
        let Some(Value::Object(note)) = js::parse(text) else {
            return;
        };
        let Some(seq) = note.get("seq").and_then(Value::as_f64) else {
            return;
        };
        let seq = seq as u64;
        let dropped = note.get("dropped").is_some_and(crate::herdr::js_truthy);
        if dropped {
            if let Some(input) = state.sent.get_mut(&seq) {
                input.dropped = true;
            }
        } else {
            state.sent.remove(&seq);
        }
    }

    fn enqueue(&self, command: Obj) -> Result<u64, HolderError> {
        let seq = {
            let mut state = self.inner.state.lock().unwrap();
            if state.next_seq == 0 || state.id.is_none() {
                return Err(HolderError::new("The pane holder is not connected"));
            }
            let seq = state.next_seq;
            state.next_seq += 1;
            let mut command = command;
            command.insert("seq".into(), Value::from(seq));
            if command_op(&command) == "input"
                && let (Some(child), Some(line)) = (
                    command_child(&command),
                    command.get("line").and_then(Value::as_str),
                )
            {
                state.sent.insert(
                    seq,
                    SentInput {
                        child,
                        line: line.to_owned(),
                        kind: command
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("other")
                            .to_owned(),
                        dropped: false,
                    },
                );
            }
            state.pending.push(command);
            seq
        };
        if let Some(on_pending) = &self.inner.options.on_pending {
            on_pending();
        }
        (self.inner.options.on_work)();
        Ok(seq)
    }

    fn adapter(&self, state: &mut State, epoch: Arc<Epoch>) -> Arc<dyn HeadlessProcess> {
        let (replayed, catch_up, resume, ended) = {
            let mut cell = epoch.state.lock().unwrap();
            cell.taken = true;
            cell.ended = cell.code.is_some();
            (
                cell.replayed,
                cell.buffer.len(),
                cell.resume.take(),
                cell.ended,
            )
        };
        let _ = ended;
        if epoch.code().is_some() {
            state.epochs.retain(|each| !Arc::ptr_eq(each, &epoch));
        }
        Arc::new(HolderProcess {
            channel: self.clone(),
            epoch,
            replayed,
            catch_up,
            resume,
        })
    }

    /// The holder's id, once one polled.
    pub fn holder_id(&self) -> Option<String> {
        self.inner.state.lock().unwrap().id.clone()
    }

    /// Its status as it last said.
    pub fn status(&self) -> Option<HolderStatus> {
        self.inner.state.lock().unwrap().status.clone()
    }

    /// A holder polled: its status is recorded, its acks drop commands.
    pub fn update(&self, next: HolderStatus) {
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.id.as_deref() != Some(next.holder_id.as_str()) {
                self.reset(&mut state, &next);
            }
            state
                .pending
                .retain(|command| command_seq(command) > next.applied);
            state.status = Some(next);
        }
        self.changed();
    }

    /// Whether a poll should be answered at once.
    pub fn has_work(&self) -> bool {
        let state = self.inner.state.lock().unwrap();
        !state.pending.is_empty() || state.announce
    }

    /// What a poll answer carries: commands, and where to send from.
    pub fn work(&self) -> HolderWork {
        let mut state = self.inner.state.lock().unwrap();
        state.announce = false;
        HolderWork {
            commands: (!state.pending.is_empty()).then(|| state.pending.clone()),
            output_from: state.expected,
        }
    }

    /// Lines of the holder's log from `offset` to `end`. Taken only when
    /// they follow what was read (else the holder is told where to send
    /// from), so each is read once. The answer's offset, if any.
    pub fn receive(&self, input: HolderOutput<'_>) -> Option<i64> {
        let (answer, offset_note) = {
            let mut state = self.inner.state.lock().unwrap();
            let expected = state.expected?;
            if state.id.as_deref() != Some(input.holder_id) {
                return None;
            }
            if input.offset != expected || input.end < input.offset {
                return Some(expected);
            }
            let mut at = input.offset;
            let mut parts: Vec<&str> = input.data.split('\n').collect();
            // The text after the last newline: empty, or a piece of a line
            // too long for one chunk, kept until the rest comes.
            let rest = parts.pop().unwrap_or("");
            let many = !parts.is_empty();
            for (index, part) in parts.into_iter().enumerate() {
                at += byte_len(part) + 1;
                let text = if index == 0 {
                    format!("{}{part}", state.carry)
                } else {
                    part.to_owned()
                };
                if !text.is_empty() {
                    Self::line(&mut state, &text, at.min(input.end));
                }
            }
            if many {
                state.carry = rest.to_owned();
            } else {
                state.carry.push_str(rest);
            }
            state.expected = Some(input.end);
            let note = state
                .id
                .clone()
                .map(|id| (id, (input.end - byte_len(&state.carry)) as u64));
            (input.end, note)
        };
        if let (Some(on_offset), Some((id, offset))) = (&self.inner.options.on_offset, offset_note)
        {
            on_offset(&id, offset);
        }
        self.changed();
        Some(answer)
    }

    fn synced(state: &State) -> bool {
        state.id.is_some()
            && state
                .expected
                .is_some_and(|expected| expected >= state.target)
    }

    /// The pane's headless agent: the oldest child not read yet (one that
    /// runs, or one that ended while nobody read), else, unless only
    /// attaching, a new one the holder starts.
    pub async fn spawn(
        &self,
        spawn: HolderSpawn,
    ) -> Result<Option<Arc<dyn HeadlessProcess>>, HolderError> {
        let timeout_ms = spawn.timeout_ms.unwrap_or(30_000);
        let signal = spawn.signal.as_ref();
        // A long log over a slow link takes a while: given up only when
        // nothing more comes for a whole timeout.
        let mut caught_up;
        loop {
            let from = self.inner.state.lock().unwrap().expected;
            caught_up = self.wait_for(Self::synced, timeout_ms, signal).await?;
            let expected = self.inner.state.lock().unwrap().expected;
            if caught_up || expected.is_none() || expected == from {
                break;
            }
        }
        if !caught_up {
            let connected = self.inner.state.lock().unwrap().id.is_some();
            return Err(HolderError::new(if connected {
                "The pane holder's log could not be read"
            } else {
                "The pane holder is not connected"
            }));
        }
        let before = {
            let mut state = self.inner.state.lock().unwrap();
            // Children that ended before the earlier reader stopped: done.
            let boundary = state.boundary;
            state.epochs.retain(|epoch| {
                let cell = epoch.state.lock().unwrap();
                cell.taken
                    || cell.code.is_none()
                    || cell.end_offset.is_none_or(|end| end > boundary)
            });
            let ready = state
                .epochs
                .iter()
                .find(|epoch| !epoch.state.lock().unwrap().taken)
                .cloned();
            if let Some(ready) = ready {
                return Ok(Some(self.adapter(&mut state, ready)));
            }
            if spawn.attach_only {
                return Ok(None);
            }
            if state.epochs.iter().any(|epoch| epoch.code().is_none()) {
                return Err(HolderError::new(
                    "The pane holder still runs a conversation process",
                ));
            }
            state.refusal = None;
            state.last_epoch
        };
        let mut command = Obj::new();
        command.insert("op".into(), Value::from("start"));
        for (key, value) in spawn.command {
            command.insert(key, value);
        }
        self.enqueue(command)?;
        let started = self
            .wait_for(
                |state| state.last_epoch > before || state.refusal.is_some(),
                timeout_ms,
                signal,
            )
            .await?;
        let mut state = self.inner.state.lock().unwrap();
        if let Some(refusal) = state.refusal.clone() {
            return Err(HolderError::new(refusal));
        }
        let epoch = state
            .epochs
            .iter()
            .find(|each| {
                let cell = each.state.lock().unwrap();
                cell.n > before && !cell.taken
            })
            .cloned();
        match (started, epoch) {
            (true, Some(epoch)) => Ok(Some(self.adapter(&mut state, epoch))),
            _ => Err(HolderError::new(
                "The pane holder did not start Claude in time",
            )),
        }
    }

    /// Gives up on the log as it stands (it cannot be read): the holder
    /// ends its child, and reading goes on from the log's end once it has.
    /// The session carries on in a new child (the agent resumed).
    pub async fn abandon(
        &self,
        timeout_ms: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<(), HolderError> {
        let (holder, alive, child) = {
            let state = self.inner.state.lock().unwrap();
            match (&state.id, &state.status) {
                (Some(id), Some(status)) => (id.clone(), status.child_alive, status.child),
                _ => return Err(HolderError::new("The pane holder is not connected")),
            }
        };
        if alive {
            let mut kill = Obj::new();
            kill.insert("op".into(), Value::from("kill"));
            kill.insert("child".into(), Value::from(child));
            self.enqueue(kill)?;
            let ended = self
                .wait_for(
                    |state| {
                        state.id.as_deref() != Some(holder.as_str())
                            || !state
                                .status
                                .as_ref()
                                .is_some_and(|status| status.child_alive)
                    },
                    timeout_ms,
                    signal,
                )
                .await?;
            if self.inner.state.lock().unwrap().id.as_deref() != Some(holder.as_str()) {
                return Err(HolderError::new("Another pane holder took over; try again"));
            }
            if !ended {
                return Err(HolderError {
                    message: HOLDER_CHILD_STUCK.into(),
                    stuck: true,
                });
            }
        }
        let end = {
            let mut state = self.inner.state.lock().unwrap();
            for epoch in std::mem::take(&mut state.epochs) {
                Self::finish_epoch(&mut state, &epoch, -1, None, false);
            }
            state.epochs.clear();
            let end = state
                .status
                .as_ref()
                .map(|status| status.log_size)
                .unwrap_or(0) as i64;
            state.expected = Some(end);
            state.carry.clear();
            state.boundary = end;
            state.target = end;
            let child = state
                .status
                .as_ref()
                .map(|status| status.child)
                .unwrap_or(0);
            state.last_epoch = state.last_epoch.max(child);
            state.refusal = None;
            state.announce = true;
            end
        };
        let mut fields = Obj::new();
        fields.insert("pane".into(), Value::from(self.pane_id()));
        fields.insert("from".into(), Value::from(end));
        self.log("reading the pane holder's log from its end", fields);
        if let Some(on_offset) = &self.inner.options.on_offset {
            on_offset(&holder, end as u64);
        }
        (self.inner.options.on_work)();
        self.changed();
        Ok(())
    }

    /// Whether the holder runs a child now (as it last said).
    pub fn child_alive(&self) -> bool {
        let state = self.inner.state.lock().unwrap();
        state.epochs.iter().any(|epoch| epoch.code().is_none())
            || state
                .status
                .as_ref()
                .is_some_and(|status| status.child_alive)
    }

    /// What a runtime after this one needs to read on.
    pub fn save(&self) -> Option<HolderSaved> {
        let state = self.inner.state.lock().unwrap();
        let (Some(id), Some(expected)) = (&state.id, state.expected) else {
            return None;
        };
        Some(HolderSaved {
            id: id.clone(),
            offset: (expected - byte_len(&state.carry)).max(0) as u64,
            pending: state.pending.clone(),
            resume: None,
        })
    }

    /// Stops every reader: the holder and its child keep running.
    pub fn detach(&self) {
        let epochs = self.inner.state.lock().unwrap().epochs.clone();
        for epoch in epochs {
            epoch.state.lock().unwrap().detached = true;
            epoch.wake.notify_waiters();
        }
    }
}

/// One child of a holder, as the session reads and writes it.
struct HolderProcess {
    channel: HolderChannel,
    epoch: Arc<Epoch>,
    replayed: usize,
    catch_up: usize,
    resume: Option<Value>,
}

impl HeadlessProcess for HolderProcess {
    fn next_line(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            loop {
                let woken = self.epoch.wake.notified();
                tokio::pin!(woken);
                woken.as_mut().enable();
                {
                    let mut cell = self.epoch.state.lock().unwrap();
                    // Asked for the next one: the one given last was handled.
                    if let Some(end) = cell.given.take() {
                        cell.handled = end;
                    }
                    if cell.detached {
                        return None;
                    }
                    if let Some((line, end)) = cell.buffer.pop_front() {
                        cell.given = Some(end);
                        return Some(line);
                    }
                    if cell.code.is_some() {
                        return None;
                    }
                }
                woken.await;
            }
        })
    }

    fn write(&self, text: &str) -> Result<(), String> {
        let n = {
            let cell = self.epoch.state.lock().unwrap();
            if cell.ended || cell.code.is_some() {
                return Err("The Claude Code process is closing".into());
            }
            cell.n
        };
        let line = text.strip_suffix('\n').unwrap_or(text);
        let kind = (self.channel.inner.options.input_kind)(line);
        let mut command = Obj::new();
        command.insert("op".into(), Value::from("input"));
        command.insert("child".into(), Value::from(n));
        command.insert("line".into(), Value::from(line));
        command.insert("kind".into(), Value::from(kind.kind));
        if let Some(request_id) = kind.request_id {
            command.insert("request_id".into(), Value::from(request_id));
        }
        self.channel
            .enqueue(command)
            .map(drop)
            .map_err(|error| error.message)
    }

    fn end(&self) {
        let (n, open) = {
            let mut cell = self.epoch.state.lock().unwrap();
            if cell.ended {
                return;
            }
            cell.ended = true;
            (cell.n, cell.code.is_none())
        };
        if open {
            let mut command = Obj::new();
            command.insert("op".into(), Value::from("end"));
            command.insert("child".into(), Value::from(n));
            let _ = self.channel.enqueue(command);
        }
    }

    fn kill(&self) {
        let (n, open) = {
            let cell = self.epoch.state.lock().unwrap();
            (cell.n, cell.code.is_none())
        };
        if open {
            let mut command = Obj::new();
            command.insert("op".into(), Value::from("kill"));
            command.insert("child".into(), Value::from(n));
            let _ = self.channel.enqueue(command);
        }
    }

    fn exited(&self) -> BoxFuture<'_, i32> {
        let mut receiver = self.epoch.exit.subscribe();
        Box::pin(async move {
            loop {
                if let Some(code) = *receiver.borrow_and_update() {
                    return code;
                }
                if receiver.changed().await.is_err() {
                    return -1;
                }
            }
        })
    }

    fn pid(&self) -> Option<u32> {
        let pid = self.epoch.state.lock().unwrap().pid;
        (pid != 0).then_some(pid as u32)
    }

    fn replayed(&self) -> usize {
        self.replayed
    }

    fn catch_up(&self) -> usize {
        self.catch_up
    }

    fn undelivered(&self) -> Option<Vec<String>> {
        Some(self.epoch.state.lock().unwrap().undelivered.clone())
    }

    fn resume(&self) -> Option<Value> {
        self.resume.clone()
    }

    fn position(&self) -> Option<Option<HolderPosition>> {
        let cell = self.epoch.state.lock().unwrap();
        Some(
            (cell.code.is_none() && !cell.detached).then(|| HolderPosition {
                child: cell.n,
                epoch_offset: cell.start.max(0) as u64,
                offset: cell.handled.max(0) as u64,
            }),
        )
    }

    fn detach(&self) {
        self.epoch.state.lock().unwrap().detached = true;
        self.epoch.wake.notify_waiters();
    }
}

#[cfg(test)]
mod tests;

#[cfg(all(test, unix))]
mod holder_tests;
