//! server/src/review/feedback-migration.test.ts, the server's half: Review
//! feedback written as review threads. Which review a note goes to, its
//! thread id and how the page migrates its notes are the web's
//! (web/src/workspaceFeedback.ts, kept in TS); what the server does with
//! the calls that code makes (`review.open`, `review.thread.add` with a
//! note's thread id and hold, `review.update`, `review.thread.release`) is
//! here, the calls made as writeFeedback makes them.

use serde_json::{Value, json};

use super::*;
use crate::model::{ReviewSnapshot, ReviewThread};

fn setup() -> Kit {
    kit(
        Host::default(),
        Options {
            delivery_delay_ms: Some(5),
            ..Options::default()
        },
    )
}

/// A 16 hexadecimal digit id per note, as feedbackThreadId gives.
fn thread_id(note: &str) -> String {
    let hash = |seed: u32| {
        note.encode_utf16().fold(seed, |value, unit| {
            (value ^ u32::from(unit)).wrapping_mul(0x0100_0193)
        })
    };
    format!("{:08x}{:08x}", hash(0x811c_9dc5), hash(0x1b87_3593))
}

/// A note of the page, and where writeFeedback sends it.
struct Note {
    id: &'static str,
    comment: &'static str,
    open: Value,
    anchor: Value,
    /// A terminal's note waits for Send.
    held: bool,
}

fn file_note(id: &'static str, comment: &'static str) -> Note {
    let note = json!({"id": id, "source": "file", "anchor": "line", "path": "docs/plan.md", "line": 3,
        "quote": "the line", "createdAt": 1});
    Note {
        id,
        comment,
        open: json!({"root": "/repo", "target": {"kind": "rendered", "path": "docs/plan.md"}, "title": "plan.md"}),
        anchor: json!({"path": "docs/plan.md", "line": 3, "side": "new", "text": "the line",
            "feedback": note.to_string()}),
        held: false,
    }
}

fn diff_note() -> Note {
    let note = json!({"id": "d1", "source": "diff", "path": "src/a.c", "kind": "unstaged", "side": "new",
        "line": 7, "hunk": "@@ -1 +1 @@", "quote": "int x;", "createdAt": 2});
    Note {
        id: "d1",
        comment: "Why int?",
        open: json!({"root": "/repo", "target": {"kind": "worktree"}}),
        anchor: json!({"path": "src/a.c", "line": 7, "side": "new", "text": "int x;",
            "feedback": note.to_string()}),
        held: false,
    }
}

/// A terminal's note: the agent's chat review when the pane's agent has
/// one (`chat`), else the terminal's own.
fn terminal_note(chat: bool) -> Note {
    let note = json!({"id": "t1", "source": "terminal", "anchor": "quote", "paneId": "w1:p2",
        "title": "build", "quote": "error: nope", "createdAt": 3});
    let open = if chat {
        json!({"root": "/repo", "target": {"kind": "chat", "chat": "session-7"},
            "title": "Chat with claude", "agent": "claude", "paneId": "w1:p2"})
    } else {
        json!({"root": "/repo", "target": {"kind": "chat", "chat": "w1:p2"}, "title": "Terminal: build"})
    };
    Note {
        id: "t1",
        comment: "Fix this",
        open,
        anchor: json!({"terminal": {"pane": "w1:p2", "title": "build", "quote": "error: nope"},
            "feedback": note.to_string()}),
        held: true,
    }
}

/// The workspace's agent, as the page passes it on a view's note.
const AGENT: Option<(&str, &str)> = Some(("w1:p1", "Claude"));

/// writeFeedback: opens the note's review, then adds its thread there,
/// held when the route or the caller holds it.
async fn write(
    service: &ReviewService,
    note: &Note,
    agent: Option<(&str, &str)>,
    held: i64,
    hold: bool,
) -> crate::error::ReviewResult<(ReviewSnapshot, ReviewThread)> {
    let mut open = note.open.clone();
    open["connectionId"] = json!("local");
    open["workspaceId"] = json!("w1");
    if let Some((pane, name)) = agent
        && !note.held
    {
        open["paneId"] = json!(pane);
        open["agent"] = json!(name);
    }
    let opened = service.open(&open)?;
    let holding = note.held || hold;
    let session = &opened.session;
    let kind = if holding
        || (!session.gitlab && session.auto_send != Some(false) && session.agent.pane_id.is_some())
    {
        "discussion"
    } else {
        "draft"
    };
    let mut add = json!({"sessionId": session.id, "kind": kind, "anchor": note.anchor,
        "newThreadId": thread_id(note.id), "text": note.comment.trim()});
    if holding {
        add["held"] = json!(held);
    }
    let thread = service.add_thread(&add).await?;
    Ok((opened, thread))
}

