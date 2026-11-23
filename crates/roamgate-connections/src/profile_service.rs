//! The connection profile service
//! (server/src/connections/profile-service.ts): the profiles the manager
//! runs at startup (`connections.json`, or the synthetic legacy profile),
//! their mutations one at a time with rollback when a step fails, the
//! probes of a profile's Herdr sockets, and the supervision of SSH
//! profiles that retries a transient failure with bounded exponential
//! jitter.
//!
//! The order of the TS service is kept as the manager keeps its own (see
//! [`crate::manager`]): a mutation takes its place in the queue when it is
//! called and runs once the ones before it settled, failed or not; what a
//! TS call does before its first `await` (enabling retries, reading the
//! generation, the manager's start) happens here before the call returns.
//! The TS `AggregateError`s are [`ProfileServiceError`]s with the
//! aggregate's message and its errors in `errors`.

use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use indexmap::{IndexMap, IndexSet};
use roamgate_base::clock::{SharedClock, SystemClock};
use roamgate_exec::ssh::sessions::SshSessions;
use roamgate_exec::ssh::tunnel::{RunProcess, SshTunnelArgs, SshTunnelManager, TunnelDeps};
use roamgate_herdr::control::{HerdrClient, HerdrClientOptions};
use roamgate_herdr::protocol::assert_supported_herdr_protocol;
use roamgate_herdr::thin::{ConnectOptions, ThinClient};
use serde::Serialize;
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::host_runtime::tunnel_error;
use crate::manager::{
    ConnectionIdentity, ConnectionManager, ConnectionRuntime, ConnectionState, ConnectionStatus,
    LEGACY_DEFAULT_CONNECTION_ID, RuntimeError, RuntimeFactory,
};
use crate::profiles::{
    CONNECTION_PROFILE_FILE_VERSION, ConnectionProfile, ConnectionProfileStore,
    LocalConnectionProfile, PersistedConnectionRegistry, current_platform,
    public_connection_profile, validate_connection_profile,
};
use crate::ssh_profile_runtime::{SshRuntimeConfigDeps, create_ssh_profile_runtime_config};

/// A profile the manager runs: a persisted one, or the synthetic legacy
/// local profile (a [`ConnectionProfile::Local`] with the id
/// `legacy-default`).
pub type ManagedConnectionProfile = ConnectionProfile;

/// The synthetic legacy profile: the configured local sockets under
/// `legacy-default`, "Default".
pub fn synthetic_legacy_profile(
    control_socket_path: &str,
    client_socket_path: &str,
) -> ManagedConnectionProfile {
    ConnectionProfile::Local(LocalConnectionProfile {
        id: LEGACY_DEFAULT_CONNECTION_ID.into(),
        label: "Default".into(),
        control_socket_path: control_socket_path.into(),
        client_socket_path: client_socket_path.into(),
        auto_connect: true,
    })
}

/// A profile registered at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRegistration {
    pub profile: ManagedConnectionProfile,
    pub read_only: bool,
}

/// What startup registers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionProfileBootstrap {
    pub default_connection_id: String,
    pub explicit_legacy_override: bool,
    pub persisted_registry: Option<PersistedConnectionRegistry>,
    /// Set when startup preserved an invalid registry and fell back to legacy.
    pub registry_load_error: Option<String>,
    pub registrations: Vec<ProfileRegistration>,
}

/// The profiles startup registers: the persisted ones, with the legacy
/// profile first (and the default) when the CLI or environment named a
/// connection, or the legacy profile alone when nothing is persisted. A
/// registry that does not load is an error (the caller preserves it).
pub fn load_connection_profile_bootstrap(
    store: &ConnectionProfileStore,
    legacy_profile: &ManagedConnectionProfile,
    explicit_legacy_override: bool,
) -> Result<ConnectionProfileBootstrap, String> {
    let persisted_registry = store.load()?;
    let persisted: Vec<ProfileRegistration> = persisted_registry
        .as_ref()
        .map(|registry| {
            registry
                .profiles
                .iter()
                .map(|profile| ProfileRegistration {
                    profile: profile.clone(),
                    read_only: false,
                })
                .collect()
        })
        .unwrap_or_default();
    let legacy = ProfileRegistration {
        profile: legacy_profile.clone(),
        read_only: true,
    };
    if explicit_legacy_override {
        let mut registrations = vec![legacy];
        registrations.extend(persisted);
        return Ok(ConnectionProfileBootstrap {
            default_connection_id: LEGACY_DEFAULT_CONNECTION_ID.into(),
            explicit_legacy_override: true,
            persisted_registry,
            registry_load_error: None,
            registrations,
        });
    }
    if let Some(registry) = persisted_registry {
        return Ok(ConnectionProfileBootstrap {
            default_connection_id: registry.default_connection_id.clone(),
            explicit_legacy_override: false,
            persisted_registry: Some(registry),
            registry_load_error: None,
            registrations: persisted,
        });
    }
    Ok(ConnectionProfileBootstrap {
        default_connection_id: LEGACY_DEFAULT_CONNECTION_ID.into(),
        explicit_legacy_override: false,
        persisted_registry: None,
        registry_load_error: None,
        registrations: vec![legacy],
    })
}

/// A profile's identity: `legacy-config`, `ssh-profile` or `local-profile`.
pub fn connection_identity_for_profile(profile: &ManagedConnectionProfile) -> ConnectionIdentity {
    let source = if profile.id() == LEGACY_DEFAULT_CONNECTION_ID {
        "legacy-config"
    } else if profile.is_ssh() {
        "ssh-profile"
    } else {
        "local-profile"
    };
    ConnectionIdentity::new(profile.id(), profile.label(), source)
}

/// Makes the manager's runtime factory of a profile.
pub type ConnectionProfileRuntimeFactory<R> =
    Arc<dyn Fn(&ManagedConnectionProfile) -> RuntimeFactory<R> + Send + Sync>;

