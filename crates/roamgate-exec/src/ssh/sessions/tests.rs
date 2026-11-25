//! The cases of bridge/ssh-sessions.test.ts, on tokio's paused time.

use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use super::*;
use crate::ssh::metrics::tests::recording;
use roamgate_base::clock::TokioClock;
use tempfile::TempDir;

pub(crate) const REFUSED: &str =
    "mux_client_request_session: session request failed: Session open refused by peer";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Out {
    pub code: i32,
    pub stderr: String,
}

impl SshOutput for Out {
    fn code(&self) -> i32 {
        self.code
    }
    fn stderr(&self) -> &str {
        &self.stderr
    }
    fn set_stderr(&mut self, stderr: String) {
        self.stderr = stderr;
    }
}

pub(crate) fn out(code: i32, stderr: &str) -> Out {
    Out {
        code,
        stderr: stderr.to_owned(),
    }
}

type Result<T> = std::result::Result<T, SessionError>;

pub(crate) fn sessions() -> SshSessions {
    SshSessions::with_platform(Arc::new(TokioClock::starting_at(1_000_000)), false)
}

/// Lets ready tasks run.
pub(crate) async fn flush() {
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
}

pub(crate) async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    flush().await;
}

/// A registered master whose control socket exists on disk.
pub(crate) struct FakeMaster {
    pub owner: MasterOwner,
    pub control_path: String,
    _directory: TempDir,
}

pub(crate) fn fake_master_with(
    sessions: &SshSessions,
    destination: &str,
    alive: Arc<AtomicBool>,
) -> FakeMaster {
    let directory = tempfile::Builder::new()
        .prefix("rg-sessions-test-")
        .tempdir_in(roamgate_base::paths::short_temp_root())
        .unwrap();
    let control_path = directory.path().join("m.ctl");
    std::fs::write(&control_path, "").unwrap();
    let control_path = control_path.to_string_lossy().into_owned();
    let owner = sessions.new_owner();
    let listening = control_path.clone();
    sessions.register_master(
        owner,
        MasterRegistration {
            destination: destination.into(),
            control_path: control_path.clone(),
            is_listening: Arc::new(move || std::path::Path::new(&listening).exists()),
            is_alive: Arc::new(move || {
                let alive = alive.load(Ordering::SeqCst);
                Box::pin(async move { alive })
            }),
            recycle: None,
        },
    );
    FakeMaster {
        owner,
        control_path,
        _directory: directory,
    }
}

pub(crate) fn fake_master(sessions: &SshSessions, destination: &str) -> FakeMaster {
    fake_master_with(sessions, destination, Arc::new(AtomicBool::new(true)))
}

fn cmd(sessions: &SshSessions, destination: &str, command: &str) -> SshCommand {
    sessions
        .command_argv(destination, command, &[], None)
        .unwrap()
}

fn read(sessions: &SshSessions, destination: &str, command: &str) -> SshCommand {
    sessions
        .read_command_argv(destination, command, &[], None)
        .unwrap()
}

fn tail(argv: &[String]) -> Vec<String> {
    argv[argv.len() - 3..].to_vec()
}

