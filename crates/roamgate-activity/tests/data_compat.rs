//! activity.sqlite between the Bun server and the Rust core (the plan's
//! section 5.7), against the TS store, reader and recorder run by Bun:
//!
//! - forward: logs Bun wrote, in today's shape, in the shape a long-lived
//!   install has (version 1 with the git and cause columns added later, as
//!   the dogfood log is), and from before those columns (opened read-only),
//!   read the same by both readers;
//! - backward: what the Rust recorder writes from the same signals is what
//!   Bun's writes, row for row, and Bun reads it as Rust does;
//! - coexistence: the two recorders take turns on one log (clean stops and
//!   a crash, each recovering the other's session), giving the rows one
//!   recorder alone gives; and a reader of one side reads while the other
//!   writes (WAL).
//!
//! Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_activity::BoxFuture;
use roamgate_activity::day_input::ActivitySettings;
use roamgate_activity::reader::{ActivityReader, PageQuery, WorkspacesQuery};
use roamgate_activity::recorder::{ActivityRecorder, OwnedAgent, RecorderHost, RecorderOptions};
use roamgate_activity::repo_info::{RunHostScript, ScriptOutput};
use roamgate_activity::subjects::SubjectResolver;
use roamgate_activity::timeline::day_bounds;
use roamgate_base::clock::{BoxFuture as ClockFuture, Clock, Interval};
use roamgate_base::log::Logger;
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
        eprintln!("skipped: bun is not on PATH, the Bun side of the log cannot run");
    }
    found
}

/// The Bun side: `seed`, `record` and `read` on a directory.
const DRIVER: &str = r#"
const [root, command, dir, raw] = process.argv.slice(2);
const spec = JSON.parse(raw);
const { openActivityStore } = await import(`${root}/server/src/activity/store.ts`);
const { openActivityReader } = await import(`${root}/server/src/activity/reader.ts`);
const { createActivityRecorder } = await import(`${root}/server/src/activity/recorder.ts`);
const { subjectResolver } = await import(`${root}/server/src/activity/subjects.ts`);
const { DEFAULT_ACTIVITY_SETTINGS } = await import(`${root}/server/src/config/gui-settings.ts`);

if (command === "read") {
  const reader = openActivityReader(dir, () => spec.now, {
    subjectOf: subjectResolver({ roots: spec.roots, home: "/home/me" }),
  });
  if (!reader) { console.log("null"); process.exit(0); }
  const out = {
    timeline: reader.timeline({ from: spec.from, to: spec.to }, spec.day_start, spec.exclude, spec.idle_seconds),
    page: reader.page({ limit: 5000 }),
    filtered: reader.page({ limit: 2, after: 1, kinds: ["workspace.focus", "agent.state"], excludeConnections: ["box"] }),
    workspaces: reader.workspaces({}),
    status: reader.status({ enabled: true, retentionDays: 90, from: spec.from, to: spec.now }),
  };
  reader.close();
  console.log(JSON.stringify(out));
} else if (command === "record") {
  let now = spec.start;
  const recorder = createActivityRecorder({
    settings: async () => ({ ...DEFAULT_ACTIVITY_SETTINGS, enabled: true, record_agent_titles: true }),
    directory: () => dir,
    herdrCall: async (_id, method) =>
      method === "workspace.list" ? { workspaces: spec.herdr.workspaces } : { panes: spec.herdr.panes },
    ownedAgents: () => spec.herdr.owned,
    runHostScript: async () => { throw new Error("no host here"); },
    now: () => now,
  });
  await recorder.ready();
  const sockets = new Map();
  const socket = (n) => { if (!sockets.has(n)) sockets.set(n, {}); return sockets.get(n); };
  for (const step of spec.steps) {
    if ("now" in step) now = step.now;
    else if ("status" in step) recorder.connectionStatus(...step.status);
    else if ("event" in step) recorder.herdrEvent(...step.event);
    else if ("panes" in step) recorder.paneList(...step.panes);
    else if ("owned" in step) recorder.ownedAgentChanged(...step.owned);
    else if ("presence" in step) await recorder.presence(socket(step.presence[0]), step.presence[1], step.presence[2]);
    else if ("closed" in step) recorder.socketClosed(socket(step.closed));
    await recorder.flush();
  }
  if (spec.end === "crash") recorder.store()?.close();
  else await recorder.stop();
  process.exit(0);
} else if (command === "hold") {
  // A writer appending while the other side reads.
  const store = openActivityStore(dir);
  const session = store.startSession(spec.start);
  for (let i = 0; i < spec.count; i++) {
    store.append({ ts: spec.start + i, kind: "agent.state", connectionId: "local", session,
      agent: { name: "claude", state: i % 2 ? "idle" : "working", task: null, sessionId: null } });
    if (i === 0) console.log("writing");
    Bun.sleepSync(1);
  }
  store.close();
}
"#;

