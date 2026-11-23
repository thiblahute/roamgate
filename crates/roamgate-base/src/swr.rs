//! Caches (mr-cache/cache.ts's core and review/memo.ts): one read however
//! many ask, answers kept for a time each answer sets.
//!
//! - [`SwrCache`]: stale-while-revalidate. A known answer is served at once
//!   and re-read in the background only when it is older than its TTL,
//!   within a budget of background reads per minute and never while the
//!   source asked to be left alone (failure backoff, or a pause the answer
//!   names). At most `max_entries` answers, the least recently fetched
//!   forgotten first (as mr-cache does: an answer read again is as good as
//!   new). Persistence stays with its owner: `entries` and `restore` give
//!   and take the answers, `on_change` says when to write them.
//! - [`Memo`]: an answer shared while it is asked, then for its TTL; a
//!   failure is forgotten at once.
//! - [`KeyedQueue`]: runs one task at a time per key.
//!
//! The card subject check of mr-cache is here too: an answer may keep the
//! subject it was read for (a checkout's `ref\ncommit` HEAD); an answer of
//! another ref is not reused, and one whose commit moved is due.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;

use crate::clock::{BoxFuture, Clock};

/// Background reads, entries kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwrSettings {
    /// Background reads started per minute, all keys together.
    pub budget_per_minute: usize,
    /// Answers kept, the least recently fetched forgotten first.
    pub max_entries: usize,
}

impl Default for SwrSettings {
    fn default() -> Self {
        Self {
            budget_per_minute: 20,
            max_entries: 1000,
        }
    }
}

/// A kept answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored<V> {
    pub value: V,
    /// Epoch ms of the read it comes from.
    pub fetched_at: i64,
    pub ttl_ms: i64,
    /// What the subject was when it was read (a checkout's HEAD).
    pub head: Option<String>,
}

/// What a read of the cache gives.
#[derive(Debug, Clone, PartialEq)]
pub struct SwrAnswer<V> {
    pub value: V,
    /// Epoch ms of the read the value comes from.
    pub fetched_at: i64,
    /// Older than its TTL allows: a read is under way or deferred.
    pub stale: bool,
}

/// Whether an answer is a failure.
pub type FailedFn<V> = Arc<dyn Fn(&V) -> bool + Send + Sync>;
/// Until when (epoch ms) the source asked to be left alone.
pub type PausedFn<V> = Arc<dyn Fn(Option<&V>) -> i64 + Send + Sync>;

type Load<V, E> = Arc<dyn Fn() -> BoxFuture<Result<V, E>> + Send + Sync>;
/// Where the subject is now (a checkout's `ref\ncommit` HEAD); None: unknown.
pub type HeadFn = Arc<dyn Fn() -> BoxFuture<Option<String>> + Send + Sync>;

/// How a key is read.
pub struct SwrOptions<V, E> {
    /// How long an answer stands, by what it says; 0: never kept.
    pub ttl: Arc<dyn Fn(&V) -> i64 + Send + Sync>,
    /// The read. A failure keeps what was known.
    pub load: Load<V, E>,
    /// Read now, ignoring TTL, budget and pauses (a click on refresh).
    pub fresh: bool,
    /// A failure answer: not kept, and the next read waits (backoff).
    pub failed: Option<FailedFn<V>>,
    /// Epoch ms until which the source asked to be left alone.
    pub paused_until: Option<PausedFn<V>>,
    /// Where the subject is now: answers of another ref are not reused.
    pub head: Option<HeadFn>,
}

impl<V, E> Clone for SwrOptions<V, E> {
    fn clone(&self) -> Self {
        Self {
            ttl: self.ttl.clone(),
            load: self.load.clone(),
            fresh: self.fresh,
            failed: self.failed.clone(),
            paused_until: self.paused_until.clone(),
            head: self.head.clone(),
        }
    }
}

