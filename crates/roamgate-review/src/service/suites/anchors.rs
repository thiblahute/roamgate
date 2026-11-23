//! The service's three reanchoring passes, on files and checkouts:
//! server/src/review/file-anchors.test.ts (a rendered file's threads
//! follow the file), changes-anchors.test.ts (Changes' entry anchors move
//! onto the worktree review's combined diff) and rewritten-anchors.test.ts
//! (threads on an amended or squashed commit follow it). The last two read
//! a real checkout with review-patch.ts's loaders, as their TS suites do.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::model::{ReviewAnchor, ReviewThread};

fn lines(text: &[&str]) -> String {
    text.join("\n")
}

const BEFORE: &[&str] = &[
    "# TODO",
    "",
    "- [ ] Firefox: old Roamgate notifications pile up since first use. What is",
    "      wanted: clear them when they no longer apply? (asked",
    "      2026-11-20 00:xx, no answer yet)",
    "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
    "      2026-11-19, needs one real headset call to confirm.",
    "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
    "",
    "## Done",
    "",
    "- [x] Something older.",
    "",
];
const AFTER: &[&str] = &[
    "# TODO",
    "",
    "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
    "",
    "## Done",
    "",
    "- [x] Something older.",
    "- [x] Headset (boom mic) muting after each turn: fixed twice on",
    "      2026-11-19, needs one real headset call to confirm.",
    "- [x] Firefox: old Roamgate notifications piling up (the user says it is fixed, 2026-11-20).",
    "",
];
const GONE: &[&str] = &["# TODO", "", "- [x] Something older.", ""];
const HEADSET: &str = "Headset (boom mic) muting after each turn: fixed twice on\n2026-11-19, needs one real headset call to confirm.";
const CALL: &str = "Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.";

/// todo.md as the checkout holds it, and how often it was read.
#[derive(Default)]
struct File {
    text: Mutex<String>,
    reads: Mutex<usize>,
}

impl File {
    fn set(&self, text: &[&str]) {
        *self.text.lock().unwrap() = lines(text);
    }

    fn reads(&self) -> usize {
        *self.reads.lock().unwrap()
    }
}

fn file_setup() -> (Kit, Arc<File>, String) {
    let file = Arc::new(File::default());
    file.set(BEFORE);
    let read = file.clone();
    let host = Host {
        diff: Some(Box::new(|_, _, _| {
            Box::pin(async { Err(LoadError::Failed("a rendered review has no diff".into())) })
        })),
        file: Some(Box::new(move |_, rev, path| {
            let read = read.clone();
            Box::pin(async move {
                *read.reads.lock().unwrap() += 1;
                if !rev.is_empty() || path != "todo.md" {
                    return Err(LoadError::Failed(format!("no {rev}:{path}")));
                }
                Ok(read.text.lock().unwrap().clone())
            })
        })),
        ..Host::default()
    };
    let kit = kit(host, Options::default());
    let session = kit
        .service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "rendered", "path": "todo.md"}, "raise": false}))
        .unwrap()
        .session;
    (kit, file, session.id)
}

/// A thread as the Files preview writes it on an item's lines.
async fn written(
    service: &ReviewService,
    id: &str,
    line: i64,
    end: Option<i64>,
    quote: &str,
    comment: &str,
) -> ReviewThread {
    let text = BEFORE[(end.unwrap_or(line) - 1) as usize];
    let mut feedback = json!({"source": "file", "anchor": "quote", "path": "/repo/todo.md", "quote": quote, "line": line});
    let mut anchor = json!({"path": "todo.md", "line": line, "side": "new", "text": text, "render": {"quote": quote}});
    if let Some(end) = end {
        feedback["endLine"] = json!(end);
        anchor["endLine"] = json!(end);
    }
    anchor["feedback"] = json!(feedback.to_string());
    service
        .add_thread(&json!({"sessionId": id, "anchor": anchor, "text": comment}))
        .await
        .unwrap()
}

