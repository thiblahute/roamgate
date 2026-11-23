//! The Claude mod hub in the core (roamgate-claude's `mod_hub`): it runs here
//! while the core owns both the review family (its agent socket takes the
//! mods' requests, `claude_mod.*` and claude-mod-inbox.json are review's)
//! and the conversation family (whose sessions the mods' panes are);
//! otherwise Bun runs it (contract/wire/core-channel.md, The Claude mod
//! hub).
//!
//! Bun drives the change of hands through the file: it writes its inbox,
//! then calls `internal.review.mod_take`; it asks `internal.review.mod_release`
//! (the core writes the inbox and stops the hub) before reading the file
//! again. The core also stops the hub, and tells `claude_mod.released`, when
//! it gives up either family. While the hub runs here the front's
//! synchronous readers read the mirror the core sends after each change
//! (`claude_mod.mirror`); a pane's change goes to the browsers through the
//! front (`claude_mod.changed`), and the front's deliveries come here
//! (`internal.review.mod_deliver`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use roamgate_claude::mod_hub::{ClaudeModHub, ClaudeModOptions, ClaudeModTypeResult};
use roamgate_review::agent_socket::{ClaudeMods, Form};
use roamgate_review::error::ReviewResult;
use roamgate_review::service::BoxFut;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::protocol::RpcError;
use serde_json::{Value, json};

use super::review_socket::ReverseMods;

/// The inbox's file, review's (contract/owners/families.json).
pub const INBOX_FILE: &str = "claude-mod-inbox.json";

#[derive(Default)]
struct Slot {
    review: bool,
    conversation: bool,
    hub: Option<Running>,
}

struct Running {
    hub: ClaudeModHub,
    mirror: tokio::task::JoinHandle<()>,
    /// Asks the mirror task to send now.
    poke: Arc<tokio::sync::Notify>,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);

fn with_slot<T>(f: impl FnOnce(&mut Slot) -> T) -> T {
    let mut guard = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Slot::default))
}

/// The hub, while it runs in the core.
pub fn current() -> Option<ClaudeModHub> {
    with_slot(|slot| slot.hub.as_ref().map(|running| running.hub.clone()))
}

/// Sends the mirror soon (after a change the hub made).
pub fn changed() {
    with_slot(|slot| {
        if let Some(running) = &slot.hub {
            running.poke.notify_one();
        }
    });
}

/// The review or conversation family was given to the core or taken back:
/// the hub stops when the core no longer owns both.
pub fn family_owned(cx: &FamilyContext, family: &str, owned: bool) {
    let stopped = with_slot(|slot| {
        match family {
            "review" => slot.review = owned,
            "conversation" => slot.conversation = owned,
            _ => {}
        }
        if slot.review && slot.conversation {
            return None;
        }
        slot.hub.take()
    });
    if let Some(running) = stopped {
        stop(running);
        let cx = cx.clone();
        tokio::spawn(async move {
            let _ = cx.reverse("claude_mod.released", json!({})).await;
        });
    }
}

fn stop(running: Running) {
    running.mirror.abort();
    // dispose writes what is pending.
    running.hub.dispose();
    running.hub.flush();
}

/// `internal.review.mod_take`: Bun wrote its inbox; the hub starts here,
/// reading it. Refused unless the core owns review and conversation.
pub fn take(cx: &FamilyContext) -> Result<Value, RpcError> {
    let owns = with_slot(|slot| (slot.review && slot.conversation, slot.hub.is_some()));
    match owns {
        (false, _) => {
            return Err(RpcError::new(
                "the core runs the Claude mod hub only while it owns review and conversation",
            ));
        }
        (true, true) => return Ok(json!({"ok": true})),
        (true, false) => {}
    }
    let hub = ClaudeModHub::new(options(cx));
    let poke = Arc::new(tokio::sync::Notify::new());
    let mirror = tokio::spawn(send_mirrors(cx.clone(), hub.clone(), poke.clone()));
    let extra = with_slot(|slot| {
        if slot.hub.is_some() || !(slot.review && slot.conversation) {
            return Some(Running { hub, mirror, poke });
        }
        slot.hub = Some(Running { hub, mirror, poke });
        None
    });
    if let Some(extra) = extra {
        stop(extra);
    }
    changed();
    Ok(json!({"ok": true}))
}

/// `internal.review.mod_release`: the hub's inbox is written and it stops
/// here; Bun reads the file next.
pub fn release() -> Value {
    if let Some(running) = with_slot(|slot| slot.hub.take()) {
        stop(running);
    }
    json!({"ok": true})
}

/// `internal.review.mod_flush`: the front stops; the inbox is written now.
pub fn flush() -> Value {
    if let Some(hub) = current() {
        hub.flush();
    }
    json!({"ok": true})
}

/// `internal.review.mod_deliver {connection_id, pane_id, text, kind}`: a
/// delivery of the front's (the companion, the agent messenger): the
/// message's id, or null when the pane's mod is not live.
pub fn deliver(params: &Value) -> Result<Value, RpcError> {
    let Some(hub) = current() else {
        return Ok(Value::Null);
    };
    let text = |name: &str| params.get(name).and_then(Value::as_str).unwrap_or("");
    let delivered = hub
        .deliver(
            text("connection_id"),
            text("pane_id"),
            text("text"),
            text("kind"),
        )
        .map_err(|error| RpcError::with_code(error.message, "claude_mod_refused"))?;
    changed();
    Ok(json!(delivered))
}

