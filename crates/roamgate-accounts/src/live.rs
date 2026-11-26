//! Whether an agent runs on an account now: Roamgate must not rotate a
//! Codex chain under a running Codex (a refresh token is single use, so
//! that Codex's own later refresh would be refused as reused and its
//! session signed out).
//!
//! On Linux every process of the user is looked at: one whose environment
//! names the account's directory (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or an
//! agy account's `HOME`) runs on it, the agent or a tool it started. Where
//! another process's environment cannot be read (macOS, Windows), an
//! account Roamgate started an agent on within [`RECENT_LAUNCH_MS`] counts
//! as in use.

use std::path::Path;

use serde_json::{Map, json};

use crate::files::{read_object, state_dir, state_file, write_private};
use crate::{AccountAgent, agy_home};

/// How long after Roamgate started an agent on an account it counts as in
/// use where processes cannot be looked at.
pub const RECENT_LAUNCH_MS: i64 = 12 * 60 * 60 * 1000;

/// The variable and value that put a process on the account.
fn marker(agent: AccountAgent, dir: &Path) -> (&'static str, String) {
    match agent {
        AccountAgent::Claude => ("CLAUDE_CONFIG_DIR", dir.to_string_lossy().into_owned()),
        AccountAgent::Codex => ("CODEX_HOME", dir.to_string_lossy().into_owned()),
        AccountAgent::Agy => ("HOME", agy_home(dir).to_string_lossy().into_owned()),
    }
}

/// Notes that Roamgate starts an agent on the account now.
pub fn mark_launched(dir: &Path, now_ms: i64) {
    if let Ok(path) = state_file(dir, "launched.json") {
        let mut record = Map::new();
        record.insert("at".into(), json!(now_ms));
        let _ = write_private(&path, &record);
    }
}

fn launched_recently(dir: &Path, now_ms: i64) -> bool {
    read_object(&state_dir(dir).join("launched.json"))
        .and_then(|record| record.get("at")?.as_i64())
        .is_some_and(|at| now_ms - at < RECENT_LAUNCH_MS)
}

/// Whether a process environment (`NAME=value` entries, NUL separated)
/// puts the process on the account.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn environ_names(environ: &[u8], name: &str, values: &[String]) -> bool {
    environ.split(|byte| *byte == 0).any(|entry| {
        let Some(rest) = entry.strip_prefix(name.as_bytes()) else {
            return false;
        };
        let Some(value) = rest.strip_prefix(b"=") else {
            return false;
        };
        let value = String::from_utf8_lossy(value);
        let value = value.trim_end_matches('/');
        values
            .iter()
            .any(|wanted| wanted.trim_end_matches('/') == value)
    })
}

#[cfg(target_os = "linux")]
fn process_on(name: &str, values: &[String]) -> Option<bool> {
    let entries = std::fs::read_dir("/proc").ok()?;
    let own = std::process::id().to_string();
    Some(entries.filter_map(Result::ok).any(|entry| {
        let pid = entry.file_name();
        let pid = pid.to_string_lossy();
        if !pid.bytes().all(|byte| byte.is_ascii_digit()) || pid == own {
            return false;
        }
        std::fs::read(entry.path().join("environ"))
            .is_ok_and(|environ| environ_names(&environ, name, values))
    }))
}

#[cfg(not(target_os = "linux"))]
fn process_on(_name: &str, _values: &[String]) -> Option<bool> {
    None
}

/// Whether an agent runs on the account now (see the module).
pub fn in_use(agent: AccountAgent, dir: &Path, now_ms: i64) -> bool {
    let (name, value) = marker(agent, dir);
    let mut values = vec![value.clone()];
    if let Ok(real) = std::fs::canonicalize(&value) {
        values.push(real.to_string_lossy().into_owned());
    }
    match process_on(name, &values) {
        Some(found) => found,
        None => launched_recently(dir, now_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_environment_names_the_account_exactly() {
        let values = vec!["/d/acct".to_owned()];
        assert!(environ_names(
            b"A=1\0CODEX_HOME=/d/acct/\0",
            "CODEX_HOME",
            &values
        ));
        assert!(!environ_names(
            b"CODEX_HOME=/d/acct2\0",
            "CODEX_HOME",
            &values
        ));
        assert!(!environ_names(
            b"XCODEX_HOME=/d/acct\0",
            "CODEX_HOME",
            &values
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_running_process_on_the_account_is_seen() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!in_use(AccountAgent::Codex, &dir, 0));
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .env("CODEX_HOME", &dir)
            .spawn()
            .unwrap();
        assert!(in_use(AccountAgent::Codex, &dir, 0));
        assert!(!in_use(AccountAgent::Claude, &dir, 0));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!in_use(AccountAgent::Codex, &dir, 0));
    }

    #[test]
    fn a_recent_launch_counts_where_processes_cannot_be_read() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!launched_recently(temp.path(), 0));
        mark_launched(temp.path(), 1_000);
        assert!(launched_recently(temp.path(), 2_000));
        assert!(!launched_recently(temp.path(), 1_000 + RECENT_LAUNCH_MS));
    }
}
