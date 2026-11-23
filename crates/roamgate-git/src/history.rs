//! A checkout's commit history (workspace/git-history.ts): pages of
//! commits anchored on a head, one commit's changes against its first
//! parent (none past a shallow boundary), a file's patch and a file's
//! content at a commit.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use base64::Engine as _;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::compare::js_number;
use crate::diff::{read_git_patch, status_label};
use crate::exec::GitContext;
use crate::preview::{
    PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES, decode_preview_buffer, image_mime_for_path,
};
use crate::shell::shell_command;
use crate::{GIT_DIFF_TIMEOUT, GitError, Result, first_text, sanitize_explorer_path, shell_quote};

/// A checkout on its host.
#[derive(Debug, Clone)]
pub struct HistoryContext {
    pub git: GitContext,
    pub root: String,
}

static COMMIT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40}(?:[a-f0-9]{24})?$").unwrap());

fn commit_id(value: Option<&Value>) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(id) if COMMIT_ID.is_match(id) => Ok(id.to_owned()),
        _ => Err(GitError::message("invalid commit id")),
    }
}

async fn run(context: &HistoryContext, full: &str) -> Result<crate::Ran> {
    Ok(context
        .git
        .run(
            shell_command(full, context.git.host()).map_err(GitError::Message)?,
            GIT_DIFF_TIMEOUT,
        )
        .await?)
}

async fn git(context: &HistoryContext, command: &str) -> Result<String> {
    let full = format!(
        "git -C {} -c core.quotepath=false {command}",
        shell_quote(&context.root)
    );
    let ran = run(context, &full).await?;
    if ran.code != 0 {
        return Err(GitError::Message(first_text(
            &[&ran.stderr, &ran.stdout],
            &format!("git exited {}", ran.code),
            1000,
        )));
    }
    Ok(ran.stdout)
}

