//! Ranger's scheduled tasks (`assistant/tasks.ts`): admission and timing.
//! Each run still goes through the ordinary Ranger service, as a
//! [`ScheduledChild`] the caller makes.
//!
//! The state is Bun's: `{tasks, proposals, requests}` as JavaScript values
//! saved in `tasks.sqlite` after every change (a failed save restores the
//! state before it and pauses scheduling). Records are found again by id
//! after every await, where the TS held them by reference.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_agents::js;
use roamgate_base::clock::SharedClock;
use roamgate_base::paths::{DataContext, random_uuid};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::errors::{AssistantError, AssistantResult};
use crate::saved::{
    MAX_NOTIFICATIONS, MAX_PROPOSALS, MAX_RUNS, MAX_TASKS, UNFINISHED, is_notification_input,
    ref_key, valid_prepared, validate_task_input,
};
use crate::task_schedule::{next_task_time, resolved_timezone, validate_task_schedule};
use crate::task_storage::TaskStorage;
use crate::tools::{BoxFuture, ToolResult};
use crate::wire::{ASSISTANT_MAX_WORKSPACES, is_snapshot, is_uuid};

const MANAGEMENT_PREVIEW_MS: i64 = 10 * 60_000;

/// A run of a task, as the service runs it.
pub trait ScheduledChild: Send + Sync {
    fn start(&self, recover: bool) -> BoxFuture<AssistantResult<()>>;
    fn resume(&self) -> BoxFuture<AssistantResult<()>>;
    fn stop(&self) -> BoxFuture<AssistantResult<()>>;
    fn action(&self, method: &str, action_id: &str) -> BoxFuture<AssistantResult<()>>;
    fn snapshot(&self) -> Value;
    fn dispose(&self) -> BoxFuture<AssistantResult<()>>;
}

pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;
/// A task notification sent to the user (best effort).
pub type NotifyUser = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;
pub type BeforeDispatch = Arc<dyn Fn() -> AssistantResult<()> + Send + Sync>;
pub type MakeChild =
    Arc<dyn Fn(Value, PathBuf, Publish, BeforeDispatch) -> Arc<dyn ScheduledChild> + Send + Sync>;
pub type Validate =
    Arc<dyn Fn(Value, CancellationToken) -> BoxFuture<AssistantResult<()>> + Send + Sync>;
/// A task over all workspaces, prepared again over those of now, with
/// what it left out (`notice`) on the result.
pub type Rescope =
    Arc<dyn Fn(Value, CancellationToken) -> BoxFuture<AssistantResult<Value>> + Send + Sync>;
/// A task over fixed workspaces without those closed or down for now, with
/// a `notice`, or None when it skipped none; `wait` for a run.
pub type Narrow = Arc<
    dyn Fn(Value, Option<CancellationToken>, bool) -> BoxFuture<AssistantResult<Option<Value>>>
        + Send
        + Sync,
>;

pub struct TaskOptions {
    pub directory: PathBuf,
    pub context: DataContext,
    pub clock: SharedClock,
    pub publish: Arc<dyn Fn() + Send + Sync>,
    pub notify: Option<NotifyUser>,
    pub validate: Validate,
    pub validate_cleanup: Option<Validate>,
    pub rescope: Option<Rescope>,
    pub narrow: Option<Narrow>,
    pub child: MakeChild,
}

/// A task's id, revision and sealed admission, held by a preview.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub revision: u64,
    pub prepared: Value,
}

pub type AssertScope = Arc<dyn Fn(&Value) -> AssistantResult<()> + Send + Sync>;

struct Guard {
    snapshot: TaskSnapshot,
    assert_scope: AssertScope,
    expires: i64,
}

type Disposal = Shared<BoxFuture<AssistantResult<()>>>;

#[derive(Default)]
struct State {
    tasks: Vec<Value>,
    proposals: Vec<Value>,
    requests: Vec<Value>,
    invalid: bool,
    enabled: bool,
    started: bool,
    disposed: bool,
    busy: Option<String>,
    fault: Option<String>,
    timer: Option<JoinHandle<()>>,
    timer_generation: u64,
    children: HashMap<String, Arc<dyn ScheduledChild>>,
    run_owners: HashMap<String, String>,
    /// By child, as Bun's WeakMap: the entry holds the child so that its
    /// address is not another's, and goes once nothing else holds it.
    child_disposals: HashMap<usize, (Arc<dyn ScheduledChild>, Disposal)>,
    failed_disposals: HashSet<String>,
    finalizing_proposals: HashSet<String>,
    admissions: HashMap<String, CancellationToken>,
    retry_at: HashMap<String, i64>,
    unstarted_admissions: HashSet<String>,
    management_guards: HashMap<String, Guard>,
    revisions: HashMap<String, u64>,
    checks: HashMap<String, Vec<(u64, CancellationToken)>>,
    next_check: u64,
    storage: Option<TaskStorage>,
    jobs: Vec<JoinHandle<()>>,
}

struct Inner {
    options: TaskOptions,
    state: Mutex<State>,
    controller: CancellationToken,
}

/// The task manager (`createAssistantTasks`).
#[derive(Clone)]
pub struct AssistantTasks(Arc<Inner>);

fn child_key(child: &Arc<dyn ScheduledChild>) -> usize {
    Arc::as_ptr(child) as *const () as usize
}

fn user(message: &str) -> AssistantError {
    AssistantError::user(message)
}

fn internal(message: &str) -> AssistantError {
    AssistantError::internal(message)
}

fn status(run: &Value) -> &str {
    run.get("status").and_then(Value::as_str).unwrap_or("")
}

fn unfinished(run: &Value) -> bool {
    UNFINISHED.contains(&status(run))
}

fn id_of(value: &Value) -> &str {
    value.get("id").and_then(Value::as_str).unwrap_or("")
}

fn task_id_of(entry: &Value) -> &str {
    entry["task"]["id"].as_str().unwrap_or("")
}

/// Compares strings as JavaScript does (UTF-16 code units).
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `seal`: the four fields of an admission, cloned.
fn seal(prepared: &Value) -> Value {
    json!({
        "input": prepared.get("input").cloned().unwrap_or(Value::Null),
        "config": prepared.get("config").cloned().unwrap_or(Value::Null),
        "targets": prepared.get("targets").cloned().unwrap_or(Value::Null),
        "workspaces": prepared.get("workspaces").cloned().unwrap_or(Value::Null),
    })
}

/// `Object.assign(target, source)` for objects.
fn assign(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn remove(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.shift_remove(key);
    }
}

fn compact(run: &mut Value) {
    for key in ["input", "config", "targets", "workspaces"] {
        remove(run, key);
    }
}

fn receipt(run: &Value) -> Value {
    let mut out = Map::new();
    for key in [
        "id",
        "task_id",
        "status",
        "scheduled_at",
        "started_at",
        "finished_at",
        "error",
    ] {
        if let Some(value) = run.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(notice) = run.get("notice") {
        out.insert("notice".into(), notice.clone());
    }
    Value::Object(out)
}

fn sha256_hex(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.as_bytes());
    }
    hex::encode(hash.finalize())
}

/// What a notification is unique within: the task's exact workspaces and
/// mentions (`notificationScopeKey`).
pub fn notification_scope_key(targets: &Value, mentions: Option<&Value>) -> String {
    let mut sorted: Vec<&Value> = targets
        .as_array()
        .map(|t| t.iter().collect())
        .unwrap_or_default();
    sorted.sort_by(|a, b| js_cmp(&ref_key(a), &ref_key(b)));
    let tuples: Vec<Value> = sorted
        .iter()
        .map(|t| {
            json!([
                t.get("connection_id"),
                t.get("workspace_id"),
                t.get("endpoint_fingerprint"),
                t.get("herdr_boot_id"),
                t.get("workspace_identity")
            ])
        })
        .collect();
    let mentions = mentions
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mention_part = if mentions.is_empty() {
        String::new()
    } else {
        let mut keys: Vec<String> = mentions
            .iter()
            .map(|m| {
                let mut parts = vec![
                    m.get("kind").cloned().unwrap_or(Value::Null),
                    m.get("connection_id").cloned().unwrap_or(Value::Null),
                    m.get("workspace_id").cloned().unwrap_or(Value::Null),
                ];
                if m.get("kind") == Some(&Value::from("agent")) {
                    for key in ["pane_id", "terminal_id", "agent_identity"] {
                        parts.push(m.get(key).cloned().unwrap_or(Value::Null));
                    }
                }
                js::stringify(&Value::Array(parts))
            })
            .collect();
        keys.sort_by(|a, b| js_cmp(a, b));
        js::stringify(&json!(keys))
    };
    sha256_hex(&[&js::stringify(&Value::Array(tuples)), &mention_part])
}

/// `runScopeKey`: a task over all workspaces is its own scope.
pub fn run_scope_key(input: &Value, targets: &Value) -> String {
    if input.get("all_workspaces") == Some(&Value::Bool(true)) {
        return sha256_hex(&["all-workspaces"]);
    }
    notification_scope_key(targets, input.get("mentions"))
}

fn schedule_key(schedule: &Value) -> AssistantResult<String> {
    let mut normalized = validate_task_schedule(schedule)?;
    if normalized["type"] == "daily" {
        let zone = normalized["timezone"].as_str().unwrap_or("").to_owned();
        if let Some(resolved) = resolved_timezone(&zone) {
            normalized["timezone"] = Value::String(resolved);
        }
    }
    Ok(js::stringify(&normalized))
}

/// `AbortSignal.any`: a token cancelled when any of these is.
fn any_signal(signals: &[&CancellationToken]) -> CancellationToken {
    let combined = CancellationToken::new();
    if signals.iter().any(|s| s.is_cancelled()) {
        combined.cancel();
        return combined;
    }
    for signal in signals {
        let (signal, combined) = ((*signal).clone(), combined.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = signal.cancelled() => combined.cancel(),
                _ = combined.cancelled() => {}
            }
        });
    }
    combined
}

impl State {
    fn find(&self, id: &str) -> AssistantResult<usize> {
        if !is_uuid(id) {
            return Err(internal("Invalid task identifier"));
        }
        self.tasks
            .iter()
            .position(|entry| task_id_of(entry) == id)
            .ok_or_else(|| internal("This task is no longer available."))
    }

    fn revision(&self, id: &str) -> u64 {
        self.revisions.get(id).copied().unwrap_or(0)
    }

