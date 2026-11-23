//! `bridge.mr_reviews.effort.*` and `ledger.*` (`handleEffortRpc`):
//! declare, update, delete, read, refresh and preview efforts; set and
//! undo dispositions; plan requests and make their parts. Nothing here
//! touches a forge beyond git fetches of the target (D13).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use super::scripts::{
    FIXUP, PortedDifference, branch_worktrees_script, carries_script, parse_branch_worktrees,
    parse_carries, parse_part_checkout, parse_part_content, parse_part_stops, parse_pick,
    parse_prepared, part_checkout_script, part_content_script, part_stops_script, pick_script,
    picked_on_branch, ported_difference, prepared_script,
};
use super::{EffortService, find_effort, readable_error, repo_parent_workspace, s, strings};
use crate::connection::{BoxFuture, MrConnection, sh_quote};
use crate::effort_board::effort_plan_entries;
use crate::efforts::{
    Author, Decision, change_plans, changes_of, decide_matches, find_plan, is_authored_disposition,
    new_id, set_dispositions, snapshot_of, undo_ledger, upstream_ref,
};
use crate::inbox::{SettingsFn, truthy};
use crate::order::{ChangeMeta, SaveFn};
use crate::rpc::{RpcError, RpcResult, change};
use crate::shared::types::{fixup_targets, upstream_workspace_home};
use crate::upstream::UpstreamScanner;

/// Runs a settings change after those asked before it (`editSettings`):
/// the settings it saved.
pub type EditFn = Arc<
    dyn Fn(BoxFuture<'static, Result<Obj, String>>) -> BoxFuture<'static, Result<Obj, String>>
        + Send
        + Sync,
>;
/// The inbox's entries as computed (no forge call): the Board's cards.
pub type EntriesFn = Arc<dyn Fn() -> BoxFuture<'static, Vec<Obj>> + Send + Sync>;
/// A group's label (a workspace headed upstream by itself: its name).
pub type GroupLabelFn = Arc<dyn Fn(String) -> BoxFuture<'static, Option<String>> + Send + Sync>;
/// An object in, an object (or nothing) out, or the error's text.
pub type CallFn = Arc<dyn Fn(Obj) -> BoxFuture<'static, Result<Obj, String>> + Send + Sync>;
/// The effort's review (`effortReview`): its snapshot, or null.
pub type EffortReviewFn = Arc<dyn Fn(Obj) -> BoxFuture<'static, Value> + Send + Sync>;

/// What the methods need (`handleEffortRpc`'s deps).
#[derive(Clone)]
pub struct EffortRpcDeps {
    pub service: EffortService,
    pub settings: SettingsFn,
    pub edit: EditFn,
    pub save: SaveFn,
    pub upstream: Arc<UpstreamScanner>,
    pub entries: Option<EntriesFn>,
    pub group_label: GroupLabelFn,
    /// Makes a worktree workspace through the user's worktree path (the
    /// `worktree_command` setting, else Herdr's), from the repository's
    /// parent workspace, or from its main checkout's path (`cwd`) when no
    /// workspace is open there: `{connectionId, branch, workspaceId | cwd}`
    /// to `{path, workspaceId?}`.
    pub create_worktree: Option<CallFn>,
    /// Puts a workspace in the Workspaces tree: under the workspace `under`
    /// (nested in its node, as Move into... does) when given, else into the
    /// group `group`: `{connectionId, path, workspaceId?, group, under?}`.
    pub place: Option<CallFn>,
    /// Opens a Roamgate review of a range in a workspace's Changes:
    /// `{connectionId, workspaceId, root, base, head, title, compare?}` to
    /// `{sessionId, snapshot?}`.
    pub open_range: Option<CallFn>,
    /// The effort's review: the threads on its view, for its leader. Found
    /// by the effort wherever it was opened; made in the head's checkout
    /// when `open` (the first comment), else null.
    pub effort_review: Option<EffortReviewFn>,
}

static SHA_PARAM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,40}$").expect("pattern"));
static BRANCH_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_./-]*$").expect("pattern"));
static SLUG_OUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9._/-]+").expect("pattern"));
static SLUG_EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-+|-+$").expect("pattern"));

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid(message)
}

fn coded(message: impl Into<String>, code: &str) -> RpcError {
    RpcError::with_code(message, code)
}

fn not_ready() -> RpcError {
    coded("that connection is not ready", "unavailable")
}

/// `String(value ?? fallback)`.
fn text_of(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(value) => js::to_text(value),
    }
}

/// `typeof value === "string"`.
fn string_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn is_branch_name(name: &str) -> bool {
    BRANCH_NAME.is_match(name) && !name.contains("..")
}

fn slug_of(name: &str) -> String {
    let lower = name.to_lowercase();
    let replaced = SLUG_OUT.replace_all(&lower, "-");
    js::head16(&SLUG_EDGES.replace_all(&replaced, ""), 60)
}

fn upstream_of(name: &str) -> String {
    if name.starts_with("upstream/") {
        name.to_owned()
    } else {
        format!("upstream/{name}")
    }
}

fn plans_of(ledger: &Obj) -> Vec<Value> {
    ledger
        .get("plans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn part_of(plan: &Value) -> Option<&Value> {
    plan.get("part").filter(|p| p.is_object())
}

fn obj(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Obj::new(),
    }
}

fn put_some(out: &mut Obj, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.into(), value);
    }
}

/// `{ sha, subject, files, folding? }`: a part's stop as recorded.
fn conflict_value(sha: &str, subject: &str, files: &[String], folding: bool) -> Value {
    let mut out = obj(json!({"sha": sha, "subject": subject, "files": files}));
    if folding {
        out.insert("folding".into(), json!(true));
    }
    Value::Object(out)
}

fn differs(ported: &PortedDifference) -> Value {
    json!({
        "only_in_plan": ported.only_in_plan,
        "only_in_branch": ported.only_in_branch,
        "summary": ported.summary,
    })
}

/// A made worktree: its path and workspace.
struct Made {
    path: String,
    workspace_id: Option<String>,
}

impl Made {
    fn of(value: &Obj) -> Made {
        Made {
            path: js::sv(value.get("path")).to_owned(),
            workspace_id: value
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|w| !w.is_empty())
                .map(str::to_owned),
        }
    }
}

/// Where a part's worktree starts: a workspace, or a checkout's path.
enum PartSource {
    Workspace(String),
    Cwd(String),
}

impl PartSource {
    fn put(&self, input: &mut Obj) {
        match self {
            PartSource::Workspace(id) => input.insert("workspaceId".into(), json!(id)),
            PartSource::Cwd(path) => input.insert("cwd".into(), json!(path)),
        };
    }
}

/// `mainCheckout`: the main checkout of the repository a checkout belongs
/// to, where Herdr starts new worktrees from: the folder of its git
/// common directory (`<root>/.git`); for a clone kept in a repository
/// directory, as gstreamer.git is (the first entry of `git worktree
/// list`, with no work tree of its own), the checkout the MR home finds
/// for it (`homeSourceScript`: the one its `gitdir` file names,
/// `core.worktree`, or the directory beside it without `.git`, when that
/// checkout's repository is this one). The checkout is None when the
/// repository has no checkout of its own (a bare one, or one whose
/// checkout is gone); the whole is None when git cannot tell the
/// repository. `(repository, checkout)`.
pub async fn main_checkout(
    connection: &dyn MrConnection,
    path: &str,
) -> Option<(String, Option<String>)> {
    let run = connection
        .run(
            &format!(
                "git -C {} rev-parse --path-format=absolute --git-common-dir",
                sh_quote(path)
            ),
            30_000,
        )
        .await;
    let repository = if run.code == 0 {
        js::trim(&run.stdout).trim_end_matches('/').to_owned()
    } else {
        String::new()
    };
    if !repository.starts_with('/') {
        return None;
    }
    if let Some(checkout) = repository.strip_suffix("/.git") {
        let checkout = checkout.to_owned();
        return Some((repository, Some(checkout)));
    }
    let source = connection
        .run(&crate::home::home_source_script(&repository), 30_000)
        .await;
    let checkout = crate::home::parse_home_source(&source.stdout);
    Some((repository, Some(checkout).filter(|c| !c.is_empty())))
}

/// One call of [`handle_effort_rpc`]: its deps, method's params and who.
struct Call<'a> {
    deps: &'a EffortRpcDeps,
    params: &'a Obj,
    meta: ChangeMeta,
}

