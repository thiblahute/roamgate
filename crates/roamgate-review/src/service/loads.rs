//! What a review shows read from its checkout: diffs, commits, files, the
//! state the overlay polls, which branches moved (review/service.ts). A
//! review whose checkout or range end is gone is remembered so for a while.

use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::join_all;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::{BoxFut, GONE_RETRY_MS, Gone, LoadError, ReviewService, field};
use crate::error::{ReviewError, ReviewResult};
use crate::model::{ReviewCommit, ReviewSession, ReviewTarget};
use crate::parse::{
    self, describe_target, file_requests, object_name, parse_review_target, same_target, text,
};

/// How long review.activity waits on one checkout's branches.
pub const ACTIVITY_ROOT_MS: u64 = 5_000;
const ACTIVITY_PARALLEL: usize = 6;
const ACTIVITY_MAX_IDS: usize = 1_000;

fn gone_key(target: &ReviewSession) -> String {
    serde_json::to_string(&json!([target.root, target.target])).unwrap_or_default()
}

impl ReviewService {
    pub(crate) fn known_gone(&self, target: &ReviewSession) -> Option<LoadError> {
        let state = self.0.lock();
        let known = state.gone.get(&target.id)?;
        (known.key == gone_key(target) && known.until > self.0.ms()).then(|| known.error.clone())
    }

    /// A load from the review's checkout, given up on while it is gone.
    pub(crate) async fn from_checkout<T>(
        &self,
        target: &ReviewSession,
        load: BoxFut<Result<T, LoadError>>,
    ) -> Result<T, LoadError> {
        if let Some(known) = self.known_gone(target) {
            return Err(known);
        }
        match load.await {
            Ok(result) => {
                self.0.lock().gone.remove(&target.id);
                Ok(result)
            }
            Err(error) => {
                if matches!(error, LoadError::Gone { .. })
                    && !matches!(target.target, ReviewTarget::Mr { .. })
                {
                    let mut state = self.0.lock();
                    if state.live(&target.id, target.inst) {
                        state.gone.insert(
                            target.id.clone(),
                            Gone {
                                key: gone_key(target),
                                until: self.0.ms() + GONE_RETRY_MS,
                                error: error.clone(),
                            },
                        );
                    }
                }
                Err(error)
            }
        }
    }

    /// One listing of a review's commits at a time.
    pub(crate) async fn commit_list(
        &self,
        target: &ReviewSession,
    ) -> Result<Vec<ReviewCommit>, LoadError> {
        let shared = {
            let mut state = self.0.lock();
            match state.listing.get(&target.id) {
                Some((_, list)) => list.clone(),
                None => {
                    let Some(load) = self.0.host.load_commits(target) else {
                        return Ok(Vec::new());
                    };
                    let this = self.clone();
                    let owned = target.clone();
                    let future: BoxFut<Result<Vec<ReviewCommit>, LoadError>> =
                        Box::pin(async move { this.from_checkout(&owned, load).await });
                    let list = future.shared();
                    let id = state.next();
                    state.listing.insert(target.id.clone(), (id, list.clone()));
                    let this = self.clone();
                    let key = target.id.clone();
                    let done = list.clone();
                    tokio::spawn(async move {
                        let _ = done.await;
                        let mut state = this.0.lock();
                        if state.listing.get(&key).is_some_and(|(each, _)| *each == id) {
                            state.listing.remove(&key);
                        }
                    });
                    list
                }
            }
        };
        shared.await
    }

    /// A review not opened: a scope Changes shows before its first comment.
    fn preview(&self, params: &Value) -> ReviewResult<ReviewSession> {
        let connection_id = text(field(params, "connectionId"), "connection", 200)?;
        let root = text(field(params, "root"), "root", 4096)?;
        let target = parse_review_target(field(params, "target"))?;
        if !matches!(
            target,
            ReviewTarget::Range { .. } | ReviewTarget::Worktree | ReviewTarget::Step { .. }
        ) {
            return Err(ReviewError::new(
                "only a checkout's changes can be read this way",
            ));
        }
        let at = self.0.now();
        Ok(ReviewSession {
            id: format!("preview-{}", parse::new_id()),
            connection_id,
            workspace_id: None,
            root,
            title: describe_target(&target),
            target,
            automatic_base: None,
            gitlab: false,
            auto_send: None,
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
            inst: u64::MAX,
        })
    }

    pub async fn preview_commits(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.preview(params)?;
        self.commits_of(&target, params).await
    }

