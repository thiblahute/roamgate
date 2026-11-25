//! `session-projection-cache.ts`: a session's projection (history entries,
//! messages, tasks, artifacts, title, commands, stats), kept per connection
//! with revisions for deltas; large Claude transcripts read by their end,
//! with a slim index for what needs the whole session.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LazyLock};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::files::BoxFut;
use crate::files::SessionFiles;
use crate::history::{
    HISTORY_WINDOW_LIMIT, all_history_entries, append_only_history,
    history_entries_from_trajectory, history_epoch, history_update,
};
use crate::index_store::SessionIndexStore;
use crate::js::{self, Obj, sv};
use crate::messages::conversation_messages_from_trajectory;
use crate::rewind::{kept_records, rewound_record_ids};
use crate::session::SessionFile;
use crate::shared::history_window::history_window_entries;
use crate::tail::{
    self, LARGE_SESSION_BYTES, MAX_APPEND_BYTES, MAX_TAIL_BYTES, SlimIndex, parse_whole_lines,
};
use crate::trajectory::project_agent_trajectory;
use crate::utils::parse_jsonl;
use crate::{artifacts, commands, tasks, title, token_usage};

/// A resolved session (`AgentSessionResolved`), as the handlers pass it.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub value: Obj,
    pub agent: String,
    pub session_kind: Option<String>,
    pub session_value: Option<String>,
    pub file: Option<SessionFile>,
}

impl Resolved {
    /// From what the resolver answered.
    pub fn from_value(value: Obj) -> Self {
        let session = js::rec(value.get("session"));
        Self {
            agent: js::sv(value.get("agent")).to_owned(),
            session_kind: session
                .and_then(|s| js::str_of(s.get("kind")))
                .map(str::to_owned),
            session_value: session
                .and_then(|s| js::str_of(s.get("value")))
                .map(str::to_owned),
            file: value
                .get("file")
                .filter(|f| f.is_object())
                .map(SessionFile::from_value),
            value,
        }
    }

    fn key(&self) -> String {
        js::stringify(&Value::Array(vec![
            Value::String(self.agent.clone()),
            self.session_kind.clone().map_or(Value::Null, Value::String),
            self.session_value
                .clone()
                .map_or(Value::Null, Value::String),
        ]))
    }
}

/// What needs the whole session.
#[derive(Debug, Clone)]
pub struct Aggregates {
    pub tasks: Vec<Value>,
    pub artifacts: Vec<Value>,
    pub title: Option<String>,
    pub commands: Vec<Value>,
    pub stats: Value,
}

impl Aggregates {
    pub fn to_value(&self) -> Value {
        Value::Object(obj! {
            "tasks" => self.tasks.clone(),
            "artifacts" => self.artifacts.clone(),
            "title" => self.title.clone().map_or(Value::Null, Value::String),
            "commands" => self.commands.clone(),
            "stats" => self.stats.clone(),
        })
    }

    pub fn from_value(value: &Value) -> Self {
        let list = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        Self {
            tasks: list("tasks"),
            artifacts: list("artifacts"),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            commands: list("commands"),
            stats: value.get("stats").cloned().unwrap_or(Value::Null),
        }
    }
}

/// A session's projection (without its trajectory, built again on need).
#[derive(Debug, Clone)]
pub struct Projection {
    pub file: SessionFile,
    pub messages: Vec<Value>,
    pub entries: Vec<Value>,
    pub all_entries: Vec<Value>,
    pub aggregates: Aggregates,
    pub partial: bool,
}

fn stats(turns: usize, records: usize, usage: Option<token_usage::TokenUsage>) -> Value {
    Value::Object(obj! {
        "turns" => turns,
        "records" => records,
        "token_usage" => usage.map_or(Value::Null, |u| u.to_value()),
    })
}

/// Every record of a transcript, in chunks for a large one.
pub async fn read_jsonl_records(
    file: &SessionFile,
    files: &dyn SessionFiles,
) -> io::Result<Vec<Obj>> {
    let size = file.size.unwrap_or(0.0) as u64;
    if !files.has_range() || size < LARGE_SESSION_BYTES {
        return Ok(parse_jsonl(&files.read_text(&file.path).await?));
    }
    let mut records = Vec::new();
    let mut carry: Vec<u8> = Vec::new();
    let mut at = 0u64;
    loop {
        let chunk = files
            .read_range(&file.path, at, at + 4 * 1024 * 1024)
            .await?;
        if chunk.is_empty() {
            break;
        }
        at += chunk.len() as u64;
        carry.extend_from_slice(&chunk);
        let (lines, used) = parse_whole_lines(&carry);
        records.extend(lines);
        carry.drain(..used);
    }
    if !carry.is_empty() {
        records.extend(parse_jsonl(&String::from_utf8_lossy(&carry)));
    }
    Ok(records)
}

/// The records of a session, as its reader gives them.
async fn read_records(
    agent: &str,
    file: &SessionFile,
    files: &dyn SessionFiles,
) -> io::Result<Vec<Obj>> {
    if agent == "agy" {
        return Ok(crate::antigravity::read_antigravity_session_records(
            &file.path,
        ));
    }
    read_jsonl_records(file, files).await
}

