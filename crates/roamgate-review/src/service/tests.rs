//! The review service's behaviour (server/src/review/service.test.ts and
//! its neighbours), on a fake host as review/testkit.ts sets one up.

use std::sync::{Arc, Mutex};

use roamgate_base::clock::TokioClock;
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::host::{Ask, Load};
use super::*;
use crate::model::ReviewCommit;

#[derive(Default)]
pub(crate) struct FakeHost {
    pub prompts: Mutex<Vec<(String, String, String)>>,
    pub prompt_error: Mutex<Option<String>>,
    pub diff: Mutex<Value>,
    pub commits: Mutex<Option<Vec<ReviewCommit>>>,
    pub heads: Mutex<Option<Vec<Option<String>>>>,
    pub files: Mutex<Option<std::collections::HashMap<String, String>>>,
    pub gone: Mutex<Option<LoadError>>,
    pub channel: Mutex<Option<bool>>,
    pub tools: Mutex<bool>,
    pub rules: Mutex<bool>,
    pub session_panes: Mutex<Option<std::collections::HashMap<String, Option<String>>>>,
    pub causes: Mutex<Vec<(String, String)>>,
}

impl ReviewHost for FakeHost {
    fn load_diff(
        &self,
        _: &ReviewSession,
        _: Option<String>,
        _: Option<Vec<String>>,
    ) -> Load<Value> {
        let gone = self.gone.lock().unwrap().clone();
        let diff = self.diff.lock().unwrap().clone();
        Box::pin(async move {
            match gone {
                Some(error) => Err(error),
                None if diff.is_null() => Ok(json!({"files": [], "truncated": false})),
                None => Ok(diff),
            }
        })
    }

    fn load_commits(&self, _: &ReviewSession) -> Option<Load<Vec<ReviewCommit>>> {
        let commits = self.commits.lock().unwrap().clone()?;
        let gone = self.gone.lock().unwrap().clone();
        Some(Box::pin(async move {
            match gone {
                Some(error) => Err(error),
                None => Ok(commits),
            }
        }))
    }

    fn load_heads(
        &self,
        _: &str,
        entries: Vec<(String, String)>,
    ) -> Option<Load<Vec<Option<String>>>> {
        let heads = self.heads.lock().unwrap().clone()?;
        Some(Box::pin(async move {
            Ok(entries
                .iter()
                .enumerate()
                .map(|(at, _)| heads.get(at).cloned().flatten())
                .collect())
        }))
    }

    fn load_file(&self, _: &ReviewSession, _: String, path: String) -> Option<Load<String>> {
        let files = self.files.lock().unwrap().clone()?;
        Some(Box::pin(async move {
            files
                .get(&path)
                .cloned()
                .ok_or_else(|| LoadError::Failed("no such file".into()))
        }))
    }

    fn can_prompt(&self) -> bool {
        true
    }

    fn prompt_agent(&self, connection_id: &str, pane_id: &str, text: String) -> Ask<()> {
        let error = self.prompt_error.lock().unwrap().clone();
        if error.is_none() {
            self.prompts
                .lock()
                .unwrap()
                .push((connection_id.into(), pane_id.into(), text));
        }
        Box::pin(async move { error.map_or(Ok(()), Err) })
    }

    fn session_pane(&self, _: &str, session: &str) -> Option<Ask<Option<String>>> {
        let panes = self.session_panes.lock().unwrap().clone()?;
        let found = panes.get(session).cloned().flatten();
        Some(Box::pin(async move { Ok(found) }))
    }

    fn agent_channel(&self, _: &str) -> Option<bool> {
        *self.channel.lock().unwrap()
    }

    fn agent_tools(&self, _: &str, _: &str) -> bool {
        *self.tools.lock().unwrap()
    }

    fn agent_rules(&self, _: &str, _: &str) -> bool {
        *self.rules.lock().unwrap()
    }

    fn note_cause(&self, connection_id: &str, pane_id: &str) {
        self.causes
            .lock()
            .unwrap()
            .push((connection_id.into(), pane_id.into()));
    }
}

