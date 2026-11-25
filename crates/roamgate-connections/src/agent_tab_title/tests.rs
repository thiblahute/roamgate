//! server/src/connections/agent-tab-title.test.ts.

// Their helpers serve tests that need Unix (sockets, modes, symlinks, sh).
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use super::*;

fn home() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".hermes")).unwrap();
    let path = root.path().join(".hermes/state.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at INTEGER);
         INSERT INTO sessions VALUES ('older', 'Correct older title', 1);
         INSERT INTO sessions VALUES ('newer', 'Other pane title', 2);",
    )
    .unwrap();
    drop(db);
    (root, path)
}

fn env_at(root: &Path) -> AgentEnv {
    AgentEnv {
        home: root.to_path_buf(),
        vars: HashMap::from([(
            "ANTIGRAVITY_HOME".to_owned(),
            root.join(".gemini/antigravity-cli")
                .to_string_lossy()
                .into_owned(),
        )]),
    }
}

/// Runs the remote command locally with `sh -c`, under `home`.
fn local_run(home: PathBuf, commands: Arc<Mutex<Vec<Vec<String>>>>) -> Run {
    Arc::new(move |argv, _| {
        commands.lock().unwrap().push(argv.clone());
        let home = home.clone();
        Box::pin(async move {
            let output = tokio::process::Command::new("sh")
                .arg("-c")
                .arg(argv.last().unwrap())
                .env("HOME", &home)
                .output()
                .await
                .map_err(|error| error.to_string())?;
            Ok(RunOutput {
                code: output.status.code().unwrap_or(1),
                stdout: output.stdout,
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            })
        })
    })
}

struct Fixture {
    reader: AgentTabTitleReader,
    info: Arc<Mutex<Value>>,
    summary: Arc<Mutex<Value>>,
    after_read: Arc<Mutex<Option<Value>>>,
    commands: Arc<Mutex<Vec<Vec<String>>>>,
}

fn fixture(agent: &str, id: Option<&str>, remote: Option<&Path>, env: AgentEnv) -> Fixture {
    let info = Arc::new(Mutex::new(json!({
        "agent": agent,
        "agent_session": id.map(|id| json!({"agent": agent, "kind": "id", "value": id})),
    })));
    let summary = Arc::new(Mutex::new(Value::Null));
    let after_read: Arc<Mutex<Option<Value>>> = Arc::default();
    let commands: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let reader = AgentTabTitleReader::new(AgentTabTitleOptions {
        herdr_call: {
            let info = info.clone();
            Arc::new(move |method, params| {
                assert_eq!(method, "agent.get");
                assert_eq!(params, json!({"target": "p"}));
                let agent = info.lock().unwrap().clone();
                Box::pin(async move { Ok(json!({"agent": agent})) })
            })
        },
        read_summary: {
            let summary = summary.clone();
            let info = info.clone();
            let after_read = after_read.clone();
            Arc::new(move |_| {
                if let Some(next) = after_read.lock().unwrap().take() {
                    *info.lock().unwrap() = next;
                }
                let summary = summary.lock().unwrap().clone();
                Box::pin(async move { Ok(summary) })
            })
        },
        ssh_host: remote.map(|_| "fixture-host".to_owned()),
        remote_platform: None,
        run: match remote {
            Some(home) => local_run(home.to_path_buf(), commands.clone()),
            None => Arc::new(|_, _| Box::pin(async { Err("Unexpected SSH lookup".to_owned()) })),
        },
        ssh_argv: Arc::new(|host, command| vec!["ssh".into(), host.into(), command.into()]),
        env,
    });
    Fixture {
        reader,
        info,
        summary,
        after_read,
        commands,
    }
}

async fn local_title(root: &Path, agent: &str, id: &str) -> Option<String> {
    fixture(agent, Some(id), None, env_at(root))
        .reader
        .read("p")
        .await
        .unwrap()
}

#[tokio::test]
async fn hermes_selects_the_reported_id_rather_than_a_newer_concurrent_session() {
    let (root, path) = home();
    assert_eq!(
        read_hermes_session_title(&path, "older")
            .unwrap()
            .as_deref(),
        Some("Correct older title")
    );
    assert_eq!(read_hermes_session_title(&path, "missing").unwrap(), None);
    assert_eq!(
        local_title(root.path(), "hermes", "older").await.as_deref(),
        Some("Correct older title")
    );
}

