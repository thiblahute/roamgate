//! A checkout's files as a tree (workspace/git-snapshot.ts and
//! git-diff.ts `snapshotWorktree`): contract/assets/sh/step-snapshot.sh
//! writes a private index's tree under a quarantine it owns, and names
//! the untracked files it left out for their size.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_base::assets::{STEP_SNAPSHOT_SH, fill_template};

use crate::exec::GitContext;
use crate::shell::shell_command;
use crate::{GIT_DIFF_TIMEOUT, GitError, Result, first_text, shell_quote};

/// The snapshot script for `root`. All its writes before publication
/// belong to one fixed, exclusively created directory: a killed shell
/// must not unlink storage its child still uses.
pub fn worktree_snapshot_command(root: &str) -> String {
    fill_template(STEP_SNAPSHOT_SH, &[("root", shell_quote(root).into())])
        .expect("step-snapshot.sh")
}

/// A snapshot: its tree, and the untracked files left out for their size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub tree: String,
    pub skipped: Vec<String>,
}

static TREE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40,64}$").unwrap());

/// Takes a snapshot of the checkout at `root` on its host.
pub async fn snapshot_worktree(cx: &GitContext, root: &str) -> Result<Snapshot> {
    let command = worktree_snapshot_command(root);
    let ran = cx
        .run(
            shell_command(&command, cx.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?;
    let lines: Vec<&str> = ran.stdout.trim().split('\n').collect();
    let tree = lines.last().copied().unwrap_or("").trim().to_owned();
    let skipped = lines
        .iter()
        .filter_map(|line| line.strip_prefix("skipped\t"))
        .map(str::to_owned)
        .collect();
    if ran.code != 0 || !TREE.is_match(&tree) {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git write-tree exited {}", ran.code),
            1000,
        )));
    }
    Ok(Snapshot { tree, skipped })
}

/// [`snapshot_worktree`]'s tree.
pub async fn snapshot_worktree_tree(cx: &GitContext, root: &str) -> Result<String> {
    Ok(snapshot_worktree(cx, root).await?.tree)
}

#[cfg(test)]
mod tests;
