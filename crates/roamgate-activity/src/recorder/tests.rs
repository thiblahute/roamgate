//! server/src/activity/recorder.test.ts, case for case, on a manual clock
//! that steps through its timers in order as Bun's fake timers do.

use super::*;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;

use roamgate_base::clock::{BoxFuture as ClockFuture, Clock, Interval};
use roamgate_base::paths::Platform;

use crate::protocol::parse_time;
use crate::repo_info::ScriptOutput;
use crate::store::{AgentFields, NewEvent, WorkspaceRow};
use crate::subjects::{SubjectResolver, SubjectWorkspace, Tree};

const T0: i64 = 1_793_610_000_000; // 2026-11-02T09:00:00Z
const SECOND: i64 = 1000;
const DAY: i64 = 24 * 60 * 60 * SECOND;

// --- A clock moved by hand ----------------------------------------------

#[derive(Default)]
struct ManualClock {
    now: AtomicI64,
    sleepers: Mutex<Vec<(i64, oneshot::Sender<()>)>>,
}

impl ManualClock {
    fn at(now: i64) -> Arc<Self> {
        let clock = Arc::new(Self::default());
        clock.now.store(now, Ordering::SeqCst);
        clock
    }

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    /// `jest.advanceTimersByTime`: each due timer fires at its own time.
    async fn advance(&self, ms: i64) {
        let target = self.now.load(Ordering::SeqCst) + ms;
        loop {
            Self::settle().await;
            let next = {
                let mut sleepers = self.sleepers.lock().unwrap();
                sleepers.retain(|(_, tx)| !tx.is_closed());
                sleepers
                    .iter()
                    .map(|(deadline, _)| *deadline)
                    .filter(|d| *d <= target)
                    .min()
            };
            let Some(deadline) = next else { break };
            self.now.store(
                deadline.max(self.now.load(Ordering::SeqCst)),
                Ordering::SeqCst,
            );
            let due: Vec<oneshot::Sender<()>> = {
                let mut sleepers = self.sleepers.lock().unwrap();
                let (due, rest): (Vec<_>, Vec<_>) =
                    sleepers.drain(..).partition(|(d, _)| *d <= deadline);
                *sleepers = rest;
                due.into_iter().map(|(_, tx)| tx).collect()
            };
            for tx in due {
                let _ = tx.send(());
            }
        }
        self.now.store(target, Ordering::SeqCst);
        Self::settle().await;
    }

    /// `jest.setSystemTime`: the time moves, no timer fires.
    fn set(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }

    /// `jest.clearAllTimers`.
    fn clear(&self) {
        self.sleepers.lock().unwrap().clear();
    }
}

impl Clock for ManualClock {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn monotonic(&self) -> f64 {
        self.now() as f64
    }

    fn sleep_until(&self, deadline: i64) -> ClockFuture<()> {
        let (tx, rx) = oneshot::channel();
        if deadline <= self.now() {
            let _ = tx.send(());
        } else {
            self.sleepers.lock().unwrap().push((deadline, tx));
        }
        Box::pin(async move {
            // A cleared timer never fires.
            if rx.await.is_err() {
                std::future::pending::<()>().await;
            }
        })
    }

    fn sleep(&self, duration: Duration) -> ClockFuture<()> {
        self.sleep_until(self.now() + duration.as_millis() as i64)
    }

    fn interval(&self, _period: Duration) -> Interval {
        unimplemented!("the recorder steps its own intervals")
    }
}

// --- A fake Herdr and host -----------------------------------------------

#[derive(Clone)]
struct Repo {
    top: &'static str,
    common: &'static str,
    gitdir: &'static str,
    branch: &'static str,
    remote: &'static str,
}

#[derive(Default)]
struct FakeState {
    workspaces: Vec<Value>,
    panes: Vec<Value>,
    calls: Vec<String>,
    owned: Vec<OwnedAgent>,
    repos: HashMap<String, Repo>,
    host_scripts: Vec<String>,
    host_fails: bool,
}

#[derive(Clone)]
struct FakeHerdr(Arc<Mutex<FakeState>>);

fn fake_herdr() -> FakeHerdr {
    FakeHerdr(Arc::new(Mutex::new(FakeState {
        workspaces: vec![
            json!({
                "workspace_id": "w1", "label": "roamgate", "focused": true,
                "worktree": {
                    "checkout_path": "/src/roamgate", "repo_root": "/src/roamgate",
                    "repo_key": "/src/roamgate/.git", "repo_name": "roamgate", "is_linked_worktree": false,
                },
            }),
            json!({ "workspace_id": "w2", "label": "gst", "focused": false }),
        ],
        panes: vec![
            json!({
                "pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "agent": "claude",
                "agent_status": "working", "agent_session": {"agent": "claude", "kind": "id", "value": "s1"},
                "title": "Fix the bridge", "focused": true, "cwd": "/src/roamgate",
            }),
            json!({
                "pane_id": "w1:p2", "workspace_id": "w1", "tab_id": "w1:t1",
                "agent_status": "unknown", "focused": false, "cwd": "/src/roamgate",
            }),
            json!({
                "pane_id": "w2:p1", "workspace_id": "w2", "tab_id": "w2:t1",
                "agent_status": "unknown", "focused": false, "cwd": "/src/gst",
            }),
        ],
        ..Default::default()
    })))
}

impl FakeHerdr {
    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0.lock().unwrap()
    }

    fn panes(&self) -> Value {
        json!({ "panes": self.state().panes.clone() })
    }
}

impl RunHostScript for FakeHerdr {
    fn run(&self, _connection_id: &str, script: &str) -> BoxFuture<Result<ScriptOutput, String>> {
        let mut state = self.state();
        state.host_scripts.push(script.to_owned());
        if state.host_fails {
            return Box::pin(async { Err("ssh down".to_owned()) });
        }
        let marker = Regex::new(r"printf '(\S+) begin 0")
            .unwrap()
            .captures(script)
            .unwrap()[1]
            .to_owned();
        let paths: Vec<String> = Regex::new(r"(?m)^p='([^']*)'$")
            .unwrap()
            .captures_iter(script)
            .map(|c| c[1].to_owned())
            .collect();
        let mut lines = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            lines.push(format!("{marker} begin {index}"));
            if let Some(repo) = state.repos.get(path) {
                lines.push(format!("top {}", repo.top));
                lines.push(format!("common {}", repo.common));
                lines.push(format!("gitdir {}", repo.gitdir));
                lines.push(format!("branch {}", repo.branch));
                lines.push(format!("remote {}", repo.remote));
            }
            lines.push(format!("{marker} end {index}"));
        }
        let stdout = format!("{}\n", lines.join("\n"));
        Box::pin(async move { Ok(ScriptOutput { code: 0, stdout }) })
    }
}

impl RecorderHost for FakeHerdr {
    fn herdr_call(
        &self,
        connection_id: &str,
        method: &str,
        _params: Value,
    ) -> BoxFuture<Result<Value, String>> {
        let mut state = self.state();
        state.calls.push(format!("{connection_id} {method}"));
        let result = match method {
            "workspace.list" => {
                Ok(json!({ "type": "workspace_list", "workspaces": state.workspaces.clone() }))
            }
            "pane.list" => Ok(json!({ "panes": state.panes.clone() })),
            other => Err(format!("unexpected {other}")),
        };
        Box::pin(async move { result })
    }

