//! remove.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_git::exec::LocalRunner;
use serde_json::json;
use tokio::sync::oneshot;

use super::*;
use crate::worktree::command_template::missing_worktree_command_where;
use crate::worktree::testing::{FnRunner, last_word, ran};

type InspectFn = dyn Fn(&str) -> Result<CheckoutState, String> + Send + Sync;
type StopFn = dyn Fn(&str) -> Result<Vec<u32>, String> + Send + Sync;
type PreserveFn = dyn Fn(&str) -> Result<String, String> + Send + Sync;

/// A recovery runtime from functions, clean and doing nothing by default.
struct Fake {
    inspect: Box<InspectFn>,
    stop: Box<StopFn>,
    preserve: Box<PreserveFn>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            inspect: Box::new(|_| Ok(CheckoutState::Clean)),
            stop: Box::new(|_| Ok(Vec::new())),
            preserve: Box::new(|_| Ok("/worktree.recovered".into())),
        }
    }
}

impl Fake {
    fn inspect(state: CheckoutState) -> Self {
        Self {
            inspect: Box::new(move |_| Ok(state)),
            ..Self::default()
        }
    }
}

impl RemovalRuntime for Fake {
    fn inspect_checkout<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<CheckoutState, String>> {
        let result = (self.inspect)(path);
        Box::pin(async move { result })
    }

    fn stop_checkout_processes<'a>(
        &'a self,
        path: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, String>> {
        let result = (self.stop)(path);
        Box::pin(async move { result })
    }

    fn preserve_checkout<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, String>> {
        let result = (self.preserve)(path);
        Box::pin(async move { result })
    }
}

/// Herdr's `worktree.remove`, keeping each params, answering from `answer`.
struct Calls {
    params: Mutex<Vec<Value>>,
}

impl Calls {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            params: Mutex::new(Vec::new()),
        })
    }

    fn list(&self) -> Vec<Value> {
        self.params.lock().unwrap().clone()
    }
}

const STALE: &str = "worktree_remove_failed: fatal: '/work/repo' is not a working tree";

fn quiet(_: &str) {}

async fn remove(
    calls: &Arc<Calls>,
    answer: impl Fn(usize) -> Result<Value, String> + Send + Sync,
    params: Value,
    checkout: Option<&str>,
    runtime: &Fake,
    command: Option<BoxFuture<'_, Result<CommandRemoval, String>>>,
    log: &(dyn Fn(&str) + Send + Sync),
) -> Result<RemovalOutcome, String> {
    let call = |params: Value| -> BoxFuture<'_, Result<Value, String>> {
        let count = {
            let mut list = calls.params.lock().unwrap();
            list.push(params);
            list.len()
        };
        let result = answer(count);
        Box::pin(async move { result })
    };
    remove_worktree_with_recovery(Removal {
        call: &call,
        params,
        checkout_path: checkout.map(str::to_owned),
        runtime,
        remove_with_command: command,
        log,
    })
    .await
}

fn ok(_: usize) -> Result<Value, String> {
    Ok(json!({ "ok": true }))
}

fn stale_then_ok(count: usize) -> Result<Value, String> {
    if count == 1 {
        Err(STALE.into())
    } else {
        Ok(json!({ "ok": true }))
    }
}

#[tokio::test]
async fn shares_one_in_flight_operation_for_the_same_workspace() {
    let coordinator = RemovalCoordinator::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let (send, receive) = oneshot::channel::<String>();
    let receive = Arc::new(Mutex::new(Some(receive)));
    let operation = || {
        calls.fetch_add(1, Ordering::SeqCst);
        let receive = receive.lock().unwrap().take().unwrap();
        async move { Ok(json!(receive.await.unwrap())) }
    };
    let first = coordinator.run("w1", operation);
    let second = coordinator.run("w1", || async { Ok(json!("second ran")) });
    let both = async { tokio::join!(first, second) };
    let sender = async {
        tokio::task::yield_now().await;
        send.send("removed".into()).unwrap();
    };
    let ((first, second), ()) = tokio::join!(both, sender);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(first.unwrap(), "removed");
    assert_eq!(second.unwrap(), "removed");
}

