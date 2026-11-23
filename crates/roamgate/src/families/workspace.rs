//! The workspace family in the core (contract/wire/core-channel.md, The
//! workspace family; Rust migration plan, S17): the explorer, Changes and
//! its history, worktrees and their hooks, the Workspaces arrangement and
//! the settings that need git or worktree hooks, from roamgate-workspace,
//! roamgate-git and roamgate-forge.
//!
//! - Browser calls: `file.*`, `git.*`, `worktree.*`,
//!   `bridge.workspace_tree.*`, `settings.workspace_auto_sync.*`,
//!   `settings.worktree_directory.get`, `settings.worktree_hooks.get`,
//!   `settings.worktree_command.update`, `settings.update_repo`; HTTP
//!   `/api/file/upload`, `/api/file/download`, `/api/file/delete`.
//! - The front's own calls: `internal.workspace.runtime_start` and
//!   `.runtime_stop` (its runtimes), `.events` (what their subscriptions
//!   saw), `.enrich`, `.last_step`, `.invalidate`, `.tree`.
//! - Reverse calls: `herdr.call` (a connection's Herdr),
//!   `workspace.ssh_run` (its SSH host), `workspace.kept_steps` (the review
//!   service's steps with threads), `connections.ready` (a shadow read's
//!   connection), `settings.changed` (through the settings family).
//!
//! Per connection generation it keeps the git status badges, auto-sync,
//! the Last step store and its turns, and the worktree removals; once per
//! process, while owned, the arrangement store with its pruner and the
//! pull request reads with their forge gate.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use futures_util::FutureExt as _;
use futures_util::future::BoxFuture as FutureBox;
use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_base::log::{LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_base::settings::Settings;
use roamgate_forge::gate::ForgeGate;
use roamgate_forge::mr_cache::MrCache;
use roamgate_forge::pull_request::{CardCache, PullRequests};
use roamgate_git::exec::{LocalRunner, RunFuture};
use roamgate_git::steps::LastStepStore;
use roamgate_git::{GitContext, Invocation, Ran, Request, RunError, Runner};
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_sidecar::protocol::{Push, RpcError};
use roamgate_workspace::auto_sync::{
    AutoSync, AutoSyncArgs, GitRootResolver, Invalidate, ResolvedRoot,
};
use roamgate_workspace::auto_sync_settings::{self, SettingsRpc};
use roamgate_workspace::connection::{
    BoxFuture as WsFuture, ConnectionEvents, Herdr, HerdrCallOptions, SettingsAccess,
    SettingsChange, WorkspaceConnection, WorkspaceError,
};
use roamgate_workspace::file_types::FileBody;
use roamgate_workspace::files::{self, FileHttpResponse, Files, PullRequestTarget};
use roamgate_workspace::last_step_turns::{
    ConnectionTurnHooks, LAST_STEP_TRANSITION_DEBOUNCE, LastStepTurns,
};
use roamgate_workspace::process::LocalStreams;
use roamgate_workspace::pull_request::read_workspace_pull_request;
use roamgate_workspace::status::{GIT_STATUS_COLD_BUDGET, GitStatus};
use roamgate_workspace::tree::store::{
    self as tree_store, EnrichList, ListLive, PrunerOptions, WorkspaceTreePruner,
    WorkspaceTreeStore, list_workspace_identities, place_created_workspace_under,
};
use roamgate_workspace::worktree::{
    Guard, PlaceCreated, ResolveGitRoot, WORKTREE_METHODS, WorktreeCallbacks, Worktrees,
};
use serde_json::{Value, json};

pub const FAMILY: &str = "workspace";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(WorkspaceFamily(Arc::new(Inner::default()))))
}

/// What a browser hears when git.pull_request fails (index.ts: a root's
/// errors may hold remote URLs or CLI diagnostics).
const PULL_REQUEST_FAILED: &str = "Cannot resolve this workspace's Git checkout.";

/// The worktree settings methods ([`Worktrees::rpc`] answers them too).
const WORKTREE_SETTINGS: [&str; 4] = [
    "settings.worktree_directory.get",
    "settings.worktree_hooks.get",
    "settings.worktree_command.update",
    "settings.update_repo",
];

/// How long the pruner waits after a connection is ready, then between its
/// two reads (config/workspace-tree.ts).
const PRUNE_SETTLE: Duration = Duration::from_secs(3);
const PRUNE_CONFIRM: Duration = Duration::from_secs(5);