fn strs(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

async fn fill(sessions: &SshSessions, destination: &str) -> Vec<SessionSlot> {
    let mut held = Vec::new();
    for _ in 0..SSH_SESSION_LIMIT {
        held.push(
            sessions
                .acquire(destination, &SshSessionWait::default(), None)
                .await
                .unwrap(),
        );
    }
    held
}

type Runs = Arc<Mutex<Vec<Vec<String>>>>;

fn runs() -> Runs {
    Arc::new(Mutex::new(Vec::new()))
}

// SSH command routing over a runtime master.

#[tokio::test(start_paused = true)]
async fn builds_a_cold_login_when_no_master_is_ready() {
    let sessions = sessions();
    let command = cmd(&sessions, "dev-box", "true");
    assert!(!command.contains("-S"));
    assert!(command.contains("ControlPath=none"));
    assert_eq!(tail(&command.argv), strs(&["--", "dev-box", "true"]));
}

#[tokio::test(start_paused = true)]
async fn multiplexes_over_the_ready_master_with_s_ahead_of_the_policy() {
    let sessions = sessions();
    let master = fake_master(&sessions, "dev-box");
    let command = cmd(&sessions, "dev-box", "true");
    // -S must override ControlPath=none; a later -o ControlPath would not.
    assert_eq!(
        command.argv[..3],
        strs(&["ssh", "-S", &master.control_path])
    );
    assert!(command.contains("ControlMaster=no"));
    assert_eq!(tail(&command.argv), strs(&["--", "dev-box", "true"]));
    assert!(!cmd(&sessions, "other-box", "true").contains("-S"));
}

#[tokio::test(start_paused = true)]
async fn keeps_masters_per_runtime_when_two_runtimes_reach_one_host() {
    let sessions = sessions();
    let first = fake_master(&sessions, "dev-box");
    let second = fake_master(&sessions, "dev-box");
    assert_eq!(
        cmd(&sessions, "dev-box", "true").argv[2],
        first.control_path
    );
    sessions.unregister_master(first.owner);
    assert_eq!(
        cmd(&sessions, "dev-box", "true").argv[2],
        second.control_path
    );
    sessions.unregister_master(second.owner);
    assert!(!cmd(&sessions, "dev-box", "true").contains("-S"));
}

#[tokio::test(start_paused = true)]
async fn falls_back_to_a_cold_login_when_the_control_socket_is_missing() {
    let sessions = sessions();
    let master = fake_master(&sessions, "dev-box");
    std::fs::remove_file(&master.control_path).unwrap();
    assert!(!cmd(&sessions, "dev-box", "true").contains("-S"));
}

// SSH command execution.

#[tokio::test(start_paused = true)]
async fn retries_a_read_once_cold_when_the_master_died_under_it() {
    let sessions = sessions();
    let alive = Arc::new(AtomicBool::new(true));
    let _master = fake_master_with(&sessions, "dev-box", alive.clone());
    let command = read(&sessions, "dev-box", "git status");
    let runs = runs();
    let seen = runs.clone();
    let result: Result<Out> = sessions
        .run(
            &command,
            |attempt, _| {
                let mut seen = seen.lock().unwrap();
                seen.push(attempt.argv);
                let first = seen.len() == 1;
                if first {
                    alive.store(false, Ordering::SeqCst);
                }
                async move { Ok(if first { out(255, "") } else { out(0, "") }) }
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(result.unwrap().code, 0);
    let runs = runs.lock().unwrap();
    assert_eq!(runs.len(), 2);
    assert!(runs[0].contains(&"-S".to_owned()));
    assert!(!runs[1].contains(&"-S".to_owned()));
    assert_eq!(tail(&runs[1]), strs(&["--", "dev-box", "git status"]));
}

#[tokio::test(start_paused = true)]
async fn logs_the_multiplexed_run_and_its_cold_retry_under_one_tag() {
    let sessions = sessions();
    let (monitor, lines) = recording(sessions.clock().clone());
    let alive = Arc::new(AtomicBool::new(true));
    let _master = fake_master_with(&sessions, "dev-box", alive.clone());
    let command = sessions
        .read_command_argv("dev-box", "true", &[], Some("files.read"))
        .unwrap();
    let _: Result<Out> = sessions
        .run(
            &command,
            |attempt, _| {
                let code = if attempt.contains("-S") { 255 } else { 0 };
                monitor.track(
                    &attempt,
                    std::future::ready(Ok(code)),
                    None::<std::future::Ready<std::result::Result<String, String>>>,
                );
                alive.store(false, Ordering::SeqCst);
                async move {
                    flush().await;
                    Ok(out(code, ""))
                }
            },
            &SshSessionWait::default(),
        )
        .await;
    flush().await;
    let lines = lines.lock().unwrap();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("tag=files.read"));
    assert!(lines[0].contains("master=true"));
    assert!(lines[1].contains("tag=files.read"));
    assert!(!lines[1].contains("master="));
}

#[tokio::test(start_paused = true)]
async fn reports_a_dead_masters_255_for_commands_that_are_not_reads() {
    let sessions = sessions();
    let alive = Arc::new(AtomicBool::new(true));
    let _master = fake_master_with(&sessions, "dev-box", alive.clone());
    let command = cmd(&sessions, "dev-box", "git worktree add ../next");
    assert!(command.contains("-S"));
    let count = AtomicUsize::new(0);
    let result: Result<Out> = sessions
        .run(
            &command,
            |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                alive.store(false, Ordering::SeqCst);
                async { Ok(out(255, "")) }
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(result.unwrap().code, 255);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn returns_the_cold_retrys_failure_without_a_second_retry() {
    let sessions = sessions();
    let _master = fake_master_with(&sessions, "dev-box", Arc::new(AtomicBool::new(false)));
    let command = read(&sessions, "dev-box", "true");
    let count = AtomicUsize::new(0);
    let result: Result<Out> = sessions
        .run(
            &command,
            |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                async { Ok(out(255, "")) }
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(result.unwrap().code, 255);
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test(start_paused = true)]
async fn does_not_retry_command_failures_while_the_master_is_alive() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "dev-box");
    let command = read(&sessions, "dev-box", "exit 255");
    let count = AtomicUsize::new(0);
    for code in [255, 1, 0] {
        let _: Result<Out> = sessions
            .run(
                &command,
                |_, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                    async move { Ok(out(code, "")) }
                },
                &SshSessionWait::default(),
            )
            .await;
    }
    assert_eq!(count.load(Ordering::SeqCst), 3);
}

#[tokio::test(start_paused = true)]
async fn does_not_retry_when_openssh_already_fell_back_to_its_own_login() {
    // Only where a multiplexed command may still log in on its own: on
    // Windows, whose OpenSSH has no POSIX `false` for ProxyCommand.
    let sessions = SshSessions::with_platform(Arc::new(TokioClock::starting_at(0)), true);
    let _master = fake_master_with(&sessions, "dev-box", Arc::new(AtomicBool::new(false)));
    let command = read(&sessions, "dev-box", "true");
    for stderr in [
        "mux_client_request_session: session request failed: Session open refused by peer\nssh: connect to host dev-box port 22: Connection refused",
        "Control socket connect(/tmp/x/m.ctl): Connection refused\nssh: connect to host dev-box port 22: Connection refused",
    ] {
        let count = AtomicUsize::new(0);
        let _: Result<Out> = sessions
            .run(
                &command,
                |_, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                    async move { Ok(out(255, stderr)) }
                },
                &SshSessionWait::default(),
            )
            .await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn runs_over_the_master_without_openssh_own_fallback_login() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "muxonly-box");
    let command = cmd(&sessions, "muxonly-box", "true");
    let runs = runs();
    let seen = runs.clone();
    let _: Result<Out> = sessions
        .run(
            &command,
            |attempt, _| {
                seen.lock().unwrap().push(attempt.argv);
                async { Ok(out(0, "")) }
            },
            &SshSessionWait::default(),
        )
        .await;
    let runs = runs.lock().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0][..3], command.argv[..3]);
    // Given ahead of the user's config, so it wins over theirs.
    assert_eq!(runs[0][3..5], strs(&["-o", "ProxyCommand=false"]));
    assert_eq!(tail(&runs[0]), tail(&command.argv));
    // Callers that spawn the argv themselves keep OpenSSH's fallback.
    assert!(!command.contains("ProxyCommand=false"));
}

