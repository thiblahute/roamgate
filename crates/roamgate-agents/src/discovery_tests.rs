//! grok-session.test.ts and muse-session.test.ts: finding Grok's and
//! Muse's sessions, and Muse's through the shared handlers.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::files::{AgentEnv, BoxFut, LocalSessionFiles, SessionFiles};
use crate::grok::{find_grok_session_by_id, find_grok_session_for_cwd};
use crate::handlers::AgentSessionHandlers;
use crate::js;
use crate::projection::read_session_projection;
use crate::resolver::{HerdrCall, MUSE_WORKSPACE_READS, ResolverContext, resolve_agent_session};

struct Herdr(Value);

impl HerdrCall for Herdr {
    fn call(&self, _: &str, _: Value, _: Option<u64>) -> BoxFut<'_, Result<Value, String>> {
        let value = self.0.clone();
        Box::pin(async move { Ok(value) })
    }
}

fn env(home: &Path, vars: &[(&str, &Path)]) -> AgentEnv {
    AgentEnv {
        home: home.to_path_buf(),
        vars: vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.to_string_lossy().into_owned()))
            .collect(),
    }
}

fn grok_session(root: &Path, cwd: &str, id: &str, updated: &str) -> PathBuf {
    // Grok names the folder after the absolute cwd (on a drive on Windows).
    let absolute = crate::paths::resolve(cwd);
    let dir = root
        .join(crate::paths::encode_uri_component(
            &absolute.to_string_lossy(),
        ))
        .join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("chat_history.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    let summary = json!({ "info": { "id": id, "cwd": cwd }, "created_at": "2026-07-01T00:00:00.000Z", "updated_at": updated, "current_model_id": "grok-4.5" });
    std::fs::write(dir.join("summary.json"), js::stringify(&summary)).unwrap();
    dir
}

#[test]
fn finds_the_newest_session_for_the_exact_working_directory() {
    let root = tempfile::tempdir().unwrap();
    grok_session(
        root.path(),
        "/workspace/repo",
        "older",
        "2026-07-01T00:00:00.000Z",
    );
    grok_session(
        root.path(),
        "/workspace/repo",
        "newer",
        "2026-07-02T00:00:00.000Z",
    );
    grok_session(
        root.path(),
        "/workspace/other",
        "other",
        "2026-07-03T00:00:00.000Z",
    );
    let found = find_grok_session_for_cwd("/workspace/repo", root.path()).unwrap();
    assert_eq!(found.session_id, "newer");
    assert_eq!(found.file.model_name.as_deref(), Some("grok-4.5"));
    assert!(Path::new(&found.file.path).ends_with("newer/chat_history.jsonl"));
}

#[test]
fn resolves_a_known_session_id_without_an_integration_provided_path() {
    let root = tempfile::tempdir().unwrap();
    grok_session(
        root.path(),
        "/workspace/repo",
        "session-1",
        "2026-07-01T00:00:00Z",
    );
    let found = find_grok_session_by_id("session-1", "", root.path()).unwrap();
    assert_eq!(found.cwd, "/workspace/repo");
    assert!(find_grok_session_by_id("../session-1", "", root.path()).is_none());
}

#[tokio::test]
async fn uses_the_foreground_process_cwd_instead_of_the_pane_identity_cwd() {
    let home = tempfile::tempdir().unwrap();
    let foreground = "/workspace/actual-agent-directory";
    grok_session(
        &home.path().join("sessions"),
        foreground,
        "foreground-session",
        "2026-07-02T00:00:00.000Z",
    );
    let agent_env = env(home.path(), &[("GROK_HOME", home.path())]);
    let herdr = Herdr(
        json!({ "agent": { "agent": "grok", "cwd": "/workspace/pane-identity-directory", "foreground_cwd": foreground } }),
    );
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let resolved = resolve_agent_session(
        &json!({ "pane_id": "p1", "agent": "grok" }),
        &herdr,
        &files,
        &ResolverContext::new(agent_env),
    )
    .await
    .unwrap();
    assert_eq!(resolved.value["status"], json!("ok"));
    assert_eq!(
        resolved.value["session"]["value"],
        json!("foreground-session")
    );
}

// ------------------------------------------------------------------ Muse

const SESSION: &str = "74747474-7474-4747-8747-747474747474";
const TIMESTAMP: f64 = 1_788_220_800_000.0; // 2026-09-01T00:00:00Z

fn record(payload_type: &str, payload: Value) -> Value {
    json!({ "schema_version": 1, "stream": { "kind": "session", "id": SESSION }, "recorded_at": TIMESTAMP * 1000.0 + 123456.0,
        "record_type": "event", "durability": "durable", "payload_type": payload_type, "payload": payload })
}

fn run(event: Value, run_id: &str) -> Value {
    record(
        "runtime.session",
        json!({ "kind": "run", "run_id": run_id, "event": event }),
    )
}

fn conversation(cwd: &str) -> Vec<Value> {
    vec![
        json!({ "retained_frame": "session_permission_transaction", "children": [] }),
        record(
            "runtime.session.metadata",
            json!({ "kind": "metadata", "record": { "workspace_root": cwd, "model_id": "meta/muse-glimmer-30b", "build": { "semver": "1.3.0" } } }),
        ),
        record(
            "run.model.configured",
            json!({ "kind": "run_model", "record": { "provider_id": "meta", "run_stream": { "kind": "run", "id": "run-1" } } }),
        ),
        record(
            "runtime.user_intent.accepted",
            json!({ "intent_id": "intent-1", "model_messages": [{ "content": [{ "kind": "text", "text": "Read README.md" }] }], "refill_blocks": [{ "kind": "text", "text": "Read README.md" }] }),
        ),
        run(
            json!({ "kind": "started", "prompt": "Read README.md" }),
            "run-1",
        ),
        record(
            "runtime.user_intent.materialized",
            json!({ "intent_id": "intent-1", "outcome": { "kind": "top_level_turn_started", "run_id": "run-1" } }),
        ),
        run(
            json!({ "kind": "assistant_message_delta", "text": "duplicate chunk" }),
            "run-1",
        ),
        run(
            json!({ "kind": "reasoning_committed", "text": "Inspect the file" }),
            "run-1",
        ),
        run(
            json!({ "kind": "assistant_tool_calls_committed", "tool_calls": [{ "call_id": "call-1", "name": "read_file", "args": "{\"path\":\"README.md\"}" }] }),
            "run-1",
        ),
        run(
            json!({ "kind": "tool_result_batch_committed", "results": [{ "tool_call_id": "call-1", "text": "# README" }] }),
            "run-1",
        ),
        run(
            json!({ "kind": "model_completed", "model": "meta/muse-glimmer-30b", "usage": { "input_tokens": 20, "output_tokens": 5, "cached_tokens": 4, "cache_read_tokens": 4, "reasoning_tokens": 2 } }),
            "run-1",
        ),
        record(
            "runtime.session",
            json!({ "kind": "task", "event": { "kind": "model_completed", "usage": { "input_tokens": 900 } } }),
        ),
        run(
            json!({ "kind": "assistant_message_committed", "text": "Read the README." }),
            "run-1",
        ),
    ]
}

fn jsonl(records: &[Value]) -> String {
    records
        .iter()
        .map(js::stringify)
        .collect::<Vec<_>>()
        .join("\n")
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

fn muse_session(root: &Path, id: &str, cwd: &str, time: f64) -> String {
    let path = root.join("2026/09/01").join(id).join("session.jsonl");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("{}\n", jsonl(&conversation(cwd)))).unwrap();
    set_mtime(&path, time);
    // As listed from the directories: one separator throughout on Windows.
    crate::paths::normalize(&path)
        .to_string_lossy()
        .into_owned()
}

fn reads() -> usize {
    MUSE_WORKSPACE_READS.with(std::cell::Cell::get)
}

#[cfg(unix)]
#[test]
fn discovers_the_newest_exact_workspace_excluding_subagents_and_other_workspaces() {
    use crate::resolver::find_muse_session;
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("muse/sessions");
    let cwd = data.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let alias = data.path().join("work-alias");
    std::os::unix::fs::symlink(&cwd, &alias).unwrap();
    let cwd_text = cwd.to_string_lossy().into_owned();
    muse_session(&root, "old", &cwd_text, TIMESTAMP);
    let newest = muse_session(&root, SESSION, &cwd_text, TIMESTAMP + 1000.0);
    muse_session(
        &root,
        "unrelated",
        &format!("{cwd_text}/nested"),
        TIMESTAMP + 2000.0,
    );
    muse_session(
        &root,
        &format!("{SESSION}/subagent/child"),
        &cwd_text,
        TIMESTAMP + 3000.0,
    );
    let agent_env = env(data.path(), &[("XDG_DATA_HOME", data.path())]);
    let find = |id: Option<&str>, cwd: Option<&str>| {
        find_muse_session(id, cwd, None, &agent_env).map(|f| f.path)
    };
    assert_eq!(find(None, Some(&alias.to_string_lossy())), Some(newest));
    assert!(find(Some("old"), None).unwrap().contains("/old/"));
    assert_eq!(find(None, Some(&format!("{cwd_text}/absent"))), None);
    assert_eq!(find(Some("../old"), None), None);
    assert_eq!(find(None, None), None);
}

#[tokio::test]
async fn caches_and_coalesces_discovery_metadata_without_pinning_the_selected_session() {
    let data = tempfile::tempdir().unwrap();
    let sessions = data.path().join("muse/sessions");
    let target = muse_session(&sessions, "target", "/work", TIMESTAMP);
    let other = muse_session(&sessions, "other", "/else", TIMESTAMP + 1000.0);
    let agent_env = env(data.path(), &[("XDG_DATA_HOME", data.path())]);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let herdr = Herdr(json!({ "agent": { "agent": "muse", "cwd": "/work" } }));
    let context = ResolverContext::new(agent_env.clone());
    let params = json!({ "pane_id": "p1" });
    let path = |resolved: std::io::Result<crate::projection::Resolved>| {
        resolved.unwrap().value["path"].as_str().unwrap().to_owned()
    };
    let (a, b) = tokio::join!(
        resolve_agent_session(&params, &herdr, &files, &context),
        resolve_agent_session(&params, &herdr, &files, &context)
    );
    assert_eq!((path(a), path(b)), (target.clone(), target.clone()));
    assert_eq!(reads(), 2);
    resolve_agent_session(&params, &herdr, &files, &context)
        .await
        .unwrap();
    assert_eq!(reads(), 2);
    resolve_agent_session(&params, &herdr, &files, &ResolverContext::new(agent_env))
        .await
        .unwrap();
    assert_eq!(reads(), 4);
    let newest = muse_session(&sessions, "new", "/work", TIMESTAMP + 2000.0);
    assert_eq!(
        path(resolve_agent_session(&params, &herdr, &files, &context).await),
        newest
    );
    assert_eq!(reads(), 5);
    let old_stat = files.stat_file(&other).await.unwrap().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    muse_session(&sessions, "other", "/work", TIMESTAMP + 1000.0);
    assert_ne!(
        files.stat_file(&other).await.unwrap().unwrap().change_token,
        old_stat.change_token
    );
    std::fs::remove_file(&newest).unwrap();
    assert_eq!(
        path(resolve_agent_session(&params, &herdr, &files, &context).await),
        other
    );
    assert_eq!(reads(), 6);
    std::fs::remove_file(&other).unwrap();
    assert_eq!(
        path(resolve_agent_session(&params, &herdr, &files, &context).await),
        target
    );
    assert_eq!(reads(), 6);
}

#[tokio::test]
async fn preserves_native_run_tool_errors_in_history_and_atif_without_leaking_across_runs() {
    let root = tempfile::tempdir().unwrap();
    let path = muse_session(root.path(), SESSION, "/work", TIMESTAMP);
    let result = |run_id: &str| {
        run(
            json!({ "kind": "tool_result_batch_committed", "results": [{ "tool_call_id": "call-1", "text": "tool failed" }] }),
            run_id,
        )
    };
    let mut records = conversation("/work");
    records.extend([
        record("tool_batch.effect.terminal", json!({ "run_id": "failed-run", "kind": "tool_batch_effect", "record": { "call_id": "call-1", "outcome": { "kind": "failed", "reason": "Missing file" } } })),
        result("failed-run"),
        result("successful-run"),
        run(json!({ "kind": "terminal", "terminal": "failed", "reason": "provider unavailable" }), "failed-run"),
        run(json!({ "kind": "terminal", "terminal": "failed" }), "no-reason"),
        run(json!({ "kind": "terminal", "terminal": "completed" }), "successful-run"),
        run(json!({ "kind": "terminal", "terminal": "cancelled" }), "cancelled-run"),
    ]);
    std::fs::write(&path, jsonl(&records)).unwrap();
    let files = LocalSessionFiles::default();
    let file = files.stat_file(&path).await.unwrap().unwrap();
    let (projection, trajectory) = read_session_projection("muse", &file, &files, None)
        .await
        .unwrap();
    let results: Vec<bool> = projection
        .entries
        .iter()
        .filter(|e| e["kind"] == "tool_result")
        .map(|e| e["is_error"] == json!(true))
        .collect();
    assert_eq!(results, [false, true, false]);
    let errors: Vec<&str> = projection
        .entries
        .iter()
        .filter(|e| e["kind"] == "error")
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(errors, ["provider unavailable", "Muse run failed"]);
    let messages: Vec<&str> = projection
        .messages
        .iter()
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(messages, ["Read README.md", "Read the README."]);
    let steps = trajectory["steps"].as_array().unwrap();
    let failed: Vec<&str> = steps
        .iter()
        .filter(|s| s["extra"]["error_message"].is_string())
        .map(|s| s["message"].as_str().unwrap())
        .collect();
    assert_eq!(
        failed,
        ["Error: provider unavailable", "Error: Muse run failed"]
    );
    let observed: Vec<bool> = steps
        .iter()
        .filter(|s| s.get("observation").is_some_and(|o| !o.is_null()))
        .map(|s| s["observation"]["results"][0]["extra"]["is_error"] == json!(true))
        .collect();
    assert_eq!(observed, [false, true, false]);
}

/// Local files reported as a remote host's (`{...localAgentSessionFiles, remote}`).
struct AsRemote(LocalSessionFiles);

impl SessionFiles for AsRemote {
    fn remote(&self) -> bool {
        true
    }
    fn stat_file<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<crate::session::SessionFile>>> {
        self.0.stat_file(path)
    }
    fn read_text<'a>(&'a self, path: &'a str) -> BoxFut<'a, std::io::Result<String>> {
        self.0.read_text(path)
    }
    fn read_prefix<'a>(
        &'a self,
        path: &'a str,
        limit: u64,
    ) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        self.0.read_prefix(path, limit)
    }
    fn read_tail<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        self.0.read_tail(path, limit)
    }
    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        self.0.read_range(path, start, end)
    }
    fn read_download<'a>(&'a self, path: &'a str) -> BoxFut<'a, std::io::Result<Vec<u8>>> {
        self.0.read_download(path)
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<crate::session::SessionFile>>> {
        self.0.find_pi_session_by_id(id)
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        cwd: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<crate::session::SessionFile>>> {
        self.0.find_pi_session_for_cwd(cwd)
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<crate::session::SessionFile>>> {
        self.0.find_claude_session_by_id(id)
    }
    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        id: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<String>>> {
        self.0.find_claude_successor(path, id)
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, std::io::Result<Option<crate::session::SessionFile>>> {
        self.0.find_codex_session_by_id(id)
    }
}

#[tokio::test]
async fn serves_reported_paths_through_the_shared_handlers_remote_s() {
    for remote in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = muse_session(root.path(), SESSION, "/work", TIMESTAMP);
        let files: Arc<dyn SessionFiles> = if remote {
            Arc::new(AsRemote(LocalSessionFiles::default()))
        } else {
            Arc::new(LocalSessionFiles::default())
        };
        let handlers = AgentSessionHandlers::new(
            Arc::new(Herdr(
                json!({ "agent": { "agent": "muse-code", "agent_session": { "kind": "path", "value": path } } }),
            )),
            files,
            Arc::new(ResolverContext::default()),
            None,
            Arc::new(js::now_ms),
        );
        let legacy = handlers
            .read_history(&json!({ "pane_id": "p1" }))
            .await
            .map_err(|e| e.message)
            .unwrap();
        let texts: Vec<&str> = legacy["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap())
            .collect();
        assert_eq!(
            texts,
            ["Read README.md", "Read the README."],
            "remote: {remote}"
        );
        let summary = handlers
            .read_summary(
                &json!({ "pane_id": "p1", "include_text": true, "include_trajectory": true }),
            )
            .await
            .map_err(|e| e.message)
            .unwrap();
        assert_eq!(summary["stats"]["turns"], json!(1));
        assert_eq!(summary["stats"]["records"], json!(13));
        let usage = &summary["stats"]["token_usage"];
        for (key, want) in [
            ("input_tokens", 20),
            ("cached_input_tokens", 4),
            ("output_tokens", 5),
            ("reasoning_output_tokens", 2),
            ("total_tokens", 25),
        ] {
            assert_eq!(usage[key], json!(want), "{key} remote: {remote}");
        }
        assert_eq!(summary["trajectory"]["session_id"], json!(SESSION));
        assert_eq!(summary["trajectory"]["trajectory_id"], json!(SESSION));
        assert_eq!(summary["trajectory"]["agent"]["name"], json!("muse-code"));
        assert_eq!(summary["trajectory"]["agent"]["version"], json!("1.3.0"));
        assert_eq!(
            summary["trajectory"]["agent"]["model_name"],
            json!("meta/muse-glimmer-30b")
        );
        assert_eq!(
            summary["trajectory"]["steps"][0]["timestamp"],
            json!("2026-09-01T00:00:00.123Z")
        );
        let reasoning = summary["trajectory"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|s| s["reasoning_content"].as_str());
        assert_eq!(reasoning, Some("Inspect the file"));
        let text = summary["text"].as_str().unwrap().to_owned();
        assert!(text.contains("runtime.session.metadata"));
        let snapshot = handlers
            .read_history(&json!({ "pane_id": "p1", "history_version": 2 }))
            .await
            .map_err(|e| e.message)
            .unwrap();
        let kinds: Vec<&str> = snapshot["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["message", "tool_call", "tool_result", "message"]);
        let tool = snapshot["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "tool_result")
            .unwrap()
            .clone();
        assert_eq!(
            (&tool["tool_name"], &tool["source_call_id"], &tool["text"]),
            (&json!("read_file"), &json!("call-1"), &json!(""))
        );
        let entry = handlers
            .read_entry(&json!({ "pane_id": "p1", "entry_id": tool["id"] }))
            .await
            .map_err(|e| e.message)
            .unwrap();
        assert_eq!(entry["text"], json!("# README"));
        let download = handlers
            .download_file(&json!({ "pane_id": "p1" }))
            .await
            .map_err(|e| e.message)
            .unwrap();
        assert_eq!(String::from_utf8(download.2).unwrap(), text);
        let atif = handlers
            .download_atif(&json!({ "pane_id": "p1" }))
            .await
            .map_err(|e| e.message)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&atif.2).unwrap(),
            summary["trajectory"]
        );
        let more = run(
            json!({ "kind": "assistant_message_committed", "text": "More detail" }),
            "run-1",
        );
        std::fs::write(
            &path,
            format!("{text}{}\n{{\"payload\":", js::stringify(&more)),
        )
        .unwrap();
        let delta = handlers
            .read_history(
                &json!({ "pane_id": "p1", "history_version": 2, "cursor": snapshot["cursor"] }),
            )
            .await
            .map_err(|e| e.message)
            .unwrap();
        let upserts: Vec<&str> = delta["upserts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["text"].as_str().unwrap())
            .collect();
        assert_eq!(upserts, ["More detail"]);
        assert_eq!(delta["removed"], json!([]));
    }
}