fn by_body(service: &ReviewService, id: &str, body: &str) -> ReviewThread {
    service
        .get(&json!({"sessionId": id}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.comments[0].body == body)
        .unwrap()
}

#[tokio::test]
async fn the_agents_update_a_thread_written_and_an_open_look_at_the_file_reads_only_now_and_then() {
    let (Kit {
        service, pushes, ..
    }, file, id) = file_setup();
    written(&service, &id, 6, Some(7), HEADSET, "headset").await;
    assert!(until(|| file.reads() >= 1).await);
    let reads = file.reads();
    file.set(AFTER);
    service.get(&json!({"sessionId": id})).unwrap();
    service.list(&json!({"connectionId": "local"}));
    assert_eq!(file.reads(), reads);
    pushes.lock().unwrap().clear();
    service
        .agent_status(&json!({"sessionId": id, "state": "update", "message": "Moved it"}))
        .unwrap();
    assert!(
        until(|| pushes.lock().unwrap().iter().any(|p| p["type"] == "session"
            && p["snapshot"]["threads"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["anchor"]["line"] == json!(8))))
        .await
    );
    let headset = by_body(&service, &id, "headset").anchor;
    assert_eq!((headset.line, headset.end_line), (Some(8), Some(9)));
    let stale = service
        .add_thread(&json!({"sessionId": id, "anchor": {"path": "todo.md", "line": 8, "side": "new",
            "text": "- [ ] Call 1 on 2026-11-19 stopped listening at 23:31 after another voice.",
            "render": {"quote": CALL}}, "text": "call"}))
        .await
        .unwrap();
    assert!(until(|| by_body(&service, &id, "call").anchor.line == Some(3)).await);
    assert_eq!(by_body(&service, &id, "call").id, stale.id);
    file.set(GONE);
    service
        .open(&json!({"connectionId": "local", "root": "/repo",
            "target": {"kind": "rendered", "path": "todo.md"}, "raise": false}))
        .unwrap();
    assert!(until(|| by_body(&service, &id, "call").anchor.line.is_none()).await);
}

#[tokio::test]
async fn the_checkouts_review_moves_its_files_preview_threads_with_their_files_its_diffs_untouched()
{
    let (Kit {
        service, pushes, ..
    }, file, id) = file_setup();
    let checkout = service
        .open(&json!({"connectionId": "local", "root": "/repo", "target": {"kind": "worktree"}, "raise": false}))
        .unwrap()
        .session;
    assert_ne!(checkout.id, id);
    let in_files = service
        .add_thread(&json!({"sessionId": checkout.id, "anchor": {"path": "todo.md", "line": 6, "endLine": 7,
            "side": "new", "text": "      2026-11-19, needs one real headset call to confirm.",
            "render": {"quote": HEADSET},
            "feedback": json!({"source": "file", "anchor": "quote", "path": "/repo/todo.md",
                "quote": HEADSET, "line": 6, "endLine": 7}).to_string()},
            "text": "headset in files"}))
        .await
        .unwrap();
    let on_diff = service
        .add_thread(&json!({"sessionId": checkout.id, "anchor": {"path": "todo.md", "line": 6, "side": "new",
            "text": "- [ ] Headset (boom mic) muting after each turn: fixed twice on",
            "feedback": json!({"source": "diff", "kind": "combined", "path": "todo.md",
                "side": "new", "line": 6}).to_string()},
            "text": "on the diff"}))
        .await
        .unwrap();
    service
        .reanchor_file(&json!({"sessionId": checkout.id}))
        .await
        .unwrap();
    file.set(AFTER);
    pushes.lock().unwrap().clear();
    let snapshot = service
        .reanchor_file(&json!({"sessionId": checkout.id, "path": "todo.md"}))
        .await
        .unwrap();
    let anchor = |thread: &str| -> ReviewAnchor {
        snapshot
            .threads
            .iter()
            .find(|t| t.id == thread)
            .unwrap()
            .anchor
            .clone()
    };
    let moved = anchor(&in_files.id);
    assert_eq!((moved.line, moved.end_line), (Some(8), Some(9)));
    assert_eq!(anchor(&on_diff.id).line, Some(6));
    assert_eq!(
        pushes
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p["type"] == "session" && p["snapshot"]["session"]["id"] == json!(checkout.id))
            .count(),
        1
    );
    let reads = file.reads();
    service
        .reanchor_file(&json!({"sessionId": checkout.id, "path": "other.md"}))
        .await
        .unwrap();
    assert_eq!(file.reads(), reads);
}