#[tokio::test]
async fn missing_or_unmatched_ids_never_adopt_an_unrelated_hermes_session() {
    let (root, _) = home();
    for id in ["", "missing", "../newer", "older'; DROP TABLE sessions; --"] {
        assert_eq!(local_title(root.path(), "hermes", id).await, None, "{id}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn the_actual_ssh_sqlite_command_is_scoped_and_read_only() {
    let (root, path) = home();
    let f = fixture(
        "hermes",
        Some("older"),
        Some(root.path()),
        env_at(root.path()),
    );
    assert_eq!(
        f.reader.read("p").await.unwrap().as_deref(),
        Some("Correct older title")
    );
    assert!(f.commands.lock().unwrap()[0].contains(&"fixture-host".to_owned()));
    let missing = fixture(
        "hermes",
        Some("missing"),
        Some(root.path()),
        env_at(root.path()),
    );
    assert_eq!(missing.reader.read("p").await.unwrap(), None);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(f.reader.read("p").await.unwrap(), None);
    assert!(!root.path().join(".hermes/state.db").exists());
}

#[tokio::test]
async fn antigravity_reads_only_the_reported_session_annotation_and_handles_escaped_titles() {
    let (root, _) = home();
    let dir = root.path().join(".gemini/antigravity-cli/annotations");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("older.pbtxt"),
        r#"title: "Correct \"quoted\" title""#,
    )
    .unwrap();
    std::fs::write(dir.join("newer.pbtxt"), r#"title: "Wrong session""#).unwrap();
    assert_eq!(
        local_title(root.path(), "agy", "older").await.as_deref(),
        Some("Correct \"quoted\" title")
    );
    assert_eq!(local_title(root.path(), "agy", "missing").await, None);
    if cfg!(unix) {
        let f = fixture("agy", Some("older"), Some(root.path()), env_at(root.path()));
        assert_eq!(
            f.reader.read("p").await.unwrap().as_deref(),
            Some("Correct \"quoted\" title")
        );
    }
}

#[tokio::test]
async fn claude_uses_the_existing_bound_summary_and_rejects_a_different_session() {
    let f = fixture("claude", Some("older"), None, AgentEnv::default());
    *f.summary.lock().unwrap() =
        json!({"session": {"kind": "id", "value": "older"}, "title": "Bound Claude title"});
    assert_eq!(
        f.reader.read("p").await.unwrap().as_deref(),
        Some("Bound Claude title")
    );
    *f.summary.lock().unwrap() =
        json!({"session": {"kind": "id", "value": "newer"}, "title": "Wrong pane"});
    assert_eq!(f.reader.read("p").await.unwrap(), None);
}

#[tokio::test]
async fn drops_a_result_when_the_agent_session_changes_while_reading_its_title() {
    let f = fixture("claude", Some("older"), None, AgentEnv::default());
    *f.summary.lock().unwrap() =
        json!({"session": {"kind": "id", "value": "older"}, "title": "Stale title"});
    *f.after_read.lock().unwrap() = Some(json!({
        "agent": "claude",
        "agent_session": {"agent": "claude", "kind": "id", "value": "newer"},
    }));
    assert_eq!(f.reader.read("p").await.unwrap(), None);
}

#[tokio::test]
async fn uses_only_this_panes_sanitized_osc_title_when_no_bound_metadata_is_available() {
    let f = fixture("codex", None, None, AgentEnv::default());
    *f.info.lock().unwrap() =
        json!({"agent": "codex", "terminal_title": "\u{1b}[31m\u{2733} Build UI\u{1b}[0m\u{7}"});
    assert_eq!(
        f.reader.read("p").await.unwrap().as_deref(),
        Some("Build UI")
    );
    *f.info.lock().unwrap() = json!({"agent": "codex", "terminal_title": "codex"});
    assert_eq!(f.reader.read("p").await.unwrap(), None);
    *f.info.lock().unwrap() = json!({"agent": "codex", "terminal_title": "user@host: ~/work"});
    assert_eq!(f.reader.read("p").await.unwrap(), None);
}
