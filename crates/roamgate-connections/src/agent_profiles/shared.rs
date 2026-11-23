//! shared/agentProfiles.ts as the server uses it: the profiles offered,
//! how a profile starts its agent, what a browser sees of one, and the
//! usage limits and models read from a session's transcript. Validation
//! and normalisation are the settings store's own
//! (`roamgate_base::settings::sections`), re-exported here. Held to
//! contract/vectors/agent-profiles.json, as the TS side is.
//!
//! A profile is Bun's JavaScript object (`{name, agent, command?, env?,
//! unset?}`) as a `serde_json` value, in its order.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use roamgate_base::log::{parse_iso_millis, slice_utf16};
pub use roamgate_base::settings::sections::{
    BUILTIN_PROFILE_NAME, MAX_PROFILE_ENV, MAX_PROFILES, normalize_profile,
    normalize_profiles_settings, profile_error,
};
use serde_json::{Map, Value, json};

use crate::agent_models::{same_model, short_model_name};
use crate::agent_profiles::time::{zone_date, zone_offset_ms, zoned_time};
use crate::usage_limit::usage_limit_stop_of;
use roamgate_base::settings::js_trim;

/// The agents a profile may name (`PROFILE_AGENTS`).
pub const PROFILE_AGENTS: &[&str] = &["claude"];

/// The program of each agent driver (`PROGRAM_BY_AGENT`).
const PROGRAM_BY_AGENT: &[(&str, &str)] = &[("claude", "claude")];

/// The driver's own program of an agent.
pub fn program_by_agent(agent: &str) -> &'static str {
    PROGRAM_BY_AGENT
        .iter()
        .find(|(name, _)| *name == agent)
        .map_or("claude", |(_, program)| program)
}

/// Claude Code's model slots a profile may fill: env name, label.
pub const MODEL_SLOTS: &[(&str, &str)] = &[
    ("ANTHROPIC_MODEL", "Main model"),
    ("ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus slot"),
    ("ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet slot"),
    ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku slot"),
    ("ANTHROPIC_SMALL_FAST_MODEL", "Small, fast model"),
    ("CLAUDE_CODE_SUBAGENT_MODEL", "Subagent model"),
];

/// The built-in profile: plain `claude`.
pub fn builtin_profile() -> Value {
    json!({"name": BUILTIN_PROFILE_NAME, "agent": "claude"})
}

/// The settings without any profile of the user's.
pub fn default_profiles_settings() -> Value {
    normalize_profiles_settings(None)
}

/// A profile's name ("" when it has none).
pub fn profile_name(profile: &Value) -> &str {
    profile.get("name").and_then(Value::as_str).unwrap_or("")
}

/// A profile's agent ("claude" when it says none).
pub fn profile_agent(profile: &Value) -> &str {
    profile
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("claude")
}

fn env_of(profile: &Value) -> Option<&Map<String, Value>> {
    profile.get("env").and_then(Value::as_object)
}

/// JavaScript truthiness of an env value: non-empty text or a file.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

/// Why a whole settings value is not valid, or None.
pub fn profiles_settings_error(raw: &Value) -> Option<String> {
    let Some(raw) = raw.as_object() else {
        return Some("profiles must be an object".into());
    };
    let Some(list) = raw.get("list").and_then(Value::as_array) else {
        return Some("profiles.list must be a list".into());
    };
    if list.len() > MAX_PROFILES {
        return Some(format!("At most {MAX_PROFILES} profiles"));
    }
    let mut names = BTreeSet::new();
    for each in list {
        if let Some(error) = profile_error(each) {
            return Some(error);
        }
        let name = js_trim(profile_name(each));
        if !names.insert(name.to_lowercase()) {
            return Some(format!("Two profiles are named {name}"));
        }
    }
    match raw.get("default") {
        None => {}
        Some(Value::String(default)) => {
            let normalized: Vec<Value> = list.iter().filter_map(normalize_profile).collect();
            if profile_named(&normalized, Some(default)).is_none() {
                return Some(format!("No profile is named {default}"));
            }
        }
        Some(_) => return Some("profiles.default must be a profile name".into()),
    }
    match raw.get("return_after_reset") {
        None | Some(Value::Bool(_)) => None,
        Some(_) => Some("profiles.return_after_reset must be true or false".into()),
    }
}

