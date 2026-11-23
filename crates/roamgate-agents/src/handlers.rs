//! `agent-sessions.ts`: the session handlers each connection has (history,
//! older pages, entries, images, commands, artifacts, tasks, summary and
//! downloads), and the task watcher.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use serde_json::Value;

use crate::compaction::{COMPACTION_TAIL_BYTES, compacted_since};
use crate::files::SessionFiles;
use crate::history::{
    HISTORY_WINDOW_LIMIT, history_text_hash, redact_history_entry, redact_history_update,
};
use crate::holders::held_open_files;
use crate::images::session_image;
use crate::index_store::SessionIndexStore;
use crate::js::{self, Obj, sv};
use crate::projection::{
    ProjectionCache, Resolved, read_session_projection, read_tail_projection, reads_by_tail,
};
use crate::resolver::{HerdrCall, ResolverContext, claude_successor_id, resolve_agent_session};
use crate::session::SessionFile;
use crate::tail::find_line_from_end;
use crate::tasks::{
    command_outputs_to_watch, subagents_to_watch, with_command_activity, with_subagent_activity,
};

const MAX_MESSAGES_PER_AGENT: usize = 200;
const TASK_OUTPUT_BYTES: u64 = 32 * 1024;
const TASK_ENTRIES: usize = 200;
const SUBAGENT_STAT_MS: f64 = 5000.0;
const TASK_ENTRY_CHARS: usize = 4000;
const FOREGROUND_RUNNING_MS: f64 = 2.0 * 60.0 * 60.0 * 1000.0;

/// An error with the code the browser gets (`image_gone`).
#[derive(Debug, Clone)]
pub struct HandlerError {
    pub message: String,
    pub code: Option<String>,
}

impl HandlerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }
    fn gone(message: &str) -> Self {
        Self {
            message: message.into(),
            code: Some(crate::images::SESSION_IMAGE_GONE.into()),
        }
    }
}

impl From<io::Error> for HandlerError {
    fn from(error: io::Error) -> Self {
        Self::new(error.to_string())
    }
}

type Result<T> = std::result::Result<T, HandlerError>;

/// When the held output files were listed, them, and the processes seen.
type Held = (f64, Vec<String>, Option<std::collections::HashSet<String>>);

