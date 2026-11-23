//! session-resolver.test.ts, the environment given to the context instead
//! of set on the process.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::*;
use crate::files::{AgentEnv, BoxFut, LocalSessionFiles, SessionFiles};

pub(crate) struct Herdr(pub Value);

impl HerdrCall for Herdr {
    fn call(
        &self,
        _method: &str,
        _params: Value,
        _timeout: Option<u64>,
    ) -> BoxFut<'_, Result<Value, String>> {
        let value = self.0.clone();
        Box::pin(async move { Ok(value) })
    }
}

fn env(home: &Path, vars: &[(&str, String)]) -> AgentEnv {
    AgentEnv {
        home: home.to_path_buf(),
        vars: vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    }
}

fn agent(agent: &str, kind: &str, value: &str, cwd: Option<&str>) -> Herdr {
    let mut info = json!({
        "agent": agent, "workspace_id": "w1", "tab_id": "t1",
        "agent_session": { "source": format!("herdr:{agent}"), "agent": agent, "kind": kind, "value": value },
    });
    if let Some(cwd) = cwd {
        info["cwd"] = json!(cwd);
    }
    Herdr(json!({ "agent": info }))
}

async fn resolve(herdr: &Herdr, files: &dyn SessionFiles, context: &ResolverContext) -> Value {
    Value::Object(
        resolve_agent_session(&json!({ "pane_id": "p1" }), herdr, files, context)
            .await
            .unwrap()
            .value,
    )
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn age(path: &Path, seconds: i64) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    let when = std::time::SystemTime::now()
        .checked_add_signed(seconds)
        .unwrap();
    file.set_modified(when).unwrap();
}

trait AddSigned {
    fn checked_add_signed(self, seconds: i64) -> Option<std::time::SystemTime>;
}

impl AddSigned for std::time::SystemTime {
    fn checked_add_signed(self, seconds: i64) -> Option<std::time::SystemTime> {
        let delta = std::time::Duration::from_secs(seconds.unsigned_abs());
        if seconds >= 0 {
            self.checked_add(delta)
        } else {
            self.checked_sub(delta)
        }
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn keeps_session_path_caches_isolated_per_connection_context() {
    let root = tempfile::tempdir().unwrap();
    let id = "session-isolated";
    let path = root
        .path()
        .join("sessions")
        .join("project")
        .join(format!("{id}.jsonl"));
    write(&path, "{}\n");
    let agent_env = env(root.path(), &[("PI_CODING_AGENT_DIR", text(root.path()))]);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let herdr = agent("pi", "id", id, Some("/repo"));
    let first = ResolverContext::new(agent_env.clone());
    let second = ResolverContext::new(agent_env);
    assert_eq!(
        resolve(&herdr, &files, &first).await["path"],
        json!(text(&path))
    );
    assert_eq!(
        first.path_cache.lock().unwrap().get(&format!("pi:{id}")),
        Some(&text(&path))
    );
    assert!(second.path_cache.lock().unwrap().is_empty());
    assert_eq!(
        resolve(&herdr, &files, &second).await["path"],
        json!(text(&path))
    );
    assert_eq!(
        second.path_cache.lock().unwrap().get(&format!("pi:{id}")),
        Some(&text(&path))
    );
}

#[tokio::test]
async fn finds_a_transcript_in_its_project_s_folder_else_anywhere_below() {
    let home = tempfile::tempdir().unwrap();
    let projects = home.path().join(".claude").join("projects");
    let id = "4b9e7c1e-2f0a-4d43-9a57-0c1f00a1b001";
    let project = projects.join("-repo");
    let kept = project.join(format!("{id}.jsonl"));
    write(&kept, "{}\n");
    let deep = project
        .join(id)
        .join("subagents")
        .join(format!("{id}.jsonl"));
    write(&deep, "{}\n");
    age(&deep, 60);
    let agent_env = env(home.path(), &[]);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let found = resolve(
        &agent("claude", "id", id, None),
        &files,
        &ResolverContext::new(agent_env.clone()),
    )
    .await;
    assert_eq!(found["path"], json!(text(&kept)));

    let other = "4b9e7c1e-2f0a-4d43-9a57-0c1f00a1b002";
    let nested = projects
        .join("-old")
        .join("nested")
        .join(format!("{other}.jsonl"));
    write(&nested, "{}\n");
    let found = resolve(
        &agent("claude", "id", other, None),
        &files,
        &ResolverContext::new(agent_env),
    )
    .await;
    assert_eq!(found["path"], json!(text(&nested)));
}

async fn omp(home: &Path, vars: &[(&str, String)], id: &str) -> Value {
    let agent_env = env(home, vars);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    resolve(
        &agent("omp", "id", id, None),
        &files,
        &ResolverContext::new(agent_env),
    )
    .await
}

#[tokio::test]
async fn finds_ids_in_the_default_omp_session_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join(".omp")
        .join("agent")
        .join("sessions")
        .join("session-a.jsonl");
    write(&path, "{}\n");
    let found = omp(root.path(), &[], "session-a").await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["path"], json!(text(&path)));
}

