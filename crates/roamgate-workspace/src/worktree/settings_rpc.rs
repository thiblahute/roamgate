//! The worktree settings of bridge/settings-rpc.ts, which move with the
//! workspace family: `settings.worktree_directory.get`,
//! `settings.worktree_hooks.get`, `settings.update_repo` and
//! `settings.worktree_command.update`. settings.json is written only
//! through the connection's [`SettingsAccess`](crate::connection::SettingsAccess).

use roamgate_base::settings::{
    Settings, WORKTREE_COMMAND_MAX_LENGTH, connection_settings_prefix, js_trim,
    normalize_worktree_command, normalize_worktree_directory,
};
use serde_json::{Map, Value, json};

use crate::connection::{RpcResult, WorkspaceConnection, WorkspaceError};
use crate::worktree::command_template::worktree_command_template_error;
use crate::worktree::create::resolve_repo_settings_key;
use crate::worktree::hooks::{HookRunner, ReadHooksError, js_truthy};
use crate::worktree::parents::update_if_current;
use crate::worktree::paths::{checkout_path, id_param, source_checkout_path};
use crate::worktree::{Guard, WorktreeCallbacks, js_string};

/// The browser RPCs of this module.
pub const METHODS: [&str; 4] = [
    "settings.worktree_directory.get",
    "settings.worktree_hooks.get",
    "settings.update_repo",
    "settings.worktree_command.update",
];

/// The error of a request whose connection was replaced meanwhile.
pub const CONNECTION_CHANGED_DURING_REQUEST: &str = "connection changed during request";

fn invalid_worktree_command() -> String {
    format!(
        "worktree_command must be at most {WORKTREE_COMMAND_MAX_LENGTH} characters without NUL bytes"
    )
}

/// The refusal of a worktree command template, if any.
fn worktree_command_refusal(raw: &str, command: Option<&str>) -> Option<String> {
    if !raw.is_empty() && command.is_none() {
        return Some(invalid_worktree_command());
    }
    command.and_then(worktree_command_template_error)
}

/// `String(value ?? "").trim()`.
fn raw_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&js_string(value)).to_owned(),
    }
}

fn repositories(settings: &Settings) -> Map<String, Value> {
    settings
        .get("repositories")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn repo_field(settings: &Settings, key: Option<&str>, field: &str) -> Value {
    key.and_then(|key| settings.get("repositories")?.get(key)?.get(field).cloned())
        .unwrap_or(Value::Null)
}

/// The key worktree creation uses: git names the repository when Herdr
/// does not, so the dialogs show and save what creation applies.
async fn repo_settings_key(
    conn: &WorkspaceConnection,
    callbacks: &WorktreeCallbacks,
    workspace_id: &str,
    workspace: &Value,
) -> Option<String> {
    let reported = workspace
        .pointer("/worktree/repo_key")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty());
    let root = if reported {
        None
    } else {
        (callbacks.resolve_git_root)(workspace_id.to_owned())
            .await
            .ok()
    };
    let settings = conn.settings.read().await;
    resolve_repo_settings_key(
        Some(workspace),
        root.as_deref(),
        Some(&conn.id),
        &settings,
        &conn.git,
    )
    .await
    .0
}

async fn repo_settings_reply(conn: &WorkspaceConnection, key: Option<&str>) -> Map<String, Value> {
    let settings = conn.settings.read().await;
    let top = |field: &str| settings.get(field).cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert(
        "enabled".into(),
        (repo_field(&settings, key, "worktree_hooks_enabled") != Value::Bool(false)).into(),
    );
    out.insert(
        "worktree_directory".into(),
        repo_field(&settings, key, "worktree_directory"),
    );
    out.insert(
        "worktree_command".into(),
        repo_field(&settings, key, "worktree_command"),
    );
    out.insert("default_worktree_command".into(), top("worktree_command"));
    out.insert(
        "worktree_remove_command".into(),
        repo_field(&settings, key, "worktree_remove_command"),
    );
    out.insert(
        "default_worktree_remove_command".into(),
        top("worktree_remove_command"),
    );
    out
}

fn owns_settings_key(conn: &WorkspaceConnection, key: &str) -> bool {
    let place = match conn.ssh_host() {
        Some(host) => format!("ssh:{host}"),
        None => "local".into(),
    };
    key.starts_with(&format!(
        "{}{place}:",
        connection_settings_prefix(Some(&conn.id))
    ))
}

async fn workspace_of(
    conn: &WorkspaceConnection,
    workspace_id: &str,
) -> Result<Value, WorkspaceError> {
    let result = conn
        .herdr_call(
            "workspace.get",
            json!({ "workspace_id": workspace_id }),
            None,
        )
        .await
        .map_err(WorkspaceError::new)?;
    Ok(result.get("workspace").cloned().unwrap_or(Value::Null))
}

