//! Threads and comments: written, answered, edited, deleted, resolved,
//! held and released, moved between reviews, restored (review/service.ts).

use serde_json::{Map, Value, json};

use super::{ReviewService, State, field, locate_in};
use crate::error::{ReviewError, ReviewResult};
use crate::model::{
    REVIEW_USER, ReviewAnchor, ReviewComment, ReviewMessagePart, ReviewSession, ReviewSnapshot,
    ReviewThread, ReviewWorkPart, limits,
};
use crate::parse::{
    self, author, body, body_limit, client_id, held_place, is_gitlab_target, iso_time,
    message_quote, optional_text, parse_anchor, parse_merge_request_url, parse_review_target, text,
};

impl ReviewService {
    /// The thread that already has a client's id, when it is in `session_id`;
    /// an id taken anywhere else is refused.
    fn written_before(
        state: &State,
        session_id: &str,
        id: &str,
    ) -> ReviewResult<Option<ReviewThread>> {
        for (owner, map) in &state.threads {
            for thread in map.values() {
                if thread.id != id && !thread.comments.iter().any(|c| c.id == id) {
                    continue;
                }
                if owner == session_id {
                    return Ok(Some(thread.clone()));
                }
                return Err(ReviewError::status(format!("id {id} is already used"), 409));
            }
        }
        Ok(None)
    }

    /// A new thread (`addThread`).
    pub async fn add_thread(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let asked = self.session_of(params)?;
        let part = field(params, "anchor")
            .and_then(|anchor| anchor.get("message"))
            .and_then(|message| message.get("thread"))
            .cloned();
        let target = match &part {
            Some(part) => inner.owner_of(&inner.lock(), &asked, Some(part))?,
            None => asked,
        };
        let kind = if field(params, "kind").and_then(Value::as_str) == Some("draft") {
            "draft"
        } else {
            "discussion"
        };
        let writer = author(field(params, "author"))?;
        self.allow_agent(&target.id, &writer).await?;
        let gitlab_mode = inner.lock().gitlab_mode(&target, inner.has_forge());
        if kind == "draft" && gitlab_mode && writer == REVIEW_USER {
            let anchor = parse_anchor(field(params, "anchor"))?;
            let note_body = body(field(params, "text"), limits::BODY_CHARS)?;
            return self.add_gitlab_draft(&target, anchor, note_body).await;
        }
        let thread_id = client_id(field(params, "newThreadId"), "new_thread_id")?;
        let mut state = inner.lock();
        if let Some(id) = &thread_id
            && let Some(before) = Self::written_before(&state, &target.id, id)?
        {
            return Ok(before);
        }
        if state.threads.get(&target.id).map_or(0, |m| m.len()) >= limits::THREADS_PER_SESSION {
            return Err(ReviewError::new("too many comments in this review"));
        }
        let at = inner.now();
        let anchor = parse_anchor(field(params, "anchor"))?;
        let comment_body = body(field(params, "text"), body_limit(&anchor, true))?;
        let thread = ReviewThread {
            id: thread_id.unwrap_or_else(parse::new_id),
            session_id: target.id.clone(),
            kind: kind.into(),
            anchor,
            comments: vec![ReviewComment::new(
                parse::new_id(),
                writer.clone(),
                comment_body,
                &at,
            )],
            resolved: false,
            created_at: at.clone(),
            updated_at: at,
            held: held_place(field(params, "held")),
            gitlab: None,
            gitlab_reply_to: None,
            pending_for: None,
            handed_at: None,
            extra: Map::new(),
            inst: 0,
        };
        let thread = inner.save_thread_in(&mut state, &target.id, thread)?;
        let follows = state
            .sessions
            .get(&target.id)
            .is_some_and(|session| Self::follows_file(session, &thread, None));
        let for_agent = Self::for_agent(&thread, &target);
        drop(state);
        if follows {
            self.spawn_reanchor_file_asked(target.id.clone(), thread.anchor.path.clone());
        }
        if kind == "draft" {
            self.note_pending_for(&target.id, &thread.id);
        }
        if for_agent && writer == REVIEW_USER {
            self.schedule_delivery(&target.id);
        }
        Ok(thread)
    }