struct Bun {
    bin: PathBuf,
    script: PathBuf,
    _dir: tempfile::TempDir,
}

impl Bun {
    fn new() -> Option<Self> {
        let bin = bun()?;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("driver.ts");
        std::fs::write(&script, DRIVER).unwrap();
        Some(Self {
            bin,
            script,
            _dir: dir,
        })
    }

    fn command(&self, command: &str, dir: &Path, spec: &Value) -> Command {
        let mut run = Command::new(&self.bin);
        run.current_dir(repo().join("server"))
            .arg(&self.script)
            .arg(repo())
            .arg(command)
            .arg(dir)
            .arg(spec.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        run
    }

    fn run(&self, command: &str, dir: &Path, spec: &Value) -> String {
        let output = self.command(command, dir, spec).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "bun {command} failed: {stderr}");
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }
}

// --- The Rust side ---------------------------------------------------------

/// A clock set step by step; its timers never come due (the Bun driver's
/// real timers do not either, in a run this short).
#[derive(Default)]
struct StepClock(AtomicI64);

impl Clock for StepClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    fn monotonic(&self) -> f64 {
        self.now() as f64
    }
    fn sleep_until(&self, deadline: i64) -> ClockFuture<()> {
        let due = deadline <= self.now();
        Box::pin(async move {
            if !due {
                std::future::pending::<()>().await;
            }
        })
    }
    fn sleep(&self, duration: Duration) -> ClockFuture<()> {
        self.sleep_until(self.now() + duration.as_millis() as i64)
    }
    fn interval(&self, _period: Duration) -> Interval {
        Interval::new(|| Box::pin(std::future::pending::<()>()))
    }
}

struct Herdr(Value);

impl RunHostScript for Herdr {
    fn run(&self, _connection_id: &str, _script: &str) -> BoxFuture<Result<ScriptOutput, String>> {
        Box::pin(async { Err("no host here".to_owned()) })
    }
}

impl RecorderHost for Herdr {
    fn herdr_call(
        &self,
        _connection_id: &str,
        method: &str,
        _params: Value,
    ) -> BoxFuture<Result<Value, String>> {
        let answer = if method == "workspace.list" {
            json!({"workspaces": self.0["workspaces"]})
        } else {
            json!({"panes": self.0["panes"]})
        };
        Box::pin(async move { Ok(answer) })
    }
    fn owned_agents(&self, _connection_id: &str) -> BoxFuture<Vec<OwnedAgent>> {
        let owned = self.0["owned"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|agent| OwnedAgent {
                pane_id: agent["pane_id"].as_str().unwrap().into(),
                session_id: agent["session_id"].as_str().map(str::to_owned),
                agent_status: agent["agent_status"].as_str().unwrap().into(),
            })
            .collect();
        Box::pin(async move { owned })
    }
}

fn context(dir: &Path) -> DataContext {
    DataContext::new(dir, Platform::Unix, None)
}

