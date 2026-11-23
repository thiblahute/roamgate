//! server/src/worktree: worktree creation and removal, their hooks and
//! command templates, and parent records.

pub mod command_template;
pub mod create;
pub mod hooks;
pub mod parents;
pub mod paths;
pub mod remove;
pub mod service;
pub mod settings_rpc;

#[cfg(test)]
pub(crate) mod testing;

pub use service::{PlaceCreated, ResolveGitRoot, WORKTREE_METHODS, WorktreeCallbacks, Worktrees};

use std::sync::Arc;

use serde_json::Value;

/// Whether the request a worktree operation serves is still current
/// (`requestIsCurrent`: its connection was not replaced).
pub type Guard = Arc<dyn Fn() -> bool + Send + Sync>;

/// `String(value)` of a JSON value that is not null.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