/// Every profile offered: the built-in Claude first unless redefined.
pub fn all_profiles(list: &[Value]) -> Vec<Value> {
    let own = list
        .iter()
        .any(|each| profile_name(each).to_lowercase() == BUILTIN_PROFILE_NAME.to_lowercase());
    if own {
        list.to_vec()
    } else {
        let mut all = vec![builtin_profile()];
        all.extend(list.iter().cloned());
        all
    }
}

/// The profile of that name (case-insensitive), the built-in included.
pub fn profile_named(list: &[Value], name: Option<&str>) -> Option<Value> {
    let name = name.filter(|name| !name.is_empty())?;
    let wanted = js_trim(name).to_lowercase();
    all_profiles(list)
        .into_iter()
        .find(|each| profile_name(each).to_lowercase() == wanted)
}

/// The program a profile runs.
pub fn profile_program(profile: &Value) -> String {
    match profile.get("command").and_then(Value::as_str) {
        Some(command) if !command.is_empty() => command.to_owned(),
        _ => program_by_agent(profile_agent(profile)).to_owned(),
    }
}

/// A profile that changes nothing: the driver's own program, no
/// environment.
pub fn is_plain_profile(profile: &Value) -> bool {
    profile_program(profile) == program_by_agent(profile_agent(profile))
        && env_of(profile).is_none_or(Map::is_empty)
        && profile
            .get("unset")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
}

/// What a profile's environment implies is removed.
fn implied_unset(key: &str) -> &'static [&'static str] {
    match key {
        "ANTHROPIC_AUTH_TOKEN" => &[
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ],
        "ANTHROPIC_API_KEY" => &[
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        ],
        "ANTHROPIC_BASE_URL" => &["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
        _ => &[],
    }
}

/// The variables a profile removes: its own list and the implied ones,
/// sorted (by UTF-16 units, as JavaScript's sort).
pub fn profile_unset(profile: &Value) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !names.iter().any(|each| each == name) {
            names.push(name.to_owned());
        }
    };
    for name in profile
        .get("unset")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(name) = name.as_str() {
            add(name);
        }
    }
    let env = env_of(profile);
    for key in env.into_iter().flat_map(Map::keys) {
        for implied in implied_unset(key) {
            add(implied);
        }
    }
    names.retain(|name| env.is_none_or(|env| !env.contains_key(name)));
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    names
}

