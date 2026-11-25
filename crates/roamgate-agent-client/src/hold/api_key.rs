//! The pane's Anthropic API key. Claude Code's TUI asks once whether to
//! use it and files the answer in its global config by the key's last 20
//! characters; claude -p uses it without asking. The headless claude keeps
//! it only when that answer is yes. The key itself is never sent, written
//! or shown: only the answer's state is reported.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Map, Value};

use crate::py::{self, Dumps};

pub const API_KEY: &str = "ANTHROPIC_API_KEY";
/// How long another writer's lock on the config may stand before it counts
/// as left behind (Claude Code's own: 10 s), and how long to wait for it.
const CONFIG_LOCK_STALE: Duration = Duration::from_secs(10);
const CONFIG_LOCK_WAIT: Duration = Duration::from_secs(5);

pub type Environ = BTreeMap<String, String>;

fn get<'a>(env: &'a Environ, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|v| !v.is_empty())
}

/// Claude Code's global config: ~/.claude.json, or in $CLAUDE_CONFIG_DIR.
pub fn claude_config_path(env: &Environ) -> PathBuf {
    let base = get(env, "CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(py::home);
    let suffix = if get(env, "CLAUDE_CODE_CUSTOM_OAUTH_URL").is_some() {
        "-custom-oauth"
    } else {
        ""
    };
    base.join(format!(".claude{suffix}.json"))
}

/// How Claude Code files its answer about a key; None without a key.
fn api_key_suffix(env: &Environ) -> Option<String> {
    let key = env.get(API_KEY).map(|k| k.trim()).unwrap_or("");
    if key.is_empty() {
        return None;
    }
    let chars: Vec<char> = key.chars().collect();
    Some(chars[chars.len().saturating_sub(20)..].iter().collect())
}

fn answer_lists(config: &Value) -> (Vec<String>, Vec<String>) {
    let responses = config
        .get("customApiKeyResponses")
        .and_then(Value::as_object);
    let list = |name: &str| -> Vec<String> {
        responses
            .and_then(|r| r.get(name))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    (list("approved"), list("rejected"))
}

/// {} when there is none or it cannot be read.
fn read_config(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// What Claude Code answered about the pane's API key, read again when its
/// config changes.
pub struct ApiKeyAnswers {
    pub env: Environ,
    /// What the config's file was when last read; None forces a read.
    pub seen: Option<(SystemTime, u64, u64)>,
    state: String,
}

impl ApiKeyAnswers {
    pub fn new(env: Environ) -> Self {
        Self {
            env,
            seen: None,
            state: String::new(),
        }
    }

    /// "" (no key), "approved", "rejected" or "new" (not answered yet).
    pub fn get(&mut self) -> String {
        let Some(suffix) = api_key_suffix(&self.env) else {
            return String::new();
        };
        let path = claude_config_path(&self.env);
        let seen = std::fs::metadata(&path).ok().map(|info| {
            (
                info.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                info.len(),
                inode(&info),
            )
        });
        if seen.is_some() && seen == self.seen {
            return self.state.clone();
        }
        self.seen = seen;
        let (approved, rejected) = answer_lists(&read_config(&path));
        self.state = if approved.contains(&suffix) {
            "approved"
        } else if rejected.contains(&suffix) {
            "rejected"
        } else {
            "new"
        }
        .into();
        self.state.clone()
    }
}

#[cfg(unix)]
fn inode(info: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(info)
}

#[cfg(not(unix))]
fn inode(_info: &std::fs::Metadata) -> u64 {
    0
}

/// Claude Code's own lock on its config: a directory beside it.
fn lock_config(path: &Path) -> Option<PathBuf> {
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let deadline = Instant::now() + CONFIG_LOCK_WAIT;
    loop {
        match std::fs::create_dir(&lock) {
            Ok(()) => return Some(lock),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&lock)
                    .and_then(|info| info.modified())
                    .ok()
                    .and_then(|at| SystemTime::now().duration_since(at).ok())
                    .is_some_and(|age| age > CONFIG_LOCK_STALE);
                if stale && std::fs::remove_dir(&lock).is_ok() {
                    continue;
                }
            }
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Files the user's answer as Claude Code does; true once it is there.
///
/// Only the answer is added: the rest of the config stays as it is, and it
/// is written whole or not at all. An answer there already (given in a
/// terminal meanwhile) is left alone.
pub fn record_api_key_answer(env: &Environ, approve: bool) -> bool {
    let Some(suffix) = api_key_suffix(env) else {
        return false;
    };
    let path = claude_config_path(env);
    let Some(lock) = lock_config(&path) else {
        return false;
    };
    let done = (|| {
        let mut config = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(config) => config,
                // Not ours to rewrite.
                Err(_) => return false,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
            Err(_) => return false,
        };
        let Some(object) = config.as_object_mut() else {
            return false;
        };
        let (approved, rejected) = answer_lists(&Value::Object(object.clone()));
        if approved.contains(&suffix) || rejected.contains(&suffix) {
            return true;
        }
        let mut responses = object
            .get("customApiKeyResponses")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let name = if approve { "approved" } else { "rejected" };
        let mut listed = responses
            .get(name)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        listed.push(Value::String(suffix.clone()));
        responses.insert(name.into(), Value::Array(listed));
        object.insert("customApiKeyResponses".into(), Value::Object(responses));
        let target = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let mode = file_mode(&target);
        let temp = PathBuf::from(format!(
            "{}.roamgate-{}",
            target.display(),
            uuid::Uuid::new_v4().simple()
        ));
        let text = py::dumps_with(
            &config,
            Dumps {
                indent: Some(2),
                compact: false,
                ensure_ascii: false,
            },
        );
        let written =
            write_new(&temp, text.as_bytes(), mode).and_then(|()| std::fs::rename(&temp, &target));
        if written.is_err() {
            let _ = std::fs::remove_file(&temp);
            return false;
        }
        true
    })();
    let _ = std::fs::remove_dir(&lock);
    done
}

#[cfg(unix)]
fn file_mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|info| info.permissions().mode() & 0o777)
        .unwrap_or(0o600)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> u32 {
    0o600
}

/// Creates `path` (never over another), writes and syncs it.
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}
