//! task-storage.test.ts, case for case.

use std::path::Path;

use roamgate_base::paths::{DataContext, Platform, random_uuid};
use rusqlite::Connection;
use serde_json::{Value, json};

use super::*;

struct Dir {
    _temp: tempfile::TempDir,
    path: PathBuf,
    context: DataContext,
}

fn directory() -> Dir {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("assistant");
    std::fs::create_dir(&path).unwrap();
    let context = DataContext::new(temp.path(), Platform::Unix, None);
    Dir {
        _temp: temp,
        path,
        context,
    }
}

fn open(dir: &Dir) -> Result<TaskStorage> {
    TaskStorage::open(&dir.context, &dir.path)
}

fn inspect<T>(path: &Path, use_db: impl FnOnce(&Connection) -> T) -> T {
    let db = Connection::open(path.join("tasks.sqlite")).unwrap();
    use_db(&db)
}

/// `structuredClone` of a prepared task.
fn prepared() -> Value {
    let scope = json!([{"connection_id": "local", "workspace_id": "workspace"}]);
    json!({
        "input": {
            "title": "Check workspace",
            "prompt": "Report verified progress",
            "scope": scope,
            "schedule": {"type": "interval", "minutes": 1},
        },
        "config": {
            "provider": "test",
            "model": "model",
            "credential_source": "assistant",
            "allowed_workspaces": scope,
        },
        "targets": [{
            "connection_id": "local",
            "workspace_id": "workspace",
            "endpoint_fingerprint": "a".repeat(64),
            "workspace_identity": "b".repeat(64),
            "herdr_boot_id": "original-boot",
        }],
        "workspaces": [{
            "connection_id": "local",
            "workspace_id": "workspace",
            "connection_label": "Local",
            "label": "Workspace",
            "runtime_generation": 1,
        }],
    })
}

