//! `shared/toolSummary.ts`: a one-line summary of what a tool call does,
//! and what a call wrote in Roamgate.

use std::collections::HashMap;
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::Value;

use super::agent_message::{client_start, is_client_word, shell_words};
use crate::js::{self, Obj, non_empty};

pub const TOOL_SUMMARY_LIMIT: usize = 160;
const PART_LIMIT: usize = 60;
pub const ROAMGATE_WRITE_TEXT_LIMIT: usize = 4000;

pub const TOOL_ARGUMENT_KEYS: [&str; 11] = [
    "command",
    "cmd",
    "file_path",
    "filePath",
    "notebook_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
];

pub fn parse_tool_arguments(text: &str) -> Option<Value> {
    js::parse(text)
}

pub fn first_line(value: &str) -> String {
    value
        .split('\n')
        .map(js::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_owned()
}

fn clip(value: &str, limit: usize) -> String {
    if js::len16(value) > limit {
        let head = js::head16(value, limit - 1);
        format!("{}…", js::trim_end(&head))
    } else {
        value.to_owned()
    }
}

fn start(value: &str, limit: usize) -> String {
    clip(&first_line(value), limit)
}

fn start60(value: &str) -> String {
    start(value, PART_LIMIT)
}

pub fn tool_argument_headline(text: &str) -> String {
    match parse_tool_arguments(text) {
        Some(Value::Object(parsed)) => key_argument(&parsed)
            .unwrap_or_else(|| first_line(&js::stringify(&Value::Object(parsed)))),
        _ => first_line(text),
    }
}

fn key_argument(args: &Obj) -> Option<String> {
    for key in TOOL_ARGUMENT_KEYS {
        if let Some(value) = non_empty(args.get(key)) {
            return Some(first_line(value));
        }
    }
    args.values()
        .find_map(|item| item.as_str().filter(|s| !js::trim(s).is_empty()))
        .map(first_line)
}

/// A path's last two parts.
pub fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.split(['\\', '/']).filter(|p| !p.is_empty()).collect();
    if parts.len() <= 2 {
        path.to_owned()
    } else {
        parts[parts.len() - 2..].join("/")
    }
}

fn host_of(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => {
            let host = match (parsed.host_str(), parsed.port()) {
                (Some(host), Some(port)) => format!("{host}:{port}"),
                (Some(host), None) => host.to_owned(),
                _ => String::new(),
            };
            let host = host.strip_prefix("www.").map(str::to_owned).unwrap_or(host);
            if host.is_empty() {
                url.to_owned()
            } else {
                host
            }
        }
        Err(_) => url.to_owned(),
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn words(value: &str) -> String {
    static SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[_-]+").unwrap());
    js::trim(&SEP.replace_all(value, " ")).to_owned()
}

fn mcp_parts(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    Some(match rest.find("__") {
        None => (rest.to_owned(), String::new()),
        Some(split) => (rest[..split].to_owned(), rest[split + 2..].to_owned()),
    })
}

fn is_roamgate_server(server: &str) -> bool {
    server == "roamgate" || server.ends_with("_roamgate")
}

/// A tool's name as people read it.
pub fn tool_display_name(name: &str) -> String {
    let Some((server, tool)) = mcp_parts(name) else {
        return name.to_owned();
    };
    let server = capitalize(&words(server.strip_prefix("claude_ai_").unwrap_or(&server)));
    let tool = words(tool.strip_suffix("_mcp").unwrap_or(&tool));
    if tool.is_empty() {
        server
    } else {
        format!("{server}: {tool}")
    }
}

/// What the rest of the session tells about a call.
#[derive(Default, Clone)]
pub struct ToolSummaryContext<'a> {
    pub result: Option<String>,
    pub notes: Option<&'a ToolSummaryNotes>,
    /// Answers given directly (the vectors' callbacks).
    pub agent_names: Option<&'a HashMap<String, String>>,
    pub thread_labels: Option<&'a HashMap<String, String>>,
    pub session_names: Option<&'a HashMap<String, String>>,
    pub codex_commands: Option<&'a HashMap<String, String>>,
}

impl ToolSummaryContext<'_> {
    fn agent_name(&self, id: &str) -> Option<String> {
        self.notes
            .and_then(|n| n.agents.get(id))
            .or_else(|| self.agent_names.and_then(|m| m.get(id)))
            .cloned()
    }
    fn thread_label(&self, id: &str) -> Option<String> {
        let key = js::head16(id, 8);
        self.notes
            .and_then(|n| n.threads.get(&key))
            .or_else(|| self.thread_labels.and_then(|m| m.get(id)))
            .cloned()
    }
    fn session_name(&self, address: &str) -> Option<String> {
        self.notes
            .and_then(|n| n.sessions.get(address))
            .or_else(|| self.session_names.and_then(|m| m.get(address)))
            .cloned()
    }
    fn codex_command(&self, id: &str) -> Option<String> {
        self.notes
            .and_then(|n| n.codex_sessions.get(id))
            .or_else(|| self.codex_commands.and_then(|m| m.get(id)))
            .cloned()
    }
}

static OPAQUE_RECIPIENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:a?[0-9a-f]{12,}|uds:.*|bridge:.*)$").unwrap());

