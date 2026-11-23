//! A review's diff file by file (workspace/review-files.ts): its summary
//! first (each file's path, status and counts, the two commits it is
//! between), then the files' patches a few at a time against those two
//! commits, each cut at [`GIT_DIFF_MAX_BYTES`].

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;

use crate::compare::js_number;
use crate::diff::parse_generated_attributes;
use crate::exec::GitContext;
use crate::patch::{DiffFile, parse_unified_diff};
use crate::review::Target;
use crate::review_patch::{
    DIFF_OPTIONS, GIT, SHAS_MARKER, ScriptHow, check_tree, enter_checkout, resolve_base,
    resolve_head, run_review_script, valid_review_path,
};
use crate::{GIT_DIFF_MAX_BYTES, GitError, Result, shell_quote};

const ATTRS_MARKER: &str = "ROAMGATE-REVIEW-ATTRS";
const FILE_MARKER: &str = "ROAMGATE-REVIEW-FILE";
const SUMMARY_TIMEOUT: Duration = Duration::from_millis(30_000);
/// shared/review.ts: the most files one `review.diff` with `files` reads.
pub const REVIEW_DIFF_FILES_MAX: usize = 32;

static OBJECT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,64}$").unwrap());

/// What a summary is of: a review's target, or one of its commits.
#[derive(Debug, Clone)]
pub enum SummaryOf {
    Target(Target),
    Commit(String),
}

/// A summary: the files without their hunks, between two commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub files: Vec<DiffFile>,
    #[serde(rename = "baseSha", skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(rename = "headSha", skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    pub truncated: bool,
    pub summary: bool,
}

fn ends_script(of: &SummaryOf) -> Result<Vec<String>> {
    match of {
        SummaryOf::Commit(commit) => {
            if !OBJECT_NAME.is_match(commit) {
                return Err(GitError::message("invalid commit"));
            }
            Ok(vec![
                format!(
                    "h=$(git rev-parse --verify --quiet {}) || {{ echo \"unknown commit\" >&2; exit 3; }}",
                    shell_quote(&format!("{commit}^{{commit}}"))
                ),
                "m=$(git rev-parse --verify --quiet \"$h^1\" 2>/dev/null) || m=$(git hash-object -t tree /dev/null)".to_owned(),
            ])
        }
        SummaryOf::Target(Target::Range {
            base,
            head,
            compare,
        }) => Ok(vec![
            resolve_base(base),
            resolve_head(head),
            if *compare {
                "m=\"$b\"".to_owned()
            } else {
                "m=$(git merge-base \"$b\" \"$h\" 2>/dev/null) || m=\"$b\"".to_owned()
            },
        ]),
        SummaryOf::Target(Target::Step { before, after, .. }) => Ok(vec![
            check_tree(before),
            check_tree(after),
            format!("m={}", shell_quote(before)),
            format!("h={}", shell_quote(after)),
        ]),
        SummaryOf::Target(_) => Err(GitError::message(
            "this review has no summary: its files are read whole",
        )),
    }
}

/// One script: the two ends, the files changed between them, which are
/// generated.
pub fn review_summary_script(root: &str, of: &SummaryOf) -> Result<String> {
    let diff = format!("{GIT} diff --no-color --no-ext-diff --no-textconv --find-renames -z");
    let mut lines = vec![enter_checkout(root)];
    lines.extend(ends_script(of)?);
    lines.push(format!("printf '{SHAS_MARKER} %s %s\\n' \"$m\" \"$h\""));
    lines.push(format!("{diff} --raw --numstat \"$m\" \"$h\" || exit 4"));
    lines.push(format!("printf '\\0{ATTRS_MARKER}\\0'"));
    lines.push(format!(
        "{diff} --name-only \"$m\" \"$h\" | git check-attr -z --stdin linguist-generated gitlab-generated 2>/dev/null"
    ));
    lines.push("exit 0".to_owned());
    Ok(lines.join("\n"))
}

fn status_of(letter: char) -> &'static str {
    match letter {
        'A' | 'C' => "added",
        'D' => "deleted",
        'R' => "renamed",
        _ => "modified",
    }
}

