//! Unified diffs read into files, hunks and numbered lines
//! (review/patch.ts `parseUnifiedDiff`), with the review's diff types of
//! shared/review.ts. Held to contract/vectors/patch.json.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// `" "`, `"+"` or `"-"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineKind {
    #[serde(rename = " ")]
    Context,
    #[serde(rename = "+")]
    Added,
    #[serde(rename = "-")]
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old: Option<u64>,
    pub new: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// A file of a diff (`ReviewDiffFile`, the fields this layer fills).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    #[serde(rename = "oldPath")]
    pub old_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<bool>,
    pub hunks: Vec<DiffHunk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

pub(crate) static HUNK_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap());

fn strip_prefix(path: &str) -> String {
    if path == "/dev/null" {
        return path.to_owned();
    }
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
        .to_owned()
}

/// One side of a `diff --git` header: quoted or plain.
const HEADER_SIDE: &str = r#"("(?:[^"\\]|\\.)*"|\S+)"#;

static SIDES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{HEADER_SIDE} {HEADER_SIDE}$")).unwrap());
static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^a/(.*) b/(.*)$").unwrap());

/// `diff --git a/x b/y` paths, quoted ones too. A plain name with spaces
/// is ambiguous there; `rename from` and `---` lines set the paths again.
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
    // The same name on both sides (no rename), possibly with spaces:
    // `^a\/(.*) b\/\1$`, without back-references.
    if let Some(body) = rest.strip_prefix("a/") {
        for (index, _) in body.match_indices(" b/") {
            let (first, second) = (&body[..index], &body[index + 3..]);
            if first == second {
                return Some((first.to_owned(), first.to_owned()));
            }
        }
    }
    PLAIN
        .captures(rest)
        .map(|plain| (plain[1].to_owned(), plain[2].to_owned()))
}

fn escape(next: char) -> Option<u8> {
    Some(match next {
        'a' => 7,
        'b' => 8,
        't' => 9,
        'n' => 10,
        'v' => 11,
        'f' => 12,
        'r' => 13,
        _ => return None,
    })
}

