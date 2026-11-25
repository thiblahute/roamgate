//! Running processes (utils/process-utils.ts, workspace/process.ts, the
//! capped subprocesses of time-report and archive): one runner for every
//! spawn site, on tokio::process, its deadlines on the server's
//! [`Clock`](roamgate_base::clock::Clock).
//!
//! - A command never goes through a shell: its words are passed as they
//!   are.
//! - It runs in a process group of its own (on Unix), so a timeout or an
//!   output past its cap ends whatever it started too.
//! - A program that does not exist exits [`NOT_FOUND_EXIT`] (127, as a
//!   shell says), with a line on stderr, rather than failing to spawn.
//! - Output may be capped: cut (the rest read and dropped) or fatal (the
//!   process group killed, [`ExecError::TooMuchOutput`]).
//! - A [`ProcessObserver`] sees every run start and end (record mode
//!   plugs in there): its words, directory, exit and duration, never its
//!   output.

use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

/// The exit code of a program that does not exist.
pub const NOT_FOUND_EXIT: i32 = 127;

/// How long a process told to stop with SIGTERM has before SIGKILL.
pub const TERM_GRACE: Duration = Duration::from_millis(1500);

/// The signal that ends a process at its deadline or past its cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KillSignal {
    /// SIGTERM, then SIGKILL after [`TERM_GRACE`] (`proc.kill()`).
    #[default]
    Term,
    /// SIGKILL at once (the time-report provider).
    Kill,
}

/// What output past the cap does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Overflow {
    /// Keep the first bytes, read and drop the rest.
    #[default]
    Cut,
    /// Kill the process group and fail.
    Fail,
}

/// A process to run: its words, where, with what environment and input,
/// and its bounds.
#[derive(Debug, Clone, Default)]
pub struct Command {
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Start from an empty environment rather than this process's.
    pub clear_env: bool,
    /// Set (`Some`) or remove (`None`), in order.
    pub env: Vec<(String, Option<String>)>,
    /// Written to stdin, which is then closed; None: no stdin at all.
    pub stdin: Option<Vec<u8>>,
    pub timeout: Option<Duration>,
    /// At most this many bytes of stdout, and of stderr, each.
    pub output_cap: Option<usize>,
    pub overflow: Overflow,
    pub kill_signal: KillSignal,
    /// A program that does not exist fails with [`ExecError::Spawn`]
    /// (`NotFound`) instead of the shell's exit 127, for callers that say
    /// so in their own words (the time-report provider).
    pub missing_is_error: bool,
}

impl Command {
    pub fn new<S: Into<String>>(argv: impl IntoIterator<Item = S>) -> Self {
        Self {
            argv: argv.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.argv.push(arg.into());
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), Some(value.into())));
        self
    }

    pub fn env_remove(mut self, key: impl Into<String>) -> Self {
        self.env.push((key.into(), None));
        self
    }

    pub fn env_clear(mut self) -> Self {
        self.clear_env = true;
        self.env.clear();
        self
    }

    pub fn stdin(mut self, input: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(input.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn output_cap(mut self, cap: usize, overflow: Overflow) -> Self {
        self.output_cap = Some(cap);
        self.overflow = overflow;
        self
    }

    pub fn kill_signal(mut self, signal: KillSignal) -> Self {
        self.kill_signal = signal;
        self
    }

    /// See [`Command::missing_is_error`].
    pub fn missing_is_error(mut self) -> Self {
        self.missing_is_error = true;
        self
    }

    /// The program's name, for messages.
    pub fn program(&self) -> &str {
        self.argv.first().map(String::as_str).unwrap_or("")
    }

    fn build(&self, stdin: Stdio, stdout: Stdio, stderr: Stdio) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.argv[0]);
        command.args(&self.argv[1..]);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        if self.clear_env {
            command.env_clear();
        }
        for (key, value) in &self.env {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        command.stdin(stdin).stdout(stdout).stderr(stderr);
        command.kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        command
    }
}

