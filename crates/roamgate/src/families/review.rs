//! The review family in the core: roamgate-review's service, owner of
//! `<data>/reviews` (reviews.sqlite and the pasted images), the browser's
//! `review.*` calls, `/api/review/image` and the review pushes.
//!
//! What the service asks of the rest of the server (git reads of a
//! checkout, agent panes and sessions, the forge) stays Bun's until those
//! families move: the family answers its `ReviewHost` with the reverse
//! calls `review.host` and `review.forge`, and a browser connection's
//! reads (its workspace's root, rendered pages) with `review.connection`.
//! What is only known in Bun and asked without waiting (whether a pane's
//! Claude has the mod's tools, whether a host runs the review client) Bun
//! sends with `internal.review.agents`. Each push also goes back to Bun
//! (`review.published`) for what Bun does with them (the notification
//! feed's prompts, the Work board's questions, the local history).
//!
//! The agent socket is the family's too: while the core owns the family it
//! serves roamgate-review's on the sockets Bun served (review_socket.rs),
//! and the `claude_mod.*` calls with roamgate-claude's install. The Claude
//! mod's hub stays Bun's while what reads it does (`review.socket`).
//!
//! Hand-over: on taking the family the core first asks Bun to close its
//! service (`review.release`), then opens reviews.sqlite; on giving it
//! back it stops its work at once, and Bun asks `internal.review.close`
//! before it opens the file again.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_channel::family::{CoreFamily, FamilyContext, Reply};
use roamgate_channel::peer::{BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall};
use roamgate_channel::protocol::{Push, RpcError};
use roamgate_review::error::{ReviewError, ReviewResult};
use roamgate_review::images::image_of_query;
use roamgate_review::model::{
    ReviewAnchor, ReviewComment, ReviewCommit, ReviewSession, ReviewTarget, ReviewThread,
};
use roamgate_review::prompts::PermissionRequest;
use roamgate_review::rpc::{
    ReviewRpcConnection, RpcFut, handle_review_rpc, is_review_method, review_get_text,
};
use roamgate_review::service::host::{Ask, Load};
use roamgate_review::service::{
    LoadError, ReviewForge, ReviewHost, ReviewService, ReviewServiceOptions,
};
use roamgate_review::storage::{ReviewStorage, review_directory};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::watch;

use super::review_socket::{SharedSockets, claude_mod_call};
use super::update::path_of;

pub const FAMILY: &str = "review";

/// How long a call waits for reviews.sqlite to be opened after a flip.
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// The review a Ranger chat's threads are in names it `ranger:<id>`
/// (shared/rangerChat.ts).
const RANGER_PREFIX: &str = "ranger:";
const RANGER_THREAD_TOOL: &str = "chat_thread_reply";

pub fn family() -> Option<Arc<dyn CoreFamily>> {
    Some(Arc::new(ReviewFamily::default()))
}

/// A pane's Claude as its mod last said, sent by Bun.
#[derive(Debug, Clone, Default)]
struct ModTools {
    /// Epoch ms until which its word holds.
    fresh_until: i64,
    work: bool,
    rules: bool,
}

/// What Bun says of its agents (`internal.review.agents`).
#[derive(Debug, Default)]
struct Agents {
    /// Whether agents on the connection's host can run the review client.
    channels: HashMap<String, bool>,
    /// By `<connection>\n<pane>`.
    tools: HashMap<String, ModTools>,
}

#[derive(Default)]
struct Slot {
    epoch: u64,
    ready: Option<watch::Receiver<Option<ReviewService>>>,
}

#[derive(Default, Clone)]
struct ReviewFamily {
    slot: Arc<Mutex<Slot>>,
    agents: Arc<Mutex<Agents>>,
    sockets: SharedSockets,
}

fn unknown(method: &str) -> RpcError {
    RpcError::with_code(format!("unknown method {method}"), "unknown_method")
}

/// A review error as the browser gets it: a gone checkout with its code.
/// A browser's review call answered: its failure logged.
fn answered<T>(method: &str, answer: ReviewResult<T>) -> Result<T, RpcError> {
    if let Err(error) = &answer {
        // A removed checkout fails each poll the same way.
        if error.code.is_some() {
            tracing::debug!(scope = "review", method, error = %error, "review request failed");
        } else {
            tracing::warn!(scope = "review", method, error = %error, "review request failed");
        }
    }
    answer.map_err(rpc_error)
}

