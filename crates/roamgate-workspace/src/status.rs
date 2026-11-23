//! A connection's Git status badges (workspace/status.ts
//! `createStatusEnricher`): `workspace.list` answers from a cache at any
//! age, entries older than [`GIT_STATUS_REFRESH_MS`] or invalidated by a
//! Git action are read again in one background refresh at a time, and the
//! checkouts whose status changed are pushed as `workspace.git_status`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt as _;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use roamgate_base::assets::{GIT_STATUS_BLOCK_SH, TemplateValue, fill_template};
use roamgate_base::clock::{SharedClock, timeout};
use roamgate_base::settings::workspace_repo_settings_key;
use roamgate_git::{Invocation, shell_quote};
use serde::Serialize;
use serde_json::{Value, json};

use crate::connection::WorkspaceConnection;

/// Entries older than this are refreshed in the background and pushed when
/// they change.
pub const GIT_STATUS_REFRESH_MS: i64 = 20_000;
const GIT_STATUS_TIMEOUT_MS: u64 = 8000;
/// How long `workspace.list` waits for a checkout's first status; a slower
/// read (a cold ssh login) is pushed later.
pub const GIT_STATUS_COLD_BUDGET: Duration = Duration::from_millis(300);

/// A checkout's status, its keys in the order the TS object had them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GitStatusSummary {
    pub ahead: u64,
    pub behind: u64,
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
    pub conflicted: u64,
    pub dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl GitStatusSummary {
    fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::default()
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("a status serialises")
    }
}

/// `text.trim().slice(0, max)`.
fn trimmed(text: &str, max: usize) -> String {
    roamgate_git::trim_slice(text, max)
}

/// `text.slice(0, max)` (no trim), in UTF-16 units.
fn sliced(text: &str, max: usize) -> String {
    roamgate_base::log::slice_utf16(text, max).to_owned()
}

/// `git status --porcelain=v1 --branch`'s summary.
pub fn parse_git_status(output: &str) -> GitStatusSummary {
    static HEADER: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^(.+?)(?:\.\.\.(.*?))?(?: \[(.*)\])?$").unwrap());
    static AHEAD: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"ahead (\d+)").unwrap());
    static BEHIND: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"behind (\d+)").unwrap());
    let mut summary = GitStatusSummary::default();
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix("## ") {
            if let Some(found) = HEADER.captures(header) {
                let branch = &found[1];
                summary.branch = Some(if branch == "HEAD (no branch)" {
                    "detached".to_owned()
                } else {
                    branch
                        .strip_prefix("No commits yet on ")
                        .unwrap_or(branch)
                        .to_owned()
                });
                if let Some(upstream) = found.get(2).filter(|m| !m.as_str().is_empty()) {
                    summary.upstream = Some(upstream.as_str().to_owned());
                }
                let tracking = found.get(3).map(|m| m.as_str()).unwrap_or("");
                let count = |re: &Regex| {
                    re.captures(tracking)
                        .and_then(|c| c[1].parse().ok())
                        .unwrap_or(0)
                };
                summary.ahead = count(&AHEAD);
                summary.behind = count(&BEHIND);
            }
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next();
        let y = chars.next();
        if x == Some('?') && y == Some('?') {
            summary.untracked += 1;
            continue;
        }
        let conflicted = x == Some('U')
            || y == Some('U')
            || (x == Some('A') && y == Some('A'))
            || (x == Some('D') && y == Some('D'));
        if conflicted {
            summary.conflicted += 1;
            continue;
        }
        if x.is_some_and(|x| x != ' ') {
            summary.staged += 1;
        }
        if y.is_some_and(|y| y != ' ') {
            summary.unstaged += 1;
        }
    }
    summary.dirty = summary.staged > 0
        || summary.unstaged > 0
        || summary.untracked > 0
        || summary.conflicted > 0;
    summary
}

struct ReadResult {
    summary: GitStatusSummary,
    /// ssh or spawn failed: the summary says nothing about the checkout.
    transport_error: bool,
}

struct Cached {
    /// When the read that produced `summary` started.
    loaded_at: i64,
    /// The invalidation sequence seen when that read started.
    loaded_seq: u64,
    summary: GitStatusSummary,
}

type Refresh = Shared<BoxFuture<'static, ()>>;

#[derive(Default)]
struct State {
    cache: BTreeMap<String, Cached>,
    invalidated: BTreeMap<String, u64>,
    invalidation_seq: u64,
    cold_waited: BTreeSet<String>,
    known_paths: Vec<String>,
    path_by_workspace: BTreeMap<String, String>,
    refreshing: Option<(u64, Refresh)>,
    refresh_runs: u64,
    refresh_again: bool,
    disposed: bool,
}

struct Inner {
    conn: WorkspaceConnection,
    clock: SharedClock,
    cold_budget: Duration,
    state: Mutex<State>,
}

