//! `mr-reviews/module.test.ts`, `panel.test.ts`, the rows of
//! `upstream.test.ts` and `effort-service.test.ts` that go through the
//! whole module: [`MrReviews`] over a store and a settings.json of their
//! own, fake connections or the git fixture's.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::{DataContext, Platform};
use roamgate_base::settings::SettingsStore;
use serde_json::{Value, json};

use super::*;
use crate::connection::fixture::{FORGE_HOST, GitFixture, Workspace};
use crate::connection::{MrConnection, ShellResult};
use crate::inbox::GetOptions;
use crate::inbox::test_support::FnFetchers;
use crate::store::state_path;

fn obj(value: Value) -> Obj {
    match value {
        Value::Object(map) => map,
        _ => Obj::new(),
    }
}

/// settings.json as a test gives it: read as given, written in memory.
struct MemorySettings(Mutex<Value>);

impl MemorySettings {
    fn new(value: Value) -> Arc<MemorySettings> {
        Arc::new(MemorySettings(Mutex::new(value)))
    }
}

impl SettingsFile for MemorySettings {
    fn read(&self) -> BoxFuture<'_, Result<Value, String>> {
        let value = self.0.lock().unwrap().clone();
        Box::pin(async move { Ok(value) })
    }

    fn update_mr_reviews(&self, change: MrReviewsChange) -> BoxFuture<'_, Result<Obj, String>> {
        let mut value = self.0.lock().unwrap();
        let next = change(value.get("mr_reviews").and_then(Value::as_object));
        value["mr_reviews"] = Value::Object(next.clone());
        Box::pin(async move { Ok(next) })
    }
}

struct Setup {
    dir: tempfile::TempDir,
    store: Arc<Mutex<MrStore>>,
}

fn setup() -> Setup {
    let dir = tempfile::Builder::new()
        .prefix("mr-mod-")
        .tempdir_in("/tmp")
        .unwrap();
    let context = DataContext::new(dir.path(), Platform::current(), None);
    let path = state_path(&context.data_root());
    let store = Arc::new(Mutex::new(MrStore::open(context, path)));
    Setup { dir, store }
}

impl Setup {
    fn context(&self) -> DataContext {
        DataContext::new(self.dir.path(), Platform::current(), None)
    }

    fn update(&self, change: impl FnOnce(&mut Obj)) {
        self.store.lock().unwrap().update(change).unwrap();
    }

    fn state(&self) -> Obj {
        self.store.lock().unwrap().get().clone()
    }

    fn options(&self, settings: Arc<dyn SettingsFile>) -> MrReviewsOptions {
        MrReviewsOptions::new(
            self.context(),
            self.store.clone(),
            settings,
            Arc::new(FnFetchers::default()),
        )
    }

    /// A settings.json of its own, in the test's directory.
    fn settings_file(&self) -> (Arc<SettingsStore>, std::path::PathBuf) {
        let path = self.dir.path().join("settings.json");
        (Arc::new(SettingsStore::new(&path)), path)
    }
}

