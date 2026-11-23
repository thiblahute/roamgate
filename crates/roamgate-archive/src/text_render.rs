//! The conversation text of an archived transcript, one line per message,
//! as the text repo keeps it (archive/text-render.ts):
//!
//!   <timestamp> <role> <kind>[ <tool>]: <text, newlines folded>
//!
//! Rendered with the agent registry's parse, tool calls cut, tool output
//! left out, secrets redacted. A renderer resumes from a saved state, so a
//! transcript that grew is rendered from where the last pass stopped.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::extract::clip;
use roamgate_agents::js::{is_js_space, parse_line};
use roamgate_agents::{Agent, ParseState};
use roamgate_base::secrets::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::Number;
use sha2::{Digest, Sha256};

use crate::sync::huge_request;

/// Characters of a tool call's input kept on its line.
pub const DEFAULT_TOOL_CALL_CHARS: u64 = 2000;
/// What a newline inside a message becomes, so every message is one line.
pub const FOLD: &str = " \u{23ce} ";
const UNDATED: &str = "undated";

/// Bump when the rendering changes: a repo of another version is rebuilt.
pub const RENDER_VERSION: u64 = 2;

/// How text is rendered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderOptions {
    #[serde(rename = "toolCallChars")]
    pub tool_call_chars: u64,
    pub thinking: bool,
}

/// What a renderer carries from one pass to the next. Field order is the
/// order Bun's renderer writes them in state.json.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RenderState {
    #[serde(rename = "lastTs", skip_serializing_if = "Option::is_none")]
    pub last_ts: Option<String>,
    #[serde(rename = "firstTs", skip_serializing_if = "Option::is_none")]
    pub first_ts: Option<String>,
    /// The session's day in the repo, fixed at its first line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(rename = "lastMeta", skip_serializing_if = "Option::is_none")]
    pub last_meta: Option<String>,
    #[serde(rename = "lastTitle", skip_serializing_if = "Option::is_none")]
    pub last_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" *\r?\n *").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

/// Every message on one line.
pub fn fold_line(text: &str) -> String {
    NEWLINES.replace_all(text, FOLD).replace(['\t', '\r'], " ")
}

/// A token without spaces (a tool name, a project in a prompt line).
fn token(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if is_js_space(c) || c == ':' {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            in_run = false;
            out.push(c);
        }
    }
    if out.is_empty() { "-".into() } else { out }
}

/// `new Date(ms).toISOString().slice(0, 19)`.
fn iso_seconds(ms: f64) -> Option<String> {
    let timestamp = jiff::Timestamp::from_millisecond(ms.trunc() as i64).ok()?;
    Some(timestamp.strftime("%Y-%m-%dT%H:%M:%S").to_string())
}

/// `str.slice(0, n)` on an ASCII-ish timestamp, by UTF-16 units.
fn head(text: &str, units: usize) -> String {
    roamgate_agents::js::utf16_prefix(text, units).to_owned()
}

/// Renders transcript lines into text lines.
pub struct TextRenderer {
    pub lines: Vec<String>,
    pub redactions: u64,
    agent: Agent,
    history: bool,
    options: RenderOptions,
    parse: ParseState,
    state: RenderState,
}

impl TextRenderer {
    pub fn new(
        agent: Agent,
        history: bool,
        options: RenderOptions,
        saved: Option<&RenderState>,
    ) -> Self {
        let state = saved.cloned().unwrap_or_default();
        let mut parse = ParseState::new(options.thinking);
        parse.cwd = state.cwd.clone();
        parse.project = state.project.clone();
        parse.cost = state.cost.clone();
        parse.session = state.session.clone();
        Self {
            lines: Vec::new(),
            redactions: 0,
            agent,
            history,
            options,
            parse,
            state,
        }
    }

    /// The state to resume from later.
    pub fn save(&self) -> RenderState {
        let mut out = self.state.clone();
        if self.parse.cwd.is_some() {
            out.cwd = self.parse.cwd.clone();
        }
        if self.parse.project.is_some() {
            out.project = self.parse.project.clone();
        }
        if self.parse.cost.is_some() {
            out.cost = self.parse.cost.clone();
        }
        if self.parse.session.is_some() {
            out.session = self.parse.session.clone();
        }
        out
    }

    pub fn first_ts(&self) -> Option<&str> {
        self.state.first_ts.as_deref()
    }

