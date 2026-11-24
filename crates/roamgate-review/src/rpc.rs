//! The browser's review calls for one connection (review/rpc.ts). The
//! browser always writes as the user; agents come through their own socket
//! and sign with their name.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::error::{ReviewError, ReviewResult};
use crate::images::save_review_image;
use crate::js::{len16, slice16};
use crate::list_since::{list_reviews_since, list_summaries_since};
use crate::model::{
    REVIEW_SNAPSHOTS_MAX, REVIEW_SUMMARIES_VERSION, REVIEW_USER, ReviewSnapshot, ReviewTarget,
};
use crate::parse::{is_host_path, parse_review_target};
use crate::rendered_target::rendered_file_target;
use crate::service::ReviewService;

pub type RpcFut<T> = Pin<Box<dyn Future<Output = ReviewResult<T>> + Send>>;

/// The largest SVG shown as a page (http/rendered-pages.ts).
pub const RENDERED_SVG_MAX_BYTES: usize = 2 * 1024 * 1024;
/// A page's stored key and value, in UTF-16 units (shared/renderedPage.ts).
pub const RENDERED_STORAGE_MAX_CHARS: usize = 256 * 1024;

/// What a browser's connection gives the calls (`ReviewRpcConnection`).
/// The optional capabilities of TS are the `can_*` flags; asked without
/// one, an operation fails.
#[allow(unused_variables)]
pub trait ReviewRpcConnection: Send + Sync {
    fn id(&self) -> &str;
    fn resolve_root(&self, workspace_id: &str) -> RpcFut<String>;
    fn can_read_default_base(&self) -> bool {
        false
    }
    fn read_default_base(&self, root: &str) -> RpcFut<String> {
        missing()
    }
    fn can_read_root(&self) -> bool {
        false
    }
    /// The repository of a directory.
    fn read_root(&self, path: &str) -> RpcFut<String> {
        missing()
    }
    fn can_scan_repos(&self) -> bool {
        false
    }
    fn scan_repos(&self, paths: Vec<String>, agent_paths: Vec<String>) -> RpcFut<Value> {
        missing()
    }
    fn can_render_pages(&self) -> bool {
        false
    }
    /// Where the browser frames a rendered review's page (an HTML file, or
    /// a site): `page` is a path under the first one served.
    fn rendered_page(
        &self,
        root: &str,
        target: &ReviewTarget,
        page: Option<String>,
        scripts: bool,
    ) -> RpcFut<Value> {
        missing()
    }
    fn can_render_svg(&self) -> bool {
        false
    }
    /// One SVG as a static page in the sandbox.
    fn rendered_svg(&self, svg: &str, color: Option<String>, scripts: bool) -> RpcFut<Value> {
        missing()
    }
    fn can_store_rendered(&self) -> bool {
        false
    }
    /// A checked write (`parseStorageWrite`) of a listed site's page under
    /// its frame's token: false when the token is not a listed site's. A
    /// full site's storage fails with status 413.
    fn rendered_storage(&self, token: &str, write: Value) -> RpcFut<bool> {
        missing()
    }
    /// Forgets what a listed site's pages stored.
    fn clear_rendered_storage(&self, site: &str) -> RpcFut<()> {
        missing()
    }
}

fn missing<T: Send + 'static>() -> RpcFut<T> {
    Box::pin(async { Err(ReviewError::status("not available on this connection", 503)) })
}

const SESSION_METHODS: &[&str] = &[
    "review.get",
    "review.reanchor",
    "review.update",
    "review.remove",
    "review.diff",
    "review.state",
    "review.commits",
    "review.file",
    "review.thread.add",
    "review.thread.move",
    "review.thread.release",
    "review.reply",
    "review.edit",
    "review.delete",
    "review.resolve",
    "review.restore",
    "review.handoff",
    "review.retry",
    "review.gitlab.refresh",
    "review.gitlab.find",
    "review.gitlab.open",
    "review.gitlab.push",
    "review.adopt",
    "review.agent.review",
    "review.image.add",
];

