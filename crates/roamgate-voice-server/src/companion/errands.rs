//! Work said by voice (`voice/voice-errands.ts`): an errand for the
//! errands session, or a job the voice companion starts on any session
//! (POST /api/voice/forward). Each is sent as a prompt, then the session's
//! history is watched until its answer settles; the answer is everything
//! it wrote meanwhile.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use indexmap::IndexMap;
use roamgate_base::clock::Clock;
use serde_json::{Value, json};

use crate::companion::turn_causes::{TurnCause, TurnCauses};
use crate::js;

/// What the session is doing now, as its status and its queues say.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrandSessionStatus {
    /// Its agent status: "working", "blocked", "idle", "done", ...
    pub status: Option<String>,
    /// What it asks the user (a permission or a question); None: nothing.
    pub waiting: Option<String>,
    /// Messages queued for it, not read yet (the companion's included).
    pub queued: u32,
}

/// A job's answer as it is kept: who answered what, and the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptAnswer {
    pub job: String,
    /// `<connection>/<pane>`.
    pub pane: String,
    /// The session's name, as said aloud.
    pub label: String,
    /// What the user asked, as said or typed.
    pub question: String,
    pub answer: String,
}

/// What a job is about, for its answer to be kept with.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrandAbout {
    /// The session's name, as said aloud; its pane without one.
    pub label: Option<String>,
    /// The user's words; the text sent without them.
    pub question: Option<String>,
}

/// What the errands need of the server. History entries are the agent
/// history's JSON entries (`id`, `role`, `kind`, `text`).
pub trait ErrandDeps: Send + Sync + 'static {
    fn read(
        &self,
        connection_id: &str,
        pane_id: &str,
    ) -> BoxFuture<'static, Result<Vec<Value>, String>>;
    /// Sends the text to the session, in whichever mode it runs: a
    /// terminal session takes it once idle.
    fn prompt(
        &self,
        connection_id: &str,
        pane_id: &str,
        text: &str,
    ) -> BoxFuture<'static, Result<(), String>>;
    /// The session's status; None when unknown. Without a reader
    /// ([`ErrandDeps::has_status`] false), never asked.
    fn status(
        &self,
        _connection_id: &str,
        _pane_id: &str,
    ) -> BoxFuture<'static, Result<Option<ErrandSessionStatus>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn has_status(&self) -> bool {
        false
    }
    /// Keeps a job's answer the moment it settles, whoever follows the job
    /// (the waiting answers).
    fn keep(&self, _answer: KeptAnswer) {}
}

/// What is worth telling of a job that runs, numbered: a new number is
/// told again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrandNotice {
    /// It waits for the user's OK (what it asks, when known).
    Waiting { seq: u32, what: Option<String> },
    /// Still working, `minutes` since its last message.
    Working { seq: u32, minutes: u64 },
}

impl ErrandNotice {
    pub fn seq(&self) -> u32 {
        match self {
            Self::Waiting { seq, .. } | Self::Working { seq, .. } => *seq,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Waiting { seq, what } => json!({"seq": seq, "kind": "waiting", "what": what}),
            Self::Working { seq, minutes } => {
                json!({"seq": seq, "kind": "working", "minutes": minutes})
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrandState {
    pub done: bool,
    /// The session's messages after the errand, once it is done.
    pub answer: Option<String>,
    /// The last thing worth telling while it runs; None: nothing.
    pub notice: Option<ErrandNotice>,
}

impl ErrandState {
    pub fn to_json(&self) -> Value {
        json!({
            "done": self.done,
            "answer": self.answer,
            "notice": self.notice.as_ref().map(ErrandNotice::to_json),
        })
    }
}

/// The watch's timing, in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrandTiming {
    pub poll: u64,
    /// The answer is complete once nothing changed for this long.
    pub settled: u64,
    /// Still working, with nothing new this long: worth telling.
    pub working: u64,
    /// Told again, at most this often, while it goes on.
    pub repeat: u64,
    pub limit: u64,
}

impl Default for ErrandTiming {
    fn default() -> Self {
        Self {
            poll: 2000,
            settled: 6000,
            working: 5 * 60_000,
            repeat: 10 * 60_000,
            limit: 15 * 60_000,
        }
    }
}

/// A finished errand is kept this long for the page to collect.
const KEPT_MS: u64 = 10 * 60_000;

fn is_answer(entry: Option<&Value>) -> bool {
    let Some(entry) = entry else {
        return false;
    };
    entry.get("role") == Some(&json!("assistant"))
        && entry.get("kind") == Some(&json!("message"))
        && entry
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| !js::trim(t).is_empty())
}

/// `String(value)` of a field that may be missing (`undefined`).
fn text_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::to_text)
}

