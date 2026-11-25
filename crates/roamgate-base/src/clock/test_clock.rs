//! The test clock of contract/wire/test-clock.md (utils/test-clock.ts on
//! the Bun side): virtual time that only moves on `advance`.
//!
//! Every sleep, interval and timeout made through a [`TestClock`] is an
//! entry of a deadline-ordered queue (ties broken by creation order); an
//! `advance` walks the queue, moving the time to each deadline in turn and
//! waking what waits on it, with one scheduler yield between two deadlines
//! so that the tasks it woke run (and may add timers that fire within the
//! same `advance`). Concurrent advances run one after the other.
//!
//! Differences from the Bun clock, all from Rust having futures rather than
//! timer callbacks: a sleep is created when `sleep`/`sleep_until` is called
//! and cancelled when its future is dropped; restarting one (`refresh`) is
//! dropping it and sleeping again, which counts as created then; there is
//! no ref and unref (a Rust server lives as long as its main task, not as
//! long as its timers). On a multi-thread runtime a woken task may still be
//! running on another worker when the next deadline fires; the parity
//! harness's scenarios advance in steps when they need work done.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use super::{BoxFuture, Clock, Interval, ceil_ms};

pub const TEST_CLOCK_ENV: &str = "ROAMGATE_TEST_CLOCK";
/// Optional start time in epoch milliseconds; the real time when unset.
pub const TEST_CLOCK_EPOCH_ENV: &str = "ROAMGATE_TEST_CLOCK_EPOCH";

/// Whether this build honours `ROAMGATE_TEST_CLOCK`: debug builds and
/// builds with the `test-clock` feature, never a release.
pub const TEST_CLOCK_HONOURED: bool = cfg!(debug_assertions) || cfg!(feature = "test-clock");

struct Entry {
    due: i64,
    seq: u64,
    /// Repeat period of an interval, None for a sleep.
    period: Option<i64>,
    /// Still in the queue (a fired sleep is not).
    armed: bool,
    /// Deadlines reached and not yet taken by the waiting future.
    ticks: u64,
    waker: Option<Waker>,
}

struct State {
    now: i64,
    next_id: u64,
    next_seq: u64,
    entries: HashMap<u64, Entry>,
}

struct Inner {
    epoch: i64,
    monotonic_base: f64,
    state: Mutex<State>,
    advancing: tokio::sync::Mutex<()>,
}

impl Inner {
    fn add(&self, due: i64, period: Option<i64>) -> u64 {
        let mut state = self.state.lock().unwrap();
        let id = state.next_id;
        state.next_id += 1;
        let seq = state.next_seq;
        state.next_seq += 1;
        // A deadline already reached is due by itself, without an advance.
        let reached = period.is_none() && due <= state.now;
        state.entries.insert(
            id,
            Entry {
                due,
                seq,
                period,
                armed: !reached,
                ticks: u64::from(reached),
                waker: None,
            },
        );
        id
    }

    fn remove(&self, id: u64) {
        self.state.lock().unwrap().entries.remove(&id);
    }

    /// Takes one tick of `id`, or keeps the waker for the next.
    fn poll_tick(&self, id: u64, context: &Context<'_>) -> Poll<()> {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.entries.get_mut(&id) else {
            return Poll::Ready(());
        };
        if entry.ticks > 0 {
            entry.ticks -= 1;
            return Poll::Ready(());
        }
        entry.waker = Some(context.waker().clone());
        Poll::Pending
    }

    /// Fires the earliest armed entry due at `target` at the latest, moving
    /// the time to its deadline; false when there is none.
    fn fire_next(&self, target: i64) -> bool {
        let mut state = self.state.lock().unwrap();
        let next = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.armed && entry.due <= target)
            .min_by_key(|(_, entry)| (entry.due, entry.seq))
            .map(|(id, _)| *id);
        let Some(id) = next else {
            return false;
        };
        let seq = state.next_seq;
        state.next_seq += 1;
        let due = state.entries[&id].due;
        if due > state.now {
            state.now = due;
        }
        let entry = state.entries.get_mut(&id).unwrap();
        match entry.period {
            Some(period) => {
                entry.due += period;
                entry.seq = seq;
            }
            None => entry.armed = false,
        }
        entry.ticks += 1;
        if let Some(waker) = entry.waker.take() {
            waker.wake();
        }
        true
    }
}

