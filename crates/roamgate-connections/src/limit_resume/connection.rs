//! A connection (local or SSH) as the resumer sees it
//! (server/src/limit-resume/connection.ts): the panes running a Claude
//! session, from Herdr's agent list and conversation mode's own (an asleep
//! conversation is idle there), and delivery the way review comments go
//! (conversation/prompt-pane.ts): conversation mode's queue, which wakes an
//! asleep process, else the pane's Claude mod, else typed into the
//! terminal's Claude through Herdr's `agent.prompt`.
//!
//! What it needs of the connection is [`LimitHost`]: Herdr, and what
//! conversation mode and the Claude mods (still the Bun server's) say.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::BoxFuture;
use crate::usage_limit::PaneOwner;

/// A pane conversation mode holds.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OwnedPane {
    pub pane_id: String,
    pub session_id: String,
    pub phase: String,
    pub agent_status: String,
    pub agent: String,
}

/// What a pane's Claude mod says of its session.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ModPane {
    pub pane_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub status: String,
}

/// What the resumer needs of a connection's runtime.
pub trait LimitHost: Send + Sync + 'static {
    /// A Herdr call on the connection, timing out after `timeout_ms`.
    fn herdr_call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
    ) -> BoxFuture<Result<Value, String>>;
    /// The panes conversation mode holds.
    fn owned_panes(&self) -> BoxFuture<Result<Vec<OwnedPane>, String>>;
    /// The panes whose Claude runs a live Roamgate mod.
    fn mod_panes(&self) -> BoxFuture<Result<Vec<ModPane>, String>>;
    /// The end of the pane session's transcript, or None.
    fn transcript_tail(&self, pane_id: &str) -> BoxFuture<Result<Option<String>, String>>;
    /// Conversation mode's queue: false when it does not hold the pane.
    fn conversation_prompt(&self, pane_id: &str, text: &str) -> BoxFuture<Result<bool, String>>;
    /// The pane's Claude mod: false when it has none live.
    fn mod_deliver(&self, pane_id: &str, text: &str, kind: &str)
    -> BoxFuture<Result<bool, String>>;
}

/// A pane running a Claude session, terminal or conversation mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitPane {
    pub pane_id: String,
    pub session_id: String,
    pub owner: PaneOwner,
    /// Herdr's (or conversation mode's) agent status; asleep is idle.
    pub status: String,
}

/// What the resumer needs of a connection (local or SSH).
pub trait LimitConnection: Send + Sync + 'static {
    fn id(&self) -> &str;
    /// The panes running a Claude session, asleep conversations included.
    fn panes(&self) -> BoxFuture<Result<Vec<LimitPane>, String>>;
    /// The end of the pane session's transcript, or None.
    fn transcript_tail(&self, pane_id: &str) -> BoxFuture<Result<Option<String>, String>>;
    /// Sends text to the session as the user would.
    fn deliver(&self, pane: &LimitPane, text: &str) -> BoxFuture<Result<(), String>>;
}

/// How a message went to a pane (promptPaneAgent's answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivered {
    Conversation,
    Mod,
    Terminal,
}

/// Sends `text` to the pane's agent: conversation mode's queue when it
/// holds the pane, the pane's live Claude mod, else typed through Herdr
/// (promptPaneAgent).
pub async fn prompt_pane_agent(
    host: &dyn LimitHost,
    pane_id: &str,
    text: &str,
    kind: &str,
) -> Result<Delivered, String> {
    if host.conversation_prompt(pane_id, text).await? {
        return Ok(Delivered::Conversation);
    }
    if host.mod_deliver(pane_id, text, kind).await? {
        return Ok(Delivered::Mod);
    }
    host.herdr_call(
        "agent.prompt",
        json!({"target": pane_id, "text": text}),
        5000,
    )
    .await?;
    Ok(Delivered::Terminal)
}

/// [`LimitConnection`] over a [`LimitHost`] (limitConnection).
pub struct HostConnection<H: LimitHost> {
    id: String,
    host: Arc<H>,
}

impl<H: LimitHost> HostConnection<H> {
    pub fn new(id: impl Into<String>, host: Arc<H>) -> Self {
        Self {
            id: id.into(),
            host,
        }
    }
}

