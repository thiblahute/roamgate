//! The workspaces that are a request's (`mr-reviews/links.ts`): on its
//! source branch in a clone of its project, named after it, or its review
//! workspace. Read from each connection's workspaces (Herdr) and one git
//! script per connection, kept a little while; no forge call.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::clones::{ProjectRef, remote_is_project};
use crate::connection::{BoxFuture, MrConnection, sh_quote};

/// A workspace as matched: where it is and what its checkout is on.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScannedWorkspace {
    pub connection_id: String,
    pub connection_label: String,
    pub workspace_id: String,
    pub label: String,
    /// The checkout's branch.
    pub branch: Option<String>,
    /// Its upstream ("origin/x").
    pub upstream: Option<String>,
    /// Its remote URLs.
    pub remotes: Vec<String>,
}

/// `workspaceScript`: for each directory, `W <dir>`, then `B <branch>`,
/// `U <upstream>` and `M <url>` per remote. Directories outside a
/// repository print only W.
pub fn workspace_script(dirs: &[String]) -> String {
    let quoted: Vec<String> = dirs.iter().map(|dir| sh_quote(dir)).collect();
    [
        format!("for d in {}; do", quoted.join(" ")),
        r#"  [ -d "$d" ] || continue"#.to_owned(),
        r#"  printf "W\t%s\n" "$d""#.to_owned(),
        r#"  b=$(git -C "$d" symbolic-ref --short -q HEAD 2>/dev/null) && printf "B\t%s\n" "$b""#.to_owned(),
        r#"  u=$(git -C "$d" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) && printf "U\t%s\n" "$u""#.to_owned(),
        r#"  git -C "$d" config --get-regexp '^remote\..*\.url$' 2>/dev/null | while read -r k v; do printf "M\t%s\n" "$v"; done"#.to_owned(),
        "done".to_owned(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// `ScannedDir`: a directory's checkout.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScannedDir {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub remotes: Vec<String>,
}

/// `parseWorkspaceScan`: by directory, in the order printed.
pub fn parse_workspace_scan(stdout: &str) -> Vec<(String, ScannedDir)> {
    let mut dirs: Vec<(String, ScannedDir)> = Vec::new();
    let mut current: Option<usize> = None;
    for line in stdout.split('\n') {
        let Some((kind, value)) = line.split_once('\t') else {
            continue;
        };
        if kind == "W" && value.starts_with('/') {
            // A directory printed again starts over, as a Map's set does.
            match dirs.iter().position(|(dir, _)| dir == value) {
                Some(at) => {
                    dirs[at].1 = ScannedDir::default();
                    current = Some(at);
                }
                None => {
                    dirs.push((value.to_owned(), ScannedDir::default()));
                    current = Some(dirs.len() - 1);
                }
            }
            continue;
        }
        let Some(at) = current else { continue };
        if value.is_empty() {
            continue;
        }
        let dir = &mut dirs[at].1;
        match kind {
            "B" => dir.branch = Some(value.to_owned()),
            "U" => dir.upstream = Some(value.to_owned()),
            "M" if !dir.remotes.iter().any(|remote| remote == value) => {
                dir.remotes.push(value.to_owned());
            }
            _ => {}
        }
    }
    dirs
}

/// The repository name of a project path ("group/sub/name" gives "name").
fn repo_name(project: &str) -> String {
    project.rsplit('/').next().unwrap_or("").to_lowercase()
}

static REMOTE_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?/?$").expect("pattern")
});

/// Whether a checkout's remotes are the request's project: one of them
/// is, or (a fork) one has the same repository name on the same host.
/// Unknown (no remote read) is not a match.
fn same_project(remotes: &[String], project: &ProjectRef) -> bool {
    if remotes.iter().any(|url| remote_is_project(url, project)) {
        return true;
    }
    let name = repo_name(&project.project);
    let host = project.host.to_lowercase();
    remotes.iter().any(|url| {
        let Some(found) = REMOTE_URL.captures(js::trim(url)) else {
            return false;
        };
        let url_host = found[1].to_lowercase();
        (url_host == host || url_host.ends_with(&format!(".{host}")))
            && repo_name(&found[2]) == name
    })
}

