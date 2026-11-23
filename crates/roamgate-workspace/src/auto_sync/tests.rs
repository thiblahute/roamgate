//! auto-sync.test.ts.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use roamgate_base::clock::TestClock;
use serde_json::json;
use tokio::sync::Notify;

use super::*;
use crate::connection::testing::FakeHerdr;
use crate::status_test_support::{Queue, connection, settle};

fn fetched_commit() -> String {
    "a".repeat(40)
}

fn remote_head() -> String {
    format!("ref: refs/heads/master\tHEAD\n{}\tHEAD\n", fetched_commit())
}

fn ok(stdout: &str) -> Ran {
    Ran::new(0, stdout, "")
}

async fn sync(answers: Vec<Ran>) -> (SyncResult, Vec<String>) {
    let runner = Queue::new(answers);
    let cx = GitContext::local(runner.clone());
    let result = sync_workspace_branch(&cx, "/repo").await.unwrap();
    (result, runner.commands())
}

fn result(status: &str, message: &str, branch: Option<&str>) -> SyncResult {
    SyncResult::new(status, message, branch)
}

/// The preflight and fetch every merge test runs through.
fn through_fetch() -> Vec<Ran> {
    vec![
        ok("true\n"),
        ok("feature/test\n"),
        ok(""),
        ok("before\n"),
        ok(""),
        ok(&remote_head()),
        ok(""),
        ok(""),
        ok(&fetched_commit()),
        Ran::new(1, "", ""),
        ok(""),
    ]
}

#[tokio::test]
async fn skips_a_workspace_with_uncommitted_changes() {
    let (got, commands) = sync(vec![
        ok("true\n"),
        ok("feature/test\n"),
        ok(" M src/index.ts\n"),
    ])
    .await;
    assert_eq!(
        got,
        result(
            "skipped",
            "Skipped because the workspace has uncommitted changes.",
            Some("feature/test")
        )
    );
    assert_eq!(commands.len(), 3);
    assert!(commands[2].contains("status --porcelain=v1"));
}

#[tokio::test]
async fn fetches_and_merges_origin_s_default_branch_into_a_clean_branch() {
    let mut answers = through_fetch();
    answers.extend([
        ok("feature/test\n"),
        ok(""),
        ok("before\n"),
        ok("Merge made by the ort strategy.\n"),
        ok("after\n"),
    ]);
    let (got, commands) = sync(answers).await;
    assert_eq!(
        got,
        result(
            "updated",
            "Merged origin/master into feature/test.",
            Some("feature/test")
        )
    );
    let commit = fetched_commit();
    assert!(commands[4].contains("for-each-ref"));
    assert!(commands[5].contains("ls-remote --symref origin HEAD"));
    assert!(commands[7].contains(&format!(
        "fetch --no-tags --no-write-fetch-head --refmap= origin '{commit}'"
    )));
    assert!(commands[9].contains("symbolic-ref --quiet 'refs/remotes/origin/master'"));
    assert!(commands[10].contains(&format!(
        "update-ref --no-deref 'refs/remotes/origin/master' '{commit}' ''"
    )));
    assert!(commands[14].contains(&format!(
        "-c commit.gpgsign=false merge --no-edit --no-stat '{commit}'"
    )));
}

#[tokio::test]
async fn aborts_a_conflicting_merge() {
    let mut answers = through_fetch();
    answers.extend([
        ok("feature/test\n"),
        ok(""),
        ok("before\n"),
        Ran::new(1, "", "CONFLICT (content): conflict\n"),
        ok(""),
    ]);
    let (got, commands) = sync(answers).await;
    assert_eq!(
        got,
        result(
            "failed",
            "CONFLICT (content): conflict",
            Some("feature/test")
        )
    );
    assert!(commands.last().unwrap().contains("merge --abort"));
}

#[tokio::test]
async fn reports_a_workspace_that_is_no_longer_a_git_repository() {
    let (got, _) = sync(vec![Ran::new(128, "", "fatal: not a git repository\n")]).await;
    assert_eq!(got, result("failed", "fatal: not a git repository", None));
}

