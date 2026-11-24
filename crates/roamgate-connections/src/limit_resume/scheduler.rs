//! Resumes the sessions a usage limit stopped, once it resets
//! (server/src/limit-resume/scheduler.ts, decision for decision).
//!
//! Every connection's Claude panes are looked at (each scan), and a
//! session whose transcript ends on a usage-limit stop is paused until its
//! reset: at the reset plus the margin, if its transcript still ends on
//! that stop and the user did not say "Don't resume", it is sent the resume
//! message, once per reset. A pause seen in time is resumed after a restart
//! too (the store keeps it); one whose time passed before Roamgate saw it
//! waits for the user's "Resume now". Every timer is on the [`Clock`].

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::{FutureExt, Shared, join_all};
use indexmap::IndexMap;
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, LogLevel, iso_millis, parse_iso_millis};
use serde_json::{Value, json};
use tokio::task::AbortHandle;

use super::connection::{LimitConnection, LimitPane};
use super::store::LimitResumeStore;
use crate::BoxFuture;
use crate::usage_limit::{
    LimitPause, LimitPauseState, LimitResumeSettings, UsageLimitStop, usage_limit_stop,
};

/// A pause seen in time but overdue by more than this is not resumed.
pub const LIMIT_RESUME_STALE_MS: i64 = 24 * 60 * 60_000;

/// The resumer's delays (createLimitResumer's options).
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    /// How often every session is looked at.
    pub scan_every_ms: i64,
    /// A stopped session's transcript is read again at least this often.
    pub reread_ms: i64,
    /// A busy terminal or a failed send is tried again after this.
    pub retry_ms: i64,
    /// Sends tried for one reset before giving up.
    pub max_attempts: u32,
    /// A look asked for (poke) waits this long, for others to join.
    pub poke_delay_ms: i64,
    /// After a send, how long its transcript has to show it.
    pub sent_guard_ms: i64,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            scan_every_ms: 60_000,
            reread_ms: 5 * 60_000,
            retry_ms: 30_000,
            max_attempts: 5,
            poke_delay_ms: 2_000,
            sent_guard_ms: 2 * 60_000,
        }
    }
}

pub type Connections =
    Arc<dyn Fn() -> BoxFuture<Result<Vec<Arc<dyn LimitConnection>>, String>> + Send + Sync>;
pub type Settings = Arc<dyn Fn() -> BoxFuture<Result<LimitResumeSettings, String>> + Send + Sync>;
pub type OnChange = Arc<dyn Fn(&str, Vec<LimitPause>) + Send + Sync>;
pub type Log = Arc<dyn Fn(LogLevel, &str, LogFields) + Send + Sync>;

/// What the resumer is made of.
pub struct ResumerOptions {
    pub connections: Connections,
    pub settings: Settings,
    pub store: LimitResumeStore,
    /// The connection's paused sessions changed (browsers are told).
    pub on_change: Option<OnChange>,
    pub log: Option<Log>,
    pub clock: SharedClock,
    pub timings: Timings,
    /// Only looks: it never arms a resume, never pokes and never sends
    /// (the core's view while Bun owns the family, for shadow reads).
    pub observer: bool,
}

/// How many transcripts one look reads at once. Bun reads them one after
/// the other; a connection with tens of conversation-mode panes takes
/// seconds per pane resolution, so a first look (and the rereads every
/// five minutes) would hold every poke behind it for tens of seconds.
pub const READ_CONCURRENCY: usize = 4;

#[derive(Debug, Clone)]
struct Entry {
    pane: LimitPane,
    stop: UsageLimitStop,
    state: LimitPauseState,
    resume_at: Option<i64>,
    resumed_at: Option<i64>,
    reason: Option<String>,
}

struct Due {
    state: LimitPauseState,
    resume_at: Option<i64>,
    resumed_at: Option<i64>,
    reason: Option<String>,
}

struct Cached {
    session_id: String,
    status: String,
    read_at: i64,
    stop: Option<UsageLimitStop>,
}

struct Failure {
    count: u32,
    at: i64,
    reason: String,
}

struct Timer {
    at: i64,
    id: u64,
    handle: AbortHandle,
}

type Key = (String, String);
type ScanFuture = Shared<BoxFuture<()>>;

