//! The cases of bridge/ssh-tunnel.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::ssh::sessions::tests::{flush, sessions};
use crate::ssh::supervised::{ChildControl, SSH_STDERR_MAX_BYTES, bounded_stderr};

fn config() -> SshTunnelConfig {
    SshTunnelConfig {
        socket_path: "/tmp/herdr-control.sock".into(),
        client_socket_path: "/tmp/herdr-client.sock".into(),
        ssh_host: Some("test-host".into()),
        ..SshTunnelConfig::default()
    }
}

fn with_remote_sockets(mut config: SshTunnelConfig) -> SshTunnelConfig {
    config.remote_socket_path = Some("/remote/control.sock".into());
    config.remote_client_socket_path = Some("/remote/render.sock".into());
    config
}

fn home(stdout: &str) -> RunProcess {
    let stdout = stdout.to_owned();
    Arc::new(move |_, _, _| {
        let stdout = stdout.clone();
        Box::pin(async move {
            Ok(ProcessOutput {
                stdout,
                stderr: String::new(),
            })
        })
    })
}

/// Children spawned by a test tunnel, with what their kill does.
#[derive(Clone, Default)]
struct Children {
    controls: Arc<Mutex<Vec<ChildControl>>>,
    argv: Arc<Mutex<Vec<Vec<String>>>>,
    signals: Arc<Mutex<Vec<KillSignal>>>,
}

impl Children {
    fn spawn(
        &self,
        kill: impl Fn(KillSignal, &ChildControl) -> Result<(), String> + Send + Sync + Clone + 'static,
    ) -> Arc<dyn Fn(SshCommand) -> Result<SupervisedSsh, String> + Send + Sync> {
        let children = self.clone();
        Arc::new(move |command: SshCommand| {
            let signals = children.signals.clone();
            let kill = kill.clone();
            let (child, control) = SupervisedSsh::manual(move |signal, control| {
                signals.lock().unwrap().push(signal);
                kill(signal, control)
            });
            children.controls.lock().unwrap().push(control);
            children.argv.lock().unwrap().push(command.argv);
            Ok(child)
        })
    }

    fn control(&self, index: usize) -> ChildControl {
        self.controls.lock().unwrap()[index].clone()
    }

    fn count(&self) -> usize {
        self.controls.lock().unwrap().len()
    }

    fn signals(&self) -> Vec<KillSignal> {
        self.signals.lock().unwrap().clone()
    }
}

fn exits_on_kill(signal: KillSignal, control: &ChildControl) -> Result<(), String> {
    control.exit(if signal == KillSignal::Kill { 137 } else { 143 });
    Ok(())
}

fn ignores_kill(_: KillSignal, _: &ChildControl) -> Result<(), String> {
    Ok(())
}

/// Polls that never fire by themselves, counted as scheduled and cancelled.
#[derive(Clone, Default)]
struct Polls {
    scheduled: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
}

impl Polls {
    fn schedule(&self) -> Arc<dyn Fn(Duration) -> ScheduledPoll + Send + Sync> {
        let polls = self.clone();
        Arc::new(move |_| {
            polls.scheduled.fetch_add(1, Ordering::SeqCst);
            let cancelled = polls.cancelled.clone();
            ScheduledPoll {
                fired: Box::pin(std::future::pending()),
                cancel: Box::new(move || {
                    cancelled.fetch_add(1, Ordering::SeqCst);
                }),
            }
        })
    }

    async fn wait_scheduled(&self, count: usize) {
        for _ in 0..1000 {
            if self.scheduled.load(Ordering::SeqCst) >= count {
                return;
            }
            flush().await;
        }
        panic!("condition not reached");
    }
}

fn deps() -> TunnelDeps {
    TunnelDeps {
        exists: Arc::new(|_| true),
        remove: Arc::new(|_| {}),
        remove_directory: Arc::new(|_| {}),
        windows: false,
        ..TunnelDeps::default()
    }
}

