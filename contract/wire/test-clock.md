# Test clock

The parity harness controls the server's time so that scenarios about idle
stop, limit-resume, the work board's checks, cache TTLs, SSH backoff,
notification pings, the voice helper's ping and stuck timers, login cooldowns
and every other deadline run the same way on every server and every machine.
Both servers implement this contract; the Bun server's implementation is
`server/src/utils/test-clock.ts`.

## Enabling

| Variable                    | Meaning                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ROAMGATE_TEST_CLOCK`       | Path of the Unix socket the server listens on for the control protocol. Unset or empty: the real clock, at no cost.    |
| `ROAMGATE_TEST_CLOCK_EPOCH` | Optional start time, in epoch milliseconds (a non-negative safe integer). Unset: the real time when the server starts. |

- Only a server run from source or a test build honours the variables. A
  release build refuses to start when `ROAMGATE_TEST_CLOCK` is set (exit code
  1, a message on stderr); it never runs on a virtual clock.
- The clock is installed before any other server code runs, so no module sees
  the real time first.
- The server removes both variables from its own environment once the clock is
  installed: child processes (hooks, CLI calls, helpers) keep the real clock.
- A stale file at the socket path is replaced.

## Control protocol

A stream socket at the given path. Each request is one line of ASCII ending
with `\n`; each gets exactly one reply line ending with `\n`. Requests on one
connection are answered in order; a client may keep the connection or open one
per request.

| Request                                | Reply                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `now`                                  | The virtual time, epoch milliseconds, as a decimal integer.                                                                                      |
| `advance <ms>`                         | `<ms>` is a decimal whole number of milliseconds (`0` allowed). Replies with the new virtual time once every timer due up to it ran (see below). |
| anything else, or a malformed duration | `error <message>`; the clock does not move.                                                                                                      |

Leading and trailing spaces are ignored; blank lines get no reply.

## Semantics

- **Time moves only on `advance`.** Real time passing changes nothing. The
  wall clock (`now`) and the monotonic clock move together, by the same
  amount.
- **Due timers run by themselves.** A timer whose deadline is the current
  virtual time (a zero, negative or non-numeric delay) runs on the next event
  loop turn without an `advance`. Any later deadline waits for an `advance`
  that reaches it.
- **Delays** are rounded up to whole milliseconds. An interval's period is at
  least 1 ms; each run schedules the next one period after the previous
  deadline (no drift, no catch-up skipping: an `advance` over several periods
  runs it once per period).
- **Order.** Timers fire in deadline order; equal deadlines fire in the order
  the timers were created (a refreshed timer counts as created at its
  refresh). While a timer fires, the virtual time equals its deadline.
- **Between two timers** the server gets one turn of its event loop: pending
  promise continuations and ready I/O callbacks run before the next timer
  fires. Work that waits on real I/O longer than that (a fake answering over
  a socket) may still be pending; a scenario that needs it done advances in
  steps.
- **Timers created while advancing** fire within the same `advance` when their
  deadline is not past its target.
- **The reply** to `advance` comes after the virtual time reached the target
  and the timers due exactly then ran. Concurrent `advance` requests (from
  several connections) run one after the other, each relative to the time
  when it starts.
- **Errors** thrown by a timer's callback are reported as the server reports
  any uncaught error; the clock keeps going.
- **Liveness.** A virtual timer marked unreferenced does not keep the process
  alive, as with real timers; the control socket keeps the process alive only
  while a referenced virtual timer waits.

### What is virtual

Every reading of the current time and every timer the server's own code (and
its libraries, through the runtime's globals) creates:

| Bun                                                                                                                  | Rust                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Date.now()`, `new Date()`, `Date()`                                                                                 | `Clock::now()` (wall clock)                             |
| `performance.now()` (starts at its real value at install, then moves with the clock)                                 | `Clock::monotonic()`                                    |
| `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, and their handles' `ref`, `unref`, `hasRef`, `refresh` | `Clock::sleep`, `Clock::sleep_until`, `Clock::interval` |
| `Bun.sleep` (a delay or a `Date`)                                                                                    | `Clock::sleep_until`                                    |
| `AbortSignal.timeout` (aborts with a `TimeoutError`, unreferenced)                                                   | `Clock::timeout`                                        |

`new Date(value)` with an argument, date parsing and formatting are not
affected.

### What stays real

Timeouts enforced by the operating system or the runtime's native code: the
`timeout` option of a spawned process, socket and TLS idle timeouts, the HTTP
server's idle timeout, WebSocket keepalive, SQLite's busy timeout. They only
bound real I/O, which the harness's fakes answer at once. A scenario never
relies on them firing.

## The Rust `Clock` trait

The Rust server reads time and creates timers only through a `Clock` held in
its shared state; no other code calls `std::time::SystemTime::now`,
`Instant::now` or `tokio::time` directly (enforced with clippy's
`disallowed-methods`).

```rust
pub trait Clock: Send + Sync + 'static {
    /// Wall clock, epoch milliseconds.
    fn now(&self) -> i64;
    /// Monotonic milliseconds since an arbitrary origin.
    fn monotonic(&self) -> f64;
    /// Resolves once the clock reaches `deadline` (epoch milliseconds).
    fn sleep_until(&self, deadline: i64) -> BoxFuture<'static, ()>;
    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()>;
    /// Ticks every `period` (at least 1 ms) after the previous deadline.
    fn interval(&self, period: Duration) -> Interval;
    /// Runs `future`, or gives `Elapsed` once `duration` passed.
    fn timeout<F: Future>(&self, duration: Duration, future: F) -> Timeout<F>;
}
```

- `SystemClock` is the production implementation over the real clocks and
  `tokio::time`.
- `TestClock` implements this contract: a deadline-ordered queue of wakers
  (ties broken by creation order) that only `advance` moves, with one
  scheduler yield (`tokio::task::yield_now` on every task woken) between two
  deadlines. It cannot be tokio's paused time alone: a paused tokio runtime
  advances by itself whenever it is idle, which this contract forbids.
- The control socket is served by the `TestClock` on its own task, with the
  same requests and replies as above.
