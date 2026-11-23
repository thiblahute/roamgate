//! The user's own clones of a project (`mr-reviews/clones.ts`), found
//! among the directories their workspaces and panes are in: one script per
//! connection reads each directory's repository, its main checkout and its
//! remotes. Read only. The connection itself is [`crate::connection`].

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_agents::js;
use roamgate_forge::remote::{on_gitlab_host, remote_project};

use crate::connection::{BoxFuture, MrConnection, sh_quote};

/// A project on a forge host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRef {
    pub host: String,
    pub project: String,
    /// `gitlab` or `github`.
    pub provider: String,
}

impl ProjectRef {
    /// A request's project.
    pub fn of(item: &roamgate_agents::js::Obj) -> ProjectRef {
        use roamgate_agents::js;
        ProjectRef {
            host: js::sv(item.get("host")).to_owned(),
            project: js::sv(item.get("project")).to_owned(),
            provider: js::sv(item.get("provider")).to_owned(),
        }
    }
}

/// `FoundClone`: a clone of a project on a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundClone {
    pub connection_id: String,
    /// The main checkout (not a linked worktree).
    pub path: String,
    /// The remote that is the project.
    pub remote: String,
}

/// A remote of a scanned repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// `ScannedRepo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScannedRepo {
    pub path: String,
    pub remotes: Vec<Remote>,
}

/// `clonesScript`: for each directory, `R <main checkout>` then
/// `M <name> <url>` per fetch remote. Directories outside a repository
/// print nothing.
pub fn clones_script(dirs: &[String]) -> String {
    let quoted: Vec<String> = dirs.iter().map(|dir| sh_quote(dir)).collect();
    [
        format!("for d in {}; do", quoted.join(" ")),
        r#"  [ -d "$d" ] || continue"#.into(),
        // The main checkout, whatever the layout (a .git directory, or a
        // repository directory such as gstreamer.git with linked worktrees).
        r#"  m=$(git -C "$d" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"#
            .into(),
        r#"  [ -n "$m" ] || continue"#.into(),
        r#"  printf "R\t%s\n" "$m""#.into(),
        // The configured URLs, as written (`remote -v` applies insteadOf).
        r#"  git -C "$m" config --get-regexp '^remote\..*\.url$' 2>/dev/null | while read -r k u; do n=${k#remote.}; printf "M\t%s\t%s\n" "${n%.url}" "$u"; done"#
            .into(),
        "done".into(),
        "exit 0".into(),
    ]
    .join("\n")
}

/// `parseClones`.
pub fn parse_clones(stdout: &str) -> Vec<ScannedRepo> {
    let mut repos: Vec<ScannedRepo> = Vec::new();
    let mut current: Option<usize> = None;
    for line in stdout.split('\n') {
        let mut parts = line.split('\t');
        let kind = parts.next().unwrap_or("");
        let a = parts.next();
        let b = parts.next();
        match (kind, a) {
            ("R", Some(a)) if a.starts_with('/') => {
                let at = match repos.iter().position(|repo| repo.path == a) {
                    Some(at) => at,
                    None => {
                        repos.push(ScannedRepo {
                            path: a.to_owned(),
                            remotes: Vec::new(),
                        });
                        repos.len() - 1
                    }
                };
                current = Some(at);
            }
            ("M", Some(a)) if !a.is_empty() => {
                let (Some(at), Some(b)) = (current, b.filter(|b| !b.is_empty())) else {
                    continue;
                };
                let repo = &mut repos[at];
                if !repo.remotes.iter().any(|remote| remote.name == a) {
                    repo.remotes.push(Remote {
                        name: a.to_owned(),
                        url: b.to_owned(),
                    });
                }
            }
            _ => {}
        }
    }
    repos
}

/// `remoteIsProject`: whether a remote URL is the project on its forge
/// host.
pub fn remote_is_project(url: &str, project: &ProjectRef) -> bool {
    let Some(remote) = remote_project(url) else {
        return false;
    };
    let host = project.host.to_lowercase();
    let on_host = if project.provider == "gitlab" {
        on_gitlab_host(&remote.host, &host)
    } else {
        remote.host == host || remote.host == format!("ssh.{host}")
    };
    on_host && remote.project.to_lowercase() == project.project.to_lowercase()
}

