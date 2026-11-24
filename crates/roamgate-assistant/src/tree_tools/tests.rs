use std::sync::Mutex;

use regex::Regex;
use roamgate_claude::mcp::{McpListener, McpRequest, RANGER_MCP_SERVER};
use roamgate_claude::{ClaudeMcp, McpTurn};
use roamgate_workspace::tree::empty_workspace_tree;

use super::*;
use crate::claude_driver::mcp_tool;
use crate::tools::{Family, RangerHandlers, Replay, call_tool, ranger_tools, tools_of};

fn workspace(
    workspace_id: &str,
    label: &str,
    path: &str,
    linked: bool,
    branch: Option<&str>,
) -> Value {
    json!({
        "workspace_id": workspace_id,
        "label": label,
        "number": workspace_id[1..].parse::<u64>().unwrap(),
        "cwd": path,
        "worktree": {
            "repo_key": "gst",
            "repo_name": "gstreamer",
            "checkout_path": path,
            "is_linked_worktree": linked,
            "git_status": { "branch": branch.unwrap_or(label) },
        },
    })
}

fn connections() -> Vec<TreeToolConnection> {
    vec![
        TreeToolConnection {
            connection_id: "desktop".into(),
            label: "Desktop".into(),
            state: TreeConnectionState::Ready,
            workspaces: vec![
                workspace("w1", "gstreamer", "/src/gstreamer", false, Some("main")),
                workspace(
                    "w2",
                    "gstreamer-ocio-a",
                    "/src/gstreamer-ocio-a",
                    true,
                    None,
                ),
                workspace(
                    "w3",
                    "gstreamer-ocio-b",
                    "/src/gstreamer-ocio-b",
                    true,
                    None,
                ),
            ],
        },
        TreeToolConnection {
            connection_id: "laptop".into(),
            label: "Laptop".into(),
            state: TreeConnectionState::Ready,
            workspaces: vec![workspace("w1", "ocio-c", "/home/me/ocio-c", true, None)],
        },
        TreeToolConnection {
            connection_id: "nas".into(),
            label: "NAS".into(),
            state: TreeConnectionState::Offline,
            workspaces: vec![],
        },
    ]
}

/// The server store in memory: one write per apply, as the real one.
#[derive(Default)]
struct Store {
    tree: Value,
    writes: usize,
    batches: Vec<Vec<Value>>,
}

struct Backend(Arc<Mutex<Store>>);

impl WorkspaceTreeToolBackend for Backend {
    fn connections(
        &self,
        _signal: Option<CancellationToken>,
    ) -> BoxFuture<TreeBackendResult<Vec<TreeToolConnection>>> {
        Box::pin(async { Ok(connections()) })
    }

    fn read(&self) -> BoxFuture<TreeBackendResult<Value>> {
        let tree = self.0.lock().unwrap().tree.clone();
        Box::pin(async move { Ok(tree) })
    }

    fn apply(&self, ops: Vec<Value>) -> BoxFuture<TreeBackendResult<Value>> {
        let store = self.0.clone();
        Box::pin(async move {
            let mut store = store.lock().unwrap();
            let mut tree = store.tree.clone();
            for op in &ops {
                tree = apply_workspace_tree_op(&tree, op)?;
            }
            store.tree = tree.clone();
            store.writes += 1;
            store.batches.push(ops);
            Ok(tree)
        })
    }
}

struct Setup {
    store: Arc<Mutex<Store>>,
    handle: Handler,
}

impl Setup {
    async fn call(&self, name: &str, params: Value) -> AssistantResult<Value> {
        let result = call_tool(Family::Tree, name, params, &self.handle, None).await?;
        Ok(serde_json::from_str(&result.text).unwrap())
    }

    async fn ok(&self, name: &str, params: Value) -> Value {
        self.call(name, params).await.unwrap()
    }

    async fn get(&self) -> Value {
        self.ok("workspace_tree_get", json!({})).await
    }

