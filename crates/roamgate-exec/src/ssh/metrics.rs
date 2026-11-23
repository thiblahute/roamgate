//! Debug accounting of ssh child processes (bridge/ssh-metrics.ts): the
//! live count, sshd's startup drops, and one log line per exit with the
//! caller's tag. The annotation rides on the [`SshCommand`] itself.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_base::clock::SharedClock;

use super::command::SshCommand;

// sshd drops connections beyond MaxStartups before the banner exchange; the
// client then reports one of these instead of an authentication error.
static STARTUP_FAILURE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:kex|ssh)_exchange_identification\b").unwrap());

/// The fields of one "ssh process exited" debug line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshExitReport {
    pub tag: String,
    pub connection: Option<String>,
    pub master: bool,
    pub host: Option<String>,
    /// None when the process's exit could not be read.
    pub code: Option<i32>,
    pub total_ms: i64,
    pub live_at_start: usize,
    pub live: usize,
    pub startup_failure: bool,
    pub startup_failures: usize,
}

impl SshExitReport {
    /// The fields in the order the log line has them, absent ones left out.
    pub fn fields(&self) -> Vec<(&'static str, String)> {
        let mut out = vec![("tag", self.tag.clone())];
        if let Some(connection) = &self.connection {
            out.push(("connection", connection.clone()));
        }
        if self.master {
            out.push(("master", "true".into()));
        }
        if let Some(host) = &self.host {
            out.push(("host", host.clone()));
        }
        out.push((
            "code",
            self.code
                .map_or_else(|| "null".to_owned(), |code| code.to_string()),
        ));
        out.push(("total_ms", self.total_ms.to_string()));
        out.push(("live_at_start", self.live_at_start.to_string()));
        out.push(("live", self.live.to_string()));
        if self.startup_failure {
            out.push(("startup_failure", "true".into()));
        }
        if self.startup_failures > 0 {
            out.push(("startup_failures", self.startup_failures.to_string()));
        }
        out
    }

    /// `key=value` pairs as the log line writes them.
    pub fn text(&self) -> String {
        self.fields()
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

type Report = dyn Fn(SshExitReport) + Send + Sync;

struct Inner {
    clock: SharedClock,
    live: AtomicUsize,
    startup_failures: AtomicUsize,
    report: Box<Report>,
}

/// Tracks ssh children: clones share the counts.
#[derive(Clone)]
pub struct SshProcessMonitor {
    inner: Arc<Inner>,
}

impl SshProcessMonitor {
    /// A monitor that hands each exit's report to `report`.
    pub fn new(clock: SharedClock, report: impl Fn(SshExitReport) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Inner {
                clock,
                live: AtomicUsize::new(0),
                startup_failures: AtomicUsize::new(0),
                report: Box::new(report),
            }),
        }
    }

    /// A monitor writing its reports as `ssh` debug lines.
    pub fn logging(clock: SharedClock) -> Self {
        Self::new(clock, |report| {
            tracing::debug!(target: "ssh", "ssh process exited {}", report.text());
        })
    }

    /// Accounts for one spawned process; argv that are not ssh are ignored,
    /// so runners can call this for everything. `stderr` is only scanned
    /// for startup drops: pass the caller's own read.
    pub fn track<X, S>(&self, command: &SshCommand, exited: X, stderr: Option<S>)
    where
        X: Future<Output = Result<i32, String>> + Send + 'static,
        S: Future<Output = Result<String, String>> + Send + 'static,
    {
        if command.argv.first().map(String::as_str) != Some("ssh") {
            return;
        }
        let inner = self.inner.clone();
        let started = inner.clock.monotonic();
        let live_at_start = inner.live.fetch_add(1, Ordering::SeqCst) + 1;
        let annotation = command.annotation.clone();
        let host = command
            .argv
            .iter()
            .position(|arg| arg == "--")
            .and_then(|at| command.argv.get(at + 1).cloned());
        tokio::spawn(async move {
            let stderr = async move {
                match stderr {
                    Some(stderr) => stderr.await.unwrap_or_default(),
                    None => String::new(),
                }
            };
            let (code, text) = tokio::join!(exited, stderr);
            let live = inner.live.fetch_sub(1, Ordering::SeqCst) - 1;
            let startup_failure = STARTUP_FAILURE.is_match(&text);
            let startup_failures = if startup_failure {
                inner.startup_failures.fetch_add(1, Ordering::SeqCst) + 1
            } else {
                inner.startup_failures.load(Ordering::SeqCst)
            };
            (inner.report)(SshExitReport {
                tag: annotation.tag.unwrap_or_else(|| "untagged".into()),
                connection: annotation.connection,
                master: annotation.master,
                host,
                code: code.ok(),
                total_ms: (inner.clock.monotonic() - started).round() as i64,
                live_at_start,
                live,
                startup_failure,
                startup_failures,
            });
        });
    }

