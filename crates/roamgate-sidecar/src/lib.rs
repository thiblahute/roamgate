//! The internal channel between the Bun server and the Rust core while the
//! server moves family by family (Rust migration plan, section 8.2; the
//! contract is contract/wire/core-channel.md). Temporary: deleted with the
//! Bun server at the cut-over.
//!
//! | Module | What |
//! |---|---|
//! | [`protocol`] | messages, body chunks, families and routing, the shadow comparison, the outbound queue (held to `contract/vectors/core-channel.json`) |
//! | [`node`] | the node link's preamble, calls and socket streams (contract/wire/node-link.md) |
//! | [`frames`] | the voice helper's frame codec over tokio, with the channel's 64 MiB cap |
//! | [`transport`] | the Unix socket, or the named pipe on Windows |
//! | [`peer`] | one side of the channel: handshake, calls, pushes, streamed HTTP, reverse calls, liveness |
//! | [`owners`] | the owners table, the declared families, one writer per file |
//! | [`shadow`] | sampling shadow reads, the gaming pause, shadow.jsonl |
//! | [`core`] | `roamgate core`, the process the Bun server spawns |
//! | [`family`] | what a family the core serves implements |
//! | [`standalone`] | the core with no Bun: reverse targets and pushes in its own process |

pub mod core;
pub mod family;
pub mod frames;
pub mod node;
pub mod owners;
pub mod peer;
pub mod protocol;
pub mod shadow;
pub mod standalone;
pub mod transport;
