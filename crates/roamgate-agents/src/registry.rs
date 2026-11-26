//! The agent registry of the session archive (archive/adapters.ts): one
//! adapter per agent, saying where its sessions live (with the agent's own
//! environment overrides), which files are sessions, how a file maps to a
//! session, and what its records say for the archive (its documents, as
//! archive/extract.ts reads them). A session file is the source of truth;
//! the adapters only teach the archive to read it.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::extract::{
    Doc, UnknownTypes, clip, clip_result, count_unknown, stable_stringify, string_field,
};
use crate::js::{js_lower, js_trim};

/// Where a file of a session belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    pub project: String,
    pub session: String,
    pub subagent: bool,
}

/// What parsing learns about a file besides its documents.
#[derive(Debug, Clone, Default)]
pub struct ParseState {
    pub thinking: bool,
    pub unknown: UnknownTypes,
    pub cwd: Option<String>,
    /// The session's cost (a JavaScript number).
    pub cost: Option<serde_json::Number>,
    /// Set when the project is only known from the content.
    pub project: Option<String>,
    pub session: Option<String>,
}

impl ParseState {
    pub fn new(thinking: bool) -> Self {
        Self {
            thinking,
            ..Self::default()
        }
    }
}

/// A file outside the sessions root (the Claude prompt history).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtraFile {
    /// Archive relpath; starts with `@` so it never meets a session file.
    pub relpath: &'static str,
    /// Path under the host's home.
    pub home_path: &'static str,
}

/// How a session file changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// JSONL that only grows.
    Append,
    /// Replaced as a whole.
    Replace,
}

/// The agents Roamgate knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Agent {
    Claude,
    Codex,
    Pi,
    Grok,
    Muse,
    Antigravity,
}

/// Every agent, in the registry's order (`ADAPTERS`).
pub const AGENTS: [Agent; 6] = [
    Agent::Claude,
    Agent::Codex,
    Agent::Pi,
    Agent::Grok,
    Agent::Muse,
    Agent::Antigravity,
];

/// An environment: a variable's value, if set.
pub trait Env {
    fn var(&self, name: &str) -> Option<String>;
}

impl<F: Fn(&str) -> Option<String>> Env for F {
    fn var(&self, name: &str) -> Option<String> {
        self(name)
    }
}

/// No variables (a remote host's roots).
pub struct NoEnv;

impl Env for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap()
});

/// A variable trimmed, when not empty (`env.X?.trim() || ...`).
fn env_dir(env: &dyn Env, name: &str) -> Option<String> {
    env.var(name)
        .map(|value| js_trim(&value).to_owned())
        .filter(|value| !value.is_empty())
}

/// `path.posix.basename(relpath, ext)`.
fn basename<'a>(relpath: &'a str, ext: &str) -> &'a str {
    let trimmed = relpath.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    match name.strip_suffix(ext) {
        Some(stem) if !ext.is_empty() && !stem.is_empty() => stem,
        _ => name,
    }
}

/// `path.posix.dirname(relpath)`.
fn dirname(relpath: &str) -> &str {
    match relpath.trim_end_matches('/').rfind('/') {
        Some(0) => "/",
        Some(index) => &relpath[..index],
        None => ".",
    }
}

/// Claude names a project directory after the working directory.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .flat_map(|c| {
            let mut units = [0u16; 2];
            let count = if c.is_ascii_alphanumeric() {
                0
            } else {
                c.encode_utf16(&mut units).len()
            };
            // Every UTF-16 unit of a non-alphanumeric character is one dash.
            if count == 0 {
                vec![c]
            } else {
                vec!['-'; count]
            }
        })
        .collect()
}

static HOME_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-(Users|var-home|home)-[^-]+").unwrap());
static CWD_HOME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/(Users|var/home|home)/[^/]+").unwrap());

