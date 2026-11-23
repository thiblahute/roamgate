//! Roamgate's review service (Rust migration plan, section 6.2;
//! server/src/review/*): reviews and their threads, kept in reviews.sqlite,
//! and what is built on them for browsers and agents.

pub mod js;
pub mod model;
pub mod storage;