#[tokio::test(start_paused = true)]
async fn runs_a_command_whose_master_socket_is_gone_on_its_own_connection() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "gone-box");
    let command = cmd(&sessions, "gone-box", "git worktree add ../next");
    let runs = runs();
    let seen = runs.clone();
    let result: Result<Out> = sessions
        .run(
            &command,
            |attempt, _| {
                let mut seen = seen.lock().unwrap();
                seen.push(attempt.argv);
                let first = seen.len() == 1;
                async move {
                    Ok(if first {
                        out(
                            255,
                            "Control socket connect(/tmp/x/m.ctl): No such file or directory\nkex_exchange_identification: Connection closed by remote host\nConnection closed by UNKNOWN port 65535",
                        )
                    } else {
                        out(0, "")
                    })
                }
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(result.unwrap(), out(0, ""));
    let runs = runs.lock().unwrap();
    assert_eq!(runs.len(), 2);
    assert!(!runs[1].contains(&"-S".to_owned()));
}

/// A run function answering `answer(run number, argv)`.
fn scripted(
    runs: &Runs,
    answer: impl Fn(usize, &[String]) -> Out + Send + Sync + 'static,
) -> impl FnMut(SshCommand, Option<u64>) -> std::future::Ready<Result<Out>> + Send + 'static {
    let runs = runs.clone();
    move |attempt, _| {
        let mut runs = runs.lock().unwrap();
        runs.push(attempt.argv.clone());
        std::future::ready(Ok(answer(runs.len(), &attempt.argv)))
    }
}

#[tokio::test(start_paused = true)]
async fn retries_a_refused_session_over_the_master_after_a_short_wait() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "refuse-box");
    let command = cmd(&sessions, "refuse-box", "touch made");
    let runs = runs();
    let run = scripted(&runs, |index, _| {
        if index < 3 {
            out(255, REFUSED)
        } else {
            out(0, "warning: kept\n")
        }
    });
    let task = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .run(&command, run, &SshSessionWait::default())
                .await
        })
    };
    flush().await;
    assert_eq!(runs.lock().unwrap().len(), 1);
    advance(SSH_REFUSED_RETRY_DELAYS_MS[0]).await;
    assert_eq!(runs.lock().unwrap().len(), 2);
    advance(SSH_REFUSED_RETRY_DELAYS_MS[1]).await;
    assert_eq!(task.await.unwrap().unwrap(), out(0, "warning: kept\n"));
    let runs = runs.lock().unwrap();
    assert_eq!(runs.len(), 3);
    for run in runs.iter() {
        assert!(run.contains(&"ProxyCommand=false".to_owned()));
    }
}

#[tokio::test(start_paused = true)]
async fn runs_a_session_refused_every_time_on_its_own_connection_at_last() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "always-refused-box");
    let command = cmd(&sessions, "always-refused-box", "true");
    let runs = runs();
    let run = scripted(&runs, |_, argv| {
        if argv.iter().any(|arg| arg == "-S") {
            out(255, REFUSED)
        } else {
            out(1, &format!("{REFUSED}\nnot found: x\n"))
        }
    });
    let task = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .run(&command, run, &SshSessionWait::default())
                .await
        })
    };
    for delay in SSH_REFUSED_RETRY_DELAYS_MS {
        flush().await;
        advance(delay).await;
    }
    let result = task.await.unwrap().unwrap();
    let runs = runs.lock().unwrap();
    assert_eq!(runs.len(), SSH_REFUSED_RETRY_DELAYS_MS.len() + 2);
    assert!(!runs.last().unwrap().contains(&"-S".to_owned()));
    // The command's own error, not OpenSSH's line about the master.
    assert_eq!(result, out(1, "not found: x\n"));
}

