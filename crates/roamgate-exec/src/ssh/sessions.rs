//! SSH session slots per destination, the lanes that share them, the
//! runtime masters commands multiplex over, and running a host command
//! through all of it (bridge/ssh-sessions.ts).
//!
//! The TS module keeps its maps as module state; here they live in one
//! [`SshSessions`] the server holds in its context (cloned handles share
//! it), so tests each get their own. Time is the [`Clock`](roamgate_base::clock::Clock)'s.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use regex::Regex;
use roamgate_base::clock::{BoxFuture, SharedClock};
use tokio::sync::{oneshot, watch};
use tokio::task::AbortHandle;

use super::command::{SshCommand, SshRoute};

/// Concurrent SSH sessions per destination. OpenSSH's sshd defaults to
/// MaxSessions 10 per connection and MaxStartups 10 unauthenticated logins,
/// so a burst of host commands would otherwise have sessions refused or
/// logins dropped.
pub const SSH_SESSION_LIMIT: usize = 8;
/// Commands queued behind a full destination; past this a new one fails.
pub const SSH_SESSION_WAITER_LIMIT: usize = 64;
/// Longest wait for a slot when the caller has no deadline of its own.
pub const SSH_SESSION_DEFAULT_WAIT_MS: u64 = 60_000;
/// Slots background reads may hold at once.
pub const SSH_BACKGROUND_SESSION_LIMIT: usize = 5;
/// Background commands queued before more are shed.
pub const SSH_BACKGROUND_WAITER_LIMIT: usize = 64;
/// Long-lived sessions that may hold slots of a master at once, and only
/// while a slot is free.
pub const SSH_STREAM_SESSION_LIMIT: usize = 2;
/// Waits before a refused multiplexed command runs again over the master;
/// past the last, it runs on a connection of its own.
pub const SSH_REFUSED_RETRY_DELAYS_MS: [u64; 4] = [200, 500, 1000, 2000];
/// After a refusal no new slot is given past the ones in use until this
/// long after the last refusal.
pub const SSH_REFUSED_COOLDOWN_MS: i64 = 5_000;
/// A command run with a deadline ends on the host this long (seconds) after.
pub const SSH_REMOTE_GRACE_S: u64 = 2;
/// Refusals in a row, over at least SSH_MASTER_RECYCLE_AFTER_MS with none
/// served between, after which the master is closed and opened again.
pub const SSH_MASTER_RECYCLE_REFUSALS: u32 = 8;
pub const SSH_MASTER_RECYCLE_AFTER_MS: i64 = 15_000;
/// The least time between two recycles of one master.
pub const SSH_MASTER_RECYCLE_INTERVAL_MS: i64 = 60_000;

pub use crate::lanes::{Lane, current_lane, run_in_lane};
use crate::process::ProcessRunner;

/// Why a command got no session, or stopped waiting.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    #[error("ssh timed out after {timeout_ms}ms waiting for a session to {destination}")]
    WaitTimeout {
        destination: String,
        timeout_ms: u64,
    },
    #[error("ssh: {SSH_SESSION_WAITER_LIMIT} commands already waiting for {0}")]
    LineFull(String),
    /// A background command dropped because its line is full: nothing the
    /// user asked for failed, so callers log it quietly.
    #[error("ssh: {SSH_BACKGROUND_WAITER_LIMIT} background commands already waiting for {0}")]
    BackgroundShed(String),
    /// The caller's signal aborted, with its reason.
    #[error("{0}")]
    Aborted(String),
    /// The caller's budget ran out between attempts.
    #[error("ssh timed out after {0}ms")]
    Timeout(u64),
}

impl SessionError {
    pub fn is_background_shed(&self) -> bool {
        matches!(self, Self::BackgroundShed(_))
    }
}

/// Aborts the waits given its signal (an AbortController).
pub struct AbortController {
    tx: watch::Sender<Option<String>>,
}

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortController {
    pub fn new() -> Self {
        Self {
            tx: watch::channel(None).0,
        }
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal {
            rx: self.tx.subscribe(),
        }
    }

    pub fn abort(&self, reason: &str) {
        self.tx.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason.to_owned());
            true
        });
    }
}

#[derive(Debug, Clone)]
pub struct AbortSignal {
    rx: watch::Receiver<Option<String>>,
}