fn rpc_error(error: ReviewError) -> RpcError {
    match error.code {
        Some(code) => RpcError::with_code(error.message, &code),
        None => RpcError::new(error.message),
    }
}

fn parsed<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("unexpected answer: {error}"))
}

fn load_error(error: RpcError) -> LoadError {
    match error.code.as_deref() {
        Some(code @ ("checkout-gone" | "base-gone" | "head-gone")) => LoadError::Gone {
            code: code.to_owned(),
            message: error.message,
        },
        _ => LoadError::Failed(error.message),
    }
}

/// A reverse call's answer as a review error: its status in `data`.
fn review_error(error: RpcError) -> ReviewError {
    let status = match error.code.as_deref() {
        Some("quota") => 413,
        _ => error
            .data
            .as_ref()
            .and_then(|data| data.get("status"))
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
            .unwrap_or(400),
    };
    ReviewError {
        message: error.message,
        status,
        code: error.code.filter(|code| code.ends_with("-gone")),
    }
}

/// The service's effects, asked of Bun.
struct ReverseHost {
    cx: FamilyContext,
    agents: Arc<Mutex<Agents>>,
}

impl ReverseHost {
    fn ask(&self, op: &'static str, mut args: Value) -> BoxFuture<Result<Value, RpcError>> {
        let cx = self.cx.clone();
        args["op"] = json!(op);
        Box::pin(async move { cx.reverse("review.host", args).await })
    }

    fn load<T: DeserializeOwned + Send + 'static>(&self, op: &'static str, args: Value) -> Load<T> {
        let asked = self.ask(op, args);
        Box::pin(async move { parsed(asked.await.map_err(load_error)?).map_err(LoadError::Failed) })
    }

    fn query<T: DeserializeOwned + Send + 'static>(&self, op: &'static str, args: Value) -> Ask<T> {
        let asked = self.ask(op, args);
        Box::pin(async move { parsed(asked.await.map_err(|error| error.message)?) })
    }

    fn mod_tools(&self, connection_id: &str, pane_id: &str) -> Option<ModTools> {
        // The core's own hub while it runs here (families/claude_mod.rs).
        if let Some(hub) = super::claude_mod::current() {
            if !hub.has_tools(connection_id, pane_id) {
                return None;
            }
            return Some(ModTools {
                fresh_until: i64::MAX,
                work: hub.has_work_tools(connection_id, pane_id),
                rules: hub.has_rules(connection_id, pane_id),
            });
        }
        let now = self.cx.clock.now();
        self.agents
            .lock()
            .unwrap()
            .tools
            .get(&format!("{connection_id}\n{pane_id}"))
            .filter(|tools| now < tools.fresh_until)
            .cloned()
    }
}

fn ranger_chat(key: &str) -> bool {
    key.strip_prefix(RANGER_PREFIX)
        .is_some_and(|id| !id.is_empty())
}

impl ReviewHost for ReverseHost {
    fn load_diff(
        &self,
        session: &ReviewSession,
        commit: Option<String>,
        paths: Option<Vec<String>>,
    ) -> Load<Value> {
        self.load(
            "loadDiff",
            json!({"session": session, "commit": commit, "paths": paths}),
        )
    }

    fn load_summary(&self, session: &ReviewSession, commit: Option<String>) -> Option<Load<Value>> {
        Some(self.load("loadSummary", json!({"session": session, "commit": commit})))
    }

    fn load_files(
        &self,
        session: &ReviewSession,
        base: String,
        head: String,
        files: Vec<Value>,
    ) -> Option<Load<Value>> {
        Some(self.load(
            "loadFiles",
            json!({"session": session, "ends": {"base": base, "head": head}, "files": files}),
        ))
    }

    fn load_commits(&self, session: &ReviewSession) -> Option<Load<Vec<ReviewCommit>>> {
        Some(self.load("loadCommits", json!({"session": session})))
    }

    fn load_patch_ids(
        &self,
        session: &ReviewSession,
        shas: Vec<String>,
    ) -> Option<Load<indexmap::IndexMap<String, String>>> {
        Some(self.load("loadPatchIds", json!({"session": session, "shas": shas})))
    }

