//! The reverse targets the core's families call, answered in the process
//! (contract/wire/core-channel.md, The core): each works on the core's own
//! families (their `internal.<family>.<op>` calls, or their shared state).
//!
//! - [`runtime`]: each connection generation's layer
//!   (`host.runtime_start`, `.runtime_stop`, `.events`, `.status`,
//!   `.master_ready`): what its events and status changes fed the other
//!   families; [`composition`]: its terminal bridge, task events and tab
//!   renamer.
//! - [`connections`]: `connections.*`, `herdr.*`, `host.run`,
//!   `workspace.ssh_run`, `activity.hostScript`, `agent_sessions.*`,
//!   `agent.transcript_tail`, `agents.addresses`.
//! - [`conversation`]: `conversation.*` and `claude_mod.*`.
//! - [`profiles`]: the `profiles.*` targets.
//! - [`assistant`]: the `assistant.*` targets.
//! - [`others`]: `settings.changed`, `settings.limit_resume.get`,
//!   `history.*`, `workspace.kept_steps`,
//!   `mr_cache.load`, `server.scheduleExit`.
//! - [`reviews`]: `review.*` (the agent socket's host, the review
//!   service's git reads and agents, the forge, a browser connection's
//!   reads); [`rendered`]: the rendered pages, served under `/rendered/`.
//! - [`mr_reviews`]: `mr_reviews.*` but the agent's turns, which are
//!   [`reviews_agent`]'s; [`forge`]: the forge CLIs and one gate.
//! - [`work`]: `work.*`, `voice.errand_*`, `voice.work_*`,
//!   `voice.session_cookie`, `notifications.*`.
//! - [`feed`]: the notification feed's sockets (`/api/notifications/ws`),
//!   with `notifications.feed` and `.clients`.
//! - [`forwards`]: the port forwards' registry and `forward.*`.
//! - [`uploads`]: a connection's uploads and their sweeper.
//! - [`browser`]: the browser RPCs of no family
//!   (`agent.list`, `workspace.*`, Herdr's pass-through with its overlays,
//!   `connections.agent_sessions`, `.agent_tasks`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture as SharedFuture, Shared};
use roamgate_base::clock::SharedClock;
use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_base::log::{LogFields, LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_channel::family::FamilyContext;
use roamgate_channel::peer::BoxFuture;
use roamgate_channel::protocol::{Ctx, RpcError};
use roamgate_channel::standalone::Standalone;
use roamgate_connections::agent_profiles::store::LaunchRegistry;
use roamgate_connections::host_runtime::HostRuntime;
use roamgate_connections::manager::ReadyRuntimeLease;
use roamgate_http::browser_rpc::BrowserClients;
use serde_json::{Value, json};

use super::host::HostHandle;

mod assistant;
pub(crate) mod browser;
pub(crate) mod composition;
mod connections;
mod conversation;
pub(crate) mod feed;
mod forge;
pub(crate) mod forwards;
mod mr_reviews;
mod others;
mod profiles;
mod rendered;
mod reviews;
mod reviews_agent;
pub(crate) mod runtime;
pub(crate) mod uploads;
mod work;

pub(crate) use forge::shared_gate as forge_gate;
pub(crate) use others::prime_settings;
pub(crate) use rendered::{http as rendered_http, stray as rendered_stray};

/// The server's configuration, as the front gives it (`internal.front.start`).
#[derive(Debug, Clone, Default)]
pub(crate) struct FrontConfig {
    pub socket_path: String,
    pub client_socket_path: String,
    pub ssh_host: Option<String>,
    pub session: Option<String>,
    pub has_explicit_socket_path: bool,
    pub has_explicit_client_socket_path: bool,
    pub task_notification_source: String,
    pub auth_required: bool,
    /// The front serves HTTPS: the scheme of the URLs it was reached on.
    pub tls: bool,
    /// The port the front listens on (never exposed by a remote forward).
    pub port: u16,
}

/// A ready runtime, leased for one request (Bun's `readyRuntimeLease`).
pub(crate) type Lease = ReadyRuntimeLease<HostRuntime>;

/// A Herdr boot id being read, or read (`createHerdrBootCache`).
type Boot = Shared<SharedFuture<'static, Option<String>>>;

/// How long a connection's boot id is trusted (agent-seen.ts BOOT_TTL_MS).
const BOOT_TTL_MS: i64 = 60_000;

/// What the standalone core keeps of what Bun kept for these targets.
pub(crate) struct Layer {
    pub host: HostHandle,
    pub clients: Arc<BrowserClients>,
    pub config: Mutex<FrontConfig>,
    clock: SharedClock,
    /// What the core's conversation mode shows each connection's front
    /// (`conversation.host` op `mirror`).
    mirrors: Mutex<HashMap<String, Value>>,
    /// Each connection's Herdr boot id, read at most once a minute.
    boots: Mutex<HashMap<String, (i64, Boot)>>,
    /// The remote history watch helpers the core's watchers asked for.
    watches: Mutex<HashMap<String, (u64, tokio::task::JoinHandle<()>)>>,
    /// The gates of the core's Ranger in flight here, with the refusal
    /// of those it said no longer hold.
    revoked: Mutex<HashMap<u64, Option<RpcError>>>,
    /// Hosts whose Claude settings were given the claude start hook.
    hooked: Mutex<HashSet<String>>,
    /// The settings the last `settings.changed` gave, with its revision.
    settings: Mutex<(Option<u64>, Option<Value>)>,
    /// The review agents' state the review family was told last.
    review_agents: Mutex<String>,
    /// The connections whose agent socket the review family listens on
    /// (an SSH host's, forwarded over its master).
    review_agent_sockets: Mutex<std::collections::BTreeSet<String>>,
    /// The SSH connections whose host has the review client set up.
    review_agent_hosts: Mutex<HashSet<String>>,
    pub(crate) runtimes: runtime::Runtimes,
    /// The `connections.agent_sessions` answers each socket holds.
    pub(crate) session_versions: browser::SessionVersions,
    /// Each connection's summary, shared by every browser.
    pub(crate) session_snapshots: Arc<browser::SessionSnapshots>,
}

/// Agent starts typed into a pane, one use each (Bun's `launchRegistry()`):
/// conversation mode's and the profiles', taken by `roamgate-hold`.
pub(crate) fn launch_registry() -> &'static LaunchRegistry {
    static REGISTRY: LazyLock<LaunchRegistry> = LazyLock::new(|| LaunchRegistry::new(None, None));
    &REGISTRY
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// The `bridge` logger (or one of its children), on the families' clock.
pub(crate) fn logger(clock: &SharedClock, scope: &str) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some(scope.into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

fn fields(value: Value) -> LogFields {
    value.as_object().cloned().unwrap_or_default()
}

/// A call to another family of the core (`internal.<family>.<op>`), its
/// answer awaited.
pub(crate) async fn call(
    cx: &FamilyContext,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    cx.standalone.call(method, params, Ctx::default()).await
}

/// [`call`], its answer not awaited (Bun's `void core.call(...)`).
pub(crate) fn tell(cx: &FamilyContext, method: &str, params: Value) {
    let call = cx.standalone.call(method, params, Ctx::default());
    tokio::spawn(async move {
        let _ = call.await;
    });
}

impl Layer {
    pub(crate) fn new(host: HostHandle, clients: Arc<BrowserClients>, clock: SharedClock) -> Self {
        Self {
            host,
            clients,
            config: Mutex::default(),
            clock,
            mirrors: Mutex::default(),
            boots: Mutex::default(),
            watches: Mutex::default(),
            revoked: Mutex::default(),
            hooked: Mutex::default(),
            settings: Mutex::default(),
            review_agents: Mutex::default(),
            review_agent_sockets: Mutex::default(),
            review_agent_hosts: Mutex::default(),
            runtimes: runtime::Runtimes::default(),
            session_versions: browser::SessionVersions::default(),
            session_snapshots: Arc::default(),
        }
    }

    fn default_id(&self) -> String {
        self.host
            .manager_now()
            .map(|manager| manager.default_id())
            .unwrap_or_else(|| {
                roamgate_connections::manager::LEGACY_DEFAULT_CONNECTION_ID.to_owned()
            })
    }

    /// The ready runtime of `id` (Bun's `readyRuntimeLease`): None while
    /// it is not ready; an unknown connection is an error.
    pub(crate) fn ready(&self, id: &str) -> Result<Option<Lease>, RpcError> {
        let Some(manager) = self.host.manager_now() else {
            return Ok(None);
        };
        manager.ready_runtime_lease(id).map_err(RpcError::new)
    }

    /// The connection a reverse call names, or the default one, ready
    /// (index.ts `coreRuntime`).
    fn lease(&self, args: &Value) -> Result<Lease, RpcError> {
        let id = text(args, "connection_id")
            .map(str::to_owned)
            .unwrap_or_else(|| self.default_id());
        self.ready(&id)?
            .ok_or_else(|| RpcError::new(format!("connection not ready: {id}")))
    }

    /// The core's conversation mode as `id`'s front sees it.
    fn mirror(&self, id: &str) -> Value {
        self.mirrors
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "leases": {},
                    "owned_panes": [],
                    "suspended": [],
                    "status": {},
                    "models": {},
                    "refusals": {},
                    "handing_over": false,
                })
            })
    }

    fn owned_panes(&self, id: &str) -> Vec<Value> {
        self.mirror(id)["owned_panes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    /// `conversation.ownedSession(paneId)`: `{session_id, cwd}` while
    /// conversation mode owns the pane's session.
    fn owned_session(&self, id: &str, pane_id: &str) -> Option<Value> {
        let mirror = self.mirror(id);
        let lease = mirror["leases"].get(pane_id)?;
        (lease["owner"] == "conversation")
            .then(|| json!({"session_id": lease["session_id"], "cwd": lease["cwd"]}))
    }

    /// The panes of `id` whose Claude runs a live Claude mod.
    fn mod_panes(&self, id: &str) -> Vec<Value> {
        super::claude_mod::current()
            .map(|hub| hub.panes(id))
            .unwrap_or_default()
    }

    /// Herdr as the agent session readers see it (runtime.ts
    /// `agentHerdrCall`, `withOwnedSessions`): conversation mode's and the
    /// Claude mods' panes over Herdr's own answers.
    async fn agent_herdr_call(
        &self,
        lease: &Lease,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
        before_send: Option<roamgate_herdr::control::BeforeSend>,
    ) -> Result<Value, String> {
        let id = &lease.connection_id;
        let answer = lease
            .runtime
            .herdr()
            .call(
                method,
                params.clone(),
                timeout_ms.unwrap_or(roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS),
                before_send,
                false,
            )
            .await;
        let held = self.owned_panes(id);
        let result = match answer {
            Ok(result) => result,
            Err(error) => {
                let pane = text(&params, "target").unwrap_or("");
                let lower = error.to_lowercase();
                if method != "agent.get"
                    || !held.iter().any(|each| text(each, "pane_id") == Some(pane))
                    || !(lower.contains("not_found") || lower.contains("not found"))
                {
                    return Err(error);
                }
                json!({})
            }
        };
        let overlaid =
            roamgate_agents::owned_panes::overlay_owned_panes(method, Some(&params), result, &held);
        // Conversation mode's panes are its own (the mod is idle there).
        let live: Vec<Value> = self
            .mod_panes(id)
            .into_iter()
            .filter(|each| {
                !held
                    .iter()
                    .any(|owned| owned.get("pane_id") == each.get("pane_id"))
            })
            .collect();
        Ok(roamgate_claude::mod_hub::overlay_mod_panes(
            method,
            Some(&params),
            overlaid,
            &live,
        ))
    }

    /// The Herdr boot id of `lease`'s connection (`herdrBoots.get` over
    /// the runtime's `recoveryIdentity`, 3 s at most); `fresh` reads it
    /// again.
    async fn herdr_boot(&self, lease: &Lease, fresh: bool) -> Option<String> {
        let id = lease.connection_id.clone();
        let now = self.clock.now();
        let boot = {
            let mut boots = self.boots.lock().unwrap();
            if fresh {
                boots.remove(&id);
            }
            match boots.get(&id) {
                Some((at, boot)) if now - at < BOOT_TTL_MS => boot.clone(),
                _ => {
                    let lease = lease.clone();
                    let read: SharedFuture<'static, Option<String>> = Box::pin(async move {
                        tokio::time::timeout(Duration::from_secs(3), recovery_identity(&lease))
                            .await
                            .ok()
                            .and_then(Result::ok)
                            .flatten()
                            .filter(|boot| !boot.is_empty())
                    });
                    let boot = futures_util::FutureExt::shared(read);
                    boots.insert(id, (now, boot.clone()));
                    boot
                }
            }
        };
        boot.await
    }
}

