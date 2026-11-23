//! server/src/review/service-integrity.test.ts: what imports, restores,
//! limits and late loads may not do to the store.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;
use crate::images::save_review_image;
use crate::model::{ReviewSession, limits};

fn limited(limit: usize) -> Kit {
    kit(
        Host::default(),
        Options {
            session_limit: Some(limit),
            ..Options::default()
        },
    )
}

fn open_plain(service: &ReviewService) -> ReviewSession {
    service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "HEAD"}}))
        .unwrap()
        .session
}

fn worktree(service: &ReviewService, root: &str) -> crate::error::ReviewResult<ReviewSession> {
    service
        .open(&json!({"connectionId": "local", "root": root, "target": {"kind": "worktree"}, "raise": false}))
        .map(|s| s.session)
}

fn snapshot(session: Value) -> Value {
    let mut full = json!({"connectionId": "local", "root": "/repo", "title": "t", "target": {"kind": "worktree"}});
    for (key, value) in session.as_object().unwrap() {
        full[key] = value.clone();
    }
    json!({"connectionId": "local", "snapshot": {"session": full, "threads": []}})
}

#[tokio::test]
async fn an_imported_review_id_cannot_walk_out_of_the_review_folder() {
    let Kit { service, dir, .. } = plain();
    let sentinel = dir.path().join("sentinel.txt");
    std::fs::write(&sentinel, "keep\n").unwrap();
    let at = "2026-01-01T00:00:00.000Z";
    let imported = service.import_session(&json!({"connectionId": "local", "snapshot": {"session": {
        "id": "../..", "connectionId": "local", "root": "/repo", "title": "Escape",
        "target": {"kind": "worktree"}, "summary": "", "agent": {}, "createdAt": at, "updatedAt": at},
        "threads": []}}));
    assert!(imported.is_err());
    assert!(service.remove(&json!({"sessionId": "../.."})).is_err());
    assert!(service.list(&json!({})).is_empty());
    assert!(sentinel.exists());
}

#[tokio::test]
async fn removing_a_review_keeps_its_images_for_the_lists_undo() {
    let Kit { service, dir, .. } = plain();
    let opened = service
        .open(&json!({"connectionId": "local", "workspaceId": "w1", "root": "/repo", "target": {"kind": "worktree"}}))
        .unwrap();
    let id = opened.session.id.clone();
    let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];
    let path = save_review_image(dir.path(), &id, "image/png", &png).unwrap();
    assert!(path.starts_with(dir.path().join("images").join(&id)));
    let snapshot = service.get(&json!({"sessionId": id})).unwrap();
    service.remove(&json!({"sessionId": id})).unwrap();
    assert!(path.exists());
    service
        .import_session(&json!({"connectionId": "local", "snapshot": to_json(&snapshot)}))
        .unwrap();
    assert_eq!(
        ids(&service.list(&json!({})), |s| s.session.id.clone()),
        vec![id]
    );
    assert!(path.exists());
}

#[tokio::test]
async fn an_import_is_rebuilt_field_by_field_ids_that_are_not_ours_are_refused() {
    let Kit { service, .. } = plain();
    for id in [
        json!("../.."),
        json!(""),
        json!(42),
        Value::Null,
        json!("ABCDEF0123456789"),
    ] {
        let mut params = snapshot(json!({}));
        if !id.is_null() {
            params["snapshot"]["session"]["id"] = id;
        }
        assert!(service.import_session(&params).is_err());
    }
    let error = service
        .import_session(&snapshot(json!({"id": "0123456789abcdef", "root": "-L"})))
        .unwrap_err();
    assert!(error.message.contains("invalid root"));
    assert!(
        service
            .import_session(&snapshot(json!({"id": "0123456789abcdef", "root": 7})))
            .is_err()
    );
    assert!(service.list(&json!({})).is_empty());
    let restored = service
        .import_session(&snapshot(
            json!({"id": "0123456789abcdef", "seenHeadSha": {"not": "a sha"},
            "holdComments": "yes", "reviewed": {"diff:a.txt": "f1"}}),
        ))
        .unwrap();
    assert_eq!(restored.session.id, "0123456789abcdef");
    assert!(restored.session.seen_head_sha.is_none());
    assert!(restored.session.hold_comments.is_none());
    assert_eq!(
        to_json(&restored.session.reviewed),
        json!({"diff:a.txt": "f1"})
    );
    let windows = service
        .import_session(&snapshot(
            json!({"id": "fedcba9876543210", "root": "C:/work/repo"}),
        ))
        .unwrap();
    assert_eq!(windows.session.root, "C:/work/repo");
}

