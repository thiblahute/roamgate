//! Which workspace a linked worktree was made from (worktree/parents.ts):
//! GUI metadata Herdr does not keep, recorded in settings.json's
//! `custom.worktree_parent_by_checkout` by checkout key and checked
//! against Herdr's current list before it is shown.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use roamgate_base::settings::{Settings, repo_settings_key};
use serde_json::{Map, Value, json};

use crate::connection::WorkspaceConnection;
use crate::worktree::Guard;
use crate::worktree::hooks::js_truthy;
use crate::worktree::paths::field;

const CUSTOM_SETTINGS_KEY: &str = "worktree_parent_by_checkout";

/// The error of a write abandoned because its request is no longer current.
pub const SETTINGS_UPDATE_CANCELLED: &str = "settings update cancelled";

fn checkout_path(workspace: &Value) -> Option<&str> {
    field(workspace, "/worktree/checkout_path")
        .or_else(|| field(workspace, "/worktree/path"))
        .or_else(|| field(workspace, "/checkout_path"))
        .or_else(|| field(workspace, "/path"))
}

fn parent_records(settings: &Settings) -> Map<String, Value> {
    let Some(Value::Object(raw)) = settings
        .custom()
        .and_then(|custom| custom.get(CUSTOM_SETTINGS_KEY))
    else {
        return Map::new();
    };
    raw.iter()
        .filter(|(_, value)| value.as_str().is_some_and(|text| !text.is_empty()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn with_parent_records(settings: &Settings, records: Map<String, Value>) -> Value {
    let mut custom = settings
        .custom()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    custom.insert(CUSTOM_SETTINGS_KEY.into(), Value::Object(records));
    settings.with("custom", Some(Value::Object(custom)))
}

/// Gives each linked worktree of Herdr's list the parent recorded for it,
/// when that parent is still the main checkout of the same repository.
pub fn attach_worktree_parents(
    result: &Value,
    settings: &Settings,
    host: Option<&str>,
    connection_id: Option<&str>,
) -> Value {
    let Some(workspaces) = result.get("workspaces").and_then(Value::as_array) else {
        return result.clone();
    };
    let records = parent_records(settings);
    let by_id: HashMap<String, usize> = workspaces
        .iter()
        .enumerate()
        .map(|(index, workspace)| {
            let id = match workspace.get("workspace_id") {
                None | Some(Value::Null) => String::new(),
                Some(value) => crate::worktree::js_string(value),
            };
            (id, index)
        })
        .collect();
    let attached: Vec<Value> = workspaces
        .iter()
        .enumerate()
        .map(|(index, workspace)| {
            if !workspace
                .pointer("/worktree/is_linked_worktree")
                .is_some_and(js_truthy)
            {
                return workspace.clone();
            }
            let Some(path) = checkout_path(workspace) else {
                return workspace.clone();
            };
            let Some(parent_id) = records
                .get(&repo_settings_key(path, host, connection_id))
                .and_then(Value::as_str)
            else {
                return workspace.clone();
            };
            let Some(&parent_at) = by_id.get(parent_id) else {
                return workspace.clone();
            };
            let parent = &workspaces[parent_at];
            let matches = parent_at != index
                && parent.pointer("/worktree/is_linked_worktree") == Some(&Value::Bool(false))
                && parent.pointer("/worktree/repo_key") == workspace.pointer("/worktree/repo_key");
            if !matches {
                return workspace.clone();
            }
            let mut workspace = workspace.clone();
            if let Some(Value::Object(worktree)) = workspace.get_mut("worktree") {
                worktree.insert("parent_workspace_id".into(), parent_id.into());
            }
            workspace
        })
        .collect();
    let mut out = result.clone();
    out["workspaces"] = Value::Array(attached);
    out
}

/// The parent store of a connection (`createWorktreeParentStore`).
#[derive(Debug, Clone, Default)]
pub struct WorktreeParents;

/// Writes settings.json unless `is_current` turned false by the time the
/// writer's slot runs the change; an abandoned write is the error
/// `settings update cancelled`, as the TS store's.
pub(crate) async fn update_if_current(
    conn: &WorkspaceConnection,
    is_current: &Guard,
    change: impl FnOnce(&Settings) -> Option<Value> + Send + 'static,
) -> Result<Arc<Settings>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (flag, guard) = (cancelled.clone(), is_current.clone());
    let settings = conn
        .settings
        .update(Box::new(move |settings| {
            if !guard() {
                flag.store(true, Ordering::SeqCst);
                return None;
            }
            change(settings)
        }))
        .await?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(SETTINGS_UPDATE_CANCELLED.into());
    }
    Ok(settings)
}

impl WorktreeParents {
    async fn resolve_worktree_workspace(
        conn: &WorkspaceConnection,
        result: &Value,
    ) -> Option<Value> {
        let direct = result.get("workspace").filter(|value| js_truthy(value));
        if let Some(direct) = direct
            && direct.get("worktree").is_some_and(js_truthy)
        {
            return Some(direct.clone());
        }
        let workspace_id = direct
            .and_then(|direct| direct.get("workspace_id"))
            .filter(|value| !value.is_null())
            .or_else(|| result.get("workspace_id").filter(|value| !value.is_null()))
            .or_else(|| {
                result
                    .pointer("/worktree/workspace_id")
                    .filter(|value| !value.is_null())
            })
            .or_else(|| {
                result
                    .pointer("/worktree/open_workspace_id")
                    .filter(|value| !value.is_null())
            });
        if let Some(id) = workspace_id.filter(|value| js_truthy(value))
            && let Ok(found) = conn
                .herdr_call(
                    "workspace.get",
                    json!({ "workspace_id": crate::worktree::js_string(id) }),
                    None,
                )
                .await
            && let Some(workspace) = found.get("workspace").filter(|value| js_truthy(value))
        {
            return Some(workspace.clone());
        }
        let worktree = result.get("worktree").filter(|value| js_truthy(value));
        let path = checkout_path(worktree.unwrap_or(result))?.to_owned();
        let listed = conn
            .herdr_call("workspace.list", json!({}), None)
            .await
            .ok();
        listed
            .as_ref()
            .and_then(|list| list.get("workspaces"))
            .and_then(Value::as_array)
            .and_then(|workspaces| {
                workspaces
                    .iter()
                    .find(|workspace| checkout_path(workspace) == Some(path.as_str()))
                    .cloned()
            })
            .or_else(|| direct.cloned())
    }

    /// Records `parent_workspace_id` as the parent of the linked worktree
    /// Herdr's `result` describes.
    pub async fn remember_worktree_parent(
        &self,
        conn: &WorkspaceConnection,
        result: &Value,
        parent_workspace_id: &str,
        is_current: &Guard,
    ) -> Result<(), String> {
        if !is_current() {
            return Ok(());
        }
        let workspace = Self::resolve_worktree_workspace(conn, result).await;
        if !is_current() {
            return Ok(());
        }
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let Some(path) = checkout_path(&workspace) else {
            return Ok(());
        };
        if parent_workspace_id.is_empty()
            || workspace.get("workspace_id").and_then(Value::as_str) == Some(parent_workspace_id)
            || workspace.pointer("/worktree/is_linked_worktree") != Some(&Value::Bool(true))
        {
            return Ok(());
        }
        let key = repo_settings_key(path, conn.ssh_host(), Some(&conn.id));
        let parent = parent_workspace_id.to_owned();
        update_if_current(conn, is_current, move |settings| {
            let mut records = parent_records(settings);
            records.insert(key, parent.into());
            Some(with_parent_records(settings, records))
        })
        .await
        .map(|_| ())
    }

    /// Forgets the parent of the checkout at `path`.
    pub async fn forget_worktree(
        &self,
        conn: &WorkspaceConnection,
        path: &str,
        is_current: &Guard,
    ) -> Result<(), String> {
        if path.is_empty() || !is_current() {
            return Ok(());
        }
        let key = repo_settings_key(path, conn.ssh_host(), Some(&conn.id));
        update_if_current(conn, is_current, move |settings| {
            let mut records = parent_records(settings);
            records.remove(&key)?;
            Some(with_parent_records(settings, records))
        })
        .await
        .map(|_| ())
    }

    /// Herdr's `workspace.list` answer with the recorded parents.
    pub async fn enrich_workspace_list(&self, conn: &WorkspaceConnection, result: Value) -> Value {
        let settings = conn.settings.read().await;
        attach_worktree_parents(&result, &settings, conn.ssh_host(), Some(&conn.id))
    }
}

#[cfg(test)]
mod tests;