/// A Claude project directory name moved to another machine: the home
/// directory part is swapped for the target's, the rest stays.
pub fn map_claude_project(project: &str, target_home: &str) -> String {
    match HOME_PREFIX.find(project) {
        Some(found) => format!(
            "{}{}",
            claude_project_dir_name(target_home),
            &project[found.end()..]
        ),
        None => project.to_owned(),
    }
}

/// The same for a working directory path.
pub fn map_cwd(cwd: &str, target_home: &str) -> String {
    match CWD_HOME.find(cwd) {
        Some(found) => format!("{target_home}{}", &cwd[found.end()..]),
        None => cwd.to_owned(),
    }
}

fn join(base: impl AsRef<Path>, rest: &str) -> PathBuf {
    base.as_ref().join(rest)
}

fn content_blocks(content: Option<&Value>) -> Vec<&Map<String, Value>> {
    match content {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

fn codex_message_text(content: Option<&Value>) -> String {
    if let Some(Value::String(text)) = content {
        return text.clone();
    }
    content_blocks(content)
        .into_iter()
        .filter_map(|block| string_field(block, "text"))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

const CODEX_IGNORED: &[&str] = &[
    "event_msg",
    "turn_context",
    "compacted",
    "world_state",
    "token_usage_record",
];
const CODEX_ITEM_IGNORED: &[&str] = &[
    "web_search_call",
    "local_shell_call",
    "ghost_snapshot",
    "tool_search_call",
    "tool_search_output",
];
const PI_IGNORED: &[&str] = &[
    "model_change",
    "thinking_level_change",
    "label",
    "compaction",
    "branch_summary",
    "session_info",
];

fn timestamp_field(record: &Value) -> Option<String> {
    record
        .as_object()
        .and_then(|object| string_field(object, "timestamp"))
        .map(str::to_owned)
}

impl Agent {
    /// The agent of an id (`ADAPTERS[id]`).
    pub fn from_id(id: &str) -> Option<Self> {
        AGENTS.into_iter().find(|agent| agent.id() == id)
    }

    pub fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Pi => "pi",
            Agent::Grok => "grok",
            Agent::Muse => "muse",
            Agent::Antigravity => "antigravity",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
            Agent::Pi => "Pi",
            Agent::Grok => "Grok",
            Agent::Muse => "Muse",
            Agent::Antigravity => "Antigravity",
        }
    }

    pub fn mode(self) -> Mode {
        match self {
            Agent::Claude | Agent::Codex | Agent::Pi => Mode::Append,
            Agent::Grok | Agent::Muse | Agent::Antigravity => Mode::Replace,
        }
    }

    /// False: archived raw, never indexed (an adapter stub).
    pub fn indexable(self) -> bool {
        matches!(self, Agent::Claude | Agent::Codex | Agent::Pi)
    }

    /// Whether `resume` can put the session back for the agent.
    pub fn supports_resume(self) -> bool {
        matches!(self, Agent::Claude | Agent::Pi)
    }

    /// A live SQLite file, snapshotted before it is copied.
    pub fn snapshot_sqlite(self) -> bool {
        self == Agent::Antigravity
    }

    /// The sessions root under a home directory, honouring the agent's
    /// environment.
    pub fn root_for(self, home: &Path, env: &dyn Env) -> PathBuf {
        match self {
            Agent::Claude => home.join(".claude").join("projects"),
            Agent::Codex => join(
                env_dir(env, "CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from),
                "sessions",
            ),
            Agent::Pi => join(
                env_dir(env, "PI_CODING_AGENT_DIR")
                    .map_or_else(|| home.join(".pi").join("agent"), PathBuf::from),
                "sessions",
            ),
            Agent::Grok => join(
                env_dir(env, "GROK_HOME").map_or_else(|| home.join(".grok"), PathBuf::from),
                "sessions",
            ),
            Agent::Muse => {
                let data = env_dir(env, "XDG_DATA_HOME").filter(|data| data.starts_with('/'));
                data.map_or_else(|| home.join(".local").join("share"), PathBuf::from)
                    .join("muse")
                    .join("sessions")
            }
            Agent::Antigravity => env_dir(env, "ANTIGRAVITY_CONVERSATIONS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    env_dir(env, "ANTIGRAVITY_HOME")
                        .or_else(|| env_dir(env, "GEMINI_HOME"))
                        .map_or_else(
                            || home.join(".gemini").join("antigravity-cli"),
                            PathBuf::from,
                        )
                        .join("conversations")
                }),
        }
    }

    /// The session roots account profiles keep apart from the user's own
    /// ([`Self::root_for`]), under Roamgate's data root: Claude's and
    /// Codex's that could not be linked to the user's, and every `agy`
    /// account's conversations.
    pub fn account_roots(self, data_root: &Path) -> Vec<PathBuf> {
        use roamgate_accounts::{AccountAgent, session_roots};
        match self {
            Agent::Claude => session_roots(data_root, AccountAgent::Claude),
            Agent::Codex => session_roots(data_root, AccountAgent::Codex),
            Agent::Antigravity => session_roots(data_root, AccountAgent::Agy),
            Agent::Pi | Agent::Grok | Agent::Muse => Vec::new(),
        }
    }

    /// rsync filter arguments that select the session files under the root.
    pub fn rsync_filters(self) -> &'static [&'static str] {
        match self {
            Agent::Claude | Agent::Pi | Agent::Muse => {
                &["--include=*/", "--include=*.jsonl", "--exclude=*"]
            }
            Agent::Codex => &["--include=*/", "--include=rollout-*.jsonl", "--exclude=*"],
            Agent::Grok => &[
                "--include=*/",
                "--include=*.jsonl",
                "--include=summary.json",
                "--exclude=*",
            ],
            Agent::Antigravity => &["--include=*.db", "--exclude=*"],
        }
    }

    pub fn accepts(self, relpath: &str) -> bool {
        match self {
            Agent::Claude | Agent::Muse => relpath.ends_with(".jsonl"),
            Agent::Codex => {
                basename(relpath, "").starts_with("rollout-") && relpath.ends_with(".jsonl")
            }
            Agent::Pi => relpath.ends_with(".jsonl") && relpath.contains('/'),
            Agent::Grok => relpath.ends_with(".jsonl") || relpath.ends_with("summary.json"),
            Agent::Antigravity => relpath.ends_with(".db"),
        }
    }

    pub fn classify(self, relpath: &str) -> FileMeta {
        match self {
            Agent::Claude => {
                let parts: Vec<&str> = relpath.split('/').collect();
                let project = parts.first().copied().unwrap_or("").to_owned();
                if parts.len() == 2 {
                    let session = parts[1].strip_suffix(".jsonl").unwrap_or(parts[1]);
                    FileMeta {
                        project,
                        session: session.to_owned(),
                        subagent: false,
                    }
                } else {
                    FileMeta {
                        project,
                        session: parts.get(1).copied().unwrap_or("").to_owned(),
                        subagent: true,
                    }
                }
            }
            Agent::Codex => {
                let name = basename(relpath, ".jsonl");
                let session = UUID
                    .find_iter(name)
                    .last()
                    .map(|found| js_lower(found.as_str()))
                    .unwrap_or_else(|| name.to_owned());
                FileMeta {
                    project: String::new(),
                    session,
                    subagent: false,
                }
            }
            Agent::Pi => {
                let project = relpath.split('/').next().unwrap_or("").to_owned();
                let name = basename(relpath, ".jsonl");
                let session = UUID
                    .find(name)
                    .map(|found| js_lower(found.as_str()))
                    .unwrap_or_else(|| name.to_owned());
                FileMeta {
                    project,
                    session,
                    subagent: false,
                }
            }
            Agent::Grok | Agent::Muse | Agent::Antigravity => {
                let dir = dirname(relpath);
                let name = basename(relpath, "");
                let session = match name.rfind('.') {
                    Some(dot) if dot + 1 < name.len() => &name[..dot],
                    _ => name,
                };
                FileMeta {
                    project: if dir == "." {
                        String::new()
                    } else {
                        dir.to_owned()
                    },
                    session: session.to_owned(),
                    subagent: false,
                }
            }
        }
    }

    pub fn timestamp_of(self, record: &Value) -> Option<String> {
        if self.indexable() {
            timestamp_field(record)
        } else {
            None
        }
    }

    pub fn parse(self, record: &Value, state: &mut ParseState) -> Vec<Doc> {
        match self {
            Agent::Claude => {
                if let Some(object) = record.as_object() {
                    if state.cwd.is_none()
                        && let Some(cwd) = string_field(object, "cwd")
                    {
                        state.cwd = Some(cwd.to_owned());
                    }
                    if object.get("type").and_then(Value::as_str) == Some("cost-state")
                        && let Some(Value::Number(cost)) = object.get("totalCostUSD")
                    {
                        state.cost = Some(cost.clone());
                    }
                }
                crate::extract::extract(record, state.thinking, &mut state.unknown)
            }
            Agent::Codex => parse_codex(record, state),
            Agent::Pi => parse_pi(record, state),
            Agent::Grok | Agent::Muse | Agent::Antigravity => Vec::new(),
        }
    }

    pub fn extra_files(self) -> &'static [ExtraFile] {
        match self {
            Agent::Claude => &[ExtraFile {
                relpath: "@history.jsonl",
                home_path: ".claude/history.jsonl",
            }],
            _ => &[],
        }
    }

    /// The relpath a restored session takes on the target machine.
    pub fn restore_relpath(self, relpath: &str, target_home: &str) -> String {
        match self {
            Agent::Claude => {
                let mut parts: Vec<String> = relpath.split('/').map(str::to_owned).collect();
                if let Some(first) = parts.first_mut() {
                    *first = map_claude_project(first, target_home);
                }
                parts.join("/")
            }
            _ => relpath.to_owned(),
        }
    }

    /// What to run to continue the session; None when it cannot be resumed.
    pub fn resume_command(self, session: &str) -> Option<String> {
        match self {
            Agent::Claude => Some(format!("claude --resume {session}")),
            Agent::Pi => Some(format!("pi --session {session}")),
            _ => None,
        }
    }
}

