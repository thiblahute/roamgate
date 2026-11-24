//! Ranger's tools for the user's arrangement of the Workspaces list
//! (`assistant/workspace-tree-tools.ts`): the same operations the sidebar
//! sends (roamgate-workspace's `tree`), applied through the same server
//! store, so a browser sees Ranger's change as one push. Arranging is
//! reversible and touches no workspace, so these run without the
//! confirmation the propose_* tools need.
//!
//! The tools' names, descriptions and schemas are the catalog's
//! ([`crate::tools`], family [`Family::Tree`](crate::tools::Family::Tree));
//! [`call_tool`](crate::tools::call_tool) checks the parameters and masks
//! what is not the user's (`callWorkspaceTreeTool`). Trees, nodes and
//! operations are the JSON the TS builds, key for key.

use std::sync::Arc;
use std::time::Duration;

use roamgate_agents::js;
use roamgate_workspace::tree::{
    Resolved, ResolvedTree, apply_workspace_tree_op, find_workspace_node, live_workspace_key,
    new_workspace_tree_group_id, resolve_workspace_tree, workspace_identity, workspace_ref_for,
    workspace_tree_root_place,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::errors::{AssistantError, AssistantResult};
use crate::tools::{BoxFuture, Handler, ToolResult};

/// A connection's state: only a ready one lists its workspaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeConnectionState {
    Ready,
    Offline,
    Error,
}

impl TreeConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Offline => "offline",
            Self::Error => "error",
        }
    }
}

/// `TreeToolConnection`: a connection and its workspaces, each as Herdr's
/// `workspace.list` gives it with Roamgate's additions (`workspace_id`,
/// `number`, `label`, `cwd`, `worktree`: `repo_key`, `repo_name`,
/// `checkout_path`, `is_linked_worktree`, `parent_workspace_id`,
/// `git_status.branch`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeToolConnection {
    pub connection_id: String,
    pub label: String,
    pub state: TreeConnectionState,
    pub workspaces: Vec<Value>,
}

/// A backend failure: whether its message may be shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeBackendError {
    /// `WorkspaceTreeError`: the tree's own refusal of an operation. From
    /// `apply` it is shown (the arrangement changed meanwhile).
    Refused(String),
    /// Anything else; never shown.
    Failed(String),
}

impl From<roamgate_workspace::tree::TreeError> for TreeBackendError {
    fn from(error: roamgate_workspace::tree::TreeError) -> Self {
        Self::Refused(error.0)
    }
}

pub type TreeBackendResult<T> = Result<T, TreeBackendError>;

/// `WorkspaceTreeToolBackend`: the server's store and its connections.
pub trait WorkspaceTreeToolBackend: Send + Sync {
    fn connections(
        &self,
        signal: Option<CancellationToken>,
    ) -> BoxFuture<TreeBackendResult<Vec<TreeToolConnection>>>;
    /// The stored tree.
    fn read(&self) -> BoxFuture<TreeBackendResult<Value>>;
    /// All the operations in one settings write; a refusal writes nothing.
    fn apply(&self, ops: Vec<Value>) -> BoxFuture<TreeBackendResult<Value>>;
}

fn masked(error: TreeBackendError) -> AssistantError {
    match error {
        TreeBackendError::Refused(message) | TreeBackendError::Failed(message) => {
            AssistantError::internal(message)
        }
    }
}

fn aborted(signal: &Option<CancellationToken>) -> AssistantResult<()> {
    if signal.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Err(AssistantError::internal("aborted"));
    }
    Ok(())
}

// ------------------------------------------------------------ JSON access

/// A field, `undefined` and `null` alike absent (`??`).
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A string field that is truthy.
fn truthy<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    text(value, key).filter(|text| !text.is_empty())
}

fn id_of(node: &Value) -> &str {
    text(node, "id").unwrap_or("")
}

fn parent_of(node: &Value) -> Option<&str> {
    text(node, "parent")
}

fn is_group(node: &Value) -> bool {
    text(node, "kind") == Some("group")
}

fn is_workspace(node: &Value) -> bool {
    text(node, "kind") == Some("workspace")
}

fn label_of(node: &Value) -> &str {
    text(node, "label").unwrap_or("")
}

fn ref_of(node: &Value) -> &Value {
    node.get("ref").unwrap_or(&Value::Null)
}

fn collapsed(node: &Value) -> bool {
    node.get("collapsed").and_then(Value::as_bool) == Some(true)
}

fn nodes(tree: &Value) -> &[Value] {
    tree.get("nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn path_of(workspace: &Value) -> Option<String> {
    text(&workspace_identity(workspace), "path").map(str::to_owned)
}

/// The repository main checkout the usual list nests a worktree under.
fn repo_parent<'a>(workspaces: &'a [Value], workspace: &Value) -> Option<&'a Value> {
    let worktree = field(workspace, "worktree")?;
    if worktree.get("is_linked_worktree").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let repo_key = truthy(worktree, "repo_key")?;
    let mains: Vec<&Value> = workspaces
        .iter()
        .filter(|each| {
            field(each, "worktree").is_some_and(|tree| {
                tree.get("is_linked_worktree").and_then(Value::as_bool) == Some(false)
                    && text(tree, "repo_key") == Some(repo_key)
            })
        })
        .collect();
    let explicit = text(worktree, "parent_workspace_id").and_then(|parent| {
        mains
            .iter()
            .find(|each| text(each, "workspace_id") == Some(parent))
    });
    explicit
        .copied()
        .or_else(|| (mains.len() == 1).then(|| mains[0]))
}

