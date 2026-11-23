//! tasks.sqlite (user_version 3) opened both ways (the plan's section 5.7
//! and Phase 11's exit): what the Bun server's storage
//! (server/src/assistant/task-storage.ts) wrote, Rust reads and writes back
//! with the same bytes in every column (forward); what Rust wrote, Bun reads
//! and validates (backward); one reads and writes while the other holds the
//! database open with WAL (coexistence). An older Roamgate's version 1
//! database written by Bun migrates in Rust. Skipped, saying why, when bun
//! is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use roamgate_assistant::task_storage::TaskStorage;
use roamgate_base::paths::{DataContext, Platform};
use rusqlite::Connection;
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
        eprintln!("skipped: bun is not on PATH, the Bun side of tasks.sqlite cannot run");
    }
    found
}

fn modules() -> [String; 2] {
    ["task-storage.ts", "tasks.ts"].map(|file| {
        repo()
            .join("server/src/assistant")
            .join(file)
            .to_string_lossy()
            .into_owned()
    })
}

fn script(bun: &Path, home: &Path, source: &str, args: &[&str]) -> Command {
    let [storage, tasks] = modules();
    let mut command = Command::new(bun);
    command
        .current_dir(repo().join("server"))
        .env("HOME", home)
        .env_remove("ROAMGATE_ASSISTANT_DIR")
        .env_remove("ROAMGATE_DATA_DIR")
        .arg("-e")
        .arg(source)
        .arg(storage)
        .arg(tasks)
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

const BUN_WRITE: &str = r#"
const { openTaskStorage } = await import(process.argv[1]);
const { validateSavedTasks } = await import(process.argv[2]);
const storage = openTaskStorage(process.argv[3], validateSavedTasks);
storage.save(JSON.parse(process.argv[4]));
storage.close();
"#;

const BUN_READ: &str = r#"
const { openTaskStorage } = await import(process.argv[1]);
const { validateSavedTasks } = await import(process.argv[2]);
const storage = openTaskStorage(process.argv[3], validateSavedTasks);
console.log(JSON.stringify(storage.load()));
storage.close();
"#;

/// Holds the database open after a save until told, then reads it again.
const BUN_HOLD: &str = r#"
const { openTaskStorage } = await import(process.argv[1]);
const { validateSavedTasks } = await import(process.argv[2]);
const { existsSync, writeFileSync } = await import("node:fs");
const storage = openTaskStorage(process.argv[3], validateSavedTasks);
storage.save(JSON.parse(process.argv[4]));
writeFileSync(process.argv[5], "ready");
while (!existsSync(process.argv[6])) Bun.sleepSync(20);
console.log(JSON.stringify(storage.load()));
storage.close();
"#;

const TASK: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const RUNNING: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const DONE: &str = "16fd2706-8baf-433b-82eb-8c7fada847da";
const PROPOSAL: &str = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const DATE: &str = "2026-10-04T00:00:00.000Z";

fn prepared(mentions: bool) -> Value {
    let scope = json!([
        {"connection_id": "local", "workspace_id": "w1"},
        {"connection_id": "ssh:box", "workspace_id": "w2"}
    ]);
    let mut input = json!({
        "title": "Check workspaces",
        "prompt": "Report verified progress, \u{e9}t\u{e9} \u{1f600}",
        "scope": scope,
        "schedule": {"type": "daily", "time": "09:30", "timezone": "Europe/Paris"},
        "notification_mode": "agent",
    });
    if mentions {
        input["mentions"] = json!([{
            "kind": "agent", "connection_id": "local", "workspace_id": "w1",
            "connection_label": "Local", "workspace_label": "One", "label": "Codex session",
            "runtime_generation": 3, "pane_id": "p1", "terminal_id": "t1", "agent": "codex",
            "agent_identity": "c".repeat(64),
        }]);
    }
    json!({
        "input": input,
        "config": {
            "thinking_level": "high",
            "provider": "claude-code",
            "model": "claude-opus",
            "credential_source": "assistant",
            "allowed_workspaces": scope,
            "approval_mode": "auto",
        },
        "targets": [
            {"connection_id": "local", "workspace_id": "w1", "endpoint_fingerprint": "a".repeat(64),
             "workspace_identity": "b".repeat(64), "herdr_boot_id": "boot-1"},
            {"connection_id": "ssh:box", "workspace_id": "w2", "endpoint_fingerprint": "d".repeat(64),
             "workspace_identity": "e".repeat(64), "herdr_boot_id": "boot-2"}
        ],
        "workspaces": [
            {"connection_id": "local", "workspace_id": "w1", "connection_label": "Local",
             "label": "One", "runtime_generation": 3},
            {"connection_id": "ssh:box", "workspace_id": "w2", "connection_label": "Box",
             "label": "Two", "runtime_generation": 7}
        ],
    })
}

fn with(base: Value, extra: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    for (key, value) in extra.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

/// A state with every field a saved task carries: an unfinished run with
/// its admission, a finished one with a notice, receipts, mentions, a
/// proposal and a request.
fn state() -> Value {
    let mut input = prepared(true)["input"].clone();
    input["all_workspaces"] = json!(true);
    let entry = with(
        with(prepared(true), json!({"input": input})),
        json!({
            "task": {"id": TASK, "status": "active", "created_at": DATE,
                     "updated_at": "2026-10-04T00:00:01.000Z", "next_run_at": "2026-10-05T07:30:00.000Z"},
            "due_at": DATE,
            "notifications": [{
                "event_key": "agent-completed", "kind": "completed", "title": "Agent finished",
                "body": "All requested work was verified.", "run_id": DONE,
                "created_at": DATE, "scope_key": "f".repeat(64)
            }],
            "runs": [
                with(prepared(true), json!({
                    "id": RUNNING, "task_id": TASK, "status": "running", "scheduled_at": DATE,
                    "started_at": DATE, "error": null, "manual": true,
                    "notice": "Skipped a workspace no longer open: Box / Gone."
                })),
                json!({
                    "id": DONE, "task_id": TASK, "status": "succeeded", "scheduled_at": DATE,
                    "started_at": DATE, "finished_at": "2026-10-04T00:05:00.000Z",
                    "error": null, "manual": false
                }),
            ],
        }),
    );
    let mut proposal = prepared(false)["input"].clone();
    for (key, value) in json!({
        "operation": "update", "detail": "Run at 09:30 instead",
        "id": PROPOSAL, "status": "pending", "created_at": DATE, "task_id": TASK
    })
    .as_object()
    .unwrap()
    {
        proposal[key] = value.clone();
    }
    json!({
        "tasks": [entry],
        "proposals": [{"proposal": proposal, "prepared": prepared(false)}],
        "requests": [{"id": "request-1", "task_id": TASK}],
    })
}

/// Every row of every table, as text, for byte comparisons.
fn dump(path: &Path) -> Vec<String> {
    let db = Connection::open_with_flags(
        path.join("tasks.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut out = Vec::new();
    for table in ["tasks", "runs", "proposals", "requests", "run_notices"] {
        let mut statement = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let count = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                let values: Vec<rusqlite::types::Value> =
                    (0..count).map(|i| row.get(i)).collect::<Result<_, _>>()?;
                Ok(format!("{table} {values:?}"))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        out.extend(rows);
    }
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    out.push(format!("user_version {version}"));
    out
}

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

#[test]
fn forward_what_bun_wrote_rust_reads_and_writes_back_byte_for_byte() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("assistant");
    let saved = state();
    ok(script(
        &bun,
        home.path(),
        BUN_WRITE,
        &[dir.to_str().unwrap(), &saved.to_string()],
    )
    .output()
    .unwrap());
    let by_bun = dump(&dir);
    let bun_read: Value = serde_json::from_str(&ok(script(
        &bun,
        home.path(),
        BUN_READ,
        &[dir.to_str().unwrap()],
    )
    .output()
    .unwrap()))
    .unwrap();
    let storage = TaskStorage::open(&context(home.path()), &dir).unwrap();
    let loaded = storage.load().unwrap();
    // What Rust loads is what Bun loads, key order included.
    assert_eq!(loaded.to_string(), bun_read.to_string());
    // Written back by Rust (the owner after a flip): the same rows.
    storage.save(&loaded).unwrap();
    drop(storage);
    assert_eq!(dump(&dir), by_bun);
}

#[test]
fn backward_what_rust_wrote_bun_reads_and_writes_on() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("assistant");
    let saved = state();
    let storage = TaskStorage::open(&context(home.path()), &dir).unwrap();
    storage.save(&saved).unwrap();
    let by_rust = dump(&dir);
    let loaded = storage.load().unwrap();
    drop(storage);
    let read: Value = serde_json::from_str(&ok(script(
        &bun,
        home.path(),
        BUN_READ,
        &[dir.to_str().unwrap()],
    )
    .output()
    .unwrap()))
    .unwrap();
    assert_eq!(read.to_string(), loaded.to_string());
    // Bun, the owner again after a flip back, saves what it read: the same
    // rows Rust wrote.
    ok(script(
        &bun,
        home.path(),
        BUN_WRITE,
        &[dir.to_str().unwrap(), &read.to_string()],
    )
    .output()
    .unwrap());
    assert_eq!(dump(&dir), by_rust);
}

#[test]
fn an_older_version_one_database_bun_wrote_migrates_in_rust() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("assistant");
    // A version 3 database from Bun, taken back to version 1's columns.
    let mut saved = state();
    saved["tasks"][0]["input"]
        .as_object_mut()
        .unwrap()
        .retain(|key, _| {
            !["notification_mode", "mentions", "all_workspaces"].contains(&key.as_str())
        });
    saved["tasks"][0]
        .as_object_mut()
        .unwrap()
        .shift_remove("notifications");
    for key in ["notification_mode", "mentions"] {
        saved["tasks"][0]["runs"][0]["input"]
            .as_object_mut()
            .unwrap()
            .shift_remove(key);
        saved["proposals"][0]["prepared"]["input"]
            .as_object_mut()
            .unwrap()
            .shift_remove(key);
        saved["proposals"][0]["proposal"]
            .as_object_mut()
            .unwrap()
            .shift_remove(key);
    }
    saved["tasks"][0]["runs"][0]
        .as_object_mut()
        .unwrap()
        .shift_remove("notice");
    ok(script(
        &bun,
        home.path(),
        BUN_WRITE,
        &[dir.to_str().unwrap(), &saved.to_string()],
    )
    .output()
    .unwrap());
    let db = Connection::open(dir.join("tasks.sqlite")).unwrap();
    db.execute_batch(
        "BEGIN;
         DROP TABLE run_notices;
         ALTER TABLE tasks DROP COLUMN all_workspaces;
         ALTER TABLE tasks DROP COLUMN mentions;
         ALTER TABLE tasks DROP COLUMN notifications;
         ALTER TABLE tasks DROP COLUMN notification_mode;
         PRAGMA user_version = 1;
         COMMIT;",
    )
    .unwrap();
    drop(db);
    let storage = TaskStorage::open(&context(home.path()), &dir).unwrap();
    let loaded = storage.load().unwrap();
    drop(storage);
    let read: Value = serde_json::from_str(&ok(script(
        &bun,
        home.path(),
        BUN_READ,
        &[dir.to_str().unwrap()],
    )
    .output()
    .unwrap()))
    .unwrap();
    assert_eq!(read.to_string(), loaded.to_string());
    assert!(dump(&dir).contains(&"user_version 3".to_owned()));
}

#[test]
fn coexistence_rust_reads_and_writes_while_bun_holds_the_database() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("assistant");
    let saved = state();
    let ready = home.path().join("ready");
    let release = home.path().join("release");
    let mut holder = script(
        &bun,
        home.path(),
        BUN_HOLD,
        &[
            dir.to_str().unwrap(),
            &saved.to_string(),
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
        &dir.join("tasks.sqlite"),
        5_000,
    )
    .unwrap();
    let count: i64 = readonly
        .conn
        .query_row("SELECT count(*) FROM runs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    drop(readonly);
    let storage = TaskStorage::open(&context(home.path()), &dir).unwrap();
    let mut changed = storage.load().unwrap();
    changed["tasks"][0]["task"]["status"] = json!("paused");
    storage.save(&changed).unwrap();
    drop(storage);
    std::fs::write(&release, "go").unwrap();
    let seen: Value = serde_json::from_str(&ok(holder.wait_with_output().unwrap())).unwrap();
    // Bun, still open, reads what Rust wrote meanwhile.
    assert_eq!(seen.to_string(), changed.to_string());
}
