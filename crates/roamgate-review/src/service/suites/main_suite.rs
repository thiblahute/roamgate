//! server/src/review/service.test.ts: the cases the first port left.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::{Value, json};

use super::*;
use crate::model::{ReviewSession, thread_needs_answer};
use crate::parse::file_change_place;

fn prompting(delay: u64) -> (Host, Options) {
    (
        Host::default(),
        Options {
            delivery_delay_ms: Some(delay),
            ..Options::default()
        },
    )
}

#[tokio::test(start_paused = true)]
async fn activity_reads_each_checkout_on_its_own_a_slow_one_told_unreadable() {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = asked.clone();
    let host = Host {
        heads: Some(Box::new(move |_, entries| {
            let seen = seen.clone();
            Box::pin(async move {
                let root = entries[0].0.clone();
                seen.lock().unwrap().push(format!("{root} {}", entries.len()));
                let count = entries.len();
                if root == "/slow" {
                    std::future::pending::<()>().await;
                }
                Ok(vec![Some("aaaaaaa1".to_owned()); count])
            })
        })),
        ..Host::default()
    };
    let Kit { service, .. } = kit(host, Options::default());
    let open = |root: &str, head: &str| {
        service
            .open(&json!({"connectionId": "local", "root": root,
                "target": {"kind": "range", "base": "main", "head": head}, "raise": false}))
            .unwrap()
            .session
            .id
    };
    let fast = open("/fast", "HEAD");
    let fast_too = open("/fast", "topic");
    let slow = open("/slow", "HEAD");
    let other = open("/other", "HEAD");
    let answer = service
        .activity(&json!({"connectionId": "local", "sessionIds": [fast, fast_too, slow]}))
        .await
        .unwrap();
    let mut read = asked.lock().unwrap().clone();
    read.sort();
    assert_eq!(read, vec!["/fast 2", "/slow 1"]);
    assert_eq!(
        answer["activity"],
        json!([
            {"sessionId": fast, "headSha": "aaaaaaa1", "newCommits": false},
            {"sessionId": fast_too, "headSha": "aaaaaaa1", "newCommits": false},
            {"sessionId": slow, "newCommits": false, "unreadable": true},
        ])
    );
    let alone = service
        .activity(&json!({"connectionId": "local", "sessionIds": [other]}))
        .await
        .unwrap();
    assert_eq!(alone["activity"][0]["sessionId"], json!(other));
    assert_eq!(alone["activity"].as_array().unwrap().len(), 1);
    let error = service
        .activity(&json!({"connectionId": "local", "sessionIds": "nope"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("sessionIds is a list"), "{error:?}");
}

#[tokio::test]
async fn the_commit_the_overlay_showed_gone_brings_the_patch_ids_along() {
    let asked: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (seen, failing) = (asked.clone(), fail.clone());
    let host = Host {
        commits: Some(Box::new(|_| {
            Box::pin(async { Ok(vec![commit(sha("a"), "a"), commit(sha("b"), "b")]) })
        })),
        patch_ids: Some(Box::new(move |_, shas| {
            seen.lock().unwrap().push(shas.clone());
            let fail = failing.load(std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                if fail {
                    return Err(LoadError::Failed("git patch-id failed".into()));
                }
                Ok(shas
                    .iter()
                    .map(|s| (s.clone(), format!("p{}", &s[..1])))
                    .collect::<IndexMap<_, _>>())
            })
        })),
        ..Host::default()
    };
    let Kit { service, .. } = kit(host, Options::default());
    let id = open_range(&service).id;
    for follow in [json!(sha("a")), Value::Null, json!("HEAD; rm")] {
        let mut params = json!({"sessionId": id});
        if !follow.is_null() {
            params["follow"] = follow;
        }
        assert!(service.commits(&params).await.unwrap().get("patchIds").is_none());
    }
    assert!(asked.lock().unwrap().is_empty());
    let result = service
        .commits(&json!({"sessionId": id, "follow": sha("9")}))
        .await
        .unwrap();
    assert_eq!(*asked.lock().unwrap(), vec![vec![sha("9"), sha("a"), sha("b")]]);
    assert_eq!(result["patchIds"][sha("9")], json!("p9"));
    assert_eq!(result["commits"].as_array().unwrap().len(), 2);
    fail.store(true, std::sync::atomic::Ordering::SeqCst);
    let plain = service
        .commits(&json!({"sessionId": id, "follow": sha("9")}))
        .await
        .unwrap();
    assert_eq!(plain["commits"].as_array().unwrap().len(), 2);
    assert!(plain.get("patchIds").is_none());
}

#[tokio::test]
async fn the_view_a_review_opens_on_loads_with_its_commits_from_one_listing() {
    let listings = Arc::new(Mutex::new(0usize));
    let diffs: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let commits = Arc::new(Mutex::new(vec!["a", "b"]));
    let (counted, asked, listed) = (listings.clone(), diffs.clone(), commits.clone());
    let host = Host {
        diff: Some(Box::new(move |_, commit, _| {
            asked.lock().unwrap().push(commit);
            Box::pin(async { Ok(json!({"files": [], "truncated": false, "headSha": sha("f")})) })
        })),
        commits: Some(Box::new(move |_| {
            let (counted, listed) = (counted.clone(), listed.clone());
            Box::pin(async move {
                *counted.lock().unwrap() += 1;
                let list: Vec<_> = listed
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|c| commit(sha(c), c))
                    .collect();
                sleep(5).await;
                Ok(list)
            })
        })),
        ..Host::default()
    };
    let Kit { service, .. } = kit(host, Options::default());
    let id = open_range(&service).id;
    let (listed_params, first_params) = (
        json!({"sessionId": id, "recheck": true}),
        json!({"sessionId": id, "first": true}),
    );
    let (list, first) = tokio::join!(
        service.commits(&listed_params),
        service.diff(&first_params),
    );
    let (list, first) = (list.unwrap(), first.unwrap());
    assert_eq!(*listings.lock().unwrap(), 1);
    assert_eq!(
        list["commits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["sha"].clone())
            .collect::<Vec<_>>(),
        vec![json!(sha("a")), json!(sha("b"))]
    );
    assert_eq!(first["view"], json!(sha("a")));
    assert_eq!(*diffs.lock().unwrap(), vec![Some(sha("a"))]);
    commits.lock().unwrap().clear();
    let all = service
        .diff(&json!({"sessionId": id, "first": true}))
        .await
        .unwrap();
    assert_eq!(all["view"], Value::Null);
    assert_eq!(*diffs.lock().unwrap(), vec![Some(sha("a")), None]);
    service.commits(&json!({"sessionId": id})).await.unwrap();
    assert_eq!(*listings.lock().unwrap(), 3);
}

#[tokio::test]
async fn a_merge_requests_review_is_never_given_up_for_its_checkout() {
    let calls = Arc::new(Mutex::new(0usize));
    let counted = calls.clone();
    let host = Host {
        diff: Some(Box::new(move |_, _, _| {
            *counted.lock().unwrap() += 1;
            Box::pin(async {
                Err(LoadError::Gone {
                    code: "checkout-gone".into(),
                    message: "gone".into(),
                })
            })
        })),
        ..Host::default()
    };
    let Kit { service, .. } = kit(host, Options::default());
    let session = service
        .open(&json!({"connectionId": "local", "root": "/gone",
            "target": {"kind": "mr", "url": "https://gitlab.example/gst/gstreamer/-/merge_requests/42"}}))
        .unwrap()
        .session;
    for _ in 0..2 {
        let error = service
            .diff(&json!({"sessionId": session.id}))
            .await
            .unwrap_err();
        assert!(error.message.contains("gone"));
    }
    assert_eq!(*calls.lock().unwrap(), 2);
}

fn gitlab_kit(gitlab: Arc<Gitlab>, delay: Option<u64>) -> Kit {
    let host = Host {
        forge: Some(gitlab),
        heads: None,
        ..Host::default()
    };
    kit(
        host,
        Options {
            delivery_delay_ms: delay,
            clock: Some(Moved::at(1_761_732_000_000)),
            ..Options::default()
        },
    )
}

#[tokio::test]
async fn a_merge_requests_review_sends_your_discussions_to_the_agent_as_written() {
    let gitlab = Gitlab::new(|_| {
        Ok(Some(json!({"url": "https://gitlab.example/gst/gstreamer/-/merge_requests/3",
            "title": "Fix", "number": 3, "state": "opened", "branch": "fix"})))
    });
    gitlab.state.lock().unwrap().api = true;
    gitlab.state.lock().unwrap().next_draft = 11;
    let Kit { service, host, .. } = gitlab_kit(gitlab, Some(10));
    let local = service
        .open(&json!({"connectionId": "local", "root": "/repo", "workspaceId": "w1",
            "target": {"kind": "range", "base": "main", "head": "HEAD"}}))
        .unwrap()
        .session;
    let opened = service
        .open_gitlab(&json!({"sessionId": local.id}))
        .await
        .unwrap();
    let session: ReviewSession =
        serde_json::from_value(opened["snapshot"]["session"].clone()).unwrap();
    assert!(session.gitlab);
    assert_eq!(session.auto_send, Some(true));
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "a.c", "line": 3, "side": "new"},
            "text": "Is it similar to enough features?"}))
        .await
        .unwrap();
    service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 2, "side": "new"}, "text": "Leak"}))
        .await
        .unwrap();
    sleep(40).await;
    assert!(host.texts().is_empty());
    service
        .update(&json!({"sessionId": session.id, "agent": "Claude", "paneId": "w1:p2"}))
        .await
        .unwrap();
    sleep(100).await;
    let texts = host.texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("Is it similar to enough features?"));
    assert!(!texts[0].contains("Leak"));
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": "a.c", "line": 4, "side": "new"},
            "text": "And here?"}))
        .await
        .unwrap();
    sleep(100).await;
    let texts = host.texts();
    assert_eq!(texts.len(), 2);
    assert!(texts[1].contains("And here?"));
}

