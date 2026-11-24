//! The agent_sessions family in the core: roamgate-agents' readers of the
//! agents' transcripts, mapped onto the channel
//! (contract/wire/core-channel.md, The agent_sessions family).
//!
//! - Browser calls: `agent_history.*` (get, older, entry, image, subscribe,
//!   unsubscribe), `agent_session.get`, `agent_artifacts.get`,
//!   `agent_commands.get`, `agent_tasks.get`, `agent_task.get`,
//!   `agent_seen.mark`, each on its call's connection.
//! - HTTP: a connection's `/agent-session/download` and `/agent-session/atif`
//!   (the front resolves the connection and forwards them with it).
//! - The front's own calls (`internal.agent_sessions.*`): `annotate`,
//!   `quiet_turn` and `note` (the seen marks Bun's agent list, Ranger and
//!   `roamgate-review notify` read and write), `socket_closed`, `refresh` (a
//!   conversation lease changed), `seen_reload` (Bun wrote its last marks),
//!   `flush` (the front stops: the pending marks now),
//!   `remote_stat` and `remote_exit` (the remote history watch's lines).
//! - Reverse calls: `agent_sessions.connection`, `agent_sessions.herdr_call`
//!   (Herdr with conversation mode's and the Claude mods' panes over it),
//!   `agent_sessions.host_read` (a transcript command on the connection's
//!   SSH host), `agent_sessions.herdr_boot`, `agent_sessions.watch_remote`,
//!   `agent_sessions.seen_written`, `notifications.clear_pane`.
//! - Pushes: `agent_history.changed` to the sockets watching a pane.
//!
//! The seen marks (`agent-seen.json`) are read and written only while the
//! core owns the family; a shadow read of `agent_history.get` while it does
//! not reads with no index store and keeps no watcher.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use roamgate_agents::files::AgentEnv;
use roamgate_agents::files::{
    BoxFut, HostRunner, LocalSessionFiles, RemoteSessionFiles, RunOutput, SessionFiles,
};
use roamgate_agents::handlers::{AgentSessionHandlers, HandlerError};
use roamgate_agents::history_watch::{
    HistoryWatcher, HistoryWatcherOptions, OnChange, SpawnRemote, WatchHandle, history_file_path,
};
use roamgate_agents::index_store::{SessionIndexStore, default_session_index_dir};
use roamgate_agents::resolver::{HerdrCall, ResolverContext};
use roamgate_agents::seen::{AgentSeenStore, agent_seen_path, mark_needs_fresh_boot, mark_params};
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_sidecar::protocol::{Push, RpcError};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

pub const FAMILY: &str = "agent_sessions";

/// What a Windows host answers (`unixOnlyHandlers`'s message).
const UNIX_ONLY: &str = "Agent history requires a Unix SSH host and is unavailable on Windows.";

/// How often the seen marks' pending write is looked at.
const SEEN_POLL: Duration = Duration::from_millis(200);

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    let family = AgentSessionsFamily::default();
    *SHARED.lock().unwrap() = Arc::downgrade(&family.shared);
    Some(Arc::new(family))
}

/// The family's state, for the standalone core's own reads of a
/// connection's transcripts (the runtime's `agentSessions` in Bun).
static SHARED: Mutex<std::sync::Weak<Shared>> = Mutex::new(std::sync::Weak::new());

/// A connection's readers while the core owns the family (its index
/// store and its files), as the browser calls use them.
pub(crate) async fn owned_readers(
    cx: &FamilyContext,
    connection_id: &str,
) -> Result<(Arc<AgentSessionHandlers>, Arc<dyn SessionFiles>), RpcError> {
    let shared = SHARED.lock().unwrap().upgrade().ok_or_else(not_owner)?;
    if !*shared.owned.lock().unwrap() {
        return Err(not_owner());
    }
    let connection = shared
        .connection(cx, Some(connection_id), None, true)
        .await?;
    if connection.windows {
        return Err(RpcError::new(UNIX_ONLY));
    }
    Ok((connection.handlers.clone(), connection.files.clone()))
}

#[derive(Default)]
struct AgentSessionsFamily {
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    /// Each connection's readers, by connection id (owned, or shadow).
    connections: Mutex<HashMap<(String, bool), Arc<Connection>>>,
    /// The seen marks while the core owns the family.
    seen: Arc<Mutex<Option<AgentSeenStore>>>,
    seen_poll: Mutex<Option<JoinHandle<()>>>,
    owned: Mutex<bool>,
}