/// What a successful probe answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProbeResult {
    pub ok: bool,
    pub version: Option<String>,
    pub protocol: i64,
}

/// Probes a profile (`testProfile`); a failure's `retryable` is false for
/// the TS `ConnectionProbeError`s and `SshTunnelError`s that are permanent.
pub type TestProfile = Arc<
    dyn Fn(ManagedConnectionProfile) -> BoxFuture<Result<ProbeResult, RuntimeError>> + Send + Sync,
>;

/// What a service call fails with: the TS error's message and whether a
/// retry may get past it. A TS `AggregateError` is one with its message
/// and its errors in `errors`, the failure that started it first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileServiceError {
    pub message: String,
    pub retryable: bool,
    pub errors: Vec<RuntimeError>,
}

impl ProfileServiceError {
    fn aggregate(message: &str, errors: Vec<RuntimeError>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            errors,
        }
    }
}

impl From<RuntimeError> for ProfileServiceError {
    fn from(error: RuntimeError) -> Self {
        Self {
            message: error.message,
            retryable: error.retryable,
            errors: Vec::new(),
        }
    }
}

impl From<String> for ProfileServiceError {
    fn from(message: String) -> Self {
        RuntimeError::new(message).into()
    }
}

impl From<&str> for ProfileServiceError {
    fn from(message: &str) -> Self {
        RuntimeError::new(message).into()
    }
}

impl std::fmt::Display for ProfileServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProfileServiceError {}

/// The failures a probe's handshake cannot get past by trying again.
fn permanent_probe_failure() -> &'static fancy_regex::Regex {
    static PATTERN: OnceLock<fancy_regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        fancy_regex::Regex::new(
            r"(?i)(?:protocol .*not supported|rejected thin-client protocol|welcomed protocol|unsupported encoding|bincode:|invalid protocol version)",
        )
        .expect("the permanent probe failure pattern")
    })
}

/// Pings the control socket (8 s), checks its protocol (a refusal is
/// permanent, and the client socket is not opened), then completes the
/// client socket's Hello/Welcome at 80x24.
pub async fn test_connection_sockets(
    control_socket_path: &str,
    client_socket_path: &str,
) -> Result<ProbeResult, RuntimeError> {
    let herdr = HerdrClient::new(control_socket_path, HerdrClientOptions::default());
    let ping = herdr
        .call("ping", json!({}), 8_000, None, false)
        .await
        .map_err(RuntimeError::new)?;
    let protocol = ping.get("protocol").cloned().unwrap_or(Value::Null);
    assert_supported_herdr_protocol(&protocol).map_err(RuntimeError::permanent)?;
    let thin = ThinClient::new(client_socket_path, None);
    let welcomed = thin
        .connect(
            std::future::ready(protocol.clone()),
            80,
            24,
            ConnectOptions::default(),
        )
        .await;
    thin.close();
    if let Err(message) = welcomed {
        let permanent = permanent_probe_failure()
            .is_match(&message)
            .unwrap_or(false);
        return Err(RuntimeError {
            message,
            retryable: !permanent,
        });
    }
    Ok(ProbeResult {
        ok: true,
        version: ping
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        protocol: protocol.as_i64().expect("a supported protocol"),
    })
}

/// Probes a local profile's sockets.
pub async fn test_local_connection_profile(
    profile: &LocalConnectionProfile,
) -> Result<ProbeResult, RuntimeError> {
    test_connection_sockets(&profile.control_socket_path, &profile.client_socket_path).await
}

/// What an SSH profile's probe opens its tunnel with (the TS module's
/// globals: the SSH sessions, `runProcess`, the tunnel's and the runtime
/// directory's dependencies).
#[derive(Clone)]
pub struct SshProbeEnvironment {
    pub sessions: SshSessions,
    pub run_process: RunProcess,
    pub tunnel_deps: TunnelDeps,
    pub runtime_config: Arc<SshRuntimeConfigDeps>,
}

impl SshProbeEnvironment {
    /// The real one, for a probe outside a running server (`roamgate
    /// connections test`, `roamgate doctor`): its own session slots, the
    /// system's processes, a runtime directory under the environment's root.
    pub fn real(environment: Arc<dyn roamgate_base::env::Env>) -> Self {
        let sessions = SshSessions::new(Arc::new(SystemClock));
        let runner = roamgate_exec::process::ProcessRunner::system();
        Self {
            run_process: crate::host_ops::HostOps::new(sessions.clone(), runner.clone())
                .tunnel_run_process(),
            sessions,
            tunnel_deps: TunnelDeps::real(runner),
            runtime_config: Arc::new(SshRuntimeConfigDeps::real(environment)),
        }
    }
}

/// Probes a profile: a local one directly, an SSH one through a tunnel
/// started for the probe and cleaned up after it.
pub async fn test_connection_profile(
    profile: &ManagedConnectionProfile,
    environment: &SshProbeEnvironment,
) -> Result<ProbeResult, RuntimeError> {
    let profile = match profile {
        ConnectionProfile::Local(local) => return test_local_connection_profile(local).await,
        ConnectionProfile::Ssh(ssh) => ssh,
    };
    let config = create_ssh_profile_runtime_config(profile, &environment.runtime_config)
        .map_err(RuntimeError::new)?;
    let tunnel = SshTunnelManager::new(SshTunnelArgs {
        sessions: environment.sessions.clone(),
        connection_id: None,
        config: config.clone(),
        run_process: environment.run_process.clone(),
        on_unexpected_exit: None,
        on_master_ready: None,
        deps: environment.tunnel_deps.clone(),
    })
    .map_err(|failure| RuntimeError {
        message: failure.message,
        retryable: failure.retryable,
    })?;
    let probed = async {
        tunnel.start().await.map_err(tunnel_error)?;
        test_connection_sockets(&config.socket_path, &config.client_socket_path).await
    }
    .await;
    tunnel.cleanup().await.map_err(tunnel_error)?;
    probed
}