#[tokio::test]
async fn a_merge_requests_review_drafts_are_draft_notes_agents_write_only_here() {
    let project = Arc::new(Mutex::new("gst/gstreamer".to_owned()));
    let named = project.clone();
    let gitlab = Gitlab::new(move |_| {
        Ok(Some(json!({"url": format!("https://gitlab.example/{}/-/merge_requests/3", named.lock().unwrap()),
            "title": "Fix", "number": 3, "state": "opened", "branch": "fix"})))
    })
    .with_api(11);
    let Kit {
        service, clock, ..
    } = gitlab_kit(gitlab.clone(), None);
    let local = service
        .open(&json!({"connectionId": "local", "root": "/repo", "workspaceId": "w1",
            "target": {"kind": "range", "base": "main", "head": "HEAD"}, "agent": "Claude"}))
        .unwrap()
        .session;
    let opened = service
        .open_gitlab(&json!({"sessionId": local.id}))
        .await
        .unwrap();
    assert_eq!(opened["mergeRequest"]["number"], json!(3));
    let session: ReviewSession =
        serde_json::from_value(opened["snapshot"]["session"].clone()).unwrap();
    assert_eq!(
        session.target.to_value(),
        json!({"kind": "mr", "url": "https://gitlab.example/gst/gstreamer/-/merge_requests/3"})
    );
    assert!(session.gitlab);
    assert_eq!(session.workspace_id.as_deref(), Some("w1"));
    assert_eq!(session.agent.name.as_deref(), Some("Claude"));
    let again = service
        .open_gitlab(&json!({"sessionId": local.id}))
        .await
        .unwrap();
    assert_eq!(again["snapshot"]["session"]["id"], json!(session.id));
    service
        .refresh_gitlab(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let draft = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 2, "side": "new"}, "text": "Leak"}))
        .await
        .unwrap();
    assert_eq!(draft.id, "gldraft:11");
    assert_eq!(gitlab.posted().len(), 1);
    let snapshot = service.get(&json!({"sessionId": session.id})).unwrap();
    assert_eq!(ids(&snapshot.threads, |t| t.id.clone()), vec!["gl:d1", "gldraft:11"]);
    assert!(!snapshot.merge_request.as_ref().unwrap().security);
    let reply = service
        .reply(&json!({"sessionId": session.id, "commentId": "gl:d1", "author": "Claude", "text": "I agree"}))
        .await
        .unwrap();
    assert_eq!(reply.kind, "draft");
    assert_eq!(reply.gitlab_reply_to.as_deref(), Some("d1"));
    assert!(!reply.id.starts_with("gl"));
    let comment = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 2, "side": "new"}, "author": "Claude", "text": "Also here"}))
        .await
        .unwrap();
    assert!(comment.gitlab.is_none());
    service
        .agent_summary(&json!({"sessionId": session.id, "author": "Claude", "text": "Fine overall"}))
        .await
        .unwrap();
    let summary_unsent = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": session.id}))
            .unwrap()
            .session
            .summary_unsent
    };
    assert_eq!(summary_unsent(&service), Some(true));
    assert_eq!(gitlab.posted().len(), 1);
    service
        .push_local_drafts(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let posted = gitlab.posted();
    assert_eq!(posted.len(), 4);
    assert!(posted[3].contains("note=Fine overall"));
    assert_eq!(summary_unsent(&service), None);
    assert!(posted[1].contains("in_reply_to_discussion_id=d1"));
    assert!(posted[1].contains("note=I agree"));
    assert!(!posted[2].contains("in_reply_to_discussion_id=d1"));
    assert!(posted[2].contains("note=Also here"));
    let sent = service.get(&json!({"sessionId": session.id})).unwrap().threads;
    assert!(sent.iter().all(|t| t.gitlab.is_some()));
    let last = sent
        .iter()
        .find(|t| t.id == "gl:d1")
        .unwrap()
        .comments
        .last()
        .unwrap()
        .clone();
    assert_eq!(last.gitlab_draft_id, Some(12));
    assert_eq!(last.body, "I agree");
    let error = service
        .edit(&json!({"sessionId": session.id, "commentId": "gldraft:11", "author": "Claude", "text": "Mine now"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("only your own draft notes"), "{error:?}");
    service
        .edit(&json!({"sessionId": session.id, "commentId": "gldraft:12", "text": "Agreed"}))
        .await
        .unwrap();
    let posted = gitlab.posted();
    assert_eq!(posted.len(), 5);
    assert!(posted[4].contains("draft_notes/12"));
    let local_now = service.get(&json!({"sessionId": local.id})).unwrap();
    assert!(local_now.threads.is_empty());
    assert!(local_now.merge_request.is_none());

    *project.lock().unwrap() = "gst/security".into();
    clock.advance(6 * 60_000);
    let secure = service
        .open_gitlab(&json!({"sessionId": local.id}))
        .await
        .unwrap();
    let secure = secure["snapshot"]["session"]["id"].as_str().unwrap().to_owned();
    assert_ne!(secure, session.id);
    service
        .refresh_gitlab(&json!({"sessionId": secure}))
        .await
        .unwrap();
    assert!(
        service
            .get(&json!({"sessionId": secure}))
            .unwrap()
            .merge_request
            .unwrap()
            .security
    );
    let error = service
        .assert_agent_allowed(&json!({"sessionId": secure, "author": "Claude"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("security merge request"), "{error:?}");
}

#[tokio::test]
async fn agent_review_the_previous_pass_goes_the_prompt_reaches_the_pane() {
    let Kit { service, host, .. } = plain();
    let session = open_range(&service);
    service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft", "author": "Claude", "text": "old pass"}))
        .await
        .unwrap();
    let kept = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft", "author": "Claude", "text": "edited by me"}))
        .await
        .unwrap();
    service
        .edit(&json!({"sessionId": session.id, "commentId": kept.id, "text": "mine now"}))
        .await
        .unwrap();
    service
        .request_agent_review(&json!({"sessionId": session.id, "focus": "locking"}))
        .await
        .unwrap();
    let after = service.get(&json!({"sessionId": session.id})).unwrap();
    assert_eq!(
        ids(&after.threads, |t| t.comments[0].body.clone()),
        vec!["mine now"]
    );
    assert_eq!(
        after.session.agent.working.unwrap().message.as_deref(),
        Some("reviewing")
    );
    let prompted = host.prompted();
    assert_eq!(prompted.len(), 1);
    assert_eq!(prompted[0].pane, "w1:p2");
    assert!(prompted[0].text.contains("Focus on: locking"));
    assert!(prompted[0]
        .text
        .contains(&format!("--session {}", &session.id[..8])));
    assert_eq!(
        service
            .agent_summary(&json!({"sessionId": session.id, "author": "Claude", "text": "Looks right"}))
            .await
            .unwrap(),
        json!({"kept": true})
    );
    service
        .update(&json!({"sessionId": session.id, "summary": "My words"}))
        .await
        .unwrap();
    assert_eq!(
        service
            .agent_summary(&json!({"sessionId": session.id, "author": "Claude", "text": "Override"}))
            .await
            .unwrap(),
        json!({"kept": false})
    );
    service
        .handoff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    let texts = host.texts();
    assert_eq!(texts.len(), 2);
    assert!(texts[1].contains("My words"));
    let watcher = service.clone();
    let id = session.id.clone();
    let waiting = tokio::spawn(async move {
        watcher
            .watch(&json!({"sessionId": id, "agent": "Claude", "mode": "any", "timeoutMs": 1000}), None)
            .await
    });
    sleep(20).await;
    service
        .handoff(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().outcome, "handoff");
    assert_eq!(host.texts().len(), 2);
}

#[tokio::test]
async fn the_overall_comment_goes_to_the_agent_with_a_handoff_once() {
    let Kit { service, host, .. } = plain();
    let session = open_range(&service);
    let id = session.id.clone();
    service
        .update(&json!({"sessionId": id, "summary": "All good"}))
        .await
        .unwrap();
    service.handoff(&json!({"sessionId": id})).await.unwrap();
    assert_eq!(host.texts().len(), 1);
    assert!(host.texts()[0].contains("My overall comment on the review:\n  All good"));
    service.handoff(&json!({"sessionId": id})).await.unwrap();
    assert!(!host.texts()[1].contains("All good"));
    service
        .update(&json!({"sessionId": id, "summary": "Ship it"}))
        .await
        .unwrap();
    let watcher = service.clone();
    let watched = id.clone();
    let waiting = tokio::spawn(async move {
        watcher
            .watch(&json!({"sessionId": watched, "agent": "Claude", "mode": "any", "timeoutMs": 1000}), None)
            .await
    });
    sleep(20).await;
    service.handoff(&json!({"sessionId": id})).await.unwrap();
    let woke = waiting.await.unwrap().unwrap();
    assert_eq!(woke.outcome, "handoff");
    assert_eq!(woke.summary.as_deref(), Some("Ship it"));
    assert_eq!(host.texts().len(), 2);
    service
        .update(&json!({"sessionId": id, "summary": ""}))
        .await
        .unwrap();
    service
        .agent_summary(&json!({"sessionId": id, "author": "Claude", "text": "Looks right"}))
        .await
        .unwrap();
    service.handoff(&json!({"sessionId": id})).await.unwrap();
    assert!(!host.texts()[2].contains("Looks right"));
}

#[tokio::test]
async fn a_comment_on_a_commit_message_reaches_the_agent_as_such() {
    let (host, options) = prompting(10);
    let Kit { service, host, .. } = kit(host, options);
    let session = open_range(&service);
    service
        .add_thread(&json!({"sessionId": session.id, "anchor": {"path": ":commit-message", "line": 1,
            "side": "new", "text": "cuda: fix", "commit": sha("a"), "commitSubject": "cuda: fix"},
            "text": "Say what it fixes"}))
        .await
        .unwrap();
    sleep(60).await;
    assert!(host.texts()[0].contains("on line 1 of the commit message in \"cuda: fix\""));
}

#[tokio::test]
async fn a_comment_on_a_part_of_a_message_reaches_the_agent_with_its_quote() {
    let (host, options) = prompting(10);
    let Kit { service, host, .. } = kit(host, options);
    let session = open_range(&service);
    let anchor = json!({"path": "plan.md", "line": 3, "side": "new"});
    let plan = service
        .add_thread(&json!({"sessionId": session.id, "author": "Claude", "anchor": anchor,
            "text": "Option A.\n\nOption B, which I lean to."}))
        .await
        .unwrap();
    let message = json!({"thread": plan.id, "comment": plan.comments[0].id, "quote": "Option B, which I lean to."});
    let mut on_part = anchor.clone();
    on_part["message"] = message.clone();
    let part = service
        .add_thread(&json!({"sessionId": session.id, "anchor": on_part, "text": "Why B?"}))
        .await
        .unwrap();
    assert_eq!(to_json(&part.anchor.message), message);
    sleep(60).await;
    let prompt = host.texts().join("\n");
    assert!(prompt.contains(&format!(
        "on a part of a message in thread [{}] (on plan.md:3)",
        &plan.id[..8]
    )));
    assert!(prompt.contains("  > Option B, which I lean to."));
    assert!(prompt.contains("Why B?"));
    let mut blank = anchor.clone();
    blank["message"] = json!({"thread": plan.id, "comment": plan.comments[0].id, "quote": " "});
    let whole = service
        .add_thread(&json!({"sessionId": session.id, "anchor": blank, "text": "No quote"}))
        .await
        .unwrap();
    assert_eq!(
        to_json(&whole.anchor.message),
        json!({"thread": plan.id, "comment": plan.comments[0].id})
    );
    sleep(60).await;
    assert!(host.texts().join("\n").contains(&format!(
        "on a message in thread [{}] (on plan.md:3)",
        &plan.id[..8]
    )));
    let mut bare = anchor.clone();
    bare["message"] = json!({"thread": plan.id});
    let error = service
        .add_thread(&json!({"sessionId": session.id, "anchor": bare, "text": "No comment"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("a message part needs its thread and comment"));
}

fn chat_host() -> Host {
    Host {
        diff: Some(Box::new(|_, _, _| {
            Box::pin(async { Err(LoadError::Failed("a chat has no diff".into())) })
        })),
        ..Host::default()
    }
}

fn delay(ms: u64) -> Options {
    Options {
        delivery_delay_ms: Some(ms),
        ..Options::default()
    }
}

#[tokio::test]
async fn a_chats_threads_no_diff_kept_out_of_the_reviews_sent_with_context() {
    let Kit { service, host, .. } = kit(chat_host(), delay(10));
    let review = open_range(&service);
    let chat = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "chat", "chat": "claude-session-1"}, "agent": "Claude", "paneId": "w1:p2"}))
        .unwrap()
        .session;
    assert_ne!(chat.id, review.id);
    assert_eq!(chat.title, "chat");
    assert_eq!(
        service
            .open(&json!({"connectionId": "local", "root": "/repo",
                "target": {"kind": "chat", "chat": "claude-session-1"}}))
            .unwrap()
            .session
            .id,
        chat.id
    );
    assert_eq!(
        service.diff(&json!({"sessionId": chat.id})).await.unwrap(),
        json!({"files": [], "truncated": false})
    );
    assert_eq!(
        ids(
            &service.list(&json!({"connectionId": "local", "root": "/repo"})),
            |s| s.session.id.clone()
        ),
        vec![review.id.clone()]
    );
    let thread = service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"chat": {"entry": "entry-7",
            "at": "2026-10-27T14:32:00", "excerpt": "I still can't reach the review",
            "quote": "Could you reopen the review?"}}, "text": "Yes, done."}))
        .await
        .unwrap();
    assert_eq!(thread.anchor.chat.as_ref().unwrap().entry, "entry-7");
    sleep(60).await;
    let prompt = host.texts().join("\n");
    assert!(prompt.contains("from me on parts of your messages in this chat"));
    assert!(prompt.contains(
        "on your message of 14:32 that starts \"I still can't reach the review\", about this part:"
    ));
    assert!(prompt.contains("  > Could you reopen the review?"));
    assert!(prompt.contains("not on code"));
    host.clear();
    service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"message": {"thread": thread.id,
            "comment": thread.comments[0].id, "quote": "Yes, done."}}, "text": "Which one?"}))
        .await
        .unwrap();
    sleep(60).await;
    let prompt = host.texts().join("\n");
    assert!(prompt.contains(&format!(
        "on a part of a message in thread [{}]:",
        &thread.id[..8]
    )));
    assert!(!prompt.contains("the whole change"));
    let error = service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"chat": {"entry": "entry-7", "quote": ""}},
            "text": "No quote"}))
        .await
        .unwrap_err();
    assert!(error.message.contains("a chat part needs its message and quote"));
}

