//! The review service (review/service.ts): reviews and their threads in
//! memory, written through to reviews.sqlite, published to browsers,
//! delivered to agents and watched by them.
//!
//! One state behind one lock, never held across an await: what the TS
//! closure did between two awaits is done under the lock, and what it
//! checked by object identity after an await (`live(target)`, a thread
//! "edited, moved or deleted meanwhile") is checked by each record's
//! `inst`, given when the object is made. Its effects (git reads, agent
//! panes, the forge) go through [`ReviewHost`].

mod delivery;
mod forge;
pub mod host;
mod loads;
mod reanchor;
mod threads;
mod watch;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use futures_util::future::Shared;
use indexmap::{IndexMap, IndexSet};
use roamgate_base::clock::SharedClock;
use serde_json::{Map, Value, json};

pub use host::{BoxFut, LoadError, ReviewForge, ReviewHost};

use crate::error::{ReviewError, ReviewResult};
use crate::model::{
    REVIEW_USER, ReviewCommit, ReviewMergeRequest, ReviewSession, ReviewSnapshot, ReviewSummary,
    ReviewTarget, ReviewThread, limits, summarize_review,
};
use crate::parse::{
    self, describe_target, is_gitlab_target, merge_request_security, optional_text,
    parse_agent_name, parse_merge_request_url, parse_review_target, same_merge_request,
    same_target, text,
};
use crate::prompts::{AgentPrompts, Publish};
use crate::storage::ReviewStorage;

pub(crate) type SharedTask = Shared<BoxFut<()>>;
/// A listing of a review's commits, shared by those who ask meanwhile.
pub(crate) type CommitListing = Shared<BoxFut<Result<Vec<ReviewCommit>, LoadError>>>;

/// How long a branch's merge request, or its absence, is remembered.
pub(crate) const FIND_TTL_MS: i64 = 5 * 60_000;
pub(crate) const GITLAB_THREADS_MS: i64 = 5 * 60_000;
pub(crate) const FIND_RETRY_MS: i64 = 60_000;
pub(crate) const GONE_RETRY_MS: i64 = 5 * 60_000;
pub(crate) const FOREVER: i64 = i64::MAX;

/// How the service is made (the TS arguments that are not effects).
pub struct ReviewServiceOptions {
    pub storage: ReviewStorage,
    pub publish: Publish,
    pub host: Arc<dyn ReviewHost>,
    pub clock: SharedClock,
    /// The most reviews kept at once (limits::SESSIONS).
    pub session_limit: Option<usize>,
    pub retry_delay_ms: Option<u64>,
    pub delivery_delay_ms: Option<u64>,
    pub agent_search_ms: Option<u64>,
}

/// A merge request's review: the merge request and its threads.
#[derive(Debug, Clone, Default)]
pub(crate) struct GitlabState {
    pub mr: Option<Value>,
    pub threads: Vec<ReviewThread>,
    pub threads_at: Option<i64>,
    pub error: Option<String>,
    pub linked: Option<Vec<String>>,
}

/// What a lookup of a branch's merge request answered.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FoundMergeRequest {
    Link(Option<Value>),
    Error(String),
}

pub(crate) struct Found {
    pub key: String,
    pub at: i64,
    pub until: i64,
    pub result: Shared<BoxFut<FoundMergeRequest>>,
    pub id: u64,
}

pub(crate) struct Gone {
    pub key: String,
    pub until: i64,
    pub error: LoadError,
}

#[derive(Default)]
pub(crate) struct Explained {
    pub session: Option<String>,
    pub at: String,
    pub kinds: HashSet<&'static str>,
    pub id: u64,
}

#[derive(Default)]
pub(crate) struct State {
    pub sessions: IndexMap<String, ReviewSession>,
    /// The reviews by checkout (connection and root), in the order
    /// sessions.ts keeps them.
    pub checkouts: HashMap<String, IndexSet<String>>,
    pub threads: HashMap<String, IndexMap<String, ReviewThread>>,
    pub gitlab: IndexMap<String, GitlabState>,
    pub found: HashMap<String, Found>,
    pub gone: HashMap<String, Gone>,
    pub loads: HashMap<String, u64>,
    pub versions: HashMap<String, u64>,
    pub handoffs: HashMap<String, u64>,
    pub watchers: HashMap<String, Vec<(u64, Arc<tokio::sync::Notify>)>>,
    pub deliveries: HashMap<String, u64>,
    pub typing: HashMap<String, usize>,
    pub retries: HashMap<String, u32>,
    pub heard: HashMap<String, String>,
    pub taken: HashMap<String, String>,
    pub reminded: HashMap<String, String>,
    pub explained_to: HashMap<String, Explained>,
    pub searching: IndexSet<String>,
    pub search_timer: bool,
    pub search_running: bool,
    pub migrating: HashMap<String, SharedTask>,
    pub migrate_again: HashSet<String>,
    pub migration_retry_at: HashMap<String, i64>,
    pub migration_tried: HashSet<String>,
    pub reanchoring_file: HashMap<String, SharedTask>,
    pub reanchor_file_again: HashSet<String>,
    pub file_read_at: HashMap<String, i64>,
    pub rewrite_tried: HashMap<String, String>,
    pub rewrite_read_at: HashMap<String, i64>,
    pub rewriting: HashMap<String, SharedTask>,
    pub listing: HashMap<String, (u64, CommitListing)>,
    pub queues: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    pub next: u64,
}

