//! One Claude per review workspace, one Claude session per request
//! (`mr-reviews/claude.ts`): the workspace's first pane runs `claude` on
//! the session of the request the worktree is on. Switching request
//! resumes that request's session once the checkout is done; a Claude in
//! the middle of a turn is never stopped: the user waits for it or leaves
//! it on its request. A Claude the user started there by hand (a session
//! that is no request's) is never touched. Only the user's clicks start or
//! switch it; it reviews only when asked.
//!
//! Agent profiles are not ported to Rust yet: the session's profile
//! command ([`AgentCommand`], `commandForSession` of profiles.ts) comes
//! through an injected function, a reverse call to Bun in the core.

use std::future::Future;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::random_uuid;
use serde_json::{Value, json};

use crate::connection::{BoxFuture, LaunchSpec, MrConnection, SwitchResult};
use crate::rpc::{RpcError, RpcResult};
use crate::shared::types::project_key;
use crate::store::MrStore;

/// The claude start setting (`claude_start_mode`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StartMode {
    /// The claude start hook leaves it in the terminal.
    #[default]
    Terminal,
    /// Conversation mode's hook takes it, as any claude started by hand.
    Conversation,
}

impl StartMode {
    /// The setting's text; anything but `conversation` is the terminal.
    pub fn parse(text: &str) -> StartMode {
        if text == "conversation" {
            StartMode::Conversation
        } else {
            StartMode::Terminal
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            StartMode::Terminal => "terminal",
            StartMode::Conversation => "conversation",
        }
    }
}

/// A profile ready to start an agent with (`AgentCommand` of profiles.ts):
/// its program, the environment it sets and what it removes. `plain` is
/// the built-in Claude unchanged: started exactly as before profiles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCommand {
    pub profile: String,
    pub agent: String,
    pub program: String,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    pub plain: bool,
    pub model: Option<String>,
}

impl AgentCommand {
    /// `PLAIN_CLAUDE`.
    pub fn plain_claude() -> AgentCommand {
        AgentCommand {
            profile: "Claude".into(),
            agent: "claude".into(),
            program: "claude".into(),
            env: vec![],
            unset: vec![],
            plain: true,
            model: None,
        }
    }

    /// The command as Bun answers it (a JSON `AgentCommand`).
    pub fn from_json(value: &Value) -> Option<AgentCommand> {
        let text = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        Some(AgentCommand {
            profile: text("profile")?,
            agent: text("agent")?,
            program: text("program")?,
            env: value
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
            unset: value
                .get("unset")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|n| n.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
            plain: value.get("plain").and_then(Value::as_bool).unwrap_or(false),
            model: text("model"),
        })
    }
}

static SESSION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f-]{36}$").expect("pattern"));
static COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_./-]+$").expect("pattern"));

/// The test stand-in for `claude` (`ROAMGATE_MR_CLAUDE_COMMAND`), when set.
pub fn test_claude_command() -> Option<String> {
    std::env::var("ROAMGATE_MR_CLAUDE_COMMAND")
        .ok()
        .filter(|value| !value.is_empty())
}

/// The claude command typed into the pane's shell, kept in the terminal
/// (`claudeCommand`). `bin` None: the test stand-in, else `claude`.
pub fn claude_command(
    session: &str,
    resume: bool,
    mode: StartMode,
    bin: Option<&str>,
) -> Result<String, String> {
    let bin = bin
        .map(str::to_owned)
        .or_else(test_claude_command)
        .unwrap_or_else(|| "claude".into());
    if !SESSION_ID.is_match(session) {
        return Err("invalid session id".into());
    }
    if !COMMAND.is_match(&bin) {
        return Err("invalid claude command".into());
    }
    // A session never written to has nothing to resume: start it by its id.
    let run = if resume {
        format!("sh -c '{bin} --resume {session} || {bin} --session-id {session}'")
    } else {
        format!("{bin} --session-id {session}")
    };
    // env, not VAR=value (old fish); the leading space keeps it out of the
    // history. In terminal mode the claude start hook leaves it there; in
    // conversation mode the hook takes it, as any claude started by hand.
    Ok(match mode {
        StartMode::Terminal => format!(" env ROAMGATE_CLAUDE_START=terminal {run}\r"),
        StartMode::Conversation => format!(" {run}\r"),
    })
}

/// The session's profile when it is not plain claude (`profileLaunch`):
/// started through the pane's roamgate-hold, which fetches its environment
/// (never typed). A test's stand-in command keeps the typed one. `command`
/// is only asked when the connection can launch.
pub async fn profile_launch<F, Fut>(
    conn: &dyn MrConnection,
    pane_id: &str,
    session: &str,
    resume: bool,
    mode: StartMode,
    command: F,
) -> Result<Option<String>, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<AgentCommand, String>>,
{
    if test_claude_command().is_some() || !conn.can_launch() {
        return Ok(None);
    }
    let profile = command().await?;
    if profile.plain {
        return Ok(None);
    }
    let spec = LaunchSpec {
        argv: vec![
            profile.program,
            if resume { "--resume" } else { "--session-id" }.into(),
            session.into(),
        ],
        env: profile.env,
        unset: profile.unset,
        agent: profile.agent,
        terminal: mode == StartMode::Terminal,
    };
    conn.launch(pane_id, spec).await.map(Some)
}