    fn load_state(&self, session: &ReviewSession) -> Option<Load<String>> {
        Some(self.load("loadState", json!({"session": session})))
    }

    fn load_heads(
        &self,
        connection_id: &str,
        entries: Vec<(String, String)>,
    ) -> Option<Load<Vec<Option<String>>>> {
        if entries.is_empty() {
            return Some(Box::pin(async { Ok(Vec::new()) }));
        }
        let entries: Vec<Value> = entries
            .into_iter()
            .map(|(root, rev)| json!({"root": root, "ref": rev}))
            .collect();
        Some(self.load(
            "loadHeads",
            json!({"connection_id": connection_id, "entries": entries}),
        ))
    }

    fn load_file(
        &self,
        session: &ReviewSession,
        rev: String,
        path: String,
    ) -> Option<Load<String>> {
        Some(self.load(
            "loadFile",
            json!({"session": session, "rev": rev, "path": path}),
        ))
    }

    fn can_prompt(&self) -> bool {
        true
    }

    fn prompt_agent(&self, connection_id: &str, pane_id: &str, text: String) -> Ask<()> {
        let asked = self.ask(
            "promptAgent",
            json!({"connection_id": connection_id, "pane_id": pane_id, "text": text}),
        );
        Box::pin(async move { asked.await.map(|_| ()).map_err(|error| error.message) })
    }

    fn session_pane(&self, connection_id: &str, session_id: &str) -> Option<Ask<Option<String>>> {
        Some(self.query(
            "sessionPane",
            json!({"connection_id": connection_id, "session_id": session_id}),
        ))
    }

    fn pane_session(&self, connection_id: &str, pane_id: &str) -> Option<Ask<Option<String>>> {
        Some(self.query(
            "paneSession",
            json!({"connection_id": connection_id, "pane_id": pane_id}),
        ))
    }

    /// None until the front said which connections' hosts take the review
    /// client: a comment made right after a start is then delivered, not
    /// marked undeliverable for good.
    fn agent_channel(&self, connection_id: &str) -> Option<bool> {
        self.agents
            .lock()
            .unwrap()
            .channels
            .get(connection_id)
            .copied()
    }

    fn agent_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        self.mod_tools(connection_id, pane_id).is_some()
    }

    fn agent_work_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        self.mod_tools(connection_id, pane_id)
            .is_some_and(|tools| tools.work)
    }

    fn agent_rules(&self, connection_id: &str, pane_id: &str) -> bool {
        self.mod_tools(connection_id, pane_id)
            .is_some_and(|tools| tools.rules)
    }

    fn agent_compacted_since(
        &self,
        connection_id: &str,
        pane_id: &str,
        since: &str,
    ) -> Option<Ask<bool>> {
        if ranger_chat(pane_id) {
            return Some(Box::pin(async { Ok(false) }));
        }
        Some(self.query(
            "agentCompactedSince",
            json!({"connection_id": connection_id, "pane_id": pane_id, "since": since}),
        ))
    }

    fn chat_reply_how(&self, session: &ReviewSession) -> Option<String> {
        match &session.target {
            ReviewTarget::Chat { chat } if ranger_chat(chat) => Some(format!(
                "your `{RANGER_THREAD_TOOL}` tool (comment_id: the bracketed ID, text: your answer)"
            )),
            _ => None,
        }
    }

    fn on_delivery_error(&self, session: &ReviewSession, reason: &str) {
        tracing::warn!(
            scope = "review",
            connection = %session.connection_id,
            pane = %session.agent.pane_id.as_deref().unwrap_or(""),
            error = %reason,
            "review comments not delivered"
        );
    }

    fn note_cause(&self, connection_id: &str, pane_id: &str) {
        let asked = self.ask(
            "noteCause",
            json!({"connection_id": connection_id, "pane_id": pane_id}),
        );
        tokio::spawn(async move {
            if let Err(error) = asked.await {
                tracing::debug!(scope = "review", error = %error.message, "turn cause not noted");
            }
        });
    }

    fn forge(&self) -> Option<Arc<dyn ReviewForge>> {
        Some(Arc::new(ReverseForge {
            cx: self.cx.clone(),
        }))
    }
}