#[tokio::test]
async fn clears_a_failed_operation_so_it_can_be_retried() {
    let coordinator = RemovalCoordinator::default();
    assert_eq!(
        coordinator
            .run("w1", || async { Err("failed".to_owned()) })
            .await
            .unwrap_err(),
        "failed"
    );
    assert_eq!(
        coordinator
            .run("w1", || async { Ok(json!("retried")) })
            .await
            .unwrap(),
        "retried"
    );
}

#[test]
fn recognizes_only_the_stale_herdr_worktree_error() {
    assert!(is_not_working_tree_remove_error(
        "worktree_remove_failed: fatal: '/tmp/wt' is not a working tree"
    ));
    assert!(!is_not_working_tree_remove_error(
        "worktree_remove_failed: contains modified files"
    ));
}

#[test]
fn finds_only_processes_whose_cwd_is_inside_the_checkout() {
    assert_eq!(
        parse_checkout_process_ids(
            "p12\nn/work/repo\np13\nn/work/repo/apps/web\np14\nn/work/repository\np15\nn/work/repo (deleted)",
            "/work/repo"
        ),
        [12, 13, 15]
    );
}

#[tokio::test]
async fn lets_herdr_shut_down_its_workspace_before_cleaning_residual_processes() {
    let calls = Calls::new();
    let stopped = Arc::new(AtomicUsize::new(0));
    let counted = stopped.clone();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Missing)),
        stop: Box::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(vec![10, 11])
        }),
        ..Fake::default()
    };
    let outcome = remove(
        &calls,
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(calls.list().len(), 1);
    assert_eq!(stopped.load(Ordering::SeqCst), 0);
    assert!(outcome.cleanup.is_none());
}

#[tokio::test]
async fn does_not_stop_processes_when_a_checkout_is_dirty() {
    let calls = Calls::new();
    let stopped = Arc::new(AtomicUsize::new(0));
    let counted = stopped.clone();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Dirty)),
        stop: Box::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }),
        ..Fake::default()
    };
    let error = remove(
        &calls,
        |_| Err("dirty_worktree_requires_force: dirty".into()),
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap_err();
    assert!(error.contains("dirty_worktree_requires_force"));
    assert_eq!(stopped.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preserves_residual_files_and_reconciles_herdr_with_force() {
    let calls = Calls::new();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        stop: Box::new(|_| Ok(vec![21])),
        preserve: Box::new(|_| Ok("/work/repo.recovered-1".into())),
    };
    let outcome = remove(
        &calls,
        stale_then_ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        calls.list(),
        [
            json!({ "workspace_id": "w1", "force": false }),
            json!({ "workspace_id": "w1", "force": true }),
        ]
    );
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 1, "recovered_stale_checkout": true, "preserved_path": "/work/repo.recovered-1" })
    );
}

#[tokio::test]
async fn recovers_a_residual_checkout_when_the_original_request_was_forced() {
    let calls = Calls::new();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        preserve: Box::new(|_| Ok("/work/repo.recovered-1".into())),
        ..Fake::default()
    };
    let outcome = remove(
        &calls,
        stale_then_ok,
        json!({ "workspace_id": "w1", "force": true }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        calls.list(),
        [
            json!({ "workspace_id": "w1", "force": true }),
            json!({ "workspace_id": "w1", "force": true }),
        ]
    );
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 0, "recovered_stale_checkout": true, "preserved_path": "/work/repo.recovered-1" })
    );
}

#[tokio::test]
async fn reconciles_an_already_missing_checkout_without_preserving_files() {
    let calls = Calls::new();
    let outcome = remove(
        &calls,
        |count| {
            if count == 1 {
                Err("worktree_remove_failed: fatal: '/work/repo' is not a worktree".into())
            } else {
                Ok(json!({ "ok": true }))
            }
        },
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &Fake::inspect(CheckoutState::Missing),
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        calls.list()[1],
        json!({ "workspace_id": "w1", "force": true })
    );
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 0, "recovered_stale_checkout": true })
    );
}

