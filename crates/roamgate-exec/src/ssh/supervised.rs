//! One supervised ssh child, shared by the command master, the Herdr tunnel
//! and port forwards (the plan's section 7, item 19): its exit as something
//! any number of tasks await, its bounded stderr tail, its live stderr for
//! readiness lines, and the graceful-then-forced stop all three use.
//!
//! The real spawn ([`SupervisedSsh::spawn`]) runs ssh through the
//! [`ProcessRunner`], as ssh-master.ts, ssh-tunnel.ts and ssh-forward.ts do
//! with Bun.spawn, so the runner's observer (record mode) sees it.
//! Tests make children with [`SupervisedSsh::manual`] and drive them through
//! a [`ChildControl`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{Clock, timeout};
use tokio::io::AsyncReadExt;
use tokio::sync::{broadcast, mpsc, watch};

use super::command::SshCommand;
use super::herdr_relay::HERDR_RELAY_READY;
use crate::process::{Command, Pipes, ProcessRunner};

/// The most stderr kept for classifying a failure (`SSH_STDERR_MAX_BYTES`).
pub const SSH_STDERR_MAX_BYTES: usize = 16 * 1024;

/// What `kill` sends: TERM (the default `proc.kill()`) or KILL (`kill(9)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillSignal {
    Term,
    Kill,
}

/// How a child ended: its exit code, or the error its wait gave (a promise
/// of `exited` that rejected).
pub type ChildExit = Result<i32, String>;

type KillFn = dyn Fn(KillSignal) -> Result<(), String> + Send + Sync;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Which pipes a spawned child has besides stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// None.
    Plain,
    /// The Herdr relay's: stdin held open, stdout watched for its line.
    Relay,
    /// Both given to the caller.
    Stdio,
}

/// A [`SupervisedSsh::spawn_stdio`] child's stdin and stdout.
pub struct StdioPipes {
    pub stdin: tokio::process::ChildStdin,
    pub stdout: tokio::process::ChildStdout,
}

/// A running (or finished) ssh child. Clones are the same child.
#[derive(Clone)]
pub struct SupervisedSsh {
    inner: Arc<Inner>,
}

struct Inner {
    id: u64,
    exit: watch::Receiver<Option<ChildExit>>,
    stderr: watch::Receiver<Option<String>>,
    live: broadcast::Sender<String>,
    /// A relay child's ready line: Some(true) once seen, Some(false) when
    /// its stdout ended first (always for other children).
    relay: watch::Receiver<Option<bool>>,
    kill: Box<KillFn>,
}

impl std::fmt::Debug for SupervisedSsh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SupervisedSsh")
            .field("id", &self.inner.id)
            .finish()
    }
}

impl PartialEq for SupervisedSsh {
    fn eq(&self, other: &Self) -> bool {
        self.inner.id == other.inner.id
    }
}

impl Eq for SupervisedSsh {}

/// The other end of a [`SupervisedSsh::manual`] child.
#[derive(Clone)]
pub struct ChildControl {
    exit: Arc<watch::Sender<Option<ChildExit>>>,
    stderr: Arc<watch::Sender<Option<String>>>,
    live: broadcast::Sender<String>,
    relay: Arc<watch::Sender<Option<bool>>>,
    pending_stderr: Arc<Mutex<Option<String>>>,
}

impl ChildControl {
    /// The child exits with `code` (only the first exit counts).
    pub fn exit(&self, code: i32) {
        self.finish(Ok(code));
    }

    /// The child's wait fails (a spawn or stream error).
    pub fn fail(&self, error: &str) {
        self.finish(Err(error.to_owned()));
    }

    fn finish(&self, outcome: ChildExit) {
        if self.exit.borrow().is_some() {
            return;
        }
        let tail = self
            .pending_stderr
            .lock()
            .expect("stderr")
            .take()
            .unwrap_or_default();
        if self.stderr.borrow().is_none() {
            let _ = self.stderr.send(Some(tail));
        }
        self.relay.send_if_modified(|ready| {
            let unset = ready.is_none();
            if unset {
                *ready = Some(false);
            }
            unset
        });
        let _ = self.exit.send(Some(outcome));
    }

    /// A relay child printed its ready line (true) or its stdout ended
    /// without it (false); only the first call counts.
    pub fn relay_ready(&self, ready: bool) {
        self.relay.send_if_modified(|current| {
            let unset = current.is_none();
            if unset {
                *current = Some(ready);
            }
            unset
        });
    }

