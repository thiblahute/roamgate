//! /api/voice/ws (server/src/http/voice-socket.ts, createVoiceSocket): a
//! browser streams its microphone to the voice helper and hears back when
//! speech starts and what was said; a call's WebRTC signalling is fronted
//! to the helper's signalling server; the Android app carries a call
//! handed to it. docs/ARCHITECTURE.md tells the protocol; this module
//! keeps Bun's messages, timings and order.
//!
//! A session outlives its socket: detached, it waits DETACHED_MS for a
//! `resume` on a new socket, then ends the utterance with what was heard
//! and keeps its text KEPT_MS. A socket that sends no audio for STALL_MS
//! while listening is taken as gone the same way. A dictation (`"mode":
//! "dictation"`) is one text over as many of the helper's utterances as its
//! pauses make, its final within FINISH_DEADLINE_MS of `finish`.
//!
//! Everything the socket is told (messages, closes, the helper's events,
//! timers, the signalling server's sockets) runs one at a time, to its
//! end, as Bun's event loop runs it: a call from outside handles it at
//! once, one made while another runs is queued behind it. Timers run on
//! the socket's clock (the test clock in tests). The companion layer is
//! reached through [`companion::Companion`], the helper through
//! [`SocketHelper`].

mod cap;
pub mod companion;
mod seam;
pub mod signalling;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use base64::Engine as _;
use indexmap::IndexMap;
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger};
use roamgate_base::paths::random_uuid;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub use cap::{
    QUESTION_PAUSE_MS, SURE_PAUSE_MS, SilenceCap, TURN_SOUNDS_FINISHED, TURN_SURELY_FINISHED,
    ends_with_filler, ends_with_question,
};
pub use seam::{CallLine, Listen, SocketHelper};

use crate::config::{CALL_REPLY_LOUDNESS, CallBackground, max_pause_ms};
use crate::helper::{ErrorSink, EventSink, ListenOptions};
use crate::js;
use companion::{CleanSession, Companion, Dictated, DictationSession, NoCompanion};
use signalling::{
    ConnectUpstream, SIGNALLING_QUEUE, UpstreamEvent, UpstreamSocket, rewrite_candidates,
};

/// How long a session whose socket went waits for it to come back.
pub const DETACHED_MS: u64 = 20_000;
/// How long what a detached session heard is kept, once it ended.
pub const KEPT_MS: u64 = 120_000;
/// No audio this long from a socket that listens: it is gone.
pub const STALL_MS: u64 = 5_000;
/// How long a handoff token may be redeemed.
pub const HANDOFF_MS: u64 = 60_000;
/// How long after the helper's server closed its replies are watched again.
pub const REPLIES_WATCH_RETRY_MS: u64 = 1000;
/// The page's ICE lines (`call_ice`) logged for one call, at most.
pub const CALL_ICE_LINES: usize = 200;
/// The longest ICE line kept, in UTF-16 units.
const CALL_ICE_CHARS: i64 = 2000;
/// After a dictation's `finish`, its final (or an error) comes within this.
pub const FINISH_DEADLINE_MS: u64 = 15_000;
/// While the helper loads its listening models, a finished dictation waits
/// this long for them, then FINISH_DEADLINE_MS.
pub const LOADING_DEADLINE_MS: u64 = 90_000;
/// A dictation's final when nothing was heard: an error the client shows.
pub const NOTHING_HEARD: &str = "Nothing was heard";
/// A dictation's pauses never end it: the client says when it is over.
const DICTATION_END_SILENCE_MS: f64 = 10_000.0;
/// The reason given to a call a newer one stops.
const REPLACED_CALL: &str = "Replaced by a newer call";
/// The context the voice chat's cleaner is given, at most (UTF-16 units).
const CONTEXT_CHARS: i64 = 4000;
/// What of a call the Android app may carry instead of the page.
const CARRIED_LEGS: [&str; 2] = ["microphone", "replies"];
/// What an output may be, as the page draws it (CallOutputKind).
const OUTPUT_KINDS: [&str; 6] = [
    "speaker",
    "earpiece",
    "bluetooth",
    "bluetooth-music",
    "wired",
    "usb",
];

/// A browser's (or the Android app's) socket on /api/voice/ws.
pub trait VoicePeer: Send + Sync {
    fn send(&self, text: String);
}

/// A page's signalling socket on /api/voice/call/signalling.
pub trait SignallingPeer: Send + Sync {
    fn send(&self, text: String);
    fn close(&self, code: u16, reason: &str);
}

pub type Peer = Arc<dyn VoicePeer>;
pub type SignallingSocket = Arc<dyn SignallingPeer>;

/// A socket's identity: the address of what it points to.
fn key_of<T: ?Sized>(peer: &Arc<T>) -> usize {
    Arc::as_ptr(peer).cast::<()>() as usize
}

/// A listen request's `language`: two lowercase letters, else none.
pub fn listen_language(value: Option<&Value>) -> Option<String> {
    let language = value?.as_str()?;
    (language.len() == 2 && language.bytes().all(|byte| byte.is_ascii_lowercase()))
        .then(|| language.to_owned())
}

/// A 256-bit random token, URL-safe.
fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// What a whole JSON number is, as a u64.
fn whole(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    (number >= 0.0 && number.fract() == 0.0 && number < 9.007_199_254_740_992e15)
        .then_some(number as u64)
}

/// `value === id` for a call's or a session's number.
fn is_id(value: Option<&Value>, id: u64) -> bool {
    value.and_then(Value::as_f64) == Some(id as f64)
}