pub(crate) struct Setup {
    pub dir: tempfile::TempDir,
    pub service: ReviewService,
    pub pushes: Arc<Mutex<Vec<Value>>>,
    pub host: Arc<FakeHost>,
}

pub(crate) fn service_in(
    dir: &std::path::Path,
    host: Arc<FakeHost>,
    delay: u64,
) -> (ReviewService, Arc<Mutex<Vec<Value>>>) {
    let storage = ReviewStorage::open(&DataContext::new(dir, Platform::Unix, None), dir).unwrap();
    let pushes: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = pushes.clone();
    let service = ReviewService::new(ReviewServiceOptions {
        storage,
        publish: Arc::new(move |push| sink.lock().unwrap().push(push)),
        host,
        clock: Arc::new(TokioClock::starting_at(1_767_182_400_000)),
        session_limit: None,
        retry_delay_ms: Some(10),
        delivery_delay_ms: Some(delay),
        agent_search_ms: Some(20),
    });
    (service, pushes)
}

pub(crate) fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(FakeHost::default());
    let (service, pushes) = service_in(dir.path(), host.clone(), 2500);
    Setup {
        dir,
        service,
        pushes,
        host,
    }
}

fn open_session(service: &ReviewService) -> ReviewSession {
    service
        .open(&json!({
            "connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "HEAD"},
            "agent": "Claude", "paneId": "w1:p2",
        }))
        .unwrap()
        .session
}

fn push_types(pushes: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
    pushes
        .lock()
        .unwrap()
        .iter()
        .map(|p| p["type"].as_str().unwrap_or("").to_owned())
        .collect()
}

#[tokio::test]
async fn open_finds_the_existing_session_for_the_same_checkout_and_target() {
    let Setup {
        service, pushes, ..
    } = setup();
    let first = open_session(&service);
    let second = open_session(&service);
    assert_eq!(second.id, first.id);
    assert_eq!(first.title, "main..HEAD");
    assert!(!first.gitlab);
    assert_eq!(
        push_types(&pushes).iter().filter(|t| *t == "open").count(),
        2
    );
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "worktree"}, "raise": false}))
        .unwrap();
    assert_ne!(other.session.id, first.id);
    assert_eq!(push_types(&pushes).last().unwrap(), "session");
}

#[tokio::test]
async fn targets_refuse_option_like_or_multi_word_refs_and_non_mr_urls() {
    let Setup { service, .. } = setup();
    let open = |target: Value| {
        service.open(&json!({"connectionId": "local", "root": "/repo", "target": target}))
    };
    assert!(open(json!({"kind": "range", "base": "--output=x", "head": "HEAD"})).is_err());
    assert!(open(json!({"kind": "range", "base": "main HEAD", "head": "HEAD"})).is_err());
    assert!(
        open(json!({"kind": "mr", "url": "http://gitlab.example/x/-/merge_requests/1"})).is_err()
    );
    let mr = open(json!({"kind": "mr", "url": "https://gitlab.example/group/project/-/merge_requests/7#note_1"})).unwrap();
    assert_eq!(
        mr.session.target.to_value(),
        json!({"kind": "mr", "url": "https://gitlab.example/group/project/-/merge_requests/7"})
    );
    assert!(mr.session.gitlab);
}

#[tokio::test]
async fn threads_replies_and_the_needs_an_answer_rule() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "src/a.ts", "line": 3, "side": "new", "text": "let x = 1;"}, "text": "Why a let?"}))
        .await
        .unwrap();
    assert_eq!(thread.comments[0].author, "you");
    let first = service
        .watch(&json!({"sessionId": session.id, "agent": "Claude"}), None)
        .await
        .unwrap();
    assert_eq!(first.outcome, "unanswered");
    assert_eq!(
        first
            .threads
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>(),
        vec![thread.id.clone()]
    );
    service
        .reply(&json!({"sessionId": session.id, "commentId": &thread.comments[0].id[..6], "author": "Claude", "text": "Fixed in abc123"}))
        .await
        .unwrap();
    let watcher = service.clone();
    let id = session.id.clone();
    let waiting = tokio::spawn(async move {
        watcher
            .watch(
                &json!({"sessionId": id, "agent": "Claude", "timeoutMs": 1000}),
                None,
            )
            .await
    });
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "text": "Thanks"}))
        .await
        .unwrap();
    let woke = waiting.await.unwrap().unwrap();
    assert_eq!(woke.outcome, "unanswered");
    let authors: Vec<_> = woke.threads[0]
        .comments
        .iter()
        .map(|c| c.author.clone())
        .collect();
    assert_eq!(authors, vec!["you", "Claude", "you"]);
}