#[tokio::test]
async fn a_comment_on_a_file_a_chats_tool_call_changed_says_the_file_and_lines() {
    let Kit { service, host, .. } = kit(chat_host(), delay(10));
    let chat = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "chat", "chat": "claude-session-1"}, "agent": "Claude", "paneId": "w1:p2"}))
        .unwrap()
        .session;
    let thread = service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"path": "/repo/plans/desktop-move.md",
            "line": 12, "endLine": 13, "side": "new", "text": "## Moving the desktop",
            "chat": {"entry": "entry-9", "at": "2026-10-27T14:32:00", "call": "toolu_01",
                "quote": "## Moving the desktop\nFirst, the disks."}}, "text": "Say which disks."}))
        .await
        .unwrap();
    assert_eq!(
        thread.anchor.chat.as_ref().unwrap().call.as_deref(),
        Some("toolu_01")
    );
    assert_eq!(thread.anchor.line, Some(12));
    assert_eq!(thread.anchor.end_line, Some(13));
    assert_eq!(thread.anchor.text.as_deref(), Some("## Moving the desktop"));
    service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"path": "/repo/plans/desktop-move.md",
            "chat": {"entry": "entry-9", "call": "toolu_01", "quote": "/repo/plans/desktop-move.md"}},
            "text": "Too long."}))
        .await
        .unwrap();
    sleep(60).await;
    let prompt = host.texts().join("\n");
    assert!(prompt.contains("on /repo/plans/desktop-move.md:12-13 (lines 12-13 as your change of 14:32 left the file), about these lines:\n  > ## Moving the desktop\n  > First, the disks."), "{prompt}");
    assert!(prompt.contains(
        "on the file /repo/plans/desktop-move.md, as your change left it:\n  Too long."
    ));
    assert!(prompt.contains("from me on files you changed in this chat:"));
    assert!(!prompt.contains("on parts of your messages"));
    assert!(prompt.contains("as review comments on code are"));
    assert!(!prompt.contains("not on code"));
    let anchor = serde_json::from_value(json!({"path": "/repo/a.ts", "line": 4, "side": "old"})).unwrap();
    assert_eq!(
        file_change_place(&anchor, Some("2026-10-27T14:32:00")),
        "on /repo/a.ts:4 (line 4 as the file was before your change of 14:32, which removed it), about this line"
    );
}