#[tokio::test]
async fn does_not_merge_if_the_checkout_changes_during_fetch() {
    let mut answers = through_fetch();
    answers.extend([ok("feature/other\n"), ok(""), ok("after\n")]);
    let (got, commands) = sync(answers).await;
    assert_eq!(
        got,
        result(
            "skipped",
            "Skipped because the workspace changed while origin/master was being fetched.",
            Some("feature/other")
        )
    );
    assert!(!commands.iter().any(|command| command.contains(" merge ")));
}

#[tokio::test]
async fn does_not_merge_when_the_remote_default_cannot_be_determined() {
    let (got, commands) = sync(vec![
        ok("true\n"),
        ok("feature/test\n"),
        ok(""),
        ok("before\n"),
        ok(""),
        Ran::new(128, "", "origin unavailable"),
    ])
    .await;
    assert_eq!(
        got,
        result(
            "failed",
            "Unable to determine origin's default branch: origin unavailable",
            Some("feature/test")
        )
    );
    assert_eq!(commands.len(), 6);
}

struct Harness {
    auto_sync: AutoSync,
    sync_calls: Arc<AtomicUsize>,
    invalidations: Arc<AtomicUsize>,
    workspace_calls: Arc<AtomicUsize>,
    settings: Arc<crate::connection::testing::MemorySettings>,
}

fn harness(
    connection_id: &str,
    settings: Value,
    herdr: Arc<FakeHerdr>,
    sync_branch: SyncBranch,
    sync_calls: Arc<AtomicUsize>,
) -> Harness {
    let runner = Queue::new(Vec::new());
    let (conn, _, memory) = connection(connection_id, None, runner, Some(herdr.clone()), settings);
    let invalidations = Arc::new(AtomicUsize::new(0));
    let counted = invalidations.clone();
    let auto_sync = AutoSync::new(AutoSyncArgs {
        conn,
        clock: Arc::new(TestClock::new(1_791_504_000_000)),
        logger: Logger::silent(),
        invalidate_git_status: Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
        resolve_git_root: Arc::new(|_| {
            async {
                Ok(ResolvedRoot {
                    workspace: json!({}),
                    root: "/repo".into(),
                })
            }
            .boxed()
        }),
        sync_branch: Some(sync_branch),
    });
    let workspace_calls = Arc::new(AtomicUsize::new(0));
    Harness {
        auto_sync,
        sync_calls,
        invalidations,
        workspace_calls,
        settings: memory,
    }
}

fn auto_sync_settings() -> Value {
    json!({
        "version": 1,
        "repositories": {},
        "workspace_auto_sync": {
            "local:/repo": { "enabled": true, "interval_minutes": 1, "checkout_path": "/repo" },
        },
    })
}

