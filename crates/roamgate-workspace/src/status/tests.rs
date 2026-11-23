//! status.test.ts.

use std::sync::Arc;

use roamgate_base::clock::TestClock;
use roamgate_git::Ran;
use serde_json::json;

use super::*;
use crate::connection::testing::KeptEvents;
use crate::status_test_support::{Deferred, PendingRun, connection, settle};

const EPOCH: i64 = 1_791_504_000_000;

struct Setup {
    status: GitStatus,
    runner: Arc<Deferred>,
    events: Arc<KeptEvents>,
    clock: TestClock,
}

// Most tests use no cold budget so a list never waits on a pending read.
fn setup(host: Option<&str>, cold_budget: Duration) -> Setup {
    let runner = Arc::new(Deferred::default());
    let (conn, events, _) = connection("conn", host, runner.clone(), None, json!({}));
    let clock = TestClock::new(EPOCH);
    let status = GitStatus::new(conn, Arc::new(clock.clone()), cold_budget);
    Setup {
        status,
        runner,
        events,
        clock,
    }
}

impl Setup {
    /// The pushed updates, each push's list.
    fn pushes(&self) -> Vec<Vec<Value>> {
        self.events
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(event, data)| {
                assert_eq!(event, "workspace.git_status");
                data["statuses"].as_array().unwrap().clone()
            })
            .collect()
    }
}

fn workspace_list(paths: &[&str]) -> Value {
    json!({
        "workspaces": paths.iter().enumerate().map(|(index, path)| json!({
            "workspace_id": format!("w{}", index + 1),
            "worktree": { "repo_key": "repo", "repo_root": path, "checkout_path": path },
        })).collect::<Vec<_>>(),
    })
}

async fn list(status: &GitStatus, paths: &[&str]) -> Vec<Option<String>> {
    let result = status.enrich_workspaces(workspace_list(paths)).await;
    result["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|workspace| {
            workspace["worktree"]["git_status"]["branch"]
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

fn local_reply(run: &PendingRun, branch: &str, dirty: bool) {
    let dirty = if dirty { " M file\n" } else { "" };
    run.resolve(Ran::new(0, format!("## {branch}\n{dirty}"), ""));
}

fn remote_reply(run: &PendingRun, branches: &[&str]) {
    let command = run.words().pop().unwrap();
    let marker = Regex::new(r"(__ROAMGATE_GIT_STATUS_\w+?__)")
        .unwrap()
        .captures(&command)
        .unwrap()[1]
        .to_owned();
    let stdout: String = branches
        .iter()
        .enumerate()
        .map(|(index, branch)| {
            format!("{marker}BEGIN {index}\n## {branch}\n{marker}END {index} 0\n")
        })
        .collect();
    run.resolve(Ran::new(0, stdout, ""));
}

fn some(branches: &[&str]) -> Vec<Option<String>> {
    branches.iter().map(|b| Some((*b).to_owned())).collect()
}

#[tokio::test]
async fn with_no_cold_budget_the_first_list_answers_at_once_and_pushes_the_result() {
    let s = setup(None, Duration::ZERO);
    assert_eq!(list(&s.status, &["/a"]).await, [None]);
    settle().await;
    assert_eq!(s.runner.count(), 1);
    assert_eq!(
        s.runner.run(0).words(),
        [
            "git",
            "--no-optional-locks",
            "-C",
            "/a",
            "status",
            "--porcelain=v1",
            "--branch"
        ]
    );
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    let pushes = s.pushes();
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0][0]["checkout_path"], "/a");
    assert_eq!(pushes[0][0]["git_status"]["branch"], "main");
    assert_eq!(pushes[0][0]["git_status"]["dirty"], false);
    assert_eq!(list(&s.status, &["/a"]).await, some(&["main"]));
    assert_eq!(s.runner.count(), 1);
}

#[tokio::test]
async fn the_first_list_waits_for_a_first_read_that_lands_within_the_budget() {
    let s = setup(None, GIT_STATUS_COLD_BUDGET);
    let status = s.status.clone();
    let listing = tokio::spawn(async move { list(&status, &["/a"]).await });
    settle().await;
    local_reply(&s.runner.run(0), "main", false);
    assert_eq!(listing.await.unwrap(), some(&["main"]));
}

#[tokio::test]
async fn a_slow_first_read_delays_only_one_list_then_arrives_as_a_push() {
    let s = setup(Some("desktop"), GIT_STATUS_COLD_BUDGET);
    let status = s.status.clone();
    let listing = tokio::spawn(async move { list(&status, &["/a"]).await });
    settle().await;
    assert_eq!(s.runner.count(), 1);
    s.clock.advance(300).await;
    assert_eq!(listing.await.unwrap(), [None]);
    // The read is still pending, but this checkout already had its wait.
    assert_eq!(list(&s.status, &["/a"]).await, [None]);
    assert_eq!(s.runner.count(), 1);
    remote_reply(&s.runner.run(0), &["main"]);
    s.status.refresh_settled().await;
    assert_eq!(s.pushes()[0][0]["git_status"]["branch"], "main");
    assert_eq!(list(&s.status, &["/a"]).await, some(&["main"]));
}

#[tokio::test]
async fn stale_entries_are_served_while_one_background_refresh_runs() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    s.clock.advance(GIT_STATUS_REFRESH_MS as u64).await;
    assert_eq!(list(&s.status, &["/a"]).await, some(&["main"]));
    assert_eq!(list(&s.status, &["/a"]).await, some(&["main"]));
    settle().await;
    assert_eq!(s.runner.count(), 2);
    local_reply(&s.runner.run(1), "topic", false);
    s.status.refresh_settled().await;
    let pushes = s.pushes();
    assert_eq!(pushes.len(), 2);
    assert_eq!(pushes[1][0]["git_status"]["branch"], "topic");
    assert_eq!(list(&s.status, &["/a"]).await, some(&["topic"]));
    assert_eq!(s.runner.count(), 2);
}