/// `git diff --raw --numstat -z` and the generated attributes, as a
/// summary: one file per raw record, in git's order.
pub fn parse_review_summary(output: &str) -> Summary {
    let start = if output.starts_with(SHAS_MARKER) {
        0
    } else {
        output
            .find(&format!("\n{SHAS_MARKER} "))
            .map_or(0, |i| i + 1)
    };
    let mut text = &output[start..];
    let end = text.find('\n');
    let first = &text[..end.unwrap_or(text.len())];
    let mut words = first.split(' ').skip(1);
    let base_sha = words.next().filter(|s| !s.is_empty()).map(str::to_owned);
    let head_sha = words.next().filter(|s| !s.is_empty()).map(str::to_owned);
    text = end.map_or("", |e| &text[e + 1..]);
    let attrs = format!("\0{ATTRS_MARKER}\0");
    let (diff_part, attrs_part) = match text.find(&attrs) {
        Some(at) => (&text[..at], &text[at + attrs.len()..]),
        None => (text, ""),
    };
    let generated = parse_generated_attributes(attrs_part);
    let fields: Vec<&str> = diff_part.split('\0').collect();
    let mut files: Vec<DiffFile> = Vec::new();
    let mut counts: Vec<(u64, u64, bool)> = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.is_empty() {
            continue;
        }
        if field.starts_with(':') {
            // :old-mode new-mode old-sha new-sha STATUS, then the paths.
            let letter = field
                .split(' ')
                .next_back()
                .and_then(|s| s.chars().next())
                .unwrap_or('M');
            let two = letter == 'R' || letter == 'C';
            let old_path = fields.get(index).copied().unwrap_or("");
            index += 1;
            let path = if two {
                let path = fields.get(index).copied().unwrap_or("");
                index += 1;
                path
            } else {
                old_path
            };
            let mut file = DiffFile::new(path, if letter == 'C' { path } else { old_path });
            file.status = Some(status_of(letter).to_owned());
            files.push(file);
            continue;
        }
        // numstat: "added<TAB>deleted<TAB>path", or for a rename an empty
        // path followed by the old and new ones.
        let mut parts = field.split('\t');
        let added = parts.next().unwrap_or("");
        let deleted = parts.next().unwrap_or("");
        if parts.next() == Some("") {
            index += 2;
        }
        let number = |text: &str| {
            if text == "-" {
                0
            } else {
                js_number(text)
                    .filter(|n| n.is_finite())
                    .map_or(0, |n| n as u64)
            }
        };
        counts.push((number(added), number(deleted), added == "-"));
    }
    for (at, file) in files.iter_mut().enumerate() {
        if let Some((additions, deletions, binary)) = counts.get(at) {
            file.additions = Some(*additions);
            file.deletions = Some(*deletions);
            if *binary {
                file.binary = Some(true);
            }
        }
        if let Some(mark) = generated.get(&file.path) {
            file.generated = Some(*mark);
        }
    }
    Summary {
        files,
        base_sha,
        head_sha,
        truncated: false,
        summary: true,
    }
}

/// A review's (or one of its commits') files, without their patches.
pub async fn read_review_summary(cx: &GitContext, root: &str, of: &SummaryOf) -> Result<Summary> {
    let target = match of {
        SummaryOf::Target(target) => Some(target),
        SummaryOf::Commit(_) => None,
    };
    let output = run_review_script(
        cx,
        root,
        &review_summary_script(root, of)?,
        ScriptHow {
            tag: "review.summary",
            timeout: SUMMARY_TIMEOUT,
            label: "git diff failed",
            target,
            max: None,
        },
    )
    .await?;
    Ok(parse_review_summary(&output))
}

/// A file to read: its path, and the one it had at the base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRequest {
    pub path: String,
    pub old_path: Option<String>,
}

impl FileRequest {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.into(),
            old_path: None,
        }
    }
}

