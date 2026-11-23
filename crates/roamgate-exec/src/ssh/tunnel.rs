//! The Herdr tunnel of an SSH connection (bridge/ssh-tunnel.ts): one ssh
//! process with stream-local forwards of Herdr's control and client
//! sockets, the remote HOME probe that finds them, the Herdr relay it runs
//! in front of the control socket (ssh::herdr_relay), readiness, failure
//! classification, and the runtime's command master started beside it.
//!
//! A Windows host's tunnel (PowerShell stdio bridges) is ssh::windows's;
//! callers pick it from `remote_platform`.

use super::windows::{RunRemote, WindowsTunnel, WindowsTunnelConfig};
use crate::process::ProcessRunner;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_base::clock::BoxFuture;
use tokio::sync::watch;

use super::command::{SshAnnotation, SshCommand, StreamForward, ssh_tunnel_argv};
use super::herdr_relay::{HerdrRelay, herdr_relay, random_relay_token};
use super::master::{MasterDeps, SshMaster, SshMasterConfig};
use super::sessions::SshSessions;
use super::supervised::{KillSignal, SupervisedSsh, stop_child};

/// Why the tunnel failed, as the page is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshTunnelFailureKind {
    Authentication,
    Permission,
    HostKey,
    Unreachable,
    Unsupported,
    Exited,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SshTunnelError {
    pub message: String,
    pub retryable: bool,
    pub kind: SshTunnelFailureKind,
    pub exit_code: i32,
}

impl SshTunnelError {
    pub fn new(
        message: impl Into<String>,
        retryable: bool,
        kind: SshTunnelFailureKind,
        exit_code: i32,
    ) -> Self {
        Self {
            message: message.into(),
            retryable,
            kind,
            exit_code,
        }
    }
}

/// What a tunnel start or cleanup can fail with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TunnelError {
    #[error(transparent)]
    Failure(#[from] SshTunnelError),
    #[error("{0}")]
    Message(String),
}

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f-\u{9f}]").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// Classifies an ssh exit from its stderr, without passing the raw stderr
/// on: permanent failures (host key, permission, authentication) are not
/// retried; the network ones are.
pub fn classify_ssh_tunnel_failure(exit_code: i32, stderr: &str) -> SshTunnelError {
    let diagnostic = ANSI.replace_all(stderr, "");
    let diagnostic = CONTROL.replace_all(&diagnostic, " ");
    let diagnostic = SPACES.replace_all(&diagnostic, " ").to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| diagnostic.contains(needle));
    use SshTunnelFailureKind::*;
    if has(&[
        "remote host identification has changed",
        "host key verification failed",
        "no matching host key type found",
    ]) {
        return SshTunnelError::new(
            "SSH host-key verification failed; verify the host outside Roamgate",
            false,
            HostKey,
            exit_code,
        );
    }
    if has(&["for an elevated server, use an administrator terminal"]) {
        return SshTunnelError::new(
            "Windows Herdr denied access to its server. Match the server's privilege level (use an administrator client for an elevated server). Sharing with ordinary clients requires explicitly enabling allow_unelevated_clients and restarting Herdr, which closes panes.",
            false,
            Permission,
            exit_code,
        );
    }
    if has(&[
        "permission denied",
        "no supported authentication methods",
        "too many authentication failures",
    ]) {
        return SshTunnelError::new(
            "SSH authentication failed; verify the service user's OpenSSH agent and config",
            false,
            Authentication,
            exit_code,
        );
    }
    if has(&[
        "connection timed out",
        "connection refused",
        "no route to host",
        "could not resolve hostname",
        "operation timed out",
    ]) {
        return SshTunnelError::new(
            "SSH destination is temporarily unreachable",
            true,
            Unreachable,
            exit_code,
        );
    }
    SshTunnelError::new(
        format!("SSH tunnel exited unexpectedly (code {exit_code})"),
        true,
        Exited,
        exit_code,
    )
}