/// [`test_connection_profile`] on `environment`, as a service's
/// `test_profile`.
pub fn connection_profile_tester(environment: SshProbeEnvironment) -> TestProfile {
    let environment = Arc::new(environment);
    Arc::new(move |profile| {
        let environment = environment.clone();
        Box::pin(async move { test_connection_profile(&profile, &environment).await })
    })
}

/// A scheduled retry or stable-reset timer; `cancel` stops it.
pub struct RetryTimer {
    cancel: Box<dyn FnOnce() + Send>,
}

impl RetryTimer {
    pub fn new(cancel: impl FnOnce() + Send + 'static) -> Self {
        Self {
            cancel: Box::new(cancel),
        }
    }

    fn cancel(self) {
        (self.cancel)()
    }
}

/// What a timer runs when it fires.
pub type RetryCallback = Box<dyn FnOnce() + Send>;
/// Schedules `callback` after a delay in milliseconds.
pub type RetrySchedule = Arc<dyn Fn(RetryCallback, u64) -> RetryTimer + Send + Sync>;
/// A number in [0, 1) (`Math.random`).
pub type RetryRandom = Arc<dyn Fn() -> f64 + Send + Sync>;

/// SSH retry supervision's settings; unset ones are the defaults.
#[derive(Clone, Default)]
pub struct ConnectionRetryOptions {
    /// 1000 ms.
    pub base_delay_ms: Option<u64>,
    /// 30000 ms.
    pub max_delay_ms: Option<u64>,
    /// Consecutive failed attempts before supervision gives up. Unlimited
    /// by default: a connection the user has not disconnected or removed
    /// keeps retrying at the capped backoff, so it recovers on its own
    /// after an outage of any length.
    pub max_attempts: Option<u64>,
    /// 30000 ms.
    pub stable_reset_ms: Option<u64>,
    pub random: Option<RetryRandom>,
    /// The default: timers on `clock`.
    pub schedule: Option<RetrySchedule>,
    /// The default schedule's clock (the system clock).
    pub clock: Option<SharedClock>,
}

/// What a service is made from.
pub struct ConnectionProfileServiceArgs<R> {
    pub manager: ConnectionManager<R>,
    pub store: Arc<ConnectionProfileStore>,
    pub bootstrap: ConnectionProfileBootstrap,
    pub create_runtime: ConnectionProfileRuntimeFactory<R>,
    /// The real one is [`connection_profile_tester`].
    pub test_profile: TestProfile,
    pub retry: ConnectionRetryOptions,
}

struct ProfileEntry {
    profile: ManagedConnectionProfile,
    read_only: bool,
}

#[derive(Default)]
struct RetryState {
    enabled: bool,
    attempt: u64,
    token: u64,
    retry_timer: Option<RetryTimer>,
    stable_timer: Option<RetryTimer>,
}

impl RetryState {
    fn cancel_timers(&mut self) {
        if let Some(timer) = self.retry_timer.take() {
            timer.cancel();
        }
        if let Some(timer) = self.stable_timer.take() {
            timer.cancel();
        }
    }
}

struct ServiceState {
    profiles: IndexMap<String, ProfileEntry>,
    registry: Option<PersistedConnectionRegistry>,
    retry_states: IndexMap<String, RetryState>,
    supervision_stopped: bool,
    mutation_disabled_error: Option<String>,
}

struct Retry {
    base_delay_ms: u64,
    max_delay_ms: u64,
    max_attempts: Option<u64>,
    stable_reset_ms: u64,
    random: RetryRandom,
    schedule: RetrySchedule,
}

struct ServiceInner<R> {
    manager: ConnectionManager<R>,
    store: Arc<ConnectionProfileStore>,
    explicit_legacy_override: bool,
    /// The bootstrap's legacy profile, which the first create seeds from.
    legacy_profile: Option<ManagedConnectionProfile>,
    create_runtime: ConnectionProfileRuntimeFactory<R>,
    test_profile: TestProfile,
    retry: Retry,
    state: Mutex<ServiceState>,
    /// The last queued mutation, settled or not.
    queue: Mutex<Shared<BoxFuture<()>>>,
}

/// The connection profile service. Clones are the same service.
pub struct ConnectionProfileService<R> {
    inner: Arc<ServiceInner<R>>,
}

impl<R> Clone for ConnectionProfileService<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

const INVALID_REGISTRY: &str =
    "connection registry is invalid; repair or remove it before changing profiles";
const ROLLBACK_FAILED: &str = "connection profile mutations are disabled because persistence rollback failed; restart the bridge and repair the registry before making further changes";

fn default_schedule(clock: SharedClock) -> RetrySchedule {
    Arc::new(move |callback: RetryCallback, delay_ms| {
        let sleep = clock.sleep(Duration::from_millis(delay_ms));
        let task = tokio::spawn(async move {
            sleep.await;
            callback();
        });
        RetryTimer::new(move || task.abort())
    })
}

fn is_active(state: ConnectionState) -> bool {
    matches!(
        state,
        ConnectionState::Ready | ConnectionState::Connecting | ConnectionState::Reconnecting
    )
}

/// A connection's status with its public profile, keys in the TS spread's
/// order.
fn list_item(status: ConnectionStatus, entry: &ProfileEntry) -> Value {
    let mut item = serde_json::to_value(status).expect("a status");
    let map = item.as_object_mut().expect("an object");
    if let Value::Object(profile) = public_connection_profile(&entry.profile, entry.read_only) {
        for (key, value) in profile {
            map.insert(key, value);
        }
    }
    item
}