    async fn refuse(&self, name: &str, params: Value) -> String {
        match self.call(name, params).await {
            Ok(_) => panic!("expected a refusal"),
            Err(error) => error.message().to_owned(),
        }
    }

    fn writes(&self) -> usize {
        self.store.lock().unwrap().writes
    }
}

fn setup() -> Setup {
    let store = Arc::new(Mutex::new(Store {
        tree: empty_workspace_tree(),
        ..Store::default()
    }));
    let handle = create_workspace_tree_tool_handler(Arc::new(Backend(store.clone())));
    Setup { store, handle }
}

fn ocio_a() -> Value {
    json!({ "connection_id": "desktop", "path": "/src/gstreamer-ocio-a" })
}

fn ocio_b() -> Value {
    json!({ "connection_id": "desktop", "workspace_id": "w3" })
}

fn ocio_c() -> Value {
    json!({ "connection_id": "laptop", "workspace_id": "w1" })
}

fn labels_at(view: &Value, placement: &str) -> Vec<String> {
    let mut list: Vec<&Value> = view["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|each| each["placement"] == placement)
        .collect();
    list.sort_by_key(|each| each["position"].as_i64().unwrap());
    list.iter()
        .map(|each| each["label"].as_str().unwrap().to_owned())
        .collect()
}

fn workspace_on<'a>(view: &'a Value, key: &str, value: &str) -> &'a Value {
    view["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|each| each[key] == value)
        .unwrap()
}

#[tokio::test]
async fn get_lists_every_workspace_on_every_connection_with_its_place() {
    let setup = setup();
    let view = setup.get().await;
    assert_eq!(
        view["connections"],
        json!([
            { "connection_id": "desktop", "label": "Desktop", "state": "ready" },
            { "connection_id": "laptop", "label": "Laptop", "state": "ready" },
            { "connection_id": "nas", "label": "NAS", "state": "offline" },
        ])
    );
    assert_eq!(view["workspaces"].as_array().unwrap().len(), 4);
    assert_eq!(
        js::stringify(&view["workspaces"][1]),
        js::stringify(&json!({
            "connection_id": "desktop",
            "workspace_id": "w2",
            "label": "gstreamer-ocio-a",
            "path": "/src/gstreamer-ocio-a",
            "branch": "gstreamer-ocio-a",
            "repository": "gstreamer",
            "usually_under": { "workspace_id": "w1", "label": "gstreamer" },
            "placement": "usual",
            "herdr_number": 2,
        }))
    );
    assert_eq!(view["groups"], json!([]));
    assert!(
        view["outline"]
            .as_str()
            .unwrap()
            .contains("Nothing is arranged")
    );
}

#[tokio::test]
async fn move_nests_workspaces_under_another_across_connections_in_one_write() {
    let setup = setup();
    let result = setup
        .ok(
            "workspace_tree_move",
            json!({
                "moves": [{
                    "items": [ocio_c(), ocio_b()],
                    "to": { "connection_id": "desktop", "workspace_id": "w2" },
                }],
            }),
        )
        .await;
    assert_eq!(result["changed"], true);
    assert_eq!(
        result["changes"],
        json!([
            "Moved \"ocio-c\" (laptop) from its usual place to under \"gstreamer-ocio-a\" (desktop) (position 0 of 2).",
            "Moved \"gstreamer-ocio-b\" (desktop) from its usual place to under \"gstreamer-ocio-a\" (desktop) (position 1 of 2).",
        ])
    );
    assert_eq!(setup.writes(), 1);
    let view = setup.get().await;
    let laptop = workspace_on(&view, "connection_id", "laptop");
    assert_eq!(laptop["placement"], "under");
    assert_eq!(
        laptop["parent"],
        json!({
            "connection_id": "desktop",
            "workspace_id": "w2",
            "label": "gstreamer-ocio-a",
        })
    );
    assert_eq!(laptop["position"], 0);
    assert!(view["outline"].as_str().unwrap().contains(
        "  gstreamer-ocio-a (desktop/w2)\n    ocio-c (laptop/w1)\n    gstreamer-ocio-b (desktop/w3)"
    ));
}