    pub async fn preview_diff(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.preview(params)?;
        self.diff_of(&target, params).await
    }

    pub async fn preview_state(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.preview(params)?;
        self.state_of(&target).await
    }

    pub async fn preview_file(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.preview(params)?;
        self.file_of(&target, params).await
    }

    /// The commits under review, oldest first (`commits`).
    pub async fn commits(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session_of(params)?;
        self.commits_of(&target, params).await
    }

    async fn commits_of(&self, target: &ReviewSession, params: &Value) -> ReviewResult<Value> {
        if field(params, "recheck") == Some(&Value::Bool(true)) {
            self.0.lock().gone.remove(&target.id);
        }
        if matches!(
            target.target,
            ReviewTarget::Worktree
                | ReviewTarget::Step { .. }
                | ReviewTarget::Chat { .. }
                | ReviewTarget::Rendered { .. }
        ) || self.0.host.load_commits(target).is_none()
        {
            return Ok(json!({"commits": []}));
        }
        let list = self.commit_list(target).await?;
        if target.inst != u64::MAX {
            let this = self.clone();
            let id = target.id.clone();
            let commits = list.clone();
            tokio::spawn(async move { this.reanchor_rewritten_id(&id, Some(commits)).await });
        }
        let follow = field(params, "follow")
            .and_then(Value::as_str)
            .filter(|follow| parse::is_sha(follow));
        let Some(follow) = follow else {
            return Ok(json!({"commits": list}));
        };
        if list.is_empty() || list.iter().any(|commit| commit.sha == follow) {
            return Ok(json!({"commits": list}));
        }
        let mut shas = vec![follow.to_owned()];
        shas.extend(list.iter().map(|commit| commit.sha.clone()));
        let Some(load) = self.0.host.load_patch_ids(target, shas) else {
            return Ok(json!({"commits": list}));
        };
        match load.await {
            Ok(patch_ids) => Ok(json!({"commits": list, "patchIds": patch_ids})),
            Err(_) => Ok(json!({"commits": list})),
        }
    }

    /// Whether the code moved since the overlay loaded it (`state`).
    pub async fn state(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session_of(params)?;
        self.state_of(&target).await
    }

    async fn state_of(&self, target: &ReviewSession) -> ReviewResult<Value> {
        if matches!(
            target.target,
            ReviewTarget::Mr { .. } | ReviewTarget::Chat { .. } | ReviewTarget::Rendered { .. }
        ) {
            return Ok(json!({"state": ""}));
        }
        let Some(load) = self.0.host.load_state(target) else {
            return Ok(json!({"state": ""}));
        };
        Ok(json!({"state": self.from_checkout(target, load).await?}))
    }

    /// The review's diff (`diff`).
    pub async fn diff(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session_of(params)?;
        self.diff_of(&target, params).await
    }

    async fn diff_of(&self, target: &ReviewSession, params: &Value) -> ReviewResult<Value> {
        let host = &self.0.host;
        let commit = field(params, "commit")
            .and_then(Value::as_str)
            .filter(|commit| !commit.is_empty())
            .map(str::to_owned);
        if let Some(commit) = &commit
            && !parse::is_sha(commit)
        {
            return Err(ReviewError::new("invalid commit"));
        }
        if matches!(
            target.target,
            ReviewTarget::Chat { .. } | ReviewTarget::Rendered { .. }
        ) {
            return Ok(json!({"files": [], "truncated": false}));
        }
        if field(params, "files").is_some() {
            let files = file_requests(field(params, "files"))?;
            let base = object_name(field(params, "base"), "base")?;
            let head = object_name(field(params, "head"), "head")?;
            let Some(load) = host.load_files(target, base.clone(), head.clone(), files) else {
                return Err(ReviewError::new("files are read whole here"));
            };
            let files = self.from_checkout(target, load).await?;
            return Ok(
                json!({"files": files, "baseSha": base, "headSha": head, "truncated": false}),
            );
        }
        let summary = field(params, "summary") == Some(&Value::Bool(true))
            && !matches!(target.target, ReviewTarget::Worktree)
            && host.load_summary(target, None).is_some();
        let load = |commit: Option<String>| -> BoxFut<Result<Value, LoadError>> {
            if summary && let Some(load) = host.load_summary(target, commit.clone()) {
                return load;
            }
            host.load_diff(target, commit, None)
        };
        if let Some(commit) = commit {
            return Ok(self.from_checkout(target, load(Some(commit))).await?);
        }
        if field(params, "first") == Some(&Value::Bool(true)) {
            let first = if matches!(
                target.target,
                ReviewTarget::Worktree | ReviewTarget::Step { .. }
            ) || host.load_commits(target).is_none()
            {
                None
            } else {
                self.commit_list(target)
                    .await?
                    .first()
                    .map(|commit| commit.sha.clone())
            };
            if let Some(first) = first {
                let mut diff = self
                    .from_checkout(target, load(Some(first.clone())))
                    .await?;
                diff["view"] = json!(first);
                return Ok(diff);
            }
            let mut diff = self.all_changes(target, load(None)).await?;
            diff["view"] = Value::Null;
            return Ok(diff);
        }
        self.all_changes(target, load(None)).await
    }

