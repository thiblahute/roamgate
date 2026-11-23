//! server/src/review/service.shared.test.ts: threads shared between a
//! rendered file and the code reviews of its checkout, each living in the
//! review it was written in and showing in both.

use serde_json::{Value, json};

use super::*;
use crate::model::ReviewSession;

fn setup() -> Kit {
    kit(
        Host::default(),
        Options {
            delivery_delay_ms: Some(10),
            ..Options::default()
        },
    )
}

fn open_at(service: &ReviewService, target: Value, root: &str) -> ReviewSession {
    service
        .open(&json!({"connectionId": "local", "root": root, "target": target,
            "agent": "claude", "paneId": "w1:p1", "raise": false}))
        .unwrap()
        .session
}

fn open(service: &ReviewService, target: Value) -> ReviewSession {
    open_at(service, target, "/repo")
}

fn on_plan(line: i64) -> Value {
    json!({"path": "plan.md", "line": line, "side": "new", "text": format!("line {line}")})
}

fn shared(service: &ReviewService, id: &str) -> Vec<String> {
    service
        .get(&json!({"sessionId": id}))
        .unwrap()
        .shared
        .unwrap_or_default()
        .iter()
        .map(|t| t.id.clone())
        .collect()
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

fn told(pushes: &std::sync::Mutex<Vec<Value>>) -> Vec<String> {
    pushes
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p["type"] == "session")
        .map(|p| p["snapshot"]["session"]["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_thread_made_in_either_view_shows_in_the_other() {
    let Kit { service, .. } = setup();
    let rendered = open(&service, json!({"kind": "rendered", "path": "plan.md"}));
    let code = open(&service, json!({"kind": "range", "base": "main", "head": "topic"}));
    let other = open(&service, json!({"kind": "rendered", "path": "other.md"}));
    let elsewhere = open_at(&service, json!({"kind": "worktree"}), "/elsewhere");
    let mut anchor = on_plan(3);
    anchor["render"] = json!({"quote": "the words"});
    let from_rendered = service
        .add_thread(&json!({"sessionId": rendered.id, "anchor": anchor, "text": "From the rendered view"}))
        .await
        .unwrap();
    let from_code = service
        .add_thread(&json!({"sessionId": code.id, "anchor": on_plan(5), "text": "From the diff"}))
        .await
        .unwrap();
    service
        .add_thread(&json!({"sessionId": code.id, "anchor": {"path": "src/main.rs", "line": 1, "side": "new"},
            "text": "Not on the file"}))
        .await
        .unwrap();
    assert_eq!(shared(&service, &code.id), vec![from_rendered.id.clone()]);
    assert_eq!(
        service
            .get(&json!({"sessionId": code.id}))
            .unwrap()
            .shared
            .unwrap()[0]
            .session_id,
        rendered.id
    );
    assert_eq!(shared(&service, &rendered.id), vec![from_code.id.clone()]);
    assert!(shared(&service, &other.id).is_empty());
    assert!(shared(&service, &elsewhere.id).is_empty());
    assert!(
        !service
            .get(&json!({"sessionId": code.id}))
            .unwrap()
            .threads
            .iter()
            .any(|t| t.id == from_rendered.id)
    );
}

#[tokio::test]
async fn a_change_in_one_review_is_pushed_to_the_reviews_showing_its_threads() {
    let Kit {
        service, pushes, ..
    } = setup();
    let rendered = open(&service, json!({"kind": "rendered", "path": "plan.md"}));
    let code = open(&service, json!({"kind": "worktree"}));
    pushes.lock().unwrap().clear();
    let thread = service
        .add_thread(&json!({"sessionId": rendered.id, "anchor": on_plan(2), "text": "Pushed to both"}))
        .await
        .unwrap();
    let last = pushes
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p["type"] == "session" && p["snapshot"]["session"]["id"] == json!(code.id))
        .next_back()
        .cloned()
        .unwrap();
    assert_eq!(
        last["snapshot"]["shared"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!(thread.id)]
    );
}

#[tokio::test]
async fn replies_resolve_and_reopen_from_the_other_view_go_to_the_threads_review_delivered_once()
{
    let Kit { service, host, .. } = setup();
    let rendered = open(&service, json!({"kind": "rendered", "path": "plan.md"}));
    let code = open(&service, json!({"kind": "range", "base": "main", "head": "topic"}));
    let thread = service
        .add_thread(&json!({"sessionId": rendered.id, "anchor": on_plan(4), "text": "First words"}))
        .await
        .unwrap();
    sleep(60).await;
    let count = |words: &str| {
        host.texts()
            .iter()
            .filter(|text| text.contains(words))
            .count()
    };
    assert_eq!(count("First words"), 1);
    service
        .reply(&json!({"sessionId": code.id, "commentId": thread.id, "text": "Said in the diff"}))
        .await
        .unwrap();
    let in_rendered = service
        .get(&json!({"sessionId": rendered.id}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == thread.id)
        .unwrap();
    assert_eq!(
        ids(&in_rendered.comments, |c| c.body.clone()),
        vec!["First words", "Said in the diff"]
    );
    sleep(60).await;
    assert_eq!(count("Said in the diff"), 1);
    assert!(
        host.texts()
            .last()
            .unwrap()
            .contains(&format!("[{}]", &thread.id[..8]))
    );
    assert!(
        service
            .get(&json!({"sessionId": code.id}))
            .unwrap()
            .session
            .delivered_at
            .is_none()
    );
    let resolved_in_code = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": code.id}))
            .unwrap()
            .shared
            .unwrap()
            .into_iter()
            .find(|t| t.id == thread.id)
            .unwrap()
            .resolved
    };
    service
        .resolve(&json!({"sessionId": code.id, "commentId": thread.id}))
        .unwrap();
    assert!(resolved_in_code(&service));
    service
        .resolve(&json!({"sessionId": rendered.id, "commentId": thread.id, "resolved": false}))
        .unwrap();
    assert!(!resolved_in_code(&service));
    assert_eq!(
        service
            .session_of_comment(&json!({"connectionId": "local", "commentId": thread.id}))
            .unwrap(),
        Some(rendered.id.clone())
    );
}

#[tokio::test]
async fn a_sub_thread_on_a_part_of_a_shared_threads_comment_lives_in_that_threads_review() {
    let Kit { service, .. } = setup();
    let rendered = open(&service, json!({"kind": "rendered", "path": "plan.md"}));
    let code = open(&service, json!({"kind": "worktree"}));
    let thread = service
        .add_thread(&json!({"sessionId": code.id, "anchor": on_plan(7), "text": "Option a or option b?"}))
        .await
        .unwrap();
    let mut anchor = on_plan(7);
    anchor["message"] =
        json!({"thread": thread.id, "comment": thread.comments[0].id, "quote": "option b"});
    let part = service
        .add_thread(&json!({"sessionId": rendered.id, "anchor": anchor, "text": "Why b?"}))
        .await
        .unwrap();
    assert_eq!(part.session_id, code.id);
    assert_eq!(shared(&service, &rendered.id), vec![thread.id, part.id]);
}

#[tokio::test]
async fn a_checkouts_code_reviews_show_each_others_threads_whatever_they_compare() {
    let Kit {
        service, pushes, ..
    } = setup();
    let worktree = open(&service, json!({"kind": "worktree"}));
    let branch = open(&service, json!({"kind": "range", "base": "origin/main", "head": "HEAD"}));
    let agents = open(&service, json!({"kind": "range", "base": "main", "head": "topic"}));
    let compare = open(
        &service,
        json!({"kind": "range", "base": "topic-before", "head": "topic", "compare": true}),
    );
    let step = open(
        &service,
        json!({"kind": "step", "step": "s1", "before": sha("a"), "after": sha("b")}),
    );
    let elsewhere = open_at(&service, json!({"kind": "worktree"}), "/elsewhere");
    let add = |id: String, text: &'static str, path: Option<&'static str>| {
        let service = service.clone();
        async move {
            let anchor = match path {
                Some(path) => json!({"path": path, "line": 1, "side": "new", "text": "x"}),
                None => json!({}),
            };
            service
                .add_thread(&json!({"sessionId": id, "anchor": anchor, "text": text}))
                .await
                .unwrap()
                .id
        }
    };
    let on_worktree = add(worktree.id.clone(), "In Files", Some("NAMING.md")).await;
    let on_branch = add(branch.id.clone(), "On a commit", Some("play.c")).await;
    let on_agents = add(agents.id.clone(), "Re-posted", Some("api.rs")).await;
    let general = add(branch.id.clone(), "On the whole branch", None).await;
    let on_compare = add(compare.id.clone(), "Compared", Some("play.c")).await;
    let on_step = add(step.id.clone(), "A step", Some("play.c")).await;
    add(elsewhere.id.clone(), "Elsewhere", Some("play.c")).await;
    let sorted_shared = |id: &str| sorted(shared(&service, id));
    assert_eq!(
        sorted_shared(&agents.id),
        sorted(vec![on_worktree.clone(), on_branch.clone(), general.clone()])
    );
    assert_eq!(
        sorted_shared(&worktree.id),
        sorted(vec![on_branch.clone(), on_agents.clone(), general.clone()])
    );
    assert_eq!(
        sorted_shared(&branch.id),
        sorted(vec![on_worktree.clone(), on_agents.clone()])
    );
    assert_eq!(
        service
            .get(&json!({"sessionId": agents.id}))
            .unwrap()
            .shared
            .unwrap()
            .into_iter()
            .find(|t| t.id == on_branch)
            .unwrap()
            .session_id,
        branch.id
    );
    for id in [&compare.id, &step.id, &elsewhere.id] {
        assert!(!shared(&service, id).contains(&on_branch));
    }
    assert!(!shared(&service, &agents.id).contains(&on_compare));
    assert!(!shared(&service, &agents.id).contains(&on_step));
    pushes.lock().unwrap().clear();
    service
        .reply(&json!({"sessionId": agents.id, "commentId": on_branch, "author": "claude",
            "text": "Answered from the agent's review"}))
        .await
        .unwrap();
    let in_branch = service
        .get(&json!({"sessionId": branch.id}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == on_branch)
        .unwrap();
    assert_eq!(
        ids(&in_branch.comments, |c| c.body.clone()),
        vec!["On a commit", "Answered from the agent's review"]
    );
    let told = told(&pushes);
    assert!(told.contains(&agents.id));
    assert!(told.contains(&worktree.id));
}

#[tokio::test]
async fn a_merge_requests_review_of_the_checkout_lists_only_its_own_threads() {
    let Kit { service, .. } = setup();
    let worktree = open(&service, json!({"kind": "worktree"}));
    let branch = open(&service, json!({"kind": "range", "base": "origin/main", "head": "HEAD"}));
    let mr = open(
        &service,
        json!({"kind": "mr", "url": "https://gitlab.example/group/project/-/merge_requests/4"}),
    );
    let add = |id: &str, text: &str| {
        json!({"sessionId": id, "anchor": {"path": "play.c", "line": 1, "side": "new", "text": "x"}, "text": text})
    };
    service.add_thread(&add(&worktree.id, "In Files")).await.unwrap();
    service
        .add_thread(&add(&branch.id, "On the branch"))
        .await
        .unwrap();
    let own = service
        .add_thread(&add(&mr.id, "On the request"))
        .await
        .unwrap()
        .id;
    let snapshot = service.get(&json!({"sessionId": mr.id})).unwrap();
    assert_eq!(ids(&snapshot.threads, |t| t.id.clone()), vec![own.clone()]);
    assert!(snapshot.shared.unwrap_or_default().is_empty());
    assert!(!shared(&service, &branch.id).contains(&own));
}

#[tokio::test]
async fn a_draft_the_agent_answered_in_is_talked_through_the_users_next_reply_reaches_the_agent()
{
    let Kit { service, host, .. } = setup();
    let branch = open(&service, json!({"kind": "range", "base": "origin/main", "head": "HEAD"}));
    let draft = service
        .add_thread(&json!({"sessionId": branch.id, "kind": "draft",
            "anchor": {"path": "play.c", "line": 1, "side": "new", "text": "x"},
            "text": "Is a new decoder that expensive?"}))
        .await
        .unwrap();
    sleep(60).await;
    assert!(host.texts().is_empty());
    service
        .reply(&json!({"sessionId": branch.id, "commentId": draft.id, "author": "Claude", "text": "Not on this machine"}))
        .await
        .unwrap();
    service
        .reply(&json!({"sessionId": branch.id, "commentId": draft.id, "text": "Measure it on the prod GPUs then"}))
        .await
        .unwrap();
    sleep(60).await;
    assert_eq!(
        host.texts()
            .iter()
            .filter(|t| t.contains("Measure it on the prod GPUs"))
            .count(),
        1
    );
}