    pub(crate) fn session_of(&self, params: &Value) -> ReviewResult<ReviewSession> {
        self.0.lock().session(field(params, "sessionId"))
    }

    /// An answer in a thread (`reply`).
    pub async fn reply(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let target = self.session_of(params)?;
        let remote = inner.remote_thread(&inner.lock(), &target.id, field(params, "commentId"));
        if let Some(remote) = remote {
            return self.reply_remote(&target, remote, params).await;
        }
        let writer = author(field(params, "author"))?;
        self.allow_agent(&target.id, &writer).await?;
        let owner = inner.owner_of(&inner.lock(), &target, field(params, "commentId"))?;
        self.reply_here(&owner, params)
    }

    pub(crate) fn reply_here(
        &self,
        target: &ReviewSession,
        params: &Value,
    ) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let located = locate_in(
            state
                .threads
                .get(&target.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let comment_id = client_id(field(params, "newCommentId"), "new_comment_id")?;
        if let Some(id) = &comment_id
            && let Some(before) = Self::written_before(&state, &target.id, id)?
        {
            if before.id == located.thread_id {
                return Ok(before);
            }
            return Err(ReviewError::status(format!("id {id} is already used"), 409));
        }
        let mut thread = state.threads[&target.id][&located.thread_id].clone();
        if thread.comments.len() >= limits::COMMENTS_PER_THREAD {
            return Err(ReviewError::new("this thread is too long"));
        }
        let writer = author(field(params, "author"))?;
        if writer != REVIEW_USER
            && let Some(last) = thread.comments.last()
            && last.author == writer
        {
            let short = crate::js::head16(&last.id, 8);
            return Err(ReviewError::status(
                format!(
                    "the last comment of this thread is yours: correct it with review_edit (comment_id: {short}; the review client: edit --comment {short} -- TEXT)"
                ),
                409,
            ));
        }
        let text_body = body(field(params, "text"), limits::BODY_CHARS)?;
        let at = inner.now();
        thread.comments.push(ReviewComment::new(
            comment_id.unwrap_or_else(parse::new_id),
            writer.clone(),
            text_body,
            &at,
        ));
        if writer == REVIEW_USER {
            thread.resolved = false;
        }
        if writer != REVIEW_USER
            && let Some(session) = state.sessions.get_mut(&target.id)
            && session
                .agent
                .working
                .as_ref()
                .and_then(|w| w.thread_id.as_deref())
                == Some(thread.id.as_str())
        {
            session.agent.working = None;
        }
        let thread = inner.save_thread_in(&mut state, &target.id, thread)?;
        let session = state.sessions.get(&target.id).cloned();
        drop(state);
        if writer == REVIEW_USER && session.is_some_and(|s| Self::for_agent(&thread, &s)) {
            self.schedule_delivery(&target.id);
        }
        Ok(thread)
    }

    /// A comment rewritten (`edit`).
    pub async fn edit(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let target = self.session_of(params)?;
        let remote = inner.remote_thread(&inner.lock(), &target.id, field(params, "commentId"));
        if let Some(remote) = remote {
            return self.edit_remote(&target, remote, params).await;
        }
        let owner = inner.owner_of(&inner.lock(), &target, field(params, "commentId"))?;
        self.edit_here(&owner, params)
    }

    fn edit_here(&self, target: &ReviewSession, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let located = locate_in(
            state
                .threads
                .get(&target.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let mut thread = state.threads[&target.id][&located.thread_id].clone();
        let writer = author(field(params, "author"))?;
        let comment = &thread.comments[located.index];
        if writer != REVIEW_USER && comment.author != writer {
            return Err(ReviewError::status(
                "an agent can only edit its own comments",
                403,
            ));
        }
        let next = body(
            field(params, "text"),
            body_limit(&thread.anchor, located.index == 0),
        )?;
        if next != comment.body {
            let at = inner.now();
            let comment = &mut thread.comments[located.index];
            comment.body = next;
            comment.updated_at = at;
            if writer == REVIEW_USER {
                comment.author = REVIEW_USER.into();
            }
        }
        let thread = inner.save_thread_in(&mut state, &target.id, thread)?;
        let session = state.sessions.get(&target.id).cloned();
        drop(state);
        if writer == REVIEW_USER && session.is_some_and(|s| Self::for_agent(&thread, &s)) {
            self.schedule_delivery(&target.id);
        }
        Ok(thread)
    }

    /// A comment deleted; the first one deletes its thread
    /// (`deleteComment`): `{deleted, thread}`.
    pub async fn delete_comment(&self, params: &Value) -> ReviewResult<Value> {
        let inner = &self.0;
        let target = self.session_of(params)?;
        let remote = inner.remote_thread(&inner.lock(), &target.id, field(params, "commentId"));
        if let Some(remote) = remote {
            return self.delete_remote(&target, remote, params).await;
        }
        let owner = inner.owner_of(&inner.lock(), &target, field(params, "commentId"))?;
        let mut state = inner.lock();
        let located = locate_in(
            state
                .threads
                .get(&owner.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let mut thread = state.threads[&owner.id][&located.thread_id].clone();
        let writer = author(field(params, "author"))?;
        if writer != REVIEW_USER && thread.comments[located.index].author != writer {
            return Err(ReviewError::status(
                "an agent can only delete its own comments",
                403,
            ));
        }
        if located.index == 0 {
            state.threads_of(&owner.id).shift_remove(&thread.id);
            inner.delete_thread_row(&thread.id);
            inner.changed(&mut state, &owner.id);
            return Ok(json!({"deleted": thread.id, "thread": null}));
        }
        let removed = thread.comments.remove(located.index);
        let thread = inner.save_thread_in(&mut state, &owner.id, thread)?;
        Ok(json!({"deleted": removed.id, "thread": thread}))
    }

    /// A thread resolved or reopened (`resolve`).
    pub fn resolve(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let target = state.session(field(params, "sessionId"))?;
        if inner
            .remote_thread(&state, &target.id, field(params, "commentId"))
            .is_some()
        {
            return Err(ReviewError::new("resolve merge request threads on GitLab"));
        }
        let owner = inner.owner_of(&state, &target, field(params, "commentId"))?;
        let located = locate_in(
            state
                .threads
                .get(&owner.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let mut thread = state.threads[&owner.id][&located.thread_id].clone();
        thread.resolved = field(params, "resolved") != Some(&Value::Bool(false));
        inner.save_thread_in(&mut state, &owner.id, thread)
    }

    /// Moves a held comment among the workspace's comments to send.
    pub fn move_held(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let asked = state.session(field(params, "sessionId"))?;
        let target = inner.owner_of(&state, &asked, field(params, "commentId"))?;
        let located = locate_in(
            state
                .threads
                .get(&target.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let mut thread = state.threads[&target.id][&located.thread_id].clone();
        let place = held_place(field(params, "held"));
        let (Some(_), Some(place)) = (thread.held, place) else {
            return Err(ReviewError::new("that comment is not held"));
        };
        thread.held = Some(place);
        inner.save_thread_in(&mut state, &target.id, thread)
    }

    /// Held comments the user handed over (`releaseHeld`).
    pub fn release_held(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let asked = state.session(field(params, "sessionId"))?;
        let target = inner.owner_of(&state, &asked, field(params, "commentId"))?;
        let located = locate_in(
            state
                .threads
                .get(&target.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let mut thread = state.threads[&target.id][&located.thread_id].clone();
        if thread.held.is_none() {
            return Ok(thread);
        }
        thread.held = None;
        let handed = field(params, "handed") == Some(&Value::Bool(true));
        if handed {
            thread.handed_at = Some(inner.now());
        }
        let thread = inner.save_thread_in(&mut state, &target.id, thread)?;
        let session = state.sessions.get(&target.id).cloned();
        drop(state);
        if !handed && session.is_some_and(|s| Self::for_agent(&thread, &s)) {
            self.schedule_delivery(&target.id);
        }
        Ok(thread)
    }

    /// Whether a thread id is used in another review.
    fn used_elsewhere(state: &State, id: &str, session_id: &str) -> bool {
        state
            .threads
            .iter()
            .any(|(owner, map)| owner != session_id && map.contains_key(id))
    }

    /// A thread as the browser sent it back, rebuilt field by field.
    fn thread_from(
        &self,
        state: &State,
        target: &ReviewSession,
        value: Option<&Value>,
    ) -> ReviewResult<ReviewThread> {
        let raw = value
            .and_then(Value::as_object)
            .filter(|raw| raw.get("comments").is_some_and(Value::is_array))
            .ok_or_else(|| ReviewError::new("thread is required"))?;
        let now = self.0.now();
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| parse::is_id(id) && !Self::used_elsewhere(state, id, &target.id))
            .map(str::to_owned)
            .unwrap_or_else(parse::new_id);
        let mut comments = Vec::new();
        for comment in raw["comments"]
            .as_array()
            .unwrap()
            .iter()
            .take(limits::COMMENTS_PER_THREAD)
        {
            let comment_id = comment
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| parse::is_id(id))
                .map(str::to_owned)
                .unwrap_or_else(parse::new_id);
            let mut built = ReviewComment::new(
                comment_id,
                author(comment.get("author"))?,
                body(comment.get("body"), limits::BODY_CHARS)?,
                &iso_time(comment.get("createdAt")).unwrap_or_else(|| now.clone()),
            );
            built.updated_at = now.clone();
            comments.push(built);
        }
        let reply_to = raw
            .get("gitlabReplyTo")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
            .map(str::to_owned);
        let pending = raw
            .get("pendingFor")
            .and_then(Value::as_str)
            .filter(|url| parse_merge_request_url(url).is_some())
            .map(str::to_owned);
        let restored = ReviewThread {
            id,
            session_id: target.id.clone(),
            kind: if raw.get("kind").and_then(Value::as_str) == Some("draft") {
                "draft".into()
            } else {
                "discussion".into()
            },
            anchor: parse_anchor(raw.get("anchor"))?,
            comments,
            resolved: raw.get("resolved") == Some(&Value::Bool(true)),
            created_at: iso_time(raw.get("createdAt")).unwrap_or_else(|| now.clone()),
            updated_at: now,
            held: held_place(raw.get("held")),
            gitlab: None,
            gitlab_reply_to: reply_to,
            pending_for: pending,
            handed_at: iso_time(raw.get("handedAt")),
            extra: Map::new(),
            inst: 0,
        };
        if restored.comments.is_empty() {
            return Err(ReviewError::new("thread is empty"));
        }
        Ok(restored)
    }

    /// Puts back a deleted thread (the overlay's one-level undo).
    pub fn restore_thread(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let raw = field(params, "thread")
            .filter(|raw| raw.get("comments").is_some_and(Value::is_array))
            .ok_or_else(|| ReviewError::new("thread is required"))?;
        let inner = &self.0;
        let mut state = inner.lock();
        let asked = state.session(field(params, "sessionId"))?;
        let raw_session = raw.get("sessionId").and_then(Value::as_str);
        let mut candidates = state.local_reviews_of(&asked);
        candidates.extend(state.linked_of(&asked));
        let target = candidates
            .iter()
            .find(|id| Some(id.as_str()) == raw_session)
            .and_then(|id| state.sessions.get(id).cloned())
            .unwrap_or(asked);
        let restored = self.thread_from(&state, &target, Some(raw))?;
        let map_len = state.threads.get(&target.id).map_or(0, |m| m.len());
        let has = state
            .threads
            .get(&target.id)
            .is_some_and(|m| m.contains_key(&restored.id));
        if !has && map_len >= limits::THREADS_PER_SESSION {
            return Err(ReviewError::new("too many comments in this review"));
        }
        inner.save_thread_in(&mut state, &target.id, restored)
    }

    /// The agent says what it is doing (`agentStatus`).
    pub fn agent_status(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let inner = &self.0;
        let mut state = inner.lock();
        let target = state.session(field(params, "sessionId"))?;
        let name = parse::parse_agent_name(field(params, "agent"))?;
        let pane = optional_text(field(params, "paneId"), "pane", 200)?;
        let message = optional_text(field(params, "message"), "message", limits::MESSAGE_CHARS)?;
        let state_name = field(params, "state").and_then(Value::as_str).unwrap_or("");
        let thread_id = if state_name == "working"
            && field(params, "commentId").is_some_and(|v| !v.is_null() && v != "")
        {
            Some(
                locate_in(
                    state
                        .threads
                        .get(&target.id)
                        .into_iter()
                        .flat_map(|m| m.values()),
                    field(params, "commentId"),
                )?
                .thread_id,
            )
        } else {
            None
        };
        if !matches!(state_name, "working" | "done" | "update") {
            return Err(ReviewError::new("invalid agent state"));
        }
        if let Some(name) = name
            && let Some(session) = state.sessions.get_mut(&target.id)
        {
            session.agent.name = Some(name);
        }
        if let Some(pane) = pane {
            self.bind_pane(&mut state, &target.id, &pane);
        }
        let at = inner.now();
        if let Some(thread) = &thread_id {
            state.taken.insert(thread.clone(), at.clone());
        }
        if let Some(session) = state.sessions.get_mut(&target.id) {
            match state_name {
                "working" => {
                    session.agent.working = Some(crate::model::ReviewWorking {
                        at,
                        message,
                        thread_id,
                    })
                }
                "done" => {
                    session.agent.working = None;
                    if let Some(message) = message {
                        session.agent.update = Some(crate::model::ReviewUpdate {
                            at,
                            message: Some(message),
                        });
                    }
                }
                _ => {
                    session.agent.working = None;
                    session.agent.update = Some(crate::model::ReviewUpdate { at, message });
                }
            }
        }
        inner.changed(&mut state, &target.id);
        let snapshot = inner.snapshot_of(&state, &state.sessions[&target.id]);
        drop(state);
        if state_name != "working" {
            self.spawn_reanchor_file_asked(target.id.clone(), None);
        }
        Ok(snapshot)
    }

    /// A thread becomes another review's (`moveThread`).
    pub fn move_thread(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let target = state.session(field(params, "sessionId"))?;
        let id = text(field(params, "threadId"), "thread", 200)?;
        let mut found: Option<ReviewThread> = None;
        for map in state.threads.values() {
            found = map
                .get(&id)
                .or_else(|| map.values().find(|t| t.id.starts_with(id.as_str())))
                .cloned();
            if found.is_some() {
                break;
            }
        }
        let Some(mut found) = found.filter(|t| t.kind != "merge-request") else {
            return Err(ReviewError::not_found("no such thread"));
        };
        if found
            .gitlab
            .as_ref()
            .is_some_and(|g| g.discussion_id.is_some() || g.draft_id.is_some())
        {
            return Err(ReviewError::new("a forge thread stays in its review"));
        }
        if found.session_id == target.id {
            return Ok(found);
        }
        let anchor = parse_anchor(field(params, "anchor"))?;
        let from = found.session_id.clone();
        let at = inner.now();
        state.threads_of(&from).shift_remove(&found.id);
        found.session_id = target.id.clone();
        found.anchor = anchor;
        found.pending_for = None;
        found.held = None;
        found.handed_at = Some(at.clone());
        found.updated_at = at.clone();
        state
            .threads_of(&target.id)
            .insert(found.id.clone(), found.clone());
        inner.delete_thread_row(&found.id);
        inner.save_thread(&found)?;
        if let Some(session) = state.sessions.get_mut(&target.id)
            && session.delivered_at.is_none()
        {
            session.delivered_at = Some(at);
            let session = session.clone();
            inner.save_session(&session);
        }
        if state.sessions.contains_key(&from) {
            inner.changed(&mut state, &from);
        }
        inner.changed(&mut state, &target.id);
        Ok(found)
    }

    /// A thread's anchor replaced in its own review.
    pub fn set_thread_anchor(&self, params: &Value) -> ReviewResult<ReviewThread> {
        let inner = &self.0;
        let mut state = inner.lock();
        let target = state.session(field(params, "sessionId"))?;
        let id = text(field(params, "threadId"), "thread", 200)?;
        let Some(mut thread) = state
            .threads
            .get(&target.id)
            .and_then(|m| m.get(&id))
            .filter(|t| t.kind != "merge-request")
            .cloned()
        else {
            return Err(ReviewError::not_found("no such thread"));
        };
        thread.anchor = parse_anchor(field(params, "anchor"))?;
        inner.save_thread_in(&mut state, &target.id, thread)
    }

    /// Where a thread on a part of a comment goes (`messagePartAnchor`).
    pub fn message_part_anchor(&self, params: &Value) -> ReviewResult<ReviewAnchor> {
        let state = self.0.lock();
        let target = state.session(field(params, "sessionId"))?;
        let located = locate_in(
            state
                .threads
                .get(&target.id)
                .into_iter()
                .flat_map(|m| m.values()),
            field(params, "commentId"),
        )?;
        let thread = &state.threads[&target.id][&located.thread_id];
        if thread.kind == "merge-request" {
            return Err(ReviewError::new(
                "a merge request's comment has no parts here",
            ));
        }
        let quote = message_quote(
            &thread.comments[located.index].body,
            &text(field(params, "quote"), "quote", 4000)?,
        )?;
        let mut anchor = thread.anchor.clone();
        anchor.message = None;
        anchor.feedback = None;
        if let Some(work) = &anchor.work {
            anchor.work = Some(ReviewWorkPart {
                item: work.item.clone(),
                from: None,
                quote: None,
                description: false,
                triage: false,
            });
        }
        anchor.message = Some(ReviewMessagePart {
            thread: thread.id.clone(),
            comment: located.comment_id,
            quote: Some(quote),
        });
        Ok(anchor)
    }

    /// An answer in a thread of a chat, by its comment (`replyInChat`).
    pub fn reply_in_chat(
        &self,
        chat: &str,
        comment_id: &str,
        text_body: &str,
        writer: &str,
    ) -> ReviewResult<ReviewThread> {
        let target = {
            let state = self.0.lock();
            let owners: Vec<ReviewSession> = state
                .sessions
                .values()
                .filter(|candidate| {
                    matches!(&candidate.target, crate::model::ReviewTarget::Chat { chat: c } if c == chat)
                        && locate_in(
                            state.threads.get(&candidate.id).into_iter().flat_map(|m| m.values()),
                            Some(&json!(comment_id)),
                        )
                        .is_ok()
                })
                .cloned()
                .collect();
            if owners.len() != 1 {
                return Err(if owners.is_empty() {
                    ReviewError::not_found("no such comment in this chat")
                } else {
                    ReviewError::new("ambiguous comment id")
                });
            }
            let target = owners[0].clone();
            self.0
                .assert_agent_allowed(&state, &target, &author(Some(&json!(writer)))?)?;
            target
        };
        self.reply_here(
            &target,
            &json!({"commentId": comment_id, "text": text_body, "author": writer}),
        )
    }

    /// Brings back a discarded review (`importSession`).
    pub fn import_session(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let inner = &self.0;
        let connection_id = text(field(params, "connectionId"), "connection", 200)?;
        let raw = field(params, "snapshot");
        let raw_session = raw
            .and_then(|raw| raw.get("session"))
            .and_then(Value::as_object)
            .filter(|s| {
                s.get("connectionId").and_then(Value::as_str) == Some(connection_id.as_str())
            })
            .ok_or_else(|| ReviewError::new("snapshot is required"))?;
        let id = raw_session
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| parse::is_id(id))
            .ok_or_else(|| ReviewError::new("invalid review id"))?
            .to_owned();
        let mut state = inner.lock();
        if let Some(existing) = state.sessions.get(&id) {
            if existing.connection_id != connection_id {
                return Err(ReviewError::new("invalid review id"));
            }
            return Ok(inner.snapshot_of(&state, existing));
        }
        inner.check_room(&state, None)?;
        let raw_threads: Vec<&Value> = raw
            .and_then(|raw| raw.get("threads"))
            .and_then(Value::as_array)
            .map(|threads| {
                threads
                    .iter()
                    .filter(|t| {
                        t.is_object()
                            && t.get("sessionId").and_then(Value::as_str) == Some(id.as_str())
                            && t.get("gitlab").is_none()
                    })
                    .collect()
            })
            .unwrap_or_default();
        if raw_threads.len() > limits::THREADS_PER_SESSION {
            return Err(ReviewError::new("too many comments in this review"));
        }
        let target = parse_review_target(raw_session.get("target"))?;
        let at = inner.now();
        let root = text(raw_session.get("root"), "root", 4096)?;
        let title = text(raw_session.get("title"), "title", limits::TITLE_CHARS)?;
        let summary = text(
            Some(raw_session.get("summary").unwrap_or(&json!(""))),
            "summary",
            limits::SUMMARY_CHARS,
        )?;
        if !parse::is_host_path(&root) {
            return Err(ReviewError::new("invalid root"));
        }
        let mut restored = ReviewSession {
            id: id.clone(),
            connection_id: connection_id.clone(),
            workspace_id: optional_text(raw_session.get("workspaceId"), "workspace", 200)?,
            root,
            title,
            gitlab: is_gitlab_target(&target),
            target,
            automatic_base: None,
            auto_send: raw_session.get("autoSend").and_then(Value::as_bool),
            summary,
            agent: Default::default(),
            created_at: iso_time(raw_session.get("createdAt")).unwrap_or_else(|| at.clone()),
            updated_at: at,
            summary_unsent: None,
            summary_sent: None,
            handoff_at: None,
            seen_head_sha: None,
            hold_comments: (raw_session.get("holdComments") == Some(&Value::Bool(true)))
                .then_some(true),
            delivered_at: None,
            delivery_error: None,
            reviewed: None,
            extra: Map::new(),
            inst: 0,
        };
        if let Some(agent) = raw_session.get("agent").and_then(Value::as_object) {
            if let Some(name) = agent.get("name").and_then(Value::as_str)
                && parse::agent_name_ok(name)
                && name.to_lowercase() != REVIEW_USER
            {
                restored.agent.name = Some(name.to_owned());
            }
            restored.agent.pane_id = optional_text(agent.get("paneId"), "pane", 200)?;
        }
        if raw_session.contains_key("reviewed") {
            restored.reviewed = Some(Self::reviewed_after_pub(
                &restored,
                raw_session.get("reviewed"),
            )?);
        }
        let mut threads = Vec::new();
        for thread in raw_threads {
            threads.push(self.thread_from(&state, &restored, Some(thread))?);
        }
        state.set_session(restored.clone());
        let mut map = indexmap::IndexMap::new();
        for mut thread in threads {
            thread.inst = state.next();
            map.insert(thread.id.clone(), thread);
        }
        inner.save_session(&state.sessions[&id]);
        for thread in map.values() {
            inner.save_thread(thread)?;
        }
        state.threads.insert(id.clone(), map);
        inner.changed(&mut state, &id);
        Ok(inner.snapshot_of(&state, &state.sessions[&id]))
    }

    pub(crate) fn reviewed_after_pub(
        target: &ReviewSession,
        changes: Option<&Value>,
    ) -> ReviewResult<indexmap::IndexMap<String, String>> {
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

    /// The review's agent is in this pane (`bindPane`).
    pub(crate) fn bind_pane(&self, state: &mut State, id: &str, pane: &str) {
        let Some(session) = state.sessions.get_mut(id) else {
            return;
        };
        if session.agent.pane_id.as_deref() != Some(pane) {
            session.agent.session_id = None;
        }
        session.agent.pane_id = Some(pane.to_owned());
        if session.agent.session_id.is_none() {
            let this = self.clone();
            let id = id.to_owned();
            let pane = pane.to_owned();
            tokio::spawn(async move { this.record_session(&id, &pane).await });
        }
    }

    /// The agent session in the pane, recorded once read.
    pub(crate) async fn record_session(&self, id: &str, pane: &str) {
        let inner = &self.0;
        let (connection, inst) = {
            let state = inner.lock();
            let Some(target) = state.sessions.get(id) else {
                return;
            };
            if matches!(
                target.target,
                crate::model::ReviewTarget::Chat { .. }
                    | crate::model::ReviewTarget::Effort { .. }
                    | crate::model::ReviewTarget::Work { .. }
            ) {
                return;
            }
            (target.connection_id.clone(), target.inst)
        };
        let Some(ask) = inner.host.pane_session(&connection, pane) else {
            return;
        };
        let Ok(Some(session_id)) = ask.await else {
            return;
        };
        let mut state = inner.lock();
        if !state.live(id, inst) {
            return;
        }
        let Some(target) = state.sessions.get_mut(id) else {
            return;
        };
        if target.agent.pane_id.as_deref() != Some(pane)
            || target.agent.session_id.as_deref() == Some(session_id.as_str())
        {
            return;
        }
        target.agent.session_id = Some(session_id);
        let target = target.clone();
        inner.save_session(&target);
    }
}
