//! What the tests share: Bun's fake timers on the test clock, gates and
//! flushing the single-threaded runtime.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use roamgate_agents::js;
use roamgate_base::clock::{Clock, TestClock};
use tokio::sync::Notify;

use crate::tools::BoxFuture;

pub(crate) async fn flush() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

/// A gate a child waits on (`Promise.withResolvers`).
#[derive(Default)]
pub(crate) struct Gate {
    open: AtomicBool,
    notify: Notify,
}

impl Gate {
    pub(crate) fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.open.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

/// A shared clock on a test's JestClock.
pub(crate) struct ClockRef(pub(crate) &'static JestClock);

impl Clock for ClockRef {
    fn now(&self) -> i64 {
        self.0.now()
    }

    fn monotonic(&self) -> f64 {
        self.0.monotonic()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        self.0.sleep_until(deadline)
    }

    fn sleep(&self, duration: std::time::Duration) -> BoxFuture<()> {
        self.0.sleep(duration)
    }

    fn interval(&self, period: std::time::Duration) -> roamgate_base::clock::Interval {
        self.0.interval(period)
    }
}

/// Bun's fake timers: the test clock, where a timer already due waits for
/// the next `advance` as `setTimeout(fn, 0)` waits for
/// `advanceTimersByTime(0)`, where the test clock fires it at once.
pub(crate) struct JestClock {
    clock: TestClock,
    /// The advances so far, and their signal.
    advances: Arc<(Notify, AtomicUsize)>,
}

impl JestClock {
    pub(crate) async fn advance(&self, ms: u64) {
        self.advances.1.fetch_add(1, Ordering::SeqCst);
        self.advances.0.notify_waiters();
        self.clock.advance(ms).await;
    }
}

impl Clock for JestClock {
    fn now(&self) -> i64 {
        self.clock.now()
    }

    fn monotonic(&self) -> f64 {
        self.clock.monotonic()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        if deadline > self.clock.now() {
            return self.clock.sleep_until(deadline);
        }
        let advances = self.advances.clone();
        let seen = advances.1.load(Ordering::SeqCst);
        Box::pin(async move {
            loop {
                let notified = advances.0.notified();
                if advances.1.load(Ordering::SeqCst) != seen {
                    return;
                }
                notified.await;
            }
        })
    }

    fn sleep(&self, duration: std::time::Duration) -> BoxFuture<()> {
        self.sleep_until(self.now() + duration.as_millis() as i64)
    }

    fn interval(&self, period: std::time::Duration) -> roamgate_base::clock::Interval {
        self.clock.interval(period)
    }
}

/// A test's clock, kept for the whole test (managers outlive their tasks).
pub(crate) fn clock_at(iso: &str) -> &'static JestClock {
    Box::leak(Box::new(JestClock {
        clock: TestClock::new(js::date_parse(iso) as i64),
        advances: Arc::default(),
    }))
}

/// A test's clock at epoch milliseconds.
pub(crate) fn clock_at_ms(ms: i64) -> &'static JestClock {
    Box::leak(Box::new(JestClock {
        clock: TestClock::new(ms),
        advances: Arc::default(),
    }))
}

/// `Promise.withResolvers<T>()`: settled once, awaited by any number.
#[allow(dead_code)]
pub(crate) struct Deferred<T: Clone + Send> {
    value: std::sync::Mutex<Option<Result<T, crate::errors::AssistantError>>>,
    notify: Notify,
}

impl<T: Clone + Send> Default for Deferred<T> {
    fn default() -> Self {
        Self {
            value: std::sync::Mutex::new(None),
            notify: Notify::new(),
        }
    }
}

#[allow(dead_code)]
impl<T: Clone + Send> Deferred<T> {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub(crate) fn resolve(&self, value: T) {
        let mut slot = self.value.lock().unwrap();
        if slot.is_none() {
            *slot = Some(Ok(value));
        }
        drop(slot);
        self.notify.notify_waiters();
    }

    pub(crate) fn reject(&self, error: crate::errors::AssistantError) {
        let mut slot = self.value.lock().unwrap();
        if slot.is_none() {
            *slot = Some(Err(error));
        }
        drop(slot);
        self.notify.notify_waiters();
    }

    pub(crate) fn settled(&self) -> bool {
        self.value.lock().unwrap().is_some()
    }

    pub(crate) async fn wait(&self) -> Result<T, crate::errors::AssistantError> {
        loop {
            let notified = self.notify.notified();
            if let Some(value) = self.value.lock().unwrap().clone() {
                return value;
            }
            notified.await;
        }
    }
}
