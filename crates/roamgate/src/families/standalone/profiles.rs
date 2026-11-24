//! What the agent_profiles family's RPCs asked of a connection (index.ts
//! `profiles.host`, runtime.ts `profileRpcDeps` and `profilePanes`), and
//! the session choices it told the front of.

use roamgate_channel::family::FamilyContext;
use roamgate_channel::protocol::RpcError;
use roamgate_connections::agent_profiles::store::profiles_of;
use serde_json::{Value, json};

use super::conversation::{launch_command, mod_deliver};
use super::{Layer, Lease, Target, call, fields, logger, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("profiles.host", |layer, cx, args| {
        Box::pin(async move { host(&layer, &cx, &args).await })
    }),
    // The store is the agent_profiles family's, in this process.
    ("profiles.sessions_changed", |_, _, args| {
        Box::pin(async move {
            if !args.get("sessions").is_some_and(Value::is_object) {
                return Err(RpcError::new("profiles.sessions_changed needs sessions"));
            }
            Ok(json!({"ok": true}))
        })
    }),
];

/// The panes whose Claude session Herdr knows (or conversation mode
/// owns), for the return after a reset.
async fn panes(layer: &Layer, lease: &Lease) -> Result<Value, RpcError> {
    let listed = lease
        .runtime
        .herdr()
        .call("agent.list", json!({}), 10_000, None, false)
        .await
        .map_err(RpcError::new)?;
    let id = &lease.connection_id;
    Ok(Value::Array(
        listed["agents"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|agent| {
                let pane = agent.get("pane_id")?.as_str()?;
                let owned = layer
                    .owned_session(id, pane)
                    .and_then(|session| session["session_id"].as_str().map(str::to_owned));
                let session = owned
                    .or_else(|| agent["agent_session"]["value"].as_str().map(str::to_owned))?;
                Some(json!({"paneId": pane, "sessionId": session}))
            })
            .collect(),
    ))
}

/// `profiles.host {op, connection_id?, pane_id?, ...}`.
async fn host(layer: &Layer, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let op = text(args, "op").unwrap_or("");
    if op == "settings" {
        let settings = super::super::settings::read_shared(cx).await;
        let raw = Value::Object(settings.as_map().clone());
        return Ok(json!({"profiles": profiles_of(Some(&raw))}));
    }
    let lease = layer.lease(args)?;
    let id = lease.connection_id.clone();
    if op == "panes" {
        return panes(layer, &lease).await;
    }
    if op == "log" {
        let message = match args.get("message") {
            Some(Value::String(message)) => message.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        let mut line = fields(json!({"connection": id}));
        if let Some(extra) = args.get("fields").and_then(Value::as_object) {
            line.extend(extra.clone());
        }
        logger(&cx.clock, "bridge.connection").info(&message, Some(&line));
        return Ok(json!({"ok": true}));
    }
    let pane = text(args, "pane_id")
        .filter(|pane| !pane.is_empty())
        .ok_or_else(|| RpcError::new("profiles.host needs a pane_id"))?
        .to_owned();
    let message = || match args.get("text") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "undefined".into(),
    };
    match op {
        "agent_get" => {
            // With what the pane's Claude mod says laid over Herdr's.
            let params = json!({"target": pane});
            let Ok(answer) = lease
                .runtime
                .herdr()
                .call("agent.get", params.clone(), 5000, None, false)
                .await
            else {
                return Ok(Value::Null);
            };
            let result = roamgate_claude::mod_hub::overlay_mod_panes(
                "agent.get",
                Some(&params),
                answer,
                &layer.mod_panes(&id),
            );
            Ok(result
                .get("agent")
                .filter(|agent| agent.is_object())
                .cloned()
                .unwrap_or(Value::Null))
        }
        "conversation_session" => Ok(layer
            .owned_session(&id, &pane)
            .map_or(Value::Null, |session| session["session_id"].clone())),
        "conversation_model" => Ok(layer.mirror(&id)["models"]
            .get(&pane)
            .cloned()
            .unwrap_or(Value::Null)),
        "restart_process" => {
            call(
                cx,
                "internal.conversation.restart_process",
                json!({"connection_id": id, "pane_id": pane}),
            )
            .await
        }
        "restart_terminal" => {
            let mut params = json!({"connection_id": id, "pane_id": pane});
            if let Some(session) = text(args, "session_id").filter(|session| !session.is_empty()) {
                params["session_id"] = json!(session);
            }
            call(cx, "internal.conversation.restart_terminal", params).await
        }
        "transcript_tail" => Ok(super::connections::transcript_tail(cx, &id, &pane)
            .await
            .unwrap_or(Value::Null)),
        "typed_launch" => {
            let spec =
                super::conversation::launch_spec_of(args.get("spec").unwrap_or(&Value::Null));
            let token = super::launch_registry().register(&id, &pane, spec);
            Ok(json!(launch_command(&lease, &token)?))
        }
        "send_conversation" => {
            call(
                cx,
                "internal.conversation.send",
                json!({"connection_id": id, "pane_id": pane, "text": message()}),
            )
            .await?;
            Ok(json!({"ok": true}))
        }
        "prompt_terminal" => {
            // A Claude mod submits it once Claude is idle; else it is typed.
            let text = message();
            if !mod_deliver(&id, &pane, &text, "retry")?.is_null() {
                return Ok(json!({"ok": true}));
            }
            lease
                .runtime
                .herdr()
                .call(
                    "agent.prompt",
                    json!({"target": pane, "text": text}),
                    5000,
                    None,
                    false,
                )
                .await
                .map_err(RpcError::new)?;
            Ok(json!({"ok": true}))
        }
        "mod_usage" => Ok(super::super::claude_mod::current()
            .and_then(|hub| hub.pane(&id, &pane))
            .and_then(|state| state.get("usage").cloned())
            .unwrap_or(Value::Null)),
        other => Err(RpcError::new(format!("profiles.host: unknown op {other}"))),
    }
}