/// One connection's readers, for one generation of it.
struct Connection {
    id: String,
    generation: Option<u64>,
    windows: bool,
    handlers: Arc<AgentSessionHandlers>,
    files: Arc<dyn SessionFiles>,
    watcher: Option<HistoryWatcher<u64>>,
    remote: Arc<RemoteSlot>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(watcher) = &self.watcher {
            watcher.dispose();
        }
    }
}

fn failed(error: RpcError) -> String {
    error.message
}

fn handler_error(error: HandlerError) -> RpcError {
    match error.code {
        Some(code) => RpcError::with_code(error.message, &code),
        None => RpcError::new(error.message),
    }
}

/// Herdr as the readers see it, through the front.
struct ReverseHerdr {
    cx: FamilyContext,
    connection_id: String,
}

impl HerdrCall for ReverseHerdr {
    fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> BoxFut<'_, Result<Value, String>> {
        let mut args = json!({
            "connection_id": self.connection_id,
            "method": method,
            "params": params,
        });
        if let Some(timeout) = timeout_ms {
            args["timeout_ms"] = json!(timeout);
        }
        Box::pin(async move {
            self.cx
                .reverse("agent_sessions.herdr_call", args)
                .await
                .map_err(failed)
        })
    }
}

/// The connection's SSH host, through the front's read lane.
struct ReverseHost {
    cx: FamilyContext,
    connection_id: String,
}

impl HostRunner for ReverseHost {
    fn run(&self, argv: Vec<String>, timeout_ms: u64) -> BoxFut<'_, Result<RunOutput, String>> {
        let args = json!({
            "connection_id": self.connection_id,
            "argv": argv,
            "timeout_ms": timeout_ms,
        });
        Box::pin(async move {
            let value = self
                .cx
                .reverse("agent_sessions.host_read", args)
                .await
                .map_err(failed)?;
            let stdout = base64::engine::general_purpose::STANDARD
                .decode(value["stdout"].as_str().unwrap_or_default())
                .map_err(|error| error.to_string())?;
            Ok(RunOutput {
                code: value["code"].as_i64().unwrap_or(-1) as i32,
                stdout,
                stderr: value["stderr"].as_str().unwrap_or_default().to_owned(),
            })
        })
    }
}

type OnLine = Arc<dyn Fn(&str) + Send + Sync>;

/// The remote history watch helper the front runs for a connection.
#[derive(Default)]
struct RemoteSlot {
    current: Mutex<Option<(u64, OnLine, OnChange)>>,
    ids: AtomicU64,
}

fn spawn_remote(cx: FamilyContext, connection_id: String, slot: Arc<RemoteSlot>) -> SpawnRemote {
    Arc::new(
        move |paths: Vec<String>, on_line: OnLine, on_exit: OnChange| {
            let id = slot.ids.fetch_add(1, Ordering::SeqCst) + 1;
            *slot.current.lock().unwrap() = Some((id, on_line, on_exit));
            {
                let (cx, slot, connection_id) = (cx.clone(), slot.clone(), connection_id.clone());
                tokio::spawn(async move {
                    let args =
                        json!({"connection_id": connection_id, "watch_id": id, "paths": paths});
                    if cx
                        .reverse("agent_sessions.watch_remote", args)
                        .await
                        .is_err()
                    {
                        // Never started: reported as an exit, as Bun's spawner does.
                        let gone = {
                            let mut current = slot.current.lock().unwrap();
                            match current.as_ref() {
                                Some((current_id, _, _)) if *current_id == id => current.take(),
                                _ => None,
                            }
                        };
                        if let Some((_, _, on_exit)) = gone {
                            on_exit();
                        }
                    }
                });
            }
            let (cx, slot, connection_id) = (cx.clone(), slot.clone(), connection_id.clone());
            let close: WatchHandle = Box::new(move || {
                {
                    let mut current = slot.current.lock().unwrap();
                    if current
                        .as_ref()
                        .is_some_and(|(current_id, _, _)| *current_id == id)
                    {
                        *current = None;
                    }
                }
                tokio::spawn(async move {
                    let args = json!({"connection_id": connection_id, "watch_id": id, "paths": []});
                    let _ = cx.reverse("agent_sessions.watch_remote", args).await;
                });
            });
            close
        },
    )
}

