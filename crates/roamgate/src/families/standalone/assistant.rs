//! What the core's Ranger reads of the runtimes (index.ts
//! `assistantHost`, `assistantConnections`, `assistantChatThreadReply`):
//! the connection table, each runtime's Herdr, Changes, worktrees and
//! transcripts, conversation mode, the settings, the turn causes. A
//! dispatch gate is the core's own closure: evaluated here, by its token,
//! right before what it guards goes.

use std::sync::{Arc, Mutex};

use roamgate_channel::family::FamilyContext;
use roamgate_channel::protocol::{Ctx, RpcError};
use roamgate_connections::profiles::connection_recovery_fingerprint;
use serde_json::{Value, json};

use super::{Layer, Lease, Target, call, text};

/// shared/rangerChat.ts.
const RANGER_CHAT_PREFIX: &str = "ranger:";
const RANGER_THREAD_AUTHOR: &str = "Ranger";

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("assistant.connections", |layer, _, _| {
        Box::pin(async move { Ok(connections(&layer)) })
    }),
    ("assistant.host", |layer, cx, args| {
        Box::pin(async move { host(&layer, &cx, &args).await })
    }),
    ("assistant.chat_thread_reply", |_, cx, args| {
        Box::pin(async move { chat_thread_reply(&cx, &args).await })
    }),
];

/// The connections as Ranger reads them: each one's ready generation
/// (null while not ready) and state.
pub(super) fn connections(layer: &Layer) -> Value {
    let Some(manager) = layer.host.manager_now() else {
        return json!([]);
    };
    Value::Array(
        manager
            .list()
            .into_iter()
            .map(|status| {
                let generation = manager
                    .ready_runtime_lease(&status.id)
                    .ok()
                    .flatten()
                    .map(|lease| lease.generation);
                let mut state = json!({
                    "label": status.label,
                    "state": status.state,
                });
                if let Some(error) = &status.error {
                    state["error"] = json!(error.message);
                }
                json!({"id": status.id, "generation": generation, "status": state})
            })
            .collect(),
    )
}

