//! `SettingsStore`, the one owner of settings.json (config/gui-settings.ts,
//! the interface preferences of ui-settings and the overlay tabs of
//! overlay-tabs.ts): reads it once, normalises it as the Bun server does,
//! serialises updates (read, change and write under one slot, so a
//! background status update never overwrites a toggle an RPC just made),
//! writes it as `JSON.stringify(settings, null, 2)` plus a newline through
//! a temporary file renamed over it (0600), and broadcasts each change.
//!
//! Normalising keeps the TS shape and key order, held to
//! contract/vectors/settings.json: every section is normalised as
//! `normalizeGuiSettings` does, those whose rules belong to a family not
//! ported yet with their TS rules in [`sections`]; keys the TS type does
//! not have are dropped, as `normalizeGuiSettings` drops them.

use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::env::{Env, roamgate_env};
use crate::json_store::{JsonFormat, to_js_json};
use crate::paths::{DataContext, DataFile, dirname};
use crate::private::{create_dir_all_mode, set_file_mode};

pub mod sections;

/// The connection id of the single connection before connections existed.
pub const LEGACY_DEFAULT_CONNECTION_ID: &str = "legacy-default";
pub const DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES: i64 = 10;
pub const WORKTREE_COMMAND_MAX_LENGTH: usize = 4096;
/// A preference is configuration, not storage.
pub const UI_SETTING_MAX_BYTES: usize = 64 * 1024;
pub const DEFAULT_IDLE_STOP_MINUTES: i64 = 30;
pub const MAX_IDLE_STOP_MINUTES: i64 = 24 * 60;
pub const MAX_TITLE_SUFFIX_LENGTH: usize = 32;
pub const DEFAULT_TIME_REPORT_TIMEOUT_SECONDS: i64 = 60;

// JavaScript's notions the TS normaliser relies on.

/// JavaScript's `\s` and `trim`: Unicode White_Space but NEL, plus BOM.
pub(crate) fn js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_whitespace)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `value && typeof value === "object"`: objects and arrays.
fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `Object.entries(value)` for objects and arrays.
fn entries(value: Option<&Value>) -> Vec<(String, &Value)> {
    match value {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => Vec::new(),
    }
}

/// `Number.isInteger(value)`, as an i64.
fn integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15)
        .then_some(number as i64)
}

fn bounded_integer(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    integer(value)
        .filter(|value| (min..=max).contains(value))
        .unwrap_or(fallback)
}

fn string_list(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.as_str().is_some_and(|text| !js_trim(text).is_empty()))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// shared/instanceName.ts normalizeTitleSuffix.
pub fn normalize_title_suffix(value: &Value) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err("Title suffix must be text".into());
    };
    let mut suffix = String::new();
    let mut in_space = false;
    for character in js_trim(text).chars() {
        if js_whitespace(character) {
            if !in_space {
                suffix.push(' ');
            }
            in_space = true;
        } else {
            suffix.push(character);
            in_space = false;
        }
    }
    if suffix.chars().count() > MAX_TITLE_SUFFIX_LENGTH {
        return Err(format!(
            "Title suffix must be {MAX_TITLE_SUFFIX_LENGTH} characters or fewer"
        ));
    }
    if suffix.chars().any(|character| {
        let point = character as u32;
        point < 32
            || (127..=159).contains(&point)
            || (0x202a..=0x202e).contains(&point)
            || (0x2066..=0x2069).contains(&point)
    }) {
        return Err("Title suffix must not contain control characters".into());
    }
    Ok(suffix)
}

/// shared/instanceName.ts instanceDisplayName.
pub fn instance_display_name(suffix: &str) -> String {
    if suffix.is_empty() {
        "Roamgate".to_owned()
    } else {
        format!("Roamgate \u{b7} {suffix}")
    }
}

fn stored_title_suffix(value: Option<&Value>) -> String {
    let value = match value {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(value) => value.clone(),
    };
    normalize_title_suffix(&value).unwrap_or_default()
}

