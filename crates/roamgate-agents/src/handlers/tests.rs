//! agent-sessions.test.ts and task-watcher.test.ts.

use std::path::Path;

use serde_json::json;

use super::*;
use crate::files::{BoxFut, LocalSessionFiles};

const REMOTE_PI: &str = "/srv/herdr-gui-test/sessions/pi-session.jsonl";

struct Herdr<F: Fn(&str, &Value) -> std::result::Result<Value, String> + Send + Sync>(F);

impl<F: Fn(&str, &Value) -> std::result::Result<Value, String> + Send + Sync> HerdrCall
    for Herdr<F>
{
    fn call(
        &self,
        method: &str,
        params: Value,
        _: Option<u64>,
    ) -> BoxFut<'_, std::result::Result<Value, String>> {
        let result = (self.0)(method, &params);
        Box::pin(async move { result })
    }
}

fn agent_call(agent: &str, path: &str) -> Arc<dyn HerdrCall> {
    let value = json!({ "agent": { "agent": agent, "workspace_id": "w1", "tab_id": "t1", "cwd": "/tmp/project",
        "agent_session": { "source": format!("herdr:{agent}"), "agent": agent, "kind": "path", "value": path } } });
    Arc::new(Herdr(move |method: &str, _: &Value| {
        assert_eq!(method, "agent.get");
        Ok(value.clone())
    }))
}

/// A transcript on an SSH host (`remotePiFiles`), with no range reads.
struct RemoteText {
    bytes: Vec<u8>,
    claude: Option<(String, String, String)>,
}

impl RemoteText {
    fn new(text: &str) -> Arc<Self> {
        Arc::new(Self {
            bytes: text.as_bytes().to_vec(),
            claude: None,
        })
    }
}