/// The forge of merge requests' reviews, Bun's until S14 moves it.
struct ReverseForge {
    cx: FamilyContext,
}

impl ReverseForge {
    fn ask<T: DeserializeOwned + Send + 'static>(
        &self,
        op: &'static str,
        mut args: Value,
    ) -> Ask<T> {
        let cx = self.cx.clone();
        args["op"] = json!(op);
        Box::pin(async move {
            parsed(
                cx.reverse("review.forge", args)
                    .await
                    .map_err(|error| error.message)?,
            )
        })
    }
}

impl ReviewForge for ReverseForge {
    fn checkout(&self, session: &ReviewSession) -> Load<Value> {
        let cx = self.cx.clone();
        let args = json!({"op": "checkout", "session": session});
        Box::pin(async move { cx.reverse("review.forge", args).await.map_err(load_error) })
    }

    fn find(&self, session: &ReviewSession, checkout: Value) -> Ask<Option<Value>> {
        let asked: Ask<Value> = self.ask("find", json!({"session": session, "checkout": checkout}));
        Box::pin(async move { Ok(Some(asked.await?).filter(|found| !found.is_null())) })
    }

    fn read_merge_request(&self, session: &ReviewSession, url: &str) -> Ask<Value> {
        self.ask("readMergeRequest", json!({"session": session, "url": url}))
    }

    fn read_threads(&self, session: &ReviewSession, mr: &Value) -> Ask<Vec<ReviewThread>> {
        self.ask("readThreads", json!({"session": session, "mr": mr}))
    }

    fn create_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        anchor: ReviewAnchor,
        note: String,
        diff: Option<Value>,
    ) -> Ask<ReviewThread> {
        self.ask(
            "createDraftNote",
            json!({"session": session, "mr": mr, "anchor": anchor, "note": note, "diff": diff}),
        )
    }

    fn update_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        id: i64,
        note: String,
    ) -> Ask<ReviewThread> {
        self.ask(
            "updateDraftNote",
            json!({"session": session, "mr": mr, "id": id, "note": note}),
        )
    }

    fn delete_draft_note(&self, session: &ReviewSession, mr: &Value, id: i64) -> Ask<()> {
        let asked: Ask<Value> = self.ask(
            "deleteDraftNote",
            json!({"session": session, "mr": mr, "id": id}),
        );
        Box::pin(async move { asked.await.map(|_| ()) })
    }

    fn create_draft_reply(
        &self,
        session: &ReviewSession,
        mr: &Value,
        discussion: &str,
        note: String,
    ) -> Ask<ReviewComment> {
        self.ask(
            "createDraftReply",
            json!({"session": session, "mr": mr, "discussion": discussion, "note": note}),
        )
    }
}

/// A browser's connection, asked of Bun (`review.connection`).
struct ReverseConnection {
    cx: FamilyContext,
    id: String,
}

impl ReverseConnection {
    fn ask<T: DeserializeOwned + Send + 'static>(
        &self,
        op: &'static str,
        mut args: Value,
    ) -> RpcFut<T> {
        let cx = self.cx.clone();
        args["op"] = json!(op);
        args["connection_id"] = json!(self.id);
        Box::pin(async move {
            let answer = cx
                .reverse("review.connection", args)
                .await
                .map_err(review_error)?;
            parsed(answer).map_err(|message| ReviewError::status(message, 500))
        })
    }
}

