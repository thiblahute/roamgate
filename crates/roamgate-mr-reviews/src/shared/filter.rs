//! The Reviews search (`shared/mrReviewsFilter.ts`): `key:value` tokens and
//! free words, as GitLab's. Held to `contract/vectors/mr-reviews-filter.json`.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::Value;

use super::types::{forge_ref_label, whose_label};

pub const FILTER_KEYS: [&str; 13] = [
    "project",
    "label",
    "waiting",
    "lane",
    "state",
    "stale",
    "draft",
    "author",
    "pipeline",
    "effort",
    "merge-after",
    "bot",
    "is",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub key: &'static str,
    pub value: String,
    pub not: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Filter {
    pub tokens: Vec<Token>,
    /// Free words (lower case); a negated one is one the request must not hold.
    pub words: Vec<(String, bool)>,
}

impl Filter {
    /// As the vectors and the TS give it.
    pub fn to_json(&self) -> Value {
        let tokens: Vec<Value> = self
            .tokens
            .iter()
            .map(|t| serde_json::json!({"key": t.key, "value": t.value, "not": t.not}))
            .collect();
        let words: Vec<Value> = self
            .words
            .iter()
            .map(|(text, not)| serde_json::json!({"text": text, "not": not}))
            .collect();
        serde_json::json!({"tokens": tokens, "words": words})
    }

    pub fn from_json(value: &Value) -> Filter {
        if let Some(text) = value.as_str() {
            return parse(text);
        }
        let mut filter = Filter::default();
        for token in value
            .get("tokens")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = js::sv(token.get("key"));
            if let Some(key) = FILTER_KEYS.iter().find(|k| **k == key) {
                filter.tokens.push(Token {
                    key,
                    value: js::sv(token.get("value")).to_owned(),
                    not: js::is_true(token.get("not")),
                });
            }
        }
        for word in value
            .get("words")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            filter.words.push((
                js::sv(word.get("text")).to_owned(),
                js::is_true(word.get("not")),
            ));
        }
        filter
    }
}

fn lane_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "needs-you" | "needs_you" | "your-move" | "your_move" | "mine" => "your_move",
        "waiting" => "waiting",
        "blocked" => "blocked",
        "not-sent" | "not_sent" | "unsent" => "not_sent",
        "stale" => "stale",
        "merging" => "merging",
        "done" => "done",
        _ => return None,
    })
}

static SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(-?\w+:"[^"]*"?)|(-?"[^"]*"?)|(\S+)"#).expect("pattern"));

fn unquote(value: &str) -> &str {
    let value = value.strip_prefix('"').unwrap_or(value);
    value.strip_suffix('"').unwrap_or(value)
}

/// The search text read as tokens and words; unknown keys stay words.
pub fn parse(text: &str) -> Filter {
    let mut filter = Filter::default();
    for part in SPLIT.find_iter(js::trim(text)).map(|m| m.as_str()) {
        let not = part.starts_with('-') && part.len() > 1;
        let body = if not { &part[1..] } else { part };
        let colon = body.find(':');
        let key = match colon {
            Some(c) if c > 0 => body[..c].to_lowercase(),
            _ => String::new(),
        };
        if let (Some(c), Some(k)) = (
            colon.filter(|c| *c > 0),
            FILTER_KEYS.iter().find(|k| **k == key),
        ) {
            let value = js::trim(unquote(&body[c + 1..]));
            if !value.is_empty() {
                filter.tokens.push(Token {
                    key: k,
                    value: value.to_owned(),
                    not,
                });
            }
            continue;
        }
        let word = unquote(body).to_lowercase();
        if !word.is_empty() {
            filter.words.push((word, not));
        }
    }
    filter
}