fn set(state: &mut Obj, name: &str, key: &str, value: Value) {
    let records = state
        .entry(name.to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .unwrap();
    records.insert(key.to_owned(), value);
}

type Herdr = Arc<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;

/// A connection whose scripts and Herdr calls are closures.
struct FnConnection {
    id: String,
    label: String,
    run: Arc<dyn Fn(&str) -> ShellResult + Send + Sync>,
    herdr: Herdr,
}

impl MrConnection for FnConnection {
    fn id(&self) -> &str {
        &self.id
    }
    fn label(&self) -> &str {
        &self.label
    }
    fn run<'a>(&'a self, script: &'a str, _: u64) -> BoxFuture<'a, ShellResult> {
        let result = (self.run)(script);
        Box::pin(async move { result })
    }
    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, String>> {
        let answer = (self.herdr)(method, &params);
        Box::pin(async move { answer })
    }
}

fn connections(list: Vec<Arc<dyn MrConnection>>) -> ConnectionsFn {
    Arc::new(move || list.clone())
}

fn pushes_into(pushes: &Arc<Mutex<Vec<Obj>>>) -> PublishFn {
    let pushes = pushes.clone();
    Arc::new(move |push: Obj| pushes.lock().unwrap().push(push))
}

fn params(value: Value) -> Obj {
    obj(value)
}

#[tokio::test]
async fn a_closed_request_s_review_is_dropped_after_the_retention_days() {
    let t = setup();
    let old = js::iso(js::now_ms() - 4.0 * 86_400_000.0);
    let recent = js::iso(js::now_ms() - 86_400_000.0);
    t.update(|state| {
        set(
            state,
            "reviews",
            "a",
            json!({"connectionId": "c", "sessionId": "sa", "closedAt": old}),
        );
        set(
            state,
            "reviews",
            "b",
            json!({"connectionId": "c", "sessionId": "sb", "closedAt": recent}),
        );
        set(
            state,
            "reviews",
            "c",
            json!({"connectionId": "c", "sessionId": "sc"}),
        );
        set(
            state,
            "seen",
            "a",
            json!({"at": old, "updatedAt": old, "headSha": "x", "notes": 0}),
        );
        set(
            state,
            "projects",
            "p",
            json!({"connectionId": "c", "clone": "/x", "worktree": "/x.worktrees/review"}),
        );
    });
    let removed: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut options = t.options(MemorySettings::new(
        json!({"mr_reviews": {"retention_days": 3}}),
    ));
    options.remove_review = Some({
        let removed = removed.clone();
        Arc::new(move |id: String| removed.lock().unwrap().push(id))
    });
    let reviews = MrReviews::new(options);
    reviews.lifecycle().await;
    assert_eq!(*removed.lock().unwrap(), vec!["sa".to_owned()]);
    let state = t.state();
    let mut kept: Vec<&String> = state["reviews"].as_object().unwrap().keys().collect();
    kept.sort();
    assert_eq!(kept, vec!["b", "c"]);
    assert!(state["seen"].get("a").is_none());
    // The project's review worktree stays.
    assert!(state["projects"].get("p").is_some());
}

#[tokio::test]
async fn forgetting_a_review_worktree_keeps_the_reviews_and_their_claude_sessions() {
    let t = setup();
    t.update(|state| {
        set(
            state,
            "projects",
            "h/g/p",
            json!({"connectionId": "local", "clone": "/x", "worktree": "/x.worktrees/review"}),
        );
        set(
            state,
            "reviews",
            "gitlab:h/g/p#1",
            json!({"connectionId": "local", "sessionId": "s", "claudeSession": "c"}),
        );
        set(state, "prefetched", "gitlab:h/g/p#1", json!("abc"));
    });
    let reviews = MrReviews::new(t.options(MemorySettings::new(json!({}))));
    let result = reviews
        .handle(
            "bridge.mr_reviews.forget_worktree",
            &params(json!({"project": "H/G/P"})),
        )
        .await
        .unwrap();
    assert_eq!(
        result["forgotten"]["worktree"],
        json!("/x.worktrees/review")
    );
    let state = t.state();
    assert_eq!(state["projects"], json!({}));
    assert_eq!(state["prefetched"], json!({}));
    assert_eq!(
        state["reviews"]["gitlab:h/g/p#1"]["claudeSession"],
        json!("c")
    );
    let error = reviews
        .handle(
            "bridge.mr_reviews.forget_worktree",
            &params(json!({"project": "h/g/p"})),
        )
        .await
        .unwrap_err();
    assert!(error.message().contains("no review worktree"), "{error:?}");
}

#[tokio::test]
async fn the_review_pane_s_agent_review_with_no_agent_pane_the_request_s_claude_starts_and_reviews()
{
    let t = setup();
    t.update(|state| {
        state.insert(
            "items".into(),
            json!([{
                "provider": "gitlab", "host": "h", "project": "g/p", "number": 1,
                "key": "gitlab:h/g/p#1", "url": "https://h/g/p/-/merge_requests/1",
                "title": "t", "author": "a", "draft": false, "state": "open",
                "updatedAt": "2026-11-04T00:00:00Z", "headSha": "a".repeat(40),
                "sourceBranch": "x", "targetBranch": "main", "pipeline": null,
                "notes": 0, "reasons": ["assigned"],
            }]),
        );
        set(state, "projects", "h/g/p", json!({"connectionId": "c", "clone": "/x", "worktree": "/x.worktrees/review", "workspaceId": "w1"}));
        set(state, "reviews", "gitlab:h/g/p#1", json!({"connectionId": "c", "sessionId": "rev1", "workspaceId": "w1"}));
    });
    let pane_agent: Arc<Mutex<Option<String>>> = Arc::default();
    let typed: Arc<Mutex<Vec<String>>> = Arc::default();
    let asked: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let session = regex::Regex::new(r"--session-id ([0-9a-f-]{36})").unwrap();
    let herdr: Herdr = {
        let pane_agent = pane_agent.clone();
        let typed = typed.clone();
        Arc::new(move |method: &str, params: &Value| match method {
            "pane.list" => Ok(json!({"panes": [{"pane_id": "w1:p1", "workspace_id": "w1"}]})),
            "agent.get" => match pane_agent.lock().unwrap().clone() {
                None => Err("agent_not_found".into()),
                Some(id) => Ok(
                    json!({"agent": {"agent": "claude", "agent_status": "idle", "agent_session": {"value": id}}}),
                ),
            },
            "pane.send_text" => {
                let text = js::sv(params.get("text")).to_owned();
                *pane_agent.lock().unwrap() = session.captures(&text).map(|c| c[1].to_owned());
                typed.lock().unwrap().push(text);
                Ok(json!({}))
            }
            _ => Ok(json!({})),
        })
    };
    let conn: Arc<dyn MrConnection> = Arc::new(FnConnection {
        id: "c".into(),
        label: "C".into(),
        run: Arc::new(|_| ShellResult::default()),
        herdr,
    });
    let mut options = t.options(MemorySettings::new(
        json!({"claude_start_mode": "conversation"}),
    ));
    options.connections = connections(vec![conn]);
    options.request_review = Some({
        let asked = asked.clone();
        Arc::new(move |params: Obj| {
            asked.lock().unwrap().push(params);
            Box::pin(async { Ok(()) })
        })
    });
    let reviews = MrReviews::new(options);
    // The workspace's pane is a bare shell: no agent pane.
    let state = reviews
        .handle(
            "bridge.mr_reviews.claude",
            &params(json!({"session_id": "rev1", "action": "review"})),
        )
        .await
        .unwrap();
    assert_eq!(state["state"], json!("ready"));
    // Started in the claude start setting's mode (conversation: no opt-out).
    let typed = typed.lock().unwrap().clone();
    assert_eq!(typed.len(), 1);
    assert!(!typed[0].contains("ROAMGATE_CLAUDE_START=terminal"));
    assert_eq!(
        *asked.lock().unwrap(),
        vec![obj(json!({"sessionId": "rev1", "paneId": "w1:p1"}))]
    );
}

#[tokio::test]
async fn the_sidebar_learns_each_review_workspace_and_the_request_it_is_on() {
    let t = setup();
    t.update(|state| {
        state.insert(
            "items".into(),
            json!([{
                "provider": "gitlab", "host": "h", "project": "g/p", "number": 12846, "key": "k",
                "url": "https://h/g/p/-/merge_requests/12846", "title": "pitch: Predictable output",
                "author": "a", "draft": false, "state": "open", "updatedAt": "t",
                "headSha": "a".repeat(40), "sourceBranch": "x", "targetBranch": "main",
                "pipeline": null, "notes": 0, "reasons": [],
            }]),
        );
        set(state, "projects", "h/g/p", json!({"connectionId": "desktop", "clone": "/x", "worktree": "/x.worktrees/review", "workspaceId": "w7", "checkedOut": "k"}));
    });
    let reviews = MrReviews::new(t.options(MemorySettings::new(json!({}))));
    assert_eq!(
        reviews
            .handle("bridge.mr_reviews.workspaces", &Obj::new())
            .await
            .unwrap(),
        json!({"workspaces": [{
            "connectionId": "desktop",
            "workspaceId": "w7",
            "project": "h/g/p",
            "current": {
                "key": "k",
                "label": "!12846 pitch: Predictable output",
                "url": "https://h/g/p/-/merge_requests/12846",
            },
        }]})
    );
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn the_panel_s_search_and_filter_kept_in_settings_json_pushed_to_every_page_read_back_with_the_inbox_no_new_version()
 {
    let t = setup();
    let (file, path) = t.settings_file();
    let pushes: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let mut options = t.options(file);
    options.publish = Some(pushes_into(&pushes));
    let reviews = MrReviews::new(options);
    let before = order_version(&reviews.settings().await);
    let first = reviews
        .handle(
            "bridge.mr_reviews.panel",
            &params(json!({"search": "project:gstreamer/*"})),
        )
        .await
        .unwrap();
    assert_eq!(first["panel"]["search"], json!("project:gstreamer/*"));
    assert_eq!(first["panel"]["filter"], json!("all"));
    let second = reviews
        .handle(
            "bridge.mr_reviews.panel",
            &params(json!({"filter": "review"})),
        )
        .await
        .unwrap();
    assert_eq!(second["panel"]["search"], json!("project:gstreamer/*"));
    assert_eq!(second["panel"]["filter"], json!("review"));
    assert!(js::sv(second["panel"].get("at")) > js::sv(first["panel"].get("at")));
    let pushes = pushes.lock().unwrap().clone();
    assert_eq!(
        pushes
            .iter()
            .map(|push| push["changed"].clone())
            .collect::<Vec<_>>(),
        vec![json!(["panel"]), json!(["panel"])]
    );
    assert!(pushes.iter().all(|push| push["version"] == json!(before)));
    let stored = read_json(&path);
    assert_eq!(stored["mr_reviews"]["panel"], second["panel"]);
    assert_eq!(
        js::num(stored["mr_reviews"].get("order_version")).unwrap_or(0.0),
        before as f64
    );
    // What another device reads with the inbox.
    assert_eq!(
        reviews.inbox().snapshot(&reviews.settings().await)["panel"],
        second["panel"]
    );
    // A filter it does not know: everything.
    reviews
        .handle(
            "bridge.mr_reviews.panel",
            &params(json!({"filter": "<bad>"})),
        )
        .await
        .unwrap();
    assert_eq!(reviews.settings().await["panel"]["filter"], json!("all"));
    let error = reviews
        .handle("bridge.mr_reviews.panel", &Obj::new())
        .await
        .unwrap_err();
    assert_eq!(error.message(), "search or filter is required");
    // The home prompt is a setting of its own.
    reviews
        .handle(
            "bridge.mr_reviews.settings.update",
            &params(json!({"settings": {"homePrompt": "Review {url}"}})),
        )
        .await
        .unwrap();
    let settings = reviews.settings().await;
    assert_eq!(settings["homePrompt"], json!("Review {url}"));
    assert_eq!(settings["panel"]["search"], json!("project:gstreamer/*"));
    reviews.stop();
}

#[tokio::test]
async fn a_request_s_recorded_home_is_linked_as_its_home_open_with_a_home_shows_the_review_there() {
    let t = setup();
    let (file, _) = t.settings_file();
    let request = json!({
        "provider": "gitlab", "host": "gitlab.example.org", "project": "g/app", "number": 7,
        "key": "gitlab:gitlab.example.org/g/app#7",
        "url": "https://gitlab.example.org/g/app/-/merge_requests/7", "title": "Fix it",
        "author": "bob", "draft": false, "state": "open", "updatedAt": js::iso(js::now_ms()),
        "headSha": "abc", "sourceBranch": "fix-it", "targetBranch": "main", "pipeline": null,
        "notes": 0, "reasons": ["review_requested"],
    });
    let key = js::sv(request.get("key")).to_owned();
    t.update(|state| {
        state.insert("items".into(), json!([request]));
        set(state, "homes", &key, json!({"connectionId": "local", "workspaceId": "w-home", "path": "/w/home", "branch": "fix-it", "at": js::iso(js::now_ms())}));
    });
    let conn: Arc<dyn MrConnection> = Arc::new(FnConnection {
        id: "local".into(),
        label: "Desktop".into(),
        run: Arc::new(|script: &str| {
            if script.contains("--show-toplevel") {
                ShellResult {
                    code: 0,
                    stdout: "T\t/w/home\n".into(),
                    stderr: String::new(),
                }
            } else {
                ShellResult::default()
            }
        }),
        herdr: Arc::new(|method: &str, _: &Value| {
            Ok(if method == "workspace.list" {
                json!({"workspaces": [{"workspace_id": "w-home", "label": "something", "cwd": "/w/home"}]})
            } else {
                json!({"panes": []})
            })
        }),
    });
    let opened: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let mut options = t.options(file);
    options.connections = connections(vec![conn]);
    options.open_review = Some({
        let opened = opened.clone();
        Arc::new(move |params: Obj| {
            opened.lock().unwrap().push(params);
            Box::pin(async { Ok(json!({"session": {"id": "rs"}})) })
        })
    });
    let reviews = MrReviews::new(options);
    let links = reviews
        .handle("bridge.mr_reviews.links", &params(json!({"keys": [key]})))
        .await
        .unwrap();
    let found = links["links"][&key].as_array().unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["workspaceId"], json!("w-home"));
    assert_eq!(found[0]["why"], json!(["home"]));
    let shown = reviews
        .handle(
            "bridge.mr_reviews.open",
            &params(
                json!({"key": key, "home": {"connection_id": "local", "workspace_id": "w-home"}}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(shown["workspaceId"], json!("w-home"));
    assert_eq!(shown["sessionId"], json!("rs"));
    let opened = opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["workspaceId"], json!("w-home"));
    assert_eq!(opened[0]["root"], json!("/w/home"));
    assert_eq!(t.state()["homes"][&key]["sessionId"], json!("rs"));
    let error = reviews
        .handle(
            "bridge.mr_reviews.open",
            &params(json!({"key": key, "home": {"connection_id": "local"}})),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .message()
            .contains("connection_id and workspace_id are required")
    );
    reviews.stop();
}

#[tokio::test]
async fn export_and_import_through_the_panel_a_preview_first_applied_with_a_push() {
    let t = setup();
    let (file, _) = t.settings_file();
    file.update(|current| {
        current.with(
            "mr_reviews",
            Some(json!({
                "hosts": [{"host": FORGE_HOST, "provider": "gitlab"}],
                "views": [{"name": "media", "query": "project:media/*"}],
            })),
        )
    })
    .await
    .unwrap();
    let pushes: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let mut options = t.options(file);
    options.publish = Some(pushes_into(&pushes));
    options.efforts_dir = Some(t.dir.path().join("efforts"));
    let reviews = MrReviews::new(options);
    let text = reviews
        .handle("bridge.mr_reviews.export", &Obj::new())
        .await
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned();
    // The hosts list, followed projects and hints too (D30).
    let exported: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        exported["mr_reviews"],
        json!({
            "followed": [],
            "hints": "",
            "hosts": [{"host": FORGE_HOST, "provider": "gitlab"}],
            "views": [{"name": "media", "query": "project:media/*"}],
        })
    );
    let changed = text.replace("project:media/*", "project:media/gst");
    let preview = reviews
        .handle(
            "bridge.mr_reviews.import",
            &params(json!({"text": changed})),
        )
        .await
        .unwrap();
    assert_eq!(
        preview,
        json!({"applied": false, "changes": [{"path": "mr_reviews.views[media]", "kind": "changed"}]})
    );
    assert_eq!(
        reviews.settings().await["views"][0]["query"],
        json!("project:media/*")
    );
    reviews
        .handle(
            "bridge.mr_reviews.import",
            &params(json!({"text": changed, "apply": true})),
        )
        .await
        .unwrap();
    assert_eq!(
        reviews.settings().await["views"][0]["query"],
        json!("project:media/gst")
    );
    let last = pushes.lock().unwrap().last().cloned().unwrap();
    assert!(
        last["changed"]
            .as_array()
            .unwrap()
            .contains(&json!("views"))
    );
    let error = reviews
        .handle("bridge.mr_reviews.import", &params(json!({"text": "{}"})))
        .await
        .unwrap_err();
    assert!(
        error.message().contains("not a Reviews export"),
        "{error:?}"
    );
}

fn p(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// A Workspaces tree with these nodes.
fn tree_of(nodes: Value) -> TreeAccess {
    let tree = json!({"version": 1, "nodes": nodes});
    TreeAccess {
        read: Arc::new(move || {
            let tree = tree.clone();
            Box::pin(async move { Ok(tree) })
        }),
        apply: Arc::new(|_| Box::pin(async { Ok(()) })),
    }
}

async fn tool(reviews: &MrReviews, name: &str, params: Value, caller: &str) -> RpcResult<Value> {
    reviews
        .board_tool(name, &params, caller)
        .await
        .map(|text| serde_json::from_str(&text).unwrap())
}

const NOT_VIEWER: GetOptions = GetOptions {
    fresh: false,
    viewer: false,
};
const VIEWER: GetOptions = GetOptions {
    fresh: false,
    viewer: true,
};

async fn entries(reviews: &MrReviews) -> Vec<Obj> {
    records(reviews.inbox().get(NOT_VIEWER).await.get("entries"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_workspace_headed_upstream_by_itself_marked_listed_an_effort_s_home_exported_unmarked() {
    let t = setup();
    let g = GitFixture::new();
    g.project("media/engine");
    let clone = g.clone("media/engine", "solo");
    g.git(&clone, &["checkout", "-q", "-b", "solo-work"]);
    g.commit(&clone, "a.c", "a\n", "Solo change", None);
    let connection: Arc<dyn MrConnection> = Arc::new(g.connection(
        vec![Workspace {
            workspace_id: "w1".into(),
            label: "solo".into(),
            cwd: p(&clone),
        }],
        "local",
    ));
    let (file, _) = t.settings_file();
    file.update(|current| {
        current.with(
            "mr_reviews",
            Some(json!({"hosts": [{"host": FORGE_HOST, "provider": "gitlab"}]})),
        )
    })
    .await
    .unwrap();
    let pushes: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let mut options = t.options(file);
    options.connections = connections(vec![connection]);
    // The workspace has no node of the tree; a group elsewhere.
    options.tree = Some(tree_of(
        json!([{"id": "g1", "kind": "group", "parent": null, "label": "Upstream"}]),
    ));
    options.publish = Some(pushes_into(&pushes));
    options.efforts_dir = Some(t.dir.path().join("efforts"));
    let reviews = MrReviews::new(options);
    // As the page names it: Herdr gives this workspace no folder of its own.
    let reference = json!({"connection_id": "local", "label": "solo", "workspace_id": "w1"});
    let key = format!("branch:gitlab:{FORGE_HOST}/media/engine@solo-work");
    // A tool finds it without a node of the tree, by its checkout or its
    // name, and marks it as the page does.
    assert_eq!(
        tool(
            &reviews,
            "upstream_workspace",
            json!({"workspace": p(&clone), "headed": true}),
            "Claude"
        )
        .await
        .unwrap(),
        json!({"changed": true, "workspace": "solo", "headed": true})
    );
    assert_eq!(
        reviews.settings().await["upstreamWorkspaces"],
        json!([reference])
    );
    tool(
        &reviews,
        "upstream_workspace",
        json!({"workspace": "SOLO", "headed": false}),
        "Claude",
    )
    .await
    .unwrap();
    assert_eq!(reviews.settings().await["upstreamWorkspaces"], json!([]));
    let error = tool(
        &reviews,
        "upstream_workspace",
        json!({"workspace": "nowhere", "headed": true}),
        "Claude",
    )
    .await
    .unwrap_err();
    assert!(
        error.message().contains("No workspace is \"nowhere\""),
        "{error:?}"
    );
    let marked = reviews
        .handle(
            "bridge.mr_reviews.upstream.workspace",
            &params(json!({"ref": reference, "headed": true})),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            marked["ok"].clone(),
            marked["headed"].clone(),
            marked["changed"].clone()
        ),
        (json!(true), json!(true), json!(true))
    );
    assert_eq!(
        pushes.lock().unwrap().last().unwrap()["changed"],
        json!(["upstream"])
    );
    assert_eq!(
        reviews
            .handle("bridge.mr_reviews.upstream.marks", &Obj::new())
            .await
            .unwrap(),
        json!({"groups": [], "skip": [], "workspaces": [reference]})
    );
    assert_eq!(reviews.settings().await["upstreamSkip"], json!([]));
    reviews.inbox().get(VIEWER).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    reviews.upstream().refresh(true).await;
    let shown = reviews.inbox().get(NOT_VIEWER).await;
    assert_eq!(shown["upstreamWorkspaces"], json!([reference]));
    let row = records(shown.get("entries"))
        .into_iter()
        .find(|entry| key_of(entry) == key)
        .expect("the branch's row");
    assert_eq!(row["lane"], json!("not_sent"));
    assert_eq!(row["branch"]["name"], json!("solo-work"));
    assert_eq!(row["branch"]["workspaceLabel"], json!("solo"));
    // Its home is the workspace: declared from its menu, or by a tool by name.
    let home = upstream_workspace_home(&obj(reference.clone()));
    let preview = tool(
        &reviews,
        "effort_set",
        json!({"group": "solo", "source": "refs/heads/solo-work", "preview": true}),
        "Claude",
    )
    .await
    .unwrap();
    assert_eq!(preview["effort"]["group"], json!(home));
    assert_eq!(preview["effort"]["name"], json!("solo"));
    // Or by its checkout, which the mark does not carry.
    let by_path = tool(
        &reviews,
        "effort_set",
        json!({"group": p(&clone), "source": "solo-work", "preview": true}),
        "Claude",
    )
    .await
    .unwrap();
    assert_eq!(by_path["effort"]["group"], json!(home));
    assert_eq!(by_path["effort"]["source"], json!("refs/heads/solo-work"));
    let declared = reviews
        .handle(
            "bridge.mr_reviews.effort.set",
            &params(json!({"group": home, "source": "refs/heads/solo-work"})),
        )
        .await
        .unwrap();
    assert_eq!(declared["effort"]["group"], json!(home));
    assert_eq!(declared["effort"]["name"], json!("solo"));
    assert_eq!(
        declared["effort"]["clone"],
        json!({"connectionId": "local", "path": p(&clone)})
    );
    // Exported with the rest.
    let text = reviews
        .handle("bridge.mr_reviews.export", &Obj::new())
        .await
        .unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned();
    let exported: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(exported["version"], json!(3));
    assert_eq!(
        exported["mr_reviews"]["upstream_workspaces"],
        json!([reference])
    );
    // Unmarked: no row; never a skip.
    let unmarked = reviews
        .handle(
            "bridge.mr_reviews.upstream.workspace",
            &params(json!({"ref": reference, "headed": false})),
        )
        .await
        .unwrap();
    assert_eq!(unmarked["changed"], json!(true));
    let after = reviews.settings().await;
    assert_eq!(after["upstreamWorkspaces"], json!([]));
    assert_eq!(after["upstreamSkip"], json!([]));
    reviews.upstream().refresh(true).await;
    assert!(
        !entries(&reviews)
            .await
            .iter()
            .any(|entry| key_of(entry) == key)
    );
    reviews.stop();
}

fn own(n: u64, extra: Value) -> Value {
    let mut item = obj(json!({
        "provider": "gitlab", "host": FORGE_HOST, "project": "media/engine", "number": n,
        "key": format!("gitlab:{FORGE_HOST}/media/engine#{n}"),
        "url": format!("https://{FORGE_HOST}/media/engine/-/merge_requests/{n}"),
        "title": format!("MR {n}"), "author": "me", "draft": false, "state": "open",
        "updatedAt": js::iso(js::now_ms()), "headSha": "", "sourceBranch": format!("b{n}"),
        "targetBranch": "main", "pipeline": "success", "notes": 0, "reasons": ["authored"],
    }));
    for (key, value) in obj(extra) {
        item.insert(key, value);
    }
    Value::Object(item)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn branch_rows_lane_not_proposed_yet_overrides_and_the_request_s_key_once_it_opens() {
    let t = setup();
    let g = GitFixture::new();
    g.project("media/engine");
    let clone = g.clone("media/engine", "engine");
    g.git(&clone, &["checkout", "-q", "-b", "pool-rework"]);
    g.commit(&clone, "a.c", "a\n", "Rework the buffer pool", None);
    g.commit(&clone, "b.c", "b\n", "Use the new pool", None);
    let outside = g.clone("media/engine", "outside");
    g.git(&outside, &["checkout", "-q", "-b", "elsewhere"]);
    g.commit(&outside, "c.c", "c\n", "Not headed upstream", None);
    let connection: Arc<dyn MrConnection> = Arc::new(g.connection(
        vec![
            Workspace {
                workspace_id: "w1".into(),
                label: "pool rework".into(),
                cwd: p(&clone),
            },
            Workspace {
                workspace_id: "w2".into(),
                label: "outside".into(),
                cwd: p(&outside),
            },
        ],
        "local",
    ));
    let tree = tree_of(json!([
        {"id": "g1", "kind": "group", "parent": null, "label": "Upstream"},
        {"id": "g2", "kind": "group", "parent": "g1", "label": "Media"},
        {"id": "g3", "kind": "group", "parent": null, "label": "Other"},
        {"id": "n1", "kind": "workspace", "parent": "g2", "ref": {"connection_id": "local", "label": "pool rework"}},
        {"id": "n2", "kind": "workspace", "parent": "g3", "ref": {"connection_id": "local", "label": "outside"}},
    ]));
    let (file, _) = t.settings_file();
    file.update(|current| {
        current.with(
            "mr_reviews",
            Some(json!({
                "hosts": [{"host": FORGE_HOST, "provider": "gitlab"}],
                "upstream_groups": ["g1"],
            })),
        )
    })
    .await
    .unwrap();
    let other = own(40, json!({"sourceBranch": "other"}));
    t.update(|state| {
        state.insert("items".into(), json!([other]));
    });
    let pushes: Arc<Mutex<Vec<Obj>>> = Arc::default();
    let mut options = t.options(file);
    options.connections = connections(vec![connection]);
    options.tree = Some(tree);
    options.publish = Some(pushes_into(&pushes));
    let reviews = MrReviews::new(options);
    reviews.inbox().get(VIEWER).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    reviews.upstream().refresh(false).await;
    let key = format!("branch:gitlab:{FORGE_HOST}/media/engine@pool-rework");
    let row = entries(&reviews)
        .await
        .into_iter()
        .find(|entry| key_of(entry) == key)
        .expect("the branch's row");
    assert_eq!(row["title"], json!("Rework the buffer pool"));
    assert_eq!(row["section"], json!("authored"));
    assert_eq!(row["lane"], json!("not_sent"));
    assert_eq!(row["next"]["text"], json!("Propose 2 commits upstream"));
    assert_eq!(row["next"]["from"], json!("rule"));
    let branch = &row["branch"];
    assert_eq!(
        [
            &branch["name"],
            &branch["workspaceLabel"],
            &branch["target"],
            &branch["ahead"],
            &branch["behind"],
            &branch["dirty"]
        ],
        [
            &json!("pool-rework"),
            &json!("pool rework"),
            &json!("origin/main"),
            &json!(2),
            &json!(0),
            &json!(0)
        ]
    );
    assert!(
        !entries(&reviews)
            .await
            .iter()
            .any(|entry| entry["title"] == json!("Not headed upstream"))
    );
    // Its workspace is its link.
    let links = reviews
        .handle("bridge.mr_reviews.links", &params(json!({"keys": [key]})))
        .await
        .unwrap();
    assert_eq!(
        links["links"][&key],
        json!([{"connectionId": "local", "connectionLabel": "Desktop", "workspaceId": "w1", "label": "pool rework", "why": ["branch"]}])
    );
    // Not proposed yet, with a title; something set by hand; a place.
    let unsent = tool(
        &reviews,
        "upstream_unsent",
        json!({"branch": "pool-rework", "unsent": true, "title": "Rework the pool"}),
        "Claude in lead",
    )
    .await
    .unwrap();
    assert_eq!(
        (
            unsent["changed"].clone(),
            unsent["key"].clone(),
            unsent["unsent"].clone()
        ),
        (json!(true), json!(key), json!(true))
    );
    assert_eq!(
        pushes.lock().unwrap().last().unwrap()["summary"],
        json!("Claude in lead made pool-rework a request not proposed yet")
    );
    // The workspace skipped: no row; back: the row again.
    tool(
        &reviews,
        "upstream_workspace",
        json!({"workspace": p(&clone), "headed": false}),
        "Claude",
    )
    .await
    .unwrap();
    reviews.upstream().refresh(true).await;
    assert!(
        !entries(&reviews)
            .await
            .iter()
            .any(|entry| key_of(entry) == key)
    );
    tool(
        &reviews,
        "upstream_workspace",
        json!({"workspace": "pool rework", "headed": true}),
        "Claude",
    )
    .await
    .unwrap();
    reviews.upstream().refresh(true).await;
    reviews
        .handle(
            "bridge.mr_reviews.override",
            &params(json!({"key": key, "set": {"labels": ["pool"]}})),
        )
        .await
        .unwrap();
    reviews
        .handle(
            "bridge.mr_reviews.order",
            &params(json!({"op": "top", "keys": [key]})),
        )
        .await
        .unwrap();
    let unsent = entries(&reviews)
        .await
        .into_iter()
        .find(|entry| key_of(entry) == key)
        .unwrap();
    assert_eq!(unsent["unsent"], json!(true));
    assert_eq!(unsent["title"], json!("Rework the pool"));
    assert_eq!(
        unsent["next"]["text"],
        json!("Open the request (2 commits)")
    );
    assert!(pushes.lock().unwrap().iter().any(|push| {
        push["changed"]
            .as_array()
            .unwrap()
            .contains(&json!("unsent"))
    }));
    // The request opens: it takes the branch's place and what was set.
    let request = own(41, json!({"sourceBranch": "pool-rework"}));
    let (other_key, request_key) = (other["key"].clone(), request["key"].clone());
    t.update(|state| {
        state.insert("items".into(), json!([other, request]));
    });
    reviews.upstream().refresh(true).await;
    reviews.rekey_branches().await;
    let settings = reviews.settings().await;
    assert_eq!(settings["unsent"], json!([]));
    assert_eq!(
        settings["order"].as_array().unwrap()[..2],
        [request_key.clone(), other_key]
    );
    assert_eq!(
        settings["overrides"][request_key.as_str().unwrap()]["labels"],
        json!(["pool"])
    );
    assert!(settings["overrides"].get(&key).is_none());
    let after = entries(&reviews).await;
    assert!(!after.iter().any(|entry| key_of(entry) == key));
    assert_eq!(
        after
            .iter()
            .find(|entry| entry["key"] == request_key)
            .unwrap()["fromBranch"],
        json!("pool-rework")
    );
    // The group unmarked: no branch rows.
    let error = tool(
        &reviews,
        "upstream_group",
        json!({"group": "Nope", "headed": false}),
        "Claude",
    )
    .await
    .unwrap_err();
    assert!(error.message().contains("Upstream/Media"), "{error:?}");
    tool(
        &reviews,
        "upstream_group",
        json!({"group": "Upstream", "headed": false}),
        "Claude",
    )
    .await
    .unwrap();
    let last = pushes.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last["changed"], json!(["upstream"]));
    assert_eq!(
        last["summary"],
        json!("Claude unmarked Upstream as headed upstream")
    );
    t.update(|state| {
        state.insert("items".into(), json!([]));
    });
    assert!(
        !entries(&reviews)
            .await
            .iter()
            .any(|entry| entry.get("branch").is_some_and(|b| !b.is_null()))
    );
    reviews.stop();
}
