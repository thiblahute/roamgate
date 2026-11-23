//! The connection manager (server/src/connections/manager.ts): one entry
//! per connection, each with its runtime factory, generation, state and
//! current runtime; starts and stops are shared tasks, and every change of
//! generation invalidates the runtime leases handed out before it.
//!
//! The order of the TS manager is kept: what a TS call does before its
//! first `await` happens here before the call returns (the state
//! published, the factory and the runtime's first step called), and the
//! status observer runs with no lock held, so it may start or stop
//! connections again as the TS observers do.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use roamgate_base::log::{LogFields, Logger};
use serde::Serialize;
use serde_json::json;

/// A connection's identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionIdentity {
    pub id: String,
    pub label: String,
    pub source: String,
}

pub const LEGACY_DEFAULT_CONNECTION_ID: &str = "legacy-default";

impl ConnectionIdentity {
    pub fn new(id: &str, label: &str, source: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            source: source.into(),
        }
    }

    /// The legacy default connection (`legacy-default`, "Default").
    pub fn legacy_default() -> Self {
        Self::new(LEGACY_DEFAULT_CONNECTION_ID, "Default", "legacy-config")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Ready,
    Reconnecting,
    Stopping,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StatusError {
    pub message: String,
}

/// What `connections.list` and the status pushes say of a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionStatus {
    pub id: String,
    pub label: String,
    pub source: String,
    pub is_default: bool,
    pub state: ConnectionState,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StatusError>,
}

/// Why a runtime or a lifecycle step failed, and whether supervision may
/// try again (the TS `SshTunnelError` and `ConnectionProbeError` carry
/// `retryable`; any other error counts as retryable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeError {
    pub message: String,
    pub retryable: bool,
}

impl RuntimeError {
    /// A failure a retry may get past.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    /// A failure no retry gets past (a refused host key, an unsupported
    /// Herdr protocol, a test server's refusal of SSH hosts).
    pub fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

impl From<String> for RuntimeError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

impl From<&str> for RuntimeError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

impl std::ops::Deref for RuntimeError {
    type Target = str;
    fn deref(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RuntimeError {}

impl PartialEq<str> for RuntimeError {
    fn eq(&self, other: &str) -> bool {
        self.message == other
    }
}

impl PartialEq<&str> for RuntimeError {
    fn eq(&self, other: &&str) -> bool {
        self.message == *other
    }
}

/// A shared lifecycle task.
pub type Task = Shared<BoxFuture<'static, Result<(), RuntimeError>>>;

/// A connection's runtime: transport, then background work, then stop.
pub trait ConnectionRuntime: Send + Sync + 'static {
    fn identity(&self) -> ConnectionIdentity;
    fn start_transport(&self) -> BoxFuture<'static, Result<(), RuntimeError>>;
    fn start_background(&self) -> BoxFuture<'static, Result<(), RuntimeError>>;
    fn stop(&self) -> BoxFuture<'static, Result<(), RuntimeError>>;
}

type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;
type ReportError = Arc<dyn Fn(String, bool) + Send + Sync>;

/// What a runtime is made with: its generation, whether it is still the
/// current one, and how it reports a failure (`reconnecting` or error).
#[derive(Clone)]
pub struct RuntimeContext {
    pub generation: u64,
    is_current: IsCurrent,
    report_error: ReportError,
}

impl RuntimeContext {
    pub fn is_current(&self) -> bool {
        (self.is_current)()
    }

    /// A failure of the current runtime: its generation ends at once.
    pub fn report_error(&self, error: &str, reconnecting: bool) {
        (self.report_error)(error.to_owned(), reconnecting)
    }

