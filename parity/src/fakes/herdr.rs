//! fake-herdr: a Herdr for one run, on Herdr's own wire types
//! (`herdr-api`, vendored at the verified Herdr release).
//!
//! The control socket speaks Herdr's NDJSON API: every request line must
//! deserialize as Herdr's `Request` (else it is answered `invalid_request`
//! as Herdr does, and logged as invalid so a scenario can fail on it), and
//! every answer is one of Herdr's `ResponseResult`s, built from a session
//! model (workspaces, tabs, panes, agents) a scenario seeds and changes.
//! `events.subscribe` keeps the connection open and gets the events the
//! scenario emits, each checked against Herdr's `EventEnvelope` or
//! `SubscriptionEventEnvelope`. Methods outside the model are answered from
//! the scenario's `responses` (by method name) or refused.
//!
//! The client socket answers the direct terminal handshake (`TerminalHello`
//! with `Welcome`, Herdr's version check) and then stays quiet.
//!
//! Named pipes (Windows) are not served yet.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use herdr_api::api::{
    AgentInfo, ErrorBody, ErrorResponse, EventEnvelope, Method, PaneInfo, Request, ResponseResult,
    SessionSnapshot, SubscriptionEventEnvelope, SuccessResponse, TabInfo, WorkspaceInfo,
};
use herdr_api::wire;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

/// A scenario's description of the Herdr session. Entries are Herdr's
/// types; fields left out get defaults (see `fill`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HerdrSeed {
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub protocol: Option<u32>,
    #[serde(default)]
    pub workspaces: Vec<Value>,
    #[serde(default)]
    pub tabs: Vec<Value>,
    #[serde(default)]
    pub panes: Vec<Value>,
    #[serde(default)]
    pub agents: Vec<Value>,
    /// Answers by method name: a `ResponseResult` (with its `type`), or
    /// `{"error": {"code", "message"}}`.
    #[serde(default)]
    pub responses: BTreeMap<String, Value>,
    /// Panes with a shell and a Claude TUI (herdr_panes.rs).
    #[serde(default)]
    pub terminals: BTreeMap<String, Value>,
    /// Serve endpoint generation 1 on the client socket (default: the
    /// legacy direct-terminal Welcome only, as a Herdr before 0.9.0).
    #[serde(default)]
    pub endpoint: bool,
    /// The endpoint methods the welcome advertises.
    #[serde(default)]
    pub endpoint_methods: Vec<String>,
    /// Endpoint requests' answers by method: a result, or `{"error": ...}`.
    #[serde(default)]
    pub endpoint_responses: BTreeMap<String, Value>,
    /// What a direct-terminal attach shows, by terminal or pane id.
    #[serde(default)]
    pub screens: BTreeMap<String, String>,
    /// The protocol the direct-terminal Welcome says (default: Herdr's).
    #[serde(default)]
    pub welcome_protocol: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct Model {
    pub version: String,
    pub protocol: u32,
    pub workspaces: Vec<WorkspaceInfo>,
    pub tabs: Vec<TabInfo>,
    pub panes: Vec<PaneInfo>,
    pub agents: Vec<AgentInfo>,
    pub responses: BTreeMap<String, Value>,
    pub terminals: BTreeMap<String, Value>,
    pub endpoint: bool,
    pub endpoint_methods: Vec<String>,
    pub endpoint_responses: BTreeMap<String, Value>,
    pub screens: BTreeMap<String, String>,
    pub welcome_protocol: Option<u32>,
    /// The popup shown over the surfaces: its terminal id and title.
    pub popup: Option<(String, String)>,
    /// The endpoint snapshot's revision (bumped on reseed).
    pub revision: u64,
}

