//! Agents' last activity times (`server/src/agent/agent-activity.ts`): the
//! modification time of each agent's transcript, added to Herdr's
//! `agent.list` answer as `last_activity_at`, without reading transcripts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::files::SessionFiles;
use crate::js;
use crate::resolver::{ResolverContext, resolve_agent_session_info};
use crate::utils::normalize_agent_name;

/// Over SSH, a pane's activity time is reused this long while its agent's
/// state stays: Herdr's agent list is polled every few seconds, and a stat
/// each time for each agent kept the host's session slots busy for an order
/// only idle agents need.
pub const REMOTE_ACTIVITY_REUSE_MS: f64 = 30_000.0;

/// How long the enrichment waits for its stats by default.
pub const ACTIVITY_TIMEOUT: Duration = Duration::from_millis(1500);

/// The activity times a remote connection reuses, by agent state (one per
/// resolver context, as Bun's WeakMap keyed by it).
#[derive(Default)]
pub struct RemoteActivity(Mutex<HashMap<String, (f64, Option<f64>)>>);

impl RemoteActivity {
    fn get(&self, key: &str) -> Option<(f64, Option<f64>)> {
        self.0.lock().unwrap().get(key).copied()
    }

    fn set(&self, key: String, at: f64, time: Option<f64>) {
        let mut known = self.0.lock().unwrap();
        if known.len() > 1000 {
            known.clear();
        }
        known.insert(key, (at, time));
    }
}

fn str_of(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn with_time(agent: &Value, time: f64) -> Value {
    let mut agent = agent.as_object().cloned().unwrap_or_default();
    agent.insert("last_activity_at".into(), js::number(time));
    Value::Object(agent)
}

/// Adds durable activity metadata without parsing or downloading
/// transcripts (`enrichAgentActivity`): at most four stats at a time, the
/// answer as it stands after `timeout` (in-flight stats are dropped, no more
/// are started).
pub async fn enrich_agent_activity(
    result: Value,
    files: &dyn SessionFiles,
    context: &ResolverContext,
    remote_activity: &RemoteActivity,
    timeout: Duration,
    now: &(dyn Fn() -> f64 + Send + Sync),
) -> Value {
    let Some(source) = result.get("agents").and_then(Value::as_array).cloned() else {
        return result;
    };
    let agents = Arc::new(Mutex::new(source.clone()));
    let next = AtomicUsize::new(0);
    let expired = AtomicBool::new(false);
    let worker = || async {
        while !expired.load(Ordering::SeqCst) {
            let index = next.fetch_add(1, Ordering::SeqCst);
            if index >= source.len() {
                break;
            }
            let agent = &source[index];
            let Some(pane_id) = agent.get("pane_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(session) = agent.get("agent_session").filter(|s| s.is_object()) else {
                continue;
            };
            // String(agent.agent ?? session.agent)
            let raw_name = match agent.get("agent").filter(|value| !value.is_null()) {
                Some(value) => js::to_text(value),
                None => match session.get("agent") {
                    None => "undefined".to_owned(),
                    Some(value) => js::to_text(value),
                },
            };
            let name = normalize_agent_name(&raw_name);
            let kind = str_of(session.get("kind"));
            // ID-based resolvers (except Pi and Codex) search local
            // directories: never this host's sessions as a remote
            // connection's activity.
            if files.remote()
                && (name == "grok"
                    || name == "agy"
                    || (kind != "path" && name != "pi" && name != "codex"))
            {
                continue;
            }
            let key = files.remote().then(|| {
                js::stringify(&json!([
                    agent.get("pane_id"),
                    session.get("kind"),
                    session.get("value"),
                    agent.get("agent_status"),
                    agent.get("state_change_seq"),
                ]))
            });
            if let Some(key) = &key
                && let Some((at, time)) = remote_activity.get(key)
                && now() - at < REMOTE_ACTIVITY_REUSE_MS
            {
                if let Some(time) = time {
                    agents.lock().unwrap()[index] = with_time(agent, time);
                }
                continue;
            }
            let params = json!({ "pane_id": pane_id });
            if let Ok(resolved) =
                resolve_agent_session_info(&params, agent.as_object(), files, context).await
            {
                let time = resolved.file.map(|file| file.mtime_ms);
                let usable = time.filter(|time| time.is_finite() && *time > 0.0);
                if let Some(time) = usable {
                    agents.lock().unwrap()[index] = with_time(agent, time);
                }
                if let Some(key) = key {
                    remote_activity.set(key, now(), usable);
                }
            }
            // Missing, unsupported or unreadable sessions must not hide
            // agents.
        }
    };
    let workers = (0..source.len().min(4)).map(|_| worker());
    let all = futures_util::future::join_all(workers);
    if tokio::time::timeout(timeout, all).await.is_err() {
        expired.store(true, Ordering::SeqCst);
    }
    // A detached snapshot: optional metadata never blocks navigation.
    let agents = agents.lock().unwrap().clone();
    let mut result = result.as_object().cloned().unwrap_or_default();
    result.insert("agents".into(), Value::Array(agents));
    Value::Object(result)
}

#[cfg(test)]
mod tests;
