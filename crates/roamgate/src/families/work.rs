//! The work family in the core: roamgate-work's board, its effects mapped
//! onto the channel (contract/wire/core-channel.md, Reverse targets).
//!
//! - Browser calls: `bridge.work.*` (machine-wide; the error is the
//!   message alone, as Bun's `work-error` reply).
//! - The front's own calls: `internal.work.tool {tool, params, caller,
//!   address?}` (the agent socket's `work` command and the mod's tools),
//!   `internal.work.user_tool {tool, params}` (the voice companion's),
//!   `internal.work.questions_seen {item, threads}` (an item's review
//!   changed), `internal.work.owner_pane {item, connection_id}` (where an
//!   item's comments go).
//! - Reverse calls: `work.review {op, ...}` (the review service),
//!   `work.notify`, `work.git`, `work.read_file`, `work.checkout`,
//!   `work.panes`, `work.workspaces`, `agents.addresses`,
//!   `connections.list`, `history.changed`, `history.work_changed`.
//! - Pushes: `{work: push}` to every page.
//!
//! The board runs (its checks, its writes of `<data>/work`) only while the
//! core owns the family; a shadow read while it does not is answered from
//! the file, in memory, writing nothing.

use std::sync::{Arc, Mutex, OnceLock};

use roamgate_base::env::{ProcessEnv, roamgate_env};
use roamgate_base::log::{LogFields, LogLevel, Logger, LoggerOptions, parse_log_level};
use roamgate_base::paths::DataContext;
use roamgate_sidecar::family::{CoreFamily, FamilyContext};
use roamgate_sidecar::peer::{BoxFuture as PeerFuture, IncomingCall};
use roamgate_sidecar::protocol::{Push, RpcError};
use roamgate_work::service::{
    BoxFuture, GitRead, Pane, WorkDeps, WorkReviews, WorkService, Workspace,
};
use roamgate_work::store::{
    HistorySink, Params, StoreWrites, WorkActor, WorkError, WorkResult, WorkStore, work_directory,
};
use roamgate_work::{By, ReviewSession, ReviewSnapshot, ReviewThread, WorkItem, WorkPush};
use serde_json::{Map, Value, json};

pub const FAMILY: &str = "work";

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(WorkFamily::default()))
}

#[derive(Default)]
struct WorkFamily {
    /// The board while the core owns the family.
    running: Mutex<Option<Board>>,
}

#[derive(Clone)]
struct Board {
    service: WorkService,
    deps: Arc<ReverseDeps>,
}

fn logger(cx: &FamilyContext) -> Logger {
    let level = roamgate_env(&ProcessEnv, "LOG_LEVEL")
        .and_then(|value| parse_log_level(&value).ok())
        .unwrap_or(LogLevel::Info);
    let clock = cx.clock.clone();
    Logger::with(LoggerOptions {
        level: Some(level),
        scope: Some("bridge".into()),
        now: Some(Arc::new(move || clock.now())),
        ..LoggerOptions::default()
    })
}

fn failed(error: RpcError) -> WorkError {
    WorkError {
        message: error.message,
        code: None,
    }
}

/// What the board asks of Bun, by reverse calls.
struct ReverseDeps {
    cx: FamilyContext,
    /// Writes and tells (a shadow read's deps do neither).
    owned: bool,
    /// This Roamgate's own checkout, asked once.
    checkout: OnceLock<Option<String>>,
    logger: Logger,
}

impl ReverseDeps {
    async fn call(&self, target: &str, args: Value) -> WorkResult<Value> {
        self.cx.reverse(target, args).await.map_err(failed)
    }

    /// Fire and forget (a notification, the history).
    fn tell(&self, target: &'static str, args: Value) {
        if !self.owned {
            return;
        }
        let cx = self.cx.clone();
        tokio::spawn(async move {
            let _ = cx.reverse(target, args).await;
        });
    }

    async fn ensure_checkout(&self) {
        if self.checkout.get().is_some() {
            return;
        }
        let checkout = self
            .call("work.checkout", json!({}))
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned));
        let _ = self.checkout.set(checkout);
    }

    async fn connections(&self) -> Vec<Value> {
        self.call("connections.list", json!({}))
            .await
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    async fn review(&self, op: &str, mut args: Value) -> WorkResult<Value> {
        args["op"] = json!(op);
        self.call("work.review", args).await
    }
}