impl SessionFiles for RemoteText {
    fn remote(&self) -> bool {
        true
    }
    fn has_range(&self) -> bool {
        false
    }
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = if self.claude.is_some() {
            SessionFile {
                path: path.into(),
                mtime_ms: 1.0,
                size: Some(1.0),
                ..Default::default()
            }
        } else {
            SessionFile {
                path: REMOTE_PI.into(),
                mtime_ms: js::date_parse("2026-07-24T00:00:03.000Z"),
                size: Some(self.bytes.len() as f64),
                ..Default::default()
            }
        };
        Box::pin(async move { Ok(Some(file)) })
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<String>> {
        let text = String::from_utf8_lossy(&self.bytes).into_owned();
        Box::pin(async move { Ok(text) })
    }
    fn read_prefix<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes[..self.bytes.len().min(limit as usize)].to_vec();
        Box::pin(async move { Ok(bytes) })
    }
    fn read_tail<'a>(&'a self, _: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes[self.bytes.len().saturating_sub(limit as usize)..].to_vec();
        Box::pin(async move { Ok(bytes) })
    }
    fn read_range<'a>(&'a self, _: &'a str, _: u64, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Err(io::Error::other("no ranges")) })
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let bytes = self.bytes.clone();
        Box::pin(async move { Ok(bytes) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let found = self
            .claude
            .as_ref()
            .filter(|(first, _, _)| first == id)
            .map(|(first, _, project)| SessionFile {
                path: format!("{project}/{first}.jsonl"),
                mtime_ms: 1.0,
                size: Some(1.0),
                ..Default::default()
            });
        Box::pin(async move { Ok(found) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        let next = self
            .claude
            .as_ref()
            .filter(|(first, _, project)| path == format!("{project}/{first}.jsonl"))
            .map(|(_, next, project)| format!("{project}/{next}.jsonl"));
        Box::pin(async move { Ok(next) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

fn handlers(herdr: Arc<dyn HerdrCall>, files: Arc<dyn SessionFiles>) -> AgentSessionHandlers {
    AgentSessionHandlers::new(
        herdr,
        files,
        Arc::new(ResolverContext::default()),
        None,
        Arc::new(js::now_ms),
    )
}

fn ok<T>(result: Result<T>) -> T {
    result.map_err(|e| e.message).unwrap()
}

fn jsonl(records: &[Value]) -> String {
    format!(
        "{}\n",
        records
            .iter()
            .map(js::stringify)
            .collect::<Vec<_>>()
            .join("\n")
    )
}

fn pi_records() -> Vec<Value> {
    vec![
        json!({ "type": "session", "version": 3, "id": "pi-session", "timestamp": "2026-07-24T00:00:00.000Z", "cwd": "/tmp/project" }),
        json!({ "type": "message", "id": "user-1", "timestamp": "2026-07-24T00:00:01.000Z", "message": { "role": "user", "content": [{ "type": "text", "text": "first message" }] } }),
        json!({ "type": "message", "id": "assistant-1", "timestamp": "2026-07-24T00:00:02.000Z", "message": { "role": "assistant", "model": "test-model",
            "content": [{ "type": "text", "text": "response" }], "usage": { "input": 4, "output": 2, "cacheRead": 1, "cacheWrite": 0 } } }),
        json!({ "type": "message", "id": "user-2", "timestamp": "2026-07-24T00:00:03.000Z", "message": { "role": "user", "content": [{ "type": "text", "text": "second message" }] } }),
        json!({ "type": "message", "id": "assistant-2", "timestamp": "2026-07-24T00:00:04.000Z", "message": { "role": "assistant", "model": "test-model",
            "content": [{ "type": "text", "text": "second response" }] } }),
    ]
}

fn pi_session(dir: &Path) -> String {
    let path = dir.join("2026-07-24_pi-session.jsonl");
    std::fs::write(&path, jsonl(&pi_records())).unwrap();
    path.to_string_lossy().into_owned()
}

fn local() -> Arc<dyn SessionFiles> {
    Arc::new(LocalSessionFiles::default())
}

#[tokio::test]
async fn reads_user_and_assistant_history_from_an_integration_reported_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = pi_session(dir.path());
    let history = ok(handlers(agent_call("pi", &path), local())
        .read_history(&json!({ "pane_id": "p1", "agent": "pi" }))
        .await);
    assert_eq!(history["status"], json!("ok"));
    assert_eq!(history["path"], json!(path));
    let messages: Vec<(&str, &str, &str)> = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["role"].as_str().unwrap(),
                m["text"].as_str().unwrap(),
                m["sent_at"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        messages,
        [
            ("user", "first message", "2026-07-24T00:00:01.000Z"),
            ("assistant", "response", "2026-07-24T00:00:02.000Z"),
            ("user", "second message", "2026-07-24T00:00:03.000Z"),
            ("assistant", "second response", "2026-07-24T00:00:04.000Z"),
        ]
    );
}

#[tokio::test]
async fn returns_persisted_omp_skill_prompts_and_execution_messages_in_history_and_summaries() {
    let records = [
        json!({ "type": "session", "version": 3, "id": "omp-session", "cwd": "/tmp/project" }),
        json!({ "type": "custom_message", "id": "skill-1", "timestamp": "2026-07-24T00:00:00.000Z", "customType": "skill-prompt", "attribution": "user",
            "display": true, "content": "<skill>Expanded instructions</skill>", "details": { "name": "review", "args": "this change", "prompt": "/skill:review this change" } }),
        json!({ "type": "message", "id": "execution-1", "timestamp": "2026-07-24T00:00:01.000Z", "message": { "role": "bashExecution", "command": "false",
            "output": "failure-output", "exitCode": 1, "cancelled": false, "timestamp": 1 } }),
    ];
    let h = handlers(
        agent_call("omp", REMOTE_PI),
        RemoteText::new(&jsonl(&records)),
    );
    let history = ok(h
        .read_history(&json!({ "pane_id": "p1", "agent": "omp", "history_version": 2 }))
        .await);
    assert_eq!(history["mode"], json!("snapshot"));
    let entries = history["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        (
            &entries[0]["role"],
            &entries[0]["kind"],
            &entries[0]["text"]
        ),
        (
            &json!("user"),
            &json!("message"),
            &json!("/skill:review this change")
        )
    );
    assert_eq!(
        (
            &entries[1]["role"],
            &entries[1]["kind"],
            &entries[1]["tool_name"],
            &entries[1]["is_error"],
            &entries[1]["text"]
        ),
        (
            &json!("tool"),
            &json!("tool_result"),
            &json!("bash"),
            &json!(true),
            &json!("")
        )
    );
    let entry = ok(h
        .read_entry(&json!({ "pane_id": "p1", "agent": "omp", "entry_id": entries[1]["id"] }))
        .await);
    assert_eq!(
        entry["text"],
        json!("Ran `false`\n\nOutput:\nfailure-output\n\nCommand exited with code 1")
    );
    let summary = ok(h
        .read_summary(&json!({ "pane_id": "p1", "agent": "omp", "include_trajectory": true }))
        .await);
    assert_eq!(summary["stats"]["turns"], json!(1));
    assert_eq!(summary["trajectory"]["steps"][0]["source"], json!("user"));
    assert_eq!(
        summary["trajectory"]["steps"][0]["message"],
        json!("/skill:review this change")
    );
}

#[tokio::test]
async fn includes_pi_statistics_and_atif_in_session_inspect() {
    let dir = tempfile::tempdir().unwrap();
    let path = pi_session(dir.path());
    let summary = ok(handlers(agent_call("pi", &path), local())
        .read_summary(&json!({ "pane_id": "p1", "agent": "pi", "include_trajectory": true }))
        .await);
    assert_eq!(summary["stats"]["turns"], json!(2));
    assert_eq!(summary["stats"]["records"], json!(5));
    let usage = &summary["stats"]["token_usage"];
    assert_eq!(
        (
            &usage["input_tokens"],
            &usage["cached_input_tokens"],
            &usage["output_tokens"]
        ),
        (&json!(4), &json!(1), &json!(2))
    );
    assert_eq!(summary["trajectory"]["session_id"], json!("pi-session"));
    assert_eq!(summary["trajectory"]["agent"]["name"], json!("pi"));
    assert_eq!(
        summary["trajectory"]["agent"]["model_name"],
        json!("test-model")
    );
}

#[tokio::test]
async fn shows_the_official_integration_command_when_pi_has_no_session() {
    let herdr: Arc<dyn HerdrCall> = Arc::new(Herdr(|_: &str, _: &Value| {
        Ok(json!({ "agent": { "agent": "pi" } }))
    }));
    let result = ok(handlers(herdr, local())
        .read_history(&json!({ "pane_id": "p1", "agent": "pi" }))
        .await);
    assert_eq!(result["status"], json!("missing_session"));
    assert_eq!(result["command"], json!("herdr integration install pi"));
}

#[tokio::test]
async fn binds_herdr_and_file_access_inside_each_runtime_handler_bundle() {
    let record = |id: &str, text: &str| {
        jsonl(&[
            json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-07-24T00:00:00.000Z" }),
            json!({ "type": "message", "id": format!("{id}-user"), "timestamp": "2026-07-24T00:00:01.000Z", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }),
        ])
    };
    let first = handlers(
        agent_call("pi", REMOTE_PI),
        RemoteText::new(&record("first-session", "first runtime")),
    );
    let second = handlers(
        agent_call("pi", REMOTE_PI),
        RemoteText::new(&record("second-session", "second runtime")),
    );
    let params = json!({ "pane_id": "p1", "agent": "pi" });
    let (a, b) = tokio::join!(first.read_history(&params), second.read_history(&params));
    assert_eq!(ok(a)["messages"][0]["text"], json!("first runtime"));
    assert_eq!(ok(b)["messages"][0]["text"], json!("second runtime"));
}

#[tokio::test]
async fn reads_and_exports_an_ssh_reported_pi_session() {
    let text = [
        json!({ "type": "session", "version": 3, "id": "remote-pi-session", "timestamp": "2026-07-24T00:00:00.000Z" }),
        json!({ "type": "message", "id": "user-remote", "timestamp": "2026-07-24T00:00:01.000Z", "message": { "role": "user", "content": [{ "type": "text", "text": "remote message" }] } }),
        json!({ "type": "message", "id": "assistant-remote", "timestamp": "2026-07-24T00:00:02.000Z", "message": { "role": "assistant", "model": "remote-model",
            "content": [{ "type": "text", "text": "remote response" }], "usage": { "input": 4, "output": 2, "cacheRead": 1, "cacheWrite": 0 } } }),
    ]
    .iter()
    .map(js::stringify)
    .collect::<Vec<_>>()
    .join("\n");
    let h = handlers(
        agent_call("pi", REMOTE_PI),
        RemoteText::new(&format!("{text}\n")),
    );
    let params = json!({ "pane_id": "p1", "agent": "pi" });
    let summary = ok(h.read_summary(&json!({ "pane_id": "p1", "agent": "pi", "include_text": true, "include_trajectory": true })).await);
    assert_eq!(summary["status"], json!("ok"));
    assert_eq!(summary["path"], json!(REMOTE_PI));
    assert_eq!(
        (&summary["stats"]["turns"], &summary["stats"]["records"]),
        (&json!(1), &json!(3))
    );
    assert_eq!(summary["truncated"], json!(false));
    assert_eq!(
        summary["trajectory"]["session_id"],
        json!("remote-pi-session")
    );
    assert_eq!(
        summary["trajectory"]["agent"]["model_name"],
        json!("remote-model")
    );
    assert!(summary["text"].as_str().unwrap().contains("remote message"));
    let raw = ok(h.download_file(&params).await);
    assert_eq!(raw.0, 200);
    assert!(
        String::from_utf8(raw.2)
            .unwrap()
            .contains("remote response")
    );
    let atif = ok(h.download_atif(&params).await);
    assert_eq!(atif.0, 200);
    let atif: Value = serde_json::from_slice(&atif.2).unwrap();
    assert_eq!(
        (&atif["schema_version"], &atif["session_id"]),
        (&json!("ATIF-v1.7"), &json!("remote-pi-session"))
    );
}

#[tokio::test]
async fn reads_and_exports_an_antigravity_sqlite_session() {
    let dir = tempfile::tempdir().unwrap();
    let id = "test-agy-uuid";
    let path = dir.path().join(format!("{id}.db"));
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
         CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
         CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
         CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));",
    )
    .unwrap();
    db.execute(
        "INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)",
        rusqlite::params!["traj-1", id, 4, 17],
    )
    .unwrap();
    // As the TS test builds them: Buffer.from of a string is its UTF-8.
    let user_text = "\u{12}\u{e}hello from agy".as_bytes();
    let mut user = vec![0x9a, 0x01, user_text.len() as u8];
    user.extend_from_slice(user_text);
    let insert = |idx: i64, kind: i64, meta: &str, payload: &[u8]| {
        db.execute(
            "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
            rusqlite::params![idx, kind, meta.as_bytes(), payload],
        )
        .unwrap();
    };
    insert(0, 14, "\u{a}\u{6}\u{8}\u{80}\u{a4}\u{eb}\u{b5}\u{6}", &user);
    let response = "\u{a}\u{f}agy response ok".as_bytes();
    let mut planner = vec![0xa2, 0x01, response.len() as u8];
    planner.extend_from_slice(response);
    insert(
        1,
        15,
        "\u{a}\u{6}\u{8}\u{85}\u{a4}\u{eb}\u{b5}\u{6}",
        &planner,
    );
    drop(db);
    let path = path.to_string_lossy().into_owned();
    let h = handlers(agent_call("agy", &path), local());
    let params = json!({ "pane_id": "p1", "agent": "agy" });
    let history = ok(h.read_history(&params).await);
    assert_eq!(history["status"], json!("ok"));
    let texts: Vec<&str> = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["hello from agy", "agy response ok"]);
    let summary = ok(h.read_summary(&json!({ "pane_id": "p1", "agent": "agy", "include_text": true, "include_trajectory": true })).await);
    assert_eq!(summary["status"], json!("ok"));
    assert_eq!(summary["stats"]["turns"], json!(1));
    assert!(summary["text"].as_str().unwrap().contains("hello from agy"));
    let raw = ok(h.download_file(&params).await);
    assert_eq!(raw.0, 200);
    assert!(
        raw.1
            .iter()
            .any(|(k, v)| k == "content-type" && v == "application/vnd.sqlite3")
    );
    let atif = ok(h.download_atif(&params).await);
    assert_eq!(atif.0, 200);
    let atif: Value = serde_json::from_slice(&atif.2).unwrap();
    assert_eq!(
        (
            &atif["schema_version"],
            &atif["session_id"],
            &atif["agent"]["name"]
        ),
        (&json!("ATIF-v1.7"), &json!(id), &json!("antigravity-cli"))
    );
}