fn live_map(connections: &[TreeToolConnection]) -> Vec<(String, Vec<Value>)> {
    connections
        .iter()
        .filter(|connection| connection.state == TreeConnectionState::Ready)
        .map(|connection| {
            (
                connection.connection_id.clone(),
                connection
                    .workspaces
                    .iter()
                    .map(workspace_identity)
                    .collect(),
            )
        })
        .collect()
}

fn state_of<'a>(resolved: &'a ResolvedTree, id: &str) -> Option<&'a Resolved> {
    resolved
        .nodes
        .iter()
        .find(|(each, _)| each == id)
        .map(|(_, state)| state)
}

/// A place from `where`, read after a verb: "in the top level", "under X".
fn at(place: &str) -> String {
    if place.starts_with("under ") {
        place.to_owned()
    } else {
        format!("in {place}")
    }
}

fn root_name(root: &str) -> &'static str {
    match root {
        "top" => "the top level, above the list",
        "bottom" => "the top level, below the list",
        _ => "the top level, in Herdr's list order",
    }
}

// --------------------------------------------------------------- the view

/// The view of the tree and the live workspaces one call works with.
struct TreeView<'a> {
    connections: &'a [TreeToolConnection],
    tree: Value,
}

impl<'a> TreeView<'a> {
    fn new(connections: &'a [TreeToolConnection], tree: Value) -> Self {
        Self { connections, tree }
    }

    fn resolved(&self) -> ResolvedTree {
        resolve_workspace_tree(&self.tree, &live_map(self.connections))
    }

    fn node(&self, id: &str) -> Option<&Value> {
        nodes(&self.tree).iter().find(|each| id_of(each) == id)
    }

    /// The live workspace a workspace node stands for, if open.
    fn live_of(&self, node: &Value) -> Option<(&'a TreeToolConnection, &'a Value)> {
        if !is_workspace(node) {
            return None;
        }
        let resolved = self.resolved();
        let Some(Resolved::Live {
            connection_id,
            workspace_id,
        }) = state_of(&resolved, id_of(node))
        else {
            return None;
        };
        let connection = self
            .connections
            .iter()
            .find(|each| &each.connection_id == connection_id)?;
        let workspace = connection
            .workspaces
            .iter()
            .find(|each| text(each, "workspace_id") == Some(workspace_id.as_str()))?;
        Some((connection, workspace))
    }

    fn live_label(&self, node: &Value) -> Option<String> {
        self.live_of(node)
            .and_then(|(_, workspace)| text(workspace, "label"))
            .map(str::to_owned)
    }

    fn node_name(&self, node: &Value) -> String {
        if is_group(node) {
            return format!("group \"{}\"", label_of(node));
        }
        let reference = ref_of(node);
        let label = self
            .live_label(node)
            .or_else(|| text(reference, "label").map(str::to_owned))
            .or_else(|| text(reference, "path").map(str::to_owned))
            .unwrap_or_else(|| "workspace".to_owned());
        format!(
            "\"{label}\" ({})",
            text(reference, "connection_id").unwrap_or("undefined")
        )
    }

