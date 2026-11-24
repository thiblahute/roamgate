//! The voice helper's supervisor (server/src/voice/voice-helper.ts,
//! VoiceHelper): starts the helper (voice/helper) on first use, passes
//! requests to it in frames, hands its events to listening sessions and
//! calls, restarts it when it dies, gets stuck or writes something that is
//! not a frame, makes its calls again in a new one, and stops it after
//! `helper_idle_exit_minutes` with nothing to do.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::Engine as _;
use indexmap::IndexMap;
use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_base::log::{LogFields, Logger};
#[cfg(test)]
use roamgate_protocol::frames::FrameReader;
use roamgate_protocol::frames::{self, FrameError};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{CallBackground, TtsModel, VoiceConfig, WRAPPED_EXIT_MS, max_pause_ms};
use crate::js;
use crate::kokoro_language::{cannot_read_notice, kokoro_voice, light_cannot_read};
use crate::speakers::{SpeakerTracker, parse_voice_tag, without_prints};
use crate::speech_rate::{playback_rate_for, speech_rate_or};

/// How long a ping may take before the helper's output is taken as unread.
pub const PING_MS: u64 = 2000;
/// The longest a sentence may take to be made before the helper is stuck.
pub const SPEAK_STUCK_MS: u64 = 15_000;
/// The same for the first sentence with a voice, or into a call's mix.
pub const SPEAK_COLD_MS: u64 = 45_000;
/// How long Kokoro reads after a stuck speaker was restarted.
pub const KOKORO_AFTER_STUCK_MS: i64 = 5 * 60_000;
/// How long Kokoro reads after a sentence its speaker failed.
pub const KOKORO_AFTER_FAILURE_MS: i64 = 30_000;

pub const HELPER_STOPPED: &str = "The voice helper stopped";

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;
/// voice.json as the helper is to start with (the low-GPU profile's).
pub type ConfigSource = Arc<dyn Fn() -> Result<VoiceConfig, String> + Send + Sync>;
/// voice.json's valid `speech_rate` and `max_pause_ms`, read whatever else
/// it holds.
pub type StoredSettings = Arc<dyn Fn() -> Map<String, Value> + Send + Sync>;
/// Where a session's or a call's events go.
pub type EventSink = Arc<dyn Fn(Map<String, Value>) + Send + Sync>;
/// Where the `[voice]` lines go (the server's stderr).
pub type ErrorSink = Arc<dyn Fn(&str) + Send + Sync>;
/// A frame the helper wrote, or what was not one.
pub type FrameItem = Result<(u8, Vec<u8>), FrameError>;
/// A sentence's answer and the rate it was made at.
type Spoken = Result<(Map<String, Value>, f64), String>;

/// A running helper process.
pub trait HelperProcess: Send + Sync {
    /// Writes a frame on its input.
    fn write(&self, frame: Vec<u8>);
    /// Stops it (a wrapped one by closing its input first).
    fn kill(&self);
    /// Its process, sampled before a stuck one is stopped.
    fn pid(&self) -> Option<u32> {
        None
    }
}

/// A helper just spawned: its process, its frames, and its end.
pub struct Spawned {
    pub process: Arc<dyn HelperProcess>,
    pub frames: mpsc::UnboundedReceiver<FrameItem>,
    /// Turns true once it exited.
    pub exited: watch::Receiver<bool>,
}

pub type Spawn = Arc<dyn Fn(&VoiceConfig) -> Result<Spawned, String> + Send + Sync>;

/// What restarted the helper last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Why {
    Stuck,
    Unreadable,
    Models,
}

#[derive(Clone)]
struct Running {
    generation: u64,
    process: Arc<dyn HelperProcess>,
    exited: watch::Receiver<bool>,
}

struct Listener {
    generation: u64,
    on_event: EventSink,
}

struct RunningCall {
    /// Tells an entry from one made under the same number later.
    serial: u64,
    event: EventSink,
    background: CallBackground,
    port: u64,
    started: bool,
    waiting: bool,
    told: bool,
    hushes: u64,
}

#[derive(Default, Clone, Copy)]
struct Progress {
    reports: bool,
    ready: bool,
    loading: bool,
}

#[derive(Default, Clone, Copy)]
struct SpeakTimes {
    sent_at: f64,
    started_at: Option<f64>,
    audio_at: Option<f64>,
}

type Pending = oneshot::Sender<Result<Map<String, Value>, String>>;

struct State {
    process: Option<Running>,
    generation: u64,
    pending: IndexMap<u64, Pending>,
    listeners: IndexMap<u64, Listener>,
    speak_times: IndexMap<u64, SpeakTimes>,
    next_id: u64,
    next_session: u64,
    next_call: u64,
    next_serial: u64,
    calls: IndexMap<u64, RunningCall>,
    /// The calls being made again after the helper restarted: true once done.
    calls_back: watch::Receiver<bool>,
    stopping: bool,
    native_rate: f64,
    speaking: u64,
    speak_watch: Option<tokio::task::JoinHandle<()>>,
    progress: Progress,
    warm: HashSet<String>,
    speak_queue: Vec<String>,
    kokoro_until: i64,
    restarts: u64,
    restarted_for: Why,
    watch_arms: u64,
    idle_ms: f64,
    idle_deadline: Option<i64>,
    idle_timer: bool,
    low_gpu: Option<String>,
    /// The running helper's models when only the light voice reads in it.
    light_only: Option<Option<Vec<TtsModel>>>,
    youtube: IndexMap<u64, EventSink>,
    next_listener: u64,
}

/// Awaited as a call starts, before the helper is asked for it.
pub type BeforeCall = Arc<dyn Fn() -> BoxFuture<Result<(), String>> + Send + Sync>;

struct Inner {
    config: ConfigSource,
    spawn: Spawn,
    save_speech_rate: Arc<dyn Fn(f64) -> Result<(), String> + Send + Sync>,
    save_max_pause: Arc<dyn Fn(f64) -> Result<(), String> + Send + Sync>,
    /// The valid reading settings of a voice.json that is no usable
    /// configuration (readVoiceConfig's `stored`).
    stored: StoredSettings,
    clock: SharedClock,
    errors: ErrorSink,
    log: Logger,
    state: Mutex<State>,
    speakers: Mutex<SpeakerTracker>,
    before_call: Mutex<Option<BeforeCall>>,
    sample_hangs: Mutex<bool>,
}

/// Options of a listening session.
#[derive(Debug, Clone, Default)]
pub struct ListenOptions {
    pub hold: bool,
    pub language: Option<String>,
    pub end_silence_ms: Option<f64>,
    pub new_speaker: bool,
    pub call: Option<u64>,
}

/// A sentence made into a file.
#[derive(Debug, Clone, PartialEq)]
pub struct Speech {
    pub audio: Vec<u8>,
    pub language: String,
    pub native_rate: f64,
}

/// A sentence put into a call's mix.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedSpeech {
    pub start_ms: f64,
    pub duration_ms: f64,
    pub now_ms: f64,
    pub language: String,
    pub native_rate: f64,
}

