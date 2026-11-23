//! The refs Changes' scope picker searches (diff-base.ts
//! `readCompareRefs`), and the JS comparisons and number reading the
//! parsers of this crate share.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use roamgate_base::assets::{COMPARE_REFS_SH, fill_template};
use serde::{Deserialize, Serialize};

use crate::diff_base::{Listed, Ref, read_invocation, resolve_default_base};
use crate::exec::GitContext;
use crate::review::is_metadata_ref;
use crate::{GitError, Result, first_text, shell_quote};

/// Tags offered: the newest ones, a long history holds thousands.
pub const COMPARE_TAGS_LISTED: usize = 200;
/// Stack neighbours taken on each side of HEAD.
const COMPARE_NEAR_LISTED: usize = 8;
/// How far back HEAD's history is searched for the branches below it.
const COMPARE_NEAR_HISTORY: usize = 1000;

/// `a.localeCompare(b)` in the default locale, close to ICU's root
/// collation for the names compared here (paths and ref names):
/// punctuation before digits before letters, letters compared without
/// case first, then lower case before upper case.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = |text: &str| -> Vec<(u8, char)> {
        text.chars()
            .map(|c| {
                let class = if c.is_alphabetic() {
                    3
                } else if c.is_numeric() {
                    2
                } else if c.is_whitespace() {
                    0
                } else {
                    1
                };
                (class, c.to_lowercase().next().unwrap_or(c))
            })
            .collect()
    };
    primary(a).cmp(&primary(b)).then_with(|| {
        // Tertiary: lower case first.
        let tertiary = |text: &str| -> Vec<bool> { text.chars().map(char::is_uppercase).collect() };
        tertiary(a).cmp(&tertiary(b))
    })
}

/// `localeCompare` with `sensitivity: "base"`: case does not count.
pub fn locale_compare_base(a: &str, b: &str) -> Ordering {
    let key = |text: &str| -> Vec<(u8, char)> {
        text.chars()
            .map(|c| {
                let class = if c.is_alphabetic() {
                    3
                } else if c.is_numeric() {
                    2
                } else if c.is_whitespace() {
                    0
                } else {
                    1
                };
                (class, c.to_lowercase().next().unwrap_or(c))
            })
            .collect()
    };
    key(a).cmp(&key(b))
}

/// `Number(text)`: None for NaN.
pub fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if trimmed
        .chars()
        .any(|c| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')))
    {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// `Number.isSafeInteger(Number(text)) && >= 0`, as a count of bytes.
pub fn safe_size(text: &str) -> Option<u64> {
    let value = js_number(text)?;
    (value.fract() == 0.0 && value >= 0.0 && value <= 9_007_199_254_740_991.0)
        .then_some(value as u64)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompareRef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompareRefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    pub near: Vec<String>,
    pub refs: Vec<CompareRef>,
}

/// One script: the refs with their dates, the config, HEAD and its kin.
pub fn compare_refs_script(root: &str) -> String {
    let git = format!("git -C {}", shell_quote(root));
    fill_template(
        COMPARE_REFS_SH,
        &[
            ("git", git.into()),
            ("tags_listed", (COMPARE_TAGS_LISTED as i64).into()),
            ("near_history", (COMPARE_NEAR_HISTORY as i64).into()),
            ("near_listed", ((COMPARE_NEAR_LISTED + 1) as i64).into()),
        ],
    )
    .expect("compare-refs.sh")
}

/// compareRefsScript's output, split.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedCompareRefs {
    pub listed: Listed,
    pub current: Option<String>,
    pub upstream: Option<String>,
    pub near: Vec<String>,
    pub refs: Vec<CompareRef>,
}

fn split2<'a>(text: &'a str, separator: &str) -> (&'a str, &'a str) {
    text.split_once(separator).unwrap_or((text, ""))
}