#[tokio::test(start_paused = true)]
async fn gives_no_new_slot_for_a_while_after_a_refusal() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "cooldown-box");
    let wait = SshSessionWait::default();
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(sessions.acquire("cooldown-box", &wait, None).await.unwrap());
    }
    let runs = runs();
    let run = scripted(&runs, |index, _| {
        if index == 1 {
            out(255, REFUSED)
        } else {
            out(0, "")
        }
    });
    let refused = {
        let sessions = sessions.clone();
        let command = cmd(&sessions, "cooldown-box", "true");
        tokio::spawn(async move {
            sessions
                .run(&command, run, &SshSessionWait::default())
                .await
        })
    };
    flush().await;
    // Four in use when the host refused: no fifth until they drop to three.
    let next = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("cooldown-box", &SshSessionWait::default(), None)
                .await
        })
    };
    flush().await;
    assert!(!next.is_finished());
    held.remove(0).release();
    flush().await;
    assert!(!next.is_finished());
    held.remove(0).release();
    flush().await;
    assert!(next.is_finished());
    advance(SSH_REFUSED_RETRY_DELAYS_MS[0]).await;
    refused.await.unwrap().unwrap();
    next.await.unwrap().unwrap().release();
    held.remove(0).release();
    // Past the cooldown every slot is given again.
    advance(SSH_REFUSED_COOLDOWN_MS as u64).await;
    let all = fill(&sessions, "cooldown-box").await;
    assert_eq!(all.len(), SSH_SESSION_LIMIT);
}

#[tokio::test(start_paused = true)]
async fn recycles_a_master_only_while_its_host_serves_no_session_at_all() {
    let sessions = sessions();
    let master = fake_master(&sessions, "streak-box");
    let recycles = Arc::new(AtomicUsize::new(0));
    let counted = recycles.clone();
    let listening = master.control_path.clone();
    sessions.register_master(
        master.owner,
        MasterRegistration {
            destination: "streak-box".into(),
            control_path: master.control_path.clone(),
            is_listening: Arc::new(move || std::path::Path::new(&listening).exists()),
            is_alive: Arc::new(|| Box::pin(async { true })),
            recycle: Some(Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            })),
        },
    );
    let serve = Arc::new(AtomicBool::new(false));
    let command = || {
        let sessions = sessions.clone();
        let serve = serve.clone();
        async move {
            let argv = read(&sessions, "streak-box", "true");
            let task = tokio::spawn({
                let sessions = sessions.clone();
                async move {
                    sessions
                        .run(
                            &argv,
                            move |attempt, _| {
                                let refused =
                                    attempt.contains("-S") && !serve.load(Ordering::SeqCst);
                                std::future::ready(Ok::<_, SessionError>(if refused {
                                    out(255, REFUSED)
                                } else {
                                    out(0, "")
                                }))
                            },
                            &SshSessionWait::default(),
                        )
                        .await
                }
            });
            while !task.is_finished() {
                advance(100).await;
            }
            task.await.unwrap().unwrap()
        }
    };
    // Refused, then a session served: the host is busy, not broken.
    command().await;
    advance(SSH_MASTER_RECYCLE_AFTER_MS as u64).await;
    serve.store(true, Ordering::SeqCst);
    command().await;
    serve.store(false, Ordering::SeqCst);
    command().await;
    assert_eq!(recycles.load(Ordering::SeqCst), 0);
    // Refused again past the threshold, with nothing served between.
    advance(SSH_MASTER_RECYCLE_AFTER_MS as u64).await;
    command().await;
    assert_eq!(recycles.load(Ordering::SeqCst), 1);
    // Not again right away, even while the host keeps refusing.
    advance(SSH_MASTER_RECYCLE_AFTER_MS as u64).await;
    command().await;
    command().await;
    assert_eq!(recycles.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn passes_commands_without_a_route_straight_through() {
    let sessions = sessions();
    let count = AtomicUsize::new(0);
    let plain = SshCommand::plain(strs(&["git", "status"]));
    let result: Result<Out> = sessions
        .run(
            &plain,
            |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                async { Ok(out(255, "")) }
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(result.unwrap().code, 255);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let hold = sessions
        .hold(&plain, &SshSessionWait::default(), false)
        .await
        .unwrap();
    assert_eq!(hold.command.argv, plain.argv);
    hold.release();
}

#[tokio::test(start_paused = true)]
async fn bounds_concurrent_sessions_per_destination_cold_or_multiplexed() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "dev-box");
    let gates: Arc<Mutex<Vec<Option<oneshot::Sender<()>>>>> = Arc::default();
    let started = Arc::new(AtomicUsize::new(0));
    let spawn_run = |destination: &str| {
        let sessions = sessions.clone();
        let command = cmd(&sessions, destination, "sleep");
        let gates = gates.clone();
        let started = started.clone();
        tokio::spawn(async move {
            sessions
                .run(
                    &command,
                    move |_, _| {
                        started.fetch_add(1, Ordering::SeqCst);
                        let (tx, rx) = oneshot::channel();
                        gates.lock().unwrap().push(Some(tx));
                        async move {
                            let _ = rx.await;
                            Ok::<_, SessionError>(out(0, ""))
                        }
                    },
                    &SshSessionWait::default(),
                )
                .await
        })
    };
    let open = |index: usize| {
        if let Some(gate) = gates.lock().unwrap()[index].take() {
            let _ = gate.send(());
        }
    };
    let mut tasks: Vec<_> = (0..SSH_SESSION_LIMIT + 2)
        .map(|_| spawn_run("dev-box"))
        .collect();
    flush().await;
    // A cold destination has its own budget.
    tasks.push(spawn_run("other-box"));
    flush().await;
    assert_eq!(started.load(Ordering::SeqCst), SSH_SESSION_LIMIT + 1);
    // A held stream slot counts against the same budget.
    let streamed = {
        let sessions = sessions.clone();
        let command = cmd(&sessions, "dev-box", "upload");
        tokio::spawn(async move {
            sessions
                .hold(&command, &SshSessionWait::default(), false)
                .await
        })
    };
    flush().await;
    open(0);
    flush().await;
    assert_eq!(started.load(Ordering::SeqCst), SSH_SESSION_LIMIT + 2);
    open(1);
    flush().await;
    assert_eq!(started.load(Ordering::SeqCst), SSH_SESSION_LIMIT + 3);
    assert!(!streamed.is_finished());
    open(2);
    let hold = streamed.await.unwrap().unwrap();
    hold.release();
    hold.release();
    for _ in 0..2 {
        let count = gates.lock().unwrap().len();
        for index in 0..count {
            open(index);
        }
        flush().await;
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(started.load(Ordering::SeqCst), SSH_SESSION_LIMIT + 3);
}

#[tokio::test(start_paused = true)]
async fn an_aborted_wait_gives_up_without_taking_a_slot() {
    let sessions = sessions();
    let mut held = fill(&sessions, "abort-box").await;
    let controller = AbortController::new();
    let waiting = {
        let sessions = sessions.clone();
        let wait = SshSessionWait::signal(controller.signal());
        tokio::spawn(async move { sessions.acquire("abort-box", &wait, None).await.map(|_| ()) })
    };
    flush().await;
    let after = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("abort-box", &SshSessionWait::default(), None)
                .await
        })
    };
    flush().await;
    controller.abort("gave up");
    assert_eq!(
        waiting.await.unwrap(),
        Err(SessionError::Aborted("gave up".into()))
    );
    // The freed slot goes to the next waiter, not to the one that gave up.
    held.remove(0).release();
    after.await.unwrap().unwrap().release();
    drop(held);
    let aborted = sessions
        .acquire(
            "abort-box",
            &SshSessionWait::signal(AbortSignal::aborted("no")),
            None,
        )
        .await;
    assert!(aborted.is_err());
}