/// A voice cloned from a recording.
#[derive(Debug, Clone, PartialEq)]
pub struct ClonedVoice {
    pub embedding: Vec<Value>,
    pub codes: Vec<Value>,
    pub heard: String,
    pub seconds: f64,
}

/// What reloadModels did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reload {
    Now,
    AfterCall,
    NotRunning,
}

impl Reload {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Now => "now",
            Self::AfterCall => "after-call",
            Self::NotRunning => "not-running",
        }
    }
}

/// Starts the helper on first use and passes requests to it.
#[derive(Clone)]
pub struct VoiceHelper {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Whether a `tts_models` entry is the light voice's.
fn is_light(entry: &TtsModel) -> bool {
    matches!(
        entry.get("model").and_then(Value::as_str),
        Some("kokoro" | "pocket-tts")
    )
}

/// Whether `models` are the light voice's only (None: the configured ones).
fn only_light(models: Option<&[TtsModel]>) -> bool {
    models.is_some_and(|models| models.iter().all(is_light))
}

fn light_name(models: Option<&[TtsModel]>) -> &'static str {
    if models.is_some_and(|models| {
        models
            .iter()
            .any(|entry| entry.get("model").and_then(Value::as_str) == Some("pocket-tts"))
    }) {
        "Pocket TTS"
    } else {
        "Kokoro"
    }
}

/// Whether a sentence's error is its speaker's.
pub fn speaker_failed(message: &str) -> bool {
    !(message.starts_with("no call")
        || message.starts_with("nothing to say")
        || message.starts_with(HELPER_STOPPED))
}

fn models_json(models: &[TtsModel]) -> String {
    js::stringify(&Value::Array(
        models.iter().cloned().map(Value::Object).collect(),
    ))
}

impl VoiceHelper {
    pub fn new(config: ConfigSource, spawn: Spawn) -> Self {
        Self::with(config, spawn, Arc::new(SystemClock), Logger::silent())
    }

    pub fn with(config: ConfigSource, spawn: Spawn, clock: SharedClock, log: Logger) -> Self {
        let (_, done) = watch::channel(true);
        Self {
            inner: Arc::new(Inner {
                config,
                spawn,
                save_speech_rate: Arc::new(|_| Ok(())),
                save_max_pause: Arc::new(|_| Ok(())),
                stored: Arc::new(Map::new),
                clock,
                errors: Arc::new(|line| eprintln!("{line}")),
                log,
                state: Mutex::new(State {
                    process: None,
                    generation: 0,
                    pending: IndexMap::new(),
                    listeners: IndexMap::new(),
                    speak_times: IndexMap::new(),
                    next_id: 1,
                    next_session: 1,
                    next_call: 1,
                    next_serial: 1,
                    calls: IndexMap::new(),
                    calls_back: done,
                    stopping: false,
                    native_rate: 1.0,
                    speaking: 0,
                    speak_watch: None,
                    progress: Progress::default(),
                    warm: HashSet::new(),
                    speak_queue: Vec::new(),
                    kokoro_until: 0,
                    restarts: 0,
                    restarted_for: Why::Stuck,
                    watch_arms: 0,
                    idle_ms: 0.0,
                    idle_deadline: None,
                    idle_timer: false,
                    low_gpu: None,
                    light_only: None,
                    youtube: IndexMap::new(),
                    next_listener: 1,
                }),
                speakers: Mutex::new(SpeakerTracker::new(None)),
                before_call: Mutex::new(None),
                sample_hangs: Mutex::new(true),
            }),
        }
    }

    /// Where `speech_rate` and `max_pause_ms` are kept (voice.json).
    pub fn with_savers(
        mut self,
        speech_rate: Arc<dyn Fn(f64) -> Result<(), String> + Send + Sync>,
        max_pause: Arc<dyn Fn(f64) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        let inner = Arc::get_mut(&mut self.inner).expect("not shared yet");
        inner.save_speech_rate = speech_rate;
        inner.save_max_pause = max_pause;
        self
    }

