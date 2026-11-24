//! The front's SSH commands while Rust owns the `host` family (S16): every
//! command the front builds with sshCommandArgv runs here, inside the one
//! set of session slots and over the one master per host, so a host sees
//! the sessions it saw from Bun alone.
//!
//! - [`HostOps::run`]: a command run whole (bridge/ssh-sessions.ts
//!   `runSshCommand`): the refused-session retries, the cold rerun of a
//!   read and the remote deadline are [`SshSessions::run`]'s.
//! - [`HoldRegistry`]: a slot held for a command the front spawns itself
//!   (`holdSshSession`: an upload, a search, a stream, a history watch, a
//!   chat's shell command), released by the front or when the channel
//!   closes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_exec::lanes::{Lane, run_in_lane};
use roamgate_exec::process::{Command, ExecError, Output, ProcessRunner};
use roamgate_exec::ssh::command::{SshAnnotation, SshCommand};
use roamgate_exec::ssh::sessions::{
    SessionError, SshOutput, SshSessionHold, SshSessionWait, SshSessions,
};
use roamgate_exec::ssh::tunnel::{ProcessOutput, RunProcess};

/// A host command as the front built it (sshCommandArgv's arguments).
#[derive(Debug, Clone, Default)]
pub struct HostCommand {
    pub destination: String,
    pub command: String,
    pub trusted: Vec<String>,
    pub tag: Option<String>,
    /// Built by sshReadCommandArgv: no remote side effects.
    pub read_only: bool,
    pub connection: Option<String>,
}

/// How a command is run or held.
#[derive(Debug, Clone, Default)]
pub struct HostWait {
    pub timeout_ms: Option<u64>,
    pub lane: Lane,
}

/// What a command run gave back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRunOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Why a command did not run to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostOpError {
    pub message: String,
    /// `ssh_background_shed` for a background command dropped because its
    /// line is full (the front's `isSshBackgroundShed`); `invalid` for a
    /// destination sshCommandArgv would refuse.
    pub code: Option<&'static str>,
}

impl HostOpError {
    fn of(error: ExecError) -> Self {
        let code = match &error {
            ExecError::Session(SessionError::BackgroundShed(_)) => Some("ssh_background_shed"),
            _ => None,
        };
        Self {
            message: error.to_string(),
            code,
        }
    }

    fn invalid() -> Self {
        Self {
            message: "ssh_destination must be an OpenSSH alias or user@host".into(),
            code: Some("invalid"),
        }
    }
}

struct Ran {
    output: Output,
    stderr: String,
}

impl SshOutput for Ran {
    fn code(&self) -> i32 {
        self.output.code
    }
    fn stderr(&self) -> &str {
        &self.stderr
    }
    fn set_stderr(&mut self, stderr: String) {
        self.stderr = stderr;
    }
}

fn build(sessions: &SshSessions, command: &HostCommand) -> Result<SshCommand, HostOpError> {
    let built = if command.read_only {
        sessions.read_command_argv(
            &command.destination,
            &command.command,
            &command.trusted,
            command.tag.as_deref(),
        )
    } else {
        sessions.command_argv(
            &command.destination,
            &command.command,
            &command.trusted,
            command.tag.as_deref(),
        )
    }
    .map_err(|_| HostOpError::invalid())?;
    Ok(match &command.connection {
        Some(connection) => built.for_connection(connection),
        None => built,
    })
}

/// Where the front's commands run: the session slots, the runner, and in
/// tests the program run instead of `ssh`.
#[derive(Clone)]
pub struct HostOps {
    pub sessions: SshSessions,
    pub runner: ProcessRunner,
    pub program: Option<String>,
}

impl HostOps {
    pub fn new(sessions: SshSessions, runner: ProcessRunner) -> Self {
        Self {
            sessions,
            runner,
            program: None,
        }
    }

    fn local_argv(&self, argv: &[String]) -> Vec<String> {
        let mut argv = argv.to_vec();
        if let (Some(program), Some(first)) = (&self.program, argv.first_mut()) {
            *first = program.clone();
        }
        argv
    }

    /// Runs a host command inside its destination's session limit, with
    /// `stdin` as its input.
    pub async fn run(
        &self,
        command: &HostCommand,
        stdin: Option<Vec<u8>>,
        wait: &HostWait,
    ) -> Result<HostRunOutput, HostOpError> {
        let ssh = build(&self.sessions, command)?;
        self.run_ssh(&ssh, stdin, wait).await
    }

    /// An ssh command line made elsewhere (a master's `-O forward`, a
    /// review client's setup), inside its destination's session limit,
    /// whatever it exits with.
    pub async fn run_command(
        &self,
        ssh: &SshCommand,
        stdin: Option<Vec<u8>>,
        timeout_ms: Option<u64>,
    ) -> Result<HostRunOutput, HostOpError> {
        self.run_ssh(
            ssh,
            stdin,
            &HostWait {
                timeout_ms,
                lane: Lane::Interactive,
            },
        )
        .await
    }