fn recipient(to: &str, context: &ToolSummaryContext) -> String {
    if to == "*" {
        return "all agents".into();
    }
    if let Some(known) = context.agent_name(to).filter(|k| !k.is_empty()) {
        return known;
    }
    let lower = to.to_lowercase();
    if lower.starts_with("uds:") || lower.starts_with("bridge:") {
        return "another session".into();
    }
    if OPAQUE_RECIPIENT.is_match(to) {
        return "an agent".into();
    }
    format!("the {to} agent")
}

fn thread_output_label(thread: &Obj) -> Option<String> {
    let quote = js::rec(thread.get("on_chat_message"))
        .and_then(|chat| non_empty(chat.get("quote")))
        .or_else(|| js::rec(thread.get("on_message")).and_then(|m| non_empty(m.get("quote"))));
    if let Some(quote) = quote {
        return Some(start60(quote));
    }
    if let Some(path) = non_empty(thread.get("path")) {
        let line = match thread.get("line") {
            Some(Value::Number(n)) => format!(":{}", js::to_text(&Value::Number(n.clone()))),
            _ => String::new(),
        };
        return Some(format!("{}{line}", short_path(path)));
    }
    let first = thread
        .get("comments")
        .and_then(Value::as_array)
        .and_then(|comments| comments.iter().find_map(Value::as_object));
    first.and_then(|c| non_empty(c.get("text"))).map(start60)
}

fn threads_in_output(output: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    fn visit(value: &Value, found: &mut Vec<(String, String)>) {
        let Value::Object(map) = value else { return };
        if let Some(id) = non_empty(map.get("id"))
            && map.get("comments").is_some_and(Value::is_array)
            && let Some(label) = thread_output_label(map)
        {
            let key = js::head16(id, 8);
            match found.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = label,
                None => found.push((key, label)),
            }
        }
        for key in ["threads", "thread"] {
            match map.get(key) {
                Some(Value::Array(inner)) => inner.iter().for_each(|v| visit(v, found)),
                Some(other) => visit(other, found),
                None => {}
            }
        }
    }
    match parse_tool_arguments(output) {
        Some(Value::Array(items)) => items.iter().for_each(|v| visit(v, &mut found)),
        Some(other) => visit(&other, &mut found),
        None => {}
    }
    found
}

fn thread_label(id: Option<&str>, context: &ToolSummaryContext) -> Option<String> {
    let id = id?;
    let key = js::head16(js::trim(id), 8);
    let from_result = context
        .result
        .as_deref()
        .and_then(|result| {
            threads_in_output(result)
                .into_iter()
                .find(|(k, _)| *k == key)
        })
        .map(|(_, label)| label);
    from_result.or_else(|| context.thread_label(&key))
}

fn line_suffix(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(n)) => format!(":{}", js::to_text(&Value::Number(n.clone()))),
        _ => String::new(),
    }
}

fn roamgate_summary(tool: &str, args: &Obj, context: &ToolSummaryContext) -> Option<String> {
    if let Some(description) = non_empty(args.get("description")) {
        return Some(first_line(description));
    }
    let text = non_empty(args.get("text"));
    let message = non_empty(args.get("message"));
    match tool {
        "review_reply" => {
            if let Some(thread) = thread_label(non_empty(args.get("comment_id")), context) {
                let tail = text
                    .map(|t| format!(" · {}", start60(t)))
                    .unwrap_or_default();
                return Some(format!("Replied on \"{thread}\"{tail}"));
            }
            Some(match text {
                Some(t) => format!("Replied: {}", start60(t)),
                None => "Replied on a thread".into(),
            })
        }
        "review_add" => {
            let verb = if js::sv(args.get("kind")) == "draft" {
                "Drafted a review comment"
            } else {
                "Commented"
            };
            let place = non_empty(args.get("file"))
                .map(|file| format!(" on {}{}", short_path(file), line_suffix(args.get("line"))))
                .unwrap_or_default();
            let tail = text
                .map(|t| format!(": {}", start60(t)))
                .unwrap_or_default();
            Some(format!("{verb}{place}{tail}"))
        }
        "review_edit" => {
            let output = context.result.as_deref().and_then(roamgate_output);
            let thread = output.as_ref().and_then(thread_output_label);
            let place = thread.map(|t| format!(" on \"{t}\"")).unwrap_or_default();
            let tail = text
                .map(|t| format!(": {}", start60(t)))
                .unwrap_or_default();
            Some(format!("Edited a comment{place}{tail}"))
        }
        "review_resolve" | "review_reopen" => {
            let verb = if tool == "review_resolve" {
                "Resolved"
            } else {
                "Reopened"
            };
            Some(
                match thread_label(non_empty(args.get("comment_id")), context) {
                    Some(thread) => format!("{verb} \"{thread}\""),
                    None => format!("{verb} a thread"),
                },
            )
        }
        "review_working" => {
            let verb = if js::is_true(args.get("done")) {
                "Done"
            } else {
                "Working"
            };
            if let Some(message) = message {
                return Some(format!("{verb}: {}", start(message, 100)));
            }
            Some(
                match thread_label(non_empty(args.get("comment_id")), context) {
                    Some(thread) => format!("{verb} on \"{thread}\""),
                    None => verb.into(),
                },
            )
        }
        "review_notify" => {
            let title = non_empty(args.get("title")).or(text);
            Some(match title {
                Some(t) => format!("Notified you: {}", start(t, 100)),
                None => "Notified you".into(),
            })
        }
        "review_update" => Some(format!(
            "Told the review it changed{}",
            message
                .map(|m| format!(": {}", start60(m)))
                .unwrap_or_default()
        )),
        "review_get" | "review_threads" | "review_summary" => Some("Read the review".into()),
        "agent_message" => {
            let to = non_empty(args.get("to"));
            let name = to
                .and_then(|to| context.session_name(to))
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "another session".into());
            let tail = text
                .map(|t| format!(": {}", start60(t)))
                .unwrap_or_default();
            Some(format!("Messaged {name}{tail}"))
        }
        "agent_sessions" => Some("Listed sessions".into()),
        "work_add" | "work_update" | "work_done" | "work_reopen" => {
            let output = context.result.as_deref().and_then(roamgate_output);
            let write = work_write(tool, args, output.as_ref())?;
            item_write_line(&write)
        }
        _ => None,
    }
}

