//! The host family in the core (contract/wire/core-channel.md, The host
//! family; Rust migration plan, S16): connections.json and the profile
//! service, the connection manager and its generations, every SSH
//! process's slot and master, the Herdr control client with its event and
//! agent status subscriptions, and the network watch, all from
//! roamgate-connections.
//!
//! - Browser calls: `connections.list`, `.create`, `.update`, `.remove`,
//!   `.set_default`, `.connect`, `.disconnect`, `.test`.
//! - The front's own calls: `internal.host.start` (the front stopped its
//!   connections: the core starts its own; nothing runs before it) and
//!   `internal.host.stop` (before the front takes them back, and at its
//!   shutdown), `internal.host.herdr_call` (a runtime's Herdr call),
//!   `internal.host.run`, `internal.host.ssh_hold` and
//!   `internal.host.ssh_release` (the front's SSH commands).
//! - Reverse calls: `host.runtime_start` and `host.runtime_stop` (the part
//!   of each generation the front keeps), `host.events` (what the
//!   subscriptions saw), `host.status` (each status change, with the
//!   list), `host.master_ready`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::FutureExt;
use futures_util::future::BoxFuture as FutureBox;
use roamgate_base::clock::SharedClock;
use roamgate_base::env::{Env, ProcessEnv, roamgate_env};
use roamgate_base::log::{LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_connections::host_ops::{HoldRegistry, HostCommand, HostOps, HostWait};
use roamgate_connections::host_runtime::{
    HostEvent, HostHooks, HostRuntime, HostRuntimeArgs, Probe, RuntimeStart, TransportExit,
};
use roamgate_connections::manager::{
    ConnectionManager, ConnectionStatus, RuntimeContext, RuntimeError, RuntimeFactory,
    sanitize_connection_error,
};
use roamgate_connections::profile_service::{
    ConnectionProfileBootstrap, ConnectionProfileService, ConnectionProfileServiceArgs,
    ConnectionRetryOptions, ManagedConnectionProfile, ProfileRegistration, SshProbeEnvironment,
    connection_identity_for_profile, connection_profile_tester, load_connection_profile_bootstrap,
    synthetic_legacy_profile, test_connection_sockets,
};
use roamgate_connections::profiles::{ConnectionProfile, ConnectionProfileStore};
use roamgate_connections::ssh_guard::{account_home, ssh_refusal};
use roamgate_connections::ssh_profile_runtime::{
    SshRuntimeConfigDeps, create_ssh_profile_runtime_config,
};
use roamgate_exec::lanes::Lane;
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::ssh::master::{SweepOptions, ssh_runtime_directory_root};
use roamgate_exec::ssh::sessions::SshSessions;
use roamgate_exec::ssh::tunnel::{SshTunnelConfig, TunnelDeps};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BoxFuture, IncomingCall};
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub const FAMILY: &str = "host";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(family_with_handle().0)
}

/// The family, and what the standalone core's front family reads of it.
pub fn family_with_handle() -> (Arc<dyn CoreFamily>, HostHandle) {
    let inner = Arc::new(Inner {
        state: Mutex::default(),
        holds: HoldRegistry::default(),
        ops: Mutex::new(None),
        running_now: tokio::sync::watch::channel(false).0,
    });
    (Arc::new(HostFamily(inner.clone())), HostHandle(inner))
}

/// The connections as the standalone core's front family routes browser
/// requests to them.
#[derive(Clone)]
pub struct HostHandle(Arc<Inner>);

impl HostHandle {
    /// The connection manager once the connections run, waiting at most
    /// `wait` for their start.
    pub async fn manager(&self, wait: Duration) -> Option<ConnectionManager<HostRuntime>> {
        if let Some(running) = self.0.running() {
            return Some(running.manager);
        }
        let mut watch = self.0.running_now.subscribe();
        let _ = tokio::time::timeout(wait, watch.wait_for(|running| *running)).await;
        self.0.running().map(|running| running.manager)
    }

    /// `connections.list`'s answer, while the connections run.
    pub fn list(&self) -> Option<Value> {
        self.0.running().map(|running| Inner::list(&running))
    }
}