fn connection_id(value: &Value) -> Result<String, ProfileServiceError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "connection id is required".into())
}

impl<R: ConnectionRuntime> ConnectionProfileService<R> {
    /// Registers every bootstrap profile with the manager.
    pub fn new(args: ConnectionProfileServiceArgs<R>) -> Result<Self, RuntimeError> {
        let ConnectionProfileServiceArgs {
            manager,
            store,
            bootstrap,
            create_runtime,
            test_profile,
            retry,
        } = args;
        let base_delay_ms = retry.base_delay_ms.unwrap_or(1000).max(1);
        let retry = Retry {
            base_delay_ms,
            max_delay_ms: retry.max_delay_ms.unwrap_or(30_000).max(base_delay_ms),
            max_attempts: retry.max_attempts.map(|attempts| attempts.max(1)),
            stable_reset_ms: retry.stable_reset_ms.unwrap_or(30_000).max(1),
            random: retry
                .random
                .unwrap_or_else(|| Arc::new(rand::random::<f64>)),
            schedule: retry.schedule.unwrap_or_else(|| {
                default_schedule(retry.clock.unwrap_or_else(|| Arc::new(SystemClock)))
            }),
        };
        let mut profiles = IndexMap::new();
        for registration in &bootstrap.registrations {
            profiles.insert(
                registration.profile.id().to_owned(),
                ProfileEntry {
                    profile: registration.profile.clone(),
                    read_only: registration.read_only,
                },
            );
            manager.register(
                connection_identity_for_profile(&registration.profile),
                create_runtime(&registration.profile),
            )?;
        }
        let legacy_profile = bootstrap
            .registrations
            .iter()
            .find(|registration| registration.profile.id() == LEGACY_DEFAULT_CONNECTION_ID)
            .map(|registration| registration.profile.clone());
        Ok(Self {
            inner: Arc::new(ServiceInner {
                manager,
                store,
                explicit_legacy_override: bootstrap.explicit_legacy_override,
                legacy_profile,
                create_runtime,
                test_profile,
                retry,
                state: Mutex::new(ServiceState {
                    profiles,
                    registry: bootstrap.persisted_registry,
                    retry_states: IndexMap::new(),
                    supervision_stopped: false,
                    mutation_disabled_error: bootstrap
                        .registry_load_error
                        .map(|_| INVALID_REGISTRY.to_owned()),
                }),
                queue: Mutex::new(futures_util::future::ready(()).boxed().shared()),
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ServiceState> {
        self.inner.state.lock().expect("connection profile service")
    }

    fn manager(&self) -> &ConnectionManager<R> {
        &self.inner.manager
    }

    fn register_profile(&self, profile: &ManagedConnectionProfile) -> Result<(), RuntimeError> {
        self.manager().register(
            connection_identity_for_profile(profile),
            (self.inner.create_runtime)(profile),
        )
    }

    async fn replace_profile(
        &self,
        profile: &ManagedConnectionProfile,
    ) -> Result<(), RuntimeError> {
        self.manager()
            .replace(
                connection_identity_for_profile(profile),
                (self.inner.create_runtime)(profile),
            )
            .await
    }

    /// Every connection's status with its public profile.
    pub fn list(&self) -> Result<Vec<Value>, String> {
        let statuses = self.manager().list();
        let state = self.lock();
        statuses
            .into_iter()
            .map(|status| {
                let entry = state
                    .profiles
                    .get(&status.id)
                    .ok_or_else(|| format!("unknown connection: {}", status.id))?;
                Ok(list_item(status, entry))
            })
            .collect()
    }

    /// Whether supervision retries this failure of the connection.
    pub fn will_retry(&self, connection_id: &str, error: &RuntimeError) -> bool {
        let state = self.lock();
        let is_ssh = state
            .profiles
            .get(connection_id)
            .is_some_and(|entry| entry.profile.is_ssh());
        let retry = state.retry_states.get(connection_id);
        !state.supervision_stopped
            && is_ssh
            && retry.is_some_and(|retry| {
                retry.enabled
                    && self
                        .inner
                        .retry
                        .max_attempts
                        .is_none_or(|max| retry.attempt < max)
            })
            && error.retryable
    }

    /// A running connection failed: its retry is scheduled when supervision
    /// takes it, and its runtime is retired.
    pub fn runtime_failed(&self, connection_id: &str, error: &RuntimeError) {
        self.schedule_retry(connection_id, error);
        let _ = self.manager().retire_failed_runtime(connection_id);
    }

    /// Run every pending SSH retry now and restart its backoff, for when the
    /// network has just changed and a peer that was unreachable may be back.
    pub fn retry_now(&self) {
        let ids: Vec<String> = {
            let state = self.lock();
            if state.supervision_stopped {
                return;
            }
            state.retry_states.keys().cloned().collect()
        };
        for connection_id in ids {
            let token = {
                let mut state = self.lock();
                let Some(retry) = state.retry_states.get_mut(&connection_id) else {
                    continue;
                };
                if !retry.enabled || retry.retry_timer.is_none() {
                    continue;
                }
                if let Some(timer) = retry.retry_timer.take() {
                    timer.cancel();
                }
                retry.attempt = 0;
                retry.token
            };
            self.run_scheduled_retry(&connection_id, token);
        }
    }

    /// Stops all supervision for good (shutdown).
    pub fn stop_supervision(&self) {
        let mut state = self.lock();
        state.supervision_stopped = true;
        for retry in state.retry_states.values_mut() {
            Self::disable(retry);
        }
    }

    /// Starts the default connection and the auto-connect ones, each on its
    /// own: a failure leaves the others alone.
    pub fn start_configured(&self) -> BoxFuture<()> {
        let mut targets = IndexSet::new();
        targets.insert(self.manager().default_id());
        {
            let state = self.lock();
            for entry in state.profiles.values() {
                if entry.profile.auto_connect() {
                    targets.insert(entry.profile.id().to_owned());
                }
            }
        }
        let starts: Vec<_> = targets
            .iter()
            .map(|connection_id| self.start_managed(connection_id, true))
            .collect();
        Box::pin(async move {
            futures_util::future::join_all(starts).await;
        })
    }

    /// Queues `operation` behind the mutations already queued.
    fn mutate<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Self) -> BoxFuture<Result<T, ProfileServiceError>> + Send + 'static,
    ) -> BoxFuture<Result<T, ProfileServiceError>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let this = self.clone();
        let mut queue = self.inner.queue.lock().expect("mutation queue");
        let previous = queue.clone();
        let task = tokio::spawn(async move {
            previous.await;
            let _ = tx.send(operation(this).await);
        });
        *queue = async move {
            let _ = task.await;
        }
        .boxed()
        .shared();
        drop(queue);
        Box::pin(async move {
            rx.await
                .unwrap_or_else(|_| Err("connection profile mutation was dropped".into()))
        })
    }

    /// Adds a profile. The first one persisted retires the synthetic
    /// legacy default, keeping the local server as a writable `local`
    /// profile (`localhost` when the new one is `local`), the new default.
    pub fn create(&self, value: Value) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| Box::pin(async move { this.create_now(value).await }))
    }

