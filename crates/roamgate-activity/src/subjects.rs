//! A workspace's subject (server/src/activity/subjects.ts, subject-tree.ts
//! and subject-settings.ts, docs/activity.md#subjects): the user's grouping
//! of it, by folder only. An explicit group the user made (the Workspaces
//! tree) wins; else the first directory level under a configured
//! `activity.subject_roots` entry. Worktrees are never grouped by their
//! repository. Computed when the log is read, so a new root or group
//! applies to past days too.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use regex::Regex;
use roamgate_base::settings::{js_trim, normalize_activity_settings};
use serde_json::{Value, json};

/// Where a home directory can sit on a connection's host.
const HOME_PREFIX: &str =
    r"(?:/Users/[^/]+|/home/[^/]+|/var/home/[^/]+|/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)";

/// What a subject is computed from: a workspace's connection, name and path.
#[derive(Debug, Clone, Copy)]
pub struct SubjectWorkspace<'a> {
    pub connection_id: &'a str,
    pub name: &'a str,
    pub path: Option<&'a str>,
}

impl<'a> SubjectWorkspace<'a> {
    /// From an ActivityWorkspace object.
    pub fn of(workspace: &'a Value) -> Self {
        Self {
            connection_id: workspace
                .get("connection_id")
                .and_then(Value::as_str)
                .unwrap_or(""),
            name: workspace.get("name").and_then(Value::as_str).unwrap_or(""),
            path: workspace.get("path").and_then(Value::as_str),
        }
    }
}