    /// A context for tests and for runtimes made outside a manager.
    pub fn detached(generation: u64) -> Self {
        Self {
            generation,
            is_current: Arc::new(|| true),
            report_error: Arc::new(|_, _| {}),
        }
    }
}

pub type RuntimeFactory<R> =
    Arc<dyn Fn(RuntimeContext) -> Result<Arc<R>, RuntimeError> + Send + Sync>;

/// A ready runtime handed out for one request.
pub struct ReadyRuntimeLease<R> {
    pub connection_id: String,
    pub generation: u64,
    pub runtime: Arc<R>,
    is_current: IsCurrent,
}

impl<R> ReadyRuntimeLease<R> {
    pub fn is_current(&self) -> bool {
        (self.is_current)()
    }
}

impl<R> Clone for ReadyRuntimeLease<R> {
    fn clone(&self) -> Self {
        Self {
            connection_id: self.connection_id.clone(),
            generation: self.generation,
            runtime: self.runtime.clone(),
            is_current: self.is_current.clone(),
        }
    }
}

const MAX_STATUS_ERROR_LENGTH: usize = 300;

fn redactions() -> &'static [(fancy_regex::Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(fancy_regex::Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)([a-z][a-z\d+.-]*://)([^@\s/]+)@", "$1***@"),
            (
                r"(?i)\b((?:proxy-)?authorization)\s*:\s*(bearer|basic)\s+[^\s,;]+",
                "$1: $2 ***",
            ),
            (
                r#"(?i)(["']?)(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passphrase|token|secret)\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)"#,
                "$1$2$1$3***",
            ),
            (r"\x1b\[[0-?]*[ -/]*[@-~]", ""),
            (r"[\x00-\x1f\x7f-\u{9f}]", " "),
            (r"\s+", " "),
        ]
        .into_iter()
        .map(|(pattern, replacement)| {
            (
                fancy_regex::Regex::new(pattern).expect("a redaction pattern"),
                replacement,
            )
        })
        .collect()
    })
}

/// A connection error as browsers may see it: credentials masked, escape
/// sequences and control characters gone, at most 300 UTF-16 units.
pub fn sanitize_connection_error(raw: &str) -> String {
    let mut text = raw.to_owned();
    for (pattern, replacement) in redactions() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    roamgate_base::log::slice_utf16(text.trim(), MAX_STATUS_ERROR_LENGTH).to_owned()
}

type StatusObserver = Arc<dyn Fn(ConnectionStatus) + Send + Sync>;

struct EntryState<R> {
    serial: u64,
    identity: ConnectionIdentity,
    create: RuntimeFactory<R>,
    generation: u64,
    state: ConnectionState,
    error: Option<String>,
    runtime: Option<Arc<R>>,
    start_token: Option<u64>,
    start_task: Option<(u64, Task)>,
    stop_task: Option<(u64, Task)>,
}

struct ManagerState<R> {
    default_id: String,
    entries: IndexMap<String, EntryState<R>>,
    removing: HashSet<String>,
    stop_all: Option<Task>,
    serial: u64,
}

struct ManagerInner<R> {
    state: Mutex<ManagerState<R>>,
    on_status: Option<StatusObserver>,
    logger: Logger,
}

/// The connection manager. Clones are the same manager.
pub struct ConnectionManager<R> {
    inner: Arc<ManagerInner<R>>,
}

impl<R> Clone for ConnectionManager<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

fn ready_task(result: Result<(), RuntimeError>) -> Task {
    futures_util::future::ready(result).boxed().shared()
}

/// A task fed by the returned sender.
fn deferred_task() -> (tokio::sync::oneshot::Sender<Result<(), RuntimeError>>, Task) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task = async move { rx.await.unwrap_or_else(|_| Err("task dropped".into())) }
        .boxed()
        .shared();
    (tx, task)
}

fn same_runtime<R>(left: &Option<Arc<R>>, right: &Arc<R>) -> bool {
    left.as_ref().is_some_and(|left| Arc::ptr_eq(left, right))
}

fn to_status<R>(entry: &EntryState<R>, default_id: &str) -> ConnectionStatus {
    ConnectionStatus {
        id: entry.identity.id.clone(),
        label: entry.identity.label.clone(),
        source: entry.identity.source.clone(),
        is_default: entry.identity.id == default_id,
        state: entry.state,
        generation: entry.generation,
        error: entry.error.clone().map(|message| StatusError { message }),
    }
}

impl<R: ConnectionRuntime> ConnectionManager<R> {
    pub fn new(
        default_id: &str,
        on_status: Option<StatusObserver>,
        logger: Option<Logger>,
    ) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                state: Mutex::new(ManagerState {
                    default_id: default_id.to_owned(),
                    entries: IndexMap::new(),
                    removing: HashSet::new(),
                    stop_all: None,
                    serial: 0,
                }),
                on_status,
                logger: logger.unwrap_or_else(Logger::silent),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ManagerState<R>> {
        self.inner.state.lock().expect("connection manager")
    }