#[tokio::test]
async fn finds_ids_in_a_configured_session_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("custom-agent")
        .join("sessions")
        .join("prefix_session-b.jsonl");
    write(&path, "{}\n");
    let found = omp(
        root.path(),
        &[(
            "PI_CODING_AGENT_DIR",
            text(&root.path().join("custom-agent")),
        )],
        "session-b",
    )
    .await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["path"], json!(text(&path)));
}

#[tokio::test]
async fn finds_sessions_under_pi_config_dir_s_relative_to_home() {
    for config in [".omp-custom", "/absolute-omp-custom"] {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join(config.trim_start_matches('/'))
            .join("agent")
            .join("sessions")
            .join("session-c.jsonl");
        write(&path, "{}\n");
        let found = omp(
            root.path(),
            &[("PI_CONFIG_DIR", config.to_owned())],
            "session-c",
        )
        .await;
        assert_eq!(found["status"], json!("ok"), "{config}");
        assert_eq!(found["path"], json!(text(&path)), "{config}");
    }
}

#[tokio::test]
async fn finds_ids_under_a_profile_agent_session_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join(".omp/profiles/test-profile/agent/sessions")
        .join("session-d.jsonl");
    write(&path, "{}\n");
    let found = omp(root.path(), &[], "session-d").await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["path"], json!(text(&path)));
}

#[tokio::test]
async fn finds_ids_in_the_default_xdg_omp_session_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("data/omp/sessions")
        .join("session-e.jsonl");
    write(&path, "{}\n");
    let found = omp(
        root.path(),
        &[("XDG_DATA_HOME", text(&root.path().join("data")))],
        "session-e",
    )
    .await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["path"], json!(text(&path)));
}

/// A remote host's files, each stat answering the path asked.
#[derive(Default)]
struct Remote {
    successor: Mutex<Option<String>>,
    reported: Option<String>,
    finds: AtomicUsize,
    successors: AtomicUsize,
}

impl SessionFiles for Remote {
    fn remote(&self) -> bool {
        true
    }
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async move {
            Ok(Some(SessionFile {
                path: path.into(),
                mtime_ms: 1.0,
                size: Some(1.0),
                ..Default::default()
            }))
        })
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
        self.finds.fetch_add(1, Ordering::SeqCst);
        let found = self.reported.clone().map(|path| SessionFile {
            path,
            mtime_ms: 1.0,
            size: Some(1.0),
            ..Default::default()
        });
        Box::pin(async move { Ok(found) })
    }
    fn find_claude_successor<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        self.successors.fetch_add(1, Ordering::SeqCst);
        let next = self.successor.lock().unwrap().clone();
        Box::pin(async move { Ok(next) })
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        _: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn uses_reported_remote_transcript_paths_without_local_id_discovery() {
    let files = Remote::default();
    let remote_path = "/remote/.omp/profiles/work/agent/sessions/session.jsonl";
    let context = ResolverContext::new(AgentEnv::default());
    let direct = resolve(&agent("omp", "path", remote_path, None), &files, &context).await;
    assert_eq!(direct["status"], json!("ok"));
    assert_eq!(direct["path"], json!(remote_path));
    let by_id = resolve(
        &agent("omp", "id", "remote-x", None),
        &files,
        &ResolverContext::new(AgentEnv::default()),
    )
    .await;
    assert_eq!(by_id["status"], json!("missing_file"));
    assert_eq!(by_id["path"], json!(""));
}

#[cfg(unix)]
#[tokio::test]
async fn follows_a_session_folder_that_is_a_link() {
    let root = tempfile::tempdir().unwrap();
    let id = "session-linked";
    let kept = root.path().join("kept").join("project");
    std::fs::create_dir_all(&kept).unwrap();
    std::fs::create_dir_all(root.path().join("sessions")).unwrap();
    std::os::unix::fs::symlink(&kept, root.path().join("sessions/project")).unwrap();
    let looped = root.path().join("sessions/loop");
    std::os::unix::fs::symlink(&looped, &looped).unwrap();
    write(&kept.join(format!("{id}.jsonl")), "{}\n");
    let agent_env = env(root.path(), &[("PI_CODING_AGENT_DIR", text(root.path()))]);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let found = resolve(
        &agent("pi", "id", id, Some("/repo")),
        &files,
        &ResolverContext::new(agent_env),
    )
    .await;
    assert_eq!(
        found["path"],
        json!(text(
            &root
                .path()
                .join("sessions/project")
                .join(format!("{id}.jsonl"))
        ))
    );
}