    fn push(&mut self, head: &str, text: &str) {
        if self.state.day.is_none() {
            let day = self
                .state
                .first_ts
                .as_deref()
                .map(|ts| roamgate_agents::js::utf16_prefix(ts, 10))
                .unwrap_or("");
            self.state.day = Some(if DAY.is_match(day) {
                day.to_owned()
            } else {
                UNDATED.into()
            });
        }
        let redacted = redact_secrets(&fold_line(text));
        self.redactions += redacted.count as u64;
        self.lines.push(format!("{head}: {}", redacted.text));
    }

    /// Render one complete JSONL line (without its newline).
    pub fn line(&mut self, raw: &[u8]) {
        if raw.is_empty() || huge_request(raw) {
            return;
        }
        let Some(record) = parse_line(raw) else {
            return;
        };
        if self.history {
            let display = record.get("display").and_then(|v| v.as_str()).unwrap_or("");
            let text = roamgate_agents::js::js_trim(display);
            if text.is_empty() {
                return;
            }
            let ts = match record.get("timestamp") {
                Some(serde_json::Value::Number(ms)) => ms.as_f64().and_then(iso_seconds),
                _ => None,
            }
            .unwrap_or_else(|| self.state.last_ts.clone().unwrap_or_else(|| "-".into()));
            if ts != "-" {
                self.state.last_ts = Some(ts.clone());
                if self.state.first_ts.is_none() {
                    self.state.first_ts = Some(ts.clone());
                }
            }
            let project = match record.get("project") {
                Some(serde_json::Value::String(project)) => token(project),
                _ => "-".into(),
            };
            let text = text.to_owned();
            self.push(&format!("{ts} user prompt {project}"), &text);
            return;
        }
        if let Some(stamp) = self
            .agent
            .timestamp_of(&record)
            .map(|ts| head(&ts, 19))
            .filter(|ts| !ts.is_empty())
        {
            self.state.last_ts = Some(stamp.clone());
            if self.state.first_ts.is_none() {
                self.state.first_ts = Some(stamp);
            }
        }
        let ts = self.state.last_ts.clone().unwrap_or_else(|| "-".into());
        for doc in self.agent.parse(&record, &mut self.parse) {
            if doc.kind == "tool_result" {
                continue;
            }
            if doc.kind == "title" {
                if self.state.last_title.as_deref() == Some(doc.text.as_str()) {
                    continue;
                }
                self.state.last_title = Some(doc.text.clone());
            }
            let text = if doc.kind == "tool_use" {
                clip(&doc.text, self.options.tool_call_chars as usize)
            } else {
                doc.text
            };
            let kind = match &doc.tool {
                Some(tool) if !tool.is_empty() => format!("{} {}", doc.kind, token(tool)),
                _ => doc.kind.clone(),
            };
            if doc.role == "meta" {
                let key = format!("{} {kind}: {text}", doc.role);
                if self.state.last_meta.as_deref() == Some(key.as_str()) {
                    continue;
                }
                self.state.last_meta = Some(key);
            }
            self.push(&format!("{ts} {} {kind}", doc.role), &text);
        }
    }
}

/// Keeps a path component safe: letters, digits, dot, dash, underscore.
pub fn safe_component(value: &str) -> String {
    let replaced: String = value
        .chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                vec![c]
            } else {
                // Every UTF-16 unit of another character is one underscore.
                vec!['_'; c.len_utf16()]
            }
        })
        .collect();
    let trimmed = replaced.trim_start_matches('.');
    let out = if trimmed.len() < replaced.len() {
        format!("_{trimmed}")
    } else {
        replaced
    };
    if out.is_empty() { "_".into() } else { out }
}

/// What a text file is rendered from.
#[derive(Debug, Clone)]
pub struct TextFileSubject<'a> {
    pub host: &'a str,
    pub agent: &'a str,
    pub relpath: &'a str,
    pub history: bool,
    pub project: &'a str,
    pub session: &'a str,
    pub subagent: bool,
}

fn posix_basename<'a>(relpath: &'a str, ext: &str) -> &'a str {
    let name = relpath
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(relpath);
    match name.strip_suffix(ext) {
        Some(stem) if !stem.is_empty() => stem,
        _ => name,
    }
}