/// Refuses Windows as the local platform: stream-local forwarding cannot
/// create a local Windows named pipe.
pub fn assert_ssh_tunnel_platform_supported(windows: bool) -> Result<(), SshTunnelError> {
    if windows {
        return Err(SshTunnelError::new(
            "SSH connections from Windows are not supported because Roamgate's stream-local forwarding cannot create a local Windows named pipe",
            false,
            SshTunnelFailureKind::Unsupported,
            -1,
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePlatform {
    Windows,
}

#[derive(Debug, Clone, Default)]
pub struct SshTunnelConfig {
    pub socket_path: String,
    pub client_socket_path: String,
    pub ssh_host: Option<String>,
    pub session: Option<String>,
    pub has_explicit_socket_path: bool,
    pub has_explicit_client_socket_path: bool,
    pub remote_socket_path: Option<String>,
    pub remote_client_socket_path: Option<String>,
    pub owned_runtime_directory: Option<String>,
    pub remote_platform: Option<RemotePlatform>,
    pub remote_herdr_path: Option<String>,
    /// Control socket of the runtime's command master; unset disables it.
    pub master_control_path: Option<String>,
    /// Puts the Herdr relay (ssh::herdr_relay) in front of the host's
    /// control socket, so Herdr answers calls at once instead of 100 ms
    /// late. A host where it does not start gets the direct forward instead.
    pub herdr_relay: bool,
}

/// What a run of the HOME probe printed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
}

/// Runs a host command: argv, input, timeout in milliseconds.
pub type RunProcess = Arc<
    dyn Fn(SshCommand, Option<String>, Option<u64>) -> BoxFuture<Result<ProcessOutput, String>>
        + Send
        + Sync,
>;

/// The tunnel's view of the command master.
pub trait MasterControl: Send + Sync {
    /// Starts it unless it runs; the start goes on without being awaited.
    fn ensure(&self) -> BoxFuture<bool>;
    fn stop(&self) -> BoxFuture<Result<(), String>>;
}

impl MasterControl for SshMaster {
    fn ensure(&self) -> BoxFuture<bool> {
        Box::pin(SshMaster::ensure(self))
    }

    fn stop(&self) -> BoxFuture<Result<(), String>> {
        Box::pin(SshMaster::stop(self))
    }
}

/// A readiness poll scheduled by the tunnel: `fired` resolves after the
/// interval; `cancel` runs when the wait ends before it did.
pub struct ScheduledPoll {
    pub fired: BoxFuture<()>,
    pub cancel: Box<dyn FnOnce() + Send>,
}

type CreateMaster = dyn Fn(&str, &str) -> Arc<dyn MasterControl> + Send + Sync;

/// What the tunnel does to the world, replaceable in tests.
#[derive(Clone)]
pub struct TunnelDeps {
    pub exists: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub remove: Arc<dyn Fn(&str) + Send + Sync>,
    pub remove_directory: Arc<dyn Fn(&str) + Send + Sync>,
    pub spawn: Arc<dyn Fn(SshCommand) -> Result<SupervisedSsh, String> + Send + Sync>,
    /// Spawns a tunnel running the Herdr relay ([`SupervisedSsh::spawn_relay`]).
    pub spawn_relay: Arc<dyn Fn(SshCommand) -> Result<SupervisedSsh, String> + Send + Sync>,
    /// Names the relay's socket on the host; random by default.
    pub relay_token: Arc<dyn Fn() -> String + Send + Sync>,
    /// None: the clock's own sleep.
    pub schedule_poll: Option<Arc<dyn Fn(Duration) -> ScheduledPoll + Send + Sync>>,
    pub socket_wait_timeout_ms: i64,
    pub socket_poll_interval_ms: u64,
    pub process_stop_timeout_ms: u64,
    pub process_force_kill_timeout_ms: u64,
    /// Whether this machine is Windows.
    pub windows: bool,
    /// None: an [`SshMaster`] on the real dependencies.
    pub create_master: Option<Arc<CreateMaster>>,
}

impl Default for TunnelDeps {
    /// [`TunnelDeps::real`] on a runner of the real clock with no observer.
    fn default() -> Self {
        Self::real(ProcessRunner::system())
    }
}

impl TunnelDeps {
    /// The real ones, ssh children running through `runner`.
    pub fn real(runner: ProcessRunner) -> Self {
        Self {
            exists: Arc::new(|path| std::path::Path::new(path).exists()),
            remove: Arc::new(|path| {
                let _ = std::fs::remove_file(path);
            }),
            remove_directory: Arc::new(|path| {
                let _ = std::fs::remove_dir_all(path);
            }),
            spawn: Arc::new({
                let runner = runner.clone();
                move |command| SupervisedSsh::spawn(&runner, &command)
            }),
            spawn_relay: Arc::new(move |command| SupervisedSsh::spawn_relay(&runner, &command)),
            relay_token: Arc::new(random_relay_token),
            schedule_poll: None,
            socket_wait_timeout_ms: 8000,
            socket_poll_interval_ms: 100,
            process_stop_timeout_ms: 1500,
            process_force_kill_timeout_ms: 1000,
            windows: cfg!(windows),
            create_master: None,
        }
    }
}

/// Everything a tunnel manager is made from.
pub struct SshTunnelArgs {
    pub sessions: SshSessions,
    pub connection_id: Option<String>,
    pub config: SshTunnelConfig,
    pub run_process: RunProcess,
    pub on_unexpected_exit: Option<Arc<dyn Fn(TunnelError) + Send + Sync>>,
    /// Runs each time the command master becomes ready.
    pub on_master_ready: Option<Arc<dyn Fn() + Send + Sync>>,
    pub deps: TunnelDeps,
}

/// A Windows host's tunnel from the tunnel's arguments: its probe through
/// the manager's `run_process`, its bridges through the sessions' runner.
fn windows_tunnel(args: &SshTunnelArgs) -> Result<WindowsTunnel, SshTunnelError> {
    let config = &args.config;
    let Some(host) = config.ssh_host.clone() else {
        return Err(SshTunnelError::new(
            "A Windows SSH connection needs its destination",
            false,
            SshTunnelFailureKind::Unsupported,
            -1,
        ));
    };
    let run_process = args.run_process.clone();
    let run_remote: RunRemote = Arc::new(move |command| {
        let run = run_process(command, None, None);
        Box::pin(async move { run.await.map(|output| output.stdout) })
    });
    let on_exit = args.on_unexpected_exit.clone().map(|report| {
        Arc::new(move |error: SshTunnelError| report(TunnelError::Failure(error)))
            as super::windows::OnUnexpectedExit
    });
    Ok(WindowsTunnel::new(
        WindowsTunnelConfig {
            socket_path: config.socket_path.clone().into(),
            client_socket_path: config.client_socket_path.clone().into(),
            ssh_host: host,
            session: config.session.clone(),
            remote_herdr_path: config.remote_herdr_path.clone(),
            owned_runtime_directory: config.owned_runtime_directory.clone().map(Into::into),
        },
        args.sessions.clone(),
        run_remote,
        None,
        on_exit,
    ))
}

// Hard cap on the HOME probe: a stuck probe blocks the whole connection.
const REMOTE_HOME_PROBE_TIMEOUT_MS: u64 = 20_000;

type Task = Shared<BoxFuture<Result<(), TunnelError>>>;

#[derive(Default)]
struct TunnelState {
    /// Set when the relay did not start on the host (no python3, say): its
    /// tunnels forward Herdr's socket directly from then on.
    relay_unavailable: bool,
    cached_home: Option<(String, String)>,
    proc: Option<SupervisedSsh>,
    stop_task: Option<Task>,
    paths: Vec<String>,
    disposed: bool,
    cleanup_task: Option<Task>,
}

struct TunnelInner {
    args: SshTunnelArgs,
    master: Option<Arc<dyn MasterControl>>,
    /// A Windows host's tunnel, which does all the work then.
    windows: Option<WindowsTunnel>,
    state: Mutex<TunnelState>,
    generation: watch::Sender<u64>,
}

/// One connection's Herdr tunnel. Clones are the same tunnel.
#[derive(Clone)]
pub struct SshTunnelManager {
    inner: Arc<TunnelInner>,
}

enum Outcome {
    Ready,
    Exited(Result<i32, String>),
    Failed(String),
    /// The relay never said it listens.
    RelayTimedOut,
    Cancelled,
}

// ssh's own exit status for a connection error; anything else is the remote
// command's.
const SSH_CONNECTION_FAILED: i32 = 255;

impl SshTunnelManager {
    /// The tunnel of a host: a POSIX host's stream-local forwards, or for a
    /// Windows host (`remote_platform`) the bridges of ssh::windows, after
    /// the local platform check (createSshTunnelManager).
    pub fn new(args: SshTunnelArgs) -> Result<Self, SshTunnelError> {
        if args.config.remote_platform == Some(RemotePlatform::Windows) {
            assert_ssh_tunnel_platform_supported(args.deps.windows)?;
            let windows = Some(windows_tunnel(&args)?);
            return Ok(Self {
                inner: Arc::new(TunnelInner {
                    args,
                    master: None,
                    windows,
                    state: Mutex::default(),
                    generation: watch::channel(0).0,
                }),
            });
        }
        let master = match (&args.config.ssh_host, &args.config.master_control_path) {
            (Some(host), Some(path)) => Some(match &args.deps.create_master {
                Some(create) => create(host, path),
                None => {
                    let connection = args
                        .connection_id
                        .clone()
                        .unwrap_or_else(|| "legacy-default".into());
                    Arc::new(SshMaster::new(
                        args.sessions.clone(),
                        SshMasterConfig {
                            destination: host.clone(),
                            control_path: path.clone(),
                            connection_id: args.connection_id.clone(),
                            on_ready: args.on_master_ready.clone(),
                        },
                        MasterDeps::real(&args.sessions, &connection, None),
                    )) as Arc<dyn MasterControl>
                }
            }),
            _ => None,
        };
        Ok(Self {
            inner: Arc::new(TunnelInner {
                state: Mutex::new(TunnelState {
                    relay_unavailable: !args.config.herdr_relay,
                    ..TunnelState::default()
                }),
                args,
                master,
                windows: None,
                generation: watch::channel(0).0,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, TunnelState> {
        self.inner.state.lock().expect("ssh tunnel")
    }

    fn connection(&self) -> String {
        self.inner
            .args
            .connection_id
            .clone()
            .unwrap_or_else(|| "legacy-default".into())
    }

    fn generation(&self) -> u64 {
        *self.inner.generation.borrow()
    }

    fn bump(&self) -> u64 {
        let mut next = 0;
        self.inner.generation.send_modify(|value| {
            *value += 1;
            next = *value;
        });
        next
    }

    async fn remote_home(&self, host: &str) -> Result<String, TunnelError> {
        if let Some((cached, home)) = &self.lock().cached_home
            && cached == host
        {
            return Ok(home.clone());
        }
        let mut command = self
            .inner
            .args
            .sessions
            .read_command_argv(host, r#"printf %s "$HOME""#, &[], Some("home.probe"))
            .map_err(|error| TunnelError::Message(error.to_string()))?;
        if let Some(connection) = &self.inner.args.connection_id {
            command = command.for_connection(connection);
        }
        let output =
            (self.inner.args.run_process)(command, None, Some(REMOTE_HOME_PROBE_TIMEOUT_MS))
                .await
                .map_err(TunnelError::Message)?;
        let home = output.stdout.trim().to_owned();
        if !home.starts_with('/') {
            return Err(TunnelError::Message(format!(
                "could not resolve remote HOME for {host}"
            )));
        }
        self.lock().cached_home = Some((host.to_owned(), home.clone()));
        Ok(home)
    }

    async fn remote_socket(&self, host: &str, control: bool) -> Result<String, TunnelError> {
        let home = self.remote_home(host).await?;
        let base = format!("{home}/.config/herdr");
        let file = if control {
            "herdr.sock"
        } else {
            "herdr-client.sock"
        };
        Ok(match &self.inner.args.config.session {
            Some(session) => format!("{base}/sessions/{session}/{file}"),
            None => format!("{base}/{file}"),
        })
    }

    fn schedule_poll(&self) -> ScheduledPoll {
        let interval = Duration::from_millis(self.inner.args.deps.socket_poll_interval_ms);
        match &self.inner.args.deps.schedule_poll {
            Some(schedule) => schedule(interval),
            None => ScheduledPoll {
                fired: self.inner.args.sessions.clock().sleep(interval),
                cancel: Box::new(|| {}),
            },
        }
    }

    /// Resolves once every path exists, or fails past the socket timeout.
    /// Dropped (an exit, a newer start, a cleanup), it cancels its poll.
    async fn wait_for_sockets(&self, paths: &[String]) -> Result<(), String> {
        let clock = self.inner.args.sessions.clock().clone();
        let started = clock.now();
        loop {
            if paths.iter().all(|path| (self.inner.args.deps.exists)(path)) {
                return Ok(());
            }
            if clock.now() - started > self.inner.args.deps.socket_wait_timeout_ms {
                return Err(format!(
                    "ssh tunnel did not create local socket(s): {}",
                    paths.join(", ")
                ));
            }
            let poll = self.schedule_poll();
            let mut pending = PendingPoll(Some(poll.cancel));
            poll.fired.await;
            pending.0 = None;
        }
    }

    async fn stop_tunnel_process(&self) -> Result<(), TunnelError> {
        let task = {
            let mut state = self.lock();
            if let Some(task) = &state.stop_task {
                task.clone()
            } else {
                let Some(proc) = state.proc.take() else {
                    return Ok(());
                };
                let tunnel = self.clone();
                let task: Task = async move {
                    let deps = &tunnel.inner.args.deps;
                    let connection = tunnel.connection();
                    stop_child(
                        &proc,
                        &**tunnel.inner.args.sessions.clock(),
                        Duration::from_millis(deps.process_stop_timeout_ms),
                        Duration::from_millis(deps.process_force_kill_timeout_ms),
                        |signal, error| {
                            if signal == KillSignal::Term {
                                tracing::warn!(connection = %connection, %error, "unable to stop SSH tunnel");
                            } else {
                                tracing::warn!(connection = %connection, %error, "unable to force-stop SSH tunnel");
                            }
                        },
                        "SSH tunnel",
                    )
                    .await
                    .map_err(|error| {
                        TunnelError::Message(format!("{error} connection={}", tunnel.connection()))
                    })
                }
                .boxed()
                .shared();
                state.stop_task = Some(task.clone());
                task
            }
        };
        let outcome = task.clone().await;
        let mut state = self.lock();
        if state
            .stop_task
            .as_ref()
            .is_some_and(|current| current.ptr_eq(&task))
        {
            state.stop_task = None;
        }
        outcome
    }

    /// Starts (or restarts) the tunnel; resolves once its sockets exist.
    pub async fn start(&self) -> Result<(), TunnelError> {
        if let Some(windows) = &self.inner.windows {
            return Ok(windows.start().await?);
        }
        if self.lock().disposed {
            return Err(TunnelError::Message(
                "SSH tunnel manager is disposed".into(),
            ));
        }
        let config = &self.inner.args.config;
        let Some(host) = config.ssh_host.clone() else {
            return Ok(());
        };
        assert_ssh_tunnel_platform_supported(self.inner.args.deps.windows)?;
        // Started beside the tunnel and never awaited: until it is ready,
        // commands (the HOME probe too) open their own connection.
        if let Some(master) = &self.inner.master {
            drop(master.ensure());
        }
        let generation = self.bump();
        self.stop_tunnel_process().await?;
        if generation != self.generation() {
            return Ok(());
        }
        let mut forwards: Vec<(StreamForward, &str)> = Vec::new();
        if config.remote_socket_path.is_some() || !config.has_explicit_socket_path {
            let remote = match &config.remote_socket_path {
                Some(path) => path.clone(),
                None => self.remote_socket(&host, true).await?,
            };
            if generation != self.generation() {
                return Ok(());
            }
            forwards.push((
                StreamForward {
                    local: config.socket_path.clone(),
                    remote,
                },
                "herdr socket",
            ));
        }
        if config.remote_client_socket_path.is_some() || !config.has_explicit_client_socket_path {
            let remote = match &config.remote_client_socket_path {
                Some(path) => path.clone(),
                None => self.remote_socket(&host, false).await?,
            };
            if generation != self.generation() {
                return Ok(());
            }
            forwards.push((
                StreamForward {
                    local: config.client_socket_path.clone(),
                    remote,
                },
                "herdr client socket",
            ));
        }
        if forwards.is_empty() {
            return Ok(());
        }
        let control = forwards
            .iter()
            .position(|(_, label)| *label == "herdr socket");
        let mut relay: Option<HerdrRelay> = None;
        if let Some(index) = control
            && !self.lock().relay_unavailable
        {
            let made = match self.remote_home(&host).await {
                Ok(home) => herdr_relay(
                    &home,
                    &forwards[index].0.remote,
                    &(self.inner.args.deps.relay_token)(),
                )
                .map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            match made {
                Ok(made) => relay = made,
                Err(error) => {
                    tracing::warn!(connection = %self.connection(), %error, "Herdr relay unavailable, forwarding Herdr directly");
                }
            }
            if generation != self.generation() {
                return Ok(());
            }
            if let Some(relay) = &relay {
                forwards[index].0.remote = relay.socket.clone();
                forwards[index].1 = "herdr socket (relay)";
            }
        }
        let paths: Vec<String> = forwards
            .iter()
            .map(|(forward, _)| forward.local.clone())
            .collect();
        self.lock().paths = paths.clone();
        for path in &paths {
            (self.inner.args.deps.remove)(path);
        }
        let streams: Vec<StreamForward> = forwards
            .iter()
            .map(|(forward, _)| forward.clone())
            .collect();
        let argv = ssh_tunnel_argv(
            &host,
            &streams,
            relay.as_ref().map(|relay| relay.command.as_str()),
        )
        .map_err(|error| TunnelError::Message(error.to_string()))?;
        let command = SshCommand::plain(argv).annotated(SshAnnotation {
            tag: Some("tunnel".into()),
            connection: self.inner.args.connection_id.clone(),
            master: false,
        });
        tracing::debug!(connection = %self.connection(), destination = %host, "starting SSH tunnel");
        for (forward, label) in &forwards {
            tracing::debug!(connection = %self.connection(), label, local = %forward.local, remote = %forward.remote, "SSH tunnel forwarding socket");
        }
        let spawn = if relay.is_some() {
            &self.inner.args.deps.spawn_relay
        } else {
            &self.inner.args.deps.spawn
        };
        let proc = spawn(command).map_err(TunnelError::Message)?;
        self.lock().proc = Some(proc.clone());
        let mut generations = self.inner.generation.subscribe();
        let outcome = tokio::select! {
            ready = async {
                self.wait_for_sockets(&paths).await?;
                Ok::<_, String>(if relay.is_some() {
                    self.wait_for_relay(&proc).await
                } else {
                    Outcome::Ready
                })
            } => match ready {
                Ok(outcome) => outcome,
                Err(error) => Outcome::Failed(error),
            },
            exit = proc.exited() => Outcome::Exited(exit),
            _ = generations.wait_for(|current| *current != generation) => Outcome::Cancelled,
        };
        let relay_failed = relay.is_some()
            && match &outcome {
                Outcome::RelayTimedOut => true,
                Outcome::Exited(Ok(code)) => *code != SSH_CONNECTION_FAILED,
                _ => false,
            };
        if relay_failed {
            if generation != self.generation() {
                return Ok(());
            }
            // ssh connected, but the relay did not start: no python3 on the
            // host, a home it cannot write. The direct forward works there.
            if self.lock().proc.as_ref() == Some(&proc) {
                self.stop_tunnel_process().await?;
            }
            self.lock().relay_unavailable = true;
            let stderr = proc.stderr().await;
            let error = if stderr.trim().is_empty() {
                "timed out".to_owned()
            } else {
                SPACES
                    .replace_all(stderr.trim(), " ")
                    .chars()
                    .take(300)
                    .collect()
            };
            tracing::warn!(connection = %self.connection(), %error, "Herdr relay did not start, forwarding Herdr directly");
            if generation != self.generation() {
                return Ok(());
            }
            return Box::pin(self.start()).await;
        }
        match outcome {
            Outcome::Cancelled => return Ok(()),
            Outcome::Failed(error) => {
                if self.lock().proc.as_ref() == Some(&proc) {
                    self.stop_tunnel_process().await?;
                }
                return Err(TunnelError::Message(error));
            }
            Outcome::RelayTimedOut => unreachable!("handled with the relay"),
            Outcome::Exited(exit) => {
                if generation != self.generation() {
                    return Ok(());
                }
                {
                    let mut state = self.lock();
                    if state.proc.as_ref() == Some(&proc) {
                        state.proc = None;
                    }
                }
                return Err(self.failure(&proc, exit).await);
            }
            Outcome::Ready => {}
        }
        if generation != self.generation() {
            return Ok(());
        }
        let tunnel = self.clone();
        let relayed = relay.is_some();
        tokio::spawn(async move {
            let exit = proc.exited().await;
            let relay_ended = relayed && !matches!(exit, Ok(SSH_CONNECTION_FAILED));
            let failure = tunnel.failure(&proc, exit).await;
            {
                let mut state = tunnel.lock();
                if state.disposed
                    || generation != tunnel.generation()
                    || state.proc.as_ref() != Some(&proc)
                {
                    return;
                }
                state.proc = None;
                if relay_ended {
                    // The connection held but the relay ended: reconnect
                    // without it.
                    state.relay_unavailable = true;
                    tracing::warn!(connection = %tunnel.connection(), "Herdr relay exited, forwarding Herdr directly");
                }
            }
            if let Some(report) = &tunnel.inner.args.on_unexpected_exit {
                report(failure);
            }
        });
        tracing::debug!(connection = %self.connection(), "SSH tunnel ready");
        Ok(())
    }

    /// Once the local sockets listen, waits for the relay to listen on the
    /// host: a call made before would fail.
    async fn wait_for_relay(&self, proc: &SupervisedSsh) -> Outcome {
        let clock = self.inner.args.sessions.clock().clone();
        let wait = Duration::from_millis(self.inner.args.deps.socket_wait_timeout_ms.max(0) as u64);
        match roamgate_base::clock::timeout(&*clock, wait, proc.relay_ready()).await {
            Ok(true) => Outcome::Ready,
            Ok(false) => Outcome::Exited(proc.exited().await),
            Err(_) => Outcome::RelayTimedOut,
        }
    }

    async fn failure(&self, proc: &SupervisedSsh, exit: Result<i32, String>) -> TunnelError {
        match exit {
            Ok(code) => {
                TunnelError::Failure(classify_ssh_tunnel_failure(code, &proc.stderr().await))
            }
            Err(error) => TunnelError::Failure(SshTunnelError::new(
                format!("SSH tunnel process failed: {error}"),
                true,
                SshTunnelFailureKind::Exited,
                -1,
            )),
        }
    }

    /// Stops the tunnel and the master for good, then removes what the
    /// tunnel made; paths stay when a process could not be stopped.
    pub fn cleanup(&self) -> Task {
        let mut state = self.lock();
        if let Some(task) = &state.cleanup_task {
            return task.clone();
        }
        if let Some(windows) = self.inner.windows.clone() {
            state.disposed = true;
            let task: Task = async move {
                windows.cleanup().await;
                Ok(())
            }
            .boxed()
            .shared();
            state.cleanup_task = Some(task.clone());
            return task;
        }
        state.disposed = true;
        let paths = std::mem::take(&mut state.paths);
        drop(state);
        self.bump();
        let tunnel = self.clone();
        let handle = tokio::spawn(async move {
            let master = tunnel.inner.master.clone();
            let (tunnel_stop, master_stop) = tokio::join!(tunnel.stop_tunnel_process(), async {
                match master {
                    Some(master) => master.stop().await,
                    None => Ok(()),
                }
            });
            tunnel_stop?;
            master_stop.map_err(TunnelError::Message)?;
            for path in &paths {
                (tunnel.inner.args.deps.remove)(path);
            }
            if let Some(directory) = &tunnel.inner.args.config.owned_runtime_directory {
                (tunnel.inner.args.deps.remove_directory)(directory);
            }
            Ok(())
        });
        let task: Task = async move {
            handle
                .await
                .unwrap_or_else(|error| Err(TunnelError::Message(error.to_string())))
        }
        .boxed()
        .shared();
        self.lock().cleanup_task = Some(task.clone());
        task
    }
}

/// A scheduled poll not fired yet: cancelled when dropped.
struct PendingPoll(Option<Box<dyn FnOnce() + Send>>);

impl Drop for PendingPoll {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel();
        }
    }
}

#[cfg(test)]
mod tests;
