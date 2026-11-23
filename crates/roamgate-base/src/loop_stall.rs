//! Late ticks of the runtime (utils/loop-stall.ts): a tick each interval
//! notes how late it ran. The runtime was busy that long (a synchronous
//! parse, a large serialisation), and every call waiting on it with it.
//! Reported (the server logs it at debug) past a threshold.

use std::sync::Arc;
use std::time::Duration;

use crate::clock::Clock;

/// The defaults of the Bun server: a tick a second, reported from 250 ms.
pub const LOOP_STALL_INTERVAL: Duration = Duration::from_secs(1);
pub const LOOP_STALL_THRESHOLD_MS: f64 = 250.0;

/// The lateness bookkeeping, apart from the timer: `tick(at)` with the
/// monotonic time a tick ran gives how late it was when that is past the
/// threshold.
#[derive(Debug, Clone)]
pub struct StallMeter {
    interval_ms: f64,
    threshold_ms: f64,
    expected: f64,
}

impl StallMeter {
    pub fn new(start: f64, interval_ms: f64, threshold_ms: f64) -> Self {
        Self {
            interval_ms,
            threshold_ms,
            expected: start + interval_ms,
        }
    }

    /// The stall in whole milliseconds, if this tick ran late past the
    /// threshold.
    pub fn tick(&mut self, at: f64) -> Option<u64> {
        let late = at - self.expected;
        self.expected = at + self.interval_ms;
        (late >= self.threshold_ms).then(|| late.round() as u64)
    }
}

/// Watches the runtime on `clock`'s interval until the returned task is
/// aborted; `now` reads the time the lateness is measured with (the
/// clock's monotonic time when None), `report` gets `stalled_ms`.
pub fn watch_loop_stalls(
    clock: Arc<dyn Clock>,
    interval: Duration,
    threshold_ms: f64,
    now: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    report: impl Fn(u64) + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let now = now.unwrap_or_else(|| {
        let clock = clock.clone();
        Arc::new(move || clock.monotonic())
    });
    let mut meter = StallMeter::new(now(), interval.as_millis() as f64, threshold_ms);
    let mut ticks = clock.interval(interval);
    tokio::spawn(async move {
        loop {
            ticks.tick().await;
            if let Some(stalled) = meter.tick(now()) {
                report(stalled);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TestClock;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[tokio::test]
    async fn reports_a_tick_that_ran_late_past_the_threshold() {
        let clock = TestClock::new(0);
        let reading = Arc::new(AtomicU64::new(0));
        let reports: Arc<Mutex<Vec<u64>>> = Arc::default();
        let watch = {
            let reading = reading.clone();
            let reports = reports.clone();
            watch_loop_stalls(
                Arc::new(clock.clone()),
                LOOP_STALL_INTERVAL,
                LOOP_STALL_THRESHOLD_MS,
                Some(Arc::new(move || reading.load(Ordering::SeqCst) as f64)),
                move |stalled| reports.lock().unwrap().push(stalled),
            )
        };
        tokio::task::yield_now().await;
        for at in [1_000, 3_200, 4_300] {
            // The second tick ran 1.2 s late: the runtime was busy.
            reading.store(at, Ordering::SeqCst);
            clock.advance(1_000).await;
            tokio::task::yield_now().await;
        }
        watch.abort();
        assert_eq!(*reports.lock().unwrap(), vec![1_200]);
    }
}