#[tokio::test]
async fn same_path_runtimes_execute_and_update_only_their_connection_keys() {
    let settings = json!({
        "version": 1,
        "repositories": {},
        "workspace_auto_sync": {
            "connection:alpha:local:/repo": { "enabled": true, "interval_minutes": 1, "checkout_path": "/repo" },
            "connection:beta:local:/repo": { "enabled": true, "interval_minutes": 1, "checkout_path": "/repo" },
        },
    });
    for connection_id in ["alpha", "beta"] {
        let herdr = FakeHerdr::new(|_, _| {
            Ok(json!({"workspaces": [{"workspace_id": "same", "cwd": "/repo"}]}))
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let h = harness(
            connection_id,
            settings.clone(),
            herdr,
            Arc::new(move |_, _| {
                counted.fetch_add(1, Ordering::SeqCst);
                async {
                    Ok(SyncResult {
                        last_status: Some("up_to_date".into()),
                        ..SyncResult::default()
                    })
                }
                .boxed()
            }),
            calls,
        );
        h.auto_sync.start();
        let updated = || {
            let settings = h.settings.0.lock().unwrap().clone();
            settings
                .get("workspace_auto_sync")
                .unwrap()
                .as_object()
                .unwrap()
                .iter()
                .filter(|(_, entry)| entry.get("last_run_at").is_some())
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        };
        for _ in 0..100 {
            if updated().len() == 1 {
                break;
            }
            settle().await;
        }
        h.auto_sync.stop().await;
        assert_eq!(h.sync_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            updated(),
            [format!("connection:{connection_id}:local:/repo")]
        );
    }
}

#[tokio::test]
async fn stop_drains_an_active_git_operation_without_publishing_retired_results() {
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let workspace_calls = Arc::new(AtomicUsize::new(0));
    let listed = workspace_calls.clone();
    let herdr = FakeHerdr::new(move |_, _| {
        listed.fetch_add(1, Ordering::SeqCst);
        Ok(json!({"workspaces": [{"workspace_id": "w1", "cwd": "/repo"}]}))
    });
    let (gate, counted) = (release.clone(), calls.clone());
    let mut h = harness(
        "legacy-default",
        auto_sync_settings(),
        herdr,
        Arc::new(move |_, _| {
            counted.fetch_add(1, Ordering::SeqCst);
            let gate = gate.clone();
            async move {
                gate.notified().await;
                Ok(SyncResult::new("updated", "updated", None))
            }
            .boxed()
        }),
        calls,
    );
    h.workspace_calls = workspace_calls;
    let before = h.settings.0.lock().unwrap().clone();
    h.auto_sync.start();
    for _ in 0..100 {
        if h.sync_calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        settle().await;
    }
    assert_eq!(h.sync_calls.load(Ordering::SeqCst), 1);
    h.auto_sync.settings_changed("local:/repo", true);
    let stop = tokio::spawn(h.auto_sync.stop());
    settle().await;
    assert!(!stop.is_finished());
    release.notify_one();
    stop.await.unwrap();
    settle().await;
    assert!(!h.auto_sync.is_running("local:/repo"));
    assert_eq!(h.workspace_calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.sync_calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.invalidations.load(Ordering::SeqCst), 0);
    assert_eq!(*h.settings.0.lock().unwrap(), before);
}

/// A Herdr whose `workspace.list` waits until released.
struct GatedHerdr {
    gate: Arc<Notify>,
}

impl crate::connection::Herdr for GatedHerdr {
    fn call(
        &self,
        _method: &str,
        _params: Value,
        _options: crate::connection::HerdrCallOptions,
    ) -> crate::connection::BoxFuture<'_, Result<Value, String>> {
        let gate = self.gate.clone();
        Box::pin(async move {
            gate.notified().await;
            Ok(json!({"workspaces": [{"workspace_id": "w1", "cwd": "/repo"}]}))
        })
    }
}

#[tokio::test]
async fn stop_drains_a_deferred_metadata_read_and_prevents_git_work() {
    let gate = Arc::new(Notify::new());
    let runner = Queue::new(Vec::new());
    let (conn, _, settings) = connection(
        "legacy-default",
        None,
        runner,
        Some(Arc::new(GatedHerdr { gate: gate.clone() })),
        auto_sync_settings(),
    );
    let before = settings.0.lock().unwrap().clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let auto_sync = AutoSync::new(AutoSyncArgs {
        conn,
        clock: Arc::new(TestClock::new(1_791_504_000_000)),
        logger: Logger::silent(),
        invalidate_git_status: Arc::new(|_| {}),
        resolve_git_root: Arc::new(|_| {
            async {
                Ok(ResolvedRoot {
                    workspace: json!({}),
                    root: "/repo".into(),
                })
            }
            .boxed()
        }),
        sync_branch: Some(Arc::new(move |_, _| {
            counted.fetch_add(1, Ordering::SeqCst);
            async {
                Ok(SyncResult {
                    last_status: Some("up_to_date".into()),
                    ..SyncResult::default()
                })
            }
            .boxed()
        })),
    });
    auto_sync.start();
    settle().await;
    let first = tokio::spawn(auto_sync.stop());
    let second = tokio::spawn(auto_sync.stop());
    settle().await;
    assert!(!first.is_finished());
    gate.notify_one();
    first.await.unwrap();
    second.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(*settings.0.lock().unwrap(), before);
}

#[test]
fn configured_paths_belong_to_their_connection_and_host() {
    let entry = json!({"enabled": true, "checkout_path": "/repo"});
    assert_eq!(
        configured_checkout_path("local:/repo", &entry, None, Some("legacy-default")),
        "/repo"
    );
    assert_eq!(
        configured_checkout_path("local:/repo", &entry, Some("dev"), Some("legacy-default")),
        ""
    );
    assert_eq!(
        configured_checkout_path("local:/other", &json!({}), None, None),
        "/other"
    );
    assert!(path_is_within_root("/repo/sub", "/repo/"));
    assert!(path_is_within_root("/x", "/"));
    assert!(!path_is_within_root("/repository", "/repo"));
}