impl State {
    /// A new identity for a record, or for a timer or watcher.
    pub fn next(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    fn checkout_key(session: &ReviewSession) -> String {
        format!("{}\0{}", session.connection_id, session.root)
    }

    /// Adds or replaces a review (ReviewSessions.set).
    pub fn set_session(&mut self, mut session: ReviewSession) {
        if session.inst == 0 {
            session.inst = self.next();
        }
        let id = session.id.clone();
        if let Some(before) = self.sessions.get(&id) {
            let key = Self::checkout_key(before);
            if let Some(set) = self.checkouts.get_mut(&key) {
                set.shift_remove(&id);
            }
        }
        self.checkouts
            .entry(Self::checkout_key(&session))
            .or_default()
            .insert(id.clone());
        self.sessions.insert(id, session);
    }

    pub fn delete_session(&mut self, id: &str) -> Option<ReviewSession> {
        let before = self.sessions.shift_remove(id)?;
        let key = Self::checkout_key(&before);
        if let Some(set) = self.checkouts.get_mut(&key) {
            set.shift_remove(id);
            if set.is_empty() {
                self.checkouts.remove(&key);
            }
        }
        Some(before)
    }

    /// The reviews of a review's checkout, itself included.
    pub fn of_checkout(&self, target: &ReviewSession) -> Vec<String> {
        self.checkouts
            .get(&Self::checkout_key(target))
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn threads_of(&mut self, id: &str) -> &mut IndexMap<String, ReviewThread> {
        self.threads.entry(id.to_owned()).or_default()
    }

    pub fn thread_list(&self, id: &str) -> Vec<ReviewThread> {
        self.threads
            .get(id)
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// The review is still the one an async step started for.
    pub fn live(&self, id: &str, inst: u64) -> bool {
        self.sessions.get(id).is_some_and(|s| s.inst == inst)
    }

    pub fn gitlab_mode(&self, target: &ReviewSession, has_forge: bool) -> bool {
        is_gitlab_target(&target.target) && has_forge
    }

    /// The local reviews of the same checkout as a merge request's review.
    pub fn local_reviews_of(&self, target: &ReviewSession) -> Vec<String> {
        if !is_gitlab_target(&target.target) {
            return Vec::new();
        }
        self.of_checkout(target)
            .into_iter()
            .filter(|id| {
                self.sessions
                    .get(id)
                    .is_some_and(|other| !is_gitlab_target(&other.target))
            })
            .collect()
    }

    /// The review comments of the local reviews pending for a merge
    /// request's review (pendingDrafts).
    pub fn pending_drafts(&self, target: &ReviewSession) -> Vec<ReviewThread> {
        let ReviewTarget::Mr { url } = &target.target else {
            return Vec::new();
        };
        let Some(reviewed) = parse_merge_request_url(url) else {
            return Vec::new();
        };
        let linked: HashSet<String> = self
            .gitlab
            .get(&target.id)
            .and_then(|state| state.linked.clone())
            .unwrap_or_default()
            .into_iter()
            .collect();
        let mut out = Vec::new();
        for other in self.local_reviews_of(target) {
            for thread in self
                .threads
                .get(&other)
                .into_iter()
                .flat_map(|m| m.values())
            {
                if thread.kind != "draft" {
                    continue;
                }
                let pending = match &thread.pending_for {
                    None => linked.contains(&other),
                    Some(url) => parse_merge_request_url(url)
                        .is_some_and(|parsed| same_merge_request(&parsed, &reviewed)),
                };
                if pending {
                    out.push(thread.clone());
                }
            }
        }
        out
    }

    /// The reviews whose threads a review shows with its own (linkedOf).
    pub fn linked_of(&self, target: &ReviewSession) -> Vec<String> {
        let code = code_review(target);
        if !code && rendered_file(target).is_none() {
            return Vec::new();
        }
        let own = checkout_code(target);
        self.of_checkout(target)
            .into_iter()
            .filter(|id| {
                let Some(other) = self.sessions.get(id) else {
                    return false;
                };
                other.id != target.id
                    && if code {
                        rendered_file(other).is_some() || (own && checkout_code(other))
                    } else {
                        code_review(other)
                    }
            })
            .collect()
    }

    /// The threads of the linked reviews on what this one shows.
    pub fn shared_threads(&self, target: &ReviewSession, has_forge: bool) -> Vec<ReviewThread> {
        let linked = self.linked_of(target);
        if linked.is_empty() {
            return Vec::new();
        }
        let path = rendered_file(target);
        let mut seen: HashSet<String> = self
            .pending_drafts(target)
            .into_iter()
            .map(|thread| thread.id)
            .collect();
        let mut shared = Vec::new();
        for id in linked {
            let Some(other) = self.sessions.get(&id) else {
                continue;
            };
            let local = self.thread_list(&id);
            let remote = if path.is_some() && self.gitlab_mode(other, has_forge) {
                self.gitlab
                    .get(&id)
                    .map(|state| state.threads.clone())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            for thread in local.into_iter().chain(remote) {
                if seen.contains(&thread.id) {
                    continue;
                }
                if thread.anchor.path.is_none() && !(path.is_none() && checkout_code(other)) {
                    continue;
                }
                if path.is_some() && thread.anchor.path.as_deref() != path.as_deref() {
                    continue;
                }
                seen.insert(thread.id.clone());
                shared.push(thread);
            }
        }
        shared
    }

    /// The shared threads that live in a linked review's own store.
    pub fn shared_local(&self, target: &ReviewSession, has_forge: bool) -> Vec<ReviewThread> {
        self.shared_threads(target, has_forge)
            .into_iter()
            .filter(|thread| {
                self.threads
                    .get(&thread.session_id)
                    .and_then(|map| map.get(&thread.id))
                    .is_some_and(|own| own.inst == thread.inst)
            })
            .collect()
    }

    pub fn snapshot(
        &self,
        target: &ReviewSession,
        with_shared: bool,
        has_forge: bool,
    ) -> ReviewSnapshot {
        let local = self.thread_list(&target.id);
        let remote = if self.gitlab_mode(target, has_forge) {
            self.gitlab.get(&target.id)
        } else {
            None
        };
        let shared = if with_shared {
            self.shared_threads(target, has_forge)
        } else {
            Vec::new()
        };
        let threads = match remote {
            Some(remote) => {
                let mut all = local;
                all.extend(self.pending_drafts(target));
                all.extend(remote.threads.iter().cloned());
                all
            }
            None => local,
        };
        let merge_request = remote.and_then(|remote| remote.mr.as_ref()).map(|mr| {
            let field = |name: &str| {
                mr.get(name)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            ReviewMergeRequest {
                url: field("url"),
                title: field("title"),
                state: field("state"),
                head_sha: field("headSha"),
                security: match &target.target {
                    ReviewTarget::Mr { url } => merge_request_security(url, Some(mr)) == "security",
                    _ => false,
                },
            }
        });
        ReviewSnapshot {
            session: target.clone(),
            threads,
            shared: (!shared.is_empty()).then_some(shared),
            merge_request,
            gitlab_error: remote.and_then(|remote| remote.error.clone()),
        }
    }

    /// Finds a review by id or an unambiguous prefix.
    pub fn session(&self, id: Option<&Value>) -> ReviewResult<ReviewSession> {
        let id = match id {
            Some(Value::String(id)) if !id.is_empty() => id,
            _ => return Err(ReviewError::new("session is required")),
        };
        if let Some(found) = self.sessions.get(id) {
            return Ok(found.clone());
        }
        let matches: Vec<_> = self
            .sessions
            .keys()
            .filter(|key| key.starts_with(id.as_str()))
            .collect();
        match matches.as_slice() {
            [one] => Ok(self.sessions[*one].clone()),
            _ => Err(ReviewError::not_found("no such review")),
        }
    }
}

/// A review of the checkout's code: a branch, a range, its work, an MR.
pub(crate) fn code_review(target: &ReviewSession) -> bool {
    matches!(
        target.target,
        ReviewTarget::Range { .. }
            | ReviewTarget::Worktree
            | ReviewTarget::Step { .. }
            | ReviewTarget::Mr { .. }
    )
}

/// The file a review of a rendered file shows (none for a site).
pub(crate) fn rendered_file(target: &ReviewSession) -> Option<String> {
    match &target.target {
        ReviewTarget::Rendered { path, url: None } => path.clone(),
        _ => None,
    }
}

/// The checkout's own code: its working tree, or a range of its commits.
pub(crate) fn checkout_code(target: &ReviewSession) -> bool {
    matches!(
        target.target,
        ReviewTarget::Worktree | ReviewTarget::Range { compare: false, .. }
    )
}

/// A thread found by its comment.
#[derive(Debug, Clone)]
pub(crate) struct Located {
    pub thread_id: String,
    pub session_id: String,
    pub comment_id: String,
    pub index: usize,
}

/// Finds a comment by id or unambiguous prefix, among the given threads
/// (locateIn).
pub(crate) fn locate_in<'a>(
    candidates: impl IntoIterator<Item = &'a ReviewThread>,
    comment_id: Option<&Value>,
) -> ReviewResult<Located> {
    let id = match comment_id {
        Some(Value::String(id)) if !id.is_empty() => id.as_str(),
        _ => return Err(ReviewError::new("comment id is required")),
    };
    let mut found: Vec<Located> = Vec::new();
    for thread in candidates {
        for (index, comment) in thread.comments.iter().enumerate() {
            let entry = Located {
                thread_id: thread.id.clone(),
                session_id: thread.session_id.clone(),
                comment_id: comment.id.clone(),
                index,
            };
            if comment.id == id {
                found.insert(0, entry);
            } else if comment.id.starts_with(id) {
                found.push(entry);
            }
        }
        if (thread.id == id || thread.id.starts_with(id))
            && let Some(root) = thread.comments.first()
        {
            found.push(Located {
                thread_id: thread.id.clone(),
                session_id: thread.session_id.clone(),
                comment_id: root.id.clone(),
                index: 0,
            });
        }
    }
    if let Some(exact) = found.iter().find(|entry| entry.comment_id == id) {
        return Ok(exact.clone());
    }
    let mut unique: IndexMap<String, Located> = IndexMap::new();
    for entry in found {
        unique.insert(entry.comment_id.clone(), entry);
    }
    match unique.len() {
        1 => Ok(unique.into_values().next().unwrap()),
        0 => Err(ReviewError::not_found("no such comment")),
        _ => Err(ReviewError::new("ambiguous comment id")),
    }
}

pub(crate) struct Inner {
    pub state: Mutex<State>,
    pub storage: Mutex<ReviewStorage>,
    pub publish: Publish,
    pub host: Arc<dyn ReviewHost>,
    pub clock: SharedClock,
    pub prompts: AgentPrompts,
    pub session_limit: usize,
    pub delivery_delay_ms: u64,
    pub retry_delay_ms: u64,
    pub agent_search_ms: u64,
}

/// The review service.
#[derive(Clone)]
pub struct ReviewService(pub(crate) Arc<Inner>);

impl Inner {
    pub fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn now(&self) -> String {
        crate::js::iso(self.clock.now())
    }

    pub fn ms(&self) -> i64 {
        self.clock.now()
    }

    pub fn has_forge(&self) -> bool {
        self.host.forge().is_some()
    }

    pub fn save_session(&self, session: &ReviewSession) {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        let _ = storage.save_session(session);
    }

    pub fn save_thread(&self, thread: &ReviewThread) -> ReviewResult<()> {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        storage
            .save_thread(thread)
            .map_err(|error| ReviewError::status(error.to_string(), 500))
    }

    pub fn delete_thread_row(&self, id: &str) {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        let _ = storage.delete_thread(id);
    }

    pub fn delete_session_row(&self, id: &str) {
        let storage = self.storage.lock().unwrap_or_else(|p| p.into_inner());
        let _ = storage.delete_session(id);
    }

    pub fn push(&self, value: Value) {
        (self.publish)(value);
    }

    pub fn snapshot_of(&self, state: &State, target: &ReviewSession) -> ReviewSnapshot {
        state.snapshot(target, true, self.has_forge())
    }

    pub fn snapshot_value(&self, state: &State, target: &ReviewSession) -> Value {
        serde_json::to_value(self.snapshot_of(state, target)).unwrap_or(Value::Null)
    }

    pub fn publish_session(&self, state: &State, target: &ReviewSession) {
        self.push(json!({"type": "session", "snapshot": self.snapshot_value(state, target)}));
        self.publish_shared(state, target);
    }

    /// The reviews showing this one's threads (or that it showed, once gone).
    pub fn publish_shared(&self, state: &State, target: &ReviewSession) {
        for id in state.linked_of(target) {
            if let Some(other) = state.sessions.get(&id) {
                self.push(
                    json!({"type": "session", "snapshot": self.snapshot_value(state, other)}),
                );
            }
        }
    }

    /// The merge requests' reviews showing a local review's comments.
    pub fn publish_linking(&self, state: &State, session_id: &str) {
        let Some(local) = state.sessions.get(session_id) else {
            return;
        };
        if is_gitlab_target(&local.target) {
            return;
        }
        let ids: Vec<String> = state.gitlab.keys().cloned().collect();
        for id in ids {
            if let Some(linking) = state.sessions.get(&id)
                && state
                    .local_reviews_of(linking)
                    .iter()
                    .any(|other| other == session_id)
            {
                self.publish_session(state, linking);
            }
        }
    }

    pub fn wake(&self, state: &State, session_id: &str) {
        if let Some(watchers) = state.watchers.get(session_id) {
            for (_, notify) in watchers {
                notify.notify_one();
            }
        }
    }

    /// A review changed: stamped, stored, published, watchers woken.
    pub fn changed(&self, state: &mut State, id: &str) {
        let at = self.now();
        *state.versions.entry(id.to_owned()).or_default() += 1;
        let Some(session) = state.sessions.get_mut(id) else {
            return;
        };
        session.updated_at = at;
        let session = session.clone();
        self.save_session(&session);
        self.push(json!({"type": "session", "snapshot": self.snapshot_value(state, &session)}));
        self.wake(state, id);
        self.publish_linking(state, id);
        self.publish_shared(state, &session);
    }

    /// A thread written: stamped, kept, stored, its review changed.
    pub fn save_thread_in(
        &self,
        state: &mut State,
        session_id: &str,
        mut thread: ReviewThread,
    ) -> ReviewResult<ReviewThread> {
        thread.updated_at = self.now();
        if thread.inst == 0 {
            thread.inst = state.next();
        }
        self.save_thread(&thread)?;
        state
            .threads_of(session_id)
            .insert(thread.id.clone(), thread.clone());
        self.changed(state, session_id);
        Ok(thread)
    }

    /// Refuses a new review once the store holds the most it keeps.
    pub fn check_room(&self, state: &State, target: Option<&ReviewTarget>) -> ReviewResult<()> {
        if matches!(target, Some(ReviewTarget::Work { .. }))
            || state.sessions.len() < self.session_limit
        {
            return Ok(());
        }
        Err(ReviewError::new(format!(
            "too many reviews ({}, the limit is {}); delete old ones in the reviews list to make room",
            state.sessions.len(),
            self.session_limit
        )))
    }

    /// The review owning a thread shown in another (ownerOf).
    pub fn owner_of(
        &self,
        state: &State,
        target: &ReviewSession,
        id: Option<&Value>,
    ) -> ReviewResult<ReviewSession> {
        let Some(Value::String(text)) = id else {
            return Ok(target.clone());
        };
        if text.is_empty() {
            return Ok(target.clone());
        }
        let mut pending = state.pending_drafts(target);
        pending.extend(state.shared_local(target, self.has_forge()));
        if pending.is_empty() {
            return Ok(target.clone());
        }
        let own = state.thread_list(&target.id);
        match locate_in(own.iter().chain(pending.iter()), id) {
            Ok(found) => Ok(state
                .sessions
                .get(&found.session_id)
                .cloned()
                .unwrap_or_else(|| target.clone())),
            Err(error) if error.status == 404 => Ok(target.clone()),
            Err(error) => Err(error),
        }
    }

    /// Why agents may not see a review (agentRefusal).
    pub fn agent_refusal(&self, state: &State, target: &ReviewSession) -> Option<&'static str> {
        let ReviewTarget::Mr { url } = &target.target else {
            return None;
        };
        let mr = state.gitlab.get(&target.id).and_then(|s| s.mr.as_ref());
        match merge_request_security(url, mr) {
            "security" => Some("this is a security merge request; it is not shared with agents"),
            "unknown" => Some(
                "GitLab has not told yet whether this merge request is confidential; it is not shared with agents until it does",
            ),
            _ => None,
        }
    }

    pub fn assert_agent_allowed(
        &self,
        state: &State,
        target: &ReviewSession,
        writer: &str,
    ) -> ReviewResult<()> {
        if writer == REVIEW_USER {
            return Ok(());
        }
        match self.agent_refusal(state, target) {
            Some(refusal) => Err(ReviewError::status(refusal, 403)),
            None => Ok(()),
        }
    }

    /// The thread on GitLab a comment id names.
    pub fn remote_thread(
        &self,
        state: &State,
        session_id: &str,
        id: Option<&Value>,
    ) -> Option<ReviewThread> {
        let id = id?.as_str()?;
        state
            .gitlab
            .get(session_id)?
            .threads
            .iter()
            .find(|thread| {
                thread.id == id || thread.comments.iter().any(|comment| comment.id == id)
            })
            .cloned()
    }

    /// A queue per key: `run` after the run before it ended (serialize).
    pub fn queue(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lock()
            .queues
            .entry(key.to_owned())
            .or_default()
            .clone()
    }
}

/// The parameters' field (a JSON object's).
pub(crate) fn field<'a>(params: &'a Value, name: &str) -> Option<&'a Value> {
    params.get(name)
}

impl ReviewService {
    /// Opens the service on its storage: every review and its threads.
    pub fn new(options: ReviewServiceOptions) -> Self {
        let publish = options.publish.clone();
        let inner = Inner {
            state: Mutex::new(State::default()),
            prompts: AgentPrompts::new(publish.clone(), options.clock.clone()),
            publish,
            host: options.host,
            clock: options.clock,
            session_limit: options.session_limit.unwrap_or(limits::SESSIONS),
            delivery_delay_ms: options.delivery_delay_ms.unwrap_or(2500),
            retry_delay_ms: options.retry_delay_ms.unwrap_or(15_000),
            agent_search_ms: options.agent_search_ms.unwrap_or(20_000),
            storage: Mutex::new(options.storage),
        };
        let service = Self(Arc::new(inner));
        service.load();
        service
    }