/// Reads a scope's diff without a review (`target` instead of a session).
const PREVIEW_METHODS: &[&str] = &[
    "review.diff",
    "review.commits",
    "review.state",
    "review.file",
];

pub fn is_review_method(method: &str) -> bool {
    method.starts_with("review.")
}

/// The storage write a page asked for, or None (`parseStorageWrite`).
pub fn parse_storage_write(raw: Option<&Value>) -> Option<Value> {
    let write = raw?.as_object()?;
    let op = write.get("op");
    if op.and_then(Value::as_str) == Some("clear") {
        return Some(json!({"op": "clear"}));
    }
    let key = write.get("key")?.as_str()?;
    let key_len = len16(key);
    if key_len == 0 || key_len > RENDERED_STORAGE_MAX_CHARS {
        return None;
    }
    match op.and_then(Value::as_str) {
        Some("remove") => Some(json!({"op": "remove", "key": key})),
        Some("set") => {
            let value = write.get("value")?.as_str()?;
            (key_len + len16(value) <= RENDERED_STORAGE_MAX_CHARS)
                .then(|| json!({"op": "set", "key": key, "value": value}))
        }
        _ => None,
    }
}

fn to_json<T: Serialize>(value: T) -> ReviewResult<Value> {
    serde_json::to_value(value).map_err(|error| ReviewError::status(error.to_string(), 500))
}

/// The first of two fields that is neither missing nor null (`a ?? b`).
fn either<'a>(raw: &'a Value, a: &str, b: &str) -> Option<&'a Value> {
    raw.get(a)
        .filter(|v| !v.is_null())
        .or_else(|| raw.get(b))
        .filter(|v| !v.is_null())
}

