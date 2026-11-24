//! Ranger, Roamgate's assistant (Rust migration plan, section 6.2): ported
//! from `server/src/assistant/` decision for decision. Values the TS keeps
//! as JavaScript objects (saved tasks, snapshots, messages) are
//! `serde_json` values in insertion order, so the JSON text either side
//! writes is the other's.

pub mod archive_tools;
pub mod claude_driver;
pub mod context;
pub mod driver;
pub mod errors;
pub mod pi_driver;
pub mod ranger_driver;
pub mod saved;
pub mod service;
pub mod task_schedule;
pub mod task_storage;
pub mod tasks;
pub mod tools;
pub mod tree_tools;
pub mod wire;

#[cfg(test)]
mod test_support;