impl<V, E> SwrOptions<V, E> {
    /// Options with a fixed TTL and the given read.
    pub fn new<F, Fut>(ttl_ms: i64, load: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<V, E>> + Send + 'static,
    {
        Self {
            ttl: Arc::new(move |_| ttl_ms),
            load: Arc::new(move || Box::pin(load())),
            fresh: false,
            failed: None,
            paused_until: None,
            head: None,
        }
    }
}

/// The ref half of a `ref\ncommit` HEAD description.
fn head_ref(head: Option<&str>) -> &str {
    head.and_then(|head| head.split('\n').next()).unwrap_or("")
}

/// An answer changed: the key, the value, when it was read.
pub type Publish<V> = Arc<dyn Fn(&str, &V, i64) + Send + Sync>;

type Flight<V, E> = Shared<BoxFuture<Result<V, E>>>;

struct State<V, E> {
    entries: HashMap<String, Stored<V>>,
    in_flight: HashMap<String, (u64, Flight<V, E>)>,
    failures: HashMap<String, (u32, i64)>,
    /// When the background reads of the last minute started.
    started: VecDeque<i64>,
    next_flight: u64,
}

struct Inner<V, E> {
    clock: Arc<dyn Clock>,
    settings: Box<dyn Fn() -> SwrSettings + Send + Sync>,
    publish: Option<Publish<V>>,
    on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    state: Mutex<State<V, E>>,
}

/// A stale-while-revalidate cache (see the module's documentation).
pub struct SwrCache<V, E> {
    inner: Arc<Inner<V, E>>,
}

impl<V, E> Clone for SwrCache<V, E> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<V, E> SwrCache<V, E>
where
    V: Clone + Send + Sync + 'static,
    E: Clone + Send + Sync + 'static,
{
    pub fn new(
        clock: Arc<dyn Clock>,
        settings: impl Fn() -> SwrSettings + Send + Sync + 'static,
    ) -> Self {
        Self::with_hooks(clock, settings, None, None)
    }

    /// A cache that tells `publish` each answer it keeps and `on_change`
    /// whenever what it keeps changed (to write it out).
    pub fn with_hooks(
        clock: Arc<dyn Clock>,
        settings: impl Fn() -> SwrSettings + Send + Sync + 'static,
        publish: Option<Publish<V>>,
        on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                clock,
                settings: Box::new(settings),
                publish,
                on_change,
                state: Mutex::new(State {
                    entries: HashMap::new(),
                    in_flight: HashMap::new(),
                    failures: HashMap::new(),
                    started: VecDeque::new(),
                    next_flight: 0,
                }),
            }),
        }
    }

    fn now(&self) -> i64 {
        self.inner.clock.now()
    }

    fn changed(&self) {
        if let Some(on_change) = &self.inner.on_change {
            on_change();
        }
    }

    /// Keeps an answer, forgetting the least recently fetched past the cap.
    fn put(
        &self,
        state: &mut State<V, E>,
        key: &str,
        value: V,
        ttl_ms: i64,
        head: Option<String>,
    ) -> i64 {
        let fetched_at = self.now();
        state.entries.insert(
            key.to_owned(),
            Stored {
                value,
                fetched_at,
                ttl_ms,
                head: head.filter(|head| !head.is_empty()),
            },
        );
        let cap = (self.inner.settings)().max_entries;
        if state.entries.len() > cap {
            let mut oldest: Vec<(i64, String)> = state
                .entries
                .iter()
                .map(|(key, entry)| (entry.fetched_at, key.clone()))
                .collect();
            oldest.sort();
            let excess = state.entries.len() - cap;
            for (_, key) in oldest.into_iter().take(excess) {
                state.entries.remove(&key);
            }
        }
        fetched_at
    }

    fn budget_left(&self, state: &mut State<V, E>) -> bool {
        let at = self.now();
        while state
            .started
            .front()
            .is_some_and(|when| *when <= at - 60_000)
        {
            state.started.pop_front();
        }
        state.started.len() < (self.inner.settings)().budget_per_minute
    }

    fn bump_failure(&self, key: &str, value: Option<&V>, options: &SwrOptions<V, E>) {
        let paused = options
            .paused_until
            .as_ref()
            .map(|paused| paused(value))
            .unwrap_or(0);
        let now = self.now();
        let mut state = self.inner.state.lock().unwrap();
        let count = state
            .failures
            .get(key)
            .map(|(count, _)| *count)
            .unwrap_or(0)
            + 1;
        let backoff = (30_000i64 << (count - 1).min(10)).min(10 * 60_000);
        state
            .failures
            .insert(key.to_owned(), (count, (now + backoff).max(paused)));
    }

    /// Reads once however many ask, keeps the answer, tells the clients.
    fn read(&self, key: &str, options: &SwrOptions<V, E>) -> Flight<V, E> {
        let mut state = self.inner.state.lock().unwrap();
        if let Some((_, flying)) = state.in_flight.get(key) {
            return flying.clone();
        }
        let now = self.now();
        state.started.push_back(now);
        let id = state.next_flight;
        state.next_flight += 1;
        let cache = self.clone();
        let owned_key = key.to_owned();
        let options = options.clone();
        let task: BoxFuture<Result<V, E>> = Box::pin(async move {
            let key = owned_key;
            let head = match &options.head {
                Some(head) => head().await,
                None => None,
            };
            let result = (options.load)().await;
            let outcome = match result {
                Err(error) => {
                    cache.bump_failure(&key, None, &options);
                    Err(error)
                }
                Ok(value) => {
                    if options.failed.as_ref().is_some_and(|failed| failed(&value)) {
                        cache.bump_failure(&key, Some(&value), &options);
                    } else {
                        let ttl = (options.ttl)(&value);
                        let kept = {
                            let mut state = cache.inner.state.lock().unwrap();
                            state.failures.remove(&key);
                            if ttl > 0 {
                                Some(cache.put(&mut state, &key, value.clone(), ttl, head))
                            } else {
                                state.entries.remove(&key);
                                None
                            }
                        };
                        cache.changed();
                        if let (Some(fetched_at), Some(publish)) = (kept, &cache.inner.publish) {
                            publish(&key, &value, fetched_at);
                        }
                    }
                    Ok(value)
                }
            };
            let mut state = cache.inner.state.lock().unwrap();
            if state
                .in_flight
                .get(&key)
                .is_some_and(|(flight, _)| *flight == id)
            {
                state.in_flight.remove(&key);
            }
            outcome
        });
        let shared = task.shared();
        state.in_flight.insert(key.to_owned(), (id, shared.clone()));
        shared
    }

    /// The answer known for a key, whatever its age.
    pub fn peek(&self, key: &str) -> Option<SwrAnswer<V>> {
        let now = self.now();
        let state = self.inner.state.lock().unwrap();
        let known = state.entries.get(key)?;
        Some(SwrAnswer {
            value: known.value.clone(),
            fetched_at: known.fetched_at,
            stale: now - known.fetched_at >= known.ttl_ms,
        })
    }

    /// The answer for a key: known and young, at once; known and old, at
    /// once too while a background read (if the budget and the source allow
    /// it) replaces it; unknown or `fresh`, after the read.
    pub async fn get(&self, key: &str, options: &SwrOptions<V, E>) -> Result<SwrAnswer<V>, E> {
        let at = self.now();
        let known = self.inner.state.lock().unwrap().entries.get(key).cloned();
        let head = match (&options.head, &known) {
            (Some(head), Some(_)) => head().await,
            _ => None,
        };
        // An answer of another ref is not reused; one whose commit moved
        // is due.
        let reusable = known.as_ref().is_some_and(|known| {
            options.head.is_none()
                || head.is_none()
                || head_ref(known.head.as_deref()).is_empty()
                || head_ref(known.head.as_deref()) == head_ref(head.as_deref())
        });
        let moved = known.as_ref().is_some_and(
            |known| matches!((&head, &known.head), (Some(now), Some(then)) if now != then),
        );
        let known = known.filter(|_| reusable);
        if let Some(known) = &known
            && !options.fresh
        {
            if at - known.fetched_at < known.ttl_ms && !moved {
                return Ok(SwrAnswer {
                    value: known.value.clone(),
                    fetched_at: known.fetched_at,
                    stale: false,
                });
            }
            let blocked = {
                let mut state = self.inner.state.lock().unwrap();
                let paused = state.failures.get(key).map(|(_, at)| *at).unwrap_or(0);
                paused > at
                    || options
                        .paused_until
                        .as_ref()
                        .is_some_and(|paused| paused(Some(&known.value)) > at)
                    || (!state.in_flight.contains_key(key) && !self.budget_left(&mut state))
            };
            if !blocked {
                // Kept on failure: the next ask retries after its backoff.
                tokio::spawn(self.read(key, options));
            }
            return Ok(SwrAnswer {
                value: known.value.clone(),
                fetched_at: known.fetched_at,
                stale: true,
            });
        }
        let value = self.read(key, options).await?;
        // A refresh that failed does not take the known answer away.
        if let Some(known) = known
            && options.failed.as_ref().is_some_and(|failed| failed(&value))
        {
            return Ok(SwrAnswer {
                value: known.value,
                fetched_at: known.fetched_at,
                stale: true,
            });
        }
        let fetched_at = self
            .inner
            .state
            .lock()
            .unwrap()
            .entries
            .get(key)
            .map(|entry| entry.fetched_at)
            .unwrap_or_else(|| self.now());
        Ok(SwrAnswer {
            value,
            fetched_at,
            stale: false,
        })
    }

    /// Facts known elsewhere: forgets the answers whose key matches.
    pub fn invalidate(&self, matches: impl Fn(&str) -> bool) {
        let changed = {
            let mut state = self.inner.state.lock().unwrap();
            let keys: Vec<String> = state
                .entries
                .keys()
                .filter(|key| matches(key))
                .cloned()
                .collect();
            for key in &keys {
                state.entries.remove(key);
                state.failures.remove(key);
            }
            !keys.is_empty()
        };
        if changed {
            self.changed();
        }
    }

    /// Hands the cache an answer read elsewhere.
    pub fn offer(&self, key: &str, value: V, ttl_ms: i64, head: Option<String>) {
        if ttl_ms <= 0 {
            return;
        }
        let fetched_at = {
            let mut state = self.inner.state.lock().unwrap();
            self.put(&mut state, key, value.clone(), ttl_ms, head)
        };
        self.changed();
        if let Some(publish) = &self.inner.publish {
            publish(key, &value, fetched_at);
        }
    }

    pub fn len(&self) -> usize {
        self.inner.state.lock().unwrap().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The answers kept, to write them out.
    pub fn entries(&self) -> Vec<(String, Stored<V>)> {
        let state = self.inner.state.lock().unwrap();
        let mut out: Vec<(String, Stored<V>)> = state
            .entries
            .iter()
            .map(|(key, entry)| (key.clone(), entry.clone()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Answers read back from where they were written.
    pub fn restore(&self, entries: impl IntoIterator<Item = (String, Stored<V>)>) {
        let mut state = self.inner.state.lock().unwrap();
        state.entries.extend(entries);
    }
}

// ---------------------------------------------------------------- memo

type MemoEntry<V, E> = (i64, Flight<V, E>, u64);

/// An answer shared by every caller until it settles and then for its TTL;
/// a failure is forgotten at once, so that the next caller asks again.
pub struct Memo<V, E> {
    clock: Arc<dyn Clock>,
    entries: Arc<Mutex<HashMap<String, MemoEntry<V, E>>>>,
    next: Arc<Mutex<u64>>,
}

impl<V, E> Clone for Memo<V, E> {
    fn clone(&self) -> Self {
        Self {
            clock: self.clock.clone(),
            entries: self.entries.clone(),
            next: self.next.clone(),
        }
    }
}

impl<V, E> Memo<V, E>
where
    V: Clone + Send + Sync + 'static,
    E: Clone + Send + Sync + 'static,
{
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            entries: Arc::default(),
            next: Arc::default(),
        }
    }

    /// `load`'s answer for `key`, kept `ttl(value)` ms once it settles.
    pub fn get<Fut>(
        &self,
        key: &str,
        ttl: impl Fn(&V) -> i64 + Send + 'static,
        load: impl FnOnce() -> Fut,
    ) -> Flight<V, E>
    where
        Fut: Future<Output = Result<V, E>> + Send + 'static,
    {
        let mut entries = self.entries.lock().unwrap();
        if let Some((until, value, _)) = entries.get(key)
            && *until > self.clock.now()
        {
            return value.clone();
        }
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        let (clock, map, owned) = (self.clock.clone(), self.entries.clone(), key.to_owned());
        let loading = load();
        let task: BoxFuture<Result<V, E>> = Box::pin(async move {
            let result = loading.await;
            let mut entries = map.lock().unwrap();
            if let Some(entry) = entries.get_mut(&owned)
                && entry.2 == id
            {
                match &result {
                    Ok(value) => entry.0 = clock.now() + ttl(value),
                    Err(_) => {
                        entries.remove(&owned);
                    }
                }
            }
            result
        });
        let shared = task.shared();
        entries.insert(key.to_owned(), (i64::MAX, shared.clone(), id));
        shared
    }
}

// ---------------------------------------------------------------- queue

/// One task at a time per key, each after the one before it ended (failed
/// or not); a key is forgotten when its last task ends (review/memo.ts's
/// `serialize`).
#[derive(Clone, Default)]
pub struct KeyedQueue {
    queues: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

impl KeyedQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run<T, Fut: Future<Output = T>>(
        &self,
        key: &str,
        task: impl FnOnce() -> Fut,
    ) -> T {
        let lock = self
            .queues
            .lock()
            .unwrap()
            .entry(key.to_owned())
            .or_default()
            .clone();
        let output = {
            let _turn = lock.lock().await;
            task().await
        };
        let mut queues = self.queues.lock().unwrap();
        // Ours and the map's: no one else waits.
        if Arc::strong_count(&lock) == 2 {
            queues.remove(key);
        }
        output
    }

    /// Keys with a task running or waiting.
    pub fn len(&self) -> usize {
        self.queues.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TestClock;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn turns() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    fn counting(
        calls: &Arc<AtomicUsize>,
        answer: impl Fn(usize) -> Result<String, String> + Send + Sync + 'static,
    ) -> SwrOptions<String, String> {
        let calls = calls.clone();
        let answer = Arc::new(answer);
        SwrOptions::new(1_000, move || {
            let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
            let answer = answer.clone();
            async move {
                tokio::task::yield_now().await;
                answer(call)
            }
        })
    }

    #[tokio::test]
    async fn one_read_serves_everyone_who_waits_for_it() {
        let clock = TestClock::new(0);
        let cache: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), SwrSettings::default);
        let calls = Arc::new(AtomicUsize::new(0));
        let options = counting(&calls, |call| Ok(format!("v{call}")));
        let (one, two) = tokio::join!(cache.get("k", &options), cache.get("k", &options));
        assert_eq!(one.unwrap().value, "v1");
        assert_eq!(two.unwrap().value, "v1");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn young_answers_are_served_and_old_ones_refreshed_behind() {
        let clock = TestClock::new(0);
        let published: Arc<Mutex<Vec<(String, String, i64)>>> = Arc::default();
        let changes = Arc::new(AtomicUsize::new(0));
        let cache: SwrCache<String, String> = SwrCache::with_hooks(
            Arc::new(clock.clone()),
            SwrSettings::default,
            Some({
                let published = published.clone();
                Arc::new(move |key: &str, value: &String, at: i64| {
                    published
                        .lock()
                        .unwrap()
                        .push((key.into(), value.clone(), at))
                })
            }),
            Some({
                let changes = changes.clone();
                Arc::new(move || {
                    changes.fetch_add(1, Ordering::SeqCst);
                })
            }),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let options = counting(&calls, |call| Ok(format!("v{call}")));
        let first = cache.get("k", &options).await.unwrap();
        assert_eq!((first.value.as_str(), first.stale), ("v1", false));
        clock.advance(999).await;
        let young = cache.get("k", &options).await.unwrap();
        assert_eq!((young.value.as_str(), young.stale), ("v1", false));
        clock.advance(1).await;
        let old = cache.get("k", &options).await.unwrap();
        assert_eq!((old.value.as_str(), old.stale), ("v1", true));
        turns().await;
        let refreshed = cache.get("k", &options).await.unwrap();
        assert_eq!(
            (refreshed.value.as_str(), refreshed.fetched_at),
            ("v2", 1_000)
        );
        assert_eq!(
            *published.lock().unwrap(),
            vec![
                ("k".into(), "v1".into(), 0),
                ("k".into(), "v2".into(), 1_000)
            ]
        );
        assert_eq!(changes.load(Ordering::SeqCst), 2);
        assert!(cache.peek("k").is_some_and(|answer| !answer.stale));
    }

    #[tokio::test]
    async fn background_reads_stay_within_the_budget() {
        let clock = TestClock::new(0);
        let cache: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), || SwrSettings {
                budget_per_minute: 2,
                max_entries: 1000,
            });
        let calls = Arc::new(AtomicUsize::new(0));
        let options = counting(&calls, |call| Ok(format!("v{call}")));
        for key in ["a", "b"] {
            cache.get(key, &options).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        clock.advance(1_000).await;
        // Two reads started this minute already: stale, and no read.
        assert!(cache.get("a", &options).await.unwrap().stale);
        turns().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        clock.advance(59_000).await;
        cache.get("a", &options).await.unwrap();
        turns().await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn failures_keep_the_known_answer_and_back_off() {
        let clock = TestClock::new(0);
        let cache: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), SwrSettings::default);
        let calls = Arc::new(AtomicUsize::new(0));
        let options = counting(&calls, |call| {
            if call == 1 {
                Ok("v1".into())
            } else {
                Err("down".into())
            }
        });
        cache.get("k", &options).await.unwrap();
        clock.advance(1_000).await;
        assert_eq!(cache.get("k", &options).await.unwrap().value, "v1");
        turns().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // 30 s backoff after the first failure.
        clock.advance(29_999).await;
        cache.get("k", &options).await.unwrap();
        turns().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        clock.advance(1).await;
        cache.get("k", &options).await.unwrap();
        turns().await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // Unknown keys report the error.
        let error = cache.get("other", &options).await.unwrap_err();
        assert_eq!(error, "down");
    }

    #[tokio::test]
    async fn a_failure_answer_is_not_kept_and_a_refresh_keeps_what_was_known() {
        let clock = TestClock::new(0);
        let cache: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), SwrSettings::default);
        let calls = Arc::new(AtomicUsize::new(0));
        let mut options = counting(&calls, |call| {
            Ok(if call == 1 {
                "v1".into()
            } else {
                "unavailable".into()
            })
        });
        options.failed = Some(Arc::new(|value: &String| value == "unavailable"));
        cache.get("k", &options).await.unwrap();
        let mut fresh = options.clone();
        fresh.fresh = true;
        let answer = cache.get("k", &fresh).await.unwrap();
        assert_eq!((answer.value.as_str(), answer.stale), ("v1", true));
        assert_eq!(cache.peek("k").unwrap().value, "v1");
        let unknown = cache.get("new", &options).await.unwrap();
        assert_eq!(unknown.value, "unavailable");
        assert!(cache.peek("new").is_none());
    }

    #[tokio::test]
    async fn the_oldest_answers_go_past_the_cap_and_invalidate_forgets() {
        let clock = TestClock::new(0);
        let cache: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), || SwrSettings {
                budget_per_minute: 20,
                max_entries: 2,
            });
        for key in ["a", "b", "c"] {
            cache.offer(key, key.to_uppercase(), 1_000, None);
            clock.advance(1).await;
        }
        cache.offer("zero", "Z".into(), 0, None);
        assert_eq!(
            cache
                .entries()
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        cache.invalidate(|key| key == "b");
        assert_eq!(cache.len(), 1);
        let restored: SwrCache<String, String> =
            SwrCache::new(Arc::new(clock.clone()), SwrSettings::default);
        restored.restore(cache.entries());
        assert_eq!(restored.peek("c").unwrap().value, "C");
    }

    #[tokio::test]
    async fn a_memo_shares_an_answer_then_keeps_it_for_its_ttl() {
        let clock = TestClock::new(0);
        let memo: Memo<u32, String> = Memo::new(Arc::new(clock.clone()));
        let calls = Arc::new(AtomicUsize::new(0));
        let load = |result: Result<u32, String>| {
            let calls = calls.clone();
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async move { result }
            }
        };
        let one = memo.get("k", |_| 100, load(Ok(1)));
        let two = memo.get("k", |_| 100, load(Ok(2)));
        assert_eq!((one.await, two.await), (Ok(1), Ok(1)));
        clock.advance(99).await;
        assert_eq!(memo.get("k", |_| 100, load(Ok(3))).await, Ok(1));
        clock.advance(1).await;
        assert_eq!(memo.get("k", |_| 100, load(Ok(4))).await, Ok(4));
        // A failure is forgotten at once.
        assert_eq!(
            memo.get("bad", |_| 100, load(Err("no".into()))).await,
            Err("no".into())
        );
        assert_eq!(memo.get("bad", |_| 100, load(Ok(5))).await, Ok(5));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn a_keyed_queue_runs_one_task_at_a_time_per_key() {
        let queue = KeyedQueue::new();
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let step = |name: &'static str| {
            let log = log.clone();
            move || async move {
                log.lock().unwrap().push(format!("{name} start"));
                tokio::task::yield_now().await;
                log.lock().unwrap().push(format!("{name} end"));
            }
        };
        tokio::join!(
            queue.run("a", step("a1")),
            queue.run("a", step("a2")),
            queue.run("b", step("b1"))
        );
        let log = log.lock().unwrap();
        let at = |entry: &str| log.iter().position(|line| line == entry).unwrap();
        assert!(at("a1 end") < at("a2 start"));
        assert!(at("b1 start") < at("a1 end"));
        assert!(queue.is_empty());
    }
}
