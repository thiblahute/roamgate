//! Roamgate's MR reviews (Rust migration plan, section 6.2): the inbox of
//! merge and pull requests, its order, pins, overrides and lanes, what is
//! inferred of one's own work, upstreaming efforts and their ledger, and
//! the reviews agent. Requests are JavaScript objects, as Bun holds them,
//! so what is written and answered is Bun's JSON text.
//!
//! | Module | Role | Replaces |
//! |---|---|---|
//! | [`shared`] | Order, search filter, merge bots and scheduled merges, keys and unread marks | shared/mrReviews*.ts |
//! | [`settings`] | The settings in effect and as settings.json keeps them | mr-reviews/settings.ts |
//! | [`fetchers`] | The forge reads the inbox asks | mr-reviews/fetchers.ts |
//! | [`agent_search`] | The reviews agent's searches, and requests as the agent names them | mr-reviews/agent-search.ts |
//! | [`inbox`] | The inbox: refresh, merge, own requests, pins, snapshot | mr-reviews/inbox.ts |
//! | [`order`] | The user's order as the server keeps it, versions and Undo | mr-reviews/order.ts |
//! | [`rpc`] | `bridge.mr_reviews.*`: checks and the inbox, order and settings methods | mr-reviews/rpc.ts |

pub mod agent_search;
pub mod connection;
pub mod curation;
pub mod efforts;
pub mod fetchers;
pub mod forge_ref;
pub mod fuzzy;
pub mod inbox;
pub mod inference;
pub mod lanes;
pub mod order;
pub mod overrides;
pub mod queries;
pub mod rpc;
pub mod settings;
pub mod shared;
pub mod store;

#[cfg(test)]
mod vectors_tests;
