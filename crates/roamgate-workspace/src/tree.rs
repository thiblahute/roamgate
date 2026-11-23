//! The user's arrangement of the Workspaces list (shared/workspaceTree.ts),
//! held to `contract/vectors/workspace-tree.json`: which workspace or label
//! group sits under which, across Herdr connections, kept in settings.json
//! `workspace_tree` (its parser is roamgate-base's
//! [`parse_workspace_tree`]) and shared by every browser.
//!
//! Trees, nodes, references and operations are the JSON the TS builds,
//! key for key in the same order, since they are what settings.json and
//! the browsers get. [`store`] is config/workspace-tree.ts: the stored
//! arrangement, automatic placement, an agent's `--group`, and the pruning
//! of workspaces that are gone.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

use regex::Regex;
pub use roamgate_base::settings::sections::{
    WORKSPACE_TREE_LABEL_MAX, WORKSPACE_TREE_MAX_NODES, parse_workspace_ref, parse_workspace_tree,
    workspace_ref_key,
};
use serde_json::{Map, Value, json};

pub mod store;

pub const WORKSPACE_TREE_VERSION: u64 = 1;
const ROOT_PLACES: [&str; 3] = ["top", "list", "bottom"];

/// `WorkspaceTreeError`: an operation that cannot apply, said to the user.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TreeError(pub String);

fn error(message: &str) -> TreeError {
    TreeError(message.to_owned())
}

pub type TreeResult<T> = Result<T, TreeError>;

fn node_id_ok(text: &str) -> bool {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
    ID.is_match(text)
}

fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

/// `normalizeGroupLabel`.
fn normalize_group_label(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let mut label = String::with_capacity(text.len());
    let mut in_control = false;
    for c in text.chars() {
        if (c as u32) < 0x20 || c == '\u{7f}' {
            if !in_control {
                label.push(' ');
            }
            in_control = true;
        } else {
            label.push(c);
            in_control = false;
        }
    }
    slice_utf16(
        roamgate_base::settings::js_trim(&label),
        WORKSPACE_TREE_LABEL_MAX,
    )
}

fn nodes(tree: &Value) -> &[Value] {
    tree.get("nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn with_nodes(tree: &Value, nodes: Vec<Value>) -> Value {
    let mut out = tree.as_object().cloned().unwrap_or_default();
    out.insert("nodes".into(), Value::Array(nodes));
    Value::Object(out)
}

fn id_of(node: &Value) -> &str {
    node.get("id").and_then(Value::as_str).unwrap_or("")
}

fn parent_of(node: &Value) -> Option<&str> {
    node.get("parent").and_then(Value::as_str)
}

fn kind_of(node: &Value) -> &str {
    node.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn is_group(node: &Value) -> bool {
    kind_of(node) == "group"
}

fn is_workspace(node: &Value) -> bool {
    kind_of(node) == "workspace"
}

fn ref_of(node: &Value) -> &Value {
    node.get("ref").unwrap_or(&Value::Null)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// `emptyWorkspaceTree`.
pub fn empty_workspace_tree() -> Value {
    json!({ "version": WORKSPACE_TREE_VERSION, "nodes": [] })
}

/// `isWorkspaceTreeRoot`: a parent naming a top-level place.
pub fn is_workspace_tree_root(parent: Option<&Value>) -> bool {
    parent.is_some_and(|parent| parent.get("root").is_some())
}

/// `workspaceTreeRootPlace`: where a node at the top level shows, or None.
pub fn workspace_tree_root_place(node: &Value) -> Option<String> {
    if parent_of(node).is_some() {
        return None;
    }
    let root = str_field(node, "root").map(str::to_owned);
    if is_group(node) {
        return Some(root.unwrap_or_else(|| "top".into()));
    }
    root
}

/// `workspaceTreeNodePlaced`: under a parent, or at the top level.
pub fn workspace_tree_node_placed(node: &Value) -> bool {
    parent_of(node).is_some() || workspace_tree_root_place(node).is_some()
}

fn parse_root_place(value: Option<&Value>) -> Option<&'static str> {
    let text = value?.as_str()?;
    ROOT_PLACES.into_iter().find(|place| *place == text)
}

/// `withPlacement`: the node with `parent` and, at the top level, `root`.
fn with_placement(node: &Value, parent: Option<&str>, root: Option<&str>) -> Value {
    let mut next = node.as_object().cloned().unwrap_or_default();
    next.insert(
        "parent".into(),
        parent.map_or(Value::Null, |parent| Value::String(parent.to_owned())),
    );
    next.shift_remove("root");
    if let (None, Some(root)) = (parent, root) {
        if is_group(node) {
            if root == "bottom" {
                next.insert("root".into(), json!("bottom"));
            }
        } else {
            next.insert("root".into(), json!(root));
        }
    }
    Value::Object(next)
}

/// `workspaceTreeChildren`.
pub fn workspace_tree_children(tree: &Value, parent: Option<&str>) -> Vec<Value> {
    nodes(tree)
        .iter()
        .filter(|node| parent_of(node) == parent)
        .cloned()
        .collect()
}

/// `findWorkspaceNode`.
pub fn find_workspace_node<'a>(tree: &'a Value, reference: &Value) -> Option<&'a Value> {
    let key = workspace_ref_key(reference);
    nodes(tree)
        .iter()
        .find(|node| is_workspace(node) && workspace_ref_key(ref_of(node)) == key)
}

