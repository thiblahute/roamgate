//! `assistant/actions.ts`: the actions Ranger proposes. Preparing one reads
//! its target and freezes what the user confirms (the preview); executing
//! it, once, checks that nothing changed, dispatches the write through a
//! gate that refuses it the moment permission or the lease goes, and
//! verifies the result without ever sending it again.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_agents::js;
use roamgate_base::clock::SharedClock;
use roamgate_base::settings::Settings;
use roamgate_review::rendered_target::posix_normalize;
use serde_json::{Map, Value, json};

use super::live::{
    BeforeSend, ContextHost, IsCurrent, Lease, Stop, err, is, is_safe_integer, js_string, put,
    same, sha256_hex, truthy,
};
use super::ported::{
    assert_unix_host, checkout_path, validate_connection_id, win32_normalize,
    worktree_checkout_path,
};
use super::{ActionResult, Authorized, PreparedAction};
use crate::errors::{AssistantError, AssistantResult};
use crate::tools::BoxFuture;

const MASKED: &str =
    "Action preview is unavailable, outside the approved scope, or the target changed.";

type Execute = Arc<dyn Fn(Option<Authorized>) -> BoxFuture<ActionResult> + Send + Sync>;

/// `PreparedAssistantAction`: the preview the user confirms, and its one
/// execution (every call after the first gives the first's result).
#[derive(Clone)]
pub struct Prepared {
    /// `AssistantActionPreview`.
    pub preview: Value,
    execute: Execute,
}

impl Prepared {
    /// `execute(authorized?)`.
    pub fn execute(&self, authorized: Option<Authorized>) -> BoxFuture<ActionResult> {
        (self.execute)(authorized)
    }

    /// The same action, `guard` run around each execution (given the
    /// execution, not started).
    pub(crate) fn guarded(
        self,
        guard: impl Fn(BoxFuture<ActionResult>) -> BoxFuture<ActionResult> + Send + Sync + 'static,
    ) -> Self {
        let inner = self.execute;
        Self {
            preview: self.preview,
            execute: Arc::new(move |authorized| {
                let inner = inner.clone();
                guard(Box::pin(async move { inner(authorized).await }))
            }),
        }
    }

    pub fn into_action(self) -> PreparedAction {
        let execute = self.execute;
        PreparedAction {
            preview: self.preview,
            execute: Box::new(move |authorized| {
                let run = execute(authorized);
                Box::pin(async move { Ok(run.await) })
            }),
        }
    }
}

/// What `prepareAssistantAction` gets: only context's approved turn
/// leases reach it.
pub(crate) struct ActionRequest {
    pub kind: String,
    /// The approved `AssistantWorkspace`.
    pub target: Value,
    pub lease: Lease,
    pub params: Value,
    pub signal: Option<Stop>,
}

/// A pane and what runs in it, as `readAssistantPaneOccupant` reads them.
pub struct PaneOccupant {
    pub pane: Map<String, Value>,
    pub agent: Map<String, Value>,
    pub process: Map<String, Value>,
    /// Everything that must not change before a write to the pane.
    pub identity: String,
    /// The concrete agent session's identity, when it has one.
    pub agent_identity: Option<String>,
}

fn text(value: Option<&Value>, max: usize) -> AssistantResult<String> {
    let control =
        |c: char| matches!(c, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}');
    match value.and_then(Value::as_str) {
        Some(text)
            if !js::trim(text).is_empty()
                && js::len16(text) <= max
                && !text.chars().any(control) =>
        {
            Ok(text.to_owned())
        }
        _ => Err(err("Invalid action parameters")),
    }
}

fn absolute_path(value: Option<&Value>) -> AssistantResult<String> {
    let path = text(value, 2048)?;
    if path.contains(['\r', '\n', '\t']) {
        return Err(err("Invalid action directory"));
    }
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if drive || path.starts_with("\\\\") {
        return Ok(win32_normalize(&path));
    }
    if path.starts_with('/') {
        return Ok(posix_normalize(&path));
    }
    Err(err("Action directory must be absolute"))
}

fn list(value: Option<&Value>) -> AssistantResult<Vec<Map<String, Value>>> {
    match value.and_then(Value::as_array) {
        Some(items) if items.iter().all(Value::is_object) => Ok(items
            .iter()
            .filter_map(|item| item.as_object().cloned())
            .collect()),
        _ => Err(err("Action target is unavailable")),
    }
}