fn merge(base: Value, extra: Value) -> Value {
    let mut map = base.as_object().unwrap().clone();
    for (key, value) in extra.as_object().unwrap() {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

const DATE: &str = "2026-10-04T00:00:00.000Z";

fn state() -> Value {
    let id = random_uuid();
    let task = merge(
        prepared(),
        json!({
            "task": {
                "id": id,
                "status": "active",
                "created_at": DATE,
                "updated_at": DATE,
                "next_run_at": "2026-10-04T00:01:00.000Z",
            },
            "due_at": DATE,
            "runs": [
                merge(prepared(), json!({
                    "id": random_uuid(), "task_id": id, "status": "running",
                    "scheduled_at": DATE, "started_at": DATE, "error": null, "manual": true,
                })),
                merge(prepared(), json!({
                    "id": random_uuid(), "task_id": id, "status": "succeeded",
                    "scheduled_at": DATE, "started_at": DATE, "finished_at": DATE,
                    "error": null, "manual": false,
                })),
            ],
        }),
    );
    json!({
        "tasks": [task],
        "proposals": [{
            "prepared": prepared(),
            "proposal": merge(prepared()["input"].clone(), json!({
                "id": random_uuid(), "status": "pending", "created_at": DATE,
            })),
        }],
        "requests": [{"id": random_uuid(), "task_id": id}],
    })
}

fn empty() -> Value {
    json!({"tasks": [], "proposals": [], "requests": []})
}

/// `toEqual`: the same values, whatever the key order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

macro_rules! assert_same {
    ($a:expr, $b:expr) => {{
        let (a, b) = (&$a, &$b);
        assert!(same(a, b), "left: {a:#}\nright: {b:#}");
    }};
}

fn exec(db: &Connection, sql: &str) {
    db.execute_batch(sql).unwrap();
}

fn create_version_one(path: &Path, saved: &Value) {
    let db = Connection::open(path.join("tasks.sqlite")).unwrap();
    exec(&db, "BEGIN IMMEDIATE");
    exec(
        &db,
        "
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, position INTEGER NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          next_run_at TEXT, due_at TEXT,
          title TEXT NOT NULL, prompt TEXT NOT NULL, scope TEXT NOT NULL,
          schedule TEXT NOT NULL, config TEXT NOT NULL,
          targets TEXT NOT NULL, workspaces TEXT NOT NULL
        ) STRICT;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          position INTEGER NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL,
          started_at TEXT, finished_at TEXT, error TEXT, manual INTEGER NOT NULL,
          admission TEXT
        ) STRICT;
        CREATE INDEX runs_task ON runs(task_id, position);
        CREATE TABLE proposals (
          id TEXT PRIMARY KEY, position INTEGER NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, task_id TEXT,
          input TEXT NOT NULL, prepared TEXT NOT NULL
        ) STRICT;
        CREATE TABLE requests (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          position INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;",
    );
    for (position, entry) in saved["tasks"].as_array().unwrap().iter().enumerate() {
        let (task, input) = (&entry["task"], &entry["input"]);
        db.execute(
            "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                task["id"].as_str(),
                position as i64,
                task["status"].as_str(),
                task["created_at"].as_str(),
                task["updated_at"].as_str(),
                task["next_run_at"].as_str(),
                entry["due_at"].as_str(),
                input["title"].as_str(),
                input["prompt"].as_str(),
                js::stringify(&input["scope"]),
                js::stringify(&input["schedule"]),
                js::stringify(&entry["config"]),
                js::stringify(&entry["targets"]),
                js::stringify(&entry["workspaces"]),
            ],
        )
        .unwrap();
        for (position, run) in entry["runs"].as_array().unwrap().iter().enumerate() {
            let status = run["status"].as_str().unwrap();
            let admission = UNFINISHED.contains(&status).then(|| {
                js::stringify(&json!({
                    "input": run["input"], "config": run["config"],
                    "targets": run["targets"], "workspaces": run["workspaces"],
                }))
            });
            db.execute(
                "INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    run["id"].as_str(),
                    task["id"].as_str(),
                    position as i64,
                    status,
                    run["scheduled_at"].as_str(),
                    run.get("started_at").and_then(Value::as_str),
                    run.get("finished_at").and_then(Value::as_str),
                    run["error"].as_str(),
                    i64::from(run["manual"] == true),
                    admission,
                ],
            )
            .unwrap();
        }
    }
    for (position, entry) in saved["proposals"].as_array().unwrap().iter().enumerate() {
        let mut input = entry["proposal"].as_object().unwrap().clone();
        let id = input.shift_remove("id");
        let status = input.shift_remove("status");
        let created = input.shift_remove("created_at");
        let task_id = input.shift_remove("task_id");
        db.execute(
            "INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                id.unwrap().as_str(),
                position as i64,
                status.unwrap().as_str(),
                created.unwrap().as_str(),
                task_id.as_ref().and_then(Value::as_str),
                js::stringify(&Value::Object(input)),
                js::stringify(&entry["prepared"]),
            ],
        )
        .unwrap();
    }
    for (position, request) in saved["requests"].as_array().unwrap().iter().enumerate() {
        db.execute(
            "INSERT INTO requests VALUES (?, ?, ?)",
            params![
                request["id"].as_str(),
                request["task_id"].as_str(),
                position as i64
            ],
        )
        .unwrap();
    }
    exec(&db, "COMMIT");
}

fn notification(saved: &Value) -> Value {
    json!({
        "event_key": "agent-completed",
        "kind": "completed",
        "title": "Agent finished",
        "body": "All requested work was verified successfully.",
        "scope_key": "c".repeat(64),
        "run_id": saved["tasks"][0]["runs"][1]["id"],
        "created_at": DATE,
    })
}