/// The legacy connection as the front was started with it.
#[derive(Debug, Clone, Default)]
struct Legacy {
    socket_path: String,
    client_socket_path: String,
    ssh_host: Option<String>,
    session: Option<String>,
    has_explicit_socket_path: bool,
    has_explicit_client_socket_path: bool,
}

impl Legacy {
    fn from_params(params: &Value) -> Result<Self, RpcError> {
        let legacy = params
            .get("legacy")
            .ok_or_else(|| RpcError::new("internal.host.start needs the legacy connection"))?;
        let text = |key: &str| legacy.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| legacy.get(key).and_then(Value::as_bool).unwrap_or(false);
        Ok(Self {
            socket_path: text("socket_path")
                .ok_or_else(|| RpcError::new("the legacy connection needs its socket_path"))?,
            client_socket_path: text("client_socket_path").ok_or_else(|| {
                RpcError::new("the legacy connection needs its client_socket_path")
            })?,
            ssh_host: text("ssh_host"),
            session: text("session"),
            has_explicit_socket_path: flag("has_explicit_socket_path"),
            has_explicit_client_socket_path: flag("has_explicit_client_socket_path"),
        })
    }

    fn config(&self) -> SshTunnelConfig {
        SshTunnelConfig {
            socket_path: self.socket_path.clone(),
            client_socket_path: self.client_socket_path.clone(),
            ssh_host: self.ssh_host.clone(),
            session: self.session.clone(),
            has_explicit_socket_path: self.has_explicit_socket_path,
            has_explicit_client_socket_path: self.has_explicit_client_socket_path,
            ..SshTunnelConfig::default()
        }
    }
}

/// The connections while the core serves them.
#[derive(Clone)]
struct Running {
    manager: ConnectionManager<HostRuntime>,
    service: ConnectionProfileService<HostRuntime>,
    network: Arc<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct State {
    owned: bool,
    running: Option<Running>,
    /// The start in progress, which a stop waits for.
    starting: bool,
}

struct Inner {
    state: Mutex<State>,
    holds: HoldRegistry,
    /// The SSH slots and the runner: one set per process.
    ops: Mutex<Option<HostOps>>,
    /// Whether the connections run (a browser call waits for the start).
    running_now: tokio::sync::watch::Sender<bool>,
}

/// How long a browser call waits for the front's `internal.host.start`.
const START_WAIT: Duration = Duration::from_secs(30);

struct HostFamily(Arc<Inner>);

fn logger(cx: &FamilyContext, scope: &str) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = cx.clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some(scope.into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

/// What the runtimes ask of the front, through reverse calls.
struct ReverseHooks {
    cx: FamilyContext,
}

impl HostHooks for ReverseHooks {
    fn runtime_start(&self, start: RuntimeStart) -> FutureBox<'static, Result<(), RuntimeError>> {
        let cx = self.cx.clone();
        async move {
            cx.reverse("host.runtime_start", start.to_value())
                .await
                .map(|_| ())
                .map_err(|error| RuntimeError::new(error.message))
        }
        .boxed()
    }

    fn runtime_stop(&self, connection_id: &str, generation: u64) -> FutureBox<'static, ()> {
        let cx = self.cx.clone();
        let args = json!({"connection_id": connection_id, "generation": generation});
        async move {
            let _ = cx.reverse("host.runtime_stop", args).await;
        }
        .boxed()
    }

    fn events(
        &self,
        connection_id: &str,
        generation: u64,
        events: Vec<HostEvent>,
    ) -> FutureBox<'static, ()> {
        let cx = self.cx.clone();
        let args = json!({
            "connection_id": connection_id,
            "generation": generation,
            "events": events.iter().map(HostEvent::to_value).collect::<Vec<_>>(),
        });
        async move {
            let _ = cx.reverse("host.events", args).await;
        }
        .boxed()
    }

    fn master_ready(&self, connection_id: &str, generation: u64, host: &str, control_path: &str) {
        let cx = self.cx.clone();
        let args = json!({
            "connection_id": connection_id,
            "generation": generation,
            "host": host,
            "control_path": control_path,
        });
        tokio::spawn(async move {
            let _ = cx.reverse("host.master_ready", args).await;
        });
    }
}

fn rpc_error(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(sanitize_connection_error(&error.to_string()))
}

fn param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