    fn load(&self) {
        let inner = &self.0;
        let (sessions, threads): (Vec<ReviewSession>, Vec<(String, Vec<ReviewThread>)>) = {
            let storage = inner.storage.lock().unwrap();
            let sessions = storage.load_sessions().unwrap_or_default();
            let threads = sessions
                .iter()
                .map(|s| {
                    (
                        s.id.clone(),
                        storage.load_threads(&s.id).unwrap_or_default(),
                    )
                })
                .collect();
            (sessions, threads)
        };
        let mut state = inner.lock();
        for (mut session, (_, list)) in sessions.into_iter().zip(threads) {
            let gitlab = is_gitlab_target(&session.target);
            if session.gitlab != gitlab {
                session.gitlab = gitlab;
                if !gitlab {
                    session.auto_send = None;
                    if crate::js::trim(&session.summary).is_empty() {
                        session.summary_unsent = None;
                    }
                }
                inner.save_session(&session);
            }
            if session.gitlab && session.auto_send == Some(false) {
                session.auto_send = None;
                inner.save_session(&session);
            }
            let id = session.id.clone();
            state.set_session(session);
            let mut map = IndexMap::new();
            for mut thread in list {
                thread.inst = state.next();
                map.insert(thread.id.clone(), thread);
            }
            state.threads.insert(id, map);
        }
        drop(state);
        self.resume_searches();
    }