    fn bump(&mut self, id: &str) {
        *self.revisions.entry(id.to_owned()).or_default() += 1;
    }

    fn run_location(&self, run_id: &str) -> Option<(usize, usize)> {
        self.tasks.iter().enumerate().find_map(|(t, entry)| {
            entry["runs"]
                .as_array()?
                .iter()
                .position(|run| id_of(run) == run_id)
                .map(|r| (t, r))
        })
    }

    fn run(&self, run_id: &str) -> Option<&Value> {
        let (t, r) = self.run_location(run_id)?;
        Some(&self.tasks[t]["runs"][r])
    }

    fn run_mut(&mut self, run_id: &str) -> Option<&mut Value> {
        let (t, r) = self.run_location(run_id)?;
        Some(&mut self.tasks[t]["runs"][r])
    }

    fn current(entry: &Value) -> Option<&Value> {
        entry["runs"].as_array()?.iter().find(|run| unfinished(run))
    }

    fn current_id(entry: &Value) -> Option<String> {
        Self::current(entry).map(|run| id_of(run).to_owned())
    }

    fn retained_proposals(&self) -> Vec<Value> {
        self.proposals
            .iter()
            .filter(|entry| {
                entry["proposal"]["status"] == "pending"
                    || self
                        .finalizing_proposals
                        .contains(id_of(&entry["proposal"]))
            })
            .cloned()
            .collect()
    }

    fn save(&mut self) -> Result<(), String> {
        if self.invalid || self.storage.is_none() {
            return Err("The saved Ranger tasks could not be loaded.".into());
        }
        let start = self.requests.len().saturating_sub(1000);
        let state = json!({
            "tasks": self.tasks,
            "proposals": self.proposals,
            "requests": self.requests[start..],
        });
        self.storage
            .as_ref()
            .unwrap()
            .save(&state)
            .map_err(|error| error.to_string())
    }
}

/// What a change leaves to do once the state is unlocked.
#[derive(Default)]
struct Effects {
    notifications: Vec<Value>,
    remove_dirs: Vec<PathBuf>,
}

impl Inner {
    fn now_ms(&self) -> i64 {
        self.options.clock.now()
    }

    fn now(&self) -> String {
        js::iso(self.now_ms() as f64)
    }

    fn publish(&self) {
        (self.options.publish)();
    }

    /// `runDirectory`: every directory checked for links on the way.
    fn run_directory(&self, task_id: &str, run_id: Option<&str>) -> AssistantResult<PathBuf> {
        let root = self.options.directory.join("tasks");
        let task = root.join(task_id);
        let mut paths = vec![self.options.directory.clone(), root, task.clone()];
        if let Some(run_id) = run_id {
            paths.push(task.join("runs"));
            paths.push(task.join("runs").join(run_id));
        }
        for directory in &paths {
            self.options
                .context
                .assert_safe_data_path(&directory.join(".guard"))
                .map_err(|error| internal(&error.to_string()))?;
        }
        Ok(paths.pop().unwrap())
    }

    fn change<T>(&self, update: impl FnOnce(&Inner, &mut State) -> T) -> AssistantResult<T> {
        self.try_change(|inner, state| Ok(update(inner, state)))
    }

    /// `change(update)`: the update, saved; when either fails the state
    /// before it comes back, scheduling pauses and the error is the save's.
    fn try_change<T>(
        &self,
        update: impl FnOnce(&Inner, &mut State) -> AssistantResult<T>,
    ) -> AssistantResult<T> {
        let mut state = self.state.lock().unwrap();
        let previous = (
            state.tasks.clone(),
            state.proposals.clone(),
            state.requests.clone(),
        );
        let result = update(self, &mut state);
        if result.is_err() || state.save().is_err() {
            state.tasks = previous.0;
            state.proposals = previous.1;
            state.requests = previous.2;
            state.fault = Some(
                "The Ranger tasks could not be saved. Scheduling is paused until recovery succeeds."
                    .into(),
            );
            state.enabled = false;
            drop(state);
            self.publish();
            return Err(internal("The Ranger task changes could not be saved."));
        }
        // Revisions describe durable state only.
        let before: HashMap<String, String> = previous
            .0
            .iter()
            .map(|entry| (task_id_of(entry).to_owned(), js::stringify(entry)))
            .collect();
        let changed: Vec<String> = state
            .tasks
            .iter()
            .filter(|entry| before.get(task_id_of(entry)) != Some(&js::stringify(entry)))
            .map(|entry| task_id_of(entry).to_owned())
            .collect();
        for id in changed {
            state.bump(&id);
        }
        let removed: Vec<String> = previous
            .0
            .iter()
            .map(|entry| task_id_of(entry).to_owned())
            .filter(|id| !state.tasks.iter().any(|entry| task_id_of(entry) == id))
            .collect();
        for id in removed {
            state.bump(&id);
        }
        let mut effects = Effects::default();
        if self.options.notify.is_some() {
            let previous_runs: HashMap<&str, &Value> = previous
                .0
                .iter()
                .flat_map(|entry| entry["runs"].as_array().into_iter().flatten())
                .map(|run| (id_of(run), run))
                .collect();
            for entry in &state.tasks {
                for run in entry["runs"].as_array().into_iter().flatten() {
                    let status = status(run);
                    let before = previous_runs.get(id_of(run));
                    if !["succeeded", "failed", "waiting"].contains(&status)
                        || before.is_some_and(|b| b["status"] == status)
                    {
                        continue;
                    }
                    let agent = |run: Option<&Value>| {
                        run.and_then(|r| r.get("input"))
                            .and_then(|i| i.get("notification_mode"))
                            == Some(&Value::from("agent"))
                    };
                    if status == "succeeded"
                        && (agent(before.copied())
                            || agent(Some(run))
                            || entry
                                .get("notifications")
                                .and_then(Value::as_array)
                                .is_some_and(|list| list.iter().any(|n| n["run_id"] == run["id"])))
                    {
                        continue;
                    }
                    let title = before
                        .and_then(|b| b.get("input"))
                        .and_then(|i| i.get("title"))
                        .or_else(|| run.get("input").and_then(|i| i.get("title")))
                        .or_else(|| entry["input"].get("title"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let (heading, body) = match status {
                        "succeeded" => ("Ranger task completed", "completed successfully."),
                        "failed" => (
                            "Ranger task failed",
                            "failed. Open Ranger to review the task.",
                        ),
                        _ => (
                            "Ranger task needs confirmation",
                            "needs your confirmation. Open Ranger to review the pending action.",
                        ),
                    };
                    effects.notifications.push(json!({
                        "task_id": entry["task"]["id"],
                        "run_id": run["id"],
                        "status": status,
                        "title": heading,
                        "body": format!("{title}: {body}"),
                    }));
                }
            }
        }
        let retained: HashSet<String> = state
            .tasks
            .iter()
            .flat_map(|entry| entry["runs"].as_array().into_iter().flatten())
            .map(|run| id_of(run).to_owned())
            .collect();
        state.retry_at.retain(|id, _| retained.contains(id));
        for entry in &previous.0 {
            let task_id = task_id_of(entry);
            for run in entry["runs"].as_array().into_iter().flatten() {
                let run_id = id_of(run);
                if !retained.contains(run_id)
                    && !state.run_owners.contains_key(run_id)
                    && state.tasks.iter().any(|item| task_id_of(item) == task_id)
                    && let Ok(path) = self.run_directory(task_id, Some(run_id))
                {
                    effects.remove_dirs.push(path);
                }
            }
        }
        drop(state);
        if let Some(notify) = &self.options.notify {
            for notification in effects.notifications {
                let _ = notify(notification);
            }
        }
        self.publish();
        for path in effects.remove_dirs {
            let _ = std::fs::remove_dir_all(path);
        }
        result
    }

    fn queue(&self, state: &mut State, index: usize, scheduled_at: &str, manual: bool) -> String {
        let entry = &mut state.tasks[index];
        let mut run = seal(entry).as_object().unwrap().clone();
        let id = random_uuid();
        run.insert("id".into(), json!(id));
        run.insert("task_id".into(), entry["task"]["id"].clone());
        run.insert("status".into(), json!("queued"));
        run.insert("scheduled_at".into(), json!(scheduled_at));
        run.insert("error".into(), Value::Null);
        run.insert("manual".into(), json!(manual));
        let runs = entry["runs"].as_array_mut().unwrap();
        runs.insert(0, Value::Object(run));
        runs.truncate(MAX_RUNS);
        id
    }

    fn next_after(&self, entry: &Value, now: i64) -> AssistantResult<Option<f64>> {
        let schedule = &entry["input"]["schedule"];
        if schedule["type"] == "interval" {
            let interval = schedule["minutes"].as_f64().unwrap_or(1.0) * 60_000.0;
            let previous = js::date_parse(entry["task"]["next_run_at"].as_str().unwrap_or(""));
            return Ok(Some(
                previous + (((now as f64 - previous) / interval).floor() + 1.0) * interval,
            ));
        }
        next_task_time(schedule, now as f64)
    }

    fn update_entry(&self, entry: &mut Value, prepared: &Value) -> AssistantResult<()> {
        let schedule_changed = schedule_key(&entry["input"]["schedule"])?
            != schedule_key(&prepared["input"]["schedule"])?;
        let next = if schedule_changed {
            let schedule = &prepared["input"]["schedule"];
            if schedule["type"] == "once" {
                schedule["at"].clone()
            } else {
                let next = next_task_time(schedule, self.now_ms() as f64)?.unwrap_or(f64::NAN);
                json!(js::iso(next))
            }
        } else {
            entry["task"]["next_run_at"].clone()
        };
        assign(entry, &seal(prepared));
        entry["task"]["updated_at"] = json!(self.now());
        if schedule_changed {
            entry["task"]["next_run_at"] = next;
            remove(entry, "due_at");
        }
        Ok(())
    }

    fn control_entry(&self, state: &mut State, method: &str, index: usize, active: Option<&str>) {
        let now = self.now();
        let unstarted = active.is_some_and(|id| state.unstarted_admissions.contains(id));
        let entry = &mut state.tasks[index];
        entry["task"]["updated_at"] = json!(now);
        if method == "pause" {
            entry["task"]["status"] = json!("paused");
            remove(entry, "due_at");
            if unstarted && let Some(run) = active.and_then(|id| find_run_mut(entry, id)) {
                run["status"] = json!("queued");
                remove(run, "started_at");
            }
        }
        if method == "resume" {
            entry["task"]["status"] = json!("active");
            if entry["task"]["next_run_at"].is_null()
                && entry["input"]["schedule"]["type"] != "once"
            {
                let next = next_task_time(&entry["input"]["schedule"], self.now_ms() as f64)
                    .ok()
                    .flatten()
                    .unwrap_or(f64::NAN);
                entry["task"]["next_run_at"] = json!(js::iso(next));
            }
        }
        if method == "run_now" && active.is_none() {
            self.queue(state, index, &now, true);
        }
        let entry = &mut state.tasks[index];
        if method == "cancel" {
            entry["task"]["status"] = json!("cancelled");
            entry["task"]["next_run_at"] = Value::Null;
            remove(entry, "due_at");
        }
        if (method == "cancel" || method == "stop")
            && let Some(id) = active
        {
            if let Some(run) = find_run_mut(entry, id) {
                run["status"] = json!("stopped");
                run["finished_at"] = json!(now);
                run["error"] = Value::Null;
            }
            remove(entry, "due_at");
        }
    }

    fn summary(entry: &Value) -> Value {
        let mut out = Map::new();
        for key in ["id", "status", "created_at", "updated_at", "next_run_at"] {
            out.insert(key.into(), entry["task"][key].clone());
        }
        if let Some(input) = entry["input"].as_object() {
            for (key, value) in input {
                out.insert(key.clone(), value.clone());
            }
        }
        out.insert("workspaces".into(), entry["workspaces"].clone());
        out.insert(
            "model".into(),
            json!({"provider": entry["config"]["provider"], "id": entry["config"]["model"]}),
        );
        if let Some(mode) = entry["config"]
            .get("approval_mode")
            .filter(|m| m.as_str().is_some_and(|m| !m.is_empty()))
        {
            out.insert("approval_mode".into(), mode.clone());
        }
        if let Some(run) = State::current(entry) {
            out.insert("current_run".into(), receipt(run));
        }
        if let Some(run) = entry["runs"]
            .as_array()
            .and_then(|runs| runs.iter().find(|run| !unfinished(run)))
        {
            out.insert("last_run".into(), receipt(run));
        }
        Value::Object(out)
    }

    /// `insert`: a new task for a request, or the one it made already.
    fn insert(
        &self,
        state: &mut State,
        prepared: &Value,
        request_id: &str,
    ) -> AssistantResult<usize> {
        if let Some(existing) = state
            .requests
            .iter()
            .find(|r| r["id"] == request_id)
            .and_then(|r| r["task_id"].as_str())
            .map(str::to_owned)
        {
            return state.find(&existing);
        }
        if state.tasks.len() >= MAX_TASKS {
            return Err(user("Ranger supports up to 50 saved tasks."));
        }
        let schedule = &prepared["input"]["schedule"];
        let next = if schedule["type"] == "once" {
            Some(js::date_parse(schedule["at"].as_str().unwrap_or("")))
        } else {
            next_task_time(schedule, self.now_ms() as f64)?
        };
        let mut entry = seal(prepared).as_object().unwrap().clone();
        let now = self.now();
        entry.insert(
            "task".into(),
            json!({
                "id": random_uuid(),
                "status": "active",
                "created_at": now,
                "updated_at": now,
                "next_run_at": next.map_or(Value::Null, |n| json!(js::iso(n))),
            }),
        );
        entry.insert("runs".into(), json!([]));
        let task_id = entry["task"]["id"].clone();
        state.tasks.insert(0, Value::Object(entry));
        state
            .requests
            .push(json!({"id": request_id, "task_id": task_id}));
        let start = state.requests.len().saturating_sub(1000);
        state.requests.drain(..start);
        Ok(0)
    }
}

fn find_run_mut<'a>(entry: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    entry["runs"]
        .as_array_mut()?
        .iter_mut()
        .find(|run| id_of(run) == id)
}

/// `rescopedEntry`: a task over all workspaces after a run prepared again.
fn rescoped_entry(entry: &Value, fresh: &Value) -> Value {
    let ran: HashSet<String> = fresh["input"]["scope"]
        .as_array()
        .into_iter()
        .flatten()
        .map(ref_key)
        .collect();
    let mut held: Vec<String> = Vec::new();
    for mention in entry["input"]["mentions"].as_array().into_iter().flatten() {
        let key = ref_key(mention);
        if !ran.contains(&key) {
            held.push(key);
        }
    }
    let held: HashSet<String> = held.into_iter().collect();
    let kept: HashSet<String> = fresh["input"]["scope"]
        .as_array()
        .into_iter()
        .flatten()
        .take(ASSISTANT_MAX_WORKSPACES.saturating_sub(held.len()))
        .map(ref_key)
        .collect();
    let pick = |from_run: &Value, from_entry: &Value| -> Value {
        let mut out: Vec<Value> = from_run
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| kept.contains(&ref_key(r)))
            .cloned()
            .collect();
        out.extend(
            from_entry
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| held.contains(&ref_key(r)))
                .cloned(),
        );
        Value::Array(out)
    };
    let scope = pick(&fresh["input"]["scope"], &entry["input"]["scope"]);
    let mut input = entry["input"].clone();
    input["scope"] = scope.clone();
    let mut config = entry["config"].clone();
    config["allowed_workspaces"] = scope;
    seal(&json!({
        "input": input,
        "config": config,
        "targets": pick(&fresh["targets"], &entry["targets"]),
        "workspaces": pick(&fresh["workspaces"], &entry["workspaces"]),
    }))
}

