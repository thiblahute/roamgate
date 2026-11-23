//! The clock (contract/wire/test-clock.md): the server reads the time and
//! makes timers only through a [`Clock`], so that the parity harness's test
//! clock moves all of them. `SystemClock` is the real one; `TestClock` only
//! moves when its control socket says `advance <ms>`.
//!
//! The trait is the contract's, made object safe so that the server keeps
//! one `Arc<dyn Clock>` in its context: `timeout` is the free function
//! [`timeout`] rather than a generic method, and an [`Interval`] is a boxed
//! ticker each clock makes its own way.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

mod test_clock;

pub use test_clock::{
    EnvSource, TEST_CLOCK_ENV, TEST_CLOCK_EPOCH_ENV, TEST_CLOCK_HONOURED, TestClock,
    TestClockConfig, answer, serve, test_clock_from_env,
};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A shared clock, as the server's context holds it.
pub type SharedClock = Arc<dyn Clock>;

pub trait Clock: Send + Sync + 'static {
    /// Wall clock, epoch milliseconds.
    fn now(&self) -> i64;
    /// Monotonic milliseconds since an arbitrary origin.
    fn monotonic(&self) -> f64;
    /// Resolves once the clock reaches `deadline` (epoch milliseconds); at
    /// once when it is not in the future.
    fn sleep_until(&self, deadline: i64) -> BoxFuture<()>;
    /// Resolves once `duration` passed, rounded up to whole milliseconds.
    fn sleep(&self, duration: Duration) -> BoxFuture<()>;
    /// Ticks every `period` (at least 1 ms) after the previous deadline,
    /// the first time one period from now.
    fn interval(&self, period: Duration) -> Interval;
}

/// A ticker made by [`Clock::interval`].
pub struct Interval {
    next: Box<dyn FnMut() -> BoxFuture<()> + Send>,
}

impl Interval {
    /// An interval whose `tick` awaits what `next` gives each time.
    pub fn new(next: impl FnMut() -> BoxFuture<()> + Send + 'static) -> Self {
        Self {
            next: Box::new(next),
        }
    }

    /// Resolves at the next deadline.
    pub async fn tick(&mut self) {
        (self.next)().await
    }
}

/// `timeout` ran out before the future finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("deadline has elapsed")]
pub struct Elapsed;

/// Runs `future`, or gives [`Elapsed`] once `duration` passed on `clock`.
pub async fn timeout<F: Future>(
    clock: &dyn Clock,
    duration: Duration,
    future: F,
) -> Result<F::Output, Elapsed> {
    let sleep = clock.sleep(duration);
    tokio::select! {
        biased;
        output = future => Ok(output),
        () = sleep => Err(Elapsed),
    }
}

/// Whole milliseconds of `duration`, rounded up, as the contract's delays.
pub fn ceil_ms(duration: Duration) -> u64 {
    let nanos = duration.as_nanos();
    nanos.div_ceil(1_000_000).min(u64::MAX as u128) as u64
}

/// The real clocks and tokio's timers.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

#[allow(clippy::disallowed_methods)]
impl Clock for SystemClock {
    fn now(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    }

    fn monotonic(&self) -> f64 {
        static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        let origin = *ORIGIN.get_or_init(std::time::Instant::now);
        origin.elapsed().as_secs_f64() * 1000.0
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        let wait = (deadline - self.now()).max(0) as u64;
        Box::pin(tokio::time::sleep(Duration::from_millis(wait)))
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ceil_ms(duration))))
    }

    fn interval(&self, period: Duration) -> Interval {
        let period = Duration::from_millis(ceil_ms(period).max(1));
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
        let ticker = Arc::new(tokio::sync::Mutex::new(ticker));
        Interval::new(move || {
            let ticker = ticker.clone();
            Box::pin(async move {
                ticker.lock().await.tick().await;
            })
        })
    }
}

/// A clock on tokio's time alone: the wall clock is `epoch` plus the tokio
/// time passed since it was made. Under `tokio::time::pause` (a test with
/// `start_paused`) it moves only as tokio's paused time does, which
/// advances by itself whenever the runtime is idle: right for unit tests
/// of timers, not for the parity harness (that is [`TestClock`]'s job).
#[derive(Debug, Clone, Copy)]
pub struct TokioClock {
    epoch: i64,
    origin: tokio::time::Instant,
}

#[allow(clippy::disallowed_methods)]
impl TokioClock {
    /// A clock reading `epoch` (epoch milliseconds) now.
    pub fn starting_at(epoch: i64) -> Self {
        Self {
            epoch,
            origin: tokio::time::Instant::now(),
        }
    }

    fn elapsed_ms(&self) -> f64 {
        tokio::time::Instant::now()
            .duration_since(self.origin)
            .as_secs_f64()
            * 1000.0
    }
}

#[allow(clippy::disallowed_methods)]
impl Clock for TokioClock {
    fn now(&self) -> i64 {
        self.epoch + self.elapsed_ms().floor() as i64
    }

    fn monotonic(&self) -> f64 {
        self.elapsed_ms()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        let wait = (deadline - self.now()).max(0) as u64;
        Box::pin(tokio::time::sleep(Duration::from_millis(wait)))
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ceil_ms(duration))))
    }

    fn interval(&self, period: Duration) -> Interval {
        SystemClock.interval(period)
    }
}

#[cfg(test)]
mod system_tests {
    use super::*;

    #[test]
    fn delays_round_up_to_whole_milliseconds() {
        assert_eq!(ceil_ms(Duration::from_micros(1)), 1);
        assert_eq!(ceil_ms(Duration::from_millis(5)), 5);
        assert_eq!(ceil_ms(Duration::from_micros(5_001)), 6);
        assert_eq!(ceil_ms(Duration::ZERO), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_system_clock_times_out_on_tokio_time() {
        let clock = SystemClock;
        let late = timeout(
            &clock,
            Duration::from_millis(10),
            std::future::pending::<()>(),
        )
        .await;
        assert_eq!(late, Err(Elapsed));
        let fine = timeout(&clock, Duration::from_millis(10), async { 3 }).await;
        assert_eq!(fine, Ok(3));
        let mut interval = clock.interval(Duration::from_millis(5));
        interval.tick().await;
        interval.tick().await;
    }

    #[tokio::test(start_paused = true)]
    async fn the_tokio_clock_moves_with_paused_time() {
        let clock = TokioClock::starting_at(1_000);
        assert_eq!(clock.now(), 1_000);
        clock.sleep(Duration::from_millis(250)).await;
        assert_eq!(clock.now(), 1_250);
        clock.sleep_until(2_000).await;
        assert_eq!(clock.now(), 2_000);
        assert_eq!(clock.monotonic(), 1_000.0);
    }
}
