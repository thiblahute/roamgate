//! On-demand port forwards of a connection's SSH transport
//! (bridge/ssh-forward.ts): one supervised ssh process each, bound to
//! loopback only, reported open only once usable, and the scan of the ports
//! a host listens on.
//!
//! Deliberately not added to the Herdr tunnel's own `-L` list: ssh cannot
//! gain a forward without a restart, which would drop the connection every
//! browser uses, and one process per forward means a refused port takes
//! only itself down.

use crate::process::ProcessRunner;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_base::clock::{BoxFuture, SharedClock};
use roamgate_protocol::forward::{ForwardWire, SshForwardDirection, SshForwardState};
use serde_json::Value;

use super::command::{
    InvalidDestination, SSH_NONINTERACTIVE_ARGS, SshCommand, validate_ssh_destination,
};
use super::supervised::SupervisedSsh;
use super::tunnel::classify_ssh_tunnel_failure;

/// Forwards bind loopback only: a forwarded port carries no authentication
/// of its own, so the only safe listener is one no other machine reaches.
pub const FORWARD_BIND_HOST: &str = "127.0.0.1";
/// How long a forward may take to become usable before it is failed.
pub const FORWARD_READY_TIMEOUT_MS: u64 = 20_000;
const FORWARD_READY_POLL_MS: u64 = 100;
/// Live forwards the server keeps at once, across connections.
pub const MAX_LIVE_FORWARDS: usize = 32;
/// The Vite dev server's port, which proxies to the bridge in development.
pub const VITE_DEV_PORT: u16 = 5173;

/// A forward as the server keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshForwardRecord {
    pub id: String,
    pub connection_id: String,
    pub direction: SshForwardDirection,
    pub remote_port: u16,
    pub local_port: u16,
    pub label: Option<String>,
    pub state: SshForwardState,
    pub error: Option<String>,
    /// Which open() started this record's process; not on the wire.
    pub attempt: u64,
}

pub fn forward_to_wire(record: &SshForwardRecord) -> ForwardWire {
    ForwardWire {
        id: record.id.clone(),
        connection_id: record.connection_id.clone(),
        direction: record.direction,
        remote_port: record.remote_port,
        local_port: record.local_port,
        label: record.label.clone().filter(|label| !label.is_empty()),
        state: record.state,
        error: record.error.clone().filter(|error| !error.is_empty()),
    }
}

fn direction_name(direction: SshForwardDirection) -> &'static str {
    match direction {
        SshForwardDirection::Local => "local",
        SshForwardDirection::Remote => "remote",
    }
}

pub fn forward_id(connection_id: &str, remote_port: u16, direction: SshForwardDirection) -> String {
    format!(
        "{connection_id}:{}:{remote_port}",
        direction_name(direction)
    )
}

/// Whether `ssh -v` said the far host accepted our `-R` listener on `port`.
pub fn remote_forward_succeeded(stderr: &str, port: u16) -> bool {
    static SUCCESS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"remote forward success for: listen (?:\S*:)?(\d+),").unwrap()
    });
    SUCCESS
        .captures_iter(stderr)
        .any(|found| found[1].parse::<u32>() == Ok(u32::from(port)))
}

pub fn ssh_forward_argv(
    destination: &str,
    local_port: u16,
    remote_port: u16,
    direction: SshForwardDirection,
) -> Result<Vec<String>, InvalidDestination> {
    let mut argv = vec!["ssh".to_owned()];
    argv.extend(SSH_NONINTERACTIVE_ARGS.iter().map(|arg| (*arg).to_owned()));
    argv.extend(["-o".into(), "ExitOnForwardFailure=yes".into(), "-N".into()]);
    match direction {
        SshForwardDirection::Local => {
            // The far side resolves "localhost" on the remote, where a dev
            // server printing http://localhost:PORT is actually bound.
            argv.push("-L".into());
            argv.push(format!(
                "{FORWARD_BIND_HOST}:{local_port}:localhost:{remote_port}"
            ));
        }
        SshForwardDirection::Remote => {
            // -v is how a remote forward reports success. The remote's
            // loopback is asked for explicitly: sshd honours it unless
            // GatewayPorts yes.
            argv.push("-v".into());
            argv.push("-R".into());
            argv.push(format!(
                "{FORWARD_BIND_HOST}:{remote_port}:localhost:{local_port}"
            ));
        }
    }
    argv.push("--".into());
    argv.push(validate_ssh_destination(destination)?.into());
    Ok(argv)
}

