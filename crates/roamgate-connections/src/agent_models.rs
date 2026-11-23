//! /model in conversation mode (shared/agentModels.ts): what was typed, how
//! model names compare, the picker's list from what the running agent and
//! the session's profile offer, and a model's short name for a chip. Held
//! to contract/vectors/agent-models.json, as the TS side is.
//!
//! Model rows (`AgentChatModel`: `value`, `label`, `description?`,
//! `resolved?`) are JavaScript objects as `serde_json` maps, in their order.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_base::log::{slice_utf16, utf16_len};
use serde_json::{Map, Value, json};

pub use roamgate_base::settings::js_trim;

/// `/model` alone (the picker, `Some(None)`) or `/model <name>`; None for
/// other text.
pub fn parse_model_command(text: &str) -> Option<Option<String>> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*/model(?:\s+(\S+))?\s*$").unwrap());
    RE.captures(text)
        .map(|captures| captures.get(1).map(|name| name.as_str().to_owned()))
}

/// What a model name may be: letters, digits and . _ : / @ [ ] -, starting
/// with a letter or digit ("sonnet", "claude-opus-5-5", "opus[1m]").
pub fn is_model_name(value: &str) -> bool {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:/@\[\]-]{0,255}$").unwrap());
    RE.is_match(value)
}

/// A model name compared: case and a context tag ("[1m]") left out.
fn model_key(value: &str) -> String {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[^\]]*\]$").unwrap());
    let lower = js_trim(value).to_lowercase();
    TAG.replace(&lower, "").into_owned()
}

/// Whether two names are one model: the same once case and a context tag
/// are left out, or one the other with a release date
/// ("claude-haiku-4-5-20251001" is "claude-haiku-4-5").
pub fn same_model(a: &str, b: &str) -> bool {
    let left = model_key(a);
    let right = model_key(b);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    let (short, long) = if left.len() < right.len() {
        (&left, &right)
    } else {
        (&right, &left)
    };
    let Some(rest) = long
        .strip_prefix(short.as_str())
        .and_then(|rest| rest.strip_prefix('-'))
    else {
        return false;
    };
    rest.len() == 8 && rest.bytes().all(|byte| byte.is_ascii_digit())
}

/// The "default" row offered when the running agent lists nothing.
pub fn default_model_row() -> Value {
    json!({"value": "default", "label": "Default", "description": "The profile's own model"})
}

fn row_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// The picker's list: what the running agent offers (its own names and
/// descriptions, in its order), then what the session's profile offers
/// that no row covers yet. Without the agent's list, a "default" row,
/// then the profile's.
pub fn merge_models(agent: Option<&[Value]>, offered: &[String]) -> Vec<Value> {
    let mut rows: Vec<Value> = match agent {
        Some(agent) if !agent.is_empty() => agent.to_vec(),
        _ => vec![default_model_row()],
    };
    for id in offered {
        if id.is_empty() || !is_model_name(id) {
            continue;
        }
        let covered = rows.iter().any(|row| {
            row_text(row, "value").is_some_and(|value| same_model(value, id))
                || row_text(row, "resolved").is_some_and(|resolved| same_model(resolved, id))
        });
        if !covered {
            rows.push(json!({"value": id, "label": id}));
        }
    }
    rows
}

/// The row the session runs: the one last picked, else the one whose name
/// or model is the one it runs, spelled the same first, else the same
/// model; the first in the list's order. None when none says.
pub fn current_model_value(
    models: &[Value],
    current: Option<&str>,
    chosen: Option<&str>,
) -> Option<String> {
    let value = |row: &Value| row_text(row, "value").unwrap_or("").to_owned();
    if let Some(chosen) = chosen.filter(|chosen| !chosen.is_empty()) {
        let row = models
            .iter()
            .find(|each| row_text(each, "value") == Some(chosen))
            .or_else(|| {
                models
                    .iter()
                    .find(|each| same_model(row_text(each, "value").unwrap_or(""), chosen))
            });
        if let Some(row) = row {
            return Some(value(row));
        }
    }
    if let Some(current) = current.filter(|current| !current.is_empty()) {
        let spelled = js_trim(current).to_lowercase();
        let names = |row: &Value| -> Vec<String> {
            let mut names = vec![row_text(row, "value").unwrap_or("").to_owned()];
            if let Some(resolved) = row_text(row, "resolved") {
                names.push(resolved.to_owned());
            }
            names
        };
        let row = models
            .iter()
            .find(|each| {
                names(each)
                    .iter()
                    .any(|name| name.to_lowercase() == spelled)
            })
            .or_else(|| {
                models
                    .iter()
                    .find(|each| names(each).iter().any(|name| same_model(name, current)))
            });
        if let Some(row) = row {
            return Some(value(row));
        }
    }
    None
}

