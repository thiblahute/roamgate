//! Where a workspace's commands run (workspace/process.ts and the
//! `runProcessWithCodeTimeout` every workspace helper takes): this machine,
//! or a POSIX host over SSH.
//!
//! The helpers build what TS built: a local argv, or the remote command
//! line an ssh run carries (`sshCommandArgv` and `sshReadCommandArgv`, with
//! their tag). A [`Runner`] runs it. While Bun owns the host layer (stage 1
//! of the migration) an SSH run goes back to Bun, which holds the masters
//! and session slots; [`LocalRunner`] runs what this machine runs.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use roamgate_exec::process::{Command, ExecError, ProcessRunner};

pub type RunFuture<'a> = Pin<Box<dyn Future<Output = Result<Ran, RunError>> + Send + 'a>>;

/// A command's end: its exit code and its output as text (UTF-8, lossy),
/// as `runProcessWithCodeTimeout` gives them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    pub fn new(code: i32, stdout: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self {
            code,
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }
}

/// A command that could not run to its end (spawn failure, deadline).
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct RunError(pub String);

impl From<ExecError> for RunError {
    fn from(error: ExecError) -> Self {
        Self(error.to_string())
    }
}

/// What to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// Words run on this machine as they are.
    Local(Vec<String>),
    /// A remote command line for a POSIX host's login shell over SSH.
    Ssh {
        destination: String,
        command: String,
        /// No side effect: may rerun once cold when its master dies
        /// mid-command (`sshReadCommandArgv`).
        read: bool,
        /// The caller's name in the ssh process log.
        tag: Option<String>,
    },
}

impl Invocation {
    pub fn local<S: Into<String>>(argv: impl IntoIterator<Item = S>) -> Self {
        Self::Local(argv.into_iter().map(Into::into).collect())
    }

    /// `sshCommandArgv(destination, command, [], tag)`.
    pub fn ssh(destination: &str, command: &str, tag: Option<&str>) -> Self {
        Self::Ssh {
            destination: destination.to_owned(),
            command: command.to_owned(),
            read: false,
            tag: tag.map(str::to_owned),
        }
    }

    /// `sshReadCommandArgv(destination, command, [], tag)`.
    pub fn ssh_read(destination: &str, command: &str, tag: Option<&str>) -> Self {
        Self::Ssh {
            destination: destination.to_owned(),
            command: command.to_owned(),
            read: true,
            tag: tag.map(str::to_owned),
        }
    }

    /// The words a log names it by.
    pub fn program(&self) -> &str {
        match self {
            Self::Local(argv) => argv.first().map(String::as_str).unwrap_or(""),
            Self::Ssh { .. } => "ssh",
        }
    }
}

/// A run: what, with what on stdin, for how long.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub invocation: Invocation,
    pub input: Option<Vec<u8>>,
    pub timeout: Duration,
}

impl Request {
    pub fn new(invocation: Invocation, timeout: Duration) -> Self {
        Self {
            invocation,
            input: None,
            timeout,
        }
    }

    pub fn with_input(mut self, input: impl Into<Vec<u8>>) -> Self {
        self.input = Some(input.into());
        self
    }
}

/// Runs a workspace's commands.
pub trait Runner: Send + Sync {
    fn run(&self, request: Request) -> RunFuture<'_>;
}

pub type SharedRunner = Arc<dyn Runner>;

/// Where a workspace's Git runs: its host (an SSH destination, or none
/// for this machine) and the runner.
#[derive(Clone)]
pub struct GitContext {
    pub host: Option<String>,
    pub runner: SharedRunner,
}

impl std::fmt::Debug for GitContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitContext")
            .field("host", &self.host)
            .finish()
    }
}

impl GitContext {
    pub fn new(host: Option<String>, runner: SharedRunner) -> Self {
        Self {
            host: host.filter(|host| !host.is_empty()),
            runner,
        }
    }

    pub fn local(runner: SharedRunner) -> Self {
        Self { host: None, runner }
    }

    pub fn host(&self) -> Option<&str> {
        self.host.as_deref()
    }

    /// `runProcessWithCodeTimeout(invocation, timeout)`.
    pub async fn run(&self, invocation: Invocation, timeout: Duration) -> Result<Ran, RunError> {
        self.runner.run(Request::new(invocation, timeout)).await
    }

