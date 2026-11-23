//! The stored arrangement (config/workspace-tree.ts): settings.json
//! `workspace_tree`, written only through its one writer
//! ([`SettingsAccess::update`]), each change told to the listeners (the
//! browsers' `{"workspace_tree": tree}` push); automatic placement; an
//! agent's `--group`; and the pruning of workspaces that are gone.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::SharedClock;
use roamgate_base::settings::Settings;
use serde_json::{Map, Value, json};

use super::{
    PathOptions, TreeError, apply_op, apply_workspace_tree_op, auto_place_workspace,
    empty_workspace_tree, find_workspace_node, gone_workspace_tree_nodes, parse_workspace_tree_op,
    parse_workspace_tree_path, remove_workspace_tree_nodes, resolve_workspace_tree_path,
    workspace_identity, workspace_ref_for, workspace_tree_ancestors, workspace_tree_group_paths,
    workspace_tree_node_name,
};
use crate::connection::{Herdr, HerdrCallOptions, RpcResult, SettingsAccess, WorkspaceError};

/// The arrangement is configuration: refuse one grown past any real use.
pub const WORKSPACE_TREE_MAX_BYTES: usize = 512 * 1024;

/// A failure of the store: an operation that cannot apply (said to the
/// user as it is), or anything else.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Tree(#[from] TreeError),
    #[error("{0}")]
    Other(String),
}

impl From<StoreError> for WorkspaceError {
    fn from(error: StoreError) -> Self {
        WorkspaceError::new(error.to_string())
    }
}

/// Told the new arrangement after every change, whoever made it.
pub type TreeListener = Arc<dyn Fn(&Value) + Send + Sync>;

fn tree_of(settings: &Settings) -> Value {
    settings
        .get("workspace_tree")
        .cloned()
        .unwrap_or_else(empty_workspace_tree)
}

fn is_empty_tree(tree: &Value) -> bool {
    tree["nodes"].as_array().is_none_or(Vec::is_empty)
}

/// The settings with `tree` (none when it holds nothing).
fn with_tree(settings: &Settings, tree: &Value) -> Value {
    settings.with(
        "workspace_tree",
        (!is_empty_tree(tree)).then(|| tree.clone()),
    )
}

/// The server's arrangement, on settings.json's writer.
pub struct WorkspaceTreeStore {
    settings: Arc<dyn SettingsAccess>,
    listeners: Mutex<Vec<(u64, TreeListener)>>,
    next: Mutex<u64>,
}

impl WorkspaceTreeStore {
    pub fn new(settings: Arc<dyn SettingsAccess>) -> Arc<Self> {
        Arc::new(Self {
            settings,
            listeners: Mutex::default(),
            next: Mutex::new(0),
        })
    }

    /// `onWorkspaceTreeChanged`: the listener's id, for [`Self::unlisten`].
    pub fn listen(&self, listener: TreeListener) -> u64 {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        self.listeners.lock().unwrap().push((*next, listener));
        *next
    }

    pub fn unlisten(&self, id: u64) {
        self.listeners
            .lock()
            .unwrap()
            .retain(|(each, _)| *each != id);
    }