fn parse_codex(record: &Value, state: &mut ParseState) -> Vec<Doc> {
    let Some(record) = record.as_object() else {
        return Vec::new();
    };
    let kind = string_field(record, "type").unwrap_or("");
    let empty = Map::new();
    let payload = record
        .get("payload")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if kind == "session_meta" {
        if let Some(cwd) = string_field(payload, "cwd").filter(|cwd| !cwd.is_empty())
            && state.cwd.is_none()
        {
            state.cwd = Some(cwd.to_owned());
            state.project = Some(claude_project_dir_name(cwd));
        }
        if let Some(id) = string_field(payload, "id").filter(|id| !id.is_empty())
            && UUID.is_match(id)
        {
            state.session = Some(js_lower(id));
        }
        return Vec::new();
    }
    if CODEX_IGNORED.contains(&kind) {
        return Vec::new();
    }
    if kind != "response_item" {
        count_unknown(&mut state.unknown, kind);
        return Vec::new();
    }
    let item = string_field(payload, "type").unwrap_or("");
    match item {
        "message" => {
            let role = match payload.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("user") => "user",
                _ => return Vec::new(),
            };
            let text = codex_message_text(payload.get("content"));
            if js_trim(&text).is_empty() {
                return Vec::new();
            }
            vec![Doc::new(role, "text", None, clip(&text, 20_000))]
        }
        "function_call" | "custom_tool_call" => {
            let raw = match payload.get("arguments") {
                Some(Value::Null) | None => payload.get("input").filter(|v| !v.is_null()),
                some => some,
            };
            let text = match raw {
                Some(Value::String(text)) => text.clone(),
                Some(other) => stable_stringify(other),
                None => stable_stringify(&Value::String(String::new())),
            };
            vec![Doc::new(
                "assistant",
                "tool_use",
                string_field(payload, "name").map(str::to_owned),
                clip(&text, 2_000),
            )]
        }
        "function_call_output" | "custom_tool_call_output" => {
            let text = match payload.get("output") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) | None => stable_stringify(&Value::String(String::new())),
                Some(other) => stable_stringify(other),
            };
            let trimmed = js_trim(&text);
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![Doc::new("tool", "tool_result", None, clip_result(trimmed))]
            }
        }
        "reasoning" => {
            if !state.thinking {
                return Vec::new();
            }
            let summary = content_blocks(payload.get("summary"))
                .into_iter()
                .filter_map(|block| string_field(block, "text"))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if summary.is_empty() {
                Vec::new()
            } else {
                vec![Doc::new(
                    "assistant",
                    "thinking",
                    None,
                    clip(&summary, 20_000),
                )]
            }
        }
        other => {
            if !CODEX_ITEM_IGNORED.contains(&other) {
                count_unknown(&mut state.unknown, &format!("response_item/{other}"));
            }
            Vec::new()
        }
    }
}

