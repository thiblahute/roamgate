//! Scripted answers of the command fakes (fake-ssh, fake-glab, fake-claude,
//! fake-svc, ...), and the log of every call they get.
//!
//! A run's fakes directory holds `<program>.json`, written by the scenario:
//!
//! ```json
//! {"rules": [{"args_match": "^api graphql", "stdout": "{...}", "times": 1}],
//!  "default": {"exit": 0}}
//! ```
//!
//! A rule matches when every condition it has holds: `args` (the exact
//! argv after the program), `args_prefix`, `args_match` (a regex over the
//! argv joined by spaces), `stdin_match` (a regex over stdin, which is then
//! read whole) and `env` (variables with these values). `times` limits how
//! many calls it answers. Its answer: `stdout` (text), `stdout_json` (a
//! value, written as one line), `stdout_lines` (values or texts, one per
//! line), `stderr`, `exit`, `delay_ms`, `files` (paths to write before
//! answering, relative to the remote home for ssh, else the cwd) and
//! `passthrough` (ssh: run the command anyway after the rule's output).
//!
//! Every call appends one line to `calls.jsonl`: the program, argv, cwd,
//! stdin when read, the variables listed in `PARITY_FAKE_ENV_KEYS` plus
//! those of the fake's family, and which rule answered.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The environment variable naming the run's fakes directory.
pub const FAKES_DIR_ENV: &str = "PARITY_FAKES_DIR";

// No deny_unknown_fields: serde refuses every field of a struct with a
// flattened member when it is set.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Script {
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub default: Option<Answer>,
    /// Fake-specific settings (claude: `turns`; voice helper: `replies`).
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub args_prefix: Option<Vec<String>>,
    #[serde(default)]
    pub args_match: Option<String>,
    #[serde(default)]
    pub stdin_match: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub times: Option<usize>,
    #[serde(flatten)]
    pub answer: Answer,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Answer {
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stdout_json: Option<Value>,
    #[serde(default)]
    pub stdout_lines: Option<Vec<Value>>,
    #[serde(default)]
    pub stderr: Option<String>,
    #[serde(default)]
    pub exit: Option<i32>,
    #[serde(default)]
    pub delay_ms: Option<u64>,
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub passthrough: bool,
    /// Fake-specific answer data (claude: `stream`).
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Answer {
    /// What goes to stdout.
    pub fn stdout_text(&self) -> String {
        let mut out = self.stdout.clone().unwrap_or_default();
        if let Some(value) = &self.stdout_json {
            out.push_str(&value.to_string());
            out.push('\n');
        }
        for line in self.stdout_lines.iter().flatten() {
            match line {
                Value::String(text) => out.push_str(text),
                other => out.push_str(&other.to_string()),
            }
            out.push('\n');
        }
        out
    }
}

/// One call as `calls.jsonl` keeps it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Call {
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// The index of the rule that answered, or null for the default.
    #[serde(default)]
    pub rule: Option<usize>,
    pub pid: u32,
}

pub fn fakes_dir() -> Option<PathBuf> {
    std::env::var_os(FAKES_DIR_ENV).map(PathBuf::from)
}

pub fn load(dir: &Path, program: &str) -> Script {
    let path = dir.join(format!("{program}.json"));
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display())),
        Err(_) => Script::default(),
    }
}

/// How many calls a rule answered so far (a line per hit in its file).
fn hits(dir: &Path, program: &str, index: usize) -> usize {
    fs::read_to_string(dir.join(format!("{program}.hits")))
        .map(|text| {
            text.lines()
                .filter(|line| *line == index.to_string())
                .count()
        })
        .unwrap_or(0)
}

pub fn count_hit(dir: &Path, program: &str, index: usize) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{program}.hits")))
    {
        let _ = file.write_all(format!("{index}\n").as_bytes());
    }
}

impl Rule {
    pub fn needs_stdin(&self) -> bool {
        self.stdin_match.is_some()
    }

    fn matches(&self, args: &[String], stdin: Option<&str>) -> bool {
        if let Some(expected) = &self.args
            && expected != args
        {
            return false;
        }
        if let Some(prefix) = &self.args_prefix
            && !args.starts_with(prefix)
        {
            return false;
        }
        if let Some(pattern) = &self.args_match {
            let regex = Regex::new(pattern).expect("args_match is a regex");
            if !regex.is_match(&args.join(" ")) {
                return false;
            }
        }
        if let Some(pattern) = &self.stdin_match {
            let regex = Regex::new(pattern).expect("stdin_match is a regex");
            if !regex.is_match(stdin.unwrap_or("")) {
                return false;
            }
        }
        self.env
            .iter()
            .all(|(key, value)| std::env::var(key).ok().as_deref() == Some(value))
    }
}

/// The rule answering this call; its hit is counted with [`count_hit`],
/// once the call is logged (a scenario waiting for the hit then finds the
/// call too).
pub fn pick(
    dir: &Path,
    program: &str,
    script: &Script,
    args: &[String],
    stdin: Option<&str>,
) -> Option<(usize, Answer)> {
    for (index, rule) in script.rules.iter().enumerate() {
        if !rule.matches(args, stdin) {
            continue;
        }
        if let Some(times) = rule.times
            && hits(dir, program, index) >= times
        {
            continue;
        }
        return Some((index, rule.answer.clone()));
    }
    None
}

/// Variables each fake family records.
pub fn recorded_env_keys(program: &str) -> Vec<String> {
    let mut keys: Vec<String> = std::env::var("PARITY_FAKE_ENV_KEYS")
        .unwrap_or_default()
        .split(',')
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .collect();
    let family: &[&str] = match program {
        "claude" => &[
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "HERDR_SOCKET_PATH",
            "HERDR_PANE_ID",
            "HERDR_WORKSPACE_ID",
            "ROAMGATE_REVIEW_SOCKET",
        ],
        "agy" => &["HERDR_PANE_ID", "ROAMGATE_AGY_SESSION"],
        "glab" | "gh" => &["GITLAB_HOST", "GH_HOST", "GLAB_CONFIG_DIR", "GH_CONFIG_DIR"],
        "ssh" => &["SSH_AUTH_SOCK"],
        _ => &[],
    };
    keys.extend(family.iter().map(|key| key.to_string()));
    keys
}

pub fn log_call(dir: &Path, call: &Call) {
    let mut line = serde_json::to_string(call).expect("a call serialises");
    line.push('\n');
    // One write of one line in append mode: lines of concurrent fakes do
    // not interleave.
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("calls.jsonl"))
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Every call so far, in order.
pub fn read_calls(dir: &Path) -> Vec<Call> {
    fs::read_to_string(dir.join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