/// How long `runtime_stop` waits for a generation's work to drain.
const STOP_WAIT: Duration = Duration::from_secs(10);

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

fn param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn rpc_error(error: WorkspaceError) -> RpcError {
    match error.code {
        Some(code) => RpcError::with_code(error.message, &code),
        None => RpcError::new(error.message),
    }
}

/// A connection's Herdr, through the front (`herdr.call`).
struct ChannelHerdr {
    cx: FamilyContext,
    connection_id: String,
}

impl Herdr for ChannelHerdr {
    fn call(
        &self,
        method: &str,
        params: Value,
        options: HerdrCallOptions,
    ) -> WsFuture<'_, Result<Value, String>> {
        let mut args = json!({
            "connection_id": self.connection_id,
            "method": method,
            "params": params,
        });
        if let Some(timeout) = options.timeout {
            args["timeout_ms"] = json!(timeout.as_millis() as u64);
        }
        if options.fresh {
            args["fresh"] = Value::Bool(true);
        }
        let cx = self.cx.clone();
        async move {
            cx.reverse("herdr.call", args)
                .await
                .map_err(|error| error.message)
        }
        .boxed()
    }
}

/// Where a connection's commands run: this machine, or its SSH host
/// through the front's (or the host family's) session slots.
struct ChannelRunner {
    cx: FamilyContext,
    connection_id: String,
    local: LocalRunner,
}

impl Runner for ChannelRunner {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            match &request.invocation {
                Invocation::Local(argv) => {
                    self.local
                        .run_local(argv, request.input.as_deref(), request.timeout)
                        .await
                }
                Invocation::Ssh {
                    command, read, tag, ..
                } => {
                    let mut args = json!({
                        "connection_id": self.connection_id,
                        "command": command,
                        "read": read,
                        "tag": tag,
                        "timeout_ms": request.timeout.as_millis() as u64,
                    });
                    if let Some(input) = &request.input {
                        args["stdin_b64"] = base64::engine::general_purpose::STANDARD
                            .encode(input)
                            .into();
                    }
                    let answer = self
                        .cx
                        .reverse("workspace.ssh_run", args)
                        .await
                        .map_err(|error| RunError(error.message))?;
                    let stdout = answer
                        .get("stdout_b64")
                        .and_then(Value::as_str)
                        .map(|text| base64::engine::general_purpose::STANDARD.decode(text))
                        .transpose()
                        .map_err(|error| RunError(error.to_string()))?
                        .unwrap_or_default();
                    Ok(Ran {
                        code: answer.get("code").and_then(Value::as_i64).unwrap_or(1) as i32,
                        stdout: String::from_utf8_lossy(&stdout).into_owned(),
                        stderr: param(&answer, "stderr").unwrap_or_default().to_owned(),
                    })
                }
            }
        })
    }
}

/// A generation's events to its browsers (runtime.ts `args.onEvent`).
struct PushEvents {
    cx: FamilyContext,
    connection_id: String,
    generation: u64,
}

impl ConnectionEvents for PushEvents {
    fn emit(&self, event: &str, data: Value) {
        self.cx.push(Push {
            message: json!({ "event": event, "data": data }),
            key: None,
            connection_id: Some(self.connection_id.clone()),
            connection_generation: Some(self.generation),
            socket_id: None,
            session_id: None,
        });
    }
}

/// settings.json through the settings family's writer.
struct CoreSettings {
    cx: FamilyContext,
    connection_id: String,
}

impl SettingsAccess for CoreSettings {
    fn read(&self) -> WsFuture<'_, Arc<Settings>> {
        super::settings::read_shared(&self.cx).boxed()
    }

    fn update(&self, change: SettingsChange) -> WsFuture<'_, Result<Arc<Settings>, String>> {
        let cause = json!({ "method": "workspace", "connection_id": self.connection_id });
        async move {
            super::settings::update_shared(&self.cx, cause, change)
                .await
                .map_err(|error| error.message)
        }
        .boxed()
    }
}

/// What the front says of a runtime.
#[derive(Debug, Clone)]
struct RuntimeInfo {
    connection_id: String,
    generation: u64,
    ssh_host: Option<String>,
    remote_platform: Option<String>,
}

