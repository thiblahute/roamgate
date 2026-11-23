//! Changes' stage, unstage, discard and delete, on one file or the whole
//! repository (workspace/git-actions.ts): each checks the working tree
//! still is what the user saw before it changes anything.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use roamgate_base::assets::{DELETE_UNTRACKED_SH, UNTRACKED_STATS_SH, fill_template};
use serde::Serialize;
use serde_json::Value;

use crate::compare::js_number;
use crate::exec::{GitContext, Ran};
use crate::shell::{git_only_command, shell_command};
use crate::{GIT_DIFF_TIMEOUT, GitError, Result, first_text, sanitize_explorer_path, shell_quote};

pub const GIT_FILE_ACTIONS: [&str; 4] =
    ["stage", "unstage", "discard_unstaged", "delete_untracked"];
pub const GIT_REPO_ACTIONS: [&str; 4] = [
    "stage_all",
    "unstage_all",
    "discard_all_unstaged",
    "delete_all_untracked",
];
const FINGERPRINT_BATCH_SIZE: usize = 100;
const MAX_ACTION_OUTPUT: usize = 1000;

/// A checkout on its host.
#[derive(Debug, Clone)]
pub struct ActionContext {
    pub git: GitContext,
    pub root: String,
}

/// A worktree file's size and modification time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Fingerprint {
    #[serde(serialize_with = "ser_plain_js_num")]
    pub size: f64,
    #[serde(serialize_with = "ser_plain_js_num")]
    pub mtime_ms: f64,
}

fn ser_plain_js_num<S: serde::Serializer>(
    value: &f64,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    use serde::Serialize as _;
    crate::js_num(*value).serialize(serializer)
}

fn changed(path: &str) -> GitError {
    GitError::Message(format!(
        "{path} changed since the last refresh; refresh Changes and try again"
    ))
}

fn parse_action<'a>(value: Option<&Value>, allowed: &[&'a str], method: &str) -> Result<&'a str> {
    let name = value.and_then(Value::as_str);
    allowed
        .iter()
        .find(|allowed| Some(**allowed) == name)
        .copied()
        .ok_or_else(|| GitError::Message(format!("{method} requires a valid action")))
}

async fn run_git(context: &ActionContext, command: &str) -> Result<Ran> {
    let full = format!(
        "git -C {} -c core.quotepath=false {command}",
        shell_quote(&context.root)
    );
    let invocation = shell_command(&full, context.git.host()).map_err(GitError::Message)?;
    Ok(context.git.run(invocation, GIT_DIFF_TIMEOUT).await?)
}

async fn run_git_or_throw(context: &ActionContext, command: &str) -> Result<Ran> {
    let ran = run_git(context, command).await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git exited {}", ran.code),
            MAX_ACTION_OUTPUT,
        )));
    }
    Ok(ran)
}

async fn head_exists(context: &ActionContext) -> Result<bool> {
    let ran = run_git(context, "rev-parse --verify --quiet 'HEAD^{commit}'").await?;
    Ok(ran.code == 0 && !ran.stdout.trim().is_empty())
}

pub(crate) fn is_conflicted(x: char, y: char) -> bool {
    x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D')
}

fn status_pair(line: &str) -> (char, char) {
    let mut chars = line.chars();
    (chars.next().unwrap_or(' '), chars.next().unwrap_or(' '))
}

/// Whether a file's porcelain line allows the action.
pub fn porcelain_allows_file_action(action: &str, porcelain: &str) -> bool {
    let Some(line) = porcelain
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .find(|l| !l.is_empty())
    else {
        return false;
    };
    let (x, y) = status_pair(line);
    let untracked = x == '?' && y == '?';
    let conflicted = is_conflicted(x, y);
    match action {
        // A conflicted file is staged to mark it resolved.
        "stage" => untracked || conflicted || y != ' ',
        "unstage" => !untracked && !conflicted && x != ' ',
        "discard_unstaged" => !untracked && !conflicted && y != ' ',
        "delete_untracked" => untracked,
        _ => false,
    }
}

/// `base64(path) size mtime` lines.
pub fn parse_fingerprint_listing(output: &str) -> BTreeMap<String, Fingerprint> {
    let mut fingerprints = BTreeMap::new();
    for line in output
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
    {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\t');
        let Some(raw) = fields.next().filter(|r| !r.is_empty()) else {
            continue;
        };
        let path = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        let size = fields.next().and_then(js_number);
        let mtime = fields.next().and_then(js_number);
        let (Some(size), Some(mtime)) = (size, mtime) else {
            continue;
        };
        if path.is_empty() || !size.is_finite() || !mtime.is_finite() {
            continue;
        }
        fingerprints.insert(
            path,
            Fingerprint {
                size,
                mtime_ms: mtime * 1000.0,
            },
        );
    }
    fingerprints
}

