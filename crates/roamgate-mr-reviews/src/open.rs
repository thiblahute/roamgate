//! Opening a request for review (`mr-reviews/open.ts`): its project's
//! clone (found, or asked for), the project's review worktree and its
//! "Reviews · project" workspace, the request's review in the review pane
//! (it diffs the request's commits from the shared objects, whatever is
//! checked out), and the checkout of its head, detached, when the setting
//! says so. Local changes in the worktree are never lost: the user picks
//! keeping them on a branch or dropping them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_base::log::{LogFields, Logger};
use serde_json::{Value, json};

use crate::claude::{
    ConnectionsFn, ItemFn, herdr, lock_store, mr_project_key, record_mut, record_of, update_store,
    workspaces_of,
};
use crate::clones::{CloneFinder, FoundClone, ProjectRef};
use crate::connection::{BoxFuture, MrConnection, sh_quote};
use crate::home::{MarkSeenFn, OpenReviewFn, PlaceWorkspaceFn};
use crate::inbox::{SettingsFn, truthy};
use crate::rpc::{RpcError, RpcResult};
use crate::shared::types::{forge_ref_label, project_key};
use crate::store::MrStore;
use crate::worktree::{
    CheckoutResult, FetchWant, LocalChanges, checkout_script, ensure_worktree_script, fetch_script,
    parse_checkout, parse_fetch, parse_status, project_url, review_worktree_path, status_script,
};

/// Remembers the clone the user picked (settings `clones`):
/// `(project key, {connectionId, path})`.
pub type SaveCloneFn = Arc<dyn Fn(String, Obj) -> BoxFuture<'static, RpcResult<()>> + Send + Sync>;

/// The default connection, ready or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DefaultConnection {
    pub id: String,
    pub label: String,
    pub ready: bool,
}

pub type DefaultConnectionFn = Arc<dyn Fn() -> Option<DefaultConnection> + Send + Sync>;

/// What [`MrOpener`] needs (`MrOpenerDeps`).
#[derive(Clone)]
pub struct MrOpenerDeps {
    /// A request of the inbox (`inbox.item`).
    pub item: ItemFn,
    /// The user saw a request (`inbox.markSeen`).
    pub mark_seen: MarkSeenFn,
    pub store: Arc<Mutex<MrStore>>,
    /// The reviews settings in effect (`clones`, `checkout`).
    pub settings: SettingsFn,
    pub save_clone: SaveCloneFn,
    /// The ready connections, the default one first.
    pub connections: ConnectionsFn,
    /// The default connection, ready or not (none: no default).
    pub default_connection: Option<DefaultConnectionFn>,
    pub clones: Arc<CloneFinder>,
    /// Puts a new review workspace in its place in the Workspaces tree.
    pub place_workspace: Option<PlaceWorkspaceFn>,
    /// The review pane's open (review service), never raising it elsewhere.
    pub open_review: OpenReviewFn,
    pub logger: Logger,
}

/// The label of a project's review workspace.
pub fn workspace_label(project: &str) -> String {
    format!(
        "Reviews \u{b7} {}",
        project.rsplit('/').next().unwrap_or(project)
    )
}

/// The opener (`createMrOpener`): a cheap clone.
#[derive(Clone)]
pub struct MrOpener(Arc<Opener>);

struct Opener {
    deps: MrOpenerDeps,
    /// One worktree operation at a time per project, in their order.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

/// `MrCheckoutState` as Bun answers it.
fn checkout_state(result: &CheckoutResult) -> Value {
    result.to_json()
}

impl MrOpener {
    pub fn new(deps: MrOpenerDeps) -> MrOpener {
        MrOpener(Arc::new(Opener {
            deps,
            locks: Mutex::new(HashMap::new()),
        }))
    }

    fn deps(&self) -> &MrOpenerDeps {
        &self.0.deps
    }