fn touch(dir: &Path, name: &str, seconds: u64) {
    let path = dir.join(name);
    std::fs::write(&path, "{}").unwrap();
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[tokio::test]
async fn a_live_workflow_s_agents_carry_when_they_started_and_were_last_active() {
    let dir = tempfile::tempdir().unwrap();
    let journal = [
        json!({ "type": "launched" }),
        json!({ "type": "started", "agentId": "a1", "label": "server", "phase": "Build" }),
        json!({ "type": "result", "agentId": "a1", "result": { "summary": "built" } }),
        json!({ "type": "started", "agentId": "a2", "label": "web", "phase": "Build" }),
    ]
    .iter()
    .map(js::stringify)
    .collect::<Vec<_>>()
    .join("\n");
    std::fs::write(dir.path().join("journal.jsonl"), journal).unwrap();
    touch(dir.path(), "agent-a1.meta.json", 1000);
    touch(dir.path(), "agent-a1.jsonl", 1090);
    touch(dir.path(), "agent-a2.meta.json", 1100);
    touch(dir.path(), "agent-a2.jsonl", 1150);
    let run = dir.path().to_string_lossy().into_owned();
    let view = read_workflow_run(
        &LocalSessionFiles::default(),
        &SettledTimes::default(),
        &run,
        &format!("{run}/missing.json"),
    )
    .await;
    assert_eq!(
        view["phases"],
        json!([{ "title": "Build", "agents": [
            { "agentId": "a1", "label": "server", "state": "done", "resultPreview": js::stringify_pretty(&json!({ "summary": "built" })),
              "startedAt": 1_000_000, "durationMs": 90_000 },
            { "agentId": "a2", "label": "web", "state": "running", "startedAt": 1_100_000, "lastActiveAt": 1_150_000 },
        ] }])
    );
}

#[tokio::test]
async fn agent_session_get_carries_the_rename_name_else_claude_s_title() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir
        .path()
        .join("session.jsonl")
        .to_string_lossy()
        .into_owned();
    let herdr = || -> Arc<dyn HerdrCall> {
        let value = json!({ "agent": { "agent": "claude", "workspace_id": "w1", "tab_id": "t1", "cwd": "/tmp",
            "agent_session": { "agent": "claude", "kind": "path", "value": path } } });
        Arc::new(Herdr(move |_: &str, _: &Value| Ok(value.clone())))
    };
    let user = json!({ "type": "user", "message": { "role": "user", "content": "hi" } });
    let ai = json!({ "type": "ai-title", "aiTitle": "Fix the login form" });
    std::fs::write(&path, jsonl(&[user.clone(), ai.clone()])).unwrap();
    let first = ok(handlers(herdr(), local())
        .read_summary(&json!({ "pane_id": "p1" }))
        .await);
    assert_eq!(first["title"], json!("Fix the login form"));
    std::fs::write(
        &path,
        jsonl(&[
            user,
            ai,
            json!({ "type": "custom-title", "customTitle": "login" }),
        ]),
    )
    .unwrap();
    let second = ok(handlers(herdr(), local())
        .read_summary(&json!({ "pane_id": "p1" }))
        .await);
    assert_eq!(second["title"], json!("login"));
}

