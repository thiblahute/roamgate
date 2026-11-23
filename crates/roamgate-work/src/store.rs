//! The Work board's store (server/src/work/store.ts): one JSON file with
//! the projects and the items, written whole on every change, and
//! `history.jsonl`, append-only, one line per change of an item (who,
//! when, what), never capped. The threads of an item live in the review
//! store. Also the parsers of what the board is given, with the TS
//! server's messages.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::DataContext;

use crate::model::{
    By, WORK_LINK_KINDS, WorkCoordinator, WorkDoneRule, WorkItem, WorkLink, WorkOwner, WorkProject,
    WorkRoot, is_work_state, limits,
};
use crate::shared::{
    is_absolute_work_path, is_work_id, normalize_work_answers, normalize_work_tags,
    parse_agent_address,
};
use crate::text::{
    js_regex, js_string_of, js_trim, locale_compare, one_line, parse_js_date, slice_utf16,
    unix_lines, utf16_len,
};

/// What went wrong, with the code the agent socket maps to a status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkError {
    pub message: String,
    /// `invalid`, `not_found`, `unavailable`, `conflict`, `forbidden`;
    /// None for an error that is not the board's (a review service's).
    pub code: Option<&'static str>,
}

impl WorkError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::with(message, "invalid")
    }

    pub fn with(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::with(message, "not_found")
    }

    /// An error of what the board calls (no code of the board's).
    pub fn other(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }
}

impl std::fmt::Display for WorkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WorkError {}

pub type WorkResult<T> = Result<T, WorkError>;

/// `<data>/work`, or ROAMGATE_WORK_DIR.
pub fn work_directory(env: &dyn Env, root: &Path) -> PathBuf {
    roamgate_env(env, "WORK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("work"))
}

/// A new item's id: 8 random bytes in hex.
pub fn new_work_id() -> String {
    let bytes: [u8; 8] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The params of a call, as a record (`{}` for anything else).
pub type Params = Map<String, Value>;

fn is_null_or_absent(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `undefined`, `null` or `""`.
pub fn not_given(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null)) || value == Some(&Value::String(String::new()))
}

fn text(value: Option<&Value>, field: &str, max: usize) -> WorkResult<String> {
    let Some(Value::String(raw)) = value else {
        return Err(WorkError::invalid(format!("{field} is required")));
    };
    let out = unix_lines(raw);
    let out = js_trim(&out);
    if out.is_empty() {
        return Err(WorkError::invalid(format!("{field} is empty")));
    }
    if utf16_len(out) > max {
        return Err(WorkError::invalid(format!("{field} is too long")));
    }
    Ok(out.to_owned())
}

fn optional_text(value: Option<&Value>, field: &str, max: usize) -> WorkResult<Option<String>> {
    if not_given(value) {
        return Ok(None);
    }
    text(value, field, max).map(Some)
}

/// `parseWorkState`.
pub fn parse_work_state(value: Option<&Value>) -> WorkResult<String> {
    let state = match value.and_then(Value::as_str) {
        Some("for_you" | "for-you" | "for you") => Some("you"),
        Some(state) if is_work_state(state) => Some(state),
        _ => None,
    };
    state.map(str::to_owned).ok_or_else(|| {
        WorkError::invalid(format!(
            "state must be one of you, doing, verify, open, done (got {})",
            slice_utf16(&js_string_of(value), 20)
        ))
    })
}

/// `parseWorkOwner`.
pub fn parse_work_owner(value: Option<&Value>) -> WorkResult<Option<WorkOwner>> {
    if not_given(value) {
        return Ok(None);
    }
    let raw = match value {
        Some(Value::String(session)) => json!({"session": session}),
        Some(other) => other.clone(),
        None => Value::Null,
    };
    let Value::Object(raw) = raw else {
        return Err(WorkError::invalid("owner must be {session, task?}"));
    };
    let session = text(raw.get("session"), "owner.session", 200)?;
    if parse_agent_address(&session).is_none() {
        return Err(WorkError::invalid(
            "owner.session must be an address, CONNECTION/PANE",
        ));
    }
    let task = optional_text(raw.get("task"), "owner.task", 120)?;
    Ok(Some(WorkOwner { session, task }))
}

/// A project's coordinator: a session's address, or nothing.
pub fn parse_work_coordinator(value: Option<&Value>) -> WorkResult<Option<WorkCoordinator>> {
    Ok(parse_work_owner(value)?.map(|owner| WorkCoordinator {
        session: owner.session,
    }))
}

static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{7,64}$").expect("sha"));
static HTTP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://").expect("http"));

/// `parseWorkLink`.
pub fn parse_work_link(value: &Value) -> WorkResult<WorkLink> {
    let Value::Object(value) = value else {
        return Err(WorkError::invalid("a link is an object with a kind"));
    };
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    if !WORK_LINK_KINDS.contains(&kind) {
        return Err(WorkError::invalid(format!(
            "link kind must be one of {}",
            WORK_LINK_KINDS.join(", ")
        )));
    }
    let get = |key: &str| value.get(key);
    Ok(match kind {
        "review" => WorkLink::Review {
            id: text(get("id"), "link.id", 64)?,
            thread: optional_text(get("thread"), "link.thread", 64)?,
        },
        "effort" => WorkLink::Effort {
            id: text(get("id"), "link.id", 200)?,
            part: optional_text(get("part"), "link.part", 200)?,
        },
        "pr" => {
            let url = text(get("url"), "link.url", 2048)?;
            if !HTTP.is_match(&url) {
                return Err(WorkError::invalid("link.url must be an http(s) URL"));
            }
            WorkLink::Pr { url }
        }
        "commit" => {
            let sha = text(get("sha"), "link.sha", 64)?.to_lowercase();
            if !SHA.is_match(&sha) {
                return Err(WorkError::invalid("link.sha must be a commit sha"));
            }
            let subject = optional_text(get("subject"), "link.subject", 300)?;
            let root = optional_text(get("root"), "link.root", 4096)?;
            WorkLink::Commit {
                sha,
                subject: subject.map(|subject| one_line(&subject, 300)),
                root,
            }
        }
        "branch" => WorkLink::Branch {
            name: text(get("name"), "link.name", 300)?,
            root: optional_text(get("root"), "link.root", 4096)?,
        },
        "decision" => WorkLink::Decision {
            path: text(get("path"), "link.path", 4096)?,
            id: text(get("id"), "link.id", 40)?,
        },
        "file" => parse_work_file_link(value)?,
        "item" => {
            let id = text(get("id"), "link.id", 64)?;
            if !is_work_id(&id) {
                return Err(WorkError::invalid("link.id must be an item id"));
            }
            WorkLink::Item { id }
        }
        "deploy" => {
            let sha = text(get("sha"), "link.sha", 64)?.to_lowercase();
            if !SHA.is_match(&sha) {
                return Err(WorkError::invalid("link.sha must be a commit sha"));
            }
            WorkLink::Deploy {
                sha,
                branch: optional_text(get("branch"), "link.branch", 300)?,
            }
        }
        _ => {
            let session = text(get("session"), "link.session", 200)?;
            if parse_agent_address(&session).is_none() {
                return Err(WorkError::invalid(
                    "link.session must be a session's address",
                ));
            }
            WorkLink::Chat {
                session,
                chat: optional_text(get("chat"), "link.chat", 200)?,
                entry: optional_text(get("entry"), "link.entry", 200)?,
            }
        }
    })
}

static LEADING_DOT_SLASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\./)+").expect("dot slash"));
static ROOT_TRAILING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)(.)[\\/]+$").expect("root trailing"));

