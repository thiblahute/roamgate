//! An agent's last step: the checkout's snapshots when its work starts
//! and ends (git-diff.ts `createLastStepBaselineStore`). A capture starts
//! at once and runs to its end whoever waits for it, as a TS promise
//! does; captures of one checkout run one at a time; a completed step's
//! trees are kept under refs (`refs/roamgate/steps/...`) when asked, and
//! read back after a restart.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};

use crate::GitError;
use crate::diff::{StepRange, persist_last_step, read_last_step_refs};
use crate::exec::GitContext;
use crate::snapshot::{Snapshot, snapshot_worktree};

const LAST_STEP_SNAPSHOT_LIMIT: usize = 64;
/// The error of a store that was disposed.
pub const DISPOSED: &str = "last-step snapshot store is disposed";

/// A capture's end: its checkout, tree and the files it left out.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Captured {
    root: String,
    baseline: String,
    skipped: Vec<String>,
}

type CaptureFuture = Shared<BoxFuture<'static, Result<Captured, String>>>;
type CompletionFuture = Shared<BoxFuture<'static, Result<bool, String>>>;
type RecoveredFuture = Shared<BoxFuture<'static, Option<StepRange>>>;

struct Cycle {
    version: u64,
    capture: CaptureFuture,
    completion: Option<CompletionFuture>,
    next_capture: Option<CaptureFuture>,
    /// The previous turn's end, when this turn started before it was done.
    prior_completion: Option<CompletionFuture>,
}

#[derive(Default)]
struct State {
    versions: BTreeMap<String, u64>,
    completed: BTreeMap<String, (String, StepRange)>,
    recovered: BTreeMap<String, RecoveredFuture>,
    completed_versions: BTreeMap<String, u64>,
    cycles: BTreeMap<String, Arc<Mutex<Cycle>>>,
    /// By id, oldest first.
    snapshots: VecDeque<(String, String, String, String, String)>,
    in_flight: Vec<Shared<BoxFuture<'static, ()>>>,
}

/// Which steps of a checkout have threads: their refs are kept past the
/// last few. Set by the review service (asked across the channel while
/// the front keeps it, hence a future).
pub type Keeper = Arc<dyn Fn(&str) -> BoxFuture<'static, Vec<String>> + Send + Sync>;

pub struct LastStepStore {
    cx: GitContext,
    refs: bool,
    keeper: Mutex<Option<Keeper>>,
    state: Mutex<State>,
    roots: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    disposed: AtomicBool,
}

/// Runs a future on its own, as a promise does, and shares its end.
fn eager<T: Clone + Send + Sync + 'static>(
    future: impl Future<Output = T> + Send + 'static,
) -> Shared<BoxFuture<'static, T>> {
    let handle = tokio::spawn(future);
    async move { handle.await.expect("a last-step task panicked") }
        .boxed()
        .shared()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `new Date(ms).toISOString()`.
pub fn iso_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// A new step's id: its end in ms (sorts by time), a few random letters.
pub fn new_last_step_id(at: i64) -> String {
    let random = uuid::Uuid::new_v4().to_string();
    format!("{at:013}-{}", &random[..8])
}

impl LastStepStore {
    /// `refs`: each completed step's trees are kept under refs and read
    /// back after a restart; off, steps live in memory only.
    pub fn new(cx: GitContext, refs: bool) -> Arc<Self> {
        Arc::new(Self {
            cx,
            refs,
            keeper: Mutex::new(None),
            state: Mutex::new(State::default()),
            roots: Mutex::new(BTreeMap::new()),
            disposed: AtomicBool::new(false),
        })
    }

    pub fn set_keeper(&self, keeper: Option<Keeper>) {
        *self.keeper.lock().unwrap() = keeper;
    }

    fn disposed(&self) -> bool {
        self.disposed.load(Ordering::SeqCst)
    }

    fn track(&self, done: Shared<BoxFuture<'static, ()>>) {
        let mut state = self.state.lock().unwrap();
        state.in_flight.retain(|task| task.peek().is_none());
        state.in_flight.push(done);
    }

    /// The checkout's snapshot, after the captures of the same root
    /// before it (the on-disk quarantine also excludes other stores).
    async fn snapshot_root(self: &Arc<Self>, root: &str) -> Result<Snapshot, String> {
        let lock = self
            .roots
            .lock()
            .unwrap()
            .entry(root.to_owned())
            .or_default()
            .clone();
        let _turn = lock.lock().await;
        snapshot_worktree(&self.cx, root)
            .await
            .map_err(|e| e.to_string())
    }