#[derive(Default)]
struct State {
    /// Connection id, then pane id.
    pauses: HashMap<String, IndexMap<String, Entry>>,
    cache: HashMap<Key, Cached>,
    timers: HashMap<Key, Timer>,
    next_timer: u64,
    /// By session and reset.
    failures: HashMap<(String, i64), Failure>,
    /// A send under way or just made, by session: never two at once.
    sending: HashMap<String, i64>,
    scans: HashMap<String, ScanFuture>,
    again: HashSet<String>,
    pokes: HashMap<String, AbortHandle>,
    emitted: HashMap<String, String>,
    background: Vec<AbortHandle>,
    started: bool,
    stopped: bool,
}

struct Inner {
    options: ResumerOptions,
    state: Mutex<State>,
}

/// The resumer (createLimitResumer). Clones share it.
#[derive(Clone)]
pub struct LimitResumer {
    inner: Arc<Inner>,
}

/// What "Resume now" and "Don't resume" answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    pub reason: Option<String>,
}

impl Outcome {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }

    fn refused(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            reason: Some(reason.into()),
        }
    }

    /// `{ok}` or `{ok, reason}`, as the RPC answers.
    pub fn to_json(&self) -> Value {
        match &self.reason {
            Some(reason) => json!({"ok": self.ok, "reason": reason}),
            None => json!({"ok": self.ok}),
        }
    }
}

/// A pane's agent is busy: neither paused nor to be typed into.
fn busy(status: &str) -> bool {
    status == "working" || status == "blocked"
}

fn key(connection_id: &str, pane_id: &str) -> Key {
    (connection_id.to_owned(), pane_id.to_owned())
}

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

