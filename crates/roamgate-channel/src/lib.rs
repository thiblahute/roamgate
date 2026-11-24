//! The internal channel between the server's two processes (contract is
//! contract/wire/core-channel.md): the front (`roamgate [server flags]`,
//! the port, auth, static files and the browser sockets' framing) and the
//! portless core it spawns (`roamgate core`, every family).
//!
//! | Module | What |
//! |---|---|
//! | [`protocol`] | messages, body chunks, the family of a method or path, the outbound queue (held to `contract/vectors/core-channel.json`) |
//! | [`node`] | the node link's preamble, calls and socket streams (contract/wire/node-link.md) |
//! | [`frames`] | the voice helper's frame codec over tokio, with the channel's 64 MiB cap |
//! | [`transport`] | the Unix socket, or the named pipe on Windows |
//! | [`peer`] | one side of the channel: handshake, calls, pushes, streamed HTTP, reverse calls, liveness |
//! | [`declared`] | the declared families (contract/wire/families.json), one writer per file |
//! | [`core`] | `roamgate core`, the process the front spawns |
//! | [`family`] | what a family the core serves implements |
//! | [`standalone`] | what the core answers in its own process: reverse targets, pushes, a family's call to another |

pub mod core;
pub mod declared;
pub mod family;
pub mod frames;
pub mod node;
pub mod peer;
pub mod protocol;
pub mod standalone;
pub mod transport;
