//! Ranger's service (`assistant/service.ts`): its chats (state.json and
//! sessions/), turns and their recovery, steers and the queue, approvals
//! and action confirmation, the model configuration, the provider login,
//! the mention and workspace catalogs, scheduled tasks (each run a child
//! service), publishing and disposal.
//!
//! The TS keeps every value as a JavaScript object it mutates in place;
//! here the state is one `Mutex<State>` of JSON values in insertion order,
//! never held across an await, and a value the TS held by reference across
//! an await (the draft of a turn, an action) is found again by id. What the
//! TS compares by identity (the model's entries, the granted workspaces,
//! the admitted run) is compared by `Arc` pointer or by a generation.
//! Snapshots leave through `publish` once the state is unlocked, in the
//! order they were made.

mod auth;
mod task_glue;
pub mod task_run;
mod turn;
pub mod util;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_agents::js;
use roamgate_base::clock::SharedClock;
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::{DataContext, dirname, random_uuid};
use roamgate_base::private::{OpenMode, create_dir_all_mode, open_nofollow, set_mode};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::context::{AssistantContext, ContextOp, PreparedAction, Scope};
use crate::driver::AssistantDriver;
use crate::errors::{AssistantError, AssistantResult};
use crate::saved::ref_key;
use crate::tasks::{AssistantTasks, BeforeDispatch, NotifyUser};
use crate::tools::{BoxFuture, Handler, ToolFuture};
use crate::wire::{
    ASSISTANT_MAX_CUSTOM_MODELS, ASSISTANT_MAX_MENTIONS, ASSISTANT_MAX_WORKSPACES, is_hex64,
    is_mention_target, is_model_api, is_model_endpoint, is_snapshot, is_thinking_level,
};

pub use task_run::{GlobalAllowed, GlobalWorkspaceAllowed, RefreshGlobalScope};
use task_run::{TaskGuard, TaskRunContext};
use util::*;
pub use util::{
    TASK_CONNECTION_WAIT_MS, assistant_directory, bound_assistant_thinking, same_assistant_config,
};

/// Makes a model driver for a directory and the directory of its
/// credentials (`createDriver`, or `createRangerDriver` by default).
pub type CreateDriver = Arc<dyn Fn(PathBuf, PathBuf) -> Arc<dyn AssistantDriver> + Send + Sync>;
/// `NotificationToolSender`: a task run's notification and its signal.
pub type SendNotification =
    Arc<dyn Fn(Value, Option<CancellationToken>) -> ToolFuture + Send + Sync>;
/// The receipts of a task's notifications so far.
pub type NotificationHistory = Arc<dyn Fn() -> AssistantResult<Vec<Value>> + Send + Sync>;
pub type GlobalApprovalMode = Arc<dyn Fn() -> Option<String> + Send + Sync>;
/// Answers a comment thread on the messages of a chat (its id), with the
/// tool's parameters.
pub type ChatThreads =
    Arc<dyn Fn(String, Value, Option<CancellationToken>) -> ToolFuture + Send + Sync>;
pub type PublishSnapshot = Arc<dyn Fn(Value) + Send + Sync>;

/// `createAssistantService`'s options.
pub struct ServiceOptions {
    pub context: Arc<dyn AssistantContext>,
    pub publish: PublishSnapshot,
    pub notify: Option<NotifyUser>,
    pub send_notification: Option<SendNotification>,
    pub notification_history: Option<NotificationHistory>,
    /// `assistantDirectory()` when None.
    pub directory: Option<PathBuf>,
    pub data: DataContext,
    pub clock: SharedClock,
    pub driver: Option<Arc<dyn AssistantDriver>>,
    pub create_driver: Option<CreateDriver>,
    /// `createRangerDriver`: the driver when neither of the above gives one.
    pub default_driver: CreateDriver,
    /// A scheduled task's run (`SavedTaskRun`): this service is its child.
    pub task_run: Option<Value>,
    pub before_task_dispatch: Option<BeforeDispatch>,
    pub global_allowed: Option<GlobalAllowed>,
    pub global_workspace_allowed: Option<GlobalWorkspaceAllowed>,
    pub refresh_global_scope: Option<RefreshGlobalScope>,
    pub global_approval_mode: Option<GlobalApprovalMode>,
    /// Ranger's Workspaces arrangement tools.
    pub workspace_tree: Option<Handler>,
    /// Searches and reads the session archive.
    pub archive: Option<Handler>,
    pub chat_threads: Option<ChatThreads>,
}

impl ServiceOptions {
    pub fn new(
        context: Arc<dyn AssistantContext>,
        publish: PublishSnapshot,
        data: DataContext,
        clock: SharedClock,
        default_driver: CreateDriver,
    ) -> Self {
        Self {
            context,
            publish,
            notify: None,
            send_notification: None,
            notification_history: None,
            directory: None,
            data,
            clock,
            driver: None,
            create_driver: None,
            default_driver,
            task_run: None,
            before_task_dispatch: None,
            global_allowed: None,
            global_workspace_allowed: None,
            refresh_global_scope: None,
            global_approval_mode: None,
            workspace_tree: None,
            archive: None,
            chat_threads: None,
        }
    }
}

pub(crate) type Work = Shared<BoxFuture<()>>;
/// The admitted run (`SavedRun`), shared as the TS shares the object.
pub(crate) type RunRef = Arc<Mutex<Value>>;
type Widen = Arc<dyn Fn(Value) -> BoxFuture<AssistantResult<()>> + Send + Sync>;
type Execute =
    Box<dyn FnOnce(Option<crate::context::Authorized>) -> BoxFuture<AssistantResult<Value>> + Send>;

/// A prepared action, held until it is confirmed (its execute runs once).
pub(crate) struct Prepared {
    execute: Mutex<Option<Execute>>,
}

impl Prepared {
    fn new(prepared: PreparedAction) -> Arc<Self> {
        Arc::new(Self {
            execute: Mutex::new(Some(prepared.execute)),
        })
    }
}

/// The scope and receipts the model was last given, with the context
/// (entries) that holds them.
struct Given {
    entries: Arc<Vec<Value>>,
    scope: String,
    receipts: String,
}

/// A login prompt waiting for the user's answer.
struct Answer {
    id: String,
    sender: oneshot::Sender<AssistantResult<String>>,
}

pub(crate) struct State {
    instance_id: String,
    revision: u64,
    session_id: String,
    sessions: Vec<Value>,
    config: Value,
    /// The identity of `config.allowed_workspaces` (the TS compares arrays).
    allowed_gen: u64,
    providers: Value,
    models: Value,
    messages: Vec<Value>,
    running: bool,
    error: Option<String>,
    auth: Value,
    entries: Arc<Vec<Value>>,
    given: Option<Given>,
    giving: Option<(String, String)>,
    historical_tools: HashMap<String, HashMap<String, Value>>,
    entry_scope: String,
    /// Workspaces Ranger created in this chat: each of its turns may use them.
    chat_workspaces: Vec<Value>,
    requests: Vec<String>,
    pending_request: Option<String>,
    invalid_saved_state: bool,
    disposed: bool,
    changing: bool,
    model_changing: bool,
    run: Option<Work>,
    active_run: Option<RunRef>,
    active_scope: Option<Scope>,
    widen_active: Option<Widen>,
    queue: Vec<Value>,
    queue_held: bool,
    drain_scheduled: bool,
    steer_missed: Option<RunRef>,
    recovering: bool,
    /// A resume was asked while one ran.
    resume_again: bool,
    awaiting_recovery: bool,
    action_work: Option<(u64, Work)>,
    prepared_actions: HashMap<String, Arc<Prepared>>,
    turn_controller: Option<CancellationToken>,
    auth_controller: Option<CancellationToken>,
    auth_work: Option<Work>,
    answer: Option<Answer>,
    timer: Option<(u64, JoinHandle<()>)>,
    workspace_inventory: Option<Value>,
    inventory_request: u64,
    inventory_applied: u64,
    inventory_grants: Option<u64>,
    /// Snapshots made while locked, published once unlocked.
    outbox: Vec<Value>,
    /// Work started while locked, begun once unlocked.
    starts: Vec<BoxFuture<()>>,
    next_id: u64,
}

impl State {
    fn next(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn allowed(&self) -> Vec<Value> {
        self.config["allowed_workspaces"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn approval_mode(&self) -> Option<String> {
        self.config
            .get("approval_mode")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn set_error(&mut self, error: impl Into<String>) {
        self.error = Some(error.into());
    }

    fn message_mut(&mut self, id: &str) -> Option<&mut Value> {
        self.messages.iter_mut().find(|message| message["id"] == id)
    }

    fn action_mut(&mut self, id: &str) -> Option<&mut Value> {
        self.messages
            .iter_mut()
            .flat_map(|message| {
                message
                    .get_mut("actions")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
            })
            .find(|action| action["id"] == id)
    }

    fn action(&self, id: &str) -> Option<&Value> {
        self.messages
            .iter()
            .flat_map(|message| {
                message
                    .get("actions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .find(|action| action["id"] == id)
    }
}

/// The service (`AssistantService`).
#[derive(Clone)]
pub struct AssistantService(Arc<Inner>);

pub(crate) struct Inner {
    weak: Weak<Inner>,
    options: ServiceOptions,
    directory: PathBuf,
    state_path: PathBuf,
    sessions_directory: PathBuf,
    driver: Arc<dyn AssistantDriver>,
    base_context: Arc<dyn AssistantContext>,
    context: Arc<dyn AssistantContext>,
    guard: Arc<TaskGuard>,
    tasks: OnceLock<AssistantTasks>,
    task_confirmations: Mutex<Vec<(u64, String, String)>>,
    state: Mutex<State>,
    /// The queue's one worker: steering, removing, resuming and sending run
    /// one at a time in queue order.
    queue_lock: tokio::sync::Mutex<()>,
    task_publish_pending: AtomicBool,
}

/// The locked state: what was published while it was held leaves once it
/// is unlocked, and a task change published meanwhile is applied then.
pub(crate) struct Locked<'a> {
    inner: &'a Inner,
    guard: Option<MutexGuard<'a, State>>,
}

impl std::ops::Deref for Locked<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        self.guard.as_ref().unwrap()
    }
}

impl std::ops::DerefMut for Locked<'_> {
    fn deref_mut(&mut self) -> &mut State {
        self.guard.as_mut().unwrap()
    }
}

impl Drop for Locked<'_> {
    fn drop(&mut self) {
        let mut guard = self.guard.take().unwrap();
        let outbox = std::mem::take(&mut guard.outbox);
        let starts = std::mem::take(&mut guard.starts);
        drop(guard);
        for snapshot in outbox {
            (self.inner.options.publish)(snapshot);
        }
        for start in starts {
            run_eagerly(start);
        }
        if self
            .inner
            .task_publish_pending
            .swap(false, Ordering::SeqCst)
        {
            self.inner.publish_task_changes();
        }
    }
}

fn io_error(error: io::Error) -> AssistantError {
    err(error.to_string())
}

fn throw_if(signal: Option<&CancellationToken>) -> AssistantResult<()> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        return Err(aborted());
    }
    Ok(())
}

