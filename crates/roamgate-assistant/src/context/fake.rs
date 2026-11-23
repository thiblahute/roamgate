//! A fake [`ContextHost`] for the context and actions tests: the TS
//! fixtures' runtimes (a Herdr world per connection, the mocked readers),
//! with each mock's calls recorded and its implementation replaceable,
//! once or for good, as `mock.mockImplementation(Once)` does.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_connections::usage_limit::LimitPause;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::live::{BeforeSend, ContextHost, IsCurrent, Lease};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::BoxFuture;

pub type Reply = BoxFuture<AssistantResult<Value>>;

/// A Herdr call as a mock sees it.
pub struct CallCtx {
    pub fake: Arc<Fake>,
    pub connection: String,
    pub method: String,
    pub params: Value,
    pub before_send: Option<BeforeSend>,
}

impl CallCtx {
    /// The fixture's own implementation (`original(...)`).
    pub fn original(&self) -> AssistantResult<Value> {
        self.fake.run_default(
            &self.connection,
            &self.method,
            &self.params,
            self.before_send.as_ref(),
        )
    }

    /// `beforeSend?.()`.
    pub fn before_send(&self) -> AssistantResult<()> {
        self.before_send.as_ref().map_or(Ok(()), |gate| gate())
    }
}

pub type CallFn = Arc<dyn Fn(CallCtx) -> Reply + Send + Sync>;
pub type CallOnce = Box<dyn FnOnce(CallCtx) -> Reply + Send>;
pub type ReadFn = Arc<dyn Fn(Arc<Fake>, Value) -> Reply + Send + Sync>;
pub type ReadOnce = Box<dyn FnOnce(Arc<Fake>, Value) -> Reply + Send>;
pub type IdentityFn =
    Arc<dyn Fn(Arc<Fake>) -> BoxFuture<AssistantResult<Option<String>>> + Send + Sync>;
pub type WorktreeFn = Arc<dyn Fn(Arc<Fake>, Value, IsCurrent, BeforeSend) -> Reply + Send + Sync>;
pub type OwnedFn = Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>;
pub type CheckFn = Arc<dyn Fn(&str, usize) + Send + Sync>;

/// A fixture's Herdr; the fake calls `beforeSend` first, as the actions
/// fixture does.
pub type DefaultCall = fn(&mut Conn, &str, &Value) -> AssistantResult<Value>;

/// One connection's Herdr and runtime.
pub struct Conn {
    pub generation: u64,
    pub ready: bool,
    pub fingerprint: Option<String>,
    pub remote_platform: Option<String>,
    pub ssh_host: Option<String>,
    pub workspaces: Vec<Value>,
    pub panes: Vec<Value>,
    pub tabs: Vec<Value>,
    pub worktrees: Vec<Value>,
    pub agent: Value,
    pub process: Value,
    pub main_pane: String,
    pub mutations: Vec<String>,
    pub setup: Option<String>,
    pub calls: Vec<(String, Value, u64)>,
    pub once: VecDeque<CallOnce>,
    pub over: Option<CallFn>,
    pub lease_calls: usize,
    pub current_checks: usize,
    pub history: VecDeque<ReadOnce>,
    pub history_default: Value,
    pub history_calls: Vec<Value>,
    pub diff_file: VecDeque<ReadOnce>,
    pub diff_file_default: Value,
    pub diff_file_calls: Vec<Value>,
    pub diff_summary_default: Value,
    pub diff_summary_calls: Vec<Value>,
    pub identity: IdentityFn,
    pub identity_calls: usize,
    pub pauses: Vec<LimitPause>,
    pub owned: Option<OwnedFn>,
    pub summary: Option<Value>,
    pub hooks_calls: usize,
    pub git_root: Option<ReadFn>,
    pub git_root_calls: usize,
    pub root: String,
}