impl LimitResumer {
    pub fn new(options: ResumerOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::default(),
            }),
        }
    }

    fn now(&self) -> i64 {
        self.inner.options.clock.now()
    }

    fn timings(&self) -> &Timings {
        &self.inner.options.timings
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap()
    }

    fn log(&self, level: LogLevel, message: &str, fields: LogFields) {
        if let Some(log) = &self.inner.options.log {
            log(level, message, fields);
        }
    }

    /// The stop the pane's transcript ends on, read again when needed.
    async fn read_stop(
        &self,
        connection: &Arc<dyn LimitConnection>,
        pane: &LimitPane,
        fresh: bool,
    ) -> Option<UsageLimitStop> {
        let cache_key = key(connection.id(), &pane.pane_id);
        let known = {
            let state = self.state();
            let cached = state.cache.get(&cache_key);
            // Read whatever Herdr says of the pane: its status may lag the stop.
            if let Some(cached) = cached
                && !fresh
                && cached.session_id == pane.session_id
                && cached.status == pane.status
                && self.now() - cached.read_at < self.timings().reread_ms
            {
                return cached.stop.clone();
            }
            cached
                .filter(|cached| cached.session_id == pane.session_id)
                .and_then(|cached| cached.stop.clone())
        };
        let tail = match connection.transcript_tail(&pane.pane_id).await {
            Ok(tail) => tail,
            // Unread (the host did not answer): what was known stays.
            Err(_) => return known,
        };
        let stop = tail
            .as_deref()
            .filter(|tail| !tail.is_empty())
            .and_then(usage_limit_stop);
        self.state().cache.insert(
            cache_key,
            Cached {
                session_id: pane.session_id.clone(),
                status: pane.status.clone(),
                read_at: self.now(),
                stop: stop.clone(),
            },
        );
        stop
    }

    /// What becomes of a pause now, and when it is resumed.
    fn state_of(
        &self,
        pane: &LimitPane,
        stop: &UsageLimitStop,
        settings: &LimitResumeSettings,
    ) -> Result<Due, String> {
        let store = &self.inner.options.store;
        let timings = *self.timings();
        let record = store.get(&pane.session_id);
        let field = |name: &str| record.as_ref().and_then(|record| record.get(name)).cloned();
        let resume_at = stop.resets_at + settings.margin_seconds * 1000;
        let resets = stop.resets_at as f64;
        let due = |state, resume_at, reason: Option<String>| Due {
            state,
            resume_at,
            resumed_at: None,
            reason,
        };
        if field("resumed").and_then(|value| value.as_f64()) == Some(resets) {
            let at = field("resumed_at")
                .and_then(|value| value.as_str().map(str::to_owned))
                .and_then(|text| parse_iso_millis(&text));
            return Ok(Due {
                state: LimitPauseState::Resumed,
                resume_at: None,
                resumed_at: at,
                reason: None,
            });
        }
        if !settings.enabled {
            return Ok(due(LimitPauseState::Off, None, None));
        }
        if field("skip").is_some_and(|value| super::store::truthy(&value)) {
            return Ok(due(LimitPauseState::Skipped, None, None));
        }
        let now = self.now();
        let (failure, sent) = {
            let state = self.state();
            (
                state
                    .failures
                    .get(&(pane.session_id.clone(), stop.resets_at))
                    .map(|failure| (failure.count, failure.at, failure.reason.clone())),
                state.sending.get(&pane.session_id).copied(),
            )
        };
        // Just sent ("Resume now"): its transcript may not show it yet.
        let not_before = match sent {
            Some(sent) if now - sent < timings.sent_guard_ms => sent + timings.sent_guard_ms,
            _ => 0,
        };
        if let Some((count, at, reason)) = failure {
            if count >= timings.max_attempts {
                return Ok(due(LimitPauseState::Failed, None, Some(reason)));
            }
            return Ok(due(
                LimitPauseState::Failed,
                Some(resume_at.max(at + timings.retry_ms).max(not_before)),
                Some(reason),
            ));
        }
        if now < resume_at {
            store.seen(&pane.session_id, stop.resets_at)?;
            return Ok(due(
                LimitPauseState::Scheduled,
                Some(resume_at.max(not_before)),
                None,
            ));
        }
        // Due: resumed only when it was seen paused in time, and not long ago.
        if field("seen").and_then(|value| value.as_f64()) == Some(resets)
            && now - resume_at < LIMIT_RESUME_STALE_MS
        {
            return Ok(due(
                LimitPauseState::Scheduled,
                Some(resume_at.max(not_before)),
                None,
            ));
        }
        Ok(due(LimitPauseState::Missed, None, None))
    }

    fn to_pause(connection_id: &str, entry: &Entry) -> LimitPause {
        LimitPause {
            connection_id: connection_id.into(),
            pane_id: entry.pane.pane_id.clone(),
            session_id: entry.pane.session_id.clone(),
            owner: entry.pane.owner,
            kind: entry.stop.kind.clone(),
            resets_at: entry.stop.resets_at,
            resume_at: entry.resume_at,
            stopped_at: entry.stop.stopped_at,
            state: entry.state,
            resumed_at: entry.resumed_at,
            reason: entry.reason.clone().filter(|reason| !reason.is_empty()),
            message: entry.stop.message.clone(),
        }
    }

    /// The connection's paused sessions.
    pub fn list(&self, connection_id: &str) -> Vec<LimitPause> {
        let state = self.state();
        let mut pauses: Vec<LimitPause> = state
            .pauses
            .get(connection_id)
            .map(|entries| {
                entries
                    .values()
                    .map(|entry| Self::to_pause(connection_id, entry))
                    .collect()
            })
            .unwrap_or_default();
        pauses.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
        pauses
    }

    fn emit(&self, connection_id: &str) {
        let pauses = self.list(connection_id);
        let text = serde_json::to_string(&pauses).unwrap_or_default();
        {
            let mut state = self.state();
            if state.emitted.get(connection_id) == Some(&text) {
                return;
            }
            state.emitted.insert(connection_id.into(), text);
        }
        if let Some(on_change) = &self.inner.options.on_change {
            on_change(connection_id, pauses);
        }
    }

    fn clear_timer_locked(state: &mut State, timer_key: &Key) {
        if let Some(timer) = state.timers.remove(timer_key) {
            timer.handle.abort();
        }
    }

    fn clear_timer(&self, timer_key: &Key) {
        Self::clear_timer_locked(&mut self.state(), timer_key);
    }

    fn schedule(&self, connection_id: &str, pane_id: &str, at: i64) {
        if self.inner.options.observer {
            return;
        }
        let timer_key = key(connection_id, pane_id);
        let mut state = self.state();
        if state.stopped {
            return;
        }
        if state
            .timers
            .get(&timer_key)
            .is_some_and(|timer| timer.at == at)
        {
            return;
        }
        Self::clear_timer_locked(&mut state, &timer_key);
        // Within setTimeout's range; the next scan sets it again meanwhile.
        let now = self.now();
        let delay = (at - now).clamp(0, (1i64 << 31) - 1);
        state.next_timer += 1;
        let id = state.next_timer;
        let this = self.clone();
        let sleep = self.inner.options.clock.sleep_until(now + delay);
        let (connection, pane) = (connection_id.to_owned(), pane_id.to_owned());
        let handle = tokio::spawn(async move {
            sleep.await;
            {
                let mut state = this.state();
                if state
                    .timers
                    .get(&key(&connection, &pane))
                    .map(|timer| timer.id)
                    != Some(id)
                {
                    return;
                }
                state.timers.remove(&key(&connection, &pane));
            }
            this.fire(&connection, &pane).await;
        })
        .abort_handle();
        state.timers.insert(timer_key, Timer { at, id, handle });
    }

    async fn connection_named(&self, connection_id: &str) -> Option<Arc<dyn LimitConnection>> {
        (self.inner.options.connections)()
            .await
            .ok()?
            .into_iter()
            .find(|connection| connection.id() == connection_id)
    }

    async fn scan_connection(&self, connection: &Arc<dyn LimitConnection>) -> Result<(), String> {
        let settings = (self.inner.options.settings)().await?;
        let Ok(panes) = connection.panes().await else {
            // Herdr did not answer: what was known stays until the next scan.
            return Ok(());
        };
        let id = connection.id().to_owned();
        let previous = self.state().pauses.get(&id).cloned().unwrap_or_default();
        let mut next: IndexMap<String, Entry> = IndexMap::new();
        let mut present = HashSet::new();
        // The transcripts are read a few at a time (each read is one pane's
        // own state); what is made of them goes in the panes' order.
        let reads: Vec<BoxFuture<Option<UsageLimitStop>>> = panes
            .iter()
            .map(|pane| {
                let (this, connection, pane) = (self.clone(), connection.clone(), pane.clone());
                Box::pin(async move { this.read_stop(&connection, &pane, false).await })
                    as BoxFuture<Option<UsageLimitStop>>
            })
            .collect();
        let stops: Vec<Option<UsageLimitStop>> = futures_util::stream::iter(reads)
            .buffered(READ_CONCURRENCY)
            .collect()
            .await;
        for (pane, stop) in panes.into_iter().zip(stops) {
            present.insert(pane.pane_id.clone());
            let Some(stop) = stop else {
                continue;
            };
            if let Some(before) = previous.get(&pane.pane_id)
                && before.state == LimitPauseState::Resuming
                && before.pane.session_id == pane.session_id
                && before.stop.resets_at == stop.resets_at
            {
                let mut kept = before.clone();
                kept.pane = pane.clone();
                next.insert(pane.pane_id.clone(), kept);
                continue;
            }
            let due = self.state_of(&pane, &stop, &settings)?;
            next.insert(
                pane.pane_id.clone(),
                Entry {
                    pane,
                    stop,
                    state: due.state,
                    resume_at: due.resume_at,
                    resumed_at: due.resumed_at,
                    reason: due.reason,
                },
            );
        }
        let to_schedule: Vec<(String, Option<i64>)> = {
            let mut state = self.state();
            state.cache.retain(|(connection_id, pane_id), _| {
                connection_id != &id || present.contains(pane_id)
            });
            let plan = next
                .iter()
                .map(|(pane_id, entry)| {
                    let at = matches!(
                        entry.state,
                        LimitPauseState::Scheduled | LimitPauseState::Failed
                    )
                    .then_some(entry.resume_at)
                    .flatten();
                    (pane_id.clone(), at)
                })
                .collect();
            let gone: Vec<Key> = state
                .timers
                .keys()
                .filter(|(connection_id, pane_id)| {
                    connection_id == &id && !next.contains_key(pane_id)
                })
                .cloned()
                .collect();
            for timer_key in gone {
                Self::clear_timer_locked(&mut state, &timer_key);
            }
            state.pauses.insert(id.clone(), next);
            plan
        };
        for (pane_id, at) in to_schedule {
            match at {
                Some(at) => self.schedule(&id, &pane_id, at),
                None => self.clear_timer(&key(&id, &pane_id)),
            }
        }
        self.emit(&id);
        Ok(())
    }

    /// Looks at a connection's sessions; one look at a time per connection.
    pub fn scan(&self, connection_id: &str) -> BoxFuture<()> {
        let mut state = self.state();
        if let Some(running) = state.scans.get(connection_id).cloned() {
            state.again.insert(connection_id.into());
            return Box::pin(running);
        }
        let (done, finished) = tokio::sync::oneshot::channel::<()>();
        let shared: ScanFuture = (Box::pin(async move {
            let _ = finished.await;
        }) as BoxFuture<()>)
            .shared();
        state.scans.insert(connection_id.into(), shared.clone());
        drop(state);
        let this = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            if let Some(connection) = this.connection_named(&id).await
                && let Err(error) = this.scan_connection(&connection).await
            {
                this.log(
                    LogLevel::Warn,
                    "usage limit check failed",
                    fields(&[("connection", json!(id)), ("error", json!(error))]),
                );
            }
            let again = {
                let mut state = this.state();
                state.scans.remove(&id);
                state.again.remove(&id) && !state.stopped
            };
            if again {
                drop(this.scan(&id));
            }
            let _ = done.send(());
        });
        Box::pin(shared)
    }

    /// Looks at a connection, or joins the look under way without asking
    /// for another (a read that only wants the current view).
    pub fn look(&self, connection_id: &str) -> BoxFuture<()> {
        if let Some(running) = self.state().scans.get(connection_id).cloned() {
            return Box::pin(running);
        }
        self.scan(connection_id)
    }

    /// Takes over what `other` read of the transcripts (the core's
    /// observer when it starts owning the family), so the first look after
    /// a flip reads only what changed.
    pub fn adopt_reads(&self, other: &LimitResumer) {
        let taken: Vec<(Key, Cached)> = other
            .state()
            .cache
            .iter()
            .map(|(key, cached)| {
                (
                    key.clone(),
                    Cached {
                        session_id: cached.session_id.clone(),
                        status: cached.status.clone(),
                        read_at: cached.read_at,
                        stop: cached.stop.clone(),
                    },
                )
            })
            .collect();
        self.state().cache.extend(taken);
    }

    /// The store (an observer reads it again before each look).
    pub fn store(&self) -> &LimitResumeStore {
        &self.inner.options.store
    }

    /// Looks at every connection; those gone lose their pauses.
    pub async fn scan_all(&self) {
        let Ok(connections) = (self.inner.options.connections)().await else {
            return;
        };
        let ids: HashSet<String> = connections
            .iter()
            .map(|each| each.id().to_owned())
            .collect();
        let gone: Vec<String> = self
            .state()
            .pauses
            .keys()
            .filter(|id| !ids.contains(*id))
            .cloned()
            .collect();
        for connection_id in gone {
            {
                let mut state = self.state();
                state.pauses.remove(&connection_id);
                let timers: Vec<Key> = state
                    .timers
                    .keys()
                    .filter(|(id, _)| id == &connection_id)
                    .cloned()
                    .collect();
                for timer_key in timers {
                    Self::clear_timer_locked(&mut state, &timer_key);
                }
            }
            self.emit(&connection_id);
        }
        join_all(connections.iter().map(|each| self.scan(each.id()))).await;
    }

    /// Sends the resume message. A manual one ("Resume now") before the
    /// reset is not counted as the reset's resume.
    async fn send(
        &self,
        connection: &Arc<dyn LimitConnection>,
        pane: &LimitPane,
        stop: &UsageLimitStop,
        text: &str,
        how: &str,
    ) -> Outcome {
        let id = connection.id().to_owned();
        let timer_key = key(&id, &pane.pane_id);
        {
            let mut state = self.state();
            let entries = state.pauses.entry(id.clone()).or_default();
            let mut entry = entries.get(&pane.pane_id).cloned().unwrap_or(Entry {
                pane: pane.clone(),
                stop: stop.clone(),
                state: LimitPauseState::Resuming,
                resume_at: None,
                resumed_at: None,
                reason: None,
            });
            entry.state = LimitPauseState::Resuming;
            entry.resume_at = None;
            entries.insert(pane.pane_id.clone(), entry);
            Self::clear_timer_locked(&mut state, &timer_key);
        }
        self.emit(&id);
        let sent_at = self.now();
        self.state()
            .sending
            .insert(pane.session_id.clone(), sent_at);
        let failed = (pane.session_id.clone(), stop.resets_at);
        let owner = json!(pane.owner.as_str());
        if let Err(reason) = connection.deliver(pane, text).await {
            {
                let mut state = self.state();
                state.sending.remove(&pane.session_id);
                if how == "auto" {
                    let count = state
                        .failures
                        .get(&failed)
                        .map_or(0, |failure| failure.count)
                        + 1;
                    let at = self.now();
                    state.failures.insert(
                        failed,
                        Failure {
                            count,
                            at,
                            reason: reason.clone(),
                        },
                    );
                }
            }
            self.log(
                LogLevel::Warn,
                "could not resume a session after its usage limit",
                fields(&[
                    ("connection", json!(id)),
                    ("pane", json!(pane.pane_id)),
                    ("session", json!(pane.session_id)),
                    ("owner", owner),
                    ("how", json!(how)),
                    ("error", json!(reason)),
                ]),
            );
            {
                let mut state = self.state();
                if let Some(entries) = state.pauses.get_mut(&id) {
                    entries.shift_remove(&pane.pane_id);
                }
                state.cache.remove(&timer_key);
            }
            self.scan(&id).await;
            return Outcome::refused(reason);
        }
        self.state().failures.remove(&failed);
        if self.now() >= stop.resets_at
            && let Err(error) = self
                .inner
                .options
                .store
                .resumed(&pane.session_id, stop.resets_at)
        {
            self.log(
                LogLevel::Warn,
                "usage limit check failed",
                fields(&[("connection", json!(id)), ("error", json!(error))]),
            );
        }
        self.log(
            LogLevel::Info,
            "session resumed after its usage limit",
            fields(&[
                ("connection", json!(id)),
                ("pane", json!(pane.pane_id)),
                ("session", json!(pane.session_id)),
                ("owner", owner),
                ("how", json!(how)),
                ("kind", json!(stop.kind)),
                ("resets_at", json!(iso_millis(stop.resets_at))),
            ]),
        );
        if let Some(entries) = self.state().pauses.get_mut(&id) {
            entries.shift_remove(&pane.pane_id);
        }
        self.emit(&id);
        // Its transcript shows the message shortly: looked at again then.
        self.state().cache.remove(&timer_key);
        self.poke(&id, Some(&pane.pane_id));
        Outcome::ok()
    }

    /// Marks a send of `session_id` under way, unless one is (or was just
    /// made): false then.
    fn claim_send(&self, session_id: &str) -> bool {
        let now = self.now();
        let guard = self.timings().sent_guard_ms;
        let mut state = self.state();
        if state
            .sending
            .get(session_id)
            .is_some_and(|sent| now - sent < guard)
        {
            return false;
        }
        state.sending.insert(session_id.to_owned(), now);
        true
    }

    /// A pause's time came: resumed if nothing changed meanwhile.
    async fn fire(&self, connection_id: &str, pane_id: &str) {
        if self.state().stopped {
            return;
        }
        let Some(connection) = self.connection_named(connection_id).await else {
            return;
        };
        let Ok(settings) = (self.inner.options.settings)().await else {
            return;
        };
        let retry = self.timings().retry_ms;
        let Ok(panes) = connection.panes().await else {
            self.schedule(connection_id, pane_id, self.now() + retry);
            return;
        };
        let pane = panes.into_iter().find(|each| each.pane_id == pane_id);
        let entry = self
            .state()
            .pauses
            .get(connection_id)
            .and_then(|entries| entries.get(pane_id))
            .cloned();
        let (Some(pane), Some(entry)) = (pane, entry) else {
            self.scan(connection_id).await;
            return;
        };
        if pane.session_id != entry.pane.session_id {
            self.scan(connection_id).await;
            return;
        }
        // Busy (a question, a turn): tried again shortly, never typed into.
        if busy(&pane.status) {
            self.schedule(connection_id, pane_id, self.now() + retry);
            return;
        }
        let stop = self.read_stop(&connection, &pane, true).await;
        let due = stop
            .as_ref()
            .and_then(|stop| self.state_of(&pane, stop, &settings).ok());
        let ready = due.as_ref().is_some_and(|due| {
            matches!(
                due.state,
                LimitPauseState::Scheduled | LimitPauseState::Failed
            ) && due.resume_at.is_some_and(|at| at <= self.now())
        });
        match stop {
            Some(stop) if ready => {
                // Never two sends at once: a timer set again while this one
                // looked may have fired and sent meanwhile (the tasks run in
                // parallel).
                if !self.claim_send(&pane.session_id) {
                    return;
                }
                self.send(&connection, &pane, &stop, &settings.message, "auto")
                    .await;
            }
            // Resumed by the user, stopped on another reset, or not wanted.
            _ => self.scan(connection_id).await,
        }
    }

    /// Something changed in a pane (a turn ended): looked at shortly.
    pub fn poke(&self, connection_id: &str, pane_id: Option<&str>) {
        let mut state = self.state();
        if state.stopped || self.inner.options.observer {
            return;
        }
        if let Some(pane_id) = pane_id {
            state.cache.remove(&key(connection_id, pane_id));
        }
        if state.pokes.contains_key(connection_id) {
            return;
        }
        let this = self.clone();
        let id = connection_id.to_owned();
        let sleep = self
            .inner
            .options
            .clock
            .sleep(Duration::from_millis(self.timings().poke_delay_ms as u64));
        let handle = tokio::spawn(async move {
            sleep.await;
            this.state().pokes.remove(&id);
            this.scan(&id).await;
        })
        .abort_handle();
        state.pokes.insert(connection_id.into(), handle);
    }

    /// Starts looking: after `first_delay_ms`, then every scan period.
    pub fn start(&self, first_delay_ms: i64) {
        let mut state = self.state();
        if state.started || state.stopped {
            return;
        }
        state.started = true;
        let clock = self.inner.options.clock.clone();
        let first = clock.sleep(Duration::from_millis(first_delay_ms.max(0) as u64));
        let this = self.clone();
        state.background.push(
            tokio::spawn(async move {
                first.await;
                this.scan_all().await;
            })
            .abort_handle(),
        );
        let mut interval =
            clock.interval(Duration::from_millis(self.timings().scan_every_ms as u64));
        let this = self.clone();
        state.background.push(
            tokio::spawn(async move {
                loop {
                    interval.tick().await;
                    let scanning = this.clone();
                    tokio::spawn(async move { scanning.scan_all().await });
                }
            })
            .abort_handle(),
        );
    }

    /// Stops every timer; nothing runs or is written after.
    pub fn stop(&self) {
        let mut state = self.state();
        state.stopped = true;
        for handle in state.background.drain(..) {
            handle.abort();
        }
        for (_, timer) in state.timers.drain() {
            timer.handle.abort();
        }
        for (_, handle) in state.pokes.drain() {
            handle.abort();
        }
    }

    /// "Resume now": sends the message at once, whatever the time.
    pub async fn resume_now(&self, connection_id: &str, pane_id: &str) -> Outcome {
        let connection = self.connection_named(connection_id).await;
        let entry = self
            .state()
            .pauses
            .get(connection_id)
            .and_then(|entries| entries.get(pane_id))
            .cloned();
        let (Some(connection), Some(entry)) = (connection, entry) else {
            return Outcome::refused("The session is not paused by a usage limit");
        };
        let panes = connection.panes().await.ok();
        let pane = panes
            .into_iter()
            .flatten()
            .find(|each| each.pane_id == pane_id);
        let Some(pane) = pane.filter(|pane| pane.session_id == entry.pane.session_id) else {
            return Outcome::refused("The pane runs another session now");
        };
        // The user's call while it works; never typed into a question.
        if pane.status == "blocked" {
            return Outcome::refused("The agent is asking something");
        }
        if entry.state == LimitPauseState::Resuming {
            return Outcome::refused("It is being resumed");
        }
        let settings = match (self.inner.options.settings)().await {
            Ok(settings) => settings,
            Err(error) => return Outcome::refused(error),
        };
        self.send(&connection, &pane, &entry.stop, &settings.message, "manual")
            .await
    }

    /// "Don't resume" (true) for the pane's session, or undone (false).
    pub async fn set_skip(
        &self,
        connection_id: &str,
        pane_id: &str,
        skip: bool,
    ) -> Result<Outcome, String> {
        let entry = self
            .state()
            .pauses
            .get(connection_id)
            .and_then(|entries| entries.get(pane_id))
            .cloned();
        let Some(entry) = entry else {
            return Ok(Outcome::refused(
                "The session is not paused by a usage limit",
            ));
        };
        self.inner
            .options
            .store
            .set_skip(&entry.pane.session_id, skip)?;
        self.log(
            LogLevel::Info,
            if skip {
                "usage limit resume declined"
            } else {
                "usage limit resume wanted again"
            },
            fields(&[
                ("connection", json!(connection_id)),
                ("pane", json!(pane_id)),
                ("session", json!(entry.pane.session_id)),
            ]),
        );
        self.scan(connection_id).await;
        Ok(Outcome::ok())
    }
}

#[cfg(test)]
mod tests;
