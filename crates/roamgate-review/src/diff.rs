//! Diffs as reviews show them (shared/review.ts) and the unified diff
//! parser (review/patch.ts), held to contract/vectors/patch.json.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewDiffLine {
    /// " ", "+" or "-".
    pub kind: String,
    pub old: Option<i64>,
    pub new: Option<i64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub expanded: bool,
}

impl ReviewDiffLine {
    /// Whether the row is a line of `side` (a context line is on both).
    pub fn on_side(&self, side: &str) -> bool {
        match self.kind.as_str() {
            " " => true,
            "-" => side == "old",
            _ => side != "old",
        }
    }

    pub fn line_of(&self, side: &str) -> Option<i64> {
        if side == "old" { self.old } else { self.new }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewDiffHunk {
    pub header: String,
    pub lines: Vec<ReviewDiffLine>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffFile {
    pub path: String,
    pub old_path: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub binary: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub commit_message: bool,
    pub hunks: Vec<ReviewDiffHunk>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ReviewDiffFile {
    pub fn rows(&self) -> impl Iterator<Item = &ReviewDiffLine> {
        self.hunks.iter().flat_map(|hunk| hunk.lines.iter())
    }
}

/// A review's diff, as the git layer answers it; only the files are read
/// here, the rest goes to the browser as it came.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    pub files: Vec<ReviewDiffFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    pub truncated: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

static HUNK_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap());
static SIDES: LazyLock<Regex> = LazyLock::new(|| {
    let side = r#"("(?:[^"\\]|\\.)*"|\S+)"#;
    Regex::new(&format!("^{side} {side}$")).unwrap()
});
static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^a/(.*) b/(.*)$").unwrap());

fn strip_prefix(path: &str) -> String {
    if path == "/dev/null" {
        return path.into();
    }
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .into()
}

/// Undoes git's C quoting: `\t`, `\"`, and octal bytes that together are
/// the name's UTF-8.
pub fn unquote(value: &str) -> String {
    let mut bytes = Vec::new();
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\\' {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            index += 1;
            continue;
        }
        let octal: String = chars[index + 1..].iter().take(3).collect();
        if octal.len() == 3 && octal.chars().all(|c| ('0'..='7').contains(&c)) {
            bytes.push(u8::from_str_radix(&octal, 8).unwrap_or(0));
            index += 4;
            continue;
        }
        let next = chars.get(index + 1).copied();
        let byte = match next {
            Some('a') => 7,
            Some('b') => 8,
            Some('t') => 9,
            Some('n') => 10,
            Some('v') => 11,
            Some('f') => 12,
            Some('r') => 13,
            Some(other) => {
                let mut buf = [0u8; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
                index += 2;
                continue;
            }
            None => {
                index += 2;
                continue;
            }
        };
        bytes.push(byte);
        index += 2;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn git_header_paths(line: &str) -> Option<(String, String)> {
    let rest = &line["diff --git ".len()..];
    if let Some(sides) = SIDES.captures(rest) {
        let read = |side: &str| {
            if side.starts_with('"') && side.len() >= 2 {
                strip_prefix(&unquote(&side[1..side.len() - 1]))
            } else {
                strip_prefix(side)
            }
        };
        return Some((read(&sides[1]), read(&sides[2])));
    }
    // Same name on both sides (no rename), possibly with spaces.
    if let Some(name) = rest.strip_prefix("a/") {
        let bytes = name.as_bytes();
        // `a/X b/X`: X is the first half.
        if bytes.len() >= 3 && (bytes.len() - 3) % 2 == 0 {
            let half = (bytes.len() - 3) / 2;
            if name.is_char_boundary(half)
                && name[half..].starts_with(" b/")
                && name[..half] == name[half + 3..]
            {
                return Some((name[..half].into(), name[..half].into()));
            }
        }
    }
    PLAIN
        .captures(rest)
        .map(|plain| (plain[1].to_owned(), plain[2].to_owned()))
}

fn named_path(line: &str, prefix: &str) -> String {
    let value = &line[prefix.len()..];
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        unquote(&value[1..value.len() - 1])
    } else {
        value.into()
    }
}

fn header_path(line: &str) -> String {
    let mut value = line[4..].to_owned();
    if let Some(tab) = value.find('\t') {
        value.truncate(tab);
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value = unquote(&value[1..value.len() - 1]);
    }
    strip_prefix(&value)
}

/// Parses unified diff text (from `git diff` or a forge) into files, hunks
/// and numbered lines (parseUnifiedDiff).
pub fn parse_unified_diff(text: &str) -> Vec<ReviewDiffFile> {
    let mut files: Vec<ReviewDiffFile> = Vec::new();
    let mut in_hunk = false;
    let mut old_line = 0i64;
    let mut new_line = 0i64;
    let mut old_left = 0i64;
    let mut new_left = 0i64;

    let start_file = |files: &mut Vec<ReviewDiffFile>, old_path: String, path: String| {
        files.push(ReviewDiffFile {
            path,
            old_path,
            ..ReviewDiffFile::default()
        });
    };

    for line in text.split('\n') {
        if line.starts_with("diff --git ") {
            let (old, new) = git_header_paths(line).unwrap_or_default();
            start_file(&mut files, old, new);
            in_hunk = false;
            continue;
        }
        if !in_hunk && let Some(current) = files.last_mut() {
            if line.starts_with("rename from ") || line.starts_with("copy from ") {
                current.old_path = named_path(
                    line,
                    if line.starts_with("rename") {
                        "rename from "
                    } else {
                        "copy from "
                    },
                );
                continue;
            }
            if line.starts_with("rename to ") || line.starts_with("copy to ") {
                current.path = named_path(
                    line,
                    if line.starts_with("rename") {
                        "rename to "
                    } else {
                        "copy to "
                    },
                );
                continue;
            }
        }
        if line.starts_with("--- ") && !in_hunk {
            let old_path = header_path(line);
            match files.last_mut() {
                Some(current) if current.hunks.is_empty() => {
                    if old_path != "/dev/null" {
                        current.old_path = old_path;
                    }
                }
                _ => start_file(&mut files, old_path.clone(), old_path),
            }
            continue;
        }
        if line.starts_with("+++ ")
            && !in_hunk
            && let Some(current) = files.last_mut()
        {
            let path = header_path(line);
            current.path = if path == "/dev/null" {
                current.old_path.clone()
            } else {
                path
            };
            continue;
        }
        if line.starts_with("Binary files ")
            && let Some(current) = files.last_mut()
        {
            current.binary = true;
            continue;
        }
        if let Some(header) = HUNK_HEADER.captures(line)
            && let Some(current) = files.last_mut()
        {
            let number = |index: usize, default: i64| {
                header
                    .get(index)
                    .and_then(|found| found.as_str().parse().ok())
                    .unwrap_or(default)
            };
            old_line = number(1, 0);
            new_line = number(3, 0);
            old_left = number(2, 1);
            new_left = number(4, 1);
            current.hunks.push(ReviewDiffHunk {
                header: line.into(),
                lines: Vec::new(),
            });
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        let kind = if line.is_empty() && old_left > 0 && new_left > 0 {
            Some(' ')
        } else {
            line.chars().next()
        };
        if kind == Some('\\') {
            continue;
        }
        let kind = match kind {
            Some(kind @ (' ' | '+' | '-')) => kind,
            _ => {
                if line.is_empty() {
                    continue;
                }
                in_hunk = false;
                continue;
            }
        };
        let rest = line.get(1..).unwrap_or("");
        if let Some(hunk) = files.last_mut().and_then(|file| file.hunks.last_mut()) {
            hunk.lines.push(ReviewDiffLine {
                kind: kind.to_string(),
                old: (kind != '+').then_some(old_line),
                new: (kind != '-').then_some(new_line),
                text: rest.into(),
                expanded: false,
            });
        }
        if kind != '+' {
            old_line += 1;
            old_left -= 1;
        }
        if kind != '-' {
            new_line += 1;
            new_left -= 1;
        }
        if old_left <= 0 && new_left <= 0 {
            in_hunk = false;
        }
    }
    for entry in &mut files {
        if entry.old_path == "/dev/null" {
            entry.old_path = entry.path.clone();
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    #[test]
    fn patch_vectors() {
        let file = vectors::load("patch");
        for case in &file.cases {
            for call in &case.calls {
                assert_eq!(call.target(), "patch.parseUnifiedDiff", "{}", case.title());
                let text = vectors::text(&call.args[0]).unwrap();
                let got = serde_json::to_value(parse_unified_diff(&text)).unwrap();
                assert_eq!(
                    &got,
                    call.result.as_ref().unwrap_or(&Value::Null),
                    "{}",
                    case.title()
                );
            }
        }
    }
}