/// What a finished process gave.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Output {
    /// The exit code; 128 plus the signal for a process a signal ended.
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Output past the cap was dropped.
    pub stdout_cut: bool,
    pub stderr_cut: bool,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == 0
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }

    /// Itself when it exited 0, else [`ExecError::Exited`] with stderr (or
    /// stdout when stderr is empty), as `runProcess` throws.
    pub fn checked(self, program: &str) -> Result<Output, ExecError> {
        if self.success() {
            return Ok(self);
        }
        let stderr = self.stderr_text();
        let detail = match stderr.trim() {
            "" => self.stdout_text().trim().to_owned(),
            text => text.to_owned(),
        };
        Err(ExecError::Exited {
            program: program.to_owned(),
            code: self.code,
            detail,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("no command to run")]
    Empty,
    #[error("{program} timed out after {ms}ms")]
    TimedOut { program: String, ms: u64 },
    #[error("{program} printed more than {cap} bytes")]
    TooMuchOutput { program: String, cap: usize },
    #[error("{program} exited {code}: {detail}")]
    Exited {
        program: String,
        code: i32,
        detail: String,
    },
    #[error("{program}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    #[error("{program}: {source}")]
    Io {
        program: String,
        #[source]
        source: io::Error,
    },
    /// An SSH host's command got no session (or its wait was cut short).
    #[error(transparent)]
    Session(#[from] crate::ssh::sessions::SessionError),
}

/// A run as an observer sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    /// Unique within the process.
    pub id: u64,
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub pid: Option<u32>,
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq)]
pub struct RunEnd {
    /// None when it was killed at its deadline or past its cap.
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Why it did not finish (never its output).
    pub error: Option<String>,
    pub duration_ms: f64,
}

/// [`ProcessRunner::observe_every_run`]'s observer.
static PROCESS_OBSERVER: std::sync::OnceLock<Arc<dyn ProcessObserver>> = std::sync::OnceLock::new();

/// Sees every process the runner starts (record mode's `recordSpawns`).
pub trait ProcessObserver: Send + Sync {
    fn started(&self, run: &RunInfo);
    fn exited(&self, run: &RunInfo, end: &RunEnd);
}

/// Record mode on the runner (hooks.ts `recordSpawns`): a `spawn` channel
/// line at each start (`api`, `argv`, `cwd`, `pid`) and exit (`api`,
/// `argv`, `pid`, `code`, `ms`, and `timed_out` or `error` when so), the
/// recorder redacting the words at flush. Output and environment are never
/// recorded.
pub struct RecordObserver {
    recorder: Arc<roamgate_base::record::ContractRecorder>,
}

impl RecordObserver {
    /// What `api` says in the lines: the TS server names the Bun or Node
    /// function, the Rust server its one runner.
    pub const API: &'static str = "ProcessRunner";

    pub fn new(recorder: Arc<roamgate_base::record::ContractRecorder>) -> Self {
        Self { recorder }
    }

    fn record(&self, ev: &str, fields: serde_json::Map<String, serde_json::Value>) {
        let mut input = roamgate_base::record::RecordInput::new("spawn", ev);
        input.fields = Some(fields);
        self.recorder.record(input);
    }
}

impl ProcessObserver for RecordObserver {
    fn started(&self, run: &RunInfo) {
        let mut fields = serde_json::Map::new();
        fields.insert("api".into(), Self::API.into());
        fields.insert("argv".into(), recorded_argv(&run.argv).into());
        fields.insert(
            "cwd".into(),
            run.cwd
                .as_ref()
                .map(|cwd| cwd.to_string_lossy().into_owned().into())
                .unwrap_or(serde_json::Value::Null),
        );
        fields.insert("pid".into(), run.pid.into());
        self.record("start", fields);
    }