/// `workspaceTreeContains`: whether `node` is `ancestor` or below it.
pub fn workspace_tree_contains(tree: &Value, ancestor: &str, node: Option<&str>) -> bool {
    let by_id: HashMap<&str, &Value> = nodes(tree).iter().map(|each| (id_of(each), each)).collect();
    let mut cursor = node.map(str::to_owned);
    let mut seen = HashSet::new();
    while let Some(current) = cursor {
        if !seen.insert(current.clone()) {
            break;
        }
        if current == ancestor {
            return true;
        }
        cursor = by_id
            .get(current.as_str())
            .and_then(|each| parent_of(each))
            .map(str::to_owned);
    }
    false
}

/// `prune`: workspace nodes in their usual place with nothing under them
/// carry nothing. None when nothing went (the same tree).
fn prune(tree: &Value) -> Option<Value> {
    let parents: HashSet<&str> = nodes(tree).iter().filter_map(parent_of).collect();
    let kept: Vec<Value> = nodes(tree)
        .iter()
        .filter(|node| {
            is_group(node) || workspace_tree_node_placed(node) || parents.contains(id_of(node))
        })
        .cloned()
        .collect();
    (kept.len() != nodes(tree).len()).then(|| with_nodes(tree, kept))
}

fn pruned(tree: Value) -> Value {
    prune(&tree).unwrap_or(tree)
}

static GENERATED: AtomicU64 = AtomicU64::new(0);

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u32;
        digits.push(std::char::from_digit(digit, 36).unwrap());
        value /= 36;
    }
    digits.iter().rev().collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `Math.random().toString(36).slice(2, 2 + len)`: random base-36 letters.
fn random36(len: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    while out.len() < len {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(GENERATED.load(Ordering::Relaxed));
        hasher.write_u64(now_ms());
        out.push_str(&base36(hasher.finish()));
    }
    out.truncate(len);
    out
}

fn new_node_id(tree: &Value) -> String {
    let ids: HashSet<&str> = nodes(tree).iter().map(id_of).collect();
    loop {
        let count = GENERATED.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("w{}{}{}", base36(now_ms()), base36(count), random36(4));
        if !ids.contains(id.as_str()) {
            return id;
        }
    }
}

/// `newWorkspaceTreeGroupId`: a fresh id for a group.
pub fn new_workspace_tree_group_id() -> String {
    format!("g{}{}", base36(now_ms()), random36(8))
}

fn node_by_id<'a>(tree: &'a Value, id: &str) -> TreeResult<&'a Value> {
    nodes(tree)
        .iter()
        .find(|each| id_of(each) == id)
        .ok_or_else(|| error("That item is no longer arranged."))
}

/// `ensureTarget`: the node a target names, made (as an unplaced
/// workspace) when needed.
fn ensure_target(tree: Value, target: &Value) -> TreeResult<(Value, String)> {
    if let Some(node) = target.get("node") {
        let id = node_by_id(&tree, node.as_str().unwrap_or(""))?;
        let id = id_of(id).to_owned();
        return Ok((tree, id));
    }
    let reference = target
        .get("workspace")
        .and_then(parse_workspace_ref)
        .ok_or_else(|| error("That workspace cannot be named."))?;
    if let Some(existing) = find_workspace_node(&tree, &reference) {
        let id = id_of(existing).to_owned();
        return Ok((tree, id));
    }
    if nodes(&tree).len() >= WORKSPACE_TREE_MAX_NODES {
        return Err(error("The arrangement is full."));
    }
    let id = new_node_id(&tree);
    let mut list = nodes(&tree).to_vec();
    list.push(json!({ "id": id, "kind": "workspace", "parent": null, "ref": reference }));
    Ok((with_nodes(&tree, list), id))
}

fn existing_target(tree: &Value, target: Option<&Value>) -> Option<String> {
    let target = target.filter(|target| !target.is_null())?;
    if let Some(node) = target.get("node") {
        let node = node.as_str()?;
        return nodes(tree)
            .iter()
            .any(|each| id_of(each) == node)
            .then(|| node.to_owned());
    }
    let reference = target.get("workspace").and_then(parse_workspace_ref)?;
    find_workspace_node(tree, &reference).map(|node| id_of(node).to_owned())
}

/// `place`: `id` under `parent` (at the top level: in `root`), before
/// `before` when that is a sibling there.
fn place(
    tree: &Value,
    id: &str,
    parent: Option<&str>,
    before: Option<&str>,
    root: Option<&str>,
) -> TreeResult<Value> {
    let node = with_placement(node_by_id(tree, id)?, parent, root);
    let mut rest: Vec<Value> = nodes(tree)
        .iter()
        .filter(|each| id_of(each) != id)
        .cloned()
        .collect();
    let anchor = before.filter(|before| *before != id).and_then(|before| {
        rest.iter()
            .position(|each| id_of(each) == before && parent_of(each) == parent)
    });
    match anchor {
        Some(anchor) => rest.insert(anchor, node),
        None => {
            // After its last sibling, so the order of other levels stays put.
            let last = rest.iter().rposition(|each| parent_of(each) == parent);
            let at = last.map_or(rest.len(), |last| last + 1);
            rest.insert(at, node);
        }
    }
    Ok(with_nodes(tree, rest))
}

