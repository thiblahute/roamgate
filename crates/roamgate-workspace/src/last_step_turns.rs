//! A connection's agent turns as Last step boundaries
//! (workspace/last-step-turns.ts `createLastStepTurnTracker`): from each
//! pane's agent status (Herdr's events and the agent status listings), a
//! workspace becomes active when one of its panes works and quiet when
//! none does, each change held for a debounce; an active edge captures the
//! workspace's baseline, a quiet one completes its step, one edge at a time
//! per workspace, coalesced while one runs.
//!
//! [`ConnectionTurnHooks`] wires it as runtime.ts does: captures and
//! completions through roamgate-git's [`LastStepStore`], the status badge
//! invalidated, and `workspace.last_step_completed` pushed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogFields, Logger};
use roamgate_git::steps::LastStepStore;
use serde_json::{Value, json};

use crate::auto_sync::GitRootResolver;
use crate::connection::WorkspaceConnection;
use crate::status::GitStatus;

/// runtime.ts's `lastStepTransitionDebounceMs` default.
pub const LAST_STEP_TRANSITION_DEBOUNCE: Duration = Duration::from_millis(150);

/// What a workspace's edges do.
pub trait TurnHooks: Send + Sync + 'static {
    /// The workspace became active: capture its baseline.
    fn capture(&self, workspace_id: String) -> BoxFuture<'static, Result<(), String>>;
    /// The workspace became quiet: complete its step.
    fn complete(&self, _workspace_id: String) -> BoxFuture<'static, Result<(), String>> {
        async { Ok(()) }.boxed()
    }
    fn capture_error(&self, _error: &str, _workspace_id: &str) {}
    fn complete_error(&self, _error: &str, _workspace_id: &str) {}
}