/// A session's whole projection and trajectory.
pub async fn read_session_projection(
    agent: &str,
    file: &SessionFile,
    files: &dyn SessionFiles,
    fallback_time: Option<f64>,
) -> io::Result<(Projection, Value)> {
    let fallback = fallback_time.unwrap_or(file.created_at_ms.unwrap_or(file.mtime_ms));
    let read = read_records(agent, file, files).await?;
    let rewound = (agent == "claude").then(|| rewound_record_ids(&read));
    let records = kept_records(read.clone(), rewound.as_ref());
    let projection_file = SessionFile {
        mtime_ms: fallback,
        ..file.clone()
    };
    let trajectory = project_agent_trajectory(agent, &projection_file, &records);
    let messages = conversation_messages_from_trajectory(&projection_file, &trajectory);
    let claude = agent == "claude";
    let turns = messages
        .iter()
        .filter(|m| sv(m.get("role")) == "user")
        .count();
    let aggregates = Aggregates {
        tasks: if claude {
            tasks::parse_session_tasks(&read, rewound.as_ref())
        } else {
            Vec::new()
        },
        title: if claude {
            title::parse_session_title(&records)
        } else {
            None
        },
        artifacts: if claude {
            artifacts::parse_session_artifacts(&records)
        } else {
            Vec::new()
        },
        commands: if claude {
            commands::parse_session_commands(&records)
        } else {
            Vec::new()
        },
        stats: stats(
            turns,
            read.len() - rewound.as_ref().map_or(0, |r| r.len()),
            token_usage::summarize_token_usage(&records),
        ),
    };
    let projection = Projection {
        file: file.clone(),
        entries: history_entries_from_trajectory(&projection_file, &trajectory),
        all_entries: all_history_entries(&projection_file, &trajectory, false),
        messages,
        aggregates,
        partial: false,
    };
    Ok((projection, trajectory))
}

const TAIL_MARGIN: usize = 20;

struct TailProjection {
    trajectory: Value,
    all: Vec<Value>,
    entries: Vec<Value>,
    messages: Vec<Value>,
}

fn project_tail(file: &SessionFile, records: &[Obj], fallback: f64) -> TailProjection {
    let rewound = rewound_record_ids(records);
    let kept = kept_records(records.to_vec(), Some(&rewound));
    let projection_file = SessionFile {
        mtime_ms: fallback,
        ..file.clone()
    };
    let trajectory = project_agent_trajectory("claude", &projection_file, &kept);
    let all = all_history_entries(&projection_file, &trajectory, true);
    TailProjection {
        entries: history_window_entries(&all, HISTORY_WINDOW_LIMIT as f64),
        messages: conversation_messages_from_trajectory(&projection_file, &trajectory),
        trajectory,
        all,
    }
}

fn shown_entries(all: &[Value]) -> usize {
    all.iter().filter(|e| sv(e.get("role")) != "tool").count()
}

/// Whether a large transcript is read by its end.
pub fn reads_by_tail(agent: &str, file: &SessionFile, files: &dyn SessionFiles) -> bool {
    agent == "claude" && files.has_range() && file.size.unwrap_or(0.0) as u64 >= LARGE_SESSION_BYTES
}

async fn read_large_tail(
    file: &SessionFile,
    files: &dyn SessionFiles,
    fallback: f64,
) -> io::Result<tail::TailRead> {
    let file_for = file.clone();
    tail::read_tail_records(
        files,
        &file.path,
        file.size.unwrap_or(0.0) as u64,
        &move |records| {
            shown_entries(&project_tail(&file_for, records, fallback).all)
                >= HISTORY_WINDOW_LIMIT + TAIL_MARGIN
        },
        None,
        None,
    )
    .await
}

/// A large Claude transcript's entries shown (its window), from its end only.
pub async fn read_tail_projection(
    file: &SessionFile,
    files: &dyn SessionFiles,
) -> io::Result<Vec<Value>> {
    let fallback = file.created_at_ms.unwrap_or(file.mtime_ms);
    let tail = read_large_tail(file, files, fallback).await?;
    Ok(project_tail(file, &tail.records, fallback).entries)
}

/// What needs the whole session, from slim records.
fn indexed_aggregates(slim: &[Obj], parsed: usize) -> Aggregates {
    let rewound = rewound_record_ids(slim);
    // The index's own records when none was rewound (the usual case), not
    // a copy: a large session's records are hundreds of megabytes.
    let kept: std::borrow::Cow<[Obj]> = if rewound.is_empty() {
        std::borrow::Cow::Borrowed(slim)
    } else {
        std::borrow::Cow::Owned(kept_records(slim.to_vec(), Some(&rewound)))
    };
    let slim_file = SessionFile {
        path: String::new(),
        mtime_ms: 0.0,
        ..Default::default()
    };
    let turns = conversation_messages_from_trajectory(
        &slim_file,
        &project_agent_trajectory("claude", &slim_file, &kept),
    )
    .iter()
    .filter(|m| sv(m.get("role")) == "user")
    .count();
    Aggregates {
        tasks: tasks::parse_session_tasks(slim, Some(&rewound)),
        artifacts: artifacts::parse_session_artifacts(&kept),
        title: title::parse_session_title(&kept),
        commands: commands::parse_session_commands(&kept),
        stats: stats(
            turns,
            parsed - rewound.len(),
            token_usage::summarize_token_usage(&kept),
        ),
    }
}

const KNOWN_LIMIT: usize = 256;

/// A very large session's aggregates are worked out again only once this
/// many times as long as their last working out has passed since it ended.
const AGGREGATES_IDLE_FACTOR: u32 = 4;

/// Sessions smaller than this have their aggregates worked out again at
/// each change.
const AGGREGATES_THROTTLED_BYTES: u64 = 32 * 1024 * 1024;