#[tokio::test]
async fn an_import_never_takes_over_another_connections_review() {
    let Kit { service, .. } = plain();
    let theirs = open_plain(&service);
    let error = service
        .import_session(&json!({"connectionId": "other", "snapshot": {"session": {
            "id": theirs.id, "connectionId": "other", "root": "/repo", "title": "t",
            "target": {"kind": "worktree"}}, "threads": []}}))
        .unwrap_err();
    assert!(error.message.contains("invalid review id"));
}

fn import_with(id: &str, threads: Vec<Value>) -> Value {
    json!({"connectionId": "local", "snapshot": {"session": {"id": id, "connectionId": "local",
        "root": "/repo", "title": "t", "target": {"kind": "worktree"}}, "threads": threads}})
}

#[tokio::test]
async fn an_import_with_too_many_threads_is_refused_before_anything_is_kept() {
    let Kit { service, .. } = plain();
    let id = "0123456789abcdef";
    let thread = json!({"sessionId": id, "comments": [{"author": "you", "body": "x"}]});
    let error = service
        .import_session(&import_with(id, vec![thread; 2001]))
        .unwrap_err();
    assert!(error.message.contains("too many comments"));
    assert!(service.list(&json!({})).is_empty());
}

#[tokio::test]
async fn an_import_with_an_invalid_thread_keeps_nothing() {
    let kit = plain();
    let id = "0123456789abcdef";
    let error = kit
        .service
        .import_session(&import_with(
            id,
            vec![
                json!({"sessionId": id, "comments": [{"author": "you", "body": "fine"}]}),
                json!({"sessionId": id, "comments": [{"author": "you", "body": "   "}]}),
            ],
        ))
        .unwrap_err();
    assert!(error.message.contains("text is empty"));
    assert!(kit.service.list(&json!({})).is_empty());
    assert!(kit.reopen().list(&json!({})).is_empty());
}

#[tokio::test]
async fn an_import_keeps_only_the_reviews_own_threads() {
    let Kit { service, .. } = plain();
    let id = "0123456789abcdef";
    let back = service
        .import_session(&import_with(
            id,
            vec![
                json!({"sessionId": id, "comments": [{"author": "you", "body": "Mine"}]}),
                json!({"sessionId": id, "gitlab": {"draftId": 3}, "comments": [{"author": "you", "body": "On GitLab"}]}),
                json!({"sessionId": "fedcba9876543210", "comments": [{"author": "you", "body": "Another review's"}]}),
            ],
        ))
        .unwrap();
    assert_eq!(
        ids(&back.threads, |t| t.comments[0].body.clone()),
        vec!["Mine"]
    );
}

#[tokio::test]
async fn a_review_past_the_limit_is_not_imported() {
    let Kit { service, .. } = limited(3);
    for index in 0..3 {
        worktree(&service, &format!("/repo/{index}")).unwrap();
    }
    let error = service
        .import_session(&import_with("0123456789abcdef", vec![]))
        .unwrap_err();
    assert!(
        error
            .message
            .contains("too many reviews (3, the limit is 3)")
    );
}

#[tokio::test]
async fn a_new_review_past_the_limit_is_refused_saying_how_to_make_room() {
    let Kit { service, .. } = limited(2);
    for index in 0..2 {
        worktree(&service, &format!("/repo/{index}")).unwrap();
    }
    let error = worktree(&service, "/repo/2").unwrap_err();
    assert!(error.message.contains(
        "too many reviews (2, the limit is 2); delete old ones in the reviews list to make room"
    ));
    assert_eq!(worktree(&service, "/repo/0").unwrap().root, "/repo/0");
}