/// What the chat says of a switch: the name asked, and the model it is.
pub fn model_switch_text(requested: &str, model: Option<&str>, next_turn: bool) -> String {
    let named = match model {
        Some(model) if !model.is_empty() && !same_model(model, requested) => {
            format!("{requested} ({model})")
        }
        _ => requested.to_owned(),
    };
    format!(
        "Model set to {named}{}",
        if next_turn { " from the next turn" } else { "" }
    )
}

/// Past this, an agent's refusal is cut in the chat (a gateway's list).
const MAX_REFUSAL: usize = 400;

/// What the chat says of a switch that failed.
pub fn model_refusal_text(requested: &str, reason: &str) -> String {
    let trimmed = js_trim(reason);
    let text = if trimmed.is_empty() {
        "refused"
    } else {
        trimmed
    };
    let text = if utf16_len(text) > MAX_REFUSAL {
        format!("{}...", slice_utf16(text, MAX_REFUSAL - 3))
    } else {
        text.to_owned()
    };
    format!("Could not switch the model to {requested}: {text}")
}

/// Claude's model families, as their ids and aliases name them.
const CLAUDE_FAMILIES: &[&str] = &["opus", "sonnet", "haiku"];

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Between a model's provider and its name, a middle dot.
pub const MODEL_PROVIDER_SEPARATOR: &str = " \u{b7} ";

/// A model's short, readable name for a chip ("Opus 5.5" from
/// claude-opus-5-5, "igalia . GLM 5p3" from igalia/glm-5p3).
pub fn short_model_name(model: &str) -> String {
    let (provider, name) = short_model_parts(model);
    match provider {
        Some(provider) => format!("{provider}{MODEL_PROVIDER_SEPARATOR}{name}"),
        None => name,
    }
}

/// shortModelName's two parts: the provider prefix (None without one),
/// the name.
pub fn short_model_parts(model: &str) -> (Option<String>, String) {
    let trimmed = js_trim(model);
    let segments: Vec<&str> = trimmed.split('/').collect();
    let provider = if segments.len() > 1 && !segments[segments.len() - 1].is_empty() {
        Some(segments[segments.len() - 2]).filter(|provider| !provider.is_empty())
    } else {
        None
    };
    (provider.map(str::to_owned), model_name(trimmed))
}