/// What runs in a request's review workspace (`MrClaudeState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MrClaudeState {
    /// Claude runs this request's session and waits for a prompt.
    Ready { pane_id: String, session: String },
    /// Started or resumed; not ready yet (a trust question, its start).
    Starting { pane_id: String, session: String },
    /// Claude is busy with another request's turn.
    Busy {
        pane_id: String,
        with: Option<String>,
    },
    /// A Claude that is no request's runs in the pane: left alone.
    Foreign { pane_id: String },
    /// No Claude for this request (it has none yet, or it was left).
    None { pane_id: Option<String> },
}

impl MrClaudeState {
    pub fn state(&self) -> &'static str {
        match self {
            MrClaudeState::Ready { .. } => "ready",
            MrClaudeState::Starting { .. } => "starting",
            MrClaudeState::Busy { .. } => "busy",
            MrClaudeState::Foreign { .. } => "foreign",
            MrClaudeState::None { .. } => "none",
        }
    }

    /// As Bun answers it.
    pub fn to_json(&self) -> Value {
        match self {
            MrClaudeState::Ready { pane_id, session }
            | MrClaudeState::Starting { pane_id, session } => {
                json!({"state": self.state(), "paneId": pane_id, "session": session})
            }
            MrClaudeState::Busy { pane_id, with } => {
                json!({"state": "busy", "paneId": pane_id, "with": with})
            }
            MrClaudeState::Foreign { pane_id } => json!({"state": "foreign", "paneId": pane_id}),
            MrClaudeState::None { pane_id } => json!({"state": "none", "paneId": pane_id}),
        }
    }
}

/// The ready connections.
pub type ConnectionsFn = Arc<dyn Fn() -> Vec<Arc<dyn MrConnection>> + Send + Sync>;
/// A request of the inbox by its key (`inbox.item`).
pub type ItemFn = Arc<dyn Fn(&str) -> Option<Obj> + Send + Sync>;
/// The claude start setting (`claude_start_mode`).
pub type StartModeFn = Arc<dyn Fn() -> BoxFuture<'static, StartMode> + Send + Sync>;
/// A session's profile command (`commandForSession`, Bun's until profiles
/// are Rust's).
pub type AgentCommandFn =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<AgentCommand, String>> + Send + Sync>;
/// The review pane's "review with the agent": `{sessionId, paneId, focus?}`.
pub type RequestReviewFn = Arc<dyn Fn(Obj) -> BoxFuture<'static, RpcResult<()>> + Send + Sync>;

/// What [`MrClaude`] needs (`createMrClaude`'s deps).
#[derive(Clone)]
pub struct MrClaudeDeps {
    pub item: ItemFn,
    pub store: Arc<Mutex<MrStore>>,
    pub connections: ConnectionsFn,
    pub request_review: RequestReviewFn,
    pub start_mode: Option<StartModeFn>,
    pub agent_command: Option<AgentCommandFn>,
    /// How long a start or an exit is waited for.
    pub wait_ms: u64,
    pub poll_ms: u64,
}

impl MrClaudeDeps {
    pub fn new(
        item: ItemFn,
        store: Arc<Mutex<MrStore>>,
        connections: ConnectionsFn,
        request_review: RequestReviewFn,
    ) -> MrClaudeDeps {
        MrClaudeDeps {
            item,
            store,
            connections,
            request_review,
            start_mode: None,
            agent_command: None,
            wait_ms: 20_000,
            poll_ms: 500,
        }
    }
}

pub(crate) fn lock_store(store: &Mutex<MrStore>) -> std::sync::MutexGuard<'_, MrStore> {
    store.lock().unwrap_or_else(|e| e.into_inner())
}

/// Changes the state and writes it; a failed write is the call's failure.
pub(crate) fn update_store(store: &Mutex<MrStore>, change: impl FnOnce(&mut Obj)) -> RpcResult<()> {
    lock_store(store)
        .update(change)
        .map_err(|error| RpcError::Failed(error.to_string()))
}

/// A record of the state (`state[name][key]`), cloned.
pub(crate) fn record_of(store: &Mutex<MrStore>, name: &str, key: &str) -> Option<Obj> {
    js::rec(lock_store(store).get().get(name))
        .and_then(|records| js::rec(records.get(key)))
        .cloned()
}

/// `state[name][key]` as a mutable record, when there.
pub(crate) fn record_mut<'a>(state: &'a mut Obj, name: &str, key: &str) -> Option<&'a mut Obj> {
    state
        .get_mut(name)
        .and_then(Value::as_object_mut)
        .and_then(|records| records.get_mut(key))
        .and_then(Value::as_object_mut)
}