/// What a browser is shown of a profile: secret files by path only.
pub fn profile_view(profile: &Value, builtin: bool) -> Value {
    let mut view = Map::new();
    view.insert("name".into(), json!(profile_name(profile)));
    view.insert("agent".into(), json!(profile_agent(profile)));
    if let Some(command) = profile.get("command").and_then(Value::as_str)
        && !command.is_empty()
    {
        view.insert("command".into(), json!(command));
    }
    view.insert("builtin".into(), json!(builtin));
    let env: Vec<Value> = env_of(profile)
        .into_iter()
        .flatten()
        .map(|(name, value)| match value {
            Value::String(text) => json!({"name": name, "value": text}),
            other => {
                json!({"name": name, "file": other.get("file").cloned().unwrap_or(Value::Null)})
            }
        })
        .collect();
    view.insert("env".into(), Value::Array(env));
    view.insert(
        "unset".into(),
        profile.get("unset").cloned().unwrap_or_else(|| json!([])),
    );
    Value::Object(view)
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// When "5:20pm (America/Santiago)" or "Oct 5 at 8am (America/Santiago)"
/// comes next after `now`; None when the words are not a time.
pub fn parse_reset_time(words: &str, now: i64) -> Option<i64> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:([A-Za-z]{3})[a-z]*\.?\s+([0-9]{1,2})(?:,?\s+([0-9]{4}))?\s+(?:at\s+)?)?([0-9]{1,2})(?::([0-9]{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?\s*$",
        )
        .unwrap()
    });
    let captures = RE.captures(js_trim(words))?;
    let number = |index: usize| -> Option<i64> {
        captures
            .get(index)
            .and_then(|m| m.as_str().parse::<i64>().ok())
    };
    let mut hour = number(4)?;
    let minute_word = captures.get(5);
    let minute = number(5).unwrap_or(0);
    if hour > 23 || minute > 59 {
        return None;
    }
    if let Some(ampm) = captures.get(6) {
        if !(1..=12).contains(&hour) {
            return None;
        }
        hour = hour % 12
            + if ampm.as_str().eq_ignore_ascii_case("pm") {
                12
            } else {
                0
            };
    } else if minute_word.is_none() {
        return None;
    }
    let zone = captures
        .get(7)
        .map(|zone| js_trim(zone.as_str()).to_owned())
        .filter(|zone| !zone.is_empty());
    let zone = zone.as_deref();
    if let Some(zone) = zone
        && zone_offset_ms(zone, now).is_none()
    {
        return None;
    }
    let minutes = hour * 60 + minute;
    let today = zone_date(now, zone);
    if let Some(month_word) = captures.get(1) {
        let month = MONTHS
            .iter()
            .position(|each| each.eq_ignore_ascii_case(month_word.as_str()))?
            as i64;
        let day = number(2)?;
        let year_word = number(3);
        let mut year = year_word.unwrap_or(today.0);
        let mut at = zoned_time(year, month, day, minutes, zone);
        // "Jan 2" read in December is next year's.
        if let Some(found) = at
            && year_word.is_none()
            && found < now - 86_400_000
        {
            year += 1;
            at = zoned_time(year, month, day, minutes, zone);
        }
        return at;
    }
    let mut at = zoned_time(today.0, today.1, today.2, minutes, zone);
    if let Some(found) = at
        && found <= now
    {
        let tomorrow = zone_date(found + 86_400_000 + 3_600_000, zone);
        at = zoned_time(tomorrow.0, tomorrow.1, tomorrow.2, minutes, zone);
    }
    at
}

/// A usage limit an agent hit, from its message (`UsageLimit`): `kind`,
/// `resets`, `resets_at`, `zone?`, `message` (then `at?`), in Bun's order.
pub fn parse_usage_limit(text: &str, now: i64) -> Option<Value> {
    static HIT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)(?:you(?:'|\x{2019})ve|you have) (?:hit|reached) your (?:([^\n\r\x{2028}\x{2029}]{1,40}?) )?limit(?:\s*[\x{b7}\x{2022}|-]\s*resets\s+([^\n]{1,80}))?",
        )
        .unwrap()
    });
    static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.\s]+$").unwrap());
    static ZONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(([^)]+)\)\s*$").unwrap());
    static LEGACY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)Claude AI usage limit reached\|([0-9]{9,11})").unwrap());
    static CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b429\b").unwrap());
    static RATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)rate[_ ]limit").unwrap());
    static ERROR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)error").unwrap());

    if text.is_empty() {
        return None;
    }
    let message = slice_utf16(js_trim(text), 400).to_owned();
    if let Some(hit) = HIT.captures(&message) {
        let resets = hit
            .get(2)
            .map(|resets| TRAILING.replace(js_trim(resets.as_str()), "").into_owned())
            .filter(|resets| !resets.is_empty());
        let zone = resets.as_deref().and_then(|resets| {
            ZONE.captures(resets)
                .map(|zone| js_trim(&zone[1]).to_owned())
                .filter(|zone| !zone.is_empty())
        });
        let kind = hit
            .get(1)
            .map(|kind| js_trim(kind.as_str()).to_owned())
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| "usage".into());
        let mut limit = Map::new();
        limit.insert("kind".into(), json!(kind));
        limit.insert("resets".into(), json!(resets));
        limit.insert(
            "resets_at".into(),
            json!(
                resets
                    .as_deref()
                    .and_then(|resets| parse_reset_time(resets, now))
            ),
        );
        if let Some(zone) = zone {
            limit.insert("zone".into(), json!(zone));
        }
        limit.insert("message".into(), json!(message));
        return Some(Value::Object(limit));
    }
    if let Some(legacy) = LEGACY.captures(&message) {
        let seconds: i64 = legacy[1].parse().ok()?;
        return Some(json!({
            "kind": "usage",
            "resets": null,
            "resets_at": seconds * 1000,
            "message": "Claude AI usage limit reached",
        }));
    }
    if CODE.is_match(&message) && RATE.is_match(&message) && ERROR.is_match(&message) {
        return Some(
            json!({"kind": "rate", "resets": null, "resets_at": null, "message": message}),
        );
    }
    None
}