/// A file link: its path relative to its root (an absolute path under the
/// root given is made relative to it), or absolute; never out of its root.
fn parse_work_file_link(value: &Map<String, Value>) -> WorkResult<WorkLink> {
    let mut path = LEADING_DOT_SLASH
        .replace(&text(value.get("path"), "link.path", 4096)?, "")
        .into_owned();
    let root = optional_text(value.get("root"), "link.root", 4096)?
        .map(|root| ROOT_TRAILING.replace(&root, "$1").into_owned());
    if let Some(root) = &root
        && !is_absolute_work_path(root)
    {
        return Err(WorkError::invalid("link.root must be an absolute path"));
    }
    if let Some(root) = &root
        && is_absolute_work_path(&path)
    {
        let base = root.trim_end_matches(['/', '\\']);
        if let Some(rest) = path.strip_prefix(&format!("{base}/")) {
            path = rest.to_owned();
        }
    }
    if path.is_empty() {
        return Err(WorkError::invalid("link.path is empty"));
    }
    if !is_absolute_work_path(&path) && path.split(['/', '\\']).any(|part| part == "..") {
        return Err(WorkError::invalid(
            "link.path must stay in its root: give its absolute path instead",
        ));
    }
    let line = match value.get("line") {
        None | Some(Value::Null) => None,
        Some(line) => {
            let whole = line
                .as_f64()
                .filter(|number| number.fract() == 0.0 && (1.0..=10_000_000.0).contains(number));
            match whole {
                Some(number) => Some(number as u64),
                None => {
                    return Err(WorkError::invalid(
                        "link.line must be a line number (1 or more)",
                    ));
                }
            }
        }
    };
    let label = optional_text(value.get("label"), "link.label", 200)?;
    Ok(WorkLink::File {
        path,
        root,
        line,
        label: label.map(|label| one_line(&label, 200)),
    })
}

/// `parseWorkLinks`.
pub fn parse_work_links(value: Option<&Value>) -> WorkResult<Vec<WorkLink>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) => {
            if list.len() > limits::LINKS_PER_ITEM {
                return Err(WorkError::invalid(format!(
                    "at most {} links",
                    limits::LINKS_PER_ITEM
                )));
            }
            list.iter().map(parse_work_link).collect()
        }
        Some(_) => Err(WorkError::invalid("links must be a list")),
    }
}

