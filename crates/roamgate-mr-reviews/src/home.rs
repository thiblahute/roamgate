//! A request's home (`mr-reviews/home.ts`): a workspace of its own, where
//! its review is shown and its agent keeps its notes. Opening a request
//! that has one (on its branch, named after it, or made here) shows its
//! review there, not in the project's shared review workspace. "Start a
//! review with a home" makes one: a worktree through the user's worktree
//! path on the request's head, named after it, placed where the project's
//! reviews go, with a Claude session told its job. Nothing is ever sent to
//! a forge: git only fetches.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_base::log::{LogFields, Logger};
use roamgate_base::paths::random_uuid;
use serde_json::{Value, json};

use crate::claude::{
    AgentCommand, AgentCommandFn, ConnectionsFn, StartMode, StartModeFn, agent_name, agent_status,
    claude_command, herdr, lock_store, mr_project_key, panes_of, profile_launch, record_mut,
    update_store, workspaces_of,
};
use crate::clones::{ProjectRef, remote_is_project};
use crate::connection::{BoxFuture, MrConnection, ShellResult, sh_quote};
use crate::inbox::SettingsFn;
use crate::rpc::{RpcError, RpcResult};
use crate::shared::types::{forge_ref_label, home_prompt};
use crate::store::MrStore;
use crate::worktree::{FetchWant, fetch_script, parse_fetch, project_url};

/// The workspace label of a request's home: "!3326 rtpgccbwe: Fix...".
pub fn home_label(item: &Obj) -> String {
    let reference = forge_ref_label(item, true);
    let title = js::collapse_space(js::sv(item.get("title")), " ");
    let full = format!("{reference} {}", js::trim(&title));
    if js::len16(&full) > 60 {
        format!("{}\u{2026}", js::trim_end(&js::head16(&full, 59)))
    } else {
        full
    }
}

static NOT_BRANCH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_./-]+").expect("pattern"));
static DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.{2,}").expect("pattern"));
static SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/{2,}").expect("pattern"));
static ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-/.]+|[-/.]+$").expect("pattern"));
static LOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.lock$").expect("pattern"));
static MAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(main|master)$").expect("pattern"));

fn number_text(item: &Obj) -> String {
    item.get("number")
        .map(js::to_text)
        .unwrap_or_else(|| "undefined".into())
}

/// A branch name git and the worktree command take, from the forge's.
pub fn home_branch_name(item: &Obj) -> String {
    let source = js::sv(item.get("sourceBranch"));
    let cleaned = NOT_BRANCH.replace_all(source, "-");
    let cleaned = DOTS.replace_all(&cleaned, ".");
    let cleaned = SLASHES.replace_all(&cleaned, "/");
    let cleaned = ENDS.replace_all(&cleaned, "");
    let cleaned = LOCK.replace(&cleaned, "");
    // Only ASCII is left.
    let cleaned: String = cleaned.chars().take(120).collect();
    if !cleaned.is_empty() && !MAIN.is_match(&cleaned) {
        cleaned
    } else {
        format!("review/{}", number_text(item))
    }
}

/// The branch to make in the clone: the request's own name unless the
/// clone has a branch of that name (the user's, never moved): then
/// review/N-name. Prints `NAME <branch>`.
pub fn home_branch_script(clone: &str, wanted: &str, number: &str) -> String {
    let other = js::head16(&format!("review/{number}-{wanted}"), 200);
    [
        format!("cd {} || exit 2", sh_quote(clone)),
        format!("b={}", sh_quote(wanted)),
        format!(
            "if git show-ref --verify --quiet \"refs/heads/$b\"; then b={}; fi",
            sh_quote(&other)
        ),
        "if git show-ref --verify --quiet \"refs/heads/$b\"; then b=\"$b-$(date +%Y%m%d-%H%M%S)\"; fi".into(),
        "printf \"NAME %s\\n\" \"$b\"".into(),
    ]
    .join("\n")
}

/// Puts the new worktree's branch on the request's head. The worktree is
/// fresh (made from the target's tip a moment ago): `--keep` still refuses
/// to lose anything a setup hook may have written. Prints `AT <sha>`.
pub fn home_checkout_script(path: &str, sha: &str) -> String {
    [
        format!("cd {} || exit 2", sh_quote(path)),
        format!(
            "git cat-file -e {} 2>/dev/null || {{ echo NOCOMMIT; exit 3; }}",
            sh_quote(&format!("{sha}^{{commit}}"))
        ),
        format!("git reset -q --keep {} >&2 || exit 4", sh_quote(sha)),
        "echo \"AT $(git rev-parse HEAD)\"".into(),
    ]
    .join("\n")
}

/// The checkout's top and its remotes: `T <top>`, then `R <name> <url>`.
pub fn home_root_script(dir: &str) -> String {
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(dir)),
        "printf \"T\\t%s\\n\" \"$(git rev-parse --show-toplevel 2>/dev/null)\"".into(),
        "git config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do n=${k#remote.}; printf \"R\\t%s\\t%s\\n\" \"${n%.url}\" \"$v\"; done".into(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// A remote of a checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HomeRemote {
    pub name: String,
    pub url: String,
}

/// What [`home_root_script`] printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HomeRoot {
    pub top: String,
    pub remotes: Vec<HomeRemote>,
}