/// One request the fake got.
#[derive(Debug, Clone, Serialize)]
pub struct HerdrCall {
    pub method: String,
    pub params: Value,
    /// False when Herdr's types refused it.
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn default_into(target: &mut Map<String, Value>, key: &str, value: Value) {
    target.entry(key.to_owned()).or_insert(value);
}

fn str_field(value: &Map<String, Value>, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

impl Model {
    /// The seed with defaults, through Herdr's types.
    pub fn from_seed(seed: &HerdrSeed) -> Result<Model> {
        let mut workspaces: Vec<Map<String, Value>> = seed.workspaces.iter().map(object).collect();
        let mut tabs: Vec<Map<String, Value>> = seed.tabs.iter().map(object).collect();
        let mut panes: Vec<Map<String, Value>> = seed.panes.iter().map(object).collect();
        let mut agents: Vec<Map<String, Value>> = seed.agents.iter().map(object).collect();
        for (index, workspace) in workspaces.iter_mut().enumerate() {
            let id =
                str_field(workspace, "workspace_id").unwrap_or_else(|| format!("w{}", index + 1));
            default_into(workspace, "workspace_id", json!(id));
            default_into(workspace, "number", json!(index + 1));
            default_into(workspace, "label", json!(id));
            default_into(workspace, "focused", json!(index == 0));
            default_into(workspace, "agent_status", json!("idle"));
        }
        // A workspace without tabs gets one.
        for workspace in &workspaces {
            let id = str_field(workspace, "workspace_id").unwrap_or_default();
            if !tabs
                .iter()
                .any(|tab| str_field(tab, "workspace_id").as_deref() == Some(&id))
            {
                let mut tab = Map::new();
                tab.insert("tab_id".into(), json!(format!("{id}:t1")));
                tab.insert("workspace_id".into(), json!(id));
                tabs.push(tab);
            }
        }
        let mut numbers: BTreeMap<String, usize> = BTreeMap::new();
        for tab in tabs.iter_mut() {
            let workspace = str_field(tab, "workspace_id").unwrap_or_default();
            let number = numbers.entry(workspace.clone()).or_default();
            *number += 1;
            default_into(tab, "number", json!(*number));
            default_into(tab, "label", json!(format!("{number}")));
            default_into(tab, "focused", json!(*number == 1));
            default_into(tab, "agent_status", json!("idle"));
        }
        let first_tab = |workspace: &str, tabs: &[Map<String, Value>]| {
            tabs.iter()
                .find(|tab| str_field(tab, "workspace_id").as_deref() == Some(workspace))
                .and_then(|tab| str_field(tab, "tab_id"))
                .unwrap_or_default()
        };
        for (index, pane) in panes.iter_mut().enumerate() {
            let id = str_field(pane, "pane_id").unwrap_or_else(|| format!("p{}", index + 1));
            default_into(pane, "pane_id", json!(id));
            default_into(pane, "terminal_id", json!(format!("term-{id}")));
            let workspace = str_field(pane, "workspace_id").unwrap_or_else(|| {
                workspaces
                    .first()
                    .and_then(|workspace| str_field(workspace, "workspace_id"))
                    .unwrap_or_default()
            });
            default_into(pane, "workspace_id", json!(workspace));
            default_into(pane, "tab_id", json!(first_tab(&workspace, &tabs)));
            default_into(pane, "focused", json!(false));
            default_into(pane, "agent_status", json!("idle"));
            default_into(pane, "revision", json!(0));
        }
        for agent in agents.iter_mut() {
            let pane_id = str_field(agent, "pane_id").unwrap_or_default();
            let pane = panes
                .iter()
                .find(|pane| str_field(pane, "pane_id").as_deref() == Some(&pane_id))
                .cloned()
                .unwrap_or_default();
            for key in [
                "terminal_id",
                "workspace_id",
                "tab_id",
                "cwd",
                "agent",
                "revision",
            ] {
                if let Some(value) = pane.get(key) {
                    default_into(agent, key, value.clone());
                }
            }
            default_into(agent, "focused", json!(false));
            default_into(agent, "agent_status", json!("idle"));
            default_into(agent, "revision", json!(0));
        }
        for tab in tabs.iter_mut() {
            let id = str_field(tab, "tab_id").unwrap_or_default();
            let count = panes
                .iter()
                .filter(|pane| str_field(pane, "tab_id").as_deref() == Some(&id))
                .count();
            default_into(tab, "pane_count", json!(count));
        }
        for workspace in workspaces.iter_mut() {
            let id = str_field(workspace, "workspace_id").unwrap_or_default();
            let mine =
                |item: &Map<String, Value>| str_field(item, "workspace_id").as_deref() == Some(&id);
            default_into(
                workspace,
                "pane_count",
                json!(panes.iter().filter(|pane| mine(pane)).count()),
            );
            default_into(
                workspace,
                "tab_count",
                json!(tabs.iter().filter(|tab| mine(tab)).count()),
            );
            default_into(workspace, "active_tab_id", json!(first_tab(&id, &tabs)));
        }
        let list = |items: Vec<Map<String, Value>>| {
            Value::Array(items.into_iter().map(Value::Object).collect())
        };
        Ok(Model {
            version: seed
                .version
                .clone()
                .unwrap_or_else(|| herdr_api::HERDR_VERSION.to_owned()),
            protocol: seed.protocol.unwrap_or(wire::PROTOCOL_VERSION),
            workspaces: serde_json::from_value(list(workspaces))
                .context("herdr.workspaces are not Herdr WorkspaceInfo")?,
            tabs: serde_json::from_value(list(tabs)).context("herdr.tabs are not Herdr TabInfo")?,
            panes: serde_json::from_value(list(panes))
                .context("herdr.panes are not Herdr PaneInfo")?,
            agents: serde_json::from_value(list(agents))
                .context("herdr.agents are not Herdr AgentInfo")?,
            responses: seed.responses.clone(),
            terminals: seed.terminals.clone(),
            endpoint: seed.endpoint,
            endpoint_methods: seed.endpoint_methods.clone(),
            endpoint_responses: seed.endpoint_responses.clone(),
            screens: seed.screens.clone(),
            popup: None,
            welcome_protocol: seed.welcome_protocol,
            revision: 1,
        })
    }

    /// A terminal's screen for a direct attach.
    fn screen(&self, terminal: &str) -> String {
        let pane = self
            .panes
            .iter()
            .find(|pane| pane.terminal_id == terminal)
            .map(|pane| pane.pane_id.clone())
            .unwrap_or_default();
        self.screens
            .get(terminal)
            .or_else(|| self.screens.get(&pane))
            .cloned()
            .unwrap_or_else(|| format!("parity {terminal} $ "))
    }

    /// The endpoint's `shell.snapshot.v1`, Herdr's ClientShellSnapshot of
    /// the model.
    pub fn shell_snapshot(&self) -> herdr_api::endpoint::ClientShellSnapshot {
        use herdr_api::endpoint::*;
        let status = |value: &herdr_api::api::AgentStatus| *value;
        ClientShellSnapshot {
            boot_id: BOOT_ID.into(),
            revision: self.revision,
            config_diagnostic: None,
            product_announcement: None,
            update_available: None,
            update_install_command: "herdr update".into(),
            server_keybindings_toml: None,
            latest_release_notes_available: false,
            integration_updates_available: false,
            worktree_directory: String::new(),
            release_notes: None,
            focused_workspace_id: self
                .workspaces
                .iter()
                .find(|w| w.focused)
                .map(|w| w.workspace_id.clone()),
            focused_tab_id: self
                .tabs
                .iter()
                .find(|t| t.focused)
                .map(|t| t.tab_id.clone()),
            focused_pane_id: self
                .panes
                .iter()
                .find(|p| p.focused)
                .map(|p| p.pane_id.clone()),
            tab_bar_right: Vec::new(),
            tab_bar_right_separator: String::new(),
            agent_view_label: None,
            agent_order: self.agents.iter().map(|a| a.pane_id.clone()).collect(),
            workspaces: self
                .workspaces
                .iter()
                .map(|w| ClientShellWorkspace {
                    workspace_id: w.workspace_id.clone(),
                    active_tab_id: w.active_tab_id.clone(),
                    new_workspace_cwd: String::new(),
                    number: w.number,
                    label: w.label.clone(),
                    custom_label: false,
                    branch: None,
                    git_ahead_behind: None,
                    tokens: w
                        .tokens
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    worktree: None,
                    focused: w.focused,
                    agent_status: status(&w.agent_status),
                })
                .collect(),
            tabs: self
                .tabs
                .iter()
                .map(|t| ClientShellTab {
                    tab_id: t.tab_id.clone(),
                    workspace_id: t.workspace_id.clone(),
                    number: t.number,
                    label: t.label.clone(),
                    custom_label: false,
                    zoomed: false,
                    focused: t.focused,
                    agent_status: status(&t.agent_status),
                })
                .collect(),
            panes: self
                .panes
                .iter()
                .map(|p| ClientShellPane {
                    pane_id: p.pane_id.clone(),
                    workspace_id: p.workspace_id.clone(),
                    tab_id: p.tab_id.clone(),
                    label: p.label.clone(),
                    cwd: p.cwd.clone(),
                    foreground_cwd: p.foreground_cwd.clone(),
                    focused: p.focused,
                    right_click_passthrough: false,
                })
                .collect(),
            agents: self
                .agents
                .iter()
                .map(|a| ClientShellAgent {
                    pane_id: a.pane_id.clone(),
                    workspace_id: a.workspace_id.clone(),
                    tab_id: a.tab_id.clone(),
                    name: a.name.clone(),
                    display_agent: a.display_agent.clone(),
                    agent: a.agent.clone(),
                    title: a.title.clone(),
                    terminal_title: a.terminal_title.clone(),
                    terminal_title_stripped: a.terminal_title_stripped.clone(),
                    agent_status: status(&a.agent_status),
                    state_change_seq: a.state_change_seq,
                    state_labels: a
                        .state_labels
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    tokens: a
                        .tokens
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    focused: a.focused,
                })
                .collect(),
            commands: Vec::new(),
        }
    }

    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            version: self.version.clone(),
            protocol: self.protocol,
            focused_workspace_id: self
                .workspaces
                .iter()
                .find(|workspace| workspace.focused)
                .map(|workspace| workspace.workspace_id.clone()),
            focused_tab_id: None,
            focused_pane_id: self
                .panes
                .iter()
                .find(|pane| pane.focused)
                .map(|pane| pane.pane_id.clone()),
            workspaces: self.workspaces.clone(),
            tabs: self.tabs.clone(),
            panes: self.panes.clone(),
            layouts: Vec::new(),
            agents: self.agents.clone(),
        }
    }

    /// A new pane in a new or given tab, with Herdr's defaults.
    fn new_pane(&mut self, workspace_id: &str, tab_id: &str, cwd: Option<String>) -> PaneInfo {
        let number = self.panes.len() + 1;
        let pane: PaneInfo = serde_json::from_value(json!({
            "pane_id": format!("p{number}"),
            "terminal_id": format!("term-p{number}"),
            "workspace_id": workspace_id,
            "tab_id": tab_id,
            "focused": false,
            "agent_status": "idle",
            "revision": 0,
            "cwd": cwd,
        }))
        .expect("a pane");
        self.panes.push(pane.clone());
        pane
    }

    fn new_tab(&mut self, workspace_id: &str, label: Option<String>) -> TabInfo {
        let number = self
            .tabs
            .iter()
            .filter(|tab| tab.workspace_id == workspace_id)
            .count()
            + 1;
        let tab: TabInfo = serde_json::from_value(json!({
            "tab_id": format!("{workspace_id}:t{number}"),
            "workspace_id": workspace_id,
            "number": number,
            "label": label.unwrap_or_else(|| number.to_string()),
            "focused": false,
            "pane_count": 1,
            "agent_status": "idle",
        }))
        .expect("a tab");
        self.tabs.push(tab.clone());
        tab
    }

