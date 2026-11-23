//! The voice socket's tests (voice-socket.test.ts,
//! voice-socket.dictation.test.ts, call-handoff.test.ts, call-audio.test.ts
//! and voice-helper.test.ts's voice socket): fakes for the helper, the
//! companion, the sockets and the helper's signalling server; time on the
//! test clock.

mod call;
mod call_helper;
mod dictation;
mod handoff;
mod listen;
mod stuck;
mod with_helper;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_base::clock::TestClock;
use serde_json::{Map, Value, json};

use super::companion::{
    CleanSession, Cleaned, Cleaner, Companion, Dictated, DictationCleaner, DictationSession,
};
use super::signalling::{ConnectUpstream, UpstreamEvent, UpstreamEvents, UpstreamSocket};
use super::*;
use crate::config::CallBackground;
use crate::helper::{BoxFuture, EventSink, ListenOptions, MusicChange};
use crate::speakers::SpeakerTracker;

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    super::lock(mutex)
}

/// Lets spawned tasks run: yields only, never waits.
pub(super) async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

pub(super) fn clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(1_700_000_000_000))
}

pub(super) fn options(clock: &Arc<TestClock>) -> VoiceSocketOptions {
    let mut options = VoiceSocketOptions::new(clock.clone());
    options.errors = Arc::new(|_| {});
    options
}

/// `ms` of 16 kHz mono S16LE audio.
pub(super) fn audio(ms: usize) -> Vec<u8> {
    vec![0; ms * 32]
}

/// A socket keeping what it is told.
#[derive(Default)]
pub(super) struct FakePeer {
    pub sent: Mutex<Vec<Value>>,
}

impl VoicePeer for FakePeer {
    fn send(&self, text: String) {
        lock(&self.sent).push(serde_json::from_str(&text).unwrap());
    }
}

pub(super) struct Socket {
    pub peer: Peer,
    fake: Arc<FakePeer>,
}

impl Socket {
    pub fn new() -> Self {
        let fake = Arc::new(FakePeer::default());
        Self {
            peer: fake.clone(),
            fake,
        }
    }

    pub fn sent(&self) -> Vec<Value> {
        lock(&self.fake.sent).clone()
    }

    pub fn last(&self) -> Value {
        self.sent().last().cloned().unwrap_or(Value::Null)
    }

    pub fn events(&self) -> Vec<String> {
        self.sent()
            .iter()
            .map(|message| message["event"].as_str().unwrap_or("").to_owned())
            .collect()
    }

    pub fn count(&self, event: &str) -> usize {
        self.events().iter().filter(|each| *each == event).count()
    }
}

/// Sends `message` as JSON text.
pub(super) fn say(socket: &VoiceSocket, ws: &Socket, message: Value) {
    socket.message(&ws.peer, &message.to_string());
}

/// A page's signalling socket: what it got, and how it closed.
#[derive(Default)]
pub(super) struct FakeSignalling {
    pub got: Mutex<Vec<String>>,
    pub closed: Mutex<Vec<(u16, String)>>,
}

impl SignallingPeer for FakeSignalling {
    fn send(&self, text: String) {
        lock(&self.got).push(text);
    }

    fn close(&self, code: u16, reason: &str) {
        lock(&self.closed).push((code, reason.to_owned()));
    }
}

pub(super) fn signalling() -> (SignallingSocket, Arc<FakeSignalling>) {
    let fake = Arc::new(FakeSignalling::default());
    (fake.clone(), fake)
}

impl FakeSignalling {
    pub fn closed(&self) -> Vec<(u16, String)> {
        lock(&self.closed).clone()
    }

    pub fn got(&self) -> Vec<Value> {
        lock(&self.got)
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect()
    }
}

/// A socket to the helper's signalling server, as the fake made it.
pub(super) struct MadeUpstream {
    pub url: String,
    pub told: Mutex<Vec<String>>,
    pub closed: Mutex<bool>,
    events: UpstreamEvents,
}

impl MadeUpstream {
    /// What the server says to it.
    pub fn say(&self, message: Value) {
        (self.events)(UpstreamEvent::Message(message.to_string()));
    }

    pub fn open(&self) {
        (self.events)(UpstreamEvent::Open);
    }

    pub fn gone(&self) {
        (self.events)(UpstreamEvent::Closed);
    }

    pub fn told(&self) -> Vec<Value> {
        lock(&self.told)
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect()
    }

    pub fn told_text(&self) -> Vec<String> {
        lock(&self.told).clone()
    }

    pub fn closed(&self) -> bool {
        *lock(&self.closed)
    }
}

struct UpstreamHandle(Arc<MadeUpstream>);

impl UpstreamSocket for UpstreamHandle {
    fn send(&self, text: String) {
        lock(&self.0.told).push(text);
    }

