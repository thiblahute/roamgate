//! work.json and history.jsonl opened both ways (the plan's section 5.7):
//! the Bun server's store (server/src/work/store.ts) and Rust's read the
//! same file into the same board and write it back with the same bytes
//! (forward and backward), and append the same history lines. Skipped,
//! saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Arc;

use roamgate_base::paths::{DataContext, Platform};
use roamgate_work::store::{NoHistory, StoreWrites, WorkStore};
use serde_json::{Map, Value, json};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the Bun side of work.json cannot run");
    }
    found
}

fn ok(output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Opens the store of `directory` with Bun's store.ts, saves its first
/// project unchanged (the whole file written again) and, given an item id
/// and a change, saves that item with the change as a history line.
fn bun_resave(bun: &Path, home: &Path, directory: &Path, item: Option<(&str, &Value)>) {
    let store = repo().join("server/src/work/store.ts");
    let source = r#"
        const { openWorkStore } = await import(process.argv[1]);
        const store = openWorkStore(process.argv[2]);
        store.saveProject(store.projects()[0]);
        if (process.argv[3]) {
          const item = store.item(process.argv[3]);
          store.saveItem(item, JSON.parse(process.argv[4]));
        }
        console.log("ok");
    "#;
    let mut command = Command::new(bun);
    command
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_DATA_DIR")
        .arg("-e")
        .arg(source)
        .arg(&store)
        .arg(directory);
    if let Some((id, change)) = item {
        command.arg(id).arg(change.to_string());
    }
    let output = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(ok(output), "ok");
}

fn rust_resave(home: &Path, directory: &Path, item: Option<(&str, &Value)>) {
    let context = DataContext::new(home, Platform::Unix, None);
    let mut store = WorkStore::open(
        directory,
        StoreWrites::Disk {
            context,
            can_write: None,
        },
        Arc::new(NoHistory),
        Arc::new(|| "2026-01-02T00:00:00.000Z".to_owned()),
    );
    let project = store.projects()[0].clone();
    store.save_project(project).unwrap();
    if let Some((id, change)) = item {
        let item = store.item(id).unwrap().clone();
        let change: &Map<String, Value> = change.as_object().unwrap();
        store.save_item(item, Some(change), None).unwrap();
    }
}

/// A board with every kind of field the store keeps, what it drops (unknown
/// fields, invalid items and links) and text that needs escaping.
fn board() -> Value {
    json!({
        "version": 1,
        "extra": "dropped",
        "projects": [
            {"id": "zeta", "name": "Zeta\tproject", "roots": [], "done": {"kind": "deployed"}},
            {
                "id": "roamgate", "name": "Roamgate",
                "roots": [{"connectionId": "local", "path": "/home/u/roamgate", "x": 1}, {"path": "/no/connection"}],
                "done": {"kind": "branch", "root": "/home/u/roamgate", "branch": "dogfood", "connectionId": "local"},
                "tags": ["Rust", "rust", " ux "],
                "coordinator": {"session": "desktop/w35:p1"},
                "unknown": true
            },
            {"id": "gst2", "name": "gst2 \u{e9}t\u{e9}", "roots": [], "done": {"kind": "nope"}, "parent": "gst2"},
            {"id": "child", "name": "Child", "roots": [], "done": {"kind": "deployed"}, "parent": "roamgate", "coordinator": {"session": "bad"}},
            {"name": "no id"}
        ],
        "items": [
            {
                "id": "0123456789abcdef", "project": "roamgate",
                "title": "Port the board \u{2014} \"quoted\", \\back\\slash, \u{1f680} and \u{2028}",
                "state": "doing", "tags": ["rust", "Rust", "p1"],
                "owner": {"session": "desktop/w35:p1", "task": "a0a5b2a0a1e034112"},
                "source": "review thread 1a2b3c4d",
                "links": [
                    {"kind": "review", "id": "0fa76e38e8f7743d", "thread": "0cac5d81f4ac3723"},
                    {"kind": "effort", "id": "e1", "part": "p2"},
                    {"kind": "pr", "url": "https://example.com/mr/1"},
                    {"kind": "commit", "sha": "afaadb321e", "subject": "Serve", "root": "/home/u/roamgate"},
                    {"kind": "branch", "name": "rust/s15-work"},
                    {"kind": "decision", "path": "plans/rust-migration.md", "id": "D3"},
                    {"kind": "file", "path": "plans/x.md", "root": "/home/u", "line": 12, "label": "Plan"},
                    {"kind": "item", "id": "96536bfb6a694136"},
                    {"kind": "deploy", "sha": "c0e3b13037", "branch": "dogfood"},
                    {"kind": "chat", "session": "desktop/w35:p1", "chat": "8a6a", "entry": "e9"},
                    {"kind": "unknown", "x": 1}
                ],
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:01:00.000Z",
                "by": "agent", "review": "0fa76e38e8f7743d",
                "ask": "  Choose:\nmedia to the car,   or none  ",
                "answers": ["Media", "None", "media", ""],
                "questions": 2, "extra": {"dropped": true}
            },
            {
                "id": "89abcdef", "project": "zeta", "title": "Done one", "state": "done",
                "tags": [], "links": [], "createdAt": "2026-01-01T00:00:00.000Z",
                "doneAt": "2026-01-01T02:00:00.000Z", "by": "user", "needsTriage": true,
                "answers": ["no ask, dropped"], "questions": 1.5
            },
            {
                "id": "fedcba98", "project": "gst2", "title": "Owner refused", "state": "open",
                "owner": {"session": "not an address"}, "links": "not a list", "by": "robot",
                "questions": 0
            },
            {"id": "NOTHEX", "project": "zeta", "title": "bad id", "state": "open"},
            {"id": "aaaaaaaa", "project": "zeta", "title": "bad state", "state": "later"},
            {"id": "bbbbbbbb", "project": "zeta", "state": "open"}
        ]
    })
}

fn homes() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let bun_home = temp.path().join("bun");
    let rust_home = temp.path().join("rust");
    for home in [&bun_home, &rust_home] {
        std::fs::create_dir_all(home.join("work")).unwrap();
    }
    (temp, bun_home, rust_home)
}

