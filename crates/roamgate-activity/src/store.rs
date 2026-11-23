//! The activity log, `<data>/activity.sqlite` (server/src/activity/
//! store.ts): coarse, timestamped attention and agent-state events per
//! connection, the workspaces they refer to, recorder sessions and the
//! periods nothing was recorded. Times are epoch milliseconds; `seq` orders
//! the log. No terminal contents are stored.
//!
//! The schema, its version (1), the columns added after it shipped and
//! every statement are the Bun server's, so either side opens what the
//! other wrote; only the owner of the activity family opens it for writing.

use std::path::{Path, PathBuf};

use roamgate_base::paths::DataContext;
use roamgate_base::sqlite::{SqliteDb, SqliteError, SqliteSpec, Synchronous, VersionRule};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value, json};

use crate::protocol::{event_id, iso_time};
use crate::repo_info::RepoInfo;

pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
  CREATE TABLE recorder_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL, last_alive INTEGER NOT NULL,
    stopped_at INTEGER, clean_stop INTEGER
  ) STRICT;
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, name TEXT NOT NULL,
    path TEXT, herdr_workspace_id TEXT,
    repo_root TEXT, repo_is_worktree INTEGER,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('workspace.focus', 'workspace.blur', 'agent.state', 'session.idle', 'session.active', 'ui.visibility')),
    connection_id TEXT NOT NULL,
    workspace_id TEXT, tab_id TEXT, pane_id TEXT,
    agent_name TEXT, agent_state TEXT, agent_task TEXT, agent_session_id TEXT,
    visible INTEGER, idle_after_seconds INTEGER, reason TEXT,
    client_id TEXT, client_kind TEXT, source TEXT,
    span INTEGER,
    session INTEGER NOT NULL,
    cause TEXT, input_age_ms INTEGER
  ) STRICT;
  CREATE INDEX events_ts ON events(ts, seq);
  CREATE INDEX events_span ON events(span) WHERE span IS NOT NULL;
  CREATE TABLE connection_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT,
    start_ts INTEGER NOT NULL, end_ts INTEGER,
    reason TEXT NOT NULL,
    excluded INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX connection_gaps_start ON connection_gaps(start_ts)";

/// Columns added after version 1 shipped: created on open, so a reader of
/// an older log (opened read-only) has to check for them.
const ADDED_COLUMNS: [(&str, &str, &str); 4] = [
    ("workspaces", "repo_branch", "TEXT"),
    ("workspaces", "repo_remote_url", "TEXT"),
    ("events", "cause", "TEXT"),
    ("events", "input_age_ms", "INTEGER"),
];

/// The workspaces columns readers select; older logs lack the git ones.
pub const WORKSPACE_COLUMNS: &str = "id, connection_id, name, path, herdr_workspace_id, repo_root, repo_is_worktree, repo_branch, repo_remote_url";

/// Rows written before causes were recorded say nothing of theirs: one a
/// recorder wrote within this long of starting came from its start.
pub const LEGACY_START_MS: i64 = 10_000;

/// At most this many free pages are returned per vacuum.
const VACUUM_PAGES: i64 = 4096;
/// Below this many free pages a vacuum is not worth it.
const VACUUM_MIN_FREE_PAGES: i64 = 256;

pub fn activity_storage_path(directory: &Path) -> PathBuf {
    directory.join("activity.sqlite")
}

pub fn columns_of(db: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>("name"))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// Whether the workspaces table has its git columns.
pub fn has_added_columns(db: &Connection) -> rusqlite::Result<bool> {
    let columns = columns_of(db, "workspaces")?;
    Ok(ADDED_COLUMNS
        .iter()
        .all(|(table, column, _)| *table != "workspaces" || columns.iter().any(|c| c == column)))
}

/// Whether events record their cause and input age.
pub fn has_cause_columns(db: &Connection) -> rusqlite::Result<bool> {
    let columns = columns_of(db, "events")?;
    Ok(columns.iter().any(|c| c == "cause") && columns.iter().any(|c| c == "input_age_ms"))
}

