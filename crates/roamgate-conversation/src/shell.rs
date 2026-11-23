//! A `!` line from a chat in conversation mode (`shell.ts`), run as
//! Claude Code's bash mode would in the terminal: on the pane's host, in
//! the session's directory, with the user's login shell. It is the user's
//! own command, typed by them: nothing is asked or filtered.
//!
//! The shell runs in a job of its own under a small POSIX wrapper
//! (contract/assets/sh/shell-job.sh) that ends the whole job when its
//! stdin closes: Stop closes it, and so does a dropped SSH connection, so
//! nothing is left running on the host.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::js;
use roamgate_agents::shared::bash_mode::BASH_OUTPUT_LIMIT;
use roamgate_base::assets::SHELL_JOB_SH;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

use crate::driver::BoxFuture;

/// The wrapper.
pub const WRAPPER: &str = SHELL_JOB_SH;

/// At most this much of each stream is kept (UTF-16 units, as Bun's
/// strings count), then the rest is counted out.
const KEEP: usize = BASH_OUTPUT_LIMIT + 4096;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellOutput {
    pub stdout: String,
    pub stderr: String,
    /// Output past the cap was dropped (only the first part is kept).
    pub truncated: bool,
}

/// How a run ended: its exit code (None when it was stopped or killed by
/// a signal), and whether it was stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShellDone {
    pub code: Option<i32>,
    pub stopped: bool,
}

/// A run: its end, and Stop.
pub struct ShellRun {
    pub done: BoxFuture<'static, Result<ShellDone, String>>,
    pub(crate) stop: Arc<dyn Fn() + Send + Sync>,
}

impl ShellRun {
    pub fn stop(&self) {
        (self.stop)()
    }
}

/// What starts a `!` line (`ShellRunner`).
pub trait ShellRunner: Send + Sync {
    fn run(
        &self,
        cwd: &str,
        command: &str,
        on_output: Arc<dyn Fn(ShellOutput) + Send + Sync>,
    ) -> ShellRun;
}

/// The command line a host's `sh` runs over SSH: the wrapper and its
/// arguments, quoted for that `sh` (the core gives it to its SSH command,
/// annotated `agent_chat.shell`).
pub fn remote_shell_command(cwd: &str, command: &str, sh_quote: &dyn Fn(&str) -> String) -> String {
    format!(
        "sh -c {} sh {} {}",
        sh_quote(WRAPPER),
        sh_quote(cwd),
        sh_quote(command)
    )
}

/// A local run's argv: the wrapper under `/bin/sh`, with the login shell.
pub fn local_shell_argv(cwd: &str, command: &str, login_shell: &str) -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        WRAPPER.into(),
        "sh".into(),
        cwd.into(),
        command.into(),
        login_shell.into(),
    ]
}

/// The local login shell: the account's, not the server's environment's.
pub fn local_login_shell() -> String {
    #[cfg(unix)]
    {
        let uid = rustix::process::getuid().as_raw();
        if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
            for line in passwd.lines() {
                let fields: Vec<&str> = line.split(':').collect();
                if fields.len() >= 7
                    && fields[2].parse::<u32>().ok() == Some(uid)
                    && !fields[6].is_empty()
                {
                    return fields[6].to_owned();
                }
            }
        }
    }
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// Roamgate's own secrets and markers stay out of the user's commands.
pub fn shell_env<I: IntoIterator<Item = (String, String)>>(env: I) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(key, _)| !key.starts_with("ROAMGATE_") && key != "HERDR_PANE_ID")
        .collect()
}

/// A run's SSH session slot (or nothing, locally): the argv to run, and
/// what releases the slot once the run ended.
pub type HoldSession = Arc<
    dyn Fn(Vec<String>) -> BoxFuture<'static, Result<(Vec<String>, Box<dyn Send>), String>>
        + Send
        + Sync,
>;

/// A run's command line: (cwd, command) to argv.
pub type ShellArgv = Arc<dyn Fn(&str, &str) -> Vec<String> + Send + Sync>;

/// Runs `!` lines with `argv` (cwd, command) as the command line, through
/// `hold` when given (an SSH session of the interactive lane).
pub struct ProcessShellRunner {
    pub argv: ShellArgv,
    pub hold: Option<HoldSession>,
}

