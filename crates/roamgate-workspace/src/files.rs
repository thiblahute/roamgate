//! The file explorer and Changes' Git of a connection (workspace/files.ts
//! `createFileHandlers`, with index.ts's dispatch of their RPCs and of
//! `/api/file/download`, `/upload` and `/delete`).
//!
//! [`Files`] holds what the TS closure held across calls (the last-step
//! store, the hosts' homes, the not-a-repository cache); each call takes
//! the connection it runs on. A Windows host is refused here, as
//! `unixOnlyHandlers` did.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::env::{Env, ProcessEnv};
use roamgate_git::actions::{ActionContext, run_git_file_action, run_git_repo_action};
use roamgate_git::diff::{
    FilesArgs, SummaryArgs, pull_git, read_diff_file, read_diff_files, read_diff_summary,
};
use roamgate_git::history::{
    HistoryContext, list_commits, read_commit, read_commit_file, read_commit_preview,
};
use roamgate_git::ignore::{NotARepoCache, collect_ignored_names};
use roamgate_git::preview::{inline_preview_mime_for_path, is_html_path};
use roamgate_git::steps::LastStepStore;
use roamgate_git::{Invocation, shell_quote};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::connection::{RpcResult, WorkspaceConnection, WorkspaceError};
use crate::file_download::{FileDownloadOptions, download_content_type_for_path};
use crate::file_manager::{FileRevealResult, RevealOptions, can_reveal_files, reveal_local_path};
use crate::file_paths::{
    checkout_path, download_content_disposition, encode_uri_component, inline_content_disposition,
    sanitize_explorer_path, sanitize_filesystem_path, sanitize_mutation_path,
    sanitize_preview_path, sanitize_upload_filename,
};
use crate::file_types::{FileBody, FileResolution};
use crate::html_preview::HTML_PREVIEW_CSP;
use crate::html_preview_files::render_html_preview_file;
use crate::local_files::{self, DownloadFailure};
use crate::process::StreamProcess;
use crate::remote_files::{self, PREVIEW_TIMEOUT};
use crate::search::{SearchMode, search_workspace_files};

const MAX_FILE_RESOLUTION_CANDIDATES: usize = 32;
const MAX_FILE_RESOLUTION_PATH_LENGTH: usize = 4096;
/// file-constants.ts `GIT_DIFF_TIMEOUT_MS`.
const GIT_DIFF_TIMEOUT: Duration = Duration::from_millis(10_000);
/// The operation a Windows host is refused (`unixOnlyHandlers`).
const UNIX_ONLY: &str = "Workspace file and Git access";
/// index.ts's refusal of a Windows host's file transfers.
const UNIX_ONLY_TRANSFERS: &str =
    "Remote file transfers and agent history require a Unix SSH host.";

/// The browser RPCs [`rpc`] answers.
pub const RPC_METHODS: &[&str] = &[
    "file.list",
    "file.resolve",
    "file.read",
    "file.stat",
    "file.search",
    "file.reveal",
    "file.mkdir",
    "file.move",
    "git.diff_summary",
    "git.refs",
    "git.diff_file",
    "git.diff_files",
    "git.commits",
    "git.commit",
    "git.commit_file",
    "git.commit_preview",
    "git.pull",
    "git.file_action",
    "git.repo_action",
];

type Home = Shared<BoxFuture<'static, Result<String, String>>>;
type Roots = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

/// What a connection's file handlers keep across calls.
pub struct Files {
    last_steps: Option<Arc<LastStepStore>>,
    review_roots: Roots,
    streams: Option<Arc<dyn StreamProcess>>,
    local_home: Arc<dyn Fn() -> String + Send + Sync>,
    reveal: RevealOptions,
    env: Arc<dyn Env>,
    remote_homes: Mutex<HashMap<String, Home>>,
    ignored: NotARepoCache,
}

impl Default for Files {
    fn default() -> Self {
        Self::new()
    }
}

impl Files {
    pub fn new() -> Self {
        Self {
            last_steps: None,
            review_roots: Arc::new(Vec::new),
            streams: None,
            local_home: Arc::new(crate::path::local_home),
            reveal: RevealOptions::default(),
            env: Arc::new(ProcessEnv),
            remote_homes: Mutex::new(HashMap::new()),
            ignored: NotARepoCache::default(),
        }
    }

    /// The connection's last steps (Changes' Last step scope).
    pub fn with_last_steps(mut self, store: Arc<LastStepStore>) -> Self {
        self.last_steps = Some(store);
        self
    }

    /// The roots of the connection's review sessions (a review from
    /// elsewhere: its repository is no pane's).
    pub fn with_review_roots(
        mut self,
        roots: impl Fn() -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        self.review_roots = Arc::new(roots);
        self
    }

    /// Runs the SSH commands read as they come (a file downloaded whole,
    /// a search) in a long-lived session; without it they are read whole.
    pub fn with_streams(mut self, streams: Arc<dyn StreamProcess>) -> Self {
        self.streams = Some(streams);
        self
    }

    /// The home `~/` paths are in, on this machine.
    pub fn with_local_home(mut self, home: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.local_home = Arc::new(home);
        self
    }

    /// How file.reveal starts the file manager (its platform and spawn).
    pub fn with_reveal(mut self, reveal: RevealOptions) -> Self {
        self.reveal = reveal;
        self
    }

    /// The environment `ROAMGATE_ALLOW_FILE_REVEAL` is read from.
    pub fn with_env(mut self, env: Arc<dyn Env>) -> Self {
        self.env = env;
        self
    }