fn snapshots(service: &ReviewService) -> Vec<ReviewSnapshot> {
    service.list(&json!({"connectionId": "local", "chats": true}))
}

fn all_threads(service: &ReviewService) -> Vec<ReviewThread> {
    snapshots(service)
        .into_iter()
        .flat_map(|s| s.threads)
        .collect()
}

/// heldFeedback's threads: held ones of the workspace, by hold.
fn held(service: &ReviewService) -> Vec<(i64, String, String)> {
    let mut found: Vec<(i64, String, String)> = snapshots(service)
        .into_iter()
        .filter(|s| s.session.workspace_id.as_deref() == Some("w1"))
        .flat_map(|s| {
            let session = s.session.id.clone();
            s.threads
                .into_iter()
                .filter_map(move |t| t.held.map(|held| (held, t.id, session.clone())))
        })
        .collect();
    found.sort();
    found
}

#[tokio::test]
async fn each_note_goes_to_the_review_of_what_it_is_on() {
    let Kit { service, .. } = setup();
    let worktree = write(&service, &diff_note(), None, 1, false)
        .await
        .unwrap()
        .0;
    assert_eq!(
        worktree.session.target.to_value(),
        json!({"kind": "worktree"})
    );
    let rendered = write(&service, &file_note("f", "x"), None, 2, false)
        .await
        .unwrap()
        .0;
    assert_eq!(
        rendered.session.target.to_value(),
        json!({"kind": "rendered", "path": "docs/plan.md"})
    );
    let terminal = write(&service, &terminal_note(false), None, 3, false)
        .await
        .unwrap()
        .0;
    assert_eq!(
        terminal.session.target.to_value(),
        json!({"kind": "chat", "chat": "w1:p2"})
    );
    assert_eq!(terminal.session.title, "Terminal: build");
    let mut sessions = vec![
        worktree.session.id,
        rendered.session.id,
        terminal.session.id,
    ];
    sessions.sort();
    sessions.dedup();
    assert_eq!(sessions.len(), 3);
}

#[tokio::test]
async fn thread_ids_are_16_hexadecimal_digits_the_same_for_the_same_note() {
    let Kit { service, .. } = setup();
    let id = thread_id("a");
    assert_eq!(id.len(), 16);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    assert_ne!(id, thread_id("b"));
    let note = file_note("a", "Once");
    let (_, first) = write(&service, &note, None, 1, false).await.unwrap();
    assert_eq!(first.id, id);
    let (_, again) = write(&service, &note, None, 1, false).await.unwrap();
    assert_eq!(again.id, id);
    assert_eq!(all_threads(&service).len(), 1);
}

#[tokio::test]
async fn a_note_read_back_compiles_word_for_word_as_it_did() {
    let Kit { service, clock, .. } = setup();
    let notes = [file_note("f1", "On the file"), diff_note(), terminal_note(false)];
    for (at, note) in notes.iter().enumerate() {
        clock.advance(1);
        write(&service, note, None, at as i64 + 100, false)
            .await
            .unwrap();
    }
    let threads = all_threads(&service);
    for note in &notes {
        let thread = threads.iter().find(|t| t.id == thread_id(note.id)).unwrap();
        assert_eq!(thread.comments[0].body, note.comment);
        assert_eq!(
            thread.anchor.feedback.as_deref(),
            note.anchor["feedback"].as_str()
        );
    }
    let mut order: Vec<_> = threads
        .iter()
        .map(|t| (t.created_at.clone(), t.comments[0].body.clone()))
        .collect();
    order.sort();
    assert_eq!(
        order.into_iter().map(|(_, body)| body).collect::<Vec<_>>(),
        vec!["On the file", "Why int?", "Fix this"]
    );
}

#[tokio::test]
async fn a_comment_is_its_reviews_thread_and_goes_to_the_workspaces_agent() {
    let Kit { service, host, .. } = setup();
    let (opened, thread) = write(&service, &diff_note(), AGENT, 1, false)
        .await
        .unwrap();
    assert!(thread.held.is_none());
    assert!(held(&service).is_empty());
    assert_eq!(thread.kind, "discussion");
    let note: Value = serde_json::from_str(thread.anchor.feedback.as_deref().unwrap()).unwrap();
    assert_eq!((&note["source"], &note["kind"]), (&json!("diff"), &json!("unstaged")));
    assert_eq!(opened.session.agent.pane_id.as_deref(), Some("w1:p1"));
    sleep(30).await;
    assert!(host.texts().join("\n").contains("Why int?"));
}

