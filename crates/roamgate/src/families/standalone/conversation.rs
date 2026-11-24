//! What the core's conversation mode and Claude mod hub asked of Bun
//! (index.ts `conversationHost`, `conversation.owned_panes`,
//! `conversation.prompt`, `claude_mod.*`): the front's view of each
//! connection's conversation mode (its mirror), the prompt cards (the
//! review family's), the settings and session profiles, launches, and the
//! browsers' events.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use roamgate_connections::agent_profiles::discovery::{ModelDiscovery, ModelDiscoveryOptions};
use roamgate_connections::agent_profiles::store::{
    LaunchSpec, SessionProfiles, profile_for_session,
};
use roamgate_connections::routing::serialize_herdr_event_envelope;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

use super::{Layer, Target, call, launch_registry, text};

pub(super) const TARGETS: &[(&str, Target)] = &[
    ("conversation.host", |layer, cx, args| {
        Box::pin(async move { host(&layer, &cx, &args).await })
    }),
    ("conversation.owned_panes", |layer, _, args| {
        Box::pin(async move {
            let lease = layer.lease(&args)?;
            Ok(Value::Array(layer.owned_panes(&lease.connection_id)))
        })
    }),
    ("conversation.prompt", |layer, cx, args| {
        Box::pin(async move {
            let (pane, text) = pane_text(&args)?;
            let lease = layer.lease(&args)?;
            let prompted =
                prompt(&layer, &cx, &lease.connection_id, &pane, &text, false, None).await?;
            Ok(json!(prompted))
        })
    }),
    // The hub runs in this process: its readers read it.
    ("claude_mod.mirror", |_, _, _| {
        Box::pin(async { Ok(json!({"ok": true})) })
    }),
    ("claude_mod.changed", |layer, cx, args| {
        Box::pin(async move {
            if let (Some(id), Some(pane), Some(change)) = (
                text(&args, "connection_id"),
                text(&args, "pane_id"),
                text(&args, "change"),
            ) {
                mod_changed(&layer, &cx, id, pane, change);
            }
            Ok(json!({"ok": true}))
        })
    }),
    // The core gave up review or conversation: only at its stop here.
    ("claude_mod.released", |_, _, _| {
        Box::pin(async { Ok(json!({"ok": true})) })
    }),
    ("claude_mod.panes", |layer, _, args| {
        Box::pin(async move {
            let lease = layer.lease(&args)?;
            Ok(Value::Array(layer.mod_panes(&lease.connection_id)))
        })
    }),
    ("claude_mod.deliver", |layer, _, args| {
        Box::pin(async move {
            let (pane, message) = pane_text(&args)?;
            let lease = layer.lease(&args)?;
            let kind = text(&args, "kind").unwrap_or("");
            let delivered = mod_deliver(&lease.connection_id, &pane, &message, kind)?;
            Ok(json!(!delivered.is_null()))
        })
    }),
];

/// A reverse call's pane and text (index.ts `corePaneText`).
fn pane_text(args: &Value) -> Result<(String, String), RpcError> {
    match (text(args, "pane_id"), text(args, "text")) {
        (Some(pane), Some(text)) => Ok((pane.to_owned(), text.to_owned())),
        _ => Err(RpcError::new("needs a pane_id and a text")),
    }
}

/// The profiles' models (profiles/models.ts `profileModels`), kept an hour.
fn discovery() -> &'static ModelDiscovery {
    static DISCOVERY: LazyLock<ModelDiscovery> = LazyLock::new(|| {
        ModelDiscovery::new(ModelDiscoveryOptions {
            fetch: None,
            now: None,
            timeout: None,
            home: home(),
        })
    });
    &DISCOVERY
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// This Roamgate's own holder and socket, for a local connection.
pub(super) fn local_holder() -> Value {
    let dir = home().join(roamgate_review::agent_socket::REVIEW_HOME_DIR);
    json!({
        "bin": dir.join("bin").join("roamgate-hold").display().to_string(),
        "socket": dir.join("review.sock").display().to_string(),
    })
}

/// The session choices as the agent_profiles family wrote them.
pub(super) fn session_profiles() -> SessionProfiles {
    SessionProfiles::at_data_root(
        roamgate_base::paths::DataContext::from_env(&roamgate_base::env::ProcessEnv),
        None,
        None,
    )
}