/// `lift`: removes a node; its children take its place under its parent.
fn lift(tree: &Value, id: &str) -> TreeResult<Value> {
    let node = node_by_id(tree, id)?;
    let parent = parent_of(node).map(str::to_owned);
    // At the top level, workspaces go back to their usual place.
    let children: Vec<Value> = nodes(tree)
        .iter()
        .filter(|each| parent_of(each) == Some(id))
        .map(|each| with_placement(each, parent.as_deref(), None))
        .collect();
    let mut out = Vec::new();
    for each in nodes(tree) {
        if id_of(each) == id {
            out.extend(children.iter().cloned());
        } else if parent_of(each) != Some(id) {
            out.push(each.clone());
        }
    }
    Ok(with_nodes(tree, out))
}

/// `applyWorkspaceTreeOp`: one operation (as [`parse_workspace_tree_op`]
/// gives it). None when the tree is the same one (a refresh that changed
/// nothing).
pub fn apply_op(tree: &Value, op: &Value) -> TreeResult<Option<Value>> {
    match str_field(op, "op").unwrap_or("") {
        "move" => {
            let subject = op.get("subject").unwrap_or(&Value::Null);
            let (mut next, subject) = ensure_target(tree.clone(), subject)?;
            let parent_target = op.get("parent").filter(|parent| !parent.is_null());
            let root = parent_target
                .filter(|parent| is_workspace_tree_root(Some(parent)))
                .and_then(|parent| str_field(parent, "root"))
                .map(str::to_owned);
            let mut parent = None;
            if let Some(target) = parent_target
                && !is_workspace_tree_root(Some(target))
            {
                let (tree, id) = ensure_target(next, target)?;
                next = tree;
                parent = Some(id);
            }
            if let Some(parent) = &parent
                && workspace_tree_contains(&next, &subject, Some(parent))
            {
                return Err(error(
                    "A workspace cannot go inside itself or what is under it.",
                ));
            }
            let before = existing_target(&next, op.get("before"));
            let placed = place(
                &next,
                &subject,
                parent.as_deref(),
                before.as_deref(),
                root.as_deref(),
            )?;
            Ok(Some(pruned(placed)))
        }
        "create_group" => {
            let id = str_field(op, "id").unwrap_or("");
            if !node_id_ok(id) || nodes(tree).iter().any(|node| id_of(node) == id) {
                return Err(error("That group id is taken or invalid."));
            }
            let label = normalize_group_label(op.get("label"));
            if label.is_empty() {
                return Err(error("A group needs a name."));
            }
            if nodes(tree).len() >= WORKSPACE_TREE_MAX_NODES {
                return Err(error("The arrangement is full."));
            }
            let mut next = tree.clone();
            let parent_target = op.get("parent").filter(|parent| !parent.is_null());
            let root = parent_target
                .filter(|parent| is_workspace_tree_root(Some(parent)))
                .and_then(|parent| str_field(parent, "root"))
                .map(str::to_owned);
            let mut parent = None;
            if let Some(target) = parent_target
                && !is_workspace_tree_root(Some(target))
            {
                let (tree, found) = ensure_target(next, target)?;
                next = tree;
                parent = Some(found);
            }
            let mut list = nodes(&next).to_vec();
            list.push(json!({ "id": id, "kind": "group", "parent": parent, "label": label }));
            next = with_nodes(&next, list);
            let before = existing_target(&next, op.get("before"));
            let placed = place(
                &next,
                id,
                parent.as_deref(),
                before.as_deref(),
                root.as_deref(),
            )?;
            Ok(Some(pruned(placed)))
        }
        "rename_group" => {
            let id = str_field(op, "node").unwrap_or("");
            let node = node_by_id(tree, id)?;
            if !is_group(node) {
                return Err(error("Not a group."));
            }
            let label = normalize_group_label(op.get("label"));
            if label.is_empty() {
                return Err(error("A group needs a name."));
            }
            let mut renamed = node.as_object().cloned().unwrap_or_default();
            renamed.insert("label".into(), json!(label));
            let renamed = Value::Object(renamed);
            Ok(Some(with_nodes(
                tree,
                nodes(tree)
                    .iter()
                    .map(|each| {
                        if id_of(each) == id {
                            renamed.clone()
                        } else {
                            each.clone()
                        }
                    })
                    .collect(),
            )))
        }
        "set_collapsed" => {
            let id = str_field(op, "node").unwrap_or("");
            let node = node_by_id(tree, id)?;
            if !is_group(node) {
                return Err(error("Not a group."));
            }
            let mut rest = node.as_object().cloned().unwrap_or_default();
            rest.shift_remove("collapsed");
            if op.get("collapsed") == Some(&Value::Bool(true)) {
                rest.insert("collapsed".into(), Value::Bool(true));
            }
            let rest = Value::Object(rest);
            Ok(Some(with_nodes(
                tree,
                nodes(tree)
                    .iter()
                    .map(|each| {
                        if id_of(each) == id {
                            rest.clone()
                        } else {
                            each.clone()
                        }
                    })
                    .collect(),
            )))
        }
        "delete_group" => {
            let id = str_field(op, "node").unwrap_or("");
            if !is_group(node_by_id(tree, id)?) {
                return Err(error("Not a group."));
            }
            Ok(Some(pruned(lift(tree, id)?)))
        }
        "remove" => {
            let id = str_field(op, "node").unwrap_or("");
            if !is_workspace(node_by_id(tree, id)?) {
                return Err(error("Not a workspace."));
            }
            Ok(Some(pruned(lift(tree, id)?)))
        }
        "refresh" => {
            let mut updates: HashMap<String, Value> = HashMap::new();
            for entry in op
                .get("nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let (Some(node), Some(reference)) = (
                    str_field(entry, "node"),
                    entry.get("ref").and_then(parse_workspace_ref),
                ) {
                    updates.insert(node.to_owned(), reference);
                }
            }
            let mut changed = false;
            let list: Vec<Value> = nodes(tree)
                .iter()
                .map(|node| {
                    let Some(reference) = updates.get(id_of(node)) else {
                        return node.clone();
                    };
                    if !is_workspace(node) {
                        return node.clone();
                    }
                    let own = ref_of(node);
                    if str_field(reference, "connection_id") != str_field(own, "connection_id") {
                        return node.clone();
                    }
                    let mut merged = Map::new();
                    merged.insert("connection_id".into(), own["connection_id"].clone());
                    for key in ["path", "label", "workspace_id"] {
                        let value = str_field(reference, key).or_else(|| str_field(own, key));
                        if let Some(value) = value.filter(|value| !value.is_empty()) {
                            merged.insert(key.into(), json!(value));
                        }
                    }
                    let merged = Value::Object(merged);
                    // Both are built in the same key order, as JSON.stringify compared them.
                    if merged == *own {
                        return node.clone();
                    }
                    // Another node already holds that identity: leave this
                    // one be.
                    let key = workspace_ref_key(&merged);
                    let clash = nodes(tree).iter().any(|other| {
                        id_of(other) != id_of(node)
                            && is_workspace(other)
                            && workspace_ref_key(ref_of(other)) == key
                    });
                    if clash {
                        return node.clone();
                    }
                    changed = true;
                    let mut next = node.as_object().cloned().unwrap_or_default();
                    next.insert("ref".into(), merged);
                    Value::Object(next)
                })
                .collect();
            Ok(changed.then(|| with_nodes(tree, list)))
        }
        _ => Err(error("Unknown workspace tree operation.")),
    }
}

