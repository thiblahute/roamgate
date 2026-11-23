//! What a git remote URL names on a forge (`remoteProject` and
//! `onGitlabHost` of review/gitlab.ts): its host and project path, for the
//! MR reviews' clones, links and upstream tracking and the review's forge
//! lookups alike.

use std::sync::LazyLock;

use regex::Regex;

static FULL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:ssh|git\+ssh|https?)://(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?/(.+)$")
        .expect("pattern")
});
// scp-like `user@host:path`; the path may not start with `//` (checked
// apart: the colon is the first after the host whatever the user part).
static SCP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[^@/:]+@)?([^/:]+):(.+)$").expect("pattern"));
static WINDOWS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z]:[\\/]").expect("pattern"));

/// A remote's forge host (lower case) and project path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteProject {
    pub host: String,
    pub project: String,
}

/// `remoteProject`: the host and project of an ssh, https or scp-like
/// remote URL; None for a local path, a Windows path, a home-relative
/// project or a path of one part.
pub fn remote_project(url: &str) -> Option<RemoteProject> {
    let (host, path) = if let Some(full) = FULL.captures(url) {
        (full[1].to_owned(), full[2].to_owned())
    } else {
        let scp = SCP.captures(url)?;
        if scp[2].starts_with("//") || WINDOWS.is_match(url) {
            return None;
        }
        (scp[1].to_owned(), scp[2].to_owned())
    };
    let project = path.trim_start_matches('/').trim_end_matches('/');
    let project = project.strip_suffix(".git").unwrap_or(project);
    if !project.contains('/') || project.starts_with('~') {
        return None;
    }
    Some(RemoteProject {
        host: host.to_lowercase(),
        project: project.to_owned(),
    })
}

/// `onGitlabHost`: whether a remote is on that GitLab host; GitLab often
/// serves SSH on `ssh.<host>`.
pub fn on_gitlab_host(remote_host: &str, gitlab_host: &str) -> bool {
    remote_host == gitlab_host || remote_host == format!("ssh.{gitlab_host}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rp(url: &str) -> Option<(String, String)> {
        remote_project(url).map(|r| (r.host, r.project))
    }

    #[test]
    fn remote_urls_name_their_host_and_project() {
        let want = |h: &str, p: &str| Some((h.to_owned(), p.to_owned()));
        assert_eq!(
            rp("git@gitlab.example.org:group/app.git"),
            want("gitlab.example.org", "group/app")
        );
        assert_eq!(
            rp("https://GitHub.com/me/engine.git/"),
            want("github.com", "me/engine")
        );
        assert_eq!(
            rp("ssh://git@ssh.gitlab.example.org:2222/group/sub/app.git"),
            want("ssh.gitlab.example.org", "group/sub/app")
        );
        assert_eq!(rp("https://h/one"), None);
        assert_eq!(rp("git@h:~me/app.git"), None);
        assert_eq!(rp("C:\\src\\app"), None);
        assert_eq!(rp("/srv/git/app.git"), None);
        assert_eq!(rp("host://x/y"), None);
        assert!(on_gitlab_host("ssh.gitlab.com", "gitlab.com"));
        assert!(!on_gitlab_host("gitlab.com.evil", "gitlab.com"));
    }
}