    /// Agents' permission prompts, answered from the browser.
    pub fn prompts(&self) -> &AgentPrompts {
        &self.0.prompts
    }

    pub fn close(&self) {
        let mut state = self.0.lock();
        state.deliveries.clear();
        state.searching.clear();
        state.search_timer = false;
    }

    fn session(&self, params: &Value) -> ReviewResult<ReviewSession> {
        self.0.lock().session(field(params, "sessionId"))
    }

    pub fn snapshot(&self, id: &str) -> Option<ReviewSnapshot> {
        let state = self.0.lock();
        let target = state.sessions.get(id)?.clone();
        Some(self.0.snapshot_of(&state, &target))
    }

    /// The repositories of the connection's reviews.
    pub fn roots(&self, connection_id: &str) -> Vec<String> {
        let state = self.0.lock();
        let mut roots: IndexSet<String> = IndexSet::new();
        for session in state.sessions.values() {
            if session.connection_id == connection_id && !session.root.is_empty() {
                roots.insert(session.root.clone());
            }
        }
        roots.into_iter().collect()
    }

    fn listed(&self, params: &Value) -> Vec<ReviewSession> {
        let connection = field(params, "connectionId").and_then(Value::as_str);
        let root = field(params, "root").and_then(Value::as_str);
        let chats = field(params, "chats") == Some(&Value::Bool(true));
        let mut shown: Vec<ReviewSession> = self
            .0
            .lock()
            .sessions
            .values()
            .filter(|s| {
                connection.is_none_or(|c| s.connection_id == c)
                    && root.is_none_or(|r| s.root == r)
                    && (!matches!(
                        s.target,
                        ReviewTarget::Chat { .. }
                            | ReviewTarget::Effort { .. }
                            | ReviewTarget::Work { .. }
                    ) || chats)
            })
            .cloned()
            .collect();
        shown.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        for each in &shown {
            self.spawn_migrate(each.id.clone());
            self.spawn_reanchor_file(each.id.clone());
        }
        shown
    }