/// The model a profile runs, for a chip; its name when it sets no model.
pub fn profile_model_label(profile: &Value) -> String {
    match env_of(profile)
        .and_then(|env| env.get("ANTHROPIC_MODEL"))
        .and_then(Value::as_str)
    {
        Some(model) if !js_trim(model).is_empty() => short_model_name(model),
        _ => profile_name(profile).to_owned(),
    }
}

/// Each JSON line of a transcript's end, newest first, that passes
/// `keep` on its text.
fn records_newest_first<'a>(
    tail: &'a str,
    keep: impl Fn(&str) -> bool + 'a,
) -> impl Iterator<Item = Map<String, Value>> + 'a {
    tail.split('\n').rev().filter_map(move |line| {
        let line = js_trim(line);
        if !line.starts_with('{') || !keep(line) {
            return None;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(record)) => Some(record),
            _ => None,
        }
    })
}

fn object<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    record.get(key).and_then(Value::as_object)
}

fn timestamp_of(record: &Map<String, Value>) -> Option<i64> {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_millis)
}

/// The usage limit a session stopped on, from the end of its transcript:
/// the newest assistant record decides.
pub fn latest_usage_limit(tail: &str, now: i64) -> Option<Value> {
    for record in records_newest_first(tail, |line| line.contains("\"assistant\"")) {
        if record.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if record.get("isApiErrorMessage") != Some(&Value::Bool(true)) {
            return None;
        }
        let text = match object(&record, "message").and_then(|message| message.get("content")) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        let at = timestamp_of(&record);
        let mut limit = parse_usage_limit(&text, at.unwrap_or(now)).or_else(|| {
            (record.get("error").and_then(Value::as_str) == Some("rate_limit")).then(|| {
                json!({
                    "kind": "usage",
                    "resets": null,
                    "resets_at": null,
                    "message": slice_utf16(js_trim(&text), 400),
                })
            })
        })?;
        // Claude Code's own fields, when it wrote them, say the reset exactly.
        if let Some(stop) = usage_limit_stop_of(&Value::Object(record.clone())) {
            limit["resets_at"] = json!(stop.resets_at);
        }
        if let Some(resets_at) = limit["resets_at"].as_i64()
            && resets_at <= now
        {
            return None;
        }
        if let Some(at) = at {
            limit["at"] = json!(at);
        }
        return Some(limit);
    }
    None
}

/// A model a transcript answered with, and when (epoch ms; None when the
/// record does not say).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionAnswer {
    pub model: String,
    pub at: Option<i64>,
}