#[tokio::test]
async fn a_ranger_chats_threads_go_to_ranger_answered_with_its_own_tool() {
    let busy = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let still = busy.clone();
    let host = Host {
        prompt: Some(Box::new(move |_, _, _| {
            if still.load(std::sync::atomic::Ordering::SeqCst) {
                Err("Ranger is busy in another chat".into())
            } else {
                Ok(())
            }
        })),
        reply_how: Some(Box::new(|session| match &session.target {
            crate::model::ReviewTarget::Chat { chat } if chat.starts_with("ranger:") => {
                Some("your `chat_thread_reply` tool".into())
            }
            _ => None,
        })),
        ..Host::default()
    };
    let Kit { service, host, .. } = kit(
        host,
        Options {
            delivery_delay_ms: Some(10),
            retry_delay_ms: Some(20),
            ..Options::default()
        },
    );
    let chat = service
        .open(&json!({"connectionId": "local", "workspaceId": "ranger", "root": "/",
            "target": {"kind": "chat", "chat": "ranger:chat-one"}, "agent": "Ranger", "paneId": "ranger:chat-one"}))
        .unwrap()
        .session;
    let thread = service
        .add_thread(&json!({"sessionId": chat.id, "anchor": {"chat": {"entry": "reply-1", "quote": "It waits for you."}},
            "text": "Which conflict?"}))
        .await
        .unwrap();
    sleep(25).await;
    assert!(host.prompted().is_empty());
    assert!(service
        .get(&json!({"sessionId": chat.id}))
        .unwrap()
        .session
        .delivery_error
        .unwrap()
        .contains("busy"));
    busy.store(false, std::sync::atomic::Ordering::SeqCst);
    sleep(60).await;
    let prompted = host.prompted();
    assert_eq!(prompted.len(), 1);
    assert_eq!(prompted[0].pane, "ranger:chat-one");
    assert!(prompted[0].text.starts_with("[Roamgate chat comment]\n"));
    assert!(prompted[0].text.contains(&format!("[{}]", &thread.id[..8])));
    assert!(prompted[0].text.ends_with(
        "Answer in each thread, not in the chat: your `chat_thread_reply` tool."
    ));
    assert!(!prompted[0].text.contains("roamgate-review"));
    let answered = service
        .reply_in_chat("ranger:chat-one", &thread.id[..8], "The one in server/src/index.ts.", "Ranger")
        .unwrap();
    assert_eq!(
        ids(&answered.comments, |c| c.author.clone()),
        vec!["you", "Ranger"]
    );
    let error = service
        .reply_in_chat("ranger:chat-two", &thread.id, "Wrong chat", "Ranger")
        .unwrap_err();
    assert!(error.message.contains("no such comment in this chat"));
    sleep(40).await;
    assert_eq!(host.prompted().len(), 1);
}

