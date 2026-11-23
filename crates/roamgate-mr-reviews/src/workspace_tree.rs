//! The parts of the Workspaces tree (`shared/workspaceTree.ts`) the MR
//! reviews read: a tree as Bun holds it (`{version, nodes}`, each node a
//! JavaScript object), its children and ancestors, where a group path
//! leads, and which live workspace each of its workspace nodes is.

use std::collections::{HashMap, HashSet};

use rand::Rng;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

/// `WORKSPACE_TREE_LABEL_MAX`.
pub const LABEL_MAX: usize = 120;

/// The tree's nodes, in sibling order (none when it has none).
pub fn nodes(tree: &Value) -> Vec<&Obj> {
    tree.get("nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect()
}

pub fn node_id(node: &Obj) -> &str {
    js::sv(node.get("id"))
}

pub fn node_parent(node: &Obj) -> Option<&str> {
    node.get("parent").and_then(Value::as_str)
}

pub fn is_group(node: &Obj) -> bool {
    node.get("kind").and_then(Value::as_str) == Some("group")
}

pub fn is_workspace(node: &Obj) -> bool {
    node.get("kind").and_then(Value::as_str) == Some("workspace")
}

/// A workspace node's reference (an empty one for a group).
pub fn node_ref(node: &Obj) -> &Obj {
    static EMPTY: std::sync::LazyLock<Obj> = std::sync::LazyLock::new(Obj::new);
    node.get("ref").and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// `workspaceTreeChildren`: the nodes under `parent` (None: the top level).
pub fn children<'a>(tree: &'a Value, parent: Option<&str>) -> Vec<&'a Obj> {
    nodes(tree)
        .into_iter()
        .filter(|node| node_parent(node) == parent)
        .collect()
}

/// `workspaceTreeAncestors`: a node and the nodes above it, nearest first.
pub fn ancestors(tree: &Value, id: Option<&str>) -> Vec<String> {
    let all = nodes(tree);
    let by_id: HashMap<&str, &Obj> = all.iter().map(|node| (node_id(node), *node)).collect();
    let mut out: Vec<String> = Vec::new();
    let mut cursor = id.filter(|id| !id.is_empty());
    while let Some(at) = cursor {
        let Some(node) = by_id.get(at) else { break };
        if out.iter().any(|seen| seen == at) {
            break;
        }
        out.push(at.to_owned());
        cursor = node_parent(node).filter(|id| !id.is_empty());
    }
    out
}

/// `workspaceTreeNodeName`: a group's label, a workspace's label (else its
/// checkout's last directory), trimmed.
pub fn node_name(node: &Obj) -> String {
    let name = if is_group(node) {
        js::sv(node.get("label")).to_owned()
    } else {
        let reference = node_ref(node);
        match reference.get("label").and_then(Value::as_str) {
            Some(label) => label.to_owned(),
            None => reference
                .get("path")
                .and_then(Value::as_str)
                .map(|path| path.rsplit('/').next().unwrap_or("").to_owned())
                .unwrap_or_default(),
        }
    };
    js::trim(&name).to_owned()
}

fn same_tree_name(a: &str, b: &str) -> bool {
    js::js_lower(js::trim(a)) == js::js_lower(js::trim(b))
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `newWorkspaceTreeGroupId`: `g`, the time in base 36, 8 random base-36
/// digits.
pub fn new_group_id() -> String {
    let mut rng = rand::rng();
    let random: String = (0..8)
        .map(|_| {
            let digit = rng.random_range(0..36u64);
            base36(digit)
        })
        .collect();
    format!("g{}{random}", base36(js::now_ms() as u64))
}

/// Options of [`resolve_path`] (`resolveWorkspaceTreePath`).
pub struct PathOptions<'a> {
    /// Where to start from, in turn (None: the top level); none given: the
    /// top level.
    pub bases: Vec<Option<String>>,
    pub create: bool,
    pub prefer_connection: Option<&'a str>,
    pub new_id: &'a mut dyn FnMut() -> String,
}

/// Where a group path leads.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedPath {
    /// The node the path names, existing or made by `ops`.
    pub node: String,
    /// The create_group operations that make the missing groups, in order.
    pub ops: Vec<Value>,
    /// The names that matched existing nodes, as they are spelled there.
    pub found: Vec<String>,
}

