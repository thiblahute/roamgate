//! The browser's review calls (server/src/review/rpc.test.ts).

use std::sync::{Arc, Mutex};

use roamgate_base::clock::TokioClock;
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::*;
use crate::model::{ReviewAnchor, ReviewComment, ReviewSession, ReviewThread};
use crate::service::ReviewServiceOptions;
use crate::service::host::{Ask, Load, LoadError, ReviewForge, ReviewHost};
use crate::storage::ReviewStorage;

/// A forge whose branch lookups must not run and finds nothing.
struct NoLookups;

impl ReviewForge for NoLookups {
    fn checkout(&self, _: &ReviewSession) -> Load<Value> {
        Box::pin(async {
            Err(LoadError::Failed(
                "the branch's own request is not looked up".into(),
            ))
        })
    }
    fn find(&self, _: &ReviewSession, _: Value) -> Ask<Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    fn read_merge_request(&self, _: &ReviewSession, _: &str) -> Ask<Value> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
    fn read_threads(&self, _: &ReviewSession, _: &Value) -> Ask<Vec<ReviewThread>> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
    fn create_draft_note(
        &self,
        _: &ReviewSession,
        _: &Value,
        _: ReviewAnchor,
        _: String,
        _: Option<Value>,
    ) -> Ask<ReviewThread> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
    fn update_draft_note(
        &self,
        _: &ReviewSession,
        _: &Value,
        _: i64,
        _: String,
    ) -> Ask<ReviewThread> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
    fn delete_draft_note(&self, _: &ReviewSession, _: &Value, _: i64) -> Ask<()> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
    fn create_draft_reply(
        &self,
        _: &ReviewSession,
        _: &Value,
        _: &str,
        _: String,
    ) -> Ask<ReviewComment> {
        Box::pin(async { Err("glab must not run".to_owned()) })
    }
}

#[derive(Default)]
struct Host {
    forge: bool,
}

impl ReviewHost for Host {
    fn load_diff(
        &self,
        _: &ReviewSession,
        _: Option<String>,
        _: Option<Vec<String>>,
    ) -> Load<Value> {
        Box::pin(async { Ok(json!({"files": [], "truncated": false})) })
    }
    fn forge(&self) -> Option<Arc<dyn ReviewForge>> {
        self.forge
            .then(|| Arc::new(NoLookups) as Arc<dyn ReviewForge>)
    }
}

fn service(dir: &std::path::Path, forge: bool) -> ReviewService {
    let storage = ReviewStorage::open(&DataContext::new(dir, Platform::Unix, None), dir).unwrap();
    ReviewService::new(ReviewServiceOptions {
        storage,
        publish: Arc::new(|_| {}),
        host: Arc::new(Host { forge }),
        clock: Arc::new(TokioClock::starting_at(1_767_182_400_000)),
        session_limit: None,
        retry_delay_ms: Some(10),
        delivery_delay_ms: Some(2500),
        agent_search_ms: Some(20),
    })
}

type Pages = Arc<Mutex<Vec<(String, Value, Option<String>)>>>;

/// A connection as the TS tests build them: its id, its workspace's root,
/// and what else a test gives it.
struct Connection {
    id: &'static str,
    root: &'static str,
    read_root: Option<Arc<Mutex<Vec<String>>>>,
    pages: Option<Pages>,
}

impl Connection {
    fn new(id: &'static str, root: &'static str) -> Self {
        Self {
            id,
            root,
            read_root: None,
            pages: None,
        }
    }
}

impl ReviewRpcConnection for Connection {
    fn id(&self) -> &str {
        self.id
    }
    fn resolve_root(&self, _: &str) -> RpcFut<String> {
        let root = self.root.to_owned();
        Box::pin(async move { Ok(root) })
    }
    fn can_read_root(&self) -> bool {
        self.read_root.is_some()
    }
    fn read_root(&self, path: &str) -> RpcFut<String> {
        if let Some(asked) = &self.read_root {
            asked.lock().unwrap().push(path.to_owned());
        }
        Box::pin(async { Ok("/repo".to_owned()) })
    }
    fn can_render_pages(&self) -> bool {
        self.pages.is_some()
    }
    fn rendered_page(
        &self,
        root: &str,
        target: &ReviewTarget,
        page: Option<String>,
        _: bool,
    ) -> RpcFut<Value> {
        if let Some(pages) = &self.pages {
            pages
                .lock()
                .unwrap()
                .push((root.to_owned(), target.to_value(), page));
        }
        Box::pin(async { Ok(json!({"src": "/rendered/x/index.html", "mode": "static"})) })
    }
}

async fn call(
    service: &ReviewService,
    connection: &Connection,
    method: &str,
    params: Value,
) -> ReviewResult<Value> {
    handle_review_rpc(
        service,
        connection,
        std::path::Path::new("/nonexistent"),
        method,
        &params,
    )
    .await
}

