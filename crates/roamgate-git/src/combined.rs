//! One file of the working changes as the review reads them
//! (workspace/git-combined.ts): the combined `git diff HEAD` (staged and
//! unstaged together, an untracked file as new) and which of its changed
//! lines the index holds, told from `git diff --cached` and `git diff`.

use std::collections::{BTreeMap, BTreeSet};

use roamgate_base::assets::{COMBINED_DIFF_SH, fill_template};
use serde::Serialize;

use crate::compare::safe_size;
use crate::patch::{DiffFile, HUNK_HEADER, LineKind, parse_unified_diff};
use crate::review_patch::{DIFF_OPTIONS, GIT as REVIEW_GIT};
use crate::{GIT_DIFF_MAX_BYTES, GitError, LARGE_DIFF_PATCH_BYTES, Result, shell_quote};

/// Line ranges, first and last, both included.
pub type LineRanges = Vec<[u64; 2]>;

/// The changed lines of a combined diff the index holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CombinedStaged {
    /// HEAD's lines the combined diff removes and the index no longer has.
    pub old: LineRanges,
    /// The working tree's lines the combined diff adds that the index has.
    pub new: LineRanges,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CombinedDiffFile {
    pub diff: String,
    pub patch_size: u64,
    pub truncated: bool,
    pub deferred: bool,
    pub untracked: bool,
    pub unmerged: bool,
    /// Absent when it cannot be told (a conflict, a patch too large or
    /// deferred).
    pub staged: Option<CombinedStaged>,
}

fn to_ranges(lines: impl IntoIterator<Item = u64>) -> LineRanges {
    let sorted: BTreeSet<u64> = lines.into_iter().collect();
    let mut ranges: LineRanges = Vec::new();
    for line in sorted {
        match ranges.last_mut() {
            Some(last) if line == last[1] + 1 => last[1] = line,
            _ => ranges.push([line, line]),
        }
    }
    ranges
}

/// A diff's new-side line to its old-side line, through its hunks; None:
/// a line the diff added.
fn new_to_old(file: Option<&DiffFile>) -> impl Fn(u64) -> Option<u64> + '_ {
    let mut exact: BTreeMap<u64, Option<u64>> = BTreeMap::new();
    // Each hunk's first new-side line and the offset (old - new) after it.
    let mut spans: Vec<(i64, i64)> = Vec::new();
    if let Some(file) = file {
        for hunk in &file.hunks {
            for line in &hunk.lines {
                if let Some(new) = line.new {
                    exact.insert(
                        new,
                        if line.kind == LineKind::Added {
                            None
                        } else {
                            line.old
                        },
                    );
                }
            }
            let Some(header) = HUNK_HEADER.captures(&hunk.header) else {
                continue;
            };
            // A side with no lines names the line before it.
            let end = |start: &str, count: Option<&str>| -> i64 {
                let start: i64 = start.parse().unwrap_or(0);
                match count {
                    Some("0") => start,
                    Some(count) => start + count.parse::<i64>().unwrap_or(0) - 1,
                    None => start,
                }
            };
            let old_end = end(&header[1], header.get(2).map(|m| m.as_str()));
            let new_end = end(&header[3], header.get(4).map(|m| m.as_str()));
            spans.push((header[3].parse().unwrap_or(0), old_end - new_end));
        }
    }
    let present = file.is_some();
    move |line: u64| {
        if !present {
            return Some(line);
        }
        if let Some(mapped) = exact.get(&line) {
            return *mapped;
        }
        let mut delta = 0i64;
        for (start, after) in &spans {
            if *start > line as i64 {
                break;
            }
            delta = *after;
        }
        Some((line as i64 + delta) as u64)
    }
}

/// The changed lines of `combined` (HEAD to working tree) that are staged,
/// from `cached` (HEAD to index) and `unstaged` (index to working tree).
pub fn staged_lines(
    combined: Option<&DiffFile>,
    cached: Option<&DiffFile>,
    unstaged: Option<&DiffFile>,
) -> CombinedStaged {
    let mut cached_removed = BTreeSet::new();
    let mut cached_added = BTreeSet::new();
    for line in cached.iter().flat_map(|f| &f.hunks).flat_map(|h| &h.lines) {
        match (line.kind, line.old, line.new) {
            (LineKind::Removed, Some(old), _) => {
                cached_removed.insert(old);
            }
            (LineKind::Added, _, Some(new)) => {
                cached_added.insert(new);
            }
            _ => {}
        }
    }
    let to_index = new_to_old(unstaged);
    let mut old = Vec::new();
    let mut added = Vec::new();
    for line in combined
        .iter()
        .flat_map(|f| &f.hunks)
        .flat_map(|h| &h.lines)
    {
        match (line.kind, line.old, line.new) {
            (LineKind::Removed, Some(line_old), _) if cached_removed.contains(&line_old) => {
                old.push(line_old);
            }
            (LineKind::Added, _, Some(new)) => {
                if let Some(index) = to_index(new)
                    && cached_added.contains(&index)
                {
                    added.push(new);
                }
            }
            _ => {}
        }
    }
    CombinedStaged {
        old: to_ranges(old),
        new: to_ranges(added),
    }
}

