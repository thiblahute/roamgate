//! The agent socket (review/agent-server.ts, agent-client.ts,
//! agent-remote.ts, agent-skill.ts): the review client's, the Claude mod's
//! and conversation mode's holder's way into Roamgate, HTTP over a unix
//! listener per connection. Served by the core while it owns the review
//! family ([`AgentSocket::listen`], [`AgentSocket::install_local`],
//! [`AgentSocket::stop`]); what belongs to families Bun still owns is asked
//! of an [`AgentSocketHost`].

pub mod form;
pub mod host;
pub mod output;
pub mod remote;
pub mod server;
pub mod texts;

pub use form::{Form, form_of, parse_questions, parse_target_flags};
pub use host::{AgentConnection, AgentSocketHost, HostAsk, HostError, HostFeatures};
pub use output::{session_output, thread_output};
pub use server::{
    AgentExchange, AgentSocket, AgentSocketOptions, ClaudeMods, ExchangeFn, socket_path_in,
};

/// Where the agent looks for the client and the socket, on every host.
pub const REVIEW_HOME_DIR: &str = ".cache/roamgate";

/// Whether a client sent an absolute directory: a POSIX one (SSH hosts,
/// Unix), or this machine's own on Windows (`C:\\...`), where the local
/// client runs.
pub fn is_client_dir(dir: &str) -> bool {
    dir.starts_with('/') || (cfg!(windows) && std::path::Path::new(dir).is_absolute())
}

/// The key of this host's own socket (the well-known link's target). An SSH
/// connection's socket is keyed by its connection id, so this key must be
/// one no connection id can take: ids start with a letter or a digit.
pub const LOCAL_SOCKET_KEY: &str = "@local";

/// The largest request an agent may send: comments are at most 20k chars.
pub const REVIEW_AGENT_MAX_BODY_BYTES: usize = 1024 * 1024;

/// The largest chunk of a conversation holder's log: whole lines, and one
/// line (a tool result with screenshots, say) can pass a megabyte.
pub const HOLD_OUTPUT_MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Long polls at once on one review; more are refused.
pub const REVIEW_AGENT_MAX_WATCHES: usize = 8;

#[cfg(test)]
mod tests;
