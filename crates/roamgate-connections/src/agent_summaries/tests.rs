//! server/src/connections/agent-sessions.test.ts and agent-tasks.test.ts.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::FutureExt;

use super::*;
use crate::manager::{ConnectionIdentity, RuntimeError};

type Reply = Arc<dyn Fn(&str) -> BoxFuture<Result<Value, String>> + Send + Sync>;

#[derive(Default)]
struct Shared {
    calls: Mutex<Vec<String>>,
    replies: Mutex<HashMap<String, Reply>>,
    parents: Mutex<HashMap<String, String>>,
    windows: Mutex<Vec<String>>,
    git_reads: Mutex<Vec<String>>,
    activity_reads: Mutex<Vec<String>>,
    activity_results: Mutex<HashMap<String, Value>>,
}

struct Fake {
    id: String,
    shared: Arc<Shared>,
}

impl ConnectionRuntime for Fake {
    fn identity(&self) -> ConnectionIdentity {
        ConnectionIdentity::new(&self.id, &self.id, "test")
    }
    fn start_transport(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<(), RuntimeError>> {
        async { Ok(()) }.boxed()
    }
    fn start_background(
        &self,
    ) -> futures_util::future::BoxFuture<'static, Result<(), RuntimeError>> {
        async { Ok(()) }.boxed()
    }
    fn stop(&self) -> futures_util::future::BoxFuture<'static, Result<(), RuntimeError>> {
        async { Ok(()) }.boxed()
    }
}

fn plural(method: &str) -> String {
    format!("{}s", method.split('.').next().unwrap())
}

impl SummaryRuntime for Fake {
    fn herdr_call(
        &self,
        method: &str,
        _params: Value,
        timeout_ms: u64,
    ) -> BoxFuture<Result<Value, String>> {
        assert_eq!(timeout_ms, 5000);
        self.shared
            .calls
            .lock()
            .unwrap()
            .push(format!("{}:{method}", self.id));
        let reply = self.shared.replies.lock().unwrap().get(&self.id).cloned();
        let method = method.to_owned();
        match reply {
            Some(reply) => reply(&method),
            None => Box::pin(async move {
                let mut out = Map::new();
                out.insert(plural(&method), json!([{"id": "same-id"}]));
                Ok(Value::Object(out))
            }),
        }
    }
    fn remote_platform(&self) -> Option<String> {
        self.shared
            .windows
            .lock()
            .unwrap()
            .contains(&self.id)
            .then(|| "windows".to_owned())
    }
    fn enrich_worktree_parents(&self, result: Value) -> Option<BoxFuture<Result<Value, String>>> {
        let parent = self.shared.parents.lock().unwrap().get(&self.id).cloned();
        Some(Box::pin(async move {
            let mut result = result;
            if let Some(parent) = parent
                && let Some(list) = result["workspaces"].as_array_mut()
            {
                for workspace in list {
                    workspace["worktree"] = json!({"parent_workspace_id": parent});
                }
            }
            Ok(result)
        }))
    }
    fn enrich_git_status(&self, result: Value) -> BoxFuture<Result<Value, String>> {
        self.shared.git_reads.lock().unwrap().push(self.id.clone());
        let id = self.id.clone();
        Box::pin(async move {
            let mut result = result;
            if let Some(list) = result["workspaces"].as_array_mut() {
                for workspace in list {
                    let mut worktree = workspace
                        .get("worktree")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    worktree["git_status"] =
                        json!({"branch": format!("{id}/main"), "dirty": true, "untracked": 2});
                    workspace["worktree"] = worktree;
                }
            }
            Ok(result)
        })
    }
    fn list_with_activity(&self, params: Value) -> BoxFuture<Result<Value, String>> {
        assert_eq!(params, json!({}));
        self.shared
            .activity_reads
            .lock()
            .unwrap()
            .push(self.id.clone());
        if let Some(result) = self.shared.activity_results.lock().unwrap().get(&self.id) {
            let result = result.clone();
            return Box::pin(async move { Ok(result) });
        }
        if let Some(reply) = self.shared.replies.lock().unwrap().get(&self.id).cloned() {
            return reply("agent.list");
        }
        Box::pin(async { Ok(json!({"agents": [{"id": "same-id"}]})) })
    }
}

