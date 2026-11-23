//! Herdr's own wire types for the parity suite's fake Herdr.
//!
//! `api` is Herdr's control API (`src/api/schema*` of Herdr at the version in
//! `HERDR_VERSION`, copied by `vendor.sh`, unchanged but for the paths into
//! the rest of Herdr, which `compat` provides). `wire` holds the handshake of
//! Herdr's client socket from `src/protocol/wire.rs`.
//!
//! Herdr is Apache-2.0 licensed; see LICENSE in this directory.

#![allow(dead_code, clippy::all)]

pub mod compat;
#[rustfmt::skip]
pub mod endpoint;
#[rustfmt::skip]
pub mod surface;
pub mod wire;

#[rustfmt::skip]
pub mod schema;

/// Herdr's control API (`src/api/schema*` in Herdr).
pub use schema as api;

/// The Herdr release these types come from.
pub const HERDR_VERSION: &str = "0.9.4";
