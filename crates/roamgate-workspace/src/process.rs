//! Processes whose output is read as it comes (workspace/process.ts
//! `spawnStreamingProcess`): a file sent whole, a search cut at its
//! hundredth result. A command run whole goes through roamgate-git's
//! [`Runner`](roamgate_git::Runner) instead.
//!
//! Over SSH the core's workspace family gives a [`StreamProcess`] that
//! takes one of the master's long-lived sessions (Bun's
//! `holdSshSession`); [`LocalStreams`] runs this machine's.

use std::process::Stdio;
use std::sync::Arc;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use roamgate_git::Invocation;
use tokio::io::AsyncReadExt as _;
use tokio::sync::{Notify, mpsc};

/// A chunk of output, or the read's failure.
pub type Chunk = Result<Vec<u8>, String>;

/// A process being read (`StreamedProcess`).
pub struct StreamedProcess {
    /// Its stdout in chunks; closed at its end.
    pub stdout: mpsc::Receiver<Chunk>,
    /// Its exit code (128 + the signal when one ended it).
    pub exited: Shared<BoxFuture<'static, i32>>,
    /// Its stderr, whole, once it ended.
    pub stderr: Shared<BoxFuture<'static, String>>,
    kill: Arc<dyn Fn() + Send + Sync>,
}

impl StreamedProcess {
    pub fn new(
        stdout: mpsc::Receiver<Chunk>,
        exited: BoxFuture<'static, i32>,
        stderr: BoxFuture<'static, String>,
        kill: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            stdout,
            exited: exited.shared(),
            stderr: stderr.shared(),
            kill,
        }
    }

    /// Ends it (nothing when it already ended).
    pub fn kill(&self) {
        (self.kill)();
    }
}

impl Drop for StreamedProcess {
    fn drop(&mut self) {
        // A body dropped half read (the browser went) ends its process.
        if self.exited.peek().is_none() {
            (self.kill)();
        }
    }
}

/// Starts a process to read as it comes.
pub trait StreamProcess: Send + Sync {
    fn spawn(&self, invocation: Invocation) -> BoxFuture<'_, Result<StreamedProcess, String>>;
}

/// This machine's processes, with `COPYFILE_DISABLE=1` as process.ts
/// spawns them; an SSH command is refused.
#[derive(Debug, Clone, Copy, Default)]
pub struct LocalStreams;

impl StreamProcess for LocalStreams {
    fn spawn(&self, invocation: Invocation) -> BoxFuture<'_, Result<StreamedProcess, String>> {
        async move {
            match invocation {
                Invocation::Local(argv) => spawn_local(&argv),
                Invocation::Ssh { destination, .. } => {
                    Err(format!("no SSH runner for {destination} in this process"))
                }
            }
        }
        .boxed()
    }
}

/// Spawns `argv` here, its stdout read in chunks as it comes.
pub fn spawn_local(argv: &[String]) -> Result<StreamedProcess, String> {
    let Some((program, args)) = argv.split_first() else {
        return Err("nothing to run".into());
    };
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .env("COPYFILE_DISABLE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let (sender, receiver) = mpsc::channel::<Chunk>(4);
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    if sender.send(Ok(buffer[..read].to_vec())).await.is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string())).await;
                    break;
                }
            }
        }
    });
    let stderr_text = tokio::spawn(async move {
        let mut text = Vec::new();
        let _ = stderr.read_to_end(&mut text).await;
        String::from_utf8_lossy(&text).into_owned()
    })
    .map(|text| text.unwrap_or_default())
    .boxed();
    let stop = Arc::new(Notify::new());
    let waiter = stop.clone();
    let exited = tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status,
            () = waiter.notified() => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        match status {
            Ok(status) => exit_code(status),
            Err(_) => 1,
        }
    })
    .map(|code| code.unwrap_or(1))
    .boxed();
    let kill: Arc<dyn Fn() + Send + Sync> = Arc::new(move || stop.notify_one());
    Ok(StreamedProcess::new(receiver, exited, stderr_text, kill))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use roamgate_git::GitContext;
    use roamgate_git::exec::LocalRunner;

    use super::*;

    /// `git check-ignore --stdin` exits 128 at once outside a repository
    /// and never reads stdin: a payload past the pipe buffer must not take
    /// the server down.
    #[tokio::test]
    async fn does_not_leak_epipe_when_the_child_exits_before_reading_stdin() {
        let directory = tempfile::Builder::new()
            .prefix("roamgate-process-")
            .tempdir()
            .unwrap();
        let payload: String = (0..40000)
            .map(|index| format!("entry-{index}-{}\0", "padding".repeat(4)))
            .collect();
        let cx = GitContext::local(Arc::new(LocalRunner::system()));
        let ran = cx
            .run_input(
                Invocation::local([
                    "git",
                    "-C",
                    directory.path().to_str().unwrap(),
                    "check-ignore",
                    "-z",
                    "--stdin",
                ]),
                payload,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(ran.code, 128);
    }

    #[tokio::test]
    async fn streams_a_local_process_and_kills_it_on_request() {
        let mut proc =
            spawn_local(&["sh".into(), "-c".into(), "printf abc; sleep 30".into()]).unwrap();
        assert_eq!(proc.stdout.recv().await.unwrap().unwrap(), b"abc");
        proc.kill();
        let code = tokio::time::timeout(Duration::from_secs(5), proc.exited.clone())
            .await
            .unwrap();
        assert_ne!(code, 0);
    }
}
