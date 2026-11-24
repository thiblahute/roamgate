//! The reviews module of the bridge (`mr-reviews/module.ts`): the inbox and
//! its settings, wired to settings.json and the user's glab and gh logins,
//! with every service of the crate put together as Bun puts them: the
//! order and its pushes, branches headed upstream, efforts, opening a
//! request, homes, the review workspace's Claude, links, placement in the
//! Workspaces tree, curation, inference, the board's tools and the reviews
//! agent, and the methods `bridge.mr_reviews.*` that are not the inbox's
//! own ([`MrReviews::handle`]).
//!
//! What the module cannot do itself comes in through [`MrReviewsOptions`]:
//! settings.json ([`SettingsFile`]), the forge reads, the connections, the
//! review service, the Workspaces tree, model runs and the agent's driver.
//! In the core these are reverse calls to Bun (crates/roamgate's
//! mr_reviews family).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

use roamgate_agents::js::{self, Obj};
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger};
use roamgate_base::paths::DataContext;
use roamgate_base::settings::SettingsStore;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::agent::{
    AgentTurn, MrAgent, MrAgentDeps, REVIEWS_AGENT_MODEL, ReviewsAgentDriver, mr_agent_path,
};
use crate::agent_tools::{MrAgentToolDeps, SaveHintsFn, SignalsFn};
use crate::board_tools::{BoardToolDeps, RpcFn, WorkspacesFn, board_tool};
use crate::claude::{
    AgentCommandFn, ConnectionsFn, MrClaude, MrClaudeDeps, RequestReviewFn, StartMode, StartModeFn,
};
use crate::clones::{CloneFinder, ProjectRef};
use crate::connection::BoxFuture;
use crate::curation::{Curation, CurationSettings, ModelAnswer, RunModel};
use crate::effort_service::rpc::{CallFn, EffortReviewFn};
use crate::effort_service::{
    EffortRpcDeps, EffortService, EffortServiceOptions, PublishFn, handle_effort_rpc,
};
use crate::fetchers::InboxFetchers;
use crate::history::{
    apply_ledgers, export_reviews, import_changes, imported_mr_reviews, parse_reviews_export,
    stable_json,
};
use crate::home::{
    CreateWorktreeFn, MadeWorktree, MrHomes, MrHomesDeps, OpenReviewFn, PlaceWorkspaceFn,
    WorkspaceAt,
};
use crate::inbox::{MrInbox, MrInboxDeps, SettingsFn, SleepUntilFn, Upstream, key_of, list};
use crate::inference::{Inference, InferenceSettings};
use crate::links::{WorkspaceAt as LinkAt, WorkspaceLinker};
use crate::open::{DefaultConnectionFn, MrOpener, MrOpenerDeps, SaveCloneFn};
use crate::order::{ChangeMeta, MrOrder, SaveFn, order_version, push_of, pushed_changes};
use crate::overrides::rename_override_keys;
use crate::rpc::{MoreFn, MrReviewsRpcDeps, RpcError, RpcResult, TreeFn, handle_mr_reviews_rpc};
use crate::settings::{mr_reviews_settings, normalize_stored_mr_reviews, stored_mr_reviews};
use crate::shared::types::{parse_branch_key, upstream_workspace_home};
use crate::store::{FOUND_KEPT_DAYS, MrStore};
use crate::tree::{Placement, review_placement_ops};
use crate::upstream::{
    UpstreamMember, UpstreamScanner, branch_entry, part_bases, request_of_branch,
};
use crate::worktree::LocalChanges;

/// How long the hosts found from the logins are kept.
const HOSTS_TTL_MS: f64 = 5.0 * 60_000.0;
const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;

/// A change of settings.json's `mr_reviews` (as stored, or absent) into
/// the next one, as stored. It may be asked again when the file moved.
pub type MrReviewsChange = Arc<dyn Fn(Option<&Obj>) -> Obj + Send + Sync>;

/// settings.json as the module reads and writes it (`readGuiSettings`,
/// `updateGuiSettings`): Bun's, the core's, or a file in tests.
pub trait SettingsFile: Send + Sync {
    /// The whole settings, normalized.
    fn read(&self) -> BoxFuture<'_, Result<Value, String>>;
    /// Writes `mr_reviews` changed by `change`; gives it as written.
    fn update_mr_reviews(&self, change: MrReviewsChange) -> BoxFuture<'_, Result<Obj, String>>;
}

impl SettingsFile for SettingsStore {
    fn read(&self) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async move {
            Ok(Value::Object(
                SettingsStore::read(self).await.as_map().clone(),
            ))
        })
    }

    fn update_mr_reviews(&self, change: MrReviewsChange) -> BoxFuture<'_, Result<Obj, String>> {
        Box::pin(async move {
            let written = self
                .update(|current| {
                    let next = change(current.get("mr_reviews").and_then(Value::as_object));
                    current.with("mr_reviews", Some(Value::Object(next)))
                })
                .await
                .map_err(|error| error.to_string())?;
            Ok(written
                .get("mr_reviews")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default())
        })
    }
}

/// Applies operations to the Workspaces tree.
pub type TreeApplyFn =
    Arc<dyn Fn(Vec<Value>) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// The Workspaces tree (settings `workspace_tree`): read it, apply ops.
#[derive(Clone)]
pub struct TreeAccess {
    pub read: crate::upstream::TreeFn,
    pub apply: TreeApplyFn,
}

/// The inference's models: the automatic one (the setting empty) and the
/// names the settings suggest.
#[derive(Clone)]
pub struct InferenceModels {
    pub automatic: Arc<dyn Fn() -> String + Send + Sync>,
    pub list: Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<String>, String>> + Send + Sync>,
}

/// The forge hosts the user's glab and gh logins have (`{host, provider}`).
pub type DiscoverFn = Arc<dyn Fn() -> Vec<Value> + Send + Sync>;
/// Drops a request's review (by its session id).
pub type RemoveReviewFn = Arc<dyn Fn(String) + Send + Sync>;

/// What [`MrReviews`] is made of (`createMrReviews`' options).
#[derive(Clone)]
pub struct MrReviewsOptions {
    pub context: DataContext,
    pub store: Arc<Mutex<MrStore>>,
    pub settings_file: Arc<dyn SettingsFile>,
    pub fetchers: Arc<dyn InboxFetchers>,
    pub discover_hosts: DiscoverFn,
    /// The ready connections, the default one first.
    pub connections: ConnectionsFn,
    /// The default connection, ready or not.
    pub default_connection: Option<DefaultConnectionFn>,
    /// The review pane: opens a request's review in its workspace.
    pub open_review: Option<OpenReviewFn>,
    /// The review pane's "review with the agent" for a request's review.
    pub request_review: Option<RequestReviewFn>,
    pub tree: Option<TreeAccess>,
    /// The model runner; None: none here (a run fails).
    pub run_model: Option<Arc<dyn RunModel>>,
    pub inference_models: Option<InferenceModels>,
    pub remove_review: Option<RemoveReviewFn>,
    /// The reviews agent's driver; None: the agent cannot run here.
    pub agent_driver: Option<Arc<dyn ReviewsAgentDriver>>,
    pub more: Option<MoreFn>,
    /// Tells every page the order, pins or removals changed.
    pub publish: Option<PublishFn>,
    /// Where efforts' ledgers live; else `<data>/mr-reviews/efforts`.
    pub efforts_dir: Option<PathBuf>,
    /// A worktree workspace through the user's worktree path:
    /// `{connectionId, branch, workspaceId | cwd}` to `{path, workspaceId?}`.
    pub create_worktree: Option<CallFn>,
    /// A Roamgate review of a range: `{sessionId, snapshot?}`.
    pub open_range: Option<CallFn>,
    pub effort_review: Option<EffortReviewFn>,
    /// A session's profile command (`commandForSession`).
    pub agent_command: Option<AgentCommandFn>,
    /// The clock the inbox's timers follow (a test clock); None: tokio's.
    pub clock: Option<SharedClock>,
    pub logger: Logger,
}

impl MrReviewsOptions {
    /// The options with nothing optional set.
    pub fn new(
        context: DataContext,
        store: Arc<Mutex<MrStore>>,
        settings_file: Arc<dyn SettingsFile>,
        fetchers: Arc<dyn InboxFetchers>,
    ) -> MrReviewsOptions {
        MrReviewsOptions {
            context,
            store,
            settings_file,
            fetchers,
            discover_hosts: Arc::new(Vec::new),
            connections: Arc::new(Vec::new),
            default_connection: None,
            open_review: None,
            request_review: None,
            tree: None,
            run_model: None,
            inference_models: None,
            remove_review: None,
            agent_driver: None,
            more: None,
            publish: None,
            efforts_dir: None,
            create_worktree: None,
            open_range: None,
            effort_review: None,
            agent_command: None,
            clock: None,
            logger: Logger::silent(),
        }
    }
}