fn data() -> DataContext {
    DataContext::from_env(&ProcessEnv)
}

fn seen_path(data: &DataContext) -> PathBuf {
    agent_seen_path(&ProcessEnv, &data.data_root())
}

impl Shared {
    /// The connection's readers for the call's generation, made again when
    /// the connection moved on.
    async fn connection(
        &self,
        cx: &FamilyContext,
        connection_id: Option<&str>,
        generation: Option<u64>,
        owned: bool,
    ) -> Result<Arc<Connection>, RpcError> {
        if let Some(id) = connection_id {
            let known = self
                .connections
                .lock()
                .unwrap()
                .get(&(id.to_owned(), owned))
                .cloned();
            if let Some(known) = known
                && (generation.is_none() || known.generation == generation)
            {
                return Ok(known);
            }
        }
        let mut args = json!({});
        if let Some(id) = connection_id {
            args["connection_id"] = json!(id);
        }
        let info = cx.reverse("agent_sessions.connection", args).await?;
        let id = info["connection_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let built = Arc::new(build_connection(cx, &id, &info, owned));
        let mut connections = self.connections.lock().unwrap();
        // Another call made it meanwhile: one set of readers per generation.
        if let Some(known) = connections.get(&(id.clone(), owned))
            && known.generation == built.generation
        {
            return Ok(known.clone());
        }
        connections.insert((id, owned), built.clone());
        Ok(built)
    }

    fn owned_connections(&self) -> Vec<Arc<Connection>> {
        self.connections
            .lock()
            .unwrap()
            .iter()
            .filter(|((_, owned), _)| *owned)
            .map(|(_, connection)| connection.clone())
            .collect()
    }

    fn owned_connection(&self, id: &str) -> Option<Arc<Connection>> {
        self.connections
            .lock()
            .unwrap()
            .get(&(id.to_owned(), true))
            .cloned()
    }

    fn with_seen<T>(&self, use_it: impl FnOnce(&mut AgentSeenStore) -> T) -> Result<T, RpcError> {
        let mut seen = self.seen.lock().unwrap();
        let store = seen.as_mut().ok_or_else(not_owner)?;
        Ok(use_it(store))
    }
}

fn not_owner() -> RpcError {
    RpcError::with_code("the agent_sessions family is not served here", "not_owner")
}

/// A connection's transcript files: local, or on its SSH host.
pub(crate) fn session_files(cx: &FamilyContext, id: &str, ssh: bool) -> Arc<dyn SessionFiles> {
    if ssh {
        RemoteSessionFiles::new(Arc::new(ReverseHost {
            cx: cx.clone(),
            connection_id: id.to_owned(),
        }))
    } else {
        Arc::new(LocalSessionFiles {
            env: AgentEnv::from_process(),
        })
    }
}

/// Session readers that keep nothing (no index store, no watcher): for
/// another family's reads of a pane's transcript (conversation mode's).
pub(crate) fn session_readers(
    cx: &FamilyContext,
    id: &str,
    files: Arc<dyn SessionFiles>,
) -> Arc<AgentSessionHandlers> {
    let herdr: Arc<dyn HerdrCall> = Arc::new(ReverseHerdr {
        cx: cx.clone(),
        connection_id: id.to_owned(),
    });
    let clock = cx.clock.clone();
    Arc::new(AgentSessionHandlers::new(
        herdr,
        files,
        Arc::new(ResolverContext::new(AgentEnv::from_process())),
        None,
        Arc::new(move || clock.now() as f64),
    ))
}

fn build_connection(cx: &FamilyContext, id: &str, info: &Value, owned: bool) -> Connection {
    let herdr: Arc<dyn HerdrCall> = Arc::new(ReverseHerdr {
        cx: cx.clone(),
        connection_id: id.to_owned(),
    });
    let ssh = info["ssh"].as_bool().unwrap_or(false);
    let files = session_files(cx, id, ssh);
    // The indexes of large sessions, kept across restarts (only by the
    // family's owner: a shadow read writes nothing).
    let store = owned.then(|| {
        let home = AgentEnv::from_process().home;
        Arc::new(SessionIndexStore::new(
            Some(default_session_index_dir(&home)),
            id,
        ))
    });
    let clock = cx.clock.clone();
    let handlers = Arc::new(AgentSessionHandlers::new(
        herdr,
        files.clone(),
        Arc::new(ResolverContext::new(AgentEnv::from_process())),
        store,
        Arc::new(move || clock.now() as f64),
    ));
    let remote = Arc::new(RemoteSlot::default());
    let generation = info["generation"].as_u64();
    let watcher = owned.then(|| {
        let resolver = handlers.clone();
        let push_cx = cx.clone();
        let connection_id = id.to_owned();
        let mut options = HistoryWatcherOptions::new(
            Arc::new(move |params: Value| {
                let resolver = resolver.clone();
                Box::pin(async move {
                    resolver
                        .resolve_path(&params)
                        .await
                        .map_err(|error| error.message)
                }) as BoxFut<'static, Result<Option<String>, String>>
            }),
            Arc::new(move |socket: &u64, event: Value| {
                push_cx.push(Push {
                    message: event,
                    key: None,
                    connection_id: Some(connection_id.clone()),
                    connection_generation: generation,
                    socket_id: Some(*socket),
                    session_id: None,
                });
            }),
        );
        if ssh {
            options.spawn_remote = Some(spawn_remote(cx.clone(), id.to_owned(), remote.clone()));
        }
        HistoryWatcher::new(options)
    });
    Connection {
        id: id.to_owned(),
        generation,
        windows: info["remote_platform"].as_str() == Some("windows"),
        handlers,
        files,
        watcher,
        remote,
    }
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

impl AgentSessionsFamily {
    fn owned(&self) -> bool {
        *self.shared.owned.lock().unwrap()
    }
}

impl CoreFamily for AgentSessionsFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let shared = self.shared.clone();
        let owned = self.owned();
        let cx = cx.clone();
        Box::pin(async move {
            if let Some(op) = call.method.strip_prefix("internal.agent_sessions.") {
                if !owned {
                    return Err(not_owner());
                }
                return internal(&shared, &cx, op, &call.params).await;
            }
            // A shadow read while Bun owns the family: readers that write
            // nothing.
            let owned = owned && !call.shadow;
            let connection = shared
                .connection(
                    &cx,
                    call.ctx.connection_id.as_deref(),
                    call.ctx.connection_generation,
                    owned,
                )
                .await?;
            browser_call(&shared, &cx, &connection, &call, owned).await
        })
    }

