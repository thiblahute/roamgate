//! Agent accounts. An account profile (a profile with `account: {id}`) is
//! one sign-in of an agent: its agent starts with a configuration
//! directory of its own, `<data>/accounts/<agent>/<id>/`, which holds that
//! sign-in and the agent's per-account identity. The rest (settings,
//! plugins, skills, transcripts, MCP server definitions) stays shared with
//! the user's own configuration: [`prepare`] links it in.
//!
//! - Claude Code: `CLAUDE_CONFIG_DIR=<dir>`. `.credentials.json` and
//!   `.claude.json` are the account's own; every other entry of the user's
//!   `~/.claude` is linked.
//! - Codex: `CODEX_HOME=<dir>`. `auth.json` is the account's own; every
//!   other entry of the user's `~/.codex` is linked.
//! - Antigravity (`agy`): `HOME=<dir>/home`, with the D-Bus session bus
//!   hidden, so that `agy` keeps its sign-in in its own file token store
//!   under that home instead of the keyring entry every home shares.
//!   Roamgate never reads, writes or sends an `agy` token: it only chooses
//!   the environment `agy` starts with.

use std::path::{Path, PathBuf};

use roamgate_base::env::Env;
use roamgate_base::paths::{DataContext, Platform};
pub use roamgate_base::settings::sections::account_id_valid;

pub mod agy_auth;
pub mod claude_auth;
pub mod codex_auth;
mod files;
pub mod json_sync;
mod logins;
pub mod mcp_sync;
mod oauth;
mod prepare;
#[cfg(test)]
mod test_server;

pub use files::fingerprint;
pub use logins::{Logins, Started, maintain};
pub use oauth::{Endpoints, Http};
pub use prepare::{Prepared, UserDirs, prepare};

/// An agent an account profile can sign in to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AccountAgent {
    Claude,
    Codex,
    Agy,
}

impl AccountAgent {
    pub const ALL: [Self; 3] = [Self::Claude, Self::Codex, Self::Agy];

    /// A profile's `agent`.
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|agent| agent.id() == id)
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Agy => "agy",
        }
    }
}

/// Whether an account's sign-in is there, as far as Roamgate can tell
/// without reading it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthState {
    /// Roamgate cannot tell (an `agy` account, a Claude account on macOS,
    /// whose sign-in is in the Keychain).
    Unknown,
    SignedIn,
    SignedOut,
    /// Signed in once, but the sign-in no longer works.
    NeedsRelogin,
}

impl AuthState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::SignedIn => "signed_in",
            Self::SignedOut => "signed_out",
            Self::NeedsRelogin => "needs_relogin",
        }
    }
}

/// The directory every account lives under: `<data>/accounts`.
pub fn accounts_root(data_root: &Path) -> PathBuf {
    data_root.join("accounts")
}

/// An account's own directory: `<data>/accounts/<agent>/<id>`.
pub fn account_dir(data_root: &Path, agent: AccountAgent, id: &str) -> PathBuf {
    accounts_root(data_root).join(agent.id()).join(id)
}

/// The account directories of an agent on disk, in name order: those of
/// the profiles there are, and of those removed since (their sessions
/// stay findable).
pub fn account_dirs(data_root: &Path, agent: AccountAgent) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(accounts_root(data_root).join(agent.id())) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_str().is_some_and(account_id_valid) && entry.path().is_dir()
        })
        .map(|entry| entry.path())
        .collect();
    dirs.sort();
    dirs
}

/// The home an `agy` account runs with: `<dir>/home`.
pub fn agy_home(dir: &Path) -> PathBuf {
    dir.join("home")
}

/// What an account sets and removes in its agent's environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchEnv {
    pub set: Vec<(String, String)>,
    pub unset: Vec<String>,
}