#[tokio::test]
async fn a_work_items_review_is_opened_past_the_limit() {
    let Kit { service, .. } = limited(1);
    worktree(&service, "/repo").unwrap();
    let work = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "work", "item": "0123abcd"}, "raise": false}))
        .unwrap();
    assert_eq!(
        work.session.target.to_value(),
        json!({"kind": "work", "item": "0123abcd"})
    );
    assert!(
        worktree(&service, "/repo/other")
            .unwrap_err()
            .message
            .contains("too many reviews")
    );
}

#[tokio::test]
async fn a_work_items_review_is_found_without_listing_every_review() {
    let Kit { service, clock, .. } = plain();
    let work_on = |connection: &str, item: &str| {
        clock.advance(1_000);
        service
            .open(&json!({"connectionId": connection, "root": "/repo", "target": {"kind": "work", "item": item}, "raise": false}))
            .unwrap()
            .session
    };
    let first = work_on("a", "0123abcd");
    let second = work_on("b", "0123abcd");
    work_on("a", "4567cdef");
    let of_item = |session: &ReviewSession| matches!(&session.target, crate::model::ReviewTarget::Work { item } if item == "0123abcd");
    assert_eq!(service.newest(of_item).unwrap().session.id, second.id);
    clock.advance(1_000);
    service
        .add_thread(&json!({"sessionId": first.id, "anchor": {}, "text": "Newer now"}))
        .await
        .unwrap();
    let found = service.newest(of_item);
    assert_eq!(found.as_ref().unwrap().session.id, first.id);
    let listed = service
        .list(&json!({"chats": true}))
        .into_iter()
        .find(|s| of_item(&s.session));
    assert_eq!(found, listed);
    let prefix = second.id[..8].to_owned();
    assert_eq!(
        service
            .newest(|session| session.id.starts_with(&prefix))
            .unwrap()
            .session
            .id,
        second.id
    );
    assert!(service.newest(|_| false).is_none());
}

#[test]
fn the_store_keeps_thousands_of_reviews() {
    const { assert!(limits::SESSIONS >= 10_000) };
}

#[tokio::test]
async fn a_restored_thread_cannot_overwrite_another_reviews_thread() {
    let kit = plain();
    let service = &kit.service;
    let mine = open_plain(service);
    let theirs = service
        .open(&json!({"connectionId": "other", "root": "/srv", "target": {"kind": "worktree"}}))
        .unwrap()
        .session;
    let original = service
        .add_thread(&json!({"sessionId": theirs.id, "text": "Theirs"}))
        .await
        .unwrap();
    let restored = service
        .restore_thread(&json!({"sessionId": mine.id, "thread": {"id": original.id,
            "comments": [{"author": "you", "body": "Mine"}]}}))
        .unwrap();
    assert_ne!(restored.id, original.id);
    let kept = kit
        .reopen()
        .get(&json!({"sessionId": theirs.id}))
        .unwrap()
        .threads;
    assert_eq!(ids(&kept, |t| t.comments[0].body.clone()), vec!["Theirs"]);
    assert_eq!(kept[0].session_id, theirs.id);
}

#[tokio::test]
async fn restoring_threads_past_the_limit_is_refused() {
    let Kit { service, .. } = plain();
    let session = open_plain(&service);
    let params =
        json!({"sessionId": session.id, "thread": {"comments": [{"author": "you", "body": "x"}]}});
    for _ in 0..2000 {
        service.restore_thread(&params).unwrap();
    }
    let error = service.restore_thread(&params).unwrap_err();
    assert!(error.message.contains("too many comments"));
    assert_eq!(
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .threads
            .len(),
        2000
    );
}

type Waiting = Arc<Mutex<Vec<Option<oneshot::Sender<Value>>>>>;

