//! config/workspace-tree.test.ts, the same cases on the Rust store.

use std::sync::atomic::{AtomicUsize, Ordering};

use roamgate_base::clock::{SystemClock, TestClock};

use super::*;
use crate::connection::{BoxFuture as Boxed, SettingsChange};

/// settings.json in memory, counting the writes.
struct Memory {
    settings: Mutex<Arc<Settings>>,
    writes: AtomicUsize,
}

impl Memory {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            settings: Mutex::new(Arc::new(Settings::normalize(&json!({})))),
            writes: AtomicUsize::new(0),
        })
    }

    fn get(&self) -> Arc<Settings> {
        self.settings.lock().unwrap().clone()
    }

    fn writes(&self) -> usize {
        self.writes.load(Ordering::SeqCst)
    }
}

impl SettingsAccess for Memory {
    fn read(&self) -> Boxed<'_, Arc<Settings>> {
        let settings = self.get();
        Box::pin(async move { settings })
    }

    fn update(&self, change: SettingsChange) -> Boxed<'_, Result<Arc<Settings>, String>> {
        let mut settings = self.settings.lock().unwrap();
        if let Some(next) = change(&settings) {
            *settings = Arc::new(Settings::normalize(&next));
            self.writes.fetch_add(1, Ordering::SeqCst);
        }
        let settings = settings.clone();
        Box::pin(async move { Ok(settings) })
    }
}

fn store() -> (Arc<Memory>, Arc<WorkspaceTreeStore>) {
    let memory = Memory::new();
    (memory.clone(), WorkspaceTreeStore::new(memory))
}

fn seen(store: &WorkspaceTreeStore) -> Arc<Mutex<Vec<Value>>> {
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let kept = seen.clone();
    store.listen(Arc::new(move |tree: &Value| {
        kept.lock().unwrap().push(tree.clone());
    }));
    seen
}

fn ocio() -> Value {
    json!({
        "workspace_id": "w1",
        "label": "gstreamer-ocio",
        "worktree": {
            "checkout_path": "/src/gstreamer.worktrees/ocio",
            "repo_key": "gstreamer",
            "is_linked_worktree": true,
        },
    })
}

fn node_count(tree: &Value) -> usize {
    tree["nodes"].as_array().unwrap().len()
}

#[tokio::test]
async fn applies_operations_in_one_write_and_tells_every_listener() {
    let (memory, store) = store();
    let seen = seen(&store);
    let tree = store
        .apply_ops(&[
            json!({ "op": "create_group", "id": "g1", "label": "upstreaming", "parent": null }),
            json!({
                "op": "move",
                "subject": { "workspace": { "connection_id": "desktop", "path": "/home/me/rs", "label": "rs" } },
                "parent": { "node": "g1" },
            }),
        ])
        .await
        .unwrap();
    assert_eq!(node_count(&tree), 2);
    assert_eq!(memory.writes(), 1);
    assert_eq!(*seen.lock().unwrap(), std::slice::from_ref(&tree));
    assert_eq!(store.read().await, tree);
}

#[tokio::test]
async fn writes_nothing_when_an_operation_cannot_apply() {
    let (memory, store) = store();
    let error = store
        .apply_ops(&[
            json!({ "op": "create_group", "id": "g1", "label": "a", "parent": null }),
            json!({ "op": "move", "subject": { "node": "g1" }, "parent": { "node": "g1" } }),
        ])
        .await
        .unwrap_err();
    assert!(error.to_string().contains("inside itself"));
    assert_eq!(memory.writes(), 0);
    assert!(memory.get().get("workspace_tree").is_none());
}

#[tokio::test]
async fn an_emptied_arrangement_leaves_no_trace_in_settings_json() {
    let (memory, store) = store();
    store
        .apply_ops(&[json!({ "op": "create_group", "id": "g1", "label": "a", "parent": null })])
        .await
        .unwrap();
    store
        .apply_ops(&[json!({ "op": "delete_group", "node": "g1" })])
        .await
        .unwrap();
    assert!(memory.get().get("workspace_tree").is_none());
}

