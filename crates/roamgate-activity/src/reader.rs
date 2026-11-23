//! Read-only access to activity.sqlite (server/src/activity/reader.ts), for
//! the timeline RPC, the day input and `roamgate activity`. Opens its own
//! connection: the recorder (Bun's or Rust's) may be writing (WAL lets
//! readers in), or not running at all.

use std::collections::HashSet;
use std::path::Path;

use roamgate_base::paths::DataContext;
use rusqlite::{Connection, OpenFlags, OptionalExtension, ToSql};
use serde_json::{Value, json};

use crate::protocol::iso_time;
use crate::store::{
    EventRow, SessionRow, WORKSPACE_COLUMNS, WorkspaceDbRow, activity_storage_path, cause_of,
    event_from_row, has_added_columns, has_cause_columns, workspace_from_row,
};
use crate::subjects::SubjectResolver;
use crate::timeline::{
    AgentRow, DEFAULT_IDLE_MS, FocusRow, GapInputRow, PresenceRow, RECORDER_STALE_MS,
    TimelineInput, build_timeline,
};

pub const PAGE_LIMIT_DEFAULT: i64 = 1000;
pub const PAGE_LIMIT_MAX: i64 = 5000;

/// Parses an event id (`0000000000000042`) back into its seq.
pub fn event_seq(id: &str) -> Option<i64> {
    if id.is_empty() || id.len() > 16 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let seq: i64 = id.parse().ok()?;
    (seq <= 9_007_199_254_740_991).then_some(seq)
}

/// A page query (`PageQuery`).
#[derive(Debug, Clone, Default)]
pub struct PageQuery {
    pub after: Option<i64>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub connection: Option<String>,
    pub workspace: Option<String>,
    pub kinds: Vec<String>,
    /// Connections left out (`exclude.connections`).
    pub exclude_connections: Vec<String>,
    pub limit: i64,
}