    /// The directory a worktree request starts from: the workspace's pane,
    /// or the cwd given.
    fn source_cwd(&self, workspace: Option<&str>, cwd: Option<&str>) -> Result<String, ErrorBody> {
        if let Some(cwd) = cwd {
            return Ok(cwd.to_owned());
        }
        let workspace = workspace.unwrap_or_default();
        self.panes
            .iter()
            .find(|pane| pane.workspace_id == workspace && pane.cwd.is_some())
            .and_then(|pane| pane.cwd.clone())
            .ok_or_else(|| ErrorBody {
                code: "not_found".into(),
                message: format!("workspace {workspace} has no directory"),
            })
    }

    /// `git worktree list` of the repository at `cwd`, as Herdr lists it.
    fn worktrees(
        &self,
        cwd: &str,
    ) -> Result<
        (
            herdr_api::api::WorktreeSourceInfo,
            Vec<herdr_api::api::WorktreeInfo>,
        ),
        ErrorBody,
    > {
        let root = git(cwd, &["rev-parse", "--show-toplevel"])?;
        let common = git(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let main = common.strip_suffix("/.git").unwrap_or(&common).to_owned();
        let name = main.rsplit('/').next().unwrap_or("repo").to_owned();
        let listing = git(cwd, &["worktree", "list", "--porcelain"])?;
        let mut worktrees = Vec::new();
        for block in listing.split("\n\n") {
            let mut path = String::new();
            let mut branch = None;
            let (mut bare, mut detached, mut prunable) = (false, false, false);
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("worktree ") {
                    path = rest.to_owned();
                } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
                    branch = Some(rest.to_owned());
                } else if line == "bare" {
                    bare = true;
                } else if line == "detached" {
                    detached = true;
                } else if line.starts_with("prunable") {
                    prunable = true;
                }
            }
            if path.is_empty() {
                continue;
            }
            let open = self
                .panes
                .iter()
                .find(|pane| pane.cwd.as_deref() == Some(path.as_str()))
                .map(|pane| pane.workspace_id.clone());
            worktrees.push(herdr_api::api::WorktreeInfo {
                label: branch
                    .clone()
                    .unwrap_or_else(|| path.rsplit('/').next().unwrap_or("").to_owned()),
                is_linked_worktree: path != main,
                path,
                branch,
                is_bare: bare,
                is_detached: detached,
                is_prunable: prunable,
                open_workspace_id: open,
            });
        }
        let source = herdr_api::api::WorktreeSourceInfo {
            repo_key: main.clone(),
            repo_name: name,
            repo_root: main,
            source_checkout_path: root,
            source_workspace_id: None,
        };
        Ok((source, worktrees))
    }

    /// The workspace of a worktree checkout, opened when it is not.
    #[allow(clippy::type_complexity)]
    fn open_worktree(
        &mut self,
        root: &str,
        path: &str,
        branch: Option<String>,
        label: Option<String>,
        focus: bool,
    ) -> Result<
        (
            WorkspaceInfo,
            TabInfo,
            PaneInfo,
            herdr_api::api::WorktreeInfo,
            bool,
        ),
        ErrorBody,
    > {
        let (_, worktrees) = self.worktrees(root)?;
        let Some(worktree) = worktrees.into_iter().find(|w| w.path == path) else {
            return Err(ErrorBody {
                code: "not_found".into(),
                message: format!("no worktree at {path}"),
            });
        };
        if let Some(pane) = self
            .panes
            .iter()
            .find(|pane| pane.cwd.as_deref() == Some(path))
            .cloned()
        {
            let workspace = self
                .workspaces
                .iter()
                .find(|w| w.workspace_id == pane.workspace_id)
                .cloned()
                .expect("a workspace");
            let tab = self
                .tabs
                .iter()
                .find(|t| t.tab_id == pane.tab_id)
                .cloned()
                .expect("a tab");
            return Ok((workspace, tab, pane, worktree, true));
        }
        let created = self.mutate(&Method::WorkspaceCreate(
            herdr_api::api::WorkspaceCreateParams {
                source_workspace_id: None,
                cwd: Some(path.to_owned()),
                focus,
                label: label.or(branch).or_else(|| Some(worktree.label.clone())),
                env: Default::default(),
            },
        ));
        match created {
            Some(Ok(ResponseResult::WorkspaceCreated {
                mut workspace,
                tab,
                root_pane,
            })) => {
                let (source, _) = self.worktrees(root)?;
                let info = herdr_api::api::WorkspaceWorktreeInfo {
                    repo_key: source.repo_key,
                    repo_name: source.repo_name,
                    repo_root: source.repo_root,
                    checkout_path: path.to_owned(),
                    is_linked_worktree: worktree.is_linked_worktree,
                };
                workspace.worktree = Some(info.clone());
                if let Some(stored) = self
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == workspace.workspace_id)
                {
                    stored.worktree = Some(info);
                }
                Ok((workspace, tab, root_pane, worktree, false))
            }
            _ => Err(ErrorBody {
                code: "error".into(),
                message: "could not open the worktree's workspace".into(),
            }),
        }
    }

    fn read_pane(
        &self,
        target: &str,
        source: herdr_api::api::ReadSource,
        format: herdr_api::api::ReadFormat,
    ) -> Result<ResponseResult, ErrorBody> {
        let Some(pane) = self
            .panes
            .iter()
            .find(|p| p.pane_id == target || p.terminal_id == target)
        else {
            return Err(ErrorBody {
                code: "not_found".into(),
                message: format!("pane {target} not found"),
            });
        };
        let claude = pane.agent.as_deref() == Some("claude")
            || self
                .agents
                .iter()
                .any(|a| a.pane_id == pane.pane_id && a.agent.as_deref() == Some("claude"));
        let text = self.screens.get(&pane.pane_id).cloned().unwrap_or_else(|| {
            if claude {
                super::herdr_panes::IDLE_CLAUDE_SCREEN.into()
            } else {
                "$ \n".into()
            }
        });
        Ok(ResponseResult::PaneRead {
            read: herdr_api::api::PaneReadResult {
                pane_id: pane.pane_id.clone(),
                workspace_id: pane.workspace_id.clone(),
                tab_id: pane.tab_id.clone(),
                source,
                format,
                text,
                revision: pane.revision,
                truncated: false,
            },
        })
    }

    /// Requests that change the session as Herdr would: creations, renames,
    /// closes, focus and input (acknowledged).
    fn mutate(&mut self, method: &Method) -> Option<Result<ResponseResult, ErrorBody>> {
        let not_found = |what: &str, id: &str| ErrorBody {
            code: "not_found".into(),
            message: format!("{what} {id} not found"),
        };
        Some(match method {
            Method::WorkspaceCreate(params) => {
                let number = self.workspaces.len() + 1;
                let id = format!("w{number}");
                let label = params.label.clone().unwrap_or_else(|| format!("{number}"));
                let tab = self.new_tab(&id, None);
                let pane = self.new_pane(&id, &tab.tab_id, params.cwd.clone());
                let workspace: WorkspaceInfo = serde_json::from_value(json!({
                    "workspace_id": id,
                    "number": number,
                    "label": label,
                    "focused": params.focus,
                    "pane_count": 1,
                    "tab_count": 1,
                    "active_tab_id": tab.tab_id,
                    "agent_status": "idle",
                }))
                .expect("a workspace");
                self.workspaces.push(workspace.clone());
                Ok(ResponseResult::WorkspaceCreated {
                    workspace,
                    tab,
                    root_pane: pane,
                })
            }
            Method::TabCreate(params) => {
                let workspace = params
                    .workspace_id
                    .clone()
                    .or_else(|| self.workspaces.first().map(|w| w.workspace_id.clone()))
                    .unwrap_or_default();
                if !self.workspaces.iter().any(|w| w.workspace_id == workspace) {
                    return Some(Err(not_found("workspace", &workspace)));
                }
                let tab = self.new_tab(&workspace, params.label.clone());
                let pane = self.new_pane(&workspace, &tab.tab_id, params.cwd.clone());
                Ok(ResponseResult::TabCreated {
                    tab,
                    root_pane: pane,
                })
            }
            Method::TabRename(params) => {
                match self.tabs.iter_mut().find(|tab| tab.tab_id == params.tab_id) {
                    Some(tab) => {
                        tab.label = params.label.clone();
                        Ok(ResponseResult::TabInfo { tab: tab.clone() })
                    }
                    None => Err(not_found("tab", &params.tab_id)),
                }
            }
            Method::WorkspaceRename(params) => {
                match self
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == params.workspace_id)
                {
                    Some(workspace) => {
                        workspace.label = params.label.clone();
                        Ok(ResponseResult::WorkspaceInfo {
                            workspace: workspace.clone(),
                        })
                    }
                    None => Err(not_found("workspace", &params.workspace_id)),
                }
            }
            Method::WorkspaceClose(params) => {
                let before = self.workspaces.len();
                self.workspaces
                    .retain(|w| w.workspace_id != params.workspace_id);
                if before == self.workspaces.len() {
                    return Some(Err(not_found("workspace", &params.workspace_id)));
                }
                self.tabs.retain(|t| t.workspace_id != params.workspace_id);
                self.panes.retain(|p| p.workspace_id != params.workspace_id);
                Ok(ResponseResult::Ok {})
            }
            Method::TabClose(target) => {
                self.tabs.retain(|t| t.tab_id != target.tab_id);
                self.panes.retain(|p| p.tab_id != target.tab_id);
                Ok(ResponseResult::Ok {})
            }
            Method::PaneClose(target) => {
                self.panes.retain(|p| p.pane_id != target.pane_id);
                self.agents.retain(|a| a.pane_id != target.pane_id);
                Ok(ResponseResult::Ok {})
            }
            Method::PaneSendText(params) => {
                match self.panes.iter().any(|p| p.pane_id == params.pane_id) {
                    true => Ok(ResponseResult::Ok {}),
                    false => Err(not_found("pane", &params.pane_id)),
                }
            }
            Method::PaneSendKeys(params) => {
                match self.panes.iter().any(|p| p.pane_id == params.pane_id) {
                    true => Ok(ResponseResult::Ok {}),
                    false => Err(not_found("pane", &params.pane_id)),
                }
            }
            Method::PaneSendInput(_)
            | Method::PaneFocus(_)
            | Method::TabFocus(_)
            | Method::WorkspaceFocus(_) => Ok(ResponseResult::Ok {}),
            Method::IntegrationList(_) => Ok(ResponseResult::IntegrationList {
                integrations: Vec::new(),
            }),
            // A pane's screen: `screens` of the seed, else an idle Claude for
            // a Claude pane, else a shell prompt (herdr_panes.rs answers for
            // its terminal panes first).
            Method::AgentRead(params) => {
                self.read_pane(&params.target, params.source, params.format)
            }
            Method::PaneRead(params) => {
                self.read_pane(&params.pane_id, params.source, params.format)
            }
            Method::WorktreeList(params) => {
                let cwd =
                    match self.source_cwd(params.workspace_id.as_deref(), params.cwd.as_deref()) {
                        Ok(cwd) => cwd,
                        Err(body) => return Some(Err(body)),
                    };
                match self.worktrees(&cwd) {
                    Ok((source, worktrees)) => {
                        Ok(ResponseResult::WorktreeList { source, worktrees })
                    }
                    Err(body) => Err(body),
                }
            }
            Method::WorktreeCreate(params) => {
                let cwd =
                    match self.source_cwd(params.workspace_id.as_deref(), params.cwd.as_deref()) {
                        Ok(cwd) => cwd,
                        Err(body) => return Some(Err(body)),
                    };
                let Some(branch) = params.branch.clone() else {
                    return Some(Err(ErrorBody {
                        code: "invalid_request".into(),
                        message: "worktree.create requires branch".into(),
                    }));
                };
                let root = match git(&cwd, &["rev-parse", "--show-toplevel"]) {
                    Ok(root) => root,
                    Err(body) => return Some(Err(body)),
                };
                let name = root.rsplit('/').next().unwrap_or("repo").to_owned();
                let path = params.path.clone().unwrap_or_else(|| {
                    format!(
                        "{}/.herdr-worktrees/{name}/{}",
                        root.rsplit_once('/').map_or("", |(parent, _)| parent),
                        branch.replace('/', "-")
                    )
                });
                let mut args = vec!["worktree", "add", "-b", branch.as_str(), path.as_str()];
                if let Some(base) = params.base.as_deref() {
                    args.push(base);
                }
                if let Err(body) = git(&root, &args) {
                    return Some(Err(body));
                }
                self.open_worktree(
                    &root,
                    &path,
                    Some(branch),
                    params.label.clone(),
                    params.focus,
                )
                .map(
                    |(workspace, tab, root_pane, worktree, _)| ResponseResult::WorktreeCreated {
                        workspace,
                        tab,
                        root_pane,
                        worktree,
                    },
                )
            }
            Method::WorktreeOpen(params) => {
                let Some(path) = params.path.clone() else {
                    return Some(Err(ErrorBody {
                        code: "invalid_request".into(),
                        message: "worktree.open requires path".into(),
                    }));
                };
                let root = match git(&path, &["rev-parse", "--show-toplevel"]) {
                    Ok(root) => root,
                    Err(body) => return Some(Err(body)),
                };
                self.open_worktree(
                    &root,
                    &path,
                    params.branch.clone(),
                    params.label.clone(),
                    params.focus,
                )
                .map(|(workspace, tab, root_pane, worktree, already_open)| {
                    ResponseResult::WorktreeOpened {
                        workspace,
                        tab,
                        root_pane,
                        worktree,
                        already_open,
                    }
                })
            }
            Method::WorktreeRemove(params) => {
                let Some(path) = self
                    .panes
                    .iter()
                    .find(|pane| pane.workspace_id == params.workspace_id)
                    .and_then(|pane| pane.cwd.clone())
                else {
                    return Some(Err(not_found("workspace", &params.workspace_id)));
                };
                let mut args = vec!["worktree", "remove"];
                if params.force {
                    args.push("--force");
                }
                args.push(path.as_str());
                if let Err(body) = git(&path, &args) {
                    return Some(Err(body));
                }
                self.workspaces
                    .retain(|w| w.workspace_id != params.workspace_id);
                self.tabs.retain(|t| t.workspace_id != params.workspace_id);
                self.panes.retain(|p| p.workspace_id != params.workspace_id);
                Ok(ResponseResult::WorktreeRemoved {
                    workspace_id: params.workspace_id.clone(),
                    path,
                    forced: params.force,
                })
            }
            _ => return None,
        })
    }

    /// Herdr's answer to a request from the model, or None to refuse.
    fn answer(&self, method: &Method) -> Option<Result<ResponseResult, ErrorBody>> {
        let not_found = |what: &str, id: &str| ErrorBody {
            code: "not_found".into(),
            message: format!("{what} {id} not found"),
        };
        Some(match method {
            Method::Ping(_) => Ok(ResponseResult::Pong {
                version: self.version.clone(),
                protocol: self.protocol,
                capabilities: None,
            }),
            Method::SessionSnapshot(_) => Ok(ResponseResult::SessionSnapshot {
                snapshot: Box::new(self.snapshot()),
            }),
            Method::WorkspaceList(_) => Ok(ResponseResult::WorkspaceList {
                workspaces: self.workspaces.clone(),
            }),
            Method::WorkspaceGet(target) => self
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == target.workspace_id)
                .map(|workspace| ResponseResult::WorkspaceInfo {
                    workspace: workspace.clone(),
                })
                .ok_or_else(|| not_found("workspace", &target.workspace_id)),
            Method::TabList(params) => Ok(ResponseResult::TabList {
                tabs: self
                    .tabs
                    .iter()
                    .filter(|tab| {
                        params
                            .workspace_id
                            .as_ref()
                            .is_none_or(|id| &tab.workspace_id == id)
                    })
                    .cloned()
                    .collect(),
            }),
            Method::TabGet(target) => self
                .tabs
                .iter()
                .find(|tab| tab.tab_id == target.tab_id)
                .map(|tab| ResponseResult::TabInfo { tab: tab.clone() })
                .ok_or_else(|| not_found("tab", &target.tab_id)),
            Method::PaneList(params) => Ok(ResponseResult::PaneList {
                panes: self
                    .panes
                    .iter()
                    .filter(|pane| {
                        params
                            .workspace_id
                            .as_ref()
                            .is_none_or(|id| &pane.workspace_id == id)
                    })
                    .cloned()
                    .collect(),
            }),
            Method::PaneGet(target) => self
                .panes
                .iter()
                .find(|pane| pane.pane_id == target.pane_id)
                .map(|pane| ResponseResult::PaneInfo { pane: pane.clone() })
                .ok_or_else(|| not_found("pane", &target.pane_id)),
            Method::AgentList(_) => Ok(ResponseResult::AgentList {
                agents: self.agents.clone(),
            }),
            Method::AgentGet(target) => self
                .agents
                .iter()
                .find(|agent| agent.pane_id == target.target || agent.terminal_id == target.target)
                .map(|agent| ResponseResult::AgentInfo {
                    agent: agent.clone(),
                })
                .ok_or_else(|| not_found("agent", &target.target)),
            Method::AgentPrompt(params) => self
                .agents
                .iter()
                .find(|agent| agent.pane_id == params.target || agent.terminal_id == params.target)
                .map(|agent| ResponseResult::AgentPrompted {
                    agent: agent.clone(),
                })
                .ok_or_else(|| not_found("agent", &params.target)),
            _ => return None,
        })
    }
}