impl AssistantTasks {
    pub fn new(options: TaskOptions) -> Self {
        let mut state = State::default();
        match TaskStorage::open(&options.context, &options.directory).and_then(|storage| {
            let loaded = storage.load()?;
            Ok((storage, loaded))
        }) {
            Ok((storage, loaded)) => {
                state.tasks = loaded["tasks"].as_array().cloned().unwrap_or_default();
                state.proposals = loaded["proposals"].as_array().cloned().unwrap_or_default();
                state.requests = loaded["requests"].as_array().cloned().unwrap_or_default();
                for entry in &mut state.proposals {
                    let proposal = &mut entry["proposal"];
                    if proposal.get("operation").is_some_and(|op| op != "create")
                        && proposal["status"] == "pending"
                    {
                        proposal["status"] = json!("cancelled");
                    }
                }
                for entry in &mut state.tasks {
                    for run in entry["runs"].as_array_mut().into_iter().flatten() {
                        if !unfinished(run) {
                            compact(run);
                        }
                    }
                }
                state.storage = Some(storage);
            }
            Err(_) => state.invalid = true,
        }
        Self(Arc::new(Inner {
            options,
            state: Mutex::new(state),
            controller: CancellationToken::new(),
        }))
    }

    fn inner(&self) -> &Inner {
        &self.0
    }

    pub fn invalid(&self) -> bool {
        self.0.state.lock().unwrap().invalid
    }

    pub fn error(&self) -> Option<String> {
        self.0.state.lock().unwrap().fault.clone()
    }

    pub fn summaries(&self) -> Vec<Value> {
        let state = self.0.state.lock().unwrap();
        state.tasks.iter().map(Inner::summary).collect()
    }

    pub fn prepared(&self, task_id: &str) -> AssistantResult<Value> {
        let state = self.0.state.lock().unwrap();
        let index = state.find(task_id)?;
        Ok(seal(&state.tasks[index]))
    }

    pub fn snapshot(&self, task_id: &str) -> AssistantResult<TaskSnapshot> {
        let state = self.0.state.lock().unwrap();
        let index = state.find(task_id)?;
        let entry = &state.tasks[index];
        Ok(TaskSnapshot {
            task_id: task_id_of(entry).to_owned(),
            revision: state.revision(task_id_of(entry)),
            prepared: seal(entry),
        })
    }

    /// `unchanged`: the task the preview was made from, still as it was.
    fn unchanged(state: &State, original: &TaskSnapshot) -> AssistantResult<usize> {
        let index = state.find(&original.task_id)?;
        let entry = &state.tasks[index];
        if state.revision(task_id_of(entry)) != original.revision
            || js::stringify(&seal(entry)) != js::stringify(&original.prepared)
        {
            return Err(user("The task changed. Ask for a fresh preview."));
        }
        Ok(index)
    }

    fn assert_management(state: &State, operation: &str, index: usize) -> AssistantResult<()> {
        let entry = &state.tasks[index];
        let task_status = entry["task"]["status"].as_str().unwrap_or("");
        if operation == "delete" {
            if task_status != "cancelled" || State::current(entry).is_some() {
                return Err(user("Cancel this task before deleting its history."));
            }
            if state
                .run_owners
                .values()
                .any(|owner| owner == task_id_of(entry))
            {
                return Err(user(
                    "Cancel this task again to retry cleanup, or wait for its run to finish stopping before deleting its history.",
                ));
            }
        } else if task_status == "cancelled" && operation != "cancel" {
            return Err(user("This task was cancelled."));
        }
        Ok(())
    }

    /// `validate` with the manager's own cancellation and the caller's.
    async fn validate(
        &self,
        prepared: Value,
        signal: Option<CancellationToken>,
        cleanup: bool,
    ) -> AssistantResult<()> {
        let inner = self.inner();
        let combined = match &signal {
            Some(signal) => any_signal(&[signal, &inner.controller]),
            None => inner.controller.child_token(),
        };
        if combined.is_cancelled() {
            return Err(internal("The task permission check was cancelled."));
        }
        let check = match (cleanup, &inner.options.validate_cleanup) {
            (true, Some(cleanup)) => cleanup(prepared, combined.clone()),
            _ => (inner.options.validate)(prepared, combined.clone()),
        };
        // The check first: it sees its own cancellation, as its abort
        // listener runs in Bun.
        let result = tokio::select! {
            biased;
            result = check => result,
            _ = combined.cancelled() => Err(internal("The task permission check was cancelled.")),
        };
        result?;
        if combined.is_cancelled() {
            return Err(internal("The task permission check was cancelled."));
        }
        Ok(())
    }

