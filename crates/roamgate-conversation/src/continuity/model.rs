//! A work session's data: what is kept of a conversation across the agents
//! that ran it.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Where a switch to another agent is (`HandoffPhase`). One agent writes
/// at a time: `Running`, then `Quiescing` (the outgoing agent is being
/// stopped), `Checkpointed` (it has stopped; what it left is recorded),
/// `StartingReplacement` (the lease names the incoming agent, which is
/// being given the history), and `Running` again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffPhase {
    #[default]
    Running,
    Quiescing,
    Checkpointed,
    StartingReplacement,
}

impl HandoffPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            HandoffPhase::Running => "running",
            HandoffPhase::Quiescing => "quiescing",
            HandoffPhase::Checkpointed => "checkpointed",
            HandoffPhase::StartingReplacement => "starting_replacement",
        }
    }

    pub fn is_switching(self) -> bool {
        self != HandoffPhase::Running
    }
}

/// A message the user sent while the agents were being switched: it goes
/// to the incoming agent, once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedHandoffMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
    pub queued_at: String,
}

/// The switch in progress, if any.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffMachine {
    #[serde(default)]
    pub phase: HandoffPhase,
    /// Counts the switches; a step of an older one is refused.
    #[serde(default)]
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement_execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub queued_during_handoff: Vec<QueuedHandoffMessage>,
}

/// One run of an agent's native session in a work session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentExecution {
    pub id: String,
    /// `"claude"`, `"agy"`.
    pub agent: String,
    pub native_session_id: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// The last event this native session has seen, once it ended (while
    /// it runs, every event is its own or was sent to it).
    pub delivered_through_seq: u64,
    /// Whether resuming this native session and giving it the events it
    /// missed is safe; false (its last turn was cut off, its start was
    /// interrupted): a return to its agent starts a new native session.
    #[serde(default = "default_true")]
    pub resync_safe: bool,
}

fn default_true() -> bool {
    true
}

/// A job Roamgate runs outside the agent (a `!` line): the incoming agent
/// reads its result instead of running it again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalJob {
    pub id: String,
    /// `"shell"`.
    pub kind: String,
    pub label: String,
    /// As the job says: `"running"`, `"done"`, `"failed"`, `"stopped"`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
}

/// What a switch records once the outgoing agent has stopped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableCheckpoint {
    /// Counts the checkpoints.
    pub version: u64,
    /// The last event it covers.
    pub at_seq: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub running_jobs: Vec<ExternalJob>,
}

/// A conversation event, as every agent is told it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CanonicalEventKind {
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    /// A turn's final answer.
    AssistantMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// A tool call that ran: history, never run again.
    ToolRecord {
        tool_call_id: String,
        name: String,
        input_summary: String,
        output_summary: String,
        #[serde(default)]
        is_error: bool,
    },
    BackendSwitch {
        from_agent: String,
        to_agent: String,
        reason: String,
        checkpoint_version: u64,
    },
    /// A tool call a switch cut off: whether it had its effect is unknown.
    UncertainAction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        name: String,
        summary: String,
    },
}

/// One numbered event of a work session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalEvent {
    pub seq: u64,
    pub at: String,
    /// `"user"`, `"roamgate"`, or the agent (`"claude"`, `"agy"`).
    pub actor: String,
    /// What makes a repeat of this event (a user message's id, a tool
    /// call's) the same event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    #[serde(flatten)]
    pub kind: CanonicalEventKind,
}

/// One conversation-mode conversation across the agents that ran it: its
/// numbered events, each agent's native sessions and how far each has
/// seen the events, and the switch in progress.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkSession {
    pub version: u32,
    pub work_session_id: String,
    pub connection_id: String,
    pub pane_id: String,
    pub cwd: String,
    pub created_at: String,
    pub active_agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_execution_id: Option<String>,
    #[serde(default)]
    pub executions: Vec<AgentExecution>,
    #[serde(default)]
    pub checkpoint: PortableCheckpoint,
    #[serde(default)]
    pub handoff: HandoffMachine,
    /// Its events, kept in their own append-only file.
    #[serde(skip)]
    pub events: Vec<CanonicalEvent>,
    #[serde(skip)]
    pub(crate) keys: HashSet<String>,
}

impl WorkSession {
    pub fn latest_seq(&self) -> u64 {
        self.events.last().map_or(0, |e| e.seq)
    }

    pub fn active_execution(&self) -> Option<&AgentExecution> {
        let id = self.active_execution_id.as_deref()?;
        self.executions.iter().find(|e| e.id == id)
    }

    pub fn active_execution_mut(&mut self) -> Option<&mut AgentExecution> {
        let id = self.active_execution_id.clone()?;
        self.executions.iter_mut().find(|e| e.id == id)
    }

    /// The agent's latest ended native session that can be resumed and
    /// given what it missed, if any.
    pub fn latest_resyncable_execution(&self, agent: &str) -> Option<&AgentExecution> {
        self.executions.iter().rev().find(|exec| {
            exec.agent == agent
                && exec.resync_safe
                && exec.ended_at.is_some()
                && !exec.native_session_id.is_empty()
                && exec.native_session_id != crate::driver::UNNAMED_SESSION_ID
        })
    }

    /// The first thing the user asked.
    pub fn goal(&self) -> Option<&str> {
        self.events.iter().find_map(|event| match &event.kind {
            CanonicalEventKind::UserMessage { text, .. } if !text.trim().is_empty() => {
                Some(text.trim())
            }
            _ => None,
        })
    }

    /// What a switch's cut off, so far.
    pub fn uncertain_actions(&self) -> impl Iterator<Item = &str> {
        self.events.iter().filter_map(|event| match &event.kind {
            CanonicalEventKind::UncertainAction { summary, .. } => Some(summary.as_str()),
            _ => None,
        })
    }
}