/// `{...params, key: raw[from]}`: set, or gone when undefined.
fn with(params: &Value, key: &str, value: Option<&Value>) -> Value {
    let mut map = params.as_object().cloned().unwrap_or_default();
    match value {
        Some(value) => {
            map.insert(key.into(), value.clone());
        }
        None => {
            map.shift_remove(key);
        }
    }
    Value::Object(map)
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn workspace_id(raw: &Value) -> ReviewResult<String> {
    non_empty_str(raw.get("workspace_id"))
        .map(str::to_owned)
        .ok_or_else(|| ReviewError::new("workspace_id is required"))
}

async fn root_of(
    connection: &dyn ReviewRpcConnection,
    path: &str,
    workspace_id: &str,
) -> ReviewResult<String> {
    if is_host_path(path) && connection.can_read_root() {
        return connection.read_root(path).await;
    }
    connection.resolve_root(workspace_id).await
}

async fn rendered_place(
    connection: &dyn ReviewRpcConnection,
    file: &str,
) -> ReviewResult<(String, ReviewTarget)> {
    rendered_file_target(
        |directory| async move {
            connection
                .read_root(&directory)
                .await
                .map_err(|error| error.message)
        },
        file,
        "",
    )
    .await
}

/// `review.get` as [`handle_review_rpc`] answers it, written as text from
/// the reviews' state (no copy of its threads, no pass through a
/// [`Value`]).
pub fn review_get_text(
    service: &ReviewService,
    connection: &dyn ReviewRpcConnection,
    raw: &Value,
) -> ReviewResult<Box<serde_json::value::RawValue>> {
    let session_id = either(raw, "session_id", "sessionId");
    service.get_text(&json!({"sessionId": session_id}), connection.id())
}

/// A browser's review call on its connection (`handleReviewRpc`).
/// `images` is the reviews' directory, where pasted images go.
pub async fn handle_review_rpc(
    service: &ReviewService,
    connection: &dyn ReviewRpcConnection,
    images: &Path,
    method: &str,
    raw: &Value,
) -> ReviewResult<Value> {
    let raw = if raw.is_object() {
        raw.clone()
    } else {
        Value::Object(Map::new())
    };
    let mut params = with(&raw, "author", Some(&json!(REVIEW_USER)));
    let session_id = either(&raw, "session_id", "sessionId").cloned();
    // A scope Changes shows with no review yet: its commits and diffs,
    // read only.
    if PREVIEW_METHODS.contains(&method) && session_id.is_none() && raw.get("target").is_some() {
        let workspace = workspace_id(&raw)?;
        // The checkout's directory (`path` is a file's, for review.file).
        let checkout = raw.get("checkout").and_then(Value::as_str).unwrap_or("");
        let root = root_of(connection, checkout, &workspace).await?;
        let preview = with(&params, "connectionId", Some(&json!(connection.id())));
        let preview = with(&preview, "root", Some(&json!(root)));
        return match method {
            "review.commits" => service.preview_commits(&preview).await,
            "review.diff" => service.preview_diff(&preview).await,
            "review.file" => service.preview_file(&preview).await,
            _ => service.preview_state(&preview).await,
        };
    }
    let session_param = json!({"sessionId": session_id});
    if SESSION_METHODS.contains(&method) {
        let snapshot = service.get(&session_param)?;
        if snapshot.session.connection_id != connection.id() {
            return Err(ReviewError::not_found("no such review"));
        }
        params = with(&params, "sessionId", Some(&json!(snapshot.session.id)));
    }
    if let Some(comment) = either(&raw, "comment_id", "commentId") {
        params = with(&params, "commentId", Some(comment));
    }
    // Ids the browser made, so a write sent twice is made once.
    if let Some(id) = raw.get("new_comment_id") {
        params = with(&params, "newCommentId", Some(id));
    }
    if let Some(id) = raw.get("new_thread_id") {
        params = with(&params, "newThreadId", Some(id));
    }
    let listed = json!({"connectionId": connection.id(), "chats": true});

    match method {
        "review.list" => {
            // A page asks for summaries; one from before gets them whole.
            if raw.get("summaries").and_then(Value::as_f64) == Some(REVIEW_SUMMARIES_VERSION as f64)
            {
                let summaries: Vec<(String, _)> = service
                    .summaries(&listed)
                    .into_iter()
                    .map(|summary| {
                        let id = summary.session["id"].as_str().unwrap_or("").to_owned();
                        (id, summary)
                    })
                    .collect();
                let mut answer =
                    list_summaries_since(&summaries, raw.get("known"), raw.get("limit"));
                answer["version"] = json!(REVIEW_SUMMARIES_VERSION);
                return Ok(answer);
            }
            let snapshots: Vec<(String, ReviewSnapshot)> = service
                .list(&listed)
                .into_iter()
                .map(|snapshot| (snapshot.session.id.clone(), snapshot))
                .collect();
            Ok(list_reviews_since(
                &snapshots,
                raw.get("known"),
                raw.get("limit"),
            ))
        }
        "review.snapshots" => {
            // The whole reviews a page shows, by id: one gone, or of
            // another connection, is named in `missing`.
            let mut ids: Vec<String> = Vec::new();
            if let Some(list) = raw.get("ids").and_then(Value::as_array) {
                for id in list.iter().filter_map(Value::as_str) {
                    if !ids.iter().any(|seen| seen == id) {
                        ids.push(id.to_owned());
                    }
                }
            }
            ids.truncate(REVIEW_SNAPSHOTS_MAX);
            let mut snapshots = Vec::new();
            let mut missing = Vec::new();
            for id in ids {
                match service.get(&json!({"sessionId": id})) {
                    Ok(snapshot) if snapshot.session.connection_id != connection.id() => {
                        missing.push(id)
                    }
                    Ok(mut snapshot) => {
                        if snapshot.shared.is_some()
                            && !matches!(snapshot.session.target, ReviewTarget::Rendered { .. })
                        {
                            snapshot.shared = None;
                        }
                        snapshots.push(snapshot);
                    }
                    Err(_) => missing.push(id),
                }
            }
            Ok(json!({"snapshots": to_json(snapshots)?, "missing": missing}))
        }
        "review.activity" => {
            let mut asked = json!({"connectionId": connection.id()});
            if let Some(ids) = raw.get("session_ids") {
                asked["sessionIds"] = ids.clone();
            }
            service.activity(&asked).await
        }
        "review.import" => to_json(service.import_session(&json!({
            "connectionId": connection.id(),
            "snapshot": raw.get("snapshot").cloned().unwrap_or(Value::Null),
        }))?),
        "review.open" => open(service, connection, &raw).await,
        "review.repos" => {
            // The repositories under the given directories that have changes.
            let strings = |value: Option<&Value>| -> Vec<String> {
                value
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let repos = if connection.can_scan_repos() {
                connection
                    .scan_repos(strings(raw.get("paths")), strings(raw.get("agent_paths")))
                    .await?
            } else {
                json!([])
            };
            Ok(json!({"repos": repos}))
        }
        "review.get" => to_json(service.get(&params)?),
        // The Files preview read a file again: its threads follow it.
        "review.reanchor" => to_json(
            service
                .reanchor_file(&with(&params, "path", raw.get("path")))
                .await?,
        ),
        "review.update" => to_json(
            service
                .update(&with(&params, "paneId", raw.get("agent_pane")))
                .await?,
        ),
        // Its pasted images stay until the bridge next starts, so the
        // list's undo brings the review back whole.
        "review.remove" => service.remove(&params),
        "review.image.add" => {
            // A pasted image: its path goes in the comment's Markdown.
            let data = raw.get("data").and_then(Value::as_str).unwrap_or("");
            let kind = match raw.get("type") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
            };
            let bytes = decode_base64(data);
            let session = params["sessionId"].as_str().unwrap_or("").to_owned();
            let path = save_review_image(images, &session, &kind, &bytes)?;
            Ok(json!({"path": path.to_string_lossy()}))
        }
        "review.rendered.storage" => {
            let write = parse_storage_write(raw.get("write"));
            let token = raw.get("token").and_then(Value::as_str);
            let (true, Some(token), Some(write)) = (connection.can_store_rendered(), token, write)
            else {
                return Err(ReviewError::new("invalid storage write"));
            };
            match connection.rendered_storage(token, write).await {
                Ok(stored) => Ok(json!({"stored": stored})),
                Err(error) if error.status == 413 => {
                    Err(ReviewError::status("the site's storage is full", 413))
                }
                Err(error) => Err(error),
            }
        }
        "review.rendered.storage.clear" => {
            let site = raw.get("site").and_then(Value::as_str);
            let (true, Some(site)) = (connection.can_store_rendered(), site) else {
                return Err(ReviewError::new("invalid site"));
            };
            connection.clear_rendered_storage(site).await?;
            Ok(json!({"cleared": true}))
        }
        "review.rendered.page" => rendered_page(service, connection, &raw, session_id).await,
        "review.diff" => service.diff(&params).await,
        "review.state" => service.state(&params).await,
        "review.commits" => service.commits(&params).await,
        "review.file" => service.file(&params).await,
        "review.thread.add" => to_json(service.add_thread(&params).await?),
        "review.thread.move" => to_json(service.move_held(&params)?),
        "review.thread.release" => to_json(service.release_held(&params)?),
        "review.reply" => to_json(service.reply(&params).await?),
        "review.edit" => to_json(service.edit(&params).await?),
        "review.delete" => service.delete_comment(&params).await,
        "review.resolve" => to_json(service.resolve(&params)?),
        "review.restore" => to_json(service.restore_thread(&params)?),
        "review.handoff" => to_json(service.handoff(&params).await?),
        "review.retry" => to_json(service.retry(&params).await?),
        // The connection's agents waiting on a permission answer.
        "review.prompts" => Ok(json!({"prompts": service.prompts().list(connection.id())})),
        "review.prompt.answer" => prompt_answer(service, connection, &raw),
        "review.gitlab.refresh" => to_json(service.refresh_gitlab(&params).await?),
        // Reads only: the branch's merge request, to offer its review.
        "review.gitlab.find" => service.find_gitlab(&params).await,
        // The review of the branch's merge request; `url`: the one the
        // user picked (Changes' card's remote).
        "review.gitlab.open" => {
            let asked = match raw.get("url") {
                Some(url) => with(&params, "url", Some(url)),
                None => params,
            };
            service.open_gitlab(&asked).await
        }
        "review.gitlab.push" => to_json(service.push_local_drafts(&params).await?),
        // The user's click: an agent's thread becomes their forge draft.
        "review.adopt" => {
            let asked = with(&params, "threadId", raw.get("thread_id"));
            let asked = with(&asked, "text", raw.get("text"));
            to_json(service.adopt_thread(&asked).await?)
        }
        "review.agent.review" => {
            let asked = with(&params, "paneId", raw.get("pane_id"));
            let asked = with(&asked, "agent", raw.get("agent"));
            let asked = with(&asked, "author", None);
            to_json(service.request_agent_review(&asked).await?)
        }
        _ => Err(ReviewError::not_found(format!(
            "unknown review method: {method}"
        ))),
    }
}

/// `Buffer.from(data, "base64")`: lenient, the URL alphabet too, padding
/// or not, stopping at the first character of neither.
fn decode_base64(data: &str) -> Vec<u8> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    let mut clean: String = data
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
        .collect();
    // A lone last character makes no byte.
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(clean).unwrap_or_default()
}