impl Call<'_> {
    fn service(&self) -> &EffortService {
        &self.deps.service
    }

    fn by(&self) -> &str {
        &self.meta.by
    }

    /// The agent's summary of its change, when it gave one.
    fn summary(&self) -> Option<&str> {
        self.meta.summary.as_deref().filter(|s| !s.is_empty())
    }

    async fn settings(&self) -> Obj {
        (self.deps.settings)().await
    }

    async fn effort_of(&self) -> RpcResult<Value> {
        let efforts = super::efforts_of(&self.settings().await);
        let name = text_of(
            self.params
                .get("id")
                .filter(|v| !v.is_null())
                .or_else(|| self.params.get("effort")),
            "",
        );
        find_effort(&efforts, &name).ok_or_else(|| coded("no such effort", "not_found"))
    }

    /// The Herdr workspace at a checkout: a workspace headed upstream there,
    /// else any open workspace of the connection there (its cwd or its
    /// worktree), else the id last known.
    async fn workspace_at(
        &self,
        connection_id: &str,
        paths: &[Option<&str>],
        known: Option<&str>,
    ) -> Option<String> {
        let wanted: Vec<&str> = paths
            .iter()
            .flatten()
            .copied()
            .filter(|p| !p.is_empty())
            .collect();
        let members = self.deps.upstream.members();
        for path in &wanted {
            if let Some(member) = members.iter().find(|each| {
                each.connection_id == connection_id
                    && each.path == *path
                    && !each.workspace_id.is_empty()
            }) {
                return Some(member.workspace_id.clone());
            }
        }
        let listed = match self.service().connection_of(connection_id) {
            Some(connection) => connection.herdr("workspace.list", json!({})).await.ok(),
            None => None,
        };
        let workspaces: Vec<Value> = listed
            .as_ref()
            .and_then(|l| l.get("workspaces"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for path in &wanted {
            let found = workspaces.iter().find(|each| {
                each.get("worktree")
                    .and_then(|w| w.get("checkout_path"))
                    .and_then(Value::as_str)
                    == Some(path)
                    || each.get("cwd").and_then(Value::as_str) == Some(path)
            });
            if let Some(id) = found
                .and_then(|f| f.get("workspace_id"))
                .and_then(Value::as_str)
            {
                return Some(id.to_owned());
            }
        }
        known.map(str::to_owned)
    }

    /// Where a part's worktree starts: Herdr refuses a linked worktree as
    /// the source, so, as the workspace menu's New worktree does, the
    /// repository's parent workspace (its main checkout, found through the
    /// clone's repository even when that is a separate directory such as
    /// gstreamer.git), never the head's linked one. With none open, the
    /// main checkout's path, which Herdr and the worktree command take as
    /// well.
    async fn part_source(
        &self,
        effort: &Value,
        connection: &dyn MrConnection,
    ) -> RpcResult<PartSource> {
        let connection_id = s(effort, &["clone", "connectionId"]);
        let head = effort
            .get("head")
            .filter(|h| h.is_object() && s(h, &["connectionId"]) == connection_id);
        let main = main_checkout(connection, s(effort, &["clone", "path"])).await;
        if let Some((_, Some(checkout))) = &main
            && let Some(at) = self
                .workspace_at(connection_id, &[Some(checkout.as_str())], None)
                .await
        {
            return Ok(PartSource::Workspace(at));
        }
        let listed = connection.herdr("workspace.list", json!({})).await.ok();
        let workspaces: Vec<Value> = listed
            .as_ref()
            .and_then(|l| l.get("workspaces"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let head_path = head.map(|h| s(h, &["path"]));
        let head_workspace = head
            .and_then(|h| h.get("workspaceId"))
            .and_then(Value::as_str);
        let known = self
            .workspace_at(
                connection_id,
                &[head_path, Some(s(effort, &["clone", "path"]))],
                head_workspace,
            )
            .await;
        let workspace = known.as_deref().and_then(|known| {
            workspaces
                .iter()
                .find(|each| each.get("workspace_id").and_then(Value::as_str) == Some(known))
        });
        if let Some(parent) = workspace.and_then(|w| repo_parent_workspace(&workspaces, w)) {
            return Ok(PartSource::Workspace(parent));
        }
        if let Some((_, Some(checkout))) = &main {
            return Ok(PartSource::Cwd(checkout.clone()));
        }
        if let Some(known) = known.filter(|k| !k.is_empty())
            && workspace
                .and_then(|w| w.get("worktree"))
                .and_then(|w| w.get("is_linked_worktree"))
                != Some(&Value::Bool(true))
        {
            return Ok(PartSource::Workspace(known));
        }
        // A repository with no checkout of its own is said by its path: the
        // generic words would send the user looking for a main checkout there
        // is none of.
        Err(coded(
            match &main {
                Some((repository, _)) => format!(
                    "the repository {repository} has no checkout of its own (no gitdir file naming one, no core.worktree, nothing beside it without .git): worktrees start from a checkout, so check it out, or open a workspace on a checkout of it first"
                ),
                None => "open a workspace on the main checkout of the effort's clone first: worktrees start from there".to_owned(),
            },
            "not_found",
        ))
    }

    /// A part's stop as its worktree has it now, not as the pick left it:
    /// a pick resolved and committed there is no stop any more, another one
    /// is the new stop. Read when the view asks; kept without a journal
    /// entry (the worktree's state, not a decision).
    async fn live_part_stops(&self, effort: &Value, commits: &[Value]) -> Obj {
        let store = self.service().store().clone();
        let id = s(effort, &["id"]).to_owned();
        let ledger = store.ledger(&id);
        let stopped: Vec<Value> = plans_of(&ledger)
            .into_iter()
            .filter(|plan| part_of(plan).is_some_and(|p| truthy(p.get("conflict"))))
            .collect();
        let connection = if stopped.is_empty() {
            None
        } else {
            self.service()
                .connection_of(s(effort, &["clone", "connectionId"]))
        };
        let Some(connection) = connection else {
            return ledger;
        };
        let paths: Vec<String> = stopped
            .iter()
            .map(|plan| s(plan, &["part", "path"]).to_owned())
            .collect();
        let out = connection.run(&part_stops_script(&paths), 30_000).await;
        let now = parse_part_stops(&out.stdout);
        let changed = stopped.iter().any(|plan| {
            let was = &plan["part"]["conflict"];
            match now.get(s(plan, &["part", "path"])) {
                None => false,
                Some(None) => true,
                Some(Some(live)) => {
                    live.sha != s(was, &["sha"])
                        || live.folding != truthy(was.get("folding"))
                        || live.files.join("\n") != strings(was.get("files")).join("\n")
                }
            }
        });
        if !changed {
            return ledger;
        }
        store.clone().queue(&id, || {
            let mut latest = store.ledger(&id);
            let mut plans = plans_of(&latest);
            for plan in plans.iter_mut() {
                let Some(part) = plan.get_mut("part").filter(|p| p.is_object()) else {
                    continue;
                };
                if !truthy(part.get("conflict")) {
                    continue;
                }
                let Some(live) = now.get(s(part, &["path"])) else {
                    continue;
                };
                let Some(part) = part.as_object_mut() else {
                    continue;
                };
                match live {
                    None => {
                        part.shift_remove("conflict");
                    }
                    Some(live) => {
                        let was = part.get("conflict").cloned().unwrap_or(Value::Null);
                        let subject = match &live.subject {
                            Some(subject) => subject.clone(),
                            None if live.sha == s(&was, &["sha"]) => {
                                s(&was, &["subject"]).to_owned()
                            }
                            None => commits
                                .iter()
                                .find(|c| s(c, &["sha"]) == live.sha)
                                .map(|c| s(c, &["subject"]).to_owned())
                                .unwrap_or_default(),
                        };
                        part.insert(
                            "conflict".into(),
                            conflict_value(&live.sha, &subject, &live.files, live.folding),
                        );
                    }
                }
            }
            latest.insert("plans".into(), Value::Array(plans));
            store.write_ledger(&id, &latest);
            latest
        })
    }

    /// A part's new worktree in the Workspaces tree: under the effort's
    /// head workspace when it has one, else in its group (and there too
    /// when the head cannot take it).
    async fn place_part(&self, effort: &Value, made: &Made) {
        let Some(place) = self.deps.place.clone() else {
            return;
        };
        let mut placed = Obj::new();
        placed.insert(
            "connectionId".into(),
            json!(s(effort, &["clone", "connectionId"])),
        );
        placed.insert("path".into(), json!(made.path));
        if let Some(workspace) = &made.workspace_id {
            placed.insert("workspaceId".into(), json!(workspace));
        }
        placed.insert("group".into(), json!(s(effort, &["group"])));
        let under_head = match effort.get("head").filter(|h| h.is_object()) {
            Some(head) => {
                let mut under = Obj::new();
                under.insert("connectionId".into(), json!(s(head, &["connectionId"])));
                under.insert("path".into(), json!(s(head, &["path"])));
                if let Some(workspace) = head.get("workspaceId").filter(|w| truthy(Some(w))) {
                    under.insert("workspaceId".into(), workspace.clone());
                }
                let mut input = placed.clone();
                input.insert("under".into(), Value::Object(under));
                place(input).await.is_ok()
            }
            None => false,
        };
        if !under_head {
            let _ = place(placed).await;
        }
    }

    /// Makes a worktree on a branch through the user's worktree path.
    async fn create_worktree(
        &self,
        effort: &Value,
        branch: &str,
        connection: &dyn MrConnection,
    ) -> RpcResult<Made> {
        let Some(create) = self.deps.create_worktree.clone() else {
            return Err(coded("worktrees cannot be made here", "unavailable"));
        };
        let source = self.part_source(effort, connection).await?;
        let mut input = Obj::new();
        input.insert(
            "connectionId".into(),
            json!(s(effort, &["clone", "connectionId"])),
        );
        input.insert("branch".into(), json!(branch));
        source.put(&mut input);
        match create(input).await {
            Ok(made) => Ok(Made::of(&made)),
            Err(error) => Err(invalid(readable_error(&error))),
        }
    }

    /// Records a plan's part, journaled.
    fn record_part(
        &self,
        effort: &Value,
        plan_id: &Value,
        part: Obj,
        summary: &str,
    ) -> RpcResult<()> {
        change_plans(
            self.service().store(),
            effort,
            &json!({"action": "part", "plan": plan_id, "part": part}),
            &Author {
                by: self.by(),
                summary,
                now: js::now_ms(),
            },
            &HashMap::new(),
        )
        .map(|_| ())
        .map_err(RpcError::Failed)
    }

    /// Refresh part: an existing part's record read again from its branch
    /// as it is now (moved by hand onto a port or a squashed commit, say).
    /// Nothing is made, picked or moved: the worktree at its path and the
    /// branch it is on are only read, and only the record is rewritten,
    /// journaled for Undo. Its base: the part it stacks on when its branch
    /// holds that part's tip, else the target; from: the branch given,
    /// else an upstream/* branch at its commit; ported when it does not
    /// hold the plan's changes as they are but is a port of them on its
    /// base; its fixups left as commits read from its branch; its stop
    /// read from its worktree. A worktree or branch gone is refused,
    /// unless from names an existing local branch to attach the part to:
    /// its worktree when it has one, else a new worktree at a free path on
    /// it (the branch not moved).
    #[allow(clippy::too_many_arguments)]
    async fn refresh_part(
        &self,
        effort: &Value,
        plan: &Value,
        picked: &[Value],
        on: Option<&Value>,
        stacked: &[Value],
        upstream: &str,
    ) -> RpcResult<Value> {
        let was = part_of(plan).cloned().unwrap_or(Value::Null);
        let plan_name = s(plan, &["name"]);
        let connection = self
            .service()
            .connection_of(s(effort, &["clone", "connectionId"]))
            .ok_or_else(not_ready)?;
        let clone = s(effort, &["clone", "path"]);
        let named = string_of(self.params.get("from"))
            .map(|f| js::trim(f).to_owned())
            .unwrap_or_default();
        if !named.is_empty() && !is_branch_name(&named) {
            return Err(invalid(format!("\"{named}\" is not a branch name")));
        }
        let was_path = s(&was, &["path"]).to_owned();
        let now = parse_part_checkout(
            &connection
                .run(
                    &part_checkout_script(&was_path, clone, s(&was, &["branch"])),
                    30_000,
                )
                .await
                .stdout,
        );
        let mut path = was_path.clone();
        let mut workspace_id = was
            .get("workspaceId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let branch: String;
        let mut from: Option<String> = None;
        let mut attached: Option<&str> = None;
        if let Some(on_branch) = &now.branch {
            branch = on_branch.clone();
            if !named.is_empty() {
                let found = parse_branch_worktrees(
                    &connection
                        .run(&branch_worktrees_script(clone, &named), 30_000)
                        .await
                        .stdout,
                );
                if found.sha.is_none() {
                    return Err(invalid(format!(
                        "{named} is not a local branch of the clone: nothing changed"
                    )));
                }
                from = Some(named.clone());
            }
        } else {
            let why = match now.state {
                "detached" => format!("its worktree {was_path} is on no branch"),
                "unborn" => format!(
                    "its branch {} is gone (its worktree {was_path} is on no commit)",
                    now.unborn.as_deref().unwrap_or("undefined")
                ),
                _ => format!(
                    "its worktree {was_path} is gone{}",
                    if now.stored {
                        String::new()
                    } else {
                        format!(", and so is its branch {}", s(&was, &["branch"]))
                    }
                ),
            };
            if named.is_empty() {
                return Err(coded(
                    format!(
                        "{plan_name}'s part cannot be read: {why}. Give from (an existing local branch) to attach the part to it; nothing changed"
                    ),
                    "gone",
                ));
            }
            let found = parse_branch_worktrees(
                &connection
                    .run(&branch_worktrees_script(clone, &named), 30_000)
                    .await
                    .stdout,
            );
            let Some(found_sha) = found.sha.clone() else {
                return Err(invalid(format!(
                    "{plan_name}'s part cannot be read ({why}), and {named} is not a local branch of the clone: nothing changed"
                )));
            };
            branch = named.clone();
            if let Some(worktree) = found.worktree {
                path = worktree;
                attached = Some("existing");
                workspace_id = self
                    .workspace_at(
                        s(effort, &["clone", "connectionId"]),
                        &[Some(path.as_str())],
                        None,
                    )
                    .await;
            } else {
                let made = self.create_worktree(effort, &named, &*connection).await?;
                // Its own checkout of that branch, the branch where it was.
                let at = self.checkout_at(&*connection, &made.path, true).await;
                if at.first().is_none_or(|p| p.is_empty())
                    || at.first() != at.get(1)
                    || at.get(2).map(String::as_str) != Some(&format!("refs/heads/{named}"))
                    || at.get(3) != Some(&found_sha)
                {
                    return Err(invalid(format!(
                        "{} is not a worktree on {named} at {}: not recorded as the part",
                        made.path,
                        js::head16(&found_sha, 10)
                    )));
                }
                path = made.path.clone();
                workspace_id = made.workspace_id.clone();
                attached = Some("made");
                self.place_part(effort, &made).await;
            }
        }
        let targets = vec![
            upstream_ref(effort),
            format!(
                "refs/remotes/{}/{}",
                s(effort, &["target", "remote"]),
                s(effort, &["target", "branch"])
            ),
        ];
        let on_part = on.and_then(part_of);
        let base_ref = on_part.map(|p| format!("refs/heads/{}", s(p, &["branch"])));
        let content = parse_part_content(
            &connection
                .run(
                    &part_content_script(clone, &branch, &targets, base_ref.as_deref()),
                    120_000,
                )
                .await
                .stdout,
        );
        let Some(content_sha) = content.sha.clone() else {
            return Err(coded(
                format!("the branch {branch} cannot be read: nothing changed"),
                "gone",
            ));
        };
        let base = match (&content.on_base, on_part) {
            (Some(_), Some(part)) => Some(s(part, &["branch"]).to_owned()),
            _ => None,
        };
        let picked_shas: Vec<String> = picked.iter().map(|c| s(c, &["sha"]).to_owned()).collect();
        let carries = parse_carries(
            &connection
                .run(
                    &carries_script(
                        clone,
                        &branch,
                        &targets,
                        &picked_shas,
                        content.on_base.as_deref(),
                    ),
                    120_000,
                )
                .await
                .stdout,
        );
        let stop = parse_part_stops(
            &connection
                .run(&part_stops_script(std::slice::from_ref(&path)), 30_000)
                .await
                .stdout,
        )
        .remove(&path)
        .flatten();
        let conflict = stop.as_ref().map(|stop| {
            let subject = stop.subject.clone().unwrap_or_else(|| {
                picked
                    .iter()
                    .find(|c| s(c, &["sha"]) == stop.sha)
                    .map(|c| s(c, &["subject"]).to_owned())
                    .unwrap_or_default()
            });
            conflict_value(&stop.sha, &subject, &stop.files, stop.folding)
        });
        let picked_ids: Vec<String> = picked
            .iter()
            .map(|c| s(c, &["patchId"]).to_owned())
            .collect();
        let on_branch = if carries.sha.is_some() {
            picked.len()
        } else {
            picked_on_branch(&picked_ids, &content.on_branch)
        };
        // Not the plan's changes as they are, nor stopped picking them: a
        // port of them on its base, its content its own.
        let mut ported: Option<PortedDifference> = None;
        if carries.sha.is_none() && conflict.is_none() && on_branch < picked.len() {
            let mut ons: Vec<(String, String)> = Vec::new();
            if let Some(base_ref) = &base_ref {
                ons.push(("base".into(), base_ref.clone()));
            }
            for each in stacked {
                let mut names: Vec<String> = Vec::new();
                if let Some(from) = part_of(each)
                    .and_then(|p| p.get("from"))
                    .and_then(Value::as_str)
                    .filter(|f| !f.is_empty())
                {
                    names.push(from.to_owned());
                }
                names.push(upstream_of(&slug_of(s(each, &["name"]))));
                for name in names.into_iter().filter(|name| *name != branch) {
                    ons.push(("upstream".into(), format!("refs/heads/{name}")));
                }
            }
            let prepared = parse_prepared(
                &connection
                    .run(
                        &prepared_script(clone, &branch, &ons, &targets, s(effort, &["source"])),
                        120_000,
                    )
                    .await
                    .stdout,
            );
            let plan_files = plan_files(picked);
            let set: HashSet<&String> = plan_files.iter().collect();
            if prepared.sha.is_some() && prepared.files.iter().any(|f| set.contains(f)) {
                ported = Some(ported_difference(&plan_files, &prepared.files));
            }
        }
        if from.is_none() {
            from = content
                .upstream
                .iter()
                .filter(|name| *name == upstream)
                .chain(content.upstream.iter())
                .find(|name| **name != branch)
                .cloned();
        }
        let unfolded = unfolded_of(&content.fixups, picked);
        let fixups_in_plan = picked
            .iter()
            .filter(|c| FIXUP.is_match(s(c, &["subject"])))
            .count();
        let folded = if ported.is_none() && conflict.is_none() && on_branch == picked.len() {
            fixups_in_plan
                .saturating_sub(unfolded.iter().filter(|(sha, _)| !sha.is_empty()).count())
        } else {
            0
        };
        let mut part = Obj::new();
        part.insert(
            "connectionId".into(),
            json!(s(effort, &["clone", "connectionId"])),
        );
        part.insert("path".into(), json!(path));
        part.insert("branch".into(), json!(branch));
        put_some(
            &mut part,
            "workspaceId",
            workspace_id.filter(|w| !w.is_empty()).map(Value::from),
        );
        put_some(&mut part, "from", from.clone().map(Value::from));
        put_some(&mut part, "ported", ported.as_ref().map(|_| json!(true)));
        put_some(&mut part, "base", base.clone().map(Value::from));
        put_some(&mut part, "conflict", conflict.clone());
        part.insert(
            "unfolded".into(),
            json!(
                unfolded
                    .iter()
                    .map(|(_, subject)| subject)
                    .collect::<Vec<_>>()
            ),
        );
        part.insert("refreshed".into(), json!(js::iso(js::now_ms())));
        let mut said: Vec<String> = Vec::new();
        if let Some(from) = &from {
            said.push(format!("from {from}"));
        }
        if let Some(base) = &base {
            said.push(format!("on {base}"));
        }
        if ported.is_some() {
            said.push("ported".into());
        }
        if conflict.is_some() {
            said.push("stopped".into());
        }
        let summary = format!(
            "Part {branch} of {plan_name} refreshed{}",
            if said.is_empty() {
                String::new()
            } else {
                format!(" ({})", said.join(", "))
            }
        );
        self.record_part(effort, &plan["id"], part, &summary)?;
        self.service().refresh_one(effort, true).await;
        self.service()
            .push(s(effort, &["id"]), self.by(), None, None)
            .await;
        let mut out = obj(json!({
            "ok": conflict.is_none(),
            "refreshed": true,
            "path": path,
            "branch": branch,
            "sha": content_sha,
            "picked": on_branch,
            "of": picked.len(),
        }));
        put_some(&mut out, "attached", attached.map(Value::from));
        put_some(&mut out, "from", from.map(Value::from));
        if let Some(ported) = &ported {
            out.insert("ported".into(), json!(true));
            out.insert("differs".into(), differs(ported));
        }
        put_some(&mut out, "base", base.clone().map(Value::from));
        if let Some(part) = on_part
            && base.is_none()
        {
            out.insert("not_on".into(), json!(s(part, &["branch"])));
        }
        if folded > 0 {
            out.insert("folded".into(), json!(folded));
        }
        if !unfolded.is_empty() {
            out.insert("unfolded".into(), unfolded_value(&unfolded));
        }
        if carries.sha.is_none()
            && ported.is_none()
            && let Some(not) = carries.not.filter(|n| !n.is_empty())
        {
            out.insert("not_held".into(), json!(not));
        }
        put_some(&mut out, "conflict", conflict);
        Ok(Value::Object(out))
    }

    /// `cd path`, then its real path, its top level, its branch ref and
    /// (with `sha`) its commit, one per line.
    async fn checkout_at(
        &self,
        connection: &dyn MrConnection,
        path: &str,
        sha: bool,
    ) -> Vec<String> {
        let script = format!(
            "cd {} 2>/dev/null && printf '%s\\n%s\\n' \"$(pwd -P)\" \"$(git rev-parse --show-toplevel 2>/dev/null)\" && git symbolic-ref -q HEAD{}",
            sh_quote(path),
            if sha { " && git rev-parse HEAD" } else { "" }
        );
        js::trim(&connection.run(&script, 30_000).await.stdout)
            .split('\n')
            .map(str::to_owned)
            .collect()
    }
}

/// The files a plan's commits change, each once, in order.
fn plan_files(picked: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for commit in picked {
        for file in strings(commit.get("files")) {
            if seen.insert(file.clone()) {
                out.push(file);
            }
        }
    }
    out
}

/// Fixups left as commits, each with the plan's commit of that subject
/// (taken once), or no sha.
fn unfolded_of(subjects: &[String], picked: &[Value]) -> Vec<(String, String)> {
    let mut left: Vec<&Value> = picked.iter().collect();
    subjects
        .iter()
        .map(|subject| {
            let at = left.iter().position(|c| s(c, &["subject"]) == subject);
            let sha = at
                .map(|at| s(left.remove(at), &["sha"]).to_owned())
                .unwrap_or_default();
            (sha, subject.clone())
        })
        .collect()
}

fn unfolded_value(unfolded: &[(String, String)]) -> Value {
    Value::Array(
        unfolded
            .iter()
            .map(|(sha, subject)| json!({"sha": sha, "subject": subject}))
            .collect(),
    )
}

/// `{ok: true, ...result}`.
fn ok_with(fields: Value) -> Value {
    let mut out = obj(json!({"ok": true}));
    out.extend(obj(fields));
    Value::Object(out)
}

/// `bridge.mr_reviews.effort.*` and `ledger.*`; None for another method.
pub async fn handle_effort_rpc(
    deps: &EffortRpcDeps,
    method: &str,
    params: &Obj,
) -> RpcResult<Option<Value>> {
    let call = Call {
        deps,
        params,
        meta: change(params),
    };
    let answer = match method {
        "bridge.mr_reviews.effort.set" | "bridge.mr_reviews.effort.preview" => {
            effort_set(&call, method == "bridge.mr_reviews.effort.preview").await?
        }
        "bridge.mr_reviews.effort.delete" => effort_delete(&call).await?,
        "bridge.mr_reviews.effort.refresh" => {
            let effort = call.effort_of().await?;
            call.service().refresh_one(&effort, true).await;
            json!({"ok": true})
        }
        "bridge.mr_reviews.effort.get" => effort_get(&call).await?,
        "bridge.mr_reviews.effort.seen" => {
            // What the user saw: What changed starts again from here.
            let effort = call.effort_of().await?;
            let id = s(&effort, &["id"]);
            let store = call.service().store();
            if let Some(derived) = store.derived(id) {
                store.write_seen(id, &snapshot_of(&derived, &store.ledger(id), js::now_ms()));
            }
            call.service().push(id, "user", None, None).await;
            json!({"ok": true})
        }
        "bridge.mr_reviews.ledger.match" => ledger_match(&call).await?,
        "bridge.mr_reviews.ledger.plans" => ledger_plans(&call).await?,
        "bridge.mr_reviews.effort.part" => effort_part(&call).await?,
        "bridge.mr_reviews.effort.open_commit" => open_commit(&call).await?,
        "bridge.mr_reviews.effort.diff" => effort_diff(&call).await?,
        "bridge.mr_reviews.effort.threads" => effort_threads(&call).await?,
        "bridge.mr_reviews.effort.leader" => effort_leader(&call).await?,
        "bridge.mr_reviews.effort.history" => {
            let effort = call.effort_of().await?;
            let key = text_of(params.get("key"), "");
            if key.is_empty() {
                return Err(invalid("key is required"));
            }
            let versions = call
                .service()
                .store()
                .history(s(&effort, &["id"]), Some(&key));
            json!({"versions": versions})
        }
        "bridge.mr_reviews.ledger.set" => ledger_set(&call).await?,
        "bridge.mr_reviews.ledger.undo" => {
            let effort = call.effort_of().await?;
            let id = s(&effort, &["id"]);
            let journal = params.get("journal").and_then(Value::as_f64);
            let undone = undo_ledger(call.service().store(), id, journal)
                .filter(|summary| !summary.is_empty())
                .ok_or_else(|| coded("nothing to undo", "gone"))?;
            call.service().refresh_one(&effort, true).await;
            call.service().push(id, "user", None, None).await;
            json!({"ok": true, "undone": undone})
        }
        _ => return Ok(None),
    };
    Ok(Some(answer))
}

/// The head of an effort (else its clone): connection, path, workspace.
fn head_of(effort: &Value) -> (String, String, Option<String>) {
    match effort.get("head").filter(|h| h.is_object()) {
        Some(head) => (
            s(head, &["connectionId"]).to_owned(),
            s(head, &["path"]).to_owned(),
            head.get("workspaceId")
                .and_then(Value::as_str)
                .filter(|w| !w.is_empty())
                .map(str::to_owned),
        ),
        None => (
            s(effort, &["clone", "connectionId"]).to_owned(),
            s(effort, &["clone", "path"]).to_owned(),
            None,
        ),
    }
}

async fn effort_set(call: &Call<'_>, preview: bool) -> RpcResult<Value> {
    // Declared on a group headed upstream; the source resolved once to an
    // exact ref of the clone (refused when ambiguous).
    let params = call.params;
    let current = call.settings().await;
    let efforts = super::efforts_of(&current);
    let existing = if params.get("id").is_some_and(|v| truthy(Some(v))) {
        find_effort(&efforts, &text_of(params.get("id"), ""))
    } else {
        None
    };
    // Its home: a group headed upstream, or a workspace headed upstream by
    // itself (its home id).
    let group = text_of(
        params
            .get("group")
            .filter(|v| !v.is_null())
            .or_else(|| existing.as_ref().and_then(|e| e.get("group"))),
        "",
    );
    let headed = strings(current.get("upstreamGroups")).contains(&group)
        || current
            .get("upstreamWorkspaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .any(|reference| upstream_workspace_home(reference) == group);
    if !headed && existing.is_none() {
        return Err(invalid(
            "an effort is declared on a group or a workspace headed upstream",
        ));
    }
    let clone_param = string_of(params.get("clone"));
    let members: Vec<_> = call
        .deps
        .upstream
        .members()
        .into_iter()
        .filter(|member| member.group == group || Some(member.path.as_str()) == clone_param)
        .collect();
    let clone_path = match clone_param.filter(|c| c.starts_with('/')) {
        Some(clone) => Some(clone.to_owned()),
        None => existing
            .as_ref()
            .and_then(|e| e.get("clone"))
            .and_then(|c| c.get("path"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| members.first().map(|m| m.path.clone())),
    };
    let member = members
        .iter()
        .find(|each| Some(&each.path) == clone_path.as_ref());
    let connection_id = match member {
        Some(member) => member.connection_id.clone(),
        None => existing
            .as_ref()
            .map(|e| s(e, &["clone", "connectionId"]).to_owned())
            .unwrap_or_default(),
    };
    let clone_path = clone_path.unwrap_or_default();
    if clone_path.is_empty() || connection_id.is_empty() {
        return Err(invalid(
            "no clone: put a workspace of the source's clone in the group, or give clone",
        ));
    }
    let connection = call
        .service()
        .connection_of(&connection_id)
        .ok_or_else(not_ready)?;
    let source_name = string_of(params.get("source"))
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| existing.as_ref().map(|e| s(e, &["source"]).to_owned()))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("source (a branch) is required"))?;
    let source = match &existing {
        Some(existing) if source_name == s(existing, &["source"]) => source_name.clone(),
        _ => {
            call.service()
                .exact_ref(&*connection, &clone_path, &source_name)
                .await?
        }
    };
    let target_text = match string_of(params.get("target")).filter(|t| t.contains('/')) {
        Some(target) => target.to_owned(),
        None => match &existing {
            Some(existing) => format!(
                "{}/{}",
                s(existing, &["target", "remote"]),
                s(existing, &["target", "branch"])
            ),
            None => "origin/main".to_owned(),
        },
    };
    let existing_feeders = existing
        .as_ref()
        .map(|e| strings(e.get("feeders")))
        .unwrap_or_default();
    let feeder_names: Vec<String> = match params.get("feeders").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        None => existing_feeders.clone(),
    };
    let mut feeders: Vec<String> = Vec::new();
    for name in feeder_names.into_iter().take(20) {
        feeders.push(if existing_feeders.contains(&name) {
            name
        } else {
            call.service()
                .exact_ref(&*connection, &clone_path, &name)
                .await?
        });
    }
    let id = existing
        .as_ref()
        .map(|e| s(e, &["id"]).to_owned())
        .unwrap_or_else(|| new_id("e", js::now_ms()));
    let name = match string_of(params.get("name"))
        .map(js::trim)
        .filter(|n| !n.is_empty())
    {
        Some(name) => name.to_owned(),
        None => match existing
            .as_ref()
            .map(|e| s(e, &["name"]))
            .filter(|n| !n.is_empty())
        {
            Some(name) => name.to_owned(),
            None => match (call.deps.group_label)(group.clone())
                .await
                .filter(|l| !l.is_empty())
            {
                Some(label) => label,
                None => source
                    .strip_prefix("refs/heads/")
                    .or_else(|| source.strip_prefix("refs/remotes/"))
                    .unwrap_or(&source)
                    .to_owned(),
            },
        },
    };
    let slash = target_text.find('/').unwrap_or(0);
    let mut effort = obj(json!({
        "id": id,
        "group": group,
        "name": name,
        "clone": {"connectionId": connection_id, "path": clone_path},
        "source": source,
        "target": {"remote": &target_text[..slash], "branch": &target_text[slash + 1..]},
        "feeders": feeders,
    }));
    match string_of(params.get("head")).filter(|h| !h.is_empty()) {
        Some(wanted) => {
            if let Some(head) = call
                .deps
                .upstream
                .members()
                .into_iter()
                .find(|each| each.path == wanted || each.label == wanted)
            {
                let mut value = obj(json!({"connectionId": head.connection_id, "path": head.path}));
                if !head.workspace_id.is_empty() {
                    value.insert("workspaceId".into(), json!(head.workspace_id));
                }
                effort.insert("head".into(), Value::Object(value));
            }
        }
        None => {
            if let Some(head) = existing
                .as_ref()
                .and_then(|e| e.get("head"))
                .filter(|h| truthy(Some(h)))
            {
                effort.insert("head".into(), head.clone());
            }
        }
    }
    let effort = Value::Object(effort);
    if preview {
        let others: Vec<Value> = efforts
            .iter()
            .filter(|each| s(each, &["id"]) != s(&effort, &["id"]))
            .cloned()
            .collect();
        let preview = call.service().preview(&effort, &others).await?;
        return Ok(json!({"effort": effort, "preview": preview}));
    }
    let settings = call.deps.settings.clone();
    let save = call.deps.save.clone();
    let meta = call.meta.clone();
    let declared = effort.clone();
    let saved = (call.deps.edit)(Box::pin(async move {
        let mut latest = settings().await;
        let mut efforts = super::efforts_of(&latest);
        let id = s(&declared, &["id"]);
        match efforts.iter_mut().find(|each| s(each, &["id"]) == id) {
            Some(each) => *each = declared.clone(),
            None => efforts.push(declared.clone()),
        }
        latest.insert("efforts".into(), Value::Array(efforts));
        save(latest, meta).await
    }))
    .await?;
    tokio::spawn(call.service().refresh_one(&effort, true));
    Ok(json!({"ok": true, "effort": effort, "version": version_of(&saved)}))
}

fn version_of(saved: &Obj) -> Value {
    match saved.get("orderVersion") {
        None | Some(Value::Null) => json!(0),
        Some(version) => version.clone(),
    }
}

async fn effort_delete(call: &Call<'_>) -> RpcResult<Value> {
    // A name several efforts share (a duplicate declared by mistake)
    // deletes none: its id says which.
    let wanted = text_of(
        call.params
            .get("id")
            .filter(|v| !v.is_null())
            .or_else(|| call.params.get("effort")),
        "",
    );
    let declared = super::efforts_of(&call.settings().await);
    let lower = js::trim(&wanted).to_lowercase();
    let named: Vec<&Value> = declared
        .iter()
        .filter(|each| s(each, &["name"]).to_lowercase() == lower)
        .collect();
    if !declared.iter().any(|each| s(each, &["id"]) == wanted) && named.len() > 1 {
        return Err(invalid(format!(
            "several efforts are named {}: give its id ({})",
            s(named[0], &["name"]),
            named
                .iter()
                .map(|each| format!(
                    "{}: {} in {}",
                    s(each, &["id"]),
                    s(each, &["source"]),
                    s(each, &["clone", "path"])
                ))
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }
    let effort = call.effort_of().await?;
    let settings = call.deps.settings.clone();
    let save = call.deps.save.clone();
    let meta = call.meta.clone();
    let gone = s(&effort, &["id"]).to_owned();
    let saved = (call.deps.edit)(Box::pin(async move {
        let mut latest = settings().await;
        let efforts: Vec<Value> = super::efforts_of(&latest)
            .into_iter()
            .filter(|each| s(each, &["id"]) != gone)
            .collect();
        latest.insert("efforts".into(), Value::Array(efforts));
        save(latest, meta).await
    }))
    .await?;
    // Only its declaration goes. Its ledger (marks, plans, history) stays
    // on disk under its own id, for Undo, and no other effort's ledger, no
    // branch and no worktree is touched.
    Ok(json!({
        "ok": true,
        "effort": {"id": effort["id"], "name": effort["name"]},
        "version": version_of(&saved),
    }))
}

async fn effort_get(call: &Call<'_>) -> RpcResult<Value> {
    let effort = call.effort_of().await?;
    let settings = call.settings().await;
    let id = s(&effort, &["id"]);
    let store = call.service().store();
    let derived = store.derived(id);
    let commits = super::commits_of(derived.as_ref());
    let ledger = call.live_part_stops(&effort, &commits).await;
    let mut out = Obj::new();
    out.insert("effort".into(), effort.clone());
    if let Some(summary) = call
        .service()
        .summaries(&settings)
        .into_iter()
        .find(|each| s(each, &["id"]) == id)
    {
        out.insert("summary".into(), summary);
    }
    let field = |name: &str| {
        derived
            .as_ref()
            .and_then(|d| d.get(name))
            .cloned()
            .unwrap_or_else(|| json!([]))
    };
    out.insert("commits".into(), Value::Array(commits.clone()));
    out.insert("feeders".into(), field("feeders"));
    out.insert("daily".into(), field("daily"));
    let journal: Vec<Value> = ledger
        .get("journal")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let skip = journal.len().saturating_sub(10);
    out.insert(
        "journal".into(),
        Value::Array(
            journal
                .iter()
                .skip(skip)
                .map(|entry| {
                    let mut each = Obj::new();
                    for key in ["id", "at", "by", "summary"] {
                        if let Some(value) = entry.get(key) {
                            each.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(each)
                })
                .collect(),
        ),
    );
    let matches = ledger.get("matches").cloned().unwrap_or(Value::Null);
    let proposals: Obj = derived
        .as_ref()
        .and_then(|d| d.get("proposals"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(key, _)| !truthy(matches.get(key.as_str()).and_then(|m| m.get("accepted"))))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    out.insert("proposals".into(), Value::Object(proposals));
    let plans = plans_of(&ledger);
    out.insert("plans".into(), Value::Array(plans.clone()));
    out.insert(
        "changes".into(),
        Value::Object(changes_of(
            derived.as_ref(),
            &ledger,
            store.seen(id).as_ref(),
        )),
    );
    if let Some(entries) = &call.deps.entries {
        let entries = entries().await;
        out.insert(
            "board".into(),
            Value::Object(effort_plan_entries(
                s(&effort, &["group"]),
                &plans,
                &call.deps.upstream.branches(),
                &entries,
                &call.deps.upstream.patch_ids(),
            )),
        );
    }
    Ok(Value::Object(out))
}

async fn ledger_match(call: &Call<'_>) -> RpcResult<Value> {
    let effort = call.effort_of().await?;
    let given = call.params.get("decisions").and_then(Value::as_array);
    let decisions: Vec<Decision> = given
        .into_iter()
        .flatten()
        .filter_map(|each| {
            Some(Decision {
                commit: each.get("commit")?.as_str()?.to_owned(),
                matched: each.get("match")?.as_str()?.to_owned(),
                accept: each.get("accept")?.as_bool()?,
            })
        })
        .collect();
    if decisions.is_empty() || Some(decisions.len()) != given.map(Vec::len) {
        return Err(invalid(
            "decisions: [{commit, match, accept}] (commit and match shas)",
        ));
    }
    let accepted = decisions.iter().filter(|d| d.accept).count();
    let summary = match call.summary() {
        Some(summary) => summary.to_owned(),
        None => format!(
            "{accepted} match{} confirmed, {} rejected",
            if accepted == 1 { "" } else { "es" },
            decisions.len() - accepted
        ),
    };
    let (accepted, rejected, journal) = decide_matches(
        call.service().store(),
        &effort,
        &decisions,
        &Author {
            by: call.by(),
            summary: &summary,
            now: js::now_ms(),
        },
    )
    .map_err(invalid)?;
    call.service().refresh_one(&effort, true).await;
    call.service()
        .push(
            s(&effort, &["id"]),
            call.by(),
            call.summary(),
            Some(journal),
        )
        .await;
    Ok(ok_with(json!({
        "accepted": accepted,
        "rejected": rejected,
        "journal": js::number(journal),
    })))
}

async fn ledger_plans(call: &Call<'_>) -> RpcResult<Value> {
    let effort = call.effort_of().await?;
    let params = call.params;
    let action = text_of(params.get("action"), "");
    let list = |key: &str| -> Option<Vec<String>> {
        params.get(key).and_then(Value::as_array).map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    };
    let plan = text_of(params.get("plan"), "");
    let mut change = obj(json!({"action": action}));
    match action.as_str() {
        "propose" => {
            change.insert(
                "name".into(),
                json!(text_of(params.get("name").filter(|v| !v.is_null()), &plan)),
            );
            change.insert("commits".into(), json!(list("commits").unwrap_or_default()));
            if let Some(depends) = list("depends_on") {
                change.insert("dependsOn".into(), json!(depends));
            }
            if params.get("accepted") == Some(&Value::Bool(true)) {
                change.insert("accepted".into(), json!(true));
            }
        }
        "accept" | "drop" => {
            change.insert("plan".into(), json!(plan));
        }
        "edit" => {
            change.insert("plan".into(), json!(plan));
            if let Some(name) = string_of(params.get("name")) {
                change.insert("name".into(), json!(name));
            }
            for (from, to) in [
                ("commits", "commits"),
                ("add", "add"),
                ("remove", "remove"),
                ("depends_on", "dependsOn"),
            ] {
                if let Some(value) = list(from) {
                    change.insert(to.into(), json!(value));
                }
            }
        }
        "split" => {
            change.insert("plan".into(), json!(plan));
            change.insert("name".into(), json!(text_of(params.get("name"), "")));
            change.insert("commits".into(), json!(list("commits").unwrap_or_default()));
        }
        _ => return Err(invalid("action: propose, accept, edit, split or drop")),
    }
    let verb = match action.as_str() {
        "propose" => "proposed",
        "accept" => "accepted",
        "edit" => "changed",
        "split" => "split",
        _ => "dropped",
    };
    let summary = match call.summary() {
        Some(summary) => summary.to_owned(),
        None => {
            let named = change
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(&plan);
            format!("Planned request {named} {verb}")
        }
    };
    let taken: HashMap<String, String> = call
        .service()
        .taken_elsewhere(s(&effort, &["id"]))
        .into_iter()
        .collect();
    let (plan, journal) = change_plans(
        call.service().store(),
        &effort,
        &Value::Object(change),
        &Author {
            by: call.by(),
            summary: &summary,
            now: js::now_ms(),
        },
        &taken,
    )
    .map_err(invalid)?;
    call.service().refresh_one(&effort, true).await;
    call.service()
        .push(
            s(&effort, &["id"]),
            call.by(),
            call.summary(),
            Some(journal),
        )
        .await;
    Ok(ok_with(json!({
        "plan": plan.unwrap_or(Value::Null),
        "journal": js::number(journal),
    })))
}

async fn ledger_set(call: &Call<'_>) -> RpcResult<Value> {
    let effort = call.effort_of().await?;
    let params = call.params;
    let disposition = string_of(params.get("disposition")).filter(|d| is_authored_disposition(d));
    let Some(disposition) = disposition else {
        return Err(invalid(
            "disposition: not_for_upstream, superseded, planned, upstream, in_review or unsorted",
        ));
    };
    let commits: Vec<String> = match params.get("commits").and_then(Value::as_array) {
        Some(list) if list.iter().all(Value::is_string) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => return Err(invalid("commits (shas or keys) are required")),
    };
    let summary = match call.summary().filter(|_| call.by() == "agent") {
        Some(summary) => summary.to_owned(),
        None => format!(
            "{} commit{} {}",
            commits.len(),
            if commits.len() == 1 { "" } else { "s" },
            disposition.replace('_', " ")
        ),
    };
    let (changed, unknown, journal) = set_dispositions(
        call.service().store(),
        &effort,
        &commits,
        disposition,
        string_of(params.get("reason")),
        string_of(params.get("pointer")),
        &Author {
            by: call.by(),
            summary: &summary,
            now: js::now_ms(),
        },
    )
    .map_err(RpcError::Failed)?;
    if !unknown.is_empty() {
        return Err(invalid(format!(
            "not in the ledger (or ambiguous): {}; nothing changed",
            unknown
                .iter()
                .take(20)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    call.service().refresh_one(&effort, true).await;
    call.service()
        .push(
            s(&effort, &["id"]),
            call.by(),
            call.summary(),
            Some(journal),
        )
        .await;
    Ok(ok_with(json!({
        "changed": changed,
        "unknown": unknown,
        "journal": js::number(journal),
    })))
}

async fn effort_part(call: &Call<'_>) -> RpcResult<Value> {
    // An accepted planned request gets its part (D25): a worktree in the
    // effort's group through the user's worktree path, on the target, with
    // the plan's commits picked in source order (no -x) and their fixups
    // folded into their targets. A conflict stops there and is reported;
    // nothing is aborted. Its base: the part of the plan it depends on (the
    // last one in source order), or of the plan its fixups all fix
    // (refused while that one has none); the target otherwise. When a
    // local upstream/<plan> branch (or the one named by from) already
    // holds the plan's changes over the target, the part starts at its
    // commit instead, nothing picked; when it is a port of the plan (its
    // own content) sitting on the base, too, said ported: its commits,
    // never the source's. That branch is only read, never moved.
    let params = call.params;
    let effort = call.effort_of().await?;
    let effort_id = s(&effort, &["id"]).to_owned();
    let store = call.service().store().clone();
    let ledger = store.ledger(&effort_id);
    let plans = plans_of(&ledger);
    let plan = find_plan(&plans, &text_of(params.get("plan"), ""))
        .map(|at| plans[at].clone())
        .ok_or_else(|| coded("no such planned request", "not_found"))?;
    let plan_name = s(&plan, &["name"]).to_owned();
    if s(&plan, &["state"]) != "accepted" {
        return Err(invalid(format!("accept {plan_name} first")));
    }
    // Refreshed: its record read again from its branch as it is now.
    let refresh = params.get("refresh") == Some(&Value::Bool(true));
    if let Some(part) = part_of(&plan)
        && !refresh
    {
        return Err(invalid(format!(
            "{plan_name} has its part already: {}",
            s(part, &["path"])
        )));
    }
    if refresh && part_of(&plan).is_none() {
        return Err(coded(
            format!("{plan_name} has no part to refresh: make it first"),
            "not_found",
        ));
    }
    let commits = super::commits_of(store.derived(&effort_id).as_ref());
    let by_key: HashMap<&str, &Value> = commits.iter().map(|c| (s(c, &["key"]), c)).collect();
    let plan_keys = strings(plan.get("commits"));
    let picked: Vec<Value> = plan_keys
        .iter()
        .filter_map(|key| by_key.get(key.as_str()).map(|c| (*c).clone()))
        .collect();
    if picked.len() != plan_keys.len() {
        return Err(invalid(
            "some of its commits are no longer on the source: edit the plan",
        ));
    }
    let slug = slug_of(&plan_name);
    // Its base: the part it stacks on. Plans in source order (their last
    // commit), the last one wins.
    let position: HashMap<&str, i64> = commits
        .iter()
        .enumerate()
        .map(|(index, c)| (s(c, &["key"]), index as i64))
        .collect();
    let last_at = |each: &Value| -> i64 {
        strings(each.get("commits"))
            .iter()
            .map(|key| position.get(key.as_str()).copied().unwrap_or(-1))
            .fold(-1, i64::max)
    };
    let mut plan_of_key: HashMap<String, &Value> = HashMap::new();
    for each in &plans {
        for key in strings(each.get("commits")) {
            plan_of_key.insert(key, each);
        }
    }
    let pairs: Vec<(String, String)> = commits
        .iter()
        .map(|c| (s(c, &["sha"]).to_owned(), s(c, &["subject"]).to_owned()))
        .collect();
    let fixes = fixup_targets(&pairs);
    let mut fixed: Vec<Value> = Vec::new();
    let fixup_only = !picked.is_empty()
        && picked.iter().all(|commit| {
            let target = position
                .get(s(commit, &["key"]))
                .and_then(|at| fixes.get(*at as usize))
                .copied()
                .flatten();
            let of = match target {
                Some(target) if target >= 0 => plan_of_key
                    .get(s(&commits[target as usize], &["key"]))
                    .copied(),
                _ => None,
            };
            match of {
                Some(of) if of["id"] != plan["id"] => {
                    if !fixed.iter().any(|each| each["id"] == of["id"]) {
                        fixed.push(of.clone());
                    }
                    true
                }
                _ => false,
            }
        });
    if fixup_only
        && !refresh
        && let Some(without) = fixed.iter().find(|each| part_of(each).is_none())
    {
        let without = s(without, &["name"]);
        return Err(invalid(format!(
            "{plan_name} only fixes commits of {without}: make the part of {without} first, {plan_name}'s part starts on it"
        )));
    }
    let mut stacked: Vec<Value> = strings(plan.get("dependsOn"))
        .iter()
        .filter_map(|id| {
            plans
                .iter()
                .find(|other| s(other, &["id"]) == id)
                .filter(|other| part_of(other).is_some())
                .cloned()
        })
        .collect();
    if fixup_only {
        stacked.extend(fixed.iter().cloned());
    }
    stacked.sort_by_key(|each| std::cmp::Reverse(last_at(each)));
    let on = stacked.first().cloned();
    let on_part = on.as_ref().and_then(part_of).cloned();
    if let (Some(on), Some(part)) = (&on, &on_part)
        && truthy(part.get("conflict"))
        && !refresh
    {
        return Err(invalid(format!(
            "the part of {} ({}), which this one starts on, is stopped at a conflict: resolve it there first",
            s(on, &["name"]),
            s(part, &["branch"])
        )));
    }
    let base_ref = on_part
        .as_ref()
        .map(|p| format!("refs/heads/{}", s(p, &["branch"])));
    if refresh {
        return call
            .refresh_part(
                &effort,
                &plan,
                &picked,
                on.as_ref(),
                &stacked,
                &upstream_of(&slug),
            )
            .await;
    }
    let branch = string_of(params.get("branch"))
        .map(js::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| slug.clone());
    if !is_branch_name(&branch) {
        return Err(invalid(format!("\"{branch}\" is not a branch name")));
    }
    let named = string_of(params.get("from"))
        .map(|f| js::trim(f).to_owned())
        .unwrap_or_default();
    if !named.is_empty() && !is_branch_name(&named) {
        return Err(invalid(format!("\"{named}\" is not a branch name")));
    }
    let base = if named.is_empty() {
        upstream_of(&slug)
    } else {
        named.clone()
    };
    let connection = call
        .service()
        .connection_of(s(&effort, &["clone", "connectionId"]))
        .ok_or_else(not_ready)?;
    if call.deps.create_worktree.is_none() {
        return Err(coded("worktrees cannot be made here", "unavailable"));
    }
    let clone = s(&effort, &["clone", "path"]);
    // A new branch only: an existing one (here or on origin) is someone
    // else's work, which a part must never check out or move.
    let taken = connection
        .run(
            &format!(
                "git -C {} for-each-ref --format='%(refname)' {} {}",
                sh_quote(clone),
                sh_quote(&format!("refs/heads/{branch}")),
                sh_quote(&format!("refs/remotes/origin/{branch}"))
            ),
            30_000,
        )
        .await
        .stdout;
    let taken = js::trim(&taken);
    if !taken.is_empty() {
        return Err(invalid(format!(
            "the branch {branch} exists already ({}): name the part's branch with branch",
            taken.split('\n').next().unwrap_or("")
        )));
    }
    let targets = vec![
        upstream_ref(&effort),
        format!(
            "refs/remotes/{}/{}",
            s(&effort, &["target", "remote"]),
            s(&effort, &["target", "branch"])
        ),
    ];
    let picked_shas: Vec<String> = picked.iter().map(|c| s(c, &["sha"]).to_owned()).collect();
    let carries = parse_carries(
        &connection
            .run(
                &carries_script(clone, &base, &targets, &picked_shas, None),
                120_000,
            )
            .await
            .stdout,
    );
    if !named.is_empty() && carries.missing {
        return Err(invalid(format!(
            "{named} is not a local branch of the clone"
        )));
    }
    if let Some(base_ref) = &base_ref {
        let verified = connection
            .run(
                &format!(
                    "git -C {} rev-parse -q --verify {}",
                    sh_quote(clone),
                    sh_quote(&format!("{base_ref}^{{commit}}"))
                ),
                30_000,
            )
            .await
            .stdout;
        if js::trim(&verified).is_empty() {
            return Err(invalid(format!(
                "the branch {} of {}'s part, which this one starts on, is gone",
                on_part.as_ref().map(|p| s(p, &["branch"])).unwrap_or(""),
                on.as_ref().map(|o| s(o, &["name"])).unwrap_or("")
            )));
        }
    }
    // Not the plan's changes as they are: a port of it on the base is still
    // the part's start (its content, said), never the source's commits
    // picked beside it. A branch named by from must touch the plan's files
    // as well.
    let mut start = carries.sha.clone();
    let mut ported: Option<PortedDifference> = None;
    if start.is_none() && !carries.missing {
        let mut ons: Vec<(String, String)> = Vec::new();
        if let Some(base_ref) = &base_ref {
            ons.push(("base".into(), base_ref.clone()));
        }
        for each in &stacked {
            if let Some(from) = part_of(each)
                .and_then(|p| p.get("from"))
                .and_then(Value::as_str)
                .filter(|f| !f.is_empty())
            {
                ons.push(("upstream".into(), format!("refs/heads/{from}")));
            }
            ons.push((
                "upstream".into(),
                format!("refs/heads/{}", upstream_of(&slug_of(s(each, &["name"])))),
            ));
        }
        let prepared = parse_prepared(
            &connection
                .run(
                    &prepared_script(clone, &base, &ons, &targets, s(&effort, &["source"])),
                    120_000,
                )
                .await
                .stdout,
        );
        let plan_files = plan_files(&picked);
        let set: HashSet<&String> = plan_files.iter().collect();
        let usable = prepared.sha.is_some()
            && (named.is_empty() || prepared.files.iter().any(|f| set.contains(f)));
        if usable {
            start = prepared.sha.clone();
            ported = Some(ported_difference(&plan_files, &prepared.files));
        } else if !named.is_empty() {
            return Err(invalid(format!(
                "{named} does not hold the plan's changes over the target ({}) and is no port of it on the part's base ({}): nothing made",
                carries.not.as_deref().unwrap_or("unknown"),
                if prepared.sha.is_some() {
                    "none of the plan's files".to_owned()
                } else {
                    prepared.not.clone().unwrap_or_else(|| "unknown".into())
                }
            )));
        }
    }
    let made = call.create_worktree(&effort, &branch, &*connection).await?;
    // The checkout made must be the new branch's own: never an existing
    // worktree its path led to, which is left as it is, unrecorded.
    let at = call.checkout_at(&*connection, &made.path, false).await;
    let wanted_ref = format!("refs/heads/{branch}");
    if at.first().is_none_or(|p| p.is_empty())
        || at.first() != at.get(1)
        || at.get(2) != Some(&wanted_ref)
    {
        return Err(invalid(format!(
            "{} is not a new worktree on {branch}{}: nothing picked there, and it is not this part",
            made.path,
            match at.get(2).filter(|r| !r.is_empty()) {
                Some(on) => format!(
                    " (it is on {})",
                    on.strip_prefix("refs/heads/").unwrap_or(on)
                ),
                None => String::new(),
            }
        )));
    }
    let pick_targets: Vec<String> = match (&start, &base_ref) {
        (Some(start), _) => vec![start.clone()],
        (None, Some(base_ref)) => vec![base_ref.clone()],
        (None, None) => targets.clone(),
    };
    let pick = parse_pick(
        &connection
            .run(
                &pick_script(
                    &made.path,
                    &pick_targets,
                    if start.is_some() { &[] } else { &picked_shas },
                    &branch,
                ),
                300_000,
            )
            .await
            .stdout,
    );
    // Only the commits read back on the branch count as picked (before the
    // fixups are folded, by patch id; folding must keep the tree). From a
    // branch holding them all, checked tree to tree: all of them.
    let picked_ids: Vec<String> = picked
        .iter()
        .map(|c| s(c, &["patchId"]).to_owned())
        .collect();
    let on_branch = if start.is_some() {
        if pick.error.is_some() || ported.is_some() {
            0
        } else {
            picked.len()
        }
    } else {
        pick.on_branch
            .as_ref()
            .map_or(0, |on| picked_on_branch(&picked_ids, on))
    };
    let missing = if start.is_none() && pick.error.is_none() && pick.conflict.is_none() {
        picked.len() as i64 - pick.skipped.len() as i64 - on_branch as i64
    } else {
        0
    };
    let error = pick.error.clone().or_else(|| {
        if missing > 0 {
            Some(format!(
                "{missing} of the plan's commits are not on {branch}"
            ))
        } else if pick.fold.as_ref().is_some_and(|f| !f.same_tree) {
            Some(format!(
                "folding the fixups changed what {branch} holds: look at it there"
            ))
        } else {
            None
        }
    });
    let conflict = match (&pick.conflict, &pick.folding) {
        (Some(sha), _) => Some(conflict_value(
            sha,
            &picked
                .iter()
                .find(|c| s(c, &["sha"]) == sha)
                .map(|c| s(c, &["subject"]).to_owned())
                .unwrap_or_default(),
            &pick.files,
            false,
        )),
        (None, Some((sha, subject))) => Some(conflict_value(sha, subject, &pick.files, true)),
        (None, None) => None,
    };
    // Fixups whose target is not in the part stay commits: said.
    let unfolded = unfolded_of(
        pick.fold
            .as_ref()
            .map(|f| f.unfolded.as_slice())
            .unwrap_or(&[]),
        &picked,
    );
    let folded = match (&pick.fold, &pick.on_branch) {
        (Some(fold), Some(on)) => on.count.saturating_sub(fold.count),
        _ => 0,
    };
    let mut part = Obj::new();
    part.insert(
        "connectionId".into(),
        json!(s(&effort, &["clone", "connectionId"])),
    );
    part.insert("path".into(), json!(made.path));
    part.insert("branch".into(), json!(branch));
    put_some(
        &mut part,
        "workspaceId",
        made.workspace_id.clone().map(Value::from),
    );
    if start.is_some() {
        part.insert("from".into(), json!(base));
    }
    if ported.is_some() {
        part.insert("ported".into(), json!(true));
    }
    if start.is_none()
        && let Some(on_part) = &on_part
    {
        part.insert("base".into(), json!(s(on_part, &["branch"])));
    }
    put_some(&mut part, "conflict", conflict.clone());
    if start.is_none() && conflict.is_none() && pick.error.is_none() {
        part.insert(
            "unfolded".into(),
            json!(
                unfolded
                    .iter()
                    .map(|(_, subject)| subject)
                    .collect::<Vec<_>>()
            ),
        );
    }
    let summary = format!(
        "Part {branch} made for {plan_name}{}",
        if start.is_some() {
            format!(
                " from {base}{}",
                if ported.is_some() { " (ported)" } else { "" }
            )
        } else if let Some(on_part) = &on_part {
            format!(" on {}", s(on_part, &["branch"]))
        } else {
            String::new()
        }
    );
    call.record_part(&effort, &plan["id"], part, &summary)?;
    call.place_part(&effort, &made).await;
    // Its branch is a request not proposed yet until its request opens.
    call.deps.upstream.refresh(true).await;
    let row = call
        .deps
        .upstream
        .branches()
        .into_iter()
        .find(|each| each.member.path == made.path);
    if let Some(row) = row {
        let settings = call.deps.settings.clone();
        let save = call.deps.save.clone();
        let meta = call.meta.clone();
        let title = js::head16(&plan_name, 300);
        (call.deps.edit)(Box::pin(async move {
            let mut latest = settings().await;
            let mut unsent: Vec<Value> = latest
                .get("unsent")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if unsent.iter().any(|each| s(each, &["key"]) == row.key) {
                return Ok(latest);
            }
            unsent.push(json!({"key": row.key, "title": title, "at": js::iso(js::now_ms())}));
            latest.insert("unsent".into(), Value::Array(unsent));
            save(latest, meta).await
        }))
        .await?;
    }
    call.service().refresh_one(&effort, true).await;
    call.service().push(&effort_id, call.by(), None, None).await;
    let mut out = obj(json!({
        "ok": conflict.is_none() && error.is_none(),
        "path": made.path,
        "branch": branch,
        "picked": on_branch,
        "of": picked.len(),
    }));
    if start.is_some() {
        out.insert("from".into(), json!(base));
    }
    if let Some(ported) = &ported {
        out.insert("ported".into(), json!(true));
        out.insert("differs".into(), differs(ported));
    }
    if start.is_none()
        && let Some(on_part) = &on_part
    {
        out.insert("base".into(), json!(s(on_part, &["branch"])));
    }
    if folded > 0 {
        out.insert("folded".into(), json!(folded));
    }
    if !unfolded.is_empty() {
        out.insert("unfolded".into(), unfolded_value(&unfolded));
    }
    if !pick.skipped.is_empty() {
        out.insert(
            "skipped".into(),
            Value::Array(
                pick.skipped
                    .iter()
                    .map(|sha| {
                        json!({
                            "sha": sha,
                            "subject": picked.iter().find(|c| s(c, &["sha"]) == sha).map(|c| s(c, &["subject"])).unwrap_or(""),
                        })
                    })
                    .collect(),
            ),
        );
    }
    put_some(&mut out, "conflict", conflict);
    put_some(&mut out, "error", error.map(Value::from));
    Ok(Value::Object(out))
}

async fn open_commit(call: &Call<'_>) -> RpcResult<Value> {
    // `d`: the commit's diff as a Roamgate review in the head workspace's
    // Changes (D32: the page goes there); with `from`, two versions of one
    // commit compared tree to tree.
    let effort = call.effort_of().await?;
    let sha = text_of(call.params.get("sha"), "");
    if !SHA_PARAM.is_match(&sha) {
        return Err(invalid("sha: a commit id"));
    }
    let from = match call.params.get("from") {
        None => String::new(),
        Some(value) => js::to_text(value),
    };
    if !from.is_empty() && !SHA_PARAM.is_match(&from) {
        return Err(invalid("from: a commit id"));
    }
    let (connection_id, path, known) = head_of(&effort);
    let workspace_id = call
        .workspace_at(&connection_id, &[Some(path.as_str())], known.as_deref())
        .await
        .ok_or_else(|| {
            coded(
                "its head workspace is not open: open it, or set head",
                "not_found",
            )
        })?;
    let Some(open_range) = call.deps.open_range.clone() else {
        return Err(coded("reviews cannot be opened here", "unavailable"));
    };
    let subject = super::commits_of(call.service().store().derived(s(&effort, &["id"])).as_ref())
        .iter()
        .find(|c| s(c, &["sha"]).starts_with(&sha))
        .map(|c| s(c, &["subject"]).to_owned())
        .unwrap_or_else(|| sha.clone());
    let mut input = obj(json!({
        "connectionId": connection_id,
        "workspaceId": workspace_id,
        "root": path,
    }));
    if from.is_empty() {
        input.insert("base".into(), json!(format!("{sha}^")));
        input.insert("head".into(), json!(sha));
    } else {
        input.insert("base".into(), json!(from));
        input.insert("head".into(), json!(sha));
        input.insert("compare".into(), json!(true));
    }
    let title = if from.is_empty() {
        subject
    } else {
        format!("{subject} (two versions)")
    };
    input.insert("title".into(), json!(js::head16(&title, 120)));
    let opened = open_range(input).await?;
    let mut out = obj(json!({
        "ok": true,
        "connectionId": connection_id,
        "workspaceId": workspace_id,
    }));
    out.extend(opened);
    Ok(Value::Object(out))
}

async fn effort_diff(call: &Call<'_>) -> RpcResult<Value> {
    // Between two versions of one commit (D24): read on demand, never kept.
    let effort = call.effort_of().await?;
    let from = text_of(call.params.get("from"), "");
    let to = text_of(call.params.get("to"), "");
    if !SHA_PARAM.is_match(&from) || !SHA_PARAM.is_match(&to) {
        return Err(invalid("from and to: commit ids"));
    }
    let connection = call
        .service()
        .connection_of(s(&effort, &["clone", "connectionId"]))
        .ok_or_else(not_ready)?;
    let d = sh_quote(s(&effort, &["clone", "path"]));
    let read = connection
        .run(
            &format!(
                "git -C {d} range-diff --no-color {from}^! {to}^! 2>/dev/null || git -C {d} diff --no-color {from} {to}"
            ),
            60_000,
        )
        .await;
    let text = read.stdout;
    let text = if js::len16(&text) > 200_000 {
        format!("{}\n...", js::head16(&text, 200_000))
    } else {
        text
    };
    Ok(json!({"text": text}))
}

async fn effort_threads(call: &Call<'_>) -> RpcResult<Value> {
    // The threads on the effort's view (its review, target `effort`):
    // delivered to its leader as review comments, answered in place.
    let effort = call.effort_of().await?;
    let Some(effort_review) = call.deps.effort_review.clone() else {
        return Err(coded("reviews cannot be opened here", "unavailable"));
    };
    let (connection_id, path, known) = head_of(&effort);
    let open = call.params.get("open") == Some(&Value::Bool(true));
    let workspace_id = if open {
        call.workspace_at(&connection_id, &[Some(path.as_str())], known.as_deref())
            .await
    } else {
        None
    };
    let mut input = obj(json!({
        "effort": effort["id"],
        "connectionId": connection_id,
    }));
    if let Some(workspace_id) = workspace_id {
        input.insert("workspaceId".into(), json!(workspace_id));
    }
    input.insert("root".into(), json!(path));
    input.insert(
        "title".into(),
        json!(format!("Effort {}", s(&effort, &["name"]))),
    );
    input.insert("open".into(), json!(open));
    Ok(json!({"snapshot": effort_review(input).await}))
}

async fn effort_leader(call: &Call<'_>) -> RpcResult<Value> {
    // The effort's leader is the Claude session of its head workspace
    // (D15); only the user starts it (D18).
    let effort = call.effort_of().await?;
    let (connection_id, path, known) = head_of(&effort);
    let connection = call
        .service()
        .connection_of(&connection_id)
        .ok_or_else(not_ready)?;
    let workspace_id = call
        .workspace_at(&connection_id, &[Some(path.as_str())], known.as_deref())
        .await
        .ok_or_else(|| {
            coded(
                "its head workspace is not open: open it, or set head",
                "not_found",
            )
        })?;
    let listed = connection
        .herdr("pane.list", json!({}))
        .await
        .map_err(RpcError::Failed)?;
    let panes: Vec<String> = listed
        .get("panes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|pane| pane.get("workspace_id").and_then(Value::as_str) == Some(&workspace_id))
        .map(|pane| js::sv(pane.get("pane_id")).to_owned())
        .collect();
    let mut free: Option<String> = None;
    for pane in &panes {
        // A pane conversation mode holds runs its Claude, even stopped:
        // Herdr sees only the holder there, yet a message wakes the session.
        let held = connection.conversation_owned(pane).await.is_some();
        let name = if held {
            "claude".to_owned()
        } else {
            connection
                .herdr("agent.get", json!({"target": pane}))
                .await
                .ok()
                .and_then(|answer| answer.get("agent").cloned())
                .and_then(|agent| {
                    agent
                        .get("agent")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default()
        };
        if name.to_lowercase().contains("claude") {
            return Ok(json!({
                "state": "ready",
                "connectionId": connection_id,
                "workspaceId": workspace_id,
                "paneId": pane,
            }));
        }
        if name.is_empty() && free.is_none() {
            free = Some(pane.clone());
        }
    }
    let start = call.params.get("start") == Some(&Value::Bool(true));
    let Some(free) = free.clone().filter(|_| start) else {
        return Ok(json!({
            "state": if free.is_some() { "none" } else { "busy" },
            "connectionId": connection_id,
            "workspaceId": workspace_id,
        }));
    };
    connection
        .herdr(
            "pane.send_text",
            json!({
                "pane_id": free,
                "text": crate::claude::claude_command(
                    &roamgate_base::paths::random_uuid(),
                    false,
                    crate::claude::StartMode::Terminal,
                    None,
                )
                .map_err(RpcError::Failed)?,
            }),
        )
        .await
        .map_err(RpcError::Failed)?;
    Ok(json!({
        "state": "starting",
        "connectionId": connection_id,
        "workspaceId": workspace_id,
        "paneId": free,
    }))
}