#[tokio::test]
async fn verifies_the_checkout_again_after_a_forced_recovery_retry() {
    let calls = Calls::new();
    let preserved = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = preserved.clone();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        stop: Box::new(|_| Ok(vec![41])),
        preserve: Box::new(move |_| {
            let mut kept = kept.lock().unwrap();
            let path = format!("/work/repo.recovered-{}", kept.len() + 1);
            kept.push(path.clone());
            Ok(path)
        }),
    };
    let outcome = remove(
        &calls,
        stale_then_ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(calls.list().len(), 2);
    assert_eq!(
        *preserved.lock().unwrap(),
        ["/work/repo.recovered-1", "/work/repo.recovered-2"]
    );
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 1, "recovered_stale_checkout": true, "preserved_path": "/work/repo.recovered-2" })
    );
}

#[tokio::test]
async fn does_not_move_residual_files_when_process_cleanup_fails() {
    let calls = Calls::new();
    let preserved = Arc::new(AtomicUsize::new(0));
    let counted = preserved.clone();
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        stop: Box::new(|_| Err("process 42 survived".into())),
        preserve: Box::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok("/work/repo.recovered".into())
        }),
    };
    let error = remove(
        &calls,
        |_| Err(STALE.into()),
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap_err();
    assert!(error.contains("unable to preserve the stale checkout"));
    assert_eq!(calls.list().len(), 1);
    assert_eq!(preserved.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn does_not_recover_when_the_checkout_is_still_a_valid_worktree() {
    let calls = Calls::new();
    let error = remove(
        &calls,
        |_| Err(STALE.into()),
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &Fake::inspect(CheckoutState::Clean),
        None,
        &quiet,
    )
    .await
    .unwrap_err();
    assert!(error.contains("is not a working tree"));
    assert_eq!(calls.list().len(), 1);
}

/// What a fake runtime was asked, by operation.
#[derive(Default)]
struct Asked(Mutex<Vec<(&'static str, String)>>);

impl Asked {
    fn of(&self, what: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(op, _)| *op == what)
            .map(|(_, path)| path.clone())
            .collect()
    }
}

fn recording(asked: Arc<Asked>, state: CheckoutState) -> Fake {
    let (inspected, stopped, preserved) = (asked.clone(), asked.clone(), asked);
    Fake {
        inspect: Box::new(move |path| {
            inspected.0.lock().unwrap().push(("inspect", path.into()));
            Ok(state)
        }),
        stop: Box::new(move |path| {
            stopped.0.lock().unwrap().push(("stop", path.into()));
            Ok(Vec::new())
        }),
        preserve: Box::new(move |path| {
            preserved.0.lock().unwrap().push(("preserve", path.into()));
            Ok("/recovered".into())
        }),
    }
}

#[tokio::test]
async fn never_performs_local_cleanup_for_an_unsafe_checkout_path() {
    let asked = Arc::new(Asked::default());
    let logs = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logs.lock().unwrap().push(message.into());
    let outcome = remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": true }),
        Some("/"),
        &recording(asked.clone(), CheckoutState::Residual),
        None,
        &log,
    )
    .await
    .unwrap();
    assert_eq!(outcome.result, json!({ "ok": true }));
    assert!(asked.0.lock().unwrap().is_empty());
    assert_eq!(
        *logs.lock().unwrap(),
        ["[bridge] refusing worktree cleanup for unsafe path: /"]
    );
}

#[tokio::test]
async fn normalizes_dot_segments_before_checking_cleanup_path_safety() {
    let asked = Arc::new(Asked::default());
    let logs = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logs.lock().unwrap().push(message.into());
    remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/tmp/.."),
        &recording(asked.clone(), CheckoutState::Clean),
        None,
        &log,
    )
    .await
    .unwrap();
    assert!(asked.of("inspect").is_empty());
    assert_eq!(
        *logs.lock().unwrap(),
        ["[bridge] refusing worktree cleanup for unsafe path: /tmp/.."]
    );
}

#[tokio::test]
async fn uses_a_normalized_checkout_path_for_cleanup_operations() {
    let asked = Arc::new(Asked::default());
    remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/parent/../repo"),
        &recording(asked.clone(), CheckoutState::Missing),
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(asked.of("inspect"), ["/work/repo"]);
    assert!(asked.of("stop").is_empty());
}

#[tokio::test]
async fn preserves_a_residual_directory_left_after_herdr_reports_success() {
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        stop: Box::new(|_| Ok(vec![31])),
        preserve: Box::new(|_| Ok("/work/repo.recovered-2".into())),
    };
    let outcome = remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 1, "recovered_stale_checkout": true, "preserved_path": "/work/repo.recovered-2" })
    );
}