/// `resolveWorkspaceTreePath`: the node a group path's names reach,
/// matched case-insensitively level by level from each base in turn, the
/// first base that reaches the whole path winning. A level with several
/// matches tries a workspace on `prefer_connection` first, then groups,
/// then other workspaces. With `create`, a path no base reaches is
/// completed with new groups under the deepest node any base reaches (the
/// earlier base on a tie); without it the answer is None.
pub fn resolve_path(
    tree: &Value,
    path: &[String],
    options: PathOptions<'_>,
) -> Option<ResolvedPath> {
    let names: Vec<&str> = path
        .iter()
        .map(|name| js::trim(name))
        .filter(|name| !name.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    let prefer = options.prefer_connection;
    let rank = |node: &Obj| -> u8 {
        if is_workspace(node)
            && prefer.is_some()
            && node_ref(node).get("connection_id").and_then(Value::as_str) == prefer
        {
            0
        } else if is_group(node) {
            1
        } else {
            2
        }
    };
    fn deepest<'a>(
        tree: &'a Value,
        names: &[&str],
        rank: &dyn Fn(&Obj) -> u8,
        parent: Option<&str>,
        from: usize,
    ) -> Vec<&'a Obj> {
        if from >= names.len() {
            return Vec::new();
        }
        let mut matches: Vec<&Obj> = children(tree, parent)
            .into_iter()
            .filter(|node| same_tree_name(&node_name(node), names[from]))
            .collect();
        matches.sort_by_key(|node| rank(node));
        let mut best: Vec<&Obj> = Vec::new();
        for found in matches {
            let mut walk = vec![found];
            walk.extend(deepest(tree, names, rank, Some(node_id(found)), from + 1));
            if walk.len() > best.len() {
                best = walk;
            }
            if from + best.len() == names.len() {
                break;
            }
        }
        best
    }
    let bases = if options.bases.is_empty() {
        vec![None]
    } else {
        options.bases.clone()
    };
    let all = nodes(tree);
    let mut chosen: Option<(Option<String>, Vec<&Obj>)> = None;
    let mut seen: HashSet<Option<String>> = HashSet::new();
    for base in bases {
        if !seen.insert(base.clone()) {
            continue;
        }
        if let Some(id) = &base
            && !all.iter().any(|node| node_id(node) == id)
        {
            continue;
        }
        let walk = deepest(tree, &names, &rank, base.as_deref(), 0);
        if walk.len() == names.len() {
            return Some(ResolvedPath {
                node: node_id(walk[walk.len() - 1]).to_owned(),
                ops: Vec::new(),
                found: walk.iter().map(|node| node_name(node)).collect(),
            });
        }
        if chosen
            .as_ref()
            .is_none_or(|(_, best)| walk.len() > best.len())
        {
            chosen = Some((base, walk));
        }
    }
    if !options.create {
        return None;
    }
    let (base, walk) = chosen?;
    let mut ops = Vec::new();
    let mut parent: Option<String> = match walk.last() {
        Some(node) => Some(node_id(node).to_owned()),
        None => base,
    };
    for name in &names[walk.len()..] {
        let id = (options.new_id)();
        let at = match &parent {
            None => json!({"root": "top"}),
            Some(node) => json!({"node": node}),
        };
        ops.push(json!({
            "op": "create_group",
            "id": id,
            "label": js::head16(name, LABEL_MAX),
            "parent": at,
        }));
        parent = Some(id);
    }
    Some(ResolvedPath {
        node: parent.unwrap_or_default(),
        ops,
        found: walk.iter().map(|node| node_name(node)).collect(),
    })
}

/// `LiveWorkspaceIdentity`: what a live workspace offers to be
/// recognised by.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveWorkspace {
    pub workspace_id: String,
    pub label: String,
    pub path: Option<String>,
}

/// `workspaceIdentity` of a workspace as Herdr lists it: its worktree's
/// checkout, else its folder.
pub fn workspace_identity(workspace: &Value) -> LiveWorkspace {
    let checkout = workspace
        .get("worktree")
        .and_then(|worktree| worktree.get("checkout_path"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty());
    let cwd = workspace
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty());
    LiveWorkspace {
        workspace_id: js::sv(workspace.get("workspace_id")).to_owned(),
        label: js::sv(workspace.get("label")).to_owned(),
        path: checkout.or(cwd).map(str::to_owned),
    }
}

/// Each ready connection's live workspaces, in the order they were read.
pub type Live = Vec<(String, Vec<LiveWorkspace>)>;

/// `liveWorkspaceKey`.
pub fn live_workspace_key(connection_id: &str, workspace_id: &str) -> String {
    format!("{connection_id}\u{0}{workspace_id}")
}

/// What a workspace node is now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolvedNode {
    Live {
        connection_id: String,
        workspace_id: String,
    },
    /// Its connection is not ready.
    Offline,
    /// Its connection answers but no workspace matches.
    Gone,
}

/// `ResolvedWorkspaceTree`.
#[derive(Clone, Debug, Default)]
pub struct ResolvedTree {
    pub nodes: HashMap<String, ResolvedNode>,
    /// `connection\0workspace` to its node.
    pub node_by_workspace: HashMap<String, String>,
    /// Live ids or labels that differ from what the tree has: `{node, ref}`.
    pub refreshes: Vec<Value>,
}

