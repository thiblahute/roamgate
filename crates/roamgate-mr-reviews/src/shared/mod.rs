//! The pure logic of `shared/mrReviews*.ts` the server needs, each held to
//! its vector file (plan 6.4: dual-use logic stays in TS for the web and
//! is pinned by vectors on both sides).

pub mod filter;
pub mod merge;
pub mod order;
pub mod types;