/// A trimmed absolute directory (trailing slashes dropped, `/` kept), or
/// None when unset or invalid.
pub fn normalize_worktree_directory(value: &Value) -> Option<String> {
    let trimmed = js_trim(value.as_str()?);
    let mut kept = trimmed;
    while kept.len() > 1 && kept.ends_with('/') {
        kept = &kept[..kept.len() - 1];
    }
    kept.starts_with('/').then(|| kept.to_owned())
}

/// A trimmed command template, or None when unset or invalid.
pub fn normalize_worktree_command(value: &Value) -> Option<String> {
    let trimmed = js_trim(value.as_str()?);
    (!trimmed.is_empty()
        && utf16_len(trimmed) <= WORKTREE_COMMAND_MAX_LENGTH
        && !trimmed.contains('\0'))
    .then(|| trimmed.to_owned())
}

/// The default activity settings (activity recorder off).
pub fn default_activity_settings() -> Value {
    json!({
        "enabled": false,
        "retention_days": 90,
        "idle_seconds": 300,
        "day_start": "00:00",
        "subject_roots": [],
        "record_agent_titles": false,
        "exclude": { "connections": [], "subjects": [] },
    })
}

fn is_day_start(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && matches!(
            (bytes[0], bytes[1]),
            (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
        )
        && matches!(bytes[3], b'0'..=b'5')
        && bytes[4].is_ascii_digit()
}

/// Fills defaults in and drops invalid values, field by field.
pub fn normalize_activity_settings(raw: Option<&Value>) -> Value {
    let empty = Map::new();
    let object = match raw {
        Some(Value::Object(map)) => map,
        _ => &empty,
    };
    let exclude = object
        .get("exclude")
        .filter(|value| is_object_like(Some(value)));
    let day_start = object
        .get("day_start")
        .and_then(Value::as_str)
        .filter(|text| is_day_start(text))
        .unwrap_or("00:00");
    json!({
        "enabled": object.get("enabled") == Some(&Value::Bool(true)),
        "retention_days": bounded_integer(object.get("retention_days"), 1, 3650, 90),
        "idle_seconds": bounded_integer(object.get("idle_seconds"), 30, 86_400, 300),
        "day_start": day_start,
        "subject_roots": string_list(object.get("subject_roots")),
        "record_agent_titles": object.get("record_agent_titles") == Some(&Value::Bool(true)),
        "exclude": {
            "connections": string_list(exclude.and_then(|value| value.get("connections"))),
            "subjects": string_list(exclude.and_then(|value| value.get("subjects"))),
        },
    })
}

/// The Hours view's provider; None when the value names no runnable
/// command.
pub fn normalize_time_report_settings(raw: Option<&Value>) -> Option<Value> {
    let object = raw?.as_object()?;
    let given = object.get("command")?.as_array()?;
    let command: Vec<&Value> = given
        .iter()
        .filter(|entry| {
            entry
                .as_str()
                .is_some_and(|text| !text.is_empty() && utf16_len(text) < 4096)
        })
        .collect();
    if command.is_empty() || command.len() != given.len() || command.len() > 64 {
        return None;
    }
    if js_trim(command[0].as_str()?).is_empty() {
        return None;
    }
    Some(json!({
        "command": command,
        "timeout_seconds": bounded_integer(object.get("timeout_seconds"), 5, 600, DEFAULT_TIME_REPORT_TIMEOUT_SECONDS),
    }))
}

/// `conversation.idle_stop_minutes`: 0 (off) to a day, whole.
pub fn is_idle_stop_minutes(value: Option<&Value>) -> bool {
    integer(value).is_some_and(|minutes| (0..=MAX_IDLE_STOP_MINUTES).contains(&minutes))
}

fn normalize_conversation(raw: Option<&Value>) -> Option<Value> {
    let object = raw?.as_object()?;
    let minutes = object.get("idle_stop_minutes");
    Some(if is_idle_stop_minutes(minutes) {
        json!({ "idle_stop_minutes": integer(minutes) })
    } else {
        json!({})
    })
}

/// The forge cache's durations and limits (mr-cache/cache.ts), in ms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MrCacheSettings {
    pub running_ms: i64,
    pub open_ms: i64,
    pub settled_ms: i64,
    pub none_ms: i64,
    pub unavailable_ms: i64,
    pub budget_per_minute: i64,
    pub max_entries: i64,
}