async fn rust_record(dir: &Path, spec: &Value) {
    let clock = Arc::new(StepClock::default());
    clock
        .0
        .store(spec["start"].as_i64().unwrap(), Ordering::SeqCst);
    let recorder = ActivityRecorder::start(RecorderOptions {
        settings: ActivitySettings {
            enabled: true,
            record_agent_titles: true,
            ..ActivitySettings::default()
        },
        context: context(dir.parent().unwrap()),
        directory: dir.to_path_buf(),
        host: Arc::new(Herdr(spec["herdr"].clone())),
        clock: clock.clone(),
        logger: Logger::silent(),
    });
    assert!(recorder.ready().await);
    for step in spec["steps"].as_array().unwrap() {
        let args = |key: &str| step[key].as_array().unwrap().clone();
        if let Some(now) = step.get("now") {
            clock.0.store(now.as_i64().unwrap(), Ordering::SeqCst);
        } else if step.get("status").is_some() {
            let a = args("status");
            recorder.connection_status(a[0].as_str().unwrap(), a[1].as_str().unwrap(), None);
        } else if step.get("event").is_some() {
            let a = args("event");
            recorder.herdr_event(a[0].as_str().unwrap(), a[1].clone(), None);
        } else if step.get("panes").is_some() {
            let a = args("panes");
            recorder.pane_list(
                a[0].as_str().unwrap(),
                a[1].clone(),
                a[2].as_i64().unwrap(),
                None,
            );
        } else if step.get("owned").is_some() {
            let a = args("owned");
            recorder.owned_agent_changed(a[0].as_str().unwrap(), a[1].as_str().unwrap(), None);
        } else if step.get("presence").is_some() {
            let a = args("presence");
            recorder
                .presence(a[0].as_u64().unwrap(), a[1].as_str().unwrap(), &a[2], None)
                .await
                .unwrap();
        } else if let Some(socket) = step.get("closed") {
            recorder.socket_closed(socket.as_u64().unwrap(), None);
        }
        recorder.flush().await;
    }
    if spec["end"] == "crash" {
        recorder.abandon();
        tokio::task::yield_now().await;
    } else {
        recorder.stop().await;
    }
}

fn read_spec(now: i64) -> Value {
    let (from, to) = day_bounds("2026-11-02", "00:00");
    json!({
        "now": now, "from": from, "to": to, "day_start": "00:00", "exclude": ["box"],
        "idle_seconds": 120, "roots": ["~/src"],
    })
}

fn rust_read(dir: &Path, spec: &Value) -> Value {
    let now = spec["now"].as_i64().unwrap();
    let roots = vec!["~/src".to_owned()];
    let Some(reader) = ActivityReader::open(
        &context(dir.parent().unwrap()),
        dir,
        Box::new(move || now),
        Some(SubjectResolver::new(&roots, None, Some("/home/me"))),
    )
    .unwrap() else {
        return Value::Null;
    };
    let range = (spec["from"].as_i64().unwrap(), spec["to"].as_i64().unwrap());
    json!({
        "timeline": reader.timeline(range, "00:00", &["box".to_owned()], Some(120)).unwrap(),
        "page": reader.page(&PageQuery { limit: 5000, ..Default::default() }).unwrap(),
        "filtered": reader.page(&PageQuery {
            limit: 2,
            after: Some(1),
            kinds: vec!["workspace.focus".into(), "agent.state".into()],
            exclude_connections: vec!["box".into()],
            ..Default::default()
        }).unwrap(),
        "workspaces": reader.workspaces(&WorkspacesQuery::default()).unwrap(),
        "status": reader.status(true, 90, range.0, now).unwrap(),
    })
}