fn text_of(value: &Map<String, Value>, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `{"key": value}` keys whose value is `undefined` in Bun are left out.
fn put(message: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        message.insert(key.into(), value.clone());
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn stringify(message: &Map<String, Value>) -> String {
    js::stringify(&Value::Object(message.clone()))
}

fn send(peer: Option<&Peer>, message: Value) {
    if let Some(peer) = peer {
        peer.send(js::stringify(&message));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What the socket reads and calls besides the helper.
pub struct VoiceSocketOptions {
    pub companion: Arc<dyn Companion>,
    /// voice.json's `max_pause_ms`, read at each listen.
    pub max_pause: Arc<dyn Fn() -> Option<Value> + Send + Sync>,
    /// voice.json's call background, read as a call starts.
    pub background: Arc<dyn Fn() -> Option<CallBackground> + Send + Sync>,
    /// voice.json's `call_ice_address`, read as each signalling opens.
    pub ice_address: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Opens a socket to the helper's signalling server.
    pub connect_upstream: ConnectUpstream,
    /// A call is over, for good: not replaced by a newer one.
    pub on_call_ended: Arc<dyn Fn() + Send + Sync>,
    pub clock: SharedClock,
    /// The voice's timing lines (the server's logger, child `voice`).
    pub log: Logger,
    /// Lines always written to the server's stderr (the page's ICE lines).
    pub errors: ErrorSink,
    /// ROAMGATE_VOICE_DEBUG's lines, when it is set.
    pub debug: Option<ErrorSink>,
}

impl VoiceSocketOptions {
    pub fn new(clock: SharedClock) -> Self {
        Self {
            companion: Arc::new(NoCompanion),
            max_pause: Arc::new(|| None),
            background: Arc::new(|| None),
            ice_address: Arc::new(|| None),
            connect_upstream: signalling::connect_upstream(),
            on_call_ended: Arc::new(|| {}),
            clock,
            log: Logger::silent(),
            errors: Arc::new(|line| eprintln!("{line}")),
            debug: None,
        }
    }
}

/// A handoff exchanged for the call's carrier token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redeemed {
    pub call: u64,
    pub carrier: String,
}

/// The Android app carrying a call (call_carry), or about to.
struct Carrier {
    serial: u64,
    token: String,
    ws: Option<Peer>,
    legs: Vec<&'static str>,
    /// It sent call_carry: the page was told it took its legs.
    joined: bool,
    /// The helper listens to its microphone.
    heard: bool,
    /// Its last call_output_state, as relayed to the page.
    outputs: Option<Map<String, Value>>,
    /// The replies producer it was last told.
    told_peer: Option<String>,
    /// Never joined, or its socket gone: it lets the call go.
    timer: Option<u64>,
}

/// A listener on the call's signalling server: it learns the peer id of the
/// helper's replies producer, for the Android app to consume it by id.
struct Watch {
    upstream_key: u64,
    upstream: Arc<dyn UpstreamSocket>,
    peer: Option<String>,
}

/// A call, and the socket that owns it, if any. Stopped calls are gone
/// from the socket's calls.
struct CallState {
    carrier: Option<Carrier>,
    handle: Option<Arc<dyn CallLine>>,
    token: String,
    ws: Option<Peer>,
    timer: Option<u64>,
    /// Times a restarted helper made it again: told on call_resume too.
    restarts: u64,
    /// The page's ICE lines logged for it.
    ice_lines: usize,
    replies: Option<Watch>,
    /// The page's Mute, as it last reported it.
    muted: bool,
    replies_retry: Option<u64>,
}

/// A page's signalling socket and its way to the helper.
struct Signalling {
    peer: SignallingSocket,
    call: u64,
    /// Opened with the carrier's token: the app's, closed when it leaves.
    carrier: Option<u64>,
    upstream: Option<(u64, Arc<dyn UpstreamSocket>)>,
    /// What the page said before the helper's socket opened.
    queue: Vec<String>,
    opened: bool,
    id: u64,
    port: u64,
    address: Option<String>,
}

/// Who a socket to the helper's signalling server is for.
#[derive(Clone, Copy)]
enum Owner {
    Signalling(usize),
    Watch(u64),
}

/// A dictation: one text, from `listen` to the client's `finish`.
struct Dictation {
    /// The helper's finals so far, and what it hears now.
    segments: Vec<String>,
    current: String,
    clean: Option<Arc<dyn DictationSession>>,
    /// When the client said `finish` (the clock's monotonic ms).
    finished_at: Option<f64>,
    /// The final is being made: the helper's last utterance came.
    concluding: bool,
    deadline: Option<u64>,
    /// The helper loads its listening models: the audio waits for them.
    loading: bool,
    /// For the helper's next utterance.
    options: ListenOptions,
}

/// The voice chat's cleaning: events go through it in order.
struct Relay {
    events: mpsc::UnboundedSender<Map<String, Value>>,
    session: Arc<Mutex<Arc<dyn CleanSession>>>,
}

/// A listening session and the socket it reports to, if any.
struct Listening {
    /// The id the socket knows it by: its first helper session's.
    id: u64,
    session: Arc<dyn Listen>,
    dictation: Option<Dictation>,
    relay: Option<Relay>,
    token: String,
    ws: Option<Peer>,
    /// What was told while no socket was there, sent on resume.
    backlog: Vec<String>,
    cap: SilenceCap,
    /// Audio bytes it got: a resumed page sends again what came after.
    received: u64,
    /// Its final text was told: nothing more is waited for.
    over: bool,
    /// It hears a call's microphone (WebRTC), not the socket's audio.
    via_call: bool,
    timer: Option<u64>,
    stall: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Detach {
    SocketClosed,
    NoAudio,
}

#[derive(Clone, Copy)]
enum TimerKind {
    /// No resume in time: the utterance ends with what was heard.
    Detached(u64),
    /// What it heard is kept no longer.
    Kept(u64),
    /// A call's microphone stalled past DETACHED_MS.
    CallStalled(u64),
    /// No audio for STALL_MS.
    Stall(u64),
    /// A finished dictation's final, whatever came.
    Deadline(u64),
    /// No resume of a call in time: it stops.
    CallDetached(u64),
    /// A carrier never joined, or its socket went.
    Carrier(u64, u64, &'static str),
    RepliesRetry(u64),
}

enum Input {
    Listen(u64, Map<String, Value>),
    Relayed(u64, Map<String, Value>),
    Call(u64, Map<String, Value>),
    CallStarted {
        call: u64,
        origin: Peer,
        started: Result<Arc<dyn CallLine>, String>,
    },
    Microphone {
        ws: Peer,
        handle: u64,
        app: Option<(u64, u64)>,
        peer: String,
        result: Result<(), String>,
    },
    Dictated {
        listening: u64,
        result: Dictated,
        raw: String,
        stt_ms: f64,
        started: f64,
    },
    Timer(u64),
    Upstream(u64, UpstreamEvent),
}

struct Shared {
    core: Mutex<Core>,
    queue: Mutex<VecDeque<Input>>,
}

impl Shared {
    /// Handles what is queued, unless something already does.
    fn drain(&self) {
        loop {
            let core = match self.core.try_lock() {
                Ok(core) => core,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return,
            };
            self.finish(core);
            if lock(&self.queue).is_empty() {
                return;
            }
        }
    }

    /// Handles the queue with `core` held, then what waits for it to be let go.
    fn finish(&self, mut core: MutexGuard<'_, Core>) {
        loop {
            let next = lock(&self.queue).pop_front();
            let Some(input) = next else {
                break;
            };
            core.handle(input);
        }
        let after = std::mem::take(&mut core.after);
        drop(core);
        for run in after {
            run();
        }
    }
}

fn post(shared: &Weak<Shared>, input: Input) {
    if let Some(shared) = shared.upgrade() {
        lock(&shared.queue).push_back(input);
        shared.drain();
    }
}

/// The voice socket: every browser socket, call and signalling relay.
#[derive(Clone)]
pub struct VoiceSocket {
    shared: Arc<Shared>,
}

impl VoiceSocket {
    pub fn new(helper: Arc<dyn SocketHelper>, options: VoiceSocketOptions) -> Self {
        let shared = Arc::new_cyclic(|me| Shared {
            core: Mutex::new(Core {
                me: me.clone(),
                helper,
                options,
                next_key: 1,
                listenings: HashMap::new(),
                by_id: IndexMap::new(),
                by_socket: HashMap::new(),
                current: None,
                calls: HashMap::new(),
                signalling: IndexMap::new(),
                handoffs: IndexMap::new(),
                upstreams: HashMap::new(),
                timers: HashMap::new(),
                after: Vec::new(),
            }),
            queue: Mutex::new(VecDeque::new()),
        });
        Self { shared }
    }

    /// Runs `act` with the socket's state, then what it queued.
    fn run<R>(&self, act: impl FnOnce(&mut Core) -> R) -> R {
        let mut core = lock(&self.shared.core);
        loop {
            let next = lock(&self.shared.queue).pop_front();
            let Some(input) = next else {
                break;
            };
            core.handle(input);
        }
        let result = act(&mut core);
        self.shared.finish(core);
        self.shared.drain();
        result
    }

    /// A text message from `ws`.
    pub fn message(&self, ws: &Peer, text: &str) {
        self.run(|core| core.message(ws, text));
    }

    /// Audio from `ws`: 16 kHz mono S16LE.
    pub fn audio(&self, ws: &Peer, samples: &[u8]) {
        self.run(|core| core.audio(ws, samples));
    }

    pub fn close(&self, ws: &Peer) {
        self.run(|core| core.close(ws));
    }

    /// The call going on now, for its music's level.
    pub fn current_call(&self) -> Option<Arc<dyn CallLine>> {
        self.run(|core| core.current_state().and_then(|call| call.handle.clone()))
    }

    /// Exchanges a handoff token (call_handoff) for the call's carrier
    /// token, once: None when it is unknown, used, expired, or its call
    /// over. A newer carrier replaces the one before, which is told the
    /// call is over for it.
    pub fn redeem_handoff(&self, token: &Value) -> Option<Redeemed> {
        self.run(|core| core.redeem_handoff(token))
    }

    /// Whether `token` owns call `id` now: its page may signal it.
    pub fn owns_call(&self, id: &Value, token: &Value) -> bool {
        self.run(|core| core.not_owner(Some(id), Some(token)).is_none())
    }

    /// Why a page may not open the signalling of call `id` with `token`
    /// (/api/voice/call/signalling answers 403), or None for the call's
    /// owner on this site (`same_site`: [`signalling::same_site_socket`]).
    pub fn signalling_refused(&self, same_site: bool, id: &Value, token: &Value) -> Option<String> {
        self.run(|core| {
            let why = if same_site {
                core.not_owner(Some(id), Some(token))
            } else {
                Some("it comes from another site".to_owned())
            };
            if let Some(why) = &why {
                let shown = match id {
                    Value::String(text) => text.clone(),
                    other => js::stringify(other),
                };
                core.debug(format!("call {shown}: signalling refused (403): {why}"));
            }
            why
        })
    }

    /// A page's signalling socket for call `id`, owned by `token`: fronted
    /// to the helper's signalling server for it.
    pub fn open_signalling(&self, ws: &SignallingSocket, id: u64, token: &str) {
        self.run(|core| core.open_signalling(ws, id, token));
    }

    pub fn signalling_message(&self, ws: &SignallingSocket, text: &str) {
        self.run(|core| core.signalling_message(ws, text));
    }

    pub fn close_signalling(&self, ws: &SignallingSocket) {
        self.run(|core| core.close_signalling(ws));
    }
}

struct Core {
    me: Weak<Shared>,
    helper: Arc<dyn SocketHelper>,
    options: VoiceSocketOptions,
    next_key: u64,
    listenings: HashMap<u64, Listening>,
    by_id: IndexMap<u64, u64>,
    by_socket: HashMap<usize, u64>,
    current: Option<u64>,
    calls: HashMap<u64, CallState>,
    signalling: IndexMap<usize, Signalling>,
    /// The handoff tokens given, single use: their call and when they expire.
    handoffs: IndexMap<String, (u64, i64)>,
    upstreams: HashMap<u64, Owner>,
    timers: HashMap<u64, (TimerKind, JoinHandle<()>)>,
    /// Run once the state is let go (callbacks out of the socket).
    after: Vec<Box<dyn FnOnce() + Send>>,
}

impl Core {
    fn key(&mut self) -> u64 {
        let key = self.next_key;
        self.next_key += 1;
        key
    }

    fn debug(&self, line: String) {
        if let Some(debug) = &self.options.debug {
            debug(&format!("[voice] {line}"));
        }
    }

    fn set_timer(&mut self, ms: u64, kind: TimerKind) -> u64 {
        let id = self.key();
        let sleep = self.options.clock.sleep(Duration::from_millis(ms));
        let me = self.me.clone();
        let task = tokio::spawn(async move {
            sleep.await;
            post(&me, Input::Timer(id));
        });
        self.timers.insert(id, (kind, task));
        id
    }

    fn clear_timer(&mut self, timer: Option<u64>) {
        if let Some(id) = timer
            && let Some((_, task)) = self.timers.remove(&id)
        {
            task.abort();
        }
    }

    fn listen_sink(&self, listening: u64) -> EventSink {
        let me = self.me.clone();
        Arc::new(move |event| post(&me, Input::Listen(listening, event)))
    }

    fn current_state(&self) -> Option<&CallState> {
        self.current.and_then(|call| self.calls.get(&call))
    }

    fn handle(&mut self, input: Input) {
        match input {
            Input::Listen(listening, event) => self.helper_event(listening, event),
            Input::Relayed(listening, event) => {
                if self.listenings.contains_key(&listening) {
                    let event = self.labelled(event);
                    self.deliver(listening, event);
                }
            }
            Input::Call(call, event) => self.call_event(call, event),
            Input::CallStarted {
                call,
                origin,
                started,
            } => self.call_started(call, &origin, started),
            Input::Microphone {
                ws,
                handle,
                app,
                peer,
                result,
            } => self.microphone_answered(&ws, handle, app, &peer, result),
            Input::Dictated {
                listening,
                result,
                raw,
                stt_ms,
                started,
            } => {
                let clean_ms = js::round(self.options.clock.monotonic() - started);
                self.dictation_final(listening, result, &raw, stt_ms, clean_ms);
            }
            Input::Timer(id) => {
                if let Some((kind, _)) = self.timers.remove(&id) {
                    self.timer(id, kind);
                }
            }
            Input::Upstream(key, event) => self.upstream_event(key, event),
        }
    }

    fn timer(&mut self, id: u64, kind: TimerKind) {
        match kind {
            TimerKind::Detached(key) => {
                let Some(listening) = self.listenings.get_mut(&key) else {
                    return;
                };
                if listening.timer == Some(id) {
                    listening.timer = None;
                }
                if !listening.over {
                    let id = listening.id;
                    self.debug(format!(
                        "session {id}: no resume, the utterance ends with what was heard"
                    ));
                    self.finish_listening(key);
                }
                let kept = self.set_timer(KEPT_MS, TimerKind::Kept(key));
                match self.listenings.get_mut(&key) {
                    Some(listening) => listening.timer = Some(kept),
                    None => self.clear_timer(Some(kept)),
                }
            }
            TimerKind::Kept(key) => self.end(key),
            TimerKind::CallStalled(key) => {
                let Some(listening) = self.listenings.get_mut(&key) else {
                    return;
                };
                listening.timer = None;
                if listening.over {
                    return;
                }
                let id = listening.id;
                self.debug(format!(
                    "session {id}: no audio from the call's microphone, the utterance ends with what was heard"
                ));
                self.finish_listening(key);
            }
            TimerKind::Stall(key) => self.stalled(key),
            TimerKind::Deadline(key) => {
                let Some(listening) = self.listenings.get_mut(&key) else {
                    return;
                };
                let id = listening.id;
                let Some(state) = listening.dictation.as_mut() else {
                    return;
                };
                state.deadline = None;
                let heard = heard_so_far(state);
                let finished_at = state.finished_at.unwrap_or(0.0);
                self.debug(format!(
                    "dictation {id}: no final in time, the words as heard"
                ));
                let stt_ms = js::round(self.options.clock.monotonic() - finished_at);
                self.dictation_final(
                    key,
                    Dictated {
                        text: heard.clone(),
                        cleaned: false,
                    },
                    &heard,
                    stt_ms,
                    0.0,
                );
            }
            TimerKind::CallDetached(call) => {
                if let Some(state) = self.calls.get_mut(&call) {
                    state.timer = None;
                }
                self.debug("a call ends: no resume".into());
                self.stop_call(Some(call), "The call ended");
            }
            TimerKind::Carrier(call, serial, why) => {
                let Some(carrier) = self
                    .calls
                    .get_mut(&call)
                    .and_then(|state| state.carrier.as_mut())
                    .filter(|carrier| carrier.serial == serial)
                else {
                    return;
                };
                carrier.timer = None;
                self.carrier_left(call, why, false);
            }
            TimerKind::RepliesRetry(call) => {
                let Some(state) = self.calls.get_mut(&call) else {
                    return;
                };
                state.replies_retry = None;
                if state.carrier.is_some() && state.replies.is_none() {
                    self.watch_replies(call);
                }
            }
        }
    }

    // Calls.

    /// Why `token` does not own call `id` now, or None when it does: the
    /// page's token, or the carrying app's.
    fn not_owner(&self, id: Option<&Value>, token: Option<&Value>) -> Option<String> {
        let Some(call) = self.current_state() else {
            return Some("no call goes on".into());
        };
        let Some(handle) = &call.handle else {
            return Some("the call is still starting".into());
        };
        if !is_id(id, handle.id()) {
            return Some(format!("the call going on is {}", handle.id()));
        }
        let Some(token) = token
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
        else {
            return Some("no call_token".into());
        };
        if call.token != token
            && call
                .carrier
                .as_ref()
                .is_none_or(|carrier| carrier.token != token)
        {
            return Some("not the call's call_token".into());
        }
        None
    }

    /// Tells the call's page and its carrying app alike.
    fn tell_both(&self, call: u64, message: &Value) {
        let Some(state) = self.calls.get(&call) else {
            return;
        };
        send(state.ws.as_ref(), message.clone());
        if let Some(app) = state
            .carrier
            .as_ref()
            .and_then(|carrier| carrier.ws.as_ref())
            && state
                .ws
                .as_ref()
                .is_none_or(|page| key_of(page) != key_of(app))
        {
            send(Some(app), message.clone());
        }
    }

    /// Where the carrier stands, as told to the page.
    fn carrier_state(state: &CallState, carrier: &Carrier) -> Value {
        json!({
            "event": "call_carrier",
            "call": state.handle.as_ref().map(|handle| handle.id()),
            "state": "joined",
            "legs": carrier.legs,
            "heard": carrier.heard,
        })
    }

    /// Closes the signalling sockets of `call` (all, or the carrier
    /// `serial`'s): the page opens them again.
    fn close_signalling_of(&mut self, call: u64, carrier: Option<u64>, why: &str) {
        let closing: Vec<usize> = self
            .signalling
            .iter()
            .filter(|(_, held)| held.call == call && (carrier.is_none() || held.carrier == carrier))
            .map(|(key, _)| *key)
            .collect();
        for key in closing {
            let Some(held) = self.signalling.shift_remove(&key) else {
                continue;
            };
            if let Some((upstream_key, upstream)) = held.upstream {
                self.upstreams.remove(&upstream_key);
                upstream.close();
            }
            held.peer.close(4000, why);
        }
    }

    /// The app lets the call's legs go (`why`): the page takes them back,
    /// the app's signalling closes, and a dropped app is told the call is
    /// over for it.
    fn carrier_left(&mut self, call: u64, why: &str, dropped: bool) {
        let Some(state) = self.calls.get_mut(&call) else {
            return;
        };
        let Some(carrier) = state.carrier.take() else {
            return;
        };
        let id = state.handle.as_ref().map(|handle| handle.id());
        let page = state.ws.clone();
        self.clear_timer(carrier.timer);
        self.debug(format!(
            "call {}: the app lets the call go: {why}",
            id.map_or("undefined".into(), |id| id.to_string())
        ));
        if carrier.joined {
            send(
                page.as_ref(),
                json!({"event": "call_carrier", "call": id, "state": "left", "why": why}),
            );
        }
        if dropped {
            send(
                carrier.ws.as_ref(),
                json!({"event": "call_audio", "call": id, "error": why}),
            );
        }
        self.close_signalling_of(call, Some(carrier.serial), why);
        self.unwatch_replies(call);
    }

    /// The call `ws` carries for the app, if it does.
    fn carried(&self, ws: &Peer) -> Option<u64> {
        let call = self.current?;
        let carrier = self.calls.get(&call)?.carrier.as_ref()?;
        (carrier.joined
            && carrier
                .ws
                .as_ref()
                .is_some_and(|app| key_of(app) == key_of(ws)))
        .then_some(call)
    }

    /// Whether `ws` is the page owning the current call.
    fn owns(&self, ws: &Peer) -> Option<u64> {
        let call = self.current?;
        self.calls
            .get(&call)?
            .ws
            .as_ref()
            .is_some_and(|page| key_of(page) == key_of(ws))
            .then_some(call)
    }

    /// Stops watching who the replies' producer of `call` is.
    fn unwatch_replies(&mut self, call: u64) {
        let Some(state) = self.calls.get_mut(&call) else {
            return;
        };
        let retry = state.replies_retry.take();
        let watch = state.replies.take();
        self.clear_timer(retry);
        if let Some(watch) = watch {
            self.upstreams.remove(&watch.upstream_key);
            watch.upstream.close();
        }
    }

    /// Tells the joined app a replies producer it was not told yet.
    fn tell_replies_peer(&mut self, call: u64) {
        let Some(state) = self.calls.get_mut(&call) else {
            return;
        };
        let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
            return;
        };
        let Some(peer) = state.replies.as_ref().and_then(|watch| watch.peer.clone()) else {
            return;
        };
        let Some(carrier) = state.carrier.as_mut().filter(|carrier| carrier.joined) else {
            return;
        };
        let Some(ws) = carrier.ws.clone() else {
            return;
        };
        if carrier.told_peer.as_deref() == Some(peer.as_str()) {
            return;
        }
        carrier.told_peer = Some(peer.clone());
        send(
            Some(&ws),
            json!({"event": "call_replies_peer", "call": id, "peer": peer}),
        );
    }

    /// Watches who the replies' producer of `call` is, as a listener on
    /// its signalling server: from a handoff on, and again on a restarted
    /// helper's new server.
    fn watch_replies(&mut self, call: u64) {
        self.unwatch_replies(call);
        if self.current != Some(call) {
            return;
        }
        let Some(handle) = self.calls.get(&call).and_then(|state| state.handle.clone()) else {
            return;
        };
        let id = handle.id();
        let port = handle.signalling_port();
        if port == 0 {
            return;
        }
        let upstream_key = self.key();
        let me = self.me.clone();
        let events = Arc::new(move |event| post(&me, Input::Upstream(upstream_key, event)));
        let upstream =
            match (self.options.connect_upstream)(&format!("ws://127.0.0.1:{port}"), events) {
                Ok(upstream) => upstream,
                Err(error) => {
                    self.debug(format!(
                        "call {id}: cannot watch the replies on port {port}: {error}"
                    ));
                    return;
                }
            };
        self.upstreams.insert(upstream_key, Owner::Watch(call));
        if let Some(state) = self.calls.get_mut(&call) {
            state.replies = Some(Watch {
                upstream_key,
                upstream,
                peer: None,
            });
        }
    }

    fn watch_message(&mut self, call: u64, text: &str) {
        let Some(state) = self.calls.get_mut(&call) else {
            return;
        };
        let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
            return;
        };
        let Some(watch) = state.replies.as_mut() else {
            return;
        };
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let is_replies = |meta: Option<&Value>| {
            meta.and_then(Value::as_object).is_some_and(|meta| {
                is_id(meta.get("call"), id) && meta.get("role") == Some(&json!("replies"))
            })
        };
        let mut found = None;
        match message.get("type").and_then(Value::as_str) {
            Some("welcome") => {
                watch.upstream.send(js::stringify(&json!({
                    "type": "setPeerStatus",
                    "roles": ["listener"],
                    "meta": {"call": id, "role": "roamgate"},
                })));
                watch.upstream.send(js::stringify(&json!({"type": "list"})));
            }
            Some("list") => {
                let producers = message
                    .get("producers")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                found = producers.iter().find_map(|each| {
                    let peer = each.get("id")?.as_str().filter(|peer| !peer.is_empty())?;
                    is_replies(each.get("meta")).then(|| peer.to_owned())
                });
            }
            Some("peerStatusChanged") => {
                let Some(peer) = message
                    .get("peerId")
                    .and_then(Value::as_str)
                    .filter(|peer| !peer.is_empty())
                else {
                    return;
                };
                let producing = message
                    .get("roles")
                    .and_then(Value::as_array)
                    .is_some_and(|roles| roles.iter().any(|role| role == "producer"));
                if producing && is_replies(message.get("meta")) {
                    found = Some(peer.to_owned());
                } else if watch.peer.as_deref() == Some(peer) {
                    watch.peer = None;
                }
            }
            _ => {}
        }
        if let Some(peer) = found
            && watch.peer.as_deref() != Some(peer.as_str())
        {
            watch.peer = Some(peer.clone());
            self.debug(format!("call {id}: the replies' producer is {peer}"));
            self.tell_replies_peer(call);
        }
    }

    fn watch_gone(&mut self, call: u64, upstream_key: u64) {
        self.upstreams.remove(&upstream_key);
        let Some(state) = self.calls.get_mut(&call) else {
            return;
        };
        if state
            .replies
            .as_ref()
            .is_none_or(|watch| watch.upstream_key != upstream_key)
        {
            return;
        }
        state.replies = None;
        let id = state.handle.as_ref().map_or(0, |handle| handle.id());
        let port = state
            .handle
            .as_ref()
            .map_or(0, |handle| handle.signalling_port());
        self.debug(format!(
            "call {id}: the replies' watch on port {port} closed"
        ));
        // A restarted helper's new server is watched on call_restarted.
        let retry = self.set_timer(REPLIES_WATCH_RETRY_MS, TimerKind::RepliesRetry(call));
        if let Some(state) = self.calls.get_mut(&call) {
            state.replies_retry = Some(retry);
        }
    }

    /// Ends `call`, telling its page why (it stops trying to signal).
    fn stop_call(&mut self, call: Option<u64>, why: &str) {
        let Some(call) = call else {
            return;
        };
        let Some(mut ending) = self.calls.remove(&call) else {
            return;
        };
        self.clear_timer(ending.timer.take());
        if let Some(handle) = &ending.handle {
            handle.stop();
        }
        self.handoffs.retain(|_, (given, _)| *given != call);
        let id = ending.handle.as_ref().map(|handle| handle.id());
        if let Some(carrier) = ending.carrier.take() {
            self.clear_timer(carrier.timer);
            if id.is_some() {
                send(
                    carrier.ws.as_ref(),
                    json!({"event": "call_audio", "call": id, "error": why}),
                );
            }
        }
        if id.is_some() {
            send(
                ending.ws.as_ref(),
                json!({"event": "call_audio", "call": id, "error": why}),
            );
        }
        self.close_signalling_of(call, None, why);
        self.clear_timer(ending.replies_retry.take());
        if let Some(watch) = ending.replies.take() {
            self.upstreams.remove(&watch.upstream_key);
            watch.upstream.close();
        }
        if self.current == Some(call) {
            self.current = None;
        }
        // Told after the call is gone: hanging up never waits for what follows.
        if id.is_some() && why != REPLACED_CALL {
            let ended = self.options.on_call_ended.clone();
            self.after.push(Box::new(move || ended()));
        }
    }

    fn start_call(&mut self, ws: &Peer) {
        self.stop_call(self.current, REPLACED_CALL);
        // A call without music still is one: the replies go through it.
        let wanted = (self.options.background)().unwrap_or(CallBackground {
            background: String::new(),
            volume: 0.6,
            ducked: 0.15,
            release_ms: 3000.0,
            muted: true,
            reply_loudness: Some(CALL_REPLY_LOUDNESS),
        });
        let call = self.key();
        self.calls.insert(
            call,
            CallState {
                carrier: None,
                handle: None,
                token: random_uuid(),
                ws: Some(ws.clone()),
                timer: None,
                restarts: 0,
                ice_lines: 0,
                replies: None,
                muted: false,
                replies_retry: None,
            },
        );
        self.current = Some(call);
        let me = self.me.clone();
        let events: EventSink = {
            let me = me.clone();
            Arc::new(move |event| post(&me, Input::Call(call, event)))
        };
        let starting = self.helper.start_call(wanted, events);
        let origin = ws.clone();
        tokio::spawn(async move {
            let started = starting.await;
            post(
                &me,
                Input::CallStarted {
                    call,
                    origin,
                    started,
                },
            );
        });
    }

    fn call_started(
        &mut self,
        call: u64,
        origin: &Peer,
        started: Result<Arc<dyn CallLine>, String>,
    ) {
        let handle = match started {
            Ok(handle) => handle,
            Err(error) => {
                if self.current == Some(call) {
                    self.current = None;
                }
                self.calls.remove(&call);
                send(Some(origin), json!({"event": "call_audio", "error": error}));
                return;
            }
        };
        let Some(state) = self.calls.get_mut(&call) else {
            // Stopped while it started.
            handle.stop();
            return;
        };
        state.handle = Some(handle.clone());
        let ws = state.ws.clone();
        let token = state.token.clone();
        let music = if handle.music() {
            if handle.music_on() {
                if handle.music_waiting() {
                    "waiting for a voice"
                } else {
                    "on"
                }
            } else {
                "off"
            }
        } else {
            "none"
        };
        self.debug(format!(
            "call {}: started, music {music}, signalling on port {}",
            handle.id(),
            handle.signalling_port()
        ));
        send(
            ws.as_ref(),
            json!({
                "event": "call_audio",
                "call": handle.id(),
                "resume": token,
                "music": handle.music(),
                "waiting": handle.music_waiting(),
                "webrtc": true,
            }),
        );
    }

    fn call_event(&mut self, call: u64, event: Map<String, Value>) {
        if !self.calls.contains_key(&call) {
            return;
        }
        let number = event.get("call").cloned().unwrap_or(Value::Null);
        match event.get("event").and_then(Value::as_str) {
            Some("call_restarted") => {
                // The helper restarted and made the call again, with another
                // signalling server: the page's sessions start again on it.
                let Some(state) = self.calls.get_mut(&call) else {
                    return;
                };
                state.restarts += 1;
                let restarts = state.restarts;
                let carried = state.carrier.is_some();
                self.debug(format!(
                    "call {}: made again after the helper restarted",
                    js::stringify(&number)
                ));
                self.close_signalling_of(call, None, "The voice helper restarted");
                self.tell_both(
                    call,
                    &json!({"event": "call_restarted", "call": number, "restarts": restarts}),
                );
                // The app learns the new server's replies producer once known.
                if carried {
                    self.watch_replies(call);
                }
            }
            Some("call_ended") => {
                // Not made again by a restarted helper: over, not owned any more.
                let error = text_of(&event, "error");
                self.debug(format!("call {}: ended: {error}", js::stringify(&number)));
                self.stop_call(Some(call), &error);
            }
            Some("call_music") => {
                let waiting = event.get("waiting").cloned();
                self.debug(format!(
                    "call {}: {}",
                    js::stringify(&number),
                    if waiting.as_ref().is_some_and(js_truthy) {
                        "the music waits for a voice"
                    } else {
                        "a voice was taken: the music plays"
                    }
                ));
                let mut message = object(json!({"event": "call_music", "call": number}));
                put(&mut message, "waiting", waiting.as_ref());
                self.tell_both(call, &Value::Object(message));
            }
            _ => {
                let error = event.get("error");
                if error == Some(&json!("Replaced")) {
                    return;
                }
                let mut message = object(json!({"event": "call_error"}));
                put(&mut message, "error", error);
                let ws = self.calls.get(&call).and_then(|state| state.ws.clone());
                send(ws.as_ref(), Value::Object(message));
            }
        }
    }

    fn redeem_handoff(&mut self, token: &Value) -> Option<Redeemed> {
        let token = token.as_str().filter(|token| !token.is_empty())?;
        let (call, expires) = self.handoffs.shift_remove(token)?;
        let id = self.calls.get(&call)?.handle.as_ref()?.id();
        if expires < self.options.clock.now() || self.current != Some(call) {
            return None;
        }
        self.carrier_left(call, "The call went to another app", true);
        let serial = self.key();
        let carrier = Carrier {
            serial,
            token: random_token(),
            ws: None,
            legs: Vec::new(),
            joined: false,
            heard: false,
            outputs: None,
            told_peer: None,
            timer: None,
        };
        let token = carrier.token.clone();
        // Never joined: let go, the page keeps the call.
        let timer = self.set_timer(
            DETACHED_MS,
            TimerKind::Carrier(call, serial, "The Roamgate app never joined"),
        );
        if let Some(state) = self.calls.get_mut(&call) {
            state.carrier = Some(Carrier {
                timer: Some(timer),
                ..carrier
            });
        }
        // Who the replies' producer is, known by the time the app joins.
        self.watch_replies(call);
        self.debug(format!("call {id}: the handoff was taken"));
        Some(Redeemed {
            call: id,
            carrier: token,
        })
    }

    // Signalling.

    fn open_signalling(&mut self, ws: &SignallingSocket, id: u64, token: &str) {
        let refused = self.not_owner(Some(&json!(id)), Some(&json!(token)));
        let call = self.current;
        let handle = self.current_state().and_then(|state| state.handle.clone());
        let (Some(call), Some(handle), None) = (call, handle, &refused) else {
            self.debug(format!(
                "call {id}: signalling closed (4004): {}",
                refused.unwrap_or_else(|| "null".into())
            ));
            ws.close(4004, "No such call");
            return;
        };
        let port = handle.signalling_port();
        if port == 0 {
            self.debug(format!(
                "call {id}: signalling closed (1011): the helper gives no port"
            ));
            ws.close(1011, "The call's signalling is not there");
            return;
        }
        let carrier = self
            .calls
            .get(&call)
            .and_then(|state| state.carrier.as_ref())
            .filter(|carrier| carrier.token == token)
            .map(|carrier| carrier.serial);
        let peer_key = key_of(ws);
        let upstream_key = self.key();
        let me = self.me.clone();
        let events = Arc::new(move |event| post(&me, Input::Upstream(upstream_key, event)));
        let upstream =
            match (self.options.connect_upstream)(&format!("ws://127.0.0.1:{port}"), events) {
                Ok(upstream) => upstream,
                Err(error) => {
                    self.debug(format!("call {id}: no signalling on port {port}: {error}"));
                    ws.close(1011, "The call's signalling is not there");
                    return;
                }
            };
        let address = (self.options.ice_address)().filter(|address| !address.is_empty());
        self.debug(format!(
            "call {id}: a page signals on port {port}{}",
            address.as_ref().map_or(String::new(), |address| format!(
                ", candidates given at {address}"
            ))
        ));
        self.upstreams
            .insert(upstream_key, Owner::Signalling(peer_key));
        self.signalling.insert(
            peer_key,
            Signalling {
                peer: ws.clone(),
                call,
                carrier,
                upstream: Some((upstream_key, upstream)),
                queue: Vec::new(),
                opened: false,
                id,
                port,
                address,
            },
        );
    }

    fn signalling_message(&mut self, ws: &SignallingSocket, text: &str) {
        let Some(held) = self.signalling.get_mut(&key_of(ws)) else {
            return;
        };
        let Some((_, upstream)) = &held.upstream else {
            return;
        };
        if held.opened {
            upstream.send(text.to_owned());
        } else if held.queue.len() < SIGNALLING_QUEUE {
            held.queue.push(text.to_owned());
        }
    }

    fn close_signalling(&mut self, ws: &SignallingSocket) {
        let Some(held) = self.signalling.shift_remove(&key_of(ws)) else {
            return;
        };
        if let Some((upstream_key, upstream)) = held.upstream {
            self.upstreams.remove(&upstream_key);
            upstream.close();
        }
    }

    fn upstream_event(&mut self, upstream_key: u64, event: UpstreamEvent) {
        let Some(owner) = self.upstreams.get(&upstream_key).copied() else {
            return;
        };
        match owner {
            Owner::Watch(call) => match event {
                UpstreamEvent::Open => {}
                UpstreamEvent::Message(text) => self.watch_message(call, &text),
                UpstreamEvent::Closed => self.watch_gone(call, upstream_key),
            },
            Owner::Signalling(peer_key) => {
                let Some(held) = self.signalling.get_mut(&peer_key) else {
                    return;
                };
                match event {
                    UpstreamEvent::Open => {
                        held.opened = true;
                        if let Some((_, upstream)) = &held.upstream {
                            for message in held.queue.drain(..) {
                                upstream.send(message);
                            }
                        }
                    }
                    UpstreamEvent::Message(text) => {
                        held.peer
                            .send(rewrite_candidates(&text, held.address.as_deref()));
                    }
                    UpstreamEvent::Closed => {
                        let Some(held) = self.signalling.shift_remove(&peer_key) else {
                            return;
                        };
                        self.upstreams.remove(&upstream_key);
                        self.debug(format!(
                            "call {}: signalling closed (1011): the helper's signalling on port {} {}",
                            held.id,
                            held.port,
                            if held.opened { "closed" } else { "did not answer" }
                        ));
                        held.peer.close(1011, "The call's signalling closed");
                    }
                }
            }
        }
    }

    // Listening.

    fn clear_timers(&mut self, key: u64) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        let timers = [listening.timer.take(), listening.stall.take()];
        for timer in timers {
            self.clear_timer(timer);
        }
    }

    fn close_cleaning(&mut self, listening: &mut Listening) {
        if let Some(relay) = listening.relay.take() {
            lock(&relay.session).close();
        }
        if let Some(state) = listening.dictation.as_mut() {
            if let Some(clean) = &state.clean {
                clean.close();
            }
            let deadline = state.deadline.take();
            self.clear_timer(deadline);
        }
    }

    fn end(&mut self, key: u64) {
        self.clear_timers(key);
        let Some(mut listening) = self.listenings.remove(&key) else {
            return;
        };
        listening.session.stop();
        self.close_cleaning(&mut listening);
        if self.by_id.get(&listening.id) == Some(&key) {
            self.by_id.shift_remove(&listening.id);
        }
        self.by_socket.retain(|_, held| *held != key);
    }

    fn stop(&mut self, ws: &Peer) {
        if let Some(key) = self.by_socket.get(&key_of(ws)).copied() {
            self.end(key);
        }
    }

    /// No socket for it now: wait for one, then end the utterance. A
    /// stalled socket stays known, in case its stream comes back.
    fn detach(&mut self, key: u64, why: Detach) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if why == Detach::SocketClosed
            && let Some(ws) = listening.ws.take()
            && self.by_socket.get(&key_of(&ws)) == Some(&key)
        {
            self.by_socket.remove(&key_of(&ws));
        }
        listening.ws = None;
        let (over, empty, id) = (listening.over, listening.backlog.is_empty(), listening.id);
        self.clear_timers(key);
        if over && empty {
            if why == Detach::SocketClosed {
                self.end(key);
            }
            return;
        }
        let why = match why {
            Detach::SocketClosed => "socket closed",
            Detach::NoAudio => "no audio",
        };
        self.debug(format!("session {id} detached ({why}): kept for a resume"));
        let timer = self.set_timer(DETACHED_MS, TimerKind::Detached(key));
        if let Some(listening) = self.listenings.get_mut(&key) {
            listening.timer = Some(timer);
        }
    }

    /// No audio for STALL_MS. The socket's own: it is gone. A call's
    /// microphone: the socket is alive, only its WebRTC stream stopped; the
    /// page is told, and past DETACHED_MS more the utterance ends.
    fn stalled(&mut self, key: u64) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        listening.stall = None;
        let Some(ws) = listening.ws.clone().filter(|_| listening.via_call) else {
            self.detach(key, Detach::NoAudio);
            return;
        };
        let id = listening.id;
        let timer = listening.timer.take();
        self.debug(format!("session {id}: the call's microphone stalled"));
        send(Some(&ws), json!({"event": "stalled", "session": id}));
        self.clear_timer(timer);
        let timer = self.set_timer(DETACHED_MS, TimerKind::CallStalled(key));
        if let Some(listening) = self.listenings.get_mut(&key) {
            listening.timer = Some(timer);
        }
    }

    fn watch_stall(&mut self, key: u64) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        let stall = listening.stall.take();
        // A finished dictation waits for its final, sending no more audio.
        let watching = listening.ws.is_some()
            && !listening.over
            && listening
                .dictation
                .as_ref()
                .is_none_or(|state| state.finished_at.is_none());
        self.clear_timer(stall);
        if watching {
            let timer = self.set_timer(STALL_MS, TimerKind::Stall(key));
            if let Some(listening) = self.listenings.get_mut(&key) {
                listening.stall = Some(timer);
            }
        }
    }

    /// A pause of the cap's length came: the utterance ends.
    fn pause_ends(&self, listening: &Listening) {
        let limit = listening.cap.limit_ms();
        let mut fields = LogFields::new();
        fields.insert("session".into(), json!(listening.id));
        fields.insert("limit_ms".into(), js::number(limit));
        self.options
            .log
            .debug("voice pause ends the turn", Some(&fields));
        self.debug(format!(
            "session {}: a pause of {} ms ends the utterance",
            listening.id,
            js::number_text(limit)
        ));
        listening.session.finish();
    }

    /// A call's microphone came for the listening (the helper's `audio`):
    /// it times the pause as the socket's audio does, and the stream is
    /// alive.
    fn call_audio_came(&mut self, key: u64, bytes: f64) {
        let Some(listening) = self.listenings.get(&key) else {
            return;
        };
        if listening.ws.is_some() {
            self.clear_timers(key);
            self.watch_stall(key);
        }
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.cap.audio(bytes) {
            let listening = &self.listenings[&key];
            self.pause_ends(listening);
        }
    }

    fn attach(&mut self, key: u64, ws: &Peer) {
        let socket = key_of(ws);
        if let Some(old) = self.by_socket.get(&socket).copied()
            && old != key
        {
            self.end(old);
        }
        self.by_socket
            .retain(|other, held| !(*held == key && *other != socket));
        self.clear_timers(key);
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        listening.ws = Some(ws.clone());
        self.by_socket.insert(socket, key);
        for message in listening.backlog.drain(..) {
            ws.send(message);
        }
        self.watch_stall(key);
    }

    /// Tells the session's socket, or keeps it for the next one.
    fn deliver(&mut self, key: u64, event: Map<String, Value>) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        // Its helper stopped under it: nothing more comes for it (no
        // finish either), and the page listens again on a new session.
        let kind = event.get("event").and_then(Value::as_str);
        let gone = kind == Some("error") && event.get("recoverable") == Some(&Value::Bool(true));
        let id = listening.id;
        if kind == Some("final") {
            // When each turn was heard whole (debug): its route and speech
            // follow.
            let mut fields = LogFields::new();
            fields.insert("session".into(), json!(id));
            fields.insert(
                "chars".into(),
                json!(
                    event
                        .get("text")
                        .and_then(Value::as_str)
                        .map_or(0, js::len16)
                ),
            );
            put(&mut fields, "speech_ms", event.get("speech_ms"));
            fields.insert(
                "via".into(),
                json!(if listening.via_call { "call" } else { "socket" }),
            );
            self.options.log.debug("voice turn heard", Some(&fields));
        }
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        let mut stall = None;
        if kind == Some("final") || gone {
            listening.over = true;
            stall = listening.stall.take();
        }
        let message = stringify(&event);
        let attached = listening.ws.clone();
        match &attached {
            Some(ws) => ws.send(message),
            None => listening.backlog.push(message),
        }
        self.clear_timer(stall);
        if gone && attached.is_some() {
            self.debug(format!("session {id}: ended with the helper"));
            self.end(key);
        }
    }

    /// A final's voice, labelled for the page to pass on.
    fn labelled(&self, mut event: Map<String, Value>) -> Map<String, Value> {
        if event.get("event").and_then(Value::as_str) != Some("final") {
            return event;
        }
        let Some(voice) = event.get("voice").filter(|voice| js_truthy(voice)) else {
            return event;
        };
        let label = self.helper.voice_label(voice);
        if !label.is_empty() {
            event.insert("voice_label".into(), json!(label));
        }
        event
    }

    /// The helper's event for a listening (createVoiceSocket's listen and
    /// startDictation callbacks).
    fn helper_event(&mut self, key: u64, event: Map<String, Value>) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.dictation.is_some() {
            self.dictation_event(key, event);
            return;
        }
        match event.get("event").and_then(Value::as_str) {
            Some("audio") => {
                let bytes = event.get("bytes").and_then(Value::as_f64).unwrap_or(0.0);
                self.call_audio_came(key, bytes);
            }
            // The voice chat's audio waits for the models as well.
            Some("listen_loading" | "listen_ready") => {}
            _ => {
                listening.cap.event(&event);
                match listening.relay.as_ref().map(|relay| relay.events.clone()) {
                    Some(events) => {
                        let _ = events.send(event);
                    }
                    None => {
                        let event = self.labelled(event);
                        self.deliver(key, event);
                    }
                }
            }
        }
    }

    // Dictation.

    /// A dictation's one final: later ones (a late cleaner) are dropped.
    fn dictation_final(
        &mut self,
        key: u64,
        result: Dictated,
        raw: &str,
        stt_ms: f64,
        clean_ms: f64,
    ) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.over {
            return;
        }
        let id = listening.id;
        let Some(state) = listening.dictation.as_mut() else {
            return;
        };
        let deadline = state.deadline.take();
        if let Some(clean) = &state.clean {
            clean.close();
        }
        self.clear_timer(deadline);
        // Timings and sizes only: never the words.
        self.debug(format!(
            "dictation {id}: heard {} ms after finish, {}, {} chars heard, {} typed",
            js::number_text(stt_ms),
            if result.cleaned {
                format!("cleaned in {} ms", js::number_text(clean_ms))
            } else {
                "typed as heard".into()
            },
            js::len16(raw),
            js::len16(&result.text)
        ));
        if raw.is_empty() {
            // Said as such: an empty final types nothing, and a client
            // waiting on its cleaning shows nothing either.
            let Some(listening) = self.listenings.get_mut(&key) else {
                return;
            };
            listening.over = true;
            let stall = listening.stall.take();
            self.clear_timer(stall);
            self.deliver(
                key,
                object(json!({
                    "event": "error",
                    "session": id,
                    "error": NOTHING_HEARD,
                    "nothing_heard": true,
                    "recoverable": false,
                })),
            );
            return;
        }
        self.deliver(
            key,
            object(json!({
                "event": "final",
                "session": id,
                "text": result.text,
                "raw": raw,
                "cleaned": result.cleaned,
                "timing": {"stt_ms": js::number(stt_ms), "clean_ms": js::number(clean_ms)},
            })),
        );
    }

    /// The helper's last utterance came after `finish`: clean and tell.
    fn conclude_dictation(&mut self, key: u64) {
        let now = self.options.clock.monotonic();
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.over {
            return;
        }
        let Some(state) = listening.dictation.as_mut() else {
            return;
        };
        if state.concluding {
            return;
        }
        state.concluding = true;
        let stt_ms = js::round(now - state.finished_at.unwrap_or(now));
        let raw = heard_so_far(state);
        let clean = state.clean.clone();
        let me = self.me.clone();
        tokio::spawn(async move {
            let result = dictated(clean, &raw).await;
            post(
                &me,
                Input::Dictated {
                    listening: key,
                    result,
                    raw,
                    stt_ms,
                    started: now,
                },
            );
        });
    }

    /// A finished dictation's final comes within `ms`, whatever comes.
    fn arm_deadline(&mut self, key: u64, ms: u64) {
        let Some(state) = self
            .listenings
            .get_mut(&key)
            .and_then(|listening| listening.dictation.as_mut())
        else {
            return;
        };
        let deadline = state.deadline.take();
        self.clear_timer(deadline);
        let timer = self.set_timer(ms, TimerKind::Deadline(key));
        if let Some(state) = self
            .listenings
            .get_mut(&key)
            .and_then(|listening| listening.dictation.as_mut())
        {
            state.deadline = Some(timer);
        }
    }

    /// The client is done: the helper ends what it hears, and the final
    /// comes within FINISH_DEADLINE_MS whatever happens.
    fn finish_dictation(&mut self, key: u64) {
        let now = self.options.clock.monotonic();
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.over {
            return;
        }
        let Some(state) = listening.dictation.as_mut() else {
            return;
        };
        if state.finished_at.is_some() {
            return;
        }
        state.finished_at = Some(now);
        let loading = state.loading;
        let stall = listening.stall.take();
        let session = listening.session.clone();
        self.clear_timer(stall);
        self.arm_deadline(
            key,
            if loading {
                LOADING_DEADLINE_MS
            } else {
                FINISH_DEADLINE_MS
            },
        );
        session.finish();
    }

    /// Ends the utterance, or the dictation, with what was heard.
    fn finish_listening(&mut self, key: u64) {
        let Some(listening) = self.listenings.get(&key) else {
            return;
        };
        if listening.dictation.is_some() {
            self.finish_dictation(key);
        } else {
            listening.session.finish();
        }
    }

    /// The helper's events for a dictation, as the socket is told them.
    fn dictation_event(&mut self, key: u64, event: Map<String, Value>) {
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        if listening.over {
            return;
        }
        // The utterance before this one may still say how it ended.
        if let Some(session) = event.get("session")
            && !is_id(Some(session), listening.session.id())
        {
            return;
        }
        let id = listening.id;
        let Some(state) = listening.dictation.as_mut() else {
            return;
        };
        match event.get("event").and_then(Value::as_str) {
            Some("listen_loading") => {
                // A helper just started: what is said now is heard once
                // its models are loaded, and the client may say so.
                state.loading = true;
                self.deliver(
                    key,
                    object(json!({"event": "loading", "session": id, "mode": "dictation"})),
                );
            }
            Some("listen_ready") => {
                state.loading = false;
                let rearm = state.finished_at.is_some() && !state.concluding;
                self.deliver(
                    key,
                    object(json!({"event": "ready", "session": id, "mode": "dictation"})),
                );
                // Finished while they loaded: the helper hears it all only now.
                if rearm {
                    self.arm_deadline(key, FINISH_DEADLINE_MS);
                }
            }
            Some("speech_start") => {
                self.deliver(key, object(json!({"event": "speech_start", "session": id})));
            }
            Some("partial") => {
                let text = text_of(&event, "text");
                if text.is_empty() {
                    return;
                }
                state.current = text;
                let whole = heard_so_far(state);
                let pause = event.get("pause") == Some(&Value::Bool(true));
                if let Some(clean) = &state.clean {
                    clean.partial(&whole, pause);
                }
                let mut told = object(json!({"event": "partial", "session": id, "text": whole}));
                if pause {
                    told.insert("pause".into(), json!(true));
                }
                self.deliver(key, told);
            }
            Some("final") => {
                // A voice the helper doubts is the speaker's is typed too:
                // the phone is held by the one dictating.
                let text = text_of(&event, "text").trim().to_owned();
                if !text.is_empty() {
                    state.segments.push(text);
                }
                state.current.clear();
                if state.finished_at.is_some() {
                    self.conclude_dictation(key);
                    return;
                }
                // A pause ended the helper's utterance, not the dictation:
                // it listens again at once, the same socket's audio going on.
                let options = state.options.clone();
                let before = listening.session.clone();
                match self.helper.listen(self.listen_sink(key), options) {
                    Ok(next) => {
                        if let Some(listening) = self.listenings.get_mut(&key) {
                            listening.session = next;
                        }
                        before.stop();
                    }
                    Err(error) => self.deliver(
                        key,
                        object(json!({
                            "event": "error",
                            "session": id,
                            "error": error,
                            "recoverable": true,
                        })),
                    ),
                }
            }
            Some("error") => {
                let recoverable = event.get("recoverable");
                let mut told = object(json!({"event": "error", "session": id}));
                put(&mut told, "error", event.get("error"));
                put(&mut told, "recoverable", recoverable);
                let over = recoverable == Some(&Value::Bool(true));
                self.deliver(key, told);
                if over && let Some(listening) = self.listenings.get_mut(&key) {
                    listening.over = true;
                }
            }
            _ => {}
        }
    }

    /// The helper listens to one session at a time: a newer listening
    /// takes it from a dictation, which ends with what it heard.
    fn preempt_dictations(&mut self) {
        let keys: Vec<u64> = self.by_id.values().copied().collect();
        for key in keys {
            let Some(listening) = self.listenings.get(&key) else {
                continue;
            };
            let Some(state) = listening.dictation.as_ref().filter(|_| !listening.over) else {
                continue;
            };
            let raw = heard_so_far(state);
            let session = listening.session.clone();
            self.debug(format!(
                "dictation {}: another listening took the helper",
                listening.id
            ));
            self.dictation_final(
                key,
                Dictated {
                    text: raw.clone(),
                    cleaned: false,
                },
                &raw,
                0.0,
                0.0,
            );
            session.stop();
        }
    }

    /// `{"op": "listen", "mode": "dictation"}`.
    fn start_dictation(&mut self, ws: &Peer, request: &Map<String, Value>) {
        if self.current.is_some() {
            send(
                Some(ws),
                json!({
                    "event": "error",
                    "session": null,
                    "error": "A voice call is going on",
                    "busy": true,
                }),
            );
            return;
        }
        self.preempt_dictations();
        let using = self.options.companion.dictation_cleaner();
        if let Some(using) = &using {
            using.warm();
        }
        let options = ListenOptions {
            language: listen_language(request.get("language")),
            end_silence_ms: Some(DICTATION_END_SILENCE_MS),
            ..ListenOptions::default()
        };
        let clean = using.map(|using| using.session(request));
        let key = self.key();
        let started = match self.helper.listen(self.listen_sink(key), options.clone()) {
            Ok(started) => started,
            Err(error) => {
                if let Some(clean) = &clean {
                    clean.close();
                }
                send(Some(ws), json!({"event": "error", "error": error}));
                return;
            }
        };
        let id = started.id();
        let token = random_uuid();
        self.listenings.insert(
            key,
            Listening {
                id,
                session: started,
                dictation: Some(Dictation {
                    segments: Vec::new(),
                    current: String::new(),
                    clean,
                    finished_at: None,
                    concluding: false,
                    deadline: None,
                    loading: false,
                    options,
                }),
                relay: None,
                token: token.clone(),
                ws: None,
                backlog: Vec::new(),
                cap: SilenceCap::default(),
                received: 0,
                over: false,
                via_call: false,
                timer: None,
                stall: None,
            },
        );
        self.by_id.insert(id, key);
        send(
            Some(ws),
            json!({"event": "listening", "session": id, "resume": token, "mode": "dictation"}),
        );
        self.attach(key, ws);
    }

    /// The voice chat's cleaning, in order: the final text waits for its
    /// cleaning, so events keep their order.
    fn relay(&self, key: u64, context: &str) -> Option<Relay> {
        let using = self.options.companion.chat_cleaner()?;
        using.warm();
        let session = Arc::new(Mutex::new(using.session(context)));
        let (events, mut received) = mpsc::unbounded_channel::<Map<String, Value>>();
        let me = self.me.clone();
        let current = session.clone();
        let helper = self.helper.clone();
        let companion = self.options.companion.clone();
        let clock = self.options.clock.clone();
        let debug = self.options.debug.clone();
        let context = context.to_owned();
        tokio::spawn(async move {
            while let Some(mut event) = received.recv().await {
                let kind = event.get("event").and_then(Value::as_str).unwrap_or("");
                let text = text_of(&event, "text");
                if kind == "partial" && !text.is_empty() {
                    let pause = event.get("pause") == Some(&Value::Bool(true));
                    lock(&current).partial(&text, pause);
                }
                if kind == "final" && !text.is_empty() {
                    let started = clock.monotonic();
                    let cleaning = lock(&current).clone();
                    let Ok(mut cleaned) = cleaning.final_text(&text).await else {
                        continue;
                    };
                    // Not surely the speaker's voice (the helper): not for
                    // the agent, whatever the cleaner made of it.
                    if event.get("for_agent") == Some(&Value::Bool(false)) {
                        cleaned.for_agent = false;
                    }
                    // Clearly another voice, and no companion to judge it.
                    let voice = event.get("voice");
                    let other = voice
                        .is_some_and(|voice| !companion.fronted() && helper.is_other_voice(voice));
                    if other {
                        cleaned.for_agent = false;
                    }
                    let label = voice
                        .filter(|voice| js_truthy(voice))
                        .map_or(String::new(), |voice| helper.voice_label(voice));
                    // Held words are shown as they were heard when nothing
                    // is left.
                    if !cleaned.for_agent && cleaned.text.is_empty() {
                        cleaned.text = text.clone();
                    }
                    if let Some(debug) = &debug {
                        debug(&format!(
                            "[voice] cleaned in {} ms{}{}: {}\n[voice]   heard: {text}",
                            js::number_text(js::round(clock.monotonic() - started)),
                            if cleaned.for_agent {
                                ""
                            } else if other {
                                ", not for the agent (another voice)"
                            } else {
                                ", not for the agent"
                            },
                            if label.is_empty() {
                                String::new()
                            } else {
                                format!(" [{label}]")
                            },
                            cleaned.text
                        ));
                    }
                    *lock(&current) = using.session(&context);
                    event.insert("text".into(), json!(cleaned.text));
                    event.insert("raw".into(), json!(text));
                    event.insert("for_agent".into(), json!(cleaned.for_agent));
                }
                post(&me, Input::Relayed(key, event));
            }
        });
        Some(Relay { events, session })
    }

    /// `{"op": "listen"}`: the voice chat.
    fn start_listening(&mut self, ws: &Peer, request: &Map<String, Value>) {
        self.preempt_dictations();
        let key = self.key();
        let context = request
            .get("context")
            .and_then(Value::as_str)
            .map(|context| js::slice16(context, -CONTEXT_CHARS, None));
        let relay = context
            .as_deref()
            .and_then(|context| self.relay(key, context));
        // Its call's microphone (WebRTC), when the page says it carries the
        // audio: only on the socket owning that call.
        let via_call = self
            .owns(ws)
            .and_then(|owned| self.calls[&owned].handle.as_ref().map(|handle| handle.id()))
            .filter(|id| is_id(request.get("call"), *id));
        let end_silence_ms = request
            .get("end_silence_ms")
            .and_then(Value::as_f64)
            .filter(|ms| (300.0..=10_000.0).contains(ms));
        let options = ListenOptions {
            hold: request.get("hold") == Some(&Value::Bool(true)),
            language: listen_language(request.get("language")),
            end_silence_ms,
            new_speaker: request.get("new_speaker") == Some(&Value::Bool(true)),
            call: via_call,
        };
        let started = match self.helper.listen(self.listen_sink(key), options) {
            Ok(started) => started,
            Err(error) => {
                if let Some(relay) = relay {
                    lock(&relay.session).close();
                }
                send(Some(ws), json!({"event": "error", "error": error}));
                return;
            }
        };
        let id = started.id();
        let token = random_uuid();
        let cap = SilenceCap::new(max_pause_ms((self.options.max_pause)().as_ref()));
        self.listenings.insert(
            key,
            Listening {
                id,
                session: started,
                dictation: None,
                relay,
                token: token.clone(),
                ws: None,
                backlog: Vec::new(),
                cap,
                received: 0,
                over: false,
                via_call: via_call.is_some(),
                timer: None,
                stall: None,
            },
        );
        self.by_id.insert(id, key);
        send(
            Some(ws),
            json!({"event": "listening", "session": id, "resume": token}),
        );
        self.attach(key, ws);
    }

    // The socket's messages.

    fn audio(&mut self, ws: &Peer, samples: &[u8]) {
        let Some(key) = self.by_socket.get(&key_of(ws)).copied() else {
            return;
        };
        let Some(listening) = self.listenings.get(&key) else {
            return;
        };
        // The stream came back on this socket after a stall.
        if listening
            .ws
            .as_ref()
            .is_none_or(|held| key_of(held) != key_of(ws))
        {
            self.attach(key, ws);
        } else {
            self.watch_stall(key);
        }
        let Some(listening) = self.listenings.get_mut(&key) else {
            return;
        };
        listening.received += samples.len() as u64;
        listening.session.audio(samples);
        if listening.dictation.is_none() && listening.cap.audio(samples.len() as f64) {
            let listening = &self.listenings[&key];
            self.pause_ends(listening);
        }
    }

    fn message(&mut self, ws: &Peer, text: &str) {
        let Ok(Value::Object(request)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let socket = key_of(ws);
        let listening = self.by_socket.get(&socket).copied();
        // Its socket speaks: a session stalled on it gets what it missed.
        if let Some(key) = listening
            && self
                .listenings
                .get(&key)
                .is_some_and(|held| held.ws.as_ref().is_none_or(|held| key_of(held) != socket))
        {
            self.attach(key, ws);
        }
        let op = request.get("op").and_then(Value::as_str).unwrap_or("");
        let mode = request.get("mode").and_then(Value::as_str);
        match op {
            "listen" => {
                self.stop(ws);
                if mode == Some("dictation") {
                    self.start_dictation(ws, &request);
                } else {
                    self.start_listening(ws, &request);
                }
            }
            "resume" => self.resume(ws, &request),
            "release" => {
                if let Some(held) = listening.and_then(|key| self.listenings.get(&key)) {
                    held.session.release();
                }
            }
            "finish" => {
                if let Some(key) = listening {
                    self.finish_listening(key);
                }
            }
            "warm" => {
                if mode != Some("dictation") {
                    return;
                }
                let using = self.options.companion.dictation_cleaner();
                if let Some(using) = &using {
                    using.warm();
                }
                send(
                    Some(ws),
                    json!({"event": "warm", "mode": "dictation", "cleaner": using.is_some()}),
                );
            }
            "stop" => self.stop(ws),
            "call_audio" => self.call_audio(ws, &request),
            "call_handoff" => self.call_handoff(ws, &request),
            "call_carry" => self.call_carry(ws, &request),
            "call_mute_state" => {
                // The page's Mute changed: the app carrying the call shows it.
                let Some(call) = self.owns(ws) else {
                    return;
                };
                let Some(muted) = request.get("muted").and_then(Value::as_bool) else {
                    return;
                };
                let state = self.calls.get_mut(&call).expect("owned call");
                let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
                    return;
                };
                if !is_id(request.get("call"), id) {
                    return;
                }
                state.muted = muted;
                if let Some(carrier) = state.carrier.as_ref().filter(|carrier| carrier.joined) {
                    send(
                        carrier.ws.as_ref(),
                        json!({"event": "call_mute", "call": id, "muted": muted}),
                    );
                }
            }
            "call_mute" => {
                // The app's Mute: the page mutes as its own button does.
                let Some(call) = self.carried(ws) else {
                    return;
                };
                let state = &self.calls[&call];
                let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
                    return;
                };
                let Some(muted) = request.get("muted").and_then(Value::as_bool) else {
                    return;
                };
                if !is_id(request.get("call"), id) {
                    return;
                }
                let page = state.ws.clone();
                self.debug(format!(
                    "call {id}: the app {} the call",
                    if muted { "mutes" } else { "unmutes" }
                ));
                send(
                    page.as_ref(),
                    json!({"event": "call_mute", "call": id, "muted": muted}),
                );
            }
            "call_carry_end" => {
                if let Some(call) = self.carried(ws) {
                    self.carrier_left(call, "The Roamgate app gave the call back", false);
                }
            }
            "call_output" => {
                // The page picks where the app plays the call.
                let Some(call) = self.owns(ws) else {
                    return;
                };
                let state = &self.calls[&call];
                let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
                    return;
                };
                let Some(carrier) = state.carrier.as_ref().filter(|carrier| carrier.joined) else {
                    return;
                };
                let Some(output) = request
                    .get("output")
                    .and_then(Value::as_str)
                    .filter(|output| !output.is_empty() && js::len16(output) <= 128)
                else {
                    return;
                };
                send(
                    carrier.ws.as_ref(),
                    json!({"event": "call_output", "call": id, "output": output}),
                );
            }
            "call_output_state" => self.call_output_state(ws, &request),
            "call_hush" => {
                if let Some(call) = self.owns(ws)
                    && let Some(handle) = &self.calls[&call].handle
                {
                    handle.hush();
                }
            }
            "call_resume" => self.call_resume(ws, &request),
            "call_ice" => {
                let Some(call) = self.owns(ws).or_else(|| self.carried(ws)) else {
                    return;
                };
                let Some(line) = request
                    .get("line")
                    .and_then(Value::as_str)
                    .filter(|line| !line.is_empty())
                else {
                    return;
                };
                let state = self.calls.get_mut(&call).expect("current call");
                let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
                    return;
                };
                state.ice_lines += 1;
                if state.ice_lines > CALL_ICE_LINES {
                    return;
                }
                let from = if state.ws.as_ref().is_some_and(|page| key_of(page) == socket) {
                    "page"
                } else {
                    "app"
                };
                let flat = collapse_newlines(line);
                (self.options.errors)(&format!(
                    "[voice] call {id} ({from}): {}",
                    js::slice16(&flat, 0, Some(CALL_ICE_CHARS))
                ));
            }
            "call_microphone" => self.call_microphone(ws, &request),
            _ => {}
        }
    }

    fn resume(&mut self, ws: &Peer, request: &Map<String, Value>) {
        let found = whole(request.get("session"))
            .and_then(|id| self.by_id.get(&id).copied())
            .filter(|key| {
                self.listenings.get(key).is_some_and(|held| {
                    request.get("resume").and_then(Value::as_str) == Some(held.token.as_str())
                })
            });
        let Some(key) = found else {
            let mut message = if request.get("mode") == Some(&json!("dictation")) {
                object(json!({"event": "error"}))
            } else {
                object(json!({"event": "resume_failed"}))
            };
            put(&mut message, "session", request.get("session"));
            if request.get("mode") == Some(&json!("dictation")) {
                message.insert("error".into(), json!("unknown session"));
                message.insert("recoverable".into(), json!(false));
            }
            send(Some(ws), Value::Object(message));
            return;
        };
        let held = &self.listenings[&key];
        let (id, received) = (held.id, held.received);
        self.debug(format!("session {id} resumed on a new socket"));
        send(
            Some(ws),
            json!({"event": "resumed", "session": id, "received": received}),
        );
        self.attach(key, ws);
    }

    fn call_audio(&mut self, ws: &Peer, request: &Map<String, Value>) {
        if request.get("on") == Some(&Value::Bool(false)) {
            // With its number, that call only (a late answer's page).
            let numbered = !request.get("call").is_some_and(Value::is_number)
                || self
                    .current_state()
                    .and_then(|state| state.handle.as_ref())
                    .is_some_and(|handle| is_id(request.get("call"), handle.id()));
            if self.owns(ws).is_some() && numbered {
                self.stop_call(self.current, "The call ended");
            } else if self.carried(ws).is_some() && numbered {
                // The app's hang-up ends the call for the page too.
                self.stop_call(self.current, "Hung up in the Roamgate app");
            }
        } else if self.carried(ws).is_none() {
            self.start_call(ws);
        }
    }

    fn call_handoff(&mut self, ws: &Peer, request: &Map<String, Value>) {
        // The page hands its call to the Android app: a token to give it.
        let found = self.owns(ws).and_then(|call| {
            let handle = self.calls[&call].handle.as_ref()?;
            is_id(request.get("call"), handle.id()).then_some((call, handle.id()))
        });
        let Some((call, id)) = found else {
            let mut message = object(json!({"event": "call_handoff"}));
            put(&mut message, "call", request.get("call"));
            message.insert("error".into(), json!("No such call"));
            send(Some(ws), Value::Object(message));
            return;
        };
        self.handoffs.retain(|_, (given, _)| *given != call);
        let handoff = random_token();
        let expires = self.options.clock.now() + HANDOFF_MS as i64;
        self.handoffs.insert(handoff.clone(), (call, expires));
        self.debug(format!("call {id}: a handoff to the app is offered"));
        send(
            Some(ws),
            json!({
                "event": "call_handoff",
                "call": id,
                "handoff": handoff,
                "expires_ms": HANDOFF_MS,
            }),
        );
    }

    fn call_carry(&mut self, ws: &Peer, request: &Map<String, Value>) {
        // The app takes the legs it carries, with its carrier token.
        let refuse = |ws: &Peer| {
            let mut message = object(json!({"event": "call_carry"}));
            put(&mut message, "call", request.get("call"));
            message.insert("error".into(), json!("No such call"));
            send(Some(ws), Value::Object(message));
        };
        let Some(call) = self.current else {
            refuse(ws);
            return;
        };
        let state = &self.calls[&call];
        let (Some(handle), Some(carrier)) = (state.handle.clone(), state.carrier.as_ref()) else {
            refuse(ws);
            return;
        };
        let id = handle.id();
        if !is_id(request.get("call"), id)
            || request.get("carrier").and_then(Value::as_str) != Some(carrier.token.as_str())
        {
            refuse(ws);
            return;
        }
        let legs: Vec<&'static str> = match request.get("legs").and_then(Value::as_array) {
            Some(asked) => CARRIED_LEGS
                .into_iter()
                .filter(|leg| asked.iter().any(|each| each == leg))
                .collect(),
            None => vec!["microphone"],
        };
        if legs.is_empty() {
            send(
                Some(ws),
                json!({"event": "call_carry", "call": id, "error": "No leg to carry"}),
            );
            return;
        }
        let state = self.calls.get_mut(&call).expect("current call");
        let carrier = state.carrier.as_mut().expect("carrier");
        let timer = carrier.timer.take();
        if !legs.contains(&"microphone") {
            carrier.heard = false;
        }
        carrier.ws = Some(ws.clone());
        carrier.legs = legs.clone();
        carrier.joined = true;
        // None until the helper's replies producer registered: a
        // call_replies_peer follows then.
        let replies_peer = state.replies.as_ref().and_then(|watch| watch.peer.clone());
        carrier.told_peer = replies_peer.clone();
        let watching = state.replies.is_some() || state.replies_retry.is_some();
        self.clear_timer(timer);
        self.debug(format!("call {id}: the app carries {}", legs.join(" and ")));
        if !watching {
            self.watch_replies(call);
        }
        let state = &self.calls[&call];
        send(
            Some(ws),
            json!({
                "event": "call_carry",
                "call": id,
                "ok": true,
                "legs": legs,
                "restarts": state.restarts,
                "waiting": handle.music_waiting(),
                "replies_peer": replies_peer,
            }),
        );
        send(
            Some(ws),
            json!({"event": "call_mute", "call": id, "muted": state.muted}),
        );
        let carrier = state.carrier.as_ref().expect("carrier");
        send(state.ws.as_ref(), Self::carrier_state(state, carrier));
        if let Some(outputs) = &carrier.outputs {
            send(state.ws.as_ref(), Value::Object(outputs.clone()));
        }
    }

    fn call_output_state(&mut self, ws: &Peer, request: &Map<String, Value>) {
        // Where the app plays the call, and what else it could: for the page.
        let Some(call) = self.carried(ws) else {
            return;
        };
        let state = self.calls.get_mut(&call).expect("current call");
        let Some(id) = state.handle.as_ref().map(|handle| handle.id()) else {
            return;
        };
        let Some(carrier) = state.carrier.as_mut() else {
            return;
        };
        let outputs: Vec<Value> = request
            .get("outputs")
            .and_then(Value::as_array)
            .map(|outputs| {
                outputs
                    .iter()
                    .filter_map(|each| {
                        let each = each.as_object()?;
                        let id = each
                            .get("id")?
                            .as_str()
                            .filter(|id| !id.is_empty() && js::len16(id) <= 128)?;
                        let kind = each
                            .get("kind")?
                            .as_str()
                            .filter(|kind| OUTPUT_KINDS.contains(kind))?;
                        let label = each
                            .get("label")
                            .and_then(Value::as_str)
                            .map_or(String::new(), |label| js::slice16(label, 0, Some(64)));
                        Some(json!({"id": id, "kind": kind, "label": label}))
                    })
                    .take(16)
                    .collect()
            })
            .unwrap_or_default();
        let current = request
            .get("current")
            .and_then(Value::as_str)
            .filter(|current| outputs.iter().any(|each| each["id"] == *current));
        let told = object(json!({
            "event": "call_output_state",
            "call": id,
            "current": current,
            "outputs": outputs,
        }));
        carrier.outputs = Some(told.clone());
        send(state.ws.as_ref(), Value::Object(told));
    }

    fn call_resume(&mut self, ws: &Peer, request: &Map<String, Value>) {
        let found = self.current.filter(|call| {
            let state = &self.calls[call];
            state
                .handle
                .as_ref()
                .is_some_and(|handle| is_id(request.get("call"), handle.id()))
                && request.get("resume").and_then(Value::as_str) == Some(state.token.as_str())
        });
        let Some(call) = found else {
            let mut message = object(json!({"event": "call_audio"}));
            put(&mut message, "call", request.get("call"));
            message.insert("error".into(), json!("The call's audio ended"));
            send(Some(ws), Value::Object(message));
            return;
        };
        let state = self.calls.get_mut(&call).expect("current call");
        let timer = state.timer.take();
        state.ws = Some(ws.clone());
        let handle = state.handle.clone().expect("started call");
        let restarts = state.restarts;
        self.clear_timer(timer);
        self.debug(format!("call {}: moved to a new socket", handle.id()));
        send(
            Some(ws),
            json!({
                "event": "call_audio",
                "call": handle.id(),
                "resumed": true,
                "restarts": restarts,
                "waiting": handle.music_waiting(),
            }),
        );
        // The app still carries it: the page's new socket learns so.
        let state = &self.calls[&call];
        if let Some(carrier) = state.carrier.as_ref().filter(|carrier| carrier.joined) {
            send(Some(ws), Self::carrier_state(state, carrier));
            if let Some(outputs) = &carrier.outputs {
                send(Some(ws), Value::Object(outputs.clone()));
            }
        }
    }

    fn call_microphone(&mut self, ws: &Peer, request: &Map<String, Value>) {
        let app = self.carried(ws);
        let from = if app.is_some() { "app" } else { "page" };
        let owner = self.owns(ws).or(app);
        let Some(handle) = owner.and_then(|call| self.calls[&call].handle.clone()) else {
            return;
        };
        let Some(peer) = request
            .get("peer")
            .and_then(Value::as_str)
            .filter(|peer| !peer.is_empty() && js::len16(peer) <= 128)
        else {
            return;
        };
        let carrier = app.and_then(|call| {
            let carrier = self.calls[&call].carrier.as_ref()?;
            Some((call, carrier.serial, carrier.legs.contains(&"microphone")))
        });
        let app_carries_microphone = self
            .current_state()
            .and_then(|state| state.carrier.as_ref())
            .is_some_and(|carrier| carrier.joined && carrier.legs.contains(&"microphone"));
        if app.is_none() && app_carries_microphone {
            // The app carries the microphone: the page's is not listened to.
            send(
                Some(ws),
                json!({
                    "event": "call_microphone",
                    "call": handle.id(),
                    "error": "The Roamgate app carries the microphone",
                }),
            );
            return;
        }
        if app.is_some() && !carrier.is_some_and(|(_, _, microphone)| microphone) {
            return;
        }
        // Who cancels the replies' echo: the helper ("here"), or the page.
        let echo_here = request.get("echo") == Some(&json!("here"));
        self.debug(format!(
            "call {}: the {from}'s microphone is {peer}, the echo cancelled {}",
            handle.id(),
            if echo_here {
                "by the helper".to_owned()
            } else {
                format!("by the {from}")
            }
        ));
        let asked = handle.microphone(peer, echo_here);
        let me = self.me.clone();
        let ws = ws.clone();
        let peer = peer.to_owned();
        let id = handle.id();
        let app = carrier.map(|(call, serial, _)| (call, serial));
        tokio::spawn(async move {
            let result = asked.await;
            post(
                &me,
                Input::Microphone {
                    ws,
                    handle: id,
                    app,
                    peer,
                    result,
                },
            );
        });
    }

    fn microphone_answered(
        &mut self,
        ws: &Peer,
        id: u64,
        app: Option<(u64, u64)>,
        peer: &str,
        result: Result<(), String>,
    ) {
        let carrier = app.and_then(|(call, serial)| {
            self.calls
                .get_mut(&call)
                .filter(|state| {
                    state
                        .carrier
                        .as_ref()
                        .is_some_and(|carrier| carrier.serial == serial)
                })
                .map(|_| call)
        });
        match result {
            Ok(()) => {
                self.debug(format!("call {id}: the helper listens to {peer}"));
                send(
                    Some(ws),
                    json!({"event": "call_microphone", "call": id, "ok": true}),
                );
                // The page's listenings hear the app's microphone now.
                if let Some(call) = carrier {
                    let state = self.calls.get_mut(&call).expect("carried call");
                    let carrier = state.carrier.as_mut().expect("carrier");
                    carrier.heard = true;
                    let state = &self.calls[&call];
                    let told = Self::carrier_state(state, state.carrier.as_ref().expect("carrier"));
                    send(state.ws.as_ref(), told);
                }
            }
            Err(error) => {
                self.debug(format!("call {id}: the helper cannot listen: {error}"));
                if let Some(call) = carrier {
                    let state = self.calls.get_mut(&call).expect("carried call");
                    let carrier = state.carrier.as_mut().expect("carrier");
                    if carrier.heard {
                        carrier.heard = false;
                        let state = &self.calls[&call];
                        let told =
                            Self::carrier_state(state, state.carrier.as_ref().expect("carrier"));
                        send(state.ws.as_ref(), told);
                    }
                }
                send(
                    Some(ws),
                    json!({"event": "call_microphone", "call": id, "error": error}),
                );
            }
        }
    }

    fn close(&mut self, ws: &Peer) {
        let socket = key_of(ws);
        if let Some(key) = self.by_socket.get(&socket).copied() {
            self.detach(key, Detach::SocketClosed);
        }
        if let Some(call) = self.current {
            let carrier = self.calls[&call].carrier.as_ref().and_then(|carrier| {
                carrier
                    .ws
                    .as_ref()
                    .is_some_and(|app| key_of(app) == socket)
                    .then_some((carrier.serial, carrier.timer))
            });
            if let Some((serial, timer)) = carrier {
                // The app may come back on a new socket (call_carry again).
                self.clear_timer(timer);
                let timer = self.set_timer(
                    DETACHED_MS,
                    TimerKind::Carrier(call, serial, "The Roamgate app's link went"),
                );
                if let Some(carrier) = self
                    .calls
                    .get_mut(&call)
                    .and_then(|state| state.carrier.as_mut())
                {
                    carrier.ws = None;
                    carrier.timer = Some(timer);
                }
            }
            if self.owns(ws).is_some() {
                // Its packets are dropped until a resume, or it stops.
                let state = self.calls.get_mut(&call).expect("current call");
                state.ws = None;
                let timer = state.timer.take();
                self.clear_timer(timer);
                let timer = self.set_timer(DETACHED_MS, TimerKind::CallDetached(call));
                if let Some(state) = self.calls.get_mut(&call) {
                    state.timer = Some(timer);
                }
            }
        }
    }
}

/// JavaScript's truthiness of a JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `text.replace(/[\r\n]+/g, " | ")`.
fn collapse_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for character in text.chars() {
        if character == '\r' || character == '\n' {
            if !in_break {
                out.push_str(" | ");
                in_break = true;
            }
        } else {
            in_break = false;
            out.push(character);
        }
    }
    out
}

/// A dictation's words so far, as heard.
fn heard_so_far(state: &Dictation) -> String {
    state
        .segments
        .iter()
        .chain(std::iter::once(&state.current))
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A dictation's end: the cleaned text, or the words as heard
/// (voice-dictation.ts dictated, its cleaning the companion's).
async fn dictated(session: Option<Arc<dyn DictationSession>>, raw: &str) -> Dictated {
    let heard = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if heard.is_empty() {
        return Dictated {
            text: String::new(),
            cleaned: true,
        };
    }
    match session {
        None => Dictated {
            text: heard,
            cleaned: false,
        },
        Some(session) => session.clean(&heard).await,
    }
}