impl AbortSignal {
    /// A signal aborted already.
    pub fn aborted(reason: &str) -> Self {
        Self {
            rx: watch::channel(Some(reason.to_owned())).1,
        }
    }

    pub fn reason(&self) -> Option<String> {
        self.rx.borrow().clone()
    }

    fn check(&self) -> Result<(), SessionError> {
        match self.reason() {
            Some(reason) => Err(SessionError::Aborted(reason)),
            None => Ok(()),
        }
    }

    /// Resolves with the reason once aborted.
    pub async fn wait(&self) -> String {
        let mut rx = self.rx.clone();
        let reason = rx
            .wait_for(Option::is_some)
            .await
            .ok()
            .map(|reason| reason.clone().unwrap_or_default());
        match reason {
            Some(reason) => reason,
            None => std::future::pending().await,
        }
    }
}

async fn aborted(signal: Option<&AbortSignal>) -> String {
    match signal {
        Some(signal) => signal.wait().await,
        None => std::future::pending().await,
    }
}

fn check(signal: Option<&AbortSignal>) -> Result<(), SessionError> {
    signal.map_or(Ok(()), AbortSignal::check)
}

/// How long a caller waits for a session slot.
#[derive(Debug, Clone, Default)]
pub struct SshSessionWait {
    /// The caller's whole budget; the time spent queued counts against it.
    pub timeout_ms: Option<u64>,
    pub signal: Option<AbortSignal>,
}

impl SshSessionWait {
    pub fn timeout(timeout_ms: u64) -> Self {
        Self {
            timeout_ms: Some(timeout_ms),
            signal: None,
        }
    }

    pub fn signal(signal: AbortSignal) -> Self {
        Self {
            timeout_ms: None,
            signal: Some(signal),
        }
    }
}

/// A runtime's master, as commands see it.
#[derive(Clone)]
pub struct MasterRegistration {
    pub destination: String,
    pub control_path: String,
    /// Cheap per-command test: the process runs and its socket exists.
    pub is_listening: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Confirms the master still serves sessions (process alive, `-O check`).
    pub is_alive: Arc<dyn Fn() -> BoxFuture<bool> + Send + Sync>,
    /// Closes the master and opens a new one, for a host that keeps
    /// refusing its sessions.
    pub recycle: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// Who registered a master: masters are kept per owning runtime, not per
/// destination, so two runtimes reaching one host each own theirs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MasterOwner(u64);

/// What a command run gives back: its status and stderr, which `run` reads
/// and cleans of OpenSSH's lines about the master.
pub trait SshOutput {
    fn code(&self) -> i32;
    fn stderr(&self) -> &str;
    fn set_stderr(&mut self, stderr: String);
}

struct Waiter {
    id: u64,
    grant: oneshot::Sender<()>,
}

struct Slots {
    active: usize,
    /// Of `active`, those held by background commands.
    background: usize,
    /// Of `active`, those held by long-lived sessions.
    streams: usize,
    /// Sessions whose client was killed here and that may still run on the
    /// host until their deadline.
    lingering: usize,
    /// The most sessions the host serves while it recovers from a refusal.
    ceiling: usize,
    cooldown_until: i64,
    cooldown_timer: Option<AbortHandle>,
    waiters: VecDeque<Waiter>,
    background_waiters: VecDeque<Waiter>,
}

impl Slots {
    fn new() -> Self {
        Self {
            active: 0,
            background: 0,
            streams: 0,
            lingering: 0,
            ceiling: SSH_SESSION_LIMIT,
            cooldown_until: 0,
            cooldown_timer: None,
            waiters: VecDeque::new(),
            background_waiters: VecDeque::new(),
        }
    }

    /// How many slots the destination gives now.
    fn limit(&self, now: i64) -> usize {
        let sessions = if self.cooldown_until > now {
            self.ceiling
        } else {
            SSH_SESSION_LIMIT
        };
        sessions.saturating_sub(self.lingering)
    }

    /// Gives free slots to the waiters: interactive ones first.
    fn grant_waiters(&mut self, now: i64) {
        while self.active < self.limit(now) {
            if let Some(waiter) = self.waiters.pop_front() {
                if waiter.grant.send(()).is_ok() {
                    self.active += 1;
                }
                continue;
            }
            if self.background >= SSH_BACKGROUND_SESSION_LIMIT {
                return;
            }
            let Some(waiter) = self.background_waiters.pop_front() else {
                return;
            };
            if waiter.grant.send(()).is_ok() {
                self.active += 1;
                self.background += 1;
            }
        }
    }

