//! The review service's TS suites (server/src/review/*.test.ts), one
//! module each, on a host made of closures as review/testkit.ts's
//! `reviewServiceForTest` takes its arguments.

mod anchors;
mod base;
mod feedback;
mod integrity;
mod main_suite;
mod rendered;
mod shared;
mod step;

use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use roamgate_base::clock::{BoxFuture, Clock, Interval, TokioClock};
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::host::{Ask, Load, LoadError, ReviewForge};
use super::{ReviewHost, ReviewService, ReviewServiceOptions};
use crate::model::{ReviewCommit, ReviewSession};
use crate::storage::ReviewStorage;

type Diff = Box<dyn Fn(&ReviewSession, Option<String>, Option<Vec<String>>) -> Load<Value> + Send + Sync>;
type Summary = Box<dyn Fn(&ReviewSession, Option<String>) -> Load<Value> + Send + Sync>;
type Files = Box<dyn Fn(&ReviewSession, String, String, Vec<Value>) -> Load<Value> + Send + Sync>;
type Commits = Box<dyn Fn(&ReviewSession) -> Load<Vec<ReviewCommit>> + Send + Sync>;
type PatchIds =
    Box<dyn Fn(&ReviewSession, Vec<String>) -> Load<IndexMap<String, String>> + Send + Sync>;
type Heads =
    Box<dyn Fn(&str, Vec<(String, String)>) -> Load<Vec<Option<String>>> + Send + Sync>;
type FileAt = Box<dyn Fn(&ReviewSession, String, String) -> Load<String> + Send + Sync>;
type Prompt = Box<dyn Fn(&str, &str, &str) -> Result<(), String> + Send + Sync>;
type SessionPane = Box<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;
type ReplyHow = Box<dyn Fn(&ReviewSession) -> Option<String> + Send + Sync>;

/// The host of a suite: each effect a closure, as testkit.ts passes them;
/// prompts are recorded unless `prompt` refuses them.
#[derive(Default)]
pub(crate) struct Host {
    pub diff: Option<Diff>,
    pub summary: Option<Summary>,
    pub files: Option<Files>,
    pub commits: Option<Commits>,
    pub patch_ids: Option<PatchIds>,
    pub heads: Option<Heads>,
    pub file: Option<FileAt>,
    pub prompt: Option<Prompt>,
    pub session_pane: Option<SessionPane>,
    pub reply_how: Option<ReplyHow>,
    /// What loadState answers, when the host has it.
    pub state: Option<String>,
    pub forge: Option<Arc<dyn ReviewForge>>,
    pub tools: bool,
    pub prompts: Mutex<Vec<Prompted>>,
}

#[derive(Debug, Clone)]
pub(crate) struct Prompted {
    pub connection: String,
    pub pane: String,
    pub text: String,
}

impl Host {
    pub fn texts(&self) -> Vec<String> {
        self.prompts
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.text.clone())
            .collect()
    }

    pub fn prompted(&self) -> Vec<Prompted> {
        self.prompts.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        self.prompts.lock().unwrap().clear();
    }
}

fn ready<T: Send + 'static>(value: Result<T, LoadError>) -> Load<T> {
    Box::pin(async move { value })
}

impl ReviewHost for Host {
    fn load_diff(
        &self,
        session: &ReviewSession,
        commit: Option<String>,
        paths: Option<Vec<String>>,
    ) -> Load<Value> {
        match &self.diff {
            Some(diff) => diff(session, commit, paths),
            None => ready(Ok(json!({"files": [], "truncated": false}))),
        }
    }

    fn load_summary(&self, session: &ReviewSession, commit: Option<String>) -> Option<Load<Value>> {
        self.summary.as_ref().map(|load| load(session, commit))
    }

    fn load_files(
        &self,
        session: &ReviewSession,
        base: String,
        head: String,
        files: Vec<Value>,
    ) -> Option<Load<Value>> {
        self.files
            .as_ref()
            .map(|load| load(session, base, head, files))
    }

    fn load_commits(&self, session: &ReviewSession) -> Option<Load<Vec<ReviewCommit>>> {
        self.commits.as_ref().map(|load| load(session))
    }

    fn load_patch_ids(
        &self,
        session: &ReviewSession,
        shas: Vec<String>,
    ) -> Option<Load<IndexMap<String, String>>> {
        self.patch_ids.as_ref().map(|load| load(session, shas))
    }

    fn load_state(&self, _: &ReviewSession) -> Option<Load<String>> {
        self.state.clone().map(|state| ready(Ok(state)))
    }

