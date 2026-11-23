//! The worktree RPC flows of index.ts (`worktree.open`, `worktree.remove`).

use std::fs;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::connection::testing::FakeHerdr;
use crate::worktree::testing::{connection_with, shell_runner};

fn callbacks() -> WorktreeCallbacks {
    WorktreeCallbacks {
        resolve_git_root: Arc::new(|_| Box::pin(async { Ok("/repo".to_owned()) })),
        place_created: None,
    }
}

fn current() -> Guard {
    Arc::new(|| true)
}

#[tokio::test]
async fn opening_a_worktree_records_its_parent_and_runs_its_opened_hook() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    fs::write(
        checkout.join("roamgate.json"),
        r#"{"worktree":{"opened":"printf opened"}}"#,
    )
    .unwrap();
    let checkout = checkout.to_str().unwrap().to_owned();
    let opened = json!({ "workspace": {
        "workspace_id": "w2",
        "worktree": { "is_linked_worktree": true, "checkout_path": checkout, "repo_key": "/repo/.git" },
    } });
    let answer = opened.clone();
    let herdr = FakeHerdr::new(move |method, _| match method {
        "worktree.open" => Ok(answer.clone()),
        _ => Ok(json!({ "workspace": { "workspace_id": "w1", "cwd": "/repo" } })),
    });
    let conn = connection_with(None, shell_runner(None), herdr.clone(), json!({}));
    let result = Worktrees::default()
        .rpc(
            &conn,
            "worktree.open",
            &json!({ "workspace_id": "w1", "path": checkout }),
            &current(),
            &callbacks(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["workspace"], opened["workspace"]);
    assert_eq!(result["opened_hook"]["status"], "succeeded");
    assert_eq!(herdr.methods(), ["workspace.get", "worktree.open"]);
    let settings = conn.settings.read().await;
    let records = &settings.custom().unwrap()["worktree_parent_by_checkout"];
    assert_eq!(records[format!("local:{checkout}")], "w1");
}

#[tokio::test]
async fn a_failed_before_remove_hook_skips_the_removal() {
    let dir = tempfile::tempdir().unwrap();
    let checkout = dir.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    fs::write(
        checkout.join("roamgate.json"),
        r#"{"worktree":{"teardown":"exit 3"}}"#,
    )
    .unwrap();
    let checkout = checkout.to_str().unwrap().to_owned();
    let workspace = json!({ "workspace": {
        "workspace_id": "w2",
        "worktree": { "is_linked_worktree": true, "checkout_path": checkout, "repo_root": "/repo" },
    } });
    let herdr = FakeHerdr::new(move |_, _| Ok(workspace.clone()));
    let conn = connection_with(None, shell_runner(None), herdr.clone(), json!({}));
    let result = Worktrees::default()
        .rpc(
            &conn,
            "worktree.remove",
            &json!({ "workspace_id": "w2" }),
            &current(),
            &callbacks(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["skipped_remove"], true);
    assert_eq!(result["before_remove_hook"]["status"], "failed");
    assert_eq!(result["before_remove_hook"]["exit_code"], 3);
    assert_eq!(herdr.methods(), ["workspace.get"]);
}

#[tokio::test]
async fn a_removal_without_a_linked_worktree_is_herdr_s_and_skips_the_hooks() {
    let herdr = FakeHerdr::new(|method, _| match method {
        "workspace.get" => Ok(json!({ "workspace": { "workspace_id": "w1", "cwd": "/repo" } })),
        _ => Ok(json!({ "type": "worktree_removed" })),
    });
    let conn = connection_with(None, shell_runner(None), herdr.clone(), json!({}));
    let result = Worktrees::default()
        .rpc(
            &conn,
            "worktree.remove",
            &json!({ "workspace_id": "w1" }),
            &current(),
            &callbacks(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result,
        json!({
            "type": "worktree_removed",
            "before_remove_hook": { "event": "worktree.before_remove", "status": "skipped" },
            "removed_hook": { "event": "worktree.removed", "status": "skipped" },
        })
    );
    assert_eq!(herdr.methods(), ["workspace.get", "worktree.remove"]);
    let error = Worktrees::default()
        .rpc(
            &conn,
            "worktree.remove",
            &json!({}),
            &current(),
            &callbacks(),
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.message, "worktree.remove requires workspace_id");
}