impl Conn {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            ready: true,
            fingerprint: None,
            remote_platform: None,
            ssh_host: None,
            workspaces: Vec::new(),
            panes: Vec::new(),
            tabs: Vec::new(),
            worktrees: Vec::new(),
            agent: json!({}),
            process: json!({}),
            main_pane: String::new(),
            mutations: Vec::new(),
            setup: None,
            calls: Vec::new(),
            once: VecDeque::new(),
            over: None,
            lease_calls: 0,
            current_checks: 0,
            history: VecDeque::new(),
            history_default: Value::Null,
            history_calls: Vec::new(),
            diff_file: VecDeque::new(),
            diff_file_default: Value::Null,
            diff_file_calls: Vec::new(),
            diff_summary_default: Value::Null,
            diff_summary_calls: Vec::new(),
            identity: Arc::new(|_| Box::pin(async { Ok(Some("boot-1".to_owned())) })),
            identity_calls: 0,
            pauses: Vec::new(),
            owned: None,
            summary: None,
            hooks_calls: 0,
            git_root: None,
            git_root_calls: 0,
            root: String::new(),
        }
    }

    pub fn methods(&self) -> Vec<String> {
        self.calls
            .iter()
            .map(|(method, ..)| method.clone())
            .collect()
    }

    pub fn count(&self, method: &str) -> usize {
        self.calls.iter().filter(|(m, ..)| m == method).count()
    }
}

pub struct Fake {
    me: Weak<Fake>,
    pub catalog: Mutex<Vec<Value>>,
    pub conns: Mutex<HashMap<String, Conn>>,
    pub default_call: DefaultCall,
    pub settings: Mutex<Value>,
    pub settings_reads: AtomicUsize,
    pub create_worktree: Mutex<Option<WorktreeFn>>,
    pub can_create_worktree: bool,
    pub worktree_calls: Mutex<Vec<Value>>,
    pub prompted: Mutex<Vec<Value>>,
    pub created: Mutex<Vec<Value>>,
    pub causes: Mutex<Vec<Value>>,
    pub inspect: Mutex<Option<ReadFn>>,
    pub inspect_calls: AtomicUsize,
    /// `(sshHost, remotePlatform)` of each directory inspection.
    pub inspect_hosts: Mutex<Vec<(Option<String>, Option<String>)>>,
    /// The repository settings key a workspace resolves to.
    pub repo_key: Mutex<Option<String>>,
    pub repo_inputs: Mutex<Vec<Value>>,
    /// Called with the connection after each `is_current` check.
    pub on_check: Mutex<Option<CheckFn>>,
}

impl Fake {
    pub fn new(default_call: DefaultCall) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            catalog: Mutex::new(Vec::new()),
            conns: Mutex::new(HashMap::new()),
            default_call,
            settings: Mutex::new(json!({})),
            settings_reads: AtomicUsize::new(0),
            create_worktree: Mutex::new(None),
            can_create_worktree: true,
            worktree_calls: Mutex::new(Vec::new()),
            prompted: Mutex::new(Vec::new()),
            created: Mutex::new(Vec::new()),
            causes: Mutex::new(Vec::new()),
            inspect: Mutex::new(None),
            inspect_calls: AtomicUsize::new(0),
            inspect_hosts: Mutex::new(Vec::new()),
            repo_key: Mutex::new(None),
            repo_inputs: Mutex::new(Vec::new()),
            on_check: Mutex::new(None),
        })
    }

    fn arc(&self) -> Arc<Fake> {
        self.me.upgrade().expect("the fake lives")
    }

    pub fn add(&self, id: &str, label: &str, conn: Conn) {
        self.catalog
            .lock()
            .unwrap()
            .push(json!({ "id": id, "label": label }));
        self.conns.lock().unwrap().insert(id.to_owned(), conn);
    }

    /// Runs `f` on a connection's state.
    pub fn with<T>(&self, id: &str, f: impl FnOnce(&mut Conn) -> T) -> T {
        f(self
            .conns
            .lock()
            .unwrap()
            .get_mut(id)
            .expect("a connection"))
    }

    pub fn run_default(
        &self,
        connection: &str,
        method: &str,
        params: &Value,
        before_send: Option<&BeforeSend>,
    ) -> AssistantResult<Value> {
        if let Some(gate) = before_send {
            gate()?;
        }
        let default = self.default_call;
        self.with(connection, |conn| default(conn, method, params))
    }

    pub fn retire(&self, id: &str) {
        self.with(id, |conn| conn.generation += 1);
    }

    pub fn disconnect(&self, id: &str) {
        self.with(id, |conn| conn.ready = false);
    }

    /// `call.mockImplementationOnce`.
    pub fn once(&self, id: &str, f: impl FnOnce(CallCtx) -> Reply + Send + 'static) {
        self.with(id, |conn| conn.once.push_back(Box::new(f)));
    }

    /// `call.mockImplementation`.
    pub fn over(&self, id: &str, f: impl Fn(CallCtx) -> Reply + Send + Sync + 'static) {
        self.with(id, |conn| conn.over = Some(Arc::new(f)));
    }

    /// `call.mockResolvedValueOnce(value)`.
    pub fn resolve_once(&self, id: &str, value: Value) {
        self.once(id, move |_| Box::pin(async move { Ok(value) }));
    }

    pub fn mutations(&self, id: &str) -> Vec<String> {
        self.with(id, |conn| conn.mutations.clone())
    }

    pub fn lease_of(&self, id: &str) -> Lease {
        self.with(id, |conn| Lease {
            connection_id: id.to_owned(),
            generation: conn.generation,
            remote_platform: conn.remote_platform.clone(),
            ssh_host: conn.ssh_host.clone(),
        })
    }
}