impl RuntimeInfo {
    fn from_params(params: &Value) -> Result<Self, RpcError> {
        Ok(Self {
            connection_id: param(params, "connection_id")
                .ok_or_else(|| RpcError::new("needs a connection_id"))?
                .to_owned(),
            generation: params
                .get("generation")
                .and_then(Value::as_u64)
                .ok_or_else(|| RpcError::new("needs a generation"))?,
            ssh_host: param(params, "ssh_host")
                .filter(|host| !host.is_empty())
                .map(str::to_owned),
            remote_platform: param(params, "remote_platform").map(str::to_owned),
        })
    }
}

fn connection(cx: &FamilyContext, info: &RuntimeInfo) -> WorkspaceConnection {
    let runner = Arc::new(ChannelRunner {
        cx: cx.clone(),
        connection_id: info.connection_id.clone(),
        local: LocalRunner::system(),
    });
    WorkspaceConnection {
        id: info.connection_id.clone(),
        generation: info.generation,
        remote_platform: info.remote_platform.clone(),
        git: GitContext::new(info.ssh_host.clone(), runner),
        herdr: Arc::new(ChannelHerdr {
            cx: cx.clone(),
            connection_id: info.connection_id.clone(),
        }),
        events: Arc::new(PushEvents {
            cx: cx.clone(),
            connection_id: info.connection_id.clone(),
            generation: info.generation,
        }),
        settings: Arc::new(CoreSettings {
            cx: cx.clone(),
            connection_id: info.connection_id.clone(),
        }),
    }
}

/// The review service's steps with threads in a checkout (index.ts
/// `keepLastSteps`), asked of the front; none when it cannot say.
fn keeper(cx: &FamilyContext) -> roamgate_git::steps::Keeper {
    let cx = cx.clone();
    Arc::new(move |root: &str| {
        let cx = cx.clone();
        let args = json!({ "root": root });
        async move {
            let answer = tokio::time::timeout(
                Duration::from_secs(5),
                cx.reverse("workspace.kept_steps", args),
            )
            .await;
            match answer {
                Ok(Ok(Value::Array(steps))) => steps
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => Vec::new(),
            }
        }
        .boxed()
    })
}

/// One connection generation's workspace part.
struct Runtime {
    conn: WorkspaceConnection,
    files: Arc<Files>,
    status: GitStatus,
    auto_sync: Option<AutoSync>,
    turns: LastStepTurns,
    worktrees: Worktrees,
    disposed: Arc<AtomicBool>,
    /// The agent status listings' revisions by the front's list number.
    lists: Mutex<BTreeMap<u64, u64>>,
    /// One batch of events at a time, in order.
    events: tokio::sync::Mutex<()>,
}

impl Runtime {
    fn start(cx: &FamilyContext, info: &RuntimeInfo) -> Arc<Self> {
        let conn = connection(cx, info);
        let store = LastStepStore::new(conn.git.clone(), true);
        store.set_keeper(Some(keeper(cx)));
        let mut files = Files::new().with_last_steps(store.clone());
        if conn.ssh_host().is_none() {
            files = files.with_streams(Arc::new(LocalStreams));
        }
        let files = Arc::new(files);
        let status = GitStatus::new(conn.clone(), cx.clock.clone(), GIT_STATUS_COLD_BUDGET);
        let resolve = resolver(&files, &conn);
        let disposed = Arc::new(AtomicBool::new(false));
        let auto_sync = (!conn.is_windows()).then(|| {
            let invalidate: Invalidate = {
                let status = status.clone();
                Arc::new(move |root: &str| status.invalidate_root(root))
            };
            let auto_sync = AutoSync::new(AutoSyncArgs {
                conn: conn.clone(),
                clock: cx.clock.clone(),
                logger: logger(cx, "bridge.auto-sync"),
                invalidate_git_status: invalidate,
                resolve_git_root: resolve.clone(),
                sync_branch: None,
            });
            auto_sync.start();
            auto_sync
        });
        let turns = LastStepTurns::new(
            Arc::new(ConnectionTurnHooks {
                conn: conn.clone(),
                store,
                status: status.clone(),
                resolve_git_root: resolve,
                logger: logger(cx, "bridge"),
                disposed: disposed.clone(),
            }),
            cx.clock.clone(),
            LAST_STEP_TRANSITION_DEBOUNCE,
        );
        Arc::new(Self {
            conn,
            files,
            status,
            auto_sync,
            turns,
            worktrees: Worktrees::default(),
            disposed,
            lists: Mutex::new(BTreeMap::new()),
            events: tokio::sync::Mutex::new(()),
        })
    }