#[tokio::test]
async fn a_thread_an_agent_wrote_with_no_line_text_is_given_its_lines_and_follows_it() {
    let (Kit { service, .. }, file, id) = file_setup();
    let thread = service
        .add_thread(&json!({"sessionId": id, "author": "Claude",
            "anchor": {"path": "todo.md", "line": 6, "endLine": 7, "side": "new"}, "text": "On the headset item"}))
        .await
        .unwrap();
    let of = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": id}))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.id == thread.id)
            .unwrap()
            .anchor
    };
    assert!(until(|| of(&service).text.is_some()).await);
    file.set(AFTER);
    service.reanchor_file(&json!({"sessionId": id})).await.unwrap();
    let anchor = of(&service);
    assert_eq!((anchor.line, anchor.end_line), (Some(8), Some(9)));
}

// Changes' entries (changes-anchors.test.ts).

/// HEAD a..f; the index adds S on top (staged); the working tree turns f
/// into F (unstaged) and has an untracked new.txt.
fn changes_checkout() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("a.txt"), "a\nb\nc\nd\ne\nf\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(root, &["commit", "-q", "-m", "base"]);
    std::fs::write(root.join("a.txt"), "S\na\nb\nc\nd\ne\nf\n").unwrap();
    git(root, &["add", "a.txt"]);
    std::fs::write(root.join("a.txt"), "S\na\nb\nc\nd\ne\nF\n").unwrap();
    std::fs::write(root.join("new.txt"), "one\ntwo\n").unwrap();
    dir
}

/// The worktree review with the paths of each read of its diff.
fn changes_kit(bun: &Path, loads: Arc<Mutex<Vec<Option<Vec<String>>>>>) -> Kit {
    let mut host = git_host(bun);
    let read = host.diff.take().unwrap();
    host.diff = Some(Box::new(move |session, commit, paths| {
        loads.lock().unwrap().push(paths.clone());
        read(session, commit, paths)
    }));
    kit(
        host,
        Options {
            delivery_delay_ms: Some(5),
            ..Options::default()
        },
    )
}

/// A diff note of Changes as workspaceFeedback.ts writes it: the
/// worktree review of the checkout (the branch's for a `branch` note), a
/// thread whose anchor is the entry's line and its note.
async fn write_note(
    service: &ReviewService,
    root: &str,
    id: &str,
    kind: &str,
    side: &str,
    line: i64,
    quote: &str,
    path: &str,
) -> (String, String) {
    let target = if kind == "branch" {
        json!({"kind": "range", "base": "main", "head": "HEAD"})
    } else {
        json!({"kind": "worktree"})
    };
    let session = service
        .open(&json!({"connectionId": "local", "workspaceId": "w1", "root": root, "target": target}))
        .unwrap()
        .session;
    let note = json!({"id": id, "source": "diff", "path": path, "kind": kind, "side": side,
        "line": line, "hunk": "@@", "quote": quote, "createdAt": line});
    let thread = service
        .add_thread(&json!({"sessionId": session.id, "kind": "draft",
            "anchor": {"path": path, "line": line, "side": side, "text": quote, "feedback": note.to_string()},
            "newThreadId": thread_id(id), "text": format!("On {quote}")}))
        .await
        .unwrap();
    (session.id, thread.id)
}

/// A 16 hexadecimal digit thread id per note (feedbackThreadId's form).
fn thread_id(note: &str) -> String {
    let hash = |seed: u32| {
        note.encode_utf16().fold(seed, |value, unit| {
            (value ^ u32::from(unit)).wrapping_mul(0x0100_0193)
        })
    };
    format!("{:08x}{:08x}", hash(0x811c_9dc5), hash(0x1b87_3593))
}