    fn info(&self, message: &str, pairs: &[(&str, Value)]) {
        self.deps().logger.info(message, Some(&fields(pairs)));
    }

    fn lock_of(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.to_owned())
            .or_default()
            .clone()
    }

    fn connection(&self, id: &str) -> RpcResult<Arc<dyn MrConnection>> {
        (self.deps().connections)()
            .into_iter()
            .find(|conn| conn.id() == id)
            .ok_or_else(|| {
                RpcError::with_code(format!("the connection {id} is not ready"), "unavailable")
            })
    }

    fn is_ready(&self, id: &str) -> bool {
        (self.deps().connections)()
            .iter()
            .any(|conn| conn.id() == id)
    }

    fn item(&self, key: &str) -> RpcResult<Obj> {
        (self.deps().item)(key)
            .ok_or_else(|| RpcError::with_code("no such request in the inbox", "not_found"))
    }

    /// The project's clone: the record's, the picked one, or one found.
    async fn clone_of(&self, entry: &Obj) -> RpcResult<Option<FoundClone>> {
        let key = mr_project_key(entry);
        if let Some(record) = record_of(&self.deps().store, "projects", &key) {
            let connection = js::sv(record.get("connectionId"));
            if self.is_ready(connection) {
                return Ok(Some(FoundClone {
                    connection_id: connection.to_owned(),
                    path: js::sv(record.get("clone")).to_owned(),
                    remote: js::sv(record.get("remote")).to_owned(),
                }));
            }
        }
        let settings = (self.deps().settings)().await;
        let picked = js::rec(settings.get("clones"))
            .and_then(|clones| js::rec(clones.get(&key)))
            .cloned();
        if let Some(picked) = picked {
            let connection = js::sv(picked.get("connectionId")).to_owned();
            if self.is_ready(&connection) {
                let path = js::sv(picked.get("path")).to_owned();
                let conn = self.connection(&connection)?;
                let checked = self
                    .deps()
                    .clones
                    .check(&*conn, &path, &ProjectRef::of(entry))
                    .await;
                return Ok(Some(checked.unwrap_or(FoundClone {
                    connection_id: connection,
                    path,
                    remote: String::new(),
                })));
            }
        }
        // A new project goes to the default connection's clone first: with
        // that connection down, nothing is decided elsewhere meanwhile.
        if let Some(preferred) = self.deps().default_connection.as_ref().and_then(|f| f())
            && !preferred.ready
        {
            return Err(RpcError::with_code(
                format!(
                    "{}, the default connection, is not connected: {}'s review goes there once it is (or pick a clone in Reviews' settings)",
                    preferred.label,
                    js::sv(entry.get("project"))
                ),
                "unavailable",
            ));
        }
        let found = self
            .deps()
            .clones
            .find(&(self.deps().connections)(), &ProjectRef::of(entry))
            .await;
        Ok(found.into_iter().next())
    }

    /// The project's review workspace, and whether it was created now.
    async fn workspace_for(
        &self,
        conn: &dyn MrConnection,
        worktree: &str,
        project: &str,
        known: Option<&str>,
    ) -> RpcResult<(String, bool)> {
        let listed = herdr(conn, "workspace.list", json!({})).await?;
        let workspaces = workspaces_of(&listed);
        let existing = workspaces
            .iter()
            .find(|w| {
                known.is_some_and(|known| {
                    !known.is_empty()
                        && w.get("workspace_id").and_then(Value::as_str) == Some(known)
                })
            })
            .or_else(|| {
                workspaces.iter().find(|w| {
                    w.get("cwd").and_then(Value::as_str) == Some(worktree)
                        || w.get("worktree")
                            .and_then(|t| t.get("checkout_path"))
                            .and_then(Value::as_str)
                            == Some(worktree)
                })
            });
        if let Some(id) = existing.and_then(|w| w.get("workspace_id"))
            && truthy(Some(id))
        {
            return Ok((js::to_text(id), false));
        }
        let created = herdr(
            conn,
            "workspace.create",
            json!({"cwd": worktree, "label": workspace_label(project), "focus": false}),
        )
        .await?;
        match created
            .get("workspace")
            .and_then(|w| w.get("workspace_id"))
            .and_then(Value::as_str)
        {
            Some(id) if !id.is_empty() => Ok((id.to_owned(), true)),
            _ => Err(RpcError::with_code(
                "Herdr did not create the review workspace",
                "herdr",
            )),
        }
    }