/// The model a session's transcript last answered with, among those
/// `wanted` accepts.
pub fn latest_session_answer(tail: &str, wanted: impl Fn(&str) -> bool) -> Option<SessionAnswer> {
    for record in records_newest_first(tail, |line| line.contains("\"assistant\"")) {
        if record.get("type").and_then(Value::as_str) != Some("assistant")
            || record.get("isApiErrorMessage") == Some(&Value::Bool(true))
        {
            continue;
        }
        let Some(model) = object(&record, "message")
            .and_then(|message| message.get("model"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if model.is_empty() || model == "<synthetic>" || !wanted(model) {
            continue;
        }
        return Some(SessionAnswer {
            model: model.to_owned(),
            at: timestamp_of(&record),
        });
    }
    None
}

/// The model a session's transcript last names, whichever agent wrote it.
pub fn latest_transcript_model(tail: &str) -> Option<String> {
    static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""model(?:Id)?""#).unwrap());
    for record in records_newest_first(tail, |line| MODEL.is_match(line)) {
        let message = object(&record, "message");
        let kind = record.get("type").and_then(Value::as_str);
        let model = match kind {
            Some("assistant") if record.get("isApiErrorMessage") != Some(&Value::Bool(true)) => {
                message.and_then(|message| message.get("model"))
            }
            Some("message")
                if message.and_then(|message| message.get("role")) == Some(&json!("assistant")) =>
            {
                message.and_then(|message| message.get("model"))
            }
            Some("model_change") => record.get("modelId"),
            Some("turn_context") => {
                object(&record, "payload").and_then(|payload| payload.get("model"))
            }
            _ => None,
        };
        if let Some(model) = model.and_then(Value::as_str)
            && !js_trim(model).is_empty()
            && model != "<synthetic>"
        {
            return Some(js_trim(model).to_owned());
        }
    }
    None
}

/// The model of [`latest_session_answer`].
pub fn latest_session_model(tail: &str, wanted: impl Fn(&str) -> bool) -> Option<String> {
    latest_session_answer(tail, wanted).map(|answer| answer.model)
}

/// A session's own model choice: the model, what it resolved to, when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChoice {
    pub model: String,
    pub resolved: Option<String>,
    pub at: String,
}

/// Whether a session started with a model of its own has answered with
/// it since.
pub fn chosen_model_answered(
    answer: &SessionAnswer,
    choice: &ModelChoice,
    profile: &Value,
) -> bool {
    if same_model(&answer.model, &choice.model) {
        return true;
    }
    if let Some(resolved) = &choice.resolved
        && same_model(&answer.model, resolved)
    {
        return true;
    }
    match (answer.at, parse_iso_millis(&choice.at)) {
        (Some(at), Some(chosen_at)) => {
            at > chosen_at && profile_serves_model(profile, &answer.model)
        }
        _ => false,
    }
}

/// Whether a profile's endpoint has a model.
pub fn profile_serves_model(profile: &Value, model: &str) -> bool {
    let env = env_of(profile);
    if !truthy(env.and_then(|env| env.get("ANTHROPIC_BASE_URL"))) {
        return model.starts_with("claude-");
    }
    MODEL_SLOTS.iter().any(|(slot, _)| {
        env.and_then(|env| env.get(*slot))
            .and_then(Value::as_str)
            .is_some_and(|value| value == model)
    })
}

/// The model a session must be started with on a profile it moves to.
pub fn switch_model(tail: Option<&str>, profile: &Value) -> Option<String> {
    let tail = tail.filter(|tail| !tail.is_empty())?;
    let last = latest_session_model(tail, |_| true)?;
    if profile_serves_model(profile, &last) {
        return None;
    }
    if let Some(served) = latest_session_model(tail, |model| profile_serves_model(profile, model)) {
        return Some(served);
    }
    let env = env_of(profile);
    if let Some(own) = env
        .and_then(|env| env.get("ANTHROPIC_MODEL"))
        .and_then(Value::as_str)
        .filter(|own| !own.is_empty())
    {
        return Some(own.to_owned());
    }
    if truthy(env.and_then(|env| env.get("ANTHROPIC_BASE_URL"))) {
        None
    } else {
        Some("opus".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    fn arg(call: &vectors::Call, index: usize) -> Value {
        call.args.get(index).cloned().unwrap_or(Value::Null)
    }

    fn text(call: &vectors::Call, index: usize) -> Option<String> {
        vectors::text(&arg(call, index))
    }

    fn list(value: &Value) -> Vec<Value> {
        value.as_array().cloned().unwrap_or_default()
    }

    fn run(call: &vectors::Call) -> Value {
        let now = || arg(call, 1).as_i64().expect("a time");
        match call.target().as_str() {
            "agentProfiles.allProfiles" => Value::Array(all_profiles(&list(&arg(call, 0)))),
            "agentProfiles.isPlainProfile" => json!(is_plain_profile(&arg(call, 0))),
            "agentProfiles.profileNamed" => {
                json!(profile_named(&list(&arg(call, 0)), arg(call, 1).as_str()))
            }
            "agentProfiles.normalizeProfilesSettings" => {
                normalize_profiles_settings(call.args.first())
            }
            "agentProfiles.profileUnset" => json!(profile_unset(&arg(call, 0))),
            "agentProfiles.profileError" => json!(profile_error(&arg(call, 0))),
            "agentProfiles.profilesSettingsError" => json!(profiles_settings_error(&arg(call, 0))),
            "agentProfiles.profileView" => {
                profile_view(&arg(call, 0), arg(call, 1).as_bool().unwrap_or(false))
            }
            "agentProfiles.parseResetTime" => {
                json!(parse_reset_time(&text(call, 0).unwrap(), now()))
            }
            "agentProfiles.parseUsageLimit" => {
                json!(parse_usage_limit(&text(call, 0).unwrap(), now()))
            }
            "agentProfiles.latestUsageLimit" => {
                json!(latest_usage_limit(&text(call, 0).unwrap(), now()))
            }
            "agentProfiles.profileModelLabel" => json!(profile_model_label(&arg(call, 0))),
            "agentProfiles.latestSessionModel" => {
                json!(latest_session_model(&text(call, 0).unwrap(), |_| true))
            }
            "agentProfiles.latestSessionAnswer" => {
                match latest_session_answer(&text(call, 0).unwrap(), |_| true) {
                    Some(answer) => json!({"model": answer.model, "at": answer.at}),
                    None => Value::Null,
                }
            }
            "agentProfiles.latestTranscriptModel" => {
                json!(latest_transcript_model(&text(call, 0).unwrap()))
            }
            "agentProfiles.chosenModelAnswered" => {
                let answer = arg(call, 0);
                let choice = arg(call, 1);
                json!(chosen_model_answered(
                    &SessionAnswer {
                        model: answer["model"].as_str().unwrap().into(),
                        at: answer["at"].as_i64(),
                    },
                    &ModelChoice {
                        model: choice["model"].as_str().unwrap().into(),
                        resolved: choice["resolved"].as_str().map(str::to_owned),
                        at: choice["at"].as_str().unwrap().into(),
                    },
                    &arg(call, 2),
                ))
            }
            "agentProfiles.profileServesModel" => json!(profile_serves_model(
                &arg(call, 0),
                arg(call, 1).as_str().unwrap()
            )),
            "agentProfiles.switchModel" => {
                json!(switch_model(text(call, 0).as_deref(), &arg(call, 1)))
            }
            other => panic!("unknown function {other}"),
        }
    }

    /// Every case of contract/vectors/agent-profiles.json.
    #[test]
    fn agent_profiles_vectors() {
        let file = vectors::load("agent-profiles");
        assert!(!file.cases.is_empty());
        for case in &file.cases {
            for call in &case.calls {
                let expected = call.result.clone().unwrap_or(Value::Null);
                assert_eq!(run(call), expected, "{}", case.title());
            }
        }
    }
}
