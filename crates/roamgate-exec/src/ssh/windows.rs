//! Windows hosts over SSH (bridge/ssh-windows.ts): Herdr on Windows has no
//! Unix sockets to forward, so each local socket (control and client)
//! accepts connections itself and runs, per connection, a long-lived ssh
//! child whose stdio is Herdr's `remote-api-bridge` or
//! `remote-client-bridge`, started through a PowerShell script that keeps
//! native stdio (PowerShell's `&` pipeline corrupts binary frames).
//!
//! Before listening, a probe script finds herdr.exe on the host (the one
//! configured, else on PATH, else the default install) and checks the
//! selected session runs; its failures are told apart (unsupported host,
//! stopped session, status failure, authentication, Windows permission).
//!
//! The server never makes one on Windows itself (the SSH tunnel's platform
//! check refuses SSH connections from Windows first), so the listeners are
//! Unix sockets.
//!
//! The probe runs over the destination's master when one listens
//! ([`SshSessions::command_argv`]); the bridges never do. Bridges are
//! children of the sessions' [`ProcessRunner`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::FutureExt as _;
use futures_util::future::Shared;
use roamgate_base::clock::{BoxFuture, SharedClock, timeout};
#[cfg(unix)]
use tokio::io::AsyncWriteExt as _;
use tokio::sync::{Notify, watch};

use roamgate_base::assets::{HERDR_BRIDGE_PS1, HERDR_PROBE_PS1, TemplateValue, fill_template};

use super::command::SshCommand;
#[cfg(unix)]
use super::command::ssh_bridge_command_argv;
use super::sessions::SshSessions;
#[cfg(unix)]
use super::supervised::read_bounded_stderr;
use super::tunnel::{SshTunnelError, SshTunnelFailureKind, classify_ssh_tunnel_failure};
use crate::process::{Command, ExecError, ProcessRunner, Spawned};
use crate::quote::powershell_quote;

/// How long bridges told to stop have before SIGKILL, then before stopping
/// fails.
const STOP_GRACE: Duration = Duration::from_millis(1500);
const STOP_KILLED: Duration = Duration::from_millis(1000);

/// `powershell.exe` running `script`, passed as UTF-16LE base64 so no
/// shell between here and there reads it.
pub fn powershell_command(script: &str) -> String {
    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(utf16)
    )
}

/// Which of Herdr's bridges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeKind {
    /// `remote-api-bridge`: the control socket.
    Control,
    /// `remote-client-bridge`: the render client socket.
    Client,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid Windows Herdr session name")]
pub struct InvalidSession;