    pub fn live_count(&self) -> usize {
        self.inner.live.load(Ordering::SeqCst)
    }

    pub fn startup_failure_count(&self) -> usize {
        self.inner.startup_failures.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;
    use crate::ssh::sessions::SshSessions;
    use roamgate_base::clock::TokioClock;
    use tokio::sync::oneshot;

    pub(crate) fn recording(clock: SharedClock) -> (SshProcessMonitor, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let monitor = SshProcessMonitor::new(clock, move |report| {
            sink.lock().unwrap().push(report.text());
        });
        (monitor, lines)
    }

    fn exit(code: Result<i32, String>) -> impl Future<Output = Result<i32, String>> {
        std::future::ready(code)
    }

    fn no_stderr() -> Option<std::future::Ready<Result<String, String>>> {
        None
    }

    fn stderr(text: &str) -> Option<std::future::Ready<Result<String, String>>> {
        Some(std::future::ready(Ok(text.to_owned())))
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn logs_tag_connection_host_exit_code_and_live_children() {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let sessions = SshSessions::new(clock.clone());
        let (monitor, lines) = recording(clock);
        let (first, first_exit) = oneshot::channel::<i32>();
        let (second, second_exit) = oneshot::channel::<i32>();
        let command = sessions
            .command_argv("desktop", "git status", &[], Some("git.status"))
            .unwrap()
            .for_connection("conn_1");
        monitor.track(
            &command,
            async { first_exit.await.map_err(|error| error.to_string()) },
            stderr(""),
        );
        monitor.track(
            &sessions.command_argv("desktop", "true", &[], None).unwrap(),
            async { second_exit.await.map_err(|error| error.to_string()) },
            no_stderr(),
        );
        assert_eq!(monitor.live_count(), 2);
        tokio::time::advance(Duration::from_millis(640)).await;
        first.send(0).unwrap();
        settle().await;
        assert_eq!(monitor.live_count(), 1);
        assert_eq!(
            *lines.lock().unwrap(),
            [
                "tag=git.status connection=conn_1 host=desktop code=0 total_ms=640 live_at_start=1 live=1"
            ]
        );
        second.send(255).unwrap();
        settle().await;
        assert_eq!(monitor.live_count(), 0);
        let second_line = lines.lock().unwrap()[1].clone();
        assert!(second_line.contains("tag=untagged"));
        assert!(second_line.contains("code=255 total_ms=640 live_at_start=2 live=0"));
    }

    #[tokio::test(start_paused = true)]
    async fn counts_sshd_startup_drops_reported_on_stderr() {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let sessions = SshSessions::new(clock.clone());
        let (monitor, lines) = recording(clock);
        let command = sessions.command_argv("desktop", "true", &[], None).unwrap();
        for text in [
            "kex_exchange_identification: read: Connection reset by peer\r\n",
            "ssh_exchange_identification: Connection closed",
            "Permission denied (publickey).",
        ] {
            monitor.track(&command, exit(Ok(255)), stderr(text));
            settle().await;
        }
        assert_eq!(monitor.startup_failure_count(), 2);
        let lines = lines.lock().unwrap();
        assert!(lines[0].contains("startup_failure=true startup_failures=1"));
        assert!(lines[1].contains("startup_failure=true startup_failures=2"));
        assert!(!lines[2].contains("startup_failure="));
        assert!(lines[2].contains("startup_failures=2"));
    }

    #[tokio::test(start_paused = true)]
    async fn ignores_other_programs_and_survives_failed_processes() {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let sessions = SshSessions::new(clock.clone());
        let (monitor, lines) = recording(clock);
        monitor.track(
            &SshCommand::plain(vec!["git".into(), "status".into()]),
            exit(Ok(0)),
            no_stderr(),
        );
        assert_eq!(monitor.live_count(), 0);
        monitor.track(
            &sessions.command_argv("desktop", "true", &[], None).unwrap(),
            exit(Err("spawn failed".into())),
            Some(std::future::ready(Err("stream failed".to_owned()))),
        );
        settle().await;
        assert_eq!(monitor.live_count(), 0);
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("code=null"));
    }

    #[tokio::test(start_paused = true)]
    async fn tags_follow_the_command_not_copies_of_its_argv() {
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let sessions = SshSessions::new(clock.clone());
        let (monitor, lines) = recording(clock);
        let command = sessions
            .command_argv("desktop", "git status", &[], Some("git.status"))
            .unwrap();
        monitor.track(&command, exit(Ok(0)), no_stderr());
        settle().await;
        monitor.track(
            &SshCommand::plain(command.argv.clone()),
            exit(Ok(0)),
            no_stderr(),
        );
        settle().await;
        let lines = lines.lock().unwrap();
        assert!(lines[0].contains("tag=git.status"));
        assert!(lines[1].contains("tag=untagged"));
    }
}