// SSH session wait.

#[tokio::test(start_paused = true)]
async fn gives_up_at_the_callers_timeout_and_leaves_the_line() {
    let sessions = sessions();
    let mut held = fill(&sessions, "wait-box").await;
    let waiting = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("wait-box", &SshSessionWait::timeout(1000), None)
                .await
                .map(|_| ())
        })
    };
    flush().await;
    advance(999).await;
    assert!(!waiting.is_finished());
    advance(1).await;
    assert_eq!(
        waiting.await.unwrap().err().unwrap().to_string(),
        "ssh timed out after 1000ms waiting for a session to wait-box"
    );
    // The slot freed later goes to a live waiter, not the expired one.
    let next = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("wait-box", &SshSessionWait::timeout(1000), None)
                .await
        })
    };
    flush().await;
    held.remove(0).release();
    next.await.unwrap().unwrap().release();
}

#[tokio::test(start_paused = true)]
async fn waits_ssh_session_default_wait_ms_without_a_timeout() {
    let sessions = sessions();
    let _held = fill(&sessions, "default-box").await;
    let waiting = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("default-box", &SshSessionWait::default(), None)
                .await
                .map(|_| ())
        })
    };
    flush().await;
    advance(SSH_SESSION_DEFAULT_WAIT_MS).await;
    let error = waiting.await.unwrap().err().unwrap().to_string();
    assert!(error.contains(&format!("after {SSH_SESSION_DEFAULT_WAIT_MS}ms")));
}

#[tokio::test(start_paused = true)]
async fn stops_waiting_when_the_callers_signal_aborts() {
    let sessions = sessions();
    let _held = fill(&sessions, "abort-box").await;
    let controller = AbortController::new();
    let waiting = {
        let sessions = sessions.clone();
        let wait = SshSessionWait::signal(controller.signal());
        tokio::spawn(async move { sessions.acquire("abort-box", &wait, None).await.map(|_| ()) })
    };
    flush().await;
    controller.abort("request gone");
    assert_eq!(
        waiting.await.unwrap().err().unwrap().to_string(),
        "request gone"
    );
    let again = sessions
        .acquire(
            "abort-box",
            &SshSessionWait::signal(controller.signal()),
            None,
        )
        .await;
    assert_eq!(again.err().unwrap().to_string(), "request gone");
}

