//! Runners for the files tests: an SSH host played by this machine (the
//! remote command line run by `bash -c`, as the TS tests do), and the
//! calls they were asked.

use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;
use futures_util::future::BoxFuture;
use roamgate_git::exec::{LocalRunner, RunFuture};
use roamgate_git::{GitContext, Invocation, Ran, Request, RunError, Runner};
use serde_json::Value;

use crate::connection::WorkspaceConnection;
use crate::connection::testing::FakeHerdr;
use crate::process::{StreamProcess, StreamedProcess, spawn_local};

type Transform = dyn Fn(&str) -> String + Send + Sync;

/// Runs a local command as it is and an SSH one's command line with
/// `bash -c` here; keeps every request.
pub struct Loopback {
    transform: Box<Transform>,
    env: Vec<(String, String)>,
    pub calls: Mutex<Vec<Request>>,
    pub outputs: Mutex<Vec<usize>>,
}

impl Loopback {
    pub fn new() -> Arc<Self> {
        Self::with(|command| command.to_owned())
    }

    /// Changes each SSH command line before it runs.
    pub fn with(transform: impl Fn(&str) -> String + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            transform: Box::new(transform),
            env: Vec::new(),
            calls: Mutex::new(Vec::new()),
            outputs: Mutex::new(Vec::new()),
        })
    }

    /// Runs with these variables set (`PATH` with shims).
    pub fn with_env(
        transform: impl Fn(&str) -> String + Send + Sync + 'static,
        env: Vec<(String, String)>,
    ) -> Arc<Self> {
        Arc::new(Self {
            transform: Box::new(transform),
            env,
            calls: Mutex::new(Vec::new()),
            outputs: Mutex::new(Vec::new()),
        })
    }

    pub fn calls(&self) -> Vec<Request> {
        self.calls.lock().unwrap().clone()
    }
}

/// The command without its login shell: the host's profile is not what
/// these tests are about, and a login profile here can take seconds.
fn no_login(command: String) -> String {
    match command.strip_prefix("bash -lc ") {
        Some(rest) => format!("bash -c {rest}"),
        None => command,
    }
}

/// What the TS test's argv would be: a local one, or `ssh ... <line>`'s
/// line.
pub fn local_argv(invocation: &Invocation) -> Vec<String> {
    match invocation {
        Invocation::Local(argv) => argv.clone(),
        Invocation::Ssh { command, .. } => vec!["ssh".into(), command.clone()],
    }
}

impl Runner for Loopback {
    fn run(&self, request: Request) -> RunFuture<'_> {
        self.calls.lock().unwrap().push(request.clone());
        let argv: Vec<String> = match &request.invocation {
            Invocation::Local(argv) => argv.clone(),
            Invocation::Ssh { command, .. } => {
                vec![
                    "bash".into(),
                    "-c".into(),
                    no_login((self.transform)(command)),
                ]
            }
        };
        let argv = if self.env.is_empty() {
            argv
        } else {
            let mut with = vec!["env".to_owned()];
            with.extend(self.env.iter().map(|(k, v)| format!("{k}={v}")));
            with.extend(argv);
            with
        };
        Box::pin(async move {
            let ran = LocalRunner::system()
                .run_local(&argv, request.input.as_deref(), request.timeout)
                .await?;
            self.outputs.lock().unwrap().push(ran.stdout.len());
            Ok(ran)
        })
    }
}

/// Streams an SSH command's line by `bash -c` here, after `before`.
pub struct LoopbackStreams {
    pub spawned: Mutex<Vec<Invocation>>,
    before: Box<dyn Fn() + Send + Sync>,
}

impl LoopbackStreams {
    pub fn new(before: impl Fn() + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            spawned: Mutex::new(Vec::new()),
            before: Box::new(before),
        })
    }
}

impl StreamProcess for LoopbackStreams {
    fn spawn(&self, invocation: Invocation) -> BoxFuture<'_, Result<StreamedProcess, String>> {
        self.spawned.lock().unwrap().push(invocation.clone());
        (self.before)();
        async move {
            match invocation {
                Invocation::Ssh { command, .. } => {
                    spawn_local(&["bash".into(), "-c".into(), no_login(command)])
                }
                Invocation::Local(argv) => spawn_local(&argv),
            }
        }
        .boxed()
    }
}

/// A connection on `host` (None: this machine) through `runner`, its
/// Herdr answering from `answer`.
pub fn connection(
    host: Option<&str>,
    runner: Arc<dyn Runner>,
    answer: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
) -> (WorkspaceConnection, Arc<FakeHerdr>) {
    let herdr = FakeHerdr::new(answer);
    let mut conn = crate::connection::testing::connection(herdr.clone());
    conn.git = GitContext::new(host.map(str::to_owned), runner);
    (conn, herdr)
}

type Answer = dyn Fn(&Request) -> Result<Ran, RunError> + Send + Sync;

/// A runner answering every request from a function.
pub struct Scripted(pub Box<Answer>, pub Mutex<Vec<Request>>);

impl Scripted {
    pub fn new(
        answer: impl Fn(&Request) -> Result<Ran, RunError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self(Box::new(answer), Mutex::new(Vec::new())))
    }

    pub fn argvs(&self) -> Vec<Vec<String>> {
        self.1
            .lock()
            .unwrap()
            .iter()
            .map(|r| local_argv(&r.invocation))
            .collect()
    }
}

impl Runner for Scripted {
    fn run(&self, request: Request) -> RunFuture<'_> {
        self.1.lock().unwrap().push(request.clone());
        let answer = (self.0)(&request);
        Box::pin(async move { answer })
    }
}