/// `AbortSignal.any`.
pub(crate) fn any_signal(signals: &[&CancellationToken]) -> CancellationToken {
    let combined = CancellationToken::new();
    if signals.iter().any(|signal| signal.is_cancelled()) {
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

/// A tool call's signal with the turn's (`AbortSignal.any([signal,
/// controller.signal])`).
fn combine(signal: Option<CancellationToken>, controller: &CancellationToken) -> CancellationToken {
    match signal {
        Some(signal) => any_signal(&[&signal, controller]),
        None => controller.clone(),
    }
}

/// Starts work as an async function starts in JavaScript: it runs at once
/// up to its first await (once the state is unlocked), then on its own.
fn start_work(
    s: &mut State,
    future: impl std::future::Future<Output = ()> + Send + 'static,
) -> Work {
    let (done, finished) = oneshot::channel::<()>();
    s.starts.push(Box::pin(async move {
        future.await;
        let _ = done.send(());
    }));
    let finished: BoxFuture<()> = Box::pin(finished.map(|_| ()));
    finished.shared()
}

/// Runs a started work's first step here, and the rest as a task.
fn run_eagerly(mut start: BoxFuture<()>) {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    if start.as_mut().poll(&mut context).is_pending() {
        tokio::spawn(start);
    }
}

fn id_arg(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => js::to_text(other),
        None => "undefined".into(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

fn truthy_value(value: &Value) -> bool {
    truthy(Some(value))
}

fn keys_within(params: &Value, allowed: &[&str]) -> bool {
    params
        .as_object()
        .is_none_or(|map| map.keys().all(|key| allowed.contains(&key.as_str())))
}

fn obj(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl AssistantService {
    pub fn new(options: ServiceOptions) -> Self {
        let directory = options
            .directory
            .clone()
            .unwrap_or_else(|| assistant_directory(&ProcessEnv, &options.data));
        let driver = options
            .driver
            .clone()
            .or_else(|| {
                options
                    .create_driver
                    .as_ref()
                    .map(|create| create(directory.clone(), directory.clone()))
            })
            .unwrap_or_else(|| (options.default_driver)(directory.clone(), directory.clone()));
        let base_context = options.context.clone();
        let guard = Arc::new(TaskGuard {
            task_run: options.task_run.clone(),
            base: base_context.clone(),
            global_allowed: options.global_allowed.clone(),
            global_workspace_allowed: options.global_workspace_allowed.clone(),
            refresh_global_scope: options.refresh_global_scope.clone(),
        });
        let context: Arc<dyn AssistantContext> = if options.task_run.is_some() {
            Arc::new(TaskRunContext(guard.clone()))
        } else {
            base_context.clone()
        };
        let now = js::iso(options.clock.now() as f64);
        let initial = session_summary(None, &[], &now);
        let config = options
            .task_run
            .as_ref()
            .map(|run| run["config"].clone())
            .unwrap_or_else(|| {
                json!({"provider": "", "model": "", "credential_source": "assistant", "allowed_workspaces": []})
            });
        let state = State {
            instance_id: random_uuid(),
            revision: 0,
            session_id: initial["id"].as_str().unwrap().to_owned(),
            sessions: vec![initial],
            config,
            allowed_gen: 1,
            providers: json!([]),
            models: json!([]),
            messages: Vec::new(),
            running: false,
            error: None,
            auth: Value::Null,
            entries: Arc::new(Vec::new()),
            given: None,
            giving: None,
            historical_tools: HashMap::new(),
            entry_scope: String::new(),
            chat_workspaces: Vec::new(),
            requests: Vec::new(),
            pending_request: None,
            invalid_saved_state: false,
            disposed: false,
            changing: false,
            model_changing: false,
            run: None,
            active_run: None,
            active_scope: None,
            widen_active: None,
            queue: Vec::new(),
            queue_held: false,
            drain_scheduled: false,
            steer_missed: None,
            recovering: false,
            resume_again: false,
            awaiting_recovery: false,
            action_work: None,
            prepared_actions: HashMap::new(),
            turn_controller: None,
            auth_controller: None,
            auth_work: None,
            answer: None,
            timer: None,
            workspace_inventory: None,
            inventory_request: 0,
            inventory_applied: 0,
            inventory_grants: None,
            outbox: Vec::new(),
            starts: Vec::new(),
            next_id: 1,
        };
        let inner = Arc::new_cyclic(|weak| Inner {
            weak: weak.clone(),
            state_path: directory.join("state.json"),
            sessions_directory: directory.join("sessions"),
            directory,
            driver,
            base_context,
            context,
            guard,
            tasks: OnceLock::new(),
            task_confirmations: Mutex::new(Vec::new()),
            state: Mutex::new(state),
            queue_lock: tokio::sync::Mutex::new(()),
            task_publish_pending: AtomicBool::new(false),
            options,
        });
        inner.load();
        if inner.options.task_run.is_none() {
            let tasks = task_glue::create_tasks(&inner);
            let _ = inner.tasks.set(tasks.clone());
            let mut s = inner.lock();
            if tasks.invalid() {
                s.set_error("The saved Ranger tasks could not be loaded.");
            } else {
                let cancelled: Vec<String> = s
                    .messages
                    .iter()
                    .flat_map(|message| {
                        message
                            .get("task_proposals")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                    })
                    .filter(|proposal| proposal["status"] == "cancelled")
                    .map(|proposal| js::sv(proposal.get("id")).to_owned())
                    .collect();
                drop(s);
                for id in cancelled {
                    tasks.cancel_proposal(&id);
                }
            }
        }
        Self(inner)
    }

    /// Resumes a turn the bridge was running when it stopped, then the
    /// scheduled tasks.
    pub async fn resume(&self) -> AssistantResult<()> {
        self.0.resume_turn().await?;
        if let Some(tasks) = self.0.tasks.get() {
            tasks.resume().await;
        }
        Ok(())
    }

    /// The snapshot as it is now (`peek`).
    pub fn peek(&self) -> Value {
        let mut s = self.0.lock();
        self.0.current(&mut s)
    }

    pub async fn workspace_catalog(&self) -> AssistantResult<Value> {
        self.0.workspace_catalog().await
    }

    pub async fn mention_catalog(&self, params: Value) -> AssistantResult<Value> {
        self.0.mention_catalog(params).await
    }

    pub async fn snapshot(&self) -> AssistantResult<Value> {
        if self.0.lock().disposed {
            return Err(err("Ranger unavailable"));
        }
        if self.0.catalog().await.is_err() {
            self.0
                .lock()
                .set_error("The provider catalog could not be loaded.");
        }
        Ok(self.0.detailed_snapshot().await)
    }

    pub async fn handle(&self, method: &str, params: Value) -> AssistantResult<Value> {
        let result = self.0.handle(method, params).await;
        // A request can end a settings change or review without publishing.
        let mut s = self.0.lock();
        self.0.drain_queue(&mut s);
        drop(s);
        result
    }

    pub async fn task_detail(&self, params: Value) -> AssistantResult<Value> {
        self.0.task_detail(params).await
    }

    /// Hands the user's comments on parts of chat `session_id`'s messages
    /// to Ranger, as a message in that chat (queued behind a running turn).
    /// Fails with "busy" while it cannot take them, so the review tries
    /// again.
    pub async fn deliver_chat_comments(&self, session_id: &str, text: &str) -> AssistantResult<()> {
        let inner = &self.0;
        {
            let s = inner.lock();
            if s.disposed {
                return Err(err("Ranger unavailable"));
            }
            if inner.options.task_run.is_some() {
                return Err(err("A task run has no chat"));
            }
            if s.session_id != session_id {
                return Err(err(
                    "Ranger is busy in another chat; open this chat to send its comments",
                ));
            }
            let pending = s.messages.iter().any(|message| {
                message
                    .get("actions")
                    .and_then(Value::as_array)
                    .is_some_and(|actions| actions.iter().any(|a| a["status"] == "pending"))
                    || message
                        .get("task_proposals")
                        .and_then(Value::as_array)
                        .is_some_and(|items| items.iter().any(|p| p["status"] == "pending"))
            });
            if pending {
                return Err(err(
                    "Ranger is busy: a preview waits for confirmation in this chat",
                ));
            }
        }
        let result = inner
            .send(
                json!({
                    "text": js::head16(text, 20_000),
                    "request_id": random_uuid(),
                    "session_id": session_id,
                    "when_busy": "queue",
                }),
                None,
            )
            .await;
        let mut s = inner.lock();
        inner.drain_queue(&mut s);
        drop(s);
        result
    }

    pub async fn dispose(&self) {
        let inner = &self.0;
        let (auth, timer) = {
            let mut s = inner.lock();
            s.disposed = true;
            (s.auth_controller.clone(), s.timer.take())
        };
        if let Some((_, timer)) = timer {
            timer.abort();
        }
        if let Some(auth) = auth {
            auth.cancel();
        }
        if let Some(tasks) = inner.tasks.get() {
            tasks.dispose().await;
        }
        let _ = inner.driver.dispose().await;
        let works = {
            let s = inner.lock();
            if let Some(controller) = &s.turn_controller {
                controller.cancel();
            }
            [
                s.run.clone(),
                s.auth_work.clone(),
                s.action_work.as_ref().map(|(_, work)| work.clone()),
            ]
        };
        for work in works.into_iter().flatten() {
            work.await;
        }
    }
}

impl Inner {
    pub(crate) fn lock(&self) -> Locked<'_> {
        Locked {
            inner: self,
            guard: Some(self.state.lock().unwrap_or_else(|e| e.into_inner())),
        }
    }

    fn arc(&self) -> Arc<Inner> {
        self.weak.upgrade().expect("the service is alive")
    }

    fn now(&self) -> String {
        js::iso(self.options.clock.now() as f64)
    }

    fn tasks(&self) -> Option<&AssistantTasks> {
        self.tasks.get()
    }

    // ------------------------------------------------------------ loading

    fn load(&self) {
        let mut s = self.lock();
        let loaded = self.load_saved(&mut s);
        let mut migrate = false;
        match loaded {
            Ok(migrated) => migrate = migrated,
            Err(_) => {
                s.invalid_saved_state = true;
                s.set_error("The saved Ranger session could not be loaded.");
            }
        }
        if let Some(run) = &self.options.task_run
            && !same_assistant_config(&s.config, &run["config"])
        {
            s.active_run = None;
            s.awaiting_recovery = false;
            s.running = false;
            s.set_error("The scheduled task configuration changed and could not be restored.");
        }
        if migrate && self.persist(&mut s).is_err() {
            s.set_error("The Ranger session migration could not be saved.");
        }
    }

    /// The saved chat, if any: whether it was the single chat of old.
    fn load_saved(&self, s: &mut State) -> AssistantResult<bool> {
        let path = &self.state_path;
        self.options
            .data
            .assert_safe_data_path(path)
            .map_err(io_error)?;
        if !path.exists() {
            return Ok(false);
        }
        if std::fs::metadata(path).map_err(io_error)?.len() as usize > MAX_STATE_BYTES {
            return Err(err("Saved session is too large"));
        }
        let text = std::fs::read_to_string(path).map_err(io_error)?;
        let saved = js::parse(&text).ok_or_else(|| err("Invalid JSON"))?;
        let restored_config = config(saved.get("config").unwrap_or(&Value::Null))?;
        let restored = self.saved_session(s, &saved)?;
        let migrated = saved.get("session_id").is_none() && saved.get("sessions").is_none();
        let restored_id = if migrated {
            Some(json!(random_uuid()))
        } else {
            saved.get("session_id").cloned()
        };
        let restored_sessions = if migrated {
            Some(json!([session_summary(
                restored_id
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                &restored.messages,
                &self.now()
            )]))
        } else {
            saved.get("sessions").cloned()
        };
        let mut check = self.base_snapshot(s);
        check.insert("config".into(), restored_config.clone());
        match &restored_id {
            Some(id) => check.insert("session_id".into(), id.clone()),
            None => check.shift_remove("session_id"),
        };
        match &restored_sessions {
            Some(sessions) => check.insert("sessions".into(), sessions.clone()),
            None => check.shift_remove("sessions"),
        };
        check.insert("messages".into(), Value::Array(restored.messages.clone()));
        if !is_snapshot(&Value::Object(check)) {
            return Err(err("Invalid saved session"));
        }
        s.config = restored_config;
        s.allowed_gen = s.next();
        s.session_id = restored_id
            .and_then(|id| id.as_str().map(str::to_owned))
            .unwrap();
        s.sessions = restored_sessions
            .and_then(|sessions| sessions.as_array().cloned())
            .unwrap();
        s.messages = restored.messages;
        self.retire_previews_in(
            &mut s.messages,
            "The bridge restarted. Ask Ranger for a fresh preview.",
        );
        s.entries = Arc::new(restored.entries);
        s.entry_scope = restored.entry_scope;
        s.chat_workspaces = restored.created_workspaces;
        s.requests = restored.requests;
        s.queue = restored.queue;
        // A recovered turn drains the queue when it answers; otherwise wait.
        s.queue_held = !s.queue.is_empty() && saved.get("active_run").is_none();
        if let Some(pending) = saved.get("active_run") {
            let invalid = || err("Invalid saved Ranger run");
            let turn_config = config(pending.get("config").unwrap_or(&Value::Null))?;
            let targets_ok = pending
                .get("recovery_targets")
                .and_then(Value::as_array)
                .is_some_and(|targets| {
                    targets.len() <= ASSISTANT_MAX_WORKSPACES
                        && targets.iter().all(|target| {
                            target.is_object()
                                && target["connection_id"].is_string()
                                && target["workspace_id"].is_string()
                                && is_hex64(&id_arg(target.get("endpoint_fingerprint")))
                                && is_hex64(&id_arg(target.get("workspace_identity")))
                                && target["herdr_boot_id"]
                                    .as_str()
                                    .is_some_and(|boot| !boot.is_empty() && js::len16(boot) <= 500)
                        })
                });
            let request = pending.get("request_id");
            let requested = request
                .and_then(Value::as_str)
                .is_some_and(|id| s.requests.iter().any(|r| r == id));
            let mentions_ok = match pending.get("mentions") {
                None => true,
                Some(Value::Array(items)) => {
                    items.len() <= ASSISTANT_MAX_MENTIONS && items.iter().all(is_mention_target)
                }
                Some(_) => false,
            };
            let draft = pending.get("draft_id");
            let drafted = s
                .messages
                .iter()
                .any(|message| Some(&message["id"]) == draft && message["role"] == "assistant");
            if !targets_ok || !requested || !mentions_ok || !drafted {
                return Err(invalid());
            }
            let mut run = Map::new();
            run.insert(
                "request_id".into(),
                json!(string500(request, "request identifier")?),
            );
            run.insert(
                "draft_id".into(),
                json!(string500(draft, "draft identifier")?),
            );
            run.insert("config".into(), turn_config);
            run.insert(
                "text".into(),
                json!(string(
                    pending.get("text"),
                    "saved prompt",
                    MAX_CONTEXT_BYTES
                )?),
            );
            run.insert(
                "recovery_targets".into(),
                pending["recovery_targets"].clone(),
            );
            if let Some(mentions) = pending
                .get("mentions")
                .filter(|m| m.as_array().is_some_and(|m| !m.is_empty()))
            {
                run.insert("mentions".into(), mentions.clone());
            }
            if let Some(addressed) = pending.get("addressed").and_then(Value::as_str) {
                run.insert("addressed".into(), json!(js::head16(addressed, 200)));
            }
            if let Some(steers) = pending
                .get("steers")
                .filter(|steers| steers.as_array().is_some_and(|items| !items.is_empty()))
            {
                run.insert("steers".into(), Value::Array(saved_steers(steers)?));
            } else if pending
                .get("steers")
                .is_some_and(|steers| !steers.is_array() && truthy(steers.get("length")))
            {
                saved_steers(&pending["steers"])?;
            }
            s.active_run = Some(Arc::new(Mutex::new(Value::Object(run))));
            s.running = true;
            s.awaiting_recovery = true;
            s.turn_controller = Some(CancellationToken::new());
            s.set_error("Waiting for the original workspace connections to resume Ranger...");
        }
        let steering: Vec<String> = s
            .active_run
            .as_ref()
            .map(|run| {
                run.lock().unwrap()["steers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|steer| js::sv(steer.get("request_id")).to_owned())
                    .collect()
            })
            .unwrap_or_default();
        for item in &mut s.queue {
            if item["mode"] == "steer" && !steering.iter().any(|id| item["id"] == *id) {
                item["mode"] = json!("follow_up");
            }
        }
        Ok(migrated)
    }

    /// `savedSession(saved)`.
    fn saved_session(&self, s: &State, saved: &Value) -> AssistantResult<SavedSession> {
        let invalid = || err("Invalid saved session");
        let (Some(messages), Some(entries), Some(requests)) = (
            saved.get("messages").and_then(Value::as_array),
            saved.get("entries").and_then(Value::as_array),
            saved.get("requests").and_then(Value::as_array),
        ) else {
            return Err(invalid());
        };
        let mut check = self.base_snapshot(s);
        check.insert("messages".into(), Value::Array(messages.clone()));
        if !is_snapshot(&Value::Object(check))
            || !requests
                .iter()
                .all(|id| id.as_str().is_some_and(|id| js::len16(id) <= 500))
        {
            return Err(invalid());
        }
        let requests: Vec<String> = requests
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect();
        let start = requests.len().saturating_sub(1000);
        Ok(SavedSession {
            messages: messages.clone(),
            entries: if json_bytes_of(entries) <= MAX_CONTEXT_BYTES {
                entries.clone()
            } else {
                Vec::new()
            },
            entry_scope: saved
                .get("entry_scope")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            created_workspaces: match saved.get("created_workspaces") {
                None => Vec::new(),
                Some(value) => refs(Some(value)).unwrap_or_default(),
            },
            requests: requests[start..].to_vec(),
            queue: saved_queue(saved.get("queue"))?,
        })
    }

    // ------------------------------------------------------------ snapshots

    /// The snapshot fields of the state, in Bun's order.
    fn base_snapshot(&self, s: &State) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("chat_selection".into(), json!(true));
        map.insert("instance_id".into(), json!(s.instance_id));
        map.insert("revision".into(), json!(s.revision));
        map.insert("session_id".into(), json!(s.session_id));
        map.insert("sessions".into(), Value::Array(s.sessions.clone()));
        map.insert("config".into(), s.config.clone());
        map.insert("providers".into(), s.providers.clone());
        map.insert("models".into(), s.models.clone());
        map.insert("messages".into(), Value::Array(s.messages.clone()));
        map.insert("running".into(), json!(s.running));
        map.insert(
            "error".into(),
            s.error.clone().map_or(Value::Null, Value::String),
        );
        map.insert("auth".into(), s.auth.clone());
        map
    }

    fn retire_previews_in(&self, messages: &mut [Value], detail: &str) {
        let mut cancelled = Vec::new();
        for message in messages.iter_mut() {
            for action in message
                .get_mut("actions")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if action["status"] == "pending" {
                    action["status"] = json!("cancelled");
                    action["detail"] = json!(detail);
                } else if action["status"] == "executing" {
                    action["status"] = json!("uncertain");
                    action["detail"] = json!(
                        "The bridge restarted during execution. Check the target before proposing another operation; this action will not be replayed."
                    );
                }
            }
            for proposal in message
                .get_mut("task_proposals")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if proposal["status"] == "pending" {
                    proposal["status"] = json!("cancelled");
                    cancelled.push(js::sv(proposal.get("id")).to_owned());
                }
            }
        }
        if let Some(tasks) = self.tasks() {
            for id in cancelled {
                tasks.cancel_proposal(&id);
            }
        }
    }

    fn bound_messages(&self, s: &mut State) {
        let start = s.messages.len().saturating_sub(MAX_MESSAGES);
        s.messages.drain(..start);
        // Reasoning is display-only, so shed it from older turns before history.
        let mut bytes = json_bytes_of(&s.messages) as i64;
        let count = s.messages.len();
        for message in s.messages.iter_mut().take(count.saturating_sub(1)) {
            if bytes <= MAX_CONTEXT_BYTES as i64 {
                break;
            }
            let Some(map) = message.as_object_mut() else {
                continue;
            };
            if !map.contains_key("thinking") {
                continue;
            }
            let mut shed = Map::new();
            for key in ["thinking", "thinking_skipped", "thinking_truncated"] {
                if let Some(value) = map.get(key) {
                    shed.insert(key.into(), value.clone());
                }
            }
            bytes -= json_bytes(&Value::Object(shed)) as i64 - 1;
            for key in ["thinking", "thinking_skipped", "thinking_truncated"] {
                js::delete(map, key);
            }
        }
        // Removing [a, b] from the front drops both items and their commas.
        let keep = if s.running { 2 } else { 0 };
        while s.messages.len() > keep && bytes > MAX_CONTEXT_BYTES as i64 {
            let removed: Vec<Value> = s.messages.drain(..2.min(s.messages.len())).collect();
            bytes -= json_bytes_of(&removed) as i64 - 1;
        }
    }

    fn update_summary(&self, s: &mut State) {
        let Some(existing) = s
            .sessions
            .iter()
            .find(|session| session["id"] == s.session_id.as_str())
            .cloned()
        else {
            return;
        };
        let last = s
            .messages
            .last()
            .and_then(|message| message.get("sent_at"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut next = existing.clone();
        if existing["message_count"] == 0 && !s.messages.is_empty() {
            next["title"] = session_summary(
                Some(js::sv(existing.get("id")).to_owned()),
                &s.messages,
                &self.now(),
            )["title"]
                .clone();
        }
        if let Some(last) = last
            && !last.is_empty()
            && js::date_parse(&last) > js::date_parse(js::sv(existing.get("updated_at")))
        {
            next["updated_at"] = json!(last);
        }
        next["message_count"] = json!(s.messages.len());
        for session in &mut s.sessions {
            if session["id"] == next["id"] {
                *session = next.clone();
            }
        }
        s.sessions.sort_by(|a, b| {
            js::locale_compare(js::sv(b.get("updated_at")), js::sv(a.get("updated_at")))
        });
    }

    /// `current()`: the snapshot to publish.
    pub(crate) fn current(&self, s: &mut State) -> Value {
        self.bound_messages(s);
        self.update_summary(s);
        let mut snapshot = self.base_snapshot(s);
        if !s.queue.is_empty() || self.options.task_run.is_none() {
            let queue: Vec<Value> = s
                .queue
                .iter()
                .map(|item| {
                    let mut entry = Map::new();
                    for key in ["id", "mode", "text", "mentions", "sent_at"] {
                        if let Some(value) = item.get(key) {
                            entry.insert(key.into(), value.clone());
                        }
                    }
                    Value::Object(entry)
                })
                .collect();
            snapshot.insert("queue".into(), Value::Array(queue));
            if s.queue_held && !s.queue.is_empty() {
                snapshot.insert("queue_held".into(), json!(true));
            }
        }
        if let Some(tasks) = self.tasks() {
            snapshot.insert("tasks".into(), Value::Array(tasks.summaries()));
            if let Some(error) = tasks.error() {
                snapshot.insert("error".into(), json!(error));
            }
        }
        if let Some(Value::Array(messages)) = snapshot.get_mut("messages") {
            for message in messages {
                let id = js::sv(message.get("id")).to_owned();
                let Some(details) = s.historical_tools.get(&id) else {
                    continue;
                };
                for tool in message
                    .get_mut("tools")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    let Some(detail) = details.get(js::sv(tool.get("id"))) else {
                        continue;
                    };
                    if detail.get("name") != tool.get("name") {
                        continue;
                    }
                    for key in ["arguments", "output"] {
                        if tool.get(key).is_none()
                            && let Some(value) = detail.get(key)
                        {
                            tool[key] = value.clone();
                        }
                    }
                }
            }
        }
        Value::Object(snapshot)
    }

    async fn detailed_snapshot(&self) -> Value {
        let (snapshot, session, pointer) = {
            let mut s = self.lock();
            let snapshot = self.current(&mut s);
            (snapshot, s.session_id.clone(), s.entries.clone())
        };
        if !self.driver.reads_tool_details() {
            return snapshot;
        }
        let result = self
            .driver
            .read_tool_details(pointer.as_ref().clone(), snapshot["messages"].clone(), None)
            .await;
        let mut s = self.lock();
        if let Ok(messages) = result {
            if s.disposed
                || s.session_id != session
                || !Arc::ptr_eq(&s.entries, &pointer)
                || json!(s.revision) != snapshot["revision"]
            {
                return self.current(&mut s);
            }
            let original = snapshot["messages"].as_array().cloned().unwrap_or_default();
            let mut next: HashMap<String, HashMap<String, Value>> = HashMap::new();
            for message in messages.as_array().into_iter().flatten() {
                let message_id = js::sv(message.get("id")).to_owned();
                let mut tools = HashMap::new();
                for tool in message["tools"].as_array().into_iter().flatten() {
                    let tool_id = js::sv(tool.get("id")).to_owned();
                    let first = original
                        .iter()
                        .find(|item| item["id"] == message["id"])
                        .and_then(|item| {
                            item["tools"]
                                .as_array()
                                .and_then(|tools| tools.iter().find(|t| t["id"] == tool["id"]))
                        });
                    let previous = s
                        .historical_tools
                        .get(&message_id)
                        .and_then(|tools| tools.get(&tool_id));
                    let pick = |key: &str| {
                        previous.and_then(|p| p.get(key)).cloned().or_else(|| {
                            if first.and_then(|o| o.get(key)).is_none() {
                                tool.get(key).cloned()
                            } else {
                                None
                            }
                        })
                    };
                    let arguments = pick("arguments");
                    let output = pick("output");
                    if arguments.is_none() && output.is_none() {
                        continue;
                    }
                    let mut detail = Map::new();
                    detail.insert("id".into(), tool["id"].clone());
                    detail.insert(
                        "name".into(),
                        tool.get("name").cloned().unwrap_or(Value::Null),
                    );
                    detail.insert(
                        "status".into(),
                        tool.get("status").cloned().unwrap_or(Value::Null),
                    );
                    if let Some(arguments) = arguments {
                        detail.insert("arguments".into(), arguments);
                    }
                    if let Some(output) = output {
                        detail.insert("output".into(), output);
                    }
                    tools.insert(tool_id, Value::Object(detail));
                }
                next.insert(message_id, tools);
            }
            s.historical_tools = next;
            let tools_of = |messages: &Value| {
                js::stringify(&Value::Array(
                    messages
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|m| m.get("tools").cloned().unwrap_or(Value::Null))
                        .collect(),
                ))
            };
            if tools_of(&messages) != tools_of(&snapshot["messages"]) {
                self.publish(&mut s, true);
            }
        }
        self.current(&mut s)
    }

    /// `publish(immediate)`.
    pub(crate) fn publish(&self, s: &mut State, immediate: bool) {
        s.revision += 1;
        if s.disposed {
            return;
        }
        self.drain_queue(s);
        if immediate {
            if let Some((_, timer)) = s.timer.take() {
                timer.abort();
            }
            let snapshot = self.current(s);
            s.outbox.push(snapshot);
        } else if s.timer.is_none() {
            let id = s.next();
            let weak = self.weak.clone();
            let sleep = self.options.clock.sleep(Duration::from_millis(80));
            let handle = tokio::spawn(async move {
                sleep.await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let mut s = inner.lock();
                if s.timer.as_ref().is_none_or(|(timer, _)| *timer != id) {
                    return;
                }
                s.timer = None;
                if !s.disposed {
                    let snapshot = inner.current(&mut s);
                    s.outbox.push(snapshot);
                }
            });
            s.timer = Some((id, handle));
        }
    }

    // ------------------------------------------------------------ saving

    /// `writeSaved(path, saved, maxBytes)`.
    fn write_saved(
        &self,
        invalid_state: &mut bool,
        path: &Path,
        saved: &Value,
        max_bytes: usize,
    ) -> AssistantResult<()> {
        let contents = format!("{}\n", js::stringify(saved));
        if contents.len() > max_bytes {
            return Err(err("Saved session is too large"));
        }
        let data = &self.options.data;
        data.assert_safe_data_path(path).map_err(io_error)?;
        let parent = dirname(path);
        create_dir_all_mode(&parent).map_err(io_error)?;
        if !cfg!(windows) {
            set_mode(&parent, 0o700).map_err(io_error)?;
        }
        let temporary = parent.join(format!(".state-{}.tmp", random_uuid()));
        let result = (|| -> AssistantResult<()> {
            {
                use std::io::Write;
                let mut file = open_nofollow(&temporary, OpenMode::CreateNew).map_err(io_error)?;
                file.write_all(contents.as_bytes()).map_err(io_error)?;
            }
            data.assert_safe_data_path(path).map_err(io_error)?;
            if path == self.state_path && *invalid_state && self.state_path.exists() {
                std::fs::rename(
                    &self.state_path,
                    self.directory
                        .join(format!(".invalid-state-{}.json", random_uuid())),
                )
                .map_err(io_error)?;
                *invalid_state = false;
            }
            std::fs::rename(&temporary, path).map_err(io_error)
        })();
        let _ = std::fs::remove_file(&temporary);
        result
    }

    fn persist(&self, s: &mut State) -> AssistantResult<()> {
        self.bound_messages(s);
        self.update_summary(s);
        let start = s.requests.len().saturating_sub(1000);
        s.requests.drain(..start);
        if json_bytes_of(&s.entries) > MAX_CONTEXT_BYTES {
            s.entries = Arc::new(Vec::new());
        }
        let mut saved = Map::new();
        saved.insert("config".into(), s.config.clone());
        saved.insert("session_id".into(), json!(s.session_id));
        saved.insert("sessions".into(), Value::Array(s.sessions.clone()));
        saved.insert("messages".into(), Value::Array(s.messages.clone()));
        saved.insert("entries".into(), Value::Array(s.entries.as_ref().clone()));
        saved.insert("entry_scope".into(), json!(s.entry_scope));
        if !s.chat_workspaces.is_empty() {
            saved.insert(
                "created_workspaces".into(),
                Value::Array(s.chat_workspaces.clone()),
            );
        }
        saved.insert("requests".into(), json!(s.requests));
        if !s.queue.is_empty() {
            saved.insert("queue".into(), Value::Array(s.queue.clone()));
        }
        if let Some(run) = &s.active_run {
            saved.insert("active_run".into(), run.lock().unwrap().clone());
        }
        let mut invalid = s.invalid_saved_state;
        let result = self.write_saved(
            &mut invalid,
            &self.state_path,
            &Value::Object(saved),
            MAX_STATE_BYTES,
        );
        s.invalid_saved_state = invalid;
        result
    }

    /// `saveChange(change)`: the change and its save, or neither.
    fn save_change(
        &self,
        s: &mut State,
        change: impl FnOnce(&Inner, &mut State) -> AssistantResult<()>,
    ) -> AssistantResult<()> {
        let previous = (
            s.config.clone(),
            s.allowed_gen,
            s.messages.clone(),
            s.session_id.clone(),
            s.sessions.clone(),
            s.providers.clone(),
            s.models.clone(),
            s.error.clone(),
            s.auth.clone(),
        );
        let previous_entries = s.entries.clone();
        let previous_scope = s.entry_scope.clone();
        let previous_workspaces = s.chat_workspaces.clone();
        let previous_requests = s.requests.clone();
        let previous_prepared = s.prepared_actions.clone();
        let previous_run = s.active_run.clone();
        let previous_queue = s.queue.clone();
        let previous_steers = previous_run
            .as_ref()
            .and_then(|run| run.lock().unwrap().get("steers").cloned());
        let previous_held = s.queue_held;
        let result = change(self, s).and_then(|()| self.persist(s));
        if result.is_err() {
            (
                s.config,
                s.allowed_gen,
                s.messages,
                s.session_id,
                s.sessions,
                s.providers,
                s.models,
                s.error,
                s.auth,
            ) = previous;
            s.queue = previous_queue;
            s.queue_held = previous_held;
            if let Some(run) = &previous_run {
                let mut run = run.lock().unwrap();
                match previous_steers {
                    Some(steers) => run["steers"] = steers,
                    None => {
                        if let Some(map) = run.as_object_mut() {
                            js::delete(map, "steers");
                        }
                    }
                }
            }
            s.entries = previous_entries;
            s.entry_scope = previous_scope;
            s.chat_workspaces = previous_workspaces;
            s.requests = previous_requests;
            s.active_run = previous_run;
            s.prepared_actions = previous_prepared;
            return Err(err("The Ranger changes could not be saved."));
        }
        Ok(())
    }

    fn session_path(&self, id: &str) -> PathBuf {
        self.sessions_directory.join(format!("{id}.json"))
    }

    fn archive_current(&self, s: &mut State) -> AssistantResult<()> {
        self.bound_messages(s);
        self.update_summary(s);
        if s.messages.is_empty() {
            let id = s.session_id.clone();
            s.sessions.retain(|session| session["id"] != id.as_str());
            return Ok(());
        }
        let mut archived = s.messages.clone();
        self.retire_previews_in(
            &mut archived,
            "This chat was left. Ask Ranger for a fresh preview.",
        );
        let mut saved = Map::new();
        saved.insert("session_id".into(), json!(s.session_id));
        saved.insert("messages".into(), Value::Array(archived));
        saved.insert(
            "entries".into(),
            if json_bytes_of(&s.entries) <= MAX_CONTEXT_BYTES {
                Value::Array(s.entries.as_ref().clone())
            } else {
                json!([])
            },
        );
        saved.insert("entry_scope".into(), json!(s.entry_scope));
        if !s.chat_workspaces.is_empty() {
            saved.insert(
                "created_workspaces".into(),
                Value::Array(s.chat_workspaces.clone()),
            );
        }
        let start = s.requests.len().saturating_sub(1000);
        saved.insert("requests".into(), json!(s.requests[start..]));
        if !s.queue.is_empty() {
            saved.insert("queue".into(), Value::Array(s.queue.clone()));
        }
        let path = self.session_path(&s.session_id);
        let mut invalid = s.invalid_saved_state;
        let result = self.write_saved(&mut invalid, &path, &Value::Object(saved), MAX_STATE_BYTES);
        s.invalid_saved_state = invalid;
        result
    }

    /// Reads a saved chat (`sessions/<id>.json`).
    fn read_session_file(&self, path: &Path) -> AssistantResult<Value> {
        self.options
            .data
            .assert_safe_data_path(path)
            .map_err(io_error)?;
        if std::fs::metadata(path).map_err(io_error)?.len() as usize > MAX_STATE_BYTES {
            return Err(err("Too large"));
        }
        let text = std::fs::read_to_string(path).map_err(io_error)?;
        js::parse(&text).ok_or_else(|| err("Invalid JSON"))
    }

    // ------------------------------------------------------------ tasks

    fn sync_task_proposals(&self, messages: &mut [Value], ids: Option<&[String]>) -> bool {
        let Some(tasks) = self.tasks() else {
            return false;
        };
        let mut changed = false;
        for message in messages.iter_mut() {
            for proposal in message
                .get_mut("task_proposals")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                let id = js::sv(proposal.get("id")).to_owned();
                if ids.is_some_and(|ids| !ids.contains(&id)) {
                    continue;
                }
                let Some(saved) = tasks.proposal(&id) else {
                    continue;
                };
                if js::stringify(&saved) == js::stringify(proposal) {
                    continue;
                }
                if let (Some(target), Some(source)) = (proposal.as_object_mut(), saved.as_object())
                {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
                changed = true;
            }
        }
        changed
    }

    /// The tasks' publish: applied at once, or once the state is unlocked
    /// when a change holds it.
    fn on_task_publish(&self) {
        self.task_publish_pending.store(true, Ordering::SeqCst);
        if let Ok(guard) = self.state.try_lock() {
            drop(guard);
            if self.task_publish_pending.swap(false, Ordering::SeqCst) {
                self.publish_task_changes();
            }
        }
    }

    /// `publishTaskChanges()`.
    fn publish_task_changes(&self) {
        let mut s = self.lock();
        let result = (|| -> AssistantResult<()> {
            let mut messages = std::mem::take(&mut s.messages);
            let changed = self.sync_task_proposals(&mut messages, None);
            s.messages = messages;
            if changed {
                if !s.running {
                    s.entries = Arc::new(Vec::new());
                }
                self.persist(&mut s)?;
            }
            let mut archived: Vec<(String, Vec<String>)> = Vec::new();
            for (_, id, session) in self.task_confirmations.lock().unwrap().iter() {
                if *session == s.session_id
                    || !s.sessions.iter().any(|item| item["id"] == session.as_str())
                {
                    continue;
                }
                match archived.iter_mut().find(|(key, _)| key == session) {
                    Some((_, ids)) => ids.push(id.clone()),
                    None => archived.push((session.clone(), vec![id.clone()])),
                }
            }
            for (session, ids) in archived {
                let path = self.session_path(&session);
                let saved = self.read_session_file(&path)?;
                if saved.get("session_id") != Some(&json!(session)) {
                    return Err(err("Invalid saved session"));
                }
                let mut restored = self.saved_session(&s, &saved)?;
                if self.sync_task_proposals(&mut restored.messages, Some(&ids)) {
                    let mut next = saved.clone();
                    next["messages"] = Value::Array(restored.messages);
                    let mut invalid = s.invalid_saved_state;
                    let result = self.write_saved(&mut invalid, &path, &next, MAX_STATE_BYTES);
                    s.invalid_saved_state = invalid;
                    result?;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            s.set_error("The task receipt was saved, but the chat could not be updated.");
        }
        self.publish(&mut s, true);
    }

    async fn confirm_task_proposal(
        &self,
        id: &str,
        authorized: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> AssistantResult<()> {
        let key = {
            let mut s = self.lock();
            let key = s.next();
            self.task_confirmations.lock().unwrap().push((
                key,
                id.to_owned(),
                s.session_id.clone(),
            ));
            key
        };
        let result = self.tasks().unwrap().confirm_proposal(id, authorized).await;
        self.publish_task_changes();
        self.task_confirmations
            .lock()
            .unwrap()
            .retain(|(k, ..)| *k != key);
        result
    }

    // ------------------------------------------------------------ scope

    fn workspace_removed(&self, s: &State, item: &Value) -> bool {
        let Some(inventory) = &s.workspace_inventory else {
            return false;
        };
        let connection = item.get("connection_id");
        let listed_connection = |key: &str| {
            inventory
                .get(key)
                .and_then(Value::as_array)
                .map(|ids| ids.iter().any(|id| Some(id) == connection))
        };
        listed_connection("connection_ids") == Some(false)
            || (listed_connection("complete_connection_ids") == Some(true)
                && !inventory["workspaces"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|w| same_ref(w, item)))
    }

    fn all_workspaces(&self, selection: &Value) -> bool {
        self.options.task_run.is_none()
            && selection.get("approval_mode") == Some(&json!("auto"))
            && selection.get("workspace_scope") == Some(&json!("all"))
    }

    fn chat_created(&self, s: &State, item: &Value) -> bool {
        s.chat_workspaces.iter().any(|w| same_ref(w, item))
    }

    /// What this chat's turns (or this task run) may use: the grant, and
    /// the workspaces Ranger created here.
    fn chat_workspace_allowed(&self, s: &State, item: &Value) -> bool {
        (!self.workspace_removed(s, item) && self.chat_created(s, item))
            || self.workspace_allowed(s, item)
    }

    pub(crate) fn workspace_allowed(&self, s: &State, item: &Value) -> bool {
        if self.workspace_removed(s, item) {
            return false;
        }
        if self.options.task_run.is_some() && !self.guard.globally_allowed(item) {
            return false;
        }
        // High mode is a dynamic grant, while task runs retain their fixed scope.
        self.all_workspaces(&s.config) || s.allowed().iter().any(|w| same_ref(w, item))
    }

    fn effective_scope(&self, s: &State, selection: &Value) -> Vec<Value> {
        if self.all_workspaces(selection) {
            s.workspace_inventory
                .as_ref()
                .and_then(|inventory| inventory["workspaces"].as_array())
                .into_iter()
                .flatten()
                .map(ref_of)
                .collect()
        } else {
            s.allowed()
        }
    }

    fn assert_scope_allowed(&self, s: &State, scope: &[Value]) -> AssistantResult<()> {
        if scope.is_empty()
            || scope
                .iter()
                .any(|item| !self.chat_workspace_allowed(s, item))
        {
            return Err(err("Choose an authorized workspace scope"));
        }
        Ok(())
    }

    fn assert_scope_value(&self, s: &State, scope: &Value) -> AssistantResult<()> {
        self.assert_scope_allowed(s, scope.as_array().map_or(&[][..], Vec::as_slice))
    }

    fn auto_approve(&self, s: &State, admitted: &Value) -> bool {
        !s.disposed
            && admitted.get("approval_mode") == Some(&json!("auto"))
            && s.approval_mode().as_deref() == Some("auto")
            && (self.options.task_run.is_none()
                || (self
                    .options
                    .global_approval_mode
                    .as_ref()
                    .and_then(|mode| mode())
                    .as_deref()
                    == Some("auto")
                    && self
                        .guard
                        .targets()
                        .iter()
                        .all(|target| self.guard.globally_allowed(target))))
    }

    async fn mention_catalog(&self, params: Value) -> AssistantResult<Value> {
        if !self.context.provides(ContextOp::MentionCatalog) {
            return Err(err("Update the bridge to use Ranger mentions."));
        }
        if !keys_within(&params, &["scope"]) {
            return Err(err("Invalid mention search parameters."));
        }
        let inventory = self.workspace_catalog().await?;
        let scope = match params.get("scope") {
            None => {
                let s = self.lock();
                self.effective_scope(&s, &s.config.clone())
                    .into_iter()
                    .filter(|item| {
                        inventory["workspaces"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|w| same_ref(w, item))
                    })
                    .collect()
            }
            Some(scope) => refs(Some(scope))?,
        };
        if scope.is_empty() {
            return Ok(json!({"targets": [], "errors": []}));
        }
        self.assert_scope_allowed(&self.lock(), &scope)?;
        let captured = self
            .context
            .capture_scope(Value::Array(scope), None, None)
            .await?;
        self.assert_scope_value(&self.lock(), &captured.workspaces)?;
        let result = self.context.mention_catalog(&captured, None).await?;
        self.assert_scope_value(&self.lock(), &captured.workspaces)?;
        Ok(result)
    }

    pub(crate) fn workspace_catalog(&self) -> BoxFuture<AssistantResult<Value>> {
        let inner = self.arc();
        Box::pin(async move { inner.workspace_catalog_once(false).await })
    }

    async fn workspace_catalog_once(self: Arc<Self>, retried: bool) -> AssistantResult<Value> {
        let (request, granted, created_before) = {
            let mut s = self.lock();
            if s.disposed {
                return Err(err("Ranger unavailable"));
            }
            s.inventory_request += 1;
            let created: Vec<String> = s.chat_workspaces.iter().map(ref_key).collect();
            (s.inventory_request, s.allowed_gen, created)
        };
        let result = self.base_context.catalog().await?;
        match self.apply_listing(request, granted, &created_before, result, retried)? {
            Some(listing) => Ok(listing),
            None => Box::pin(self.clone().workspace_catalog_once(true)).await,
        }
    }

    /// The listing applied, or None to list again.
    fn apply_listing(
        &self,
        request: u64,
        granted: u64,
        created_before: &[String],
        result: Value,
        retried: bool,
    ) -> AssistantResult<Option<Value>> {
        let mut s = self.lock();
        if s.disposed {
            return Err(err("Ranger unavailable"));
        }
        // A slower, older listing must not resurrect deleted scopes or
        // overwrite a newer connection snapshot.
        if request < s.inventory_applied && s.inventory_grants == Some(s.allowed_gen) {
            return Ok(Some(s.workspace_inventory.clone().unwrap_or(Value::Null)));
        }
        if request < s.inventory_applied || granted != s.allowed_gen {
            // A concurrent configuration save is newer evidence than this
            // listing. Refresh once before publishing authoritative absence.
            if retried {
                return Err(err(
                    "Workspace permissions changed during refresh. Try again.",
                ));
            }
            return Ok(None);
        }
        s.inventory_applied = request;
        s.workspace_inventory = Some(result.clone());
        // A workspace Ranger created is forgotten once a complete listing
        // no longer has it. One created after this listing started is kept.
        let kept: Vec<Value> = s
            .chat_workspaces
            .iter()
            .filter(|w| !created_before.contains(&ref_key(w)) || !self.workspace_removed(&s, w))
            .cloned()
            .collect();
        if kept.len() != s.chat_workspaces.len() {
            s.chat_workspaces = kept;
            // Narrower in memory; the next listing prunes the saved list.
            let _ = self.persist(&mut s);
        }
        if self.options.task_run.is_none() {
            let retained: Vec<Value> = s
                .allowed()
                .into_iter()
                .filter(|w| !self.workspace_removed(&s, w))
                .collect();
            if retained.len() != s.allowed().len() {
                let previous = (s.config.clone(), s.allowed_gen, s.entries.clone());
                s.config["allowed_workspaces"] = Value::Array(retained);
                s.allowed_gen = s.next();
                if !s.running {
                    s.entries = Arc::new(Vec::new());
                }
                if self.persist(&mut s).is_err() {
                    (s.config, s.allowed_gen, s.entries) = previous;
                    return Err(err("The workspace permissions could not be saved."));
                }
                self.publish(&mut s, true);
            }
        }
        s.inventory_grants = Some(s.allowed_gen);
        Ok(Some(result))
    }

    async fn catalog(&self) -> AssistantResult<()> {
        let source = js::sv(self.lock().config.get("credential_source")).to_owned();
        let result = self.driver.catalog(&source).await?;
        let mut s = self.lock();
        if js::sv(s.config.get("credential_source")) == source {
            assign_catalog(&mut s, &result);
        }
        Ok(())
    }

    fn check_selection(&self, s: &State, value: Option<&Value>) -> AssistantResult<()> {
        let Some(Value::Object(expected)) = value else {
            return Err(err("Invalid expected Ranger selection"));
        };
        const KEYS: [&str; 5] = [
            "instance_id",
            "provider",
            "model",
            "credential_source",
            "thinking_level",
        ];
        if expected.keys().any(|key| !KEYS.contains(&key.as_str())) {
            return Err(err("Invalid expected Ranger selection"));
        }
        if expected.get("instance_id") != Some(&json!(s.instance_id))
            || expected.get("provider") != s.config.get("provider")
            || expected.get("model") != s.config.get("model")
            || expected.get("credential_source") != s.config.get("credential_source")
            || expected.get("thinking_level") != s.config.get("thinking_level")
        {
            return Err(err(
                "The Ranger model or thinking effort changed. Review the current selection and try again.",
            ));
        }
        Ok(())
    }

    fn check_thinking(selection: &Value, models: &Value) -> AssistantResult<()> {
        let model = models.as_array().into_iter().flatten().find(|model| {
            model.get("provider") == selection.get("provider")
                && model.get("id") == selection.get("model")
        });
        let levels = model.and_then(|model| model.get("thinking_levels"));
        let empty = levels.and_then(Value::as_array).is_some_and(Vec::is_empty);
        let unsupported = selection.get("thinking_level").is_some_and(|level| {
            !levels
                .and_then(Value::as_array)
                .is_some_and(|levels| levels.contains(level))
        });
        if empty || unsupported {
            return Err(err(
                "The selected thinking effort is not supported by this model",
            ));
        }
        Ok(())
    }

    fn idle(&self, s: &State) -> AssistantResult<()> {
        if s.disposed {
            return Err(err("Ranger unavailable"));
        }
        if s.running || s.changing || s.auth_controller.is_some() || s.action_work.is_some() {
            return Err(err("Ranger is busy"));
        }
        Ok(())
    }

    fn cancel_pending_actions(&self, s: &mut State, detail: &str) {
        let mut cancelled = Vec::new();
        for message in &mut s.messages {
            for action in message
                .get_mut("actions")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if action["status"] == "pending" {
                    action["status"] = json!("cancelled");
                    action["detail"] = json!(detail);
                }
            }
            for proposal in message
                .get_mut("task_proposals")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if proposal["status"] == "pending" {
                    proposal["status"] = json!("cancelled");
                    cancelled.push(js::sv(proposal.get("id")).to_owned());
                }
            }
        }
        if let Some(tasks) = self.tasks() {
            for id in cancelled {
                tasks.cancel_proposal(&id);
            }
        }
        s.prepared_actions.clear();
    }

    fn message(&self, role: &str, text: &str) -> Value {
        json!({
            "id": random_uuid(),
            "role": role,
            "text": text,
            "sent_at": self.now(),
            "tools": [],
            "sources": [],
        })
    }

    fn pending_review(&self, s: &State) -> bool {
        s.messages.iter().any(|item| {
            item.get("actions")
                .and_then(Value::as_array)
                .is_some_and(|actions| {
                    actions
                        .iter()
                        .any(|a| a["status"] == "pending" || a["status"] == "executing")
                })
                || item
                    .get("task_proposals")
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.iter().any(|p| p["status"] == "pending"))
        })
    }

    // ------------------------------------------------------------ queue

    /// `queueTask(task)`: one at a time, in the order they were asked.
    async fn queue_task<T>(&self, task: impl std::future::Future<Output = T>) -> T {
        let _turn = self.queue_lock.lock().await;
        task.await
    }

    /// The one place that decides whether the oldest follow-up may go.
    pub(crate) fn drain_queue(&self, s: &mut State) {
        if s.drain_scheduled || s.disposed {
            return;
        }
        s.drain_scheduled = true;
        let inner = self.arc();
        tokio::spawn(async move {
            {
                inner.lock().drain_scheduled = false;
            }
            let worker = inner.clone();
            inner
                .queue_task(async move {
                    let next = {
                        let s = worker.lock();
                        let next = s.queue.first().cloned();
                        if next.is_none()
                            || s.queue_held
                            || s.disposed
                            || s.running
                            || s.changing
                            || s.auth_controller.is_some()
                            || s.action_work.is_some()
                            || worker.pending_review(&s)
                        {
                            return;
                        }
                        next.unwrap()
                    };
                    let _ = worker.send_queued(next).await;
                })
                .await;
        });
    }

    async fn send_queued(self: &Arc<Self>, item: Value) -> AssistantResult<()> {
        let session = self.lock().session_id.clone();
        let mut params = Map::new();
        params.insert("text".into(), item["text"].clone());
        params.insert("request_id".into(), item["id"].clone());
        params.insert("session_id".into(), json!(session));
        if item
            .get("mentions")
            .and_then(Value::as_array)
            .is_some_and(|m| !m.is_empty())
        {
            params.insert("mentions".into(), item["mentions"].clone());
        }
        if let Some(scope) = item.get("scope") {
            params.insert("scope".into(), scope.clone());
        }
        let result = self.send(Value::Object(params), Some(item)).await;
        if let Err(error) = &result {
            let mut s = self.lock();
            s.queue_held = true;
            if !s.disposed {
                s.set_error(format!(
                    "The queued message was not sent. {}",
                    error.message()
                ));
                self.publish(&mut s, true);
            }
        }
        result
    }

    // ------------------------------------------------------------ details

    async fn task_detail(&self, params: Value) -> AssistantResult<Value> {
        let tasks = match (self.lock().disposed, self.tasks()) {
            (false, Some(tasks)) => tasks.clone(),
            _ => return Err(err("Ranger tasks unavailable")),
        };
        if !keys_within(&params, &["task_id", "run_id"]) {
            return Err(err("Task detail accepts only task and run identifiers."));
        }
        let run_id = params.get("run_id").map(|id| id_arg(Some(id)));
        let mut detail = tasks.detail(&id_arg(params.get("task_id")), run_id.as_deref())?;
        let incomplete = detail
            .get("run")
            .and_then(|run| run["messages"].as_array())
            .is_some_and(|messages| {
                messages.iter().any(|message| {
                    message["tools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|tool| tool.get("arguments").is_none() || tool.get("output").is_none())
                })
            });
        if incomplete && self.driver.reads_tool_details() {
            let source = self
                .directory
                .join("tasks")
                .join(js::sv(detail["task"].get("id")))
                .join("runs")
                .join(js::sv(detail["run"].get("id")));
            let path = source.join("state.json");
            let read = async {
                self.options
                    .data
                    .assert_safe_data_path(&path)
                    .map_err(io_error)?;
                if std::fs::metadata(&path).map_err(io_error)?.len() as usize <= MAX_STATE_BYTES {
                    let text = std::fs::read_to_string(&path).map_err(io_error)?;
                    let saved = js::parse(&text).ok_or_else(|| err("Invalid JSON"))?;
                    if let Some(entries) = saved.get("entries").and_then(Value::as_array) {
                        let messages = self
                            .driver
                            .read_tool_details(
                                entries.clone(),
                                detail["run"]["messages"].clone(),
                                Some(source.clone()),
                            )
                            .await?;
                        return Ok::<_, AssistantError>(Some(messages));
                    }
                }
                Ok(None)
            };
            if let Ok(Some(messages)) = read.await {
                detail["run"]["messages"] = messages;
            }
        }
        Ok(detail)
    }
}

struct SavedSession {
    messages: Vec<Value>,
    entries: Vec<Value>,
    entry_scope: String,
    created_workspaces: Vec<Value>,
    requests: Vec<String>,
    queue: Vec<Value>,
}

/// `Object.assign(state, catalog)`.
fn assign_catalog(s: &mut State, catalog: &Value) {
    if let Some(providers) = catalog.get("providers") {
        s.providers = providers.clone();
    }
    if let Some(models) = catalog.get("models") {
        s.models = models.clone();
    }
}

fn configured_in(catalog: &Value, config: &Value) -> bool {
    catalog["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| p.get("id") == config.get("provider") && p["configured"] == true)
        && catalog["models"].as_array().into_iter().flatten().any(|m| {
            m.get("provider") == config.get("provider") && m.get("id") == config.get("model")
        })
}

impl Inner {
    // ------------------------------------------------------------ handle

    async fn handle(self: &Arc<Self>, method: &str, params: Value) -> AssistantResult<Value> {
        if self.lock().disposed {
            return Err(err("Ranger unavailable"));
        }
        let method = method.strip_prefix("bridge.assistant.").unwrap_or(method);
        if let Some(operation) = method.strip_prefix("task.") {
            self.handle_task(operation, params).await?;
            let mut s = self.lock();
            return Ok(self.current(&mut s));
        }
        match method {
            "configure_chat" => self.configure_chat(&params).await?,
            "configure_approval" => {
                let mode = params.get("approval_mode");
                let scope = params.get("workspace_scope");
                if !keys_within(&params, &["approval_mode", "workspace_scope"])
                    || (mode != Some(&json!("manual")) && mode != Some(&json!("auto")))
                    || (scope.is_some()
                        && (scope != Some(&json!("all")) || mode != Some(&json!("auto"))))
                {
                    return Err(err("Invalid approval mode"));
                }
                let mut s = self.lock();
                if mode == Some(&json!("auto")) {
                    self.idle(&s)?;
                }
                let previous = s.config.clone();
                s.config["approval_mode"] = mode.unwrap().clone();
                if let Some(map) = s.config.as_object_mut() {
                    js::delete(map, "workspace_scope");
                }
                if scope.is_some() {
                    s.config["workspace_scope"] = json!("all");
                }
                if self.persist(&mut s).is_err() {
                    s.config = previous;
                    return Err(err("The approval mode could not be saved."));
                }
                self.publish(&mut s, true);
            }
            "get" => {
                if self.catalog().await.is_err() {
                    self.lock()
                        .set_error("The provider catalog could not be loaded.");
                }
            }
            "configure_model" => self.configure_model(&params).await?,
            "configure" => self.configure(&params).await?,
            "send" => self.send(params, None).await?,
            "queue.remove" => {
                if !keys_within(&params, &["id"]) {
                    return Err(err("Removal accepts only the message identifier."));
                }
                let id = string500(params.get("id"), "message identifier")?;
                // Behind the worker, a message being sent is gone by the time
                // this runs, so it can never be removed and still sent.
                self.queue_task(async {
                    let mut s = self.lock();
                    let Some(item) = s.queue.iter().find(|entry| entry["id"] == id.as_str()) else {
                        return Err(err("This message was already sent."));
                    };
                    if item["mode"] == "steer" {
                        return Err(err(
                            "This message is already steering Ranger and can no longer be removed.",
                        ));
                    }
                    self.save_change(&mut s, |_, s| {
                        s.queue.retain(|entry| entry["id"] != id.as_str());
                        Ok(())
                    })?;
                    self.publish(&mut s, true);
                    Ok(())
                })
                .await?;
            }
            "queue.resume" => {
                if params.as_object().is_some_and(|map| !map.is_empty()) {
                    return Err(err("Resuming the queue accepts no parameters."));
                }
                self.queue_task(async {
                    let next = {
                        let s = self.lock();
                        let Some(next) = s.queue.first().cloned() else {
                            return Ok(());
                        };
                        self.idle(&s)?;
                        next
                    };
                    self.send_queued(next).await
                })
                .await?;
            }
            "stop" => self.stop().await?,
            "new_session" => {
                let mut s = self.lock();
                self.idle(&s)?;
                let now = self.now();
                self.save_change(&mut s, |inner, s| {
                    inner.archive_current(s)?;
                    let next = session_summary(None, &[], &now);
                    s.session_id = js::sv(next.get("id")).to_owned();
                    s.sessions.push(next);
                    s.messages = Vec::new();
                    s.entries = Arc::new(Vec::new());
                    s.entry_scope = String::new();
                    s.chat_workspaces = Vec::new();
                    s.requests = Vec::new();
                    s.queue = Vec::new();
                    s.queue_held = false;
                    s.prepared_actions.clear();
                    s.error = None;
                    Ok(())
                })?;
                self.publish(&mut s, true);
            }
            "select_session" => self.select_session(&params)?,
            "action.confirm" => self.confirm_action(&params).await?,
            "action.cancel" => {
                let mut s = self.lock();
                self.idle(&s)?;
                let id = string500(params.get("action_id"), "action identifier")?;
                let Some(action) = s.action_mut(&id) else {
                    return Err(err("This action is no longer available."));
                };
                if action["status"] == "pending" {
                    action["status"] = json!("cancelled");
                    action["detail"] = json!("Cancelled. Nothing was executed.");
                    s.prepared_actions.remove(&id);
                    s.entries = Arc::new(Vec::new());
                    self.persist(&mut s)?;
                    self.publish(&mut s, true);
                }
            }
            "auth.start" => self.start_auth(&params).await?,
            "auth.respond" => self.respond_auth(&params)?,
            "auth.cancel" => {
                let work = {
                    let s = self.lock();
                    if truthy(params.get("auth_id")) && params.get("auth_id") != s.auth.get("id") {
                        return Err(err("This login is no longer active"));
                    }
                    if let Some(controller) = &s.auth_controller {
                        controller.cancel();
                    }
                    s.auth_work.clone()
                };
                if let Some(work) = work {
                    work.await;
                }
            }
            _ => return Err(err("Unknown Ranger method")),
        }
        if method == "get" || method == "select_session" {
            Ok(self.detailed_snapshot().await)
        } else {
            let mut s = self.lock();
            Ok(self.current(&mut s))
        }
    }

    async fn configure_chat(self: &Arc<Self>, params: &Value) -> AssistantResult<()> {
        let provider;
        let model;
        {
            let mut s = self.lock();
            if s.changing || s.auth_controller.is_some() {
                return Err(err("Ranger settings are busy"));
            }
            let level = params.get("thinking_level");
            if !keys_within(params, &["provider", "model", "thinking_level", "expected"])
                || (level != Some(&Value::Null) && !level.is_some_and(is_thinking_level))
            {
                return Err(err("Invalid Ranger chat selection"));
            }
            provider = string500(params.get("provider"), "provider")?;
            model = string500(params.get("model"), "model")?;
            self.check_selection(&s, params.get("expected"))?;
            s.changing = true;
        }
        let result = async {
            let source = js::sv(self.lock().config.get("credential_source")).to_owned();
            let available = self
                .driver
                .catalog(&source)
                .await
                .map_err(|_| err("The model catalog could not be loaded. Try again."))?;
            let mut s = self.lock();
            if s.disposed {
                return Err(err("Ranger unavailable"));
            }
            self.check_selection(&s, params.get("expected"))?;
            let next_config = json!({"provider": provider, "model": model});
            if !configured_in(&available, &next_config) {
                return Err(err("The selected model is not configured"));
            }
            // Only replace the next-turn selection.
            let mut next = s.config.clone();
            next["provider"] = json!(provider);
            next["model"] = json!(model);
            if let Some(map) = next.as_object_mut() {
                js::delete(map, "thinking_level");
            }
            if let Some(level) = params.get("thinking_level").filter(|l| !l.is_null()) {
                next["thinking_level"] = level.clone();
            }
            Self::check_thinking(&next, &available["models"])?;
            let previous = (s.config.clone(), s.providers.clone(), s.models.clone());
            s.config = next;
            assign_catalog(&mut s, &available);
            if self.persist(&mut s).is_err() {
                (s.config, s.providers, s.models) = previous;
                return Err(err("The Ranger chat selection could not be saved."));
            }
            self.publish(&mut s, true);
            Ok(())
        }
        .await;
        self.lock().changing = false;
        result
    }

    async fn configure_model(self: &Arc<Self>, params: &Value) -> AssistantResult<()> {
        {
            let mut s = self.lock();
            self.idle(&s)?;
            if self.tasks().is_some_and(|tasks| {
                tasks
                    .summaries()
                    .iter()
                    .any(|task| task["current_run"]["status"] == "running")
            }) {
                return Err(err(
                    "Stop the running Ranger task before editing a model connection.",
                ));
            }
            s.changing = true;
            s.model_changing = true;
        }
        let result = async {
            let invalid = || err("Invalid model connection");
            let source = self.lock().config.get("credential_source").cloned();
            if !self.driver.configures_models()
                || params.get("credential_source") != source.as_ref()
                || !keys_within(
                    params,
                    &[
                        "provider",
                        "model",
                        "models",
                        "reasoning",
                        "thinking_levels",
                        "base_url",
                        "api",
                        "api_key",
                        "credential_source",
                    ],
                )
            {
                return Err(invalid());
            }
            let provider = js::trim(&string(params.get("provider"), "provider", 64)?).to_owned();
            let model = js::trim(&string500(params.get("model"), "model")?).to_owned();
            let raw_models = params.get("models");
            if raw_models.is_some_and(|models| {
                models.as_array().is_none_or(|models| {
                    models.is_empty() || models.len() > ASSISTANT_MAX_CUSTOM_MODELS
                })
            }) {
                return Err(invalid());
            }
            let models = match raw_models {
                None => None,
                Some(raw) => {
                    let mut unique: Vec<String> = Vec::new();
                    for id in raw.as_array().unwrap() {
                        let id = js::trim(&string500(Some(id), "model")?).to_owned();
                        if !unique.contains(&id) {
                            unique.push(id);
                        }
                    }
                    Some(unique)
                }
            };
            let base_url = js::trim(&string(params.get("base_url"), "base URL", 2000)?).to_owned();
            let thinking = params.get("thinking_levels");
            let reasoning = params.get("reasoning");
            let control = |text: &str| text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}');
            let provider_ok = regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$")
                .unwrap()
                .is_match(&provider);
            let thinking_bad = thinking.is_some_and(|levels| match levels.as_array() {
                None => true,
                Some(levels) => {
                    let unique: std::collections::HashSet<String> =
                        levels.iter().map(js::stringify).collect();
                    levels.is_empty()
                        || !levels.iter().all(is_thinking_level)
                        || unique.len() != levels.len()
                        || reasoning.is_some_and(|reasoning| {
                            *reasoning != json!(levels.iter().any(|l| *l != "off"))
                        })
                }
            });
            if !provider_ok
                || control(&model)
                || models.as_ref().is_some_and(|models| {
                    !models.contains(&model) || models.iter().any(|id| control(id))
                })
                || !is_model_endpoint(&json!(base_url))
                || !params.get("api").is_some_and(is_model_api)
                || reasoning.is_some_and(|r| !r.is_boolean())
                || thinking_bad
            {
                return Err(invalid());
            }
            let api_key = match params.get("api_key") {
                None => None,
                Some(key) => Some(string(Some(key), "API key", 10_000)?),
            };
            if api_key
                .as_ref()
                .is_some_and(|key| js::trim_start(key).starts_with('!') || key.contains('$'))
            {
                return Err(err("Enter a literal API key"));
            }
            let mut input = Map::new();
            input.insert("provider".into(), json!(provider));
            input.insert("model".into(), json!(model));
            if let Some(models) = models {
                input.insert("models".into(), json!(models));
            }
            if let Some(reasoning) = reasoning {
                input.insert("reasoning".into(), reasoning.clone());
            }
            if let Some(thinking) = thinking {
                input.insert("thinking_levels".into(), thinking.clone());
            }
            input.insert("base_url".into(), json!(base_url));
            input.insert("api".into(), params["api"].clone());
            if let Some(key) = api_key {
                input.insert("api_key".into(), json!(key));
            }
            input.insert(
                "credential_source".into(),
                source.clone().unwrap_or(Value::Null),
            );
            let weak = self.weak.clone();
            let save: crate::driver::SaveModels = Arc::new(move |path, value| {
                let inner = weak.upgrade().ok_or_else(|| err("Ranger unavailable"))?;
                let mut invalid = inner.lock().invalid_saved_state;
                let result =
                    inner.write_saved(&mut invalid, Path::new(&path), &value, MAX_STATE_BYTES);
                inner.lock().invalid_saved_state = invalid;
                result
            });
            self.driver
                .configure_model(Value::Object(input), save)
                .await?;
            if self.lock().disposed {
                return Err(err("Ranger unavailable"));
            }
            self.catalog().await?;
            {
                let mut s = self.lock();
                s.error = None;
                s.model_changing = false;
            }
            if let Some(tasks) = self.tasks() {
                tasks.revalidate().await;
            }
            let mut s = self.lock();
            self.publish(&mut s, true);
            Ok(())
        }
        .await;
        let mut s = self.lock();
        s.changing = false;
        s.model_changing = false;
        result.map_err(|_| {
            err("The model connection could not be saved. Check the custom provider, endpoint, model and API key.")
        })
    }

    async fn configure(self: &Arc<Self>, params: &Value) -> AssistantResult<()> {
        let mut next = {
            let mut s = self.lock();
            self.idle(&s)?;
            let value = match params.get("config") {
                Some(config) if !config.is_null() => config,
                _ => params,
            };
            let next = config(value)?;
            s.changing = true;
            next
        };
        let result = async {
            self.workspace_catalog().await?;
            let (previous, added) = {
                let s = self.lock();
                let previous = s.config.clone();
                let kept: Vec<Value> = next["allowed_workspaces"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|w| !self.workspace_removed(&s, w))
                    .cloned()
                    .collect();
                next["allowed_workspaces"] = Value::Array(kept);
                let existing: Vec<String> = previous["allowed_workspaces"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(ref_key)
                    .collect();
                let added: Vec<Value> = next["allowed_workspaces"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|w| !existing.contains(&ref_key(w)))
                    .cloned()
                    .collect();
                (previous, added)
            };
            if !added.is_empty() {
                self.context
                    .capture_scope(Value::Array(added.clone()), None, None)
                    .await?;
            }
            let next_catalog = self
                .driver
                .catalog(js::sv(next.get("credential_source")))
                .await?;
            {
                let mut s = self.lock();
                if s.disposed {
                    return Err(err("Ranger unavailable"));
                }
                let provider = js::sv(next.get("provider"));
                if !provider.is_empty()
                    && !next_catalog["providers"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|p| p.get("id") == next.get("provider"))
                {
                    return Err(err("Invalid provider"));
                }
                if !js::sv(next.get("model")).is_empty()
                    && !next_catalog["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|m| {
                            m.get("provider") == next.get("provider")
                                && m.get("id") == next.get("model")
                        })
                {
                    return Err(err("Invalid model"));
                }
                Self::check_thinking(&next, &next_catalog["models"])?;
                self.save_change(&mut s, |inner, s| {
                    let mut value = next.clone();
                    value["allowed_workspaces"] = Value::Array(
                        next["allowed_workspaces"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|w| {
                                added.iter().any(|item| same_ref(item, w))
                                    || !inner.workspace_removed(s, w)
                            })
                            .cloned()
                            .collect(),
                    );
                    for key in ["approval_mode", "workspace_scope"] {
                        match s.config.get(key) {
                            Some(mode) => value[key] = mode.clone(),
                            None => {
                                if let Some(map) = value.as_object_mut() {
                                    js::delete(map, key);
                                }
                            }
                        }
                    }
                    s.config = config(&value)?;
                    s.allowed_gen = s.next();
                    inner.cancel_pending_actions(
                        s,
                        "The Ranger configuration changed. Ask for a fresh preview.",
                    );
                    assign_catalog(s, &next_catalog);
                    if previous.get("provider") != next.get("provider")
                        || previous.get("credential_source") != next.get("credential_source")
                    {
                        s.auth = Value::Null;
                    }
                    // Removed scope must not remain in the model's historical tool context.
                    if js::stringify(&previous["allowed_workspaces"])
                        != js::stringify(&next["allowed_workspaces"])
                    {
                        s.entries = Arc::new(Vec::new());
                    }
                    s.error = None;
                    Ok(())
                })?;
            }
            if let Some(tasks) = self.tasks() {
                tasks.revalidate().await;
            }
            let mut s = self.lock();
            self.publish(&mut s, true);
            Ok(())
        }
        .await;
        self.lock().changing = false;
        result.map_err(|_: AssistantError| {
            err("The Ranger configuration could not be saved. Check the provider, model and workspace scope.")
        })
    }

    fn select_session(self: &Arc<Self>, params: &Value) -> AssistantResult<()> {
        let mut s = self.lock();
        self.idle(&s)?;
        let id = string500(params.get("session_id"), "session identifier")?;
        if !keys_within(params, &["session_id"]) || !is_session_id(&id) {
            return Err(err("Selection accepts only a saved session identifier."));
        }
        if !s
            .sessions
            .iter()
            .any(|session| session["id"] == id.as_str())
        {
            return Err(err("This Ranger chat is no longer available."));
        }
        if s.session_id == id {
            return Ok(());
        }
        let selected = (|| {
            let saved = self.read_session_file(&self.session_path(&id))?;
            if saved.get("session_id") != Some(&json!(id)) {
                return Err(err("Invalid saved session"));
            }
            let mut selected = self.saved_session(&s, &saved)?;
            self.retire_previews_in(
                &mut selected.messages,
                "This saved preview has expired. Ask Ranger for a fresh preview.",
            );
            Ok(selected)
        })()
        .map_err(|_: AssistantError| err("The saved Ranger chat could not be loaded."))?;
        self.save_change(&mut s, move |inner, s| {
            inner.archive_current(s)?;
            s.session_id = id;
            s.messages = selected.messages;
            s.entries = Arc::new(selected.entries);
            s.entry_scope = selected.entry_scope;
            s.chat_workspaces = selected.created_workspaces;
            s.requests = selected.requests;
            s.queue = selected.queue;
            for item in &mut s.queue {
                item["mode"] = json!("follow_up");
            }
            s.queue_held = true;
            s.prepared_actions.clear();
            s.error = None;
            Ok(())
        })?;
        self.publish(&mut s, true);
        Ok(())
    }

    async fn stop(self: &Arc<Self>) -> AssistantResult<()> {
        let (waiting, controller) = {
            let mut s = self.lock();
            let waiting = s.awaiting_recovery;
            s.queue_held = true;
            if s.active_run.is_some() {
                // Persist cancellation intent before touching the running
                // harness: a crash during abort must not resume it.
                self.save_change(&mut s, |_, s| {
                    s.active_run = None;
                    s.entries = Arc::new(Vec::new());
                    Ok(())
                })?;
            }
            (waiting, s.turn_controller.clone())
        };
        if let Some(controller) = controller {
            controller.cancel();
        }
        self.driver
            .stop()
            .await
            .map_err(|_| err("Ranger could not be stopped."))?;
        let run = self.lock().run.clone();
        if let Some(run) = run {
            run.await;
        }
        if waiting {
            let mut s = self.lock();
            s.awaiting_recovery = false;
            s.running = false;
            s.error = None;
            s.turn_controller = None;
            s.entries = Arc::new(Vec::new());
            for item in &mut s.queue {
                item["mode"] = json!("follow_up");
            }
            if let Some(last) = s.messages.last_mut() {
                for tool in last
                    .get_mut("tools")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    if tool["status"] == "running" {
                        tool["status"] = json!("failed");
                    }
                }
            }
            self.persist(&mut s)?;
            self.publish(&mut s, true);
        }
        Ok(())
    }

    async fn handle_task(self: &Arc<Self>, operation: &str, params: Value) -> AssistantResult<()> {
        let Some(tasks) = self.tasks().cloned() else {
            return Err(err("Nested scheduled tasks are unavailable."));
        };
        match operation {
            "create" => {
                let mut input = obj(params.clone());
                let request = input.shift_remove("request_id");
                let prepared = self
                    .prepare_task(Value::Object(input), None, None, None, None)
                    .await?;
                let request = string500(request.as_ref(), "task request identifier")?;
                tasks.create(&prepared, &request).await?;
            }
            "update" => {
                let mut input = obj(params.clone());
                let task_id = id_arg(input.shift_remove("task_id").as_ref());
                let mut updated = crate::saved::validate_task_input(&Value::Object(input))?;
                let original = tasks.snapshot(&task_id)?;
                let previous = original.prepared.clone();
                let previous_mentions: Vec<Value> = previous["input"]["mentions"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let retained: Vec<Value> = updated["mentions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|mention| {
                        previous_mentions
                            .iter()
                            .any(|target| mention_target_key(target) == mention_target_key(mention))
                    })
                    .cloned()
                    .collect();
                if !retained.is_empty() {
                    self.workspace_catalog().await?;
                    self.assert_scope_allowed(&self.lock(), &retained)?;
                    if !self.context.provides(ContextOp::RestoreScope)
                        || !self.context.provides(ContextOp::BindMentions)
                    {
                        return Err(err("Task references are unavailable."));
                    }
                    let parents: Vec<String> = retained.iter().map(ref_key).collect();
                    let targets: Vec<Value> = previous["targets"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|target| parents.contains(&ref_key(target)))
                        .cloned()
                        .collect();
                    let restored = self
                        .context
                        .restore_scope(Value::Array(targets), None)
                        .await?;
                    let rebound = self
                        .context
                        .bind_mentions(
                            &restored,
                            Value::Array(restored_mentions(&retained, &restored.workspaces)?),
                            None,
                        )
                        .await?;
                    self.assert_scope_value(&self.lock(), &restored.workspaces)?;
                    let rebound = rebound.as_array().cloned().unwrap_or_default();
                    let mentions: Vec<Value> = updated["mentions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|mention| {
                            rebound
                                .iter()
                                .find(|target| {
                                    mention_target_key(target) == mention_target_key(mention)
                                })
                                .cloned()
                                .unwrap_or_else(|| mention.clone())
                        })
                        .collect();
                    updated["mentions"] = Value::Array(mentions);
                }
                let prepared = self.prepare_task(updated, None, None, None, None).await?;
                tasks.update(&task_id, &prepared, Some(original)).await?;
            }
            "delete" => {
                if !keys_within(&params, &["task_id"]) {
                    return Err(err("Task deletion accepts only the task identifier."));
                }
                tasks.delete(&id_arg(params.get("task_id")))?;
            }
            "pause" | "resume" | "cancel" | "run_now" | "stop" => {
                if !keys_within(&params, &["task_id"]) {
                    return Err(err("Task control accepts only the task identifier."));
                }
                tasks
                    .control(operation, &id_arg(params.get("task_id")))
                    .await?;
            }
            "confirm_proposal" | "cancel_proposal" => {
                if !keys_within(&params, &["proposal_id"]) {
                    return Err(err(
                        "Task confirmation accepts only the proposal identifier.",
                    ));
                }
                let id = string500(params.get("proposal_id"), "task proposal identifier")?;
                let (pending, session) = {
                    let s = self.lock();
                    let proposal = s
                        .messages
                        .iter()
                        .flat_map(|m| {
                            m.get("task_proposals")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                        })
                        .find(|p| p["id"] == id.as_str());
                    let Some(proposal) = proposal else {
                        return Err(err("This task proposal is no longer available."));
                    };
                    (proposal["status"] == "pending", s.session_id.clone())
                };
                if pending {
                    let failure = if operation == "confirm_proposal" {
                        self.confirm_task_proposal(&id, None).await.err()
                    } else {
                        tasks.cancel_proposal(&id);
                        None
                    };
                    let mut s = self.lock();
                    let saved = tasks.proposal(&id);
                    for message in &mut s.messages {
                        for proposal in message
                            .get_mut("task_proposals")
                            .and_then(Value::as_array_mut)
                            .into_iter()
                            .flatten()
                        {
                            if proposal["id"] == id.as_str()
                                && let (Some(target), Some(Value::Object(source))) =
                                    (proposal.as_object_mut(), &saved)
                            {
                                for (key, value) in source {
                                    target.insert(key.clone(), value.clone());
                                }
                            }
                        }
                    }
                    // Confirmation may happen while this question is still
                    // streaming: keep its durable pointer until it completes.
                    if s.session_id == session {
                        if !s.running {
                            s.entries = Arc::new(Vec::new());
                        }
                        if self.persist(&mut s).is_err() {
                            s.set_error(
                                "The task receipt was saved, but the chat could not be updated.",
                            );
                        }
                        self.publish(&mut s, true);
                    }
                    if let Some(failure) = failure {
                        return Err(failure);
                    }
                }
            }
            "action.confirm" | "action.cancel" => {
                if !keys_within(&params, &["task_id", "run_id", "action_id"]) {
                    return Err(err("Task actions accept only target identifiers."));
                }
                tasks
                    .action(
                        if operation == "action.confirm" {
                            "confirm"
                        } else {
                            "cancel"
                        },
                        &id_arg(params.get("task_id")),
                        &id_arg(params.get("run_id")),
                        &id_arg(params.get("action_id")),
                    )
                    .await?;
            }
            _ => return Err(err("Unknown Ranger task method")),
        }
        Ok(())
    }
}
