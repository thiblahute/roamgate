//! Conversation mode's Antigravity CLI (`agy`) drivers: `agy acp --stdio`
//! headless (the protocol driver and its ACP codec), the `agy` TUI (the
//! terminal driver), the companion's memory directory, and the commands
//! AGY answers locally, implementing roamgate-conversation's driver traits.

pub mod acp;
pub mod commands;
pub mod memory;
pub mod tui;

use std::sync::Arc;

use roamgate_conversation::driver::ConversationDriver;

pub use acp::{AgyAcpCodec, AgyModels, AgyProtocolDriver, agy_capabilities};
pub use memory::AgyMemoryDriver;
pub use tui::AgyTerminalDriver;

/// AGY's drivers: headless over ACP, TUI and memory.
pub fn agy_driver() -> ConversationDriver {
    ConversationDriver {
        protocol: Arc::new(AgyProtocolDriver),
        terminal: Arc::new(AgyTerminalDriver),
        memory: Arc::new(AgyMemoryDriver),
    }
}

#[cfg(test)]
mod tests {
    use roamgate_agents::js;
    use roamgate_agents::obj;
    use roamgate_conversation::driver::Drivers;
    use roamgate_conversation::holder::resume_reply;
    use roamgate_conversation::shared::AgentCommand;
    use serde_json::Value;

    #[test]
    fn a_claude_profile_never_changes_an_agy_resume() {
        let lease = obj! {
            "pane_id" => "p", "session_id" => "s2", "cwd" => "/w", "agent" => "agy",
        };
        let claude = AgentCommand {
            agent: "claude".into(),
            program: "claude".into(),
            ..AgentCommand::default()
        };
        let drivers = Drivers::new(vec![super::agy_driver()]);
        assert_eq!(
            js::stringify(&Value::Object(resume_reply(
                &lease,
                Some(&claude),
                &drivers
            ))),
            r#"{"action":"resume","session_id":"s2","cwd":"/w","argv":["agy","--conversation","s2"],"args":["--conversation","s2"]}"#
        );
    }
}