/// The path of a transcript's text in the repo:
/// host/agent/project/YYYY/MM/DD/<session>[.<subagent>].md, or
/// host/@history/agent/<name>.md for a prompt history. None before its
/// first line.
pub fn text_path(subject: &TextFileSubject<'_>, state: &RenderState) -> Option<String> {
    let host = safe_component(subject.host);
    let agent = safe_component(subject.agent);
    if subject.history {
        let name = subject.relpath.strip_prefix('@').unwrap_or(subject.relpath);
        let name = name.strip_suffix(".jsonl").unwrap_or(name);
        return Some(format!(
            "{host}/@history/{agent}/{}.md",
            safe_component(name)
        ));
    }
    let day = state.day.as_deref()?;
    if day.is_empty() {
        return None;
    }
    let day = if DAY.is_match(day) {
        day.replace('-', "/")
    } else {
        UNDATED.into()
    };
    let project_source = state
        .project
        .as_deref()
        .filter(|p| !p.is_empty())
        .or(Some(subject.project).filter(|p| !p.is_empty()))
        .unwrap_or("_unknown");
    let project = safe_component(project_source);
    let session_source = if subject.session.is_empty() {
        posix_basename(subject.relpath, ".jsonl")
    } else {
        subject.session
    };
    let mut name = safe_component(session_source);
    if subject.subagent {
        name.push('.');
        name.push_str(&safe_component(posix_basename(subject.relpath, ".jsonl")));
    }
    Some(format!("{host}/{agent}/{project}/{day}/{name}.md"))
}

/// A taken path's deterministic alternative: the 8 hex of the raw path's
/// sha256.
pub fn suffixed_path(path: &str, raw_key: &str) -> String {
    let hash = hex::encode(Sha256::digest(raw_key.as_bytes()));
    match path.strip_suffix(".md") {
        Some(stem) => format!("{stem}.{}.md", &hash[..8]),
        None => path.to_owned(),
    }
}

/// The first line of a text file: where it comes from.
pub fn header_line(raw_key: &str, state: &RenderState) -> String {
    match state.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        Some(cwd) => format!("# {raw_key} cwd={}", fold_line(cwd)),
        None => format!("# {raw_key}"),
    }
}

/// A text line's fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLine {
    pub ts: Option<String>,
    pub role: String,
    pub kind: String,
    pub tool: Option<String>,
    pub text: String,
}

static LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\S+) (\S+) ([^\s:]+)(?: ([^\s:]+))?: ([\s\S]*)$").unwrap());