/// A model runner where there is none: every run fails.
struct NoModel;

impl RunModel for NoModel {
    fn run<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, Result<ModelAnswer, String>> {
        Box::pin(async { Err("no model runner here".to_owned()) })
    }
}

/// The reviews agent's driver where there is none.
struct NoDriver;

impl ReviewsAgentDriver for NoDriver {
    fn run(&self, _: AgentTurn, _: CancellationToken) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Err("the reviews agent does not run here".to_owned()) })
    }
    fn stop(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    fn dispose(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

fn reviews(message: impl Into<String>, code: &str) -> RpcError {
    RpcError::with_code(message, code)
}

fn unavailable() -> RpcError {
    reviews("reviews are not available", "unavailable")
}

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn records(value: Option<&Value>) -> Vec<Obj> {
    list(value)
        .iter()
        .filter_map(Value::as_object)
        .cloned()
        .collect()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    list(value)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

struct Inner {
    options: MrReviewsOptions,
    logger: Logger,
    discovered: Mutex<Option<(f64, Vec<Value>)>>,
    clones: Arc<CloneFinder>,
    linker: WorkspaceLinker,
    curation: Arc<Curation>,
    upstream: Arc<UpstreamScanner>,
    efforts_root: PathBuf,
    efforts: EffortService,
    inference_models: InferenceModels,
    inference: Arc<Inference>,
    inbox: MrInbox,
    order: Arc<MrOrder>,
    opener: MrOpener,
    claude: MrClaude,
    homes: MrHomes,
    agent: Mutex<Option<MrAgent>>,
}

/// The reviews module (`createMrReviews`): a cheap clone.
#[derive(Clone)]
pub struct MrReviews(Arc<Inner>);

/// What a closure made before the module holds: the module, once made.
fn upgrade(weak: &Weak<Inner>) -> Option<MrReviews> {
    weak.upgrade().map(MrReviews)
}

impl MrReviews {
    pub fn new(options: MrReviewsOptions) -> MrReviews {
        MrReviews(Arc::new_cyclic(|weak: &Weak<Inner>| build(options, weak)))
    }

    pub fn inbox(&self) -> &MrInbox {
        &self.0.inbox
    }

    pub fn order(&self) -> &Arc<MrOrder> {
        &self.0.order
    }

    pub fn upstream(&self) -> &Arc<UpstreamScanner> {
        &self.0.upstream
    }

    pub fn efforts(&self) -> &EffortService {
        &self.0.efforts
    }

    pub fn store(&self) -> &Arc<Mutex<MrStore>> {
        &self.0.options.store
    }

    fn options(&self) -> &MrReviewsOptions {
        &self.0.options
    }

    /// settings.json as read now.
    async fn read_file(&self) -> Value {
        match self.options().settings_file.read().await {
            Ok(value) => value,
            Err(error) => {
                self.0.logger.warn(
                    "settings not read",
                    Some(&fields(&[("error", json!(error))])),
                );
                json!({})
            }
        }
    }

    /// The settings as saved: an empty hosts list means the logins'.
    pub async fn saved(&self) -> Obj {
        let file = self.read_file().await;
        mr_reviews_settings(file.get("mr_reviews").and_then(Value::as_object))
    }

    /// The settings in effect: hosts from the logins when none are set.
    pub async fn settings(&self) -> Obj {
        let mut value = self.saved().await;
        if !list(value.get("hosts")).is_empty() {
            return value;
        }
        let now = js::now_ms();
        let hosts = {
            let mut discovered = self.0.discovered.lock().unwrap_or_else(|e| e.into_inner());
            match discovered.as_ref() {
                Some((at, hosts)) if now - at <= HOSTS_TTL_MS => hosts.clone(),
                _ => {
                    let hosts = (self.options().discover_hosts)();
                    *discovered = Some((now, hosts.clone()));
                    hosts
                }
            }
        };
        value.insert("hosts".into(), Value::Array(hosts));
        value
    }

    fn forget_hosts(&self) {
        *self.0.discovered.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Saves the settings. A change of the order, the pins or the removals
    /// takes the next version (in the same write) and is pushed to every
    /// page.
    pub async fn save_settings(&self, next: Obj, meta: ChangeMeta) -> Result<Obj, String> {
        let seen: Arc<Mutex<(Vec<&'static str>, Option<Obj>)>> = Arc::default();
        let change: MrReviewsChange = {
            let seen = seen.clone();
            Arc::new(move |current: Option<&Obj>| {
                let before = mr_reviews_settings(current);
                let changed = pushed_changes(&before, &next);
                let version = order_version(&before) + i64::from(!changed.is_empty());
                let mut value = next.clone();
                value.insert("orderVersion".into(), json!(version));
                *seen.lock().unwrap_or_else(|e| e.into_inner()) = (changed, Some(before));
                stored_mr_reviews(&value)
            })
        };
        let written = self
            .options()
            .settings_file
            .update_mr_reviews(change)
            .await?;
        self.forget_hosts();
        let saved = mr_reviews_settings(Some(&written));
        let (changed, previous) = seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if !changed.is_empty() {
            // Undo needs what the change started from.
            if let Some(previous) = previous {
                self.0.order.seed(&previous);
            }
            self.0.order.remember(&saved);
            if let Some(publish) = &self.options().publish
                && let Value::Object(push) = push_of(&saved, &changed, &meta)
            {
                publish(push);
            }
        }
        Ok(saved)
    }

    /// Writes `mr_reviews` changed by `change` (nothing pushed).
    async fn update_stored(
        &self,
        change: impl Fn(Obj) -> Obj + Send + Sync + 'static,
    ) -> Result<(), String> {
        self.options()
            .settings_file
            .update_mr_reviews(Arc::new(move |current: Option<&Obj>| {
                stored_mr_reviews(&change(mr_reviews_settings(current)))
            }))
            .await
            .map(|_| ())
    }

    /// The efforts' parts as upstream members.
    fn effort_parts(&self, value: &Obj) -> Vec<UpstreamMember> {
        let mut out = Vec::new();
        for effort in records(value.get("efforts")) {
            let ledger = self.0.efforts.store().ledger(js::sv(effort.get("id")));
            let plans = list(ledger.get("plans")).to_vec();
            for plan in &plans {
                let Some(part) = plan.get("part").and_then(Value::as_object) else {
                    continue;
                };
                out.push(UpstreamMember {
                    connection_id: js::sv(part.get("connectionId")).to_owned(),
                    workspace_id: js::sv(part.get("workspaceId")).to_owned(),
                    label: js::sv(part.get("branch")).to_owned(),
                    path: js::sv(part.get("path")).to_owned(),
                    group: js::sv(effort.get("group")).to_owned(),
                    bases: part_bases(plan, &plans),
                    plan: Some(js::sv(plan.get("name")).to_owned()),
                });
            }
        }
        out
    }

    /// Branches headed upstream: their own rows, and the requests they are.
    pub fn upstream_rows(&self, value: &Obj) -> Upstream {
        let inbox = &self.0.inbox;
        let users = inbox.users();
        let ids = self.0.upstream.patch_ids();
        let branches = self.0.upstream.branches();
        // Each branch's request, by key: the requests read in place.
        let requests: Vec<Option<String>> = inbox.with_items(|items| {
            branches
                .iter()
                .map(|branch| {
                    request_of_branch(branch, items.iter().copied(), &ids, &[])
                        .map(|request| key_of(request).to_owned())
                })
                .collect()
        });
        let efforts = records(value.get("efforts"));
        let effort_of = |group: &str| {
            efforts
                .iter()
                .find(|each| js::sv(each.get("group")) == group)
        };
        let mut out = Upstream::default();
        for (branch, request) in branches.iter().zip(requests) {
            let effort = effort_of(&branch.member.group);
            if let Some(request) = request {
                let mut covered = Obj::new();
                if let Some(effort) = effort {
                    covered.insert(
                        "effort".into(),
                        effort.get("name").cloned().unwrap_or(Value::Null),
                    );
                }
                covered.insert("fromBranch".into(), json!(branch.branch));
                if branch.dirty != 0.0 || branch.unpushed.is_some_and(|n| n != 0.0) {
                    covered.insert(
                        "local".into(),
                        json!({
                            "unpushed": js::number(branch.unpushed.unwrap_or(0.0)),
                            "dirty": js::number(branch.dirty),
                            "workspace": branch.member.label,
                        }),
                    );
                }
                out.covered.insert(request, covered);
                continue;
            }
            // The effort's own source checkout is its card, not a row.
            if let Some(effort) = effort {
                let clone = effort
                    .get("clone")
                    .and_then(|clone| clone.get("path"))
                    .and_then(Value::as_str);
                if clone == Some(branch.member.path.as_str())
                    && js::sv(effort.get("source")).ends_with(&format!("/{}", branch.branch))
                {
                    continue;
                }
            }
            let mut row = branch_entry(
                branch,
                value,
                users.get(&branch.host).map_or("", String::as_str),
                &branches,
            );
            if let Some(effort) = effort {
                row.insert(
                    "effort".into(),
                    effort.get("name").cloned().unwrap_or(Value::Null),
                );
            }
            out.rows.push(row);
        }
        out
    }

    /// A request merged or closed `retentionDays` ago loses its review
    /// state here: its review, what was seen and picked. The project's
    /// review worktree stays.
    pub async fn lifecycle(&self) {
        let store = &self.options().store;
        // What the reviews agent found ages out once it is not touched.
        let found_cutoff = js::now_ms() - FOUND_KEPT_DAYS * DAY_MS;
        let stale: Vec<String> = {
            let store = store.lock().unwrap_or_else(|e| e.into_inner());
            js::rec(store.get().get("found"))
                .map(|found| {
                    found
                        .iter()
                        .filter(|(_, entry)| {
                            js::date_parse(js::sv(entry.get("at"))) <= found_cutoff
                        })
                        .map(|(key, _)| key.clone())
                        .collect()
                })
                .unwrap_or_default()
        };
        if !stale.is_empty() {
            let _ = store
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .update(|state| {
                    if let Some(found) = state.get_mut("found").and_then(Value::as_object_mut) {
                        for key in &stale {
                            found.remove(key);
                        }
                    }
                });
        }
        let days = js::to_number(self.settings().await.get("retentionDays"));
        let cutoff = js::now_ms() - days * DAY_MS;
        let gone: Vec<(String, String)> = {
            let store = store.lock().unwrap_or_else(|e| e.into_inner());
            js::rec(store.get().get("reviews"))
                .map(|reviews| {
                    reviews
                        .iter()
                        .filter(|(_, review)| {
                            js::non_empty(review.get("closedAt"))
                                .is_some_and(|at| js::date_parse(at) <= cutoff)
                        })
                        .map(|(key, review)| {
                            (key.clone(), js::sv(review.get("sessionId")).to_owned())
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        if gone.is_empty() {
            return;
        }
        if let Some(remove) = &self.options().remove_review {
            for (_, session) in &gone {
                remove(session.clone());
            }
        }
        let _ = store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update(|state| {
                for (key, _) in &gone {
                    for name in ["reviews", "seen", "ranked", "drafts", "homes"] {
                        if let Some(records) = state.get_mut(name).and_then(Value::as_object_mut) {
                            records.remove(key);
                        }
                    }
                }
            });
        self.0.logger.info(
            "closed requests' reviews dropped",
            Some(&fields(&[("count", json!(gone.len()))])),
        );
    }

    /// A branch headed upstream whose request opened takes the request's
    /// key everywhere the user's state names it (order, what was set by
    /// hand, dependencies), in one settings write; its "not proposed yet"
    /// goes (D6).
    pub async fn rekey_branches(&self) {
        let items = self.0.inbox.items();
        let this = self.clone();
        let result: Result<(), String> = self
            .0
            .order
            .edit(async move {
                let current = this.saved().await;
                let overrides = js::rec(current.get("overrides"))
                    .cloned()
                    .unwrap_or_default();
                let mut named: Vec<String> = Vec::new();
                let mut add = |key: String| {
                    if !named.contains(&key) {
                        named.push(key);
                    }
                };
                for key in strings(current.get("order")) {
                    add(key);
                }
                for each in records(current.get("unsent")) {
                    add(js::sv(each.get("key")).to_owned());
                }
                for key in overrides.keys() {
                    add(key.clone());
                }
                for each in overrides.values() {
                    for key in strings(each.get("dependsOn")) {
                        add(key);
                    }
                }
                let mut renames: Vec<(String, String)> = Vec::new();
                for key in &named {
                    let Some((provider, host, project, branch)) = parse_branch_key(key) else {
                        continue;
                    };
                    let request = items.iter().find(|item| {
                        list(item.get("reasons")).iter().any(|r| r == "authored")
                            && js::sv(item.get("state")) != "closed"
                            && js::sv(item.get("provider")) == provider
                            && js::js_lower(js::sv(item.get("host"))) == host
                            && js::js_lower(js::sv(item.get("project"))) == project
                            && js::sv(item.get("sourceBranch")) == branch
                    });
                    if let Some(request) = request {
                        renames.push((key.clone(), key_of(request).to_owned()));
                    }
                }
                if renames.is_empty() {
                    return Ok(());
                }
                let rename = |key: &str| {
                    renames
                        .iter()
                        .find(|(from, _)| from == key)
                        .map(|(_, to)| to.clone())
                };
                let mut overrides = overrides;
                for (from, to) in &renames {
                    overrides = rename_override_keys(&overrides, from, to);
                }
                let mut order: Vec<String> = Vec::new();
                for key in strings(current.get("order")) {
                    let next = rename(&key).unwrap_or(key);
                    if !order.contains(&next) {
                        order.push(next);
                    }
                }
                let unsent: Vec<Value> = list(current.get("unsent"))
                    .iter()
                    .filter(|each| rename(js::sv(each.get("key"))).is_none())
                    .cloned()
                    .collect();
                let mut next = current.clone();
                next.insert("order".into(), json!(order));
                next.insert("overrides".into(), Value::Object(overrides));
                next.insert("unsent".into(), Value::Array(unsent));
                this.save_settings(next, ChangeMeta::user()).await?;
                this.0.logger.info(
                    "branches took their requests' keys",
                    Some(&fields(&[("count", json!(renames.len()))])),
                );
                Ok(())
            })
            .await;
        if let Err(error) = result {
            self.0.logger.warn(
                "branches not rekeyed",
                Some(&fields(&[("error", json!(error))])),
            );
        }
    }

    /// The Workspaces tree changed: a group deleted from it is no longer
    /// headed upstream (D5).
    pub async fn tree_changed(&self, tree: &Value) {
        let groups: Vec<String> = crate::workspace_tree::nodes(tree)
            .into_iter()
            .filter(|node| js::sv(node.get("kind")) == "group")
            .map(|node| js::sv(node.get("id")).to_owned())
            .collect();
        let this = self.clone();
        let _ = self
            .0
            .order
            .edit(async move {
                let mut current = this.saved().await;
                let marked = strings(current.get("upstreamGroups"));
                let kept: Vec<String> = marked
                    .iter()
                    .filter(|id| groups.contains(id))
                    .cloned()
                    .collect();
                if kept.len() != marked.len() {
                    current.insert("upstreamGroups".into(), json!(kept));
                    this.save_settings(current, ChangeMeta::user()).await?;
                }
                Ok::<(), String>(())
            })
            .await;
        self.0.upstream.refresh(true).await;
    }

    /// The reviews agent's chat, made on first use.
    pub fn agent(&self) -> MrAgent {
        let mut agent = self.0.agent.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(agent) = agent.as_ref() {
            return agent.clone();
        }
        let made = MrAgent::new(MrAgentDeps {
            tools: self.agent_tool_deps(),
            context: self.options().context.clone(),
            path: mr_agent_path(&self.options().context.data_root()),
            model: REVIEWS_AGENT_MODEL.to_owned(),
            driver: self
                .options()
                .agent_driver
                .clone()
                .unwrap_or_else(|| Arc::new(NoDriver)),
        });
        *agent = Some(made.clone());
        made
    }

    fn settings_fn(&self) -> SettingsFn {
        let weak = Arc::downgrade(&self.0);
        settings_fn(&weak)
    }

    fn rpc_fn(&self) -> RpcFn {
        let weak = Arc::downgrade(&self.0);
        Arc::new(move |method: String, params: Obj| {
            let weak = weak.clone();
            Box::pin(async move {
                match upgrade(&weak) {
                    Some(this) => this.handle(&method, &params).await,
                    None => Err(unavailable()),
                }
            })
        })
    }

    fn agent_tool_deps(&self) -> MrAgentToolDeps {
        let weak = Arc::downgrade(&self.0);
        let signals: SignalsFn = {
            let weak = weak.clone();
            Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    let this = upgrade(&weak).expect("the module");
                    let hints = js::sv(this.settings().await.get("hints")).to_owned();
                    this.0.curation.signals(&this.0.inbox.items(), &hints).await
                })
            })
        };
        let save_hints: SaveHintsFn = {
            let weak = weak.clone();
            Arc::new(move |hints: String| {
                let weak = weak.clone();
                Box::pin(async move {
                    let Some(this) = upgrade(&weak) else {
                        return Err("the reviews are gone".to_owned());
                    };
                    this.update_stored(move |mut value| {
                        value.insert("hints".into(), json!(hints));
                        value
                    })
                    .await?;
                    this.forget_hosts();
                    Ok(())
                })
            })
        };
        MrAgentToolDeps {
            fetchers: self.options().fetchers.clone(),
            settings: self.settings_fn(),
            inbox: self.0.inbox.clone(),
            store: self.options().store.clone(),
            signals,
            save_hints,
            order: self.0.order.clone(),
            rpc: self.rpc_fn(),
            now: Arc::new(js::now_ms),
        }
    }

    /// `bridge.mr_reviews.*` (`handle`): the inbox's own methods, and the
    /// module's.
    pub async fn handle(&self, method: &str, params: &Obj) -> RpcResult<Value> {
        let this = self.clone();
        let more: MoreFn = Arc::new(move |method: String, params: Obj| {
            let this = this.clone();
            Box::pin(async move { this.more(&method, &params).await })
        });
        let settings: SettingsFn = {
            let this = self.clone();
            Arc::new(move || {
                let this = this.clone();
                Box::pin(async move {
                    // The settings page shows what is saved, and the hosts found.
                    let mut value = this.saved().await;
                    let discovered = if list(value.get("hosts")).is_empty() {
                        this.settings()
                            .await
                            .get("hosts")
                            .cloned()
                            .unwrap_or(json!([]))
                    } else {
                        json!([])
                    };
                    value.insert("discoveredHosts".into(), discovered);
                    let worktrees: Vec<Value> = {
                        let store = this
                            .options()
                            .store
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        js::rec(store.get().get("projects"))
                            .map(|projects| {
                                projects
                                    .iter()
                                    .map(|(project, record)| {
                                        json!({
                                            "project": project,
                                            "connectionId": record.get("connectionId").cloned().unwrap_or(Value::Null),
                                            "path": record.get("worktree").cloned().unwrap_or(Value::Null),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default()
                    };
                    value.insert("reviewWorktrees".into(), Value::Array(worktrees));
                    value
                })
            })
        };
        let upstream = self.0.upstream.clone();
        let deps = MrReviewsRpcDeps {
            inbox: self.0.inbox.clone(),
            settings,
            save_settings: save_fn(&Arc::downgrade(&self.0)),
            order: self.0.order.clone(),
            upstream_changed: Some(Arc::new(move || {
                let upstream = upstream.clone();
                Box::pin(async move { upstream.refresh(true).await })
            })),
            tree: self.rpc_tree(),
            more: Some(more),
        };
        handle_mr_reviews_rpc(&deps, method, params).await
    }

    fn rpc_tree(&self) -> Option<TreeFn> {
        let tree = self.options().tree.clone()?;
        Some(Arc::new(move || {
            let read = (tree.read)();
            Box::pin(async move { read.await.ok() })
        }))
    }

    /// One of the board's tools for an agent session (the review socket's
    /// `reviews` command): `caller` names it in what the user is told.
    pub async fn board_tool(&self, tool: &str, params: &Value, caller: &str) -> RpcResult<String> {
        let upstream = self.0.upstream.clone();
        let workspaces: WorkspacesFn = Arc::new(move || {
            let upstream = upstream.clone();
            Box::pin(async move { upstream.live().await })
        });
        let deps = BoardToolDeps {
            settings: self.settings_fn(),
            inbox: self.0.inbox.clone(),
            store: self.options().store.clone(),
            order: self.0.order.clone(),
            rpc: self.rpc_fn(),
            tree: self.rpc_tree(),
            workspaces: Some(workspaces),
        };
        board_tool(&deps, tool, params, caller).await
    }

    /// A request named by `key`, or by its review session (`session_id`).
    fn key(&self, params: &Obj) -> RpcResult<String> {
        // A request's review names it by its review session too.
        if let Some(session) = params.get("session_id").and_then(Value::as_str)
            && !params.get("key").is_some_and(js_truthy)
        {
            let store = self
                .options()
                .store
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let found = js::rec(store.get().get("reviews")).and_then(|reviews| {
                reviews
                    .iter()
                    .find(|(_, review)| js::sv(review.get("sessionId")) == session)
                    .map(|(key, _)| key.clone())
            });
            return found.ok_or_else(|| reviews("this review is not one of Reviews'", "not_found"));
        }
        match params.get("key") {
            Some(Value::String(key)) if !key.is_empty() => Ok(key.clone()),
            _ => Err(RpcError::invalid("key is required")),
        }
    }

    fn effort_deps(&self) -> EffortRpcDeps {
        let weak = Arc::downgrade(&self.0);
        let edit_order = self.0.order.clone();
        let entries = {
            let weak = weak.clone();
            Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    let Some(this) = upgrade(&weak) else {
                        return Vec::new();
                    };
                    let settings = this.settings().await;
                    records(this.0.inbox.snapshot(&settings).get("entries"))
                }) as BoxFuture<'static, Vec<Obj>>
            })
        };
        let group_label = {
            let weak = weak.clone();
            Arc::new(move |group: String| {
                let weak = weak.clone();
                Box::pin(async move {
                    let this = upgrade(&weak)?;
                    if let Some(tree) = &this.options().tree
                        && let Ok(tree) = (tree.read)().await
                        && let Some(node) = crate::workspace_tree::nodes(&tree)
                            .into_iter()
                            .find(|node| js::sv(node.get("id")) == group)
                        && js::sv(node.get("kind")) == "group"
                    {
                        return Some(js::sv(node.get("label")).to_owned());
                    }
                    // A workspace headed upstream by itself: its name.
                    let saved = this.saved().await;
                    let reference = records(saved.get("upstreamWorkspaces"))
                        .into_iter()
                        .find(|each| upstream_workspace_home(each) == group)?;
                    reference
                        .get("label")
                        .and_then(Value::as_str)
                        .or_else(|| reference.get("path").and_then(Value::as_str))
                        .map(str::to_owned)
                }) as BoxFuture<'static, Option<String>>
            })
        };
        let place: Option<CallFn> = self.options().tree.clone().map(|tree| {
            Arc::new(move |place: Obj| {
                let tree = tree.clone();
                Box::pin(async move {
                    let mut workspace = Obj::new();
                    workspace.insert(
                        "connection_id".into(),
                        place.get("connectionId").cloned().unwrap_or(Value::Null),
                    );
                    workspace.insert(
                        "path".into(),
                        place.get("path").cloned().unwrap_or(Value::Null),
                    );
                    if let Some(id) = js::non_empty(place.get("workspaceId")) {
                        workspace.insert("workspace_id".into(), json!(id));
                    }
                    let parent = match place.get("under").and_then(Value::as_object) {
                        Some(under) => {
                            let mut at = Obj::new();
                            at.insert(
                                "connection_id".into(),
                                under.get("connectionId").cloned().unwrap_or(Value::Null),
                            );
                            at.insert(
                                "path".into(),
                                under.get("path").cloned().unwrap_or(Value::Null),
                            );
                            if let Some(id) = js::non_empty(under.get("workspaceId")) {
                                at.insert("workspace_id".into(), json!(id));
                            }
                            json!({"workspace": at})
                        }
                        None => json!({"node": place.get("group").cloned().unwrap_or(Value::Null)}),
                    };
                    (tree.apply)(vec![json!({
                        "op": "move",
                        "subject": {"workspace": workspace},
                        "parent": parent,
                    })])
                    .await?;
                    Ok(Obj::new())
                }) as BoxFuture<'static, Result<Obj, String>>
            }) as CallFn
        });
        EffortRpcDeps {
            service: self.0.efforts.clone(),
            settings: saved_fn(&weak),
            edit: Arc::new(move |change| {
                let order = edit_order.clone();
                Box::pin(async move { order.edit(change).await })
            }),
            save: save_fn(&weak),
            upstream: self.0.upstream.clone(),
            entries: Some(entries),
            group_label,
            create_worktree: self.options().create_worktree.clone(),
            place,
            open_range: self.options().open_range.clone(),
            effort_review: self.options().effort_review.clone(),
        }
    }

    /// The module's own methods (module.ts's `more`).
    pub async fn more(&self, method: &str, params: &Obj) -> RpcResult<Value> {
        if (method.starts_with("bridge.mr_reviews.effort.")
            || method.starts_with("bridge.mr_reviews.ledger."))
            && let Some(answer) = handle_effort_rpc(&self.effort_deps(), method, params).await?
        {
            return Ok(answer);
        }
        match method {
            "bridge.mr_reviews.export" => self.export().await,
            "bridge.mr_reviews.import" => self.import(params).await,
            "bridge.mr_reviews.inference_models" => {
                // The settings' suggestions: the automatic model and the names to offer.
                let models = &self.0.inference_models;
                let automatic = (models.automatic)();
                let list = (models.list)().await.unwrap_or_default();
                Ok(json!({"automatic": automatic, "models": list}))
            }
            "bridge.mr_reviews.infer" => {
                // One row now (`:infer`, reviews_refresh), whatever the schedule.
                let target = self.key(params)?;
                self.0.inference.infer_row(&target).await;
                let settings = self.settings().await;
                let row = records(self.0.inbox.snapshot(&settings).get("entries"))
                    .into_iter()
                    .find(|entry| key_of(entry) == target)
                    .ok_or_else(|| reviews("not on the board", "not_found"))?;
                let mut out = Obj::new();
                out.insert("ok".into(), json!(true));
                out.insert("state".into(), self.0.inference.state());
                if let Some(inferred) = row.get("inferred").filter(|v| js_truthy(v)) {
                    out.insert("inferred".into(), inferred.clone());
                }
                out.insert(
                    "lane".into(),
                    row.get("lane").cloned().unwrap_or(Value::Null),
                );
                out.insert(
                    "next".into(),
                    row.get("next").cloned().unwrap_or(Value::Null),
                );
                Ok(Value::Object(out))
            }
            "bridge.mr_reviews.agent.get" => Ok(self.agent().snapshot()),
            "bridge.mr_reviews.agent.send" => {
                let text = match params.get("text") {
                    Some(Value::String(text)) if !js::trim(text).is_empty() => text.clone(),
                    _ => return Err(RpcError::invalid("text is required")),
                };
                let request_id = params
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|id| {
                        (1..=80).contains(&id.chars().count())
                            && id
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    })
                    .map(str::to_owned);
                let queue = params.get("when_busy").and_then(Value::as_str) == Some("queue");
                let agent = self.agent();
                let queued = agent
                    .send(&text, request_id.as_deref(), queue)
                    .map_err(|error| reviews(error, "busy"))?;
                Ok(json!({"queued": queued, "snapshot": agent.snapshot()}))
            }
            "bridge.mr_reviews.agent.unqueue" => {
                let removed = params
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.agent().unqueue(id));
                Ok(json!({"removed": removed}))
            }
            "bridge.mr_reviews.agent.stop" => {
                let agent = self.agent();
                agent.stop().await;
                Ok(agent.snapshot())
            }
            "bridge.mr_reviews.agent.reset" => {
                let agent = self.agent();
                agent.reset().await;
                Ok(agent.snapshot())
            }
            "bridge.mr_reviews.open" => self.open(params).await,
            "bridge.mr_reviews.home" => {
                // "Start a review with a home": a workspace of its own with an agent.
                let started = self.0.homes.start(&self.key(params)?).await?;
                self.0.linker.forget();
                Ok(Value::Object(started))
            }
            "bridge.mr_reviews.panel" => self.panel(params).await,
            "bridge.mr_reviews.workspaces" => Ok(self.workspaces()),
            "bridge.mr_reviews.links" => self.links(params).await,
            "bridge.mr_reviews.forget_worktree" => self.forget_worktree(params),
            "bridge.mr_reviews.claude" => {
                let claude = &self.0.claude;
                let state = match params.get("action").and_then(Value::as_str) {
                    Some("status") => claude.status(&self.key(params)?).await?,
                    Some("switch") => claude.ensure(&self.key(params)?, false, true).await?,
                    Some("start") => {
                        let wait = params.get("wait") == Some(&json!(true));
                        claude.ensure(&self.key(params)?, true, wait).await?
                    }
                    Some("review") => {
                        let focus = params
                            .get("focus")
                            .and_then(Value::as_str)
                            .map(|focus| js::head16(focus, 500));
                        claude.review(&self.key(params)?, focus.as_deref()).await?
                    }
                    _ => {
                        return Err(RpcError::invalid(
                            "action must be status, switch, start or review",
                        ));
                    }
                };
                Ok(state.to_json())
            }
            "bridge.mr_reviews.checkout" => {
                let local = match params.get("local") {
                    None | Some(Value::Null) => Some(LocalChanges::Refuse),
                    Some(Value::String(text)) => LocalChanges::parse(text),
                    Some(_) => None,
                }
                .ok_or_else(|| RpcError::invalid("local must be refuse, wip or discard"))?;
                self.0.opener.checkout(&self.key(params)?, local).await
            }
            "bridge.mr_reviews.clone" => {
                let text = |name: &str| params.get(name).and_then(Value::as_str);
                let provider = text("provider").filter(|p| *p == "gitlab" || *p == "github");
                match (
                    text("host"),
                    text("project"),
                    text("connection_id"),
                    text("path"),
                    provider,
                ) {
                    (Some(host), Some(project), Some(connection), Some(path), Some(provider))
                        if path.starts_with('/') =>
                    {
                        self.0
                            .opener
                            .set_clone(
                                &ProjectRef {
                                    host: host.to_owned(),
                                    project: project.to_owned(),
                                    provider: provider.to_owned(),
                                },
                                connection,
                                path,
                            )
                            .await
                    }
                    _ => Err(RpcError::invalid(
                        "host, project, provider, connection_id and an absolute path are required",
                    )),
                }
            }
            _ => match &self.options().more {
                Some(more) => more(method.to_owned(), params.clone()).await,
                None => Err(reviews(format!("unknown method: {method}"), "unknown")),
            },
        }
    }

    async fn open(&self, params: &Obj) -> RpcResult<Value> {
        // In one of its homes: its review shown there (D27).
        if let Some(home) = params.get("home").filter(|home| home.is_object()) {
            let (Some(connection), Some(workspace)) = (
                home.get("connection_id").and_then(Value::as_str),
                home.get("workspace_id").and_then(Value::as_str),
            ) else {
                return Err(RpcError::invalid(
                    "home: connection_id and workspace_id are required",
                ));
            };
            let at = WorkspaceAt {
                connection_id: connection.to_owned(),
                workspace_id: workspace.to_owned(),
            };
            return Ok(Value::Object(
                self.0.homes.open_in(&self.key(params)?, &at, None).await?,
            ));
        }
        let checkout = params
            .get("checkout")
            .and_then(Value::as_str)
            .filter(|c| *c == "now" || *c == "later");
        let key = self.key(params)?;
        let result = self.0.opener.open(&key, checkout).await?;
        let done = result
            .get("checkout")
            .and_then(|checkout| checkout.get("state"))
            .and_then(Value::as_str)
            == Some("done");
        if result.get("needClone").is_some() || !done {
            return Ok(result);
        }
        // After the checkout: the request's own Claude session, if it has
        // one; a busy Claude of another request is only reported.
        let state = match self.0.claude.ensure(&self.key(params)?, false, false).await {
            Ok(state) => state.to_json(),
            Err(error) => json!({"state": "error", "message": error.message()}),
        };
        let mut out = js::rec(Some(&result)).cloned().unwrap_or_default();
        out.insert("claude".into(), state);
        Ok(Value::Object(out))
    }

    async fn panel(&self, params: &Obj) -> RpcResult<Value> {
        // The panel's search and filter, kept for every device: pushed
        // apart from the authored state (no version, no Undo).
        let search = params
            .get("search")
            .and_then(Value::as_str)
            .map(|search| js::head16(search, 500));
        let filter = params
            .get("filter")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if search.is_none() && filter.is_none() {
            return Err(RpcError::invalid("search or filter is required"));
        }
        let this = self.clone();
        let panel = self
            .0
            .order
            .edit(async move {
                let current = this.saved().await;
                let previous = js::rec(current.get("panel")).cloned().unwrap_or_default();
                let last = js::date_parse(js::non_empty(previous.get("at")).unwrap_or("0"));
                let now = js::now_ms();
                let at = if last.is_nan() { now } else { now.max(last + 1.0) };
                let mut stored = stored_mr_reviews(&current);
                stored.insert(
                    "panel".into(),
                    json!({
                        "search": search.unwrap_or_else(|| js::sv(previous.get("search")).to_owned()),
                        "filter": filter.unwrap_or_else(|| js::sv(previous.get("filter")).to_owned()),
                        // Strictly after the last write: a page orders by it.
                        "at": js::iso(at),
                    }),
                );
                let normalized = normalize_stored_mr_reviews(Some(&Value::Object(stored)));
                let next = mr_reviews_settings(normalized.as_ref().and_then(Value::as_object));
                this.save_settings(next.clone(), ChangeMeta::user()).await?;
                Ok::<Value, String>(next.get("panel").cloned().unwrap_or(Value::Null))
            })
            .await?;
        let now = self.saved().await;
        if let Some(publish) = &self.options().publish {
            let mut push = Obj::new();
            push.insert("version".into(), json!(order_version(&now)));
            push.insert(
                "order".into(),
                now.get("order").cloned().unwrap_or(json!([])),
            );
            push.insert("changed".into(), json!(["panel"]));
            push.insert("by".into(), json!("user"));
            publish(push);
        }
        Ok(json!({"panel": panel}))
    }

    fn workspaces(&self) -> Value {
        // The review workspaces, for the sidebar: whose they are and the
        // request each is checked out on. No forge call.
        let store = self
            .options()
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = store.get();
        let items = records(state.get("items"));
        let mut out = Vec::new();
        for (project, record) in js::rec(state.get("projects")).into_iter().flatten() {
            let Some(workspace) = js::non_empty(record.get("workspaceId")) else {
                continue;
            };
            let mut entry = Obj::new();
            entry.insert(
                "connectionId".into(),
                record.get("connectionId").cloned().unwrap_or(Value::Null),
            );
            entry.insert("workspaceId".into(), json!(workspace));
            entry.insert("project".into(), json!(project));
            let current = js::non_empty(record.get("checkedOut"))
                .and_then(|key| items.iter().find(|item| key_of(item) == key));
            if let Some(current) = current {
                let mark = if js::sv(current.get("provider")) == "github" {
                    "#"
                } else {
                    "!"
                };
                entry.insert(
                    "current".into(),
                    json!({
                        "key": current.get("key").cloned().unwrap_or(Value::Null),
                        "label": format!(
                            "{mark}{} {}",
                            js::to_text(current.get("number").unwrap_or(&Value::Null)),
                            js::to_text(current.get("title").unwrap_or(&Value::Null)),
                        ),
                        "url": current.get("url").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            out.push(Value::Object(entry));
        }
        json!({"workspaces": out})
    }

    async fn links(&self, params: &Obj) -> RpcResult<Value> {
        // The workspaces that are each request's, on every connection: no
        // forge call. `keys` narrows it to those requests.
        let wanted: Option<Vec<String>> =
            params.get("keys").and_then(Value::as_array).map(|keys| {
                keys.iter()
                    .filter_map(Value::as_str)
                    .take(200)
                    .map(str::to_owned)
                    .collect()
            });
        let wants = |key: &str| {
            wanted
                .as_ref()
                .is_none_or(|wanted| wanted.iter().any(|k| k == key))
        };
        let items: Vec<Obj> = self
            .0
            .inbox
            .items()
            .into_iter()
            .filter(|item| wants(key_of(item)))
            .collect();
        // Its review workspace: where its review is, or the project's
        // review worktree while it is checked out on it.
        let (reviews, homes) = {
            let store = self
                .options()
                .store
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let state = store.get();
            let at = |record: &Obj| LinkAt {
                connection_id: js::sv(record.get("connectionId")).to_owned(),
                workspace_id: js::non_empty(record.get("workspaceId")).map(str::to_owned),
            };
            let mut reviews: HashMap<String, LinkAt> = js::rec(state.get("reviews"))
                .into_iter()
                .flatten()
                .filter_map(|(key, record)| Some((key.clone(), at(record.as_object()?))))
                .collect();
            for record in js::rec(state.get("projects"))
                .into_iter()
                .flatten()
                .filter_map(|(_, r)| r.as_object())
            {
                if let (Some(_), Some(checked)) = (
                    js::non_empty(record.get("workspaceId")),
                    js::non_empty(record.get("checkedOut")),
                ) {
                    reviews
                        .entry(checked.to_owned())
                        .or_insert_with(|| at(record));
                }
            }
            let homes: HashMap<String, LinkAt> = js::rec(state.get("homes"))
                .into_iter()
                .flatten()
                .filter_map(|(key, record)| Some((key.clone(), at(record.as_object()?))))
                .collect();
            (reviews, homes)
        };
        let mut links = self.0.linker.links(&items, &reviews, &homes).await;
        // A branch headed upstream: its own workspace.
        let rows = self.upstream_rows(&self.settings().await).rows;
        for row in rows {
            let Some(branch) = row.get("branch").and_then(Value::as_object) else {
                continue;
            };
            if !wants(key_of(&row)) {
                continue;
            }
            links.insert(
                key_of(&row).to_owned(),
                json!([{
                    "connectionId": branch.get("connectionId").cloned().unwrap_or(Value::Null),
                    "connectionLabel": branch.get("connectionLabel").cloned().unwrap_or(Value::Null),
                    "workspaceId": branch.get("workspaceId").cloned().unwrap_or(Value::Null),
                    "label": branch.get("workspaceLabel").cloned().unwrap_or(Value::Null),
                    "why": ["branch"],
                }]),
            );
        }
        Ok(json!({"links": links}))
    }

    fn forget_worktree(&self, params: &Obj) -> RpcResult<Value> {
        // The project's next review makes its worktree anew (on the
        // default connection first). The old worktree and its workspace
        // stay where they are, for the user to remove; reviews, Claude
        // sessions and drafts (on the forge) are kept.
        let project = params
            .get("project")
            .and_then(Value::as_str)
            .map(js::js_lower)
            .unwrap_or_default();
        let mut store = self
            .options()
            .store
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(record) = js::rec(store.get().get("projects"))
            .and_then(|projects| js::rec(projects.get(&project)))
            .cloned()
        else {
            return Err(reviews("no review worktree for that project", "not_found"));
        };
        let marker = format!(":{project}#");
        store
            .update(|state| {
                if let Some(projects) = state.get_mut("projects").and_then(Value::as_object_mut) {
                    projects.remove(&project);
                }
                if let Some(prefetched) = state.get_mut("prefetched").and_then(Value::as_object_mut)
                {
                    prefetched.retain(|key, _| !js::js_lower(key).contains(&marker));
                }
            })
            .map_err(|error| RpcError::Failed(error.to_string()))?;
        drop(store);
        self.0.logger.info(
            "review worktree forgotten",
            Some(&fields(&[
                ("project", json!(project)),
                (
                    "connection",
                    record.get("connectionId").cloned().unwrap_or(Value::Null),
                ),
                (
                    "worktree",
                    record.get("worktree").cloned().unwrap_or(Value::Null),
                ),
            ])),
        );
        Ok(json!({"forgotten": record}))
    }

    async fn export(&self) -> RpcResult<Value> {
        // What the Reviews authored, as the CLI's `roamgate reviews export`.
        let stored = Value::Object(stored_mr_reviews(&self.saved().await));
        let value = export_reviews(Some(&stored), &self.0.efforts_root, js::now_ms());
        Ok(json!({"text": stable_json(&value.to_value())}))
    }

    async fn import(&self, params: &Obj) -> RpcResult<Value> {
        // What an export would change; applied only when asked (never silent).
        let text = match params.get("text") {
            Some(Value::String(text)) if text.len() <= 50_000_000 => text,
            _ => return Err(RpcError::invalid("text: an export's JSON")),
        };
        let incoming = parse_reviews_export(text).map_err(RpcError::invalid)?;
        let stored = Value::Object(stored_mr_reviews(&self.saved().await));
        let local = export_reviews(Some(&stored), &self.0.efforts_root, js::now_ms());
        let changes = import_changes(&local, &incoming);
        let changes = Value::Array(changes.iter().map(|change| change.to_value()).collect());
        if params.get("apply") != Some(&json!(true)) {
            return Ok(json!({"applied": false, "changes": changes}));
        }
        let this = self.clone();
        let applied = incoming.clone();
        self.0
            .order
            .edit(async move {
                let current = Value::Object(stored_mr_reviews(&this.saved().await));
                let next = normalize_stored_mr_reviews(Some(&Value::Object(imported_mr_reviews(
                    Some(&current),
                    &applied,
                ))));
                this.save_settings(
                    mr_reviews_settings(next.as_ref().and_then(Value::as_object)),
                    ChangeMeta::user(),
                )
                .await
            })
            .await?;
        let ledgers = apply_ledgers(&self.options().context, &incoming, &self.0.efforts_root)
            .map_err(|error| RpcError::Failed(error.to_string()))?;
        let efforts = self.0.efforts.clone();
        tokio::spawn(async move { efforts.refresh(true).await });
        self.0.inbox.changed();
        Ok(json!({"applied": true, "changes": changes, "ledgers": ledgers}))
    }

    pub fn start(&self) {
        self.0.inbox.start();
    }

    pub fn stop(&self) {
        self.0.inbox.stop();
        if let Some(agent) = self
            .0
            .agent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            tokio::spawn(async move { agent.dispose().await });
        }
    }
}

/// JavaScript truthiness of a value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn settings_fn(weak: &Weak<Inner>) -> SettingsFn {
    let weak = weak.clone();
    Arc::new(move || {
        let weak = weak.clone();
        Box::pin(async move {
            match upgrade(&weak) {
                Some(this) => this.settings().await,
                None => mr_reviews_settings(None),
            }
        })
    })
}

fn saved_fn(weak: &Weak<Inner>) -> SettingsFn {
    let weak = weak.clone();
    Arc::new(move || {
        let weak = weak.clone();
        Box::pin(async move {
            match upgrade(&weak) {
                Some(this) => this.saved().await,
                None => mr_reviews_settings(None),
            }
        })
    })
}

fn save_fn(weak: &Weak<Inner>) -> SaveFn {
    let weak = weak.clone();
    Arc::new(move |next: Obj, meta: ChangeMeta| {
        let weak = weak.clone();
        Box::pin(async move {
            match upgrade(&weak) {
                Some(this) => this.save_settings(next, meta).await,
                None => Err("the reviews are gone".to_owned()),
            }
        })
    })
}

fn start_mode_fn(settings_file: &Arc<dyn SettingsFile>) -> StartModeFn {
    let settings_file = settings_file.clone();
    Arc::new(move || {
        let settings_file = settings_file.clone();
        Box::pin(async move {
            let file = settings_file.read().await.unwrap_or_default();
            if file.get("claude_start_mode").and_then(Value::as_str) == Some("conversation") {
                StartMode::Conversation
            } else {
                StartMode::Terminal
            }
        })
    })
}

/// Spawns a future when a runtime runs (hooks run inside one).
fn spawn(future: impl std::future::Future<Output = ()> + Send + 'static) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(future);
    }
}

fn build(options: MrReviewsOptions, weak: &Weak<Inner>) -> Inner {
    let logger = options.logger.child("mr-reviews");
    let store = options.store.clone();
    let connections = options.connections.clone();
    let settings = settings_fn(weak);
    let saved = saved_fn(weak);
    let run_model: Arc<dyn RunModel> = options
        .run_model
        .clone()
        .unwrap_or_else(|| Arc::new(NoModel));
    let clones = Arc::new(CloneFinder::new());
    let linker = WorkspaceLinker::new(connections.clone());

    let mut curation = Curation::new(
        store.clone(),
        {
            let settings = settings.clone();
            Arc::new(move || {
                let settings = settings();
                Box::pin(async move {
                    let value = settings.await;
                    CurationSettings {
                        curation: value.get("curation") != Some(&json!(false)),
                        hints: js::sv(value.get("hints")).to_owned(),
                        followed: list(value.get("followed")).len(),
                        suggest_days: js::num(value.get("suggestDays")),
                    }
                })
            })
        },
        run_model.clone(),
    );
    curation.connections = connections.clone();
    curation.clones = Some({
        let weak = weak.clone();
        Arc::new(move || {
            let weak = weak.clone();
            Box::pin(async move {
                let Some(this) = upgrade(&weak) else {
                    return Vec::new();
                };
                let value = this.settings().await;
                let mut found = Vec::new();
                for project in records(value.get("followed")) {
                    let project = ProjectRef {
                        host: js::sv(project.get("host")).to_owned(),
                        project: js::sv(project.get("project")).to_owned(),
                        provider: js::sv(project.get("provider")).to_owned(),
                    };
                    for clone in this
                        .0
                        .clones
                        .find(&(this.options().connections)(), &project)
                        .await
                    {
                        found.push((
                            CloneFinder::key(&project.host, &project.project),
                            clone.path.clone(),
                        ));
                    }
                }
                found
            })
        })
    });
    curation.users = Some({
        let weak = weak.clone();
        Arc::new(move || {
            upgrade(&weak)
                .map(|this| this.0.inbox.users())
                .unwrap_or_default()
        })
    });
    let curation = Arc::new(curation);

    // Branches headed upstream, read from the marked groups' workspaces.
    let tree_read: crate::upstream::TreeFn = match &options.tree {
        Some(tree) => tree.read.clone(),
        None => Arc::new(|| Box::pin(async { Ok(json!({"version": 1, "nodes": []})) })),
    };
    let mut upstream = UpstreamScanner::new(connections.clone(), tree_read, {
        let settings = settings.clone();
        Arc::new(move || {
            let settings = settings();
            Box::pin(async move { Ok(settings.await) })
        })
    });
    upstream.items = Some({
        let weak = weak.clone();
        Arc::new(move || {
            upgrade(&weak)
                .map(|this| this.0.inbox.items())
                .unwrap_or_default()
        })
    });
    // Read when the scan runs, after the efforts are made below.
    upstream.parts = Some({
        let weak = weak.clone();
        Arc::new(move |value: &Obj| {
            upgrade(&weak)
                .map(|this| this.effort_parts(value))
                .unwrap_or_default()
        })
    });
    let upstream = Arc::new(upstream);

    let efforts_root = options.efforts_dir.clone().unwrap_or_else(|| {
        options
            .context
            .data_root()
            .join("mr-reviews")
            .join("efforts")
    });
    let efforts = EffortService::new(EffortServiceOptions {
        context: options.context.clone(),
        root: efforts_root.clone(),
        settings: saved.clone(),
        connections: connections.clone(),
        items: {
            let weak = weak.clone();
            Arc::new(move || {
                upgrade(&weak)
                    .map(|this| this.0.inbox.items())
                    .unwrap_or_default()
            })
        },
        upstream: upstream.clone(),
        publish: options.publish.clone(),
        current: {
            let saved = saved.clone();
            Arc::new(move || {
                let saved = saved();
                Box::pin(async move {
                    let value = saved.await;
                    (
                        json!(order_version(&value)),
                        value.get("order").cloned().unwrap_or(json!([])),
                    )
                })
            })
        },
        now: None,
    });

    // Whose move it is, inferred (section 7): twice a day and on meaningful events.
    let inference_models = options
        .inference_models
        .clone()
        .unwrap_or_else(|| InferenceModels {
            automatic: Arc::new(String::new),
            list: Arc::new(|| Box::pin(async { Ok(Vec::new()) })),
        });
    let mut inference = Inference::new(
        store.clone(),
        {
            let settings = settings.clone();
            Arc::new(move || {
                let settings = settings();
                Box::pin(async move {
                    let value = settings.await;
                    let defaults = InferenceSettings::default();
                    InferenceSettings {
                        inference: value.get("inference") != Some(&json!(false)),
                        inference_hours: js::num(value.get("inferenceHours"))
                            .unwrap_or(defaults.inference_hours),
                        inference_model: js::sv(value.get("inferenceModel")).to_owned(),
                    }
                })
            })
        },
        {
            let weak = weak.clone();
            Arc::new(move || {
                let weak = weak.clone();
                Box::pin(async move {
                    let Some(this) = upgrade(&weak) else {
                        return Vec::new();
                    };
                    let settings = this.settings().await;
                    records(this.0.inbox.snapshot(&settings).get("entries"))
                })
            })
        },
        {
            let weak = weak.clone();
            Arc::new(move || {
                upgrade(&weak)
                    .map(|this| this.0.inbox.users())
                    .unwrap_or_default()
            })
        },
        run_model,
    );
    inference.patch_ids = Some({
        let upstream = upstream.clone();
        Arc::new(move || upstream.patch_ids())
    });
    inference.automatic_model = Some(inference_models.automatic.clone());
    inference.on_change = Some({
        let weak = weak.clone();
        Arc::new(move || {
            if let Some(this) = upgrade(&weak) {
                this.0.inbox.changed();
            }
        })
    });
    let inference = Arc::new(inference);

    let mut deps = MrInboxDeps::new(options.fetchers.clone(), settings.clone(), store.clone());
    deps.logger = logger.clone();
    deps.sleep_until = options.clock.clone().map(|clock| {
        Arc::new(move |deadline: f64| clock.sleep_until(deadline.ceil() as i64)) as SleepUntilFn
    });
    deps.upstream = Some({
        let weak = weak.clone();
        Arc::new(move |value: &Obj| {
            upgrade(&weak)
                .map(|this| this.upstream_rows(value))
                .unwrap_or_default()
        })
    });
    deps.efforts = Some({
        let weak = weak.clone();
        Arc::new(move |value: &Obj| {
            upgrade(&weak)
                .map(|this| this.0.efforts.summaries(value))
                .unwrap_or_default()
        })
    });
    deps.on_viewer = Some({
        let weak = weak.clone();
        Arc::new(move || {
            let Some(this) = upgrade(&weak) else {
                return;
            };
            spawn(async move {
                this.0.upstream.refresh(false).await;
                this.0.efforts.refresh(false).await;
            });
        })
    });
    deps.after_refresh = Some({
        let weak = weak.clone();
        Arc::new(move |items: Vec<Obj>| {
            let this = upgrade(&weak)?;
            {
                let opener = this.0.opener.clone();
                let items = items.clone();
                spawn(async move { opener.prefetch(&items).await });
            }
            {
                let this = this.clone();
                spawn(async move { this.lifecycle().await });
            }
            {
                let curation = this.0.curation.clone();
                spawn(async move { curation.maybe_run(&items, false).await });
            }
            // The branches read again, then the inference: the refresh ends
            // once the inference decided whether it runs when nothing
            // before it reads a checkout, as Bun's ends with its state set.
            Some(Box::pin(async move {
                let settings = this.settings().await;
                let quick = this
                    .0
                    .upstream
                    .quick(&settings, !this.effort_parts(&settings).is_empty());
                let work = {
                    let this = this.clone();
                    async move {
                        this.0.upstream.refresh(false).await;
                        this.rekey_branches().await;
                        let efforts = this.0.efforts.clone();
                        spawn(async move { efforts.refresh(false).await });
                        this.0.inference.maybe_run_decided().await;
                    }
                };
                if quick {
                    work.await;
                } else {
                    spawn(work);
                }
            }) as BoxFuture<'static, ()>)
        })
    });
    deps.curation = Some({
        let curation = curation.clone();
        Arc::new(move || curation.state())
    });
    deps.inference = Some({
        let inference = inference.clone();
        Arc::new(move || inference.state())
    });
    deps.on_merge_time = Some({
        let inference = inference.clone();
        Arc::new(move || {
            let inference = inference.clone();
            spawn(async move { inference.maybe_run().await });
        })
    });
    let inbox = MrInbox::new(deps);
    let order = Arc::new(MrOrder::new(inbox.clone(), saved.clone(), save_fn(weak)));

    // A new review workspace (the project's, or a request's home) goes
    // where the project's reviews go in the Workspaces tree.
    let place_review_workspace: Option<PlaceWorkspaceFn> = options.tree.clone().map(|tree| {
        let settings = settings.clone();
        Arc::new(move |place: Obj| {
            let tree = tree.clone();
            let settings = settings();
            Box::pin(async move {
                let path: Option<Vec<String>> = js::rec(settings.await.get("treeGroups"))
                    .and_then(|groups| groups.get(js::sv(place.get("projectKey"))))
                    .map(|path| strings(Some(path)));
                let current = (tree.read)().await?;
                let reference = json!({
                    "connection_id": place.get("connectionId").cloned().unwrap_or(Value::Null),
                    "path": place.get("worktree").cloned().unwrap_or(Value::Null),
                    "label": place.get("label").cloned().unwrap_or(Value::Null),
                    "workspace_id": place.get("workspaceId").cloned().unwrap_or(Value::Null),
                });
                let ops = review_placement_ops(
                    &current,
                    &Placement {
                        reference: &reference,
                        connection_id: js::sv(place.get("connectionId")),
                        clone_path: js::sv(place.get("clone")),
                        path: path.as_deref(),
                    },
                    None,
                );
                (tree.apply)(ops).await
            }) as BoxFuture<'static, Result<(), String>>
        }) as PlaceWorkspaceFn
    });
    let open_review: OpenReviewFn = match options.open_review.clone() {
        Some(open) => open,
        None => Arc::new(|_| Box::pin(async { Err(unavailable()) })),
    };
    let item_fn = {
        let inbox = inbox.clone();
        Arc::new(move |key: &str| inbox.item(key))
    };
    let mark_seen = {
        let inbox = inbox.clone();
        Arc::new(move |key: &str| {
            inbox.mark_seen(key);
        })
    };
    let save_clone: SaveCloneFn = {
        let settings_file = options.settings_file.clone();
        Arc::new(move |key: String, clone: Obj| {
            let settings_file = settings_file.clone();
            Box::pin(async move {
                settings_file
                    .update_mr_reviews(Arc::new(move |current: Option<&Obj>| {
                        let mut value = mr_reviews_settings(current);
                        let mut clones = js::rec(value.get("clones")).cloned().unwrap_or_default();
                        clones.insert(key.clone(), Value::Object(clone.clone()));
                        value.insert("clones".into(), Value::Object(clones));
                        stored_mr_reviews(&value)
                    }))
                    .await
                    .map(|_| ())
                    .map_err(RpcError::Failed)
            })
        })
    };
    let opener = MrOpener::new(MrOpenerDeps {
        item: item_fn.clone(),
        mark_seen: mark_seen.clone(),
        store: store.clone(),
        settings: settings.clone(),
        save_clone,
        connections: connections.clone(),
        default_connection: options.default_connection.clone(),
        clones: clones.clone(),
        place_workspace: place_review_workspace.clone(),
        open_review: open_review.clone(),
        logger: logger.clone(),
    });

    let request_review: RequestReviewFn = match options.request_review.clone() {
        Some(request) => request,
        None => Arc::new(|_| Box::pin(async { Err(unavailable()) })),
    };
    let start_mode = start_mode_fn(&options.settings_file);
    let mut claude_deps =
        MrClaudeDeps::new(item_fn, store.clone(), connections.clone(), request_review);
    claude_deps.start_mode = Some(start_mode.clone());
    claude_deps.agent_command = options.agent_command.clone();
    let claude = MrClaude::new(claude_deps);

    // Requests' homes: their review shown there, made with an agent (D27).
    let mut home_deps = MrHomesDeps::new(
        {
            let inbox = inbox.clone();
            Arc::new(move |key: &str| {
                inbox
                    .item(key)
                    .ok_or_else(|| reviews("no such request in the inbox", "not_found"))
            })
        },
        store.clone(),
        connections.clone(),
        saved.clone(),
        opener.project_fn(),
        open_review,
        mark_seen,
    );
    home_deps.create_worktree = options.create_worktree.clone().map(|create| {
        Arc::new(move |input: Obj| {
            let made = create(input);
            Box::pin(async move {
                let made = made.await?;
                Ok(MadeWorktree {
                    path: js::sv(made.get("path")).to_owned(),
                    workspace_id: js::non_empty(made.get("workspaceId")).map(str::to_owned),
                })
            }) as BoxFuture<'static, Result<MadeWorktree, String>>
        }) as CreateWorktreeFn
    });
    home_deps.place_workspace = place_review_workspace.clone();
    home_deps.start_mode = Some(start_mode);
    home_deps.agent_command = options.agent_command.clone();
    home_deps.logger = logger.clone();
    let homes = MrHomes::new(home_deps);

    Inner {
        logger,
        discovered: Mutex::new(None),
        clones,
        linker,
        curation,
        upstream,
        efforts_root,
        efforts,
        inference_models,
        inference,
        inbox,
        order,
        opener,
        claude,
        homes,
        agent: Mutex::new(None),
        options,
    }
}

#[cfg(test)]
mod tests;