/// `resolveWorkspaceTree`: matches the tree's workspaces with the live
/// ones. A connection missing from `live` is offline. A path decides
/// first, then the label, then the last id seen.
pub fn resolve_tree(tree: &Value, live: &Live) -> ResolvedTree {
    let mut out = ResolvedTree::default();
    let mut by_connection: Vec<(&str, Vec<&Obj>)> = Vec::new();
    for node in nodes(tree) {
        if !is_workspace(node) {
            continue;
        }
        let connection = js::sv(node_ref(node).get("connection_id"));
        match by_connection.iter_mut().find(|(id, _)| *id == connection) {
            Some((_, list)) => list.push(node),
            None => by_connection.push((connection, vec![node])),
        }
    }
    let field = |node: &Obj, key: &str| -> Option<String> {
        node_ref(node)
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    for (connection_id, refs) in by_connection {
        let Some((_, workspaces)) = live.iter().find(|(id, _)| id == connection_id) else {
            for node in refs {
                out.nodes
                    .insert(node_id(node).to_owned(), ResolvedNode::Offline);
            }
            continue;
        };
        let mut claimed: HashSet<String> = HashSet::new();
        let matched = |out: &mut ResolvedTree,
                       claimed: &mut HashSet<String>,
                       node: &Obj,
                       workspace: &LiveWorkspace| {
            claimed.insert(workspace.workspace_id.clone());
            out.nodes.insert(
                node_id(node).to_owned(),
                ResolvedNode::Live {
                    connection_id: connection_id.to_owned(),
                    workspace_id: workspace.workspace_id.clone(),
                },
            );
            out.node_by_workspace.insert(
                live_workspace_key(connection_id, &workspace.workspace_id),
                node_id(node).to_owned(),
            );
            let label = field(node, "label");
            let id = field(node, "workspace_id");
            let path = field(node, "path");
            if label.as_deref() != Some(workspace.label.as_str())
                || id.as_deref() != Some(workspace.workspace_id.as_str())
                || workspace
                    .path
                    .as_ref()
                    .is_some_and(|p| path.as_deref() != Some(p.as_str()))
            {
                let mut reference = Obj::new();
                reference.insert("connection_id".into(), json!(connection_id));
                if let Some(p) = &workspace.path {
                    reference.insert("path".into(), json!(p));
                }
                if !workspace.label.is_empty() {
                    reference.insert("label".into(), json!(workspace.label));
                }
                reference.insert("workspace_id".into(), json!(workspace.workspace_id));
                out.refreshes
                    .push(json!({"node": node_id(node), "ref": reference}));
            }
        };
        let pick = |node: &Obj, candidates: Vec<&LiveWorkspace>| -> Option<LiveWorkspace> {
            let label = field(node, "label");
            let id = field(node, "workspace_id");
            let same_label = |each: &&LiveWorkspace| label.as_deref() == Some(each.label.as_str());
            let same_id = |each: &&LiveWorkspace| id.as_deref() == Some(each.workspace_id.as_str());
            candidates
                .iter()
                .find(|each| same_label(each) && same_id(each))
                .or_else(|| candidates.iter().find(|each| same_label(each)))
                .or_else(|| candidates.iter().find(|each| same_id(each)))
                .or_else(|| candidates.first())
                .map(|each| (*each).clone())
        };
        // A path first: the strongest identity.
        for node in &refs {
            let Some(path) = field(node, "path").filter(|p| !p.is_empty()) else {
                continue;
            };
            let free: Vec<&LiveWorkspace> = workspaces
                .iter()
                .filter(|each| !claimed.contains(&each.workspace_id))
                .filter(|each| each.path.as_deref() == Some(path.as_str()))
                .collect();
            if let Some(found) = pick(node, free) {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        // Then a label, for workspaces without a checkout.
        for node in &refs {
            let label = field(node, "label").unwrap_or_default();
            if field(node, "path").is_some_and(|p| !p.is_empty())
                || out.nodes.contains_key(node_id(node))
                || label.is_empty()
            {
                continue;
            }
            let free: Vec<&LiveWorkspace> = workspaces
                .iter()
                .filter(|each| !claimed.contains(&each.workspace_id))
                .filter(|each| each.path.is_none() && each.label == label)
                .collect();
            if let Some(found) = pick(node, free) {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        // Then the id last seen: a pathless workspace the user renamed.
        for node in &refs {
            let id = field(node, "workspace_id").unwrap_or_default();
            if field(node, "path").is_some_and(|p| !p.is_empty())
                || out.nodes.contains_key(node_id(node))
                || id.is_empty()
            {
                continue;
            }
            let found = workspaces
                .iter()
                .filter(|each| !claimed.contains(&each.workspace_id))
                .find(|each| each.path.is_none() && each.workspace_id == id)
                .cloned();
            if let Some(found) = found {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        for node in &refs {
            if !out.nodes.contains_key(node_id(node)) {
                out.nodes
                    .insert(node_id(node).to_owned(), ResolvedNode::Gone);
            }
        }
    }
    out
}