    /// Stops its background work; resolves once it drained.
    fn stop(&self) -> FutureBox<'static, ()> {
        self.disposed.store(true, Ordering::SeqCst);
        self.status.dispose();
        let auto_sync = self.auto_sync.as_ref().map(AutoSync::stop);
        let turns = self.turns.clone();
        let store = self.files.last_steps().cloned();
        async move {
            if let Some(auto_sync) = auto_sync {
                auto_sync.await;
            }
            turns.stop().await;
            if let Some(store) = store {
                store.dispose().await;
            }
        }
        .boxed()
    }

    fn is_current(&self) -> Guard {
        let disposed = self.disposed.clone();
        Arc::new(move || !disposed.load(Ordering::SeqCst))
    }
}

/// files.ts's `resolveWorkspaceGitRoot`, as the other parts take it.
fn resolver(files: &Arc<Files>, conn: &WorkspaceConnection) -> GitRootResolver {
    let (files, conn) = (files.clone(), conn.clone());
    Arc::new(move |workspace_id: String| {
        let (files, conn) = (files.clone(), conn.clone());
        async move {
            let root = files
                .workspace_git_root(&conn, &json!({ "workspace_id": workspace_id }))
                .await?;
            Ok(ResolvedRoot {
                workspace: root.workspace,
                root: root.root,
            })
        }
        .boxed()
    })
}

/// The arrangement while the core owns the family.
struct Tree {
    store: Arc<WorkspaceTreeStore>,
    pruner: Arc<WorkspaceTreePruner>,
    listener: u64,
}

#[derive(Default)]
struct Inner {
    owned: AtomicBool,
    runtimes: Mutex<BTreeMap<String, Arc<Runtime>>>,
    tree: Mutex<Option<Arc<Tree>>>,
    pull_requests: Mutex<Option<Arc<PullRequests>>>,
    /// The cards' cache while the core does not hold the MR cache.
    cards: Mutex<Option<MrCache>>,
}

struct WorkspaceFamily(Arc<Inner>);

impl Inner {
    fn runtime(&self, connection_id: &str) -> Option<Arc<Runtime>> {
        self.runtimes.lock().unwrap().get(connection_id).cloned()
    }

    fn tree(&self) -> Result<Arc<Tree>, RpcError> {
        self.tree.lock().unwrap().clone().ok_or_else(|| {
            RpcError::with_code("the workspace family is the front's now", "not_owner")
        })
    }

    fn pull_requests(&self, cx: &FamilyContext) -> Arc<PullRequests> {
        self.pull_requests
            .lock()
            .unwrap()
            .get_or_insert_with(|| {
                PullRequests::new(cx.clock.clone(), ForgeGate::new(cx.clock.clone()))
            })
            .clone()
    }

    /// The MR cache the cards share: the core's own while it holds the
    /// mr_cache family, else one in memory (no file) for this family.
    fn cards(&self, cx: &FamilyContext) -> MrCache {
        if let Some(cache) = super::mr_cache::shared_cache() {
            return cache;
        }
        self.cards
            .lock()
            .unwrap()
            .get_or_insert_with(|| MrCache::open(cx.clock.clone(), None, None))
            .clone()
    }
}

/// A Herdr `workspace.list` answer of the runtime's connection with its
/// worktree parents, as the arrangement reads it.
fn runtime_enrich(runtime: &Arc<Runtime>) -> EnrichList {
    let runtime = runtime.clone();
    Arc::new(move |listed: Value| {
        let runtime = runtime.clone();
        async move {
            Ok(runtime
                .worktrees
                .enrich_workspace_list(&runtime.conn, listed)
                .await)
        }
        .boxed()
    })
}

/// A connection's live workspaces for the pruner: None when the core has
/// no runtime of it (down: its workspaces stay).
fn list_live(inner: std::sync::Weak<Inner>) -> ListLive {
    Arc::new(move |connection_id: String| {
        let inner = inner.clone();
        async move {
            let Some(inner) = inner.upgrade() else {
                return Ok(None);
            };
            let Some(runtime) = inner.runtime(&connection_id) else {
                return Ok(None);
            };
            let enrich = runtime_enrich(&runtime);
            list_workspace_identities(runtime.conn.herdr.as_ref(), Some(&enrich)).await
        }
        .boxed()
    })
}

