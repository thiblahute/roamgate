//! last-step-turns.test.ts.

use std::sync::Arc;

use roamgate_base::clock::TokioClock;
use tokio::sync::{Notify, Semaphore};

use super::*;
use crate::status_test_support::settle;

#[derive(Default)]
struct Recorded {
    captures: Mutex<Vec<String>>,
    completions: Mutex<Vec<String>>,
    errors: Mutex<Vec<String>>,
    /// Captures wait for a permit when set.
    capture_gate: Option<Arc<Semaphore>>,
    capture_started: Option<Arc<Notify>>,
    capture_fails: bool,
}

impl Recorded {
    fn captures(&self) -> Vec<String> {
        self.captures.lock().unwrap().clone()
    }

    fn completions(&self) -> Vec<String> {
        self.completions.lock().unwrap().clone()
    }
}

impl TurnHooks for Recorded {
    fn capture(&self, workspace_id: String) -> BoxFuture<'static, Result<(), String>> {
        self.captures.lock().unwrap().push(workspace_id);
        if let Some(started) = &self.capture_started {
            started.notify_one();
        }
        let gate = self.capture_gate.clone();
        let fails = self.capture_fails;
        async move {
            if let Some(gate) = gate {
                let _permit = gate.acquire().await.unwrap();
            }
            if fails {
                Err("snapshot failed".into())
            } else {
                Ok(())
            }
        }
        .boxed()
    }

    fn complete(&self, workspace_id: String) -> BoxFuture<'static, Result<(), String>> {
        self.completions.lock().unwrap().push(workspace_id);
        async { Ok(()) }.boxed()
    }

    fn capture_error(&self, error: &str, workspace_id: &str) {
        self.errors
            .lock()
            .unwrap()
            .push(format!("{workspace_id}: {error}"));
    }
}

fn tracker(hooks: Arc<Recorded>, debounce: Duration) -> LastStepTurns {
    LastStepTurns::new(
        hooks,
        Arc::new(TokioClock::starting_at(1_791_504_000_000)),
        debounce,
    )
}

fn status(pane: &str, workspace: &str, agent_status: &str) -> Value {
    json!({
        "event": "pane.agent_status_changed",
        "data": { "pane_id": pane, "workspace_id": workspace, "agent_status": agent_status },
    })
}

fn listed(panes: &[(&str, &str, &str, &str)]) -> Value {
    json!({
        "panes": panes.iter().map(|(pane, workspace, agent, status)| json!({
            "pane_id": pane, "workspace_id": workspace, "agent": agent, "agent_status": status,
        })).collect::<Vec<_>>(),
    })
}

fn moved(previous: &str, previous_workspace: &str, pane: &str, workspace: &str) -> Value {
    json!({
        "event": "pane_moved",
        "data": {
            "type": "pane_moved",
            "previous_pane_id": previous,
            "previous_workspace_id": previous_workspace,
            "previous_tab_id": format!("{previous_workspace}:tab1"),
            "pane": { "pane_id": pane, "workspace_id": workspace, "agent_status": "working" },
        },
    })
}

#[tokio::test]
async fn captures_starts_and_completes_only_workspace_wide_activity_periods() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    tracker.handle_herdr_event(&status("p2", "w1", "working"));
    settle().await;
    tracker.handle_herdr_event(&status("p1", "w1", "idle"));
    tracker.handle_herdr_event(&status("p2", "w1", "done"));
    settle().await;
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    assert_eq!(hooks.captures(), ["w1", "w1"]);
    assert_eq!(hooks.completions(), ["w1"]);
}

#[tokio::test]
async fn seeds_active_workspaces_from_pane_listings_without_capturing() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.reconcile_pane_list(&listed(&[("p1", "w1", "pi", "working")]), None);
    tracker.handle_herdr_event(&status("p2", "w1", "working"));
    tracker.handle_herdr_event(&status("p1", "w1", "idle"));
    tracker.handle_herdr_event(&status("p2", "w1", "done"));
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
}

#[tokio::test]
async fn does_not_let_a_stale_idle_listing_overwrite_a_newer_working_event() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    let idle = listed(&[("p1", "w1", "pi", "idle")]);
    tracker.reconcile_pane_list(&idle, None);
    let revision = tracker.begin_pane_list();
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    tracker.reconcile_pane_list(&idle, Some(revision));
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
}