/// A Roamgate tool's output as JSON.
pub fn roamgate_output(result: &str) -> Option<Obj> {
    let text = js::trim(result);
    let mut parsed = parse_tool_arguments(text);
    if parsed.is_none()
        && let Some(brace) = text.find('{')
        && brace > 0
    {
        parsed = parse_tool_arguments(&text[brace..]);
    }
    let Value::Object(map) = parsed? else {
        return None;
    };
    match map.get("result") {
        Some(Value::Object(inner)) => Some(inner.clone()),
        _ => Some(map),
    }
}

const CLIENT_VALUES: [&str; 13] = [
    "--agent",
    "--session",
    "--comment",
    "--file",
    "--line",
    "--end-line",
    "--side",
    "--quote",
    "--message",
    "--title",
    "--description",
    "--timeout",
    "--on-comment",
];

fn inline_heredoc(word: &str) -> String {
    static HEREDOC: LazyLock<FancyRegex> = LazyLock::new(|| {
        FancyRegex::new(
            r#"^\$\(cat <<-?\s*(['"]?)([A-Za-z0-9_-]+)\1\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\)$"#,
        )
        .unwrap()
    });
    match HEREDOC.captures(word) {
        Ok(Some(caps)) => caps[3].to_owned(),
        _ => word.to_owned(),
    }
}

/// The review client's command in a shell command, as its tool and args.
pub fn review_client_call(command: &str) -> Option<(String, Obj)> {
    let at = client_start(command)?;
    let (words, heredoc) = shell_words(&command[at..]);
    if !is_client_word(words.first().map_or("", String::as_str)) {
        return None;
    }
    let mut options: Vec<(String, String)> = Vec::new();
    let set_option = |options: &mut Vec<(String, String)>, key: String, value: String| match options
        .iter_mut()
        .find(|(k, _)| *k == key)
    {
        Some(entry) => entry.1 = value,
        None => options.push((key, value)),
    };
    let mut positional: Vec<String> = Vec::new();
    let mut sub: Option<String> = None;
    let mut rest = false;
    let mut index = 1;
    while index < words.len() {
        let word = &words[index];
        if rest || !word.starts_with("--") {
            if sub.is_none() {
                sub = Some(word.clone());
            } else {
                positional.push(inline_heredoc(word));
            }
            index += 1;
            continue;
        }
        if word == "--" {
            rest = true;
            index += 1;
            continue;
        }
        match word.find('=') {
            Some(equals) if equals > 0 => set_option(
                &mut options,
                word[..equals].to_owned(),
                inline_heredoc(&word[equals + 1..]),
            ),
            _ if CLIENT_VALUES.contains(&word.as_str()) => {
                let value = inline_heredoc(words.get(index + 1).map_or("", String::as_str));
                set_option(&mut options, word.clone(), value);
                index += 1;
            }
            _ => set_option(&mut options, word.clone(), "1".into()),
        }
        index += 1;
    }
    let sub = sub?;
    let joined = positional.join(" ");
    let text = if joined == "-" || joined.is_empty() {
        heredoc.clone().unwrap_or_default()
    } else {
        joined
    };
    let has = |name: &str| options.iter().any(|(k, _)| k == name);
    let option = |name: &str| {
        options
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };
    let line = |name: &str| {
        let value = option(name).map_or(f64::NAN, |v| js::number_from_text(&v));
        (js::is_safe_integer(value) && value > 0.0).then_some(value)
    };
    let mut args = Obj::new();
    let set = |args: &mut Obj, key: &str, value: Option<Value>| {
        if let Some(value) = value
            && value != Value::String(String::new())
        {
            args.insert(key.to_owned(), value);
        }
    };
    let s = |v: Option<String>| v.map(Value::String);
    set(&mut args, "description", s(option("--description")));
    set(&mut args, "review", s(option("--session")));
    let text_value = Some(Value::String(text.clone()));
    match sub.as_str() {
        "reply" | "edit" => {
            set(&mut args, "comment_id", s(option("--comment")));
            set(&mut args, "text", text_value);
            Some((format!("review_{sub}"), args))
        }
        "add" => {
            set(&mut args, "text", text_value);
            set(
                &mut args,
                "kind",
                has("--draft").then(|| Value::String("draft".into())),
            );
            set(&mut args, "file", s(option("--file")));
            set(&mut args, "line", line("--line").map(js::number));
            set(&mut args, "end_line", line("--end-line").map(js::number));
            set(&mut args, "side", s(option("--side")));
            set(&mut args, "quote", s(option("--quote")));
            set(&mut args, "on_comment", s(option("--on-comment")));
            Some(("review_add".into(), args))
        }
        "working" => {
            set(&mut args, "comment_id", s(option("--comment")));
            set(&mut args, "message", s(option("--message")));
            set(
                &mut args,
                "done",
                has("--done").then_some(Value::Bool(true)),
            );
            Some(("review_working".into(), args))
        }
        "resolve" | "reopen" => {
            set(&mut args, "comment_id", s(option("--comment")));
            let tool = if sub == "reopen" || has("--unresolve") {
                "review_reopen"
            } else {
                "review_resolve"
            };
            Some((tool.into(), args))
        }
        "update" => {
            set(&mut args, "message", s(option("--message")));
            Some(("review_update".into(), args))
        }
        "notify" => {
            set(&mut args, "title", s(option("--title")));
            set(&mut args, "text", text_value);
            Some(("review_notify".into(), args))
        }
        "work" => {
            let tool = positional.first()?.clone();
            let params = positional.get(1);
            let source = match params {
                None => heredoc.clone().unwrap_or_else(|| "{}".into()),
                Some(p) if p == "-" => heredoc.clone().unwrap_or_else(|| "{}".into()),
                Some(p) => p.clone(),
            };
            let mut out = match parse_tool_arguments(&source) {
                Some(Value::Object(map)) => map,
                _ => Obj::new(),
            };
            if let Some(description) = args.get("description")
                && description.as_str().is_some_and(|d| !d.is_empty())
            {
                out.insert("description".into(), description.clone());
            }
            Some((tool, out))
        }
        _ => None,
    }
}