    fn exited(&self, run: &RunInfo, end: &RunEnd) {
        let mut fields = serde_json::Map::new();
        fields.insert("api".into(), Self::API.into());
        fields.insert("argv".into(), recorded_argv(&run.argv).into());
        fields.insert("pid".into(), run.pid.into());
        fields.insert("code".into(), end.code.into());
        fields.insert("ms".into(), (end.duration_ms.round() as i64).into());
        if end.timed_out {
            fields.insert("timed_out".into(), true.into());
        }
        if let Some(error) = &end.error {
            fields.insert("error".into(), error.clone().into());
        }
        self.record("exit", fields);
    }
}

/// A command line's arguments, a credential after a credential flag
/// hidden (hooks.ts `argvOf`): `--token x` keeps the flag and hides `x`,
/// `--token=x` becomes `--token=[redacted]`.
pub fn recorded_argv(argv: &[String]) -> Vec<String> {
    static FLAG: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^--?([a-z0-9_-]*(?:password|passwd|token|secret|pin|auth|api-?key))(=.*)?$",
        )
        .expect("pattern")
    });
    let mut out = Vec::with_capacity(argv.len());
    let mut hide_next = false;
    for arg in argv {
        if hide_next {
            out.push("[redacted]".to_owned());
            hide_next = false;
            continue;
        }
        match FLAG.captures(arg) {
            Some(flag) if flag.get(2).is_some() => out.push(format!("--{}=[redacted]", &flag[1])),
            Some(_) => {
                out.push(arg.clone());
                hide_next = true;
            }
            None => out.push(arg.clone()),
        }
    }
    out
}

static RUN_IDS: AtomicU64 = AtomicU64::new(1);

/// The one way the server runs processes.
#[derive(Clone)]
pub struct ProcessRunner {
    clock: SharedClock,
    observer: Option<Arc<dyn ProcessObserver>>,
}

impl std::fmt::Debug for ProcessRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcessRunner")
            .field("observed", &self.observer.is_some())
            .finish()
    }
}

/// The exit code of a status: its code, or 128 plus its signal.
pub fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    -1
}

/// Signals the process group led by `pid` (Unix), or nothing.
fn signal_group(pid: Option<u32>, kill: bool) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|pid| rustix::process::Pid::from_raw(pid as i32)) {
        let signal = if kill {
            rustix::process::Signal::KILL
        } else {
            rustix::process::Signal::TERM
        };
        let _ = rustix::process::kill_process_group(pid, signal);
    }
    #[cfg(not(unix))]
    let _ = (pid, kill);
}

/// Spawns `command`, again when the program is a file another thread had
/// open for writing as it forked (ETXTBSY: a script just written, whose
/// descriptor a concurrent fork inherited for a moment).
fn spawn_child(mut command: tokio::process::Command) -> io::Result<tokio::process::Child> {
    let mut tries = 0;
    loop {
        match command.spawn() {
            Err(error) if error.kind() == io::ErrorKind::ExecutableFileBusy && tries < 20 => {
                tries += 1;
                std::thread::yield_now();
            }
            other => return other,
        }
    }
}

/// Reads `stream` whole, keeping at most `cap` bytes; past it, with
/// `Overflow::Fail`, wakes `overflowed` and stops.
async fn read_capped(
    stream: Option<impl AsyncRead + Unpin>,
    cap: Option<usize>,
    overflow: Overflow,
    overflowed: &Notify,
) -> (Vec<u8>, bool) {
    let Some(mut stream) = stream else {
        return (Vec::new(), false);
    };
    let mut kept = Vec::new();
    let mut cut = false;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let room = cap.map_or(usize::MAX, |cap| cap.saturating_sub(kept.len()));
        if read > room {
            kept.extend_from_slice(&buffer[..room]);
            cut = true;
            if overflow == Overflow::Fail {
                overflowed.notify_one();
                break;
            }
        } else {
            kept.extend_from_slice(&buffer[..read]);
        }
    }
    (kept, cut)
}