pub const DEFAULT_MR_CACHE_SETTINGS: MrCacheSettings = MrCacheSettings {
    running_ms: 75_000,
    open_ms: 10 * 60_000,
    settled_ms: 6 * 60 * 60_000,
    none_ms: 15 * 60_000,
    unavailable_ms: 10 * 60_000,
    budget_per_minute: 20,
    max_entries: 1000,
};

/// Fills defaults in and drops invalid values, field by field.
pub fn normalize_mr_cache_settings(raw: Option<&Value>) -> MrCacheSettings {
    let empty = Map::new();
    let object = match raw {
        Some(Value::Object(map)) => map,
        _ => &empty,
    };
    let defaults = DEFAULT_MR_CACHE_SETTINGS;
    let seconds = |key: &str, fallback: i64| {
        bounded_integer(object.get(key), 5, 30 * 24 * 3600, fallback / 1000) * 1000
    };
    MrCacheSettings {
        running_ms: seconds("running_seconds", defaults.running_ms),
        open_ms: seconds("open_seconds", defaults.open_ms),
        settled_ms: seconds("settled_seconds", defaults.settled_ms),
        none_ms: seconds("none_seconds", defaults.none_ms),
        unavailable_ms: seconds("unavailable_seconds", defaults.unavailable_ms),
        budget_per_minute: bounded_integer(
            object.get("budget_per_minute"),
            1,
            600,
            defaults.budget_per_minute,
        ),
        max_entries: bounded_integer(object.get("max_entries"), 50, 20_000, defaults.max_entries),
    }
}

/// Only the valid fields of `mr_cache`, in the units settings.json uses.
fn stored_mr_cache(raw: &Value) -> Value {
    let normalized = normalize_mr_cache_settings(Some(raw));
    let defaults = DEFAULT_MR_CACHE_SETTINGS;
    let given = raw.as_object();
    let pairs = [
        (
            "running_seconds",
            normalized.running_ms / 1000,
            defaults.running_ms / 1000,
        ),
        (
            "open_seconds",
            normalized.open_ms / 1000,
            defaults.open_ms / 1000,
        ),
        (
            "settled_seconds",
            normalized.settled_ms / 1000,
            defaults.settled_ms / 1000,
        ),
        (
            "none_seconds",
            normalized.none_ms / 1000,
            defaults.none_ms / 1000,
        ),
        (
            "unavailable_seconds",
            normalized.unavailable_ms / 1000,
            defaults.unavailable_ms / 1000,
        ),
        (
            "budget_per_minute",
            normalized.budget_per_minute,
            defaults.budget_per_minute,
        ),
        ("max_entries", normalized.max_entries, defaults.max_entries),
    ];
    let mut out = Map::new();
    for (key, value, fallback) in pairs {
        let Some(given) = given.and_then(|map| map.get(key)) else {
            continue;
        };
        if value != fallback || given.as_f64() == Some(value as f64) {
            out.insert(key.into(), value.into());
        }
    }
    Value::Object(out)
}