#[tokio::test]
async fn a_handoff_wakes_the_agent_even_with_nothing_to_answer() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let watcher = service.clone();
    let id = session.id.clone();
    let waiting = tokio::spawn(async move {
        watcher
            .watch(
                &json!({"sessionId": id, "agent": "Claude", "timeoutMs": 1000}),
                None,
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    service
        .handoff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().outcome, "handoff");
}

#[tokio::test]
async fn watch_times_out_and_reports_a_removed_review_as_gone() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let timed = service
        .watch(
            &json!({"sessionId": session.id, "agent": "Claude", "timeoutMs": 5}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(timed.outcome, "timeout");
    let watcher = service.clone();
    let id = session.id.clone();
    let waiting = tokio::spawn(async move {
        watcher
            .watch(
                &json!({"sessionId": id, "agent": "Claude", "mode": "any", "timeoutMs": 1000}),
                None,
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    service.remove(&json!({"sessionId": session.id})).unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().outcome, "gone");
}

#[tokio::test]
async fn agents_edit_and_delete_only_their_own_comments_the_user_takes_over_drafts() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let draft = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft", "anchor": {"path": "a.c", "line": 1}, "author": "Claude", "text": "Leaks on error"}))
        .await
        .unwrap();
    let mine = service
        .add_thread(
            &json!({"sessionId": session.id, "anchor": {"path": "a.c", "line": 2}, "text": "Mine"}),
        )
        .await
        .unwrap();
    let error = service
        .edit(&json!({"sessionId": session.id, "commentId": mine.id, "author": "Claude", "text": "Changed"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("only edit its own"));
    let edited = service
        .edit(&json!({"sessionId": session.id, "commentId": draft.comments[0].id, "text": "Leaks the buffer on error"}))
        .await
        .unwrap();
    assert_eq!(edited.comments[0].author, "you");
    let error = service
        .delete_comment(&json!({"sessionId": session.id, "commentId": mine.id, "author": "Claude"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("only delete its own"));
    let deleted = service
        .delete_comment(&json!({"sessionId": session.id, "commentId": mine.id}))
        .await
        .unwrap();
    assert_eq!(deleted["thread"], Value::Null);
    assert_eq!(
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .threads
            .len(),
        1
    );
}

#[tokio::test]
async fn an_agent_reply_keeps_a_resolved_thread_resolved_the_users_reopens_it() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "text": "Overall?"}))
        .await
        .unwrap();
    service
        .resolve(&json!({"sessionId": session.id, "commentId": thread.id}))
        .unwrap();
    let answer = service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "author": "Claude", "text": "Noted"}))
        .await
        .unwrap();
    assert!(answer.resolved);
    let answer = service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "text": "Wait"}))
        .await
        .unwrap();
    assert!(!answer.resolved);
}