/// A connection's error, as the runtime throws it.
pub fn fail<T>(message: &str) -> AssistantResult<T> {
    Err(AssistantError::internal(message))
}

impl ContextHost for Fake {
    fn catalog(&self) -> BoxFuture<AssistantResult<Vec<Value>>> {
        let catalog = self.catalog.lock().unwrap().clone();
        Box::pin(async move { Ok(catalog) })
    }

    fn lease(&self, connection_id: &str) -> BoxFuture<AssistantResult<Option<Lease>>> {
        let lease = self.with(connection_id, |conn| {
            conn.lease_calls += 1;
            conn.ready
        });
        let lease = lease.then(|| self.lease_of(connection_id));
        Box::pin(async move { Ok(lease) })
    }

    fn is_current(&self, lease: &Lease) -> bool {
        let (current, checks) = self.with(&lease.connection_id, |conn| {
            conn.current_checks += 1;
            (
                conn.ready && conn.generation == lease.generation,
                conn.current_checks,
            )
        });
        let hook = self.on_check.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(&lease.connection_id, checks);
        }
        current
    }

    fn recovery_fingerprint(
        &self,
        connection_id: &str,
    ) -> BoxFuture<AssistantResult<Option<String>>> {
        let value = self.with(connection_id, |conn| conn.fingerprint.clone());
        Box::pin(async move { Ok(value) })
    }

    fn limit_pauses(&self, connection_id: &str) -> BoxFuture<AssistantResult<Vec<LimitPause>>> {
        let pauses = self.with(connection_id, |conn| conn.pauses.clone());
        Box::pin(async move { Ok(pauses) })
    }

    fn can_create_worktree(&self) -> bool {
        self.can_create_worktree
    }

    fn create_worktree(
        &self,
        lease: &Lease,
        params: Value,
        is_current: IsCurrent,
        before_dispatch: BeforeSend,
    ) -> Reply {
        self.worktree_calls.lock().unwrap().push(params.clone());
        let fake = self.arc();
        let id = lease.connection_id.clone();
        let custom = self.create_worktree.lock().unwrap().clone();
        if let Some(custom) = custom {
            return custom(fake, params, is_current, before_dispatch);
        }
        Box::pin(
            async move { default_worktree(&fake, &id, &params, &is_current, &before_dispatch) },
        )
    }

    fn agent_prompted(&self, input: Value) {
        self.prompted.lock().unwrap().push(input);
    }

    fn workspace_created(&self, input: Value) -> BoxFuture<AssistantResult<()>> {
        self.created.lock().unwrap().push(input);
        Box::pin(async { Ok(()) })
    }

    fn herdr_call(
        &self,
        lease: &Lease,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> Reply {
        let id = lease.connection_id.clone();
        let (once, over) = self.with(&id, |conn| {
            conn.calls
                .push((method.to_owned(), params.clone(), timeout_ms));
            (conn.once.pop_front(), conn.over.clone())
        });
        let ctx = CallCtx {
            fake: self.arc(),
            connection: id,
            method: method.to_owned(),
            params,
            before_send,
        };
        if let Some(once) = once {
            return once(ctx);
        }
        if let Some(over) = over {
            return over(ctx);
        }
        Box::pin(async move { ctx.original() })
    }

    fn read_git_diff_file(&self, lease: &Lease, query: Value) -> Reply {
        let (once, value) = self.with(&lease.connection_id, |conn| {
            conn.diff_file_calls.push(query.clone());
            (conn.diff_file.pop_front(), conn.diff_file_default.clone())
        });
        match once {
            Some(once) => once(self.arc(), query),
            None => Box::pin(async move { Ok(value) }),
        }
    }

    fn read_git_diff_summary(&self, lease: &Lease, query: Value) -> Reply {
        let value = self.with(&lease.connection_id, |conn| {
            conn.diff_summary_calls.push(query);
            conn.diff_summary_default.clone()
        });
        Box::pin(async move { Ok(value) })
    }

    fn resolve_workspace_git_root(&self, lease: &Lease, query: Value) -> Reply {
        let (custom, value) = self.with(&lease.connection_id, |conn| {
            conn.git_root_calls += 1;
            (
                conn.git_root.clone(),
                json!({ "root": conn.root, "workspace": conn.workspaces.first() }),
            )
        });
        match custom {
            Some(custom) => custom(self.arc(), query),
            None => Box::pin(async move { Ok(value) }),
        }
    }

    fn read_history(&self, lease: &Lease, query: Value) -> Reply {
        let (once, value) = self.with(&lease.connection_id, |conn| {
            conn.history_calls.push(query.clone());
            (conn.history.pop_front(), conn.history_default.clone())
        });
        match once {
            Some(once) => once(self.arc(), query),
            None => Box::pin(async move { Ok(value) }),
        }
    }

    fn read_summary(
        &self,
        lease: &Lease,
        _query: Value,
    ) -> BoxFuture<AssistantResult<Option<Value>>> {
        let summary = self.with(&lease.connection_id, |conn| conn.summary.clone());
        Box::pin(async move { Ok(summary) })
    }

    fn owned_session(
        &self,
        lease: &Lease,
        pane_id: &str,
    ) -> BoxFuture<AssistantResult<Option<Value>>> {
        let owned = self.with(&lease.connection_id, |conn| conn.owned.clone());
        let session = owned.and_then(|owned| owned(pane_id));
        Box::pin(async move { Ok(session) })
    }

    fn conversation_prompt(
        &self,
        _lease: &Lease,
        _pane_id: &str,
        _prompt: &str,
        _before_send: BeforeSend,
    ) -> BoxFuture<AssistantResult<bool>> {
        // No pane is in conversation mode: prompts are typed into the pane.
        Box::pin(async { Ok(false) })
    }

    fn read_worktree_hooks(&self, lease: &Lease, _cwd: &str) -> Reply {
        let (setup, root) = self.with(&lease.connection_id, |conn| {
            conn.hooks_calls += 1;
            (conn.setup.clone(), conn.root.clone())
        });
        Box::pin(async move {
            Ok(match setup {
                None => Value::Null,
                Some(setup) => json!({
                    "config": { "setup": setup },
                    "path": format!("{root}/roamgate.json"),
                    "source": "roamgate",
                }),
            })
        })
    }

    fn recovery_identity(&self, lease: &Lease) -> BoxFuture<AssistantResult<Option<String>>> {
        let identity = self.with(&lease.connection_id, |conn| {
            conn.identity_calls += 1;
            conn.identity.clone()
        });
        identity(self.arc())
    }

    fn read_gui_settings(&self) -> Reply {
        self.settings_reads.fetch_add(1, Ordering::SeqCst);
        let settings = self.settings.lock().unwrap().clone();
        Box::pin(async move { Ok(settings) })
    }

    fn resolve_repo_settings_key(&self, _lease: &Lease, input: Value) -> Reply {
        self.repo_inputs.lock().unwrap().push(input.clone());
        let key = self.repo_key.lock().unwrap().clone().or_else(|| {
            input["workspace"]["cwd"]
                .as_str()
                .map(|cwd| format!("repo:{cwd}"))
        });
        Box::pin(async move { Ok(json!({ "key": key, "commonDir": null })) })
    }

    fn inspect_workspace_path(&self, lease: &Lease, cwd: &str) -> Reply {
        self.inspect_calls.fetch_add(1, Ordering::SeqCst);
        self.inspect_hosts
            .lock()
            .unwrap()
            .push((lease.ssh_host.clone(), lease.remote_platform.clone()));
        let custom = self.inspect.lock().unwrap().clone();
        if let Some(custom) = custom {
            return custom(self.arc(), json!(cwd));
        }
        let path = std::path::Path::new(cwd);
        let value = if !path.exists() {
            json!({ "path": cwd, "error": "Directory does not exist." })
        } else if !path.is_dir() {
            json!({ "path": cwd, "error": "Path is not a directory." })
        } else {
            json!({ "path": cwd })
        };
        Box::pin(async move { Ok(value) })
    }

    fn note_turn_cause(&self, connection_id: &str, pane_id: &str, cause: Value) {
        self.causes
            .lock()
            .unwrap()
            .push(json!([connection_id, pane_id, cause]));
    }
}