impl ReviewRpcConnection for ReverseConnection {
    fn id(&self) -> &str {
        &self.id
    }
    fn resolve_root(&self, workspace_id: &str) -> RpcFut<String> {
        self.ask("resolveRoot", json!({"workspace_id": workspace_id}))
    }
    fn can_read_default_base(&self) -> bool {
        true
    }
    fn read_default_base(&self, root: &str) -> RpcFut<String> {
        self.ask("readDefaultBase", json!({"root": root}))
    }
    fn can_read_root(&self) -> bool {
        true
    }
    fn read_root(&self, path: &str) -> RpcFut<String> {
        self.ask("readRoot", json!({"path": path}))
    }
    fn can_scan_repos(&self) -> bool {
        true
    }
    fn scan_repos(&self, paths: Vec<String>, agent_paths: Vec<String>) -> RpcFut<Value> {
        self.ask(
            "scanRepos",
            json!({"paths": paths, "agent_paths": agent_paths}),
        )
    }
    fn can_render_pages(&self) -> bool {
        true
    }
    fn rendered_page(
        &self,
        root: &str,
        target: &ReviewTarget,
        page: Option<String>,
        scripts: bool,
    ) -> RpcFut<Value> {
        self.ask(
            "renderedPage",
            json!({"root": root, "target": target.to_value(), "page": page, "scripts": scripts}),
        )
    }
    fn can_render_svg(&self) -> bool {
        true
    }
    fn rendered_svg(&self, svg: &str, color: Option<String>, scripts: bool) -> RpcFut<Value> {
        self.ask(
            "renderedSvg",
            json!({"svg": svg, "color": color, "scripts": scripts}),
        )
    }
    fn can_store_rendered(&self) -> bool {
        true
    }
    fn rendered_storage(&self, token: &str, write: Value) -> RpcFut<bool> {
        self.ask("renderedStorage", json!({"token": token, "write": write}))
    }
    fn clear_rendered_storage(&self, site: &str) -> RpcFut<()> {
        let asked: RpcFut<Value> = self.ask("clearRenderedStorage", json!({"site": site}));
        Box::pin(async move { asked.await.map(|_| ()) })
    }
}

/// What the publisher hands Bun of a push.
fn for_bun(push: &Value) -> Option<Value> {
    match push.get("type").and_then(Value::as_str)? {
        "prompts" | "removed" => Some(push.clone()),
        "session" => {
            let snapshot = push.get("snapshot")?;
            let session = snapshot.get("session")?;
            let mut told = json!({
                "type": "session",
                "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
            });
            // A work item's review: its questions are counted on its card.
            if let Some(item) = session
                .get("target")
                .filter(|target| target.get("kind").and_then(Value::as_str) == Some("work"))
                .and_then(|target| target.get("item"))
            {
                told["workItem"] = item.clone();
                told["threads"] = snapshot.get("threads").cloned().unwrap_or(json!([]));
            }
            Some(told)
        }
        _ => None,
    }
}

impl ReviewFamily {
    fn service_now(&self) -> Option<watch::Receiver<Option<ReviewService>>> {
        self.slot.lock().unwrap().ready.clone()
    }

    async fn service(&self, cx: &FamilyContext) -> Result<ReviewService, RpcError> {
        let Some(mut ready) = self.service_now() else {
            return Err(RpcError::with_code(
                "the reviews are not served here now",
                "not_owner",
            ));
        };
        let not_ready = || RpcError::with_code("the reviews are not ready", "not_ready");
        tokio::select! {
            service = ready.wait_for(Option::is_some) => {
                service.map(|service| service.clone().expect("waited for it")).map_err(|_| not_ready())
            }
            _ = cx.clock.sleep(READY_TIMEOUT) => Err(not_ready()),
        }
    }

    fn open_service(&self, cx: &FamilyContext) -> Result<ReviewService, String> {
        let context = DataContext::from_env(&ProcessEnv);
        let directory = review_directory(&ProcessEnv);
        let storage = ReviewStorage::open(&context, &directory).map_err(|e| e.to_string())?;
        let publisher = cx.clone();
        let publish = Arc::new(move |push: Value| {
            if let Some(told) = for_bun(&push) {
                let cx = publisher.clone();
                tokio::spawn(async move {
                    if let Err(error) = cx.reverse("review.published", told).await {
                        tracing::debug!(scope = "review", error = %error.message, "push not told to Bun");
                    }
                });
            }
            // A session's snapshot replaces the one before; so does a
            // connection's prompts.
            let key = match push.get("type").and_then(Value::as_str) {
                Some("session") => push
                    .pointer("/snapshot/session/id")
                    .and_then(Value::as_str)
                    .map(|id| format!("review:{id}")),
                Some("prompts") => push
                    .get("connectionId")
                    .and_then(Value::as_str)
                    .map(|id| format!("review-prompts:{id}")),
                _ => None,
            };
            publisher.push(Push {
                message: json!({"review": push}),
                key,
                connection_id: None,
                connection_generation: None,
                socket_id: None,
                session_id: None,
            });
        });
        let service = ReviewService::new(ReviewServiceOptions {
            storage,
            publish,
            host: Arc::new(ReverseHost {
                cx: cx.clone(),
                agents: self.agents.clone(),
            }),
            clock: cx.clock.clone(),
            session_limit: None,
            retry_delay_ms: None,
            delivery_delay_ms: None,
            agent_search_ms: None,
        });
        // Images of reviews discarded before.
        let live: std::collections::HashSet<String> = service
            .list(&json!({}))
            .into_iter()
            .map(|snapshot| snapshot.session.id)
            .collect();
        roamgate_review::images::prune_review_images(&directory, &live);
        Ok(service)
    }