    fn owned_agents(&self, _connection_id: &str) -> BoxFuture<Vec<OwnedAgent>> {
        let owned = self.state().owned.clone();
        Box::pin(async move { owned })
    }
}

// --- The harness ---------------------------------------------------------

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    context: DataContext,
    clock: Arc<ManualClock>,
    herdr: FakeHerdr,
    recorder: ActivityRecorder,
}

fn settings(change: impl FnOnce(&mut ActivitySettings)) -> ActivitySettings {
    let mut settings = ActivitySettings {
        enabled: true,
        ..ActivitySettings::default()
    };
    change(&mut settings);
    settings
}

impl Harness {
    fn new(settings: ActivitySettings) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::Unix, None);
        let root = dir.path().join("roamgate");
        let clock = ManualClock::at(T0);
        let herdr = fake_herdr();
        let recorder = Self::open(&context, &root, &clock, &herdr, settings);
        Self {
            _dir: dir,
            root,
            context,
            clock,
            herdr,
            recorder,
        }
    }

    fn open(
        context: &DataContext,
        root: &Path,
        clock: &Arc<ManualClock>,
        herdr: &FakeHerdr,
        settings: ActivitySettings,
    ) -> ActivityRecorder {
        ActivityRecorder::start(RecorderOptions {
            settings,
            context: context.clone(),
            directory: root.to_path_buf(),
            host: Arc::new(herdr.clone()),
            clock: clock.clone(),
            logger: Logger::silent(),
        })
    }

    /// A recorder on the same log, as after a restart.
    fn reopen(&self, settings: ActivitySettings) -> ActivityRecorder {
        Self::open(
            &self.context,
            &self.root,
            &self.clock,
            &self.herdr,
            settings,
        )
    }

    async fn advance(&self, ms: i64) {
        self.clock.advance(ms).await;
    }
}

fn harness() -> Harness {
    Harness::new(settings(|_| {}))
}

fn presence_params(change: Value) -> Value {
    let mut params = json!({
        "client_id": "c1", "client_kind": "desktop", "workspace_id": "w1", "tab_id": "w1:t1",
        "pane_id": "w1:p1", "visible": true, "focused": true, "input_age_ms": 0, "cause": "user_input",
    });
    for (key, value) in change.as_object().unwrap() {
        params[key] = value.clone();
    }
    params
}

fn status_event(pane: &str, workspace: &str, status: &str, extra: Value) -> Value {
    let mut data = json!({
        "type": "pane_agent_status_changed", "pane_id": pane, "workspace_id": workspace,
        "agent_status": status, "agent": "claude",
    });
    for (key, value) in extra.as_object().unwrap() {
        data[key] = value.clone();
    }
    json!({ "event": "pane.agent_status_changed", "data": data })
}

fn w1() -> String {
    stable_workspace_id("local", "/src/roamgate")
}

fn w2() -> String {
    stable_workspace_id("local", "/src/gst")
}

fn ms(event: &Value) -> i64 {
    parse_time(event["ts"].as_str().unwrap()).unwrap()
}

async fn ready(recorder: &ActivityRecorder, connection: &str) {
    recorder.connection_status(connection, "ready", None);
    recorder.flush().await;
}

async fn report(recorder: &ActivityRecorder, socket: u64, fields: Value) -> Value {
    report_on(recorder, socket, fields, "local").await
}

async fn report_on(
    recorder: &ActivityRecorder,
    socket: u64,
    fields: Value,
    connection: &str,
) -> Value {
    let reply = recorder
        .presence(socket, connection, &presence_params(fields), None)
        .await
        .unwrap();
    recorder.flush().await;
    reply
}

async fn events(recorder: &ActivityRecorder) -> Vec<Value> {
    recorder.read_events().await
}

async fn agents(recorder: &ActivityRecorder) -> Vec<Value> {
    events(recorder)
        .await
        .into_iter()
        .filter(|e| e["kind"] == "agent.state")
        .collect()
}

fn source_of(event: &Value) -> Option<&str> {
    event.get("source").and_then(Value::as_str)
}

/// Attention events as (kind, ms since T0, detail) for compact checks.
async fn attention(recorder: &ActivityRecorder, source: &str) -> Vec<(String, i64, String)> {
    let (w1, w2) = (w1(), w2());
    events(recorder)
        .await
        .into_iter()
        .filter(|e| e["kind"] != "agent.state" && source_of(e).is_none_or(|s| s == source))
        .map(|e| {
            let kind = e["kind"].as_str().unwrap().to_owned();
            let detail = match kind.as_str() {
                "workspace.focus" => {
                    let workspace = e["workspace_id"].as_str().unwrap_or("");
                    let name = if workspace == w1 {
                        "W1"
                    } else if workspace == w2 {
                        "W2"
                    } else {
                        workspace
                    };
                    format!("{name} {}", e["pane_id"].as_str().unwrap_or("null"))
                }
                "workspace.blur" => e["reason"].as_str().unwrap_or("").to_owned(),
                "ui.visibility" => e["visible"].to_string(),
                "session.idle" => e["idle_after_seconds"].to_string(),
                _ => String::new(),
            };
            (kind, ms(&e) - T0, detail)
        })
        .collect()
}

type Caused = (String, i64, String, Value, Value);

/// Attention events with their cause and input age.
async fn caused(recorder: &ActivityRecorder, source: &str) -> Vec<Caused> {
    let rows = attention(recorder, source).await;
    let all: Vec<Value> = events(recorder)
        .await
        .into_iter()
        .filter(|e| e["kind"] != "agent.state" && source_of(e).is_none_or(|s| s == source))
        .collect();
    rows.into_iter()
        .zip(all)
        .map(|((kind, at, detail), event)| {
            (
                kind,
                at,
                detail,
                event.get("cause").cloned().unwrap_or(Value::Null),
                event.get("input_age_ms").cloned().unwrap_or(Value::Null),
            )
        })
        .collect()
}

fn row(kind: &str, at: i64, detail: &str) -> (String, i64, String) {
    (kind.into(), at, detail.into())
}

fn caused_row(kind: &str, at: i64, detail: &str, cause: Value, age: Value) -> Caused {
    (kind.into(), at, detail.into(), cause, age)
}

// --- The cases -----------------------------------------------------------

#[tokio::test]
async fn agent_states_are_recorded_once_per_change_with_done_as_idle() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({})),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({})),
        None,
    );
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "done", json!({})),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "idle", json!({})),
        None,
    );
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "blocked", json!({})),
        None,
    );
    recorder.flush().await;
    let agents = agents(recorder).await;
    let states: Vec<(String, i64)> = agents
        .iter()
        .map(|e| (e["agent"]["state"].as_str().unwrap().into(), ms(e) - T0))
        .collect();
    assert_eq!(
        states,
        vec![
            ("working".into(), 0),
            ("idle".into(), 1000),
            ("blocked".into(), 2000)
        ]
    );
    assert_eq!(agents[0]["connection_id"], "local");
    assert_eq!(agents[0]["workspace_id"], w1());
    assert_eq!(agents[0]["tab_id"], "w1:t1");
    assert_eq!(agents[0]["pane_id"], "w1:p1");
    assert_eq!(
        agents[0]["agent"],
        json!({"name": "claude", "state": "working", "task": null, "session_id": "s1"})
    );
    assert!(agents[0].get("source").is_none());
}

