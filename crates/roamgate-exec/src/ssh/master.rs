//! A runtime's command master (bridge/ssh-master.ts): connection B, which
//! carries host commands and uploads while the Herdr tunnel stays on its
//! own connection. A master that is missing, starting or dead only costs
//! speed: commands then open their own connection. Also the sweep of
//! masters a crashed Roamgate left behind, and where runtime directories go.

use crate::process::ProcessRunner;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_base::clock::{BoxFuture, timeout};
use tokio::task::AbortHandle;

use super::command::{
    SshAnnotation, SshCommand, ssh_master_argv, ssh_master_check_argv, ssh_master_stop_argv,
};
use super::metrics::SshProcessMonitor;
use super::sessions::{MasterOwner, MasterRegistration, SshSessions};
use super::supervised::{SupervisedSsh, stop_child};

/// Covers ConnectTimeout plus key exchange and authentication.
pub const MASTER_READY_TIMEOUT_MS: u64 = 20_000;
pub const MASTER_POLL_INTERVAL_MS: u64 = 100;
/// A master that was ready and then exited is started again after this
/// delay; one that never became ready waits for the next tunnel start.
pub const MASTER_RESTART_DELAY_MS: u64 = 10_000;
/// On stop, commands multiplexed over the master get this long to finish.
pub const MASTER_DRAIN_TIMEOUT_MS: u64 = 10_000;

type Spawn = dyn Fn(SshCommand) -> Result<SupervisedSsh, String> + Send + Sync;
type Exists = dyn Fn(&str) -> bool + Send + Sync;
type Remove = dyn Fn(&str) -> Result<(), String> + Send + Sync;
type RunCheck = dyn Fn(Vec<String>) -> BoxFuture<i32> + Send + Sync;

/// What the master does to the world, replaceable in tests.
#[derive(Clone)]
pub struct MasterDeps {
    pub spawn: Arc<Spawn>,
    pub exists: Arc<Exists>,
    pub remove: Arc<Remove>,
    /// Runs `-O check` and `-O stop`, giving the exit code.
    pub run_check: Arc<RunCheck>,
    pub ready_timeout_ms: u64,
    pub poll_interval_ms: u64,
    pub restart_delay_ms: u64,
    pub drain_timeout_ms: u64,
    pub stop_timeout_ms: u64,
    pub force_kill_timeout_ms: u64,
}

impl MasterDeps {
    /// The real ones: ssh children tracked by `monitor`, the filesystem.
    pub fn real(
        sessions: &SshSessions,
        connection: &str,
        monitor: Option<SshProcessMonitor>,
    ) -> Self {
        let tagged = |tag: &str| SshAnnotation {
            tag: Some(tag.to_owned()),
            connection: Some(connection.to_owned()),
            master: false,
        };
        let master_tag = tagged("master");
        let check_tag = tagged("master.check");
        let spawn_monitor = monitor.clone();
        let runner = sessions.runner().clone();
        let spawn_runner = runner.clone();
        Self {
            spawn: Arc::new(move |command: SshCommand| {
                let command = command.annotated(master_tag.clone());
                let child = SupervisedSsh::spawn(&spawn_runner, &command)?;
                if let Some(monitor) = &spawn_monitor {
                    let exited = child.clone();
                    monitor.track(
                        &command,
                        async move { exited.exited().await },
                        None::<std::future::Ready<Result<String, String>>>,
                    );
                }
                Ok(child)
            }),
            exists: Arc::new(|path| std::path::Path::new(path).exists()),
            remove: Arc::new(|path| match std::fs::remove_file(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(error.to_string())
                }
                _ => Ok(()),
            }),
            run_check: Arc::new(move |argv: Vec<String>| {
                let command = SshCommand::plain(argv).annotated(check_tag.clone());
                let monitor = monitor.clone();
                let runner = runner.clone();
                Box::pin(async move {
                    run_quietly(&runner, &command, Duration::from_secs(5), monitor).await
                })
            }),
            ready_timeout_ms: MASTER_READY_TIMEOUT_MS,
            poll_interval_ms: MASTER_POLL_INTERVAL_MS,
            restart_delay_ms: MASTER_RESTART_DELAY_MS,
            drain_timeout_ms: MASTER_DRAIN_TIMEOUT_MS,
            stop_timeout_ms: 1500,
            force_kill_timeout_ms: 1000,
        }
    }
}

