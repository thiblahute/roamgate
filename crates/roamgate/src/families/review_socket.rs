//! The review family's agent socket in the core: roamgate-review's
//! [`AgentSocket`], served while the core owns the family. What the socket
//! asks of families Bun still owns (the connections' checkouts, the
//! boards, notifications, the agent messenger, conversation mode's holder,
//! prepared launches, and the Claude mod's hub while Bun runs it:
//! families/claude_mod.rs) is the `review.socket` reverse call; the
//! `claude_mod.*` calls of the Integrations page run roamgate-claude's
//! install on the connection's host (`host.run`).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use roamgate_base::env::{Env, ProcessEnv};
use roamgate_claude::plugin::{ClaudeModAction, claude_mod_host_script, claude_mod_integration};
use roamgate_review::agent_socket::{
    AgentConnection, AgentExchange, AgentSocket, AgentSocketHost, AgentSocketOptions, ClaudeMods,
    Form, HostAsk, HostError, HostFeatures, LOCAL_SOCKET_KEY,
};
use roamgate_review::error::{ReviewError, ReviewResult};
use roamgate_review::service::{BoxFut, ReviewService};
use roamgate_review::storage::review_directory;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// A reverse call's error as the socket answers it: Bun says the status
/// in `data`.
fn host_error(error: RpcError) -> HostError {
    HostError {
        status: error
            .data
            .as_ref()
            .and_then(|data| data.get("status"))
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok()),
        code: error.code,
        message: error.message,
    }
}

/// What the socket asks of Bun.
pub struct ReverseSocketHost {
    pub cx: FamilyContext,
}

impl ReverseSocketHost {
    fn ask<T: DeserializeOwned + Send + 'static>(
        &self,
        op: &'static str,
        args: Value,
    ) -> HostAsk<T> {
        let cx = self.cx.clone();
        Box::pin(async move {
            let answer = cx
                .reverse("review.socket", json!({"op": op, "input": args}))
                .await
                .map_err(host_error)?;
            serde_json::from_value(answer)
                .map_err(|error| HostError::status(format!("unexpected answer: {error}"), 500))
        })
    }
}

impl AgentSocketHost for ReverseSocketHost {
    fn features(&self) -> HostFeatures {
        HostFeatures {
            notify: true,
            workspaces: true,
            reviews: true,
            work: true,
            messages: true,
            claude_start: true,
            holder: true,
        }
    }

    fn connections(&self) -> HostAsk<Vec<AgentConnection>> {
        let asked: HostAsk<Vec<Value>> = self.ask("connections", json!({}));
        Box::pin(async move {
            Ok(asked
                .await?
                .into_iter()
                .map(|each| {
                    let text = |key: &str| each.get(key).and_then(Value::as_str).map(str::to_owned);
                    AgentConnection {
                        id: text("id").unwrap_or_default(),
                        herdr_socket_path: text("herdrSocketPath"),
                        ssh_host: text("sshHost"),
                        last_steps: each.get("lastSteps") == Some(&Value::Bool(true)),
                    }
                })
                .collect())
        })
    }

    fn read_root(&self, connection_id: &str, path: &str) -> HostAsk<String> {
        self.ask(
            "readRoot",
            json!({"connectionId": connection_id, "path": path}),
        )
    }

    fn read_default_base(&self, connection_id: &str, root: &str) -> HostAsk<String> {
        self.ask(
            "readDefaultBase",
            json!({"connectionId": connection_id, "root": root}),
        )
    }

    fn read_last_step(
        &self,
        connection_id: &str,
        root: &str,
        workspace_id: &str,
    ) -> HostAsk<Option<Value>> {
        self.ask(
            "readLastStep",
            json!({"connectionId": connection_id, "root": root, "workspaceId": workspace_id}),
        )
    }

    fn has_viewers(&self) -> HostAsk<Option<bool>> {
        self.ask("hasViewers", json!({}))
    }