/// A request's profile: `params.profile`, else the params themselves.
fn profile_value(params: &Value) -> Value {
    params
        .get("profile")
        .filter(|profile| !profile.is_null())
        .cloned()
        .unwrap_or_else(|| params.clone())
}

fn host_command(params: &Value) -> Result<(HostCommand, HostWait), RpcError> {
    let destination = param(params, "destination")
        .ok_or_else(|| RpcError::new("needs a destination"))?
        .to_owned();
    let command = param(params, "command")
        .ok_or_else(|| RpcError::new("needs a command"))?
        .to_owned();
    let trusted = params
        .get("trusted_args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let lane = match param(params, "lane") {
        Some("background") => Lane::Background,
        _ => Lane::Interactive,
    };
    Ok((
        HostCommand {
            destination,
            command,
            trusted,
            tag: param(params, "tag").map(str::to_owned),
            read_only: params
                .get("read_only")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            connection: param(params, "connection_id").map(str::to_owned),
        },
        HostWait {
            timeout_ms: params.get("timeout_ms").and_then(Value::as_u64),
            lane,
        },
    ))
}

impl Inner {
    fn ops(&self) -> HostOps {
        self.ops
            .lock()
            .unwrap()
            .get_or_insert_with(|| {
                // The real clock: these are I/O (process deadlines, session
                // waits); the front's test clock drives the supervision.
                let clock: SharedClock = Arc::new(roamgate_base::clock::SystemClock);
                HostOps::new(SshSessions::new(clock.clone()), ProcessRunner::new(clock))
            })
            .clone()
    }

    fn running(&self) -> Option<Running> {
        self.state.lock().unwrap().running.clone()
    }

    /// The running connections; while the core owns the family but the
    /// front has not handed them over yet, waits for that.
    async fn running_or_wait(&self) -> Result<Running, RpcError> {
        let not_ours = || RpcError::with_code("the connections are not the core's", "not_owner");
        if let Some(running) = self.running() {
            return Ok(running);
        }
        if !self.state.lock().unwrap().owned {
            return Err(not_ours());
        }
        let mut watch = self.running_now.subscribe();
        let _ = tokio::time::timeout(START_WAIT, watch.wait_for(|running| *running)).await;
        self.running().ok_or_else(not_ours)
    }

    /// The list as `connections.list` answers it.
    fn list(running: &Running) -> Value {
        json!({
            "default_connection_id": running.manager.default_id(),
            "connections": running.service.list().unwrap_or_default(),
        })
    }