/// Indexes built in the background, one at a time for the whole process.
static WARM_QUEUE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// What a large transcript's requests read and write, held briefly.
struct LargeState {
    identity: Option<String>,
    records: Vec<Obj>,
    start: u64,
    end: u64,
    first_span: u64,
    aggregates: Option<(u64, Aggregates)>,
    /// When the last aggregates were worked out, and how long that took.
    computed: Option<(std::time::Instant, std::time::Duration)>,
    saved: Option<(u64, Aggregates)>,
    warming: bool,
    persisted: Option<(f64, u64)>,
}

/// A large transcript as read so far: its end, and its index once asked
/// (held long while it reads: never while `state` is held).
struct Large {
    state: Mutex<LargeState>,
    index: Mutex<Option<SlimIndex>>,
}

#[derive(Clone)]
struct Cached {
    projection: Projection,
    signature: String,
    /// `history_epoch`'s: the same in every process reading this file.
    epoch: String,
    /// The transcript's size plus one: its prefix is the earlier revision.
    revision: i64,
    /// Set once this file was seen rewritten: its signature then.
    generation: Option<String>,
    versions: Vec<(i64, Vec<Value>)>,
    bytes: usize,
    fallback_time: f64,
    large: Option<Arc<Large>>,
}

fn signature(file: &SessionFile) -> String {
    js::stringify(&Value::Array(vec![
        Value::String(file.path.clone()),
        js::number(file.mtime_ms),
        file.size.map_or(Value::Null, js::number),
        file.identity.clone().map_or(Value::Null, Value::String),
        file.change_token.clone().map_or(Value::Null, Value::String),
        file.session_id.clone().map_or(Value::Null, Value::String),
        file.created_at_ms.map_or(Value::Null, js::number),
        file.model_name.clone().map_or(Value::Null, Value::String),
        file.agent_version
            .clone()
            .map_or(Value::Null, Value::String),
    ]))
}

/// The cursor of a transcript as it stands (`historyCursor`): a pure
/// function of the file, so every process answers a browser's cursor the
/// same. A format rewritten in place takes its signature into its epoch.
fn history_cursor(agent: &str, file: &SessionFile, generation: Option<&str>) -> (String, i64) {
    let whole = signature(file);
    let generation = if append_only_history(agent) {
        generation
    } else {
        Some(whole.as_str())
    };
    (
        history_epoch(agent, &file.path, file.identity.as_deref(), generation),
        file.size.unwrap_or(0.0) as i64 + 1,
    )
}

/// The versions kept under a cursor: those of the same epoch, and its own.
fn next_versions(
    old: Option<&Cached>,
    epoch: &str,
    revision: i64,
    entries: &[Value],
) -> Vec<(i64, Vec<Value>)> {
    let mut versions = match old {
        Some(old) if old.epoch == epoch => old.versions.clone(),
        _ => Vec::new(),
    };
    versions.retain(|(r, _)| *r != revision);
    versions.push((revision, entries.to_vec()));
    while versions.len() > 4 {
        versions.remove(0);
    }
    versions
}

/// A file access that sees a file's first `size` bytes only.
struct PrefixFiles<'f> {
    files: &'f dyn SessionFiles,
    size: u64,
}

impl SessionFiles for PrefixFiles<'_> {
    fn remote(&self) -> bool {
        self.files.remote()
    }
    fn stat_file<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        self.files.stat_file(path)
    }
    fn read_text<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<String>> {
        Box::pin(async move {
            if self.size == 0 {
                return Ok(String::new());
            }
            let mut bytes = self.files.read_prefix(path, self.size).await?;
            bytes.truncate(self.size as usize);
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        })
    }
    fn read_prefix<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        self.files.read_prefix(path, limit.min(self.size))
    }
    fn read_tail<'a>(&'a self, path: &'a str, limit: u64) -> BoxFut<'a, io::Result<Vec<u8>>> {
        self.files.read_tail(path, limit)
    }
    fn has_range(&self) -> bool {
        self.files.has_range()
    }
    fn read_range<'a>(
        &'a self,
        path: &'a str,
        start: u64,
        end: u64,
    ) -> BoxFut<'a, io::Result<Vec<u8>>> {
        let end = end.min(self.size);
        if end <= start {
            return Box::pin(async { Ok(Vec::new()) });
        }
        self.files.read_range(path, start, end)
    }
    fn read_download<'a>(&'a self, path: &'a str) -> BoxFut<'a, io::Result<Vec<u8>>> {
        self.files.read_download(path)
    }
    fn find_pi_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        self.files.find_pi_session_by_id(id)
    }
    fn find_pi_session_for_cwd<'a>(
        &'a self,
        cwd: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        self.files.find_pi_session_for_cwd(cwd)
    }
    fn find_claude_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        self.files.find_claude_session_by_id(id)
    }
    fn find_claude_successor<'a>(
        &'a self,
        path: &'a str,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<String>>> {
        self.files.find_claude_successor(path, id)
    }
    fn find_codex_session_by_id<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFut<'a, io::Result<Option<SessionFile>>> {
        self.files.find_codex_session_by_id(id)
    }
}