    fn tell(&self, tree: &Value) {
        let listeners: Vec<TreeListener> = self
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener(tree);
        }
    }

    /// `readWorkspaceTree`.
    pub async fn read(&self) -> Value {
        tree_of(&*self.settings.read().await)
    }

    /// `applyWorkspaceTreeOps`: applies operations in one settings write,
    /// so two browsers rearranging at once both land, and tells every
    /// listener. Nothing is written when one cannot apply.
    pub async fn apply_ops(&self, ops: &[Value]) -> Result<Value, StoreError> {
        let failure: Arc<Mutex<Option<StoreError>>> = Arc::default();
        let changed: Arc<Mutex<bool>> = Arc::default();
        let (ops, kept_failure, kept_changed) = (ops.to_vec(), failure.clone(), changed.clone());
        let settings = self
            .settings
            .update(Box::new(move |current: &Settings| {
                let before = tree_of(current);
                let mut tree = before.clone();
                let mut same = true;
                for op in &ops {
                    match apply_op(&tree, op) {
                        Ok(Some(next)) => {
                            tree = next;
                            same = false;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            *kept_failure.lock().unwrap() = Some(error.into());
                            return None;
                        }
                    }
                }
                if same {
                    return None;
                }
                if tree.to_string().len() > WORKSPACE_TREE_MAX_BYTES {
                    *kept_failure.lock().unwrap() = Some(StoreError::Other(
                        "The workspace arrangement is too large.".into(),
                    ));
                    return None;
                }
                *kept_changed.lock().unwrap() = true;
                Some(with_tree(current, &tree))
            }))
            .await
            .map_err(StoreError::Other)?;
        if let Some(error) = failure.lock().unwrap().take() {
            return Err(error);
        }
        let tree = tree_of(&settings);
        if *changed.lock().unwrap() {
            self.tell(&tree);
        }
        Ok(tree)
    }

    /// `pruneGoneWorkspaces`: takes out of the arrangement the workspaces
    /// of `connection_id` that Herdr confirms gone, judged against the
    /// stored tree at the time of writing; `only` narrows them to nodes an
    /// earlier read found gone too. Returns the nodes removed.
    pub async fn prune_gone(
        &self,
        connection_id: &str,
        live: &[Value],
        closed: Option<&Value>,
        only: Option<&HashSet<String>>,
    ) -> Result<Vec<String>, StoreError> {
        let removed: Arc<Mutex<Vec<String>>> = Arc::default();
        let failure: Arc<Mutex<Option<StoreError>>> = Arc::default();
        let (connection, live, closed, only) = (
            connection_id.to_owned(),
            live.to_vec(),
            closed.cloned(),
            only.cloned(),
        );
        let (kept, kept_failure) = (removed.clone(), failure.clone());
        let settings = self
            .settings
            .update(Box::new(move |current: &Settings| {
                let before = tree_of(current);
                let gone: Vec<String> =
                    gone_workspace_tree_nodes(&before, &connection, &live, closed.as_ref())
                        .into_iter()
                        .filter(|id| only.as_ref().is_none_or(|only| only.contains(id)))
                        .collect();
                if gone.is_empty() {
                    return None;
                }
                match remove_workspace_tree_nodes(&before, &gone) {
                    Ok(tree) => {
                        *kept.lock().unwrap() = gone;
                        Some(with_tree(current, &tree))
                    }
                    Err(error) => {
                        *kept_failure.lock().unwrap() = Some(error.into());
                        None
                    }
                }
            }))
            .await
            .map_err(StoreError::Other)?;
        if let Some(error) = failure.lock().unwrap().take() {
            return Err(error);
        }
        let removed = removed.lock().unwrap().clone();
        if !removed.is_empty() {
            self.tell(&tree_of(&settings));
        }
        Ok(removed)
    }

    /// `placeCreatedWorkspace`: a workspace made for an agent goes under
    /// the workspace that agent works in ([`auto_place_workspace`] says
    /// when it is left alone). Whether the arrangement changed.
    pub async fn place_created_workspace(
        &self,
        connection_id: &str,
        workspace: Option<&Value>,
        parent_connection_id: Option<&str>,
        parent: Option<&Value>,
    ) -> Result<bool, StoreError> {
        let has_id = |value: Option<&Value>| {
            value
                .and_then(|value| value.get("workspace_id"))
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        };
        if !has_id(workspace) || !has_id(parent) {
            return Ok(false);
        }
        let child = placement_ref(connection_id, workspace.unwrap());
        let parent = placement_ref(
            parent_connection_id.unwrap_or(connection_id),
            parent.unwrap(),
        );
        let changed: Arc<Mutex<bool>> = Arc::default();
        let failure: Arc<Mutex<Option<StoreError>>> = Arc::default();
        let (kept, kept_failure) = (changed.clone(), failure.clone());
        let settings = self
            .settings
            .update(Box::new(
                move |current: &Settings| match auto_place_workspace(
                    &tree_of(current),
                    &child,
                    &parent,
                ) {
                    Ok(None) => None,
                    Ok(Some(tree)) => {
                        *kept.lock().unwrap() = true;
                        Some(current.with("workspace_tree", Some(tree)))
                    }
                    Err(error) => {
                        *kept_failure.lock().unwrap() = Some(error.into());
                        None
                    }
                },
            ))
            .await
            .map_err(StoreError::Other)?;
        if let Some(error) = failure.lock().unwrap().take() {
            return Err(error);
        }
        let changed = *changed.lock().unwrap();
        if changed {
            self.tell(&tree_of(&settings));
        }
        Ok(changed)
    }
}