    fn connection_list(&self) -> String {
        self.connections
            .iter()
            .map(|each| each.connection_id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn group_list(&self) -> String {
        let groups: Vec<String> = nodes(&self.tree)
            .iter()
            .filter(|node| is_group(node))
            .map(|node| format!("\"{}\" ({})", label_of(node), id_of(node)))
            .collect();
        if groups.is_empty() {
            "There are no groups.".to_owned()
        } else {
            format!("Groups: {}.", groups.join(", "))
        }
    }

    fn find_group(&self, name: &str) -> AssistantResult<&Value> {
        let groups: Vec<&Value> = nodes(&self.tree)
            .iter()
            .filter(|node| is_group(node))
            .collect();
        if let Some(by_id) = groups.iter().find(|node| id_of(node) == name) {
            return Ok(by_id);
        }
        let wanted = js::trim(name).to_lowercase();
        let named: Vec<&Value> = groups
            .into_iter()
            .filter(|node| label_of(node).to_lowercase() == wanted)
            .collect();
        match named.as_slice() {
            [one] => Ok(one),
            [] => Err(AssistantError::user(format!(
                "Unknown group \"{name}\". {}",
                self.group_list()
            ))),
            several => Err(AssistantError::user(format!(
                "Several groups are named \"{name}\" ({}); name one by its id.",
                several
                    .iter()
                    .map(|node| id_of(node))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        }
    }

    /// A workspace or group as an operation target, with a name for reports.
    fn target(&self, item: &Value) -> AssistantResult<(Value, String)> {
        let group = truthy(item, "group");
        let workspace_id = truthy(item, "workspace_id");
        let connection_id = truthy(item, "connection_id");
        let path = truthy(item, "path");
        let as_workspace = workspace_id.is_some() || path.is_some();
        if group.is_some() && (as_workspace || connection_id.is_some()) {
            return Err(AssistantError::user(
                "Name either a group or a workspace, not both.",
            ));
        }
        if let Some(group) = group {
            let node = self.find_group(group)?;
            return Ok((json!({ "node": id_of(node) }), self.node_name(node)));
        }
        if !as_workspace {
            return Err(AssistantError::user(
                "Name a workspace (workspace_id or path) or a group.",
            ));
        }
        let connections: Vec<&TreeToolConnection> = self
            .connections
            .iter()
            .filter(|each| connection_id.is_none_or(|id| each.connection_id == id))
            .collect();
        if let Some(connection_id) = connection_id
            && connections.is_empty()
        {
            return Err(AssistantError::user(format!(
                "Unknown connection \"{connection_id}\". Connections: {}.",
                self.connection_list()
            )));
        }
        let matches: Vec<(&TreeToolConnection, &Value)> = connections
            .iter()
            .flat_map(|connection| {
                connection
                    .workspaces
                    .iter()
                    .filter(|workspace| {
                        workspace_id.is_none_or(|id| text(workspace, "workspace_id") == Some(id))
                            && path.is_none_or(|path| {
                                path_of(workspace).as_deref() == Some(path)
                                    || text(workspace, "cwd") == Some(path)
                            })
                    })
                    .map(move |workspace| (*connection, workspace))
            })
            .collect();
        let named = match path {
            Some(path) => format!("the workspace at {path}"),
            None => format!("workspace \"{}\"", workspace_id.unwrap_or("undefined")),
        };
        if matches.len() > 1 {
            let mut on: Vec<&str> = Vec::new();
            for (connection, _) in &matches {
                if !on.contains(&connection.connection_id.as_str()) {
                    on.push(&connection.connection_id);
                }
            }
            return Err(AssistantError::user(format!(
                "{named} matches several workspaces (on {}); add connection_id.",
                on.join(", ")
            )));
        }
        if let Some((connection, workspace)) = matches.first() {
            return Ok((
                json!({ "workspace": workspace_ref_for(&connection.connection_id, workspace) }),
                format!(
                    "\"{}\" ({})",
                    text(workspace, "label").unwrap_or(""),
                    connection.connection_id
                ),
            ));
        }
        // Placed but not open now (its connection down, say): still movable.
        let stored = nodes(&self.tree).iter().find(|node| {
            let reference = ref_of(node);
            is_workspace(node)
                && connection_id.is_none_or(|id| text(reference, "connection_id") == Some(id))
                && match path {
                    Some(path) => text(reference, "path") == Some(path),
                    None => text(reference, "workspace_id") == workspace_id,
                }
        });
        if let Some(stored) = stored {
            return Ok((json!({ "node": id_of(stored) }), self.node_name(stored)));
        }
        Err(AssistantError::user(format!(
            "Unknown workspace: no open workspace matches {named}{}. Read workspace_tree_get for the workspaces and their identifiers.",
            connection_id
                .map(|id| format!(" on {id}"))
                .unwrap_or_default()
        )))
    }

    /// A destination as an operation's parent (null: the usual place).
    fn destination(&self, to: &Value) -> AssistantResult<(Value, String)> {
        let root = field(to, "root");
        let usual = to.get("usual") == Some(&Value::Bool(true));
        let item = truthy(to, "group").is_some()
            || truthy(to, "workspace_id").is_some()
            || truthy(to, "path").is_some();
        let kinds = [root.is_some(), usual, item]
            .into_iter()
            .filter(|kind| *kind)
            .count();
        if kinds != 1 {
            return Err(AssistantError::user(
                "A destination is exactly one of: a group, a workspace, root, or usual.",
            ));
        }
        if let Some(root) = truthy(to, "root") {
            return Ok((json!({ "root": root }), root_name(root).to_owned()));
        }
        if usual {
            return Ok((Value::Null, "its usual place".to_owned()));
        }
        self.target(to)
    }

    fn node_id_of(&self, target: &Value) -> Option<String> {
        if let Some(node) = target.get("node") {
            return node.as_str().map(str::to_owned);
        }
        find_workspace_node(&self.tree, target.get("workspace").unwrap_or(&Value::Null))
            .map(|node| id_of(node).to_owned())
    }

    /// The node to insert before for a position, before or after.
    fn anchor(
        &self,
        parent: &Value,
        placement: &Value,
        moving: &[Value],
        notes: &mut Vec<String>,
    ) -> AssistantResult<Option<Value>> {
        let position = placement.get("position").filter(|value| !value.is_null());
        let before = field(placement, "before");
        let after = field(placement, "after");
        let asked = [position.is_some(), before.is_some(), after.is_some()]
            .into_iter()
            .filter(|asked| *asked)
            .count();
        if asked == 0 {
            return Ok(None);
        }
        if asked > 1 {
            return Err(AssistantError::user(
                "Give at most one of position, before and after.",
            ));
        }
        let root = text(parent, "root");
        if parent.is_null() || root == Some("list") {
            notes.push(if parent.is_null() {
                "Workspaces in their usual place follow Herdr's order; the position was not used."
                    .to_owned()
            } else {
                "Workspaces at the top level in Herdr's list follow Herdr's order; the position was not used."
                    .to_owned()
            });
            return Ok(None);
        }
        let parent_id = if root.is_some() {
            None
        } else {
            Some(
                self.node_id_of(parent)
                    .unwrap_or_else(|| "\u{0}none".to_owned()),
            )
        };
        let moved: Vec<String> = moving
            .iter()
            .filter_map(|each| self.node_id_of(each))
            .collect();
        let siblings: Vec<&Value> = nodes(&self.tree)
            .iter()
            .filter(|node| {
                parent_of(node) == parent_id.as_deref()
                    && !moved.iter().any(|id| id == id_of(node))
                    && (parent_id.is_some() || workspace_tree_root_place(node).as_deref() == root)
            })
            .collect();
        // A workspace is named by its reference, not its node id: a node made
        // earlier in this batch gets another id when the store applies it.
        let target_of = |node: &Value| {
            if is_workspace(node) {
                json!({ "workspace": ref_of(node) })
            } else {
                json!({ "node": id_of(node) })
            }
        };
        if let Some(position) = position {
            let index = position.as_u64().unwrap_or(u64::MAX);
            return Ok(usize::try_from(index)
                .ok()
                .and_then(|index| siblings.get(index))
                .map(|node| target_of(node)));
        }
        let sibling = before.or(after).unwrap_or(&Value::Null);
        let (target, name) = self.target(sibling)?;
        let id = self.node_id_of(&target);
        let Some(index) = siblings
            .iter()
            .position(|node| Some(id_of(node)) == id.as_deref())
        else {
            return Err(AssistantError::user(format!(
                "{name} is not directly in the destination, so nothing can go before or after it there."
            )));
        };
        if before.is_some() {
            return Ok(Some(target_of(siblings[index])));
        }
        Ok(siblings.get(index + 1).map(|node| target_of(node)))
    }

    /// Applies one operation to the working copy, explaining a refusal.
    fn apply(&mut self, op: &Value, what: &str) -> AssistantResult<()> {
        self.tree = apply_workspace_tree_op(&self.tree, op).map_err(|error| {
            AssistantError::user(format!(
                "Refused to {what}: {} Nothing was changed.",
                error.0
            ))
        })?;
        Ok(())
    }

    /// Where a workspace or group sits, in words.
    fn place(&self, target: &Value) -> String {
        let Some(node) = self.node_id_of(target).and_then(|id| self.node(&id)) else {
            return "its usual place".to_owned();
        };
        if let Some(parent) = parent_of(node).filter(|parent| !parent.is_empty()) {
            let siblings: Vec<&Value> = nodes(&self.tree)
                .iter()
                .filter(|each| parent_of(each) == Some(parent))
                .collect();
            let index = siblings
                .iter()
                .position(|each| id_of(each) == id_of(node))
                .map_or(-1, |index| index as i64);
            return format!(
                "under {} (position {index} of {})",
                self.node(parent).map_or_else(
                    || "a removed item".to_owned(),
                    |parent| self.node_name(parent)
                ),
                siblings.len()
            );
        }
        match workspace_tree_root_place(node) {
            Some(root) => root_name(&root).to_owned(),
            None => "its usual place".to_owned(),
        }
    }
}

/// The index of a node among `list` (`indexOf`), -1 when absent.
fn index_in(list: &[&Value], node: &Value) -> i64 {
    list.iter()
        .position(|each| id_of(each) == id_of(node))
        .map_or(-1, |index| index as i64)
}

/// The arranged view Ranger reads: workspaces, groups and an outline.
fn describe(view: &TreeView) -> Value {
    let tree = &view.tree;
    let connections = view.connections;
    let resolved = resolve_workspace_tree(tree, &live_map(connections));
    let by_id = |id: &str| nodes(tree).iter().find(|node| id_of(node) == id);
    let parent_of_node = |node: &Value| -> Option<Value> {
        let parent = parent_of(node)
            .filter(|parent| !parent.is_empty())
            .and_then(by_id)?;
        if is_group(parent) {
            return Some(json!({ "group": id_of(parent), "label": label_of(parent) }));
        }
        let reference = ref_of(parent);
        let live = view.live_of(parent);
        let mut out = Map::new();
        out.insert(
            "connection_id".into(),
            reference
                .get("connection_id")
                .cloned()
                .unwrap_or(Value::Null),
        );
        let workspace_id = live
            .and_then(|(_, workspace)| field(workspace, "workspace_id"))
            .or_else(|| field(reference, "workspace_id"));
        if let Some(workspace_id) = workspace_id {
            out.insert("workspace_id".into(), workspace_id.clone());
        }
        let label = live
            .and_then(|(_, workspace)| field(workspace, "label"))
            .or_else(|| field(reference, "label"))
            .or_else(|| field(reference, "path"));
        if let Some(label) = label {
            out.insert("label".into(), label.clone());
        }
        Some(Value::Object(out))
    };
    let placement_of = |node: Option<&Value>| -> Map<String, Value> {
        let mut out = Map::new();
        let Some(node) = node else {
            out.insert("placement".into(), json!("usual"));
            return out;
        };
        if let Some(parent) = parent_of_node(node) {
            let siblings: Vec<&Value> = nodes(tree)
                .iter()
                .filter(|each| parent_of(each) == parent_of(node))
                .collect();
            out.insert("placement".into(), json!("under"));
            out.insert("parent".into(), parent);
            out.insert("position".into(), json!(index_in(&siblings, node)));
            return out;
        }
        let root = workspace_tree_root_place(node);
        match root.as_deref() {
            None | Some("list") => {
                out.insert(
                    "placement".into(),
                    json!(root.as_deref().unwrap_or("usual")),
                );
            }
            Some(root) => {
                let siblings: Vec<&Value> = nodes(tree)
                    .iter()
                    .filter(|each| {
                        parent_of(each).is_none()
                            && workspace_tree_root_place(each).as_deref() == Some(root)
                    })
                    .collect();
                out.insert("placement".into(), json!(root));
                out.insert("position".into(), json!(index_in(&siblings, node)));
            }
        }
        out
    };

    let mut workspaces = Vec::new();
    for connection in connections {
        for workspace in &connection.workspaces {
            let key = live_workspace_key(
                &connection.connection_id,
                text(workspace, "workspace_id").unwrap_or("undefined"),
            );
            let node = resolved
                .node_by_workspace
                .iter()
                .find(|(each, _)| *each == key)
                .and_then(|(_, id)| by_id(id));
            let repo = repo_parent(&connection.workspaces, workspace);
            let mut out = Map::new();
            out.insert("connection_id".into(), json!(connection.connection_id));
            out.insert(
                "workspace_id".into(),
                workspace
                    .get("workspace_id")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            out.insert(
                "label".into(),
                workspace.get("label").cloned().unwrap_or(Value::Null),
            );
            if let Some(path) = path_of(workspace).filter(|path| !path.is_empty()) {
                out.insert("path".into(), json!(path));
            }
            let worktree = field(workspace, "worktree");
            if let Some(branch) = worktree
                .and_then(|worktree| field(worktree, "git_status"))
                .and_then(|status| truthy(status, "branch"))
            {
                out.insert("branch".into(), json!(branch));
            }
            if let Some(repository) = worktree.and_then(|worktree| truthy(worktree, "repo_name")) {
                out.insert("repository".into(), json!(repository));
            }
            if let Some(repo) = repo {
                out.insert(
                    "usually_under".into(),
                    json!({
                        "workspace_id": repo.get("workspace_id").cloned().unwrap_or(Value::Null),
                        "label": repo.get("label").cloned().unwrap_or(Value::Null),
                    }),
                );
            }
            out.extend(placement_of(node));
            if let Some(number) = workspace.get("number") {
                out.insert("herdr_number".into(), number.clone());
            }
            workspaces.push(Value::Object(out));
        }
    }
    let groups: Vec<Value> = nodes(tree)
        .iter()
        .filter(|node| is_group(node))
        .map(|node| {
            let mut out = Map::new();
            out.insert("group".into(), json!(id_of(node)));
            out.insert("label".into(), json!(label_of(node)));
            out.extend(placement_of(Some(node)));
            out.insert(
                "children".into(),
                json!(
                    nodes(tree)
                        .iter()
                        .filter(|each| parent_of(each) == Some(id_of(node)))
                        .count()
                ),
            );
            if collapsed(node) {
                out.insert("collapsed".into(), json!(true));
            }
            Value::Object(out)
        })
        .collect();
    let unavailable: Vec<Value> = nodes(tree)
        .iter()
        .filter(|node| is_workspace(node))
        .filter_map(|node| {
            let state = state_of(&resolved, id_of(node))?;
            if matches!(state, Resolved::Live { .. }) {
                return None;
            }
            let reference = ref_of(node);
            let mut out = Map::new();
            out.insert(
                "connection_id".into(),
                reference
                    .get("connection_id")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            if let Some(label) = field(reference, "label").or_else(|| field(reference, "path")) {
                out.insert("label".into(), label.clone());
            }
            if let Some(path) = truthy(reference, "path") {
                out.insert("path".into(), json!(path));
            }
            out.insert(
                "state".into(),
                json!(if *state == Resolved::Offline {
                    "connection not ready"
                } else {
                    "not open"
                }),
            );
            out.extend(placement_of(Some(node)));
            Some(Value::Object(out))
        })
        .collect();

    // The outline: what the user arranged, in sidebar order.
    let mut lines: Vec<String> = Vec::new();
    fn line(view: &TreeView, node: &Value, depth: usize, lines: &mut Vec<String>) {
        let indent = "  ".repeat(depth);
        if is_group(node) {
            lines.push(format!(
                "{indent}[group {}] {}{}",
                id_of(node),
                label_of(node),
                if collapsed(node) { " (collapsed)" } else { "" }
            ));
        } else {
            let reference = ref_of(node);
            let live = view.live_of(node);
            let label = live
                .and_then(|(_, workspace)| text(workspace, "label"))
                .or_else(|| text(reference, "label"))
                .or_else(|| text(reference, "path"))
                .unwrap_or("?");
            let connection_id = text(reference, "connection_id").unwrap_or("undefined");
            let id = match live {
                Some((_, workspace)) => format!(
                    "{connection_id}/{}",
                    text(workspace, "workspace_id").unwrap_or("")
                ),
                None => format!("{connection_id}, not open"),
            };
            lines.push(format!("{indent}{label} ({id})"));
        }
        for child in nodes(&view.tree)
            .iter()
            .filter(|each| parent_of(each) == Some(id_of(node)))
        {
            line(view, child, depth + 1, lines);
        }
    }
    let roots: Vec<&Value> = nodes(tree)
        .iter()
        .filter(|node| parent_of(node).is_none())
        .collect();
    let mut section = |title: &str, keep: &dyn Fn(Option<&str>) -> bool| {
        let list: Vec<&&Value> = roots
            .iter()
            .filter(|node| keep(workspace_tree_root_place(node).as_deref()))
            .collect();
        if list.is_empty() {
            return;
        }
        lines.push(title.to_owned());
        for node in list {
            line(view, node, 1, &mut lines);
        }
    };
    section("Above the list:", &|root| root == Some("top"));
    section(
        "In Herdr's list (its order), holding what is arranged under them:",
        &|root| root.is_none() || root == Some("list"),
    );
    section("Below the list:", &|root| root == Some("bottom"));

    let mut out = Map::new();
    out.insert(
        "connections".into(),
        Value::Array(
            connections
                .iter()
                .map(|connection| {
                    json!({
                        "connection_id": connection.connection_id,
                        "label": connection.label,
                        "state": connection.state.as_str(),
                    })
                })
                .collect(),
        ),
    );
    out.insert("workspaces".into(), Value::Array(workspaces));
    out.insert("groups".into(), Value::Array(groups));
    if !unavailable.is_empty() {
        out.insert("placed_but_unavailable".into(), Value::Array(unavailable));
    }
    out.insert(
        "outline".into(),
        json!(if lines.is_empty() {
            "Nothing is arranged: every workspace is in its usual place.".to_owned()
        } else {
            lines.join("\n")
        }),
    );
    out.insert(
        "note".into(),
        json!("A workspace with placement usual shows in Herdr's order, a worktree under its repository's main checkout (usually_under)."),
    );
    Value::Object(out)
}

// ------------------------------------------------------------ the handler

/// What one move or group call builds up.
#[derive(Default)]
struct Batch {
    ops: Vec<Value>,
    changes: Vec<String>,
    notes: Vec<String>,
    created: Vec<Value>,
    moved: Vec<(Value, String)>,
}

impl Batch {
    fn move_items(
        &mut self,
        view: &mut TreeView,
        items: &[Value],
        parent: &Value,
        destination: &str,
        placement: &Value,
    ) -> AssistantResult<()> {
        let subjects = items
            .iter()
            .map(|item| view.target(item))
            .collect::<AssistantResult<Vec<_>>>()?;
        let moving: Vec<Value> = subjects.iter().map(|(target, _)| target.clone()).collect();
        let anchor = view.anchor(parent, placement, &moving, &mut self.notes)?;
        for (target, name) in subjects {
            let mut op = Map::new();
            op.insert("op".into(), json!("move"));
            op.insert("subject".into(), target.clone());
            op.insert("parent".into(), parent.clone());
            if let Some(anchor) = &anchor {
                op.insert("before".into(), anchor.clone());
            }
            let op = Value::Object(op);
            view.apply(&op, &format!("move {name} to {destination}"))?;
            self.ops.push(op);
            self.moved.push((target, name));
        }
        Ok(())
    }

    fn group_action(&mut self, view: &mut TreeView, action: &Value) -> AssistantResult<()> {
        let kind = text(action, "action").unwrap_or("");
        let label = text(action, "label");
        let blank_label = label.is_none_or(|label| js::trim(label).is_empty());
        if kind == "create" {
            if blank_label {
                return Err(AssistantError::user("create needs a label."));
            }
            let label = label.unwrap_or("");
            if truthy(action, "group").is_some() {
                return Err(AssistantError::user(
                    "create takes a label, not a group; the id is made for you.",
                ));
            }
            let parent = field(action, "parent");
            if parent.is_some_and(|parent| parent.get("usual") == Some(&Value::Bool(true))) {
                return Err(AssistantError::user(
                    "A group has no usual place: put it in a group, under a workspace, or at root top or bottom.",
                ));
            }
            let (parent, _) = match parent {
                Some(parent) => view.destination(parent)?,
                None => (Value::Null, root_name("top").to_owned()),
            };
            let anchor = view.anchor(&parent, action, &[], &mut self.notes)?;
            let id = new_workspace_tree_group_id();
            let mut op = Map::new();
            op.insert("op".into(), json!("create_group"));
            op.insert("id".into(), json!(id));
            op.insert("label".into(), json!(label));
            op.insert("parent".into(), parent);
            if let Some(anchor) = anchor {
                op.insert("before".into(), anchor);
            }
            let op = Value::Object(op);
            view.apply(&op, &format!("create group \"{label}\""))?;
            self.ops.push(op);
            let label = view
                .node(&id)
                .filter(|node| is_group(node))
                .map_or(label, label_of)
                .to_owned();
            self.created.push(json!({ "group": id, "label": label }));
            self.changes.push(format!(
                "Created group \"{label}\" ({id}) {}.",
                at(&view.place(&json!({ "node": id })))
            ));
            if let Some(children) = field(action, "children").and_then(Value::as_array) {
                self.move_items(
                    view,
                    children,
                    &json!({ "node": id }),
                    &format!("group \"{label}\""),
                    &json!({}),
                )?;
            }
            return Ok(());
        }
        let Some(group) = truthy(action, "group") else {
            return Err(AssistantError::user(format!("{kind} needs a group.")));
        };
        if field(action, "children").is_some() || field(action, "parent").is_some() {
            return Err(AssistantError::user(format!(
                "{kind} takes only a group{}; use workspace_tree_move to move things.",
                if kind == "rename" { " and a label" } else { "" }
            )));
        }
        let node = view.find_group(group)?.clone();
        let id = id_of(&node).to_owned();
        let name = view.node_name(&node);
        match kind {
            "rename" => {
                if blank_label {
                    return Err(AssistantError::user("rename needs a label."));
                }
                let label = label.unwrap_or("");
                let op = json!({ "op": "rename_group", "node": id, "label": label });
                view.apply(&op, &format!("rename {name}"))?;
                self.ops.push(op);
                let renamed = view
                    .node(&id)
                    .filter(|node| is_group(node))
                    .map_or(label, label_of);
                self.changes
                    .push(format!("Renamed {name} to \"{renamed}\"."));
            }
            "delete" => {
                let children = nodes(&view.tree)
                    .iter()
                    .filter(|each| parent_of(each) == Some(id.as_str()))
                    .count();
                let parent = parent_of(&node)
                    .filter(|parent| !parent.is_empty())
                    .and_then(|parent| view.node(parent))
                    .cloned();
                let op = json!({ "op": "delete_group", "node": id });
                view.apply(&op, &format!("delete {name}"))?;
                self.ops.push(op);
                self.changes.push(if children > 0 {
                    format!(
                        "Deleted {name}; its {children} item{} moved up a level, {}.",
                        if children == 1 { "" } else { "s" },
                        match &parent {
                            Some(parent) => format!("under {}", view.node_name(parent)),
                            None => "to the top level (workspaces back to their usual place, groups above the list)".to_owned(),
                        }
                    )
                } else {
                    format!("Deleted {name}, which was empty.")
                });
            }
            _ => {
                let collapsed = kind == "collapse";
                let op = json!({ "op": "set_collapsed", "node": id, "collapsed": collapsed });
                view.apply(&op, &format!("{kind} {name}"))?;
                self.ops.push(op);
                self.changes.push(format!(
                    "{} {name}.",
                    if collapsed { "Collapsed" } else { "Expanded" }
                ));
            }
        }
        Ok(())
    }
}

async fn handle(
    backend: Arc<dyn WorkspaceTreeToolBackend>,
    kind: &'static str,
    params: Value,
    signal: Option<CancellationToken>,
) -> AssistantResult<ToolResult> {
    let (connections, tree) = tokio::join!(backend.connections(signal.clone()), backend.read());
    let connections = connections.map_err(masked)?;
    let tree = tree.map_err(masked)?;
    aborted(&signal)?;
    let mut view = TreeView::new(&connections, tree.clone());
    if kind == "get" {
        return Ok(ToolResult::text(js::stringify(&describe(&view))));
    }

    let mut batch = Batch::default();
    let before = TreeView::new(&connections, tree.clone());
    let empty = Vec::new();
    if kind == "move" {
        for entry in params["moves"].as_array().unwrap_or(&empty) {
            let (parent, name) = view.destination(&entry["to"])?;
            let items = entry["items"].as_array().unwrap_or(&empty);
            batch.move_items(&mut view, items, &parent, &name, entry)?;
        }
    } else {
        for action in params["actions"].as_array().unwrap_or(&empty) {
            batch.group_action(&mut view, action)?;
        }
    }

    aborted(&signal)?;
    let Batch {
        ops,
        mut changes,
        notes,
        created,
        moved,
    } = batch;
    let after = backend.apply(ops).await.map_err(|error| match error {
        TreeBackendError::Refused(message) => AssistantError::user(format!(
            "The arrangement changed meanwhile and refused this: {message} Nothing was changed; read workspace_tree_get again."
        )),
        TreeBackendError::Failed(message) => AssistantError::internal(message),
    })?;
    let result = TreeView::new(&connections, after.clone());
    // Each moved item once, where it ended up.
    let mut last: Vec<(String, Value, String)> = Vec::new();
    for (target, name) in moved {
        let key = js::stringify(&target);
        match last.iter_mut().find(|(each, ..)| *each == key) {
            Some(entry) => *entry = (key, target, name),
            None => last.push((key, target, name)),
        }
    }
    for (_, target, name) in &last {
        let from = before.place(target);
        let to = result.place(target);
        changes.push(if from == to {
            format!("{name} stays {}.", at(&to))
        } else {
            format!("Moved {name} from {from} to {to}.")
        });
    }
    let changed = js::stringify(&after) != js::stringify(&tree);
    let mut out = Map::new();
    out.insert("changed".into(), json!(changed));
    out.insert("changes".into(), json!(changes));
    if !created.is_empty() {
        out.insert("groups_created".into(), Value::Array(created));
    }
    if !notes.is_empty() {
        let mut unique: Vec<String> = Vec::new();
        for note in notes {
            if !unique.contains(&note) {
                unique.push(note);
            }
        }
        out.insert("notes".into(), json!(unique));
    }
    Ok(ToolResult::text(js::stringify(&Value::Object(out))))
}

/// `createWorkspaceTreeToolHandler`: the tree tools over a backend, the
/// [`Handler`] of [`RangerHandlers::arrange`](crate::tools::RangerHandlers).
pub fn create_workspace_tree_tool_handler(backend: Arc<dyn WorkspaceTreeToolBackend>) -> Handler {
    Arc::new(move |kind, params, signal| Box::pin(handle(backend.clone(), kind, params, signal)))
}

// ------------------------------------------------------ the live connections

/// A ready connection's runtime, as `readWorkspaceTreeConnections` uses it.
pub trait TreeConnectionRuntime: Send + Sync {
    /// `herdr.call(method, params, timeout)`.
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> BoxFuture<AssistantResult<Value>>;
    /// `worktreeParents.enrichWorkspaceList(listed)`: the repository
    /// parents the sidebar shows; None when the runtime has none.
    fn enrich_worktree_parents(&self, listed: &Value) -> Option<BoxFuture<AssistantResult<Value>>>;
    /// `status.enrichWorkspacesWithGitStatus(listed)`: the branches; None
    /// when the runtime has no status.
    fn enrich_git_status(&self, listed: &Value) -> Option<BoxFuture<AssistantResult<Value>>>;
    /// `remotePlatform`: "windows" for a Windows host.
    fn remote_platform(&self) -> Option<String>;
}

/// The connection manager, as `readWorkspaceTreeConnections` uses it.
pub trait TreeConnectionManager: Send + Sync {
    /// `list()`: each connection's id and label, in order.
    fn list(&self) -> Vec<(String, String)>;
    /// `readyRuntimeLease(id)`: the runtime of a ready connection.
    fn ready_runtime(&self, id: &str) -> Option<Arc<dyn TreeConnectionRuntime>>;
}

/// `readWorkspaceTreeConnections`: each connection's workspaces, with the
/// repository parents and branches the sidebar shows. A connection that
/// is not ready, or does not answer, lists none.
pub async fn read_workspace_tree_connections(
    manager: &dyn TreeConnectionManager,
) -> Vec<TreeToolConnection> {
    let reads = manager.list().into_iter().map(|(id, label)| {
        let runtime = manager.ready_runtime(&id);
        async move {
            let state = match runtime {
                None => Err(TreeConnectionState::Offline),
                Some(runtime) => read_workspaces(runtime.as_ref())
                    .await
                    .map_err(|_| TreeConnectionState::Error),
            };
            let (state, workspaces) = match state {
                Ok(workspaces) => (TreeConnectionState::Ready, workspaces),
                Err(state) => (state, Vec::new()),
            };
            TreeToolConnection {
                connection_id: id,
                label,
                state,
                workspaces,
            }
        }
    });
    futures_util::future::join_all(reads).await
}

async fn read_workspaces(runtime: &dyn TreeConnectionRuntime) -> AssistantResult<Vec<Value>> {
    let mut listed = runtime
        .herdr_call("workspace.list", json!({}), Duration::from_millis(5000))
        .await?;
    if !listed.get("workspaces").is_some_and(Value::is_array) {
        return Err(AssistantError::internal("no list"));
    }
    if let Some(enriched) = runtime.enrich_worktree_parents(&listed) {
        listed = enriched.await?;
    }
    if runtime.remote_platform().as_deref() != Some("windows")
        && let Some(enriched) = runtime.enrich_git_status(&listed)
        && let Ok(enriched) = enriched.await
    {
        listed = enriched;
    }
    let Some(workspaces) = listed.get("workspaces").and_then(Value::as_array) else {
        return Err(AssistantError::internal("no list"));
    };
    Ok(workspaces
        .iter()
        .filter(|each| {
            each.get("workspace_id").is_some_and(Value::is_string)
                && each.get("label").is_some_and(Value::is_string)
        })
        .cloned()
        .collect())
}

#[cfg(test)]
mod tests;