    async fn all_changes(
        &self,
        target: &ReviewSession,
        read: BoxFut<Result<Value, LoadError>>,
    ) -> ReviewResult<Value> {
        let load = {
            let mut state = self.0.lock();
            let load = state.loads.get(&target.id).copied().unwrap_or(0) + 1;
            state.loads.insert(target.id.clone(), load);
            load
        };
        let result = self.from_checkout(target, read).await?;
        let head = result
            .get("headSha")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty());
        let mut state = self.0.lock();
        if let Some(head) = head
            && state.live(&target.id, target.inst)
            && state.loads.get(&target.id) == Some(&load)
            && let Some(live) = state.sessions.get_mut(&target.id)
            && live.seen_head_sha.as_deref() != Some(head)
        {
            live.seen_head_sha = Some(head.to_owned());
            let live = live.clone();
            self.0.save_session(&live);
        }
        Ok(result)
    }

    /// Which reviews' branches moved since last seen (`activity`).
    pub async fn activity(&self, params: &Value) -> ReviewResult<Value> {
        let connection_id = text(field(params, "connectionId"), "connection", 200)?;
        let asked: Option<Vec<String>> = match field(params, "sessionIds") {
            None => None,
            Some(Value::Array(ids)) => {
                if ids.len() > ACTIVITY_MAX_IDS {
                    return Err(ReviewError::new(format!(
                        "sessionIds names over {ACTIVITY_MAX_IDS} reviews"
                    )));
                }
                Some(
                    ids.iter()
                        .filter_map(Value::as_str)
                        .filter(|id| parse::is_id(id))
                        .map(str::to_owned)
                        .collect(),
                )
            }
            Some(_) => return Err(ReviewError::new("sessionIds is a list")),
        };
        let mine: Vec<ReviewSession> = self
            .0
            .lock()
            .sessions
            .values()
            .filter(|s| {
                s.connection_id == connection_id
                    && asked.as_ref().is_none_or(|ids| ids.contains(&s.id))
            })
            .cloned()
            .collect();
        let mut out: Vec<Value> = Vec::new();
        for s in &mine {
            if let Some(LoadError::Gone { code, .. }) = self.known_gone(s) {
                out.push(json!({"sessionId": s.id, "newCommits": false, "gone": code}));
            }
        }
        let reviews: Vec<ReviewSession> = mine
            .into_iter()
            .filter(|s| {
                matches!(s.target, ReviewTarget::Range { .. }) && self.known_gone(s).is_none()
            })
            .collect();
        let host = &self.0.host;
        if reviews.is_empty() || host.load_heads(&connection_id, Vec::new()).is_none() {
            return Ok(json!({"activity": out}));
        }
        let mut by_root: IndexMap<String, Vec<ReviewSession>> = IndexMap::new();
        for s in &reviews {
            by_root.entry(s.root.clone()).or_default().push(s.clone());
        }
        let mut heads: std::collections::HashMap<String, Option<String>> = Default::default();
        let mut unreadable: std::collections::HashSet<String> = Default::default();
        let groups: Vec<(String, Vec<ReviewSession>)> = by_root.into_iter().collect();
        for chunk in groups.chunks(ACTIVITY_PARALLEL) {
            let reads = chunk.iter().map(|(root, group)| {
                let entries = group
                    .iter()
                    .map(|s| {
                        let reference = match &s.target {
                            ReviewTarget::Range { head, .. } => head.clone(),
                            _ => "HEAD".into(),
                        };
                        (root.clone(), reference)
                    })
                    .collect();
                let load = host.load_heads(&connection_id, entries);
                let clock = self.0.clock.clone();
                async move {
                    let Some(load) = load else {
                        return Err(());
                    };
                    match roamgate_base::clock::timeout(
                        &*clock,
                        Duration::from_millis(ACTIVITY_ROOT_MS),
                        load,
                    )
                    .await
                    {
                        Ok(Ok(found)) => Ok(found),
                        _ => Err(()),
                    }
                }
            });
            let answers = join_all(reads).await;
            for ((_, group), answer) in chunk.iter().zip(answers) {
                match answer {
                    Ok(found) => {
                        for (index, s) in group.iter().enumerate() {
                            heads.insert(s.id.clone(), found.get(index).cloned().flatten());
                        }
                    }
                    Err(()) => {
                        for s in group {
                            unreadable.insert(s.id.clone());
                        }
                    }
                }
            }
        }
        for s in &reviews {
            if unreadable.contains(&s.id) {
                out.push(json!({"sessionId": s.id, "newCommits": false, "unreadable": true}));
                continue;
            }
            let head = heads.get(&s.id).cloned().flatten();
            let mut entry = Map::new();
            entry.insert("sessionId".into(), json!(s.id));
            if let Some(head) = &head {
                entry.insert("headSha".into(), json!(head));
            }
            let moved = head.as_ref().is_some_and(|head| {
                s.seen_head_sha
                    .as_ref()
                    .is_some_and(|seen| !seen.is_empty() && seen != head)
            });
            entry.insert("newCommits".into(), json!(moved));
            out.push(Value::Object(entry));
        }
        Ok(json!({"activity": out}))
    }

    /// One file of the review (`file`).
    pub async fn file(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session_of(params)?;
        self.file_of(&target, params).await
    }

    async fn file_of(&self, target: &ReviewSession, params: &Value) -> ReviewResult<Value> {
        let rev = field(params, "rev")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let path = text(field(params, "path"), "path", 4096)?;
        let Some(load) = self.0.host.load_file(target, rev, path) else {
            return Err(ReviewError::new("files are not available here"));
        };
        Ok(json!({"text": self.from_checkout(target, load).await?}))
    }

    /// The target to open for an agent's range of the checkout
    /// (`equivalentTarget`).
    pub async fn equivalent_target(
        &self,
        connection_id: &str,
        root: &str,
        target: ReviewTarget,
    ) -> ReviewTarget {
        let ReviewTarget::Range {
            base,
            head,
            compare: false,
        } = &target
        else {
            return target;
        };
        let kept: Vec<ReviewSession> = self
            .0
            .lock()
            .sessions
            .values()
            .filter(|s| {
                s.connection_id == connection_id
                    && s.root == root
                    && matches!(s.target, ReviewTarget::Range { compare: false, .. })
            })
            .cloned()
            .collect();
        if kept.is_empty() || kept.iter().any(|s| same_target(&s.target, &target)) {
            return target;
        }
        let mut names: Vec<String> = vec![base.clone(), head.clone()];
        for s in &kept {
            if let ReviewTarget::Range { base, head, .. } = &s.target {
                names.push(base.clone());
                names.push(head.clone());
            }
        }
        let mut unique: Vec<String> = Vec::new();
        for name in names {
            if !unique.contains(&name) {
                unique.push(name);
            }
        }
        let Some(load) = self.0.host.load_heads(
            connection_id,
            unique
                .iter()
                .map(|r| (root.to_owned(), r.clone()))
                .collect(),
        ) else {
            return target;
        };
        let Ok(shas) = load.await else {
            return target;
        };
        let sha = |reference: &str| -> Option<String> {
            unique
                .iter()
                .position(|name| name == reference)
                .and_then(|at| shas.get(at).cloned().flatten())
        };
        let (Some(base_sha), Some(head_sha)) = (sha(base), sha(head)) else {
            return target;
        };
        let mut same: Vec<&ReviewSession> = kept
            .iter()
            .filter(|s| match &s.target {
                ReviewTarget::Range { base, head, .. } => {
                    sha(base).as_ref() == Some(&base_sha) && sha(head).as_ref() == Some(&head_sha)
                }
                _ => false,
            })
            .collect();
        same.sort_by(|a, b| {
            let follows = |s: &ReviewSession| matches!(&s.target, ReviewTarget::Range { head, .. } if head == "HEAD");
            follows(b)
                .cmp(&follows(a))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        same.first().map(|s| s.target.clone()).unwrap_or(target)
    }
}
