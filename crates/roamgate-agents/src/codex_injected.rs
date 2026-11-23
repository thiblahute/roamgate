//! `codex-injected.ts`: what Codex itself writes in a user message of its
//! rollout, beside or instead of the user's words.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj, sv};
use crate::shared::injected::inner_tag;

/// A part of a Codex user message.
#[derive(Debug, Clone, PartialEq)]
pub enum CodexUserPart {
    Text(String),
    Notice {
        kind: String,
        label: String,
        body: String,
    },
}

struct Tagged {
    tag: String,
    inner: String,
    rest: String,
}

const AGENTS_MD: &str = "# AGENTS.md instructions for ";
const TAGS: [&str; 6] = [
    "environment_context",
    "user_instructions",
    "turn_aborted",
    "subagent_notification",
    "user_shell_command",
    "recommended_plugins",
];

fn leading_tag(text: &str) -> Option<Tagged> {
    let trimmed = js::trim_start(text);
    if trimmed.starts_with(AGENTS_MD) {
        let rest = match trimmed.find("</INSTRUCTIONS>") {
            None => String::new(),
            Some(close) => trimmed[close + 15..].to_owned(),
        };
        return Some(Tagged {
            tag: "agents_md".into(),
            inner: trimmed.to_owned(),
            rest,
        });
    }
    for tag in TAGS {
        let open = format!("<{tag}>");
        if !trimmed.starts_with(&open) {
            continue;
        }
        let close = format!("</{tag}>");
        return Some(match trimmed.find(&close) {
            None => Tagged {
                tag: tag.into(),
                inner: trimmed[open.len()..].to_owned(),
                rest: String::new(),
            },
            Some(at) => Tagged {
                tag: tag.into(),
                inner: trimmed[open.len()..at].to_owned(),
                rest: trimmed[at + close.len()..].to_owned(),
            },
        });
    }
    None
}

/// What an `<environment_context>` says.
#[derive(Debug, Clone, Default)]
pub struct CodexEnvironment {
    pub cwd: String,
    pub shell: String,
    pub date: String,
    pub timezone: String,
    pub roots: Vec<String>,
    pub subagents: String,
}

pub fn parse_environment_context(inner: &str) -> CodexEnvironment {
    static ROOT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<root>([\s\S]*?)</root>").unwrap());
    let roots_text = inner_tag(inner, "workspace_roots");
    CodexEnvironment {
        cwd: inner_tag(inner, "cwd"),
        shell: inner_tag(inner, "shell"),
        date: inner_tag(inner, "current_date"),
        timezone: inner_tag(inner, "timezone"),
        roots: ROOT
            .captures_iter(&roots_text)
            .map(|c| js::trim(&c[1]).to_owned())
            .collect(),
        subagents: inner_tag(inner, "subagents"),
    }
}

