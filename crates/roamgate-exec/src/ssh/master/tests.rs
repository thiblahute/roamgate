//! The cases of bridge/ssh-master.test.ts, on tokio's paused time.

use std::sync::atomic::AtomicUsize;

use super::*;
use crate::ssh::sessions::tests::{REFUSED, advance, flush, out, sessions};
use crate::ssh::sessions::{
    SSH_MASTER_RECYCLE_AFTER_MS, SSH_MASTER_RECYCLE_REFUSALS, SSH_REFUSED_RETRY_DELAYS_MS,
    SessionError, SshSessionWait,
};
use crate::ssh::supervised::{ChildControl, KillSignal};

const CONTROL_PATH: &str = "/tmp/rg-master-test/m.ctl";

struct Spawned {
    argv: Vec<String>,
    control: ChildControl,
    signals: Arc<Mutex<Vec<KillSignal>>>,
}

#[derive(Default)]
struct Overrides {
    exists: Option<Arc<Exists>>,
    restart_delay_ms: Option<u64>,
    remove_fails: bool,
    drain_timeout_ms: Option<u64>,
}

struct Harness {
    sessions: SshSessions,
    master: SshMaster,
    spawned: Arc<Mutex<Vec<Spawned>>>,
    removed: Arc<Mutex<Vec<String>>>,
    controls: Arc<Mutex<Vec<Vec<String>>>>,
    socket: Arc<AtomicBool>,
}

impl Harness {
    fn listen(&self) {
        self.socket.store(true, Ordering::SeqCst);
    }

    fn crash(&self, index: usize) {
        self.socket.store(false, Ordering::SeqCst);
        self.spawned.lock().unwrap()[index].control.exit(255);
    }

    fn exit(&self, index: usize, code: i32) {
        self.spawned.lock().unwrap()[index].control.exit(code);
    }

    fn spawn_count(&self) -> usize {
        self.spawned.lock().unwrap().len()
    }

    fn signals(&self, index: usize) -> Vec<KillSignal> {
        self.spawned.lock().unwrap()[index]
            .signals
            .lock()
            .unwrap()
            .clone()
    }

    fn routed(&self) -> bool {
        self.sessions
            .command_argv("dev-box", "true", &[], None)
            .unwrap()
            .contains("-S")
    }
}

fn harness_on(sessions: SshSessions, overrides: Overrides) -> Harness {
    let spawned: Arc<Mutex<Vec<Spawned>>> = Arc::default();
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let controls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let socket = Arc::new(AtomicBool::new(false));
    let spawn = {
        let spawned = spawned.clone();
        let socket = socket.clone();
        Arc::new(move |command: SshCommand| {
            let signals: Arc<Mutex<Vec<KillSignal>>> = Arc::default();
            let seen = signals.clone();
            let socket = socket.clone();
            let (child, control) = SupervisedSsh::manual(move |signal, control| {
                seen.lock().unwrap().push(signal);
                socket.store(false, Ordering::SeqCst);
                control.exit(if signal == KillSignal::Kill { 137 } else { 143 });
                Ok(())
            });
            spawned.lock().unwrap().push(Spawned {
                argv: command.argv,
                control,
                signals,
            });
            Ok(child)
        })
    };
    let exists: Arc<Exists> = overrides.exists.unwrap_or_else(|| {
        let socket = socket.clone();
        Arc::new(move |_| socket.load(Ordering::SeqCst))
    });
    let remove = {
        let removed = removed.clone();
        let socket = socket.clone();
        let fails = overrides.remove_fails;
        Arc::new(move |path: &str| {
            if fails {
                return Err("EACCES: permission denied".to_owned());
            }
            removed.lock().unwrap().push(path.to_owned());
            socket.store(false, Ordering::SeqCst);
            Ok(())
        })
    };
    let run_check = {
        let controls = controls.clone();
        let socket = socket.clone();
        Arc::new(move |argv: Vec<String>| {
            controls.lock().unwrap().push(argv);
            let code = if socket.load(Ordering::SeqCst) {
                0
            } else {
                255
            };
            Box::pin(async move { code }) as BoxFuture<i32>
        })
    };
    let master = SshMaster::new(
        sessions.clone(),
        SshMasterConfig {
            destination: "dev-box".into(),
            control_path: CONTROL_PATH.into(),
            connection_id: None,
            on_ready: None,
        },
        MasterDeps {
            spawn,
            exists,
            remove,
            run_check,
            ready_timeout_ms: 50,
            poll_interval_ms: 1,
            restart_delay_ms: overrides.restart_delay_ms.unwrap_or(1000),
            drain_timeout_ms: overrides.drain_timeout_ms.unwrap_or(5_000),
            stop_timeout_ms: 10,
            force_kill_timeout_ms: 10,
        },
    );
    Harness {
        sessions,
        master,
        spawned,
        removed,
        controls,
        socket,
    }
}