    /// The project's review worktree and workspace, made when missing.
    async fn project_of(&self, entry: &Obj) -> RpcResult<Option<(Arc<dyn MrConnection>, Obj)>> {
        let Some(clone) = self.clone_of(entry).await? else {
            return Ok(None);
        };
        let conn = self.connection(&clone.connection_id)?;
        let key = mr_project_key(entry);
        let worktree = review_worktree_path(&clone.path);
        let start = if clone.remote.is_empty() {
            "HEAD".to_owned()
        } else {
            format!("{}/{}", clone.remote, js::sv(entry.get("targetBranch")))
        };
        let made = conn
            .run(
                &ensure_worktree_script(&clone.path, &worktree, &start),
                120_000,
            )
            .await;
        if made.code != 0 {
            let output = if made.stderr.is_empty() {
                &made.stdout
            } else {
                &made.stderr
            };
            return Err(RpcError::with_code(
                format!(
                    "cannot make the review worktree: {}",
                    js::slice16(js::trim(output), -300, None)
                ),
                "worktree",
            ));
        }
        let previous = record_of(&self.deps().store, "projects", &key);
        let known = previous
            .as_ref()
            .and_then(|p| p.get("workspaceId"))
            .and_then(Value::as_str);
        let project = js::sv(entry.get("project"));
        let (workspace_id, fresh) = self
            .workspace_for(&*conn, &worktree, project, known)
            .await?;
        // A new one goes where the project's reviews go in the tree; one
        // the user placed is never moved.
        if fresh && let Some(place) = &self.deps().place_workspace {
            let mut params = Obj::new();
            params.insert("projectKey".into(), json!(key));
            params.insert("connectionId".into(), json!(conn.id()));
            params.insert("workspaceId".into(), json!(workspace_id));
            params.insert("label".into(), json!(workspace_label(project)));
            params.insert("worktree".into(), json!(worktree));
            params.insert("clone".into(), json!(clone.path));
            if let Err(error) = place(params).await {
                self.info(
                    "review workspace not placed",
                    &[("project", json!(key)), ("error", json!(error))],
                );
            }
        }
        let mut record = previous.unwrap_or_default();
        record.insert("connectionId".into(), json!(conn.id()));
        record.insert("clone".into(), json!(clone.path));
        record.insert("worktree".into(), json!(worktree));
        record.insert("workspaceId".into(), json!(workspace_id));
        if !clone.remote.is_empty() {
            record.insert("remote".into(), json!(clone.remote));
        }
        let stored = record.clone();
        update_store(&self.deps().store, |state| {
            if let Some(projects) = state.get_mut("projects").and_then(Value::as_object_mut) {
                projects.insert(key.clone(), Value::Object(stored));
            }
        })?;
        Ok(Some((conn, record)))
    }

    fn source_of(entry: &Obj, record: &Obj) -> String {
        match js::sv(record.get("remote")) {
            "" => project_url(js::sv(entry.get("host")), js::sv(entry.get("project"))),
            remote => remote.to_owned(),
        }
    }