struct Root {
    configured: String,
    label: String,
    patterns: Vec<Regex>,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn trim_slashes(value: &str) -> &str {
    value.trim_end_matches(['/', '\\'])
}

fn parse_root(configured: &str, home: &str) -> Option<Root> {
    let root = trim_slashes(js_trim(configured));
    if root.is_empty() || root == "~" {
        return None;
    }
    let label = root.rsplit(['/', '\\']).next().unwrap_or(root).to_owned();
    let rest = |pattern: &str| Regex::new(&format!(r"^{pattern}[\\/]([^\\/]+)(?:[\\/]|$)")).ok();
    if let Some(tail) = root.strip_prefix("~/") {
        let tail = regex::escape(tail).replace('/', r"[\\/]");
        // The bridge's own home, and any user's home on another host: a
        // root under ~ means the same folder on every connection.
        let patterns = [
            rest(&format!(
                r"{}[\\/]{tail}",
                regex::escape(trim_slashes(home))
            )),
            rest(&format!(r"{HOME_PREFIX}[\\/]{tail}")),
        ];
        return Some(Root {
            configured: root.to_owned(),
            label,
            patterns: patterns.into_iter().flatten().collect(),
        });
    }
    let absolute = Regex::new(r"^(?:/|[A-Za-z]:[\\/])").expect("valid regex");
    if !absolute.is_match(root) {
        return None;
    }
    Some(Root {
        configured: root.to_owned(),
        label,
        patterns: rest(&regex::escape(root)).into_iter().collect(),
    })
}

/// The explicit groups holding a workspace, top first (`{id, label}`).
pub type Groups = Vec<(String, String)>;

/// The subject of each workspace (`subjectResolver`).
pub struct SubjectResolver {
    roots: Vec<Root>,
    tree: Option<Tree>,
}

impl SubjectResolver {
    /// `roots` is `activity.subject_roots`; `tree` the user's Workspaces tree.
    pub fn new(roots: &[String], tree: Option<Tree>, home: Option<&str>) -> Self {
        let home = home.map(str::to_owned).unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .display()
                .to_string()
        });
        let mut roots: Vec<Root> = roots
            .iter()
            .filter_map(|root| parse_root(root, &home))
            .collect();
        // The deepest root wins when roots nest.
        roots.sort_by_key(|root| std::cmp::Reverse(utf16_len(&root.configured)));
        Self {
            roots,
            tree: tree.filter(|tree| !tree.nodes.is_empty()),
        }
    }

    /// The subject of `workspace`, or Null.
    pub fn subject_of(&self, workspace: SubjectWorkspace<'_>) -> Value {
        if let Some(groups) = self
            .tree
            .as_ref()
            .and_then(|tree| tree.explicit_groups(workspace))
            && let Some((id, label)) = groups.last()
        {
            return json!({
                "id": id,
                "label": label,
                "source": "explicit",
                "path": null,
                "groups": groups.iter().map(|(id, label)| json!({"id": id, "label": label})).collect::<Vec<_>>(),
            });
        }
        let Some(path) = workspace.path else {
            return Value::Null;
        };
        for root in &self.roots {
            for pattern in &root.patterns {
                let Some(found) = pattern.captures(path) else {
                    continue;
                };
                let folder = found.get(1).map_or("", |m| m.as_str());
                let whole = found.get(0).map_or("", |m| m.as_str());
                let id = format!("dir:{}/{folder}", root.configured);
                let trimmed = whole.strip_suffix(['/', '\\']).unwrap_or(whole);
                return json!({
                    "id": id,
                    "label": folder,
                    "source": "directory",
                    "path": trimmed,
                    "groups": [
                        {"id": format!("dir:{}", root.configured), "label": root.label},
                        {"id": id, "label": folder},
                    ],
                });
            }
        }
        Value::Null
    }

    /// The workspaces with their subjects (`withSubjects`).
    pub fn with_subjects(&self, workspaces: Vec<Value>) -> Vec<Value> {
        workspaces
            .into_iter()
            .map(|mut workspace| {
                let subject = self.subject_of(SubjectWorkspace::of(&workspace));
                if let Some(object) = workspace.as_object_mut() {
                    object.insert("subject".into(), subject);
                }
                workspace
            })
            .collect()
    }

    /// The subjects settings.json gives (`subjectsFromSettings`): the
    /// Workspaces tree's groups, then the folders under
    /// `activity.subject_roots`. Takes the file's raw content.
    pub fn from_settings(raw: &Value) -> Self {
        let activity = normalize_activity_settings(raw.get("activity"));
        let roots: Vec<String> = activity["subject_roots"]
            .as_array()
            .map(|roots| {
                roots
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let tree = raw.get("workspace_tree").map(Tree::parse);
        Self::new(&roots, tree, None)
    }
}

// --- The Workspaces tree (shared/workspaceTree.ts) ---------------------

const WORKSPACE_TREE_MAX_NODES: usize = 2000;
const WORKSPACE_TREE_LABEL_MAX: usize = 120;
const REF_FIELD_MAX: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRef {
    pub connection_id: String,
    pub path: Option<String>,
    pub label: Option<String>,
    pub workspace_id: Option<String>,
}

impl WorkspaceRef {
    /// `workspaceRefKey`.
    fn key(&self) -> String {
        let identity = match (&self.path, &self.label) {
            (Some(path), _) => format!("p:{path}"),
            (None, Some(label)) => format!("l:{label}"),
            _ => format!("i:{}", self.workspace_id.as_deref().unwrap_or("")),
        };
        format!("{}\u{0}{identity}", self.connection_id)
    }
}

#[derive(Debug, Clone)]
pub enum NodeKind {
    Group { label: String },
    Workspace { reference: WorkspaceRef, root: bool },
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub parent: Option<String>,
    pub kind: NodeKind,
}

/// The parts of the Workspaces tree subjects need (`parseWorkspaceTree`).
#[derive(Debug, Clone, Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

fn node_id(value: Option<&Value>) -> Option<&str> {
    let id = value?.as_str()?;
    (!id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

fn bounded_string(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty() && utf16_len(text) <= max).then(|| text.to_owned())
}

fn parse_ref(value: Option<&Value>) -> Option<WorkspaceRef> {
    let raw = value?.as_object()?;
    let connection_id = bounded_string(raw.get("connection_id"), 256)?;
    let path = bounded_string(raw.get("path"), REF_FIELD_MAX);
    let label = bounded_string(raw.get("label"), WORKSPACE_TREE_LABEL_MAX * 4);
    let workspace_id = bounded_string(raw.get("workspace_id"), 256);
    if path.is_none() && label.is_none() && workspace_id.is_none() {
        return None;
    }
    Some(WorkspaceRef {
        connection_id,
        path,
        label,
        workspace_id,
    })
}

fn group_label(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let mut replaced = String::new();
    let mut in_controls = false;
    for ch in text.chars() {
        if ch <= '\u{1f}' || ch == '\u{7f}' {
            if !in_controls {
                replaced.push(' ');
            }
            in_controls = true;
        } else {
            replaced.push(ch);
            in_controls = false;
        }
    }
    let mut out = String::new();
    let mut units = 0;
    for ch in js_trim(&replaced).chars() {
        units += ch.len_utf16();
        if units > WORKSPACE_TREE_LABEL_MAX {
            break;
        }
        out.push(ch);
    }
    out
}

impl Tree {
    /// Validates a stored tree, dropping what does not hold together.
    pub fn parse(value: &Value) -> Self {
        let Some(raw_nodes) = value
            .as_object()
            .and_then(|o| o.get("nodes"))
            .and_then(Value::as_array)
        else {
            return Self::default();
        };
        let mut nodes: Vec<Node> = Vec::new();
        let mut ids: HashSet<String> = HashSet::new();
        let mut keys: HashSet<String> = HashSet::new();
        for raw in raw_nodes.iter().take(WORKSPACE_TREE_MAX_NODES) {
            let Some(entry) = raw.as_object() else {
                continue;
            };
            let Some(id) = node_id(entry.get("id")).filter(|id| !ids.contains(*id)) else {
                continue;
            };
            let parent = node_id(entry.get("parent")).map(str::to_owned);
            let root = matches!(
                entry.get("root").and_then(Value::as_str),
                Some("top" | "list" | "bottom")
            );
            let kind = match entry.get("kind").and_then(Value::as_str) {
                Some("group") => {
                    let label = group_label(entry.get("label"));
                    if label.is_empty() {
                        continue;
                    }
                    NodeKind::Group { label }
                }
                Some("workspace") => {
                    let Some(reference) = parse_ref(entry.get("ref")) else {
                        continue;
                    };
                    if !keys.insert(reference.key()) {
                        continue;
                    }
                    NodeKind::Workspace {
                        reference,
                        root: parent.is_none() && root,
                    }
                }
                _ => continue,
            };
            ids.insert(id.to_owned());
            nodes.push(Node {
                id: id.to_owned(),
                parent,
                kind,
            });
        }
        // Parents that are missing, and loops a hand edit could leave, go
        // back to the top level.
        let known: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
        for node in &mut nodes {
            if node.parent.as_ref().is_some_and(|p| !known.contains(p)) {
                node.parent = None;
            }
        }
        for index in 0..nodes.len() {
            let parents: HashMap<String, Option<String>> = nodes
                .iter()
                .map(|n| (n.id.clone(), n.parent.clone()))
                .collect();
            let mut seen: HashSet<String> = HashSet::from([nodes[index].id.clone()]);
            let mut cursor = nodes[index].parent.clone();
            while let Some(id) = cursor {
                if !seen.insert(id.clone()) {
                    nodes[index].parent = None;
                    break;
                }
                cursor = parents.get(&id).cloned().flatten();
            }
        }
        // Workspace nodes at the top level lose a root place they no longer
        // have a right to when their parent went.
        for node in &mut nodes {
            if node.parent.is_some()
                && let NodeKind::Workspace { root, .. } = &mut node.kind
            {
                *root = false;
            }
        }
        // prune: unplaced workspace nodes that are nobody's parent go.
        let parents: HashSet<String> = nodes.iter().filter_map(|n| n.parent.clone()).collect();
        nodes.retain(|node| match &node.kind {
            NodeKind::Group { .. } => true,
            NodeKind::Workspace { root, .. } => {
                node.parent.is_some() || *root || parents.contains(&node.id)
            }
        });
        Self { nodes }
    }

    fn find(&self, reference: &WorkspaceRef) -> Option<&Node> {
        let key = reference.key();
        self.nodes
            .iter()
            .find(|node| matches!(&node.kind, NodeKind::Workspace { reference, .. } if reference.key() == key))
    }

    /// The explicit groups of the tree holding a workspace, top first
    /// (`treeExplicitGroups`): the group nodes above its node.
    pub fn explicit_groups(&self, workspace: SubjectWorkspace<'_>) -> Option<Groups> {
        let by_path = workspace.path.filter(|p| !p.is_empty()).and_then(|path| {
            self.find(&WorkspaceRef {
                connection_id: workspace.connection_id.to_owned(),
                path: Some(path.to_owned()),
                label: None,
                workspace_id: None,
            })
        });
        let node = by_path.or_else(|| {
            self.find(&WorkspaceRef {
                connection_id: workspace.connection_id.to_owned(),
                path: None,
                label: (!workspace.name.is_empty()).then(|| workspace.name.to_owned()),
                workspace_id: None,
            })
        })?;
        let by_id: HashMap<&str, &Node> = self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let mut groups: Groups = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut parent = node.parent.as_deref().and_then(|p| by_id.get(p).copied());
        while let Some(current) = parent.filter(|p| !seen.contains(p.id.as_str())) {
            seen.insert(current.id.as_str());
            if let NodeKind::Group { label } = &current.kind {
                groups.insert(0, (format!("tree:{}", current.id), label.clone()));
            }
            parent = current
                .parent
                .as_deref()
                .and_then(|p| by_id.get(p).copied());
        }
        (!groups.is_empty()).then_some(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws<'a>(connection_id: &'a str, path: Option<&'a str>) -> SubjectWorkspace<'a> {
        SubjectWorkspace {
            connection_id,
            name: "w",
            path,
        }
    }

    fn resolver() -> SubjectResolver {
        let roots = ["~/devel/clients", "~/devel/gstreamer", "/srv/work/"].map(str::to_owned);
        SubjectResolver::new(&roots, None, Some("/Users/me"))
    }

    #[test]
    fn the_first_folder_under_a_root_is_the_subject_on_any_hosts_home() {
        let subject_of = resolver();
        assert_eq!(
            subject_of.subject_of(ws(
                "local",
                Some("/Users/me/devel/clients/sequence/cloud-project-system")
            )),
            json!({
                "id": "dir:~/devel/clients/sequence",
                "label": "sequence",
                "source": "directory",
                "path": "/Users/me/devel/clients/sequence",
                "groups": [
                    {"id": "dir:~/devel/clients", "label": "clients"},
                    {"id": "dir:~/devel/clients/sequence", "label": "sequence"},
                ],
            })
        );
        let remote = subject_of.subject_of(ws(
            "desktop",
            Some("/var/home/me/devel/clients/sequence/cps-iga-184"),
        ));
        assert_eq!(remote["id"], "dir:~/devel/clients/sequence");
        assert_eq!(remote["path"], "/var/home/me/devel/clients/sequence");
        assert_eq!(
            subject_of.subject_of(ws("box", Some("/home/me/devel/gstreamer/2.0/gst2")))["label"],
            "2.0"
        );
        assert_eq!(
            subject_of.subject_of(ws("box", Some("/srv/work/olmo")))["id"],
            "dir:/srv/work/olmo"
        );
    }

    #[test]
    fn worktrees_are_grouped_by_folder_never_by_their_repository() {
        let subject_of = resolver();
        assert_eq!(
            subject_of.subject_of(ws(
                "desktop",
                Some("/var/home/me/devel/gstreamer/gstreamer-ocio")
            ))["label"],
            "gstreamer-ocio"
        );
        assert_eq!(
            subject_of.subject_of(ws(
                "desktop",
                Some("/var/home/me/devel/gstreamer/gstreamer")
            ))["label"],
            "gstreamer"
        );
    }

    #[test]
    fn a_root_itself_a_path_outside_every_root_or_no_path_has_no_subject() {
        let subject_of = resolver();
        for path in [
            Some("/Users/me/devel/clients"),
            Some("/Users/me/devel/clientsx/a"),
            Some("/tmp/x"),
            None,
        ] {
            assert_eq!(
                subject_of.subject_of(ws("local", path)),
                Value::Null,
                "{path:?}"
            );
        }
        assert_eq!(
            SubjectResolver::new(&[], None, None).subject_of(ws("local", Some("/a/b"))),
            Value::Null
        );
    }

    #[test]
    fn the_deepest_root_wins_when_roots_nest() {
        let nested = SubjectResolver::new(
            &["~/devel".into(), "~/devel/clients".into()],
            None,
            Some("/Users/me"),
        );
        assert_eq!(
            nested.subject_of(ws("local", Some("/Users/me/devel/clients/sequence")))["label"],
            "sequence"
        );
        assert_eq!(
            nested.subject_of(ws("local", Some("/Users/me/devel/misc/roamgate")))["label"],
            "misc"
        );
    }

    #[test]
    fn a_group_of_the_workspaces_tree_wins_over_the_folder() {
        let tree = Tree::parse(&json!({
            "version": 1,
            "nodes": [
                {"id": "g1", "kind": "group", "parent": null, "label": "upstreaming"},
                {"id": "g2", "kind": "group", "parent": "g1", "label": "ocio"},
                {"id": "w1", "kind": "workspace", "parent": null,
                 "ref": {"connection_id": "desktop", "path": "/var/home/me/devel/gstreamer/gstreamer-ocio"}},
                {"id": "w2", "kind": "workspace", "parent": "w1",
                 "ref": {"connection_id": "desktop", "path": "/var/home/me/devel/gstreamer/upstreaming/ocio-plugin"}},
                {"id": "w3", "kind": "workspace", "parent": "g2",
                 "ref": {"connection_id": "desktop", "path": "/var/home/me/devel/gstreamer/upstreaming/ocio-tests"}},
                {"id": "w4", "kind": "workspace", "parent": "g1", "ref": {"connection_id": "local", "label": "notes"}},
            ],
        }));
        let roots = ["~/devel/clients", "~/devel/gstreamer", "/srv/work/"].map(str::to_owned);
        let resolve = SubjectResolver::new(&roots, Some(tree), Some("/Users/me"));
        assert_eq!(
            resolve.subject_of(ws(
                "desktop",
                Some("/var/home/me/devel/gstreamer/upstreaming/ocio-tests")
            )),
            json!({
                "id": "tree:g2",
                "label": "ocio",
                "source": "explicit",
                "path": null,
                "groups": [{"id": "tree:g1", "label": "upstreaming"}, {"id": "tree:g2", "label": "ocio"}],
            })
        );
        let plugin = resolve.subject_of(ws(
            "desktop",
            Some("/var/home/me/devel/gstreamer/upstreaming/ocio-plugin"),
        ));
        assert_eq!(
            (plugin["source"].as_str(), plugin["label"].as_str()),
            (Some("directory"), Some("upstreaming"))
        );
        let notes = resolve.subject_of(SubjectWorkspace {
            connection_id: "local",
            name: "notes",
            path: None,
        });
        assert_eq!(notes["id"], "tree:g1");
        assert_eq!(
            resolve.subject_of(ws(
                "local",
                Some("/var/home/me/devel/gstreamer/upstreaming/ocio-tests")
            ))["source"],
            "directory"
        );
    }

    #[test]
    fn settings_json_gives_both_sources() {
        let subject_of = SubjectResolver::from_settings(&json!({
            "activity": {"subject_roots": ["/srv/work"]},
            "workspace_tree": {
                "version": 1,
                "nodes": [
                    {"id": "g1", "kind": "group", "parent": null, "label": "clients"},
                    {"id": "w1", "kind": "workspace", "parent": "g1", "ref": {"connection_id": "local", "path": "/srv/work/a"}},
                ],
            },
        }));
        assert_eq!(
            subject_of.subject_of(ws("local", Some("/srv/work/a")))["label"],
            "clients"
        );
        assert_eq!(
            subject_of.subject_of(ws("local", Some("/srv/work/b")))["label"],
            "b"
        );
        assert_eq!(
            SubjectResolver::from_settings(&Value::Null)
                .subject_of(ws("local", Some("/srv/work/b"))),
            Value::Null
        );
    }
}
