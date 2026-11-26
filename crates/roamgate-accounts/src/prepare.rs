//! An account directory made ready for its agent: what is the account's
//! own stays there, the rest is linked to the user's own configuration
//! (a symbolic link, a junction for a directory on Windows; a copy of the
//! user's settings where neither can be made).
//!
//! Parts adapted from clauth (https://github.com/uwuclxdy/clauth, MIT
//! licence, Copyright (c) 2026 cloudy): the per-account `.claude.json`
//! keys are `PER_PROFILE_FIELDS` of its src/claude_json.rs; the link walk,
//! the stores a shared tree links (`SHARED_STORES`), the dangling link
//! pruning and the link removal follow `build_runtime_dir_with_active_env`,
//! `ensure_store_links`, `prune_dangling_links` and `unlink_link` of its
//! src/runtime.rs.

use std::io;
use std::path::{Path, PathBuf};

use roamgate_base::private::create_private_dir;
use serde_json::{Map, Value};

use crate::{AccountAgent, agy_home};

/// The user's own configuration an account shares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserDirs {
    /// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    pub claude_dir: PathBuf,
    /// Claude Code's global config: `~/.claude.json`, or in
    /// `$CLAUDE_CONFIG_DIR`.
    pub claude_json: PathBuf,
    /// `$CODEX_HOME`, else `~/.codex`.
    pub codex_home: PathBuf,
}

impl UserDirs {
    /// The user's directories for a home and an environment.
    pub fn of(home: &Path, var: &dyn Fn(&str) -> Option<String>) -> Self {
        let set = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let claude_config = set("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        Self {
            claude_dir: claude_config
                .clone()
                .unwrap_or_else(|| home.join(".claude")),
            claude_json: claude_config
                .map_or_else(|| home.join(".claude.json"), |dir| dir.join(".claude.json")),
            codex_home: set("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
        }
    }
}

/// What a preparation did, by entry name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Prepared {
    /// Linked to the user's own.
    pub linked: Vec<String>,
    /// Copied from the user's own (no link could be made).
    pub copied: Vec<String>,
    /// Left to the account (its own, or neither linked nor copied).
    pub own: Vec<String>,
}

/// How an agent's directory is shared.
struct Sharing {
    /// The account's own entries, never linked.
    own: &'static [&'static str],
    /// The user's stores made when missing so that they are linked: what
    /// the agent writes there (transcripts) lands in the user's.
    stores: &'static [&'static str],
    /// What is copied when no link can be made, and refreshed from the
    /// user's when theirs is newer.
    copied: &'static [&'static str],
}

const CLAUDE: Sharing = Sharing {
    own: &[".credentials.json", ".claude.json", ".claude.json.backup"],
    stores: &["projects", "sessions", "jobs"],
    copied: &[
        "settings.json",
        "CLAUDE.md",
        "keybindings.json",
        "agents",
        "commands",
        "hooks",
        "output-styles",
        "plugins",
        "skills",
    ],
};

const CODEX: Sharing = Sharing {
    own: &["auth.json", "models_cache.json"],
    stores: &["sessions"],
    copied: &[
        "config.toml",
        "AGENTS.md",
        ".credentials.json",
        "prompts",
        "rules",
        "skills",
    ],
};

/// The `.claude.json` keys that belong to one account (clauth's
/// `PER_PROFILE_FIELDS`): its identity, and the caches of its plan,
/// organisation and models.
const CLAUDE_JSON_OWN: &[&str] = &[
    "oauthAccount",
    "overageCreditGrantCache",
    "passesEligibilityCache",
    "passesLastSeenRemaining",
    "cachedExtraUsageDisabledReason",
    "cachedUsageUtilization",
    "cachedArtifactRoster",
    "artifactRosterDenied",
    "groveConfigCache",
    "promoStartupStatusCache",
    "metricsStatusCacheByPrincipal",
    "metricsStatusCache",
    "clientDataCacheSlots",
    "clientDataCache",
    "cachedGrowthBookFeatures",
    "cachedGrowthBookFeaturesAt",
    "cachedExperimentFeatures",
    "cachedExperimentData",
    "orgModelDefaultCache",
    "lastSeenOrgDefaultUpdatedAt",
    "modelAccessCache",
    "additionalModelCostsCache",
    "additionalModelOptionsCache",
    "additionalModelOptionsAnsweredAt",
    "githubWebConnectionStatusCache",
    "autoCompactWindowsCache",
    "startupPrefetchedAt",
    "primaryApiKey",
    "customApiKeyResponses",
];

