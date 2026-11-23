//! Merge requests' reviews (review/service.ts): the merge request of a
//! branch, its threads and draft notes on the forge, the local reviews'
//! review comments waiting for it, the overall comment. The forge itself
//! is the host's ([`super::ReviewForge`]).

use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::{Value, json};

use super::{
    BoxFut, FIND_RETRY_MS, FIND_TTL_MS, FOREVER, Found, FoundMergeRequest, GITLAB_THREADS_MS,
    GONE_RETRY_MS, GitlabState, LoadError, ReviewForge, ReviewService, field,
};
use crate::error::{ReviewError, ReviewResult};
use crate::model::{
    COMMIT_MESSAGE_PATH, REVIEW_USER, ReviewAnchor, ReviewSession, ReviewSnapshot, ReviewTarget,
    ReviewThread, limits,
};
use crate::parse::{
    self, author, body, is_gitlab_target, parse_merge_request_url, parse_review_target,
    reviews_branch, same_merge_request, text,
};

impl ReviewService {
    fn forge(&self) -> ReviewResult<Arc<dyn ReviewForge>> {
        self.0
            .host
            .forge()
            .ok_or_else(|| ReviewError::new("GitLab is not available here"))
    }

    /// As assertAgentAllowed, asking GitLab first when it has not answered.
    pub(crate) async fn allow_agent(&self, id: &str, writer: &str) -> ReviewResult<()> {
        if writer == REVIEW_USER {
            return Ok(());
        }
        let needs = {
            let state = self.0.lock();
            let target = state.sessions.get(id).cloned();
            match target {
                Some(target) => {
                    matches!(target.target, ReviewTarget::Mr { .. })
                        && state.gitlab.get(id).and_then(|s| s.mr.as_ref()).is_none()
                }
                None => return Ok(()),
            }
        };
        if needs {
            let _ = self.refresh_gitlab(&json!({"sessionId": id})).await;
        }
        let state = self.0.lock();
        let Some(target) = state.sessions.get(id) else {
            return Ok(());
        };
        self.0.assert_agent_allowed(&state, target, writer)
    }