#[tokio::test]
async fn refuses_to_grow_past_its_size_limit() {
    let (_, store) = store();
    let label = "x".repeat(4000);
    let mut ops = vec![json!({ "op": "create_group", "id": "g", "label": "g", "parent": null })];
    for index in 0..140 {
        ops.push(json!({
            "op": "move",
            "subject": { "workspace": { "connection_id": "c", "path": format!("/{index}/{label}"), "label": index.to_string() } },
            "parent": { "node": "g" },
        }));
    }
    let error = store.apply_ops(&ops).await.unwrap_err();
    assert!(error.to_string().contains("too large"));
    assert_eq!(WORKSPACE_TREE_MAX_BYTES, 512 * 1024);
}

#[tokio::test]
async fn places_what_an_agent_made_under_its_workspace_and_says_so() {
    let (memory, store) = store();
    let seen = seen(&store);
    let changed = store
        .place_created_workspace(
            "local",
            Some(&json!({
                "workspace_id": "w5",
                "label": "up-colorspace",
                "worktree": {
                    "checkout_path": "/src/gstreamer.worktrees/up-colorspace",
                    "repo_key": "gstreamer",
                    "is_linked_worktree": true,
                },
            })),
            None,
            Some(&ocio()),
        )
        .await
        .unwrap();
    assert!(changed);
    let tree = memory.get().get("workspace_tree").cloned().unwrap();
    let nodes = tree["nodes"].as_array().unwrap();
    let child = nodes
        .iter()
        .find(|node| node["kind"] == "workspace" && node["ref"]["workspace_id"] == "w5")
        .unwrap();
    let parent = nodes
        .iter()
        .find(|node| node["id"] == child["parent"])
        .unwrap();
    assert_eq!(parent["kind"], "workspace");
    assert_eq!(parent["parent"], Value::Null);
    assert_eq!(parent["ref"]["path"], "/src/gstreamer.worktrees/ocio");
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn leaves_a_worktree_made_from_its_repository_s_main_checkout_alone() {
    let (memory, store) = store();
    let changed = store
        .place_created_workspace(
            "local",
            Some(&json!({
                "workspace_id": "w5",
                "label": "up-colorspace",
                "worktree": {
                    "checkout_path": "/src/gstreamer.worktrees/up-colorspace",
                    "repo_key": "gstreamer",
                    "is_linked_worktree": true,
                },
            })),
            None,
            Some(&json!({
                "workspace_id": "w0",
                "label": "gstreamer",
                "worktree": {
                    "checkout_path": "/src/gstreamer",
                    "repo_key": "gstreamer",
                    "is_linked_worktree": false,
                },
            })),
        )
        .await
        .unwrap();
    assert!(!changed);
    assert_eq!(memory.writes(), 0);
}

#[tokio::test]
async fn does_nothing_without_both_workspaces() {
    let (_, store) = store();
    assert!(
        !store
            .place_created_workspace("local", None, None, Some(&ocio()))
            .await
            .unwrap()
    );
}

fn desktop(path: &str, label: Option<&str>) -> Value {
    let mut out = json!({ "connection_id": "desktop", "path": path });
    if let Some(label) = label {
        out["label"] = json!(label);
    }
    out
}

/// gst > upstreaming, and gst > agent (the asking workspace).
fn agent_tree() -> Value {
    json!({
        "version": 1,
        "nodes": [
            { "id": "gst", "kind": "workspace", "parent": null, "ref": desktop("/src/gst", Some("gst")) },
            { "id": "up", "kind": "group", "parent": "gst", "label": "upstreaming" },
            { "id": "me", "kind": "workspace", "parent": "gst", "ref": desktop("/src/gst.worktrees/agent", Some("agent")) },
        ],
    })
}

fn gst() -> Value {
    desktop("/src/gst", Some("gst"))
}

fn agent() -> Value {
    desktop("/src/gst.worktrees/agent", Some("agent"))
}

fn made() -> Value {
    desktop("/src/cerbero.worktrees/pc", Some("cerbero-pc"))
}

fn apply_all(ops: &[Value]) -> Value {
    ops.iter().fold(agent_tree(), |tree, op| {
        apply_workspace_tree_op(&tree, op).unwrap()
    })
}

fn placement(input: GroupPlacement<'_>) -> Result<Placement, TreeError> {
    agent_group_placement_ops(&agent_tree(), input)
}

#[test]
fn a_path_from_the_top_moves_the_workspace_there() {
    let placed = placement(GroupPlacement {
        subject: Some(made()),
        asker: Some(agent()),
        group: "GST/Upstreaming".into(),
        ..GroupPlacement::default()
    })
    .unwrap();
    assert_eq!(
        placed,
        Placement {
            ops: vec![
                json!({ "op": "move", "subject": { "workspace": made() }, "parent": { "node": "up" } })
            ],
            path: vec!["gst".into(), "upstreaming".into()],
            created: vec![],
        }
    );
    let after = apply_all(&placed.ops);
    let moved = after["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["kind"] == "workspace" && node["ref"]["path"] == made()["path"])
        .unwrap();
    assert_eq!(moved["parent"], "up");
}

#[test]
fn a_path_relative_to_the_agent_s_group() {
    assert_eq!(
        placement(GroupPlacement {
            subject: Some(made()),
            asker: Some(agent()),
            group: "upstreaming".into(),
            ..GroupPlacement::default()
        })
        .unwrap()
        .path,
        ["gst", "upstreaming"]
    );
    // Not from somewhere the agent is not.
    assert!(
        placement(GroupPlacement {
            subject: Some(made()),
            group: "upstreaming".into(),
            ..GroupPlacement::default()
        })
        .is_err()
    );
}

#[test]
fn an_agent_in_its_usual_place_starts_from_its_main_checkout() {
    let placed = placement(GroupPlacement {
        subject: Some(made()),
        asker: Some(desktop("/src/gst.worktrees/other", Some("other"))),
        asker_usual_parent: Some(gst()),
        group: "upstreaming".into(),
        ..GroupPlacement::default()
    })
    .unwrap();
    assert_eq!(
        placed.ops.last().unwrap(),
        &json!({ "op": "move", "subject": { "workspace": made() }, "parent": { "node": "up" } })
    );
}

#[test]
fn a_missing_group_is_refused_unless_created() {
    let refused = placement(GroupPlacement {
        subject: Some(made()),
        asker: Some(agent()),
        group: "gst/upstreaming/soundtouch".into(),
        ..GroupPlacement::default()
    })
    .unwrap_err();
    let message = refused.to_string();
    assert!(message.contains("No group \"gst/upstreaming/soundtouch\""));
    assert!(message.contains("--create-group"));
    let mut new_id = || "g-new".to_owned();
    let placed = placement(GroupPlacement {
        subject: Some(made()),
        asker: Some(agent()),
        group: "gst/upstreaming/soundtouch".into(),
        create: true,
        new_id: Some(&mut new_id),
        ..GroupPlacement::default()
    })
    .unwrap();
    assert_eq!(
        placed.ops,
        [
            json!({ "op": "create_group", "id": "g-new", "label": "soundtouch", "parent": { "node": "up" } }),
            json!({ "op": "move", "subject": { "workspace": made() }, "parent": { "node": "g-new" } }),
        ]
    );
    assert_eq!(placed.path, ["gst", "upstreaming", "soundtouch"]);
    assert_eq!(placed.created, ["soundtouch"]);
    assert_eq!(node_count(&apply_all(&placed.ops)), 5);
}

#[test]
fn without_a_subject_it_only_checks_the_path() {
    assert!(
        placement(GroupPlacement {
            asker: Some(agent()),
            group: "gst > upstreaming".into(),
            ..GroupPlacement::default()
        })
        .unwrap()
        .ops
        .is_empty()
    );
    assert!(
        placement(GroupPlacement {
            asker: Some(agent()),
            group: " / ".into(),
            ..GroupPlacement::default()
        })
        .is_err()
    );
}

#[test]
fn a_workspace_cannot_go_into_itself_or_below_itself() {
    for group in ["gst", "gst/upstreaming"] {
        assert!(
            placement(GroupPlacement {
                subject: Some(gst()),
                group: group.into(),
                ..GroupPlacement::default()
            })
            .is_err(),
            "{group}"
        );
    }
}

#[test]
fn groups_lists_the_paths_and_the_agent_s_own() {
    assert_eq!(
        agent_group_paths(&agent_tree(), Some(&agent()), None),
        json!({
            "groups": [
                { "path": "gst", "kind": "workspace", "connection_id": "desktop" },
                { "path": "gst/upstreaming", "kind": "group" },
            ],
            "yours": "gst",
        })
    );
    assert_eq!(
        agent_group_paths(&agent_tree(), None, None)["yours"],
        Value::Null
    );
}

fn ges() -> Value {
    json!({
        "connection_id": "desktop",
        "path": "/src/gstreamer.worktrees/ges-child-names",
        "label": "upstream-ges-child-names",
        "workspace_id": "w3",
    })
}

fn colour() -> Value {
    json!({
        "connection_id": "desktop",
        "path": "/src/gstreamer.worktrees/colour",
        "label": "up-colour",
        "workspace_id": "w2",
    })
}

fn live_desktop() -> Vec<Value> {
    vec![json!({ "workspace_id": "w2", "label": "up-colour", "path": colour()["path"] })]
}

async fn arranged() -> (Arc<Memory>, Arc<WorkspaceTreeStore>) {
    let (memory, store) = store();
    let remote = json!({
        "connection_id": "mac",
        "path": "/Users/me/src/notes",
        "label": "notes",
        "workspace_id": "w1",
    });
    store
        .apply_ops(&[
            json!({ "op": "create_group", "id": "up", "label": "upstream", "parent": null }),
            json!({ "op": "move", "subject": { "workspace": colour() }, "parent": { "node": "up" } }),
            json!({ "op": "move", "subject": { "workspace": ges() }, "parent": { "node": "up" } }),
            json!({ "op": "move", "subject": { "workspace": remote }, "parent": { "node": "up" } }),
        ])
        .await
        .unwrap();
    (memory, store)
}

fn labels(tree: &Value) -> Vec<String> {
    tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            if node["kind"] == "group" {
                format!("[{}]", node["label"].as_str().unwrap())
            } else {
                node["ref"]["label"].as_str().unwrap().to_owned()
            }
        })
        .collect()
}