    /// A step starts: the checkout's snapshot, its baseline.
    pub async fn capture_workspace(
        self: &Arc<Self>,
        workspace_id: &str,
        resolve_root: BoxFuture<'static, Result<String, GitError>>,
    ) -> Result<String, GitError> {
        if self.disposed() {
            return Err(GitError::message(DISPOSED));
        }
        let store = self.clone();
        let capture: CaptureFuture = eager(async move {
            let root = resolve_root.await.map_err(|e| e.to_string())?;
            if store.disposed() {
                return Err(DISPOSED.to_owned());
            }
            let snapshot = store.snapshot_root(&root).await?;
            if store.disposed() {
                return Err(DISPOSED.to_owned());
            }
            Ok(Captured {
                root,
                baseline: snapshot.tree,
                skipped: snapshot.skipped,
            })
        });
        self.track(capture.clone().map(|_| ()).boxed().shared());
        {
            let mut state = self.state.lock().unwrap();
            let version = state.versions.get(workspace_id).copied().unwrap_or(0) + 1;
            state.versions.insert(workspace_id.to_owned(), version);
            let prior_completion = state
                .cycles
                .get(workspace_id)
                .and_then(|cycle| cycle.lock().unwrap().completion.clone());
            let prior = state.cycles.insert(
                workspace_id.to_owned(),
                Arc::new(Mutex::new(Cycle {
                    version,
                    capture: capture.clone(),
                    completion: None,
                    next_capture: None,
                    prior_completion,
                })),
            );
            if let Some(prior) = prior {
                let mut prior = prior.lock().unwrap();
                if prior.completion.is_some() {
                    prior.next_capture = Some(capture.clone());
                }
            }
        }
        capture
            .await
            .map(|captured| captured.baseline)
            .map_err(GitError::Message)
    }