#[tokio::test]
async fn a_relative_path_is_refused_an_empty_one_is_the_workspace_s_own() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), false);
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut reading = Connection::new("local", "/repo");
    reading.read_root = Some(asked.clone());
    let refused = call(
        &service,
        &reading,
        "review.open",
        json!({"workspace_id": "w1", "path": "blog/public", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("must be absolute"), "{refused}");
    let opened = call(
        &service,
        &reading,
        "review.open",
        json!({"workspace_id": "w1", "path": "", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap();
    assert_eq!(opened["session"]["root"], "/repo");
    assert!(asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_review_is_invisible_from_another_connection() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), false);
    let local = Connection::new("local", "/repo");
    let remote = Connection::new("remote", "/srv/repo");
    let opened = call(
        &service,
        &local,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap();
    let refused = call(
        &service,
        &remote,
        "review.get",
        json!({"session_id": opened["session"]["id"]}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("no such review"));
    let listed = call(&service, &remote, "review.list", json!({}))
        .await
        .unwrap();
    assert_eq!(listed["sessions"], json!([]));
}

#[tokio::test]
async fn the_page_s_list_has_the_chats_so_their_threads_survive_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), false);
    let local = Connection::new("local", "/repo");
    call(
        &service,
        &local,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap();
    call(
        &service,
        &local,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "chat", "chat": "claude-session-1"}}),
    )
    .await
    .unwrap();
    let listed = call(&service, &local, "review.list", json!({}))
        .await
        .unwrap();
    let mut kinds: Vec<String> = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            each["session"]["target"]["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    kinds.sort();
    assert_eq!(kinds, ["chat", "worktree"]);
    // Agents listing the reviews of a checkout still do not see them.
    assert_eq!(service.list(&json!({"connectionId": "local"})).len(), 1);
}

#[tokio::test]
async fn the_merge_request_the_user_picked_opens_as_is_whatever_the_branch_s_lookup_finds() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), true);
    let local = Connection::new("local", "/repo");
    let opened = call(
        &service,
        &local,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap();
    let fork = "https://gitlab.example/fork/p/-/merge_requests/7";
    let picked = call(
        &service,
        &local,
        "review.gitlab.open",
        json!({"session_id": opened["session"]["id"], "url": fork}),
    )
    .await
    .unwrap();
    assert_eq!(picked["mergeRequest"]["url"], fork);
    assert_eq!(picked["mergeRequest"]["number"], 7);
    let session = &picked["snapshot"]["session"];
    assert_eq!(session["target"], json!({"kind": "mr", "url": fork}));
    assert_eq!(session["workspaceId"], "w1");
    assert_eq!(session["gitlab"], true);
    let refused = call(
        &service,
        &local,
        "review.gitlab.open",
        json!({
            "session_id": opened["session"]["id"],
            "url": "http://gitlab.example/fork/p/-/merge_requests/7",
        }),
    )
    .await
    .unwrap_err();
    assert!(
        refused.message.contains("invalid merge request URL"),
        "{refused}"
    );
}

#[tokio::test]
async fn a_rendered_review_s_page_comes_from_the_connection_only_for_its_own_reviews() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), false);
    let pages: Pages = Arc::default();
    let mut with_pages = Connection::new("local", "/repo");
    with_pages.pages = Some(pages.clone());
    let worktree = call(
        &service,
        &with_pages,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "worktree"}}),
    )
    .await
    .unwrap();
    let refused = call(
        &service,
        &with_pages,
        "review.rendered.page",
        json!({"session_id": worktree["session"]["id"]}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("not a rendered review"));
    let rendered = call(
        &service,
        &with_pages,
        "review.open",
        json!({"workspace_id": "w1", "target": {"kind": "rendered", "path": "docs/index.html"}}),
    )
    .await
    .unwrap();
    let id = rendered["session"]["id"].clone();
    assert_eq!(
        call(
            &service,
            &with_pages,
            "review.rendered.page",
            json!({"session_id": id, "page": "other.html"}),
        )
        .await
        .unwrap(),
        json!({"src": "/rendered/x/index.html", "mode": "static"})
    );
    assert_eq!(
        *pages.lock().unwrap(),
        [(
            "/repo".to_owned(),
            json!({"kind": "rendered", "path": "docs/index.html"}),
            Some("other.html".to_owned()),
        )]
    );
    let mut remote = Connection::new("remote", "/srv/repo");
    remote.pages = Some(pages.clone());
    let refused = call(
        &service,
        &remote,
        "review.rendered.page",
        json!({"session_id": id}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("no such review"));
    let refused = call(
        &service,
        &with_pages,
        "review.rendered.page",
        json!({"session_id": id, "page": 5}),
    )
    .await
    .unwrap_err();
    assert!(refused.message.contains("invalid page"));
}

#[test]
fn storage_writes_are_checked_as_the_page_s_are() {
    assert_eq!(
        parse_storage_write(Some(&json!({"op": "clear", "key": 1}))),
        Some(json!({"op": "clear"}))
    );
    assert_eq!(
        parse_storage_write(Some(&json!({"op": "set", "key": "k", "value": "v"}))),
        Some(json!({"op": "set", "key": "k", "value": "v"}))
    );
    assert_eq!(
        parse_storage_write(Some(&json!({"op": "set", "key": "k"}))),
        None
    );
    assert_eq!(
        parse_storage_write(Some(&json!({"op": "remove", "key": ""}))),
        None
    );
    assert_eq!(parse_storage_write(None), None);
}

#[test]
fn pasted_images_decode_as_node_reads_base64() {
    assert_eq!(decode_base64("aGk="), b"hi");
    assert_eq!(decode_base64("aGk"), b"hi");
    assert_eq!(decode_base64("aG\nk=junk"), b"hi");
    assert_eq!(decode_base64("_-8"), vec![0xff, 0xef]);
}