type Lists = Arc<Mutex<HashMap<String, Vec<Value>>>>;

fn pruner(
    store: &Arc<WorkspaceTreeStore>,
    lists: Lists,
    clock: SharedClock,
) -> (Arc<WorkspaceTreePruner>, Arc<Mutex<Vec<String>>>) {
    let reads: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = reads.clone();
    let list: ListLive = Arc::new(move |connection: String| {
        kept.lock().unwrap().push(connection.clone());
        let answer = lists.lock().unwrap().get(&connection).cloned();
        Box::pin(async move { Ok(answer) })
    });
    let pruner = WorkspaceTreePruner::new(
        store.clone(),
        PrunerOptions {
            list,
            clock,
            settle: Duration::from_millis(1000),
            confirm: Duration::from_millis(5000),
            on_error: None,
        },
    );
    (pruner, reads)
}

async fn flush() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[test]
fn reads_the_workspace_herdr_reports_closed_or_removed() {
    assert_eq!(
        closed_workspace_of_event(&json!({
            "event": "worktree.removed",
            "data": {
                "workspace_id": "w3",
                "workspace": { "workspace_id": "w3", "label": "upstream-ges-child-names" },
                "worktree": { "path": ges()["path"] },
            },
        })),
        Some(json!({
            "workspace_id": "w3",
            "label": "upstream-ges-child-names",
            "path": ges()["path"],
        }))
    );
    assert_eq!(
        closed_workspace_of_event(
            &json!({ "data": { "type": "workspace_closed", "workspace_id": "w3" } })
        ),
        Some(json!({ "workspace_id": "w3" }))
    );
    assert_eq!(
        closed_workspace_of_event(
            &json!({ "event": "tab.closed", "data": { "workspace_id": "w3" } })
        ),
        None
    );
}