/// A row's cause, derived for rows older than causes (`causeOf`).
pub fn cause_of(
    kind: &str,
    ts: i64,
    source: Option<&str>,
    visible: Option<bool>,
    cause: Option<&str>,
    session_start: Option<i64>,
) -> Option<String> {
    if let Some(cause) = cause.filter(|cause| !cause.is_empty()) {
        return Some(cause.to_owned());
    }
    let start = session_start?;
    if ts - start > LEGACY_START_MS {
        return None;
    }
    if kind == "workspace.focus" {
        return Some(
            if source == Some("herdr") {
                "recorder_start"
            } else {
                "reconnect"
            }
            .into(),
        );
    }
    if kind == "ui.visibility" && visible == Some(true) {
        return Some("reconnect".into());
    }
    None
}

/// The kinds that carry `cause` and `input_age_ms`.
fn caused_kind(kind: &str) -> bool {
    matches!(
        kind,
        "workspace.focus" | "workspace.blur" | "ui.visibility" | "session.active"
    )
}

/// What a recorder appends (`NewEvent`).
#[derive(Debug, Clone, Default)]
pub struct NewEvent {
    pub ts: i64,
    pub kind: &'static str,
    pub connection_id: String,
    pub session: i64,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub agent: Option<AgentFields>,
    pub visible: Option<bool>,
    pub idle_after_seconds: Option<i64>,
    pub reason: Option<&'static str>,
    pub client: Option<Client>,
    pub source: Option<&'static str>,
    /// On a blur: the seq of the focus it ends.
    pub span: Option<i64>,
    pub cause: Option<String>,
    pub input_age_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentFields {
    pub name: String,
    pub state: &'static str,
    pub task: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRow {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub path: Option<String>,
    pub herdr_workspace_id: Option<String>,
    pub repo_root: Option<String>,
    pub repo_is_worktree: Option<bool>,
    pub seen_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub id: i64,
    pub started_at: i64,
    pub last_alive: i64,
    pub stopped_at: Option<i64>,
}

impl SessionRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            started_at: row.get("started_at")?,
            last_alive: row.get("last_alive")?,
            stopped_at: row.get("stopped_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SpanRow {
    pub seq: i64,
    pub ts: i64,
    pub connection_id: String,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub client_id: Option<String>,
    pub client_kind: Option<String>,
    pub source: Option<String>,
    pub session: i64,
}

#[derive(Debug, Clone)]
pub struct VisibleClientRow {
    pub connection_id: String,
    pub client_id: String,
    pub client_kind: String,
    pub session: i64,
}

#[derive(Debug, Clone)]
pub struct GapRow {
    pub id: i64,
    pub connection_id: Option<String>,
    pub start_ts: i64,
    pub reason: String,
}

/// An events row as the readers select it (`e.*`, `open`, `session_start`).
#[derive(Debug, Clone, Default)]
pub struct EventRow {
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub connection_id: String,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub agent_name: Option<String>,
    pub agent_state: Option<String>,
    pub agent_task: Option<String>,
    pub agent_session_id: Option<String>,
    pub visible: Option<i64>,
    pub idle_after_seconds: Option<i64>,
    pub reason: Option<String>,
    pub client_id: Option<String>,
    pub client_kind: Option<String>,
    pub source: Option<String>,
    pub span: Option<i64>,
    pub open: i64,
    pub cause: Option<String>,
    pub input_age_ms: Option<i64>,
    pub session_start: Option<i64>,
}

fn optional_column<T: rusqlite::types::FromSql>(
    row: &Row<'_>,
    name: &str,
) -> rusqlite::Result<Option<T>> {
    match row.as_ref().column_index(name) {
        Ok(index) => row.get(index),
        Err(_) => Ok(None),
    }
}

impl EventRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get("seq")?,
            ts: row.get("ts")?,
            kind: row.get("kind")?,
            connection_id: row.get("connection_id")?,
            workspace_id: row.get("workspace_id")?,
            tab_id: row.get("tab_id")?,
            pane_id: row.get("pane_id")?,
            agent_name: row.get("agent_name")?,
            agent_state: row.get("agent_state")?,
            agent_task: row.get("agent_task")?,
            agent_session_id: row.get("agent_session_id")?,
            visible: row.get("visible")?,
            idle_after_seconds: row.get("idle_after_seconds")?,
            reason: row.get("reason")?,
            client_id: row.get("client_id")?,
            client_kind: row.get("client_kind")?,
            source: row.get("source")?,
            span: row.get("span")?,
            open: row.get::<_, Option<i64>>("open")?.unwrap_or(0),
            cause: optional_column(row, "cause")?,
            input_age_ms: optional_column(row, "input_age_ms")?,
            session_start: optional_column(row, "session_start")?,
        })
    }
}