#[tokio::test]
async fn reviews_survive_a_restart_and_a_deleted_thread_can_be_restored() {
    let Setup {
        dir, service, host, ..
    } = setup();
    let session = open_session(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft", "anchor": {"path": "a.c", "line": 4, "side": "old", "endLine": 6}, "text": "Range"}))
        .await
        .unwrap();
    service
        .update(&json!({"sessionId": session.id, "summary": "Looks good"}))
        .await
        .unwrap();
    service
        .delete_comment(&json!({"sessionId": session.id, "commentId": thread.id}))
        .await
        .unwrap();
    service
        .restore_thread(
            &json!({"sessionId": session.id, "thread": serde_json::to_value(&thread).unwrap()}),
        )
        .unwrap();
    service.close();
    drop(service);
    let (second, _) = service_in(dir.path(), host, 2500);
    let restored = second.get(&json!({"sessionId": session.id})).unwrap();
    assert_eq!(restored.session.summary, "Looks good");
    assert_eq!(restored.threads.len(), 1);
    assert_eq!(
        serde_json::to_value(&restored.threads[0].anchor).unwrap(),
        json!({"path": "a.c", "line": 4, "endLine": 6, "side": "old"})
    );
}

#[tokio::test]
async fn agent_status_working_update_and_done() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    service
        .agent_status(
            &json!({"sessionId": session.id, "state": "working", "message": "Fixing the leak"}),
        )
        .unwrap();
    let agent = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session
        .agent;
    assert_eq!(
        agent.working.unwrap().message.as_deref(),
        Some("Fixing the leak")
    );
    service
        .agent_status(&json!({"sessionId": session.id, "state": "update", "message": "Pushed"}))
        .unwrap();
    let after = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session
        .agent;
    assert!(after.working.is_none());
    assert_eq!(after.update.unwrap().message.as_deref(), Some("Pushed"));
}

#[tokio::test]
async fn agent_status_on_one_thread_lasts_until_the_agent_answers_it() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "src/a.ts", "line": 3, "side": "new"}, "text": "Free it on error"}))
        .await
        .unwrap();
    service
        .agent_status(&json!({"sessionId": session.id, "state": "working", "commentId": &thread.comments[0].id[..6], "message": "Freeing the buffer"}))
        .unwrap();
    let working = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session
        .agent
        .working
        .unwrap();
    assert_eq!(working.thread_id.as_deref(), Some(thread.id.as_str()));
    service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "text": "Thanks"}))
        .await
        .unwrap();
    assert!(
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .session
            .agent
            .working
            .is_some()
    );
    service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "author": "Claude", "text": "Freed in abc123"}))
        .await
        .unwrap();
    assert!(
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .session
            .agent
            .working
            .is_none()
    );
    let error = service
        .agent_status(&json!({"sessionId": session.id, "state": "working", "commentId": "nope"}))
        .unwrap_err();
    assert!(error.message.contains("no such comment"));
}

#[tokio::test]
async fn activity_tells_which_branches_moved_since_their_diff_was_seen() {
    let Setup { service, host, .. } = setup();
    let session = open_session(&service);
    *host.diff.lock().unwrap() = json!({"files": [], "truncated": false, "headSha": "aaa"});
    *host.heads.lock().unwrap() = Some(vec![Some("aaa".into())]);
    service
        .diff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let still = service
        .activity(&json!({"connectionId": "local"}))
        .await
        .unwrap();
    assert_eq!(still["activity"][0]["newCommits"], false);
    *host.heads.lock().unwrap() = Some(vec![Some("bbb".into())]);
    let moved = service
        .activity(&json!({"connectionId": "local"}))
        .await
        .unwrap();
    assert_eq!(
        moved["activity"][0],
        json!({"sessionId": session.id, "headSha": "bbb", "newCommits": true})
    );
}

