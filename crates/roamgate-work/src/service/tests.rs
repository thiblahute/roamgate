//! server/src/work/service.test.ts, ported. The review service is a fake
//! with what the board asks of it (the TS file's fakeReviews); the tests
//! that drive the real review service in TS check here what the board
//! hands it (threads, authors, anchors) and where its comments go
//! (`owner_pane`): delivery and its prompts are the review service's,
//! ported with it (S19).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::model::By;
use crate::rpc::{handle_work_rpc, is_work_method};
use crate::store::{NoHistory, StoreWrites, WorkStore};
use crate::tools::{WORK_USER_TOOLS, work_tool, work_user_tool};
use roamgate_base::clock::TokioClock;
use roamgate_base::paths::{DataContext, Platform};

type GitFn = dyn Fn(&str, &[String], Option<&str>) -> GitRead + Send + Sync;
type ReadFn = dyn Fn(&str, &str, Option<&str>) -> Option<String> + Send + Sync;

/// An in-memory review store with what the board asks of it.
#[derive(Default)]
struct FakeReviews {
    /// Sessions in order: (session, threads).
    sessions: Mutex<Vec<(Value, Vec<Value>)>>,
    added: Mutex<Vec<(String, String, String)>>,
    images: Mutex<Vec<(String, String, usize)>>,
    next: Mutex<u64>,
}

impl FakeReviews {
    fn id(&self) -> String {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        format!("{:016x}", *next)
    }

    fn snapshot(session: &Value, threads: &[Value]) -> ReviewSnapshot {
        ReviewSnapshot::from_value(json!({"session": session, "threads": threads})).unwrap()
    }

    fn find_now(&self, item: &str) -> Option<ReviewSnapshot> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(session, _)| session["target"] == json!({"kind": "work", "item": item}))
            .map(|(session, threads)| Self::snapshot(session, threads))
    }

    fn set(&self, snapshot: Value) {
        let mut sessions = self.sessions.lock().unwrap();
        let id = snapshot["session"]["id"].clone();
        sessions.retain(|(session, _)| session["id"] != id);
        sessions.push((
            snapshot["session"].clone(),
            snapshot["threads"].as_array().cloned().unwrap_or_default(),
        ));
    }

    fn threads_of(&self, session_id: &str) -> Vec<Value> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(session, _)| session["id"] == session_id)
            .map(|(_, threads)| threads.clone())
            .unwrap_or_default()
    }

    fn add(&self, session_id: &str, author: &str, text: &str, anchor: Value) -> ReviewThread {
        self.added
            .lock()
            .unwrap()
            .push((session_id.into(), author.into(), text.into()));
        let thread = json!({
            "id": self.id(),
            "sessionId": session_id,
            "kind": "discussion",
            "anchor": anchor,
            "comments": [{
                "id": self.id(),
                "author": author,
                "body": text,
                "createdAt": "2026-11-20T10:01:00.000Z",
                "updatedAt": "2026-11-20T10:01:00.000Z",
            }],
            "resolved": false,
            "createdAt": "2026-11-20T10:01:00.000Z",
            "updatedAt": "2026-11-20T10:01:00.000Z",
        });
        let mut sessions = self.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(session, _)| session["id"] == session_id)
            .expect("the session");
        threads.push(thread.clone());
        ReviewThread::from_value(thread).unwrap()
    }

    fn last_added(&self) -> (String, String, String) {
        self.added.lock().unwrap().last().cloned().unwrap()
    }
}

fn ready<T: Send + 'static>(value: T) -> BoxFuture<'static, T> {
    Box::pin(async move { value })
}

impl WorkReviews for FakeReviews {
    fn find(&self, item: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>> {
        ready(Ok(self.find_now(item)))
    }

    fn open(
        &self,
        item: &str,
        connection_id: &str,
        root: &str,
        title: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewSnapshot>> {
        if let Some(found) = self.find_now(item) {
            return ready(Ok(found));
        }
        let session = json!({
            "id": self.id(),
            "connectionId": connection_id,
            "root": root,
            "title": title,
            "target": {"kind": "work", "item": item},
        });
        self.sessions
            .lock()
            .unwrap()
            .push((session.clone(), Vec::new()));
        ready(Ok(Self::snapshot(&session, &[])))
    }

    fn get(&self, review: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>> {
        let found = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .find(|(session, _)| session["id"].as_str().unwrap_or("").starts_with(review))
            .map(|(session, threads)| Self::snapshot(session, threads));
        ready(Ok(found))
    }

    fn session_of_comment(&self, id: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSession>>> {
        let found =
            self.sessions
                .lock()
                .unwrap()
                .iter()
                .find_map(|(session, threads)| {
                    threads
                        .iter()
                        .any(|thread| {
                            thread["id"].as_str().unwrap_or("").starts_with(id)
                                || thread["comments"].as_array().into_iter().flatten().any(
                                    |comment| comment["id"].as_str().unwrap_or("").starts_with(id),
                                )
                        })
                        .then(|| ReviewSession::from_value(session.clone()).unwrap())
                });
        ready(Ok(found))
    }

    fn add_thread(
        &self,
        session_id: &str,
        author: &str,
        text: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        ready(Ok(self.add(session_id, author, text, anchor)))
    }

    fn move_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let mut sessions = self.sessions.lock().unwrap();
        let mut moved = None;
        for (_, threads) in sessions.iter_mut() {
            if let Some(at) = threads
                .iter()
                .position(|thread| thread["id"].as_str().unwrap_or("").starts_with(thread_id))
            {
                let mut thread = threads.remove(at);
                thread["sessionId"] = json!(session_id);
                thread["anchor"] = anchor.clone();
                moved = Some(thread);
                break;
            }
        }
        let Some(thread) = moved else {
            return ready(Err(WorkError::other("no such thread")));
        };
        let (_, threads) = sessions
            .iter_mut()
            .find(|(session, _)| session["id"] == session_id)
            .expect("the session");
        threads.push(thread.clone());
        ready(Ok(ReviewThread::from_value(thread).unwrap()))
    }

    fn set_anchor(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let mut sessions = self.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(session, _)| session["id"] == session_id)
            .expect("the session");
        let thread = threads
            .iter_mut()
            .find(|thread| thread["id"] == thread_id)
            .expect("the thread");
        thread["anchor"] = anchor;
        ready(Ok(ReviewThread::from_value(thread.clone()).unwrap()))
    }

    fn add_image(
        &self,
        session_id: &str,
        kind: &str,
        data: Vec<u8>,
    ) -> BoxFuture<'_, WorkResult<String>> {
        let mut images = self.images.lock().unwrap();
        images.push((session_id.into(), kind.into(), data.len()));
        ready(Ok(format!("/images/{session_id}/{}.png", images.len())))
    }

    // As the review service: only the comment's author rewrites or deletes.
    fn edit_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
        text: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>> {
        let mut sessions = self.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(session, _)| session["id"] == session_id)
            .expect("the session");
        for thread in threads.iter_mut() {
            let Some(comment) = thread["comments"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|comment| comment["id"] == comment_id)
            else {
                continue;
            };
            if comment["author"] != author {
                return ready(Err(WorkError::other(
                    "an agent can only edit its own comments",
                )));
            }
            comment["body"] = json!(text);
            return ready(Ok(ReviewThread::from_value(thread.clone()).unwrap()));
        }
        ready(Err(WorkError::other("no such comment")))
    }

    fn delete_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
    ) -> BoxFuture<'_, WorkResult<(String, Option<ReviewThread>)>> {
        let mut sessions = self.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(session, _)| session["id"] == session_id)
            .expect("the session");
        for at in 0..threads.len() {
            let comments = threads[at]["comments"].as_array().unwrap().clone();
            let Some(index) = comments
                .iter()
                .position(|comment| comment["id"] == comment_id)
            else {
                continue;
            };
            if comments[index]["author"] != author {
                return ready(Err(WorkError::other(
                    "an agent can only delete its own comments",
                )));
            }
            if index == 0 {
                let thread = threads.remove(at);
                return ready(Ok((thread["id"].as_str().unwrap().into(), None)));
            }
            threads[at]["comments"]
                .as_array_mut()
                .unwrap()
                .remove(index);
            return ready(Ok((
                comment_id.into(),
                Some(ReviewThread::from_value(threads[at].clone()).unwrap()),
            )));
        }
        ready(Err(WorkError::other("no such comment")))
    }
}

/// What the board asks of the server, faked; what it told, kept.
#[derive(Default)]
struct Fake {
    reviews: Option<Arc<FakeReviews>>,
    pushes: Mutex<Vec<WorkPush>>,
    notified: Mutex<Vec<String>>,
    cleared: Mutex<Vec<String>>,
    git: Option<Box<GitFn>>,
    read_file: Option<Box<ReadFn>>,
    sessions: Option<Vec<String>>,
    deployed: Mutex<Option<String>>,
    panes: Option<Mutex<Vec<Pane>>>,
    /// The panes are asked and never answer.
    panes_hang: bool,
    workspaces: Option<Vec<Workspace>>,
    generation: Option<u64>,
}

impl WorkDeps for Fake {
    fn publish(&self, push: WorkPush) {
        self.pushes.lock().unwrap().push(push);
    }
    fn reviews(&self) -> Option<&dyn WorkReviews> {
        self.reviews
            .as_deref()
            .map(|reviews| reviews as &dyn WorkReviews)
    }
    fn notify(&self, item: &WorkItem, publish: bool) {
        if publish {
            self.notified.lock().unwrap().push(item.id.clone());
        } else {
            self.cleared.lock().unwrap().push(item.id.clone());
        }
    }
    fn has_git(&self) -> bool {
        self.git.is_some()
    }
    fn git<'a>(
        &'a self,
        root: &'a str,
        args: Vec<String>,
        connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, GitRead> {
        let read = self
            .git
            .as_ref()
            .map(|git| git(root, &args, connection_id))
            .unwrap_or_default();
        ready(read)
    }
    fn has_read_file(&self) -> bool {
        self.read_file.is_some()
    }
    fn read_file<'a>(
        &'a self,
        root: &'a str,
        path: &'a str,
        connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        let read = self
            .read_file
            .as_ref()
            .and_then(|read| read(root, path, connection_id));
        ready(read)
    }
    fn sessions(&self) -> Option<BoxFuture<'_, WorkResult<Vec<String>>>> {
        self.sessions.clone().map(|sessions| ready(Ok(sessions)))
    }
    fn deployed(&self) -> Option<String> {
        self.deployed.lock().unwrap().clone()
    }
    fn own_root(&self) -> Option<String> {
        Some("/home/me/roamgate".into())
    }
    fn default_connection(&self) -> BoxFuture<'_, Option<String>> {
        ready(Some("desktop".into()))
    }
    fn has_places(&self) -> bool {
        self.panes.is_some() || self.panes_hang
    }
    fn panes<'a>(&'a self, _connection_id: &'a str) -> BoxFuture<'a, Result<Vec<Pane>, String>> {
        if self.panes_hang {
            return Box::pin(std::future::pending());
        }
        ready(Ok(self
            .panes
            .as_ref()
            .map(|panes| panes.lock().unwrap().clone())
            .unwrap_or_default()))
    }
    fn workspaces<'a>(
        &'a self,
        _connection_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Workspace>, String>> {
        ready(Ok(self.workspaces.clone().unwrap_or_default()))
    }
    fn generation<'a>(&'a self, _connection_id: &'a str) -> BoxFuture<'a, Option<u64>> {
        ready(self.generation)
    }
}