fn one<T: rusqlite::types::FromSql>(db: &Connection, sql: &str) -> T {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn compact(run: &mut Value) {
    let map = run.as_object_mut().unwrap();
    for key in ["input", "config", "targets", "workspaces"] {
        map.shift_remove(key);
    }
}

#[test]
fn sqlite_round_trips_queryable_plans_and_keeps_admissions_only_for_unfinished_runs() {
    let dir = directory();
    let saved = state();
    let mut storage = open(&dir).unwrap();
    storage.save(&saved).unwrap();
    let loaded = storage.load().unwrap();
    assert_same!(loaded["tasks"][0]["task"], saved["tasks"][0]["task"]);
    assert_eq!(loaded["tasks"][0]["due_at"], saved["tasks"][0]["due_at"]);
    assert_same!(loaded["tasks"][0]["runs"][0], saved["tasks"][0]["runs"][0]);
    assert!(loaded["tasks"][0]["runs"][1].get("input").is_none());
    assert_same!(loaded["proposals"], saved["proposals"]);
    assert_same!(loaded["requests"], saved["requests"]);
    inspect(&dir.path, |db| {
        assert_eq!(one::<String>(db, "PRAGMA journal_mode"), "wal");
        assert_eq!(one::<i64>(db, "PRAGMA user_version"), 3);
        let (id, status, title): (String, String, String) = db
            .query_row("SELECT id, status, title FROM tasks", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(id, saved["tasks"][0]["task"]["id"]);
        assert_eq!(
            (status.as_str(), title.as_str()),
            ("active", "Check workspace")
        );
        let (run, task): (String, String) = db
            .query_row(
                "SELECT id, task_id FROM runs WHERE status = 'running'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(run, saved["tasks"][0]["runs"][0]["id"]);
        assert_eq!(task, saved["tasks"][0]["task"]["id"]);
        assert_eq!(
            one::<Option<String>>(db, "SELECT admission FROM runs WHERE status = 'succeeded'"),
            None
        );
    });
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
}

#[test]
fn version_one_migrates_every_table_and_retains_the_default_notification_behavior() {
    let dir = directory();
    let mut saved = state();
    saved["proposals"][0]["proposal"]["status"] = json!("confirmed");
    saved["proposals"][0]["proposal"]["task_id"] = saved["tasks"][0]["task"]["id"].clone();
    create_version_one(&dir.path, &saved);
    let mut storage = open(&dir).unwrap();
    let mut loaded = storage.load().unwrap();
    let mut expected = saved.clone();
    compact(&mut expected["tasks"][0]["runs"][1]);
    assert_same!(loaded, expected);
    assert!(loaded["tasks"][0].get("notifications").is_none());
    inspect(&dir.path, |db| {
        assert_eq!(one::<i64>(db, "PRAGMA user_version"), 3);
        let row: (Option<String>, String) = db
            .query_row(
                "SELECT notification_mode, notifications FROM tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (None, "[]".to_owned()));
    });
    loaded["tasks"][0]["input"]["notification_mode"] = json!("agent");
    loaded["tasks"][0]["notifications"] = json!([notification(&saved)]);
    storage.save(&loaded).unwrap();
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
}

#[test]
fn agent_mode_and_notification_receipts_survive_reload_and_pruning_their_source_run() {
    let dir = directory();
    let mut saved = state();
    saved["tasks"][0]["input"]["notification_mode"] = json!("agent");
    saved["tasks"][0]["runs"][0]["input"]["notification_mode"] = json!("agent");
    let notifications = json!([notification(&saved)]);
    saved["tasks"][0]["notifications"] = notifications.clone();
    saved["proposals"][0]["prepared"]["input"]["notification_mode"] = json!("agent");
    saved["proposals"][0]["proposal"]["notification_mode"] = json!("agent");
    let mut storage = open(&dir).unwrap();
    storage.save(&saved).unwrap();
    let mut loaded = storage.load().unwrap();
    assert_eq!(loaded["tasks"][0]["input"]["notification_mode"], "agent");
    assert_eq!(
        loaded["tasks"][0]["runs"][0]["input"]["notification_mode"],
        "agent"
    );
    assert_same!(loaded["tasks"][0]["notifications"], notifications);
    assert_same!(loaded["proposals"], saved["proposals"]);
    let first = loaded["tasks"][0]["runs"][0].clone();
    loaded["tasks"][0]["runs"] = json!([first]);
    storage.save(&loaded).unwrap();
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
    inspect(&dir.path, |db| {
        let row: (String, String) = db
            .query_row(
                "SELECT notification_mode, notifications FROM tasks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("agent".to_owned(), js::stringify(&notifications)));
    });
}

#[test]
fn version_two_retains_existing_plans_admissions_proposals_and_notifications_during_migration() {
    let dir = directory();
    let saved = state();
    create_version_one(&dir.path, &saved);
    let receipt = notification(&saved);
    inspect(&dir.path, |db| {
        exec(
            db,
            "ALTER TABLE tasks ADD COLUMN notification_mode TEXT;
             ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]';
             PRAGMA user_version = 2;",
        );
        db.execute(
            "UPDATE tasks SET notification_mode = ?, notifications = ?",
            params!["agent", js::stringify(&json!([receipt]))],
        )
        .unwrap();
    });
    let mut storage = open(&dir).unwrap();
    let loaded = storage.load().unwrap();
    let mut input = saved["tasks"][0]["input"].clone();
    input["notification_mode"] = json!("agent");
    assert_same!(loaded["tasks"][0]["input"], input);
    assert_same!(loaded["tasks"][0]["notifications"], json!([receipt]));
    assert_same!(loaded["tasks"][0]["runs"][0], saved["tasks"][0]["runs"][0]);
    assert_same!(loaded["proposals"], saved["proposals"]);
    assert_same!(loaded["requests"], saved["requests"]);
    inspect(&dir.path, |db| {
        assert_eq!(one::<i64>(db, "PRAGMA user_version"), 3);
        assert_eq!(
            one::<Option<String>>(db, "SELECT mentions FROM tasks"),
            None
        );
    });
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
}

#[test]
fn a_task_over_all_workspaces_and_its_run_notices_survive_reload() {
    let dir = directory();
    let mut saved = state();
    saved["tasks"][0]["input"]["all_workspaces"] = json!(true);
    saved["tasks"][0]["runs"][0]["input"]["all_workspaces"] = json!(true);
    saved["tasks"][0]["runs"][0]["notice"] =
        json!("Herdr on Local restarted since the task was saved.");
    saved["tasks"][0]["runs"][1]["notice"] =
        json!("Skipped a workspace no longer open: Local / Gone.");
    let mut storage = open(&dir).unwrap();
    storage.save(&saved).unwrap();
    let loaded = storage.load().unwrap();
    assert_eq!(loaded["tasks"][0]["input"]["all_workspaces"], true);
    assert_eq!(
        loaded["tasks"][0]["runs"][0]["notice"],
        saved["tasks"][0]["runs"][0]["notice"]
    );
    assert_eq!(
        loaded["tasks"][0]["runs"][1]["notice"],
        saved["tasks"][0]["runs"][1]["notice"]
    );
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
    // A notice goes with its run.
    inspect(&dir.path, |db| {
        assert_eq!(
            one::<i64>(db, "SELECT count(*) AS count FROM run_notices"),
            2
        );
    });
}

#[test]
fn version_three_gains_the_scope_flag_and_run_notices_in_place_and_an_older_roamgate_still_reads_and_writes_it()
 {
    let dir = directory();
    let mut saved = state();
    saved["tasks"][0]["runs"][1]["notice"] = json!("Skipped a workspace.");
    create_version_one(&dir.path, &saved);
    inspect(&dir.path, |db| {
        exec(
            db,
            "ALTER TABLE tasks ADD COLUMN notification_mode TEXT;
             ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE tasks ADD COLUMN mentions TEXT;
             PRAGMA user_version = 3;",
        )
    });
    let mut storage = open(&dir).unwrap();
    let mut loaded = storage.load().unwrap();
    // Nothing was saved for them before: the old notice is gone, nothing else.
    assert_same!(loaded["tasks"][0]["input"], saved["tasks"][0]["input"]);
    assert!(loaded["tasks"][0]["runs"][1].get("notice").is_none());
    assert_same!(loaded["tasks"][0]["runs"][0], saved["tasks"][0]["runs"][0]);
    assert_same!(loaded["proposals"], saved["proposals"]);
    assert_same!(loaded["requests"], saved["requests"]);
    loaded["tasks"][0]["input"]["all_workspaces"] = json!(true);
    loaded["tasks"][0]["runs"][1]["notice"] = json!("Skipped a workspace.");
    storage.save(&loaded).unwrap();
    storage.close();
    inspect(&dir.path, |db| {
        // An older Roamgate accepts versions 1 to 3 only.
        assert_eq!(one::<i64>(db, "PRAGMA user_version"), 3);
        assert_eq!(
            one::<String>(db, "SELECT title FROM tasks"),
            "Check workspace"
        );
        assert_eq!(one::<i64>(db, "SELECT all_workspaces FROM tasks"), 1);
        // Its saves: tasks by column name, runs by position.
        exec(
            db,
            "BEGIN IMMEDIATE;
             CREATE TEMP TABLE old_tasks AS SELECT * FROM tasks;
             CREATE TEMP TABLE old_runs AS SELECT * FROM runs ORDER BY position;
             DELETE FROM requests; DELETE FROM runs; DELETE FROM tasks; DELETE FROM proposals;
             INSERT INTO tasks (
               id, position, status, created_at, updated_at, next_run_at, due_at,
               title, prompt, scope, schedule, config, targets, workspaces,
               notification_mode, notifications, mentions
             ) SELECT id, position, status, created_at, updated_at, next_run_at, due_at,
               title, prompt, scope, schedule, config, targets, workspaces,
               notification_mode, notifications, mentions FROM old_tasks;
             INSERT INTO runs SELECT * FROM old_runs;
             COMMIT;",
        );
    });
    // Back on this version: the flag the older one did not save is gone, the
    // run keeps its notice, and nothing else changed.
    let reloaded = open(&dir).unwrap().load().unwrap();
    assert!(
        reloaded["tasks"][0]["input"]
            .get("all_workspaces")
            .is_none()
    );
    assert_eq!(
        reloaded["tasks"][0]["runs"][1]["notice"],
        "Skipped a workspace."
    );
    assert_same!(
        reloaded["tasks"][0]["runs"][0],
        loaded["tasks"][0]["runs"][0]
    );
}

#[test]
fn mention_bindings_round_trip_tasks_proposals_and_admitted_runs_without_keeping_completed_admissions()
 {
    let dir = directory();
    let mut saved = state();
    let mentions = json!([{
        "kind": "agent",
        "connection_id": "local",
        "workspace_id": "workspace",
        "connection_label": "Local",
        "workspace_label": "Workspace",
        "label": "Codex session",
        "runtime_generation": 1,
        "pane_id": "pane",
        "terminal_id": "terminal",
        "agent": "codex",
        "agent_identity": "c".repeat(64),
    }]);
    saved["tasks"][0]["input"]["mentions"] = mentions.clone();
    saved["tasks"][0]["runs"][0]["input"]["mentions"] = mentions.clone();
    saved["tasks"][0]["runs"][1]["input"]["mentions"] = mentions.clone();
    saved["proposals"][0]["prepared"]["input"]["mentions"] = mentions.clone();
    saved["proposals"][0]["proposal"]["mentions"] = mentions.clone();
    let mut storage = open(&dir).unwrap();
    storage.save(&saved).unwrap();
    let loaded = storage.load().unwrap();
    assert_same!(loaded["tasks"][0]["input"]["mentions"], mentions);
    assert_same!(loaded["tasks"][0]["runs"][0]["input"]["mentions"], mentions);
    assert!(loaded["tasks"][0]["runs"][1].get("input").is_none());
    assert_same!(loaded["proposals"], saved["proposals"]);
    inspect(&dir.path, |db| {
        assert_eq!(
            one::<String>(db, "SELECT mentions FROM tasks"),
            js::stringify(&mentions)
        );
    });
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), loaded);
}

#[test]
fn default_notification_mode_retains_its_original_optional_shape() {
    for mode in [None, Some("status")] {
        let dir = directory();
        let mut saved = state();
        if let Some(mode) = mode {
            saved["tasks"][0]["input"]["notification_mode"] = json!(mode);
        }
        let storage = open(&dir).unwrap();
        storage.save(&saved).unwrap();
        assert_same!(
            storage.load().unwrap()["tasks"][0]["input"],
            saved["tasks"][0]["input"]
        );
        assert!(
            storage.load().unwrap()["tasks"][0]
                .get("notifications")
                .is_none()
        );
        inspect(&dir.path, |db| {
            assert_eq!(
                one::<Option<String>>(db, "SELECT notification_mode FROM tasks").as_deref(),
                mode
            );
        });
    }
}

type Rows = Vec<Vec<rusqlite::types::Value>>;

fn rows(db: &Connection, sql: &str) -> Rows {
    let mut statement = db.prepare(sql).unwrap();
    let count = statement.column_count();
    statement
        .query_map([], |row| (0..count).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_version_one_failure_rolls_back_the_entire_migration() {
    for damage in ["duplicate-column", "invalid-row", "missing-table"] {
        let dir = directory();
        create_version_one(&dir.path, &state());
        inspect(&dir.path, |db| {
            exec(
                db,
                match damage {
                    "duplicate-column" => {
                        "ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]'"
                    }
                    "missing-table" => "DROP TABLE requests",
                    _ => "UPDATE runs SET admission = NULL WHERE status = 'running'",
                },
            )
        });
        let snapshot = |db: &Connection| {
            [
                "PRAGMA table_info(tasks)",
                "SELECT * FROM tasks",
                "SELECT * FROM runs",
                "SELECT * FROM proposals",
            ]
            .map(|sql| rows(db, sql))
        };
        let original = inspect(&dir.path, snapshot);
        assert!(open(&dir).is_err(), "{damage}");
        inspect(&dir.path, |db| {
            assert_eq!(one::<i64>(db, "PRAGMA user_version"), 1);
            assert_eq!(snapshot(db), original, "{damage}");
        });
    }
}

#[test]
fn a_separate_sqlite_process_can_read_while_the_writer_saves() {
    let dir = directory();
    let storage = open(&dir).unwrap();
    let mut saved = state();
    storage.save(&saved).unwrap();
    let file = dir.path.join("tasks.sqlite");
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut reads = 0;
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let db =
                    Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                        .unwrap();
                db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                db.execute_batch("BEGIN").unwrap();
                let tasks = rows(&db, "SELECT id, status FROM tasks");
                let runs = rows(&db, "SELECT task_id FROM runs");
                db.execute_batch("COMMIT").unwrap();
                assert_eq!(tasks.len(), 1, "inconsistent task receipt");
                assert_eq!(runs.len(), 2, "inconsistent task receipt");
                assert!(runs.iter().all(|run| run[0] == tasks[0][0]));
                reads += 1;
            }
            reads
        })
    };
    for index in 0..200 {
        saved["tasks"][0]["task"]["status"] =
            json!(if index % 2 == 1 { "active" } else { "paused" });
        storage.save(&saved).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(reader.join().unwrap() > 0);
}

#[test]
fn deleting_every_plan_preserves_an_authoritative_initialized_empty_database() {
    let dir = directory();
    let mut storage = open(&dir).unwrap();
    storage.save(&state()).unwrap();
    storage.save(&empty()).unwrap();
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), empty());
    inspect(&dir.path, |db| {
        assert_eq!(one::<i64>(db, "PRAGMA user_version"), 3)
    });
}