impl WorkspaceFamily {
    fn start_tree(&self, cx: &FamilyContext) {
        let settings: Arc<dyn SettingsAccess> = Arc::new(CoreSettings {
            cx: cx.clone(),
            connection_id: String::new(),
        });
        let store = WorkspaceTreeStore::new(settings);
        let push_cx = cx.clone();
        let listener = store.listen(Arc::new(move |tree: &Value| {
            push_cx.push(Push {
                message: json!({ "workspace_tree": tree }),
                key: Some("workspace_tree".into()),
                connection_id: None,
                connection_generation: None,
                socket_id: None,
                session_id: None,
            });
        }));
        let log = logger(cx, "bridge");
        let pruner = WorkspaceTreePruner::new(
            store.clone(),
            PrunerOptions {
                list: list_live(Arc::downgrade(&self.0)),
                clock: cx.clock.clone(),
                confirm: PRUNE_CONFIRM,
                settle: PRUNE_SETTLE,
                on_error: Some(Arc::new(move |error: &str, connection_id: &str| {
                    let fields = [
                        ("connection".to_owned(), Value::from(connection_id)),
                        ("error".to_owned(), Value::from(error)),
                    ]
                    .into_iter()
                    .collect();
                    log.warn("could not tidy the workspace arrangement", Some(&fields));
                })),
            },
        );
        *self.0.tree.lock().unwrap() = Some(Arc::new(Tree {
            store,
            pruner,
            listener,
        }));
    }

    fn stop_all(&self) -> FutureBox<'static, ()> {
        let runtimes: Vec<_> = std::mem::take(&mut *self.0.runtimes.lock().unwrap())
            .into_values()
            .collect();
        if let Some(tree) = self.0.tree.lock().unwrap().take() {
            tree.store.unlisten(tree.listener);
            tree.pruner.dispose();
        }
        let stops: Vec<_> = runtimes.iter().map(|runtime| runtime.stop()).collect();
        futures_util::future::join_all(stops).map(|_| ()).boxed()
    }
}

/// A browser call's runtime: the one the front started, else (a shadow
/// read while the front owns the family) the connection as the front
/// says it is now, with nothing running in the background.
async fn call_runtime(
    inner: &Arc<Inner>,
    cx: &FamilyContext,
    call: &IncomingCall,
) -> Result<Arc<Runtime>, RpcError> {
    let connection_id = call
        .ctx
        .connection_id
        .clone()
        .unwrap_or_else(|| "local".to_owned());
    if let Some(runtime) = inner.runtime(&connection_id) {
        if let Some(generation) = call.ctx.connection_generation
            && generation != runtime.conn.generation
        {
            return Err(RpcError::new(
                auto_sync_settings::CONNECTION_CHANGED_DURING_REQUEST,
            ));
        }
        return Ok(runtime);
    }
    if !call.shadow {
        return Err(RpcError::with_code(
            format!("connection not ready: {connection_id}"),
            "not_ready",
        ));
    }
    let ready = cx.reverse("connections.ready", Value::Null).await?;
    let entry = ready
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|each| param(each, "id") == Some(&connection_id))
        })
        .cloned()
        .ok_or_else(|| {
            RpcError::with_code(
                format!("connection not ready: {connection_id}"),
                "not_ready",
            )
        })?;
    let info = RuntimeInfo {
        connection_id,
        generation: entry.get("generation").and_then(Value::as_u64).unwrap_or(0),
        ssh_host: param(&entry, "ssh_host").map(str::to_owned),
        remote_platform: param(&entry, "remote_platform").map(str::to_owned),
    };
    let conn = connection(cx, &info);
    let store = LastStepStore::new(conn.git.clone(), true);
    let files = Arc::new(Files::new().with_last_steps(store.clone()));
    let status = GitStatus::new(conn.clone(), cx.clock.clone(), GIT_STATUS_COLD_BUDGET);
    let turns = LastStepTurns::new(
        Arc::new(ConnectionTurnHooks {
            conn: conn.clone(),
            store,
            status: status.clone(),
            resolve_git_root: resolver(&files, &conn),
            logger: logger(cx, "bridge"),
            disposed: Arc::new(AtomicBool::new(true)),
        }),
        cx.clock.clone(),
        LAST_STEP_TRANSITION_DEBOUNCE,
    );
    Ok(Arc::new(Runtime {
        conn,
        files,
        status,
        auto_sync: None,
        turns,
        worktrees: Worktrees::default(),
        disposed: Arc::new(AtomicBool::new(true)),
        lists: Mutex::new(BTreeMap::new()),
        events: tokio::sync::Mutex::new(()),
    }))
}

