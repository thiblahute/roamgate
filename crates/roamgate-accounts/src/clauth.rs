//! Moving from clauth: what `~/.clauth` holds (its profiles, their chain
//! and settings, whether each is signed in) and its import as account
//! profiles. Nothing under `~/.clauth` is ever written or removed.
//!
//! The layout is clauth's (https://github.com/uwuclxdy/clauth, MIT
//! licence, Copyright (c) 2026 cloudy): `profiles.toml` (`active_profile`,
//! `profiles`, `fallback_chain`, `walk_order`), `codex-profiles.toml`
//! (`profiles`, `fallback_chain`), and per profile `profiles/<name>/`
//! with `config.toml` (`fallback_threshold`, `weekly_threshold`,
//! `preferred`, `preferred_days`, `last_resort`, `base_url`, `harness`)
//! and its sign-in: `credentials.json` (Claude Code's format) or, for a
//! Codex profile, `auth.json`. Its daemon's pid is in `clauthd.pid`.
//!
//! While clauth runs, two managers must never refresh one OAuth chain (D9):
//! an imported account's sign-in is a link to clauth's own file, which
//! Roamgate only reads (never refreshes, signs out or rewrites) until the
//! user takes it over.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::files::{read_object, state_dir, state_file, write_private, write_private_bytes};
use crate::{AccountAgent, account_dir};

/// One clauth profile, as an import offers it (no secret).
#[derive(Clone, Debug, PartialEq)]
pub struct ClauthAccount {
    pub name: String,
    /// `claude` or `codex`.
    pub agent: AccountAgent,
    /// Signed in in clauth (a sign-in file with a refresh token).
    pub signed_in: bool,
    /// An API-key endpoint profile: not an account, not imported.
    pub api_key: bool,
    pub fallback_threshold: Option<f64>,
    pub weekly_threshold: Option<f64>,
    pub preferred: bool,
    /// 0 (Sunday) to 6.
    pub preferred_days: Vec<u8>,
    pub last_resort: bool,
    /// clauth's own file holding its sign-in.
    pub credentials: PathBuf,
}

/// What `~/.clauth` holds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClauthScan {
    pub dir: PathBuf,
    /// Claude profiles first, then Codex ones.
    pub accounts: Vec<ClauthAccount>,
    /// clauth's chain: Claude's `fallback_chain`, then Codex's.
    pub chain: Vec<String>,
    /// `active_profile`.
    pub active: Option<String>,
    /// `walk_order`, as Roamgate names it.
    pub walk: Option<&'static str>,
    pub daemon_running: bool,
}

fn read_toml(path: &Path) -> Option<toml::Table> {
    std::fs::read_to_string(path)
        .ok()?
        .parse::<toml::Table>()
        .ok()
}

fn strings(table: &toml::Table, key: &str) -> Vec<String> {
    table
        .get(key)
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn number(table: &toml::Table, key: &str) -> Option<f64> {
    let value = table.get(key)?;
    value
        .as_float()
        .or_else(|| value.as_integer().map(|n| n as f64))
}

/// A day as chrono reads it (full or three-letter name, any case).
fn weekday(name: &str) -> Option<u8> {
    let name = name.trim().to_lowercase();
    ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        .iter()
        .position(|day| name == *day || (name.len() > 3 && name.starts_with(day)))
        .map(|day| day as u8)
}

/// Whether the daemon named in `clauthd.pid` runs (Linux: its /proc entry;
/// elsewhere the file being there counts).
fn daemon_running(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("clauthd.pid")) else {
        return false;
    };
    let Ok(pid) = text.trim().parse::<u32>() else {
        return false;
    };
    if cfg!(target_os = "linux") {
        Path::new("/proc").join(pid.to_string()).exists()
    } else {
        true
    }
}

/// Whether a sign-in file holds a refresh token (never read further).
fn holds_sign_in(path: &Path, agent: AccountAgent) -> bool {
    let Some(file) = read_object(path) else {
        return false;
    };
    let token = match agent {
        AccountAgent::Codex => file.get("tokens").and_then(|t| t.get("refresh_token")),
        _ => file
            .get("claudeAiOauth")
            .and_then(|oauth| oauth.get("refreshToken")),
    };
    token
        .and_then(Value::as_str)
        .is_some_and(|token| !token.is_empty())
}