fn placed(service: &ReviewService, session: &str, note: &str) -> (Value, Value) {
    let thread = service
        .get(&json!({"sessionId": session}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == thread_id(note))
        .unwrap();
    let fed: Value = serde_json::from_str(thread.anchor.feedback.as_deref().unwrap()).unwrap();
    (
        json!([thread.anchor.side, thread.anchor.line, thread.anchor.text]),
        json!([fed["kind"], fed["side"], fed["line"]]),
    )
}

fn root_of(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().into_owned()
}

#[tokio::test]
async fn changes_entry_anchors_move_onto_the_combined_diff_by_their_lines_text() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let root = root_of(&dir);
    let loads: Arc<Mutex<Vec<Option<Vec<String>>>>> = Arc::default();
    let Kit { service, .. } = changes_kit(&bun, loads.clone());
    let notes = [
        ("staged-new", "staged", "new", 1, "S", "a.txt"),
        ("staged-ctx", "staged", "new", 4, "c", "a.txt"),
        ("staged-old", "staged", "old", 6, "f", "a.txt"),
        ("unstaged-old", "unstaged", "old", 7, "f", "a.txt"),
        ("unstaged-new", "unstaged", "new", 7, "F", "a.txt"),
        ("untracked", "untracked", "new", 2, "two", "new.txt"),
        ("gone", "unstaged", "old", 3, "no such line", "a.txt"),
    ];
    let mut session = String::new();
    for (id, kind, side, line, quote, path) in notes {
        session = write_note(&service, &root, id, kind, side, line, quote, path)
            .await
            .0;
    }
    service
        .migrate_entry_anchors(&json!({"sessionId": session}))
        .await
        .unwrap();
    let at = |note: &str| placed(&service, &session, note);
    assert_eq!(at("staged-new"), (json!(["new", 1, "S"]), json!(["combined", "new", 1])));
    assert_eq!(at("staged-ctx"), (json!(["new", 4, "c"]), json!(["combined", "new", 4])));
    assert_eq!(at("staged-old"), (json!(["old", 6, "f"]), json!(["combined", "old", 6])));
    assert_eq!(at("unstaged-old"), (json!(["old", 6, "f"]), json!(["combined", "old", 6])));
    assert_eq!(at("unstaged-new"), (json!(["new", 7, "F"]), json!(["combined", "new", 7])));
    assert_eq!(at("untracked"), (json!(["new", 2, "two"]), json!(["combined", "new", 2])));
    assert_eq!(
        at("gone"),
        (json!(["old", 3, "no such line"]), json!(["unstaged", "old", 3]))
    );
    let loads = loads.lock().unwrap().clone();
    assert!(!loads.is_empty());
    for paths in loads {
        assert!(
            paths
                .unwrap_or_default()
                .iter()
                .all(|path| path == "a.txt" || path == "new.txt")
        );
    }
    let moved = service
        .get(&json!({"sessionId": session}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == thread_id("unstaged-old"))
        .unwrap();
    assert_eq!(moved.comments[0].body, "On f");
    let note: Value = serde_json::from_str(moved.anchor.feedback.as_deref().unwrap()).unwrap();
    assert_eq!(
        (&note["id"], &note["source"], &note["path"], &note["quote"]),
        (&json!("unstaged-old"), &json!("diff"), &json!("a.txt"), &json!("f"))
    );
}

#[tokio::test]
async fn the_migration_runs_once_a_second_read_writes_nothing_a_migrated_thread_is_not_read_again() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let loads: Arc<Mutex<Vec<Option<Vec<String>>>>> = Arc::default();
    let Kit { service, .. } = changes_kit(&bun, loads.clone());
    let (session, thread) =
        write_note(&service, &root_of(&dir), "u", "unstaged", "old", 7, "f", "a.txt").await;
    let params = json!({"sessionId": session});
    let migrate = || service.migrate_entry_anchors(&params);
    let of = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": session}))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.id == thread)
            .unwrap()
    };
    migrate().await.unwrap();
    let first = of(&service);
    migrate().await.unwrap();
    service.list(&json!({"connectionId": "local"}));
    migrate().await.unwrap();
    let again = of(&service);
    assert_eq!(again.anchor, first.anchor);
    assert_eq!(again.updated_at, first.updated_at);
    assert_eq!(
        loads.lock().unwrap().iter().filter(|p| p.is_some()).count(),
        1
    );
}