static REVIEW_WORKTREE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.worktrees/review$").expect("pattern"));

/// `matchClones`: the clones of one project among scanned repositories.
pub fn match_clones(
    connection_id: &str,
    repos: &[ScannedRepo],
    project: &ProjectRef,
) -> Vec<FoundClone> {
    repos
        .iter()
        .filter_map(|repo| {
            // A review worktree's own repository is its clone's: never a clone.
            if REVIEW_WORKTREE.is_match(&repo.path) {
                return None;
            }
            let remote = repo
                .remotes
                .iter()
                .find(|remote| remote_is_project(&remote.url, project))?;
            Some(FoundClone {
                connection_id: connection_id.to_owned(),
                path: repo.path.clone(),
                remote: remote.name.clone(),
            })
        })
        .collect()
}

/// How long a connection's scan is reused.
pub const SCAN_TTL_MS: f64 = 10.0 * 60_000.0;

type Scan = Shared<BoxFuture<'static, Arc<Vec<ScannedRepo>>>>;

/// `createCloneFinder`: clone lookups, the scans cached per connection
/// (one scan shared by the lookups that ask while it runs).
pub struct CloneFinder {
    scans: Mutex<HashMap<String, (f64, Scan)>>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl Default for CloneFinder {
    fn default() -> Self {
        CloneFinder {
            scans: Mutex::new(HashMap::new()),
            now: Arc::new(js::now_ms),
        }
    }
}

impl CloneFinder {
    pub fn new() -> CloneFinder {
        CloneFinder::default()
    }

    fn scan(&self, connection: &Arc<dyn MrConnection>) -> Scan {
        let mut scans = self.scans.lock().unwrap_or_else(|e| e.into_inner());
        let now = (self.now)();
        if let Some((at, scan)) = scans.get(connection.id())
            && now - at < SCAN_TTL_MS
        {
            return scan.clone();
        }
        let id = connection.id().to_owned();
        let connection = Arc::clone(connection);
        let scan: Scan = async move {
            let mut dirs: Vec<String> = Vec::new();
            for dir in connection.dirs().await {
                if dir.starts_with('/') && !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
            dirs.truncate(200);
            if dirs.is_empty() {
                return Arc::new(Vec::new());
            }
            let result = connection.run(&clones_script(&dirs), 30_000).await;
            Arc::new(parse_clones(&result.stdout))
        }
        .boxed()
        .shared();
        scans.insert(id, (now, scan.clone()));
        scan
    }

    /// Every clone of the project on the connections, in their order.
    pub async fn find(
        &self,
        connections: &[Arc<dyn MrConnection>],
        project: &ProjectRef,
    ) -> Vec<FoundClone> {
        let mut found = Vec::new();
        for connection in connections {
            let repos = self.scan(connection).await;
            found.extend(match_clones(connection.id(), &repos, project));
        }
        found
    }

    /// Checks a path the user gave: a clone of the project there.
    pub async fn check(
        &self,
        connection: &dyn MrConnection,
        path: &str,
        project: &ProjectRef,
    ) -> Option<FoundClone> {
        let result = connection
            .run(&clones_script(&[path.to_owned()]), 30_000)
            .await;
        match_clones(connection.id(), &parse_clones(&result.stdout), project)
            .into_iter()
            .next()
    }

    /// Forgets one connection's scan, or every scan.
    pub fn forget(&self, connection_id: Option<&str>) {
        let mut scans = self.scans.lock().unwrap_or_else(|e| e.into_inner());
        match connection_id {
            Some(id) => {
                scans.remove(id);
            }
            None => scans.clear(),
        }
    }

    /// `key`: a project's key (`mrProjectKey`).
    pub fn key(host: &str, project: &str) -> String {
        crate::shared::types::project_key(host, project)
    }
}

/// `orderConnections`: the order a project's clone is looked for in, and
/// its review worktree made: the default connection, then this machine,
/// then the others. Entries are `(is_default, remote, connection)`.
pub fn order_connections<T>(entries: Vec<(bool, bool, T)>) -> Vec<T> {
    let mut entries = entries;
    entries.sort_by_key(|(is_default, remote, _)| {
        if *is_default {
            0
        } else if *remote {
            2
        } else {
            1
        }
    });
    entries
        .into_iter()
        .map(|(_, _, connection)| connection)
        .collect()
}