impl ProcessShellRunner {
    /// Local runs with the account's login shell.
    pub fn local() -> Self {
        let login = local_login_shell();
        Self {
            argv: Arc::new(move |cwd, command| local_shell_argv(cwd, command, &login)),
            hold: None,
        }
    }
}

struct RunState {
    stopped: bool,
    pid: Option<u32>,
    stdin: Option<tokio::process::ChildStdin>,
}

fn take(
    output: &Mutex<ShellOutput>,
    stderr: bool,
    chunk: &[u8],
    on_output: &(dyn Fn(ShellOutput) + Send + Sync),
) {
    let snapshot = {
        let mut output = output.lock().unwrap();
        let kept = if stderr {
            &output.stderr
        } else {
            &output.stdout
        };
        let room = KEEP.saturating_sub(js::len16(kept));
        if room == 0 {
            output.truncated = true;
            return;
        }
        let text = String::from_utf8_lossy(chunk);
        if js::len16(&text) > room {
            output.truncated = true;
        }
        let piece = js::head16(&text, room);
        if stderr {
            output.stderr.push_str(&piece);
        } else {
            output.stdout.push_str(&piece);
        }
        output.clone()
    };
    on_output(snapshot);
}

impl ShellRunner for ProcessShellRunner {
    fn run(
        &self,
        cwd: &str,
        command: &str,
        on_output: Arc<dyn Fn(ShellOutput) + Send + Sync>,
    ) -> ShellRun {
        let argv = (self.argv)(cwd, command);
        let hold = self.hold.clone();
        let state = Arc::new(Mutex::new(RunState {
            stopped: false,
            pid: None,
            stdin: None,
        }));
        let (exited, exit_seen) = watch::channel(false);
        let output = Arc::new(Mutex::new(ShellOutput::default()));
        let run_state = state.clone();
        let done = Box::pin(async move {
            let (argv, release) = match &hold {
                Some(hold) => hold(argv).await?,
                None => (argv, Box::new(()) as Box<dyn Send>),
            };
            let _release = release;
            if run_state.lock().unwrap().stopped {
                return Ok(ShellDone {
                    code: None,
                    stopped: true,
                });
            }
            let mut child = tokio::process::Command::new(&argv[0])
                .args(&argv[1..])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env_clear()
                .envs(shell_env(std::env::vars()))
                .kill_on_drop(false)
                .spawn()
                .map_err(|error| error.to_string())?;
            {
                let mut state = run_state.lock().unwrap();
                state.pid = child.id();
                state.stdin = child.stdin.take();
                if state.stopped {
                    state.stdin = None;
                }
            }
            let read = |mut stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>, stderr: bool| {
                let output = output.clone();
                let on_output = on_output.clone();
                async move {
                    let mut buffer = vec![0u8; 64 * 1024];
                    loop {
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => take(&output, stderr, &buffer[..read], &*on_output),
                        }
                    }
                }
            };
            let stdout = read(Box::new(child.stdout.take().unwrap()), false);
            let stderr = read(Box::new(child.stderr.take().unwrap()), true);
            let wait = async {
                let status = child.wait().await;
                // Its watcher reads stdin until it closes: close it once
                // the wrapper is done, so its pipes close too.
                run_state.lock().unwrap().stdin = None;
                let _ = exited.send(true);
                status
            };
            let (status, (), ()) = tokio::join!(wait, stdout, stderr);
            let status = status.map_err(|error| error.to_string())?;
            let stopped = run_state.lock().unwrap().stopped;
            Ok(ShellDone {
                code: if stopped { None } else { status.code() },
                stopped,
            })
        });
        let stop_state = state;
        let stop = Arc::new(move || {
            let pid = {
                let mut state = stop_state.lock().unwrap();
                if state.stopped {
                    return;
                }
                state.stopped = true;
                // The wrapper ends the job when its stdin closes; ssh
                // carries that to the host.
                state.stdin = None;
                state.pid
            };
            let Some(pid) = pid else {
                return;
            };
            let mut exit_seen = exit_seen.clone();
            tokio::spawn(async move {
                let ended = tokio::time::timeout(
                    Duration::from_secs(3),
                    exit_seen.wait_for(|exited| *exited),
                )
                .await;
                if ended.is_err() {
                    terminate(pid);
                }
            });
        });
        ShellRun { done, stop }
    }
}

fn terminate(pid: u32) {
    #[cfg(unix)]
    if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
    #[cfg(not(unix))]
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

#[cfg(all(test, unix))]
mod tests;