#[tokio::test]
async fn agent_titles_are_recorded_only_when_asked_for() {
    let h = Harness::new(settings(|s| s.record_agent_titles = true));
    ready(&h.recorder, "local").await;
    h.recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({"title": "Fix the bridge"})),
        None,
    );
    h.recorder.flush().await;
    assert_eq!(
        agents(&h.recorder).await[0]["agent"]["task"],
        "Fix the bridge"
    );
}

#[tokio::test]
async fn pane_listings_catch_missed_changes_but_never_undo_a_newer_event() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    let panes = |status: &str| {
        let list: Vec<Value> = h
            .herdr
            .state()
            .panes
            .iter()
            .map(|pane| {
                let mut pane = pane.clone();
                if pane["pane_id"] == "w1:p1" {
                    pane["agent_status"] = json!(status);
                }
                pane
            })
            .collect();
        json!({ "panes": list })
    };
    // The first listing is the baseline.
    recorder.pane_list("local", panes("working"), T0, None);
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "idle", json!({})),
        None,
    );
    // Started before that event: its "working" is stale.
    recorder.pane_list("local", panes("working"), T0 + 500, None);
    h.advance(SECOND).await;
    // Nothing changed: nothing recorded.
    recorder.pane_list("local", panes("done"), T0 + 2000, None);
    h.advance(SECOND).await;
    // A change the subscription missed.
    recorder.pane_list("local", panes("blocked"), T0 + 3000, None);
    h.advance(SECOND).await;
    // The pane went away.
    let rest: Vec<Value> = h
        .herdr
        .state()
        .panes
        .iter()
        .filter(|p| p["pane_id"] != "w1:p1")
        .cloned()
        .collect();
    recorder.pane_list("local", json!({ "panes": rest }), T0 + 4000, None);
    recorder.flush().await;
    let states: Vec<(String, i64)> = agents(recorder)
        .await
        .iter()
        .map(|e| (e["agent"]["state"].as_str().unwrap().into(), ms(e) - T0))
        .collect();
    assert_eq!(
        states,
        vec![
            ("working".into(), 0),
            ("idle".into(), 1000),
            ("blocked".into(), 3000),
            ("unknown".into(), 4000)
        ]
    );
}

#[tokio::test]
async fn an_agent_roamgate_runs_itself_is_recorded_as_roamgate_knows_it_not_as_herdr_says() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    h.herdr.state().owned = vec![
        OwnedAgent {
            pane_id: "w1:p1".into(),
            session_id: Some("s1".into()),
            agent_status: "idle".into(),
        },
        OwnedAgent {
            pane_id: "w1:p2".into(),
            session_id: Some("s2".into()),
            agent_status: "working".into(),
        },
    ];
    recorder.pane_list("local", h.herdr.panes(), T0, None);
    recorder.flush().await;
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({})),
        None,
    );
    recorder.flush().await;
    h.advance(SECOND).await;
    // A turn starts, then ends: conversation mode reports both.
    h.herdr.state().owned[0].agent_status = "working".into();
    recorder.owned_agent_changed("local", "w1:p1", None);
    recorder.flush().await;
    h.advance(60 * SECOND).await;
    h.herdr.state().owned[0].agent_status = "idle".into();
    recorder.owned_agent_changed("local", "w1:p1", None);
    recorder.flush().await;
    h.advance(SECOND).await;
    // Herdr's frozen working in the next listing changes nothing.
    recorder.pane_list("local", h.herdr.panes(), T0 + 63_000, None);
    recorder.flush().await;
    let got: Vec<(String, String, String, i64)> = agents(recorder)
        .await
        .iter()
        .map(|e| {
            (
                e["pane_id"].as_str().unwrap().into(),
                e["agent"]["state"].as_str().unwrap().into(),
                e["agent"]["session_id"].as_str().unwrap().into(),
                ms(e) - T0,
            )
        })
        .collect();
    let r = |p: &str, s: &str, id: &str, at: i64| (p.to_owned(), s.to_owned(), id.to_owned(), at);
    assert_eq!(
        got,
        vec![
            r("w1:p1", "idle", "s1", 0),
            r("w1:p2", "working", "s2", 0),
            r("w1:p1", "working", "s1", 2000),
            r("w1:p1", "idle", "s1", 62000)
        ]
    );
}

#[tokio::test]
async fn a_closed_panes_agent_ends_as_unknown_and_the_state_restarts_after_a_gap() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({})),
        None,
    );
    // Its workspace goes first: the agent still ends in it.
    recorder.herdr_event(
        "local",
        json!({"event": "workspace.closed", "data": {"workspace_id": "w1"}}),
        None,
    );
    recorder.herdr_event(
        "local",
        json!({"event": "pane.closed", "data": {"pane_id": "w1:p1", "workspace_id": "w1"}}),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p3", "w1", "working", json!({})),
        None,
    );
    recorder.connection_status("local", "reconnecting", None);
    recorder.connection_status("local", "ready", None);
    // The same state again after the gap is a new baseline.
    recorder.herdr_event(
        "local",
        status_event("w1:p3", "w1", "working", json!({})),
        None,
    );
    recorder.flush().await;
    let w1 = w1();
    let got: Vec<(String, String, bool)> = agents(recorder)
        .await
        .iter()
        .map(|e| {
            (
                e["pane_id"].as_str().unwrap().into(),
                e["agent"]["state"].as_str().unwrap().into(),
                e["workspace_id"] == w1.as_str(),
            )
        })
        .collect();
    let r = |p: &str, s: &str| (p.to_owned(), s.to_owned(), true);
    assert_eq!(
        got,
        vec![
            r("w1:p1", "working"),
            r("w1:p1", "unknown"),
            r("w1:p3", "working"),
            r("w1:p3", "working")
        ]
    );
}

#[tokio::test]
async fn unknown_is_recorded_once_and_not_for_an_agent_never_seen_in_a_state() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    recorder.herdr_event(
        "local",
        status_event("w1:p3", "w1", "unknown", json!({})),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "idle", json!({})),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "unknown", json!({})),
        None,
    );
    // Herdr releases the agent, then still reports it unknown.
    recorder.herdr_event(
        "local",
        json!({"event": "pane.agent_detected", "data": {"pane_id": "w1:p1", "workspace_id": "w1", "agent": null}}),
        None,
    );
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "unknown", json!({})),
        None,
    );
    recorder.flush().await;
    let got: Vec<(String, String)> = agents(recorder)
        .await
        .iter()
        .map(|e| {
            (
                e["pane_id"].as_str().unwrap().into(),
                e["agent"]["state"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("w1:p1".into(), "idle".into()),
            ("w1:p1".into(), "unknown".into())
        ]
    );
}

async fn gaps(recorder: &ActivityRecorder) -> Vec<Value> {
    recorder
        .inspect(|store| store.map(|s| s.read_gaps().unwrap()).unwrap_or_default())
        .await
        .unwrap()
}

fn offset(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |text| json!(parse_time(text).unwrap() - T0))
}