/// A port from the wire: a whole number from 1 to 65535, or its text.
pub fn validate_forward_port(value: &Value) -> Result<u16, String> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .or_else(|| text.trim().is_empty().then_some(0.0)),
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    };
    match number {
        Some(port) if port.fract() == 0.0 && (1.0..=65535.0).contains(&port) => Ok(port as u16),
        _ => Err(format!(
            "Invalid port: {}",
            match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            }
        )),
    }
}

/// The remote's own number when free here, else the next free one above
/// it within `span`: the mapping is reported, since the URL changes.
pub fn choose_local_port(
    preferred: u16,
    is_free: impl Fn(u16) -> bool,
    span: u16,
) -> Result<u16, String> {
    if is_free(preferred) {
        return Ok(preferred);
    }
    for offset in 1..=span {
        let candidate = u32::from(preferred) + u32::from(offset);
        if candidate <= 65535 && is_free(candidate as u16) {
            return Ok(candidate as u16);
        }
    }
    Err(format!(
        "No free local port near {preferred}; close a forward and retry"
    ))
}

/// Ports a remote forward must never expose: Roamgate's own listener and,
/// in development, the Vite server proxying to it.
pub fn roamgate_own_ports(listening_port: u16, development: bool) -> Vec<u16> {
    if development {
        vec![listening_port, VITE_DEV_PORT]
    } else {
        vec![listening_port]
    }
}

/// Free on both loopbacks: the forward binds 127.0.0.1, but the browser
/// opens http://localhost:PORT, which may resolve to ::1 first.
pub fn default_port_is_free(port: u16) -> bool {
    can_bind("127.0.0.1", port, true) && can_bind("::1", port, false)
}

fn can_bind(host: &str, port: u16, required: bool) -> bool {
    match std::net::TcpListener::bind((host, port)) {
        Ok(_) => true,
        // Only "in use" means taken on ::1; a host without IPv6 loopback
        // has nothing there to collide with.
        Err(error) => !required && error.kind() != std::io::ErrorKind::AddrInUse,
    }
}

async fn default_probe_port(port: u16) -> bool {
    tokio::net::TcpStream::connect((FORWARD_BIND_HOST, port))
        .await
        .is_ok()
}

type Listener = Arc<dyn Fn(&[SshForwardRecord]) + Send + Sync>;

/// What forwards do to the world, replaceable in tests.
#[derive(Clone)]
pub struct ForwardDeps {
    pub spawn: Arc<dyn Fn(SshCommand) -> Result<SupervisedSsh, String> + Send + Sync>,
    pub is_port_free: Arc<dyn Fn(u16) -> bool + Send + Sync>,
    /// Whether something accepts connections on a local port.
    pub probe_port: Arc<dyn Fn(u16) -> BoxFuture<bool> + Send + Sync>,
    pub ready_timeout_ms: u64,
    pub poll_interval_ms: u64,
    /// Local ports a remote forward refuses to expose.
    pub reserved_ports: Arc<dyn Fn() -> Vec<u16> + Send + Sync>,
}

impl Default for ForwardDeps {
    /// [`ForwardDeps::real`] on a runner of the real clock with no observer.
    fn default() -> Self {
        Self::real(ProcessRunner::system())
    }
}

impl ForwardDeps {
    /// The real ones, ssh children running through `runner`.
    pub fn real(runner: ProcessRunner) -> Self {
        Self {
            spawn: Arc::new(move |command| SupervisedSsh::spawn(&runner, &command)),
            is_port_free: Arc::new(default_port_is_free),
            probe_port: Arc::new(|port| Box::pin(default_probe_port(port))),
            ready_timeout_ms: FORWARD_READY_TIMEOUT_MS,
            poll_interval_ms: FORWARD_READY_POLL_MS,
            reserved_ports: Arc::new(Vec::new),
        }
    }
}

/// What a page asks to forward.
#[derive(Debug, Clone)]
pub struct ForwardRequest {
    pub connection_id: String,
    pub destination: String,
    /// The port on whichever host owns the service.
    pub port: u16,
    pub direction: SshForwardDirection,
    pub label: Option<String>,
}

