//! The internal channel between the Bun server and the Rust core while the
//! server moves family by family (Rust migration plan, section 8.2; the
//! contract is contract/wire/core-channel.md). Temporary: deleted with the
//! Bun server at the cut-over.
//!
//! | Module | What |
//! |---|---|
//! | [`protocol`] | messages, body chunks, families and routing, the shadow comparison, the outbound queue (held to `contract/vectors/core-channel.json`) |
//! | [`frames`] | the voice helper's frame codec over tokio, with the channel's 64 MiB cap |
//! | [`transport`] | the Unix socket, or the named pipe on Windows |
//! | [`peer`] | one side of the channel: handshake, calls, pushes, streamed HTTP, reverse calls, liveness |
//! | [`owners`] | the owners table, the declared families, one writer per file |
//! | [`shadow`] | sampling shadow reads, the gaming pause, shadow.jsonl |
//! | [`core`] | `roamgate core`, the process the Bun server spawns |

pub mod core;
pub mod frames;
pub mod owners;
pub mod peer;
pub mod protocol;
pub mod shadow;
pub mod transport;