/// One connection generation's status cache; [`GitStatus::dispose`] when
/// the generation goes.
#[derive(Clone)]
pub struct GitStatus(Arc<Inner>);

fn cache_key(host: Option<&str>, path: &str) -> String {
    format!("{}\0{path}", host.unwrap_or("local"))
}

impl GitStatus {
    /// `cold_budget`: [`GIT_STATUS_COLD_BUDGET`] in production; zero never
    /// waits.
    pub fn new(conn: WorkspaceConnection, clock: SharedClock, cold_budget: Duration) -> Self {
        Self(Arc::new(Inner {
            conn,
            clock,
            cold_budget,
            state: Mutex::new(State::default()),
        }))
    }

    fn host(&self) -> Option<String> {
        self.0.conn.ssh_host().map(str::to_owned)
    }

    fn is_fresh(&self, state: &State, key: &str) -> bool {
        state.cache.get(key).is_some_and(|cached| {
            self.0.clock.now() - cached.loaded_at < GIT_STATUS_REFRESH_MS
                && cached.loaded_seq >= state.invalidated.get(key).copied().unwrap_or(0)
        })
    }

    fn stale_paths(&self, state: &State, host: Option<&str>) -> Vec<String> {
        state
            .known_paths
            .iter()
            .filter(|path| !self.is_fresh(state, &cache_key(host, path)))
            .cloned()
            .collect()
    }

    /// A Git action changed the checkout: read it again now.
    pub fn invalidate_root(&self, checkout_path: &str) {
        {
            let mut state = self.0.state.lock().unwrap();
            state.invalidation_seq += 1;
            let seq = state.invalidation_seq;
            state
                .invalidated
                .insert(cache_key(self.host().as_deref(), checkout_path), seq);
        }
        drop(self.refresh_in_background());
    }

    /// [`Self::invalidate_root`] of the workspace's checkout, when the last
    /// list had it.
    pub fn invalidate_workspace(&self, workspace_id: &str) {
        let path = self
            .0
            .state
            .lock()
            .unwrap()
            .path_by_workspace
            .get(workspace_id)
            .cloned();
        if let Some(path) = path {
            self.invalidate_root(&path);
        }
    }