/// A workspaces row (`WorkspaceDbRow`).
#[derive(Debug, Clone, Default)]
pub struct WorkspaceDbRow {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub path: Option<String>,
    pub herdr_workspace_id: Option<String>,
    pub repo_root: Option<String>,
    pub repo_is_worktree: Option<i64>,
    pub repo_branch: Option<String>,
    pub repo_remote_url: Option<String>,
}

impl WorkspaceDbRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            connection_id: row.get("connection_id")?,
            name: row.get("name")?,
            path: row.get("path")?,
            herdr_workspace_id: row.get("herdr_workspace_id")?,
            repo_root: row.get("repo_root")?,
            repo_is_worktree: row.get("repo_is_worktree")?,
            repo_branch: optional_column(row, "repo_branch")?,
            repo_remote_url: optional_column(row, "repo_remote_url")?,
        })
    }
}

fn nullable(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |text| Value::String(text.to_owned()))
}

/// An events row as the protocol's Event (`eventFromRow`).
pub fn event_from_row(row: &EventRow) -> Value {
    let mut event = Map::new();
    event.insert("id".into(), json!(event_id(row.seq)));
    event.insert("ts".into(), json!(iso_time(row.ts)));
    event.insert("kind".into(), json!(row.kind));
    event.insert("connection_id".into(), json!(row.connection_id));
    event.insert("workspace_id".into(), nullable(row.workspace_id.as_deref()));
    event.insert("tab_id".into(), nullable(row.tab_id.as_deref()));
    event.insert("pane_id".into(), nullable(row.pane_id.as_deref()));
    let kind = row.kind.as_str();
    if kind == "agent.state"
        && let (Some(name), Some(state)) = (
            row.agent_name.as_deref().filter(|v| !v.is_empty()),
            row.agent_state.as_deref().filter(|v| !v.is_empty()),
        )
    {
        event.insert(
            "agent".into(),
            json!({
                "name": name,
                "state": state,
                "task": nullable(row.agent_task.as_deref()),
                "session_id": nullable(row.agent_session_id.as_deref()),
            }),
        );
    }
    if kind == "ui.visibility" {
        event.insert("visible".into(), json!(row.visible == Some(1)));
    }
    if kind == "session.idle" {
        event.insert("idle_after_seconds".into(), json!(row.idle_after_seconds));
    }
    if kind == "workspace.blur" {
        event.insert("reason".into(), nullable(row.reason.as_deref()));
    }
    if kind == "workspace.focus" {
        event.insert("open".into(), json!(row.open == 1));
    }
    match (
        row.client_id.as_deref().filter(|v| !v.is_empty()),
        row.client_kind.as_deref().filter(|v| !v.is_empty()),
    ) {
        (Some(id), Some(client_kind)) => {
            event.insert("client".into(), json!({ "id": id, "kind": client_kind }));
        }
        _ if kind != "agent.state" => {
            event.insert("client".into(), Value::Null);
        }
        _ => {}
    }
    if let Some(source) = row.source.as_deref().filter(|v| !v.is_empty())
        && (kind == "workspace.focus" || kind == "workspace.blur")
    {
        event.insert("source".into(), json!(source));
    }
    if caused_kind(kind) {
        let cause = cause_of(
            kind,
            row.ts,
            row.source.as_deref(),
            row.visible.map(|v| v == 1),
            row.cause.as_deref(),
            row.session_start,
        );
        event.insert("cause".into(), json!(cause));
        event.insert("input_age_ms".into(), json!(row.input_age_ms));
    }
    Value::Object(event)
}

/// A workspaces row as the protocol's Workspace (`workspaceFromRow`).
pub fn workspace_from_row(row: &WorkspaceDbRow) -> Value {
    json!({
        "id": row.id,
        "connection_id": row.connection_id,
        "name": row.name,
        "path": row.path,
        "subject": null,
        "repo": match row.repo_root.as_deref().filter(|v| !v.is_empty()) {
            Some(root) => json!({
                "root": root,
                "remote_url": row.repo_remote_url,
                "branch": row.repo_branch,
                "is_worktree": row.repo_is_worktree == Some(1),
            }),
            None => Value::Null,
        },
        "herdr_workspace_id": row.herdr_workspace_id,
    })
}