/// A call to a Roamgate tool, as the tool and its arguments.
pub fn roamgate_tool_call(name: &str, args: &Obj) -> Option<(String, Obj)> {
    if let Some((server, tool)) = mcp_parts(name) {
        return is_roamgate_server(&server).then(|| (tool, args.clone()));
    }
    let command = match name {
        "Bash" => non_empty(args.get("command")),
        "exec_command" => non_empty(args.get("cmd")),
        _ => None,
    }?;
    if !command.contains("roamgate-review") {
        return None;
    }
    review_client_call(command)
}

/// `isThreadWrite`.
pub fn is_thread_write(write: &Obj) -> bool {
    !js::sv(write.get("action")).starts_with("item_")
}

fn write_text(text: Option<&str>) -> Obj {
    let Some(text) = text.filter(|t| !js::trim(t).is_empty()) else {
        return Obj::new();
    };
    if js::len16(text) > ROAMGATE_WRITE_TEXT_LIMIT {
        obj! { "text" => js::head16(text, ROAMGATE_WRITE_TEXT_LIMIT), "clipped" => true }
    } else {
        obj! { "text" => text }
    }
}

fn output_comments(output: Option<&Obj>) -> Vec<&Obj> {
    output
        .and_then(|o| o.get("comments"))
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn review_write(tool: &str, args: &Obj, output: Option<&Obj>) -> Option<Obj> {
    let comments = output_comments(output);
    let (action, comment): (&str, Option<String>) = match tool {
        "review_reply" => (
            "reply",
            comments
                .last()
                .and_then(|c| non_empty(c.get("id")))
                .map(str::to_owned),
        ),
        "review_add" => (
            if js::sv(args.get("kind")) == "draft" {
                "draft"
            } else {
                "comment"
            },
            comments
                .first()
                .and_then(|c| non_empty(c.get("id")))
                .map(str::to_owned),
        ),
        "review_edit" => {
            let asked = non_empty(args.get("comment_id")).map(js::trim);
            (
                "edit",
                asked.and_then(|asked| {
                    comments
                        .iter()
                        .filter_map(|c| non_empty(c.get("id")))
                        .find(|id| id.starts_with(asked))
                        .map(str::to_owned)
                }),
            )
        }
        _ => return None,
    };
    let where_ = output
        .and_then(thread_output_label)
        .filter(|w| !w.is_empty())
        .or_else(|| {
            non_empty(args.get("file"))
                .map(|file| format!("{}{}", short_path(file), line_suffix(args.get("line"))))
        });
    let description = non_empty(args.get("description"));
    let review = output.and_then(|o| non_empty(o.get("session")));
    let thread = output.and_then(|o| non_empty(o.get("id")));
    let base = obj! {
        "action" => action,
        "description" => description.map(first_line),
        "review" => review,
        "thread" => thread,
        "comment" => comment,
        "where" => where_,
    };
    Some(js::spread(base, &write_text(non_empty(args.get("text")))))
}

/// What a call wrote in Roamgate, or None.
pub fn roamgate_write(
    name: &str,
    args: &Value,
    result_text: Option<&str>,
    is_error: bool,
) -> Option<Obj> {
    if is_error {
        return None;
    }
    let parsed;
    let input = match args {
        Value::String(text) => {
            parsed = parse_tool_arguments(text)?;
            &parsed
        }
        other => other,
    };
    let input = input.as_object()?;
    let (tool, call_args) = roamgate_tool_call(name, input)?;
    let output = result_text
        .filter(|t| !t.is_empty())
        .and_then(roamgate_output);
    review_write(&tool, &call_args, output.as_ref())
        .or_else(|| work_write(&tool, &call_args, output.as_ref()))
}

fn state_name(state: Option<&Value>) -> Option<String> {
    let name = non_empty(state)?;
    Some(
        match name {
            "you" => "For you",
            "doing" => "Doing",
            "verify" => "Verify",
            "open" => "Open",
            "done" => "Done",
            other => other,
        }
        .to_owned(),
    )
}

fn item_change(args: &Obj) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(state) = state_name(args.get("state")) {
        parts.push(format!("moved to {state}"));
    }
    if let Some(title) = non_empty(args.get("title")) {
        parts.push(format!("retitled \"{}\"", start60(title)));
    }
    if non_empty(args.get("text")).is_some() {
        parts.push("rewrote its description".into());
    }
    let ticked: Vec<&str> = args
        .get("tick")
        .and_then(Value::as_array)
        .map(|tick| {
            tick.iter()
                .filter_map(Value::as_object)
                .filter_map(|each| non_empty(each.get("decision")))
                .collect()
        })
        .unwrap_or_default();
    if !ticked.is_empty() {
        parts.push(format!("ticked {}", ticked.join(", ")));
    }
    match args.get("owner") {
        Some(Value::Null) => parts.push("left it".into()),
        Some(Value::Object(_)) => parts.push("took it".into()),
        _ => {}
    }
    let is_array = |key: &str| args.get(key).is_some_and(Value::is_array);
    if is_array("add_links") || is_array("links") || is_array("remove_links") {
        parts.push("changed its links".into());
    }
    if is_array("tags") || is_array("add_tags") || is_array("remove_tags") {
        parts.push("changed its tags".into());
    }
    (!parts.is_empty()).then(|| parts.join(", "))
}