fn snapshot_of(value: Value) -> WorkResult<Option<ReviewSnapshot>> {
    if value.is_null() {
        return Ok(None);
    }
    ReviewSnapshot::from_value(value)
        .map(Some)
        .ok_or_else(|| WorkError::other("work.review: not a review"))
}

fn thread_of(value: Value) -> WorkResult<ReviewThread> {
    ReviewThread::from_value(value).ok_or_else(|| WorkError::other("work.review: not a thread"))
}

impl WorkReviews for ReverseDeps {
    fn find(&self, item: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>> {
        let args = json!({"item": item});
        Box::pin(async move { snapshot_of(self.review("find", args).await?) })
    }

    fn open(
        &self,
        item: &str,
        connection_id: &str,
        root: &str,
        title: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewSnapshot>> {
        let args =
            json!({"item": item, "connection_id": connection_id, "root": root, "title": title});
        Box::pin(async move {
            snapshot_of(self.review("open", args).await?)?
                .ok_or_else(|| WorkError::other("work.review: the review was not opened"))
        })
    }

    fn get(&self, review: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>> {
        let args = json!({"review": review});
        Box::pin(async move { snapshot_of(self.review("get", args).await?) })
    }

    fn session_of_comment(&self, id: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSession>>> {
        let args = json!({"id": id});
        Box::pin(async move {
            let value = self.review("session_of_comment", args).await?;
            Ok((!value.is_null())
                .then(|| ReviewSession::from_value(value))
                .flatten())
        })
    }

    fn add_thread(
        &self,
        session_id: &str,
        author: &str,
        text: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let args =
            json!({"session_id": session_id, "author": author, "text": text, "anchor": anchor});
        Box::pin(async move { thread_of(self.review("add_thread", args).await?) })
    }

    fn move_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let args = json!({"session_id": session_id, "thread_id": thread_id, "anchor": anchor});
        Box::pin(async move { thread_of(self.review("move_thread", args).await?) })
    }

    fn set_anchor(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let args = json!({"session_id": session_id, "thread_id": thread_id, "anchor": anchor});
        Box::pin(async move { thread_of(self.review("set_anchor", args).await?) })
    }

    fn add_image(
        &self,
        session_id: &str,
        kind: &str,
        data: Vec<u8>,
    ) -> BoxFuture<'_, WorkResult<String>> {
        use base64::Engine as _;
        let args = json!({
            "session_id": session_id,
            "type": kind,
            "data": base64::engine::general_purpose::STANDARD.encode(data),
        });
        Box::pin(async move {
            self.review("add_image", args)
                .await?
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| WorkError::other("work.review: no image path"))
        })
    }

    fn edit_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
        text: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let args = json!({"session_id": session_id, "comment_id": comment_id, "author": author, "text": text});
        Box::pin(async move { thread_of(self.review("edit_comment", args).await?) })
    }

    fn delete_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
    ) -> BoxFuture<'_, WorkResult<(String, Option<ReviewThread>)>> {
        let args = json!({"session_id": session_id, "comment_id": comment_id, "author": author});
        Box::pin(async move {
            let value = self.review("delete_comment", args).await?;
            let deleted = value["deleted"].as_str().unwrap_or_default().to_owned();
            let thread = match value.get("thread") {
                None | Some(Value::Null) => None,
                Some(thread) => Some(thread_of(thread.clone())?),
            };
            Ok((deleted, thread))
        })
    }
}

impl WorkDeps for ReverseDeps {
    fn publish(&self, push: WorkPush) {
        if !self.owned {
            return;
        }
        self.cx.push(Push {
            message: json!({ "work": push }),
            ..Push::default()
        });
    }

    fn reviews(&self) -> Option<&dyn WorkReviews> {
        Some(self)
    }

    fn notify(&self, item: &WorkItem, publish: bool) {
        self.tell(
            "work.notify",
            json!({"op": if publish { "publish" } else { "clear" }, "item": item}),
        );
    }

    fn has_git(&self) -> bool {
        true
    }

