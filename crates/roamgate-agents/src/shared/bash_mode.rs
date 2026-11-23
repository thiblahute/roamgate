//! `shared/bashMode.ts`: Claude Code's `!` lines, as its transcript writes
//! them (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::js::{self, Obj};

/// What Claude reads of each stream, as Claude Code's own cap.
pub const BASH_OUTPUT_LIMIT: usize = 30_000;

/// The command of a `!` line, or None.
pub fn shell_line(text: &str) -> Option<String> {
    let start = text.find(|c: char| !js::is_js_space(c))?;
    if !text[start..].starts_with('!') {
        return None;
    }
    let command = &text[start + 1..];
    (!js::trim(command).is_empty()).then(|| command.to_owned())
}

pub fn escape_bash_output(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub fn unescape_bash_output(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// Output past the cap, cut as Claude Code cuts it.
pub fn truncate_bash_output(value: &str, limit: usize) -> (String, bool) {
    if js::len16(value) <= limit {
        return (value.to_owned(), false);
    }
    let head = js::head16(value, limit);
    let rest = js::tail_from16(value, limit);
    let lines = rest.split('\n').count();
    (format!("{head}\n\n... [{lines} lines truncated] ..."), true)
}

/// The two text blocks Claude reads for one run.
pub fn bash_mode_texts(command: &str, stdout: &str, stderr: &str) -> [String; 2] {
    [
        format!("<bash-input>{command}</bash-input>"),
        format!(
            "<bash-stdout>{}</bash-stdout><bash-stderr>{}</bash-stderr>",
            escape_bash_output(stdout),
            escape_bash_output(stderr)
        ),
    ]
}

/// A run read back: its command, its output, or both (`BashModePart`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BashModePart {
    pub command: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

impl BashModePart {
    /// As the JavaScript object, its keys in the order they were set.
    pub fn to_obj(&self) -> Obj {
        obj! {
            "command" => self.command.clone(),
            "stdout" => self.stdout.clone(),
            "stderr" => self.stderr.clone(),
        }
    }
}

/// The runs a message starts with and the text after them, or None.
pub fn split_bash_mode(text: &str) -> Option<(Vec<BashModePart>, String)> {
    static INPUT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*<bash-input>([\s\S]*?)</bash-input>").unwrap());
    static OUTPUT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^\s*<bash-stdout>([\s\S]*?)</bash-stdout>\s*<bash-stderr>([\s\S]*?)</bash-stderr>",
        )
        .unwrap()
    });
    let mut parts: Vec<BashModePart> = Vec::new();
    let mut rest = text;
    loop {
        if let Some(input) = INPUT.captures(rest) {
            parts.push(BashModePart {
                command: Some(input[1].to_owned()),
                ..Default::default()
            });
            rest = &rest[input.get(0).unwrap().end()..];
            continue;
        }
        if let Some(output) = OUTPUT.captures(rest) {
            let stdout = unescape_bash_output(&output[1]);
            let stderr = unescape_bash_output(&output[2]);
            match parts.last_mut() {
                Some(last) if last.stdout.is_none() => {
                    last.stdout = Some(stdout);
                    last.stderr = Some(stderr);
                }
                _ => parts.push(BashModePart {
                    command: None,
                    stdout: Some(stdout),
                    stderr: Some(stderr),
                }),
            }
            rest = &rest[output.get(0).unwrap().end()..];
            continue;
        }
        break;
    }
    (!parts.is_empty()).then(|| (parts, js::trim(rest).to_owned()))
}

/// `splitBashMode` as the JavaScript value.
pub fn split_bash_mode_value(text: &str) -> Value {
    match split_bash_mode(text) {
        None => Value::Null,
        Some((parts, rest)) => Value::Object(obj! {
            "parts" => parts.iter().map(|p| Value::Object(p.to_obj())).collect::<Vec<_>>(),
            "rest" => rest,
        }),
    }
}
