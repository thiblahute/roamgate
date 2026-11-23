//! reviews.sqlite (review/storage.ts): review sessions and their threads,
//! one row each with the record as JSON, written through on every change.
//!
//! The same file, schema and rules as the Bun server's: `<data>/reviews`
//! (or `ROAMGATE_REVIEW_DIR`), 0700, the database and its side files 0600
//! and never followed through a link, WAL with `synchronous = FULL`,
//! foreign keys on, schema version 1 (any other refused). Whichever server
//! owns the review family writes it; the other may read it (WAL), and the
//! next owner opens what the last one left.

use std::path::{Path, PathBuf};

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::DataContext;
use roamgate_base::sqlite::{SqliteDb, SqliteError, SqliteSpec, Synchronous, VersionRule};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::model::{ReviewSession, ReviewThread};

pub const SCHEMA_VERSION: i64 = 1;

/// The schema, as review/storage.ts creates it.
pub const SCHEMA: &str = "
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL,
    updated_at TEXT NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, data TEXT NOT NULL
  ) STRICT;
  CREATE INDEX threads_session ON threads(session_id, created_at);
";

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Open(#[from] SqliteError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Review thread id belongs to another review")]
    ThreadOfAnotherReview,
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

/// The open database.
pub struct ReviewStorage {
    db: SqliteDb,
}

impl std::fmt::Debug for ReviewStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReviewStorage")
            .field("path", &self.db.path())
            .finish()
    }
}

/// `<data>/reviews`, or `ROAMGATE_REVIEW_DIR`.
pub fn review_directory(env: &dyn Env) -> PathBuf {
    match roamgate_env(env, "REVIEW_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => DataContext::from_env(env).data_root().join("reviews"),
    }
}

fn spec() -> SqliteSpec<'static> {
    SqliteSpec {
        name: "review",
        busy_timeout_ms: 5_000,
        foreign_keys: true,
        synchronous: Synchronous::Full,
        incremental_vacuum: false,
        schema: SCHEMA,
        user_version: SCHEMA_VERSION,
        versions: VersionRule::Exact,
    }
}

/// Rows parsed; a row this version cannot read is skipped rather than
/// failing every other review.
fn parse_rows<T: DeserializeOwned>(rows: Vec<String>) -> Vec<T> {
    rows.into_iter()
        .filter_map(|data| serde_json::from_str(&data).ok())
        .collect()
}

impl ReviewStorage {
    /// Opens (or creates) `directory/reviews.sqlite`.
    pub fn open(context: &DataContext, directory: &Path) -> Result<Self, StorageError> {
        let path = directory.join("reviews.sqlite");
        let db = SqliteDb::open(context, &path, spec())?;
        Ok(Self { db })
    }

