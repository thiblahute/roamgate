//! Ranger's scheduled tasks on disk (`assistant/task-storage.ts`):
//! `tasks.sqlite`, `user_version` 3, the tables of `contract/sqlite/tasks.sql`.
//!
//! SQLite is authoritative once its file exists, even when it holds no
//! tasks. A database Bun wrote opens here and one written here opens in
//! Bun, older Roamgates included: versions 1 and 2 are migrated in one
//! transaction that validates every table first; additions to version 3
//! (the `all_workspaces` column, the `run_notices` table) keep the version,
//! since an older Roamgate reading version 3 names the task columns it saves
//! and ignores the table. Anything it cannot read fails closed without
//! touching the file.

use std::path::{Path, PathBuf};

use roamgate_agents::js;
use roamgate_base::paths::DataContext;
use roamgate_base::private::{create_private_dir, private_file, protect_sidecars};
use roamgate_base::sqlite::sidecars;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Map, Value};

use crate::saved::{MAX_TASK_STATE_BYTES, UNFINISHED, validate_saved_tasks};

const INVALID_FILE: &str = "Invalid Ranger task storage file";

/// Run notices live beside the runs rather than in them: an older Roamgate
/// writes runs by position, so a new runs column would break its saves after
/// a rollback. It does not know this table, leaves it alone, and its rows
/// name runs by their unique id, so a stale one is dropped on the next save.
const RUN_NOTICES: &str = "CREATE TABLE IF NOT EXISTS run_notices (
    run_id TEXT PRIMARY KEY, notice TEXT NOT NULL
  ) STRICT;";

const SCHEMA: &str = "
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    next_run_at TEXT, due_at TEXT,
    title TEXT NOT NULL, prompt TEXT NOT NULL, scope TEXT NOT NULL,
    schedule TEXT NOT NULL, config TEXT NOT NULL,
    targets TEXT NOT NULL, workspaces TEXT NOT NULL,
    notification_mode TEXT, notifications TEXT NOT NULL DEFAULT '[]',
    mentions TEXT, all_workspaces INTEGER
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
";

/// The bounds checked before any JSON is read: each table's rows and the
/// bytes of its columns, summed over the tables.
const BOUNDS: [(&str, usize, &[&str]); 5] = [
    (
        "tasks",
        50,
        &[
            "id",
            "status",
            "created_at",
            "updated_at",
            "next_run_at",
            "due_at",
            "title",
            "prompt",
            "scope",
            "schedule",
            "config",
            "targets",
            "workspaces",
            "notification_mode",
            "notifications",
            "mentions",
        ],
    ),
    (
        "runs",
        1000,
        &[
            "id",
            "task_id",
            "status",
            "scheduled_at",
            "started_at",
            "finished_at",
            "admission",
            "error",
        ],
    ),
    (
        "proposals",
        50,
        &["id", "status", "created_at", "task_id", "input", "prepared"],
    ),
    ("requests", 1000, &["id", "task_id"]),
    ("run_notices", 1000, &["run_id", "notice"]),
];

#[derive(Debug, thiserror::Error)]
pub enum TaskStorageError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

fn message(text: impl Into<String>) -> TaskStorageError {
    TaskStorageError::Message(text.into())
}

type Result<T> = std::result::Result<T, TaskStorageError>;

/// The open task database.
pub struct TaskStorage {
    conn: Option<Connection>,
    path: PathBuf,
    context: DataContext,
}

fn io_invalid(error: std::io::Error) -> TaskStorageError {
    if error.kind() == std::io::ErrorKind::InvalidData {
        message(INVALID_FILE)
    } else {
        error.into()
    }
}

fn parse(text: &str) -> Result<Value> {
    js::parse(text).ok_or_else(|| message(format!("JSON Parse error: {text:.40}")))
}