fn session_identity(value: Option<&Value>) -> AssistantResult<Option<Map<String, Value>>> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let kind = js_string(value.get("kind"));
    if !value.is_object()
        || !["id", "path"].contains(&kind.as_str())
        || !value.get("value").is_some_and(Value::is_string)
    {
        return Err(err("Cannot verify the target session"));
    }
    let mut session = Map::new();
    put(&mut session, "source", value.get("source"));
    put(&mut session, "agent", value.get("agent"));
    put(&mut session, "kind", value.get("kind"));
    put(&mut session, "value", value.get("value"));
    Ok(Some(session))
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `readAssistantPaneOccupant(call, workspaceId, paneId)`.
pub(crate) async fn read_pane_occupant<C, Fut>(
    call: C,
    workspace_id: &str,
    pane_id: &str,
) -> AssistantResult<PaneOccupant>
where
    C: Fn(&'static str, Value) -> Fut,
    Fut: Future<Output = AssistantResult<Value>>,
{
    let changed = || err("Action pane changed");
    let pane_result = call("pane.get", json!({ "pane_id": pane_id })).await?;
    let Some(pane) = pane_result.get("pane").and_then(Value::as_object).cloned() else {
        return Err(changed());
    };
    // agent.get lists detected agents only; an empty shell uses pane.get.
    let agent_result = if truthy(pane.get("agent")) {
        call("agent.get", json!({ "target": pane_id })).await?
    } else {
        json!({ "agent": pane })
    };
    let agent = agent_result
        .get("agent")
        .and_then(Value::as_object)
        .cloned();
    let process_result = call("pane.process_info", json!({ "pane_id": pane_id })).await?;
    let process = process_result
        .get("process_info")
        .and_then(Value::as_object)
        .cloned();
    let (Some(agent), Some(process)) = (agent, process) else {
        return Err(changed());
    };
    let terminal_id = pane.get("terminal_id");
    if !is(pane.get("pane_id"), pane_id)
        || !is(agent.get("pane_id"), pane_id)
        || !is(process.get("pane_id"), pane_id)
        || !is(pane.get("workspace_id"), workspace_id)
        || !is(agent.get("workspace_id"), workspace_id)
        || !terminal_id
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        || !same(agent.get("terminal_id"), terminal_id)
        || !same(
            Some(&or_null(pane.get("agent"))),
            Some(&or_null(agent.get("agent"))),
        )
    {
        return Err(changed());
    }
    let mut processes = Vec::new();
    let foreground = match process.get("foreground_processes") {
        None | Some(Value::Null) => json!([]),
        Some(value) => value.clone(),
    };
    for entry in list(Some(&foreground))? {
        let pid = entry.get("pid");
        if !is_safe_integer(pid) || pid.and_then(Value::as_f64).is_none_or(|pid| pid <= 0.0) {
            return Err(err("Cannot verify the target process"));
        }
        let mut item = Map::new();
        put(&mut item, "pid", pid);
        put(&mut item, "name", entry.get("name"));
        processes.push(item);
    }
    processes.sort_by(|left, right| {
        let pid = |item: &Map<String, Value>| item["pid"].as_f64().unwrap_or(0.0);
        pid(left).total_cmp(&pid(right))
    });
    let shell_pid = process.get("shell_pid");
    let shell = is_safe_integer(shell_pid)
        && shell_pid
            .and_then(Value::as_f64)
            .is_some_and(|pid| pid > 0.0);
    if !shell && processes.is_empty() {
        return Err(err("Cannot verify the target process"));
    }
    let session = session_identity(agent.get("agent_session"))?;
    let mut identity = Map::new();
    put(&mut identity, "terminal_id", terminal_id);
    put(&mut identity, "tab_id", pane.get("tab_id"));
    identity.insert("agent".into(), or_null(agent.get("agent")));
    identity.insert("name".into(), or_null(agent.get("name")));
    identity.insert(
        "session".into(),
        session.clone().map_or(Value::Null, Value::Object),
    );
    put(&mut identity, "shell_pid", shell_pid);
    put(
        &mut identity,
        "foreground_process_group_id",
        process.get("foreground_process_group_id"),
    );
    identity.insert(
        "processes".into(),
        Value::Array(processes.into_iter().map(Value::Object).collect()),
    );
    let identity = sha256_hex(&js::stringify(&Value::Object(identity)));
    let agent_identity = session
        .filter(|session| !js::trim(session["value"].as_str().unwrap_or("")).is_empty())
        .map(|session| {
            let mut value = Map::new();
            put(&mut value, "terminal_id", terminal_id);
            put(&mut value, "agent", agent.get("agent"));
            value.insert("session".into(), Value::Object(session));
            sha256_hex(&js::stringify(&Value::Object(value)))
        });
    Ok(PaneOccupant {
        pane,
        agent,
        process,
        identity,
        agent_identity,
    })
}

#[derive(Debug, Clone, PartialEq)]
struct LayoutItem {
    pane_id: String,
    tab_id: String,
    terminal_id: String,
}

#[derive(Debug, Clone, PartialEq)]
struct PaneRef {
    pane_id: String,
    tab_id: String,
    terminal_id: String,
    cwd: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Source {
    cwd: String,
    /// The pane the directory was read from, when the workspace has no
    /// checkout: `(pane_id, tab_id, terminal_id)`.
    pane: Option<(String, String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
struct HookState {
    command: Value,
    enabled: bool,
    directory: Option<String>,
    worktree_command: Option<String>,
}

/// What a dispatch failed with: never sent (the gate refused, or the
/// write failed before leaving), or failed once it may have left.
enum Dispatch {
    NotSent,
    Failed(AssistantError),
}

impl Dispatch {
    fn message(&self) -> &str {
        match self {
            Self::NotSent => "Action was not dispatched",
            Self::Failed(error) => error.message(),
        }
    }

    fn into_error(self) -> AssistantError {
        match self {
            Self::NotSent => err("Action was not dispatched"),
            Self::Failed(error) => error,
        }
    }
}

struct Session {
    host: Arc<dyn ContextHost>,
    clock: SharedClock,
    lease: Lease,
    target: Value,
    connection_id: String,
    workspace_id: String,
    signal: Option<Stop>,
    preparing: AtomicBool,
}

impl Session {
    fn check(&self) -> AssistantResult<()> {
        if self.preparing.load(Ordering::SeqCst)
            && let Some(signal) = &self.signal
        {
            signal.throw_if_aborted()?;
        }
        if !self.host.is_current(&self.lease) {
            return Err(err("Action connection changed"));
        }
        Ok(())
    }

    async fn read<T, Fut>(&self, operation: impl FnOnce() -> Fut) -> AssistantResult<T>
    where
        Fut: Future<Output = AssistantResult<T>>,
    {
        self.check()?;
        let operation = operation();
        let signal = if self.preparing.load(Ordering::SeqCst) {
            self.signal.clone()
        } else {
            None
        };
        let result = match signal {
            Some(signal) => tokio::select! {
                result = operation => result,
                _ = signal.stopped() => Err(err("Action stopped")),
            },
            None => operation.await,
        }?;
        self.check()?;
        Ok(result)
    }

    async fn call(&self, method: &str, query: Value) -> AssistantResult<Value> {
        self.read(|| self.host.herdr_call(&self.lease, method, query, 5000, None))
            .await
    }

    async fn workspace(&self, workspace_id: Option<&str>) -> AssistantResult<Value> {
        let workspace_id = workspace_id.unwrap_or(&self.workspace_id);
        let result = self
            .call("workspace.get", json!({ "workspace_id": workspace_id }))
            .await?;
        match result.get("workspace") {
            Some(workspace)
                if workspace.is_object() && is(workspace.get("workspace_id"), workspace_id) =>
            {
                Ok(workspace.clone())
            }
            _ => Err(err("Action workspace changed")),
        }
    }

    async fn workspaces(&self) -> AssistantResult<Vec<Map<String, Value>>> {
        list(
            self.call("workspace.list", json!({}))
                .await?
                .get("workspaces"),
        )
    }

    async fn worktrees(&self) -> AssistantResult<Vec<Map<String, Value>>> {
        let query = json!({ "workspace_id": self.workspace_id });
        list(self.call("worktree.list", query).await?.get("worktrees"))
    }

    async fn panes(&self) -> AssistantResult<Vec<Map<String, Value>>> {
        let query = json!({ "workspace_id": self.workspace_id });
        Ok(list(self.call("pane.list", query).await?.get("panes"))?
            .into_iter()
            .filter(|pane| is(pane.get("workspace_id"), &self.workspace_id))
            .collect())
    }

    async fn tabs(&self) -> AssistantResult<Vec<Map<String, Value>>> {
        let query = json!({ "workspace_id": self.workspace_id });
        Ok(list(self.call("tab.list", query).await?.get("tabs"))?
            .into_iter()
            .filter(|tab| is(tab.get("workspace_id"), &self.workspace_id))
            .collect())
    }

    async fn pane(&self, pane_id: &str) -> AssistantResult<PaneRef> {
        let result = self.call("pane.get", json!({ "pane_id": pane_id })).await?;
        let item = result.get("pane");
        let Some(item) = item.filter(|item| {
            item.is_object()
                && is(item.get("pane_id"), pane_id)
                && is(item.get("workspace_id"), &self.workspace_id)
        }) else {
            return Err(err("Source pane changed"));
        };
        Ok(PaneRef {
            pane_id: validate_connection_id(item.get("pane_id"))?,
            tab_id: validate_connection_id(item.get("tab_id"))?,
            terminal_id: validate_connection_id(item.get("terminal_id"))?,
            cwd: absolute_path(item.get("cwd"))?,
        })
    }

    async fn source_directory(&self, current: &Value) -> AssistantResult<Source> {
        let path = checkout_path(current);
        if !path.is_empty() {
            return Ok(Source {
                cwd: absolute_path(Some(&json!(path)))?,
                pane: None,
            });
        }
        let query = json!({ "workspace_id": self.workspace_id });
        let panes: Vec<_> = list(self.call("pane.list", query).await?.get("panes"))?
            .into_iter()
            .filter(|pane| is(pane.get("workspace_id"), &self.workspace_id))
            .collect();
        let pane = panes
            .iter()
            .find(|pane| truthy(pane.get("focused")))
            .or_else(|| panes.first());
        let Some(pane) = pane.filter(|pane| {
            pane.get("terminal_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        }) else {
            return Err(err("Cannot verify the source directory"));
        };
        Ok(Source {
            cwd: absolute_path(pane.get("cwd"))?,
            pane: Some((
                validate_connection_id(pane.get("pane_id"))?,
                validate_connection_id(pane.get("tab_id"))?,
                validate_connection_id(pane.get("terminal_id"))?,
            )),
        })
    }

    async fn occupant(&self, pane_id: &str) -> AssistantResult<PaneOccupant> {
        read_pane_occupant(
            |method, params| self.call(method, params),
            &self.workspace_id,
            pane_id,
        )
        .await
    }

    async fn hook_state(&self, current: &Value, root: &str) -> AssistantResult<HookState> {
        let mut source = current.as_object().cloned().unwrap_or_default();
        let cwd = Some(checkout_path(current))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| root.to_owned());
        source.insert("cwd".into(), json!(cwd));
        let hooks = self
            .read(|| self.host.read_worktree_hooks(&self.lease, &cwd))
            .await?;
        let command = if hooks.is_null() {
            Value::Null
        } else {
            let Some(config) = hooks.get("config").filter(|config| !config.is_null()) else {
                return Err(err("Invalid worktree hooks"));
            };
            config.get("setup").cloned().unwrap_or(Value::Null)
        };
        if !command.is_null()
            && command
                .as_str()
                .is_none_or(|command| js::len16(command) > 20_000)
        {
            return Err(err("Cannot preview this setup hook"));
        }
        // The repository key worktree creation will use, so that its guards
        // compare against the settings creation applies.
        let raw = self.read(|| self.host.read_gui_settings()).await?;
        let resolved = self
            .read(|| {
                self.host.resolve_repo_settings_key(
                    &self.lease,
                    json!({ "workspace": source, "root": root, "settings": raw }),
                )
            })
            .await?;
        let key = resolved.get("key").and_then(Value::as_str);
        let settings = Settings::normalize(&raw);
        // The repository's worktree location decides the new checkout's
        // path, and the configured command, if any, creates it instead of Herdr.
        Ok(HookState {
            command,
            enabled: settings.repo_worktree_hooks_enabled(key),
            directory: settings.repo_worktree_directory(key),
            worktree_command: settings.worktree_command_for(key),
        })
    }

    /// The workspace's panes, frozen: removing a last pane also removes its
    /// tab or workspace, and an added pane must never become part of an
    /// already approved close.
    async fn close_layout(
        &self,
        frozen_workspace: &str,
        workspace_label: Option<&Value>,
        before_dispatch: bool,
    ) -> AssistantResult<Vec<LayoutItem>> {
        let mut layout = self
            .panes()
            .await?
            .iter()
            .map(|item| {
                Ok(LayoutItem {
                    pane_id: validate_connection_id(item.get("pane_id"))?,
                    tab_id: validate_connection_id(item.get("tab_id"))?,
                    terminal_id: validate_connection_id(item.get("terminal_id"))?,
                })
            })
            .collect::<AssistantResult<Vec<_>>>()?;
        layout.sort_by(|left, right| js::locale_compare(&left.pane_id, &right.pane_id));
        let distinct = |key: fn(&LayoutItem) -> &str| {
            let mut seen: Vec<&str> = layout.iter().map(key).collect();
            seen.sort_unstable();
            seen.dedup();
            seen.len() == layout.len()
        };
        if layout.is_empty()
            || !distinct(|item| &item.pane_id)
            || !distinct(|item| &item.terminal_id)
        {
            return Err(err("Cannot verify the workspace panes"));
        }
        let live = self.workspace(None).await?;
        let pane_count_differs = live
            .get("pane_count")
            .is_some_and(|count| count.as_f64() != Some(layout.len() as f64));
        if workspace_identity(&live) != frozen_workspace
            || (before_dispatch && !same(live.get("label"), workspace_label))
            || pane_count_differs
        {
            return Err(err("Workspace panes changed"));
        }
        Ok(layout)
    }
}

/// The parts of a workspace an action relies on.
fn workspace_identity(item: &Value) -> String {
    let worktree = item.get("worktree").filter(|worktree| worktree.is_object());
    let mut identity = Map::new();
    put(&mut identity, "cwd", item.get("cwd"));
    identity.insert(
        "worktree".into(),
        worktree.map_or(Value::Null, |worktree| {
            let mut fields = Map::new();
            for key in [
                "repo_key",
                "repo_root",
                "checkout_path",
                "is_linked_worktree",
            ] {
                put(&mut fields, key, worktree.get(key));
            }
            Value::Object(fields)
        }),
    );
    js::stringify(&Value::Object(identity))
}

fn outcome(status: &str, detail: &str) -> Value {
    json!({ "status": status, "detail": detail })
}

fn created_outcome(status: &str, created: &Value, detail: &str) -> Value {
    json!({ "status": status, "created": created, "detail": detail })
}

/// What each kind of action does once confirmed, with what it froze.
enum Plan {
    CreateWorkspace {
        label: String,
        cwd: String,
        source: Option<Source>,
    },
    Close {
        workspace_label: Option<Value>,
        layout: Vec<LayoutItem>,
        pane_id: Option<String>,
        frozen: Vec<(String, String)>,
        closes_workspace: bool,
    },
    CreateWorktree {
        branch: String,
        label: Option<String>,
        root: String,
        hooks: HookState,
        path: Option<String>,
    },
    CreateTab {
        source: Source,
    },
    SplitPane {
        pane_id: String,
        direction: String,
        source: PaneRef,
    },
    StartAgent {
        pane_id: String,
        agent: String,
        name: String,
        identity: String,
        terminal_id: Value,
    },
    SendPrompt {
        pane_id: String,
        prompt: String,
        identity: String,
        terminal_id: Value,
        state_change_seq: Option<Value>,
        agent_status: Value,
    },
}

/// The write of an execution: refused without sending once permission or
/// the lease is gone, and known to have started once the host called its
/// gate.
struct Dispatcher {
    session: Arc<Session>,
    is_current: IsCurrent,
    dispatched: Arc<AtomicBool>,
}

impl Dispatcher {
    async fn dispatch<F, Fut>(&self, operation: F) -> Result<Value, Dispatch>
    where
        F: FnOnce(BeforeSend) -> Fut,
        Fut: Future<Output = AssistantResult<Value>>,
    {
        if !(self.is_current)() {
            return Err(Dispatch::NotSent);
        }
        let (is_current, dispatched) = (self.is_current.clone(), self.dispatched.clone());
        let before_send: BeforeSend = Arc::new(move || {
            if !is_current() {
                return Err(err("Action authorization expired before dispatch"));
            }
            dispatched.store(true, Ordering::SeqCst);
            Ok(())
        });
        match self.session.read(|| operation(before_send)).await {
            Ok(value) => Ok(value),
            Err(_) if !self.dispatched.load(Ordering::SeqCst) => Err(Dispatch::NotSent),
            Err(error) => Err(Dispatch::Failed(error)),
        }
    }
}

/// `prepareAssistantAction(args)`.
pub(crate) async fn prepare_assistant_action(
    host: Arc<dyn ContextHost>,
    clock: SharedClock,
    request: ActionRequest,
) -> AssistantResult<Prepared> {
    let ActionRequest {
        kind,
        target,
        lease,
        params,
        signal,
    } = request;
    let keys: &[&str] = match kind.as_str() {
        "create_workspace" => &["connection_id", "workspace_id", "label", "cwd"],
        "create_worktree" => &["connection_id", "workspace_id", "branch", "label"],
        "create_tab" => &["connection_id", "workspace_id"],
        "split_pane" => &["connection_id", "workspace_id", "pane_id", "direction"],
        "start_agent" => &["connection_id", "workspace_id", "pane_id", "agent"],
        "send_prompt" => &["connection_id", "workspace_id", "pane_id", "prompt"],
        "close_workspace" => &["connection_id", "workspace_id"],
        "close_pane" | "close_agent" => &["connection_id", "workspace_id", "pane_id"],
        _ => &[],
    };
    let Some(given) = params
        .as_object()
        .filter(|params| !keys.is_empty() && params.keys().all(|key| keys.contains(&key.as_str())))
    else {
        return Err(err("Unsupported action parameters"));
    };
    // A copy of the allowlisted strings before the first await.
    let mut snapshot = Map::new();
    for (key, value) in given {
        let max = match key.as_str() {
            "prompt" => 20_000,
            "cwd" => 2048,
            _ => 200,
        };
        snapshot.insert(key.clone(), json!(text(Some(value), max)?));
    }
    let params = snapshot;
    let connection_id = target["connection_id"].as_str().unwrap_or("").to_owned();
    let workspace_id = target["workspace_id"].as_str().unwrap_or("").to_owned();
    if !is(params.get("connection_id"), &connection_id)
        || !is(params.get("workspace_id"), &workspace_id)
    {
        return Err(err("Action is outside the approved workspace scope"));
    }
    let session = Arc::new(Session {
        host,
        clock,
        lease,
        target,
        connection_id,
        workspace_id,
        signal,
        preparing: AtomicBool::new(true),
    });
    prepare(session, kind, params)
        .await
        .map_err(|error| error.surface(MASKED))
}

async fn prepare(
    session: Arc<Session>,
    kind: String,
    params: Map<String, Value>,
) -> AssistantResult<Prepared> {
    let s = &session;
    let current = s.workspace(None).await?;
    let frozen_workspace = workspace_identity(&current);
    let preview_params: Map<String, Value>;
    let summary: String;
    let plan: Plan;
    match kind.as_str() {
        "create_workspace" => {
            let label = text(params.get("label"), 200)?;
            if label.contains(['\r', '\n', '\t']) {
                return Err(err("Invalid workspace label"));
            }
            let source = if params.get("cwd").is_none() {
                Some(s.source_directory(&current).await?)
            } else {
                None
            };
            let cwd = match &source {
                Some(source) => source.cwd.clone(),
                None => absolute_path(params.get("cwd"))?,
            };
            preview_params = json_map(json!({ "label": label, "cwd": cwd }));
            summary = "Create a workspace on this connection using the displayed directory. It will not change focus.".into();
            plan = Plan::CreateWorkspace { label, cwd, source };
        }
        "close_workspace" | "close_pane" | "close_agent" => {
            let workspace_label = current.get("label").cloned();
            let layout = s
                .close_layout(&frozen_workspace, workspace_label.as_ref(), true)
                .await?;
            let pane_id = if kind == "close_workspace" {
                None
            } else {
                Some(validate_connection_id(params.get("pane_id"))?)
            };
            if let Some(pane) = &pane_id
                && !layout.iter().any(|item| item.pane_id == *pane)
            {
                return Err(err("Pane is outside the workspace"));
            }
            let affected: Vec<LayoutItem> = layout
                .iter()
                .filter(|item| pane_id.as_ref().is_none_or(|pane| item.pane_id == *pane))
                .cloned()
                .collect();
            let mut frozen = Vec::new();
            let mut described = Vec::new();
            let mut first_agent = None;
            for item in &affected {
                let occupant = s.occupant(&item.pane_id).await?;
                if !is(occupant.pane.get("tab_id"), &item.tab_id)
                    || !is(occupant.pane.get("terminal_id"), &item.terminal_id)
                    || (kind == "close_agent" && !truthy(occupant.agent.get("agent")))
                {
                    return Err(err("Close target changed"));
                }
                let agent = occupant
                    .agent
                    .get("agent")
                    .filter(|agent| !agent.is_null())
                    .map_or_else(|| "shell".to_owned(), js::to_text);
                described.push(format!(
                    "{} ({agent}; terminal {})",
                    item.pane_id,
                    js_string(occupant.pane.get("terminal_id"))
                ));
                if first_agent.is_none() {
                    first_agent = Some(occupant.agent.get("agent").cloned());
                }
                frozen.push((item.pane_id.clone(), occupant.identity));
            }
            if s.close_layout(&frozen_workspace, workspace_label.as_ref(), true)
                .await?
                != layout
            {
                return Err(err("Workspace panes changed"));
            }
            let closes_workspace = kind == "close_workspace" || layout.len() == 1;
            if !closes_workspace
                && current.get("worktree").is_some_and(Value::is_object)
                && !js::is_true(current["worktree"].get("is_linked_worktree"))
            {
                // Herdr has no atomic no-group option on pane.close. Another
                // pane disappearing after our reads could make this close the
                // entire group.
                return Err(err("Safe pane close is unavailable in a worktree root"));
            }
            preview_params = match &pane_id {
                Some(pane) => {
                    let mut map = Map::new();
                    map.insert("pane_id".into(), json!(pane));
                    map.insert("terminal_id".into(), json!(affected[0].terminal_id));
                    let agent = first_agent.flatten();
                    if truthy(agent.as_ref()) {
                        map.insert("agent".into(), json!(text(agent.as_ref(), 200)?));
                    }
                    map.insert(
                        "closes_workspace".into(),
                        json!(closes_workspace.to_string()),
                    );
                    map
                }
                None => json_map(json!({
                    "pane_count": layout.len().to_string(),
                    "panes": text(Some(&json!(described.join("\n"))), 20_000)?,
                })),
            };
            summary = if kind == "close_workspace" {
                "Close this workspace and terminate the displayed panes and their running processes. Unsaved terminal work may be lost. Worktree files and saved agent history will not be deleted. Linked workspaces will not be closed.".into()
            } else {
                format!(
                    "Close this exact {}pane and terminate its running processes. Unsaved terminal work may be lost.{} Worktree files and saved agent history will not be deleted.",
                    if kind == "close_agent" {
                        "agent's "
                    } else {
                        ""
                    },
                    if closes_workspace {
                        " This is the last pane, so its workspace will also close."
                    } else {
                        " Its tab will also close if this is the tab's last pane."
                    }
                )
            };
            plan = Plan::Close {
                workspace_label,
                layout,
                pane_id,
                frozen,
                closes_workspace,
            };
        }
        "create_worktree" => {
            // Git root and hook helpers are Unix-only, unlike native Herdr RPCs.
            assert_unix_host(
                s.lease.remote_platform.as_deref(),
                "Ranger worktree creation",
            )?;
            if !s.host.can_create_worktree() {
                return Err(err("Worktree creation is unavailable"));
            }
            let branch = text(params.get("branch"), 200)?;
            if invalid_branch(&branch) {
                return Err(err("Invalid worktree branch"));
            }
            let label = match params.get("label") {
                None => None,
                Some(label) => Some(text(Some(label), 200)?),
            };
            let resolved = s
                .read(|| {
                    s.host.resolve_workspace_git_root(
                        &s.lease,
                        json!({ "workspace_id": s.workspace_id }),
                    )
                })
                .await?;
            let root = absolute_path(resolved.get("root"))?;
            let hooks = s.hook_state(&current, &root).await?;
            let path = match &hooks.directory {
                Some(directory) => Some(worktree_checkout_path(directory, &branch)?),
                None => None,
            };
            let mut map = Map::new();
            map.insert("branch".into(), json!(branch));
            if let Some(label) = &label {
                map.insert("label".into(), json!(label));
            }
            map.insert("cwd".into(), json!(root));
            map.insert(
                "path".into(),
                json!(
                    path.clone()
                        .unwrap_or_else(|| "(Herdr's default worktree location)".into())
                ),
            );
            map.insert(
                "base".into(),
                json!("Latest origin default branch (fetched at confirmation)"),
            );
            map.insert(
                "setup_hook".into(),
                match &hooks.command {
                    Value::Null => json!("(none configured)"),
                    command => command.clone(),
                },
            );
            map.insert(
                "setup_hook_enabled".into(),
                json!(hooks.enabled.to_string()),
            );
            map.insert(
                "worktree_command".into(),
                json!(
                    hooks
                        .worktree_command
                        .clone()
                        .unwrap_or_else(|| "(none configured: Herdr creates it)".into())
                ),
            );
            preview_params = map;
            summary = "Fetch origin's default branch, create its worktree (with the displayed worktree command if one is configured and installed on the host, otherwise with Herdr), save the source relationship, and run the displayed setup hook if enabled. Focus will stay unchanged.".into();
            plan = Plan::CreateWorktree {
                branch,
                label,
                root,
                hooks,
                path,
            };
        }
        "create_tab" => {
            let source = s.source_directory(&current).await?;
            let mut map = Map::new();
            map.insert("cwd".into(), json!(source.cwd));
            if let Some((pane_id, tab_id, terminal_id)) = &source.pane {
                map.insert("pane_id".into(), json!(pane_id));
                map.insert("tab_id".into(), json!(tab_id));
                map.insert("terminal_id".into(), json!(terminal_id));
            }
            preview_params = map;
            summary = "Create a tab with a new shell pane in this workspace using the displayed directory. Focus will stay unchanged.".into();
            plan = Plan::CreateTab { source };
        }
        "split_pane" => {
            let pane_id = validate_connection_id(params.get("pane_id"))?;
            let direction = params
                .get("direction")
                .and_then(Value::as_str)
                .filter(|direction| *direction == "right" || *direction == "down")
                .ok_or_else(|| err("Invalid split direction"))?
                .to_owned();
            let source = s.pane(&pane_id).await?;
            preview_params = json_map(json!({
                "pane_id": source.pane_id,
                "tab_id": source.tab_id,
                "terminal_id": source.terminal_id,
                "cwd": source.cwd,
                "direction": direction,
            }));
            summary = "Split this exact pane in the displayed direction, creating a new shell in the same tab and directory. Focus will stay unchanged.".into();
            plan = Plan::SplitPane {
                pane_id,
                direction,
                source,
            };
        }
        _ => {
            let pane_id = validate_connection_id(params.get("pane_id"))?;
            let frozen = s.occupant(&pane_id).await?;
            let terminal_id = frozen
                .pane
                .get("terminal_id")
                .cloned()
                .unwrap_or(Value::Null);
            let running = frozen.agent.get("agent");
            if kind == "start_agent" {
                let agent = validate_connection_id(params.get("agent"))?;
                let manifests = list(
                    s.call("server.agent_manifests", json!({}))
                        .await?
                        .get("manifests"),
                )?;
                if !manifests.iter().any(|entry| is(entry.get("agent"), &agent)) {
                    return Err(err("Unknown agent"));
                }
                if truthy(running) && !is(running, &agent) {
                    return Err(err("Pane already has another agent"));
                }
                let group = frozen.process.get("foreground_process_group_id");
                if !truthy(running)
                    && truthy(group)
                    && !same(group, frozen.process.get("shell_pid"))
                {
                    return Err(err("Pane has a foreground process"));
                }
                let name = format!(
                    "ranger-{}",
                    &sha256_hex(&format!("{pane_id}\0{agent}"))[..20]
                );
                preview_params = json_map(json!({
                    "pane_id": pane_id,
                    "terminal_id": js_string(Some(&terminal_id)),
                    "agent": agent,
                    "name": name,
                }));
                summary = "Start the selected coding agent in this exact pane. No custom command or arguments will be added.".into();
                plan = Plan::StartAgent {
                    pane_id,
                    agent,
                    name,
                    identity: frozen.identity,
                    terminal_id,
                };
            } else {
                let prompt = text(params.get("prompt"), 20_000)?;
                if !truthy(running) {
                    return Err(err("Pane has no coding agent"));
                }
                preview_params = json_map(json!({
                    "pane_id": pane_id,
                    "terminal_id": js_string(Some(&terminal_id)),
                    "agent": js_string(running),
                    "prompt": prompt,
                }));
                summary = "Send the exact displayed prompt to this coding agent. It may trigger work or change files. Delivery will not be automatically retried.".into();
                plan = Plan::SendPrompt {
                    pane_id,
                    prompt,
                    identity: frozen.identity,
                    terminal_id,
                    state_change_seq: frozen.agent.get("state_change_seq").cloned(),
                    agent_status: frozen
                        .agent
                        .get("agent_status")
                        .cloned()
                        .unwrap_or(Value::Null),
                };
            }
        }
    }
    s.check()?;
    let preview = json!({
        "kind": kind,
        "connection_id": s.connection_id,
        "workspace_id": s.workspace_id,
        "runtime_generation": s.lease.generation,
        "connection_label": s.target.get("connection_label").cloned().unwrap_or(Value::Null),
        "workspace_label": s.target.get("label").cloned().unwrap_or(Value::Null),
        "params": preview_params,
        "summary": summary,
    });
    // Pi may abort tool signals when disposing its session. Confirmation has its own admission.
    s.preparing.store(false, Ordering::SeqCst);
    let plan = Arc::new(plan);
    let execution: Arc<Mutex<Option<Shared<BoxFuture<ActionResult>>>>> = Arc::new(Mutex::new(None));
    let session = session.clone();
    Ok(Prepared {
        preview,
        execute: Arc::new(move |authorized| {
            // The service persists admission before calling this one-shot closure.
            let run = execution
                .lock()
                .unwrap()
                .get_or_insert_with(|| {
                    let run: BoxFuture<ActionResult> = Box::pin(execute(
                        session.clone(),
                        plan.clone(),
                        frozen_workspace.clone(),
                        authorized,
                    ));
                    run.shared()
                })
                .clone();
            Box::pin(run)
        }),
    })
}

fn json_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The branch names worktree creation refuses.
fn invalid_branch(branch: &str) -> bool {
    use std::sync::LazyLock;
    static INVALID: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[./-]|[\s~^:?*\[\\]|\.\.|@\{|/$|\.$|\.lock(?:/|$)").unwrap()
    });
    INVALID.is_match(branch) || branch == "@"
}

async fn execute(
    session: Arc<Session>,
    plan: Arc<Plan>,
    frozen_workspace: String,
    authorized: Option<Authorized>,
) -> ActionResult {
    let dispatched = Arc::new(AtomicBool::new(false));
    let result: AssistantResult<Value> = async {
        session.check()?;
        if workspace_identity(&session.workspace(None).await?) != frozen_workspace {
            return Err(err("Source workspace changed"));
        }
        let is_current: IsCurrent = {
            let (host, lease, authorized) = (
                session.host.clone(),
                session.lease.clone(),
                authorized.clone(),
            );
            Arc::new(move || host.is_current(&lease) && authorized.as_ref().is_none_or(|a| a()))
        };
        let dispatcher = Dispatcher {
            session: session.clone(),
            is_current,
            dispatched: dispatched.clone(),
        };
        let result = perform(&session, &plan, &frozen_workspace, &dispatcher).await?;
        session.check()?;
        Ok(result)
    }
    .await;
    match result {
        Ok(result) => result,
        Err(_) if dispatched.load(Ordering::SeqCst) => outcome(
            "uncertain",
            "The operation started, but its final state could not be verified. Inspect the target before retrying.",
        ),
        Err(_) if authorized.as_ref().is_some_and(|a| !a()) => outcome(
            "failed",
            "Automatic approval was disabled before dispatch. Nothing was sent.",
        ),
        Err(_) => outcome(
            "failed",
            "The target changed or the operation is unavailable. Nothing was sent; prepare a new preview.",
        ),
    }
}

async fn perform(
    s: &Arc<Session>,
    plan: &Plan,
    frozen_workspace: &str,
    dispatcher: &Dispatcher,
) -> AssistantResult<Value> {
    let host = s.host.clone();
    let lease = s.lease.clone();
    let herdr = |method: &'static str, query: Value, timeout: u64| {
        let (host, lease) = (host.clone(), lease.clone());
        move |before_send: BeforeSend| async move {
            host.herdr_call(&lease, method, query, timeout, Some(before_send))
                .await
        }
    };
    match plan {
        Plan::CreateWorkspace { label, cwd, source } => {
            if let Some(Source {
                pane: Some((pane_id, _, terminal_id)),
                ..
            }) = source
            {
                let result = s.call("pane.get", json!({ "pane_id": pane_id })).await?;
                let pane = result.get("pane");
                let unchanged = match pane.filter(|pane| pane.is_object()) {
                    Some(pane) => {
                        is(pane.get("workspace_id"), &s.workspace_id)
                            && is(pane.get("terminal_id"), terminal_id)
                            && absolute_path(pane.get("cwd"))? == *cwd
                    }
                    None => false,
                };
                if !unchanged {
                    return Err(err("Source pane or directory changed"));
                }
            }
            let before = s.workspaces().await?;
            if before.iter().any(|item| is(item.get("label"), label)) {
                return Ok(outcome(
                    "failed",
                    "A workspace with this label already exists. No duplicate was created.",
                ));
            }
            let directory = s
                .read(|| s.host.inspect_workspace_path(&s.lease, cwd))
                .await?;
            if truthy(directory.get("error")) {
                return Ok(outcome(
                    "failed",
                    &format!(
                        "{} Nothing was sent; prepare a new preview.",
                        js_string(directory.get("error"))
                    ),
                ));
            }
            let previous: Vec<Value> = before
                .iter()
                .filter_map(|item| item.get("workspace_id").cloned())
                .collect();
            let response = match dispatcher
                .dispatch(herdr(
                    "workspace.create",
                    json!({
                        "label": label,
                        "cwd": cwd,
                        "source_workspace_id": s.workspace_id,
                        "focus": false,
                    }),
                    30_000,
                ))
                .await
            {
                Ok(response) => Some(response),
                Err(Dispatch::NotSent) => return Err(Dispatch::NotSent.into_error()),
                // A lost reply may still have created the workspace. Verify before any retry.
                Err(Dispatch::Failed(_)) => None,
            };
            let returned = response
                .as_ref()
                .and_then(|response| response.get("workspace"))
                .filter(|workspace| workspace.is_object())
                .and_then(|workspace| workspace.get("workspace_id"));
            let found: Vec<_> = s
                .workspaces()
                .await?
                .into_iter()
                .filter(|item| {
                    let id = item.get("workspace_id");
                    is(item.get("label"), label)
                        && !previous.iter().any(|old| same(Some(old), id))
                        && returned.is_none_or(|returned| same(id, Some(returned)))
                })
                .collect();
            if found.len() != 1 {
                return Ok(outcome(
                    "uncertain",
                    "Workspace creation was sent, but the result could not be verified. Inspect this connection before retrying.",
                ));
            }
            let id = validate_connection_id(found[0].get("workspace_id"))?;
            s.workspace(Some(&id)).await?;
            let _ = s
                .host
                .workspace_created(json!({
                    "connectionId": s.connection_id,
                    "workspaceId": id,
                    "sourceWorkspaceId": s.workspace_id,
                }))
                .await;
            let panes = list(
                s.call("pane.list", json!({ "workspace_id": id }))
                    .await?
                    .get("panes"),
            )?;
            let mut verified = false;
            for pane in &panes {
                if is(pane.get("workspace_id"), &id)
                    && pane.get("cwd").is_some_and(Value::is_string)
                    && absolute_path(pane.get("cwd"))? == *cwd
                {
                    verified = true;
                    break;
                }
            }
            if !verified {
                return Ok(outcome(
                    "uncertain",
                    "A new workspace was observed, but its directory could not be verified. Inspect it before retrying.",
                ));
            }
            Ok(json!({
                "status": "succeeded",
                "detail": "The new workspace and its directory were verified.",
                "created": { "connection_id": s.connection_id, "workspace_id": id },
            }))
        }
        Plan::Close {
            workspace_label,
            layout,
            pane_id,
            frozen,
            closes_workspace,
        } => {
            for (pane, identity) in frozen {
                if s.occupant(pane).await?.identity != *identity {
                    return Err(err("Pane occupant changed"));
                }
            }
            if s.close_layout(frozen_workspace, workspace_label.as_ref(), true)
                .await?
                != *layout
            {
                return Err(err("Workspace panes changed"));
            }
            // pane.close can implicitly close a worktree group when native
            // close confirmation is disabled. workspace.close always requires
            // explicit close_group intent, so use it for last-pane closes
            // without that flag.
            let (method, query) = if *closes_workspace {
                ("workspace.close", json!({ "workspace_id": s.workspace_id }))
            } else {
                (
                    "pane.close",
                    json!({ "pane_id": pane_id.clone().unwrap_or_default() }),
                )
            };
            match dispatcher.dispatch(herdr(method, query, 30_000)).await {
                Ok(_) => {}
                Err(Dispatch::NotSent) => return Err(Dispatch::NotSent.into_error()),
                Err(failure) => {
                    let message = failure.message();
                    if message.starts_with("workspace_group_close_required:")
                        || message.starts_with("confirmation_required:")
                    {
                        return Ok(outcome(
                            "failed",
                            "Herdr refused the close because it would require closing a worktree group. No group close was requested. Inspect the workspace before preparing another action.",
                        ));
                    }
                    // A lost reply can follow a successful close. Read back once, never retry.
                }
            }
            let remaining = s.workspaces().await?;
            let ids = remaining
                .iter()
                .map(|item| validate_connection_id(item.get("workspace_id")))
                .collect::<AssistantResult<Vec<_>>>()?;
            let mut distinct = ids.clone();
            distinct.sort_unstable();
            distinct.dedup();
            if distinct.len() != ids.len() {
                return Err(err("Cannot verify remaining workspaces"));
            }
            let workspace_remains = remaining
                .iter()
                .any(|item| is(item.get("workspace_id"), &s.workspace_id));
            // Herdr can derive the workspace label from its first tab's root
            // pane. Closing that pane legitimately changes the label, so
            // readback checks the stable workspace identity and layout rather
            // than its old label.
            let remaining_panes = if !closes_workspace && workspace_remains {
                s.close_layout(frozen_workspace, workspace_label.as_ref(), false)
                    .await?
            } else {
                Vec::new()
            };
            let closed = if *closes_workspace {
                !workspace_remains
            } else {
                workspace_remains
                    && !remaining_panes
                        .iter()
                        .any(|item| Some(&item.pane_id) == pane_id.as_ref())
            };
            Ok(if closed {
                outcome(
                    "succeeded",
                    if *closes_workspace {
                        "The workspace is no longer open. No worktree removal or agent-history deletion was requested."
                    } else {
                        "The pane is no longer open in the original workspace. No worktree removal or agent-history deletion was requested."
                    },
                )
            } else {
                outcome(
                    "uncertain",
                    "The close was sent, but the expected final state could not be verified. Inspect the target before retrying; the close will not be sent again automatically.",
                )
            })
        }
        Plan::CreateWorktree {
            branch,
            label,
            root,
            hooks,
            path,
        } => {
            let actual = s
                .read(|| {
                    s.host.resolve_workspace_git_root(
                        &s.lease,
                        json!({ "workspace_id": s.workspace_id }),
                    )
                })
                .await?;
            if absolute_path(actual.get("root"))? != *root
                || s.hook_state(&s.workspace(None).await?, root).await? != *hooks
            {
                return Err(err(
                    "Worktree source, setup hook, location or command changed",
                ));
            }
            if s.worktrees()
                .await?
                .iter()
                .any(|item| is(item.get("branch"), branch))
            {
                return Ok(outcome(
                    "failed",
                    "A worktree for this branch already exists. No duplicate was created; inspect the existing checkout.",
                ));
            }
            let mut params = Map::new();
            params.insert("workspace_id".into(), json!(s.workspace_id));
            params.insert("branch".into(), json!(branch));
            if let Some(label) = label {
                params.insert("label".into(), json!(label));
            }
            // The previewed path, not one recomputed at dispatch.
            if let Some(path) = path {
                params.insert("path".into(), json!(path));
            }
            params.insert("focus".into(), json!(false));
            params.insert("expected_setup_hook".into(), hooks.command.clone());
            params.insert("expected_hooks_enabled".into(), json!(hooks.enabled));
            params.insert("expected_source_root".into(), json!(root));
            params.insert(
                "expected_worktree_command".into(),
                json!(hooks.worktree_command),
            );
            let (host, lease, is_current) = (
                s.host.clone(),
                s.lease.clone(),
                dispatcher.is_current.clone(),
            );
            let response = dispatcher
                .dispatch(move |before_dispatch| async move {
                    host.create_worktree(&lease, Value::Object(params), is_current, before_dispatch)
                        .await
                })
                .await
                .map_err(Dispatch::into_error)?;
            let Some(created) = response
                .get("workspace")
                .filter(|workspace| workspace.is_object())
                .and_then(|workspace| workspace.get("workspace_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return Err(err("Worktree result unavailable"));
            };
            s.workspace(Some(&validate_connection_id(Some(&json!(created)))?))
                .await?;
            if !s.worktrees().await?.iter().any(|item| {
                is(item.get("branch"), branch) && is(item.get("open_workspace_id"), &created)
            }) {
                return Err(err("Worktree result unavailable"));
            }
            let created = json!({ "connection_id": s.connection_id, "workspace_id": created });
            if js::is_true(response.get("parent_tracking_failed")) {
                return Ok(created_outcome(
                    "failed",
                    &created,
                    "The worktree was created, but its source relationship could not be saved. Inspect it before retrying.",
                ));
            }
            let hook = response.get("setup_hook").filter(|hook| hook.is_object());
            let reason = hook.and_then(|hook| hook.get("reason"));
            if is(reason, "setup_hook_changed") || is(reason, "hooks_enabled_changed") {
                return Ok(created_outcome(
                    "failed",
                    &created,
                    "The worktree was created, but setup was skipped because its configuration changed. Inspect it before retrying.",
                ));
            }
            if is(hook.and_then(|hook| hook.get("status")), "failed") {
                return Ok(created_outcome(
                    "failed",
                    &created,
                    "The worktree was created, but its setup hook failed. Inspect it before retrying.",
                ));
            }
            Ok(created_outcome(
                "succeeded",
                &created,
                "The worktree and its workspace were verified. The configured creation flow completed.",
            ))
        }
        Plan::CreateTab { source } => {
            let cwd = &source.cwd;
            let previous_ids: Vec<Value> = s
                .tabs()
                .await?
                .iter()
                .map(|tab| tab.get("tab_id").cloned().unwrap_or(Value::Null))
                .collect();
            let previous_panes = s.panes().await?;
            let mut changed = workspace_identity(&s.workspace(None).await?) != frozen_workspace;
            if !changed && let Some((pane_id, tab_id, terminal_id)) = &source.pane {
                changed = s.pane(pane_id).await?
                    != (PaneRef {
                        pane_id: pane_id.clone(),
                        tab_id: tab_id.clone(),
                        terminal_id: terminal_id.clone(),
                        cwd: cwd.clone(),
                    });
            }
            if changed {
                return Err(err("Source directory changed"));
            }
            let response = dispatcher
                .dispatch(herdr(
                    "tab.create",
                    json!({ "workspace_id": s.workspace_id, "cwd": cwd, "focus": false }),
                    30_000,
                ))
                .await
                .map_err(Dispatch::into_error)?;
            let tab = response.get("tab").filter(|tab| tab.is_object());
            let root_pane = response.get("root_pane").filter(|pane| pane.is_object());
            let (true, Some(tab), Some(root_pane)) =
                (is(response.get("type"), "tab_created"), tab, root_pane)
            else {
                return Err(err("Tab creation result unavailable"));
            };
            let tab_id = validate_connection_id(tab.get("tab_id"))?;
            let pane_id = validate_connection_id(root_pane.get("pane_id"))?;
            let created = s.pane(&pane_id).await?;
            let unverified = previous_ids.iter().any(|id| is(Some(id), &tab_id))
                || !is(tab.get("workspace_id"), &s.workspace_id)
                || !is(root_pane.get("workspace_id"), &s.workspace_id)
                || !is(root_pane.get("tab_id"), &tab_id)
                || created.tab_id != tab_id
                || !is(root_pane.get("terminal_id"), &created.terminal_id)
                || created.cwd != *cwd
                || previous_panes.iter().any(|item| {
                    is(item.get("pane_id"), &pane_id)
                        || is(item.get("terminal_id"), &created.terminal_id)
                });
            if unverified
                || !s
                    .tabs()
                    .await?
                    .iter()
                    .any(|tab| is(tab.get("tab_id"), &tab_id))
            {
                return Err(err("Tab creation target could not be verified"));
            }
            Ok(outcome(
                "succeeded",
                &format!(
                    "Created tab {tab_id} with pane {pane_id} in the authorized workspace. Its directory was verified."
                ),
            ))
        }
        Plan::SplitPane {
            pane_id,
            direction,
            source,
        } => {
            let previous = s.panes().await?;
            if s.pane(pane_id).await? != *source {
                return Err(err("Source pane or directory changed"));
            }
            let response = dispatcher
                .dispatch(herdr(
                    "pane.split",
                    json!({
                        "target_pane_id": pane_id,
                        "direction": direction,
                        "cwd": source.cwd,
                        "focus": false,
                    }),
                    30_000,
                ))
                .await
                .map_err(Dispatch::into_error)?;
            let pane = response.get("pane").filter(|pane| pane.is_object());
            let (true, Some(pane)) = (is(response.get("type"), "pane_info"), pane) else {
                return Err(err("Pane split result unavailable"));
            };
            let created_id = validate_connection_id(pane.get("pane_id"))?;
            let created = s.pane(&created_id).await?;
            let unverified = !is(pane.get("workspace_id"), &s.workspace_id)
                || !is(pane.get("tab_id"), &source.tab_id)
                || created.tab_id != source.tab_id
                || !is(pane.get("terminal_id"), &created.terminal_id)
                || created.cwd != source.cwd
                || previous.iter().any(|item| {
                    is(item.get("pane_id"), &created_id)
                        || is(item.get("terminal_id"), &created.terminal_id)
                });
            if unverified || s.pane(pane_id).await? != *source {
                return Err(err("Pane split target could not be verified"));
            }
            Ok(outcome(
                "succeeded",
                &format!(
                    "Created pane {created_id} in tab {}. Its source pane and directory were verified.",
                    source.tab_id
                ),
            ))
        }
        Plan::StartAgent {
            pane_id,
            agent,
            name,
            identity,
            terminal_id,
        } => {
            let before = s.occupant(pane_id).await?;
            if before.identity != *identity {
                return Err(err("Pane occupant changed"));
            }
            if is(before.agent.get("agent"), agent) {
                return Ok(outcome(
                    "succeeded",
                    "This coding agent is already running in the verified pane. No second agent was started.",
                ));
            }
            let deadline = s.clock.now() + 60_000;
            let response = match dispatcher
                .dispatch(herdr(
                    "agent.start",
                    json!({
                        "pane_id": pane_id,
                        "kind": agent,
                        "name": name,
                        "timeout_ms": 60_000,
                    }),
                    65_000,
                ))
                .await
            {
                Ok(response) => Some(response),
                Err(Dispatch::NotSent) => return Err(Dispatch::NotSent.into_error()),
                // Inspect the pane after a lost startup reply; never launch twice.
                Err(Dispatch::Failed(_)) => None,
            };
            if let Some(response) = &response {
                let started = response.get("agent").filter(|agent| agent.is_object());
                if !started.is_some_and(|started| {
                    is(started.get("pane_id"), pane_id)
                        && same(started.get("terminal_id"), Some(terminal_id))
                }) {
                    return Ok(outcome(
                        "uncertain",
                        "Agent startup returned an unexpected target. Inspect this pane before retrying.",
                    ));
                }
            }
            // Raw agent.start is asynchronous. Match the native CLI's
            // readiness wait, using agent.get rather than pane/list snapshots
            // or state-only agent.wait.
            loop {
                let result = s.call("pane.get", json!({ "pane_id": pane_id })).await?;
                let pane = result.get("pane");
                if !pane.is_some_and(|pane| {
                    pane.is_object()
                        && is(pane.get("pane_id"), pane_id)
                        && is(pane.get("workspace_id"), &s.workspace_id)
                        && same(pane.get("terminal_id"), Some(terminal_id))
                }) {
                    return Err(err("Agent startup target changed"));
                }
                let live = match s.call("agent.get", json!({ "target": pane_id })).await {
                    Ok(result) => result.get("agent").cloned(),
                    // Detection may lag the launch; only a missing agent is retryable.
                    Err(error) if error.message().starts_with("agent_not_found:") => None,
                    Err(error) => return Err(error),
                };
                if let Some(live) = live {
                    let reported = live.get("agent").filter(|agent| !agent.is_null());
                    if !live.is_object()
                        || !is(live.get("pane_id"), pane_id)
                        || !is(live.get("workspace_id"), &s.workspace_id)
                        || !same(live.get("terminal_id"), Some(terminal_id))
                        || reported.is_some_and(|reported| !is(Some(reported), agent))
                        || !is(live.get("name"), name)
                    {
                        return Err(err("Agent startup identity changed"));
                    }
                    let status = js_string(live.get("agent_status"));
                    if status == "blocked" {
                        return Ok(outcome(
                            "failed",
                            "Agent startup was attempted, but the agent is blocked before becoming interactive. It may still be running; inspect this pane before retrying.",
                        ));
                    }
                    let settled = status == "idle" || status == "done";
                    if is(live.get("agent"), agent)
                        && js::is_true(live.get("interactive_ready"))
                        && (settled || (agent == "codex" && status == "unknown"))
                    {
                        return Ok(outcome(
                            "succeeded",
                            "The selected coding agent was verified as interactive in the original terminal.",
                        ));
                    }
                    if settled && !js::is_true(live.get("launch_pending")) {
                        return Ok(outcome(
                            "failed",
                            "Agent startup was attempted, but Herdr reports that startup ended before the agent became interactive. Inspect this pane before retrying.",
                        ));
                    }
                }
                let remaining = deadline - s.clock.now();
                if remaining <= 0 {
                    return Ok(outcome(
                        "uncertain",
                        "Agent startup was sent, but interactive readiness was not verified before the timeout. It may still be running; inspect this pane before retrying.",
                    ));
                }
                let wait = std::time::Duration::from_millis(remaining.min(100) as u64);
                s.read(|| async {
                    s.clock.sleep(wait).await;
                    Ok(())
                })
                .await?;
            }
        }
        Plan::SendPrompt {
            pane_id,
            prompt,
            identity,
            terminal_id,
            state_change_seq,
            agent_status,
        } => {
            if s.occupant(pane_id).await?.identity != *identity {
                return Err(err("Pane occupant changed"));
            }
            s.host
                .note_turn_cause(&s.connection_id, pane_id, json!({ "by": "ranger" }));
            let (host, lease, pane, text) = (
                s.host.clone(),
                s.lease.clone(),
                pane_id.clone(),
                prompt.clone(),
            );
            let result = match dispatcher
                .dispatch(move |before_send| async move {
                    // Conversation mode holds the pane: a message, not keystrokes.
                    if host
                        .conversation_prompt(&lease, &pane, &text, before_send.clone())
                        .await?
                    {
                        return Ok(json!({ "sent": true }));
                    }
                    host.herdr_call(
                        &lease,
                        "agent.prompt",
                        json!({ "target": pane, "text": text }),
                        5000,
                        Some(before_send),
                    )
                    .await
                })
                .await
            {
                Ok(result) => result,
                // The public API rejects blocked agents before submitting any input.
                Err(failure) if failure.message().starts_with("agent_blocked:") => {
                    return Ok(outcome(
                        "failed",
                        "Herdr rejected the prompt because the agent is blocked. No prompt was submitted.",
                    ));
                }
                Err(failure) => return Err(failure.into_error()),
            };
            let reached = result
                .get("agent")
                .filter(|agent| agent.is_object())
                .is_some_and(|agent| is(agent.get("pane_id"), pane_id));
            if !reached || s.occupant(pane_id).await?.identity != *identity {
                return Ok(outcome(
                    "uncertain",
                    "Prompt submission was sent, but its target or delivery could not be verified. Inspect this pane; do not resend automatically.",
                ));
            }
            if is_safe_integer(state_change_seq.as_ref()) {
                let status = if agent_status.is_null() {
                    String::new()
                } else {
                    js::to_text(agent_status)
                };
                s.host.agent_prompted(json!({
                    "connectionId": s.connection_id,
                    "paneId": pane_id,
                    "terminalId": js_string(Some(terminal_id)),
                    "seq": state_change_seq,
                    "status": status,
                }));
            }
            Ok(outcome(
                "uncertain",
                "Herdr accepted the prompt. Delivery and the agent's response have not been independently verified. Do not resend automatically.",
            ))
        }
    }
}

#[cfg(test)]
mod tests;