    /// The stderr tail the child leaves (read once it exited).
    pub fn set_stderr(&self, text: &str) {
        *self.pending_stderr.lock().expect("stderr") = Some(text.to_owned());
    }

    /// Stderr text as it arrives, for readiness watchers.
    pub fn emit_stderr(&self, text: &str) {
        let _ = self.live.send(text.to_owned());
    }

    pub fn has_exited(&self) -> bool {
        self.exit.borrow().is_some()
    }
}

impl SupervisedSsh {
    /// A child driven by hand: `kill` is what the child does with a signal
    /// (exit through the control it is given, or fail).
    pub fn manual(
        kill: impl Fn(KillSignal, &ChildControl) -> Result<(), String> + Send + Sync + 'static,
    ) -> (Self, ChildControl) {
        let (exit_tx, exit_rx) = watch::channel(None);
        let (stderr_tx, stderr_rx) = watch::channel(None);
        let (relay_tx, relay_rx) = watch::channel(None);
        let (live, _) = broadcast::channel(64);
        let control = ChildControl {
            exit: Arc::new(exit_tx),
            stderr: Arc::new(stderr_tx),
            live: live.clone(),
            relay: Arc::new(relay_tx),
            pending_stderr: Arc::new(Mutex::new(None)),
        };
        let for_kill = control.clone();
        let child = Self {
            inner: Arc::new(Inner {
                id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                exit: exit_rx,
                stderr: stderr_rx,
                live,
                relay: relay_rx,
                kill: Box::new(move |signal| kill(signal, &for_kill)),
            }),
        };
        (child, control)
    }

    /// Spawns `command` through `runner` (`LC_ALL=C`, no stdin or stdout,
    /// stderr kept: a bounded tail for failures and live chunks for
    /// readiness lines). The runner's observer sees it start and end.
    pub fn spawn(runner: &ProcessRunner, command: &SshCommand) -> Result<Self, String> {
        Self::spawn_piped(runner, command, Mode::Plain).map(|(child, _)| child)
    }

    /// [`SupervisedSsh::spawn`] for a tunnel running the Herdr relay as its
    /// remote command: its stdin stays open, never written, until the child
    /// exits (the relay ends with its session), and its stdout is watched
    /// for the relay's ready line ([`SupervisedSsh::relay_ready`]).
    pub fn spawn_relay(runner: &ProcessRunner, command: &SshCommand) -> Result<Self, String> {
        Self::spawn_piped(runner, command, Mode::Relay).map(|(child, _)| child)
    }

    /// [`SupervisedSsh::spawn`] for a child spoken to on its stdin and
    /// stdout (the node link, contract/wire/node-link.md): both pipes are
    /// the caller's; closing stdin ends the remote command.
    pub fn spawn_stdio(
        runner: &ProcessRunner,
        command: &SshCommand,
    ) -> Result<(Self, StdioPipes), String> {
        let (child, pipes) = Self::spawn_piped(runner, command, Mode::Stdio)?;
        Ok((child, pipes.expect("a stdio child's pipes")))
    }