/// Runs a short ssh request with no input or output, killed past `limit`.
async fn run_quietly(
    runner: &ProcessRunner,
    command: &SshCommand,
    limit: Duration,
    monitor: Option<SshProcessMonitor>,
) -> i32 {
    let clock = runner.clock().clone();
    let Ok(child) = SupervisedSsh::spawn(runner, command) else {
        return -1;
    };
    if let Some(monitor) = monitor {
        let exited = child.clone();
        monitor.track(
            command,
            async move { exited.exited().await },
            None::<std::future::Ready<Result<String, String>>>,
        );
    }
    match timeout(&*clock, limit, child.exited()).await {
        Ok(Ok(code)) => code,
        Ok(Err(_)) => -1,
        Err(_) => {
            let _ = child.kill(super::supervised::KillSignal::Kill);
            -1
        }
    }
}

/// What a master is made for.
#[derive(Clone)]
pub struct SshMasterConfig {
    pub destination: String,
    pub control_path: String,
    pub connection_id: Option<String>,
    /// Runs each time the master becomes ready, including after a restart.
    pub on_ready: Option<Arc<dyn Fn() + Send + Sync>>,
}

type StartTask = Shared<BoxFuture<bool>>;
type StopTask = Shared<BoxFuture<Result<(), String>>>;

#[derive(Default)]
struct MasterState {
    proc: Option<SupervisedSsh>,
    starting: Option<(u64, StartTask)>,
    restart_timer: Option<AbortHandle>,
    stopped: bool,
    stop_task: Option<StopTask>,
    /// The child being closed to be opened again at once.
    recycling: Option<u64>,
}

struct MasterInner {
    sessions: SshSessions,
    config: SshMasterConfig,
    deps: MasterDeps,
    owner: MasterOwner,
    state: Mutex<MasterState>,
    next_start: AtomicU64,
}

/// Supervises one runtime's command master. Clones are the same master.
#[derive(Clone)]
pub struct SshMaster {
    inner: Arc<MasterInner>,
}

