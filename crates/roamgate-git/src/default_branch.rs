//! Origin's default branch, asked of the remote on every sync and fetched
//! by its advertised commit (workspace/default-branch.ts): the clone's
//! `origin/HEAD` may be stale. Its tests run with the worktree base and
//! auto-sync that use it, in roamgate-workspace.

use std::sync::LazyLock;

use futures_util::future::BoxFuture;
use regex::Regex;

use crate::exec::{Ran, RunError};
use crate::{GitError, Result, shell_quote};

/// Runs `git <args>` in the checkout (the args a shell line).
pub type RunGit<'a> = &'a (dyn Fn(String) -> BoxFuture<'a, Result<Ran, RunError>> + Send + Sync);

fn process_error(result: &Ran, fallback: &str) -> String {
    let stderr = result.stderr.trim();
    let stdout = result.stdout.trim();
    let text = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback
    };
    crate::trim_slice(text, 2_000)
}

/// What the fetch of the default branch did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedDefault {
    /// `origin/<branch>`.
    pub base: String,
    pub commit: String,
    /// The fetch as it was run (`git fetch ...`).
    pub command: String,
    pub stdout: String,
    pub stderr: String,
}

static HEAD_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^ref: (refs/heads/[^\r\n]+)\tHEAD\r?$").unwrap());
static HEAD_COMMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD\r?$").unwrap());

/// Asks origin for its default branch and commit, fetches that object
/// (never a mutable ref, never writing FETCH_HEAD) and moves
/// `refs/remotes/origin/<branch>` to it unless a symbolic ref or a
/// conflicting name holds that place.
pub async fn fetch_origin_default_branch(run_git: RunGit<'_>) -> Result<FetchedDefault> {
    let tracking = run_git(
        "for-each-ref --format='%(refname) %(objectname) %(symref)' refs/remotes/origin/".into(),
    )
    .await?;
    if tracking.code != 0 {
        return Err(GitError::Message(format!(
            "Unable to read origin's tracking refs: {}",
            process_error(&tracking, "git for-each-ref failed")
        )));
    }
    let head = run_git("ls-remote --symref origin HEAD".into()).await?;
    if head.code != 0 {
        return Err(GitError::Message(format!(
            "Unable to determine origin's default branch: {}",
            process_error(&head, "git ls-remote failed")
        )));
    }
    let Some(reference) = HEAD_REF.captures(&head.stdout).map(|c| c[1].to_owned()) else {
        return Err(GitError::message(
            "Unable to determine origin's default branch: origin HEAD does not identify a branch.",
        ));
    };
    let valid = run_git(format!("check-ref-format {}", shell_quote(&reference))).await?;
    if valid.code != 0 {
        return Err(GitError::message(
            "Unable to determine origin's default branch: origin HEAD contains an invalid branch ref.",
        ));
    }
    let branch = reference["refs/heads/".len()..].to_owned();
    let base = format!("origin/{branch}");
    let Some(commit) = HEAD_COMMIT.captures(&head.stdout).map(|c| c[1].to_owned()) else {
        return Err(GitError::message(
            "Unable to determine origin's default commit: origin HEAD does not identify a commit.",
        ));
    };
    // The advertised object, not a mutable ref, without writing the
    // shared FETCH_HEAD.
    let fetch_args = format!(
        "fetch --no-tags --no-write-fetch-head --refmap= origin {}",
        shell_quote(&commit)
    );
    let fetched = run_git(fetch_args.clone()).await?;
    if fetched.code != 0 {
        return Err(GitError::Message(format!(
            "Unable to update {base}: {}",
            process_error(&fetched, &format!("git fetch exited {}", fetched.code))
        )));
    }
    let revision = run_git(format!(
        "rev-parse --verify {}",
        shell_quote(&format!("{commit}^{{commit}}"))
    ))
    .await?;
    if revision.code != 0 || revision.stdout.trim() != commit {
        return Err(GitError::Message(format!(
            "Unable to resolve {base} after fetching it: {}",
            process_error(&revision, &format!("{base} does not point to a commit"))
        )));
    }
    let tracking_ref = format!("refs/remotes/{base}");
    let tracking_refs: Vec<Vec<&str>> = tracking
        .stdout
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| line.split(' ').collect())
        .collect();
    let current = tracking_refs
        .iter()
        .find(|fields| fields.first() == Some(&tracking_ref.as_str()));
    // Conflicting refs are kept; fetch --prune cleans up after renames.
    let normalized = tracking_ref.to_lowercase();
    let mut blocked = current
        .and_then(|fields| fields.get(2))
        .is_some_and(|s| !s.is_empty())
        || tracking_refs.iter().any(|fields| {
            let name = fields.first().copied().unwrap_or("");
            let lower = name.to_lowercase();
            (lower == normalized && name != tracking_ref)
                || lower.starts_with(&format!("{normalized}/"))
                || normalized.starts_with(&format!("{lower}/"))
        });
    // for-each-ref omits dangling symrefs: each branch prefix is asked.
    let parts: Vec<&str> = branch.split('/').collect();
    let mut length = 1;
    while !blocked && length < parts.len() {
        let prefix = format!("refs/remotes/origin/{}", parts[..length].join("/"));
        let probed = run_git(format!("symbolic-ref --quiet {}", shell_quote(&prefix))).await?;
        if probed.code != 0 && probed.code != 1 {
            return Err(GitError::Message(format!(
                "Unable to check {base}'s tracking prefix: {}",
                process_error(&probed, "git symbolic-ref failed")
            )));
        }
        blocked = probed.code == 0;
        length += 1;
    }
    if !blocked {
        let symbolic = run_git(format!(
            "symbolic-ref --quiet {}",
            shell_quote(&tracking_ref)
        ))
        .await?;
        if symbolic.code != 0 && symbolic.code != 1 {
            return Err(GitError::Message(format!(
                "Unable to check {base}'s tracking ref: {}",
                process_error(&symbolic, "git symbolic-ref failed")
            )));
        }
        if symbolic.code == 1 {
            let old = current
                .and_then(|fields| fields.get(1))
                .copied()
                .unwrap_or("");
            let updated = run_git(format!(
                "update-ref --no-deref {} {} {}",
                shell_quote(&tracking_ref),
                shell_quote(&commit),
                shell_quote(old)
            ))
            .await?;
            if updated.code != 0 {
                let now =
                    run_git(format!("rev-parse --verify {}", shell_quote(&tracking_ref))).await?;
                if now.code != 0 || now.stdout.trim() != commit {
                    return Err(GitError::Message(format!(
                        "Unable to update {base}'s tracking ref: {}",
                        process_error(&updated, "git update-ref failed")
                    )));
                }
            }
        }
    }
    Ok(FetchedDefault {
        base,
        commit,
        command: format!("git {fetch_args}"),
        stdout: fetched.stdout.trim().to_owned(),
        stderr: fetched.stderr.trim().to_owned(),
    })
}