    async fn create_now(&self, value: Value) -> Result<Value, ProfileServiceError> {
        self.require_writable_registry_state()?;
        let profile = validate_connection_profile(&value, current_platform())?;
        let id = profile.id().to_owned();
        if self.lock().profiles.contains_key(&id) || self.manager().has(&id) {
            return Err(format!("connection already exists: {id}").into());
        }
        let previous_registry = self.lock().registry.clone();
        let migration = previous_registry.is_none() && !self.inner.explicit_legacy_override;
        let migration_seed = if migration {
            self.local_migration_seed(&id)
        } else {
            None
        };
        let next_registry = match &previous_registry {
            Some(previous) => {
                let mut profiles = previous.profiles.clone();
                profiles.push(profile.clone());
                PersistedConnectionRegistry {
                    version: CONNECTION_PROFILE_FILE_VERSION,
                    default_connection_id: previous.default_connection_id.clone(),
                    profiles,
                }
            }
            None => PersistedConnectionRegistry {
                version: CONNECTION_PROFILE_FILE_VERSION,
                default_connection_id: migration_seed
                    .as_ref()
                    .map_or_else(|| id.clone(), |seed| seed.id().to_owned()),
                profiles: match &migration_seed {
                    Some(seed) => vec![seed.clone(), profile.clone()],
                    None => vec![profile.clone()],
                },
            },
        };
        self.inner.store.save(&next_registry)?;
        let registered = (|| {
            if let Some(seed) = &migration_seed {
                self.register_profile(seed)?;
            }
            self.register_profile(&profile)
        })();
        if let Err(error) = registered {
            let rolled_back = async {
                if let Some(seed) = &migration_seed
                    && self.manager().has(seed.id())
                {
                    self.manager().unregister(seed.id()).await?;
                }
                match &previous_registry {
                    Some(previous) => self.inner.store.save(previous)?,
                    None => self.inner.store.clear()?,
                }
                Ok::<(), RuntimeError>(())
            }
            .await;
            if let Err(rollback_error) = rolled_back {
                self.disable_mutations_after_rollback_failure();
                return Err(ProfileServiceError::aggregate(
                    "connection creation failed and persistence rollback was incomplete",
                    vec![error, rollback_error],
                ));
            }
            return Err(error.into());
        }
        {
            let mut state = self.lock();
            if let Some(seed) = &migration_seed {
                state.profiles.insert(
                    seed.id().to_owned(),
                    ProfileEntry {
                        profile: seed.clone(),
                        read_only: false,
                    },
                );
            }
            state.profiles.insert(
                id.clone(),
                ProfileEntry {
                    profile: profile.clone(),
                    read_only: false,
                },
            );
            state.registry = Some(next_registry.clone());
        }
        if migration {
            self.manager()
                .set_default(&next_registry.default_connection_id)?;
            self.manager()
                .unregister(LEGACY_DEFAULT_CONNECTION_ID)
                .await?;
            self.lock()
                .profiles
                .shift_remove(LEGACY_DEFAULT_CONNECTION_ID);
        }
        if let Some(seed) = &migration_seed {
            let _ = self.start_managed(seed.id(), true).await;
        }
        if profile.auto_connect() || self.manager().default_id() == id {
            let _ = self.start_managed(&id, true).await;
        }
        Ok(self.item(&id)?)
    }

    fn local_migration_seed(&self, new_profile_id: &str) -> Option<ManagedConnectionProfile> {
        let Some(ConnectionProfile::Local(legacy)) = &self.inner.legacy_profile else {
            return None;
        };
        Some(ConnectionProfile::Local(LocalConnectionProfile {
            id: if new_profile_id == "local" {
                "localhost"
            } else {
                "local"
            }
            .into(),
            label: "Local".into(),
            control_socket_path: legacy.control_socket_path.clone(),
            client_socket_path: legacy.client_socket_path.clone(),
            auto_connect: true,
        }))
    }