/// actions.test.ts's `createWorktree` mock: the shared flow as the fixture
/// fakes it.
pub fn default_worktree(
    fake: &Fake,
    id: &str,
    params: &Value,
    is_current: &IsCurrent,
    before_dispatch: &BeforeSend,
) -> AssistantResult<Value> {
    if !is_current() {
        return fail("retired");
    }
    before_dispatch()?;
    fake.with(id, |conn| {
        conn.mutations.push("worktree.flow".into());
        let label = params
            .get("label")
            .cloned()
            .unwrap_or_else(|| params["branch"].clone());
        let workspace =
            json!({ "workspace_id": "w2", "label": label, "cwd": "/ranger-actions-child" });
        conn.workspaces.push(workspace.clone());
        conn.worktrees.push(json!({
            "branch": params["branch"],
            "path": "/ranger-actions-child",
            "open_workspace_id": "w2",
        }));
        Ok(json!({
            "workspace": workspace,
            "setup_hook": { "status": if conn.setup.is_some() { "succeeded" } else { "skipped" } },
            "secret": "private-key",
        }))
    })
}

/// A promise the test resolves (`deferred()`).
pub struct Deferred<T: Clone + Send + Sync + 'static> {
    sender: Mutex<Option<oneshot::Sender<T>>>,
    receiver: Shared<BoxFuture<Option<T>>>,
}

impl<T: Clone + Send + Sync + 'static> Deferred<T> {
    pub fn new() -> Arc<Self> {
        let (sender, receiver) = oneshot::channel();
        let receiver: BoxFuture<Option<T>> = Box::pin(async move { receiver.await.ok() });
        Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            receiver: receiver.shared(),
        })
    }

    pub fn resolve(&self, value: T) {
        if let Some(sender) = self.sender.lock().unwrap().take() {
            let _ = sender.send(value);
        }
    }

    pub fn wait(&self) -> BoxFuture<T> {
        let receiver = self.receiver.clone();
        Box::pin(async move { receiver.await.expect("resolved") })
    }
}

/// Lets spawned work run until `done` holds (the tests' `await gate`).
pub async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..100_000 {
        if done() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the condition never held");
}

/// Lets every task run a while (`flushReads`).
pub async fn flush() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}