/// A browser RPC of the family on its connection's runtime.
async fn browser_call(
    inner: Arc<Inner>,
    cx: FamilyContext,
    call: IncomingCall,
) -> Result<Value, RpcError> {
    let method = call.method.as_str();
    let params = &call.params;
    if method.starts_with("bridge.workspace_tree.") {
        let store = match inner.tree() {
            Ok(tree) => tree.store.clone(),
            // A shadow read while the front owns the family: the
            // arrangement as settings.json holds it, nothing written.
            Err(_) if call.shadow && method == "bridge.workspace_tree.get" => {
                WorkspaceTreeStore::new(Arc::new(CoreSettings {
                    cx: cx.clone(),
                    connection_id: String::new(),
                }))
            }
            Err(error) => return Err(error),
        };
        return tree_store::rpc(&store, method, params)
            .await
            .unwrap_or_else(|| Err(WorkspaceError::new(format!("unknown method {method}"))))
            .map_err(rpc_error);
    }
    let runtime = call_runtime(&inner, &cx, &call).await?;
    let conn = &runtime.conn;
    if method == "git.pull_request" {
        let answer = match runtime.files.pull_request_target(conn, params).await {
            Ok(PullRequestTarget::Answer(answer)) => Ok(answer),
            Ok(PullRequestTarget::Root(root)) => {
                let cards = inner.cards(&cx);
                read_workspace_pull_request(
                    conn,
                    &inner.pull_requests(&cx),
                    &cards as &dyn CardCache,
                    &root,
                    params,
                )
                .await
            }
            Err(error) => Err(error),
        };
        return answer.map_err(|_| RpcError::new(PULL_REQUEST_FAILED));
    }
    if let Some(answer) = files::rpc(
        &runtime.files,
        conn,
        method,
        params,
        call.ctx.client_ip.as_deref(),
    )
    .await
    {
        let answer = answer.map_err(rpc_error)?;
        // index.ts: a pull or an action changed the checkout.
        if matches!(method, "git.pull" | "git.file_action" | "git.repo_action")
            && let Some(root) = param(&answer, "root")
        {
            runtime.status.invalidate_root(root);
        }
        return Ok(answer);
    }
    if WORKTREE_METHODS.contains(&method) || WORKTREE_SETTINGS.contains(&method) {
        let callbacks = worktree_callbacks(&inner, &runtime);
        return runtime
            .worktrees
            .rpc(conn, method, params, &runtime.is_current(), &callbacks)
            .await
            .unwrap_or_else(|| Err(WorkspaceError::new(format!("unknown method {method}"))))
            .map_err(rpc_error);
    }
    if auto_sync_settings::METHODS.contains(&method) {
        let Some(auto_sync) = runtime.auto_sync.as_ref() else {
            return Err(RpcError::new(
                roamgate_workspace::worktree::hooks::unix_only_message("Workspace auto-sync"),
            ));
        };
        let settings_path = super::activity::settings_file(&ProcessEnv)
            .display()
            .to_string();
        let resolve = resolver(&runtime.files, conn);
        let rpc = SettingsRpc {
            conn,
            auto_sync,
            resolve_git_root: &resolve,
            settings_path: &settings_path,
            is_current: runtime.is_current(),
        };
        return auto_sync_settings::settings_rpc(&rpc, method, params)
            .await
            .unwrap_or_else(|| Err(WorkspaceError::new(format!("unknown method {method}"))))
            .map_err(rpc_error);
    }
    Err(RpcError::with_code(
        format!("unknown method {method}"),
        "unknown_method",
    ))
}

fn worktree_callbacks(inner: &Arc<Inner>, runtime: &Arc<Runtime>) -> WorktreeCallbacks {
    let resolve_git_root: ResolveGitRoot = {
        let (files, conn) = (runtime.files.clone(), runtime.conn.clone());
        Arc::new(move |workspace_id: String| {
            let (files, conn) = (files.clone(), conn.clone());
            async move {
                files
                    .workspace_git_root(&conn, &json!({ "workspace_id": workspace_id }))
                    .await
                    .map(|root| root.root)
            }
            .boxed()
        })
    };
    let place_created: Option<PlaceCreated> = inner.tree.lock().unwrap().clone().map(|tree| {
        let runtime = runtime.clone();
        Arc::new(move |created: Value, requester: Option<String>| {
            let (tree, runtime) = (tree.clone(), runtime.clone());
            async move {
                let enrich = runtime_enrich(&runtime);
                place_created_workspace_under(
                    &tree.store,
                    &runtime.conn.id,
                    runtime.conn.herdr.as_ref(),
                    Some(&enrich),
                    &created,
                    requester.as_deref(),
                )
                .await
                .map_err(WorkspaceError::new)
            }
            .boxed()
        }) as PlaceCreated
    });
    WorktreeCallbacks {
        resolve_git_root,
        place_created,
    }
}