#[tokio::test]
async fn a_pi_pane_with_no_reported_session_takes_its_directory_s_newest() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("sessions").join("--repo-app--");
    let older = dir.join("2026-10-01T10-00-00-000Z_older-id.jsonl");
    let newer = dir.join("2026-10-02T10-00-00-000Z_newer-id.jsonl");
    write(&older, "{}\n");
    write(&newer, "{}\n");
    age(&older, -60);
    let agent_env = env(root.path(), &[("PI_CODING_AGENT_DIR", text(root.path()))]);
    let files = LocalSessionFiles {
        env: agent_env.clone(),
    };
    let pane = |cwd: &str| {
        Herdr(
            json!({ "agent": { "agent": "pi", "workspace_id": "w1", "tab_id": "t1", "cwd": cwd } }),
        )
    };
    let found = resolve(
        &pane("/repo/app"),
        &files,
        &ResolverContext::new(agent_env.clone()),
    )
    .await;
    assert_eq!(found["path"], json!(text(&newer)));
    assert_eq!(
        found["session"],
        json!({ "source": "pi-local", "agent": "pi", "kind": "id", "value": "newer-id" })
    );
    let other = resolve(
        &pane("/repo/other"),
        &files,
        &ResolverContext::new(agent_env.clone()),
    )
    .await;
    assert_eq!(other["status"], json!("missing_session"));
    write(
        &root
            .path()
            .join("sessions/--repo-unnamed--/2026-10-03_.jsonl"),
        "{}\n",
    );
    let missing = resolve(
        &pane("/repo/unnamed"),
        &files,
        &ResolverContext::new(agent_env),
    )
    .await;
    assert_eq!(missing["status"], json!("missing_session"));
    assert_eq!(missing["path"], json!(""));
}

const ID: &str = "69775585-98cc-4cb1-9275-4956ebb07add";

fn successor_files() -> LocalSessionFiles {
    LocalSessionFiles::default()
}

#[cfg(unix)]
#[tokio::test]
async fn a_resumed_session_is_followed_to_the_transcript_it_went_on_in() {
    let root = tempfile::tempdir().unwrap();
    let reported = root.path().join(format!("{ID}.jsonl"));
    let resumed = root
        .path()
        .join("b6a8466c-831a-4cf8-9659-d65d02fa7db3.jsonl");
    let other = root
        .path()
        .join("0e3b0c44-298f-4c14-9a3b-2c1d9e5f0a11.jsonl");
    write(&reported, &format!("{{\"sessionId\":\"{ID}\"}}\n"));
    write(
        &resumed,
        &format!("{{\"sessionId\":\"{ID}\"}}\n{{\"sessionId\":\"b6a8\"}}\n"),
    );
    write(&other, "{\"sessionId\":\"0e3b\"}\n");
    age(&reported, -60);
    let files = successor_files();
    assert_eq!(
        files
            .find_claude_successor(&text(&reported), ID)
            .await
            .unwrap(),
        Some(text(&resumed))
    );
    assert_eq!(
        files
            .find_claude_successor(&text(&resumed), ID)
            .await
            .unwrap(),
        None
    );
}

#[cfg(unix)]
#[tokio::test]
async fn mentioning_another_session_in_user_text_does_not_make_a_successor() {
    let root = tempfile::tempdir().unwrap();
    let reported = root.path().join(format!("{ID}.jsonl"));
    let other = root
        .path()
        .join("b6a8466c-831a-4cf8-9659-d65d02fa7db3.jsonl");
    write(
        &reported,
        &format!("{}\n", crate::js::stringify(&json!({ "sessionId": ID }))),
    );
    let mention = json!({
        "sessionId": "b6a8466c-831a-4cf8-9659-d65d02fa7db3",
        "message": { "role": "user", "content": format!("Check {ID} and {{\"sessionId\":\"{ID}\"}}") },
    });
    write(&other, &format!("{}\n", crate::js::stringify(&mention)));
    age(&reported, -60);
    assert_eq!(
        successor_files()
            .find_claude_successor(&text(&reported), ID)
            .await
            .unwrap(),
        None
    );
}