#[test]
fn sqlite_data_fails_closed_without_clearing_the_database() {
    for damage in [
        "corrupt",
        "uninitialized",
        "future-version",
        "invalid-row",
        "missing-table",
        "notification-mode",
        "notification-json",
        "notification-receipt",
        "mention-json",
        "mention-identity",
    ] {
        let dir = directory();
        let file = dir.path.join("tasks.sqlite");
        match damage {
            "corrupt" => std::fs::write(&file, "not sqlite").unwrap(),
            "uninitialized" => std::fs::write(&file, "").unwrap(),
            _ => {
                let mut storage = open(&dir).unwrap();
                storage.save(&state()).unwrap();
                storage.close();
                inspect(&dir.path, |db| {
                    exec(
                        db,
                        match damage {
                            "future-version" => "PRAGMA user_version = 4",
                            "missing-table" => "DROP TABLE requests",
                            "notification-mode" => "UPDATE tasks SET notification_mode = 'invalid'",
                            "notification-json" => "UPDATE tasks SET notifications = 'not JSON'",
                            "notification-receipt" => "UPDATE tasks SET notifications = '[{}]'",
                            "mention-json" => "UPDATE tasks SET mentions = 'not JSON'",
                            "mention-identity" => "UPDATE tasks SET mentions = '[{}]'",
                            _ => "UPDATE runs SET admission = NULL WHERE status = 'running'",
                        },
                    )
                });
            }
        }
        let prior = std::fs::read(&file).unwrap();
        assert!(open(&dir).is_err(), "{damage}");
        assert_eq!(std::fs::read(&file).unwrap(), prior, "{damage}");
    }
}