#[tokio::test]
async fn connection_gaps_cover_the_periods_a_connection_was_not_ready() {
    let h = harness();
    let recorder = &h.recorder;
    recorder.connection_status("local", "disconnected", None);
    recorder.connection_status("local", "connecting", None);
    h.advance(5 * SECOND).await;
    ready(recorder, "local").await;
    report(recorder, 1, json!({})).await;
    h.advance(60 * SECOND).await;
    recorder.connection_status("local", "error", None);
    recorder.connection_status("local", "reconnecting", None);
    h.advance(30 * SECOND).await;
    ready(recorder, "local").await;
    let got: Vec<Value> = gaps(recorder)
        .await
        .iter()
        .map(|g| {
            json!([
                g["connection_id"],
                offset(&g["start"]),
                offset(&g["end"]),
                g["reason"],
                g["excluded"]
            ])
        })
        .collect();
    assert_eq!(
        got,
        vec![
            json!(["local", 0, 5000, "disconnected", false]),
            json!(["local", 65_000, 95_000, "error", false])
        ]
    );
    let all = events(recorder).await;
    let blurs: Vec<Value> = all
        .iter()
        .filter(|e| e["kind"] == "workspace.blur")
        .map(|e| json!([e["source"], e["reason"], ms(e) - T0]))
        .collect();
    assert_eq!(
        blurs,
        vec![
            json!(["browser", "disconnect", 65_000]),
            json!(["herdr", "disconnect", 65_000])
        ]
    );
    // Herdr's focus is followed again once the connection is back.
    let focus: Vec<Value> = all
        .iter()
        .filter(|e| e["kind"] == "workspace.focus" && source_of(e) == Some("herdr"))
        .map(|e| json!([ms(e) - T0, e["open"]]))
        .collect();
    assert_eq!(focus, vec![json!([5000, false]), json!([95_000, true])]);
}

#[tokio::test]
async fn presence_becomes_focus_spans_that_end_on_a_switch_or_when_hidden() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    assert_eq!(
        report(recorder, 1, json!({})).await,
        json!({"recording": true, "idle_seconds": 300, "attention": true})
    );
    h.advance(10 * SECOND).await;
    // The same place again: nothing new.
    report(recorder, 1, json!({"input_age_ms": 10_000})).await;
    report(recorder, 1, json!({"pane_id": "w1:p2"})).await;
    h.advance(10 * SECOND).await;
    let w2 = json!({"workspace_id": "w2", "tab_id": "w2:t1", "pane_id": "w2:p1"});
    let with = |extra: Value| {
        let mut value = w2.clone();
        for (key, field) in extra.as_object().unwrap() {
            value[key] = field.clone();
        }
        value
    };
    report(recorder, 1, w2.clone()).await;
    h.advance(10 * SECOND).await;
    report(recorder, 1, with(json!({"visible": false}))).await;
    h.advance(10 * SECOND).await;
    report(recorder, 1, w2.clone()).await;
    h.advance(10 * SECOND).await;
    // Another application has the focus: as good as hidden.
    report(recorder, 1, with(json!({"focused": false}))).await;
    h.advance(10 * SECOND).await;
    report(recorder, 1, w2.clone()).await;
    h.advance(10 * SECOND).await;
    // No workspace on screen (no layout yet).
    report(
        recorder,
        1,
        json!({"workspace_id": null, "tab_id": null, "pane_id": null}),
    )
    .await;
    assert_eq!(
        attention(recorder, "browser").await,
        vec![
            row("ui.visibility", 0, "true"),
            row("workspace.focus", 0, "W1 w1:p1"),
            row("workspace.blur", 10_000, "switch"),
            row("workspace.focus", 10_000, "W1 w1:p2"),
            row("workspace.blur", 20_000, "switch"),
            row("workspace.focus", 20_000, "W2 w2:p1"),
            row("ui.visibility", 30_000, "false"),
            row("workspace.blur", 30_000, "hidden"),
            row("ui.visibility", 40_000, "true"),
            row("workspace.focus", 40_000, "W2 w2:p1"),
            row("ui.visibility", 50_000, "false"),
            row("workspace.blur", 50_000, "hidden"),
            row("ui.visibility", 60_000, "true"),
            row("workspace.focus", 60_000, "W2 w2:p1"),
            row("workspace.blur", 70_000, "switch"),
        ]
    );
    let all = events(recorder).await;
    let focus = all
        .iter()
        .find(|e| e["kind"] == "workspace.focus" && source_of(e) == Some("browser"))
        .unwrap();
    assert_eq!(focus["connection_id"], "local");
    assert_eq!(focus["tab_id"], "w1:t1");
    assert_eq!(focus["client"], json!({"id": "c1", "kind": "desktop"}));
    assert_eq!(focus["source"], "browser");
    assert_eq!(focus["open"], false);
}

#[tokio::test]
async fn a_page_that_loads_is_no_attention_until_an_input_follows() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    let loaded = report(
        recorder,
        1,
        json!({"input_age_ms": null, "cause": "page_load"}),
    )
    .await;
    assert_eq!(loaded["attention"], false);
    h.advance(60 * SECOND).await;
    report(
        recorder,
        1,
        json!({"input_age_ms": null, "cause": "repeat"}),
    )
    .await;
    h.advance(SECOND).await;
    let typed = report(
        recorder,
        1,
        json!({"input_age_ms": 0, "cause": "user_input"}),
    )
    .await;
    assert_eq!(typed["attention"], true);
    assert_eq!(
        caused(recorder, "browser").await,
        vec![
            caused_row("ui.visibility", 0, "true", json!("page_load"), Value::Null),
            caused_row(
                "workspace.focus",
                61_000,
                "W1 w1:p1",
                json!("user_input"),
                json!(0)
            ),
        ]
    );
}

#[tokio::test]
async fn a_page_reconnecting_to_a_restarted_bridge_is_no_attention_until_an_input_after_it() {
    let h = harness();
    ready(&h.recorder, "local").await;
    report(&h.recorder, 1, json!({})).await;
    h.advance(10 * SECOND).await;
    h.recorder.stop().await;
    // The bridge restarts; the page reconnects on a new socket and reports
    // its input of 20 s ago, before the restart.
    h.advance(SECOND).await;
    let recorder = h.reopen(settings(|_| {}));
    ready(&recorder, "local").await;
    h.advance(2 * SECOND).await;
    let again = report(
        &recorder,
        2,
        json!({"input_age_ms": 20 * SECOND, "cause": "repeat"}),
    )
    .await;
    assert_eq!(again["attention"], false);
    // Brought to the front without input: the page counts it as input.
    h.advance(3 * SECOND).await;
    report(
        &recorder,
        2,
        json!({"input_age_ms": 0, "cause": "user_focus"}),
    )
    .await;
    let rows = caused(&recorder, "browser").await;
    let late: Vec<Caused> = rows.iter().filter(|r| r.1 >= 13_000).cloned().collect();
    assert_eq!(
        late,
        vec![
            caused_row(
                "ui.visibility",
                13_000,
                "true",
                json!("reconnect"),
                json!(20_000)
            ),
            caused_row(
                "workspace.focus",
                16_000,
                "W1 w1:p1",
                json!("user_focus"),
                json!(0)
            ),
        ]
    );
    // The restart's rows are no person: recorder_stop, no cause.
    let restart: Vec<Caused> = rows.into_iter().filter(|r| r.1 == 10_000).collect();
    assert_eq!(
        restart,
        vec![
            caused_row(
                "workspace.blur",
                10_000,
                "recorder_stop",
                Value::Null,
                Value::Null
            ),
            caused_row("ui.visibility", 10_000, "false", Value::Null, Value::Null),
        ]
    );
}