/// A host whose diffs answer only when the test says (TS's deferred).
fn deferred() -> (Host, Waiting) {
    let waiting: Waiting = Arc::default();
    let loads = waiting.clone();
    let host = Host {
        diff: Some(Box::new(move |_, _, _| {
            let (send, receive) = oneshot::channel();
            loads.lock().unwrap().push(Some(send));
            Box::pin(async move {
                receive
                    .await
                    .map_err(|_| LoadError::Failed("dropped".into()))
            })
        })),
        ..Host::default()
    };
    (host, waiting)
}

fn loaded(head: &str) -> Value {
    json!({"files": [], "truncated": false, "headSha": sha(head)})
}

async fn until_asked(waiting: &Waiting, count: usize) {
    while waiting.lock().unwrap().len() < count {
        tokio::task::yield_now().await;
    }
}

fn answer(waiting: &Waiting, at: usize, value: Value) {
    let send = waiting.lock().unwrap()[at].take().unwrap();
    send.send(value).unwrap();
}

#[tokio::test]
async fn a_review_removed_while_its_diff_loads_stays_removed() {
    let (host, waiting) = deferred();
    let kit = kit(host, Options::default());
    let service = kit.service.clone();
    let session = open_plain(&service);
    let id = session.id.clone();
    let loading = tokio::spawn(async move { service.diff(&json!({"sessionId": id})).await });
    until_asked(&waiting, 1).await;
    kit.service
        .remove(&json!({"sessionId": session.id}))
        .unwrap();
    answer(&waiting, 0, loaded("a"));
    let _ = loading.await.unwrap();
    assert!(kit.reopen().list(&json!({})).is_empty());
}

#[tokio::test]
async fn an_older_diff_answering_late_does_not_overwrite_the_head_last_seen() {
    let (host, waiting) = deferred();
    let Kit { service, .. } = kit(host, Options::default());
    let session = open_plain(&service);
    let diff = |service: &ReviewService| {
        let service = service.clone();
        let id = session.id.clone();
        tokio::spawn(async move { service.diff(&json!({"sessionId": id})).await })
    };
    let seen = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .session
            .seen_head_sha
    };
    let first = diff(&service);
    until_asked(&waiting, 1).await;
    let second = diff(&service);
    until_asked(&waiting, 2).await;
    answer(&waiting, 1, loaded("b"));
    second.await.unwrap().unwrap();
    answer(&waiting, 0, loaded("a"));
    first.await.unwrap().unwrap();
    assert_eq!(seen(&service), Some(sha("b")));
    let third = diff(&service);
    until_asked(&waiting, 3).await;
    service
        .update(&json!({"sessionId": session.id, "base": "develop"}))
        .await
        .unwrap();
    answer(&waiting, 2, loaded("c"));
    third.await.unwrap().unwrap();
    assert_eq!(seen(&service), None);
}

#[tokio::test]
async fn a_refused_update_changes_nothing() {
    let kit = plain();
    let service = &kit.service;
    let session = open_plain(service);
    for (params, refusal) in [
        (
            json!({"summary": "Overall", "title": 42}),
            "title is required",
        ),
        (
            json!({"autoSend": false, "title": "Renamed", "holdComments": "yes"}),
            "invalid hold flag",
        ),
        (
            json!({"reviewed": {"diff:a.txt": "f1"}, "base": "--bad"}),
            "invalid base",
        ),
    ] {
        let mut params = params;
        params["sessionId"] = json!(session.id);
        let error = service.update(&params).await.unwrap_err();
        assert!(error.message.contains(refusal), "{error:?}");
    }
    let now = service
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session;
    assert_eq!(now.summary, "");
    assert_eq!(now.title, "main..HEAD");
    assert_eq!(now.auto_send, Some(true));
    assert!(now.reviewed.is_none());
    let reopened = kit
        .reopen()
        .get(&json!({"sessionId": session.id}))
        .unwrap()
        .session;
    assert_eq!(reopened.summary, "");
    assert_eq!(reopened.auto_send, Some(true));
}

/// The service's half: the root rpc.ts's readRoot answers for a picked
/// Windows path is the review's root as written.
#[tokio::test]
async fn the_browser_opens_a_review_of_a_windows_path_it_picked() {
    let Kit { service, .. } = plain();
    let opened = service
        .open(
            &json!({"connectionId": "local", "workspaceId": "w1", "root": "C:/work/repo",
            "target": {"kind": "worktree"}}),
        )
        .unwrap();
    assert_eq!(opened.session.root, "C:/work/repo");
}