    /// Every review asked for, as snapshots, latest first.
    pub fn list(&self, params: &Value) -> Vec<ReviewSnapshot> {
        let shown = self.listed(params);
        let state = self.0.lock();
        shown
            .iter()
            .filter_map(|each| state.sessions.get(&each.id))
            .map(|each| self.0.snapshot_of(&state, each))
            .collect()
    }

    /// The summaries of what `list` gives.
    pub fn summaries(&self, params: &Value) -> Vec<ReviewSummary> {
        let shown = self.listed(params);
        let state = self.0.lock();
        shown
            .iter()
            .filter_map(|each| state.sessions.get(&each.id))
            .map(|each| summarize_review(&state.snapshot(each, false, self.0.has_forge())))
            .collect()
    }

    /// The newest review `matches` takes, with its snapshot.
    pub fn newest(&self, matches: impl Fn(&ReviewSession) -> bool) -> Option<ReviewSnapshot> {
        let found = {
            let state = self.0.lock();
            let mut found: Option<&ReviewSession> = None;
            for each in state.sessions.values() {
                if matches(each) && found.is_none_or(|f| each.updated_at > f.updated_at) {
                    found = Some(each);
                }
            }
            found.cloned()?
        };
        self.spawn_migrate(found.id.clone());
        self.spawn_reanchor_file(found.id.clone());
        let state = self.0.lock();
        let found = state.sessions.get(&found.id)?;
        Some(self.0.snapshot_of(&state, found))
    }