#[tokio::test]
async fn a_view_that_follows_herdr_or_moves_by_itself_ends_the_span_and_opens_none() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    report(recorder, 1, json!({})).await;
    h.advance(10 * SECOND).await;
    let w2 = |extra: Value| {
        let mut value = json!({"workspace_id": "w2", "tab_id": "w2:t1", "pane_id": "w2:p1"});
        for (key, field) in extra.as_object().unwrap() {
            value[key] = field.clone();
        }
        value
    };
    let followed = report(
        recorder,
        1,
        w2(json!({"input_age_ms": 10 * SECOND, "cause": "follow_herdr"})),
    )
    .await;
    assert_eq!(followed["attention"], false);
    h.advance(10 * SECOND).await;
    // Reading on without input: still not attention.
    report(
        recorder,
        1,
        w2(json!({"input_age_ms": 20 * SECOND, "cause": "repeat"})),
    )
    .await;
    h.advance(SECOND).await;
    report(recorder, 1, w2(json!({"input_age_ms": 0}))).await;
    h.advance(10 * SECOND).await;
    report(
        recorder,
        1,
        json!({"input_age_ms": 9 * SECOND, "cause": "app"}),
    )
    .await;
    assert_eq!(
        caused(recorder, "browser").await,
        vec![
            caused_row("ui.visibility", 0, "true", json!("user_input"), json!(0)),
            caused_row(
                "workspace.focus",
                0,
                "W1 w1:p1",
                json!("user_input"),
                json!(0)
            ),
            caused_row(
                "workspace.blur",
                10_000,
                "switch",
                json!("follow_herdr"),
                json!(10_000)
            ),
            caused_row(
                "workspace.focus",
                21_000,
                "W2 w2:p1",
                json!("user_input"),
                json!(0)
            ),
            caused_row(
                "workspace.blur",
                31_000,
                "switch",
                json!("app"),
                json!(9_000)
            ),
        ]
    );
}

#[tokio::test]
async fn input_after_idle_is_session_active_caused_by_input() {
    let h = Harness::new(settings(|s| s.idle_seconds = 60));
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    report(recorder, 1, json!({})).await;
    h.advance(70 * SECOND).await;
    report(
        recorder,
        1,
        json!({"input_age_ms": 70 * SECOND, "cause": "repeat"}),
    )
    .await;
    h.advance(SECOND).await;
    report(recorder, 1, json!({"input_age_ms": 0})).await;
    let all = events(recorder).await;
    let active = all.iter().find(|e| e["kind"] == "session.active").unwrap();
    assert_eq!(
        (active["cause"].clone(), active["input_age_ms"].clone()),
        (json!("user_input"), json!(0))
    );
}

#[tokio::test]
async fn herdrs_focus_says_where_it_came_from_start_event_listing_reconnect() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        json!({"event": "workspace.focused", "data": {"workspace_id": "w2"}}),
        None,
    );
    recorder.flush().await;
    h.advance(SECOND).await;
    // Herdr's focus moves without an event (a browser focused its pane),
    // found by the listing a browser report needs.
    for workspace in h.herdr.state().workspaces.iter_mut() {
        let focused = workspace["workspace_id"] == "w1";
        workspace["focused"] = json!(focused);
    }
    recorder.herdr_event(
        "local",
        json!({"event": "workspace.updated", "data": {"workspace_id": "w1"}}),
        None,
    );
    report(recorder, 1, json!({})).await;
    h.advance(SECOND).await;
    recorder.connection_status("local", "reconnecting", None);
    recorder.connection_status("local", "ready", None);
    recorder.flush().await;
    let rows: Vec<Caused> = caused(recorder, "herdr")
        .await
        .into_iter()
        .filter(|r| r.0 != "ui.visibility")
        .collect();
    assert_eq!(
        rows,
        vec![
            caused_row(
                "workspace.focus",
                0,
                "W1 w1:p1",
                json!("recorder_start"),
                Value::Null
            ),
            caused_row(
                "workspace.blur",
                1000,
                "switch",
                json!("herdr_event"),
                Value::Null
            ),
            caused_row(
                "workspace.focus",
                1000,
                "W2 null",
                json!("herdr_event"),
                Value::Null
            ),
            caused_row(
                "workspace.blur",
                2000,
                "switch",
                json!("herdr_listing"),
                Value::Null
            ),
            caused_row(
                "workspace.focus",
                2000,
                "W1 w1:p1",
                json!("herdr_listing"),
                Value::Null
            ),
            caused_row(
                "workspace.blur",
                3000,
                "disconnect",
                Value::Null,
                Value::Null
            ),
            caused_row(
                "workspace.focus",
                3000,
                "W1 w1:p1",
                json!("connection_ready"),
                Value::Null
            ),
        ]
    );
}

#[tokio::test]
async fn herdrs_focus_at_a_recorder_start_is_recorder_start_never_null() {
    let h = harness();
    ready(&h.recorder, "local").await;
    h.recorder.stop().await;
    h.advance(SECOND).await;
    let recorder = h.reopen(settings(|_| {}));
    ready(&recorder, "local").await;
    let causes: Vec<Value> = events(&recorder)
        .await
        .iter()
        .filter(|e| e["kind"] == "workspace.focus" && source_of(e) == Some("herdr"))
        .map(|e| e["cause"].clone())
        .collect();
    assert_eq!(
        causes,
        vec![json!("recorder_start"), json!("recorder_start")]
    );
}

#[tokio::test]
async fn reading_counts_as_attention_until_the_idle_threshold() {
    let h = Harness::new(settings(|s| s.idle_seconds = 120));
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    assert_eq!(report(recorder, 1, json!({})).await["idle_seconds"], 120);
    h.advance(60 * SECOND).await;
    report(recorder, 1, json!({"input_age_ms": 60_000})).await;
    h.advance(60 * SECOND).await;
    // The browser says so as the threshold passes.
    report(recorder, 1, json!({"input_age_ms": 120_000})).await;
    h.advance(100 * SECOND).await;
    // Input again.
    report(recorder, 1, json!({"input_age_ms": 0})).await;
    h.advance(140 * SECOND).await;
    // A report that comes late still ends the span at the threshold.
    report(recorder, 1, json!({"input_age_ms": 140_000})).await;
    assert_eq!(
        attention(recorder, "browser").await,
        vec![
            row("ui.visibility", 0, "true"),
            row("workspace.focus", 0, "W1 w1:p1"),
            row("workspace.blur", 120_000, "idle"),
            row("session.idle", 120_000, "120"),
            row("session.active", 220_000, ""),
            row("workspace.focus", 220_000, "W1 w1:p1"),
            row("workspace.blur", 340_000, "idle"),
            row("session.idle", 340_000, "120"),
        ]
    );
}