fn work_write(tool: &str, args: &Obj, output: Option<&Obj>) -> Option<Obj> {
    let action = match tool {
        "work_add" => "item_add",
        "work_update" => "item_update",
        "work_done" => "item_done",
        "work_reopen" => "item_reopen",
        _ => return None,
    };
    let item = output.and_then(|o| js::rec(o.get("item")));
    let id = item
        .and_then(|i| non_empty(i.get("id")))
        .or_else(|| non_empty(args.get("item")));
    let title = item
        .and_then(|i| non_empty(i.get("title")))
        .or_else(|| non_empty(args.get("title")));
    let state = item
        .and_then(|i| non_empty(i.get("state")))
        .or_else(|| non_empty(args.get("state")));
    let description = non_empty(args.get("description"));
    let change = if action == "item_update" {
        item_change(args)
    } else {
        None
    };
    let base = obj! {
        "action" => action,
        "description" => description.map(first_line),
        "item" => id,
        "title" => title.map(first_line),
        "state" => state,
        "change" => change,
    };
    Some(js::spread(base, &write_text(non_empty(args.get("text")))))
}

/// A Work item's write in one line.
pub fn item_write_line(write: &Obj) -> Option<String> {
    let title = js::str_of(write.get("title")).filter(|t| !t.is_empty());
    let item = js::str_of(write.get("item")).filter(|t| !t.is_empty());
    let name = match (title, item) {
        (Some(title), _) => format!("\"{}\"", start60(title)),
        (None, Some(item)) => format!("item {}", js::head16(item, 8)),
        _ => "an item".into(),
    };
    match js::sv(write.get("action")) {
        "item_add" => {
            let state = state_name(write.get("state"));
            let tail = match state {
                Some(s) if s != "Open" => format!(" ({s})"),
                _ => String::new(),
            };
            Some(format!("Added to Work: {name}{tail}"))
        }
        "item_update" => {
            let Some(change) = js::str_of(write.get("change")).filter(|c| !c.is_empty()) else {
                return Some(format!("Updated {name}"));
            };
            static MOVED: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"^moved to ([^,]+)$").unwrap());
            static RETITLED: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r#"^retitled "[^"]*"$"#).unwrap());
            if let Some(moved) = MOVED.captures(change) {
                return Some(format!("Moved {name} to {}", &moved[1]));
            }
            if RETITLED.is_match(change) {
                let which = item
                    .map(|i| format!("item {}", js::head16(i, 8)))
                    .unwrap_or_else(|| "an item".into());
                return Some(format!("Retitled {which}: {name}"));
            }
            Some(format!("Updated {name}: {change}"))
        }
        "item_done" => Some(format!("Marked {name} done")),
        "item_reopen" => {
            let state = state_name(write.get("state"));
            Some(format!(
                "Reopened {name}{}",
                state.map(|s| format!(" ({s})")).unwrap_or_default()
            ))
        }
        _ => None,
    }
}

fn todo_summary(args: &Obj) -> String {
    let active = args
        .get("todos")
        .and_then(Value::as_array)
        .and_then(|todos| {
            todos
                .iter()
                .filter_map(Value::as_object)
                .find(|todo| js::sv(todo.get("status")) == "in_progress")
        });
    let doing =
        active.and_then(|a| non_empty(a.get("activeForm")).or_else(|| non_empty(a.get("content"))));
    doing
        .map(first_line)
        .unwrap_or_else(|| "Updated the to-do list".into())
}

fn question_summary(args: &Obj) -> Option<String> {
    let first = args
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|q| q.iter().find_map(Value::as_object))?;
    non_empty(first.get("question")).map(|q| format!("Asked: {}", start(q, 100)))
}

fn tool_search_summary(query: &str) -> String {
    static SELECT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)^select:(.*)$").unwrap());
    let Some(select) = SELECT.captures(js::trim(query)) else {
        return format!("Looked for tools: \"{}\"", start60(query));
    };
    let names: Vec<String> = select[1]
        .split(',')
        .map(js::trim)
        .filter(|n| !n.is_empty())
        .map(tool_display_name)
        .collect();
    if names.is_empty() {
        "Loaded tools".into()
    } else {
        format!("Loaded tools: {}", names.join(", "))
    }
}