fn valid_session(session: &str) -> bool {
    let bytes = session.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// The remote command running Herdr's `kind` bridge of `session` with the
/// herdr.exe at `path`.
pub fn windows_herdr_bridge_command(
    path: &str,
    session: &str,
    kind: BridgeKind,
) -> Result<String, InvalidSession> {
    if !valid_session(session) {
        return Err(InvalidSession);
    }
    let command = match kind {
        BridgeKind::Control => "remote-api-bridge",
        BridgeKind::Client => "remote-client-bridge",
    };
    let script = fill_template(
        HERDR_BRIDGE_PS1,
        &[
            ("path", TemplateValue::Text(powershell_quote(path))),
            (
                "arguments",
                TemplateValue::Text(powershell_quote(&format!("--session {session} {command}"))),
            ),
        ],
    )
    .expect("herdr-bridge.ps1 takes path and arguments");
    Ok(powershell_command(&script))
}

/// What a Windows tunnel needs to know.
#[derive(Debug, Clone)]
pub struct WindowsTunnelConfig {
    pub socket_path: PathBuf,
    pub client_socket_path: PathBuf,
    pub ssh_host: String,
    pub session: Option<String>,
    pub remote_herdr_path: Option<String>,
    /// Removed on cleanup.
    pub owned_runtime_directory: Option<PathBuf>,
}

/// Runs an ssh command to its end (inside its destination's session limit):
/// its stdout, or the message of its failure (`"<program> exited <code>:
/// <stderr>"`, as runProcess throws).
pub type RunRemote = Arc<dyn Fn(SshCommand) -> BoxFuture<Result<String, String>> + Send + Sync>;
/// Starts a bridge's ssh child with piped stdio.
pub type SpawnBridge = Arc<dyn Fn(Vec<String>) -> Result<Spawned, ExecError> + Send + Sync>;
/// Told when a bridge ends badly while its connection was in use.
pub type OnUnexpectedExit = Arc<dyn Fn(SshTunnelError) + Send + Sync>;

/// The real bridge spawn: ssh with `LC_ALL=C` through `runner`, killed
/// when dropped.
pub fn spawn_ssh_bridge(runner: &ProcessRunner, argv: Vec<String>) -> Result<Spawned, ExecError> {
    runner.spawn(&Command::new(argv).env("LC_ALL", "C"), true)
}

struct Connection {
    term: Arc<Notify>,
    force: Arc<Notify>,
    done: watch::Receiver<bool>,
}

type Starting = Shared<BoxFuture<Result<(), SshTunnelError>>>;

#[derive(Default)]
struct State {
    disposed: bool,
    stopping: bool,
    listeners: Vec<tokio::task::JoinHandle<()>>,
    connections: HashMap<u64, Connection>,
    // Only a Unix server bridges connections (see the module's doc).
    #[cfg_attr(not(unix), allow(dead_code))]
    next: u64,
    starting: Option<Starting>,
    cleanup: Option<Shared<BoxFuture<()>>>,
}

struct Inner {
    config: WindowsTunnelConfig,
    run_remote: RunRemote,
    #[cfg_attr(not(unix), allow(dead_code))]
    spawn_bridge: SpawnBridge,
    #[cfg_attr(not(unix), allow(dead_code))]
    on_unexpected_exit: Option<OnUnexpectedExit>,
    sessions: SshSessions,
    clock: SharedClock,
    state: Mutex<State>,
    stop_lock: tokio::sync::Mutex<()>,
}

/// The tunnel manager of a Windows host (`createWindowsSshTunnel`).
#[derive(Clone)]
pub struct WindowsTunnel {
    inner: Arc<Inner>,
}

impl WindowsTunnel {
    /// A tunnel to `config.ssh_host` whose probe goes through `sessions`
    /// (its master when one listens) and whose bridges run through their
    /// runner (or `spawn_bridge`).
    pub fn new(
        config: WindowsTunnelConfig,
        sessions: SshSessions,
        run_remote: RunRemote,
        spawn_bridge: Option<SpawnBridge>,
        on_unexpected_exit: Option<OnUnexpectedExit>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                run_remote,
                spawn_bridge: spawn_bridge.unwrap_or_else(|| {
                    let runner = sessions.runner().clone();
                    Arc::new(move |argv| spawn_ssh_bridge(&runner, argv))
                }),
                on_unexpected_exit,
                clock: sessions.clock().clone(),
                sessions,
                state: Mutex::new(State::default()),
                stop_lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// Finds Herdr on the host and listens on both sockets
    /// (`startAutoSshTunnel`); a start under way is shared.
    pub async fn start(&self) -> Result<(), SshTunnelError> {
        let task = {
            let mut state = self.inner.state.lock().unwrap();
            if state.disposed {
                return Err(SshTunnelError::new(
                    "SSH tunnel manager is disposed",
                    false,
                    SshTunnelFailureKind::Exited,
                    -1,
                ));
            }
            if let Some(starting) = &state.starting {
                starting.clone()
            } else {
                let inner = self.inner.clone();
                let task: BoxFuture<Result<(), SshTunnelError>> =
                    Box::pin(async move { inner.start_once().await });
                let task = task.shared();
                state.starting = Some(task.clone());
                task
            }
        };
        let result = task.clone().await;
        let mut state = self.inner.state.lock().unwrap();
        if state
            .starting
            .as_ref()
            .is_some_and(|starting| starting.ptr_eq(&task))
        {
            state.starting = None;
        }
        result
    }

    /// Stops for good: no listener after it, even from a start under way
    /// (`cleanupAutoSshTunnel`).
    pub async fn cleanup(&self) {
        let task = {
            let mut state = self.inner.state.lock().unwrap();
            if let Some(cleanup) = &state.cleanup {
                cleanup.clone()
            } else {
                state.disposed = true;
                let inner = self.inner.clone();
                let starting = state.starting.clone();
                let task: BoxFuture<()> = Box::pin(async move {
                    if let Some(starting) = starting {
                        let _ = starting.await;
                    }
                    let _ = inner.stop().await;
                    if let Some(dir) = &inner.config.owned_runtime_directory {
                        let _ = std::fs::remove_dir_all(dir);
                    }
                });
                let task = task.shared();
                state.cleanup = Some(task.clone());
                task
            }
        };
        task.await
    }
}

impl Inner {
    async fn start_once(self: Arc<Self>) -> Result<(), SshTunnelError> {
        self.stop().await?;
        self.state.lock().unwrap().stopping = false;
        let path = self.resolve_herdr().await?;
        if self.state.lock().unwrap().disposed {
            return Ok(());
        }
        let session = self.config.session.as_deref().unwrap_or("default");
        let listened = async {
            let invalid = |_| {
                SshTunnelError::new(
                    "Invalid Windows Herdr session name",
                    false,
                    SshTunnelFailureKind::Unsupported,
                    -1,
                )
            };
            let control = windows_herdr_bridge_command(&path, session, BridgeKind::Control)
                .map_err(invalid)?;
            let client = windows_herdr_bridge_command(&path, session, BridgeKind::Client)
                .map_err(invalid)?;
            self.clone()
                .listen(self.config.socket_path.clone(), control)
                .await?;
            self.clone()
                .listen(self.config.client_socket_path.clone(), client)
                .await
        }
        .await;
        if let Err(error) = listened {
            let _ = self.stop().await;
            return Err(error);
        }
        Ok(())
    }

    /// Closes the listeners, ends the bridges and removes the sockets.
    async fn stop(&self) -> Result<(), SshTunnelError> {
        let _serial = self.stop_lock.lock().await;
        let connections: Vec<(Arc<Notify>, Arc<Notify>, watch::Receiver<bool>)> = {
            let mut state = self.state.lock().unwrap();
            state.stopping = true;
            for listener in state.listeners.drain(..) {
                listener.abort();
            }
            state
                .connections
                .values()
                .map(|conn| (conn.term.clone(), conn.force.clone(), conn.done.clone()))
                .collect()
        };
        for (term, ..) in &connections {
            term.notify_one();
        }
        let all_done = |connections: Vec<watch::Receiver<bool>>| async move {
            for mut done in connections {
                let _ = done.wait_for(|done| *done).await;
            }
        };
        let receivers = || connections.iter().map(|(.., done)| done.clone()).collect();
        if timeout(&*self.clock, STOP_GRACE, all_done(receivers()))
            .await
            .is_err()
        {
            for (_, force, _) in &connections {
                force.notify_one();
            }
        }
        let exited = timeout(&*self.clock, STOP_KILLED, all_done(receivers())).await;
        for path in [&self.config.socket_path, &self.config.client_socket_path] {
            let _ = std::fs::remove_file(path);
        }
        if exited.is_err() {
            return Err(SshTunnelError::new(
                "Windows SSH bridges did not exit",
                true,
                SshTunnelFailureKind::Exited,
                -1,
            ));
        }
        Ok(())
    }

    async fn resolve_herdr(&self) -> Result<String, SshTunnelError> {
        let probe = fill_template(
            HERDR_PROBE_PS1,
            &[
                (
                    "configured",
                    TemplateValue::Flag(self.config.remote_herdr_path.is_some()),
                ),
                (
                    "path",
                    TemplateValue::Text(powershell_quote(
                        self.config.remote_herdr_path.as_deref().unwrap_or(""),
                    )),
                ),
                (
                    "session",
                    TemplateValue::Text(powershell_quote(
                        self.config.session.as_deref().unwrap_or("default"),
                    )),
                ),
            ],
        )
        .expect("herdr-probe.ps1 takes configured, path and session");
        let command = powershell_command(&probe);
        let found = async {
            let ssh = self
                .sessions
                .command_argv(&self.config.ssh_host, &command, &[], None)
                .map_err(|error| error.to_string())?;
            let stdout = (self.run_remote)(ssh).await?;
            parse_probe(&stdout).ok_or_else(|| "roamgate-windows-herdr-unavailable".to_owned())
        }
        .await;
        found.map_err(|message| preflight_failure(&format!("Error: {message}")))
    }

    async fn listen(self: Arc<Self>, path: PathBuf, command: String) -> Result<(), SshTunnelError> {
        if self.state.lock().unwrap().disposed {
            return Ok(());
        }
        #[cfg(unix)]
        {
            let listener = tokio::net::UnixListener::bind(&path).map_err(|error| {
                SshTunnelError::new(
                    format!("Windows SSH listener failed: {error}"),
                    true,
                    SshTunnelFailureKind::Exited,
                    -1,
                )
            })?;
            let inner = self.clone();
            let task = tokio::spawn(async move {
                loop {
                    let stream = match listener.accept().await {
                        Ok((stream, _)) => stream,
                        Err(_) => {
                            if let Some(report) = &inner.on_unexpected_exit {
                                report(SshTunnelError::new(
                                    "Windows SSH listener failed",
                                    true,
                                    SshTunnelFailureKind::Exited,
                                    -1,
                                ));
                            }
                            return;
                        }
                    };
                    inner.clone().accept(stream, command.clone());
                }
            });
            self.state.lock().unwrap().listeners.push(task);
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = (path, command);
            Err(SshTunnelError::new(
                "SSH connections from Windows are not supported because Roamgate's stream-local forwarding cannot create a local Windows named pipe",
                false,
                SshTunnelFailureKind::Unsupported,
                -1,
            ))
        }
    }

    #[cfg(unix)]
    fn accept(self: Arc<Self>, stream: tokio::net::UnixStream, command: String) {
        let (id, term, force, done_tx) = {
            let mut state = self.state.lock().unwrap();
            if state.disposed || state.stopping {
                return;
            }
            state.next += 1;
            let id = state.next;
            let (done_tx, done) = watch::channel(false);
            let term = Arc::new(Notify::new());
            let force = Arc::new(Notify::new());
            state.connections.insert(
                id,
                Connection {
                    term: term.clone(),
                    force: force.clone(),
                    done,
                },
            );
            (id, term, force, done_tx)
        };
        tokio::spawn(async move {
            self.serve(stream, command, term, force).await;
            self.state.lock().unwrap().connections.remove(&id);
            let _ = done_tx.send(true);
        });
    }

    #[cfg(unix)]
    async fn serve(
        &self,
        stream: tokio::net::UnixStream,
        command: String,
        term: Arc<Notify>,
        force: Arc<Notify>,
    ) {
        let Ok(argv) = ssh_bridge_command_argv(&self.config.ssh_host, &command) else {
            return;
        };
        let Ok(mut child) = (self.spawn_bridge)(argv) else {
            return;
        };
        let (mut reading, mut writing) = stream.into_split();
        let stdin = child.stdin();
        let stdout = child.stdout();
        let stderr = child.stderr();
        let stderr = tokio::spawn(read_bounded_stderr(stderr));
        // Socket to bridge; the socket's end ends the bridge's input.
        let up = tokio::spawn(async move {
            if let Some(mut stdin) = stdin {
                let _ = tokio::io::copy(&mut reading, &mut stdin).await;
                let _ = stdin.shutdown().await;
            }
        });
        // Bridge to socket, without ending the socket at the bridge's end.
        let down = tokio::spawn(async move {
            if let Some(mut stdout) = stdout {
                let _ = tokio::io::copy(&mut stdout, &mut writing).await;
            }
            writing
        });
        let status = loop {
            tokio::select! {
                status = child.wait() => break status,
                () = term.notified() => child.kill(false),
                () = force.notified() => child.kill(true),
            }
        };
        let code = status.unwrap_or(-1);
        up.abort();
        let writing = timeout(&*self.clock, STOP_KILLED, down).await;
        if code == 0
            && let Ok(Ok(mut writing)) = writing
        {
            let _ = writing.shutdown().await;
        }
        // Dropping the halves destroys the socket otherwise.
        let report = {
            let state = self.state.lock().unwrap();
            !state.disposed && !state.stopping && code != 0
        };
        if report && let Some(on_exit) = &self.on_unexpected_exit {
            let text = stderr.await.unwrap_or_default();
            on_exit(classify_ssh_tunnel_failure(code, &text));
        }
    }
}

/// herdr.exe's path from the probe's output line, if it is one.
fn parse_probe(stdout: &str) -> Option<String> {
    let encoded = stdout
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .find_map(|line| line.strip_prefix("roamgate-herdr-path:"))?;
    let body = encoded.trim_end_matches('=');
    if body.is_empty()
        || encoded.len() - body.len() > 2
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(body))
        .ok()?;
    let resolved = String::from_utf8_lossy(&bytes).into_owned();
    let drive = resolved.as_bytes();
    let valid = resolved.encode_utf16().count() <= 1024
        && drive.len() > 7
        && drive[0].is_ascii_alphabetic()
        && drive[1] == b':'
        && drive[2] == b'\\'
        && resolved.to_ascii_lowercase().ends_with(".exe")
        && resolved[3..resolved.len() - 4].chars().count() >= 1
        && !resolved[3..resolved.len() - 4]
            .chars()
            .any(|c| (c as u32) <= 0x1f || (0x7f..=0x9f).contains(&(c as u32)));
    valid.then_some(resolved)
}

/// Why finding Herdr failed, from the diagnostic (`String(error)`).
fn preflight_failure(diagnostic: &str) -> SshTunnelError {
    let failure = classify_ssh_tunnel_failure(-1, diagnostic);
    if failure.kind == SshTunnelFailureKind::Permission {
        return failure;
    }
    if diagnostic.contains("roamgate-windows-status-failed") {
        return SshTunnelError::new(
            "Could not read the Windows Herdr server status. Check the selected session on the remote host.",
            true,
            SshTunnelFailureKind::Exited,
            -1,
        );
    }
    if diagnostic.contains("roamgate-windows-session-unavailable") {
        return SshTunnelError::new(
            "The selected Windows Herdr session is not running. Start it on the remote host before connecting.",
            true,
            SshTunnelFailureKind::Unreachable,
            -1,
        );
    }
    let missing_powershell = regex::Regex::new(
        r#"(?i)powershell\.exe['":\s]+(?:is not recognized|(?:command )?not found)"#,
    )
    .expect("pattern")
    .is_match(diagnostic);
    if !diagnostic.contains("roamgate-windows-herdr-unavailable") && !missing_powershell {
        return failure;
    }
    SshTunnelError::new(
        "Windows SSH requires Windows PowerShell and Herdr 0.9.1+ with remote-api-bridge. Install it on the remote host or set its executable path.",
        false,
        SshTunnelFailureKind::Unsupported,
        -1,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use roamgate_base::clock::SystemClock;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const HERDR_PATH: &str = r"C:\Herdr O'Brien\herdr.exe";

    /// A bridge spawned: its words and pid.
    type Spawn = (Vec<String>, Option<u32>);

    fn config(dir: &tempfile::TempDir) -> WindowsTunnelConfig {
        let root = dir.path().join("runtime");
        std::fs::create_dir(&root).unwrap();
        WindowsTunnelConfig {
            socket_path: root.join("control.sock"),
            client_socket_path: root.join("render.sock"),
            ssh_host: "windows-host".into(),
            session: Some("isolated-session".into()),
            remote_herdr_path: Some(HERDR_PATH.into()),
            owned_runtime_directory: Some(root),
        }
    }

    fn discovered() -> String {
        format!(
            "roamgate-herdr-path:{}\r\n",
            base64::engine::general_purpose::STANDARD.encode(HERDR_PATH)
        )
    }

    fn answering(answer: Result<String, String>) -> RunRemote {
        Arc::new(move |_| {
            let answer = answer.clone();
            Box::pin(async move { answer })
        })
    }

    fn tunnel(
        config: WindowsTunnelConfig,
        run: RunRemote,
        spawn: Option<SpawnBridge>,
        on_exit: Option<OnUnexpectedExit>,
    ) -> WindowsTunnel {
        WindowsTunnel::new(
            config,
            SshSessions::new(Arc::new(SystemClock)),
            run,
            spawn,
            on_exit,
        )
    }

    fn decode_script(command: &str) -> String {
        let encoded = command.rsplit(' ').next().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    fn shell(script: &str) -> Result<Spawned, ExecError> {
        ProcessRunner::system().spawn(&Command::new(["sh", "-c", script]), true)
    }

    #[test]
    fn quotes_executable_paths_and_selects_both_bridges_without_a_powershell_pipeline() {
        for (kind, bridge) in [(BridgeKind::Control, "api"), (BridgeKind::Client, "client")] {
            let command =
                windows_herdr_bridge_command(HERDR_PATH, "isolated-session", kind).unwrap();
            let script = decode_script(&command);
            assert!(script.contains(r"-FilePath 'C:\Herdr O''Brien\herdr.exe'"));
            assert!(script.contains(&format!(
                "--session isolated-session remote-{bridge}-bridge"
            )));
            assert!(script.contains("-NoNewWindow"));
            assert!(!script.contains("& "));
        }
        assert_eq!(
            windows_herdr_bridge_command(HERDR_PATH, "default --update", BridgeKind::Client),
            Err(InvalidSession)
        );
    }

    #[tokio::test]
    async fn preserves_binary_data_on_both_channels_and_terminates_active_children_on_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let settings = config(&dir);
        let spawned: Arc<Mutex<Vec<Spawn>>> = Arc::default();
        let seen = spawned.clone();
        let spawn: SpawnBridge = Arc::new(move |argv| {
            let child = shell("exec cat")?;
            seen.lock().unwrap().push((argv, child.pid()));
            Ok(child)
        });
        let manager = tunnel(
            settings.clone(),
            answering(Ok(discovered())),
            Some(spawn),
            None,
        );
        manager.start().await.unwrap();
        for path in [&settings.socket_path, &settings.client_socket_path] {
            let mut socket = tokio::net::UnixStream::connect(path).await.unwrap();
            let bytes = [0u8, 255, 128, 13, 10, 27, 65];
            socket.write_all(&bytes).await.unwrap();
            let mut echoed = [0u8; 7];
            socket.read_exact(&mut echoed).await.unwrap();
            assert_eq!(echoed, bytes);
        }
        let mut active = tokio::net::UnixStream::connect(&settings.client_socket_path)
            .await
            .unwrap();
        active.write_all(b"x").await.unwrap();
        let mut one = [0u8; 1];
        active.read_exact(&mut one).await.unwrap();
        manager.cleanup().await;
        // The active connection was closed.
        let mut rest = Vec::new();
        assert_eq!(active.read_to_end(&mut rest).await.unwrap_or(0), 0);
        let spawned = spawned.lock().unwrap();
        assert_eq!(spawned.len(), 3);
        for (argv, pid) in spawned.iter() {
            // A long-lived bridge keeps its own connection, master or not.
            assert!(!argv.contains(&"-S".to_owned()));
            for option in [
                "BatchMode=yes",
                "StrictHostKeyChecking=yes",
                "ServerAliveCountMax=3",
            ] {
                assert!(argv.contains(&option.to_owned()), "{option}");
            }
            let state =
                std::fs::read_to_string(format!("/proc/{}/stat", pid.unwrap())).unwrap_or_default();
            assert!(state.is_empty() || state.contains(") Z"), "{state}");
        }
        assert!(!settings.owned_runtime_directory.unwrap().exists());
    }

    #[tokio::test]
    async fn reports_bridge_failures_without_leaking_stderr() {
        for (diagnostic, kind) in [
            (
                "Permission denied (publickey).",
                SshTunnelFailureKind::Authentication,
            ),
            (
                "For an elevated server, use an administrator terminal. Sharing with ordinary clients requires stopping it there and restarting its `herdr server` command with --allow-unelevated-clients (closes panes). Access is denied. (os error 5)",
                SshTunnelFailureKind::Permission,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let settings = config(&dir);
            let (sender, mut failure) = tokio::sync::mpsc::unbounded_channel();
            let report: OnUnexpectedExit = Arc::new(move |error| {
                let _ = sender.send(error);
            });
            let text = format!("{diagnostic} private detail");
            let spawn: SpawnBridge = Arc::new(move |_| {
                shell(&format!(
                    "printf '%s' {} >&2; exit 1",
                    crate::quote::shell_quote(&text)
                ))
            });
            let manager = tunnel(
                settings.clone(),
                answering(Ok(discovered())),
                Some(spawn),
                Some(report),
            );
            manager.start().await.unwrap();
            let _socket = tokio::net::UnixStream::connect(&settings.socket_path)
                .await
                .unwrap();
            let error = failure.recv().await.unwrap();
            assert_eq!((error.kind, error.retryable), (kind, false));
            assert!(!error.message.contains("private detail"));
            manager.cleanup().await;
        }
    }

    #[tokio::test]
    async fn cleanup_during_discovery_prevents_late_listeners() {
        let dir = tempfile::tempdir().unwrap();
        let settings = config(&dir);
        let gate = Arc::new(Notify::new());
        let asked = Arc::new(Notify::new());
        let (wait, tell) = (gate.clone(), asked.clone());
        let run: RunRemote = Arc::new(move |_| {
            let (wait, tell) = (wait.clone(), tell.clone());
            Box::pin(async move {
                tell.notify_one();
                wait.notified().await;
                Ok(discovered())
            })
        });
        let manager = tunnel(settings.clone(), run, None, None);
        let starting = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.start().await })
        };
        // Discovery begins after the first stop settled.
        asked.notified().await;
        let cleanup = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.cleanup().await })
        };
        tokio::task::yield_now().await;
        gate.notify_one();
        starting.await.unwrap().unwrap();
        cleanup.await.unwrap();
        assert!(!settings.socket_path.exists());
        assert!(!settings.owned_runtime_directory.unwrap().exists());
    }

    async fn preflight(message: &str) -> (SshTunnelError, bool) {
        let dir = tempfile::tempdir().unwrap();
        let settings = config(&dir);
        let manager = tunnel(
            settings.clone(),
            answering(Err(message.to_owned())),
            None,
            None,
        );
        let error = manager.start().await.unwrap_err();
        let listened = settings.socket_path.exists();
        manager.cleanup().await;
        (error, listened)
    }

    #[tokio::test]
    async fn rejects_unavailable_bridges_permanently_without_starting_listeners() {
        let (error, listened) = preflight("roamgate-windows-herdr-unavailable").await;
        assert_eq!(
            (error.kind, error.retryable, listened),
            (SshTunnelFailureKind::Unsupported, false, false)
        );
        // A probe answer that is not a herdr.exe path is the same.
        let dir = tempfile::tempdir().unwrap();
        let settings = config(&dir);
        let bad = base64::engine::general_purpose::STANDARD.encode("/usr/bin/herdr");
        let manager = tunnel(
            settings.clone(),
            answering(Ok(format!("roamgate-herdr-path:{bad}\n"))),
            None,
            None,
        );
        let error = manager.start().await.unwrap_err();
        assert_eq!(error.kind, SshTunnelFailureKind::Unsupported);
        manager.cleanup().await;
    }

    #[tokio::test]
    async fn keeps_transient_preflight_failures_retryable() {
        for message in [
            "ssh exited 255: kex_exchange_identification: read: Connection reset by peer",
            "ssh exited 255: Connection closed by remote host",
            "ssh exited 255: client_loop: send disconnect: Broken pipe",
        ] {
            let (error, listened) = preflight(message).await;
            assert_eq!(
                (error.kind, error.retryable, listened),
                (SshTunnelFailureKind::Exited, true, false),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_missing_powershell_permanently() {
        for message in [
            "ssh exited 1: 'powershell.exe' is not recognized as an internal or external command",
            "ssh exited 127: powershell.exe: command not found",
        ] {
            let (error, listened) = preflight(message).await;
            assert_eq!(
                (error.kind, error.retryable, listened),
                (SshTunnelFailureKind::Unsupported, false, false),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn classifies_a_stopped_session_as_retryable_without_starting_listeners() {
        let (error, listened) = preflight("roamgate-windows-session-unavailable").await;
        assert_eq!(
            (error.kind, error.retryable, listened),
            (SshTunnelFailureKind::Unreachable, true, false)
        );
    }

    #[tokio::test]
    async fn distinguishes_preflight_failures() {
        for (message, kind, retryable, hint) in [
            (
                "For an elevated server, use an administrator terminal. Permission denied (os error 5)\nroamgate-windows-status-failed",
                SshTunnelFailureKind::Permission,
                false,
                "administrator",
            ),
            (
                "Permission denied (publickey).",
                SshTunnelFailureKind::Authentication,
                false,
                "SSH",
            ),
            (
                "roamgate-windows-status-failed",
                SshTunnelFailureKind::Exited,
                true,
                "status",
            ),
        ] {
            let (error, listened) = preflight(message).await;
            assert_eq!(
                (error.kind, error.retryable, listened),
                (kind, retryable, false)
            );
            assert!(error.message.contains(hint), "{}", error.message);
        }
    }
}