/// Runs `body` in a transaction (`BEGIN IMMEDIATE` when `immediate`),
/// rolled back when it fails.
fn transaction<T>(
    conn: &Connection,
    immediate: bool,
    body: impl FnOnce(&Connection) -> Result<T>,
) -> Result<T> {
    conn.execute_batch(if immediate {
        "BEGIN IMMEDIATE"
    } else {
        "BEGIN"
    })?;
    match body(conn) {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn optional_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn json_text(value: Option<&Value>) -> String {
    js::stringify(value.unwrap_or(&Value::Null))
}

/// Reads and validates every table (no transaction of its own).
fn read_state(conn: &Connection) -> Result<Value> {
    // Bound row counts and payloads before materialising JSON from disk.
    let mut bytes: i64 = 0;
    for (table, count, columns) in BOUNDS {
        let sum = columns
            .iter()
            .map(|column| format!("coalesce(length(CAST({column} AS BLOB)), 0)"))
            .collect::<Vec<_>>()
            .join(" + ");
        let (rows, size): (i64, i64) = conn.query_row(
            &format!("SELECT count(*) AS count, coalesce(sum({sum}), 0) AS bytes FROM {table}"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        bytes += size;
        if rows as usize > count || bytes as usize > MAX_TASK_STATE_BYTES {
            return Err(message("Saved Ranger tasks are too large"));
        }
    }
    struct Run {
        id: String,
        task_id: String,
        status: String,
        scheduled_at: String,
        started_at: Option<String>,
        finished_at: Option<String>,
        error: Option<String>,
        manual: i64,
        admission: Option<String>,
    }
    let mut statement = conn.prepare(
        "SELECT id, task_id, status, scheduled_at, started_at, finished_at, error, manual, admission FROM runs ORDER BY position",
    )?;
    let runs = statement
        .query_map([], |row| {
            Ok(Run {
                id: row.get(0)?,
                task_id: row.get(1)?,
                status: row.get(2)?,
                scheduled_at: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                error: row.get(6)?,
                manual: row.get(7)?,
                admission: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut statement = conn.prepare("SELECT run_id, notice FROM run_notices")?;
    let notices: std::collections::HashMap<String, String> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(statement);

    // The columns an older version lacks are read by name when present.
    let mut statement = conn.prepare("SELECT * FROM tasks ORDER BY position")?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|n| n.to_string())
        .collect();
    let rows = statement
        .query_map([], |row| {
            let mut fields = std::collections::HashMap::new();
            for (index, name) in names.iter().enumerate() {
                let value: rusqlite::types::Value = row.get(index)?;
                fields.insert(name.clone(), value);
            }
            Ok(fields)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let get_text = |fields: &std::collections::HashMap<String, rusqlite::types::Value>,
                    name: &str|
     -> Option<String> {
        match fields.get(name) {
            Some(rusqlite::types::Value::Text(text)) => Some(text.clone()),
            _ => None,
        }
    };
    let mut tasks = Vec::new();
    for fields in &rows {
        let text = |name: &str| get_text(fields, name).unwrap_or_default();
        let id = text("id");
        let mut task = Map::new();
        task.insert("id".into(), Value::String(id.clone()));
        task.insert("status".into(), Value::String(text("status")));
        task.insert("created_at".into(), Value::String(text("created_at")));
        task.insert("updated_at".into(), Value::String(text("updated_at")));
        task.insert(
            "next_run_at".into(),
            get_text(fields, "next_run_at").map_or(Value::Null, Value::String),
        );
        let mut input = Map::new();
        input.insert("title".into(), Value::String(text("title")));
        input.insert("prompt".into(), Value::String(text("prompt")));
        input.insert("scope".into(), parse(&text("scope"))?);
        input.insert("schedule".into(), parse(&text("schedule"))?);
        if let Some(mode) = get_text(fields, "notification_mode") {
            input.insert("notification_mode".into(), Value::String(mode));
        }
        if let Some(mentions) = get_text(fields, "mentions") {
            input.insert("mentions".into(), parse(&mentions)?);
        }
        // An older Roamgate saves no flag: the task keeps its scope.
        if matches!(
            fields.get("all_workspaces"),
            Some(rusqlite::types::Value::Integer(1))
        ) {
            input.insert("all_workspaces".into(), Value::Bool(true));
        }
        let notifications = parse(&get_text(fields, "notifications").unwrap_or_default())?;
        let mut entry = Map::new();
        entry.insert("task".into(), Value::Object(task));
        if let Some(due) = get_text(fields, "due_at") {
            entry.insert("due_at".into(), Value::String(due));
        }
        entry.insert("input".into(), Value::Object(input));
        entry.insert("config".into(), parse(&text("config"))?);
        entry.insert("targets".into(), parse(&text("targets"))?);
        entry.insert("workspaces".into(), parse(&text("workspaces"))?);
        if !notifications.as_array().is_some_and(Vec::is_empty) {
            entry.insert("notifications".into(), notifications);
        }
        let mut task_runs = Vec::new();
        for run in runs.iter().filter(|run| run.task_id == id) {
            let mut value = match &run.admission {
                Some(admission) => match parse(admission)? {
                    Value::Object(map) => map,
                    _ => Map::new(),
                },
                None => Map::new(),
            };
            value.insert("id".into(), Value::String(run.id.clone()));
            value.insert("task_id".into(), Value::String(run.task_id.clone()));
            value.insert("status".into(), Value::String(run.status.clone()));
            value.insert(
                "scheduled_at".into(),
                Value::String(run.scheduled_at.clone()),
            );
            if let Some(started) = &run.started_at {
                value.insert("started_at".into(), Value::String(started.clone()));
            }
            if let Some(finished) = &run.finished_at {
                value.insert("finished_at".into(), Value::String(finished.clone()));
            }
            value.insert(
                "error".into(),
                run.error.clone().map_or(Value::Null, Value::String),
            );
            value.insert("manual".into(), Value::Bool(run.manual == 1));
            if let Some(notice) = notices.get(&run.id) {
                value.insert("notice".into(), Value::String(notice.clone()));
            }
            task_runs.push(Value::Object(value));
        }
        entry.insert("runs".into(), Value::Array(task_runs));
        tasks.push(Value::Object(entry));
    }
    let ids: Vec<String> = rows
        .iter()
        .map(|f| get_text(f, "id").unwrap_or_default())
        .collect();
    if runs
        .iter()
        .any(|run| !ids.contains(&run.task_id) || ![0, 1].contains(&run.manual))
    {
        return Err(message("Invalid saved task runs"));
    }
    let mut statement = conn.prepare(
        "SELECT id, status, created_at, task_id, input, prepared FROM proposals ORDER BY position",
    )?;
    let proposal_rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut proposals = Vec::new();
    for (id, status, created_at, task_id, input, prepared) in proposal_rows {
        let mut proposal = match parse(&input)? {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        proposal.insert("id".into(), Value::String(id));
        proposal.insert("status".into(), Value::String(status));
        proposal.insert("created_at".into(), Value::String(created_at));
        match task_id {
            Some(task_id) => {
                proposal.insert("task_id".into(), Value::String(task_id));
            }
            // `task_id: undefined` keeps a key the input may have named.
            None => {
                proposal.shift_remove("task_id");
            }
        }
        let mut entry = Map::new();
        entry.insert("proposal".into(), Value::Object(proposal));
        entry.insert("prepared".into(), parse(&prepared)?);
        proposals.push(Value::Object(entry));
    }
    let mut statement = conn.prepare("SELECT id, task_id FROM requests ORDER BY position")?;
    let requests = statement
        .query_map([], |row| {
            let mut request = Map::new();
            request.insert("id".into(), Value::String(row.get(0)?));
            request.insert("task_id".into(), Value::String(row.get(1)?));
            Ok(Value::Object(request))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut state = Map::new();
    state.insert("tasks".into(), Value::Array(tasks));
    state.insert("proposals".into(), Value::Array(proposals));
    state.insert("requests".into(), Value::Array(requests));
    let state = Value::Object(state);
    validate_saved_tasks(&state).map_err(message)?;
    Ok(state)
}

fn write_state(conn: &Connection, state: &Value) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM requests; DELETE FROM runs; DELETE FROM tasks; DELETE FROM proposals; DELETE FROM run_notices",
    )?;
    let mut notice_insert = conn.prepare("INSERT INTO run_notices VALUES (?, ?)")?;
    let mut task_insert = conn.prepare(
        "INSERT INTO tasks (
          id, position, status, created_at, updated_at, next_run_at, due_at,
          title, prompt, scope, schedule, config, targets, workspaces,
          notification_mode, notifications, mentions, all_workspaces
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    let mut run_insert = conn.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")?;
    let empty = Vec::new();
    for (position, entry) in state["tasks"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .enumerate()
    {
        let task = &entry["task"];
        let input = &entry["input"];
        let notifications = entry
            .get("notifications")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        task_insert.execute(params![
            task["id"].as_str(),
            position as i64,
            task["status"].as_str(),
            task["created_at"].as_str(),
            task["updated_at"].as_str(),
            optional_text(task.get("next_run_at")),
            optional_text(entry.get("due_at")),
            input["title"].as_str(),
            input["prompt"].as_str(),
            json_text(input.get("scope")),
            json_text(input.get("schedule")),
            json_text(entry.get("config")),
            json_text(entry.get("targets")),
            json_text(entry.get("workspaces")),
            optional_text(input.get("notification_mode")),
            js::stringify(&notifications),
            input.get("mentions").map(js::stringify),
            (input.get("all_workspaces") == Some(&Value::Bool(true))).then_some(1i64),
        ])?;
        for (position, run) in entry["runs"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .enumerate()
        {
            let status = run["status"].as_str().unwrap_or("");
            let admission = UNFINISHED.contains(&status).then(|| {
                let mut admission = Map::new();
                for key in ["input", "config", "targets", "workspaces"] {
                    admission.insert(key.into(), run.get(key).cloned().unwrap_or(Value::Null));
                }
                js::stringify(&Value::Object(admission))
            });
            run_insert.execute(params![
                run["id"].as_str(),
                task["id"].as_str(),
                position as i64,
                status,
                run["scheduled_at"].as_str(),
                optional_text(run.get("started_at")),
                optional_text(run.get("finished_at")),
                optional_text(run.get("error")),
                i64::from(run.get("manual") == Some(&Value::Bool(true))),
                admission,
            ])?;
            if let Some(notice) = run.get("notice").and_then(Value::as_str) {
                notice_insert.execute(params![run["id"].as_str(), notice])?;
            }
        }
    }
    let mut proposal_insert = conn.prepare("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?)")?;
    for (position, entry) in state["proposals"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .enumerate()
    {
        let mut input = entry["proposal"].as_object().cloned().unwrap_or_default();
        let id = input.shift_remove("id");
        let status = input.shift_remove("status");
        let created_at = input.shift_remove("created_at");
        let task_id = input.shift_remove("task_id");
        proposal_insert.execute(params![
            id.as_ref().and_then(Value::as_str),
            position as i64,
            status.as_ref().and_then(Value::as_str),
            created_at.as_ref().and_then(Value::as_str),
            task_id.as_ref().and_then(Value::as_str),
            js::stringify(&Value::Object(input)),
            json_text(entry.get("prepared")),
        ])?;
    }
    let mut request_insert = conn.prepare("INSERT INTO requests VALUES (?, ?, ?)")?;
    for (position, request) in state["requests"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .enumerate()
    {
        request_insert.execute(params![
            request["id"].as_str(),
            request["task_id"].as_str(),
            position as i64
        ])?;
    }
    Ok(())
}

/// Additions to version 3 that an older Roamgate reading version 3 still
/// reads and writes, so they keep the version.
fn additions(conn: &Connection) -> Result<()> {
    let columns = task_columns(conn)?;
    if !columns.is_empty() && !columns.iter().any(|c| c == "all_workspaces") {
        conn.execute_batch("ALTER TABLE tasks ADD COLUMN all_workspaces INTEGER")?;
    }
    conn.execute_batch(RUN_NOTICES)?;
    Ok(())
}

fn task_columns(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_table_info('tasks')")?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

fn current(conn: &Connection) -> Result<bool> {
    let has_notices: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_notices'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(task_columns(conn)?.iter().any(|c| c == "all_workspaces") && has_notices.is_some())
}

impl TaskStorage {
    /// Opens `<directory>/tasks.sqlite`, creating, migrating or refusing it
    /// as Bun's `openTaskStorage` does.
    pub fn open(context: &DataContext, directory: &Path) -> Result<Self> {
        let path = directory.join("tasks.sqlite");
        context.assert_safe_data_path(&path)?;
        create_private_dir(directory)?;
        roamgate_base::private::set_mode(directory, 0o700)?;
        let existing = std::fs::symlink_metadata(&path).is_ok();
        private_file(&path, !existing, INVALID_FILE).map_err(io_invalid)?;
        let storage = Self {
            conn: None,
            path: path.clone(),
            context: context.clone(),
        };
        storage.protect()?;
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if existing && ![1, 2, 3].contains(&version) {
            return Err(message("Unsupported Ranger task database"));
        }
        let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if mode != "wal" {
            return Err(message("Ranger task database requires WAL"));
        }
        conn.execute_batch("PRAGMA synchronous = FULL")?;
        storage.protect()?;
        if !existing {
            transaction(&conn, true, |conn| {
                conn.execute_batch(SCHEMA)?;
                conn.execute_batch(RUN_NOTICES)?;
                conn.execute_batch("PRAGMA user_version = 3")?;
                read_state(conn).map(drop)
            })?;
        } else if version == 1 || version == 2 {
            transaction(&conn, true, |conn| {
                if version == 1 {
                    conn.execute_batch(
                        "ALTER TABLE tasks ADD COLUMN notification_mode TEXT;
                         ALTER TABLE tasks ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]';",
                    )?;
                }
                conn.execute_batch("ALTER TABLE tasks ADD COLUMN mentions TEXT")?;
                additions(conn)?;
                // Validate every table before committing the upgrade.
                read_state(conn)?;
                conn.execute_batch("PRAGMA user_version = 3")?;
                Ok(())
            })?;
        } else if !current(&conn)? {
            transaction(&conn, true, |conn| {
                additions(conn)?;
                read_state(conn).map(drop)
            })?;
        } else {
            // Fail closed while opening, a missing or damaged table included.
            transaction(&conn, false, read_state)?;
        }
        Ok(Self {
            conn: Some(conn),
            ..storage
        })
    }

    fn conn(&self) -> Result<&Connection> {
        self.conn
            .as_ref()
            .ok_or_else(|| message("Ranger task storage is closed"))
    }

    fn protect(&self) -> Result<()> {
        self.context.assert_safe_data_path(&self.path)?;
        for sidecar in sidecars(&self.path) {
            self.context.assert_safe_data_path(&sidecar)?;
        }
        protect_sidecars(&sidecars(&self.path), INVALID_FILE).map_err(io_invalid)
    }

    /// The saved state, validated.
    pub fn load(&self) -> Result<Value> {
        transaction(self.conn()?, false, read_state)
    }

    /// Replaces the saved state, after validating it, in one transaction.
    pub fn save(&self, state: &Value) -> Result<()> {
        let conn = self.conn()?;
        self.protect()?;
        transaction(conn, true, |conn| {
            validate_saved_tasks(state).map_err(message)?;
            write_state(conn, state)
        })
    }

    pub fn close(&mut self) {
        self.conn = None;
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests;
