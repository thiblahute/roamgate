//! Roamgate's browser WebSocket transport (the Rust migration plan, section
//! 6.5): the `/ws` behaviour of the Bun server, from the upgrade to the
//! bytes on the wire.
//!
//! - [`upgrade`] answers the HTTP upgrade and negotiates permessage-deflate
//!   exactly as Bun's `perMessageDeflate: { compress: "dedicated",
//!   decompress: "shared" }` does.
//! - [`socket`] runs one task per socket that owns its outbound buffer, so
//!   the buffered amount is exact, and compresses message by message.
//! - [`flow`] is `websocket-send.ts`: coalescing of terminal repaints, chunk
//!   frames and acknowledgement windows, and the slow-socket rules.
//! - [`frame`] and [`deflate`] are the framing and RFC 7692 codec, on
//!   tungstenite's frame header and flate2 (zlib-rs).

pub mod deflate;
pub mod flow;
pub mod frame;
pub mod socket;
pub mod upgrade;
#[cfg(feature = "yawc")]
pub mod yawc_backend;

pub use socket::{Config, Event, SocketHandle, SocketStats, WireStats};