    /// Where the `[voice]` lines go.
    /// Where the reading settings of an unusable voice.json come from.
    pub fn with_stored(mut self, stored: StoredSettings) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("not shared yet")
            .stored = stored;
        self
    }

    pub fn with_errors(mut self, errors: ErrorSink) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("not shared yet")
            .errors = errors;
        self
    }

    pub fn set_before_call(&self, hook: Option<BeforeCall>) {
        *lock(&self.inner.before_call) = hook;
    }

    pub fn set_sample_hangs(&self, sample: bool) {
        *lock(&self.inner.sample_hangs) = sample;
    }

    /// Which voice is the user's on the call, learnt as it goes.
    pub fn speakers(&self) -> MutexGuard<'_, SpeakerTracker> {
        lock(&self.inner.speakers)
    }

    fn error(&self, line: &str) {
        (self.inner.errors)(line);
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.inner.state)
    }

    fn now(&self) -> i64 {
        self.inner.clock.now()
    }

    /// The longest pause before a turn that sounded finished ends.
    pub fn max_pause_ms(&self) -> f64 {
        match (self.inner.config)() {
            Ok(config) => max_pause_ms(config.get("max_pause_ms")),
            Err(_) => max_pause_ms((self.inner.stored)().get("max_pause_ms")),
        }
    }

    pub fn set_max_pause_ms(&self, ms: f64) -> Result<(), String> {
        (self.inner.save_max_pause)(ms)
    }

    /// How fast replies are read (`speech_rate`).
    pub fn speech_rate(&self) -> f64 {
        match (self.inner.config)() {
            Ok(config) => config.speech_rate(),
            Err(_) => speech_rate_or((self.inner.stored)().get("speech_rate")),
        }
    }

    pub fn set_speech_rate(&self, rate: f64) -> Result<(), String> {
        (self.inner.save_speech_rate)(rate)
    }

    /// `{available: true}` or `{available: false, detail}`.
    pub fn status(&self) -> Value {
        match (self.inner.config)() {
            Ok(_) => json!({"available": true}),
            Err(detail) => json!({"available": false, "detail": detail}),
        }
    }

    fn start(&self) -> Result<Running, String> {
        let mut state = self.state();
        if let Some(running) = &state.process {
            return Ok(running.clone());
        }
        let config = (self.inner.config)()?;
        let spawned = (self.inner.spawn)(&config)?;
        state.generation += 1;
        let running = Running {
            generation: state.generation,
            process: spawned.process,
            exited: spawned.exited,
        };
        state.process = Some(running.clone());
        state.native_rate = config.native_speech_rate();
        state.idle_ms = config.idle_exit_ms();
        state.low_gpu = config.low_gpu().map(str::to_owned);
        let models = config.tts_models();
        state.light_only = (models.is_none() || only_light(models.as_deref())).then_some(models);
        drop(state);
        self.touch(running.generation);
        let reader = self.clone();
        let generation = running.generation;
        let mut frames = spawned.frames;
        tokio::spawn(async move {
            while let Some(item) = frames.recv().await {
                match item {
                    Ok((kind, payload)) => reader.frame(generation, kind, &payload),
                    Err(error) => {
                        reader.error(&format!(
                            "[voice] the helper's output is not frames, restarting it: {}",
                            error.bytes
                        ));
                        reader.restart(generation, Why::Unreadable);
                        break;
                    }
                }
            }
        });
        let watcher = self.clone();
        let mut exited = running.exited.clone();
        tokio::spawn(async move {
            let _ = exited.wait_for(|done| *done).await;
            watcher.exited(generation);
        });
        Ok(running)
    }

    fn frame(&self, generation: u64, kind: u8, payload: &[u8]) {
        self.touch(generation);
        if kind != frames::JSON {
            return;
        }
        let Ok(Value::Object(reply)) = serde_json::from_slice::<Value>(payload) else {
            return;
        };
        if reply.get("event").and_then(Value::as_str) == Some("speak_progress") {
            let stage = match reply.get("stage") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
            };
            {
                let now = self.inner.clock.monotonic();
                let mut state = self.state();
                if let Some(id) = reply.get("id").and_then(Value::as_u64)
                    && let Some(timed) = state.speak_times.get_mut(&id)
                {
                    if stage == "started" && timed.started_at.is_none() {
                        timed.started_at = Some(now);
                    }
                    if stage == "audio" && timed.audio_at.is_none() {
                        timed.audio_at = Some(now);
                    }
                }
            }
            self.speak_progress(generation, &stage);
            return;
        }
        if let Some(event) = reply.get("event").and_then(Value::as_str) {
            if event == "call_youtube" {
                let listeners: Vec<EventSink> = self.state().youtube.values().cloned().collect();
                for listener in listeners {
                    listener(reply.clone());
                }
                return;
            }
            if let Some(call) = reply.get("call").and_then(Value::as_f64) {
                let sink = {
                    let mut state = self.state();
                    match state
                        .calls
                        .get_mut(&(call as u64))
                        .filter(|_| call.fract() == 0.0)
                    {
                        Some(entry) => {
                            if event == "call_music" {
                                entry.waiting = reply.get("waiting") == Some(&Value::Bool(true));
                                entry.told = true;
                            }
                            Some(entry.event.clone())
                        }
                        None => None,
                    }
                };
                if let Some(sink) = sink {
                    sink(reply);
                }
                return;
            }
            self.dispatch(reply);
            return;
        }
        let Some(id) = reply.get("id").and_then(Value::as_u64) else {
            return;
        };
        let pending = self.state().pending.shift_remove(&id);
        if let Some(pending) = pending {
            let answer = match reply.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_owned()),
                None => Ok(reply),
            };
            let _ = pending.send(answer);
        }
    }

    /// The helper `generation` exited.
    fn exited(&self, generation: u64) {
        let (waiting, ended, stopping_calls, going) = {
            let mut state = self.state();
            if state
                .process
                .as_ref()
                .is_some_and(|running| running.generation == generation)
            {
                state.process = None;
                state.idle_deadline = None;
            }
            state.warm.clear();
            state.progress = Progress::default();
            let stopping = std::mem::take(&mut state.stopping);
            let waiting: Vec<Pending> = state
                .pending
                .drain(..)
                .map(|(_, pending)| pending)
                .collect();
            let going: Vec<(u64, u64)> = state
                .calls
                .iter()
                .filter(|(_, call)| call.started)
                .map(|(id, call)| (*id, call.serial))
                .collect();
            let ended: Vec<(u64, EventSink)> = state
                .listeners
                .iter()
                .filter(|(_, listener)| listener.generation == generation)
                .map(|(session, listener)| (*session, listener.on_event.clone()))
                .collect();
            for (session, _) in &ended {
                state.listeners.shift_remove(session);
            }
            let stopping_calls: Vec<(u64, EventSink)> = if stopping {
                state
                    .calls
                    .drain(..)
                    .map(|(id, call)| (id, call.event))
                    .collect()
            } else {
                Vec::new()
            };
            let going = if !stopping && !going.is_empty() {
                let (done, back) = watch::channel(false);
                state.calls_back = back;
                Some((going, done))
            } else {
                None
            };
            (waiting, ended, stopping_calls, going)
        };
        if let Some((calls, done)) = going {
            let helper = self.clone();
            tokio::spawn(async move {
                helper.restart_calls(calls).await;
                let _ = done.send(true);
            });
        }
        for pending in waiting {
            let _ = pending.send(Err(HELPER_STOPPED.into()));
        }
        for (session, on_event) in ended {
            on_event(object(json!({
                "event": "error",
                "session": session,
                "error": HELPER_STOPPED,
                "recoverable": true,
            })));
        }
        for (id, event) in stopping_calls {
            event(object(
                json!({"event": "call_ended", "call": id, "error": HELPER_STOPPED}),
            ));
        }
    }

    /// Restarts helper `generation`, if it is still the one running.
    fn restart(&self, generation: u64, why: Why) {
        let process = {
            let mut state = self.state();
            let Some(running) = state
                .process
                .clone()
                .filter(|running| running.generation == generation)
            else {
                return;
            };
            state.restarts += 1;
            state.restarted_for = why;
            if why == Why::Stuck {
                state.kokoro_until = self.now() + KOKORO_AFTER_STUCK_MS;
            }
            running.process
        };
        if why == Why::Stuck {
            let helper = self.clone();
            tokio::spawn(async move {
                helper.sample_stuck(process.as_ref()).await;
                process.kill();
            });
        } else {
            process.kill();
        }
    }

    /// An event goes to its session; one without (the helper failing) to all.
    fn dispatch(&self, mut event: Map<String, Value>) {
        if event.get("event").and_then(Value::as_str) == Some("final")
            && let Some(voice) = event.get("voice").cloned()
        {
            match parse_voice_tag(&voice) {
                Some(mut tag) => {
                    self.speakers().observe(Some(&mut tag));
                    event.insert("voice".into(), without_prints(&tag).to_json());
                }
                None => {
                    event.shift_remove("voice");
                }
            }
        }
        let sinks: Vec<EventSink> = {
            let state = self.state();
            match event.get("session").and_then(Value::as_f64) {
                Some(session) => state
                    .listeners
                    .get(&(session as u64))
                    .filter(|_| session.fract() == 0.0 && session >= 0.0)
                    .map(|listener| vec![listener.on_event.clone()])
                    .unwrap_or_default(),
                None => state
                    .listeners
                    .values()
                    .map(|listener| listener.on_event.clone())
                    .collect(),
            }
        };
        for sink in sinks {
            sink(event.clone());
        }
    }

    /// Whether helper `generation` answers a ping within `ms`.
    async fn answers(&self, generation: u64, ms: u64) -> bool {
        let (sender, receiver) = oneshot::channel();
        let (id, process) = {
            let mut state = self.state();
            let Some(running) = state
                .process
                .clone()
                .filter(|running| running.generation == generation)
            else {
                return true;
            };
            let id = state.next_id;
            state.next_id += 1;
            state.pending.insert(id, sender);
            (id, running.process)
        };
        process.write(frames::encode(
            frames::JSON,
            js::stringify(&json!({"op": "ping", "id": id})).as_bytes(),
        ));
        match roamgate_base::clock::timeout(
            self.inner.clock.as_ref(),
            Duration::from_millis(ms),
            receiver,
        )
        .await
        {
            Ok(_) => true,
            Err(_) => {
                self.state().pending.shift_remove(&id);
                false
            }
        }
    }

    fn send(&self, message: Map<String, Value>) -> Result<(), String> {
        let running = self.start()?;
        running.process.write(frames::encode(
            frames::JSON,
            js::stringify(&Value::Object(message)).as_bytes(),
        ));
        self.touch(running.generation);
        Ok(())
    }

    async fn request_with(
        &self,
        message: Map<String, Value>,
        on_id: impl FnOnce(&mut State, u64),
    ) -> Result<Map<String, Value>, String> {
        let running = self.start()?;
        let (sender, receiver) = oneshot::channel();
        let id = {
            let mut state = self.state();
            let id = state.next_id;
            state.next_id += 1;
            on_id(&mut state, id);
            state.pending.insert(id, sender);
            id
        };
        let mut message = message;
        message.insert("id".into(), json!(id));
        running.process.write(frames::encode(
            frames::JSON,
            js::stringify(&Value::Object(message)).as_bytes(),
        ));
        self.touch(running.generation);
        receiver
            .await
            .unwrap_or_else(|_| Err(HELPER_STOPPED.into()))
    }

    async fn request(&self, message: Map<String, Value>) -> Result<Map<String, Value>, String> {
        self.request_with(message, |_, _| {}).await
    }

    /// Something went to or came from helper `generation`: its idle time
    /// starts again.
    fn touch(&self, generation: u64) {
        let mut state = self.state();
        if state.idle_ms == 0.0
            || state
                .process
                .as_ref()
                .is_none_or(|running| running.generation != generation)
        {
            return;
        }
        state.idle_deadline = Some(self.now() + state.idle_ms as i64);
        if state.idle_timer {
            return;
        }
        state.idle_timer = true;
        drop(state);
        let helper = self.clone();
        tokio::spawn(async move {
            loop {
                let Some(deadline) = helper.state().idle_deadline else {
                    helper.state().idle_timer = false;
                    return;
                };
                helper.inner.clock.sleep_until(deadline).await;
                let due = {
                    let mut state = helper.state();
                    match state.idle_deadline {
                        Some(at) if at <= helper.now() => {
                            state.idle_deadline = None;
                            state.idle_timer = false;
                            state.process.as_ref().map(|running| running.generation)
                        }
                        Some(_) => continue,
                        None => {
                            state.idle_timer = false;
                            return;
                        }
                    }
                };
                if let Some(generation) = due {
                    helper.idle_exit(generation);
                }
                return;
            }
        });
    }

    fn idle_exit(&self, generation: u64) {
        let minutes = {
            let state = self.state();
            if state
                .process
                .as_ref()
                .is_none_or(|running| running.generation != generation)
            {
                return;
            }
            if !state.calls.is_empty()
                || !state.listeners.is_empty()
                || state.speaking > 0
                || !state.pending.is_empty()
            {
                drop(state);
                self.touch(generation);
                return;
            }
            state.idle_ms / 60_000.0
        };
        self.error(&format!(
            "[voice] nothing for the voice helper in {} min: stopping it until the next voice request",
            js::number_text(minutes)
        ));
        self.stop();
    }

    /// Listens until `stop()`; starting a session ends the one before.
    pub fn listen(
        &self,
        on_event: EventSink,
        options: ListenOptions,
    ) -> Result<VoiceSession, String> {
        let id = {
            let mut state = self.state();
            let id = state.next_session;
            state.next_session += 1;
            id
        };
        let running = self.start()?;
        self.state().listeners.insert(
            id,
            Listener {
                generation: running.generation,
                on_event,
            },
        );
        let user = {
            let mut speakers = self.speakers();
            if options.new_speaker {
                speakers.kept_user()
            } else {
                speakers.user()
            }
        };
        let mut message = Map::new();
        message.insert("op".into(), json!("listen_start"));
        message.insert("session".into(), json!(id));
        message.insert("hold".into(), json!(options.hold));
        if let Some(language) = options.language.filter(|language| !language.is_empty()) {
            message.insert("language".into(), json!(language));
        }
        if let Some(ms) = options
            .end_silence_ms
            .filter(|ms| *ms != 0.0 && !ms.is_nan())
        {
            message.insert("end_silence_ms".into(), js::number(ms));
        }
        if options.new_speaker {
            message.insert("new_speaker".into(), json!(true));
        }
        if let Some(call) = options.call {
            message.insert("call".into(), json!(call));
        }
        if let Some(user) = user {
            message.insert("user_voice".into(), user.to_json());
        }
        self.send(message)?;
        Ok(VoiceSession {
            id,
            helper: self.clone(),
        })
    }

    /// The helper session `id` runs in, if it still runs.
    fn running_for(&self, session: u64) -> Option<Running> {
        let state = self.state();
        let generation = state.listeners.get(&session)?.generation;
        state
            .process
            .clone()
            .filter(|running| running.generation == generation)
    }

    /// Speaks `text` into a file.
    pub async fn speak(
        &self,
        text: &str,
        language: Option<&str>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> Result<Speech, String> {
        let (reply, native_rate) = self
            .speak_request(
                text.to_owned(),
                language.map(str::to_owned),
                models,
                rate,
                None,
                false,
            )
            .await?;
        let audio = reply.get("audio").and_then(Value::as_str).unwrap_or("");
        Ok(Speech {
            audio: base64::engine::general_purpose::STANDARD
                .decode(audio)
                .or_else(|_| {
                    base64::engine::general_purpose::STANDARD_NO_PAD
                        .decode(audio.trim_end_matches('='))
                })
                .unwrap_or_default(),
            language: value_text(reply.get("language")),
            native_rate,
        })
    }

    /// Speaks `text` into call `call`'s mix.
    pub async fn speak_in_call(
        &self,
        call: u64,
        text: &str,
        language: Option<&str>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> Result<QueuedSpeech, String> {
        let (reply, native_rate) = self
            .speak_request(
                text.to_owned(),
                language.map(str::to_owned),
                models,
                rate,
                Some(call),
                false,
            )
            .await?;
        if reply.get("queued") != Some(&Value::Bool(true)) {
            return Err("The voice helper sent a file".into());
        }
        let number = |key: &str| reply.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        Ok(QueuedSpeech {
            start_ms: number("start_ms"),
            duration_ms: number("duration_ms"),
            now_ms: number("now_ms"),
            language: value_text(reply.get("language")),
            native_rate,
        })
    }

    fn speak_request(
        &self,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
        call: Option<u64>,
        retried: bool,
    ) -> BoxFuture<Spoken> {
        let helper = self.clone();
        Box::pin(async move {
            helper
                .speak_request_inner(text, language, models, rate, call, retried)
                .await
        })
    }

    async fn speak_request_inner(
        &self,
        mut text: String,
        mut language: Option<String>,
        mut models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
        call: Option<u64>,
        retried: bool,
    ) -> Spoken {
        let running = self.start()?;
        let light = self.light_models(language.as_deref());
        let (kokoro_until, low_gpu, light_only, mut native_rate, restarts, hushes) = {
            let state = self.state();
            (
                state.kokoro_until,
                state.low_gpu.clone(),
                state.light_only.clone(),
                state.native_rate,
                state.restarts,
                call.and_then(|call| state.calls.get(&call).map(|entry| entry.hushes)),
            )
        };
        if light.is_some() && !only_light(models.as_deref()) && self.now() < kokoro_until {
            models = light.clone();
        }
        if models.is_some() && low_gpu.is_some() {
            models = None;
        }
        let light_reads: Option<Option<Vec<TtsModel>>> = match &models {
            Some(models) => only_light(Some(models)).then(|| Some(models.clone())),
            None => light_only,
        };
        if !retried
            && let Some(reads) = &light_reads
            && let Some(missing) = light_cannot_read(&text, language.as_deref(), reads.as_deref())
        {
            self.error(&format!(
                "[voice] no {} voice reads {missing}: a notice is read in place of a sentence ({} chars)",
                light_name(reads.as_deref()),
                js::len16(&text)
            ));
            text = cannot_read_notice(&missing);
            language = Some("en".into());
        }
        let mut overriding: Option<Vec<TtsModel>> = None;
        if let Some(models) = &models {
            let mut own = (self.inner.config)().unwrap_or_else(|_| VoiceConfig {
                raw: object(json!({"helper": ""})),
            });
            own.set(
                "tts_models",
                Value::Array(models.iter().cloned().map(Value::Object).collect()),
            );
            native_rate = own.native_speech_rate();
            overriding = own.helper_tts_models();
        }
        let tempo = rate.map_or(1.0, |rate| playback_rate_for(rate, native_rate));
        let key = format!(
            "{}|{}",
            overriding
                .as_deref()
                .map_or_else(|| "default".to_owned(), models_json),
            call.map_or_else(|| "file".to_owned(), |call| call.to_string())
        );
        {
            let mut state = self.state();
            state.speak_queue.push(key.clone());
            state.speaking += 1;
            let first = state.speaking == 1;
            drop(state);
            if first {
                self.watch_speaking();
            }
        }
        let mut queued = true;
        let mut message = Map::new();
        message.insert("op".into(), json!("speak"));
        message.insert("text".into(), json!(text));
        if let Some(language) = language.as_deref().filter(|language| !language.is_empty()) {
            message.insert("language".into(), json!(language));
        }
        if let Some(overriding) = &overriding {
            message.insert("tts_models".into(), json!(models_json(overriding)));
        }
        if tempo != 1.0 {
            message.insert("rate".into(), js::number(tempo));
        }
        if let Some(call) = call {
            message.insert("call".into(), json!(call));
        }
        let sent_at = self.inner.clock.monotonic();
        let timed_id = Arc::new(Mutex::new(None::<u64>));
        let timed_slot = timed_id.clone();
        let result = self
            .request_with(message, move |state, id| {
                *lock(&timed_slot) = Some(id);
                state.speak_times.insert(
                    id,
                    SpeakTimes {
                        sent_at,
                        ..SpeakTimes::default()
                    },
                );
            })
            .await;
        let timed = lock(&timed_id).and_then(|id| self.state().speak_times.get(&id).copied());
        let where_ = call.map_or(String::new(), |call| format!(" in call {call}"));
        let finish = |this: &Self, queued: &mut bool| {
            if *queued {
                this.dequeue(&key);
            }
            *queued = false;
            if let Some(id) = *lock(&timed_id) {
                this.state().speak_times.shift_remove(&id);
            }
        };
        let reply = match result {
            Ok(reply) => reply,
            Err(message) => {
                let (now_restarts, why) = {
                    let state = self.state();
                    (state.restarts, state.restarted_for)
                };
                let stuck = why == Why::Stuck;
                if !retried && now_restarts != restarts && (!stuck || light.is_some()) {
                    finish(self, &mut queued);
                    let mut back = self.state().calls_back.clone();
                    let _ = back.wait_for(|done| *done).await;
                    return self
                        .speak_request(
                            text,
                            language,
                            if stuck { light } else { models },
                            rate,
                            call,
                            true,
                        )
                        .await;
                }
                if speaker_failed(&message)
                    && let Some(again) = self.by_kokoro(
                        &format!("failed ({message})"),
                        &where_,
                        retried,
                        restarts,
                        &light,
                        &models,
                    )
                {
                    finish(self, &mut queued);
                    return self
                        .speak_request(text, language, again, rate, call, true)
                        .await;
                }
                self.error(&format!(
                    "[voice] a sentence was not said{where_}: {message}"
                ));
                finish(self, &mut queued);
                return Err(message);
            }
        };
        if self
            .state()
            .process
            .as_ref()
            .is_some_and(|process| process.generation == running.generation)
        {
            self.state().warm.insert(key.clone());
        }
        let done_at = self.inner.clock.monotonic();
        if let Some(timed) = timed {
            let mut fields = LogFields::new();
            fields.insert("in_call".into(), json!(call.is_some()));
            fields.insert("chars".into(), json!(js::len16(&text)));
            if let Some(started) = timed.started_at {
                fields.insert(
                    "queued_ms".into(),
                    js::number(js::round(started - timed.sent_at)),
                );
            }
            if let Some(audio) = timed.audio_at {
                fields.insert(
                    "first_audio_ms".into(),
                    js::number(js::round(audio - timed.sent_at)),
                );
            }
            fields.insert(
                "total_ms".into(),
                js::number(js::round(done_at - timed.sent_at)),
            );
            if let Some(duration) = reply.get("duration_ms").and_then(Value::as_f64) {
                fields.insert("duration_ms".into(), js::number(js::round(duration)));
            }
            self.inner.log.debug("voice sentence spoken", Some(&fields));
        }
        let silent = reply.get("queued") == Some(&Value::Bool(true))
            && reply.get("duration_ms").and_then(Value::as_f64) == Some(0.0)
            && call.is_some()
            && call.and_then(|call| self.state().calls.get(&call).map(|entry| entry.hushes))
                == hushes;
        finish(self, &mut queued);
        if silent {
            if let Some(again) = self.by_kokoro(
                &format!("came out silent ({} chars)", js::len16(&text)),
                &where_,
                retried,
                restarts,
                &light,
                &models,
            ) {
                return self
                    .speak_request(text, language, again, rate, call, true)
                    .await;
            }
            self.error(&format!(
                "[voice] call {}: a sentence came out silent ({} chars)",
                call.unwrap_or(0),
                js::len16(&text)
            ));
        }
        let made = reply
            .get("rate")
            .and_then(Value::as_f64)
            .filter(|rate| *rate > 0.0)
            .unwrap_or(1.0);
        Ok((reply, js::round(native_rate * made * 1000.0) / 1000.0))
    }

    /// Its speaker failed: the light voice says it (the models to say it
    /// with), and the next ones for a short while.
    fn by_kokoro(
        &self,
        why: &str,
        where_: &str,
        retried: bool,
        restarts: u64,
        light: &Option<Vec<TtsModel>>,
        models: &Option<Vec<TtsModel>>,
    ) -> Option<Option<Vec<TtsModel>>> {
        let light_models = light.as_ref()?;
        if retried || self.state().restarts != restarts {
            return None;
        }
        if only_light(models.as_deref()) {
            return None;
        }
        self.error(&format!(
            "[voice] a sentence {why}{where_}: {} says it again now, and the next ones for {} s",
            light_name(Some(light_models)),
            KOKORO_AFTER_FAILURE_MS / 1000
        ));
        let until = self.now() + KOKORO_AFTER_FAILURE_MS;
        let mut state = self.state();
        state.kokoro_until = state.kokoro_until.max(until);
        Some(light.clone())
    }

    /// Starts a call in the helper.
    pub async fn start_call(
        &self,
        background: CallBackground,
        on_event: EventSink,
    ) -> Result<CallHandle, String> {
        let (id, replaced) = {
            let mut state = self.state();
            let id = state.next_call;
            state.next_call += 1;
            let replaced: Vec<(u64, EventSink)> = state
                .calls
                .drain(..)
                .map(|(other, call)| (other, call.event))
                .collect();
            (id, replaced)
        };
        for (other, event) in replaced {
            event(object(
                json!({"event": "call_error", "call": other, "error": "Replaced"}),
            ));
        }
        let hook = lock(&self.inner.before_call).clone();
        if let Some(hook) = hook
            && let Err(error) = hook().await
        {
            self.error(&format!(
                "[voice] before call {id}: {error}, the call starts as it is"
            ));
        }
        let serial = {
            let mut state = self.state();
            let serial = state.next_serial;
            state.next_serial += 1;
            state.calls.insert(
                id,
                RunningCall {
                    serial,
                    event: on_event,
                    background: background.clone(),
                    port: 0,
                    started: false,
                    waiting: false,
                    told: false,
                    hushes: 0,
                },
            );
            serial
        };
        let mut message = Map::new();
        message.insert("op".into(), json!("call_start"));
        message.insert("call".into(), json!(id));
        message.extend(background.to_json());
        let reply = match self.request(message).await {
            Ok(reply) => reply,
            Err(error) => {
                let mut state = self.state();
                if state
                    .calls
                    .get(&id)
                    .is_some_and(|call| call.serial == serial)
                {
                    state.calls.shift_remove(&id);
                }
                return Err(error);
            }
        };
        let Some(port) = reply.get("signalling_port").and_then(Value::as_f64) else {
            let running = {
                let mut state = self.state();
                state.calls.shift_remove(&id);
                state.process.is_some()
            };
            if running {
                let _ = self.send(object(json!({"op": "call_stop", "call": id})));
            }
            return Err("This voice helper makes no WebRTC call".into());
        };
        {
            let mut state = self.state();
            if let Some(entry) = state.calls.get_mut(&id) {
                entry.port = port as u64;
                entry.started = true;
                if !entry.told {
                    entry.waiting = reply.get("waiting") == Some(&Value::Bool(true));
                }
            }
        }
        Ok(CallHandle {
            id,
            music: reply.get("music") == Some(&Value::Bool(true)),
            initially_muted: background.muted,
            helper: self.clone(),
        })
    }

    /// The call the helper runs now, started.
    fn running_call(&self) -> Option<u64> {
        self.state()
            .calls
            .iter()
            .filter(|(_, call)| call.started)
            .map(|(id, _)| *id)
            .next_back()
    }

    /// Whether a call runs.
    pub fn in_call(&self) -> bool {
        self.running_call().is_some()
    }

    /// The call running now, started, if any.
    pub fn current_call_id(&self) -> Option<u64> {
        self.running_call()
    }

    /// A call_youtube request to the call running.
    pub async fn call_youtube(
        &self,
        command: Map<String, Value>,
        music_on: bool,
    ) -> Result<Map<String, Value>, String> {
        let Some(id) = self.running_call() else {
            return Err("no call".into());
        };
        let muted = self
            .state()
            .calls
            .get(&id)
            .is_some_and(|call| call.background.muted);
        if music_on && muted {
            let answer = self
                .request(object(
                    json!({"op": "call_music", "call": id, "muted": false}),
                ))
                .await?;
            let mut state = self.state();
            if let Some(call) = state.calls.get_mut(&id) {
                call.background.volume = answer
                    .get("volume")
                    .and_then(Value::as_f64)
                    .unwrap_or(call.background.volume);
                call.background.muted = answer.get("muted") == Some(&Value::Bool(true));
            }
        }
        let mut message = command;
        message.insert("op".into(), json!("call_youtube"));
        message.insert("call".into(), json!(id));
        self.request(message).await
    }

    /// Listens to the helper's call_youtube events; the id to stop with.
    pub fn on_youtube(&self, listener: EventSink) -> u64 {
        let mut state = self.state();
        let id = state.next_listener;
        state.next_listener += 1;
        state.youtube.insert(id, listener);
        id
    }

    pub fn off_youtube(&self, id: u64) {
        self.state().youtube.shift_remove(&id);
    }

    /// The running helper reads with voice.json's `tts_models` from the
    /// next sentence on.
    pub async fn apply_tts_models(&self) -> Result<(), String> {
        if self.state().process.is_none() {
            return Ok(());
        }
        let Ok(config) = (self.inner.config)() else {
            return Ok(());
        };
        let Some(models) = config.helper_tts_models() else {
            return Ok(());
        };
        self.request(object(
            json!({"op": "set_tts_models", "tts_models": models_json(&models)}),
        ))
        .await?;
        self.state().native_rate = config.native_speech_rate();
        Ok(())
    }

    /// A voice from a recording.
    pub async fn clone_voice(&self, request: Map<String, Value>) -> Result<ClonedVoice, String> {
        let mut message = object(json!({"op": "clone_voice"}));
        message.extend(request);
        let reply = self.request(message).await?;
        let (Some(embedding), Some(codes)) = (
            reply.get("embedding").and_then(Value::as_array),
            reply.get("codes").and_then(Value::as_array),
        ) else {
            return Err("The voice helper sent no voice".into());
        };
        Ok(ClonedVoice {
            embedding: embedding.clone(),
            codes: codes.clone(),
            heard: reply
                .get("heard")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            seconds: reply.get("seconds").and_then(Value::as_f64).unwrap_or(0.0),
        })
    }

    fn busy(state: &State) -> bool {
        !state.calls.is_empty()
            || !state.listeners.is_empty()
            || state.speaking > 0
            || !state.pending.is_empty()
    }

    /// voice.json's models changed: a helper doing nothing stops now.
    pub fn reload_models(&self) -> Reload {
        {
            let state = self.state();
            if state.process.is_none() {
                return Reload::NotRunning;
            }
            if Self::busy(&state) {
                return Reload::AfterCall;
            }
        }
        self.stop();
        Reload::Now
    }

    /// reload_models, and the helper it stopped waited for.
    pub async fn reload_models_and_wait(&self) -> Reload {
        let old = self.state().process.clone();
        let result = self.reload_models();
        if result == Reload::Now
            && let Some(old) = old
        {
            let mut exited = old.exited.clone();
            let _ = roamgate_base::clock::timeout(
                self.inner.clock.as_ref(),
                Duration::from_millis(WRAPPED_EXIT_MS + 1000),
                exited.wait_for(|done| *done),
            )
            .await;
        }
        result
    }

    /// Restarts the helper now, its calls made again; false when none runs.
    pub fn restart_models(&self) -> bool {
        let Some(generation) = self
            .state()
            .process
            .as_ref()
            .map(|running| running.generation)
        else {
            return false;
        };
        self.restart(generation, Why::Models);
        true
    }

    /// "low-gpu" or "full", None when none runs.
    pub fn running_profile(&self) -> Option<&'static str> {
        let state = self.state();
        state.process.as_ref()?;
        Some(if state.low_gpu.is_none() {
            "full"
        } else {
            "low-gpu"
        })
    }

    /// Who asked for the running helper's low-GPU set.
    pub fn low_gpu_reason(&self) -> Option<String> {
        let state = self.state();
        state.process.as_ref()?;
        state.low_gpu.clone()
    }

    pub fn running(&self) -> bool {
        self.state().process.is_some()
    }

    pub fn stop(&self) {
        let process = {
            let mut state = self.state();
            if state.process.is_some() {
                state.stopping = true;
            }
            state.idle_deadline = None;
            state.process.take()
        };
        if let Some(process) = process {
            process.process.kill();
        }
    }

    fn dequeue(&self, key: &str) {
        {
            let mut state = self.state();
            let Some(at) = state.speak_queue.iter().position(|each| each == key) else {
                return;
            };
            state.speak_queue.remove(at);
            state.speaking = state.speaking.saturating_sub(1);
        }
        self.watch_speaking();
    }

    async fn restart_calls(&self, calls: Vec<(u64, u64)>) {
        for (id, serial) in calls {
            let background = {
                let state = self.state();
                match state.calls.get(&id).filter(|call| call.serial == serial) {
                    Some(call) => call.background.clone(),
                    None => continue,
                }
            };
            let mut port = 0u64;
            let mut failed = "it gives no signalling".to_owned();
            let mut message = object(json!({"op": "call_start", "call": id}));
            message.extend(background.to_json());
            match self.request(message).await {
                Ok(reply) => {
                    if let Some(given) = reply.get("signalling_port").and_then(Value::as_f64) {
                        port = given as u64;
                    }
                }
                Err(error) => failed = error,
            }
            let current = {
                let mut state = self.state();
                let current = state
                    .calls
                    .get(&id)
                    .is_some_and(|call| call.serial == serial);
                let ended = if current && port == 0 {
                    state.calls.shift_remove(&id).map(|call| call.event)
                } else {
                    None
                };
                (current, ended)
            };
            match current {
                (false, _) => {
                    if port != 0 && self.state().process.is_some() {
                        let _ = self.send(object(json!({"op": "call_stop", "call": id})));
                    }
                }
                (true, Some(event)) => {
                    self.error(&format!("[voice] call {id}: not made again: {failed}"));
                    event(object(json!({
                        "event": "call_ended",
                        "call": id,
                        "error": format!("{HELPER_STOPPED}: {failed}"),
                    })));
                }
                (true, None) => {
                    let event = {
                        let mut state = self.state();
                        state.calls.get_mut(&id).map(|call| {
                            call.port = port;
                            call.event.clone()
                        })
                    };
                    self.error(&format!(
                        "[voice] call {id}: made again in the restarted helper"
                    ));
                    if let Some(event) = event {
                        event(object(json!({"event": "call_restarted", "call": id})));
                    }
                }
            }
        }
    }

    /// voice.json's light voice in `tts_models`, if anything else reads
    /// there.
    fn light_models(&self, language: Option<&str>) -> Option<Vec<TtsModel>> {
        let config = (self.inner.config)().ok()?;
        let models = config.tts_models().unwrap_or_default();
        let model = |entry: &TtsModel| {
            entry
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let light: Vec<TtsModel> = models
            .iter()
            .filter(|entry| model(entry).as_deref() == Some("pocket-tts"))
            .chain(
                models
                    .iter()
                    .filter(|entry| model(entry).as_deref() == Some("kokoro")),
            )
            .cloned()
            .collect();
        if light.is_empty() || light.len() == models.len() {
            return None;
        }
        let language = language.filter(|language| !language.is_empty());
        if let Some(language) = language
            && light_cannot_read("", Some(language), Some(&light)).is_some()
        {
            return None;
        }
        let Some(voice) = language.and_then(kokoro_voice) else {
            return Some(light);
        };
        Some(
            light
                .into_iter()
                .map(|mut entry| {
                    if model(&entry).as_deref() == Some("kokoro")
                        && !entry.contains_key("voice")
                        && !entry.contains_key("speaker")
                    {
                        entry.insert("voice".into(), json!(voice));
                    }
                    entry
                })
                .collect(),
        )
    }

    fn speak_progress(&self, generation: u64, stage: &str) {
        {
            let mut state = self.state();
            if state
                .process
                .as_ref()
                .is_none_or(|running| running.generation != generation)
            {
                return;
            }
            state.progress = Progress {
                reports: true,
                ready: state.progress.ready || stage == "ready",
                loading: stage == "loading",
            };
        }
        self.watch_speaking();
    }

    fn speak_wait(state: &State) -> u64 {
        let progress = state.progress;
        if progress.reports {
            return if progress.ready && !progress.loading {
                SPEAK_STUCK_MS
            } else {
                SPEAK_COLD_MS
            };
        }
        match state.speak_queue.first() {
            Some(head) if state.warm.contains(head) => SPEAK_STUCK_MS,
            _ => SPEAK_COLD_MS,
        }
    }

    fn watch_speaking(&self) {
        let mut state = self.state();
        if let Some(watch) = state.speak_watch.take() {
            watch.abort();
        }
        state.watch_arms += 1;
        let arm = state.watch_arms;
        if state.speaking == 0 {
            return;
        }
        let generation = state.process.as_ref().map(|running| running.generation);
        let wait = Self::speak_wait(&state);
        let helper = self.clone();
        state.speak_watch = Some(tokio::spawn(async move {
            helper.inner.clock.sleep(Duration::from_millis(wait)).await;
            {
                let mut state = helper.state();
                state.speak_watch = None;
                if state.speaking == 0 {
                    return;
                }
                let Some(generation) = generation else {
                    return;
                };
                if state
                    .process
                    .as_ref()
                    .is_none_or(|running| running.generation != generation)
                {
                    return;
                }
            }
            let generation = generation.expect("checked");
            // The ping goes on even when the watch is armed again meanwhile.
            tokio::spawn(async move {
                let answered = helper.answers(generation, PING_MS).await;
                {
                    let state = helper.state();
                    if state.watch_arms != arm || state.speaking == 0 {
                        return;
                    }
                    if state
                        .process
                        .as_ref()
                        .is_none_or(|running| running.generation != generation)
                    {
                        return;
                    }
                }
                if answered {
                    helper.error(&format!(
                        "[voice] the voice helper made no speech in {} s: restarting it, Kokoro reads meanwhile",
                        js::number_text(wait as f64 / 1000.0)
                    ));
                } else {
                    helper.error(&format!(
                        "[voice] the voice helper answered no ping in {} s while a sentence waited {} s: its output is unreadable, restarting it",
                        js::number_text(PING_MS as f64 / 1000.0),
                        js::number_text(wait as f64 / 1000.0)
                    ));
                }
                helper.restart(
                    generation,
                    if answered {
                        Why::Stuck
                    } else {
                        Why::Unreadable
                    },
                );
            });
        }));
    }

    /// What a stuck helper's threads do, kept before it is stopped (macOS's
    /// `sample`, 3 s): voice-hang-<time>.txt in voice_hang_dir. Not elsewhere.
    async fn sample_stuck(&self, process: &dyn HelperProcess) {
        if !cfg!(target_os = "macos") || !*lock(&self.inner.sample_hangs) {
            return;
        }
        let Some(pid) = process.pid() else {
            return;
        };
        let dir = voice_hang_dir();
        let stamp = roamgate_base::log::iso_millis(self.now()).replace(':', "-");
        let file = dir.join(format!("voice-hang-{stamp}.txt"));
        if let Err(error) = std::fs::create_dir_all(&dir) {
            self.error(&format!(
                "[voice] sampling the stuck helper failed: {error}"
            ));
            return;
        }
        match tokio::process::Command::new("/usr/bin/sample")
            .arg(pid.to_string())
            .arg("3")
            .arg("-file")
            .arg(&file)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
                self.error(&format!(
                    "[voice] the stuck helper's threads: {}",
                    file.display()
                ));
            }
            Err(error) => self.error(&format!(
                "[voice] sampling the stuck helper failed: {error}"
            )),
        }
    }
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Where a stuck voice helper's samples go: ROAMGATE_VOICE_HANG_DIR, or
/// ~/Library/Logs/roamgate-voice.
pub fn voice_hang_dir() -> PathBuf {
    match std::env::var("ROAMGATE_VOICE_HANG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join("Library")
            .join("Logs")
            .join("roamgate-voice"),
    }
}