    async fn connection(
        &self,
        cx: &FamilyContext,
        call: &IncomingCall,
    ) -> Result<ReverseConnection, RpcError> {
        let id = match &call.ctx.connection_id {
            Some(id) => id.clone(),
            // A legacy socket's call: the default connection's.
            None => cx
                .reverse("review.connection", json!({"op": "id"}))
                .await?
                .as_str()
                .unwrap_or("")
                .to_owned(),
        };
        Ok(ReverseConnection { cx: cx.clone(), id })
    }

    /// The front's own use of the service while the core owns it.
    async fn internal(&self, service: &ReviewService, params: &Value) -> ReviewResult<Value> {
        let asked = params.get("params").cloned().unwrap_or_else(|| json!({}));
        let text = |name: &str| {
            asked
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        fn value<T: serde::Serialize>(value: T) -> ReviewResult<Value> {
            serde_json::to_value(value).map_err(|e| ReviewError::status(e.to_string(), 500))
        }
        match params.get("method").and_then(Value::as_str).unwrap_or("") {
            "prompts.list" => Ok(json!(service.prompts().list(&text("connectionId")))),
            "prompts.answer" => Ok(json!(service.prompts().answer(
                &text("connectionId"),
                &text("id"),
                asked.get("answer").cloned().unwrap_or(Value::Null),
            ))),
            "addThread" => value(service.add_thread(&asked).await?),
            "replyInChat" => value(service.reply_in_chat(
                &text("chat"),
                &text("commentId"),
                &text("text"),
                &text("author"),
            )?),
            "requestAgentReview" => value(service.request_agent_review(&asked).await?),
            "remove" => service.remove(&asked),
            "roots" => Ok(json!(service.roots(&text("connectionId")))),
            "keptSteps" => Ok(json!(service.kept_steps(&text("root")))),
            "open" => value(service.open(&asked)?),
            "list" => value(service.list(&asked)),
            "moveThread" => value(service.move_thread(&asked)?),
            "setThreadAnchor" => value(service.set_thread_anchor(&asked)?),
            "edit" => value(service.edit(&asked).await?),
            "deleteComment" => service.delete_comment(&asked).await,
            // A headless claude's permission or question: answered by a
            // browser, or null. The prompt goes when the front stops asking.
            "prompts.request" => {
                let (asking, gone) = tokio::sync::oneshot::channel::<()>();
                let number = |name: &str| asked.get(name).and_then(Value::as_f64);
                let request = service.prompts().request(PermissionRequest {
                    connection_id: text("connectionId"),
                    pane_id: text("paneId"),
                    agent: text("agent"),
                    tool: text("tool"),
                    input: asked.get("input").cloned().unwrap_or(Value::Null),
                    can_always: asked.get("canAlways") == Some(&Value::Bool(true)),
                    questions: asked.get("questions").filter(|q| !q.is_null()).cloned(),
                    no_terminal: asked.get("noTerminal") == Some(&Value::Bool(true)),
                    timeout_ms: number("timeoutMs").unwrap_or(0.0).max(0.0) as u64,
                    cancel: Some(Box::pin(async move {
                        let _ = gone.await;
                    })),
                });
                let answer = tokio::spawn(request).await;
                drop(asking);
                Ok(answer.ok().flatten().unwrap_or(Value::Null))
            }
            method => Err(ReviewError::not_found(format!(
                "unknown review service method: {method}"
            ))),
        }
    }

    fn set_agents(&self, params: &Value) {
        if let Some(keys) = params.get("socket_keys").and_then(Value::as_array) {
            let mut sockets = self.sockets.lock().unwrap();
            sockets.wanted = keys
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            sockets.sync();
        }
        let mut agents = self.agents.lock().unwrap();
        if let Some(channels) = params.get("channels").and_then(Value::as_object) {
            agents.channels = channels
                .iter()
                .filter_map(|(id, on)| on.as_bool().map(|on| (id.clone(), on)))
                .collect();
        }
        if let Some(tools) = params.get("tools").and_then(Value::as_array) {
            agents.tools = tools
                .iter()
                .filter_map(|each| {
                    let connection = each.get("connection_id")?.as_str()?;
                    let pane = each.get("pane_id")?.as_str()?;
                    Some((
                        format!("{connection}\n{pane}"),
                        ModTools {
                            fresh_until: each.get("fresh_until")?.as_f64()? as i64,
                            work: each.get("work") == Some(&Value::Bool(true)),
                            rules: each.get("rules") == Some(&Value::Bool(true)),
                        },
                    ))
                })
                .collect();
        }
    }
}

/// An image as Bun's `serveReviewImage` sends it.
async fn image_response(directory: &Path, query: &str) -> HttpResponse {
    let not_found = || {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let _ = tx.try_send(b"not found".to_vec());
        HttpResponse {
            status: 404,
            headers: vec![("content-type".into(), "text/plain;charset=utf-8".into())],
            body: Some(rx),
        }
    };
    let Some((path, content_type, named)) = image_of_query(directory, query) else {
        return not_found();
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return not_found();
    };
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    let _ = tx.try_send(bytes);
    HttpResponse {
        status: 200,
        headers: vec![
            ("content-type".into(), content_type.into()),
            (
                "cache-control".into(),
                if named {
                    "private, no-cache"
                } else {
                    "private, max-age=31536000, immutable"
                }
                .into(),
            ),
            ("x-content-type-options".into(), "nosniff".into()),
            (
                "content-security-policy".into(),
                "default-src 'none'".into(),
            ),
        ],
        body: Some(rx),
    }
}

impl CoreFamily for ReviewFamily {
    fn name(&self) -> &'static str {
        FAMILY
    }

