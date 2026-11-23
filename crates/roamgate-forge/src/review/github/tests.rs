//! review/github.test.ts: pull requests in the review pane through a fake
//! gh.

use std::sync::{Arc, Mutex};

use roamgate_review::model::ReviewAnchor;
use serde_json::{Value, json};

use super::*;
use crate::review::cli::ForgeProcess;
use crate::review::gitlab::{
    create_draft_note, create_draft_reply, delete_draft_note, read_merge_request,
    read_merge_request_diff, read_merge_request_threads, update_draft_note,
};
use crate::review::testkit::{Fake, fail, field, json as answer_json, ok, tools, words};

const URL: &str = "https://github.com/o/r/pull/7";

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

#[test]
fn a_pull_request_url_is_a_merge_request_reference() {
    assert_eq!(
        parse_merge_request_url(&format!("{URL}/files")),
        Some(MergeRequestRef {
            host: "github.com".into(),
            project: "o/r".into(),
            iid: 7,
        })
    );
}

#[tokio::test]
async fn reads_the_pull_request_its_diff_and_its_comment_threads() {
    let answers = [
        // GitHub's shape of a pull request's conversation (issue) comments.
        (
            "repos/o/r/issues/7/comments",
            json!([{
                "id": 3501, "body": "Thanks! Could you add a test?", "user": {"login": "reviewer"},
                "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-01T10:00:00Z",
                "author_association": "MEMBER",
            }]),
        ),
        (
            "repos/o/r/pulls/7/files",
            json!([{"filename": "a.c", "status": "modified", "patch": "@@ -1 +1 @@\n-old\n+new"}]),
        ),
        (
            "repos/o/r/pulls/7/comments",
            json!([
                {"id": 1, "path": "a.c", "line": 1, "side": "RIGHT", "body": "why?", "user": {"login": "bob"}, "created_at": "t"},
                {"id": 2, "in_reply_to_id": 1, "path": "a.c", "body": "because", "user": {"login": "me"}, "created_at": "t2"},
            ]),
        ),
        (
            "repos/o/r/pulls/7",
            json!({"html_url": URL, "title": "T", "state": "open",
                   "head": {"sha": "a".repeat(40)}, "base": {"sha": "b".repeat(40)}}),
        ),
    ];
    let calls: Calls = Arc::default();
    let seen = calls.clone();
    let fake = Fake::sync(move |process| {
        let argv = words(process);
        seen.lock().unwrap().push(argv.clone());
        if argv.iter().any(|a| a == "graphql") {
            return answer_json(
                &json!({"data": {"repository": {"pullRequest": {"id": "PR", "reviews": {"nodes": []}}}}}),
            );
        }
        let path = argv
            .iter()
            .find(|part| part.starts_with("repos/"))
            .cloned()
            .unwrap_or_default();
        match answers.iter().find(|(prefix, _)| path.starts_with(prefix)) {
            Some((_, value)) => answer_json(value),
            None => fail(1, format!("no answer for {path}")),
        }
    });
    let context = tools(fake).context("/tmp", None);
    let mr = read_merge_request(&context, URL).await.unwrap();
    assert_eq!(mr.forge.as_deref(), Some("github"));
    assert_eq!(mr.head_sha, "a".repeat(40));
    assert_eq!(mr.base_sha, "b".repeat(40));
    assert_eq!(mr.state, "opened");
    let diff = read_merge_request_diff(&context, &mr).await.unwrap();
    assert_eq!(
        diff.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["a.c"]
    );
    let all = read_merge_request_threads(&context, &mr, "s")
        .await
        .unwrap();
    // The conversation comment: a general thread, with no draft reply.
    let general: Vec<(String, String, Option<String>)> = all
        .iter()
        .filter(|thread| thread.anchor.path.is_none())
        .map(|thread| {
            (
                thread.id.clone(),
                thread.comments[0].author.clone(),
                thread.gitlab.as_ref().and_then(|g| g.discussion_id.clone()),
            )
        })
        .collect();
    assert_eq!(general, vec![("ghc:3501".into(), "@reviewer".into(), None)]);
    let threads: Vec<_> = all
        .iter()
        .filter(|thread| thread.anchor.path.is_some())
        .collect();
    assert_eq!(threads.len(), 1);
    assert_eq!(
        threads[0]
            .comments
            .iter()
            .map(|c| c.author.as_str())
            .collect::<Vec<_>>(),
        ["@bob", "@me"]
    );
    assert_eq!(threads[0].anchor.path.as_deref(), Some("a.c"));
    assert_eq!(threads[0].anchor.line, Some(1));
    assert_eq!(threads[0].anchor.side.as_deref(), Some("new"));
    // Every call is a read with gh.
    assert!(calls.lock().unwrap().iter().all(|argv| {
        argv[0] == "gh"
            && (argv.iter().any(|a| a == "GET")
                || (argv.iter().any(|a| a == "graphql") && !argv.join(" ").contains("mutation")))
    }));
}