    async fn fetch_one(&self, conn: &dyn MrConnection, entry: &Obj, record: &Obj) {
        if !truthy(entry.get("headSha")) {
            return;
        }
        let want = FetchWant::of(entry);
        let result = conn
            .run(
                &fetch_script(
                    js::sv(record.get("clone")),
                    &Self::source_of(entry, record),
                    js::sv(entry.get("provider")),
                    std::slice::from_ref(&want),
                ),
                180_000,
            )
            .await;
        if parse_fetch(&result.stdout)
            .missing
            .contains(&(want.number as i64))
        {
            self.info(
                "request head not fetched",
                &[
                    ("mr", entry.get("key").cloned().unwrap_or(Value::Null)),
                    (
                        "error",
                        json!(js::slice16(js::trim(&result.stderr), -200, None)),
                    ),
                ],
            );
        }
    }

    async fn checkout_in(
        &self,
        conn: &dyn MrConnection,
        entry: &Obj,
        record: &Obj,
        local: LocalChanges,
    ) -> RpcResult<Value> {
        let key = mr_project_key(entry);
        let lock = self.lock_of(&key);
        let _held = lock.lock().await;
        // Labelled by the request the worktree was on, when known.
        let current = record
            .get("checkedOut")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .and_then(|key| (self.deps().item)(key));
        let label = match &current {
            Some(current) => current.get("number").map(js::to_text).unwrap_or_default(),
            None => "wip".to_owned(),
        };
        let worktree = js::sv(record.get("worktree"));
        let head = js::sv(entry.get("headSha"));
        let script = checkout_script(worktree, head, local, &label);
        let mut result = parse_checkout(&conn.run(&script, 120_000).await);
        if result == CheckoutResult::Missing {
            self.fetch_one(conn, entry, record).await;
            result = parse_checkout(&conn.run(&script, 120_000).await);
        }
        if result == CheckoutResult::Dirty {
            let status = parse_status(&conn.run(&status_script(worktree), 30_000).await.stdout);
            let changes: Vec<String> = status.changes.into_iter().take(50).collect();
            return Ok(json!({"state": "dirty", "changes": changes}));
        }
        if matches!(result, CheckoutResult::Done { .. }) {
            let entry_key = entry.get("key").cloned().unwrap_or(Value::Null);
            update_store(&self.deps().store, |state| {
                if let Some(project) = record_mut(state, "projects", &key) {
                    project.insert("checkedOut".into(), entry_key);
                }
            })?;
        }
        Ok(checkout_state(&result))
    }

    /// The project's clone, review worktree and workspace (made when
    /// missing): its connection and record.
    pub async fn project(&self, entry: &Obj) -> RpcResult<Option<(Arc<dyn MrConnection>, Obj)>> {
        let lock = self.lock_of(&mr_project_key(entry));
        let _held = lock.lock().await;
        self.project_of(entry).await
    }

    /// [`MrOpener::project`] as the homes take it.
    pub fn project_fn(&self) -> crate::home::ProjectFn {
        let opener = self.clone();
        Arc::new(move |entry: Obj| {
            let opener = opener.clone();
            Box::pin(async move { opener.project(&entry).await })
        })
    }