#[tokio::test]
async fn reports_incomplete_cleanup_without_changing_a_successful_remove_into_failure() {
    let logs = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logs.lock().unwrap().push(message.into());
    let runtime = Fake {
        inspect: Box::new(|_| Ok(CheckoutState::Residual)),
        stop: Box::new(|_| Err("process 42 survived".into())),
        ..Fake::default()
    };
    let outcome = remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &log,
    )
    .await
    .unwrap();
    assert_eq!(outcome.result, json!({ "ok": true }));
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({
            "terminated_processes": 0,
            "warning": "Herdr removed the worktree, but stale checkout cleanup failed: process 42 survived",
        })
    );
    assert_eq!(
        *logs.lock().unwrap(),
        [
            "[bridge] Herdr removed the worktree, but stale checkout cleanup failed: process 42 survived"
        ]
    );
}

#[tokio::test]
async fn warns_when_a_successful_removal_cannot_be_verified() {
    let outcome = remove(
        &Calls::new(),
        ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &Fake::inspect(CheckoutState::Unknown),
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({
            "terminated_processes": 0,
            "warning": "Herdr reported success, but the checkout removal could not be verified at /work/repo",
        })
    );
}

#[tokio::test]
async fn continues_recovery_if_a_residual_directory_disappears_before_preservation() {
    let calls = Calls::new();
    let inspections = Arc::new(AtomicUsize::new(0));
    let counted = inspections.clone();
    let runtime = Fake {
        inspect: Box::new(move |_| {
            Ok(if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                CheckoutState::Residual
            } else {
                CheckoutState::Missing
            })
        }),
        preserve: Box::new(|_| Err("ENOENT".into())),
        ..Fake::default()
    };
    let outcome = remove(
        &calls,
        stale_then_ok,
        json!({ "workspace_id": "w1", "force": false }),
        Some("/work/repo"),
        &runtime,
        None,
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(calls.list().len(), 2);
    assert_eq!(
        outcome.cleanup.unwrap().to_value(),
        json!({ "terminated_processes": 0, "recovered_stale_checkout": true })
    );
}

fn local_runtime() -> HostRemovalRuntime {
    HostRemovalRuntime {
        cx: GitContext::local(Arc::new(LocalRunner::system())),
    }
}

#[tokio::test]
async fn does_not_mistake_a_directory_inside_another_repository_for_a_worktree() {
    let root = tempfile::Builder::new()
        .prefix("herdr-gui-remove-")
        .tempdir()
        .unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(root.path())
        .status()
        .unwrap();
    assert!(status.success());
    let child = root.path().join("stale-checkout");
    std::fs::create_dir(&child).unwrap();
    let runtime = local_runtime();
    assert_eq!(
        runtime
            .inspect_checkout(root.path().to_str().unwrap())
            .await
            .unwrap(),
        CheckoutState::Clean
    );
    assert_eq!(
        runtime
            .inspect_checkout(child.to_str().unwrap())
            .await
            .unwrap(),
        CheckoutState::Residual
    );
}

#[tokio::test]
async fn stops_a_stable_process_whose_cwd_is_inside_the_checkout() {
    let root = tempfile::Builder::new()
        .prefix("herdr-gui-process-")
        .tempdir()
        .unwrap();
    let mut sleeper = std::process::Command::new("sleep")
        .arg("30")
        .current_dir(root.path())
        .spawn()
        .unwrap();
    let stopped = local_runtime()
        .stop_checkout_processes(root.path().to_str().unwrap())
        .await;
    let status = sleeper.wait().unwrap();
    assert!(stopped.unwrap().contains(&sleeper.id()));
    assert!(!status.success());
}

