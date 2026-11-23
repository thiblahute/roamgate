//! server/src/review/step-review.test.ts: the Last step as a review
//! target, and scopes read without a review (showing a scope never
//! creates or touches a session).

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::parse::{describe_target, parse_review_target};

type Loads = Arc<Mutex<Vec<(Value, Option<String>)>>>;

fn setup_in(dir: Option<Arc<tempfile::TempDir>>) -> (Kit, Loads) {
    let loads: Loads = Arc::default();
    let seen = loads.clone();
    let host = Host {
        diff: Some(Box::new(move |session, commit, _| {
            seen.lock()
                .unwrap()
                .push((session.target.to_value(), commit));
            Box::pin(async { Ok(json!({"files": [], "truncated": false, "headSha": sha("f")})) })
        })),
        commits: Some(Box::new(|session| {
            let range = matches!(session.target, crate::model::ReviewTarget::Range { .. });
            Box::pin(async move {
                Ok(if range {
                    let mut one = commit(sha("c"), "One");
                    one.date = "2026-11-15".into();
                    vec![one]
                } else {
                    Vec::new()
                })
            })
        })),
        state: Some("state".into()),
        ..Host::default()
    };
    (kit_in(dir, host, Options::default()), loads)
}

fn step_target() -> Value {
    json!({"kind": "step", "step": "1763200000000-abcdef01", "before": sha("a"), "after": sha("b"),
        "at": "2026-11-15T10:02:00.000Z", "skipped": ["huge.bin"]})
}

fn with(mut target: Value, changes: Value) -> Value {
    for (key, value) in changes.as_object().unwrap() {
        if value.is_null() {
            target.as_object_mut().unwrap().remove(key);
        } else {
            target[key] = value.clone();
        }
    }
    target
}

#[tokio::test]
async fn a_steps_review_is_one_per_step_the_same_two_snapshots_open_the_same_session() {
    let (Kit { service, .. }, _) = setup_in(None);
    let open = |target: Value, workspace: bool| {
        let mut params = json!({"connectionId": "local", "root": "/repo", "target": target, "raise": false});
        if workspace {
            params["workspaceId"] = json!("w1");
        }
        service.open(&params).unwrap().session
    };
    let first = open(step_target(), true);
    assert_eq!(first.target.to_value(), step_target());
    assert!(
        regex::Regex::new(r"^last step \d\d:\d\d$")
            .unwrap()
            .is_match(&first.title),
        "{}",
        first.title
    );
    let again = open(with(step_target(), json!({"at": null})), false);
    assert_eq!(again.id, first.id);
    let next = open(
        with(
            step_target(),
            json!({"step": "1763200000001-abcdef02", "before": sha("b"), "after": sha("c")}),
        ),
        false,
    );
    assert_ne!(next.id, first.id);
    let bare = parse_review_target(Some(
        &json!({"kind": "step", "step": "x", "before": sha("a"), "after": sha("b")}),
    ))
    .unwrap();
    assert_eq!(
        describe_target(&bare),
        format!("last step {}..{}", &sha("a")[..7], &sha("b")[..7])
    );
}

#[tokio::test]
async fn a_steps_target_refuses_what_is_not_a_tree_id_an_option_like_step_or_a_path_outside() {
    let (Kit { service, .. }, _) = setup_in(None);
    let open = |target: Value| {
        service.open(&json!({"connectionId": "local", "root": "/repo", "target": target}))
    };
    for (changes, refusal) in [
        (json!({"before": "HEAD"}), "invalid before"),
        (json!({"after": format!("{};x", sha("b"))}), "invalid after"),
        (json!({"step": "--x"}), "invalid step"),
    ] {
        let error = open(with(step_target(), changes)).unwrap_err();
        assert!(error.message.contains(refusal), "{error:?}");
    }
    let opened = open(with(
        step_target(),
        json!({"skipped": ["../etc/passwd", "ok.bin", 3]}),
    ))
    .unwrap();
    assert_eq!(
        opened.session.target.to_value()["skipped"],
        json!(["ok.bin"])
    );
}