/// What a subagent's file and a command's output say of their tasks.
pub struct TaskWatcher {
    files: Arc<dyn SessionFiles>,
    seen: Mutex<HashMap<String, (f64, Option<f64>)>>,
    held: Mutex<Option<Held>>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl TaskWatcher {
    pub fn new(files: Arc<dyn SessionFiles>, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self {
            files,
            seen: Mutex::new(HashMap::new()),
            held: Mutex::new(None),
            now,
        }
    }

    async fn stat(&self, path: &str, now: f64) -> Option<f64> {
        if let Some((_, file)) = self.seen.lock().unwrap().get(path) {
            return *file;
        }
        let file = self
            .files
            .stat_file(path)
            .await
            .ok()
            .flatten()
            .map(|f| f.mtime_ms);
        self.seen
            .lock()
            .unwrap()
            .insert(path.to_owned(), (now, file));
        file
    }

    fn holds(&self, paths: &[String], now: f64) -> Option<std::collections::HashSet<String>> {
        if self.files.remote() {
            return None;
        }
        let mut held = self.held.lock().unwrap();
        let fresh = held.as_ref().is_some_and(|(at, checked, _)| {
            now - at < SUBAGENT_STAT_MS && paths.iter().all(|p| checked.contains(p))
        });
        if !fresh {
            *held = Some((now, paths.to_vec(), held_open_files(paths)));
        }
        held.as_ref().unwrap().2.clone()
    }

    /// The tasks with what their files say.
    pub async fn watch(&self, session_path: &str, tasks: Vec<Value>) -> Vec<Value> {
        let now = (self.now)();
        let ids = subagents_to_watch(&tasks, now, 8);
        let outputs = command_outputs_to_watch(&tasks, now);
        if ids.is_empty() && outputs.is_empty() {
            return tasks;
        }
        let dir = format!(
            "{}/subagents",
            session_path.strip_suffix(".jsonl").unwrap_or(session_path)
        );
        self.seen
            .lock()
            .unwrap()
            .retain(|_, (at, _)| now - *at < SUBAGENT_STAT_MS);
        let mut activity = HashMap::new();
        for id in &ids {
            activity.insert(
                id.clone(),
                self.stat(&format!("{dir}/agent-{id}.jsonl"), now).await,
            );
        }
        let mut next = with_subagent_activity(&tasks, &activity, now);
        if !outputs.is_empty() {
            let mut output_activity = HashMap::new();
            for path in &outputs {
                output_activity.insert(path.clone(), self.stat(path, now).await);
            }
            let open = self.holds(&outputs, now);
            next = with_command_activity(&next, &output_activity, now, &|path| {
                open.as_ref().map(|o| o.contains(path))
            });
        }
        next
    }
}

fn agent_session_value(agent: Option<&Value>) -> Option<String> {
    let value = agent?.get("agent_session")?.get("value")?.as_str()?;
    (!value.is_empty()).then(|| value.to_owned())
}

/// The handlers of one connection.
pub struct AgentSessionHandlers {
    pub herdr: Arc<dyn HerdrCall>,
    pub files: Arc<dyn SessionFiles>,
    pub resolver: Arc<ResolverContext>,
    pub cache: Arc<ProjectionCache>,
    pub tasks: TaskWatcher,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

fn with(mut base: Obj, extra: Obj) -> Value {
    for (key, value) in extra {
        base.insert(key, value);
    }
    Value::Object(base)
}

fn is_not_found(error: &str) -> bool {
    static NOT_FOUND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)not[_ ]found").unwrap());
    NOT_FOUND.is_match(error)
}

impl AgentSessionHandlers {
    pub fn new(
        herdr: Arc<dyn HerdrCall>,
        files: Arc<dyn SessionFiles>,
        resolver: Arc<ResolverContext>,
        store: Option<Arc<SessionIndexStore>>,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> Self {
        Self {
            cache: ProjectionCache::new(files.clone(), store),
            tasks: TaskWatcher::new(files.clone(), now.clone()),
            herdr,
            files,
            resolver,
            now,
        }
    }

    async fn resolve(&self, params: &Value) -> Result<Resolved> {
        Ok(resolve_agent_session(
            params,
            self.herdr.as_ref(),
            self.files.as_ref(),
            &self.resolver,
        )
        .await?)
    }

    /// The pane's session file now, for the history watcher.
    pub async fn resolve_path(&self, params: &Value) -> Result<Option<String>> {
        Ok(self.resolve(params).await?.file.map(|f| f.path))
    }

    /// Whether the pane's session was compacted since `since`.
    pub async fn compacted_since(&self, pane: &str, since: &str) -> Result<bool> {
        let resolved = self
            .resolve(&serde_json::json!({ "pane_id": pane }))
            .await?;
        let Some(file) = resolved.file else {
            return Ok(false);
        };
        if let Some(stat) = self.files.stat_file(&file.path).await?
            && stat.mtime_ms <= js::date_parse(since)
        {
            return Ok(false);
        }
        let tail = self
            .files
            .read_tail(&file.path, COMPACTION_TAIL_BYTES)
            .await?;
        Ok(compacted_since(&String::from_utf8_lossy(&tail), since))
    }

    /// The session a pane's agent runs now.
    pub async fn pane_session(&self, pane: &str) -> Result<Option<String>> {
        match self
            .herdr
            .call(
                "agent.get",
                serde_json::json!({ "target": pane }),
                Some(5000),
            )
            .await
        {
            Ok(result) => Ok(agent_session_value(result.get("agent"))),
            Err(error) if is_not_found(&error) => Ok(None),
            Err(error) => Err(HandlerError::new(error)),
        }
    }

    /// The pane whose agent runs a session now.
    pub async fn session_pane(&self, session: &str) -> Result<Option<String>> {
        let listed = self
            .herdr
            .call("agent.list", serde_json::json!({}), Some(10_000))
            .await
            .map_err(HandlerError::new)?;
        let agents = listed
            .get("agents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pane_of = |id: &str| {
            agents.iter().find_map(|agent| {
                let pane = agent.get("pane_id")?.as_str()?;
                (agent_session_value(Some(agent)).as_deref() == Some(id)).then(|| pane.to_owned())
            })
        };
        if let Some(pane) = pane_of(session) {
            return Ok(Some(pane));
        }
        let next = claude_successor_id(session, self.files.as_ref(), &self.resolver)
            .await
            .ok()
            .flatten();
        Ok(next.and_then(|n| pane_of(&n)))
    }

    /// `agent_history.get`: the messages (v1) or the entries' update (v2).
    pub async fn read_history(&self, params: &Value) -> Result<Value> {
        if params.get("history_version").and_then(Value::as_f64) != Some(2.0) {
            return self.read_message_history(params).await;
        }
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            self.cache.invalidate(&resolved).await;
            return Ok(with(
                resolved.value,
                obj! {
                    "history_version" => 2i64,
                    "mode" => "snapshot",
                    "cursor" => obj! { "epoch" => roamgate_base::paths::random_uuid(), "revision" => 1i64 },
                    "window_limit" => HISTORY_WINDOW_LIMIT,
                    "entries" => Vec::<Value>::new(),
                },
            ));
        }
        let (projection, update) = self.cache.history(&resolved, params.get("cursor")).await?;
        let mut out = resolved.value;
        out.insert("file".into(), projection.file.to_value());
        out.insert(
            "updated_at".into(),
            Value::String(js::iso(projection.file.mtime_ms)),
        );
        let Value::Object(update) = redact_history_update(&update) else {
            unreachable!()
        };
        Ok(with(out, update))
    }