/// Ranger answers a comment on its chat's messages in its thread.
async fn chat_thread_reply(cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let params = &args["params"];
    let (Some(session), Some(comment), Some(reply)) = (
        text(args, "session_id"),
        text(params, "comment_id"),
        text(params, "text"),
    ) else {
        return Err(RpcError::new(
            "assistant.chat_thread_reply needs a session and a reply",
        ));
    };
    let thread = call(
        cx,
        "internal.review.call",
        json!({"method": "replyInChat", "params": {
            "chat": format!("{RANGER_CHAT_PREFIX}{session}"),
            "commentId": comment,
            "text": reply,
            "author": RANGER_THREAD_AUTHOR,
        }}),
    )
    .await?;
    let id: String = thread["id"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(8)
        .collect();
    Ok(json!({"text": format!("Answered in thread [{id}].")}))
}

/// The runtime a lease of Ranger's names, while it is current (index.ts
/// `assistantLeased`).
fn leased(layer: &Layer, args: &Value) -> Result<Lease, RpcError> {
    let lease = &args["lease"];
    let id = text(lease, "connection_id")
        .ok_or_else(|| RpcError::new("assistant.host needs a lease"))?;
    let held = layer.ready(id)?;
    match held {
        Some(held) if Some(held.generation) == lease["generation"].as_u64() => Ok(held),
        _ => Err(RpcError::new(
            "Connection changed during Ranger read; start a new turn",
        )),
    }
}

type Gate = Arc<dyn Fn() -> Result<(), RpcError> + Send + Sync>;

/// The gate a call carries (index.ts `assistantGate`), while the call
/// runs: the core's own, unless it was told revoked (`gate_revoke`).
struct GateHold {
    layer: Arc<Layer>,
    token: u64,
    gate: Gate,
}

impl Drop for GateHold {
    fn drop(&mut self) {
        self.layer.revoked.lock().unwrap().remove(&self.token);
    }
}

fn gate(layer: &Arc<Layer>, args: &Value) -> Option<GateHold> {
    let token = args.get("gate").and_then(Value::as_u64)?;
    layer.revoked.lock().unwrap().entry(token).or_insert(None);
    let held = layer.clone();
    Some(GateHold {
        layer: layer.clone(),
        token,
        gate: Arc::new(move || {
            if let Some(Some(revoked)) = held.revoked.lock().unwrap().get(&token) {
                return Err(revoked.clone());
            }
            super::super::assistant::gate_check(token)
        }),
    })
}

/// The workspace part of a leased runtime, the core's (its generation).
fn workspace(lease: &Lease) -> Result<super::super::workspace::RangerRuntime, RpcError> {
    super::super::workspace::ranger_runtime(&lease.connection_id)
        .filter(|runtime| runtime.generation() == lease.generation)
        .ok_or_else(|| RpcError::new(format!("connection not ready: {}", lease.connection_id)))
}

/// A Unix-only read refused on a Windows host keeps its kind.
fn platform_error(lease: &Lease, error: RpcError) -> RpcError {
    if lease.runtime.remote_platform().is_some() && error.code.is_none() {
        return RpcError::with_code(error.message, "unsupported_platform");
    }
    error
}

/// `assistant.host {op, ...}`.
async fn host(layer: &Arc<Layer>, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let query = args.get("query").cloned().unwrap_or_else(|| json!({}));
    let op = text(args, "op").unwrap_or("");
    match op {
        "catalog" => Ok(Value::Array(
            layer
                .host
                .profiles_once_started()
                .await
                .into_iter()
                .map(|item| json!({"id": item["id"], "label": item["label"]}))
                .collect(),
        )),
        "lease" => {
            let id = text(args, "connection_id").unwrap_or("");
            Ok(match layer.ready(id)? {
                Some(held) => json!({
                    "connection_id": id,
                    "generation": held.generation,
                    "remote_platform": held.runtime.remote_platform().map(|_| "windows"),
                    "ssh_host": held.runtime.ssh_host(),
                }),
                None => Value::Null,
            })
        }
        "recovery_fingerprint" => {
            let id = text(args, "connection_id").unwrap_or("");
            let profile = layer
                .host
                .profile(id)
                .ok_or_else(|| RpcError::new("Ranger connection is no longer configured"))?;
            Ok(json!(connection_recovery_fingerprint(&profile)))
        }
        "limit_pauses" => {
            let id = text(args, "connection_id").unwrap_or("");
            let standalone = &cx.standalone;
            let ctx = Ctx {
                connection_id: Some(id.to_owned()),
                ..Ctx::default()
            };
            let listed = standalone
                .call("limit_resume.list", json!({}), ctx)
                .await
                .unwrap_or(Value::Null);
            Ok(listed.get("pauses").cloned().unwrap_or_else(|| json!([])))
        }
        "create_worktree" => {
            let held = leased(layer, args)?;
            let runtime = workspace(&held)?;
            let hold = gate(layer, args);
            let gate = hold.as_ref().map(|hold| hold.gate.clone());
            // The gate's refusal keeps its kind (a message Ranger shows).
            let refused: Arc<Mutex<Option<RpcError>>> = Arc::default();
            let before = {
                let refused = refused.clone();
                Arc::new(move || match gate.as_ref().map(|gate| gate()) {
                    Some(Err(error)) => {
                        let message = error.message.clone();
                        *refused.lock().unwrap() = Some(error);
                        Err(message)
                    }
                    _ => Ok(()),
                }) as Arc<dyn Fn() -> Result<(), String> + Send + Sync>
            };
            let lease = held.clone();
            let created = runtime
                .create_worktree(
                    &args["params"],
                    Arc::new(move || lease.is_current()),
                    before,
                )
                .await;
            match created {
                Ok(created) => Ok(created),
                Err(error) => {
                    if let Some(refusal) = refused.lock().unwrap().take()
                        && refusal.message == error.message
                    {
                        return Err(refusal);
                    }
                    Err(match error.code {
                        Some(code) => RpcError::with_code(error.message, &code),
                        None => RpcError::new(error.message),
                    })
                }
            }
        }
        "agent_prompted" => {
            let input = &args["input"];
            super::tell(
                cx,
                "internal.agent_sessions.quiet_turn",
                json!({
                    "connection_id": input["connectionId"],
                    "pane_id": input["paneId"],
                    "terminal_id": input["terminalId"],
                    "seq": input["seq"],
                    "status": input["status"],
                }),
            );
            Ok(Value::Null)
        }
        "workspace_created" => {
            let input = &args["input"];
            let id = text(input, "connectionId").unwrap_or("");
            if let Ok(Some(_)) = layer.ready(id)
                && let Some(runtime) = super::super::workspace::ranger_runtime(id)
            {
                runtime
                    .place_created(
                        json!({"workspace_id": input["workspaceId"]}),
                        text(input, "sourceWorkspaceId").map(str::to_owned),
                    )
                    .await
                    .map_err(RpcError::new)?;
            }
            Ok(Value::Null)
        }
        "herdr_call" => {
            let held = leased(layer, args)?;
            let hold = gate(layer, args);
            let refused: Arc<Mutex<Option<RpcError>>> = Arc::default();
            let before = hold.as_ref().map(|hold| {
                let gate = hold.gate.clone();
                let refused = refused.clone();
                Box::new(move || {
                    gate().map_err(|error| {
                        let message = error.message.clone();
                        *refused.lock().unwrap() = Some(error);
                        message
                    })
                }) as roamgate_herdr::control::BeforeSend
            });
            let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
            held.runtime
                .herdr()
                .call(
                    text(args, "method").unwrap_or(""),
                    params,
                    args.get("timeout_ms")
                        .and_then(Value::as_u64)
                        .unwrap_or(roamgate_herdr::control::DEFAULT_CALL_TIMEOUT_MS),
                    before,
                    false,
                )
                .await
                .map_err(|message| match refused.lock().unwrap().take() {
                    Some(refusal) if refusal.message == message => refusal,
                    _ => RpcError::new(message),
                })
        }
        "read_git_diff_file" | "read_git_diff_summary" => {
            let held = leased(layer, args)?;
            let method = if op == "read_git_diff_file" {
                "git.diff_file"
            } else {
                "git.diff_summary"
            };
            workspace(&held)?
                .git_read(method, &query)
                .await
                .map_err(|error| platform_error(&held, error))
        }
        "resolve_workspace_git_root" => {
            let held = leased(layer, args)?;
            workspace(&held)?
                .git_root(&query)
                .await
                .map_err(|error| platform_error(&held, error))
        }
        "read_history" | "read_summary" => {
            let held = leased(layer, args)?;
            let (readers, _) = super::super::agent_sessions::owned_readers(cx, &held.connection_id)
                .await
                .map_err(|error| platform_error(&held, error))?;
            let read = if op == "read_history" {
                readers.read_history(&query).await
            } else {
                readers.read_summary(&query).await
            };
            read.map_err(|error| match error.code {
                Some(code) => RpcError::with_code(error.message, &code),
                None => RpcError::new(error.message),
            })
        }
        "owned_session" => {
            let held = leased(layer, args)?;
            Ok(layer
                .owned_session(&held.connection_id, text(args, "pane_id").unwrap_or(""))
                .unwrap_or(Value::Null))
        }
        "conversation_prompt" => {
            let held = leased(layer, args)?;
            let hold = gate(layer, args);
            let prompted = super::conversation::prompt(
                layer,
                cx,
                &held.connection_id,
                text(args, "pane_id").unwrap_or(""),
                text(args, "prompt").unwrap_or(""),
                false,
                hold.as_ref()
                    .map(|hold| &*hold.gate as &(dyn Fn() -> Result<(), RpcError> + Send + Sync)),
            )
            .await?;
            Ok(json!(prompted))
        }
        "read_worktree_hooks" => {
            let held = leased(layer, args)?;
            workspace(&held)?
                .worktree_hooks(text(args, "cwd").unwrap_or(""))
                .await
        }
        "recovery_identity" => {
            let held = leased(layer, args)?;
            super::recovery_identity(&held)
                .await
                .map(|boot| json!(boot))
                .map_err(RpcError::new)
        }
        "read_gui_settings" => {
            let settings = super::super::settings::read_shared(cx).await;
            Ok(Value::Object(settings.as_map().clone()))
        }
        "resolve_repo_settings_key" => {
            let held = leased(layer, args)?;
            let runtime = workspace(&held)?;
            let input = &args["input"];
            let settings = roamgate_base::settings::Settings::normalize(&input["settings"]);
            let (key, common_dir) =
                roamgate_workspace::worktree::create::resolve_repo_settings_key(
                    input
                        .get("workspace")
                        .filter(|workspace| !workspace.is_null()),
                    text(input, "root"),
                    Some(&held.connection_id),
                    &settings,
                    runtime.git(),
                )
                .await;
            Ok(json!({"key": key, "commonDir": common_dir}))
        }
        "inspect_workspace_path" => {
            let held = leased(layer, args)?;
            let runtime = workspace(&held)?;
            let info = roamgate_workspace::path::inspect_workspace_path(
                args.get("cwd"),
                runtime.git(),
                runtime.is_windows(),
                false,
            )
            .await
            .map_err(|error| RpcError::new(error.message))?;
            Ok(serde_json::to_value(info).unwrap_or(Value::Null))
        }
        "note_turn_cause" => {
            super::super::voice::note_turn_cause(
                text(args, "connection_id").unwrap_or(""),
                text(args, "pane_id").unwrap_or(""),
                &args["cause"],
            );
            Ok(Value::Null)
        }
        "gate_revoke" => {
            if let Some(token) = args.get("token").and_then(Value::as_u64)
                && layer.revoked.lock().unwrap().contains_key(&token)
            {
                let message = text(args, "message").unwrap_or("").to_owned();
                let error = if args.get("user") == Some(&Value::Bool(true)) {
                    RpcError::with_code(message, "assistant_user")
                } else {
                    RpcError::new(message)
                };
                layer.revoked.lock().unwrap().insert(token, Some(error));
            }
            Ok(Value::Null)
        }
        other => Err(RpcError::new(format!("unknown assistant.host op {other}"))),
    }
}