fn options(cx: &FamilyContext) -> ClaudeModOptions {
    let clock = cx.clock.clone();
    let typer = cx.clone();
    let teller = cx.clone();
    ClaudeModOptions {
        file: Some(
            DataContext::from_env(&ProcessEnv)
                .data_root()
                .join(INBOX_FILE),
        ),
        now: Arc::new(move || clock.now()),
        log: Some(Arc::new(|message, fields| {
            tracing::info!(scope = "claude-mod", fields = %fields, "{message}");
        })),
        debug: Some(Arc::new(|message, fields| {
            tracing::debug!(scope = "claude-mod", fields = %fields, "{message}");
        })),
        type_message: Some(Arc::new(move |connection, pane, text| {
            let cx = typer.clone();
            Box::pin(async move { type_message(&cx, &connection, &pane, &text).await })
        })),
        on_change: Some(Arc::new(move |connection, pane, change| {
            changed();
            let cx = teller.clone();
            let args = json!({
                "connection_id": connection,
                "pane_id": pane,
                "change": change.as_str(),
            });
            tokio::spawn(async move {
                let _ = cx.reverse("claude_mod.changed", args).await;
            });
        })),
        ..ClaudeModOptions::default()
    }
}

/// A message a pane's mod left when it went away: typed as for a session
/// without one (Bun's `typeForClaudeMod`): conversation mode's queue, else
/// through Herdr once its agent is idle.
async fn type_message(
    cx: &FamilyContext,
    connection: &str,
    pane: &str,
    text: &str,
) -> Result<ClaudeModTypeResult, String> {
    let ready = cx
        .reverse("connections.ready", json!({}))
        .await
        .map_err(|error| error.message)?;
    let connected = ready
        .as_array()
        .into_iter()
        .flatten()
        .any(|each| each.get("id").and_then(Value::as_str) == Some(connection));
    if !connected {
        return Ok(ClaudeModTypeResult::Wait);
    }
    let prompted = cx
        .reverse(
            "conversation.prompt",
            json!({"connection_id": connection, "pane_id": pane, "text": text}),
        )
        .await
        .map_err(|error| error.message)?;
    if prompted == Value::Bool(true) {
        return Ok(ClaudeModTypeResult::Typed);
    }
    let info = match cx
        .reverse(
            "herdr.call",
            json!({
                "connection_id": connection,
                "method": "agent.get",
                "params": {"target": pane},
                "timeout_ms": 5000,
            }),
        )
        .await
    {
        Ok(info) => info,
        Err(error) => {
            let lower = error.message.to_lowercase();
            if lower.contains("not_found") || lower.contains("not found") {
                return Ok(ClaudeModTypeResult::Gone);
            }
            return Err(error.message);
        }
    };
    let Some(agent) = info.get("agent").filter(|agent| agent.is_object()) else {
        return Ok(ClaudeModTypeResult::Gone);
    };
    let status = agent.get("agent_status").and_then(Value::as_str);
    if status != Some("idle") && status != Some("done") {
        return Ok(ClaudeModTypeResult::Wait);
    }
    cx.reverse(
        "herdr.call",
        json!({
            "connection_id": connection,
            "method": "agent.prompt",
            "params": {"target": pane, "text": text},
            "timeout_ms": 5000,
        }),
    )
    .await
    .map_err(|error| error.message)?;
    Ok(ClaudeModTypeResult::Typed)
}

/// Sends the mirror once something may have changed (a poke), and every
/// few seconds, so the front's live and tools checks age as the hub's do;
/// an unchanged mirror is not sent again.
async fn send_mirrors(cx: FamilyContext, hub: ClaudeModHub, poke: Arc<tokio::sync::Notify>) {
    let mut sent = String::new();
    loop {
        tokio::select! {
            () = poke.notified() => {
                // A burst of changes goes as one.
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            () = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
        let mirror = hub.mirror();
        let text = mirror.to_string();
        if text == sent {
            continue;
        }
        if cx.reverse("claude_mod.mirror", mirror).await.is_ok() {
            sent = text;
        }
    }
}

/// The agent socket's Claude mod requests: the core's hub while it runs
/// here, else Bun's through `review.socket`.
pub struct SwitchMods {
    pub reverse: ReverseMods,
}

impl ClaudeMods for SwitchMods {
    fn request(
        &self,
        connection_id: String,
        command: String,
        form: Form,
    ) -> BoxFut<ReviewResult<Value>> {
        match current() {
            Some(hub) => Box::pin(async move {
                // A poll counts while it waits: the mirror says so.
                let early = tokio::spawn(async {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    changed();
                });
                let answer = ClaudeMods::request(&hub, connection_id, command, form).await;
                early.abort();
                changed();
                answer
            }),
            None => self.reverse.request(connection_id, command, form),
        }
    }
}