/// One listening session: the microphone streams in until it ends.
pub struct VoiceSession {
    pub id: u64,
    helper: VoiceHelper,
}

impl VoiceSession {
    /// 16 kHz mono S16LE samples.
    pub fn audio(&self, samples: &[u8]) {
        let Some(running) = self.helper.running_for(self.id) else {
            return;
        };
        let mut payload = Vec::with_capacity(4 + samples.len());
        payload.extend_from_slice(&(self.id as u32).to_le_bytes());
        payload.extend_from_slice(samples);
        running
            .process
            .write(frames::encode(frames::AUDIO, &payload));
    }

    /// The reply stopped playing: any voice counts again.
    pub fn release(&self) {
        if self.helper.running_for(self.id).is_some() {
            let _ = self
                .helper
                .send(object(json!({"op": "listen_release", "session": self.id})));
        }
    }

    /// End the utterance now.
    pub fn finish(&self) {
        if self.helper.running_for(self.id).is_some() {
            let _ = self
                .helper
                .send(object(json!({"op": "listen_finish", "session": self.id})));
        }
    }

    pub fn stop(&self) {
        let running = {
            let mut state = self.helper.state();
            if state.listeners.shift_remove(&self.id).is_none() {
                return;
            }
            state.process.is_some()
        };
        if running {
            let _ = self
                .helper
                .send(object(json!({"op": "listen_stop", "session": self.id})));
        }
    }
}