    /// A step ends: the checkout's snapshot after it becomes the completed
    /// step (unless a newer one already completed). False when nothing
    /// completed.
    pub async fn complete_workspace(
        self: &Arc<Self>,
        workspace_id: &str,
    ) -> Result<bool, GitError> {
        if self.disposed() {
            return Err(GitError::message(DISPOSED));
        }
        let Some(cycle) = self.state.lock().unwrap().cycles.get(workspace_id).cloned() else {
            return Ok(false);
        };
        let existing = cycle.lock().unwrap().completion.clone();
        if let Some(completion) = existing {
            return completion.await.map_err(GitError::Message);
        }
        let store = self.clone();
        let workspace = workspace_id.to_owned();
        let task_cycle = cycle.clone();
        let completion: CompletionFuture = eager(async move {
            let (capture, version) = {
                let cycle = task_cycle.lock().unwrap();
                (cycle.capture.clone(), cycle.version)
            };
            let Ok(captured) = capture.await else {
                return Ok(false);
            };
            let after = store.snapshot_root(&captured.root).await?;
            let mut current = after.tree;
            let mut skipped_after = after.skipped;
            let next = task_cycle.lock().unwrap().next_capture.clone();
            if let Some(next) = next {
                match next.await {
                    Ok(next) => {
                        if next.root == captured.root {
                            current = next.baseline;
                            skipped_after = next.skipped;
                        }
                    }
                    // A newer period that failed to set its boundary: no
                    // late end is published.
                    Err(_) => return Ok(false),
                }
            }
            if store.disposed() {
                return Ok(false);
            }
            let ended = now_ms();
            let step = new_last_step_id(ended);
            let skipped: Vec<String> = captured
                .skipped
                .iter()
                .chain(skipped_after.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let range = StepRange {
                baseline: captured.baseline.clone(),
                current: current.clone(),
                step: Some(step.clone()),
                at: Some(iso_time(ended)),
                skipped: skipped.clone(),
            };
            {
                let mut state = store.state.lock().unwrap();
                if state
                    .completed_versions
                    .get(&workspace)
                    .copied()
                    .unwrap_or(0)
                    >= version
                {
                    return Ok(false);
                }
                state.completed_versions.insert(workspace.clone(), version);
                state
                    .completed
                    .insert(workspace.clone(), (captured.root.clone(), range.clone()));
                state
                    .recovered
                    .remove(&format!("{workspace}\n{}", captured.root));
            }
            // Under refs, so the step's review outlives a restart and gc;
            // best effort: without them it shows from memory.
            if store.refs {
                let keeper = store.keeper.lock().unwrap().clone();
                let keep = match keeper {
                    Some(keeper) => keeper(&captured.root).await,
                    None => Vec::new(),
                };
                let _ =
                    persist_last_step(&store.cx, &captured.root, &workspace, &step, &range, &keep)
                        .await;
            }
            store
                .state
                .lock()
                .unwrap()
                .snapshots
                .retain(|(_, ws, _, _, _)| *ws != workspace);
            Ok(true)
        });
        self.track(completion.clone().map(|_| ()).boxed().shared());
        cycle.lock().unwrap().completion = Some(completion.clone());
        completion.await.map_err(GitError::Message)
    }

    /// Lets a read see the workspace's steps as of its call: the current
    /// turn's baseline captured (so the turn's edits are not in it, however
    /// soon they follow the read), its end if it is being recorded, and a
    /// previous turn's end still being recorded. A failed capture or end
    /// keeps the previous completed step.
    async fn settle_completion(&self, workspace_id: &str) {
        let pending = self
            .state
            .lock()
            .unwrap()
            .cycles
            .get(workspace_id)
            .map(|cycle| {
                let cycle = cycle.lock().unwrap();
                (
                    cycle.capture.clone(),
                    cycle.completion.clone(),
                    cycle.prior_completion.clone(),
                )
            });
        let Some((capture, completion, prior)) = pending else {
            return;
        };
        let _ = capture.await;
        if let Some(completion) = completion {
            let _ = completion.await;
        }
        if let Some(prior) = prior {
            let _ = prior.await;
        }
    }

    /// The completed step's trees, when it is of this checkout.
    pub async fn resolve_completed(
        &self,
        workspace_id: &str,
        root: &str,
    ) -> Option<(String, String)> {
        if self.disposed() {
            return None;
        }
        self.settle_completion(workspace_id).await;
        let state = self.state.lock().unwrap();
        let (range_root, range) = state.completed.get(workspace_id)?;
        (range_root == root).then(|| (range.baseline.clone(), range.current.clone()))
    }

    /// The completed step as a review target needs it; after a restart,
    /// the latest one kept under refs (read once).
    pub async fn completed_step(
        self: &Arc<Self>,
        workspace_id: &str,
        root: &str,
    ) -> Option<StepRange> {
        if self.disposed() {
            return None;
        }
        self.settle_completion(workspace_id).await;
        let found = {
            let mut state = self.state.lock().unwrap();
            if let Some((range_root, range)) = state.completed.get(workspace_id) {
                return (range_root == root).then(|| range.clone());
            }
            let key = format!("{workspace_id}\n{root}");
            let known = state.recovered.get(&key).cloned();
            if !self.refs {
                return None;
            }
            match known {
                Some(found) => found,
                None => {
                    let cx = self.cx.clone();
                    let (root, workspace) = (root.to_owned(), workspace_id.to_owned());
                    let found: RecoveredFuture = eager(async move {
                        read_last_step_refs(&cx, &root, &workspace)
                            .await
                            .ok()
                            .flatten()
                    });
                    state.recovered.insert(key, found.clone());
                    found
                }
            }
        };
        found.await
    }

    /// Keeps a summary's tree pair for its file reads; the oldest go past
    /// the limit.
    pub fn remember_snapshot(
        &self,
        workspace_id: &str,
        root: &str,
        baseline: &str,
        current: &str,
    ) -> Result<String, GitError> {
        if self.disposed() {
            return Err(GitError::message(DISPOSED));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut state = self.state.lock().unwrap();
        state.snapshots.push_back((
            id.clone(),
            workspace_id.to_owned(),
            root.to_owned(),
            baseline.to_owned(),
            current.to_owned(),
        ));
        while state.snapshots.len() > LAST_STEP_SNAPSHOT_LIMIT {
            state.snapshots.pop_front();
        }
        Ok(id)
    }

    pub fn resolve_snapshot(
        &self,
        workspace_id: &str,
        root: &str,
        id: &str,
    ) -> Option<(String, String)> {
        let state = self.state.lock().unwrap();
        state
            .snapshots
            .iter()
            .find(|(each, ws, r, _, _)| each == id && ws == workspace_id && r == root)
            .map(|(_, _, _, baseline, current)| (baseline.clone(), current.clone()))
    }

    pub fn delete_snapshot(&self, id: &str) {
        self.state
            .lock()
            .unwrap()
            .snapshots
            .retain(|(each, ..)| each != id);
    }

    /// The step of this workspace and checkout is gone (its trees were
    /// collected): forget it, and do not read it back from refs.
    pub fn invalidate_workspace(&self, workspace_id: &str, root: &str) {
        let mut state = self.state.lock().unwrap();
        state
            .snapshots
            .retain(|(_, ws, r, _, _)| !(ws == workspace_id && r == root));
        if state
            .completed
            .get(workspace_id)
            .is_some_and(|(r, _)| r == root)
        {
            state.completed.remove(workspace_id);
            state.completed_versions.remove(workspace_id);
        }
        state.recovered.insert(
            format!("{workspace_id}\n{root}"),
            async { None }.boxed().shared(),
        );
    }

    /// Sets a completed step as if one had ended (tests of the readers).
    #[cfg(test)]
    pub fn set_completed(&self, workspace_id: &str, root: &str, range: StepRange) {
        self.state
            .lock()
            .unwrap()
            .completed
            .insert(workspace_id.to_owned(), (root.to_owned(), range));
    }

    /// Stops the store: in-flight captures drain, then its state goes. A
    /// capture's quarantine left by an uncertain end stays for recovery.
    pub async fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        let tasks = std::mem::take(&mut self.state.lock().unwrap().in_flight);
        futures_util::future::join_all(tasks).await;
        *self.state.lock().unwrap() = State::default();
        self.roots.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times_match_javascript() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