fn model_name(model: &str) -> String {
    static TAGGED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]$").unwrap());
    static ANTHROPIC: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^(?:[a-z]{2,4}\.)?anthropic\.").unwrap());
    static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)-v\d+(?::\d+)?$").unwrap());
    static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-@]\d{8}$").unwrap());
    static MODERN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?$").unwrap());
    static OLDER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^claude-(\d+)(?:[-.](\d{1,2}))?-([a-z]+)$").unwrap());
    static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-_\s]+").unwrap());

    let mut rest = model.to_owned();
    let mut tag = String::new();
    if let Some(captures) = TAGGED.captures(&rest) {
        tag = js_trim(&captures[1]).to_uppercase();
        let index = captures.get(0).unwrap().start();
        rest = js_trim(&rest[..index]).to_owned();
    }
    let with_tag = |name: String| {
        if tag.is_empty() {
            name
        } else {
            format!("{name} {tag}")
        }
    };
    let last = match rest.rfind('/') {
        Some(index) if !rest[index + 1..].is_empty() => rest[index + 1..].to_owned(),
        Some(_) => rest.clone(),
        None => rest.clone(),
    };
    let claude = ANTHROPIC.replace(&last, "").into_owned();
    let claude = VERSION.replace(&claude, "").into_owned();
    let claude = DATE.replace(&claude, "").to_lowercase();
    if CLAUDE_FAMILIES.contains(&claude.as_str()) {
        return with_tag(capitalized(&claude));
    }
    if claude == "opusplan" {
        return with_tag("Opus plan".into());
    }
    if let Some(modern) = MODERN.captures(&claude)
        && CLAUDE_FAMILIES.contains(&&modern[1])
    {
        let minor = modern
            .get(3)
            .map(|m| format!(".{}", m.as_str()))
            .unwrap_or_default();
        return with_tag(format!("{} {}{minor}", capitalized(&modern[1]), &modern[2]));
    }
    if let Some(older) = OLDER.captures(&claude)
        && CLAUDE_FAMILIES.contains(&&older[3])
    {
        let minor = older
            .get(2)
            .map(|m| format!(".{}", m.as_str()))
            .unwrap_or_default();
        return with_tag(format!("{} {}{minor}", capitalized(&older[3]), &older[1]));
    }
    let mut parts = WORDS.split(&last);
    let first = parts.next().unwrap_or("");
    let head = if utf16_len(first) <= 3 {
        first.to_uppercase()
    } else {
        capitalized(first)
    };
    let mut words = vec![head];
    words.extend(parts.map(str::to_owned));
    with_tag(slice_utf16(&words.join(" "), 40).to_owned())
}

/// A row as a map, for callers building rows.
pub fn model_row(value: &str, label: &str) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("value".into(), Value::String(value.into()));
    row.insert("label".into(), Value::String(label.into()));
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    fn arg(call: &vectors::Call, index: usize) -> Value {
        call.args.get(index).cloned().unwrap_or(Value::Null)
    }

    fn text(call: &vectors::Call, index: usize) -> String {
        vectors::text(&arg(call, index)).unwrap_or_default()
    }

    fn opt(value: &Value) -> Option<&str> {
        value.as_str()
    }

    fn run(call: &vectors::Call) -> Value {
        match call.target().as_str() {
            "agentModels.parseModelCommand" => match parse_model_command(&text(call, 0)) {
                Some(model) => json!({"model": model}),
                None => Value::Null,
            },
            "agentModels.isModelName" => json!(is_model_name(&text(call, 0))),
            "agentModels.sameModel" => json!(same_model(&text(call, 0), &text(call, 1))),
            "agentModels.shortModelName" => json!(short_model_name(&text(call, 0))),
            "agentModels.shortModelParts" => {
                let (provider, name) = short_model_parts(&text(call, 0));
                json!({"provider": provider, "name": name})
            }
            "agentModels.mergeModels" => {
                let agent = arg(call, 0);
                let offered: Vec<String> = arg(call, 1)
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .map(|each| each.as_str().unwrap_or_default().to_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                Value::Array(merge_models(agent.as_array().map(Vec::as_slice), &offered))
            }
            "agentModels.currentModelValue" => {
                let models = arg(call, 0);
                json!(current_model_value(
                    models.as_array().map(Vec::as_slice).unwrap_or_default(),
                    opt(&arg(call, 1)),
                    opt(&arg(call, 2)),
                ))
            }
            "agentModels.modelSwitchText" => {
                let next_turn = arg(call, 2)
                    .get("nextTurn")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                json!(model_switch_text(
                    &text(call, 0),
                    opt(&arg(call, 1)),
                    next_turn
                ))
            }
            "agentModels.modelRefusalText" => {
                json!(model_refusal_text(&text(call, 0), &text(call, 1)))
            }
            other => panic!("unknown function {other}"),
        }
    }

    /// Every case of contract/vectors/agent-models.json.
    #[test]
    fn agent_models_vectors() {
        let file = vectors::load("agent-models");
        assert!(!file.cases.is_empty());
        for case in &file.cases {
            for call in &case.calls {
                let expected = call.result.clone().unwrap_or(Value::Null);
                assert_eq!(run(call), expected, "{}", case.title());
            }
        }
    }
}
