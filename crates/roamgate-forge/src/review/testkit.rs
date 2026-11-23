//! Fake glab and gh for the review forge's tests: a runner that answers
//! each process a test's handler's way and keeps what it was asked.

use std::sync::{Arc, Mutex};

use roamgate_base::clock::{BoxFuture, SharedClock, TokioClock};
use serde_json::Value;

use super::cli::{ForgeContext, ForgeProcess, ForgeRunner, ForgeTools, RunError};
use crate::gate::{ForgeGate, ProcessOutput, without_gate_flags};

pub(crate) type Answer = Result<ProcessOutput, RunError>;
type Handler = Arc<dyn Fn(ForgeProcess) -> BoxFuture<Answer> + Send + Sync>;

/// A runner answering through its handler.
pub(crate) struct Fake {
    pub processes: Mutex<Vec<ForgeProcess>>,
    handler: Handler,
}

impl ForgeRunner for Fake {
    fn run(&self, process: ForgeProcess, _timeout_ms: u64) -> BoxFuture<Answer> {
        self.processes.lock().unwrap().push(process.clone());
        (self.handler)(process)
    }
}

impl Fake {
    pub fn new(
        handler: impl Fn(ForgeProcess) -> BoxFuture<Answer> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            processes: Mutex::default(),
            handler: Arc::new(handler),
        })
    }

    /// A runner answering at once.
    pub fn sync(handler: impl Fn(&ForgeProcess) -> Answer + Send + Sync + 'static) -> Arc<Self> {
        let handler = Arc::new(handler);
        Self::new(move |process| {
            let answer = handler(&process);
            Box::pin(async move { answer })
        })
    }
}

pub(crate) fn clock() -> SharedClock {
    Arc::new(TokioClock::starting_at(1_767_182_400_000))
}

/// Tools on `runner`, with a gate of their own.
pub(crate) fn tools(runner: Arc<dyn ForgeRunner>) -> ForgeTools {
    let clock = clock();
    ForgeTools::new(runner, ForgeGate::new(clock.clone()), clock, "test")
}

/// A context at `/repo` on this machine.
pub(crate) fn context(runner: Arc<dyn ForgeRunner>) -> ForgeContext {
    tools(runner).context("/repo", None)
}

pub(crate) fn ok(stdout: impl Into<String>) -> Answer {
    Ok(ProcessOutput {
        code: 0,
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

pub(crate) fn json(value: &Value) -> Answer {
    ok(value.to_string())
}

pub(crate) fn fail(code: i32, stderr: impl Into<String>) -> Answer {
    Ok(ProcessOutput {
        code,
        stdout: String::new(),
        stderr: stderr.into(),
    })
}

/// What a process says: a CLI's argv (without the gate's flags), a script
/// or an SSH command line as one word.
pub(crate) fn words(process: &ForgeProcess) -> Vec<String> {
    match process {
        ForgeProcess::Cli { argv, .. } => without_gate_flags(argv),
        ForgeProcess::Script { script, .. } => vec![script.clone()],
        ForgeProcess::Ssh { command, .. } => vec![command.clone()],
    }
}

/// Whether a process asks glab about a host (glab_host_script).
pub(crate) fn is_host_probe(process: &ForgeProcess) -> bool {
    words(process)
        .iter()
        .any(|word| word.contains("glab config get host"))
}

/// glab's answer about a host: gitlab.example is its default host, and it
/// has a login of its own for `logins`.
pub(crate) fn host_probe(process: &ForgeProcess, logins: &[&str]) -> Option<Answer> {
    if !is_host_probe(process) {
        return None;
    }
    let script = words(process).join(" ");
    let login = logins
        .iter()
        .any(|host| script.contains(&format!("token '{host}'")));
    Some(ok(format!(
        "glab https://gitlab.example\n{}",
        if login { "login\n" } else { "" }
    )))
}

/// The value of a `-f`/`-F` field.
pub(crate) fn field(argv: &[String], name: &str) -> Option<String> {
    argv.iter()
        .find_map(|arg| arg.strip_prefix(&format!("{name}=")).map(str::to_owned))
}