    /// A review's snapshot, for a browser or an agent (`get`).
    pub fn get(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let target = self.session(params)?;
        self.spawn_migrate(target.id.clone());
        self.spawn_reanchor_file(target.id.clone());
        let now = self.0.ms();
        let rewrite = {
            let mut state = self.0.lock();
            let due = state.rewrite_read_at.get(&target.id).copied().unwrap_or(0) <= now;
            if due {
                state
                    .rewrite_read_at
                    .insert(target.id.clone(), now + 30_000);
            }
            due
        };
        if rewrite {
            let this = self.clone();
            let id = target.id.clone();
            tokio::spawn(async move { this.reanchor_rewritten_id(&id, None).await });
        }
        let state = self.0.lock();
        let target = state
            .sessions
            .get(&target.id)
            .ok_or_else(|| ReviewError::not_found("no such review"))?;
        Ok(self.0.snapshot_of(&state, target))
    }

    /// Opens (or raises) a review (`open`).
    pub fn open(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let connection_id = text(field(params, "connectionId"), "connection", 200)?;
        let root = text(field(params, "root"), "root", 4096)?;
        let target = parse_review_target(field(params, "target"))?;
        let agent_name = parse_agent_name(field(params, "agent"))?;
        let pane_id = optional_text(field(params, "paneId"), "pane", 200)?;
        let workspace_id = optional_text(field(params, "workspaceId"), "workspace", 200)?;
        let message = optional_text(field(params, "message"), "message", limits::MESSAGE_CHARS)?;
        let title = optional_text(field(params, "title"), "title", limits::TITLE_CHARS)?;
        let automatic = field(params, "automatic") == Some(&Value::Bool(true))
            && matches!(target, ReviewTarget::Range { .. });
        let raise = field(params, "raise") != Some(&Value::Bool(false));
        let inner = &self.0;
        let mut state = inner.lock();
        let site = matches!(&target, ReviewTarget::Rendered { url: Some(_), .. });
        let mut found = state
            .sessions
            .values()
            .find(|s| {
                s.connection_id == connection_id
                    && (s.root == root || site)
                    && same_target(&s.target, &target)
            })
            .map(|s| s.id.clone());
        if found.is_none() && automatic {
            let mut moved: Vec<&ReviewSession> = state
                .sessions
                .values()
                .filter(|s| {
                    let (
                        ReviewTarget::Range {
                            base,
                            head,
                            compare: false,
                        },
                        ReviewTarget::Range {
                            base: new_base,
                            head: new_head,
                            ..
                        },
                    ) = (&s.target, &target)
                    else {
                        return false;
                    };
                    s.connection_id == connection_id
                        && s.root == root
                        && s.automatic_base != Some(false)
                        && head == new_head
                        && (parse::counterpart_bases(base, new_base)
                            || crate::model::is_metadata_ref(base))
                })
                .collect();
            moved.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            if let Some(moved) = moved.first().map(|s| s.id.clone()) {
                self.move_target(&mut state, &moved, target.clone());
                found = Some(moved);
            }
        }
        if let Some(id) = &found
            && automatic
            && let Some(session) = state.sessions.get_mut(id)
            && session.automatic_base.is_none()
        {
            session.automatic_base = Some(true);
        }
        let id = match found {
            Some(id) => id,
            None => {
                inner.check_room(&state, Some(&target))?;
                let at = inner.now();
                let session = ReviewSession {
                    id: parse::new_id(),
                    connection_id: connection_id.clone(),
                    workspace_id: workspace_id.clone(),
                    root: root.clone(),
                    title: title.unwrap_or_else(|| describe_target(&target)),
                    automatic_base: matches!(target, ReviewTarget::Range { .. })
                        .then_some(automatic),
                    gitlab: is_gitlab_target(&target),
                    target,
                    auto_send: Some(true),
                    summary: String::new(),
                    agent: Default::default(),
                    created_at: at.clone(),
                    updated_at: at,
                    summary_unsent: None,
                    summary_sent: None,
                    handoff_at: None,
                    seen_head_sha: None,
                    hold_comments: None,
                    delivered_at: None,
                    delivery_error: None,
                    reviewed: None,
                    extra: Map::new(),
                    inst: 0,
                };
                let id = session.id.clone();
                state.set_session(session);
                state.threads.insert(id.clone(), IndexMap::new());
                id
            }
        };
        let mut bind = None;
        if let Some(session) = state.sessions.get_mut(&id) {
            if let Some(workspace) = &workspace_id {
                session.workspace_id = Some(workspace.clone());
            }
            if let Some(name) = &agent_name
                && (raise || session.agent.name.is_none())
            {
                session.agent.name = Some(name.clone());
            }
            if let Some(pane) = &pane_id
                && (raise || session.agent.pane_id.is_none())
            {
                bind = Some(pane.clone());
            }
        }
        if let Some(pane) = bind {
            self.bind_pane(&mut state, &id, &pane);
        }
        inner.changed(&mut state, &id);
        drop(state);
        self.spawn_migrate(id.clone());
        self.spawn_reanchor_file_asked(id.clone(), None);
        if raise {
            let mut push = Map::new();
            push.insert("type".into(), json!("open"));
            push.insert("sessionId".into(), json!(id));
            push.insert("connectionId".into(), json!(connection_id));
            if let Some(pane) = pane_id {
                push.insert("paneId".into(), json!(pane));
            }
            if let Some(message) = message {
                push.insert("message".into(), json!(message));
            }
            inner.push(Value::Object(push));
        }
        let state = inner.lock();
        Ok(inner.snapshot_of(&state, &state.sessions[&id]))
    }

