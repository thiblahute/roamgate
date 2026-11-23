//! The board's types (shared/work.ts), serialised as the TS server writes
//! them: camelCase fields, optional ones left out, in the order the store
//! reads an item back (`normalItem`).

use serde::Serialize;
use serde_json::Value;

pub const WORK_STATES: [&str; 5] = ["you", "doing", "verify", "open", "done"];
/// Every state but done.
pub const WORK_OPEN_STATES: [&str; 4] = ["you", "doing", "verify", "open"];
/// The states whose items say what the user has to do (`ask`).
pub const WORK_ASK_STATES: [&str; 2] = ["you", "verify"];
/// The states a landing makes done by itself.
pub const WORK_LANDING_DONE_STATES: [&str; 2] = ["doing", "open"];

pub const WORK_LINK_KINDS: [&str; 10] = [
    "review", "effort", "pr", "commit", "branch", "decision", "file", "item", "deploy", "chat",
];

/// WORK_LIMITS.
pub mod limits {
    pub const ITEMS: usize = 2000;
    pub const PROJECTS: usize = 50;
    pub const TITLE_CHARS: usize = 300;
    pub const TAG_CHARS: usize = 40;
    pub const TAGS_PER_ITEM: usize = 12;
    pub const LINKS_PER_ITEM: usize = 30;
    pub const ASK_CHARS: usize = 400;
    pub const ANSWERS: usize = 6;
    pub const ANSWER_CHARS: usize = 80;
}

/// REVIEW_USER: the user's name as a review comment's author.
pub const REVIEW_USER: &str = "you";
/// A work item's review session ids start with this.
pub const WORK_SESSION_PREFIX: &str = "work:";
/// REVIEW_LIMITS.descriptionChars: the longest description.
pub const WORK_DESCRIPTION_CHARS: usize = 200_000;

pub fn is_work_state(value: &str) -> bool {
    WORK_STATES.contains(&value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkRoot {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkDoneRule {
    Deployed,
    Branch {
        root: String,
        branch: String,
        #[serde(rename = "connectionId", skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkCoordinator {
    pub session: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkProject {
    pub id: String,
    pub name: String,
    pub roots: Vec<WorkRoot>,
    pub done: WorkDoneRule,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinator: Option<WorkCoordinator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkOwner {
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkLink {
    Review {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        thread: Option<String>,
    },
    Effort {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        part: Option<String>,
    },
    Pr {
        url: String,
    },
    Commit {
        sha: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    Branch {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    Decision {
        path: String,
        id: String,
    },
    File {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Item {
        id: String,
    },
    Deploy {
        sha: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    Chat {
        session: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entry: Option<String>,
    },
}

impl WorkLink {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Review { .. } => "review",
            Self::Effort { .. } => "effort",
            Self::Pr { .. } => "pr",
            Self::Commit { .. } => "commit",
            Self::Branch { .. } => "branch",
            Self::Decision { .. } => "decision",
            Self::File { .. } => "file",
            Self::Item { .. } => "item",
            Self::Deploy { .. } => "deploy",
            Self::Chat { .. } => "chat",
        }
    }

    /// The link as JSON.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("a link serialises")
    }

    /// Its own root, for the kinds that have one.
    pub fn root(&self) -> Option<&str> {
        match self {
            Self::Commit { root, .. } | Self::Branch { root, .. } | Self::File { root, .. } => {
                root.as_deref()
            }
            _ => None,
        }
    }

    /// The link with `root` set (commit, branch and file links).
    pub fn with_root(&self, path: &str) -> Self {
        let mut out = self.clone();
        match &mut out {
            Self::Commit { root, .. } | Self::Branch { root, .. } | Self::File { root, .. } => {
                *root = Some(path.to_owned());
            }
            _ => {}
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum By {
    User,
    Agent,
}

impl By {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub project: String,
    pub title: String,
    pub state: String,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<WorkOwner>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub links: Vec<WorkLink>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_at: Option<String>,
    pub by: By,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub needs_triage: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<u64>,
}

impl WorkItem {
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("an item serialises")
    }
}

/// What the server pushes to every page when the board changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkPush {
    pub changed: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    pub by: By,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// A review session, as the board reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewSession {
    pub id: String,
    pub connection_id: String,
    pub root: String,
    pub target: Value,
}

impl ReviewSession {
    pub fn target_kind(&self) -> &str {
        self.target
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
    }

    /// The item of a `work` target.
    pub fn target_item(&self) -> Option<&str> {
        (self.target_kind() == "work")
            .then(|| self.target.get("item").and_then(Value::as_str))
            .flatten()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewThread {
    pub id: String,
    pub session_id: String,
    pub anchor: Value,
    pub comments: Vec<ReviewComment>,
    pub resolved: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl ReviewThread {
    /// `anchor.work.<key>`.
    pub fn work(&self, key: &str) -> Option<&Value> {
        self.anchor.get("work")?.get(key)
    }

    /// `anchor.message.<key>`.
    pub fn message(&self, key: &str) -> Option<&Value> {
        self.anchor.get("message")?.get(key)
    }

    fn truthy(value: Option<&Value>) -> bool {
        match value {
            None | Some(Value::Null) | Some(Value::Bool(false)) => false,
            Some(Value::String(text)) => !text.is_empty(),
            Some(_) => true,
        }
    }

    pub fn is_description(&self) -> bool {
        Self::truthy(self.work("description"))
    }

    pub fn has_work(&self) -> bool {
        self.anchor.get("work").is_some_and(|work| !work.is_null())
    }

    pub fn work_truthy(&self, key: &str) -> bool {
        Self::truthy(self.work(key))
    }
}

#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize)]
#[serde(default)]
pub struct ReviewSnapshot {
    pub session: ReviewSession,
    pub threads: Vec<ReviewThread>,
    /// The snapshot as the review service gave it (`bridge.work.threads`
    /// answers it whole).
    #[serde(skip)]
    pub raw: Value,
}

impl ReviewSnapshot {
    /// A snapshot as the review service writes it.
    pub fn from_value(value: Value) -> Option<Self> {
        let mut snapshot: Self = serde_json::from_value(value.clone()).ok()?;
        snapshot.raw = value;
        Some(snapshot)
    }
}

impl ReviewThread {
    pub fn from_value(value: Value) -> Option<Self> {
        serde_json::from_value(value).ok()
    }
}

impl ReviewSession {
    pub fn from_value(value: Value) -> Option<Self> {
        serde_json::from_value(value).ok()
    }
}