fn path_summary(verb: &str, args: &Obj) -> Option<String> {
    let path = non_empty(args.get("file_path"))
        .or_else(|| non_empty(args.get("filePath")))
        .or_else(|| non_empty(args.get("notebook_path")))
        .or_else(|| non_empty(args.get("path")))?;
    Some(format!("{verb} {}", short_path(js::trim(path))))
}

fn search_summary(verb: &str, args: &Obj) -> Option<String> {
    let pattern = non_empty(args.get("pattern"))?;
    let place = non_empty(args.get("path"))
        .map(|p| format!(" in {}", short_path(p)))
        .unwrap_or_default();
    Some(format!("{verb} {pattern}{place}"))
}

fn js_string_value(literal: &str) -> String {
    if literal.starts_with('"')
        && let Some(Value::String(text)) = js::parse(literal)
    {
        return text;
    }
    static ESCAPE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)").unwrap());
    let inner = if literal.len() >= 2 {
        js::slice16(literal, 1, Some(-1))
    } else {
        String::new()
    };
    ESCAPE
        .replace_all(&inner, |caps: &regex::Captures| {
            let escape = &caps[1];
            if escape.chars().count() > 1 {
                let code = u32::from_str_radix(&escape[1..], 16).unwrap_or(0);
                return char::from_u32(code).map(String::from).unwrap_or_default();
            }
            match escape {
                "n" => "\n".into(),
                "t" => "\t".into(),
                other => other.to_owned(),
            }
        })
        .into_owned()
}

const JS_STRING: &str = r#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`"#;

fn js_string_arguments(code: &str, key: &str) -> Vec<String> {
    let pattern = Regex::new(&format!(
        r#"(?:^|[{{,\s])["']?{}["']?\s*:\s*({JS_STRING})"#,
        regex::escape(key)
    ))
    .unwrap();
    pattern
        .captures_iter(code)
        .map(|caps| js_string_value(&caps[1]))
        .collect()
}

fn js_number_argument(code: &str, key: &str) -> Option<String> {
    let pattern = Regex::new(&format!(
        r#"["']?{}["']?\s*:\s*([0-9]+)"#,
        regex::escape(key)
    ))
    .unwrap();
    pattern.captures(code).map(|caps| caps[1].to_owned())
}