/// `placementRef`: a workspace's reference, with what automatic placement
/// reads of its checkout.
fn placement_ref(connection_id: &str, workspace: &Value) -> Value {
    let mut out = workspace_ref_for(connection_id, workspace)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let worktree = workspace
        .get("worktree")
        .filter(|worktree| worktree.is_object());
    if let Some(key) = worktree
        .and_then(|worktree| worktree.get("repo_key"))
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
    {
        out.insert("repo_key".into(), json!(key));
    }
    if let Some(worktree) = worktree {
        out.insert(
            "linked".into(),
            json!(worktree.get("is_linked_worktree") == Some(&Value::Bool(true))),
        );
    }
    Value::Object(out)
}

/// `closedWorkspaceOfEvent`: what a Herdr `workspace.closed` or
/// `worktree.removed` event names, or None.
pub fn closed_workspace_of_event(event: &Value) -> Option<Value> {
    let envelope = event.as_object()?;
    let empty = Value::Object(Map::new());
    let data = envelope
        .get("data")
        .filter(|data| !data.is_null())
        .unwrap_or(&empty);
    let name = envelope
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| data.get("type").and_then(Value::as_str))
        .unwrap_or("");
    let kind = name.replace('_', ".");
    if kind != "workspace.closed" && kind != "worktree.removed" {
        return None;
    }
    let workspace = data
        .get("workspace")
        .filter(|w| !w.is_null())
        .unwrap_or(&empty);
    let id = data
        .get("workspace_id")
        .and_then(Value::as_str)
        .or_else(|| workspace.get("workspace_id").and_then(Value::as_str))
        .unwrap_or("");
    if id.is_empty() {
        return None;
    }
    let worktree = workspace
        .get("worktree")
        .filter(|w| !w.is_null())
        .or_else(|| data.get("worktree").filter(|w| !w.is_null()))
        .unwrap_or(&empty);
    let path = worktree
        .get("checkout_path")
        .and_then(Value::as_str)
        .or_else(|| worktree.get("path").and_then(Value::as_str))
        .unwrap_or("");
    let label = workspace.get("label").and_then(Value::as_str).unwrap_or("");
    let mut out = Map::new();
    out.insert("workspace_id".into(), json!(id));
    if !label.is_empty() {
        out.insert("label".into(), json!(label));
    }
    if !path.is_empty() {
        out.insert("path".into(), json!(path));
    }
    Some(Value::Object(out))
}

/// The workspaces Herdr lists as the tree recognises them
/// (`listWorkspaceIdentities` once listed and enriched), or None when the
/// listing has no workspaces array.
pub fn workspace_identities(listed: &Value) -> Option<Vec<Value>> {
    let workspaces = listed.get("workspaces")?.as_array()?;
    Some(
        workspaces
            .iter()
            .filter(|each| {
                each.get("workspace_id").is_some_and(Value::is_string)
                    && each.get("label").is_some_and(Value::is_string)
            })
            .map(workspace_identity)
            .collect(),
    )
}

/// Enriches a `workspace.list` answer (the worktree parents).
pub type EnrichList = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

/// `listWorkspaceIdentities`: a ready connection's workspaces as the tree
/// recognises them, or None.
pub async fn list_workspace_identities(
    herdr: &dyn Herdr,
    enrich: Option<&EnrichList>,
) -> Result<Option<Vec<Value>>, String> {
    let mut listed = herdr
        .call(
            "workspace.list",
            json!({}),
            HerdrCallOptions::timeout(Duration::from_millis(5000)),
        )
        .await?;
    if !listed.get("workspaces").is_some_and(Value::is_array) {
        return Ok(None);
    }
    if let Some(enrich) = enrich {
        listed = enrich(listed).await?;
    }
    Ok(workspace_identities(&listed))
}