/// The open log, for its one writer (the recorder).
pub struct ActivityStore {
    db: SqliteDb,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Open(#[from] SqliteError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl ActivityStore {
    /// Opens (or creates) `<directory>/activity.sqlite` for writing.
    pub fn open(context: &DataContext, directory: &Path) -> Result<Self, StoreError> {
        let path = activity_storage_path(directory);
        let db = SqliteDb::open(
            context,
            &path,
            SqliteSpec {
                name: "activity",
                busy_timeout_ms: 5_000,
                foreign_keys: false,
                synchronous: Synchronous::Normal,
                incremental_vacuum: true,
                schema: SCHEMA,
                user_version: SCHEMA_VERSION,
                versions: VersionRule::Exact,
            },
        )?;
        // For the readers: states and presence by kind. Added after version
        // 1 shipped, so created on open rather than with the schema.
        db.conn
            .execute_batch("CREATE INDEX IF NOT EXISTS events_kind ON events(kind, ts)")?;
        if !has_added_columns(&db.conn)? || !has_cause_columns(&db.conn)? {
            db.conn.execute_batch("BEGIN IMMEDIATE")?;
            let added = (|| -> rusqlite::Result<()> {
                for (table, column, kind) in ADDED_COLUMNS {
                    if !columns_of(&db.conn, table)?.iter().any(|c| c == column) {
                        db.conn.execute_batch(&format!(
                            "ALTER TABLE {table} ADD COLUMN {column} {kind}"
                        ))?;
                    }
                }
                Ok(())
            })();
            match added {
                Ok(()) => db.conn.execute_batch("COMMIT")?,
                Err(error) => {
                    let _ = db.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
            }
        }
        db.protect()?;
        Ok(Self { db })
    }

    pub fn conn(&self) -> &Connection {
        &self.db.conn
    }

    pub fn append(&self, event: &NewEvent) -> rusqlite::Result<i64> {
        let agent = event.agent.as_ref();
        self.db.conn.execute(
            "INSERT INTO events (
              ts, kind, connection_id, workspace_id, tab_id, pane_id,
              agent_name, agent_state, agent_task, agent_session_id,
              visible, idle_after_seconds, reason, client_id, client_kind, source,
              span, session, cause, input_age_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                event.ts,
                event.kind,
                event.connection_id,
                event.workspace_id,
                event.tab_id,
                event.pane_id,
                agent.map(|a| a.name.as_str()),
                agent.map(|a| a.state),
                agent.and_then(|a| a.task.as_deref()),
                agent.and_then(|a| a.session_id.as_deref()),
                event.visible.map(i64::from),
                event.idle_after_seconds,
                event.reason,
                event.client.as_ref().map(|c| c.id.as_str()),
                event.client.as_ref().map(|c| c.kind.as_str()),
                event.source,
                event.span,
                event.session,
                event.cause,
                // Math.round: half up.
                event.input_age_ms.map(|age| (age + 0.5).floor() as i64),
            ],
        )?;
        Ok(self.db.conn.last_insert_rowid())
    }

    pub fn upsert_workspace(&self, workspace: &WorkspaceRow) -> rusqlite::Result<()> {
        self.db.conn.execute(
            "INSERT INTO workspaces (
              id, connection_id, name, path, herdr_workspace_id,
              repo_root, repo_is_worktree, first_seen, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path,
              herdr_workspace_id = excluded.herdr_workspace_id,
              repo_root = COALESCE(excluded.repo_root, repo_root),
              repo_is_worktree = COALESCE(excluded.repo_is_worktree, repo_is_worktree),
              last_seen = MAX(last_seen, excluded.last_seen)",
            params![
                workspace.id,
                workspace.connection_id,
                workspace.name,
                workspace.path,
                workspace.herdr_workspace_id,
                workspace.repo_root,
                workspace.repo_is_worktree.map(i64::from),
                workspace.seen_at,
                workspace.seen_at,
            ],
        )?;
        Ok(())
    }

    /// What git says of a workspace's repository (repo_info).
    pub fn set_repo(&self, id: &str, repo: Option<&RepoInfo>) -> rusqlite::Result<()> {
        self.db.conn.execute(
            "UPDATE workspaces SET repo_root = COALESCE(?, repo_root), repo_is_worktree = ?,
               repo_branch = ?, repo_remote_url = ? WHERE id = ?",
            params![
                repo.and_then(|r| r.root.as_deref()),
                repo.map(|r| i64::from(r.is_worktree)),
                repo.and_then(|r| r.branch.as_deref()),
                repo.and_then(|r| r.remote_url.as_deref()),
                id,
            ],
        )?;
        Ok(())
    }

    pub fn start_session(&self, now: i64) -> rusqlite::Result<i64> {
        self.db.conn.query_row(
            "INSERT INTO recorder_sessions (started_at, last_alive) VALUES (?, ?) RETURNING id",
            params![now, now],
            |row| row.get(0),
        )
    }

    pub fn alive(&self, session: i64, now: i64) -> rusqlite::Result<()> {
        self.db.conn.execute(
            "UPDATE recorder_sessions SET last_alive = ? WHERE id = ? AND stopped_at IS NULL",
            params![now, session],
        )?;
        Ok(())
    }

    pub fn stop_session(&self, session: i64, at: i64, clean: bool) -> rusqlite::Result<()> {
        self.db.conn.execute(
            "UPDATE recorder_sessions SET stopped_at = ?, last_alive = MAX(last_alive, ?), clean_stop = ? WHERE id = ?",
            params![at, at, i64::from(clean), session],
        )?;
        Ok(())
    }

    /// Sessions never stopped: the recorder died.
    pub fn unfinished_sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        let mut statement = self.db.conn.prepare(
            "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions WHERE stopped_at IS NULL ORDER BY id",
        )?;
        statement.query_map([], SessionRow::from_row)?.collect()
    }