#[tokio::test(start_paused = true)]
async fn refuses_a_command_once_the_line_is_full() {
    let sessions = sessions();
    let _held = fill(&sessions, "busy-box").await;
    let queued: Vec<_> = (0..SSH_SESSION_WAITER_LIMIT)
        .map(|_| {
            let sessions = sessions.clone();
            tokio::spawn(async move {
                sessions
                    .acquire("busy-box", &SshSessionWait::timeout(1000), None)
                    .await
                    .map(|_| ())
            })
        })
        .collect();
    flush().await;
    let refused = sessions
        .acquire("busy-box", &SshSessionWait::default(), None)
        .await;
    assert_eq!(
        refused.err().unwrap().to_string(),
        format!("ssh: {SSH_SESSION_WAITER_LIMIT} commands already waiting for busy-box")
    );
    advance(1000).await;
    for waiter in queued {
        assert!(waiter.await.unwrap().is_err());
    }
}

#[tokio::test(start_paused = true)]
async fn counts_the_wait_against_the_commands_timeout() {
    let sessions = sessions();
    let mut held = fill(&sessions, "budget-box").await;
    let budgets: Arc<Mutex<Vec<Option<u64>>>> = Arc::default();
    let running = {
        let sessions = sessions.clone();
        let budgets = budgets.clone();
        let command = cmd(&sessions, "budget-box", "true");
        tokio::spawn(async move {
            sessions
                .run(
                    &command,
                    move |_, remaining| {
                        budgets.lock().unwrap().push(remaining);
                        std::future::ready(Ok::<_, SessionError>(out(0, "")))
                    },
                    &SshSessionWait::timeout(1000),
                )
                .await
        })
    };
    flush().await;
    advance(400).await;
    held.remove(0).release();
    running.await.unwrap().unwrap();
    assert_eq!(*budgets.lock().unwrap(), [Some(600)]);

    // Full again, so the upload's hold has to wait too.
    held.push(
        sessions
            .acquire("budget-box", &SshSessionWait::default(), None)
            .await
            .unwrap(),
    );
    let hold = {
        let sessions = sessions.clone();
        let command = cmd(&sessions, "budget-box", "upload");
        tokio::spawn(async move {
            sessions
                .hold(&command, &SshSessionWait::timeout(1000), false)
                .await
        })
    };
    flush().await;
    advance(250).await;
    held.remove(0).release();
    let hold = hold.await.unwrap().unwrap();
    assert_eq!(hold.remaining_ms, Some(750));
}

#[tokio::test(start_paused = true)]
async fn an_abort_after_a_queued_slot_is_granted_still_prevents_command_dispatch() {
    let sessions = sessions();
    let destination = "grant-abort-box";
    let mut held = fill(&sessions, destination).await;
    let controller = AbortController::new();
    let dispatched = Arc::new(AtomicBool::new(false));
    let pending = {
        let sessions = sessions.clone();
        let command = cmd(&sessions, destination, "write-operation");
        let dispatched = dispatched.clone();
        let wait = SshSessionWait::signal(controller.signal());
        tokio::spawn(async move {
            sessions
                .run(
                    &command,
                    move |_, _| {
                        dispatched.store(true, Ordering::SeqCst);
                        std::future::ready(Ok::<_, SessionError>(out(0, "")))
                    },
                    &wait,
                )
                .await
        })
    };
    flush().await;
    held.remove(0).release();
    controller.abort("request cancelled");
    assert_eq!(
        pending.await.unwrap().err().unwrap().to_string(),
        "request cancelled"
    );
    assert!(!dispatched.load(Ordering::SeqCst));
    drop(held);
    let after = fill(&sessions, destination).await;
    assert_eq!(after.len(), SSH_SESSION_LIMIT);
}

// SSH session lanes.

#[tokio::test(start_paused = true)]
async fn work_is_interactive_unless_it_runs_in_the_background_lane() {
    assert_eq!(current_lane(), Lane::Interactive);
    let seen = run_in_lane(Lane::Background, async {
        tokio::task::yield_now().await;
        current_lane()
    })
    .await;
    assert_eq!(seen, Lane::Background);
    assert_eq!(current_lane(), Lane::Interactive);
}

#[tokio::test(start_paused = true)]
async fn background_work_keeps_slots_free_for_interactive_work() {
    let sessions = sessions();
    let wait = SshSessionWait::default();
    let mut background = Vec::new();
    for _ in 0..SSH_BACKGROUND_SESSION_LIMIT {
        background.push(
            sessions
                .acquire("lane-box", &wait, Some(Lane::Background))
                .await
                .unwrap(),
        );
    }
    let more = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire(
                    "lane-box",
                    &SshSessionWait::default(),
                    Some(Lane::Background),
                )
                .await
        })
    };
    flush().await;
    assert!(!more.is_finished());
    // Every slot background work may not take is still there for the user.
    let mut interactive = Vec::new();
    for _ in 0..SSH_SESSION_LIMIT - SSH_BACKGROUND_SESSION_LIMIT {
        interactive.push(sessions.acquire("lane-box", &wait, None).await.unwrap());
    }
    background.remove(0).release();
    more.await.unwrap().unwrap().release();
}