    /// Starts the core's connections from connections.json and the
    /// front's legacy connection.
    async fn start(
        self: &Arc<Self>,
        cx: &FamilyContext,
        params: &Value,
    ) -> Result<Value, RpcError> {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(running) = &state.running {
                return Ok(Self::list(running));
            }
            if !state.owned {
                return Err(RpcError::with_code(
                    "the core does not own the host family",
                    "not_owner",
                ));
            }
            state.starting = true;
        }
        let started = self.build(cx, params).await;
        let installed = {
            let mut state = self.state.lock().unwrap();
            state.starting = false;
            match started {
                Err(error) => Err(error),
                Ok(running) if state.owned => {
                    state.running = Some(running.clone());
                    Ok(running)
                }
                Ok(running) => {
                    // Given back meanwhile: what just started stops.
                    tokio::spawn(async move { Self::shutdown(running).await });
                    Err(RpcError::with_code(
                        "the core no longer owns the host family",
                        "not_owner",
                    ))
                }
            }
        };
        let running = installed?;
        self.running_now.send_replace(true);
        let before = running.service.list().unwrap_or_default();
        let starting = running.clone();
        tokio::spawn(async move {
            starting.service.start_configured().await;
        });
        // Answered once the local connections are up (or failed), as the
        // front's own start would have them by its first browser call.
        local_starts_settled(&running, &before).await;
        Ok(Self::list(&running))
    }

    async fn build(
        self: &Arc<Self>,
        cx: &FamilyContext,
        params: &Value,
    ) -> Result<Running, RpcError> {
        let legacy = Legacy::from_params(params)?;
        let explicit_legacy_override = params
            .get("explicit_legacy_override")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let ops = self.ops();
        let env: Arc<dyn Env> = Arc::new(ProcessEnv);
        // Masters of a server or core that died with them still up.
        let root = ssh_runtime_directory_root(env.as_ref());
        #[cfg(unix)]
        {
            let swept = roamgate_exec::ssh::master::sweep_orphaned_ssh_masters(
                &SweepOptions::real(root, ops.runner.clone()),
            )
            .await;
            if swept > 0 {
                tracing::info!(scope = "bridge.ssh", swept, "ended orphaned SSH masters");
            }
        }
        #[cfg(not(unix))]
        let _ = (root, SweepOptions::real);

        let store = Arc::new(ConnectionProfileStore::for_server(env.as_ref()).map_err(rpc_error)?);
        let legacy_profile =
            synthetic_legacy_profile(&legacy.socket_path, &legacy.client_socket_path);
        let connections_logger = logger(cx, "bridge.connections");
        let bootstrap = match load_connection_profile_bootstrap(
            &store,
            &legacy_profile,
            explicit_legacy_override,
        ) {
            Ok(bootstrap) => bootstrap,
            Err(error) => {
                let registry_load_error = sanitize_connection_error(&error);
                let mut fields = roamgate_base::log::LogFields::new();
                fields.insert("error".into(), json!(registry_load_error));
                fields.insert("profile_mutations".into(), json!("disabled"));
                connections_logger.error("invalid connection registry preserved", Some(&fields));
                ConnectionProfileBootstrap {
                    default_connection_id:
                        roamgate_connections::manager::LEGACY_DEFAULT_CONNECTION_ID.into(),
                    explicit_legacy_override,
                    persisted_registry: None,
                    registry_load_error: Some(registry_load_error),
                    registrations: vec![ProfileRegistration {
                        profile: legacy_profile.clone(),
                        read_only: true,
                    }],
                }
            }
        };

        // Status changes reach the front in order, with the list as it is
        // when each goes.
        let (observer_statuses, mut queue) = mpsc::unbounded_channel::<Option<ConnectionStatus>>();
        let manager = ConnectionManager::<HostRuntime>::new(
            &bootstrap.default_connection_id,
            Some(Arc::new(move |status: ConnectionStatus| {
                let _ = observer_statuses.send(Some(status));
            })),
            Some(connections_logger.clone()),
        );

        let service_slot: Arc<std::sync::OnceLock<ConnectionProfileService<HostRuntime>>> =
            Arc::default();
        let hooks: Arc<dyn HostHooks> = Arc::new(ReverseHooks { cx: cx.clone() });
        let probe: Probe = Arc::new(|control, client| {
            async move {
                test_connection_sockets(&control, &client)
                    .await
                    .map(|result| serde_json::to_value(result).unwrap_or(Value::Null))
            }
            .boxed()
        });
        let runtime_logger = logger(cx, "bridge.connection");
        let factory_cx = cx.clone();
        let factory_ops = ops.clone();
        let factory_env = env.clone();
        let factory_slot = service_slot.clone();
        let factory_legacy = legacy.clone();
        let create_runtime = Arc::new(move |profile: &ManagedConnectionProfile| {
            let profile = profile.clone();
            let identity = connection_identity_for_profile(&profile);
            let cx = factory_cx.clone();
            let ops = factory_ops.clone();
            let env = factory_env.clone();
            let slot = factory_slot.clone();
            let legacy = factory_legacy.clone();
            let hooks = hooks.clone();
            let probe = probe.clone();
            let logger = runtime_logger.clone();
            Arc::new(move |context: RuntimeContext| {
                let config = runtime_config(&profile, &legacy, env.clone())?;
                // A test server (a HOME of its own) stays off the real hosts.
                if config.ssh_host.is_some()
                    && let Some(refusal) = ssh_refusal(env.as_ref(), &account_home())
                {
                    remove_owned_directory(&config);
                    return Err(RuntimeError::permanent(refusal));
                }
                let exit_context = context.clone();
                let exit_slot = slot.clone();
                let profile_id = profile.id().to_owned();
                let on_transport_exit: Option<TransportExit> = config.ssh_host.as_ref().map(|_| {
                    Arc::new(move |error: RuntimeError| {
                        if !exit_context.is_current() {
                            return;
                        }
                        let Some(service) = exit_slot.get() else {
                            return;
                        };
                        let reconnecting = service.will_retry(&profile_id, &error);
                        exit_context.report_error(&error.message, reconnecting);
                        service.runtime_failed(&profile_id, &error);
                    }) as TransportExit
                });
                let made = HostRuntime::new(HostRuntimeArgs {
                    identity: identity.clone(),
                    context,
                    config: config.clone(),
                    sessions: ops.sessions.clone(),
                    run_process: ops.tunnel_run_process(),
                    tunnel_deps: TunnelDeps::real(ops.runner.clone()),
                    clock: cx.clock.clone(),
                    logger: logger.clone(),
                    hooks: hooks.clone(),
                    probe: probe.clone(),
                    on_transport_exit,
                    skip_front: false,
                });
                if made.is_err() {
                    remove_owned_directory(&config);
                }
                made
            }) as RuntimeFactory<HostRuntime>
        });

        let probe_environment = SshProbeEnvironment {
            sessions: ops.sessions.clone(),
            run_process: ops.tunnel_run_process(),
            tunnel_deps: TunnelDeps::real(ops.runner.clone()),
            runtime_config: Arc::new(SshRuntimeConfigDeps::real(env.clone())),
        };
        let service = ConnectionProfileService::new(ConnectionProfileServiceArgs {
            manager: manager.clone(),
            store,
            bootstrap,
            create_runtime,
            test_profile: connection_profile_tester(probe_environment),
            retry: ConnectionRetryOptions {
                clock: Some(cx.clock.clone()),
                ..ConnectionRetryOptions::default()
            },
        })
        .map_err(rpc_error)?;
        let _ = service_slot.set(service.clone());
        // The front's generations so far: the next ones follow them.
        if let Some(generations) = params.get("generations").and_then(Value::as_object) {
            for (id, generation) in generations {
                if let Some(generation) = generation.as_u64() {
                    manager.raise_generation(id, generation);
                }
            }
        }

        // The status forwarder.
        let push_cx = cx.clone();
        let push_manager = manager.clone();
        let push_service = service.clone();
        tokio::spawn(async move {
            while let Some(status) = queue.recv().await {
                let mut args = json!({
                    "default_connection_id": push_manager.default_id(),
                    "connections": push_service.list().unwrap_or_default(),
                });
                if let Some(status) = status {
                    args["status"] = serde_json::to_value(status).unwrap_or(Value::Null);
                }
                let _ = push_cx.reverse("host.status", args).await;
            }
        });

        // A pending SSH retry may wait up to its capped backoff. When the
        // network changes, a peer that was unreachable may be back.
        let watch_service = service.clone();
        let watch_logger = connections_logger;
        let network = roamgate_connections::network_watch::watch_network_changes(
            cx.clock.clone(),
            Arc::new(move || {
                watch_logger.debug("network changed; retrying waiting connections", None);
                watch_service.retry_now();
            }),
            Duration::from_millis(5000),
            Arc::new(roamgate_connections::network_watch::system_interfaces),
        );
        Ok(Running {
            manager,
            service,
            network: Arc::new(network),
        })
    }

    /// Stops what runs: supervision, every runtime (the front's parts with
    /// them), the network watch.
    async fn shutdown(running: Running) {
        running.service.stop_supervision();
        running.network.abort();
        let _ = running.manager.stop_all().await;
    }

    async fn stop(&self) -> Value {
        // A start in progress finishes first: it then sees the family gone.
        for _ in 0..600 {
            if !self.state.lock().unwrap().starting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let running = self.state.lock().unwrap().running.take();
        self.running_now.send_replace(false);
        if let Some(running) = running {
            Self::shutdown(running).await;
        }
        self.holds.release_all();
        json!({"ok": true})
    }
}