/// What is typed into a pane to start a launch (runtime.ts `typedLaunch`):
/// over SSH the host's holder, locally this Roamgate's own.
pub(super) fn launch_command(lease: &super::Lease, token: &str) -> Result<String, RpcError> {
    let local = lease.runtime.ssh_host().is_none().then(|| {
        let holder = local_holder();
        roamgate_conversation::holder_script::LocalHolder {
            bin: holder["bin"].as_str().unwrap_or("").to_owned(),
            socket: holder["socket"].as_str().unwrap_or("").to_owned(),
        }
    });
    roamgate_conversation::holder_script::launch_command(token, local.as_ref())
        .map_err(|error| RpcError::new(error.0))
}

/// conversation/core-front.ts `prompt`: a message for the session the
/// core's conversation mode holds in the pane, queued there; false when
/// it holds none (or the terminal does). `before_send` is a gate run
/// just before it goes.
pub(super) async fn prompt(
    layer: &Layer,
    cx: &FamilyContext,
    connection_id: &str,
    pane_id: &str,
    text: &str,
    peer: bool,
    before_send: Option<&(dyn Fn() -> Result<(), RpcError> + Send + Sync)>,
) -> Result<bool, RpcError> {
    let lease = layer.mirror(connection_id)["leases"][pane_id].clone();
    if lease.is_null() || lease["phase"] == "terminal" {
        return Ok(false);
    }
    if let Some(before_send) = before_send {
        before_send()?;
    }
    let answer = call(
        cx,
        "internal.conversation.prompt",
        json!({"connection_id": connection_id, "pane_id": pane_id, "text": text, "peer": peer}),
    )
    .await?;
    Ok(answer == Value::Bool(true))
}

/// The hub's delivery (`ClaudeModFront.deliver`): the message's id, or
/// null when the pane's mod is not live.
pub(super) fn mod_deliver(
    connection_id: &str,
    pane_id: &str,
    text: &str,
    kind: &str,
) -> Result<Value, RpcError> {
    super::super::claude_mod::deliver(&json!({
        "connection_id": connection_id,
        "pane_id": pane_id,
        "text": text,
        "kind": kind,
    }))
}

/// index.ts `claudeModChanged`: the browsers read the pane again, and a
/// turn that ended may have stopped on a usage limit.
fn mod_changed(layer: &Layer, cx: &FamilyContext, id: &str, pane: &str, change: &str) {
    let generation = layer.ready(id).ok().flatten().map(|lease| lease.generation);
    let event =
        json!({"event": "roamgate.claude_mod", "data": {"pane_id": pane, "change": change}});
    if let Ok(line) = serialize_herdr_event_envelope(id, &event, generation) {
        layer.clients.broadcast(&line, "claude-mod", None);
    }
    if change != "usage" {
        super::runtime::poke_limit(cx, id, Some(pane));
    }
}

/// A conversation lease changed (runtime.ts `conversationLeaseChanged`):
/// the pane's history may now be another file, and Herdr's view of it
/// changes with it.
fn lease_changed(layer: &Layer, cx: &FamilyContext, id: &str, pane: &str) {
    super::tell(
        cx,
        "internal.agent_sessions.refresh",
        json!({"connection_id": id, "pane_id": pane}),
    );
    let generation = layer.ready(id).ok().flatten().map(|lease| lease.generation);
    let event = json!({"event": "roamgate.conversation_lease", "data": {"pane_id": pane}});
    if let Ok(line) = serialize_herdr_event_envelope(id, &event, generation) {
        layer.clients.broadcast(&line, "event", None);
    }
}

/// An owned agent reported its status (runtime.ts `onOwnedAgentStatus`):
/// the activity log hears it, and a turn that ended may have stopped on a
/// limit.
fn owned_status(cx: &FamilyContext, id: &str, pane: &str) {
    super::tell(
        cx,
        "internal.activity.signals",
        json!({"signals": [{
            "op": "owned_agent",
            "ts": cx.clock.now(),
            "connection_id": id,
            "pane_id": pane,
        }]}),
    );
    super::runtime::poke_limit(cx, id, Some(pane));
}