    /// `check`: a validation that Pause, Stop and Cancel of the task end.
    async fn check(
        &self,
        id: &str,
        prepared: Value,
        signal: Option<CancellationToken>,
        cleanup: bool,
    ) -> AssistantResult<()> {
        let operation = CancellationToken::new();
        let key = {
            let mut state = self.0.state.lock().unwrap();
            state.next_check += 1;
            let key = state.next_check;
            state
                .checks
                .entry(id.to_owned())
                .or_default()
                .push((key, operation.clone()));
            key
        };
        let combined = match &signal {
            Some(signal) => any_signal(&[signal, &operation]),
            None => operation.clone(),
        };
        let result = self.validate(prepared, Some(combined), cleanup).await;
        let mut state = self.0.state.lock().unwrap();
        if let Some(pending) = state.checks.get_mut(id) {
            pending.retain(|(k, _)| *k != key);
            if pending.is_empty() {
                state.checks.remove(id);
            }
        }
        result
    }

    fn cancel_checks(&self, id: &str) {
        let state = self.0.state.lock().unwrap();
        for (_, check) in state.checks.get(id).into_iter().flatten() {
            check.cancel();
        }
    }

    fn track(&self, work: impl std::future::Future<Output = ()> + Send + 'static) {
        let handle = tokio::spawn(work);
        let mut state = self.0.state.lock().unwrap();
        state.jobs.retain(|job| !job.is_finished());
        state.jobs.push(handle);
    }

    /// `arm`: one timer, at the earliest due run.
    pub fn arm(&self) {
        let inner = self.inner();
        let mut state = inner.state.lock().unwrap();
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        if !state.enabled || state.disposed || state.invalid {
            return;
        }
        let now = inner.now_ms();
        let mut due: Vec<f64> = state
            .tasks
            .iter()
            .filter(|e| e["task"]["status"] == "active" && e["task"]["next_run_at"].is_string())
            .map(|e| js::date_parse(e["task"]["next_run_at"].as_str().unwrap()))
            .collect();
        if state.busy.is_some() {
            due.push((now + 5_000) as f64);
        } else {
            for entry in &state.tasks {
                let run = State::current(entry);
                let active = entry["task"]["status"] == "active";
                match run {
                    Some(run)
                        if status(run) == "queued"
                            && (active
                                || run["manual"] == true
                                || run.get("started_at").is_some()) =>
                    {
                        due.push(state.retry_at.get(id_of(run)).copied().unwrap_or(now) as f64);
                    }
                    None if active && entry.get("due_at").is_some() => due.push(now as f64),
                    _ => {}
                }
            }
        }
        let Some(first) = due.into_iter().filter(|d| !d.is_nan()).reduce(f64::min) else {
            return;
        };
        let wait = (first - now as f64).clamp(0.0, 2_147_483_647.0) as i64;
        let manager = self.clone();
        // The timer exists from now, as a `setTimeout` does.
        let sleep = inner.options.clock.sleep_until(now + wait);
        state.timer_generation += 1;
        let generation = state.timer_generation;
        state.timer = Some(tokio::spawn(async move {
            sleep.await;
            {
                let mut state = manager.0.state.lock().unwrap();
                if state.timer_generation != generation {
                    return;
                }
                state.timer = None;
            }
            let tick = manager.clone();
            manager.track(async move { tick.tick().await });
        }));
    }

