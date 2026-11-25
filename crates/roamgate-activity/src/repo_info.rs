//! What the activity log keeps of a workspace's repository (server/src/
//! activity/repo-info.ts): its root (the main checkout for a linked
//! worktree), the branch checked out and the URL of its remote. Read with
//! git on the connection's host, a few paths per command, never modifying
//! anything (contract/assets/sh/repo-info-block.sh).

use std::collections::HashMap;

use roamgate_base::assets::{REPO_INFO_BLOCK_SH, TemplateValue, fill_template};

use crate::BoxFuture;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// None when git cannot tell: a linked worktree whose repository keeps
    /// its git directory apart (`repo.git`); Herdr's root then stands.
    pub root: Option<String>,
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    pub is_worktree: bool,
}

/// A script's exit code and output.
#[derive(Debug, Clone, Default)]
pub struct ScriptOutput {
    pub code: i32,
    pub stdout: String,
}

/// Runs a POSIX shell script on a connection's host.
pub trait RunHostScript: Send + Sync {
    fn run(&self, connection_id: &str, script: &str) -> BoxFuture<Result<ScriptOutput, String>>;
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// The script reading `paths`; its output is parsed by [`parse_repo_info`].
pub fn repo_info_script(paths: &[String], marker: &str) -> String {
    let mut lines = vec!["export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0".to_owned()];
    for (index, path) in paths.iter().enumerate() {
        lines.push(
            fill_template(
                REPO_INFO_BLOCK_SH,
                &[
                    ("path", TemplateValue::Text(sh_quote(path))),
                    ("marker", TemplateValue::Text(marker.to_owned())),
                    ("index", TemplateValue::Number(index as f64)),
                ],
            )
            .expect("the repo-info template takes path, marker and index"),
        );
    }
    lines.join("\n")
}

/// A remote URL without credentials (`cleanRemoteUrl`): an http(s) URL's
/// user and password are dropped (a token can sit there), another scheme's
/// password; scp-style `user@host:path` is kept.
pub fn clean_remote_url(value: &str) -> Option<String> {
    let url = roamgate_base::settings::js_trim(value);
    if url.is_empty() || url.encode_utf16().count() > 2048 {
        return None;
    }
    let scheme = regex::Regex::new(r"(?i)^[a-z][a-z0-9+.-]*://").expect("valid regex");
    if scheme.is_match(url) {
        let mut parsed = url::Url::parse(url).ok()?;
        if parsed.scheme() == "http" || parsed.scheme() == "https" {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
        } else {
            let _ = parsed.set_password(None);
        }
        return Some(parsed.to_string());
    }
    Some(url.to_owned())
}

fn dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(index) if index > 0 => trimmed[..index].to_owned(),
        _ => "/".to_owned(),
    }
}

/// The script's output, by path; None for a path that is no repository.
pub fn parse_repo_info(
    output: &str,
    paths: &[String],
    marker: &str,
) -> HashMap<String, Option<RepoInfo>> {
    let mut result = HashMap::new();
    let begin = format!("{marker} begin ");
    let end = format!("{marker} end ");
    let mut index: Option<f64> = None;
    let mut fields: HashMap<String, String> = HashMap::new();
    let common_git = regex::Regex::new(r"/\.git/?$").expect("valid regex");
    for line in output.split('\n') {
        if let Some(rest) = line.strip_prefix(&begin) {
            // Number(): a malformed index is NaN, which names no path.
            let rest = roamgate_base::settings::js_trim(rest);
            index = Some(if rest.is_empty() {
                0.0
            } else {
                rest.parse::<f64>().unwrap_or(f64::NAN)
            });
            fields = HashMap::new();
            continue;
        }
        if line.starts_with(&end) {
            let path = index
                .filter(|value| value.fract() == 0.0 && *value >= 0.0)
                .and_then(|value| paths.get(value as usize));
            if let Some(path) = path {
                match fields.get("top").filter(|top| !top.is_empty()) {
                    None => {
                        result.insert(path.clone(), None);
                    }
                    Some(top) => {
                        let common = fields.get("common").filter(|v| !v.is_empty()).cloned();
                        let git_dir = fields.get("gitdir").filter(|v| !v.is_empty()).cloned();
                        let is_worktree =
                            matches!((&common, &git_dir), (Some(c), Some(g)) if c != g);
                        let root = if !is_worktree {
                            Some(top.clone())
                        } else {
                            common
                                .as_deref()
                                .filter(|common| common_git.is_match(common))
                                .map(dirname)
                        };
                        result.insert(
                            path.clone(),
                            Some(RepoInfo {
                                root,
                                branch: fields.get("branch").filter(|v| !v.is_empty()).cloned(),
                                remote_url: clean_remote_url(
                                    fields.get("remote").map_or("", String::as_str),
                                ),
                                is_worktree,
                            }),
                        );
                    }
                }
            }
            index = None;
            continue;
        }
        if index.is_none() {
            continue;
        }
        let (key, value) = match line.find(' ') {
            Some(space) => (&line[..space], &line[space + 1..]),
            None => (line, ""),
        };
        if ["top", "common", "gitdir", "branch", "remote"].contains(&key) {
            fields.insert(key.to_owned(), value.to_owned());
        }
    }
    result
}