/// A virtual clock (see the module's documentation). Clones share it.
#[derive(Clone)]
pub struct TestClock {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TestClock {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TestClock")
            .field("now", &self.now())
            .field("pending", &self.pending())
            .finish()
    }
}

impl TestClock {
    /// A clock reading `epoch` (epoch milliseconds), its monotonic clock 0.
    pub fn new(epoch: i64) -> Self {
        Self::with_monotonic_base(epoch, 0.0)
    }

    /// A clock reading `epoch`, its monotonic clock `monotonic_base`.
    pub fn with_monotonic_base(epoch: i64, monotonic_base: f64) -> Self {
        Self {
            inner: Arc::new(Inner {
                epoch,
                monotonic_base,
                state: Mutex::new(State {
                    now: epoch,
                    next_id: 1,
                    next_seq: 1,
                    entries: HashMap::new(),
                }),
                advancing: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// Sleeps and intervals not yet fired or dropped.
    pub fn pending(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .filter(|entry| entry.armed)
            .count()
    }

    /// Moves the time forward by `ms`, waking every sleep and interval due
    /// on the way in deadline order with one scheduler yield between them,
    /// and gives the new time once what is due at the end was woken.
    pub async fn advance(&self, ms: u64) -> i64 {
        let _turn = self.inner.advancing.lock().await;
        let target = self
            .now()
            .saturating_add(i64::try_from(ms).unwrap_or(i64::MAX));
        loop {
            tokio::task::yield_now().await;
            if self.inner.fire_next(target) {
                continue;
            }
            let mut state = self.inner.state.lock().unwrap();
            if state.now >= target {
                return state.now;
            }
            state.now = target;
        }
    }
}

struct Sleep {
    inner: Arc<Inner>,
    id: u64,
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        self.inner.poll_tick(self.id, context)
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        self.inner.remove(self.id);
    }
}

/// An interval's queue entry, removed with the interval.
struct Ticker {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for Ticker {
    fn drop(&mut self) {
        self.inner.remove(self.id);
    }
}

struct Tick {
    ticker: Arc<Ticker>,
}

impl Future for Tick {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        self.ticker.inner.poll_tick(self.ticker.id, context)
    }
}

impl Clock for TestClock {
    fn now(&self) -> i64 {
        self.inner.state.lock().unwrap().now
    }

    fn monotonic(&self) -> f64 {
        self.inner.monotonic_base + (self.now() - self.inner.epoch) as f64
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        let id = self.inner.add(deadline, None);
        Box::pin(Sleep {
            inner: self.inner.clone(),
            id,
        })
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        let delay = i64::try_from(ceil_ms(duration)).unwrap_or(i64::MAX);
        self.sleep_until(self.now().saturating_add(delay))
    }

    fn interval(&self, period: Duration) -> Interval {
        let period = i64::try_from(ceil_ms(period).max(1)).unwrap_or(i64::MAX);
        let id = self
            .inner
            .add(self.now().saturating_add(period), Some(period));
        let ticker = Arc::new(Ticker {
            inner: self.inner.clone(),
            id,
        });
        Interval::new(move || {
            Box::pin(Tick {
                ticker: ticker.clone(),
            })
        })
    }
}

/// One reply line for one request line of the control protocol.
pub async fn answer(clock: &TestClock, line: &str) -> String {
    let trimmed = line.trim();
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    match words.as_slice() {
        ["now"] => clock.now().to_string(),
        ["advance", duration] => {
            if !duration.bytes().all(|byte| byte.is_ascii_digit()) {
                return format!("error bad duration: {duration}");
            }
            match duration.parse::<u64>() {
                Ok(ms) if ms <= 9_007_199_254_740_991 => clock.advance(ms).await.to_string(),
                _ => format!("error bad duration: {duration}"),
            }
        }
        _ => format!("error unknown command: {trimmed}"),
    }
}

/// Serves the control protocol on a Unix socket at `path` (a stale file
/// there is replaced; on Windows an `AF_UNIX` socket too, as Bun's
/// `Bun.listen({ unix })`): one reply line per request line, in order per
/// connection, blank lines ignored. Runs until the returned task is aborted.
pub fn serve(
    clock: TestClock,
    path: &std::path::Path,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let _ = std::fs::remove_file(path);
    let listener = crate::local_socket::Listener::bind(path)?;
    Ok(tokio::spawn(async move {
        while let Ok(stream) = listener.accept().await {
            let clock = clock.clone();
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(stream);
                let mut lines = BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let reply = answer(&clock, &line).await;
                    if write
                        .write_all(format!("{reply}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    }))
}

/// Where the environment is read from and the variables removed. The
/// process's own environment cannot be changed safely in Rust 2024 (a
/// `deny(unsafe_code)` crate cannot call `std::env::remove_var`): the server
/// keeps its environment as a map it reads and hands its children, and the
/// variables are removed from that map.
pub trait EnvSource {
    fn var(&self, name: &str) -> Option<String>;
    fn remove(&mut self, name: &str);
}

impl EnvSource for HashMap<String, String> {
    fn var(&self, name: &str) -> Option<String> {
        self.get(name).cloned()
    }

    fn remove(&mut self, name: &str) {
        HashMap::remove(self, name);
    }
}

/// What `ROAMGATE_TEST_CLOCK` asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestClockConfig {
    /// The control socket's path.
    pub socket: std::path::PathBuf,
    /// The start time, epoch milliseconds; None: the real time.
    pub epoch: Option<i64>,
}

impl TestClockConfig {
    /// The clock, starting at the configured time or `real_now`, its
    /// monotonic clock at `monotonic_base`.
    pub fn clock(&self, real_now: i64, monotonic_base: f64) -> TestClock {
        TestClock::with_monotonic_base(self.epoch.unwrap_or(real_now), monotonic_base)
    }
}

/// The test clock the environment asks for: None without
/// `ROAMGATE_TEST_CLOCK` (or with it empty); an error when this build does
/// not honour it (`honoured` false: the release refuses to start) or the
/// epoch is not epoch milliseconds. Once accepted, both variables are
/// removed from `env` so that child processes keep the real clock.
pub fn test_clock_from_env(
    env: &mut impl EnvSource,
    honoured: bool,
) -> Result<Option<TestClockConfig>, String> {
    let Some(path) = env.var(TEST_CLOCK_ENV).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    if !honoured {
        return Err(format!(
            "{TEST_CLOCK_ENV} is only honoured by a test build of the server, never by a release build."
        ));
    }
    let epoch = match env
        .var(TEST_CLOCK_EPOCH_ENV)
        .filter(|text| !text.is_empty())
    {
        None => None,
        Some(text) => match text.trim().parse::<i64>() {
            Ok(epoch) if (0..=9_007_199_254_740_991).contains(&epoch) => Some(epoch),
            _ => {
                return Err(format!(
                    "{TEST_CLOCK_EPOCH_ENV} must be epoch milliseconds: {text}"
                ));
            }
        },
    };
    env.remove(TEST_CLOCK_ENV);
    env.remove(TEST_CLOCK_EPOCH_ENV);
    Ok(Some(TestClockConfig {
        socket: path.into(),
        epoch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::timeout;

    /// 2026-01-02T03:04:05Z.
    const EPOCH: i64 = 1_767_323_045_000;

    type Log = Arc<Mutex<Vec<String>>>;

    fn push(log: &Log, text: String) {
        log.lock().unwrap().push(text);
    }

    async fn turns() {
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn time_moves_only_on_advance_firing_timers_in_deadline_order() {
        let clock = TestClock::new(EPOCH);
        let fired: Log = Arc::default();
        for (name, delay) in [("b", 5), ("c", 10), ("a", 5)] {
            let (clock, fired) = (clock.clone(), fired.clone());
            let sleep = clock.sleep(Duration::from_millis(delay));
            tokio::spawn(async move {
                sleep.await;
                push(&fired, format!("{name}@{}", clock.now() - EPOCH));
            });
        }
        let mut interval = clock.interval(Duration::from_millis(4));
        let ticking = {
            let (clock, fired) = (clock.clone(), fired.clone());
            tokio::spawn(async move {
                loop {
                    interval.tick().await;
                    push(&fired, format!("i@{}", clock.now() - EPOCH));
                }
            })
        };
        turns().await;
        assert!(fired.lock().unwrap().is_empty());
        assert_eq!(clock.now(), EPOCH);

        assert_eq!(clock.advance(10).await, EPOCH + 10);
        turns().await;
        assert_eq!(
            *fired.lock().unwrap(),
            vec!["i@4", "b@5", "a@5", "i@8", "c@10"]
        );

        ticking.abort();
        turns().await;
        clock.advance(100).await;
        assert_eq!(fired.lock().unwrap().len(), 5);
        assert_eq!(clock.pending(), 0);
    }

    #[tokio::test]
    async fn a_timer_set_by_a_firing_timer_fires_in_the_same_advance() {
        let clock = TestClock::new(EPOCH);
        let fired: Arc<Mutex<Vec<i64>>> = Arc::default();
        let task = {
            let (clock, fired) = (clock.clone(), fired.clone());
            let first = clock.sleep(Duration::from_millis(20));
            tokio::spawn(async move {
                first.await;
                fired.lock().unwrap().push(clock.now() - EPOCH);
                clock.sleep(Duration::from_millis(30)).await;
                fired.lock().unwrap().push(clock.now() - EPOCH);
            })
        };
        clock.advance(60).await;
        task.await.unwrap();
        assert_eq!(*fired.lock().unwrap(), vec![20, 50]);
        assert_eq!(clock.now(), EPOCH + 60);
    }

    #[tokio::test]
    async fn continuations_settle_between_timers() {
        let clock = TestClock::new(EPOCH);
        let seen: Log = Arc::default();
        {
            let (sleep, seen) = (clock.sleep(Duration::from_millis(1)), seen.clone());
            tokio::spawn(async move {
                sleep.await;
                std::future::ready(()).await;
                std::future::ready(()).await;
                push(&seen, "first done".into());
            });
        }
        {
            let (sleep, seen) = (clock.sleep(Duration::from_millis(2)), seen.clone());
            tokio::spawn(async move {
                sleep.await;
                push(&seen, "second".into());
            });
        }
        clock.advance(2).await;
        turns().await;
        assert_eq!(*seen.lock().unwrap(), vec!["first done", "second"]);
    }

    #[tokio::test]
    async fn deadlines_already_reached_run_without_advancing_time() {
        let clock = TestClock::new(EPOCH);
        clock.sleep(Duration::ZERO).await;
        clock.sleep_until(EPOCH - 5).await;
        clock.sleep_until(EPOCH).await;
        assert_eq!(clock.now(), EPOCH);
        // A sub-millisecond delay rounds up to 1 ms and waits for it.
        let short = clock.sleep(Duration::from_micros(10));
        assert_eq!(clock.pending(), 1);
        drop(short);
        assert_eq!(clock.pending(), 0);
    }

    #[tokio::test]
    async fn a_restarted_sleep_counts_from_its_restart() {
        // The Bun clock's refresh(): here the sleep is dropped and made again.
        let clock = TestClock::new(EPOCH);
        let fired = Arc::new(Mutex::new(0));
        let sleep = clock.sleep(Duration::from_millis(10));
        clock.advance(8).await;
        drop(sleep);
        let task = {
            let (sleep, fired) = (clock.sleep(Duration::from_millis(10)), fired.clone());
            tokio::spawn(async move {
                sleep.await;
                *fired.lock().unwrap() += 1;
            })
        };
        clock.advance(8).await;
        turns().await;
        assert_eq!(*fired.lock().unwrap(), 0);
        clock.advance(2).await;
        task.await.unwrap();
        assert_eq!(*fired.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn every_reading_and_timer_goes_through_the_clock() {
        // The Bun clock routes Date, performance.now, timers, Bun.sleep and
        // AbortSignal.timeout; in Rust they are the Clock's methods.
        let clock = TestClock::with_monotonic_base(EPOCH, 1000.0);
        assert_eq!(clock.now(), EPOCH);
        assert_eq!(clock.monotonic(), 1000.0);
        let shared: Arc<dyn Clock> = Arc::new(clock.clone());
        let slept = Arc::new(Mutex::new(false));
        {
            let (shared, slept) = (shared.clone(), slept.clone());
            tokio::spawn(async move {
                shared.sleep(Duration::from_millis(500)).await;
                *slept.lock().unwrap() = true;
            });
        }
        let timed_out = Arc::new(Mutex::new(None));
        {
            let (shared, timed_out) = (shared.clone(), timed_out.clone());
            tokio::spawn(async move {
                let result = timeout(
                    shared.as_ref(),
                    Duration::from_millis(700),
                    std::future::pending::<()>(),
                )
                .await;
                *timed_out.lock().unwrap() = Some(result.is_err());
            });
        }
        turns().await;
        clock.advance(600).await;
        turns().await;
        assert!(*slept.lock().unwrap());
        assert_eq!(*timed_out.lock().unwrap(), None);
        clock.advance(400).await;
        turns().await;
        assert_eq!(*timed_out.lock().unwrap(), Some(true));
        assert_eq!(shared.now(), EPOCH + 1000);
        assert_eq!(shared.monotonic(), 2000.0);
    }

    #[tokio::test]
    async fn answers_now_and_advance_and_refuses_anything_else() {
        let clock = TestClock::new(EPOCH);
        assert_eq!(answer(&clock, "now").await, EPOCH.to_string());
        assert_eq!(
            answer(&clock, "advance 1500").await,
            (EPOCH + 1500).to_string()
        );
        assert_eq!(answer(&clock, "  now  ").await, (EPOCH + 1500).to_string());
        for bad in ["advance -1", "advance 1.5", "advance", "set 0", "now now"] {
            assert!(answer(&clock, bad).await.starts_with("error "), "{bad}");
        }
        assert_eq!(clock.now(), EPOCH + 1500);
    }

    #[tokio::test]
    async fn the_control_socket_answers_in_order_and_replaces_a_stale_file() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clock.sock");
        std::fs::write(&path, "stale").unwrap();
        let clock = TestClock::new(EPOCH);
        let server = serve(clock.clone(), &path).unwrap();
        let stream = crate::local_socket::connect(&path).await.unwrap();
        let (read, mut write) = tokio::io::split(stream);
        write
            .write_all(b"now\n\nadvance 250\n  now \nbogus\n")
            .await
            .unwrap();
        let mut lines = BufReader::new(read).lines();
        let mut replies = Vec::new();
        for _ in 0..4 {
            replies.push(lines.next_line().await.unwrap().unwrap());
        }
        assert_eq!(
            replies,
            vec![
                EPOCH.to_string(),
                (EPOCH + 250).to_string(),
                (EPOCH + 250).to_string(),
                "error unknown command: bogus".to_string(),
            ]
        );
        server.abort();
    }

    #[tokio::test]
    async fn concurrent_advances_run_one_after_the_other() {
        let clock = TestClock::new(EPOCH);
        let (one, two) = tokio::join!(clock.advance(100), clock.advance(50));
        // The first to start takes its turn; the second starts from there.
        assert_eq!(one, EPOCH + 100);
        assert_eq!(two, EPOCH + 150);
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn does_nothing_without_the_variable() {
        assert_eq!(test_clock_from_env(&mut env(&[]), true), Ok(None));
        assert_eq!(
            test_clock_from_env(&mut env(&[(TEST_CLOCK_ENV, "")]), true),
            Ok(None)
        );
        let mut accepted = env(&[
            (TEST_CLOCK_ENV, "/tmp/c.sock"),
            (TEST_CLOCK_EPOCH_ENV, "1000"),
        ]);
        assert_eq!(
            test_clock_from_env(&mut accepted, true),
            Ok(Some(TestClockConfig {
                socket: "/tmp/c.sock".into(),
                epoch: Some(1000)
            }))
        );
        assert!(accepted.is_empty(), "both variables removed");
    }

    #[test]
    fn a_release_build_refuses_it() {
        let mut environment = env(&[(TEST_CLOCK_ENV, "/tmp/clock.sock")]);
        let error = test_clock_from_env(&mut environment, false).unwrap_err();
        assert!(error.contains("never by a release build"), "{error}");
        assert_eq!(environment[TEST_CLOCK_ENV], "/tmp/clock.sock");
        const { assert!(TEST_CLOCK_HONOURED, "tests are a debug build") };
    }

    #[test]
    fn refuses_an_epoch_that_is_not_epoch_milliseconds() {
        for bad in ["yesterday", "-1", "1.5", "9007199254740992"] {
            let error = test_clock_from_env(
                &mut env(&[
                    (TEST_CLOCK_ENV, "/tmp/clock.sock"),
                    (TEST_CLOCK_EPOCH_ENV, bad),
                ]),
                true,
            )
            .unwrap_err();
            assert!(error.contains("epoch milliseconds"), "{bad}: {error}");
        }
    }
}