/// `mrProjectKey` of a request.
pub fn mr_project_key(item: &Obj) -> String {
    project_key(js::sv(item.get("host")), js::sv(item.get("project")))
}

/// The panes of a `pane.list` answer.
pub(crate) fn panes_of(listed: &Value) -> Vec<Value> {
    listed
        .get("panes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The workspaces of a `workspace.list` answer.
pub(crate) fn workspaces_of(listed: &Value) -> Vec<Value> {
    listed
        .get("workspaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// A Herdr call, its failure the call's.
pub(crate) async fn herdr(
    conn: &dyn MrConnection,
    method: &str,
    params: Value,
) -> RpcResult<Value> {
    conn.herdr(method, params).await.map_err(RpcError::Failed)
}

#[derive(Clone, Debug)]
struct PaneAgent {
    name: Option<String>,
    status: String,
    session: Option<String>,
}

fn busy(status: &str) -> bool {
    status == "working" || status == "blocked"
}

static NOT_FOUND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)not.?found").expect("pattern"));
static CLAUDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)claude").expect("pattern"));

/// `String(value ?? "unknown")` of an agent's status.
pub(crate) fn agent_status(agent: &Value) -> String {
    let status = match agent.get("agent_status") {
        Some(Value::Null) | None => agent.get("status"),
        found => found,
    };
    match status {
        Some(Value::Null) | None => "unknown".into(),
        Some(value) => js::to_text(value),
    }
}

/// The agent's name, `claude` for any Claude.
pub(crate) fn agent_name(agent: &Value) -> Option<String> {
    let name = agent.get("agent").and_then(Value::as_str)?;
    Some(if CLAUDE.is_match(name) {
        "claude".into()
    } else {
        name.into()
    })
}

/// The review workspace's Claude (`createMrClaude`): a cheap clone.
#[derive(Clone)]
pub struct MrClaude(Arc<MrClaudeDeps>);

struct Project {
    conn: Arc<dyn MrConnection>,
    record: Obj,
    project_key: String,
}

impl MrClaude {
    pub fn new(deps: MrClaudeDeps) -> MrClaude {
        MrClaude(Arc::new(deps))
    }

    fn project(&self, key: &str) -> RpcResult<Project> {
        let Some(item) = (self.0.item)(key) else {
            return Err(RpcError::with_code(
                "no such request in the inbox",
                "not_found",
            ));
        };
        let project_key = mr_project_key(&item);
        let record = record_of(&self.0.store, "projects", &project_key)
            .filter(|record| js::non_empty(record.get("workspaceId")).is_some())
            .ok_or_else(|| RpcError::invalid("open the request's review first"))?;
        let connection = js::sv(record.get("connectionId")).to_owned();
        let conn = (self.0.connections)()
            .into_iter()
            .find(|conn| conn.id() == connection)
            .ok_or_else(|| {
                RpcError::with_code("the review's connection is not ready", "unavailable")
            })?;
        Ok(Project {
            conn,
            record,
            project_key,
        })
    }

    /// The workspace's Claude pane: the one used before, else its first.
    async fn pane_of(&self, project: &Project) -> RpcResult<Option<String>> {
        let listed = herdr(&*project.conn, "pane.list", json!({})).await?;
        let workspace = project.record.get("workspaceId");
        let panes: Vec<Value> = panes_of(&listed)
            .into_iter()
            .filter(|pane| pane.get("workspace_id") == workspace)
            .collect();
        let used = project.record.get("claudePane");
        let pane = panes
            .iter()
            .find(|pane| pane.get("pane_id") == used && used.is_some())
            .or(panes.first());
        let Some(pane_id) = pane
            .and_then(|pane| pane.get("pane_id"))
            .filter(|id| crate::inbox::truthy(Some(id)))
        else {
            return Ok(None);
        };
        let pane_id = js::to_text(pane_id);
        if Some(&Value::String(pane_id.clone())) != used {
            let key = project.project_key.clone();
            let id = pane_id.clone();
            update_store(&self.0.store, |state| {
                if let Some(entry) = record_mut(state, "projects", &key) {
                    entry.insert("claudePane".into(), Value::String(id));
                }
            })?;
        }
        Ok(Some(pane_id))
    }

    async fn agent_of(
        &self,
        conn: &dyn MrConnection,
        pane_id: &str,
        started: Option<&str>,
    ) -> RpcResult<PaneAgent> {
        let agent = match conn.herdr("agent.get", json!({"target": pane_id})).await {
            Ok(result) => result.get("agent").cloned().unwrap_or(Value::Null),
            Err(error) if NOT_FOUND.is_match(&error) => Value::Null,
            Err(error) => return Err(RpcError::Failed(error)),
        };
        let name = agent
            .get("agent")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let is_claude = name.as_deref().is_some_and(|name| CLAUDE.is_match(name));
        let told = agent
            .get("agent_session")
            .and_then(|session| session.get("value"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(PaneAgent {
            name: if is_claude {
                Some("claude".into())
            } else {
                name
            },
            status: agent_status(&agent),
            session: told.or_else(|| {
                if is_claude {
                    started.map(str::to_owned)
                } else {
                    None
                }
            }),
        })
    }

    /// The request whose Claude session this is, if any.
    fn request_of(&self, session: Option<&str>) -> Option<String> {
        let session = session?;
        let store = lock_store(&self.0.store);
        js::rec(store.get().get("reviews"))?
            .iter()
            .find(|(_, review)| {
                review.get("claudeSession").and_then(Value::as_str) == Some(session)
            })
            .map(|(key, _)| key.clone())
    }

    fn claude_session(&self, key: &str) -> Option<String> {
        record_of(&self.0.store, "reviews", key)
            .and_then(|review| js::non_empty(review.get("claudeSession")).map(str::to_owned))
    }

    fn claude_started(&self, project_key: &str) -> Option<String> {
        record_of(&self.0.store, "projects", project_key)
            .and_then(|record| js::non_empty(record.get("claudeStarted")).map(str::to_owned))
    }

    async fn sleep(&self) {
        tokio::time::sleep(Duration::from_millis(self.0.poll_ms)).await;
    }

    async fn wait_for(
        &self,
        conn: &dyn MrConnection,
        pane_id: &str,
        done: impl Fn(&PaneAgent) -> bool,
        started: Option<&str>,
    ) -> RpcResult<PaneAgent> {
        let mut agent = self.agent_of(conn, pane_id, started).await?;
        let mut waited = 0;
        while waited < self.0.wait_ms && !done(&agent) {
            self.sleep().await;
            agent = self.agent_of(conn, pane_id, started).await?;
            waited += self.0.poll_ms;
        }
        Ok(agent)
    }

    fn set_started(&self, project_key: &str, session: &str) -> RpcResult<()> {
        let session = session.to_owned();
        update_store(&self.0.store, |state| {
            if let Some(entry) = record_mut(state, "projects", project_key) {
                entry.insert("claudeStarted".into(), Value::String(session));
            }
        })
    }

    fn set_session(&self, key: &str, session: &str) -> RpcResult<()> {
        let session = session.to_owned();
        update_store(&self.0.store, |state| {
            if let Some(review) = record_mut(state, "reviews", key) {
                review.insert("claudeSession".into(), Value::String(session));
            }
        })
    }

    fn has_review(&self, key: &str) -> bool {
        record_of(&self.0.store, "reviews", key).is_some()
    }

    /// Puts this request's Claude in the pane. `start`: a request without
    /// a session gets a new one; else only an existing session is resumed.
    pub async fn ensure(&self, key: &str, start: bool, wait: bool) -> RpcResult<MrClaudeState> {
        let project = self.project(key)?;
        let Some(pane_id) = self.pane_of(&project).await? else {
            return Ok(MrClaudeState::None { pane_id: None });
        };
        let conn = &*project.conn;
        let mut session = self.claude_session(key);
        // Conversation mode holds the pane: its own switch, never /exit.
        if let Some(held) = conn.conversation_owned(&pane_id).await {
            if session.as_deref() == Some(held.as_str()) {
                return Ok(MrClaudeState::Ready {
                    pane_id,
                    session: held,
                });
            }
            let Some(other) = self.request_of(Some(&held)) else {
                return Ok(MrClaudeState::Foreign { pane_id });
            };
            if session.is_none() && !start {
                return Ok(MrClaudeState::None {
                    pane_id: Some(pane_id),
                });
            }
            let next = match &session {
                Some(session) => session.clone(),
                None => {
                    if !self.has_review(key) {
                        return Err(RpcError::invalid("open the request's review first"));
                    }
                    let next = random_uuid();
                    self.set_session(key, &next)?;
                    next
                }
            };
            let mut switched = conn.conversation_switch(&pane_id, &next).await;
            let mut waited = 0;
            while wait
                && matches!(switched, SwitchResult::Refused { busy: true, .. })
                && waited < self.0.wait_ms
            {
                self.sleep().await;
                switched = conn.conversation_switch(&pane_id, &next).await;
                waited += self.0.poll_ms;
            }
            return match switched {
                SwitchResult::Ok => {
                    self.set_started(&project.project_key, &next)?;
                    Ok(MrClaudeState::Ready {
                        pane_id,
                        session: next,
                    })
                }
                SwitchResult::Refused { busy: true, .. } => Ok(MrClaudeState::Busy {
                    pane_id,
                    with: Some(other),
                }),
                SwitchResult::Refused { reason, .. } => Err(RpcError::with_code(reason, "busy")),
            };
        }
        let started = self.claude_started(&project.project_key);
        let mut agent = self.agent_of(conn, &pane_id, started.as_deref()).await?;
        if agent.name.as_deref() == Some("claude") {
            if let Some(session) = &session
                && agent.session.as_deref() == Some(session.as_str())
            {
                let session = session.clone();
                return Ok(if agent.status == "unknown" {
                    MrClaudeState::Starting { pane_id, session }
                } else {
                    MrClaudeState::Ready { pane_id, session }
                });
            }
            let Some(other) = self.request_of(agent.session.as_deref()) else {
                return Ok(MrClaudeState::Foreign { pane_id });
            };
            if busy(&agent.status) {
                if !wait {
                    return Ok(MrClaudeState::Busy {
                        pane_id,
                        with: Some(other),
                    });
                }
                agent = self
                    .wait_for(
                        conn,
                        &pane_id,
                        |each| !busy(&each.status),
                        started.as_deref(),
                    )
                    .await?;
                if busy(&agent.status) {
                    return Ok(MrClaudeState::Busy {
                        pane_id,
                        with: Some(other),
                    });
                }
            }
            if session.is_none() && !start {
                // Nothing to resume: the other request's Claude stays.
                return Ok(MrClaudeState::None {
                    pane_id: Some(pane_id),
                });
            }
            herdr(
                conn,
                "pane.send_text",
                json!({"pane_id": pane_id, "text": "/exit\r"}),
            )
            .await?;
            agent = self
                .wait_for(
                    conn,
                    &pane_id,
                    |each| each.name.as_deref() != Some("claude"),
                    None,
                )
                .await?;
            if agent.name.as_deref() == Some("claude") {
                return Err(RpcError::with_code(
                    "Claude did not exit in the review workspace",
                    "busy",
                ));
            }
        } else if agent.name.is_some() {
            // Another agent runs there: the user's.
            return Ok(MrClaudeState::Foreign { pane_id });
        }
        if session.is_none() && !start {
            return Ok(MrClaudeState::None {
                pane_id: Some(pane_id),
            });
        }
        let resume = session.is_some();
        let session = match session.take() {
            Some(session) => session,
            None => {
                let next = random_uuid();
                self.set_session(key, &next)?;
                if !self.has_review(key) {
                    return Err(RpcError::invalid("open the request's review first"));
                }
                next
            }
        };
        self.set_started(&project.project_key, &session)?;
        let mode = match &self.0.start_mode {
            Some(mode) => mode().await,
            None => StartMode::Terminal,
        };
        let text = match self.launch(conn, &pane_id, &session, resume, mode).await? {
            Some(text) => text,
            None => claude_command(&session, resume, mode, None).map_err(RpcError::Failed)?,
        };
        herdr(
            conn,
            "pane.send_text",
            json!({"pane_id": pane_id, "text": text}),
        )
        .await?;
        let ready = |each: &PaneAgent| {
            each.name.as_deref() == Some("claude")
                && (each.status == "idle" || each.status == "done")
        };
        let up = self.wait_for(conn, &pane_id, ready, Some(&session)).await?;
        Ok(if ready(&up) {
            MrClaudeState::Ready { pane_id, session }
        } else {
            MrClaudeState::Starting { pane_id, session }
        })
    }

    async fn launch(
        &self,
        conn: &dyn MrConnection,
        pane_id: &str,
        session: &str,
        resume: bool,
        mode: StartMode,
    ) -> RpcResult<Option<String>> {
        let command = self.0.agent_command.clone();
        let session_id = session.to_owned();
        profile_launch(conn, pane_id, session, resume, mode, move || async move {
            match command {
                Some(command) => command(session_id).await,
                None => Ok(AgentCommand::plain_claude()),
            }
        })
        .await
        .map_err(RpcError::Failed)
    }

    /// What runs in the request's review workspace, without changing it.
    pub async fn status(&self, key: &str) -> RpcResult<MrClaudeState> {
        let project = self.project(key)?;
        let Some(pane_id) = self.pane_of(&project).await? else {
            return Ok(MrClaudeState::None { pane_id: None });
        };
        let conn = &*project.conn;
        let session = self.claude_session(key);
        if let Some(held) = conn.conversation_owned(&pane_id).await {
            if session.as_deref() == Some(held.as_str()) {
                return Ok(MrClaudeState::Ready {
                    pane_id,
                    session: held,
                });
            }
            return Ok(if self.request_of(Some(&held)).is_some() {
                MrClaudeState::None {
                    pane_id: Some(pane_id),
                }
            } else {
                MrClaudeState::Foreign { pane_id }
            });
        }
        let started = self.claude_started(&project.project_key);
        let agent = self.agent_of(conn, &pane_id, started.as_deref()).await?;
        if agent.name.as_deref() != Some("claude") {
            return Ok(if agent.name.is_some() {
                MrClaudeState::Foreign { pane_id }
            } else {
                MrClaudeState::None {
                    pane_id: Some(pane_id),
                }
            });
        }
        if let Some(session) = session
            && agent.session.as_deref() == Some(session.as_str())
        {
            return Ok(MrClaudeState::Ready { pane_id, session });
        }
        let Some(other) = self.request_of(agent.session.as_deref()) else {
            return Ok(MrClaudeState::Foreign { pane_id });
        };
        Ok(if busy(&agent.status) {
            MrClaudeState::Busy {
                pane_id,
                with: Some(other),
            }
        } else {
            MrClaudeState::None {
                pane_id: Some(pane_id),
            }
        })
    }

    /// "Review with Claude": its Claude, then the review pane's own review
    /// request, so its threads land in Roamgate's review of the request.
    pub async fn review(&self, key: &str, focus: Option<&str>) -> RpcResult<MrClaudeState> {
        let state = self.ensure(key, true, false).await?;
        let MrClaudeState::Ready { pane_id, .. } = &state else {
            return Ok(state);
        };
        let Some(review) = record_of(&self.0.store, "reviews", key) else {
            return Err(RpcError::invalid("open the request's review first"));
        };
        let mut params = Obj::new();
        params.insert(
            "sessionId".into(),
            review.get("sessionId").cloned().unwrap_or(Value::Null),
        );
        params.insert("paneId".into(), Value::String(pane_id.clone()));
        if let Some(focus) = focus.filter(|focus| !focus.is_empty()) {
            params.insert("focus".into(), Value::String(focus.to_owned()));
        }
        (self.0.request_review)(params).await?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0b1c2d3e-0000-4000-8000-000000000001";

    #[test]
    fn the_command_stays_in_the_terminal_and_resumes_or_starts() {
        let typed = claude_command(ID, false, StartMode::Terminal, Some("claude")).unwrap();
        assert_eq!(
            typed,
            format!(" env ROAMGATE_CLAUDE_START=terminal claude --session-id {ID}\r")
        );
        let resumed = claude_command(ID, true, StartMode::Terminal, Some("claude")).unwrap();
        assert!(resumed.contains(&format!("claude --resume {ID} || claude --session-id {ID}")));
        assert!(claude_command("x; rm -rf ~", true, StartMode::Terminal, Some("claude")).is_err());
        assert!(claude_command(ID, true, StartMode::Terminal, Some("a b")).is_err());
    }

    #[test]
    fn the_claude_start_setting_decides_the_mode_claude_starts_in() {
        assert_eq!(
            claude_command(ID, false, StartMode::Conversation, Some("claude")).unwrap(),
            format!(" claude --session-id {ID}\r")
        );
        assert!(
            claude_command(ID, false, StartMode::Terminal, Some("claude"))
                .unwrap()
                .contains("ROAMGATE_CLAUDE_START=terminal")
        );
        assert_eq!(StartMode::parse("conversation"), StartMode::Conversation);
        assert_eq!(StartMode::parse("other"), StartMode::Terminal);
    }
}

#[cfg(test)]
mod service_tests {
    //! claude.test.ts's service cases: a fake pane, a shell or claude on a
    //! session, idle or working.

    use std::sync::{Arc, Mutex};

    use roamgate_agents::js::Obj;
    use serde_json::{Value, json};

    use super::*;
    use crate::connection::{BoxFuture, ShellResult, SwitchResult};
    use crate::inbox::test_support::{SharedStore, store};

    const A: &str = "gitlab:h/g/p#1";
    const B: &str = "gitlab:h/g/p#2";

    #[derive(Default)]
    struct Pane {
        agent: Option<String>,
        session: Option<String>,
        status: String,
    }

    #[derive(Default)]
    struct Conversation {
        held: Option<String>,
        busy: bool,
        switches: Vec<String>,
    }

    struct Fake {
        hookless: bool,
        pane: Mutex<Pane>,
        typed: Mutex<Vec<String>>,
        conversation: Option<Mutex<Conversation>>,
    }

    struct Conn(Arc<Fake>);

    static SENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"--(?:resume|session-id) ([0-9a-f-]{36})").expect("pattern"));

    impl MrConnection for Conn {
        fn id(&self) -> &str {
            "c"
        }
        fn label(&self) -> &str {
            "C"
        }
        fn run<'a>(&'a self, _script: &'a str, _timeout: u64) -> BoxFuture<'a, ShellResult> {
            Box::pin(async { ShellResult::default() })
        }
        fn herdr<'a>(
            &'a self,
            method: &'a str,
            params: Value,
        ) -> BoxFuture<'a, Result<Value, String>> {
            let fake = &self.0;
            let answer = (|| {
                let mut pane = fake.pane.lock().unwrap();
                match method {
                    "pane.list" => Ok(json!({"panes": [
                        {"pane_id": "w1:p1", "workspace_id": "w1"},
                        {"pane_id": "w2:p1", "workspace_id": "w2"},
                    ]})),
                    "agent.get" => {
                        let Some(agent) = &pane.agent else {
                            return Err("agent_not_found".to_owned());
                        };
                        let session = match (&pane.session, fake.hookless) {
                            (Some(session), false) => json!({"kind": "id", "value": session}),
                            _ => Value::Null,
                        };
                        Ok(
                            json!({"agent": {"agent": agent, "agent_status": pane.status, "agent_session": session}}),
                        )
                    }
                    "pane.send_text" => {
                        assert_eq!(params["pane_id"], "w1:p1");
                        let text = params["text"].as_str().unwrap().to_owned();
                        fake.typed.lock().unwrap().push(text.clone());
                        if text == "/exit\r" {
                            if pane.status == "working" {
                                return Err("typed into a busy Claude".to_owned());
                            }
                            pane.agent = None;
                            pane.session = None;
                        } else {
                            pane.agent = Some("claude".into());
                            pane.session = SENT.captures(&text).map(|c| c[1].to_owned());
                            pane.status = "idle".into();
                        }
                        Ok(json!({}))
                    }
                    _ => Ok(json!({})),
                }
            })();
            Box::pin(async move { answer })
        }
        fn conversation_owned<'a>(&'a self, _pane: &'a str) -> BoxFuture<'a, Option<String>> {
            let held = self
                .0
                .conversation
                .as_ref()
                .and_then(|c| c.lock().unwrap().held.clone());
            Box::pin(async move { held })
        }
        fn conversation_switch<'a>(
            &'a self,
            _pane: &'a str,
            session: &'a str,
        ) -> BoxFuture<'a, SwitchResult> {
            let mut conversation = self.0.conversation.as_ref().unwrap().lock().unwrap();
            conversation.switches.push(session.to_owned());
            let result = if conversation.busy {
                SwitchResult::Refused {
                    busy: true,
                    reason: "it works".into(),
                }
            } else {
                conversation.held = Some(session.to_owned());
                SwitchResult::Ok
            };
            Box::pin(async move { result })
        }
    }

    struct Setup {
        _dir: tempfile::TempDir,
        store: SharedStore,
        fake: Arc<Fake>,
        reviews: Arc<Mutex<Vec<Obj>>>,
        claude: MrClaude,
    }

    fn setup(hookless: bool, conversation: bool) -> Setup {
        let (dir, store) = store();
        store
            .lock()
            .unwrap()
            .update(|state| {
                state.insert(
                    "projects".into(),
                    json!({"h/g/p": {"connectionId": "c", "clone": "/src/p",
                        "worktree": "/src/p.worktrees/review", "workspaceId": "w1"}}),
                );
                state.insert(
                    "reviews".into(),
                    json!({
                        A: {"connectionId": "c", "sessionId": "rA", "workspaceId": "w1"},
                        B: {"connectionId": "c", "sessionId": "rB", "workspaceId": "w1"},
                    }),
                );
            })
            .unwrap();
        let fake = Arc::new(Fake {
            hookless,
            pane: Mutex::new(Pane {
                status: "unknown".into(),
                ..Pane::default()
            }),
            typed: Mutex::new(vec![]),
            conversation: conversation.then(|| Mutex::new(Conversation::default())),
        });
        let reviews = Arc::new(Mutex::new(vec![]));
        let conn: Arc<dyn MrConnection> = Arc::new(Conn(fake.clone()));
        let seen = reviews.clone();
        let mut deps = MrClaudeDeps::new(
            Arc::new(|key: &str| {
                (key == A || key == B).then(|| {
                    json!({"host": "h", "project": "g/p"})
                        .as_object()
                        .unwrap()
                        .clone()
                })
            }),
            store.clone(),
            Arc::new(move || vec![conn.clone()]),
            Arc::new(move |params| {
                seen.lock().unwrap().push(params);
                Box::pin(async { Ok(()) })
            }),
        );
        deps.wait_ms = 50;
        deps.poll_ms = 10;
        Setup {
            _dir: dir,
            store,
            fake,
            reviews,
            claude: MrClaude::new(deps),
        }
    }

    impl Setup {
        fn session(&self, key: &str) -> String {
            self.store.lock().unwrap().get()["reviews"][key]["claudeSession"]
                .as_str()
                .unwrap()
                .to_owned()
        }
        fn typed(&self) -> Vec<String> {
            std::mem::take(&mut *self.fake.typed.lock().unwrap())
        }
        fn conversation(&self) -> std::sync::MutexGuard<'_, Conversation> {
            self.fake.conversation.as_ref().unwrap().lock().unwrap()
        }
    }

    fn command(session: &str, resume: bool) -> String {
        claude_command(session, resume, StartMode::Terminal, Some("claude")).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn review_with_claude_starts_the_requests_session_and_asks_the_review() {
        let t = setup(false, false);
        let state = t.claude.review(A, Some("error paths")).await.unwrap();
        assert_eq!(state.state(), "ready");
        let session = t.session(A);
        assert_eq!(t.typed(), vec![command(&session, false)]);
        assert_eq!(
            Value::Array(
                t.reviews
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .map(Value::Object)
                    .collect()
            ),
            json!([{"sessionId": "rA", "paneId": "w1:p1", "focus": "error paths"}])
        );
        assert_eq!(
            state.to_json(),
            json!({"state": "ready", "paneId": "w1:p1", "session": session})
        );
    }

    #[tokio::test(start_paused = true)]
    async fn switching_resumes_the_other_requests_session_never_while_busy() {
        let t = setup(false, false);
        t.claude.ensure(A, true, false).await.unwrap();
        t.claude.ensure(B, true, false).await.unwrap();
        let a = t.session(A);
        let b = t.session(B);
        assert_eq!(
            t.fake.pane.lock().unwrap().session.as_deref(),
            Some(b.as_str())
        );
        // Back to A: /exit then resume A's session.
        t.typed();
        assert_eq!(
            t.claude.ensure(A, false, false).await.unwrap().state(),
            "ready"
        );
        assert_eq!(t.typed(), vec!["/exit\r".to_owned(), command(&a, true)]);
        // A busy: only reported; nothing typed.
        t.fake.pane.lock().unwrap().status = "working".into();
        assert_eq!(
            t.claude.ensure(B, false, false).await.unwrap(),
            MrClaudeState::Busy {
                pane_id: "w1:p1".into(),
                with: Some(A.into())
            }
        );
        assert!(t.typed().is_empty());
        // Waiting: still busy at the deadline, still nothing typed.
        assert_eq!(
            t.claude.ensure(B, false, true).await.unwrap().state(),
            "busy"
        );
        assert!(t.typed().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn without_claudes_session_hook_the_session_started_there_is_known() {
        let t = setup(true, false);
        t.claude.ensure(A, true, false).await.unwrap();
        let a = t.session(A);
        t.typed();
        assert_eq!(
            t.claude.ensure(A, false, false).await.unwrap().state(),
            "ready"
        );
        assert!(t.typed().is_empty());
        t.claude.ensure(B, true, false).await.unwrap();
        t.typed();
        t.claude.ensure(A, false, false).await.unwrap();
        assert_eq!(t.typed(), vec!["/exit\r".to_owned(), command(&a, true)]);
    }

    #[tokio::test(start_paused = true)]
    async fn conversation_mode_its_own_switch_never_exit_never_a_busy_turn() {
        let t = setup(false, true);
        let held = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        t.store
            .lock()
            .unwrap()
            .update(|state| {
                state["reviews"][A]
                    .as_object_mut()
                    .unwrap()
                    .insert("claudeSession".into(), json!(held));
            })
            .unwrap();
        t.conversation().held = Some(held.into());
        assert_eq!(
            t.claude.ensure(A, false, false).await.unwrap().state(),
            "ready"
        );
        // B has no session: a switch starts none; Ask Claude makes one.
        assert_eq!(
            t.claude.ensure(B, false, false).await.unwrap().state(),
            "none"
        );
        t.conversation().busy = true;
        assert!(matches!(
            t.claude.ensure(B, true, false).await.unwrap(),
            MrClaudeState::Busy { with: Some(ref with), .. } if with == A
        ));
        // "Switch when it is done": tries again until it is idle.
        let claude = t.claude.clone();
        let waiting = tokio::spawn(async move { claude.ensure(B, true, true).await });
        tokio::task::yield_now().await;
        t.conversation().busy = false;
        let done = waiting.await.unwrap().unwrap();
        assert_eq!(done.state(), "ready");
        let b = t.session(B);
        assert_eq!(t.conversation().held.as_deref(), Some(b.as_str()));
        assert!(t.conversation().switches.iter().all(|id| *id == b));
        // Nothing typed into the pane, no /exit.
        assert!(t.typed().is_empty());
        // Back to A: its own session again.
        assert_eq!(
            t.claude.ensure(A, false, false).await.unwrap().state(),
            "ready"
        );
        assert_eq!(t.conversation().held.as_deref(), Some(held));
    }

    #[tokio::test(start_paused = true)]
    async fn a_claude_that_is_no_requests_is_left_alone() {
        let t = setup(false, false);
        {
            let mut pane = t.fake.pane.lock().unwrap();
            pane.agent = Some("claude".into());
            pane.session = Some("11111111-1111-4111-8111-111111111111".into());
            pane.status = "idle".into();
        }
        assert_eq!(t.claude.review(A, None).await.unwrap().state(), "foreign");
        assert!(t.typed().is_empty());
        assert!(t.reviews.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_without_a_session_nothing_started_by_a_switch() {
        let t = setup(false, false);
        assert_eq!(
            t.claude.ensure(A, false, false).await.unwrap().state(),
            "none"
        );
        assert!(t.typed().is_empty());
        assert_eq!(t.claude.status(A).await.unwrap().state(), "none");
    }
}