#[derive(Debug, Clone, Default)]
pub struct WorkspacesQuery {
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub connection: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReaderError {
    #[error("Unsupported activity database")]
    Unsupported,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Timeline(String),
}

pub struct ActivityReader {
    db: Connection,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    subjects: Option<SubjectResolver>,
    causes: bool,
    added: bool,
}

fn check_version(db: &Connection) -> Result<(), ReaderError> {
    db.busy_timeout(std::time::Duration::from_millis(5_000))?;
    let version: i64 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != 1 {
        return Err(ReaderError::Unsupported);
    }
    Ok(())
}

/// A read-only connection. With the recorder stopped, a WAL database has no
/// shared-memory file, which a read-only connection cannot create: then a
/// connection that may create it, refusing every write (`query_only`).
fn open_read_only(path: &Path) -> Result<Connection, ReaderError> {
    let first = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(ReaderError::from)
    .and_then(|db| check_version(&db).map(|()| db));
    match first {
        Ok(db) => return Ok(db),
        Err(ReaderError::Sqlite(rusqlite::Error::SqliteFailure(error, _)))
            if error.code == rusqlite::ErrorCode::CannotOpen => {}
        Err(error) => return Err(error),
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.execute_batch("PRAGMA query_only = ON")?;
    check_version(&db)?;
    Ok(db)
}

fn query_rows<T>(
    db: &Connection,
    sql: &str,
    args: &[&dyn ToSql],
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut statement = db.prepare(sql)?;
    statement.query_map(args, map)?.collect()
}

impl ActivityReader {
    /// None when there is no log yet.
    pub fn open(
        context: &DataContext,
        directory: &Path,
        now: Box<dyn Fn() -> i64 + Send + Sync>,
        subjects: Option<SubjectResolver>,
    ) -> Result<Option<Self>, ReaderError> {
        let path = activity_storage_path(directory);
        context.assert_safe_data_path(&path)?;
        if !path.exists() {
            return Ok(None);
        }
        let db = open_read_only(&path)?;
        let causes = has_cause_columns(&db)?;
        let added = has_added_columns(&db)?;
        Ok(Some(Self {
            db,
            now,
            subjects,
            causes,
            added,
        }))
    }

    fn cause_column(&self, table: &str) -> String {
        if self.causes {
            format!("{table}.cause")
        } else {
            "NULL".into()
        }
    }

    fn all_workspaces(&self) -> rusqlite::Result<Vec<Value>> {
        let sql = if self.added {
            format!("SELECT {WORKSPACE_COLUMNS} FROM workspaces ORDER BY id")
        } else {
            "SELECT id, connection_id, name, path, herdr_workspace_id, repo_root, repo_is_worktree FROM workspaces ORDER BY id".into()
        };
        let rows = query_rows(&self.db, &sql, &[], WorkspaceDbRow::from_row)?;
        let workspaces: Vec<Value> = rows.iter().map(workspace_from_row).collect();
        Ok(match &self.subjects {
            Some(subjects) => subjects.with_subjects(workspaces),
            None => workspaces,
        })
    }

    fn gaps(&self, to: i64, from: i64) -> rusqlite::Result<Vec<GapInputRow>> {
        query_rows(
            &self.db,
            "SELECT connection_id, start_ts AS start, end_ts AS \"end\", reason
             FROM connection_gaps
             WHERE start_ts < ?1 AND (end_ts IS NULL OR end_ts > ?2)
             ORDER BY start_ts, id",
            &[&to, &from],
            |row| {
                Ok(GapInputRow {
                    connection_id: row.get("connection_id")?,
                    start: row.get("start")?,
                    end: row.get("end")?,
                    reason: row.get("reason")?,
                })
            },
        )
    }

    fn sessions(&self) -> rusqlite::Result<Vec<SessionRow>> {
        query_rows(
            &self.db,
            "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions ORDER BY id",
            &[],
            SessionRow::from_row,
        )
    }

    /// The timeline of `[from, to)` (`timeline`): `exclude_connections`
    /// leaves those connections out entirely; `idle_seconds` is the setting.
    pub fn timeline(
        &self,
        range: (i64, i64),
        day_start: &str,
        exclude_connections: &[String],
        idle_seconds: Option<i64>,
    ) -> Result<Value, ReaderError> {
        let (from, to) = range;
        let at = (self.now)();
        let idle_ms = idle_seconds.map_or(DEFAULT_IDLE_MS, |seconds| seconds * 1000);
        let excluded: HashSet<&str> = exclude_connections.iter().map(String::as_str).collect();
        let kept = |connection: Option<&str>| connection.is_none_or(|c| !excluded.contains(c));
        self.db.execute_batch("BEGIN DEFERRED")?;
        let result = (|| -> Result<TimelineInput, ReaderError> {
            let focus_sql = format!(
                "SELECT f.seq, f.ts AS start, b.ts AS \"end\", b.reason, f.connection_id,
                   f.workspace_id, f.tab_id, f.pane_id, COALESCE(f.source, 'browser') AS source,
                   f.client_id, f.client_kind, f.session, {} AS cause,
                   {} AS end_cause, s.started_at AS session_start
                 FROM events f LEFT JOIN events b
                   ON b.span = f.seq AND b.kind = 'workspace.blur'
                 LEFT JOIN recorder_sessions s ON s.id = f.session
                 WHERE f.kind = 'workspace.focus' AND f.ts < ?1
                   AND (b.ts IS NULL OR b.ts >= ?2)
                 ORDER BY f.seq",
                self.cause_column("f"),
                self.cause_column("b")
            );
            let since = from - idle_ms;
            let focus = query_rows(&self.db, &focus_sql, &[&to, &since], |row| {
                let end: Option<i64> = row.get("end")?;
                let start: i64 = row.get("start")?;
                let source: String = row.get("source")?;
                let cause: Option<String> = row.get("cause")?;
                let session_start: Option<i64> = row.get("session_start")?;
                Ok(FocusRow {
                    seq: row.get("seq")?,
                    start,
                    end,
                    reason: if end.is_none() {
                        None
                    } else {
                        row.get("reason")?
                    },
                    connection_id: row.get("connection_id")?,
                    workspace_id: row.get("workspace_id")?,
                    tab_id: row.get("tab_id")?,
                    pane_id: row.get("pane_id")?,
                    cause: cause_of(
                        "workspace.focus",
                        start,
                        Some(&source),
                        None,
                        cause.as_deref(),
                        session_start,
                    ),
                    source,
                    client_id: row.get("client_id")?,
                    client_kind: row.get("client_kind")?,
                    session: row.get("session")?,
                    end_cause: if end.is_none() {
                        None
                    } else {
                        row.get("end_cause")?
                    },
                })
            })?;
            let presence_columns = format!(
                "seq, ts, kind, connection_id, client_id, client_kind,
                   CASE WHEN visible IS NULL THEN NULL ELSE visible = 1 END AS visible, session,
                   {} AS cause,
                   (SELECT started_at FROM recorder_sessions s WHERE s.id = events.session)
                     AS session_start",
                self.cause_column("events")
            );
            let presence_kinds = "kind IN ('session.idle', 'session.active', 'ui.visibility')
                   AND client_id IS NOT NULL";
            let presence_sql = format!(
                "SELECT {presence_columns} FROM events
                 WHERE {presence_kinds} AND ts >= ?1 AND ts < ?2
                 UNION
                 SELECT {presence_columns} FROM events
                 WHERE seq IN (SELECT MAX(seq) FROM events
                   WHERE {presence_kinds} AND ts < ?1 GROUP BY client_id)
                 ORDER BY seq"
            );
            let presence = query_rows(&self.db, &presence_sql, &[&from, &to], |row| {
                let kind: String = row.get("kind")?;
                let ts: i64 = row.get("ts")?;
                let visible: Option<i64> = row.get("visible")?;
                let cause: Option<String> = row.get("cause")?;
                let session_start: Option<i64> = row.get("session_start")?;
                Ok(PresenceRow {
                    seq: row.get("seq")?,
                    ts,
                    cause: cause_of(
                        &kind,
                        ts,
                        None,
                        visible.map(|v| v != 0),
                        cause.as_deref(),
                        session_start,
                    ),
                    kind,
                    connection_id: row.get("connection_id")?,
                    client_id: row.get("client_id")?,
                    client_kind: row.get("client_kind")?,
                    visible: visible.map(|v| v != 0),
                    session: row.get("session")?,
                })
            })?;
            let agent_columns = "seq, ts, connection_id, workspace_id, pane_id,
                   agent_name AS name, agent_state AS state, agent_task AS task, session";
            let agents_sql = format!(
                "SELECT {agent_columns} FROM events
                 WHERE kind = 'agent.state' AND agent_name IS NOT NULL
                   AND ts >= ?1 AND ts < ?2
                 UNION
                 SELECT {agent_columns} FROM events
                 WHERE seq IN (SELECT MAX(seq) FROM events
                   WHERE kind = 'agent.state' AND agent_name IS NOT NULL AND ts < ?1
                   GROUP BY connection_id, pane_id, agent_name)
                   AND agent_state != 'unknown'
                 ORDER BY seq"
            );
            let agents = query_rows(&self.db, &agents_sql, &[&from, &to], |row| {
                Ok(AgentRow {
                    seq: row.get("seq")?,
                    ts: row.get("ts")?,
                    connection_id: row.get("connection_id")?,
                    workspace_id: row.get("workspace_id")?,
                    pane_id: row.get("pane_id")?,
                    name: row.get("name")?,
                    state: row.get::<_, Option<String>>("state")?.unwrap_or_default(),
                    task: row.get("task")?,
                    session: row.get("session")?,
                })
            })?;
            let gaps = self.gaps(to, from)?;
            let sessions = self.sessions()?;
            let workspaces = self.all_workspaces()?;
            Ok(TimelineInput {
                from: from as f64,
                to: to as f64,
                now: at as f64,
                day_start: day_start.to_owned(),
                focus: focus
                    .into_iter()
                    .filter(|r| kept(Some(&r.connection_id)))
                    .collect(),
                presence: presence
                    .into_iter()
                    .filter(|r| kept(Some(&r.connection_id)))
                    .collect(),
                agents: agents
                    .into_iter()
                    .filter(|r| kept(Some(&r.connection_id)))
                    .collect(),
                gaps: gaps
                    .into_iter()
                    .filter(|r| kept(r.connection_id.as_deref()))
                    .collect(),
                sessions,
                workspaces: workspaces
                    .into_iter()
                    .filter(|w| kept(w.get("connection_id").and_then(Value::as_str)))
                    .collect(),
                idle_ms: Some(idle_ms),
            })
        })();
        let _ = self.db.execute_batch("COMMIT");
        build_timeline(&result?).map_err(ReaderError::Timeline)
    }

    /// Events in id order after `after`, within `[from, to)` by `ts`.
    pub fn page(&self, query: &PageQuery) -> Result<Value, ReaderError> {
        let mut clauses = vec!["e.seq > ?".to_owned()];
        let mut args: Vec<Box<dyn ToSql>> = vec![Box::new(query.after.unwrap_or(0))];
        if let Some(from) = query.from {
            clauses.push("e.ts >= ?".into());
            args.push(Box::new(from));
        }
        if let Some(to) = query.to {
            clauses.push("e.ts < ?".into());
            args.push(Box::new(to));
        }
        if let Some(connection) = &query.connection {
            clauses.push("e.connection_id = ?".into());
            args.push(Box::new(connection.clone()));
        }
        if let Some(workspace) = &query.workspace {
            clauses.push("e.workspace_id = ?".into());
            args.push(Box::new(workspace.clone()));
        }
        if !query.kinds.is_empty() {
            clauses.push(format!(
                "e.kind IN ({})",
                vec!["?"; query.kinds.len()].join(", ")
            ));
            args.extend(
                query
                    .kinds
                    .iter()
                    .map(|k| Box::new(k.clone()) as Box<dyn ToSql>),
            );
        }
        if !query.exclude_connections.is_empty() {
            clauses.push(format!(
                "e.connection_id NOT IN ({})",
                vec!["?"; query.exclude_connections.len()].join(", ")
            ));
            args.extend(
                query
                    .exclude_connections
                    .iter()
                    .map(|c| Box::new(c.clone()) as Box<dyn ToSql>),
            );
        }
        let limit = query.limit.clamp(1, PAGE_LIMIT_MAX);
        args.push(Box::new(limit + 1));
        let sql = format!(
            "SELECT e.*, (e.kind = 'workspace.focus'
                 AND NOT EXISTS (SELECT 1 FROM events b WHERE b.span = e.seq)) AS open,
               s.started_at AS session_start
             FROM events e LEFT JOIN recorder_sessions s ON s.id = e.session
             WHERE {}
             ORDER BY e.seq LIMIT ?",
            clauses.join(" AND ")
        );
        let refs: Vec<&dyn ToSql> = args.iter().map(|a| a.as_ref()).collect();
        let rows = query_rows(&self.db, &sql, &refs, EventRow::from_row)?;
        let more = rows.len() as i64 > limit;
        let events: Vec<Value> = rows
            .iter()
            .take(limit as usize)
            .map(event_from_row)
            .collect();
        let ids: HashSet<&str> = events
            .iter()
            .filter_map(|e| e.get("workspace_id").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .collect();
        let workspaces: Vec<Value> = self
            .all_workspaces()?
            .into_iter()
            .filter(|w| {
                w.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.contains(id))
            })
            .collect();
        let next_cursor = if more {
            events.last().and_then(|e| e.get("id")).cloned()
        } else {
            None
        };
        Ok(json!({ "events": events, "workspaces": workspaces, "next_cursor": next_cursor }))
    }

    pub fn workspaces(&self, query: &WorkspacesQuery) -> Result<Vec<Value>, ReaderError> {
        let mut clauses = vec!["workspace_id IS NOT NULL".to_owned()];
        let mut args: Vec<Box<dyn ToSql>> = Vec::new();
        if let Some(from) = query.from {
            clauses.push("ts >= ?".into());
            args.push(Box::new(from));
        }
        if let Some(to) = query.to {
            clauses.push("ts < ?".into());
            args.push(Box::new(to));
        }
        if let Some(connection) = &query.connection {
            clauses.push("connection_id = ?".into());
            args.push(Box::new(connection.clone()));
        }
        let refs: Vec<&dyn ToSql> = args.iter().map(|a| a.as_ref()).collect();
        let ids: HashSet<String> = query_rows(
            &self.db,
            &format!(
                "SELECT DISTINCT workspace_id FROM events WHERE {}",
                clauses.join(" AND ")
            ),
            &refs,
            |row| row.get::<_, String>(0),
        )?
        .into_iter()
        .collect();
        Ok(self
            .all_workspaces()?
            .into_iter()
            .filter(|w| {
                w.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| ids.contains(id))
            })
            .collect())
    }