    pub fn last_steps(&self) -> Option<&Arc<LastStepStore>> {
        self.last_steps.as_ref()
    }
}

/// `String(value ?? "")`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => roamgate_git::js_num(n.as_f64().unwrap_or(0.0)).to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// JS truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn workspace_id(params: &Value, method: &str) -> Result<String, WorkspaceError> {
    let id = js_string(params.get("workspace_id"));
    if id.is_empty() {
        return Err(WorkspaceError::new(format!(
            "{method} requires workspace_id"
        )));
    }
    Ok(id)
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a files answer serialises")
}

/// `{...value, ...extra}` as JS spreads it: a key already there keeps its
/// place.
fn spread(mut base: Value, extra: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    if let Value::Object(map) = &mut base {
        for (key, value) in extra {
            map.insert(key.to_owned(), value);
        }
    }
    base
}

/// `{...head, ...value}`: `head` first.
fn prefixed(head: impl IntoIterator<Item = (&'static str, Value)>, value: Value) -> Value {
    let mut map: Map<String, Value> = head
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    if let Value::Object(rest) = value {
        for (key, value) in rest {
            map.insert(key, value);
        }
    }
    Value::Object(map)
}

fn repo_name(workspace: &Value) -> Value {
    workspace
        .pointer("/worktree/repo_name")
        .filter(|v| !v.is_null())
        .or_else(|| workspace.get("label").filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or_else(|| json!(""))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, WorkspaceError> + Send + 'static,
) -> Result<T, WorkspaceError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| WorkspaceError::new(error.to_string()))?
}

/// A resolved workspace and its Git root (`workspaceAndGitRoot`).
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    pub workspace_id: String,
    pub workspace: Value,
    pub root: String,
}

/// What git.pull_request reads: a root, or a definite answer about the
/// worktree asked (`readWorkspacePullRequest`'s early returns).
#[derive(Debug, Clone, PartialEq)]
pub enum PullRequestTarget {
    Root(String),
    Answer(Value),
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    roamgate_git::steps::iso_time(ms)
}