    /// `runProcessWithInputTimeout(invocation, input, timeout)`.
    pub async fn run_input(
        &self,
        invocation: Invocation,
        input: impl Into<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Ran, RunError> {
        self.runner
            .run(Request::new(invocation, timeout).with_input(input))
            .await
    }
}

/// Runs local words on this machine with `COPYFILE_DISABLE=1` (macOS tar
/// writes no `._` files), as workspace/process.ts spawns them. An SSH run
/// is refused: this runner has no masters or session slots.
#[derive(Debug, Clone)]
pub struct LocalRunner {
    runner: ProcessRunner,
}

impl LocalRunner {
    pub fn new(runner: ProcessRunner) -> Self {
        Self { runner }
    }

    pub fn system() -> Self {
        Self::new(ProcessRunner::system())
    }

    pub async fn run_local(
        &self,
        argv: &[String],
        input: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<Ran, RunError> {
        let mut command = Command::new(argv.iter().cloned());
        command.env = vec![("COPYFILE_DISABLE".into(), Some("1".into()))];
        command.stdin = input.map(<[u8]>::to_vec);
        command.timeout = Some(timeout);
        let output = self.runner.run(&command).await?;
        Ok(Ran {
            code: output.code,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl Runner for LocalRunner {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            match &request.invocation {
                Invocation::Local(argv) => {
                    self.run_local(argv, request.input.as_deref(), request.timeout)
                        .await
                }
                Invocation::Ssh { destination, .. } => Err(RunError(format!(
                    "no SSH runner for {destination} in this process"
                ))),
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! Runners for the tests: the real one, and one that answers from a
    //! function and keeps what it was asked.

    use std::sync::Mutex;

    use super::*;

    pub fn local() -> GitContext {
        GitContext::local(Arc::new(LocalRunner::system()))
    }

    type Answer = dyn Fn(&Request) -> Result<Ran, RunError> + Send + Sync;

    pub struct Scripted {
        answer: Box<Answer>,
        pub calls: Mutex<Vec<Request>>,
    }

    impl Scripted {
        pub fn new(
            answer: impl Fn(&Request) -> Result<Ran, RunError> + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                answer: Box::new(answer),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn calls(&self) -> Vec<Request> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runner for Scripted {
        fn run(&self, request: Request) -> RunFuture<'_> {
            self.calls.lock().unwrap().push(request.clone());
            let answer = (self.answer)(&request);
            Box::pin(async move { answer })
        }
    }

    /// The real local runner with words put before each command (`env
    /// HOME=...`), a banner before its output (a login profile), or a
    /// shorter deadline.
    #[derive(Default)]
    pub struct Wrapped {
        pub prefix: Vec<String>,
        pub banner: String,
        pub timeout: Option<Duration>,
    }

    impl Wrapped {
        pub fn env(pairs: &[(&str, &str)]) -> GitContext {
            let mut prefix = vec!["env".to_owned()];
            prefix.extend(pairs.iter().map(|(k, v)| format!("{k}={v}")));
            GitContext::local(Arc::new(Self {
                prefix,
                ..Self::default()
            }))
        }

        pub fn banner(text: &str) -> GitContext {
            GitContext::local(Arc::new(Self {
                banner: text.to_owned(),
                ..Self::default()
            }))
        }

        #[cfg(unix)]
        pub fn deadline(timeout: Duration) -> GitContext {
            GitContext::local(Arc::new(Self {
                timeout: Some(timeout),
                ..Self::default()
            }))
        }
    }

    impl Runner for Wrapped {
        fn run(&self, request: Request) -> RunFuture<'_> {
            Box::pin(async move {
                let Invocation::Local(argv) = &request.invocation else {
                    return Err(RunError("not local".into()));
                };
                let mut words = self.prefix.clone();
                words.extend(argv.iter().cloned());
                let mut ran = LocalRunner::system()
                    .run_local(
                        &words,
                        request.input.as_deref(),
                        self.timeout.unwrap_or(request.timeout),
                    )
                    .await?;
                ran.stdout = format!("{}{}", self.banner, ran.stdout);
                Ok(ran)
            })
        }
    }

    /// The text a request runs: a local argv joined, or the SSH line.
    /// A request's command line, and its script when it is given on
    /// stdin (Windows' snapshot).
    pub fn text(request: &Request) -> String {
        let line = match &request.invocation {
            Invocation::Local(argv) => argv.join(" "),
            Invocation::Ssh { command, .. } => command.clone(),
        };
        match &request.input {
            Some(input) if cfg!(windows) => format!("{line} {}", String::from_utf8_lossy(input)),
            _ => line,
        }
    }

    type Hook = dyn Fn(Request) -> futures_util::future::BoxFuture<'static, Option<Result<Ran, RunError>>>
        + Send
        + Sync;

    /// The real local runner behind a hook that sees each request first
    /// and may wait (a gate) or answer in its place.
    pub struct Hooked {
        hook: Box<Hook>,
    }

    impl Hooked {
        pub fn context(
            hook: impl Fn(
                Request,
            )
                -> futures_util::future::BoxFuture<'static, Option<Result<Ran, RunError>>>
            + Send
            + Sync
            + 'static,
        ) -> GitContext {
            GitContext::local(Arc::new(Self {
                hook: Box::new(hook),
            }))
        }
    }

    impl Runner for Hooked {
        fn run(&self, request: Request) -> RunFuture<'_> {
            Box::pin(async move {
                if let Some(answer) = (self.hook)(request.clone()).await {
                    return answer;
                }
                let Invocation::Local(argv) = &request.invocation else {
                    return Err(RunError("not local".into()));
                };
                // These tests are about order, not deadlines: a loaded
                // runner (Windows' Git Bash snapshots) may pass the
                // production one, so the real process gets a minute at least.
                let timeout = request.timeout.max(std::time::Duration::from_secs(60));
                LocalRunner::system()
                    .run_local(argv, request.input.as_deref(), timeout)
                    .await
            })
        }
    }

    type Transform = dyn Fn(&str) -> String + Send + Sync;

    /// The real local runner with the script (the last word) rewritten
    /// first, and an optional deadline of its own.
    pub struct Instrumented {
        transform: Box<Transform>,
        timeout: Option<Duration>,
    }

    impl Instrumented {
        pub fn context(
            transform: impl Fn(&str) -> String + Send + Sync + 'static,
            timeout: Option<Duration>,
        ) -> GitContext {
            GitContext::local(Arc::new(Self {
                transform: Box::new(transform),
                timeout,
            }))
        }
    }

    impl Runner for Instrumented {
        fn run(&self, request: Request) -> RunFuture<'_> {
            Box::pin(async move {
                let Invocation::Local(argv) = &request.invocation else {
                    return Err(RunError("not local".into()));
                };
                let mut words = argv.clone();
                // The script is the last word, or the input when it is
                // given on stdin (Windows' snapshot).
                let input = match &request.input {
                    Some(input) => {
                        Some((self.transform)(&String::from_utf8_lossy(input)).into_bytes())
                    }
                    None => {
                        if let Some(last) = words.last_mut() {
                            *last = (self.transform)(last);
                        }
                        None
                    }
                };
                LocalRunner::system()
                    .run_local(
                        &words,
                        input.as_deref(),
                        self.timeout.unwrap_or(request.timeout),
                    )
                    .await
            })
        }
    }

    /// A runner that runs local words for real, and an SSH command's line
    /// locally with `sh -c` (a fake host that is this machine), keeping
    /// each request.
    pub struct Loopback {
        local: LocalRunner,
        pub calls: Mutex<Vec<Request>>,
    }

    impl Loopback {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                local: LocalRunner::system(),
                calls: Mutex::new(Vec::new()),
            })
        }

        pub fn calls(&self) -> Vec<Request> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Runner for Loopback {
        fn run(&self, request: Request) -> RunFuture<'_> {
            self.calls.lock().unwrap().push(request.clone());
            Box::pin(async move {
                let argv = match &request.invocation {
                    Invocation::Local(argv) => argv.clone(),
                    Invocation::Ssh { command, .. } => {
                        vec!["sh".into(), "-c".into(), command.clone()]
                    }
                };
                self.local
                    .run_local(&argv, request.input.as_deref(), request.timeout)
                    .await
            })
        }
    }
}