#[tokio::test]
async fn does_not_let_a_stale_working_listing_suppress_the_next_turn() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    let working = listed(&[("p1", "w1", "pi", "working")]);
    tracker.reconcile_pane_list(&working, None);
    let revision = tracker.begin_pane_list();
    tracker.handle_herdr_event(&status("p1", "w1", "idle"));
    tracker.reconcile_pane_list(&working, Some(revision));
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
}

#[tokio::test]
async fn captures_a_quiet_to_active_transition_observed_by_a_later_pane_listing() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.reconcile_pane_list(&listed(&[]), None);
    tracker.reconcile_pane_list(
        &listed(&[
            ("p1", "w1", "pi", "working"),
            ("p2", "w1", "codex", "working"),
        ]),
        None,
    );
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
}

#[tokio::test]
async fn forgets_closed_panes_when_deciding_whether_a_workspace_is_quiet() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    tracker.handle_herdr_event(&json!({
        "event": "pane.closed",
        "data": { "pane_id": "p1", "workspace_id": "w1" },
    }));
    settle().await;
    tracker.handle_herdr_event(&status("p2", "w1", "working"));
    settle().await;
    assert_eq!(hooks.captures(), ["w1", "w1"]);
}

#[tokio::test(start_paused = true)]
async fn debounces_transient_idle_flapping_before_snapshot_work_starts() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::from_millis(20));
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    tracker.handle_herdr_event(&status("p1", "w1", "idle"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(hooks.captures().is_empty());
    assert!(hooks.completions().is_empty());
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
    tracker.stop().await;
}

#[tokio::test]
async fn coalesces_queued_edges_while_one_workspace_snapshot_is_in_flight() {
    let gate = Arc::new(Semaphore::new(0));
    let hooks = Arc::new(Recorded {
        capture_gate: Some(gate.clone()),
        ..Recorded::default()
    });
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    tracker.handle_herdr_event(&status("p1", "w1", "idle"));
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    gate.add_permits(10);
    settle().await;
    assert_eq!(hooks.captures(), ["w1"]);
    assert!(hooks.completions().is_empty());
    tracker.stop().await;
}

#[tokio::test]
async fn transfers_a_working_pane_between_workspace_activity_periods() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.reconcile_pane_list(&listed(&[("p1", "old", "pi", "working")]), None);
    tracker.handle_herdr_event(&moved("p1", "old", "p2", "new"));
    settle().await;
    assert_eq!(hooks.completions(), ["old"]);
    assert_eq!(hooks.captures(), ["new"]);
    tracker.handle_herdr_event(&status("p2", "new", "done"));
    settle().await;
    assert_eq!(hooks.completions(), ["old", "new"]);
    tracker.stop().await;
}

#[tokio::test]
async fn follows_pane_id_changes_for_moves_within_one_workspace() {
    let hooks = Arc::new(Recorded::default());
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    tracker.handle_herdr_event(&moved("p1", "w1", "p2", "w1"));
    tracker.handle_herdr_event(&status("p2", "w1", "done"));
    settle().await;
    assert_eq!(hooks.completions(), ["w1"]);
    tracker.stop().await;
}

#[tokio::test]
async fn does_not_complete_a_closed_workspace_after_its_capture_settles() {
    let gate = Arc::new(Semaphore::new(0));
    let started = Arc::new(Notify::new());
    let hooks = Arc::new(Recorded {
        capture_gate: Some(gate.clone()),
        capture_started: Some(started.clone()),
        ..Recorded::default()
    });
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    started.notified().await;
    tracker.handle_herdr_event(&json!({
        "event": "workspace.closed",
        "data": { "workspace_id": "w1" },
    }));
    gate.add_permits(10);
    settle().await;
    assert!(hooks.completions().is_empty());
    tracker.stop().await;
}

#[tokio::test]
async fn reports_capture_failures_without_rejecting_event_handling() {
    let hooks = Arc::new(Recorded {
        capture_fails: true,
        ..Recorded::default()
    });
    let tracker = tracker(hooks.clone(), Duration::ZERO);
    tracker.handle_herdr_event(&status("p1", "w1", "working"));
    settle().await;
    assert_eq!(*hooks.errors.lock().unwrap(), ["w1: snapshot failed"]);
}