    fn close(&self) {
        *lock(&self.0.closed) = true;
    }
}

/// The helper's signalling server's sockets, and what each was told.
#[derive(Clone, Default)]
pub(super) struct Upstreams {
    pub made: Arc<Mutex<Vec<Arc<MadeUpstream>>>>,
}

impl Upstreams {
    pub fn connect(&self) -> ConnectUpstream {
        let made = self.made.clone();
        Arc::new(move |url: &str, events: UpstreamEvents| {
            let entry = Arc::new(MadeUpstream {
                url: url.to_owned(),
                told: Mutex::default(),
                closed: Mutex::new(false),
                events,
            });
            lock(&made).push(entry.clone());
            Ok(Arc::new(UpstreamHandle(entry)) as Arc<dyn UpstreamSocket>)
        })
    }

    pub fn get(&self, index: usize) -> Arc<MadeUpstream> {
        lock(&self.made)[index].clone()
    }

    pub fn last(&self) -> Arc<MadeUpstream> {
        lock(&self.made).last().unwrap().clone()
    }

    pub fn len(&self) -> usize {
        lock(&self.made).len()
    }

    pub fn urls(&self) -> Vec<String> {
        lock(&self.made)
            .iter()
            .map(|each| each.url.clone())
            .collect()
    }
}

/// One session the fake helper listens to.
pub(super) struct FakeSession {
    pub id: u64,
    pub sink: EventSink,
    pub options: ListenOptions,
    pub calls: Mutex<Vec<&'static str>>,
    pub bytes: AtomicUsize,
}

impl Listen for FakeSession {
    fn id(&self) -> u64 {
        self.id
    }

    fn audio(&self, samples: &[u8]) {
        self.bytes.fetch_add(samples.len(), Ordering::SeqCst);
    }

    fn release(&self) {}

    fn finish(&self) {
        lock(&self.calls).push("finish");
    }

    fn stop(&self) {
        lock(&self.calls).push("stop");
    }
}

impl FakeSession {
    pub fn calls(&self) -> Vec<&'static str> {
        lock(&self.calls).clone()
    }

    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::SeqCst)
    }
}

/// A call the fake helper starts: number 7, no music, no signalling.
struct FakeCall;

impl CallLine for FakeCall {
    fn id(&self) -> u64 {
        7
    }

    fn music(&self) -> bool {
        false
    }

    fn music_on(&self) -> bool {
        false
    }

    fn music_waiting(&self) -> bool {
        false
    }

    fn signalling_port(&self) -> u64 {
        0
    }

    fn microphone(&self, _peer: &str, _echo_here: bool) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn hush(&self) {}

    fn music_level(&self, _change: MusicChange) -> BoxFuture<Result<(f64, bool), String>> {
        Box::pin(async { Ok((0.6, true)) })
    }

    fn stop(&self) {}
}

/// A helper whose sessions' events the test sends (voice-socket.test.ts
/// and voice-socket.dictation.test.ts fakeHelper): each listen gets the
/// next id, or always 1 with `same_id`.
pub(super) struct FakeHelper {
    pub sessions: Mutex<Vec<Arc<FakeSession>>>,
    pub speakers: Mutex<SpeakerTracker>,
    same_id: bool,
}

impl FakeHelper {
    pub fn new(same_id: bool) -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::default(),
            speakers: Mutex::new(SpeakerTracker::new(None)),
            same_id,
        })
    }

    pub fn latest(&self) -> Arc<FakeSession> {
        lock(&self.sessions).last().unwrap().clone()
    }

    pub fn session(&self, index: usize) -> Arc<FakeSession> {
        lock(&self.sessions)[index].clone()
    }

    pub fn count(&self) -> usize {
        lock(&self.sessions).len()
    }

    /// Tells the latest session `event`, its session filled in.
    pub fn emit(&self, event: Value) {
        let latest = self.latest();
        let mut event = event.as_object().cloned().unwrap_or_default();
        if !event.contains_key("session") {
            event.insert("session".into(), json!(latest.id));
        }
        (latest.sink)(event);
    }

    /// The latest session's calls (finish, stop).
    pub fn calls(&self) -> Vec<&'static str> {
        self.latest().calls()
    }
}

impl SocketHelper for FakeHelper {
    fn listen(
        &self,
        on_event: EventSink,
        options: ListenOptions,
    ) -> Result<Arc<dyn Listen>, String> {
        let mut sessions = lock(&self.sessions);
        let id = if self.same_id {
            1
        } else {
            sessions.len() as u64 + 1
        };
        let session = Arc::new(FakeSession {
            id,
            sink: on_event,
            options,
            calls: Mutex::default(),
            bytes: AtomicUsize::new(0),
        });
        sessions.push(session.clone());
        Ok(session)
    }