#[tokio::test]
async fn finds_the_pane_running_a_session_following_a_claude_session_that_went_on_under_a_new_id() {
    let first = "362be254-14eb-4390-a96c-25032526572a";
    let next = "9f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    let agents = json!([
        { "pane_id": "w1:p3", "agent": "claude", "agent_session": { "kind": "id", "value": "another-session" } },
        { "pane_id": "w2:p14", "agent": "claude", "agent_session": { "kind": "id", "value": next } },
    ]);
    let herdr: Arc<dyn HerdrCall> =
        Arc::new(Herdr(move |method: &str, params: &Value| match method {
            "agent.list" => Ok(json!({ "agents": agents })),
            "agent.get" => agents
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["pane_id"] == params["target"])
                .map(|a| json!({ "agent": a }))
                .ok_or_else(|| {
                    format!(
                        "agent_not_found: agent target {} not found",
                        js::sv(params.get("target"))
                    )
                }),
            other => Err(format!("unexpected {other}")),
        }));
    let project = "/home/user/.claude/projects/-repo";
    let files = Arc::new(RemoteText {
        bytes: Vec::new(),
        claude: Some((first.into(), next.into(), project.into())),
    });
    let h = handlers(herdr, files);
    assert_eq!(ok(h.session_pane(next).await).as_deref(), Some("w2:p14"));
    assert_eq!(ok(h.session_pane(first).await).as_deref(), Some("w2:p14"));
    assert_eq!(
        ok(h.session_pane("0b1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f").await),
        None
    );
    assert_eq!(ok(h.pane_session("w2:p14").await).as_deref(), Some(next));
    assert_eq!(ok(h.pane_session("w2:p2").await), None);
}