pub fn parse_home_root(stdout: &str) -> HomeRoot {
    let mut root = HomeRoot::default();
    for line in stdout.split('\n') {
        let mut fields = line.split('\t');
        let kind = fields.next().unwrap_or("");
        let a = fields.next().unwrap_or("");
        let b = fields.next().unwrap_or("");
        if kind == "T" && a.starts_with('/') {
            root.top = a.to_owned();
        } else if kind == "R" && !a.is_empty() && !b.is_empty() {
            root.remotes.push(HomeRemote {
                name: a.to_owned(),
                url: b.to_owned(),
            });
        }
    }
    root
}

static TRAILING_SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/+$").expect("pattern"));
static DOT_GIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.git$").expect("pattern"));

/// The clone's own checkout, where its worktrees start from. Herdr's
/// worktree actions, and Roamgate's worktree path before them, run
/// work-tree commands there (`git rev-parse --show-toplevel`), which a
/// repository directory refuses: "this operation must be run in a work
/// tree". A checkout is its own, and so is the work tree `core.worktree`
/// gives a repository directory. A repository directory such as
/// gstreamer.git (the first entry of `git worktree list`, with no work tree
/// of its own) has the checkout its `gitdir` file names, or the directory
/// beside it without `.git`, when that checkout's repository is this one.
/// Prints `TOP\t<checkout>`, empty when there is none.
pub fn home_source_script(clone: &str) -> String {
    let trimmed = TRAILING_SLASHES.replace(clone, "");
    let beside = DOT_GIT.replace(&trimmed, "");
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(clone)),
        "t=$(git rev-parse --show-toplevel 2>/dev/null)".into(),
        "if [ -z \"$t\" ]; then".into(),
        "  c=$(cd \"$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)\" 2>/dev/null && pwd -P)".into(),
        format!(
            "  for d in \"$(sed -n 's,/\\.git$,,p' gitdir 2>/dev/null)\" {}; do",
            sh_quote(&beside)
        ),
        "    [ -n \"$d\" ] && [ -d \"$d\" ] || continue".into(),
        "    d=$(cd \"$d\" 2>/dev/null && pwd -P) || continue".into(),
        "    [ -n \"$c\" ] && [ \"$(cd \"$(git -C \"$d\" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)\" 2>/dev/null && pwd -P)\" = \"$c\" ] || continue".into(),
        "    t=$(git -C \"$d\" rev-parse --show-toplevel 2>/dev/null) && [ -n \"$t\" ] && break".into(),
        "  done".into(),
        "fi".into(),
        "printf \"TOP\\t%s\\n\" \"$t\"".into(),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

/// The checkout [`home_source_script`] printed; empty when there is none.
pub fn parse_home_source(stdout: &str) -> String {
    let top = stdout
        .split('\n')
        .find_map(|line| line.strip_prefix("TOP\t"))
        .map(js::trim)
        .unwrap_or("");
    if top.starts_with('/') {
        top.to_owned()
    } else {
        String::new()
    }
}

/// Makes the home's worktree with git, from an existing worktree of the
/// repository (`git worktree add` needs no work tree of the clone), on a
/// new branch at the request's head. Prints `MADE <path>`; the exit code
/// says which step failed ([`home_worktree_error`]).
pub fn home_worktree_script(from: &str, path: &str, branch: &str, sha: &str) -> String {
    [
        format!("cd {} 2>/dev/null || exit 2", sh_quote(from)),
        format!("mkdir -p \"$(dirname {})\" || exit 3", sh_quote(path)),
        format!(
            "git worktree add -q -b {} {} {} >&2 || exit 4",
            sh_quote(branch),
            sh_quote(path),
            sh_quote(sha)
        ),
        format!(
            "printf \"MADE %s\\n\" \"$(cd {} && pwd -P)\"",
            sh_quote(path)
        ),
    ]
    .join("\n")
}

/// Why [`home_worktree_script`] failed: the command and directory, with
/// git's words.
pub fn home_worktree_error(
    result: &ShellResult,
    from: &str,
    path: &str,
    branch: &str,
    sha: &str,
) -> String {
    let output = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    let said = js::slice16(js::trim(output), -300, None);
    let command = format!(
        "git -C {from} worktree add -b {branch} {path} {}",
        js::head16(sha, 12)
    );
    match result.code {
        2 => format!("cannot enter {from}"),
        3 => format!("cannot create the directory of {path}"),
        _ if said.is_empty() => format!("{command} failed"),
        _ => format!("{command} failed: {said}"),
    }
}

static NOT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").expect("pattern"));
static NAME_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-.]+").expect("pattern"));
static LAST_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/[^/]*$").expect("pattern"));

/// Where a home made with git goes: beside the review worktree.
pub fn home_worktree_path(review_worktree: &str, branch: &str) -> String {
    let name = NOT_NAME.replace_all(branch, "-");
    let name = NAME_START.replace(&name, "");
    let trimmed = TRAILING_SLASHES.replace(review_worktree, "");
    let parent = LAST_PART.replace(&trimmed, "");
    format!("{parent}/{}", if name.is_empty() { "home" } else { &name })
}

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f]+").expect("pattern"));

/// Control characters out of text from a forge, before it reaches an agent.
fn plain(text: &str) -> String {
    js::trim(&CONTROL.replace_all(text, " ")).to_owned()
}

/// `a || b` on a request's text field.
fn or_text<'a>(item: &'a Obj, name: &str, fallback: &'a str) -> &'a str {
    match js::sv(item.get(name)) {
        "" => fallback,
        text => text,
    }
}