    fn publish(&self, status: Option<ConnectionStatus>) {
        let (Some(status), Some(observer)) = (status, &self.inner.on_status) else {
            return;
        };
        let id = status.id.clone();
        let observer = observer.clone();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(status))).is_err() {
            self.log_error(
                "connection status observer failed",
                &id,
                "observer panicked",
            );
        }
    }

    fn log_error(&self, message: &str, connection: &str, error: &str) {
        let mut fields = LogFields::new();
        fields.insert("connection".into(), json!(connection));
        fields.insert("error".into(), json!(sanitize_connection_error(error)));
        self.inner.logger.error(message, Some(&fields));
    }

    fn status_of(state: &ManagerState<R>, id: &str) -> Option<ConnectionStatus> {
        state
            .entries
            .get(id)
            .map(|entry| to_status(entry, &state.default_id))
    }

    pub fn register(
        &self,
        identity: ConnectionIdentity,
        create: RuntimeFactory<R>,
    ) -> Result<(), RuntimeError> {
        let status = {
            let mut state = self.lock();
            if state.stop_all.is_some() {
                return Err("connection manager is stopping".into());
            }
            if state.entries.contains_key(&identity.id) {
                return Err(format!("connection already registered: {}", identity.id).into());
            }
            state.serial += 1;
            let serial = state.serial;
            let id = identity.id.clone();
            state.entries.insert(
                id.clone(),
                EntryState {
                    serial,
                    identity,
                    create,
                    generation: 0,
                    state: ConnectionState::Disconnected,
                    error: None,
                    runtime: None,
                    start_token: None,
                    start_task: None,
                    stop_task: None,
                },
            );
            Self::status_of(&state, &id)
        };
        self.publish(status);
        Ok(())
    }

    pub fn default_id(&self) -> String {
        self.lock().default_id.clone()
    }

    pub fn set_default(&self, connection_id: &str) -> Result<(), RuntimeError> {
        let (previous, next) = {
            let mut state = self.lock();
            if state.stop_all.is_some() {
                return Err("connection manager is stopping".into());
            }
            if !state.entries.contains_key(connection_id) || state.removing.contains(connection_id)
            {
                return Err(format!("unknown connection: {connection_id}").into());
            }
            if state.default_id == connection_id {
                return Ok(());
            }
            let previous_id = std::mem::replace(&mut state.default_id, connection_id.to_owned());
            (
                Self::status_of(&state, &previous_id),
                Self::status_of(&state, connection_id),
            )
        };
        self.publish(previous);
        self.publish(next);
        Ok(())
    }

    pub fn has(&self, connection_id: &str) -> bool {
        self.lock().entries.contains_key(connection_id)
    }

    pub fn status(&self, connection_id: &str) -> Result<ConnectionStatus, String> {
        Self::status_of(&self.lock(), connection_id)
            .ok_or_else(|| format!("unknown connection: {connection_id}"))
    }

    pub fn list(&self) -> Vec<ConnectionStatus> {
        let state = self.lock();
        state
            .entries
            .values()
            .map(|entry| to_status(entry, &state.default_id))
            .collect()
    }

    pub fn identity(&self, connection_id: &str) -> Option<ConnectionIdentity> {
        self.lock()
            .entries
            .get(connection_id)
            .map(|entry| entry.identity.clone())
    }

    /// A failed connection whose retry is queued reads as reconnecting.
    pub fn mark_reconnecting(&self, connection_id: &str, error: &str) -> Result<bool, String> {
        let status = {
            let mut state = self.lock();
            let stopping = state.stop_all.is_some() || state.removing.contains(connection_id);
            let default_id = state.default_id.clone();
            let entry = state
                .entries
                .get_mut(connection_id)
                .ok_or_else(|| format!("unknown connection: {connection_id}"))?;
            if stopping
                || !matches!(
                    entry.state,
                    ConnectionState::Error | ConnectionState::Reconnecting
                )
            {
                return Ok(false);
            }
            entry.state = ConnectionState::Reconnecting;
            entry.error = Some(sanitize_connection_error(error));
            to_status(entry, &default_id)
        };
        self.publish(Some(status));
        Ok(true)
    }

    /// Stops a failed runtime, keeping the failure's state for the retry.
    pub fn retire_failed_runtime(&self, connection_id: &str) -> Result<Task, String> {
        let (runtime, start_task, serial, failed_generation, failed_state, failed_error) = {
            let state = self.lock();
            let entry = state
                .entries
                .get(connection_id)
                .ok_or_else(|| format!("unknown connection: {connection_id}"))?;
            if !matches!(
                entry.state,
                ConnectionState::Error | ConnectionState::Reconnecting
            ) {
                return Ok(ready_task(Ok(())));
            }
            if let Some((_, task)) = &entry.stop_task {
                return Ok(task.clone());
            }
            let Some(runtime) = entry.runtime.clone() else {
                return Ok(ready_task(Ok(())));
            };
            (
                runtime,
                entry.start_task.as_ref().map(|(_, task)| task.clone()),
                entry.serial,
                entry.generation,
                entry.state,
                entry.error.clone(),
            )
        };
        let (tx, task) = deferred_task();
        let token = self.install_stop_task(connection_id, serial, task.clone());
        let stopping = runtime.stop();
        let this = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            let (stopped, _) = tokio::join!(stopping, async {
                if let Some(task) = start_task {
                    let _ = task.await;
                }
            });
            let status = {
                let mut state = this.lock();
                let default_id = state.default_id.clone();
                state.entries.get_mut(&id).and_then(|entry| {
                    if entry.serial != serial {
                        return None;
                    }
                    if same_runtime(&entry.runtime, &runtime) {
                        entry.runtime = None;
                    }
                    if entry.generation == failed_generation
                        && matches!(
                            entry.state,
                            ConnectionState::Error | ConnectionState::Reconnecting
                        )
                    {
                        entry.state = failed_state;
                        entry.error = failed_error;
                        return Some(to_status(entry, &default_id));
                    }
                    None
                })
            };
            if let Err(error) = &stopped {
                this.log_error("failed runtime cleanup", &id, error);
            }
            this.publish(status);
            this.clear_stop_task(&id, serial, token);
            let _ = tx.send(Ok(()));
        });
        Ok(task)
    }

    fn install_stop_task(&self, id: &str, serial: u64, task: Task) -> u64 {
        let mut state = self.lock();
        state.serial += 1;
        let token = state.serial;
        if let Some(entry) = state.entries.get_mut(id)
            && entry.serial == serial
        {
            entry.stop_task = Some((token, task));
        }
        token
    }

    fn clear_stop_task(&self, id: &str, serial: u64, token: u64) {
        let mut state = self.lock();
        if let Some(entry) = state.entries.get_mut(id)
            && entry.serial == serial
            && entry.stop_task.as_ref().is_some_and(|(t, _)| *t == token)
        {
            entry.stop_task = None;
        }
    }

    pub fn current_runtime(&self, connection_id: &str) -> Result<Option<Arc<R>>, String> {
        self.lock()
            .entries
            .get(connection_id)
            .map(|entry| entry.runtime.clone())
            .ok_or_else(|| format!("unknown connection: {connection_id}"))
    }

    pub fn default_runtime(&self) -> Option<Arc<R>> {
        let id = self.default_id();
        self.current_runtime(&id).ok().flatten()
    }

    fn is_current_check(
        &self,
        id: &str,
        serial: u64,
        generation: u64,
        runtime: Weak<R>,
        ready: bool,
    ) -> IsCurrent {
        let weak = Arc::downgrade(&self.inner);
        let id = id.to_owned();
        Arc::new(move || {
            let (Some(inner), Some(runtime)) = (weak.upgrade(), runtime.upgrade()) else {
                return false;
            };
            let state = inner.state.lock().expect("connection manager");
            state.entries.get(&id).is_some_and(|entry| {
                entry.serial == serial
                    && entry.generation == generation
                    && same_runtime(&entry.runtime, &runtime)
                    && (!ready || entry.state == ConnectionState::Ready)
            })
        })
    }

    pub fn ready_runtime_lease(
        &self,
        connection_id: &str,
    ) -> Result<Option<ReadyRuntimeLease<R>>, String> {
        let state = self.lock();
        let entry = state
            .entries
            .get(connection_id)
            .ok_or_else(|| format!("unknown connection: {connection_id}"))?;
        let Some(runtime) = entry.runtime.clone() else {
            return Ok(None);
        };
        if entry.state != ConnectionState::Ready {
            return Ok(None);
        }
        let (serial, generation) = (entry.serial, entry.generation);
        drop(state);
        Ok(Some(ReadyRuntimeLease {
            connection_id: connection_id.to_owned(),
            generation,
            is_current: self.is_current_check(
                connection_id,
                serial,
                generation,
                Arc::downgrade(&runtime),
                true,
            ),
            runtime,
        }))
    }

    pub fn ready_runtime(&self, connection_id: &str) -> Option<Arc<R>> {
        self.ready_runtime_lease(connection_id)
            .ok()
            .flatten()
            .map(|lease| lease.runtime)
    }

    pub fn default_ready_runtime(&self) -> Option<Arc<R>> {
        let id = self.default_id();
        self.ready_runtime(&id)
    }

    pub fn current_runtimes(&self) -> Vec<Arc<R>> {
        self.lock()
            .entries
            .values()
            .filter_map(|entry| entry.runtime.clone())
            .collect()
    }

    pub fn start_default(&self) -> Task {
        let id = self.default_id();
        self.start(&id)
    }

    /// Starts a connection; concurrent starts share one task.
    pub fn start(&self, connection_id: &str) -> Task {
        let prepared = {
            let mut state = self.lock();
            let removing = state.removing.contains(connection_id);
            let stopping = state.stop_all.is_some();
            state.serial += 1;
            let token = state.serial;
            let Some(entry) = state.entries.get_mut(connection_id) else {
                return ready_task(Err(format!("unknown connection: {connection_id}").into()));
            };
            if removing {
                return ready_task(Err(
                    format!("connection is being removed: {connection_id}").into()
                ));
            }
            if stopping {
                return ready_task(Err("connection manager is stopping".into()));
            }
            if entry.state == ConnectionState::Ready {
                return ready_task(Ok(()));
            }
            if let Some((_, stop)) = &entry.stop_task {
                let stop = stop.clone();
                let this = self.clone();
                let id = connection_id.to_owned();
                return async move {
                    stop.await?;
                    this.start(&id).await
                }
                .boxed()
                .shared();
            }
            if let Some((_, task)) = &entry.start_task {
                return task.clone();
            }
            entry.start_token = Some(token);
            let (tx, task) = deferred_task();
            entry.start_task = Some((token, task.clone()));
            (entry.serial, token, tx, task)
        };
        let (serial, token, tx, task) = prepared;
        let begun = self.begin_start(connection_id, serial, token);
        let this = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            let result = begun.await;
            {
                let mut state = this.lock();
                if let Some(entry) = state.entries.get_mut(&id)
                    && entry.serial == serial
                {
                    if entry.start_task.as_ref().is_some_and(|(t, _)| *t == token) {
                        entry.start_task = None;
                    }
                    if entry.start_token == Some(token) {
                        entry.start_token = None;
                    }
                }
            }
            let _ = tx.send(result);
        });
        task
    }

    /// The start's work up to its first wait, done now; the rest returned.
    fn begin_start(
        &self,
        id: &str,
        serial: u64,
        token: u64,
    ) -> BoxFuture<'static, Result<(), RuntimeError>> {
        let retired = {
            let mut state = self.lock();
            let default_id = state.default_id.clone();
            match state.entries.get_mut(id) {
                Some(entry) if entry.serial == serial => entry.runtime.clone().map(|runtime| {
                    entry.generation += 1;
                    entry.state = ConnectionState::Stopping;
                    entry.error = None;
                    (runtime, to_status(entry, &default_id))
                }),
                _ => return futures_util::future::ready(Ok(())).boxed(),
            }
        };
        let Some((retired, status)) = retired else {
            return self.create_and_run(id, serial);
        };
        self.publish(Some(status));
        let stopping = retired.stop();
        let this = self.clone();
        let id = id.to_owned();
        async move {
            if let Err(error) = stopping.await {
                let status = {
                    let mut state = this.lock();
                    let default_id = state.default_id.clone();
                    state.entries.get_mut(&id).map(|entry| {
                        entry.state = ConnectionState::Error;
                        entry.error = Some(sanitize_connection_error(&error));
                        to_status(entry, &default_id)
                    })
                };
                this.publish(status);
                return Err(error);
            }
            let proceed = {
                let mut state = this.lock();
                match state.entries.get_mut(&id) {
                    Some(entry) if entry.serial == serial => {
                        if same_runtime(&entry.runtime, &retired) {
                            entry.runtime = None;
                        }
                        entry.start_token == Some(token)
                    }
                    _ => false,
                }
            };
            if !proceed {
                return Ok(());
            }
            this.create_and_run(&id, serial).await
        }
        .boxed()
    }

    /// A new generation's runtime, made and started.
    fn create_and_run(
        &self,
        id: &str,
        serial: u64,
    ) -> BoxFuture<'static, Result<(), RuntimeError>> {
        let (generation, create) = {
            let mut state = self.lock();
            let Some(entry) = state.entries.get_mut(id) else {
                return futures_util::future::ready(Ok(())).boxed();
            };
            entry.generation += 1;
            entry.state = ConnectionState::Connecting;
            entry.error = None;
            (entry.generation, entry.create.clone())
        };
        let slot: Arc<OnceLock<Weak<R>>> = Arc::default();
        let weak = Arc::downgrade(&self.inner);
        let current = {
            let slot = slot.clone();
            let weak = weak.clone();
            let id = id.to_owned();
            Arc::new(move || {
                let (Some(inner), Some(runtime)) =
                    (weak.upgrade(), slot.get().and_then(Weak::upgrade))
                else {
                    return false;
                };
                let state = inner.state.lock().expect("connection manager");
                state.entries.get(&id).is_some_and(|entry| {
                    entry.serial == serial
                        && entry.generation == generation
                        && same_runtime(&entry.runtime, &runtime)
                })
            }) as IsCurrent
        };
        let report: ReportError = {
            let current = current.clone();
            let this = Arc::downgrade(&self.inner);
            let id = id.to_owned();
            Arc::new(move |error: String, reconnecting: bool| {
                let Some(inner) = this.upgrade() else {
                    return;
                };
                let manager = ConnectionManager { inner };
                if !current() {
                    return;
                }
                let status = {
                    let mut state = manager.lock();
                    let default_id = state.default_id.clone();
                    state.entries.get_mut(&id).map(|entry| {
                        entry.generation += 1;
                        entry.state = if reconnecting {
                            ConnectionState::Reconnecting
                        } else {
                            ConnectionState::Error
                        };
                        entry.error = Some(sanitize_connection_error(&error));
                        to_status(entry, &default_id)
                    })
                };
                manager.publish(status);
            })
        };
        let context = RuntimeContext {
            generation,
            is_current: current.clone(),
            report_error: report,
        };
        let created = create(context);
        let runtime = match created {
            Ok(runtime) => runtime,
            Err(error) => {
                let status = {
                    let mut state = self.lock();
                    let default_id = state.default_id.clone();
                    state.entries.get_mut(id).and_then(|entry| {
                        (entry.generation == generation).then(|| {
                            entry.state = ConnectionState::Error;
                            entry.error = Some(sanitize_connection_error(&error));
                            to_status(entry, &default_id)
                        })
                    })
                };
                self.publish(status);
                return futures_util::future::ready(Err(error)).boxed();
            }
        };
        let _ = slot.set(Arc::downgrade(&runtime));
        let mismatch = {
            let mut state = self.lock();
            let default_id = state.default_id.clone();
            let entry = state.entries.get_mut(id);
            match entry {
                Some(entry) => {
                    entry.runtime = Some(runtime.clone());
                    let actual = runtime.identity().id;
                    if actual != entry.identity.id {
                        Err(format!(
                            "runtime identity mismatch: expected {}, received {actual}",
                            entry.identity.id
                        )
                        .into())
                    } else {
                        Ok(to_status(entry, &default_id))
                    }
                }
                None => return futures_util::future::ready(Ok(())).boxed(),
            }
        };
        let this = self.clone();
        let id = id.to_owned();
        let transport = match mismatch {
            Err(error) => {
                return async move { this.fail_start(&id, &runtime, current, error).await }.boxed();
            }
            Ok(status) => {
                self.publish(Some(status));
                runtime.start_transport()
            }
        };
        async move {
            if let Err(error) = transport.await {
                return this.fail_start(&id, &runtime, current, error).await;
            }
            if !current() {
                return this.drop_stale(&id, serial, &runtime).await;
            }
            if let Err(error) = runtime.start_background().await {
                return this.fail_start(&id, &runtime, current, error).await;
            }
            if !current() {
                return this.drop_stale(&id, serial, &runtime).await;
            }
            let status = {
                let mut state = this.lock();
                let default_id = state.default_id.clone();
                state.entries.get_mut(&id).map(|entry| {
                    entry.state = ConnectionState::Ready;
                    entry.error = None;
                    to_status(entry, &default_id)
                })
            };
            this.publish(status);
            Ok(())
        }
        .boxed()
    }

    /// A start no longer current: its runtime stops unless a stop has it.
    async fn drop_stale(
        &self,
        id: &str,
        serial: u64,
        runtime: &Arc<R>,
    ) -> Result<(), RuntimeError> {
        let stop_pending = {
            let state = self.lock();
            state
                .entries
                .get(id)
                .is_some_and(|entry| entry.serial == serial && entry.stop_task.is_some())
        };
        if stop_pending {
            return Ok(());
        }
        let stopped = runtime.stop().await;
        let mut state = self.lock();
        if let Some(entry) = state.entries.get_mut(id)
            && same_runtime(&entry.runtime, runtime)
        {
            entry.runtime = None;
        }
        stopped
    }

    async fn fail_start(
        &self,
        id: &str,
        runtime: &Arc<R>,
        current: IsCurrent,
        error: RuntimeError,
    ) -> Result<(), RuntimeError> {
        if current() {
            let status = {
                let mut state = self.lock();
                let default_id = state.default_id.clone();
                state.entries.get_mut(id).map(|entry| {
                    entry.generation += 1;
                    entry.state = ConnectionState::Error;
                    entry.error = Some(sanitize_connection_error(&error));
                    to_status(entry, &default_id)
                })
            };
            self.publish(status);
            let stopped = runtime.stop().await;
            {
                let mut state = self.lock();
                if let Some(entry) = state.entries.get_mut(id)
                    && same_runtime(&entry.runtime, runtime)
                {
                    entry.runtime = None;
                }
            }
            if let Err(cleanup) = stopped {
                self.log_error("failed runtime cleanup", id, &cleanup);
            }
        }
        Err(error)
    }

    /// Stops a connection; concurrent stops share one task.
    pub fn stop(&self, connection_id: &str) -> Task {
        let prepared = {
            let mut state = self.lock();
            let default_id = state.default_id.clone();
            state.serial += 1;
            let token = state.serial;
            let Some(entry) = state.entries.get_mut(connection_id) else {
                return ready_task(Err(format!("unknown connection: {connection_id}").into()));
            };
            if let Some((_, stop)) = &entry.stop_task {
                if matches!(
                    entry.state,
                    ConnectionState::Error | ConnectionState::Reconnecting
                ) {
                    let stop = stop.clone();
                    let this = self.clone();
                    let id = connection_id.to_owned();
                    return async move {
                        stop.await?;
                        this.stop(&id).await
                    }
                    .boxed()
                    .shared();
                }
                return stop.clone();
            }
            if entry.runtime.is_none() && entry.start_task.is_none() {
                let status = (entry.state != ConnectionState::Disconnected).then(|| {
                    entry.state = ConnectionState::Disconnected;
                    entry.error = None;
                    to_status(entry, &default_id)
                });
                drop(state);
                self.publish(status);
                return ready_task(Ok(()));
            }
            let runtime = entry.runtime.clone();
            let start_task = entry.start_task.as_ref().map(|(_, task)| task.clone());
            entry.start_token = None;
            let (tx, task) = deferred_task();
            entry.stop_task = Some((token, task.clone()));
            // Install the stop before this publish so an observer can only
            // queue a restart behind it.
            entry.generation += 1;
            entry.state = ConnectionState::Stopping;
            entry.error = None;
            let status = to_status(entry, &default_id);
            (entry.serial, token, runtime, start_task, tx, task, status)
        };
        let (serial, token, runtime, start_task, tx, task, status) = prepared;
        self.publish(Some(status));
        let stopping = runtime.as_ref().map(|runtime| runtime.stop());
        let this = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            let (stopped, _) = tokio::join!(
                async {
                    match stopping {
                        Some(stopping) => stopping.await,
                        None => Ok(()),
                    }
                },
                async {
                    if let Some(task) = start_task {
                        let _ = task.await;
                    }
                }
            );
            let (status, result) = {
                let mut state = this.lock();
                let default_id = state.default_id.clone();
                match state.entries.get_mut(&id) {
                    Some(entry) if entry.serial == serial => {
                        if let Some(runtime) = &runtime
                            && same_runtime(&entry.runtime, runtime)
                        {
                            entry.runtime = None;
                        }
                        match &stopped {
                            Err(error) => {
                                entry.state = ConnectionState::Error;
                                entry.error = Some(sanitize_connection_error(error));
                            }
                            Ok(()) => {
                                entry.state = ConnectionState::Disconnected;
                                entry.error = None;
                            }
                        }
                        if entry.stop_task.as_ref().is_some_and(|(t, _)| *t == token) {
                            entry.stop_task = None;
                        }
                        (Some(to_status(entry, &default_id)), stopped)
                    }
                    _ => (None, stopped),
                }
            };
            this.publish(status);
            let _ = tx.send(result);
        });
        task
    }

    /// Removes a non-default connection after draining its runtime.
    pub async fn unregister(&self, connection_id: &str) -> Result<(), RuntimeError> {
        let serial = {
            let mut state = self.lock();
            let Some(entry) = state.entries.get(connection_id) else {
                return Err(format!("unknown connection: {connection_id}").into());
            };
            let serial = entry.serial;
            if state.stop_all.is_some() {
                return Err("connection manager is stopping".into());
            }
            if connection_id == state.default_id {
                return Err("cannot remove the default connection".into());
            }
            if !state.removing.insert(connection_id.to_owned()) {
                return Err(format!("connection is already being removed: {connection_id}").into());
            }
            serial
        };
        let cleanup = self.stop(connection_id).await;
        let mut state = self.lock();
        state.removing.remove(connection_id);
        if state
            .entries
            .get(connection_id)
            .is_none_or(|entry| entry.serial != serial)
        {
            return Err(format!("connection changed while being removed: {connection_id}").into());
        }
        // Once stop invalidated the lease, the factory goes even when the
        // runtime's cleanup failed, so the profile can never reconnect.
        state.entries.shift_remove(connection_id);
        drop(state);
        if let Err(error) = cleanup {
            self.log_error(
                "connection unregister cleanup failed",
                connection_id,
                &error,
            );
        }
        Ok(())
    }

    /// Replaces a connection's identity and factory, stopping its runtime;
    /// a start queued behind that stop makes the replacement.
    pub async fn replace(
        &self,
        identity: ConnectionIdentity,
        create: RuntimeFactory<R>,
    ) -> Result<(), RuntimeError> {
        let id = identity.id.clone();
        {
            let mut state = self.lock();
            let stopping = state.stop_all.is_some();
            let removing = state.removing.contains(&id);
            let Some(entry) = state.entries.get_mut(&id) else {
                return Err(format!("unknown connection: {id}").into());
            };
            if stopping {
                return Err("connection manager is stopping".into());
            }
            if removing {
                return Err(format!("connection is being removed: {id}").into());
            }
            entry.start_token = None;
            entry.generation += 1;
            entry.identity = identity;
            entry.create = create;
            entry.error = None;
        }
        self.stop(&id).await?;
        let status = Self::status_of(&self.lock(), &id);
        self.publish(status);
        Ok(())
    }

    /// Stops every connection once; later registrations are refused.
    pub fn stop_all(&self) -> Task {
        let ids = {
            let mut state = self.lock();
            if let Some(task) = &state.stop_all {
                return task.clone();
            }
            let (tx, task) = deferred_task();
            state.stop_all = Some(task.clone());
            let ids: Vec<String> = state.entries.keys().cloned().collect();
            (ids, tx, task)
        };
        let (ids, tx, task) = ids;
        let stops: Vec<(String, Task)> = ids
            .into_iter()
            .map(|id| {
                let stop = self.stop(&id);
                (id, stop)
            })
            .collect();
        let this = self.clone();
        tokio::spawn(async move {
            for (id, stop) in stops {
                if let Err(error) = stop.await {
                    this.log_error("connection stop failed", &id, &error);
                }
            }
            let _ = tx.send(Ok(()));
        });
        task
    }
}

#[cfg(test)]
mod tests;