/// Where a request's review is, or its home.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceAt {
    pub connection_id: String,
    pub workspace_id: Option<String>,
}

/// `matchWorkspaces`: the workspaces that are the request's, each with
/// why (`MrWorkspaceLink`s): the home made for it, its checkout is on the
/// source branch (or tracks it) in a clone of the project, its name
/// carries the request's number or branch, or it is the request's review
/// workspace. A generic branch (the target's own name) never matches.
pub fn match_workspaces(
    item: &Obj,
    workspaces: &[ScannedWorkspace],
    review: Option<&WorkspaceAt>,
    home: Option<&WorkspaceAt>,
) -> Vec<Value> {
    let mut links: Vec<(String, Obj)> = Vec::new();
    let mut add = |workspace: &ScannedWorkspace, why: &str| {
        let id = format!("{}\n{}", workspace.connection_id, workspace.workspace_id);
        let at = match links.iter().position(|(key, _)| *key == id) {
            Some(at) => at,
            None => {
                let mut link = Obj::new();
                link.insert("connectionId".into(), json!(workspace.connection_id));
                link.insert("connectionLabel".into(), json!(workspace.connection_label));
                link.insert("workspaceId".into(), json!(workspace.workspace_id));
                link.insert("label".into(), json!(workspace.label));
                link.insert("why".into(), json!([]));
                links.push((id, link));
                links.len() - 1
            }
        };
        if let Some(Value::Array(whys)) = links[at].1.get_mut("why")
            && !whys.iter().any(|each| each == why)
        {
            whys.push(json!(why));
        }
    };
    let project = ProjectRef::of(item);
    let branch = js::sv(item.get("sourceBranch"));
    let usable = !branch.is_empty()
        && item.get("targetBranch").and_then(Value::as_str) != Some(branch)
        && branch != "main"
        && branch != "master";
    let mark = if project.provider == "gitlab" {
        "!"
    } else {
        "#"
    };
    let number = js::to_text(item.get("number").unwrap_or(&Value::Null));
    // `(?:!|\b(?:mr|pr)[-_ ]?)<n>(?!\d)`, JavaScript's ASCII `\b` and `\d`.
    let by_number = Regex::new(&format!(
        r"(?i)(?:{}|(?-u:\b)(?:mr|pr)[-_ ]?){}(?:[^0-9]|$)",
        regex::escape(mark),
        regex::escape(&number)
    ))
    .expect("pattern");
    for workspace in workspaces {
        let in_project = same_project(&workspace.remotes, &project);
        if let Some(home) = home
            && home.connection_id == workspace.connection_id
            && home.workspace_id.as_deref() == Some(workspace.workspace_id.as_str())
        {
            add(workspace, "home");
        }
        if let Some(review) = review
            && let Some(id) = review.workspace_id.as_deref().filter(|id| !id.is_empty())
            && review.connection_id == workspace.connection_id
            && id == workspace.workspace_id
        {
            add(workspace, "review");
        }
        if usable && in_project {
            let upstream = workspace
                .upstream
                .as_deref()
                .map(|upstream| match upstream.find('/') {
                    Some(at) => &upstream[at + 1..],
                    None => upstream,
                });
            if workspace.branch.as_deref() == Some(branch) || upstream == Some(branch) {
                add(workspace, "branch");
            }
        }
        // A name is only trusted in the project's clone, or outside any repository.
        if in_project || workspace.remotes.is_empty() {
            let label = &workspace.label;
            if by_number.is_match(label)
                || (usable && js::len16(branch) >= 4 && label.contains(branch))
            {
                add(workspace, "name");
            }
        }
    }
    let rank = |link: &Obj| -> u8 {
        let whys = link.get("why").and_then(Value::as_array);
        let has = |why: &str| whys.is_some_and(|whys| whys.iter().any(|each| each == why));
        if has("home") {
            0
        } else if has("branch") {
            1
        } else if has("name") {
            2
        } else {
            3
        }
    };
    let mut links: Vec<Obj> = links.into_iter().map(|(_, link)| link).collect();
    links.sort_by_key(|link| rank(link));
    links.into_iter().map(Value::Object).collect()
}

