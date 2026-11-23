//! Where a project's review workspace goes in the Workspaces tree
//! (`mr-reviews/tree.ts`): the project's `tree_group` setting (a path of
//! names: groups, or workspaces, which hold children too), else a
//! "Reviews" group under the workspace of the project's clone when the
//! tree has it, else a top-level "Reviews" group. Names match
//! case-insensitively (as the agents' --group); missing groups are created.

use roamgate_agents::js;
use serde_json::{Value, json};

use crate::workspace_tree::{self, PathOptions};

pub const DEFAULT_GROUP: &str = "Reviews";

/// The review workspace to place.
pub struct Placement<'a> {
    /// The review workspace's reference (`WorkspaceRef`).
    pub reference: &'a Value,
    pub connection_id: &'a str,
    pub clone_path: &'a str,
    /// The project's `tree_group` setting.
    pub path: Option<&'a [String]>,
}

/// `reviewPlacementOps`: the operations that put the review workspace in
/// its place, creating the groups it needs (ids from `new_id`, the
/// tree's own group ids when None).
pub fn review_placement_ops(
    tree: &Value,
    target: &Placement<'_>,
    new_id: Option<&mut dyn FnMut() -> String>,
) -> Vec<Value> {
    let mut fresh = workspace_tree::new_group_id;
    let new_id: &mut dyn FnMut() -> String = match new_id {
        Some(new_id) => new_id,
        None => &mut fresh,
    };
    let path: Option<Vec<String>> = target.path.map(|path| {
        path.iter()
            .map(|part| js::trim(part).to_owned())
            .filter(|part| !part.is_empty())
            .collect()
    });
    let clone = workspace_tree::nodes(tree).into_iter().find(|node| {
        let reference = workspace_tree::node_ref(node);
        workspace_tree::is_workspace(node)
            && reference.get("connection_id").and_then(Value::as_str) == Some(target.connection_id)
            && reference.get("path").and_then(Value::as_str) == Some(target.clone_path)
    });
    let resolved = match path.filter(|path| !path.is_empty()) {
        Some(path) => workspace_tree::resolve_path(
            tree,
            &path,
            PathOptions {
                bases: Vec::new(),
                create: true,
                prefer_connection: Some(target.connection_id),
                new_id,
            },
        ),
        None => workspace_tree::resolve_path(
            tree,
            &[DEFAULT_GROUP.to_owned()],
            PathOptions {
                bases: vec![clone.map(|node| workspace_tree::node_id(node).to_owned())],
                create: true,
                prefer_connection: None,
                new_id,
            },
        ),
    };
    // A path with a name always resolves when groups may be created.
    let Some(resolved) = resolved else {
        return Vec::new();
    };
    let mut ops = resolved.ops;
    ops.push(json!({
        "op": "move",
        "subject": {"workspace": target.reference},
        "parent": {"node": resolved.node},
    }));
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> Value {
        json!({"connection_id": "desktop", "path": "/src/gst.worktrees/review", "label": "Reviews \u{b7} gstreamer"})
    }

    fn tree() -> Value {
        json!({"version": 1, "nodes": [
            {"id": "gst", "kind": "workspace", "parent": null, "ref": {"connection_id": "desktop", "path": "/src/gst", "label": "gst"}},
            {"id": "gstMac", "kind": "workspace", "parent": null, "ref": {"connection_id": "local", "path": "/Users/me/gst", "label": "gst"}},
            {"id": "rev", "kind": "group", "parent": "gst", "label": "reviews"},
            {"id": "up", "kind": "group", "parent": "gst", "label": "upstreaming"},
        ]})
    }

    fn ops(clone_path: &str, path: Option<&[&str]>) -> Value {
        let mut n = 0;
        let mut new_id = || {
            n += 1;
            format!("new{n}")
        };
        let path: Option<Vec<String>> = path.map(|p| p.iter().map(|s| s.to_string()).collect());
        let reference = reference();
        Value::Array(review_placement_ops(
            &tree(),
            &Placement {
                reference: &reference,
                connection_id: "desktop",
                clone_path,
                path: path.as_deref(),
            },
            Some(&mut new_id),
        ))
    }

    #[test]
    fn a_set_path_reuses_what_exists_by_name_case_insensitively() {
        assert_eq!(
            ops("/src/gst", Some(&["GST", "Reviews"])),
            json!([{"op": "move", "subject": {"workspace": reference()}, "parent": {"node": "rev"}}])
        );
    }

    #[test]
    fn missing_groups_of_a_set_path_are_created() {
        assert_eq!(
            ops("/x", Some(&["gst", "reviews", "rs"])),
            json!([
                {"op": "create_group", "id": "new1", "label": "rs", "parent": {"node": "rev"}},
                {"op": "move", "subject": {"workspace": reference()}, "parent": {"node": "new1"}},
            ])
        );
        assert_eq!(
            ops("/x", Some(&["Work", "Reviews"])),
            json!([
                {"op": "create_group", "id": "new1", "label": "Work", "parent": {"root": "top"}},
                {"op": "create_group", "id": "new2", "label": "Reviews", "parent": {"node": "new1"}},
                {"op": "move", "subject": {"workspace": reference()}, "parent": {"node": "new2"}},
            ])
        );
    }

    #[test]
    fn by_default_a_reviews_group_under_the_clones_workspace_else_at_the_top() {
        assert_eq!(
            ops("/src/gst", None),
            json!([{"op": "move", "subject": {"workspace": reference()}, "parent": {"node": "rev"}}])
        );
        assert_eq!(
            ops("/elsewhere", None),
            json!([
                {"op": "create_group", "id": "new1", "label": "Reviews", "parent": {"root": "top"}},
                {"op": "move", "subject": {"workspace": reference()}, "parent": {"node": "new1"}},
            ])
        );
        // The ids the tree makes by default: g, the time, random digits.
        let reference = reference();
        let made = review_placement_ops(
            &tree(),
            &Placement {
                reference: &reference,
                connection_id: "desktop",
                clone_path: "/elsewhere",
                path: None,
            },
            None,
        );
        assert!(made[0]["id"].as_str().unwrap().starts_with('g'));
    }
}
