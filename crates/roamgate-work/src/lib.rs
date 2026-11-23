//! Roamgate's Work board (server/src/work, Rust migration plan, section
//! 6.2): its store, the board's rules and done checks, the agents' and the
//! user's tools on the catalog's tables (roamgate-claude's registry), and
//! the `bridge.work.*` RPCs. What the board asks of what it does not own
//! (the review service, Herdr, git on a connection, notifications, the
//! local history) goes through [`service::WorkDeps`].

pub mod deployed;
pub mod model;
pub mod rpc;
pub mod service;
pub mod shared;
pub mod store;
pub mod tags;
pub mod text;
pub mod tools;

pub use model::*;
pub use store::{WorkError, WorkResult, WorkStore};
