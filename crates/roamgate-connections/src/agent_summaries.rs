//! The agents of every connection at once (connections/agent-sessions.ts
//! and connections/agent-tasks.ts): the Workspaces list's summary of each
//! ready connection, read without changing a browser's active connection
//! or starting runtimes, and the side tasks of agents on any connection in
//! one batch.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::{Map, Value, json};

use crate::BoxFuture;
use crate::manager::{ConnectionManager, ConnectionRuntime, sanitize_connection_error};

/// What a summary reads of a connection's runtime.
pub trait SummaryRuntime: Send + Sync {
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> BoxFuture<Result<Value, String>>;
    /// `windows` for a remote Windows host.
    fn remote_platform(&self) -> Option<String> {
        None
    }
    /// The worktree parents laid over a workspace list; None: no reader.
    fn enrich_worktree_parents(&self, _result: Value) -> Option<BoxFuture<Result<Value, String>>> {
        None
    }
    /// Git status laid over a workspace list.
    fn enrich_git_status(&self, result: Value) -> BoxFuture<Result<Value, String>>;
    /// The agents with their durable activity (`listWithActivity`).
    fn list_with_activity(&self, params: Value) -> BoxFuture<Result<Value, String>>;
}

fn windows(runtime: &dyn SummaryRuntime) -> bool {
    runtime.remote_platform().as_deref() == Some("windows")
}

/// `readConnectionAgentSessions`: `{connections: [...]}` of the ready
/// connections still current once read.
pub async fn read_connection_agent_sessions<R>(manager: &ConnectionManager<R>) -> Value
where
    R: ConnectionRuntime + SummaryRuntime,
{
    let reads = manager.list().into_iter().map(|connection| async move {
        let lease = manager.ready_runtime_lease(&connection.id).ok().flatten()?;
        let mut identity = Map::new();
        identity.insert("connection_id".into(), json!(connection.id));
        identity.insert("connection_generation".into(), json!(lease.generation));
        let runtime = lease.runtime.clone();
        let snapshot = match read_one(runtime.as_ref()).await {
            Ok((workspaces, tabs, panes, agents)) => {
                let mut snapshot = identity;
                snapshot.insert("workspaces".into(), workspaces);
                snapshot.insert("tabs".into(), tabs);
                snapshot.insert("panes".into(), panes);
                snapshot.insert("agents".into(), agents);
                snapshot
            }
            Err(error) => {
                let mut snapshot = identity;
                snapshot.insert("workspaces".into(), json!([]));
                snapshot.insert("tabs".into(), json!([]));
                snapshot.insert("panes".into(), json!([]));
                snapshot.insert("agents".into(), Value::Null);
                snapshot.insert("error".into(), json!(sanitize_connection_error(&error)));
                snapshot
            }
        };
        Some((lease, snapshot))
    });
    let results = join_all(reads).await;
    let connections: Vec<Value> = results
        .into_iter()
        .flatten()
        .filter(|(lease, _)| lease.is_current())
        .map(|(_, snapshot)| Value::Object(snapshot))
        .collect();
    json!({"connections": connections})
}

async fn read_one(runtime: &dyn SummaryRuntime) -> Result<(Value, Value, Value, Value), String> {
    let agents = async {
        let read = if windows(runtime) {
            runtime.herdr_call("agent.list", json!({}), 5000).await
        } else {
            runtime.list_with_activity(json!({})).await
        };
        read.unwrap_or(Value::Null)
    };
    let (workspaces, tabs, panes, agents) = tokio::join!(
        runtime.herdr_call("workspace.list", json!({}), 5000),
        runtime.herdr_call("tab.list", json!({}), 5000),
        runtime.herdr_call("pane.list", json!({}), 5000),
        agents,
    );
    let (workspaces, tabs, panes) = (workspaces?, tabs?, panes?);
    let list = |value: &Value, key: &str| value.get(key).filter(|list| list.is_array()).cloned();
    let (Some(_), Some(tabs), Some(panes)) = (
        list(&workspaces, "workspaces"),
        list(&tabs, "tabs"),
        list(&panes, "panes"),
    ) else {
        return Err("Invalid session list from Herdr".into());
    };
    let mut enriched = match runtime.enrich_worktree_parents(workspaces.clone()) {
        Some(read) => read.await?,
        None => workspaces,
    };
    if !windows(runtime) {
        enriched = runtime.enrich_git_status(enriched).await?;
    }
    let workspaces = enriched.get("workspaces").cloned().unwrap_or(Value::Null);
    Ok((workspaces, tabs, panes, agents))
}