    async fn read_message_history(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            self.cache.invalidate(&resolved).await;
            return Ok(with(
                resolved.value,
                obj! { "messages" => Vec::<Value>::new() },
            ));
        }
        let projected = self.cache.recent(&resolved).await?;
        let messages = &projected.messages;
        let messages = messages[messages.len().saturating_sub(MAX_MESSAGES_PER_AGENT)..].to_vec();
        let mut out = resolved.value;
        out.insert("file".into(), projected.file.to_value());
        out.insert(
            "updated_at".into(),
            Value::String(js::iso(projected.file.mtime_ms)),
        );
        out.insert("messages".into(), Value::Array(messages));
        Ok(Value::Object(out))
    }

    /// The pane's transcript records for a rewind's scan.
    pub async fn read_records(&self, params: &Value) -> Result<Option<Vec<Obj>>> {
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            return Ok(None);
        }
        Ok(Some(self.cache.records(&resolved).await?))
    }

    /// `agent_history.older`.
    pub async fn read_older(&self, params: &Value) -> Result<Value> {
        let before = sv(params.get("before_id"));
        if before.is_empty() {
            return Err(HandlerError::new("before_id is required"));
        }
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            self.cache.invalidate(&resolved).await;
            let detail = sv(resolved.value.get("detail"));
            return Err(HandlerError::new(if detail.is_empty() {
                "Agent session is unavailable"
            } else {
                detail
            }));
        }
        let limit = js::to_number(params.get("limit"));
        let page = self
            .cache
            .older(&resolved, before, if limit.is_nan() { 0.0 } else { limit })
            .await?;
        Ok(with(
            resolved.value,
            obj! {
                "entries" => page.entries.iter().map(redact_history_entry).collect::<Vec<_>>(),
                "has_more" => page.has_more,
            },
        ))
    }

    /// `agent_history.entry`.
    pub async fn read_entry(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            self.cache.invalidate(&resolved).await;
            let detail = sv(resolved.value.get("detail"));
            return Err(HandlerError::new(if detail.is_empty() {
                "Agent session is unavailable"
            } else {
                detail
            }));
        }
        let entries = self.cache.entries(&resolved).await?;
        let wanted = sv(params.get("entry_id"));
        let Some(entry) = entries.iter().find(|e| sv(e.get("id")) == wanted) else {
            return Err(HandlerError::new(
                "That history entry is no longer available; refresh the history and try again",
            ));
        };
        let text = sv(entry.get("text"));
        Ok(Value::Object(obj! {
            "entry_id" => sv(entry.get("id")),
            "text" => text,
            "text_hash" => history_text_hash(text),
        }))
    }

    /// `agent_history.image`.
    pub async fn read_image(&self, params: &Value) -> Result<Value> {
        static UUID: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").unwrap());
        let uuid = sv(params.get("uuid")).to_owned();
        let index = params.get("index").and_then(Value::as_f64).unwrap_or(0.0);
        if !UUID.is_match(&uuid) {
            return Err(HandlerError::gone("invalid uuid"));
        }
        let resolved = self.resolve(params).await?;
        let Some(file) = &resolved.file else {
            let detail = sv(resolved.value.get("detail"));
            return Err(HandlerError::new(if detail.is_empty() {
                "Agent session is unavailable"
            } else {
                detail
            }));
        };
        let image = if reads_by_tail(&resolved.agent, file, self.files.as_ref()) {
            let size = file.size.unwrap_or(0.0) as u64;
            let mut found = |line: &str| session_image(line, &uuid, index);
            find_line_from_end(
                self.files.as_ref(),
                &file.path,
                size,
                &js::quote(&uuid),
                &mut found,
            )
            .await?
        } else {
            session_image(&self.files.read_text(&file.path).await?, &uuid, index)
        };
        image.ok_or_else(|| HandlerError::gone("That image is not in the session"))
    }

    /// `agent_commands.get`.
    pub async fn read_commands(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            return Ok(serde_json::json!({ "commands": [] }));
        }
        let (_, aggregates, partial) = self.cache.aggregates(&resolved).await?;
        Ok(Value::Object(
            obj! { "commands" => aggregates.commands, "partial" => partial.then_some(true) },
        ))
    }

    /// `agent_artifacts.get`.
    pub async fn read_artifacts(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        if resolved.file.is_none() {
            return Ok(serde_json::json!({ "artifacts": [] }));
        }
        let (_, aggregates, partial) = self.cache.aggregates(&resolved).await?;
        Ok(Value::Object(
            obj! { "artifacts" => aggregates.artifacts, "partial" => partial.then_some(true) },
        ))
    }

    /// `agent_tasks.get`.
    pub async fn read_tasks(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        let Some(file) = &resolved.file else {
            return Ok(serde_json::json!({ "tasks": [] }));
        };
        let (_, aggregates, partial) = self.cache.aggregates(&resolved).await?;
        let now = (self.now)();
        let foreground = |task: &Value| js::is_true(task.get("foreground"));
        let running_now: Vec<Value> = aggregates
            .tasks
            .iter()
            .filter(|task| {
                foreground(task)
                    && now - js::date_parse(sv(task.get("startedAt"))) < FOREGROUND_RUNNING_MS
            })
            .cloned()
            .collect();
        let background: Vec<Value> = aggregates
            .tasks
            .iter()
            .filter(|t| !foreground(t))
            .cloned()
            .collect();
        let tasks = self.tasks.watch(&file.path, background).await;
        Ok(Value::Object(obj! {
            "tasks" => tasks,
            "running_now" => running_now,
            "session" => crate::files::session_name(&file.path),
            "partial" => partial.then_some(true),
        }))
    }

    async fn conversation(&self, path: &str) -> Result<Vec<Value>> {
        let Some(file) = self.files.stat_file(path).await? else {
            return Ok(Vec::new());
        };
        let entries = if reads_by_tail("claude", &file, self.files.as_ref()) {
            read_tail_projection(&file, self.files.as_ref()).await?
        } else {
            read_session_projection("claude", &file, self.files.as_ref(), None)
                .await?
                .0
                .entries
        };
        Ok(entries[entries.len().saturating_sub(TASK_ENTRIES)..]
            .iter()
            .map(|entry| {
                let mut entry = entry.as_object().cloned().unwrap_or_default();
                let text = js::head16(sv(entry.get("text")), TASK_ENTRY_CHARS);
                entry.insert("text".into(), Value::String(text));
                Value::Object(entry)
            })
            .collect())
    }

    /// `agent_task.get`.
    pub async fn read_task(&self, params: &Value) -> Result<Value> {
        static WORKFLOW: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^wf_[A-Za-z0-9_-]+$").unwrap());
        static AGENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
        let resolved = self.resolve(params).await?;
        let Some(file) = resolved.file.clone() else {
            return Err(HandlerError::new("Agent session is unavailable"));
        };
        let wanted = params.get("task_id");
        let find = |tasks: &[Value]| tasks.iter().find(|t| t.get("id") == wanted).cloned();
        let mut projection = self.cache.get(&resolved, false).await?;
        let mut task = find(&projection.aggregates.tasks);
        if task.is_none() && projection.partial {
            projection = self.cache.get(&resolved, true).await?;
            task = find(&projection.aggregates.tasks);
        }
        let Some(task) = task else {
            return Err(HandlerError::new("That task is no longer in the session"));
        };
        let Some(task) = self
            .tasks
            .watch(&file.path, vec![task])
            .await
            .into_iter()
            .next()
        else {
            return Err(HandlerError::new("That task is no longer in the session"));
        };
        let session_dir = file
            .path
            .strip_suffix(".jsonl")
            .unwrap_or(&file.path)
            .to_owned();
        let kind = sv(task.get("kind"));
        let run_id = sv(task.get("runId"));
        if kind == "workflow" && !run_id.is_empty() {
            if !WORKFLOW.is_match(run_id) {
                return Err(HandlerError::new("Unknown workflow"));
            }
            let run_dir = format!("{session_dir}/subagents/workflows/{run_id}");
            let workflow = read_workflow_run(
                self.files.as_ref(),
                &run_dir,
                &format!("{session_dir}/workflows/{run_id}.json"),
            )
            .await;
            let agent_id = sv(params.get("agent_id"));
            if !agent_id.is_empty() {
                let known = workflow
                    .get("phases")
                    .and_then(Value::as_array)
                    .is_some_and(|phases| {
                        phases.iter().any(|p| {
                            p.get("agents")
                                .and_then(Value::as_array)
                                .is_some_and(|a| a.iter().any(|a| sv(a.get("agentId")) == agent_id))
                        })
                    });
                if !known {
                    return Err(HandlerError::new("Unknown workflow agent"));
                }
                let entries = self
                    .conversation(&format!("{run_dir}/agent-{agent_id}.jsonl"))
                    .await?;
                return Ok(Value::Object(
                    obj! { "task" => task, "workflow" => workflow, "entries" => entries },
                ));
            }
            return Ok(Value::Object(
                obj! { "task" => task, "workflow" => workflow },
            ));
        }
        let agent_id = sv(task.get("agentId")).to_owned();
        if (kind == "agent" || kind == "teammate") && !agent_id.is_empty() {
            if !AGENT.is_match(&agent_id) {
                return Err(HandlerError::new("Unknown subagent"));
            }
            let entries = self
                .conversation(&format!("{session_dir}/subagents/agent-{agent_id}.jsonl"))
                .await?;
            return Ok(Value::Object(obj! { "task" => task, "entries" => entries }));
        }
        let output_file = sv(task.get("outputFile")).to_owned();
        if !output_file.ends_with(".output") {
            return Ok(Value::Object(obj! { "task" => task, "output" => "" }));
        }
        let bytes = self
            .files
            .read_tail(&output_file, TASK_OUTPUT_BYTES)
            .await
            .unwrap_or_default();
        Ok(Value::Object(
            obj! { "task" => task, "output" => String::from_utf8_lossy(&bytes).into_owned() },
        ))
    }

    /// `agent_session.get`.
    pub async fn read_summary(&self, params: &Value) -> Result<Value> {
        let resolved = self.resolve(params).await?;
        let Some(file) = resolved.file.clone() else {
            self.cache.invalidate(&resolved).await;
            return Ok(with(
                resolved.value,
                obj! {
                    "stats" => serde_json::json!({ "turns": 0, "records": 0, "token_usage": null }),
                    "title" => Value::Null,
                    "text" => Value::Null,
                    "truncated" => false,
                    "trajectory" => Value::Null,
                },
            ));
        };
        let (read_file, aggregates, partial) = self.cache.aggregates(&resolved).await?;
        let include_text = js::is_true(params.get("include_text"));
        let include_trajectory = js::is_true(params.get("include_trajectory"));
        let asked = js::to_number(params.get("preview_limit"));
        let preview = if asked.is_nan() || asked == 0.0 {
            512.0 * 1024.0
        } else {
            asked
        };
        let preview = preview.clamp(1.0, 2.0 * 1024.0 * 1024.0).floor() as usize;
        let mut text = Value::Null;
        let mut truncated = false;
        if include_text && sv(resolved.value.get("agent")) == "agy" {
            let records = crate::antigravity::read_antigravity_session_records(&file.path);
            let ndjson = records
                .into_iter()
                .map(|r| js::stringify(&Value::Object(r)))
                .collect::<Vec<_>>()
                .join("\n");
            truncated = js::len16(&ndjson) > preview;
            text = Value::String(if truncated {
                js::head16(&ndjson, preview)
            } else {
                ndjson
            });
        } else if include_text {
            let bytes = self
                .files
                .read_prefix(&file.path, preview as u64 + 1)
                .await?;
            truncated = bytes.len() > preview || read_file.size.unwrap_or(0.0) > preview as f64;
            let shown = if truncated {
                &bytes[..bytes.len().min(preview)]
            } else {
                &bytes[..]
            };
            text = Value::String(String::from_utf8_lossy(shown).into_owned());
        }
        let trajectory = if include_trajectory {
            self.cache.trajectory(&resolved, false).await?
        } else {
            Value::Null
        };
        let mut out = resolved.value;
        out.insert("file".into(), read_file.to_value());
        out.insert(
            "updated_at".into(),
            Value::String(js::iso(read_file.mtime_ms)),
        );
        Ok(with(
            out,
            obj! {
                "stats" => aggregates.stats,
                "title" => aggregates.title.map_or(Value::Null, Value::String),
                "text" => text,
                "truncated" => truncated,
                "trajectory" => trajectory,
                "partial" => partial.then_some(true),
            },
        ))
    }

    /// `/api/agent-session/download`: status, headers, body.
    pub async fn download_file(
        &self,
        params: &Value,
    ) -> Result<(u16, Vec<(String, String)>, Vec<u8>)> {
        let resolved = self.resolve(params).await?;
        let Some(file) = &resolved.file else {
            return Ok(missing(&resolved));
        };
        let body = self.files.read_download(&file.path).await?;
        let is_db = file.path.ends_with(".db");
        Ok((
            200,
            vec![
                (
                    "content-type".into(),
                    if is_db {
                        "application/vnd.sqlite3"
                    } else {
                        "application/x-ndjson; charset=utf-8"
                    }
                    .into(),
                ),
                (
                    "content-length".into(),
                    js::number_text(file.size.unwrap_or(0.0)),
                ),
                (
                    "content-disposition".into(),
                    content_disposition_filename(&file.path),
                ),
                (
                    "x-agent-session-path".into(),
                    crate::paths::encode_uri_component(&file.path),
                ),
            ],
            body,
        ))
    }

    /// `/api/agent-session/atif`.
    pub async fn download_atif(
        &self,
        params: &Value,
    ) -> Result<(u16, Vec<(String, String)>, Vec<u8>)> {
        let resolved = self.resolve(params).await?;
        let Some(file) = &resolved.file else {
            return Ok(missing(&resolved));
        };
        let trajectory = self.cache.trajectory(&resolved, true).await?;
        Ok((
            200,
            vec![
                (
                    "content-type".into(),
                    "application/json; charset=utf-8".into(),
                ),
                ("content-disposition".into(), content_disposition_atif(file)),
                (
                    "x-agent-session-path".into(),
                    crate::paths::encode_uri_component(&file.path),
                ),
            ],
            format!("{}\n", js::stringify_pretty(&trajectory)).into_bytes(),
        ))
    }
}

