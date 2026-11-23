//! The connection runtime of the `host` family (Rust migration plan,
//! section 8.2, S16): what server/src/connections/runtime.ts does for a
//! generation that Rust owns once `host` flips, the rest staying with the
//! front.
//!
//! A runtime here owns its transport (the SSH tunnel and its command
//! master, through roamgate-exec), the probe that the Herdr sockets answer,
//! the Herdr control client with the event subscription loop and the agent
//! status subscription. The front keeps each generation's composition root
//! (conversation mode, the workspace, the terminal bridge, history watch,
//! tab titles): [`HostHooks::runtime_start`] asks it to build one once the
//! transport is up, before the subscriptions start, so a connection is
//! ready only once the front's part is, as before; [`HostHooks::runtime_stop`]
//! disposes it. What the subscriptions see reaches the front in order,
//! batched, through [`HostHooks::events`], with the generation it belongs
//! to.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger, RecoveryReporter};
use roamgate_exec::ssh::sessions::SshSessions;
use roamgate_exec::ssh::tunnel::{
    RemotePlatform, RunProcess, SshTunnelArgs, SshTunnelConfig, SshTunnelManager, TunnelDeps,
    TunnelError,
};
use roamgate_herdr::control::{ClientEvent, HerdrClient, HerdrClientOptions, Subscription};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::agent_status::{AgentStatusArgs, AgentStatusSubscriptionLoop, StatusHerdr};
use crate::manager::{
    ConnectionIdentity, ConnectionRuntime, RuntimeContext, RuntimeError, sanitize_connection_error,
};
use crate::subscription_loop::{EventSubscriptionLoop, LoopSubscription, SubscriptionLoopArgs};

/// The Herdr events a runtime subscribes to (runtime.ts `DEFAULT_EVENTS`).
pub const DEFAULT_EVENTS: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.renamed",
    "workspace.closed",
    "workspace.focused",
    "workspace.moved",
    "workspace.reordered",
    "tab.created",
    "tab.closed",
    "tab.renamed",
    "tab.focused",
    "pane.created",
    "pane.closed",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
];

/// What the front is told a runtime's subscriptions saw, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum HostEvent {
    /// A Herdr event line.
    Herdr(Value),
    /// The event subscription was acknowledged (again): browsers reconcile.
    Ready,
    /// A `pane.list` of the agent status subscription started (`list`
    /// numbers it), at `started_at` (epoch ms).
    PaneListStart { list: i64, started_at: i64 },
    /// Its result.
    PaneList { list: i64, result: Value },
}

impl HostEvent {
    pub fn to_value(&self) -> Value {
        match self {
            Self::Herdr(event) => json!({"kind": "herdr", "event": event}),
            Self::Ready => json!({"kind": "ready"}),
            Self::PaneListStart { list, started_at } => {
                json!({"kind": "pane_list_start", "list": list, "started_at": started_at})
            }
            Self::PaneList { list, result } => {
                json!({"kind": "pane_list", "list": list, "result": result})
            }
        }
    }
}

/// What the front builds a generation's composition from.
#[derive(Debug, Clone)]
pub struct RuntimeStart {
    pub identity: ConnectionIdentity,
    pub generation: u64,
    pub config: SshTunnelConfig,
}

/// A runtime's tunnel configuration as the front's runtime takes it
/// (runtime.ts `SshTunnelConfig`, camelCase).
pub fn config_value(config: &SshTunnelConfig) -> Value {
    json!({
        "socketPath": config.socket_path,
        "clientSocketPath": config.client_socket_path,
        "sshHost": config.ssh_host,
        "session": config.session,
        "hasExplicitSocketPath": config.has_explicit_socket_path,
        "hasExplicitClientSocketPath": config.has_explicit_client_socket_path,
        "remoteSocketPath": config.remote_socket_path,
        "remoteClientSocketPath": config.remote_client_socket_path,
        "ownedRuntimeDirectory": config.owned_runtime_directory,
        "remotePlatform": config.remote_platform.map(|_| "windows"),
        "remoteHerdrPath": config.remote_herdr_path,
        "masterControlPath": config.master_control_path,
    })
}