/// A Workspaces list asks for many agents at once; bound the batch.
pub const AGENT_TASKS_BATCH_MAX: usize = 64;
const READ_TIMEOUT: Duration = Duration::from_millis(5000);

/// What the batch reads of a connection's runtime.
pub trait TasksRuntime: Send + Sync {
    /// `{tasks?, session?, partial?}` of a pane's session.
    fn read_tasks(&self, params: Value) -> BoxFuture<Result<Value, String>>;
    /// `windows` for a remote Windows host.
    fn remote_platform(&self) -> Option<String> {
        None
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}

/// What a browser is shown of a task (`AgentTaskSummary`).
fn summary(task: &Value) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), task.get("id").cloned().unwrap_or(Value::Null));
    out.insert(
        "kind".into(),
        task.get("kind").cloned().unwrap_or(Value::Null),
    );
    let title = text(task.get("title"));
    out.insert(
        "title".into(),
        json!(roamgate_base::log::slice_utf16(&title, 200)),
    );
    out.insert(
        "status".into(),
        task.get("status").cloned().unwrap_or(Value::Null),
    );
    for key in ["name", "startedAt", "resumedAt", "endedAt"] {
        if let Some(value) = task
            .get(key)
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        {
            out.insert(key.into(), value.clone());
        }
    }
    if task.get("rewound") == Some(&Value::Bool(true)) {
        out.insert("rewound".into(), json!(true));
    }
    Value::Object(out)
}

/// `readConnectionAgentTasks`: `{results: [...]}`, one per request with a
/// connection and a pane.
pub async fn read_connection_agent_tasks<R, F>(ready_runtime: F, params: &Value) -> Value
where
    R: TasksRuntime + ?Sized,
    F: Fn(&str) -> Option<Arc<R>>,
{
    let requests: Vec<Value> = params
        .get("requests")
        .and_then(Value::as_array)
        .map(|requests| {
            requests
                .iter()
                .take(AGENT_TASKS_BATCH_MAX)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let reads = requests.into_iter().map(|request| {
        let connection_id = text(request.get("connection_id"));
        let pane_id = text(request.get("pane_id"));
        let agent = text(request.get("agent"));
        let runtime = (!connection_id.is_empty())
            .then(|| ready_runtime(&connection_id))
            .flatten();
        async move {
            if connection_id.is_empty() || pane_id.is_empty() {
                return None;
            }
            let mut out = Map::new();
            out.insert("connection_id".into(), json!(connection_id));
            out.insert("pane_id".into(), json!(pane_id));
            // Only Claude sessions record their side tasks.
            if agent != "claude" {
                out.insert("tasks".into(), json!([]));
                return Some(Value::Object(out));
            }
            let Some(runtime) =
                runtime.filter(|runtime| runtime.remote_platform().as_deref() != Some("windows"))
            else {
                out.insert("error".into(), json!("connection not ready"));
                return Some(Value::Object(out));
            };
            let read = runtime.read_tasks(json!({
                "pane_id": pane_id,
                "workspace_id": text(request.get("workspace_id")),
                "tab_id": text(request.get("tab_id")),
                "agent": agent,
            }));
            match tokio::time::timeout(READ_TIMEOUT, read).await {
                Ok(Ok(result)) => {
                    out.insert(
                        "session".into(),
                        result.get("session").cloned().unwrap_or(Value::Null),
                    );
                    let tasks: Vec<Value> = result
                        .get("tasks")
                        .and_then(Value::as_array)
                        .map(|tasks| tasks.iter().map(summary).collect())
                        .unwrap_or_default();
                    out.insert("tasks".into(), Value::Array(tasks));
                    // Read from part of the session: ask again shortly.
                    if result.get("partial") == Some(&Value::Bool(true)) {
                        out.insert("partial".into(), json!(true));
                    }
                }
                Ok(Err(error)) => {
                    out.insert("error".into(), json!(error));
                }
                Err(_) => {
                    out.insert("error".into(), json!("timed out"));
                }
            }
            Some(Value::Object(out))
        }
    });
    let results: Vec<Value> = join_all(reads).await.into_iter().flatten().collect();
    json!({"results": results})
}

#[cfg(test)]
mod tests;
