//! `shared/injectedMessage.ts`: what Claude Code puts in the user's turn
//! that the user did not type (a subagent's report, another session's
//! message, a task ending, reminders).

use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::Value;

use super::agent_message::{AGENT_MESSAGE_NOTE, AGENT_MESSAGE_PREAMBLE, AGENT_MESSAGE_TAG};
use crate::js::{self, Obj};

#[derive(Debug, Clone, PartialEq)]
pub struct InjectedNotice {
    pub kind: String,
    pub label: String,
    pub body: String,
}

impl InjectedNotice {
    pub fn to_obj(&self) -> Obj {
        obj! { "kind" => self.kind.clone(), "label" => self.label.clone(), "body" => self.body.clone() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InjectedMessage {
    pub notices: Vec<InjectedNotice>,
    pub rest: String,
}

fn tags() -> String {
    format!(
        "agent-message|teammate-message|cross-session-message|{AGENT_MESSAGE_TAG}|task-notification|system-reminder"
    )
}

static BLOCK_LINES: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r"^<({})\b([^>]*)>([\s\S]*?)\n</\1>[ \t]*(?:\n|$)\s*",
        tags()
    ))
    .unwrap()
});
static BLOCK: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r"^<({})\b([^>]*)>([\s\S]*?)</\1>\s*", tags())).unwrap()
});
static PREAMBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:Another Claude session sent a message(?: while you were working)?:|{})\s*",
        regex::escape(AGENT_MESSAGE_PREAMBLE)
    ))
    .unwrap()
});
static AGENT_NOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^That "other Claude session" is an agent working inside this same session[\s\S]*?permission laundering\.\s*"#,
    )
    .unwrap()
});

fn unescape(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn attributes(raw: &str) -> Vec<(String, String)> {
    static ATTR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"([A-Za-z0-9_-]+)="([^"]*)""#).unwrap());
    let mut found: Vec<(String, String)> = Vec::new();
    for caps in ATTR.captures_iter(raw) {
        let key = caps[1].to_owned();
        let value = unescape(&caps[2]);
        match found.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => found.push((key, value)),
        }
    }
    found
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// The trimmed text of the first `<tag>...</tag>`, or "".
pub fn inner_tag(body: &str, tag: &str) -> String {
    let pattern = Regex::new(&format!(r"<{0}>([\s\S]*?)</{0}>", regex::escape(tag))).unwrap();
    pattern
        .captures(body)
        .map(|caps| js::trim(&caps[1]).to_owned())
        .unwrap_or_default()
}

fn hand_back_report(body: &str) -> String {
    const MARK: &str = "The report follows:";
    let Some(at) = body.find(MARK) else {
        return js::trim(body).to_owned();
    };
    let lines: Vec<&str> = body[at + MARK.len()..].split('\n').collect();
    let joined = lines
        .iter()
        .map(|line| line.strip_prefix("  ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    js::trim(&joined).to_owned()
}

fn notice(tag: &str, attrs: &[(String, String)], body: &str) -> Option<InjectedNotice> {
    static TASK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^a[0-9a-f]{12,}$").unwrap());
    let make = |kind: &str, label: String, body: String| {
        Some(InjectedNotice {
            kind: kind.into(),
            label,
            body,
        })
    };
    match tag {
        "agent-message" => {
            let from = match attr(attrs, "from") {
                Some(from) if !from.is_empty() && !TASK_ID.is_match(from) => from.to_owned(),
                _ => "a subagent".into(),
            };
            if body.contains("[Subagent hand-back]") {
                return make(
                    "report",
                    format!("Report from {from}"),
                    hand_back_report(body),
                );
            }
            make(
                "agent",
                format!("Message from {from}"),
                js::trim(body).to_owned(),
            )
        }
        "cross-session-message" | AGENT_MESSAGE_TAG => {
            let who = [attr(attrs, "from-name"), attr(attrs, "from")]
                .into_iter()
                .flatten()
                .find(|value| !value.is_empty())
                .unwrap_or("another session");
            let label = if tag == AGENT_MESSAGE_TAG {
                format!("From {who}")
            } else {
                format!("Message from {who}")
            };
            make("session", label, js::trim(body).to_owned())
        }
        "teammate-message" => {
            let id = attr(attrs, "teammate_id")
                .filter(|v| !v.is_empty())
                .unwrap_or("a teammate");
            let mut text = js::trim(body).to_owned();
            let mut idle = false;
            if let Some(parsed) = js::parse(&text)
                && let Value::Object(map) = &parsed
            {
                idle = js::sv(map.get("type")) == "idle_notification";
                text = match (map.get("result"), map.get("summary")) {
                    (Some(Value::String(result)), _) => result.clone(),
                    (_, Some(Value::String(summary))) => summary.clone(),
                    _ => String::new(),
                };
            } else if let Some(parsed) = js::parse(&text)
                && let Value::Array(_) = &parsed
            {
                // An array is an object too: no type, no result.
                text = String::new();
            }
            let summary = attr(attrs, "summary")
                .map(js::trim)
                .filter(|s| !s.is_empty());
            let label = if idle {
                format!("Teammate {id} is idle")
            } else if let Some(summary) = summary {
                format!("Teammate {id}: {summary}")
            } else {
                format!("Message from teammate {id}")
            };
            make("teammate", label, text)
        }
        "task-notification" => {
            let status = inner_tag(body, "status");
            let summary = inner_tag(body, "summary");
            let verb = match status.as_str() {
                "completed" => "Task finished",
                "failed" => "Task failed",
                "killed" | "stopped" => "Task stopped",
                _ => "Task update",
            };
            let label = if summary.is_empty() {
                verb.to_owned()
            } else {
                format!("{verb}: {summary}")
            };
            let result = inner_tag(body, "result");
            make(
                "task",
                label,
                if result.is_empty() { summary } else { result },
            )
        }
        _ => None,
    }
}

fn strip(pattern: &Regex, text: &str) -> String {
    match pattern.find(text) {
        Some(found) if found.start() == 0 => text[found.end()..].to_owned(),
        _ => text.to_owned(),
    }
}

/// The injected messages a user turn starts with, and what follows them.
pub fn parse_injected_message(text: &str) -> Option<InjectedMessage> {
    let mut rest = js::trim(text).to_owned();
    let mut notices = Vec::new();
    let mut matched = false;
    loop {
        rest = strip(&PREAMBLE, &rest);
        rest = strip(&AGENT_NOTE, &rest);
        rest = strip(&AGENT_MESSAGE_NOTE, &rest);
        let found = BLOCK_LINES
            .captures(&rest)
            .ok()
            .flatten()
            .or_else(|| BLOCK.captures(&rest).ok().flatten());
        let Some(caps) = found else { break };
        matched = true;
        let end = caps.get(0).unwrap().end();
        let notice = notice(&caps[1], &attributes(&caps[2]), &caps[3]);
        rest = rest[end..].to_owned();
        if let Some(notice) = notice {
            notices.push(notice);
        }
    }
    rest = strip(&AGENT_NOTE, &rest);
    rest = strip(&AGENT_MESSAGE_NOTE, &rest);
    matched.then(|| InjectedMessage {
        notices,
        rest: js::trim(&rest).to_owned(),
    })
}

/// `parseInjectedMessage` as the JavaScript value.
pub fn parse_injected_message_value(text: &str) -> Value {
    match parse_injected_message(text) {
        None => Value::Null,
        Some(message) => Value::Object(obj! {
            "notices" => message.notices.iter().map(|n| Value::Object(n.to_obj())).collect::<Vec<_>>(),
            "rest" => message.rest,
        }),
    }
}