#[test]
fn invalid_permissions_and_duplicate_run_identifiers_cannot_overwrite_saved_tasks() {
    for defect in ["target", "duplicate-run"] {
        let dir = directory();
        let storage = open(&dir).unwrap();
        storage.save(&state()).unwrap();
        let original = storage.load().unwrap();
        let mut changed = original.clone();
        if defect == "target" {
            changed["tasks"][0]["targets"][0]["workspace_identity"] = json!("replaced");
        } else {
            changed["tasks"][0]["runs"][1]["id"] = changed["tasks"][0]["runs"][0]["id"].clone();
        }
        assert!(storage.save(&changed).is_err(), "{defect}");
        assert_same!(storage.load().unwrap(), original);
    }
}

#[test]
fn invalid_notification_cannot_overwrite_saved_tasks() {
    for defect in ["mode", "receipt", "duplicate", "overflow"] {
        let dir = directory();
        let mut saved = state();
        saved["tasks"][0]["input"]["notification_mode"] = json!("agent");
        saved["tasks"][0]["notifications"] = json!([notification(&saved)]);
        let storage = open(&dir).unwrap();
        storage.save(&saved).unwrap();
        let original = storage.load().unwrap();
        let mut changed = original.clone();
        match defect {
            "mode" => changed["tasks"][0]["input"]["notification_mode"] = json!("invalid"),
            "receipt" => changed["tasks"][0]["notifications"][0]["run_id"] = json!("invalid"),
            "duplicate" => changed["tasks"][0]["notifications"]
                .as_array_mut()
                .unwrap()
                .push(notification(&saved)),
            _ => {
                changed["tasks"][0]["notifications"] = Value::Array(
                    (0..101)
                        .map(|index| {
                            let mut item = notification(&saved);
                            item["event_key"] = json!(format!("completed-{index}"));
                            item
                        })
                        .collect(),
                )
            }
        }
        assert!(storage.save(&changed).is_err(), "{defect}");
        assert_same!(storage.load().unwrap(), original);
    }
}