/// The first prompt of a request's home agent, from the setting.
pub fn home_prompt_for(template: &str, item: &Obj) -> String {
    let url = js::sv(item.get("url"));
    let reference = forge_ref_label(item, false);
    let title = js::head16(&plain(js::sv(item.get("title"))), 300);
    let author = js::head16(&plain(or_text(item, "author", "unknown")), 100);
    let target = js::head16(
        &plain(or_text(item, "targetBranch", "its target branch")),
        200,
    );
    let source = js::head16(&plain(or_text(item, "sourceBranch", "")), 200);
    home_prompt(
        template,
        &[
            ("url", url),
            ("ref", &reference),
            ("title", &title),
            ("author", &author),
            ("target", &target),
            ("source", &source),
            ("project", js::sv(item.get("project"))),
        ],
    )
}

/// Where a request's review is opened: a workspace on a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceAt {
    pub connection_id: String,
    pub workspace_id: String,
}

/// A worktree made through the user's worktree path (or Herdr's).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MadeWorktree {
    pub path: String,
    pub workspace_id: Option<String>,
}

/// A request by its key (`deps.item`, which throws when it is unknown).
pub type HomeItemFn = Arc<dyn Fn(&str) -> RpcResult<Obj> + Send + Sync>;
/// The project's clone, review worktree and workspace, made when missing
/// (`opener.project`): its connection and `MrProjectRecord`.
pub type ProjectFn = Arc<
    dyn Fn(Obj) -> BoxFuture<'static, RpcResult<Option<(Arc<dyn MrConnection>, Obj)>>>
        + Send
        + Sync,
>;
/// A worktree workspace through the user's worktree path:
/// `{connectionId, workspaceId, branch}`.
pub type CreateWorktreeFn =
    Arc<dyn Fn(Obj) -> BoxFuture<'static, Result<MadeWorktree, String>> + Send + Sync>;
/// Puts a new workspace where the project's reviews go in the tree:
/// `{projectKey, connectionId, workspaceId, label, worktree, clone}`.
pub type PlaceWorkspaceFn =
    Arc<dyn Fn(Obj) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;
/// The review pane's open (review service): `{connectionId, workspaceId,
/// root, url, title, paneId?}` gives a `ReviewSnapshot`.
pub type OpenReviewFn = Arc<dyn Fn(Obj) -> BoxFuture<'static, RpcResult<Value>> + Send + Sync>;
/// The user saw a request (`inbox.markSeen`).
pub type MarkSeenFn = Arc<dyn Fn(&str) + Send + Sync>;

/// What [`MrHomes`] needs (`createMrHomes`' deps).
#[derive(Clone)]
pub struct MrHomesDeps {
    pub item: HomeItemFn,
    pub store: Arc<Mutex<MrStore>>,
    pub connections: ConnectionsFn,
    /// The reviews settings in effect (their `homePrompt`).
    pub settings: SettingsFn,
    pub project: ProjectFn,
    pub create_worktree: Option<CreateWorktreeFn>,
    pub place_workspace: Option<PlaceWorkspaceFn>,
    pub open_review: OpenReviewFn,
    pub mark_seen: MarkSeenFn,
    pub start_mode: Option<StartModeFn>,
    /// The new session's profile command; None: plain claude.
    pub agent_command: Option<AgentCommandFn>,
    /// How long the background delivery keeps trying.
    pub deliver_ms: u64,
    pub poll_ms: u64,
    pub logger: Logger,
}

impl MrHomesDeps {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        item: HomeItemFn,
        store: Arc<Mutex<MrStore>>,
        connections: ConnectionsFn,
        settings: SettingsFn,
        project: ProjectFn,
        open_review: OpenReviewFn,
        mark_seen: MarkSeenFn,
    ) -> MrHomesDeps {
        MrHomesDeps {
            item,
            store,
            connections,
            settings,
            project,
            create_worktree: None,
            place_workspace: None,
            open_review,
            mark_seen,
            start_mode: None,
            agent_command: None,
            deliver_ms: 10 * 60_000,
            poll_ms: 1_000,
            logger: Logger::silent(),
        }
    }
}

type Delivery = Shared<BoxFuture<'static, bool>>;
type Start = Shared<BoxFuture<'static, RpcResult<Obj>>>;

struct Homes {
    deps: MrHomesDeps,
    /// One start at a time per request.
    starting: Mutex<HashMap<String, Start>>,
    /// Each request's prompt delivery under way (tests wait for it).
    deliveries: Mutex<HashMap<String, Delivery>>,
}

/// Requests' homes (`createMrHomes`): a cheap clone.
#[derive(Clone)]
pub struct MrHomes(Arc<Homes>);

fn fields(pairs: &[(&str, Value)]) -> LogFields {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn trim_slashes(path: Option<&Value>) -> &str {
    match path.and_then(Value::as_str) {
        Some(path) => path.trim_end_matches('/'),
        None => "",
    }
}

fn absolute(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|path| path.starts_with('/'))
        .map(str::to_owned)
}

/// `a || b` on two fields of a record.
fn either<'a>(record: &'a Value, a: &str, b: &str) -> Option<&'a Value> {
    match record.get(a) {
        Some(value) if crate::inbox::truthy(Some(value)) => Some(value),
        _ => record.get(b),
    }
}

/// `(stderr || stdout).trim().slice(-n)`.
fn said(result: &ShellResult, n: i64) -> String {
    let output = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    js::slice16(js::trim(output), -n, None)
}

static NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"NAME (\S+)").expect("pattern"));
static MADE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^MADE (/.*)$").expect("pattern"));
static AT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^AT ").expect("pattern"));

impl MrHomes {
    pub fn new(deps: MrHomesDeps) -> MrHomes {
        MrHomes(Arc::new(Homes {
            deps,
            starting: Mutex::new(HashMap::new()),
            deliveries: Mutex::new(HashMap::new()),
        }))
    }

    fn deps(&self) -> &MrHomesDeps {
        &self.0.deps
    }

    fn info(&self, message: &str, pairs: &[(&str, Value)]) {
        self.deps().logger.info(message, Some(&fields(pairs)));
    }

    fn connection(&self, id: &str) -> RpcResult<Arc<dyn MrConnection>> {
        (self.deps().connections)()
            .into_iter()
            .find(|conn| conn.id() == id)
            .ok_or_else(|| {
                RpcError::with_code(format!("the connection {id} is not ready"), "unavailable")
            })
    }

    /// The folder a workspace works in: its checkout, else its first pane's.
    async fn folder_of(
        &self,
        conn: &dyn MrConnection,
        workspace_id: &str,
    ) -> RpcResult<Option<String>> {
        let listed = herdr(conn, "workspace.list", json!({})).await?;
        let Some(workspace) = workspaces_of(&listed)
            .into_iter()
            .find(|each| each.get("workspace_id").and_then(Value::as_str) == Some(workspace_id))
        else {
            return Ok(None);
        };
        let checkout = workspace
            .get("worktree")
            .and_then(|w| w.get("checkout_path"));
        let own = match checkout {
            Some(value) if crate::inbox::truthy(Some(value)) => Some(value),
            _ => workspace.get("cwd"),
        };
        if let Some(own) = absolute(own) {
            return Ok(Some(own));
        }
        let panes = conn
            .herdr("pane.list", json!({}))
            .await
            .unwrap_or(Value::Null);
        let pane = panes_of(&panes)
            .into_iter()
            .find(|each| each.get("workspace_id").and_then(Value::as_str) == Some(workspace_id));
        Ok(pane.and_then(|pane| absolute(either(&pane, "foreground_cwd", "cwd"))))
    }