    fn call(&self, cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let this = self.clone();
        let cx = cx.clone();
        Box::pin(async move {
            let method = call.method.clone();
            match method.as_str() {
                // The Claude mod hub (families/claude_mod.rs).
                "internal.review.mod_take" => super::claude_mod::take(&cx),
                "internal.review.mod_flush" => Ok(super::claude_mod::flush()),
                "internal.review.mod_deliver" => super::claude_mod::deliver(&call.params),
                "internal.review.agents" => {
                    this.set_agents(&call.params);
                    Ok(json!({}))
                }
                // Bun is about to open reviews.sqlite again: the core's
                // service stops first.
                "internal.review.close" => {
                    this.sockets.lock().unwrap().stop();
                    let previous = this.slot.lock().unwrap().ready.take();
                    if let Some(previous) = previous {
                        let service = previous.borrow().clone();
                        if let Some(service) = service {
                            service.close();
                        }
                    }
                    Ok(json!({}))
                }
                "internal.review.call" => {
                    let service = this.service(&cx).await?;
                    roamgate_channel::core::note_served(&ProcessEnv, FAMILY, &method);
                    this.internal(&service, &call.params)
                        .await
                        .map_err(rpc_error)
                }
                // Configuration > Integrations: the mod on the host.
                "claude_mod.status" | "claude_mod.install" | "claude_mod.uninstall" => {
                    let connection = this.connection(&cx, &call).await?;
                    roamgate_channel::core::note_served(&ProcessEnv, FAMILY, &method);
                    claude_mod_call(&cx, &connection.id, &method["claude_mod.".len()..]).await
                }
                method if is_review_method(method) => {
                    let service = this.service(&cx).await?;
                    roamgate_channel::core::note_served(&ProcessEnv, FAMILY, method);
                    let connection = this.connection(&cx, &call).await?;
                    let answer = handle_review_rpc(
                        &service,
                        &connection,
                        &review_directory(&ProcessEnv),
                        method,
                        &call.params,
                    )
                    .await;
                    answered(method, answer)
                }
                _ => Err(unknown(&method)),
            }
        })
    }