    /// The last session before `session`, if any.
    pub fn previous_session(&self, session: i64) -> rusqlite::Result<Option<SessionRow>> {
        self.db
            .conn
            .query_row(
                "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions WHERE id < ? ORDER BY id DESC LIMIT 1",
                [session],
                SessionRow::from_row,
            )
            .optional()
    }

    /// Focus events with no blur yet.
    pub fn open_spans(&self) -> rusqlite::Result<Vec<SpanRow>> {
        let mut statement = self.db.conn.prepare(
            "SELECT f.seq, f.ts, f.connection_id, f.workspace_id, f.tab_id, f.pane_id,
               f.client_id, f.client_kind, f.source, f.session
             FROM events f
             WHERE f.kind = 'workspace.focus'
               AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = f.seq)
             ORDER BY f.seq",
        )?;
        statement
            .query_map([], |row| {
                Ok(SpanRow {
                    seq: row.get("seq")?,
                    ts: row.get("ts")?,
                    connection_id: row.get("connection_id")?,
                    workspace_id: row.get("workspace_id")?,
                    tab_id: row.get("tab_id")?,
                    pane_id: row.get("pane_id")?,
                    client_id: row.get("client_id")?,
                    client_kind: row.get("client_kind")?,
                    source: row.get("source")?,
                    session: row.get("session")?,
                })
            })?
            .collect()
    }

    /// Clients whose last visibility event says visible.
    pub fn visible_clients(&self) -> rusqlite::Result<Vec<VisibleClientRow>> {
        let mut statement = self.db.conn.prepare(
            "SELECT e.connection_id, e.client_id, e.client_kind, e.session
             FROM events e
             WHERE e.seq IN (
               SELECT MAX(seq) FROM events
               WHERE kind = 'ui.visibility' AND client_id IS NOT NULL
               GROUP BY client_id
             ) AND e.visible = 1
             ORDER BY e.seq",
        )?;
        statement
            .query_map([], |row| {
                Ok(VisibleClientRow {
                    connection_id: row.get("connection_id")?,
                    client_id: row.get("client_id")?,
                    client_kind: row.get("client_kind")?,
                    session: row.get("session")?,
                })
            })?
            .collect()
    }

    pub fn open_gap(
        &self,
        connection_id: Option<&str>,
        start: i64,
        reason: &str,
    ) -> rusqlite::Result<i64> {
        self.db.conn.query_row(
            "INSERT INTO connection_gaps (connection_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?) RETURNING id",
            params![connection_id, start, Option::<i64>::None, reason],
            |row| row.get(0),
        )
    }

    pub fn close_gap(&self, id: i64, end: i64) -> rusqlite::Result<()> {
        self.db.conn.execute(
            "UPDATE connection_gaps SET end_ts = MAX(start_ts, ?) WHERE id = ? AND end_ts IS NULL",
            params![end, id],
        )?;
        Ok(())
    }

    pub fn add_gap(
        &self,
        connection_id: Option<&str>,
        start: i64,
        end: i64,
        reason: &str,
    ) -> rusqlite::Result<()> {
        if end > start {
            self.db.conn.query_row(
                "INSERT INTO connection_gaps (connection_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?) RETURNING id",
                params![connection_id, start, end, reason],
                |row| row.get::<_, i64>(0),
            )?;
        }
        Ok(())
    }

    pub fn open_gaps(&self) -> rusqlite::Result<Vec<GapRow>> {
        let mut statement = self.db.conn.prepare(
            "SELECT id, connection_id, start_ts, reason FROM connection_gaps WHERE end_ts IS NULL ORDER BY id",
        )?;
        statement
            .query_map([], |row| {
                Ok(GapRow {
                    id: row.get("id")?,
                    connection_id: row.get("connection_id")?,
                    start_ts: row.get("start_ts")?,
                    reason: row.get("reason")?,
                })
            })?
            .collect()
    }

    /// Deletes what ended before `cutoff`; returns the events deleted.
    pub fn purge(&self, cutoff: i64) -> rusqlite::Result<usize> {
        let conn = &self.db.conn;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> rusqlite::Result<usize> {
            let events = conn.execute("DELETE FROM events WHERE ts < ?", [cutoff])?;
            conn.execute(
                "DELETE FROM connection_gaps WHERE end_ts IS NOT NULL AND end_ts < ?",
                [cutoff],
            )?;
            conn.execute(
                "DELETE FROM recorder_sessions WHERE stopped_at IS NOT NULL AND stopped_at < ?
                   AND id < (SELECT MAX(id) FROM recorder_sessions)",
                [cutoff],
            )?;
            conn.execute(
                "DELETE FROM workspaces WHERE last_seen < ?
                   AND NOT EXISTS (SELECT 1 FROM events WHERE events.workspace_id = workspaces.id)",
                [cutoff],
            )?;
            Ok(events)
        })();
        match result {
            Ok(events) => {
                conn.execute_batch("COMMIT")?;
                Ok(events)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Returns freed pages to the file system, a bounded amount at a time.
    pub fn vacuum(&self) -> rusqlite::Result<()> {
        let free: i64 = self
            .db
            .conn
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        if free >= VACUUM_MIN_FREE_PAGES {
            // incremental_vacuum returns no rows, but steps.
            let mut statement = self
                .db
                .conn
                .prepare(&format!("PRAGMA incremental_vacuum({VACUUM_PAGES})"))?;
            let mut rows = statement.query([])?;
            while rows.next()?.is_some() {}
        }
        Ok(())
    }

    /// Read side, for tests.
    pub fn read_events(&self, from: Option<i64>, to: Option<i64>) -> rusqlite::Result<Vec<Value>> {
        let mut statement = self.db.conn.prepare(
            "SELECT e.*, (e.kind = 'workspace.focus'
                 AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = e.seq)) AS open,
               s.started_at AS session_start
             FROM events e LEFT JOIN recorder_sessions s ON s.id = e.session
             WHERE e.ts >= ? AND e.ts < ? ORDER BY e.ts, e.seq",
        )?;
        let rows = statement
            .query_map(
                params![from.unwrap_or(0), to.unwrap_or(9_007_199_254_740_991)],
                EventRow::from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.iter().map(event_from_row).collect())
    }

    pub fn read_workspaces(&self) -> rusqlite::Result<Vec<Value>> {
        let mut statement = self.db.conn.prepare(&format!(
            "SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY id"
        ))?;
        let rows = statement
            .query_map([], WorkspaceDbRow::from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.iter().map(workspace_from_row).collect())
    }

    pub fn read_gaps(&self) -> rusqlite::Result<Vec<Value>> {
        let mut statement = self.db.conn.prepare(
            "SELECT connection_id, start_ts, end_ts, reason, excluded FROM connection_gaps ORDER BY start_ts, id",
        )?;
        statement
            .query_map([], |row| {
                let end: Option<i64> = row.get("end_ts")?;
                Ok(json!({
                    "connection_id": row.get::<_, Option<String>>("connection_id")?,
                    "start": iso_time(row.get("start_ts")?),
                    "end": end.map(iso_time),
                    "reason": row.get::<_, String>("reason")?,
                    "excluded": row.get::<_, i64>("excluded")? == 1,
                }))
            })?
            .collect()
    }
}

#[cfg(test)]
mod tests;