#[tokio::test]
async fn a_removed_checkout_is_remembered_not_asked_of_the_host_each_poll() {
    let Setup { service, host, .. } = setup();
    let session = open_session(&service);
    *host.gone.lock().unwrap() = Some(LoadError::Gone {
        code: "checkout-gone".into(),
        message: "the checkout is gone".into(),
    });
    let error = service
        .diff(&json!({"sessionId": session.id}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, error.code.as_deref()),
        (410, Some("checkout-gone"))
    );
    // Back, but remembered gone until the overlay asks again.
    *host.gone.lock().unwrap() = None;
    assert!(
        service
            .diff(&json!({"sessionId": session.id}))
            .await
            .is_err()
    );
    let activity = service
        .activity(&json!({"connectionId": "local"}))
        .await
        .unwrap();
    assert_eq!(activity["activity"][0]["gone"], "checkout-gone");
    *host.commits.lock().unwrap() = Some(Vec::new());
    service
        .commits(&json!({"sessionId": session.id, "recheck": true}))
        .await
        .unwrap();
    assert!(
        service
            .diff(&json!({"sessionId": session.id}))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_range_whose_base_is_gone_can_compare_against_another() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let moved = service
        .update(&json!({"sessionId": session.id, "base": "origin/main"}))
        .await
        .unwrap();
    assert_eq!(moved.session.title, "origin/main..HEAD");
    assert_eq!(moved.session.automatic_base, Some(false));
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "range", "base": "main", "head": "HEAD"}}))
        .unwrap();
    let error = service
        .update(&json!({"sessionId": other.session.id, "base": "origin/main"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("already compares"));
}

#[tokio::test]
async fn a_discarded_review_comes_back_with_its_threads() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    service
        .add_thread(&json!({"sessionId": session.id, "text": "Keep me"}))
        .await
        .unwrap();
    let snapshot =
        serde_json::to_value(service.get(&json!({"sessionId": session.id})).unwrap()).unwrap();
    service.remove(&json!({"sessionId": session.id})).unwrap();
    let back = service
        .import_session(&json!({"connectionId": "local", "snapshot": snapshot}))
        .unwrap();
    assert_eq!(back.session.id, session.id);
    assert_eq!(back.threads.len(), 1);
    assert_eq!(back.threads[0].comments[0].body, "Keep me");
    assert!(back.session.agent.name.as_deref() == Some("Claude"));
}

#[tokio::test(start_paused = true)]
async fn the_users_comments_reach_the_agent_by_themselves_batched() {
    let Setup { service, host, .. } = setup();
    let session = open_session(&service);
    for text in ["One", "Two"] {
        service
            .add_thread(&json!({"sessionId": session.id, "text": text}))
            .await
            .unwrap();
    }
    assert!(host.prompts.lock().unwrap().is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    let prompts = host.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1);
    let (connection, pane, text) = &prompts[0];
    assert_eq!((connection.as_str(), pane.as_str()), ("local", "w1:p2"));
    assert!(
        text.starts_with(
            "[Roamgate review \"main..HEAD\" (main..HEAD)]\n2 comments from me in the review:"
        ),
        "{text}"
    );
    assert!(text.contains("  One") && text.contains("  Two"));
    assert!(text.contains("roamgate-review --session"));
    // The turn it starts is the user's.
    assert_eq!(
        host.causes.lock().unwrap().as_slice(),
        &[("local".to_owned(), "w1:p2".to_owned())]
    );
    // Explained once: the next delivery is the short form.
    service
        .add_thread(&json!({"sessionId": session.id, "text": "Three"}))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    let prompts = host.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 2);
    assert!(
        prompts[1]
            .2
            .contains("Answer each, saying what you changed:"),
        "{}",
        prompts[1].2
    );
}

#[tokio::test(start_paused = true)]
async fn held_comments_wait_for_the_users_handoff() {
    let Setup { service, host, .. } = setup();
    let session = open_session(&service);
    service
        .update(&json!({"sessionId": session.id, "holdComments": true}))
        .await
        .unwrap();
    service
        .add_thread(&json!({"sessionId": session.id, "text": "Later"}))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
    assert!(host.prompts.lock().unwrap().is_empty());
    let timed = service
        .watch(
            &json!({"sessionId": session.id, "agent": "Claude", "timeoutMs": 10}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(timed.outcome, "timeout");
    service
        .handoff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let prompts = host.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].2.contains("Later"));
}

