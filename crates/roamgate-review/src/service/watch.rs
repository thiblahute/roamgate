//! An agent waiting for work in a review and its workspace's others
//! (`watch`, review/service.ts).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Notify;

use super::{ReviewService, State, field};
use crate::error::{ReviewError, ReviewResult};
use crate::model::{REVIEW_USER, ReviewSession, ReviewThread};
use crate::parse::author;

const MAX_WATCH_MS: f64 = 3_600_000.0;

/// What a watch ends with.
#[derive(Debug, Clone, Serialize)]
pub struct ReviewWatchResult {
    /// `unanswered`, `handoff`, `changed`, `timeout` or `gone`.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<ReviewSession>,
    pub threads: Vec<ReviewThread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl ReviewService {
    /// The reviews of one workspace, one per repository (groupOf).
    fn group_of(&self, state: &State, target: &ReviewSession) -> Vec<String> {
        let Some(workspace) = &target.workspace_id else {
            return vec![target.id.clone()];
        };
        let mut group = vec![target.id.clone()];
        for other in state.sessions.values() {
            if other.id != target.id
                && other.connection_id == target.connection_id
                && other.workspace_id.as_ref() == Some(workspace)
                && self.0.agent_refusal(state, other).is_none()
            {
                group.push(other.id.clone());
            }
        }
        group
    }

    fn unanswered(state: &State, session_id: &str, agent: &str) -> Vec<ReviewThread> {
        let target = state.sessions.get(session_id);
        state
            .thread_list(session_id)
            .into_iter()
            .filter(|thread| match target {
                Some(target) => Self::needs_answer(thread, target, agent),
                None => crate::model::thread_needs_answer(thread, agent, false),
            })
            .collect()
    }

    fn pending_in(
        state: &State,
        group: &[String],
        agent: &str,
        handed_off: bool,
    ) -> Vec<ReviewThread> {
        group
            .iter()
            .flat_map(|id| match state.sessions.get(id) {
                Some(member) if handed_off || !member.holds_comments() => {
                    Self::unanswered(state, id, agent)
                }
                _ => Vec::new(),
            })
            .collect()
    }

    /// What a watch hands the agent counts as delivered.
    fn received(&self, state: &mut State, result: ReviewWatchResult) -> ReviewWatchResult {
        let inner = &self.0;
        let mut ids: Vec<String> = Vec::new();
        for thread in &result.threads {
            if !ids.contains(&thread.session_id) {
                ids.push(thread.session_id.clone());
            }
        }
        for id in ids {
            let at = inner.now();
            let Some(current) = state.sessions.get_mut(&id) else {
                continue;
            };
            current.delivered_at = Some(at);
            let failed = current.delivery_error.take().is_some();
            let current = current.clone();
            inner.save_session(&current);
            if failed {
                inner.publish_session(state, &current);
            }
            state.deliveries.remove(&id);
        }
        result
    }

    /// Waits for work (`watch`); `cancel` resolves when the agent went.
    pub async fn watch(
        &self,
        params: &Value,
        cancel: Option<std::pin::Pin<Box<dyn Future<Output = ()> + Send>>>,
    ) -> ReviewResult<ReviewWatchResult> {
        let inner = &self.0;
        let (target, agent, mode, timeout_ms, group, notify, watcher) = {
            let mut state = inner.lock();
            let target = state.session(field(params, "sessionId"))?;
            let agent = author(field(params, "agent"))?;
            if agent == REVIEW_USER {
                return Err(ReviewError::new("watch needs the agent name"));
            }
            inner.assert_agent_allowed(&state, &target, &agent)?;
            let mode = if field(params, "mode").and_then(Value::as_str) == Some("any") {
                "any"
            } else {
                "unanswered"
            };
            let requested = match field(params, "timeoutMs") {
                None | Some(Value::Null) => Some(1_800_000.0),
                Some(Value::Number(n)) => n.as_f64(),
                Some(Value::String(s)) => s.trim().parse::<f64>().ok().or(if s.trim().is_empty() {
                    Some(0.0)
                } else {
                    None
                }),
                Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
                _ => None,
            };
            let timeout_ms = match requested.filter(|r| r.is_finite()) {
                Some(requested) => requested.clamp(0.0, MAX_WATCH_MS),
                None => 1_800_000.0,
            };
            let group = self.group_of(&state, &target);
            if mode == "unanswered" {
                let pending = Self::pending_in(&state, &group, &agent, false);
                if !pending.is_empty() {
                    return Ok(self.received(
                        &mut state,
                        ReviewWatchResult {
                            outcome: "unanswered",
                            session: Some(target.clone()),
                            threads: pending,
                            summary: None,
                        },
                    ));
                }
            }
            let notify = Arc::new(Notify::new());
            let watcher = state.next();
            for id in &group {
                state
                    .watchers
                    .entry(id.clone())
                    .or_default()
                    .push((watcher, notify.clone()));
            }
            (target, agent, mode, timeout_ms, group, notify, watcher)
        };
        let (handoffs, versions): (HashMap<String, u64>, HashMap<String, u64>) = {
            let state = inner.lock();
            (
                group
                    .iter()
                    .map(|id| (id.clone(), state.handoffs.get(id).copied().unwrap_or(0)))
                    .collect(),
                group
                    .iter()
                    .map(|id| (id.clone(), state.versions.get(id).copied().unwrap_or(0)))
                    .collect(),
            )
        };
        let check = |state: &mut State| -> Option<ReviewWatchResult> {
            let Some(current) = state.sessions.get(&target.id).cloned() else {
                return Some(ReviewWatchResult {
                    outcome: "gone",
                    session: None,
                    threads: Vec::new(),
                    summary: None,
                });
            };
            let handed = group.iter().find(|id| {
                state.sessions.contains_key(*id)
                    && state.handoffs.get(*id).copied().unwrap_or(0) != handoffs[*id]
            });
            if let Some(handed) = handed.cloned() {
                let mut member = state.sessions[&handed].clone();
                let summary = Self::unsent_summary_pub(&member);
                if let Some(summary) = &summary {
                    member.summary_sent = Some(summary.clone());
                    state.sessions.get_mut(&handed).unwrap().summary_sent = Some(summary.clone());
                    self.0.save_session(&member);
                }
                return Some(ReviewWatchResult {
                    outcome: "handoff",
                    session: Some(member),
                    threads: Self::pending_in(state, &group, &agent, true),
                    summary,
                });
            }
            if mode == "unanswered" {
                let pending = Self::pending_in(state, &group, &agent, false);
                if !pending.is_empty() {
                    return Some(ReviewWatchResult {
                        outcome: "unanswered",
                        session: Some(current),
                        threads: pending,
                        summary: None,
                    });
                }
            } else {
                let moved = group.iter().find(|id| {
                    state.sessions.contains_key(*id)
                        && state.versions.get(*id).copied().unwrap_or(0) != versions[*id]
                });
                if let Some(moved) = moved {
                    return Some(ReviewWatchResult {
                        outcome: "changed",
                        session: state.sessions.get(moved).cloned(),
                        threads: state.thread_list(moved),
                        summary: None,
                    });
                }
            }
            None
        };
        let sleep = inner.clock.sleep(Duration::from_millis(timeout_ms as u64));
        tokio::pin!(sleep);
        let cancel = async move {
            match cancel {
                Some(cancel) => cancel.await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(cancel);
        let finish = |result: ReviewWatchResult| {
            let mut state = inner.lock();
            for id in &group {
                if let Some(list) = state.watchers.get_mut(id) {
                    list.retain(|(each, _)| *each != watcher);
                    if list.is_empty() {
                        state.watchers.remove(id);
                    }
                }
            }
            self.received(&mut state, result)
        };
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            tokio::select! {
                () = &mut notified => {
                    let found = check(&mut inner.lock());
                    if let Some(result) = found {
                        return Ok(finish(result));
                    }
                }
                () = &mut sleep => {
                    return Ok(finish(ReviewWatchResult {
                        outcome: "timeout",
                        session: Some(target.clone()),
                        threads: Vec::new(),
                        summary: None,
                    }));
                }
                () = &mut cancel => {
                    return Ok(finish(ReviewWatchResult {
                        outcome: "timeout",
                        session: Some(target.clone()),
                        threads: Vec::new(),
                        summary: None,
                    }));
                }
            }
        }
    }

    pub(crate) fn unsent_summary_pub(target: &ReviewSession) -> Option<String> {
        let text = crate::js::trim(&target.summary);
        let sent = target.summary_sent.as_deref().map(crate::js::trim);
        (!text.is_empty() && Some(text) != sent).then(|| text.to_owned())
    }
}
