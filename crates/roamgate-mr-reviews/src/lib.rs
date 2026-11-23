//! Roamgate's MR reviews (Rust migration plan, section 6.2): the inbox of
//! merge and pull requests, its order, pins, overrides and lanes, what is
//! inferred of one's own work, upstreaming efforts and their ledger, and
//! the reviews agent. Requests are JavaScript objects, as Bun holds them,
//! so what is written and answered is Bun's JSON text.
//!
//! | Module | Role | Replaces |
//! |---|---|---|
//! | [`shared`] | Order, search filter, merge bots and scheduled merges, keys and unread marks | shared/mrReviews*.ts |

pub mod connection;
pub mod curation;
pub mod efforts;
pub mod forge_ref;
pub mod fuzzy;
pub mod inference;
pub mod lanes;
pub mod overrides;
pub mod queries;
pub mod shared;
pub mod store;

#[cfg(test)]
mod vectors_tests;