fn harness(overrides: Overrides) -> Harness {
    harness_on(sessions(), overrides)
}

// SSH command master lifecycle.

#[tokio::test(start_paused = true)]
async fn a_socket_it_cannot_clear_leaves_commands_cold_without_rejecting() {
    let h = harness(Overrides {
        remove_fails: true,
        ..Overrides::default()
    });
    assert!(!h.master.ensure().await);
    assert_eq!(h.spawn_count(), 0);
    assert!(!h.routed());
    h.master.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn starts_an_explicit_master_and_routes_commands_once_it_listens() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    assert_eq!(h.spawn_count(), 1);
    let argv = h.spawned.lock().unwrap()[0].argv.clone();
    assert_eq!(argv[..4], ["ssh", "-M", "-S", CONTROL_PATH]);
    assert!(argv.contains(&"-N".to_owned()));
    assert!(argv.contains(&"BatchMode=yes".to_owned()));
    assert_eq!(argv[argv.len() - 2..], ["--", "dev-box"]);
    assert!(!h.routed());
    h.listen();
    assert!(ready.await);
    let command = h
        .sessions
        .command_argv("dev-box", "true", &[], None)
        .unwrap();
    assert_eq!(command.argv[..3], ["ssh", "-S", CONTROL_PATH]);
    // A running master is reused rather than replaced.
    assert!(h.master.ensure().await);
    assert_eq!(h.spawn_count(), 1);
    h.master.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn shares_one_start_between_concurrent_callers() {
    let h = harness(Overrides::default());
    let first = h.master.ensure();
    let second = h.master.ensure();
    h.listen();
    assert_eq!((first.await, second.await), (true, true));
    assert_eq!(h.spawn_count(), 1);
    h.master.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn leaves_commands_cold_when_the_master_exits_before_it_listens() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.exit(0, 255);
    assert!(!ready.await);
    assert!(!h.master.is_running());
    assert!(!h.routed());
}

#[tokio::test(start_paused = true)]
async fn kills_a_master_that_never_listens_before_the_deadline() {
    let h = harness(Overrides {
        exists: Some(Arc::new(|_| false)),
        ..Overrides::default()
    });
    assert!(!h.master.ensure().await);
    assert_eq!(h.signals(0), [KillSignal::Term]);
    assert!(!h.master.is_running());
}

#[tokio::test(start_paused = true)]
async fn removes_a_stale_socket_before_starting() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    assert_eq!(*h.removed.lock().unwrap(), [CONTROL_PATH]);
    h.listen();
    ready.await;
    h.master.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn restarts_after_a_ready_master_dies_not_after_one_that_never_listens() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.listen();
    assert!(ready.await);
    h.crash(0);
    flush().await;
    assert!(!h.master.is_running());
    assert!(!h.routed());
    advance(999).await;
    assert_eq!(h.spawn_count(), 1);
    advance(1).await;
    assert_eq!(h.spawn_count(), 2);
    // This one never becomes ready: no further automatic restarts.
    h.exit(1, 255);
    flush().await;
    advance(10_000).await;
    assert_eq!(h.spawn_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn recycles_a_master_whose_host_keeps_refusing_its_sessions() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.listen();
    assert!(ready.await);
    // The host took every session of this connection and never gives them
    // back: each multiplexed command is refused, then runs on its own.
    let mux_runs = Arc::new(AtomicUsize::new(0));
    let command = || {
        let sessions = h.sessions.clone();
        let mux_runs = mux_runs.clone();
        async move {
            let argv = sessions
                .read_command_argv("dev-box", "true", &[], None)
                .unwrap();
            let task = tokio::spawn({
                let sessions = sessions.clone();
                async move {
                    sessions
                        .run(
                            &argv,
                            move |attempt, _| {
                                let mux = attempt.contains("-S");
                                if mux {
                                    mux_runs.fetch_add(1, Ordering::SeqCst);
                                }
                                std::future::ready(Ok::<_, SessionError>(if mux {
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
    assert_eq!(command().await.code, 0);
    assert_eq!(
        mux_runs.load(Ordering::SeqCst),
        SSH_REFUSED_RETRY_DELAYS_MS.len() + 1
    );
    assert_eq!(h.signals(0), []);
    // Refused for long enough: the master is closed, and opened again at
    // once rather than after the crash restart delay.
    advance(SSH_MASTER_RECYCLE_AFTER_MS as u64).await;
    assert_eq!(command().await.code, 0);
    assert_eq!(
        mux_runs.load(Ordering::SeqCst),
        SSH_MASTER_RECYCLE_REFUSALS as usize
    );
    assert_eq!(h.signals(0), [KillSignal::Term]);
    flush().await;
    advance(0).await;
    assert_eq!(h.spawn_count(), 2);
    assert!(!h.routed());
    h.listen();
    advance(1).await;
    assert!(h.routed());
    h.master.stop().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn stops_for_good_on_dispose_and_removes_its_socket() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.listen();
    ready.await;
    h.crash(0);
    flush().await;
    // A pending restart is cancelled by stop.
    h.master.stop().await.unwrap();
    advance(5_000).await;
    assert_eq!(h.spawn_count(), 1);
    assert!(!h.master.ensure().await);
    assert_eq!(*h.removed.lock().unwrap(), [CONTROL_PATH]);

    let live = harness(Overrides::default());
    let ready = live.master.ensure();
    live.listen();
    ready.await;
    live.master.stop().await.unwrap();
    assert_eq!(live.signals(0), [KillSignal::Term]);
    assert_eq!(*live.removed.lock().unwrap(), [CONTROL_PATH, CONTROL_PATH]);
    assert!(!live.routed());
}

#[tokio::test(start_paused = true)]
async fn lets_multiplexed_commands_finish_before_it_stops() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.listen();
    ready.await;
    let upload = h
        .sessions
        .hold(
            &h.sessions
                .command_argv("dev-box", "upload", &[], None)
                .unwrap(),
            &SshSessionWait::default(),
            false,
        )
        .await
        .unwrap();
    let stopping = tokio::spawn(h.master.stop());
    flush().await;
    // Closed to new sessions, which now log in on their own...
    let last = h.controls.lock().unwrap().last().unwrap().clone();
    assert!(last.contains(&"stop".to_owned()));
    assert_eq!(last[..3], ["ssh", "-S", CONTROL_PATH]);
    assert!(!h.routed());
    // ...while the running one keeps its master.
    advance(20).await;
    assert_eq!(h.signals(0), []);
    upload.release();
    stopping.await.unwrap().unwrap();
    assert_eq!(h.signals(0), [KillSignal::Term]);
}

#[tokio::test(start_paused = true)]
async fn stops_a_master_whose_commands_outlast_the_drain() {
    let h = harness(Overrides {
        drain_timeout_ms: Some(20),
        ..Overrides::default()
    });
    let ready = h.master.ensure();
    h.listen();
    ready.await;
    let upload = h
        .sessions
        .hold(
            &h.sessions
                .command_argv("dev-box", "upload", &[], None)
                .unwrap(),
            &SshSessionWait::default(),
            false,
        )
        .await
        .unwrap();
    h.master.stop().await.unwrap();
    assert_eq!(h.signals(0), [KillSignal::Term]);
    upload.release();
}

#[tokio::test(start_paused = true)]
async fn kills_a_master_that_is_still_starting_when_the_runtime_stops() {
    let h = harness(Overrides::default());
    let ready = h.master.ensure();
    h.master.stop().await.unwrap();
    assert_eq!(h.signals(0), [KillSignal::Term]);
    assert!(!ready.await);
    assert!(!h.routed());
}

#[tokio::test(start_paused = true)]
async fn reports_a_master_that_survives_forced_termination() {
    let signals: Arc<Mutex<Vec<KillSignal>>> = Arc::default();
    let socket = Arc::new(AtomicBool::new(false));
    let seen = signals.clone();
    let controls: Arc<Mutex<Vec<ChildControl>>> = Arc::default();
    let kept = controls.clone();
    let master = SshMaster::new(
        sessions(),
        SshMasterConfig {
            destination: "dev-box".into(),
            control_path: CONTROL_PATH.into(),
            connection_id: None,
            on_ready: None,
        },
        MasterDeps {
            spawn: Arc::new(move |_| {
                let seen = seen.clone();
                let (child, control) = SupervisedSsh::manual(move |signal, _| {
                    seen.lock().unwrap().push(signal);
                    Ok(())
                });
                kept.lock().unwrap().push(control);
                Ok(child)
            }),
            exists: {
                let socket = socket.clone();
                Arc::new(move |_| socket.load(Ordering::SeqCst))
            },
            remove: Arc::new(|_| Ok(())),
            run_check: Arc::new(|_| Box::pin(async { 0 })),
            ready_timeout_ms: MASTER_READY_TIMEOUT_MS,
            poll_interval_ms: 1,
            restart_delay_ms: MASTER_RESTART_DELAY_MS,
            drain_timeout_ms: MASTER_DRAIN_TIMEOUT_MS,
            stop_timeout_ms: 1,
            force_kill_timeout_ms: 1,
        },
    );
    let ready = master.ensure();
    socket.store(true, Ordering::SeqCst);
    assert!(ready.await);
    let error = master.stop().await.unwrap_err();
    assert!(error.contains("did not exit"), "{error}");
    assert_eq!(
        *signals.lock().unwrap(),
        [KillSignal::Term, KillSignal::Kill]
    );
}

// Orphaned master sweep.

#[cfg(unix)]
mod sweep {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};

    fn runtime_directory(
        root: &Path,
        name: &str,
        owner: Option<i64>,
        mode: u32,
        listeners: &mut Vec<UnixListener>,
    ) -> PathBuf {
        let directory = root.join(name);
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(mode)).unwrap();
        if let Some(owner) = owner {
            std::fs::write(directory.join("owner.pid"), format!("{owner}\n")).unwrap();
        }
        listeners.push(UnixListener::bind(directory.join("m.ctl")).unwrap());
        directory
    }

    fn options(
        root: &Path,
        uid: u32,
        alive: i32,
        exits: Arc<Mutex<Vec<Vec<String>>>>,
        code: i32,
    ) -> SweepOptions {
        SweepOptions {
            root: root.to_string_lossy().into_owned(),
            uid,
            is_process_alive: Box::new(move |pid| pid == alive),
            run_exit: Box::new(move |argv| {
                exits.lock().unwrap().push(argv);
                Box::pin(async move { Ok(code) })
            }),
            remove: Box::new(|path| std::fs::remove_dir_all(path)),
        }
    }

    fn tempdir(prefix: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(roamgate_base::paths::short_temp_root())
            .unwrap()
    }

    #[tokio::test]
    async fn ends_masters_only_in_private_runtime_directories_of_a_dead_roamgate() {
        let root = tempdir("rg-sweep-test-");
        let mut listeners = Vec::new();
        let dead = (1 << 22) + 17;
        let me = std::process::id() as i32;
        let orphan = runtime_directory(
            root.path(),
            "roamgate-ssh-Orph01",
            Some(dead),
            0o700,
            &mut listeners,
        );
        let kept = [
            // Another Roamgate on this account still runs.
            runtime_directory(
                root.path(),
                "roamgate-ssh-Live01",
                Some(me as i64),
                0o700,
                &mut listeners,
            ),
            // No owner record: not provably orphaned.
            runtime_directory(
                root.path(),
                "roamgate-ssh-NoOwn1",
                None,
                0o700,
                &mut listeners,
            ),
            // Not private.
            runtime_directory(
                root.path(),
                "roamgate-ssh-Open01",
                Some(dead),
                0o755,
                &mut listeners,
            ),
            // Not a runtime directory name.
            runtime_directory(
                root.path(),
                "other-ssh-Orph01",
                Some(dead),
                0o700,
                &mut listeners,
            ),
        ];
        // A symlink to an orphan-looking directory is not followed.
        let elsewhere = tempdir("rg-sweep-target-");
        let target = runtime_directory(
            elsewhere.path(),
            "roamgate-ssh-Targ01",
            Some(dead),
            0o700,
            &mut listeners,
        );
        std::os::unix::fs::symlink(&target, root.path().join("roamgate-ssh-Link01")).unwrap();
        let uid = rustix::process::getuid().as_raw();
        let exits: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        // Someone else's directories are never touched.
        assert_eq!(
            sweep_orphaned_ssh_masters(&options(root.path(), uid + 1, me, exits.clone(), 0)).await,
            0
        );
        assert!(exits.lock().unwrap().is_empty());
        assert_eq!(
            sweep_orphaned_ssh_masters(&options(root.path(), uid, me, exits.clone(), 0)).await,
            1
        );
        let control = orphan.join("m.ctl").to_string_lossy().into_owned();
        assert_eq!(
            *exits.lock().unwrap(),
            [vec![
                "ssh",
                "-F",
                "/dev/null",
                "-S",
                &control,
                "-O",
                "exit",
                "--",
                "roamgate-orphaned-master"
            ]]
        );
        assert!(!orphan.exists());
        for directory in kept.iter().chain([&target]) {
            assert!(directory.join("m.ctl").exists());
        }
    }

    #[tokio::test]
    async fn a_failed_orphan_exit_keeps_its_control_socket_available_for_retry() {
        let root = tempdir("rg-sweep-retry-");
        let mut listeners = Vec::new();
        let directory = runtime_directory(
            root.path(),
            "roamgate-ssh-Retry1",
            Some((1 << 22) + 19),
            0o700,
            &mut listeners,
        );
        let uid = rustix::process::getuid().as_raw();
        let exits: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        assert_eq!(
            sweep_orphaned_ssh_masters(&options(root.path(), uid, -1, exits.clone(), 255)).await,
            0
        );
        assert!(directory.join("m.ctl").exists());
        assert_eq!(
            sweep_orphaned_ssh_masters(&options(root.path(), uid, -1, exits, 0)).await,
            1
        );
        assert!(!directory.exists());
    }
}

// SSH runtime directory root.

#[test]
fn roamgate_ssh_runtime_dir_moves_it_tmp_otherwise() {
    let env = |pairs: &[(&str, &str)]| {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<std::collections::HashMap<String, String>>()
    };
    assert_eq!(ssh_runtime_directory_root(&env(&[])), "/tmp");
    assert_eq!(
        ssh_runtime_directory_root(&env(&[("ROAMGATE_SSH_RUNTIME_DIR", "")])),
        "/tmp"
    );
    assert_eq!(
        ssh_runtime_directory_root(&env(&[("ROAMGATE_SSH_RUNTIME_DIR", "/tmp/run/ssh")])),
        "/tmp/run/ssh"
    );
    assert_eq!(
        ssh_runtime_directory_root(&env(&[("HERDR_GUI_SSH_RUNTIME_DIR", "/tmp/legacy")])),
        "/tmp/legacy"
    );
}
