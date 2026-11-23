//! Threads placed again when what they are on moved: Changes' entry
//! anchors onto the combined diff, threads on files onto the file as it
//! reads now, threads of rewritten commits onto what they became
//! (review/service.ts). Each runs in the background, one pass per review
//! at a time; tests await the pass.

use std::collections::HashSet;

use futures_util::FutureExt;
use indexmap::IndexMap;
use serde_json::Value;

use super::{BoxFut, ReviewService, SharedTask, field, rendered_file};
use crate::anchors::changes::{combined_anchor, entry_anchored};
use crate::anchors::commit::{
    CommitMove, line_in_file, moved_anchor, rewritten_commit, rewritten_out,
};
use crate::anchors::file::{anchor_in_file, anchored_in_file, written_in_file};
use crate::diff::{ReviewDiff, ReviewDiffFile};
use crate::error::ReviewResult;
use crate::model::{ReviewCommit, ReviewSession, ReviewSnapshot, ReviewTarget, ReviewThread};

const FILE_REANCHOR_EVERY_MS: i64 = 30_000;

fn diff_of(value: Value) -> Option<ReviewDiff> {
    serde_json::from_value(value).ok()
}

impl ReviewService {
    /// The reviews whose threads on files follow the files.
    pub(crate) fn follows_files(target: &ReviewSession) -> bool {
        rendered_file(target).is_some()
            || matches!(
                target.target,
                ReviewTarget::Worktree | ReviewTarget::Range { compare: false, .. }
            )
    }

    /// A thread of the review that follows its file, on `path` when given.
    pub(crate) fn follows_file(
        target: &ReviewSession,
        thread: &ReviewThread,
        path: Option<&str>,
    ) -> bool {
        let anchor = &thread.anchor;
        let Some(own) = anchor.path.as_deref().filter(|p| !p.is_empty()) else {
            return false;
        };
        if path.is_some_and(|path| path != own) {
            return false;
        }
        let on = match rendered_file(target) {
            Some(rendered) => own == rendered,
            None => written_in_file(anchor),
        };
        on && anchored_in_file(anchor)
    }