#[tokio::test]
async fn an_edit_to_an_answered_comment_reaches_the_agent_again() {
    let Kit { service, host, .. } = kit(Host::default(), delay(10));
    let session = open_range(&service);
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "text": "Do you see me?"}))
        .await
        .unwrap();
    sleep(40).await;
    assert_eq!(host.texts().len(), 1);
    let answered = service
        .reply(&json!({"sessionId": session.id, "commentId": thread.id, "author": "Claude", "text": "Yes"}))
        .await
        .unwrap();
    assert!(!thread_needs_answer(&answered, "Claude", false));
    sleep(5).await;
    let edited = service
        .edit(&json!({"sessionId": session.id, "commentId": thread.comments[0].id, "text": "Do you see me now?"}))
        .await
        .unwrap();
    assert!(thread_needs_answer(&edited, "Claude", false));
    sleep(40).await;
    let texts = host.texts();
    assert_eq!(texts.len(), 2);
    assert!(texts[1].contains("I edited my comment"));
    assert!(texts[1].contains("Do you see me now?"));
    sleep(5).await;
    let rewritten = service
        .edit(&json!({"sessionId": session.id, "commentId": answered.comments[1].id,
            "author": "Claude", "text": "Yes, now too"}))
        .await
        .unwrap();
    assert!(!thread_needs_answer(&rewritten, "Claude", false));
}