#[test]
fn notification_bytes_are_bounded_before_materializing_their_json() {
    let dir = directory();
    let mut storage = open(&dir).unwrap();
    storage.save(&state()).unwrap();
    storage.close();
    inspect(&dir.path, |db| {
        exec(
            db,
            "UPDATE tasks SET notifications = printf('%33000000s', '')",
        )
    });
    let error = open(&dir).err().unwrap();
    assert_eq!(error.to_string(), "Saved Ranger tasks are too large");
}

#[test]
fn a_failure_after_deleting_old_rows_rolls_back_every_table_and_can_be_retried() {
    let dir = directory();
    let mut storage = open(&dir).unwrap();
    storage.save(&state()).unwrap();
    let previous = storage.load().unwrap();
    let mut changed = previous.clone();
    changed["tasks"][0]["task"]["status"] = json!("paused");
    changed["tasks"][0]["input"]["notification_mode"] = json!("agent");
    changed["tasks"][0]["notifications"] = json!([notification(&previous)]);
    changed["proposals"][0]["proposal"]["status"] = json!("cancelled");
    changed["requests"] = json!([]);
    inspect(&dir.path, |db| {
        exec(
            db,
            "CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
        )
    });
    let error = storage.save(&changed).unwrap_err();
    assert!(error.to_string().contains("disk failure"), "{error}");
    assert_same!(storage.load().unwrap(), previous);
    inspect(&dir.path, |db| exec(db, "DROP TRIGGER fail_run"));
    storage.save(&changed).unwrap();
    storage.close();
    assert_same!(open(&dir).unwrap().load().unwrap(), changed);
}