fn missing(resolved: &Resolved) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let detail = sv(resolved.value.get("detail"));
    let body = if detail.is_empty() {
        "session file unavailable"
    } else {
        detail
    };
    (
        404,
        vec![("content-type".into(), "text/plain; charset=utf-8".into())],
        body.as_bytes().to_vec(),
    )
}

/// `replace(/[^\x20-\x7e]|["\r\n]/g, "_")`, one `_` per UTF-16 unit.
fn header_safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if (' '..='~').contains(&c) && c != '"' {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn content_disposition_filename(path: &str) -> String {
    let fallback_default = if path.ends_with(".db") {
        "session.db"
    } else {
        "session.jsonl"
    };
    let name = header_safe(crate::utils::basename(path));
    format!(
        "attachment; filename=\"{}\"",
        if name.is_empty() {
            fallback_default.to_owned()
        } else {
            name
        }
    )
}

fn content_disposition_atif(file: &SessionFile) -> String {
    let base = file
        .session_id()
        .map(str::to_owned)
        .unwrap_or_else(|| crate::utils::basename(&file.path).to_owned());
    let name = header_safe(crate::utils::without_extension(&base));
    let filename = format!(
        "{}.atif.json",
        if name.is_empty() { "session" } else { &name }
    );
    format!(
        "attachment; filename=\"{filename}\"; filename*=UTF-8''{}",
        crate::paths::encode_uri_component(&filename)
    )
}

fn event_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => Some(s.clone()),
        other => Some(js::stringify_pretty(other)),
    }
}