/// `placeCreatedWorkspaceUnder` (index.ts): the workspace a worktree or
/// session was made for goes under the workspace that asked. Never fails
/// the creation: an error is given back for the log only.
pub async fn place_created_workspace_under(
    store: &WorkspaceTreeStore,
    connection_id: &str,
    herdr: &dyn Herdr,
    enrich: Option<&EnrichList>,
    created: &Value,
    requester: Option<&str>,
) -> Result<(), String> {
    let Some(requester) = requester.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if connection_id.is_empty() {
        return Ok(());
    }
    let record = if created.is_object() {
        created.clone()
    } else {
        json!({})
    };
    let workspace_id = record
        .get("workspace")
        .and_then(|workspace| workspace.get("workspace_id"))
        .filter(|id| !id.is_null())
        .or_else(|| record.get("workspace_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(workspace_id) = workspace_id.filter(|id| id != requester) else {
        return Ok(());
    };
    let list = herdr
        .call("workspace.list", json!({}), HerdrCallOptions::default())
        .await?;
    let enriched = match enrich {
        Some(enrich) => enrich(list).await?,
        None => list,
    };
    let find = |id: &str| {
        enriched
            .get("workspaces")
            .and_then(Value::as_array)
            .and_then(|list| {
                list.iter()
                    .find(|each| each.get("workspace_id").and_then(Value::as_str) == Some(id))
            })
            .cloned()
    };
    let workspace = find(&workspace_id).or_else(|| record.get("workspace").cloned());
    let parent = find(requester);
    store
        .place_created_workspace(connection_id, workspace.as_ref(), None, parent.as_ref())
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// What an agent asks of the arrangement (`agentGroupPlacementOps`).
#[derive(Default)]
pub struct GroupPlacement<'a> {
    /// What goes there; without it, only whether the path leads somewhere.
    pub subject: Option<Value>,
    /// The agent's workspace.
    pub asker: Option<Value>,
    /// Its repository's main checkout, when the list nests it there.
    pub asker_usual_parent: Option<Value>,
    pub group: String,
    pub create: bool,
    pub new_id: Option<&'a mut dyn FnMut() -> String>,
}

/// The operations, the whole path from the top, the groups made.
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub ops: Vec<Value>,
    pub path: Vec<String>,
    pub created: Vec<String>,
}

impl Placement {
    pub fn to_json(&self) -> Value {
        json!({ "ops": self.ops, "path": self.path, "created": self.created })
    }
}