    /// The forge's merge request of the reviewed branch (findMergeRequest).
    pub(crate) async fn find_merge_request(
        &self,
        target: &ReviewSession,
        fresh: bool,
    ) -> FoundMergeRequest {
        let inner = &self.0;
        let Some(forge) = inner.host.forge() else {
            return FoundMergeRequest::Link(None);
        };
        if !matches!(
            target.target,
            ReviewTarget::Range { .. } | ReviewTarget::Worktree | ReviewTarget::Mr { .. }
        ) {
            return FoundMergeRequest::Link(None);
        }
        let unreadable =
            serde_json::to_string(&json!([target.root, target.target])).unwrap_or_default();
        let failed = {
            let state = inner.lock();
            state
                .found
                .get(&target.id)
                .filter(|f| f.key == unreadable && f.until > inner.ms())
                .map(|f| f.result.clone())
        };
        if let Some(failed) = failed {
            return failed.await;
        }
        let checkout = match forge.checkout(target).await {
            Ok(checkout) => checkout,
            Err(error) => {
                let result = FoundMergeRequest::Error(error.message().to_owned());
                let now = inner.ms();
                let ready = result.clone();
                let mut state = inner.lock();
                let id = state.next();
                state.found.insert(
                    target.id.clone(),
                    Found {
                        key: unreadable,
                        at: now,
                        until: now
                            + if matches!(error, LoadError::Gone { .. }) {
                                GONE_RETRY_MS
                            } else {
                                FIND_RETRY_MS
                            },
                        result: (Box::pin(async move { ready }) as BoxFut<FoundMergeRequest>)
                            .shared(),
                        id,
                    },
                );
                return result;
            }
        };
        let reference = match &target.target {
            ReviewTarget::Range { head, .. } => head.clone(),
            _ => "HEAD".into(),
        };
        let head = if reference != "HEAD"
            && let Some(load) = inner.host.load_heads(
                &target.connection_id,
                vec![(target.root.clone(), reference)],
            ) {
            load.await
                .ok()
                .and_then(|heads| heads.into_iter().next().flatten())
        } else {
            checkout
                .get("head")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let branch = checkout
            .get("branch")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let key = serde_json::to_string(&json!([
            target.root,
            target.target,
            head.clone().unwrap_or_default(),
            branch
        ]))
        .unwrap_or_default();
        let cached = {
            let state = inner.lock();
            state
                .found
                .get(&target.id)
                .filter(|f| f.key == key && f.until > inner.ms())
                .map(|f| (f.result.clone(), f.at))
        };
        if let Some((cached, at)) = cached {
            let result = cached.await;
            let stale = fresh
                && result == FoundMergeRequest::Link(None)
                && inner.ms() - at >= FIND_RETRY_MS;
            if !stale {
                return result;
            }
        }
        let this = self.clone();
        let owned = target.clone();
        let entry_key = key.clone();
        let (id, shared) = {
            let mut state = inner.lock();
            let id = state.next();
            let future: BoxFut<FoundMergeRequest> = Box::pin(async move {
                let found = forge.find(&owned, checkout).await;
                let now = this.0.ms();
                let (ttl, result) = match found {
                    Ok(request) => (FIND_TTL_MS, this.link_of(&owned, request)),
                    Err(error) => (FIND_RETRY_MS, FoundMergeRequest::Error(error)),
                };
                let mut state = this.0.lock();
                if let Some(entry) = state.found.get_mut(&owned.id)
                    && entry.id == id
                {
                    entry.at = now;
                    entry.until = now + ttl;
                }
                result
            });
            let shared = future.shared();
            state.found.insert(
                target.id.clone(),
                Found {
                    key: entry_key,
                    at: FOREVER,
                    until: FOREVER,
                    result: shared.clone(),
                    id,
                },
            );
            (id, shared)
        };
        let _ = id;
        shared.await
    }

    fn link_of(&self, target: &ReviewSession, request: Option<Value>) -> FoundMergeRequest {
        let Some(request) = request else {
            return FoundMergeRequest::Link(None);
        };
        let field = |name: &str| request.get(name).and_then(Value::as_str).unwrap_or("");
        let parsed = parse_merge_request_url(field("url"));
        let Some(parsed) = parsed else {
            return FoundMergeRequest::Link(None);
        };
        if field("state") != "opened" || !reviews_branch(&target.target, field("branch")) {
            return FoundMergeRequest::Link(None);
        }
        if let ReviewTarget::Mr { url } = &target.target {
            let same = parse_merge_request_url(url)
                .is_some_and(|reviewed| same_merge_request(&parsed, &reviewed));
            if !same {
                return FoundMergeRequest::Link(None);
            }
        }
        FoundMergeRequest::Link(Some(json!({
            "url": field("url"),
            "title": field("title"),
            "number": request.get("number").cloned().unwrap_or(Value::Null),
        })))
    }

    /// The merge request of a review's branch (`review.gitlab.find`).
    pub async fn find_gitlab(&self, params: &Value) -> ReviewResult<Value> {
        let target = self.session_of(params)?;
        let local = field(params, "local") == Some(&Value::Bool(true));
        let result = self.find_merge_request(&target, local).await;
        let merge_request = match result {
            FoundMergeRequest::Link(link) => link,
            FoundMergeRequest::Error(_) => None,
        };
        if !local || merge_request.is_none() || !matches!(target.target, ReviewTarget::Mr { .. }) {
            return Ok(json!({"mergeRequest": merge_request}));
        }
        let linked = self.linked_reviews(&target, true).await;
        let state = self.0.lock();
        let mut locals: Vec<&ReviewSession> = state
            .local_reviews_of(&target)
            .iter()
            .filter(|id| linked.contains(id))
            .filter_map(|id| state.sessions.get(id))
            .collect();
        locals.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let ids: Vec<&String> = locals.iter().map(|s| &s.id).collect();
        Ok(json!({"mergeRequest": merge_request, "localReviews": ids}))
    }

    /// From a local review: the review of its branch's merge request
    /// (`review.gitlab.open`).
    pub async fn open_gitlab(&self, params: &Value) -> ReviewResult<Value> {
        let from = self.session_of(params)?;
        if is_gitlab_target(&from.target) {
            let state = self.0.lock();
            return Ok(
                json!({"mergeRequest": null, "snapshot": self.0.snapshot_of(&state, &from)}),
            );
        }
        let open = |url: &str| {
            let mut params = json!({
                "connectionId": from.connection_id,
                "root": from.root,
                "target": {"kind": "mr", "url": url},
                "raise": false,
            });
            if let Some(workspace) = &from.workspace_id {
                params["workspaceId"] = json!(workspace);
            }
            if let Some(agent) = &from.agent.name {
                params["agent"] = json!(agent);
            }
            if let Some(pane) = &from.agent.pane_id {
                params["paneId"] = json!(pane);
            }
            self.open(&params)
        };
        if let Some(url) = field(params, "url") {
            let picked = parse_review_target(Some(&json!({"kind": "mr", "url": url})))?;
            let ReviewTarget::Mr { url } = picked else {
                return Err(ReviewError::new("invalid merge request URL"));
            };
            let number: i64 = regex::Regex::new(r"/(?:-/merge_requests|pull)/(\d+)")
                .unwrap()
                .captures(&url)
                .and_then(|c| c[1].parse().ok())
                .unwrap_or(0);
            let opened = open(&url)?;
            let target = self.session_of(&json!({"sessionId": opened.session.id}))?;
            let linked = self.linked_reviews(&target, false).await;
            self.link_reviews(&target.id, linked);
            let state = self.0.lock();
            let live = state.sessions[&target.id].clone();
            return Ok(json!({
                "mergeRequest": {"url": url, "title": "", "number": number},
                "snapshot": self.0.snapshot_of(&state, &live),
            }));
        }
        let result = self.find_merge_request(&from, true).await;
        let link = match result {
            FoundMergeRequest::Error(error) => return Err(ReviewError::new(error)),
            FoundMergeRequest::Link(None) => return Ok(json!({"mergeRequest": null})),
            FoundMergeRequest::Link(Some(link)) => link,
        };
        let url = link["url"].as_str().unwrap_or("").to_owned();
        let opened = open(&url)?;
        let target = self.session_of(&json!({"sessionId": opened.session.id}))?;
        let linked = self.linked_reviews(&target, false).await;
        self.link_reviews(&target.id, linked);
        let state = self.0.lock();
        let live = state.sessions[&target.id].clone();
        Ok(json!({"mergeRequest": link, "snapshot": self.0.snapshot_of(&state, &live)}))
    }

    /// The local reviews whose branch is the merge request's source branch
    /// (linkedReviews).
    pub(crate) async fn linked_reviews(&self, target: &ReviewSession, strict: bool) -> Vec<String> {
        let ReviewTarget::Mr { url } = &target.target else {
            return Vec::new();
        };
        if self.0.host.forge().is_none() {
            return Vec::new();
        }
        let Some(reviewed) = parse_merge_request_url(url) else {
            return Vec::new();
        };
        let (before, candidates): (Vec<String>, Vec<ReviewSession>) = {
            let state = self.0.lock();
            (
                state
                    .gitlab
                    .get(&target.id)
                    .and_then(|s| s.linked.clone())
                    .unwrap_or_default(),
                state
                    .local_reviews_of(target)
                    .iter()
                    .filter_map(|id| state.sessions.get(id).cloned())
                    .collect(),
            )
        };
        let answers = futures_util::future::join_all(
            candidates
                .iter()
                .map(|other| self.find_merge_request(other, false)),
        )
        .await;
        let mut linked = Vec::new();
        for (other, answer) in candidates.iter().zip(answers) {
            let keep = match answer {
                FoundMergeRequest::Error(_) => !strict && before.contains(&other.id),
                FoundMergeRequest::Link(link) => {
                    let parsed = link
                        .as_ref()
                        .and_then(|link| link["url"].as_str())
                        .and_then(parse_merge_request_url);
                    if parsed.is_some_and(|parsed| same_merge_request(&parsed, &reviewed)) {
                        self.mark_pending(&other.id, url);
                        true
                    } else {
                        false
                    }
                }
            };
            if keep {
                linked.push(other.id.clone());
            }
        }
        linked
    }

    fn mark_pending(&self, id: &str, url: &str) {
        let inner = &self.0;
        let mut state = inner.lock();
        let Some(map) = state.threads.get_mut(id) else {
            return;
        };
        for thread in map.values_mut() {
            if thread.kind != "draft" || thread.pending_for.is_some() {
                continue;
            }
            thread.pending_for = Some(url.to_owned());
            let _ = inner.save_thread(thread);
        }
    }

    /// A review comment written in a local review learns its merge request
    /// in the background (notePendingFor).
    pub(crate) fn note_pending_for(&self, id: &str, thread_id: &str) {
        let inner = &self.0;
        if inner.host.forge().is_none() {
            return;
        }
        let Some((target, thread)) = ({
            let state = inner.lock();
            state.sessions.get(id).cloned().and_then(|target| {
                state
                    .threads
                    .get(id)
                    .and_then(|m| m.get(thread_id))
                    .cloned()
                    .map(|thread| (target, thread))
            })
        }) else {
            return;
        };
        if is_gitlab_target(&target.target) || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let result = this.find_merge_request(&target, false).await;
            let FoundMergeRequest::Link(Some(link)) = result else {
                return;
            };
            let Some(url) = link["url"].as_str() else {
                return;
            };
            let inner = &this.0;
            let mut state = inner.lock();
            let Some(live) = state
                .threads
                .get_mut(&target.id)
                .and_then(|m| m.get_mut(&thread.id))
            else {
                return;
            };
            if live.inst != thread.inst || live.pending_for.is_some() {
                return;
            }
            live.pending_for = Some(url.to_owned());
            let live = live.clone();
            let _ = inner.save_thread(&live);
            inner.publish_linking(&state, &target.id);
        });
    }

    pub(crate) fn link_reviews(&self, id: &str, linked: Vec<String>) {
        let mut state = self.0.lock();
        state.gitlab.entry(id.to_owned()).or_default().linked = Some(linked);
    }

    /// An agent's overall comment left waiting in a local review goes with
    /// the merge request's drafts (adoptSummaries).
    fn adopt_summaries(&self, id: &str) {
        let inner = &self.0;
        let mut state = inner.lock();
        if state.gitlab.get(id).and_then(|s| s.mr.as_ref()).is_none() {
            return;
        }
        let Some(target) = state.sessions.get(id).cloned() else {
            return;
        };
        for other_id in state.local_reviews_of(&target) {
            let linked = state
                .gitlab
                .get(id)
                .and_then(|s| s.linked.clone())
                .unwrap_or_default();
            let Some(other) = state.sessions.get(&other_id).cloned() else {
                continue;
            };
            if !other.summary_unsent() || !linked.contains(&other_id) {
                continue;
            }
            let note = crate::js::trim(&other.summary).to_owned();
            let live = state.sessions.get_mut(id).unwrap();
            if !note.is_empty() && !live.summary.contains(&note) {
                live.summary = if crate::js::trim(&live.summary).is_empty() {
                    other.summary.clone()
                } else {
                    format!("{}\n\n{}", live.summary, other.summary)
                };
                live.summary_unsent = Some(true);
                let live = live.clone();
                inner.save_session(&live);
            }
            let other = state.sessions.get_mut(&other_id).unwrap();
            other.summary_unsent = None;
            let other = other.clone();
            inner.save_session(&other);
        }
    }

    /// Reads the merge request and its threads again (`review.gitlab.refresh`).
    pub async fn refresh_gitlab(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let inner = &self.0;
        let target = self.session_of(params)?;
        let snapshot = |this: &Self| {
            let state = this.0.lock();
            let live = state
                .sessions
                .get(&target.id)
                .cloned()
                .unwrap_or_else(|| target.clone());
            this.0.snapshot_of(&state, &live)
        };
        let Some(forge) = inner.host.forge() else {
            return Ok(snapshot(self));
        };
        let ReviewTarget::Mr { url } = &target.target else {
            return Ok(snapshot(self));
        };
        let before = serde_json::to_string(&snapshot(self)).unwrap_or_default();
        let poll = field(params, "poll") == Some(&Value::Bool(true));
        let attempt: Result<(), String> = async {
            let linked = self.linked_reviews(&target, false).await;
            self.link_reviews(&target.id, linked);
            let mr = forge.read_merge_request(&target, url).await?;
            {
                let mut state = inner.lock();
                let known = state.gitlab.get(&target.id).cloned();
                if let Some(known) = known
                    && poll
                    && let Some(known_mr) = &known.mr
                    && known.error.is_none()
                    && let Some(at) = known.threads_at
                    && inner.ms() - at < GITLAB_THREADS_MS
                    && mr.get("updatedAt").is_some_and(|u| !u.is_null())
                    && known_mr.get("updatedAt") == mr.get("updatedAt")
                    && known_mr.get("headSha") == mr.get("headSha")
                {
                    state.gitlab.get_mut(&target.id).unwrap().mr = Some(mr);
                    return Ok(());
                }
            }
            let remote = forge.read_threads(&target, &mr).await?;
            let mut state = inner.lock();
            let now = inner.ms();
            let entry = state.gitlab.entry(target.id.clone()).or_default();
            entry.mr = Some(mr);
            entry.threads = remote.clone();
            entry.threads_at = Some(now);
            entry.error = None;
            let overall = remote.iter().find(|t| {
                t.gitlab.as_ref().is_some_and(|g| g.draft_id.is_some()) && t.anchor.path.is_none()
            });
            if let Some(live) = state.sessions.get_mut(&target.id)
                && crate::js::trim(&live.summary).is_empty()
                && let Some(first) = overall.and_then(|t| t.comments.first())
            {
                live.summary = first.body.clone();
                let live = live.clone();
                inner.save_session(&live);
            }
            drop(state);
            self.adopt_summaries(&target.id);
            Ok(())
        }
        .await;
        if let Err(error) = attempt {
            inner
                .lock()
                .gitlab
                .entry(target.id.clone())
                .or_default()
                .error = Some(error);
        }
        let after = snapshot(self);
        if serde_json::to_string(&after).unwrap_or_default() != before {
            let state = inner.lock();
            if let Some(live) = state.sessions.get(&target.id) {
                inner.publish_session(&state, live);
            }
        }
        Ok(after)
    }

    async fn merge_request_of(
        &self,
        id: &str,
    ) -> ReviewResult<(Arc<dyn ReviewForge>, Value, ReviewSession)> {
        let forge = self.forge()?;
        let known = self.0.lock().gitlab.get(id).and_then(|s| s.mr.clone());
        if known.is_none() {
            self.refresh_gitlab(&json!({"sessionId": id})).await?;
        }
        let state = self.0.lock();
        let gitlab = state.gitlab.get(id).cloned().unwrap_or_default();
        let target = state
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| ReviewError::not_found("no such review"))?;
        match gitlab.mr {
            Some(mr) => Ok((forge, mr, target)),
            None => {
                Err(ReviewError::new(gitlab.error.unwrap_or_else(|| {
                    "the merge request is not reachable".into()
                })))
            }
        }
    }

    /// Sends the overall comment to the forge, after the writes already
    /// going (syncSummary).
    pub(crate) async fn sync_summary(&self, id: &str) -> ReviewResult<()> {
        let queue = self.0.queue(&format!("summary:{id}"));
        let _turn = queue.lock().await;
        let (written, inst) = {
            let state = self.0.lock();
            let target = state
                .sessions
                .get(id)
                .ok_or_else(|| ReviewError::not_found("no such review"))?;
            (target.summary.clone(), target.inst)
        };
        self.write_summary_draft(id).await?;
        let mut state = self.0.lock();
        if state.live(id, inst)
            && let Some(live) = state.sessions.get_mut(id)
            && live.summary == written
            && live.summary_unsent()
        {
            live.summary_unsent = None;
            let live = live.clone();
            self.0.save_session(&live);
        }
        Ok(())
    }

    async fn write_summary_draft(&self, id: &str) -> ReviewResult<()> {
        let (forge, mr, target) = self.merge_request_of(id).await?;
        let existing = {
            let state = self.0.lock();
            state.gitlab.get(id).and_then(|s| {
                s.threads
                    .iter()
                    .find(|t| {
                        t.gitlab.as_ref().is_some_and(|g| g.draft_id.is_some())
                            && t.anchor.path.is_none()
                    })
                    .cloned()
            })
        };
        let note = crate::js::trim(&target.summary).to_owned();
        if let Some(existing) = existing {
            let draft_id = existing.gitlab.as_ref().and_then(|g| g.draft_id).unwrap();
            if note.is_empty() {
                forge
                    .delete_draft_note(&target, &mr, draft_id)
                    .await
                    .map_err(ReviewError::new)?;
                let mut state = self.0.lock();
                if let Some(entry) = state.gitlab.get_mut(id) {
                    entry.threads.retain(|t| t.id != existing.id);
                }
            } else if existing.comments.first().map(|c| c.body.as_str())
                != Some(target.summary.as_str())
            {
                let updated = forge
                    .update_draft_note(&target, &mr, draft_id, target.summary.clone())
                    .await
                    .map_err(ReviewError::new)?;
                let mut state = self.0.lock();
                if let Some(entry) = state.gitlab.get_mut(id) {
                    for thread in entry.threads.iter_mut() {
                        if thread.id == existing.id {
                            *thread = updated.clone();
                        }
                    }
                }
            }
        } else if !note.is_empty() {
            let draft = forge
                .create_draft_note(
                    &target,
                    &mr,
                    ReviewAnchor::default(),
                    target.summary.clone(),
                    None,
                )
                .await
                .map_err(ReviewError::new)?;
            self.0
                .lock()
                .gitlab
                .entry(id.to_owned())
                .or_default()
                .threads
                .push(draft);
        }
        Ok(())
    }

    /// The diff a draft note's anchor is on (anchorDiff).
    async fn anchor_diff(&self, target: &ReviewSession, anchor: &ReviewAnchor) -> Option<Value> {
        let path = anchor.path.as_ref()?;
        anchor.line?;
        let commit = match (&anchor.commit, &anchor.commit_parent) {
            (Some(commit), Some(_)) => Some(commit.clone()),
            _ => None,
        };
        let mut paths = vec![path.clone()];
        if let Some(old) = &anchor.old_path
            && old != path
        {
            paths.push(old.clone());
        }
        self.0
            .host
            .load_diff(target, commit, Some(paths))
            .await
            .ok()
    }

    /// A review comment as a forge draft note (gitlabNote).
    fn gitlab_note(anchor: &ReviewAnchor, text: &str) -> (ReviewAnchor, String) {
        if anchor.path.as_deref() != Some(COMMIT_MESSAGE_PATH) {
            return (anchor.clone(), text.to_owned());
        }
        let commit = anchor
            .commit
            .as_deref()
            .map(|c| crate::js::head16(c, 10).to_owned())
            .unwrap_or_else(|| "the commit".into());
        (
            ReviewAnchor::default(),
            format!(
                "On the commit message of {commit}{}{}\n\n{text}",
                anchor
                    .commit_subject
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" (\"{s}\")"))
                    .unwrap_or_default(),
                anchor
                    .text
                    .as_deref()
                    .filter(|t| !t.is_empty())
                    .map(|t| format!(":\n> {t}"))
                    .unwrap_or_default()
            ),
        )
    }

    /// The user's review comment in a merge request's review: a draft
    /// note on the forge.
    pub(crate) async fn add_gitlab_draft(
        &self,
        target: &ReviewSession,
        anchor: ReviewAnchor,
        text_body: String,
    ) -> ReviewResult<ReviewThread> {
        let (forge, mr, live) = self.merge_request_of(&target.id).await?;
        let (anchor, note) = Self::gitlab_note(&anchor, &text_body);
        let diff = if anchor.end_line.is_some() || anchor.side.as_deref() == Some("old") {
            self.anchor_diff(&live, &anchor).await
        } else {
            None
        };
        let thread = forge
            .create_draft_note(&live, &mr, anchor, note, diff)
            .await
            .map_err(ReviewError::new)?;
        let state_thread = thread.clone();
        let mut state = self.0.lock();
        state
            .gitlab
            .entry(target.id.clone())
            .or_default()
            .threads
            .push(state_thread);
        if let Some(live) = state.sessions.get(&target.id).cloned() {
            self.0.publish_session(&state, &live);
        }
        self.0.wake(&state, &target.id);
        Ok(thread)
    }

    pub(crate) async fn reply_remote(
        &self,
        target: &ReviewSession,
        remote: ReviewThread,
        params: &Value,
    ) -> ReviewResult<ReviewThread> {
        let Some(discussion) = remote.gitlab.as_ref().and_then(|g| g.discussion_id.clone()) else {
            return Err(ReviewError::new(if remote.id.starts_with("ghc:") {
                "a pull request's conversation comment has no draft reply on GitHub: answer it there"
            } else {
                "edit a draft note instead of replying to it"
            }));
        };
        let writer = author(field(params, "author"))?;
        if writer != REVIEW_USER {
            self.allow_agent(&target.id, &writer).await?;
            let inner = &self.0;
            let mut state = inner.lock();
            if state.threads.get(&target.id).map_or(0, |m| m.len()) >= limits::THREADS_PER_SESSION {
                return Err(ReviewError::new("too many comments in this review"));
            }
            let at = inner.now();
            let thread = ReviewThread {
                id: parse::new_id(),
                session_id: target.id.clone(),
                kind: "draft".into(),
                anchor: remote.anchor.clone(),
                comments: vec![crate::model::ReviewComment::new(
                    parse::new_id(),
                    writer,
                    body(field(params, "text"), limits::BODY_CHARS)?,
                    &at,
                )],
                resolved: false,
                created_at: at.clone(),
                updated_at: at,
                held: None,
                gitlab: None,
                gitlab_reply_to: Some(discussion),
                pending_for: None,
                handed_at: None,
                extra: serde_json::Map::new(),
                inst: 0,
            };
            let thread = inner.save_thread_in(&mut state, &target.id, thread)?;
            if let Some(live) = state.sessions.get_mut(&target.id)
                && live
                    .agent
                    .working
                    .as_ref()
                    .and_then(|w| w.thread_id.as_deref())
                    == Some(remote.id.as_str())
            {
                live.agent.working = None;
            }
            return Ok(thread);
        }
        let (forge, mr, live) = self.merge_request_of(&target.id).await?;
        forge
            .create_draft_reply(
                &live,
                &mr,
                &discussion,
                body(field(params, "text"), limits::BODY_CHARS)?,
            )
            .await
            .map_err(ReviewError::new)?;
        self.refresh_gitlab(&json!({"sessionId": target.id}))
            .await?;
        let state = self.0.lock();
        Ok(self
            .0
            .remote_thread(&state, &target.id, Some(&json!(remote.id)))
            .unwrap_or(remote))
    }

    pub(crate) async fn edit_remote(
        &self,
        target: &ReviewSession,
        remote: ReviewThread,
        params: &Value,
    ) -> ReviewResult<ReviewThread> {
        let comment_id = field(params, "commentId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let reply = remote
            .comments
            .iter()
            .find(|c| c.id == comment_id && c.gitlab_draft_id.is_some())
            .cloned();
        let draft_id = reply
            .as_ref()
            .and_then(|r| r.gitlab_draft_id)
            .or_else(|| remote.gitlab.as_ref().and_then(|g| g.draft_id));
        if author(field(params, "author"))? != REVIEW_USER || draft_id.is_none() {
            return Err(ReviewError::status(
                "only your own draft notes can be edited",
                403,
            ));
        }
        let (forge, mr, live) = self.merge_request_of(&target.id).await?;
        let updated = forge
            .update_draft_note(
                &live,
                &mr,
                draft_id.unwrap(),
                body(field(params, "text"), limits::BODY_CHARS)?,
            )
            .await
            .map_err(ReviewError::new)?;
        let mut state = self.0.lock();
        let entry = state.gitlab.entry(target.id.clone()).or_default();
        let result = if let Some(reply) = reply {
            let mut changed = remote.clone();
            for thread in entry.threads.iter_mut() {
                if thread.id == remote.id {
                    for comment in thread.comments.iter_mut() {
                        if comment.id == reply.id {
                            comment.body = updated
                                .comments
                                .first()
                                .map(|c| c.body.clone())
                                .unwrap_or_default();
                        }
                    }
                    changed = thread.clone();
                }
            }
            changed
        } else {
            for thread in entry.threads.iter_mut() {
                if thread.id == remote.id {
                    *thread = updated.clone();
                }
            }
            updated
        };
        if let Some(live) = state.sessions.get(&target.id).cloned() {
            self.0.publish_session(&state, &live);
        }
        Ok(result)
    }

    pub(crate) async fn delete_remote(
        &self,
        target: &ReviewSession,
        remote: ReviewThread,
        params: &Value,
    ) -> ReviewResult<Value> {
        let comment_id = field(params, "commentId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let reply = remote
            .comments
            .iter()
            .find(|c| c.id == comment_id && c.gitlab_draft_id.is_some())
            .cloned();
        let own_draft = remote.gitlab.as_ref().and_then(|g| g.draft_id);
        if author(field(params, "author"))? != REVIEW_USER
            || (reply.is_none() && own_draft.is_none())
        {
            return Err(ReviewError::status(
                "only your own draft notes can be deleted",
                403,
            ));
        }
        let (forge, mr, live) = self.merge_request_of(&target.id).await?;
        if let Some(reply) = reply {
            forge
                .delete_draft_note(&live, &mr, reply.gitlab_draft_id.unwrap())
                .await
                .map_err(ReviewError::new)?;
            let mut state = self.0.lock();
            let mut kept = remote.clone();
            if let Some(entry) = state.gitlab.get_mut(&target.id) {
                for thread in entry.threads.iter_mut() {
                    if thread.id == remote.id {
                        thread.comments.retain(|c| c.id != reply.id);
                        kept = thread.clone();
                    }
                }
            }
            if let Some(live) = state.sessions.get(&target.id).cloned() {
                self.0.publish_session(&state, &live);
            }
            return Ok(json!({"deleted": reply.id, "thread": kept}));
        }
        forge
            .delete_draft_note(&live, &mr, own_draft.unwrap())
            .await
            .map_err(ReviewError::new)?;
        let mut state = self.0.lock();
        if let Some(entry) = state.gitlab.get_mut(&target.id) {
            entry.threads.retain(|t| t.id != remote.id);
        }
        if let Some(live) = state.sessions.get(&target.id).cloned() {
            self.0.publish_session(&state, &live);
        }
        Ok(json!({"deleted": remote.id, "thread": null}))
    }

    /// Sends the review comments pending in a merge request's review to
    /// the forge as drafts (`review.gitlab.push`).
    pub async fn push_local_drafts(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let target = self.session_of(params)?;
        if !self.0.lock().gitlab_mode(&target, self.0.has_forge()) {
            return Err(ReviewError::new("this is not a merge request's review"));
        }
        let queue = self.0.queue(&format!("push:{}", target.id));
        let _turn = queue.lock().await;
        self.push_now(&target.id).await
    }

    async fn push_now(&self, id: &str) -> ReviewResult<ReviewSnapshot> {
        let inner = &self.0;
        let (forge, mr, target) = self.merge_request_of(id).await?;
        let linked = self.linked_reviews(&target, true).await;
        self.link_reviews(id, linked);
        self.adopt_summaries(id);
        let drafts: Vec<ReviewThread> = {
            let state = inner.lock();
            let mut all = state.thread_list(id);
            all.extend(state.pending_drafts(&target));
            all.into_iter().filter(|t| t.kind == "draft").collect()
        };
        let mut touched: Vec<String> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        for thread in drafts {
            let owner = thread.session_id.clone();
            let live = |state: &super::State| {
                state
                    .threads
                    .get(&owner)
                    .and_then(|m| m.get(&thread.id))
                    .filter(|t| t.inst == thread.inst)
                    .map(|t| {
                        t.comments
                            .iter()
                            .map(|c| c.body.as_str())
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
            };
            let Some(text) = live(&inner.lock()) else {
                continue;
            };
            let outcome: Result<bool, String> = async {
                if let Some(reply_to) = &thread.gitlab_reply_to {
                    let found = inner.lock().gitlab.get(id).is_some_and(|s| {
                        s.threads.iter().any(|r| {
                            r.gitlab.as_ref().and_then(|g| g.discussion_id.as_ref())
                                == Some(reply_to)
                        })
                    });
                    if !found {
                        return Err("the GitLab discussion a reply answers is gone".into());
                    }
                    let draft = forge
                        .create_draft_reply(&target, &mr, reply_to, text.clone())
                        .await?;
                    let current = live(&inner.lock());
                    if current.as_deref() != Some(text.as_str()) {
                        let _ = forge
                            .delete_draft_note(
                                &target,
                                &mr,
                                draft.gitlab_draft_id.unwrap_or_default(),
                            )
                            .await;
                        if current.is_some() {
                            return Err("a draft changed while it was sent".into());
                        }
                        return Ok(false);
                    }
                    let mut state = inner.lock();
                    if let Some(entry) = state.gitlab.get_mut(id) {
                        for remote in entry.threads.iter_mut() {
                            if remote
                                .gitlab
                                .as_ref()
                                .and_then(|g| g.discussion_id.as_ref())
                                == Some(reply_to)
                            {
                                remote.comments.push(draft.clone());
                                break;
                            }
                        }
                    }
                } else {
                    let (anchor, note) = Self::gitlab_note(&thread.anchor, &text);
                    let diff = self.anchor_diff(&target, &anchor).await;
                    let draft = forge
                        .create_draft_note(&target, &mr, anchor, note, diff)
                        .await?;
                    let current = live(&inner.lock());
                    if current.as_deref() != Some(text.as_str()) {
                        let draft_id = draft
                            .gitlab
                            .as_ref()
                            .and_then(|g| g.draft_id)
                            .unwrap_or_default();
                        let _ = forge.delete_draft_note(&target, &mr, draft_id).await;
                        if current.is_some() {
                            return Err("a draft changed while it was sent".into());
                        }
                        return Ok(false);
                    }
                    inner
                        .lock()
                        .gitlab
                        .entry(id.to_owned())
                        .or_default()
                        .threads
                        .push(draft);
                }
                Ok(true)
            }
            .await;
            match outcome {
                Ok(true) => {
                    let mut state = inner.lock();
                    state.threads_of(&owner).shift_remove(&thread.id);
                    inner.delete_thread_row(&thread.id);
                    if !touched.contains(&owner) {
                        touched.push(owner);
                    }
                }
                Ok(false) => {}
                Err(error) => failed.push(error),
            }
        }
        let unsent = inner
            .lock()
            .sessions
            .get(id)
            .is_some_and(ReviewSession::summary_unsent);
        if unsent && let Err(error) = self.sync_summary(id).await {
            failed.push(error.message);
        }
        {
            let mut state = inner.lock();
            for owner in &touched {
                if owner != id && state.sessions.contains_key(owner) {
                    inner.changed(&mut state, owner);
                }
            }
            if state.sessions.contains_key(id) {
                inner.changed(&mut state, id);
            }
        }
        if !failed.is_empty() {
            return Err(ReviewError::new(format!(
                "{} stayed here: {}",
                if failed.len() == 1 {
                    "A draft".to_owned()
                } else {
                    format!("{} drafts", failed.len())
                },
                failed[0]
            )));
        }
        let state = inner.lock();
        let live = state.sessions.get(id).cloned().unwrap_or(target);
        Ok(inner.snapshot_of(&state, &live))
    }

    /// "Make it mine": an agent's thread becomes the user's draft on the
    /// forge (`review.adopt`).
    pub async fn adopt_thread(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let inner = &self.0;
        let target = self.session_of(params)?;
        if author(field(params, "author"))? != REVIEW_USER {
            return Err(ReviewError::status(
                "only you can make a comment yours",
                403,
            ));
        }
        if !inner.lock().gitlab_mode(&target, inner.has_forge()) {
            return Err(ReviewError::new("this is not a merge request's review"));
        }
        let id = text(field(params, "threadId"), "thread", 200)?;
        let thread = {
            let state = inner.lock();
            let mut all = state.thread_list(&target.id);
            all.extend(state.pending_drafts(&target));
            all.extend(state.shared_local(&target, inner.has_forge()));
            all.into_iter().find(|t| t.id == id)
        };
        let Some(thread) = thread.filter(|t| t.kind != "merge-request") else {
            return Err(ReviewError::not_found("no such thread of an agent"));
        };
        let owner = thread.session_id.clone();
        let Some(theirs) = thread
            .comments
            .iter()
            .rev()
            .find(|c| c.author != REVIEW_USER)
        else {
            return Err(ReviewError::new("this thread has no agent comment"));
        };
        let wording = field(params, "text")
            .and_then(Value::as_str)
            .filter(|t| !crate::js::trim(t).is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| theirs.body.clone());
        self.add_thread(&json!({
            "sessionId": target.id,
            "kind": "draft",
            "author": REVIEW_USER,
            "anchor": serde_json::to_value(&thread.anchor).unwrap_or(Value::Null),
            "text": wording,
        }))
        .await?;
        let mut state = inner.lock();
        let owner = if state.sessions.contains_key(&owner) {
            owner
        } else {
            target.id.clone()
        };
        if thread.kind == "draft" {
            state.threads_of(&owner).shift_remove(&thread.id);
            inner.delete_thread_row(&thread.id);
        } else if let Some(live) = state
            .threads
            .get_mut(&owner)
            .and_then(|m| m.get_mut(&thread.id))
        {
            live.resolved = true;
            live.updated_at = inner.now();
            let live = live.clone();
            let _ = inner.save_thread(&live);
        }
        if owner != target.id {
            inner.changed(&mut state, &owner);
        }
        inner.changed(&mut state, &target.id);
        let live = state.sessions[&target.id].clone();
        Ok(inner.snapshot_of(&state, &live))
    }
}

#[allow(dead_code)]
fn unused(_: GitlabState) {}
