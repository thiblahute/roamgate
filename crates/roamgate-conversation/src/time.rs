//! The clock conversation mode's timers run on: `roamgate-base`'s
//! [`Clock`], so the parity harness's test clock moves them, and a
//! [`VirtualClock`] for polling loops in tests (`virtualClock` of
//! testing.ts: sleeping advances it at once).

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

pub use roamgate_base::clock::{BoxFuture, Clock, SharedClock, SystemClock, TokioClock};
use roamgate_base::clock::{Interval, ceil_ms};

/// Sleeps `ms` milliseconds on the clock.
pub fn sleep_ms(clock: &dyn Clock, ms: u64) -> BoxFuture<()> {
    clock.sleep(Duration::from_millis(ms))
}

/// A clock that moves only when slept on: each sleep advances it by its
/// length at once and lets other tasks run.
#[derive(Clone, Debug, Default)]
pub struct VirtualClock {
    now: Arc<AtomicI64>,
}

impl VirtualClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shared(&self) -> SharedClock {
        Arc::new(self.clone())
    }

    pub fn set(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }
}

impl Clock for VirtualClock {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn monotonic(&self) -> f64 {
        self.now() as f64
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        let wait = (deadline - self.now()).max(0) as u64;
        self.sleep(Duration::from_millis(wait))
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        let now = self.now.clone();
        let ms = ceil_ms(duration) as i64;
        Box::pin(async move {
            now.fetch_add(ms, Ordering::SeqCst);
            tokio::task::yield_now().await;
        })
    }

    fn interval(&self, period: Duration) -> Interval {
        let clock = self.clone();
        Interval::new(move || clock.sleep(period))
    }
}
