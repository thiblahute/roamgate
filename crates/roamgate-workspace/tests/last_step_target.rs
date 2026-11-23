//! last-step-target.test.ts: the Last step as a review target. Each
//! step's snapshot trees are kept under refs while its review has threads
//! and for the last steps, read back after a restart, untracked files over
//! 50 MB left out and named.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt as _;
use roamgate_git::diff::{
    LAST_STEPS_KEPT, StepRange, SummaryArgs, last_step_ref_prefix, read_diff_summary,
};
use roamgate_git::exec::LocalRunner;
use roamgate_git::patch::LineKind;
use roamgate_git::review::{GoneCode, Target};
use roamgate_git::review_patch::{read_review_patch, read_review_state};
use roamgate_git::steps::LastStepStore;
use roamgate_git::{GitContext, GitError};
use serde_json::{Value, json};

fn git(root: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn cx() -> GitContext {
    GitContext::local(Arc::new(LocalRunner::system()))
}

fn repository() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("roamgate-step-target-")
        .tempdir()
        .unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@example.com"]);
    git(root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(root, &["add", "a.txt"]);
    git(root, &["commit", "-qm", "one"]);
    dir
}

fn path(dir: &tempfile::TempDir) -> String {
    dir.path().to_str().unwrap().to_owned()
}

/// A step: the baseline taken, the files written, the step completed.
async fn step(
    store: &Arc<LastStepStore>,
    root: &str,
    write: impl FnOnce(),
    workspace: &str,
) -> StepRange {
    let at = root.to_owned();
    store
        .capture_workspace(workspace, async move { Ok(at) }.boxed())
        .await
        .unwrap();
    write();
    assert!(store.complete_workspace(workspace).await.unwrap());
    let done = store.completed_step(workspace, root).await.unwrap();
    assert!(done.step.is_some());
    done
}

fn step_refs(root: &Path, workspace: &str) -> Vec<String> {
    let out = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            &format!("{}/", last_step_ref_prefix(workspace)),
        ],
    );
    let mut steps: Vec<String> = out
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.split('/').nth(4).unwrap().to_owned())
        .collect();
    steps.sort();
    steps.dedup();
    steps
}

async fn summary(cx: &GitContext, root: &str, store: &Arc<LastStepStore>) -> Value {
    read_diff_summary(SummaryArgs {
        cx,
        workspace_id: "w1",
        workspace: &json!({}),
        root,
        params: &json!({"mode": "last-step"}),
        last_steps: Some(store),
    })
    .await
    .unwrap()
}

