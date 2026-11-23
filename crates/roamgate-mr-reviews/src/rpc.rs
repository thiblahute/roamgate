//! `bridge.mr_reviews.*` (`mr-reviews/rpc.ts`): the reviews inbox for
//! every browser. Reads and the user's own marks (seen, feedback, pins,
//! removals, order, overrides, views, settings); nothing here writes to a
//! forge. The other methods (open, checkout, Claude, efforts...) go to
//! [`MrReviewsRpcDeps::more`], module.ts's dispatch, until those are ported.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_base::settings::sections::{
    MAX_HIDDEN, MAX_PINNED, MAX_UNSENT, MAX_UPSTREAM_GROUPS, MAX_UPSTREAM_SKIP,
    MAX_UPSTREAM_WORKSPACES, MAX_VIEWS, VIEW_NAME_MAX, VIEW_QUERY_MAX, parse_workspace_ref,
    view_name,
};
use serde_json::{Value, json};

use crate::agent_search::{RequestRef, parse_request_ref};
use crate::connection::BoxFuture;
use crate::inbox::{GetOptions, MrInbox, SettingsFn, key_of, list, truthy};
use crate::order::{ChangeMeta, MrOrder, SaveFn, order_version};
use crate::overrides::{self, Change, FIELDS, apply_override, same_override};
use crate::settings::{
    mr_reviews_settings, normalize_stored_mr_reviews, stored_merge_of, stored_mr_reviews,
};
use crate::shared::order::OrderOp;
use crate::shared::types::{
    activity_marker, forge_ref_key, forge_ref_label, parse_whose, same_upstream_workspace,
    workspace_ref_key,
};

/// A refused call: `MrReviewsError` (its message and code, `invalid` by
/// default), or any other failure (a save that could not be written).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcError {
    Reviews { message: String, code: String },
    Failed(String),
}

impl RpcError {
    pub fn invalid(message: impl Into<String>) -> RpcError {
        RpcError::with_code(message, "invalid")
    }

    pub fn with_code(message: impl Into<String>, code: &str) -> RpcError {
        RpcError::Reviews {
            message: message.into(),
            code: code.into(),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            RpcError::Reviews { message, .. } | RpcError::Failed(message) => message,
        }
    }

    /// The code of an `MrReviewsError`, None for other failures.
    pub fn code(&self) -> Option<&str> {
        match self {
            RpcError::Reviews { code, .. } => Some(code),
            RpcError::Failed(_) => None,
        }
    }
}

impl From<String> for RpcError {
    fn from(message: String) -> RpcError {
        RpcError::Failed(message)
    }
}

pub type RpcResult<T> = Result<T, RpcError>;

/// The rest of the methods (open, checkout, Claude), when set up.
pub type MoreFn = Arc<dyn Fn(String, Obj) -> BoxFuture<'static, RpcResult<Value>> + Send + Sync>;

/// What the methods need (`MrReviewsRpcDeps`).
#[derive(Clone)]
pub struct MrReviewsRpcDeps {
    pub inbox: MrInbox,
    pub settings: SettingsFn,
    /// Saves new settings (settings.json `mr_reviews`), returns them.
    pub save_settings: SaveFn,
    /// The user's order of the inbox; its [`MrOrder::edit`] runs the
    /// settings changes one at a time.
    pub order: Arc<MrOrder>,
    /// The Headed upstream marks changed: the branches are read again.
    pub upstream_changed: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
    /// The Workspaces tree (`{nodes: [...]}`): whether a workspace is in a
    /// group headed upstream. Without it, a workspace marked by itself is
    /// unmarked and any other is taken to be in such a group.
    pub tree: Option<Arc<dyn Fn() -> BoxFuture<'static, Option<Value>> + Send + Sync>>,
    pub more: Option<MoreFn>,
}

pub fn is_mr_reviews_method(method: &str) -> bool {
    method.starts_with("bridge.mr_reviews.")
}

/// `params.key`: required, at most 600 characters.
pub fn key(params: &Obj) -> RpcResult<String> {
    match params.get("key") {
        Some(Value::String(value)) if !value.is_empty() && js::len16(value) <= 600 => {
            Ok(value.clone())
        }
        _ => Err(RpcError::invalid("key is required")),
    }
}

/// Who is changing the view: the agent says so, and in a few words what.
pub fn change(params: &Obj) -> ChangeMeta {
    if params.get("by").and_then(Value::as_str) != Some("agent") {
        return ChangeMeta::user();
    }
    ChangeMeta {
        by: "agent".into(),
        // What an agent changes, the user can take back.
        undoable: true,
        summary: params
            .get("summary")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| js::head16(s, 200)),
    }
}