impl RuntimeStart {
    pub fn to_value(&self) -> Value {
        json!({
            "connection_id": self.identity.id,
            "identity": self.identity,
            "generation": self.generation,
            "config": config_value(&self.config),
        })
    }
}

/// What the runtime asks of the front.
pub trait HostHooks: Send + Sync + 'static {
    /// Builds and starts the generation's composition; the runtime is
    /// ready only once this resolved.
    fn runtime_start(&self, start: RuntimeStart) -> BoxFuture<'static, Result<(), RuntimeError>>;
    /// Disposes it (a generation it never built is ignored).
    fn runtime_stop(&self, connection_id: &str, generation: u64) -> BoxFuture<'static, ()>;
    /// What the subscriptions saw, in order; the next batch waits for it.
    fn events(
        &self,
        connection_id: &str,
        generation: u64,
        events: Vec<HostEvent>,
    ) -> BoxFuture<'static, ()>;
    /// The SSH command master of the connection became ready (again).
    fn master_ready(&self, connection_id: &str, generation: u64, host: &str, control_path: &str);
}

/// The probe that a connection's sockets answer (profile_service's
/// `test_connection_sockets`): its control socket, then its client socket.
pub type Probe =
    Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<Value, RuntimeError>> + Send + Sync>;

/// Reports an SSH tunnel's unexpected exit: the family decides whether the
/// connection reconnects (runtime.ts `onTransportExit` in index.ts).
pub type TransportExit = Arc<dyn Fn(RuntimeError) + Send + Sync>;

/// A tunnel failure as the manager and supervision see it.
pub fn tunnel_error(error: TunnelError) -> RuntimeError {
    match error {
        TunnelError::Failure(failure) => RuntimeError {
            message: failure.message,
            retryable: failure.retryable,
        },
        TunnelError::Message(message) => RuntimeError::new(message),
    }
}

/// Everything a runtime is made from.
pub struct HostRuntimeArgs {
    pub identity: ConnectionIdentity,
    pub context: RuntimeContext,
    pub config: SshTunnelConfig,
    pub sessions: SshSessions,
    /// The HOME probe and other tunnel commands (through `sessions`).
    pub run_process: RunProcess,
    pub tunnel_deps: TunnelDeps,
    pub clock: SharedClock,
    pub logger: Logger,
    pub hooks: Arc<dyn HostHooks>,
    pub probe: Probe,
    pub on_transport_exit: Option<TransportExit>,
    /// The front's composition is not built (tests of the transport alone).
    pub skip_front: bool,
}