    fn load_heads(
        &self,
        connection_id: &str,
        entries: Vec<(String, String)>,
    ) -> Option<Load<Vec<Option<String>>>> {
        self.heads.as_ref().map(|load| load(connection_id, entries))
    }

    fn load_file(&self, session: &ReviewSession, rev: String, path: String) -> Option<Load<String>> {
        self.file.as_ref().map(|load| load(session, rev, path))
    }

    fn can_prompt(&self) -> bool {
        true
    }

    fn prompt_agent(&self, connection_id: &str, pane_id: &str, text: String) -> Ask<()> {
        let outcome = match &self.prompt {
            Some(prompt) => prompt(connection_id, pane_id, &text),
            None => Ok(()),
        };
        if outcome.is_ok() {
            self.prompts.lock().unwrap().push(Prompted {
                connection: connection_id.into(),
                pane: pane_id.into(),
                text,
            });
        }
        Box::pin(async move { outcome })
    }

    fn session_pane(&self, connection_id: &str, session_id: &str) -> Option<Ask<Option<String>>> {
        let pane = self.session_pane.as_ref()?(connection_id, session_id);
        Some(Box::pin(async move { Ok(pane) }))
    }

    fn agent_tools(&self, _: &str, _: &str) -> bool {
        self.tools
    }

    fn chat_reply_how(&self, session: &ReviewSession) -> Option<String> {
        self.reply_how.as_ref().and_then(|how| how(session))
    }

    fn forge(&self) -> Option<Arc<dyn ReviewForge>> {
        self.forge.clone()
    }
}

/// A clock on tokio's time that a test moves on by hand, as the TS suites
/// pass `now: () => new Date(at)`.
#[derive(Clone)]
pub(crate) struct Moved {
    base: TokioClock,
    shift: Arc<AtomicI64>,
}

impl Moved {
    pub fn at(epoch: i64) -> Self {
        Self {
            base: TokioClock::starting_at(epoch),
            shift: Arc::default(),
        }
    }