    /// Replaces a profile (its id stays). A ready connection's replacement
    /// is probed first; a failed replacement puts the old file, factory
    /// and connection back.
    pub fn update(
        &self,
        connection_id: Value,
        value: Value,
    ) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| {
            Box::pin(async move { this.update_now(connection_id, value).await })
        })
    }

    async fn update_now(
        &self,
        connection_id: Value,
        value: Value,
    ) -> Result<Value, ProfileServiceError> {
        self.require_writable_registry_state()?;
        let id = self::connection_id(&connection_id)?;
        let current = self.require_writable_profile(&id)?;
        let replacement = validate_connection_profile(&value, current_platform())?;
        if replacement.id() != id {
            return Err("connection profile id cannot be changed".into());
        }
        let registry = self.require_registry()?;
        let previous_state = self.manager().status(&id)?.state;
        let was_ready = previous_state == ConnectionState::Ready;
        let should_remain_connected = is_active(previous_state) || self.retry_enabled(&id);
        if was_ready {
            self.test(replacement.to_value()).await?;
        }
        let next_registry = PersistedConnectionRegistry {
            version: CONNECTION_PROFILE_FILE_VERSION,
            default_connection_id: registry.default_connection_id.clone(),
            profiles: registry
                .profiles
                .iter()
                .map(|profile| {
                    if profile.id() == id {
                        replacement.clone()
                    } else {
                        profile.clone()
                    }
                })
                .collect(),
        };
        self.inner.store.save(&next_registry)?;
        self.disable_retry(&id);
        let replaced = async {
            self.replace_profile(&replacement).await?;
            {
                let mut state = self.lock();
                state.profiles.insert(
                    id.clone(),
                    ProfileEntry {
                        profile: replacement.clone(),
                        read_only: false,
                    },
                );
                state.registry = Some(next_registry.clone());
            }
            if should_remain_connected
                || replacement.auto_connect()
                || self.manager().default_id() == id
            {
                self.start_managed(&id, true).await?;
            }
            Ok::<(), RuntimeError>(())
        }
        .await;
        let Err(error) = replaced else {
            return Ok(self.item(&id)?);
        };
        self.disable_retry(&id);
        let mut rollback_failures = Vec::new();
        let persistence_rolled_back = match self.inner.store.save(&registry) {
            Ok(()) => true,
            Err(rollback_error) => {
                rollback_failures.push(RuntimeError::new(rollback_error));
                self.disable_mutations_after_rollback_failure();
                false
            }
        };
        if persistence_rolled_back {
            {
                let mut state = self.lock();
                state.profiles.insert(
                    id.clone(),
                    ProfileEntry {
                        profile: current.clone(),
                        read_only: false,
                    },
                );
                state.registry = Some(registry.clone());
            }
            let restored = async {
                self.replace_profile(&current).await?;
                if should_remain_connected {
                    self.start_managed(&id, true).await?;
                }
                Ok::<(), RuntimeError>(())
            }
            .await;
            if let Err(rollback_error) = restored {
                rollback_failures.push(rollback_error);
            }
        } else {
            // The replacement was durably written before runtime replacement
            // began. If writing the old registry back fails, keep memory aligned
            // with that last known durable value and retire all affected routing.
            {
                let mut state = self.lock();
                state.profiles.insert(
                    id.clone(),
                    ProfileEntry {
                        profile: replacement.clone(),
                        read_only: false,
                    },
                );
                state.registry = Some(next_registry.clone());
            }
            if let Err(rollback_error) = self.manager().stop(&id).await {
                rollback_failures.push(rollback_error);
            }
        }
        if !rollback_failures.is_empty() {
            let mut errors = vec![error];
            errors.extend(rollback_failures);
            return Err(ProfileServiceError::aggregate(
                "connection update failed and rollback was incomplete",
                errors,
            ));
        }
        Err(error.into())
    }

    /// Removes a non-default profile. Its routing goes first; when the file
    /// cannot be written then, the old registration comes back.
    pub fn remove(&self, connection_id: Value) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| Box::pin(async move { this.remove_now(connection_id).await }))
    }

    async fn remove_now(&self, connection_id: Value) -> Result<Value, ProfileServiceError> {
        self.require_writable_registry_state()?;
        let id = self::connection_id(&connection_id)?;
        let current = self.require_writable_profile(&id)?;
        if self.manager().default_id() == id {
            return Err("cannot remove the default connection".into());
        }
        let registry = self.require_registry()?;
        let next_profiles: Vec<ConnectionProfile> = registry
            .profiles
            .iter()
            .filter(|profile| profile.id() != id)
            .cloned()
            .collect();
        let next_registry = (!next_profiles.is_empty()).then(|| PersistedConnectionRegistry {
            version: CONNECTION_PROFILE_FILE_VERSION,
            default_connection_id: registry.default_connection_id.clone(),
            profiles: next_profiles,
        });
        if next_registry.is_none() && !self.inner.explicit_legacy_override {
            return Err("cannot remove the last persisted connection".into());
        }
        let previous_state = self.manager().status(&id)?.state;
        let should_recover_connection = is_active(previous_state) || self.retry_enabled(&id);

        // Retire routing first. If persistence then fails, the existing durable
        // registry still describes the old profile and we can safely restore its
        // factory without ever exposing a profile that disk says was removed.
        self.disable_retry(&id);
        self.manager().unregister(&id).await?;
        let persisted = match &next_registry {
            Some(next) => self.inner.store.save(next),
            None => self.inner.store.clear(),
        };
        if let Err(error) = persisted {
            let recovered = async {
                self.register_profile(&current)?;
                if should_recover_connection {
                    self.start_managed(&id, true).await?;
                }
                Ok::<(), RuntimeError>(())
            }
            .await;
            if let Err(recovery_error) = recovered {
                return Err(ProfileServiceError::aggregate(
                    "connection removal failed and runtime recovery was incomplete",
                    vec![RuntimeError::new(error), recovery_error],
                ));
            }
            return Err(error.into());
        }
        let mut state = self.lock();
        state.profiles.shift_remove(&id);
        state.registry = next_registry;
        Ok(json!({ "ok": true }))
    }

    /// Makes a persisted profile the default.
    pub fn set_default(
        &self,
        connection_id: Value,
    ) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| Box::pin(async move { this.set_default_now(connection_id).await }))
    }

    async fn set_default_now(&self, connection_id: Value) -> Result<Value, ProfileServiceError> {
        self.require_writable_registry_state()?;
        let id = self::connection_id(&connection_id)?;
        if self.inner.explicit_legacy_override {
            return Err("explicit CLI/environment connection remains the process default".into());
        }
        self.require_writable_profile(&id)?;
        let registry = self.require_registry()?;
        let next_registry = PersistedConnectionRegistry {
            version: CONNECTION_PROFILE_FILE_VERSION,
            default_connection_id: id.clone(),
            profiles: registry.profiles.clone(),
        };
        self.inner.store.save(&next_registry)?;
        if let Err(error) = self.manager().set_default(&id) {
            if let Err(rollback_error) = self.inner.store.save(&registry) {
                self.disable_mutations_after_rollback_failure();
                return Err(ProfileServiceError::aggregate(
                    "default connection update failed and persistence rollback was incomplete",
                    vec![error, RuntimeError::new(rollback_error)],
                ));
            }
            return Err(error.into());
        }
        self.lock().registry = Some(next_registry);
        Ok(json!({ "ok": true, "default_connection_id": id }))
    }

    /// Starts a connection (with supervision for an SSH one).
    pub fn connect(&self, connection_id: Value) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| {
            Box::pin(async move {
                let id = self::connection_id(&connection_id)?;
                this.require_profile(&id)?;
                this.start_managed(&id, true).await?;
                Ok(this.item(&id)?)
            })
        })
    }

    /// Stops a connection and its supervision.
    pub fn disconnect(
        &self,
        connection_id: Value,
    ) -> BoxFuture<Result<Value, ProfileServiceError>> {
        self.mutate(move |this| {
            Box::pin(async move {
                let id = self::connection_id(&connection_id)?;
                this.require_profile(&id)?;
                this.disable_retry(&id);
                this.manager().stop(&id).await?;
                Ok(this.item(&id)?)
            })
        })
    }

    /// Probes a profile: `{ "id": ... }` alone names a known one, anything
    /// else is validated as a profile.
    pub fn test(&self, value: Value) -> BoxFuture<Result<ProbeResult, ProfileServiceError>> {
        let named = value
            .as_object()
            .filter(|map| map.len() == 1)
            .and_then(|map| map.get("id"))
            .and_then(Value::as_str);
        let profile = match named {
            Some(id) => self.require_profile(id),
            None => validate_connection_profile(&value, current_platform()).map_err(Into::into),
        };
        let test_profile = self.inner.test_profile.clone();
        Box::pin(async move { Ok(test_profile(profile?).await?) })
    }

    fn retry_enabled(&self, connection_id: &str) -> bool {
        self.lock()
            .retry_states
            .get(connection_id)
            .is_some_and(|retry| retry.enabled)
    }

    fn enable_retry(&self, connection_id: &str) {
        let mut state = self.lock();
        let is_ssh = state
            .profiles
            .get(connection_id)
            .is_some_and(|entry| entry.profile.is_ssh());
        if !is_ssh || state.supervision_stopped {
            return;
        }
        let retry = state
            .retry_states
            .entry(connection_id.to_owned())
            .or_default();
        retry.token += 1;
        retry.cancel_timers();
        retry.attempt = 0;
        retry.enabled = true;
    }

    fn disable(retry: &mut RetryState) {
        retry.enabled = false;
        retry.token += 1;
        retry.cancel_timers();
    }

    fn disable_retry(&self, connection_id: &str) {
        if let Some(retry) = self.lock().retry_states.get_mut(connection_id) {
            Self::disable(retry);
        }
    }

    fn current_token(&self, connection_id: &str, token: u64) -> bool {
        self.lock()
            .retry_states
            .get(connection_id)
            .is_some_and(|retry| retry.enabled && retry.token == token)
    }

    fn mark_stable(&self, connection_id: &str) {
        let token = {
            let mut state = self.lock();
            let Some(retry) = state.retry_states.get_mut(connection_id) else {
                return;
            };
            if !retry.enabled || retry.attempt == 0 {
                return;
            }
            if let Some(timer) = retry.stable_timer.take() {
                timer.cancel();
            }
            retry.token
        };
        let weak = Arc::downgrade(&self.inner);
        let id = connection_id.to_owned();
        let callback: RetryCallback = Box::new(move || {
            let Some(this) = Self::upgrade(&weak) else {
                return;
            };
            let mut state = this.lock();
            if let Some(retry) = state.retry_states.get_mut(&id)
                && retry.enabled
                && retry.token == token
            {
                retry.attempt = 0;
                retry.stable_timer = None;
            }
        });
        let timer = (self.inner.retry.schedule)(callback, self.inner.retry.stable_reset_ms);
        self.keep_timer(connection_id, token, timer, true);
    }

    fn upgrade(weak: &Weak<ServiceInner<R>>) -> Option<Self> {
        weak.upgrade().map(|inner| Self { inner })
    }

    /// Keeps a timer just scheduled, or cancels it when its retry state
    /// moved on while it was being scheduled.
    fn keep_timer(&self, connection_id: &str, token: u64, timer: RetryTimer, stable: bool) {
        let mut state = self.lock();
        match state.retry_states.get_mut(connection_id) {
            Some(retry) if retry.enabled && retry.token == token => {
                let slot = if stable {
                    &mut retry.stable_timer
                } else {
                    &mut retry.retry_timer
                };
                if let Some(previous) = slot.replace(timer) {
                    previous.cancel();
                }
            }
            _ => timer.cancel(),
        }
    }

    /// Starts a connection; a failure schedules its retry unless the
    /// transport already reported it (a newer generation, reconnecting).
    fn start_managed(
        &self,
        connection_id: &str,
        reset_retry: bool,
    ) -> BoxFuture<Result<(), RuntimeError>> {
        let is_ssh = match self.require_profile(connection_id) {
            Ok(profile) => profile.is_ssh(),
            Err(error) => return Box::pin(std::future::ready(Err(error))),
        };
        if is_ssh && reset_retry {
            self.enable_retry(connection_id);
        }
        let generation_before_start = match self.manager().status(connection_id) {
            Ok(status) => status.generation,
            Err(error) => return Box::pin(std::future::ready(Err(error.into()))),
        };
        let started = self.manager().start(connection_id);
        let this = self.clone();
        let id = connection_id.to_owned();
        Box::pin(async move {
            match started.await {
                Ok(()) => {
                    if this
                        .manager()
                        .status(&id)
                        .is_ok_and(|status| status.state == ConnectionState::Ready)
                    {
                        this.mark_stable(&id);
                    }
                    Ok(())
                }
                Err(error) => {
                    // A transport can report its own exit while startup is still awaiting a
                    // functional socket probe. That callback advances the generation and
                    // marks reconnecting before it queues a retry. Use that durable manager
                    // state rather than timer timing to avoid consuming a second attempt.
                    let transport_already_reported =
                        this.manager().status(&id).is_ok_and(|status| {
                            status.state == ConnectionState::Reconnecting
                                && status.generation > generation_before_start
                        });
                    if !transport_already_reported {
                        this.schedule_retry(&id, &error);
                    }
                    Err(error)
                }
            }
        })
    }

    fn schedule_retry(&self, connection_id: &str, error: &RuntimeError) -> bool {
        if !self.will_retry(connection_id, error) {
            return false;
        }
        self.lock()
            .retry_states
            .entry(connection_id.to_owned())
            .or_default()
            .cancel_timers();
        if !self
            .manager()
            .mark_reconnecting(connection_id, &error.message)
            .unwrap_or(false)
        {
            return false;
        }
        let (delay_ms, token) = {
            let mut state = self.lock();
            let retry = state
                .retry_states
                .entry(connection_id.to_owned())
                .or_default();
            let settings = &self.inner.retry;
            let window = (settings.max_delay_ms as f64)
                .min(settings.base_delay_ms as f64 * 2f64.powi(retry.attempt.min(30) as i32));
            let random = (settings.random)().clamp(0.0, 1.0);
            let delay_ms = (window / 2.0 + random * (window / 2.0)).floor() as u64;
            retry.attempt += 1;
            (delay_ms, retry.token)
        };
        let weak = Arc::downgrade(&self.inner);
        let id = connection_id.to_owned();
        let callback: RetryCallback = Box::new(move || {
            let Some(this) = Self::upgrade(&weak) else {
                return;
            };
            {
                let mut state = this.lock();
                let Some(retry) = state.retry_states.get_mut(&id) else {
                    return;
                };
                if !retry.enabled || retry.token != token {
                    return;
                }
                retry.retry_timer = None;
            }
            this.run_scheduled_retry(&id, token);
        });
        let timer = (self.inner.retry.schedule)(callback, delay_ms);
        self.keep_timer(connection_id, token, timer, false);
        true
    }

    fn run_scheduled_retry(&self, connection_id: &str, token: u64) {
        // A timer may fire before the failed runtime has finished cleanup. Wait
        // here, then re-check the retry token, instead of queueing an
        // uncancellable manager.start() behind stopTask.
        let retired = self.manager().retire_failed_runtime(connection_id);
        let this = self.clone();
        let id = connection_id.to_owned();
        tokio::spawn(async move {
            let cleaned = match retired {
                Ok(task) => task.await,
                Err(error) => Err(error.into()),
            };
            if let Err(cleanup_error) = cleaned {
                if this.current_token(&id, token) {
                    this.schedule_retry(&id, &cleanup_error);
                }
                return;
            }
            if !this.current_token(&id, token) {
                return;
            }
            // start_managed owns failure classification and generation-based duplicate
            // suppression for both initial and timer-triggered startups.
            let _ = this.start_managed(&id, false).await;
        });
    }

    fn item(&self, connection_id: &str) -> Result<Value, String> {
        let status = self.manager().status(connection_id)?;
        let state = self.lock();
        let entry = state
            .profiles
            .get(connection_id)
            .ok_or_else(|| format!("unknown connection: {connection_id}"))?;
        Ok(list_item(status, entry))
    }

    fn require_profile(
        &self,
        connection_id: &str,
    ) -> Result<ManagedConnectionProfile, RuntimeError> {
        self.lock()
            .profiles
            .get(connection_id)
            .map(|entry| entry.profile.clone())
            .ok_or_else(|| format!("unknown connection: {connection_id}").into())
    }

    fn require_writable_profile(
        &self,
        connection_id: &str,
    ) -> Result<ConnectionProfile, ProfileServiceError> {
        let state = self.lock();
        let entry = state
            .profiles
            .get(connection_id)
            .ok_or_else(|| format!("unknown connection: {connection_id}"))?;
        if entry.read_only {
            return Err("connection profile is read-only".into());
        }
        Ok(entry.profile.clone())
    }

    fn require_registry(&self) -> Result<PersistedConnectionRegistry, ProfileServiceError> {
        self.lock()
            .registry
            .clone()
            .ok_or_else(|| "no persisted connection registry".into())
    }

    fn require_writable_registry_state(&self) -> Result<(), ProfileServiceError> {
        match &self.lock().mutation_disabled_error {
            Some(error) => Err(error.as_str().into()),
            None => Ok(()),
        }
    }

    fn disable_mutations_after_rollback_failure(&self) {
        self.lock().mutation_disabled_error = Some(ROLLBACK_FAILED.into());
    }
}

#[cfg(all(test, unix))]
mod tests;
