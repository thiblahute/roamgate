//! A Herdr workspace's checkouts (workspace/utils.ts), as the worktree
//! code reads them.

use serde_json::Value;

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Herdr's worktree provenance, else the workspace's cwd; empty when
/// neither is known.
pub fn checkout_path(workspace: &Value) -> String {
    text(workspace.pointer("/worktree/checkout_path"))
        .or_else(|| text(workspace.get("cwd")))
        .unwrap_or_default()
        .to_owned()
}

/// The source checkout when Herdr gives it (`repo_root`), else the
/// checkout.
pub fn source_checkout_path(workspace: &Value) -> String {
    text(workspace.pointer("/worktree/repo_root"))
        .map(str::to_owned)
        .unwrap_or_else(|| checkout_path(workspace))
}

/// Whether Herdr says the workspace is a linked worktree.
pub fn is_linked_worktree(workspace: &Value) -> bool {
    workspace.pointer("/worktree/is_linked_worktree") == Some(&Value::Bool(true))
}

/// The non-empty values once each, in order.
pub fn unique_strings<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for value in values.into_iter().flatten() {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// A JS truthy string field.
pub(crate) fn field<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    text(value.pointer(pointer))
}

/// `String(value ?? "")` for an id parameter.
pub(crate) fn id_param(params: &Value, key: &str) -> String {
    match params.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => crate::worktree::js_string(other),
    }
}
