//! server/src/cli/activity.test.ts, case for case.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use roamgate_activity::store::{ActivityStore, AgentFields, Client, NewEvent, WorkspaceRow};

use super::*;

const MIN: i64 = 60_000;

fn at(hours: i64, minutes: i64) -> i64 {
    day_bounds("2026-11-02", &format!("{hours:02}:{minutes:02}")).0
}

struct Setup {
    _home: tempfile::TempDir,
    runtime: CliRuntime,
    directory: PathBuf,
}

fn setup(activity: Value) -> Setup {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".config").join("roamgate");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("settings.json"),
        json!({"version": 1, "activity": activity}).to_string(),
    )
    .unwrap();
    let runtime = CliRuntime {
        platform: "linux".into(),
        arch: "x64".into(),
        home: home.path().into(),
        app_data: None,
        exec_path: home.path().join("bin").join("roamgate"),
        version: "1.2.3".into(),
        standalone: true,
        uid: Some(1000),
        env: Arc::new(HashMap::<String, String>::new()),
    };
    Setup {
        _home: home,
        runtime,
        directory,
    }
}

fn seed(setup: &Setup) {
    let context = DataContext::new(setup.runtime.home.clone(), Platform::Unix, None);
    let store = ActivityStore::open(&context, &setup.directory).unwrap();
    let session = store.start_session(at(8, 0)).unwrap();
    for (id, connection, name) in [("ws_a", "local", "alpha"), ("ws_b", "work", "beta")] {
        store
            .upsert_workspace(&WorkspaceRow {
                id: id.into(),
                connection_id: connection.into(),
                name: name.into(),
                path: Some(format!("/src/{name}")),
                herdr_workspace_id: None,
                repo_root: None,
                repo_is_worktree: None,
                seen_at: at(8, 0),
            })
            .unwrap();
    }
    let client = Some(Client {
        id: "c1".into(),
        kind: "desktop".into(),
    });
    for (start, end, workspace, connection) in [
        (at(9, 0), at(10, 30), "ws_a", "local"),
        (at(11, 0), at(11, 20), "ws_b", "work"),
    ] {
        let span = store
            .append(&NewEvent {
                ts: start,
                kind: "workspace.focus",
                connection_id: connection.into(),
                session,
                workspace_id: Some(workspace.into()),
                client: client.clone(),
                source: Some("browser"),
                ..Default::default()
            })
            .unwrap();
        store
            .append(&NewEvent {
                ts: end,
                kind: "workspace.blur",
                connection_id: connection.into(),
                session,
                workspace_id: Some(workspace.into()),
                reason: Some("switch"),
                client: client.clone(),
                source: Some("browser"),
                span: Some(span),
                ..Default::default()
            })
            .unwrap();
    }
    for (ts, state) in [(at(9, 0), "working"), (at(10, 0), "idle")] {
        store
            .append(&NewEvent {
                ts,
                kind: "agent.state",
                connection_id: "local".into(),
                session,
                workspace_id: Some("ws_a".into()),
                pane_id: Some("p1".into()),
                agent: Some(AgentFields {
                    name: "claude".into(),
                    state,
                    task: None,
                    session_id: None,
                }),
                ..Default::default()
            })
            .unwrap();
    }
    store.alive(session, at(12, 0)).unwrap();
}

fn run(setup: &Setup, args: &[&str]) -> Printed {
    let now = || at(12, 1);
    let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    ActivityCli {
        runtime: &setup.runtime,
        now: &now,
    }
    .run(&args)
}

#[test]
fn durations_read_as_hours_and_minutes() {
    assert_eq!(format_duration(5 * MIN), "5m");
    assert_eq!(format_duration(90 * MIN), "1h30m");
    assert_eq!(format_duration(120 * MIN), "2h");
}

#[test]
fn today_prints_attended_and_agent_time_per_workspace() {
    let setup = setup(json!({"enabled": true}));
    seed(&setup);
    let printed = run(&setup, &["today"]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    assert!(
        printed.stdout.contains("2026-11-02  attended 1h50m"),
        "{}",
        printed.stdout
    );
    assert!(
        regex::Regex::new(r"alpha\s+1h30m\s+-\s+1h\s+-")
            .unwrap()
            .is_match(&printed.stdout)
    );
    assert!(
        regex::Regex::new(r"beta\s+20m")
            .unwrap()
            .is_match(&printed.stdout)
    );
}

#[test]
fn excluded_connections_are_left_out_json_gives_the_timeline() {
    let setup = setup(json!({"enabled": true, "exclude": {"connections": ["work"]}}));
    seed(&setup);
    let printed = run(&setup, &["day", "2026-11-02", "--json"]);
    assert_eq!(printed.code, 0);
    let timeline: Value = serde_json::from_str(&printed.stdout).unwrap();
    assert_eq!(timeline["days"][0]["totals"]["attended_ms"], 90 * MIN);
    assert_eq!(
        timeline["workspaces"],
        json!([{"id": "ws_a", "connection_id": "local", "name": "alpha", "path": "/src/alpha", "herdr_workspace_id": null, "subject": null}])
    );
}

#[test]
fn events_page_in_id_order_and_resume_after_an_id() {
    let setup = setup(json!({"enabled": true}));
    seed(&setup);
    let printed = run(&setup, &["events", "--limit", "3", "--json"]);
    assert_eq!(printed.code, 0);
    let page: Value = serde_json::from_str(&printed.stdout).unwrap();
    assert_eq!(page["events"].as_array().unwrap().len(), 3);
    assert_eq!(page["next_cursor"], page["events"][2]["id"]);
    let printed = run(
        &setup,
        &[
            "events",
            "--after",
            page["next_cursor"].as_str().unwrap(),
            "--ndjson",
        ],
    );
    assert_eq!(printed.code, 0);
    let rest: Vec<Value> = printed
        .stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let kinds: Vec<&str> = rest.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["workspace.blur", "agent.state", "agent.state"]);
    assert!(rest[1].get("source").is_none());
}

#[test]
fn status_reports_the_recorder_and_the_connections() {
    let setup = setup(json!({"enabled": true}));
    seed(&setup);
    let printed = run(&setup, &["status", "--json"]);
    assert_eq!(printed.code, 0);
    let status: Value = serde_json::from_str(&printed.stdout).unwrap();
    assert_eq!(status["recording"], true);
    assert_eq!(status["retention_days"], 90);
    let connections: Vec<(&str, &str)> = status["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap(), c["state"].as_str().unwrap()))
        .collect();
    assert_eq!(connections, [("local", "ready"), ("work", "ready")]);
}

#[test]
fn errors_usage_a_missing_log_json_errors_for_json_readers() {
    let setup = setup(json!({"enabled": true}));
    let printed = run(&setup, &["today"]);
    assert_eq!(printed.code, 1);
    assert!(
        printed.stderr.contains("no activity log"),
        "{}",
        printed.stderr
    );
    assert_eq!(run(&setup, &["day"]).code, 2);
    let printed = run(&setup, &["events", "--after", "x", "--json"]);
    assert_eq!(printed.code, 2);
    let error: Value = serde_json::from_str(printed.stderr.lines().next().unwrap()).unwrap();
    assert_eq!(error, json!({"error": "--after must be an event id"}));
    let printed = run(&setup, &["status", "--json"]);
    assert_eq!(printed.code, 0);
    assert_eq!(
        serde_json::from_str::<Value>(&printed.stdout).unwrap()["recording"],
        false
    );
}