#[tokio::test]
async fn the_migrated_anchors_are_kept_across_a_restart_of_the_server() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let kit = changes_kit(&bun, Arc::default());
    let (session, thread) =
        write_note(&kit.service, &root_of(&dir), "u", "unstaged", "old", 7, "f", "a.txt").await;
    kit.service
        .migrate_entry_anchors(&json!({"sessionId": session}))
        .await
        .unwrap();
    let found = kit
        .reopen()
        .get(&json!({"sessionId": session}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == thread)
        .unwrap();
    assert_eq!(
        (found.anchor.side.as_deref(), found.anchor.line),
        (Some("old"), Some(6))
    );
}

#[tokio::test]
async fn a_branch_reviews_threads_and_a_range_review_are_left_alone() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let loads: Arc<Mutex<Vec<Option<Vec<String>>>>> = Arc::default();
    let Kit { service, .. } = changes_kit(&bun, loads.clone());
    let (session, thread) =
        write_note(&service, &root_of(&dir), "b", "branch", "new", 7, "F", "a.txt").await;
    service
        .migrate_entry_anchors(&json!({"sessionId": session}))
        .await
        .unwrap();
    let snapshot = service.get(&json!({"sessionId": session})).unwrap();
    assert_eq!(snapshot.session.target.kind(), "range");
    let found = snapshot.threads.into_iter().find(|t| t.id == thread).unwrap();
    let note: Value = serde_json::from_str(found.anchor.feedback.as_deref().unwrap()).unwrap();
    assert_eq!(note["kind"], json!("branch"));
    assert!(loads.lock().unwrap().iter().all(Option::is_none));
}

async fn unstaged_f(service: &ReviewService, session: &str) -> ReviewThread {
    let note = json!({"id": "u", "source": "diff", "path": "a.txt", "kind": "unstaged", "side": "old",
        "line": 7, "hunk": "@@", "quote": "f", "comment": "On f", "createdAt": 7});
    service
        .add_thread(&json!({"sessionId": session, "anchor": {"path": "a.txt", "line": 7, "side": "old",
            "text": "f", "feedback": note.to_string()}, "text": "On f"}))
        .await
        .unwrap()
}

