//! Conversation mode's Claude drivers (`server/src/conversation/drivers/`):
//! Claude Code headless over stream-json (the protocol driver, its codec,
//! rewind, models and MCP servers), its TUI (the terminal driver) and the
//! companion's memory directory, implementing roamgate-conversation's
//! driver traits. [`drivers`] is every agent's drivers, for the core to
//! give the conversation service.

pub mod claude;
pub mod env;
pub mod js_re;
pub mod mcp;
pub mod memory;
pub mod models;
pub mod rewind;
pub mod stream;
pub mod testing;
pub mod tui;

use std::sync::Arc;

use roamgate_conversation::driver::{ConversationDriver, Drivers};

/// Claude's drivers: headless, TUI and memory.
pub fn claude_driver() -> ConversationDriver {
    ConversationDriver {
        protocol: Arc::new(claude::ClaudeProtocolDriver),
        terminal: Arc::new(tui::ClaudeTerminalDriver),
        memory: Arc::new(memory::ClaudeMemoryDriver),
    }
}

/// Every agent's drivers (`drivers/index.ts`), Claude's first: the
/// default, an older lease's agent.
pub fn drivers() -> Drivers {
    Drivers::new(vec![claude_driver()])
}

#[cfg(test)]
mod contract_tests;
#[cfg(test)]
pub(crate) mod fake;
