//! server/src/activity/reader.test.ts, case for case.

use super::*;
use roamgate_base::paths::Platform;
use std::path::PathBuf;

use crate::day_input::{ActivitySettings, build_day_input};
use crate::protocol::parse_time;
use crate::store::{ActivityStore, AgentFields, Client, NewEvent, WorkspaceRow};
use crate::timeline::day_bounds;

const MIN: i64 = 60_000;

fn at(hours: i64, minutes: i64) -> i64 {
    day_bounds("2026-11-02", &format!("{hours:02}:{minutes:02}")).0
}

fn directory() -> (tempfile::TempDir, DataContext, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let context = DataContext::new(dir.path(), Platform::Unix, None);
    let path = dir.path().join("roamgate");
    (dir, context, path)
}

fn browser() -> Option<Client> {
    Some(Client {
        id: "c1".into(),
        kind: "desktop".into(),
    })
}

fn agent(ts: i64, session: i64, state: &'static str) -> NewEvent {
    NewEvent {
        ts,
        kind: "agent.state",
        connection_id: "local".into(),
        session,
        workspace_id: Some("ws_a".into()),
        pane_id: Some("w1:p1".into()),
        agent: Some(AgentFields {
            name: "claude".into(),
            state,
            task: None,
            session_id: None,
        }),
        ..Default::default()
    }
}

fn workspace(repo_root: Option<&str>, seen_at: i64) -> WorkspaceRow {
    WorkspaceRow {
        id: "ws_a".into(),
        connection_id: "local".into(),
        name: "alpha".into(),
        path: Some("/src/alpha".into()),
        herdr_workspace_id: Some("w1".into()),
        repo_root: repo_root.map(str::to_owned),
        repo_is_worktree: repo_root.map(|_| false),
        seen_at,
    }
}

fn seed(context: &DataContext, path: &Path) -> ActivityStore {
    let store = ActivityStore::open(context, path).unwrap();
    let session = store.start_session(at(8, 0)).unwrap();
    store
        .upsert_workspace(&workspace(Some("/src/alpha"), at(8, 0)))
        .unwrap();
    let focus = store
        .append(&NewEvent {
            ts: at(9, 0),
            kind: "workspace.focus",
            connection_id: "local".into(),
            session,
            workspace_id: Some("ws_a".into()),
            pane_id: Some("w1:p1".into()),
            client: browser(),
            source: Some("browser"),
            ..Default::default()
        })
        .unwrap();
    store
        .append(&NewEvent {
            ts: at(10, 0),
            kind: "workspace.blur",
            connection_id: "local".into(),
            session,
            workspace_id: Some("ws_a".into()),
            reason: Some("switch"),
            client: browser(),
            source: Some("browser"),
            span: Some(focus),
            ..Default::default()
        })
        .unwrap();
    // A state from yesterday still holds this morning.
    store
        .append(&agent(at(7, 0) - 24 * 60 * MIN, session, "working"))
        .unwrap();
    store.append(&agent(at(9, 30), session, "idle")).unwrap();
    store
        .add_gap(Some("local"), at(11, 0), at(11, 5), "disconnected")
        .unwrap();
    store.alive(session, at(12, 0)).unwrap();
    store
}

fn reader(context: &DataContext, path: &Path, now: i64) -> ActivityReader {
    ActivityReader::open(context, path, Box::new(move || now), None)
        .unwrap()
        .unwrap()
}

fn ms(value: &Value) -> i64 {
    parse_time(value.as_str().unwrap()).unwrap()
}

