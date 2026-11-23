//! The efforts of the user's Reviews (`mr-reviews/effort-service.ts`):
//! their ledgers derived when a head moved (at most every minute, the
//! target asked of its remote at most every TARGET_CHECK_MS), their cards
//! for the inbox, and their RPCs ([`rpc::handle_effort_rpc`]).

pub mod rpc;
pub mod scripts;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::DataContext;
use roamgate_forge::remote::{on_gitlab_host, remote_project};
use serde_json::{Value, json};

use crate::connection::{BoxFuture, MrConnection, sh_quote};
use crate::efforts::{
    DeriveInput, Effort, LedgerStore, RequestIds, TARGET_CHECK_MS, derive_effort, effort_summary,
    overlap_of, upstream_ref,
};
use crate::inbox::{SettingsFn, truthy};
use crate::rpc::{RpcError, RpcResult};
use crate::shared::types::forge_ref_label;
use crate::upstream::{
    ConnectionsFn, ItemsFn, PatchIdsWant, UpstreamScanner, parse_request_patch_ids,
    request_patch_ids_script,
};

pub use rpc::{EffortRpcDeps, handle_effort_rpc};

const EFFORT_REFRESH_MS: f64 = 60_000.0;

/// Publishes a push to the browsers (`MrReviewsPush`).
pub type PublishFn = Arc<dyn Fn(Obj) + Send + Sync>;
/// The inbox version and order, for a push that only says "effort".
pub type CurrentFn = Arc<dyn Fn() -> BoxFuture<'static, (Value, Value)> + Send + Sync>;
pub type NowFn = Arc<dyn Fn() -> f64 + Send + Sync>;

/// What the service reads and where it publishes (`createEffortService`'s options).
pub struct EffortServiceOptions {
    pub context: DataContext,
    /// `<data>/mr-reviews/efforts`.
    pub root: PathBuf,
    pub settings: SettingsFn,
    pub connections: ConnectionsFn,
    pub items: ItemsFn,
    pub upstream: Arc<UpstreamScanner>,
    pub publish: Option<PublishFn>,
    pub current: CurrentFn,
    pub now: Option<NowFn>,
}

type Running = Shared<BoxFuture<'static, Option<Obj>>>;

#[derive(Default)]
struct State {
    last_run: HashMap<String, f64>,
    last_target: HashMap<String, f64>,
    running: HashMap<String, Running>,
    /// Request patch ids read in a clone: `clone\0key` -> head, ids.
    request_ids: HashMap<String, (String, HashSet<String>)>,
    /// The efforts declared, as last read (for takenElsewhere).
    known: Vec<Value>,
}

struct Inner {
    options: EffortServiceOptions,
    now: NowFn,
    store: LedgerStore,
    state: Mutex<State>,
}

/// The upstreaming efforts' service, a cheap clone.
#[derive(Clone)]
pub struct EffortService {
    inner: Arc<Inner>,
}