fn environment_notice(env: &CodexEnvironment) -> (String, String) {
    let said: Vec<String> = [
        (!env.cwd.is_empty()).then(|| format!("cwd {}", env.cwd)),
        (!env.date.is_empty()).then(|| format!("date {}", env.date)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let body = [
        (!env.cwd.is_empty()).then(|| format!("- cwd: `{}`", env.cwd)),
        (!env.roots.is_empty()).then(|| {
            format!(
                "- workspace: {}",
                env.roots
                    .iter()
                    .map(|r| format!("`{r}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        (!env.date.is_empty()).then(|| format!("- date: {}", env.date)),
        (!env.timezone.is_empty()).then(|| format!("- timezone: {}", env.timezone)),
        (!env.shell.is_empty()).then(|| format!("- shell: {}", env.shell)),
        (!env.subagents.is_empty()).then(|| format!("- subagents:\n{}", env.subagents)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    let label = if said.is_empty() {
        "Environment".to_owned()
    } else {
        format!("Environment: {}", said.join(", "))
    };
    (label, body)
}

fn shell_part(inner: &str) -> CodexUserPart {
    static OUTPUT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?:^|\n)Output:\n([\s\S]*)$").unwrap());
    static EXIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?:^|\n)Exit code: (-?[0-9]+)").unwrap());
    static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`+").unwrap());
    let command = inner_tag(inner, "command");
    let result = inner_tag(inner, "result");
    let output = OUTPUT.captures(&result).map(|c| c[1].to_owned());
    let exit = EXIT.captures(&result).map(|c| c[1].to_owned());
    let stdout = output.unwrap_or_else(|| result.clone());
    let stdout = stdout.trim_end_matches('\n');
    let longest = TICKS
        .find_iter(stdout)
        .map(|m| m.as_str().len() + 1)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(3));
    let first = command.split('\n').next().unwrap_or("");
    let exit_text = match exit {
        Some(code) if code != "0" => format!(" (exit code {code})"),
        _ => String::new(),
    };
    CodexUserPart::Notice {
        kind: "context".into(),
        label: format!("You ran: {first}{exit_text}"),
        body: format!("{fence}\n$ {command}\n{stdout}\n{fence}"),
    }
}

fn subagent_part(inner: &str, names: &HashMap<String, String>) -> Option<CodexUserPart> {
    let parsed = js::parse(js::trim(inner))?;
    let parsed = parsed.as_object()?;
    let path = sv(parsed.get("agent_path"));
    let name = names
        .get(path)
        .filter(|n| !n.is_empty())
        .cloned()
        .unwrap_or_else(|| "a subagent".into());
    if let Some(Value::Object(status)) = parsed.get("status") {
        let (state, value) = match status.iter().next() {
            Some((state, value)) => (Some(state.as_str()), Some(value)),
            None => (None, None),
        };
        let text = value.and_then(Value::as_str).unwrap_or("").to_owned();
        if state == Some("completed") {
            return Some(CodexUserPart::Notice {
                kind: "report".into(),
                label: format!("Report from {name}"),
                body: text,
            });
        }
        let mut chars = name.chars();
        let capital = chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>())
            .unwrap_or_default();
        return Some(CodexUserPart::Notice {
            kind: "agent".into(),
            label: format!("{capital}{}: {}", chars.as_str(), state.unwrap_or("update")),
            body: text,
        });
    }
    None
}

fn subagent_names(list: &str, names: &mut HashMap<String, String>) {
    static LINE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)^\s*-\s*(\S+):\s*(.+?)\s*$").unwrap());
    for caps in LINE.captures_iter(list) {
        names.insert(caps[1].to_owned(), caps[2].to_owned());
    }
}

/// What a session's earlier messages said.
#[derive(Debug, Clone, Default)]
pub struct CodexInjectedState {
    pub environment: String,
    pub names: HashMap<String, String>,
}

fn item_kind(payload: &Obj, index: usize) -> Option<Option<&'static str>> {
    let meta = js::rec(payload.get("internal_chat_message_metadata_passthrough"))?;
    let kinds = meta.get("content_item_kinds").and_then(Value::as_array);
    let items = meta.get("content_item_metadata").and_then(Value::as_array);
    if let Some(Value::String(kind)) = kinds.and_then(|k| k.get(index)) {
        return Some(Some(if kind.starts_with("user.") {
            "user"
        } else {
            "codex"
        }));
    }
    if let Some(Value::Object(item)) = items.and_then(|i| i.get(index))
        && let Some(Value::Object(provenance)) = item.get("provenance")
    {
        return Some(Some(if sv(provenance.get("type")) == "user" {
            "user"
        } else {
            "codex"
        }));
    }
    Some(None)
}

/// A user message of a Codex rollout as its parts, in order.
pub fn codex_user_parts(payload: &Obj, state: &mut CodexInjectedState) -> Vec<CodexUserPart> {
    static IMAGE_FRAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:<image name=[^>\n]*>|</image>)$").unwrap());
    let content: Vec<Value> = match payload.get("content") {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => vec![Value::Object(
            crate::obj! { "type" => "input_text", "text" => text.clone() },
        )],
        _ => Vec::new(),
    };
    let mut parts = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let flush = |parts: &mut Vec<CodexUserPart>, words: &mut Vec<String>| {
        let text = words.join("\n");
        words.clear();
        if !js::trim(&text).is_empty() {
            parts.push(CodexUserPart::Text(text));
        }
    };
    for (index, item) in content.iter().enumerate() {
        let Some(item) = item.as_object() else {
            continue;
        };
        let text = match (item.get("text"), item.get("content")) {
            (Some(Value::String(t)), _) => t.as_str(),
            (_, Some(Value::String(c))) => c.as_str(),
            _ => "",
        };
        if text.is_empty() {
            continue;
        }
        let said = item_kind(payload, index).flatten();
        if IMAGE_FRAME.is_match(js::trim(text)) {
            continue;
        }
        if said == Some("user") {
            words.push(text.to_owned());
            continue;
        }
        let Some(tagged) = leading_tag(text) else {
            if said != Some("codex") {
                words.push(text.to_owned());
            }
            continue;
        };
        flush(&mut parts, &mut words);
        if let Some(part) = tagged_part(&tagged, state) {
            parts.push(part);
        }
        if !js::trim(&tagged.rest).is_empty() {
            words.push(js::trim(&tagged.rest).to_owned());
        }
    }
    flush(&mut parts, &mut words);
    parts
}

fn tagged_part(tagged: &Tagged, state: &mut CodexInjectedState) -> Option<CodexUserPart> {
    match tagged.tag.as_str() {
        "environment_context" => {
            let env = parse_environment_context(&tagged.inner);
            if !env.subagents.is_empty() {
                subagent_names(&env.subagents, &mut state.names);
            }
            let (label, body) = environment_notice(&env);
            let key = format!("{label}\n{body}");
            if key == state.environment {
                return None;
            }
            state.environment = key;
            Some(CodexUserPart::Notice {
                kind: "context".into(),
                label,
                body,
            })
        }
        "subagent_notification" => subagent_part(&tagged.inner, &state.names),
        "user_shell_command" => Some(shell_part(&tagged.inner)),
        _ => None,
    }
}