fn parse_pi(record: &Value, state: &mut ParseState) -> Vec<Doc> {
    let Some(record) = record.as_object() else {
        return Vec::new();
    };
    let kind = string_field(record, "type").unwrap_or("");
    if kind == "session" {
        if let Some(cwd) = string_field(record, "cwd").filter(|cwd| !cwd.is_empty())
            && state.cwd.is_none()
        {
            state.cwd = Some(cwd.to_owned());
        }
        return Vec::new();
    }
    if PI_IGNORED.contains(&kind) {
        return Vec::new();
    }
    if kind == "custom_message" {
        return match string_field(record, "content") {
            Some(content) if !js_trim(content).is_empty() => {
                vec![Doc::new("system", "text", None, clip(content, 20_000))]
            }
            _ => Vec::new(),
        };
    }
    if kind != "message" {
        count_unknown(&mut state.unknown, kind);
        return Vec::new();
    }
    let empty = Map::new();
    let message = record
        .get("message")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let role = string_field(message, "role");
    let mut out = Vec::new();
    if role == Some("toolResult") {
        let text = codex_message_text(message.get("content"));
        let trimmed = js_trim(&text);
        if !trimmed.is_empty() {
            out.push(Doc::new(
                "tool",
                "tool_result",
                string_field(message, "toolName").map(str::to_owned),
                clip_result(trimmed),
            ));
        }
        return out;
    }
    let role = match role {
        Some(role @ ("user" | "assistant")) => role,
        _ => return out,
    };
    for block in content_blocks(message.get("content")) {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = string_field(block, "text")
                    && !js_trim(text).is_empty()
                {
                    out.push(Doc::new(role, "text", None, clip(text, 20_000)));
                }
            }
            Some("toolCall") => {
                let arguments = match block.get("arguments") {
                    Some(Value::Null) | None => Value::Object(Map::new()),
                    Some(other) => other.clone(),
                };
                out.push(Doc::new(
                    role,
                    "tool_use",
                    string_field(block, "name").map(str::to_owned),
                    clip(&stable_stringify(&arguments), 2_000),
                ));
            }
            Some("thinking") if state.thinking => {
                if let Some(text) = string_field(block, "thinking").filter(|text| !text.is_empty())
                {
                    out.push(Doc::new(role, "thinking", None, clip(text, 20_000)));
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roots_honour_the_agents_environment() {
        let home = Path::new("/h");
        let none = NoEnv;
        assert_eq!(
            Agent::Claude.root_for(home, &none),
            Path::new("/h/.claude/projects")
        );
        assert_eq!(
            Agent::Codex.root_for(home, &none),
            Path::new("/h/.codex/sessions")
        );
        let env = |name: &str| (name == "CODEX_HOME").then(|| " /c ".to_owned());
        assert_eq!(Agent::Codex.root_for(home, &env), Path::new("/c/sessions"));
        let env = |name: &str| (name == "XDG_DATA_HOME").then(|| "rel".to_owned());
        assert_eq!(
            Agent::Muse.root_for(home, &env),
            Path::new("/h/.local/share/muse/sessions")
        );
        let env = |name: &str| (name == "GEMINI_HOME").then(|| "/g".to_owned());
        assert_eq!(
            Agent::Antigravity.root_for(home, &env),
            Path::new("/g/conversations")
        );
    }

    #[test]
    fn files_map_to_sessions() {
        assert_eq!(
            Agent::Claude.classify("p/abc.jsonl"),
            FileMeta {
                project: "p".into(),
                session: "abc".into(),
                subagent: false
            }
        );
        assert_eq!(
            Agent::Claude.classify("p/abc/subagents/agent-1.jsonl"),
            FileMeta {
                project: "p".into(),
                session: "abc".into(),
                subagent: true
            }
        );
        let codex = Agent::Codex.classify(
            "2026/01/02/rollout-2026-01-02T10-00-00-0199AAAA-1111-2222-3333-444455556666.jsonl",
        );
        assert_eq!(codex.session, "0199aaaa-1111-2222-3333-444455556666");
        assert!(Agent::Codex.accepts("a/rollout-x.jsonl"));
        assert!(!Agent::Codex.accepts("a/other.jsonl"));
        assert!(!Agent::Pi.accepts("top.jsonl"));
        assert_eq!(Agent::Grok.classify("s1/summary.json").session, "summary");
        assert_eq!(Agent::Grok.classify("s1/summary.json").project, "s1");
        assert_eq!(Agent::Antigravity.classify("c.db").project, "");
    }

    #[test]
    fn project_mapping_follows_the_target_home() {
        assert_eq!(
            claude_project_dir_name("/home/me/src/a.b"),
            "-home-me-src-a-b"
        );
        assert_eq!(
            map_claude_project("-Users-me-src-x", "/var/home/them"),
            "-var-home-them-src-x"
        );
        assert_eq!(map_claude_project("other", "/home/x"), "other");
        assert_eq!(map_cwd("/Users/me/src/x", "/home/them"), "/home/them/src/x");
        assert_eq!(
            Agent::Claude.restore_relpath("-home-a-p/s.jsonl", "/Users/b"),
            "-Users-b-p/s.jsonl"
        );
    }

    #[test]
    fn codex_and_pi_records_parse() {
        let mut state = ParseState::new(false);
        Agent::Codex.parse(
            &json!({"type": "session_meta", "payload": {"cwd": "/home/me/x", "id": "0199AAAA-1111-2222-3333-444455556666"}}),
            &mut state,
        );
        assert_eq!(state.project.as_deref(), Some("-home-me-x"));
        assert_eq!(
            state.session.as_deref(),
            Some("0199aaaa-1111-2222-3333-444455556666")
        );
        let docs = Agent::Codex.parse(
            &json!({"type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{\"cmd\":1}"}}),
            &mut state,
        );
        assert_eq!(docs[0].text, "{\"cmd\":1}");
        Agent::Codex.parse(
            &json!({"type": "response_item", "payload": {"type": "new_thing"}}),
            &mut state,
        );
        assert_eq!(state.unknown.get("response_item/new_thing"), Some(&1));
        let mut state = ParseState::new(false);
        let docs = Agent::Pi.parse(
            &json!({"type": "message", "message": {"role": "assistant", "content": [
                {"type": "text", "text": "hi"}, {"type": "toolCall", "name": "read", "arguments": {"path": "x"}}
            ]}}),
            &mut state,
        );
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[1].text, "{\"path\":\"x\"}");
    }
}