#[tokio::test]
async fn a_closed_workspace_leaves_at_once_its_group_and_siblings_kept() {
    let (_, store) = arranged().await;
    let seen = seen(&store);
    let lists: Lists = Arc::new(Mutex::new(HashMap::from([(
        "desktop".to_owned(),
        live_desktop(),
    )])));
    let (prune, _) = pruner(&store, lists, Arc::new(SystemClock));
    prune
        .event(
            "desktop",
            &json!({ "event": "workspace.closed", "data": { "workspace_id": "w3" } }),
        )
        .unwrap()
        .await;
    prune.idle().await;
    prune.dispose();
    let tree = store.read().await;
    assert_eq!(labels(&tree), ["[upstream]", "up-colour", "notes"]);
    assert!(
        tree["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| node["parent"].is_null() || node["parent"] == "up")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_ready_connection_s_vanished_workspaces_leave_once_two_reads_agree() {
    let clock = Arc::new(TestClock::new(1_800_000_000_000));
    let (_, store) = arranged().await;
    let lists: Lists = Arc::new(Mutex::new(HashMap::from([(
        "desktop".to_owned(),
        live_desktop(),
    )])));
    let (prune, reads) = pruner(&store, lists, clock.clone());
    prune.ready("desktop");
    // The connection that is down keeps its workspaces.
    prune.ready("mac");
    flush().await;
    assert!(reads.lock().unwrap().is_empty());
    clock.advance(1000).await;
    flush().await;
    let mut asked = reads.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, ["desktop", "mac"]);
    // Waiting for the second read: nothing gone yet.
    assert!(labels(&store.read().await).contains(&"upstream-ges-child-names".to_owned()));
    clock.advance(5000).await;
    prune.idle().await;
    assert_eq!(
        labels(&store.read().await),
        ["[upstream]", "up-colour", "notes"]
    );
    prune.dispose();
}

#[tokio::test]
async fn a_workspace_back_by_the_second_read_stays() {
    let clock = Arc::new(TestClock::new(1_800_000_000_000));
    let (_, store) = arranged().await;
    let lists: Lists = Arc::new(Mutex::new(HashMap::from([(
        "desktop".to_owned(),
        live_desktop(),
    )])));
    let (prune, reads) = pruner(&store, lists.clone(), clock.clone());
    prune.ready("desktop");
    flush().await;
    clock.advance(1000).await;
    flush().await;
    assert_eq!(*reads.lock().unwrap(), ["desktop"]);
    let mut back = live_desktop();
    back.push(json!({ "workspace_id": "w8", "label": ges()["label"], "path": ges()["path"] }));
    lists.lock().unwrap().insert("desktop".into(), back);
    clock.advance(5000).await;
    prune.idle().await;
    assert_eq!(*reads.lock().unwrap(), ["desktop", "desktop"]);
    assert!(labels(&store.read().await).contains(&"upstream-ges-child-names".to_owned()));
    prune.dispose();
}

/// `bridge.workspace_tree.*` as index.ts answers them.
#[tokio::test]
async fn answers_the_workspace_tree_rpcs() {
    let (_, store) = store();
    assert_eq!(
        rpc(&store, "bridge.workspace_tree.get", &json!({}))
            .await
            .unwrap()
            .unwrap(),
        json!({ "tree": { "version": 1, "nodes": [] } })
    );
    let applied = rpc(
        &store,
        "bridge.workspace_tree.apply",
        &json!({ "ops": [{ "op": "create_group", "id": "g", "label": "a", "parent": null }] }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(node_count(&applied["tree"]), 1);
    for ops in [json!([]), json!([{ "op": "drop_table" }])] {
        assert_eq!(
            rpc(
                &store,
                "bridge.workspace_tree.apply",
                &json!({ "ops": ops })
            )
            .await
            .unwrap()
            .unwrap_err()
            .message,
            "bridge.workspace_tree.apply needs valid ops"
        );
    }
    assert!(rpc(&store, "file.list", &json!({})).await.is_none());
}