pub fn parse_compare_refs_output(stdout: &str) -> ParsedCompareRefs {
    let (refs_part, rest) = split2(stdout, "\n--diff-base-config--\n");
    let (config, after_config) = split2(rest, "\n--compare-head--\n");
    let (head, near_part) = split2(after_config, "\n--compare-near--\n");
    let current = head
        .trim()
        .split('\n')
        .next_back()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned);
    let mut refs = Vec::new();
    let mut branch_refs = Vec::new();
    let mut upstream = None;
    for line in refs_part
        .split('\n')
        .filter(|line| line.starts_with("refs/"))
    {
        let fields: Vec<&str> = line.split('\t').collect();
        let field = |index: usize| fields.get(index).copied().unwrap_or("");
        let name = field(0);
        let symbolic = (!field(1).is_empty()).then(|| field(1).to_owned());
        let sha = (!field(2).is_empty()).then(|| field(2).to_owned());
        if !name.starts_with("refs/tags/") {
            branch_refs.push(Ref {
                name: name.to_owned(),
                symbolic: symbolic.clone(),
                sha,
            });
        }
        if current.as_deref() == Some(name) && !field(4).is_empty() {
            upstream = Some(field(4).to_owned());
        }
        if symbolic.is_some() {
            continue;
        }
        if !name.starts_with("refs/tags/") && is_metadata_ref(name) {
            continue;
        }
        let seconds = js_number(field(3)).unwrap_or(0.0);
        refs.push(CompareRef {
            name: name.to_owned(),
            date: (seconds > 0.0).then_some(seconds as i64),
        });
    }
    let (history_part, above_part) = split2(near_part, "\n--compare-above--\n");
    let mut distance: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, sha) in history_part
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .enumerate()
    {
        // A Map built from pairs keeps the last index of a repeat.
        distance.insert(sha, index);
    }
    let mut below: Vec<&Ref> = branch_refs
        .iter()
        .filter(|r| {
            r.name.starts_with("refs/heads/")
                && r.symbolic.is_none()
                && Some(&r.name) != current.as_ref()
                && r.sha
                    .as_deref()
                    .is_some_and(|sha| distance.contains_key(sha))
        })
        .collect();
    below.sort_by_key(|r| distance[r.sha.as_deref().unwrap()]);
    let below = below
        .into_iter()
        .take(COMPARE_NEAR_LISTED)
        .map(|r| r.name.clone());
    let above = above_part
        .split('\n')
        .map(str::trim)
        .filter(|line| line.starts_with("refs/heads/") && Some(*line) != current.as_deref())
        .take(COMPARE_NEAR_LISTED)
        .map(str::to_owned);
    let mut seen = BTreeSet::new();
    let near = below
        .chain(above)
        .filter(|name| seen.insert(name.clone()))
        .collect();
    ParsedCompareRefs {
        listed: Listed {
            refs: branch_refs,
            configured_default: config.trim().to_owned(),
        },
        current,
        upstream,
        near,
        refs,
    }
}

/// The refs Changes' scope picker searches, read with what the repository
/// already has (never a fetch).
pub async fn read_compare_refs(
    cx: &GitContext,
    root: &str,
    timeout: Option<Duration>,
) -> Result<CompareRefs> {
    let timeout = timeout.unwrap_or(Duration::from_millis(10_000));
    let ran = cx
        .run(
            read_invocation(cx, &compare_refs_script(root), "git.refs")?,
            timeout,
        )
        .await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            "Unable to read branches",
            1000,
        )));
    }
    let parsed = parse_compare_refs_output(&ran.stdout);
    let base = resolve_default_base(cx, root, Some(timeout), Some(parsed.listed.clone()))
        .await
        .ok()
        .and_then(|resolved| resolved.base);
    Ok(CompareRefs {
        current: parsed.current,
        upstream: parsed.upstream,
        base,
        near: parsed.near,
        refs: parsed.refs,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::Path;
    use std::process::Command;

    use super::*;
    use crate::exec::testing::local;

    /// `git -C cwd args...` with a fixed identity and no global config.
    pub fn git(cwd: &Path, args: &[&str]) -> String {
        git_env(cwd, args, &[])
    }

    pub fn git_env(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
        for (key, value) in env {
            command.env(key, value);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn commit(root: &Path, file: &str, at: i64) {
        std::fs::write(root.join(file), file).unwrap();
        git(root, &["add", file]);
        let date = format!("@{at} +0000");
        git_env(
            root,
            &["commit", "-q", "-m", file],
            &[("GIT_AUTHOR_DATE", &date), ("GIT_COMMITTER_DATE", &date)],
        );
    }

    #[tokio::test]
    async fn the_scope_picker_s_refs_branches_with_their_dates_the_newest_tags_head_s_upstream_its_stack_s_neighbours_and_automatic_s_base()
     {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        commit(root, "base", 1_000);
        git(root, &["tag", "v1.0"]);
        git(root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(
            root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        git(root, &["switch", "-q", "-c", "up/one"]);
        commit(root, "one", 2_000);
        git(root, &["switch", "-q", "-c", "up/two"]);
        commit(root, "two", 3_000);
        git(root, &["switch", "-q", "-c", "up/three"]);
        commit(root, "three", 4_000);
        git(root, &["branch", "backup/old", "up/one"]);
        git(root, &["switch", "-q", "up/two"]);
        git(
            root,
            &["remote", "add", "origin", "https://example.test/repo.git"],
        );
        git(root, &["config", "branch.up/two.remote", "origin"]);
        git(root, &["config", "branch.up/two.merge", "refs/heads/main"]);

        let refs = read_compare_refs(&local(), root.to_str().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(refs.current.as_deref(), Some("refs/heads/up/two"));
        assert_eq!(refs.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!(refs.base.as_deref(), Some("refs/remotes/origin/main"));
        assert!(refs.near.contains(&"refs/heads/up/one".to_owned()));
        assert_eq!(refs.near.last().unwrap(), "refs/heads/up/three");
        assert!(!refs.near.contains(&"refs/heads/up/two".to_owned()));
        let by_name: BTreeMap<_, _> = refs
            .refs
            .iter()
            .map(|r| (r.name.as_str(), r.date))
            .collect();
        assert_eq!(by_name["refs/heads/up/three"], Some(4_000));
        assert_eq!(by_name["refs/tags/v1.0"], Some(1_000));
        assert!(by_name.contains_key("refs/remotes/origin/main"));
        assert!(!by_name.contains_key("refs/remotes/origin/HEAD"));
    }
}
