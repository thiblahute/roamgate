//! Roamgate's conversation mode (Rust migration plan, section 6.2): a
//! pane's agent driven headless through the pane's holder, handed over to
//! and from its TUI. Ported from `server/src/conversation/` decision for
//! decision. The core (session, service, handover, holder) is the same for
//! every agent and reaches the agent only through its driver ([`driver`]);
//! Claude's drivers are `roamgate-claude::conversation`.

pub mod driver;