fn worktree_with_agent(service: &ReviewService, agent: bool) -> String {
    let mut params = json!({"connectionId": "local", "root": "/repo", "workspaceId": "w1", "target": {"kind": "worktree"}});
    if agent {
        params["agent"] = json!("Claude");
        params["paneId"] = json!("w1:p1");
    }
    service.open(&params).unwrap().session.id
}

#[tokio::test]
async fn a_review_held_until_send_holds_the_comments_written_in_the_views_too() {
    let Kit { service, host, .. } = setup();
    let id = worktree_with_agent(&service, true);
    service
        .update(&json!({"sessionId": id, "holdComments": true}))
        .await
        .unwrap();
    write(&service, &diff_note(), AGENT, 1, false)
        .await
        .unwrap();
    sleep(30).await;
    assert!(host.texts().is_empty());
    service
        .update(&json!({"sessionId": id, "holdComments": false}))
        .await
        .unwrap();
    sleep(30).await;
    assert!(host.texts().join("\n").contains("Why int?"));
}

#[tokio::test]
async fn a_review_that_does_not_send_to_the_agent_takes_a_review_comment() {
    let Kit { service, host, .. } = setup();
    let id = worktree_with_agent(&service, false);
    service
        .update(&json!({"sessionId": id, "autoSend": false}))
        .await
        .unwrap();
    let (_, thread) = write(&service, &diff_note(), AGENT, 1, false)
        .await
        .unwrap();
    sleep(30).await;
    assert!(host.texts().is_empty());
    assert_eq!(thread.kind, "draft");
}

#[tokio::test]
async fn a_terminal_comment_still_waits_in_review_feedback() {
    let Kit { service, host, .. } = setup();
    let (_, thread) = write(&service, &terminal_note(false), AGENT, 1, false)
        .await
        .unwrap();
    assert_eq!(thread.held, Some(1));
    sleep(30).await;
    assert!(host.texts().is_empty());
    assert_eq!(
        held(&service)
            .into_iter()
            .map(|(_, id, _)| id)
            .collect::<Vec<_>>(),
        vec![thread.id]
    );
}

#[tokio::test]
async fn comments_held_before_wait_for_send_with_a_terminals_and_the_hand_off_delivers_nothing_twice()
{
    let Kit { service, host, .. } = setup();
    let id = worktree_with_agent(&service, false);
    service
        .add_thread(&json!({"sessionId": id, "kind": "discussion", "anchor": {"path": "src/a.c", "line": 7,
            "side": "new", "feedback": diff_note().anchor["feedback"]}, "text": "Why int?", "held": 1}))
        .await
        .unwrap();
    write(&service, &terminal_note(false), None, 2, false)
        .await
        .unwrap();
    sleep(30).await;
    assert!(host.texts().is_empty());
    let waiting = held(&service);
    assert_eq!(waiting.len(), 2);
    let sources: Vec<Value> = waiting
        .iter()
        .map(|(_, thread, _)| {
            let found = all_threads(&service)
                .into_iter()
                .find(|t| &t.id == thread)
                .unwrap();
            serde_json::from_str::<Value>(found.anchor.feedback.as_deref().unwrap()).unwrap()["source"]
                .clone()
        })
        .collect();
    assert_eq!(sources, vec![json!("diff"), json!("terminal")]);
    for (_, thread, session) in &waiting {
        service
            .release_held(&json!({"sessionId": session, "commentId": thread, "handed": true}))
            .unwrap();
    }
    sleep(30).await;
    assert!(host.texts().is_empty());
    assert!(held(&service).is_empty());
    assert!(all_threads(&service).iter().all(|t| t.handed_at.is_some()));
}