    fn idle(&self, now: i64) -> bool {
        self.active == 0
            && self.lingering == 0
            && self.waiters.is_empty()
            && self.background_waiters.is_empty()
            && self.cooldown_until <= now
    }
}

#[derive(Default)]
struct Mux {
    active: usize,
    idle: Vec<oneshot::Sender<()>>,
}

struct Streak {
    since: i64,
    count: u32,
}

#[derive(Default)]
struct State {
    masters: Vec<(MasterOwner, MasterRegistration)>,
    slots: HashMap<String, Slots>,
    mux: HashMap<String, Mux>,
    streaks: HashMap<String, Streak>,
    last_recycles: HashMap<String, i64>,
}

struct Shared {
    clock: SharedClock,
    runner: ProcessRunner,
    windows: bool,
    state: Mutex<State>,
    next_id: AtomicU64,
}

/// The session slots, masters and lanes of every destination.
#[derive(Clone)]
pub struct SshSessions {
    shared: Arc<Shared>,
}

/// A held session slot: released once, by `release` or on drop.
pub struct SessionSlot {
    sessions: SshSessions,
    destination: String,
    background: bool,
    stream: bool,
    released: AtomicBool,
}

impl SessionSlot {
    pub fn release(&self) {
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let now = self.sessions.now();
        let mut state = self.sessions.lock();
        if let Some(slots) = state.slots.get_mut(&self.destination) {
            slots.active -= 1;
            if self.background {
                slots.background -= 1;
            }
            if self.stream {
                slots.streams -= 1;
            }
            // Hand the slot straight to the next waiter so a newcomer
            // cannot jump it.
            slots.grant_waiters(now);
        }
        forget_if_idle(&mut state, &self.destination, now);
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        self.release();
    }
}

/// A command in flight over a master's control socket.
pub struct MuxGuard {
    sessions: SshSessions,
    control_path: Option<String>,
    released: AtomicBool,
}

impl MuxGuard {
    pub fn release(&self) {
        let Some(path) = &self.control_path else {
            return;
        };
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut state = self.sessions.lock();
        let Some(entry) = state.mux.get_mut(path) else {
            return;
        };
        entry.active -= 1;
        if entry.active > 0 {
            return;
        }
        if let Some(entry) = state.mux.remove(path) {
            for idle in entry.idle {
                let _ = idle.send(());
            }
        }
    }
}

impl Drop for MuxGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// A held slot for a command the caller spawns itself.
pub struct SshSessionHold {
    slot: Option<SessionSlot>,
    mux: Option<MuxGuard>,
    /// What is left of the timeout after the wait; unset without one.
    pub remaining_ms: Option<u64>,
    /// What to spawn: the command given, or for a long-lived session past
    /// its share of the master, the same command on a connection of its own.
    pub command: SshCommand,
}

impl SshSessionHold {
    /// Releases the slot (once; dropping the hold does too).
    pub fn release(&self) {
        if let Some(mux) = &self.mux {
            mux.release();
        }
        if let Some(slot) = &self.slot {
            slot.release();
        }
    }
}

fn forget_if_idle(state: &mut State, destination: &str, now: i64) {
    if state
        .slots
        .get(destination)
        .is_some_and(|slots| slots.idle(now))
    {
        state.slots.remove(destination);
    }
}

// OpenSSH prints these when it could not use the master and already fell
// back to its own connection; a 255 then belongs to that cold attempt.
static MUX_FALLBACK_STDERR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Control socket connect|mux_client_request_session: session request failed")
        .unwrap()
});
// The master could not open the session: the host refused it (MaxSessions).
static MUX_REFUSED_STDERR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"mux_client_request_session: session request failed").unwrap());
static MUX_NOISE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"mux_client|Control socket connect|muxclient").unwrap());
// OpenSSH's lines about the master and its fallback, not the command's.
static MUX_NOISE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:Control socket connect\(.*|mux_client_\w+: .*|muxclient: .*|kex_exchange_identification: .*|Connection closed by UNKNOWN port \d+)$").unwrap()
});
static POWERSHELL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^powershell(?:\.exe)?\s").unwrap());