/// `agentPathBases`: the top level, then the group the agent's workspace
/// sits in and each one above.
fn agent_path_bases(
    tree: &Value,
    asker: Option<&Value>,
    usual_parent: Option<&Value>,
) -> Vec<Option<String>> {
    let node = asker.and_then(|asker| find_workspace_node(tree, asker));
    let placed = node.is_some_and(|node| {
        node.get("parent").is_some_and(|p| !p.is_null()) || node.get("root").is_some()
    });
    let start = if placed {
        node.and_then(|node| node.get("parent"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        usual_parent
            .and_then(|parent| find_workspace_node(tree, parent))
            .and_then(|node| node.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let mut bases = vec![None];
    bases.extend(
        workspace_tree_ancestors(tree, start.as_deref())
            .into_iter()
            .map(Some),
    );
    bases
}

/// `agentGroupPlacementOps`: an agent putting a workspace into a group
/// (`roamgate-review worktree|workspace|place --group PATH`).
pub fn agent_group_placement_ops(
    tree: &Value,
    input: GroupPlacement<'_>,
) -> Result<Placement, TreeError> {
    let names = parse_workspace_tree_path(&input.group);
    if names.is_empty() {
        return Err(TreeError("The group path is empty.".into()));
    }
    let resolved = resolve_workspace_tree_path(
        tree,
        &names,
        PathOptions {
            bases: agent_path_bases(
                tree,
                input.asker.as_ref(),
                input.asker_usual_parent.as_ref(),
            ),
            create: input.create,
            prefer_connection: input
                .subject
                .as_ref()
                .or(input.asker.as_ref())
                .and_then(|each| each.get("connection_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            new_id: input.new_id,
        },
    )
    .ok_or_else(|| {
        TreeError(format!(
            "No group \"{}\" in the Workspaces tree: see roamgate-review groups, or add --create-group.",
            names.join("/")
        ))
    })?;
    let mut ops = resolved.ops.clone();
    if let Some(subject) = &input.subject {
        if find_workspace_node(tree, subject)
            .and_then(|node| node.get("id"))
            .and_then(Value::as_str)
            == Some(resolved.node.as_str())
        {
            return Err(TreeError("A workspace cannot go inside itself.".into()));
        }
        ops.push(json!({
            "op": "move",
            "subject": { "workspace": subject },
            "parent": { "node": resolved.node },
        }));
    }
    // Refused here, before anything is written, if it cannot apply.
    let mut check = tree.clone();
    for op in &ops {
        check = apply_workspace_tree_op(&check, op)?;
    }
    let created: Vec<String> = resolved
        .ops
        .iter()
        .filter(|op| op["op"] == "create_group")
        .filter_map(|op| op["label"].as_str().map(str::to_owned))
        .collect();
    // The whole path from the top, whichever base it was found from.
    let reached = match resolved.ops.first() {
        Some(first) if first["op"] == "create_group" => first["parent"]
            .get("node")
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => Some(resolved.node.clone()),
    };
    let by_id: HashMap<&str, &Value> = check["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|node| (node["id"].as_str().unwrap_or(""), node))
        .collect();
    let mut path: Vec<String> = workspace_tree_ancestors(tree, reached.as_deref())
        .into_iter()
        .rev()
        .map(|id| {
            by_id
                .get(id.as_str())
                .map(|node| workspace_tree_node_name(node))
                .unwrap_or_default()
        })
        .collect();
    path.extend(created.iter().cloned());
    Ok(Placement { ops, path, created })
}

/// `agentGroupPaths`: the group paths an agent can give (`roamgate-review
/// groups`), and the one its own workspace sits in.
pub fn agent_group_paths(
    tree: &Value,
    asker: Option<&Value>,
    usual_parent: Option<&Value>,
) -> Value {
    let paths = workspace_tree_group_paths(tree);
    let bases = agent_path_bases(tree, asker, usual_parent);
    let yours = match bases.get(1) {
        None => Value::Null,
        Some(own) => paths
            .iter()
            .find(|each| Some(&each.node) == own.as_ref())
            .map_or(Value::Null, |each| json!(each.names.join("/"))),
    };
    let groups: Vec<Value> = paths
        .iter()
        .map(|each| {
            let mut out = Map::new();
            out.insert("path".into(), json!(each.names.join("/")));
            out.insert("kind".into(), json!(each.kind));
            if let Some(connection) = &each.connection_id {
                out.insert("connection_id".into(), json!(connection));
            }
            Value::Object(out)
        })
        .collect();
    json!({ "groups": groups, "yours": yours })
}

/// The workspace tree's browser RPCs: `bridge.workspace_tree.get` and
/// `.apply` (index.ts); None for any other method. The arrangement belongs
/// to this server and spans every connection.
pub async fn rpc(store: &WorkspaceTreeStore, method: &str, params: &Value) -> Option<RpcResult> {
    match method {
        "bridge.workspace_tree.get" => Some(Ok(json!({ "tree": store.read().await }))),
        "bridge.workspace_tree.apply" => {
            let raw: Vec<Value> = params
                .get("ops")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let ops: Vec<Option<Value>> =
                raw.iter().take(64).map(parse_workspace_tree_op).collect();
            if ops.is_empty() || ops.iter().any(Option::is_none) {
                return Some(Err(WorkspaceError::new(
                    "bridge.workspace_tree.apply needs valid ops",
                )));
            }
            let ops: Vec<Value> = ops.into_iter().flatten().collect();
            Some(
                store
                    .apply_ops(&ops)
                    .await
                    .map(|tree| json!({ "tree": tree }))
                    .map_err(WorkspaceError::from),
            )
        }
        _ if method.starts_with("bridge.workspace_tree.") => Some(Err(WorkspaceError::new(
            format!("unknown bridge-global method: {method}"),
        ))),
        _ => None,
    }
}

/// A connection's workspaces now, or None when it is not ready.
pub type ListLive =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<Vec<Value>>, String>> + Send + Sync>;

/// Told a failure of a read or a prune, with its connection.
pub type OnPruneError = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// How the pruner reads and waits.
pub struct PrunerOptions {
    pub list: ListLive,
    pub clock: SharedClock,
    /// How long a ready connection's second read waits (5 s).
    pub confirm: Duration,
    /// How long after a ready connection the first read waits (3 s).
    pub settle: Duration,
    pub on_error: Option<OnPruneError>,
}

type Queued = Shared<BoxFuture<'static, ()>>;

/// `createWorkspaceTreePruner`: keeps the arrangement free of workspaces
/// that no longer exist. A workspace Herdr reports closed leaves at once.
/// When a connection becomes ready, what it no longer has leaves too, once
/// two reads a few seconds apart agree. A connection that is down is never
/// read: its workspaces stay, shown offline.
pub struct WorkspaceTreePruner {
    store: Arc<WorkspaceTreeStore>,
    options: PrunerOptions,
    timers: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    queues: Mutex<HashMap<String, (u64, Queued)>>,
    next: Mutex<u64>,
    disposed: std::sync::atomic::AtomicBool,
}

impl WorkspaceTreePruner {
    pub fn new(store: Arc<WorkspaceTreeStore>, options: PrunerOptions) -> Arc<Self> {
        Arc::new(Self {
            store,
            options,
            timers: Mutex::default(),
            queues: Mutex::default(),
            next: Mutex::new(0),
            disposed: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn disposed(&self) -> bool {
        self.disposed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// One read and prune per connection at a time, in order.
    fn queue(
        self: &Arc<Self>,
        connection_id: &str,
        run: impl FnOnce(Arc<Self>) -> BoxFuture<'static, Result<(), String>> + Send + 'static,
    ) -> Queued {
        let mut queues = self.queues.lock().unwrap();
        let previous = queues.get(connection_id).map(|(_, queued)| queued.clone());
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        let pruner = self.clone();
        let connection = connection_id.to_owned();
        let task = tokio::spawn(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            if !pruner.disposed()
                && let Err(error) = run(pruner.clone()).await
                && let Some(on_error) = &pruner.options.on_error
            {
                on_error(&error, &connection);
            }
            let mut queues = pruner.queues.lock().unwrap();
            if queues.get(&connection).is_some_and(|(each, _)| *each == id) {
                queues.remove(&connection);
            }
        });
        let queued: Queued = async move {
            let _ = task.await;
        }
        .boxed()
        .shared();
        queues.insert(connection_id.to_owned(), (id, queued.clone()));
        queued
    }

    /// `event`: a Herdr event of `connection_id`; a closed workspace
    /// leaves the tree. None when the event closes nothing.
    pub fn event(self: &Arc<Self>, connection_id: &str, event: &Value) -> Option<Queued> {
        let closed = closed_workspace_of_event(event)?;
        let connection = connection_id.to_owned();
        Some(self.queue(connection_id, move |pruner| {
            async move {
                let live = (pruner.options.list)(connection.clone()).await?;
                if let Some(live) = live {
                    pruner
                        .store
                        .prune_gone(&connection, &live, Some(&closed), None)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            .boxed()
        }))
    }

    /// `ready`: `connection_id` became ready; what it no longer has leaves,
    /// confirmed by a second read.
    pub fn ready(self: &Arc<Self>, connection_id: &str) {
        let pruner = self.clone();
        let connection = connection_id.to_owned();
        let timer = tokio::spawn(async move {
            pruner.options.clock.sleep(pruner.options.settle).await;
            pruner.timers.lock().unwrap().remove(&connection);
            drop(pruner.confirm(&connection));
        });
        if let Some(previous) = self
            .timers
            .lock()
            .unwrap()
            .insert(connection_id.to_owned(), timer)
        {
            previous.abort();
        }
    }

    fn confirm(self: &Arc<Self>, connection_id: &str) -> Queued {
        let connection = connection_id.to_owned();
        self.queue(connection_id, move |pruner| {
            async move {
                let Some(first) = (pruner.options.list)(connection.clone()).await? else {
                    return Ok(());
                };
                let gone = gone_workspace_tree_nodes(
                    &pruner.store.read().await,
                    &connection,
                    &first,
                    None,
                );
                if gone.is_empty() {
                    return Ok(());
                }
                pruner.options.clock.sleep(pruner.options.confirm).await;
                if pruner.disposed() {
                    return Ok(());
                }
                if let Some(second) = (pruner.options.list)(connection.clone()).await? {
                    let only: HashSet<String> = gone.into_iter().collect();
                    pruner
                        .store
                        .prune_gone(&connection, &second, None, Some(&only))
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            .boxed()
        })
    }

    /// Waits for the reads under way (tests).
    pub async fn idle(&self) {
        loop {
            let pending: Vec<Queued> = self
                .queues
                .lock()
                .unwrap()
                .values()
                .map(|(_, queued)| queued.clone())
                .collect();
            if pending.is_empty() {
                return;
            }
            futures_util::future::join_all(pending).await;
        }
    }

    pub fn dispose(&self) {
        self.disposed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        for (_, timer) in self.timers.lock().unwrap().drain() {
            timer.abort();
        }
    }
}

#[cfg(test)]
mod tests;