#[tokio::test(start_paused = true)]
async fn a_full_background_queue_never_delays_an_interactive_command() {
    let sessions = sessions();
    let wait = SshSessionWait::default();
    let mut held = Vec::new();
    for index in 0..SSH_SESSION_LIMIT {
        let lane = if index < SSH_BACKGROUND_SESSION_LIMIT {
            Lane::Background
        } else {
            Lane::Interactive
        };
        held.push(
            sessions
                .acquire("queue-box", &wait, Some(lane))
                .await
                .unwrap(),
        );
    }
    let backlog: Vec<_> = (0..SSH_BACKGROUND_WAITER_LIMIT)
        .map(|_| {
            let sessions = sessions.clone();
            tokio::spawn(async move {
                sessions
                    .acquire(
                        "queue-box",
                        &SshSessionWait::timeout(60_000),
                        Some(Lane::Background),
                    )
                    .await
                    .map(|_| ())
            })
        })
        .collect();
    flush().await;
    let interactive = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("queue-box", &SshSessionWait::timeout(60_000), None)
                .await
        })
    };
    flush().await;
    // The first slot freed goes to the interactive command, ahead of the
    // whole background line.
    held.remove(0).release();
    flush().await;
    assert!(interactive.is_finished());
    interactive.await.unwrap().unwrap().release();
    advance(60_000).await;
    for waiter in backlog {
        let _ = waiter.await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn sheds_background_work_quietly_once_its_line_is_full() {
    let sessions = sessions();
    let _held = fill(&sessions, "shed-box").await;
    let backlog: Vec<_> = (0..SSH_BACKGROUND_WAITER_LIMIT)
        .map(|_| {
            let sessions = sessions.clone();
            tokio::spawn(async move {
                sessions
                    .acquire(
                        "shed-box",
                        &SshSessionWait::timeout(1000),
                        Some(Lane::Background),
                    )
                    .await
                    .map(|_| ())
            })
        })
        .collect();
    flush().await;
    let wait = SshSessionWait::default();
    let shed = run_in_lane(Lane::Background, sessions.acquire("shed-box", &wait, None)).await;
    assert!(shed.err().unwrap().is_background_shed());
    // Interactive commands have a line of their own.
    let interactive = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire("shed-box", &SshSessionWait::timeout(1000), None)
                .await
                .map(|_| ())
        })
    };
    flush().await;
    advance(1000).await;
    assert!(matches!(
        interactive.await.unwrap(),
        Err(SessionError::WaitTimeout { .. })
    ));
    for waiter in backlog {
        let _ = waiter.await.unwrap();
    }
}

// Long-lived SSH sessions.

#[tokio::test(start_paused = true)]
async fn long_lived_sessions_take_a_few_master_slots_then_connections_of_their_own() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "stream-box");
    let mut holds = Vec::new();
    for index in 0..SSH_STREAM_SESSION_LIMIT + 1 {
        let command = read(&sessions, "stream-box", &format!("watch {index}"));
        let hold = sessions
            .hold(&command, &SshSessionWait::default(), true)
            .await
            .unwrap();
        holds.push((command, hold));
    }
    for (command, hold) in &holds[..SSH_STREAM_SESSION_LIMIT] {
        assert_eq!(hold.command.argv, command.argv);
    }
    let (command, extra) = holds.last().unwrap();
    assert!(!extra.command.contains("-S"));
    assert_eq!(tail(&extra.command.argv), tail(&command.argv));
    // Short commands still get every slot the streams left.
    let mut short = Vec::new();
    for _ in 0..SSH_SESSION_LIMIT - SSH_STREAM_SESSION_LIMIT {
        short.push(
            sessions
                .acquire("stream-box", &SshSessionWait::timeout(50), None)
                .await
                .unwrap(),
        );
    }
    let late = sessions
        .acquire("stream-box", &SshSessionWait::timeout(1), None)
        .await;
    assert!(late.err().unwrap().to_string().contains("timed out"));
    holds[0].1.release();
    holds[0].1.release();
    sessions
        .acquire("stream-box", &SshSessionWait::timeout(50), None)
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn long_lived_sessions_never_wait_behind_short_commands() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "busy-box");
    let _short = fill(&sessions, "busy-box").await;
    let command = read(&sessions, "busy-box", "watch");
    let hold = sessions
        .hold(&command, &SshSessionWait::default(), true)
        .await
        .unwrap();
    assert!(!hold.command.contains("-S"));
}

#[test]
fn without_mux_noise_keeps_the_commands_own_lines() {
    assert_eq!(without_mux_noise("plain\n"), "plain\n");
    assert_eq!(
        without_mux_noise(&format!(
            "not found: /a/b\n{REFUSED}\nControl socket connect(/x): Connection refused\n"
        )),
        "not found: /a/b\n"
    );
}