/// shared/history.ts normalizeHistorySettings.
fn normalize_history(raw: Option<&Value>) -> Option<Value> {
    let object = raw?.as_object()?;
    let mut out = Map::new();
    if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
        out.insert("enabled".into(), enabled.into());
    }
    if let Some(location) = object.get("location").and_then(Value::as_str)
        && !js_trim(location).is_empty()
    {
        out.insert("location".into(), js_trim(location).into());
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Namespaces are addressed by RPC: unmistakable identifiers only.
pub fn ui_setting_key_is_valid(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Refuses values too large to be configuration (None: undefined, fine).
/// Every JSON value round-trips through the file, so size is the only
/// limit left here (a cyclic or function value cannot reach Rust).
pub fn ui_setting_value_error(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let bytes = serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(usize::MAX);
    (bytes > UI_SETTING_MAX_BYTES)
        .then(|| format!("Preference value is {bytes} bytes; the limit is {UI_SETTING_MAX_BYTES}."))
}

/// A section's normaliser; a family that owns a section may plug its own
/// in with [`SettingsStore::with_section`].
pub type SectionNormalizer = fn(Option<&Value>) -> Option<Value>;

fn default_sections() -> HashMap<&'static str, SectionNormalizer> {
    HashMap::from([
        ("archive", sections::archive_section as SectionNormalizer),
        ("limit_resume", sections::limit_resume_section),
        ("profiles", sections::profiles_section),
        ("mr_reviews", sections::normalize_stored_mr_reviews),
        ("workspace_tree", sections::workspace_tree_section),
    ])
}

/// normalizeGuiSettings: the TS type's fields, in its order.
fn normalize(
    raw: &Value,
    sections: &HashMap<&'static str, SectionNormalizer>,
) -> Map<String, Value> {
    // Objects as JSON.parse gives them to the TS side: array-index keys
    // first. The result is ordered again, as JS orders what it assigns.
    let raw = sections::js_key_order(raw.clone());
    match sections::js_key_order(Value::Object(normalize_ordered(&raw, sections))) {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn normalize_ordered(
    raw: &Value,
    sections: &HashMap<&'static str, SectionNormalizer>,
) -> Map<String, Value> {
    let empty = Map::new();
    let object = raw.as_object().unwrap_or(&empty);
    let get = |key: &str| {
        object
            .get(key)
            .filter(|value| !value.is_null() || key == "archive" || key == "profiles")
    };
    let section = |key: &str| {
        sections
            .get(key)
            .and_then(|normalize| normalize(object.get(key)))
    };
    let mut out = Map::new();
    out.insert("version".into(), 1.into());
    out.insert(
        "title_suffix".into(),
        stored_title_suffix(object.get("title_suffix")).into(),
    );
    out.insert(
        "auto_rename_agent_tabs".into(),
        object
            .get("auto_rename_agent_tabs")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            .into(),
    );
    if let Some(command) = get("worktree_command").and_then(normalize_worktree_command) {
        out.insert("worktree_command".into(), command.into());
    }
    if let Some(command) = get("worktree_remove_command").and_then(normalize_worktree_command) {
        out.insert("worktree_remove_command".into(), command.into());
    }
    let mut repositories = Map::new();
    if is_object_like(get("repositories")) {
        for (key, repo) in entries(get("repositories")) {
            if !is_object_like(Some(repo)) {
                continue;
            }
            let mut entry = Map::new();
            if let Some(enabled) = repo.get("worktree_hooks_enabled").and_then(Value::as_bool) {
                entry.insert("worktree_hooks_enabled".into(), enabled.into());
            }
            if let Some(directory) = repo
                .get("worktree_directory")
                .and_then(normalize_worktree_directory)
            {
                entry.insert("worktree_directory".into(), directory.into());
            }
            for field in ["worktree_command", "worktree_remove_command"] {
                if let Some(command) = repo.get(field).and_then(normalize_worktree_command) {
                    entry.insert(field.into(), command.into());
                }
            }
            if let Some(custom) = repo
                .get("custom")
                .filter(|value| is_object_like(Some(value)))
            {
                entry.insert("custom".into(), custom.clone());
            }
            repositories.insert(key, Value::Object(entry));
        }
    }
    out.insert("repositories".into(), Value::Object(repositories));
    let mut auto_sync = Map::new();
    if is_object_like(get("workspace_auto_sync")) {
        for (key, entry) in entries(get("workspace_auto_sync")) {
            if !is_object_like(Some(entry)) {
                continue;
            }
            let mut kept = Map::new();
            kept.insert(
                "enabled".into(),
                (entry.get("enabled") == Some(&Value::Bool(true))).into(),
            );
            let interval = entry
                .get("interval_minutes")
                .and_then(Value::as_f64)
                .filter(|minutes| minutes.is_finite() && *minutes >= 1.0)
                .map(|minutes| (minutes + 0.5).floor() as i64)
                .unwrap_or(DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES);
            kept.insert("interval_minutes".into(), interval.into());
            for field in ["checkout_path", "host", "last_run_at"] {
                if let Some(text) = entry.get(field).and_then(Value::as_str) {
                    kept.insert(field.into(), text.into());
                }
            }
            if let Some(status) = entry
                .get("last_status")
                .and_then(Value::as_str)
                .filter(|status| ["updated", "up_to_date", "skipped", "failed"].contains(status))
            {
                kept.insert("last_status".into(), status.into());
            }
            for field in ["last_message", "last_branch"] {
                if let Some(text) = entry.get(field).and_then(Value::as_str) {
                    kept.insert(field.into(), text.into());
                }
            }
            auto_sync.insert(key, Value::Object(kept));
        }
    }
    out.insert("workspace_auto_sync".into(), Value::Object(auto_sync));
    let mut transport = Map::new();
    for (key, entry) in entries(get("terminal_transport")) {
        if let Some(codecs) = entry.get("surface_codecs").and_then(Value::as_bool) {
            transport.insert(key, json!({ "surface_codecs": codecs }));
        }
    }
    out.insert("terminal_transport".into(), Value::Object(transport));
    if let Some(archive) = section("archive") {
        out.insert("archive".into(), archive);
    }
    if object.contains_key("activity") {
        out.insert(
            "activity".into(),
            normalize_activity_settings(object.get("activity")),
        );
    }
    if let Some(report) = normalize_time_report_settings(object.get("time_report")) {
        out.insert("time_report".into(), report);
    }
    if let Some(mode) = object
        .get("claude_start_mode")
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "terminal" | "conversation"))
    {
        out.insert("claude_start_mode".into(), mode.into());
    }
    if let Some(conversation) = normalize_conversation(object.get("conversation")) {
        out.insert("conversation".into(), conversation);
    }
    for key in ["limit_resume", "profiles"] {
        if let Some(value) = section(key) {
            out.insert(key.into(), value);
        }
    }
    if let Some(cache) = get("mr_cache").filter(|value| is_object_like(Some(value))) {
        out.insert("mr_cache".into(), stored_mr_cache(cache));
    }
    if let Some(reviews) = section("mr_reviews") {
        out.insert("mr_reviews".into(), reviews);
    }
    out.insert(
        "custom".into(),
        get("custom")
            .filter(|value| is_object_like(Some(value)))
            .cloned()
            .unwrap_or_else(|| json!({})),
    );
    let mut ui = Map::new();
    if let Some(Value::Object(given)) = get("ui") {
        for (key, value) in given {
            if ui_setting_key_is_valid(key) && ui_setting_value_error(Some(value)).is_none() {
                ui.insert(key.clone(), value.clone());
            }
        }
    }
    out.insert("ui".into(), Value::Object(ui));
    if let Some(value) = section("workspace_tree") {
        out.insert("workspace_tree".into(), value);
    }
    let sites = sections::normalize_site_list(object.get("rendered_sites"));
    let roots = sections::normalize_site_roots(object.get("rendered_site_roots"), &sites);
    if !sites.is_empty() {
        out.insert("rendered_sites".into(), sites.into());
    }
    if !roots.is_empty() {
        out.insert("rendered_site_roots".into(), Value::Object(roots));
    }
    if let Some(history) = normalize_history(object.get("history")) {
        out.insert("history".into(), history);
    }
    out
}

fn default_settings() -> Map<String, Value> {
    let Value::Object(map) = json!({
        "version": 1,
        "title_suffix": "",
        "auto_rename_agent_tabs": true,
        "repositories": {},
        "workspace_auto_sync": {},
        "terminal_transport": {},
        "custom": {},
        "ui": {},
    }) else {
        unreachable!()
    };
    map
}

/// Normalised settings.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings(Map<String, Value>);

impl Settings {
    /// Normalises a raw settings.json value with the default sections.
    pub fn normalize(raw: &Value) -> Self {
        Self(normalize(raw, &default_sections()))
    }

    pub fn defaults() -> Self {
        Self(default_settings())
    }

    pub fn as_map(&self) -> &Map<String, Value> {
        &self.0
    }

    pub fn into_value(self) -> Value {
        Value::Object(self.0)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// A copy with `key` set (`None` removes it), for update closures.
    pub fn with(&self, key: &str, value: Option<Value>) -> Value {
        let mut map = self.0.clone();
        match value {
            Some(value) => {
                map.insert(key.into(), value);
            }
            None => {
                map.remove(key);
            }
        }
        Value::Object(map)
    }

    fn object(&self, key: &str) -> Map<String, Value> {
        self.0
            .get(key)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    pub fn custom(&self) -> Option<&Value> {
        self.0.get("custom")
    }

    pub fn ui(&self) -> Map<String, Value> {
        self.object("ui")
    }

    /// Whether the connection's terminals use the surface codecs (default
    /// on).
    pub fn terminal_surface_codecs_enabled(&self, connection_id: Option<&str>) -> bool {
        let connection = connection_id.unwrap_or(LEGACY_DEFAULT_CONNECTION_ID);
        self.0
            .get("terminal_transport")
            .and_then(|transport| transport.get(connection))
            .and_then(|entry| entry.get("surface_codecs"))
            != Some(&Value::Bool(false))
    }

    /// The repository's worktree command, else the global default.
    pub fn worktree_command_for(&self, repo_key: Option<&str>) -> Option<String> {
        self.repo_field(repo_key, "worktree_command").or_else(|| {
            self.0
                .get("worktree_command")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
    }

    /// The repository's worktree removal command, else the global default.
    pub fn worktree_remove_command_for(&self, repo_key: Option<&str>) -> Option<String> {
        self.repo_field(repo_key, "worktree_remove_command")
            .or_else(|| {
                self.0
                    .get("worktree_remove_command")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    }

    fn repo_field(&self, repo_key: Option<&str>, field: &str) -> Option<String> {
        let key = repo_key.filter(|key| !key.is_empty())?;
        self.0
            .get("repositories")?
            .get(key)?
            .get(field)?
            .as_str()
            .map(str::to_owned)
    }

    /// Whether the repository's worktree hooks run (default on).
    pub fn repo_worktree_hooks_enabled(&self, repo_key: Option<&str>) -> bool {
        let Some(key) = repo_key.filter(|key| !key.is_empty()) else {
            return true;
        };
        self.0
            .get("repositories")
            .and_then(|repos| repos.get(key))
            .and_then(|repo| repo.get("worktree_hooks_enabled"))
            != Some(&Value::Bool(false))
    }

    /// The repository's worktree directory.
    pub fn repo_worktree_directory(&self, repo_key: Option<&str>) -> Option<String> {
        self.repo_field(repo_key, "worktree_directory")
    }

    /// Where a claude started by hand in a pane goes: "terminal" unless set.
    pub fn claude_start_mode(&self) -> &str {
        self.0
            .get("claude_start_mode")
            .and_then(Value::as_str)
            .unwrap_or("terminal")
    }

    /// Conversation mode's idle stop in minutes (0: off).
    pub fn conversation_idle_stop_minutes(&self) -> i64 {
        integer(
            self.0
                .get("conversation")
                .and_then(|conversation| conversation.get("idle_stop_minutes")),
        )
        .unwrap_or(DEFAULT_IDLE_STOP_MINUTES)
    }

    /// The activity settings in effect, defaults included.
    pub fn activity(&self) -> Value {
        self.0
            .get("activity")
            .cloned()
            .unwrap_or_else(|| normalize_activity_settings(None))
    }

    /// The forge cache settings in effect, defaults included.
    pub fn mr_cache(&self) -> MrCacheSettings {
        normalize_mr_cache_settings(self.0.get("mr_cache"))
    }

    /// The overlay tabs of a connection (`ui.overlayTabs`).
    pub fn overlay_tab_ids(&self, connection_id: &str) -> BTreeSet<String> {
        overlay_tab_ids_in(&self.ui(), connection_id)
    }
}

/// The forge cache settings of possibly absent settings.
pub fn mr_cache_settings(settings: Option<&Settings>) -> MrCacheSettings {
    normalize_mr_cache_settings(settings.and_then(|settings| settings.get("mr_cache")))
}

/// Tab ids a connection shows as overlay tabs, from the interface setting
/// the frontend owns (`ui.overlayTabs`, web/src/overlayTabs.ts). A
/// malformed value hides nothing.
pub fn overlay_tab_ids_in(ui: &Map<String, Value>, connection_id: &str) -> BTreeSet<String> {
    let Some(value) = ui.get("overlayTabs") else {
        return BTreeSet::new();
    };
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return BTreeSet::new();
    }
    let Some(Value::Object(marks)) = value
        .get("connections")
        .and_then(|connections| connections.get(connection_id))
    else {
        return BTreeSet::new();
    };
    marks
        .values()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `connection:<id>:` for a connection other than the legacy default.
pub fn connection_settings_prefix(connection_id: Option<&str>) -> String {
    match connection_id {
        Some(id) if !id.is_empty() && id != LEGACY_DEFAULT_CONNECTION_ID => {
            format!("connection:{}:", encode_uri_component(id))
        }
        _ => String::new(),
    }
}

/// A repository's key in `repositories` (the legacy format for the legacy
/// connection).
pub fn repo_settings_key(
    raw_repo_key: &str,
    host: Option<&str>,
    connection_id: Option<&str>,
) -> String {
    let place = match host.filter(|host| !host.is_empty()) {
        Some(host) => format!("ssh:{host}"),
        None => "local".to_owned(),
    };
    format!(
        "{}{place}:{raw_repo_key}",
        connection_settings_prefix(connection_id)
    )
}

/// The settings key of a Herdr workspace's repository: its worktree's
/// repo_key, else repo_root, else its checkout (the worktree's
/// checkout_path, else the workspace's cwd).
pub fn workspace_repo_settings_key(
    workspace: &Value,
    host: Option<&str>,
    connection_id: Option<&str>,
) -> Option<String> {
    let worktree = workspace.get("worktree");
    let field = |name: &str| {
        worktree
            .and_then(|worktree| worktree.get(name))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    let cwd = workspace
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    let raw = field("repo_key")
        .or_else(|| field("repo_root"))
        .or_else(|| field("checkout_path"))
        .or(cwd)?;
    Some(repo_settings_key(raw, host, connection_id))
}

/// The settings key of a checkout's auto sync.
pub fn workspace_auto_sync_settings_key(
    checkout_path: &str,
    host: Option<&str>,
    connection_id: Option<&str>,
) -> Option<String> {
    let path = js_trim(checkout_path);
    (!path.is_empty()).then(|| repo_settings_key(path, host, connection_id))
}

/// Where settings.json is: `ROAMGATE_SETTINGS_PATH` (or its legacy name),
/// even empty, without migrating anything; else the data root's, migrated
/// from herdr-gui once.
pub fn settings_path(env: &dyn Env, context: &DataContext) -> std::io::Result<PathBuf> {
    match roamgate_env(env, "SETTINGS_PATH") {
        Some(path) => Ok(PathBuf::from(path)),
        None => context.default_data_file(DataFile::Settings),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("settings update cancelled")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The one owner of settings.json.
pub struct SettingsStore {
    path: PathBuf,
    sections: HashMap<&'static str, SectionNormalizer>,
    cached: Mutex<Option<Arc<Settings>>>,
    queue: tokio::sync::Mutex<()>,
    changes: watch::Sender<Option<Arc<Settings>>>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            sections: default_sections(),
            cached: Mutex::new(None),
            queue: tokio::sync::Mutex::new(()),
            changes: watch::channel(None).0,
        }
    }

    /// The store of the settings file the environment names.
    pub fn from_env(env: &dyn Env, context: &DataContext) -> std::io::Result<Self> {
        Ok(Self::new(settings_path(env, context)?))
    }

    /// Plugs in the normaliser of a section a family owns.
    pub fn with_section(mut self, key: &'static str, normalize: SectionNormalizer) -> Self {
        self.sections.insert(key, normalize);
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn normalize(&self, raw: &Value) -> Settings {
        Settings(normalize(raw, &self.sections))
    }

    /// The settings read last, for code that cannot wait; None before the
    /// first read.
    pub fn peek(&self) -> Option<Arc<Settings>> {
        self.cached.lock().expect("settings").clone()
    }

    /// Each change, as written.
    pub fn subscribe(&self) -> watch::Receiver<Option<Arc<Settings>>> {
        self.changes.subscribe()
    }

    /// The settings: read once, then kept. A missing file gives the
    /// defaults; an invalid one is logged and gives the defaults.
    pub async fn read(&self) -> Arc<Settings> {
        if let Some(cached) = self.peek() {
            return cached;
        }
        let settings = match tokio::fs::read(&self.path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::defaults(),
            Err(error) => {
                tracing::warn!(path = %self.path.display(), %error, "ignoring invalid settings");
                Settings::defaults()
            }
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(raw) => self.normalize(&raw),
                Err(error) => {
                    tracing::warn!(path = %self.path.display(), %error, "ignoring invalid settings");
                    Settings::defaults()
                }
            },
        };
        let settings = Arc::new(settings);
        *self.cached.lock().expect("settings") = Some(settings.clone());
        settings
    }

    /// Reads, changes and writes under one slot.
    pub async fn update(
        &self,
        change: impl FnOnce(&Settings) -> Value,
    ) -> Result<Arc<Settings>, SettingsError> {
        self.update_if(change, || true).await
    }

    /// [`Self::update`], abandoned (`Cancelled`) when `should_commit` turns
    /// false before the file is replaced.
    pub async fn update_if(
        &self,
        change: impl FnOnce(&Settings) -> Value,
        should_commit: impl Fn() -> bool,
    ) -> Result<Arc<Settings>, SettingsError> {
        let _slot = self.queue.lock().await;
        let current = self.read().await;
        if !should_commit() {
            return Err(SettingsError::Cancelled);
        }
        let next = self.normalize(&change(&current));
        if !should_commit() {
            return Err(SettingsError::Cancelled);
        }
        let text = to_js_json(next.as_map(), JsonFormat::Pretty)?;
        let path = self.path.clone();
        let temporary = PathBuf::from(format!(
            "{}.{}.{}.tmp",
            path.display(),
            std::process::id(),
            TEMPORARY_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1
        ));
        let written = tokio::task::spawn_blocking({
            let temporary = temporary.clone();
            move || -> std::io::Result<()> {
                create_dir_all_mode(&dirname(&path))?;
                let mut file = std::fs::File::options()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                set_file_mode(&file, 0o600)?;
                file.write_all(text.as_bytes())?;
                file.sync_all()
            }
        })
        .await
        .map_err(std::io::Error::other)
        .and_then(|result| result);
        let committed = written.map_err(SettingsError::from).and_then(|()| {
            if should_commit() {
                std::fs::rename(&temporary, &self.path).map_err(SettingsError::from)
            } else {
                Err(SettingsError::Cancelled)
            }
        });
        if let Err(error) = committed {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        let next = Arc::new(next);
        *self.cached.lock().expect("settings") = Some(next.clone());
        self.changes.send_replace(Some(next.clone()));
        Ok(next)
    }
}

#[cfg(test)]
mod tests;