/// A workflow run's phases and agents.
pub async fn read_workflow_run(
    files: &dyn SessionFiles,
    run_dir: &str,
    record_path: &str,
) -> Value {
    let mut phases: Vec<(String, Vec<String>)> = Vec::new();
    let mut agents: Vec<(String, Obj)> = Vec::new();
    fn phase_of<'a>(
        phases: &'a mut Vec<(String, Vec<String>)>,
        title: &str,
    ) -> &'a mut Vec<String> {
        if let Some(at) = phases.iter().position(|(t, _)| t == title) {
            return &mut phases[at].1;
        }
        phases.push((title.to_owned(), Vec::new()));
        &mut phases.last_mut().unwrap().1
    }
    if let Ok(Some(journal)) = files.stat_file(&format!("{run_dir}/journal.jsonl")).await
        && let Ok(text) = files.read_text(&journal.path).await
    {
        for line in text.split('\n') {
            let Some(Value::Object(event)) = js::parse(line) else {
                continue;
            };
            let agent_id = sv(event.get("agentId")).to_owned();
            if agent_id.is_empty() {
                continue;
            }
            let known = agents.iter().position(|(id, _)| *id == agent_id);
            match (sv(event.get("type")), known) {
                ("started", None) => {
                    let label = js::str_of(event.get("label"))
                        .unwrap_or(&agent_id)
                        .to_owned();
                    agents.push((agent_id.clone(), obj! { "agentId" => agent_id.clone(), "label" => label, "state" => "running" }));
                    phase_of(&mut phases, sv(event.get("phase"))).push(agent_id);
                }
                ("result", Some(at)) => {
                    let agent = &mut agents[at].1;
                    agent.insert("state".into(), Value::String("done".into()));
                    js::put(
                        agent,
                        "resultPreview",
                        event_text(event.get("result")).map(|t| js::head16(&t, 300)),
                    );
                }
                ("error" | "failed", Some(at)) => {
                    agents[at]
                        .1
                        .insert("state".into(), Value::String("failed".into()));
                }
                _ => {}
            }
        }
    }
    let record = match files.stat_file(record_path).await {
        Ok(Some(file)) => files
            .read_text(&file.path)
            .await
            .ok()
            .and_then(|t| js::parse(&t)),
        _ => None,
    };
    let build = |phases: &[(String, Vec<String>)], agents: &[(String, Obj)]| -> Vec<Value> {
        phases
            .iter()
            .map(|(title, ids)| {
                Value::Object(obj! {
                    "title" => title.clone(),
                    "agents" => ids.iter().filter_map(|id| agents.iter().find(|(a, _)| a == id).map(|(_, o)| Value::Object(o.clone()))).collect::<Vec<_>>(),
                })
            })
            .collect()
    };
    let Some(Value::Object(record)) = record else {
        add_live_agent_times(files, run_dir, &phases, &mut agents).await;
        return Value::Object(obj! { "phases" => build(&phases, &agents) });
    };
    let mut ordered: Vec<String> = Vec::new();
    for phase in record
        .get("phases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let title = sv(phase.get("title"));
        if !title.is_empty() {
            phase_of(&mut phases, title);
            ordered.push(title.to_owned());
        }
    }
    for item in record
        .get("workflowProgress")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(item) = item.as_object() else {
            continue;
        };
        if sv(item.get("type")) != "workflow_agent" {
            continue;
        }
        let Some(Value::String(agent_id)) = item.get("agentId") else {
            continue;
        };
        let at = match agents.iter().position(|(id, _)| id == agent_id) {
            Some(at) => at,
            None => {
                let label = js::str_of(item.get("label")).unwrap_or(agent_id).to_owned();
                agents.push((
                    agent_id.clone(),
                    obj! { "agentId" => agent_id.clone(), "label" => label, "state" => "done" },
                ));
                phase_of(&mut phases, sv(item.get("phaseTitle"))).push(agent_id.clone());
                agents.len() - 1
            }
        };
        let agent = &mut agents[at].1;
        match sv(item.get("state")) {
            "done" => {
                agent.insert("state".into(), Value::String("done".into()));
            }
            "error" | "failed" => {
                agent.insert("state".into(), Value::String("failed".into()));
            }
            _ => {}
        }
        for key in ["durationMs", "startedAt"] {
            if let Some(n @ Value::Number(_)) = item.get(key) {
                agent.insert(key.into(), n.clone());
            }
        }
        if let Some(Value::String(preview)) = item.get("resultPreview") {
            agent.insert(
                "resultPreview".into(),
                Value::String(js::head16(preview, 300)),
            );
        }
    }
    let mut all: Vec<(String, Vec<String>)> = ordered
        .iter()
        .filter_map(|t| phases.iter().find(|(p, _)| p == t).cloned())
        .collect();
    all.extend(phases.iter().filter(|(t, _)| !ordered.contains(t)).cloned());
    let result = event_text(record.get("result"))
        .map(|t| js::head16(&t, 4000))
        .filter(|t| !t.is_empty());
    Value::Object(obj! { "phases" => build(&all, &agents), "result" => result })
}