fn fixture() -> (ConnectionManager<Fake>, Arc<Shared>) {
    let shared = Arc::new(Shared::default());
    let manager = ConnectionManager::new("alpha", None, None);
    for id in ["alpha", "beta", "offline"] {
        let shared = shared.clone();
        let owned = id.to_owned();
        manager
            .register(
                ConnectionIdentity::new(id, id, "test"),
                Arc::new(move |_| {
                    Ok(Arc::new(Fake {
                        id: owned.clone(),
                        shared: shared.clone(),
                    }))
                }),
            )
            .unwrap();
    }
    (manager, shared)
}

async fn start_both(manager: &ConnectionManager<Fake>) {
    let (a, b) = tokio::join!(manager.start("alpha"), manager.start("beta"));
    a.unwrap();
    b.unwrap();
}

fn ids(result: &Value) -> Vec<String> {
    result["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["connection_id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn summarizes_only_ready_connections_without_switching_or_starting_others() {
    let (manager, shared) = fixture();
    shared
        .parents
        .lock()
        .unwrap()
        .insert("alpha".into(), "alpha-parent".into());
    shared
        .parents
        .lock()
        .unwrap()
        .insert("beta".into(), "beta-parent".into());
    start_both(&manager).await;
    let result = read_connection_agent_sessions(&manager).await;
    assert_eq!(ids(&result), vec!["alpha", "beta"]);
    let connections = result["connections"].as_array().unwrap();
    assert_eq!(
        connections[0]["connection_generation"],
        json!(manager.status("alpha").unwrap().generation)
    );
    assert_eq!(connections[0]["panes"], json!([{"id": "same-id"}]));
    assert_eq!(connections[1]["panes"], connections[0]["panes"]);
    assert_eq!(
        connections[0]["workspaces"][0]["worktree"]["parent_workspace_id"],
        json!("alpha-parent")
    );
    assert_eq!(
        connections[1]["workspaces"][0]["worktree"]["parent_workspace_id"],
        json!("beta-parent")
    );
    assert_eq!(
        connections[0]["workspaces"][0]["worktree"]["git_status"],
        json!({"branch": "alpha/main", "dirty": true, "untracked": 2})
    );
    assert_eq!(
        connections[1]["workspaces"][0]["worktree"]["git_status"],
        json!({"branch": "beta/main", "dirty": true, "untracked": 2})
    );
    assert_eq!(manager.default_id(), "alpha");
    assert_eq!(
        serde_json::to_value(manager.status("offline").unwrap().state).unwrap(),
        json!("disconnected")
    );
    assert_eq!(shared.calls.lock().unwrap().len(), 6);
    assert_eq!(
        *shared.activity_reads.lock().unwrap(),
        vec!["alpha", "beta"]
    );
    manager.stop_all().await.unwrap();
}

#[tokio::test]
async fn contains_read_failures_and_tolerates_missing_optional_agent_metadata() {
    let (manager, shared) = fixture();
    shared.replies.lock().unwrap().insert(
        "alpha".into(),
        Arc::new(|_| Box::pin(async { Err("password=hidden failed".to_owned()) })),
    );
    shared.replies.lock().unwrap().insert(
        "beta".into(),
        Arc::new(|method| {
            let method = method.to_owned();
            Box::pin(async move {
                if method == "agent.list" {
                    return Err("unsupported".to_owned());
                }
                let mut out = Map::new();
                out.insert(plural(&method), json!([]));
                Ok(Value::Object(out))
            })
        }),
    );
    start_both(&manager).await;
    let result = read_connection_agent_sessions(&manager).await;
    let connections = result["connections"].as_array().unwrap();
    assert_eq!(connections[0]["panes"], json!([]));
    assert_eq!(connections[0]["error"], json!("password=*** failed"));
    assert_eq!(connections[1]["panes"], json!([]));
    assert_eq!(connections[1]["agents"], Value::Null);
    assert!(connections[1].get("error").is_none());
    shared.replies.lock().unwrap().insert(
        "beta".into(),
        Arc::new(|_| Box::pin(async { Ok(json!({})) })),
    );
    let again = read_connection_agent_sessions(&manager).await;
    assert_eq!(again["connections"][1]["panes"], json!([]));
    assert_eq!(
        again["connections"][1]["error"],
        json!("Invalid session list from Herdr")
    );
    manager.stop_all().await.unwrap();
}

#[tokio::test]
async fn discards_a_retired_runtime_even_if_its_read_finishes_before_other_servers() {
    let (manager, shared) = fixture();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
    let started_tx = Arc::new(Mutex::new(Some(started_tx)));
    let (finish_tx, finish_rx) = tokio::sync::watch::channel(false);
    shared.replies.lock().unwrap().insert(
        "beta".into(),
        Arc::new(move |method| {
            if let Some(tx) = started_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            let mut finish = finish_rx.clone();
            let method = method.to_owned();
            Box::pin(async move {
                let _ = finish.wait_for(|done| *done).await;
                let mut out = Map::new();
                out.insert(plural(&method), json!([]));
                Ok(Value::Object(out))
            })
        }),
    );
    start_both(&manager).await;
    let read = tokio::spawn({
        let manager = manager.clone();
        async move { read_connection_agent_sessions(&manager).await }
    });
    started_rx.await.unwrap();
    manager.stop("alpha").await.unwrap();
    finish_tx.send(true).unwrap();
    let result = read.await.unwrap();
    assert_eq!(ids(&result), vec!["beta"]);
    manager.stop_all().await.unwrap();
}

#[tokio::test]
async fn windows_summaries_use_raw_agents_and_skip_unix_enrichment() {
    let (manager, shared) = fixture();
    shared.windows.lock().unwrap().push("alpha".into());
    shared
        .parents
        .lock()
        .unwrap()
        .insert("alpha".into(), "alpha-parent".into());
    start_both(&manager).await;
    let result = read_connection_agent_sessions(&manager).await;
    assert_eq!(*shared.git_reads.lock().unwrap(), vec!["beta"]);
    assert_eq!(*shared.activity_reads.lock().unwrap(), vec!["beta"]);
    let calls = shared.calls.lock().unwrap().clone();
    assert!(calls.contains(&"alpha:agent.list".to_owned()));
    assert!(!calls.contains(&"beta:agent.list".to_owned()));
    let connections = result["connections"].as_array().unwrap();
    assert_eq!(
        connections[0]["agents"],
        json!({"agents": [{"id": "same-id"}]})
    );
    assert_eq!(
        connections[0]["workspaces"][0]["worktree"],
        json!({"parent_workspace_id": "alpha-parent"})
    );
    assert_eq!(
        connections[1]["workspaces"][0]["worktree"]["git_status"]["branch"],
        json!("beta/main")
    );
    manager.stop_all().await.unwrap();
}

#[tokio::test]
async fn preserves_each_unix_runtimes_durable_activity_metadata() {
    let (manager, shared) = fixture();
    let alpha = json!({"agents": [{"pane_id": "w1:p1", "state_change_seq": 999, "last_activity_at": 1000}]});
    let beta =
        json!({"agents": [{"pane_id": "w1:p1", "state_change_seq": 1, "last_activity_at": 2000}]});
    shared
        .activity_results
        .lock()
        .unwrap()
        .insert("alpha".into(), alpha.clone());
    shared
        .activity_results
        .lock()
        .unwrap()
        .insert("beta".into(), beta.clone());
    start_both(&manager).await;
    let result = read_connection_agent_sessions(&manager).await;
    let agents: Vec<Value> = result["connections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["agents"].clone())
        .collect();
    assert_eq!(agents, vec![alpha, beta]);
    manager.stop_all().await.unwrap();
}

struct Tasks {
    tasks: Vec<Value>,
    asked: Arc<Mutex<Vec<Value>>>,
}

impl TasksRuntime for Tasks {
    fn read_tasks(&self, params: Value) -> BoxFuture<Result<Value, String>> {
        self.asked.lock().unwrap().push(params);
        let tasks = self.tasks.clone();
        Box::pin(async move { Ok(json!({"session": "s1", "tasks": tasks})) })
    }
}

#[tokio::test]
async fn reads_side_tasks_of_agents_on_several_connections_in_one_batch() {
    let task = |id: &str, extra: Value| {
        let mut task = json!({
            "id": id,
            "kind": "agent",
            "title": format!("Task {id}"),
            "status": "running",
            "startedAt": "2026-10-31T10:00:00Z",
            "outputFile": "/tmp/secret-output",
            "summary": "long result",
        });
        for (key, value) in extra.as_object().unwrap() {
            task[key] = value.clone();
        }
        task
    };
    let asked = Arc::new(Mutex::new(Vec::new()));
    let mut runtimes: HashMap<&str, Arc<Tasks>> = HashMap::new();
    runtimes.insert(
        "local",
        Arc::new(Tasks {
            tasks: vec![
                task("a", json!({})),
                task("b", json!({"kind": "teammate", "name": "rev"})),
            ],
            asked: asked.clone(),
        }),
    );
    runtimes.insert(
        "desktop",
        Arc::new(Tasks {
            tasks: vec![
                task("c", json!({"status": "failed"})),
                task("d", json!({"rewound": true})),
            ],
            asked: asked.clone(),
        }),
    );
    let result = read_connection_agent_tasks(
        |id| runtimes.get(id).cloned(),
        &json!({"requests": [
            {"connection_id": "local", "pane_id": "p1", "workspace_id": "w1", "tab_id": "t1", "agent": "claude"},
            {"connection_id": "desktop", "pane_id": "p2", "agent": "claude"},
            {"connection_id": "local", "pane_id": "p3", "agent": "codex"},
            {"connection_id": "gone", "pane_id": "p4", "agent": "claude"},
            {"pane_id": "nameless"},
        ]}),
    )
    .await;
    let started = "2026-10-31T10:00:00Z";
    assert_eq!(
        result,
        json!({"results": [
            {"connection_id": "local", "pane_id": "p1", "session": "s1", "tasks": [
                {"id": "a", "kind": "agent", "title": "Task a", "status": "running", "startedAt": started},
                {"id": "b", "kind": "teammate", "title": "Task b", "status": "running", "name": "rev", "startedAt": started},
            ]},
            {"connection_id": "desktop", "pane_id": "p2", "session": "s1", "tasks": [
                {"id": "c", "kind": "agent", "title": "Task c", "status": "failed", "startedAt": started},
                {"id": "d", "kind": "agent", "title": "Task d", "status": "running", "startedAt": started, "rewound": true},
            ]},
            // Only Claude sessions record side tasks: nothing is read for others.
            {"connection_id": "local", "pane_id": "p3", "tasks": []},
            {"connection_id": "gone", "pane_id": "p4", "error": "connection not ready"},
        ]})
    );
    assert_eq!(
        *asked.lock().unwrap(),
        vec![
            json!({"pane_id": "p1", "workspace_id": "w1", "tab_id": "t1", "agent": "claude"}),
            json!({"pane_id": "p2", "workspace_id": "", "tab_id": "", "agent": "claude"}),
        ]
    );
}