#[tokio::test]
async fn in_a_local_review_a_suggested_change_goes_to_the_agent() {
    let Kit { service, host, .. } = kit(Host::default(), delay(20));
    let session = open_range(&service);
    service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 3, "side": "new", "text": "x = 1;"}, "text": "Nit: naming"}))
        .await
        .unwrap();
    sleep(80).await;
    assert!(host.texts().is_empty());
    service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 4, "side": "new", "text": "y = 2;"},
            "text": "```suggestion:-0+0\ny = 3;\n```"}))
        .await
        .unwrap();
    sleep(80).await;
    let texts = host.texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("y = 3;"));
    assert!(texts[0].contains("A suggested change: apply it"));
    assert!(!texts[0].contains("Nit: naming"));
}

/// findSetup: the checkout's head through loadHeads, GitLab's lookups
/// counted, its API only with `api`.
fn find_setup(gitlab: Arc<Gitlab>) -> Kit {
    let state = gitlab.clone();
    let host = Host {
        forge: Some(gitlab),
        heads: Some(Box::new(move |_, entries| {
            let head = state.state.lock().unwrap().head.clone();
            Box::pin(async move { Ok(entries.iter().map(|_| head.clone()).collect()) })
        })),
        ..Host::default()
    };
    kit(
        host,
        Options {
            clock: Some(Moved::at(1_761_732_000_000)),
            ..Options::default()
        },
    )
}

async fn find(service: &ReviewService, id: &str) -> Value {
    service
        .find_gitlab(&json!({"sessionId": id}))
        .await
        .unwrap()
}

#[tokio::test]
async fn a_local_review_finds_its_branchs_merge_request_cached_until_the_head_moves() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request())));
    let Kit { service, clock, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    assert_eq!(
        find(&service, &session.id).await,
        json!({"mergeRequest": {"url": FIX_URL, "title": "Fix the leak", "number": 10046}})
    );
    tokio::join!(find(&service, &session.id), find(&service, &session.id));
    assert_eq!(gitlab.finds(), 1);
    gitlab.state.lock().unwrap().head = Some("b2".into());
    find(&service, &session.id).await;
    assert_eq!(gitlab.finds(), 2);
    clock.advance(6 * 60_000);
    find(&service, &session.id).await;
    assert_eq!(gitlab.finds(), 3);
    assert!(!service.get(&json!({"sessionId": session.id})).unwrap().session.gitlab);
}

#[tokio::test]
async fn no_merge_request_another_branch_or_a_failure_none_quietly() {
    let answer: Arc<Mutex<Result<Option<Value>, String>>> = Arc::new(Mutex::new(Ok(None)));
    let given = answer.clone();
    let gitlab = Gitlab::new(move |_| given.lock().unwrap().clone());
    let Kit { service, clock, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    assert_eq!(find(&service, &session.id).await["mergeRequest"], Value::Null);
    *answer.lock().unwrap() = Err("glab: network down".into());
    gitlab.state.lock().unwrap().head = Some("b2".into());
    assert_eq!(find(&service, &session.id).await["mergeRequest"], Value::Null);
    clock.advance(61_000);
    *answer.lock().unwrap() = Ok(Some(fix_request()));
    assert_eq!(
        find(&service, &session.id).await["mergeRequest"]["number"],
        json!(10046)
    );
    assert_eq!(gitlab.finds(), 3);
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "feature"}, "raise": false}))
        .unwrap()
        .session;
    assert_eq!(find(&service, &other.id).await["mergeRequest"], Value::Null);
    let Kit { service: plain, .. } = plain();
    let alone = open_range(&plain);
    assert_eq!(find(&plain, &alone.id).await["mergeRequest"], Value::Null);
}

#[tokio::test]
async fn a_merge_request_review_is_offered_locally_only_on_its_own_branch() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request())));
    let Kit { service, .. } = find_setup(gitlab);
    let mr = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "mr", "url": format!("{FIX_URL}/diffs")}, "raise": false}))
        .unwrap()
        .session;
    assert_eq!(
        find(&service, &mr.id).await["mergeRequest"]["number"],
        json!(10046)
    );
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "mr", "url": "https://gitlab.example/gst/gstreamer/-/merge_requests/7"},
            "raise": false}))
        .unwrap()
        .session;
    assert_eq!(find(&service, &other.id).await["mergeRequest"], Value::Null);
}

#[tokio::test]
async fn another_branch_at_the_same_commit_is_looked_up_again() {
    let gitlab = Gitlab::new(|state| {
        let mut request = fix_request();
        request["branch"] = json!(state.branch.clone().unwrap_or_default());
        Ok(Some(request))
    });
    let Kit { service, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    find(&service, &session.id).await;
    find(&service, &session.id).await;
    assert_eq!(gitlab.finds(), 1);
    gitlab.state.lock().unwrap().branch = Some("fix-v2".into());
    find(&service, &session.id).await;
    assert_eq!(gitlab.finds(), 2);
}

#[tokio::test]
async fn gitlab_is_the_merge_requests_review_the_local_review_stays_local() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request())));
    let Kit { service, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    find(&service, &session.id).await;
    let error = service
        .update(&json!({"sessionId": session.id, "gitlab": true}))
        .await
        .unwrap_err();
    assert!(error.message.contains("open the merge request's review"));
    let opened = service
        .open_gitlab(&json!({"sessionId": session.id}))
        .await
        .unwrap();
    assert_eq!(opened["mergeRequest"]["number"], json!(10046));
    let mr = &opened["snapshot"]["session"];
    assert_eq!(mr["target"], json!({"kind": "mr", "url": FIX_URL}));
    assert_eq!(mr["gitlab"], json!(true));
    assert_eq!(mr["root"], json!("/repo"));
    let mr_id = mr["id"].as_str().unwrap().to_owned();
    let error = service
        .update(&json!({"sessionId": mr_id, "gitlab": false}))
        .await
        .unwrap_err();
    assert!(error.message.contains("open the local review instead"));
    let agent = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "mr", "url": format!("{FIX_URL}/diffs")}, "raise": false}))
        .unwrap()
        .session;
    assert_eq!(agent.id, mr_id);
    assert!(!service.get(&json!({"sessionId": session.id})).unwrap().session.gitlab);
    assert_eq!(
        find(&service, &session.id).await["mergeRequest"]["number"],
        json!(10046)
    );
    assert_eq!(gitlab.finds(), 1);
}