/// A text line back into its fields; None for the header or a foreign line.
pub fn parse_text_line(line: &str) -> Option<ParsedLine> {
    if line.starts_with("# ") {
        return None;
    }
    let found = LINE.captures(line)?;
    let ts = found.get(1)?.as_str();
    Some(ParsedLine {
        ts: (ts != "-").then(|| ts.to_owned()),
        role: found.get(2)?.as_str().to_owned(),
        kind: found.get(3)?.as_str().to_owned(),
        tool: found.get(4).map(|tool| tool.as_str().to_owned()),
        text: found.get(5)?.as_str().to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> RenderOptions {
        RenderOptions {
            tool_call_chars: 2000,
            thinking: false,
        }
    }

    fn render(agent: Agent, lines: &[&str]) -> TextRenderer {
        let mut renderer = TextRenderer::new(agent, false, options(), None);
        for line in lines {
            renderer.line(line.as_bytes());
        }
        renderer
    }

    #[test]
    fn one_line_per_message_tool_calls_cut_tool_output_left_out() {
        let long = "x".repeat(50);
        let renderer = TextRenderer::new(
            Agent::Claude,
            false,
            RenderOptions {
                tool_call_chars: 10,
                thinking: false,
            },
            None,
        );
        let mut renderer = renderer;
        renderer.line(
            br#"{"type":"user","timestamp":"2026-01-02T03:04:05.678Z","cwd":"/w","message":{"content":"first\n  second"}}"#,
        );
        renderer.line(
            format!(
                r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash Tool","input":{{"command":"{long}"}}}},{{"type":"tool_result","content":"out"}}]}}}}"#
            )
            .as_bytes(),
        );
        renderer.line(br#"{"type":"ai-title","aiTitle":"T"}"#);
        renderer.line(br#"{"type":"ai-title","aiTitle":"T"}"#);
        assert_eq!(
            renderer.lines,
            vec![
                "2026-01-02T03:04:05 user text: first \u{23ce} second".to_owned(),
                "2026-01-02T03:04:05 assistant tool_use Bash_Tool: xxxxxxxxxx".to_owned(),
                "2026-01-02T03:04:05 meta title: T".to_owned(),
            ]
        );
        let saved = renderer.save();
        assert_eq!(saved.cwd.as_deref(), Some("/w"));
        assert_eq!(saved.day.as_deref(), Some("2026-01-02"));
    }

    #[test]
    fn resumes_from_a_saved_state_titles_and_timestamps_carry_over() {
        let first = render(
            Agent::Claude,
            &[r#"{"type":"ai-title","aiTitle":"T","timestamp":"2026-01-02T00:00:00Z"}"#],
        );
        let mut second = TextRenderer::new(Agent::Claude, false, options(), Some(&first.save()));
        second.line(br#"{"type":"ai-title","aiTitle":"T"}"#);
        second.line(br#"{"type":"user","message":{"content":"later"}}"#);
        assert_eq!(
            second.lines,
            vec!["2026-01-02T00:00:00 user text: later".to_owned()]
        );
    }

    #[test]
    fn the_day_is_fixed_at_the_first_line_undated_when_no_time_came_first() {
        let renderer = render(
            Agent::Claude,
            &[
                r#"{"type":"user","message":{"content":"no time"}}"#,
                r#"{"type":"user","timestamp":"2026-03-04T00:00:00Z","message":{"content":"timed"}}"#,
            ],
        );
        let state = renderer.save();
        assert_eq!(state.day.as_deref(), Some("undated"));
        let subject = TextFileSubject {
            host: "h",
            agent: "claude",
            relpath: "p/s.jsonl",
            history: false,
            project: "p",
            session: "s",
            subagent: false,
        };
        assert_eq!(
            text_path(&subject, &state).unwrap(),
            "h/claude/p/undated/s.md"
        );
    }

    #[test]
    fn prompt_history_lines_carry_the_project_as_a_token() {
        let mut renderer = TextRenderer::new(Agent::Claude, true, options(), None);
        renderer.line(
            br#"{"display":" fix it ","timestamp":1767225600000,"project":"/home/me/my proj"}"#,
        );
        renderer.line(br#"{"display":"again"}"#);
        assert_eq!(
            renderer.lines,
            vec![
                "2026-01-01T00:00:00 user prompt /home/me/my_proj: fix it".to_owned(),
                "2026-01-01T00:00:00 user prompt -: again".to_owned(),
            ]
        );
    }

    #[test]
    fn secrets_are_redacted_and_counted() {
        let renderer = render(
            Agent::Claude,
            &[r#"{"type":"user","message":{"content":"token glpat-abcdefghijklmnop here"}}"#],
        );
        assert_eq!(renderer.redactions, 1);
        assert!(!renderer.lines[0].contains("glpat-abcdefghijklmnop"));
    }

    #[test]
    fn host_agent_project_day_session_md_dated_by_the_first_message() {
        let renderer = render(
            Agent::Claude,
            &[r#"{"type":"user","timestamp":"2026-05-06T07:08:09Z","message":{"content":"x"}}"#],
        );
        let state = renderer.save();
        let subject = TextFileSubject {
            host: "my host",
            agent: "claude",
            relpath: "p/s/subagents/agent-a.jsonl",
            history: false,
            project: "-home-me-p",
            session: "s",
            subagent: true,
        };
        assert_eq!(
            text_path(&subject, &state).unwrap(),
            "my_host/claude/-home-me-p/2026/05/06/s.agent-a.md"
        );
        let history = TextFileSubject {
            relpath: "@history.jsonl",
            history: true,
            subagent: false,
            ..subject
        };
        assert_eq!(
            text_path(&history, &RenderState::default()).unwrap(),
            "my_host/@history/claude/history.md"
        );
        assert_eq!(
            text_path(
                &TextFileSubject {
                    history: false,
                    ..history
                },
                &RenderState::default()
            ),
            None
        );
        assert_eq!(safe_component(".hidden"), "_hidden");
    }

    #[test]
    fn the_collision_suffix_is_the_raw_path_s_sha256() {
        let hash = hex::encode(Sha256::digest(b"h/claude/p/s.jsonl"));
        assert_eq!(
            suffixed_path("a/b.md", "h/claude/p/s.jsonl"),
            format!("a/b.{}.md", &hash[..8])
        );
    }

    #[test]
    fn lines_parse_back_colons_in_the_text_included() {
        assert_eq!(
            parse_text_line("2026-01-02T03:04:05 assistant tool_use Bash: a: b"),
            Some(ParsedLine {
                ts: Some("2026-01-02T03:04:05".into()),
                role: "assistant".into(),
                kind: "tool_use".into(),
                tool: Some("Bash".into()),
                text: "a: b".into(),
            })
        );
        assert_eq!(parse_text_line("- user text: x").unwrap().ts, None);
        assert_eq!(parse_text_line("# h/claude/x"), None);
        assert_eq!(parse_text_line("garbage"), None);
    }
}
