//! Ranger, Roamgate's assistant (Rust migration plan, section 6.2): ported
//! from `server/src/assistant/` decision for decision. Values the TS keeps
//! as JavaScript objects (saved tasks, snapshots, messages) are
//! `serde_json` values in insertion order, so the JSON text either side
//! writes is the other's.

pub mod errors;
pub mod saved;
pub mod task_schedule;
pub mod task_storage;
pub mod wire;