/// A request named by key, reference or URL, for a dependency: one of the
/// list's, or any request on the user's hosts.
pub fn request_key(value: &str, items: &[Obj], hosts: &[Value]) -> RpcResult<String> {
    let text = js::trim(value);
    if items.iter().any(|item| key_of(item) == text) {
        return Ok(text.to_owned());
    }
    match parse_request_ref(text, items, hosts) {
        None => Err(RpcError::invalid(format!(
            "\"{}\" names no request: use its URL or project!123.",
            js::head16(text, 100)
        ))),
        Some(RequestRef::Ambiguous(found)) => Err(RpcError::invalid(format!(
            "\"{}\" fits several requests: {}.",
            js::head16(text, 100),
            found
                .iter()
                .map(|item| forge_ref_label(item, false))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
        Some(RequestRef::Ref(found)) => Ok(found.key()),
    }
}

fn all_strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// An override change from a page or a tool, checked (`overrideChange`).
pub fn override_change(
    params: &Obj,
    resolve: &dyn Fn(&str) -> RpcResult<String>,
) -> RpcResult<Change> {
    let mut out = Change::default();
    let mut has_set = false;
    if let Some(set) = params.get("set") {
        let Some(value) = set.as_object() else {
            return Err(RpcError::invalid("set must be an object"));
        };
        for name in value.keys() {
            if !FIELDS.contains(&name.as_str()) {
                return Err(RpcError::invalid(format!(
                    "unknown field {name}: {}",
                    FIELDS.join(", ")
                )));
            }
        }
        let mut fields = Obj::new();
        if let Some(whose) = value.get("whose") {
            let parsed = match whose {
                Value::String(text) => parse_whose(text),
                Value::Object(person) => parse_whose(
                    &person
                        .get("person")
                        .map_or_else(|| "undefined".to_owned(), js::to_text),
                ),
                _ => None,
            };
            let Some(parsed) = parsed else {
                return Err(RpcError::invalid(
                    "whose is me, reviewer, external or a person's user name",
                ));
            };
            fields.insert("whose".into(), parsed);
        }
        if let Some(next) = value.get("next") {
            if !next.is_string() {
                return Err(RpcError::invalid("next must be text"));
            }
            fields.insert("next".into(), next.clone());
        }
        if let Some(depends) = value.get("dependsOn") {
            let Some(depends) = all_strings(depends) else {
                return Err(RpcError::invalid("dependsOn must be a list of requests"));
            };
            let keys = depends
                .iter()
                .map(|each| resolve(each))
                .collect::<RpcResult<Vec<String>>>()?;
            fields.insert("dependsOn".into(), json!(keys));
        }
        if let Some(labels) = value.get("labels") {
            let Some(labels) = all_strings(labels) else {
                return Err(RpcError::invalid("labels must be a list of words"));
            };
            fields.insert("labels".into(), json!(labels));
        }
        if let Some(link) = value.get("link") {
            if !link.is_string() {
                return Err(RpcError::invalid("link must be a URL or a path"));
            }
            fields.insert("link".into(), link.clone());
        }
        if let Some(stale) = value.get("stale") {
            if !stale.is_boolean() {
                return Err(RpcError::invalid("stale must be true or false"));
            }
            fields.insert("stale".into(), stale.clone());
        }
        out.set = fields;
        has_set = true;
    }
    match params.get("clear") {
        None => {}
        Some(Value::String(all)) if all == "all" => out.clear = Some(None),
        Some(clear) => {
            let fields = all_strings(clear)
                .filter(|names| names.iter().all(|n| FIELDS.contains(&n.as_str())))
                .ok_or_else(|| {
                    RpcError::invalid(format!(
                        "clear is \"all\" or fields among {}",
                        FIELDS.join(", ")
                    ))
                })?;
            out.clear = Some(Some(fields));
        }
    }
    if !has_set && out.clear.is_none() {
        return Err(RpcError::invalid("set or clear is required"));
    }
    Ok(out)
}

const ORDER_OPS: [&str; 5] = ["top", "bottom", "before", "after", "arrange"];

/// An order operation from a page: keys, and a target for before / after.
pub fn order_operation(params: &Obj) -> RpcResult<OrderOp> {
    let op = params.get("op").and_then(Value::as_str).unwrap_or("");
    let keys = params.get("keys").and_then(all_strings).filter(|keys| {
        !keys.is_empty()
            && keys.len() <= 500
            && keys.iter().all(|k| !k.is_empty() && js::len16(k) <= 600)
    });
    let (true, Some(keys)) = (ORDER_OPS.contains(&op), keys) else {
        return Err(RpcError::invalid(
            "op (top, bottom, before, after, arrange) and keys are required",
        ));
    };
    if op == "before" || op == "after" {
        let target = match params.get("target") {
            Some(Value::String(t)) if !t.is_empty() && js::len16(t) <= 600 => t.clone(),
            _ => return Err(RpcError::invalid("target is required")),
        };
        return Ok(if op == "before" {
            OrderOp::Before(keys, target)
        } else {
            OrderOp::After(keys, target)
        });
    }
    Ok(match op {
        "top" => OrderOp::Top(keys),
        "bottom" => OrderOp::Bottom(keys),
        _ => OrderOp::Arrange(keys),
    })
}

static GROUP_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("pattern"));
static WEB_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").expect("pattern"));

/// `workspaceTreeAncestors`: a node and its parents, by id, cycles cut.
fn tree_ancestors(tree: &Value, id: Option<&str>) -> Vec<String> {
    let nodes = list(tree.get("nodes"));
    let mut out: Vec<String> = Vec::new();
    let mut cursor = id.map(str::to_owned);
    while let Some(at) = cursor.filter(|c| !c.is_empty() && !out.contains(c)) {
        let Some(node) = nodes.iter().find(|n| js::sv(n.get("id")) == at) else {
            break;
        };
        out.push(at);
        cursor = node
            .get("parent")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    out
}

fn obj_of(value: &Value) -> Obj {
    value.as_object().cloned().unwrap_or_default()
}

fn with_version(changed: bool, version: i64) -> Obj {
    let mut out = Obj::new();
    out.insert("changed".into(), json!(changed));
    out.insert("version".into(), json!(version));
    out
}

fn answer(head: Vec<(&str, Value)>, rest: Obj) -> Value {
    let mut out: Obj = head.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    for (k, v) in rest {
        out.insert(k, v);
    }
    Value::Object(out)
}

impl MrReviewsRpcDeps {
    async fn settings(&self) -> Obj {
        (self.settings)().await
    }

    async fn save(&self, next: Obj, meta: ChangeMeta) -> RpcResult<Obj> {
        Ok((self.save_settings)(next, meta).await?)
    }
}

/// `handleMrReviewsRpc`.
pub async fn handle_mr_reviews_rpc(
    deps: &MrReviewsRpcDeps,
    method: &str,
    params: &Obj,
) -> RpcResult<Value> {
    match method {
        "bridge.mr_reviews.inbox" => Ok(Value::Object(
            deps.inbox
                .get(GetOptions {
                    fresh: params.get("fresh") == Some(&json!(true)),
                    viewer: params.get("viewer") != Some(&json!(false)),
                })
                .await,
        )),
        "bridge.mr_reviews.seen" => Ok(json!({"ok": deps.inbox.mark_seen(&key(params)?)})),
        "bridge.mr_reviews.feedback" => {
            let verdict = match params.get("verdict") {
                Some(Value::Null) => None,
                Some(Value::String(v)) if v == "not_interested" || v == "more_like_this" => {
                    Some(v.as_str())
                }
                _ => {
                    return Err(RpcError::invalid(
                        "verdict must be not_interested, more_like_this or null",
                    ));
                }
            };
            Ok(json!({"ok": deps.inbox.feedback(&key(params)?, verdict)}))
        }
        "bridge.mr_reviews.pin" => pin(deps, params).await,
        "bridge.mr_reviews.unpin" => {
            let target = key(params)?;
            deps.order
                .edit(async {
                    let mut next = deps.settings().await;
                    let pinned: Vec<Value> = list(next.get("pinned"))
                        .iter()
                        .filter(|each| forge_ref_key(&obj_of(each)) != target)
                        .cloned()
                        .collect();
                    next.insert("pinned".into(), Value::Array(pinned));
                    deps.save(next, change(params)).await
                })
                .await?;
            deps.inbox.changed();
            Ok(json!({"ok": true}))
        }
        "bridge.mr_reviews.hide" => {
            // Out of the view: a pinned request is unpinned, any other one
            // stays out until something happens on it.
            let target = key(params)?;
            let action = deps
                .order
                .edit(async {
                    let mut next = deps.settings().await;
                    let pinned = list(next.get("pinned")).to_vec();
                    if pinned
                        .iter()
                        .any(|each| forge_ref_key(&obj_of(each)) == target)
                    {
                        let kept: Vec<Value> = pinned
                            .into_iter()
                            .filter(|each| forge_ref_key(&obj_of(each)) != target)
                            .collect();
                        next.insert("pinned".into(), Value::Array(kept));
                        deps.save(next, change(params)).await?;
                        return Ok("unpinned");
                    }
                    let Some(item) = deps.inbox.item(&target) else {
                        return Err(RpcError::with_code("no such request", "not_found"));
                    };
                    let mut hidden: Vec<Value> = list(next.get("hidden"))
                        .iter()
                        .filter(|each| js::sv(each.get("key")) != target)
                        .cloned()
                        .collect();
                    hidden.push(json!({"key": target, "marker": activity_marker(&item)}));
                    let skip = hidden.len().saturating_sub(MAX_HIDDEN);
                    next.insert(
                        "hidden".into(),
                        Value::Array(hidden.into_iter().skip(skip).collect()),
                    );
                    deps.save(next, change(params)).await?;
                    Ok("hidden")
                })
                .await?;
            deps.inbox.changed();
            Ok(json!({"ok": true, "action": action}))
        }
        "bridge.mr_reviews.unhide" => {
            let target = key(params)?;
            deps.order
                .edit(async {
                    let mut next = deps.settings().await;
                    let hidden: Vec<Value> = list(next.get("hidden"))
                        .iter()
                        .filter(|each| js::sv(each.get("key")) != target)
                        .cloned()
                        .collect();
                    next.insert("hidden".into(), Value::Array(hidden));
                    deps.save(next, change(params)).await
                })
                .await?;
            deps.inbox.changed();
            Ok(json!({"ok": true}))
        }
        "bridge.mr_reviews.order" => {
            // An operation on the latest order, or the undo of an earlier change.
            if params.get("op").and_then(Value::as_str) == Some("undo") {
                let version = js::to_number(params.get("version"));
                if !js::is_safe_integer(version) || version < 1.0 {
                    return Err(RpcError::invalid("version is required"));
                }
                let saved = deps
                    .order
                    .undo(version as i64)
                    .await
                    .map_err(|message| RpcError::with_code(message, "gone"))?;
                return Ok(json!({"ok": true, "version": order_version(&saved)}));
            }
            let result = deps
                .order
                .apply(&order_operation(params)?, &ChangeMeta::user(), None)
                .await?;
            Ok(json!({
                "ok": true,
                "changed": result.changed,
                "version": result.version,
                "unknown": result.unknown,
                "elsewhere": result.elsewhere,
            }))
        }
        "bridge.mr_reviews.override" => set_override(deps, params).await,
        "bridge.mr_reviews.view" => view(deps, params).await,
        "bridge.mr_reviews.unsent" => unsent(deps, params).await,
        "bridge.mr_reviews.upstream.marks" => {
            let current = deps.settings().await;
            let field = |name: &str| current.get(name).cloned().unwrap_or(json!([]));
            Ok(json!({
                "groups": field("upstreamGroups"),
                "skip": field("upstreamSkip"),
                "workspaces": field("upstreamWorkspaces"),
            }))
        }
        "bridge.mr_reviews.upstream.group" | "bridge.mr_reviews.upstream.workspace" => {
            upstream_mark(deps, method, params).await
        }
        "bridge.mr_reviews.settings.get" => Ok(Value::Object(deps.settings().await)),
        "bridge.mr_reviews.settings.update" => update_settings(deps, params).await,
        _ => match &deps.more {
            Some(more) => more(method.to_owned(), params.clone()).await,
            None => Err(RpcError::with_code(
                format!("unknown method: {method}"),
                "unknown",
            )),
        },
    }
}

async fn pin(deps: &MrReviewsRpcDeps, params: &Obj) -> RpcResult<Value> {
    // A URL on one of the user's hosts, or "project!12" / "!12" as the
    // reviews agent reads them.
    let text = match params.get("text") {
        Some(Value::String(text)) if !js::trim(text).is_empty() && js::len16(text) <= 600 => {
            js::trim(text).to_owned()
        }
        _ => return Err(RpcError::invalid("a merge or pull request URL is required")),
    };
    let reference = match parse_request_ref(&text, &deps.inbox.items(), &deps.inbox.hosts().await) {
        None => {
            return Err(RpcError::invalid(if WEB_URL.is_match(&text) {
                "That host is not one of your forge hosts (see the settings), or it is not a merge or pull request URL."
            } else {
                "Not a merge or pull request: paste its URL."
            }));
        }
        Some(RequestRef::Ambiguous(_)) => {
            return Err(RpcError::invalid(
                "That number fits several requests: paste the URL.",
            ));
        }
        Some(RequestRef::Ref(reference)) => reference,
    };
    let key = reference.key();
    deps.order
        .edit(async {
            let mut next = deps.settings().await;
            let pinned = list(next.get("pinned")).to_vec();
            if pinned
                .iter()
                .any(|each| forge_ref_key(&obj_of(each)) == key)
            {
                return Ok(());
            }
            if pinned.len() >= MAX_PINNED {
                return Err(RpcError::invalid(format!(
                    "At most {MAX_PINNED} requests can be pinned: remove one first."
                )));
            }
            let pinned: Vec<Value> = std::iter::once(Value::Object(reference.to_obj()))
                .chain(pinned)
                .collect();
            let hidden: Vec<Value> = list(next.get("hidden"))
                .iter()
                .filter(|each| js::sv(each.get("key")) != key)
                .cloned()
                .collect();
            next.insert("pinned".into(), Value::Array(pinned));
            next.insert("hidden".into(), Value::Array(hidden));
            deps.save(next, change(params)).await?;
            Ok(())
        })
        .await?;
    // One a list already has (pinned from the inbox) is known: no call.
    if deps.inbox.item(&key).is_some() {
        deps.inbox.changed();
    } else {
        deps.inbox.read_pin(&reference).await;
    }
    Ok(json!({"ok": true, "key": key}))
}

async fn set_override(deps: &MrReviewsRpcDeps, params: &Obj) -> RpcResult<Value> {
    // Whose move, next step, dependencies, labels, link, stale: set by hand
    // on one of the user's requests (or cleared).
    let target = key(params)?;
    // A request, or a branch headed upstream (a row with no request).
    let item = match deps.inbox.item(&target) {
        Some(item) => Some(item),
        None => {
            let settings = deps.settings().await;
            deps.inbox
                .entries(&settings)
                .0
                .into_iter()
                .find(|entry| key_of(entry) == target && truthy(entry.get("branch")))
        }
    };
    let Some(item) = item else {
        return Err(RpcError::with_code("no such request", "not_found"));
    };
    let hosts = deps.inbox.hosts().await;
    let items = deps.inbox.items();
    let change_of = override_change(params, &|value| request_key(value, &items, &hosts))?;
    if list(change_of.set.get("dependsOn"))
        .iter()
        .any(|k| k.as_str() == Some(target.as_str()))
    {
        return Err(RpcError::invalid("a request cannot wait for itself"));
    }
    let meta = change(params);
    let result = deps
        .order
        .edit(async {
            let current = deps.settings().await;
            let overrides_now = current
                .get("overrides")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let before = overrides_now
                .get(&target)
                .and_then(Value::as_object)
                .cloned();
            let at = js::iso(js::now_ms());
            let marker = activity_marker(&item);
            let after = apply_override(
                before.as_ref(),
                &change_of,
                &overrides::Meta {
                    by: &meta.by,
                    at: &at,
                    marker: &marker,
                },
            );
            if same_override(before.as_ref(), after.as_ref()) {
                let mut out = Obj::new();
                out.insert("changed".into(), json!(false));
                out.insert("override".into(), before.map_or(Value::Null, Value::Object));
                return Ok(out);
            }
            let mut overrides_next = overrides_now;
            match &after {
                Some(after) => {
                    overrides_next.insert(target.clone(), Value::Object(after.clone()));
                }
                None => {
                    overrides_next.shift_remove(&target);
                }
            }
            let mut next = current.clone();
            next.insert("overrides".into(), Value::Object(overrides_next));
            let saved = deps.save(next, meta.clone()).await?;
            let mut out = Obj::new();
            out.insert("changed".into(), json!(true));
            out.insert("override".into(), after.map_or(Value::Null, Value::Object));
            out.insert("version".into(), json!(order_version(&saved)));
            Ok::<Obj, RpcError>(out)
        })
        .await?;
    if result.get("changed") == Some(&json!(true)) {
        deps.inbox.changed();
    }
    Ok(answer(
        vec![("ok", json!(true)), ("key", json!(target))],
        result,
    ))
}

async fn view(deps: &MrReviewsRpcDeps, params: &Obj) -> RpcResult<Value> {
    // A saved search: saved (a new one, or a new query for its name) or deleted.
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
    let Some(name) = view_name(params.get("name")) else {
        return Err(RpcError::invalid(format!(
            "a view's name is required (at most {VIEW_NAME_MAX} characters, no colon or quote)"
        )));
    };
    if action != "save" && action != "delete" {
        return Err(RpcError::invalid("action is save or delete"));
    }
    let query = match params.get("query") {
        Some(Value::String(query)) => js::head16(js::trim(query), VIEW_QUERY_MAX),
        _ => String::new(),
    };
    if action == "save" && query.is_empty() {
        return Err(RpcError::invalid("a view needs a query"));
    }
    let meta = change(params);
    let result = deps
        .order
        .edit(async {
            let current = deps.settings().await;
            let lower = name.to_lowercase();
            let views = list(current.get("views"));
            let named = |view: &Value| js::sv(view.get("name")).to_lowercase() == lower;
            let existing = views.iter().find(|view| named(view)).cloned();
            if action == "delete" && existing.is_none() {
                return Err(RpcError::with_code(
                    format!("no view named {name}"),
                    "not_found",
                ));
            }
            if action == "save"
                && existing
                    .as_ref()
                    .is_some_and(|e| e.get("query").and_then(Value::as_str) == Some(&query))
            {
                return Ok(with_version(false, order_version(&current)));
            }
            if action == "save" && existing.is_none() && views.len() >= MAX_VIEWS {
                return Err(RpcError::invalid(format!(
                    "At most {MAX_VIEWS} views: delete one first."
                )));
            }
            let next_views: Vec<Value> = if action == "delete" {
                views.iter().filter(|view| !named(view)).cloned().collect()
            } else if let Some(existing) = &existing {
                views
                    .iter()
                    .map(|view| {
                        if named(view) {
                            json!({"name": existing.get("name").cloned().unwrap_or(Value::Null), "query": query})
                        } else {
                            view.clone()
                        }
                    })
                    .collect()
            } else {
                views
                    .iter()
                    .cloned()
                    .chain(std::iter::once(json!({"name": name, "query": query})))
                    .collect()
            };
            let mut next = current.clone();
            next.insert("views".into(), Value::Array(next_views));
            let saved = deps.save(next, meta.clone()).await?;
            Ok(with_version(true, order_version(&saved)))
        })
        .await?;
    Ok(answer(
        vec![("ok", json!(true)), ("name", json!(name))],
        result,
    ))
}

async fn unsent(deps: &MrReviewsRpcDeps, params: &Obj) -> RpcResult<Value> {
    // A branch headed upstream said to be a request, not proposed yet (or
    // back to a plain branch).
    let target = key(params)?;
    if !target.starts_with("branch:") {
        return Err(RpcError::invalid("only a branch can be not proposed yet"));
    }
    let want = params.get("unsent") != Some(&json!(false));
    let trimmed = |name: &str, max: usize| match params.get(name) {
        Some(Value::String(text)) => js::head16(js::trim(text), max),
        _ => String::new(),
    };
    let title = trimmed("title", 300);
    let goal = trimmed("target", 200);
    let meta = change(params);
    let result = deps
        .order
        .edit(async {
            let current = deps.settings().await;
            let entries = list(current.get("unsent"));
            let existing = entries
                .iter()
                .find(|each| js::sv(each.get("key")) == target)
                .cloned();
            if want {
                let row = deps
                    .inbox
                    .entries(&current)
                    .0
                    .into_iter()
                    .find(|entry| key_of(entry) == target);
                if row.is_none() && existing.is_none() {
                    return Err(RpcError::with_code(
                        "no such branch headed upstream",
                        "not_found",
                    ));
                }
                if entries.len() >= MAX_UNSENT && existing.is_none() {
                    return Err(RpcError::invalid(format!(
                        "At most {MAX_UNSENT} requests not proposed yet."
                    )));
                }
            } else if existing.is_none() {
                return Ok(with_version(false, order_version(&current)));
            }
            let known = |name: &str| {
                existing
                    .as_ref()
                    .and_then(|e| e.get(name))
                    .filter(|v| truthy(Some(v)))
                    .cloned()
            };
            let mut entry = Obj::new();
            entry.insert("key".into(), json!(target));
            if let Some(title) = (!title.is_empty())
                .then(|| json!(title))
                .or_else(|| known("title"))
            {
                entry.insert("title".into(), title);
            }
            if let Some(goal) = (!goal.is_empty())
                .then(|| json!(goal))
                .or_else(|| known("target"))
            {
                entry.insert("target".into(), goal);
            }
            entry.insert(
                "at".into(),
                existing
                    .as_ref()
                    .and_then(|e| e.get("at"))
                    .filter(|a| !a.is_null())
                    .cloned()
                    .unwrap_or_else(|| json!(js::iso(js::now_ms()))),
            );
            let mut next_unsent: Vec<Value> = entries
                .iter()
                .filter(|each| js::sv(each.get("key")) != target)
                .cloned()
                .collect();
            if want {
                next_unsent.push(Value::Object(entry));
            }
            if js::stringify(&Value::Array(next_unsent.clone()))
                == js::stringify(&Value::Array(entries.to_vec()))
            {
                return Ok(with_version(false, order_version(&current)));
            }
            let mut next = current.clone();
            next.insert("unsent".into(), Value::Array(next_unsent));
            let saved = deps.save(next, meta.clone()).await?;
            Ok(with_version(true, order_version(&saved)))
        })
        .await?;
    deps.inbox.changed();
    Ok(answer(
        vec![
            ("ok", json!(true)),
            ("key", json!(target)),
            ("unsent", json!(want)),
        ],
        result,
    ))
}

async fn upstream_mark(deps: &MrReviewsRpcDeps, method: &str, params: &Obj) -> RpcResult<Value> {
    // A Workspaces-tree group headed upstream (D5), or a workspace: one of
    // such a group's that is not, or one headed by itself.
    let headed = params.get("headed") != Some(&json!(false));
    let meta = change(params);
    let is_group = method == "bridge.mr_reviews.upstream.group";
    let group = params
        .get("group")
        .and_then(Value::as_str)
        .filter(|g| GROUP_ID.is_match(g))
        .map(str::to_owned);
    let reference = if is_group {
        None
    } else {
        params.get("ref").and_then(parse_workspace_ref)
    };
    if (is_group && group.is_none()) || (!is_group && reference.is_none()) {
        return Err(RpcError::invalid(if is_group {
            "group (a node id) is required"
        } else {
            "ref (a workspace) is required"
        }));
    }
    let result = deps
        .order
        .edit(async {
            let current = deps.settings().await;
            let mut next = current.clone();
            if let Some(group) = &group {
                let groups = list(current.get("upstreamGroups"));
                let has = groups.iter().any(|id| id.as_str() == Some(group));
                if has == headed {
                    return Ok(with_version(false, order_version(&current)));
                }
                if headed && groups.len() >= MAX_UPSTREAM_GROUPS {
                    return Err(RpcError::invalid(format!(
                        "At most {MAX_UPSTREAM_GROUPS} groups headed upstream."
                    )));
                }
                let marked: Vec<Value> = if headed {
                    groups.iter().cloned().chain([json!(group)]).collect()
                } else {
                    groups
                        .iter()
                        .filter(|id| id.as_str() != Some(group))
                        .cloned()
                        .collect()
                };
                next.insert("upstreamGroups".into(), Value::Array(marked));
            } else {
                // In a group headed upstream, a workspace is headed unless
                // skipped; elsewhere only when marked by itself.
                let reference = obj_of(reference.as_ref().unwrap_or(&Value::Null));
                let id = workspace_ref_key(&reference);
                let workspaces = list(current.get("upstreamWorkspaces"));
                let skip = list(current.get("upstreamSkip"));
                let own = workspaces
                    .iter()
                    .any(|each| same_upstream_workspace(&obj_of(each), &reference));
                let tree = match &deps.tree {
                    Some(tree) => tree().await,
                    None => None,
                };
                let in_group = match &tree {
                    Some(tree) => {
                        let node = list(tree.get("nodes")).iter().find(|each| {
                            js::sv(each.get("kind")) == "workspace"
                                && same_upstream_workspace(
                                    &obj_of(each.get("ref").unwrap_or(&Value::Null)),
                                    &reference,
                                )
                        });
                        let marked: Vec<&str> = list(current.get("upstreamGroups"))
                            .iter()
                            .filter_map(Value::as_str)
                            .collect();
                        node.and_then(|n| n.get("parent"))
                            .and_then(Value::as_str)
                            .filter(|p| !p.is_empty())
                            .is_some_and(|parent| {
                                tree_ancestors(tree, Some(parent))
                                    .iter()
                                    .any(|each| marked.contains(&each.as_str()))
                            })
                    }
                    None => !own,
                };
                let skipped = skip
                    .iter()
                    .any(|each| workspace_ref_key(&obj_of(each)) == id);
                let upstream_skip: Vec<Value> = if in_group && !headed {
                    if skipped {
                        skip.to_vec()
                    } else {
                        let all: Vec<Value> = skip
                            .iter()
                            .cloned()
                            .chain([Value::Object(reference.clone())])
                            .collect();
                        let from = all.len().saturating_sub(MAX_UPSTREAM_SKIP);
                        all.into_iter().skip(from).collect()
                    }
                } else {
                    skip.iter()
                        .filter(|each| workspace_ref_key(&obj_of(each)) != id)
                        .cloned()
                        .collect()
                };
                let mut upstream_workspaces: Vec<Value> = workspaces
                    .iter()
                    .filter(|each| !same_upstream_workspace(&obj_of(each), &reference))
                    .cloned()
                    .collect();
                if !in_group && headed {
                    if upstream_workspaces.len() >= MAX_UPSTREAM_WORKSPACES {
                        return Err(RpcError::invalid(format!(
                            "At most {MAX_UPSTREAM_WORKSPACES} workspaces headed upstream by themselves."
                        )));
                    }
                    upstream_workspaces = if own {
                        workspaces.to_vec()
                    } else {
                        upstream_workspaces
                            .into_iter()
                            .chain([Value::Object(reference.clone())])
                            .collect()
                    };
                }
                let same = |a: &[Value], b: &[Value]| {
                    js::stringify(&Value::Array(a.to_vec())) == js::stringify(&Value::Array(b.to_vec()))
                };
                if same(&upstream_skip, skip) && same(&upstream_workspaces, workspaces) {
                    return Ok(with_version(false, order_version(&current)));
                }
                next.insert("upstreamSkip".into(), Value::Array(upstream_skip));
                next.insert(
                    "upstreamWorkspaces".into(),
                    Value::Array(upstream_workspaces),
                );
            }
            let saved = deps.save(next, meta.clone()).await?;
            Ok(with_version(true, order_version(&saved)))
        })
        .await?;
    if result.get("changed") == Some(&json!(true))
        && let Some(changed) = &deps.upstream_changed
    {
        changed().await;
    }
    deps.inbox.changed();
    Ok(answer(
        vec![("ok", json!(true)), ("headed", json!(headed))],
        result,
    ))
}

/// The page's names that change nothing the forges are asked.
const LOCAL_SETTINGS: [&str; 7] = [
    "order",
    "orderVersion",
    "pinned",
    "hidden",
    "staleDays",
    "homePrompt",
    "inferenceModel",
];

async fn update_settings(deps: &MrReviewsRpcDeps, params: &Obj) -> RpcResult<Value> {
    let Some(value) = params.get("settings").and_then(Value::as_object) else {
        return Err(RpcError::invalid("settings are required"));
    };
    // One at a time with the order's operations: a whole order from a page
    // that fell behind is rebased onto the latest, never written over.
    let saved = deps
        .order
        .edit(async {
            let current = deps.settings().await;
            // The browser speaks the settings' own names; settings.json the
            // stored ones: normalized through the stored form. What the page
            // does not send (overrides, views...) is kept.
            let mut stored = stored_mr_reviews(&current);
            let pick = |name: &str| {
                value
                    .get(name)
                    .filter(|v| !v.is_null())
                    .or_else(|| current.get(name))
                    .cloned()
            };
            let put = |stored: &mut Obj, key: &str, value: Option<Value>| match value {
                Some(value) => {
                    stored.insert(key.into(), value);
                }
                None => {
                    stored.shift_remove(key);
                }
            };
            for (stored_name, name) in [
                ("hosts", "hosts"),
                ("followed", "followed"),
                ("checkout", "checkout"),
                ("retention_days", "retentionDays"),
                ("curation", "curation"),
                ("inference", "inference"),
                ("inference_hours", "inferenceHours"),
                ("inference_model", "inferenceModel"),
                ("suggest_days", "suggestDays"),
                ("hints", "hints"),
                ("home_prompt", "homePrompt"),
                ("tree_groups", "treeGroups"),
            ] {
                put(&mut stored, stored_name, pick(name));
            }
            let clones: Obj = pick("clones")
                .and_then(|c| c.as_object().cloned())
                .unwrap_or_default()
                .into_iter()
                .map(|(project, clone)| {
                    let mut out = Obj::new();
                    if let Some(id) = clone.get("connectionId").filter(|v| !v.is_null()) {
                        out.insert("connection_id".into(), id.clone());
                    }
                    if let Some(path) = clone.get("path").filter(|v| !v.is_null()) {
                        out.insert("path".into(), path.clone());
                    }
                    (project, Value::Object(out))
                })
                .collect();
            put(&mut stored, "clones", Some(Value::Object(clones)));
            let order = match value.get("order") {
                Some(Value::Array(order)) => {
                    let keys: Vec<String> = order
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                    let base = value
                        .get("orderVersion")
                        .and_then(Value::as_f64)
                        .map(|v| v as i64);
                    Some(json!(deps.order.rebased(&current, &keys, base)))
                }
                _ => current.get("order").cloned(),
            };
            put(&mut stored, "order", order);
            put(&mut stored, "pinned", pick("pinned"));
            put(&mut stored, "hidden", pick("hidden"));
            put(&mut stored, "stale_days", pick("staleDays"));
            if let Some(merge) = value.get("merge") {
                let merge =
                    stored_merge_of(merge.as_object()).map_or_else(|| json!({}), Value::Object);
                put(&mut stored, "merge", Some(merge));
            }
            let normalized = normalize_stored_mr_reviews(Some(&Value::Object(stored)));
            let settings = mr_reviews_settings(normalized.as_ref().and_then(Value::as_object));
            deps.save(settings, ChangeMeta::user()).await
        })
        .await?;
    // The user's order alone changes nothing the forges are asked.
    if value
        .keys()
        .any(|name| !LOCAL_SETTINGS.contains(&name.as_str()))
    {
        deps.inbox.refresh_soon();
    }
    Ok(Value::Object(saved))
}

#[cfg(test)]
mod tests;