/// Waits (at most 30 s of real time) until each local connection the
/// start began (the default and the auto-connect ones) is past connecting:
/// what the front's own start reaches before its first browser call. An
/// SSH connection's tunnel may wait on the test clock, so it is not waited
/// for, as the front's own start does not hold browsers for it either.
async fn local_starts_settled(running: &Running, before: &[Value]) {
    let targets: Vec<(String, u64)> = before
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("local")
                && (item.get("is_default").and_then(Value::as_bool) == Some(true)
                    || item.get("auto_connect").and_then(Value::as_bool) == Some(true))
        })
        .filter_map(|item| {
            Some((
                item.get("id")?.as_str()?.to_owned(),
                item.get("generation")?.as_u64()?,
            ))
        })
        .collect();
    let settled = || {
        targets.iter().all(|(id, generation)| {
            running.manager.status(id).is_ok_and(|status| {
                status.generation > *generation
                    && !matches!(
                        status.state,
                        roamgate_connections::manager::ConnectionState::Connecting
                            | roamgate_connections::manager::ConnectionState::Stopping
                    )
            })
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !settled() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A profile's tunnel configuration (index.ts runtimeFactoryForProfile).
fn runtime_config(
    profile: &ManagedConnectionProfile,
    legacy: &Legacy,
    env: Arc<dyn Env>,
) -> Result<SshTunnelConfig, RuntimeError> {
    if profile.id() == roamgate_connections::manager::LEGACY_DEFAULT_CONNECTION_ID {
        return Ok(legacy.config());
    }
    match profile {
        ConnectionProfile::Ssh(ssh) => {
            create_ssh_profile_runtime_config(ssh, &SshRuntimeConfigDeps::real(env))
                .map_err(RuntimeError::new)
        }
        ConnectionProfile::Local(local) => Ok(SshTunnelConfig {
            socket_path: local.control_socket_path.clone(),
            client_socket_path: local.client_socket_path.clone(),
            has_explicit_socket_path: true,
            has_explicit_client_socket_path: true,
            ..SshTunnelConfig::default()
        }),
    }
}

fn remove_owned_directory(config: &SshTunnelConfig) {
    if let Some(directory) = &config.owned_runtime_directory {
        let _ = std::fs::remove_dir_all(directory);
    }
}

impl CoreFamily for HostFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let inner = self.0.clone();
        let cx = cx.clone();
        Box::pin(async move {
            let params = call.params;
            match call.method.as_str() {
                "internal.host.start" => {
                    // The parity suite's proof that the core took the connections.
                    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "internal.host.start");
                    inner.start(&cx, &params).await
                }
                "internal.host.stop" => Ok(inner.stop().await),
                "internal.host.herdr_call" => {
                    let running = inner.running_or_wait().await?;
                    let id = param(&params, "connection_id")
                        .ok_or_else(|| RpcError::new("herdr_call needs a connection_id"))?;
                    let method = param(&params, "method")
                        .ok_or_else(|| RpcError::new("herdr_call needs a method"))?;
                    let runtime = running
                        .manager
                        .current_runtime(id)
                        .map_err(RpcError::new)?
                        .filter(|runtime| {
                            params
                                .get("generation")
                                .and_then(Value::as_u64)
                                .is_none_or(|generation| generation == runtime.generation())
                        })
                        .ok_or_else(|| RpcError::new("connection runtime is disposed"))?;
                    runtime
                        .herdr()
                        .call(
                            method,
                            params.get("params").cloned().unwrap_or(Value::Null),
                            params
                                .get("timeout_ms")
                                .and_then(Value::as_u64)
                                .unwrap_or(roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS),
                            None,
                            params
                                .get("fresh")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        )
                        .await
                        .map_err(RpcError::new)
                }
                "internal.host.run" => {
                    let (command, wait) = host_command(&params)?;
                    let stdin = match param(&params, "stdin_b64") {
                        Some(text) => Some(
                            base64::engine::general_purpose::STANDARD
                                .decode(text)
                                .map_err(|_| RpcError::new("stdin_b64 is not base64"))?,
                        ),
                        None => None,
                    };
                    let output = inner.ops().run(&command, stdin, &wait).await.map_err(
                        |error| match error.code {
                            Some(code) => RpcError::with_code(error.message, code),
                            None => RpcError::new(error.message),
                        },
                    )?;
                    Ok(json!({
                        "code": output.code,
                        "stdout_b64": base64::engine::general_purpose::STANDARD.encode(&output.stdout),
                        "stderr": output.stderr,
                    }))
                }
                "internal.host.ssh_hold" => {
                    let (command, wait) = host_command(&params)?;
                    let long_lived = params
                        .get("long_lived")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let ops = inner.ops();
                    let held = inner
                        .holds
                        .hold(&ops, &command, &wait, long_lived)
                        .await
                        .map_err(|error| match error.code {
                            Some(code) => RpcError::with_code(error.message, code),
                            None => RpcError::new(error.message),
                        })?;
                    Ok(json!({
                        "lease": held.lease,
                        "argv": ops.spawn_argv(&held),
                        "remaining_ms": held.remaining_ms,
                    }))
                }
                "internal.host.ssh_release" => {
                    let lease = params.get("lease").and_then(Value::as_u64).unwrap_or(0);
                    Ok(json!({"released": inner.holds.release(lease)}))
                }
                method => {
                    let running = inner.running_or_wait().await?;
                    let service = &running.service;
                    let result = match method {
                        "connections.list" => Ok(Inner::list(&running)),
                        "connections.create" => service.create(profile_value(&params)).await,
                        "connections.update" => {
                            service
                                .update(
                                    params.get("id").cloned().unwrap_or(Value::Null),
                                    profile_value(&params),
                                )
                                .await
                        }
                        "connections.remove" => {
                            service
                                .remove(params.get("id").cloned().unwrap_or(Value::Null))
                                .await
                        }
                        "connections.set_default" => {
                            service
                                .set_default(params.get("id").cloned().unwrap_or(Value::Null))
                                .await
                        }
                        "connections.connect" => {
                            service
                                .connect(params.get("id").cloned().unwrap_or(Value::Null))
                                .await
                        }
                        "connections.disconnect" => {
                            service
                                .disconnect(params.get("id").cloned().unwrap_or(Value::Null))
                                .await
                        }
                        "connections.test" => service
                            .test(profile_value(&params))
                            .await
                            .map(|result| serde_json::to_value(result).unwrap_or(Value::Null)),
                        _ => {
                            return Err(RpcError::with_code(
                                format!("unknown method {method}"),
                                "unknown_method",
                            ));
                        }
                    };
                    if method != "connections.list" {
                        // Labels, the default and the profiles may have
                        // changed: the front's copy follows before the
                        // browser hears the answer.
                        let _ = cx.reverse("host.status", Inner::list(&running)).await;
                    }
                    result.map_err(|error| rpc_error(error.message))
                }
            }
        })
    }

    fn owned(&self, _cx: &FamilyContext, owned: bool) {
        let inner = self.0.clone();
        let stop = {
            let mut state = inner.state.lock().unwrap();
            state.owned = owned;
            !owned
        };
        if stop {
            tokio::spawn(async move {
                inner.stop().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_names_its_profile_or_is_one() {
        assert_eq!(
            profile_value(&json!({"profile": {"id": "a"}})),
            json!({"id": "a"})
        );
        assert_eq!(profile_value(&json!({"id": "a"})), json!({"id": "a"}));
    }

    #[test]
    fn a_host_command_takes_the_front_s_arguments() {
        let (command, wait) = host_command(&json!({
            "destination": "devbox",
            "command": "git status",
            "trusted_args": ["-p", "22"],
            "tag": "git.status",
            "read_only": true,
            "connection_id": "work",
            "timeout_ms": 5000,
            "lane": "background",
        }))
        .unwrap();
        assert_eq!(command.destination, "devbox");
        assert_eq!(command.trusted, vec!["-p", "22"]);
        assert!(command.read_only);
        assert_eq!(command.connection.as_deref(), Some("work"));
        assert_eq!(wait.timeout_ms, Some(5000));
        assert_eq!(wait.lane, Lane::Background);
        assert!(host_command(&json!({"command": "x"})).is_err());
    }

    #[test]
    fn the_legacy_connection_keeps_the_front_s_flags() {
        let legacy = Legacy::from_params(&json!({"legacy": {
            "socket_path": "/run/h.sock",
            "client_socket_path": "/run/c.sock",
            "ssh_host": "devbox",
            "session": "main",
            "has_explicit_socket_path": true,
        }}))
        .unwrap();
        let config = legacy.config();
        assert_eq!(config.socket_path, "/run/h.sock");
        assert_eq!(config.ssh_host.as_deref(), Some("devbox"));
        assert_eq!(config.session.as_deref(), Some("main"));
        assert!(config.has_explicit_socket_path);
        assert!(!config.has_explicit_client_socket_path);
        assert!(config.master_control_path.is_none());
        assert!(Legacy::from_params(&json!({})).is_err());
    }
}