type Signal = Shared<BoxFuture<()>>;

#[derive(Default)]
struct ForwardState {
    /// In insertion order, as a Map keeps them.
    records: Vec<SshForwardRecord>,
    processes: HashMap<String, SupervisedSsh>,
    /// Settles once the exit handler classified a process's exit.
    exits_handled: HashMap<u64, Signal>,
    /// Resolved when `ssh -v` reports a remote forward's bind accepted.
    remote_ready: HashMap<u64, Signal>,
    /// One readiness wait per process, shared by every request for it.
    readiness: HashMap<u64, Shared<BoxFuture<Option<SshForwardRecord>>>>,
    attempts: u64,
}

impl ForwardState {
    fn get(&self, id: &str) -> Option<&SshForwardRecord> {
        self.records.iter().find(|record| record.id == id)
    }

    fn set(&mut self, record: SshForwardRecord) {
        match self.records.iter_mut().find(|each| each.id == record.id) {
            Some(existing) => *existing = record,
            None => self.records.push(record),
        }
    }

    fn delete(&mut self, id: &str) -> bool {
        let before = self.records.len();
        self.records.retain(|record| record.id != id);
        before != self.records.len()
    }
}

struct ForwardsInner {
    clock: SharedClock,
    deps: ForwardDeps,
    state: Mutex<ForwardState>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
}

/// The live forwards of every connection. Clones are the same set.
#[derive(Clone)]
pub struct SshForwards {
    inner: Arc<ForwardsInner>,
}