    /// Opens the request's review in one of its workspaces: its head
    /// fetched into that checkout first (read only), from the remote that
    /// is the project when it has one. `{connectionId, workspaceId,
    /// sessionId, snapshot, root}`.
    pub async fn open_in(
        &self,
        key: &str,
        at: &WorkspaceAt,
        pane_id: Option<&str>,
    ) -> RpcResult<Obj> {
        let item = (self.deps().item)(key)?;
        let conn = self.connection(&at.connection_id)?;
        let Some(folder) = self.folder_of(&*conn, &at.workspace_id).await? else {
            return Err(RpcError::with_code(
                "that workspace is not open any more",
                "not_found",
            ));
        };
        let read = parse_home_root(&conn.run(&home_root_script(&folder), 30_000).await.stdout);
        if read.top.is_empty() {
            return Err(RpcError::invalid(format!("{folder} is not a Git checkout")));
        }
        let project = ProjectRef::of(&item);
        let remote = read
            .remotes
            .iter()
            .find(|each| remote_is_project(&each.url, &project));
        if crate::inbox::truthy(item.get("headSha")) {
            let source = match remote {
                Some(remote) => remote.name.clone(),
                None => project_url(&project.host, &project.project),
            };
            let want = FetchWant::of(&item);
            let fetched = conn
                .run(
                    &fetch_script(
                        &read.top,
                        &source,
                        &project.provider,
                        std::slice::from_ref(&want),
                    ),
                    180_000,
                )
                .await;
            if parse_fetch(&fetched.stdout)
                .missing
                .contains(&(want.number as i64))
            {
                self.info(
                    "request head not fetched in its home",
                    &[("mr", json!(key))],
                );
            }
        }
        let mut params = Obj::new();
        params.insert("connectionId".into(), json!(conn.id()));
        params.insert("workspaceId".into(), json!(at.workspace_id));
        params.insert("root".into(), json!(read.top));
        params.insert(
            "url".into(),
            item.get("url").cloned().unwrap_or(Value::Null),
        );
        params.insert(
            "title".into(),
            json!(js::head16(
                &format!(
                    "{} {}",
                    forge_ref_label(&item, false),
                    js::sv(item.get("title"))
                ),
                300
            )),
        );
        if let Some(pane_id) = pane_id.filter(|id| !id.is_empty()) {
            params.insert("paneId".into(), json!(pane_id));
        }
        let snapshot = (self.deps().open_review)(params).await?;
        let session_id = snapshot
            .get("session")
            .and_then(|session| session.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        {
            let conn_id = conn.id().to_owned();
            let session_id = session_id.clone();
            update_store(&self.deps().store, |state| {
                if let Some(home) = record_mut(state, "homes", key)
                    && home.get("connectionId").and_then(Value::as_str) == Some(conn_id.as_str())
                    && home.get("workspaceId").and_then(Value::as_str)
                        == Some(at.workspace_id.as_str())
                {
                    home.insert("sessionId".into(), session_id);
                }
            })?;
        }
        (self.deps().mark_seen)(key);
        let mut out = Obj::new();
        out.insert("connectionId".into(), json!(conn.id()));
        out.insert("workspaceId".into(), json!(at.workspace_id));
        out.insert("sessionId".into(), session_id);
        out.insert("snapshot".into(), snapshot);
        out.insert("root".into(), json!(read.top));
        Ok(out)
    }

    async fn agent_of(&self, conn: &dyn MrConnection, pane_id: &str) -> (Option<String>, String) {
        let answer = conn
            .herdr("agent.get", json!({"target": pane_id}))
            .await
            .unwrap_or(Value::Null);
        let agent = answer.get("agent").cloned().unwrap_or(Value::Null);
        (agent_name(&agent), agent_status(&agent))
    }

    /// Sends the prompt once the session waits for one; false: not yet.
    async fn deliver(
        &self,
        conn: &dyn MrConnection,
        pane_id: &str,
        session: &str,
        text: &str,
    ) -> Result<bool, String> {
        if conn.conversation_owned(pane_id).await.as_deref() == Some(session)
            && conn.conversation_prompt(pane_id, text).await?
        {
            return Ok(true);
        }
        let (name, status) = self.agent_of(conn, pane_id).await;
        if name.as_deref() != Some("claude") || (status != "idle" && status != "done") {
            return Ok(false);
        }
        conn.herdr("agent.prompt", json!({"target": pane_id, "text": text}))
            .await?;
        Ok(true)
    }

    /// The home's first pane: where its Claude runs.
    async fn first_pane(
        &self,
        conn: &dyn MrConnection,
        workspace_id: &str,
    ) -> RpcResult<Option<String>> {
        let listed = herdr(conn, "pane.list", json!({})).await?;
        let pane = panes_of(&listed)
            .into_iter()
            .find(|each| each.get("workspace_id").and_then(Value::as_str) == Some(workspace_id));
        Ok(pane.and_then(|pane| {
            pane.get("pane_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        }))
    }

    /// The prompt delivery of a request's home agent, while it runs.
    pub async fn delivered(&self, key: &str) -> bool {
        let delivery = self
            .0
            .deliveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned();
        match delivery {
            Some(delivery) => delivery.await,
            None => false,
        }
    }

    /// Starts Claude in the home's pane, then gives it its job once it
    /// waits for a prompt (a trust question first is fine: it is told
    /// after), in the background.
    async fn start_agent(
        &self,
        conn: Arc<dyn MrConnection>,
        key: &str,
        pane_id: Option<String>,
        text: String,
    ) -> RpcResult<Value> {
        let Some(pane_id) = pane_id else {
            return Ok(json!({"state": "none", "paneId": null}));
        };
        let (running, _) = self.agent_of(&*conn, &pane_id).await;
        if running.is_some() {
            return Ok(json!({"state": "foreign", "paneId": pane_id}));
        }
        let session = random_uuid();
        {
            let session = session.clone();
            update_store(&self.deps().store, |state| {
                if let Some(home) = record_mut(state, "homes", key) {
                    home.insert("claudeSession".into(), Value::String(session));
                }
            })?;
        }
        let mode = match &self.deps().start_mode {
            Some(mode) => mode().await,
            None => StartMode::Terminal,
        };
        // A new session: the default profile, as the review workspace's Claude.
        let command = self.deps().agent_command.clone();
        let session_id = session.clone();
        let launched = profile_launch(
            &*conn,
            &pane_id,
            &session,
            false,
            mode,
            move || async move {
                match command {
                    Some(command) => command(session_id).await,
                    None => Ok(AgentCommand::plain_claude()),
                }
            },
        )
        .await
        .map_err(RpcError::Failed)?;
        let typed = match launched {
            Some(typed) => typed,
            None => claude_command(&session, false, mode, None).map_err(RpcError::Failed)?,
        };
        herdr(
            &*conn,
            "pane.send_text",
            json!({"pane_id": pane_id, "text": typed}),
        )
        .await?;
        let homes = self.clone();
        let (key_owned, pane, told) = (key.to_owned(), pane_id.clone(), session.clone());
        let delivery: BoxFuture<'static, bool> = Box::pin(async move {
            let deps = homes.deps();
            let mut waited = 0;
            while waited < deps.deliver_ms {
                tokio::time::sleep(Duration::from_millis(deps.poll_ms)).await;
                if homes
                    .deliver(&*conn, &pane, &told, &text)
                    .await
                    .unwrap_or(false)
                {
                    homes.info("home agent prompted", &[("mr", json!(key_owned))]);
                    return true;
                }
                waited += deps.poll_ms;
            }
            homes.info(
                "home agent never got its prompt",
                &[("mr", json!(key_owned))],
            );
            false
        });
        let handle = tokio::spawn(delivery);
        let shared = async move { handle.await.unwrap_or(false) }
            .boxed()
            .shared();
        self.0
            .deliveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.to_owned(), shared);
        Ok(json!({"state": "starting", "paneId": pane_id, "session": session}))
    }

    /// The workspace of the clone's own checkout: a new worktree starts
    /// from the repository's parent workspace (Herdr refuses a linked
    /// worktree's, such as the review workspace). Opened on the checkout
    /// when none is.
    async fn clone_workspace(
        &self,
        conn: &dyn MrConnection,
        checkout: &str,
        item: &Obj,
    ) -> RpcResult<String> {
        let wanted = checkout.trim_end_matches('/');
        let listed = herdr(conn, "workspace.list", json!({})).await?;
        let found = workspaces_of(&listed).into_iter().find(|each| {
            let path = each.get("worktree").and_then(|w| w.get("checkout_path"));
            trim_slashes(path) == wanted
                || (!crate::inbox::truthy(path) && trim_slashes(each.get("cwd")) == wanted)
        });
        if let Some(id) = found
            .as_ref()
            .and_then(|each| each.get("workspace_id"))
            .and_then(Value::as_str)
        {
            return Ok(id.to_owned());
        }
        // Herdr's list may give no folder: a pane working in the clone says it.
        let panes = conn
            .herdr("pane.list", json!({}))
            .await
            .unwrap_or(Value::Null);
        let pane = panes_of(&panes).into_iter().find(|each| {
            each.get("workspace_id").is_some_and(Value::is_string)
                && (trim_slashes(each.get("cwd")) == wanted
                    || trim_slashes(each.get("foreground_cwd")) == wanted)
        });
        if let Some(pane) = pane {
            return Ok(js::sv(pane.get("workspace_id")).to_owned());
        }
        let project = js::sv(item.get("project"));
        let created = herdr(
            conn,
            "workspace.create",
            json!({"cwd": checkout, "label": project.rsplit('/').next().unwrap_or(project), "focus": false}),
        )
        .await?;
        match created
            .get("workspace")
            .and_then(|w| w.get("workspace_id"))
            .and_then(Value::as_str)
        {
            Some(id) if !id.is_empty() => Ok(id.to_owned()),
            _ => Err(RpcError::with_code(
                "Herdr did not open the project's clone",
                "herdr",
            )),
        }
    }

    /// The home's worktree made with git when the clone is a repository
    /// directory with no checkout of its own: Herdr starts no worktree
    /// there (not a work tree), nor from its linked worktrees, so git makes
    /// it from the project's review worktree, beside it, and Herdr opens it
    /// as a workspace. The user's worktree path is not run.
    async fn git_worktree(
        &self,
        conn: &dyn MrConnection,
        record: &Obj,
        branch: &str,
        sha: &str,
        key: &str,
    ) -> RpcResult<MadeWorktree> {
        let review = js::sv(record.get("worktree"));
        let path = home_worktree_path(review, branch);
        let made = conn
            .run(&home_worktree_script(review, &path, branch, sha), 120_000)
            .await;
        let at = MADE
            .captures(&made.stdout)
            .map(|c| js::trim(&c[1]).to_owned())
            .filter(|at| !at.is_empty());
        let Some(at) = at.filter(|_| made.code == 0) else {
            return Err(RpcError::with_code(
                format!(
                    "cannot make the home's worktree on {}: {}",
                    conn.label(),
                    home_worktree_error(&made, review, &path, branch, sha)
                ),
                "worktree",
            ));
        };
        self.info(
            "home worktree made with git: the clone has no checkout",
            &[
                ("mr", json!(key)),
                ("clone", record.get("clone").cloned().unwrap_or(Value::Null)),
                ("path", json!(at)),
            ],
        );
        let created = herdr(
            conn,
            "workspace.create",
            json!({"cwd": at, "label": branch, "focus": false}),
        )
        .await?;
        match created
            .get("workspace")
            .and_then(|w| w.get("workspace_id"))
            .and_then(Value::as_str)
        {
            Some(id) if !id.is_empty() => Ok(MadeWorktree {
                path: at,
                workspace_id: Some(id.to_owned()),
            }),
            _ => Err(RpcError::with_code(
                format!("Herdr did not open the home's worktree {at}"),
                "herdr",
            )),
        }
    }

    /// Whether a recorded home's workspace is still there.
    async fn live_home(&self, home: &Obj) -> bool {
        let id = js::sv(home.get("connectionId"));
        let Some(conn) = (self.deps().connections)()
            .into_iter()
            .find(|c| c.id() == id)
        else {
            return false;
        };
        let listed = conn
            .herdr("workspace.list", json!({}))
            .await
            .unwrap_or(Value::Null);
        workspaces_of(&listed)
            .iter()
            .any(|each| each.get("workspace_id") == home.get("workspaceId"))
    }

    async fn start_now(&self, key: &str) -> RpcResult<Obj> {
        let item = (self.deps().item)(key)?;
        let known = js::rec(lock_store(&self.deps().store).get().get("homes"))
            .and_then(|homes| js::rec(homes.get(key)))
            .cloned();
        if let Some(known) = known
            && self.live_home(&known).await
        {
            let at = WorkspaceAt {
                connection_id: js::sv(known.get("connectionId")).to_owned(),
                workspace_id: js::sv(known.get("workspaceId")).to_owned(),
            };
            let mut opened = self.open_in(key, &at, None).await?;
            opened.insert("created".into(), json!(false));
            if let Some(branch) = known
                .get("branch")
                .filter(|b| crate::inbox::truthy(Some(b)))
            {
                opened.insert("branch".into(), branch.clone());
            }
            let session = known
                .get("claudeSession")
                .filter(|s| crate::inbox::truthy(Some(s)));
            let mut agent = Obj::new();
            agent.insert(
                "state".into(),
                json!(if session.is_some() {
                    "starting"
                } else {
                    "none"
                }),
            );
            agent.insert("paneId".into(), Value::Null);
            if let Some(session) = session {
                agent.insert("session".into(), session.clone());
            }
            opened.insert("agent".into(), Value::Object(agent));
            return Ok(opened);
        }
        let head = js::sv(item.get("headSha")).to_owned();
        if head.is_empty() {
            return Err(RpcError::invalid("the forge gave no head for this request"));
        }
        let Some(create_worktree) = self.deps().create_worktree.clone() else {
            return Err(RpcError::with_code(
                "worktrees cannot be made here",
                "unavailable",
            ));
        };
        let Some((conn, record)) = (self.deps().project)(item.clone()).await? else {
            return Err(RpcError::with_code(
                format!(
                    "no clone of {} is known: open its review once to pick one",
                    js::sv(item.get("project"))
                ),
                "not_found",
            ));
        };
        if !crate::inbox::truthy(record.get("workspaceId")) {
            return Err(RpcError::invalid(
                "the project's review workspace is missing",
            ));
        }
        let project = ProjectRef::of(&item);
        let clone = js::sv(record.get("clone")).to_owned();
        // Its head in the clone (shared with every linked worktree).
        let remote = match js::sv(record.get("remote")) {
            "" => project_url(&project.host, &project.project),
            remote => remote.to_owned(),
        };
        let want = FetchWant {
            number: FetchWant::of(&item).number,
            head_sha: head.clone(),
            base_sha: None,
            target_branch: None,
        };
        conn.run(
            &fetch_script(&clone, &remote, &project.provider, &[want]),
            180_000,
        )
        .await;
        let number = item.get("number").map(js::to_text).unwrap_or_default();
        let branched = conn
            .run(
                &home_branch_script(&clone, &home_branch_name(&item), &number),
                30_000,
            )
            .await;
        let Some(named) = NAMED.captures(&branched.stdout).map(|c| c[1].to_owned()) else {
            return Err(RpcError::with_code(
                "cannot name the home's branch",
                "worktree",
            ));
        };
        // Where the worktree starts from: the clone's own checkout, never the
        // repository directory itself (no work tree: Herdr and the worktree
        // path fail there with "this operation must be run in a work tree").
        let source = parse_home_source(&conn.run(&home_source_script(&clone), 30_000).await.stdout);
        let made = if source.is_empty() {
            self.git_worktree(&*conn, &record, &named, &head, key)
                .await?
        } else {
            let workspace_id = self.clone_workspace(&*conn, &source, &item).await?;
            let mut input = Obj::new();
            input.insert("connectionId".into(), json!(conn.id()));
            input.insert("workspaceId".into(), json!(workspace_id));
            input.insert("branch".into(), json!(named));
            create_worktree(input).await.map_err(|error| {
                RpcError::with_code(
                    format!(
                        "cannot make the home's worktree from {source} on {}: {error}",
                        conn.label()
                    ),
                    "worktree",
                )
            })?
        };
        let Some(workspace_id) = made.workspace_id.clone().filter(|id| !id.is_empty()) else {
            return Err(RpcError::with_code(
                "the worktree was made without a workspace",
                "herdr",
            ));
        };
        let moved = conn
            .run(&home_checkout_script(&made.path, &head), 60_000)
            .await;
        if !AT.is_match(&moved.stdout) {
            self.info(
                "home not moved to the request's head",
                &[("mr", json!(key)), ("error", json!(said(&moved, 200)))],
            );
        }
        let label = home_label(&item);
        if let Err(error) = conn
            .herdr(
                "workspace.rename",
                json!({"workspace_id": workspace_id, "label": label}),
            )
            .await
        {
            self.info(
                "home not renamed",
                &[("mr", json!(key)), ("error", json!(error))],
            );
        }
        let home = json!({
            "connectionId": conn.id(), "workspaceId": workspace_id, "path": made.path,
            "branch": named, "at": js::iso(js::now_ms()),
        });
        update_store(&self.deps().store, |state| {
            let homes = state.entry("homes").or_insert_with(|| json!({}));
            if !homes.is_object() {
                *homes = json!({});
            }
            if let Some(homes) = homes.as_object_mut() {
                homes.insert(key.to_owned(), home);
            }
        })?;
        if let Some(place) = &self.deps().place_workspace {
            let mut params = Obj::new();
            params.insert("projectKey".into(), json!(mr_project_key(&item)));
            params.insert("connectionId".into(), json!(conn.id()));
            params.insert("workspaceId".into(), json!(workspace_id));
            params.insert("label".into(), json!(label));
            params.insert("worktree".into(), json!(made.path));
            params.insert("clone".into(), json!(clone));
            if let Err(error) = place(params).await {
                self.info(
                    "home not placed",
                    &[("mr", json!(key)), ("error", json!(error))],
                );
            }
        }
        // Its review first, bound to the pane its Claude runs in: the
        // prompt tells the agent to work in it.
        let pane_id = self.first_pane(&*conn, &workspace_id).await.unwrap_or(None);
        let at = WorkspaceAt {
            connection_id: conn.id().to_owned(),
            workspace_id: workspace_id.clone(),
        };
        let mut opened = self.open_in(key, &at, pane_id.as_deref()).await?;
        let settings = (self.deps().settings)().await;
        let text = home_prompt_for(js::sv(settings.get("homePrompt")), &item);
        let agent = match self
            .start_agent(conn.clone(), key, pane_id.clone(), text)
            .await
        {
            Ok(agent) => agent,
            Err(error) => {
                self.info(
                    "home agent not started",
                    &[("mr", json!(key)), ("error", json!(error.message()))],
                );
                json!({"state": "none", "paneId": pane_id})
            }
        };
        self.info(
            "review home made",
            &[("mr", json!(key)), ("branch", json!(named))],
        );
        opened.insert("created".into(), json!(true));
        opened.insert("branch".into(), json!(named));
        opened.insert("agent".into(), agent);
        Ok(opened)
    }

    /// "Start a review with a home": the request's home, made when it has
    /// none (`MrHomeStart`). One start at a time per request.
    pub async fn start(&self, key: &str) -> RpcResult<Obj> {
        let start = {
            let mut starting = self.0.starting.lock().unwrap_or_else(|e| e.into_inner());
            match starting.get(key) {
                Some(running) => running.clone(),
                None => {
                    let homes = self.clone();
                    let owned = key.to_owned();
                    let next = async move {
                        let result = homes.start_now(&owned).await;
                        homes
                            .0
                            .starting
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&owned);
                        result
                    }
                    .boxed()
                    .shared();
                    starting.insert(key.to_owned(), next.clone());
                    next
                }
            }
        };
        start.await
    }
}

#[cfg(test)]
pub(crate) mod test_item {
    use roamgate_agents::js::Obj;
    use serde_json::{Value, json};