/// A change of a call's music.
#[derive(Debug, Clone, Copy, Default)]
pub struct MusicChange {
    pub volume: Option<f64>,
    pub muted: Option<bool>,
}

/// A call the helper runs.
#[derive(Clone)]
pub struct CallHandle {
    pub id: u64,
    /// Whether the call has a background, on or off.
    pub music: bool,
    initially_muted: bool,
    helper: VoiceHelper,
}

impl CallHandle {
    /// Where the call's signalling server listens, on 127.0.0.1, now.
    pub fn signalling_port(&self) -> u64 {
        self.helper
            .state()
            .calls
            .get(&self.id)
            .map_or(0, |call| call.port)
    }

    /// Listens to the page's microphone: its producer's peer id.
    pub async fn microphone(&self, peer: &str, echo_here: bool) -> Result<(), String> {
        if !self.helper.state().calls.contains_key(&self.id) {
            return Err(format!("no call {}", self.id));
        }
        let mut message = object(json!({"op": "call_microphone", "call": self.id, "peer": peer}));
        if echo_here {
            message.insert("echo".into(), json!("here"));
        }
        self.helper.request(message).await.map(|_| ())
    }

    /// Whether the background is on now.
    pub fn music_on(&self) -> bool {
        let muted = self
            .helper
            .state()
            .calls
            .get(&self.id)
            .map_or(self.initially_muted, |call| call.background.muted);
        self.music && !muted
    }