#[tokio::test]
async fn a_steps_review_has_no_commits_its_diff_is_the_steps_the_steps_with_threads_are_kept() {
    let (Kit { service, .. }, loads) = setup_in(None);
    let session = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": step_target(), "raise": false}))
        .unwrap()
        .session;
    assert_eq!(
        service
            .commits(&json!({"sessionId": session.id}))
            .await
            .unwrap(),
        json!({"commits": []})
    );
    let first = service
        .diff(&json!({"sessionId": session.id, "first": true}))
        .await
        .unwrap();
    assert_eq!(first["view"], Value::Null);
    assert_eq!(
        loads.lock().unwrap().last().cloned(),
        Some((session.target.to_value(), None))
    );
    assert!(service.kept_steps("/repo").is_empty());
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "a.txt", "line": 1, "side": "new",
            "text": "two"}, "text": "Why?", "author": "you"}))
        .await
        .unwrap();
    assert_eq!(service.kept_steps("/repo"), vec!["1763200000000-abcdef01"]);
    assert!(service.kept_steps("/other").is_empty());
}

#[tokio::test]
async fn reading_a_scope_with_no_review_creates_touches_and_publishes_no_session() {
    let (Kit { service, .. }, loads) = setup_in(None);
    let range = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "HEAD"}, "raise": false}))
        .unwrap()
        .session;
    let updated = |service: &ReviewService| {
        ids(&service.list(&json!({})), |s| s.session.updated_at.clone())
    };
    let listed = updated(&service);
    let read = |target: Value| json!({"connectionId": "local", "root": "/repo", "target": target});
    let commits = service
        .preview_commits(&read(json!({"kind": "range", "base": "origin/main", "head": "HEAD"})))
        .await
        .unwrap();
    assert_eq!(commits["commits"].as_array().unwrap().len(), 1);
    assert_eq!(commits["commits"][0]["subject"], json!("One"));
    let mut params = read(json!({"kind": "range", "base": "origin/main", "head": "HEAD"}));
    params["commit"] = json!(sha("c"));
    let diff = service.preview_diff(&params).await.unwrap();
    assert_eq!(diff["files"], json!([]));
    assert_eq!(loads.lock().unwrap().last().unwrap().1, Some(sha("c")));
    service
        .preview_diff(&read(json!({"kind": "worktree"})))
        .await
        .unwrap();
    service.preview_diff(&read(step_target())).await.unwrap();
    assert_eq!(
        service.preview_state(&read(step_target())).await.unwrap(),
        json!({"state": "state"})
    );
    let error = service
        .preview_diff(&read(json!({"kind": "chat", "chat": "x"})))
        .await
        .unwrap_err();
    assert!(error.message.contains("only a checkout's changes"));
    assert_eq!(
        ids(&service.list(&json!({})), |s| s.session.id.clone()),
        vec![range.id.clone()]
    );
    assert_eq!(updated(&service), listed);
    assert!(
        service
            .get(&json!({"sessionId": range.id}))
            .unwrap()
            .session
            .seen_head_sha
            .is_none()
    );
}

#[tokio::test]
async fn a_review_of_a_kind_from_a_newer_build_is_kept_and_listed_never_crashing_a_read() {
    let (kit, _) = setup_in(None);
    let session = kit
        .service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": step_target(), "raise": false}))
        .unwrap()
        .session;
    kit.service.close();
    {
        let db = rusqlite::Connection::open(kit.dir.path().join("reviews.sqlite")).unwrap();
        let data: String = db
            .query_row(
                "SELECT data FROM sessions WHERE id = ?",
                [&session.id],
                |row| row.get(0),
            )
            .unwrap();
        let mut stored: Value = serde_json::from_str(&data).unwrap();
        stored["target"] = json!({"kind": "from-a-newer-build", "what": 1});
        db.execute(
            "UPDATE sessions SET data = ? WHERE id = ?",
            [serde_json::to_string(&stored).unwrap(), session.id.clone()],
        )
        .unwrap();
    }
    let (Kit {
        service: reopened, ..
    }, _) = setup_in(Some(kit.dir.clone()));
    let found = reopened
        .list(&json!({}))
        .into_iter()
        .find(|s| s.session.id == session.id)
        .unwrap();
    assert_eq!(found.session.target.kind(), "from-a-newer-build");
    assert_eq!(describe_target(&found.session.target), "review");
    assert_eq!(
        reopened
            .commits(&json!({"sessionId": session.id}))
            .await
            .unwrap(),
        json!({"commits": []})
    );
    reopened
        .diff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .session
            .id,
        session.id
    );
}