    /// A review compares `next` from now on (moveTarget).
    pub(crate) fn move_target(&self, state: &mut State, id: &str, next: ReviewTarget) {
        if let Some(session) = state.sessions.get_mut(id) {
            if session.title == describe_target(&session.target) {
                session.title = describe_target(&next);
            }
            session.target = next;
            session.seen_head_sha = None;
        }
        state.found.remove(id);
        state.gone.remove(id);
        *state.loads.entry(id.to_owned()).or_default() += 1;
    }

    /// A range compared against another base (retargetTo).
    fn retarget_to(
        &self,
        state: &State,
        target: &ReviewSession,
        value: Option<&Value>,
    ) -> ReviewResult<ReviewTarget> {
        let ReviewTarget::Range { head, .. } = &target.target else {
            return Err(ReviewError::new("only a range review has a base"));
        };
        let next = ReviewTarget::Range {
            base: parse::ref_name(value, "base")?,
            head: head.clone(),
            compare: false,
        };
        let other = state.sessions.values().any(|s| {
            s.id != target.id
                && s.connection_id == target.connection_id
                && s.root == target.root
                && same_target(&s.target, &next)
        });
        if other {
            return Err(ReviewError::new(format!(
                "another review already compares {}: open it instead",
                describe_target(&next)
            )));
        }
        Ok(next)
    }

    /// The files and hunks reviewed after a change (reviewedAfter).
    fn reviewed_after(
        target: &ReviewSession,
        changes: Option<&Value>,
    ) -> ReviewResult<IndexMap<String, String>> {
        let Some(changes) = changes.and_then(Value::as_object) else {
            return Err(ReviewError::new("invalid reviewed files"));
        };
        let mut reviewed = target.reviewed.clone().unwrap_or_default();
        for (key, value) in changes {
            if crate::js::len16(key) > 4200 {
                return Err(ReviewError::new("invalid reviewed file"));
            }
            match value {
                Value::Null => {
                    reviewed.shift_remove(key);
                }
                Value::String(text) if crate::js::len16(text) <= 64 => {
                    reviewed.insert(key.clone(), text.clone());
                }
                _ => return Err(ReviewError::new("invalid reviewed file")),
            }
        }
        if reviewed.len() > 20_000 {
            return Err(ReviewError::new("too many reviewed files"));
        }
        Ok(reviewed)
    }