    fn git<'a>(
        &'a self,
        root: &'a str,
        args: Vec<String>,
        connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, GitRead> {
        Box::pin(async move {
            let read = self
                .call(
                    "work.git",
                    json!({"root": root, "args": args, "connection_id": connection_id}),
                )
                .await
                .unwrap_or(Value::Null);
            GitRead {
                code: read["code"].as_i64().map(|code| code as i32),
                stdout: read["stdout"].as_str().unwrap_or_default().to_owned(),
            }
        })
    }

    fn has_read_file(&self) -> bool {
        true
    }

    fn read_file<'a>(
        &'a self,
        root: &'a str,
        path: &'a str,
        connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            self.call(
                "work.read_file",
                json!({"root": root, "path": path, "connection_id": connection_id}),
            )
            .await
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
        })
    }

    fn sessions(&self) -> Option<BoxFuture<'_, WorkResult<Vec<String>>>> {
        Some(Box::pin(async move {
            let listed = self.call("agents.addresses", json!({})).await?;
            Ok(listed
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|each| each.as_str().map(str::to_owned))
                .collect())
        }))
    }

    fn deployed(&self) -> Option<String> {
        let checkout = self.checkout.get()?.as_ref()?;
        roamgate_work::deployed::deployed_of(std::path::Path::new(checkout))
    }

    fn own_root(&self) -> Option<String> {
        self.checkout.get().cloned().flatten()
    }

    fn default_connection(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let listed = self.connections().await;
            listed
                .iter()
                .find(|each| each["is_default"] == true)
                .or(listed.first())
                .and_then(|each| each["id"].as_str().map(str::to_owned))
        })
    }

    fn has_places(&self) -> bool {
        true
    }

    fn panes<'a>(&'a self, connection_id: &'a str) -> BoxFuture<'a, Result<Vec<Pane>, String>> {
        Box::pin(async move {
            let listed = self
                .call("work.panes", json!({"connection_id": connection_id}))
                .await
                .map_err(|error| error.message)?;
            serde_json::from_value(listed).map_err(|error| error.to_string())
        })
    }

    fn workspaces<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Workspace>, String>> {
        Box::pin(async move {
            let listed = self
                .call("work.workspaces", json!({"connection_id": connection_id}))
                .await
                .map_err(|error| error.message)?;
            serde_json::from_value(listed).map_err(|error| error.to_string())
        })
    }

    fn generation<'a>(&'a self, connection_id: &'a str) -> BoxFuture<'a, Option<u64>> {
        Box::pin(async move {
            self.connections()
                .await
                .iter()
                .find(|each| each["id"] == connection_id)
                .and_then(|each| each["generation"].as_u64())
        })
    }

    fn log(&self, message: &str, fields: Value) {
        let fields: LogFields = fields.as_object().cloned().unwrap_or_default();
        self.logger.warn(message, Some(&fields));
    }
}

/// The store's writes told to Bun's local history.
struct ReverseHistory(Arc<ReverseDeps>);

impl HistorySink for ReverseHistory {
    fn changed(&self, area: &str, id: Option<&str>) {
        self.0
            .tell("history.changed", json!({"area": area, "id": id}));
    }

    fn work_changed(
        &self,
        item: Option<&WorkItem>,
        id: &str,
        change: &Map<String, Value>,
        actor: &WorkActor,
        at: &str,
    ) {
        self.0.tell(
            "history.work_changed",
            json!({"item": item, "id": id, "change": change, "actor": actor, "at": at}),
        );
    }
}

/// A board on the channel: `owned`, it writes the store, pushes and tells;
/// otherwise it reads the file into memory and writes nothing.
fn board(cx: &FamilyContext, owned: bool) -> Board {
    let deps = Arc::new(ReverseDeps {
        cx: cx.clone(),
        owned,
        checkout: OnceLock::new(),
        logger: logger(cx),
    });
    let context = DataContext::from_env(&ProcessEnv);
    let directory = work_directory(&ProcessEnv, &context.data_root());
    let writes = if owned {
        let owners = cx.owners.clone();
        StoreWrites::Disk {
            context,
            can_write: Some(Arc::new(move || {
                owners
                    .check_write(FAMILY)
                    .map_err(|error| error.to_string())
            })),
        }
    } else {
        StoreWrites::Memory
    };
    let clock = cx.clock.clone();
    let store = WorkStore::open(
        &directory,
        writes,
        Arc::new(ReverseHistory(deps.clone())),
        Arc::new(move || roamgate_work::text::iso(clock.now())),
    );
    Board {
        service: WorkService::new(store, deps.clone(), cx.clock.clone()),
        deps,
    }
}

