//! A [`ReviewsAgentDriver`] whose Claude Code turns run in another
//! process (the core's: Bun's driver, through its reverse calls): the
//! turn is asked with its model, session, text, system prompt and tools;
//! the tools' calls come back here ([`RemoteDriver::tool`]) and so does
//! what the turn reports, in order ([`RemoteDriver::event`]).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use roamgate_assistant::driver::RunEvent;
use roamgate_assistant::errors::AssistantError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentTurn, ReviewsAgentDriver};
use crate::agent_tools::ReviewsAgentTools;
use crate::connection::BoxFuture;

/// A call to the process that runs the turns: `turn {turn_id, model,
/// resume, text, system_prompt, tools}` (answered when the turn ends) or
/// `stop {}`.
pub type RemoteCall =
    Arc<dyn Fn(&'static str, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

/// The turns run elsewhere, by id.
#[derive(Clone)]
pub struct RemoteDriver {
    call: RemoteCall,
    turns: Arc<Mutex<HashMap<String, AgentTurn>>>,
    next: Arc<AtomicU64>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn text(event: &Value, name: &str) -> String {
    event
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

impl RemoteDriver {
    pub fn new(call: RemoteCall) -> RemoteDriver {
        RemoteDriver {
            call,
            turns: Arc::default(),
            next: Arc::default(),
        }
    }

    fn turn(&self, id: &str) -> Option<AgentTurn> {
        lock(&self.turns).get(id).cloned()
    }

    /// What a turn reported (`{turn_id, kind, ...}`): `delta {text}`,
    /// `message {text}`, `thinking {steps}`, `tool {id, name, status,
    /// details?}`, `error`, `checkpoint {entries}`.
    pub fn event(&self, event: &Value) {
        let Some(turn) = self.turn(&text(event, "turn_id")) else {
            return;
        };
        let run = match event.get("kind").and_then(Value::as_str) {
            Some("delta") => RunEvent::Delta(text(event, "text")),
            Some("message") => RunEvent::Message(text(event, "text")),
            Some("thinking") => RunEvent::Thinking(strings(event.get("steps"))),
            Some("tool") => RunEvent::Tool {
                id: text(event, "id"),
                name: text(event, "name"),
                status: text(event, "status"),
                details: event.get("details").cloned(),
            },
            Some("error") => RunEvent::Error,
            Some("checkpoint") => {
                let entries = event
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                (turn.checkpoint)(entries);
                return;
            }
            _ => return,
        };
        (turn.events)(run);
    }

    /// A tool's call of a turn: `{text}`, or `{error: {user, message}}`
    /// (`user`: a refusal the model may read as it is).
    pub async fn tool(&self, turn_id: &str, name: &str, params: &Value) -> Value {
        let Some(turn) = self.turn(turn_id) else {
            return json!({"error": {"user": false, "message": "this turn is over"}});
        };
        match turn.tools.call(name, params, None).await {
            Ok(text) => json!({"text": text}),
            Err(AssistantError::User(message)) => {
                json!({"error": {"user": true, "message": message}})
            }
            Err(error) => json!({"error": {"user": false, "message": error.message()}}),
        }
    }
}

impl ReviewsAgentDriver for RemoteDriver {
    fn run(
        &self,
        turn: AgentTurn,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<(), String>> {
        let this = self.clone();
        Box::pin(async move {
            let id = format!("t{}", this.next.fetch_add(1, Ordering::SeqCst) + 1);
            let tools: Vec<Value> = ReviewsAgentTools::tools()
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                        "replay": tool.replay,
                        "sequential": tool.sequential.unwrap_or(false),
                    })
                })
                .collect();
            let args = json!({
                "turn_id": id,
                "model": turn.model,
                "resume": turn.resume,
                "text": turn.text,
                "system_prompt": turn.system_prompt,
                "tools": tools,
            });
            lock(&this.turns).insert(id.clone(), turn);
            let asked = (this.call)("turn", args);
            let outcome = tokio::select! {
                outcome = asked => outcome.map(|_| ()),
                () = cancel.cancelled() => {
                    let _ = (this.call)("stop", json!({})).await;
                    Err("stopped".to_owned())
                }
            };
            lock(&this.turns).remove(&id);
            outcome
        })
    }

    fn stop(&self) -> BoxFuture<'static, ()> {
        let call = self.call.clone();
        Box::pin(async move {
            let _ = call("stop", json!({})).await;
        })
    }

    fn dispose(&self) -> BoxFuture<'static, ()> {
        self.stop()
    }
}
