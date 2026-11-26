//! The Work board's service (server/src/work/service.ts): the items and
//! projects of the store, their threads (one review per item, target
//! `work`, delivered to the owner as an effort's are to its leader), the
//! For you notification, and the done rule (a commit landed where the
//! project says). Every change is pushed to the pages as `work`.
//!
//! The store is read and written under a short lock, never held across an
//! await: the operations interleave at their awaits as the TS service's do
//! on its event loop.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use roamgate_base::clock::SharedClock;

use crate::model::{
    By, REVIEW_USER, ReviewSession, ReviewSnapshot, ReviewThread, WORK_DESCRIPTION_CHARS,
    WORK_OPEN_STATES, WorkDoneRule, WorkItem, WorkLink, WorkOwner, WorkProject, WorkPush, WorkRoot,
    limits,
};
use crate::shared::{
    WorkFilter, WorkLinkRoot, WorkPlace, describe_work_link, filter_work_items,
    is_absolute_work_path, is_work_workspace_tag, normalize_work_tag, parse_agent_address,
    parse_title_line, provisional_work_title, work_description_thread, work_landing_makes_done,
    work_link_roots, work_open_questions, work_place_tag_for, work_project_family,
    work_project_for_paths, work_state_asks, work_workspace_tag,
};
use crate::store::{
    Params, WorkActor, WorkError, WorkResult, WorkStore, given, merge_work_links, new_work_id,
    parse_done_rule, parse_work_answers, parse_work_ask, parse_work_coordinator, parse_work_link,
    parse_work_links, parse_work_owner, parse_work_source, parse_work_state, parse_work_tags,
    parse_work_time, parse_work_title, work_link_key,
};
use crate::tags::auto_work_tags;
use crate::text::{
    js_regex, js_trim, locale_compare, one_line, slice_utf16, unix_lines, utf16_len,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const WORK_ROAMGATE_PROJECT: &str = "roamgate";
/// The done rules are checked this often.
pub const WORK_CHECK_MS: u64 = 10 * 60_000;
/// The deployed build is read this often.
pub const WORK_DEPLOYED_MS: u64 = 60_000;
/// How long placing a workspace may wait on its connection.
pub const WORK_PLACE_MS: u64 = 3_000;
/// The most images an item is added with.
pub const WORK_ADD_IMAGES: usize = 8;

/// What an agent is told when it leaves the user nothing to do.
pub const WORK_ASK_REQUIRED: &str = "an item in For you (you) or Verify (verify) says what the user has to do: give ask, one or two sentences from the item and its thread (\"Choose: media to the car with the phone mic, or no music on car links\", \"Dictate once after 10 idle minutes; text should appear\"), and for a decision answers, a few short one-tap choices";

/// Who makes a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkMeta {
    pub by: By,
    /// The agent's name, in what the user is told ("Claude in roamgate").
    pub caller: Option<String>,
    /// The agent's session address: its own items need no telling.
    pub address: Option<String>,
    pub summary: Option<String>,
}

impl WorkMeta {
    pub fn user() -> Self {
        Self {
            by: By::User,
            caller: None,
            address: None,
            summary: None,
        }
    }

    pub fn agent(caller: impl Into<String>, address: Option<String>) -> Self {
        Self {
            by: By::Agent,
            caller: Some(caller.into()),
            address,
            summary: None,
        }
    }

    fn is_agent(&self) -> bool {
        self.by == By::Agent
    }
}

fn summary_of(meta: &WorkMeta, what: &str) -> String {
    meta.summary
        .clone()
        .unwrap_or_else(|| format!("{} {what}", meta.caller.as_deref().unwrap_or("Claude")))
}

fn actor_of(meta: &WorkMeta) -> WorkActor {
    WorkActor {
        by: meta.by,
        address: meta.address.clone().filter(|_| meta.is_agent()),
        caller: meta.caller.clone().filter(|_| meta.is_agent()),
    }
}

/// The agent's bare name from its caller line ("Claude in roamgate").
fn agent_name_of(meta: &WorkMeta) -> String {
    let caller = meta.caller.as_deref().unwrap_or("Claude");
    let name = caller.split(" in ").next().unwrap_or("");
    if name.is_empty() {
        "Claude".into()
    } else {
        name.into()
    }
}

/// What a git run gave: its exit code (None when it did not run) and
/// output.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GitRead {
    pub code: Option<i32>,
    pub stdout: String,
}

/// A pane, as Herdr lists it.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct Pane {
    pub pane_id: String,
    pub workspace_id: Option<String>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
}

/// A workspace, as Herdr lists it.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct Workspace {
    pub workspace_id: String,
    pub label: Option<String>,
    pub worktree: Option<WorkspaceTree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct WorkspaceTree {
    pub checkout_path: Option<String>,
    pub repo_root: Option<String>,
}

/// What the board asks of the review service.
pub trait WorkReviews: Send + Sync {
    /// The item's review, wherever it was opened.
    fn find(&self, item: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>>;
    /// Makes the item's review (target `work`), or answers the existing one.
    fn open(
        &self,
        item: &str,
        connection_id: &str,
        root: &str,
        title: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewSnapshot>>;
    /// A review and its threads, by id (a prefix is enough).
    fn get(&self, review: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSnapshot>>>;
    /// The review a thread or comment id belongs to.
    fn session_of_comment(&self, id: &str) -> BoxFuture<'_, WorkResult<Option<ReviewSession>>>;
    /// A new thread, by an author (an agent's name, or the user).
    fn add_thread(
        &self,
        session_id: &str,
        author: &str,
        text: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>>;
    /// A thread of any review becomes this review's.
    fn move_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>>;
    /// A thread's anchor replaced in its own review.
    fn set_anchor(
        &self,
        session_id: &str,
        thread_id: &str,
        anchor: Value,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>>;
    /// Stores an image of the review; its path.
    fn add_image(
        &self,
        session_id: &str,
        kind: &str,
        data: Vec<u8>,
    ) -> BoxFuture<'_, WorkResult<String>>;
    /// Rewrites a comment, as its author.
    fn edit_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
        text: &str,
    ) -> BoxFuture<'_, WorkResult<ReviewThread>>;
    /// Deletes a comment (its thread, when the first): the id deleted and
    /// the thread left, if any.
    fn delete_comment(
        &self,
        session_id: &str,
        comment_id: &str,
        author: &str,
    ) -> BoxFuture<'_, WorkResult<(String, Option<ReviewThread>)>>;
}

/// What the board asks of what it does not own.
pub trait WorkDeps: Send + Sync + 'static {
    /// Tells every page (`{work: push}`).
    fn publish(&self, _push: WorkPush) {}
    fn reviews(&self) -> Option<&dyn WorkReviews> {
        None
    }
    /// The For you notification: published (`true`) or cleared.
    fn notify(&self, _item: &WorkItem, _publish: bool) {}
    fn has_git(&self) -> bool {
        false
    }
    /// git in a checkout, on its connection (none: local).
    fn git<'a>(
        &'a self,
        _root: &'a str,
        _args: Vec<String>,
        _connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, GitRead> {
        Box::pin(async { GitRead::default() })
    }
    fn has_read_file(&self) -> bool {
        false
    }
    /// A file of a checkout's working tree, on its connection.
    fn read_file<'a>(
        &'a self,
        _root: &'a str,
        _path: &'a str,
        _connection_id: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    /// The addresses of the agent sessions Roamgate manages; None when the
    /// owner is not checked.
    fn sessions(&self) -> Option<BoxFuture<'_, WorkResult<Vec<String>>>> {
        None
    }
    /// The deployed build of this Roamgate.
    fn deployed(&self) -> Option<String> {
        None
    }
    /// This Roamgate's own checkout.
    fn own_root(&self) -> Option<String> {
        None
    }
    /// The default connection's id.
    fn default_connection(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async { None })
    }
    /// Whether panes and workspaces can be listed.
    fn has_places(&self) -> bool {
        false
    }
    fn panes<'a>(&'a self, _connection_id: &'a str) -> BoxFuture<'a, Result<Vec<Pane>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn workspaces<'a>(
        &'a self,
        _connection_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Workspace>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// A connection's runtime generation.
    fn generation<'a>(&'a self, _connection_id: &'a str) -> BoxFuture<'a, Option<u64>> {
        Box::pin(async { None })
    }
    fn log(&self, _message: &str, _fields: Value) {}
}

/// An image an item is added with: its token in the text, its bytes.
struct AddImage {
    token: String,
    kind: String,
    data: Vec<u8>,
}

/// What `add` did.
#[derive(Debug, Clone)]
pub struct WorkAdded {
    pub item: WorkItem,
    /// The source named an existing item: changed instead of added.
    pub updated: bool,
    pub changed: Option<Map<String, Value>>,
    /// Parameters an update leaves aside.
    pub ignored: Option<Vec<String>>,
    /// The thread given as `adopt_thread`, now the item's own.
    pub adopted: Option<String>,
}

/// What `change` did.
#[derive(Debug)]
pub struct WorkChanged {
    pub item: WorkItem,
    pub changed: Map<String, Value>,
    pub adopted: Option<String>,
}

/// What `commentEdit` did.
#[derive(Debug)]
pub struct CommentEdited {
    pub item: WorkItem,
    pub thread: Option<ReviewThread>,
    pub deleted: Option<String>,
}

/// Where a session runs, for the page to open its chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressTarget {
    pub connection_id: String,
    pub runtime_generation: u64,
    pub workspace_id: String,
    pub pane_id: String,
    pub task: Option<String>,
}

impl AddressTarget {
    pub fn to_json(&self) -> Value {
        let mut out = json!({
            "connectionId": self.connection_id,
            "runtimeGeneration": self.runtime_generation,
            "workspaceId": self.workspace_id,
            "paneId": self.pane_id,
        });
        if let Some(task) = &self.task {
            out["task"] = json!(task);
        }
        out
    }
}

/// What `check` did.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct WorkChecked {
    pub landed: Vec<String>,
    pub recorded: Vec<String>,
    pub checked: usize,
}

/// A link's checkout, as `bridge.work.link_target` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    pub connection_id: Option<String>,
    pub root: String,
    pub path: Option<String>,
}

impl LinkTarget {
    pub fn to_json(&self) -> Value {
        let mut out = json!({"connectionId": self.connection_id, "root": self.root});
        if let Some(path) = &self.path {
            out["path"] = json!(path);
        }
        out
    }
}

