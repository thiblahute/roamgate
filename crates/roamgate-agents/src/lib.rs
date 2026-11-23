//! Roamgate's agent sessions (Rust migration plan, section 6.2): the
//! transcript readers of the eight agents (Claude, Codex, Pi, OMP, Kimi,
//! Grok, Muse, Antigravity), the history projection, tasks, artifacts,
//! commands, ATIF, token usage, compaction, tail reads, the history watch,
//! seen marks, session resolution and the agent messenger. Ported from
//! `server/src/agent/` decision for decision; what Bun's readers give is
//! what these give (held to the `contract/vectors/session-*.json` cases).

#[macro_use]
pub mod js;

pub mod artifacts;
pub mod codex_injected;
pub mod commands;
pub mod compaction;
pub mod grok;
pub mod history;
pub mod holders;
pub mod images;
pub mod messages;
pub mod paths;
pub mod rewind;
pub mod seen;
pub mod session;
pub mod shared;
pub mod tasks;
pub mod title;
pub mod token_usage;
pub mod trajectory;
pub mod utils;

#[cfg(test)]
mod vectors_tests;