#[test]
fn directory_database_and_wal_files_are_private_and_dispose_closes_the_handle() {
    let dir = directory();
    roamgate_base::private::set_mode(&dir.path, 0o755).unwrap();
    let mut storage = open(&dir).unwrap();
    storage.save(&state()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["tasks.sqlite-wal", "tasks.sqlite-shm"] {
            roamgate_base::private::set_mode(&dir.path.join(file), 0o644).unwrap();
        }
        storage.save(&storage.load().unwrap()).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.path), 0o700);
        for file in ["tasks.sqlite", "tasks.sqlite-wal", "tasks.sqlite-shm"] {
            assert_eq!(mode(&dir.path.join(file)), 0o600, "{file}");
        }
    }
    storage.close();
    storage.close();
    assert!(storage.load().is_err());
    assert!(storage.save(&empty()).is_err());
    assert_eq!(
        open(&dir).unwrap().load().unwrap()["tasks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[cfg(unix)]
#[test]
fn indirection_is_rejected_without_changing_the_target_file() {
    use std::os::unix::fs::PermissionsExt;
    for target in [
        "database",
        "wal",
        "shm",
        "journal",
        "hardlink",
        "sidecar-hardlink",
    ] {
        let dir = directory();
        let outside = dir.path.join("outside");
        let contents = js::stringify(&state());
        std::fs::write(&outside, &contents).unwrap();
        roamgate_base::private::set_mode(&outside, 0o644).unwrap();
        let linked = dir.path.join(match target {
            "sidecar-hardlink" => "tasks.sqlite-shm".to_owned(),
            "wal" | "shm" | "journal" => format!("tasks.sqlite-{target}"),
            _ => "tasks.sqlite".to_owned(),
        });
        if target.ends_with("hardlink") {
            std::fs::hard_link(&outside, &linked).unwrap();
        } else {
            std::os::unix::fs::symlink(&outside, &linked).unwrap();
        }
        assert!(open(&dir).is_err(), "{target}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), contents);
        assert_eq!(
            std::fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}