/// git as the review's patch loader runs it, pathspecs taken literally.
fn git() -> String {
    format!("{REVIEW_GIT} --literal-pathspecs")
}

/// The script: the combined patch into a private file (its size first,
/// then the patch, cut), then, marked, the cached and unstaged patches.
pub fn combined_diff_script(
    root: &str,
    path: &str,
    old_path: Option<&str>,
    marker: &str,
    automatic: bool,
) -> String {
    let pathspec = [old_path.filter(|old| *old != path), Some(path)]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    fill_template(
        COMBINED_DIFF_SH,
        &[
            ("root", shell_quote(root).into()),
            ("path", shell_quote(path).into()),
            ("git", git().into()),
            ("diff_options", DIFF_OPTIONS.into()),
            ("pathspec", pathspec.into()),
            ("automatic", if automatic { "1" } else { "0" }.into()),
            ("large_patch_bytes", (LARGE_DIFF_PATCH_BYTES as i64).into()),
            ("cap", ((GIT_DIFF_MAX_BYTES + 4) as i64).into()),
            ("max_bytes", (GIT_DIFF_MAX_BYTES as i64).into()),
            ("marker", marker.into()),
        ],
    )
    .expect("combined-diff.sh")
}

/// The file's own patch among a patch's files (a rename: by either name).
fn file_of(text: &str, path: &str) -> Option<DiffFile> {
    let files = parse_unified_diff(text);
    files
        .iter()
        .find(|f| f.path == path)
        .or_else(|| files.iter().find(|f| f.old_path == path))
        .or_else(|| files.first())
        .cloned()
}

/// `bytes[..GIT_DIFF_MAX_BYTES]` without a cut UTF-8 sequence, as text.
pub(crate) fn cut_patch(patch: &str) -> String {
    let bytes = patch.as_bytes();
    let end = bytes.len().min(GIT_DIFF_MAX_BYTES);
    String::from_utf8_lossy(crate::trim_incomplete_utf8_tail(&bytes[..end])).into_owned()
}

pub fn parse_combined_diff_output(
    output: &str,
    marker: &str,
    path: &str,
    automatic: bool,
) -> Result<CombinedDiffFile> {
    let newline = output.find('\n');
    let first = output[..newline.unwrap_or(output.len())].trim();
    let mut fields = first.split(' ');
    let size = fields.next().unwrap_or("");
    let untracked = fields.next() == Some("1");
    let unmerged = fields.next() == Some("1");
    let patch_size = match (newline, safe_size(size)) {
        (Some(_), Some(size)) => size,
        _ => return Err(GitError::message("invalid Git patch size")),
    };
    let rest = &output[newline.unwrap() + 1..];
    let separator = format!("\n{marker}\n");
    let mut parts = rest.split(separator.as_str());
    let patch = parts.next().unwrap_or("");
    let cached = parts.next();
    let unstaged = parts.next();
    let truncated = patch_size > GIT_DIFF_MAX_BYTES as u64;
    let deferred = automatic && patch_size >= LARGE_DIFF_PATCH_BYTES as u64;
    let diff = if truncated {
        cut_patch(patch)
    } else {
        patch.to_owned()
    };
    let mut result = CombinedDiffFile {
        diff: if deferred {
            String::new()
        } else {
            diff.clone()
        },
        patch_size,
        truncated,
        deferred,
        untracked,
        unmerged,
        staged: None,
    };
    if deferred || truncated || unmerged {
        return Ok(result);
    }
    if untracked {
        result.staged = Some(CombinedStaged::default());
        return Ok(result);
    }
    let (Some(cached), Some(unstaged)) = (cached, unstaged) else {
        return Ok(result);
    };
    // A cut cached or unstaged patch cannot tell the lines exactly.
    if cached.len() > GIT_DIFF_MAX_BYTES || unstaged.len() > GIT_DIFF_MAX_BYTES {
        return Ok(result);
    }
    result.staged = Some(staged_lines(
        file_of(&diff, path).as_ref(),
        file_of(cached, path).as_ref(),
        file_of(unstaged, path).as_ref(),
    ));
    Ok(result)
}

/// Where the script's own output starts: past what a login profile
/// printed (`^\d+ [01] [01]\n`, multiline).
pub fn skip_login_noise(stdout: &str) -> &str {
    let mut offset = 0;
    for line in stdout.split_inclusive('\n') {
        if is_size_line(line) {
            return &stdout[offset..];
        }
        offset += line.len();
    }
    stdout
}

fn is_size_line(line: &str) -> bool {
    let Some(body) = line.strip_suffix('\n') else {
        return false;
    };
    let mut parts = body.split(' ');
    let (Some(size), Some(a), Some(b), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    !size.is_empty()
        && size.bytes().all(|c| c.is_ascii_digit())
        && matches!(a, "0" | "1")
        && matches!(b, "0" | "1")
}

#[cfg(test)]
mod tests;