/// Undoes git's C quoting: `\t`, `\"`, and octal bytes (`\303\251`) that
/// together are the name's UTF-8.
pub(crate) fn unquote(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut bytes: Vec<u8> = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char != '\\' {
            let mut buffer = [0; 4];
            bytes.extend_from_slice(char.encode_utf8(&mut buffer).as_bytes());
            index += 1;
            continue;
        }
        let octal: String = chars.iter().skip(index + 1).take(3).collect();
        if octal.len() == 3 && octal.chars().all(|c| ('0'..='7').contains(&c)) {
            bytes.push(u8::from_str_radix(&octal, 8).unwrap_or(0));
            index += 4;
            continue;
        }
        match chars.get(index + 1) {
            Some(next) => {
                match escape(*next) {
                    Some(byte) => bytes.push(byte),
                    // `next.charCodeAt(0)`, kept to its low byte as
                    // Buffer.from(number[]) does.
                    None => bytes.push((*next as u32 & 0xff) as u8),
                }
                index += 2;
            }
            None => {
                // `"".charCodeAt(0)` is NaN, which Buffer writes as 0.
                bytes.push(0);
                index += 2;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `rename from x`, `copy to y`: a path, quoted when git quotes it.
fn named_path(line: &str, prefix: &str) -> String {
    let value = &line[prefix.len()..];
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        unquote(&value[1..value.len() - 1])
    } else {
        value.to_owned()
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
/// and numbered lines.
pub fn parse_unified_diff(text: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    // The current file is always the last one; whether a hunk is open.
    let mut has_file = false;
    let mut in_hunk = false;
    let mut old_line: u64 = 0;
    let mut new_line: u64 = 0;
    // Lines still owed by the current hunk, so a "--- " line after it
    // starts a new file instead of reading as a removal.
    let mut old_left: i64 = 0;
    let mut new_left: i64 = 0;

    let start_file = |files: &mut Vec<DiffFile>, old_path: String, path: String| {
        files.push(DiffFile {
            path,
            old_path,
            binary: None,
            hunks: Vec::new(),
            truncated: None,
        });
    };

    for line in text.split('\n') {
        if line.starts_with("diff --git ") {
            let (old, new) = git_header_paths(line).unwrap_or_default();
            start_file(&mut files, old, new);
            has_file = true;
            in_hunk = false;
            continue;
        }
        if !in_hunk && has_file {
            let current = files.last_mut().unwrap();
            if line.starts_with("rename from ") || line.starts_with("copy from ") {
                let prefix = if line.starts_with("rename") {
                    "rename from "
                } else {
                    "copy from "
                };
                current.old_path = named_path(line, prefix);
                continue;
            }
            if line.starts_with("rename to ") || line.starts_with("copy to ") {
                let prefix = if line.starts_with("rename") {
                    "rename to "
                } else {
                    "copy to "
                };
                current.path = named_path(line, prefix);
                continue;
            }
        }
        if line.starts_with("--- ") && !in_hunk {
            let old_path = header_path(line);
            // A file that already has hunks is finished: without a "diff
            // --git" header (a mailed patch), "--- " starts the next one.
            if !has_file || !files.last().unwrap().hunks.is_empty() {
                start_file(&mut files, old_path.clone(), old_path);
                has_file = true;
            } else if old_path != "/dev/null" {
                files.last_mut().unwrap().old_path = old_path;
            }
            continue;
        }
        if line.starts_with("+++ ") && !in_hunk && has_file {
            let path = header_path(line);
            let current = files.last_mut().unwrap();
            current.path = if path == "/dev/null" {
                current.old_path.clone()
            } else {
                path
            };
            continue;
        }
        if line.starts_with("Binary files ") && has_file {
            files.last_mut().unwrap().binary = Some(true);
            continue;
        }
        if has_file && let Some(header) = HUNK_HEADER.captures(line) {
            old_line = header[1].parse().unwrap_or(0);
            new_line = header[3].parse().unwrap_or(0);
            old_left = header.get(2).map_or(1, |m| m.as_str().parse().unwrap_or(0));
            new_left = header.get(4).map_or(1, |m| m.as_str().parse().unwrap_or(0));
            files.last_mut().unwrap().hunks.push(DiffHunk {
                header: line.to_owned(),
                lines: Vec::new(),
            });
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        // An empty context line written without its space (some mailers,
        // or diff.suppressBlankEmpty) while the hunk owes both sides.
        let kind = if line.is_empty() && old_left > 0 && new_left > 0 {
            Some(' ')
        } else {
            line.chars().next()
        };
        if kind == Some('\\') {
            continue;
        }
        let kind = match kind {
            Some(' ') => LineKind::Context,
            Some('+') => LineKind::Added,
            Some('-') => LineKind::Removed,
            _ => {
                // A line outside the grammar ends the hunk (trailers,
                // signatures).
                if !line.is_empty() {
                    in_hunk = false;
                }
                continue;
            }
        };
        let text = line.get(1..).unwrap_or("").to_owned();
        let hunk = files.last_mut().unwrap().hunks.last_mut().unwrap();
        hunk.lines.push(DiffLine {
            kind,
            old: (kind != LineKind::Added).then_some(old_line),
            new: (kind != LineKind::Removed).then_some(new_line),
            text,
        });
        if kind != LineKind::Added {
            old_line += 1;
            old_left -= 1;
        }
        if kind != LineKind::Removed {
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
    use roamgate_protocol::vectors;
    use serde_json::Value;

    use super::*;

    /// contract/vectors/patch.json, the cases bun test reads too.
    #[test]
    fn patch_vectors() {
        let file = vectors::load("patch");
        for case in &file.cases {
            for call in &case.calls {
                match call.target().as_str() {
                    "patch.parseUnifiedDiff" => {
                        let text = call.args[0].as_str().unwrap();
                        let got = serde_json::to_value(parse_unified_diff(text)).unwrap();
                        let want = call.result.clone().unwrap_or(Value::Null);
                        assert_eq!(got, want, "{}", case.title());
                    }
                    other => panic!("{}: unknown call {other}", case.title()),
                }
            }
        }
    }
}