/// Every row of every table, for row-for-row comparisons.
fn dump(dir: &Path) -> Value {
    let db = Connection::open_with_flags(
        dir.join("activity.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut out = serde_json::Map::new();
    for (table, order) in [
        ("recorder_sessions", "id"),
        ("workspaces", "id"),
        ("events", "seq"),
        ("connection_gaps", "id"),
    ] {
        let mut statement = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .unwrap();
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|n| n.to_string())
            .collect();
        let rows: Vec<Value> = statement
            .query_map([], |row| {
                let mut object = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => json!(n),
                        rusqlite::types::ValueRef::Real(f) => json!(f),
                        rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                        rusqlite::types::ValueRef::Blob(_) => json!("<blob>"),
                    };
                    object.insert(name.clone(), value);
                }
                Ok(Value::Object(object))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        out.insert(table.into(), json!(rows));
    }
    Value::Object(out)
}

// --- Scenarios -------------------------------------------------------------

fn t(hours: i64, minutes: i64) -> i64 {
    day_bounds("2026-11-02", &format!("{hours:02}:{minutes:02}")).0
}

fn herdr() -> Value {
    json!({
        "workspaces": [
            {"workspace_id": "w1", "label": "roamgate", "focused": true,
             "worktree": {"checkout_path": "/home/me/src/roamgate", "repo_root": "/home/me/src/roamgate", "is_linked_worktree": false}},
            {"workspace_id": "w2", "label": "gst", "focused": false},
        ],
        "panes": [
            {"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "agent": "claude", "agent_status": "working",
             "agent_session": {"kind": "id", "value": "s1"}, "title": "Fix it", "focused": true, "cwd": "/home/me/src/roamgate"},
            {"pane_id": "w2:p1", "workspace_id": "w2", "tab_id": "w2:t1", "agent_status": "unknown", "focused": false,
             "cwd": "/home/me/src/gst"},
        ],
        "owned": [{"pane_id": "w2:p1", "session_id": "s9", "agent_status": "idle"}],
    })
}

fn presence(workspace: &str, pane: &str, age: i64, cause: &str) -> Value {
    json!({"client_id": "c1", "client_kind": "desktop", "workspace_id": workspace, "tab_id": null,
           "pane_id": pane, "visible": true, "focused": true, "input_age_ms": age, "cause": cause})
}

/// A morning's signals, starting at `start`, ending with `end`.
fn session(start: i64, end: &str) -> Value {
    let status = |state: &str| json!({"status": ["local", state]});
    json!({
        "start": start,
        "herdr": herdr(),
        "end": end,
        "steps": [
            status("ready"),
            {"status": ["box", "connecting"]},
            {"now": start + 60_000},
            {"presence": [1, "local", presence("w1", "w1:p1", 0, "user_input")]},
            {"event": ["local", {"event": "pane.agent_status_changed", "data": {"pane_id": "w1:p1", "workspace_id": "w1", "agent_status": "idle", "agent": "claude", "title": "Fix it"}}]},
            {"now": start + 120_000},
            {"owned": ["local", "w2:p1"]},
            {"panes": ["local", {"panes": herdr()["panes"]}, start + 110_000]},
            {"presence": [1, "local", presence("w2", "w2:p1", 1_000, "user_input")]},
            {"event": ["local", {"event": "workspace.focused", "data": {"workspace_id": "w2"}}]},
            {"now": start + 600_000},
            {"presence": [1, "local", presence("w2", "w2:p1", 480_000, "repeat")]},
            {"now": start + 700_000},
            {"presence": [2, "local", presence("w1", "w1:p1", null_age(), "page_load")]},
            {"closed": 1},
            status("reconnecting"),
            {"now": start + 760_000},
            status("ready"),
            {"status": ["box", "ready"]},
        ],
    })
}

fn null_age() -> i64 {
    // A page that loaded: no input yet (input_age_ms null) is set below.
    -1
}

fn fix_null_ages(mut spec: Value) -> Value {
    for step in spec["steps"].as_array_mut().unwrap() {
        if let Some(params) = step.get_mut("presence").and_then(|p| p.get_mut(2))
            && params["input_age_ms"] == -1
        {
            params["input_age_ms"] = Value::Null;
        }
    }
    spec
}

fn dirs() -> (tempfile::TempDir, PathBuf) {
    let base = tempfile::tempdir().unwrap();
    let dir = base.path().join("roamgate");
    (base, dir)
}

#[tokio::test]
async fn rust_writes_what_bun_writes_from_the_same_signals_and_each_reads_the_others_log() {
    let Some(bun) = Bun::new() else { return };
    let spec = fix_null_ages(session(t(9, 0), "stop"));
    let (_a, by_bun) = dirs();
    let (_b, by_rust) = dirs();
    bun.run("record", &by_bun, &spec);
    rust_record(&by_rust, &spec).await;
    // Row for row (backward: the same file Bun would have).
    assert_eq!(dump(&by_rust), dump(&by_bun));
    let read = read_spec(t(12, 0));
    // Forward: Bun's log read by both; backward: Rust's read by both.
    for dir in [&by_bun, &by_rust] {
        let bun_read: Value = serde_json::from_str(&bun.run("read", dir, &read)).unwrap();
        assert_eq!(rust_read(dir, &read), bun_read, "{}", dir.display());
        assert!(bun_read["page"]["events"].as_array().unwrap().len() > 10);
    }
}

#[tokio::test]
async fn the_two_recorders_take_turns_on_one_log_through_stops_and_a_crash() {
    let Some(bun) = Bun::new() else { return };
    let sessions = [
        fix_null_ages(session(t(8, 0), "stop")),
        fix_null_ages(session(t(9, 0), "stop")),
        fix_null_ages(session(t(10, 0), "crash")),
        fix_null_ages(session(t(11, 0), "stop")),
    ];
    // Bun, Rust, Bun crashing, Rust recovering; and the same with one side.
    let (_a, mixed) = dirs();
    let (_b, all_bun) = dirs();
    let (_c, all_rust) = dirs();
    for (index, spec) in sessions.iter().enumerate() {
        if index % 2 == 0 {
            bun.run("record", &mixed, spec);
        } else {
            rust_record(&mixed, spec).await;
        }
        bun.run("record", &all_bun, spec);
        rust_record(&all_rust, spec).await;
    }
    let mixed_rows = dump(&mixed);
    assert_eq!(mixed_rows, dump(&all_bun));
    assert_eq!(mixed_rows, dump(&all_rust));
    // The crashed session was closed at its last sign of life by the next.
    let sessions_rows = mixed_rows["recorder_sessions"].as_array().unwrap();
    assert_eq!(sessions_rows.len(), 4);
    assert_eq!(sessions_rows[2]["clean_stop"], 0);
    let read = read_spec(t(12, 0));
    let bun_read: Value = serde_json::from_str(&bun.run("read", &mixed, &read)).unwrap();
    assert_eq!(rust_read(&mixed, &read), bun_read);
}

/// A version 1 log as it shipped: no git columns, no causes.
fn shipped_v1(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    let db = Connection::open(dir.join("activity.sqlite")).unwrap();
    db.execute_batch(
        "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;
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
          session INTEGER NOT NULL
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
        CREATE INDEX connection_gaps_start ON connection_gaps(start_ts);
        PRAGMA user_version = 1;",
    )
    .unwrap();
    let start = t(8, 0);
    db.execute("INSERT INTO recorder_sessions (started_at, last_alive, stopped_at, clean_stop) VALUES (?, ?, ?, 1)", [start, t(11, 0), t(11, 0)])
        .unwrap();
    db.execute(
        "INSERT INTO workspaces VALUES ('ws_a', 'local', 'alpha', '/home/me/src/alpha', 'w1', '/home/me/src/alpha', 0, ?, ?)",
        [start, start],
    )
    .unwrap();
    let rows = [
        (start + 2_000, "workspace.focus", None, Some("herdr")),
        (t(9, 0), "ui.visibility", Some(1), None),
        (t(9, 0), "workspace.focus", None, Some("browser")),
        (t(10, 0), "workspace.blur", None, Some("browser")),
    ];
    for (ts, kind, visible, source) in rows {
        let client = if source == Some("herdr") {
            None
        } else {
            Some("c1")
        };
        db.execute(
            "INSERT INTO events (ts, kind, connection_id, workspace_id, visible, client_id, client_kind, source, span, reason, session)
             VALUES (?, ?, 'local', 'ws_a', ?, ?, ?, ?, ?, ?, 1)",
            rusqlite::params![
                ts,
                kind,
                visible,
                client,
                client.map(|_| "desktop"),
                source,
                (kind == "workspace.blur").then_some(3),
                (kind == "workspace.blur").then_some("switch"),
            ],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO events (ts, kind, connection_id, workspace_id, pane_id, agent_name, agent_state, session)
         VALUES (?, 'agent.state', 'local', 'ws_a', 'p1', 'claude', 'working', 1)",
        [t(9, 30)],
    )
    .unwrap();
    db.execute("INSERT INTO connection_gaps (connection_id, start_ts, end_ts, reason) VALUES ('box', ?, NULL, 'error')", [start])
        .unwrap();
}

#[tokio::test]
async fn old_logs_read_the_same_from_both_sides_before_and_after_a_writer_adds_the_columns() {
    let Some(bun) = Bun::new() else { return };
    let (_base, dir) = dirs();
    shipped_v1(&dir);
    let read = read_spec(t(12, 0));
    // As shipped, opened read-only by both: no cause or git columns yet.
    let bun_read: Value = serde_json::from_str(&bun.run("read", &dir, &read)).unwrap();
    assert_eq!(rust_read(&dir, &read), bun_read);
    assert_eq!(bun_read["page"]["events"][0]["cause"], "recorder_start");
    // The shape a long-lived install has (the dogfood log): a writer added
    // the columns. Rust's writer adds them here; Bun reads them.
    rust_record(&dir, &fix_null_ages(session(t(11, 30), "stop"))).await;
    let db = Connection::open(dir.join("activity.sqlite")).unwrap();
    let schema: String = db
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'events'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        schema.ends_with(", cause TEXT, input_age_ms INTEGER) STRICT"),
        "{schema}"
    );
    drop(db);
    let read = read_spec(t(13, 0));
    let bun_read: Value = serde_json::from_str(&bun.run("read", &dir, &read)).unwrap();
    assert_eq!(rust_read(&dir, &read), bun_read);
}

#[tokio::test]
async fn a_reader_of_one_side_reads_while_the_other_writes() {
    let Some(bun) = Bun::new() else { return };
    let (_base, dir) = dirs();
    // Bun writes; Rust reads meanwhile (the shadow read while Bun owns).
    let start = t(9, 0);
    rust_record(&dir, &fix_null_ages(session(t(8, 0), "stop"))).await;
    let mut writer = bun
        .command("hold", &dir, &json!({"start": start, "count": 400}))
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(writer.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    assert_eq!(line.trim(), "writing");
    let read = read_spec(t(12, 0));
    let mut seen = Vec::new();
    for _ in 0..20 {
        let value = rust_read(&dir, &read);
        seen.push(value["page"]["events"].as_array().unwrap().len());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(writer.wait().unwrap().success());
    assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]), "{seen:?}");
    // Rust writes; Bun reads meanwhile.
    let spec = fix_null_ages(session(t(13, 0), "stop"));
    let reads = Arc::new(Mutex::new(Vec::new()));
    let reader = {
        let reads = reads.clone();
        let dir = dir.clone();
        let read = read_spec(t(14, 0));
        let bin = bun.bin.clone();
        let script = bun.script.clone();
        std::thread::spawn(move || {
            for _ in 0..3 {
                let output = Command::new(&bin)
                    .current_dir(repo().join("server"))
                    .arg(&script)
                    .arg(repo())
                    .arg("read")
                    .arg(&dir)
                    .arg(read.to_string())
                    .output()
                    .unwrap();
                reads.lock().unwrap().push(output.status.success());
            }
        })
    };
    rust_record(&dir, &spec).await;
    reader.join().unwrap();
    assert!(reads.lock().unwrap().iter().all(|ok| *ok));
    let read = read_spec(t(14, 0));
    let bun_read: Value = serde_json::from_str(&bun.run("read", &dir, &read)).unwrap();
    assert_eq!(rust_read(&dir, &read), bun_read);
}
