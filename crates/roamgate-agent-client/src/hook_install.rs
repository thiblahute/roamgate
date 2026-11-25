//! Adds the Claude start hook to Claude's user settings unless it is
//! there, as contract/assets/python/claude-start-hook-install.py does on
//! SSH hosts: the user's own hooks and settings are kept as they are.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::py::{self, Dumps};

/// What the hook runs; also how Roamgate finds its own entry.
pub const COMMAND: &str = "~/.cache/roamgate/bin/roamgate-review claude-start";
/// What marks Roamgate's hook among the user's.
pub const MARK: &str = "roamgate-review claude-start";

/// What the installer did: installed, present, no-claude, invalid or
/// unwritable (the word the Python installer prints).
pub fn install(claude_dir: &Path) -> &'static str {
    if !claude_dir.is_dir() {
        return "no-claude";
    }
    let path = claude_dir.join("settings.json");
    let (text, mode) = match std::fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => (text, file_mode(&path)),
            Err(_) => return "invalid",
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (String::new(), 0o600),
        Err(_) => return "invalid",
    };
    let mut settings = if text.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(_) => return "invalid",
        }
    };
    let Some(settings_map) = settings.as_object_mut() else {
        return "invalid";
    };
    let hooks = settings_map
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(hooks) = hooks.as_object_mut() else {
        return "invalid";
    };
    let groups = hooks
        .entry("SessionStart")
        .or_insert_with(|| Value::Array(vec![]));
    let Some(groups) = groups.as_array_mut() else {
        return "invalid";
    };
    let present = groups.iter().any(|group| {
        group_hooks(group).iter().any(|hook| {
            hook.as_object()
                .and_then(|hook| hook.get("command"))
                .is_some_and(|command| command_text(command).contains(MARK))
        })
    });
    if present {
        return "present";
    }
    groups.push(json!({
        "matcher": "startup|resume",
        "hooks": [{"type": "command", "command": COMMAND, "timeout": 10}],
    }));
    let mut text = py::dumps_with(
        &settings,
        Dumps {
            indent: Some(2),
            compact: false,
            ensure_ascii: true,
        },
    );
    text.push('\n');
    if write_replacing(claude_dir, &path, text.as_bytes(), mode).is_err() {
        return "unwritable";
    }
    "installed"
}

/// `(group.get("hooks") or [])` of a group that is an object.
fn group_hooks(group: &Value) -> Vec<Value> {
    match group.as_object().and_then(|group| group.get("hooks")) {
        Some(Value::Array(items)) => items.clone(),
        // Iterating an object gives its keys, a string its characters:
        // none of them is a hook.
        _ => vec![],
    }
}

/// `str(hook.get("command") or "")`.
fn command_text(command: &Value) -> String {
    match command {
        Value::String(text) => text.clone(),
        Value::Null | Value::Bool(false) => String::new(),
        other => py::dumps(other),
    }
}

/// Claude's user directory: `$CLAUDE_CONFIG_DIR`, else `HOME/.claude`.
pub fn claude_dir(home: &Path, config_dir: Option<&str>) -> PathBuf {
    match config_dir.filter(|dir| !dir.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => home.join(".claude"),
    }
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

/// Writes a temporary file beside it (`.settings.*`), gives it `mode`,
/// then puts it in place in one step.
fn write_replacing(dir: &Path, path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    let mut temp = tempfile::Builder::new()
        .prefix(".settings.")
        .tempfile_in(dir)?;
    temp.write_all(bytes)?;
    temp.flush()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}