#[tokio::test]
async fn a_span_ends_with_timeout_when_the_reports_stop() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    report(recorder, 1, json!({})).await;
    h.advance(60 * SECOND).await;
    report(recorder, 1, json!({"input_age_ms": 1000})).await;
    h.advance(PRESENCE_TIMEOUT_MS - 1).await;
    recorder.flush().await;
    assert_eq!(
        attention(recorder, "browser").await.last().unwrap().0,
        "workspace.focus"
    );
    h.advance(1).await;
    recorder.flush().await;
    // Nothing is known after the last report.
    let rows = attention(recorder, "browser").await;
    assert_eq!(
        rows[rows.len() - 2..],
        [
            row("workspace.blur", 60_000, "timeout"),
            row("ui.visibility", 60_000, "false")
        ]
    );
    h.advance(10 * SECOND).await;
    report(recorder, 1, json!({})).await;
    let rows = attention(recorder, "browser").await;
    assert_eq!(
        rows[rows.len() - 2..],
        [
            row("ui.visibility", 220_000, "true"),
            row("workspace.focus", 220_000, "W1 w1:p1")
        ]
    );
}

#[tokio::test]
async fn a_span_ends_at_once_when_the_socket_closes() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    report(recorder, 1, json!({})).await;
    h.advance(5 * SECOND).await;
    recorder.socket_closed(1, None);
    recorder.flush().await;
    let rows = attention(recorder, "browser").await;
    assert_eq!(
        rows[rows.len() - 2..],
        [
            row("workspace.blur", 5000, "disconnect"),
            row("ui.visibility", 5000, "false")
        ]
    );
    // No timeout follows for a closed socket.
    h.advance(PRESENCE_TIMEOUT_MS).await;
    recorder.flush().await;
    assert_eq!(attention(recorder, "browser").await.len(), 4);
}

#[tokio::test]
async fn a_browser_moving_to_another_connection_switches_and_phones_count() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    ready(recorder, "remote").await;
    report(recorder, 1, json!({"client_kind": "phone"})).await;
    h.advance(5 * SECOND).await;
    report_on(recorder, 1, json!({"client_kind": "phone"}), "remote").await;
    let browser: Vec<Value> = events(recorder)
        .await
        .into_iter()
        .filter(|e| source_of(e) != Some("herdr") && e["kind"] != "agent.state")
        .collect();
    let got: Vec<Value> = browser
        .iter()
        .map(|e| {
            json!([
                e["kind"],
                e["connection_id"],
                e.get("reason")
                    .or(e.get("visible"))
                    .cloned()
                    .unwrap_or(Value::Null)
            ])
        })
        .collect();
    assert_eq!(
        got,
        vec![
            json!(["ui.visibility", "local", true]),
            json!(["workspace.focus", "local", null]),
            json!(["workspace.blur", "local", "switch"]),
            json!(["ui.visibility", "local", false]),
            json!(["ui.visibility", "remote", true]),
            json!(["workspace.focus", "remote", null]),
        ]
    );
    let last = browser.last().unwrap();
    assert_eq!(
        last["workspace_id"],
        stable_workspace_id("remote", "/src/roamgate")
    );
    assert_eq!(last["client"], json!({"id": "c1", "kind": "phone"}));
}

#[tokio::test]
async fn herdrs_own_focus_is_a_low_confidence_span_of_its_own() {
    let h = harness();
    let recorder = &h.recorder;
    ready(recorder, "local").await;
    h.advance(SECOND).await;
    recorder.herdr_event(
        "local",
        json!({"event": "pane.focused", "data": {"pane_id": "w1:p2", "workspace_id": "w1"}}),
        None,
    );
    recorder.herdr_event(
        "local",
        json!({"event": "workspace.focused", "data": {"workspace_id": "w2"}}),
        None,
    );
    recorder.flush().await;
    assert_eq!(
        attention(recorder, "herdr").await,
        vec![
            row("workspace.focus", 0, "W1 w1:p1"),
            row("workspace.blur", 1000, "switch"),
            row("workspace.focus", 1000, "W2 null")
        ]
    );
    let all = events(recorder).await;
    assert!(all.iter().all(|e| e["client"].is_null()));
    assert!(all.iter().all(|e| source_of(e) == Some("herdr")));
}

#[tokio::test]
async fn a_stop_ends_every_span_a_restart_closes_a_crashed_recorders_at_its_last_sign_of_life() {
    let h = harness();
    let first = &h.recorder;
    ready(first, "local").await;
    first.connection_status("remote", "error", None);
    report(first, 1, json!({})).await;
    h.advance(140 * SECOND).await;
    first.flush().await;
    // Gone without a stop: its alive stamp is from T0 + 120 s.
    h.clock.clear();
    first.abandon();
    ManualClock::settle().await;
    h.clock.set(T0 + 600_000);
    let second = h.reopen(settings(|_| {}));
    assert!(second.ready().await);
    let recovered: Vec<Value> = events(&second)
        .await
        .into_iter()
        .filter(|e| ms(e) == T0 + 120_000)
        .map(|e| {
            json!([
                e["kind"],
                e.get("source").cloned().unwrap_or(Value::Null),
                e.get("reason")
                    .or(e.get("visible"))
                    .cloned()
                    .unwrap_or(Value::Null)
            ])
        })
        .collect();
    assert_eq!(
        recovered,
        vec![
            json!(["workspace.blur", "herdr", "recorder_stop"]),
            json!(["workspace.blur", "browser", "recorder_stop"]),
            json!(["ui.visibility", null, false]),
        ]
    );
    assert!(!events(&second).await.iter().any(|e| e["open"] == true));
    let gap_rows = |gaps: Vec<Value>| -> Vec<Value> {
        gaps.iter()
            .map(|g| {
                json!([
                    g["connection_id"],
                    offset(&g["start"]),
                    offset(&g["end"]),
                    g["reason"]
                ])
            })
            .collect()
    };
    assert_eq!(
        gap_rows(gaps(&second).await),
        vec![
            json!(["remote", 0, 120_000, "error"]),
            json!([null, 120_000, 600_000, "recorder"])
        ]
    );
    // A clean stop: the next start records the time in between too.
    ready(&second, "local").await;
    report(&second, 2, json!({})).await;
    h.advance(100 * SECOND).await;
    second.stop().await;
    h.clock.set(T0 + 1_000_000);
    let third = h.reopen(settings(|_| {}));
    third.ready().await;
    let blurs: Vec<Value> = events(&third)
        .await
        .into_iter()
        .filter(|e| e["kind"] == "workspace.blur" && ms(e) == T0 + 700_000)
        .map(|e| json!([e["source"], e["reason"]]))
        .collect();
    assert_eq!(
        blurs,
        vec![
            json!(["browser", "recorder_stop"]),
            json!(["herdr", "recorder_stop"])
        ]
    );
    let recorder_gaps: Vec<Value> = gaps(&third)
        .await
        .into_iter()
        .filter(|g| g["connection_id"].is_null())
        .map(|g| json!([offset(&g["start"]), offset(&g["end"])]))
        .collect();
    assert_eq!(
        recorder_gaps,
        vec![json!([120_000, 600_000]), json!([700_000, 1_000_000])]
    );
}