enum Finish {
    Done(io::Result<ExitStatus>, (Vec<u8>, bool), (Vec<u8>, bool)),
    TimedOut,
    Overflowed,
}

impl ProcessRunner {
    pub fn new(clock: SharedClock) -> Self {
        Self {
            clock,
            observer: None,
        }
    }

    /// A runner on the real clock.
    pub fn system() -> Self {
        Self::new(Arc::new(SystemClock))
    }

    pub fn with_observer(mut self, observer: Arc<dyn ProcessObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// The observer of every runner of this process that has none of its
    /// own (record mode's `recordSpawns`, which patched every spawn
    /// function); the first one set stays.
    pub fn observe_every_run(observer: Arc<dyn ProcessObserver>) {
        let _ = PROCESS_OBSERVER.set(observer);
    }

    fn observer(&self) -> Option<&Arc<dyn ProcessObserver>> {
        self.observer.as_ref().or_else(|| PROCESS_OBSERVER.get())
    }

    pub fn clock(&self) -> &SharedClock {
        &self.clock
    }

    fn info(&self, command: &Command, pid: Option<u32>) -> RunInfo {
        RunInfo {
            id: RUN_IDS.fetch_add(1, Ordering::Relaxed),
            argv: command.argv.clone(),
            cwd: command.cwd.clone(),
            pid,
        }
    }

    fn started(&self, info: &RunInfo) {
        if let Some(observer) = self.observer() {
            observer.started(info);
        }
    }

    fn report(&self, info: &RunInfo, started: f64, code: Option<i32>, error: Option<&ExecError>) {
        if let Some(observer) = self.observer() {
            observer.exited(
                info,
                &RunEnd {
                    code,
                    timed_out: matches!(error, Some(ExecError::TimedOut { .. })),
                    error: error.map(ToString::to_string),
                    duration_ms: self.clock.monotonic() - started,
                },
            );
        }
    }

    /// A program that does not exist, as a shell reports it.
    fn not_found(&self, command: &Command, started: f64) -> Output {
        let info = self.info(command, None);
        self.started(&info);
        self.report(&info, started, Some(NOT_FOUND_EXIT), None);
        Output {
            code: NOT_FOUND_EXIT,
            stderr: format!("{}: command not found\n", command.program()).into_bytes(),
            ..Output::default()
        }
    }

    /// Runs `command` to its end (or its deadline) and gives its exit code
    /// and output, whatever the code.
    pub async fn run(&self, command: &Command) -> Result<Output, ExecError> {
        if command.argv.is_empty() {
            return Err(ExecError::Empty);
        }
        let program = command.program().to_owned();
        let started = self.clock.monotonic();
        if let Some(cwd) = &command.cwd
            && !cwd.is_dir()
        {
            return Err(ExecError::Spawn {
                program,
                source: io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no directory {}", cwd.display()),
                ),
            });
        }
        let stdin = if command.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        };
        let mut child = match spawn_child(command.build(stdin, Stdio::piped(), Stdio::piped())) {
            Ok(child) => child,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !command.missing_is_error => {
                return Ok(self.not_found(command, started));
            }
            Err(source) => return Err(ExecError::Spawn { program, source }),
        };
        let pid = child.id();
        let info = self.info(command, pid);
        self.started(&info);
        let input = command.stdin.clone();
        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let overflowed = Notify::new();
        let finish = {
            let work = async {
                let write = async {
                    // A child may exit before it reads its input (`git
                    // check-ignore --stdin` outside a repository): the
                    // broken pipe is not the failure, its exit tells.
                    if let (Some(pipe), Some(input)) = (stdin.as_mut(), input) {
                        let _ = pipe.write_all(&input).await;
                        let _ = pipe.shutdown().await;
                    }
                    drop(stdin.take());
                };
                let ((), out, err) = tokio::join!(
                    write,
                    read_capped(stdout, command.output_cap, command.overflow, &overflowed),
                    read_capped(stderr, command.output_cap, command.overflow, &overflowed),
                );
                let status = child.wait().await;
                Finish::Done(status, out, err)
            };
            let deadline = async {
                match command.timeout {
                    Some(timeout) => self.clock.sleep(timeout).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                finish = work => finish,
                () = deadline => Finish::TimedOut,
                () = overflowed.notified() => Finish::Overflowed,
            }
        };
        match finish {
            Finish::Done(status, (stdout, stdout_cut), (stderr, stderr_cut)) => {
                let status = status.map_err(|source| ExecError::Io {
                    program: program.clone(),
                    source,
                })?;
                let code = exit_code(status);
                self.report(&info, started, Some(code), None);
                Ok(Output {
                    code,
                    stdout,
                    stderr,
                    stdout_cut,
                    stderr_cut,
                })
            }
            Finish::TimedOut => {
                self.stop(&mut child, pid, command.kill_signal).await;
                let ms = command.timeout.map_or(0, roamgate_base::clock::ceil_ms);
                let error = ExecError::TimedOut { program, ms };
                self.report(&info, started, None, Some(&error));
                Err(error)
            }
            Finish::Overflowed => {
                self.stop(&mut child, pid, command.kill_signal).await;
                let error = ExecError::TooMuchOutput {
                    program,
                    cap: command.output_cap.unwrap_or(0),
                };
                self.report(&info, started, None, Some(&error));
                Err(error)
            }
        }
    }