    fn spawn_piped(
        runner: &ProcessRunner,
        command: &SshCommand,
        mode: Mode,
    ) -> Result<(Self, Option<StdioPipes>), String> {
        let relay = mode == Mode::Relay;
        let piped = mode != Mode::Plain;
        let mut child = runner
            .spawn_with(
                &Command::new(command.argv.iter().cloned()).env("LC_ALL", "C"),
                Pipes {
                    stdin: piped,
                    stdout: piped,
                    stderr: true,
                },
            )
            .map_err(|error| format!("spawn {error}"))?;
        let (exit_tx, exit_rx) = watch::channel(None);
        let (stderr_tx, stderr_rx) = watch::channel(None);
        let (relay_tx, relay_rx) = watch::channel(if relay { None } else { Some(false) });
        let (live, _) = broadcast::channel(64);
        let mut stdin = child.stdin();
        let mut stdout = child.stdout();
        let pipes = if mode == Mode::Stdio {
            match (stdin.take(), stdout.take()) {
                (Some(stdin), Some(stdout)) => Some(StdioPipes { stdin, stdout }),
                _ => return Err("spawn: the child has no stdin or stdout".into()),
            }
        } else {
            None
        };
        if let Some(mut stdout) = stdout {
            tokio::spawn(async move {
                let mut seen: Vec<u8> = Vec::new();
                let mut chunk = vec![0u8; 4096];
                while let Ok(read) = stdout.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    if relay_tx.borrow().is_none() {
                        seen.extend_from_slice(&chunk[..read]);
                        if seen.len() > 4096 {
                            seen.drain(..seen.len() - 4096);
                        }
                        if String::from_utf8_lossy(&seen).contains(HERDR_RELAY_READY) {
                            let _ = relay_tx.send(Some(true));
                        }
                    }
                }
                relay_tx.send_if_modified(|ready| {
                    let unset = ready.is_none();
                    if unset {
                        *ready = Some(false);
                    }
                    unset
                });
            });
        }
        let mut pipe = child.stderr();
        let live_tx = live.clone();
        tokio::spawn(async move {
            let mut tail: Vec<u8> = Vec::new();
            if let Some(pipe) = pipe.as_mut() {
                let mut chunk = vec![0u8; 8192];
                while let Ok(read) = pipe.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    let _ = live_tx.send(String::from_utf8_lossy(&chunk[..read]).into_owned());
                    keep_tail(&mut tail, &chunk[..read]);
                }
            }
            let _ = stderr_tx.send(Some(String::from_utf8_lossy(&tail).into_owned()));
        });
        let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<KillSignal>();
        tokio::spawn(async move {
            // Held open until the child exits.
            let _stdin = stdin;
            loop {
                tokio::select! {
                    status = child.wait() => {
                        let outcome = status.map_err(|error| error.to_string());
                        let _ = exit_tx.send(Some(outcome));
                        break;
                    }
                    Some(signal) = kill_rx.recv() => child.kill(signal == KillSignal::Kill),
                }
            }
        });
        let exited = exit_rx.clone();
        let child = Self {
            inner: Arc::new(Inner {
                id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                exit: exit_rx,
                stderr: stderr_rx,
                live,
                relay: relay_rx,
                kill: Box::new(move |signal| {
                    if exited.borrow().is_some() {
                        return Ok(());
                    }
                    kill_tx.send(signal).map_err(|error| error.to_string())
                }),
            }),
        };
        Ok((child, pipes))
    }

    pub fn id(&self) -> u64 {
        self.inner.id
    }

    /// Resolves with how the child ended.
    pub async fn exited(&self) -> ChildExit {
        let mut exit = self.inner.exit.clone();
        match exit.wait_for(Option::is_some).await {
            Ok(value) => value.clone().expect("exit"),
            Err(_) => Err("the child's supervisor went away".into()),
        }
    }

    pub fn has_exited(&self) -> bool {
        self.inner.exit.borrow().is_some()
    }

    /// The stderr tail (at most [`SSH_STDERR_MAX_BYTES`]), once complete.
    pub async fn stderr(&self) -> String {
        let mut stderr = self.inner.stderr.clone();
        match stderr.wait_for(Option::is_some).await {
            Ok(value) => value.clone().unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    /// Whether a relay child printed its ready line: true once it did, false
    /// when its stdout ended first (at once for any other child).
    pub async fn relay_ready(&self) -> bool {
        let mut relay = self.inner.relay.clone();
        match relay.wait_for(Option::is_some).await {
            Ok(value) => value.unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Stderr text as it arrives from now on.
    pub fn subscribe_stderr(&self) -> broadcast::Receiver<String> {
        self.inner.live.subscribe()
    }

    pub fn kill(&self, signal: KillSignal) -> Result<(), String> {
        (self.inner.kill)(signal)
    }

    /// Whether the child exits within `wait` on `clock`.
    pub async fn exited_within(&self, clock: &dyn Clock, wait: Duration) -> bool {
        timeout(clock, wait, self.exited()).await.is_ok()
    }
}

/// Adds `chunk` to `tail`, keeping its last [`SSH_STDERR_MAX_BYTES`].
fn keep_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > SSH_STDERR_MAX_BYTES {
        tail.drain(..tail.len() - SSH_STDERR_MAX_BYTES);
    }
}

/// The stderr tail kept of `chunks`, as text (`readBoundedStderr`).
pub fn bounded_stderr<'a>(chunks: impl IntoIterator<Item = &'a [u8]>) -> String {
    let mut tail = Vec::new();
    for chunk in chunks {
        keep_tail(&mut tail, chunk);
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// Reads `stream` to its end and gives its last [`SSH_STDERR_MAX_BYTES`],
/// as text (`readBoundedStderr` of a bridge's stderr).
pub async fn read_bounded_stderr(stream: Option<impl tokio::io::AsyncRead + Unpin>) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut tail = Vec::new();
    let mut chunk = vec![0u8; 8192];
    while let Ok(read) = stream.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        keep_tail(&mut tail, &chunk[..read]);
    }
    String::from_utf8_lossy(&tail).into_owned()
}

/// Why a stop did not end the child.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct StopError(pub String);

/// Stops `child`: TERM, then KILL when it did not exit within `graceful`,
/// then an error when it did not exit within `forced` either. A kill that
/// fails is reported through `on_kill_error` and the stop goes on.
pub async fn stop_child(
    child: &SupervisedSsh,
    clock: &dyn Clock,
    graceful: Duration,
    forced: Duration,
    on_kill_error: impl Fn(KillSignal, &str),
    what: &str,
) -> Result<(), StopError> {
    if let Err(error) = child.kill(KillSignal::Term) {
        on_kill_error(KillSignal::Term, &error);
    }
    if child.exited_within(clock, graceful).await {
        return Ok(());
    }
    if let Err(error) = child.kill(KillSignal::Kill) {
        on_kill_error(KillSignal::Kill, &error);
    }
    if child.exited_within(clock, forced).await {
        return Ok(());
    }
    Err(StopError(format!(
        "{what} did not exit after forced termination"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::clock::TokioClock;

    #[tokio::test]
    async fn a_real_child_reports_its_exit_and_a_bounded_stderr_tail() {
        let script = format!(
            "head -c {} /dev/zero | tr '\\0' w >&2; printf ' Permission denied' >&2; exit 3",
            SSH_STDERR_MAX_BYTES * 2
        );
        let child = SupervisedSsh::spawn(
            &ProcessRunner::system(),
            &SshCommand::plain(vec!["sh".into(), "-c".into(), script]),
        )
        .unwrap();
        assert_eq!(child.exited().await, Ok(3));
        let tail = child.stderr().await;
        assert!(tail.ends_with(" Permission denied"), "{tail:?}");
        assert!(tail.len() <= SSH_STDERR_MAX_BYTES);
        assert!(tail.starts_with('w'));
    }

    #[tokio::test]
    async fn a_real_child_stops_on_term() {
        let child = SupervisedSsh::spawn(
            &ProcessRunner::system(),
            &SshCommand::plain(vec!["sleep".into(), "30".into()]),
        )
        .unwrap();
        let clock = TokioClock::starting_at(0);
        stop_child(
            &child,
            &clock,
            Duration::from_secs(5),
            Duration::from_secs(5),
            |_, _| {},
            "test child",
        )
        .await
        .unwrap();
        assert_eq!(child.exited().await, Ok(128 + 15));
        // A kill after the exit does nothing.
        assert_eq!(child.kill(KillSignal::Kill), Ok(()));
    }

    #[tokio::test]
    async fn a_relay_child_keeps_its_stdin_open_and_reports_its_ready_line() {
        // `cat` ends only when its stdin closes: held open until the kill.
        let script = format!("echo '{HERDR_RELAY_READY}'; cat >/dev/null; exit 4");
        let child = SupervisedSsh::spawn_relay(
            &ProcessRunner::system(),
            &SshCommand::plain(vec!["sh".into(), "-c".into(), script]),
        )
        .unwrap();
        assert!(child.relay_ready().await);
        let clock = TokioClock::starting_at(0);
        assert!(
            !child
                .exited_within(&clock, Duration::from_millis(200))
                .await
        );
        child.kill(KillSignal::Term).unwrap();
        assert_eq!(child.exited().await, Ok(128 + 15));

        // Output that ends without the line.
        let silent = SupervisedSsh::spawn_relay(
            &ProcessRunner::system(),
            &SshCommand::plain(vec!["sh".into(), "-c".into(), "exit 127".into()]),
        )
        .unwrap();
        assert!(!silent.relay_ready().await);
        assert_eq!(silent.exited().await, Ok(127));
    }

    #[tokio::test(start_paused = true)]
    async fn stop_forces_then_reports_a_child_that_never_exits() {
        let signals = Arc::new(Mutex::new(Vec::new()));
        let seen = signals.clone();
        let (child, _control) = SupervisedSsh::manual(move |signal, _| {
            seen.lock().unwrap().push(signal);
            Ok(())
        });
        let clock = TokioClock::starting_at(0);
        let error = stop_child(
            &child,
            &clock,
            Duration::from_millis(1),
            Duration::from_millis(1),
            |_, _| {},
            "SSH tunnel",
        )
        .await
        .unwrap_err();
        assert!(error.0.contains("did not exit after forced termination"));
        assert_eq!(
            *signals.lock().unwrap(),
            [KillSignal::Term, KillSignal::Kill]
        );
    }
}
