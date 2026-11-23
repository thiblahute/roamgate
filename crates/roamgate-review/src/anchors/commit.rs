//! Threads written on one commit's diff following a rewritten commit
//! (review/commit-anchors.ts), held to contract/vectors/commit-anchors.json.

use indexmap::IndexMap;
use serde_json::{Value, json};

use super::{note_of, note_text};
use crate::diff::ReviewDiffFile;
use crate::model::{ReviewAnchor, ReviewCommit};

/// A subject without a rewrite's `fixup!` and `squash!`, case or spacing.
fn normalized_subject(subject: &str) -> String {
    let mut text = crate::js::trim(subject).to_owned();
    loop {
        let lower = text.to_lowercase();
        let stripped = ["fixup!", "squash!", "amend!"]
            .iter()
            .find(|prefix| lower.starts_with(*prefix))
            .map(|prefix| {
                text[prefix.len()..]
                    .trim_start_matches(crate::js::js_space)
                    .to_owned()
            });
        match stripped {
            Some(stripped) if stripped != text => text = stripped,
            _ => break,
        }
    }
    let mut spaced = String::new();
    let mut space = false;
    for ch in text.chars() {
        if crate::js::js_space(ch) {
            if !space {
                spaced.push(' ');
            }
            space = true;
        } else {
            spaced.push(ch);
            space = false;
        }
    }
    if spaced.ends_with('.') {
        spaced.pop();
    }
    spaced.to_lowercase()
}

fn names(commit: &ReviewCommit, sha: &str) -> bool {
    commit.sha == sha || commit.sha.starts_with(sha)
}

/// The anchor's commit is no longer among the review's commits.
pub fn rewritten_out(anchor: &ReviewAnchor, commits: &[ReviewCommit]) -> bool {
    match anchor.commit.as_deref() {
        Some(commit) if !commit.is_empty() => {
            !commits.is_empty() && !commits.iter().any(|each| names(each, commit))
        }
        _ => false,
    }
}

/// What the anchor's commit became among the review's commits
/// (rewrittenCommit).
pub fn rewritten_commit<'a>(
    anchor: &ReviewAnchor,
    commits: &'a [ReviewCommit],
    patch_ids: &IndexMap<String, String>,
    by_subject: bool,
) -> Option<&'a ReviewCommit> {
    let commit = anchor
        .commit
        .as_deref()
        .filter(|commit| !commit.is_empty())?;
    if let Some((_, own)) = patch_ids.iter().find(|(sha, _)| sha.starts_with(commit)) {
        let same: Vec<_> = commits
            .iter()
            .filter(|each| patch_ids.get(&each.sha) == Some(own))
            .collect();
        if let Some(last) = same.last() {
            return Some(last);
        }
    }
    if !by_subject {
        return None;
    }
    let subject = anchor.commit_subject.as_deref().filter(|s| !s.is_empty())?;
    if let Some(exact) = commits.iter().rfind(|each| each.subject == subject) {
        return Some(exact);
    }
    let normalized = normalized_subject(subject);
    commits
        .iter()
        .rfind(|each| normalized_subject(&each.subject) == normalized)
}

