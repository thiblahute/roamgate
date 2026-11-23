//! What the agent socket asks of the rest of Roamgate (createReviewAgentServer's
//! arguments besides the review service and the Claude mod's hub): the
//! connections and their checkouts, and the families Bun still owns while
//! review moves (the Workspaces tree, the boards, notifications, the agent
//! messenger, conversation mode's holder and claude start, prepared
//! launches). The core's review family answers each by a reverse call;
//! every one is optional as the TS arguments are.

use serde_json::Value;

use crate::service::BoxFut;

/// A failure of what the host was asked, with what the socket answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub message: String,
    /// The HTTP status to answer, when the host says (the agent messenger's
    /// errors, a ReviewError).
    pub status: Option<u16>,
    /// A code, as `not_found` for the boards.
    pub code: Option<String>,
}

impl HostError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            code: None,
        }
    }

    pub fn status(message: impl Into<String>, status: u16) -> Self {
        Self {
            status: Some(status),
            ..Self::new(message)
        }
    }
}

pub type HostAsk<T> = BoxFut<Result<T, HostError>>;

/// What the agent socket needs to know of a ready connection
/// (ReviewAgentConnection).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentConnection {
    pub id: String,
    /// The Herdr socket, for telling local connections apart.
    pub herdr_socket_path: Option<String>,
    pub ssh_host: Option<String>,
    /// Whether it keeps workspaces' last steps (`readLastStep`).
    pub last_steps: bool,
}

/// What the host serves of what is optional (the TS arguments that may be
/// left out); what it does not serve is refused as the TS server refuses it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostFeatures {
    pub notify: bool,
    pub workspaces: bool,
    pub reviews: bool,
    pub work: bool,
    pub messages: bool,
    pub claude_start: bool,
    /// Conversation mode's holder (`hold`, `handback`, `hold_output`, `fg`).
    pub holder: bool,
}

fn unavailable<T: Send + 'static>() -> HostAsk<T> {
    Box::pin(async { Err(HostError::status("unavailable", 503)) })
}

/// Inputs carry the TS argument objects' fields (camelCase), so the Bun side
/// of a reverse call hands them on unchanged.
pub trait AgentSocketHost: Send + Sync + 'static {
    /// What of the optional parts this host serves.
    fn features(&self) -> HostFeatures {
        HostFeatures::default()
    }
    /// The ready connections.
    fn connections(&self) -> HostAsk<Vec<AgentConnection>>;
    /// The checkout holding `path` on the connection's host.
    fn read_root(&self, connection_id: &str, path: &str) -> HostAsk<String>;
    /// The checkout's default base (Automatic's).
    fn read_default_base(&self, connection_id: &str, root: &str) -> HostAsk<String>;
    /// The workspace's last step in the checkout, as review target JSON; None
    /// when none is known. Asked only of a connection with `last_steps`.
    fn read_last_step(
        &self,
        _connection_id: &str,
        _root: &str,
        _workspace_id: &str,
    ) -> HostAsk<Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    /// Whether any browser could answer a permission prompt now (None: not
    /// known, asked as if one could).
    fn has_viewers(&self) -> HostAsk<Option<bool>> {
        Box::pin(async { Ok(None) })
    }
    /// An agent telling the user they need to act: `{connectionId, paneId,
    /// agent, title?, text}`.
    fn notify(&self, _input: Value) -> HostAsk<()> {
        unavailable()
    }
    /// Workspaces an agent makes or starts work in: `{connectionId, paneId,
    /// workspaceId, command, params}`.
    fn workspaces(&self, _input: Value) -> HostAsk<Value> {
        unavailable()
    }
    /// The Reviews board's tools: `{connectionId, paneId, workspaceId, agent,
    /// tool, params}`, answering the tool's text.
    fn reviews(&self, _input: Value) -> HostAsk<String> {
        unavailable()
    }
    /// The Work board's tools, as `reviews`.
    fn work(&self, _input: Value) -> HostAsk<String> {
        unavailable()
    }
    /// The agent sessions Roamgate manages, across connections.
    fn messages_list(&self) -> HostAsk<Vec<Value>> {
        unavailable()
    }
    /// A message to another session: `{from: {connectionId, paneId}, to,
    /// text}`.
    fn messages_send(&self, _input: Value) -> HostAsk<Value> {
        unavailable()
    }
    /// A claude the user just started in a pane: `{connectionId, paneId,
    /// sessionId, source}`.
    fn claude_start(&self, _input: Value) -> HostAsk<Value> {
        unavailable()
    }
    /// A start prepared for a pane (roamgate-hold --launch), taken once:
    /// `{connectionId, paneId, token}`; None when there is none.
    fn launch(&self, _input: Value) -> HostAsk<Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    /// `hold`: `{connectionId, paneId, sessionId, form}` (the holder's
    /// status and shell are read from `form` where conversation mode is).
    fn holder_hold(&self, _input: Value) -> HostAsk<Value> {
        Box::pin(async { Err(HostError::status("conversation mode is unavailable", 503)) })
    }
    /// `hold_output`: `{connectionId, paneId, holderId, offset, end, data}`.
    fn holder_output(&self, _input: Value) -> HostAsk<Value> {
        Box::pin(async { Err(HostError::status("conversation mode is unavailable", 503)) })
    }
    /// `handback`: `{connectionId, paneId, sessionId}`.
    fn holder_handback(&self, _input: Value) -> HostAsk<Value> {
        Box::pin(async { Err(HostError::status("conversation mode is unavailable", 503)) })
    }
    /// `fg`: `{connectionId, paneId, form}`; an error with status 400 for a
    /// form naming no stopped session.
    fn holder_fg(&self, _input: Value) -> HostAsk<Value> {
        Box::pin(async {
            Ok(serde_json::json!({"action": "refused", "reason": "fg is unavailable here"}))
        })
    }
}