    /// The request of home.test.ts, with `extra` over it.
    pub fn item(extra: Value) -> Obj {
        let mut base = json!({
            "provider": "gitlab", "host": "gitlab.example.org",
            "project": "gstreamer/gstreamer", "number": 3326,
            "key": "gitlab:gitlab.example.org/gstreamer/gstreamer#3326",
            "url": "https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326",
            "title": "rtpgccbwe: Fix the estimate when packets are lost in bursts of many",
            "author": "alice", "draft": false, "state": "open",
            "updatedAt": "2026-11-23T00:00:00.000Z", "headSha": "abc1234",
            "sourceBranch": "gcc-fix", "targetBranch": "main", "pipeline": null,
            "notes": 0, "reasons": ["review_requested"],
        });
        let map = base.as_object_mut().unwrap();
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            map.insert(key, value);
        }
        map.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::test_item::item;
    use super::*;
    use crate::shared::types::DEFAULT_HOME_PROMPT;
    use serde_json::json;

    #[test]
    fn a_homes_name_branch_and_prompt() {
        assert_eq!(
            home_label(&item(json!({}))),
            "!3326 rtpgccbwe: Fix the estimate when packets are lost in\u{2026}"
        );
        assert_eq!(
            home_label(&item(json!({"title": "short", "provider": "github"}))),
            "#3326 short"
        );
        assert_eq!(
            home_branch_name(&item(json!({"sourceBranch": "me/fix it.."}))),
            "me/fix-it"
        );
        assert_eq!(
            home_branch_name(&item(json!({"sourceBranch": "main"}))),
            "review/3326"
        );
        let text = home_prompt_for("", &item(json!({"title": "evil\n/clear title"})));
        assert!(text.contains(
            "home of the review of https://gitlab.example.org/gstreamer/gstreamer/-/merge_requests/3326"
        ));
        assert!(text.contains("\"evil /clear title\" by alice, into main"));
        assert!(text.contains("pending drafts"));
        assert!(text.contains("Never post to the forge"));
        assert!(DEFAULT_HOME_PROMPT.contains("{url}"));
        assert_eq!(
            home_prompt_for("Review {ref} ({source})", &item(json!({}))),
            "Review gstreamer/gstreamer!3326 (gcc-fix)"
        );
        assert_eq!(
            parse_home_root("T\t/a/b\nR\torigin\tgit@h:g/p.git\nR\tbad\n").remotes,
            vec![HomeRemote {
                name: "origin".into(),
                url: "git@h:g/p.git".into()
            }]
        );
        // mrHomeLinks (the shared review workspace is no home) is the web
        // panel's, not the server's: it stays with the TS test.
    }