    fn notify(&self, input: Value) -> HostAsk<()> {
        let asked: HostAsk<Value> = self.ask("notify", input);
        Box::pin(async move { asked.await.map(|_| ()) })
    }

    fn workspaces(&self, input: Value) -> HostAsk<Value> {
        self.ask("workspaces", input)
    }

    fn reviews(&self, input: Value) -> HostAsk<String> {
        self.ask("reviews", input)
    }

    fn work(&self, input: Value) -> HostAsk<String> {
        self.ask("work", input)
    }

    fn messages_list(&self) -> HostAsk<Vec<Value>> {
        self.ask("messagesList", json!({}))
    }

    fn messages_send(&self, input: Value) -> HostAsk<Value> {
        self.ask("messagesSend", input)
    }

    fn claude_start(&self, input: Value) -> HostAsk<Value> {
        self.ask("claudeStart", input)
    }

    fn launch(&self, input: Value) -> HostAsk<Option<Value>> {
        self.ask("launch", input)
    }

    fn holder_hold(&self, input: Value) -> HostAsk<Value> {
        self.ask("hold", input)
    }

    fn holder_output(&self, input: Value) -> HostAsk<Value> {
        self.ask("holdOutput", input)
    }

    fn holder_handback(&self, input: Value) -> HostAsk<Value> {
        self.ask("handback", input)
    }

    fn holder_fg(&self, input: Value) -> HostAsk<Value> {
        self.ask("fg", input)
    }
}

/// The Claude mod's requests, answered by Bun's hub while it runs there
/// (the core runs it only while it owns review and conversation:
/// families/claude_mod.rs).
pub struct ReverseMods {
    pub cx: FamilyContext,
}

impl ClaudeMods for ReverseMods {
    fn request(
        &self,
        connection_id: String,
        command: String,
        form: Form,
    ) -> BoxFut<ReviewResult<Value>> {
        let cx = self.cx.clone();
        Box::pin(async move {
            cx.reverse(
                "review.socket",
                json!({"op": "mod", "input": {
                    "connectionId": connection_id,
                    "command": command,
                    "form": form.to_value(),
                }}),
            )
            .await
            .map_err(|error| {
                let error = host_error(error);
                ReviewError::status(error.message, error.status.unwrap_or(500))
            })
        })
    }
}

/// The socket while the core owns the family, and the keys it should
/// listen on (`@local`, and each SSH connection Bun forwards to it).
#[derive(Default)]
pub struct Sockets {
    pub socket: Option<AgentSocket>,
    pub wanted: BTreeSet<String>,
    pub listening: BTreeSet<String>,
}

impl Sockets {
    /// Starts the socket on the service just opened.
    pub fn start(&mut self, cx: &FamilyContext, service: ReviewService) {
        self.stop();
        let home = ProcessEnv.var("HOME").unwrap_or_default();
        self.socket = Some(AgentSocket::new(AgentSocketOptions {
            service,
            directory: review_directory(&ProcessEnv),
            home: home.into(),
            host: Arc::new(ReverseSocketHost { cx: cx.clone() }),
            claude_mod: Some(Arc::new(super::claude_mod::SwitchMods {
                reverse: ReverseMods { cx: cx.clone() },
            })),
            // The parity suite's proof that the core served the socket.
            on_exchange: Some(Arc::new(|exchange: &AgentExchange| {
                roamgate_sidecar::core::note_served(
                    &ProcessEnv,
                    "review",
                    &format!("agent {}", exchange.command),
                );
            })),
        }));
        // Beside Bun's, then moved over its paths in one step: a client
        // reaches Bun's listener or this one, never neither.
        self.sync_at(true);
        self.commit();
    }

    /// Moves the staged sockets over the paths Bun's listen on.
    fn commit(&mut self) {
        let Some(socket) = &self.socket else {
            return;
        };
        for key in &self.listening {
            if let Err(error) = socket.commit(key) {
                tracing::warn!(scope = "review", key = %key, error = %error, "agent socket not taken over");
            }
        }
    }

