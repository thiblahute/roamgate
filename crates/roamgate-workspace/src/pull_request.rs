//! `git.pull_request` (files.ts `readWorkspacePullRequest`): the checkout's
//! pull or merge request through roamgate-forge's
//! [`PullRequests`](roamgate_forge::pull_request::PullRequests), in the
//! workspace's Git root or in one of its repository's worktrees that Herdr
//! lists.

use std::sync::Arc;

use roamgate_forge::mr_cache::iso_time;
use roamgate_forge::pull_request::{CardCache, Checkout, PullRequests};
use serde_json::{Map, Value, json};

use crate::connection::{RpcResult, WorkspaceConnection, WorkspaceError};

/// The answer of a worktree that cannot be looked up: a definite answer,
/// unlike transport failures, so the browser does not keep showing that
/// target's previous request as last known.
fn unavailable(reader: &PullRequests, state: &str, root: &str, message: &str) -> Value {
    json!({
        "state": state,
        "root": root,
        "branch": "",
        "remotes": [],
        "refreshedAt": iso_time(reader.clock().now()),
        "message": message,
    })
}

/// The request status of `root` (the workspace's Git root, resolved by
/// the caller), or of `params.worktree_path` when it names a worktree of
/// the workspace's repository. The browser is answered "Cannot resolve
/// this workspace's Git checkout." on any error (index.ts), which only
/// the caller says.
pub async fn read_workspace_pull_request(
    conn: &WorkspaceConnection,
    reader: &Arc<PullRequests>,
    cache: &dyn CardCache,
    root: &str,
    params: &Value,
) -> RpcResult {
    let mut root = root.to_owned();
    if let Some(wanted) = params.get("worktree_path") {
        let mut args = Map::new();
        if let Some(workspace) = params.get("workspace_id") {
            args.insert("workspace_id".into(), workspace.clone());
        }
        let listed = conn
            .herdr_call("worktree.list", Value::Object(args), None)
            .await
            .map_err(WorkspaceError::new)?;
        let worktree = listed
            .get("worktrees")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().find(|entry| entry.get("path") == Some(wanted)));
        let Some(worktree) = worktree else {
            return Ok(unavailable(
                reader,
                "error",
                "",
                "Worktree is unavailable in this repository.",
            ));
        };
        let path = worktree.get("path").and_then(Value::as_str).unwrap_or("");
        if worktree.get("is_bare") == Some(&Value::Bool(true))
            || worktree.get("is_prunable") == Some(&Value::Bool(true))
        {
            return Ok(unavailable(
                reader,
                "unsupported",
                path,
                "Bare or prunable worktrees cannot resolve PR/MR status.",
            ));
        }
        root = path.to_owned();
    }
    let params = params.as_object().cloned().unwrap_or_default();
    reader
        .shared_status(&Checkout::new(conn.git.clone(), root), &params, cache)
        .await
        .map_err(WorkspaceError::new)
}

#[cfg(test)]
mod tests;