// Remote deadlines.

#[tokio::test(start_paused = true)]
async fn a_hung_remote_command_frees_its_slot_and_the_hosts_later() {
    let sessions = sessions();
    let destination = "hung-box";
    let _master = fake_master(&sessions, destination);
    let mut held = Vec::new();
    for _ in 0..SSH_SESSION_LIMIT - 1 {
        held.push(
            sessions
                .acquire(destination, &SshSessionWait::default(), None)
                .await
                .unwrap(),
        );
    }
    let ran: Arc<Mutex<Vec<String>>> = Arc::default();
    // As the process runner does: the client is killed at the deadline and
    // the run fails, while the command still runs on the host.
    let hung = {
        let sessions = sessions.clone();
        let command = read(&sessions, destination, "glab auth status");
        let ran = ran.clone();
        let clock = sessions.clock().clone();
        tokio::spawn(async move {
            sessions
                .run(
                    &command,
                    move |attempt, remaining| {
                        *ran.lock().unwrap() = attempt.argv;
                        let sleep = clock.sleep(Duration::from_millis(remaining.unwrap()));
                        async move {
                            sleep.await;
                            Err::<Out, _>(SessionError::Timeout(1000))
                        }
                    },
                    &SshSessionWait::timeout(1000),
                )
                .await
        })
    };
    flush().await;
    assert_eq!(
        ran.lock().unwrap().last().unwrap(),
        &with_remote_deadline("glab auth status", (1 + SSH_REMOTE_GRACE_S) as f64)
    );
    let next = {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            sessions
                .acquire(destination, &SshSessionWait::default(), None)
                .await
        })
    };
    flush().await;
    assert!(!next.is_finished());
    advance(1000).await;
    assert!(
        hung.await
            .unwrap()
            .err()
            .unwrap()
            .to_string()
            .contains("timed out")
    );
    // Free here, but the host counts the session until its deadline.
    flush().await;
    assert!(!next.is_finished());
    advance(SSH_REMOTE_GRACE_S * 1000).await;
    assert!(next.is_finished());
    next.await.unwrap().unwrap().release();
}

#[tokio::test(start_paused = true)]
async fn runs_commands_without_a_deadline_as_they_are() {
    let sessions = sessions();
    let _master = fake_master(&sessions, "plain-box");
    let command = cmd(&sessions, "plain-box", "glab auth status");
    let ran: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = ran.clone();
    let _: Result<Out> = sessions
        .run(
            &command,
            move |attempt, _| {
                *seen.lock().unwrap() = attempt.argv;
                std::future::ready(Ok(out(0, "")))
            },
            &SshSessionWait::default(),
        )
        .await;
    assert_eq!(ran.lock().unwrap().last().unwrap(), "glab auth status");
}

#[test]
fn leaves_powershell_commands_for_windows_hosts_alone() {
    let command = "powershell.exe -NoLogo -EncodedCommand AAAA";
    assert_eq!(with_remote_deadline(command, 5.0), command);
}

#[cfg(unix)]
pub(crate) fn which(name: &str) -> Option<String> {
    std::env::var("PATH").ok()?.split(':').find_map(|dir| {
        let path = std::path::Path::new(dir).join(name);
        path.is_file().then(|| path.to_string_lossy().into_owned())
    })
}

#[cfg(unix)]
#[test]
fn passes_output_input_and_status_through_from_sh_or_fish_to_sh() {
    use std::io::Write;
    let Some(setsid) = which("setsid") else {
        return;
    };
    // POSIX only: fish, even when SHELL names it, would refuse v=.
    let command = r#"cat; v='a\b'; printf '%s|' "$v" "x'y"; exit 3"#;
    let fish = which("fish");
    for shell in [Some("sh".to_owned()), fish.clone()].into_iter().flatten() {
        let mut child = std::process::Command::new(&setsid)
            .args(["-w", &shell, "-c", &with_remote_deadline(command, 30.0)])
            .env("SHELL", fish.clone().unwrap_or_else(|| shell.clone()))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"in|").unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), r"in|a\b|x'y|");
        assert_eq!(output.status.code(), Some(3));
    }
}

#[cfg(unix)]
#[test]
#[allow(clippy::disallowed_methods)]
fn kills_a_hung_command_and_what_it_started_at_the_deadline() {
    let Some(setsid) = which("setsid") else {
        return;
    };
    let marker = format!("roamgate-hung-{}", std::process::id());
    let started = std::time::Instant::now();
    let output = std::process::Command::new(&setsid)
        .args([
            "-w",
            "sh",
            "-c",
            &with_remote_deadline(&format!("sh -c 'sleep 30; echo {marker}'"), 1.0),
        ])
        .stdout(std::process::Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
    assert!(started.elapsed() < Duration::from_secs(10));
    let left = std::process::Command::new("pgrep")
        .args(["-f", &format!("echo {marker}")])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&left.stdout), "");
}