    fn http(
        &self,
        cx: &FamilyContext,
        request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let shared = self.shared.clone();
        let owned = self.owned();
        let cx = cx.clone();
        Box::pin(async move {
            let path = request.url.split(['?', '#']).next().unwrap_or("");
            let atif = path.ends_with("/agent-session/atif");
            if !atif && !path.ends_with("/agent-session/download") {
                return Ok(HttpResponse::status(404));
            }
            let mut params = serde_json::Map::new();
            if let Some(query) = request.url.split_once('?').map(|(_, query)| query) {
                let query = query.split('#').next().unwrap_or("");
                for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                    if (key == "pane_id" || key == "agent") && !params.contains_key(key.as_ref()) {
                        params.insert(key.into_owned(), Value::String(value.into_owned()));
                    }
                }
            }
            // `url.searchParams.get(...)`: null when absent.
            for key in ["pane_id", "agent"] {
                params.entry(key).or_insert(Value::Null);
            }
            let connection = shared
                .connection(
                    &cx,
                    request.ctx.connection_id.as_deref(),
                    request.ctx.connection_generation,
                    owned,
                )
                .await?;
            let params = Value::Object(params);
            let answer = if atif {
                connection.handlers.download_atif(&params).await
            } else {
                connection.handlers.download_file(&params).await
            };
            Ok(match answer {
                Ok((status, headers, body)) => respond(status, headers, body),
                Err(error) => respond(
                    500,
                    vec![(
                        "content-type".into(),
                        "application/json;charset=utf-8".into(),
                    )],
                    serde_json::to_vec(&json!({ "error": error.message })).unwrap_or_default(),
                ),
            })
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let shared = self.shared.clone();
        let mut was = shared.owned.lock().unwrap();
        if *was == owned {
            return;
        }
        *was = owned;
        drop(was);
        // Each side's readers start over (their watchers go with them).
        shared
            .connections
            .lock()
            .unwrap()
            .retain(|(_, readers_owned), _| !*readers_owned);
        if let Some(poll) = shared.seen_poll.lock().unwrap().take() {
            poll.abort();
        }
        if owned {
            let data = data();
            let clock = cx.clock.clone();
            *shared.seen.lock().unwrap() = Some(AgentSeenStore::open(
                seen_path(&data),
                data,
                Box::new(move || clock.now() as f64),
            ));
            let seen = shared.seen.clone();
            let clock = cx.clock.clone();
            *shared.seen_poll.lock().unwrap() = Some(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(SEEN_POLL).await;
                    if let Some(store) = seen.lock().unwrap().as_mut() {
                        store.poll(clock.now() as f64);
                    }
                }
            }));
        } else {
            // The last marks written, then Bun reads them.
            let store = shared.seen.lock().unwrap().take();
            if let Some(mut store) = store {
                store.flush();
                let cx = cx.clone();
                tokio::spawn(async move {
                    let _ = cx.reverse("agent_sessions.seen_written", json!({})).await;
                });
            }
        }
    }
}