#[tokio::test]
async fn an_unchanged_refresh_pushes_nothing() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    s.clock.advance(GIT_STATUS_REFRESH_MS as u64).await;
    list(&s.status, &["/a"]).await;
    settle().await;
    local_reply(&s.runner.run(1), "main", false);
    s.status.refresh_settled().await;
    assert_eq!(s.pushes().len(), 1);
}

#[tokio::test]
async fn invalidation_refreshes_immediately_even_during_a_refresh() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    s.status.invalidate_root("/a");
    settle().await;
    assert_eq!(s.runner.count(), 2);
    // A second git action lands while the first refresh is still reading.
    s.status.invalidate_root("/a");
    settle().await;
    assert_eq!(s.runner.count(), 2);
    local_reply(&s.runner.run(1), "main", true);
    settle().await;
    assert_eq!(s.runner.count(), 3);
    local_reply(&s.runner.run(2), "main", false);
    s.status.refresh_settled().await;
    let dirty: Vec<Value> = s
        .pushes()
        .iter()
        .map(|push| push[0]["git_status"]["dirty"].clone())
        .collect();
    assert_eq!(dirty, [json!(false), json!(true), json!(false)]);
    assert_eq!(list(&s.status, &["/a"]).await, some(&["main"]));
    assert_eq!(s.runner.count(), 3);
}

#[tokio::test]
async fn workspace_invalidation_maps_to_its_checkout() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a", "/b"]).await;
    settle().await;
    local_reply(&s.runner.run(0), "a", false);
    local_reply(&s.runner.run(1), "b", false);
    s.status.refresh_settled().await;
    s.status.invalidate_workspace("w2");
    settle().await;
    assert_eq!(s.runner.count(), 3);
    assert_eq!(s.runner.run(2).words()[3], "/b");
    s.status.invalidate_workspace("unknown");
    settle().await;
    assert_eq!(s.runner.count(), 3);
}

#[tokio::test]
async fn a_transport_failure_keeps_the_last_known_status() {
    let s = setup(Some("desktop"), Duration::ZERO);
    list(&s.status, &["/a", "/b"]).await;
    settle().await;
    let words = s.runner.run(0).words();
    assert_eq!(words[0], "ssh");
    assert!(words[1].starts_with("export GIT_OPTIONAL_LOCKS=0\n"));
    remote_reply(&s.runner.run(0), &["a", "b"]);
    s.status.refresh_settled().await;
    assert_eq!(list(&s.status, &["/a", "/b"]).await, some(&["a", "b"]));
    s.clock.advance(GIT_STATUS_REFRESH_MS as u64).await;
    list(&s.status, &["/a", "/b"]).await;
    settle().await;
    s.runner.run(1).reject("ssh timed out after 8000ms");
    s.status.refresh_settled().await;
    assert_eq!(s.pushes().len(), 1);
    assert_eq!(list(&s.status, &["/a", "/b"]).await, some(&["a", "b"]));
    // The failed attempt still counts, so polling does not hammer ssh.
    settle().await;
    assert_eq!(s.runner.count(), 2);
}

#[tokio::test]
async fn a_transport_failure_with_no_previous_status_reports_the_error() {
    let s = setup(Some("desktop"), Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    s.runner.run(0).resolve(Ran::new(255, "", "unreachable"));
    s.status.refresh_settled().await;
    assert_eq!(s.pushes()[0][0]["git_status"]["error"], "unreachable");
}

#[tokio::test]
async fn checkouts_that_leave_the_list_are_forgotten() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    // The workspace closes before its first read returns.
    list(&s.status, &[]).await;
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    assert!(s.pushes().is_empty());
    assert_eq!(list(&s.status, &["/a"]).await, [None]);
    settle().await;
    assert_eq!(s.runner.count(), 2);
}

#[tokio::test]
async fn dispose_stops_reads_and_drops_the_one_in_flight() {
    let s = setup(None, Duration::ZERO);
    list(&s.status, &["/a"]).await;
    settle().await;
    s.status.dispose();
    local_reply(&s.runner.run(0), "main", false);
    s.status.refresh_settled().await;
    assert!(s.pushes().is_empty());
    s.status.invalidate_root("/a");
    s.clock.advance(GIT_STATUS_REFRESH_MS as u64).await;
    assert_eq!(list(&s.status, &["/a"]).await, [None]);
    settle().await;
    assert_eq!(s.runner.count(), 1);
}

#[test]
fn parses_branch_tracking_and_change_counts() {
    let summary = parse_git_status(
        "## topic...origin/topic [ahead 2, behind 1]\nM  staged\n M unstaged\nMM both\n?? new\nUU conflict\nAA added\n",
    );
    assert_eq!(
        summary.to_json(),
        json!({
            "ahead": 2, "behind": 1, "staged": 2, "unstaged": 2, "untracked": 1,
            "conflicted": 2, "dirty": true, "branch": "topic", "upstream": "origin/topic",
        })
    );
    assert_eq!(
        parse_git_status("## HEAD (no branch)\n").branch.as_deref(),
        Some("detached")
    );
    assert_eq!(
        parse_git_status("## No commits yet on main\n")
            .branch
            .as_deref(),
        Some("main")
    );
}