/// How long a connection's scan is reused.
pub const LINK_SCAN_MS: f64 = 60_000.0;

type Scan = Shared<BoxFuture<'static, Result<Arc<Vec<ScannedWorkspace>>, String>>>;

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Each connection's workspaces, scanned and kept LINK_SCAN_MS.
async fn scan_connection(
    connection: Arc<dyn MrConnection>,
) -> Result<Vec<ScannedWorkspace>, String> {
    // Herdr gives a workspace's checkout when it is one; its panes' folders
    // say where the work is otherwise.
    let listed = connection.herdr("workspace.list", Value::Null);
    let panes = connection.herdr("pane.list", Value::Null);
    let (listed, panes) = futures_util::future::join(listed, panes).await;
    let listed = listed?;
    let panes = panes.ok();
    let workspaces: Vec<&Value> = listed
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|each| each.get("workspace_id").is_some_and(Value::is_string))
        .collect();
    let mut dirs_of: Vec<(String, Vec<String>)> = Vec::new();
    let mut note = |id: Option<&str>, dir: Option<&str>| {
        let (Some(id), Some(dir)) = (id.filter(|id| !id.is_empty()), dir) else {
            return;
        };
        if !dir.starts_with('/') {
            return;
        }
        let at = match dirs_of.iter().position(|(each, _)| each == id) {
            Some(at) => at,
            None => {
                dirs_of.push((id.to_owned(), Vec::new()));
                dirs_of.len() - 1
            }
        };
        let list = &mut dirs_of[at].1;
        if !list.iter().any(|each| each == dir) && list.len() < 4 {
            list.push(dir.to_owned());
        }
    };
    for each in &workspaces {
        let id = text(each, "workspace_id");
        note(
            id,
            each.get("worktree")
                .and_then(|worktree| worktree.get("checkout_path"))
                .and_then(Value::as_str),
        );
        note(id, text(each, "cwd"));
    }
    for pane in panes
        .as_ref()
        .and_then(|panes| panes.get("panes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = text(pane, "workspace_id");
        note(id, text(pane, "foreground_cwd"));
        note(id, text(pane, "cwd"));
    }
    let mut dirs: Vec<String> = Vec::new();
    for (_, list) in &dirs_of {
        for dir in list {
            if !dirs.contains(dir) {
                dirs.push(dir.clone());
            }
        }
    }
    dirs.truncate(200);
    let scanned = if dirs.is_empty() {
        Vec::new()
    } else {
        parse_workspace_scan(
            &connection
                .run(&workspace_script(&dirs), 30_000)
                .await
                .stdout,
        )
    };
    // One entry per checkout of a workspace (matching merges them).
    let mut out = Vec::new();
    for each in workspaces {
        let workspace_id = js::sv(each.get("workspace_id")).to_owned();
        let base = ScannedWorkspace {
            connection_id: connection.id().to_owned(),
            connection_label: connection.label().to_owned(),
            workspace_id: workspace_id.clone(),
            label: text(each, "label").unwrap_or("").to_owned(),
            ..ScannedWorkspace::default()
        };
        let found: Vec<&ScannedDir> = dirs_of
            .iter()
            .find(|(id, _)| *id == workspace_id)
            .map(|(_, list)| list.as_slice())
            .unwrap_or_default()
            .iter()
            .filter_map(|dir| {
                scanned
                    .iter()
                    .find(|(each, _)| each == dir)
                    .map(|(_, checkout)| checkout)
            })
            .filter(|checkout| !checkout.remotes.is_empty() || checkout.branch.is_some())
            .collect();
        if found.is_empty() {
            out.push(base);
            continue;
        }
        for checkout in found {
            out.push(ScannedWorkspace {
                branch: checkout.branch.clone(),
                upstream: checkout.upstream.clone(),
                remotes: checkout.remotes.clone(),
                ..base.clone()
            });
        }
    }
    Ok(out)
}