/// The front's own calls.
async fn internal(
    family: &WorkspaceFamily,
    cx: &FamilyContext,
    op: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let inner = &family.0;
    if !inner.owned.load(Ordering::SeqCst) {
        return Err(RpcError::with_code(
            "the workspace family is the front's now",
            "not_owner",
        ));
    }
    let connection = || {
        let id = param(params, "connection_id").unwrap_or("local");
        inner
            .runtime(id)
            .ok_or_else(|| RpcError::with_code(format!("connection not ready: {id}"), "not_ready"))
    };
    // The family's own answers to the front's other parts count as served
    // (the parity suite's proof), the bookkeeping does not.
    if matches!(op, "enrich" | "last_step" | "tree") {
        roamgate_sidecar::core::note_served(
            &ProcessEnv,
            FAMILY,
            &format!("internal.workspace.{op}"),
        );
    }
    match op {
        "runtime_start" => {
            let info = RuntimeInfo::from_params(params)?;
            let previous = inner.runtime(&info.connection_id);
            if let Some(previous) = &previous
                && previous.conn.generation == info.generation
            {
                return Ok(json!({ "ok": true }));
            }
            let runtime = Runtime::start(cx, &info);
            inner
                .runtimes
                .lock()
                .unwrap()
                .insert(info.connection_id.clone(), runtime);
            if let Some(previous) = previous {
                tokio::spawn(previous.stop());
            }
            if let Ok(tree) = inner.tree() {
                tree.pruner.ready(&info.connection_id);
            }
            Ok(json!({ "ok": true }))
        }
        "runtime_stop" => {
            let id = param(params, "connection_id").unwrap_or_default();
            let generation = params.get("generation").and_then(Value::as_u64);
            let runtime = {
                let mut runtimes = inner.runtimes.lock().unwrap();
                match runtimes.get(id) {
                    Some(runtime) if generation.is_none_or(|g| g == runtime.conn.generation) => {
                        runtimes.remove(id)
                    }
                    _ => None,
                }
            };
            if let Some(runtime) = runtime {
                let _ = tokio::time::timeout(STOP_WAIT, runtime.stop()).await;
            }
            Ok(json!({ "ok": true }))
        }
        "events" => {
            let runtime = connection()?;
            if params.get("generation").and_then(Value::as_u64) != Some(runtime.conn.generation) {
                return Ok(json!({ "ok": false }));
            }
            let _turn = runtime.events.lock().await;
            let tree = inner.tree().ok();
            for event in params
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let list = event.get("list").and_then(Value::as_u64);
                match param(event, "kind") {
                    Some("herdr") => {
                        let herdr = event.get("event").cloned().unwrap_or(Value::Null);
                        runtime.turns.handle_herdr_event(&herdr);
                        if let Some(tree) = &tree {
                            let _ = tree.pruner.event(&runtime.conn.id, &herdr);
                        }
                    }
                    Some("pane_list_start") => {
                        let revision = runtime.turns.begin_pane_list();
                        if let Some(list) = list {
                            runtime.lists.lock().unwrap().insert(list, revision);
                        }
                    }
                    Some("pane_list") => {
                        let revision =
                            list.and_then(|list| runtime.lists.lock().unwrap().remove(&list));
                        let result = event.get("result").cloned().unwrap_or(Value::Null);
                        runtime.turns.reconcile_pane_list(&result, revision);
                    }
                    _ => {}
                }
            }
            Ok(json!({ "ok": true }))
        }
        "enrich" => {
            let runtime = connection()?;
            let result = params.get("result").cloned().unwrap_or(Value::Null);
            if params.get("git_status") == Some(&Value::Bool(true)) {
                if runtime.conn.is_windows() {
                    return Ok(result);
                }
                return Ok(runtime.status.enrich_workspaces(result).await);
            }
            Ok(runtime
                .worktrees
                .enrich_workspace_list(&runtime.conn, result)
                .await)
        }
        "last_step" => {
            let runtime = connection()?;
            let workspace_id = param(params, "workspace_id").unwrap_or_default();
            let root = param(params, "root").unwrap_or_default();
            Ok(files::read_last_step(&runtime.files, root, workspace_id)
                .await
                .unwrap_or(Value::Null))
        }
        "invalidate" => {
            let runtime = connection()?;
            if let Some(root) = param(params, "root") {
                runtime.status.invalidate_root(root);
            }
            if let Some(workspace_id) = param(params, "workspace_id") {
                runtime.status.invalidate_workspace(workspace_id);
            }
            Ok(json!({ "ok": true }))
        }
        "tree" => {
            let tree = inner.tree()?;
            match param(params, "op") {
                Some("get") => Ok(json!({ "tree": tree.store.read().await })),
                Some("apply") => {
                    let ops = params
                        .get("ops")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let tree = tree
                        .store
                        .apply_ops(&ops)
                        .await
                        .map_err(|error| RpcError::new(error.to_string()))?;
                    Ok(json!({ "tree": tree }))
                }
                Some("place") => {
                    let changed = tree
                        .store
                        .place_created_workspace(
                            param(params, "connection_id").unwrap_or_default(),
                            params.get("workspace"),
                            param(params, "parent_connection_id"),
                            params.get("parent"),
                        )
                        .await
                        .map_err(|error| RpcError::new(error.to_string()))?;
                    Ok(json!({ "changed": changed }))
                }
                _ => Err(RpcError::new(
                    "internal.workspace.tree needs op get, apply or place",
                )),
            }
        }
        _ => Err(RpcError::with_code(
            format!("unknown method internal.workspace.{op}"),
            "unknown_method",
        )),
    }
}