#[derive(Default)]
struct Pending {
    review: Option<Value>,
    comments: Vec<Value>,
}

#[tokio::test]
async fn drafts_are_the_users_pending_review_replies_and_submits_never() {
    let calls: Calls = Arc::default();
    let state: Arc<Mutex<Pending>> = Arc::default();
    let (seen, pending) = (calls.clone(), state.clone());
    let fake = Fake::sync(move |process| {
        let argv = words(process);
        seen.lock().unwrap().push(argv.clone());
        let query = field(&argv, "query").unwrap_or_default();
        let get = |name: &str| field(&argv, name);
        let mut state = pending.lock().unwrap();
        let data = if query.contains("reviews(states: PENDING") {
            // GitHub's shape: the side is the thread's, a comment names its
            // review, and fullDatabaseId is a string (no databaseId).
            assert!(
                !regex::Regex::new(r"\bdatabaseId\b")
                    .unwrap()
                    .is_match(&query)
            );
            assert!(query.contains("reviewThreads"));
            let mut threads = vec![json!({
                // A published thread of someone else: not a draft.
                "id": "T0", "diffSide": "LEFT", "comments": {"nodes": [{
                    "id": "X1", "fullDatabaseId": "5", "body": "old", "path": "a.c", "line": 1,
                    "originalLine": 1, "startLine": null, "replyTo": null, "pullRequestReview": {"id": "R0"},
                }]},
            })];
            threads.extend(
                state
                    .comments
                    .iter()
                    .map(|comment| json!({"diffSide": "RIGHT", "comments": {"nodes": [comment]}})),
            );
            json!({"repository": {"pullRequest": {
                "id": "PR1",
                "reviews": {"nodes": state.review.iter().cloned().collect::<Vec<_>>()},
                "reviewThreads": {"nodes": threads},
            }}})
        } else if query.contains("addPullRequestReview(") {
            state.review = Some(json!({"id": "R1", "body": ""}));
            json!({"addPullRequestReview": {"pullRequestReview": {"id": "R1", "state": "PENDING"}}})
        } else if query.contains("addPullRequestReviewThread(") {
            let comment = json!({
                "id": "C9", "fullDatabaseId": "9", "body": get("body"), "path": get("path"), "line": 3,
                "originalLine": 3, "startLine": null, "replyTo": null, "pullRequestReview": {"id": "R1"},
            });
            state.comments.push(comment.clone());
            json!({"addPullRequestReviewThread": {"thread": {"diffSide": "RIGHT", "comments": {"nodes": [comment]}}}})
        } else if query.contains("addPullRequestReviewThreadReply") {
            assert_eq!(get("t").as_deref(), Some("T0"));
            assert_eq!(get("r").as_deref(), Some("R1"));
            json!({"addPullRequestReviewThreadReply": {"comment": {
                "id": "C10", "fullDatabaseId": "10", "body": get("b"), "path": "a.c", "line": 1,
                "originalLine": 1, "startLine": null, "replyTo": {"fullDatabaseId": "5"},
                "pullRequestReview": {"id": "R1"},
            }}})
        } else if query.contains("updatePullRequestReviewComment") {
            state.comments[0]["body"] = json!(get("b"));
            json!({"updatePullRequestReviewComment": {"pullRequestReviewComment": state.comments[0]}})
        } else if query.contains("deletePullRequestReviewComment") {
            state.comments.remove(0);
            json!({"deletePullRequestReviewComment": {"pullRequestReview": {"id": "R1"}}})
        } else if query.contains("updatePullRequestReview(") {
            if let Some(review) = state.review.as_mut() {
                review["body"] = json!(get("b"));
            }
            json!({"updatePullRequestReview": {"pullRequestReview": {"id": "R1"}}})
        } else {
            return fail(1, "unexpected");
        };
        ok(json!({ "data": data }).to_string())
    });
    let context = tools(fake).context("/tmp", None);
    let mr = MergeRequestInfo {
        host: "github.com".into(),
        project: "o/r".into(),
        iid: 7,
        forge: Some("github".into()),
        project_path: None,
        url: URL.into(),
        title: String::new(),
        state: "opened".into(),
        base_sha: "b".into(),
        start_sha: "b".into(),
        head_sha: "a".repeat(40),
        updated_at: None,
    };
    let anchor = ReviewAnchor {
        path: Some("a.c".into()),
        line: Some(3),
        side: Some("new".into()),
        ..ReviewAnchor::default()
    };
    let draft = create_draft_note(&context, &mr, &anchor, "nit", None)
        .await
        .unwrap();
    assert_eq!(draft.id, 9);
    assert_eq!(draft.note, "nit");
    assert_eq!(draft.position["new_path"], "a.c");
    assert_eq!(draft.position["new_line"], 3);
    assert_eq!(
        update_draft_note(&context, &mr, 9, "nit 2")
            .await
            .unwrap()
            .note,
        "nit 2"
    );
    create_draft_note(&context, &mr, &ReviewAnchor::default(), "Overall", None)
        .await
        .unwrap();
    assert_eq!(
        state.lock().unwrap().review.as_ref().unwrap()["body"],
        "Overall"
    );
    delete_draft_note(&context, &mr, 9).await.unwrap();
    assert!(state.lock().unwrap().comments.is_empty());
    // A reply is a draft of the pending review, in its discussion.
    let error = create_draft_reply(&context, &mr, "1", "x")
        .await
        .unwrap_err();
    assert!(error.contains("no such discussion"), "{error}");
    let reply = create_draft_reply(&context, &mr, "5", "agreed")
        .await
        .unwrap();
    assert_eq!(reply.id, 10);
    assert_eq!(reply.note, "agreed");
    assert_eq!(reply.discussion_id.as_deref(), Some("5"));
    let all = calls
        .lock()
        .unwrap()
        .iter()
        .map(|argv| argv.join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    // Never an event: nothing is submitted.
    assert!(
        !regex::Regex::new(r"submitPullRequestReview|event|APPROVE|COMMENT\b|REQUEST_CHANGES")
            .unwrap()
            .is_match(&all)
    );
    assert!(!all.contains("/comments/"), "no public comment");
}

#[tokio::test]
async fn a_dead_master_reruns_a_read_cold_never_a_write() {
    // The host layer reruns a read cold when its master died under it
    // (runSshCommand); a write runs once. What decides is the read flag
    // each gh call carries.
    let runs: Arc<Mutex<usize>> = Arc::default();
    let counted = runs.clone();
    let fake = Fake::sync(move |process| {
        let ForgeProcess::Ssh { read, .. } = process else {
            panic!("over SSH");
        };
        // The master dies under the first, multiplexed run.
        let mut runs = counted.lock().unwrap();
        *runs += 1;
        if *read {
            *runs += 1;
            return ok("{}");
        }
        fail(255, "")
    });
    let context = tools(fake).context("/tmp", Some("gh-box".into()));
    let attempts = |runs: &Arc<Mutex<usize>>| std::mem::take(&mut *runs.lock().unwrap());
    let query = |text: &str| GhOptions {
        fields: vec![("query".into(), text.into(), FieldKind::Raw)],
        kind: Some("drafts"),
        paginate: false,
    };
    let _ = gh_api(
        &context,
        "github.com",
        "GET",
        "repos/o/r/pulls/8",
        GhOptions::default(),
    )
    .await;
    assert_eq!(attempts(&runs), 2);
    let _ = gh_api(
        &context,
        "github.com",
        "POST",
        "graphql",
        query("query { viewer { login } }"),
    )
    .await;
    assert_eq!(attempts(&runs), 2);
    let _ = gh_api(
        &context,
        "github.com",
        "POST",
        "graphql",
        query("mutation($r: ID!) { addPullRequestReviewThread(input: {pullRequestReviewId: $r}) { thread { id } } }"),
    )
    .await;
    assert_eq!(attempts(&runs), 1);
    for method in ["POST", "PATCH", "DELETE"] {
        let _ = gh_api(
            &context,
            "github.com",
            method,
            "repos/o/r/pulls/8/comments",
            GhOptions::default(),
        )
        .await;
        assert_eq!(attempts(&runs), 1, "{method}");
    }
}