fn parse_entries(status: &str, stat: &str) -> Vec<Value> {
    let mut stats: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let fields: Vec<&str> = stat.split('\0').collect();
    let mut index = 0;
    while index + 1 < fields.len() {
        let line = fields[index];
        index += 1;
        let mut parts = line.split('\t');
        let added = parts.next().unwrap_or("");
        let deleted = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        // A rename's numstat line has no path: the two names follow.
        let actual = if path.is_empty() {
            index += 1;
            let path = fields.get(index).copied().unwrap_or("");
            index += 1;
            path
        } else {
            path
        };
        if actual.is_empty() {
            continue;
        }
        let mut value = Map::new();
        if added == "-" || deleted == "-" {
            value.insert("binary".into(), json!(true));
        } else {
            let number = |text: &str| {
                js_number(text)
                    .filter(|n| *n != 0.0 && n.is_finite())
                    .unwrap_or(0.0)
            };
            value.insert("additions".into(), json!(number(added) as u64));
            value.insert("deletions".into(), json!(number(deleted) as u64));
        }
        stats.insert(actual.to_owned(), value);
    }
    let statuses: Vec<&str> = status.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index + 1 < statuses.len() {
        let code = statuses[index];
        index += 1;
        let renamed = code.starts_with('R') || code.starts_with('C');
        let first = statuses.get(index).copied().unwrap_or("");
        index += 1;
        let path = if renamed {
            let path = statuses.get(index).copied().unwrap_or("");
            index += 1;
            path
        } else {
            first
        };
        if path.is_empty() {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("path".into(), json!(path));
        if renamed {
            entry.insert("old_path".into(), json!(first));
        }
        entry.insert("kind".into(), json!("branch"));
        let letter = code.chars().next().map_or("M".to_owned(), String::from);
        entry.insert("status".into(), json!(status_label(&letter, "branch")));
        if let Some(stat) = stats.get(path) {
            entry.extend(stat.clone());
        }
        entries.push(Value::Object(entry));
    }
    entries
}

/// `git.commits`: 30 commits from `head` (or HEAD) past `offset`.
pub async fn list_commits(context: &HistoryContext, params: &Value) -> Result<Value> {
    let offset = match params.get("offset") {
        None => 0,
        Some(Value::Number(n)) => match n.as_u64() {
            Some(n) if n <= 100_000 => n,
            _ => return Err(GitError::message("invalid history offset")),
        },
        _ => return Err(GitError::message("invalid history offset")),
    };
    let requested = params
        .get("head")
        .filter(|h| !matches!(h, Value::Null | Value::Bool(false)) && h.as_str() != Some(""));
    let head = match requested {
        Some(head) => commit_id(Some(head))?,
        None => {
            let full = format!(
                "git -C {} rev-parse -q --verify 'HEAD^{{commit}}'",
                shell_quote(&context.root)
            );
            let ran = run(context, &full).await?;
            if ran.code != 0 {
                return Ok(
                    json!({ "head": null, "commits": [], "has_more": false, "shallow": false }),
                );
            }
            commit_id(Some(&json!(ran.stdout.trim())))?
        }
    };
    let output = git(
        context,
        &format!(
            "log -z --max-count=31 --skip={offset} --format='%H%x00%h%x00%an%x00%aI%x00%s' {}",
            shell_quote(&head)
        ),
    )
    .await?;
    let fields: Vec<&str> = output.split('\0').collect();
    let mut commits = Vec::new();
    let mut index = 0;
    while index + 4 < fields.len() {
        // `log -z` ends each record with a NUL: the next sha follows it
        // (with git's newline separator removed by -z).
        if fields[index].is_empty() {
            break;
        }
        commits.push(json!({
            "sha": fields[index],
            "short_sha": fields[index + 1],
            "author": fields[index + 2],
            "authored_at": fields[index + 3],
            "subject": fields[index + 4],
        }));
        index += 5;
    }
    let shallow = git(context, "rev-parse --is-shallow-repository")
        .await?
        .trim()
        == "true";
    let has_more = commits.len() > 30;
    commits.truncate(30);
    Ok(json!({ "head": head, "commits": commits, "has_more": has_more, "shallow": shallow }))
}

async fn object_exists(context: &HistoryContext, sha: &str) -> Result<bool> {
    let full = format!(
        "git -C {} cat-file -e {}",
        shell_quote(&context.root),
        shell_quote(&format!("{sha}^{{commit}}"))
    );
    Ok(run(context, &full).await?.code == 0)
}

/// `git.commit`: one commit's metadata and its changes.
pub async fn read_commit(context: &HistoryContext, sha: Option<&Value>) -> Result<Value> {
    let sha = commit_id(sha)?;
    let output = git(
        context,
        &format!(
            "show -s --format='%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B' {}",
            shell_quote(&sha)
        ),
    )
    .await?;
    let fields: Vec<&str> = output.split('\0').collect();
    if fields.len() < 9 {
        return Err(GitError::message("invalid commit metadata"));
    }
    let mut parents: Vec<String> = fields[1]
        .split(' ')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect();
    if parents.is_empty()
        && git(context, "rev-parse --is-shallow-repository")
            .await?
            .trim()
            == "true"
    {
        let raw = git(context, &format!("cat-file -p {}", shell_quote(&sha))).await?;
        let header = raw.split("\n\n").next().unwrap_or("");
        parents = header
            .split('\n')
            .filter_map(|line| line.strip_prefix("parent "))
            .map(str::to_owned)
            .collect();
    }
    let base = parents.first().cloned();
    let shallow_boundary = match &base {
        Some(base) => !object_exists(context, base).await?,
        None => false,
    };
    let args = match &base {
        Some(base) => format!(
            "diff --no-ext-diff --find-renames {} {}",
            shell_quote(base),
            shell_quote(&sha)
        ),
        None => format!(
            "diff-tree --root --no-commit-id -r --find-renames {}",
            shell_quote(&sha)
        ),
    };
    let (status, stat) = if shallow_boundary {
        (String::new(), String::new())
    } else {
        let (name_status, numstat) = (
            format!("{args} --name-status -z"),
            format!("{args} --numstat -z"),
        );
        let (status, stat) = tokio::join!(git(context, &name_status), git(context, &numstat));
        (status?, stat?)
    };
    let message = fields[8..].join("\0");
    Ok(json!({
        "sha": sha,
        "parents": parents,
        "base": base,
        "shallow_boundary": shallow_boundary,
        "subject": fields[8].split('\n').next().unwrap_or(""),
        "message": message.trim_end_matches('\n'),
        "author": { "name": fields[2], "email": fields[3], "date": fields[4] },
        "committer": { "name": fields[5], "email": fields[6], "date": fields[7] },
        "entries": parse_entries(&status, &stat),
    }))
}

/// `git.commit_file`: a file's patch in a commit.
pub async fn read_commit_file(context: &HistoryContext, params: &Value) -> Result<Value> {
    let sha = commit_id(params.get("sha"))?;
    let base = match params.get("base") {
        Some(Value::Null) => None,
        other => Some(commit_id(other)?),
    };
    let path = sanitize_explorer_path(params.get("path"))?;
    if path.is_empty() {
        return Err(GitError::message("git.commit_file requires path"));
    }
    let old_path = sanitize_explorer_path(params.get("old_path"))?;
    let paths: Vec<&str> = if !old_path.is_empty() && old_path != path {
        vec![&old_path, &path]
    } else {
        vec![&path]
    };
    let args = match &base {
        Some(base) => format!(
            "diff --no-ext-diff --find-renames {} {}",
            shell_quote(base),
            shell_quote(&sha)
        ),
        None => format!(
            "diff-tree --root --no-commit-id -r -p --no-ext-diff --find-renames {}",
            shell_quote(&sha)
        ),
    };
    let command = format!(
        "{args} -- {}",
        paths
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let patch = read_git_patch(&context.git, &context.root, &command, false).await?;
    if patch.code != 0 {
        return Err(GitError::Message(first_text(
            &[&patch.stderr, &patch.stdout],
            &format!("git exited {}", patch.code),
            1000,
        )));
    }
    Ok(json!({
        "path": path,
        "kind": "branch",
        "diff": patch.diff,
        "patch_size": patch.patch_size,
        "truncated": patch.truncated,
    }))
}

/// `git.commit_preview`: a file's content at a commit, bounded.
pub async fn read_commit_preview(context: &HistoryContext, params: &Value) -> Result<Value> {
    let sha = commit_id(params.get("sha"))?;
    let path = sanitize_explorer_path(params.get("path"))?;
    if path.is_empty() {
        return Err(GitError::message("git.commit_preview requires path"));
    }
    let spec = shell_quote(&format!("{sha}:{path}"));
    let size = js_number(git(context, &format!("cat-file -s {spec}")).await?.trim());
    let limit = if image_mime_for_path(&path).is_some() {
        PREVIEW_IMAGE_MAX_BYTES
    } else {
        PREVIEW_MAX_BYTES
    };
    let size = match size {
        Some(size) if size.is_finite() && size >= 0.0 => size,
        _ => return Err(GitError::message("invalid historical file size")),
    };
    if size > limit as f64 {
        return Ok(
            json!({ "path": path, "size": crate::js_num(size), "truncated": true, "text": null, "binary": false }),
        );
    }
    let encoded = git(context, &format!("cat-file blob {spec} | base64")).await?;
    let compact: String = encoded.split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .unwrap_or_default();
    let mut result = Map::new();
    result.insert("path".into(), json!(path));
    result.insert("size".into(), crate::js_num(size));
    result.insert("truncated".into(), json!(false));
    if let Value::Object(decoded) =
        serde_json::to_value(decode_preview_buffer(&bytes, false, &path)).unwrap()
    {
        result.extend(decoded);
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests;
