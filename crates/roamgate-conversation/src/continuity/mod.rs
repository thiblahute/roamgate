//! A conversation-mode conversation kept across the agents that run it
//! (`claude`, `agy`): Roamgate's own numbered history of it, each agent's
//! native sessions and how far each has seen it, and the switch from one
//! agent to another, one writer at a time (`agent_chat.switch_agent`).

pub mod export;
pub mod model;
pub mod store;

pub use export::{
    BootstrapOptions, BootstrapPackage, DEFAULT_BOOTSTRAP_BUDGET_CHARS, export_bootstrap,
};
pub use model::{
    AgentExecution, CanonicalEvent, CanonicalEventKind, ExternalJob, HandoffMachine, HandoffPhase,
    PortableCheckpoint, QueuedHandoffMessage, WorkSession,
};
pub use store::{Recovery, WorkSessionStore, default_continuity_dir};