fn params_of(value: &Value) -> Params {
    value.as_object().cloned().unwrap_or_default()
}

/// A board's error as the front answers it: the board's code, if any.
fn tool_error(error: WorkError) -> RpcError {
    match error.code {
        Some(code) => RpcError::with_code(error.message, code),
        None => RpcError::new(error.message),
    }
}

impl WorkFamily {
    fn running(&self) -> Option<Board> {
        self.running.lock().unwrap().clone()
    }
}

impl CoreFamily for WorkFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> PeerFuture<Result<Value, RpcError>> {
        let running = self.running();
        let cx = cx.clone();
        Box::pin(async move {
            let method = call.method.as_str();
            let params = &call.params;
            if let Some(op) = method.strip_prefix("internal.work.") {
                let Some(board) = running else {
                    return Err(RpcError::with_code(
                        "the work family is not served here",
                        "not_owner",
                    ));
                };
                board.deps.ensure_checkout().await;
                board.service.start();
                return internal(&board, op, params).await;
            }
            // A browser's call: the board's, or a shadow read's one look.
            let board = match running {
                Some(board) => {
                    board.deps.ensure_checkout().await;
                    board.service.start();
                    board
                }
                None => {
                    let once = board(&cx, false);
                    once.deps.ensure_checkout().await;
                    once
                }
            };
            roamgate_work::rpc::handle_work_rpc(&board.service, method, &params_of(params))
                .await
                // As Bun's `work-error` reply: the message alone.
                .map_err(|error| RpcError::new(error.message))
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.take() {
            previous.service.stop();
        }
        if owned {
            // The file as Bun left it; the checks start with the first call.
            *running = Some(board(cx, true));
        }
    }
}

/// The front's own calls. The tools are the board's own answers (an
/// agent's or the user's call, through Bun's socket or MCP server): they
/// count as served for the parity suite's proof, the notices do not.
async fn internal(board: &Board, op: &str, params: &Value) -> Result<Value, RpcError> {
    let service = &board.service;
    if op == "tool" || op == "user_tool" {
        roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, &format!("internal.work.{op}"));
    }
    match op {
        "tool" => {
            let tool = params["tool"].as_str().unwrap_or_default();
            let caller = params["caller"].as_str().unwrap_or("Claude");
            let address = params["address"].as_str();
            let by = if params["by"] == "user" {
                By::User
            } else {
                By::Agent
            };
            let text = roamgate_work::tools::work_tool(
                service,
                tool,
                params.get("params").unwrap_or(&Value::Null),
                caller,
                address,
                by,
            )
            .await
            .map_err(tool_error)?;
            Ok(json!({ "text": text }))
        }
        "user_tool" => {
            let tool = params["tool"].as_str().unwrap_or_default();
            let source = match params["source"].as_str() {
                Some(source) => source.to_owned(),
                None => roamgate_work::tools::voice_source(board.deps.cx.clock.now()),
            };
            let text = roamgate_work::tools::work_user_tool(
                service,
                tool,
                params.get("params").unwrap_or(&Value::Null),
                &source,
            )
            .await
            .map_err(tool_error)?;
            Ok(json!({ "text": text }))
        }
        "questions_seen" => {
            let item = params["item"].as_str().unwrap_or_default();
            let threads: Vec<ReviewThread> = params["threads"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|thread| ReviewThread::from_value(thread.clone()))
                .collect();
            service.questions_seen(item, &threads).map_err(tool_error)?;
            Ok(json!({"ok": true}))
        }
        "owner_pane" => {
            let item = params["item"].as_str().unwrap_or_default();
            let connection_id = params["connection_id"].as_str().unwrap_or_default();
            Ok(json!({"pane": service.owner_pane(item, connection_id).await}))
        }
        other => Err(RpcError::with_code(
            format!("unknown method internal.work.{other}"),
            "unknown_method",
        )),
    }
}
