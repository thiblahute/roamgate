//! Roamgate's conversation mode (Rust migration plan, section 6.2): a
//! pane's agent driven headless through the pane's holder, handed over to
//! and from its TUI. Ported from `server/src/conversation/` decision for
//! decision. The core (session, service, handover, holder) is the same for
//! every agent and reaches the agent only through its driver ([`driver`]);
//! Claude's drivers are `roamgate-claude::conversation`.
//!
//! Bun's JavaScript values (leases, holder replies, handover results,
//! stream items) are `serde_json` maps in insertion order, their JSON text
//! Bun's; timers run on `roamgate-base`'s clock.

pub mod auto_start;
pub mod behind;
pub mod claude_start_hook;
pub mod continuity;
pub mod driver;
pub mod handover;
pub mod headless;
pub mod herdr;
pub mod holder;
pub mod holder_script;
pub mod idle_stop;
pub mod images;
pub mod lease;
pub mod pane_child;
pub mod prompt_pane;
pub mod rewind_scan;
pub mod rpc;
pub mod service;
pub mod session;
pub mod shared;
pub mod shell;
pub mod suspended;
pub mod testing;
pub mod time;