async fn add_live_agent_times(
    files: &dyn SessionFiles,
    run_dir: &str,
    phases: &[(String, Vec<String>)],
    agents: &mut [(String, Obj)],
) {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
    let ids: Vec<String> = phases.iter().flat_map(|(_, ids)| ids.clone()).collect();
    for id in ids {
        let Some(at) = agents.iter().position(|(a, _)| *a == id) else {
            continue;
        };
        let running = sv(agents[at].1.get("state")) == "running";
        if !ID.is_match(&id) || (files.remote() && !running) {
            continue;
        }
        let mtime = |path: String| async move {
            files
                .stat_file(&path)
                .await
                .ok()
                .flatten()
                .map(|f| f.mtime_ms)
        };
        let started = mtime(format!("{run_dir}/agent-{id}.meta.json")).await;
        let agent = &mut agents[at].1;
        if let Some(started) = started {
            agent.insert("startedAt".into(), js::number(started.round()));
        }
        let transcript = format!("{run_dir}/agent-{id}.jsonl");
        if running {
            if let Some(active) = mtime(transcript).await {
                agent.insert("lastActiveAt".into(), js::number(active.round()));
            }
            continue;
        }
        if let (Some(started), Some(ended)) = (started, mtime(transcript).await) {
            agent.insert(
                "durationMs".into(),
                js::number((ended - started).round().max(0.0)),
            );
        }
    }
}