struct Job {
    state: ErrandState,
    pane: String,
}

struct Inner {
    deps: Arc<dyn ErrandDeps>,
    causes: Arc<TurnCauses>,
    timing: ErrandTiming,
    clock: Arc<dyn Clock>,
    jobs: Mutex<IndexMap<String, Job>>,
}

#[derive(Clone)]
pub struct VoiceErrands(Arc<Inner>);

impl VoiceErrands {
    pub fn new(
        deps: Arc<dyn ErrandDeps>,
        causes: Arc<TurnCauses>,
        timing: ErrandTiming,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self(Arc::new(Inner {
            deps,
            causes,
            timing,
            clock,
            jobs: Mutex::default(),
        }))
    }

    /// Sends `text` to `pane` (`<connection>/<pane>`); its job's id back.
    /// Its answer is kept as `about` says who answered what.
    pub async fn start(
        &self,
        pane: &str,
        text: &str,
        about: ErrandAbout,
    ) -> Result<String, String> {
        let (connection_id, pane_id) = pane.split_once('/').unwrap_or(("", pane));
        let before = self.0.deps.read(connection_id, pane_id).await?;
        self.0
            .causes
            .note(connection_id, pane_id, TurnCause::Companion);
        self.0.deps.prompt(connection_id, pane_id, text).await?;
        let id = roamgate_base::paths::random_uuid();
        self.0.jobs.lock().unwrap().insert(
            id.clone(),
            Job {
                state: ErrandState::default(),
                pane: pane.to_owned(),
            },
        );
        let non_empty = |value: &Option<String>| {
            value
                .as_deref()
                .map(js::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let kept = KeptAnswer {
            job: id.clone(),
            pane: pane.to_owned(),
            label: non_empty(&about.label).unwrap_or_else(|| pane.to_owned()),
            question: non_empty(&about.question).unwrap_or_else(|| text.to_owned()),
            answer: String::new(),
        };
        let errands = self.clone();
        let (connection_id, pane_id, job) =
            (connection_id.to_owned(), pane_id.to_owned(), id.clone());
        tokio::spawn(async move {
            errands
                .watch(&job, &connection_id, &pane_id, before, kept)
                .await;
            // Over (answered, or given up): the session may idle-stop again.
            errands.update(&job, |state| state.done = true);
            errands.0.clock.sleep(Duration::from_millis(KEPT_MS)).await;
            errands.0.jobs.lock().unwrap().shift_remove(&job);
        });
        Ok(id)
    }

    pub fn state(&self, id: &str) -> Option<ErrandState> {
        self.0
            .jobs
            .lock()
            .unwrap()
            .get(id)
            .map(|job| job.state.clone())
    }

    /// Whether a job still runs on the session (`<connection>/<pane>`).
    pub fn working(&self, pane: &str) -> bool {
        self.first(pane).is_some()
    }

    /// The oldest job still running on `pane`: the one that tells.
    fn first(&self, pane: &str) -> Option<String> {
        self.0
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|(_, job)| !job.state.done && job.pane == pane)
            .map(|(id, _)| id.clone())
    }

    fn update<T>(&self, id: &str, change: impl FnOnce(&mut ErrandState) -> T) -> Option<T> {
        self.0
            .jobs
            .lock()
            .unwrap()
            .get_mut(id)
            .map(|job| change(&mut job.state))
    }

    async fn watch(
        &self,
        id: &str,
        connection_id: &str,
        pane_id: &str,
        before: Vec<Value>,
        mut kept: KeptAnswer,
    ) {
        let inner = &self.0;
        let timing = inner.timing;
        let pane = format!("{connection_id}/{pane_id}");
        let seen: Vec<Value> = before
            .iter()
            .map(|e| e.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        let now = || inner.clock.now();
        let started = now();
        let mut signature = String::new();
        let mut since = now();
        let mut seq = 0;
        // When "still working" is next worth telling, in quiet time.
        let mut tell_working = timing.working as i64;
        while now() - started < timing.limit as i64 {
            inner.clock.sleep(Duration::from_millis(timing.poll)).await;
            let Ok(entries) = inner.deps.read(connection_id, pane_id).await else {
                continue;
            };
            let fresh: Vec<Value> = entries
                .into_iter()
                .filter(|e| !seen.contains(e.get("id").unwrap_or(&Value::Null)))
                .collect();
            let last = fresh.last();
            let current = format!(
                "{} {} {}",
                fresh.len(),
                text_of(last.and_then(|e| e.get("id"))),
                js::len16(&text_of(last.and_then(|e| e.get("text"))))
            );
            if current != signature {
                signature = current;
                since = now();
                tell_working = timing.working as i64;
                // It moved: whatever it waited for was answered.
                self.update(id, |state| {
                    if matches!(state.notice, Some(ErrandNotice::Waiting { .. })) {
                        state.notice = None;
                    }
                });
                continue;
            }
            let quiet = now() - since;
            if is_answer(last) && quiet >= timing.settled as i64 {
                // The whole answer: every message it wrote since, in order.
                let answer = fresh
                    .iter()
                    .filter(|e| is_answer(Some(e)))
                    .filter_map(|e| e.get("text").and_then(Value::as_str))
                    .map(js::trim)
                    .collect::<Vec<_>>()
                    .join("\n\n");
                // Kept before anyone can see the job done.
                kept.answer = answer.clone();
                inner.deps.keep(kept);
                self.update(id, |state| {
                    state.answer = Some(answer);
                    state.done = true;
                });
                return;
            }
            // One job per session tells how it goes; quiet a moment first.
            if quiet < timing.settled as i64 || self.first(&pane).as_deref() != Some(id) {
                continue;
            }
            let status = if inner.deps.has_status() {
                inner
                    .deps
                    .status(connection_id, pane_id)
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            if let Some(status) = status.as_ref().filter(|s| {
                s.waiting.as_deref().is_some_and(|w| !w.is_empty())
                    || s.status.as_deref() == Some("blocked")
            }) {
                let what = status.waiting.clone().filter(|w| !w.is_empty());
                self.update(id, |state| {
                    let same = matches!(&state.notice, Some(ErrandNotice::Waiting { what: told, .. }) if *told == what);
                    if !same {
                        seq += 1;
                        state.notice = Some(ErrandNotice::Waiting { seq, what });
                    }
                });
                continue;
            }
            self.update(id, |state| {
                if matches!(state.notice, Some(ErrandNotice::Waiting { .. })) {
                    state.notice = None;
                }
            });
            // Still at work: its status says so, or messages wait for it;
            // without a status, what it wrote since.
            let working = match &status {
                Some(status) => {
                    matches!(status.status.as_deref(), Some("working" | "starting"))
                        || status.queued > 0
                }
                None => !fresh.is_empty(),
            };
            if working && quiet >= tell_working {
                seq += 1;
                let minutes = (quiet / 60_000) as u64;
                self.update(id, |state| {
                    state.notice = Some(ErrandNotice::Working { seq, minutes })
                });
                tell_working = quiet + timing.repeat as i64;
            }
        }
    }
}

#[cfg(test)]
mod tests;