    pub fn advance(&self, ms: i64) {
        self.shift.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for Moved {
    fn now(&self) -> i64 {
        self.base.now() + self.shift.load(Ordering::SeqCst)
    }

    fn monotonic(&self) -> f64 {
        self.base.monotonic()
    }

    fn sleep_until(&self, deadline: i64) -> BoxFuture<()> {
        let wait = (deadline - self.now()).max(0) as u64;
        self.base.sleep(Duration::from_millis(wait))
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<()> {
        self.base.sleep(duration)
    }

    fn interval(&self, period: Duration) -> Interval {
        self.base.interval(period)
    }
}

/// What a suite changes of testkit's defaults.
#[derive(Default)]
pub(crate) struct Options {
    pub delivery_delay_ms: Option<u64>,
    pub retry_delay_ms: Option<u64>,
    pub session_limit: Option<usize>,
    pub clock: Option<Moved>,
}

pub(crate) struct Kit {
    pub dir: Arc<tempfile::TempDir>,
    pub service: ReviewService,
    pub host: Arc<Host>,
    pub pushes: Arc<Mutex<Vec<Value>>>,
    pub clock: Moved,
}

pub(crate) const EPOCH: i64 = 1_767_182_400_000;

/// A service on its own reviews.sqlite (`dir`, else a new one).
pub(crate) fn kit_in(dir: Option<Arc<tempfile::TempDir>>, host: Host, options: Options) -> Kit {
    let dir = dir.unwrap_or_else(|| Arc::new(tempfile::tempdir().unwrap()));
    let host = Arc::new(host);
    let clock = options.clock.clone().unwrap_or_else(|| Moved::at(EPOCH));
    let pushes: Arc<Mutex<Vec<Value>>> = Arc::default();
    let service = open_service(dir.path(), host.clone(), &options, clock.clone(), pushes.clone());
    Kit {
        dir,
        service,
        host,
        pushes,
        clock,
    }
}

pub(crate) fn kit(host: Host, options: Options) -> Kit {
    kit_in(None, host, options)
}

pub(crate) fn plain() -> Kit {
    kit(Host::default(), Options::default())
}

fn open_service(
    dir: &Path,
    host: Arc<Host>,
    options: &Options,
    clock: Moved,
    pushes: Arc<Mutex<Vec<Value>>>,
) -> ReviewService {
    let storage = ReviewStorage::open(&DataContext::new(dir, Platform::Unix, None), dir).unwrap();
    ReviewService::new(ReviewServiceOptions {
        storage,
        publish: Arc::new(move |push| pushes.lock().unwrap().push(push)),
        host,
        clock: Arc::new(clock),
        session_limit: options.session_limit,
        retry_delay_ms: options.retry_delay_ms,
        delivery_delay_ms: options.delivery_delay_ms,
        agent_search_ms: None,
    })
}

impl Kit {
    /// The same reviews.sqlite opened again, as after a restart.
    pub fn reopen(&self) -> ReviewService {
        self.service.close();
        open_service(
            self.dir.path(),
            Arc::new(Host::default()),
            &Options::default(),
            self.clock.clone(),
            Arc::default(),
        )
    }

    pub fn push_types(&self) -> Vec<String> {
        self.pushes
            .lock()
            .unwrap()
            .iter()
            .map(|p| p["type"].as_str().unwrap_or("").to_owned())
            .collect()
    }
}

/// The review testkit's suites open first.
pub(crate) fn open_range(service: &ReviewService) -> ReviewSession {
    service
        .open(&json!({
            "connectionId": "local", "root": "/repo",
            "target": {"kind": "range", "base": "main", "head": "HEAD"},
            "agent": "Claude", "paneId": "w1:p2",
        }))
        .unwrap()
        .session
}

pub(crate) async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

pub(crate) fn sha(c: &str) -> String {
    c.repeat(40)
}

pub(crate) fn commit(sha: String, subject: &str) -> ReviewCommit {
    ReviewCommit {
        sha,
        parent: None,
        author: "T".into(),
        date: "2026-11-05".into(),
        subject: subject.into(),
        body: String::new(),
        history: false,
    }
}

pub(crate) fn ids<T>(list: &[T], id: impl Fn(&T) -> String) -> Vec<String> {
    list.iter().map(id).collect()
}

pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

type Find = Box<dyn Fn(&GitlabState) -> Result<Option<Value>, String> + Send + Sync>;

/// What the fake GitLab holds: the checkout as the forge reads it, the
/// lookups and the API's writes (`posted`, one line per write).
pub(crate) struct GitlabState {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub unreadable: bool,
    pub checkouts: usize,
    pub finds: usize,
    /// Without it the API must not be read (findSetup without `glab`).
    pub api: bool,
    pub down: bool,
    pub discussions: Vec<(String, i64, String, String)>,
    pub next_draft: i64,
    pub posted: Vec<String>,
}

/// GitLab as review/gitlab.ts reads and writes it, answering what the TS
/// suites' fake glab answers.
pub(crate) struct Gitlab {
    pub state: Mutex<GitlabState>,
    find: Find,
}

impl Gitlab {
    pub fn new(find: impl Fn(&GitlabState) -> Result<Option<Value>, String> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(GitlabState {
                branch: Some("fix".into()),
                head: Some("a1".into()),
                unreadable: false,
                checkouts: 0,
                finds: 0,
                api: false,
                down: false,
                discussions: Vec::new(),
                next_draft: 21,
                posted: Vec::new(),
            }),
            find: Box::new(find),
        })
    }

    /// mergeRequestApi: one discussion, no drafts.
    pub fn with_api(self: Arc<Self>, next_draft: i64) -> Arc<Self> {
        {
            let mut state = self.state.lock().unwrap();
            state.api = true;
            state.next_draft = next_draft;
            state.discussions = vec![("d1".into(), 1, "x".into(), "Hm".into())];
        }
        self
    }

    pub fn posted(&self) -> Vec<String> {
        self.state.lock().unwrap().posted.clone()
    }

    pub fn finds(&self) -> usize {
        self.state.lock().unwrap().finds
    }

    fn api(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        if !state.api {
            return Err("glab must not run".into());
        }
        if state.down {
            return Err("GitLab: 502".into());
        }
        Ok(())
    }

    fn draft(&self, write: String) -> i64 {
        let mut state = self.state.lock().unwrap();
        state.posted.push(write);
        let id = state.next_draft;
        state.next_draft += 1;
        id
    }
}

pub(crate) const FIX_URL: &str = "https://gitlab.example/gst/gstreamer/-/merge_requests/10046";

pub(crate) fn fix_request() -> Value {
    json!({"url": FIX_URL, "title": "Fix the leak", "number": 10046, "state": "opened", "branch": "fix"})
}

fn epoch_at() -> String {
    "1970-01-01T00:00:00.000Z".into()
}

impl ReviewForge for Gitlab {
    fn checkout(&self, _: &ReviewSession) -> Load<Value> {
        let mut state = self.state.lock().unwrap();
        state.checkouts += 1;
        let value = if state.unreadable {
            Err(LoadError::Failed("ssh: host unreachable".into()))
        } else {
            Ok(json!({
                "branch": state.branch, "head": state.head, "defaultBranch": "main",
                "remoteHeads": {}, "upstream": null, "pushRemote": null, "remotes": {},
                "gitlabHost": "gitlab.example", "gitlabLogins": [],
            }))
        };
        ready(value)
    }