/// A conservative estimate of what a value retains (`estimateRetainedBytes`).
pub fn estimate_retained_bytes(value: &Value, budget: f64, depth: usize) -> f64 {
    if depth > 64 || budget < 0.0 {
        return f64::INFINITY;
    }
    match value {
        Value::String(s) => {
            let bytes = 32.0 + 2.0 * js::len16(s) as f64;
            if bytes > budget { f64::INFINITY } else { bytes }
        }
        Value::Array(items) => {
            let mut bytes = 64.0;
            if bytes > budget {
                return f64::INFINITY;
            }
            for item in items {
                bytes += 8.0 + estimate_retained_bytes(item, budget - bytes - 8.0, depth + 1);
                if bytes > budget {
                    return f64::INFINITY;
                }
            }
            bytes
        }
        Value::Object(map) => {
            let mut bytes = 64.0;
            if bytes > budget {
                return f64::INFINITY;
            }
            for (key, item) in map {
                bytes += 32.0 + 2.0 * js::len16(key) as f64;
                if bytes > budget {
                    return f64::INFINITY;
                }
                bytes += estimate_retained_bytes(item, budget - bytes, depth + 1);
                if bytes > budget {
                    return f64::INFINITY;
                }
            }
            bytes
        }
        _ => {
            if budget < 16.0 {
                f64::INFINITY
            } else {
                16.0
            }
        }
    }
}

type Known = Vec<(String, (Option<String>, u64, Aggregates))>;

struct Inner {
    cache: Vec<(String, Arc<Cached>)>,
    larges: Vec<(String, Arc<Large>)>,
    retained: usize,
}

/// One per connection.
pub struct ProjectionCache {
    files: Arc<dyn SessionFiles>,
    store: Option<Arc<SessionIndexStore>>,
    limit_entries: usize,
    limit_bytes: usize,
    large_limit: usize,
    persist_ms: f64,
    inner: Mutex<Inner>,
    /// The last aggregates of each large session, by path.
    known: std::sync::Mutex<Known>,
}

/// A page of older entries.
pub struct OlderPage {
    pub entries: Vec<Value>,
    pub has_more: bool,
}

fn remember(
    known: &std::sync::Mutex<Known>,
    path: &str,
    identity: Option<String>,
    end: u64,
    value: Aggregates,
) {
    let mut known = known.lock().unwrap();
    known.retain(|(k, _)| k != path);
    known.push((path.to_owned(), (identity, end, value)));
    while known.len() > KNOWN_LIMIT {
        known.remove(0);
    }
}

fn known_value(
    known: &std::sync::Mutex<Known>,
    path: &str,
    identity: &Option<String>,
    end: u64,
) -> Option<Aggregates> {
    let known = known.lock().unwrap();
    known
        .iter()
        .find(|(k, (i, e, _))| k == path && i == identity && *e == end)
        .map(|(_, (_, _, v))| v.clone())
}

impl ProjectionCache {
    pub fn new(files: Arc<dyn SessionFiles>, store: Option<Arc<SessionIndexStore>>) -> Arc<Self> {
        Self::with_limits(files, store, 16, 64 * 1024 * 1024)
    }