    /// Changes a review's settings (`update`).
    pub async fn update(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let target = self.session(params)?;
        let inner = &self.0;
        if let Some(gitlab) = field(params, "gitlab") {
            let Some(gitlab) = gitlab.as_bool() else {
                return Err(ReviewError::new("invalid gitlab flag"));
            };
            if gitlab != target.gitlab {
                return Err(ReviewError::new(if target.gitlab {
                    "this is the merge request's review; open the local review instead"
                } else {
                    "open the merge request's review for GitLab"
                }));
            }
        }
        let agent_name = parse_agent_name(field(params, "agent"))?;
        let agent_pane = optional_text(field(params, "paneId"), "pane", 200)?;
        let flag = |name: &str, what: &str| -> ReviewResult<Option<bool>> {
            match field(params, name) {
                None => Ok(None),
                Some(Value::Bool(value)) => Ok(Some(*value)),
                Some(_) => Err(ReviewError::new(format!("invalid {what} flag"))),
            }
        };
        let auto_send = flag("autoSend", "auto-send")?;
        let hold = flag("holdComments", "hold")?;
        let summary = match field(params, "summary") {
            None => None,
            value => Some(text(value, "summary", limits::SUMMARY_CHARS)?),
        };
        let base = match field(params, "base") {
            None => None,
            value => Some(self.retarget_to(&inner.lock(), &target, value)?),
        };
        let title = match field(params, "title") {
            None => None,
            value => Some(text(value, "title", limits::TITLE_CHARS)?),
        };
        let reviewed = match field(params, "reviewed") {
            None => None,
            value => Some(Self::reviewed_after(&target, value)?),
        };
        let id = target.id.clone();
        if let Some(summary) = &summary {
            let gitlab_mode = inner.lock().gitlab_mode(&target, inner.has_forge());
            {
                let mut state = inner.lock();
                if let Some(session) = state.sessions.get_mut(&id) {
                    session.summary = summary.clone();
                    if gitlab_mode {
                        session.summary_unsent = Some(true);
                    }
                    if gitlab_mode && field(params, "summaryLocal") != Some(&Value::Bool(true)) {
                        let session = session.clone();
                        inner.save_session(&session);
                    }
                }
            }
            if gitlab_mode && field(params, "summaryLocal") != Some(&Value::Bool(true)) {
                if let Err(error) = self.sync_summary(&id).await {
                    let state = inner.lock();
                    if let Some(session) = state.sessions.get(&id) {
                        inner.publish_session(&state, session);
                    }
                    return Err(error);
                }
                let state = inner.lock();
                if !state.live(&id, target.inst) {
                    return Ok(inner.snapshot_of(&state, &target));
                }
            }
        }
        let mut state = inner.lock();
        let mut attached = false;
        let has_pane = state
            .sessions
            .get(&id)
            .is_some_and(|s| s.agent.pane_id.is_some());
        if let Some(pane) = &agent_pane
            && !has_pane
        {
            self.bind_pane(&mut state, &id, pane);
            if let Some(session) = state.sessions.get_mut(&id)
                && let Some(name) = &agent_name
                && session.agent.name.is_none()
            {
                session.agent.name = Some(name.clone());
            }
            attached = true;
        }
        if let Some(session) = state.sessions.get_mut(&id) {
            if let Some(auto) = auto_send {
                session.auto_send = Some(auto);
            }
            match hold {
                Some(true) => session.hold_comments = Some(true),
                Some(false) => session.hold_comments = None,
                None => {}
            }
        }
        let sends = state.sessions.get(&id).is_some_and(sends_by_itself);
        if !sends {
            state.deliveries.remove(&id);
        }
        if let Some(base) = base {
            self.move_target(&mut state, &id, base);
            if let Some(session) = state.sessions.get_mut(&id) {
                session.automatic_base = Some(false);
            }
        }
        if let Some(session) = state.sessions.get_mut(&id)
            && let Some(title) = title
        {
            session.title = title;
        }
        if let Some(reviewed) = reviewed {
            if let Some(session) = state.sessions.get_mut(&id) {
                session.reviewed = Some(reviewed);
            }
            const REVIEWED_ONLY: [&str; 5] =
                ["reviewed", "sessionId", "session_id", "author", "paneId"];
            let only = params
                .as_object()
                .is_some_and(|map| map.keys().all(|key| REVIEWED_ONLY.contains(&key.as_str())));
            if only {
                let session = state.sessions[&id].clone();
                inner.save_session(&session);
                inner.publish_session(&state, &session);
                return Ok(inner.snapshot_of(&state, &session));
            }
        }
        inner.changed(&mut state, &id);
        let snapshot = inner.snapshot_of(&state, &state.sessions[&id]);
        drop(state);
        if attached || auto_send == Some(true) || hold == Some(false) {
            self.schedule_delivery(&id);
        }
        Ok(snapshot)
    }

    /// Removes a review (`remove`).
    pub fn remove(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session(params)?;
        let inner = &self.0;
        let mut state = inner.lock();
        let id = target.id.clone();
        state.delete_session(&id);
        state.threads.remove(&id);
        state.found.remove(&id);
        state.gone.remove(&id);
        state.loads.remove(&id);
        state.versions.remove(&id);
        state.handoffs.remove(&id);
        state.deliveries.remove(&id);
        state.retries.remove(&id);
        state.typing.remove(&id);
        inner.delete_session_row(&id);
        inner.push(
            json!({"type": "removed", "sessionId": id, "connectionId": target.connection_id}),
        );
        inner.wake(&state, &id);
        state.gitlab.shift_remove(&id);
        inner.publish_linking(&state, &id);
        inner.publish_shared(&state, &target);
        Ok(json!({"removed": id}))
    }

    /// The last steps of a checkout whose reviews have threads.
    pub fn kept_steps(&self, root: &str) -> Vec<String> {
        let state = self.0.lock();
        state
            .sessions
            .values()
            .filter_map(|each| match &each.target {
                ReviewTarget::Step { step, .. }
                    if each.root == root
                        && state.threads.get(&each.id).is_some_and(|m| !m.is_empty()) =>
                {
                    Some(step.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// Whether agents may see this review now, without asking GitLab.
    pub fn agent_may_read(&self, params: &Value) -> ReviewResult<bool> {
        let state = self.0.lock();
        let target = state.session(field(params, "sessionId"))?;
        Ok(self.0.agent_refusal(&state, &target).is_none())
    }

    /// Throws when the agent may not use this review, asking GitLab first.
    pub async fn assert_agent_allowed(&self, params: &Value) -> ReviewResult<()> {
        let target = self.session(params)?;
        let writer = parse::author(field(params, "author"))?;
        self.allow_agent(&target.id, &writer).await
    }

    /// The review of the connection holding a comment.
    pub fn session_of_comment(&self, params: &Value) -> ReviewResult<Option<String>> {
        let connection_id = text(field(params, "connectionId"), "connection", 200)?;
        let state = self.0.lock();
        let owners: Vec<&ReviewSession> = state
            .sessions
            .values()
            .filter(|candidate| {
                candidate.connection_id == connection_id
                    && locate_in(
                        state
                            .threads
                            .get(&candidate.id)
                            .into_iter()
                            .flat_map(|m| m.values()),
                        field(params, "commentId"),
                    )
                    .is_ok()
            })
            .collect();
        Ok((owners.len() == 1).then(|| owners[0].id.clone()))
    }
}

/// Whether the user's comments go to the agent by themselves.
pub(crate) fn sends_by_itself(target: &ReviewSession) -> bool {
    target.auto_send != Some(false) && !target.holds_comments()
}

#[cfg(test)]
mod suites;
#[cfg(test)]
mod tests;