#[test]
fn no_log_no_reader() {
    let (_dir, context, path) = directory();
    assert!(
        ActivityReader::open(&context, &path, Box::new(|| 0), None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn the_timeline_reads_spans_states_before_the_range_and_gaps() {
    let (_dir, context, path) = directory();
    let _store = seed(&context, &path);
    let bounds = day_bounds("2026-11-02", "00:00");
    let timeline = reader(&context, &path, at(12, 0))
        .timeline(bounds, "00:00", &[], None)
        .unwrap();
    let day = &timeline["days"][0];
    assert_eq!(day["focus"].as_array().unwrap().len(), 1);
    assert_eq!(day["totals"]["attended_ms"], 60 * MIN);
    let lane = &day["agents"][0];
    let states: Vec<&str> = lane["spans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["working", "idle", "idle"]);
    assert_eq!(ms(&lane["spans"][0]["start"]), bounds.0);
    let gap = &day["gaps"][0];
    assert_eq!(
        (
            gap["connection_id"].as_str(),
            gap["reason"].as_str(),
            gap["excluded"].as_bool()
        ),
        (Some("local"), Some("disconnected"), Some(false))
    );
    assert_eq!(
        timeline["workspaces"],
        json!([{
            "id": "ws_a",
            "connection_id": "local",
            "name": "alpha",
            "path": "/src/alpha",
            "herdr_workspace_id": "w1",
            "subject": null,
        }])
    );
}

#[test]
fn pages_are_in_id_order_and_resume_after_an_id() {
    let (_dir, context, path) = directory();
    let _store = seed(&context, &path);
    let log = reader(&context, &path, at(12, 0));
    let kinds = |page: &Value| -> Vec<String> {
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap().to_owned())
            .collect()
    };
    let first = log
        .page(&PageQuery {
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(kinds(&first), ["workspace.focus", "workspace.blur"]);
    assert_eq!(first["events"][0]["source"], "browser");
    assert_eq!(first["workspaces"][0]["id"], "ws_a");
    assert_eq!(first["next_cursor"], first["events"][1]["id"]);
    let second = log
        .page(&PageQuery {
            after: event_seq(first["next_cursor"].as_str().unwrap()),
            limit: 2,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(kinds(&second), ["agent.state", "agent.state"]);
    // Agent states carry no source.
    assert!(second["events"][0].get("source").is_none());
    assert_eq!(second["next_cursor"], Value::Null);
    let morning = log
        .page(&PageQuery {
            limit: 10,
            kinds: vec!["agent.state".into()],
            from: Some(at(0, 0)),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(morning["events"].as_array().unwrap().len(), 1);
    let excluded = log
        .page(&PageQuery {
            limit: 10,
            exclude_connections: vec!["local".into()],
            ..Default::default()
        })
        .unwrap();
    assert!(excluded["events"].as_array().unwrap().is_empty());
    assert_eq!(event_seq("0000000000000042"), Some(42));
    assert_eq!(event_seq("x"), None);
}

#[test]
fn status_tells_a_running_recorder_from_a_stopped_one() {
    let (_dir, context, path) = directory();
    let _store = seed(&context, &path);
    let running = reader(&context, &path, at(12, 1))
        .status(true, 90, at(0, 0), at(12, 1))
        .unwrap();
    assert_eq!(running["recording"], true);
    assert_eq!(running["retention_days"], 90);
    assert_eq!(running["connections"][0]["id"], "local");
    assert_eq!(running["connections"][0]["state"], "ready");
    assert_eq!(running["connections"].as_array().unwrap().len(), 1);
    assert_eq!(running["gaps"].as_array().unwrap().len(), 1);
    let stopped = reader(&context, &path, at(15, 0))
        .status(true, 90, at(0, 0), at(15, 0))
        .unwrap();
    assert_eq!(stopped["recording"], false);
    assert_eq!(stopped["connections"][0]["state"], "disconnected");
    let last = stopped["gaps"].as_array().unwrap().last().unwrap();
    assert_eq!(
        (
            last["connection_id"].clone(),
            last["end"].clone(),
            last["reason"].clone()
        ),
        (Value::Null, Value::Null, json!("recorder"))
    );
}

#[test]
fn a_log_whose_recorder_stopped_can_still_be_read_and_is_not_written() {
    let (_dir, context, path) = directory();
    drop(seed(&context, &path));
    let file = path.join("activity.sqlite");
    let log = reader(&context, &path, at(12, 0));
    let page = log
        .page(&PageQuery {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page["events"].as_array().unwrap().len(), 4);
    drop(log);
    assert!(file.exists());
}

/// A log from before causes: a bridge restarted at 13:00 and a page
/// reloaded 3 s later; the 12:52 switch is a person.
fn legacy_restart(context: &DataContext, path: &Path) -> ActivityStore {
    let store = ActivityStore::open(context, path).unwrap();
    let first = store.start_session(at(12, 48)).unwrap();
    store
        .upsert_workspace(&workspace(None, at(12, 48)))
        .unwrap();
    let span = |ts: i64, end: i64, session: i64, source: &'static str| {
        let client = if source == "browser" { browser() } else { None };
        let focus = store
            .append(&NewEvent {
                ts,
                kind: "workspace.focus",
                connection_id: "local".into(),
                session,
                workspace_id: Some("ws_a".into()),
                client: client.clone(),
                source: Some(source),
                ..Default::default()
            })
            .unwrap();
        store
            .append(&NewEvent {
                ts: end,
                kind: "workspace.blur",
                connection_id: "local".into(),
                session,
                workspace_id: Some("ws_a".into()),
                client,
                source: Some(source),
                reason: Some("recorder_stop"),
                span: Some(focus),
                ..Default::default()
            })
            .unwrap();
    };
    let visible = |ts: i64, session: i64| {
        store
            .append(&NewEvent {
                ts,
                kind: "ui.visibility",
                connection_id: "local".into(),
                session,
                client: browser(),
                visible: Some(true),
                ..Default::default()
            })
            .unwrap();
    };
    visible(at(12, 52), first);
    span(at(12, 52), at(13, 0), first, "browser");
    store.stop_session(first, at(13, 0), true).unwrap();
    let second = store.start_session(at(13, 0) + 300).unwrap();
    span(at(13, 0) + 1_000, at(13, 6), second, "herdr");
    visible(at(13, 0) + 3_000, second);
    span(at(13, 0) + 3_200, at(13, 6), second, "browser");
    store.stop_session(second, at(13, 6), true).unwrap();
    store
}

#[test]
fn old_rows_written_just_after_a_recorder_start_read_as_its_start_everywhere() {
    let (_dir, context, path) = directory();
    let _store = legacy_restart(&context, &path);
    let log = reader(&context, &path, at(14, 0));
    let page = log
        .page(&PageQuery {
            limit: 100,
            ..Default::default()
        })
        .unwrap();
    let causes: Vec<(String, Value, Value)> = page["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["kind"].as_str().unwrap().to_owned(),
                e.get("source").cloned().unwrap_or(Value::Null),
                e["cause"].clone(),
            )
        })
        .collect();
    let row = |kind: &str, source: Value, cause: Value| (kind.to_owned(), source, cause);
    assert_eq!(
        causes,
        vec![
            row("ui.visibility", Value::Null, Value::Null),
            row("workspace.focus", json!("browser"), Value::Null),
            row("workspace.blur", json!("browser"), Value::Null),
            row("workspace.focus", json!("herdr"), json!("recorder_start")),
            row("workspace.blur", json!("herdr"), Value::Null),
            row("ui.visibility", Value::Null, json!("reconnect")),
            row("workspace.focus", json!("browser"), json!("reconnect")),
            row("workspace.blur", json!("browser"), Value::Null),
        ]
    );
    // The provider gets the same.
    let settings = ActivitySettings {
        enabled: true,
        ..ActivitySettings::default()
    };
    let input = build_day_input(&log, &settings, "2026-11-02", "UTC").unwrap();
    let focus_causes: Vec<Value> = input["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "workspace.focus")
        .map(|e| e["cause"].clone())
        .collect();
    assert_eq!(
        focus_causes,
        vec![Value::Null, json!("recorder_start"), json!("reconnect")]
    );
    // The timeline counts the person's 8 minutes, not the reloaded page's 6.
    let bounds = day_bounds("2026-11-02", "00:00");
    let timeline = log.timeline(bounds, "00:00", &[], None).unwrap();
    let day = &timeline["days"][0];
    assert_eq!(day["totals"]["attended_ms"], 8 * MIN);
    let spans: Vec<Value> = day["focus"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["cause"].clone())
        .collect();
    assert_eq!(
        spans,
        vec![Value::Null, json!("recorder_start"), json!("reconnect")]
    );
}