    #[test]
    fn the_scripts_are_buns_text() {
        assert_eq!(
            home_root_script("/a b"),
            "cd '/a b' 2>/dev/null || exit 2\nprintf \"T\\t%s\\n\" \"$(git rev-parse --show-toplevel 2>/dev/null)\"\ngit config --get-regexp '^remote\\..*\\.url$' 2>/dev/null | while read -r k v; do n=${k#remote.}; printf \"R\\t%s\\t%s\\n\" \"${n%.url}\" \"$v\"; done\nexit 0"
        );
        assert!(home_source_script("/src/gst.git/").contains(
            "  for d in \"$(sed -n 's,/\\.git$,,p' gitdir 2>/dev/null)\" '/src/gst'; do"
        ));
        assert_eq!(parse_home_source("x\nTOP\t/src/gst \n"), "/src/gst");
        assert_eq!(parse_home_source("TOP\t\n"), "");
        assert_eq!(
            home_worktree_path("/src/p.worktrees/review/", "me/fix"),
            "/src/p.worktrees/me-fix"
        );
        assert_eq!(
            home_worktree_path("/src/p.worktrees/review", ".."),
            "/src/p.worktrees/home"
        );
        let failed = ShellResult {
            code: 4,
            stdout: String::new(),
            stderr: "fatal: no\n".into(),
        };
        assert_eq!(
            home_worktree_error(&failed, "/w", "/p", "b", "0123456789abcdef"),
            "git -C /w worktree add -b b /p 0123456789ab failed: fatal: no"
        );
        assert!(
            home_checkout_script("/p", "abc").contains(
                "git cat-file -e 'abc^{commit}' 2>/dev/null || { echo NOCOMMIT; exit 3; }"
            )
        );
        assert!(home_branch_script("/c", "fix", "3").contains("b='review/3-fix'"));
    }
}

#[cfg(test)]
mod service_tests;

#[cfg(test)]
pub(crate) mod gitdir_tests;
