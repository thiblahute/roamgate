//! What the worktree tests share: runners answering from a function, a
//! connection on them, and the unquoting of an ssh `sh -c` line.

use std::sync::{Arc, Mutex};

use roamgate_git::exec::{LocalRunner, RunFuture, Runner};
use roamgate_git::{GitContext, Invocation, Ran, Request, RunError};
use serde_json::{Value, json};

use crate::connection::testing::{FakeHerdr, MemorySettings};
use crate::connection::{Herdr, WorkspaceConnection};

type Answer = dyn Fn(&Request) -> futures_util::future::BoxFuture<'static, Result<Ran, RunError>>
    + Send
    + Sync;

/// A runner answering from an async function, keeping each request.
pub struct FnRunner {
    answer: Box<Answer>,
    pub calls: Mutex<Vec<Request>>,
}

impl FnRunner {
    pub fn new(
        answer: impl Fn(&Request) -> futures_util::future::BoxFuture<'static, Result<Ran, RunError>>
        + Send
        + Sync
        + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            answer: Box::new(answer),
            calls: Mutex::new(Vec::new()),
        })
    }

    /// Answers each request with `ran` (sync).
    pub fn answering(
        answer: impl Fn(&Request) -> Result<Ran, RunError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Self::new(move |request| {
            let result = answer(request);
            Box::pin(async move { result })
        })
    }

    pub fn requests(&self) -> Vec<Request> {
        self.calls.lock().unwrap().clone()
    }
}

impl Runner for FnRunner {
    fn run(&self, request: Request) -> RunFuture<'_> {
        self.calls.lock().unwrap().push(request.clone());
        let future = (self.answer)(&request);
        Box::pin(future)
    }
}

/// The last word of what runs: a local argv's last word, an ssh command.
pub fn last_word(request: &Request) -> String {
    match &request.invocation {
        Invocation::Local(argv) => argv.last().cloned().unwrap_or_default(),
        Invocation::Ssh { command, .. } => command.clone(),
    }
}

/// Runs locally what would run locally, and an ssh command with `sh -c`
/// here, checking it goes to `host`.
pub fn shell_runner(host: Option<&'static str>) -> Arc<FnRunner> {
    FnRunner::new(move |request| {
        let request = request.clone();
        Box::pin(async move {
            let local = LocalRunner::system();
            let argv = match &request.invocation {
                Invocation::Local(argv) => {
                    assert!(host.is_none(), "a local run on an ssh connection");
                    argv.clone()
                }
                Invocation::Ssh {
                    destination,
                    command,
                    ..
                } => {
                    assert_eq!(Some(destination.as_str()), host);
                    vec!["sh".into(), "-c".into(), command.clone()]
                }
            };
            local
                .run_local(&argv, request.input.as_deref(), request.timeout)
                .await
        })
    })
}

/// The script inside an ssh `sh -c '<script>'`, unquoted by sh.
pub fn remote_script(command: &str) -> String {
    let rest = command
        .strip_prefix("sh -c ")
        .unwrap_or_else(|| panic!("not an sh -c line: {command}"));
    let output = std::process::Command::new("sh")
        .args(["-c", &format!("printf %s {rest}")])
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap()
}

/// The legacy connection on `runner` (an ssh one when `host`), a Herdr
/// answering `{}`, and empty settings.
pub fn connection(host: Option<&str>, runner: Arc<dyn Runner>) -> WorkspaceConnection {
    connection_with(
        host,
        runner,
        FakeHerdr::new(|_, _| Ok(json!({}))),
        json!({}),
    )
}

pub fn connection_with(
    host: Option<&str>,
    runner: Arc<dyn Runner>,
    herdr: Arc<dyn Herdr>,
    settings: Value,
) -> WorkspaceConnection {
    let mut conn = crate::connection::testing::connection(herdr);
    // The legacy connection: its settings keys have no connection prefix.
    conn.id = roamgate_base::settings::LEGACY_DEFAULT_CONNECTION_ID.into();
    conn.git = GitContext::new(host.map(str::to_owned), runner);
    conn.settings = MemorySettings::new(settings);
    conn
}

pub fn ran(code: i32, stdout: &str, stderr: &str) -> Ran {
    Ran::new(code, stdout, stderr)
}