fn s<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut at = value;
    for key in path {
        match at.get(*key) {
            Some(next) => at = next,
            None => return "",
        }
    }
    at.as_str().unwrap_or("")
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn commits_of(derived: Option<&Obj>) -> Vec<Value> {
    derived
        .and_then(|d| d.get("commits"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn efforts_of(settings: &Obj) -> Vec<Value> {
    settings
        .get("efforts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

impl EffortService {
    pub fn new(options: EffortServiceOptions) -> EffortService {
        let now = options.now.clone().unwrap_or_else(|| Arc::new(js::now_ms));
        let store = LedgerStore::new(options.context.clone(), options.root.clone());
        EffortService {
            inner: Arc::new(Inner {
                options,
                now,
                store,
                state: Mutex::new(State::default()),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> f64 {
        (self.inner.now)()
    }

    pub fn store(&self) -> &LedgerStore {
        &self.inner.store
    }

    pub fn upstream(&self) -> &Arc<UpstreamScanner> {
        &self.inner.options.upstream
    }

    pub fn connection_of(&self, id: &str) -> Option<Arc<dyn MrConnection>> {
        (self.inner.options.connections)()
            .into_iter()
            .find(|each| each.id() == id)
    }

    /// The user's open requests on the effort's target project, with the
    /// patch ids of their commits (read in the clone when their head moved).
    async fn requests_for(
        &self,
        effort: &Effort,
        connection: &dyn MrConnection,
        url: &str,
    ) -> Vec<RequestIds> {
        let remote = remote_project(url);
        let settings = (self.inner.options.settings)().await;
        let Some(remote) = remote else {
            return vec![];
        };
        let host = settings
            .get("hosts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|each| {
                if s(each, &["provider"]) == "gitlab" {
                    on_gitlab_host(&remote.host, s(each, &["host"]))
                } else {
                    remote.host == s(each, &["host"])
                }
            })
            .cloned();
        let Some(host) = host else {
            return vec![];
        };
        let clone = s(effort, &["clone", "path"]).to_owned();
        let own: Vec<Obj> = (self.inner.options.items)()
            .into_iter()
            .filter(|item| {
                strings(item.get("reasons")).iter().any(|r| r == "authored")
                    && js::sv(item.get("state")) == "open"
                    && js::sv(item.get("provider")) == s(&host, &["provider"])
                    && js::sv(item.get("host")).to_lowercase() == s(&host, &["host"]).to_lowercase()
                    && js::sv(item.get("project")).to_lowercase() == remote.project.to_lowercase()
                    && !js::sv(item.get("headSha")).is_empty()
            })
            .take(60)
            .collect();
        let id_of = |item: &Obj| format!("{clone}\u{0}{}", js::sv(item.get("key")));
        let stale: Vec<&Obj> = {
            let state = self.state();
            own.iter()
                .filter(|item| {
                    state
                        .request_ids
                        .get(&id_of(item))
                        .map(|(head, _)| head.as_str())
                        != Some(js::sv(item.get("headSha")))
                })
                .collect()
        };
        if !stale.is_empty() {
            let wants: Vec<PatchIdsWant> = stale
                .iter()
                .map(|item| PatchIdsWant {
                    key: js::sv(item.get("key")).to_owned(),
                    provider: js::sv(item.get("provider")).to_owned(),
                    number: item.get("number").and_then(Value::as_u64).unwrap_or(0),
                    head: js::sv(item.get("headSha")).to_owned(),
                })
                .collect();
            let script = request_patch_ids_script(
                &clone,
                s(effort, &["target", "remote"]),
                &upstream_ref(effort),
                &wants,
            );
            let read = parse_request_patch_ids(&connection.run(&script, 300_000).await.stdout);
            let mut state = self.state();
            for item in &stale {
                let key = js::sv(item.get("key"));
                state.request_ids.insert(
                    id_of(item),
                    (
                        js::sv(item.get("headSha")).to_owned(),
                        read.get(key).cloned().unwrap_or_default(),
                    ),
                );
            }
        }
        let state = self.state();
        own.iter()
            .map(|item| RequestIds {
                key: js::sv(item.get("key")).to_owned(),
                label: forge_ref_label(item, false),
                ids: state
                    .request_ids
                    .get(&id_of(item))
                    .map(|(_, ids)| ids.clone())
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// Derives one effort when due (or now, forced): what is derived then.
    pub fn refresh_one(&self, effort: &Effort, force: bool) -> BoxFuture<'static, Option<Obj>> {
        let id = s(effort, &["id"]).to_owned();
        let store = self.inner.store.clone();
        if let Some(busy) = self.state().running.get(&id).cloned() {
            return Box::pin(busy);
        }
        let now = self.now();
        let due = force
            || now - self.state().last_run.get(&id).copied().unwrap_or(0.0) >= EFFORT_REFRESH_MS;
        if !due {
            return Box::pin(async move { store.derived(&id) });
        }
        let Some(connection) = self.connection_of(s(effort, &["clone", "connectionId"])) else {
            return Box::pin(async move { store.derived(&id) });
        };
        let check_target = {
            let mut state = self.state();
            state.last_run.insert(id.clone(), now);
            let check = force
                || now - state.last_target.get(&id).copied().unwrap_or(0.0) >= TARGET_CHECK_MS;
            if check {
                state.last_target.insert(id.clone(), now);
            }
            check
        };
        let parts = self.parts_of(effort);
        let elsewhere = self.taken_elsewhere(&id);
        let service = self.clone();
        let effort = effort.clone();
        let key = id.clone();
        let run: BoxFuture<'static, Option<Obj>> = Box::pin(async move {
            let requests_service = service.clone();
            let requests_effort = effort.clone();
            let requests_connection = connection.clone();
            let (derived, ran) = derive_effort(DeriveInput {
                effort: &effort,
                connection: &*connection,
                store: &store,
                check_target,
                requests: Box::new(move |url, _target| {
                    Box::pin(async move {
                        Ok(requests_service
                            .requests_for(&requests_effort, &*requests_connection, &url)
                            .await)
                    })
                }),
                parts,
                elsewhere,
                now: service.now(),
                force,
            })
            .await;
            if !ran && derived.get("error").is_some_and(|e| truthy(Some(e))) {
                store.write_derived(&id, &derived);
            }
            if ran {
                service.push(&id, "user", None, None).await;
            }
            service.state().running.remove(&id);
            Some(derived)
        });
        let shared = run.shared();
        self.state().running.insert(key, shared.clone());
        Box::pin(shared)
    }

    /// Commits in another effort's planned requests or parts, by patch id:
    /// that effort's name (D4: in one plan or part across efforts), first
    /// one first.
    pub fn taken_elsewhere(&self, effort_id: &str) -> Vec<(String, String)> {
        let known = self.state().known.clone();
        let store = &self.inner.store;
        let mut out: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for other in &known {
            let other_id = s(other, &["id"]);
            if other_id == effort_id {
                continue;
            }
            let plans: Vec<Value> = store
                .ledger(other_id)
                .get("plans")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if plans.is_empty() {
                continue;
            }
            let patch_of: HashMap<String, String> = commits_of(store.derived(other_id).as_ref())
                .iter()
                .map(|c| (s(c, &["key"]).to_owned(), s(c, &["patchId"]).to_owned()))
                .collect();
            for plan in &plans {
                for key in strings(plan.get("commits")) {
                    let id = patch_of.get(&key).cloned().unwrap_or(key);
                    if seen.insert(id.clone()) {
                        out.push((id, s(other, &["name"]).to_owned()));
                    }
                }
            }
        }
        out
    }

    /// The patch ids of each part: branches of the effort's group.
    fn parts_of(&self, effort: &Effort) -> Vec<(String, HashSet<String>)> {
        // A part made for a plan holds its commits even where their patch ids
        // changed: fixups folded, or made from a branch holding them already
        // (both checked tree to tree when it was made).
        let id = s(effort, &["id"]);
        let store = &self.inner.store;
        let plans: Vec<Value> = store
            .ledger(id)
            .get("plans")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let patch_ids: HashMap<String, String> = commits_of(store.derived(id).as_ref())
            .iter()
            .map(|c| (s(c, &["key"]).to_owned(), s(c, &["patchId"]).to_owned()))
            .collect();
        let head_path = effort.get("head").map(|h| s(h, &["path"]));
        self.inner
            .options
            .upstream
            .branches()
            .into_iter()
            .filter(|branch| {
                branch.member.group == s(effort, &["group"])
                    && branch.member.path != s(effort, &["clone", "path"])
                    && Some(branch.member.path.as_str()) != head_path
            })
            .map(|branch| {
                let mut ids: HashSet<String> = branch
                    .commits
                    .iter()
                    .filter_map(|c| c.patch_id.clone().filter(|id| !id.is_empty()))
                    .collect();
                for plan in &plans {
                    let Some(part) = plan.get("part").filter(|p| p.is_object()) else {
                        continue;
                    };
                    if s(part, &["path"]) != branch.member.path || truthy(part.get("conflict")) {
                        continue;
                    }
                    for key in strings(plan.get("commits")) {
                        if let Some(id) = patch_ids.get(&key).filter(|id| !id.is_empty()) {
                            ids.insert(id.clone());
                        }
                    }
                }
                (branch.branch, ids)
            })
            .collect()
    }

    /// Publishes that an effort changed.
    pub async fn push(
        &self,
        effort_id: &str,
        by: &str,
        summary: Option<&str>,
        journal: Option<f64>,
    ) {
        let Some(publish) = self.inner.options.publish.clone() else {
            return;
        };
        let (version, order) = (self.inner.options.current)().await;
        let mut push = Obj::new();
        push.insert("version".into(), version);
        push.insert("order".into(), order);
        push.insert("changed".into(), json!(["effort"]));
        push.insert("by".into(), json!(by));
        if let Some(summary) = summary.filter(|s| !s.is_empty()) {
            push.insert("summary".into(), json!(summary));
        }
        let mut effort = Obj::new();
        effort.insert("id".into(), json!(effort_id));
        if let Some(journal) = journal {
            effort.insert("journal".into(), js::number(journal));
        }
        push.insert("effort".into(), Value::Object(effort));
        publish(push);
    }

    /// Overlaps of each effort with the others and with branches (D23).
    fn overlaps(&self, efforts: &[Value]) -> HashMap<String, Vec<Value>> {
        let store = &self.inner.store;
        let sets: HashMap<String, HashSet<String>> = efforts
            .iter()
            .map(|effort| {
                let id = s(effort, &["id"]).to_owned();
                let ids = commits_of(store.derived(&id).as_ref())
                    .iter()
                    .map(|c| s(c, &["patchId"]).to_owned())
                    .collect();
                (id, ids)
            })
            .collect();
        let branches = self.inner.options.upstream.branches();
        let mut out = HashMap::new();
        for effort in efforts {
            let id = s(effort, &["id"]);
            let mine = &sets[id];
            let mut list: Vec<Value> = Vec::new();
            if !mine.is_empty() {
                for other in efforts {
                    if s(other, &["id"]) == id {
                        continue;
                    }
                    if let Some(found) = overlap_of(
                        mine,
                        &sets[s(other, &["id"])],
                        s(other, &["name"]),
                        "effort",
                    ) {
                        list.push(Value::Object(found));
                    }
                }
                for branch in &branches {
                    if branch.member.path == s(effort, &["clone", "path"]) {
                        continue;
                    }
                    let ids: HashSet<String> = branch
                        .commits
                        .iter()
                        .filter_map(|c| c.patch_id.clone().filter(|id| !id.is_empty()))
                        .collect();
                    if ids.is_empty() {
                        continue;
                    }
                    if let Some(found) = overlap_of(mine, &ids, &branch.branch, "branch")
                        && found.get("relation").and_then(Value::as_str) != Some("contains")
                    {
                        list.push(Value::Object(found));
                    }
                }
            }
            out.insert(id.to_owned(), list);
        }
        out
    }

    /// Resolves a ref name to one exact ref of the clone, else says why.
    pub async fn exact_ref(
        &self,
        connection: &dyn MrConnection,
        clone: &str,
        name: &str,
    ) -> RpcResult<String> {
        let short = name
            .strip_prefix("refs/heads/")
            .or_else(|| name.strip_prefix("refs/remotes/"))
            .unwrap_or(name);
        let script = format!(
            "git -C {} for-each-ref --format='%(refname)' {} {} {}",
            sh_quote(clone),
            sh_quote(&format!("refs/heads/{short}")),
            sh_quote(&format!("refs/remotes/{short}")),
            sh_quote(&format!("refs/remotes/*/{short}"))
        );
        let mut found: Vec<String> = Vec::new();
        for line in connection.run(&script, 30_000).await.stdout.split('\n') {
            if line.starts_with("refs/") && !found.iter().any(|f| f == line) {
                found.push(line.to_owned());
            }
        }
        if name.starts_with("refs/") && found.iter().any(|f| f == name) {
            return Ok(name.to_owned());
        }
        if found.len() == 1 {
            return Ok(found.remove(0));
        }
        // A local branch first, as git reads a short name.
        let local = format!("refs/heads/{short}");
        if !name.starts_with("refs/remotes/") && found.contains(&local) {
            return Ok(local);
        }
        Err(RpcError::invalid(if found.is_empty() {
            format!("No ref \"{name}\" in {clone}")
        } else {
            format!("\"{name}\" is ambiguous in {clone}: {}", found.join(", "))
        }))
    }

    /// Derives every due effort (after an inbox refresh, on a viewer).
    pub async fn refresh(&self, force: bool) {
        let known = efforts_of(&(self.inner.options.settings)().await);
        self.state().known = known.clone();
        for effort in &known {
            self.refresh_one(effort, force).await;
        }
    }

    /// The cards, from what is on disk (no git).
    pub fn summaries(&self, settings: &Obj) -> Vec<Value> {
        let efforts = efforts_of(settings);
        self.state().known = efforts.clone();
        let mut found = self.overlaps(&efforts);
        let store = &self.inner.store;
        efforts
            .iter()
            .map(|effort| {
                let id = s(effort, &["id"]);
                let head = effort.get("head").filter(|h| h.is_object()).map(|head| {
                    let mut out = Obj::new();
                    out.insert(
                        "connectionId".into(),
                        head.get("connectionId").cloned().unwrap_or(Value::Null),
                    );
                    if let Some(workspace) = head.get("workspaceId").filter(|w| truthy(Some(w))) {
                        out.insert("workspaceId".into(), workspace.clone());
                    }
                    Value::Object(out)
                });
                let ledger = store.ledger(id);
                let seen = store.seen(id);
                Value::Object(effort_summary(
                    effort,
                    store.derived(id).as_ref(),
                    found.remove(id).unwrap_or_default(),
                    head,
                    Some((&ledger, seen.as_ref())),
                ))
            })
            .collect()
    }

    /// Derives a candidate effort in a scratch place: what it would hold.
    pub async fn preview(&self, effort: &Effort, others: &[Value]) -> RpcResult<Obj> {
        let Some(connection) = self.connection_of(s(effort, &["clone", "connectionId"])) else {
            return Err(RpcError::with_code(
                "that connection is not ready",
                "unavailable",
            ));
        };
        let root = self
            .inner
            .options
            .root
            .join(format!(".preview-{}", js::number_text(self.now())));
        let scratch = LedgerStore::new(self.inner.options.context.clone(), root.clone());
        let service = self.clone();
        let requests_effort = effort.clone();
        let requests_connection = connection.clone();
        let (derived, _) = derive_effort(DeriveInput {
            effort,
            connection: &*connection,
            store: &scratch,
            check_target: true,
            requests: Box::new(move |url, _target| {
                Box::pin(async move {
                    Ok(service
                        .requests_for(&requests_effort, &*requests_connection, &url)
                        .await)
                })
            }),
            parts: vec![],
            elsewhere: vec![],
            now: self.now(),
            force: true,
        })
        .await;
        let mine: HashSet<String> = commits_of(Some(&derived))
            .iter()
            .map(|c| s(c, &["patchId"]).to_owned())
            .collect();
        let mut list: Vec<Value> = Vec::new();
        for other in others {
            let theirs: HashSet<String> =
                commits_of(self.inner.store.derived(s(other, &["id"])).as_ref())
                    .iter()
                    .map(|c| s(c, &["patchId"]).to_owned())
                    .collect();
            if let Some(found) = overlap_of(&mine, &theirs, s(other, &["name"]), "effort") {
                list.push(Value::Object(found));
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        Ok(effort_summary(effort, Some(&derived), list, None, None))
    }
}

/// `findEffort`: an effort named by id or name (case-insensitive).
pub fn find_effort(efforts: &[Value], name: &str) -> Option<Value> {
    let lower = js::trim(name).to_lowercase();
    efforts
        .iter()
        .find(|each| s(each, &["id"]) == name)
        .or_else(|| {
            efforts
                .iter()
                .find(|each| s(each, &["name"]).to_lowercase() == lower)
        })
        .cloned()
}

/// `repoParentWorkspace`: a linked worktree workspace's repository
/// parent, as the workspace menu finds it: the one Roamgate recorded, else
/// the only main checkout of the same repository. The workspace itself
/// when it is not a linked worktree.
pub fn repo_parent_workspace(workspaces: &[Value], workspace: &Value) -> Option<String> {
    let worktree = workspace.get("worktree");
    let linked = worktree.and_then(|w| w.get("is_linked_worktree"));
    if linked != Some(&Value::Bool(true)) {
        return if linked == Some(&Value::Bool(false)) {
            workspace
                .get("workspace_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
    }
    let worktree = worktree?;
    let repo_key = worktree.get("repo_key");
    let mains: Vec<&Value> = workspaces
        .iter()
        .filter(|each| {
            each.get("worktree")
                .and_then(|w| w.get("is_linked_worktree"))
                == Some(&Value::Bool(false))
                && repo_key.is_some_and(|k| truthy(Some(k)))
                && each.get("worktree").and_then(|w| w.get("repo_key")) == repo_key
                && each.get("workspace_id").is_some_and(Value::is_string)
        })
        .collect();
    let parent = worktree.get("parent_workspace_id");
    let explicit = parent.filter(|p| p.is_string()).and_then(|parent| {
        mains
            .iter()
            .find(|each| each.get("workspace_id") == Some(parent))
            .copied()
    });
    let chosen = explicit.or(if mains.len() == 1 {
        Some(mains[0])
    } else {
        None
    });
    chosen
        .and_then(|each| each.get("workspace_id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// `readableError`: an error as the user reads it, without Herdr's code
/// prefix (`linked_worktree_source: ...`) or a closing period, which the
/// toast adds.
pub fn readable_error(text: &str) -> String {
    static CODE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-z][a-z0-9_]*: ").expect("pattern"));
    let stripped = CODE.replace(text, "");
    js::trim(&stripped).trim_end_matches('.').to_owned()
}