#[tokio::test]
async fn events_past_the_retention_period_are_deleted_every_day() {
    let h = Harness::new(settings(|s| s.retention_days = 90));
    let recorder = &h.recorder;
    recorder.ready().await;
    recorder
        .inspect(|store| {
            let store = store.unwrap();
            let agent = |ts| NewEvent {
                ts,
                kind: "agent.state",
                connection_id: "local".into(),
                session: 1,
                agent: Some(AgentFields {
                    name: "claude".into(),
                    state: "idle",
                    task: None,
                    session_id: None,
                }),
                ..Default::default()
            };
            store.append(&agent(T0 - 91 * DAY)).unwrap();
            store.append(&agent(T0 - 80 * DAY)).unwrap();
            store
                .add_gap(Some("local"), T0 - 100 * DAY, T0 - 95 * DAY, "error")
                .unwrap();
            store
                .upsert_workspace(&WorkspaceRow {
                    id: "ws_old".into(),
                    connection_id: "local".into(),
                    name: "old".into(),
                    path: Some("/old".into()),
                    herdr_workspace_id: Some("w9".into()),
                    repo_root: None,
                    repo_is_worktree: None,
                    seen_at: T0 - 100 * DAY,
                })
                .unwrap();
        })
        .await;
    h.advance(DAY).await;
    recorder.flush().await;
    let times: Vec<i64> = events(recorder).await.iter().map(ms).collect();
    assert_eq!(times, vec![T0 - 80 * DAY]);
    assert!(gaps(recorder).await.is_empty());
    let workspaces = recorder
        .inspect(|store| store.unwrap().read_workspaces().unwrap())
        .await
        .unwrap();
    assert!(workspaces.is_empty());
}

#[tokio::test]
async fn with_recording_off_nothing_is_recorded_not_even_a_file() {
    let h = Harness::new(settings(|s| s.enabled = false));
    let recorder = &h.recorder;
    assert!(!recorder.ready().await);
    recorder.connection_status("local", "ready", None);
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "working", json!({})),
        None,
    );
    recorder.pane_list("local", h.herdr.panes(), T0, None);
    assert_eq!(
        recorder
            .presence(1, "local", &presence_params(json!({})), None)
            .await
            .unwrap(),
        json!({"recording": false, "idle_seconds": 300, "attention": false})
    );
    recorder.socket_closed(1, None);
    recorder.flush().await;
    recorder.stop().await;
    assert!(
        recorder
            .inspect(|store| store.is_none())
            .await
            .unwrap_or(true)
    );
    assert!(h.herdr.state().calls.is_empty());
    assert!(!h.root.exists());
}

#[test]
fn presence_reports_are_checked() {
    let base = presence_params(json!({}));
    let with = |key: &str, value: Value| {
        let mut params = base.clone();
        params[key] = value;
        params
    };
    assert_eq!(
        parse_presence(&Value::Null).unwrap_err(),
        "invalid presence"
    );
    assert_eq!(
        parse_presence(&with("client_id", json!("a b"))).unwrap_err(),
        "invalid client_id"
    );
    assert_eq!(
        parse_presence(&with("client_kind", json!("tv"))).unwrap_err(),
        "invalid client_kind"
    );
    assert_eq!(
        parse_presence(&with("visible", json!("yes"))).unwrap_err(),
        "invalid visibility"
    );
    assert_eq!(
        parse_presence(&with("input_age_ms", json!(-1))).unwrap_err(),
        "invalid input_age_ms"
    );
    assert_eq!(
        parse_presence(&with("cause", json!("agent"))).unwrap_err(),
        "invalid cause"
    );
    let parsed = parse_presence(&with("input_age_ms", Value::Null)).unwrap();
    assert_eq!(
        (parsed.input_age_ms, parsed.cause.as_deref()),
        (None, Some("user_input"))
    );
    // Pages older than causes send none.
    let mut old = base.clone();
    old.as_object_mut().unwrap().remove("cause");
    assert_eq!(parse_presence(&old).unwrap().cause, None);
    assert_eq!(
        parse_presence(&with("pane_id", json!("x".repeat(200)))).unwrap_err(),
        "invalid pane_id"
    );
    assert_eq!(
        parse_presence(&with("input_age_ms", json!(1e15)))
            .unwrap()
            .input_age_ms,
        Some(DAY as f64)
    );
}

/// The JSON Schema subset docs/activity.schema.json uses; the errors.
fn validate(value: &Value, schema: &Value, defs: &Value, path: &str) -> Vec<String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let name = reference.trim_start_matches("#/$defs/");
        return match defs.get(name) {
            Some(target) => validate(value, target, defs, path),
            None => vec![format!("{path}: unknown $ref {reference}")],
        };
    }
    if let Some(options) = schema.get("anyOf").and_then(Value::as_array) {
        return if options
            .iter()
            .any(|option| validate(value, option, defs, path).is_empty())
        {
            Vec::new()
        } else {
            vec![format!("{path}: matches no anyOf option: {value}")]
        };
    }
    let mut errors = Vec::new();
    if let Some(kind) = schema.get("type") {
        let types: Vec<&str> = match kind {
            Value::Array(list) => list.iter().filter_map(Value::as_str).collect(),
            other => other.as_str().into_iter().collect(),
        };
        let actual = match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Number(n) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => "integer",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Bool(_) => "boolean",
            Value::Object(_) => "object",
        };
        if !types.contains(&actual) && !(actual == "integer" && types.contains(&"number")) {
            return vec![format!("{path}: {actual} is not {}", types.join("|"))];
        }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        errors.push(format!("{path}: {value} not in enum"));
    }
    if let Some(constant) = schema.get("const")
        && constant != value
    {
        errors.push(format!("{path}: not {constant}"));
    }
    if schema.get("format").and_then(Value::as_str) == Some("date-time") {
        let shape =
            Regex::new(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$").unwrap();
        if !value
            .as_str()
            .is_some_and(|text| shape.is_match(text) && parse_time(text).is_some())
        {
            errors.push(format!("{path}: not a date-time"));
        }
    }
    if let Some(object) = value.as_object() {
        for key in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(key) {
                errors.push(format!("{path}: missing {key}"));
            }
        }
        let empty = Map::new();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        for (key, child) in object {
            match properties.get(key) {
                Some(property) => {
                    errors.extend(validate(child, property, defs, &format!("{path}.{key}")))
                }
                // Fields the protocol does not know would be a protocol change.
                None => errors.push(format!("{path}: unknown field {key}")),
            }
        }
    }
    if let (Some(items), Some(schema)) = (value.as_array(), schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            errors.extend(validate(item, schema, defs, &format!("{path}[{index}]")));
        }
    }
    errors
}