#[tokio::test(start_paused = true)]
async fn attaching_an_agent_delivers_what_was_written_failures_are_reported() {
    let Setup {
        service,
        host,
        pushes,
        ..
    } = setup();
    let session = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "worktree"}}))
        .unwrap()
        .session;
    service
        .add_thread(&json!({"sessionId": session.id, "text": "Hello"}))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    assert!(host.prompts.lock().unwrap().is_empty());
    *host.prompt_error.lock().unwrap() = Some("agent_not_found".into());
    service
        .update(&json!({"sessionId": session.id, "paneId": "w1:p3", "agent": "codex"}))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    let live = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session;
    assert_eq!(
        live.delivery_error.as_deref(),
        Some("Codex is no longer running in pane w1:p3")
    );
    assert!(live.agent.pane_id.is_none());
    assert!(
        pushes
            .lock()
            .unwrap()
            .iter()
            .any(|p| p["snapshot"]["session"]["deliveryError"].is_string())
    );
    *host.prompt_error.lock().unwrap() = None;
    service
        .update(&json!({"sessionId": session.id, "paneId": "w1:p3", "agent": "codex"}))
        .await
        .unwrap();
    service
        .retry(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let live = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session;
    assert!(live.delivery_error.is_none());
    assert_eq!(host.prompts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_agent_watching_one_repository_hears_about_the_workspaces_others() {
    let Setup { service, .. } = setup();
    let open = |root: &str| {
        service
            .open(&json!({"connectionId": "local", "root": root, "workspaceId": "w1", "target": {"kind": "worktree"}, "agent": "Claude"}))
            .unwrap()
            .session
    };
    let first = open("/one");
    let second = open("/two");
    let thread = service
        .add_thread(&json!({"sessionId": second.id, "text": "Over here"}))
        .await
        .unwrap();
    let woke = service
        .watch(
            &json!({"sessionId": first.id, "agent": "Claude", "timeoutMs": 100}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(woke.outcome, "unanswered");
    assert_eq!(woke.threads[0].id, thread.id);
}

#[tokio::test]
async fn a_comment_on_a_commit_message_reaches_the_agent_as_such() {
    let anchor = crate::model::ReviewAnchor {
        path: Some(crate::model::COMMIT_MESSAGE_PATH.into()),
        line: Some(2),
        ..Default::default()
    };
    assert_eq!(
        super::delivery::describe_anchor(&anchor),
        "line 2 of the commit message"
    );
}

#[tokio::test]
async fn the_threads_of_a_rendered_file_follow_its_lines_once_the_file_changes() {
    let Setup { service, host, .. } = setup();
    *host.files.lock().unwrap() =
        Some([("doc.md".to_owned(), "# Title\n\nOne line\nTwo\n".to_owned())].into());
    let session = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "rendered", "path": "doc.md"}}))
        .unwrap()
        .session;
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "doc.md", "line": 3, "text": "One line", "render": {"quote": "One line"}}, "text": "Hm"}))
        .await
        .unwrap();
    *host.files.lock().unwrap() = Some(
        [(
            "doc.md".to_owned(),
            "# Title\n\nNew\n\nOne line\nTwo\n".to_owned(),
        )]
        .into(),
    );
    let after = service
        .reanchor_file(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let moved = after.threads.iter().find(|t| t.id == thread.id).unwrap();
    assert_eq!(moved.anchor.line, Some(5));
}

#[tokio::test]
async fn too_many_reviews_are_refused_but_a_work_item_is_not() {
    let dir = tempfile::tempdir().unwrap();
    let storage = ReviewStorage::open(
        &DataContext::new(dir.path(), Platform::Unix, None),
        dir.path(),
    )
    .unwrap();
    let service = ReviewService::new(ReviewServiceOptions {
        storage,
        publish: Arc::new(|_| {}),
        host: Arc::new(FakeHost::default()),
        clock: Arc::new(TokioClock::starting_at(1_767_182_400_000)),
        session_limit: Some(1),
        retry_delay_ms: None,
        delivery_delay_ms: None,
        agent_search_ms: None,
    });
    open_session(&service);
    let error = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "worktree"}}))
        .unwrap_err();
    assert!(
        error
            .message
            .starts_with("too many reviews (1, the limit is 1)")
    );
    assert!(service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "work", "item": "0123abcd"}}))
        .is_ok());
}