fn pane(id: &str, workspace: Option<&str>, cwd: Option<&str>) -> Pane {
    Pane {
        pane_id: id.into(),
        workspace_id: workspace.map(str::to_owned),
        cwd: cwd.map(str::to_owned),
        foreground_cwd: None,
    }
}

struct Kit {
    service: WorkService,
    fake: Arc<Fake>,
    reviews: Arc<FakeReviews>,
    dir: tempfile::TempDir,
}

impl Kit {
    fn pushes(&self) -> Vec<WorkPush> {
        self.fake.pushes.lock().unwrap().clone()
    }
    fn item(&self, id: &str) -> WorkItem {
        self.service.read(|store| store.item(id).cloned()).unwrap()
    }
}

fn store_at(dir: &std::path::Path) -> WorkStore {
    WorkStore::open(
        dir,
        StoreWrites::Disk {
            context: DataContext::new(dir, Platform::current(), None),
            can_write: None,
        },
        Arc::new(NoHistory),
        Arc::new(|| "2026-11-20T10:00:00.000Z".into()),
    )
}

/// 2026-11-20T10:00:00Z.
const EPOCH: i64 = 1_763_632_800_000;

fn setup_with(build: impl FnOnce(&mut Fake)) -> Kit {
    let reviews = Arc::new(FakeReviews::default());
    let mut fake = Fake {
        reviews: Some(reviews.clone()),
        ..Fake::default()
    };
    build(&mut fake);
    let fake = Arc::new(fake);
    let dir = tempfile::tempdir().unwrap();
    let service = WorkService::new(
        store_at(dir.path()),
        fake.clone(),
        Arc::new(TokioClock::starting_at(EPOCH)),
    );
    Kit {
        service,
        fake,
        reviews,
        dir,
    }
}

fn setup() -> Kit {
    setup_with(|_| {})
}

fn p(value: Value) -> Params {
    value.as_object().cloned().unwrap()
}

fn user() -> WorkMeta {
    WorkMeta::user()
}

fn agent(caller: Option<&str>, address: Option<&str>) -> WorkMeta {
    WorkMeta {
        by: By::Agent,
        caller: caller.map(str::to_owned),
        address: address.map(str::to_owned),
        summary: None,
    }
}

fn links(item: &WorkItem) -> Value {
    json!(item.links)
}

fn answer_json(answer: &str) -> Value {
    serde_json::from_str(answer.split_once('\n').unwrap().1).unwrap()
}

async fn tool(
    kit: &Kit,
    name: &str,
    params: Value,
    caller: &str,
    address: Option<&str>,
) -> WorkResult<Value> {
    work_tool(&kit.service, name, &params, caller, address, By::Agent)
        .await
        .map(|answer| answer_json(&answer))
}

fn has_ws_tag(item: &WorkItem) -> bool {
    item.tags.iter().any(|tag| tag.starts_with("ws:"))
}

/// A TODO file's review with one thread, as the coordinator kept them.
fn todo_review(resolved: bool) -> Value {
    json!({
        "session": {
            "id": "d22a2f86bc540f34",
            "connectionId": "desktop",
            "root": "/home/me/roamgate.worktrees",
            "title": "Roamgate TODO",
            "target": {"kind": "rendered", "path": "plans/todo.md"},
        },
        "threads": [{
            "id": "b057f8a2129c74bc",
            "sessionId": "d22a2f86bc540f34",
            "kind": "discussion",
            "anchor": {
                "path": "plans/todo.md",
                "line": 14,
                "text": "## Reviews and Files",
                "render": {"quote": "Reviews and Files"},
            },
            "comments": [
                {"id": "c1c1c1c1c1c1c1c1", "author": "you", "body": "**doing** Fold a reviewed chunk again\n\nDetails here.", "createdAt": "2026-11-20T09:01:00.000Z"},
                {"id": "c2c2c2c2c2c2c2c2", "author": "Claude", "body": "Taken.", "createdAt": "2026-11-20T09:02:00.000Z"},
            ],
            "resolved": resolved,
            "createdAt": "2026-11-20T09:01:00.000Z",
            "updatedAt": "2026-11-20T09:02:00.000Z",
        }],
    })
}