#[tokio::test]
async fn move_to_the_top_level_at_a_position_and_back_to_the_usual_place() {
    let setup = setup();
    setup
        .ok(
            "workspace_tree_move",
            json!({
                "moves": [
                    { "items": [ocio_a(), ocio_b()], "to": { "root": "top" } },
                    { "items": [ocio_c()], "to": { "root": "top" }, "before": ocio_b() },
                    {
                        "items": [{ "connection_id": "desktop", "workspace_id": "w1" }],
                        "to": { "root": "bottom" },
                    },
                ],
            }),
        )
        .await;
    assert_eq!(setup.writes(), 1);
    let view = setup.get().await;
    assert_eq!(
        labels_at(&view, "top"),
        ["gstreamer-ocio-a", "ocio-c", "gstreamer-ocio-b"]
    );
    assert_eq!(view["workspaces"][0]["placement"], "bottom");

    setup
        .ok(
            "workspace_tree_move",
            json!({ "moves": [{ "items": [ocio_a()], "to": { "root": "top" }, "after": ocio_b() }] }),
        )
        .await;
    let view = setup.get().await;
    assert_eq!(
        labels_at(&view, "top"),
        ["ocio-c", "gstreamer-ocio-b", "gstreamer-ocio-a"]
    );

    let result = setup
        .ok(
            "workspace_tree_move",
            json!({ "moves": [{ "items": [ocio_c()], "to": { "usual": true } }] }),
        )
        .await;
    assert_eq!(
        result["changes"],
        json!(["Moved \"ocio-c\" (laptop) from the top level, above the list to its usual place."])
    );
    let view = setup.get().await;
    assert_eq!(
        workspace_on(&view, "connection_id", "laptop")["placement"],
        "usual"
    );
}

#[tokio::test]
async fn a_position_in_herdr_s_order_is_noted_not_applied() {
    let setup = setup();
    let result = setup
        .ok(
            "workspace_tree_move",
            json!({ "moves": [{ "items": [ocio_a()], "to": { "root": "list" }, "position": 0 }] }),
        )
        .await;
    assert_eq!(result["changed"], true);
    assert!(
        result["notes"][0]
            .as_str()
            .unwrap()
            .contains("follow Herdr's order")
    );
}

