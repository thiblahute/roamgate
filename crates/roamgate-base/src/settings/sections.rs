//! The sections of settings.json whose rules live with a family not ported
//! when the settings store moved to Rust (S13): `archive`
//! (archive/settings.ts), `limit_resume` (shared/limitResume.ts),
//! `profiles` (shared/agentProfiles.ts), `mr_reviews`
//! (mr-reviews/settings.ts and overrides.ts), `workspace_tree`
//! (shared/workspaceTree.ts) and the rendered sites
//! (shared/renderedPage.ts). Each normalises exactly as its TS function,
//! held to contract/vectors/settings.json; a family that later owns one of
//! them takes its normaliser from here.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde_json::{Map, Value, json};

use super::{js_trim, js_whitespace};
use crate::log::{slice_utf16, utf16_len};

// JavaScript's notions the TS normalisers rely on.

/// `value.replace(/\s+/g, " ")`.
pub fn js_collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for character in text.chars() {
        if js_whitespace(character) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(character);
            in_space = false;
        }
    }
    out
}

/// `value.replace(/\s+/g, " ").trim().slice(0, max)`.
fn tidy(text: &str, max: usize) -> String {
    slice_utf16(js_trim(&js_collapse_whitespace(text)), max).to_owned()
}

/// `value && typeof value === "object" && !Array.isArray(value)`.
fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `!!value && typeof value === "object"` (arrays included).
fn object_like(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// `typeof value === "string" && value.trim() ? value.trim() : undefined`.
fn trimmed(value: Option<&Value>) -> Option<String> {
    let text = js_trim(value?.as_str()?);
    (!text.is_empty()).then(|| text.to_owned())
}

/// `String(value ?? "")`.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_to_string(value),
    }
}

fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => crate::log::js_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_to_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(value)` (absent: NaN).
pub fn js_to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js_string_to_number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => js_to_number(Some(&Value::String(js_string(Some(one))))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(text)`.
pub fn js_string_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str, radix: u32| {
        text.strip_prefix(prefix)
            .or_else(|| text.strip_prefix(&prefix.to_uppercase()))
            .map(|digits| {
                if digits.is_empty() {
                    return f64::NAN;
                }
                digits
                    .chars()
                    .try_fold(0f64, |total, digit| {
                        digit
                            .to_digit(radix)
                            .map(|digit| total * f64::from(radix) + f64::from(digit))
                    })
                    .unwrap_or(f64::NAN)
            })
    };
    if let Some(value) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return value;
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // JS decimal literals only: digits, one point, an exponent.
    let valid = !unsigned.is_empty()
        && unsigned.chars().all(|character| {
            character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-')
        })
        && unsigned
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_digit() || first == '.');
    if !valid {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isInteger(number)`.
fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// `Number.isSafeInteger(number)`.
fn is_safe_integer(number: f64) -> bool {
    is_integer(number) && number.abs() <= 9_007_199_254_740_991.0
}

fn number_value(number: f64) -> Value {
    if is_safe_integer(number) {
        json!(number as i64)
    } else {
        json!(number)
    }
}

/// Whether `key` is an array index, which JS objects list first, in
/// ascending order.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u32>()
        .ok()
        .filter(|index| *index != u32::MAX && index.to_string() == key)
}

/// A value with every object's keys in the order JS keeps them: array
/// indices first, ascending, then the others as inserted (what
/// `JSON.parse` and later assignments give the TS side).
pub fn js_key_order(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut indices = Vec::new();
            let mut others = Map::new();
            for (key, value) in map {
                let value = js_key_order(value);
                match array_index(&key) {
                    Some(index) => indices.push((index, key, value)),
                    None => {
                        others.insert(key, value);
                    }
                }
            }
            if indices.is_empty() {
                return Value::Object(others);
            }
            indices.sort_by_key(|(index, _, _)| *index);
            let mut out = Map::new();
            for (_, key, value) in indices {
                out.insert(key, value);
            }
            out.extend(others);
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(js_key_order).collect()),
        other => other,
    }
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

macro_rules! static_regex {
    ($name:ident, $pattern:expr) => {
        fn $name() -> &'static Regex {
            static CELL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
            CELL.get_or_init(|| regex($pattern))
        }
    };
}

// ---------------------------------------------------------------- archive

fn archive_rule(rule: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for field in ["host", "agent", "project"] {
        if let Some(text) = trimmed(rule.get(field)) {
            out.insert(field.into(), text.into());
        }
    }
    out
}

fn archive_rules(value: Option<&Value>) -> Value {
    let Some(Value::Array(items)) = value else {
        return json!([]);
    };
    Value::Array(
        items
            .iter()
            .filter_map(Value::as_object)
            .map(|rule| Value::Object(archive_rule(rule)))
            .collect(),
    )
}

fn index_level(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|level| matches!(*level, "full" | "words" | "none"))
}

fn archive_host(value: &Value) -> Value {
    let Some(spec) = value.as_object() else {
        return json!({});
    };
    let mut out = Map::new();
    for field in ["ssh", "home"] {
        if let Some(text) = trimmed(spec.get(field)) {
            out.insert(field.into(), text.into());
        }
    }
    if let Some(style) = spec
        .get("path_style")
        .and_then(Value::as_str)
        .filter(|style| matches!(*style, "windows" | "posix"))
    {
        out.insert("path_style".into(), style.into());
    }
    if let Some(roots) = as_object(spec.get("roots")) {
        let kept: Map<String, Value> = roots
            .iter()
            .filter_map(|(agent, root)| {
                trimmed(Some(root)).map(|root| (agent.clone(), root.into()))
            })
            .collect();
        if !kept.is_empty() {
            out.insert("roots".into(), Value::Object(kept));
        }
    }
    if spec.get("enabled") == Some(&Value::Bool(false)) {
        out.insert("enabled".into(), false.into());
    }
    Value::Object(out)
}

/// archive/settings.ts normalizeArchiveSettings.
pub fn normalize_archive_settings(raw: Option<&Value>) -> Value {
    let empty = Map::new();
    let object = as_object(raw).unwrap_or(&empty);
    let mut out = Map::new();
    for field in ["dir", "host"] {
        if let Some(text) = trimmed(object.get(field)) {
            out.insert(field.into(), text.into());
        }
    }
    let agents = match object.get("agents") {
        Some(Value::Array(items)) => Value::Array(
            items
                .iter()
                .filter(|agent| agent.as_str().is_some_and(|text| !js_trim(text).is_empty()))
                .cloned()
                .collect(),
        ),
        _ => json!(["claude", "codex", "pi"]),
    };
    out.insert("agents".into(), agents);
    let hosts: Map<String, Value> = as_object(object.get("hosts"))
        .map(|hosts| {
            hosts
                .iter()
                .map(|(id, spec)| (id.clone(), archive_host(spec)))
                .collect()
        })
        .unwrap_or_default();
    out.insert("hosts".into(), Value::Object(hosts));
    let stale_hours = object
        .get("stale_hours")
        .filter(|value| value.as_f64().is_some_and(|hours| hours > 0.0))
        .cloned()
        .unwrap_or_else(|| json!(48));
    out.insert("stale_hours".into(), stale_hours);
    out.insert(
        "thinking".into(),
        (object.get("thinking") == Some(&Value::Bool(true))).into(),
    );
    let index = as_object(object.get("index"));
    let rules = match index.and_then(|index| index.get("rules")) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .filter_map(|rule| {
                let level = index_level(rule.get("level"))?;
                let mut kept = archive_rule(rule);
                kept.insert("level".into(), level.into());
                Some(Value::Object(kept))
            })
            .collect(),
        _ => Vec::new(),
    };
    out.insert(
        "index".into(),
        json!({
            "default": index_level(index.and_then(|index| index.get("default"))).unwrap_or("full"),
            "rules": rules,
        }),
    );
    out.insert("exclude".into(), archive_rules(object.get("exclude")));
    out.insert("hide".into(), archive_rules(object.get("hide")));
    let min_free = object
        .get("min_free_gb")
        .filter(|value| value.as_f64().is_some_and(|gb| gb >= 0.0))
        .cloned()
        .unwrap_or_else(|| json!(20));
    out.insert("min_free_gb".into(), min_free);
    if let Some(push) = as_object(object.get("push"))
        && let Some(target) = trimmed(push.get("target"))
    {
        let mut kept = Map::new();
        kept.insert("target".into(), target.into());
        for field in ["archive_dir", "binary"] {
            if let Some(text) = trimmed(push.get(field)) {
                kept.insert(field.into(), text.into());
            }
        }
        out.insert("push".into(), Value::Object(kept));
    }
    for field in ["remote", "remote_dir"] {
        if let Some(text) = trimmed(object.get(field)) {
            out.insert(field.into(), text.into());
        }
    }
    if let Some(chars) = object
        .get("text_tool_chars")
        .and_then(Value::as_f64)
        .filter(|chars| is_integer(*chars) && (80.0..=100_000.0).contains(chars))
    {
        out.insert("text_tool_chars".into(), number_value(chars));
    }
    Value::Object(out)
}

/// The `archive` section: normalised whenever the key is there.
pub fn archive_section(raw: Option<&Value>) -> Option<Value> {
    raw.map(|raw| normalize_archive_settings(Some(raw)))
}

// ----------------------------------------------------------- limit_resume

pub const DEFAULT_LIMIT_RESUME_MESSAGE: &str = "The usage limit has reset. Continue where you stopped, and restart any background agents or workflows that failed because of the limit (resume workflows from their run id).";
pub const DEFAULT_LIMIT_RESUME_MARGIN_SECONDS: i64 = 60;
pub const MAX_LIMIT_RESUME_MARGIN_SECONDS: i64 = 3600;
pub const MAX_LIMIT_RESUME_MESSAGE_LENGTH: usize = 4000;

const LIMIT_RESUME_KEYS: [&str; 3] = ["enabled", "message", "margin_seconds"];

/// shared/limitResume.ts limitResumeSettingsError: why `raw` is not a
/// valid (partial) `limit_resume` update, or None. Every key is optional;
/// unknown keys are refused.
pub fn limit_resume_settings_error(raw: &Map<String, Value>) -> Option<String> {
    let unknown: Vec<&str> = raw
        .keys()
        .filter(|key| !LIMIT_RESUME_KEYS.contains(&key.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Some(format!(
            "limit_resume takes enabled, message and margin_seconds, not {}",
            unknown.join(", ")
        ));
    }
    if let Some(enabled) = raw.get("enabled")
        && !enabled.is_boolean()
    {
        return Some("limit_resume.enabled must be true or false".into());
    }
    if let Some(message) = raw.get("message") {
        match message.as_str() {
            Some(text) if !js_trim(text).is_empty() => {
                if utf16_len(text) > MAX_LIMIT_RESUME_MESSAGE_LENGTH {
                    return Some(format!(
                        "limit_resume.message must be at most {MAX_LIMIT_RESUME_MESSAGE_LENGTH} characters"
                    ));
                }
            }
            _ => return Some("limit_resume.message must be some text".into()),
        }
    }
    if let Some(margin) = raw.get("margin_seconds") {
        let valid = margin.as_f64().is_some_and(|seconds| {
            seconds.fract() == 0.0
                && (0.0..=MAX_LIMIT_RESUME_MARGIN_SECONDS as f64).contains(&seconds)
        });
        if !valid {
            return Some(format!(
                "limit_resume.margin_seconds must be a whole number of seconds from 0 to {MAX_LIMIT_RESUME_MARGIN_SECONDS}"
            ));
        }
    }
    None
}

/// shared/limitResume.ts normalizeLimitResumeSettings: the stored
/// settings' valid keys; None for what is not an object.
pub fn normalize_limit_resume_settings(raw: &Value) -> Option<Map<String, Value>> {
    let raw = raw.as_object()?;
    let mut kept = Map::new();
    for key in LIMIT_RESUME_KEYS {
        let Some(value) = raw.get(key) else {
            continue;
        };
        let mut one = Map::new();
        one.insert(key.into(), value.clone());
        if limit_resume_settings_error(&one).is_some() {
            continue;
        }
        let value = match (key, value.as_str()) {
            ("message", Some(text)) => Value::String(js_trim(text).into()),
            _ => value.clone(),
        };
        kept.insert(key.into(), value);
    }
    Some(kept)
}

/// The `limit_resume` section.
pub fn limit_resume_section(raw: Option<&Value>) -> Option<Value> {
    normalize_limit_resume_settings(raw?).map(Value::Object)
}

// --------------------------------------------------------------- profiles

pub const BUILTIN_PROFILE_NAME: &str = "Claude";
pub const MAX_PROFILES: usize = 16;
pub const MAX_PROFILE_ENV: usize = 48;
/// The agents a profile may name (shared/agentProfiles.ts PROFILE_AGENTS).
pub const PROFILE_AGENTS: [&str; 3] = ["claude", "codex", "agy"];

/// `/^[a-z0-9][a-z0-9_-]{0,39}$/`: an account profile's id, the name of
/// its directory under `<data>/accounts/<agent>/` (lower case, so two ids
/// never share a directory on a case-insensitive file system).
pub fn account_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=40).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

/// An account profile's id (`account.id`), when it is one.
pub fn profile_account_id(profile: &Value) -> Option<&str> {
    profile.get("account")?.get("id")?.as_str()
}

fn control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{1f}' | '\u{7f}')
}

/// `/^[^\x00-\x1f\x7f]{1,40}$/`, counted in UTF-16 units as JS does.
fn profile_name_valid(name: &str) -> bool {
    let units = utf16_len(name);
    (1..=40).contains(&units) && !name.chars().any(control)
}

/// `/^[A-Za-z_][A-Za-z0-9_]{0,127}$/`.
fn env_name_valid(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

/// shared/agentProfiles.ts profileError.
pub fn profile_error(raw: &Value) -> Option<String> {
    let Some(raw) = raw.as_object() else {
        return Some("A profile must be an object".into());
    };
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .map(js_trim)
        .unwrap_or("");
    if !profile_name_valid(name) {
        return Some("A profile name is 1 to 40 characters on one line".into());
    }
    if !raw
        .get("agent")
        .and_then(Value::as_str)
        .is_some_and(|agent| PROFILE_AGENTS.contains(&agent))
    {
        return Some(format!(
            "{name}: the agent must be one of {}",
            PROFILE_AGENTS.join(", ")
        ));
    }
    if let Some(command) = raw.get("command") {
        let valid = command.as_str().is_some_and(|command| {
            !js_trim(command).is_empty()
                && utf16_len(command) <= 4096
                && !command.chars().any(control)
        });
        if !valid {
            return Some(format!("{name}: the command must be one line"));
        }
    }
    if let Some(env) = raw.get("env") {
        let Some(env) = env.as_object() else {
            return Some(format!("{name}: env must be an object"));
        };
        if env.len() > MAX_PROFILE_ENV {
            return Some(format!("{name}: at most {MAX_PROFILE_ENV} variables"));
        }
        for (key, value) in env {
            if !env_name_valid(key) {
                return Some(format!("{name}: {key} is not a variable name"));
            }
            match value {
                Value::String(text) => {
                    if text.contains('\0') || utf16_len(text) > 16_384 {
                        return Some(format!("{name}: {key} is too long or has a NUL byte"));
                    }
                }
                value => {
                    let valid = value.as_object().is_some_and(|file| {
                        file.len() == 1
                            && file
                                .get("file")
                                .and_then(Value::as_str)
                                .is_some_and(|path| {
                                    !js_trim(path).is_empty()
                                        && !path.chars().any(|character| {
                                            matches!(character, '\u{0}'..='\u{1f}')
                                        })
                                })
                    });
                    if !valid {
                        return Some(format!(
                            "{name}: {key} must be text or {{\"file\": \"<path>\"}}"
                        ));
                    }
                }
            }
        }
    }
    if let Some(unset) = raw.get("unset") {
        let valid = unset.as_array().is_some_and(|items| {
            items.len() <= MAX_PROFILE_ENV
                && items
                    .iter()
                    .all(|item| item.as_str().is_some_and(env_name_valid))
        });
        if !valid {
            return Some(format!("{name}: unset must be a list of variable names"));
        }
    }
    if let Some(account) = raw.get("account") {
        let valid = account.as_object().is_some_and(|account| {
            account.len() == 1
                && account
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(account_id_valid)
        });
        if !valid {
            return Some(format!(
                "{name}: account must be {{\"id\": \"<1 to 40 lower-case letters, digits, - or _>\"}}"
            ));
        }
    }
    None
}

/// shared/agentProfiles.ts normalizeProfile.
pub fn normalize_profile(raw: &Value) -> Option<Value> {
    if profile_error(raw).is_some() {
        return None;
    }
    let raw = raw.as_object()?;
    let mut out = Map::new();
    out.insert("name".into(), js_trim(raw.get("name")?.as_str()?).into());
    out.insert("agent".into(), raw.get("agent")?.clone());
    if let Some(command) = raw.get("command").and_then(Value::as_str) {
        out.insert("command".into(), js_trim(command).into());
    }
    if let Some(env) = raw.get("env").and_then(Value::as_object)
        && !env.is_empty()
    {
        let kept: Map<String, Value> = env
            .iter()
            .map(|(key, value)| {
                let value = match value {
                    Value::String(_) => value.clone(),
                    file => json!({ "file": js_trim(file.get("file").and_then(Value::as_str).unwrap_or("")) }),
                };
                (key.clone(), value)
            })
            .collect();
        out.insert("env".into(), Value::Object(kept));
    }
    if let Some(unset) = raw.get("unset").and_then(Value::as_array) {
        let mut seen = HashSet::new();
        let kept: Vec<Value> = unset
            .iter()
            .filter(|name| seen.insert(name.as_str().unwrap_or_default().to_owned()))
            .cloned()
            .collect();
        if !kept.is_empty() {
            out.insert("unset".into(), Value::Array(kept));
        }
    }
    if let Some(id) = profile_account_id(&Value::Object(raw.clone())) {
        out.insert("account".into(), json!({ "id": id }));
    }
    Some(Value::Object(out))
}

/// shared/agentProfiles.ts normalizeProfilesSettings.
pub fn normalize_profiles_settings(raw: Option<&Value>) -> Value {
    let Some(raw) = as_object(raw) else {
        return json!({ "list": [], "default": BUILTIN_PROFILE_NAME, "return_after_reset": false });
    };
    let mut seen = HashSet::new();
    let mut accounts = HashSet::new();
    let mut list = Vec::new();
    for each in raw
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(profile) = normalize_profile(each) else {
            continue;
        };
        let name = profile["name"].as_str().unwrap_or_default().to_lowercase();
        if seen.contains(&name) {
            continue;
        }
        // Two profiles never share an account's directory: the first keeps it.
        if let Some(id) = profile_account_id(&profile) {
            let account = format!("{}/{id}", profile["agent"].as_str().unwrap_or_default());
            if !accounts.insert(account) {
                continue;
            }
        }
        seen.insert(name);
        list.push(profile);
        if list.len() >= MAX_PROFILES {
            break;
        }
    }
    let wanted = match raw.get("default") {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => BUILTIN_PROFILE_NAME.to_owned(),
    };
    let default = profile_named(&list, &wanted).unwrap_or_else(|| BUILTIN_PROFILE_NAME.to_owned());
    json!({
        "list": list,
        "default": default,
        "return_after_reset": raw.get("return_after_reset") == Some(&Value::Bool(true)),
    })
}

/// The name of the profile so named (case-insensitive), the built-in
/// included.
fn profile_named(list: &[Value], name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let wanted = js_trim(name).to_lowercase();
    let own_builtin = list.iter().any(|each| {
        each["name"].as_str().unwrap_or_default().to_lowercase()
            == BUILTIN_PROFILE_NAME.to_lowercase()
    });
    let builtin = (!own_builtin).then(|| BUILTIN_PROFILE_NAME.to_owned());
    builtin
        .into_iter()
        .chain(
            list.iter()
                .map(|each| each["name"].as_str().unwrap_or_default().to_owned()),
        )
        .find(|each| each.to_lowercase() == wanted)
}

/// The `profiles` section: normalised whenever the key is there.
pub fn profiles_section(raw: Option<&Value>) -> Option<Value> {
    raw.map(|raw| normalize_profiles_settings(Some(raw)))
}

// ----------------------------------------------------------- workspace tree

pub const WORKSPACE_TREE_MAX_NODES: usize = 2000;
pub const WORKSPACE_TREE_LABEL_MAX: usize = 120;
const REF_FIELD_MAX: usize = 4096;

/// `/^[A-Za-z0-9_-]{1,64}$/`.
fn word_id(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn bounded_string(value: Option<&Value>, max: usize) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && utf16_len(text) <= max)
}

/// shared/workspaceTree.ts parseWorkspaceRef.
pub fn parse_workspace_ref(value: &Value) -> Option<Value> {
    let raw = value.as_object()?;
    let connection_id = bounded_string(raw.get("connection_id"), 256)?;
    let path = bounded_string(raw.get("path"), REF_FIELD_MAX);
    let label = bounded_string(raw.get("label"), WORKSPACE_TREE_LABEL_MAX * 4);
    let workspace_id = bounded_string(raw.get("workspace_id"), 256);
    if path.is_none() && label.is_none() && workspace_id.is_none() {
        return None;
    }
    let mut out = Map::new();
    out.insert("connection_id".into(), connection_id.into());
    for (key, value) in [
        ("path", path),
        ("label", label),
        ("workspace_id", workspace_id),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), value.into());
        }
    }
    Some(Value::Object(out))
}

/// shared/workspaceTree.ts workspaceRefKey.
pub fn workspace_ref_key(reference: &Value) -> String {
    let field = |name: &str| {
        reference
            .get(name)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    let identity = match (field("path"), field("label")) {
        (Some(path), _) => format!("p:{path}"),
        (None, Some(label)) => format!("l:{label}"),
        (None, None) => format!("i:{}", field("workspace_id").unwrap_or("")),
    };
    format!(
        "{}\u{0}{identity}",
        reference
            .get("connection_id")
            .and_then(Value::as_str)
            .unwrap_or("")
    )
}

fn group_label(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return String::new();
    };
    let mut label = String::with_capacity(text.len());
    let mut in_control = false;
    for character in text.chars() {
        if control(character) {
            if !in_control {
                label.push(' ');
            }
            in_control = true;
        } else {
            label.push(character);
            in_control = false;
        }
    }
    slice_utf16(js_trim(&label), WORKSPACE_TREE_LABEL_MAX).to_owned()
}

struct TreeNode {
    id: String,
    group: bool,
    parent: Option<String>,
    /// The node's fields as the TS builds them, `parent` excepted.
    label: Option<String>,
    collapsed: bool,
    reference: Option<Value>,
    root: Option<&'static str>,
}

/// shared/workspaceTree.ts parseWorkspaceTree.
pub fn parse_workspace_tree(value: Option<&Value>) -> Value {
    let empty = json!({ "version": 1, "nodes": [] });
    let Some(raw_nodes) = as_object(value)
        .and_then(|tree| tree.get("nodes"))
        .and_then(Value::as_array)
    else {
        return empty;
    };
    let mut nodes: Vec<TreeNode> = Vec::new();
    let mut ids = HashSet::new();
    let mut ref_keys = HashSet::new();
    for raw in raw_nodes.iter().take(WORKSPACE_TREE_MAX_NODES) {
        if !object_like(raw) {
            continue;
        }
        let id = raw.get("id").and_then(Value::as_str).unwrap_or("");
        if !word_id(id, 64) || ids.contains(id) {
            continue;
        }
        let parent = raw
            .get("parent")
            .and_then(Value::as_str)
            .filter(|parent| word_id(parent, 64))
            .map(str::to_owned);
        let root = raw.get("root").and_then(Value::as_str).and_then(|place| {
            ["top", "list", "bottom"]
                .into_iter()
                .find(|each| *each == place)
        });
        match raw.get("kind").and_then(Value::as_str) {
            Some("group") => {
                let label = group_label(raw.get("label"));
                if label.is_empty() {
                    continue;
                }
                let root = (parent.is_none() && root == Some("bottom")).then_some("bottom");
                nodes.push(TreeNode {
                    id: id.into(),
                    group: true,
                    parent,
                    label: Some(label),
                    collapsed: raw.get("collapsed") == Some(&Value::Bool(true)),
                    reference: None,
                    root,
                });
            }
            Some("workspace") => {
                let Some(reference) = raw.get("ref").and_then(parse_workspace_ref) else {
                    continue;
                };
                if !ref_keys.insert(workspace_ref_key(&reference)) {
                    continue;
                }
                let root = if parent.is_none() { root } else { None };
                nodes.push(TreeNode {
                    id: id.into(),
                    group: false,
                    parent,
                    label: None,
                    collapsed: false,
                    reference: Some(reference),
                    root,
                });
            }
            _ => continue,
        }
        ids.insert(id.to_owned());
    }
    // Parents that are missing, and loops a hand edit could leave, go back
    // to the top level (in order: each fix is seen by the next node).
    let index: HashMap<String, usize> = nodes
        .iter()
        .enumerate()
        .map(|(at, node)| (node.id.clone(), at))
        .collect();
    for node in &mut nodes {
        if node
            .parent
            .as_ref()
            .is_some_and(|parent| !index.contains_key(parent))
        {
            node.parent = None;
        }
    }
    for at in 0..nodes.len() {
        let mut seen = HashSet::from([nodes[at].id.clone()]);
        let mut cursor = nodes[at]
            .parent
            .as_ref()
            .and_then(|parent| index.get(parent).copied());
        while let Some(current) = cursor {
            if !seen.insert(nodes[current].id.clone()) {
                nodes[at].parent = None;
                break;
            }
            cursor = nodes[current]
                .parent
                .as_ref()
                .and_then(|parent| index.get(parent).copied());
        }
    }
    // Workspace nodes in their usual place with nothing under them carry
    // nothing.
    let parents: HashSet<String> = nodes
        .iter()
        .filter_map(|node| node.parent.clone())
        .collect();
    let kept = nodes.into_iter().filter(|node| {
        let placed = node.parent.is_some() || node.group || node.root.is_some();
        placed || parents.contains(&node.id)
    });
    let nodes: Vec<Value> = kept
        .map(|node| {
            let mut out = Map::new();
            out.insert("id".into(), node.id.into());
            out.insert(
                "kind".into(),
                if node.group { "group" } else { "workspace" }.into(),
            );
            out.insert(
                "parent".into(),
                node.parent.map(Value::String).unwrap_or(Value::Null),
            );
            if let Some(label) = node.label {
                out.insert("label".into(), label.into());
                if node.collapsed {
                    out.insert("collapsed".into(), true.into());
                }
            }
            if let Some(reference) = node.reference {
                out.insert("ref".into(), reference);
            }
            if let Some(root) = node.root {
                out.insert("root".into(), root.into());
            }
            Value::Object(out)
        })
        .collect();
    json!({ "version": 1, "nodes": nodes })
}

/// The `workspace_tree` section: kept when it has nodes.
pub fn workspace_tree_section(raw: Option<&Value>) -> Option<Value> {
    let tree = parse_workspace_tree(raw);
    tree["nodes"]
        .as_array()
        .is_some_and(|nodes| !nodes.is_empty())
        .then_some(tree)
}

// ------------------------------------------------------------ rendered sites

/// shared/renderedPage.ts normalizeSite.
pub fn normalize_site(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    if utf16_len(text) > 2048 {
        return None;
    }
    let trimmed = js_trim(text);
    if trimmed.starts_with('/') {
        if trimmed.contains('\0') || trimmed.split('/').any(|part| part == ".." || part == ".") {
            return None;
        }
        return Some(if trimmed.ends_with('/') {
            trimmed.to_owned()
        } else {
            format!("{trimmed}/")
        });
    }
    let url = url::Url::parse(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return None;
    }
    let path = url.path();
    let path = if path.ends_with('/') {
        path
    } else {
        &path[..path.rfind('/').map_or(0, |at| at + 1)]
    };
    Some(format!("{}{path}", url.origin().ascii_serialization()))
}

/// shared/renderedPage.ts normalizeSiteList.
pub fn normalize_site_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut sites: Vec<String> = Vec::new();
    for item in items.iter().take(100) {
        if let Some(site) = normalize_site(item)
            && !sites.contains(&site)
        {
            sites.push(site);
        }
    }
    sites
}

/// shared/renderedPage.ts normalizeSiteRoots.
pub fn normalize_site_roots(value: Option<&Value>, sites: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(roots) = as_object(value) else {
        return out;
    };
    for (site, raw) in roots {
        if !sites.contains(site) {
            continue;
        }
        if let Some(root) = normalize_site(raw)
            && site.starts_with(&root)
        {
            out.insert(site.clone(), root.into());
        }
    }
    out
}

// --------------------------------------------------------------- mr_reviews

pub const MAX_EFFORTS: usize = 30;
pub const MAX_HOSTS: usize = 10;
pub const MAX_FOLLOWED: usize = 30;
pub const MAX_ORDER: usize = 500;
pub const MAX_PINNED: usize = 100;
pub const MAX_HIDDEN: usize = 300;
pub const MAX_OVERRIDES: usize = 500;
pub const MAX_VIEWS: usize = 20;
pub const VIEW_NAME_MAX: usize = 40;
pub const VIEW_QUERY_MAX: usize = 500;
pub const PANEL_SEARCH_MAX: usize = 500;
pub const HOME_PROMPT_MAX: usize = 4000;
pub const INFERENCE_MODEL_MAX: usize = 200;
pub const MAX_UPSTREAM_GROUPS: usize = 50;
pub const MAX_UPSTREAM_SKIP: usize = 200;
pub const MAX_UPSTREAM_WORKSPACES: usize = 200;
pub const MAX_UNSENT: usize = 200;
pub const MAX_MERGE_PATTERNS: usize = 20;
pub const MAX_MERGE_PATTERN: usize = 200;
pub const MAX_MERGE_SCOPES: usize = 50;
pub const NEXT_MAX: usize = 200;
pub const LABELS_MAX: usize = 10;
pub const LABEL_MAX: usize = 40;
pub const LINK_MAX: usize = 1000;
pub const DEPENDS_MAX: usize = 20;

static_regex!(host_re, r"(?i)^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$");
static_regex!(project_re, r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$");
static_regex!(ref_re, r"^refs/(heads|remotes)/[A-Za-z0-9_./-]{1,240}$");
static_regex!(remote_re, r"^[A-Za-z0-9_.-]{1,100}$");
static_regex!(branch_re, r"^[A-Za-z0-9_./-]{1,200}$");
static_regex!(effort_id_re, r"^[A-Za-z0-9_-]{1,64}$");
static_regex!(person_re, r"^[A-Za-z0-9_.-]{1,80}$");
static_regex!(bot_re, r"(?i)^@?[A-Za-z0-9_.-]{1,100}(\[bot\])?$");
static_regex!(
    scope_re,
    r"^[a-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9_.-]+)*(/\*)?$"
);

/// shared/forge.ts validHost.
pub fn valid_host(host: &str) -> bool {
    host_re().is_match(host) && host.len() <= 253
}

/// shared/forge.ts validProject.
pub fn valid_project(project: &str) -> bool {
    utf16_len(project) <= 300
        && project_re().is_match(project)
        && !project.split('/').any(|part| part == "." || part == "..")
}

fn provider(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_str) {
        Some("gitlab") => Some("gitlab"),
        Some("github") => Some("github"),
        _ => None,
    }
}

/// `list()`: the entries that are objects (arrays included).
fn records(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Array(items)) => items.iter().filter(|item| object_like(item)).collect(),
        _ => Vec::new(),
    }
}

/// `.replace(/^\/+|\/+$/g, "")`.
fn strip_slashes(text: &str) -> &str {
    text.trim_matches('/')
}

/// mrMergePattern: a pattern that compiles as `new RegExp(value, "iu")`.
pub fn mr_merge_pattern(text: &Value) -> Option<String> {
    let value = js_trim(text.as_str()?);
    if value.is_empty() || utf16_len(value) > MAX_MERGE_PATTERN {
        return None;
    }
    fancy_regex::Regex::new(&format!("(?i){value}"))
        .ok()
        .map(|_| value.to_owned())
}

/// mrBotName.
pub fn mr_bot_name(name: &str) -> String {
    let name = js_trim(name);
    let name = name.strip_prefix('@').unwrap_or(name);
    let name = match name.len().checked_sub(5) {
        Some(at)
            if name
                .get(at..)
                .is_some_and(|tail| tail.eq_ignore_ascii_case("[bot]")) =>
        {
            &name[..at]
        }
        _ => name,
    };
    name.to_lowercase()
}

/// mrMergeScope.
pub fn mr_merge_scope(text: &str) -> Option<String> {
    let lower = js_trim(text).to_lowercase();
    let value = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .unwrap_or(&lower);
    let value = value.trim_end_matches('/');
    (!value.is_empty() && utf16_len(value) <= 300 && scope_re().is_match(value))
        .then(|| value.to_owned())
}

const MERGE_LISTS: [&str; 4] = ["after_labels", "bots", "bot_failures", "queue_labels"];

fn merge_lists(raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(value) = raw.as_object() else {
        return out;
    };
    for stored in MERGE_LISTS {
        let Some(Value::Array(list)) = value.get(stored) else {
            continue;
        };
        let mut seen = HashSet::new();
        let kept: Vec<Value> = list
            .iter()
            .filter_map(|each| {
                if stored == "bots" {
                    each.as_str()
                        .filter(|text| bot_re().is_match(js_trim(text)))
                        .map(mr_bot_name)
                } else {
                    mr_merge_pattern(each)
                }
            })
            .filter(|checked| seen.insert(checked.clone()))
            .take(MAX_MERGE_PATTERNS)
            .map(Value::String)
            .collect();
        out.insert(stored.into(), Value::Array(kept));
    }
    out
}

/// normalizeStoredMerge.
pub fn normalize_stored_merge(raw: &Value) -> Option<Map<String, Value>> {
    let object = raw.as_object()?;
    let mut out = merge_lists(raw);
    if let Some(scopes) = as_object(object.get("scopes")) {
        let mut kept = Map::new();
        for (key, lists) in scopes.iter().take(MAX_MERGE_SCOPES) {
            let Some(scope) = mr_merge_scope(key) else {
                continue;
            };
            let checked = merge_lists(lists);
            if !checked.is_empty() {
                kept.insert(scope, Value::Object(checked));
            }
        }
        if !kept.is_empty() {
            out.insert("scopes".into(), Value::Object(kept));
        }
    }
    Some(out)
}

/// overrides.ts whoseOf.
pub fn whose_of(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(text) if matches!(text.as_str(), "me" | "reviewer" | "external") => {
            Some(Value::String(text.clone()))
        }
        Value::Object(object) => {
            let person = object.get("person")?.as_str()?;
            let person = person.strip_prefix('@').unwrap_or(person);
            person_re()
                .is_match(person)
                .then(|| json!({ "person": person }))
        }
        _ => None,
    }
}

/// overrides.ts textOf: spaces collapsed, trimmed, capped; None when empty.
pub fn text_of(value: Option<&Value>, max: usize) -> Option<String> {
    let text = tidy(value?.as_str()?, max);
    (!text.is_empty()).then_some(text)
}

/// overrides.ts labelsOf.
pub fn labels_of(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    let mut seen = HashSet::new();
    let labels: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .map(|each| tidy(each, LABEL_MAX))
        .filter(|each| !each.is_empty() && seen.insert(each.to_lowercase()))
        .take(LABELS_MAX)
        .collect();
    (!labels.is_empty()).then_some(labels)
}

/// overrides.ts keysOf.
pub fn keys_of(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    let mut seen = HashSet::new();
    let keys: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .filter(|each| !each.is_empty() && utf16_len(each) <= 600)
        .filter(|each| seen.insert(each.to_string()))
        .take(DEPENDS_MAX)
        .map(str::to_owned)
        .collect();
    (!keys.is_empty()).then_some(keys)
}

/// overrides.ts normalizeOverride.
pub fn normalize_override(raw: &Value) -> Option<Map<String, Value>> {
    let value = raw.as_object()?;
    let at = value
        .get("at")
        .and_then(Value::as_str)
        .map(|text| slice_utf16(text, 40))
        .unwrap_or("");
    let marker = value
        .get("marker")
        .and_then(Value::as_str)
        .map(|text| slice_utf16(text, 200))
        .unwrap_or("");
    let mut out = Map::new();
    if let Some(whose) = whose_of(value.get("whose")) {
        out.insert("whose".into(), whose);
    }
    if let Some(next) = text_of(value.get("next"), NEXT_MAX) {
        out.insert("next".into(), next.into());
    }
    if let Some(depends) = keys_of(value.get("depends_on")) {
        out.insert("depends_on".into(), depends.into());
    }
    if let Some(labels) = labels_of(value.get("labels")) {
        out.insert("labels".into(), labels.into());
    }
    if let Some(link) = text_of(value.get("link"), LINK_MAX) {
        out.insert("link".into(), link.into());
    }
    if let Some(stale) = value.get("stale").and_then(Value::as_bool) {
        out.insert("stale".into(), stale.into());
    }
    if out.is_empty() {
        return None;
    }
    out.insert(
        "at".into(),
        if at.is_empty() {
            "1970-01-01T00:00:00.000Z"
        } else {
            at
        }
        .into(),
    );
    out.insert(
        "by".into(),
        if value.get("by").and_then(Value::as_str) == Some("agent") {
            "agent"
        } else {
            "user"
        }
        .into(),
    );
    out.insert("marker".into(), marker.into());
    Some(out)
}

/// mr-reviews/settings.ts normalizeEffort.
pub fn normalize_effort(raw: &Value) -> Option<Value> {
    let value = raw.as_object()?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| effort_id_re().is_match(id))
        .unwrap_or("");
    let group = value
        .get("group")
        .and_then(Value::as_str)
        .filter(|group| word_id(group, 64))
        .unwrap_or("");
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(|name| tidy(name, 80))
        .unwrap_or_default();
    let field =
        |outer: &str, inner: &str| js_string(value.get(outer).and_then(|outer| outer.get(inner)));
    let connection = field("clone", "connection_id");
    let path = field("clone", "path");
    let source = js_string(value.get("source"));
    let remote = field("target", "remote");
    let branch = field("target", "branch");
    if id.is_empty()
        || group.is_empty()
        || name.is_empty()
        || connection.is_empty()
        || !path.starts_with('/')
        || !ref_re().is_match(&source)
        || !remote_re().is_match(&remote)
        || !branch_re().is_match(&branch)
    {
        return None;
    }
    let feeders: Vec<Value> = match value.get("feeders") {
        Some(Value::Array(items)) => {
            let mut seen = HashSet::new();
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|feeder| ref_re().is_match(feeder) && *feeder != source)
                .filter(|feeder| seen.insert(feeder.to_string()))
                .take(20)
                .map(Value::from)
                .collect()
        }
        _ => Vec::new(),
    };
    let head = value.get("head").and_then(|head| {
        let connection = head.get("connection_id")?.as_str()?;
        let path = head.get("path")?.as_str()?;
        if !path.starts_with('/') {
            return None;
        }
        let mut out = Map::new();
        out.insert("connection_id".into(), connection.into());
        out.insert("path".into(), path.into());
        if let Some(workspace) = head.get("workspace_id").and_then(Value::as_str) {
            out.insert("workspace_id".into(), workspace.into());
        }
        Some(Value::Object(out))
    });
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("group".into(), group.into());
    out.insert("name".into(), name.into());
    out.insert(
        "clone".into(),
        json!({ "connection_id": connection, "path": path }),
    );
    out.insert("source".into(), source.into());
    out.insert(
        "target".into(),
        json!({ "remote": remote, "branch": branch }),
    );
    if !feeders.is_empty() {
        out.insert("feeders".into(), Value::Array(feeders));
    }
    if let Some(head) = head {
        out.insert("head".into(), head);
    }
    Some(Value::Object(out))
}

/// mr-reviews/settings.ts viewName: a saved view's name, tidied, or None.
pub fn view_name(value: Option<&Value>) -> Option<String> {
    let name = tidy(value?.as_str()?, VIEW_NAME_MAX);
    (!name.is_empty() && !name.contains([':', '"'])).then_some(name)
}

fn integer_in(value: Option<&Value>, min: f64, max: f64) -> Option<Value> {
    let number = js_to_number(value);
    (is_integer(number) && number >= min && number <= max).then(|| number_value(number))
}

fn host_project(entry: &Value) -> (String, String) {
    let host = js_string(entry.get("host")).to_lowercase();
    let project = strip_slashes(&js_string(entry.get("project"))).to_owned();
    (host, project)
}

/// mr-reviews/settings.ts normalizeStoredMrReviews.
pub fn normalize_stored_mr_reviews(raw: Option<&Value>) -> Option<Value> {
    let value = as_object(raw)?;
    let mut out = Map::new();
    if let Some(Value::Array(_)) = value.get("hosts") {
        let mut seen = HashSet::new();
        let hosts: Vec<Value> = records(value.get("hosts"))
            .into_iter()
            .filter_map(|entry| {
                let host = js_string(entry.get("host")).to_lowercase();
                let kind = provider(entry.get("provider"))?;
                (valid_host(&host) && seen.insert(host.clone()))
                    .then(|| json!({ "host": host, "provider": kind }))
            })
            .take(MAX_HOSTS)
            .collect();
        out.insert("hosts".into(), Value::Array(hosts));
    }
    if let Some(Value::Array(_)) = value.get("followed") {
        let mut seen = HashSet::new();
        let followed: Vec<Value> = records(value.get("followed"))
            .into_iter()
            .filter_map(|entry| {
                let (host, project) = host_project(entry);
                let kind = provider(entry.get("provider"));
                let key = format!("{}/{}", host.to_lowercase(), project.to_lowercase());
                let kind = kind?;
                if !valid_host(&host) || !valid_project(&project) || seen.contains(&key) {
                    return None;
                }
                seen.insert(key);
                Some(json!({ "host": host, "provider": kind, "project": project }))
            })
            .take(MAX_FOLLOWED)
            .collect();
        out.insert("followed".into(), Value::Array(followed));
    }
    if let Some(checkout) = value
        .get("checkout")
        .and_then(Value::as_str)
        .filter(|checkout| matches!(*checkout, "immediately" | "on_demand"))
    {
        out.insert("checkout".into(), checkout.into());
    }
    if let Some(days) = integer_in(value.get("retention_days"), 0.0, 365.0) {
        out.insert("retention_days".into(), days);
    }
    for field in ["curation", "inference"] {
        if let Some(flag) = value.get(field).and_then(Value::as_bool) {
            out.insert(field.into(), flag.into());
        }
    }
    if let Some(hours) = integer_in(value.get("inference_hours"), 1.0, 168.0) {
        out.insert("inference_hours".into(), hours);
    }
    if let Some(model) = value.get("inference_model").and_then(Value::as_str) {
        let model = slice_utf16(js_trim(model), INFERENCE_MODEL_MAX);
        if !model.is_empty() && !model.chars().any(js_whitespace) {
            out.insert("inference_model".into(), model.into());
        }
    }
    if let Some(days) = integer_in(value.get("suggest_days"), 1.0, 365.0) {
        out.insert("suggest_days".into(), days);
    }
    if let Some(hints) = value.get("hints").and_then(Value::as_str) {
        out.insert("hints".into(), slice_utf16(hints, 2000).into());
    }
    if let Some(prompt) = value.get("home_prompt").and_then(Value::as_str) {
        out.insert(
            "home_prompt".into(),
            slice_utf16(prompt, HOME_PROMPT_MAX).into(),
        );
    }
    if let Some(panel) = as_object(value.get("panel")) {
        let filter = panel.get("filter").and_then(Value::as_str).unwrap_or("all");
        let filter = if matches!(filter, "all" | "review" | "mine")
            || (filter.starts_with("view:") && utf16_len(filter) <= 80)
        {
            filter
        } else {
            "all"
        };
        out.insert(
            "panel".into(),
            json!({
                "search": panel.get("search").and_then(Value::as_str).map(|text| slice_utf16(text, PANEL_SEARCH_MAX)).unwrap_or(""),
                "filter": filter,
                "at": panel.get("at").and_then(Value::as_str).map(|text| slice_utf16(text, 40)).unwrap_or(""),
            }),
        );
    }
    if let Some(groups) = as_object(value.get("tree_groups")) {
        let mut kept = Map::new();
        for (key, path) in groups {
            let Some(path) = path.as_array().filter(|_| key.contains('/')) else {
                continue;
            };
            let names: Vec<Value> = path
                .iter()
                .filter_map(Value::as_str)
                .map(|part| slice_utf16(js_trim(part), 120).to_owned())
                .filter(|part| !part.is_empty())
                .take(6)
                .map(Value::String)
                .collect();
            if !names.is_empty() {
                kept.insert(key.to_lowercase(), Value::Array(names));
            }
        }
        out.insert("tree_groups".into(), Value::Object(kept));
    }
    if let Some(clones) = as_object(value.get("clones")) {
        let mut kept = Map::new();
        for (key, entry) in clones {
            let path = js_string(entry.get("path"));
            let connection = js_string(entry.get("connection_id"));
            if path.starts_with('/') && !connection.is_empty() && key.contains('/') {
                kept.insert(
                    key.to_lowercase(),
                    json!({ "connection_id": connection, "path": path }),
                );
            }
        }
        out.insert("clones".into(), Value::Object(kept));
    }
    if let Some(Value::Array(order)) = value.get("order") {
        let mut seen = HashSet::new();
        let kept: Vec<Value> = order
            .iter()
            .filter_map(Value::as_str)
            .filter(|key| !key.is_empty() && utf16_len(key) <= 600)
            .filter(|key| seen.insert(key.to_string()))
            .take(MAX_ORDER)
            .map(Value::from)
            .collect();
        out.insert("order".into(), Value::Array(kept));
    }
    let version = js_to_number(value.get("order_version"));
    if is_safe_integer(version) && version > 0.0 {
        out.insert("order_version".into(), number_value(version));
    }
    if let Some(Value::Array(_)) = value.get("pinned") {
        let mut seen = HashSet::new();
        let pinned: Vec<Value> = records(value.get("pinned"))
            .into_iter()
            .filter_map(|entry| {
                let (host, project) = host_project(entry);
                let kind = provider(entry.get("provider"))?;
                let number = js_to_number(entry.get("number"));
                if !valid_host(&host) || !valid_project(&project) || !is_safe_integer(number) || number <= 0.0 {
                    return None;
                }
                let key = format!(
                    "{kind}:{}/{}#{}",
                    host.to_lowercase(),
                    project.to_lowercase(),
                    number as i64
                );
                seen.insert(key).then(|| {
                    json!({ "provider": kind, "host": host, "project": project, "number": number as i64 })
                })
            })
            .take(MAX_PINNED)
            .collect();
        out.insert("pinned".into(), Value::Array(pinned));
    }
    if let Some(Value::Array(_)) = value.get("hidden") {
        let mut seen = HashSet::new();
        let hidden: Vec<Value> = records(value.get("hidden"))
            .into_iter()
            .filter_map(|entry| {
                let key = entry.get("key")?.as_str()?;
                let marker = entry.get("marker")?.as_str()?;
                if key.is_empty() || utf16_len(key) > 600 || utf16_len(marker) > 200 {
                    return None;
                }
                seen.insert(key.to_owned())
                    .then(|| json!({ "key": key, "marker": marker }))
            })
            .collect();
        let skip = hidden.len().saturating_sub(MAX_HIDDEN);
        out.insert(
            "hidden".into(),
            Value::Array(hidden.into_iter().skip(skip).collect()),
        );
    }
    if let Some(overrides) = as_object(value.get("overrides")) {
        let mut kept: Vec<(String, Map<String, Value>)> = overrides
            .iter()
            .filter(|(key, _)| !key.is_empty() && utf16_len(key) <= 600)
            .filter_map(|(key, raw)| normalize_override(raw).map(|value| (key.clone(), value)))
            .collect();
        // localeCompare of ISO times: their code point order.
        kept.sort_by(|(_, a), (_, b)| {
            a["at"]
                .as_str()
                .unwrap_or("")
                .cmp(b["at"].as_str().unwrap_or(""))
        });
        let skip = kept.len().saturating_sub(MAX_OVERRIDES);
        out.insert(
            "overrides".into(),
            Value::Object(
                kept.into_iter()
                    .skip(skip)
                    .map(|(key, value)| (key, Value::Object(value)))
                    .collect(),
            ),
        );
    }
    if let Some(Value::Array(_)) = value.get("views") {
        let mut seen = HashSet::new();
        let views: Vec<Value> = records(value.get("views"))
            .into_iter()
            .filter_map(|entry| {
                let name = view_name(entry.get("name"));
                let query = entry
                    .get("query")
                    .and_then(Value::as_str)
                    .map(|query| slice_utf16(js_trim(query), VIEW_QUERY_MAX).to_owned())
                    .unwrap_or_default();
                let name = name?;
                if query.is_empty() || !seen.insert(name.to_lowercase()) {
                    return None;
                }
                Some(json!({ "name": name, "query": query }))
            })
            .take(MAX_VIEWS)
            .collect();
        out.insert("views".into(), Value::Array(views));
    }
    if let Some(Value::Array(groups)) = value.get("upstream_groups") {
        let mut seen = HashSet::new();
        let kept: Vec<Value> = groups
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| word_id(id, 64))
            .filter(|id| seen.insert(id.to_string()))
            .take(MAX_UPSTREAM_GROUPS)
            .map(Value::from)
            .collect();
        out.insert("upstream_groups".into(), Value::Array(kept));
    }
    let refs = |list: &[Value], max: usize| {
        let mut seen = HashSet::new();
        Value::Array(
            list.iter()
                .filter_map(parse_workspace_ref)
                .filter(|reference| seen.insert(workspace_ref_key(reference)))
                .take(max)
                .collect(),
        )
    };
    if let Some(Value::Array(skip)) = value.get("upstream_skip") {
        out.insert("upstream_skip".into(), refs(skip, MAX_UPSTREAM_SKIP));
    }
    if let Some(Value::Array(workspaces)) = value.get("upstream_workspaces") {
        out.insert(
            "upstream_workspaces".into(),
            refs(workspaces, MAX_UPSTREAM_WORKSPACES),
        );
    }
    if let Some(Value::Array(_)) = value.get("unsent") {
        let mut seen = HashSet::new();
        let unsent: Vec<Value> = records(value.get("unsent"))
            .into_iter()
            .filter_map(|entry| {
                let key = entry.get("key")?.as_str()?;
                if !key.starts_with("branch:")
                    || utf16_len(key) > 600
                    || !seen.insert(key.to_owned())
                {
                    return None;
                }
                let title = entry
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|title| tidy(title, 300))
                    .unwrap_or_default();
                let target = entry
                    .get("target")
                    .and_then(Value::as_str)
                    .map(|target| slice_utf16(js_trim(target), 200).to_owned())
                    .unwrap_or_default();
                let mut out = Map::new();
                out.insert("key".into(), key.into());
                if !title.is_empty() {
                    out.insert("title".into(), title.into());
                }
                if !target.is_empty() {
                    out.insert("target".into(), target.into());
                }
                out.insert(
                    "at".into(),
                    entry
                        .get("at")
                        .and_then(Value::as_str)
                        .map(|at| slice_utf16(at, 40))
                        .unwrap_or("")
                        .into(),
                );
                Some(Value::Object(out))
            })
            .take(MAX_UNSENT)
            .collect();
        out.insert("unsent".into(), Value::Array(unsent));
    }
    if let Some(Value::Array(efforts)) = value.get("efforts") {
        let mut seen = HashSet::new();
        let kept: Vec<Value> = efforts
            .iter()
            .filter_map(normalize_effort)
            .filter(|effort| seen.insert(effort["id"].as_str().unwrap_or("").to_owned()))
            .take(MAX_EFFORTS)
            .collect();
        out.insert("efforts".into(), Value::Array(kept));
    }
    if let Some(days) = integer_in(value.get("stale_days"), 1.0, 3650.0) {
        out.insert("stale_days".into(), days);
    }
    if let Some(merge) = value.get("merge").and_then(normalize_stored_merge)
        && !merge.is_empty()
    {
        out.insert("merge".into(), Value::Object(merge));
    }
    Some(Value::Object(out))
}