#[tokio::test]
async fn a_reviews_diff_asked_as_a_summary_reads_its_files_list_and_its_files_a_few_at_a_time() {
    let calls: Arc<Mutex<Vec<String>>> = Arc::default();
    let (whole, summary, files) = (calls.clone(), calls.clone(), calls.clone());
    let (base, head) = (sha("a"), sha("b"));
    let (summary_base, summary_head) = (base.clone(), head.clone());
    let whole_head = head.clone();
    let host = Host {
        diff: Some(Box::new(move |_, _, _| {
            whole.lock().unwrap().push("whole".into());
            let head = whole_head.clone();
            Box::pin(async move { Ok(json!({"files": [], "truncated": false, "headSha": head})) })
        })),
        summary: Some(Box::new(move |_, commit| {
            let (calls, base, head) = (summary.clone(), summary_base.clone(), summary_head.clone());
            Box::pin(async move {
                calls.lock().unwrap().push(format!(
                    "summary {}",
                    commit.unwrap_or_else(|| "all".into())
                ));
                Ok(
                    json!({"files": [{"path": "a.ts", "oldPath": "a.ts", "hunks": [], "status": "modified"}],
                    "baseSha": base, "headSha": head, "truncated": false, "summary": true}),
                )
            })
        })),
        files: Some(Box::new(move |_, base, head, list| {
            let named: Vec<String> = list
                .iter()
                .map(|f| {
                    format!(
                        "{}>{}",
                        f["oldPath"].as_str().unwrap_or(""),
                        f["path"].as_str().unwrap()
                    )
                })
                .collect();
            files.lock().unwrap().push(format!(
                "files {}..{} {}",
                &base[..1],
                &head[..1],
                named.join(",")
            ));
            let out: Vec<Value> = list
                .iter()
                .map(|f| json!({"path": f["path"], "oldPath": f.get("oldPath").cloned().unwrap_or(f["path"].clone()), "hunks": []}))
                .collect();
            Box::pin(async move { Ok(json!(out)) })
        })),
        ..Host::default()
    };
    let Kit { service, .. } = kit(host, Options::default());
    let session = open_plain(&service);
    let id = session.id.clone();
    let summary = service
        .diff(&json!({"sessionId": id, "summary": true}))
        .await
        .unwrap();
    assert_eq!(summary["summary"], json!(true));
    assert_eq!(
        service
            .get(&json!({"sessionId": id}))
            .unwrap()
            .session
            .seen_head_sha,
        Some(head.clone())
    );
    service
        .diff(&json!({"sessionId": id, "summary": true, "commit": "c0ffee1"}))
        .await
        .unwrap();
    let read = service
        .diff(&json!({"sessionId": id, "base": base, "head": head,
            "files": [{"path": "a.ts"}, {"path": "b.ts", "oldPath": "old/b.ts"}]}))
        .await
        .unwrap();
    assert_eq!(
        read["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].clone())
            .collect::<Vec<_>>(),
        vec![json!("a.ts"), json!("b.ts")]
    );
    service.diff(&json!({"sessionId": id})).await.unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "summary all",
            "summary c0ffee1",
            "files a..b >a.ts,old/b.ts>b.ts",
            "whole"
        ]
    );
    let many: Vec<Value> = (0..33).map(|i| json!({"path": format!("f{i}")})).collect();
    for bad in [
        json!({"base": base, "head": head, "files": [{"path": "../x"}]}),
        json!({"base": "main", "head": head, "files": [{"path": "a.ts"}]}),
        json!({"base": base, "head": head, "files": []}),
        json!({"base": base, "head": head, "files": many}),
    ] {
        let mut params = bad;
        params["sessionId"] = json!(id);
        assert!(service.diff(&params).await.is_err(), "{params}");
    }
    assert_eq!(calls.lock().unwrap().len(), 4);
}