    /// The schema's Status (`roamgate activity status`).
    pub fn status(
        &self,
        enabled: bool,
        retention_days: i64,
        from: i64,
        to: i64,
    ) -> Result<Value, ReaderError> {
        let at = (self.now)();
        let latest = self
            .db
            .query_row(
                "SELECT id, started_at, last_alive, stopped_at FROM recorder_sessions ORDER BY id DESC LIMIT 1",
                [],
                SessionRow::from_row,
            )
            .optional()?;
        let running = latest
            .as_ref()
            .is_some_and(|l| l.stopped_at.is_none() && at - l.last_alive <= RECORDER_STALE_MS);
        let ids = query_rows(
            &self.db,
            "SELECT connection_id AS id FROM workspaces
             UNION SELECT connection_id FROM connection_gaps
               WHERE connection_id IS NOT NULL
             ORDER BY id",
            &[],
            |row| row.get::<_, String>(0),
        )?;
        let mut connections = Vec::new();
        for id in ids {
            let open: i64 = self.db.query_row(
                "SELECT COUNT(*) AS n FROM connection_gaps WHERE connection_id = ? AND end_ts IS NULL",
                [&id],
                |row| row.get(0),
            )?;
            if !running || open > 0 {
                connections
                    .push(json!({ "id": id, "state": "disconnected", "recording_since": null }));
                continue;
            }
            let last_gap: Option<i64> = self.db.query_row(
                "SELECT MAX(end_ts) AS end_ts FROM connection_gaps WHERE connection_id = ?",
                [&id],
                |row| row.get(0),
            )?;
            let started = latest.as_ref().map_or(0, |l| l.started_at);
            connections.push(json!({
                "id": id,
                "state": "ready",
                "recording_since": iso_time(last_gap.unwrap_or(0).max(started)),
            }));
        }
        let mut gaps: Vec<Value> = self
            .gaps(to, from)?
            .into_iter()
            .map(|gap| {
                json!({
                    "connection_id": gap.connection_id,
                    "start": iso_time(gap.start),
                    "end": gap.end.map(iso_time),
                    "reason": gap.reason,
                    "excluded": false,
                })
            })
            .collect();
        if let Some(latest) = latest.as_ref().filter(|_| !running) {
            gaps.push(json!({
                "connection_id": null,
                "start": iso_time(latest.stopped_at.unwrap_or(latest.last_alive)),
                "end": null,
                "reason": "recorder",
                "excluded": false,
            }));
        }
        Ok(json!({
            "recording": enabled && running,
            "retention_days": retention_days,
            "last_alive": latest.as_ref().map(|l| iso_time(l.last_alive)),
            "gaps": gaps,
            "connections": connections,
        }))
    }
}

#[cfg(test)]
mod tests;
