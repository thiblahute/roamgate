//! The relay an SSH tunnel runs on the host in front of Herdr's control
//! socket (bridge/herdr-relay.ts).
//!
//! Herdr reads a control connection's request without blocking and, when
//! nothing has arrived yet, sleeps 100 ms before it looks again. Through an
//! ssh `-L` forward the request is never there at first: sshd connects to
//! the socket when the channel opens and the request follows a round trip
//! later, so every call waited the full 100 ms. The relay
//! (contract/assets/python/herdr-relay.py) listens on a socket of its own,
//! reads the request line first and only then connects to Herdr and writes
//! it. It runs as the tunnel's remote command, prints [`HERDR_RELAY_READY`]
//! once it listens, and exits, removing its socket, when the tunnel's
//! session ends (its stdin closes).

use roamgate_base::assets::HERDR_RELAY_PY;

use super::sessions::any_shell_quote;

/// The line the relay prints once its socket listens.
pub const HERDR_RELAY_READY: &str = "roamgate-herdr-relay ready";

/// Socket file names of relays, in the host's Roamgate cache directory.
pub const HERDR_RELAY_SOCKET_PREFIX: &str = "herdr-relay-";

/// Where relays listen, under the host's HOME.
pub const HERDR_RELAY_DIRECTORY: &str = ".cache/roamgate";

/// The relay's Python, written without single quotes or backslashes so it
/// quotes alike in sh, bash, zsh and fish.
pub const HERDR_RELAY_SCRIPT: &str = HERDR_RELAY_PY;

// Unix socket paths are limited to 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH_BYTES: usize = 100;

/// One tunnel's relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrRelay {
    /// The relay's socket on the host: the tunnel's control forward target.
    pub socket: String,
    /// The tunnel's remote command, run by the host's login shell.
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("herdr relay token must be alphanumeric")]
pub struct InvalidRelayToken;

/// The relay for one tunnel, or None when its socket path would be too long
/// for the host. `token` keeps two tunnels to the same host apart.
pub fn herdr_relay(
    home: &str,
    herdr_socket: &str,
    token: &str,
) -> Result<Option<HerdrRelay>, InvalidRelayToken> {
    if token.is_empty() || token.len() > 32 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(InvalidRelayToken);
    }
    let socket = format!(
        "{}/{HERDR_RELAY_DIRECTORY}/{HERDR_RELAY_SOCKET_PREFIX}{token}.sock",
        home.trim_end_matches('/')
    );
    if !socket.starts_with('/')
        || !herdr_socket.starts_with('/')
        || socket.len() > MAX_SOCKET_PATH_BYTES
        || socket.contains(['\0', '\n'])
        || herdr_socket.contains(['\0', '\n'])
    {
        return Ok(None);
    }
    let command = format!(
        "exec python3 -c {} {} {}",
        any_shell_quote(HERDR_RELAY_SCRIPT),
        any_shell_quote(herdr_socket),
        any_shell_quote(&socket)
    );
    Ok(Some(HerdrRelay { socket, command }))
}

/// A token for a relay's socket: 16 hex digits, different per call (the
/// process's random hash keys over a counter).
pub fn random_relay_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests;
