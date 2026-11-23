//! What the review service asks of the rest of the server (the arguments
//! of `createReviewService`): the checkout's git reads, the agent panes and
//! sessions, the Claude mod's word on a pane, and the forge. Each is
//! optional as it is in TS; the core's family adapter answers them with
//! reverse calls into what Bun still owns.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::Value;

use crate::error::ReviewError;
use crate::model::{ReviewAnchor, ReviewComment, ReviewCommit, ReviewSession, ReviewThread};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Why a read of the checkout failed.
#[derive(Debug, Clone, PartialEq)]
pub enum LoadError {
    /// Its checkout, or a commit of its range, is gone (ReviewGoneError):
    /// `checkout-gone`, `base-gone` or `head-gone`.
    Gone {
        code: String,
        message: String,
    },
    Failed(String),
}

impl LoadError {
    pub fn message(&self) -> &str {
        match self {
            Self::Gone { message, .. } | Self::Failed(message) => message,
        }
    }
}

impl From<LoadError> for ReviewError {
    fn from(error: LoadError) -> Self {
        match error {
            LoadError::Gone { code, message } => ReviewError {
                message,
                status: 410,
                code: Some(code),
            },
            LoadError::Failed(message) => ReviewError {
                message,
                status: 500,
                code: None,
            },
        }
    }
}

pub type Load<T> = BoxFut<Result<T, LoadError>>;
pub type Ask<T> = BoxFut<Result<T, String>>;

///
/// A read only builds its future: the service learns whether the host has
/// a read (TS's `if (!loadCommits)`) by calling it and dropping what it
/// answers unpolled, so nothing may happen before the future is polled.
#[allow(unused_variables)]
pub trait ReviewHost: Send + Sync + 'static {
    /// The review's diff, or one commit's; with `paths`, only those files,
    /// whole. A `ReviewDiff` as JSON.
    fn load_diff(
        &self,
        session: &ReviewSession,
        commit: Option<String>,
        paths: Option<Vec<String>>,
    ) -> Load<Value>;
    /// The files without patches (`ReviewDiff.summary`).
    fn load_summary(&self, session: &ReviewSession, commit: Option<String>) -> Option<Load<Value>> {
        None
    }
    /// These files' patches between a summary's two commits.
    fn load_files(
        &self,
        session: &ReviewSession,
        base: String,
        head: String,
        files: Vec<Value>,
    ) -> Option<Load<Value>> {
        None
    }
    fn load_commits(&self, session: &ReviewSession) -> Option<Load<Vec<ReviewCommit>>> {
        None
    }
    fn load_patch_ids(
        &self,
        session: &ReviewSession,
        shas: Vec<String>,
    ) -> Option<Load<IndexMap<String, String>>> {
        None
    }
    fn load_state(&self, session: &ReviewSession) -> Option<Load<String>> {
        None
    }
    /// The commits these refs name in their checkouts (`null`: none).
    fn load_heads(
        &self,
        connection_id: &str,
        entries: Vec<(String, String)>,
    ) -> Option<Load<Vec<Option<String>>>> {
        None
    }
    fn load_file(
        &self,
        session: &ReviewSession,
        rev: String,
        path: String,
    ) -> Option<Load<String>> {
        None
    }
    /// Whether comments can be typed into agents' panes at all.
    fn can_prompt(&self) -> bool {
        false
    }
    fn prompt_agent(&self, connection_id: &str, pane_id: &str, text: String) -> Ask<()> {
        Box::pin(async { Err("comments cannot be sent to agents here".to_owned()) })
    }
    /// The pane an agent session runs in now (`None` inside: none).
    fn session_pane(&self, connection_id: &str, session_id: &str) -> Option<Ask<Option<String>>> {
        None
    }
    /// The agent session a pane runs now.
    fn pane_session(&self, connection_id: &str, pane_id: &str) -> Option<Ask<Option<String>>> {
        None
    }
    /// Whether agents on the connection's host can run the review client
    /// (`None`: not told, taken as yes).
    fn agent_channel(&self, connection_id: &str) -> Option<bool> {
        None
    }
    fn agent_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        false
    }
    fn agent_work_tools(&self, connection_id: &str, pane_id: &str) -> bool {
        false
    }
    fn agent_rules(&self, connection_id: &str, pane_id: &str) -> bool {
        false
    }
    fn agent_compacted_since(
        &self,
        connection_id: &str,
        pane_id: &str,
        since: &str,
    ) -> Option<Ask<bool>> {
        None
    }
    fn chat_reply_how(&self, session: &ReviewSession) -> Option<String> {
        None
    }
    fn on_delivery_error(&self, session: &ReviewSession, reason: &str) {}
    /// The turn a prompt starts is the user's doing (voice/turn-causes.ts).
    fn note_cause(&self, connection_id: &str, pane_id: &str) {}
    /// The forge layer, when merge requests can be reviewed here.
    fn forge(&self) -> Option<Arc<dyn ReviewForge>> {
        None
    }
}

/// A merge request's forge (GitLab or GitHub), as the review service uses
/// it: what it builds (draft threads, draft replies) comes back built.
#[allow(unused_variables)]
pub trait ReviewForge: Send + Sync + 'static {
    /// The checkout's branch and what finding its merge request needs
    /// (`ReviewCheckout`: `branch`, `head`...).
    fn checkout(&self, session: &ReviewSession) -> Load<Value>;
    /// The open merge request of the checkout's branch (`BranchMergeRequest`).
    fn find(&self, session: &ReviewSession, checkout: Value) -> Ask<Option<Value>>;
    /// `MergeRequestInfo`.
    fn read_merge_request(&self, session: &ReviewSession, url: &str) -> Ask<Value>;
    fn read_threads(&self, session: &ReviewSession, mr: &Value) -> Ask<Vec<ReviewThread>>;
    /// A draft note, as its thread (draftThread).
    fn create_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        anchor: ReviewAnchor,
        note: String,
        diff: Option<Value>,
    ) -> Ask<ReviewThread>;
    fn update_draft_note(
        &self,
        session: &ReviewSession,
        mr: &Value,
        id: i64,
        note: String,
    ) -> Ask<ReviewThread>;
    fn delete_draft_note(&self, session: &ReviewSession, mr: &Value, id: i64) -> Ask<()>;
    /// A draft reply in a discussion, as its comment (draftReply).
    fn create_draft_reply(
        &self,
        session: &ReviewSession,
        mr: &Value,
        discussion: &str,
        note: String,
    ) -> Ask<ReviewComment>;
}