#[tokio::test]
async fn stored_events_workspaces_and_a_page_conform_to_activity_schema_json() {
    let text = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/activity.schema.json"),
    )
    .unwrap();
    let protocol: Value = serde_json::from_str(&text).unwrap();
    let defs = &protocol["$defs"];
    let check = |value: &Value, name: &str| {
        validate(
            value,
            &json!({"$ref": format!("#/$defs/{name}")}),
            defs,
            "$",
        )
    };
    let h = Harness::new(settings(|s| s.record_agent_titles = true));
    let recorder = &h.recorder;
    recorder.connection_status("local", "disconnected", None);
    ready(recorder, "local").await;
    recorder.herdr_event(
        "local",
        status_event("w1:p1", "w1", "done", json!({"title": "Fix the bridge"})),
        None,
    );
    report(recorder, 1, json!({"client_kind": "phone"})).await;
    h.advance(10 * SECOND).await;
    report(recorder, 1, json!({"client_kind": "phone", "workspace_id": "w2", "tab_id": "w2:t1", "pane_id": "w2:p1"})).await;
    h.advance(300 * SECOND).await;
    report(
        recorder,
        1,
        json!({"client_kind": "phone", "input_age_ms": 300_000}),
    )
    .await;
    report(recorder, 1, json!({"client_kind": "phone"})).await;
    report(
        recorder,
        1,
        json!({"client_kind": "phone", "visible": false}),
    )
    .await;
    recorder.socket_closed(1, None);
    recorder.flush().await;
    let all = events(recorder).await;
    let kinds: HashSet<String> = all
        .iter()
        .map(|e| e["kind"].as_str().unwrap().to_owned())
        .collect();
    let expected: HashSet<String> = defs["EventKind"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(kinds, expected);
    for event in &all {
        assert_eq!(check(event, "Event"), Vec::<String>::new(), "{event}");
    }
    let workspaces = recorder
        .inspect(|store| store.unwrap().read_workspaces().unwrap())
        .await
        .unwrap();
    let mut names: Vec<Value> = workspaces
        .iter()
        .map(|w| json!([w["name"], w["path"], w["repo"]["root"]]))
        .collect();
    names.sort_by_key(|n| n[0].as_str().unwrap().to_owned());
    assert_eq!(
        names,
        vec![
            json!(["gst", "/src/gst", null]),
            json!(["roamgate", "/src/roamgate", "/src/roamgate"])
        ]
    );
    for workspace in &workspaces {
        assert_eq!(check(workspace, "Workspace"), Vec::<String>::new());
    }
    // With subjects, both sources.
    let tree = Tree::parse(&json!({"version": 1, "nodes": [
        {"id": "g1", "kind": "group", "parent": null, "label": "upstream"},
        {"id": "g2", "kind": "group", "parent": "g1", "label": "ocio"},
        {"id": "w1", "kind": "workspace", "parent": "g2", "ref": {"connection_id": "local", "path": "/src/gst"}},
    ]}));
    let subjects = SubjectResolver::new(&["/src".into()], Some(tree), None);
    let with_subject = subjects.with_subjects(workspaces.clone());
    let mut sources: Vec<String> = with_subject
        .iter()
        .map(|w| w["subject"]["source"].as_str().unwrap().to_owned())
        .collect();
    sources.sort();
    assert_eq!(sources, ["directory", "explicit"]);
    for workspace in &with_subject {
        assert_eq!(check(workspace, "Workspace"), Vec::<String>::new());
    }
    let _ = SubjectWorkspace::of(&with_subject[0]);
    let mut wrong = with_subject[0].clone();
    wrong["subject"] = json!({"id": "x", "label": "x", "source": "repo", "groups": []});
    assert!(!check(&wrong, "Workspace").is_empty());
    assert_eq!(
        check(
            &json!({"events": all, "workspaces": workspaces, "next_cursor": null}),
            "ActivityPage"
        ),
        Vec::<String>::new()
    );
    // Ids are opaque strings that sort the way the log is ordered.
    let mut ids: Vec<String> = all
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    let mut by_number = ids.clone();
    by_number.sort_by_key(|id| id.parse::<i64>().unwrap());
    ids.sort();
    assert_eq!(ids, by_number);
    let mut bored = all[0].clone();
    bored["reason"] = json!("bored");
    assert!(!check(&bored, "Event").is_empty());
}

fn repo(
    top: &'static str,
    common: &'static str,
    gitdir: &'static str,
    branch: &'static str,
    remote: &'static str,
) -> Repo {
    Repo {
        top,
        common,
        gitdir,
        branch,
        remote,
    }
}

#[tokio::test]
async fn branches_and_remotes_are_read_from_the_host_now_and_then_and_kept() {
    let h = harness();
    let recorder = &h.recorder;
    h.herdr.state().repos.insert(
        "/src/roamgate".into(),
        repo(
            "/src/roamgate",
            "/src/roamgate/.git",
            "/src/roamgate/.git",
            "main",
            "https://u:token@example.com/roamgate.git",
        ),
    );
    h.herdr.state().repos.insert(
        "/src/gst".into(),
        repo(
            "/src/gst",
            "/src/gstreamer/.git",
            "/src/gstreamer/.git/worktrees/gst",
            "ocio",
            "git@example.com:gst/gstreamer.git",
        ),
    );
    ready(recorder, "local").await;
    let by_name = || async {
        let workspaces = recorder
            .inspect(|store| store.unwrap().read_workspaces().unwrap())
            .await
            .unwrap();
        workspaces
            .into_iter()
            .map(|w| (w["name"].as_str().unwrap().to_owned(), w["repo"].clone()))
            .collect::<HashMap<_, _>>()
    };
    let repos = by_name().await;
    assert_eq!(
        repos["roamgate"],
        json!({"root": "/src/roamgate", "remote_url": "https://example.com/roamgate.git", "branch": "main", "is_worktree": false})
    );
    assert_eq!(
        repos["gst"],
        json!({"root": "/src/gstreamer", "remote_url": "git@example.com:gst/gstreamer.git", "branch": "ocio", "is_worktree": true})
    );
    assert_eq!(h.herdr.state().host_scripts.len(), 1);
    // Herdr listing again keeps what git said; the branch is not read again soon.
    h.herdr
        .state()
        .repos
        .get_mut("/src/roamgate")
        .unwrap()
        .branch = "next";
    recorder.pane_list("local", h.herdr.panes(), h.clock.now(), None);
    recorder.flush().await;
    assert_eq!(h.herdr.state().host_scripts.len(), 1);
    assert_eq!(by_name().await["roamgate"]["branch"], "main");
    h.advance(10 * 60 * SECOND).await;
    recorder.pane_list("local", h.herdr.panes(), h.clock.now(), None);
    recorder.flush().await;
    assert_eq!(h.herdr.state().host_scripts.len(), 2);
    assert_eq!(by_name().await["roamgate"]["branch"], "next");
    assert_eq!(by_name().await["roamgate"]["root"], "/src/roamgate");
}

#[tokio::test]
async fn a_failing_host_read_leaves_the_log_as_herdr_says() {
    let h = harness();
    h.herdr.state().repos.insert(
        "/src/roamgate".into(),
        repo(
            "/src/roamgate",
            "/src/roamgate/.git",
            "/src/roamgate/.git",
            "main",
            "x",
        ),
    );
    h.herdr.state().host_fails = true;
    ready(&h.recorder, "local").await;
    let workspaces = h
        .recorder
        .inspect(|store| store.unwrap().read_workspaces().unwrap())
        .await
        .unwrap();
    let roamgate = workspaces.iter().find(|w| w["name"] == "roamgate").unwrap();
    assert_eq!(
        roamgate["repo"],
        json!({"root": "/src/roamgate", "remote_url": null, "branch": null, "is_worktree": false})
    );
}