/// A launch as the front gets it (`LaunchSpec`).
pub(super) fn launch_spec_of(value: &Value) -> LaunchSpec {
    let strings = |key: &str| -> Vec<String> {
        value[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|each| each.as_str().map(str::to_owned))
            .collect()
    };
    LaunchSpec {
        argv: strings("argv"),
        env: value["env"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect(),
        unset: strings("unset"),
        agent: value["agent"].as_str().unwrap_or("").to_owned(),
        terminal: value["terminal"] == Value::Bool(true),
    }
}

/// `conversation.host {op, connection_id?, ...}`.
async fn host(layer: &Arc<Layer>, cx: &FamilyContext, args: &Value) -> Result<Value, RpcError> {
    let op = text(args, "op").unwrap_or("");
    if op == "released" {
        return Ok(json!({"ok": true}));
    }
    let lease = layer.lease(args)?;
    let id = lease.connection_id.clone();
    let pane = text(args, "pane_id").unwrap_or("").to_owned();
    match op {
        "connection" => {
            let ssh = lease.runtime.ssh_host().is_some();
            Ok(json!({
                "connection_id": id,
                "generation": lease.generation,
                "ssh": ssh,
                "local_holder": if ssh { Value::Null } else { local_holder() },
            }))
        }
        "ssh_argv" => {
            let host = lease
                .runtime
                .ssh_host()
                .ok_or_else(|| RpcError::new("this connection has no SSH host"))?;
            let command = match args.get("command") {
                Some(Value::String(command)) => command.clone(),
                None | Some(Value::Null) => String::new(),
                Some(other) => other.to_string(),
            };
            let tag = text(args, "tag").unwrap_or("agent_chat");
            Ok(json!(super::connections::ssh_read_argv(
                layer, host, &command, tag
            )?))
        }
        "ask" => {
            let mut asked = json!({
                "tool": text(args, "tool").unwrap_or(""),
                "input": args.get("input").cloned().unwrap_or(Value::Null),
                "canAlways": args.get("can_always") == Some(&Value::Bool(true)),
                "timeoutMs": args.get("timeout_ms").and_then(Value::as_f64).unwrap_or(0.0),
                "connectionId": id,
                "paneId": pane,
                "agent": "Claude",
                "noTerminal": true,
            });
            if let Some(questions) = args.get("questions").filter(|q| q.is_array()) {
                asked["questions"] = questions.clone();
            }
            // The card goes when this call is dropped (the turn stopped
            // asking).
            call(
                cx,
                "internal.review.call",
                json!({"method": "prompts.request", "params": asked}),
            )
            .await
        }
        "idle_stop_minutes" => Ok(json!(
            super::super::settings::read_shared(cx)
                .await
                .conversation_idle_stop_minutes()
        )),
        // A voice call or a companion job keeps a conversation awake: the
        // core's own (its conversation mode asks its voice first).
        "keep_awake" => Ok(Value::Null),
        "models_offered" => {
            let settings = super::super::settings::read_shared(cx).await;
            let raw = Value::Object(settings.as_map().clone());
            let store = session_profiles();
            let profile = profile_for_session(
                Some(&raw),
                Some(text(args, "session_id").unwrap_or("")),
                Some(&store),
            );
            Ok(discovery().models(&profile, false).await)
        }
        "choose_model" => {
            let mut write = json!({
                "op": "choose_model",
                "session_id": text(args, "session_id").unwrap_or(""),
                "model": text(args, "model").unwrap_or(""),
            });
            if let Some(resolved) = text(args, "resolved").filter(|resolved| !resolved.is_empty()) {
                write["resolved"] = json!(resolved);
            }
            call(cx, "internal.agent_profiles.store", write).await?;
            Ok(json!({"ok": true}))
        }
        "register_launch" => {
            let spec = launch_spec_of(args.get("spec").unwrap_or(&Value::Null));
            launch_registry().register_token(&id, &pane, spec, text(args, "token").unwrap_or(""));
            Ok(json!({"ok": true}))
        }
        "mirror" => {
            let mirror = args.get("mirror").cloned().unwrap_or(Value::Null);
            layer.mirrors.lock().unwrap().insert(id, mirror);
            Ok(json!({"ok": true}))
        }
        "tell" => {
            match text(args, "what") {
                Some("lease_changed") => lease_changed(layer, cx, &id, &pane),
                Some("owned_status") => owned_status(cx, &id, &pane),
                _ => {}
            }
            Ok(json!({"ok": true}))
        }
        other => Err(RpcError::new(format!(
            "conversation.host: unknown op {other}"
        ))),
    }
}