#[tokio::test(start_paused = true)]
async fn seeds_the_roamgate_project_and_adds_moves_finishes_and_reopens_items() {
    let kit = setup();
    let service = &kit.service;
    let board = service.board().await.unwrap();
    assert_eq!(board["projects"][0]["id"], "roamgate");
    assert_eq!(board["projects"][0]["done"], json!({"kind": "deployed"}));
    let item = service
        .add(
            &p(json!({"title": "  Fix the keys  ", "tags": ["Reviews"], "owner": "desktop/w35:p1"})),
            &agent(Some("Claude in roamgate"), None),
        )
        .await
        .unwrap();
    assert_eq!(item.state, "open");
    assert_eq!(item.tags, ["reviews"]);
    assert_eq!(item.owner.as_ref().unwrap().session, "desktop/w35:p1");
    let summary = kit
        .pushes()
        .into_iter()
        .find(|push| push.summary.is_some())
        .unwrap();
    assert_eq!(summary.changed, ["items"]);
    assert_eq!(
        summary.summary.as_deref(),
        Some("Claude in roamgate added \"Fix the keys\"")
    );
    assert!(kit.fake.notified.lock().unwrap().is_empty());
    let for_you = service
        .update(
            &p(json!({"item": item.id, "state": "you", "ask": "Try the keys on the phone."})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(for_you.state, "you");
    assert_eq!(
        *kit.fake.notified.lock().unwrap(),
        std::slice::from_ref(&item.id)
    );
    let doing = service
        .update(
            &p(json!({"item": &item.id[..8], "state": "doing", "add_tags": ["phone"]})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(doing.tags, ["reviews", "phone"]);
    assert_eq!(
        *kit.fake.cleared.lock().unwrap(),
        std::slice::from_ref(&item.id)
    );
    service
        .update(&p(json!({"item": item.id, "state": "you"})), &user())
        .await
        .unwrap();
    assert_eq!(kit.fake.notified.lock().unwrap().len(), 2);
    let done = service
        .done(
            &p(json!({"item": item.id, "landed": {"commit": "abcdef1234", "subject": "Fix the keys"}})),
            &agent(None, None),
        )
        .unwrap();
    assert_eq!(done.state, "done");
    assert!(done.done_at.is_some());
    assert_eq!(
        links(&done),
        json!([{"kind": "commit", "sha": "abcdef1234", "subject": "Fix the keys"}])
    );
    let back = service
        .reopen(&p(json!({"item": item.id, "state": "verify"})), &user())
        .await
        .unwrap();
    assert_eq!(back.state, "verify");
    assert_eq!(back.done_at, None);
    assert!(
        service
            .reopen(&p(json!({"item": item.id, "state": "done"})), &user())
            .await
            .is_err()
    );
    assert!(
        service
            .update(&p(json!({"item": "ffffffff", "state": "open"})), &user())
            .await
            .unwrap_err()
            .message
            .contains("no work item")
    );
    let ids = |items: Vec<WorkItem>| items.into_iter().map(|item| item.id).collect::<Vec<_>>();
    assert_eq!(
        ids(service.list(&p(json!({"open": true})), None).await.unwrap()),
        std::slice::from_ref(&item.id)
    );
    assert_eq!(
        ids(service
            .list(&p(json!({"tags": ["phone"]})), None)
            .await
            .unwrap()),
        std::slice::from_ref(&item.id)
    );
    assert!(
        service
            .list(&p(json!({"tags": ["voice"]})), None)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(start_paused = true)]
async fn an_import_keeps_its_dates_and_its_source_and_the_same_source_changes_the_item() {
    let kit = setup();
    let service = &kit.service;
    let source = "imported from plans/todo.md line 107";
    let first = service
        .add(
            &p(json!({
                "title": "Headset muting after each turn", "state": "done", "tags": ["voice"],
                "source": source, "created_at": "2026-11-19T08:00:00Z", "done_at": "2026-11-19T18:30:00.000Z",
            })),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(first.created_at, "2026-11-19T08:00:00.000Z");
    assert_eq!(first.done_at.as_deref(), Some("2026-11-19T18:30:00.000Z"));
    assert_eq!(first.source.as_deref(), Some(source));
    let again = service
        .add_or_update(
            &p(json!({
                "title": "Headset muting after each turn", "state": "done", "tags": ["voice", "calls"],
                "text": "A description the item already has", "source": source, "created_at": "2026-11-19T08:00:00Z",
            })),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(again.item.id, first.id);
    assert!(again.updated);
    assert_eq!(json!(again.changed), json!({"tags": ["voice", "calls"]}));
    assert_eq!(again.ignored, Some(vec!["text".to_owned()]));
    assert_eq!(
        again.item.done_at.as_deref(),
        Some("2026-11-19T18:30:00.000Z")
    );
    let refused = service
        .add(
            &p(json!({"title": "Headset (boom mic) muting after each turn", "source": source})),
            &agent(None, None),
        )
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("exists in roamgate: ")
            && refused.message.contains("replace: true")
    );
    assert_eq!(kit.item(&first.id).title, "Headset muting after each turn");
    let retitled = service
        .add_or_update(
            &p(json!({"title": "Headset (boom mic) muting after each turn", "source": source, "replace": true})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(
        json!(retitled.changed),
        json!({"title": "Headset (boom mic) muting after each turn"})
    );
    assert_eq!(retitled.item.tags, ["voice", "calls"]);
    let same = service
        .add_or_update(
            &p(json!({"title": "Headset (boom mic) muting after each turn", "source": source})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert!(same.updated);
    assert_eq!(json!(same.changed), json!({}));
    service
        .project_set(&p(json!({"name": "gst2", "roots": ["/g"]})), &user())
        .await
        .unwrap();
    let other = service
        .add(
            &p(json!({"project": "gst2", "title": "Other", "source": source})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_ne!(other.id, first.id);
    assert!(
        service
            .add(
                &p(json!({"title": "x", "created_at": "yesterday"})),
                &user()
            )
            .await
            .unwrap_err()
            .message
            .contains("created_at")
    );
}

#[tokio::test(start_paused = true)]
async fn declares_a_project_with_a_branch_rule_and_scopes_items_to_it() {
    let kit = setup();
    let service = &kit.service;
    let project = service
        .project_set(
            &p(json!({
                "name": "gst2",
                "roots": ["/home/me/gstreamer/2.0", {"connectionId": "desktop", "path": "/home/me/gstreamer/2.0/gstreamer"}],
                "done": {"kind": "branch", "root": "/home/me/gstreamer/2.0/gstreamer", "branch": "main"},
                "tags": ["rfc-0052"],
            })),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(project.id, "gst2");
    assert_eq!(
        json!(project.done),
        json!({"kind": "branch", "root": "/home/me/gstreamer/2.0/gstreamer", "branch": "main", "connectionId": "desktop"})
    );
    let item = service
        .add(
            &p(json!({"project": "gst2", "title": "Phase 6", "links": [{"kind": "branch", "name": "task/p6"}]})),
            &user(),
        )
        .await
        .unwrap();
    assert!(
        service
            .list(&p(json!({"project": "roamgate"})), None)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        service
            .list(&p(json!({"project": "gst2"})), None)
            .await
            .unwrap()[0]
            .id,
        item.id
    );
    assert!(
        service
            .add(&p(json!({"project": "nope", "title": "x"})), &user())
            .await
            .unwrap_err()
            .message
            .contains("no project nope")
    );
}

#[tokio::test(start_paused = true)]
async fn the_done_rule_a_commit_on_the_deployed_build_finishes_the_item_a_rebased_one_by_its_subject()
 {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let seen = calls.clone();
    let kit = setup_with(move |fake| {
        fake.git = Some(Box::new(move |root, args, _| {
            let mut call = vec![root.to_owned()];
            call.extend(args.iter().cloned());
            seen.lock().unwrap().push(call);
            if args[0] == "merge-base" {
                return GitRead {
                    code: Some(if args[2].starts_with("aaaa") { 0 } else { 128 }),
                    stdout: String::new(),
                };
            }
            if args[0] == "log" && args.iter().any(|a| a == "--grep=Rebased fix") {
                return GitRead {
                    code: Some(0),
                    stdout: format!("{}\n", "c".repeat(40)),
                };
            }
            GitRead {
                code: Some(0),
                stdout: String::new(),
            }
        }));
    });
    let service = &kit.service;
    let landed = service
        .add(
            &p(json!({"title": "Landed", "state": "verify", "links": [{"kind": "commit", "sha": "aaaa1111"}]})),
            &user(),
        )
        .await
        .unwrap();
    let rebased = service
        .add(
            &p(json!({"title": "Rebased", "state": "doing", "links": [{"kind": "commit", "sha": "bbbb2222", "subject": "Rebased fix"}]})),
            &user(),
        )
        .await
        .unwrap();
    let unrelated = service
        .add(
            &p(json!({"title": "No commit", "links": [{"kind": "pr", "url": "https://x/1"}]})),
            &user(),
        )
        .await
        .unwrap();
    let lost = service
        .add(
            &p(json!({"title": "Lost", "links": [{"kind": "commit", "sha": "dddd3333"}]})),
            &user(),
        )
        .await
        .unwrap();
    service.link_roots_filled().await;
    assert_eq!(
        service.check().await.unwrap(),
        WorkChecked {
            landed: vec![],
            recorded: vec![],
            checked: 3
        }
    );
    let deployed = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    *kit.fake.deployed.lock().unwrap() = Some(deployed.into());
    let result = service.check().await.unwrap();
    assert_eq!(result.landed, std::slice::from_ref(&rebased.id));
    assert_eq!(result.recorded, std::slice::from_ref(&landed.id));
    let now = kit.item(&landed.id);
    assert_eq!(now.state, "verify");
    assert_eq!(now.done_at, None);
    assert_eq!(
        links(&now),
        json!([{"kind": "commit", "sha": "aaaa1111", "root": "/home/me/roamgate"}, {"kind": "deploy", "sha": deployed}])
    );
    assert_eq!(kit.item(&rebased.id).state, "done");
    assert_eq!(kit.item(&unrelated.id).state, "open");
    assert_eq!(kit.item(&lost.id).state, "open");
    let summaries: Vec<String> = kit
        .pushes()
        .into_iter()
        .filter_map(|push| push.summary)
        .filter(|summary| summary.contains("landed"))
        .collect();
    assert_eq!(
        summaries,
        [
            "Landed landed (landed aaaa1111aa), still to verify",
            "Rebased landed (landed aaaa1111aa)"
        ]
    );
    *kit.fake.deployed.lock().unwrap() = Some("eeee1111eeee1111eeee1111eeee1111eeee1111".into());
    assert!(service.check().await.unwrap().recorded.is_empty());
    assert_eq!(kit.item(&landed.id).links.len(), 2);
    assert!(
        calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call[0] == "/home/me/roamgate" && call[1] == "merge-base")
    );
}

#[tokio::test(start_paused = true)]
async fn a_commit_or_branch_link_opens_in_the_checkout_that_holds_it_its_root_else_the_project_s_roots_else_a_plain_error()
 {
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = calls.clone();
    let kit = setup_with(move |fake| {
        fake.git = Some(Box::new(move |root, args, _| {
            seen.lock().unwrap().push(args.join(" "));
            let held: &[&str] = match root {
                "/g/2.0/gstreamer" => &["refs:feature"],
                "/g/gstreamer2.worktrees/caps" => &["abcd1234"],
                _ => &[],
            };
            let code = if args[0] == "cat-file" {
                if held
                    .iter()
                    .any(|sha| args[2] == format!("{sha}^{{commit}}"))
                {
                    0
                } else {
                    128
                }
            } else if args[0] == "rev-parse" && args[1] == "--verify" {
                let name = args[3].replace("^{commit}", "");
                if held.contains(&format!("refs:{name}").as_str()) {
                    0
                } else {
                    1
                }
            } else {
                1
            };
            GitRead {
                code: Some(code),
                stdout: String::new(),
            }
        }));
    });
    let service = &kit.service;
    service
        .project_set(
            &p(json!({
                "name": "gst2",
                "roots": [
                    {"connectionId": "desktop", "path": "/g/2.0/gstreamer"},
                    {"connectionId": "desktop", "path": "/g/gstreamer2.worktrees/caps"},
                    {"connectionId": "desktop", "path": "/g/not-a-repo"},
                ],
                "done": {"kind": "branch", "root": "/g/2.0/gstreamer", "branch": "main"},
            })),
            &user(),
        )
        .await
        .unwrap();
    let item = service
        .add(
            &p(
                json!({"project": "gst2", "title": "Caps", "state": "doing", "links": [
                    {"kind": "commit", "sha": "abcd1234", "subject": "caps: fix"},
                    {"kind": "branch", "name": "feature"},
                    {"kind": "commit", "sha": "eeee9999"},
                ]}),
            ),
            &agent(None, None),
        )
        .await
        .unwrap();
    service.link_roots_filled().await;
    assert_eq!(
        links(&kit.item(&item.id)),
        json!([
            {"kind": "commit", "sha": "abcd1234", "subject": "caps: fix", "root": "/g/gstreamer2.worktrees/caps"},
            {"kind": "branch", "name": "feature", "root": "/g/2.0/gstreamer"},
            {"kind": "commit", "sha": "eeee9999"},
        ])
    );
    let lookups = |calls: &Arc<Mutex<Vec<String>>>| {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| *call == "cat-file -e eeee9999^{commit}")
            .count()
    };
    assert_eq!(lookups(&calls), 3);
    service
        .update(
            &p(json!({"item": item.id, "add_tags": ["x"]})),
            &agent(None, None),
        )
        .await
        .unwrap();
    service.link_roots_filled().await;
    assert_eq!(lookups(&calls), 3);
    let target = |link: Value| {
        let params = p(json!({"item": item.id, "link": link}));
        async move {
            service
                .link_target(&params)
                .await
                .map(|target| target.to_json())
        }
    };
    let caps = json!({"connectionId": "desktop", "root": "/g/gstreamer2.worktrees/caps"});
    assert_eq!(
        target(json!(kit.item(&item.id).links[0])).await.unwrap(),
        caps
    );
    assert_eq!(
        target(json!({"kind": "commit", "sha": "abcd1234"}))
            .await
            .unwrap(),
        caps
    );
    assert_eq!(
        target(json!({"kind": "deploy", "sha": "abcd1234", "branch": "main"}))
            .await
            .unwrap(),
        caps
    );
    assert_eq!(
        target(json!({"kind": "branch", "name": "feature"}))
            .await
            .unwrap(),
        json!({"connectionId": "desktop", "root": "/g/2.0/gstreamer"})
    );
    assert_eq!(
        target(json!({"kind": "commit", "sha": "eeee9999"}))
            .await
            .unwrap_err()
            .message,
        "This commit is not in any of the project's repositories"
    );
    assert_eq!(
        target(json!({"kind": "branch", "name": "gone"}))
            .await
            .unwrap_err()
            .message,
        "The branch gone is not in any of the project's repositories"
    );
    assert!(
        target(json!({"kind": "pr", "url": "https://x/1"}))
            .await
            .unwrap_err()
            .message
            .contains("only commit, branch and landing links")
    );
    assert_eq!(
        handle_work_rpc(
            service,
            "bridge.work.link_target",
            &p(json!({"item": item.id, "link": {"kind": "branch", "name": "feature"}}))
        )
        .await
        .unwrap(),
        json!({"target": {"connectionId": "desktop", "root": "/g/2.0/gstreamer"}})
    );
}

#[tokio::test(start_paused = true)]
async fn a_file_link_gets_the_project_s_checkout_that_has_it_and_opens_there_on_its_connection() {
    let reads: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = reads.clone();
    let kit = setup_with(move |fake| {
        fake.read_file = Some(Box::new(move |root, path, connection| {
            seen.lock()
                .unwrap()
                .push(format!("{}:{root}/{path}", connection.unwrap_or("")));
            (root == "/g/meta" && path == "plans/agent-prompts.md").then(|| "# Plan".to_owned())
        }));
    });
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "gst2", "roots": [
                {"connectionId": "desktop", "path": "/g/2.0/gstreamer"},
                {"connectionId": "mac", "path": "/g/meta"},
            ], "done": {"kind": "deployed"}})),
            &user(),
        )
        .await
        .unwrap();
    let item = service
        .add(
            &p(json!({"project": "gst2", "title": "Prompts", "links": [
                {"kind": "file", "path": "plans/agent-prompts.md", "line": 4},
                {"kind": "file", "path": "plans/gone.md"},
                {"kind": "file", "path": "/g/2.0/gstreamer/README.md"},
            ]})),
            &agent(None, None),
        )
        .await
        .unwrap();
    service.link_roots_filled().await;
    let now = kit.item(&item.id);
    assert_eq!(
        links(&now),
        json!([
            {"kind": "file", "path": "plans/agent-prompts.md", "root": "/g/meta", "line": 4},
            {"kind": "file", "path": "plans/gone.md"},
            {"kind": "file", "path": "/g/2.0/gstreamer/README.md"},
        ])
    );
    assert!(
        reads
            .lock()
            .unwrap()
            .contains(&"mac:/g/meta/plans/agent-prompts.md".to_owned())
    );
    let target = |index: usize| {
        let params = p(json!({"item": item.id, "link": now.links[index]}));
        async move { service.link_target(&params).await.unwrap().to_json() }
    };
    assert_eq!(
        target(0).await,
        json!({"connectionId": "mac", "root": "/g/meta", "path": "plans/agent-prompts.md"})
    );
    assert_eq!(
        target(1).await,
        json!({"connectionId": "desktop", "root": "/g/2.0/gstreamer", "path": "plans/gone.md"})
    );
    assert_eq!(
        target(2).await,
        json!({"connectionId": "desktop", "root": "/g/2.0/gstreamer", "path": "/g/2.0/gstreamer/README.md"})
    );
}

#[tokio::test(start_paused = true)]
async fn existing_items_commit_links_without_a_root_get_one_when_the_service_starts_the_deployed_rule_this_roamgate_s_checkout()
 {
    let dir = tempfile::tempdir().unwrap();
    let clock: SharedClock = Arc::new(TokioClock::starting_at(EPOCH));
    let before = WorkService::new(
        store_at(dir.path()),
        Arc::new(Fake::default()),
        clock.clone(),
    );
    let old = before
        .add(
            &p(json!({"title": "Gaming", "state": "done", "links": [
                {"kind": "commit", "sha": "85bbb76eafbcb5973af4f8070bbebb500dcdded5"},
                {"kind": "branch", "name": "up/voice-setup"},
            ]})),
            &agent(None, None),
        )
        .await
        .unwrap();
    let fake = Fake {
        git: Some(Box::new(|root, args, _| GitRead {
            code: Some(if root == "/home/me/roamgate" && args[0] != "merge-base" {
                0
            } else {
                1
            }),
            stdout: String::new(),
        })),
        ..Fake::default()
    };
    let after = WorkService::new(store_at(dir.path()), Arc::new(fake), clock);
    after.backfill_link_roots().await;
    let item = after.read(|store| store.item(&old.id).cloned()).unwrap();
    assert_eq!(
        links(&item),
        json!([
            {"kind": "commit", "sha": "85bbb76eafbcb5973af4f8070bbebb500dcdded5", "root": "/home/me/roamgate"},
            {"kind": "branch", "name": "up/voice-setup", "root": "/home/me/roamgate"},
        ])
    );
    assert_eq!(item.updated_at, old.updated_at);
}

#[test]
fn a_decision_is_decided_by_its_ticked_box_or_by_its_heading_s_answered_line_rfc_0053() {
    let rfc = [
        "## Decisions",
        "",
        "### D1. Crates and the sink's name",
        "",
        "> **Answered 2026-11-11:** \"Follow gst-plugins-rs\".",
        "",
        "### D2. Formats",
        "",
        "Open: packed RGB only?",
        "",
        "### D3: Timestamps",
        "",
        "> **Decided:** none.",
        "",
        "## Later",
        "",
        "- [ ] **D13** The staged add.",
        "- [x] **D14** Plain first.",
    ]
    .join("\n");
    assert!(decision_decided(&rfc, "D1"));
    assert!(!decision_decided(&rfc, "D2"));
    assert!(decision_decided(&rfc, "D3"));
    assert!(!decision_decided(&rfc, "D13"));
    assert!(decision_decided(&rfc, "D14"));
    assert!(!decision_decided(
        "### D13. Staged\n\n> **Answered:** yes",
        "D1"
    ));
    assert!(!decision_decided("- [x] **D14** done", "D1"));
}

#[tokio::test(start_paused = true)]
async fn an_owner_s_session_must_be_one_roamgate_manages_its_task_is_taken_as_given() {
    let kit = setup_with(|fake| {
        fake.sessions = Some(vec!["desktop/w35:p1".into(), "mac/w2:p4".into()]);
    });
    let service = &kit.service;
    let refused = service
        .add(
            &p(json!({"title": "Nobody's", "owner": {"session": "desktop/w99:p9"}})),
            &agent(None, None),
        )
        .await
        .unwrap_err();
    assert!(
        refused
            .message
            .starts_with("no agent session Roamgate manages is at desktop/w99:p9; agent_sessions")
    );
    assert!(refused.message.contains("such as desktop/w35:p1"));
    assert_eq!(refused.code, Some("not_found"));
    let item = service
        .add(
            &p(json!({"title": "A subagent's", "owner": {"session": "mac/w2:p4", "task": "a0a5b2a0a1e034112"}})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(
        item.owner.as_ref().unwrap().task.as_deref(),
        Some("a0a5b2a0a1e034112")
    );
    assert!(
        service
            .update(
                &p(json!({"item": item.id, "owner": {"session": "gone/w1:p1"}})),
                &agent(None, None)
            )
            .await
            .unwrap_err()
            .message
            .contains("no agent session Roamgate manages is at gone/w1:p1")
    );
    let moved = service
        .update(
            &p(json!({"item": item.id, "owner": {"session": "mac/w2:p4", "task": "ffff"}})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(moved.owner.unwrap().task.as_deref(), Some("ffff"));
    let loose = setup();
    let any = loose
        .service
        .add(
            &p(json!({"title": "Any", "owner": {"session": "x/y:z"}})),
            &agent(None, None),
        )
        .await
        .unwrap();
    assert_eq!(any.owner.unwrap().session, "x/y:z");
}

#[tokio::test(start_paused = true)]
async fn an_agent_rewrites_or_deletes_its_own_comments_on_an_item_not_the_user_s_nor_another_agent_s()
 {
    let kit = setup();
    let service = &kit.service;
    let item = service
        .add(
            &p(json!({"title": "Comments", "owner": {"session": "desktop/w35:p1"}, "text": "First words"})),
            &agent(Some("Claude in roamgate"), Some("desktop/w35:p1")),
        )
        .await
        .unwrap();
    let session = service
        .threads(&item.id, false)
        .await
        .unwrap()
        .unwrap()
        .session
        .id;
    let mine = kit.reviews.threads_of(&session)[0]["comments"][0].clone();
    assert_eq!(mine["author"], "Claude");
    let mine = mine["id"].as_str().unwrap().to_owned();
    let users = kit.reviews.add(
        &session,
        "you",
        "Please look",
        json!({"work": {"item": item.id}}),
    );
    let told = kit.reviews.add(
        &session,
        "Codex in gst2",
        "Taken.",
        json!({"work": {"item": item.id}}),
    );
    let meta = agent(Some("Claude in roamgate"), None);
    let edited = service
        .comment_edit(
            &p(json!({"comment": mine, "text": "Better words"})),
            &meta,
            true,
        )
        .await
        .unwrap();
    assert_eq!(edited.item.id, item.id);
    assert_eq!(
        edited.thread.as_ref().unwrap().comments[0].body,
        "Better words"
    );
    let refused = service
        .comment_edit(
            &p(json!({"comment": users.comments[0].id, "text": "Mine now"})),
            &meta,
            true,
        )
        .await
        .unwrap_err();
    assert!(
        refused
            .message
            .contains("only edit its own comments (this one is by you)")
    );
    assert_eq!(refused.code, Some("forbidden"));
    assert!(
        service
            .comment_edit(&p(json!({"comment": told.comments[0].id})), &meta, false)
            .await
            .unwrap_err()
            .message
            .contains("only delete its own comments")
    );
    let theirs = service
        .comment_edit(
            &p(json!({"comment": told.comments[0].id, "text": "Done."})),
            &agent(Some("Codex in gst2"), None),
            true,
        )
        .await
        .unwrap();
    assert_eq!(theirs.thread.unwrap().comments[0].body, "Done.");
    assert!(
        service
            .comment_edit(&p(json!({"comment": told.id, "text": "x"})), &meta, true)
            .await
            .unwrap_err()
            .message
            .contains("give the comment's own id")
    );
    let gone = service
        .comment_edit(&p(json!({"comment": mine})), &meta, false)
        .await
        .unwrap();
    assert_eq!(
        gone.deleted.as_deref(),
        Some(edited.thread.unwrap().id.as_str())
    );
    assert!(gone.thread.is_none());
    assert_eq!(kit.reviews.threads_of(&session).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn the_design_doc_is_the_item_s_description_set_whole_revised_in_place_its_questions_asked_on_its_parts_its_versions_kept()
 {
    let kit = setup();
    let service = &kit.service;
    let item = service
        .add(
            &p(json!({"title": "Data history", "text": "Keep everything in git"})),
            &user(),
        )
        .await
        .unwrap();
    let session = service
        .threads(&item.id, false)
        .await
        .unwrap()
        .unwrap()
        .session
        .id;
    let users = kit.reviews.threads_of(&session)[0].clone();
    let users_comment = users["comments"][0]["id"].as_str().unwrap().to_owned();
    kit.reviews.add(
        &session,
        "you",
        "Not too often",
        json!({"work": {"item": item.id}, "message": {"thread": users["id"], "comment": users_comment, "quote": "Keep everything"}}),
    );
    let doc = format!(
        "# Data history\n\n{}\n\n## Approach\n\nA copy in **git** of every store.\n\n## Scope\n\nEvery area.\n",
        "Some long words of the design. ".repeat(1000)
    );
    let meta = agent(Some("Claude in roamgate"), Some("desktop/w35:p1"));
    let set = service
        .update(&p(json!({"item": item.id, "text": doc})), &meta)
        .await
        .unwrap();
    assert_eq!(set.questions, None);
    let threads = service
        .threads(&item.id, false)
        .await
        .unwrap()
        .unwrap()
        .threads;
    let description = crate::shared::work_description_thread(&threads, &set.created_at)
        .unwrap()
        .clone();
    assert_ne!(json!(description.id), users["id"]);
    assert_eq!(description.comments[0].author, "Claude");
    assert_eq!(description.comments[0].body, doc.trim());
    let former = threads
        .iter()
        .find(|thread| json!(thread.id) == users["id"])
        .unwrap();
    assert_eq!(former.anchor["work"], json!({"item": item.id}));
    // The agent's questions on parts of the description.
    let comment = description.comments[0].id.clone();
    for (text, quote) in [
        ("Every store?", "A copy in git of every store."),
        ("Every area?", "Every area."),
    ] {
        kit.reviews.add(
            &session,
            "Claude",
            text,
            json!({"work": {"item": item.id}, "message": {"thread": description.id, "comment": comment, "quote": quote}}),
        );
    }
    let threads = service
        .threads(&item.id, false)
        .await
        .unwrap()
        .unwrap()
        .threads;
    service.questions_seen(&item.id, &threads).unwrap();
    assert_eq!(kit.item(&item.id).questions, Some(2));
    // The first answered: the decision written into the text, the thread
    // resolved.
    let decided = doc.replace(
        "A copy in **git** of every store.",
        "A copy in **git** of every store (decided 2026-11-22: \"every store\").",
    );
    service
        .update(&p(json!({"item": item.id, "text": decided})), &meta)
        .await
        .unwrap();
    {
        let mut sessions = kit.reviews.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(each, _)| each["id"] == session)
            .unwrap();
        let asked = threads
            .iter_mut()
            .find(|thread| thread["comments"][0]["body"] == "Every store?")
            .unwrap();
        asked["resolved"] = json!(true);
    }
    let threads = service
        .threads(&item.id, false)
        .await
        .unwrap()
        .unwrap()
        .threads;
    service.questions_seen(&item.id, &threads).unwrap();
    assert_eq!(kit.item(&item.id).questions, Some(1));
    let same = crate::shared::work_description_thread(&threads, &item.created_at)
        .unwrap()
        .clone();
    assert_eq!(same.id, description.id);
    assert!(
        same.comments[0]
            .body
            .contains("(decided 2026-11-22: \"every store\")")
    );
    let versions: Vec<Value> = service
        .description_versions(&kit.item(&item.id))
        .into_iter()
        .map(|each| each["text"].clone())
        .collect();
    assert_eq!(
        versions,
        [json!(doc.trim()), json!("Keep everything in git")]
    );
    let listed = tool(
        &kit,
        "work_list",
        json!({"item": item.id, "versions": true}),
        "Claude in roamgate",
        None,
    )
    .await
    .unwrap();
    assert_eq!(listed["item"]["open_questions"], 1);
    assert!(
        listed["description"]
            .as_str()
            .unwrap()
            .contains("Every area.")
    );
    assert_eq!(listed["description_versions"].as_array().unwrap().len(), 2);
    let again = service
        .change(
            &p(json!({"item": item.id, "text": same.comments[0].body})),
            &meta,
        )
        .await
        .unwrap();
    assert!(again.changed.is_empty());
}

#[tokio::test(start_paused = true)]
async fn an_item_s_threads_are_a_review_of_the_item_its_comments_going_to_the_owner_s_pane() {
    let kit = setup();
    let service = &kit.service;
    let own = service
        .add(
            &p(json!({"title": "Mine", "owner": "desktop/w35:p1"})),
            &agent(Some("Claude in roamgate"), Some("desktop/w35:p1")),
        )
        .await
        .unwrap();
    assert!(service.threads(&own.id, false).await.unwrap().is_none());
    let item = service
        .add(
            &p(json!({"title": "Talk", "owner": {"session": "desktop/w35:p1", "task": "a1b2c3"}})),
            &user(),
        )
        .await
        .unwrap();
    let snapshot = service.threads(&item.id, false).await.unwrap().unwrap();
    assert_eq!(
        snapshot.session.target,
        json!({"kind": "work", "item": item.id})
    );
    assert_eq!(snapshot.session.connection_id, "desktop");
    assert_eq!(
        kit.item(&item.id).review.as_deref(),
        Some(snapshot.session.id.as_str())
    );
    assert_eq!(
        *kit.reviews.added.lock().unwrap(),
        [(snapshot.session.id.clone(), "you".into(), "Talk".into())]
    );
    assert_eq!(snapshot.threads[0].anchor["work"], json!({"item": item.id}));
    assert_eq!(
        service
            .threads(&item.id, true)
            .await
            .unwrap()
            .unwrap()
            .session
            .id,
        snapshot.session.id
    );
    assert_eq!(
        service.owner_pane(&item.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
    assert_eq!(service.owner_pane(&item.id, "mac").await, None);
    let thread = service
        .comment(&p(json!({"item": item.id, "text": "Take it"})), "Claude")
        .await
        .unwrap();
    assert_eq!(
        kit.reviews.last_added(),
        (
            snapshot.session.id.clone(),
            "Claude".into(),
            "Take it".into()
        )
    );
    assert_eq!(thread.anchor["work"], json!({"item": item.id}));
    assert_eq!(
        service
            .owner_target(&p(json!({"item": item.id})))
            .await
            .unwrap(),
        None
    );
    let with_panes = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![pane("w35:p1", Some("w35"), None)]));
        fake.generation = Some(3);
    });
    let owned = with_panes
        .service
        .add(
            &p(json!({"title": "Owned", "owner": {"session": "desktop/w35:p1", "task": "a1b2c3"}})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(
        with_panes
            .service
            .owner_target(&p(json!({"item": owned.id})))
            .await
            .unwrap()
            .unwrap()
            .to_json(),
        json!({"connectionId": "desktop", "runtimeGeneration": 3, "workspaceId": "w35", "paneId": "w35:p1", "task": "a1b2c3"})
    );
}

#[tokio::test(start_paused = true)]
async fn a_thread_on_an_item_s_comment_is_kept_under_it_listed_with_its_parent_and_delivered_with_its_quote()
 {
    let kit = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![pane("w35:p1", Some("w35"), None)]));
    });
    let service = &kit.service;
    let item = service
        .add(&p(json!({"title": "Nest me"})), &user())
        .await
        .unwrap();
    service
        .update(
            &p(json!({"item": item.id, "owner": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let session = service
        .threads(&item.id, true)
        .await
        .unwrap()
        .unwrap()
        .session
        .id;
    // Its comments go to the owner's pane, where the review service
    // delivers them with their quote.
    assert_eq!(
        service.owner_pane(&item.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
    let parent = kit.reviews.add(
        &session,
        "you",
        "Please look",
        json!({"work": {"item": item.id}}),
    );
    {
        let mut sessions = kit.reviews.sessions.lock().unwrap();
        let (_, threads) = sessions
            .iter_mut()
            .find(|(each, _)| each["id"] == session)
            .unwrap();
        let thread = threads
            .iter_mut()
            .find(|thread| thread["id"] == parent.id)
            .unwrap();
        thread["comments"].as_array_mut().unwrap().push(json!({
            "id": "5a1d5a1d5a1d5a1d", "author": "Claude", "body": "Done: the box opens.", "createdAt": "2026-11-20T10:02:00.000Z",
        }));
    }
    let quoted = kit.reviews.add(
        &session,
        "you",
        "Which box?",
        json!({"work": {"item": item.id}, "message": {"thread": parent.id, "comment": "5a1d5a1d5a1d5a1d", "quote": "the box opens"}}),
    );
    let whole = kit.reviews.add(
        &session,
        "you",
        "Thanks",
        json!({"work": {"item": item.id}, "message": {"thread": parent.id, "comment": "5a1d5a1d5a1d5a1d"}}),
    );
    let listed = tool(&kit, "work_list", json!({"item": item.id}), "Claude", None)
        .await
        .unwrap();
    let roots: Vec<&Value> = listed["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| &each["thread"])
        .collect();
    assert_eq!(roots, [&json!(parent.id)]);
    assert!(
        listed["comments"][0]["comments"][0]
            .get("threads")
            .is_none()
    );
    let under = &listed["comments"][0]["comments"][1];
    assert_eq!(under["id"], "5a1d5a1d5a1d5a1d");
    let nested: Vec<&Value> = under["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| &each["thread"])
        .collect();
    assert_eq!(nested, [&json!(quoted.id), &json!(whole.id)]);
    assert_eq!(
        under["threads"][0]["on"],
        json!({"comment": "5a1d5a1d5a1d5a1d", "quote": "the box opens"})
    );
    assert_eq!(under["threads"][0]["comments"][0]["text"], "Which box?");
    assert_eq!(
        under["threads"][1]["on"],
        json!({"comment": "5a1d5a1d5a1d5a1d"})
    );
}

#[tokio::test(start_paused = true)]
async fn promotes_a_review_thread_into_an_item_that_adopts_it_title_and_state_from_the_first_line_ids_kept()
 {
    let kit = setup();
    let service = &kit.service;
    kit.reviews.set(todo_review(false));
    let item = service
        .promote(&p(json!({"thread": "b057f8a2"})), &user())
        .await
        .unwrap();
    assert_eq!(item.title, "Fold a reviewed chunk again");
    assert_eq!(item.state, "doing");
    assert_eq!(item.source.as_deref(), Some("thread b057f8a2129c74bc"));
    assert_eq!(item.created_at, "2026-11-20T09:01:00.000Z");
    assert_eq!(
        links(&item),
        json!([{"kind": "review", "id": "d22a2f86bc540f34", "thread": "b057f8a2129c74bc"}])
    );
    let own = kit.reviews.find_now(&item.id).unwrap();
    assert_eq!(
        own.threads
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>(),
        ["b057f8a2129c74bc"]
    );
    assert_eq!(
        own.threads[0]
            .comments
            .iter()
            .map(|c| (c.id.as_str(), c.author.as_str()))
            .collect::<Vec<_>>(),
        [("c1c1c1c1c1c1c1c1", "you"), ("c2c2c2c2c2c2c2c2", "Claude")]
    );
    assert_eq!(
        own.threads[0].anchor["work"],
        json!({"item": item.id, "from": {"review": "d22a2f86bc540f34", "thread": "b057f8a2129c74bc"}, "quote": "Reviews and Files"})
    );
    assert!(kit.reviews.threads_of("d22a2f86bc540f34").is_empty());
    assert_eq!(
        service
            .promote(&p(json!({"thread": "b057f8a2129c74bc"})), &user())
            .await
            .unwrap()
            .id,
        item.id
    );
    assert!(
        service
            .promote(&p(json!({"thread": "nope0000"})), &user())
            .await
            .unwrap_err()
            .message
            .contains("no such thread")
    );
}

#[tokio::test(start_paused = true)]
async fn an_item_nobody_owns_is_the_project_s_coordinator_s_told_of_it_as_a_review_comment() {
    use base64::Engine as _;
    let kit = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![pane("w35:p1", Some("w35"), None)]));
    });
    let service = &kit.service;
    let project = service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(project.coordinator.unwrap().session, "desktop/w35:p1");
    assert!(
        service
            .project_set(&p(json!({"name": "roamgate", "tags": ["voice"]})), &user())
            .await
            .unwrap()
            .coordinator
            .is_some()
    );
    assert!(
        service
            .project_set(
                &p(json!({"name": "roamgate", "coordinator": "w35"})),
                &user()
            )
            .await
            .unwrap_err()
            .message
            .contains("address")
    );
    let png = b"fakepng";
    let item = service
        .add(
            &p(json!({
                "title": "Copy a picture",
                "text": "Like this one: ![shot](<work-image:1>)",
                "images": [{"token": "<work-image:1>", "type": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png)}],
            })),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(item.owner.as_ref().unwrap().session, "desktop/w35:p1");
    let review = item.review.clone().unwrap();
    assert_eq!(
        *kit.reviews.images.lock().unwrap(),
        [(review.clone(), "image/png".into(), png.len())]
    );
    assert_eq!(
        *kit.reviews.added.lock().unwrap(),
        [(
            review.clone(),
            "you".into(),
            format!("Like this one: ![shot](/images/{review}/1.png)")
        )]
    );
    assert_eq!(
        kit.reviews.threads_of(&review)[0]["anchor"]["work"],
        json!({"item": item.id, "description": true})
    );
    assert_eq!(
        service.owner_pane(&item.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
    let bare = service
        .add(&p(json!({"title": "Just a title"})), &user())
        .await
        .unwrap();
    assert_eq!(
        kit.reviews.last_added(),
        (
            bare.review.clone().unwrap(),
            "you".into(),
            "Just a title".into()
        )
    );
    assert_eq!(
        kit.reviews.threads_of(bare.review.as_ref().unwrap())[0]["anchor"]["work"],
        json!({"item": bare.id})
    );
    let mine = service
        .add(
            &p(json!({"title": "Remember the milk", "state": "you"})),
            &user(),
        )
        .await
        .unwrap();
    assert!(mine.owner.is_none() && mine.review.is_none());
    assert_eq!(kit.reviews.added.lock().unwrap().len(), 2);
    assert_eq!(service.owner_pane(&mine.id, "desktop").await, None);
    let given = service
        .add(
            &p(json!({"title": "For the coordinator", "text": "Please do this."})),
            &agent(Some("Claude in gst2"), Some("desktop/w32:p1")),
        )
        .await
        .unwrap();
    assert_eq!(
        kit.reviews.last_added(),
        (
            given.review.clone().unwrap(),
            "Claude in gst2".into(),
            "Please do this.".into()
        )
    );
    let own = service
        .add(
            &p(json!({"title": "My own", "text": "Notes.", "owner": "desktop/w32:p1"})),
            &agent(Some("Claude in gst2"), Some("desktop/w32:p1")),
        )
        .await
        .unwrap();
    assert_eq!(
        kit.reviews.last_added(),
        (
            own.review.clone().unwrap(),
            "Claude".into(),
            "Notes.".into()
        )
    );
    let orphan = service
        .add(
            &p(json!({"title": "Orphan", "owner": "desktop/w9:p1"})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(
        service.owner_pane(&orphan.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
    kit.fake.panes.as_ref().unwrap().lock().unwrap().clear();
    assert_eq!(service.owner_pane(&orphan.id, "desktop").await, None);
    kit.fake
        .panes
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .push(pane("w35:p1", Some("w35"), None));
    let old = service
        .add(
            &p(json!({"title": "Old one", "state": "done", "done_at": "2026-11-01T10:00:00Z"})),
            &agent(Some("Claude in roamgate"), None),
        )
        .await
        .unwrap();
    assert!(old.owner.is_none());
    assert_eq!(kit.reviews.added.lock().unwrap().len(), 5);
    let back = service
        .reopen(&p(json!({"item": old.id})), &user())
        .await
        .unwrap();
    assert_eq!(back.owner.unwrap().session, "desktop/w35:p1");
    assert_eq!(
        kit.reviews.last_added(),
        (back.review.unwrap(), "you".into(), "Reopened.".into())
    );
    assert!(
        service
            .add(
                &p(json!({"title": "x", "text": "y", "images": [{"token": "t", "type": "image/png"}]})),
                &user()
            )
            .await
            .unwrap_err()
            .message
            .contains("an image is")
    );
}

#[tokio::test(start_paused = true)]
async fn the_real_review_service_tells_the_coordinator_of_the_user_s_new_item_and_sends_it_the_comments_of_an_item_whose_owner_is_gone()
 {
    // The board's part: the new item is the coordinator's and its text a
    // thread by the user; an orphan's comments go to the coordinator; the
    // user's own For you item's go nowhere (the review service then says
    // WORK_NO_OWNER).
    let kit = setup_with(|fake| fake.panes = Some(Mutex::new(vec![pane("w35:p1", None, None)])));
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let item = service
        .add(
            &p(json!({"title": "Copy a picture", "text": "When adding a task, paste one."})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(item.owner.unwrap().session, "desktop/w35:p1");
    assert_eq!(kit.reviews.last_added().2, "When adding a task, paste one.");
    let orphan = service
        .add(
            &p(json!({"title": "Orphan", "owner": "desktop/w9:p1"})),
            &agent(Some("Claude in roamgate"), Some("desktop/w9:p1")),
        )
        .await
        .unwrap();
    assert_eq!(
        service.owner_pane(&orphan.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
    kit.fake.panes.as_ref().unwrap().lock().unwrap().clear();
    let mine = service
        .add(&p(json!({"title": "Remember", "state": "you"})), &user())
        .await
        .unwrap();
    assert_eq!(service.owner_pane(&mine.id, "desktop").await, None);
}

#[tokio::test(start_paused = true)]
async fn free_text_from_the_board_a_provisional_title_from_its_first_line_the_coordinator_s_to_sort_needs_triage_until_it_clears_it()
 {
    let kit = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![pane("w35:p1", Some("w35"), None)]));
    });
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let long = format!("{} end", "word ".repeat(30).trim());
    let text = format!("## {long}\nand the details\n- a second task");
    let item = service
        .add(&p(json!({"text": text})), &user())
        .await
        .unwrap();
    assert_eq!(utf16_len(&item.title), 80);
    assert!(item.title.ends_with('\u{2026}'));
    assert!(item.title.starts_with("word word"));
    assert_eq!(item.state, "open");
    assert!(item.tags.is_empty());
    assert_eq!(item.owner.as_ref().unwrap().session, "desktop/w35:p1");
    assert!(item.needs_triage);
    assert_eq!(kit.reviews.last_added().2, text);
    assert_eq!(
        kit.reviews.threads_of(item.review.as_ref().unwrap())[0]["anchor"]["work"],
        json!({"item": item.id, "description": true, "triage": true})
    );
    let short = service
        .add(
            &p(json!({"text": "![shot](<work-image:1>)\nFix the header\nmore"})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(short.title, "Fix the header");
    assert!(
        store_at(kit.dir.path())
            .item(&item.id)
            .unwrap()
            .needs_triage
    );
    let listed = tool(
        &kit,
        "work_list",
        json!({"item": item.id}),
        "Claude in roamgate",
        None,
    )
    .await
    .unwrap();
    assert_eq!(listed["item"]["needs_triage"], true);
    let sorted = service
        .update(
            &p(json!({"item": item.id, "title": "Words, sorted", "add_tags": ["board"], "state": "doing", "needs_triage": false})),
            &agent(Some("Claude in roamgate"), None),
        )
        .await
        .unwrap();
    assert!(!sorted.needs_triage);
    assert_eq!(sorted.title, "Words, sorted");
    assert_eq!(sorted.tags, ["board"]);
    assert!(
        service
            .update(
                &p(json!({"item": item.id, "needs_triage": "no"})),
                &agent(Some("Claude"), None)
            )
            .await
            .unwrap_err()
            .message
            .contains("needs_triage")
    );
    let titled = service
        .add(
            &p(json!({"title": "Has a title", "text": "Body."})),
            &user(),
        )
        .await
        .unwrap();
    assert!(!titled.needs_triage);
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": null})),
            &user(),
        )
        .await
        .unwrap();
    let alone = service
        .add(&p(json!({"text": "Nobody here"})), &user())
        .await
        .unwrap();
    assert_eq!(alone.title, "Nobody here");
    assert!(!alone.needs_triage);
    assert!(
        service
            .add(&p(json!({})), &user())
            .await
            .unwrap_err()
            .message
            .contains("title")
    );
}

#[tokio::test(start_paused = true)]
async fn an_item_given_no_tags_gets_them_from_its_words_the_project_s_own_and_the_app_s_areas_given_ones_stand()
 {
    let kit = setup();
    let service = &kit.service;
    let claude = agent(Some("Claude"), None);
    service
        .project_set(&p(json!({"name": "roamgate", "tags": ["mobile"]})), &user())
        .await
        .unwrap();
    service
        .add(
            &p(json!({"title": "Earlier", "tags": ["rfc-0052"]})),
            &claude,
        )
        .await
        .unwrap();
    let free = service
        .add(
            &p(json!({"text": "On my phone the MR header scrolls away\nsee RFC-0052"})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(free.tags, ["mobile", "reviews", "rfc-0052"]);
    let words = service
        .add(
            &p(json!({"title": "Voice starts late", "text": "In a call, TTS lags."})),
            &claude,
        )
        .await
        .unwrap();
    assert_eq!(words.tags, ["voice"]);
    let given = service
        .add(&p(json!({"title": "Voice again", "tags": ["x"]})), &claude)
        .await
        .unwrap();
    assert_eq!(given.tags, ["x"]);
    let none = service
        .add(&p(json!({"title": "Voice once more", "tags": []})), &claude)
        .await
        .unwrap();
    assert!(none.tags.is_empty());
}

#[tokio::test(start_paused = true)]
async fn the_real_review_service_asks_the_coordinator_to_triage_the_user_s_free_text_item() {
    // The board's part: the item is marked for triage, its thread too, and
    // its comments go to the coordinator's pane.
    let kit = setup_with(|fake| fake.panes = Some(Mutex::new(vec![pane("w35:p1", None, None)])));
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let item = service
        .add(
            &p(json!({"text": "the phone header scrolls away\nand also the files pane"})),
            &user(),
        )
        .await
        .unwrap();
    assert!(item.needs_triage);
    assert_eq!(
        kit.reviews.threads_of(item.review.as_ref().unwrap())[0]["anchor"]["work"],
        json!({"item": item.id, "description": true, "triage": true})
    );
    assert_eq!(
        service.owner_pane(&item.id, "desktop").await.as_deref(),
        Some("w35:p1")
    );
}

#[tokio::test(start_paused = true)]
async fn free_text_the_user_adds_from_a_session_s_chat_is_that_session_s_to_sort_not_the_coordinator_s()
 {
    let kit = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![
            pane("w35:p1", Some("w35"), None),
            pane("w36:p2", Some("w36"), None),
        ]));
        fake.generation = Some(4);
    });
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let item = service
        .add(
            &p(json!({
                "text": "> the header scrolls away\n\nkeep it put",
                "owner": {"session": "desktop/w36:p2"},
                "links": [{"kind": "chat", "session": "desktop/w36:p2", "chat": "c0ffee", "entry": "msg-7"}],
            })),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(item.owner.as_ref().unwrap().session, "desktop/w36:p2");
    assert!(item.needs_triage);
    assert_eq!(
        links(&item),
        json!([{"kind": "chat", "session": "desktop/w36:p2", "chat": "c0ffee", "entry": "msg-7"}])
    );
    assert_eq!(
        service.owner_pane(&item.id, "desktop").await.as_deref(),
        Some("w36:p2")
    );
    assert_eq!(
        service
            .session_target(&p(json!({"session": "desktop/w36:p2"})))
            .await
            .unwrap()
            .unwrap()
            .to_json(),
        json!({"connectionId": "desktop", "runtimeGeneration": 4, "workspaceId": "w36", "paneId": "w36:p2"})
    );
    assert_eq!(
        service
            .session_target(&p(json!({"session": "desktop/w99:p9"})))
            .await
            .unwrap(),
        None
    );
    assert!(
        service
            .add(
                &p(json!({"text": "x", "links": [{"kind": "chat", "session": "not an address"}]})),
                &user()
            )
            .await
            .unwrap_err()
            .message
            .contains("session's address")
    );
}

#[tokio::test(start_paused = true)]
async fn a_call_s_description_is_for_the_user_s_chat_taken_never_kept() {
    let kit = setup();
    let added = tool(
        &kit,
        "work_add",
        json!({"title": "Fix the bar", "description": "Add the bar fix"}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    let id = added["item"]["id"].as_str().unwrap().to_owned();
    let moved = tool(
        &kit,
        "work_update",
        json!({"item": id, "state": "doing", "description": "Take the bar fix"}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    assert_eq!(moved["item"]["title"], "Fix the bar");
    assert_eq!(moved["item"]["state"], "doing");
    tool(
        &kit,
        "work_done",
        json!({"item": id, "description": "Mark it done"}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    tool(
        &kit,
        "work_reopen",
        json!({"item": id, "description": "Take it back"}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    let stored = serde_json::to_string(&kit.item(&id)).unwrap();
    assert!(!stored.contains("Take it back") && !stored.contains("Add the bar fix"));
    assert!(
        tool(
            &kit,
            "work_update",
            json!({"item": id, "description": "x".repeat(201)}),
            "Claude",
            None
        )
        .await
        .unwrap_err()
        .message
        .contains("invalid work_update")
    );
}

#[tokio::test(start_paused = true)]
async fn the_user_s_tools_write_in_their_name_words_for_its_owner_to_sort_comments_and_answers_that_reach_it()
 {
    let kit = setup();
    kit.service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let service = &kit.service;
    let run = |name: &'static str, params: Value| async move {
        work_user_tool(service, name, &params, "voice 2026-11-21 10:00:00")
            .await
            .map(|answer| answer_json(&answer))
    };
    let added = run(
        "work_add",
        json!({"text": "Call drops when the car starts"}),
    )
    .await
    .unwrap();
    assert_eq!(added["item"]["owner_session"], "desktop/w35:p1");
    assert_eq!(added["item"]["needs_triage"], true);
    assert_eq!(added["item"]["source"], "voice 2026-11-21 10:00:00");
    let id = added["item"]["id"].as_str().unwrap().to_owned();
    assert_eq!(kit.item(&id).by, By::User);
    assert_eq!(kit.reviews.last_added().1, "you");
    assert_eq!(kit.reviews.last_added().2, "Call drops when the car starts");
    assert!(
        run("work_add", json!({"title": "x", "text": "y"}))
            .await
            .unwrap_err()
            .message
            .contains("invalid work_add")
    );
    let moved = run(
        "work_update",
        json!({"item": id, "state": "you", "ask": "Choose: drop the car link or keep it", "answers": ["Drop it", "Keep it"]}),
    )
    .await
    .unwrap();
    assert_eq!(moved["item"]["state"], "you");
    assert!(
        run("work_answer", json!({"item": id, "answer": "Maybe"}))
            .await
            .unwrap_err()
            .message
            .contains("\"Drop it\", \"Keep it\"")
    );
    let answered = run("work_answer", json!({"item": id, "answer": "keep it"}))
        .await
        .unwrap();
    assert!(answered["told"].is_string());
    assert_eq!(kit.reviews.last_added().2, "Keep it");
    run(
        "work_comment",
        json!({"item": id, "text": "Et vérifie avec le téléphone"}),
    )
    .await
    .unwrap();
    assert_eq!(kit.reviews.last_added().2, "Et vérifie avec le téléphone");
    assert_eq!(
        run("work_done", json!({"item": id})).await.unwrap()["item"]["state"],
        "done"
    );
    let listed = run("work_list", json!({"state": "done"})).await.unwrap();
    assert_eq!(listed["items"][0]["id"], json!(id));
    assert!(
        run("work_project", json!({"name": "x"}))
            .await
            .unwrap_err()
            .message
            .contains("unknown tool")
    );
    assert!(WORK_USER_TOOLS.contains(&"work_list"));
}

#[tokio::test(start_paused = true)]
async fn the_tools_take_an_ask_and_answers_list_them_and_say_how_to_give_one() {
    let kit = setup();
    let made = tool(
        &kit,
        "work_add",
        json!({"title": "Car audio"}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    let id = made["item"]["id"].as_str().unwrap().to_owned();
    assert!(
        tool(
            &kit,
            "work_update",
            json!({"item": id, "state": "you"}),
            "Claude",
            None
        )
        .await
        .unwrap_err()
        .message
        .contains("give ask")
    );
    let moved = tool(
        &kit,
        "work_update",
        json!({"item": id, "state": "you", "ask": "Choose: media or no music", "answers": ["Media", "No music"]}),
        "Claude",
        None,
    )
    .await
    .unwrap();
    assert_eq!(moved["item"]["ask"], "Choose: media or no music");
    assert_eq!(moved["item"]["answers"], json!(["Media", "No music"]));
    assert!(
        tool(
            &kit,
            "work_update",
            json!({"item": id, "answers": ["x".repeat(81)]}),
            "Claude",
            None
        )
        .await
        .unwrap_err()
        .message
        .contains("invalid work_update")
    );
    let help: Value = serde_json::from_str(
        &work_tool(&kit.service, "help", &json!({}), "Claude", None, By::Agent)
            .await
            .unwrap(),
    )
    .unwrap();
    let update = help["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "work_update")
        .unwrap();
    assert!(update["description"].as_str().unwrap().contains("ask"));
    assert!(update["params"]["properties"]["ask"].is_object());
    assert!(update["params"]["properties"]["answers"].is_object());
}

/// A desktop with the GStreamer workspaces: a coordinator, a worktree.
async fn gstreamer(over: impl FnOnce(&mut Fake)) -> Kit {
    let kit = setup_with(|fake| {
        fake.sessions = Some(vec!["desktop/w32:p1".into(), "desktop/w36:p1".into()]);
        fake.panes = Some(Mutex::new(vec![
            pane("w32:p1", Some("w32"), Some("/g/2.0")),
            pane("w36:p1", Some("w36"), Some("/g/2.0/gst2-video")),
            pane("w3E:p1", Some("w3E"), Some("/g/upstreaming")),
            pane("w35:p1", Some("w35"), Some("/home/me/roamgate")),
        ]));
        let workspace = |id: &str, label: &str, checkout: Option<&str>| Workspace {
            workspace_id: id.into(),
            label: Some(label.into()),
            worktree: checkout.map(|path| WorkspaceTree {
                checkout_path: Some(path.into()),
                repo_root: None,
            }),
        };
        fake.workspaces = Some(vec![
            workspace("w32", "gst2", None),
            workspace("w36", "gst2-video", None),
            workspace("w3E", "gst-upstreaming", Some("/g/upstreaming/ocio")),
            workspace("w35", "roamgate", None),
        ]);
        over(fake);
    });
    kit.service
        .project_set(
            &p(json!({"name": "gstreamer", "roots": ["/g/gstreamer", "/g"]})),
            &user(),
        )
        .await
        .unwrap();
    kit.service
        .project_set(
            &p(json!({"name": "gst2", "roots": ["/g/2.0"], "coordinator": "desktop/w32:p1", "parent": "gstreamer"})),
            &user(),
        )
        .await
        .unwrap();
    kit
}

#[tokio::test(start_paused = true)]
async fn a_parent_s_list_holds_its_subprojects_items_cycles_are_refused() {
    let kit = gstreamer(|_| {}).await;
    let service = &kit.service;
    let own = service
        .add(
            &p(json!({"project": "gstreamer", "title": "Upstream OCIO"})),
            &user(),
        )
        .await
        .unwrap();
    let sub = service
        .add(&p(json!({"project": "gst2", "title": "Caps"})), &user())
        .await
        .unwrap();
    let mut ids: Vec<String> = service
        .list(&p(json!({"project": "gstreamer"})), None)
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
    ids.sort();
    let mut want = vec![own.id.clone(), sub.id.clone()];
    want.sort();
    assert_eq!(ids, want);
    assert!(
        service
            .project_set(&p(json!({"name": "gstreamer", "parent": "gst2"})), &user())
            .await
            .unwrap_err()
            .message
            .contains("cannot be part of it")
    );
    assert!(
        service
            .project_set(&p(json!({"name": "gst2", "parent": "nope"})), &user())
            .await
            .unwrap_err()
            .message
            .contains("no project nope")
    );
    assert_eq!(
        service
            .project_set(&p(json!({"name": "gst2", "tags": ["caps"]})), &user())
            .await
            .unwrap()
            .parent
            .as_deref(),
        Some("gstreamer")
    );
    assert_eq!(
        service
            .project_set(&p(json!({"name": "gst2", "parent": null})), &user())
            .await
            .unwrap()
            .parent,
        None
    );
}

#[tokio::test(start_paused = true)]
async fn an_item_added_from_a_workspace_gets_its_tag_besides_the_auto_tags() {
    let kit = gstreamer(|_| {}).await;
    let service = &kit.service;
    let from_form = service
        .add(
            &p(json!({"project": "gst2", "title": "Fix the caps negotiation on the phone", "workspace": {"connectionId": "desktop", "workspaceId": "w36"}})),
            &user(),
        )
        .await
        .unwrap();
    assert!(from_form.tags.contains(&"ws:gst2-video".to_owned()));
    assert!(from_form.tags.contains(&"phone".to_owned()));
    let from_chat = service
        .add(
            &p(json!({"project": "gst2", "title": "From a chat", "tags": ["caps"], "workspace": {"connectionId": "desktop", "paneId": "w36:p1"}})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(from_chat.tags, ["caps", "ws:gst2-video"]);
    let from_agent = tool(
        &kit,
        "work_add",
        json!({"project": "gst2", "title": "Agent item", "owner": {"session": "desktop/w36:p1"}}),
        "Claude in gst2-video",
        Some("desktop/w36:p1"),
    )
    .await
    .unwrap();
    assert!(
        from_agent["item"]["tags"]
            .as_array()
            .unwrap()
            .contains(&json!("ws:gst2-video"))
    );
    let opted = service
        .add(
            &p(json!({"project": "gst2", "title": "Not about here", "workspace": false})),
            &agent(None, Some("desktop/w36:p1")),
        )
        .await
        .unwrap();
    assert!(!opted.tags.contains(&"ws:gst2-video".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn no_tag_from_the_coordinator_s_workspace_nor_for_another_tree() {
    let kit = gstreamer(|_| {}).await;
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "roots": ["/home/me/roamgate"]})),
            &user(),
        )
        .await
        .unwrap();
    let coordinator = service
        .add(
            &p(json!({"project": "gst2", "title": "Plan the next phase"})),
            &agent(None, Some("desktop/w32:p1")),
        )
        .await
        .unwrap();
    assert!(!has_ws_tag(&coordinator));
    let elsewhere = service
        .add(
            &p(json!({"project": "roamgate", "title": "Unrelated", "workspace": {"connectionId": "desktop", "workspaceId": "w36"}})),
            &user(),
        )
        .await
        .unwrap();
    assert!(!has_ws_tag(&elsewhere));
    let parent = service
        .add(
            &p(json!({"project": "gstreamer", "title": "Shared", "workspace": {"connectionId": "desktop", "workspaceId": "w36"}})),
            &user(),
        )
        .await
        .unwrap();
    assert!(parent.tags.contains(&"ws:gst2-video".to_owned()));
    let upstreaming = service
        .add(
            &p(json!({"project": "gstreamer", "title": "OCIO", "workspace": {"connectionId": "desktop", "workspaceId": "w3E"}})),
            &user(),
        )
        .await
        .unwrap();
    assert!(upstreaming.tags.contains(&"ws:gst-upstreaming".to_owned()));
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_does_not_answer_adds_the_item_untagged() {
    let kit = gstreamer(|fake| fake.panes_hang = true).await;
    let started = tokio::time::Instant::now();
    let item = kit
        .service
        .add(
            &p(json!({"project": "gst2", "title": "Slow", "workspace": {"connectionId": "desktop", "workspaceId": "w36"}})),
            &user(),
        )
        .await
        .unwrap();
    assert!(!has_ws_tag(&item));
    // It waited WORK_PLACE_MS on the clock, then gave up on the tag.
    assert!(started.elapsed() >= Duration::from_millis(WORK_PLACE_MS));
}

#[tokio::test(start_paused = true)]
async fn work_list_keeps_a_workspace_s_items_its_name_its_tag_or_self() {
    let kit = gstreamer(|_| {}).await;
    let service = &kit.service;
    let here = service
        .add(
            &p(json!({"project": "gst2", "title": "Here", "workspace": {"connectionId": "desktop", "workspaceId": "w36"}})),
            &user(),
        )
        .await
        .unwrap();
    service
        .add(&p(json!({"project": "gst2", "title": "Not here"})), &user())
        .await
        .unwrap();
    let ids = |params: Value, address: Option<&'static str>| {
        let params = p(params);
        async move {
            service
                .list(&params, address)
                .await
                .map(|items| items.into_iter().map(|item| item.id).collect::<Vec<_>>())
        }
    };
    assert_eq!(
        ids(json!({"workspace": "gst2-video"}), None).await.unwrap(),
        std::slice::from_ref(&here.id)
    );
    assert_eq!(
        ids(json!({"workspace": "ws:gst2-video"}), None)
            .await
            .unwrap(),
        std::slice::from_ref(&here.id)
    );
    assert_eq!(
        ids(json!({"workspace": "self"}), Some("desktop/w36:p1"))
            .await
            .unwrap(),
        std::slice::from_ref(&here.id)
    );
    assert!(
        ids(json!({"workspace": "self"}), None)
            .await
            .unwrap_err()
            .message
            .contains("not known")
    );
}

#[tokio::test(start_paused = true)]
async fn with_the_rules_and_the_work_tools_a_triage_a_task_and_a_comment_each_end_with_one_line_naming_the_tool_and_ids()
 {
    // The board's part of those prompts (written by the review service):
    // the triage mark on the item and its thread, the coordinator owning
    // both items, and their comments' pane.
    let kit = setup_with(|fake| fake.panes = Some(Mutex::new(vec![pane("w35:p1", None, None)])));
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let free = service
        .add(
            &p(json!({"text": "the phone header scrolls away"})),
            &user(),
        )
        .await
        .unwrap();
    assert!(free.needs_triage);
    assert_eq!(
        kit.reviews.threads_of(free.review.as_ref().unwrap())[0]["anchor"]["work"],
        json!({"item": free.id, "description": true, "triage": true})
    );
    let task = service
        .add(
            &p(json!({"title": "Fold the header", "text": "Fold it on scroll."})),
            &user(),
        )
        .await
        .unwrap();
    assert!(!task.needs_triage);
    assert_eq!(
        kit.reviews.threads_of(task.review.as_ref().unwrap())[0]["anchor"]["work"],
        json!({"item": task.id, "description": true})
    );
    for item in [&free.id, &task.id] {
        assert_eq!(
            service.owner_pane(item, "desktop").await.as_deref(),
            Some("w35:p1")
        );
    }
}

#[tokio::test(start_paused = true)]
async fn the_owner_s_first_new_title_clears_needs_triage_another_s_the_user_s_or_the_same_title_do_not()
 {
    let kit = setup_with(|fake| {
        fake.panes = Some(Mutex::new(vec![pane("w35:p1", Some("w35"), None)]));
    });
    let service = &kit.service;
    service
        .project_set(
            &p(json!({"name": "roamgate", "coordinator": "desktop/w35:p1"})),
            &user(),
        )
        .await
        .unwrap();
    let owner = agent(Some("Claude in roamgate"), Some("desktop/w35:p1"));
    let item = service
        .add(&p(json!({"text": "words to sort"})), &user())
        .await
        .unwrap();
    assert!(item.needs_triage);
    assert!(
        service
            .update(&p(json!({"item": item.id, "add_tags": ["board"]})), &owner)
            .await
            .unwrap()
            .needs_triage
    );
    assert!(
        service
            .update(
                &p(json!({"item": item.id, "title": "Someone else's"})),
                &agent(Some("Codex"), Some("desktop/w9:p1"))
            )
            .await
            .unwrap()
            .needs_triage
    );
    assert!(
        service
            .update(&p(json!({"item": item.id, "title": "The user's"})), &user())
            .await
            .unwrap()
            .needs_triage
    );
    let sorted = service
        .change(
            &p(json!({"item": item.id, "title": "Words, sorted"})),
            &owner,
        )
        .await
        .unwrap();
    assert!(!sorted.item.needs_triage);
    assert_eq!(sorted.changed.get("needs_triage"), Some(&json!(false)));
    let again = service
        .add(&p(json!({"text": "more words to sort"})), &user())
        .await
        .unwrap();
    let kept = service
        .update(
            &p(json!({"item": again.id, "title": "Sorted, still marked", "needs_triage": true})),
            &owner,
        )
        .await
        .unwrap();
    assert!(kept.needs_triage);
}

#[tokio::test(start_paused = true)]
async fn adopts_a_thread_into_an_existing_item_once_and_the_rpcs_route_to_the_service() {
    let kit = setup();
    let service = &kit.service;
    kit.reviews.set(todo_review(false));
    let item = service
        .add(&p(json!({"title": "Already here"})), &user())
        .await
        .unwrap();
    let adopted = service
        .adopt(
            &p(json!({"item": item.id, "thread": "c2c2c2c2"})),
            &agent(Some("Claude"), None),
        )
        .await
        .unwrap();
    assert_eq!(
        links(&adopted),
        json!([{"kind": "review", "id": "d22a2f86bc540f34", "thread": "b057f8a2129c74bc"}])
    );
    assert!(
        kit.pushes()
            .last()
            .unwrap()
            .summary
            .as_deref()
            .unwrap()
            .contains("took thread b057f8a2")
    );
    let before = kit.pushes().len();
    service
        .adopt(
            &p(json!({"item": item.id, "thread": "b057f8a2129c74bc"})),
            &user(),
        )
        .await
        .unwrap();
    assert_eq!(kit.pushes().len(), before);
    assert!(is_work_method("bridge.work.list") && !is_work_method("bridge.mr_reviews.list"));
    let added = handle_work_rpc(service, "bridge.work.add", &p(json!({"title": "RPC"})))
        .await
        .unwrap();
    assert_eq!(added["item"]["by"], "user");
    let id = added["item"]["id"].clone();
    let moved = handle_work_rpc(
        service,
        "bridge.work.update",
        &p(json!({"item": id, "state": "you", "ask": "Say which.", "by": "agent", "summary": "moved it"})),
    )
    .await
    .unwrap();
    assert_eq!(moved["item"]["state"], "you");
    let last = kit.pushes().last().cloned().unwrap();
    assert_eq!(
        (last.by, last.summary.as_deref()),
        (By::Agent, Some("moved it"))
    );
    assert!(
        handle_work_rpc(service, "bridge.work.nope", &p(json!({})))
            .await
            .unwrap_err()
            .message
            .contains("unknown method")
    );
    handle_work_rpc(service, "bridge.work.remove", &p(json!({"item": id})))
        .await
        .unwrap();
    assert_eq!(
        handle_work_rpc(service, "bridge.work.board", &p(json!({})))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let threads = handle_work_rpc(service, "bridge.work.threads", &p(json!({"item": item.id})))
        .await
        .unwrap();
    assert_eq!(
        threads["snapshot"]["session"]["target"],
        json!({"kind": "work", "item": item.id})
    );
}

#[tokio::test(start_paused = true)]
async fn the_board_written_as_text_is_the_board_serialised() {
    let kit = setup();
    let service = &kit.service;
    for title in ["Fix the keys", "Quote \"this\" \u{2028} 1.5e3"] {
        service
            .add(
                &p(json!({"title": title, "tags": ["Reviews"], "owner": "desktop/w35:p1"})),
                &agent(Some("Claude in roamgate"), None),
            )
            .await
            .unwrap();
    }
    let by_value = service.board().await.unwrap().to_string();
    assert_eq!(service.board_text().await.unwrap().get(), by_value);
}