fn patch_summary(patch: &str) -> Option<String> {
    static FILES: LazyLock<FancyRegex> = LazyLock::new(|| {
        FancyRegex::new(r#"\*\*\* (Add|Update|Delete) File: (.+?)(?=\\n|\n|"|$)"#).unwrap()
    });
    let files: Vec<(&str, String)> = FILES
        .captures_iter(patch)
        .filter_map(Result::ok)
        .map(|caps| {
            let verb = match &caps[1] {
                "Add" => "Add",
                "Update" => "Edit",
                _ => "Delete",
            };
            (verb, short_path(js::trim(&caps[2])))
        })
        .collect();
    if files.is_empty() {
        return None;
    }
    let same = files.iter().all(|(verb, _)| *verb == files[0].0);
    Some(if same {
        format!(
            "{} {}",
            files[0].0,
            files
                .iter()
                .map(|(_, p)| p.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        files
            .iter()
            .map(|(v, p)| format!("{v} {p}"))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

fn write_stdin_summary(
    session_id: Option<&str>,
    chars: &str,
    context: &ToolSummaryContext,
) -> String {
    let command = session_id
        .and_then(|id| context.codex_command(id))
        .filter(|c| !c.is_empty());
    let target = match (command, session_id) {
        (Some(command), _) => first_line(&command),
        (None, Some(id)) if !id.is_empty() => format!("session {id}"),
        _ => "a session".into(),
    };
    if chars.is_empty() {
        return format!("Wait for output of {target}");
    }
    if chars == "\u{3}" {
        return format!("Interrupt {target}");
    }
    format!("Type into {target}: {}", start60(chars))
}

fn plan_summary(plan: Option<&Value>) -> String {
    let active = plan.and_then(Value::as_array).and_then(|steps| {
        steps
            .iter()
            .filter_map(Value::as_object)
            .find(|step| js::sv(step.get("status")) == "in_progress")
    });
    match active.and_then(|a| non_empty(a.get("step"))) {
        Some(step) => format!("Plan: {}", first_line(step)),
        None => "Updated the plan".into(),
    }
}

fn codex_code_call_summary(name: &str, code: &str, context: &ToolSummaryContext) -> String {
    match name {
        "exec_command" => js_string_arguments(code, "cmd")
            .first()
            .map(|c| first_line(c))
            .unwrap_or_else(|| "Run a command".into()),
        "write_stdin" => {
            let id = js_number_argument(code, "session_id");
            let chars = js_string_arguments(code, "chars")
                .into_iter()
                .next()
                .unwrap_or_default();
            write_stdin_summary(id.as_deref(), &chars, context)
        }
        "apply_patch" => patch_summary(code).unwrap_or_else(|| "Edit files".into()),
        "update_plan" => {
            static STEP: LazyLock<Regex> = LazyLock::new(|| {
                Regex::new(r#"step\s*["']?\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*["']?status["']?\s*:\s*["']in_progress"#)
                    .unwrap()
            });
            match STEP.captures(code) {
                Some(caps) => format!("Plan: {}", first_line(&js_string_value(&caps[1]))),
                None => "Updated the plan".into(),
            }
        }
        "view_image" => match js_string_arguments(code, "path").first() {
            Some(path) => format!("View {}", short_path(path)),
            None => "View an image".into(),
        },
        "web__run" => {
            if let Some(query) = js_string_arguments(code, "q").first() {
                return format!("Search the web: {}", first_line(query));
            }
            match js_string_arguments(code, "ref_id").first() {
                Some(r) if r.starts_with("http:") || r.starts_with("https:") => {
                    format!("Fetch {}", host_of(r))
                }
                _ => "Browse the web".into(),
            }
        }
        _ => capitalize(&words(&name.replace("__", ": "))),
    }
}

static TOOLS_CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)tools\.([A-Za-z0-9_]+)\s*\(").unwrap());

fn codex_exec_summary(code: &str, context: &ToolSummaryContext) -> Option<String> {
    let calls: Vec<_> = TOOLS_CALL.captures_iter(code).collect();
    if calls.is_empty() {
        return None;
    }
    Some(
        calls
            .iter()
            .enumerate()
            .map(|(index, call)| {
                let whole = call.get(0).unwrap();
                let end = calls
                    .get(index + 1)
                    .map_or(code.len(), |next| next.get(0).unwrap().start());
                codex_code_call_summary(&call[1], &code[whole.end()..end], context)
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn codex_tool_summary(name: &str, args: &Obj, context: &ToolSummaryContext) -> Option<String> {
    let value = non_empty(args.get("value"));
    match name {
        "exec" => value.and_then(|v| codex_exec_summary(v, context)),
        "exec_command" => non_empty(args.get("cmd")).map(first_line),
        "write_stdin" => {
            let id = match args.get("session_id") {
                Some(v @ Value::Number(_)) => Some(js::to_text(v)),
                Some(Value::String(s)) => Some(s.clone()),
                _ => None,
            };
            let chars = js::sv(args.get("chars"));
            Some(write_stdin_summary(id.as_deref(), chars, context))
        }
        "apply_patch" => {
            patch_summary(value.or_else(|| non_empty(args.get("input"))).unwrap_or(""))
        }
        "update_plan" => Some(plan_summary(args.get("plan"))),
        "view_image" => path_summary("View", args),
        "spawn_agent" => {
            non_empty(args.get("message")).map(|m| format!("Agent: {}", start(m, 100)))
        }
        "wait" | "wait_agent" => Some("Wait for agents".into()),
        "close_agent" => Some("Close an agent".into()),
        _ => None,
    }
}

fn codex_started_session(name: &str, args: &Obj, result: &str) -> Option<(String, String)> {
    static ID: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"session ID ([0-9]+)|\\?"session_id\\?"\s*:\s*([0-9]+)"#).unwrap()
    });
    let caps = ID.captures(result)?;
    let command = match name {
        "exec_command" => non_empty(args.get("cmd")).map(str::to_owned),
        "exec" => {
            let code = non_empty(args.get("value")).unwrap_or("");
            let calls: Vec<_> = TOOLS_CALL.captures_iter(code).collect();
            if calls.len() == 1 && &calls[0][1] == "exec_command" {
                js_string_arguments(code, "cmd").into_iter().next()
            } else {
                None
            }
        }
        _ => None,
    }?;
    let id = caps.get(1).or(caps.get(2))?.as_str().to_owned();
    Some((id, command))
}

fn known_tool_summary(name: &str, args: &Obj, context: &ToolSummaryContext) -> Option<String> {
    let description = non_empty(args.get("description"));
    match name {
        "SendMessage" => {
            let to = non_empty(args.get("to"));
            let what = non_empty(args.get("summary"))
                .map(str::to_owned)
                .or_else(|| non_empty(args.get("message")).map(start60));
            let who = to
                .map(|to| recipient(js::trim(to), context))
                .unwrap_or_else(|| "an agent".into());
            Some(match what {
                Some(what) => format!("To {who}: {}", first_line(&what)),
                None => format!("Message to {who}"),
            })
        }
        "Agent" | "Task" => {
            if let Some(d) = description {
                return Some(first_line(d));
            }
            non_empty(args.get("prompt")).map(|p| start(p, 100))
        }
        "Bash" | "Monitor" => {
            if let Some(d) = description {
                return Some(first_line(d));
            }
            non_empty(args.get("command")).map(first_line)
        }
        "Read" => path_summary("Read", args),
        "Edit" | "MultiEdit" | "NotebookEdit" => path_summary("Edit", args),
        "Write" => path_summary("Write", args),
        "Grep" => search_summary("Search for", args),
        "Glob" => search_summary("Find", args),
        "WebSearch" => {
            non_empty(args.get("query")).map(|q| format!("Search the web: {}", first_line(q)))
        }
        "WebFetch" => non_empty(args.get("url")).map(|u| format!("Fetch {}", host_of(js::trim(u)))),
        "ToolSearch" => non_empty(args.get("query")).map(tool_search_summary),
        "TodoWrite" => Some(todo_summary(args)),
        "Skill" => non_empty(args.get("skill")).map(|s| format!("Skill: {s}")),
        "AskUserQuestion" => question_summary(args),
        _ => codex_tool_summary(name, args, context),
    }
}

/// What a call does, in one short line.
pub fn tool_call_summary(
    name: &str,
    text: &str,
    context: &ToolSummaryContext,
    limit: usize,
) -> String {
    let parsed = match parse_tool_arguments(text) {
        Some(Value::Object(parsed)) => parsed,
        _ => return clip(&first_line(text), limit),
    };
    let mcp = mcp_parts(name);
    let client = if mcp.is_some() {
        None
    } else {
        roamgate_tool_call(name, &parsed)
    };
    if let Some((tool, client_args)) = &client {
        let described = non_empty(client_args.get("description"))
            .or_else(|| non_empty(parsed.get("description")));
        let line = match described {
            Some(d) => Some(first_line(d)),
            None => roamgate_summary(tool, client_args, context),
        };
        if let Some(line) = line.filter(|l| !l.is_empty()) {
            return clip(&line, limit);
        }
    }
    let known = match &mcp {
        Some((server, tool)) => {
            if is_roamgate_server(server) {
                roamgate_summary(tool, &parsed, context)
            } else {
                None
            }
        }
        None => known_tool_summary(name, &parsed, context),
    };
    if let Some(known) = known.filter(|k| !k.is_empty()) {
        return clip(&known, limit);
    }
    let line = match non_empty(parsed.get("description")) {
        Some(d) => Some(first_line(d)),
        None => key_argument(&parsed),
    };
    if mcp.is_some() {
        let label = tool_display_name(name);
        return clip(
            &match line.filter(|l| !l.is_empty()) {
                Some(line) => format!("{label} · {line}"),
                None => label,
            },
            limit,
        );
    }
    clip(
        &line.unwrap_or_else(|| first_line(&js::stringify(&Value::Object(parsed)))),
        limit,
    )
}

/// What a session tells about its calls' arguments (`createToolSummaryNotes`).
#[derive(Default, Debug, Clone)]
pub struct ToolSummaryNotes {
    pub agents: HashMap<String, String>,
    pub threads: HashMap<String, String>,
    pub sessions: HashMap<String, String>,
    pub codex_sessions: HashMap<String, String>,
}

impl ToolSummaryNotes {
    pub fn note_message(&mut self, text: &str) {
        static HEAD: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^- \[([0-9a-f]{8})\] .*:\s*$").unwrap());
        static QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {2}> \S").unwrap());
        static BODY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {2}[^\s>(]").unwrap());
        static FRAME: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"<roamgate-agent-message from="([^"]+)" from-name="([^"]*)""#).unwrap()
        });
        if text.is_empty() {
            return;
        }
        let lines: Vec<&str> = text.split('\n').collect();
        for (index, line) in lines.iter().enumerate() {
            let Some(head) = HEAD.captures(line) else {
                continue;
            };
            let rest = &lines[index + 1..];
            let end = rest.iter().position(|each| !each.starts_with("  "));
            let thread = match end {
                None => rest,
                Some(end) => &rest[..end],
            };
            let quote = thread.iter().find(|each| QUOTE.is_match(each));
            let body = thread.iter().find(|each| BODY.is_match(each));
            let label = start60(&match quote {
                Some(q) => q.strip_prefix("  > ").unwrap_or(q).to_owned(),
                None => body.map(|b| (*b).to_owned()).unwrap_or_default(),
            });
            if !label.is_empty() {
                self.threads.insert(head[1].to_owned(), label);
            }
        }
        for frame in FRAME.captures_iter(text) {
            let name = frame[2]
                .replace("&quot;", "\"")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&");
            if !js::trim(&name).is_empty() {
                self.sessions
                    .insert(frame[1].to_owned(), js::trim(&name).to_owned());
            }
        }
    }

    pub fn note_call(&mut self, name: &str, args: Option<&Value>, result: Option<&str>) {
        let empty = Obj::new();
        let input = js::rec(args).unwrap_or(&empty);
        let result = result.filter(|r| !r.is_empty());
        if let Some(result) = result
            && let Some((id, command)) = codex_started_session(name, input, result)
        {
            self.codex_sessions.insert(id, command);
        }
        if (name == "Agent" || name == "Task")
            && let Some(result) = result
        {
            static AGENT_ID: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"agentId:\s*([A-Za-z0-9_-]+)").unwrap());
            let id = AGENT_ID.captures(result).map(|c| c[1].to_owned());
            let label = if let Some(agent) = non_empty(input.get("name")) {
                Some(format!("the {} agent", js::trim(agent)))
            } else {
                non_empty(input.get("description")).map(|d| format!("the \"{}\" agent", start60(d)))
            };
            if let (Some(id), Some(label)) = (id, label) {
                self.agents.insert(id, label);
            }
        }
        let Some((server, tool)) = mcp_parts(name) else {
            return;
        };
        let Some(result) = result else { return };
        if !is_roamgate_server(&server) {
            return;
        }
        for (id, label) in threads_in_output(result) {
            self.threads.insert(id, label);
        }
        if tool == "agent_sessions"
            && let Some(Value::Object(parsed)) = parse_tool_arguments(result)
            && let Some(Value::Array(list)) = parsed.get("sessions")
        {
            for session in list.iter().filter_map(Value::as_object) {
                let address = non_empty(session.get("address"));
                let label = non_empty(session.get("title"))
                    .or_else(|| non_empty(session.get("name")))
                    .or_else(|| non_empty(session.get("workspace")));
                if let (Some(address), Some(label)) = (address, label) {
                    self.sessions
                        .insert(address.to_owned(), js::trim(label).to_owned());
                }
            }
        }
    }

    pub fn context(&self, result: Option<&str>) -> ToolSummaryContext<'_> {
        ToolSummaryContext {
            result: result.filter(|r| !r.is_empty()).map(str::to_owned),
            notes: Some(self),
            ..Default::default()
        }
    }
}
