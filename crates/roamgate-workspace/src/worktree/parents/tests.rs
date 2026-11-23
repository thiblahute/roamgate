//! parents.test.ts.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use roamgate_base::settings::{Settings, repo_settings_key};
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::*;
use crate::connection::{BoxFuture, SettingsAccess, SettingsChange};
use crate::worktree::testing::{FnRunner, connection};

fn settings(path: &str, parent: &str, connection_id: Option<&str>) -> Settings {
    Settings::normalize(&json!({
        "custom": {
            CUSTOM_SETTINGS_KEY: { repo_settings_key(path, None, connection_id): parent }
        }
    }))
}

fn main_worktree() -> Value {
    json!({
        "repo_key": "/repo/.git",
        "repo_root": "/repo",
        "checkout_path": "/repo",
        "is_linked_worktree": false,
    })
}

fn linked_worktree(path: &str) -> Value {
    let mut worktree = main_worktree();
    worktree["checkout_path"] = path.into();
    worktree["is_linked_worktree"] = true.into();
    worktree
}

const LINKED: &str = "/worktrees/feature";

#[test]
fn attaches_the_persisted_source_when_a_repo_has_several_workspaces() {
    let result = attach_worktree_parents(
        &json!({ "workspaces": [
            { "workspace_id": "w1", "worktree": main_worktree() },
            { "workspace_id": "w2", "worktree": main_worktree() },
            { "workspace_id": "w3", "worktree": linked_worktree(LINKED) },
        ]}),
        &settings(LINKED, "w1", None),
        None,
        None,
    );
    assert_eq!(
        result["workspaces"][2]["worktree"]["parent_workspace_id"],
        "w1"
    );
}

#[test]
fn does_not_attach_another_connection_s_identical_parent_record() {
    let input = json!({ "workspaces": [
        { "workspace_id": "w1", "worktree": main_worktree() },
        { "workspace_id": "w2", "worktree": linked_worktree(LINKED) },
    ]});
    let persisted = settings(LINKED, "w1", Some("alpha"));
    assert_eq!(
        attach_worktree_parents(&input, &persisted, None, Some("alpha"))["workspaces"][1]["worktree"]
            ["parent_workspace_id"],
        "w1"
    );
    assert_eq!(
        attach_worktree_parents(&input, &persisted, None, Some("beta")),
        input
    );
}

/// settings.json whose writes wait at a gate, telling when one is queued.
struct GatedSettings {
    stored: Mutex<Arc<Settings>>,
    queued: Notify,
    gate: Notify,
}

impl SettingsAccess for GatedSettings {
    fn read(&self) -> BoxFuture<'_, Arc<Settings>> {
        let settings = self.stored.lock().unwrap().clone();
        Box::pin(async move { settings })
    }

    fn update(&self, change: SettingsChange) -> BoxFuture<'_, Result<Arc<Settings>, String>> {
        Box::pin(async move {
            self.queued.notify_one();
            self.gate.notified().await;
            let mut stored = self.stored.lock().unwrap();
            if let Some(next) = change(&stored) {
                *stored = Arc::new(Settings::normalize(&next));
            }
            Ok(stored.clone())
        })
    }
}

#[tokio::test]
async fn does_not_commit_stale_parent_additions_or_removals() {
    let gated = Arc::new(GatedSettings {
        stored: Mutex::new(Arc::new(Settings::normalize(&json!({})))),
        queued: Notify::new(),
        gate: Notify::new(),
    });
    let mut conn = connection(None, FnRunner::answering(|_| unreachable!()));
    conn.id = "alpha".into();
    conn.settings = gated.clone();
    let current = Arc::new(AtomicBool::new(true));
    let flag = current.clone();
    let guard: Guard = Arc::new(move || flag.load(Ordering::SeqCst));
    let result =
        json!({ "workspace": { "workspace_id": "w2", "worktree": linked_worktree(LINKED) } });

    let (add_conn, add_guard) = (conn.clone(), guard.clone());
    let adding = tokio::spawn(async move {
        WorktreeParents
            .remember_worktree_parent(&add_conn, &result, "w1", &add_guard)
            .await
    });
    gated.queued.notified().await;
    current.store(false, Ordering::SeqCst);
    gated.gate.notify_one();
    assert_eq!(
        adding.await.unwrap().unwrap_err(),
        "settings update cancelled"
    );
    assert!(gated.stored.lock().unwrap().custom().unwrap()[CUSTOM_SETTINGS_KEY].is_null());

    *gated.stored.lock().unwrap() = Arc::new(settings(LINKED, "w1", Some("alpha")));
    current.store(true, Ordering::SeqCst);
    let (remove_conn, remove_guard) = (conn.clone(), guard.clone());
    let removing = tokio::spawn(async move {
        WorktreeParents
            .forget_worktree(&remove_conn, LINKED, &remove_guard)
            .await
    });
    gated.queued.notified().await;
    current.store(false, Ordering::SeqCst);
    gated.gate.notify_one();
    assert_eq!(
        removing.await.unwrap().unwrap_err(),
        "settings update cancelled"
    );
    let key = repo_settings_key(LINKED, None, Some("alpha"));
    assert_eq!(
        gated.stored.lock().unwrap().custom().unwrap()[CUSTOM_SETTINGS_KEY][&key],
        "w1"
    );
}

#[test]
fn ignores_a_stale_or_incompatible_parent_record() {
    let mut other = main_worktree();
    other["repo_key"] = "/other/.git".into();
    let input = json!({ "workspaces": [
        { "workspace_id": "w1", "worktree": other },
        { "workspace_id": "w2", "worktree": linked_worktree(LINKED) },
    ]});
    assert_eq!(
        attach_worktree_parents(&input, &settings(LINKED, "w1", None), None, None),
        input
    );
}

#[test]
fn does_not_trust_an_unverified_parent_workspace() {
    let input = json!({ "workspaces": [
        { "workspace_id": "w1", "label": "ordinary workspace" },
        { "workspace_id": "w2", "worktree": linked_worktree(LINKED) },
    ]});
    assert_eq!(
        attach_worktree_parents(&input, &settings(LINKED, "w1", None), None, None),
        input
    );
}
