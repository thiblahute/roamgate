//! Text for the agent of a pane from Roamgate itself (`prompt-pane.ts`):
//! a message when conversation mode holds the pane, where typing would
//! only reach the holder; the pane's Claude mod when it runs a live one,
//! which submits it once Claude is idle; typed into the pane through
//! Herdr's `agent.prompt` otherwise.

use serde_json::json;

use crate::driver::BoxFuture;
use crate::herdr::HerdrResult;

/// What delivers to a pane's Claude through Roamgate's Claude mod, when
/// that Claude runs a live one (`ClaudeModDelivery`).
pub trait ClaudeModDelivery: Send + Sync {
    /// The message's inbox id, else None.
    fn deliver(&self, pane_id: &str, text: &str, kind: &str) -> Option<u64>;
    /// Whether the pane's Claude has the mod's tools (it said so lately).
    fn has_tools(&self, _pane_id: &str) -> bool {
        false
    }
}

/// What a prompt goes through.
pub trait PromptRuntime: Send + Sync {
    /// Conversation mode takes it as a message; false when it does not
    /// hold the pane.
    fn conversation_prompt<'a>(&'a self, pane_id: &'a str, text: &'a str) -> BoxFuture<'a, bool>;
    fn claude_mod(&self) -> Option<&dyn ClaudeModDelivery>;
    fn herdr_call<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> BoxFuture<'a, HerdrResult<serde_json::Value>>;
}

/// Which way the text went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptWay {
    Conversation,
    Mod,
    Terminal,
}

impl PromptWay {
    pub fn as_str(self) -> &'static str {
        match self {
            PromptWay::Conversation => "conversation",
            PromptWay::Mod => "mod",
            PromptWay::Terminal => "terminal",
        }
    }
}

/// Says which way it went; the error is Herdr's when typing failed.
pub async fn prompt_pane_agent(
    runtime: &dyn PromptRuntime,
    pane_id: &str,
    text: &str,
    kind: &str,
) -> HerdrResult<PromptWay> {
    if runtime.conversation_prompt(pane_id, text).await {
        return Ok(PromptWay::Conversation);
    }
    if runtime
        .claude_mod()
        .is_some_and(|delivery| delivery.deliver(pane_id, text, kind).is_some())
    {
        return Ok(PromptWay::Mod);
    }
    runtime
        .herdr_call(
            "agent.prompt",
            json!({"target": pane_id, "text": text}),
            5000,
        )
        .await?;
    Ok(PromptWay::Terminal)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;

    #[derive(Default)]
    struct Runtime {
        holds: bool,
        fails: bool,
        messages: Mutex<Vec<(String, String)>>,
        calls: Mutex<Vec<(String, Value)>>,
        delivery: Option<Delivery>,
    }

    #[derive(Default)]
    struct Delivery {
        live: bool,
        handed: Mutex<Vec<(String, String, String)>>,
    }

    impl ClaudeModDelivery for Delivery {
        fn deliver(&self, pane_id: &str, text: &str, kind: &str) -> Option<u64> {
            if !self.live {
                return None;
            }
            self.handed
                .lock()
                .unwrap()
                .push((pane_id.into(), text.into(), kind.into()));
            Some(1)
        }
    }

    impl PromptRuntime for Runtime {
        fn conversation_prompt<'a>(
            &'a self,
            pane_id: &'a str,
            text: &'a str,
        ) -> BoxFuture<'a, bool> {
            Box::pin(async move {
                if !self.holds {
                    return false;
                }
                self.messages
                    .lock()
                    .unwrap()
                    .push((pane_id.into(), text.into()));
                true
            })
        }
        fn claude_mod(&self) -> Option<&dyn ClaudeModDelivery> {
            self.delivery
                .as_ref()
                .map(|delivery| delivery as &dyn ClaudeModDelivery)
        }
        fn herdr_call<'a>(
            &'a self,
            method: &'a str,
            params: Value,
            _timeout_ms: u64,
        ) -> BoxFuture<'a, HerdrResult<Value>> {
            Box::pin(async move {
                if self.fails {
                    return Err("agent_blocked".into());
                }
                self.calls.lock().unwrap().push((method.into(), params));
                Ok(json!({}))
            })
        }
    }

    #[tokio::test]
    async fn conversation_mode_a_message_in_the_conversation_nothing_typed() {
        let rt = Runtime {
            holds: true,
            ..Runtime::default()
        };
        assert_eq!(
            prompt_pane_agent(&rt, "w1:p1", "A comment", "").await,
            Ok(PromptWay::Conversation)
        );
        assert_eq!(
            *rt.messages.lock().unwrap(),
            [("w1:p1".to_owned(), "A comment".to_owned())]
        );
        assert!(rt.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn terminal_mode_typed_into_the_pane_through_herdr() {
        let rt = Runtime::default();
        assert_eq!(
            prompt_pane_agent(&rt, "w1:p1", "A comment", "").await,
            Ok(PromptWay::Terminal)
        );
        assert!(rt.messages.lock().unwrap().is_empty());
        assert_eq!(
            *rt.calls.lock().unwrap(),
            [(
                "agent.prompt".to_owned(),
                json!({"target": "w1:p1", "text": "A comment"})
            )]
        );
    }

    #[tokio::test]
    async fn a_claude_running_roamgate_s_mod_handed_to_the_mod_nothing_typed() {
        let rt = Runtime {
            delivery: Some(Delivery {
                live: true,
                ..Delivery::default()
            }),
            ..Runtime::default()
        };
        assert_eq!(
            prompt_pane_agent(&rt, "w1:p1", "A comment", "review").await,
            Ok(PromptWay::Mod)
        );
        assert_eq!(
            *rt.delivery.as_ref().unwrap().handed.lock().unwrap(),
            [(
                "w1:p1".to_owned(),
                "A comment".to_owned(),
                "review".to_owned()
            )]
        );
        assert!(rt.calls.lock().unwrap().is_empty());
        // No live mod there: typed as before.
        let rt = Runtime {
            delivery: Some(Delivery::default()),
            ..Runtime::default()
        };
        assert_eq!(
            prompt_pane_agent(&rt, "w1:p1", "Another", "").await,
            Ok(PromptWay::Terminal)
        );
        assert_eq!(rt.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_failure_says_so_the_review_records_it_as_not_delivered() {
        let rt = Runtime {
            fails: true,
            ..Runtime::default()
        };
        assert_eq!(
            prompt_pane_agent(&rt, "w1:p1", "A comment", "").await,
            Err("agent_blocked".to_owned())
        );
    }
}