    /// [`run`](Self::run), failing unless it exits 0 (`runProcess`).
    pub async fn run_checked(&self, command: &Command) -> Result<Output, ExecError> {
        let output = self.run(command).await?;
        output.checked(command.program())
    }

    /// Ends a child and its group, and reaps it.
    async fn stop(&self, child: &mut tokio::process::Child, pid: Option<u32>, signal: KillSignal) {
        if signal == KillSignal::Term {
            signal_group(pid, false);
            #[cfg(not(unix))]
            let _ = child.start_kill();
            let reaped =
                roamgate_base::clock::timeout(&*self.clock, TERM_GRACE, child.wait()).await;
            if reaped.is_ok() {
                return;
            }
        }
        signal_group(pid, true);
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    /// Starts `command` for its output as it comes (a file sent whole) or
    /// for a conversation on its stdin and stdout (a bridge), with no
    /// deadline. Its pipes are the caller's; `wait` reports its end to the
    /// observer.
    pub fn spawn(&self, command: &Command, stdin: bool) -> Result<Spawned, ExecError> {
        self.spawn_with(
            command,
            Pipes {
                stdin,
                stdout: true,
                stderr: true,
            },
        )
    }

    /// [`Self::spawn`] with the pipes asked for; the others are null (a
    /// supervised ssh child keeps only its stderr, and an unread stdout
    /// pipe would fill and stall it).
    pub fn spawn_with(&self, command: &Command, pipes: Pipes) -> Result<Spawned, ExecError> {
        if command.argv.is_empty() {
            return Err(ExecError::Empty);
        }
        let pipe = |wanted: bool| {
            if wanted {
                Stdio::piped()
            } else {
                Stdio::null()
            }
        };
        let started = self.clock.monotonic();
        let child = command.build(pipe(pipes.stdin), pipe(pipes.stdout), pipe(pipes.stderr));
        let child = spawn_child(child).map_err(|source| ExecError::Spawn {
            program: command.program().to_owned(),
            source,
        })?;
        let info = self.info(command, child.id());
        self.started(&info);
        Ok(Spawned {
            child,
            info,
            started,
            runner: self.clone(),
            reported: false,
            kept: Vec::new(),
        })
    }
}

/// Which of a spawned process's stdio are pipes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pipes {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

/// A process started by [`ProcessRunner::spawn`]. Dropped, it is killed.
pub struct Spawned {
    child: tokio::process::Child,
    info: RunInfo,
    started: f64,
    runner: ProcessRunner,
    reported: bool,
    /// What lives as long as the process is held (an SSH session slot).
    kept: Vec<Box<dyn std::any::Any + Send>>,
}

impl Spawned {
    pub fn pid(&self) -> Option<u32> {
        self.info.pid
    }