    /// Listens on the keys wanted, stops the others.
    pub fn sync(&mut self) {
        self.sync_at(false);
    }

    fn sync_at(&mut self, staged: bool) {
        let Some(socket) = &self.socket else {
            return;
        };
        for key in self
            .listening
            .difference(&self.wanted)
            .cloned()
            .collect::<Vec<_>>()
        {
            socket.stop(Some(&key));
            self.listening.remove(&key);
        }
        for key in self
            .wanted
            .difference(&self.listening)
            .cloned()
            .collect::<Vec<_>>()
        {
            let listened = match (key == LOCAL_SOCKET_KEY, staged) {
                (true, false) => socket.install_local(),
                (true, true) => socket.install_local_staged(),
                (false, false) => socket.listen(&key).map(|_| ()),
                (false, true) => socket.listen_staged(&key).map(|_| ()),
            };
            match listened {
                Ok(()) => {
                    tracing::info!(scope = "review", key = %key, "agent socket listening");
                    self.listening.insert(key);
                }
                Err(error) => {
                    tracing::warn!(scope = "review", key = %key, error = %error, "review agent socket unavailable");
                }
            }
        }
    }

    /// Every listener closed, the well-known link removed when it is ours.
    pub fn stop(&mut self) {
        if let Some(socket) = self.socket.take() {
            socket.stop(None);
        }
        self.listening.clear();
    }
}

pub type SharedSockets = Arc<Mutex<Sockets>>;

/// `claude_mod.status|install|uninstall` on a connection's host.
pub async fn claude_mod_call(
    cx: &FamilyContext,
    connection_id: &str,
    action: &str,
) -> Result<Value, RpcError> {
    let action = ClaudeModAction::parse(action)
        .ok_or_else(|| RpcError::with_code("unknown action", "unknown_method"))?;
    let ready = cx.reverse("connections.ready", json!({})).await?;
    let connection = ready
        .as_array()
        .into_iter()
        .flatten()
        .find(|each| each.get("id").and_then(Value::as_str) == Some(connection_id))
        .cloned()
        .ok_or_else(|| RpcError::new("this connection is not ready"))?;
    let sessions = match super::claude_mod::current() {
        Some(hub) => hub.panes(connection_id).len() as i64,
        None => cx
            .reverse("claude_mod.panes", json!({"connection_id": connection_id}))
            .await?
            .as_array()
            .map_or(0, |panes| panes.len() as i64),
    };
    let remote = connection.get("remote_platform").and_then(Value::as_str);
    let unix = match remote {
        Some(platform) => platform != "windows",
        None => !cfg!(windows),
    };
    let connection_id = connection_id.to_owned();
    Ok(claude_mod_integration(action, unix, sessions, |which| {
        let cx = cx.clone();
        let connection_id = connection_id.clone();
        async move {
            let script = claude_mod_host_script(which);
            match cx
                .reverse(
                    "host.run",
                    json!({
                        "connection_id": connection_id,
                        "argv": ["/bin/sh", "-lc", script],
                        "timeout_ms": 120_000,
                    }),
                )
                .await
            {
                Ok(result) => {
                    let text = |key: &str| {
                        result
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned()
                    };
                    let code = result.get("code").and_then(Value::as_i64);
                    let failed = if code == Some(0) {
                        String::new()
                    } else {
                        format!("ROAMGATE_SCRIPT_FAILED {}", text("stderr"))
                    };
                    format!("{}\n{failed}", text("stdout"))
                }
                Err(error) => format!("\nROAMGATE_SCRIPT_FAILED {}", error.message),
            }
        }
    })
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_error_keeps_bun_s_status_and_code() {
        let mut error = RpcError::with_code("no such review", "not_found");
        error.data = Some(json!({"status": 404}));
        assert_eq!(
            host_error(error),
            HostError {
                message: "no such review".into(),
                status: Some(404),
                code: Some("not_found".into()),
            }
        );
        assert_eq!(host_error(RpcError::new("x")).status, None);
    }
}