/// Makes an account's directory ready before its agent starts: created
/// (0700), the user's shared configuration linked in. The user's own
/// directories are only ever read, but for the stores made when missing.
/// Run before each start: what the user added since is linked then.
pub fn prepare(agent: AccountAgent, dir: &Path, user: &UserDirs) -> io::Result<Prepared> {
    create_private_dir(dir)?;
    match agent {
        AccountAgent::Claude => {
            let mut prepared = share(&user.claude_dir, dir, &CLAUDE)?;
            if seed_claude_json(&user.claude_json, &dir.join(".claude.json"))? {
                prepared.copied.push(".claude.json".into());
            }
            Ok(prepared)
        }
        AccountAgent::Codex => share(&user.codex_home, dir, &CODEX),
        AccountAgent::Agy => {
            // TODO(accounts plan, Work item 315289b9, D8 and D11): an agy
            // account shares nothing with the user's home yet; its home only
            // has to exist for agy to keep its sign-in there.
            create_private_dir(&agy_home(dir))?;
            Ok(Prepared::default())
        }
    }
}

fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Removes a link, never what it points at (a directory link or junction
/// on Windows goes with `remove_dir`).
fn unlink(path: &Path) {
    if std::fs::remove_file(path).is_err() {
        let _ = std::fs::remove_dir(path);
    }
}

#[cfg(unix)]
fn link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn link(target: &Path, link: &Path) -> io::Result<()> {
    if target.is_dir() {
        // A junction needs no developer mode.
        std::os::windows::fs::symlink_dir(target, link)
            .or_else(|_| roamgate_base::junction::create(target, link))
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

#[cfg(not(any(unix, windows)))]
fn link(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no links here"))
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

fn share(user: &Path, dir: &Path, sharing: &Sharing) -> io::Result<Prepared> {
    let mut prepared = Prepared::default();
    // The user's directory inside the accounts' (a misconfiguration): there
    // is nothing of the user's to share.
    if !user.is_dir() || user.starts_with(dir) || dir.starts_with(user) {
        return Ok(prepared);
    }
    // Links whose target is gone (the user moved it away) are dropped,
    // then made again if it is back.
    for entry in std::fs::read_dir(dir)?.filter_map(Result::ok) {
        let path = entry.path();
        if is_link(&path) && !path.exists() {
            unlink(&path);
        }
    }
    for store in sharing.stores {
        let path = user.join(store);
        if std::fs::symlink_metadata(&path).is_err() {
            // A store that cannot be made stays the account's own.
            let _ = create_private_dir(&path);
        }
    }
    let mut names: Vec<String> = std::fs::read_dir(user)?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .collect();
    names.sort();
    for name in names {
        if sharing.own.contains(&name.as_str()) {
            continue;
        }
        let from = user.join(&name);
        let to = dir.join(&name);
        if is_link(&to) {
            prepared.linked.push(name);
            continue;
        }
        let copied = sharing.copied.contains(&name.as_str());
        if to.exists() {
            // A copy made before: refreshed when the user's is newer (a
            // file only; a directory copy is made once).
            if copied && to.is_file() && modified(&from) > modified(&to) {
                std::fs::copy(&from, &to)?;
                prepared.copied.push(name);
            } else {
                prepared.own.push(name);
            }
            continue;
        }
        if link(&from, &to).is_ok() {
            prepared.linked.push(name);
        } else if copied && copy_tree(&from, &to).is_ok() {
            prepared.copied.push(name);
        } else {
            prepared.own.push(name);
        }
    }
    Ok(prepared)
}

fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// Writes 0600 through a temporary file renamed into place.
fn write_private(path: &Path, value: &Map<String, Value>) -> io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    let temporary = path.with_extension("json.roamgate-tmp");
    std::fs::write(&temporary, text)?;
    roamgate_base::private::set_mode(&temporary, 0o600)?;
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// An account's `.claude.json`: on its first start, the user's without
/// what belongs to the user's account; afterwards the user's MCP servers
/// (`mcpServers`) are brought in on each start, theirs winning, the
/// account's own kept. True when it wrote.
///
/// TODO(accounts plan, Work item 315289b9, D11): the rest of the shared
/// keys (projects, settings Claude Code writes there) are not kept in
/// sync after the first start, and MCP logins (`mcpOAuth`, kept with the
/// sign-in in `.credentials.json`) are not shared.
fn seed_claude_json(user: &Path, own: &Path) -> io::Result<bool> {
    let Some(user) = read_object(user) else {
        return Ok(false);
    };
    if std::fs::symlink_metadata(own).is_err() {
        let mut seeded = user;
        for key in CLAUDE_JSON_OWN {
            seeded.shift_remove(*key);
        }
        write_private(own, &seeded)?;
        return Ok(true);
    }
    // One being written, or not JSON: left alone until the next start.
    let Some(mut current) = read_object(own) else {
        return Ok(false);
    };
    let Some(Value::Object(servers)) = user.get("mcpServers") else {
        return Ok(false);
    };
    let mut merged = match current.get("mcpServers") {
        Some(Value::Object(mine)) => mine.clone(),
        _ => Map::new(),
    };
    for (name, server) in servers {
        merged.insert(name.clone(), server.clone());
    }
    if current.get("mcpServers") == Some(&Value::Object(merged.clone())) {
        return Ok(false);
    }
    current.insert("mcpServers".into(), Value::Object(merged));
    write_private(own, &current)?;
    Ok(true)
}