    fn start_call(
        &self,
        _background: CallBackground,
        _on_event: EventSink,
    ) -> BoxFuture<Result<Arc<dyn CallLine>, String>> {
        Box::pin(async { Ok(Arc::new(FakeCall) as Arc<dyn CallLine>) })
    }

    fn voice_label(&self, voice: &Value) -> String {
        lock(&self.speakers).label(crate::speakers::parse_voice_tag(voice).as_ref())
    }

    fn is_other_voice(&self, voice: &Value) -> bool {
        lock(&self.speakers).is_other(crate::speakers::parse_voice_tag(voice).as_ref())
    }
}

/// The voice chat's cleaner: drops "um", holds what mentions the salt
/// (voice-socket.test.ts fakeCleaner), keeping each session's context.
#[derive(Default)]
pub(super) struct FakeCleaner {
    pub contexts: Mutex<Vec<String>>,
    /// Never asked: the voice chat's cleaner in a dictation's tests.
    pub refuses: bool,
}

struct FakeClean {
    refuses: bool,
}

impl CleanSession for FakeClean {
    fn partial(&self, _text: &str, _pause: bool) {}

    fn final_text(&self, text: &str) -> BoxFuture<Result<Cleaned, String>> {
        let refuses = self.refuses;
        let text = text.to_owned();
        Box::pin(async move {
            if refuses {
                return Err("the voice chat's cleaner was asked".into());
            }
            Ok(Cleaned {
                for_agent: !text.contains("salt"),
                text: text.replace("um ", ""),
            })
        })
    }

    fn close(&self) {}
}

impl Cleaner for FakeCleaner {
    fn warm(&self) {}

    fn session(&self, context: &str) -> Arc<dyn CleanSession> {
        lock(&self.contexts).push(context.to_owned());
        Arc::new(FakeClean {
            refuses: self.refuses,
        })
    }
}

pub(super) type Answer = Arc<dyn Fn(String) -> BoxFuture<Dictated> + Send + Sync>;

/// A dictation cleaner that drops "euh" and capitalizes; or as told
/// (voice-socket.dictation.test.ts fakeCleaner).
pub(super) struct FakeDictation {
    pub warmed: AtomicUsize,
    pub requests: Mutex<Vec<Map<String, Value>>>,
    answer: Answer,
}

impl FakeDictation {
    pub fn new() -> Arc<Self> {
        Self::answering(Arc::new(|heard: String| {
            Box::pin(async move {
                let rest = heard.replace("euh ", "");
                let mut chars = rest.chars();
                let first = chars.next().map(|c| c.to_uppercase().to_string());
                Dictated {
                    text: format!("{}{}.", first.unwrap_or_default(), chars.as_str()),
                    cleaned: true,
                }
            })
        }))
    }

    pub fn answering(answer: Answer) -> Arc<Self> {
        Arc::new(Self {
            warmed: AtomicUsize::new(0),
            requests: Mutex::default(),
            answer,
        })
    }
}

struct FakeDictationSession {
    answer: Answer,
}

impl DictationSession for FakeDictationSession {
    fn partial(&self, _whole: &str, _pause: bool) {}

    fn clean(&self, heard: &str) -> BoxFuture<Dictated> {
        (self.answer)(heard.to_owned())
    }

    fn close(&self) {}
}

impl DictationCleaner for FakeDictation {
    fn warm(&self) {
        self.warmed.fetch_add(1, Ordering::SeqCst);
    }

    fn session(&self, listen: &Map<String, Value>) -> Arc<dyn DictationSession> {
        lock(&self.requests).push(listen.clone());
        Arc::new(FakeDictationSession {
            answer: self.answer.clone(),
        })
    }
}

/// A companion with the cleaners it is given.
pub(super) struct FakeCompanion {
    pub chat: Option<Arc<FakeCleaner>>,
    pub dictation: Option<Arc<FakeDictation>>,
    pub fronted: bool,
}

impl Companion for FakeCompanion {
    fn chat_cleaner(&self) -> Option<Arc<dyn Cleaner>> {
        self.chat.clone().map(|cleaner| cleaner as Arc<dyn Cleaner>)
    }

    fn dictation_cleaner(&self) -> Option<Arc<dyn DictationCleaner>> {
        self.dictation
            .clone()
            .map(|cleaner| cleaner as Arc<dyn DictationCleaner>)
    }

    fn fronted(&self) -> bool {
        self.fronted
    }
}

/// Lines written to a sink.
pub(super) fn lines() -> (ErrorSink, Arc<Mutex<Vec<String>>>) {
    let kept: Arc<Mutex<Vec<String>>> = Arc::default();
    let into = kept.clone();
    (
        Arc::new(move |line: &str| lock(&into).push(line.to_owned())),
        kept,
    )
}
