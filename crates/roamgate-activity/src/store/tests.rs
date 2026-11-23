//! server/src/activity/store.test.ts, case for case.

use super::*;
use roamgate_base::paths::Platform;
use std::os::unix::fs::PermissionsExt;

use crate::protocol::parse_time;
use crate::reader::{ActivityReader, WorkspacesQuery};

fn directory() -> (tempfile::TempDir, DataContext, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let context = DataContext::new(dir.path(), Platform::Unix, None);
    let path = dir.path().join("roamgate");
    (dir, context, path)
}

fn agent_event(ts: i64) -> NewEvent {
    NewEvent {
        ts,
        kind: "agent.state",
        connection_id: "local".into(),
        session: 1,
        agent: Some(AgentFields {
            name: "claude".into(),
            state: "working",
            task: None,
            session_id: None,
        }),
        ..Default::default()
    }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn the_log_is_a_private_wal_database_with_incremental_vacuum() {
    let (_dir, context, path) = directory();
    let store = ActivityStore::open(&context, &path).unwrap();
    store.append(&agent_event(1)).unwrap();
    let file = path.join("activity.sqlite");
    assert_eq!(mode(&path), 0o700);
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&path.join("activity.sqlite-wal")), 0o600);
    let db =
        Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let journal: String = db
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal");
    let vacuum: i64 = db
        .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
        .unwrap();
    assert_eq!(vacuum, 2);
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let mut statement = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap();
    let tables: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        tables,
        [
            "connection_gaps",
            "events",
            "recorder_sessions",
            "workspaces"
        ]
    );
}

#[test]
fn a_database_from_a_newer_roamgate_is_refused() {
    let (_dir, context, path) = directory();
    drop(ActivityStore::open(&context, &path).unwrap());
    let db = Connection::open(path.join("activity.sqlite")).unwrap();
    db.execute_batch("PRAGMA user_version = 99").unwrap();
    drop(db);
    let error = ActivityStore::open(&context, &path).err().unwrap();
    assert_eq!(error.to_string(), "Unsupported activity database");
}

#[test]
fn a_symlinked_log_is_refused() {
    let (_dir, context, path) = directory();
    std::fs::create_dir_all(&path).unwrap();
    let target = path.join("elsewhere");
    std::fs::write(&target, "").unwrap();
    std::os::unix::fs::symlink(&target, path.join("activity.sqlite")).unwrap();
    let error = ActivityStore::open(&context, &path).err().unwrap();
    assert!(error.to_string().contains("symlink"), "{error}");
}

#[test]
fn event_ids_keep_their_order_across_reopening_and_deletion() {
    let (_dir, context, path) = directory();
    let store = ActivityStore::open(&context, &path).unwrap();
    let first = store.append(&agent_event(1000)).unwrap();
    store.append(&agent_event(2000)).unwrap();
    store.purge(5000).unwrap();
    drop(store);
    let reopened = ActivityStore::open(&context, &path).unwrap();
    let next = reopened.append(&agent_event(6000)).unwrap();
    assert!(next > first + 1);
    let events = reopened.read_events(None, None).unwrap();
    assert_eq!(events[0]["id"], event_id(next));
    assert!(event_id(9) < event_id(10));
}

#[test]
fn a_vacuum_returns_the_space_retention_freed() {
    let (_dir, context, path) = directory();
    let store = ActivityStore::open(&context, &path).unwrap();
    let task = "x".repeat(2000);
    for index in 0..2000 {
        let mut event = agent_event(index);
        event.agent.as_mut().unwrap().task = Some(task.clone());
        store.append(&event).unwrap();
    }
    store.purge(9_007_199_254_740_991).unwrap();
    let free = || -> i64 {
        let db = Connection::open_with_flags(
            path.join("activity.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        db.query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .unwrap()
    };
    assert!(free() > 256);
    store.vacuum().unwrap();
    assert!(free() < 256);
}

#[test]
fn times_read_back_in_local_time_with_their_offset() {
    let ms = parse_time("2026-11-02T09:00:00.250Z").unwrap();
    let text = iso_time(ms);
    let shape = regex::Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.250[+-]\d\d:\d\d$").unwrap();
    assert!(shape.is_match(&text), "{text}");
    assert_eq!(parse_time(&text), Some(ms));
}

#[test]
fn a_log_from_before_the_git_columns_gains_them_and_readers_cope() {
    let (_dir, context, path) = directory();
    let store = ActivityStore::open(&context, &path).unwrap();
    let row = |repo_root: Option<&str>, worktree: Option<bool>, seen_at| WorkspaceRow {
        id: "ws".into(),
        connection_id: "local".into(),
        name: "w".into(),
        path: Some("/w".into()),
        herdr_workspace_id: Some("w1".into()),
        repo_root: repo_root.map(str::to_owned),
        repo_is_worktree: worktree,
        seen_at,
    };
    store
        .upsert_workspace(&row(Some("/w"), Some(false), 1))
        .unwrap();
    drop(store);
    // As version 1 shipped: no branch nor remote columns.
    let db = Connection::open(path.join("activity.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE workspaces DROP COLUMN repo_branch; ALTER TABLE workspaces DROP COLUMN repo_remote_url")
        .unwrap();
    drop(db);
    let reader = ActivityReader::open(&context, &path, Box::new(|| 0), None)
        .unwrap()
        .unwrap();
    assert!(
        reader
            .workspaces(&WorkspacesQuery::default())
            .unwrap()
            .is_empty()
    );
    drop(reader);
    let again = ActivityStore::open(&context, &path).unwrap();
    again
        .set_repo(
            "ws",
            Some(&RepoInfo {
                root: Some("/r".into()),
                branch: Some("main".into()),
                remote_url: Some("https://example.com/r.git".into()),
                is_worktree: true,
            }),
        )
        .unwrap();
    assert_eq!(
        again.read_workspaces().unwrap()[0]["repo"],
        json!({"root": "/r", "remote_url": "https://example.com/r.git", "branch": "main", "is_worktree": true})
    );
    // Herdr's listing without a root keeps git's.
    again.upsert_workspace(&row(None, None, 2)).unwrap();
    assert_eq!(again.read_workspaces().unwrap()[0]["repo"]["root"], "/r");
    // git that cannot tell the root keeps the one known.
    again
        .set_repo(
            "ws",
            Some(&RepoInfo {
                root: None,
                branch: Some("b".into()),
                remote_url: None,
                is_worktree: true,
            }),
        )
        .unwrap();
    let repo = &again.read_workspaces().unwrap()[0]["repo"];
    assert_eq!(
        (repo["root"].as_str(), repo["branch"].as_str()),
        (Some("/r"), Some("b"))
    );
}