fn strings(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn override_labels(entry: &Obj) -> Vec<&str> {
    strings(entry.get("override").and_then(|o| o.get("labels")))
}

/// The words a request is found by.
pub fn search_text(entry: &Obj) -> String {
    let s = |name: &str| js::sv(entry.get(name)).to_owned();
    let mut parts = vec![
        s("title"),
        s("project"),
        s("host"),
        s("author"),
        forge_ref_label(entry, false),
        forge_ref_label(entry, true),
        s("sourceBranch"),
        s("targetBranch"),
        s("state"),
        if js::is_true(entry.get("draft")) {
            "draft".into()
        } else {
            String::new()
        },
        s("reason"),
        js::sv(entry.get("next").and_then(|n| n.get("text"))).to_owned(),
    ];
    parts.extend(strings(entry.get("labels")).into_iter().map(str::to_owned));
    parts.extend(override_labels(entry).into_iter().map(str::to_owned));
    parts.extend(
        strings(entry.get("reasons"))
            .into_iter()
            .map(|r| r.replace('_', " ")),
    );
    parts.join("\n").to_lowercase()
}

/// `group/*` (or `group/`) and `*` match as globs; anything else whole.
pub fn like(pattern: &str, value: &str) -> bool {
    let mut p = pattern.to_lowercase();
    if p.ends_with('/') {
        p.push('*');
    }
    let v = value.to_lowercase();
    if !p.contains('*') {
        return v == p;
    }
    let body: Vec<String> = p.split('*').map(regex::escape).collect();
    Regex::new(&format!("^{}$", body.join(".*"))).is_ok_and(|r| r.is_match(&v))
}

fn state_of(entry: &Obj) -> String {
    if js::sv(entry.get("key")).starts_with("branch:") {
        return if js::is_true(entry.get("unsent")) {
            "unsent"
        } else {
            "branch"
        }
        .to_owned();
    }
    js::sv(entry.get("state")).to_owned()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

fn holds(entry: &Obj, token: &Token) -> bool {
    let value = token.value.to_lowercase();
    let lane = js::sv(entry.get("lane"));
    let merge = entry.get("merge");
    let after = merge
        .and_then(|m| m.get("after"))
        .filter(|a| truthy(Some(a)));
    let bot = merge.and_then(|m| m.get("bot")).filter(|b| truthy(Some(b)));
    let after_ready = after.is_some_and(|a| js::is_true(a.get("ready")));
    let reasons = strings(entry.get("reasons"));
    let section = js::sv(entry.get("section"));
    match token.key {
        "project" => like(&token.value, js::sv(entry.get("project"))),
        "label" => strings(entry.get("labels"))
            .into_iter()
            .chain(override_labels(entry))
            .any(|label| like(&token.value, label)),
        "waiting" => {
            let whose = entry
                .get("override")
                .and_then(|o| o.get("whose"))
                .filter(|w| truthy(Some(w)));
            if let Some(whose) = whose
                && !truthy(entry.get("overrideOutdated"))
            {
                return like(&token.value, &whose_label(whose));
            }
            match value.as_str() {
                "me" => lane == "your_move",
                "time" => lane == "waiting" && after.is_some() && !after_ready,
                "reviewer" => lane == "waiting" && !(after.is_some() && !after_ready),
                _ => {
                    lane == "merging"
                        && bot.is_some_and(|b| {
                            value == "bot" || like(&token.value, js::sv(b.get("name")))
                        })
                }
            }
        }
        "lane" => !lane.is_empty() && lane_name(&value) == Some(lane),
        "state" => {
            if value == "merging" {
                return lane == "merging" || bot.is_some_and(|b| js::is_true(b.get("queued")));
            }
            if value == "draft" {
                js::is_true(entry.get("draft")) && js::sv(entry.get("state")) == "open"
            } else {
                state_of(entry) == value
            }
        }
        "merge-after" => {
            if value == "no" || value == "none" {
                return after.is_none();
            }
            let Some(after) = after else { return false };
            match value.as_str() {
                "ready" | "now" => after_ready,
                "waiting" | "later" => !after_ready,
                _ => {
                    value == "yes"
                        || value == "any"
                        || like(&token.value, js::sv(after.get("delay")))
                }
            }
        }
        "bot" => {
            let Some(bot) = bot else {
                return value == "none";
            };
            match value.as_str() {
                "any" | "yes" => true,
                "failed" => truthy(bot.get("failed")),
                "queued" => js::is_true(bot.get("queued")),
                _ => like(&token.value, js::sv(bot.get("name"))),
            }
        }
        "stale" => (lane == "stale") == (value == "yes" || value == "true"),
        "draft" => js::is_true(entry.get("draft")) == (value == "yes" || value == "true"),
        "author" => like(&token.value, js::sv(entry.get("author"))),
        "pipeline" => {
            entry
                .get("pipeline")
                .and_then(Value::as_str)
                .unwrap_or("none")
                == value
        }
        "effort" => {
            let effort = js::sv(entry.get("effort"));
            !effort.is_empty() && like(&token.value, effort)
        }
        "is" => match value.as_str() {
            "mine" | "own" => reasons.contains(&"authored"),
            "review" => section != "suggested" && !reasons.contains(&"authored"),
            "pinned" => section == "pinned",
            "suggested" => section == "suggested",
            "unread" => {
                js::is_true(entry.get("isNew"))
                    || truthy(entry.get("unread").and_then(|u| u.get("changed")))
            }
            _ => false,
        },
        _ => false,
    }
}

/// Whether a request matches the filter.
pub fn matches(entry: &Obj, filter: &Filter) -> bool {
    let mut by_key: Vec<(&str, Vec<&Token>)> = Vec::new();
    for token in filter.tokens.iter().filter(|t| !t.not) {
        match by_key.iter_mut().find(|(k, _)| *k == token.key) {
            Some((_, list)) => list.push(token),
            None => by_key.push((token.key, vec![token])),
        }
    }
    for (_, tokens) in &by_key {
        if !tokens.iter().any(|t| holds(entry, t)) {
            return false;
        }
    }
    if filter.tokens.iter().any(|t| t.not && holds(entry, t)) {
        return false;
    }
    if filter.words.is_empty() {
        return true;
    }
    let text = search_text(entry);
    filter
        .words
        .iter()
        .all(|(word, not)| text.contains(word.as_str()) != *not)
}

/// Whether a filter keeps only one's own work (lanes then apply).
pub fn is_own(filter: &Filter) -> bool {
    filter.tokens.iter().any(|t| {
        !t.not
            && ((t.key == "is" && (t.value == "mine" || t.value == "own"))
                || matches!(t.key, "lane" | "waiting" | "effort" | "merge-after" | "bot")
                || (t.key == "state" && t.value == "merging"))
    })
}

fn fixed_values(key: &str) -> &'static [&'static str] {
    match key {
        "waiting" => &["me", "reviewer", "external", "time", "bot"],
        "lane" => &[
            "needs-you",
            "waiting",
            "merging",
            "blocked",
            "not-sent",
            "stale",
            "done",
        ],
        "state" => &[
            "open", "draft", "merging", "merged", "closed", "branch", "unsent",
        ],
        "merge-after" => &["yes", "no", "waiting", "ready"],
        "bot" => &["any", "queued", "failed", "none"],
        "stale" | "draft" => &["yes", "no"],
        "pipeline" => &["failed", "running", "pending", "success", "manual", "none"],
        "is" => &["mine", "review", "pinned", "suggested", "unread"],
        _ => &[],
    }
}

/// What completes the search's last word: `(label, insert)` pairs.
pub fn completions(text: &str, entries: &[Obj]) -> Vec<(String, String)> {
    let at = text
        .char_indices()
        .rev()
        .find(|(_, c)| c.is_whitespace())
        .map_or(0, |(i, c)| i + c.len_utf8());
    let word = &text[at..];
    let not = if word.starts_with('-') { "-" } else { "" };
    let body = &word[not.len()..];
    let head = &text[..at];
    let Some(colon) = body.find(':') else {
        let lower = body.to_lowercase();
        return FILTER_KEYS
            .iter()
            .filter(|k| k.starts_with(&lower))
            .map(|k| (format!("{not}{k}:"), format!("{head}{not}{k}:")))
            .collect();
    };
    let key = body[..colon].to_lowercase();
    if !FILTER_KEYS.contains(&key.as_str()) {
        return vec![];
    }
    let typed = unquote(&body[colon + 1..]).to_lowercase();
    let mut found: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        if !found.iter().any(|f| f == value) {
            found.push(value.to_owned());
        }
    };
    for value in fixed_values(&key) {
        add(value);
    }
    for entry in entries {
        match key.as_str() {
            "project" => {
                let project = js::sv(entry.get("project"));
                add(project);
                let parts: Vec<&str> = project.split('/').collect();
                let group = parts[..parts.len() - 1].join("/");
                if !group.is_empty() {
                    add(&format!("{group}/*"));
                }
            }
            "label" => {
                for label in strings(entry.get("labels"))
                    .into_iter()
                    .chain(override_labels(entry))
                {
                    add(label);
                }
            }
            "author" => add(js::sv(entry.get("author"))),
            _ => {
                let whose = entry
                    .get("override")
                    .and_then(|o| o.get("whose"))
                    .filter(|w| truthy(Some(w)));
                let effort = js::sv(entry.get("effort"));
                let bot = entry
                    .get("merge")
                    .and_then(|m| m.get("bot"))
                    .filter(|b| truthy(Some(b)));
                if key == "waiting" && whose.is_some() {
                    add(&whose_label(whose.unwrap_or(&Value::Null)));
                } else if key == "effort" && !effort.is_empty() {
                    add(effort);
                } else if (key == "bot" || key == "waiting")
                    && let Some(bot) = bot
                {
                    add(js::sv(bot.get("name")));
                }
            }
        }
    }
    let mut found: Vec<String> = found
        .into_iter()
        .filter(|v| !v.is_empty() && v.to_lowercase().starts_with(&typed))
        .collect();
    found.sort_by(|a, b| js::locale_compare(a, b));
    found
        .into_iter()
        .take(30)
        .map(|value| {
            let quoted = if value.chars().any(char::is_whitespace) {
                format!("\"{value}\"")
            } else {
                value
            };
            (
                format!("{not}{key}:{quoted}"),
                format!("{head}{not}{key}:{quoted} "),
            )
        })
        .collect()
}
