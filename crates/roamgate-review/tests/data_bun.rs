//! reviews.sqlite opened both ways (the plan's section 5.7 and Phase 8's
//! exit): what the Bun server's storage (server/src/review/storage.ts)
//! wrote, Rust reads and writes back unchanged (forward); what Rust wrote,
//! Bun reads (backward); one reads while the other holds the database open
//! with WAL (coexistence). Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use roamgate_base::paths::{DataContext, Platform};
use roamgate_review::model::{ReviewSession, ReviewThread};
use roamgate_review::storage::ReviewStorage;
use serde_json::{Value, json};

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
        eprintln!("skipped: bun is not on PATH, the Bun side of reviews.sqlite cannot run");
    }
    found
}

fn storage_module() -> String {
    repo()
        .join("server/src/review/storage.ts")
        .to_string_lossy()
        .into_owned()
}

fn script(bun: &Path, home: &Path, source: &str, args: &[&str]) -> Command {
    let mut command = Command::new(bun);
    command
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_REVIEW_DIR")
        .arg("-e")
        .arg(source)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn ok(output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn context(home: &Path) -> DataContext {
    DataContext::new(home, Platform::Unix, None)
}

/// A review and threads as the Bun service writes them, with every kind
/// of field a record carries.
fn records() -> (Value, Vec<Value>) {
    let session = json!({
        "id": "0123456789abcdef", "connectionId": "local", "workspaceId": "w1",
        "root": "/home/u/repo", "title": "Feature review",
        "target": {"kind": "range", "base": "main", "head": "HEAD"},
        "automaticBase": true, "gitlab": false, "autoSend": true,
        "summary": "Looks good",
        "agent": {"name": "claude", "paneId": "w1:p1", "sessionId": "abc",
                  "working": {"at": "2026-01-01T00:00:01.000Z", "message": "on it", "threadId": "1111111111111111"}},
        "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:02.000Z",
        "deliveredAt": "2026-01-01T00:00:01.500Z", "reviewed": {"all:f.txt": "abc", "all:f.txt\nh1": "1"},
        "holdComments": true, "seenHeadSha": "deadbeef"
    });
    let threads = vec![
        json!({
            "id": "1111111111111111", "sessionId": "0123456789abcdef", "kind": "discussion",
            "anchor": {"path": "f.txt", "line": 2, "endLine": 3, "side": "new", "text": "TWO",
                       "feedback": "{\"source\":\"diff\",\"kind\":\"combined\"}"},
            "comments": [
                {"id": "2222222222222222", "author": "you", "body": "Why upper case?",
                 "createdAt": "2026-01-01T00:00:00.100Z", "updatedAt": "2026-01-01T00:00:00.100Z"},
                {"id": "3333333333333333", "author": "claude", "body": "Fixed.",
                 "createdAt": "2026-01-01T00:00:00.200Z", "updatedAt": "2026-01-01T00:00:00.300Z"}
            ],
            "resolved": false, "createdAt": "2026-01-01T00:00:00.100Z", "updatedAt": "2026-01-01T00:00:00.300Z",
            "handedAt": "2026-01-01T00:00:00.250Z"
        }),
        json!({
            "id": "4444444444444444", "sessionId": "0123456789abcdef", "kind": "draft",
            "anchor": {"render": {"quote": "words", "region": {"x": 0.25, "y": 0, "w": 0.5, "h": 0.125}},
                       "chat": {"entry": "e1", "quote": "q", "at": "2026-01-01T00:00:00.000Z"},
                       "effort": {"tab": "ledger", "item": {"kind": "commit", "key": "k", "label": "abc subject"}},
                       "work": {"item": "0123abcd", "description": true}},
            "comments": [{"id": "5555555555555555", "author": "you", "body": "```suggestion\nx\n```",
                          "createdAt": "2026-01-01T00:00:00.400Z", "updatedAt": "2026-01-01T00:00:00.400Z"}],
            "resolved": true, "createdAt": "2026-01-01T00:00:00.400Z", "updatedAt": "2026-01-01T00:00:00.400Z",
            "held": 3, "pendingFor": "https://gitlab.example.com/g/p/-/merge_requests/7",
            "gitlabReplyTo": "abcdef"
        }),
    ];
    (session, threads)
}

const BUN_WRITE: &str = r#"
const { openReviewStorage } = await import(process.argv[1]);
const [session, threads] = JSON.parse(process.argv[3]);
const storage = openReviewStorage(process.argv[2]);
storage.saveSession(session);
for (const thread of threads) storage.saveThread(thread);
storage.close();
"#;

const BUN_READ: &str = r#"
const { openReviewStorage } = await import(process.argv[1]);
const storage = openReviewStorage(process.argv[2]);
const sessions = storage.loadSessions();
console.log(JSON.stringify(sessions.map((session) => [session, storage.loadThreads(session.id)])));
storage.close();
"#;

/// Holds the database open (and a write pending in its WAL) until told.
const BUN_HOLD: &str = r#"
const { openReviewStorage } = await import(process.argv[1]);
const { existsSync, writeFileSync } = await import("node:fs");
const [session, threads] = JSON.parse(process.argv[3]);
const storage = openReviewStorage(process.argv[2]);
storage.saveSession(session);
for (const thread of threads) storage.saveThread(thread);
writeFileSync(process.argv[4], "ready");
while (!existsSync(process.argv[5])) Bun.sleepSync(20);
const sessions = storage.loadSessions();
console.log(JSON.stringify(sessions.map((s) => [s, storage.loadThreads(s.id)])));
storage.close();
"#;

fn wait_for(path: &Path, child: &mut Child) {
    let start = Instant::now();
    while !path.exists() {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("bun exited early: {status}");
        }
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "bun never got ready"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn read_with_rust(home: &Path) -> Vec<(Value, Vec<Value>)> {
    let storage = ReviewStorage::open(&context(home), &home.join("reviews")).unwrap();
    storage
        .load_session_values()
        .unwrap()
        .into_iter()
        .map(|session| {
            let id = session["id"].as_str().unwrap().to_owned();
            let threads = storage.load_thread_values(&id).unwrap();
            (session, threads)
        })
        .collect()
}

#[test]
fn forward_what_bun_wrote_rust_reads_and_writes_back_unchanged() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("reviews");
    let (session, threads) = records();
    let payload = json!([session, threads]).to_string();
    ok(script(
        &bun,
        home.path(),
        BUN_WRITE,
        &[&storage_module(), dir.to_str().unwrap(), &payload],
    )
    .output()
    .unwrap());
    // Read raw and typed: the typed records are what the service holds.
    assert_eq!(
        read_with_rust(home.path()),
        vec![(session.clone(), threads.clone())]
    );
    let storage = ReviewStorage::open(&context(home.path()), &dir).unwrap();
    let typed: Vec<ReviewSession> = storage.load_sessions().unwrap();
    let typed_threads: Vec<ReviewThread> = storage.load_threads(&typed[0].id).unwrap();
    assert_eq!(serde_json::to_value(&typed[0]).unwrap(), session);
    assert_eq!(
        serde_json::to_value(&typed_threads).unwrap(),
        json!(threads)
    );
    // Written back by Rust (the owner after a flip), read by Bun again.
    storage.save_session(&typed[0]).unwrap();
    for thread in &typed_threads {
        storage.save_thread(thread).unwrap();
    }
    drop(storage);
    let read = ok(script(
        &bun,
        home.path(),
        BUN_READ,
        &[&storage_module(), dir.to_str().unwrap()],
    )
    .output()
    .unwrap());
    let read: Value = serde_json::from_str(&read).unwrap();
    assert_eq!(read, json!([[session, threads]]));
}

#[test]
fn backward_what_rust_wrote_bun_reads() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("reviews");
    let (session, threads) = records();
    let storage = ReviewStorage::open(&context(home.path()), &dir).unwrap();
    let typed: ReviewSession = serde_json::from_value(session.clone()).unwrap();
    storage.save_session(&typed).unwrap();
    for thread in &threads {
        let typed: ReviewThread = serde_json::from_value(thread.clone()).unwrap();
        storage.save_thread(&typed).unwrap();
    }
    drop(storage);
    let read = ok(script(
        &bun,
        home.path(),
        BUN_READ,
        &[&storage_module(), dir.to_str().unwrap()],
    )
    .output()
    .unwrap());
    let read: Value = serde_json::from_str(&read).unwrap();
    assert_eq!(read, json!([[session, threads]]));
    // And Bun, the owner again after a flip back, writes on what Rust left.
    let (mut later, _) = records();
    later["id"] = json!("fedcba9876543210");
    later["updatedAt"] = json!("2026-01-03T00:00:00.000Z");
    ok(script(
        &bun,
        home.path(),
        BUN_WRITE,
        &[
            &storage_module(),
            dir.to_str().unwrap(),
            &json!([later, []]).to_string(),
        ],
    )
    .output()
    .unwrap());
    let both = read_with_rust(home.path());
    assert_eq!(both.len(), 2);
    assert_eq!(both[1].0, later);
}

#[test]
fn coexistence_rust_reads_while_bun_holds_the_database_and_bun_after_rust() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("reviews");
    let (session, threads) = records();
    let ready = home.path().join("ready");
    let release = home.path().join("release");
    let mut holder = script(
        &bun,
        home.path(),
        BUN_HOLD,
        &[
            &storage_module(),
            dir.to_str().unwrap(),
            &json!([session, threads]).to_string(),
            ready.to_str().unwrap(),
            release.to_str().unwrap(),
        ],
    )
    .spawn()
    .unwrap();
    wait_for(&ready, &mut holder);
    // Bun has it open with its writes in the WAL: a read-only reader (the
    // non-owner's shadow read) and a second writer both see them.
    let readonly = roamgate_base::sqlite::SqliteDb::open_readonly(
        &context(home.path()),
        &dir.join("reviews.sqlite"),
        5_000,
    )
    .unwrap();
    let count: i64 = readonly
        .conn
        .query_row("SELECT count(*) FROM threads", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    drop(readonly);
    let storage = ReviewStorage::open(&context(home.path()), &dir).unwrap();
    let mut second: ReviewSession = serde_json::from_value(session.clone()).unwrap();
    second.id = "aaaaaaaaaaaaaaaa".into();
    second.updated_at = "2026-01-05T00:00:00.000Z".into();
    storage.save_session(&second).unwrap();
    drop(storage);
    std::fs::write(&release, "go").unwrap();
    let output = holder.wait_with_output().unwrap();
    let seen: Value = serde_json::from_str(&ok(output)).unwrap();
    // Bun, still open, reads what Rust wrote meanwhile.
    assert_eq!(seen.as_array().unwrap().len(), 2);
    assert_eq!(seen[1][0]["id"], json!("aaaaaaaaaaaaaaaa"));
    assert_eq!(seen[0], json!([session, threads]));
}
