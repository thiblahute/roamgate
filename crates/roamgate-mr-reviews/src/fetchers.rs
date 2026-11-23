//! How the inbox asks the forges (`mr-reviews/fetchers.ts`): on the
//! bridge's machine with the user's own glab and gh logins, every call
//! through the forge gate (its per-host budget, queue and rate-limit
//! pauses), feature `inbox`. Reads only.
//!
//! [`InboxFetchers`] is what the inbox, pins and the reviews agent's
//! searches ask. Its glab and gh implementation (`createInboxFetchers`)
//! sits on review/gitlab.ts's `glab` and review/forge.ts's `ghHostLogin`,
//! which are the review module's: until they are Rust's, the core answers
//! it with reverse calls to Bun, as [`crate::connection::MrConnection`]
//! does for host effects.

use std::fmt;

use roamgate_agents::js::Obj;
use serde_json::Value;

use crate::connection::BoxFuture;

/// Who asks, for the gate's log and budget: the inbox by default, the
/// reviews agent's searches as `reviews-agent`; `reuse_ms` shares an
/// identical query's answer that long.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchCall {
    pub feature: String,
    pub kind: String,
    pub reuse_ms: Option<u64>,
}

impl FetchCall {
    pub fn new(feature: &str, kind: &str) -> FetchCall {
        FetchCall {
            feature: feature.into(),
            kind: kind.into(),
            reuse_ms: None,
        }
    }

    /// `INBOX_CALL`: the inbox's own lists.
    pub fn inbox() -> FetchCall {
        FetchCall::new("inbox", "inbox")
    }

    /// `{feature, kind, reuseMs?}`, as the gate takes it.
    pub fn to_json(&self) -> Value {
        let mut out = Obj::new();
        out.insert("feature".into(), self.feature.clone().into());
        out.insert("kind".into(), self.kind.clone().into());
        if let Some(reuse) = self.reuse_ms.filter(|ms| *ms > 0) {
            out.insert("reuseMs".into(), reuse.into());
        }
        Value::Object(out)
    }
}

/// A failed forge read: `NotSignedInError`, `ForgeToolMissingError`, or
/// any other error (its message).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The host has no login here ("Not signed in to <host> (...)").
    NotSignedIn(String),
    /// glab or gh is not installed.
    ToolMissing(String),
    Failed(String),
}

impl FetchError {
    pub fn message(&self) -> &str {
        match self {
            FetchError::NotSignedIn(m) | FetchError::ToolMissing(m) | FetchError::Failed(m) => m,
        }
    }

    /// The host state a failed inbox read gives: `not_signed_in`,
    /// `unavailable` or `error`.
    pub fn host_state(&self) -> &'static str {
        match self {
            FetchError::NotSignedIn(_) => "not_signed_in",
            FetchError::ToolMissing(_) => "unavailable",
            FetchError::Failed(_) => "error",
        }
    }

    /// From a reverse call's answer error: `{kind?, message}` where kind is
    /// `not_signed_in` or `tool_missing`.
    pub fn from_json(value: &Value) -> FetchError {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the request failed")
            .to_owned();
        match value.get("kind").and_then(Value::as_str) {
            Some("not_signed_in") => FetchError::NotSignedIn(message),
            Some("tool_missing") => FetchError::ToolMissing(message),
            _ => FetchError::Failed(message),
        }
    }
}

impl fmt::Display for FetchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl From<String> for FetchError {
    fn from(message: String) -> FetchError {
        FetchError::Failed(message)
    }
}

pub type FetchResult<T> = Result<T, FetchError>;

/// The forge reads of the inbox (`InboxFetchers`).
pub trait InboxFetchers: Send + Sync {
    /// A GraphQL query to a GitLab host; NotSignedIn when it has no login here.
    fn gitlab<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>>;
    /// A GraphQL query to a GitHub host (its data even with errors).
    fn github<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>>;
    /// The user's pending draft notes on a GitLab merge request.
    fn gitlab_drafts<'a>(&'a self, item: &'a Obj) -> BoxFuture<'a, FetchResult<usize>>;
    /// When each label of a GitLab merge request was last added (section
    /// 15); None when these fetchers cannot say.
    fn gitlab_label_events<'a>(&'a self, item: &'a Obj) -> Option<BoxFuture<'a, FetchResult<Obj>>> {
        let _ = item;
        None
    }
}