#[tokio::test]
async fn a_terminal_comment_on_an_agents_pane_is_held_in_that_agents_chat_review() {
    let Kit { service, host, .. } = setup();
    let chat = service
        .open(&json!({"connectionId": "local", "workspaceId": "w1", "root": "/repo",
            "target": {"kind": "chat", "chat": "session-7"}, "title": "Chat with claude",
            "agent": "claude", "paneId": "w1:p2"}))
        .unwrap();
    let (opened, thread) = write(&service, &terminal_note(true), AGENT, 5, false)
        .await
        .unwrap();
    assert_eq!(thread.held, Some(5));
    assert_eq!(opened.session.id, chat.session.id);
    assert_eq!(held(&service)[0].2, chat.session.id);
    assert_eq!(
        to_json(&thread.anchor.terminal),
        json!({"pane": "w1:p2", "title": "build", "quote": "error: nope"})
    );
    sleep(30).await;
    assert!(host.texts().is_empty());
    let Kit { service: second, .. } = setup();
    let (first, _) = write(&second, &terminal_note(true), AGENT, 1, false)
        .await
        .unwrap();
    assert_eq!(
        first.session.target.to_value(),
        json!({"kind": "chat", "chat": "session-7"})
    );
    assert_eq!(first.session.agent.pane_id.as_deref(), Some("w1:p2"));
    let reopened = second
        .open(&json!({"connectionId": "local", "workspaceId": "w1", "root": "/repo",
            "target": {"kind": "chat", "chat": "session-7"}, "title": "Chat with claude",
            "agent": "claude", "paneId": "w1:p2"}))
        .unwrap();
    assert_eq!(reopened.session.id, first.session.id);
    assert_eq!(snapshots(&second).len(), 1);
}

#[tokio::test]
async fn a_file_an_agent_opened_hears_comments_at_once() {
    let Kit { service, host, .. } = setup();
    service
        .open(&json!({"connectionId": "local", "root": "/repo", "workspaceId": "w1",
            "target": {"kind": "rendered", "path": "docs/plan.md"}, "agent": "Claude", "paneId": "w1:p1"}))
        .unwrap();
    let (_, thread) = write(&service, &file_note("f", "Direct"), None, 1, false)
        .await
        .unwrap();
    assert!(thread.held.is_none());
    sleep(30).await;
    assert!(host.texts().join("\n").contains("Direct"));
    assert!(held(&service).is_empty());
}

#[tokio::test]
async fn migration_a_note_the_server_refuses_stays() {
    let Kit { service, .. } = setup();
    let mut moved = Vec::new();
    let mut kept = Vec::new();
    for (at, note) in [
        file_note("n1", "first"),
        file_note("n2", "   "),
        file_note("n3", "third"),
    ]
    .iter()
    .enumerate()
    {
        match write(&service, note, None, 1000 + at as i64, false).await {
            Ok(_) => moved.push(note.id),
            Err(error) => kept.push((note.id, error.message)),
        }
    }
    assert_eq!(moved, vec!["n1", "n3"]);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].0, "n2");
    let mut bodies = ids(&all_threads(&service), |t| t.comments[0].body.clone());
    bodies.sort();
    assert_eq!(bodies, vec!["first", "third"]);
}

#[tokio::test]
async fn migration_a_note_with_no_words_stays_the_users_draft() {
    let Kit { service, .. } = setup();
    let error = write(&service, &file_note("n1", "   "), None, 1, false)
        .await
        .unwrap_err();
    assert!(error.message.contains("text is empty"), "{error:?}");
    assert!(all_threads(&service).is_empty());
}

#[tokio::test]
async fn migration_a_page_closed_mid_way_loses_nothing_and_writes_nothing_twice() {
    let Kit { service, .. } = setup();
    let notes = [
        file_note("n1", "first"),
        file_note("n2", "second"),
        file_note("n3", "third"),
    ];
    write(&service, &notes[0], None, 1, false).await.unwrap();
    write(&service, &notes[1], None, 2, false).await.unwrap();
    // The next load writes what the page did not forget: n2 again, n3.
    write(&service, &notes[1], None, 1, false).await.unwrap();
    write(&service, &notes[2], None, 2, false).await.unwrap();
    let mut bodies = ids(&all_threads(&service), |t| t.comments[0].body.clone());
    bodies.sort();
    assert_eq!(bodies, vec!["first", "second", "third"]);
}

#[tokio::test]
async fn migration_each_note_becomes_a_held_thread_of_its_review_a_terminals_in_its_agents_chat_review()
{
    let Kit { service, host, .. } = setup();
    let notes = [file_note("n1", "first"), diff_note(), terminal_note(true)];
    for (at, note) in notes.iter().enumerate() {
        write(&service, note, AGENT, 10 + at as i64, true)
            .await
            .unwrap();
    }
    let waiting = held(&service);
    assert_eq!(
        waiting.iter().map(|(_, id, _)| id.clone()).collect::<Vec<_>>(),
        ["n1", "d1", "t1"].map(thread_id).to_vec()
    );
    let kinds: Vec<String> = waiting
        .iter()
        .map(|(_, _, session)| {
            service
                .get(&json!({"sessionId": session}))
                .unwrap()
                .session
                .target
                .kind()
                .to_owned()
        })
        .collect();
    assert_eq!(kinds, vec!["rendered", "worktree", "chat"]);
    sleep(30).await;
    assert!(host.texts().is_empty());
}
