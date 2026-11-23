//! agent-activity.test.ts.

use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::time::SystemTime;

use serde_json::json;

use super::*;
use crate::files::{BoxFut, local_stat};
use crate::handlers::AgentSessionHandlers;
use crate::resolver::HerdrCall;
use crate::session::SessionFile;

type Stat = Arc<dyn Fn(String) -> BoxFut<'static, io::Result<Option<SessionFile>>> + Send + Sync>;

/// Session files that only stat: activity must never read a transcript.
struct StatOnly {
    remote: bool,
    stat: Stat,
}

fn stat_only(remote: bool, stat: Stat) -> Arc<dyn SessionFiles> {
    Arc::new(StatOnly { remote, stat })
}

fn no_reads<T>() -> BoxFut<'static, io::Result<T>> {
    Box::pin(async { Err(io::Error::other("Activity must not read transcripts")) })
}

impl SessionFiles for StatOnly {
    fn remote(&self) -> bool {
        self.remote
    }
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        (self.stat)(path.to_owned())
    }
    fn read_text<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<String>> {
        no_reads()
    }
    fn read_prefix<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        no_reads()
    }
    fn read_tail<'a>(&'a self, _: &'a str, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        no_reads()
    }
    fn read_range<'a>(&'a self, _: &'a str, _: u64, _: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        no_reads()
    }
    fn read_download<'a>(&'a self, _: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        no_reads()
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

fn agent(pane_id: &str, path: &str, seq: i64) -> Value {
    json!({
        "pane_id": pane_id,
        "terminal_id": format!("terminal-{pane_id}"),
        "agent": "codex",
        "agent_status": "idle",
        "state_change_seq": seq,
        "agent_session": { "agent": "codex", "kind": "path", "value": path },
    })
}

struct Herdr(Arc<Mutex<Value>>);

impl HerdrCall for Herdr {
    fn call(
        &self,
        method: &str,
        params: Value,
        _: Option<u64>,
    ) -> BoxFut<'_, Result<Value, String>> {
        // No per-pane agent.get requests.
        assert_eq!(method, "agent.list");
        assert_eq!(params, json!({ "workspace": "example" }));
        let agents = self.0.lock().unwrap().clone();
        Box::pin(async move { Ok(json!({ "agents": agents, "extra": "preserved" })) })
    }
}

fn handlers(
    agents: Arc<Mutex<Value>>,
    files: Arc<dyn SessionFiles>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
) -> AgentSessionHandlers {
    AgentSessionHandlers::new(
        Arc::new(Herdr(agents)),
        files,
        Arc::new(ResolverContext::default()),
        None,
        now,
    )
}

async fn list(handlers: &AgentSessionHandlers) -> Value {
    handlers
        .list_with_activity(json!({ "workspace": "example" }))
        .await
        .map_err(|error| error.message)
        .unwrap()
}

fn shared(value: Value) -> Arc<Mutex<Value>> {
    Arc::new(Mutex::new(value))
}

fn local() -> Arc<dyn SessionFiles> {
    stat_only(
        false,
        Arc::new(|path| Box::pin(async move { Ok(local_stat(&path)) })),
    )
}

fn real_now() -> Arc<dyn Fn() -> f64 + Send + Sync> {
    Arc::new(js::now_ms)
}

fn set_mtime(path: &std::path::Path, seconds: u64) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
        .unwrap();
}

#[tokio::test]
async fn stats_current_files_across_refreshes_and_fresh_bridge_instances_despite_sequence_churn() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join("old.jsonl");
    let recent = root.path().join("recent.jsonl");
    std::fs::write(&old, "old transcript").unwrap();
    std::fs::write(&recent, "recent transcript").unwrap();
    set_mtime(&old, 1000);
    set_mtime(&recent, 2000);
    let snapshot = shared(json!([
        agent("old", old.to_str().unwrap(), 482),
        agent("recent", recent.to_str().unwrap(), 474),
    ]));
    let bridge = handlers(snapshot.clone(), local(), real_now());
    let times = |value: &Value| -> Vec<Value> {
        value["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|agent| agent["last_activity_at"].clone())
            .collect()
    };
    assert_eq!(
        times(&list(&bridge).await),
        vec![json!(1000000), json!(2000000)]
    );
    snapshot.lock().unwrap()[0]["state_change_seq"] = json!(900);
    let fresh = handlers(snapshot.clone(), local(), real_now());
    assert_eq!(
        list(&fresh).await["agents"][0]["last_activity_at"],
        json!(1000000)
    );
    set_mtime(&recent, 3000);
    assert_eq!(
        list(&bridge).await["agents"][1]["last_activity_at"],
        json!(3000000)
    );
    std::fs::remove_file(&recent).unwrap();
    assert!(
        list(&bridge).await["agents"][1]
            .get("last_activity_at")
            .is_none()
    );
    assert!(
        snapshot.lock().unwrap()[0]
            .get("last_activity_at")
            .is_none()
    );
}

#[tokio::test]
async fn keeps_missing_failed_and_unsupported_sessions_without_fabricated_activity() {
    let mut unsupported = agent("unsupported", "/unsupported", 1);
    unsupported["agent"] = json!("unknown");
    let mut no_session = agent("no-session", "/unused", 1);
    no_session["agent_session"] = Value::Null;
    let snapshot = json!([
        agent("good", "/good", 1),
        agent("missing", "/missing", 1),
        agent("denied", "/denied", 1),
        unsupported,
        no_session,
        null,
    ]);
    let files = stat_only(
        false,
        Arc::new(|path| {
            Box::pin(async move {
                match path.as_str() {
                    "/denied" => Err(io::Error::other("Permission denied")),
                    "/good" => Ok(Some(SessionFile {
                        path,
                        mtime_ms: 1234.0,
                        ..Default::default()
                    })),
                    _ => Ok(None),
                }
            })
        }),
    );
    let result = list(&handlers(shared(snapshot.clone()), files, real_now())).await;
    assert_eq!(result["extra"], json!("preserved"));
    let mut expected = snapshot.as_array().unwrap().clone();
    expected[0]["last_activity_at"] = json!(1234);
    assert_eq!(result["agents"], Value::Array(expected));
}