#[tokio::test]
async fn only_an_open_merge_request_is_found_for_the_chip_and_gitlab() {
    let state = Arc::new(Mutex::new("merged"));
    let read = state.clone();
    let gitlab = Gitlab::new(move |_| {
        let mut request = fix_request();
        request["state"] = json!(*read.lock().unwrap());
        Ok(Some(request))
    });
    let Kit { service, clock, .. } = find_setup(gitlab);
    let session = open_range(&service);
    assert_eq!(find(&service, &session.id).await["mergeRequest"], Value::Null);
    assert_eq!(
        service
            .open_gitlab(&json!({"sessionId": session.id}))
            .await
            .unwrap(),
        json!({"mergeRequest": null})
    );
    assert_eq!(service.list(&json!({})).len(), 1);
    *state.lock().unwrap() = "opened";
    clock.advance(6 * 60_000);
    assert_eq!(
        service
            .open_gitlab(&json!({"sessionId": session.id}))
            .await
            .unwrap()["mergeRequest"]["number"],
        json!(10046)
    );
    assert_eq!(service.list(&json!({})).len(), 2);
}

#[tokio::test]
async fn a_failed_lookup_no_chip_gitlab_says_why_and_waits_to_retry() {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let failing = fail.clone();
    let gitlab = Gitlab::new(move |_| {
        if failing.load(std::sync::atomic::Ordering::SeqCst) {
            Err("GitLab: 502 Bad Gateway".into())
        } else {
            Ok(Some(fix_request()))
        }
    });
    let Kit { service, clock, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    assert_eq!(find(&service, &session.id).await["mergeRequest"], Value::Null);
    for wait in [0, 30_000] {
        clock.advance(wait);
        let error = service
            .open_gitlab(&json!({"sessionId": session.id}))
            .await
            .unwrap_err();
        assert!(error.message.contains("GitLab: 502 Bad Gateway"));
    }
    assert_eq!(gitlab.finds(), 1);
    fail.store(false, std::sync::atomic::Ordering::SeqCst);
    clock.advance(31_000);
    assert_eq!(
        find(&service, &session.id).await["mergeRequest"]["number"],
        json!(10046)
    );
    assert_eq!(gitlab.finds(), 2);
}

#[tokio::test]
async fn an_unreadable_checkout_is_not_asked_again_before_the_retry_delay() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request())));
    let Kit { service, clock, .. } = find_setup(gitlab.clone());
    let session = open_range(&service);
    gitlab.state.lock().unwrap().unreadable = true;
    assert_eq!(find(&service, &session.id).await["mergeRequest"], Value::Null);
    clock.advance(30_000);
    let error = service
        .open_gitlab(&json!({"sessionId": session.id}))
        .await
        .unwrap_err();
    assert!(error.message.contains("ssh: host unreachable"));
    assert_eq!(gitlab.state.lock().unwrap().checkouts, 1);
    gitlab.state.lock().unwrap().unreadable = false;
    clock.advance(31_000);
    assert_eq!(
        find(&service, &session.id).await["mergeRequest"]["number"],
        json!(10046)
    );
    assert_eq!(gitlab.state.lock().unwrap().checkouts, 2);
    assert_eq!(gitlab.finds(), 1);
}

async fn open_mr(service: &ReviewService, local: &str) -> crate::model::ReviewSnapshot {
    let opened = service
        .open_gitlab(&json!({"sessionId": local}))
        .await
        .unwrap();
    serde_json::from_value(opened["snapshot"].clone()).unwrap()
}