fn account(dir: &Path, name: &str, agent: AccountAgent) -> ClauthAccount {
    let profile = dir.join("profiles").join(name);
    let config = read_toml(&profile.join("config.toml")).unwrap_or_default();
    let agent = match config.get("harness").and_then(toml::Value::as_str) {
        Some("codex") => AccountAgent::Codex,
        _ => agent,
    };
    let credentials = profile.join(match agent {
        AccountAgent::Codex => "auth.json",
        _ => "credentials.json",
    });
    let flag = |key: &str| {
        config
            .get(key)
            .and_then(toml::Value::as_bool)
            .unwrap_or(false)
    };
    let mut days = Vec::new();
    for day in strings(&config, "preferred_days")
        .iter()
        .filter_map(|day| weekday(day))
    {
        if !days.contains(&day) {
            days.push(day);
        }
    }
    ClauthAccount {
        name: name.to_owned(),
        agent,
        signed_in: holds_sign_in(&credentials, agent),
        api_key: config.get("base_url").is_some() || config.get("api_key").is_some(),
        fallback_threshold: number(&config, "fallback_threshold"),
        weekly_threshold: number(&config, "weekly_threshold"),
        preferred: flag("preferred"),
        preferred_days: days,
        last_resort: flag("last_resort"),
        credentials,
    }
}

/// What `<home>/.clauth` holds; None when there is no clauth.
pub fn scan(home: &Path) -> Option<ClauthScan> {
    let dir = home.join(".clauth");
    let state = read_toml(&dir.join("profiles.toml"));
    let codex = read_toml(&dir.join("codex-profiles.toml"));
    if state.is_none() && codex.is_none() {
        return None;
    }
    let state = state.unwrap_or_default();
    let codex = codex.unwrap_or_default();
    let mut accounts = Vec::new();
    for name in strings(&state, "profiles") {
        accounts.push(account(&dir, &name, AccountAgent::Claude));
    }
    for name in strings(&codex, "profiles") {
        if !accounts.iter().any(|each| each.name == name) {
            accounts.push(account(&dir, &name, AccountAgent::Codex));
        }
    }
    let mut chain = strings(&state, "fallback_chain");
    chain.extend(strings(&codex, "fallback_chain"));
    chain.retain(|name| {
        accounts
            .iter()
            .any(|each| &each.name == name && !each.api_key)
    });
    let walk = match state.get("walk_order").and_then(toml::Value::as_str) {
        Some("soonest-weekly-reset") => Some("soonest_reset"),
        Some("most-weekly-headroom") => Some("most_headroom"),
        Some("chain") => Some("chain"),
        _ => None,
    };
    Some(ClauthScan {
        daemon_running: daemon_running(&dir),
        active: state
            .get("active_profile")
            .and_then(toml::Value::as_str)
            .map(str::to_owned),
        dir,
        accounts,
        chain,
        walk,
    })
}

/// Whether `<home>/.gemini` holds the user's own agy (its sign-in is never
/// read).
pub fn default_agy(home: &Path) -> bool {
    home.join(".gemini").join("antigravity-cli").is_dir()
}

/// An account id for a clauth profile's name, unique among `taken`.
pub fn account_id_for(name: &str, taken: &[String]) -> String {
    let mut id: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    id = id.trim_matches('-').to_owned();
    if id.is_empty() || !id.as_bytes()[0].is_ascii_alphanumeric() {
        id.insert_str(0, "clauth-");
    }
    id.truncate(36);
    let mut unique = id.clone();
    let mut n = 2;
    while taken.contains(&unique) {
        unique = format!("{id}-{n}");
        n += 1;
    }
    unique
}

/// The sign-in file of an account's agent.
fn sign_in_name(agent: AccountAgent) -> &'static str {
    match agent {
        AccountAgent::Codex => "auth.json",
        _ => ".credentials.json",
    }
}

#[cfg(unix)]
fn link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn link(target: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(not(any(unix, windows)))]
fn link(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no links here"))
}

/// Makes an imported account's sign-in clauth's own: a link to its file,
/// and the record that clauth manages it. Fails where no link can be
/// made: a copy would be a second manager of the chain.
pub fn link_sign_in(data_root: &Path, account: &ClauthAccount, id: &str) -> io::Result<PathBuf> {
    let dir = account_dir(data_root, account.agent, id);
    roamgate_base::private::create_private_dir(&dir)?;
    let target = dir.join(sign_in_name(account.agent));
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "the account already has a sign-in of its own",
        ));
    }
    link(&account.credentials, &target)?;
    let mut record = Map::new();
    record.insert("profile".into(), json!(account.name));
    record.insert("file".into(), json!(account.credentials.to_string_lossy()));
    write_private(&state_file(&dir, "clauth.json")?, &record)?;
    Ok(dir)
}

/// The clauth profile whose sign-in an account reads, when clauth manages
/// it.
pub fn managed_by_clauth(dir: &Path) -> Option<String> {
    read_object(&state_dir(dir).join("clauth.json"))?
        .get("profile")?
        .as_str()
        .map(str::to_owned)
}

