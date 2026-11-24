//! `archive-tools.test.ts`: the tools through the catalog's checks
//! ([`crate::tools::call_tool`]) on a real archive (synced, text pass run).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_archive::engine::{SyncOptions, run_sync};
use roamgate_archive::hosts::{ArchiveRuntime, SystemExec};
use roamgate_archive::settings::{ArchiveRule, ArchiveSettings, normalize_archive_settings};
use roamgate_archive::text_repo::{TextPassOptions, update_text_repo};
use serde_json::{Value, json};

use super::*;
use crate::tools::{Family, call_tool};

const SESSION: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    settings: Arc<Mutex<ArchiveSettings>>,
}

fn runtime(root: &Path) -> ArchiveRuntime {
    ArchiveRuntime {
        home_dir: root.to_path_buf(),
        platform: "linux".into(),
        env: Arc::new(|_| None),
        data_dir: root.join("data"),
        context: roamgate_base::paths::DataContext::new(
            root,
            roamgate_base::paths::Platform::current(),
            None,
        ),
        hostname: "testhost".into(),
    }
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let settings = normalize_archive_settings(Some(&json!({"host": "testhost"})));
        let project = root.join(".claude/projects/-Users-t-proj");
        std::fs::create_dir_all(&project).unwrap();
        let lines: Vec<String> = [
            "first question about the zebra",
            "an answer",
            "third message",
            "fourth",
        ]
        .iter()
        .enumerate()
        .map(|(i, text)| {
            json!({
                "type": if i % 2 == 1 { "assistant" } else { "user" },
                "timestamp": format!("2026-11-14T10:0{i}:00Z"),
                "cwd": "/Users/t/proj",
                "message": {"content": text},
            })
            .to_string()
        })
        .collect();
        std::fs::write(
            project.join(format!("{SESSION}.jsonl")),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
        let fixture = Self {
            _dir: dir,
            root,
            settings: Arc::new(Mutex::new(settings)),
        };
        let settings = fixture.settings.lock().unwrap().clone();
        run_sync(SyncOptions {
            settings: &settings,
            runtime: &runtime(&fixture.root),
            archive_dir: &fixture.archive(),
            hosts: None,
            agents: None,
            local_only: true,
            exec: &SystemExec,
            log: &mut |_| {},
        })
        .unwrap();
        update_text_repo(TextPassOptions {
            archive_dir: &fixture.archive(),
            settings: &settings,
            host: "testhost",
            log: &mut |_| {},
            busy: None,
            now_ms: None,
            repack: true,
        })
        .unwrap();
        fixture
    }

    fn archive(&self) -> PathBuf {
        self.root.join("archive")
    }

    fn handler(&self) -> crate::tools::Handler {
        let (settings, root, archive) = (self.settings.clone(), self.root.clone(), self.archive());
        archive_tool_handler(ArchiveToolDeps {
            settings: Arc::new(move || settings.lock().unwrap().clone()),
            archive_dir: Arc::new(move |_| archive.clone()),
            runtime: Arc::new(move || runtime(&root)),
        })
    }

    async fn call(&self, name: &str, params: Value) -> AssistantResult<String> {
        call_tool(Family::Archive, name, params, &self.handler(), None)
            .await
            .map(|result| result.text)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn search_session_and_a_bounded_read() {
    let f = Fixture::new();
    let search = f
        .call("archive_search", json!({"query": "zebra"}))
        .await
        .unwrap();
    assert!(search.contains("1 match"), "{search}");
    assert!(search.contains(SESSION));
    let session = f
        .call("archive_session", json!({"id": &SESSION[..8]}))
        .await
        .unwrap();
    assert!(session.contains("project -Users-t-proj"), "{session}");
    let read = f
        .call(
            "archive_read",
            json!({"id": SESSION, "from_line": 2, "limit": 2}),
        )
        .await
        .unwrap();
    assert!(read.contains("L2 assistant/text: an answer"), "{read}");
    assert!(read.contains("L3 user/text: third message"));
    assert!(!read.contains("fourth"));
    assert!(read.contains("next_line 4"));
}

#[tokio::test(flavor = "multi_thread")]
async fn hidden_projects_are_never_shown() {
    let f = Fixture::new();
    f.settings.lock().unwrap().hide = vec![ArchiveRule {
        host: None,
        agent: None,
        project: Some("proj".into()),
    }];
    let search = f
        .call("archive_search", json!({"query": "zebra"}))
        .await
        .unwrap();
    assert!(search.contains("0 match"), "{search}");
    for name in ["archive_session", "archive_read"] {
        let text = f.call(name, json!({"id": SESSION})).await.unwrap();
        assert!(text.contains("No archived session"), "{text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_parameters_are_refused() {
    let f = Fixture::new();
    assert!(
        f.call("archive_search", json!({"query": "zebra", "limit": 99}))
            .await
            .is_err()
    );
    assert!(f.call("archive_read", json!({"id": "x"})).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn search_finds_what_was_said_since_the_last_pass_and_regexes() {
    let f = Fixture::new();
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(
            f.root
                .join(".claude/projects/-Users-t-proj")
                .join(format!("{SESSION}.jsonl")),
        )
        .unwrap()
        .write_all(
            format!(
                "{}\n",
                json!({"type": "user", "timestamp": "2026-11-14T11:00:00Z", "message": {"content": "a late okapi"}})
            )
            .as_bytes(),
        )
        .unwrap();
    let live = f
        .call("archive_search", json!({"query": "okapi"}))
        .await
        .unwrap();
    assert!(
        live.contains("1 matching message(s) in 1 session(s)"),
        "{live}"
    );
    let regex = f
        .call("archive_search", json!({"query": "ze+bra", "regex": true}))
        .await
        .unwrap();
    assert!(regex.contains(SESSION), "{regex}");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_text_repo_there_is_no_archive_to_search_yet() {
    let f = Fixture::new();
    std::fs::remove_dir_all(f.archive().join("text.git")).unwrap();
    let error = f
        .call("archive_search", json!({"query": "zebra"}))
        .await
        .unwrap_err();
    assert!(
        error.message().contains("no session archive yet"),
        "{error}"
    );
}