#[derive(Default)]
struct State {
    transport_started: bool,
    background_started: bool,
    front_started: bool,
    disposed: bool,
    stop_task: Option<futures_util::future::Shared<BoxFuture<'static, Result<(), RuntimeError>>>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

struct Inner {
    identity: ConnectionIdentity,
    generation: u64,
    config: SshTunnelConfig,
    herdr: HerdrClient,
    tunnel: Option<SshTunnelManager>,
    logger: Logger,
    hooks: Arc<dyn HostHooks>,
    probe: Probe,
    skip_front: bool,
    events: mpsc::UnboundedSender<HostEvent>,
    event_queue: Mutex<Option<mpsc::UnboundedReceiver<HostEvent>>>,
    subscriptions: EventSubscriptionLoop,
    agent_status: AgentStatusSubscriptionLoop,
    /// Shared with the master-ready hook.
    disposed: Arc<AtomicBool>,
    state: Mutex<State>,
}

/// A connection's runtime while Rust owns the `host` family.
pub struct HostRuntime {
    inner: Arc<Inner>,
}

fn connection_fields(id: &str) -> LogFields {
    let mut fields = LogFields::new();
    fields.insert("connection".into(), json!(id));
    fields
}

impl HostRuntime {
    pub fn new(args: HostRuntimeArgs) -> Result<Arc<Self>, RuntimeError> {
        let identity = args.identity.clone();
        let id = identity.id.clone();
        let herdr = HerdrClient::new(
            args.config.socket_path.clone(),
            HerdrClientOptions {
                logger: Some(args.logger.child("herdr")),
                connection_id: Some(id.clone()),
                clock: Some(args.clock.clone()),
                read_reuse_ms: None,
            },
        );
        let (events, event_queue) = mpsc::unbounded_channel();
        let disposed = Arc::new(AtomicBool::new(false));

        // The tunnel (an SSH host's), with its command master.
        let tunnel = match &args.config.ssh_host {
            Some(host) => {
                let hooks = args.hooks.clone();
                let generation = args.context.generation;
                let control_path = args.config.master_control_path.clone();
                let host = host.clone();
                let master_id = id.clone();
                let ready_disposed = disposed.clone();
                let on_master_ready: Option<Arc<dyn Fn() + Send + Sync>> =
                    control_path.map(|control_path| {
                        Arc::new(move || {
                            if !ready_disposed.load(Ordering::SeqCst) {
                                hooks.master_ready(&master_id, generation, &host, &control_path);
                            }
                        }) as Arc<dyn Fn() + Send + Sync>
                    });
                let on_exit = args.on_transport_exit.clone();
                let on_unexpected_exit: Option<Arc<dyn Fn(TunnelError) + Send + Sync>> = on_exit
                    .map(|report| {
                        Arc::new(move |error: TunnelError| report(tunnel_error(error)))
                            as Arc<dyn Fn(TunnelError) + Send + Sync>
                    });
                Some(
                    SshTunnelManager::new(SshTunnelArgs {
                        sessions: args.sessions.clone(),
                        connection_id: Some(id.clone()),
                        config: args.config.clone(),
                        run_process: args.run_process.clone(),
                        on_unexpected_exit,
                        on_master_ready,
                        deps: args.tunnel_deps,
                    })
                    .map_err(|error| RuntimeError {
                        message: error.message,
                        retryable: error.retryable,
                    })?,
                )
            }
            None => None,
        };

        // The event subscription loop: Herdr's events, acknowledged once
        // per subscription; each acknowledgement makes browsers reconcile.
        let events_logger = args.logger.child("events");
        let now_clock = args.clock.clone();
        let event_recovery = Arc::new(RecoveryReporter::new(
            events_logger.clone(),
            "event subscription failed",
            "event subscription recovered",
            Arc::new(move || now_clock.now()),
        ));
        let subscribe_herdr = herdr.clone();
        let types: Vec<Subscription> = DEFAULT_EVENTS.iter().map(|name| (*name).into()).collect();
        let ready_events = events.clone();
        let ready_recovery = event_recovery.clone();
        let ready_logger = events_logger.clone();
        let ready_id = id.clone();
        let error_recovery = event_recovery.clone();
        let error_id = id.clone();
        let closed_recovery = event_recovery.clone();
        let closed_id = id.clone();
        let subscriptions = EventSubscriptionLoop::new(SubscriptionLoopArgs {
            subscribe: Arc::new(move || {
                Ok(LoopSubscription::from_herdr(subscribe_herdr.subscribe(
                    &types,
                    roamgate_herdr::control::SUBSCRIPTION_ACK_TIMEOUT_MS,
                )))
            }),
            retry_delay: std::time::Duration::from_millis(2000),
            on_ready: Some(Arc::new(move || {
                let _ = ready_events.send(HostEvent::Ready);
                let fields = connection_fields(&ready_id);
                if !ready_recovery.recovered(Some(&fields)) {
                    ready_logger.info("subscribed to Herdr events", Some(&fields));
                }
            })),
            on_subscribe_error: Some(Arc::new(move |error: String| {
                let mut fields = connection_fields(&error_id);
                fields.insert("retry_ms".into(), json!(2000));
                error_recovery.failure(&sanitize_connection_error(&error), Some(&fields));
            })),
            on_subscription_closed: Some(Arc::new(move || {
                let mut fields = connection_fields(&closed_id);
                fields.insert("retry_ms".into(), json!(2000));
                closed_recovery.failure("subscription closed", Some(&fields));
            })),
            clock: args.clock.clone(),
        });

        // The agent status subscription, its listings told to the front.
        let status_logger = args.logger.child("agent-status");
        let now_clock = args.clock.clone();
        let status_recovery = Arc::new(RecoveryReporter::new(
            status_logger.clone(),
            "agent status subscription failed",
            "agent status subscription recovered",
            Arc::new(move || now_clock.now()),
        ));
        let mut status_args = AgentStatusArgs::new(
            Arc::new(herdr.clone()) as Arc<dyn StatusHerdr>,
            &id,
            args.clock.clone(),
        );
        let recovery = status_recovery.clone();
        let error_id = id.clone();
        status_args.on_subscribe_error = Some(Arc::new(move |error: String| {
            recovery.failure(
                &sanitize_connection_error(&error),
                Some(&connection_fields(&error_id)),
            );
        }));
        let recovery = status_recovery.clone();
        let error_id = id.clone();
        status_args.on_list_error = Some(Arc::new(move |error: String| {
            let mut fields = connection_fields(&error_id);
            fields.insert("operation".into(), json!("pane list"));
            recovery.failure(&sanitize_connection_error(&error), Some(&fields));
        }));
        let lists = Arc::new(AtomicI64::new(0));
        let start_events = events.clone();
        let start_clock = args.clock.clone();
        let start_lists = lists.clone();
        status_args.on_pane_list_start = Some(Arc::new(move || {
            let list = start_lists.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = start_events.send(HostEvent::PaneListStart {
                list,
                started_at: start_clock.now(),
            });
            list
        }));
        let list_events = events.clone();
        status_args.on_pane_list = Some(Arc::new(move |result: &Value, list: Option<i64>| {
            let _ = list_events.send(HostEvent::PaneList {
                list: list.unwrap_or(0),
                result: result.clone(),
            });
        }));
        let recovery = status_recovery;
        let log_id = id.clone();
        let log_logger = status_logger;
        status_args.log = Some(Arc::new(move |message: &str| {
            let fields = connection_fields(&log_id);
            recovery.recovered(Some(&fields));
            log_logger.debug(message, Some(&fields));
        }));
        let agent_status = AgentStatusSubscriptionLoop::new(status_args);

        let inner = Arc::new(Inner {
            identity,
            generation: args.context.generation,
            config: args.config,
            herdr,
            tunnel,
            logger: args.logger,
            hooks: args.hooks,
            probe: args.probe,
            skip_front: args.skip_front,
            events,
            event_queue: Mutex::new(Some(event_queue)),
            subscriptions,
            agent_status,
            disposed,
            state: Mutex::default(),
        });
        Ok(Arc::new(Self { inner }))
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation
    }