    pub(crate) fn spawn_migrate(&self, id: String) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let task = self.migrate_task(&id);
        tokio::spawn(task);
    }

    /// The review's Changes anchors moved onto the combined diff
    /// (migrateEntryAnchors); tests await it.
    pub async fn migrate_entry_anchors(&self, params: &Value) -> ReviewResult<()> {
        let target = self.session_of(params)?;
        self.migrate_task(&target.id).await;
        Ok(())
    }

    fn migrate_task(&self, id: &str) -> SharedTask {
        let inner = &self.0;
        let mut state = inner.lock();
        let ready: SharedTask = (Box::pin(async {}) as BoxFut<()>).shared();
        let Some(target) = state.sessions.get(id).cloned() else {
            return ready;
        };
        if !matches!(target.target, ReviewTarget::Worktree) {
            return ready;
        }
        if let Some(running) = state.migrating.get(id).cloned() {
            state.migrate_again.insert(id.to_owned());
            return running;
        }
        if state.migration_retry_at.get(id).copied().unwrap_or(0) > inner.ms() {
            return ready;
        }
        let todo: Vec<ReviewThread> = state
            .thread_list(id)
            .into_iter()
            .filter(|t| !state.migration_tried.contains(&t.id) && entry_anchored(t))
            .collect();
        if todo.is_empty() {
            return ready;
        }
        let mut paths: Vec<String> = Vec::new();
        for thread in &todo {
            let path = thread.anchor.path.clone().unwrap_or_default();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        let this = self.clone();
        let key = id.to_owned();
        let task: BoxFut<()> = Box::pin(async move {
            let load = this.0.host.load_diff(&target, None, Some(paths));
            let diff = this
                .from_checkout(&target, load)
                .await
                .ok()
                .and_then(diff_of);
            {
                let inner = &this.0;
                let mut state = inner.lock();
                match diff {
                    None => {
                        let at = inner.ms() + 5_000;
                        state.migration_retry_at.insert(key.clone(), at);
                    }
                    Some(diff) => {
                        state.migration_retry_at.remove(&key);
                        for thread in &todo {
                            state.migration_tried.insert(thread.id.clone());
                        }
                        if state.live(&key, target.inst) {
                            let mut moved = false;
                            for thread in &todo {
                                let current =
                                    state.threads.get(&key).and_then(|m| m.get(&thread.id));
                                if current.is_none_or(|c| c.inst != thread.inst)
                                    || !entry_anchored(thread)
                                {
                                    continue;
                                }
                                let file = diff
                                    .files
                                    .iter()
                                    .find(|f| Some(&f.path) == thread.anchor.path.as_ref());
                                let Some(anchor) = combined_anchor(thread, file) else {
                                    continue;
                                };
                                let live = state.threads_of(&key).get_mut(&thread.id).unwrap();
                                live.anchor = anchor;
                                let live = live.clone();
                                let _ = inner.save_thread(&live);
                                moved = true;
                            }
                            if moved && let Some(session) = state.sessions.get(&key).cloned() {
                                inner.publish_session(&state, &session);
                            }
                        }
                    }
                }
                state.migrating.remove(&key);
            }
            let again = this.0.lock().migrate_again.remove(&key);
            if again {
                this.migrate_task(&key).await;
            }
        });
        let shared = task.shared();
        state.migrating.insert(id.to_owned(), shared.clone());
        shared
    }

    pub(crate) fn spawn_reanchor_file(&self, id: String) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        tokio::spawn(self.reanchor_file_task(&id, false, None));
    }

    pub(crate) fn spawn_reanchor_file_asked(&self, id: String, path: Option<String>) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        tokio::spawn(self.reanchor_file_task(&id, true, path));
    }

    /// The review's threads on its files placed again (`reanchorFile`):
    /// the review after.
    pub async fn reanchor_file(&self, params: &Value) -> ReviewResult<ReviewSnapshot> {
        let target = self.session_of(params)?;
        let path = crate::parse::optional_text(field(params, "path"), "path", 4096)?;
        self.reanchor_file_task(&target.id, true, path).await;
        let state = self.0.lock();
        let live = state.sessions.get(&target.id).cloned().unwrap_or(target);
        Ok(self.0.snapshot_of(&state, &live))
    }

    fn reanchor_file_task(&self, id: &str, asked: bool, path: Option<String>) -> SharedTask {
        let inner = &self.0;
        let ready: SharedTask = (Box::pin(async {}) as BoxFut<()>).shared();
        let mut state = inner.lock();
        let Some(target) = state.sessions.get(id).cloned() else {
            return ready;
        };
        if !Self::follows_files(&target)
            || inner
                .host
                .load_file(&target, String::new(), String::new())
                .is_none()
        {
            return ready;
        }
        if let Some(running) = state.reanchoring_file.get(id).cloned() {
            if asked {
                state.reanchor_file_again.insert(id.to_owned());
            }
            return running;
        }
        if !asked && state.file_read_at.get(id).copied().unwrap_or(0) > inner.ms() {
            return ready;
        }
        let mut by_path: IndexMap<String, Vec<ReviewThread>> = IndexMap::new();
        for thread in state.thread_list(id) {
            if Self::follows_file(&target, &thread, path.as_deref()) {
                by_path
                    .entry(thread.anchor.path.clone().unwrap_or_default())
                    .or_default()
                    .push(thread);
            }
        }
        if by_path.is_empty() {
            return ready;
        }
        if path.is_none() {
            let at = inner.ms() + FILE_REANCHOR_EVERY_MS;
            state.file_read_at.insert(id.to_owned(), at);
        }
        let this = self.clone();
        let key = id.to_owned();
        let task: BoxFut<()> = Box::pin(async move {
            let mut moved = false;
            let mut stopped = false;
            for (file, todo) in by_path {
                let Some(load) = this.0.host.load_file(&target, String::new(), file) else {
                    continue;
                };
                let text = this.from_checkout(&target, load).await.ok();
                let inner = &this.0;
                let mut state = inner.lock();
                if !state.live(&key, target.inst) {
                    stopped = true;
                    break;
                }
                let Some(text) = text else {
                    continue;
                };
                let lines: Vec<String> = text
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .split('\n')
                    .map(str::to_owned)
                    .collect();
                for thread in todo {
                    let same = state
                        .threads
                        .get(&key)
                        .and_then(|m| m.get(&thread.id))
                        .is_some_and(|c| c.inst == thread.inst);
                    if !same {
                        continue;
                    }
                    let Some(anchor) = anchor_in_file(&thread.anchor, &lines) else {
                        continue;
                    };
                    let live = state.threads_of(&key).get_mut(&thread.id).unwrap();
                    live.anchor = anchor;
                    let live = live.clone();
                    let _ = inner.save_thread(&live);
                    moved = true;
                }
            }
            {
                let inner = &this.0;
                let mut state = inner.lock();
                if moved
                    && !stopped
                    && let Some(session) = state.sessions.get(&key).cloned()
                {
                    inner.publish_session(&state, &session);
                }
                state.reanchoring_file.remove(&key);
            }
            let again = this.0.lock().reanchor_file_again.remove(&key);
            if again {
                this.reanchor_file_task(&key, true, None).await;
            }
        });
        let shared = task.shared();
        state.reanchoring_file.insert(id.to_owned(), shared.clone());
        shared
    }

    /// Moves threads off rewritten commits (tests await it).
    pub async fn reanchor_rewritten(&self, params: &Value) -> ReviewResult<()> {
        let target = self.session_of(params)?;
        self.reanchor_rewritten_id(&target.id, None).await;
        Ok(())
    }

    pub(crate) async fn reanchor_rewritten_id(&self, id: &str, list: Option<Vec<ReviewCommit>>) {
        let task = {
            let mut state = self.0.lock();
            let Some(target) = state.sessions.get(id).cloned() else {
                return;
            };
            if !matches!(target.target, ReviewTarget::Range { compare: false, .. })
                || self.0.host.load_commits(&target).is_none()
            {
                return;
            }
            if let Some(running) = state.rewriting.get(id) {
                running.clone()
            } else {
                let this = self.clone();
                let key = id.to_owned();
                let task: BoxFut<()> = Box::pin(async move {
                    this.rewrite_pass(&target, list).await;
                    this.0.lock().rewriting.remove(&key);
                });
                let shared = task.shared();
                state.rewriting.insert(id.to_owned(), shared.clone());
                shared
            }
        };
        task.await;
    }

    async fn rewrite_pass(&self, target: &ReviewSession, list: Option<Vec<ReviewCommit>>) {
        let inner = &self.0;
        let commits = match list {
            Some(list) => list,
            None => self.commit_list(target).await.unwrap_or_default(),
        };
        if commits.is_empty() || commits[0].history {
            return;
        }
        let key = format!("{}:{}", commits.len(), commits[commits.len() - 1].sha);
        let (owners, todo) = {
            let mut state = inner.lock();
            let owners: Vec<ReviewSession> = state
                .sessions
                .values()
                .filter(|s| {
                    s.connection_id == target.connection_id
                        && s.root == target.root
                        && matches!(
                            s.target,
                            ReviewTarget::Worktree | ReviewTarget::Range { compare: false, .. }
                        )
                })
                .cloned()
                .collect();
            let todo: Vec<ReviewThread> = owners
                .iter()
                .flat_map(|owner| state.thread_list(&owner.id))
                .filter(|thread| {
                    thread.anchor.path.as_deref().is_some_and(|p| !p.is_empty())
                        && rewritten_out(&thread.anchor, &commits)
                        && state.rewrite_tried.get(&thread.id) != Some(&key)
                })
                .collect();
            for thread in &todo {
                state.rewrite_tried.insert(thread.id.clone(), key.clone());
            }
            (owners, todo)
        };
        if todo.is_empty() {
            return;
        }
        let mut same_head: HashSet<String> = [target.id.clone()].into();
        let others: Vec<&ReviewSession> = owners
            .iter()
            .filter(|owner| owner.id != target.id && todo.iter().any(|t| t.session_id == owner.id))
            .collect();
        let head_of = |owner: &ReviewSession| match &owner.target {
            ReviewTarget::Range { head, .. } => head.clone(),
            _ => "HEAD".into(),
        };
        if !others.is_empty() {
            let mut entries = vec![(target.root.clone(), head_of(target))];
            entries.extend(
                others
                    .iter()
                    .map(|owner| (owner.root.clone(), head_of(owner))),
            );
            if let Some(load) = inner.host.load_heads(&target.connection_id, entries) {
                let heads = load.await.unwrap_or_default();
                if let Some(Some(head)) = heads.first() {
                    for (index, owner) in others.iter().enumerate() {
                        if heads.get(index + 1).cloned().flatten().as_ref() == Some(head) {
                            same_head.insert(owner.id.clone());
                        }
                    }
                }
            }
        }
        let mut stale: Vec<String> = Vec::new();
        for thread in &todo {
            let commit = thread.anchor.commit.clone().unwrap_or_default();
            if !stale.contains(&commit) {
                stale.push(commit);
            }
        }
        let mut shas = stale;
        let tail = commits.len().saturating_sub(200);
        shas.extend(commits[tail..].iter().map(|c| c.sha.clone()));
        let patch_ids = match inner.host.load_patch_ids(target, shas) {
            Some(load) => load.await.unwrap_or_default(),
            None => IndexMap::new(),
        };
        let mut paths: Vec<String> = Vec::new();
        for thread in &todo {
            let path = thread.anchor.path.clone().unwrap_or_default();
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        let whole = self
            .from_checkout(target, inner.host.load_diff(target, None, Some(paths)))
            .await
            .ok()
            .and_then(diff_of);
        let file_in = |diff: Option<&ReviewDiff>, path: &str| -> Option<ReviewDiffFile> {
            diff?
                .files
                .iter()
                .find(|f| f.path == path || f.old_path == path)
                .cloned()
        };
        let mut commit_diffs: std::collections::HashMap<String, Option<ReviewDiff>> =
            Default::default();
        let mut moved: Vec<String> = Vec::new();
        for thread in &todo {
            let own = same_head.contains(&thread.session_id);
            let to = rewritten_commit(&thread.anchor, &commits, &patch_ids, own).cloned();
            let path = thread.anchor.path.clone().unwrap_or_default();
            let anchor = if let Some(to) = &to {
                if !commit_diffs.contains_key(&to.sha) {
                    let diff = self
                        .from_checkout(
                            target,
                            inner.host.load_diff(target, Some(to.sha.clone()), None),
                        )
                        .await
                        .ok()
                        .and_then(diff_of);
                    commit_diffs.insert(to.sha.clone(), diff);
                }
                let line = line_in_file(
                    &thread.anchor,
                    file_in(commit_diffs[&to.sha].as_ref(), &path).as_ref(),
                );
                match line {
                    Some(line) => Some(moved_anchor(
                        &thread.anchor,
                        CommitMove::Onto(to),
                        Some(line),
                        false,
                    )),
                    None => {
                        match line_in_file(&thread.anchor, file_in(whole.as_ref(), &path).as_ref())
                        {
                            Some(in_whole) => Some(moved_anchor(
                                &thread.anchor,
                                CommitMove::Whole,
                                Some(in_whole),
                                false,
                            )),
                            None => Some(moved_anchor(
                                &thread.anchor,
                                CommitMove::Onto(to),
                                None,
                                true,
                            )),
                        }
                    }
                }
            } else if own {
                match line_in_file(&thread.anchor, file_in(whole.as_ref(), &path).as_ref()) {
                    Some(in_whole) => Some(moved_anchor(
                        &thread.anchor,
                        CommitMove::Whole,
                        Some(in_whole),
                        false,
                    )),
                    None if thread.anchor.outdated => None,
                    None => Some(moved_anchor(&thread.anchor, CommitMove::Keep, None, true)),
                }
            } else {
                None
            };
            let mut state = inner.lock();
            let Some(anchor) = anchor else {
                continue;
            };
            if !state.sessions.contains_key(&thread.session_id) {
                continue;
            }
            let same = state
                .threads
                .get(&thread.session_id)
                .and_then(|m| m.get(&thread.id))
                .is_some_and(|c| c.inst == thread.inst);
            if !same {
                continue;
            }
            let live = state
                .threads_of(&thread.session_id)
                .get_mut(&thread.id)
                .unwrap();
            live.anchor = anchor;
            let live = live.clone();
            let _ = inner.save_thread(&live);
            if !moved.contains(&thread.session_id) {
                moved.push(thread.session_id.clone());
            }
        }
        let state = inner.lock();
        for id in moved {
            if let Some(owner) = state.sessions.get(&id) {
                inner.publish_session(&state, owner);
            }
        }
    }
}
