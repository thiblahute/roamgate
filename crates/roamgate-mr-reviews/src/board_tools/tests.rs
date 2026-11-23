//! board-tools.test.ts (the board's tools as an agent session calls them,
//! through module.ts's `boardTool`) and inbox.merge.test.ts's row on the
//! tools' merge fields.

use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use super::*;
use crate::inbox::test_support::store;
use crate::order::tests::{Reviews, reviews};

const HOST: &str = "gl.example";

fn item(n: u64, extra: Value) -> Value {
    let mut out = json!({
        "provider": "gitlab",
        "host": HOST,
        "project": "g/p",
        "number": n,
        "key": key(n),
        "url": format!("https://{HOST}/g/p/-/merge_requests/{n}"),
        "title": format!("MR {n}"),
        "author": "me",
        "draft": false,
        "state": "open",
        "updatedAt": js::iso(js::now_ms()),
        "headSha": format!("head{n}"),
        "sourceBranch": format!("b{n}"),
        "targetBranch": "main",
        "pipeline": "success",
        "notes": 0,
        "reasons": ["authored"],
        "own": {
            "approvedBy": [],
            "approved": false,
            "changesRequested": [],
            "unresolved": 0,
            "conflicts": false,
            "needsRebase": false,
        },
    });
    for (field, value) in extra.as_object().cloned().unwrap_or_default() {
        out[field] = value;
    }
    out
}

fn key(n: u64) -> String {
    format!("gitlab:{HOST}/g/p#{n}")
}

struct Board {
    _dir: tempfile::TempDir,
    t: Reviews,
    deps: BoardToolDeps,
}

impl Board {
    async fn tool(&self, name: &str, params: Value, caller: &str) -> RpcResult<String> {
        board_tool(&self.deps, name, &params, caller).await
    }
}

fn setup() -> Board {
    let persisted = Arc::new(Mutex::new(
        json!({"hosts": [{"host": HOST, "provider": "gitlab"}]}),
    ));
    let (dir, shared_store) = store();
    let ago = |ms: f64| js::iso(js::now_ms() - ms);
    shared_store
        .lock()
        .unwrap()
        .update(|state| {
            state["items"] = json!([
                item(
                    1,
                    json!({"pipeline": "failed", "labels": ["audio"], "updatedAt": ago(60_000.0)})
                ),
                item(2, json!({"updatedAt": ago(120_000.0)})),
                item(3, json!({"reasons": ["review_requested"], "author": "bob"})),
            ]);
        })
        .unwrap();
    let t = reviews(&persisted, &shared_store);
    let rpc: RpcFn = {
        let deps = t.deps.clone();
        Arc::new(move |method: String, params: Obj| {
            let deps = deps.clone();
            Box::pin(
                async move { crate::rpc::handle_mr_reviews_rpc(&deps, &method, &params).await },
            )
        })
    };
    let deps = BoardToolDeps {
        settings: t.deps.settings.clone(),
        inbox: t.deps.inbox.clone(),
        store: shared_store,
        order: t.order.clone(),
        rpc,
        tree: None,
        workspaces: None,
    };
    Board { _dir: dir, t, deps }
}

/// The JSON after the untrusted line.
fn data(text: &str) -> Value {
    let body = match text.find('\n') {
        Some(at) if !text.starts_with('{') => &text[at + 1..],
        _ => text,
    };
    serde_json::from_str(body).unwrap()
}

fn column(rows: &Value, fields: &[&str]) -> Vec<Vec<Value>> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| fields.iter().map(|f| row[*f].clone()).collect())
        .collect()
}

#[tokio::test]
async fn reviews_list_gives_lanes_next_steps_and_overrides_paged() {
    let b = setup();
    let list = data(
        &b.tool("reviews_list", json!({"section": "authored"}), "Claude")
            .await
            .unwrap(),
    );
    assert_eq!(
        column(&list["requests"], &["ref", "lane", "next"]),
        vec![
            vec![
                json!("g/p!1"),
                json!("your_move"),
                json!("Fix the failed pipeline")
            ],
            vec![
                json!("g/p!2"),
                json!("waiting"),
                json!("Waiting for review")
            ],
        ]
    );
    let page = data(
        &b.tool("reviews_list", json!({"limit": 1}), "Claude")
            .await
            .unwrap(),
    );
    assert_eq!(page["requests"].as_array().unwrap().len(), 1);
    let rest = data(
        &b.tool(
            "reviews_list",
            json!({"cursor": page["next_cursor"]}),
            "Claude",
        )
        .await
        .unwrap(),
    );
    assert_eq!(rest["requests"].as_array().unwrap().len(), 2);
    assert!(rest.get("next_cursor").is_none());
}