    /// A consistent copy of `directory/reviews.sqlite` at `into` (a file
    /// not there yet), read without writing: what a server that does not
    /// own the reviews answers a shadow read from. Nothing to copy when
    /// there is no database yet.
    pub fn copy(directory: &Path, into: &Path) -> Result<bool, StorageError> {
        let source = directory.join("reviews.sqlite");
        if !source.exists() {
            return Ok(false);
        }
        let db = rusqlite::Connection::open_with_flags(
            &source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(std::time::Duration::from_millis(5_000))?;
        db.execute("VACUUM INTO ?1", params![into.to_string_lossy()])?;
        Ok(true)
    }

    pub fn path(&self) -> &Path {
        self.db.path()
    }

    fn rows(&self, sql: &str, param: Option<&str>) -> Result<Vec<String>, StorageError> {
        let mut statement = self.db.conn.prepare_cached(sql)?;
        let rows = match param {
            Some(value) => statement
                .query_map(params![value], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
            None => statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        };
        Ok(rows)
    }

    /// Every session's record, oldest update first.
    pub fn load_session_values(&self) -> Result<Vec<Value>, StorageError> {
        Ok(parse_rows(self.rows(
            "SELECT data FROM sessions ORDER BY updated_at",
            None,
        )?))
    }

    /// A session's threads, oldest first: only those whose record names it.
    pub fn load_thread_values(&self, session_id: &str) -> Result<Vec<Value>, StorageError> {
        let rows: Vec<Value> = parse_rows(self.rows(
            "SELECT data FROM threads WHERE session_id = ? ORDER BY created_at, id",
            Some(session_id),
        )?);
        Ok(rows
            .into_iter()
            .filter(|row| row.get("sessionId").and_then(Value::as_str) == Some(session_id))
            .collect())
    }

    /// The sessions this build can read.
    pub fn load_sessions(&self) -> Result<Vec<ReviewSession>, StorageError> {
        Ok(self
            .load_session_values()?
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect())
    }

    /// A session's threads this build can read.
    pub fn load_threads(&self, session_id: &str) -> Result<Vec<ReviewThread>, StorageError> {
        Ok(self
            .load_thread_values(session_id)?
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect())
    }

    /// Writes a session's record (`id`, `connectionId`, `updatedAt` read
    /// from it).
    pub fn save_session_value(&self, session: &Value) -> Result<(), StorageError> {
        let text = |name: &str| session.get(name).and_then(Value::as_str).unwrap_or("");
        self.db
            .conn
            .prepare_cached(
                "INSERT INTO sessions (id, connection_id, updated_at, data)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id,
               updated_at = excluded.updated_at, data = excluded.data",
            )?
            .execute(params![
                text("id"),
                text("connectionId"),
                text("updatedAt"),
                serde_json::to_string(session)?
            ])?;
        Ok(())
    }

    /// Writes a thread's record; refused when its id is another review's
    /// thread (never written over).
    pub fn save_thread_value(&self, thread: &Value) -> Result<(), StorageError> {
        let text = |name: &str| thread.get(name).and_then(Value::as_str).unwrap_or("");
        let changes = self
            .db
            .conn
            .prepare_cached(
                "INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET data = excluded.data
                   WHERE threads.session_id = excluded.session_id",
            )?
            .execute(params![
                text("id"),
                text("sessionId"),
                text("createdAt"),
                serde_json::to_string(thread)?
            ])?;
        if changes == 0 {
            return Err(StorageError::ThreadOfAnotherReview);
        }
        Ok(())
    }

    pub fn save_session(&self, session: &ReviewSession) -> Result<(), StorageError> {
        self.save_session_value(&to_value(session)?)
    }

    pub fn save_thread(&self, thread: &ReviewThread) -> Result<(), StorageError> {
        self.save_thread_value(&to_value(thread)?)
    }

    pub fn delete_thread(&self, id: &str) -> Result<(), StorageError> {
        self.db
            .conn
            .prepare_cached("DELETE FROM threads WHERE id = ?")?
            .execute(params![id])?;
        Ok(())
    }

    /// Deletes a session and (by its foreign key) its threads.
    pub fn delete_session(&self, id: &str) -> Result<(), StorageError> {
        self.db
            .conn
            .prepare_cached("DELETE FROM sessions WHERE id = ?")?
            .execute(params![id])?;
        Ok(())
    }

    /// A session's record as stored, for tests and the data checks.
    pub fn session_value(&self, id: &str) -> Result<Option<Value>, StorageError> {
        let data: Option<String> = self
            .db
            .conn
            .query_row(
                "SELECT data FROM sessions WHERE id = ?",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(data.and_then(|data| serde_json::from_str(&data).ok()))
    }
}

fn to_value<T: Serialize>(record: &T) -> Result<Value, StorageError> {
    Ok(serde_json::to_value(record)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::paths::Platform;
    use serde_json::json;

    fn context(dir: &Path) -> DataContext {
        DataContext::new(dir, Platform::Unix, None)
    }

    fn open(dir: &Path) -> ReviewStorage {
        ReviewStorage::open(&context(dir), &dir.join("reviews")).unwrap()
    }

    /// Runs SQL on the database file directly, as an older version left it.
    fn raw(dir: &Path, run: impl FnOnce(&rusqlite::Connection)) {
        let db = rusqlite::Connection::open(dir.join("reviews/reviews.sqlite")).unwrap();
        run(&db);
    }

    fn session(id: &str, updated_at: &str) -> Value {
        json!({
            "id": id, "connectionId": "local", "root": "/repo", "title": id,
            "target": {"kind": "worktree"}, "summary": "", "agent": {},
            "createdAt": updated_at, "updatedAt": updated_at,
        })
    }

    fn thread(id: &str, session_id: &str, text: &str) -> Value {
        json!({
            "id": id, "sessionId": session_id, "kind": "discussion",
            "anchor": {"kind": "review"},
            "comments": [{"id": format!("{id}c"), "author": "you", "text": text}],
            "resolved": false,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        })
    }

    const AT: &str = "2026-01-01T00:00:00.000Z";

    #[test]
    fn sessions_and_threads_come_back_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        storage.save_session_value(&session("s1", AT)).unwrap();
        storage
            .save_session_value(&session("s2", "2026-01-02T00:00:00.000Z"))
            .unwrap();
        storage
            .save_thread_value(&thread("t1", "s1", "hello"))
            .unwrap();
        let mut edited = thread("t1", "s1", "hello");
        edited["comments"][0]["text"] = json!("edited");
        storage.save_thread_value(&edited).unwrap();
        drop(storage);
        let reopened = open(dir.path());
        let ids: Vec<_> = reopened
            .load_session_values()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("s1"), json!("s2")]);
        assert_eq!(reopened.load_thread_values("s1").unwrap(), vec![edited]);
        assert!(reopened.load_thread_values("s2").unwrap().is_empty());
        // Private files.
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.path().join("reviews")), 0o700);
        assert_eq!(mode(dir.path().join("reviews/reviews.sqlite")), 0o600);
    }

    #[test]
    fn a_copy_is_read_while_the_owner_keeps_its_file_open() {
        let dir = tempfile::tempdir().unwrap();
        let owner = open(dir.path());
        owner.save_session_value(&session("s1", AT)).unwrap();
        owner.save_thread_value(&thread("t1", "s1", "a")).unwrap();
        let copy = dir.path().join("copy");
        std::fs::create_dir_all(&copy).unwrap();
        assert!(
            ReviewStorage::copy(&dir.path().join("reviews"), &copy.join("reviews.sqlite")).unwrap()
        );
        // The owner writes on; the copy is what was.
        owner.save_session_value(&session("s2", AT)).unwrap();
        let read = ReviewStorage::open(&context(dir.path()), &copy).unwrap();
        assert_eq!(read.load_session_values().unwrap().len(), 1);
        assert_eq!(read.load_thread_values("s1").unwrap().len(), 1);
        assert!(
            !ReviewStorage::copy(&dir.path().join("none"), &copy.join("other.sqlite")).unwrap()
        );
    }

    #[test]
    fn deleting_a_session_deletes_its_threads() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        storage.save_session_value(&session("s1", AT)).unwrap();
        storage.save_thread_value(&thread("t1", "s1", "a")).unwrap();
        storage.save_thread_value(&thread("t2", "s1", "b")).unwrap();
        storage.delete_thread("t2").unwrap();
        storage.delete_session("s1").unwrap();
        drop(storage);
        let reopened = open(dir.path());
        assert!(reopened.load_session_values().unwrap().is_empty());
        assert!(reopened.load_thread_values("s1").unwrap().is_empty());
        let mut count = 0;
        raw(dir.path(), |db| {
            count = db
                .query_row("SELECT count(*) FROM threads", [], |row| row.get(0))
                .unwrap();
        });
        assert_eq!(count, 0);
    }

    #[test]
    fn a_thread_id_of_another_review_is_refused_and_that_thread_kept() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        storage.save_session_value(&session("s1", AT)).unwrap();
        storage.save_session_value(&session("s2", AT)).unwrap();
        storage
            .save_thread_value(&thread("t1", "s1", "mine"))
            .unwrap();
        let error = storage
            .save_thread_value(&thread("t1", "s2", "taken over"))
            .unwrap_err();
        assert!(error.to_string().contains("belongs to another review"));
        drop(storage);
        let reopened = open(dir.path());
        assert_eq!(
            reopened.load_thread_values("s1").unwrap(),
            vec![thread("t1", "s1", "mine")]
        );
        assert!(reopened.load_thread_values("s2").unwrap().is_empty());
    }

    #[test]
    fn a_reviews_threads_are_only_those_that_name_it() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        storage.save_session_value(&session("s1", AT)).unwrap();
        storage.save_session_value(&session("s2", AT)).unwrap();
        storage
            .save_thread_value(&thread("t1", "s1", "hello"))
            .unwrap();
        drop(storage);
        raw(dir.path(), |db| {
            db.execute(
                "INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)",
                params![
                    "t2",
                    "s1",
                    "2026-01-02",
                    thread("t2", "s2", "x").to_string()
                ],
            )
            .unwrap();
        });
        let reopened = open(dir.path());
        let ids: Vec<_> = reopened
            .load_thread_values("s1")
            .unwrap()
            .iter()
            .map(|t| t["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("t1")]);
    }

    #[test]
    fn a_row_that_does_not_parse_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        storage.save_session_value(&session("s1", AT)).unwrap();
        storage
            .save_thread_value(&thread("t1", "s1", "hello"))
            .unwrap();
        drop(storage);
        raw(dir.path(), |db| {
            db.execute(
                "INSERT INTO threads (id, session_id, created_at, data) VALUES (?, ?, ?, ?)",
                params!["t2", "s1", "2026-01-02", "{not json"],
            )
            .unwrap();
            db.execute(
                "INSERT INTO sessions (id, connection_id, updated_at, data) VALUES (?, ?, ?, ?)",
                params!["s2", "local", "2026-01-02", "{not json"],
            )
            .unwrap();
        });
        let reopened = open(dir.path());
        assert_eq!(reopened.load_session_values().unwrap().len(), 1);
        assert_eq!(reopened.load_thread_values("s1").unwrap().len(), 1);
    }

    #[test]
    fn a_database_from_an_unknown_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        drop(open(dir.path()));
        raw(dir.path(), |db| {
            db.execute_batch("PRAGMA user_version = 99").unwrap();
        });
        let error =
            ReviewStorage::open(&context(dir.path()), &dir.path().join("reviews")).unwrap_err();
        assert_eq!(error.to_string(), "Unsupported review database");
    }

    #[test]
    fn typed_records_round_trip_through_the_rows() {
        let dir = tempfile::tempdir().unwrap();
        let storage = open(dir.path());
        let stored = json!({
            "id": "0123456789abcdef", "connectionId": "local", "workspaceId": "w1",
            "root": "/repo", "title": "t", "target": {"kind": "range", "base": "main", "head": "HEAD"},
            "automaticBase": true, "gitlab": false, "autoSend": true, "summary": "",
            "agent": {"name": "claude", "paneId": "w1:p1"},
            "createdAt": AT, "updatedAt": AT, "reviewed": {"all:a.txt": "f00"},
            "somethingNewer": [1, 2]
        });
        storage.save_session_value(&stored).unwrap();
        let sessions = storage.load_sessions().unwrap();
        storage.save_session(&sessions[0]).unwrap();
        assert_eq!(
            storage.session_value("0123456789abcdef").unwrap().unwrap(),
            stored
        );
    }
}