fn respond(status: u16, headers: Vec<(String, String)>, body: Vec<u8>) -> HttpResponse {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let _ = tx.try_send(body);
    HttpResponse {
        status,
        headers,
        body: Some(rx),
    }
}

async fn browser_call(
    shared: &Shared,
    cx: &FamilyContext,
    connection: &Connection,
    call: &IncomingCall,
    owned: bool,
) -> Result<Value, RpcError> {
    let params = if call.params.is_null() {
        json!({})
    } else {
        call.params.clone()
    };
    let method = call.method.as_str();
    if connection.windows && method != "agent_seen.mark" {
        return Err(RpcError::new(UNIX_ONLY));
    }
    let handlers = &connection.handlers;
    let result = match method {
        "agent_seen.mark" => return mark_seen(shared, cx, connection, &params).await,
        "agent_history.subscribe" => {
            let (Some(watcher), Some(socket)) = (&connection.watcher, call.ctx.socket_id) else {
                return Err(RpcError::new("History push is unavailable here"));
            };
            return watcher
                .subscribe(socket, &params)
                .await
                .map_err(RpcError::new);
        }
        "agent_history.unsubscribe" => {
            if let (Some(watcher), Some(socket)) = (&connection.watcher, call.ctx.socket_id) {
                let pane = params
                    .get("pane_id")
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => roamgate_agents::js::to_text(other),
                    })
                    .unwrap_or_default();
                watcher.unsubscribe(&socket, &pane);
            }
            return Ok(json!({ "ok": true }));
        }
        "agent_history.get" => {
            let result = handlers.read_history(&params).await;
            if let (Ok(result), Some(watcher), Some(pane)) =
                (&result, &connection.watcher, str_param(&params, "pane_id"))
                && owned
            {
                // The pane may have moved to another file (/clear, a new
                // session): its watcher follows now.
                watcher.note_path(pane, history_file_path(result).as_deref());
            }
            result
        }
        "agent_history.older" => handlers.read_older(&params).await,
        "agent_history.entry" => handlers.read_entry(&params).await,
        "agent_history.image" => handlers.read_image(&params).await,
        "agent_session.get" => handlers.read_summary(&params).await,
        "agent_artifacts.get" => handlers.read_artifacts(&params).await,
        "agent_commands.get" => handlers.read_commands(&params).await,
        "agent_tasks.get" => handlers.read_tasks(&params).await,
        "agent_task.get" => handlers.read_task(&params).await,
        other => {
            return Err(RpcError::with_code(
                format!("unknown method {other}"),
                "unknown_method",
            ));
        }
    };
    result.map_err(handler_error)
}

/// `agent_seen.mark` on the connection's current Herdr boot.
async fn mark_seen(
    shared: &Shared,
    cx: &FamilyContext,
    connection: &Connection,
    params: &Value,
) -> Result<Value, RpcError> {
    let (pane, terminal, seq) = mark_params(params).map_err(RpcError::new)?;
    let fresh = shared
        .with_seen(|store| mark_needs_fresh_boot(store, &connection.id, &pane, &terminal, seq))?;
    let boot = cx
        .reverse(
            "agent_sessions.herdr_boot",
            json!({"connection_id": connection.id, "fresh": fresh}),
        )
        .await
        .ok()
        .and_then(|boot| boot.as_str().map(str::to_owned))
        .filter(|boot| !boot.is_empty());
    let marked = shared
        .with_seen(|store| store.mark(&connection.id, &pane, &terminal, seq, boot.as_deref()))?;
    // The user looks at the agent: what it notified about is seen.
    let _ = cx
        .reverse(
            "notifications.clear_pane",
            json!({"connection_id": connection.id, "pane_id": pane}),
        )
        .await;
    Ok(json!({ "marked": marked }))
}