#[tokio::test]
async fn a_review_read_publishes_it_again_once_its_threads_moved() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let Kit {
        service, pushes, ..
    } = kit(git_host(&bun), Options::default());
    let opened = service
        .open(&json!({"connectionId": "local", "root": root_of(&dir), "target": {"kind": "worktree"}}))
        .unwrap();
    unstaged_f(&service, &opened.session.id).await;
    pushes.lock().unwrap().clear();
    service
        .get(&json!({"sessionId": opened.session.id}))
        .unwrap();
    service
        .migrate_entry_anchors(&json!({"sessionId": opened.session.id}))
        .await
        .unwrap();
    let lines: Vec<String> = pushes
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p["type"] == "session")
        .map(|p| {
            p["snapshot"]["threads"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["anchor"]["line"].to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    assert_eq!(lines, vec!["6"]);
}

#[tokio::test]
async fn a_checkout_not_readable_yet_is_asked_again_later() {
    let Some(bun) = bun() else { return };
    let dir = changes_checkout();
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut host = git_host(&bun);
    let read = host.diff.take().unwrap();
    let up = ready.clone();
    host.diff = Some(Box::new(move |session, commit, paths| {
        if !up.load(std::sync::atomic::Ordering::SeqCst) {
            return Box::pin(async { Err(LoadError::Failed("connection not ready".into())) });
        }
        read(session, commit, paths)
    }));
    let Kit { service, clock, .. } = kit(
        host,
        Options {
            clock: Some(Moved::at(1_763_200_800_000)),
            ..Options::default()
        },
    );
    let opened = service
        .open(&json!({"connectionId": "local", "root": root_of(&dir), "target": {"kind": "worktree"}}))
        .unwrap();
    let id = opened.session.id.clone();
    let thread = unstaged_f(&service, &id).await;
    let line = |service: &ReviewService| {
        service
            .get(&json!({"sessionId": id}))
            .unwrap()
            .threads
            .into_iter()
            .find(|t| t.id == thread.id)
            .unwrap()
            .anchor
            .line
    };
    let params = json!({"sessionId": id});
    let migrate = || service.migrate_entry_anchors(&params);
    migrate().await.unwrap();
    assert_eq!(line(&service), Some(7));
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    migrate().await.unwrap();
    assert_eq!(line(&service), Some(7));
    clock.advance(6_000);
    migrate().await.unwrap();
    assert_eq!(line(&service), Some(6));
}

// Rewritten commits (rewritten-anchors.test.ts).

const PLAY: &[&str] = &[
    "#include <gst-c.h>",
    "",
    "static void",
    "die (const char *what, GstError *err)",
    "{",
    "  fprintf (stderr, \"%s\\n\", what);",
    "}",
    "",
    "int",
    "main (void)",
    "{",
    "  return 0;",
    "}",
];
const SUBJECT: &str = "gst-c: Add futures, elements written in C, and the pipeline";

/// main, then topic: a first commit, the one commented on, a last one.
fn rewritten_repository() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("rg-rw-")
        .tempdir_in("/tmp")
        .unwrap();
    let root = dir.path().canonicalize().unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("README"), "readme\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "first"]);
    git(&root, &["checkout", "-q", "-b", "topic"]);
    std::fs::write(root.join("caps.c"), "caps\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "gst-c: a C API for caps"]);
    std::fs::write(root.join("play.c"), format!("{}\n", lines(PLAY))).unwrap();
    std::fs::write(
        root.join("element.rs"),
        "pub struct GstPad {\n    _private: [u8; 0],\n}\n",
    )
    .unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", SUBJECT]);
    std::fs::write(root.join("docs.md"), "docs\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "docs"]);
    (dir, root)
}

fn open_on(service: &ReviewService, root: &Path, target: Value) -> String {
    service
        .open(&json!({"connectionId": "local", "root": root, "target": target, "raise": false}))
        .unwrap()
        .session
        .id
}

/// A comment written in a commit's view in Changes, as the browser sends it.
async fn on_commit(
    service: &ReviewService,
    session: &str,
    root: &Path,
    path: &str,
    text: &str,
    body: &str,
) -> ReviewThread {
    let sha = git(root, &["rev-parse", "topic~1"]);
    let parent = git(root, &["rev-parse", "topic~2"]);
    let line: i64 = git(root, &["grep", "-n", "-F", text, "topic~1", "--", path])
        .split(':')
        .nth(2)
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let feedback = json!({"source": "diff", "path": path, "kind": "branch", "side": "new", "line": line,
        "quote": text, "hunk": "@@", "commit": {"sha": sha, "subject": SUBJECT, "parent": parent},
        "id": format!("note-{body}"), "createdAt": 1});
    service
        .add_thread(&json!({"sessionId": session, "anchor": {"path": path, "commit": sha,
            "commitSubject": SUBJECT, "commitParent": parent, "line": line, "side": "new", "text": text,
            "feedback": feedback.to_string()}, "text": body}))
        .await
        .unwrap()
}

/// Amends the commented commit and replays the branch, as an agent does.
fn amend_and_replay(root: &Path, edit: impl FnOnce()) -> String {
    git(root, &["checkout", "-q", "topic~1"]);
    edit();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "--amend", "--no-edit"]);
    let amended = git(root, &["rev-parse", "HEAD"]);
    git(root, &["checkout", "-q", "topic"]);
    git(root, &["rebase", "-q", "--onto", &amended, "topic~1"]);
    amended
}

fn thread_of(service: &ReviewService, session: &str, id: &str) -> ReviewAnchor {
    service
        .get(&json!({"sessionId": session}))
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == id)
        .unwrap()
        .anchor
}