/// The Windows half (no successor search there) is `cfg!(windows)` in
/// `find_claude_successor`, checked on the Windows runner.
#[cfg(unix)]
#[tokio::test]
async fn a_successor_is_found_in_a_folder_with_spaces_and_not_on_windows() {
    let parent = tempfile::tempdir().unwrap();
    let root: PathBuf = parent.path().join("my project");
    let reported = root.join(format!("{ID}.jsonl"));
    let resumed = root.join("b6a8466c-831a-4cf8-9659-d65d02fa7db3.jsonl");
    write(&reported, &format!("{{\"sessionId\":\"{ID}\"}}\n"));
    write(&resumed, &format!("{{\"sessionId\":\"{ID}\"}}\n"));
    age(&reported, -60);
    assert_eq!(
        successor_files()
            .find_claude_successor(&text(&reported), ID)
            .await
            .unwrap(),
        Some(text(&resumed))
    );
}

#[tokio::test]
async fn a_remote_lookup_is_kept_and_its_successor_checked_at_most_every_30s() {
    let reported = "/remote/p/old.jsonl";
    let resumed = "/remote/p/new.jsonl";
    let files = Remote {
        reported: Some(reported.into()),
        ..Default::default()
    };
    let herdr = agent("claude", "id", ID, Some("/repo"));
    let context = ResolverContext::new(AgentEnv::default());
    assert_eq!(
        resolve(&herdr, &files, &context).await["path"],
        json!(reported)
    );
    *files.successor.lock().unwrap() = Some(resumed.into());
    assert_eq!(
        resolve(&herdr, &files, &context).await["path"],
        json!(reported)
    );
    assert_eq!(
        (
            files.finds.load(Ordering::SeqCst),
            files.successors.load(Ordering::SeqCst)
        ),
        (1, 1)
    );
    context.successor_checked.lock().unwrap().clear();
    assert_eq!(
        resolve(&herdr, &files, &context).await["path"],
        json!(resumed)
    );
    assert_eq!(
        resolve(&herdr, &files, &context).await["path"],
        json!(resumed)
    );
    assert_eq!(
        (
            files.finds.load(Ordering::SeqCst),
            files.successors.load(Ordering::SeqCst)
        ),
        (1, 2)
    );
}

fn agy_env(root: &Path) -> AgentEnv {
    env(root, &[("ANTIGRAVITY_CONVERSATIONS_DIR", text(root))])
}

#[tokio::test]
async fn resolves_antigravity_session_via_resolve_agent_session() {
    let root = tempfile::tempdir().unwrap();
    let id = "session-herdr-resolved";
    crate::antigravity::tests::synthetic_db(root.path(), id, "/workspace/test-repo", 1726272000, "m");
    let agent_env = agy_env(root.path());
    let files = LocalSessionFiles { env: agent_env.clone() };
    let herdr = Herdr(json!({ "agent": { "agent": "agy", "cwd": "/workspace/test-repo",
        "agent_session": { "source": "herdr:antigravity_cli", "agent": "agy", "kind": "id", "value": id } } }));
    let found = resolve(&herdr, &files, &ResolverContext::new(agent_env)).await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["agent"], json!("agy"));
    assert_eq!(found["session"]["value"], json!(id));
    assert!(found["file"]["path"].as_str().unwrap().ends_with(&format!("{id}.db")));
}

#[tokio::test]
async fn resolves_antigravity_session_via_cwd_fallback_when_agent_session_is_missing() {
    let root = tempfile::tempdir().unwrap();
    let id = "session-fallback-cwd";
    crate::antigravity::tests::synthetic_db(root.path(), id, "/workspace/fallback-dir", 1726272000, "m");
    let agent_env = agy_env(root.path());
    let files = LocalSessionFiles { env: agent_env.clone() };
    let herdr = Herdr(json!({ "agent": { "agent": "antigravity", "cwd": "/workspace/fallback-dir" } }));
    let found = resolve(&herdr, &files, &ResolverContext::new(agent_env)).await;
    assert_eq!(found["status"], json!("ok"));
    assert_eq!(found["agent"], json!("agy"));
    assert_eq!(found["session"]["value"], json!(id));
}

#[tokio::test]
async fn returns_missing_session_with_integration_command_when_session_cannot_be_resolved() {
    let root = tempfile::tempdir().unwrap();
    let agent_env = agy_env(root.path());
    let files = LocalSessionFiles { env: agent_env.clone() };
    let herdr = Herdr(json!({ "agent": { "agent": "agy", "cwd": "" } }));
    let found = resolve(&herdr, &files, &ResolverContext::new(agent_env)).await;
    assert_eq!(found["status"], json!("missing_session"));
    assert_eq!(found["command"], json!("herdr integration install antigravity-cli"));
}