/// One script: each file's patch between two commits (or trees), in the
/// order asked, each cut at `max_bytes`.
pub fn review_files_script(
    root: &str,
    base: &str,
    head: &str,
    files: &[FileRequest],
    max_bytes: usize,
) -> Result<String> {
    if !OBJECT_NAME.is_match(base) || !OBJECT_NAME.is_match(head) {
        return Err(GitError::message("invalid revision"));
    }
    if files.is_empty() {
        return Err(GitError::message("no files to read"));
    }
    if files.len() > REVIEW_DIFF_FILES_MAX {
        return Err(GitError::Message(format!(
            "at most {REVIEW_DIFF_FILES_MAX} files at a time"
        )));
    }
    if files.iter().any(|f| {
        !valid_review_path(&f.path) || f.old_path.as_deref().is_some_and(|o| !valid_review_path(o))
    }) {
        return Err(GitError::message("invalid path"));
    }
    let diff = format!("{GIT} --literal-pathspecs diff {DIFF_OPTIONS} --find-renames");
    let mut lines = vec![enter_checkout(root)];
    for (index, file) in files.iter().enumerate() {
        let mut paths = Vec::new();
        if let Some(old) = file
            .old_path
            .as_deref()
            .filter(|o| *o != file.path && !o.is_empty())
        {
            paths.push(shell_quote(old));
        }
        paths.push(shell_quote(&file.path));
        lines.push(format!(
            "printf '\\n{FILE_MARKER} {index}\\n'; {diff} {} {} -- {} | head -c {}",
            shell_quote(base),
            shell_quote(head),
            paths.join(" "),
            max_bytes + 1
        ));
    }
    lines.push("exit 0".to_owned());
    Ok(lines.join("\n"))
}

static FILE_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"\n{FILE_MARKER} (\d+)\n")).unwrap());

/// The files' patches as the script printed them, each in its place.
pub fn parse_review_files(output: &str, files: &[FileRequest], max_bytes: usize) -> Vec<DiffFile> {
    let found: Vec<(usize, usize, usize)> = FILE_MARK
        .captures_iter(output)
        .map(|c| {
            let whole = c.get(0).unwrap();
            (
                c[1].parse().unwrap_or(usize::MAX),
                whole.start(),
                whole.end(),
            )
        })
        .collect();
    let mut parts = std::collections::BTreeMap::new();
    for (at, (index, _, from)) in found.iter().enumerate() {
        let to = found.get(at + 1).map_or(output.len(), |next| next.1);
        parts.insert(*index, &output[*from..to]);
    }
    files
        .iter()
        .enumerate()
        .map(|(index, asked)| {
            let mut text = parts.get(&index).copied().unwrap_or("").to_owned();
            let truncated = text.len() > max_bytes;
            if truncated {
                // Only whole hunks: the one the cut fell in goes.
                text = match text.rfind("\n@@ ") {
                    Some(last) if last > 0 => text[..last + 1].to_owned(),
                    _ => String::new(),
                };
            }
            let parsed = parse_unified_diff(&text);
            let mut file = parsed
                .iter()
                .find(|f| f.path == asked.path)
                .or_else(|| parsed.first())
                .cloned()
                .unwrap_or_else(|| {
                    DiffFile::new(
                        &asked.path,
                        asked.old_path.as_deref().unwrap_or(&asked.path),
                    )
                });
            if truncated {
                file.truncated = Some(true);
            }
            file
        })
        .collect()
}

/// These files' patches between a summary's two commits.
pub async fn read_review_files(
    cx: &GitContext,
    root: &str,
    base: &str,
    head: &str,
    files: &[FileRequest],
) -> Result<Vec<DiffFile>> {
    let output = run_review_script(
        cx,
        root,
        &review_files_script(root, base, head, files, GIT_DIFF_MAX_BYTES)?,
        ScriptHow {
            tag: "review.files",
            timeout: SUMMARY_TIMEOUT,
            label: "git diff failed",
            target: None,
            max: None,
        },
    )
    .await?;
    Ok(parse_review_files(&output, files, GIT_DIFF_MAX_BYTES))
}

#[cfg(test)]
mod tests;