/// The panes of `agent.list`'s answer, laid over by the mods and
/// conversation mode (limitConnection's panes).
pub fn limit_panes(listed: &Value, owned: &[OwnedPane], mods: &[ModPane]) -> Vec<LimitPane> {
    let agents = listed
        .as_object()
        .and_then(|listed| listed.get("agents"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut panes = Vec::new();
    for agent in &agents {
        let Some(agent) = agent.as_object() else {
            continue;
        };
        let Some(pane_id) = agent.get("pane_id").and_then(Value::as_str) else {
            continue;
        };
        if owned.iter().any(|each| each.pane_id == pane_id)
            || agent.get("agent").and_then(Value::as_str) != Some("claude")
        {
            continue;
        }
        let session = agent.get("agent_session").and_then(Value::as_object);
        let Some(value) = session
            .filter(|session| session.get("kind").and_then(Value::as_str) == Some("id"))
            .and_then(|session| session.get("value"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        // A live Claude mod knows when the turn really ended.
        let module = mods.iter().find(|each| each.pane_id == pane_id);
        panes.push(LimitPane {
            pane_id: pane_id.into(),
            session_id: module
                .map(|module| module.session_id.as_str())
                .filter(|id| !id.is_empty())
                .unwrap_or(value)
                .into(),
            owner: PaneOwner::Terminal,
            status: match module {
                Some(module) => module.status.clone(),
                None => agent
                    .get("agent_status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
            },
        });
    }
    for pane in owned {
        // Being handed over: neither side may be typed into meanwhile.
        if pane.phase != "conversation" || pane.agent != "claude" {
            continue;
        }
        panes.push(LimitPane {
            pane_id: pane.pane_id.clone(),
            session_id: pane.session_id.clone(),
            owner: PaneOwner::Conversation,
            status: pane.agent_status.clone(),
        });
    }
    panes
}

impl<H: LimitHost> LimitConnection for HostConnection<H> {
    fn id(&self) -> &str {
        &self.id
    }

    fn panes(&self) -> BoxFuture<Result<Vec<LimitPane>, String>> {
        let host = self.host.clone();
        Box::pin(async move {
            let listed = host.herdr_call("agent.list", json!({}), 10_000).await?;
            let owned = host.owned_panes().await?;
            let mods = host.mod_panes().await?;
            Ok(limit_panes(&listed, &owned, &mods))
        })
    }

    fn transcript_tail(&self, pane_id: &str) -> BoxFuture<Result<Option<String>, String>> {
        self.host.transcript_tail(pane_id)
    }

    fn deliver(&self, pane: &LimitPane, text: &str) -> BoxFuture<Result<(), String>> {
        let host = self.host.clone();
        let pane_id = pane.pane_id.clone();
        let text = text.to_owned();
        Box::pin(async move {
            prompt_pane_agent(host.as_ref(), &pane_id, &text, "limit-resume").await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Fake {
        owned: Vec<OwnedPane>,
        mods: Vec<ModPane>,
        calls: Mutex<Vec<(String, Value)>>,
        prompted: Mutex<Vec<(String, String)>>,
        handed: Mutex<Vec<(String, String)>>,
    }

    impl LimitHost for Fake {
        fn herdr_call(
            &self,
            method: &str,
            params: Value,
            _timeout_ms: u64,
        ) -> BoxFuture<Result<Value, String>> {
            self.calls.lock().unwrap().push((method.into(), params));
            let answer = if method == "agent.list" {
                json!({"agents": [
                    {"pane_id": "w1:p1", "agent": "claude", "agent_status": "idle", "agent_session": {"kind": "id", "value": "terminal-session"}},
                    // Codex, and a Claude Herdr has no session for: not ours.
                    {"pane_id": "w1:p2", "agent": "codex", "agent_status": "idle", "agent_session": {"kind": "id", "value": "codex-session"}},
                    {"pane_id": "w1:p3", "agent": "claude", "agent_status": "idle"},
                    // The holder's child in a pane conversation mode holds.
                    {"pane_id": "w2:p1", "agent": "claude", "agent_status": "working", "agent_session": {"kind": "id", "value": "stale"}},
                ]})
            } else {
                json!({})
            };
            Box::pin(async move { Ok(answer) })
        }

        fn owned_panes(&self) -> BoxFuture<Result<Vec<OwnedPane>, String>> {
            let owned = self.owned.clone();
            Box::pin(async move { Ok(owned) })
        }

        fn mod_panes(&self) -> BoxFuture<Result<Vec<ModPane>, String>> {
            let mods = self.mods.clone();
            Box::pin(async move { Ok(mods) })
        }

        fn transcript_tail(&self, _pane_id: &str) -> BoxFuture<Result<Option<String>, String>> {
            Box::pin(async { Ok(None) })
        }

        fn conversation_prompt(
            &self,
            pane_id: &str,
            text: &str,
        ) -> BoxFuture<Result<bool, String>> {
            let held = self.owned.iter().any(|each| each.pane_id == pane_id);
            if held {
                self.prompted
                    .lock()
                    .unwrap()
                    .push((pane_id.into(), text.into()));
            }
            Box::pin(async move { Ok(held) })
        }

        fn mod_deliver(
            &self,
            pane_id: &str,
            text: &str,
            _kind: &str,
        ) -> BoxFuture<Result<bool, String>> {
            let live = self.mods.iter().any(|each| each.pane_id == pane_id);
            if live {
                self.handed
                    .lock()
                    .unwrap()
                    .push((pane_id.into(), text.into()));
            }
            Box::pin(async move { Ok(live) })
        }
    }

    fn asleep(pane_id: &str, session_id: &str, phase: &str) -> OwnedPane {
        OwnedPane {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            phase: phase.into(),
            // An asleep conversation is idle: its next message wakes it.
            agent_status: "idle".into(),
            agent: "claude".into(),
        }
    }

    fn pane(pane_id: &str, session_id: &str, owner: PaneOwner, status: &str) -> LimitPane {
        LimitPane {
            pane_id: pane_id.into(),
            session_id: session_id.into(),
            owner,
            status: status.into(),
        }
    }

    #[tokio::test]
    async fn lists_terminal_and_conversation_mode_claude_sessions_asleep_ones_included() {
        let host = Arc::new(Fake {
            owned: vec![
                asleep("w2:p1", "conversation-session", "conversation"),
                asleep("w2:p2", "x", "to_terminal"),
            ],
            ..Fake::default()
        });
        let connection = HostConnection::new("desktop", host);
        assert_eq!(
            connection.panes().await.unwrap(),
            vec![
                pane("w1:p1", "terminal-session", PaneOwner::Terminal, "idle"),
                pane(
                    "w2:p1",
                    "conversation-session",
                    PaneOwner::Conversation,
                    "idle"
                ),
            ]
        );
    }

    #[tokio::test]
    async fn a_conversation_gets_the_message_in_its_queue_a_terminal_has_it_typed() {
        let host = Arc::new(Fake {
            owned: vec![asleep("w2:p1", "conversation-session", "conversation")],
            ..Fake::default()
        });
        let connection = HostConnection::new("desktop", host.clone());
        let panes = connection.panes().await.unwrap();
        connection.deliver(&panes[1], "Go on.").await.unwrap();
        assert_eq!(
            *host.prompted.lock().unwrap(),
            vec![("w2:p1".to_owned(), "Go on.".to_owned())]
        );
        assert!(
            !host
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(method, _)| method == "agent.prompt")
        );
        connection.deliver(&panes[0], "Go on.").await.unwrap();
        assert_eq!(
            host.calls.lock().unwrap().last().unwrap(),
            &(
                "agent.prompt".to_owned(),
                json!({"target": "w1:p1", "text": "Go on."})
            )
        );
        assert_eq!(host.prompted.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_terminal_claude_running_roamgate_s_mod_its_status_and_delivery() {
        let host = Arc::new(Fake {
            mods: vec![ModPane {
                pane_id: "w1:p1".into(),
                session_id: "mod-session".into(),
                // Herdr's screen says idle; the turn still runs.
                status: "working".into(),
            }],
            ..Fake::default()
        });
        let connection = HostConnection::new("desktop", host.clone());
        let panes = connection.panes().await.unwrap();
        assert_eq!(
            panes[0],
            pane("w1:p1", "mod-session", PaneOwner::Terminal, "working")
        );
        connection.deliver(&panes[0], "Continue").await.unwrap();
        assert_eq!(
            *host.handed.lock().unwrap(),
            vec![("w1:p1".to_owned(), "Continue".to_owned())]
        );
        assert!(
            !host
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(method, _)| method == "agent.prompt")
        );
    }
}
