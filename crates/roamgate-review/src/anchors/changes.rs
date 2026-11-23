//! Threads written in Changes on an entry's own diff (staged, unstaged,
//! untracked) placed on the combined `git diff HEAD` by their line's text
//! (review/changes-anchors.ts), held to contract/vectors/changes-anchors.json.

use serde_json::{Value, json};

use super::{note_of, note_text};
use crate::diff::ReviewDiffFile;
use crate::model::{ReviewAnchor, ReviewThread};

const ENTRY_KINDS: [&str; 3] = ["staged", "unstaged", "untracked"];

/// A thread written on a staged, unstaged or untracked entry's own diff.
pub fn entry_anchored(thread: &ReviewThread) -> bool {
    let Some(note) = note_of(&thread.anchor) else {
        return false;
    };
    note.get("source").and_then(Value::as_str) == Some("diff")
        && note
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| ENTRY_KINDS.contains(&kind))
        && thread.anchor.path.is_some()
}

/// The thread's anchor on the combined diff of its file, or `None` when
/// its line is not found there (combinedAnchor).
pub fn combined_anchor(
    thread: &ReviewThread,
    file: Option<&ReviewDiffFile>,
) -> Option<ReviewAnchor> {
    let note = note_of(&thread.anchor)?;
    if !entry_anchored(thread) {
        return None;
    }
    let anchor = &thread.anchor;
    let kind = note
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let side = anchor.side.clone().unwrap_or_else(|| {
        if note.get("side").and_then(Value::as_str) == Some("old") {
            "old".into()
        } else {
            "new".into()
        }
    });
    let line = anchor.line;
    let text = anchor.text.as_deref();
    let written = |to: Option<(String, i64)>| {
        let mut next = anchor.clone();
        let mut fields = note.clone();
        fields.insert("kind".into(), json!("combined"));
        if let (Some((to_side, to_line)), Some(line)) = (to, line) {
            next.side = Some(to_side.clone());
            next.line = Some(to_line);
            fields.insert("side".into(), json!(to_side));
            fields.insert("line".into(), json!(to_line));
            if let Some(end) = anchor.end_line {
                let end = to_line + (end - line);
                next.end_line = Some(end);
                fields.insert("endLine".into(), json!(end));
                if fields.contains_key("endSide") {
                    fields.insert("endSide".into(), json!(to_side));
                }
            }
        }
        next.feedback = Some(note_text(&fields));
        next
    };
    // On the file and no line: nothing to find again.
    let line = match line {
        Some(line) if line > 0 => line,
        _ => return Some(written(None)),
    };
    let file = file?;
    let shared = (kind == "staged" && side == "old") || (kind != "staged" && side == "new");
    if shared {
        let exact = file.rows().any(|row| {
            row.on_side(&side)
                && row.line_of(&side) == Some(line)
                && text.is_none_or(|text| row.text == text)
        });
        if exact || text.is_none() {
            return Some(written(Some((side, line))));
        }
    }
    let text = text?;
    let mut best: Option<(String, i64, f64)> = None;
    for row in file.rows() {
        if row.text != text {
            continue;
        }
        let own = row.on_side(&side);
        let found_side = if own {
            side.clone()
        } else if side == "old" {
            "new".into()
        } else {
            "old".into()
        };
        let Some(found) = row.line_of(&found_side) else {
            continue;
        };
        let distance = (found - line).abs() as f64 + if own { 0.0 } else { 0.25 };
        if best.as_ref().is_none_or(|(_, _, best)| distance < *best) {
            best = Some((found_side, found, distance));
        }
    }
    best.map(|(side, line, _)| written(Some((side, line))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::parse_unified_diff;
    use roamgate_protocol::vectors;
    use serde_json::Value;

    #[test]
    fn changes_anchors_vectors() {
        let file = vectors::load("changes-anchors");
        for case in &file.cases {
            let mut diffs: Vec<Value> = Vec::new();
            for call in &case.calls {
                match call.target().as_str() {
                    "patch.parseUnifiedDiff" => {
                        let text = vectors::text(&call.args[0]).unwrap();
                        let got = serde_json::to_value(parse_unified_diff(&text)).unwrap();
                        assert_eq!(
                            &got,
                            call.result.as_ref().unwrap_or(&Value::Null),
                            "{}",
                            case.title()
                        );
                        diffs.push(got);
                    }
                    "changes-anchors.combinedAnchor" => {
                        let thread: ReviewThread =
                            serde_json::from_value(call.args[0].clone()).unwrap();
                        let file: Option<ReviewDiffFile> = call
                            .args
                            .get(1)
                            .filter(|value| !vectors::is_undefined(value))
                            .map(|value| serde_json::from_value(value.clone()).unwrap());
                        let got = combined_anchor(&thread, file.as_ref());
                        let got = got
                            .map(|anchor| serde_json::to_value(anchor).unwrap())
                            .unwrap_or(Value::Null);
                        assert_eq!(
                            &got,
                            call.result.as_ref().unwrap_or(&Value::Null),
                            "{}",
                            case.title()
                        );
                    }
                    other => panic!("unknown call {other}"),
                }
            }
        }
    }
}