/// A checkout's file as `untracked-stats.sh` reads it, without the shell: a
/// regular file (or a link to one), its own size and whole-second mtime.
fn local_fingerprint(root: &str, path: &str) -> Option<Fingerprint> {
    let full = std::path::Path::new(root).join(path);
    if !std::fs::metadata(&full).ok()?.is_file() {
        return None;
    }
    let own = std::fs::symlink_metadata(&full).ok()?;
    let modified = own.modified().ok()?;
    let seconds = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => after.as_secs() as f64,
        Err(before) => -(before.duration().as_secs_f64().ceil()),
    };
    Some(Fingerprint {
        size: own.len() as f64,
        mtime_ms: seconds * 1000.0,
    })
}

/// Stats worktree files in batches, one shell round trip each; missing
/// files are absent. Paths go as `./path`, so a leading dash is a name.
/// On this machine the files are read in process: the script forks a few
/// processes per file, a second or more for a few dozen files on a busy
/// host.
pub async fn collect_worktree_fingerprints(
    context: &ActionContext,
    paths: &[String],
) -> Result<BTreeMap<String, Fingerprint>> {
    let mut seen = BTreeSet::new();
    let unique: Vec<&String> = paths
        .iter()
        .filter(|p| !p.is_empty() && seen.insert(p.as_str()))
        .collect();
    let mut fingerprints = BTreeMap::new();
    if context.git.host().is_none() {
        for path in unique {
            if let Some(fingerprint) = local_fingerprint(&context.root, path) {
                fingerprints.insert(path.clone(), fingerprint);
            }
        }
        return Ok(fingerprints);
    }
    for batch in unique.chunks(FINGERPRINT_BATCH_SIZE) {
        let command = fill_template(
            UNTRACKED_STATS_SH,
            &[
                (
                    "paths",
                    batch
                        .iter()
                        .map(|p| shell_quote(p))
                        .collect::<Vec<_>>()
                        .join(" ")
                        .into(),
                ),
                ("root", shell_quote(&context.root).into()),
            ],
        )
        .expect("untracked-stats.sh");
        let invocation =
            git_only_command(&command, context.git.host()).map_err(GitError::Message)?;
        let ran = context.git.run(invocation, GIT_DIFF_TIMEOUT).await?;
        if ran.code != 0 {
            continue;
        }
        fingerprints.extend(parse_fingerprint_listing(&ran.stdout));
    }
    Ok(fingerprints)
}

fn expected_fingerprint(params: &Value) -> Option<Fingerprint> {
    let number = |key: &str| match params.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => js_number(s),
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(f64::from(u8::from(*b))),
        _ => None,
    };
    let mtime = number("mtime_ms")?;
    let size = number("size")?;
    if !mtime.is_finite() || mtime <= 0.0 || !size.is_finite() || size < 0.0 {
        return None;
    }
    Some(Fingerprint {
        size,
        mtime_ms: mtime,
    })
}

async fn assert_porcelain_allows(context: &ActionContext, action: &str, path: &str) -> Result<()> {
    let ran = run_git_or_throw(
        context,
        &format!(
            "status --porcelain=v1 --untracked-files=all -- {}",
            shell_quote(path)
        ),
    )
    .await?;
    if !porcelain_allows_file_action(action, &ran.stdout) {
        return Err(changed(path));
    }
    Ok(())
}

/// `git clean -f` skips untracked directories and still exits 0: they are
/// refused instead. A symlink is removed itself, whatever it points at.
async fn run_delete_untracked(context: &ActionContext, path: &str) -> Result<()> {
    let script = fill_template(
        DELETE_UNTRACKED_SH,
        &[
            ("root", shell_quote(&context.root).into()),
            ("file", shell_quote(&format!("./{path}")).into()),
            ("path", shell_quote(path).into()),
        ],
    )
    .expect("delete-untracked.sh");
    let invocation = shell_command(&script, context.git.host()).map_err(GitError::Message)?;
    let ran = context.git.run(invocation, GIT_DIFF_TIMEOUT).await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git clean exited {}", ran.code),
            MAX_ACTION_OUTPUT,
        )));
    }
    Ok(())
}