#[test]
fn substitutes_the_checkout_its_repository_and_force_when_forced() {
    assert_eq!(
        render_worktree_remove_command(
            "git recworktree remove {path} {force}",
            "/w/it's",
            "/src",
            true
        )
        .unwrap(),
        r#"export ROAMGATE_WORKTREE_PATH='/w/it'\''s'; export ROAMGATE_WORKTREE_REPO='/src'; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree remove "$ROAMGATE_WORKTREE_PATH" --force"#
    );
    assert_eq!(
        render_worktree_remove_command(
            "tool rm {path} {force} --repo {repo}",
            "~/wt/a",
            "/src",
            false
        )
        .unwrap(),
        r#"export ROAMGATE_WORKTREE_PATH="$HOME"/'wt/a'; export ROAMGATE_WORKTREE_REPO='/src'; cd "$ROAMGATE_WORKTREE_REPO" && tool rm "$ROAMGATE_WORKTREE_PATH"  --repo "$ROAMGATE_WORKTREE_REPO""#
    );
}

#[tokio::test]
async fn a_hostile_checkout_path_runs_nothing_with_a_real_sh() {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-remove-sh-")
        .tempdir()
        .unwrap();
    let root = dir.path().to_str().unwrap().to_owned();
    let marker = format!("{root}/pwned");
    let checkout = format!("{root}/a$(touch${{IFS}}{marker})'$(touch${{IFS}}{marker})'");
    let cx = GitContext::local(Arc::new(LocalRunner::system()));
    for template in [
        r#"printf '%s' "{path}" > out"#,
        r#"printf '%s' '{path}' > out"#,
    ] {
        let error = run_worktree_remove_command(template, &checkout, &root, false, &cx)
            .await
            .unwrap_err();
        assert_eq!(
            error,
            "Remove the quotes around {path}: Roamgate quotes placeholders itself."
        );
    }
    assert!(!std::path::Path::new(&marker).exists());
    assert_eq!(
        run_worktree_remove_command(r#"printf '%s' {path} > out"#, &checkout, &root, false, &cx)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        std::fs::read_to_string(format!("{root}/out")).unwrap(),
        checkout
    );
    assert!(!std::path::Path::new(&marker).exists());
}

#[tokio::test]
async fn runs_from_the_source_repository_over_ssh_on_a_remote_host() {
    let runner = FnRunner::answering(|_| Ok(ran(0, "", "")));
    let cx = GitContext::new(Some("desktop".into()), runner.clone());
    let fallback = run_worktree_remove_command(
        "git recworktree remove {path} {force}",
        "/w/a",
        "/src",
        false,
        &cx,
    )
    .await
    .unwrap();
    assert_eq!(fallback, None);
    let requests = runner.requests();
    assert_eq!(requests.len(), 2);
    assert!(last_word(&requests[0]).contains("command -v -- "));
    let Invocation::Ssh { destination, .. } = &requests[1].invocation else {
        panic!("not over ssh");
    };
    assert_eq!(destination, "desktop");
    assert_eq!(
        last_word(&requests[1]),
        r#"sh -c 'export ROAMGATE_WORKTREE_PATH='\''/w/a'\''; export ROAMGATE_WORKTREE_REPO='\''/src'\''; cd "$ROAMGATE_WORKTREE_REPO" && git recworktree remove "$ROAMGATE_WORKTREE_PATH" '"#
    );
}

#[tokio::test]
async fn a_command_not_installed_on_the_host_leaves_the_removal_to_herdr_and_says_so() {
    let runner = FnRunner::answering(|_| Ok(ran(127, "", "")));
    let cx = GitContext::local(runner.clone());
    let calls = Calls::new();
    let command = async {
        let fallback = run_worktree_remove_command(
            "git recworktree remove {path}",
            "/w/a",
            "/src",
            false,
            &cx,
        )
        .await?;
        Ok(match fallback {
            Some(fallback) => CommandRemoval::Fallback(fallback),
            None => CommandRemoval::Removed(json!({ "type": "worktree_removed" })),
        })
    }
    .boxed();
    let outcome = remove(
        &calls,
        |_| Ok(json!({ "type": "worktree_removed" })),
        json!({ "workspace_id": "w2" }),
        Some("/w/a"),
        &Fake::inspect(CheckoutState::Missing),
        Some(command),
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(runner.requests().len(), 1);
    assert_eq!(calls.list().len(), 1);
    assert_eq!(outcome.result, json!({ "type": "worktree_removed" }));
    assert_eq!(
        outcome.command_fallback.as_deref(),
        Some("git recworktree is not installed on this machine.")
    );
}

#[tokio::test]
async fn an_exit_127_from_inside_an_installed_remove_command_is_a_failure() {
    let call = AtomicUsize::new(0);
    let runner = FnRunner::answering(move |_| {
        Ok(if call.fetch_add(1, Ordering::SeqCst) == 0 {
            ran(0, "", "")
        } else {
            ran(127, "", "hook: rmtool: not found")
        })
    });
    let cx = GitContext::local(runner);
    assert_eq!(
        run_worktree_remove_command("git recworktree remove {path}", "/w/a", "/src", false, &cx)
            .await
            .unwrap_err(),
        "Worktree remove command failed (exit 127): hook: rmtool: not found"
    );
}

#[tokio::test]
async fn no_sh_on_this_machine_leaves_the_removal_to_herdr() {
    let runner = FnRunner::answering(|_| Err(roamgate_git::RunError("spawn sh ENOENT".into())));
    let cx = GitContext::local(runner);
    let template = "git recworktree remove {path}";
    let fallback =
        run_worktree_remove_command_where(template, "C:/w/a", "C:/src", false, &cx, || {
            missing_worktree_command_where(template, &cx, || false).boxed()
        })
        .await
        .unwrap();
    assert_eq!(
        fallback.as_deref(),
        Some("sh is not available on this machine.")
    );
}

#[tokio::test]
async fn the_command_s_removal_skips_herdr_s_and_a_failure_stops_it() {
    let calls = Calls::new();
    let outcome = remove(
        &calls,
        |_| Ok(json!({})),
        json!({ "workspace_id": "w2" }),
        Some("/w/a"),
        &Fake::inspect(CheckoutState::Missing),
        Some(
            async {
                Ok(CommandRemoval::Removed(
                    json!({ "type": "worktree_removed", "path": "/w/a" }),
                ))
            }
            .boxed(),
        ),
        &quiet,
    )
    .await
    .unwrap();
    assert!(calls.list().is_empty());
    assert_eq!(outcome.result["path"], "/w/a");
    assert_eq!(outcome.command_fallback, None);

    let run = AtomicUsize::new(0);
    let runner = FnRunner::answering(move |_| {
        Ok(if run.fetch_add(1, Ordering::SeqCst) == 0 {
            ran(0, "", "")
        } else {
            ran(1, "", "Error: worktree has uncommitted changes")
        })
    });
    let cx = GitContext::local(runner);
    assert_eq!(
        run_worktree_remove_command("git recworktree remove {path}", "/w/a", "/src", false, &cx)
            .await
            .unwrap_err(),
        "Worktree remove command failed (exit 1): Error: worktree has uncommitted changes"
    );
}

#[tokio::test]
async fn a_command_failing_on_a_stale_checkout_gets_the_same_recovery_as_herdr() {
    let calls = Calls::new();
    let outcome = remove(
        &calls,
        |_| Ok(json!({ "type": "worktree_removed" })),
        json!({ "workspace_id": "w2" }),
        Some("/w/a"),
        &Fake::inspect(CheckoutState::Missing),
        Some(
            async {
                Err(
                    "Worktree remove command failed (exit 128): fatal: '/w/a' is not a working tree"
                        .to_owned(),
                )
            }
            .boxed(),
        ),
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        calls.list(),
        [json!({ "workspace_id": "w2", "force": true })]
    );
    assert_eq!(outcome.result, json!({ "type": "worktree_removed" }));
}

#[tokio::test]
async fn warnings_after_the_command_s_removal_name_the_command_not_herdr() {
    let outcome = remove(
        &Calls::new(),
        |_| Ok(json!({})),
        json!({ "workspace_id": "w2" }),
        Some("/w/a"),
        &Fake::inspect(CheckoutState::Clean),
        Some(
            async {
                Ok(CommandRemoval::Removed(
                    json!({ "type": "worktree_removed" }),
                ))
            }
            .boxed(),
        ),
        &quiet,
    )
    .await
    .unwrap();
    assert_eq!(
        outcome.cleanup.unwrap().warning.as_deref(),
        Some(
            "The worktree remove command reported success, but the checkout is still a clean working tree at /w/a"
        )
    );
}