fn paths(summary: &Value) -> Vec<String> {
    summary["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect()
}

fn target(done: &StepRange) -> Target {
    Target::Step {
        step: done.step.clone().unwrap(),
        before: done.baseline.clone(),
        after: done.current.clone(),
        at: None,
        skipped: None,
    }
}

#[tokio::test]
async fn a_completed_step_s_trees_are_kept_under_refs_its_summary_names_it_as_a_target() {
    let dir = repository();
    let root = path(&dir);
    let cx = cx();
    let store = LastStepStore::new(cx.clone(), true);
    let done = step(
        &store,
        &root,
        || std::fs::write(dir.path().join("a.txt"), "two\n").unwrap(),
        "w1",
    )
    .await;
    let id = done.step.clone().unwrap();
    assert!(
        regex::Regex::new(r"^\d{13}-[0-9a-f]{8}$")
            .unwrap()
            .is_match(&id)
    );
    assert_eq!(step_refs(dir.path(), "w1"), std::slice::from_ref(&id));
    assert_eq!(
        git(
            dir.path(),
            &[
                "rev-parse",
                &format!("{}/{id}/after", last_step_ref_prefix("w1"))
            ]
        )
        .trim(),
        done.current
    );
    let summary = summary(&cx, &root, &store).await;
    assert_eq!(paths(&summary), ["a.txt"]);
    assert_eq!(
        summary["step"],
        json!({"step": id, "before": done.baseline, "after": done.current, "at": done.at})
    );
    // The review of the step reads tree against tree.
    let target = target(&done);
    let diff = read_review_patch(&cx, &root, &target, None).await.unwrap();
    assert_eq!(
        diff.files
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        ["a.txt"]
    );
    assert_eq!(
        diff.files[0].hunks[0]
            .lines
            .iter()
            .map(|line| line.kind)
            .collect::<Vec<_>>(),
        [LineKind::Removed, LineKind::Added]
    );
    assert_eq!(diff.base_sha.as_deref(), Some(done.baseline.as_str()));
    assert_eq!(diff.head_sha.as_deref(), Some(done.current.as_str()));
    assert_eq!(
        read_review_state(&cx, &root, &target).await.unwrap(),
        format!("{} {}", done.baseline, done.current)
    );
    store.dispose().await;
}

#[tokio::test]
async fn only_the_last_steps_keep_their_refs_and_a_step_whose_review_has_threads() {
    let dir = repository();
    let root = path(&dir);
    let store = LastStepStore::new(cx(), true);
    let kept = Arc::new(std::sync::Mutex::new(String::new()));
    let (keeper_root, keeper_kept) = (root.clone(), kept.clone());
    store.set_keeper(Some(Arc::new(move |at: &str| {
        let kept = keeper_kept.lock().unwrap().clone();
        if at == keeper_root && !kept.is_empty() {
            vec![kept]
        } else {
            Vec::new()
        }
    })));
    let mut steps = Vec::new();
    for index in 0..LAST_STEPS_KEPT + 2 {
        let done = step(
            &store,
            &root,
            || std::fs::write(dir.path().join("a.txt"), format!("step {index}\n")).unwrap(),
            "w1",
        )
        .await;
        steps.push(done.step.clone().unwrap());
        // The first step's review got a thread.
        if index == 0 {
            *kept.lock().unwrap() = done.step.clone().unwrap();
        }
        // Steps in one millisecond would not sort by time.
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let mut expected = vec![steps[0].clone()];
    expected.extend(steps[steps.len() - LAST_STEPS_KEPT..].iter().cloned());
    expected.sort();
    assert_eq!(step_refs(dir.path(), "w1"), expected);
    // Another workspace's steps are its own.
    step(
        &store,
        &root,
        || std::fs::write(dir.path().join("a.txt"), "other\n").unwrap(),
        "w2",
    )
    .await;
    assert_eq!(step_refs(dir.path(), "w1").len(), LAST_STEPS_KEPT + 1);
    assert_eq!(step_refs(dir.path(), "w2").len(), 1);
    store.dispose().await;
}

#[tokio::test]
async fn after_a_restart_the_latest_step_is_read_back_from_its_refs_a_store_without_refs_knows_none()
 {
    let dir = repository();
    let root = path(&dir);
    let cx = cx();
    let first = LastStepStore::new(cx.clone(), true);
    let done = step(
        &first,
        &root,
        || std::fs::write(dir.path().join("a.txt"), "after\n").unwrap(),
        "w1",
    )
    .await;
    first.dispose().await;
    let restarted = LastStepStore::new(cx.clone(), true);
    let read = restarted.completed_step("w1", &root).await.unwrap();
    assert_eq!(read.baseline, done.baseline);
    assert_eq!(read.current, done.current);
    assert_eq!(read.step, done.step);
    assert_eq!(read.at, done.at);
    // The scope shows it again, with the same target.
    let summary = summary(&cx, &root, &restarted).await;
    assert_eq!(summary["baseline_available"], true);
    assert_eq!(summary["step"]["step"].as_str(), done.step.as_deref());
    assert!(restarted.completed_step("other", &root).await.is_none());
    let memory_only = LastStepStore::new(cx, false);
    assert!(memory_only.completed_step("w1", &root).await.is_none());
    restarted.dispose().await;
    memory_only.dispose().await;
}

#[tokio::test]
async fn a_step_whose_refs_were_dropped_and_trees_collected_expires_its_review_says_the_snapshot_is_gone()
 {
    let dir = repository();
    let root = path(&dir);
    let cx = cx();
    let store = LastStepStore::new(cx.clone(), true);
    let done = step(
        &store,
        &root,
        || std::fs::write(dir.path().join("new.txt"), "a new file nobody else has\n").unwrap(),
        "w1",
    )
    .await;
    store.dispose().await;
    let prefix = format!(
        "{}/{}",
        last_step_ref_prefix("w1"),
        done.step.as_deref().unwrap()
    );
    for end in ["before", "after"] {
        git(
            dir.path(),
            &["update-ref", "-d", &format!("{prefix}/{end}")],
        );
    }
    git(dir.path(), &["reflog", "expire", "--expire=now", "--all"]);
    git(dir.path(), &["gc", "-q", "--prune=now"]);
    let error = read_review_patch(&cx, &root, &target(&done), None)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        GitError::Gone {
            code: GoneCode::HeadGone,
            ..
        }
    ));
    // Restarted, no step is known any more: the scope is empty.
    let restarted = LastStepStore::new(cx.clone(), true);
    let summary = summary(&cx, &root, &restarted).await;
    assert_eq!(summary["baseline_available"], false);
    assert_eq!(summary["entries"], json!([]));
    restarted.dispose().await;
}

fn sparse(path: &Path, size: u64) {
    std::fs::File::create(path).unwrap().set_len(size).unwrap();
}

#[tokio::test]
async fn an_untracked_file_of_20_mb_is_in_the_snapshots_only_those_over_50_mb_are_left_out() {
    let dir = repository();
    let root = path(&dir);
    let cx = cx();
    let store = LastStepStore::new(cx.clone(), true);
    let done = step(
        &store,
        &root,
        || sparse(&dir.path().join("big.bin"), 20 * 1024 * 1024),
        "w1",
    )
    .await;
    assert!(done.skipped.is_empty());
    assert_eq!(paths(&summary(&cx, &root, &store).await), ["big.bin"]);
    store.dispose().await;
}

#[tokio::test]
async fn an_untracked_file_over_50_mb_is_left_out_of_the_snapshots_and_named_the_step_goes_on() {
    let dir = repository();
    let root = path(&dir);
    let cx = cx();
    let store = LastStepStore::new(cx.clone(), true);
    let done = step(
        &store,
        &root,
        || {
            std::fs::write(dir.path().join("small.txt"), "small\n").unwrap();
            // Sparse: its size without writing it.
            sparse(&dir.path().join("huge.bin"), 51 * 1024 * 1024);
        },
        "w1",
    )
    .await;
    assert_eq!(done.skipped, ["huge.bin"]);
    let summary = summary(&cx, &root, &store).await;
    assert_eq!(paths(&summary), ["small.txt"]);
    assert_eq!(summary["step"]["skipped"], json!(["huge.bin"]));
    store.dispose().await;
    // Read back after a restart too.
    let restarted = LastStepStore::new(cx, true);
    assert_eq!(
        restarted.completed_step("w1", &root).await.unwrap().skipped,
        ["huge.bin"]
    );
    restarted.dispose().await;
}