fn manager(config: SshTunnelConfig, run_process: RunProcess, deps: TunnelDeps) -> SshTunnelManager {
    SshTunnelManager::new(SshTunnelArgs {
        sessions: sessions(),
        connection_id: None,
        config,
        run_process,
        on_unexpected_exit: None,
        on_master_ready: None,
        deps,
    })
    .unwrap()
}

type Remove = Arc<dyn Fn(&str) + Send + Sync>;

fn recorder() -> (Arc<Mutex<Vec<String>>>, Remove) {
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = removed.clone();
    (
        removed,
        Arc::new(move |path: &str| sink.lock().unwrap().push(path.to_owned())),
    )
}

// SSH tunnel readiness lifecycle.

#[test]
fn rejects_windows_before_constructing_an_invalid_stream_local_forward() {
    let failure = assert_ssh_tunnel_platform_supported(true).unwrap_err();
    assert!(!failure.retryable);
    assert_eq!(failure.kind, SshTunnelFailureKind::Unsupported);
    assert!(
        failure
            .message
            .contains("cannot create a local Windows named pipe")
    );
    assert!(assert_ssh_tunnel_platform_supported(false).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn a_windows_host_gets_the_windows_bridges_through_the_same_manager() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("runtime");
    std::fs::create_dir(&runtime).unwrap();
    let herdr = r"C:\Herdr\herdr.exe";
    let probed: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let seen = probed.clone();
    let answer = format!(
        "roamgate-herdr-path:{}\r\n",
        base64::engine::general_purpose::STANDARD.encode(herdr)
    );
    let run_process: RunProcess = Arc::new(move |command, _, _| {
        seen.lock().unwrap().push(command.argv.clone());
        let stdout = answer.clone();
        Box::pin(async move {
            Ok(ProcessOutput {
                stdout,
                stderr: String::new(),
            })
        })
    });
    let config = SshTunnelConfig {
        socket_path: runtime.join("control.sock").to_string_lossy().into_owned(),
        client_socket_path: runtime.join("render.sock").to_string_lossy().into_owned(),
        ssh_host: Some("windows-host".into()),
        remote_platform: Some(RemotePlatform::Windows),
        owned_runtime_directory: Some(runtime.to_string_lossy().into_owned()),
        ..SshTunnelConfig::default()
    };
    let manager = manager(config.clone(), run_process, deps());
    manager.start().await.unwrap();
    // The probe ran once, as a PowerShell script over ssh; both sockets
    // listen for bridges.
    let probed = probed.lock().unwrap().clone();
    assert_eq!(probed.len(), 1);
    assert!(probed[0].last().unwrap().starts_with("powershell.exe "));
    assert!(std::path::Path::new(&config.socket_path).exists());
    assert!(std::path::Path::new(&config.client_socket_path).exists());
    manager.cleanup().await.unwrap();
    assert!(!runtime.exists());
    // Without its destination it is refused.
    let refused = SshTunnelManager::new(SshTunnelArgs {
        sessions: sessions(),
        connection_id: None,
        config: SshTunnelConfig {
            ssh_host: None,
            ..config
        },
        run_process: home("/unused"),
        on_unexpected_exit: None,
        on_master_ready: None,
        deps: deps(),
    });
    assert!(refused.is_err());
}

#[test]
fn classifies_permanent_and_transient_openssh_failures_without_raw_stderr() {
    let auth = classify_ssh_tunnel_failure(255, "Permission denied (publickey).");
    assert!(!auth.retryable);
    assert_eq!(auth.kind, SshTunnelFailureKind::Authentication);
    assert!(!auth.message.contains("publickey"));
    let host_key = classify_ssh_tunnel_failure(255, "REMOTE HOST IDENTIFICATION HAS CHANGED!");
    assert_eq!(
        (host_key.retryable, host_key.kind),
        (false, SshTunnelFailureKind::HostKey)
    );
    let refused = classify_ssh_tunnel_failure(255, "ssh: connect: Connection refused");
    assert_eq!(
        (refused.retryable, refused.kind),
        (true, SshTunnelFailureKind::Unreachable)
    );
    let other = classify_ssh_tunnel_failure(1, "unknown banner");
    assert_eq!(
        (other.retryable, other.kind, other.exit_code),
        (true, SshTunnelFailureKind::Exited, 1)
    );
}

#[tokio::test(start_paused = true)]
async fn cleanup_during_remote_home_resolution_prevents_process_startup() {
    let (answer, question) = tokio::sync::oneshot::channel::<()>();
    let question = Arc::new(Mutex::new(Some(question)));
    let run: RunProcess = Arc::new(move |_, _, _| {
        let question = question.lock().unwrap().take();
        Box::pin(async move {
            if let Some(question) = question {
                let _ = question.await;
            }
            Ok(ProcessOutput {
                stdout: "/home/test".into(),
                stderr: String::new(),
            })
        })
    });
    let children = Children::default();
    let manager = manager(
        config(),
        run,
        TunnelDeps {
            spawn: children.spawn(ignores_kill),
            ..deps()
        },
    );
    let starting = tokio::spawn({
        let manager = manager.clone();
        async move { manager.start().await }
    });
    flush().await;
    let cleanup = manager.cleanup();
    answer.send(()).unwrap();
    starting.await.unwrap().unwrap();
    cleanup.await.unwrap();
    assert_eq!(children.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn the_remote_home_probe_runs_with_a_deadline() {
    type Probe = Option<(SshCommand, Option<u64>)>;
    let probe: Arc<Mutex<Probe>> = Arc::default();
    let seen = probe.clone();
    let run: RunProcess = Arc::new(move |command, _, timeout| {
        *seen.lock().unwrap() = Some((command, timeout));
        Box::pin(async {
            Ok(ProcessOutput {
                stdout: "/home/test".into(),
                stderr: String::new(),
            })
        })
    });
    let children = Children::default();
    let manager = manager(
        config(),
        run,
        TunnelDeps {
            spawn: children.spawn(exits_on_kill),
            ..deps()
        },
    );
    manager.start().await.unwrap();
    let (command, timeout) = probe.lock().unwrap().clone().unwrap();
    assert_eq!(timeout, Some(20_000));
    assert_eq!(command.annotation.tag.as_deref(), Some("home.probe"));
    assert_eq!(command.argv.last().unwrap(), r#"printf %s "$HOME""#);
    // The sockets of the default Herdr session under that HOME.
    let argv = children.argv.lock().unwrap()[0].clone();
    assert!(
        argv.contains(&"/tmp/herdr-control.sock:/home/test/.config/herdr/herdr.sock".to_owned())
    );
    assert!(
        argv.contains(
            &"/tmp/herdr-client.sock:/home/test/.config/herdr/herdr-client.sock".to_owned()
        )
    );
    manager.cleanup().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn cleanup_cancels_readiness_polling_and_the_starting_process() {
    let children = Children::default();
    let polls = Polls::default();
    let manager = manager(
        config(),
        home("/home/test"),
        TunnelDeps {
            exists: Arc::new(|_| false),
            spawn: children.spawn(exits_on_kill),
            schedule_poll: Some(polls.schedule()),
            ..deps()
        },
    );
    let starting = tokio::spawn({
        let manager = manager.clone();
        async move { manager.start().await }
    });
    polls.wait_scheduled(1).await;
    let cleanup = manager.cleanup();
    starting.await.unwrap().unwrap();
    cleanup.await.unwrap();
    assert_eq!(children.signals().len(), 1);
    assert_eq!(polls.cancelled.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn process_exit_cancels_the_outstanding_readiness_poll() {
    let children = Children::default();
    let polls = Polls::default();
    let manager = manager(
        config(),
        home("/home/test"),
        TunnelDeps {
            exists: Arc::new(|_| false),
            spawn: children.spawn(ignores_kill),
            schedule_poll: Some(polls.schedule()),
            ..deps()
        },
    );
    let starting = tokio::spawn({
        let manager = manager.clone();
        async move { manager.start().await }
    });
    polls.wait_scheduled(1).await;
    children.control(0).exit(255);
    let error = starting.await.unwrap().unwrap_err();
    assert_eq!(
        error.to_string(),
        "SSH tunnel exited unexpectedly (code 255)"
    );
    assert_eq!(polls.cancelled.load(Ordering::SeqCst), 1);
}

#[test]
fn retains_the_stderr_tail_for_permanent_failure_classification() {
    let noise = "warning ".repeat(3000);
    let stderr = bounded_stderr([noise.as_bytes(), b" Permission denied (publickey)."]);
    assert!(stderr.contains("Permission denied"));
    assert!(stderr.len() <= SSH_STDERR_MAX_BYTES);
    let failure = classify_ssh_tunnel_failure(255, &stderr);
    assert_eq!(
        (failure.retryable, failure.kind),
        (false, SshTunnelFailureKind::Authentication)
    );
}

#[tokio::test(start_paused = true)]
async fn reports_a_classified_exit_after_readiness_exactly_once() {
    let children = Children::default();
    let failures: Arc<Mutex<Vec<TunnelError>>> = Arc::default();
    let seen = failures.clone();
    let manager = SshTunnelManager::new(SshTunnelArgs {
        sessions: sessions(),
        connection_id: None,
        config: with_remote_sockets(config()),
        run_process: home("/unused"),
        on_unexpected_exit: Some(Arc::new(move |error| seen.lock().unwrap().push(error))),
        on_master_ready: None,
        deps: TunnelDeps {
            spawn: children.spawn(ignores_kill),
            ..deps()
        },
    })
    .unwrap();
    manager.start().await.unwrap();
    let control = children.control(0);
    control.set_stderr("ssh: connect: Connection refused");
    control.exit(255);
    flush().await;
    {
        let failures = failures.lock().unwrap();
        assert_eq!(failures.len(), 1);
        let TunnelError::Failure(failure) = &failures[0] else {
            panic!("{:?}", failures[0]);
        };
        assert_eq!(
            (failure.retryable, failure.kind),
            (true, SshTunnelFailureKind::Unreachable)
        );
    }
    manager.cleanup().await.unwrap();
    assert_eq!(failures.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn uses_explicit_profile_forwards_and_cleans_only_its_owned_runtime_directory() {
    let children = Children::default();
    let (removed, remove) = recorder();
    let (directories, remove_directory) = recorder();
    let probes = Arc::new(AtomicUsize::new(0));
    let counted = probes.clone();
    let config = SshTunnelConfig {
        socket_path: "/tmp/private-a/control.sock".into(),
        client_socket_path: "/tmp/private-a/render.sock".into(),
        remote_socket_path: Some("/remote/herdr.sock".into()),
        remote_client_socket_path: Some("/remote/herdr-client.sock".into()),
        owned_runtime_directory: Some("/tmp/private-a".into()),
        has_explicit_socket_path: true,
        has_explicit_client_socket_path: true,
        ..config()
    };
    let run: RunProcess = Arc::new(move |_, _, _| {
        counted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(ProcessOutput::default()) })
    });
    let manager = manager(
        config,
        run,
        TunnelDeps {
            remove,
            remove_directory,
            spawn: children.spawn(exits_on_kill),
            ..deps()
        },
    );
    manager.start().await.unwrap();
    assert_eq!(probes.load(Ordering::SeqCst), 0);
    let argv = children.argv.lock().unwrap()[0].clone();
    assert!(argv.contains(&"BatchMode=yes".to_owned()));
    assert!(argv.contains(&"StrictHostKeyChecking=yes".to_owned()));
    assert!(!argv.contains(&"StrictHostKeyChecking=no".to_owned()));
    assert_eq!(argv[argv.len() - 2..], ["--", "test-host"]);
    assert!(argv.contains(&"/tmp/private-a/control.sock:/remote/herdr.sock".to_owned()));
    assert!(argv.contains(&"/tmp/private-a/render.sock:/remote/herdr-client.sock".to_owned()));
    manager.cleanup().await.unwrap();
    assert_eq!(children.signals().len(), 1);
    assert_eq!(
        *removed.lock().unwrap(),
        [
            "/tmp/private-a/control.sock",
            "/tmp/private-a/render.sock",
            "/tmp/private-a/control.sock",
            "/tmp/private-a/render.sock"
        ]
    );
    assert_eq!(*directories.lock().unwrap(), ["/tmp/private-a"]);
}

#[tokio::test(start_paused = true)]
async fn awaits_process_exit_before_removing_owned_tunnel_paths() {
    let children = Children::default();
    let (removed, remove) = recorder();
    let mut config = with_remote_sockets(config());
    config.owned_runtime_directory = Some("/tmp/private-wait".into());
    let manager = manager(
        config,
        home("/unused"),
        TunnelDeps {
            remove: remove.clone(),
            remove_directory: remove,
            spawn: children.spawn(ignores_kill),
            process_stop_timeout_ms: 100,
            ..deps()
        },
    );
    manager.start().await.unwrap();
    let cleanup = manager.cleanup();
    flush().await;
    assert_eq!(
        *removed.lock().unwrap(),
        ["/tmp/herdr-control.sock", "/tmp/herdr-client.sock"]
    );
    children.control(0).exit(143);
    cleanup.await.unwrap();
    assert_eq!(
        *removed.lock().unwrap(),
        [
            "/tmp/herdr-control.sock",
            "/tmp/herdr-client.sock",
            "/tmp/herdr-control.sock",
            "/tmp/herdr-client.sock",
            "/tmp/private-wait"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn uses_force_kill_after_a_failed_graceful_termination() {
    let children = Children::default();
    let manager = manager(
        with_remote_sockets(config()),
        home("/unused"),
        TunnelDeps {
            spawn: children.spawn(|signal, control| {
                if signal == KillSignal::Term {
                    return Err("graceful kill failed".into());
                }
                control.exit(137);
                Ok(())
            }),
            process_stop_timeout_ms: 1,
            process_force_kill_timeout_ms: 20,
            ..deps()
        },
    );
    manager.start().await.unwrap();
    manager.cleanup().await.unwrap();
    assert_eq!(children.signals(), [KillSignal::Term, KillSignal::Kill]);
}

#[tokio::test(start_paused = true)]
async fn preserves_owned_paths_when_forced_process_exit_cannot_be_confirmed() {
    let children = Children::default();
    let (removed, remove) = recorder();
    let mut config = with_remote_sockets(config());
    config.owned_runtime_directory = Some("/tmp/private-stuck".into());
    let manager = manager(
        config,
        home("/unused"),
        TunnelDeps {
            remove: remove.clone(),
            remove_directory: remove,
            spawn: children.spawn(ignores_kill),
            process_stop_timeout_ms: 1,
            process_force_kill_timeout_ms: 1,
            ..deps()
        },
    );
    manager.start().await.unwrap();
    let error = manager.cleanup().await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("did not exit after forced termination")
    );
    assert_eq!(children.signals(), [KillSignal::Term, KillSignal::Kill]);
    assert_eq!(
        *removed.lock().unwrap(),
        ["/tmp/herdr-control.sock", "/tmp/herdr-client.sock"]
    );
}

#[tokio::test(start_paused = true)]
async fn a_superseding_start_cancels_the_previous_readiness_poll() {
    let children = Children::default();
    let polls = Polls::default();
    let manager = manager(
        config(),
        home("/home/test"),
        TunnelDeps {
            exists: Arc::new(|_| false),
            spawn: children.spawn(exits_on_kill),
            schedule_poll: Some(polls.schedule()),
            ..deps()
        },
    );
    let start = || {
        let manager = manager.clone();
        tokio::spawn(async move { manager.start().await })
    };
    let first = start();
    polls.wait_scheduled(1).await;
    let second = start();
    polls.wait_scheduled(2).await;
    let cleanup = manager.cleanup();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    cleanup.await.unwrap();
    assert_eq!(children.signals().len(), 2);
    assert_eq!(polls.cancelled.load(Ordering::SeqCst), 2);
}

// SSH command master alongside the tunnel.

struct FakeMaster {
    calls: Arc<Mutex<Vec<&'static str>>>,
    stop_error: Option<String>,
}

impl MasterControl for FakeMaster {
    fn ensure(&self) -> BoxFuture<bool> {
        self.calls.lock().unwrap().push("ensure");
        Box::pin(async { true })
    }

    fn stop(&self) -> BoxFuture<Result<(), String>> {
        self.calls.lock().unwrap().push("stop");
        let outcome = self.stop_error.clone().map_or(Ok(()), Err);
        Box::pin(async move { outcome })
    }
}

struct WithMaster {
    manager: SshTunnelManager,
    created: Arc<Mutex<Vec<(String, String)>>>,
    calls: Arc<Mutex<Vec<&'static str>>>,
    events: Arc<Mutex<Vec<String>>>,
}

fn manager_with(stop_error: Option<&str>, master_control_path: Option<&str>) -> WithMaster {
    let calls: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let created: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut config = with_remote_sockets(config());
    config.owned_runtime_directory = Some("/tmp/private-m".into());
    config.master_control_path = master_control_path.map(str::to_owned);
    let master = Arc::new(FakeMaster {
        calls: calls.clone(),
        stop_error: stop_error.map(str::to_owned),
    });
    let made = created.clone();
    let spawned = events.clone();
    let removed = events.clone();
    let manager = manager(
        config,
        home("/unused"),
        TunnelDeps {
            remove_directory: Arc::new(move |path| {
                removed.lock().unwrap().push(format!("rmdir {path}"))
            }),
            spawn: Arc::new(move |_| {
                spawned.lock().unwrap().push("tunnel".into());
                Ok(SupervisedSsh::manual(exits_on_kill).0)
            }),
            create_master: Some(Arc::new(move |destination, path| {
                made.lock()
                    .unwrap()
                    .push((destination.to_owned(), path.to_owned()));
                master.clone() as Arc<dyn MasterControl>
            })),
            ..deps()
        },
    );
    WithMaster {
        manager,
        created,
        calls,
        events,
    }
}

#[tokio::test(start_paused = true)]
async fn starts_one_master_per_runtime_and_keeps_it_across_tunnel_restarts() {
    let t = manager_with(None, Some("/tmp/private-m/m.ctl"));
    assert_eq!(
        *t.created.lock().unwrap(),
        [("test-host".to_owned(), "/tmp/private-m/m.ctl".to_owned())]
    );
    t.manager.start().await.unwrap();
    t.manager.start().await.unwrap();
    assert_eq!(*t.calls.lock().unwrap(), ["ensure", "ensure"]);
    assert_eq!(*t.events.lock().unwrap(), ["tunnel", "tunnel"]);
    t.manager.cleanup().await.unwrap();
    assert_eq!(*t.calls.lock().unwrap(), ["ensure", "ensure", "stop"]);
    assert_eq!(
        t.events.lock().unwrap().last().unwrap(),
        "rmdir /tmp/private-m"
    );
}

#[tokio::test(start_paused = true)]
async fn preserves_the_runtime_directory_when_the_master_cannot_be_stopped() {
    let t = manager_with(Some("master did not exit"), Some("/tmp/private-m/m.ctl"));
    t.manager.start().await.unwrap();
    let error = t.manager.cleanup().await.unwrap_err();
    assert_eq!(error.to_string(), "master did not exit");
    assert!(
        !t.events
            .lock()
            .unwrap()
            .contains(&"rmdir /tmp/private-m".to_owned())
    );
}

#[tokio::test(start_paused = true)]
async fn runs_without_a_master_when_the_runtime_has_no_control_path() {
    let t = manager_with(None, None);
    t.manager.start().await.unwrap();
    t.manager.cleanup().await.unwrap();
    assert!(t.created.lock().unwrap().is_empty());
    assert!(t.calls.lock().unwrap().is_empty());
}