    /// `review.get` written as text from the reviews' state; the rest as
    /// [`CoreFamily::call`] answers.
    fn call_reply(
        &self,
        cx: &FamilyContext,
        call: IncomingCall,
    ) -> BoxFuture<Result<Reply, RpcError>> {
        if call.method != "review.get" {
            let answer = self.call(cx, call);
            return Box::pin(async move { answer.await.map(Reply::Value) });
        }
        let this = self.clone();
        let cx = cx.clone();
        Box::pin(async move {
            let service = this.service(&cx).await?;
            roamgate_channel::core::note_served(&ProcessEnv, FAMILY, &call.method);
            let connection = this.connection(&cx, &call).await?;
            answered(
                &call.method,
                review_get_text(&service, &connection, &call.params),
            )
            .map(Reply::Text)
        })
    }

    fn http(
        &self,
        _cx: &FamilyContext,
        request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        Box::pin(async move {
            let path = path_of(&request.url);
            if path != "/api/review/image" || !request.method.eq_ignore_ascii_case("GET") {
                return Ok(HttpResponse::status(404));
            }
            roamgate_channel::core::note_served(&ProcessEnv, FAMILY, "GET /api/review/image");
            let query = request
                .url
                .split_once('?')
                .map(|(_, query)| query.split('#').next().unwrap_or(""))
                .unwrap_or("");
            Ok(image_response(&review_directory(&ProcessEnv), query).await)
        })
    }

    fn owned(&self, cx: &FamilyContext, owned: bool) {
        super::claude_mod::family_owned(cx, FAMILY, owned);
        // Its agent socket closes at once: Bun listens again after it
        // asked internal.review.close.
        self.sockets.lock().unwrap().stop();
        let mut slot = self.slot.lock().unwrap();
        slot.epoch += 1;
        let epoch = slot.epoch;
        if let Some(previous) = slot.ready.take() {
            let service = previous.borrow().clone();
            if let Some(service) = service {
                service.close();
            }
        }
        if !owned {
            return;
        }
        let (ready, receiver) = watch::channel(None);
        slot.ready = Some(receiver);
        let cx = cx.clone();
        let this = self.clone();
        tokio::spawn(async move {
            if this.slot.lock().unwrap().epoch != epoch {
                return;
            }
            match this.open_service(&cx) {
                Ok(service) => {
                    if this.slot.lock().unwrap().epoch != epoch {
                        service.close();
                        return;
                    }
                    // The agents' requests come here.
                    this.sockets.lock().unwrap().start(&cx, service.clone());
                    let _ = ready.send(Some(service));
                }
                Err(error) => {
                    tracing::warn!(scope = "review", error = %error, "reviews.sqlite not opened");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bun_hears_of_prompts_removals_and_work_reviews() {
        let prompts = json!({"type": "prompts", "connectionId": "c", "prompts": []});
        assert_eq!(for_bun(&prompts), Some(prompts.clone()));
        let work = json!({"type": "session", "snapshot": {
            "session": {"id": "s1", "target": {"kind": "work", "item": "i1"}},
            "threads": [{"id": "t"}],
        }});
        assert_eq!(
            for_bun(&work),
            Some(
                json!({"type": "session", "sessionId": "s1", "workItem": "i1", "threads": [{"id": "t"}]})
            )
        );
        let code = json!({"type": "session", "snapshot": {
            "session": {"id": "s2", "target": {"kind": "worktree"}}, "threads": [],
        }});
        assert_eq!(
            for_bun(&code),
            Some(json!({"type": "session", "sessionId": "s2"}))
        );
        assert_eq!(for_bun(&json!({"type": "open", "sessionId": "s"})), None);
    }

    #[test]
    fn a_gone_checkout_keeps_its_code() {
        let gone = load_error(RpcError::with_code("gone", "checkout-gone"));
        assert_eq!(
            gone,
            LoadError::Gone {
                code: "checkout-gone".into(),
                message: "gone".into()
            }
        );
        assert_eq!(
            load_error(RpcError::new("no")),
            LoadError::Failed("no".into())
        );
        assert_eq!(
            review_error(RpcError::with_code("full", "quota")).status,
            413
        );
    }

    #[test]
    fn ranger_chats_are_told_their_tool() {
        assert!(ranger_chat("ranger:abc"));
        assert!(!ranger_chat("ranger:"));
        assert!(!ranger_chat("claude-1"));
    }
}