fn pathspecs(path: &str, old_path: &str) -> String {
    let paths: Vec<&str> = if !old_path.is_empty() && old_path != path {
        vec![old_path, path]
    } else {
        vec![path]
    };
    paths
        .iter()
        .map(|p| shell_quote(p))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileActionResult {
    pub action: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

/// `git.file_action`.
pub async fn run_git_file_action(
    context: &ActionContext,
    params: &Value,
) -> Result<FileActionResult> {
    let action = parse_action(params.get("action"), &GIT_FILE_ACTIONS, "git.file_action")?;
    let path = sanitize_explorer_path(params.get("path"))?;
    if path.is_empty() {
        return Err(GitError::message("git.file_action requires path"));
    }
    let old_path = sanitize_explorer_path(params.get("old_path"))?;
    assert_porcelain_allows(context, action, &path).await?;
    if action == "discard_unstaged" || action == "delete_untracked" {
        let expected = expected_fingerprint(params);
        let current = collect_worktree_fingerprints(context, std::slice::from_ref(&path))
            .await?
            .remove(&path);
        match (expected, current) {
            // Fail closed: without the summary's fingerprint, a change
            // since the menu opened cannot be told. A missing file stays
            // allowed (restoring a deletion, a broken link).
            (None, Some(_)) => return Err(changed(&path)),
            (None, None) => {}
            (Some(_), None) => return Err(changed(&path)),
            (Some(expected), Some(current)) => {
                if current.size != expected.size
                    || (current.mtime_ms / 1000.0).trunc() != (expected.mtime_ms / 1000.0).trunc()
                {
                    return Err(changed(&path));
                }
            }
        }
    }
    let old = (!old_path.is_empty()).then(|| old_path.clone());
    if action == "delete_untracked" {
        run_delete_untracked(context, &path).await?;
        return Ok(FileActionResult {
            action: action.into(),
            path,
            old_path: old,
        });
    }
    let command = match action {
        "stage" => format!("add -- {}", shell_quote(&path)),
        "unstage" => {
            if head_exists(context).await? {
                format!("reset -q HEAD -- {}", pathspecs(&path, &old_path))
            } else {
                format!("rm -q --cached -- {}", pathspecs(&path, &old_path))
            }
        }
        // From the index: a staged version survives.
        _ => format!("checkout -- {}", shell_quote(&path)),
    };
    run_git_or_throw(context, &command).await?;
    Ok(FileActionResult {
        action: action.into(),
        path,
        old_path: old,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct WorkingTreeCounts {
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
    pub conflicted: u64,
}

impl WorkingTreeCounts {
    fn get(&self, key: &str) -> u64 {
        match key {
            "staged" => self.staged,
            "unstaged" => self.unstaged,
            "untracked" => self.untracked,
            _ => self.conflicted,
        }
    }
}

pub fn parse_working_tree_counts(output: &str) -> WorkingTreeCounts {
    let mut counts = WorkingTreeCounts::default();
    for line in output
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
    {
        if line.is_empty() {
            continue;
        }
        let (x, y) = status_pair(line);
        if x == '?' && y == '?' {
            counts.untracked += 1;
            continue;
        }
        if is_conflicted(x, y) {
            counts.conflicted += 1;
            continue;
        }
        if x != ' ' {
            counts.staged += 1;
        }
        if y != ' ' {
            counts.unstaged += 1;
        }
    }
    counts
}

async fn read_working_tree_counts(context: &ActionContext) -> Result<WorkingTreeCounts> {
    let ran = run_git_or_throw(context, "status --porcelain=v1 --untracked-files=all").await?;
    Ok(parse_working_tree_counts(&ran.stdout))
}

fn expected_counts(params: &Value) -> Option<BTreeMap<&'static str, u64>> {
    let record = params.get("expected_counts")?.as_object()?;
    let mut counts = BTreeMap::new();
    for key in ["staged", "unstaged", "untracked", "conflicted"] {
        let value = match record.get(key) {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => js_number(s),
            _ => None,
        };
        if let Some(value) = value
            && value.fract() == 0.0
            && (0.0..=9_007_199_254_740_991.0).contains(&value)
        {
            counts.insert(key, value as u64);
        }
    }
    (!counts.is_empty()).then_some(counts)
}

async fn assert_counts_fresh(
    context: &ActionContext,
    expected: Option<&BTreeMap<&'static str, u64>>,
    keys: &[&str],
) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current = read_working_tree_counts(context).await?;
    if keys.iter().any(|key| {
        expected
            .get(key)
            .is_some_and(|want| *want != current.get(key))
    }) {
        return Err(GitError::message(
            "the working tree changed since the last refresh; refresh Changes and try again",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoActionResult {
    pub action: String,
    pub counts: WorkingTreeCounts,
}

/// `git.repo_action`.
pub async fn run_git_repo_action(
    context: &ActionContext,
    params: &Value,
) -> Result<RepoActionResult> {
    let action = parse_action(params.get("action"), &GIT_REPO_ACTIONS, "git.repo_action")?;
    let expected = expected_counts(params);
    let command = match action {
        "stage_all" => "add -A",
        "unstage_all" => {
            if head_exists(context).await? {
                "reset -q"
            } else {
                "rm -r -q --cached ."
            }
        }
        "discard_all_unstaged" => {
            assert_counts_fresh(context, expected.as_ref(), &["unstaged"]).await?;
            if read_working_tree_counts(context).await?.conflicted > 0 {
                return Err(GitError::message(
                    "resolve conflicted files before discarding all unstaged changes",
                ));
            }
            // From the index: staged changes survive.
            "checkout -- ."
        }
        _ => {
            assert_counts_fresh(context, expected.as_ref(), &["untracked"]).await?;
            // No -x: ignored files stay.
            "clean -fd"
        }
    };
    run_git_or_throw(context, command).await?;
    let counts = read_working_tree_counts(context).await?;
    Ok(RepoActionResult {
        action: action.into(),
        counts,
    })
}

#[cfg(test)]
mod tests;