    fn find(&self, _: &ReviewSession, _: Value) -> Ask<Option<Value>> {
        let answer = {
            let mut state = self.state.lock().unwrap();
            state.finds += 1;
            (self.find)(&state)
        };
        Box::pin(async move { answer })
    }

    fn read_merge_request(&self, _: &ReviewSession, url: &str) -> Ask<Value> {
        let answer = self.api().map(|()| {
            let reference = crate::parse::parse_merge_request_url(url).expect("a merge request URL");
            json!({"host": reference.host, "project": reference.project, "iid": reference.iid,
                "projectPath": reference.project, "url": url, "title": "Fix", "state": "opened",
                "baseSha": "b", "startSha": "s", "headSha": "h"})
        });
        Box::pin(async move { answer })
    }

    fn read_threads(&self, session: &ReviewSession, _: &Value) -> Ask<Vec<crate::model::ReviewThread>> {
        let answer = self.api().map(|()| {
            let at = epoch_at();
            self.state
                .lock()
                .unwrap()
                .discussions
                .iter()
                .map(|(id, note, author, body)| {
                    serde_json::from_value(json!({
                        "id": format!("gl:{id}"), "sessionId": session.id, "kind": "merge-request",
                        "anchor": {}, "resolved": false,
                        "comments": [{"id": format!("gl:{id}:{note}"), "author": format!("@{author}"),
                            "body": body, "createdAt": at, "updatedAt": at}],
                        "createdAt": at, "updatedAt": at, "gitlab": {"discussionId": id},
                    }))
                    .unwrap()
                })
                .collect()
        });
        Box::pin(async move { answer })
    }

    fn create_draft_note(
        &self,
        session: &ReviewSession,
        _: &Value,
        anchor: crate::model::ReviewAnchor,
        note: String,
        _: Option<Value>,
    ) -> Ask<crate::model::ReviewThread> {
        let answer = self.api().map(|()| {
            let id = self.draft(format!("POST draft_notes note={note}"));
            draft_thread(id, &session.id, anchor, note)
        });
        Box::pin(async move { answer })
    }

    fn update_draft_note(
        &self,
        session: &ReviewSession,
        _: &Value,
        id: i64,
        note: String,
    ) -> Ask<crate::model::ReviewThread> {
        let answer = self.api().map(|()| {
            self.state
                .lock()
                .unwrap()
                .posted
                .push(format!("PUT draft_notes/{id} note={note}"));
            draft_thread(id, &session.id, Default::default(), note)
        });
        Box::pin(async move { answer })
    }

    fn delete_draft_note(&self, _: &ReviewSession, _: &Value, id: i64) -> Ask<()> {
        let answer = self.api().map(|()| {
            self.state
                .lock()
                .unwrap()
                .posted
                .push(format!("DELETE draft_notes/{id}"));
        });
        Box::pin(async move { answer })
    }

    fn create_draft_reply(
        &self,
        _: &ReviewSession,
        _: &Value,
        discussion: &str,
        note: String,
    ) -> Ask<crate::model::ReviewComment> {
        let answer = self.api().map(|()| {
            let id = self.draft(format!(
                "POST draft_notes in_reply_to_discussion_id={discussion} note={note}"
            ));
            let at = epoch_at();
            serde_json::from_value(json!({
                "id": format!("gldraft:{id}"), "author": "you", "body": note,
                "createdAt": at, "updatedAt": at, "gitlabDraftId": id,
            }))
            .unwrap()
        });
        Box::pin(async move { answer })
    }
}

fn draft_thread(
    id: i64,
    session: &str,
    anchor: crate::model::ReviewAnchor,
    note: String,
) -> crate::model::ReviewThread {
    let at = epoch_at();
    serde_json::from_value(json!({
        "id": format!("gldraft:{id}"), "sessionId": session, "kind": "draft",
        "anchor": anchor, "resolved": false,
        "comments": [{"id": format!("gldraft:{id}"), "author": "you", "body": note,
            "createdAt": at, "updatedAt": at}],
        "createdAt": at, "updatedAt": at, "gitlab": {"draftId": id},
    }))
    .unwrap()
}

/// The repository's root.
pub(crate) fn repo() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

/// bun, when it is on PATH: the suites on a real checkout read it with
/// the review loaders the TS suites use (workspace/review-patch.ts, Bun's
/// until S17 ports them), so they skip, saying why, without it.
pub(crate) fn bun() -> Option<std::path::PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("bun"))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the review loaders cannot read the checkout");
    }
    found
}