    /// Settles when the refresh in flight, if any, finishes.
    pub fn refresh_settled(&self) -> BoxFuture<'static, ()> {
        let refreshing = self.0.state.lock().unwrap().refreshing.clone();
        match refreshing {
            Some((_, task)) => task.boxed(),
            None => async {}.boxed(),
        }
    }

    /// Single-flight: a request while a refresh runs schedules one more
    /// pass, so an invalidation during an in-flight read is never lost.
    fn refresh_in_background(&self) -> BoxFuture<'static, ()> {
        let mut state = self.0.state.lock().unwrap();
        if let Some((_, task)) = state.refreshing.clone() {
            if !state.disposed {
                state.refresh_again = true;
            }
            return task.boxed();
        }
        if state.disposed {
            return async {}.boxed();
        }
        state.refresh_runs += 1;
        let run = state.refresh_runs;
        let this = self.clone();
        let handle = tokio::spawn(async move {
            loop {
                let (host, paths) = {
                    let mut state = this.0.state.lock().unwrap();
                    if state.disposed {
                        break;
                    }
                    state.refresh_again = false;
                    let host = this.host();
                    let paths = this.stale_paths(&state, host.as_deref());
                    (host, paths)
                };
                if paths.is_empty() {
                    break;
                }
                this.refresh_statuses(host.as_deref(), paths).await;
                if !this.0.state.lock().unwrap().refresh_again {
                    break;
                }
            }
            let mut state = this.0.state.lock().unwrap();
            if state.refreshing.as_ref().is_some_and(|(id, _)| *id == run) {
                state.refreshing = None;
            }
        });
        let task: Refresh = async move {
            let _ = handle.await;
        }
        .boxed()
        .shared();
        state.refreshing = Some((run, task.clone()));
        task.boxed()
    }

    async fn refresh_statuses(&self, host: Option<&str>, paths: Vec<String>) {
        let (started_at, started_seq) = {
            let state = self.0.state.lock().unwrap();
            (self.0.clock.now(), state.invalidation_seq)
        };
        let results: Vec<(String, ReadResult)> = match host {
            Some(host) => self.read_remote(host, &paths).await,
            None => {
                futures_util::future::join_all(
                    paths
                        .iter()
                        .map(|path| async move { (path.clone(), self.read_local(path).await) }),
                )
                .await
            }
        };
        let mut updates = Vec::new();
        {
            let mut state = self.0.state.lock().unwrap();
            if state.disposed {
                return;
            }
            let known: BTreeSet<String> = state.known_paths.iter().cloned().collect();
            for (path, result) in results {
                if !known.contains(&path) {
                    continue;
                }
                let key = cache_key(host, &path);
                let previous = state.cache.get(&key).map(|cached| cached.summary.clone());
                // A dropped ssh keeps the last real answer instead of
                // replacing every badge with a transport error; it is retried
                // after the refresh period.
                let summary = match (&previous, result.transport_error) {
                    (Some(previous), true) => previous.clone(),
                    _ => result.summary,
                };
                state.cache.insert(
                    key,
                    Cached {
                        loaded_at: started_at,
                        loaded_seq: started_seq,
                        summary: summary.clone(),
                    },
                );
                if previous.as_ref() != Some(&summary) {
                    updates.push(json!({"checkout_path": path, "git_status": summary.to_json()}));
                }
            }
        }
        if !updates.is_empty() {
            self.0.conn.events.emit(
                "workspace.git_status",
                json!({"type": "workspace.git_status", "statuses": updates}),
            );
        }
    }

    async fn read_local(&self, path: &str) -> ReadResult {
        // Polling must never take index.lock from the user's own git
        // (GIT_OPTIONAL_LOCKS=0, as a flag).
        let invocation = Invocation::local([
            "git",
            "--no-optional-locks",
            "-C",
            path,
            "status",
            "--porcelain=v1",
            "--branch",
        ]);
        match self
            .0
            .conn
            .git
            .run(invocation, Duration::from_millis(GIT_STATUS_TIMEOUT_MS))
            .await
        {
            Ok(ran) if ran.code == 0 => ReadResult {
                summary: parse_git_status(&ran.stdout),
                transport_error: false,
            },
            Ok(ran) => {
                let text = [ran.stderr.as_str(), ran.stdout.as_str()]
                    .into_iter()
                    .find(|text| !text.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("git exited {}", ran.code));
                ReadResult {
                    summary: GitStatusSummary::failed(trimmed(&text, 300)),
                    transport_error: false,
                }
            }
            Err(error) => ReadResult {
                summary: GitStatusSummary::failed(sliced(&error.0, 300)),
                transport_error: true,
            },
        }
    }

    async fn read_remote(&self, host: &str, paths: &[String]) -> Vec<(String, ReadResult)> {
        let random = uuid::Uuid::new_v4().simple().to_string();
        let marker = format!("__ROAMGATE_GIT_STATUS_{}__", &random[..8]);
        let mut lines = vec!["export GIT_OPTIONAL_LOCKS=0".to_owned()];
        for (index, path) in paths.iter().enumerate() {
            lines.push(
                fill_template(
                    GIT_STATUS_BLOCK_SH,
                    &[
                        ("path", TemplateValue::from(shell_quote(path))),
                        ("marker", TemplateValue::from(marker.as_str())),
                        ("index", TemplateValue::Number(index as f64)),
                    ],
                )
                .expect("the git status block's template"),
            );
        }
        let command = lines.join("\n");
        let timeout_ms = GIT_STATUS_TIMEOUT_MS.max(2500 + paths.len() as u64 * 1000);
        let fail_all = |error: String| {
            paths
                .iter()
                .map(|path| {
                    (
                        path.clone(),
                        ReadResult {
                            summary: GitStatusSummary::failed(error.clone()),
                            transport_error: true,
                        },
                    )
                })
                .collect::<Vec<_>>()
        };
        let ran = match self
            .0
            .conn
            .git
            .run(
                Invocation::ssh_read(host, &command, Some("git.status.batch")),
                Duration::from_millis(timeout_ms),
            )
            .await
        {
            Ok(ran) => ran,
            Err(error) => return fail_all(sliced(&error.0, 300)),
        };
        if ran.code != 0 {
            let text = [ran.stderr.as_str(), ran.stdout.as_str()]
                .into_iter()
                .find(|text| !text.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("ssh exited {}", ran.code));
            return fail_all(trimmed(&text, 300));
        }
        let mut found: BTreeMap<usize, GitStatusSummary> = BTreeMap::new();
        let begin = format!("{marker}BEGIN ");
        let end = format!("{marker}END ");
        static END: std::sync::LazyLock<Regex> =
            std::sync::LazyLock::new(|| Regex::new(r"END (\d+) (\d+)").unwrap());
        let mut current: Option<usize> = None;
        let mut current_lines: Vec<&str> = Vec::new();
        for line in ran.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(rest) = line.strip_prefix(&begin) {
                current = rest.parse().ok();
                current_lines.clear();
                continue;
            }
            if line.starts_with(&end) {
                if let Some(captures) = END.captures(line) {
                    let index: Option<usize> = captures[1].parse().ok();
                    let code: Option<i64> = captures[2].parse().ok();
                    if let (Some(index), Some(code)) = (index, code)
                        && current == Some(index)
                        && index < paths.len()
                    {
                        let output = current_lines.join("\n");
                        let summary = if code == 0 {
                            parse_git_status(&output)
                        } else {
                            let text = if output.is_empty() {
                                format!("git exited {code}")
                            } else {
                                output
                            };
                            GitStatusSummary::failed(trimmed(&text, 300))
                        };
                        found.insert(index, summary);
                    }
                }
                current = None;
                current_lines.clear();
                continue;
            }
            if current.is_some() {
                current_lines.push(line);
            }
        }
        paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                let summary = found.remove(&index).unwrap_or_else(|| {
                    GitStatusSummary::failed("git status did not return a result".into())
                });
                (
                    path.clone(),
                    ReadResult {
                        summary,
                        transport_error: false,
                    },
                )
            })
            .collect()
    }

    /// Attaches the last known status (and each repository's settings key
    /// and hook switch) to a `workspace.list` answer. Stale or missing
    /// entries refresh in the background and reach the browsers as
    /// `workspace.git_status`; only a checkout seen for the first time
    /// waits, up to the cold budget.
    pub async fn enrich_workspaces(&self, mut payload: Value) -> Value {
        let Some(workspaces) = payload.get_mut("workspaces").and_then(Value::as_array_mut) else {
            return payload;
        };
        let checkout = |workspace: &Value| {
            workspace
                .get("worktree")
                .and_then(|worktree| worktree.get("checkout_path"))
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
        };
        let host = self.host();
        let settings = self.0.conn.settings.read().await;
        for workspace in workspaces.iter_mut() {
            if checkout(workspace).is_none() {
                continue;
            }
            let Some(key) =
                workspace_repo_settings_key(workspace, host.as_deref(), Some(&self.0.conn.id))
            else {
                continue;
            };
            let enabled = settings
                .get("repositories")
                .and_then(|repositories| repositories.get(&key))
                .and_then(|entry| entry.get("worktree_hooks_enabled"))
                != Some(&Value::Bool(false));
            if let Some(worktree) = workspace.get_mut("worktree").and_then(Value::as_object_mut) {
                worktree.insert("gui_settings_key".into(), key.into());
                worktree.insert("worktree_hooks_enabled".into(), enabled.into());
            }
        }
        let (stale, cold) = {
            let mut state = self.0.state.lock().unwrap();
            state.path_by_workspace = BTreeMap::new();
            for workspace in workspaces.iter() {
                if let (Some(path), Some(id)) = (
                    checkout(workspace),
                    workspace.get("workspace_id").and_then(Value::as_str),
                ) {
                    state.path_by_workspace.insert(id.to_owned(), path);
                }
            }
            // The order of the list's checkouts, as a Map's values keep it.
            let mut ordered = Vec::new();
            for workspace in workspaces.iter() {
                if let (Some(path), Some(_)) = (
                    checkout(workspace),
                    workspace.get("workspace_id").and_then(Value::as_str),
                ) && !ordered.contains(&path)
                {
                    ordered.push(path);
                }
            }
            state.known_paths = ordered;
            let known_keys: BTreeSet<String> = state
                .known_paths
                .iter()
                .map(|path| cache_key(host.as_deref(), path))
                .collect();
            state.cache.retain(|key, _| known_keys.contains(key));
            state.invalidated.retain(|key, _| known_keys.contains(key));
            state.cold_waited.retain(|key| known_keys.contains(key));
            let stale = !self.stale_paths(&state, host.as_deref()).is_empty();
            let cold: Vec<String> = known_keys
                .iter()
                .filter(|key| !state.cache.contains_key(*key) && !state.cold_waited.contains(*key))
                .cloned()
                .collect();
            (stale, cold)
        };
        if stale {
            let refresh = self.refresh_in_background();
            let disposed = self.0.state.lock().unwrap().disposed;
            if !cold.is_empty() && !self.0.cold_budget.is_zero() && !disposed {
                self.0.state.lock().unwrap().cold_waited.extend(cold);
                let _ = timeout(self.0.clock.as_ref(), self.0.cold_budget, refresh).await;
            }
        }
        let state = self.0.state.lock().unwrap();
        for workspace in workspaces.iter_mut() {
            let Some(path) = checkout(workspace) else {
                continue;
            };
            if let Some(cached) = state.cache.get(&cache_key(host.as_deref(), &path))
                && let Some(worktree) = workspace.get_mut("worktree").and_then(Value::as_object_mut)
            {
                worktree.insert("git_status".into(), cached.summary.to_json());
            }
        }
        drop(state);
        payload
    }

    /// Stops background refreshes: no new git or ssh process starts and a
    /// read already in flight neither updates the cache nor pushes.
    pub fn dispose(&self) {
        self.0.state.lock().unwrap().disposed = true;
    }
}

#[cfg(test)]
mod tests;