/// `settleWorkAsk`: an item's ask and answers as a change leaves them.
pub fn settle_work_ask(
    before: Option<&WorkItem>,
    next: &mut WorkItem,
    params: &Params,
    meta_by: By,
    change: &mut Map<String, Value>,
) -> WorkResult<()> {
    let ask_given = params.contains_key("ask");
    let answers_given = params.contains_key("answers");
    if ask_given {
        next.ask = parse_work_ask(params.get("ask"))?;
    }
    if answers_given {
        let answers = parse_work_answers(params.get("answers"))?;
        next.answers = (!answers.is_empty()).then_some(answers);
    }
    let leaving = !work_state_asks(&next.state);
    if leaving && !ask_given {
        next.ask = None;
    }
    if leaving && !answers_given {
        next.answers = None;
    }
    if meta_by == By::Agent
        && !leaving
        && next.ask.is_none()
        && (before.is_none_or(|before| before.state != next.state) || ask_given)
    {
        return Err(WorkError::invalid(WORK_ASK_REQUIRED));
    }
    if next.ask != before.and_then(|before| before.ask.clone()) {
        change.insert("ask".into(), json!(next.ask));
    }
    let answers = |item: Option<&WorkItem>| {
        item.and_then(|item| item.answers.clone())
            .unwrap_or_default()
    };
    if answers(Some(next)) != answers(before) {
        change.insert("answers".into(), json!(next.answers));
    }
    Ok(())
}

/// An item leaving For you and Verify: its ask goes.
fn without_ask(mut item: WorkItem) -> WorkItem {
    if !work_state_asks(&item.state) {
        item.ask = None;
        item.answers = None;
    }
    item
}

static DECISION_TICK: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^{S}*[-*]{S}+\[[xX]\]"));
static ANY_HEADING: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^(#{1,6}){S}"));
static ANSWERED: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)^{S}*>?{S}*\*\*(Answered|Decided|Decision)\b"));

/// Whether a decision is decided in a file's text: its box ticked, or its
/// heading followed by a line that says it was answered or decided.
pub fn decision_decided(text: &str, id: &str) -> bool {
    let lines: Vec<&str> = text.split('\n').collect();
    let marker = format!("**{id}**");
    if let Some(ticked) = lines.iter().find(|line| line.contains(&marker))
        && DECISION_TICK.is_match(ticked)
    {
        return true;
    }
    let heading = js_regex(&format!(
        r"^(#{{1,6}}){{S}}+{}([.:)])?({{S}}|$)",
        regex::escape(id)
    ));
    for (at, line) in lines.iter().enumerate() {
        let Some(open) = heading.captures(line) else {
            continue;
        };
        // (The TS pattern's `(?![0-9])` after the id adds nothing: the
        // optional `.:)` must be followed by a space or the end.)
        let level = open[1].len();
        for line in &lines[at + 1..] {
            if let Some(other) = ANY_HEADING.captures(line)
                && other[1].len() <= level
            {
                break;
            }
            if ANSWERED.is_match(line) {
                return true;
            }
        }
        return false;
    }
    false
}

enum Fill {
    Item(String),
    Barrier(oneshot::Sender<()>),
}

struct Inner {
    store: Mutex<WorkStore>,
    deps: Arc<dyn WorkDeps>,
    clock: SharedClock,
    /// Links looked for and found nowhere, not looked for again.
    not_found: Mutex<HashSet<String>>,
    fills: Mutex<Option<mpsc::UnboundedSender<Fill>>>,
    timers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    last_deployed: Mutex<Option<String>>,
}

/// The board's service.
#[derive(Clone)]
pub struct WorkService {
    inner: Arc<Inner>,
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn str_param<'a>(params: &'a Params, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

impl WorkService {
    pub fn new(store: WorkStore, deps: Arc<dyn WorkDeps>, clock: SharedClock) -> Self {
        Self {
            inner: Arc::new(Inner {
                store: Mutex::new(store),
                deps,
                clock,
                not_found: Mutex::default(),
                fills: Mutex::default(),
                timers: Mutex::default(),
                last_deployed: Mutex::default(),
            }),
        }
    }

    fn deps(&self) -> &dyn WorkDeps {
        self.inner.deps.as_ref()
    }

    /// Reads the store under its lock.
    pub fn read<T>(&self, read: impl FnOnce(&WorkStore) -> T) -> T {
        read(&self.inner.store.lock().expect("the work store"))
    }

    fn write<T>(&self, write: impl FnOnce(&mut WorkStore) -> T) -> T {
        write(&mut self.inner.store.lock().expect("the work store"))
    }

    fn now(&self) -> String {
        crate::text::iso(self.inner.clock.now())
    }

    fn push(&self, push: WorkPush) {
        self.deps().publish(push);
    }

    fn reviews(&self) -> WorkResult<&dyn WorkReviews> {
        self.deps()
            .reviews()
            .ok_or_else(|| WorkError::with("reviews are unavailable", "unavailable"))
    }

    fn project_of(&self, reference: Option<&str>) -> WorkResult<WorkProject> {
        let id = js_trim(reference.unwrap_or(""));
        let found = self.read(|store| {
            if id.is_empty() {
                store
                    .project(WORK_ROAMGATE_PROJECT)
                    .or_else(|| store.projects().first())
                    .cloned()
            } else {
                store.project(id).cloned()
            }
        });
        found.ok_or_else(|| {
            WorkError::not_found(if id.is_empty() {
                "no project yet: work_project declares one".to_owned()
            } else {
                format!(
                    "no project {}: work_project declares one",
                    slice_utf16(id, 40)
                )
            })
        })
    }

    fn item_of(&self, reference: Option<&Value>) -> WorkResult<WorkItem> {
        let reference = reference
            .and_then(Value::as_str)
            .filter(|reference| !js_trim(reference).is_empty())
            .ok_or_else(|| WorkError::invalid("item is required"))?;
        self.read(|store| store.find(reference).cloned())
            .ok_or_else(|| {
                WorkError::not_found(format!("no work item {}", slice_utf16(reference, 20)))
            })
    }

    /// An owner's session must be one Roamgate manages.
    async fn assert_owner_known(&self, owner: Option<&WorkOwner>) -> WorkResult<()> {
        let Some(owner) = owner else { return Ok(()) };
        let Some(sessions) = self.deps().sessions() else {
            return Ok(());
        };
        let known = sessions.await?;
        if known.contains(&owner.session) {
            return Ok(());
        }
        Err(WorkError::not_found(format!(
            "no agent session Roamgate manages is at {}; agent_sessions (roamgate-review sessions) lists them as CONNECTION/PANE{}",
            owner.session,
            if known.is_empty() {
                String::new()
            } else {
                format!(
                    ", such as {}",
                    known.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
                )
            }
        )))
    }

    /// Writes an item, says so, and keeps the For you notification right.
    fn commit(
        &self,
        before: Option<&WorkItem>,
        item: WorkItem,
        meta: &WorkMeta,
        change: &Map<String, Value>,
        what: &str,
    ) -> WorkResult<WorkItem> {
        self.write(|store| store.save_item(item.clone(), Some(change), Some(&actor_of(meta))))?;
        if self.needs_link_roots(&item) {
            self.fill_link_roots_later(&item.id);
        }
        let was_you = before.is_some_and(|before| before.state == "you");
        if item.state == "you" && !was_you {
            self.deps().notify(&item, true);
        } else if item.state != "you" && was_you {
            self.deps().notify(&item, false);
        }
        self.push(WorkPush {
            changed: vec![if before.is_some() { "item" } else { "items" }],
            item: Some(item.id.clone()),
            by: meta.by,
            summary: meta.is_agent().then(|| summary_of(meta, what)),
        });
        Ok(item)
    }

    /// The seeded project: Roamgate itself, on the deployed rule.
    async fn seed(&self) -> WorkResult<()> {
        if self.read(|store| !store.projects().is_empty()) {
            return Ok(());
        }
        let connection_id = self
            .deps()
            .default_connection()
            .await
            .unwrap_or_else(|| "local".into());
        let root = self.deps().own_root();
        self.write(|store| {
            if !store.projects().is_empty() {
                return Ok(());
            }
            store.save_project(WorkProject {
                id: WORK_ROAMGATE_PROJECT.into(),
                name: "roamgate".into(),
                roots: root
                    .map(|path| {
                        vec![WorkRoot {
                            connection_id,
                            path,
                        }]
                    })
                    .unwrap_or_default(),
                done: WorkDoneRule::Deployed,
                tags: Some(vec![
                    "reviews".into(),
                    "voice".into(),
                    "android".into(),
                    "housekeeping".into(),
                ]),
                coordinator: None,
                parent: None,
            })
        })
    }

    /// The board: projects, items and the deployed build.
    pub async fn board(&self) -> WorkResult<Value> {
        self.seed().await?;
        let deployed = self.deps().deployed();
        Ok(self.read(|store| {
            let mut out = json!({"projects": store.projects(), "items": store.items()});
            if let Some(deployed) = deployed {
                out["deployed"] = json!(deployed);
            }
            out
        }))
    }

    /// [`WorkService::board`]'s text, written from the store as is.
    pub async fn board_text(&self) -> WorkResult<Box<serde_json::value::RawValue>> {
        /// The board's fields in [`WorkService::board`]'s order.
        #[derive(serde::Serialize)]
        struct Board<'a> {
            projects: &'a [WorkProject],
            items: &'a [WorkItem],
            #[serde(skip_serializing_if = "Option::is_none")]
            deployed: Option<String>,
        }
        self.seed().await?;
        let deployed = self.deps().deployed();
        self.read(|store| {
            serde_json::value::to_raw_value(&Board {
                projects: store.projects(),
                items: store.items(),
                deployed,
            })
        })
        .map_err(|error| WorkError::other(error.to_string()))
    }