/// The command's stderr without OpenSSH's lines about the master.
pub fn without_mux_noise(stderr: &str) -> String {
    if !MUX_NOISE.is_match(stderr) {
        return stderr.to_owned();
    }
    stderr
        .split('\n')
        .filter(|line| !MUX_NOISE_LINE.is_match(line.strip_suffix('\r').unwrap_or(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Single quotes as POSIX shells read them, with backslashes outside the
/// quotes, since fish reads `\\` and `\'` inside single quotes as escapes.
fn any_shell_quote(value: &str) -> String {
    let mut out = String::from("'");
    for c in value.chars() {
        match c {
            '\'' => out.push_str(r"'\''"),
            '\\' => out.push_str(r"'\\'"),
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

/// The remote command line that runs `command` under /bin/sh, but kills it
/// and everything it started `seconds` from now: sshd gives each session
/// its own process group, and a command that waits on nothing it reads
/// would otherwise hold its session long after its client was killed. The
/// watchdog goes when the command ends. The outer line parses alike in sh,
/// bash, zsh and fish; PowerShell commands (Windows hosts) are left alone.
pub fn with_remote_deadline(command: &str, seconds: f64) -> String {
    if POWERSHELL.is_match(command) {
        return command.to_owned();
    }
    let script = r#"t=$1; c=$2; (trap "kill \$p 2>/dev/null; exit 0" TERM; sleep "$t" & p=$!; wait "$p" && kill -s KILL 0) </dev/null >/dev/null 2>&1 & w=$!; /bin/sh -c "$c"; s=$?; kill "$w" 2>/dev/null; exit "$s""#;
    let seconds = (seconds.ceil() as i64).max(1);
    format!(
        "exec /bin/sh -c {} roamgate-deadline {seconds} {}",
        any_shell_quote(script),
        any_shell_quote(command)
    )
}

impl SshSessions {
    pub fn new(clock: SharedClock) -> Self {
        Self::with_platform(clock, cfg!(windows))
    }

    /// Sessions as on Windows (`windows`), whose OpenSSH runs no POSIX
    /// `false`, so multiplexed commands keep OpenSSH's own fallback.
    pub fn with_platform(clock: SharedClock, windows: bool) -> Self {
        Self::with_runner(ProcessRunner::new(clock), windows)
    }

    /// Sessions whose ssh children run through `runner` (the server's, with
    /// its observer), on its clock.
    pub fn with_runner(runner: ProcessRunner, windows: bool) -> Self {
        Self {
            shared: Arc::new(Shared {
                clock: runner.clock().clone(),
                runner,
                windows,
                state: Mutex::new(State::default()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn clock(&self) -> &SharedClock {
        &self.shared.clock
    }

    /// The runner ssh children of these sessions run through.
    pub fn runner(&self) -> &ProcessRunner {
        &self.shared.runner
    }

    pub(crate) fn is_windows(&self) -> bool {
        self.shared.windows
    }

    fn now(&self) -> i64 {
        self.shared.clock.now()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.shared.state.lock().expect("ssh sessions")
    }

    fn next_id(&self) -> u64 {
        self.shared.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// A new owner for [`Self::register_master`].
    pub fn new_owner(&self) -> MasterOwner {
        MasterOwner(self.next_id())
    }

    /// Registers (or replaces, in place) `owner`'s master.
    pub fn register_master(&self, owner: MasterOwner, registration: MasterRegistration) {
        let mut state = self.lock();
        match state.masters.iter_mut().find(|(each, _)| *each == owner) {
            Some((_, existing)) => *existing = registration,
            None => state.masters.push((owner, registration)),
        }
    }

    pub fn unregister_master(&self, owner: MasterOwner) {
        self.lock().masters.retain(|(each, _)| *each != owner);
    }

    fn masters(&self) -> Vec<MasterRegistration> {
        self.lock()
            .masters
            .iter()
            .map(|(_, registration)| registration.clone())
            .collect()
    }

    /// A ready master of the destination's, if any.
    pub fn master_control_path(&self, destination: &str) -> Option<String> {
        self.masters()
            .into_iter()
            .find(|master| master.destination == destination && (master.is_listening)())
            .map(|master| master.control_path)
    }

    fn hold_mux(&self, control_path: Option<&str>) -> MuxGuard {
        if let Some(path) = control_path {
            self.lock().mux.entry(path.to_owned()).or_default().active += 1;
        }
        MuxGuard {
            sessions: self.clone(),
            control_path: control_path.map(str::to_owned),
            released: AtomicBool::new(false),
        }
    }

    /// Resolves once no command is in flight over `control_path`.
    pub fn mux_sessions_idle(&self, control_path: &str) -> BoxFuture<()> {
        let mut state = self.lock();
        let Some(entry) = state.mux.get_mut(control_path) else {
            return Box::pin(async {});
        };
        let (tx, rx) = oneshot::channel();
        entry.idle.push(tx);
        Box::pin(async move {
            let _ = rx.await;
        })
    }

    /// A session over `control_path` ran: its host serves sessions again.
    fn note_master_served(&self, control_path: &str) {
        self.lock().streaks.remove(control_path);
    }

    /// The host refused a session over `control_path`. Past the refusal
    /// threshold the master is recycled (at most once a minute) and true is
    /// returned: the master is not worth retrying.
    fn note_master_refusal(&self, control_path: &str) -> bool {
        let now = self.now();
        let recycle = {
            let mut state = self.lock();
            let streak = state
                .streaks
                .entry(control_path.to_owned())
                .or_insert(Streak {
                    since: now,
                    count: 0,
                });
            streak.count += 1;
            if streak.count < SSH_MASTER_RECYCLE_REFUSALS
                || now - streak.since < SSH_MASTER_RECYCLE_AFTER_MS
            {
                return false;
            }
            let due = state
                .last_recycles
                .get(control_path)
                .is_none_or(|last| now - last >= SSH_MASTER_RECYCLE_INTERVAL_MS);
            let recycle = if due {
                state
                    .masters
                    .iter()
                    .find(|(_, master)| {
                        master.control_path == control_path && master.recycle.is_some()
                    })
                    .and_then(|(_, master)| master.recycle.clone())
            } else {
                None
            };
            if recycle.is_some() {
                state.last_recycles.insert(control_path.to_owned(), now);
                state.streaks.remove(control_path);
            }
            recycle
        };
        if let Some(recycle) = recycle {
            recycle();
        }
        true
    }

    /// The host refused a session: no slot past the ones in use (less the
    /// refused one) for SSH_REFUSED_COOLDOWN_MS, then the rest again.
    fn note_refusal(&self, destination: &str) {
        let now = self.now();
        let mut state = self.lock();
        let slots = state
            .slots
            .entry(destination.to_owned())
            .or_insert_with(Slots::new);
        let current = if slots.cooldown_until > now {
            slots.ceiling
        } else {
            SSH_SESSION_LIMIT
        };
        slots.ceiling = current
            .min((slots.active + slots.lingering).saturating_sub(1))
            .max(1);
        slots.cooldown_until = now + SSH_REFUSED_COOLDOWN_MS;
        if let Some(timer) = slots.cooldown_timer.take() {
            timer.abort();
        }
        let sessions = self.clone();
        let destination = destination.to_owned();
        let task = tokio::spawn(async move {
            sessions
                .shared
                .clock
                .sleep(Duration::from_millis(SSH_REFUSED_COOLDOWN_MS as u64))
                .await;
            let now = sessions.now();
            let mut state = sessions.lock();
            if let Some(slots) = state.slots.get_mut(&destination) {
                slots.cooldown_timer = None;
                slots.grant_waiters(now);
            }
            forget_if_idle(&mut state, &destination, now);
        });
        slots.cooldown_timer = Some(task.abort_handle());
    }

    /// A command's client was killed here while its session may still run
    /// on the host until `until`: the slot is free here, but the host's
    /// session is counted until then.
    fn note_lingering(&self, destination: &str, until: i64) {
        let left = until - self.now();
        if left <= 0 {
            return;
        }
        self.lock()
            .slots
            .entry(destination.to_owned())
            .or_insert_with(Slots::new)
            .lingering += 1;
        let sessions = self.clone();
        let destination = destination.to_owned();
        tokio::spawn(async move {
            sessions
                .shared
                .clock
                .sleep(Duration::from_millis(left as u64))
                .await;
            let now = sessions.now();
            let mut state = sessions.lock();
            if let Some(slots) = state.slots.get_mut(&destination) {
                slots.lingering -= 1;
                slots.grant_waiters(now);
            }
            forget_if_idle(&mut state, &destination, now);
        });
    }

    fn slot(&self, destination: &str, background: bool, stream: bool) -> SessionSlot {
        SessionSlot {
            sessions: self.clone(),
            destination: destination.to_owned(),
            background,
            stream,
            released: AtomicBool::new(false),
        }
    }

    /// Takes one of the destination's session slots, waiting in line while
    /// all are busy. The wait ends with an error at `timeout_ms` (default
    /// SSH_SESSION_DEFAULT_WAIT_MS), when the signal aborts, or at once when
    /// SSH_SESSION_WAITER_LIMIT commands are already queued. Background work
    /// (`lane`, else the current lane) holds at most
    /// SSH_BACKGROUND_SESSION_LIMIT slots, waits behind every interactive
    /// command, and past SSH_BACKGROUND_WAITER_LIMIT queued is shed.
    pub async fn acquire(
        &self,
        destination: &str,
        wait: &SshSessionWait,
        lane: Option<Lane>,
    ) -> Result<SessionSlot, SessionError> {
        check(wait.signal.as_ref())?;
        let background = lane.unwrap_or_else(current_lane) == Lane::Background;
        let now = self.now();
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        let timeout_ms;
        {
            let mut state = self.lock();
            let slots = state
                .slots
                .entry(destination.to_owned())
                .or_insert_with(Slots::new);
            let limit = slots.limit(now);
            let free = if background {
                slots.active < limit
                    && slots.background < SSH_BACKGROUND_SESSION_LIMIT
                    && slots.waiters.is_empty()
                    && slots.background_waiters.is_empty()
            } else {
                slots.active < limit && slots.waiters.is_empty()
            };
            if free {
                slots.active += 1;
                if background {
                    slots.background += 1;
                }
                return Ok(self.slot(destination, background, false));
            }
            let line = if background {
                &mut slots.background_waiters
            } else {
                &mut slots.waiters
            };
            if background && line.len() >= SSH_BACKGROUND_WAITER_LIMIT {
                return Err(SessionError::BackgroundShed(destination.to_owned()));
            }
            if !background && line.len() >= SSH_SESSION_WAITER_LIMIT {
                return Err(SessionError::LineFull(destination.to_owned()));
            }
            timeout_ms = wait.timeout_ms.unwrap_or(SSH_SESSION_DEFAULT_WAIT_MS);
            if timeout_ms == 0 {
                return Err(SessionError::WaitTimeout {
                    destination: destination.to_owned(),
                    timeout_ms,
                });
            }
            line.push_back(Waiter { id, grant: tx });
        }
        let mut queued = Queued {
            sessions: self,
            destination,
            id,
            background,
            rx,
            done: false,
        };
        let outcome = tokio::select! {
            biased;
            granted = &mut queued.rx => granted.ok().map(|()| Ok(())),
            () = self.shared.clock.sleep(Duration::from_millis(timeout_ms)) => {
                Some(Err(SessionError::WaitTimeout {
                    destination: destination.to_owned(),
                    timeout_ms,
                }))
            }
            reason = aborted(wait.signal.as_ref()) => Some(Err(SessionError::Aborted(reason))),
        };
        if matches!(outcome, Some(Ok(()))) {
            queued.done = true;
            return Ok(self.slot(destination, background, false));
        }
        // Leaving the line; a grant that raced the timer or the abort wins,
        // as it settled first in TS.
        if queued.leave() {
            return Ok(self.slot(destination, background, false));
        }
        match outcome {
            Some(Err(error)) => Err(error),
            _ => Err(SessionError::Aborted("ssh session wait dropped".into())),
        }
    }

    /// A long-lived session's slot: one of the SSH_STREAM_SESSION_LIMIT,
    /// taken only when free now with nobody waiting.
    fn take_stream_slot(&self, destination: &str) -> Option<SessionSlot> {
        let now = self.now();
        let mut state = self.lock();
        let slots = state
            .slots
            .entry(destination.to_owned())
            .or_insert_with(Slots::new);
        if slots.streams >= SSH_STREAM_SESSION_LIMIT
            || slots.active >= slots.limit(now)
            || !slots.waiters.is_empty()
            || !slots.background_waiters.is_empty()
        {
            forget_if_idle(&mut state, destination, now);
            return None;
        }
        slots.active += 1;
        slots.streams += 1;
        Some(self.slot(destination, false, true))
    }

    /// Holds a session slot for a command the caller spawns itself (an
    /// upload, a stream); commands with no route pass through. A long-lived
    /// session never waits: it takes one of SSH_STREAM_SESSION_LIMIT slots
    /// when one is free, else runs on a connection of its own.
    pub async fn hold(
        &self,
        command: &SshCommand,
        wait: &SshSessionWait,
        long_lived: bool,
    ) -> Result<SshSessionHold, SessionError> {
        let Some(route) = command.route.clone() else {
            check(wait.signal.as_ref())?;
            return Ok(SshSessionHold {
                slot: None,
                mux: None,
                remaining_ms: wait.timeout_ms,
                command: command.clone(),
            });
        };
        if long_lived {
            check(wait.signal.as_ref())?;
            let slot = route
                .control_path
                .as_ref()
                .and_then(|_| self.take_stream_slot(&route.destination));
            let Some(slot) = slot else {
                let mut cold = route.cold.clone();
                cold.annotation = command.annotation.clone();
                return Ok(SshSessionHold {
                    slot: None,
                    mux: None,
                    remaining_ms: wait.timeout_ms,
                    command: cold,
                });
            };
            return Ok(SshSessionHold {
                mux: Some(self.hold_mux(route.control_path.as_deref())),
                slot: Some(slot),
                remaining_ms: wait.timeout_ms,
                command: command.clone(),
            });
        }
        let started = self.now();
        let slot = self.acquire(&route.destination, wait, None).await?;
        let mux = self.hold_mux(route.control_path.as_deref());
        let elapsed = (self.now() - started).max(0) as u64;
        Ok(SshSessionHold {
            slot: Some(slot),
            mux: Some(mux),
            remaining_ms: wait.timeout_ms.map(|budget| budget.saturating_sub(elapsed)),
            command: command.clone(),
        })
    }

    async fn master_died(&self, control_path: &str) -> bool {
        let master = self
            .masters()
            .into_iter()
            .find(|master| master.control_path == control_path);
        match master {
            Some(master) => !(master.is_alive)().await,
            None => true,
        }
    }

    async fn backoff(&self, ms: u64, signal: Option<&AbortSignal>) -> Result<(), SessionError> {
        tokio::select! {
            () = self.shared.clock.sleep(Duration::from_millis(ms)) => Ok(()),
            reason = aborted(signal) => Err(SessionError::Aborted(reason)),
        }
    }

    /// Runs a host command inside its destination's session limit (see the
    /// module and ssh-sessions.ts `runSshCommand`): over a master it runs
    /// the mux-only form, retrying a refused session over the master after
    /// SSH_REFUSED_RETRY_DELAYS_MS and then on a connection of its own; a
    /// read reruns once cold when its master died under it; with a
    /// deadline the remote command ends SSH_REMOTE_GRACE_S after it.
    /// `run` gets each attempt and what is left of the budget.
    pub async fn run<T, E, F, Fut>(
        &self,
        command: &SshCommand,
        mut run: F,
        wait: &SshSessionWait,
    ) -> Result<T, E>
    where
        T: SshOutput,
        E: From<SessionError>,
        F: FnMut(SshCommand, Option<u64>) -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        check(wait.signal.as_ref())?;
        let Some(route) = command.route.clone() else {
            return run(command.clone(), wait.timeout_ms).await;
        };
        let started = self.now();
        let slot = self.acquire(&route.destination, wait, None).await?;
        let mux = self.hold_mux(route.control_path.as_deref());
        let attempts = Attempts {
            sessions: self,
            route: &route,
            wait,
            started,
        };
        let outcome = self
            .run_attempts(command, &route, &attempts, &mut run, wait, &mux)
            .await;
        mux.release();
        slot.release();
        outcome
    }

    async fn run_attempts<T, E, F, Fut>(
        &self,
        command: &SshCommand,
        route: &SshRoute,
        attempts: &Attempts<'_>,
        run: &mut F,
        wait: &SshSessionWait,
        mux: &MuxGuard,
    ) -> Result<T, E>
    where
        T: SshOutput,
        E: From<SessionError>,
        F: FnMut(SshCommand, Option<u64>) -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let signal = wait.signal.as_ref();
        let mux_only = route.mux_only.as_ref().map(|argv| SshCommand {
            argv: argv.clone(),
            annotation: command.annotation.clone(),
            route: None,
        });
        let first = mux_only.clone().unwrap_or_else(|| command.unrouted());
        let mut tries = 0usize;
        loop {
            check(signal)?;
            let result = attempts.attempt(&first, run).await?;
            if mux_only.is_some()
                && result.code() == 255
                && MUX_REFUSED_STDERR.is_match(result.stderr())
            {
                self.note_refusal(&route.destination);
                let broken = route
                    .control_path
                    .as_deref()
                    .is_some_and(|path| self.note_master_refusal(path));
                let delay = if broken {
                    None
                } else {
                    SSH_REFUSED_RETRY_DELAYS_MS.get(tries).copied()
                };
                if let Some(delay) = delay {
                    let left = attempts.remaining()?;
                    if left.is_none_or(|left| left > delay) {
                        self.backoff(delay, signal).await?;
                        tries += 1;
                        continue;
                    }
                }
                // Still refused: a connection of its own.
                mux.release();
                check(signal)?;
                return Ok(clean(attempts.attempt(&route.cold, run).await?));
            }
            if mux_only.is_some()
                && result.code() == 255
                && MUX_FALLBACK_STDERR.is_match(result.stderr())
            {
                // The socket is gone: the command never started.
                mux.release();
                check(signal)?;
                return Ok(clean(attempts.attempt(&route.cold, run).await?));
            }
            if mux_only.is_some()
                && let Some(path) = &route.control_path
            {
                self.note_master_served(path);
            }
            if route.retry_safe
                && result.code() == 255
                && !MUX_FALLBACK_STDERR.is_match(result.stderr())
                && let Some(path) = &route.control_path
                && self.master_died(path).await
            {
                mux.release();
                check(signal)?;
                return Ok(clean(attempts.attempt(&route.cold, run).await?));
            }
            return Ok(clean(result));
        }
    }
}

fn clean<T: SshOutput>(mut result: T) -> T {
    let stderr = without_mux_noise(result.stderr());
    if stderr != result.stderr() {
        result.set_stderr(stderr);
    }
    result
}

/// The attempts of one `run`: the budget they share.
struct Attempts<'a> {
    sessions: &'a SshSessions,
    route: &'a SshRoute,
    wait: &'a SshSessionWait,
    started: i64,
}

impl Attempts<'_> {
    fn remaining(&self) -> Result<Option<u64>, SessionError> {
        let Some(budget) = self.wait.timeout_ms else {
            return Ok(None);
        };
        let left = budget as i64 - (self.sessions.now() - self.started);
        if left <= 0 {
            return Err(SessionError::Timeout(budget));
        }
        Ok(Some(left as u64))
    }

    /// One attempt: with a deadline, the command ends on the host too,
    /// shortly after it; a client killed here leaves its session counted
    /// until then.
    async fn attempt<T, E, F, Fut>(&self, each: &SshCommand, run: &mut F) -> Result<T, E>
    where
        E: From<SessionError>,
        F: FnMut(SshCommand, Option<u64>) -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let Some(left) = self.remaining()? else {
            return run(each.clone(), None).await;
        };
        let now = self.sessions.now();
        let until = now + left as i64 + SSH_REMOTE_GRACE_S as i64 * 1000;
        let mut bounded = each.clone();
        if let Some(last) = bounded.argv.last_mut() {
            *last = with_remote_deadline(last, (until - now) as f64 / 1000.0);
        }
        let outcome = run(bounded, Some(left)).await;
        if outcome.is_err() {
            self.sessions.note_lingering(&self.route.destination, until);
        }
        outcome
    }
}

/// A waiter in line: leaves it when its wait ends or is dropped.
struct Queued<'a> {
    sessions: &'a SshSessions,
    destination: &'a str,
    id: u64,
    background: bool,
    rx: oneshot::Receiver<()>,
    done: bool,
}

impl Queued<'_> {
    /// Leaves the line; true when the slot was granted meanwhile.
    fn leave(&mut self) -> bool {
        self.done = true;
        let mut state = self.sessions.lock();
        if let Some(slots) = state.slots.get_mut(self.destination) {
            let line = if self.background {
                &mut slots.background_waiters
            } else {
                &mut slots.waiters
            };
            if let Some(index) = line.iter().position(|waiter| waiter.id == self.id) {
                line.remove(index);
                return false;
            }
        }
        drop(state);
        self.rx.try_recv().is_ok()
    }
}

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        // Dropped while waiting: out of the line, and a slot granted to
        // nobody goes back.
        if !self.done && self.leave() {
            self.sessions
                .slot(self.destination, self.background, false)
                .release();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