    /// Keeps `guard` until this is dropped (an SSH session slot held for
    /// as long as its stream runs).
    pub fn keep(mut self, guard: impl std::any::Any + Send) -> Self {
        self.kept.push(Box::new(guard));
        self
    }

    pub fn stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub fn stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub fn stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    /// Signals it and its group: SIGTERM, or SIGKILL with `force`.
    pub fn kill(&mut self, force: bool) {
        signal_group(self.info.pid, force);
        if force || cfg!(not(unix)) {
            let _ = self.child.start_kill();
        }
    }

    /// Waits for its end, reported to the observer once.
    pub async fn wait(&mut self) -> io::Result<i32> {
        let status = self.child.wait().await;
        if !self.reported {
            self.reported = true;
            match &status {
                Ok(status) => {
                    self.runner
                        .report(&self.info, self.started, Some(exit_code(*status)), None)
                }
                Err(error) => {
                    let error = ExecError::Io {
                        program: self.info.argv[0].clone(),
                        source: io::Error::new(error.kind(), error.to_string()),
                    };
                    self.runner
                        .report(&self.info, self.started, None, Some(&error))
                }
            }
        }
        status.map(exit_code)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use roamgate_base::clock::TokioClock;
    use std::sync::Mutex;

    fn runner() -> ProcessRunner {
        ProcessRunner::new(Arc::new(TokioClock::starting_at(0)))
    }

    #[tokio::test]
    async fn native_spawning_keeps_cwd_environment_and_literal_arguments_without_a_shell() {
        let dir = tempfile::Builder::new()
            .prefix("roamgate process ' ")
            .tempdir()
            .unwrap();
        let literal = "space ' quote \" & $HOME; $(echo injected)";
        // By absolute paths, with PATH empty as in the TS test: nothing
        // could have looked a shell up, and the words arrive as they are.
        let output = runner()
            .run(
                &Command::new([
                    "/bin/sh",
                    "-c",
                    "pwd -P; printf '%s\\n' \"$ROAMGATE_TEST_VALUE\" \"$1\"; printf '%s' \"$PATH\"",
                    "sh",
                    literal,
                ])
                .cwd(dir.path())
                .env("PATH", "")
                .env("ROAMGATE_TEST_VALUE", literal)
                .timeout(Duration::from_secs(5)),
            )
            .await
            .unwrap();
        assert_eq!(output.code, 0);
        let real = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            output.stdout_text(),
            format!("{}\n{literal}\n{literal}\n", real.display())
        );
    }

    #[tokio::test]
    async fn a_missing_program_exits_127() {
        let output = runner()
            .run(&Command::new(["roamgate-no-such-program-x"]))
            .await
            .unwrap();
        assert_eq!(output.code, NOT_FOUND_EXIT);
        assert!(output.stderr_text().contains("command not found"));
        let error = output.checked("roamgate-no-such-program-x").unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("roamgate-no-such-program-x exited 127: ")
        );
        let error = runner()
            .run(&Command::new(["roamgate-no-such-program-x"]).missing_is_error())
            .await
            .unwrap_err();
        assert!(
            matches!(&error, ExecError::Spawn { source, .. } if source.kind() == io::ErrorKind::NotFound),
            "{error}"
        );
    }

