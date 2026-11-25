//! Node mode (`roamgate node --listen`): a machine's node serves its own
//! connection beside the home (the desktop), which keeps every shared
//! store and job. The node's processes carry [`NODE_HOME_ENV`] (the
//! home's origin), and [`DATA_ROOT_ENV`] names their own data root, so
//! nothing they write is the home-style `~/.config/roamgate`.

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::env::Env;

/// The home's origin (`https://host`), set on a node's front and core.
pub const NODE_HOME_ENV: &str = "ROAMGATE_NODE_HOME";

/// The data root that replaces `<config>/roamgate`, set on a node's
/// processes (its config directory).
pub const DATA_ROOT_ENV: &str = "ROAMGATE_DATA_ROOT";

/// The error code of a call a node leaves to its home.
pub const SERVED_BY_HOME: &str = "served_by_home";

/// The connection id of a node's one connection: the id the home's
/// profile for this machine has, so ids match on both sockets.
pub const NODE_CONNECTION_ID: &str = "local";

/// The home's origin when `env` is a node's.
pub fn home(env: &dyn Env) -> Option<String> {
    env.var(NODE_HOME_ENV).filter(|home| !home.is_empty())
}

/// The data root `env` names, when it names one.
pub fn data_root(env: &dyn Env) -> Option<PathBuf> {
    env.var(DATA_ROOT_ENV)
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
}

/// This process is a node's: read once from the process environment.
pub fn active() -> bool {
    process_home().is_some()
}

/// The home's origin of this process, when it is a node's.
pub fn process_home() -> Option<&'static str> {
    static HOME: OnceLock<Option<String>> = OnceLock::new();
    HOME.get_or_init(|| home(&crate::env::ProcessEnv))
        .as_deref()
}

/// The message of a refused call.
pub fn served_by_home_message(what: &str) -> String {
    match process_home() {
        Some(home) => format!("{what} is served by the home ({home}), not this node"),
        None => format!("{what} is served by the home, not this node"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_is_named_by_its_home() {
        assert_eq!(home(&[(NODE_HOME_ENV, "")]), None);
        assert_eq!(
            home(&[(NODE_HOME_ENV, "https://home.example")]).as_deref(),
            Some("https://home.example")
        );
        assert_eq!(data_root(&[(DATA_ROOT_ENV, "")]), None);
        assert_eq!(
            data_root(&[(DATA_ROOT_ENV, "/n")]),
            Some(PathBuf::from("/n"))
        );
    }
}
