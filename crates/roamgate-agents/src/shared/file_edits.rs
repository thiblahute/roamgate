//! `shared/fileEdits.ts`: what a file-editing tool call did, as the chat
//! shows it, bounded.

use serde_json::Value;

use crate::js::{self, Obj};

pub const FILE_EDIT_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const MAX_LINES: usize = 160;
const MAX_LINE_CHARS: usize = 400;
const MAX_DIFF_LINES: usize = 600;

pub fn is_file_edit_tool(tool: &str) -> bool {
    FILE_EDIT_TOOLS.contains(&tool)
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

struct Hunk {
    old_start: Option<Value>,
    new_start: Option<Value>,
    lines: Vec<String>,
}

fn finish(path: &str, hunks: Vec<Hunk>, created: bool) -> Value {
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
    let mut left = MAX_LINES as i64;
    let mut truncated = false;
    let mut kept = Vec::new();
    for hunk in hunks {
        if left <= 0 {
            truncated = true;
            break;
        }
        let lines: Vec<Value> = hunk
            .lines
            .iter()
            .take(left as usize)
            .map(|line| {
                Value::String(if js::len16(line) > MAX_LINE_CHARS {
                    js::head16(line, MAX_LINE_CHARS)
                } else {
                    line.clone()
                })
            })
            .collect();
        if lines.len() < hunk.lines.len() {
            truncated = true;
        }
        left -= lines.len() as i64;
        kept.push(Value::Object(obj! {
            "old_start" => hunk.old_start,
            "new_start" => hunk.new_start,
            "lines" => lines,
        }));
    }
    Value::Object(obj! {
        "path" => path,
        "created" => created.then_some(true),
        "added" => added as i64,
        "removed" => removed as i64,
        "hunks" => kept,
        "truncated" => truncated.then_some(true),
    })
}

/// The lines of a change from `before` to `after` as a unified diff's body.
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
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head
        && tail < b.len() - head
        && a[a.len() - 1 - tail] == b[b.len() - 1 - tail]
    {
        tail += 1;
    }
    let x = &a[head..a.len() - tail];
    let y = &b[head..b.len() - tail];
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
    while i < x.len() {
        middle.push(format!("-{}", x[i]));
        i += 1;
    }
    while j < y.len() {
        middle.push(format!("+{}", y[j]));
        j += 1;
    }
    a[..head]
        .iter()
        .map(|line| format!(" {line}"))
        .chain(middle)
        .chain(a[a.len() - tail..].iter().map(|line| format!(" {line}")))
        .collect()
}

/// From Claude Code's result of the call: its patch, or a new file.
pub fn file_edit_from_result(result: Option<&Value>) -> Option<Value> {
    let result = js::rec(result)?;
    let path =
        js::str_of(result.get("filePath")).or_else(|| js::str_of(result.get("notebook_path")))?;
    if path.is_empty() {
        return None;
    }
    if js::sv(result.get("type")) == "create"
        && let Some(Value::String(content)) = result.get("content")
    {
        return Some(finish(
            path,
            vec![Hunk {
                old_start: Some(js::int(0)),
                new_start: Some(js::int(1)),
                lines: split_lines(content)
                    .iter()
                    .map(|l| format!("+{l}"))
                    .collect(),
            }],
            true,
        ));
    }
    let patch = result.get("structuredPatch")?.as_array()?;
    if patch.is_empty() {
        return None;
    }
    let hunks: Vec<Hunk> = patch
        .iter()
        .filter_map(|hunk| {
            let hunk = hunk.as_object()?;
            let lines = hunk.get("lines")?.as_array()?;
            Some(Hunk {
                old_start: hunk.get("oldStart").filter(|v| v.is_number()).cloned(),
                new_start: hunk.get("newStart").filter(|v| v.is_number()).cloned(),
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

/// From the call's arguments: what it asks to change.
pub fn file_edit_from_arguments(tool: Option<&str>, args: Option<&Value>) -> Option<Value> {
    let tool = tool.filter(|t| is_file_edit_tool(t))?;
    let args: &Obj = js::rec(args)?;
    let path =
        js::str_of(args.get("file_path")).or_else(|| js::str_of(args.get("notebook_path")))?;
    if path.is_empty() {
        return None;
    }
    let plain = |lines| Hunk {
        old_start: None,
        new_start: None,
        lines,
    };
    match tool {
        "Edit" => {
            let before = js::str_of(args.get("old_string"))?;
            let after = js::str_of(args.get("new_string"))?;
            Some(finish(path, vec![plain(line_diff(before, after))], false))
        }
        "MultiEdit" => {
            let edits = args.get("edits")?.as_array()?;
            let hunks: Vec<Hunk> = edits
                .iter()
                .filter_map(|edit| {
                    let edit = edit.as_object()?;
                    let before = js::str_of(edit.get("old_string"))?;
                    let after = js::str_of(edit.get("new_string"))?;
                    Some(plain(line_diff(before, after)))
                })
                .collect();
            (!hunks.is_empty()).then(|| finish(path, hunks, false))
        }
        "Write" => {
            let content = js::str_of(args.get("content"))?;
            Some(finish(
                path,
                vec![plain(
                    split_lines(content)
                        .iter()
                        .map(|l| format!("+{l}"))
                        .collect(),
                )],
                false,
            ))
        }
        "NotebookEdit" => {
            let source = js::str_of(args.get("new_source"))?;
            let lines = if js::sv(args.get("edit_mode")) == "delete" {
                Vec::new()
            } else {
                split_lines(source)
                    .iter()
                    .map(|l| format!("+{l}"))
                    .collect()
            };
            Some(finish(path, vec![plain(lines)], false))
        }
        _ => None,
    }
}

/// From the call's arguments as JSON text.
pub fn file_edit_from_argument_text(tool: Option<&str>, text: &str) -> Option<Value> {
    let tool = tool.filter(|t| is_file_edit_tool(t))?;
    if text.is_empty() {
        return None;
    }
    let parsed = js::parse(text)?;
    file_edit_from_arguments(Some(tool), Some(&parsed))
}