/// An HTTP answer of the file routes, with its body streamed.
fn http_response(answer: FileHttpResponse) -> HttpResponse {
    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    match answer.body {
        FileBody::Bytes(bytes) => {
            let _ = tx.try_send(bytes);
        }
        FileBody::File { path, start, end } => {
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
                let Ok(mut file) = tokio::fs::File::open(&path).await else {
                    return;
                };
                if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                    return;
                }
                let mut left = end.saturating_sub(start);
                while left > 0 {
                    let mut chunk = vec![0u8; left.min(256 * 1024) as usize];
                    match file.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => {
                            chunk.truncate(read);
                            left -= read as u64;
                            if tx.send(chunk).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
        FileBody::Stream(mut chunks) => {
            tokio::spawn(async move {
                while let Some(Ok(chunk)) = chunks.recv().await {
                    if tx.send(chunk).await.is_err() {
                        return;
                    }
                }
            });
        }
    }
    HttpResponse {
        status: answer.status,
        headers: answer.headers,
        body: Some(rx),
    }
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(header, _)| header.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

async fn read_body(body: Option<BodyReceiver>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Some(mut body) = body {
        while let Some(chunk) = body.chunk().await {
            bytes.extend_from_slice(&chunk);
        }
    }
    bytes
}

impl CoreFamily for WorkspaceFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let cx = cx.clone();
        let inner = self.0.clone();
        let family = WorkspaceFamily(inner.clone());
        Box::pin(async move {
            if let Some(op) = call.method.strip_prefix("internal.workspace.") {
                return internal(&family, &cx, op, &call.params).await;
            }
            browser_call(inner, cx, call).await
        })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let cx = cx.clone();
        let inner = self.0.clone();
        Box::pin(async move {
            let (path, query) = request
                .url
                .split_once('?')
                .unwrap_or((request.url.as_str(), ""));
            let call = IncomingCall {
                id: 0,
                method: path.to_owned(),
                params: Value::Null,
                ctx: request.ctx.clone(),
                shadow: false,
            };
            let runtime = call_runtime(&inner, &cx, &call).await?;
            let files = &runtime.files;
            let conn = &runtime.conn;
            let answer = match (request.method.as_str(), path) {
                ("GET" | "HEAD", "/api/file/download") => {
                    files
                        .http_download(
                            conn,
                            query,
                            header(&request, "range"),
                            header(&request, "if-range"),
                        )
                        .await
                }
                ("POST", "/api/file/upload") => {
                    let bytes = read_body(body).await;
                    files.http_upload(conn, query, &bytes).await
                }
                ("POST" | "DELETE", "/api/file/delete") => files.http_delete(conn, query).await,
                _ => return Ok(HttpResponse::status(404)),
            };
            Ok(http_response(answer))
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let was = self.0.owned.swap(owned, Ordering::SeqCst);
        if was == owned {
            return;
        }
        tokio::spawn(self.stop_all());
        if owned {
            self.start_tree(cx);
        }
    }
}