/// Takes an account's sign-in over from clauth: its link becomes a copy of
/// what clauth's file holds now, Roamgate's own from then on (clauth must
/// stop managing that profile). clauth's file is left as it is.
pub fn take_over(dir: &Path, agent: AccountAgent) -> io::Result<()> {
    if managed_by_clauth(dir).is_none() {
        return Ok(());
    }
    let target = dir.join(sign_in_name(agent));
    let bytes = std::fs::read(&target)?;
    // The link itself goes, never what it names.
    std::fs::remove_file(&target)?;
    write_private_bytes(&target, &bytes)?;
    std::fs::remove_file(state_dir(dir).join("clauth.json"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `~/.clauth` as clauth leaves it (the shapes of 2026-11-26).
    fn fake_clauth(home: &Path) -> PathBuf {
        let dir = home.join(".clauth");
        let write = |path: &str, text: &str| {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "profiles.toml",
            "active_profile = \"work\"\nprofiles = [\n    \"work\",\n    \"perso\",\n    \"glm\",\n]\nfallback_chain = [\n    \"perso\",\n    \"work\",\n]\nwrap_off = false\nwalk_order = \"most-weekly-headroom\"\nrefresh_interval_ms = 90000\n\n[herdr]\npane_tag = true\n",
        );
        write(
            "codex-profiles.toml",
            "profiles = [\"codex\"]\nfallback_chain = []\nwrap_off = false\n\n[ids]\ncodex = \"7db4e3d882da4bc0cfea262d3073922a\"\n",
        );
        write(
            "profiles/work/config.toml",
            "# clauth profile configuration\n# base_url = \"https://api.anthropic.com\"\nfallback_threshold = 90\npreferred = true\npreferred_days = [\"Sun\", \"saturday\", \"xyz\"]\n",
        );
        write(
            "profiles/work/credentials.json",
            r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"scopes":[],"subscriptionType":"max"},"mcpOAuth":{}}"#,
        );
        write(
            "profiles/perso/config.toml",
            "fallback_threshold = 95\nweekly_threshold = 97.5\nlast_resort = true\n",
        );
        write(
            "profiles/glm/config.toml",
            "base_url = \"https://gw.example\"\napi_key = \"k\"\n",
        );
        write("profiles/codex/config.toml", "harness = \"codex\"\n");
        write(
            "profiles/codex/auth.json",
            r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"i","access_token":"a","refresh_token":"r","account_id":"x"},"last_refresh":"2026-11-26T00:00:00Z"}"#,
        );
        write("clauthd.pid", &format!("{}\n", std::process::id()));
        dir
    }

    #[test]
    fn clauth_s_profiles_chain_and_settings_are_read() {
        let temp = tempfile::tempdir().unwrap();
        let dir = fake_clauth(temp.path());
        let found = scan(temp.path()).unwrap();
        assert_eq!(found.dir, dir);
        assert_eq!(found.active.as_deref(), Some("work"));
        assert_eq!(found.chain, ["perso", "work"]);
        assert_eq!(found.walk, Some("most_headroom"));
        if cfg!(target_os = "linux") {
            assert!(found.daemon_running);
        }
        let names: Vec<_> = found
            .accounts
            .iter()
            .map(|a| (a.name.as_str(), a.agent, a.signed_in, a.api_key))
            .collect();
        assert_eq!(
            names,
            [
                ("work", AccountAgent::Claude, true, false),
                ("perso", AccountAgent::Claude, false, false),
                ("glm", AccountAgent::Claude, false, true),
                ("codex", AccountAgent::Codex, true, false),
            ]
        );
        let work = &found.accounts[0];
        assert_eq!(work.fallback_threshold, Some(90.0));
        assert!(work.preferred);
        assert_eq!(work.preferred_days, [0, 6]);
        let perso = &found.accounts[1];
        assert_eq!(perso.weekly_threshold, Some(97.5));
        assert!(perso.last_resort);
        assert!(scan(&temp.path().join("nobody")).is_none());
    }

    #[test]
    fn an_import_links_clauth_s_sign_in_and_a_take_over_copies_it() {
        let temp = tempfile::tempdir().unwrap();
        fake_clauth(temp.path());
        let found = scan(temp.path()).unwrap();
        let data = temp.path().join("data");
        let work = &found.accounts[0];
        let before = std::fs::read(&work.credentials).unwrap();
        let dir = link_sign_in(&data, work, "work").unwrap();
        assert_eq!(managed_by_clauth(&dir).as_deref(), Some("work"));
        if cfg!(unix) {
            assert_eq!(
                std::fs::read_link(dir.join(".credentials.json")).unwrap(),
                work.credentials
            );
        }
        assert!(link_sign_in(&data, work, "work").is_err());
        take_over(&dir, AccountAgent::Claude).unwrap();
        assert!(managed_by_clauth(&dir).is_none());
        let own = dir.join(".credentials.json");
        assert!(
            !std::fs::symlink_metadata(&own)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read(&own).unwrap(), before);
        // clauth's own file is never touched.
        assert_eq!(std::fs::read(&work.credentials).unwrap(), before);
    }

    #[test]
    fn ids_come_from_names() {
        assert_eq!(account_id_for("Work", &[]), "work");
        assert_eq!(account_id_for("My Max!", &[]), "my-max");
        assert_eq!(account_id_for("work", &["work".into()]), "work-2");
        assert_eq!(account_id_for("__", &[]), "clauth-__");
    }
}
