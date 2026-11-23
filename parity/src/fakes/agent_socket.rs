//! A scripted agent socket: what the TS suites' fake Roamgate socket did,
//! for the assets the server installs (roamgate-hold, roamgate-review, the
//! Claude mod client) run against answers a real server cannot be made to
//! give (a refusal, an outage, a hanging long poll).
//!
//! `POST /v1/<command>` takes the next of the command's scripted replies
//! (the last one repeats; `*` stands for any command). A reply is a JSON
//! body, or `{"$status": n, "$body": ...}`, or `{"$hang": true}` (no answer,
//! as a long poll that waits). Every request is kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::Response;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

#[derive(Default)]
struct Shared {
    replies: BTreeMap<String, Vec<Value>>,
    used: BTreeMap<String, usize>,
    requests: Vec<Value>,
}

type AppState = Arc<Mutex<Shared>>;

pub struct FakeAgentSocket {
    pub path: PathBuf,
    shared: AppState,
    task: JoinHandle<()>,
}

async fn answer(State(state): State<AppState>, uri: Uri, body: Bytes) -> Response {
    let command = uri.path().trim_start_matches("/v1/").to_owned();
    let parsed: Value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&body).into_owned()));
    let reply = {
        let mut shared = state.lock().expect("agent socket state");
        shared
            .requests
            .push(json!({"command": command, "body": parsed}));
        let key = if shared.replies.contains_key(&command) {
            command.clone()
        } else {
            "*".to_owned()
        };
        let list = shared.replies.get(&key).cloned().unwrap_or_default();
        let index = shared.used.entry(key).or_default();
        let reply = list.get(*index).or_else(|| list.last()).cloned();
        *index += 1;
        reply
    };
    let reply = reply.unwrap_or_else(|| json!({"$status": 404, "$body": {"error": "unscripted"}}));
    if reply.get("$hang").and_then(Value::as_bool) == Some(true) {
        std::future::pending::<()>().await;
    }
    let (status, body) = match reply.get("$status").and_then(Value::as_u64) {
        Some(status) => (
            status as u16,
            reply.get("$body").cloned().unwrap_or(Value::Null),
        ),
        None => (200, reply),
    };
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("response")
}

/// The replies of a scenario's `replies` map: a value or a list of them.
pub fn replies_of(spec: &Value) -> BTreeMap<String, Vec<Value>> {
    spec.as_object()
        .into_iter()
        .flatten()
        .map(|(command, replies)| {
            let list = match replies {
                Value::Array(items) => items.clone(),
                other => vec![other.clone()],
            };
            (command.clone(), list)
        })
        .collect()
}

impl FakeAgentSocket {
    #[cfg(unix)]
    pub async fn start(
        path: &Path,
        replies: BTreeMap<String, Vec<Value>>,
    ) -> Result<FakeAgentSocket> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _ = std::fs::remove_file(path);
        let shared: AppState = Arc::new(Mutex::new(Shared {
            replies,
            ..Shared::default()
        }));
        let listener = tokio::net::UnixListener::bind(path)?;
        let app = Router::new().fallback(answer).with_state(shared.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(FakeAgentSocket {
            path: path.to_path_buf(),
            shared,
            task,
        })
    }

    #[cfg(not(unix))]
    pub async fn start(
        _path: &Path,
        _replies: BTreeMap<String, Vec<Value>>,
    ) -> Result<FakeAgentSocket> {
        anyhow::bail!("the scripted agent socket needs Unix sockets")
    }

    /// Every request so far: `{command, body}`.
    pub fn requests(&self) -> Vec<Value> {
        self.shared
            .lock()
            .expect("agent socket state")
            .requests
            .clone()
    }

    /// Stops answering and removes the socket (Roamgate gone).
    pub fn stop(self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for FakeAgentSocket {
    fn drop(&mut self) {
        self.task.abort();
    }
}