/// Reads `paths` on a connection's host; None for one that is no repository.
pub async fn read_repo_info(
    run: &dyn RunHostScript,
    connection_id: &str,
    paths: &[String],
) -> Result<HashMap<String, Option<RepoInfo>>, String> {
    if paths.is_empty() {
        return Ok(HashMap::new());
    }
    let marker = format!(
        "__ROAMGATE_REPO_{}__",
        hex::encode(rand::random::<[u8; 4]>())
    );
    let output = run
        .run(connection_id, &repo_info_script(paths, &marker))
        .await?;
    if output.code != 0 {
        return Err(format!("repository read exited {}", output.code));
    }
    Ok(parse_repo_info(&output.stdout, paths, &marker))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    struct Shell;
    impl RunHostScript for Shell {
        fn run(&self, _connection: &str, script: &str) -> BoxFuture<Result<ScriptOutput, String>> {
            let script = script.to_owned();
            Box::pin(async move {
                let shell = roamgate_base::posix_shell::posix_shell()?;
                let output = Command::new(shell)
                    .arg("-c")
                    .arg(script)
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .output()
                    .map_err(|error| error.to_string())?;
                Ok(ScriptOutput {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                })
            })
        }
    }

    /// A real directory, named as git names it (with `/` on Windows too).
    fn base() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = roamgate_base::paths::realpath(dir.path())
            .unwrap()
            .display()
            .to_string();
        let path = if cfg!(windows) {
            path.replace('\\', "/")
        } else {
            path
        };
        (dir, path)
    }

    fn info(
        root: Option<&str>,
        branch: Option<&str>,
        remote: Option<&str>,
        worktree: bool,
    ) -> Option<RepoInfo> {
        Some(RepoInfo {
            root: root.map(str::to_owned),
            branch: branch.map(str::to_owned),
            remote_url: remote.map(str::to_owned),
            is_worktree: worktree,
        })
    }

    #[tokio::test]
    async fn reads_root_branch_and_remote_of_checkouts_and_linked_worktrees() {
        let (_dir, base) = base();
        let main = format!("{base}/gstreamer");
        git(Path::new(&base), &["init", "-q", "-b", "main", &main]);
        git(
            Path::new(&main),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        git(
            Path::new(&main),
            &[
                "remote",
                "add",
                "origin",
                "https://user:secret@gitlab.example.com/gst/gstreamer.git",
            ],
        );
        let linked = format!("{base}/gstreamer-ocio");
        git(
            Path::new(&main),
            &["worktree", "add", "-q", "-b", "ocio", &linked],
        );
        let plain = format!("{base}/notes");
        std::fs::create_dir(&plain).unwrap();
        let missing = format!("{base}/missing it's");
        let paths = vec![main.clone(), linked.clone(), plain.clone(), missing.clone()];
        let found = read_repo_info(&Shell, "local", &paths).await.unwrap();
        let remote = Some("https://gitlab.example.com/gst/gstreamer.git");
        assert_eq!(found[&main], info(Some(&main), Some("main"), remote, false));
        assert_eq!(
            found[&linked],
            info(Some(&main), Some("ocio"), remote, true)
        );
        assert_eq!(found[&plain], None);
        assert_eq!(found[&missing], None);
    }

    #[tokio::test]
    async fn a_worktree_of_a_repository_with_its_git_directory_apart_keeps_no_root() {
        let (_dir, base) = base();
        let main = format!("{base}/gstreamer");
        let separate = format!("{base}/gstreamer.git");
        git(
            Path::new(&base),
            &[
                "init",
                "-q",
                "-b",
                "main",
                "--separate-git-dir",
                &separate,
                &main,
            ],
        );
        git(
            Path::new(&main),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        let linked = format!("{base}/ocio");
        git(
            Path::new(&main),
            &["worktree", "add", "-q", "-b", "ocio", &linked],
        );
        let found = read_repo_info(&Shell, "local", &[main.clone(), linked.clone()])
            .await
            .unwrap();
        assert_eq!(
            found[&main].as_ref().unwrap().root.as_deref(),
            Some(main.as_str())
        );
        let worktree = found[&linked].as_ref().unwrap();
        assert_eq!(worktree.root, None);
        assert_eq!(worktree.branch.as_deref(), Some("ocio"));
        assert!(worktree.is_worktree);
    }

    #[tokio::test]
    async fn a_detached_head_has_no_branch_no_remote_is_null() {
        let (_dir, base) = base();
        git(Path::new(&base), &["init", "-q", "-b", "main", "."]);
        git(
            Path::new(&base),
            &["commit", "-q", "--allow-empty", "-m", "first"],
        );
        git(Path::new(&base), &["checkout", "-q", "--detach"]);
        let found = read_repo_info(&Shell, "local", std::slice::from_ref(&base))
            .await
            .unwrap();
        assert_eq!(found[&base], info(Some(&base), None, None, false));
    }

    #[test]
    fn credentials_never_leave_a_remote_url() {
        assert_eq!(
            clean_remote_url("https://oauth2:tok@github.com/a/b").as_deref(),
            Some("https://github.com/a/b")
        );
        assert_eq!(
            clean_remote_url("ssh://git:pw@host:22/a/b.git").as_deref(),
            Some("ssh://git@host:22/a/b.git")
        );
        assert_eq!(
            clean_remote_url("git@gitlab.freedesktop.org:gstreamer/gstreamer").as_deref(),
            Some("git@gitlab.freedesktop.org:gstreamer/gstreamer")
        );
        assert_eq!(clean_remote_url(""), None);
    }

    #[test]
    fn output_for_unknown_indexes_or_without_markers_is_ignored() {
        let parsed = parse_repo_info(
            "top /x\nM begin 5\ntop /y\nM end 5\n",
            &["/a".to_owned()],
            "M",
        );
        assert!(parsed.is_empty());
    }
}