/// [`apply_op`], the tree it gives (the same one when nothing changed).
pub fn apply_workspace_tree_op(tree: &Value, op: &Value) -> TreeResult<Value> {
    Ok(apply_op(tree, op)?.unwrap_or_else(|| tree.clone()))
}

/// `parseWorkspaceTreeOp`: validates an operation sent over RPC.
pub fn parse_workspace_tree_op(value: &Value) -> Option<Value> {
    let raw = value.as_object()?;
    // None: invalid; Some(Null): null or absent.
    let target = |input: Option<&Value>| -> Option<Value> {
        let Some(input) = input.filter(|input| !input.is_null()) else {
            return Some(Value::Null);
        };
        let entry = input.as_object()?;
        if let Some(node) = entry.get("node").and_then(Value::as_str)
            && node_id_ok(node)
        {
            return Some(json!({ "node": node }));
        }
        let reference = entry.get("workspace").and_then(parse_workspace_ref)?;
        Some(json!({ "workspace": reference }))
    };
    let parent_of_op = |input: Option<&Value>| -> Option<Value> {
        let place = input
            .filter(|input| input.is_object())
            .and_then(|input| parse_root_place(input.get("root")));
        match place {
            Some(place) => Some(json!({ "root": place })),
            None => target(input),
        }
    };
    let node_id = |input: Option<&Value>| -> Option<String> {
        input
            .and_then(Value::as_str)
            .filter(|text| node_id_ok(text))
            .map(str::to_owned)
    };
    let absent = |value: Option<&Value>| value.is_none();
    match raw.get("op").and_then(Value::as_str)? {
        "move" => {
            let subject = target(raw.get("subject")).filter(|subject| !subject.is_null())?;
            let parent = parent_of_op(raw.get("parent"))?;
            // An undefined parent is invalid; a null one sends it back.
            if absent(raw.get("parent")) {
                return None;
            }
            let before = target(raw.get("before")).filter(|before| !before.is_null());
            let mut out = Map::new();
            out.insert("op".into(), json!("move"));
            out.insert("subject".into(), subject);
            out.insert("parent".into(), parent);
            if let Some(before) = before {
                out.insert("before".into(), before);
            }
            Some(Value::Object(out))
        }
        "create_group" => {
            let id = node_id(raw.get("id"))?;
            let label = raw.get("label").and_then(Value::as_str)?;
            let parent = parent_of_op(raw.get("parent"))?;
            if absent(raw.get("parent")) {
                return None;
            }
            let before = target(raw.get("before")).filter(|before| !before.is_null());
            let mut out = Map::new();
            out.insert("op".into(), json!("create_group"));
            out.insert("id".into(), json!(id));
            out.insert("label".into(), json!(label));
            out.insert("parent".into(), parent);
            if let Some(before) = before {
                out.insert("before".into(), before);
            }
            Some(Value::Object(out))
        }
        "rename_group" => {
            let node = node_id(raw.get("node"))?;
            let label = raw.get("label").and_then(Value::as_str)?;
            Some(json!({ "op": "rename_group", "node": node, "label": label }))
        }
        "set_collapsed" => {
            let node = node_id(raw.get("node"))?;
            let collapsed = raw.get("collapsed").and_then(Value::as_bool)?;
            Some(json!({ "op": "set_collapsed", "node": node, "collapsed": collapsed }))
        }
        op @ ("delete_group" | "remove") => {
            let node = node_id(raw.get("node"))?;
            Some(json!({ "op": op, "node": node }))
        }
        "refresh" => {
            let list = raw.get("nodes").and_then(Value::as_array)?;
            let nodes: Vec<Value> = list
                .iter()
                .take(WORKSPACE_TREE_MAX_NODES)
                .filter_map(|entry| {
                    let entry = entry.as_object()?;
                    let node = node_id(entry.get("node"))?;
                    let reference = entry.get("ref").and_then(parse_workspace_ref)?;
                    Some(json!({ "node": node, "ref": reference }))
                })
                .collect();
            Some(json!({ "op": "refresh", "nodes": nodes }))
        }
        _ => None,
    }
}