    /// Whether it waits, silent, for the helper to learn the speaker's voice.
    pub fn music_waiting(&self) -> bool {
        let state = self.helper.state();
        self.music
            && state
                .calls
                .get(&self.id)
                .is_some_and(|call| call.waiting && !call.background.muted)
    }

    /// The voice queued in the mix goes (the user talks over it).
    pub fn hush(&self) {
        let running = {
            let mut state = self.helper.state();
            let Some(call) = state.calls.get_mut(&self.id) else {
                return;
            };
            call.hushes += 1;
            state.process.is_some()
        };
        if running {
            let _ = self
                .helper
                .send(object(json!({"op": "call_hush", "call": self.id})));
        }
    }

    /// The music's level and whether it is off; answers what it is now.
    pub async fn music_level(&self, change: MusicChange) -> Result<(f64, bool), String> {
        let mut message = object(json!({"op": "call_music", "call": self.id}));
        if let Some(volume) = change.volume {
            message.insert("volume".into(), js::number(volume));
        }
        if let Some(muted) = change.muted {
            message.insert("muted".into(), json!(muted));
        }
        let answer = self.helper.request(message).await?;
        let volume = answer.get("volume").and_then(Value::as_f64).unwrap_or(0.0);
        let muted = answer.get("muted") == Some(&Value::Bool(true));
        if let Some(call) = self.helper.state().calls.get_mut(&self.id) {
            call.background.volume = volume;
            call.background.muted = muted;
        }
        Ok((volume, muted))
    }

    pub fn stop(&self) {
        let running = {
            let mut state = self.helper.state();
            if state.calls.shift_remove(&self.id).is_none() {
                return;
            }
            state.process.is_some()
        };
        if running {
            let _ = self
                .helper
                .send(object(json!({"op": "call_stop", "call": self.id})));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