/// The anchored line in a file's diff (lineInFile).
pub fn line_in_file(anchor: &ReviewAnchor, file: Option<&ReviewDiffFile>) -> Option<(String, i64)> {
    let file = file?;
    let text = anchor.text.as_deref()?;
    let line = anchor.line?;
    let side = anchor.side_or_new().to_owned();
    let rows: Vec<_> = file.rows().filter(|row| row.on_side(&side)).collect();
    let quote = note_of(anchor)
        .and_then(|note| note.get("quote").and_then(Value::as_str).map(str::to_owned));
    let after: Vec<String> = quote
        .map(|quote| {
            quote
                .split('\n')
                .skip(1)
                .take(5)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut best: Option<(i64, i64)> = None;
    for (index, row) in rows.iter().enumerate() {
        if row.text != text {
            continue;
        }
        let Some(found) = row.line_of(&side) else {
            continue;
        };
        let context = after
            .iter()
            .enumerate()
            .filter(|(offset, expected)| {
                rows.get(index + 1 + offset)
                    .is_some_and(|next| &next.text == *expected)
            })
            .count() as i64;
        let score = (found - line).abs() - context * 1_000_000;
        if best.is_none_or(|(_, best)| score < best) {
            best = Some((found, score));
        }
    }
    best.map(|(line, _)| (side, line))
}

/// What a move does to the anchor's commit.
pub enum CommitMove<'a> {
    /// Onto the whole change.
    Whole,
    /// The commit it names.
    Keep,
    Onto(&'a ReviewCommit),
}

/// The anchor moved (movedAnchor).
pub fn moved_anchor(
    anchor: &ReviewAnchor,
    commit: CommitMove<'_>,
    to: Option<(String, i64)>,
    outdated: bool,
) -> ReviewAnchor {
    let mut next = anchor.clone();
    let mut note = note_of(anchor);
    match commit {
        CommitMove::Whole => {
            next.commit = None;
            next.commit_subject = None;
            next.commit_parent = None;
            if let Some(note) = note.as_mut() {
                note.shift_remove("commit");
            }
        }
        CommitMove::Onto(commit) => {
            next.commit = Some(commit.sha.clone());
            next.commit_subject = Some(commit.subject.clone());
            next.commit_parent = commit.parent.clone().filter(|parent| !parent.is_empty());
            if let Some(note) = note.as_mut() {
                let mut value = serde_json::Map::new();
                value.insert("sha".into(), json!(commit.sha));
                value.insert("subject".into(), json!(commit.subject));
                if let Some(parent) = commit.parent.as_ref().filter(|p| !p.is_empty()) {
                    value.insert("parent".into(), json!(parent));
                }
                note.insert("commit".into(), Value::Object(value));
            }
        }
        CommitMove::Keep => {}
    }
    if let (Some((side, line)), Some(from)) = (to, anchor.line) {
        next.side = Some(side.clone());
        next.line = Some(line);
        if let Some(end) = anchor.end_line {
            next.end_line = Some(line + (end - from));
        }
        if let Some(note) = note.as_mut() {
            note.insert("side".into(), json!(side));
            note.insert("line".into(), json!(line));
            if let Some(end) = next.end_line {
                note.insert("endLine".into(), json!(end));
            }
            if note.contains_key("endSide") {
                note.insert("endSide".into(), json!(side));
            }
        }
    }
    next.outdated = outdated;
    if let Some(note) = note {
        next.feedback = Some(note_text(&note));
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    fn anchor(value: &Value) -> ReviewAnchor {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn commits(value: &Value) -> Vec<ReviewCommit> {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn file(value: Option<&Value>) -> Option<ReviewDiffFile> {
        value
            .filter(|value| !vectors::is_undefined(value) && !value.is_null())
            .map(|value| serde_json::from_value(value.clone()).unwrap())
    }

    #[test]
    fn commit_anchors_vectors() {
        let file_ = vectors::load("commit-anchors");
        for case in &file_.cases {
            for call in &case.calls {
                let got = match call.target().as_str() {
                    "commit-anchors.rewrittenOut" => {
                        json!(rewritten_out(
                            &anchor(&call.args[0]),
                            &commits(&call.args[1])
                        ))
                    }
                    "commit-anchors.rewrittenCommit" => {
                        let list = commits(&call.args[1]);
                        let ids: IndexMap<String, String> =
                            serde_json::from_value(call.args[2].clone()).unwrap();
                        let by_subject = call.args.get(3).and_then(Value::as_bool).unwrap_or(true);
                        rewritten_commit(&anchor(&call.args[0]), &list, &ids, by_subject)
                            .map(|commit| serde_json::to_value(commit).unwrap())
                            .unwrap_or(Value::Null)
                    }
                    "commit-anchors.lineInFile" => {
                        line_in_file(&anchor(&call.args[0]), file(call.args.get(1)).as_ref())
                            .map(|(side, line)| json!({"side": side, "line": line}))
                            .unwrap_or(Value::Null)
                    }
                    "commit-anchors.movedAnchor" => {
                        let commit_arg = call.args.get(1);
                        let onto: Option<ReviewCommit> = commit_arg
                            .filter(|v| v.is_object() && !vectors::is_undefined(v))
                            .map(|v| serde_json::from_value(v.clone()).unwrap());
                        let commit = match (commit_arg, &onto) {
                            (_, Some(commit)) => CommitMove::Onto(commit),
                            (Some(Value::Null), None) => CommitMove::Whole,
                            _ => CommitMove::Keep,
                        };
                        let to = call
                            .args
                            .get(2)
                            .filter(|v| v.is_object() && !vectors::is_undefined(v))
                            .map(|v| {
                                (
                                    v["side"].as_str().unwrap().to_owned(),
                                    v["line"].as_i64().unwrap(),
                                )
                            });
                        let outdated = call.args.get(3).and_then(Value::as_bool).unwrap_or(false);
                        serde_json::to_value(moved_anchor(
                            &anchor(&call.args[0]),
                            commit,
                            to,
                            outdated,
                        ))
                        .unwrap()
                    }
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

    #[test]
    fn subjects_compare_without_rewrite_marks() {
        assert_eq!(
            normalized_subject("fixup! Squash!  Add  thing."),
            "add thing"
        );
    }
}