const LOADER: &str = r#"
const repo = process.env.ROAMGATE_REPO;
const patch = await import(`${repo}/server/src/workspace/review-patch.ts`);
const { runProcessWithCodeTimeout, shQuote } = await import(`${repo}/server/src/utils/process-utils.ts`);
const [op, raw] = process.argv.slice(-2);
const args = { ...JSON.parse(raw), shQuote, runProcessWithCodeTimeout };
const read = {
  patch: () => patch.readReviewPatch(args),
  commitPatch: () => patch.readReviewCommitPatch(args),
  commits: () => patch.readReviewCommits(args),
  heads: () => patch.readReviewHeads(args),
  patchIds: () => patch.readReviewPatchIds(args),
  defaultBase: () => patch.readDefaultBase(args),
}[op];
try {
  console.log(JSON.stringify({ ok: (await read()) ?? null }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error?.message ?? error), code: error?.code }));
}
"#;

/// One read of review-patch.ts, through bun.
pub(crate) fn load_with(bun: &Path, op: &str, args: Value) -> BoxFuture<Result<Value, LoadError>> {
    let mut command = tokio::process::Command::new(bun);
    command
        .current_dir(repo().join("server"))
        .env("ROAMGATE_REPO", repo())
        .arg("-e")
        .arg(LOADER)
        .arg(op)
        .arg(args.to_string());
    Box::pin(async move {
        let output = command
            .output()
            .await
            .map_err(|error| LoadError::Failed(error.to_string()))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.lines().last().unwrap_or("");
        let answer: Value = serde_json::from_str(line).map_err(|_| {
            LoadError::Failed(format!(
                "bun: {}{}",
                text,
                String::from_utf8_lossy(&output.stderr)
            ))
        })?;
        match (answer.get("ok"), answer["error"].as_str()) {
            (Some(value), _) => Ok(value.clone()),
            (None, Some(message)) => Err(match answer["code"].as_str() {
                Some(code) if crate::model::is_review_gone_code(code) => LoadError::Gone {
                    code: code.into(),
                    message: message.into(),
                },
                _ => LoadError::Failed(message.into()),
            }),
            _ => Err(LoadError::Failed(line.into())),
        }
    })
}

/// A host whose git reads are review-patch.ts's, as the TS suites wire
/// them: a commit's patch, else the review's; its commits, heads and
/// patch ids.
pub(crate) fn git_host(bun: &Path) -> Host {
    let (diff, commits, ids, heads) = (bun.to_owned(), bun.to_owned(), bun.to_owned(), bun.to_owned());
    Host {
        diff: Some(Box::new(move |session, commit, paths| match commit {
            Some(commit) => load_with(&diff, "commitPatch", json!({"root": session.root, "commit": commit})),
            None => load_with(
                &diff,
                "patch",
                json!({"root": session.root, "target": session.target.to_value(), "paths": paths}),
            ),
        })),
        commits: Some(Box::new(move |session| {
            let load = match &session.target {
                crate::model::ReviewTarget::Range { base, head, .. } => Some(load_with(
                    &commits,
                    "commits",
                    json!({"root": session.root, "base": base, "head": head}),
                )),
                _ => None,
            };
            Box::pin(async move {
                let Some(load) = load else {
                    return Ok(Vec::new());
                };
                serde_json::from_value(load.await?).map_err(|error| LoadError::Failed(error.to_string()))
            })
        })),
        patch_ids: Some(Box::new(move |session, shas| {
            let load = load_with(&ids, "patchIds", json!({"root": session.root, "shas": shas}));
            Box::pin(async move {
                serde_json::from_value(load.await?).map_err(|error| LoadError::Failed(error.to_string()))
            })
        })),
        heads: Some(Box::new(move |_, entries| {
            let entries: Vec<Value> = entries
                .into_iter()
                .map(|(root, reference)| json!({"root": root, "ref": reference}))
                .collect();
            let load = load_with(&heads, "heads", json!({"entries": entries}));
            Box::pin(async move {
                serde_json::from_value(load.await?).map_err(|error| LoadError::Failed(error.to_string()))
            })
        })),
        ..Host::default()
    }
}

/// git in a test repository, with no user or system configuration.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("HOME", "/nonexistent")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Waits (a few seconds at most) until `done` holds.
pub(crate) async fn until(mut done: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        if done() {
            return true;
        }
        sleep(10).await;
    }
    done()
}