/// `createWorkspaceLinker`: each connection's workspaces, scanned and kept
/// LINK_SCAN_MS (one scan shared by the lookups that ask while it runs).
pub struct WorkspaceLinker {
    pub connections: Arc<dyn Fn() -> Vec<Arc<dyn MrConnection>> + Send + Sync>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    scans: Mutex<HashMap<String, (u64, f64, Scan)>>,
    serial: Mutex<u64>,
}

impl WorkspaceLinker {
    pub fn new(connections: Arc<dyn Fn() -> Vec<Arc<dyn MrConnection>> + Send + Sync>) -> Self {
        WorkspaceLinker {
            connections,
            now: Arc::new(js::now_ms),
            scans: Mutex::new(HashMap::new()),
            serial: Mutex::new(0),
        }
    }

    async fn scan(
        &self,
        connection: &Arc<dyn MrConnection>,
    ) -> Result<Arc<Vec<ScannedWorkspace>>, String> {
        let (serial, scan) = {
            let mut scans = self.scans.lock().unwrap_or_else(|e| e.into_inner());
            let now = (self.now)();
            match scans.get(connection.id()) {
                Some((serial, at, scan)) if now - at < LINK_SCAN_MS => (*serial, scan.clone()),
                _ => {
                    let serial = {
                        let mut next = self.serial.lock().unwrap_or_else(|e| e.into_inner());
                        *next += 1;
                        *next
                    };
                    let scan: Scan = scan_connection(Arc::clone(connection))
                        .map(|result| result.map(Arc::new))
                        .boxed()
                        .shared();
                    scans.insert(connection.id().to_owned(), (serial, now, scan.clone()));
                    (serial, scan)
                }
            }
        };
        let result = scan.await;
        if result.is_err() {
            // A scan that failed is not kept.
            let mut scans = self.scans.lock().unwrap_or_else(|e| e.into_inner());
            if scans
                .get(connection.id())
                .is_some_and(|(kept, _, _)| *kept == serial)
            {
                scans.remove(connection.id());
            }
        }
        result
    }

    /// The linked workspaces of each request (`MrWorkspaceLink`s), by key:
    /// `reviews` and `homes` by request key.
    pub async fn links(
        &self,
        items: &[Obj],
        reviews: &HashMap<String, WorkspaceAt>,
        homes: &HashMap<String, WorkspaceAt>,
    ) -> Obj {
        let mut all: Vec<ScannedWorkspace> = Vec::new();
        for connection in (self.connections)() {
            // A connection that does not answer has no link to give.
            if let Ok(found) = self.scan(&connection).await {
                all.extend(found.iter().cloned());
            }
        }
        let mut out = Obj::new();
        for item in items {
            let key = js::sv(item.get("key"));
            let found = match_workspaces(item, &all, reviews.get(key), homes.get(key));
            if !found.is_empty() {
                out.insert(key.to_owned(), Value::Array(found));
            }
        }
        out
    }