struct Shared {
    model: Model,
    calls: Vec<HerdrCall>,
    panes: super::herdr_panes::Panes,
}

/// A running fake Herdr.
pub struct FakeHerdr {
    pub control: PathBuf,
    pub client: PathBuf,
    shared: Arc<Mutex<Shared>>,
    events: broadcast::Sender<String>,
    /// Frames for every endpoint client (notifications, snapshots).
    frames: broadcast::Sender<Vec<u8>>,
    tasks: Vec<JoinHandle<()>>,
}

fn line<T: Serialize>(value: &T) -> String {
    let mut text = serde_json::to_string(value).expect("Herdr types serialise");
    text.push('\n');
    text
}

/// The answer line to one request line, and whether it subscribes.
fn handle(shared: &Mutex<Shared>, text: &str) -> (String, bool) {
    let raw: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let method_name = raw
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let params = raw.get("params").cloned().unwrap_or(Value::Null);
    let parsed = serde_json::from_value::<Request>(raw.clone());
    let mut guard = shared.lock().expect("fake herdr state");
    guard.calls.push(HerdrCall {
        method: method_name.clone(),
        params,
        valid: parsed.is_ok(),
        error: parsed.as_ref().err().map(ToString::to_string),
    });
    let error = |code: &str, message: String| {
        line(&ErrorResponse {
            id: id.clone(),
            error: ErrorBody {
                code: code.into(),
                message,
            },
        })
    };
    if let Some(scripted) = guard.model.responses.get(&method_name) {
        if let Some(body) = scripted.get("error") {
            let body: ErrorBody = serde_json::from_value(body.clone()).unwrap_or(ErrorBody {
                code: "error".into(),
                message: body.to_string(),
            });
            return (error(&body.code, body.message), false);
        }
        // Scripted answers pass through Herdr's types when they can.
        let result = serde_json::from_value::<ResponseResult>(scripted.clone())
            .map(|result| serde_json::to_value(result).expect("serialises"))
            .unwrap_or_else(|_| scripted.clone());
        return (
            line(&json!({"id": id, "result": result})),
            method_name == "events.subscribe",
        );
    }
    let request = match parsed {
        Ok(request) => request,
        Err(reason) => return (error("invalid_request", reason.to_string()), false),
    };
    {
        let Shared { model, panes, .. } = &mut *guard;
        if let Some(result) = panes.answer(model, &request.method) {
            return (line(&SuccessResponse { id, result }), false);
        }
    }
    if let Method::EventsSubscribe(_) = request.method {
        return (
            line(&SuccessResponse {
                id,
                result: ResponseResult::SubscriptionStarted {},
            }),
            true,
        );
    }
    if let Some(result) = guard.model.mutate(&request.method) {
        return match result {
            Ok(result) => (line(&SuccessResponse { id, result }), false),
            Err(body) => (error(&body.code, body.message), false),
        };
    }
    match guard.model.answer(&request.method) {
        Some(Ok(result)) => (line(&SuccessResponse { id, result }), false),
        Some(Err(body)) => (error(&body.code, body.message), false),
        None => (
            error(
                "unsupported",
                format!("fake herdr has no answer for {method_name}"),
            ),
            false,
        ),
    }
}