/// `workLinkKey`: the same place, whatever else differs.
pub fn work_link_key(link: &WorkLink) -> String {
    let or = |value: &Option<String>| value.clone().unwrap_or_default();
    match link {
        WorkLink::Review { id, thread } => format!("review:{id}:{}", or(thread)),
        WorkLink::Effort { id, part } => format!("effort:{id}:{}", or(part)),
        WorkLink::Pr { url } => format!("pr:{url}"),
        WorkLink::Commit { sha, .. } => format!("commit:{sha}"),
        WorkLink::Branch { name, root } => format!("branch:{}:{name}", or(root)),
        WorkLink::Decision { path, id } => format!("decision:{path}:{id}"),
        WorkLink::File {
            path, root, line, ..
        } => format!(
            "file:{}:{path}:{}",
            or(root),
            line.map(|line| line.to_string()).unwrap_or_default()
        ),
        WorkLink::Item { id } => format!("item:{id}"),
        WorkLink::Deploy { sha, .. } => format!("deploy:{sha}"),
        WorkLink::Chat {
            session,
            chat,
            entry,
        } => format!("chat:{session}:{}:{}", or(chat), or(entry)),
    }
}

/// `mergeWorkLinks`: one link per place, the current ones first.
pub fn merge_work_links(current: &[WorkLink], added: &[WorkLink]) -> Vec<WorkLink> {
    let mut out = current.to_vec();
    let mut keys: std::collections::HashSet<String> = out.iter().map(work_link_key).collect();
    for link in added {
        if keys.insert(work_link_key(link)) {
            out.push(link.clone());
        }
    }
    out.truncate(limits::LINKS_PER_ITEM);
    out
}

/// `parseWorkSource`.
pub fn parse_work_source(value: Option<&Value>) -> WorkResult<Option<String>> {
    if not_given(value) {
        return Ok(None);
    }
    if !matches!(value, Some(Value::String(_))) {
        return Err(WorkError::invalid("source must be words"));
    }
    Ok(Some(one_line(&text(value, "source", 400)?, 300)))
}

/// `parseWorkTime`: a time as given (ISO 8601, or epoch milliseconds), as
/// ISO.
pub fn parse_work_time(value: Option<&Value>, field: &str) -> WorkResult<Option<String>> {
    if not_given(value) {
        return Ok(None);
    }
    let at = value
        .filter(|value| value.is_number() || value.is_string())
        .and_then(parse_js_date);
    match at {
        Some(at) => Ok(Some(crate::text::iso(at))),
        None => Err(WorkError::invalid(format!(
            "{field} must be a date (ISO 8601)"
        ))),
    }
}

/// `parseWorkTitle` (store): one line of 300 at most.
pub fn parse_work_title(value: Option<&Value>) -> WorkResult<String> {
    Ok(one_line(
        &text(value, "title", limits::TITLE_CHARS * 2)?,
        limits::TITLE_CHARS,
    ))
}

static TAG_SPLIT: LazyLock<Regex> = LazyLock::new(|| js_regex("[{S},]+"));

/// `parseWorkTags`.
pub fn parse_work_tags(value: Option<&Value>) -> WorkResult<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(words)) => {
            let list: Vec<&str> = TAG_SPLIT.split(words).collect();
            Ok(normalize_work_tags(&list))
        }
        Some(Value::Array(list)) => {
            let mut words = Vec::with_capacity(list.len());
            for tag in list {
                let Value::String(tag) = tag else {
                    return Err(WorkError::invalid("tags must be words"));
                };
                words.push(tag.as_str());
            }
            Ok(normalize_work_tags(&words))
        }
        Some(_) => Err(WorkError::invalid("tags must be a list of words")),
    }
}

/// `parseWorkAsk`: one or two sentences on one line; null, "" or none
/// clears it.
pub fn parse_work_ask(value: Option<&Value>) -> WorkResult<Option<String>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(ask)) => {
            let trimmed = js_trim(ask);
            if trimmed.is_empty() {
                return Ok(None);
            }
            if utf16_len(trimmed) > limits::ASK_CHARS {
                return Err(WorkError::invalid(format!(
                    "ask is too long: one or two sentences, {} characters at most",
                    limits::ASK_CHARS
                )));
            }
            Ok(Some(one_line(ask, limits::ASK_CHARS)))
        }
        Some(_) => Err(WorkError::invalid("ask must be words")),
    }
}

/// `parseWorkAnswers`.
pub fn parse_work_answers(value: Option<&Value>) -> WorkResult<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => {
            if list.len() > limits::ANSWERS {
                return Err(WorkError::invalid(format!(
                    "at most {} answers",
                    limits::ANSWERS
                )));
            }
            let words: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
            Ok(normalize_work_answers(&words))
        }
        Some(_) => Err(WorkError::invalid(
            "answers must be a list of short answers",
        )),
    }
}