/// Answers one of [`METHODS`]; None for another method. A request whose
/// connection was replaced meanwhile answers `connection changed during
/// request`.
pub async fn settings_rpc(
    conn: &WorkspaceConnection,
    hooks: &HookRunner,
    method: &str,
    params: &Value,
    is_current: &Guard,
    callbacks: &WorktreeCallbacks,
) -> Option<RpcResult> {
    if !METHODS.contains(&method) {
        return None;
    }
    if !is_current() {
        return Some(Err(WorkspaceError::new(CONNECTION_CHANGED_DURING_REQUEST)));
    }
    let result = answer(conn, hooks, method, params, is_current, callbacks).await;
    Some(if is_current() {
        result
    } else {
        Err(WorkspaceError::new(CONNECTION_CHANGED_DURING_REQUEST))
    })
}

async fn answer(
    conn: &WorkspaceConnection,
    hooks: &HookRunner,
    method: &str,
    params: &Value,
    is_current: &Guard,
    callbacks: &WorktreeCallbacks,
) -> RpcResult {
    match method {
        "settings.worktree_directory.get" => {
            let workspace_id = id_param(params, "workspace_id");
            if workspace_id.is_empty() {
                return Err(WorkspaceError::new(
                    "settings.worktree_directory.get requires workspace_id",
                ));
            }
            let workspace = workspace_of(conn, &workspace_id).await?;
            let key = repo_settings_key(conn, callbacks, &workspace_id, &workspace).await;
            let settings = conn.settings.read().await;
            Ok(json!({
                "workspace_id": workspace_id,
                "key": key,
                "worktree_directory": repo_field(&settings, key.as_deref(), "worktree_directory"),
            }))
        }
        "settings.worktree_hooks.get" => {
            let workspace_id = id_param(params, "workspace_id");
            if workspace_id.is_empty() {
                return Err(WorkspaceError::new(
                    "settings.worktree_hooks.get requires workspace_id",
                ));
            }
            let workspace = workspace_of(conn, &workspace_id).await?;
            if !workspace.get("worktree").is_some_and(js_truthy) {
                return Ok(json!({
                    "workspace_id": workspace_id,
                    "key": null,
                    "enabled": true,
                    "hooks": {},
                    "config_path": null,
                    "config_source": null,
                    "paseo_path": null,
                    "error": "workspace has no worktree metadata",
                }));
            }
            let key = repo_settings_key(conn, callbacks, &workspace_id, &workspace).await;
            let checkout = checkout_path(&workspace);
            let source = source_checkout_path(&workspace);
            let (loaded, error, config_path, config_source) = match hooks
                .read_worktree_hooks(conn, &checkout, Some(&source))
                .await
            {
                Ok(Some(loaded)) => (
                    loaded.config_value(),
                    None,
                    Some(loaded.path),
                    Some(loaded.source),
                ),
                Ok(None) => (json!({}), None, None, None),
                Err(ReadHooksError::Config(error)) => (
                    json!({}),
                    Some(error.to_string()),
                    Some(error.path),
                    Some(error.source_name),
                ),
                Err(error @ ReadHooksError::Host(_)) => {
                    (json!({}), Some(error.to_string()), None, None)
                }
            };
            let mut out = Map::new();
            out.insert("workspace_id".into(), workspace_id.into());
            out.insert("key".into(), key.clone().into());
            out.extend(repo_settings_reply(conn, key.as_deref()).await);
            out.insert(
                "repo_name".into(),
                workspace
                    .pointer("/worktree/repo_name")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            out.insert(
                "repo_root".into(),
                workspace
                    .pointer("/worktree/repo_root")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            out.insert("checkout_path".into(), checkout.into());
            out.insert("source_checkout_path".into(), source.into());
            out.insert("config_path".into(), config_path.clone().into());
            out.insert("config_source".into(), config_source.into());
            out.insert(
                "paseo_path".into(),
                if config_source == Some("paseo") {
                    config_path.into()
                } else {
                    Value::Null
                },
            );
            out.insert("hooks".into(), loaded);
            if let Some(error) = error {
                out.insert("error".into(), error.into());
            }
            Ok(Value::Object(out))
        }
        "settings.update_repo" => {
            let key = id_param(params, "key");
            if key.is_empty() {
                return Err(WorkspaceError::new("settings.update_repo requires key"));
            }
            if !owns_settings_key(conn, &key) {
                return Err(WorkspaceError::new(
                    "repository settings belong to another connection",
                ));
            }
            let patch = match params.get("settings") {
                Some(Value::Object(patch)) => patch.clone(),
                _ => Map::new(),
            };
            let mut command = None;
            if patch.contains_key("worktree_command") {
                let raw = raw_text(patch.get("worktree_command"));
                command = Some(normalize_worktree_command(&Value::from(raw.as_str())));
                if let Some(refusal) =
                    worktree_command_refusal(&raw, command.as_ref().and_then(Option::as_deref))
                {
                    return Err(WorkspaceError::new(refusal));
                }
            }
            let mut remove_command = None;
            if patch.contains_key("worktree_remove_command") {
                let raw = raw_text(patch.get("worktree_remove_command"));
                remove_command = Some(normalize_worktree_command(&Value::from(raw.as_str())));
                if let Some(refusal) = worktree_command_refusal(
                    &raw,
                    remove_command.as_ref().and_then(Option::as_deref),
                ) {
                    return Err(WorkspaceError::new(refusal));
                }
            }
            let mut directory = None;
            if patch.contains_key("worktree_directory") {
                let raw = raw_text(patch.get("worktree_directory"));
                let normalized = normalize_worktree_directory(&Value::from(raw.as_str()));
                if !raw.is_empty() && normalized.is_none() {
                    return Err(WorkspaceError::new(
                        "worktree_directory must be an absolute path",
                    ));
                }
                directory = Some(normalized);
            }
            let entry_key = key.clone();
            let settings = update_if_current(conn, is_current, move |current| {
                let mut repos = repositories(current);
                let mut next = repos
                    .get(&entry_key)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let existing_custom = next.get("custom").cloned();
                if let Some(Value::Bool(enabled)) = patch.get("worktree_hooks_enabled") {
                    next.insert("worktree_hooks_enabled".into(), (*enabled).into());
                }
                for (field, value) in [
                    ("worktree_directory", directory),
                    ("worktree_command", command),
                    ("worktree_remove_command", remove_command),
                ] {
                    match value {
                        Some(Some(text)) => {
                            next.insert(field.into(), text.into());
                        }
                        Some(None) => {
                            next.remove(field);
                        }
                        None => {}
                    }
                }
                if let Some(custom @ (Value::Object(_) | Value::Array(_))) = patch.get("custom") {
                    let mut merged = existing_custom
                        .and_then(|custom| custom.as_object().cloned())
                        .unwrap_or_default();
                    if let Value::Object(custom) = custom {
                        merged.extend(custom.clone());
                    } else if let Value::Array(items) = custom {
                        for (at, item) in items.iter().enumerate() {
                            merged.insert(at.to_string(), item.clone());
                        }
                    }
                    next.insert("custom".into(), Value::Object(merged));
                }
                repos.insert(entry_key, Value::Object(next));
                Some(current.with("repositories", Some(Value::Object(repos))))
            })
            .await
            .map_err(WorkspaceError::new)?;
            let repo = settings
                .get("repositories")
                .and_then(|repos| repos.get(&key))
                .cloned()
                .unwrap_or(Value::Null);
            Ok(json!({ "settings": settings.as_map(), "repo": repo, "key": key }))
        }
        "settings.worktree_command.update" => {
            let raw = raw_text(params.get("command"));
            let command = normalize_worktree_command(&Value::from(raw.as_str()));
            if let Some(refusal) = worktree_command_refusal(&raw, command.as_deref()) {
                return Err(WorkspaceError::new(refusal));
            }
            // The removal command changes only when given.
            let remove = params
                .get("remove_command")
                .map(|value| raw_text(Some(value)));
            let remove_command = remove
                .as_ref()
                .map(|raw| normalize_worktree_command(&Value::from(raw.as_str())));
            if let (Some(raw), Some(normalized)) = (&remove, &remove_command)
                && let Some(refusal) = worktree_command_refusal(raw, normalized.as_deref())
            {
                return Err(WorkspaceError::new(refusal));
            }
            let settings = update_if_current(conn, is_current, move |current| {
                let next = current.with("worktree_command", command.map(Value::from));
                match remove_command {
                    None => Some(next),
                    Some(remove) => {
                        let next = Settings::normalize(&next);
                        Some(next.with("worktree_remove_command", remove.map(Value::from)))
                    }
                }
            })
            .await
            .map_err(WorkspaceError::new)?;
            let top = |field: &str| settings.get(field).cloned().unwrap_or(Value::Null);
            Ok(json!({
                "worktree_command": top("worktree_command"),
                "worktree_remove_command": top("worktree_remove_command"),
            }))
        }
        _ => Err(WorkspaceError::new(format!(
            "unknown settings method: {method}"
        ))),
    }
}

#[cfg(test)]
mod tests;