#[tokio::test]
async fn reviews_override_sets_and_clears_said_with_undo_never_on_others_names() {
    let b = setup();
    let answer: Value = serde_json::from_str(
        &b.tool(
            "reviews_override",
            json!({
                "request": "!2",
                "set": {
                    "whose": "bob",
                    "next": "bob answers the API question",
                    "depends_on": ["g/p!1"],
                    "labels": ["api"],
                },
            }),
            "Claude in sequence-head",
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(answer["changed"], json!(true));
    assert_eq!(answer["lane"], json!("waiting"));
    assert_eq!(answer["next"], json!("bob answers the API question"));
    assert_eq!(answer["next_from"], json!("set by an agent"));
    assert_eq!(answer["depends_on"], json!([key(1)]));
    assert_eq!(answer["under"], json!(key(1)));
    let push = b.t.pushes().last().cloned().unwrap();
    assert_eq!(push["changed"], json!(["overrides"]));
    assert_eq!(push["by"], json!("agent"));
    assert_eq!(
        push["summary"],
        json!(
            "Claude in sequence-head set who it is on, the next step, what it waits for, labels on !2"
        )
    );
    b.t.call("order", json!({"op": "undo", "version": b.t.last_undo()}))
        .await
        .unwrap();
    assert!(b.t.settings().await["overrides"].get(key(2)).is_none());
    let itself = b
        .tool(
            "reviews_override",
            json!({"request": "!2", "set": {"depends_on": ["!2"]}}),
            "Claude",
        )
        .await
        .unwrap_err();
    assert!(itself.message().contains("itself"), "{itself:?}");
    let whose = b
        .tool(
            "reviews_override",
            json!({"request": "!2", "set": {"whose": "two words"}}),
            "Claude",
        )
        .await
        .unwrap_err();
    assert!(whose.message().contains("whose"), "{whose:?}");
    let invalid = b
        .tool(
            "reviews_override",
            json!({"request": "!2", "nope": 1}),
            "Claude",
        )
        .await
        .unwrap_err();
    // The detail is typebox's first error, as roamgate-claude's checker says it.
    assert!(
        invalid
            .message()
            .starts_with("invalid reviews_override parameters: /"),
        "{}",
        invalid.message()
    );
    assert_eq!(invalid.code(), Some("invalid"));
    let unknown = b
        .tool("reviews_eat", json!({}), "Claude")
        .await
        .unwrap_err();
    assert_eq!(unknown.code(), Some("not_found"));
    assert!(
        unknown
            .message()
            .starts_with("unknown tool reviews_eat: effort_get, ")
    );
}

#[tokio::test]
async fn saved_views_and_filters_same_tokens_in_the_list_kept_and_undone() {
    let b = setup();
    let refs = |list: &Value| -> Vec<Value> {
        list["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["ref"].clone())
            .collect()
    };
    let filtered = data(
        &b.tool(
            "reviews_list",
            json!({"filter": "is:mine -label:audio"}),
            "Claude",
        )
        .await
        .unwrap(),
    );
    assert_eq!(refs(&filtered), vec![json!("g/p!2")]);
    let made = b
        .tool(
            "reviews_view",
            json!({"action": "create", "name": "Audio", "filter": "label:audio"}),
            "Claude",
        )
        .await
        .unwrap();
    assert_eq!(
        made,
        r#"{"changed":true,"views":[{"name":"Audio","query":"label:audio"}]}"#
    );
    let push = b.t.pushes().last().cloned().unwrap();
    assert_eq!(push["changed"], json!(["views"]));
    assert_eq!(push["summary"], json!("Claude saved the view Audio"));
    let by_view = data(
        &b.tool("reviews_list", json!({"filter": "view:audio"}), "Claude")
            .await
            .unwrap(),
    );
    assert_eq!(refs(&by_view), vec![json!("g/p!1")]);
    // The inbox carries the views for every page.
    let inbox =
        b.t.deps
            .inbox
            .get(crate::inbox::GetOptions {
                fresh: false,
                viewer: false,
            })
            .await;
    assert_eq!(
        inbox["views"],
        json!([{"name": "Audio", "query": "label:audio"}])
    );
    // A new query for the same name, then Undo: the old query is back.
    b.t.call(
        "view",
        json!({"action": "save", "name": "audio", "query": "label:audio is:mine", "by": "agent"}),
    )
    .await
    .unwrap();
    assert_eq!(
        b.t.settings().await["views"],
        json!([{"name": "Audio", "query": "label:audio is:mine"}])
    );
    b.t.call("order", json!({"op": "undo", "version": b.t.last_undo()}))
        .await
        .unwrap();
    assert_eq!(
        b.t.settings().await["views"],
        json!([{"name": "Audio", "query": "label:audio"}])
    );
    let bad =
        b.t.call(
            "view",
            json!({"action": "save", "name": "a:b", "query": "x"}),
        )
        .await
        .unwrap_err();
    assert!(bad.message().contains("name"), "{bad:?}");
    b.tool(
        "reviews_view",
        json!({"action": "delete", "name": "AUDIO"}),
        "Claude",
    )
    .await
    .unwrap();
    assert_eq!(b.t.settings().await["views"], json!([]));
    let gone = b
        .tool("reviews_list", json!({"filter": "view:audio"}), "Claude")
        .await
        .unwrap_err();
    assert!(gone.message().contains("No saved view"), "{gone:?}");
}

/// The board's side of "any agent session reaches the board through
/// roamgate-review": the session's name in what the user is told, the
/// list after the untrusted line, `help` with each tool's schema. The
/// socket command and the Python client are the review agent server's.
#[tokio::test]
async fn an_agent_session_s_calls_name_it_and_help_lists_the_tools() {
    let b = setup();
    let set: Value = serde_json::from_str(
        &b.tool(
            "reviews_override",
            json!({"request": "g/p!1", "set": {"next": "rerun the job"}}),
            "Codex in w9",
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(set["changed"], json!(true));
    assert_eq!(set["next"], json!("rerun the job"));
    assert_eq!(
        b.t.pushes().last().unwrap()["summary"],
        json!("Codex in w9 set the next step on !1")
    );
    let listed = b
        .tool(
            "reviews_list",
            json!({"section": "authored"}),
            "Claude in w9",
        )
        .await
        .unwrap();
    assert!(listed.starts_with(UNTRUSTED));
    let row = &data(&listed)["requests"][0];
    assert_eq!(row["ref"], json!("g/p!1"));
    assert_eq!(row["next"], json!("rerun the job"));
    assert_eq!(row["override"]["next"], json!("rerun the job"));
    assert_eq!(row["override"]["by"], json!("agent"));
    let help: Value = serde_json::from_str(&b.tool("help", json!({}), "x").await.unwrap()).unwrap();
    let tools = help["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "reviews_override"));
    let schema = &tools
        .iter()
        .find(|tool| tool["name"] == "reviews_override")
        .unwrap()["params"];
    assert_eq!(
        schema["properties"]["set"]["properties"]["whose"]["type"],
        json!("string")
    );
}

#[test]
fn the_tools_rows_carry_the_merge_state() {
    const DAY: f64 = 86_400_000.0;
    const HOUR: f64 = 3_600_000.0;
    let now = js::now_ms();
    let ago = |ms: f64| js::iso(now - ms);
    let merge = json!({
        "after": {
            "label": "merge after 1d",
            "delayMs": DAY,
            "delay": "1 day",
            "from": "update",
            "since": ago(DAY),
            "at": ago(0.0),
            "ready": true,
        },
        "bot": {
            "name": "marge-bot",
            "via": "assignee",
            "queued": false,
            "failed": {"reason": "CI failed!", "at": ago(HOUR)},
        },
    });
    assert_eq!(
        Value::Object(merge_fields(merge.as_object().unwrap())),
        json!({
            "after": {
                "label": "merge after 1d",
                "delay": "1 day",
                "from": "update",
                "since": ago(DAY),
                "mergeable_at": ago(0.0),
                "ready": true,
            },
            "bot": {
                "name": "marge-bot",
                "via": "assignee",
                "queued": false,
                "failed": {"reason": "CI failed!", "at": ago(HOUR)},
            },
        })
    );
}

#[test]
fn words_lines_and_matches_read_as_the_ts() {
    assert_eq!(words(Some("!12967, Foo  a #x")), vec!["12967", "foo"]);
    let item = item(5, json!({"files": ["src/Validate.c"], "draft": true}));
    let item = item.as_object().unwrap();
    let line = item_line(item, Obj::new());
    assert_eq!(
        js::stringify(&Value::Object(line)),
        format!(
            r#"{{"key":"{}","ref":"g/p!5","title":"MR 5","author":"me","state":"draft","updated":{},"pipeline":"success"}}"#,
            key(5),
            js::stringify(&item["updatedAt"])
        )
    );
    assert!(matches(item, &words(Some("validate")), &[]));
    assert!(matches(item, &words(Some("!5")), &[]));
    assert!(!matches(item, &words(Some("rtp")), &[]));
    assert!(matches(item, &words(Some("rtp")), &["RTP".into()]));
}

#[test]
fn group_paths_name_groups_and_workspaces_with_nodes_under_them() {
    let tree = json!({"version": 1, "nodes": [
        {"id": "g1", "kind": "group", "label": "Upstream", "parent": null},
        {"id": "g2", "kind": "group", "label": "Media", "parent": "g1"},
        {"id": "w1", "kind": "workspace", "parent": "g2", "ref": {"connection_id": "local", "label": "gst"}},
        {"id": "w2", "kind": "workspace", "parent": null, "ref": {"connection_id": "c2", "path": "/src/app"}},
        {"id": "w3", "kind": "workspace", "parent": "w2", "ref": {"connection_id": "c2", "label": "app-x"}},
    ]});
    let paths: Vec<(String, String, String, Option<String>)> =
        crate::workspace_tree::group_paths(&tree)
            .into_iter()
            .map(|each| {
                (
                    each.node,
                    each.kind,
                    each.names.join("/"),
                    each.connection_id,
                )
            })
            .collect();
    assert_eq!(
        paths,
        vec![
            ("g1".into(), "group".into(), "Upstream".into(), None),
            ("g2".into(), "group".into(), "Upstream/Media".into(), None),
            (
                "w2".into(),
                "workspace".into(),
                "app".into(),
                Some("c2".into())
            ),
        ]
    );
}