#[tokio::test]
async fn group_create_takes_its_children_in_the_same_change() {
    let setup = setup();
    let result = setup
        .ok(
            "workspace_tree_group",
            json!({
                "actions": [
                    { "action": "create", "label": "OCIO", "children": [ocio_a(), ocio_b(), ocio_c()] },
                ],
            }),
        )
        .await;
    assert_eq!(setup.writes(), 1);
    let created = result["groups_created"].as_array().unwrap();
    assert_eq!(created.len(), 1);
    let group = created[0]["group"].as_str().unwrap();
    assert!(group.starts_with('g'));
    assert_eq!(created[0]["label"], "OCIO");
    assert!(
        Regex::new(r#"^Created group "OCIO" \(g\w+\) in the top level, above the list\.$"#)
            .unwrap()
            .is_match(result["changes"][0].as_str().unwrap())
    );
    assert_eq!(result["changes"].as_array().unwrap().len(), 4);
    let view = setup.get().await;
    assert_eq!(
        js::stringify(&view["groups"]),
        js::stringify(&json!([{
            "group": group,
            "label": "OCIO",
            "placement": "top",
            "position": 0,
            "children": 3,
        }]))
    );
    assert_eq!(
        view["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|each| each["parent"]["label"] == "OCIO")
            .count(),
        3
    );
}

#[tokio::test]
async fn group_rename_collapse_nesting_by_name_and_delete_moving_children_up() {
    let setup = setup();
    setup
        .ok(
            "workspace_tree_group",
            json!({
                "actions": [
                    { "action": "create", "label": "Upstream" },
                    {
                        "action": "create",
                        "label": "OCIO",
                        "parent": { "group": "upstream" },
                        "children": [ocio_a()],
                    },
                    { "action": "collapse", "group": "OCIO" },
                ],
            }),
        )
        .await;
    let view = setup.get().await;
    let ocio = view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|each| each["label"] == "OCIO")
        .unwrap();
    assert_eq!(ocio["placement"], "under");
    assert_eq!(ocio["parent"]["label"], "Upstream");
    assert_eq!(ocio["collapsed"], true);

    let renamed = setup
        .ok(
            "workspace_tree_group",
            json!({
                "actions": [
                    { "action": "rename", "group": ocio["group"], "label": "Color" },
                    { "action": "expand", "group": "Color" },
                ],
            }),
        )
        .await;
    assert_eq!(
        renamed["changes"],
        json!([
            "Renamed group \"OCIO\" to \"Color\".",
            "Expanded group \"Color\".",
        ])
    );

    let deleted = setup
        .ok(
            "workspace_tree_group",
            json!({ "actions": [{ "action": "delete", "group": "Color" }] }),
        )
        .await;
    assert_eq!(
        deleted["changes"],
        json!(["Deleted group \"Color\"; its 1 item moved up a level, under group \"Upstream\"."])
    );
    let view = setup.get().await;
    let w2 = workspace_on(&view, "workspace_id", "w2");
    assert_eq!(w2["placement"], "under");
    assert_eq!(w2["parent"]["label"], "Upstream");
}

#[tokio::test]
async fn refusals_name_the_problem_and_change_nothing() {
    let setup = setup();
    setup
        .ok(
            "workspace_tree_move",
            json!({ "moves": [{ "items": [ocio_b()], "to": ocio_a() }] }),
        )
        .await;
    let writes = setup.writes();
    let before = setup.store.lock().unwrap().tree.clone();

    assert_eq!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({ "moves": [{ "items": [ocio_a()], "to": ocio_b() }] }),
            )
            .await,
        "Refused to move \"gstreamer-ocio-a\" (desktop) to \"gstreamer-ocio-b\" (desktop): A workspace cannot go inside itself or what is under it. Nothing was changed."
    );
    assert!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({
                    "moves": [
                        { "items": [ocio_c()], "to": { "root": "top" } },
                        { "items": [{ "workspace_id": "w9" }], "to": { "root": "top" } },
                    ],
                }),
            )
            .await
            .contains("Unknown workspace: no open workspace matches workspace \"w9\"")
    );
    assert_eq!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({ "moves": [{ "items": [{ "workspace_id": "w1" }], "to": { "root": "top" } }] }),
            )
            .await,
        "workspace \"w1\" matches several workspaces (on desktop, laptop); add connection_id."
    );
    assert_eq!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({ "moves": [{ "items": [{ "group": "Nope" }], "to": { "root": "top" } }] }),
            )
            .await,
        "Unknown group \"Nope\". There are no groups."
    );
    assert!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({ "moves": [{ "items": [ocio_c()], "to": { "root": "top", "usual": true } }] }),
            )
            .await
            .contains("exactly one of")
    );
    assert_eq!(
        setup
            .refuse(
                "workspace_tree_move",
                json!({
                    "moves": [{
                        "items": [{ "connection_id": "mars", "path": "/x" }],
                        "to": { "root": "top" },
                    }],
                }),
            )
            .await,
        "Unknown connection \"mars\". Connections: desktop, laptop, nas."
    );
    assert!(
        setup
            .refuse(
                "workspace_tree_group",
                json!({ "actions": [{ "action": "delete", "group": "Nope" }] }),
            )
            .await
            .contains("Unknown group \"Nope\"")
    );
    assert_eq!(
        setup
            .refuse("workspace_tree_move", json!({ "moves": [], "extra": 1 }))
            .await,
        "Invalid workspace tree tool parameters."
    );
    assert_eq!(setup.writes(), writes);
    assert_eq!(setup.store.lock().unwrap().tree, before);
}