    /// The runtime's Herdr control client (the front's `herdr.call`s).
    pub fn herdr(&self) -> &HerdrClient {
        &self.inner.herdr
    }

    pub fn config(&self) -> &SshTunnelConfig {
        &self.inner.config
    }

    pub fn ssh_host(&self) -> Option<&str> {
        self.inner.config.ssh_host.as_deref()
    }

    pub fn remote_platform(&self) -> Option<RemotePlatform> {
        self.inner.config.remote_platform
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().expect("host runtime")
    }

    /// Feeds Herdr's events to the agent status loop and the queue, and the
    /// queue to the front, one batch at a time.
    fn start_pumps(&self) -> Vec<tokio::task::JoinHandle<()>> {
        let mut tasks = Vec::new();
        let mut client_events = self.inner.herdr.events();
        let inner = self.inner.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                match client_events.recv().await {
                    Ok(ClientEvent::Event(event)) => {
                        if inner.disposed.load(Ordering::SeqCst) {
                            break;
                        }
                        inner.agent_status.handle_herdr_event(&event);
                        let _ = inner.events.send(HostEvent::Herdr(event));
                    }
                    Ok(ClientEvent::Error(error)) => {
                        inner.logger.debug(
                            "Herdr subscription error",
                            Some(&{
                                let mut fields = connection_fields(&inner.identity.id);
                                fields.insert(
                                    "error".into(),
                                    json!(sanitize_connection_error(&error)),
                                );
                                fields
                            }),
                        );
                    }
                    Ok(ClientEvent::SubscriptionClosed) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        inner.logger.warn(
                            "dropped Herdr events",
                            Some(&{
                                let mut fields = connection_fields(&inner.identity.id);
                                fields.insert("missed".into(), json!(missed));
                                fields
                            }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let queue = self.inner.event_queue.lock().unwrap().take();
        if let Some(mut queue) = queue {
            let inner = self.inner.clone();
            tasks.push(tokio::spawn(async move {
                while let Some(first) = queue.recv().await {
                    let mut batch = vec![first];
                    while let Ok(next) = queue.try_recv() {
                        batch.push(next);
                    }
                    if inner.disposed.load(Ordering::SeqCst) {
                        break;
                    }
                    inner
                        .hooks
                        .events(&inner.identity.id, inner.generation, batch)
                        .await;
                }
            }));
        }
        tasks
    }
}

impl ConnectionRuntime for HostRuntime {
    fn identity(&self) -> ConnectionIdentity {
        self.inner.identity.clone()
    }

    /// The tunnel (an SSH host's), then the probe of both Herdr sockets.
    fn start_transport(&self) -> BoxFuture<'static, Result<(), RuntimeError>> {
        let inner = self.inner.clone();
        async move {
            if inner.disposed.load(Ordering::SeqCst) {
                return Err("connection runtime is disposed".into());
            }
            if let Some(tunnel) = &inner.tunnel {
                tunnel.start().await.map_err(tunnel_error)?;
            }
            (inner.probe)(
                inner.config.socket_path.clone(),
                inner.config.client_socket_path.clone(),
            )
            .await?;
            if !inner.disposed.load(Ordering::SeqCst) {
                inner.state.lock().unwrap().transport_started = true;
            }
            Ok(())
        }
        .boxed()
    }

    /// The front's composition, then the subscriptions.
    fn start_background(&self) -> BoxFuture<'static, Result<(), RuntimeError>> {
        let this = Self {
            inner: self.inner.clone(),
        };
        async move {
            if this.inner.disposed.load(Ordering::SeqCst) {
                return Err("connection runtime is disposed".into());
            }
            {
                let mut state = this.lock();
                if state.background_started {
                    return Ok(());
                }
                state.background_started = true;
            }
            if !this.inner.skip_front {
                this.inner
                    .hooks
                    .runtime_start(RuntimeStart {
                        identity: this.inner.identity.clone(),
                        generation: this.inner.generation,
                        config: this.inner.config.clone(),
                    })
                    .await?;
                this.lock().front_started = true;
            }
            if this.inner.disposed.load(Ordering::SeqCst) {
                return Err("connection runtime is disposed".into());
            }
            let tasks = this.start_pumps();
            this.lock().tasks.extend(tasks);
            this.inner.subscriptions.start();
            this.inner.agent_status.start();
            Ok(())
        }
        .boxed()
    }

    fn stop(&self) -> BoxFuture<'static, Result<(), RuntimeError>> {
        let mut state = self.lock();
        if let Some(task) = &state.stop_task {
            return task.clone().boxed();
        }
        if state.disposed {
            return futures_util::future::ready(Ok(())).boxed();
        }
        state.disposed = true;
        self.inner.disposed.store(true, Ordering::SeqCst);
        state.background_started = false;
        let tasks = std::mem::take(&mut state.tasks);
        let front_started = std::mem::take(&mut state.front_started);
        let inner = self.inner.clone();
        let task = async move {
            for task in tasks {
                task.abort();
            }
            let front = async {
                if front_started {
                    inner
                        .hooks
                        .runtime_stop(&inner.identity.id, inner.generation)
                        .await;
                }
            };
            let subscriptions = inner.subscriptions.stop();
            let agent_status = inner.agent_status.stop();
            let tunnel = async {
                match &inner.tunnel {
                    Some(tunnel) => tunnel.cleanup().await.map_err(tunnel_error),
                    None => Ok(()),
                }
            };
            let ((), (), (), cleaned) = tokio::join!(front, subscriptions, agent_status, tunnel);
            cleaned
        }
        .boxed()
        .shared();
        state.stop_task = Some(task.clone());
        task.boxed()
    }
}

#[cfg(test)]
mod tests;