#[tokio::test]
async fn threads_on_an_amended_commit_follow_it_onto_the_new_commit_and_their_line_there() {
    let Some(bun) = bun() else { return };
    let (_dir, root) = rewritten_repository();
    let Kit {
        service, pushes, ..
    } = kit(git_host(&bun), Options::default());
    let branch = open_on(&service, &root, json!({"kind": "range", "base": "main", "head": "HEAD"}));
    let before = open_on(&service, &root, json!({"kind": "range", "base": "main", "head": "topic"}));
    let die = on_commit(&service, &before, &root, "play.c", "die (const char *what, GstError *err)", "Logging?").await;
    let pad = on_commit(&service, &branch, &root, "element.rs", "    _private: [u8; 0],", "What does [u8; 0] mean?!").await;
    let exit = on_commit(&service, &branch, &root, "play.c", "  return 0;", "Exit code?").await;
    let was = thread_of(&service, &branch, &pad.id).commit;
    let edited = root.clone();
    let amended = amend_and_replay(&root, move || {
        std::fs::write(
            edited.join("play.c"),
            format!(
                "/* Plays a URI. */\n\n{}\n",
                lines(PLAY).replace("  return 0;", "  return run ();")
            ),
        )
        .unwrap();
    });
    assert_ne!(Some(amended.clone()), was);
    pushes.lock().unwrap().clear();
    service
        .commits(&json!({"sessionId": branch}))
        .await
        .unwrap();
    service
        .reanchor_rewritten(&json!({"sessionId": branch}))
        .await
        .unwrap();
    let moved = thread_of(&service, &before, &die.id);
    assert_eq!(moved.commit.as_deref(), Some(amended.as_str()));
    assert_eq!(moved.commit_parent, Some(git(&root, &["rev-parse", "topic~2"])));
    assert_eq!(moved.line, Some(6));
    assert!(!moved.outdated);
    let note: Value = serde_json::from_str(moved.feedback.as_deref().unwrap()).unwrap();
    assert_eq!(note["commit"]["sha"], json!(amended));
    assert_eq!(note["line"], json!(6));
    let pad_moved = thread_of(&service, &branch, &pad.id);
    assert_eq!(pad_moved.commit.as_deref(), Some(amended.as_str()));
    assert_eq!(pad_moved.line, Some(2));
    let gone = thread_of(&service, &branch, &exit.id);
    assert_eq!(gone.commit.as_deref(), Some(amended.as_str()));
    assert!(gone.outdated);
    assert_eq!(gone.line, Some(12));
    let told: Vec<String> = pushes
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p["type"] == "session")
        .map(|p| p["snapshot"]["session"]["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(told.contains(&branch));
    assert!(told.contains(&before));
    pushes.lock().unwrap().clear();
    service
        .reanchor_rewritten(&json!({"sessionId": branch}))
        .await
        .unwrap();
    assert!(pushes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_commit_squashed_away_its_thread_goes_to_its_line_in_the_whole_change() {
    let Some(bun) = bun() else { return };
    let (_dir, root) = rewritten_repository();
    let Kit { service, .. } = kit(git_host(&bun), Options::default());
    let branch = open_on(&service, &root, json!({"kind": "range", "base": "main", "head": "HEAD"}));
    let die = on_commit(&service, &branch, &root, "play.c", "die (const char *what, GstError *err)", "Logging?").await;
    git(&root, &["reset", "-q", "--soft", "main"]);
    git(&root, &["commit", "-q", "-m", "gst-c: everything at once"]);
    service
        .reanchor_rewritten(&json!({"sessionId": branch}))
        .await
        .unwrap();
    let anchor = thread_of(&service, &branch, &die.id);
    assert!(anchor.commit.is_none());
    assert_eq!(anchor.line, Some(4));
    assert!(!anchor.outdated);
    let note: Value = serde_json::from_str(anchor.feedback.as_deref().unwrap()).unwrap();
    assert!(note.get("commit").is_none());
}

#[tokio::test]
async fn another_branchs_thread_is_not_moved_onto_this_one_by_its_subject() {
    let Some(bun) = bun() else { return };
    let (_dir, root) = rewritten_repository();
    let Kit { service, .. } = kit(git_host(&bun), Options::default());
    git(&root, &["branch", "other", "topic"]);
    let other = open_on(&service, &root, json!({"kind": "range", "base": "main", "head": "other"}));
    let thread = on_commit(&service, &other, &root, "play.c", "die (const char *what, GstError *err)", "On other").await;
    let edited = root.clone();
    amend_and_replay(&root, move || {
        std::fs::write(edited.join("play.c"), format!("/* changed */\n{}\n", lines(PLAY))).unwrap();
    });
    let branch = open_on(&service, &root, json!({"kind": "range", "base": "main", "head": "HEAD"}));
    service
        .reanchor_rewritten(&json!({"sessionId": branch}))
        .await
        .unwrap();
    let anchor = thread_of(&service, &other, &thread.id);
    assert_eq!(anchor.commit, Some(git(&root, &["rev-parse", "other~1"])));
    assert!(!anchor.outdated);
}