impl SshMaster {
    pub fn new(sessions: SshSessions, config: SshMasterConfig, deps: MasterDeps) -> Self {
        let owner = sessions.new_owner();
        Self {
            inner: Arc::new(MasterInner {
                sessions,
                config,
                deps,
                owner,
                state: Mutex::new(MasterState::default()),
                next_start: AtomicU64::new(1),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, MasterState> {
        self.inner.state.lock().expect("ssh master")
    }

    fn connection(&self) -> &str {
        self.inner
            .config
            .connection_id
            .as_deref()
            .unwrap_or("legacy-default")
    }

    fn path(&self) -> &str {
        &self.inner.config.control_path
    }

    pub fn is_running(&self) -> bool {
        self.lock().proc.is_some()
    }

    /// Starts the master unless it runs; resolves whether it is ready. The
    /// start goes on whether or not the result is awaited, and never fails:
    /// a master that cannot start only costs speed.
    pub fn ensure(&self) -> StartTask {
        let mut state = self.lock();
        if state.stopped {
            return ready(false);
        }
        if let Some((_, task)) = &state.starting {
            return task.clone();
        }
        if state.proc.is_some() {
            return ready(true);
        }
        if let Some(timer) = state.restart_timer.take() {
            timer.abort();
        }
        drop(state);
        let Some((child, was_ready)) = self.spawn_child() else {
            return ready(false);
        };
        let id = self.inner.next_start.fetch_add(1, Ordering::Relaxed);
        let (done, result) = tokio::sync::oneshot::channel();
        let task: StartTask = async move { result.await.unwrap_or(false) }
            .boxed()
            .shared();
        self.lock().starting = Some((id, task.clone()));
        let master = self.clone();
        tokio::spawn(async move {
            let ready = master.finish_start(child, was_ready).await;
            {
                let mut state = master.lock();
                if state.starting.as_ref().is_some_and(|(each, _)| *each == id) {
                    state.starting = None;
                }
            }
            let _ = done.send(ready);
        });
        task
    }

    /// The start's first, synchronous steps: clear a stale socket (a master
    /// that crashed leaves it, and a new one cannot bind over it) and spawn.
    fn spawn_child(&self) -> Option<(SupervisedSsh, Arc<AtomicBool>)> {
        if let Err(error) = (self.inner.deps.remove)(self.path()) {
            tracing::debug!(connection = self.connection(), %error, "SSH command master socket could not be cleared");
            return None;
        }
        let argv = ssh_master_argv(&self.inner.config.destination, self.path()).ok()?;
        let child = match (self.inner.deps.spawn)(SshCommand::plain(argv)) {
            Ok(child) => child,
            Err(error) => {
                tracing::debug!(connection = self.connection(), %error, "SSH command master failed to start");
                return None;
            }
        };
        self.lock().proc = Some(child.clone());
        let was_ready = Arc::new(AtomicBool::new(false));
        self.watch_exit(child.clone(), was_ready.clone());
        Some((child, was_ready))
    }

    async fn finish_start(&self, child: SupervisedSsh, was_ready: Arc<AtomicBool>) -> bool {
        let ready = self.wait_ready(&child).await;
        was_ready.store(ready, Ordering::SeqCst);
        let current = {
            let state = self.lock();
            !state.stopped && state.proc.as_ref() == Some(&child)
        };
        if !ready || !current {
            let ours = {
                let mut state = self.lock();
                if state.proc.as_ref() == Some(&child) {
                    state.proc = None;
                    true
                } else {
                    false
                }
            };
            if ours {
                let _ = self.stop_process(&child).await;
            }
            tracing::debug!(
                connection = self.connection(),
                "SSH command master unavailable; using cold logins"
            );
            return false;
        }
        self.register(&child);
        tracing::debug!(connection = self.connection(), "SSH command master ready");
        if let Some(on_ready) = &self.inner.config.on_ready {
            on_ready();
        }
        true
    }

    async fn wait_ready(&self, child: &SupervisedSsh) -> bool {
        let mut waited = 0;
        loop {
            {
                let state = self.lock();
                if state.stopped || child.has_exited() || state.proc.as_ref() != Some(child) {
                    return false;
                }
            }
            if (self.inner.deps.exists)(self.path()) {
                return true;
            }
            if waited >= self.inner.deps.ready_timeout_ms {
                return false;
            }
            self.inner
                .sessions
                .clock()
                .sleep(Duration::from_millis(self.inner.deps.poll_interval_ms))
                .await;
            waited += self.inner.deps.poll_interval_ms;
        }
    }

    fn register(&self, child: &SupervisedSsh) {
        let weak: Weak<MasterInner> = Arc::downgrade(&self.inner);
        let listening = (weak.clone(), child.clone());
        let alive = weak.clone();
        let recycling = (weak, child.clone());
        self.inner.sessions.register_master(
            self.inner.owner,
            MasterRegistration {
                destination: self.inner.config.destination.clone(),
                control_path: self.path().to_owned(),
                is_listening: Arc::new(move || {
                    let (weak, child) = &listening;
                    weak.upgrade().is_some_and(|inner| {
                        let master = SshMaster { inner };
                        master.lock().proc.as_ref() == Some(child)
                            && (master.inner.deps.exists)(master.path())
                    })
                }),
                is_alive: Arc::new(move || {
                    let master = alive.upgrade().map(|inner| SshMaster { inner });
                    Box::pin(async move {
                        match master {
                            Some(master) => master.is_alive().await,
                            None => false,
                        }
                    })
                }),
                recycle: Some(Arc::new(move || {
                    let (weak, child) = &recycling;
                    if let Some(inner) = weak.upgrade() {
                        SshMaster { inner }.recycle(child);
                    }
                })),
            },
        );
    }

    async fn is_alive(&self) -> bool {
        if self.lock().proc.is_none() || !(self.inner.deps.exists)(self.path()) {
            return false;
        }
        let Ok(argv) = ssh_master_check_argv(&self.inner.config.destination, self.path()) else {
            return false;
        };
        (self.inner.deps.run_check)(argv).await == 0
    }

    /// Closes `child`, the ready master, and opens a new one as soon as it
    /// is gone: its host refuses every session it asks for.
    fn recycle(&self, child: &SupervisedSsh) {
        {
            let mut state = self.lock();
            if state.stopped
                || state.proc.as_ref() != Some(child)
                || state.recycling == Some(child.id())
            {
                return;
            }
            state.recycling = Some(child.id());
        }
        self.inner.sessions.unregister_master(self.inner.owner);
        tracing::info!(
            connection = self.connection(),
            "SSH command master recycled: the host refuses its sessions"
        );
        let master = self.clone();
        let child = child.clone();
        tokio::spawn(async move {
            if let Err(error) = master.stop_process(&child).await {
                tracing::debug!(connection = master.connection(), %error, "SSH command master did not stop for its recycle");
            }
        });
    }

    fn watch_exit(&self, child: SupervisedSsh, was_ready: Arc<AtomicBool>) {
        let master = self.clone();
        tokio::spawn(async move {
            let _ = child.exited().await;
            let delay = {
                let mut state = master.lock();
                if state.proc.as_ref() != Some(&child) {
                    return;
                }
                state.proc = None;
                drop(state);
                master.inner.sessions.unregister_master(master.inner.owner);
                let mut state = master.lock();
                if state.stopped {
                    return;
                }
                tracing::debug!(
                    connection = master.connection(),
                    "SSH command master exited"
                );
                let recycled = state.recycling == Some(child.id());
                if recycled {
                    state.recycling = None;
                }
                if !was_ready.load(Ordering::SeqCst) || state.restart_timer.is_some() {
                    return;
                }
                if recycled {
                    0
                } else {
                    master.inner.deps.restart_delay_ms
                }
            };
            let restarting = master.clone();
            let timer = tokio::spawn(async move {
                restarting
                    .inner
                    .sessions
                    .clock()
                    .sleep(Duration::from_millis(delay))
                    .await;
                restarting.lock().restart_timer = None;
                drop(restarting.ensure());
            });
            master.lock().restart_timer = Some(timer.abort_handle());
        });
    }

    async fn stop_process(&self, child: &SupervisedSsh) -> Result<(), String> {
        let deps = &self.inner.deps;
        stop_child(
            child,
            &**self.inner.sessions.clock(),
            Duration::from_millis(deps.stop_timeout_ms),
            Duration::from_millis(deps.force_kill_timeout_ms),
            |_, _| {},
            "SSH command master",
        )
        .await
        .map_err(|error| format!("{error} connection={}", self.connection()))
    }

    /// Lets commands in flight over the master finish: `-O stop` closes its
    /// control socket to new sessions, and running ones get the drain time.
    async fn drain(&self, child: &SupervisedSsh) {
        if !(self.inner.deps.exists)(self.path()) {
            return;
        }
        if let Ok(argv) = ssh_master_stop_argv(&self.inner.config.destination, self.path()) {
            let _ = (self.inner.deps.run_check)(argv).await;
        }
        let clock = self.inner.sessions.clock();
        tokio::select! {
            () = self.inner.sessions.mux_sessions_idle(self.path()) => {}
            _ = child.exited() => {}
            () = clock.sleep(Duration::from_millis(self.inner.deps.drain_timeout_ms)) => {}
        }
    }

    /// Stops for good. New commands go cold at once; commands in flight
    /// over the master get a bounded drain before it is killed.
    pub fn stop(&self) -> StopTask {
        let mut state = self.lock();
        if let Some(task) = &state.stop_task {
            return task.clone();
        }
        state.stopped = true;
        if let Some(timer) = state.restart_timer.take() {
            timer.abort();
        }
        let child = state.proc.take();
        drop(state);
        self.inner.sessions.unregister_master(self.inner.owner);
        let master = self.clone();
        let handle = tokio::spawn(async move {
            let Some(child) = child else {
                return Ok(());
            };
            master.drain(&child).await;
            master.stop_process(&child).await?;
            // The runtime directory removal that follows takes it otherwise.
            let _ = (master.inner.deps.remove)(master.path());
            Ok(())
        });
        let task: StopTask =
            async move { handle.await.unwrap_or_else(|error| Err(error.to_string())) }
                .boxed()
                .shared();
        self.lock().stop_task = Some(task.clone());
        task
    }
}

fn ready<T: Clone + Send + Sync + 'static>(value: T) -> Shared<BoxFuture<T>> {
    let future: BoxFuture<T> = Box::pin(std::future::ready(value));
    future.shared()
}

/// Where SSH profile runtimes make their private directories by default:
/// /tmp, short enough for the sockets in them everywhere.
pub const SSH_RUNTIME_DIRECTORY_ROOT: &str = "/tmp";
/// Written into each runtime directory: the pid of the Roamgate owning it.
pub const SSH_RUNTIME_OWNER_FILE: &str = "owner.pid";

/// Where SSH profile runtimes make their directories and where the orphan
/// sweep looks: ROAMGATE_SSH_RUNTIME_DIR when set and not empty, else /tmp.
pub fn ssh_runtime_directory_root(environment: &dyn roamgate_base::env::Env) -> String {
    roamgate_base::env::roamgate_env(environment, "SSH_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| SSH_RUNTIME_DIRECTORY_ROOT.to_owned())
}

type RunExit = dyn Fn(Vec<String>) -> BoxFuture<Result<i32, String>> + Send + Sync;
type RemoveDirectory = dyn Fn(&std::path::Path) -> std::io::Result<()> + Send + Sync;

/// What [`sweep_orphaned_ssh_masters`] looks at and does.
pub struct SweepOptions {
    pub root: String,
    pub uid: u32,
    pub is_process_alive: Box<dyn Fn(i32) -> bool + Send + Sync>,
    pub run_exit: Box<RunExit>,
    pub remove: Box<RemoveDirectory>,
}

#[cfg(unix)]
impl SweepOptions {
    /// The real ones: this process's uid, `kill -0`, ssh `-O exit` through
    /// `runner`.
    pub fn real(root: String, runner: ProcessRunner) -> Self {
        Self {
            root,
            uid: rustix::process::getuid().as_raw(),
            is_process_alive: Box::new(process_alive),
            run_exit: Box::new(move |argv| {
                let runner = runner.clone();
                Box::pin(async move {
                    Ok(run_quietly(
                        &runner,
                        &SshCommand::plain(argv),
                        Duration::from_secs(5),
                        None,
                    )
                    .await)
                })
            }),
            remove: Box::new(|path| std::fs::remove_dir_all(path)),
        }
    }
}

#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    let Some(pid) = rustix::process::Pid::from_raw(pid) else {
        return false;
    };
    // EPERM: alive, but someone else's; never ours to clean up after.
    !matches!(
        rustix::process::test_kill_process(pid),
        Err(error) if error == rustix::io::Errno::SRCH
    )
}

#[cfg(unix)]
fn is_runtime_directory_name(name: &str) -> bool {
    name.strip_prefix("roamgate-ssh-").is_some_and(|rest| {
        rest.len() == 6 && rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

/// Ends command masters left behind when a Roamgate that owned them
/// crashed. Only private `roamgate-ssh-XXXXXX` runtime directories of the
/// current user whose recorded owner pid is gone are touched: their `m.ctl`
/// is sent `-O exit`, then the directory is removed. A failed exit keeps the
/// socket, so a later sweep can still stop that master.
#[cfg(unix)]
pub async fn sweep_orphaned_ssh_masters(options: &SweepOptions) -> usize {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let Ok(entries) = std::fs::read_dir(&options.root) else {
        return 0;
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_runtime_directory_name(name))
        .collect();
    names.sort();
    let mut swept = 0;
    for name in names {
        let directory = std::path::Path::new(&options.root).join(&name);
        let Ok(info) = std::fs::symlink_metadata(&directory) else {
            continue;
        };
        if !info.is_dir() || info.uid() != options.uid || info.mode() & 0o077 != 0 {
            continue;
        }
        let owner_path = directory.join(SSH_RUNTIME_OWNER_FILE);
        let Ok(owner) = std::fs::symlink_metadata(&owner_path) else {
            continue;
        };
        if !owner.is_file() || owner.uid() != options.uid {
            continue;
        }
        let Some(pid) = std::fs::read_to_string(&owner_path)
            .ok()
            .and_then(|text| text.trim().parse::<i32>().ok())
            .filter(|pid| *pid > 0)
        else {
            continue;
        };
        if (options.is_process_alive)(pid) {
            continue;
        }
        let control_path = directory.join("m.ctl");
        if let Ok(socket) = std::fs::symlink_metadata(&control_path)
            && socket.file_type().is_socket()
            && socket.uid() == options.uid
        {
            let argv = super::command::ssh_master_exit_argv(&control_path.to_string_lossy());
            if (options.run_exit)(argv).await != Ok(0) {
                tracing::debug!(directory = %directory.display(), "Orphaned SSH master exit failed; retaining its socket");
                continue;
            }
        }
        match (options.remove)(&directory) {
            Ok(()) => swept += 1,
            Err(error) => {
                tracing::debug!(directory = %directory.display(), %error, "Could not sweep an orphaned SSH runtime directory");
            }
        }
    }
    if swept > 0 {
        tracing::debug!(swept, "Swept orphaned SSH runtime directories");
    }
    swept
}

/// Windows keeps no orphaned masters: the sweep finds nothing.
#[cfg(not(unix))]
pub async fn sweep_orphaned_ssh_masters(_options: &SweepOptions) -> usize {
    0
}

#[cfg(test)]
mod tests;