    fn release_run(&self, run_id: &str) {
        let inner = self.inner();
        let remove = {
            let mut state = inner.state.lock().unwrap();
            if state.children.contains_key(run_id) || state.admissions.contains_key(run_id) {
                return;
            }
            let task_id = state.run_owners.remove(run_id);
            task_id.and_then(|task_id| {
                let entry = state.tasks.iter().find(|e| task_id_of(e) == task_id)?;
                (!entry["runs"]
                    .as_array()
                    .is_some_and(|runs| runs.iter().any(|r| id_of(r) == run_id)))
                .then(|| inner.run_directory(&task_id, Some(run_id)).ok())
                .flatten()
            })
        };
        if let Some(path) = remove {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    /// `disposeChild`: once per child; a failed one may be retried.
    fn dispose_child(&self, run_id: &str, child: &Arc<dyn ScheduledChild>) -> Disposal {
        let key = child_key(child);
        let mut state = self.0.state.lock().unwrap();
        if let Some((_, existing)) = state.child_disposals.get(&key) {
            return existing.clone();
        }
        // What a WeakMap would have let go: children no one else holds.
        state
            .child_disposals
            .retain(|_, (held, disposal)| Arc::strong_count(held) > 1 || disposal.peek().is_none());
        state.failed_disposals.remove(run_id);
        let manager = self.clone();
        let child_ref = child.clone();
        let (run_id, child) = (run_id.to_owned(), child.clone());
        let work: BoxFuture<AssistantResult<()>> = Box::pin(async move {
            let result = child.dispose().await;
            match result {
                Ok(()) => {
                    {
                        let mut state = manager.0.state.lock().unwrap();
                        if state
                            .children
                            .get(&run_id)
                            .is_some_and(|current| child_key(current) == key)
                        {
                            state.children.remove(&run_id);
                        }
                        state.failed_disposals.remove(&run_id);
                    }
                    manager.release_run(&run_id);
                    Ok(())
                }
                Err(error) => {
                    let mut state = manager.0.state.lock().unwrap();
                    state.failed_disposals.insert(run_id.clone());
                    state.child_disposals.remove(&key);
                    Err(error)
                }
            }
        });
        let shared = work.shared();
        state
            .child_disposals
            .insert(key, (child_ref, shared.clone()));
        drop(state);
        let tracked = shared.clone();
        self.track(async move {
            let _ = tracked.await;
        });
        shared
    }

    /// `finish(runId, snapshot)`: a child's state, recorded on its run.
    pub fn finish(&self, run_id: &str, snapshot: &Value) {
        let inner = self.inner();
        {
            let state = inner.state.lock().unwrap();
            if state.disposed || state.admissions.contains_key(run_id) {
                return;
            }
            match state.run(run_id) {
                Some(run) if ["running", "waiting"].contains(&status(run)) => {}
                _ => return,
            }
        }
        let error = snapshot.get("error").cloned().unwrap_or(Value::Null);
        if snapshot["running"] == true {
            let differs = inner
                .state
                .lock()
                .unwrap()
                .run(run_id)
                .is_some_and(|run| run["error"] != error);
            if differs {
                let _ = inner.change(|_, state| {
                    if let Some(run) = state.run_mut(run_id) {
                        run["error"] = error.clone();
                    }
                });
            }
            return;
        }
        let pending = snapshot["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| {
                m["actions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|a| a["status"] == "pending" || a["status"] == "executing")
            });
        let _ = inner.change(|inner, state| {
            let Some((t, r)) = state.run_location(run_id) else {
                return;
            };
            let now = inner.now();
            let run = &mut state.tasks[t]["runs"][r];
            run["error"] = error.clone();
            if pending {
                run["status"] = json!("waiting");
            } else {
                run["status"] = json!(if error.is_null() {
                    "succeeded"
                } else {
                    "failed"
                });
                run["finished_at"] = json!(now);
                compact(run);
                let entry = &state.tasks[t];
                if let Some(due) = entry
                    .get("due_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    && entry["task"]["status"] == "active"
                {
                    inner.queue(state, t, &due, false);
                    remove(&mut state.tasks[t], "due_at");
                }
            }
        });
        let child = {
            let mut state = inner.state.lock().unwrap();
            if state.busy.as_deref() == Some(run_id) {
                state.busy = None;
            }
            (!pending)
                .then(|| state.children.get(run_id).cloned())
                .flatten()
        };
        if let Some(child) = child {
            // Tracked by the manager; nothing waits for it here.
            drop(self.dispose_child(run_id, &child));
        }
        self.arm();
    }

    fn running(&self, run_id: &str) -> bool {
        let state = self.0.state.lock().unwrap();
        !state.disposed
            && state
                .run(run_id)
                .is_some_and(|run| ["running", "waiting"].contains(&status(run)))
    }

    fn clear_busy(&self, run_id: &str) {
        let mut state = self.0.state.lock().unwrap();
        if state.busy.as_deref() == Some(run_id) {
            state.busy = None;
        }
    }

    /// `launch(entry, run, recover)`.
    /// `launch(entry, run, recover)`: the model slot and the admission are
    /// taken at once, as Bun's synchronous start of `launch` does; the rest
    /// is the returned future.
    fn launch(&self, task_id: String, run_id: String, recover: bool) -> BoxFuture<()> {
        let admission = CancellationToken::new();
        {
            let mut state = self.0.state.lock().unwrap();
            state.busy = Some(run_id.clone());
            state.run_owners.insert(run_id.clone(), task_id.clone());
            state.admissions.insert(run_id.clone(), admission.clone());
            let manual = state.run(&run_id).is_some_and(|run| run["manual"] == true);
            if !recover && !manual {
                state.unstarted_admissions.insert(run_id.clone());
            }
        }
        let manager = self.clone();
        Box::pin(async move {
            manager
                .launch_run(task_id, run_id, recover, admission)
                .await
        })
    }

    async fn launch_run(
        &self,
        task_id: String,
        run_id: String,
        recover: bool,
        admission: CancellationToken,
    ) {
        let inner = self.inner();
        let mut child: Option<Arc<dyn ScheduledChild>> = None;
        let mut stage = "reading its saved run";
        let result: AssistantResult<()> = async {
            inner.change(|inner, state| {
                state.retry_at.remove(&run_id);
                let now = inner.now();
                if let Some(run) = state.run_mut(&run_id) {
                    run["status"] = json!("running");
                    if run.get("started_at").is_none() {
                        run["started_at"] = json!(now);
                    }
                    run["error"] = Value::Null;
                }
            })?;
            let run = inner.state.lock().unwrap().run(&run_id).cloned().unwrap_or(Value::Null);
            if !valid_prepared(&run) {
                return Err(user(
                    "Its saved workspaces or settings are invalid. Edit the task to choose them again.",
                ));
            }
            // Admission may wait on connections: stopping Ranger ends that too.
            let admitting = any_signal(&[&admission, &inner.controller]);
            stage = "checking its workspaces";
            let all = run["input"]["all_workspaces"] == true;
            if !recover && all && let Some(rescope) = inner.options.rescope.clone() {
                let rescoped = rescope(seal(&run), admitting.clone()).await?;
                let fresh = seal(&rescoped);
                if !self.running(&run_id) {
                    self.clear_busy(&run_id);
                    return Ok(());
                }
                let unscoped = |input: &Value| {
                    let mut input = input.clone();
                    input["scope"] = json!([]);
                    input["mentions"] = json!([]);
                    js::stringify(&input)
                };
                inner.change(|_, state| {
                    let Some((t, r)) = state.run_location(&run_id) else {
                        return;
                    };
                    let run = &mut state.tasks[t]["runs"][r];
                    assign(run, &fresh);
                    if let Some(notice) = rescoped.get("notice") {
                        run["notice"] = notice.clone();
                    }
                    // The task shows them too, unless it was edited since.
                    if unscoped(&state.tasks[t]["input"]) == unscoped(&fresh["input"]) {
                        let next = rescoped_entry(&state.tasks[t], &fresh);
                        assign(&mut state.tasks[t], &next);
                        let id = task_id_of(&state.tasks[t]).to_owned();
                        state.bump(&id);
                    }
                })?;
            } else if !recover && !all && let Some(narrow) = inner.options.narrow.clone() {
                // A new run over fixed workspaces runs over those still open.
                let narrowed = narrow(seal(&run), Some(admitting.clone()), true).await?;
                if !self.running(&run_id) {
                    self.clear_busy(&run_id);
                    return Ok(());
                }
                if let Some(narrowed) = narrowed {
                    inner.change(|_, state| {
                        let Some((t, r)) = state.run_location(&run_id) else {
                            return;
                        };
                        let run = &mut state.tasks[t]["runs"][r];
                        assign(run, &seal(&narrowed));
                        run["notice"] = narrowed.get("notice").cloned().unwrap_or(Value::Null);
                        // A workspace found again after its Herdr restarted is the
                        // same one: the task keeps it under the new server identity.
                        let mut bumped = false;
                        for target in state.tasks[t]["targets"].as_array_mut().into_iter().flatten() {
                            let found = narrowed["targets"].as_array().into_iter().flatten().find(|item| {
                                ref_key(item) == ref_key(target)
                                    && item["endpoint_fingerprint"] == target["endpoint_fingerprint"]
                                    && item["workspace_identity"] == target["workspace_identity"]
                            });
                            if let Some(found) = found
                                && found["herdr_boot_id"] != target["herdr_boot_id"]
                            {
                                target["herdr_boot_id"] = found["herdr_boot_id"].clone();
                                bumped = true;
                            }
                        }
                        if bumped {
                            let id = task_id_of(&state.tasks[t]).to_owned();
                            state.bump(&id);
                        }
                    })?;
                }
            }
            stage = "checking its permissions, workspaces and model";
            let run = inner.state.lock().unwrap().run(&run_id).cloned().unwrap_or(Value::Null);
            self.validate(run.clone(), Some(admission.clone()), false).await?;
            if !self.running(&run_id) {
                self.clear_busy(&run_id);
                return Ok(());
            }
            stage = "starting its run";
            let directory = inner.run_directory(&task_id, Some(&run_id))?;
            let publish: Publish = {
                let manager = self.clone();
                let run_id = run_id.clone();
                Arc::new(move |snapshot| manager.finish(&run_id, &snapshot))
            };
            let before: BeforeDispatch = {
                let manager = self.clone();
                let (run_id, task_id, admission) = (run_id.clone(), task_id.clone(), admission.clone());
                Arc::new(move || {
                    if admission.is_cancelled() {
                        return Err(internal("Scheduled task stopped"));
                    }
                    let mut state = manager.0.state.lock().unwrap();
                    let active = state
                        .tasks
                        .iter()
                        .find(|e| task_id_of(e) == task_id)
                        .is_some_and(|e| e["task"]["status"] == "active");
                    if state.unstarted_admissions.contains(&run_id) && !active {
                        return Err(internal("Scheduled task paused before dispatch"));
                    }
                    state.unstarted_admissions.remove(&run_id);
                    Ok(())
                })
            };
            let made = (inner.options.child)(run, directory, publish, before);
            inner.state.lock().unwrap().children.insert(run_id.clone(), made.clone());
            child = Some(made.clone());
            made.start(recover).await?;
            let disposed = {
                let mut state = inner.state.lock().unwrap();
                state.admissions.remove(&run_id);
                state.disposed
            };
            if !disposed {
                self.finish(&run_id, &made.snapshot());
            }
            Ok(())
        }
        .await;
        if let Err(error) = result
            && self.running(&run_id)
        {
            if matches!(error, AssistantError::RecoveryNotReady(_)) {
                if let Some(child) = &child {
                    let _ = self.dispose_child(&run_id, child).await;
                }
                if self.running(&run_id) {
                    let _ = inner.change(|_, state| {
                        if let Some(run) = state.run_mut(&run_id) {
                            run["status"] = json!("queued");
                            run["error"] = json!(
                                "Waiting for the original workspace connection to become ready."
                            );
                            // An admitted run keeps its checkpoint and start time.
                            if !recover {
                                remove(run, "started_at");
                            }
                        }
                    });
                    let at = inner.now_ms() + 5_000;
                    inner
                        .state
                        .lock()
                        .unwrap()
                        .retry_at
                        .insert(run_id.clone(), at);
                }
            } else {
                let verb = if recover { "resume" } else { "start" };
                let message = match &error {
                    AssistantError::ServerRestarted { connection, .. } if recover => format!(
                        "This run could not safely resume: Herdr on {connection} restarted since it started. Start a fresh run instead."
                    ),
                    AssistantError::User(_) | AssistantError::ServerRestarted { .. } => {
                        format!("The task could not safely {verb}: {}", error.message())
                    }
                    _ => format!(
                        "The task could not safely {verb}: an unexpected error while {stage}. Run it again; if it keeps failing, edit the task to choose its workspaces and model again."
                    ),
                };
                let _ = inner.change(|inner, state| {
                    let now = inner.now();
                    if let Some(run) = state.run_mut(&run_id) {
                        run["status"] = json!("failed");
                        run["error"] = json!(message);
                        run["finished_at"] = json!(now);
                        compact(run);
                    }
                });
                self.clear_busy(&run_id);
                if let Some(child) = &child {
                    let _ = self.dispose_child(&run_id, child).await;
                }
            }
        }
        let queued = inner
            .state
            .lock()
            .unwrap()
            .run(&run_id)
            .is_some_and(|run| status(run) == "queued");
        if let Some(child) = &child
            && queued
            && admission.is_cancelled()
        {
            let _ = self.dispose_child(&run_id, child).await;
        }
        {
            let mut state = inner.state.lock().unwrap();
            state.unstarted_admissions.remove(&run_id);
            state.admissions.remove(&run_id);
        }
        self.release_run(&run_id);
        {
            let mut state = inner.state.lock().unwrap();
            if !state.children.contains_key(&run_id) && state.busy.as_deref() == Some(&run_id) {
                state.busy = None;
            }
        }
        self.arm();
    }

    /// `tick`: due tasks queued, then one run launched (or the busy one
    /// resumed).
    pub fn tick(&self) -> BoxFuture<()> {
        let manager = self.clone();
        Box::pin(async move { manager.tick_once().await })
    }

    async fn tick_once(&self) {
        let inner = self.inner();
        {
            let state = inner.state.lock().unwrap();
            if !state.enabled || state.disposed || state.invalid {
                return;
            }
        }
        let time = inner.now_ms();
        let (due, deferred): (Vec<String>, Vec<String>) = {
            let state = inner.state.lock().unwrap();
            let due = state
                .tasks
                .iter()
                .filter(|e| {
                    e["task"]["status"] == "active"
                        && e["task"]["next_run_at"]
                            .as_str()
                            .is_some_and(|n| js::date_parse(n) <= time as f64)
                })
                .map(|e| task_id_of(e).to_owned())
                .collect();
            let deferred = state
                .tasks
                .iter()
                .filter(|e| {
                    e["task"]["status"] == "active"
                        && e.get("due_at").is_some()
                        && State::current(e).is_none()
                })
                .map(|e| task_id_of(e).to_owned())
                .collect();
            (due, deferred)
        };
        if !due.is_empty() || !deferred.is_empty() {
            let _ = inner.change(|inner, state| {
                // A startup failure or restart can leave a coalesced occurrence
                // with no active run: claim it once before newer deadlines.
                for id in &deferred {
                    let Some(t) = state.tasks.iter().position(|e| task_id_of(e) == id) else {
                        continue;
                    };
                    let due = state.tasks[t]["due_at"].as_str().unwrap_or("").to_owned();
                    inner.queue(state, t, &due, false);
                    remove(&mut state.tasks[t], "due_at");
                }
                for id in &due {
                    let Some(t) = state.tasks.iter().position(|e| task_id_of(e) == id) else {
                        continue;
                    };
                    let scheduled = state.tasks[t]["task"]["next_run_at"].clone();
                    let next = inner.next_after(&state.tasks[t], time).ok().flatten();
                    state.tasks[t]["task"]["next_run_at"] =
                        next.map_or(Value::Null, |n| json!(js::iso(n)));
                    let active = State::current(&state.tasks[t]).cloned();
                    match active {
                        Some(active)
                            if status(&active) != "queued"
                                || active["manual"] == true
                                || active.get("started_at").is_some() =>
                        {
                            if state.tasks[t].get("due_at").is_none() {
                                state.tasks[t]["due_at"] = scheduled;
                            }
                        }
                        Some(_) => continue,
                        None => {
                            let scheduled = scheduled.as_str().unwrap_or("").to_owned();
                            inner.queue(state, t, &scheduled, false);
                        }
                    }
                }
            });
        }
        let busy = inner.state.lock().unwrap().busy.clone();
        if let Some(busy) = busy {
            let child = inner.state.lock().unwrap().children.get(&busy).cloned();
            if let Some(child) = child {
                let _ = child.resume().await;
            }
        } else {
            let next = {
                let guard = inner.state.lock().unwrap();
                let state: &State = &guard;
                let mut queued: Vec<(String, String, String, bool)> = state
                    .tasks
                    .iter()
                    .flat_map(|entry| {
                        let active = entry["task"]["status"] == "active";
                        let task_id = task_id_of(entry).to_owned();
                        entry["runs"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(move |run| {
                                status(run) == "queued"
                                    && state.retry_at.get(id_of(run)).copied().unwrap_or(0) <= time
                                    && (active
                                        || run["manual"] == true
                                        || run.get("started_at").is_some())
                            })
                            .map(move |run| {
                                (
                                    run["scheduled_at"].as_str().unwrap_or("").to_owned(),
                                    task_id.clone(),
                                    id_of(run).to_owned(),
                                    run.get("started_at").is_some(),
                                )
                            })
                    })
                    .collect();
                queued.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
                queued.into_iter().next()
            };
            if let Some((_, task_id, run_id, recover)) = next {
                let launch = self.launch(task_id, run_id, recover);
                self.track(launch);
            }
        }
        self.arm();
    }

    pub fn notification_history(
        &self,
        task_id: &str,
        run_id: Option<&str>,
    ) -> AssistantResult<Vec<Value>> {
        let state = self.0.state.lock().unwrap();
        let entry = &state.tasks[state.find(task_id)?];
        let run = run_id.and_then(|id| {
            entry["runs"]
                .as_array()
                .and_then(|runs| runs.iter().find(|r| id_of(r) == id))
        });
        if run_id.is_some() && !run.is_some_and(valid_prepared) {
            return Err(internal("The original task run is no longer available."));
        }
        let source = run.unwrap_or(entry);
        let key = run_scope_key(&source["input"], &source["targets"]);
        Ok(entry
            .get("notifications")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter(|n| n["scope_key"] == key.as_str())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The run's task and the run, while it is active.
    fn active_run(
        &self,
        task_id: &str,
        run_id: &str,
        signal: Option<&CancellationToken>,
    ) -> AssistantResult<(usize, Value)> {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(internal("aborted"));
        }
        let state = self.0.state.lock().unwrap();
        let index = state.find(task_id)?;
        let entry = &state.tasks[index];
        let run = entry["runs"]
            .as_array()
            .and_then(|runs| runs.iter().find(|r| id_of(r) == run_id));
        match run {
            Some(run)
                if !state.disposed
                    && entry["task"]["status"] != "cancelled"
                    && status(run) == "running"
                    && valid_prepared(run) =>
            {
                Ok((index, run.clone()))
            }
            _ => Err(internal("The original task run is no longer active.")),
        }
    }

    /// `notifyRun`: a custom notification of a confirmed task's run, once
    /// per event and run, saved before it is sent.
    pub async fn notify_run(
        &self,
        task_id: &str,
        run_id: &str,
        input: &Value,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<ToolResult> {
        let inner = self.inner();
        let Some(notify) = inner.options.notify.clone() else {
            return Err(internal("Task notifications are unavailable or invalid."));
        };
        if !is_notification_input(input) {
            return Err(internal("Task notifications are unavailable or invalid."));
        }
        let notification = input.clone();
        let (_, run) = self.active_run(task_id, run_id, signal.as_ref())?;
        self.check(task_id, seal(&run), signal.clone(), false)
            .await?;
        let (_, run) = self.active_run(task_id, run_id, signal.as_ref())?;
        let scope_key = run_scope_key(&run["input"], &run["targets"]);
        {
            let state = inner.state.lock().unwrap();
            let entry = &state.tasks[state.find(task_id)?];
            let list = entry.get("notifications").and_then(Value::as_array);
            if list.is_some_and(|l| {
                l.iter().any(|p| {
                    p["scope_key"] == scope_key.as_str()
                        && p["event_key"] == notification["event_key"]
                })
            }) {
                return Ok(ToolResult::text(js::stringify(
                    &json!({"accepted": false, "reason": "already_notified"}),
                )));
            }
            if list.is_some_and(|l| l.iter().any(|p| p["run_id"] == run_id)) {
                return Ok(ToolResult::text(js::stringify(
                    &json!({"accepted": false, "reason": "run_limit"}),
                )));
            }
        }
        inner.change(|inner, state| {
            let now = inner.now();
            if let Ok(index) = state.find(task_id) {
                let entry = &mut state.tasks[index];
                let mut list = entry
                    .get("notifications")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut receipt = notification.as_object().cloned().unwrap_or_default();
                receipt.insert("scope_key".into(), json!(scope_key));
                receipt.insert("run_id".into(), json!(run_id));
                receipt.insert("created_at".into(), json!(now));
                list.push(Value::Object(receipt));
                let start = list.len().saturating_sub(MAX_NOTIFICATIONS);
                entry["notifications"] = Value::Array(list.split_off(start));
            }
        })?;
        let _ = notify(json!({
            "task_id": task_id,
            "run_id": run_id,
            "status": if notification["kind"] == "completed" { "succeeded" } else { "waiting" },
            "title": notification["title"],
            "body": notification["body"],
        }));
        Ok(ToolResult::text(js::stringify(
            &json!({"accepted": true, "delivery": "best_effort"}),
        )))
    }

    pub fn proposal(&self, id: &str) -> Option<Value> {
        let state = self.0.state.lock().unwrap();
        state
            .proposals
            .iter()
            .find(|entry| entry["proposal"]["id"] == id)
            .map(|entry| entry["proposal"].clone())
    }

    /// `create(prepared, requestId)`.
    pub async fn create(&self, prepared: &Value, request_id: &str) -> AssistantResult<Value> {
        if !is_uuid(request_id) {
            return Err(internal("Invalid task request identifier"));
        }
        let sealed = seal(prepared);
        self.validate(sealed.clone(), None, false).await?;
        let index = self
            .inner()
            .try_change(|inner, state| inner.insert(state, &sealed, request_id))?;
        let summary = {
            let state = self.0.state.lock().unwrap();
            Inner::summary(&state.tasks[index])
        };
        self.arm();
        Ok(summary)
    }

    /// `update(id, prepared, original = snapshot(id))`.
    pub async fn update(
        &self,
        id: &str,
        prepared: &Value,
        original: Option<TaskSnapshot>,
    ) -> AssistantResult<()> {
        let original = match original {
            Some(original) => original,
            None => self.snapshot(id)?,
        };
        if original.task_id != id {
            return Err(internal("Invalid task snapshot"));
        }
        let task_id = {
            let state = self.0.state.lock().unwrap();
            let index = Self::unchanged(&state, &original)?;
            Self::assert_management(&state, "update", index)?;
            task_id_of(&state.tasks[index]).to_owned()
        };
        let sealed = seal(prepared);
        self.check(&task_id, sealed.clone(), None, false).await?;
        {
            let state = self.0.state.lock().unwrap();
            let index = Self::unchanged(&state, &original)?;
            Self::assert_management(&state, "update", index)?;
        }
        self.inner().try_change(|inner, state| {
            let index = Self::unchanged(state, &original)?;
            inner.update_entry(&mut state.tasks[index], &sealed)
        })?;
        self.arm();
        Ok(())
    }

    /// `proposeManagement`: a preview of an operation on a task.
    pub async fn propose_management(
        &self,
        operation: &str,
        id: &str,
        changes: &Value,
        assert_scope: AssertScope,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<Value> {
        let aborted = || signal.as_ref().is_some_and(CancellationToken::is_cancelled);
        if aborted() {
            return Err(internal("aborted"));
        }
        let original = self.snapshot(id)?;
        assert_scope(&original.prepared)?;
        {
            let state = self.0.state.lock().unwrap();
            let index = Self::unchanged(&state, &original)?;
            Self::assert_management(&state, operation, index)?;
        }
        let fields: Vec<&String> = changes
            .as_object()
            .map(|m| m.keys().collect())
            .unwrap_or_default();
        let bad = if operation == "update" {
            fields.is_empty()
                || fields.iter().any(|f| {
                    !["title", "prompt", "schedule", "notification_mode"].contains(&f.as_str())
                })
        } else {
            !fields.is_empty()
        };
        if bad {
            return Err(user("Invalid task edit fields."));
        }
        let mut prepared = seal(&original.prepared);
        if operation == "update" {
            let mut input = prepared["input"].clone();
            assign(&mut input, changes);
            prepared["input"] = validate_task_input(&input)?;
        }
        let cleanup = ["pause", "cancel", "delete"].contains(&operation);
        self.check(
            &original.task_id,
            seal(&original.prepared),
            signal.clone(),
            cleanup,
        )
        .await?;
        if operation == "update" {
            self.check(&original.task_id, seal(&prepared), signal.clone(), false)
                .await?;
        }
        if aborted() {
            return Err(internal("aborted"));
        }
        assert_scope(&original.prepared)?;
        {
            let state = self.0.state.lock().unwrap();
            let index = Self::unchanged(&state, &original)?;
            Self::assert_management(&state, operation, index)?;
            if state.retained_proposals().len() >= MAX_PROPOSALS {
                return Err(user("Too many pending task proposals."));
            }
        }
        let mut proposal = prepared["input"].as_object().cloned().unwrap_or_default();
        proposal.insert("id".into(), json!(random_uuid()));
        proposal.insert("operation".into(), json!(operation));
        proposal.insert("task_id".into(), json!(original.task_id));
        proposal.insert("status".into(), json!("pending"));
        proposal.insert("created_at".into(), json!(self.inner().now()));
        let proposal = Value::Object(proposal);
        self.inner().change(|_, state| {
            state.proposals = state.retained_proposals();
            state
                .proposals
                .push(json!({"prepared": prepared, "proposal": proposal}));
        })?;
        let mut state = self.0.state.lock().unwrap();
        let expires = self.inner().now_ms() + MANAGEMENT_PREVIEW_MS;
        state.management_guards.insert(
            id_of(&proposal).to_owned(),
            Guard {
                snapshot: original,
                assert_scope,
                expires,
            },
        );
        let pending: HashSet<String> = state
            .proposals
            .iter()
            .filter(|e| e["proposal"]["status"] == "pending")
            .map(|e| id_of(&e["proposal"]).to_owned())
            .collect();
        state.management_guards.retain(|id, _| pending.contains(id));
        Ok(proposal)
    }

    /// `propose(prepared)`: a preview of a new task.
    pub async fn propose(
        &self,
        prepared: &Value,
        signal: Option<CancellationToken>,
    ) -> AssistantResult<Value> {
        let sealed = seal(prepared);
        self.validate(sealed.clone(), signal, false).await?;
        if self.0.state.lock().unwrap().retained_proposals().len() >= MAX_PROPOSALS {
            return Err(user("Too many pending task proposals."));
        }
        let mut proposal = sealed["input"].as_object().cloned().unwrap_or_default();
        proposal.insert("id".into(), json!(random_uuid()));
        proposal.insert("status".into(), json!("pending"));
        proposal.insert("created_at".into(), json!(self.inner().now()));
        let proposal = Value::Object(proposal);
        self.inner().change(|_, state| {
            state.proposals = state.retained_proposals();
            state
                .proposals
                .push(json!({"prepared": sealed, "proposal": proposal}));
        })?;
        Ok(proposal)
    }

    fn proposal_entry(&self, id: &str) -> Option<Value> {
        let state = self.0.state.lock().unwrap();
        state
            .proposals
            .iter()
            .find(|e| e["proposal"]["id"] == id)
            .cloned()
    }

    fn set_proposal(state: &mut State, id: &str, update: impl FnOnce(&mut Value)) {
        if let Some(entry) = state
            .proposals
            .iter_mut()
            .find(|e| e["proposal"]["id"] == id)
        {
            update(&mut entry["proposal"]);
        }
    }

    /// `confirmProposal(id, authorized?)`.
    pub async fn confirm_proposal(
        &self,
        id: &str,
        authorized: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> AssistantResult<()> {
        let inner = self.inner();
        let Some(entry) = self.proposal_entry(id) else {
            return Err(internal("This task proposal is no longer available."));
        };
        if entry["proposal"]["status"] != "pending" {
            return Ok(());
        }
        let operation = entry["proposal"]
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("create")
            .to_owned();
        let check_key = format!("proposal:{id}");
        if operation != "create" {
            let assert_fresh = || -> AssistantResult<usize> {
                let state = inner.state.lock().unwrap();
                let Some(guard) = state
                    .management_guards
                    .get(id)
                    .filter(|g| !state.disposed && inner.now_ms() < g.expires)
                else {
                    return Err(user("This task preview expired. Ask for a fresh preview."));
                };
                (guard.assert_scope)(&guard.snapshot.prepared)?;
                let index = Self::unchanged(&state, &guard.snapshot)?;
                Self::assert_management(&state, &operation, index)?;
                Ok(index)
            };
            assert_fresh()?;
            let snapshot_prepared = inner.state.lock().unwrap().management_guards[id]
                .snapshot
                .prepared
                .clone();
            let mut sealed = seal(&entry["prepared"]);
            let cleanup = ["pause", "cancel", "delete"].contains(&operation.as_str());
            self.check(&check_key, seal(&snapshot_prepared), None, cleanup)
                .await?;
            if operation == "update" {
                self.check(&check_key, sealed.clone(), None, false).await?;
            }
            if authorized.as_ref().is_some_and(|ok| !ok()) {
                return Ok(());
            }
            match self.proposal_entry(id) {
                Some(entry) if entry["proposal"]["status"] == "pending" => {
                    if js::stringify(&entry["prepared"]) != js::stringify(&sealed) {
                        return Err(internal(
                            "The task proposal changed. Ask for a fresh preview.",
                        ));
                    }
                }
                _ => return Ok(()),
            }
            // A manual edit authorizes this new prompt, not future automatic effects.
            if operation == "update" && authorized.is_none() {
                sealed["config"]["approval_mode"] = json!("manual");
            }
            let index = assert_fresh()?;
            let (task_id, active) = {
                let state = inner.state.lock().unwrap();
                let entry = &state.tasks[index];
                (task_id_of(entry).to_owned(), State::current_id(entry))
            };
            // Every precondition before changing either the task or the receipt.
            if operation == "delete" {
                inner.run_directory(&task_id, None)?;
            }
            inner
                .state
                .lock()
                .unwrap()
                .finalizing_proposals
                .insert(id.to_owned());
            let outcome = async {
                inner.try_change(|inner, state| {
                    let index = state.find(&task_id)?;
                    match operation.as_str() {
                        "update" => inner.update_entry(&mut state.tasks[index], &sealed)?,
                        "delete" => delete_entry(state, &task_id),
                        _ => inner.control_entry(state, &operation, index, active.as_deref()),
                    }
                    Self::set_proposal(state, id, |p| p["status"] = json!("confirmed"));
                    Ok(())
                })?;
                inner.state.lock().unwrap().management_guards.remove(id);
                let finished = if operation == "delete" {
                    self.remove_history(&task_id)
                } else if operation != "update" {
                    self.finish_control(&operation, &task_id, active.clone()).await
                } else {
                    Ok(())
                };
                if finished.is_err() {
                    let detail = if operation == "delete" {
                        "The task was deleted, but its private history could not be removed."
                    } else {
                        "The task was cancelled, but its active run could not be fully stopped. Review it before deleting its history."
                    };
                    let _ = inner.change(|_, state| {
                        Self::set_proposal(state, id, |p| p["detail"] = json!(detail));
                    });
                    return Err(user(detail));
                }
                self.arm();
                Ok(())
            }
            .await;
            inner.state.lock().unwrap().finalizing_proposals.remove(id);
            return outcome;
        }
        let mut sealed = seal(&entry["prepared"]);
        self.check(&check_key, sealed.clone(), None, false).await?;
        if authorized.as_ref().is_some_and(|ok| !ok()) {
            return Ok(());
        }
        match self.proposal_entry(id) {
            Some(entry) if entry["proposal"]["status"] == "pending" => {
                if js::stringify(&entry["prepared"]) != js::stringify(&sealed) {
                    return Err(internal(
                        "The task proposal changed. Ask for a fresh preview.",
                    ));
                }
            }
            _ => return Ok(()),
        }
        // Manual confirmation does not authorize future automatic effects.
        if authorized.is_none() {
            sealed["config"]["approval_mode"] = json!("manual");
        }
        inner.try_change(|inner, state| {
            let index = inner.insert(state, &sealed, &check_key)?;
            let task_id = state.tasks[index]["task"]["id"].clone();
            Self::set_proposal(state, id, |p| {
                p["status"] = json!("confirmed");
                p["task_id"] = task_id;
            });
            Ok(())
        })?;
        self.arm();
        Ok(())
    }

    pub fn cancel_proposal(&self, id: &str) {
        let pending = self
            .proposal_entry(id)
            .is_some_and(|e| e["proposal"]["status"] == "pending");
        if !pending {
            return;
        }
        let _ = self.inner().change(|_, state| {
            Self::set_proposal(state, id, |p| p["status"] = json!("cancelled"));
        });
        self.0.state.lock().unwrap().management_guards.remove(id);
        self.cancel_checks(&format!("proposal:{id}"));
    }

    fn remove_history(&self, task_id: &str) -> AssistantResult<()> {
        let result = self
            .inner()
            .run_directory(task_id, None)
            .and_then(|path| match std::fs::remove_dir_all(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(internal(&error.to_string())),
            })
            .map_err(|_| {
                user("The task was deleted, but its private history could not be removed.")
            });
        self.arm();
        result
    }

    /// `finishControl`: what a control does once it is saved.
    async fn finish_control(
        &self,
        method: &str,
        task_id: &str,
        active: Option<String>,
    ) -> AssistantResult<()> {
        let inner = self.inner();
        if ["cancel", "stop", "pause"].contains(&method) {
            self.cancel_checks(task_id);
        }
        if method == "pause"
            && let Some(active) = &active
        {
            let state = inner.state.lock().unwrap();
            if state.unstarted_admissions.contains(active)
                && let Some(admission) = state.admissions.get(active)
            {
                admission.cancel();
            }
        }
        let mut outcome = Ok(());
        if (method == "cancel" || method == "stop")
            && let Some(active) = &active
        {
            let child = {
                let state = inner.state.lock().unwrap();
                if let Some(admission) = state.admissions.get(active) {
                    admission.cancel();
                }
                state.children.get(active).cloned()
            };
            let stopped = match &child {
                Some(child) => child.stop().await,
                None => Ok(()),
            };
            // A failed disposal ends here, as its throw from Bun's finally:
            // the model slot stays taken until a retry drains the child.
            if let Some(child) = &child {
                self.dispose_child(active, child).await?;
            }
            self.clear_busy(active);
            let _ = inner.change(|_, state| {
                if let Some(run) = state.run_mut(active) {
                    compact(run);
                }
            });
            self.arm();
            outcome = stopped;
        }
        // A previous disposal failure keeps history protected; Cancel and
        // Stop retry it without replaying a finalised proposal.
        if method == "cancel" || method == "stop" {
            let failed: Vec<String> = inner
                .state
                .lock()
                .unwrap()
                .failed_disposals
                .iter()
                .cloned()
                .collect();
            for run_id in failed {
                let child = {
                    let state = inner.state.lock().unwrap();
                    (state.run_owners.get(&run_id).map(String::as_str) == Some(task_id))
                        .then(|| state.children.get(&run_id).cloned())
                        .flatten()
                };
                if let Some(child) = child {
                    self.dispose_child(&run_id, &child).await?;
                    self.clear_busy(&run_id);
                    let stopped = inner
                        .state
                        .lock()
                        .unwrap()
                        .run(&run_id)
                        .is_some_and(|r| status(r) == "stopped");
                    if stopped {
                        let _ = inner.change(|_, state| {
                            if let Some(run) = state.run_mut(&run_id) {
                                compact(run);
                            }
                        });
                    }
                }
            }
        }
        outcome?;
        if method == "resume" {
            let children: Vec<(String, Arc<dyn ScheduledChild>)> = {
                let mut state = inner.state.lock().unwrap();
                if !state.started || state.disposed {
                    Vec::new()
                } else {
                    state.enabled = true;
                    state.fault = None;
                    state
                        .children
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect()
                }
            };
            if !children.is_empty() || inner.state.lock().unwrap().enabled {
                for (run_id, child) in children {
                    self.finish(&run_id, &child.snapshot());
                }
                inner.publish();
            }
        }
        self.arm();
        Ok(())
    }

    /// `control(method, id)`: pause, resume, cancel, run now or stop.
    pub async fn control(&self, method: &str, id: &str) -> AssistantResult<()> {
        let inner = self.inner();
        let (version, sealed) = {
            let state = inner.state.lock().unwrap();
            let index = state.find(id)?;
            let entry = &state.tasks[index];
            if entry["task"]["status"] == "cancelled" && !["cancel", "stop"].contains(&method) {
                return Err(internal("This task was cancelled."));
            }
            (state.revision(id), seal(entry))
        };
        if method == "resume" || method == "run_now" {
            let all = sealed["input"]["all_workspaces"] == true;
            // Tasks over all workspaces check their fresh scope in launch;
            // fixed ones run over the workspaces still open.
            if !all || inner.options.rescope.is_none() {
                let checked = async {
                    let narrowed = match (&inner.options.narrow, all) {
                        (Some(narrow), false) => narrow(sealed.clone(), None, false).await?,
                        _ => None,
                    };
                    self.check(id, narrowed.unwrap_or_else(|| sealed.clone()), None, false)
                        .await
                }
                .await;
                if let Err(error) = checked {
                    // None of its connections is up yet: the run waits.
                    if method != "run_now" || !matches!(error, AssistantError::RecoveryNotReady(_))
                    {
                        return Err(error);
                    }
                }
            }
            let state = inner.state.lock().unwrap();
            let index = state.find(id)?;
            let entry = &state.tasks[index];
            if entry["task"]["status"] == "cancelled" {
                return Err(internal("This task was cancelled."));
            }
            if state.revision(id) != version {
                if method == "run_now"
                    && State::current(entry).is_some()
                    && js::stringify(&seal(entry)) == js::stringify(&sealed)
                {
                    return Ok(());
                }
                return Err(internal(
                    "The task changed during permission checks. Review it and try again.",
                ));
            }
        }
        let active = {
            let state = inner.state.lock().unwrap();
            State::current_id(&state.tasks[state.find(id)?])
        };
        inner.try_change(|inner, state| {
            let index = state.find(id)?;
            inner.control_entry(state, method, index, active.as_deref());
            Ok(())
        })?;
        self.finish_control(method, id, active).await
    }

    /// `revalidate`: running tasks whose permission went are stopped.
    pub async fn revalidate(&self) {
        let running: Vec<(String, Value)> = {
            let state = self.0.state.lock().unwrap();
            state
                .tasks
                .iter()
                .filter_map(|entry| {
                    let run = State::current(entry)?;
                    state
                        .children
                        .contains_key(id_of(run))
                        .then(|| (task_id_of(entry).to_owned(), run.clone()))
                })
                .collect()
        };
        for (task_id, run) in running {
            let valid =
                valid_prepared(&run) && self.validate(run.clone(), None, false).await.is_ok();
            if !valid {
                let _ = self.control("stop", &task_id).await;
                let _ = self.inner().change(|_, state| {
                    if let Some(run) = state.run_mut(id_of(&run)) {
                        run["error"] = json!(
                            "The original task permission, workspace identity or model is no longer available."
                        );
                    }
                });
            }
        }
    }

    /// `delete(id)`: a cancelled task and its private history.
    pub fn delete(&self, id: &str) -> AssistantResult<()> {
        let inner = self.inner();
        {
            let state = inner.state.lock().unwrap();
            let index = state.find(id)?;
            Self::assert_management(&state, "delete", index)?;
        }
        inner.run_directory(id, None)?;
        inner.change(|_, state| delete_entry(state, id))?;
        self.remove_history(id)
    }

    /// `action(method, taskId, runId, actionId)`: a waiting run's preview.
    pub async fn action(
        &self,
        method: &str,
        task_id: &str,
        run_id: &str,
        action_id: &str,
    ) -> AssistantResult<()> {
        let inner = self.inner();
        let (child, run, version) = {
            let state = inner.state.lock().unwrap();
            let entry = &state.tasks[state.find(task_id)?];
            let run = entry["runs"]
                .as_array()
                .and_then(|runs| {
                    runs.iter()
                        .find(|r| id_of(r) == run_id && status(r) == "waiting")
                })
                .cloned();
            let Some(run) = run else {
                return Err(internal("This task preview has expired."));
            };
            let Some(child) = state.children.get(run_id).cloned() else {
                return Err(internal(
                    "This task preview has expired. Ask for a fresh preview.",
                ));
            };
            if !valid_prepared(&run) {
                return Err(internal("Invalid task scope"));
            }
            (child, run, state.revision(task_id))
        };
        if method == "confirm" {
            self.check(task_id, seal(&run), None, false).await?;
        }
        {
            let state = inner.state.lock().unwrap();
            let entry = &state.tasks[state.find(task_id)?];
            let waiting = entry["runs"].as_array().is_some_and(|runs| {
                runs.iter()
                    .any(|r| id_of(r) == run_id && status(r) == "waiting")
            });
            let same = state
                .children
                .get(run_id)
                .is_some_and(|c| child_key(c) == child_key(&child));
            if state.revision(task_id) != version || !waiting || !same {
                return Err(internal(
                    "This task preview changed or was cancelled. Review it again.",
                ));
            }
        }
        child.action(method, action_id).await?;
        self.finish(run_id, &child.snapshot());
        Ok(())
    }

    /// `detail(taskId, runId?)`: a task, its runs, and one run's messages.
    pub fn detail(&self, task_id: &str, run_id: Option<&str>) -> AssistantResult<Value> {
        let inner = self.inner();
        // The child's snapshot is read unlocked: the child's own state may
        // wait on the service's, which reads the tasks'.
        let child = run_id.and_then(|run_id| {
            let state = inner.state.lock().unwrap();
            state.children.get(run_id).cloned()
        });
        let child_messages = child.as_ref().map(|c| c.snapshot()["messages"].clone());
        let state = inner.state.lock().unwrap();
        let entry = &state.tasks[state.find(task_id)?];
        let runs: Vec<Value> = entry["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(receipt)
            .collect();
        let mut out = json!({"task": Inner::summary(entry), "runs": runs});
        let Some(run_id) = run_id else {
            return Ok(out);
        };
        let Some(run) = entry["runs"]
            .as_array()
            .and_then(|runs| runs.iter().find(|r| id_of(r) == run_id))
        else {
            return Err(internal("This task run is no longer available."));
        };
        let child = state.children.get(run_id).cloned();
        let mut messages = child.as_ref().and(child_messages);
        if messages.is_none() {
            messages = inner
                .run_directory(task_id, Some(run_id))
                .ok()
                .and_then(|dir| saved_messages(&inner.options.context, &dir.join("state.json")));
        }
        let mut messages = messages
            .filter(Value::is_array)
            .unwrap_or_else(|| json!([]));
        if child.is_none() {
            for message in messages.as_array_mut().into_iter().flatten() {
                for action in message
                    .get_mut("actions")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    if action["status"] == "pending" || action["status"] == "executing" {
                        action["status"] = json!("cancelled");
                        action["detail"] =
                            json!("This task preview expired. Ask Ranger for a fresh preview.");
                    }
                }
            }
        }
        let mut run_detail = receipt(run);
        run_detail["messages"] = messages;
        out["run"] = run_detail;
        Ok(out)
    }

    /// `resume()`: scheduling on, runs a restart left recovered.
    pub async fn resume(&self) {
        let inner = self.inner();
        {
            let mut state = inner.state.lock().unwrap();
            if state.disposed || state.invalid {
                return;
            }
            state.enabled = true;
            state.started = true;
            state.fault = None;
            state.retry_at.clear();
        }
        let current: Vec<(String, Value)> = {
            let state = inner.state.lock().unwrap();
            state
                .tasks
                .iter()
                .filter_map(|entry| {
                    let run = State::current(entry)?;
                    (!state.children.contains_key(id_of(run)))
                        .then(|| (task_id_of(entry).to_owned(), run.clone()))
                })
                .collect()
        };
        for (task_id, run) in current {
            let run_id = id_of(&run).to_owned();
            if status(&run) == "waiting" {
                // Prepared write closures cannot survive a restart: never
                // rebuild or confirm an old preview.
                let _ = inner.change(|inner, state| {
                    let Some((t, r)) = state.run_location(&run_id) else {
                        return;
                    };
                    let now = inner.now();
                    let run = &mut state.tasks[t]["runs"][r];
                    run["status"] = json!("failed");
                    run["finished_at"] = json!(now);
                    run["error"] = json!(
                        "The bridge restarted and task action previews expired. Ask Ranger for a fresh preview."
                    );
                    compact(run);
                    let entry = &state.tasks[t];
                    if let Some(due) = entry.get("due_at").and_then(Value::as_str).map(str::to_owned)
                        && entry["task"]["status"] == "active"
                    {
                        inner.queue(state, t, &due, false);
                        remove(&mut state.tasks[t], "due_at");
                    }
                });
            } else if status(&run) == "running" && inner.state.lock().unwrap().busy.is_none() {
                let launch = self.launch(task_id, run_id, true);
                self.track(launch);
            }
        }
        let busy_child = {
            let state = inner.state.lock().unwrap();
            state
                .busy
                .as_ref()
                .and_then(|b| state.children.get(b).cloned())
        };
        if let Some(child) = busy_child {
            let _ = child.resume().await;
        }
        self.tick().await;
    }

    /// `dispose()`: scheduling stopped, children disposed, storage closed.
    pub async fn dispose(&self) {
        let inner = self.inner();
        let children: Vec<(String, Arc<dyn ScheduledChild>)> = {
            let mut state = inner.state.lock().unwrap();
            state.disposed = true;
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            state
                .children
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        inner.controller.cancel();
        for (run_id, child) in children {
            let _ = self.dispose_child(&run_id, &child).await;
        }
        let jobs: Vec<JoinHandle<()>> = std::mem::take(&mut inner.state.lock().unwrap().jobs);
        for job in jobs {
            let _ = job.await;
        }
        let mut state = inner.state.lock().unwrap();
        state.children.clear();
        if let Some(mut storage) = state.storage.take() {
            storage.close();
        }
    }

    /// The directory a run keeps its private history in.
    pub fn run_directory(&self, task_id: &str, run_id: Option<&str>) -> AssistantResult<PathBuf> {
        self.inner().run_directory(task_id, run_id)
    }
}

fn delete_entry(state: &mut State, task_id: &str) {
    state.tasks.retain(|entry| task_id_of(entry) != task_id);
    state.requests.retain(|r| r["task_id"] != task_id);
}

/// A run's messages from its saved `state.json`, when it holds a valid
/// snapshot of at most 3 MB.
fn saved_messages(context: &DataContext, path: &Path) -> Option<Value> {
    context.assert_safe_data_path(path).ok()?;
    if std::fs::metadata(path).ok()?.len() > 3_000_000 {
        return None;
    }
    let saved = js::parse(&std::fs::read_to_string(path).ok()?)?;
    let mut probe = saved.as_object()?.clone();
    for (key, value) in [
        ("instance_id", json!("saved-task")),
        ("revision", json!(0)),
        ("running", json!(false)),
        ("error", Value::Null),
        ("auth", Value::Null),
        ("providers", json!([])),
        ("models", json!([])),
    ] {
        probe.insert(key.into(), value);
    }
    is_snapshot(&Value::Object(probe)).then(|| saved["messages"].clone())
}

#[cfg(test)]
mod tests;
