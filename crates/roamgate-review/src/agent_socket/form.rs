//! What an agent sends (review/agent-server.ts): a flat JSON object read as
//! strings, the target flags of `open`, and Claude's questions.

use std::future::Future;

use fancy_regex::Regex;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

use crate::error::{ReviewError, ReviewResult};
use crate::js::head16;

/// A request's fields as strings (the TS URLSearchParams).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Form(pub IndexMap<String, String>);

impl Form {
    /// The field, as `form.get`: None when absent.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    /// The field when present and not empty (`form.get(key) || ...`).
    pub fn non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|value| !value.is_empty())
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        self.0.insert(key.to_owned(), value.into());
    }

    pub fn with(pairs: &[(&str, &str)]) -> Self {
        let mut form = Self::default();
        for (key, value) in pairs {
            form.set(key, *value);
        }
        form
    }

    /// The fields as a JSON object (what a reverse call carries).
    pub fn to_value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect::<Map<_, _>>(),
        )
    }
}

/// The client sends a flat JSON object; values are read as strings.
pub fn form_of(body: &str) -> ReviewResult<Form> {
    let parsed: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).map_err(|_| ReviewError::new("invalid JSON"))?
    };
    let Value::Object(object) = parsed else {
        return Err(ReviewError::new("invalid request"));
    };
    let mut form = Form::default();
    for (key, value) in object {
        match value {
            Value::Null => continue,
            Value::Object(_) | Value::Array(_) => {
                return Err(ReviewError::new(format!("invalid {key}")));
            }
            other => form.set(&key, roamgate_agents::js::to_text(&other)),
        }
    }
    Ok(form)
}

/// No target named: the branch against Automatic's base.
pub fn automatic_target(form: &Form) -> bool {
    !["mr", "worktree", "last_step", "compare", "range"]
        .iter()
        .any(|flag| form.non_empty(flag).is_some())
}

/// The target `open`'s flags name, as review target JSON.
pub async fn parse_target_flags<B, BF, L, LF>(
    form: &Form,
    default_base: B,
    last_step: Option<L>,
) -> ReviewResult<Value>
where
    B: FnOnce() -> BF,
    BF: Future<Output = ReviewResult<String>>,
    L: FnOnce() -> LF,
    LF: Future<Output = ReviewResult<Option<Value>>>,
{
    static RANGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([^.\s]+?)\.\.\.?([^.\s]*)$").unwrap());
    if let Some(mr) = form.non_empty("mr") {
        return Ok(json!({"kind": "mr", "url": mr}));
    }
    if form.non_empty("worktree").is_some() {
        return Ok(json!({"kind": "worktree"}));
    }
    if form.non_empty("last_step").is_some() {
        let Some(last_step) = last_step else {
            return Err(ReviewError::new("this connection does not keep last steps"));
        };
        return last_step().await?.ok_or_else(|| {
            ReviewError::new("no last step known here yet: it ends when your turn does")
        });
    }
    if let Some(compare) = form.non_empty("compare") {
        // Git refuses ".." in ref names: the two refs split there.
        let parts: Vec<&str> = compare.split("..").collect();
        if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
            return Err(ReviewError::new("--compare takes OLD NEW"));
        }
        return Ok(json!({"kind": "range", "base": parts[0], "head": parts[1], "compare": true}));
    }
    if let Some(range) = form.non_empty("range") {
        let Some(found) = RANGE.captures(range).ok().flatten() else {
            return Err(ReviewError::new("--range takes BASE..HEAD"));
        };
        let head = found.get(2).map_or("", |m| m.as_str());
        return Ok(json!({
            "kind": "range",
            "base": &found[1],
            "head": if head.is_empty() { "HEAD" } else { head },
        }));
    }
    let base = default_base().await?;
    Ok(json!({"kind": "range", "base": base, "head": "HEAD"}))
}

/// Claude's AskUserQuestion questions, as its hook passes them on.
pub fn parse_questions(raw: Option<&str>) -> Vec<Value> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw.unwrap_or("[]")) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let item = item.as_object()?;
            let question = item.get("question")?.as_str()?;
            let options = item.get("options")?.as_array()?;
            let mut out = Map::new();
            out.insert("question".into(), json!(head16(question, 2000)));
            if let Some(header) = item.get("header").and_then(Value::as_str) {
                out.insert("header".into(), json!(head16(header, 40)));
            }
            let options: Vec<Value> = options
                .iter()
                .filter_map(|option| {
                    let option = option.as_object();
                    let label = option?.get("label")?.as_str()?;
                    let mut kept = Map::new();
                    kept.insert("label".into(), json!(head16(label, 200)));
                    if let Some(description) = option
                        .and_then(|o| o.get("description"))
                        .and_then(Value::as_str)
                    {
                        kept.insert("description".into(), json!(head16(description, 1000)));
                    }
                    Some(Value::Object(kept))
                })
                .collect();
            out.insert("options".into(), Value::Array(options));
            out.insert(
                "multiSelect".into(),
                json!(item.get("multiSelect") == Some(&Value::Bool(true))),
            );
            Some(Value::Object(out))
        })
        .collect()
}