    #[tokio::test]
    async fn exit_codes_signals_and_checked_errors() {
        let runner = runner();
        let output = runner
            .run(&Command::new([
                "sh",
                "-c",
                "echo out; echo err >&2; exit 3",
            ]))
            .await
            .unwrap();
        assert_eq!(
            (
                output.code,
                output.stdout_text().as_str(),
                output.stderr_text().as_str()
            ),
            (3, "out\n", "err\n")
        );
        let error = runner
            .run_checked(&Command::new(["sh", "-c", "echo only-out; exit 2"]))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "sh exited 2: only-out");
        let killed = runner
            .run(&Command::new(["sh", "-c", "kill -9 $$"]))
            .await
            .unwrap();
        assert_eq!(killed.code, 128 + 9);
    }

    #[tokio::test]
    async fn stdin_is_written_then_closed_and_a_closed_pipe_is_not_an_error() {
        let runner = runner();
        let output = runner
            .run(&Command::new(["cat"]).stdin("hello"))
            .await
            .unwrap();
        assert_eq!(output.stdout_text(), "hello");
        // A child that exits without reading a large input.
        let big = vec![b'x'; 4 * 1024 * 1024];
        let output = runner
            .run(&Command::new(["sh", "-c", "exit 128"]).stdin(big))
            .await
            .unwrap();
        assert_eq!(output.code, 128);
    }

    #[tokio::test]
    async fn environment_is_set_removed_and_cleared() {
        let runner = runner();
        let output = runner
            .run(
                &Command::new(["/bin/sh", "-c", "printf '%s|%s' \"$A\" \"${HOME-unset}\""])
                    .env("A", "1")
                    .env_remove("HOME"),
            )
            .await
            .unwrap();
        assert_eq!(output.stdout_text(), "1|unset");
        let output = runner
            .run(&Command::new(["/bin/sh", "-c", "printf '%s' \"${A-none}\""]).env_clear())
            .await
            .unwrap();
        assert_eq!(output.stdout_text(), "none");
    }

    #[tokio::test]
    #[allow(clippy::disallowed_methods)] // real time: the kernel handles the signal
    async fn a_timeout_kills_the_whole_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let runner = ProcessRunner::system();
        let error = runner
            .run(&Command::new(["sh", "-c", &script]).timeout(Duration::from_millis(300)))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "sh timed out after 300ms");
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // The grandchild got the group's SIGTERM too: gone, or a zombie
        // waiting for its reaper, once the signal is handled (a loaded
        // machine may still show it running for a moment).
        let mut state = String::new();
        for _ in 0..100 {
            state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
            if state.is_empty() || state.contains(") Z") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(state.is_empty() || state.contains(") Z"), "{state}");
    }

    #[tokio::test]
    async fn output_past_its_cap_is_cut_or_fatal() {
        let runner = runner();
        let cut = runner
            .run(
                &Command::new(["sh", "-c", "head -c 100000 /dev/zero"])
                    .output_cap(10, Overflow::Cut),
            )
            .await
            .unwrap();
        assert_eq!((cut.stdout.len(), cut.stdout_cut, cut.code), (10, true, 0));
        let error = runner
            .run(&Command::new(["yes"]).output_cap(1024, Overflow::Fail))
            .await
            .unwrap_err();
        assert!(matches!(error, ExecError::TooMuchOutput { cap: 1024, .. }));
    }

    type Event = (String, RunInfo, Option<RunEnd>);

    #[derive(Default)]
    struct Seen(Mutex<Vec<Event>>);

    impl ProcessObserver for Seen {
        fn started(&self, run: &RunInfo) {
            self.0
                .lock()
                .unwrap()
                .push(("start".into(), run.clone(), None));
        }
        fn exited(&self, run: &RunInfo, end: &RunEnd) {
            self.0
                .lock()
                .unwrap()
                .push(("exit".into(), run.clone(), Some(end.clone())));
        }
    }

    #[tokio::test]
    async fn observers_see_the_processes_run_without_their_output() {
        let seen = Arc::new(Seen::default());
        let runner = runner().with_observer(seen.clone());
        runner
            .run(&Command::new([
                "sh",
                "-c",
                "printf private-output; exit 3",
                "--token",
                "abc",
            ]))
            .await
            .unwrap();
        runner.run(&Command::new(["true"])).await.unwrap();
        let mut held = runner
            .spawn(&Command::new(["sh", "-c", "exit 0"]), false)
            .unwrap();
        assert_eq!(held.wait().await.unwrap(), 0);
        let seen = seen.0.lock().unwrap();
        let starts: Vec<_> = seen.iter().filter(|(ev, ..)| ev == "start").collect();
        let exits: Vec<_> = seen.iter().filter(|(ev, ..)| ev == "exit").collect();
        assert_eq!((starts.len(), exits.len()), (3, 3));
        assert_eq!(
            starts[0].1.argv,
            [
                "sh",
                "-c",
                "printf private-output; exit 3",
                "--token",
                "abc"
            ]
        );
        assert!(starts[0].1.pid.is_some());
        assert_eq!(starts[0].1.id, exits[0].1.id);
        assert_eq!(exits[0].2.as_ref().unwrap().code, Some(3));
        assert_eq!(exits[1].1.argv, ["true"]);
        assert_eq!(exits[1].2.as_ref().unwrap().code, Some(0));
        assert_eq!(exits[2].2.as_ref().unwrap().code, Some(0));
        // An end carries a code, a duration and an error, never output.
        assert!(
            exits
                .iter()
                .all(|(_, _, end)| end.as_ref().unwrap().error.is_none())
        );
    }

    #[tokio::test]
    async fn record_mode_writes_the_processes_run_redacted_without_their_output() {
        use roamgate_base::record::{ContractRecorder, RecorderOptions};
        let scratch = tempfile::tempdir().unwrap();
        let directory = scratch.path().join("rec");
        let recorder = Arc::new(
            ContractRecorder::new(RecorderOptions::new(
                &directory,
                "server",
                Arc::new(|| 1_767_323_045_678),
            ))
            .unwrap(),
        );
        let runner = runner().with_observer(Arc::new(RecordObserver::new(recorder.clone())));
        runner
            .run(&Command::new([
                "sh",
                "-c",
                "printf %s \"$(echo cHJpdmF0ZQ== | base64 -d)\"; exit 3",
                "--token",
                "abc",
            ]))
            .await
            .unwrap();
        runner
            .run(&Command::new(["true"]).cwd(scratch.path()))
            .await
            .unwrap();
        recorder.flush();
        let mut text = String::new();
        for entry in std::fs::read_dir(&directory).unwrap() {
            text.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
        }
        // Its output said "private"; its words never did.
        assert!(!text.contains("private"));
        assert!(!text.contains("\"abc\""), "{text}");
        assert_eq!(
            recorded_argv(&["x".into(), "-api-key=k".into(), "--PIN".into(), "1".into()]),
            ["x", "--api-key=[redacted]", "--PIN", "[redacted]"]
        );
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|line: &serde_json::Value| line["ch"] == "spawn")
            .collect();
        let start = lines.iter().find(|line| line["ev"] == "start").unwrap();
        assert_eq!(start["api"], "ProcessRunner");
        assert_eq!(
            start["argv"],
            serde_json::json!([
                "sh",
                "-c",
                "printf %s \"$(echo cHJpdmF0ZQ== | base64 -d)\"; exit 3",
                "--token",
                "[redacted]"
            ])
        );
        // The line's own pid wins over the field, as in TS.
        assert!(start["pid"].is_number());
        let exits: Vec<_> = lines.iter().filter(|line| line["ev"] == "exit").collect();
        assert_eq!(exits.len(), 2);
        assert_eq!(exits[0]["code"], 3);
        assert!(exits[0]["ms"].is_number());
        assert_eq!(exits[1]["argv"], serde_json::json!(["true"]));
        assert_eq!(exits[1]["code"], 0);
        let second = lines
            .iter()
            .filter(|line| line["ev"] == "start")
            .nth(1)
            .unwrap();
        assert_eq!(
            second["cwd"],
            serde_json::Value::from(scratch.path().to_string_lossy().into_owned())
        );
        recorder.close();
    }
}