impl Files {
    async fn host_home(&self, conn: &WorkspaceConnection) -> Result<String, WorkspaceError> {
        let Some(host) = conn.ssh_host() else {
            return Ok((self.local_home)().replace('\\', "/"));
        };
        let home = {
            let mut homes = self.remote_homes.lock().unwrap();
            homes
                .entry(host.to_owned())
                .or_insert_with(|| {
                    let cx = conn.git.clone();
                    let host = host.to_owned();
                    async move {
                        let ran = cx
                            .run(
                                Invocation::ssh_read(
                                    &host,
                                    "printf %s \"$HOME\"",
                                    Some("files.home"),
                                ),
                                PREVIEW_TIMEOUT,
                            )
                            .await;
                        match ran {
                            Ok(ran) if ran.code == 0 && ran.stdout.trim().starts_with('/') => {
                                Ok(ran.stdout.trim().to_owned())
                            }
                            _ => Err(format!("the home of {host} is not known")),
                        }
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        match home.await {
            Ok(home) => Ok(home),
            Err(error) => {
                self.remote_homes.lock().unwrap().remove(host);
                Err(WorkspaceError::new(error))
            }
        }
    }

    /// A `~/` path as the absolute path it names on the workspace's host.
    async fn expand_home(
        &self,
        conn: &WorkspaceConnection,
        path: String,
    ) -> Result<String, WorkspaceError> {
        if path != "~" && !path.starts_with("~/") {
            return Ok(path);
        }
        let home = self.host_home(conn).await?;
        Ok(format!("{}{}", home.trim_end_matches('/'), &path[1..]))
    }
}

async fn pane_list(conn: &WorkspaceConnection) -> Result<Vec<Value>, WorkspaceError> {
    let result = conn
        .herdr_call("pane.list", json!({}), None)
        .await
        .map_err(WorkspaceError::new)?;
    Ok(result
        .get("panes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn workspace_pane<'a>(panes: &'a [Value], workspace_id: &str) -> Option<&'a Value> {
    let of = |pane: &&Value| pane.get("workspace_id").and_then(Value::as_str) == Some(workspace_id);
    panes
        .iter()
        .find(|pane| of(pane) && truthy(pane.get("focused")))
        .or_else(|| panes.iter().find(of))
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The checkout Files shows: Herdr's, else its focused pane's directory.
async fn explorer_root(
    conn: &WorkspaceConnection,
    workspace_id: &str,
    workspace: &Value,
) -> Result<String, WorkspaceError> {
    let checkout = checkout_path(workspace);
    if !checkout.is_empty() {
        return Ok(checkout);
    }
    let panes = pane_list(conn).await?;
    let pane = workspace_pane(&panes, workspace_id);
    Ok(pane
        .and_then(|pane| text_of(pane.get("foreground_cwd")).or_else(|| text_of(pane.get("cwd"))))
        .unwrap_or_default())
}

async fn get_workspace(
    conn: &WorkspaceConnection,
    workspace_id: &str,
) -> Result<Value, WorkspaceError> {
    let result = conn
        .herdr_call(
            "workspace.get",
            json!({ "workspace_id": workspace_id }),
            None,
        )
        .await
        .map_err(WorkspaceError::new)?;
    Ok(match result.get("workspace") {
        Some(workspace) if !workspace.is_null() => workspace.clone(),
        _ => result,
    })
}

fn no_directory() -> WorkspaceError {
    WorkspaceError::new("workspace has no directory path")
}

fn rev_parse(conn: &WorkspaceConnection, directory: &str) -> Invocation {
    match conn.ssh_host() {
        Some(host) => Invocation::ssh_read(
            host,
            &format!(
                "git -C {} rev-parse --show-toplevel",
                shell_quote(directory)
            ),
            None,
        ),
        None => Invocation::local(["git", "-C", directory, "rev-parse", "--show-toplevel"]),
    }
}

/// `gitRoot`: the Git top level of the workspace's checkout, else of its
/// pane's directory, the agent's foreground directory last.
async fn git_root(
    conn: &WorkspaceConnection,
    workspace_id: &str,
    workspace: &Value,
) -> Result<String, WorkspaceError> {
    let mut tried: Vec<String> = Vec::new();
    let mut last_error = "workspace is not inside a git repository".to_owned();
    let mut candidates: Vec<Option<String>> = vec![Some(checkout_path(workspace))];
    let mut panes_read = false;
    let mut index = 0;
    loop {
        if index == candidates.len() {
            if panes_read {
                break;
            }
            // A pane's foreground process can belong to an agent plugin
            // rather than the checkout: pane cwd first, foreground last.
            panes_read = true;
            let panes = pane_list(conn).await?;
            let pane = workspace_pane(&panes, workspace_id);
            candidates.push(pane.and_then(|p| text_of(p.get("cwd"))));
            candidates.push(pane.and_then(|p| text_of(p.get("foreground_cwd"))));
            continue;
        }
        let candidate = candidates[index].clone();
        index += 1;
        let Some(candidate) = candidate.filter(|c| !c.is_empty() && !tried.contains(c)) else {
            continue;
        };
        tried.push(candidate.clone());
        let ran = conn
            .git
            .run(rev_parse(conn, &candidate), GIT_DIFF_TIMEOUT)
            .await
            .map_err(|error| WorkspaceError::new(error.0))?;
        if ran.code == 0 && !ran.stdout.trim().is_empty() {
            return Ok(ran.stdout.trim().to_owned());
        }
        let text = [&ran.stderr, &ran.stdout]
            .into_iter()
            .find(|text| !text.is_empty())
            .cloned()
            .unwrap_or_else(|| "workspace is not inside a git repository".into());
        last_error = roamgate_git::trim_slice(&text, 1000);
    }
    if tried.is_empty() {
        return Err(no_directory());
    }
    Err(WorkspaceError::new(last_error))
}

fn trim_slashes(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed.to_owned()
    }
}

impl Files {
    /// `workspaceRepoRoot`: another repository of the workspace (Changes'
    /// picker), whose top level holds or is under the checkout or one of
    /// its panes' directories, or a review's own root.
    async fn workspace_repo_root(
        &self,
        conn: &WorkspaceConnection,
        workspace_id: &str,
        workspace: &Value,
        wanted: &str,
    ) -> Result<String, WorkspaceError> {
        let root = trim_slashes(wanted);
        if !root.starts_with('/') || root.split('/').any(|part| part == "..") {
            return Err(WorkspaceError::new("root must be an absolute path"));
        }
        let panes = pane_list(conn).await?;
        let mut dirs = vec![checkout_path(workspace)];
        for pane in &panes {
            if pane.get("workspace_id").and_then(Value::as_str) == Some(workspace_id) {
                for key in ["cwd", "foreground_cwd"] {
                    if let Some(dir) = pane.get(key).and_then(Value::as_str) {
                        dirs.push(dir.to_owned());
                    }
                }
            }
        }
        let prefix = |dir: &str| {
            if dir == "/" {
                String::new()
            } else {
                dir.to_owned()
            }
        };
        let related = |dir: &String| {
            *dir == root
                || dir.starts_with(&format!("{}/", prefix(&root)))
                || root.starts_with(&format!("{}/", prefix(dir)))
        };
        let dirs: Vec<String> = dirs
            .into_iter()
            .filter(|dir| dir.starts_with('/'))
            .map(|dir| trim_slashes(&dir))
            .collect();
        let review = (self.review_roots)()
            .iter()
            .map(|root| trim_slashes(root))
            .any(|review| review == root);
        if !dirs.iter().any(related) && !review {
            return Err(WorkspaceError::new(
                "root is not a repository of this workspace",
            ));
        }
        let ran = conn
            .git
            .run(rev_parse(conn, &root), GIT_DIFF_TIMEOUT)
            .await
            .map_err(|error| WorkspaceError::new(error.0))?;
        if ran.code != 0 || trim_slashes(ran.stdout.trim()) != root {
            return Err(WorkspaceError::new("root is not a repository's top level"));
        }
        Ok(root)
    }

    /// `resolveWorkspaceGitRoot` (`workspaceAndGitRoot`): the workspace
    /// and the Git root its calls read, `params.root` when another
    /// repository of it is asked.
    pub async fn workspace_git_root(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
    ) -> Result<WorkspaceRoot, WorkspaceError> {
        unix_only(conn)?;
        self.workspace_and_git_root(conn, params, "git diff").await
    }

    async fn workspace_and_git_root(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        method: &str,
    ) -> Result<WorkspaceRoot, WorkspaceError> {
        let workspace_id = workspace_id(params, method)?;
        let workspace = get_workspace(conn, &workspace_id).await?;
        let root = match params
            .get("root")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
        {
            Some(wanted) => {
                self.workspace_repo_root(conn, &workspace_id, &workspace, wanted)
                    .await?
            }
            None => git_root(conn, &workspace_id, &workspace).await?,
        };
        Ok(WorkspaceRoot {
            workspace_id,
            workspace,
            root,
        })
    }

    /// The root git.pull_request reads (`readWorkspacePullRequest` before
    /// `sharedPullRequestStatus`): the workspace's Git root, or the
    /// worktree asked when Herdr lists it as available; a definite answer
    /// otherwise.
    pub async fn pull_request_target(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
    ) -> Result<PullRequestTarget, WorkspaceError> {
        unix_only(conn)?;
        let WorkspaceRoot { root, .. } = self
            .workspace_and_git_root(conn, params, "git.pull_request")
            .await?;
        let Some(asked) = params.get("worktree_path") else {
            return Ok(PullRequestTarget::Root(root));
        };
        let listed = conn
            .herdr_call(
                "worktree.list",
                json!({ "workspace_id": params.get("workspace_id") }),
                None,
            )
            .await
            .map_err(WorkspaceError::new)?;
        let worktree = listed
            .get("worktrees")
            .and_then(Value::as_array)
            .and_then(|list| list.iter().find(|entry| entry.get("path") == Some(asked)));
        // A definite answer, unlike transport failures: the browser must
        // not keep showing this target's previous request as last known.
        let Some(worktree) = worktree else {
            return Ok(PullRequestTarget::Answer(json!({
                "state": "error",
                "root": "",
                "branch": "",
                "remotes": [],
                "refreshedAt": now_iso(),
                "message": "Worktree is unavailable in this repository.",
            })));
        };
        let path = worktree.get("path").cloned().unwrap_or(Value::Null);
        if truthy(worktree.get("is_bare")) || truthy(worktree.get("is_prunable")) {
            return Ok(PullRequestTarget::Answer(json!({
                "state": "unsupported",
                "root": path,
                "branch": "",
                "remotes": [],
                "refreshedAt": now_iso(),
                "message": "Bare or prunable worktrees cannot resolve PR/MR status.",
            })));
        }
        Ok(PullRequestTarget::Root(js_string(Some(&path))))
    }
}

fn unix_only(conn: &WorkspaceConnection) -> Result<(), WorkspaceError> {
    if conn.is_windows() {
        return Err(WorkspaceError::new(format!(
            "{UNIX_ONLY} requires a Unix SSH host and is unavailable on Windows."
        )));
    }
    Ok(())
}

/// A browser RPC of the file explorer or Changes' Git (None: not one of
/// [`RPC_METHODS`]). `client_ip` is the browser's transport address
/// (file.reveal only allows loopback).
pub async fn rpc(
    files: &Files,
    conn: &WorkspaceConnection,
    method: &str,
    params: &Value,
    client_ip: Option<&str>,
) -> Option<RpcResult> {
    if !RPC_METHODS.contains(&method) {
        return None;
    }
    if let Err(error) = unix_only(conn) {
        return Some(Err(error));
    }
    Some(match method {
        "file.list" => files.list(conn, params).await,
        "file.resolve" => files.resolve(conn, params).await,
        "file.read" => files.read(conn, params).await,
        "file.stat" => files.stat(conn, params).await,
        "file.search" => files.search(conn, params).await,
        "file.reveal" => files
            .reveal(conn, params, client_ip.unwrap_or(""))
            .await
            .map(|r| to_value(&r)),
        "file.mkdir" => files.mutate(conn, params, false).await,
        "file.move" => files.mutate(conn, params, true).await,
        _ => files.git(conn, method, params).await,
    })
}

impl Files {
    async fn list(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let workspace_id = workspace_id(params, "file.list")?;
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        let filesystem = params.get("scope").and_then(Value::as_str) == Some("filesystem");
        let root_path = if filesystem {
            let asked = params.get("path").filter(|p| truthy(Some(p))).cloned();
            sanitize_filesystem_path(Some(&asked.unwrap_or_else(|| json!(checkout))))?
        } else {
            checkout.clone()
        };
        let relative_path = if filesystem {
            String::new()
        } else {
            sanitize_explorer_path(params.get("path"))?
        };
        let show_hidden = params.get("show_hidden") == Some(&Value::Bool(true));
        let mut list = match conn.ssh_host() {
            Some(host) => {
                remote_files::list_remote_files(
                    &conn.git,
                    host,
                    &root_path,
                    &relative_path,
                    show_hidden,
                )
                .await?
            }
            None => {
                let (root, rel) = (root_path.clone(), relative_path.clone());
                blocking(move || {
                    local_files::list_local_files(&root, &rel, show_hidden, filesystem)
                })
                .await?
            }
        };
        if !list.entries.is_empty() {
            let directory = if relative_path.is_empty() {
                list.root.clone()
            } else {
                format!("{}/{relative_path}", list.root)
            };
            let names: Vec<String> = list.entries.iter().map(|e| e.name.clone()).collect();
            let ignored = collect_ignored_names(&conn.git, &self.ignored, &directory, &names).await;
            for entry in &mut list.entries {
                if ignored.contains(&entry.name) {
                    entry.ignored = Some(true);
                }
            }
        }
        if filesystem {
            let directory = list.root.replace('\\', "/");
            let directory = directory.trim_end_matches('/');
            for entry in &mut list.entries {
                entry.path = format!("{directory}/{}", entry.name);
            }
        }
        let mut value = to_value(&list);
        let map = value.as_object_mut().expect("a list");
        if filesystem {
            map.insert("scope".into(), json!("filesystem"));
        }
        map.insert("workspace_id".into(), json!(workspace_id));
        map.insert("repo_name".into(), repo_name(&workspace));
        map.insert("checkout_path".into(), json!(checkout));
        Ok(value)
    }

    /// `fileTarget`: the workspace, its checkout and the path asked.
    async fn file_target(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        method: &str,
    ) -> Result<(String, Value, String, String), WorkspaceError> {
        let workspace_id = workspace_id(params, method)?;
        let path = self
            .expand_home(conn, sanitize_preview_path(params.get("path"))?)
            .await?;
        if path.is_empty() {
            return Err(WorkspaceError::new(format!("{method} requires path")));
        }
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        Ok((workspace_id, workspace, checkout, path))
    }

    async fn read(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let (workspace_id, workspace, checkout, path) =
            self.file_target(conn, params, "file.read").await?;
        let preview = match conn.ssh_host() {
            Some(host) => remote_files::read_remote_file(&conn.git, host, &checkout, &path).await?,
            None => {
                let root = checkout.clone();
                blocking(move || local_files::read_local_file(&root, &path)).await?
            }
        };
        Ok(spread(
            to_value(&preview),
            [
                ("workspace_id", json!(workspace_id)),
                ("repo_name", repo_name(&workspace)),
                ("checkout_path", json!(checkout)),
            ],
        ))
    }

    async fn stat(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let (_, _, checkout, path) = self.file_target(conn, params, "file.stat").await?;
        let stat = match conn.ssh_host() {
            Some(host) => remote_files::stat_remote_file(&conn.git, host, &checkout, &path).await?,
            None => blocking(move || local_files::stat_local_file(&checkout, &path)).await?,
        };
        Ok(to_value(&stat))
    }

    async fn search(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let workspace_id = workspace_id(params, "file.search")?;
        let mode = match params.get("mode").and_then(Value::as_str) {
            Some("files") => SearchMode::Files,
            Some("content") => SearchMode::Content,
            _ => return Err(WorkspaceError::new("invalid file.search mode")),
        };
        let query = params.get("query").and_then(Value::as_str).filter(|q| {
            !q.trim().is_empty()
                && q.encode_utf16().count() <= 512
                && !q.chars().any(|c| c <= '\x1f' || c == '\x7f')
        });
        let Some(query) = query else {
            return Err(WorkspaceError::new("invalid file.search query"));
        };
        let workspace = get_workspace(conn, &workspace_id).await?;
        let root = explorer_root(conn, &workspace_id, &workspace).await?;
        if root.is_empty() {
            return Err(no_directory());
        }
        let result = search_workspace_files(
            &conn.git,
            self.streams.as_ref(),
            &root,
            query.trim(),
            mode,
            params.get("show_hidden") == Some(&Value::Bool(true)),
        )
        .await?;
        Ok(spread(
            to_value(&result),
            [("workspace_id", json!(workspace_id)), ("root", json!(root))],
        ))
    }

    /// `revealWorkspaceFile`: only with the host's opt-in, on a local
    /// profile, for a loopback peer.
    pub async fn reveal(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        client_address: &str,
    ) -> Result<FileRevealResult, WorkspaceError> {
        if conn.ssh_host().is_some() || !can_reveal_files(client_address, self.env.as_ref()) {
            return Err(WorkspaceError::new(
                "file.reveal requires host opt-in, a local profile and a loopback peer",
            ));
        }
        let scope = match params.get("scope") {
            None | Some(Value::Null) => "workspace",
            Some(Value::String(s)) if s == "workspace" || s == "filesystem" => s.as_str(),
            _ => return Err(WorkspaceError::new("invalid file.reveal scope")),
        };
        let changes = match params.get("source") {
            None => false,
            Some(Value::String(s)) if s == "changes" => true,
            _ => return Err(WorkspaceError::new("invalid file.reveal source")),
        };
        if changes && scope != "workspace" {
            return Err(WorkspaceError::new(
                "Changes reveal requires a Git-root-relative path",
            ));
        }
        let workspace_id = workspace_id(params, "file.reveal")?;
        let Some(path) = params
            .get("path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        else {
            return Err(WorkspaceError::new("file.reveal requires path"));
        };
        let workspace = get_workspace(conn, &workspace_id).await?;
        let root = if changes {
            git_root(conn, &workspace_id, &workspace).await?
        } else {
            explorer_root(conn, &workspace_id, &workspace).await?
        };
        if root.is_empty() {
            return Err(no_directory());
        }
        let options = RevealOptions {
            scope: scope.into(),
            nearest_existing_ancestor: changes,
            ..self.reveal.clone()
        };
        let path = path.to_owned();
        blocking(move || reveal_local_path(&root, &path, &options)).await
    }

    async fn resolve(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let workspace_id = workspace_id(params, "file.resolve")?;
        let raw: &[Value] = params
            .get("paths")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut candidates: Vec<FileResolution> = Vec::new();
        for value in raw.iter().take(MAX_FILE_RESOLUTION_CANDIDATES) {
            let Some(text) = value.as_str() else { continue };
            let candidate = text.trim();
            if candidate.is_empty()
                || candidate.encode_utf16().count() > MAX_FILE_RESOLUTION_PATH_LENGTH
                || candidates.iter().any(|c| c.candidate == candidate)
            {
                continue;
            }
            // Invalid candidates are unresolved rather than failing the
            // whole batch.
            let Ok(sanitized) = sanitize_preview_path(Some(&json!(candidate))) else {
                continue;
            };
            let path = if sanitized.starts_with('/') {
                sanitized
            } else {
                sanitized
                    .split('/')
                    .filter(|part| !part.is_empty() && *part != ".")
                    .collect::<Vec<_>>()
                    .join("/")
            };
            if path.is_empty() {
                continue;
            }
            candidates.push(FileResolution {
                candidate: candidate.to_owned(),
                path,
            });
        }
        if candidates.is_empty() {
            return Ok(json!({ "workspace_id": workspace_id, "files": [] }));
        }
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        let mut paths: Vec<String> = Vec::new();
        for candidate in &candidates {
            if !paths.contains(&candidate.path) {
                paths.push(candidate.path.clone());
            }
        }
        let existing = match conn.ssh_host() {
            Some(host) => {
                remote_files::resolve_remote_file_paths(&conn.git, host, &checkout, &paths).await?
            }
            None => {
                let root = checkout.clone();
                blocking(move || local_files::resolve_local_file_paths(&root, &paths)).await?
            }
        };
        let files: Vec<&FileResolution> = candidates
            .iter()
            .filter(|c| existing.contains(&c.path))
            .collect();
        Ok(json!({
            "workspace_id": workspace_id,
            "checkout_path": checkout,
            "files": files,
        }))
    }

    async fn mutate(&self, conn: &WorkspaceConnection, params: &Value, moving: bool) -> RpcResult {
        let method = if moving { "file.move" } else { "file.mkdir" };
        let workspace_id = workspace_id(params, method)?;
        match params.get("scope") {
            None => {}
            Some(Value::String(s)) if s == "workspace" => {}
            _ => {
                return Err(WorkspaceError::new(format!(
                    "{method} only supports workspace scope"
                )));
            }
        }
        let directory = match params.get("directory") {
            None | Some(Value::Null) => sanitize_mutation_path(Some(&json!("")))?,
            directory => sanitize_mutation_path(directory)?,
        };
        let path = if moving {
            Some(sanitize_mutation_path(params.get("path"))?)
        } else {
            None
        };
        if moving && path.as_deref() == Some("") {
            return Err(WorkspaceError::new("file.move requires path"));
        }
        let name = match &path {
            None => sanitize_upload_filename(params.get("name"))?,
            Some(path) => path.rsplit('/').next().unwrap_or(path).to_owned(),
        };
        let workspace = get_workspace(conn, &workspace_id).await?;
        let root = explorer_root(conn, &workspace_id, &workspace).await?;
        if root.is_empty() {
            return Err(no_directory());
        }
        let path_done = match conn.ssh_host() {
            Some(host) => {
                remote_files::mutate_remote_file(
                    &conn.git,
                    host,
                    &root,
                    &directory,
                    &name,
                    path.as_deref(),
                )
                .await?
            }
            None => {
                blocking(move || match path {
                    None => local_files::create_local_directory(&root, &directory, &name),
                    Some(path) => local_files::move_local_file(&root, &path, &directory),
                })
                .await?
            }
        };
        Ok(json!({ "workspace_id": workspace_id, "path": path_done }))
    }

    async fn git(&self, conn: &WorkspaceConnection, method: &str, params: &Value) -> RpcResult {
        let context_method = match method {
            "git.refs" | "git.file_action" | "git.repo_action" => method,
            "git.commits" | "git.commit" | "git.commit_file" | "git.commit_preview" => {
                "git history"
            }
            _ => "git diff",
        };
        let WorkspaceRoot {
            workspace_id,
            workspace,
            root,
        } = self
            .workspace_and_git_root(conn, params, context_method)
            .await?;
        let cx = &conn.git;
        let history = || HistoryContext {
            git: cx.clone(),
            root: root.clone(),
        };
        let action = || ActionContext {
            git: cx.clone(),
            root: root.clone(),
        };
        let files_args = || FilesArgs {
            cx,
            workspace_id: &workspace_id,
            root: &root,
            params,
            last_steps: self.last_steps.as_ref(),
        };
        let head = || [("workspace_id", json!(workspace_id)), ("root", json!(root))];
        Ok(match method {
            "git.diff_summary" => {
                let summary = read_diff_summary(SummaryArgs {
                    cx,
                    workspace_id: &workspace_id,
                    workspace: &workspace,
                    root: &root,
                    params,
                    last_steps: self.last_steps.as_ref(),
                })
                .await?;
                // Another repository than the workspace's own goes by its
                // own name.
                if params
                    .get("root")
                    .and_then(Value::as_str)
                    .is_some_and(|r| !r.is_empty())
                {
                    let name = root
                        .rsplit('/')
                        .next()
                        .filter(|n| !n.is_empty())
                        .unwrap_or(&root);
                    spread(summary, [("repo_name", json!(name))])
                } else {
                    summary
                }
            }
            "git.refs" => to_value(
                &roamgate_git::compare::read_compare_refs(cx, &root, Some(GIT_DIFF_TIMEOUT))
                    .await?,
            ),
            "git.diff_file" => read_diff_file(files_args()).await?,
            "git.diff_files" => read_diff_files(files_args()).await?,
            "git.commits" => list_commits(&history(), params).await?,
            "git.commit" => read_commit(&history(), params.get("sha")).await?,
            "git.commit_file" => prefixed(head(), read_commit_file(&history(), params).await?),
            "git.commit_preview" => {
                prefixed(head(), read_commit_preview(&history(), params).await?)
            }
            "git.pull" => pull_git(cx, &workspace_id, &root).await?,
            "git.file_action" => prefixed(
                head(),
                to_value(&run_git_file_action(&action(), params).await?),
            ),
            "git.repo_action" => prefixed(
                head(),
                to_value(&run_git_repo_action(&action(), params).await?),
            ),
            other => return Err(WorkspaceError::new(format!("unknown method {other}"))),
        })
    }
}

/// An HTTP answer of the file routes, as the adapter sends it.
#[derive(Debug)]
pub struct FileHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: FileBody,
}

impl FileHttpResponse {
    fn text(status: u16, text: &str, headers: Vec<(String, String)>) -> Self {
        let mut all = vec![(
            "content-type".to_owned(),
            "text/plain;charset=utf-8".to_owned(),
        )];
        for (name, value) in headers {
            match all.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => all.push((name, value)),
            }
        }
        Self {
            status,
            headers: all,
            body: FileBody::Bytes(text.as_bytes().to_vec()),
        }
    }

    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            headers: vec![(
                "content-type".into(),
                "application/json;charset=utf-8".into(),
            )],
            body: FileBody::Bytes(serde_json::to_vec(value).expect("json")),
        }
    }

    /// The header's value, by lower-case name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

fn header(name: &str, value: impl Into<String>) -> (String, String) {
    (name.to_owned(), value.into())
}

/// A request's query as the TS read it (`url.searchParams.get`): null
/// when absent.
fn query_params(query: &str, names: &[&str]) -> Map<String, Value> {
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    names
        .iter()
        .map(|name| {
            let value = pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| json!(value))
                .unwrap_or(Value::Null);
            ((*name).to_owned(), value)
        })
        .collect()
}

impl Files {
    fn windows_refusal() -> FileHttpResponse {
        FileHttpResponse::json(501, &json!({ "error": UNIX_ONLY_TRANSFERS }))
    }

    /// `GET /api/file/download?workspace_id&path&scope&inline=1` with its
    /// `Range` and `If-Range`: a 400 with the message when it fails.
    pub async fn http_download(
        &self,
        conn: &WorkspaceConnection,
        query: &str,
        range: Option<&str>,
        if_range: Option<&str>,
    ) -> FileHttpResponse {
        if conn.is_windows() {
            return Self::windows_refusal();
        }
        let mut params = query_params(query, &["workspace_id", "path", "scope"]);
        let inline = query_params(query, &["inline"])
            .get("inline")
            .and_then(Value::as_str)
            == Some("1");
        params.insert("inline".into(), json!(inline));
        let options = FileDownloadOptions {
            inline,
            range: range.map(str::to_owned),
            if_range: if_range.map(str::to_owned),
            max_bytes: None,
        };
        match self.download(conn, &Value::Object(params), options).await {
            Ok(response) => response,
            Err(error) => FileHttpResponse::text(400, &error.message, Vec::new()),
        }
    }

    async fn download(
        &self,
        conn: &WorkspaceConnection,
        params: &Value,
        options: FileDownloadOptions,
    ) -> Result<FileHttpResponse, WorkspaceError> {
        let workspace_id = workspace_id(params, "file.download")?;
        let path = if params.get("scope").and_then(Value::as_str) == Some("filesystem") {
            let asked = match params.get("path").and_then(Value::as_str) {
                Some(path) => json!(self.expand_home(conn, path.trim().to_owned()).await?),
                None => params.get("path").cloned().unwrap_or(Value::Null),
            };
            sanitize_filesystem_path(Some(&asked))?
        } else {
            sanitize_explorer_path(params.get("path"))?
        };
        if path.is_empty() {
            return Err(WorkspaceError::new("file.download requires path"));
        }
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        if options.inline && is_html_path(&path) {
            let name = path.rsplit('/').next().unwrap_or(&path);
            let headers = vec![
                header("content-type", "text/html; charset=utf-8"),
                header("content-disposition", inline_content_disposition(name)),
                header("content-security-policy", HTML_PREVIEW_CSP),
                header("referrer-policy", "no-referrer"),
                header("x-content-type-options", "nosniff"),
                header("cache-control", "private, no-store"),
            ];
            return Ok(
                match render_html_preview_file(&conn.git, &checkout, &path).await {
                    Ok(page) => FileHttpResponse {
                        status: 200,
                        headers,
                        body: FileBody::Bytes(page.into_bytes()),
                    },
                    Err(error) => {
                        let message = if error.status == 413 {
                            "HTML is too large to render, or its static resources exceed the preview limits. Use Source or Download."
                        } else {
                            "Unable to render HTML. Preview requires a readable UTF-8 HTML file and static resources inside the workspace. Use Source or Download."
                        };
                        let mut headers = headers;
                        headers[0].1 = "text/plain; charset=utf-8".into();
                        FileHttpResponse {
                            status: error.status,
                            headers,
                            body: FileBody::Bytes(message.as_bytes().to_vec()),
                        }
                    }
                },
            );
        }
        let download = match conn.ssh_host() {
            Some(host) => {
                remote_files::download_remote_file(
                    &conn.git,
                    host,
                    &checkout,
                    &path,
                    &options,
                    self.streams.as_ref(),
                )
                .await
            }
            None => local_files::download_local_file(&checkout, &path, &options).await,
        };
        let download = match download {
            Ok(download) => download,
            Err(DownloadFailure::Failed(error)) => return Err(error),
            Err(DownloadFailure::Refused(error)) => {
                let mut headers = vec![
                    header("cache-control", "private, no-store"),
                    header("x-content-type-options", "nosniff"),
                ];
                if error.status == 416 {
                    headers.push(header(
                        "content-range",
                        format!(
                            "bytes */{}",
                            error
                                .size
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "undefined".into())
                        ),
                    ));
                }
                return Ok(FileHttpResponse::text(
                    error.status,
                    &error.message,
                    headers,
                ));
            }
        };
        let inline_mime = (options.inline && download.content_type != "application/gzip")
            .then(|| inline_preview_mime_for_path(&download.path))
            .flatten();
        let content_type = match inline_mime {
            Some(mime) => mime.to_owned(),
            None if download.content_type == "application/octet-stream" => {
                download_content_type_for_path(&download.filename).to_owned()
            }
            None => download.content_type.clone(),
        };
        let mut headers = vec![
            header("content-type", content_type),
            header("content-length", download.size.to_string()),
            header(
                "content-disposition",
                if inline_mime.is_some() {
                    inline_content_disposition(&download.filename)
                } else {
                    download_content_disposition(&download.filename)
                },
            ),
            header("x-file-path", encode_uri_component(&download.path)),
        ];
        if download.accept_ranges {
            headers.push(header("accept-ranges", "bytes"));
        }
        if let Some(range) = &download.content_range {
            headers.push(header("content-range", range.clone()));
        }
        if inline_mime.is_some() {
            headers.push(header("cache-control", "private, no-store"));
            headers.push(header("x-content-type-options", "nosniff"));
        }
        if inline_mime == Some("image/svg+xml") {
            // SVGs are inert in <img>; direct navigation to the same
            // endpoint is isolated too.
            headers.push(header(
                "content-security-policy",
                "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            ));
        }
        Ok(FileHttpResponse {
            status: if download.content_range.is_some() {
                206
            } else {
                200
            },
            headers,
            body: download.body,
        })
    }

    /// `POST /api/file/upload?workspace_id&directory&filename` with the
    /// file as its body: the upload's JSON, or `{error}` with 400.
    pub async fn http_upload(
        &self,
        conn: &WorkspaceConnection,
        query: &str,
        body: &[u8],
    ) -> FileHttpResponse {
        if conn.is_windows() {
            return Self::windows_refusal();
        }
        let params = Value::Object(query_params(
            query,
            &["workspace_id", "directory", "filename"],
        ));
        match self.upload(conn, &params, body).await {
            Ok(value) => FileHttpResponse::json(200, &value),
            Err(error) => FileHttpResponse::json(400, &json!({ "error": error.message })),
        }
    }

    async fn upload(&self, conn: &WorkspaceConnection, params: &Value, body: &[u8]) -> RpcResult {
        let workspace_id = workspace_id(params, "file.upload")?;
        let directory = sanitize_explorer_path(params.get("directory"))?;
        let filename = sanitize_upload_filename(params.get("filename"))?;
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        let upload = match conn.ssh_host() {
            Some(host) => {
                remote_files::upload_remote_file(
                    &conn.git, host, &checkout, &directory, &filename, body,
                )
                .await?
            }
            None => {
                let (dir, name, body) = (directory.clone(), filename.clone(), body.to_vec());
                blocking(move || local_files::upload_local_file(&checkout, &dir, &name, &body))
                    .await?
            }
        };
        Ok(prefixed(
            [
                ("workspace_id", json!(workspace_id)),
                ("directory", json!(directory)),
                ("filename", json!(filename)),
            ],
            to_value(&upload),
        ))
    }

    /// `POST /api/file/delete?workspace_id&path`: the deletion's JSON, or
    /// `{error}` with 400.
    pub async fn http_delete(&self, conn: &WorkspaceConnection, query: &str) -> FileHttpResponse {
        if conn.is_windows() {
            return Self::windows_refusal();
        }
        let params = Value::Object(query_params(query, &["workspace_id", "path"]));
        match self.delete(conn, &params).await {
            Ok(value) => FileHttpResponse::json(200, &value),
            Err(error) => FileHttpResponse::json(400, &json!({ "error": error.message })),
        }
    }

    async fn delete(&self, conn: &WorkspaceConnection, params: &Value) -> RpcResult {
        let workspace_id = workspace_id(params, "file.delete")?;
        let path = sanitize_explorer_path(params.get("path"))?;
        if path.is_empty() {
            return Err(WorkspaceError::new("file.delete requires path"));
        }
        let workspace = get_workspace(conn, &workspace_id).await?;
        let checkout = explorer_root(conn, &workspace_id, &workspace).await?;
        if checkout.is_empty() {
            return Err(no_directory());
        }
        let deleted = match conn.ssh_host() {
            Some(host) => {
                remote_files::delete_remote_file(&conn.git, host, &checkout, &path).await?
            }
            None => blocking(move || local_files::delete_local_file(&checkout, &path)).await?,
        };
        Ok(prefixed(
            [("workspace_id", json!(workspace_id))],
            to_value(&deleted),
        ))
    }
}

/// `readLastStep`: the workspace's last step in `root` as a review target
/// (`{kind: "step", step, before, after, at?, skipped?}`), None without one.
pub async fn read_last_step(files: &Files, root: &str, workspace_id: &str) -> Option<Value> {
    let store = files.last_steps.as_ref()?;
    let step = store.completed_step(workspace_id, root).await?;
    let id = step.step.clone()?;
    let mut target = json!({
        "kind": "step",
        "step": id,
        "before": step.baseline,
        "after": step.current,
    });
    let map = target.as_object_mut().expect("a target");
    if let Some(at) = &step.at {
        map.insert("at".into(), json!(at));
    }
    if !step.skipped.is_empty() {
        map.insert("skipped".into(), json!(step.skipped));
    }
    Some(target)
}

/// Whether `path` names a file on this machine Files would serve as a
/// local file (index.ts publishes those responses differently).
pub fn is_local(conn: &WorkspaceConnection) -> bool {
    conn.ssh_host().is_none()
}

/// The real path `root` names, for the tests' fixtures.
#[cfg(test)]
pub(crate) fn real(root: &std::path::Path) -> String {
    crate::file_types::path_text(&crate::file_types::realpath(root).unwrap())
}

#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod reveal_tests;
#[cfg(test)]
mod tests;