fn strings_of(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// `normalItem`: an item as read from the file, or None.
pub fn normal_item(raw: &Value) -> Option<WorkItem> {
    let raw = raw.as_object()?;
    let id = raw.get("id")?.as_str()?;
    if !is_work_id(id) {
        return None;
    }
    let title = raw.get("title")?.as_str()?;
    let project = raw.get("project")?.as_str()?;
    let state = raw.get("state")?.as_str()?;
    if !is_work_state(state) {
        return None;
    }
    let links = parse_work_links(raw.get("links")).unwrap_or_default();
    let owner = parse_work_owner(raw.get("owner")).unwrap_or(None);
    let source = raw.get("source").and_then(Value::as_str).map(str::to_owned);
    let at = raw
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let ask = raw
        .get("ask")
        .and_then(Value::as_str)
        .filter(|ask| !js_trim(ask).is_empty())
        .map(|ask| one_line(ask, limits::ASK_CHARS));
    let answers = if ask.is_some() {
        normalize_work_answers(&strings_of(raw.get("answers")))
    } else {
        Vec::new()
    };
    let questions = raw
        .get("questions")
        .and_then(Value::as_f64)
        .filter(|number| number.fract() == 0.0 && *number > 0.0)
        .map(|number| number as u64);
    Some(WorkItem {
        id: id.to_owned(),
        project: project.to_owned(),
        title: one_line(title, limits::TITLE_CHARS),
        state: state.to_owned(),
        tags: normalize_work_tags(&strings_of(raw.get("tags"))),
        owner,
        // An empty source is none, as `...(source ? ...)` drops it.
        source: source.filter(|source| !source.is_empty()),
        links,
        created_at: at.clone(),
        updated_at: raw
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or(at),
        done_at: raw.get("doneAt").and_then(Value::as_str).map(str::to_owned),
        by: if raw.get("by").and_then(Value::as_str) == Some("agent") {
            By::Agent
        } else {
            By::User
        },
        review: raw.get("review").and_then(Value::as_str).map(str::to_owned),
        needs_triage: raw.get("needsTriage") == Some(&Value::Bool(true)),
        ask,
        answers: (!answers.is_empty()).then_some(answers),
        questions,
    })
}

/// `parseDoneRule`.
pub fn parse_done_rule(value: Option<&Value>) -> WorkResult<WorkDoneRule> {
    let Some(Value::Object(value)) = value else {
        return Err(WorkError::invalid("done must be a rule"));
    };
    match value.get("kind").and_then(Value::as_str) {
        Some("deployed") => Ok(WorkDoneRule::Deployed),
        Some("branch") => Ok(WorkDoneRule::Branch {
            root: text(value.get("root"), "done.root", 4096)?,
            branch: text(value.get("branch"), "done.branch", 300)?,
            connection_id: optional_text(value.get("connectionId"), "done.connection", 200)?,
        }),
        _ => Err(WorkError::invalid("done.kind must be deployed or branch")),
    }
}

/// `normalProject`.
pub fn normal_project(raw: &Value) -> Option<WorkProject> {
    let raw = raw.as_object()?;
    let id = raw.get("id")?.as_str().filter(|id| !id.is_empty())?;
    let name = raw.get("name")?.as_str()?;
    let done = parse_done_rule(raw.get("done")).unwrap_or(WorkDoneRule::Deployed);
    let roots = raw
        .get("roots")
        .and_then(Value::as_array)
        .map(|roots| {
            roots
                .iter()
                .filter_map(|root| {
                    Some(WorkRoot {
                        connection_id: root.get("connectionId")?.as_str()?.to_owned(),
                        path: root.get("path")?.as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let coordinator = parse_work_coordinator(raw.get("coordinator")).unwrap_or(None);
    let parent = raw
        .get("parent")
        .and_then(Value::as_str)
        .filter(|parent| !parent.is_empty() && *parent != id)
        .map(|parent| slice_utf16(parent, 64).to_owned());
    Some(WorkProject {
        id: slice_utf16(id, 64).to_owned(),
        name: one_line(name, 80),
        roots,
        done,
        tags: raw
            .get("tags")
            .and_then(Value::as_array)
            .map(|_| normalize_work_tags(&strings_of(raw.get("tags")))),
        coordinator,
        parent,
    })
}

/// A line of `history.jsonl`.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct WorkHistoryLine {
    pub at: String,
    pub item: String,
    pub by: String,
    /// What changed: the fields and their new values.
    pub change: Map<String, Value>,
}

/// Who made a Work change, for the history's per-change commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkActor {
    pub by: By,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

impl WorkActor {
    pub fn of(by: By) -> Self {
        Self {
            by,
            address: None,
            caller: None,
        }
    }
}

/// Where the store tells the local history what it wrote
/// (server/src/history/hooks.ts), after its own write succeeded.
pub trait HistorySink: Send + Sync {
    fn changed(&self, area: &str, id: Option<&str>);
    /// `item` None: removed.
    fn work_changed(
        &self,
        item: Option<&WorkItem>,
        id: &str,
        change: &Map<String, Value>,
        actor: &WorkActor,
        at: &str,
    );
}

/// A sink that hears nothing (tests, the CLI).
pub struct NoHistory;

impl HistorySink for NoHistory {
    fn changed(&self, _area: &str, _id: Option<&str>) {}
    fn work_changed(
        &self,
        _item: Option<&WorkItem>,
        _id: &str,
        _change: &Map<String, Value>,
        _actor: &WorkActor,
        _at: &str,
    ) {
    }
}

/// Whether this process may write the store now (the owners table's one
/// writer per file): Err says why not.
pub type CanWrite = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// How the store writes: to its directory, or nowhere (a shadow read).
#[derive(Clone)]
pub enum StoreWrites {
    Disk {
        context: DataContext,
        can_write: Option<CanWrite>,
    },
    /// In memory only: nothing is written (the board read by the side that
    /// does not own it).
    Memory,
}

/// The file as written.
#[derive(Serialize)]
struct StoreFile<'a> {
    version: u8,
    projects: &'a [WorkProject],
    items: &'a [WorkItem],
}

/// `JSON.stringify(value, null, 1)`.
fn stringify_one(value: &impl Serialize) -> String {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    value.serialize(&mut serializer).expect("JSON serialises");
    String::from_utf8(out).expect("JSON is UTF-8")
}

/// The store at a directory: read once, kept in memory, written whole on
/// each change. A file that does not parse is treated as empty (never
/// overwritten until something is saved).
pub struct WorkStore {
    pub path: PathBuf,
    history_path: PathBuf,
    directory: PathBuf,
    projects: Vec<WorkProject>,
    items: Vec<WorkItem>,
    writes: StoreWrites,
    sink: Arc<dyn HistorySink>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl WorkStore {
    pub fn open(
        directory: &Path,
        writes: StoreWrites,
        sink: Arc<dyn HistorySink>,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        let path = directory.join("work.json");
        let mut store = Self {
            history_path: directory.join("history.jsonl"),
            directory: directory.to_path_buf(),
            path,
            projects: Vec::new(),
            items: Vec::new(),
            writes,
            sink,
            now,
        };
        store.reload();
        store
    }

    /// Reads the file again (the other side wrote it meanwhile).
    pub fn reload(&mut self) {
        self.projects.clear();
        self.items.clear();
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return;
        };
        let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        self.projects = raw
            .get("projects")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(normal_project).collect())
            .unwrap_or_default();
        self.items = raw
            .get("items")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(normal_item).collect())
            .unwrap_or_default();
    }

    fn save(&self) -> WorkResult<()> {
        let StoreWrites::Disk { context, can_write } = &self.writes else {
            return Ok(());
        };
        if let Some(can_write) = can_write {
            can_write().map_err(WorkError::other)?;
        }
        create_private_dir(&self.directory).map_err(|error| WorkError::other(error.to_string()))?;
        let file = StoreFile {
            version: 1,
            projects: &self.projects,
            items: &self.items,
        };
        context
            .replace_data_file(
                &self.path,
                format!("{}\n", stringify_one(&file)).as_bytes(),
                0o600,
            )
            .map_err(|error| WorkError::other(error.to_string()))
    }

    fn history(&self, line: &WorkHistoryLine) {
        let StoreWrites::Disk { .. } = &self.writes else {
            return;
        };
        // The store is the truth; the history is a convenience.
        let _ = (|| -> std::io::Result<()> {
            create_private_dir(&self.directory)?;
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&self.history_path)?;
            let mut text = serde_json::to_string(line).map_err(std::io::Error::other)?;
            text.push('\n');
            file.write_all(text.as_bytes())
        })();
    }

    pub fn projects(&self) -> &[WorkProject] {
        &self.projects
    }

    pub fn items(&self) -> &[WorkItem] {
        &self.items
    }

    /// A project by id or name.
    pub fn project(&self, id: &str) -> Option<&WorkProject> {
        self.projects
            .iter()
            .find(|project| project.id == id || project.name == id)
    }

    pub fn item(&self, id: &str) -> Option<&WorkItem> {
        self.items.iter().find(|item| item.id == id)
    }

    /// An item by its id or a prefix of it (8 characters at least).
    pub fn find(&self, reference: &str) -> Option<&WorkItem> {
        let key = js_trim(reference).to_lowercase();
        if key.is_empty() {
            return None;
        }
        if let Some(exact) = self.item(&key) {
            return Some(exact);
        }
        if utf16_len(&key) < 8 {
            return None;
        }
        let mut matches = self.items.iter().filter(|item| item.id.starts_with(&key));
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }

    pub fn save_project(&mut self, project: WorkProject) -> WorkResult<()> {
        if !self.projects.iter().any(|each| each.id == project.id)
            && self.projects.len() >= limits::PROJECTS
        {
            return Err(WorkError::invalid(format!(
                "at most {} projects",
                limits::PROJECTS
            )));
        }
        let before = self.projects.clone();
        self.projects.retain(|each| each.id != project.id);
        self.projects.push(project);
        self.projects
            .sort_by(|a, b| locale_compare(&a.name, &b.name));
        if let Err(error) = self.save() {
            self.projects = before;
            return Err(error);
        }
        self.sink.changed("work", None);
        Ok(())
    }

    /// Writes an item; `change` is what changed (a line of the history),
    /// `actor` who changed it (else the item's `by`).
    pub fn save_item(
        &mut self,
        item: WorkItem,
        change: Option<&Map<String, Value>>,
        actor: Option<&WorkActor>,
    ) -> WorkResult<()> {
        let before = self.items.clone();
        match self.items.iter().position(|each| each.id == item.id) {
            Some(at) => self.items[at] = item.clone(),
            None => {
                if self.items.len() >= limits::ITEMS {
                    return Err(WorkError::invalid(format!(
                        "at most {} items",
                        limits::ITEMS
                    )));
                }
                self.items.push(item.clone());
            }
        }
        if let Err(error) = self.save() {
            self.items = before;
            return Err(error);
        }
        let empty = Map::new();
        let change = change.unwrap_or(&empty);
        if !change.is_empty() {
            self.history(&WorkHistoryLine {
                at: item.updated_at.clone(),
                item: item.id.clone(),
                by: item.by.as_str().into(),
                change: change.clone(),
            });
        }
        let actor = actor.cloned().unwrap_or_else(|| WorkActor::of(item.by));
        let at = if item.updated_at.is_empty() {
            (self.now)()
        } else {
            item.updated_at.clone()
        };
        if matches!(self.writes, StoreWrites::Disk { .. }) {
            self.sink
                .work_changed(Some(&item), &item.id, change, &actor, &at);
        }
        Ok(())
    }

    /// The history's lines of an item, oldest first (the file read whole).
    pub fn history_of(&self, id: &str) -> Vec<WorkHistoryLine> {
        let Ok(text) = std::fs::read_to_string(&self.history_path) else {
            return Vec::new();
        };
        text.split('\n')
            .filter(|line| line.contains(id))
            .filter_map(|line| serde_json::from_str::<WorkHistoryLine>(line).ok())
            .filter(|line| line.item == id)
            .collect()
    }

    pub fn remove_item(&mut self, id: &str, actor: Option<&WorkActor>) -> WorkResult<()> {
        let before = self.items.clone();
        self.items.retain(|item| item.id != id);
        if let Err(error) = self.save() {
            self.items = before;
            return Err(error);
        }
        let mut change = Map::new();
        change.insert("removed".into(), Value::Bool(true));
        let actor = actor.cloned().unwrap_or_else(|| WorkActor::of(By::User));
        self.sink
            .work_changed(None, id, &change, &actor, &(self.now)());
        Ok(())
    }

    /// The file as it is (tests and exports).
    pub fn snapshot(&self) -> Value {
        json!({"version": 1, "projects": self.projects, "items": self.items})
    }

    /// Whether this store writes to disk.
    pub fn writes_to_disk(&self) -> bool {
        matches!(self.writes, StoreWrites::Disk { .. })
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// `given`: neither undefined, null nor "".
pub fn given(value: Option<&Value>) -> bool {
    !not_given(value)
}

/// Absent or null.
pub fn absent(value: Option<&Value>) -> bool {
    is_null_or_absent(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ReviewThread, WorkRoot};
    use crate::shared::{
        WorkFilter, filter_work_items, parse_title_line, work_description_thread, work_tags_of,
    };

    fn open(dir: &Path) -> WorkStore {
        WorkStore::open(
            dir,
            StoreWrites::Disk {
                context: DataContext::new(dir, roamgate_base::paths::Platform::current(), None),
                can_write: None,
            },
            Arc::new(NoHistory),
            Arc::new(|| "2026-11-20T10:00:00.000Z".into()),
        )
    }

    pub(crate) fn item(id: &str, project: &str, tags: &[&str], state: &str) -> WorkItem {
        WorkItem {
            id: id.into(),
            project: project.into(),
            title: format!("title {id}"),
            state: state.into(),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
            owner: None,
            source: None,
            links: Vec::new(),
            created_at: "2026-11-20T10:00:00.000Z".into(),
            updated_at: "2026-11-20T10:00:00.000Z".into(),
            done_at: None,
            by: By::User,
            review: None,
            needs_triage: false,
            ask: None,
            answers: None,
            questions: None,
        }
    }

    fn thread(id: &str, created_at: &str, work: Value) -> ReviewThread {
        ReviewThread {
            id: id.into(),
            created_at: created_at.into(),
            anchor: json!({ "work": work }),
            ..ReviewThread::default()
        }
    }

    #[test]
    fn the_thread_made_with_the_item_else_the_earliest_bare_one_within_a_minute() {
        let made = "2026-11-20T10:00:00.000Z";
        let marked = thread(
            "m",
            "2026-11-20T12:00:00.000Z",
            json!({"item": "x", "description": true}),
        );
        let early = thread("e", "2026-11-20T10:00:03.000Z", json!({"item": "x"}));
        let quoted = thread(
            "q",
            "2026-11-20T10:00:01.000Z",
            json!({"item": "x", "quote": "words"}),
        );
        let adopted = thread(
            "a",
            "2026-11-20T09:59:30.000Z",
            json!({"item": "x", "from": {"review": "r", "thread": "t"}}),
        );
        let late = thread("l", "2026-11-20T10:02:00.000Z", json!({"item": "x"}));
        let id = |threads: &[ReviewThread], at: &str| {
            work_description_thread(threads, at).map(|thread| thread.id.clone())
        };
        assert_eq!(
            id(&[late.clone(), early.clone(), marked], made).as_deref(),
            Some("m")
        );
        assert_eq!(
            id(
                &[late.clone(), quoted.clone(), adopted.clone(), early.clone()],
                made
            )
            .as_deref(),
            Some("e")
        );
        assert_eq!(id(&[late, quoted, adopted], made), None);
        assert_eq!(id(&[early], "nope"), None);
    }

    #[test]
    fn keeps_items_and_projects_across_reopen_with_a_history_line_per_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = open(dir.path());
        store
            .save_project(WorkProject {
                id: "roamgate".into(),
                name: "roamgate".into(),
                roots: vec![WorkRoot {
                    connection_id: "local".into(),
                    path: "/r".into(),
                }],
                done: WorkDoneRule::Deployed,
                tags: None,
                coordinator: Some(WorkCoordinator {
                    session: "desktop/w35:p1".into(),
                }),
                parent: None,
            })
            .unwrap();
        let mut made = item("0123456789abcdef", "roamgate", &["reviews"], "open");
        made.title = "Fix the thing".into();
        let mut change = Map::new();
        change.insert("state".into(), json!("open"));
        store.save_item(made, Some(&change), None).unwrap();
        let again = open(dir.path());
        assert_eq!(
            again
                .projects()
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["roamgate"]
        );
        assert_eq!(
            again.project("roamgate").unwrap().coordinator,
            Some(WorkCoordinator {
                session: "desktop/w35:p1".into()
            })
        );
        assert_eq!(
            again.item("0123456789abcdef").unwrap().title,
            "Fix the thing"
        );
        assert_eq!(again.find("01234567").unwrap().id, "0123456789abcdef");
        assert!(again.find("0123").is_none());
        let history = std::fs::read_to_string(dir.path().join("history.jsonl")).unwrap();
        let line: Value = serde_json::from_str(history.trim()).unwrap();
        assert_eq!(line["change"], json!({"state": "open"}));
        assert!(dir.path().join("work.json").exists());
    }

    #[test]
    fn keeps_an_item_s_ask_and_answers_answers_only_with_an_ask() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = open(dir.path());
        let mut asked = item("0123456789abcdef", "roamgate", &[], "you");
        asked.by = By::Agent;
        asked.ask = Some("Choose: A or B".into());
        asked.answers = Some(vec!["A".into(), "B".into()]);
        store.save_item(asked, Some(&Map::new()), None).unwrap();
        let mut stray = item("fedcba9876543210", "roamgate", &[], "you");
        stray.answers = Some(vec!["stray".into()]);
        store.save_item(stray, Some(&Map::new()), None).unwrap();
        let again = open(dir.path());
        let kept = again.item("0123456789abcdef").unwrap();
        assert_eq!(kept.ask.as_deref(), Some("Choose: A or B"));
        assert_eq!(kept.answers, Some(vec!["A".into(), "B".into()]));
        assert_eq!(again.item("fedcba9876543210").unwrap().answers, None);
    }

    #[test]
    fn parses_an_ask_and_answers_refusing_what_is_not_one() {
        assert_eq!(
            parse_work_ask(Some(&json!(" Try it\n once. ")))
                .unwrap()
                .as_deref(),
            Some("Try it once.")
        );
        assert_eq!(parse_work_ask(Some(&Value::Null)).unwrap(), None);
        assert_eq!(parse_work_ask(Some(&json!("  "))).unwrap(), None);
        assert!(parse_work_ask(Some(&json!(3))).is_err());
        assert!(
            parse_work_ask(Some(&json!("x".repeat(401))))
                .unwrap_err()
                .message
                .contains("too long")
        );
        assert!(parse_work_answers(Some(&Value::Null)).unwrap().is_empty());
        assert_eq!(
            parse_work_answers(Some(&json!(["A", " a "]))).unwrap(),
            ["A"]
        );
        assert!(parse_work_answers(Some(&json!("A"))).is_err());
        assert!(parse_work_answers(Some(&json!([1]))).is_err());
    }

    #[test]
    fn a_broken_file_reads_as_empty_and_is_not_overwritten_until_saved() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("work.json");
        std::fs::write(&bad, "{not json").unwrap();
        let store = open(dir.path());
        assert!(store.items().is_empty());
        assert!(store.projects().is_empty());
        assert_eq!(std::fs::read_to_string(&bad).unwrap(), "{not json");
    }

    #[test]
    fn parses_states_owners_and_links_refusing_what_is_not_one() {
        assert_eq!(parse_work_state(Some(&json!("for you"))).unwrap(), "you");
        assert_eq!(parse_work_state(Some(&json!("doing"))).unwrap(), "doing");
        assert_eq!(
            parse_work_state(Some(&json!("later"))).unwrap_err().message,
            "state must be one of you, doing, verify, open, done (got later)"
        );
        assert_eq!(
            parse_work_owner(Some(&json!("desktop/w35:p1"))).unwrap(),
            Some(WorkOwner {
                session: "desktop/w35:p1".into(),
                task: None
            })
        );
        assert_eq!(
            parse_work_owner(Some(&json!({"session": "desktop/w35:p1", "task": "a1b2"}))).unwrap(),
            Some(WorkOwner {
                session: "desktop/w35:p1".into(),
                task: Some("a1b2".into())
            })
        );
        assert!(
            parse_work_owner(Some(&json!("nowhere")))
                .unwrap_err()
                .message
                .contains("CONNECTION/PANE")
        );
        assert_eq!(
            parse_work_link(&json!({"kind": "commit", "sha": "ABCDEF1", "subject": "x"}))
                .unwrap()
                .to_json(),
            json!({"kind": "commit", "sha": "abcdef1", "subject": "x"})
        );
        assert!(parse_work_link(&json!({"kind": "commit", "sha": "zz"})).is_err());
        assert!(parse_work_link(&json!({"kind": "pr", "url": "ftp://x"})).is_err());
        assert_eq!(
            parse_work_link(&json!({"kind": "decision", "path": "rfcs/0052.md", "id": "D13"}))
                .unwrap()
                .to_json(),
            json!({"kind": "decision", "path": "rfcs/0052.md", "id": "D13"})
        );
        assert!(
            parse_work_link(&json!({"kind": "what"}))
                .unwrap_err()
                .message
                .contains("link kind")
        );
    }

    #[test]
    fn a_file_link_its_path_in_its_root_a_line_and_a_label_never_out_of_its_root() {
        let link = |value: Value| parse_work_link(&value).map(|link| link.to_json());
        assert_eq!(
            link(json!({
                "kind": "file",
                "path": "./plans/agent-prompts.md",
                "root": "/home/me/meta/",
                "line": 12,
                "label": "  The prompts\nplan "
            }))
            .unwrap(),
            json!({
                "kind": "file",
                "path": "plans/agent-prompts.md",
                "root": "/home/me/meta",
                "line": 12,
                "label": "The prompts plan"
            })
        );
        assert_eq!(
            link(
                json!({"kind": "file", "path": "/home/me/meta/plans/a.md", "root": "/home/me/meta"})
            )
            .unwrap(),
            json!({"kind": "file", "path": "plans/a.md", "root": "/home/me/meta"})
        );
        assert_eq!(
            link(json!({"kind": "file", "path": "/srv/rfc.md"})).unwrap(),
            json!({"kind": "file", "path": "/srv/rfc.md"})
        );
        let refused = |value: Value| link(value).unwrap_err().message;
        assert!(
            refused(json!({"kind": "file", "path": "../secret", "root": "/a"}))
                .contains("stay in its root")
        );
        assert!(
            refused(json!({"kind": "file", "path": "a.md", "root": "relative"}))
                .contains("absolute path")
        );
        assert!(
            refused(json!({"kind": "file", "path": "a.md", "line": 0})).contains("line number")
        );
        assert!(refused(json!({"kind": "file"})).contains("link.path"));
        let file = |line: Option<u64>| WorkLink::File {
            path: "a.md".into(),
            root: Some("/r".into()),
            line,
            label: None,
        };
        assert_eq!(
            merge_work_links(&[file(None)], &[file(None), file(Some(3))]),
            vec![file(None), file(Some(3))]
        );
    }

    #[test]
    fn merges_links_by_place_one_commit_per_sha_one_review_thread_each() {
        let commit = |subject: Option<&str>| WorkLink::Commit {
            sha: "abcdef1".into(),
            subject: subject.map(str::to_owned),
            root: None,
        };
        let review = WorkLink::Review {
            id: "r1".into(),
            thread: Some("t1".into()),
        };
        assert_eq!(
            merge_work_links(
                &[commit(None)],
                &[commit(Some("same")), review.clone(), review.clone()]
            ),
            vec![commit(None), review]
        );
    }

    #[test]
    fn cuts_to_max_characters_the_ellipsis_included() {
        assert_eq!(one_line(&"x".repeat(300), 300), "x".repeat(300));
        let cut = one_line(&"x".repeat(301), 300);
        assert_eq!(utf16_len(&cut), 300);
        assert_eq!(cut, format!("{}...", "x".repeat(297)));
        assert_eq!(one_line(" a\n  b\u{7} ", 10), "a b");
    }

    #[test]
    fn reads_the_todo_title_line_state_title() {
        let parse = |line: &str| parse_title_line(line);
        assert_eq!(
            parse("**doing** Fix the keys\nmore"),
            (Some("doing".into()), "Fix the keys".into())
        );
        assert_eq!(
            parse("**you**: Decide the color"),
            (Some("you".into()), "Decide the color".into())
        );
        assert_eq!(
            parse("**For-you** Something"),
            (Some("you".into()), "Something".into())
        );
        assert_eq!(parse("Plain first line"), (None, "Plain first line".into()));
        assert_eq!(
            parse("**bold** not a state"),
            (None, "**bold** not a state".into())
        );
    }

    #[test]
    fn normalizes_tags_and_filters_items_by_project_tags_and_state() {
        assert_eq!(
            normalize_work_tags(&["Reviews", " voice calls ", "#android", "reviews"]),
            ["reviews", "voice-calls", "android"]
        );
        let items = vec![
            item("a", "roamgate", &["reviews", "phone"], "you"),
            item("b", "roamgate", &["voice"], "doing"),
            item("c", "gst2", &["reviews"], "open"),
        ];
        let ids = |filter: WorkFilter| {
            filter_work_items(&items, &filter)
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(WorkFilter {
                project: Some("roamgate".into()),
                ..WorkFilter::default()
            }),
            ["a", "b"]
        );
        assert_eq!(
            ids(WorkFilter {
                tags: vec!["reviews".into()],
                ..WorkFilter::default()
            }),
            ["a", "c"]
        );
        assert_eq!(
            ids(WorkFilter {
                tags: vec!["reviews".into(), "phone".into()],
                ..WorkFilter::default()
            }),
            ["a"]
        );
        assert_eq!(
            ids(WorkFilter {
                states: Some(vec!["doing".into(), "open".into()]),
                ..WorkFilter::default()
            }),
            ["b", "c"]
        );
        assert_eq!(
            ids(WorkFilter {
                query: Some("title b".into()),
                ..WorkFilter::default()
            }),
            ["b"]
        );
        assert_eq!(work_tags_of(&items), ["reviews", "phone", "voice"]);
    }
}