/// A Herdr event's name: `event`, else `data.type` (utils/herdr-events.ts).
pub fn herdr_event_name(event: &Value) -> Option<&str> {
    let envelope = event.as_object()?;
    if let Some(name) = envelope.get("event").and_then(Value::as_str)
        && !name.is_empty()
    {
        return Some(name);
    }
    envelope
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("type"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
}

#[derive(Clone)]
struct Pane {
    workspace_id: String,
    status: String,
}

type Worker = Shared<BoxFuture<'static, ()>>;

#[derive(Default)]
struct State {
    panes: BTreeMap<String, Pane>,
    pane_event_revisions: BTreeMap<String, u64>,
    closed_workspace_revisions: BTreeMap<String, u64>,
    stable: BTreeMap<String, bool>,
    applied: BTreeMap<String, bool>,
    pending: BTreeMap<String, (u64, tokio::task::JoinHandle<()>)>,
    workers: BTreeMap<String, (u64, Worker)>,
    workspace_generations: BTreeMap<String, u64>,
    activity_revision: u64,
    seeded: bool,
    stopping: bool,
    next_id: u64,
}

impl State {
    fn is_active(&self, workspace_id: &str) -> bool {
        self.panes
            .values()
            .any(|pane| pane.workspace_id == workspace_id && pane.status == "working")
    }

    fn stable(&self, workspace_id: &str) -> bool {
        self.stable.get(workspace_id).copied().unwrap_or(false)
    }

    fn applied(&self, workspace_id: &str) -> bool {
        self.applied.get(workspace_id).copied().unwrap_or(false)
    }

    fn generation(&self, workspace_id: &str) -> u64 {
        self.workspace_generations
            .get(workspace_id)
            .copied()
            .unwrap_or(0)
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

struct Inner {
    hooks: Arc<dyn TurnHooks>,
    clock: SharedClock,
    debounce: Duration,
    state: Mutex<State>,
}

/// One connection generation's turn tracker.
#[derive(Clone)]
pub struct LastStepTurns(Arc<Inner>);

/// The hook of an edge, called at once as the TS worker did up to its
/// first await.
fn edge(inner: &Inner, workspace_id: &str, active: bool) -> BoxFuture<'static, Result<(), String>> {
    if active {
        inner.hooks.capture(workspace_id.to_owned())
    } else {
        inner.hooks.complete(workspace_id.to_owned())
    }
}

fn start_worker(inner: &Arc<Inner>, state: &mut State, workspace_id: &str) {
    if state.stopping || state.workers.contains_key(workspace_id) {
        return;
    }
    let desired = state.stable(workspace_id);
    if desired == state.applied(workspace_id) {
        return;
    }
    let generation = state.generation(workspace_id);
    let id = state.next_id();
    let first = edge(inner, workspace_id, desired);
    let task_inner = inner.clone();
    let workspace = workspace_id.to_owned();
    let handle = tokio::spawn(async move {
        let (mut desired, mut running) = (desired, first);
        loop {
            // Git and IO failures are reported once at this boundary; the
            // failed edge is consumed so status flapping cannot queue
            // retries without end.
            if let Err(error) = running.await {
                if desired {
                    task_inner.hooks.capture_error(&error, &workspace);
                } else {
                    task_inner.hooks.complete_error(&error, &workspace);
                }
            }
            let mut state = task_inner.state.lock().unwrap();
            if state.stopping || state.generation(&workspace) != generation {
                break;
            }
            state.applied.insert(workspace.clone(), desired);
            let next = state.stable(&workspace);
            if next == state.applied(&workspace) {
                break;
            }
            desired = next;
            running = edge(&task_inner, &workspace, desired);
        }
        let mut state = task_inner.state.lock().unwrap();
        if state
            .workers
            .get(&workspace)
            .is_some_and(|(worker, _)| *worker == id)
        {
            state.workers.remove(&workspace);
        }
        if !state.stopping && state.stable(&workspace) != state.applied(&workspace) {
            start_worker(&task_inner, &mut state, &workspace);
        }
    });
    let worker: Worker = async move {
        let _ = handle.await;
    }
    .boxed()
    .shared();
    state.workers.insert(workspace_id.to_owned(), (id, worker));
}

fn commit_transition(inner: &Arc<Inner>, state: &mut State, workspace_id: &str, active: bool) {
    if state.stopping || state.is_active(workspace_id) != active {
        return;
    }
    if state.stable(workspace_id) == active {
        return;
    }
    state.stable.insert(workspace_id.to_owned(), active);
    start_worker(inner, state, workspace_id);
}

fn observe_workspace(inner: &Arc<Inner>, state: &mut State, workspace_id: &str) {
    if state.stopping {
        return;
    }
    let active = state.is_active(workspace_id);
    if let Some((_, timer)) = state.pending.remove(workspace_id) {
        timer.abort();
    }
    if state.stable(workspace_id) == active {
        return;
    }
    if inner.debounce.is_zero() {
        commit_transition(inner, state, workspace_id, active);
        return;
    }
    let id = state.next_id();
    let sleep = inner.clock.sleep(inner.debounce);
    let task_inner = inner.clone();
    let workspace = workspace_id.to_owned();
    let timer = tokio::spawn(async move {
        sleep.await;
        let mut state = task_inner.state.lock().unwrap();
        if !state
            .pending
            .get(&workspace)
            .is_some_and(|(timer, _)| *timer == id)
        {
            return;
        }
        state.pending.remove(&workspace);
        commit_transition(&task_inner, &mut state, &workspace, active);
    });
    state.pending.insert(workspace_id.to_owned(), (id, timer));
}

fn cancel_workspace(state: &mut State, workspace_id: &str) {
    let generation = state.generation(workspace_id) + 1;
    state
        .workspace_generations
        .insert(workspace_id.to_owned(), generation);
    if let Some((_, timer)) = state.pending.remove(workspace_id) {
        timer.abort();
    }
    state.stable.remove(workspace_id);
    state.applied.remove(workspace_id);
}

fn text<'a>(data: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn nonempty<'a>(data: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    text(data, key).filter(|text| !text.is_empty())
}

impl LastStepTurns {
    /// `debounce`: how long a change must hold (zero: none).
    pub fn new(hooks: Arc<dyn TurnHooks>, clock: SharedClock, debounce: Duration) -> Self {
        Self(Arc::new(Inner {
            hooks,
            clock,
            debounce,
            state: Mutex::new(State::default()),
        }))
    }

    /// An agent status listing starts: its revision, for
    /// [`Self::reconcile_pane_list`].
    pub fn begin_pane_list(&self) -> u64 {
        self.0.state.lock().unwrap().activity_revision
    }

    /// An agent status listing (`{panes: [...]}`) started at `revision`
    /// (None: now): panes an event changed since keep the event's status.
    /// The first listing seeds the workspaces without an edge.
    pub fn reconcile_pane_list(&self, result: &Value, revision: Option<u64>) {
        let inner = &self.0;
        let mut state = inner.state.lock().unwrap();
        if state.stopping {
            return;
        }
        let started_at = revision.unwrap_or(state.activity_revision);
        let Some(listed) = result
            .as_object()
            .and_then(|result| result.get("panes"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let mut next: BTreeMap<String, Pane> = BTreeMap::new();
        for pane in listed {
            let Some(record) = pane.as_object() else {
                continue;
            };
            if let (Some(pane_id), Some(workspace_id), Some(agent), Some(status)) = (
                text(record, "pane_id"),
                text(record, "workspace_id"),
                text(record, "agent"),
                text(record, "agent_status"),
            ) && !agent.is_empty()
            {
                next.insert(
                    pane_id.to_owned(),
                    Pane {
                        workspace_id: workspace_id.to_owned(),
                        status: status.to_owned(),
                    },
                );
            }
        }
        let mut affected: BTreeSet<String> = state
            .panes
            .values()
            .map(|pane| pane.workspace_id.clone())
            .collect();
        let ids: Vec<String> = next.keys().cloned().collect();
        for pane_id in ids {
            let workspace = next[&pane_id].workspace_id.clone();
            if state
                .closed_workspace_revisions
                .get(&workspace)
                .copied()
                .unwrap_or(0)
                > started_at
            {
                next.remove(&pane_id);
                continue;
            }
            if state
                .pane_event_revisions
                .get(&pane_id)
                .copied()
                .unwrap_or(0)
                > started_at
            {
                match state.panes.get(&pane_id) {
                    Some(event_pane) => {
                        next.insert(pane_id.clone(), event_pane.clone());
                    }
                    None => {
                        next.remove(&pane_id);
                    }
                }
            }
        }
        for (pane_id, event_pane) in &state.panes {
            if !next.contains_key(pane_id)
                && state
                    .pane_event_revisions
                    .get(pane_id)
                    .copied()
                    .unwrap_or(0)
                    > started_at
            {
                next.insert(pane_id.clone(), event_pane.clone());
            }
        }
        for pane in next.values() {
            affected.insert(pane.workspace_id.clone());
        }
        state.panes = next;
        if !state.seeded {
            for workspace in &affected {
                let active = state.is_active(workspace);
                state.stable.insert(workspace.clone(), active);
                state.applied.insert(workspace.clone(), active);
            }
        } else {
            for workspace in &affected {
                observe_workspace(inner, &mut state, workspace);
            }
        }
        state.seeded = true;
    }

    /// A Herdr event: agent status changes, pane moves and closes, closed
    /// workspaces.
    pub fn handle_herdr_event(&self, event: &Value) {
        let inner = &self.0;
        let mut state = inner.state.lock().unwrap();
        if state.stopping {
            return;
        }
        let Some(name) = herdr_event_name(event) else {
            return;
        };
        let Some(data) = event.get("data").and_then(Value::as_object) else {
            return;
        };
        match name {
            "pane.agent_status_changed" => {
                let (Some(pane_id), Some(workspace_id), Some(status)) = (
                    nonempty(data, "pane_id"),
                    nonempty(data, "workspace_id"),
                    text(data, "agent_status"),
                ) else {
                    return;
                };
                let previous = state.panes.get(pane_id).cloned();
                state.activity_revision += 1;
                let revision = state.activity_revision;
                state
                    .pane_event_revisions
                    .insert(pane_id.to_owned(), revision);
                state.closed_workspace_revisions.remove(workspace_id);
                state.panes.insert(
                    pane_id.to_owned(),
                    Pane {
                        workspace_id: workspace_id.to_owned(),
                        status: status.to_owned(),
                    },
                );
                if let Some(previous) = previous
                    && previous.workspace_id != workspace_id
                {
                    observe_workspace(inner, &mut state, &previous.workspace_id);
                }
                observe_workspace(inner, &mut state, workspace_id);
            }
            "pane.moved" | "pane_moved" => {
                // A move can allocate a new pane id: activity follows both.
                let pane = data.get("pane").and_then(Value::as_object);
                let (Some(previous_pane_id), Some(previous_workspace_id), Some(pane)) = (
                    nonempty(data, "previous_pane_id"),
                    nonempty(data, "previous_workspace_id"),
                    pane,
                ) else {
                    return;
                };
                let (Some(pane_id), Some(workspace_id)) =
                    (nonempty(pane, "pane_id"), nonempty(pane, "workspace_id"))
                else {
                    return;
                };
                let previous = state.panes.get(previous_pane_id).cloned();
                let status = text(pane, "agent_status")
                    .map(str::to_owned)
                    .or_else(|| previous.as_ref().map(|pane| pane.status.clone()))
                    .unwrap_or_else(|| "unknown".to_owned());
                state.activity_revision += 1;
                let revision = state.activity_revision;
                state
                    .pane_event_revisions
                    .insert(previous_pane_id.to_owned(), revision);
                state.panes.remove(previous_pane_id);
                state
                    .pane_event_revisions
                    .insert(pane_id.to_owned(), revision);
                state.closed_workspace_revisions.remove(workspace_id);
                state.panes.insert(
                    pane_id.to_owned(),
                    Pane {
                        workspace_id: workspace_id.to_owned(),
                        status,
                    },
                );
                observe_workspace(inner, &mut state, previous_workspace_id);
                if let Some(previous) = previous
                    && previous.workspace_id != previous_workspace_id
                {
                    observe_workspace(inner, &mut state, &previous.workspace_id);
                }
                if workspace_id != previous_workspace_id {
                    observe_workspace(inner, &mut state, workspace_id);
                }
            }
            "pane.closed" | "pane_closed" => {
                if let Some(pane_id) = text(data, "pane_id") {
                    let pane = state.panes.get(pane_id).cloned();
                    state.activity_revision += 1;
                    let revision = state.activity_revision;
                    state
                        .pane_event_revisions
                        .insert(pane_id.to_owned(), revision);
                    state.panes.remove(pane_id);
                    if let Some(pane) = pane {
                        observe_workspace(inner, &mut state, &pane.workspace_id);
                    }
                }
            }
            "workspace.closed" | "workspace_closed" => {
                let Some(workspace_id) = text(data, "workspace_id") else {
                    return;
                };
                state.activity_revision += 1;
                let revision = state.activity_revision;
                state
                    .closed_workspace_revisions
                    .insert(workspace_id.to_owned(), revision);
                let closed: Vec<String> = state
                    .panes
                    .iter()
                    .filter(|(_, pane)| pane.workspace_id == workspace_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                for pane_id in closed {
                    state.pane_event_revisions.insert(pane_id.clone(), revision);
                    state.panes.remove(&pane_id);
                }
                cancel_workspace(&mut state, workspace_id);
            }
            _ => {}
        }
    }

    /// Stops: no new edge, the snapshots in flight drained, the state
    /// forgotten.
    pub async fn stop(&self) {
        let (workers, first) = {
            let mut state = self.0.state.lock().unwrap();
            let first = !state.stopping;
            state.stopping = true;
            for (_, (_, timer)) in std::mem::take(&mut state.pending) {
                timer.abort();
            }
            let workers: Vec<Worker> = state
                .workers
                .values()
                .map(|(_, worker)| worker.clone())
                .collect();
            (workers, first)
        };
        futures_util::future::join_all(workers).await;
        if first {
            let mut state = self.0.state.lock().unwrap();
            *state = State {
                stopping: true,
                next_id: state.next_id,
                ..State::default()
            };
        }
    }
}

/// runtime.ts's wiring of the tracker for a connection.
pub struct ConnectionTurnHooks {
    pub conn: WorkspaceConnection,
    pub store: Arc<LastStepStore>,
    pub status: GitStatus,
    /// The workspace's Git root (runtime.ts's `resolveLastStepWorkspaceGitRoot`
    /// or files.ts's `resolveWorkspaceGitRoot`).
    pub resolve_git_root: GitRootResolver,
    pub logger: Logger,
    /// Set when the connection generation goes: no push after it.
    pub disposed: Arc<AtomicBool>,
}

impl ConnectionTurnHooks {
    fn log(&self, message: &str, workspace_id: &str, error: &str) {
        let fields: LogFields = [
            ("connection".to_owned(), Value::from(self.conn.id.clone())),
            ("workspace".to_owned(), Value::from(workspace_id)),
            ("error".to_owned(), Value::from(error)),
        ]
        .into_iter()
        .collect();
        self.logger.warn(message, Some(&fields));
    }
}

impl TurnHooks for ConnectionTurnHooks {
    fn capture(&self, workspace_id: String) -> BoxFuture<'static, Result<(), String>> {
        if self.conn.is_windows() {
            return async { Ok(()) }.boxed();
        }
        let store = self.store.clone();
        let resolve = self.resolve_git_root.clone();
        let workspace = workspace_id.clone();
        async move {
            let root = async move {
                resolve(workspace)
                    .await
                    .map(|resolved| resolved.root)
                    .map_err(|error| roamgate_git::GitError::Message(error.message))
            }
            .boxed();
            store
                .capture_workspace(&workspace_id, root)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        .boxed()
    }

    fn complete(&self, workspace_id: String) -> BoxFuture<'static, Result<(), String>> {
        // A finished agent turn is the likeliest moment for the tree to
        // change.
        self.status.invalidate_workspace(&workspace_id);
        let store = self.store.clone();
        let events = self.conn.events.clone();
        let disposed = self.disposed.clone();
        async move {
            let completed = store.complete_workspace(&workspace_id).await;
            // File refresh depends on step completion, not Git snapshot
            // availability.
            if !disposed.load(Ordering::SeqCst) {
                events.emit(
                    "workspace.last_step_completed",
                    json!({"type": "workspace.last_step_completed", "workspace_id": workspace_id}),
                );
            }
            completed.map(|_| ()).map_err(|error| error.to_string())
        }
        .boxed()
    }

    fn capture_error(&self, error: &str, workspace_id: &str) {
        self.log("last-step baseline failed", workspace_id, error);
    }

    fn complete_error(&self, error: &str, workspace_id: &str) {
        self.log("last-step completion failed", workspace_id, error);
    }
}

#[cfg(test)]
mod tests;