#[tokio::test]
async fn the_local_reviews_review_comments_wait_in_the_merge_requests_review() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request()))).with_api(21);
    let kit = find_setup(gitlab.clone());
    let Kit {
        service, clock, pushes, ..
    } = &kit;
    let local = open_range(service);
    let discussion = service
        .add_thread(&json!({"sessionId": local.id, "anchor": {"path": "a.c", "line": 1, "side": "new"}, "text": "Why this?"}))
        .await
        .unwrap();
    let draft = service
        .add_thread(&json!({"sessionId": local.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 2, "side": "new"}, "text": "Leak"}))
        .await
        .unwrap();
    let on_message = service
        .add_thread(&json!({"sessionId": local.id, "kind": "draft", "anchor": {"path": ":commit-message",
            "line": 1, "side": "new", "commit": "abcdef0123456789", "commitSubject": "Fix it", "text": "Fix it"},
            "text": "Say why"}))
        .await
        .unwrap();
    let other = service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "feature"}, "raise": false}))
        .unwrap()
        .session;
    service
        .add_thread(&json!({"sessionId": other.id, "kind": "draft",
            "anchor": {"path": "b.c", "line": 1, "side": "new"}, "text": "Elsewhere"}))
        .await
        .unwrap();
    let mr = open_mr(service, &local.id).await;
    assert_eq!(
        ids(&mr.threads, |t| t.id.clone()),
        vec![draft.id.clone(), on_message.id.clone()]
    );
    let shown = service
        .refresh_gitlab(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    assert_eq!(
        ids(&shown.threads, |t| t.id.clone()),
        vec![draft.id.clone(), on_message.id.clone(), "gl:d1".into()]
    );
    let local_ids = |service: &ReviewService| {
        ids(
            &service.get(&json!({"sessionId": local.id})).unwrap().threads,
            |t| t.id.clone(),
        )
    };
    assert_eq!(
        local_ids(service),
        vec![discussion.id.clone(), draft.id.clone(), on_message.id.clone()]
    );
    pushes.lock().unwrap().clear();
    service
        .edit(&json!({"sessionId": mr.session.id, "commentId": draft.comments[0].id, "text": "Leak here"}))
        .await
        .unwrap();
    let local_now = service.get(&json!({"sessionId": local.id})).unwrap();
    assert_eq!(
        local_now
            .threads
            .iter()
            .find(|t| t.id == draft.id)
            .unwrap()
            .comments[0]
            .body,
        "Leak here"
    );
    let heard: Vec<String> = pushes
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p["type"] == "session")
        .map(|p| p["snapshot"]["session"]["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(heard.contains(&local.id));
    assert!(heard.contains(&mr.session.id));
    clock.advance(1000);
    service
        .push_local_drafts(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    let posted = gitlab.posted();
    assert_eq!(posted.len(), 2);
    assert!(posted[0].contains("note=Leak here"));
    assert!(posted[1].contains("On the commit message of abcdef0123"), "{posted:?}");
    assert_eq!(local_ids(service), vec![discussion.id.clone()]);
    assert_eq!(
        ids(
            &service.get(&json!({"sessionId": other.id})).unwrap().threads,
            |t| t.anchor.path.clone().unwrap_or_default()
        ),
        vec!["b.c"]
    );
    let after = service
        .get(&json!({"sessionId": mr.session.id}))
        .unwrap()
        .threads;
    assert_eq!(
        after
            .iter()
            .filter(|t| t.gitlab.as_ref().is_some_and(|g| g.draft_id.is_some()))
            .count(),
        2
    );
    assert!(after.iter().all(|t| t.gitlab.is_some()));
}

#[tokio::test]
async fn a_review_comment_waits_for_the_merge_request_of_the_branch_it_was_written_on() {
    let answer: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(Some(fix_request())));
    let given = answer.clone();
    let gitlab = Gitlab::new(move |_| Ok(given.lock().unwrap().clone())).with_api(21);
    let Kit { service, clock, .. } = find_setup(gitlab.clone());
    let local = open_range(&service);
    let draft = |path: &str, text: &str| {
        json!({"sessionId": local.id, "kind": "draft", "anchor": {"path": path, "line": 1, "side": "new"}, "text": text})
    };
    let on_fix = service.add_thread(&draft("a.c", "On fix")).await.unwrap();
    sleep(10).await;
    let mr = open_mr(&service, &local.id).await;
    service
        .refresh_gitlab(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    gitlab.state.lock().unwrap().branch = Some("wip".into());
    *answer.lock().unwrap() = None;
    let on_wip = service.add_thread(&draft("w.c", "On wip")).await.unwrap();
    sleep(10).await;
    gitlab.state.lock().unwrap().branch = Some("other".into());
    let mut request = fix_request();
    request["url"] = json!("https://gitlab.example/gst/gstreamer/-/merge_requests/10047");
    request["number"] = json!(10047);
    request["branch"] = json!("other");
    *answer.lock().unwrap() = Some(request);
    let on_other = service.add_thread(&draft("b.c", "On other")).await.unwrap();
    sleep(10).await;
    let shown = ids(
        &service.get(&json!({"sessionId": mr.session.id})).unwrap().threads,
        |t| t.id.clone(),
    );
    assert!(shown.contains(&on_fix.id));
    assert!(!shown.contains(&on_other.id));
    clock.advance(1000);
    service
        .push_local_drafts(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    let posted = gitlab.posted();
    assert_eq!(posted.len(), 1);
    assert!(posted[0].contains("note=On fix"));
    let mut left = ids(
        &service.get(&json!({"sessionId": local.id})).unwrap().threads,
        |t| t.id.clone(),
    );
    left.sort();
    let mut want = vec![on_wip.id, on_other.id];
    want.sort();
    assert_eq!(left, want);
}

#[tokio::test]
async fn a_pending_review_comment_is_reached_by_an_id_prefix_from_the_merge_requests_review() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request()))).with_api(21);
    let Kit { service, .. } = find_setup(gitlab);
    let local = open_range(&service);
    let draft = service
        .add_thread(&json!({"sessionId": local.id, "kind": "draft",
            "anchor": {"path": "a.c", "line": 1, "side": "new"}, "text": "Leak", "author": "Claude"}))
        .await
        .unwrap();
    let mr = open_mr(&service, &local.id).await;
    service
        .edit(&json!({"sessionId": mr.session.id, "commentId": &draft.comments[0].id[..8],
            "text": "Leak here", "author": "Claude"}))
        .await
        .unwrap();
    let local_now = service.get(&json!({"sessionId": local.id})).unwrap();
    assert_eq!(local_now.threads[0].comments[0].body, "Leak here");
    service
        .resolve(&json!({"sessionId": mr.session.id, "commentId": &draft.id[..8]}))
        .unwrap();
    assert!(service.get(&json!({"sessionId": local.id})).unwrap().threads[0].resolved);
}

#[tokio::test]
async fn a_refresh_that_works_again_forgets_the_earlier_failure() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request()))).with_api(21);
    gitlab.state.lock().unwrap().down = true;
    let Kit { service, .. } = find_setup(gitlab.clone());
    let local = open_range(&service);
    let mr = open_mr(&service, &local.id).await;
    let failed = service
        .refresh_gitlab(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    assert!(failed.gitlab_error.unwrap().contains("502"));
    gitlab.state.lock().unwrap().down = false;
    let back = service
        .refresh_gitlab(&json!({"sessionId": mr.session.id}))
        .await
        .unwrap();
    assert!(back.gitlab_error.is_none());
    assert_eq!(back.merge_request.unwrap().url, FIX_URL);
}

#[tokio::test]
async fn local_from_a_merge_requests_review_is_a_local_review_of_its_branch() {
    let gitlab = Gitlab::new(|_| Ok(Some(fix_request())));
    let Kit { service, .. } = find_setup(gitlab);
    let local = open_range(&service);
    let mr = open_mr(&service, &local.id).await;
    service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "feature"}, "raise": false}))
        .unwrap();
    let found = service
        .find_gitlab(&json!({"sessionId": mr.session.id, "local": true}))
        .await
        .unwrap();
    assert_eq!(found["mergeRequest"]["number"], json!(10046));
    assert_eq!(found["localReviews"], json!([local.id]));
}