/// `workspaceIdentity`: what a live workspace offers to be recognised by.
pub fn workspace_identity(workspace: &Value) -> Value {
    let path = workspace
        .get("worktree")
        .and_then(|worktree| str_field(worktree, "checkout_path"))
        .filter(|path| !path.is_empty())
        .or_else(|| str_field(workspace, "cwd").filter(|path| !path.is_empty()));
    let mut out = Map::new();
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
    if let Some(path) = path {
        out.insert("path".into(), json!(path));
    }
    Value::Object(out)
}

/// `workspaceRefFor`.
pub fn workspace_ref_for(connection_id: &str, workspace: &Value) -> Value {
    let identity = workspace_identity(workspace);
    let mut out = Map::new();
    out.insert("connection_id".into(), json!(connection_id));
    if let Some(path) = str_field(&identity, "path").filter(|path| !path.is_empty()) {
        out.insert("path".into(), json!(path));
    }
    if let Some(label) = str_field(&identity, "label").filter(|label| !label.is_empty()) {
        out.insert("label".into(), json!(label));
    }
    out.insert("workspace_id".into(), identity["workspace_id"].clone());
    Value::Object(out)
}

/// `liveWorkspaceKey`.
pub fn live_workspace_key(connection_id: &str, workspace_id: &str) -> String {
    format!("{connection_id}\u{0}{workspace_id}")
}

/// What a tree node resolved to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Live {
        connection_id: String,
        workspace_id: String,
    },
    /// Its connection is not ready: shown greyed where it was.
    Offline,
    /// Its connection answers but no workspace matches.
    Gone,
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Live {
                connection_id,
                workspace_id,
            } => {
                json!({ "state": "live", "connectionId": connection_id, "workspaceId": workspace_id })
            }
            Self::Offline => json!({ "state": "offline" }),
            Self::Gone => json!({ "state": "gone" }),
        }
    }
}

/// `resolveWorkspaceTree`'s answer, its maps in insertion order.
#[derive(Debug, Clone, Default)]
pub struct ResolvedTree {
    pub nodes: Vec<(String, Resolved)>,
    pub node_by_workspace: Vec<(String, String)>,
    pub refreshes: Vec<Value>,
}

impl ResolvedTree {
    fn state(&self, id: &str) -> Option<&Resolved> {
        self.nodes
            .iter()
            .find(|(each, _)| each == id)
            .map(|(_, state)| state)
    }

    fn has_workspace(&self, key: &str) -> bool {
        self.node_by_workspace.iter().any(|(each, _)| each == key)
    }
}