#[tokio::test]
async fn uses_connection_specific_file_access_and_never_resolves_remote_ids_against_local_sessions()
{
    let mut by_id = agent("id", "/unused", 1);
    by_id["agent_session"] = json!({ "kind": "id", "value": "local-id" });
    let snapshot = json!([agent("path", "/remote/session", 1), by_id]);
    let paths = Arc::new(Mutex::new(Vec::<String>::new()));
    let files = |mtime: f64| {
        let paths = paths.clone();
        stat_only(
            true,
            Arc::new(move |path| {
                paths.lock().unwrap().push(path.clone());
                Box::pin(async move {
                    Ok(Some(SessionFile {
                        path,
                        mtime_ms: mtime,
                        ..Default::default()
                    }))
                })
            }),
        )
    };
    let result = list(&handlers(
        shared(snapshot.clone()),
        files(100.0),
        real_now(),
    ))
    .await;
    let mut expected = snapshot.as_array().unwrap().clone();
    expected[0]["last_activity_at"] = json!(100);
    assert_eq!(result["agents"], Value::Array(expected));
    let again = list(&handlers(shared(snapshot), files(200.0), real_now())).await;
    assert_eq!(again["agents"][0]["last_activity_at"], json!(200));
    assert_eq!(
        *paths.lock().unwrap(),
        vec!["/remote/session", "/remote/session"]
    );
}

#[tokio::test]
async fn over_ssh_reuses_an_agents_activity_time_while_its_state_stays() {
    let paths = Arc::new(AtomicUsize::new(0));
    let mtime = Arc::new(AtomicU64::new(100));
    let files = {
        let (paths, mtime) = (paths.clone(), mtime.clone());
        stat_only(
            true,
            Arc::new(move |path| {
                paths.fetch_add(1, Ordering::SeqCst);
                let mtime = mtime.load(Ordering::SeqCst) as f64;
                Box::pin(async move {
                    Ok(Some(SessionFile {
                        path,
                        mtime_ms: mtime,
                        ..Default::default()
                    }))
                })
            }),
        )
    };
    let now = Arc::new(AtomicU64::new(js::now_ms() as u64));
    let snapshot = shared(json!([agent("path", "/remote/session", 1)]));
    let handler = {
        let now = now.clone();
        handlers(
            snapshot.clone(),
            files,
            Arc::new(move || now.load(Ordering::SeqCst) as f64),
        )
    };
    let time = || async { list(&handler).await["agents"][0]["last_activity_at"].clone() };
    assert_eq!(time().await, json!(100));
    mtime.store(200, Ordering::SeqCst);
    assert_eq!(time().await, json!(100));
    assert_eq!(paths.load(Ordering::SeqCst), 1);
    // Its agent changed state: stat again.
    *snapshot.lock().unwrap() = json!([agent("path", "/remote/session", 2)]);
    assert_eq!(time().await, json!(200));
    assert_eq!(paths.load(Ordering::SeqCst), 2);
    mtime.store(300, Ordering::SeqCst);
    now.fetch_add(REMOTE_ACTIVITY_REUSE_MS as u64, Ordering::SeqCst);
    assert_eq!(time().await, json!(300));
    assert_eq!(paths.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn bounds_concurrent_stats_while_preserving_the_source_ordering() {
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let snapshot: Vec<Value> = (0..12)
        .map(|i| agent(&format!("p{i}"), &format!("/p{i}"), 1))
        .collect();
    let files = {
        let (active, peak) = (active.clone(), peak.clone());
        stat_only(
            false,
            Arc::new(move |path| {
                let (active, peak) = (active.clone(), peak.clone());
                Box::pin(async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(Some(SessionFile {
                        path,
                        mtime_ms: 1000.0,
                        ..Default::default()
                    }))
                })
            }),
        )
    };
    let result = list(&handlers(
        shared(Value::Array(snapshot.clone())),
        files,
        real_now(),
    ))
    .await;
    assert!(peak.load(Ordering::SeqCst) <= 4);
    let panes: Vec<&Value> = result["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["pane_id"])
        .collect();
    let expected: Vec<&Value> = snapshot.iter().map(|a| &a["pane_id"]).collect();
    assert_eq!(panes, expected);
}

#[tokio::test]
async fn slow_activity_lookups_return_all_agents_promptly_and_stop_scheduling_work() {
    let snapshot: Vec<Value> = (0..10)
        .map(|i| agent(&format!("p{i}"), &format!("/p{i}"), 1))
        .collect();
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Notify::new());
    let files = {
        let (calls, gate) = (calls.clone(), gate.clone());
        stat_only(
            false,
            Arc::new(move |path| {
                calls.fetch_add(1, Ordering::SeqCst);
                let gate = gate.clone();
                Box::pin(async move {
                    gate.notified().await;
                    Ok(Some(SessionFile {
                        path,
                        mtime_ms: 1234.0,
                        ..Default::default()
                    }))
                })
            }),
        )
    };
    let input = json!({ "agents": snapshot });
    let result = enrich_agent_activity(
        input.clone(),
        files.as_ref(),
        &ResolverContext::default(),
        &RemoteActivity::default(),
        Duration::from_millis(1),
        &js::now_ms,
    )
    .await;
    assert_eq!(result, input);
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    gate.notify_waiters();
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert_eq!(result, input);
}