    pub fn forget(&self) {
        self.scans.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    //! `links.test.ts`.

    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::connection::ShellResult;

    fn item() -> Obj {
        let Value::Object(item) = json!({
            "key": "gitlab:gitlab.example.org/group/app#12",
            "host": "gitlab.example.org",
            "project": "group/app",
            "provider": "gitlab",
            "number": 12,
            "sourceBranch": "fix-pitch",
            "targetBranch": "main",
        }) else {
            unreachable!()
        };
        item
    }

    fn ws(workspace_id: &str) -> ScannedWorkspace {
        ScannedWorkspace {
            connection_id: "local".into(),
            connection_label: "Desktop".into(),
            workspace_id: workspace_id.into(),
            label: "work".into(),
            remotes: vec!["git@gitlab.example.org:group/app.git".into()],
            ..ScannedWorkspace::default()
        }
    }

    fn with_branch(mut workspace: ScannedWorkspace, branch: &str) -> ScannedWorkspace {
        workspace.branch = Some(branch.into());
        workspace
    }

    fn labelled(mut workspace: ScannedWorkspace, label: &str) -> ScannedWorkspace {
        workspace.label = label.into();
        workspace
    }

    fn at(workspace_id: &str) -> WorkspaceAt {
        WorkspaceAt {
            connection_id: "local".into(),
            workspace_id: Some(workspace_id.into()),
        }
    }

    fn whys(links: &[Value]) -> Vec<(String, Vec<String>)> {
        links
            .iter()
            .map(|link| {
                (
                    link["workspaceId"].as_str().unwrap().to_owned(),
                    link["why"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|why| why.as_str().unwrap().to_owned())
                        .collect(),
                )
            })
            .collect()
    }

    fn want(pairs: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
        pairs
            .iter()
            .map(|(id, whys)| {
                (
                    (*id).to_owned(),
                    whys.iter().map(|w| (*w).to_owned()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn its_home_first_whatever_its_name_or_branch_the_shared_review_workspace_last() {
        let links = match_workspaces(
            &item(),
            &[
                labelled(ws("review"), "Reviews \u{b7} app"),
                with_branch(ws("a"), "fix-pitch"),
                with_branch(labelled(ws("made"), "renamed by hand"), "x"),
            ],
            Some(&at("review")),
            Some(&at("made")),
        );
        assert_eq!(
            whys(&links),
            want(&[
                ("made", &["home"]),
                ("a", &["branch"]),
                ("review", &["review"])
            ])
        );
        assert_eq!(
            Value::Object(links[0].as_object().unwrap().clone()),
            json!({"connectionId": "local", "connectionLabel": "Desktop", "workspaceId": "made", "label": "renamed by hand", "why": ["home"]})
        );
    }

    #[test]
    fn on_its_branch_in_a_clone_of_the_project_or_tracking_it() {
        let mut b = with_branch(ws("b"), "local-name");
        b.upstream = Some("me/fix-pitch".into());
        let mut c = with_branch(ws("c"), "fix-pitch");
        // Same branch name in another project: not it.
        c.remotes = vec!["https://github.com/other/thing.git".into()];
        // A fork of the project, by its repository name on the same host.
        let mut d = with_branch(ws("d"), "fix-pitch");
        d.connection_id = "mac".into();
        d.connection_label = "Mac".into();
        d.remotes = vec!["https://gitlab.example.org/me/app.git".into()];
        let links = match_workspaces(
            &item(),
            &[
                with_branch(ws("a"), "fix-pitch"),
                b,
                c,
                d,
                with_branch(ws("e"), "main"),
            ],
            None,
            None,
        );
        assert_eq!(
            whys(&links),
            want(&[("a", &["branch"]), ("b", &["branch"]), ("d", &["branch"])])
        );
        assert_eq!(links[2]["connectionLabel"], "Mac");
    }

    #[test]
    fn by_its_name_its_review_workspace_the_target_branch_never() {
        let mut main = item();
        main.insert("sourceBranch".into(), json!("main"));
        let mut c = labelled(ws("c"), "mr-12 scratch");
        c.remotes = Vec::new();
        let mut x = labelled(ws("x"), "!12 elsewhere");
        x.remotes = vec!["https://github.com/other/thing.git".into()];
        let links = match_workspaces(
            &main,
            &[
                with_branch(labelled(ws("a"), "app !12 pitch"), "main"),
                labelled(ws("b"), "app !123"),
                c,
                labelled(ws("r"), "Reviews \u{b7} app"),
                x,
            ],
            Some(&at("r")),
            None,
        );
        assert_eq!(
            whys(&links),
            want(&[("a", &["name"]), ("c", &["name"]), ("r", &["review"])])
        );
    }

    #[test]
    fn none_nothing() {
        assert!(
            match_workspaces(&item(), &[with_branch(ws("w1"), "other")], None, None).is_empty()
        );
    }

    #[test]
    fn the_script_and_its_parse() {
        assert!(workspace_script(&["/a b".into()]).contains("'/a b'"));
        let scan = parse_workspace_scan(
            "W\t/r/app\nB\tfix-pitch\nU\torigin/fix-pitch\nM\tgit@h:g/app.git\nW\t/tmp\n",
        );
        assert_eq!(
            scan,
            vec![
                (
                    "/r/app".to_owned(),
                    ScannedDir {
                        branch: Some("fix-pitch".into()),
                        upstream: Some("origin/fix-pitch".into()),
                        remotes: vec!["git@h:g/app.git".into()],
                    }
                ),
                ("/tmp".to_owned(), ScannedDir::default()),
            ]
        );
    }

    struct Fake {
        id: String,
        label: String,
        broken: bool,
        runs: Arc<Mutex<Vec<String>>>,
    }

    impl MrConnection for Fake {
        fn id(&self) -> &str {
            &self.id
        }
        fn label(&self) -> &str {
            &self.label
        }
        fn run<'a>(&'a self, _script: &'a str, _timeout_ms: u64) -> BoxFuture<'a, ShellResult> {
            self.runs.lock().unwrap().push(self.id.clone());
            let id = &self.id;
            let stdout =
                format!("W\t/{id}/app\nB\tfix-pitch\nM\thttps://gitlab.example.org/group/app\n");
            Box::pin(async move {
                ShellResult {
                    code: 0,
                    stdout,
                    stderr: String::new(),
                }
            })
        }
        fn herdr<'a>(
            &'a self,
            method: &'a str,
            _params: Value,
        ) -> BoxFuture<'a, Result<Value, String>> {
            let id = &self.id;
            let answer = if self.broken {
                Err("gone".to_owned())
            } else if method == "pane.list" {
                // The Mac's workspace is no checkout itself: its pane's folder is.
                Ok(
                    json!({"panes": [{"workspace_id": format!("{id}-w"), "cwd": format!("/{id}/app")}]}),
                )
            } else {
                let mut workspace = json!({"workspace_id": format!("{id}-w"), "label": "pitch"});
                if id != "mac" {
                    workspace["worktree"] = json!({"checkout_path": format!("/{id}/app")});
                }
                Ok(json!({"workspaces": [workspace]}))
            };
            Box::pin(async move { answer })
        }
    }

    #[tokio::test]
    async fn every_connection_its_workspaces_read_once_a_minute() {
        let now = Arc::new(AtomicU64::new(0));
        let runs = Arc::new(Mutex::new(Vec::new()));
        let fake = |id: &str, label: &str, broken: bool| -> Arc<dyn MrConnection> {
            Arc::new(Fake {
                id: id.into(),
                label: label.into(),
                broken,
                runs: Arc::clone(&runs),
            })
        };
        let connections = vec![
            fake("local", "Desktop", false),
            fake("down", "Down", true),
            fake("mac", "Mac", false),
        ];
        let mut linker = WorkspaceLinker::new(Arc::new(move || connections.clone()));
        let clock = Arc::clone(&now);
        linker.now = Arc::new(move || clock.load(Ordering::SeqCst) as f64);
        let mut full = item();
        for (key, value) in [
            ("url", json!("u")),
            ("title", json!("t")),
            ("author", json!("me")),
            ("draft", json!(false)),
            ("state", json!("open")),
            ("updatedAt", json!("")),
            ("headSha", json!("")),
            ("pipeline", Value::Null),
            ("notes", json!(0)),
            ("reasons", json!([])),
        ] {
            full.insert(key.into(), value);
        }
        let key = js::sv(full.get("key")).to_owned();
        let items = vec![full];
        let none = HashMap::new();
        let links = linker.links(&items, &none, &none).await;
        let ids: Vec<&str> = links[&key]
            .as_array()
            .unwrap()
            .iter()
            .map(|link| link["workspaceId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["local-w", "mac-w"]);
        linker.links(&items, &none, &none).await;
        assert_eq!(*runs.lock().unwrap(), vec!["local", "mac"]);
        now.fetch_add(61_000, Ordering::SeqCst);
        linker.links(&items, &none, &none).await;
        assert_eq!(*runs.lock().unwrap(), vec!["local", "mac", "local", "mac"]);
    }
}