/// runtime.ts `recoveryIdentity`: Herdr's boot id through a passive
/// endpoint handshake; None when the endpoint is off or Herdr's protocol
/// has none.
pub(crate) async fn recovery_identity(lease: &Lease) -> Result<Option<String>, String> {
    if roamgate_env(&ProcessEnv, "DISABLE_ENDPOINT").as_deref() == Some("1") {
        return Ok(None);
    }
    if !lease.is_current() {
        return Err("connection runtime is disposed".into());
    }
    let ping = lease
        .runtime
        .herdr()
        .call("ping", json!({}), 5_000, None, false)
        .await?;
    if !ping
        .get("protocol")
        .and_then(Value::as_i64)
        .is_some_and(roamgate_herdr::thin::is_terminal_hello_protocol)
    {
        return Ok(None);
    }
    let path = lease.runtime.config().client_socket_path.clone();
    let boot = roamgate_herdr::endpoint::read_boot_id(&path).await?;
    if !lease.is_current() {
        return Err("connection runtime is disposed".into());
    }
    Ok(boot)
}

/// A reverse target's answer.
type Target = fn(Arc<Layer>, FamilyContext, Value) -> BoxFuture<Result<Value, RpcError>>;

fn add(standalone: &Standalone, layer: &Arc<Layer>, target: &str, run: Target) {
    let layer = layer.clone();
    standalone.register(
        target,
        Arc::new(move |cx, args, _ctx| run(layer.clone(), cx.clone(), args)),
    );
}

/// Registers every target of this module.
pub(crate) fn register(standalone: &Standalone, layer: &Arc<Layer>) {
    for (target, run) in runtime::TARGETS
        .iter()
        .chain(connections::TARGETS)
        .chain(conversation::TARGETS)
        .chain(profiles::TARGETS)
        .chain(assistant::TARGETS)
        .chain(others::TARGETS)
        .chain(mr_reviews::TARGETS)
        .chain(work::TARGETS)
        .chain(reviews::TARGETS)
        .chain(reviews_agent::TARGETS)
    {
        add(standalone, layer, target, *run);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_target_is_named_once() {
        let mut seen = HashSet::new();
        for (target, _) in runtime::TARGETS
            .iter()
            .chain(connections::TARGETS)
            .chain(conversation::TARGETS)
            .chain(profiles::TARGETS)
            .chain(assistant::TARGETS)
            .chain(others::TARGETS)
            .chain(mr_reviews::TARGETS)
            .chain(work::TARGETS)
            .chain(reviews::TARGETS)
            .chain(reviews_agent::TARGETS)
        {
            assert!(seen.insert(*target), "{target} twice");
        }
    }
}