async fn open(
    service: &ReviewService,
    connection: &dyn ReviewRpcConnection,
    raw: &Value,
) -> ReviewResult<Value> {
    let workspace = workspace_id(raw)?;
    // A directory picks one of the workspace's repositories; else the
    // workspace's own.
    let path = raw.get("path").and_then(Value::as_str).unwrap_or("");
    if !path.is_empty() && !is_host_path(path) {
        return Err(ReviewError::new(format!(
            "the review's path must be absolute, not \"{}\"",
            slice16(path, 0, Some(200))
        )));
    }
    // With its title and the workspace's agent, so comments can go to it
    // from the start.
    let opened = |root: String, target: Value, automatic: Option<bool>| {
        let mut asked = json!({
            "connectionId": connection.id(),
            "workspaceId": workspace,
            "root": root,
            "target": target,
        });
        if let Some(automatic) = automatic {
            asked["automatic"] = json!(automatic);
        }
        for (key, from) in [
            ("title", "title"),
            ("agent", "agent"),
            ("paneId", "agent_pane"),
        ] {
            if let Some(value) = raw.get(from) {
                asked[key] = value.clone();
            }
        }
        asked["raise"] = json!(false);
        service.open(&asked).and_then(to_json)
    };
    let asked = raw.get("target");
    let kind = asked.and_then(|t| t.get("kind")).and_then(Value::as_str);
    // A chat has no repository: its agent's directory names it.
    if kind == Some("chat") {
        let root = if path.is_empty() { "/" } else { path };
        return opened(root.into(), asked.cloned().unwrap_or(Value::Null), None);
    }
    // A site has no checkout.
    if kind == Some("rendered") && asked.is_some_and(|t| t.get("url").is_some()) {
        return opened("/".into(), asked.cloned().unwrap_or(Value::Null), None);
    }
    // A file to discuss, rendered: its checkout and path in it.
    if kind == Some("rendered")
        && let Some(file) = raw.get("file").and_then(Value::as_str)
        && connection.can_read_root()
    {
        let (root, target) = rendered_place(connection, file).await?;
        return opened(root, target.to_value(), None);
    }
    let root = root_of(connection, path, &workspace).await?;
    // Without a target the branch is reviewed against the default branch;
    // without one (nothing committed yet), the uncommitted work.
    // `None`: no reads; `Some(None)`: no default branch.
    let default_base: Option<Option<String>> = if connection.can_read_default_base() {
        Some(connection.read_default_base(&root).await.ok())
    } else {
        None
    };
    // A branch (`head`, a work item's branch link): against the default
    // branch.
    if raw.get("target").is_none()
        && let Some(head) = raw.get("head").and_then(Value::as_str)
    {
        let head = crate::js::trim(head);
        if head.is_empty() || head.starts_with('-') {
            return Err(ReviewError::new("head must be a branch name"));
        }
        let Some(Some(base)) =
            default_base.filter(|base| base.as_ref().is_some_and(|b| !b.is_empty()))
        else {
            return Err(ReviewError::new(
                "the repository has no default branch to compare the branch to",
            ));
        };
        return opened(
            root,
            json!({"kind": "range", "base": base, "head": head}),
            None,
        );
    }
    let asked_target = raw.get("target").filter(|target| !target.is_null());
    let target = match asked_target {
        Some(target) => target.clone(),
        None => match &default_base {
            Some(None) => json!({"kind": "worktree"}),
            Some(Some(base)) if !base.is_empty() => {
                json!({"kind": "range", "base": base, "head": "HEAD"})
            }
            _ => Value::Null,
        },
    };
    let automatic = !raw.get("target").is_some_and(truthy)
        && matches!(&default_base, Some(Some(base)) if !base.is_empty());
    opened(root, target, Some(automatic))
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

async fn rendered_page(
    service: &ReviewService,
    connection: &dyn ReviewRpcConnection,
    raw: &Value,
    session_id: Option<Value>,
) -> ReviewResult<Value> {
    let unavailable = || ReviewError::status("pages cannot be shown here", 503);
    // A page shown in the Files preview, which may have no review yet.
    if !connection.can_render_pages() {
        return Err(unavailable());
    }
    let page = match raw.get("page") {
        None => None,
        Some(Value::String(page)) if len16(page) <= 2048 => Some(page.clone()),
        Some(_) => return Err(ReviewError::new("invalid page")),
    };
    if let Some(svg) = raw.get("svg").and_then(Value::as_str) {
        if svg.len() > RENDERED_SVG_MAX_BYTES {
            return Err(ReviewError::new("that SVG is too large to draw here"));
        }
        let color = raw.get("color").and_then(Value::as_str).map(str::to_owned);
        // Only the browser calls this: asked for by the user, never an agent.
        let scripts = raw.get("scripts") == Some(&Value::Bool(true));
        if !connection.can_render_svg() {
            return Err(unavailable());
        }
        return connection.rendered_svg(svg, color, scripts).await;
    }
    let (root, target) = if let Some(id) = session_id {
        let snapshot = service.get(&json!({"sessionId": id}))?;
        if snapshot.session.connection_id != connection.id() {
            return Err(ReviewError::not_found("no such review"));
        }
        (snapshot.session.root, snapshot.session.target)
    } else if let Some(file) = raw.get("file").and_then(Value::as_str)
        && connection.can_read_root()
    {
        rendered_place(connection, file).await?
    } else {
        ("/".to_owned(), parse_review_target(raw.get("target"))?)
    };
    if !matches!(target, ReviewTarget::Rendered { .. }) {
        return Err(ReviewError::new("not a rendered review"));
    }
    let scripts = raw.get("scripts") == Some(&Value::Bool(true));
    let page = page.filter(|page| !page.is_empty());
    connection
        .rendered_page(&root, &target, page, scripts)
        .await
}

fn prompt_answer(
    service: &ReviewService,
    connection: &dyn ReviewRpcConnection,
    raw: &Value,
) -> ReviewResult<Value> {
    let id = match raw.get("id") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(id)) => id.clone(),
        Some(other) => other.to_string(),
    };
    let prompts = service.prompts();
    // "In the terminal": the hook gives up, Claude Code asks there.
    if raw.get("release") == Some(&Value::Bool(true)) {
        return Ok(json!({"answered": prompts.release(connection.id(), &id)}));
    }
    // Questions are answered with each question's chosen option(s).
    if let Some(answers) = raw.get("answers").and_then(Value::as_object) {
        let mut clean = Map::new();
        for (question, value) in answers {
            if let Some(value) = value.as_str() {
                clean.insert(question.clone(), json!(slice16(value, 0, Some(4000))));
            }
        }
        return Ok(json!({
            "answered": prompts.answer(connection.id(), &id, json!({"answers": clean})),
        }));
    }
    let answer = raw.get("answer").and_then(Value::as_str);
    match answer {
        Some(answer @ ("allow" | "always" | "deny" | "dismiss")) => Ok(json!({
            "answered": prompts.answer(connection.id(), &id, json!(answer)),
        })),
        _ => Err(ReviewError::new(
            "answer must be allow, always, deny or dismiss",
        )),
    }
}

#[cfg(test)]
mod tests;
