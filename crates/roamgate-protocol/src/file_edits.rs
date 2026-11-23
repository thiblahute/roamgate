//! What a file-editing tool call did (shared/fileEdits.ts): the file, its
//! line counts and its diff in hunks, from Claude Code's result of the
//! call or from its arguments. Held to contract/vectors/file-edits.json;
//! the review service's permission prompts carry one, the agent session
//! readers (S21) build them from transcripts.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEditHunk {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_start: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_start: Option<Number>,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEdit {
    pub path: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub created: bool,
    pub added: usize,
    pub removed: usize,
    pub hunks: Vec<FileEditHunk>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

/// The tools whose calls change a file.
pub const FILE_EDIT_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const MAX_LINES: usize = 160;
const MAX_LINE_CHARS: usize = 400;
const MAX_DIFF_LINES: usize = 600;

fn units(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The first `max` UTF-16 units.
fn head(value: &str, max: usize) -> &str {
    let mut count = 0;
    for (index, ch) in value.char_indices() {
        count += ch.len_utf16();
        if count > max {
            return &value[..index];
        }
    }
    value
}

fn split_lines(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = value
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

fn finish(path: &str, hunks: Vec<FileEditHunk>, created: bool) -> FileEdit {
    let mut added = 0;
    let mut removed = 0;
    for hunk in &hunks {
        for line in &hunk.lines {
            if line.starts_with('+') {
                added += 1;
            } else if line.starts_with('-') {
                removed += 1;
            }
        }
    }
    let mut left = MAX_LINES;
    let mut truncated = false;
    let mut kept = Vec::new();
    for hunk in hunks {
        if left == 0 {
            truncated = true;
            break;
        }
        let lines: Vec<String> = hunk
            .lines
            .iter()
            .take(left)
            .map(|line| {
                if units(line) > MAX_LINE_CHARS {
                    head(line, MAX_LINE_CHARS).to_owned()
                } else {
                    line.clone()
                }
            })
            .collect();
        if lines.len() < hunk.lines.len() {
            truncated = true;
        }
        left -= lines.len();
        kept.push(FileEditHunk { lines, ..hunk });
    }
    FileEdit {
        path: path.into(),
        created,
        added,
        removed,
        hunks: kept,
        truncated,
    }
}

/// The lines of a change from `before` to `after`, as a unified diff's
/// body (lineDiff).
pub fn line_diff(before: &str, after: &str) -> Vec<String> {
    let a = split_lines(before);
    let b = split_lines(after);
    if a.len() > MAX_DIFF_LINES || b.len() > MAX_DIFF_LINES {
        return a
            .iter()
            .map(|line| format!("-{line}"))
            .chain(b.iter().map(|line| format!("+{line}")))
            .collect();
    }
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut tail = 0;
    while tail < a.len() - start
        && tail < b.len() - start
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    let x = &a[start..a.len() - tail];
    let y = &b[start..b.len() - tail];
    let cols = y.len() + 1;
    let mut table = vec![0u16; (x.len() + 1) * cols];
    for i in (0..x.len()).rev() {
        for j in (0..y.len()).rev() {
            table[i * cols + j] = if x[i] == y[j] {
                table[(i + 1) * cols + j + 1].wrapping_add(1)
            } else {
                table[(i + 1) * cols + j].max(table[i * cols + j + 1])
            };
        }
    }
    let mut middle = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < x.len() && j < y.len() {
        if x[i] == y[j] {
            middle.push(format!(" {}", x[i]));
            i += 1;
            j += 1;
        } else if table[(i + 1) * cols + j] >= table[i * cols + j + 1] {
            middle.push(format!("-{}", x[i]));
            i += 1;
        } else {
            middle.push(format!("+{}", y[j]));
            j += 1;
        }
    }
    middle.extend(x[i..].iter().map(|line| format!("-{line}")));
    middle.extend(y[j..].iter().map(|line| format!("+{line}")));
    a[..start]
        .iter()
        .map(|line| format!(" {line}"))
        .chain(middle)
        .chain(a[a.len() - tail..].iter().map(|line| format!(" {line}")))
        .collect()
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn text<'a>(map: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    map.get(name).and_then(Value::as_str)
}

/// From Claude Code's result of the call (fileEditFromResult).
pub fn file_edit_from_result(result: &Value) -> Option<FileEdit> {
    let result = record(result)?;
    let path = text(result, "filePath")
        .or_else(|| text(result, "notebook_path"))
        .filter(|path| !path.is_empty())?;
    if text(result, "type") == Some("create")
        && let Some(content) = text(result, "content")
    {
        return Some(finish(
            path,
            vec![FileEditHunk {
                old_start: Some(0.into()),
                new_start: Some(1.into()),
                lines: split_lines(content)
                    .into_iter()
                    .map(|line| format!("+{line}"))
                    .collect(),
            }],
            true,
        ));
    }
    let patch = result.get("structuredPatch")?.as_array()?;
    if patch.is_empty() {
        return None;
    }
    let hunks: Vec<FileEditHunk> = patch
        .iter()
        .filter_map(|hunk| {
            let hunk = record(hunk)?;
            let lines = hunk.get("lines")?.as_array()?;
            let number = |name: &str| match hunk.get(name) {
                Some(Value::Number(number)) => Some(number.clone()),
                _ => None,
            };
            Some(FileEditHunk {
                old_start: number("oldStart"),
                new_start: number("newStart"),
                lines: lines
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|line| !line.starts_with('\\'))
                    .map(str::to_owned)
                    .collect(),
            })
        })
        .collect();
    (!hunks.is_empty()).then(|| finish(path, hunks, false))
}

/// From the call's arguments (fileEditFromArguments).
pub fn file_edit_from_arguments(tool: Option<&str>, args: &Value) -> Option<FileEdit> {
    let tool = tool.filter(|tool| FILE_EDIT_TOOLS.contains(tool))?;
    let args = record(args)?;
    let path = text(args, "file_path")
        .or_else(|| text(args, "notebook_path"))
        .filter(|path| !path.is_empty())?;
    let plain = |lines: Vec<String>| FileEditHunk {
        old_start: None,
        new_start: None,
        lines,
    };
    match tool {
        "Edit" => {
            let before = text(args, "old_string")?;
            let after = text(args, "new_string")?;
            Some(finish(path, vec![plain(line_diff(before, after))], false))
        }
        "MultiEdit" => {
            let edits = args.get("edits")?.as_array()?;
            let hunks: Vec<FileEditHunk> = edits
                .iter()
                .filter_map(|edit| {
                    let edit = record(edit)?;
                    Some(plain(line_diff(
                        text(edit, "old_string")?,
                        text(edit, "new_string")?,
                    )))
                })
                .collect();
            (!hunks.is_empty()).then(|| finish(path, hunks, false))
        }
        "Write" => {
            let content = text(args, "content")?;
            Some(finish(
                path,
                vec![plain(
                    split_lines(content)
                        .into_iter()
                        .map(|line| format!("+{line}"))
                        .collect(),
                )],
                false,
            ))
        }
        "NotebookEdit" => {
            let source = text(args, "new_source")?;
            let lines = if text(args, "edit_mode") == Some("delete") {
                Vec::new()
            } else {
                split_lines(source)
                    .into_iter()
                    .map(|line| format!("+{line}"))
                    .collect()
            };
            Some(finish(path, vec![plain(lines)], false))
        }
        _ => None,
    }
}

/// From the call's arguments as JSON text (fileEditFromArgumentText).
pub fn file_edit_from_argument_text(tool: Option<&str>, argument_text: &str) -> Option<FileEdit> {
    let tool = tool.filter(|tool| FILE_EDIT_TOOLS.contains(tool))?;
    if argument_text.is_empty() {
        return None;
    }
    let args: Value = serde_json::from_str(argument_text).ok()?;
    file_edit_from_arguments(Some(tool), &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors;

    #[test]
    fn file_edits_vectors() {
        let file = vectors::load("file-edits");
        for case in &file.cases {
            for call in &case.calls {
                let args: Vec<Value> = call
                    .args
                    .iter()
                    .map(|arg| {
                        vectors::text(arg)
                            .map(Value::String)
                            .unwrap_or_else(|| arg.clone())
                    })
                    .collect();
                let tool = || args[0].as_str();
                let got = match call.target().as_str() {
                    "fileEdits.lineDiff" => serde_json::to_value(line_diff(
                        args[0].as_str().unwrap(),
                        args[1].as_str().unwrap(),
                    ))
                    .unwrap(),
                    "fileEdits.fileEditFromResult" => {
                        serde_json::to_value(file_edit_from_result(&args[0])).unwrap()
                    }
                    "fileEdits.fileEditFromArguments" => {
                        serde_json::to_value(file_edit_from_arguments(tool(), &args[1])).unwrap()
                    }
                    "fileEdits.fileEditFromArgumentText" => serde_json::to_value(
                        file_edit_from_argument_text(tool(), args[1].as_str().unwrap_or("")),
                    )
                    .unwrap(),
                    other => panic!("unknown call {other}"),
                };
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