    /// With at most `entries` sessions and `bytes` retained.
    pub fn with_limits(
        files: Arc<dyn SessionFiles>,
        store: Option<Arc<SessionIndexStore>>,
        entries: usize,
        bytes: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            files,
            store,
            limit_entries: entries,
            limit_bytes: bytes,
            large_limit: 8,
            persist_ms: 30_000.0,
            inner: Mutex::new(Inner {
                cache: Vec::new(),
                larges: Vec::new(),
                retained: 0,
            }),
            known: std::sync::Mutex::new(Vec::new()),
        })
    }

    pub fn files(&self) -> &Arc<dyn SessionFiles> {
        &self.files
    }

    fn remove(inner: &mut Inner, key: &str) {
        if let Some(at) = inner.cache.iter().position(|(k, _)| k == key) {
            let (_, old) = inner.cache.remove(at);
            inner.retained -= old.bytes.min(inner.retained);
        }
    }

    pub async fn invalidate(&self, resolved: &Resolved) {
        let prefix = format!("{}:", resolved.key());
        let mut inner = self.inner.lock().await;
        let larges: Vec<String> = inner
            .larges
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .collect();
        for key in larges {
            inner.larges.retain(|(k, _)| *k != key);
            let path = key[prefix.len()..].to_owned();
            self.known.lock().unwrap().retain(|(k, _)| *k != path);
        }
        let keys: Vec<String> = inner
            .cache
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            Self::remove(&mut inner, &key);
        }
    }

    async fn load_large(
        &self,
        inner: &mut Inner,
        key: &str,
        agent: &str,
        current: &SessionFile,
    ) -> io::Result<Arc<Cached>> {
        let size = current.size.unwrap_or(0.0) as u64;
        let mut large = inner
            .larges
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, s)| s.clone());
        let old = inner
            .cache
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, c)| c.clone())
            .filter(|c| c.large.is_some());
        // Cut, or changed without growing: the same file rewritten.
        let mut cut = false;
        if let Some(existing) = &large {
            let s = existing.state.lock().await;
            let same = s.identity == current.identity;
            cut = same
                && (size < s.end
                    || (size == s.end
                        && old
                            .as_ref()
                            .is_some_and(|o| o.signature != signature(current))));
            let stale = !same || cut;
            drop(s);
            if stale {
                large = None;
                inner.larges.retain(|(k, _)| k != key);
            }
        }
        if large.is_some()
            && let Some(old) = &old
            && old.signature == signature(current)
        {
            return Ok(old.clone());
        }
        let reset = large.is_none();
        let old = if reset { None } else { old };
        let fallback = old
            .as_ref()
            .map_or(current.created_at_ms.unwrap_or(current.mtime_ms), |o| {
                o.fallback_time
            });
        let large = match large {
            Some(large) => {
                let mut s = large.state.lock().await;
                if size - s.end > MAX_APPEND_BYTES
                    || s.end - s.start > (4 * s.first_span).max(MAX_TAIL_BYTES)
                {
                    let tail = read_large_tail(current, self.files.as_ref(), fallback).await?;
                    s.records = tail.records;
                    s.start = tail.start;
                    s.end = tail.end;
                    s.first_span = (tail.end - tail.start).max(1);
                } else if size > s.end {
                    let appended = self.files.read_range(&current.path, s.end, size).await?;
                    let (records, used) = parse_whole_lines(&appended);
                    s.records.extend(records);
                    s.end += used as u64;
                }
                drop(s);
                large
            }
            None => {
                let tail = read_large_tail(current, self.files.as_ref(), fallback).await?;
                Arc::new(Large {
                    state: Mutex::new(LargeState {
                        identity: current.identity.clone(),
                        first_span: (tail.end - tail.start).max(1),
                        records: tail.records,
                        start: tail.start,
                        end: tail.end,
                        aggregates: None,
                        computed: None,
                        saved: None,
                        warming: false,
                        persisted: None,
                    }),
                    index: Mutex::new(None),
                })
            }
        };
        let records = large.state.lock().await.records.clone();
        let tail = project_tail(current, &records, fallback);
        let generation = if cut {
            Some(signature(current))
        } else {
            old.as_ref().and_then(|o| o.generation.clone())
        };
        let (epoch, revision) = history_cursor(agent, current, generation.as_deref());
        let versions = next_versions(old.as_deref(), &epoch, revision, &tail.entries);
        let value = Arc::new(Cached {
            projection: Projection {
                file: current.clone(),
                messages: tail.messages,
                entries: tail.entries,
                all_entries: tail.all,
                aggregates: Aggregates {
                    tasks: Vec::new(),
                    artifacts: Vec::new(),
                    title: None,
                    commands: Vec::new(),
                    stats: stats(0, 0, None),
                },
                partial: false,
            },
            signature: signature(current),
            epoch,
            revision,
            generation,
            versions,
            bytes: 0,
            fallback_time: fallback,
            large: Some(large.clone()),
        });
        Self::remove(inner, key);
        inner.cache.push((key.to_owned(), value.clone()));
        inner.larges.retain(|(k, _)| k != key);
        inner.larges.push((key.to_owned(), large));
        while inner.larges.len() > self.large_limit {
            inner.larges.remove(0);
        }
        Ok(value)
    }

    /// The session's cached projection, loaded or reused.
    async fn load(&self, resolved: &Resolved) -> io::Result<Arc<Cached>> {
        let file = resolved
            .file
            .as_ref()
            .ok_or_else(|| io::Error::other("Session file unavailable"))?;
        let key = format!("{}:{}", resolved.key(), file.path);
        let mut inner = self.inner.lock().await;
        let Some(before) = self.files.stat_file(&file.path).await? else {
            Self::remove(&mut inner, &key);
            return Err(io::Error::other(
                "Session file disappeared; refresh to resolve it again",
            ));
        };
        let mut current = merge_file(file, &before);
        if reads_by_tail(&resolved.agent, &current, self.files.as_ref()) {
            return self
                .load_large(&mut inner, &key, &resolved.agent, &current)
                .await;
        }
        inner.larges.retain(|(k, _)| *k != key);
        let old = inner
            .cache
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, c)| c.clone());
        if let Some(old) = &old
            && old.signature == signature(&current)
        {
            if let Some(at) = inner.cache.iter().position(|(k, _)| *k == key) {
                let entry = inner.cache.remove(at);
                inner.cache.push(entry);
            }
            return Ok(old.clone());
        }
        let is_reset = |current: &SessionFile| {
            old.as_ref().is_none_or(|o| {
                o.projection.file.identity != current.identity
                    || current.size.unwrap_or(0.0) < o.projection.file.size.unwrap_or(0.0)
            })
        };
        let mut projection = None;
        let mut fallback = current.created_at_ms.unwrap_or(current.mtime_ms);
        for _ in 0..3 {
            fallback = match &old {
                Some(o)
                    if !is_reset(&current)
                        && o.projection.file.created_at_ms == current.created_at_ms =>
                {
                    o.fallback_time
                }
                _ => current.created_at_ms.unwrap_or(current.mtime_ms),
            };
            let (read, _) = match read_session_projection(
                &resolved.agent,
                &current,
                self.files.as_ref(),
                Some(fallback),
            )
            .await
            {
                Ok(read) => read,
                Err(error) => {
                    Self::remove(&mut inner, &key);
                    return Err(error);
                }
            };
            let Some(after) = self.files.stat_file(&file.path).await? else {
                return Err(io::Error::other("Session file disappeared while reading"));
            };
            if signature(&merge_file(file, &after)) == signature(&current) {
                projection = Some(read);
                break;
            }
            current = merge_file(file, &after);
        }
        let Some(projection) = projection else {
            return Err(io::Error::other(
                "Session file changed while reading; retry on the next refresh",
            ));
        };
        // The same file cut, or changed without growing: rewritten.
        let same_file = old
            .as_ref()
            .is_some_and(|o| o.projection.file.identity == current.identity);
        let cut = same_file
            && current.size.unwrap_or(0.0)
                <= old.as_ref().unwrap().projection.file.size.unwrap_or(0.0);
        let generation = if !same_file {
            None
        } else if cut {
            Some(signature(&current))
        } else {
            old.as_ref().and_then(|o| o.generation.clone())
        };
        let (epoch, revision) = history_cursor(&resolved.agent, &current, generation.as_deref());
        let versions = next_versions(old.as_deref(), &epoch, revision, &projection.entries);
        let mut estimate_input: Vec<Value> = vec![projection_value(&projection)];
        estimate_input.extend(versions.iter().map(|(_, v)| Value::Array(v.clone())));
        let bytes =
            estimate_retained_bytes(&Value::Array(estimate_input), self.limit_bytes as f64, 0);
        let value = Arc::new(Cached {
            projection,
            signature: signature(&current),
            epoch,
            revision,
            generation,
            versions,
            bytes: if bytes.is_finite() {
                bytes as usize
            } else {
                usize::MAX
            },
            fallback_time: fallback,
            large: None,
        });
        Self::remove(&mut inner, &key);
        if value.bytes <= self.limit_bytes && self.limit_entries > 0 {
            inner.cache.push((key, value.clone()));
            inner.retained += value.bytes;
            while inner.cache.len() > self.limit_entries || inner.retained > self.limit_bytes {
                let first = inner.cache[0].0.clone();
                Self::remove(&mut inner, &first);
            }
        }
        Ok(value)
    }

    /// Entries and messages shown, without what needs the whole session.
    pub async fn recent(&self, resolved: &Resolved) -> io::Result<Projection> {
        Ok(self.load(resolved).await?.projection.clone())
    }

    /// The transcript's file and its last `max` messages: the rest of the
    /// projection is not copied.
    pub async fn recent_messages(
        &self,
        resolved: &Resolved,
        max: usize,
    ) -> io::Result<(SessionFile, Vec<Value>)> {
        let cached = self.load(resolved).await?;
        let messages = &cached.projection.messages;
        Ok((
            cached.projection.file.clone(),
            messages[messages.len().saturating_sub(max)..].to_vec(),
        ))
    }

    /// Every entry known (for an entry looked up by id).
    pub async fn entries(&self, resolved: &Resolved) -> io::Result<Vec<Value>> {
        let cached = self.load(resolved).await?;
        if let Some(large) = &cached.large {
            let s = large.state.lock().await;
            return Ok(project_tail(&cached.projection.file, &s.records, cached.fallback_time).all);
        }
        Ok(cached.projection.all_entries.clone())
    }

    /// The entries a transcript's first `size` bytes showed.
    async fn entries_at(&self, agent: &str, cached: &Cached, size: u64) -> io::Result<Vec<Value>> {
        let mut file = cached.projection.file.clone();
        file.size = Some(size as f64);
        let limited = PrefixFiles {
            files: self.files.as_ref(),
            size,
        };
        if reads_by_tail(agent, &file, &limited) {
            let tail = read_large_tail(&file, &limited, cached.fallback_time).await?;
            return Ok(project_tail(&file, &tail.records, cached.fallback_time).entries);
        }
        let (projection, _) =
            read_session_projection(agent, &file, &limited, Some(cached.fallback_time)).await?;
        Ok(projection.entries)
    }

    /// The history as it stands, as a delta from the browser's `cursor`
    /// when that cursor is this file's: its revision, if not kept, is
    /// projected again from the transcript's prefix, so any process
    /// answers it the same.
    pub async fn history(
        &self,
        resolved: &Resolved,
        cursor: Option<&Value>,
    ) -> io::Result<(Projection, Value)> {
        let mut cached = self.load(resolved).await?;
        let agent = resolved.agent.as_str();
        let append = append_only_history(agent);
        let base = cursor.and_then(Value::as_object);
        let requested = |cached: &Cached| {
            base.filter(|b| b.get("epoch").and_then(Value::as_str) == Some(cached.epoch.as_str()))
                .and_then(|b| b.get("revision"))
                .and_then(Value::as_f64)
                .filter(|r| js::is_safe_integer(*r))
                .map(|r| r as i64)
        };
        if append && requested(&cached).is_some_and(|r| r > cached.revision) {
            // Its cursor is past the file's end: rewritten, unseen here.
            let mut next = (*cached).clone();
            next.generation = Some(signature(&next.projection.file));
            let (epoch, revision) =
                history_cursor(agent, &next.projection.file, next.generation.as_deref());
            next.versions = next_versions(None, &epoch, revision, &next.projection.entries);
            next.epoch = epoch;
            let next = Arc::new(next);
            let mut inner = self.inner.lock().await;
            for (_, entry) in inner.cache.iter_mut() {
                if Arc::ptr_eq(entry, &cached) {
                    *entry = next.clone();
                }
            }
            drop(inner);
            cached = next;
        }
        let mut versions: HashMap<i64, Vec<Value>> = cached.versions.iter().cloned().collect();
        if append
            && let Some(r) = requested(&cached)
            && r >= 1
            && r < cached.revision
            && !versions.contains_key(&r)
        {
            let entries = self.entries_at(agent, &cached, (r - 1) as u64).await?;
            versions.insert(r, entries);
        }
        let update = history_update(
            &serde_json::json!({ "epoch": cached.epoch, "revision": cached.revision }),
            &cached.projection.entries,
            cursor,
            &versions,
        );
        Ok((cached.projection.clone(), update))
    }

    /// The projection with what needs the whole session (partial while a
    /// large session's index is not ready, unless `wait`).
    pub async fn get(self: &Arc<Self>, resolved: &Resolved, wait: bool) -> io::Result<Projection> {
        let cached = self.load(resolved).await?;
        let mut projection = cached.projection.clone();
        let Some(large) = cached.large.clone() else {
            return Ok(projection);
        };
        let (aggregates, partial) = self
            .large_aggregates(large, &projection.file.path, wait)
            .await?;
        projection.aggregates = aggregates;
        projection.partial = partial;
        Ok(projection)
    }

    /// What needs the whole session, answered from what is known when the
    /// session is large and unchanged since.
    pub async fn aggregates(
        self: &Arc<Self>,
        resolved: &Resolved,
    ) -> io::Result<(SessionFile, Aggregates, bool)> {
        let file = resolved
            .file
            .as_ref()
            .ok_or_else(|| io::Error::other("Session file unavailable"))?;
        let stat = self.files.stat_file(&file.path).await?;
        if let Some(stat) = &stat {
            let current = merge_file(file, stat);
            if reads_by_tail(&resolved.agent, &current, self.files.as_ref()) {
                let size = current.size.unwrap_or(0.0) as u64;
                if let Some(value) =
                    known_value(&self.known, &current.path, &current.identity, size)
                {
                    return Ok((current, value, false));
                }
                if let Some(store) = &self.store
                    && let Some((end, value)) =
                        store.peek(&current.path, current.identity.as_deref(), size)
                    && end == size
                {
                    let value = Aggregates::from_value(&value);
                    remember(
                        &self.known,
                        &current.path,
                        current.identity.clone(),
                        size,
                        value.clone(),
                    );
                    return Ok((current, value, false));
                }
            }
        }
        let projection = self.get(resolved, false).await?;
        Ok((projection.file, projection.aggregates, projection.partial))
    }

    /// The index brought up to the session's end and its aggregates (the
    /// index lock held by the caller).
    async fn index_aggregates(
        &self,
        large: &Large,
        index: &mut Option<SlimIndex>,
        path: &str,
    ) -> io::Result<Aggregates> {
        let (identity, end) = {
            let s = large.state.lock().await;
            (s.identity.clone(), s.end)
        };
        if index.is_none() {
            let mut fresh = SlimIndex::new(path);
            if let Some(store) = &self.store
                && let Some(saved) = store
                    .load(self.files.as_ref(), path, identity.as_deref(), end)
                    .await
            {
                fresh.restore(saved.records, saved.parsed, saved.end);
                let mut s = large.state.lock().await;
                if let Some((end, value)) = saved.aggregates {
                    s.saved = Some((end, Aggregates::from_value(&value)));
                }
                s.persisted = Some((js::now_ms(), saved.end));
            }
            *index = Some(fresh);
        }
        let built = index.as_mut().unwrap();
        built.update(self.files.as_ref(), end).await?;
        let index_end = built.end;
        let cached = {
            let s = large.state.lock().await;
            s.aggregates
                .as_ref()
                .filter(|(e, _)| *e == index_end)
                .map(|(_, v)| v.clone())
        };
        if let Some(value) = cached {
            return Ok(value);
        }
        let started = std::time::Instant::now();
        let value = indexed_aggregates(&built.records, built.parsed);
        let took = started.elapsed();
        remember(
            &self.known,
            path,
            identity.clone(),
            index_end,
            value.clone(),
        );
        let persist = {
            let mut s = large.state.lock().await;
            s.aggregates = Some((index_end, value.clone()));
            s.computed = Some((std::time::Instant::now(), took));
            let now = js::now_ms();
            let due = self.store.is_some()
                && s.persisted
                    .is_none_or(|(at, end)| end != index_end && now - at >= self.persist_ms);
            if due {
                s.persisted = Some((now, index_end));
            }
            due
        };
        if persist && let Some(store) = &self.store {
            let saved = store
                .save(
                    self.files.as_ref(),
                    path,
                    identity.as_deref(),
                    index_end,
                    built.parsed,
                    &built.records,
                    Some((index_end, value.to_value())),
                )
                .await;
            if saved.is_err() {
                large.state.lock().await.persisted = None;
            }
        }
        Ok(value)
    }

    async fn warm(self: Arc<Self>, large: Arc<Large>, path: String) {
        let _queue = WARM_QUEUE.lock().await;
        let mut index = large.index.lock().await;
        let _ = self.index_aggregates(&large, &mut index, &path).await;
        drop(index);
        large.state.lock().await.warming = false;
    }

    async fn large_aggregates(
        self: &Arc<Self>,
        large: Arc<Large>,
        path: &str,
        wait: bool,
    ) -> io::Result<(Aggregates, bool)> {
        if wait {
            let mut index = large.index.lock().await;
            let value = self.index_aggregates(&large, &mut index, path).await?;
            return Ok((value, false));
        }
        let (warming, end, identity) = {
            let s = large.state.lock().await;
            // Slow to work out over a very large session (a second for
            // 200 MB), they are worked out again at most a fifth of the
            // time while it grows: its agent appends to it all the time.
            if let (Some((_, value)), Some((at, took))) = (&s.aggregates, s.computed)
                && s.end >= AGGREGATES_THROTTLED_BYTES
                && at.elapsed() < took * AGGREGATES_IDLE_FACTOR
            {
                return Ok((value.clone(), false));
            }
            (s.warming, s.end, s.identity.clone())
        };
        if !warming
            && let Ok(mut index) = large.index.try_lock()
            && index
                .as_ref()
                .is_some_and(|i| end - i.end <= MAX_APPEND_BYTES)
        {
            let value = self.index_aggregates(&large, &mut index, path).await?;
            return Ok((value, false));
        }
        if let Some(value) = known_value(&self.known, path, &identity, end) {
            return Ok((value, false));
        }
        let index_missing = large.index.try_lock().map(|i| i.is_none()).unwrap_or(false);
        let mut s = large.state.lock().await;
        if s.saved.is_none()
            && s.aggregates.is_none()
            && let Some(store) = &self.store
            && let Some((end, value)) = store.peek(path, s.identity.as_deref(), s.end)
        {
            s.saved = Some((end, Aggregates::from_value(&value)));
        }
        if let Some((saved_end, value)) = &s.saved
            && *saved_end == s.end
            && index_missing
        {
            let value = value.clone();
            remember(&self.known, path, s.identity.clone(), s.end, value.clone());
            return Ok((value, false));
        }
        if !s.warming {
            s.warming = true;
            tokio::spawn(self.clone().warm(large.clone(), path.to_owned()));
        }
        if let Some((_, value)) = &s.aggregates {
            return Ok((value.clone(), true));
        }
        if let Some((_, value)) = &s.saved {
            return Ok((value.clone(), true));
        }
        let slim: Vec<Obj> = s.records.iter().filter_map(tail::slim_record).collect();
        Ok((indexed_aggregates(&slim, s.records.len()), true))
    }

    /// The session's records for a whole-session scan.
    pub async fn records(self: &Arc<Self>, resolved: &Resolved) -> io::Result<Vec<Obj>> {
        let cached = self.load(resolved).await?;
        let Some(large) = cached.large.clone() else {
            return read_jsonl_records(&cached.projection.file, self.files.as_ref()).await;
        };
        let mut index = large.index.lock().await;
        self.index_aggregates(&large, &mut index, &cached.projection.file.path)
            .await?;
        Ok(index
            .as_ref()
            .map(|i| i.records.clone())
            .unwrap_or_default())
    }

    /// A page of entries before `before_id`.
    pub async fn older(
        &self,
        resolved: &Resolved,
        before_id: &str,
        limit: f64,
    ) -> io::Result<OlderPage> {
        let cached = self.load(resolved).await?;
        let asked = if limit.is_finite() {
            limit.floor()
        } else {
            0.0
        };
        let page = if asked == 0.0 {
            50
        } else {
            (asked as i64).clamp(1, 200) as usize
        };
        let before = |all: &[Value]| {
            all.iter()
                .position(|e| sv(e.get("id")) == before_id)
                .map(|at| all[..at].to_vec())
        };
        let mut earlier;
        let mut more_before = false;
        if let Some(large) = &cached.large {
            let mut s = large.state.lock().await;
            let mut all =
                project_tail(&cached.projection.file, &s.records, cached.fallback_time).all;
            earlier = before(&all);
            let mut chunk: u64 = 1024 * 1024;
            while s.start > 0
                && earlier
                    .as_ref()
                    .is_none_or(|e| shown_entries(e) < page + TAIL_MARGIN)
            {
                let from = s.start.saturating_sub(chunk);
                let bytes = self
                    .files
                    .read_range(&cached.projection.file.path, from, s.start)
                    .await?;
                let skip = if from > 0 {
                    bytes.iter().position(|&b| b == b'\n').map_or(0, |n| n + 1)
                } else {
                    0
                };
                if from > 0 && skip == 0 {
                    chunk *= 2;
                    continue;
                }
                let (records, _) = parse_whole_lines(&bytes[skip..]);
                let mut joined = records;
                joined.extend(std::mem::take(&mut s.records));
                s.records = joined;
                s.start = from + skip as u64;
                chunk = (chunk * 2).min(MAX_APPEND_BYTES);
                all = project_tail(&cached.projection.file, &s.records, cached.fallback_time).all;
                earlier = before(&all);
            }
            more_before = s.start > 0;
        } else {
            earlier = before(&cached.projection.all_entries);
        }
        let Some(earlier) = earlier else {
            return Err(io::Error::other("That entry is no longer in the history"));
        };
        let shown = history_window_entries(&earlier, page as f64);
        Ok(OlderPage {
            has_more: shown.len() < earlier.len() || more_before,
            entries: shown,
        })
    }

    /// The session's trajectory, built again (a large one's end unless
    /// `whole`).
    pub async fn trajectory(&self, resolved: &Resolved, whole: bool) -> io::Result<Value> {
        let cached = self.load(resolved).await?;
        if let Some(large) = &cached.large
            && !whole
        {
            let s = large.state.lock().await;
            return Ok(
                project_tail(&cached.projection.file, &s.records, cached.fallback_time).trajectory,
            );
        }
        Ok(read_session_projection(
            &resolved.agent,
            &cached.projection.file,
            self.files.as_ref(),
            Some(cached.fallback_time),
        )
        .await?
        .1)
    }
}