fn reading() -> Handler {
    Arc::new(|_, _, _| Box::pin(async { Ok(ToolResult::text("{}")) }))
}

#[tokio::test]
async fn the_tools_are_in_ranger_s_mcp_list_executing_directly_in_manual_mode() {
    let setup = setup();
    let tools = ranger_tools(
        &RangerHandlers {
            arrange: Some(setup.handle.clone()),
            ..RangerHandlers::reading(reading())
        },
        false,
    );
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    for tool in tools_of(Family::Tree) {
        assert!(names.contains(&tool.name.as_str()));
    }
    // No proposer was given: arranging never goes through confirmation.
    assert!(!names.iter().any(|name| name.starts_with("propose_")));
    for tool in tools
        .iter()
        .filter(|each| each.name.starts_with("workspace_tree_"))
    {
        assert!(!tool.description.contains("pending proposal"));
    }

    let mcp = ClaudeMcp::with_listen(
        RANGER_MCP_SERVER,
        Box::new(|_| {
            Ok(McpListener {
                url: "http://127.0.0.1:1/mcp".to_owned(),
                stop: Box::new(|| {}),
            })
        }),
    );
    let mut lease = mcp
        .open(McpTurn {
            tools: tools.into_iter().map(mcp_tool).collect(),
            cancel: CancellationToken::new(),
            sources: None,
        })
        .unwrap();
    let config: Value = serde_json::from_str(&lease.config).unwrap();
    let authorization = config["mcpServers"]["ranger"]["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .to_owned();
    let rpc = async |body: Value| {
        mcp.handle(McpRequest::post(Some(&authorization), &body))
            .await
            .body_json()
            .unwrap()
    };
    let list = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
    let listed: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    for name in [
        "workspace_tree_get",
        "workspace_tree_move",
        "workspace_tree_group",
    ] {
        assert!(listed.contains(&name));
    }
    let called = rpc(json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "workspace_tree_group",
            "arguments": { "actions": [{ "action": "create", "label": "OCIO", "children": [ocio_a()] }] },
        },
    }))
    .await;
    assert!(called["result"].get("isError").is_none());
    let text: Value =
        serde_json::from_str(called["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["changed"], true);
    // Applied at once: no pending action waits for a click.
    assert_eq!(setup.writes(), 1);
    let refused = rpc(json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "workspace_tree_move",
            "arguments": { "moves": [{ "items": [{ "workspace_id": "w9" }], "to": { "root": "top" } }] },
        },
    }))
    .await;
    assert_eq!(refused["result"]["isError"], true);
    assert!(
        refused["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Unknown workspace")
    );
    lease.close();
}

#[test]
fn tree_tools_are_absent_without_a_handler_and_moves_run_one_at_a_time() {
    assert!(
        !ranger_tools(&RangerHandlers::reading(reading()), true)
            .iter()
            .any(|tool| tool.name.starts_with("workspace_tree_"))
    );
    let setup = setup();
    let tools = ranger_tools(
        &RangerHandlers {
            arrange: Some(setup.handle.clone()),
            ..RangerHandlers::reading(reading())
        },
        true,
    );
    let by_name = |name: &str| tools.iter().find(|tool| tool.name == name).unwrap();
    assert_eq!(by_name("workspace_tree_get").replay, Replay::Safe);
    assert!(!by_name("workspace_tree_get").sequential);
    assert_eq!(by_name("workspace_tree_move").replay, Replay::Unsafe);
    assert!(by_name("workspace_tree_move").sequential);
    assert!(by_name("workspace_tree_group").sequential);
}