/// `resolveWorkspaceTree`: matches the tree's workspaces with the live
/// ones (`live`: each ready connection's workspaces, in order; a
/// connection missing from it is offline). A path decides first, then the
/// label, then the last id seen.
pub fn resolve_workspace_tree(tree: &Value, live: &[(String, Vec<Value>)]) -> ResolvedTree {
    let mut out = ResolvedTree::default();
    let mut by_connection: Vec<(String, Vec<&Value>)> = Vec::new();
    for node in nodes(tree).iter().filter(|node| is_workspace(node)) {
        let connection = str_field(ref_of(node), "connection_id")
            .unwrap_or("")
            .to_owned();
        match by_connection
            .iter_mut()
            .find(|(each, _)| *each == connection)
        {
            Some((_, list)) => list.push(node),
            None => by_connection.push((connection, vec![node])),
        }
    }
    for (connection_id, refs) in &by_connection {
        let Some((_, workspaces)) = live.iter().find(|(each, _)| each == connection_id) else {
            for node in refs {
                set_state(&mut out, id_of(node), Resolved::Offline);
            }
            continue;
        };
        let mut claimed: HashSet<String> = HashSet::new();
        let label = |value: &Value| str_field(value, "label").map(str::to_owned);
        let wid = |value: &Value| str_field(value, "workspace_id").map(str::to_owned);
        let path = |value: &Value| {
            str_field(value, "path")
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
        };
        let matched = |out: &mut ResolvedTree,
                       claimed: &mut HashSet<String>,
                       node: &Value,
                       workspace: &Value| {
            let workspace_id = wid(workspace).unwrap_or_default();
            claimed.insert(workspace_id.clone());
            set_state(
                out,
                id_of(node),
                Resolved::Live {
                    connection_id: connection_id.clone(),
                    workspace_id: workspace_id.clone(),
                },
            );
            out.node_by_workspace.push((
                live_workspace_key(connection_id, &workspace_id),
                id_of(node).to_owned(),
            ));
            let own = ref_of(node);
            let live_path = path(workspace);
            if label(workspace) != label(own)
                || wid(workspace) != wid(own)
                || live_path
                    .as_ref()
                    .is_some_and(|p| Some(p.as_str()) != str_field(own, "path"))
            {
                let mut reference = Map::new();
                reference.insert("connection_id".into(), json!(connection_id));
                if let Some(p) = &live_path {
                    reference.insert("path".into(), json!(p));
                }
                if let Some(l) = label(workspace).filter(|l| !l.is_empty()) {
                    reference.insert("label".into(), json!(l));
                }
                reference.insert("workspace_id".into(), json!(workspace_id));
                out.refreshes
                    .push(json!({ "node": id_of(node), "ref": reference }));
            }
        };
        let pick = |node: &Value, candidates: Vec<&Value>| -> Option<Value> {
            let own = ref_of(node);
            candidates
                .iter()
                .find(|each| label(each) == label(own) && wid(each) == wid(own))
                .or_else(|| candidates.iter().find(|each| label(each) == label(own)))
                .or_else(|| candidates.iter().find(|each| wid(each) == wid(own)))
                .or_else(|| candidates.first())
                .map(|each| (*each).clone())
        };
        // A path first: the strongest identity.
        for node in refs {
            let Some(own_path) = path(ref_of(node)) else {
                continue;
            };
            let candidates: Vec<&Value> = workspaces
                .iter()
                .filter(|each| !claimed.contains(&wid(each).unwrap_or_default()))
                .filter(|each| path(each).as_deref() == Some(own_path.as_str()))
                .collect();
            if let Some(found) = pick(node, candidates) {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        // Then a label, for workspaces without a checkout.
        for node in refs {
            let own = ref_of(node);
            let Some(own_label) = label(own).filter(|l| !l.is_empty()) else {
                continue;
            };
            if path(own).is_some() || out.state(id_of(node)).is_some() {
                continue;
            }
            let candidates: Vec<&Value> = workspaces
                .iter()
                .filter(|each| !claimed.contains(&wid(each).unwrap_or_default()))
                .filter(|each| {
                    path(each).is_none() && label(each).as_deref() == Some(own_label.as_str())
                })
                .collect();
            if let Some(found) = pick(node, candidates) {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        // Then the id last seen: a pathless workspace the user renamed.
        for node in refs {
            let own = ref_of(node);
            let Some(own_id) = wid(own).filter(|id| !id.is_empty()) else {
                continue;
            };
            if path(own).is_some() || out.state(id_of(node)).is_some() {
                continue;
            }
            let found = workspaces
                .iter()
                .filter(|each| !claimed.contains(&wid(each).unwrap_or_default()))
                .find(|each| path(each).is_none() && wid(each).as_deref() == Some(own_id.as_str()))
                .cloned();
            if let Some(found) = found {
                matched(&mut out, &mut claimed, node, &found);
            }
        }
        for node in refs {
            if out.state(id_of(node)).is_none() {
                set_state(&mut out, id_of(node), Resolved::Gone);
            }
        }
    }
    out
}

fn set_state(out: &mut ResolvedTree, id: &str, state: Resolved) {
    match out.nodes.iter_mut().find(|(each, _)| each == id) {
        Some(entry) => entry.1 = state,
        None => out.nodes.push((id.to_owned(), state)),
    }
}

/// `goneWorkspaceTreeNodes`: the workspace nodes of `connection_id` that
/// Herdr confirms gone (`live`: that connection's list, read just now).
/// With `closed`, only the nodes naming that workspace count.
pub fn gone_workspace_tree_nodes(
    tree: &Value,
    connection_id: &str,
    live: &[Value],
    closed: Option<&Value>,
) -> Vec<String> {
    if closed.is_none() && live.is_empty() {
        return Vec::new();
    }
    let resolved = resolve_workspace_tree(tree, &[(connection_id.to_owned(), live.to_vec())]);
    let free_labels: HashSet<String> = live
        .iter()
        .filter(|each| {
            !resolved.has_workspace(&live_workspace_key(
                connection_id,
                str_field(each, "workspace_id").unwrap_or(""),
            ))
        })
        .filter_map(|each| str_field(each, "label").map(str::to_owned))
        .collect();
    nodes(tree)
        .iter()
        .filter(|node| {
            is_workspace(node) && str_field(ref_of(node), "connection_id") == Some(connection_id)
        })
        .filter(|node| resolved.state(id_of(node)) == Some(&Resolved::Gone))
        .filter(|node| {
            let own = ref_of(node);
            let own_path = str_field(own, "path").filter(|p| !p.is_empty());
            let own_label = str_field(own, "label").filter(|l| !l.is_empty());
            if let Some(closed) = closed {
                let closed_path = str_field(closed, "path").filter(|p| !p.is_empty());
                let closed_label = str_field(closed, "label").filter(|l| !l.is_empty());
                return str_field(own, "workspace_id") == str_field(closed, "workspace_id")
                    || (closed_path.is_some() && own_path == closed_path)
                    || (own_path.is_none() && closed_label.is_some() && own_label == closed_label);
            }
            !own_label.is_some_and(|label| free_labels.contains(label))
        })
        .map(|node| id_of(node).to_owned())
        .collect()
}

/// `removeWorkspaceTreeNodes`: takes workspace nodes out; their children
/// take their place.
pub fn remove_workspace_tree_nodes(tree: &Value, ids: &[String]) -> TreeResult<Value> {
    let mut next = tree.clone();
    for id in ids {
        let workspace = nodes(&next)
            .iter()
            .any(|each| id_of(each) == id && is_workspace(each));
        if workspace {
            next = apply_workspace_tree_op(&next, &json!({ "op": "remove", "node": id }))?;
        }
    }
    Ok(next)
}

/// `autoPlaceWorkspace`: where an automatically placed workspace goes:
/// under the workspace that asked for it, unless the usual list already
/// shows it right there or the user arranged it. None: the same tree.
pub fn auto_place_workspace(
    tree: &Value,
    child: &Value,
    parent: &Value,
) -> TreeResult<Option<Value>> {
    if workspace_ref_key(child) == workspace_ref_key(parent) {
        return Ok(None);
    }
    if let Some(existing) = find_workspace_node(tree, child)
        && workspace_tree_node_placed(existing)
    {
        return Ok(None);
    }
    fn repo_key(value: &Value) -> Option<&str> {
        str_field(value, "repo_key").filter(|key| !key.is_empty())
    }
    let usually_there = str_field(child, "connection_id") == str_field(parent, "connection_id")
        && child.get("linked") == Some(&Value::Bool(true))
        && parent.get("linked") == Some(&Value::Bool(false))
        && repo_key(child).is_some()
        && repo_key(child) == repo_key(parent);
    if usually_there {
        return Ok(None);
    }
    let strip = |each: &Value| {
        let mut out = Map::new();
        out.insert(
            "connection_id".into(),
            each.get("connection_id").cloned().unwrap_or(Value::Null),
        );
        for key in ["path", "label", "workspace_id"] {
            if let Some(value) = str_field(each, key).filter(|value| !value.is_empty()) {
                out.insert(key.into(), json!(value));
            }
        }
        Value::Object(out)
    };
    apply_op(
        tree,
        &json!({
            "op": "move",
            "subject": { "workspace": strip(child) },
            "parent": { "workspace": strip(parent) },
        }),
    )
}

/// `workspaceTreeNodeName`: a node's name in a group path.
pub fn workspace_tree_node_name(node: &Value) -> String {
    let name = if is_group(node) {
        str_field(node, "label").unwrap_or("").to_owned()
    } else {
        let own = ref_of(node);
        match str_field(own, "label") {
            Some(label) => label.to_owned(),
            None => str_field(own, "path")
                .map(|path| path.rsplit('/').next().unwrap_or("").to_owned())
                .unwrap_or_default(),
        }
    };
    roamgate_base::settings::js_trim(&name).to_owned()
}

/// `parseWorkspaceTreePath`: "gst/upstreaming" or "gst > upstreaming".
pub fn parse_workspace_tree_path(text: &str) -> Vec<String> {
    text.split(['/', '>'])
        .map(|part| roamgate_base::settings::js_trim(part).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

fn same_tree_name(a: &str, b: &str) -> bool {
    use roamgate_base::settings::js_trim;
    js_trim(a).to_lowercase() == js_trim(b).to_lowercase()
}

/// Options of [`resolve_workspace_tree_path`].
#[derive(Default)]
pub struct PathOptions<'a> {
    /// Where to start, in turn (None: the top level).
    pub bases: Vec<Option<String>>,
    pub create: bool,
    pub prefer_connection: Option<String>,
    pub new_id: Option<&'a mut dyn FnMut() -> String>,
}

/// Where a group path leads: `{node, ops, found}`.
#[derive(Debug, Clone, PartialEq)]
pub struct PathResolution {
    pub node: String,
    pub ops: Vec<Value>,
    pub found: Vec<String>,
}

impl PathResolution {
    pub fn to_json(&self) -> Value {
        json!({ "node": self.node, "ops": self.ops, "found": self.found })
    }
}

/// `resolveWorkspaceTreePath`.
pub fn resolve_workspace_tree_path(
    tree: &Value,
    path: &[String],
    options: PathOptions<'_>,
) -> Option<PathResolution> {
    let names: Vec<String> = path
        .iter()
        .map(|name| roamgate_base::settings::js_trim(name).to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    let prefer = options.prefer_connection.clone();
    let rank = |node: &Value| {
        if is_workspace(node)
            && prefer.is_some()
            && str_field(ref_of(node), "connection_id") == prefer.as_deref()
        {
            0
        } else if is_group(node) {
            1
        } else {
            2
        }
    };
    fn deepest(
        tree: &Value,
        names: &[String],
        parent: Option<&str>,
        from: usize,
        rank: &dyn Fn(&Value) -> i32,
    ) -> Vec<Value> {
        if from >= names.len() {
            return Vec::new();
        }
        let mut matches: Vec<Value> = workspace_tree_children(tree, parent)
            .into_iter()
            .filter(|node| same_tree_name(&workspace_tree_node_name(node), &names[from]))
            .collect();
        matches.sort_by_key(|node| rank(node));
        let mut best: Vec<Value> = Vec::new();
        for found in matches {
            let mut walk = vec![found.clone()];
            walk.extend(deepest(tree, names, Some(id_of(&found)), from + 1, rank));
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
    let mut chosen: Option<(Option<String>, Vec<Value>)> = None;
    let mut seen: Vec<Option<String>> = Vec::new();
    for base in bases {
        if seen.contains(&base) {
            continue;
        }
        seen.push(base.clone());
        if let Some(base) = &base
            && !nodes(tree).iter().any(|node| id_of(node) == base)
        {
            continue;
        }
        let walk = deepest(tree, &names, base.as_deref(), 0, &rank);
        if walk.len() == names.len() {
            return Some(PathResolution {
                node: id_of(walk.last().unwrap()).to_owned(),
                ops: Vec::new(),
                found: walk.iter().map(workspace_tree_node_name).collect(),
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
    let mut fallback = new_workspace_tree_group_id;
    let new_id: &mut dyn FnMut() -> String = match options.new_id {
        Some(new_id) => new_id,
        None => &mut fallback,
    };
    let mut ops = Vec::new();
    let mut parent = walk.last().map(|node| id_of(node).to_owned()).or(base);
    for name in &names[walk.len()..] {
        let id = new_id();
        ops.push(json!({
            "op": "create_group",
            "id": id,
            "label": slice_utf16(name, WORKSPACE_TREE_LABEL_MAX),
            "parent": match &parent {
                None => json!({ "root": "top" }),
                Some(parent) => json!({ "node": parent }),
            },
        }));
        parent = Some(id);
    }
    Some(PathResolution {
        node: parent.unwrap_or_default(),
        ops,
        found: walk.iter().map(workspace_tree_node_name).collect(),
    })
}

/// One of [`workspace_tree_group_paths`].
#[derive(Debug, Clone, PartialEq)]
pub struct GroupPath {
    pub node: String,
    pub kind: String,
    pub names: Vec<String>,
    pub connection_id: Option<String>,
}

impl GroupPath {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("node".into(), json!(self.node));
        out.insert("kind".into(), json!(self.kind));
        out.insert("names".into(), json!(self.names));
        if let Some(connection) = &self.connection_id {
            out.insert("connection_id".into(), json!(connection));
        }
        Value::Object(out)
    }
}

/// `workspaceTreeGroupPaths`: every group, and every workspace that holds
/// others, by the names from the top level down, in sidebar order.
pub fn workspace_tree_group_paths(tree: &Value) -> Vec<GroupPath> {
    let parents: HashSet<&str> = nodes(tree).iter().filter_map(parent_of).collect();
    let mut out = Vec::new();
    fn walk(
        tree: &Value,
        parents: &HashSet<&str>,
        parent: Option<&str>,
        names: &[String],
        seen: &HashSet<String>,
        out: &mut Vec<GroupPath>,
    ) {
        for node in workspace_tree_children(tree, parent) {
            let id = id_of(&node).to_owned();
            if seen.contains(&id) {
                continue;
            }
            let mut here = names.to_vec();
            here.push(workspace_tree_node_name(&node));
            if is_group(&node) || parents.contains(id.as_str()) {
                out.push(GroupPath {
                    node: id.clone(),
                    kind: kind_of(&node).to_owned(),
                    names: here.clone(),
                    connection_id: is_workspace(&node).then(|| {
                        str_field(ref_of(&node), "connection_id")
                            .unwrap_or("")
                            .to_owned()
                    }),
                });
                let mut seen = seen.clone();
                seen.insert(id.clone());
                walk(tree, parents, Some(&id), &here, &seen, out);
            }
        }
    }
    walk(tree, &parents, None, &[], &HashSet::new(), &mut out);
    out
}

/// `workspaceTreeAncestors`: a node and the nodes above it, nearest first.
pub fn workspace_tree_ancestors(tree: &Value, id: Option<&str>) -> Vec<String> {
    let by_id: HashMap<&str, &Value> = nodes(tree).iter().map(|node| (id_of(node), node)).collect();
    let mut out: Vec<String> = Vec::new();
    let mut cursor = id.map(str::to_owned);
    while let Some(current) = cursor {
        let Some(node) = by_id.get(current.as_str()) else {
            break;
        };
        if out.contains(&current) {
            break;
        }
        out.push(current);
        cursor = parent_of(node).map(str::to_owned);
    }
    out
}

#[cfg(test)]
mod tests;
