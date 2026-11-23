//! settings-rpc.test.ts's auto-sync cases.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::FutureExt as _;
use roamgate_base::clock::TestClock;
use roamgate_base::log::Logger;
use serde_json::json;

use super::*;
use crate::auto_sync::{AutoSyncArgs, ResolvedRoot};
use crate::connection::testing::MemorySettings;
use crate::status_test_support::{Queue, connection};

fn setup(
    id: &str,
    settings: Value,
) -> (
    WorkspaceConnection,
    AutoSync,
    GitRootResolver,
    Arc<MemorySettings>,
) {
    let (conn, _, memory) = connection(id, None, Queue::new(Vec::new()), None, settings);
    let resolve: GitRootResolver = Arc::new(|_| {
        async {
            Ok(ResolvedRoot {
                workspace: json!({"label": "same"}),
                root: "/same".into(),
            })
        }
        .boxed()
    });
    let auto_sync = AutoSync::new(AutoSyncArgs {
        conn: conn.clone(),
        clock: Arc::new(TestClock::new(0)),
        logger: Logger::silent(),
        invalidate_git_status: Arc::new(|_| {}),
        resolve_git_root: resolve.clone(),
        sync_branch: None,
    });
    (conn, auto_sync, resolve, memory)
}

fn two_connections() -> Value {
    json!({
        "version": 1,
        "repositories": {},
        "workspace_auto_sync": {
            "connection:alpha:local:/same": { "enabled": true, "interval_minutes": 10, "checkout_path": "/same" },
            "connection:beta:local:/same": { "enabled": true, "interval_minutes": 10, "checkout_path": "/same" },
        },
    })
}

fn enabled(memory: &MemorySettings, key: &str) -> Value {
    memory.0.lock().unwrap().get("workspace_auto_sync").unwrap()[key]["enabled"].clone()
}

#[tokio::test]
async fn settings_rpc_lists_and_mutates_only_its_connection_namespace() {
    let (conn, auto_sync, resolve, memory) = setup("alpha", two_connections());
    let rpc = SettingsRpc {
        conn: &conn,
        auto_sync: &auto_sync,
        resolve_git_root: &resolve,
        settings_path: "/data/settings.json",
        is_current: Arc::new(|| true),
    };
    let list = settings_rpc(&rpc, "settings.workspace_auto_sync.list", &json!({}))
        .await
        .unwrap()
        .unwrap();
    let configs = list["configs"].as_array().unwrap();
    assert_eq!(configs.len(), 1);
    assert_eq!(configs[0]["key"], "connection:alpha:local:/same");
    assert_eq!(list["path"], "/data/settings.json");
    let cross = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.update_key",
        &json!({"key": "connection:beta:local:/same", "enabled": false}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(cross.message.contains("another connection"));
    let own = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.update_key",
        &json!({"key": "connection:alpha:local:/same", "enabled": false}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(own["key"], "connection:alpha:local:/same");
    assert_eq!(own["enabled"], false);
    assert_eq!(enabled(&memory, "connection:alpha:local:/same"), false);
    assert_eq!(enabled(&memory, "connection:beta:local:/same"), true);
}

#[tokio::test]
async fn settings_rpc_cancels_a_queued_mutation_after_replacement() {
    let settings = json!({
        "workspace_auto_sync": {
            "connection:alpha:local:/same": { "enabled": true, "interval_minutes": 10, "checkout_path": "/same" },
        },
    });
    let (conn, auto_sync, resolve, memory) = setup("alpha", settings);
    let current = Arc::new(AtomicBool::new(true));
    let flag = current.clone();
    let rpc = SettingsRpc {
        conn: &conn,
        auto_sync: &auto_sync,
        resolve_git_root: &resolve,
        settings_path: "",
        is_current: Arc::new(move || flag.swap(false, Ordering::SeqCst)),
    };
    // Current when the request came, replaced before its write.
    let error = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.update_key",
        &json!({"key": "connection:alpha:local:/same", "enabled": false}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.message, CONNECTION_CHANGED_DURING_REQUEST);
    assert_eq!(enabled(&memory, "connection:alpha:local:/same"), true);
    assert!(!current.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_workspace_s_auto_sync_is_read_and_set_by_its_checkout() {
    let (conn, auto_sync, resolve, memory) = setup("alpha", json!({}));
    let rpc = SettingsRpc {
        conn: &conn,
        auto_sync: &auto_sync,
        resolve_git_root: &resolve,
        settings_path: "",
        is_current: Arc::new(|| true),
    };
    let get = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.get",
        &json!({"workspace_id": "w1"}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        get,
        json!({
            "workspace_id": "w1", "workspace_label": "same", "checkout_path": "/same",
            "key": "connection:alpha:local:/same", "enabled": false, "interval_minutes": 10,
            "running": false,
        })
    );
    let set = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.update",
        &json!({"workspace_id": "w1", "enabled": true}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        set,
        json!({
            "workspace_id": "w1", "workspace_label": "same", "key": "connection:alpha:local:/same",
            "enabled": true, "interval_minutes": 10, "checkout_path": "/same", "running": false,
        })
    );
    assert_eq!(enabled(&memory, "connection:alpha:local:/same"), true);
    let missing = settings_rpc(
        &rpc,
        "settings.workspace_auto_sync.update",
        &json!({"workspace_id": "w1"}),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(
        missing.message,
        "settings.workspace_auto_sync.update requires enabled"
    );
    assert!(
        settings_rpc(&rpc, "settings.get", &json!({}))
            .await
            .is_none()
    );
}