#[tokio::test]
async fn ids_from_the_browser_make_writes_idempotent() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let params =
        json!({"sessionId": session.id, "text": "Once", "newThreadId": "0123456789abcdef"});
    let first = service.add_thread(&params).await.unwrap();
    let again = service.add_thread(&params).await.unwrap();
    assert_eq!(first.id, again.id);
    assert_eq!(
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .threads
            .len(),
        1
    );
    let reply = json!({"sessionId": session.id, "commentId": first.id, "text": "Twice?", "newCommentId": "fedcba9876543210"});
    service.reply(&reply).await.unwrap();
    let again = service.reply(&reply).await.unwrap();
    assert_eq!(again.comments.len(), 2);
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "worktree"}}))
        .unwrap()
        .session;
    let error = service
        .add_thread(
            &json!({"sessionId": other.id, "text": "Taken", "newThreadId": "0123456789abcdef"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.status, 409);
    let error = service
        .add_thread(&json!({"sessionId": other.id, "text": "Bad", "newThreadId": "not-hex"}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "new_thread_id must be 16 hexadecimal digits");
}

#[tokio::test(start_paused = true)]
async fn the_turn_a_review_comment_starts_is_noted_as_the_users() {
    let Setup { service, host, .. } = setup();
    let session = open_session(&service);
    service
        .add_thread(&json!({"sessionId": session.id, "text": "Go"}))
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
    assert_eq!(host.prompts.lock().unwrap().len(), 1);
    assert_eq!(
        host.causes.lock().unwrap().as_slice(),
        &[("local".to_owned(), "w1:p2".to_owned())]
    );
}

fn stored_session(dir: &std::path::Path, session: Value) {
    let storage = ReviewStorage::open(&DataContext::new(dir, Platform::Unix, None), dir).unwrap();
    storage.save_session_value(&session).unwrap();
}

fn raw_session(target: Value, gitlab: bool) -> Value {
    json!({
        "id": "0123456789abcdef", "connectionId": "local", "root": "/repo", "title": "t",
        "target": target, "gitlab": gitlab, "summary": "", "agent": {},
        "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

#[tokio::test]
async fn a_merge_requests_review_stored_with_sending_off_as_they_once_started_sends_your_discussions_again()
 {
    let dir = tempfile::tempdir().unwrap();
    let mut stored = raw_session(
        json!({"kind": "mr", "url": "https://gitlab.example/g/p/-/merge_requests/1"}),
        true,
    );
    stored["autoSend"] = json!(false);
    stored_session(dir.path(), stored);
    let (service, _) = service_in(dir.path(), Arc::new(FakeHost::default()), 2500);
    let session = service
        .get(&json!({"sessionId": "0123456789abcdef"}))
        .unwrap()
        .session;
    assert_eq!(session.auto_send, None);
}

#[tokio::test]
async fn a_local_review_left_in_the_old_gitlab_mode_is_local_again_threads_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut stored = raw_session(json!({"kind": "worktree"}), true);
    stored["autoSend"] = json!(false);
    stored["summaryUnsent"] = json!(true);
    stored_session(dir.path(), stored);
    let (service, _) = service_in(dir.path(), Arc::new(FakeHost::default()), 2500);
    let session = service
        .get(&json!({"sessionId": "0123456789abcdef"}))
        .unwrap()
        .session;
    assert!(!session.gitlab);
    assert_eq!(session.auto_send, None);
    assert_eq!(session.summary_unsent, None);
}

#[tokio::test]
async fn an_agent_answers_the_user_not_itself() {
    let Setup { service, .. } = setup();
    let session = open_session(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "text": "Q"}))
        .await
        .unwrap();
    let answer = service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "author": "Claude", "text": "A"}))
        .await
        .unwrap();
    let error = service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "author": "Claude", "text": "More"}))
        .await
        .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(
        error
            .message
            .contains(&format!("comment_id: {}", &answer.comments[1].id[..8]))
    );
}

#[tokio::test]
async fn listing_many_reviews_looks_through_each_ones_checkout_alone() {
    let Setup { service, .. } = setup();
    for index in 0..50 {
        service
            .open(&json!({"connectionId": "local", "root": format!("/repo{index}"), "target": {"kind": "worktree"}, "raise": false}))
            .unwrap();
    }
    let state = service.0.lock();
    assert_eq!(state.checkouts.len(), 50);
    assert!(state.checkouts.values().all(|set| set.len() == 1));
    drop(state);
    assert_eq!(service.list(&json!({})).len(), 50);
    assert_eq!(service.summaries(&json!({})).len(), 50);
}