    /// The items a filter keeps.
    pub async fn list(&self, params: &Params, address: Option<&str>) -> WorkResult<Vec<WorkItem>> {
        self.seed().await?;
        let states = if given(params.get("state")) {
            Some(vec![parse_work_state(params.get("state"))?])
        } else if params.get("open") == Some(&Value::Bool(true)) {
            Some(
                WORK_OPEN_STATES
                    .iter()
                    .map(|state| (*state).to_owned())
                    .collect(),
            )
        } else {
            None
        };
        let project = match str_param(params, "project").filter(|p| !js_trim(p).is_empty()) {
            Some(project) => Some(self.project_of(Some(project))?.id),
            None => None,
        };
        let mut tags = parse_work_tags(params.get("tags"))?;
        if let Some(named) = str_param(params, "workspace")
            .map(js_trim)
            .filter(|n| !n.is_empty())
        {
            let tag = if named == "self" {
                let parsed = address.and_then(parse_agent_address);
                let place = match parsed {
                    Some(parsed) => {
                        self.place_of(&parsed.connection_id, None, Some(&parsed.pane_id))
                            .await
                    }
                    None => None,
                };
                let Some(place) = place else {
                    return Err(WorkError::not_found(
                        "workspace self: your session's workspace is not known",
                    ));
                };
                work_workspace_tag(&place.label)
            } else if is_work_workspace_tag(&named.to_lowercase()) {
                Some(normalize_work_tag(named))
            } else {
                work_workspace_tag(named)
            };
            let Some(tag) = tag.filter(|tag| !tag.is_empty()) else {
                return Err(WorkError::invalid("workspace: a workspace's name or tag"));
            };
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        Ok(self.read(|store| {
            let filter = WorkFilter {
                projects: project.map(|project| work_project_family(store.projects(), &project)),
                states,
                tags,
                owner: str_param(params, "owner")
                    .filter(|owner| !owner.is_empty())
                    .map(str::to_owned),
                query: str_param(params, "query").map(str::to_owned),
                ..WorkFilter::default()
            };
            filter_work_items(store.items(), &filter)
                .into_iter()
                .cloned()
                .collect()
        }))
    }

    /// Declares or changes a project.
    pub async fn project_set(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkProject> {
        self.seed().await?;
        let name = one_line(str_param(params, "name").unwrap_or(""), 80).to_lowercase();
        if name.is_empty() {
            return Err(WorkError::invalid("name is required"));
        }
        let existing = self.read(|store| {
            str_param(params, "id")
                .and_then(|id| store.project(id))
                .or_else(|| store.project(&name))
                .cloned()
        });
        let default_connection = self.deps().default_connection().await;
        let roots = match params.get("roots") {
            Some(Value::Array(roots)) => {
                let mut out = Vec::new();
                for root in roots {
                    let raw = match root {
                        Value::String(path) => json!({"path": path}),
                        other => other.clone(),
                    };
                    let path = raw
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|p| !p.is_empty());
                    let (Some(_), Some(path)) = (raw.as_object(), path) else {
                        return Err(WorkError::invalid(
                            "roots are paths, or {connectionId, path}",
                        ));
                    };
                    let connection_id = raw
                        .get("connectionId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .or_else(|| default_connection.clone())
                        .unwrap_or_else(|| "local".into());
                    out.push(WorkRoot {
                        connection_id,
                        path: slice_utf16(path, 4096).to_owned(),
                    });
                }
                out
            }
            _ => existing
                .as_ref()
                .map(|p| p.roots.clone())
                .unwrap_or_default(),
        };
        if roots.len() > 20 {
            return Err(WorkError::invalid("at most 20 roots"));
        }
        let mut done = if params.contains_key("done") {
            parse_done_rule(params.get("done"))?
        } else {
            existing
                .as_ref()
                .map(|p| p.done.clone())
                .unwrap_or(WorkDoneRule::Deployed)
        };
        if let WorkDoneRule::Branch {
            root,
            connection_id,
            ..
        } = &mut done
            && connection_id.is_none()
        {
            *connection_id = roots
                .iter()
                .find(|each| &each.path == root)
                .map(|each| each.connection_id.clone())
                .or_else(|| default_connection.clone());
        }
        let coordinator = if params.contains_key("coordinator") {
            parse_work_coordinator(params.get("coordinator"))?
        } else {
            existing.as_ref().and_then(|p| p.coordinator.clone())
        };
        static NOT_ID: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"[^a-z0-9._-]+").expect("id"));
        let id = existing
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| NOT_ID.replace_all(&name, "-").into_owned());
        let mut parent = existing.as_ref().and_then(|p| p.parent.clone());
        match params.get("parent") {
            None => {}
            Some(Value::Null) => parent = None,
            Some(Value::String(named)) if named.is_empty() => parent = None,
            Some(Value::String(named)) => {
                let found = self.read(|store| store.project(js_trim(named)).cloned());
                let Some(found) = found else {
                    return Err(WorkError::not_found(format!(
                        "no project {} to be part of",
                        slice_utf16(named, 40)
                    )));
                };
                let family = self.read(|store| work_project_family(store.projects(), &id));
                if family.contains(&found.id) {
                    return Err(WorkError::with(
                        format!(
                            "{} is {}: a project cannot be part of it",
                            found.name,
                            if found.id == id {
                                "this project"
                            } else {
                                "one of its subprojects"
                            }
                        ),
                        "conflict",
                    ));
                }
                parent = Some(found.id);
            }
            Some(_) => {
                return Err(WorkError::invalid(
                    "parent is a project's name or id, or null",
                ));
            }
        }
        let tags = if params.contains_key("tags") {
            Some(parse_work_tags(params.get("tags"))?)
        } else {
            existing.as_ref().and_then(|p| p.tags.clone())
        };
        let project = WorkProject {
            id,
            name,
            roots,
            done,
            tags,
            coordinator,
            parent,
        };
        self.write(|store| store.save_project(project.clone()))?;
        self.push(WorkPush {
            changed: vec!["projects"],
            item: None,
            by: meta.by,
            summary: meta.is_agent().then(|| {
                summary_of(
                    meta,
                    &format!(
                        "{} project {}",
                        if existing.is_some() {
                            "changed"
                        } else {
                            "declared"
                        },
                        project.name
                    ),
                )
            }),
        });
        Ok(project)
    }

    /// The tags an item given none gets by itself, from its words.
    fn auto_tags(&self, project: &WorkProject, words: &str) -> Vec<String> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        self.read(|store| {
            for item in store.items() {
                if item.project != project.id {
                    continue;
                }
                for tag in &item.tags {
                    match counts.iter_mut().find(|(each, _)| each == tag) {
                        Some(entry) => entry.1 += 1,
                        None => counts.push((tag.clone(), 1)),
                    }
                }
            }
        });
        counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(&a.0, &b.0)));
        // A workspace's tag says where an item was added, not what it is about.
        let vocabulary: Vec<String> = project
            .tags
            .clone()
            .unwrap_or_default()
            .into_iter()
            .chain(counts.into_iter().map(|(tag, _)| tag))
            .filter(|tag| !is_work_workspace_tag(tag))
            .collect();
        auto_work_tags(words, &vocabulary)
    }

    /// A workspace as the board places it; None when its connection does
    /// not answer in time or does not know it.
    async fn place_of(
        &self,
        connection_id: &str,
        workspace_id: Option<&str>,
        pane_id: Option<&str>,
    ) -> Option<WorkPlace> {
        let deps = self.deps();
        if !deps.has_places() {
            return None;
        }
        let read = async {
            let (panes, workspaces) =
                tokio::join!(deps.panes(connection_id), deps.workspaces(connection_id));
            Some((panes.ok()?, workspaces.ok()?))
        };
        let late = self.inner.clock.sleep(Duration::from_millis(WORK_PLACE_MS));
        let (panes, workspaces) = tokio::select! {
            listed = read => listed?,
            () = late => return None,
        };
        let workspace_id = workspace_id.map(str::to_owned).or_else(|| {
            panes
                .iter()
                .find(|pane| Some(pane.pane_id.as_str()) == pane_id)
                .and_then(|pane| pane.workspace_id.clone())
        })?;
        let workspace = workspaces
            .iter()
            .find(|each| each.workspace_id == workspace_id)?;
        let label = workspace.label.clone().filter(|label| !label.is_empty())?;
        let own: Vec<&Pane> = panes
            .iter()
            .filter(|pane| pane.workspace_id.as_deref() == Some(workspace_id.as_str()))
            .collect();
        let tree = workspace.worktree.clone().unwrap_or_default();
        let mut paths: Vec<String> = Vec::new();
        for path in [tree.checkout_path, tree.repo_root]
            .into_iter()
            .chain(own.iter().map(|pane| pane.cwd.clone()))
            .chain(own.iter().map(|pane| pane.foreground_cwd.clone()))
            .flatten()
        {
            if !path.is_empty() && !paths.contains(&path) {
                paths.push(path);
            }
        }
        Some(WorkPlace {
            connection_id: connection_id.to_owned(),
            label,
            paths,
            pane_ids: own.iter().map(|pane| pane.pane_id.clone()).collect(),
        })
    }

    /// The workspace tag of an item added from a workspace.
    async fn added_from_tag(
        &self,
        project: &WorkProject,
        params: &Params,
        meta: &WorkMeta,
    ) -> Option<String> {
        if params.get("workspace") == Some(&Value::Bool(false)) {
            return None;
        }
        let place = if let Some(workspace) = record(params.get("workspace")) {
            let connection_id = workspace
                .get("connectionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())?;
            let workspace_id = workspace
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            let pane_id = workspace
                .get("paneId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty());
            if workspace_id.is_none() && pane_id.is_none() {
                return None;
            }
            self.place_of(connection_id, workspace_id, pane_id).await
        } else if meta.is_agent()
            && let Some(address) = &meta.address
        {
            let parsed = parse_agent_address(address)?;
            self.place_of(&parsed.connection_id, None, Some(&parsed.pane_id))
                .await
        } else {
            return None;
        }?;
        self.read(|store| work_place_tag_for(&place, store.projects(), &project.id))
    }

    /// The owner an item gets when given none: the project's coordinator,
    /// unless the item is For you or done.
    fn owner_for(
        project: &WorkProject,
        state: &str,
        given: Option<WorkOwner>,
    ) -> Option<WorkOwner> {
        if given.is_some() {
            return given;
        }
        if state == "you" || state == "done" {
            return None;
        }
        project.coordinator.as_ref().map(|coordinator| WorkOwner {
            session: coordinator.session.clone(),
            task: None,
        })
    }

    /// The text an item is added with, and the images it holds.
    fn parse_add_text(params: &Params) -> WorkResult<(Option<String>, Vec<AddImage>)> {
        let raw = params.get("text");
        let text = match raw {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => unix_lines(text),
            Some(_) => return Err(WorkError::invalid("text must be words")),
        };
        if utf16_len(&text) > WORK_DESCRIPTION_CHARS {
            return Err(WorkError::invalid("text is too long"));
        }
        let trimmed = js_trim(&text);
        let text = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        let list = match params.get("images") {
            None | Some(Value::Null) => return Ok((text, Vec::new())),
            Some(Value::Array(list)) => list,
            Some(_) => return Err(WorkError::invalid("images must be a list")),
        };
        if list.len() > WORK_ADD_IMAGES {
            return Err(WorkError::invalid(format!(
                "at most {WORK_ADD_IMAGES} images"
            )));
        }
        let mut images = Vec::new();
        for each in list {
            let token = each
                .get("token")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty());
            let kind = each.get("type").and_then(Value::as_str);
            let data = each.get("data").and_then(Value::as_str);
            let (Some(token), Some(kind), Some(data)) = (token, kind, data) else {
                return Err(WorkError::invalid(
                    "an image is {token, type, data (base64)}",
                ));
            };
            images.push(AddImage {
                token: slice_utf16(token, 80).to_owned(),
                kind: kind.to_owned(),
                data: decode_base64(data),
            });
        }
        Ok((text, images))
    }

    /// Tells the item's owner of it, as a review comment is told.
    async fn announce(
        &self,
        item: &WorkItem,
        meta: &WorkMeta,
        text: Option<&str>,
        images: &[AddImage],
        added: bool,
    ) -> WorkResult<Option<ReviewThread>> {
        let Some(reviews) = self.deps().reviews() else {
            return Ok(None);
        };
        let own = meta.is_agent()
            && meta.address.is_some()
            && item.owner.as_ref().map(|owner| &owner.session) == meta.address.as_ref();
        if text.is_none() && (item.owner.is_none() || own) {
            return Ok(None);
        }
        let author = if meta.by == By::User {
            REVIEW_USER.to_owned()
        } else if own {
            agent_name_of(meta)
        } else {
            meta.caller.clone().unwrap_or_else(|| "Claude".into())
        };
        let snapshot = self
            .threads(&item.id, true)
            .await?
            .ok_or_else(|| WorkError::invalid("the item's review could not be opened"))?;
        let mut body = text.map(str::to_owned).unwrap_or_else(|| {
            if added {
                item.title.clone()
            } else {
                "Reopened.".into()
            }
        });
        for image in images {
            let path = reviews
                .add_image(&snapshot.session.id, &image.kind, image.data.clone())
                .await?;
            body = body.split(&image.token).collect::<Vec<_>>().join(&path);
        }
        let mut work = json!({"item": item.id});
        if text.is_some() {
            work["description"] = json!(true);
        }
        if item.needs_triage {
            work["triage"] = json!(true);
        }
        reviews
            .add_thread(
                &snapshot.session.id,
                &author,
                &body,
                json!({ "work": work }),
            )
            .await
            .map(Some)
    }

    pub async fn add(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        Ok(self.add_or_update(params, meta).await?.item)
    }

    /// `add`, saying what it did: an item with the same source in the
    /// project is changed instead of added, never silently retitled.
    pub async fn add_or_update(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkAdded> {
        self.seed().await?;
        let project = self.project_of(str_param(params, "project"))?;
        let source = parse_work_source(params.get("source"))?;
        let existing = source.as_ref().and_then(|source| {
            self.read(|store| {
                store
                    .items()
                    .iter()
                    .find(|item| item.project == project.id && item.source.as_ref() == Some(source))
                    .cloned()
            })
        });
        if let Some(existing) = existing {
            let source = source.unwrap_or_default();
            let title = if params.contains_key("title") {
                Some(parse_work_title(params.get("title"))?)
            } else {
                None
            };
            if let Some(title) = &title
                && *title != existing.title
                && params.get("replace") != Some(&Value::Bool(true))
            {
                return Err(WorkError::with(
                    format!(
                        "an item with source \"{}\" exists in {}: {} \"{}\"; work_update changes it, or replace: true retitles it to \"{}\"",
                        one_line(&source, 80),
                        project.name,
                        existing.id,
                        one_line(&existing.title, 80),
                        one_line(title, 80)
                    ),
                    "conflict",
                ));
            }
            let mut rest = params.clone();
            rest.insert("item".into(), json!(existing.id));
            for key in ["source", "project", "text", "images", "replace"] {
                rest.shift_remove(key);
            }
            let ignored: Vec<String> = ["text", "images"]
                .into_iter()
                .filter(|key| given(params.get(*key)))
                .map(str::to_owned)
                .collect();
            let changed = self.change(&rest, meta).await?;
            return Ok(WorkAdded {
                item: changed.item,
                updated: true,
                changed: Some(changed.changed),
                ignored: (!ignored.is_empty()).then_some(ignored),
                adopted: changed.adopted,
            });
        }
        let at = self.now();
        let created =
            parse_work_time(params.get("created_at"), "created_at")?.unwrap_or_else(|| at.clone());
        let state = if given(params.get("state")) {
            parse_work_state(params.get("state"))?
        } else {
            "open".into()
        };
        let given_owner = parse_work_owner(params.get("owner"))?;
        self.assert_owner_known(given_owner.as_ref()).await?;
        let owner = Self::owner_for(&project, &state, given_owner);
        let (text, images) = Self::parse_add_text(params)?;
        let untitled = match params.get("title") {
            None | Some(Value::Null) => true,
            Some(Value::String(title)) => js_trim(title).is_empty(),
            Some(_) => false,
        } && text.is_some();
        let title = if untitled {
            provisional_work_title(text.as_deref().unwrap_or(""))
        } else {
            parse_work_title(params.get("title"))?
        };
        let links = merge_work_links(&[], &parse_work_links(params.get("links"))?);
        let updated_at = if given(params.get("updated_at")) {
            parse_work_time(params.get("updated_at"), "updated_at")?.unwrap_or_default()
        } else if created > at {
            created.clone()
        } else {
            at.clone()
        };
        let needs_triage = untitled
            && owner.as_ref().is_some_and(|owner| {
                !(meta.is_agent() && meta.address.as_deref() == Some(owner.session.as_str()))
            });
        let mut item = WorkItem {
            id: new_work_id(),
            project: project.id.clone(),
            title,
            state,
            tags: Vec::new(),
            owner: owner.clone(),
            source,
            links,
            created_at: created,
            updated_at,
            done_at: None,
            by: meta.by,
            review: None,
            needs_triage,
            ask: None,
            answers: None,
            questions: None,
        };
        item.tags = parse_work_tags(params.get("tags"))?;
        if item.tags.is_empty() && !params.contains_key("tags") {
            let words = [
                if untitled { "" } else { item.title.as_str() },
                text.as_deref().unwrap_or(""),
                str_param(params, "tag_text").unwrap_or(""),
            ]
            .join("\n");
            item.tags = self.auto_tags(&project, &words);
        }
        // Where it was added from: that workspace's tag, besides the others.
        if let Some(from) = self.added_from_tag(&project, params, meta).await
            && !item.tags.contains(&from)
        {
            item.tags.truncate(limits::TAGS_PER_ITEM - 1);
            item.tags.push(from);
        }
        if item.state == "done" {
            item.done_at = Some(
                parse_work_time(params.get("done_at"), "done_at")?.unwrap_or_else(|| at.clone()),
            );
        }
        let mut asked = Map::new();
        settle_work_ask(None, &mut item, params, meta.by, &mut asked)?;
        let mut change = Map::new();
        change.insert("state".into(), json!(item.state));
        change.insert("title".into(), json!(item.title));
        if let Some(owner) = &owner {
            change.insert("owner".into(), json!(owner));
        }
        if !item.tags.is_empty() {
            change.insert("tags".into(), json!(item.tags));
        }
        if item.needs_triage {
            change.insert("needs_triage".into(), json!(true));
        }
        change.extend(asked);
        let what = format!("added \"{}\"", one_line(&item.title, 60));
        let made = self.commit(None, item, meta, &change, &what)?;
        let mut adopted = None;
        if given(params.get("adopt_thread")) {
            let reference = crate::text::js_string_of(params.get("adopt_thread"));
            adopted = Some(self.adopt_into(&made, &reference, meta).await?.1);
        } else if made.state != "done" {
            self.announce(&made, meta, text.as_deref(), &images, true)
                .await?;
        }
        let item = self
            .read(|store| store.item(&made.id).cloned())
            .unwrap_or(made);
        Ok(WorkAdded {
            item,
            updated: false,
            changed: None,
            ignored: None,
            adopted,
        })
    }

    pub async fn update(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        Ok(self.change(params, meta).await?.item)
    }

    /// `update`, saying what changed.
    pub async fn change(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkChanged> {
        let before = self.item_of(params.get("item"))?;
        let mut change = Map::new();
        let mut next = WorkItem {
            by: meta.by,
            updated_at: self.now(),
            ..before.clone()
        };
        if params.contains_key("title") {
            next.title = parse_work_title(params.get("title"))?;
            if next.title != before.title {
                change.insert("title".into(), json!(next.title));
            }
        }
        if given(params.get("state")) {
            next.state = parse_work_state(params.get("state"))?;
            if next.state != before.state {
                change.insert("state".into(), json!(next.state));
                if next.state == "done" {
                    next.done_at = Some(
                        parse_work_time(params.get("done_at"), "done_at")?
                            .unwrap_or_else(|| next.updated_at.clone()),
                    );
                } else {
                    next.done_at = None;
                }
            } else if next.state == "done" && given(params.get("done_at")) {
                next.done_at = parse_work_time(params.get("done_at"), "done_at")?;
            }
        }
        if given(params.get("created_at")) {
            let created =
                parse_work_time(params.get("created_at"), "created_at")?.unwrap_or_default();
            if created != before.created_at {
                next.created_at = created.clone();
                change.insert("created_at".into(), json!(created));
            }
        }
        if given(params.get("project")) {
            let reference = crate::text::js_string_of(params.get("project"));
            next.project = self.project_of(Some(&reference))?.id;
            if next.project != before.project {
                change.insert("project".into(), json!(next.project));
            }
        }
        if params.contains_key("source") {
            let source = parse_work_source(params.get("source"))?;
            next.source = source.clone();
            if source != before.source {
                change.insert("source".into(), json!(source));
            }
        }
        if params.contains_key("tags") {
            next.tags = parse_work_tags(params.get("tags"))?;
        }
        if params.contains_key("add_tags") {
            let mut all = next.tags.clone();
            all.extend(parse_work_tags(params.get("add_tags"))?);
            next.tags = crate::shared::normalize_work_tags(&all);
        }
        if params.contains_key("remove_tags") {
            let gone: HashSet<String> = parse_work_tags(params.get("remove_tags"))?
                .into_iter()
                .collect();
            next.tags.retain(|tag| !gone.contains(tag));
        }
        if next.tags != before.tags {
            change.insert("tags".into(), json!(next.tags));
        }
        if params.contains_key("owner") {
            let owner = parse_work_owner(params.get("owner"))?;
            if let Some(owner) = &owner
                && Some(&owner.session) != before.owner.as_ref().map(|owner| &owner.session)
            {
                self.assert_owner_known(Some(owner)).await?;
            }
            next.owner = owner.clone();
            if owner != before.owner {
                change.insert("owner".into(), json!(owner));
            }
        }
        if params.contains_key("links") {
            next.links = merge_work_links(&[], &parse_work_links(params.get("links"))?);
        }
        if params.contains_key("add_links") {
            next.links = merge_work_links(&next.links, &parse_work_links(params.get("add_links"))?);
        }
        if params.contains_key("remove_links") {
            let gone = parse_work_links(params.get("remove_links"))?;
            next.links.retain(|link| !gone.contains(link));
        }
        if params.contains_key("needs_triage") {
            let Some(Value::Bool(triage)) = params.get("needs_triage") else {
                return Err(WorkError::invalid("needs_triage must be true or false"));
            };
            next.needs_triage = *triage;
            if next.needs_triage != before.needs_triage {
                change.insert("needs_triage".into(), json!(next.needs_triage));
            }
        } else if before.needs_triage
            && change.contains_key("title")
            && meta.is_agent()
            && meta.address.as_ref().is_some_and(|address| {
                Some(address) == before.owner.as_ref().map(|owner| &owner.session)
                    || Some(address) == next.owner.as_ref().map(|owner| &owner.session)
            })
        {
            // Its owner's first title for it is the triage the mark waits for.
            next.needs_triage = false;
            change.insert("needs_triage".into(), json!(false));
        }
        settle_work_ask(Some(&before), &mut next, params, meta.by, &mut change)?;
        if params.contains_key("text")
            && let Some((text, previous)) = self.write_description(&before, params, meta).await?
        {
            change.insert("description".into(), json!({"chars": utf16_len(&text)}));
            change.insert("previous_description".into(), json!(previous));
        }
        if next.links != before.links {
            change.insert("links".into(), json!(next.links));
        }
        let mut written = before.clone();
        if !change.is_empty() {
            let what = match change.get("state") {
                Some(state) => format!(
                    "moved \"{}\" to {}",
                    one_line(&next.title, 60),
                    crate::text::js_string(state)
                ),
                None => format!("changed \"{}\"", one_line(&next.title, 60)),
            };
            written = self.commit(Some(&before), next, meta, &change, &what)?;
        }
        let mut adopted = None;
        if given(params.get("adopt_thread")) {
            let reference = crate::text::js_string_of(params.get("adopt_thread"));
            adopted = Some(self.adopt_into(&written, &reference, meta).await?.1);
        }
        let item = self
            .read(|store| store.item(&written.id).cloned())
            .unwrap_or(written);
        Ok(WorkChanged {
            item,
            changed: change,
            adopted,
        })
    }

    /// The item's description set (`text`): rewritten in place when it is
    /// the caller's own, else a new description thread is made.
    async fn write_description(
        &self,
        item: &WorkItem,
        params: &Params,
        meta: &WorkMeta,
    ) -> WorkResult<Option<(String, Option<String>)>> {
        let reviews = self.reviews()?;
        let snapshot = self
            .threads(&item.id, true)
            .await?
            .ok_or_else(|| WorkError::invalid("the item's review could not be opened"))?;
        let current = work_description_thread(&snapshot.threads, &item.created_at).cloned();
        let old = current
            .as_ref()
            .and_then(|thread| thread.comments.first())
            .cloned();
        let text = match params.get("text") {
            Some(Value::String(text)) if !js_trim(text).is_empty() => {
                let text = js_trim(&unix_lines(text)).to_owned();
                if utf16_len(&text) > WORK_DESCRIPTION_CHARS {
                    return Err(WorkError::invalid(format!(
                        "text is too long ({WORK_DESCRIPTION_CHARS} characters at most)"
                    )));
                }
                text
            }
            _ => {
                return Err(WorkError::invalid(
                    "text is empty: an item keeps a description",
                ));
            }
        };
        let previous = old.as_ref().map(|comment| comment.body.clone());
        if old.is_some() && Some(&text) == previous.as_ref() {
            return Ok(None);
        }
        let author = if meta.by == By::User {
            REVIEW_USER.to_owned()
        } else {
            agent_name_of(meta)
        };
        let own = old.as_ref().is_some_and(|old| {
            old.author == author || (meta.is_agent() && meta.caller.as_ref() == Some(&old.author))
        });
        match (&current, &old) {
            (Some(_), Some(old)) if own => {
                reviews
                    .edit_comment(&snapshot.session.id, &old.id, &old.author, &text)
                    .await?;
            }
            _ => {
                if let Some(current) = current.as_ref().filter(|thread| thread.is_description()) {
                    let mut work = json!({"item": item.id});
                    if current.work_truthy("triage") {
                        work["triage"] = json!(true);
                    }
                    reviews
                        .set_anchor(&snapshot.session.id, &current.id, json!({ "work": work }))
                        .await?;
                }
                reviews
                    .add_thread(
                        &snapshot.session.id,
                        &author,
                        &text,
                        json!({"work": {"item": item.id, "description": true}}),
                    )
                    .await?;
            }
        }
        Ok(Some((text, previous)))
    }

    /// The versions an item's description had before its current one,
    /// newest first.
    pub fn description_versions(&self, item: &WorkItem) -> Vec<Value> {
        let mut out: Vec<Value> = self
            .read(|store| store.history_of(&item.id))
            .into_iter()
            .filter_map(|line| {
                let text = line
                    .change
                    .get("previous_description")?
                    .as_str()?
                    .to_owned();
                Some(json!({"replaced": line.at, "by": line.by, "text": text}))
            })
            .collect();
        out.reverse();
        out
    }

    /// An item's review changed: its open questions counted on its card.
    pub fn questions_seen(&self, item_id: &str, threads: &[ReviewThread]) -> WorkResult<()> {
        let Some(item) = self.read(|store| store.item(item_id).cloned()) else {
            return Ok(());
        };
        let open = work_open_questions(threads, &item.created_at) as u64;
        if item.questions.unwrap_or(0) == open {
            return Ok(());
        }
        let next = WorkItem {
            questions: (open > 0).then_some(open),
            ..item
        };
        self.write(|store| store.save_item(next, None, None))?;
        self.push(WorkPush {
            changed: vec!["item"],
            item: Some(item_id.to_owned()),
            by: By::User,
            summary: None,
        });
        Ok(())
    }

    /// The item is done: what landed, when known, is linked.
    pub fn done(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        let before = self.item_of(params.get("item"))?;
        let mut links = Vec::new();
        if let Some(landed) = record(params.get("landed")) {
            if let Some(Value::String(sha)) = landed.get("commit") {
                let mut link = json!({"kind": "commit", "sha": sha});
                if let Some(Value::String(subject)) = landed.get("subject") {
                    link["subject"] = json!(subject);
                }
                if let Some(Value::String(root)) = landed.get("root") {
                    link["root"] = json!(root);
                }
                links.push(parse_work_link(&link)?);
            }
            if let Some(Value::String(url)) = landed.get("pr") {
                links.push(parse_work_link(&json!({"kind": "pr", "url": url}))?);
            }
            if let Some(Value::String(branch)) = landed.get("branch") {
                links.push(parse_work_link(&json!({"kind": "branch", "name": branch}))?);
            }
        }
        let at = self.now();
        let next = without_ask(WorkItem {
            state: "done".into(),
            done_at: Some(
                parse_work_time(params.get("done_at"), "done_at")?.unwrap_or_else(|| at.clone()),
            ),
            updated_at: at,
            by: meta.by,
            links: merge_work_links(&before.links, &links),
            ..before.clone()
        });
        let mut change = Map::new();
        change.insert("state".into(), json!("done"));
        if !links.is_empty() {
            change.insert(
                "landed".into(),
                json!(links.iter().map(describe_work_link).collect::<Vec<_>>()),
            );
        }
        let what = format!("done with \"{}\"", one_line(&next.title, 60));
        self.commit(Some(&before), next, meta, &change, &what)
    }

    pub async fn reopen(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        let before = self.item_of(params.get("item"))?;
        let state = if given(params.get("state")) {
            parse_work_state(params.get("state"))?
        } else {
            "open".into()
        };
        if state == "done" {
            return Err(WorkError::invalid("reopen to a live state"));
        }
        let project = self.read(|store| store.project(&before.project).cloned());
        let owner = match &project {
            Some(project) => Self::owner_for(project, &state, before.owner.clone()),
            None => before.owner.clone(),
        };
        let mut next = WorkItem {
            state: state.clone(),
            owner: owner.clone().or(before.owner.clone()),
            updated_at: self.now(),
            by: meta.by,
            done_at: None,
            ..before.clone()
        };
        let mut asked = Map::new();
        settle_work_ask(Some(&before), &mut next, params, meta.by, &mut asked)?;
        let given_owner = owner.clone().filter(|_| before.owner.is_none());
        let mut change = Map::new();
        change.insert("state".into(), json!(state));
        if let Some(owner) = &given_owner {
            change.insert("owner".into(), json!(owner));
        }
        change.extend(asked);
        let what = format!("reopened \"{}\" as {state}", one_line(&next.title, 60));
        let made = self.commit(Some(&before), next, meta, &change, &what)?;
        // Given to the coordinator now: told of it, as of a new item.
        if given_owner.is_some() {
            self.announce(&made, meta, None, &[], false).await?;
        }
        Ok(self
            .read(|store| store.item(&made.id).cloned())
            .unwrap_or(made))
    }

    pub fn remove(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        let item = self.item_of(params.get("item"))?;
        self.write(|store| store.remove_item(&item.id, Some(&actor_of(meta))))?;
        if item.state == "you" {
            self.deps().notify(&item, false);
        }
        self.push(WorkPush {
            changed: vec!["items"],
            item: Some(item.id.clone()),
            by: meta.by,
            summary: meta
                .is_agent()
                .then(|| summary_of(meta, &format!("removed \"{}\"", one_line(&item.title, 60)))),
        });
        Ok(item)
    }

    /// Where an item's review lives: the owner's connection, else the
    /// project's.
    async fn review_home(&self, item: &WorkItem) -> (String, String) {
        let project = self.read(|store| store.project(&item.project).cloned());
        let owner = item
            .owner
            .as_ref()
            .and_then(|owner| parse_agent_address(&owner.session));
        let roots = project.map(|project| project.roots).unwrap_or_default();
        let connection_id = match owner
            .map(|owner| owner.connection_id)
            .or_else(|| roots.first().map(|root| root.connection_id.clone()))
        {
            Some(id) => id,
            None => self
                .deps()
                .default_connection()
                .await
                .unwrap_or_else(|| "local".into()),
        };
        let root = roots
            .iter()
            .find(|each| each.connection_id == connection_id)
            .or(roots.first())
            .map(|root| root.path.clone())
            .or_else(|| self.deps().own_root())
            .unwrap_or_else(|| "/".into());
        (connection_id, root)
    }

    /// The item's review: its threads, for the board (made when `open`).
    pub async fn threads(&self, reference: &str, open: bool) -> WorkResult<Option<ReviewSnapshot>> {
        let item = self.item_of(Some(&Value::String(reference.to_owned())))?;
        let reviews = self.reviews()?;
        let found = reviews.find(&item.id).await?;
        if found.is_some() || !open {
            return Ok(found);
        }
        let (connection_id, root) = self.review_home(&item).await;
        let snapshot = reviews
            .open(
                &item.id,
                &connection_id,
                &root,
                &format!("Work: {}", item.title),
            )
            .await?;
        let current = self.read(|store| store.item(&item.id).cloned());
        if let Some(current) = current
            && current.review.as_deref() != Some(snapshot.session.id.as_str())
        {
            let next = WorkItem {
                review: Some(snapshot.session.id.clone()),
                ..current
            };
            self.write(|store| store.save_item(next, None, None))?;
            self.push(WorkPush {
                changed: vec!["item"],
                item: Some(item.id.clone()),
                by: By::User,
                summary: None,
            });
        }
        Ok(Some(snapshot))
    }

    /// A comment on an item, by an agent or the user: its review's thread.
    pub async fn comment(&self, params: &Params, author: &str) -> WorkResult<ReviewThread> {
        let item = self.item_of(params.get("item"))?;
        let reviews = self.reviews()?;
        let text = str_param(params, "text").map(js_trim).unwrap_or("");
        if text.is_empty() {
            return Err(WorkError::invalid("text is empty"));
        }
        let snapshot = self
            .threads(&item.id, true)
            .await?
            .ok_or_else(|| WorkError::invalid("the item's review could not be opened"))?;
        reviews
            .add_thread(
                &snapshot.session.id,
                author,
                text,
                json!({"work": {"item": item.id}}),
            )
            .await
    }

    /// A thread by its id (or a comment's), with the review it is in.
    async fn thread_ref(&self, reference: &str) -> WorkResult<(ReviewSession, ReviewThread)> {
        let reviews = self.reviews()?;
        let key = js_trim(reference);
        if key.is_empty() {
            return Err(WorkError::invalid("thread is required"));
        }
        let session = reviews
            .session_of_comment(key)
            .await?
            .ok_or_else(|| WorkError::not_found("no such thread"))?;
        let snapshot = reviews.get(&session.id).await?;
        let thread = snapshot
            .and_then(|snapshot| {
                snapshot.threads.into_iter().find(|each| {
                    each.id == key
                        || each.id.starts_with(key)
                        || each
                            .comments
                            .iter()
                            .any(|comment| comment.id == key || comment.id.starts_with(key))
                })
            })
            .ok_or_else(|| WorkError::not_found("no such thread"))?;
        Ok((session, thread))
    }

    /// A comment of an item's thread rewritten (`edit`) or deleted, only an
    /// agent's own.
    pub async fn comment_edit(
        &self,
        params: &Params,
        meta: &WorkMeta,
        edit: bool,
    ) -> WorkResult<CommentEdited> {
        let what = if edit { "edit" } else { "delete" };
        let reference = str_param(params, "comment").map(js_trim).unwrap_or("");
        if reference.is_empty() {
            return Err(WorkError::invalid("comment is required"));
        }
        let (session, thread) = self.thread_ref(reference).await?;
        let Some(item_id) = session.target_item() else {
            return Err(WorkError::invalid(
                "that comment is not on a work item: review_edit works on it",
            ));
        };
        let item = self.item_of(Some(&Value::String(item_id.to_owned())))?;
        let comment = thread
            .comments
            .iter()
            .find(|each| each.id == reference || each.id.starts_with(reference))
            .cloned()
            .ok_or_else(|| {
                WorkError::not_found(
                    "comment names a thread: give the comment's own id (work_list {item} lists them)",
                )
            })?;
        let mine = [
            agent_name_of(meta),
            meta.caller.clone().unwrap_or_else(|| "Claude".into()),
        ];
        if meta.is_agent() && !mine.contains(&comment.author) {
            return Err(WorkError::with(
                format!(
                    "an agent can only {what} its own comments (this one is by {})",
                    one_line(&comment.author, 60)
                ),
                "forbidden",
            ));
        }
        let author = if meta.by == By::User {
            REVIEW_USER.to_owned()
        } else {
            comment.author.clone()
        };
        let reviews = self.reviews()?;
        if edit {
            let text = str_param(params, "text").map(js_trim).unwrap_or("");
            if text.is_empty() {
                return Err(WorkError::invalid("text is empty"));
            }
            let edited = reviews
                .edit_comment(&session.id, &comment.id, &author, text)
                .await?;
            return Ok(CommentEdited {
                item,
                thread: Some(edited),
                deleted: None,
            });
        }
        let (deleted, thread) = reviews
            .delete_comment(&session.id, &comment.id, &author)
            .await?;
        Ok(CommentEdited {
            item,
            thread,
            deleted: Some(deleted),
        })
    }

    /// An existing review thread becomes the item's own.
    async fn adopt_into(
        &self,
        item: &WorkItem,
        reference: &str,
        meta: &WorkMeta,
    ) -> WorkResult<(WorkItem, String)> {
        let (from, thread) = self.thread_ref(reference).await?;
        let own = self
            .threads(&item.id, true)
            .await?
            .ok_or_else(|| WorkError::invalid("the item's review could not be opened"))?;
        if thread.session_id == own.session.id {
            let current = self
                .read(|store| store.item(&item.id).cloned())
                .unwrap_or_else(|| item.clone());
            return Ok((current, thread.id));
        }
        let quote = thread
            .work("quote")
            .filter(|quote| !quote.is_null())
            .or_else(|| {
                thread
                    .anchor
                    .get("render")
                    .and_then(|render| render.get("quote"))
            })
            .filter(|quote| {
                !matches!(quote, Value::Null | Value::Bool(false)) && *quote != &json!("")
            })
            .cloned();
        let mut work = json!({"item": item.id, "from": {"review": from.id, "thread": thread.id}});
        if let Some(quote) = quote {
            work["quote"] = quote;
        }
        self.reviews()?
            .move_thread(&own.session.id, &thread.id, json!({ "work": work }))
            .await?;
        let current = self
            .read(|store| store.item(&item.id).cloned())
            .unwrap_or_else(|| item.clone());
        let mut added = vec![WorkLink::Review {
            id: from.id.clone(),
            thread: Some(thread.id.clone()),
        }];
        if from.target_kind() == "effort"
            && let Some(effort) = from.target.get("effort").and_then(Value::as_str)
        {
            added.push(WorkLink::Effort {
                id: effort.to_owned(),
                part: None,
            });
        }
        let links = merge_work_links(&current.links, &added);
        if links != current.links {
            let mut change = Map::new();
            change.insert("adopted".into(), json!(thread.id));
            let what = format!(
                "took thread {} into \"{}\"",
                slice_utf16(&thread.id, 8),
                one_line(&current.title, 60)
            );
            let next = WorkItem {
                links,
                updated_at: self.now(),
                by: meta.by,
                ..current.clone()
            };
            self.commit(Some(&current), next, meta, &change, &what)?;
        }
        let current = self
            .read(|store| store.item(&item.id).cloned())
            .unwrap_or(current);
        Ok((current, thread.id))
    }

    /// An item takes an existing review thread as its own.
    pub async fn adopt(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        let item = self.item_of(params.get("item"))?;
        let reference = crate::text::js_string_of(params.get("thread"));
        let reference = if params.get("thread").is_none_or(Value::is_null) {
            String::new()
        } else {
            reference
        };
        Ok(self.adopt_into(&item, &reference, meta).await?.0)
    }

    /// The pane an item's comments go to.
    pub async fn owner_pane(&self, item_id: &str, connection_id: &str) -> Option<String> {
        let item = self.read(|store| store.item(item_id).cloned())?;
        let panes = if self.deps().has_places() {
            self.deps().panes(connection_id).await.ok()
        } else {
            None
        };
        let here = |session: Option<&str>| -> Option<String> {
            let address = parse_agent_address(session?)?;
            if address.connection_id != connection_id {
                return None;
            }
            if let Some(panes) = &panes
                && !panes.iter().any(|pane| pane.pane_id == address.pane_id)
            {
                return None;
            }
            Some(address.pane_id)
        };
        let owner = item.owner.as_ref().map(|owner| owner.session.as_str());
        if let Some(own) = here(owner) {
            return Some(own);
        }
        // The user's own For you item (nobody's): its comments are notes.
        if item.state == "you" && item.owner.is_none() {
            return None;
        }
        let coordinator = self.read(|store| {
            store
                .project(&item.project)
                .and_then(|project| project.coordinator.clone())
        })?;
        if Some(coordinator.session.as_str()) == owner {
            return None;
        }
        here(Some(&coordinator.session))
    }

    async fn address_target(&self, address: &str) -> Option<AddressTarget> {
        let at = parse_agent_address(address)?;
        let generation = self.deps().generation(&at.connection_id).await?;
        let panes = self
            .deps()
            .panes(&at.connection_id)
            .await
            .unwrap_or_default();
        let workspace_id = panes
            .iter()
            .find(|pane| pane.pane_id == at.pane_id)
            .and_then(|pane| pane.workspace_id.clone())
            .unwrap_or_default();
        if workspace_id.is_empty() {
            return None;
        }
        Some(AddressTarget {
            connection_id: at.connection_id,
            runtime_generation: generation,
            workspace_id,
            pane_id: at.pane_id,
            task: None,
        })
    }

    /// Where the owner is, for the page to open its chat or its task.
    pub async fn owner_target(&self, params: &Params) -> WorkResult<Option<AddressTarget>> {
        let item = self.item_of(params.get("item"))?;
        let Some(owner) = &item.owner else {
            return Ok(None);
        };
        Ok(self
            .address_target(&owner.session)
            .await
            .map(|target| AddressTarget {
                task: owner.task.clone().filter(|task| !task.is_empty()),
                ..target
            }))
    }

    /// Where a session runs (a chat link's).
    pub async fn session_target(&self, params: &Params) -> WorkResult<Option<AddressTarget>> {
        let Some(session) = str_param(params, "session").filter(|s| !s.is_empty()) else {
            return Err(WorkError::invalid("session must be a session's address"));
        };
        Ok(self.address_target(session).await)
    }

    /// A review thread becomes an item that adopts it.
    pub async fn promote(&self, params: &Params, meta: &WorkMeta) -> WorkResult<WorkItem> {
        self.seed().await?;
        let (session, thread) = self
            .thread_ref(str_param(params, "thread").unwrap_or(""))
            .await?;
        // Its own item already (the thread was adopted): that item.
        if let Some(item) = session.target_item()
            && let Some(owner) = self.read(|store| store.item(item).cloned())
        {
            return Ok(owner);
        }
        let first = thread
            .comments
            .first()
            .map(|comment| comment.body.clone())
            .unwrap_or_default();
        let (parsed_state, parsed_title) = parse_title_line(&first);
        let render_quote = thread
            .anchor
            .get("render")
            .and_then(|render| render.get("quote"))
            .and_then(Value::as_str)
            .filter(|quote| !quote.is_empty());
        let title = match str_param(params, "title").filter(|title| !js_trim(title).is_empty()) {
            Some(title) => title.to_owned(),
            None if !parsed_title.is_empty() => parsed_title,
            None => render_quote.unwrap_or("Untitled").to_owned(),
        };
        let project = match str_param(params, "project").filter(|p| !js_trim(p).is_empty()) {
            Some(project) => project.to_owned(),
            None => self.project_for_root(&session.connection_id, &session.root)?,
        };
        let mut input = Params::new();
        input.insert("project".into(), json!(project));
        input.insert("title".into(), json!(title));
        let state = match params.get("state") {
            Some(state) if !state.is_null() => state.clone(),
            _ if thread.resolved => json!("done"),
            _ => json!(parsed_state.unwrap_or_else(|| "open".into())),
        };
        input.insert("state".into(), state);
        for key in ["tags", "owner", "ask", "answers"] {
            if let Some(value) = params.get(key) {
                input.insert(key.into(), value.clone());
            }
        }
        // Tags read from the whole thread's first comment, not its title.
        input.insert("tag_text".into(), json!(first));
        input.insert("source".into(), json!(format!("thread {}", thread.id)));
        input.insert("created_at".into(), json!(thread.created_at));
        if thread.resolved {
            input.insert("done_at".into(), json!(thread.updated_at));
        }
        input.insert("adopt_thread".into(), json!(thread.id));
        self.add(&input, meta).await
    }

    /// The project whose root holds this checkout, else the first.
    fn project_for_root(&self, connection_id: &str, root: &str) -> WorkResult<String> {
        let found = self.read(|store| {
            work_project_for_paths(store.projects(), connection_id, &[Some(root)])
                .map(|p| p.id.clone())
        });
        match found {
            Some(id) => Ok(id),
            None => Ok(self.project_of(None)?.id),
        }
    }

    /// Whether an item's landing is linked already.
    fn landed_once(item: &WorkItem) -> bool {
        item.links.iter().any(|link| link.kind() == "deploy")
    }

    /// The done rules: every live item with a commit (or decision) link
    /// whose project says it landed becomes done, with a `deploy` link.
    pub async fn check(&self) -> WorkResult<WorkChecked> {
        self.seed().await?;
        let mut out = WorkChecked::default();
        let deployed = self.deps().deployed();
        let items: Vec<WorkItem> = self.read(|store| store.items().to_vec());
        for item in items {
            if !WORK_OPEN_STATES.contains(&item.state.as_str()) {
                continue;
            }
            // Waiting on the user: a landing is recorded once.
            if !work_landing_makes_done(&item.state) && Self::landed_once(&item) {
                continue;
            }
            let Some(project) = self.read(|store| store.project(&item.project).cloned()) else {
                continue;
            };
            let commits: Vec<&WorkLink> =
                item.links.iter().filter(|l| l.kind() == "commit").collect();
            let decisions: Vec<&WorkLink> = item
                .links
                .iter()
                .filter(|l| l.kind() == "decision")
                .collect();
            if commits.is_empty() && decisions.is_empty() {
                continue;
            }
            out.checked += 1;
            let mut found: Option<WorkLink> = None;
            for commit in &commits {
                found = self.landed_at(&project, commit, deployed.as_deref()).await;
                if found.is_some() {
                    break;
                }
            }
            if found.is_none() && commits.is_empty() && !decisions.is_empty() {
                let ticked = futures_util::future::join_all(
                    decisions
                        .iter()
                        .map(|decision| self.decision_ticked(&project, decision)),
                )
                .await;
                if ticked.iter().all(|(ticked, _)| *ticked) {
                    found = Some(WorkLink::Deploy {
                        sha: "decision".into(),
                        branch: Some(
                            if ticked.iter().any(|(_, uncommitted)| *uncommitted) {
                                "ticked, uncommitted"
                            } else {
                                "ticked"
                            }
                            .into(),
                        ),
                    });
                }
            }
            let Some(found) = found else { continue };
            let at = self.now();
            let Some(current) = self.read(|store| store.item(&item.id).cloned()) else {
                continue;
            };
            if !WORK_OPEN_STATES.contains(&current.state.as_str()) {
                continue;
            }
            let described = describe_work_link(&found);
            let agent = |summary: String| WorkMeta {
                by: By::Agent,
                caller: None,
                address: None,
                summary: Some(summary),
            };
            // The user still has to verify or answer: the landing is linked.
            if !work_landing_makes_done(&current.state) {
                if Self::landed_once(&current) {
                    continue;
                }
                let kept = WorkItem {
                    updated_at: at,
                    by: By::Agent,
                    links: merge_work_links(&current.links, &[found]),
                    ..current.clone()
                };
                let summary = format!(
                    "{} landed ({described}), still {}",
                    one_line(&kept.title, 60),
                    if kept.state == "verify" {
                        "to verify"
                    } else {
                        "for you"
                    }
                );
                let mut change = Map::new();
                change.insert("landed".into(), json!(described));
                self.commit(
                    Some(&current),
                    kept.clone(),
                    &agent(summary),
                    &change,
                    "landed",
                )?;
                out.recorded.push(kept.id);
                continue;
            }
            let next = without_ask(WorkItem {
                state: "done".into(),
                done_at: Some(at.clone()),
                updated_at: at,
                by: By::Agent,
                links: merge_work_links(&current.links, &[found]),
                ..current.clone()
            });
            let summary = format!("{} landed ({described})", one_line(&next.title, 60));
            let mut change = Map::new();
            change.insert("state".into(), json!("done"));
            change.insert("landed".into(), json!(described));
            self.commit(
                Some(&current),
                next.clone(),
                &agent(summary),
                &change,
                "landed",
            )?;
            out.landed.push(next.id);
        }
        Ok(out)
    }

    /// The checkout that holds a link's commit or branch.
    async fn link_repository(
        &self,
        link: &WorkLink,
        project: Option<&WorkProject>,
    ) -> Option<WorkLinkRoot> {
        if !self.deps().has_git() {
            return None;
        }
        static SHA: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[0-9a-f]{4,64}$").expect("sha"));
        let ask: Vec<String> = match link {
            WorkLink::Branch { name, .. } => {
                if name.starts_with('-') {
                    return None;
                }
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    format!("{name}^{{commit}}"),
                ]
            }
            WorkLink::Commit { sha, .. } | WorkLink::Deploy { sha, .. } => {
                if !SHA.is_match(sha) {
                    return None;
                }
                vec!["cat-file".into(), "-e".into(), format!("{sha}^{{commit}}")]
            }
            _ => return None,
        };
        let mut places = work_link_roots(link, project);
        let own = match project.map(|project| &project.done) {
            Some(WorkDoneRule::Deployed) => self.deps().own_root(),
            _ => None,
        };
        if let Some(own) = own
            && !places.iter().any(|each| each.path == own)
        {
            places.push(WorkLinkRoot {
                connection_id: None,
                path: own,
            });
        }
        for place in places {
            let read = self
                .deps()
                .git(&place.path, ask.clone(), place.connection_id.as_deref())
                .await;
            if read.code == Some(0) {
                return Some(place);
            }
        }
        None
    }

    /// The checkout that holds a file link's relative path.
    async fn file_repository(
        &self,
        link: &WorkLink,
        project: Option<&WorkProject>,
    ) -> Option<WorkLinkRoot> {
        let WorkLink::File { path, .. } = link else {
            return None;
        };
        if !self.deps().has_read_file() || is_absolute_work_path(path) {
            return None;
        }
        for place in work_link_roots(link, project) {
            if self
                .deps()
                .read_file(&place.path, path, place.connection_id.as_deref())
                .await
                .is_some()
            {
                return Some(place);
            }
        }
        None
    }

    async fn file_target(
        &self,
        link: &WorkLink,
        project: Option<&WorkProject>,
    ) -> WorkResult<LinkTarget> {
        let WorkLink::File { path, root, .. } = link else {
            return Err(WorkError::invalid("not a file link"));
        };
        let fallback = self.deps().default_connection().await;
        if is_absolute_work_path(path) {
            let mut holders: Vec<&WorkRoot> = project
                .map(|project| {
                    project
                        .roots
                        .iter()
                        .filter(|each| path_holds(&each.path, path))
                        .collect()
                })
                .unwrap_or_default();
            holders.sort_by_key(|each| std::cmp::Reverse(utf16_len(&each.path)));
            let holder = holders.first();
            static PARENT: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"[\\/][^\\/]*$").expect("parent"));
            let parent = PARENT.replace(path, "").into_owned();
            return Ok(LinkTarget {
                connection_id: holder.map(|each| each.connection_id.clone()).or(fallback),
                root: root
                    .clone()
                    .or_else(|| holder.map(|each| each.path.clone()))
                    .unwrap_or(if parent.is_empty() {
                        "/".into()
                    } else {
                        parent
                    }),
                path: Some(path.clone()),
            });
        }
        let place = match root {
            Some(_) => None,
            None => self.file_repository(link, project).await,
        }
        .or_else(|| work_link_roots(link, project).into_iter().next());
        let Some(place) = place else {
            return Err(WorkError::not_found(format!(
                "The file {} has no checkout: the project has no roots",
                one_line(path, 80)
            )));
        };
        Ok(LinkTarget {
            connection_id: place.connection_id.or(fallback),
            root: place.path,
            path: Some(path.clone()),
        })
    }

    /// `bridge.work.link_target`: where a link of an item opens.
    pub async fn link_target(&self, params: &Params) -> WorkResult<LinkTarget> {
        let item = self.item_of(params.get("item"))?;
        let link = parse_work_link(params.get("link").unwrap_or(&Value::Null))?;
        let project = self.read(|store| store.project(&item.project).cloned());
        if let WorkLink::File { .. } = link {
            return self.file_target(&link, project.as_ref()).await;
        }
        if let WorkLink::Deploy { sha, .. } = &link
            && sha == "decision"
        {
            return Err(WorkError::invalid("decisions ticked name no commit"));
        }
        if !matches!(
            link,
            WorkLink::Commit { .. } | WorkLink::Branch { .. } | WorkLink::Deploy { .. }
        ) {
            return Err(WorkError::invalid(
                "only commit, branch and landing links have a repository",
            ));
        }
        let Some(found) = self.link_repository(&link, project.as_ref()).await else {
            return Err(WorkError::not_found(match &link {
                WorkLink::Branch { name, .. } => format!(
                    "The branch {} is not in any of the project's repositories",
                    one_line(name, 80)
                ),
                WorkLink::Deploy { .. } => {
                    "The landed commit is not in any of the project's repositories".into()
                }
                _ => "This commit is not in any of the project's repositories".into(),
            }));
        };
        let connection_id = match found.connection_id {
            Some(id) => Some(id),
            None => self.deps().default_connection().await,
        };
        Ok(LinkTarget {
            connection_id,
            root: found.path,
            path: None,
        })
    }

    /// A commit or branch link without its checkout, or a relative file
    /// link without one: the server finds it.
    fn rootless(&self, link: &WorkLink) -> bool {
        match link {
            WorkLink::File { root, path, .. } => {
                self.deps().has_read_file() && root.is_none() && !is_absolute_work_path(path)
            }
            WorkLink::Commit { root, .. } | WorkLink::Branch { root, .. } => {
                self.deps().has_git() && root.is_none()
            }
            _ => false,
        }
    }

    fn needs_link_roots(&self, item: &WorkItem) -> bool {
        item.links.iter().any(|link| self.rootless(link))
    }

    fn fills(&self) -> Option<mpsc::UnboundedSender<Fill>> {
        let mut fills = self.inner.fills.lock().expect("the fills");
        if let Some(sender) = fills.as_ref()
            && !sender.is_closed()
        {
            return Some(sender.clone());
        }
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let (sender, mut receiver) = mpsc::unbounded_channel::<Fill>();
        // A weak handle: the queue does not keep the service alive.
        let weak = Arc::downgrade(&self.inner);
        runtime.spawn(async move {
            while let Some(fill) = receiver.recv().await {
                match fill {
                    Fill::Item(id) => {
                        let Some(inner) = weak.upgrade() else { break };
                        let service = WorkService { inner };
                        let _ = service.fill_link_roots(&id).await;
                    }
                    Fill::Barrier(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        *fills = Some(sender.clone());
        Some(sender)
    }

    fn fill_link_roots_later(&self, id: &str) {
        if let Some(fills) = self.fills() {
            let _ = fills.send(Fill::Item(id.to_owned()));
        }
    }

    /// Settles once the links' checkouts being looked for are found.
    pub async fn link_roots_filled(&self) {
        let Some(fills) = self.fills() else { return };
        let (done, wait) = oneshot::channel();
        if fills.send(Fill::Barrier(done)).is_ok() {
            let _ = wait.await;
        }
    }

    /// Gives an item's rootless links the checkout that holds them, written
    /// quietly. True when a link changed.
    pub async fn fill_link_roots(&self, id: &str) -> WorkResult<bool> {
        let Some(item) = self.read(|store| store.item(id).cloned()) else {
            return Ok(false);
        };
        if !self.needs_link_roots(&item) {
            return Ok(false);
        }
        let project = self.read(|store| store.project(&item.project).cloned());
        let mut found: Vec<(String, WorkLink)> = Vec::new();
        for link in &item.links {
            if !self.rootless(link) {
                continue;
            }
            let key = format!("{}\n{}", item.project, work_link_key(link));
            if self
                .inner
                .not_found
                .lock()
                .expect("not found")
                .contains(&key)
            {
                continue;
            }
            let place = if let WorkLink::File { .. } = link {
                self.file_repository(link, project.as_ref()).await
            } else {
                self.link_repository(link, project.as_ref()).await
            };
            match place {
                Some(place) => found.push((work_link_key(link), link.with_root(&place.path))),
                None => {
                    self.inner.not_found.lock().expect("not found").insert(key);
                }
            }
        }
        if found.is_empty() {
            return Ok(false);
        }
        // The item as it is now: written meanwhile, only the roots added.
        let Some(current) = self.read(|store| store.item(id).cloned()) else {
            return Ok(false);
        };
        let replaced: Vec<WorkLink> = current
            .links
            .iter()
            .map(|link| {
                if self.rootless(link) {
                    found
                        .iter()
                        .find(|(key, _)| *key == work_link_key(link))
                        .map(|(_, with)| with.clone())
                        .unwrap_or_else(|| link.clone())
                } else {
                    link.clone()
                }
            })
            .collect();
        let links = merge_work_links(&[], &replaced);
        if links == current.links {
            return Ok(false);
        }
        self.write(|store| store.save_item(WorkItem { links, ..current }, None, None))?;
        self.push(WorkPush {
            changed: vec!["item"],
            item: Some(id.to_owned()),
            by: By::Agent,
            summary: None,
        });
        Ok(true)
    }

    /// Every item's links without a checkout, looked for (at start).
    pub async fn backfill_link_roots(&self) {
        let ids: Vec<String> = self.read(|store| {
            store
                .items()
                .iter()
                .filter(|item| self.needs_link_roots(item))
                .map(|item| item.id.clone())
                .collect()
        });
        for id in ids {
            self.fill_link_roots_later(&id);
        }
        self.link_roots_filled().await;
    }

    /// Where a commit landed under the project's rule, or None.
    async fn landed_at(
        &self,
        project: &WorkProject,
        commit: &WorkLink,
        deployed: Option<&str>,
    ) -> Option<WorkLink> {
        if !self.deps().has_git() {
            return None;
        }
        let WorkLink::Commit { sha, root, .. } = commit else {
            return None;
        };
        match &project.done {
            WorkDoneRule::Deployed => {
                let deployed = deployed?;
                let root = root.clone().or_else(|| self.deps().own_root())?;
                if sha == deployed || deployed.starts_with(sha.as_str()) {
                    return Some(WorkLink::Deploy {
                        sha: deployed.into(),
                        branch: None,
                    });
                }
                self.reachable(&root, commit, deployed, None)
                    .await
                    .map(|_| WorkLink::Deploy {
                        sha: deployed.into(),
                        branch: None,
                    })
            }
            WorkDoneRule::Branch {
                root: rule_root,
                branch,
                connection_id,
            } => {
                let root = root.clone().unwrap_or_else(|| rule_root.clone());
                self.reachable(&root, commit, branch, connection_id.as_deref())
                    .await
                    .map(|sha| WorkLink::Deploy {
                        sha,
                        branch: Some(branch.clone()),
                    })
            }
        }
    }

    /// The commit's sha when `target` holds it (its own, or a rebased one
    /// by its subject), else None.
    async fn reachable(
        &self,
        root: &str,
        commit: &WorkLink,
        target: &str,
        connection_id: Option<&str>,
    ) -> Option<String> {
        let WorkLink::Commit { sha, subject, .. } = commit else {
            return None;
        };
        let direct = self
            .deps()
            .git(
                root,
                vec![
                    "merge-base".into(),
                    "--is-ancestor".into(),
                    sha.clone(),
                    target.into(),
                ],
                connection_id,
            )
            .await;
        if direct.code == Some(0) {
            return Some(sha.clone());
        }
        if direct.code != Some(128) && direct.code != Some(1) {
            return None;
        }
        let subject = subject.as_ref().filter(|subject| !subject.is_empty())?;
        let found = self
            .deps()
            .git(
                root,
                vec![
                    "log".into(),
                    "-1".into(),
                    "--format=%H".into(),
                    "--fixed-strings".into(),
                    format!("--grep={subject}"),
                    target.into(),
                ],
                connection_id,
            )
            .await;
        let sha = found
            .stdout
            .trim()
            .split('\n')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        (found.code == Some(0)
            && sha.len() == 40
            && sha
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
        .then_some(sha)
    }

    /// Whether a decision is decided in the file on the project's branch,
    /// else in the working tree of the rule's root (`uncommitted`).
    async fn decision_ticked(&self, project: &WorkProject, decision: &WorkLink) -> (bool, bool) {
        let none = (false, false);
        let WorkLink::Decision {
            path: decision_path,
            id,
        } = decision
        else {
            return none;
        };
        if !self.deps().has_git() {
            return none;
        }
        let Some(root) = project
            .roots
            .iter()
            .find(|each| decision_path.starts_with(&format!("{}/", each.path)))
            .or(project.roots.first())
        else {
            return none;
        };
        // Absolute on the host (a POSIX path, or a Windows drive's):
        // relative to the rule's root, whatever separator it names.
        let path = if roamgate_base::paths::is_host_path(decision_path) {
            decision_path
                .get(root.path.len()..)
                .unwrap_or("")
                .trim_start_matches(['/', '\\'])
                .to_owned()
        } else {
            decision_path.clone()
        };
        let reference = match &project.done {
            WorkDoneRule::Branch { branch, .. } => branch.clone(),
            WorkDoneRule::Deployed => "HEAD".into(),
        };
        let shown = self
            .deps()
            .git(
                &root.path,
                vec!["show".into(), format!("{reference}:{path}")],
                Some(&root.connection_id),
            )
            .await;
        if shown.code == Some(0) && decision_decided(&shown.stdout, id) {
            return (true, false);
        }
        if !self.deps().has_read_file() {
            return none;
        }
        if let WorkDoneRule::Branch { branch, .. } = &project.done {
            let head = self
                .deps()
                .git(
                    &root.path,
                    vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
                    Some(&root.connection_id),
                )
                .await;
            if head.code != Some(0) || head.stdout.trim() != branch {
                return none;
            }
        }
        match self
            .deps()
            .read_file(&root.path, &path, Some(&root.connection_id))
            .await
        {
            Some(text) if decision_decided(&text, id) => (true, true),
            _ => none,
        }
    }

    /// Starts the checks: at once, every 10 minutes, and when the deployed
    /// build changes (read every minute).
    pub fn start(&self) {
        let mut timers = self.inner.timers.lock().expect("the timers");
        if !timers.is_empty() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        *self.inner.last_deployed.lock().expect("deployed") = self.deps().deployed();
        let service = self.clone();
        timers.push(runtime.spawn(async move {
            let _ = service.seed().await;
            service.backfill_link_roots().await;
            let _ = service.check().await;
        }));
        let service = self.clone();
        let mut every = self
            .inner
            .clock
            .interval(Duration::from_millis(WORK_CHECK_MS));
        timers.push(runtime.spawn(async move {
            loop {
                every.tick().await;
                let _ = service.check().await;
            }
        }));
        let service = self.clone();
        let mut every = self
            .inner
            .clock
            .interval(Duration::from_millis(WORK_DEPLOYED_MS));
        timers.push(runtime.spawn(async move {
            loop {
                every.tick().await;
                let current = service.deps().deployed();
                let changed = {
                    let mut last = service.inner.last_deployed.lock().expect("deployed");
                    let changed = *last != current;
                    *last = current;
                    changed
                };
                if changed {
                    service.push(WorkPush {
                        changed: vec!["projects"],
                        item: None,
                        by: By::User,
                        summary: None,
                    });
                    let _ = service.check().await;
                }
            }
        }));
    }

    pub fn stop(&self) {
        for timer in self.inner.timers.lock().expect("the timers").drain(..) {
            timer.abort();
        }
    }

    pub fn started(&self) -> bool {
        !self.inner.timers.lock().expect("the timers").is_empty()
    }

    /// The store read again from disk (the other side wrote it).
    pub fn reload(&self) {
        self.write(WorkStore::reload);
    }
}

fn path_holds(root: &str, path: &str) -> bool {
    let base = root.trim_end_matches(['/', '\\']);
    !base.is_empty() && (path == base || path.starts_with(&format!("{base}/")))
}

/// `Buffer.from(data, "base64")`: what is not base64 is skipped.
fn decode_base64(data: &str) -> Vec<u8> {
    let cleaned: String = data
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(cleaned.trim_end_matches('='))
        .or_else(|_| {
            // A trailing partial byte: drop it, as Node does.
            let usable = cleaned.len() - cleaned.len() % 4;
            let extra = match cleaned.len() % 4 {
                2 | 3 => &cleaned[usable..],
                _ => "",
            };
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(format!("{}{extra}", &cleaned[..usable]))
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