fn seed(home: &Path, text: &str) -> PathBuf {
    let directory = home.join("work");
    std::fs::write(directory.join("work.json"), text).unwrap();
    directory
}

#[test]
fn the_same_board_is_read_and_written_back_with_the_same_bytes() {
    let Some(bun) = bun() else { return };
    let (_temp, bun_home, rust_home) = homes();
    let raw = serde_json::to_string_pretty(&board()).unwrap();
    let bun_dir = seed(&bun_home, &raw);
    let rust_dir = seed(&rust_home, &raw);

    bun_resave(&bun, &bun_home, &bun_dir, None);
    rust_resave(&rust_home, &rust_dir, None);
    let bun_bytes = std::fs::read_to_string(bun_dir.join("work.json")).unwrap();
    let rust_bytes = std::fs::read_to_string(rust_dir.join("work.json")).unwrap();
    assert_eq!(
        rust_bytes, bun_bytes,
        "the same raw board, normalised and written"
    );

    // Forward: what Bun wrote, Rust writes back unchanged.
    let forward = seed(&rust_home, &bun_bytes);
    rust_resave(&rust_home, &forward, None);
    assert_eq!(
        std::fs::read_to_string(forward.join("work.json")).unwrap(),
        bun_bytes
    );
    // Backward: what Rust wrote, Bun writes back unchanged.
    let backward = seed(&bun_home, &rust_bytes);
    bun_resave(&bun, &bun_home, &backward, None);
    assert_eq!(
        std::fs::read_to_string(backward.join("work.json")).unwrap(),
        rust_bytes
    );
}

#[test]
fn a_change_appends_the_same_history_line() {
    let Some(bun) = bun() else { return };
    let (_temp, bun_home, rust_home) = homes();
    let raw = serde_json::to_string(&board()).unwrap();
    let bun_dir = seed(&bun_home, &raw);
    let rust_dir = seed(&rust_home, &raw);
    // A line Bun wrote before, which Rust appends after.
    let earlier = "{\"at\":\"2025-12-31T00:00:00.000Z\",\"item\":\"0123456789abcdef\",\"by\":\"user\",\"change\":{\"state\":[\"open\",\"doing\"]}}\n";
    for dir in [&bun_dir, &rust_dir] {
        std::fs::write(dir.join("history.jsonl"), earlier).unwrap();
    }
    let change = json!({"state": ["doing", "verify"], "owner": [null, {"session": "desktop/w35:p1"}], "note": "caf\u{e9} \u{1f680}"});

    bun_resave(
        &bun,
        &bun_home,
        &bun_dir,
        Some(("0123456789abcdef", &change)),
    );
    rust_resave(&rust_home, &rust_dir, Some(("0123456789abcdef", &change)));
    let bun_history = std::fs::read_to_string(bun_dir.join("history.jsonl")).unwrap();
    let rust_history = std::fs::read_to_string(rust_dir.join("history.jsonl")).unwrap();
    assert_eq!(rust_history, bun_history);
    assert_eq!(rust_history.lines().count(), 2);

    // Each reads the other's history of the item.
    let context = DataContext::new(&rust_home, Platform::Unix, None);
    let store = WorkStore::open(
        &bun_dir,
        StoreWrites::Disk {
            context,
            can_write: None,
        },
        Arc::new(NoHistory),
        Arc::new(|| "2026-01-02T00:00:00.000Z".to_owned()),
    );
    assert_eq!(store.history_of("0123456789abcdef").len(), 2);
}

/// A real board (`ROAMGATE_WORK_SAMPLE`, the path of a work.json, read
/// only): Bun and Rust write it back with the same bytes. Skipped unset.
#[test]
fn a_sample_board_is_written_back_with_the_same_bytes() {
    let Some(sample) = std::env::var_os("ROAMGATE_WORK_SAMPLE") else {
        eprintln!("skipped: ROAMGATE_WORK_SAMPLE names no work.json");
        return;
    };
    let Some(bun) = bun() else { return };
    let (_temp, bun_home, rust_home) = homes();
    let raw = std::fs::read_to_string(sample).unwrap();
    let bun_dir = seed(&bun_home, &raw);
    let rust_dir = seed(&rust_home, &raw);
    bun_resave(&bun, &bun_home, &bun_dir, None);
    rust_resave(&rust_home, &rust_dir, None);
    assert_eq!(
        std::fs::read_to_string(rust_dir.join("work.json")).unwrap(),
        std::fs::read_to_string(bun_dir.join("work.json")).unwrap()
    );
}