impl SshForwards {
    pub fn new(clock: SharedClock, deps: ForwardDeps) -> Self {
        Self {
            inner: Arc::new(ForwardsInner {
                clock,
                deps,
                state: Mutex::new(ForwardState::default()),
                listeners: Mutex::new(Vec::new()),
                next_listener: AtomicU64::new(1),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, ForwardState> {
        self.inner.state.lock().expect("ssh forwards")
    }

    pub fn list(&self) -> Vec<SshForwardRecord> {
        self.lock().records.clone()
    }

    fn snapshot(&self, id: &str) -> Option<SshForwardRecord> {
        self.lock().get(id).cloned()
    }

    fn publish(&self) {
        let snapshot = self.list();
        let listeners: Vec<Listener> = self
            .inner
            .listeners
            .lock()
            .expect("listeners")
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener(&snapshot);
        }
    }

    /// Calls `listener` with the list on each change; the id removes it.
    pub fn on_change(&self, listener: impl Fn(&[SshForwardRecord]) + Send + Sync + 'static) -> u64 {
        let id = self.inner.next_listener.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .expect("listeners")
            .push((id, Arc::new(listener)));
        id
    }

    pub fn remove_listener(&self, id: u64) {
        self.inner
            .listeners
            .lock()
            .expect("listeners")
            .retain(|(each, _)| *each != id);
    }

    pub fn is_reserved(&self, port: u16) -> bool {
        (self.inner.deps.reserved_ports)().contains(&port)
    }

    /// Starts a forward, or gives the live one for the same port and way.
    pub fn open(&self, request: ForwardRequest) -> Result<SshForwardRecord, String> {
        let direction = request.direction;
        let port = validate_forward_port(&Value::from(request.port))?;
        if direction == SshForwardDirection::Remote && self.is_reserved(port) {
            return Err(format!(
                "Port {port} is Roamgate's own and cannot be exposed to the remote"
            ));
        }
        let id = forward_id(&request.connection_id, port, direction);
        let record = {
            let mut state = self.lock();
            if let Some(existing) = state.get(&id)
                && !matches!(
                    existing.state,
                    SshForwardState::Failed | SshForwardState::Closed
                )
            {
                return Ok(existing.clone());
            }
            let live: Vec<&SshForwardRecord> = state
                .records
                .iter()
                .filter(|record| {
                    matches!(
                        record.state,
                        SshForwardState::Starting | SshForwardState::Open
                    )
                })
                .collect();
            if live.len() >= MAX_LIVE_FORWARDS {
                return Err(format!(
                    "Already forwarding {MAX_LIVE_FORWARDS} ports; stop one and retry"
                ));
            }
            // Only a local forward binds here, so only it can move to a
            // free port; a remote forward's port is the far host's to give.
            let local_port = match direction {
                SshForwardDirection::Local => {
                    let taken: Vec<u16> = live
                        .iter()
                        .filter(|record| record.direction == SshForwardDirection::Local)
                        .map(|record| record.local_port)
                        .collect();
                    let is_free = &self.inner.deps.is_port_free;
                    choose_local_port(
                        port,
                        |candidate| !taken.contains(&candidate) && is_free(candidate),
                        64,
                    )?
                }
                SshForwardDirection::Remote => port,
            };
            state.attempts += 1;
            let record = SshForwardRecord {
                id: id.clone(),
                connection_id: request.connection_id.clone(),
                direction,
                remote_port: port,
                local_port,
                label: request.label.clone(),
                state: SshForwardState::Starting,
                error: None,
                attempt: state.attempts,
            };
            state.set(record.clone());
            record
        };
        let argv = ssh_forward_argv(
            &request.destination,
            record.local_port,
            record.remote_port,
            direction,
        )
        .map_err(|error| error.to_string());
        tracing::debug!(%id, direction = direction_name(direction), local_port = record.local_port, remote_port = record.remote_port, "opening ssh forward");
        let spawned = argv.and_then(|argv| (self.inner.deps.spawn)(SshCommand::plain(argv)));
        let proc = match spawned {
            Ok(proc) => proc,
            Err(error) => {
                let failed = SshForwardRecord {
                    state: SshForwardState::Failed,
                    error: Some(error),
                    ..record
                };
                self.lock().set(failed.clone());
                self.publish();
                return Ok(failed);
            }
        };
        {
            let mut state = self.lock();
            state.processes.insert(id.clone(), proc.clone());
            if direction == SshForwardDirection::Remote {
                let mut stderr = proc.subscribe_stderr();
                let (done, ready) = tokio::sync::oneshot::channel::<()>();
                tokio::spawn(async move {
                    // A window, not the whole -v log: the line may straddle
                    // two chunks, but it is far shorter than this.
                    let mut seen = String::new();
                    while let Ok(text) = stderr.recv().await {
                        seen.push_str(&text);
                        if seen.len() > 4096 {
                            let mut cut = seen.len() - 4096;
                            while !seen.is_char_boundary(cut) {
                                cut += 1;
                            }
                            seen.drain(..cut);
                        }
                        if remote_forward_succeeded(&seen, port) {
                            let _ = done.send(());
                            return;
                        }
                    }
                });
                let signal: BoxFuture<()> = Box::pin(async move {
                    if ready.await.is_err() {
                        std::future::pending::<()>().await;
                    }
                });
                state.remote_ready.insert(proc.id(), signal.shared());
            }
        }
        // ExitOnForwardFailure means a refused bind exits with ssh's reason.
        let forwards = self.clone();
        let exiting = proc.clone();
        let exit_id = id.clone();
        let handled = tokio::spawn(async move {
            let code = exiting.exited().await.unwrap_or(-1);
            {
                let mut state = forwards.lock();
                if state.processes.get(&exit_id) != Some(&exiting) {
                    return;
                }
                state.processes.remove(&exit_id);
            }
            let Some(current) = forwards.snapshot(&exit_id) else {
                return;
            };
            if current.state == SshForwardState::Closed {
                return;
            }
            let failure = classify_ssh_tunnel_failure(code, &exiting.stderr().await);
            forwards.lock().set(SshForwardRecord {
                state: SshForwardState::Failed,
                error: Some(failure.message.clone()),
                ..current
            });
            tracing::warn!(id = %exit_id, code, error = %failure.message, "ssh forward exited");
            forwards.publish();
        });
        let signal: BoxFuture<()> = Box::pin(async move {
            let _ = handled.await;
        });
        let signal = signal.shared();
        self.lock().exits_handled.insert(proc.id(), signal.clone());
        let cleanup = self.clone();
        let proc_id = proc.id();
        tokio::spawn(async move {
            signal.await;
            let mut state = cleanup.lock();
            state.exits_handled.remove(&proc_id);
            state.remote_ready.remove(&proc_id);
        });
        self.publish();
        Ok(record)
    }

    /// Resolves once a starting forward can carry traffic, or with it
    /// failed. A local forward is ready when its port accepts a connection;
    /// a remote one when `-v` logs the far host's confirmation. An exit fails
    /// it with ssh's reason; past the deadline it is killed and failed.
    pub async fn wait_until_open(&self, id: &str) -> Option<SshForwardRecord> {
        let pending = {
            let mut state = self.lock();
            let current = state.get(id).cloned()?;
            if current.state != SshForwardState::Starting {
                return Some(current);
            }
            let Some(proc) = state.processes.get(id).cloned() else {
                return Some(current);
            };
            match state.readiness.get(&proc.id()) {
                Some(pending) => pending.clone(),
                None => {
                    let forwards = self.clone();
                    let key = proc.id();
                    let id = id.to_owned();
                    let pending: BoxFuture<Option<SshForwardRecord>> = Box::pin(async move {
                        let outcome = forwards.settle(&id, current, proc).await;
                        forwards.lock().readiness.remove(&key);
                        outcome
                    });
                    let pending = pending.shared();
                    state.readiness.insert(key, pending.clone());
                    pending
                }
            }
        };
        pending.await
    }

    async fn settle(
        &self,
        id: &str,
        record: SshForwardRecord,
        proc: SupervisedSsh,
    ) -> Option<SshForwardRecord> {
        enum Outcome {
            Ready,
            Exited,
            Timeout,
        }
        let (remote_ready, exit_handled) = {
            let state = self.lock();
            (
                state.remote_ready.get(&proc.id()).cloned(),
                state.exits_handled.get(&proc.id()).cloned(),
            )
        };
        let clock = self.inner.clock.clone();
        let deps = self.inner.deps.clone();
        let ready = async {
            match record.direction {
                SshForwardDirection::Remote => match remote_ready {
                    Some(ready) => ready.await,
                    None => std::future::pending().await,
                },
                SshForwardDirection::Local => loop {
                    if (deps.probe_port)(record.local_port).await {
                        break;
                    }
                    clock
                        .sleep(Duration::from_millis(deps.poll_interval_ms))
                        .await;
                },
            }
        };
        let exited = async {
            match exit_handled {
                Some(handled) => handled.await,
                None => {
                    let _ = proc.exited().await;
                }
            }
        };
        let outcome = tokio::select! {
            () = ready => Outcome::Ready,
            () = exited => Outcome::Exited,
            () = clock.sleep(Duration::from_millis(deps.ready_timeout_ms)) => Outcome::Timeout,
        };
        // Closed or replaced while waiting: nothing of ours to settle, and a
        // forward opened since is not this request's answer.
        if self.lock().processes.get(id) != Some(&proc) {
            let current = self.snapshot(id);
            return current.filter(|current| current.attempt == record.attempt);
        }
        match outcome {
            Outcome::Ready => self.mark_open(id),
            Outcome::Timeout => {
                self.lock().processes.remove(id);
                let _ = proc.kill(super::supervised::KillSignal::Term);
                if let Some(current) = self.snapshot(id) {
                    self.lock().set(SshForwardRecord {
                        state: SshForwardState::Failed,
                        error: Some(format!(
                            "The forward was not ready after {} s",
                            (deps.ready_timeout_ms as f64 / 1000.0).round()
                        )),
                        ..current
                    });
                    tracing::warn!(%id, "ssh forward timed out");
                    self.publish();
                }
            }
            Outcome::Exited => {}
        }
        self.snapshot(id)
    }

    /// A forward is only reported open once it has survived its startup.
    pub fn mark_open(&self, id: &str) {
        {
            let mut state = self.lock();
            let Some(current) = state.get(id).cloned() else {
                return;
            };
            if current.state != SshForwardState::Starting {
                return;
            }
            state.set(SshForwardRecord {
                state: SshForwardState::Open,
                ..current
            });
        }
        self.publish();
    }

    pub fn close(&self, id: &str) -> bool {
        let existed = {
            let mut state = self.lock();
            if let Some(proc) = state.processes.remove(id) {
                let _ = proc.kill(super::supervised::KillSignal::Term);
            }
            state.delete(id)
        };
        if existed {
            self.publish();
        }
        existed
    }

    /// Closes a forward only if it is still the one `record`'s open()
    /// started: a stale request must not take down one opened since.
    pub fn close_attempt(&self, record: &SshForwardRecord) -> bool {
        let current = self.snapshot(&record.id);
        if current.is_none_or(|current| current.attempt != record.attempt) {
            return false;
        }
        self.close(&record.id)
    }

    /// The connection's runtime went away: its ssh processes stop, but its
    /// forwards stay listed as failed so the page shows what was lost.
    pub fn lose_connection(&self, connection_id: &str) {
        let mut changed = false;
        {
            let mut state = self.lock();
            let records: Vec<SshForwardRecord> = state
                .records
                .iter()
                .filter(|record| record.connection_id == connection_id)
                .cloned()
                .collect();
            for record in records {
                if let Some(proc) = state.processes.remove(&record.id) {
                    let _ = proc.kill(super::supervised::KillSignal::Term);
                }
                if record.state == SshForwardState::Failed {
                    continue;
                }
                state.set(SshForwardRecord {
                    state: SshForwardState::Failed,
                    error: Some("Lost with its connection; forward the port again".into()),
                    ..record
                });
                changed = true;
            }
        }
        if changed {
            self.publish();
        }
    }

    pub fn close_all(&self) {
        for record in self.list() {
            self.close(&record.id);
        }
    }
}

/// A port a host listens on, with its process when the scan named one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListeningPort {
    pub port: u16,
    pub process: Option<String>,
}

/// `ss`, then lsof (macOS), then netstat: the ports a host listens on, with
/// the processes the user can see (their own).
pub const LISTENING_PORTS_COMMAND: &str =
    "ss -ltnpH 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || netstat -ltnp 2>/dev/null";

fn listens_on_loopback(host: &str) -> bool {
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    matches!(
        bare.as_str(),
        "127.0.0.1" | "::1" | "localhost" | "0.0.0.0" | "*" | "::"
    ) || bare.starts_with("127.")
}

/// The loopback (and wildcard) listeners of `ss -ltnH`, `netstat -ltn` or
/// `lsof` output, one per port, by port.
pub fn parse_listening_ports(output: &str) -> Vec<ListeningPort> {
    static HEADER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(Netid|Proto|Active|COMMAND)").unwrap());
    static LOCAL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^\[?[\d.:a-f*]+\]?:\d+$").unwrap());
    static USERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"users:\(\("([^"]+)""#).unwrap());
    let mut by_port: Vec<ListeningPort> = Vec::new();
    for line in output.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || HEADER.is_match(trimmed) {
            continue;
        }
        let columns: Vec<&str> = trimmed.split_whitespace().collect();
        let lsof = trimmed.ends_with("(LISTEN)") && columns.contains(&"TCP");
        let Some(local) = columns
            .iter()
            .enumerate()
            .find(|(index, column)| *index > 1 && LOCAL.is_match(column))
            .map(|(_, column)| *column)
        else {
            continue;
        };
        let colon = local.rfind(':').unwrap_or(0);
        let Ok(port) = local[colon + 1..].parse::<u32>() else {
            continue;
        };
        if !(1..=65535).contains(&port) {
            continue;
        }
        if !listens_on_loopback(&local[..colon]) {
            continue;
        }
        let process = if lsof {
            Some(columns[0].to_owned())
        } else {
            USERS.captures(trimmed).map(|found| found[1].to_owned())
        };
        match by_port
            .iter_mut()
            .find(|entry| u32::from(entry.port) == port)
        {
            None => by_port.push(ListeningPort {
                port: port as u16,
                process,
            }),
            Some(existing) => {
                if existing.process.is_none() {
                    existing.process = process;
                }
            }
        }
    }
    by_port.sort_by_key(|entry| entry.port);
    by_port
}

/// The listeners worth offering: those whose process the scan named (the
/// user's own), or every one when none is named at all.
pub fn owned_listening_ports(ports: &[ListeningPort]) -> Vec<ListeningPort> {
    let named: Vec<ListeningPort> = ports
        .iter()
        .filter(|entry| entry.process.is_some())
        .cloned()
        .collect();
    if named.is_empty() {
        ports.to_vec()
    } else {
        named
    }
}

#[cfg(test)]
mod tests;