    async fn run_ssh(
        &self,
        ssh: &SshCommand,
        stdin: Option<Vec<u8>>,
        wait: &HostWait,
    ) -> Result<HostRunOutput, HostOpError> {
        let session_wait = SshSessionWait {
            timeout_ms: wait.timeout_ms,
            signal: None,
        };
        let run = self.sessions.run(
            ssh,
            |attempt: SshCommand, remaining| {
                let mut local = Command::new(self.local_argv(&attempt.argv));
                if let Some(input) = &stdin {
                    local = local.stdin(input.clone());
                }
                if let Some(ms) = remaining.or(wait.timeout_ms) {
                    local = local.timeout(Duration::from_millis(ms));
                }
                let runner = self.runner.clone();
                async move {
                    let output = runner.run(&local).await?;
                    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                    Ok::<_, ExecError>(Ran { output, stderr })
                }
            },
            &session_wait,
        );
        let ran = run_in_lane(wait.lane, run).await.map_err(HostOpError::of)?;
        Ok(HostRunOutput {
            code: ran.output.code,
            stdout: ran.output.stdout,
            stderr: ran.stderr,
        })
    }

    /// The tunnel's `runProcess` (its HOME probe): a command through the
    /// session slots, an error unless it exits 0 (process-utils.ts
    /// `runProcess`).
    pub fn tunnel_run_process(&self) -> RunProcess {
        let ops = self.clone();
        Arc::new(
            move |command: SshCommand, input: Option<String>, timeout_ms: Option<u64>| {
                let ops = ops.clone();
                Box::pin(async move {
                    let wait = SshSessionWait {
                        timeout_ms,
                        signal: None,
                    };
                    let program = command.argv.first().cloned().unwrap_or_default();
                    let ran = ops
                        .sessions
                        .run(
                            &command,
                            |attempt: SshCommand, remaining| {
                                let mut local = Command::new(ops.local_argv(&attempt.argv));
                                if let Some(input) = &input {
                                    local = local.stdin(input.clone().into_bytes());
                                }
                                if let Some(ms) = remaining.or(timeout_ms) {
                                    local = local.timeout(Duration::from_millis(ms));
                                }
                                let runner = ops.runner.clone();
                                async move {
                                    let output = runner.run(&local).await?;
                                    let stderr =
                                        String::from_utf8_lossy(&output.stderr).into_owned();
                                    Ok::<_, ExecError>(Ran { output, stderr })
                                }
                            },
                            &wait,
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                    let stdout = ran.output.stdout_text();
                    if ran.output.code != 0 {
                        let detail = match ran.stderr.trim() {
                            "" => stdout.trim().to_owned(),
                            stderr => stderr.to_owned(),
                        };
                        return Err(format!("{program} exited {}: {detail}", ran.output.code));
                    }
                    Ok(ProcessOutput {
                        stdout,
                        stderr: ran.stderr,
                    })
                })
            },
        )
    }

    /// The argv to spawn for a held command (`program` in tests).
    pub fn spawn_argv(&self, held: &HeldCommand) -> Vec<String> {
        self.local_argv(&held.argv)
    }
}

/// A held slot as the front is told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldCommand {
    pub lease: u64,
    /// What to spawn.
    pub argv: Vec<String>,
    pub remaining_ms: Option<u64>,
    pub annotation: SshAnnotation,
}

/// The slots the front holds, by lease.
#[derive(Clone, Default)]
pub struct HoldRegistry {
    next: Arc<AtomicU64>,
    holds: Arc<Mutex<HashMap<u64, SshSessionHold>>>,
}

impl HoldRegistry {
    /// Holds a slot for `command` (a long-lived one never waits: see
    /// [`SshSessions::hold`]).
    pub async fn hold(
        &self,
        ops: &HostOps,
        command: &HostCommand,
        wait: &HostWait,
        long_lived: bool,
    ) -> Result<HeldCommand, HostOpError> {
        let ssh = build(&ops.sessions, command)?;
        let session_wait = SshSessionWait {
            timeout_ms: wait.timeout_ms,
            signal: None,
        };
        let hold = run_in_lane(
            wait.lane,
            ops.sessions.hold(&ssh, &session_wait, long_lived),
        )
        .await
        .map_err(|error| HostOpError::of(ExecError::Session(error)))?;
        let lease = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let held = HeldCommand {
            lease,
            argv: hold.command.argv.clone(),
            remaining_ms: hold.remaining_ms,
            annotation: hold.command.annotation.clone(),
        };
        self.holds.lock().unwrap().insert(lease, hold);
        Ok(held)
    }

    /// Gives a held slot back; an unknown lease is ignored.
    pub fn release(&self, lease: u64) -> bool {
        let hold = self.holds.lock().unwrap().remove(&lease);
        match hold {
            Some(hold) => {
                hold.release();
                true
            }
            None => false,
        }
    }

    /// Gives every slot back (the channel closed, the family went back).
    pub fn release_all(&self) {
        let holds: Vec<SshSessionHold> = self
            .holds
            .lock()
            .unwrap()
            .drain()
            .map(|(_, hold)| hold)
            .collect();
        for hold in holds {
            hold.release();
        }
    }

    pub fn len(&self) -> usize {
        self.holds.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests;