// ------------------------------------------------------------ task watcher

const MINUTE: f64 = 60_000.0;

/// Stats this machine's files, as a local or a remote host's.
struct Stats(bool);

impl SessionFiles for Stats {
    fn remote(&self) -> bool {
        self.0
    }
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        let file = std::fs::metadata(path).ok().map(|m| SessionFile {
            path: path.into(),
            mtime_ms: crate::paths::mtime_ms(&m),
            ..Default::default()
        });
        Box::pin(async move { Ok(file) })
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<String>> {
        Box::pin(async { Ok(String::new()) })
    }
    fn read_prefix<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read_tail<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read_range<'a>(&'a self, _: &'a str, _: u64, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        Box::pin(async { Ok(None) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

fn set_mtime(path: &Path, ms: f64) {
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

fn clock(
    start: f64,
) -> (
    Arc<std::sync::atomic::AtomicU64>,
    Arc<dyn Fn() -> f64 + Send + Sync>,
) {
    let now = Arc::new(std::sync::atomic::AtomicU64::new(start as u64));
    let read = now.clone();
    (
        now,
        Arc::new(move || read.load(std::sync::atomic::Ordering::SeqCst) as f64),
    )
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_background_command_runs_while_its_process_writes_and_is_lost_once_it_is_gone() {
    let start = js::date_parse("2026-11-13T18:00:00.000Z");
    let dir = tempfile::tempdir().unwrap();
    let dir = std::fs::canonicalize(dir.path()).unwrap();
    let output = dir.join("b1.output");
    let file = std::fs::File::create(&output).unwrap();
    let mut child = std::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(file)
        .spawn()
        .unwrap();
    let silent_since = start - 30.0 * MINUTE;
    set_mtime(&output, silent_since);
    let task = json!({ "id": "t1", "kind": "command", "title": "Build", "status": "running",
        "startedAt": js::iso(start - 90.0 * MINUTE), "outputFile": output.to_string_lossy() });
    let (now, clock) = clock(start);
    let watch = TaskWatcher::new(Arc::new(Stats(false)), clock);
    let session = dir.join("session.jsonl").to_string_lossy().into_owned();
    let running = watch.watch(&session, vec![task.clone()]).await;
    assert_eq!(running[0]["status"], json!("running"));
    child.kill().unwrap();
    child.wait().unwrap();
    now.fetch_add(10_000, std::sync::atomic::Ordering::SeqCst);
    let lost = watch.watch(&session, vec![task.clone()]).await;
    assert_eq!(lost[0]["status"], json!("lost"));
    assert_eq!(lost[0]["endedAt"], json!(js::iso(silent_since)));
    assert_eq!(task["status"], json!("running"));
}

#[tokio::test]
async fn without_a_process_list_a_silent_command_is_lost_only_after_an_hour() {
    let start = js::date_parse("2026-11-13T18:00:00.000Z");
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("b2.output");
    std::fs::File::create(&output).unwrap();
    set_mtime(&output, start - 30.0 * MINUTE);
    let task = json!({ "id": "t2", "kind": "command", "title": "Remote build", "status": "running",
        "startedAt": js::iso(start - 180.0 * MINUTE), "outputFile": output.to_string_lossy() });
    let (now, clock) = clock(start);
    let watch = TaskWatcher::new(Arc::new(Stats(true)), clock);
    let session = dir
        .path()
        .join("session.jsonl")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        watch.watch(&session, vec![task.clone()]).await[0]["status"],
        json!("running")
    );
    now.fetch_add((31.0 * MINUTE) as u64, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        watch.watch(&session, vec![task]).await[0]["status"],
        json!("lost")
    );
}