/// The environment an account's agent starts with. The variables that
/// would sign it in some other way (an API key, a token) are removed: the
/// account's own sign-in is what it runs on.
pub fn launch_env(agent: AccountAgent, dir: &Path) -> LaunchEnv {
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let names = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect();
    match agent {
        AccountAgent::Claude => LaunchEnv {
            set: vec![("CLAUDE_CONFIG_DIR".into(), text(dir))],
            unset: names(&[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ]),
        },
        AccountAgent::Codex => LaunchEnv {
            set: vec![("CODEX_HOME".into(), text(dir))],
            unset: names(&["CODEX_API_KEY", "OPENAI_API_KEY"]),
        },
        AccountAgent::Agy => {
            let home = agy_home(dir);
            let mut set = vec![("HOME".to_owned(), text(&home))];
            if cfg!(windows) {
                set.push(("USERPROFILE".into(), text(&home)));
            } else {
                // agy's token store falls back to a file in its home when the
                // keyring cannot be reached; an unset address would let D-Bus
                // find the session bus by itself, so it names one that is not
                // there.
                set.push((
                    "DBUS_SESSION_BUS_ADDRESS".into(),
                    format!("unix:path={}", text(&home.join(".no-session-bus"))),
                ));
            }
            for (name, under) in [
                ("XDG_CONFIG_HOME", ".config"),
                ("XDG_DATA_HOME", ".local/share"),
                ("XDG_STATE_HOME", ".local/state"),
                ("XDG_CACHE_HOME", ".cache"),
            ] {
                set.push((name.into(), text(&home.join(under))));
            }
            LaunchEnv {
                set,
                unset: names(&[
                    "ANTIGRAVITY_CONVERSATIONS_DIR",
                    "ANTIGRAVITY_HOME",
                    "GEMINI_HOME",
                ]),
            }
        }
    }
}

/// An account's sign-in state: from its credentials for Claude and Codex
/// (a refused refresh token is `needs_relogin`), from `agy`'s own last
/// answer for `agy`.
pub fn auth_state(agent: AccountAgent, dir: &Path) -> AuthState {
    match agent {
        // Claude Code keeps a macOS sign-in in the Keychain, not the file.
        AccountAgent::Claude if cfg!(target_os = "macos") => match claude_auth::auth_state(dir) {
            AuthState::SignedIn => AuthState::SignedIn,
            _ => AuthState::Unknown,
        },
        AccountAgent::Claude => claude_auth::auth_state(dir),
        AccountAgent::Codex => codex_auth::auth_state(dir),
        AccountAgent::Agy => agy_auth::auth_state(dir),
    }
}

/// `dir/name` when it is a directory of the account's own, not a link to
/// the user's (whose files are found where the user's are).
fn own_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let path = dir.join(name);
    std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.is_dir())
        .then_some(path)
}

/// The session roots the accounts of an agent keep apart from the user's
/// own: Claude's `projects` and Codex's `sessions` that could not be
/// linked to the user's, and every `agy` account's conversations.
pub fn session_roots(data_root: &Path, agent: AccountAgent) -> Vec<PathBuf> {
    account_dirs(data_root, agent)
        .into_iter()
        .filter_map(|dir| match agent {
            AccountAgent::Claude => own_dir(&dir, "projects"),
            AccountAgent::Codex => own_dir(&dir, "sessions"),
            AccountAgent::Agy => {
                let root = agy_conversations_root(&dir);
                root.is_dir().then_some(root)
            }
        })
        .collect()
}

/// The Codex session directories (`sessions`, `archived_sessions`) of
/// every account that keeps its own.
pub fn codex_session_dirs(data_root: &Path) -> Vec<PathBuf> {
    account_dirs(data_root, AccountAgent::Codex)
        .into_iter()
        .flat_map(|dir| {
            ["sessions", "archived_sessions"]
                .into_iter()
                .filter_map(move |name| own_dir(&dir, name))
        })
        .collect()
}

/// Where an `agy` account's conversations are: its home's
/// `~/.gemini/antigravity-cli/conversations`.
pub fn agy_conversations_root(dir: &Path) -> PathBuf {
    agy_home(dir)
        .join(".gemini")
        .join("antigravity-cli")
        .join("conversations")
}

struct Vars<'a>(&'a (dyn Fn(&str) -> Option<String> + Send + Sync));

impl Env for Vars<'_> {
    fn var(&self, name: &str) -> Option<String> {
        (self.0)(name)
    }
}

/// Roamgate's data root for a home and an environment: what
/// [`DataContext::data_root`] gives a process with them.
pub fn data_root_of(home: &Path, var: &(dyn Fn(&str) -> Option<String> + Send + Sync)) -> PathBuf {
    let vars = Vars(var);
    DataContext {
        home: home.to_path_buf(),
        platform: Platform::current(),
        app_data: vars
            .var("APPDATA")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from),
        root: roamgate_base::node::data_root(&vars),
    }
    .data_root()
}

#[cfg(test)]
mod tests;