    /// Opens a request: `{needClone}` or `{connectionId, workspaceId,
    /// sessionId, snapshot, worktree, checkout}`. `checkout`: `now`,
    /// `later` or the setting.
    pub async fn open(&self, key: &str, checkout: Option<&str>) -> RpcResult<Value> {
        let entry = self.item(key)?;
        let head = js::sv(entry.get("headSha")).to_owned();
        if head.is_empty() {
            return Err(RpcError::invalid("the forge gave no head for this request"));
        }
        let Some((conn, record)) = self.project(&entry).await? else {
            let connections: Vec<Value> = (self.deps().connections)()
                .iter()
                .map(|c| json!({"id": c.id(), "label": c.label()}))
                .collect();
            return Ok(json!({"needClone": {
                "host": entry.get("host").cloned().unwrap_or(Value::Null),
                "project": entry.get("project").cloned().unwrap_or(Value::Null),
                "connections": connections,
            }}));
        };
        // The review diffs the request's commits: they are fetched first
        // (a prefetched one is already there: no network).
        self.fetch_one(&*conn, &entry, &record).await;
        let workspace_id = record.get("workspaceId").cloned().unwrap_or(Value::Null);
        let worktree = record.get("worktree").cloned().unwrap_or(Value::Null);
        let mut params = Obj::new();
        params.insert("connectionId".into(), json!(conn.id()));
        params.insert("workspaceId".into(), workspace_id.clone());
        params.insert("root".into(), worktree.clone());
        params.insert(
            "url".into(),
            entry.get("url").cloned().unwrap_or(Value::Null),
        );
        params.insert(
            "title".into(),
            json!(js::head16(
                &format!(
                    "{} {}",
                    forge_ref_label(&entry, false),
                    js::sv(entry.get("title"))
                ),
                300
            )),
        );
        let snapshot = (self.deps().open_review)(params).await?;
        let session_id = snapshot
            .get("session")
            .and_then(|session| session.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        {
            let (conn_id, workspace, session) = (
                conn.id().to_owned(),
                workspace_id.clone(),
                session_id.clone(),
            );
            update_store(&self.deps().store, |state| {
                if let Some(reviews) = state.get_mut("reviews").and_then(Value::as_object_mut) {
                    let mut review = reviews
                        .get(key)
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    review.insert("connectionId".into(), json!(conn_id));
                    review.insert("workspaceId".into(), workspace);
                    review.insert("sessionId".into(), session);
                    reviews.insert(key.to_owned(), Value::Object(review));
                }
            })?;
        }
        (self.deps().mark_seen)(key);
        let settings = (self.deps().settings)().await;
        let now = checkout == Some("now")
            || (checkout != Some("later") && js::sv(settings.get("checkout")) == "immediately");
        let state = if !now {
            json!({"state": "deferred"})
        } else if record.get("checkedOut").and_then(Value::as_str) == Some(key) {
            json!({"state": "done", "head": head})
        } else {
            self.checkout_in(&*conn, &entry, &record, LocalChanges::Refuse)
                .await?
        };
        let mut out = Obj::new();
        out.insert("connectionId".into(), json!(conn.id()));
        out.insert("workspaceId".into(), workspace_id);
        out.insert("sessionId".into(), session_id);
        out.insert("snapshot".into(), snapshot);
        out.insert("worktree".into(), worktree);
        out.insert("checkout".into(), state);
        Ok(Value::Object(out))
    }

    /// The user's answer to local changes, or the on-demand checkout.
    pub async fn checkout(&self, key: &str, local: LocalChanges) -> RpcResult<Value> {
        let entry = self.item(key)?;
        let Some(record) = record_of(&self.deps().store, "projects", &mr_project_key(&entry))
        else {
            return Err(RpcError::invalid("open the request first"));
        };
        let conn = self.connection(js::sv(record.get("connectionId")))?;
        self.checkout_in(&*conn, &entry, &record, local).await
    }

    /// The clone the user picked for a project: `{ok, remote}`.
    pub async fn set_clone(
        &self,
        project: &ProjectRef,
        connection_id: &str,
        path: &str,
    ) -> RpcResult<Value> {
        let conn = self.connection(connection_id)?;
        // A clone of the project there, a checkout or a repository
        // directory such as gstreamer.git (no work tree of its own); else
        // any checkout.
        let found = self.deps().clones.check(&*conn, path, project).await;
        let path = match &found {
            Some(found) => found.path.clone(),
            None => {
                let result = conn
                    .run(
                        &format!(
                            "cd {} 2>/dev/null && git rev-parse --show-toplevel",
                            sh_quote(path)
                        ),
                        30_000,
                    )
                    .await;
                if result.code != 0 {
                    return Err(RpcError::invalid(format!(
                        "{path} is not a Git checkout there"
                    )));
                }
                js::trim(&result.stdout).to_owned()
            }
        };
        let mut clone = Obj::new();
        clone.insert("connectionId".into(), json!(conn.id()));
        clone.insert("path".into(), json!(path));
        (self.deps().save_clone)(project_key(&project.host, &project.project), clone).await?;
        self.deps().clones.forget(Some(conn.id()));
        Ok(json!({"ok": true, "remote": found.map(|found| found.remote)}))
    }

    /// Fetches the heads of the inbox's open requests whose project has a
    /// review worktree, one fetch per project; nothing for the others.
    pub async fn prefetch(&self, items: &[Obj]) {
        // Only what the user is likely to open: their requests and the
        // suggestions picked (or asked for), and only a head not fetched yet.
        let mut by_project: Vec<(String, Vec<Obj>)> = Vec::new();
        {
            let store = lock_store(&self.deps().store);
            let known = store.get();
            let wanted: Vec<&str> = known
                .get("feedback")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| {
                    entry.get("verdict").and_then(Value::as_str) == Some("more_like_this")
                })
                .map(|entry| js::sv(entry.get("key")))
                .collect();
            for entry in items {
                let key = js::sv(entry.get("key"));
                let head = entry.get("headSha");
                let reasons = entry
                    .get("reasons")
                    .and_then(Value::as_array)
                    .is_some_and(|reasons| !reasons.is_empty());
                let picked = known
                    .get("ranked")
                    .and_then(|ranked| ranked.get(key))
                    .is_some_and(|ranked| truthy(ranked.get("pick")));
                let fetched = known.get("prefetched").and_then(|p| p.get(key));
                if js::sv(entry.get("state")) == "open"
                    && truthy(head)
                    && (reasons || picked || wanted.contains(&key))
                    && fetched != head
                {
                    let project = mr_project_key(entry);
                    match by_project.iter_mut().find(|(key, _)| *key == project) {
                        Some((_, entries)) => entries.push(entry.clone()),
                        None => by_project.push((project, vec![entry.clone()])),
                    }
                }
            }
        }
        for (key, entries) in by_project {
            let Some(record) = record_of(&self.deps().store, "projects", &key) else {
                continue;
            };
            let connection = js::sv(record.get("connectionId"));
            let Some(conn) = (self.deps().connections)()
                .into_iter()
                .find(|c| c.id() == connection)
            else {
                continue;
            };
            let first = &entries[0];
            let wants: Vec<FetchWant> = entries.iter().map(FetchWant::of).collect();
            let result = conn
                .run(
                    &fetch_script(
                        js::sv(record.get("clone")),
                        &Self::source_of(first, &record),
                        js::sv(first.get("provider")),
                        &wants,
                    ),
                    300_000,
                )
                .await;
            let parsed = parse_fetch(&result.stdout);
            let done: Vec<i64> = parsed.have.iter().chain(&parsed.fetched).copied().collect();
            let saved = update_store(&self.deps().store, |state| {
                let Some(prefetched) = state.get_mut("prefetched").and_then(Value::as_object_mut)
                else {
                    return;
                };
                for entry in &entries {
                    let number = js::num(entry.get("number")).unwrap_or(f64::NAN);
                    if done.iter().any(|n| *n as f64 == number) {
                        prefetched.insert(
                            js::sv(entry.get("key")).to_owned(),
                            entry.get("headSha").cloned().unwrap_or(Value::Null),
                        );
                    }
                }
            });
            if let Err(error) = saved {
                self.info(
                    "prefetch failed",
                    &[("project", json!(key)), ("error", json!(error.message()))],
                );
                continue;
            }
            if !parsed.fetched.is_empty() || !parsed.missing.is_empty() {
                self.info(
                    "request heads prefetched",
                    &[
                        ("project", json!(key)),
                        ("fetched", json!(parsed.fetched.len())),
                        ("missing", json!(parsed.missing.len())),
                    ],
                );
            }
        }
    }
}

#[cfg(test)]
mod tests;