#[cfg(unix)]
async fn serve_control(
    listener: tokio::net::UnixListener,
    shared: Arc<Mutex<Shared>>,
    events: broadcast::Sender<String>,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let shared = shared.clone();
        let mut receiver = events.subscribe();
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let mut subscribed = false;
            loop {
                tokio::select! {
                    next = lines.next_line() => {
                        let Ok(Some(text)) = next else { return };
                        if text.trim().is_empty() { continue; }
                        let (answer, subscribes) = handle(&shared, &text);
                        if write.write_all(answer.as_bytes()).await.is_err() { return; }
                        subscribed |= subscribes;
                    }
                    event = receiver.recv(), if subscribed => {
                        match event {
                            Ok(text) => {
                                if write.write_all(text.as_bytes()).await.is_err() { return; }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => {}
                            Err(_) => return,
                        }
                    }
                }
            }
        });
    }
}

/// Runs git in a directory; its trimmed stdout, or Herdr's error.
fn git(cwd: &str, args: &[&str]) -> Result<String, ErrorBody> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| ErrorBody {
            code: "git_failed".into(),
            message: error.to_string(),
        })?;
    if !output.status.success() {
        return Err(ErrorBody {
            code: "git_failed".into(),
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Reads one length-prefixed frame's payload.
async fn read_payload(stream: &mut (impl AsyncReadExt + Unpin)) -> Option<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.ok()?;
    let length = u32::from_le_bytes(length) as usize;
    if length > wire::MAX_FRAME_SIZE {
        return None;
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await.ok()?;
    Some(payload)
}

/// Sent on the endpoint broadcast: each shell repaints its surface.
const REPAINT: &[u8] = &[0];

/// The boot id the fake's endpoint snapshots carry.
pub const BOOT_ID: &str = "parity-boot";

fn record(shared: &Mutex<Shared>, method: &str, params: Value) {
    shared
        .lock()
        .expect("fake herdr state")
        .calls
        .push(HerdrCall {
            method: method.into(),
            params,
            valid: true,
            error: None,
        });
}

/// A terminal-ANSI `Terminal` frame (ServerMessage variant 1 since protocol 22).
fn terminal_frame(seq: u64, full: bool, bytes: &[u8]) -> Vec<u8> {
    wire::encode_variant(1, &(seq, 80u16, 24u16, full, bytes.to_vec()))
}

/// The direct-terminal (legacy thin client) side after its Welcome: an
/// `AttachTerminal` gets the terminal's screen (`screens` in the seed, by
/// terminal or pane id), typed `Input` is echoed back as an incremental
/// frame, and everything the client sends is logged as `client.<what>`.
async fn serve_terminal(mut stream: tokio::net::UnixStream, shared: Arc<Mutex<Shared>>) {
    let mut seq = 0u64;
    let mut attached = String::new();
    while let Some(payload) = read_payload(&mut stream).await {
        let Some(index) = wire::variant(&payload) else {
            return;
        };
        let mut out = Vec::new();
        match index {
            1 => {
                if let Ok((_, data)) = wire::decode::<(u32, Vec<u8>)>(&payload) {
                    record(
                        &shared,
                        "client.input",
                        json!({"terminal_id": attached, "data": String::from_utf8_lossy(&data)}),
                    );
                    seq += 1;
                    out = terminal_frame(seq, false, &data);
                }
            }
            3 => {
                if let Ok((_, cols, rows, _, _)) =
                    wire::decode::<(u32, u16, u16, u32, u32)>(&payload)
                {
                    record(
                        &shared,
                        "client.resize",
                        json!({"terminal_id": attached, "cols": cols, "rows": rows}),
                    );
                }
            }
            4 => record(&shared, "client.detach", json!({"terminal_id": attached})),
            5 => {
                if let Ok((_, terminal, takeover)) = wire::decode::<(u32, String, bool)>(&payload) {
                    record(
                        &shared,
                        "client.attach",
                        json!({"terminal_id": terminal, "takeover": takeover}),
                    );
                    let screen = {
                        let guard = shared.lock().expect("fake herdr state");
                        guard.model.screen(&terminal)
                    };
                    attached = terminal;
                    seq += 1;
                    out = terminal_frame(seq, true, screen.as_bytes());
                }
            }
            other => record(&shared, &format!("client.variant_{other}"), Value::Null),
        }
        if !out.is_empty() && stream.write_all(&out).await.is_err() {
            return;
        }
    }
}

/// A full pane surface of one pane (ServerMessage::PaneSurface): its
/// screen text laid out in cells, the pane filling the surface.
fn pane_surface(
    pane_id: &str,
    screen: &str,
    size: (u16, u16),
    projection: u64,
    surface_revision: u64,
    content_revision: u64,
    popup: Option<(String, String)>,
) -> Vec<u8> {
    use herdr_api::surface::*;
    let popup = popup.map(|(terminal_id, title)| {
        Box::new(ClientShellPopupSurface {
            terminal_id,
            title,
            width: Some(ClientShellPopupSize::Percent(80)),
            height: Some(ClientShellPopupSize::Percent(60)),
            frame: FrameData {
                cells: Vec::new(),
                width: 0,
                height: 0,
                cursor: None,
                hyperlinks: Vec::new(),
                graphics: Vec::new(),
            },
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            pixel_width: 0,
            pixel_height: 0,
        })
    });
    let (width, height) = (size.0.max(1), size.1.max(1));
    let mut cells = Vec::with_capacity(width as usize * height as usize);
    let lines: Vec<&str> = screen.split('\n').collect();
    let mut cursor = (0u16, 0u16);
    for y in 0..height {
        let chars: Vec<char> = lines
            .get(y as usize)
            .map(|line| line.chars().collect())
            .unwrap_or_default();
        if (y as usize) < lines.len() {
            cursor = (chars.len().min(width as usize - 1) as u16, y);
        }
        for x in 0..width {
            let symbol = chars
                .get(x as usize)
                .map(|c| c.to_string())
                .unwrap_or_else(|| " ".into());
            cells.push(CellData {
                symbol,
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            });
        }
    }
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width,
        height,
    };
    let frame = PaneSurfaceFrame {
        boot_id: BOOT_ID.into(),
        projection_revision: projection,
        surface_revision,
        frame: FrameData {
            cells,
            width,
            height,
            cursor: Some(CursorState {
                x: cursor.0,
                y: cursor.1,
                visible: true,
                shape: 0,
            }),
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        },
        panes: vec![PaneSurfacePane {
            pane_id: pane_id.into(),
            content_revision,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: Some(PaneSurfaceScrollMetrics {
                offset_from_bottom: 0,
                max_offset_from_bottom: 0,
                viewport_rows: height as u64,
            }),
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 0,
            pixel_height: 0,
        }],
        splits: Vec::new(),
        popup,
        graphics: SurfaceGraphicsScene::default(),
    };
    wire::encode_variant(wire::SERVER_PANE_SURFACE, &frame)
}

/// A client-owned shell on endpoint generation 1 (Herdr's
/// src/protocol/endpoint.rs): welcome, the snapshot, health pongs, endpoint
/// requests answered from the seed's `endpoint_responses`, and every frame
/// `endpoint_frames` carries (semantic notifications, newer snapshots).
async fn serve_endpoint(
    stream: tokio::net::UnixStream,
    shared: Arc<Mutex<Shared>>,
    mut frames: broadcast::Receiver<Vec<u8>>,
    hello: String,
) {
    use herdr_api::endpoint::*;
    let (mut read, mut write) = stream.into_split();
    let parsed = serde_json::from_str::<EndpointClientHello>(&hello);
    record(
        &shared,
        "endpoint.hello",
        serde_json::from_str(&hello).unwrap_or(Value::Null),
    );
    let (methods, snapshot) = {
        let guard = shared.lock().expect("fake herdr state");
        let methods = if guard.model.endpoint_methods.is_empty() {
            vec!["pane.focus".to_owned(), "pane.scroll".to_owned()]
        } else {
            guard.model.endpoint_methods.clone()
        };
        (methods, guard.model.shell_snapshot())
    };
    let welcome = match &parsed {
        Ok(hello)
            if hello.generation == ENDPOINT_PROTOCOL_GENERATION
                && hello
                    .snapshot_codecs
                    .iter()
                    .any(|codec| codec == SNAPSHOT_CODEC_V1)
                && hello
                    .surface_codecs
                    .iter()
                    .any(|codec| codec == SURFACE_CODEC_V1)
                && hello
                    .input_codecs
                    .iter()
                    .any(|codec| codec == INPUT_CODEC_V1)
                && hello.blob_codecs.iter().any(|codec| codec == BLOB_CODEC_V1) =>
        {
            EndpointServerWelcome {
                generation: ENDPOINT_PROTOCOL_GENERATION,
                server_version: herdr_api::HERDR_VERSION.into(),
                snapshot_codec: SNAPSHOT_CODEC_V1.into(),
                surface_codec: SURFACE_CODEC_V1.into(),
                input_codec: INPUT_CODEC_V1.into(),
                blob_codec: BLOB_CODEC_V1.into(),
                methods,
                capabilities: vec![HEALTH_CHECK_CAPABILITY.into()],
                error: None,
            }
        }
        _ => EndpointServerWelcome {
            generation: ENDPOINT_PROTOCOL_GENERATION,
            server_version: herdr_api::HERDR_VERSION.into(),
            snapshot_codec: SNAPSHOT_CODEC_V1.into(),
            surface_codec: SURFACE_CODEC_V1.into(),
            input_codec: INPUT_CODEC_V1.into(),
            blob_codec: BLOB_CODEC_V1.into(),
            methods: Vec::new(),
            capabilities: Vec::new(),
            error: Some(EndpointHandshakeError {
                code: "unsupported_hello".into(),
                message: "the hello is not endpoint generation 1 with its required codecs".into(),
            }),
        },
    };
    let failed = welcome.error.is_some();
    let mut size = parsed
        .as_ref()
        .map(|hello| (hello.surface_size.cols, hello.surface_size.rows))
        .unwrap_or((80, 24));
    let surface_active = parsed
        .as_ref()
        .map(|hello| hello.surface_active)
        .unwrap_or(false);
    let mut focused: Option<String> = None;
    let mut surface_revision = 0u64;
    let mut content_revision = 0u64;
    let surface = |focused: &Option<String>,
                   size: (u16, u16),
                   surface_revision: u64,
                   content_revision: u64|
     -> Vec<u8> {
        // A shell that focused no pane sees the session's focused one.
        let fallback = {
            let guard = shared.lock().expect("fake herdr state");
            guard
                .model
                .panes
                .iter()
                .find(|p| p.focused)
                .or(guard.model.panes.first())
                .map(|p| p.pane_id.clone())
        };
        let Some(pane) = focused.as_ref().or(fallback.as_ref()) else {
            return Vec::new();
        };
        let (screen, projection) = {
            let guard = shared.lock().expect("fake herdr state");
            let terminal = guard
                .model
                .panes
                .iter()
                .find(|p| &p.pane_id == pane)
                .map(|p| p.terminal_id.clone())
                .unwrap_or_default();
            (guard.model.screen(&terminal), guard.model.revision)
        };
        let popup = shared.lock().expect("fake herdr state").model.popup.clone();
        pane_surface(
            pane,
            &screen,
            size,
            projection,
            surface_revision,
            content_revision,
            popup,
        )
    };
    let mut out = wire::endpoint_control(
        ENDPOINT_WELCOME_KIND,
        &serde_json::to_string(&welcome).expect("serialises"),
    );
    if !failed {
        out.extend(wire::endpoint_control(
            ENDPOINT_SNAPSHOT_KIND,
            &serde_json::to_string(&snapshot).expect("serialises"),
        ));
    }
    if write.write_all(&out).await.is_err() || failed {
        return;
    }
    loop {
        tokio::select! {
            payload = read_payload(&mut read) => {
                let Some(payload) = payload else { return };
                let Some(index) = wire::variant(&payload) else { return };
                let reply = match index {
                    wire::variant::ENDPOINT_CONTROL => match wire::decode_two_strings(&payload) {
                        Ok((_, kind, data)) if kind == HEALTH_PING_KIND => {
                            record(&shared, "endpoint.health", Value::Null);
                            wire::endpoint_control(HEALTH_PONG_KIND, &data)
                        }
                        Ok((_, kind, data)) => {
                            record(&shared, &format!("endpoint.control.{kind}"), serde_json::from_str(&data).unwrap_or(Value::String(data)));
                            Vec::new()
                        }
                        Err(_) => Vec::new(),
                    },
                    wire::variant::CLIENT_SHELL_ENDPOINT_REQUEST => match wire::decode_two_strings(&payload) {
                        Ok((_, boot, request)) => {
                            let request: Value = serde_json::from_str(&request).unwrap_or(Value::Null);
                            let id = request.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                            let method = request.get("method").and_then(Value::as_str).unwrap_or("").to_owned();
                            record(&shared, &format!("endpoint.{method}"), request.get("params").cloned().unwrap_or(Value::Null));
                            let answer = {
                                let guard = shared.lock().expect("fake herdr state");
                                guard.model.endpoint_responses.get(&method).cloned()
                            };
                            let body = match answer {
                                Some(value) if value.get("error").is_some() => value,
                                Some(value) => json!({"result": value}),
                                None if boot != BOOT_ID => json!({"error": {"message": "stale boot id"}}),
                                None => json!({"result": {}}),
                            };
                            let mut out = wire::endpoint_response(BOOT_ID, &id, &body.to_string());
                            // Focus scopes the shell's surface to the pane;
                            // a focus or scroll repaints it, as Herdr does.
                            if method == "pane.focus" {
                                focused = request.pointer("/params/pane_id").and_then(Value::as_str).map(str::to_owned);
                            }
                            if surface_active && (method == "pane.focus" || method == "pane.scroll") {
                                surface_revision += 1;
                                out.extend(surface(&focused, size, surface_revision, content_revision));
                            }
                            out
                        }
                        Err(_) => Vec::new(),
                    },
                    wire::variant::CLIENT_SHELL_RESIZE => {
                        match wire::decode_prefix::<(u32, u32, u32, u16, u16, bool)>(&payload) {
                            Ok((_, _, _, cols, rows, _)) => {
                                record(&shared, "endpoint.resize", json!({"cols": cols, "rows": rows}));
                                size = (cols, rows);
                                surface_revision += 1;
                                if surface_active { surface(&focused, size, surface_revision, content_revision) } else { Vec::new() }
                            }
                            Err(_) => Vec::new(),
                        }
                    }
                    wire::variant::CLIENT_SHELL_PANE_INPUT => {
                        let pane = wire::decode_prefix::<(u32, String)>(&payload).map(|(_, pane)| pane).unwrap_or_default();
                        record(&shared, "endpoint.pane_input", json!({"pane_id": pane}));
                        content_revision += 1;
                        surface_revision += 1;
                        if surface_active { surface(&focused, size, surface_revision, content_revision) } else { Vec::new() }
                    }
                    other => {
                        record(&shared, &format!("endpoint.variant_{other}"), Value::Null);
                        Vec::new()
                    }
                };
                if !reply.is_empty() && write.write_all(&reply).await.is_err() {
                    return;
                }
            }
            frame = frames.recv() => match frame {
                // The fake's own commands: close the shell, or repaint it.
                Ok(frame) if frame.is_empty() => return,
                Ok(frame) if frame == REPAINT => {
                    surface_revision += 1;
                    let out = if surface_active { surface(&focused, size, surface_revision, content_revision) } else { Vec::new() };
                    if !out.is_empty() && write.write_all(&out).await.is_err() { return; }
                }
                Ok(frame) => {
                    if write.write_all(&frame).await.is_err() { return; }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(_) => return,
            }
        }
    }
}

#[cfg(unix)]
async fn serve_client(
    listener: tokio::net::UnixListener,
    shared: Arc<Mutex<Shared>>,
    frames: broadcast::Sender<Vec<u8>>,
) {
    while let Ok((mut stream, _)) = listener.accept().await {
        let shared = shared.clone();
        let receiver = frames.subscribe();
        tokio::spawn(async move {
            let Some(payload) = read_payload(&mut stream).await else {
                return;
            };
            let endpoint = shared.lock().expect("fake herdr state").model.endpoint;
            // An endpoint hello: served when the seed says `endpoint: true`;
            // otherwise the legacy Welcome, which tells the client this
            // Herdr predates endpoint generation 1.
            if wire::variant(&payload) == Some(wire::variant::ENDPOINT_CONTROL)
                && let Ok((_, kind, data)) = wire::decode_two_strings(&payload)
                && kind == herdr_api::endpoint::ENDPOINT_HELLO_KIND
                && endpoint
            {
                serve_endpoint(stream, shared, receiver, data).await;
                return;
            }
            let welcome_protocol = shared
                .lock()
                .expect("fake herdr state")
                .model
                .welcome_protocol
                .unwrap_or(wire::PROTOCOL_VERSION);
            // A Herdr before protocol 22 (0.9.0) took the older Hello (the
            // same variant 0, more fields): it answers with its own version.
            let model_protocol = shared.lock().expect("fake herdr state").model.protocol;
            if model_protocol < wire::PROTOCOL_VERSION
                && wire::variant(&payload) == Some(0)
                && let Ok((_, version)) = wire::decode_prefix::<(u32, u32)>(&payload)
            {
                record(&shared, "client.hello", json!({"version": version}));
                let welcome = wire::ServerMessage::Welcome {
                    version: model_protocol,
                    encoding: wire::RenderEncoding::TerminalAnsi,
                    error: (version != model_protocol).then(|| format!("client version {version} does not match server version {model_protocol}")),
                };
                if stream.write_all(&wire::encode(&welcome)).await.is_err() {
                    return;
                }
                let mut sink = [0u8; 4096];
                while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
                return;
            }
            let welcome = match wire::decode::<wire::ClientMessage>(&payload) {
                Ok(wire::ClientMessage::TerminalHello { version, .. })
                    if welcome_protocol != wire::PROTOCOL_VERSION =>
                {
                    let _ = version;
                    wire::ServerMessage::Welcome {
                        version: welcome_protocol,
                        encoding: wire::RenderEncoding::TerminalAnsi,
                        error: None,
                    }
                }
                Ok(wire::ClientMessage::TerminalHello { version, .. }) => {
                    let error = (version != wire::PROTOCOL_VERSION).then(|| {
                        format!(
                            "client version {version} does not match server version {}",
                            wire::PROTOCOL_VERSION
                        )
                    });
                    wire::ServerMessage::Welcome {
                        version: wire::PROTOCOL_VERSION,
                        encoding: wire::RenderEncoding::TerminalAnsi,
                        error,
                    }
                }
                Err(reason) => wire::ServerMessage::Welcome {
                    version: wire::PROTOCOL_VERSION,
                    encoding: wire::RenderEncoding::TerminalAnsi,
                    error: Some(format!("expected a terminal handshake: {reason}")),
                },
            };
            let refused = matches!(
                &welcome,
                wire::ServerMessage::Welcome { error: Some(_), .. }
            );
            if stream.write_all(&wire::encode(&welcome)).await.is_err() || refused {
                // A refused hello: the client reads the error, then leaves.
                let mut sink = [0u8; 4096];
                while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
                return;
            }
            serve_terminal(stream, shared).await;
        });
    }
}

impl FakeHerdr {
    /// Starts the fake on sockets in `dir`.
    #[cfg(unix)]
    pub async fn start(dir: &Path, seed: &HerdrSeed) -> Result<FakeHerdr> {
        std::fs::create_dir_all(dir)?;
        let control = dir.join("herdr.sock");
        let client = dir.join("client.sock");
        let _ = std::fs::remove_file(&control);
        let _ = std::fs::remove_file(&client);
        let model = Model::from_seed(seed)?;
        let shared = Arc::new(Mutex::new(Shared {
            model,
            calls: Vec::new(),
            panes: super::herdr_panes::Panes::default(),
        }));
        let (events, _) = broadcast::channel(1024);
        let (frames, _) = broadcast::channel(256);
        let control_listener = tokio::net::UnixListener::bind(&control)?;
        let client_listener = tokio::net::UnixListener::bind(&client)?;
        let tasks = vec![
            tokio::spawn(serve_control(
                control_listener,
                shared.clone(),
                events.clone(),
            )),
            tokio::spawn(serve_client(
                client_listener,
                shared.clone(),
                frames.clone(),
            )),
        ];
        Ok(FakeHerdr {
            control,
            client,
            shared,
            events,
            frames,
            tasks,
        })
    }

    #[cfg(not(unix))]
    pub async fn start(_dir: &Path, _seed: &HerdrSeed) -> Result<FakeHerdr> {
        bail!("fake herdr: named pipes are not served yet")
    }

    /// Sends an event to every subscription, after checking it is one of
    /// Herdr's event envelopes.
    pub fn emit(&self, event: &Value) -> Result<()> {
        let valid = serde_json::from_value::<EventEnvelope>(event.clone()).is_ok()
            || serde_json::from_value::<SubscriptionEventEnvelope>(event.clone()).is_ok();
        if !valid {
            bail!("not a Herdr event envelope: {event}");
        }
        let _ = self.events.send(line(event));
        Ok(())
    }

    /// Sends a SemanticNotification (ServerMessage variant 14) to every
    /// endpoint client, after checking it is Herdr's type. Kinds and sounds
    /// are Herdr's variant names (`Finished`, `NeedsAttention`, `Done`, ...).
    pub fn notify(&self, notification: &Value) -> Result<()> {
        let notification: herdr_api::endpoint::SemanticNotification =
            serde_json::from_value(notification.clone())
                .context("not a Herdr SemanticNotification")?;
        let frame =
            wire::encode_variant(wire::variant::SERVER_SEMANTIC_NOTIFICATION, &notification);
        if self.frames.send(frame).is_err() {
            bail!("no endpoint client is connected to the fake Herdr");
        }
        Ok(())
    }

    /// Endpoint actions: `{clipboard: <base64>}` sends a Clipboard
    /// message (variant 5), `{popup: {terminal_id, title} | null}` shows or
    /// hides a popup in every shell's next surface (sent now), `{close: true}`
    /// closes every endpoint shell.
    pub fn endpoint_action(&self, action: &Value) -> Result<()> {
        if let Some(data) = action.get("clipboard").and_then(Value::as_str) {
            let _ = self
                .frames
                .send(wire::encode_variant(wire::variant::SERVER_CLIPBOARD, &data));
        }
        if let Some(popup) = action.get("popup") {
            let popup = popup.as_object().map(|popup| {
                (
                    popup
                        .get("terminal_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    popup
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                )
            });
            self.shared.lock().expect("fake herdr state").model.popup = popup;
            let _ = self.frames.send(REPAINT.to_vec());
        }
        if action.get("close").and_then(Value::as_bool) == Some(true) {
            let _ = self.frames.send(Vec::new());
        }
        Ok(())
    }

    /// Replaces the session model (the next answers use it); endpoint
    /// clients get the new snapshot.
    pub fn reseed(&self, seed: &HerdrSeed) -> Result<()> {
        let mut model = Model::from_seed(seed)?;
        let mut guard = self.shared.lock().expect("fake herdr state");
        model.revision = guard.model.revision + 1;
        if model.endpoint {
            let snapshot = serde_json::to_string(&model.shell_snapshot())?;
            let _ = self.frames.send(wire::endpoint_control(
                herdr_api::endpoint::ENDPOINT_SNAPSHOT_KIND,
                &snapshot,
            ));
        }
        guard.model = model;
        let Shared { model, panes, .. } = &mut *guard;
        panes.reset(model);
        Ok(())
    }

    /// Gives the terminal panes their shell (the run's environment and
    /// fakes) and starts their TUIs.
    pub fn attach_shell(&self, shell: super::herdr_panes::Shell) {
        let mut guard = self.shared.lock().expect("fake herdr state");
        let Shared { model, panes, .. } = &mut *guard;
        panes.attach(shell, model);
    }

    pub fn calls(&self) -> Vec<HerdrCall> {
        self.shared.lock().expect("fake herdr state").calls.clone()
    }

    /// Types on the keyboard of a terminal pane's running job.
    pub fn type_into(&self, pane: &str, text: &str) -> Result<()> {
        self.shared
            .lock()
            .expect("fake herdr state")
            .panes
            .type_into(pane, text)
    }

    /// Signals a terminal pane's running job; gives its pid.
    pub fn signal_pane(&self, pane: &str, signal: &str) -> Result<u32> {
        self.shared
            .lock()
            .expect("fake herdr state")
            .panes
            .signal(pane, signal)
    }

    pub fn pane_job_pid(&self, pane: &str) -> Option<u32> {
        self.shared
            .lock()
            .expect("fake herdr state")
            .panes
            .job_pid(pane)
    }
}

impl Drop for FakeHerdr {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