fn merge_file(file: &SessionFile, stat: &SessionFile) -> SessionFile {
    SessionFile {
        path: stat.path.clone(),
        mtime_ms: stat.mtime_ms,
        size: stat.size.or(file.size),
        identity: stat.identity.clone().or_else(|| file.identity.clone()),
        change_token: stat
            .change_token
            .clone()
            .or_else(|| file.change_token.clone()),
        session_id: stat.session_id.clone().or_else(|| file.session_id.clone()),
        created_at_ms: stat.created_at_ms.or(file.created_at_ms),
        model_name: stat.model_name.clone().or_else(|| file.model_name.clone()),
        agent_version: stat
            .agent_version
            .clone()
            .or_else(|| file.agent_version.clone()),
    }
}

fn projection_value(projection: &Projection) -> Value {
    Value::Object(obj! {
        "file" => projection.file.to_value(),
        "messages" => projection.messages.clone(),
        "entries" => projection.entries.clone(),
        "allEntries" => projection.all_entries.clone(),
        "tasks" => projection.aggregates.tasks.clone(),
        "title" => projection.aggregates.title.clone().map_or(Value::Null, Value::String),
        "artifacts" => projection.aggregates.artifacts.clone(),
        "commands" => projection.aggregates.commands.clone(),
        "stats" => projection.aggregates.stats.clone(),
    })
}

#[cfg(test)]
mod history_cursor_tests;
#[cfg(test)]
mod tests;