async fn internal(
    shared: &Shared,
    cx: &FamilyContext,
    op: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    let connection_id = str_param(params, "connection_id").unwrap_or_default();
    // The seen marks' own work counts as served for the parity suite's
    // proof (Bun's agent list reads them here); the notices do not.
    if matches!(op, "annotate" | "quiet_turn" | "note") {
        roamgate_sidecar::core::note_served(
            &ProcessEnv,
            FAMILY,
            &format!("internal.agent_sessions.{op}"),
        );
    }
    match op {
        "annotate" => {
            let boot = str_param(params, "boot");
            let result = params.get("result").cloned().unwrap_or(Value::Null);
            shared.with_seen(|store| store.annotate(connection_id, &result, boot))
        }
        "quiet_turn" => {
            let pane = str_param(params, "pane_id").unwrap_or_default();
            let terminal = str_param(params, "terminal_id").unwrap_or_default();
            let seq = params["seq"].as_f64().unwrap_or(-1.0);
            let status = str_param(params, "status").unwrap_or_default();
            shared
                .with_seen(|store| store.quiet_turn(connection_id, pane, terminal, seq, status))?;
            Ok(json!({ "ok": true }))
        }
        "note" => {
            let pane = str_param(params, "pane_id").unwrap_or_default();
            let text = str_param(params, "text").unwrap_or_default();
            let title = str_param(params, "title");
            shared.with_seen(|store| store.note(connection_id, pane, text, title))?;
            Ok(json!({ "ok": true }))
        }
        "flush" => {
            // The front stops: the pending marks now.
            shared.with_seen(AgentSeenStore::flush)?;
            Ok(json!({ "ok": true }))
        }
        "seen_reload" => {
            // Bun wrote its last marks: read them, unless marks were made
            // here meanwhile (they win, written with the next burst).
            let data = data();
            let clock = cx.clock.clone();
            let mut seen = shared.seen.lock().unwrap();
            if seen.as_ref().is_some_and(|store| store.due().is_none()) {
                *seen = Some(AgentSeenStore::open(
                    seen_path(&data),
                    data,
                    Box::new(move || clock.now() as f64),
                ));
            }
            Ok(json!({ "ok": true }))
        }
        "socket_closed" => {
            if let Some(socket) = params["socket_id"].as_u64() {
                for connection in shared.owned_connections() {
                    if let Some(watcher) = &connection.watcher {
                        watcher.cleanup_ws(&socket);
                    }
                }
            }
            Ok(json!({ "ok": true }))
        }
        "refresh" => {
            if let (Some(connection), Some(pane)) = (
                shared.owned_connection(connection_id),
                str_param(params, "pane_id"),
            ) && let Some(watcher) = &connection.watcher
            {
                watcher.refresh(pane);
            }
            Ok(json!({ "ok": true }))
        }
        "remote_stat" | "remote_exit" => {
            let watch_id = params["watch_id"].as_u64();
            let Some(connection) = shared.owned_connection(connection_id) else {
                return Ok(json!({ "ok": false }));
            };
            let slot = &connection.remote;
            if op == "remote_stat" {
                let on_line = slot
                    .current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|(id, _, _)| Some(*id) == watch_id)
                    .map(|(_, on_line, _)| on_line.clone());
                if let Some(on_line) = on_line {
                    on_line(str_param(params, "line").unwrap_or_default());
                }
            } else {
                let gone = {
                    let mut current = slot.current.lock().unwrap();
                    match current.as_ref() {
                        Some((id, _, _)) if Some(*id) == watch_id => current.take(),
                        _ => None,
                    }
                };
                if let Some((_, _, on_exit)) = gone {
                    on_exit();
                }
            }
            Ok(json!({ "ok": true }))
        }
        other => Err(RpcError::with_code(
            format!("unknown method internal.agent_sessions.{other}"),
            "unknown_method",
        )),
    }
}
