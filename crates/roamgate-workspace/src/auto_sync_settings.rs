//! The auto-sync's settings RPCs (bridge/settings-rpc.ts,
//! `settings.workspace_auto_sync.get`, `.list`, `.update` and
//! `.update_key`): they move with the workspace family and write
//! settings.json through its one writer.

use std::sync::{Arc, Mutex};

use roamgate_base::settings::{
    DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES, Settings, connection_settings_prefix,
    workspace_auto_sync_settings_key,
};
use serde_json::{Map, Value};

use crate::auto_sync::{AutoSync, GitRootResolver};
use crate::connection::{RpcResult, WorkspaceConnection, WorkspaceError};

/// connections/protocol.ts `CONNECTION_CHANGED_DURING_REQUEST`.
pub const CONNECTION_CHANGED_DURING_REQUEST: &str = "connection changed during request";

/// The methods [`settings_rpc`] answers.
pub const METHODS: [&str; 4] = [
    "settings.workspace_auto_sync.get",
    "settings.workspace_auto_sync.list",
    "settings.workspace_auto_sync.update_key",
    "settings.workspace_auto_sync.update",
];

/// What the RPCs need besides their params.
pub struct SettingsRpc<'a> {
    pub conn: &'a WorkspaceConnection,
    pub auto_sync: &'a AutoSync,
    pub resolve_git_root: &'a GitRootResolver,
    /// settings.json's path, as `list` answers it.
    pub settings_path: &'a str,
    /// False once the connection generation changed under the request.
    pub is_current: Arc<dyn Fn() -> bool + Send + Sync>,
}

fn entries(settings: &Settings) -> Map<String, Value> {
    settings
        .get("workspace_auto_sync")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

impl SettingsRpc<'_> {
    fn host(&self) -> Option<&str> {
        self.conn.ssh_host()
    }

    fn owns_key(&self, key: &str) -> bool {
        let prefix = format!(
            "{}{}:",
            connection_settings_prefix(Some(&self.conn.id)),
            match self.host() {
                Some(host) => format!("ssh:{host}"),
                None => "local".to_owned(),
            }
        );
        key.starts_with(&prefix)
    }

    fn fail(&self, message: &str) -> WorkspaceError {
        WorkspaceError::new(if (self.is_current)() {
            message
        } else {
            CONNECTION_CHANGED_DURING_REQUEST
        })
    }

    fn reply(&self, result: Value) -> RpcResult {
        if (self.is_current)() {
            Ok(result)
        } else {
            Err(self.fail(CONNECTION_CHANGED_DURING_REQUEST))
        }
    }

    async fn resolve(&self, workspace_id: &str) -> Result<(Value, String), WorkspaceError> {
        let resolved = (self.resolve_git_root)(workspace_id.to_owned())
            .await
            .map_err(|error| self.fail(&error.message))?;
        Ok((resolved.workspace, resolved.root))
    }

    /// Writes `change` unless the request went stale; the error a TS
    /// throw inside the change gave, or the cancel's.
    async fn update(
        &self,
        change: impl FnOnce(&Settings) -> Result<Value, String> + Send + 'static,
    ) -> Result<Arc<Settings>, WorkspaceError> {
        let thrown: Arc<Mutex<Option<String>>> = Arc::default();
        let kept = thrown.clone();
        let is_current = self.is_current.clone();
        let written = self
            .conn
            .settings
            .update(Box::new(move |settings| {
                if !is_current() {
                    *kept.lock().unwrap() = Some("settings update cancelled".into());
                    return None;
                }
                match change(settings) {
                    Ok(next) => Some(next),
                    Err(error) => {
                        *kept.lock().unwrap() = Some(error);
                        None
                    }
                }
            }))
            .await
            .map_err(|error| self.fail(&error))?;
        if let Some(error) = thrown.lock().unwrap().take() {
            return Err(self.fail(&error));
        }
        Ok(written)
    }

    fn workspace_label(workspace: &Value) -> Option<Value> {
        workspace
            .get("label")
            .filter(|label| !label.is_null())
            .cloned()
    }

    async fn get(&self, params: &Value) -> RpcResult {
        let workspace_id = param_text(params, "workspace_id");
        if workspace_id.is_empty() {
            return Err(self.fail("settings.workspace_auto_sync.get requires workspace_id"));
        }
        let (workspace, root) = self.resolve(&workspace_id).await?;
        let Some(key) = workspace_auto_sync_settings_key(&root, self.host(), Some(&self.conn.id))
        else {
            return Err(self.fail("workspace has no checkout path"));
        };
        let settings = self.conn.settings.read().await;
        let entry = entries(&settings).get(&key).cloned().unwrap_or(Value::Null);
        let mut out = Map::new();
        out.insert("workspace_id".into(), workspace_id.into());
        if let Some(label) = Self::workspace_label(&workspace) {
            out.insert("workspace_label".into(), label);
        }
        out.insert("checkout_path".into(), root.into());
        out.insert("key".into(), key.clone().into());
        out.insert(
            "enabled".into(),
            (entry.get("enabled") == Some(&Value::Bool(true))).into(),
        );
        out.insert(
            "interval_minutes".into(),
            entry
                .get("interval_minutes")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES.into()),
        );
        for field in ["last_run_at", "last_status", "last_message", "last_branch"] {
            if let Some(value) = entry.get(field) {
                out.insert(field.into(), value.clone());
            }
        }
        out.insert("running".into(), self.auto_sync.is_running(&key).into());
        self.reply(Value::Object(out))
    }

    async fn list(&self) -> RpcResult {
        let settings = self.conn.settings.read().await;
        let mut configs: Vec<(String, Value)> = entries(&settings)
            .into_iter()
            .filter(|(key, _)| self.owns_key(key))
            .map(|(key, entry)| {
                let mut config = Map::new();
                config.insert("key".into(), key.clone().into());
                if let Value::Object(entry) = entry {
                    config.extend(entry);
                }
                config.insert("running".into(), self.auto_sync.is_running(&key).into());
                (key, Value::Object(config))
            })
            .collect();
        configs.sort_by(|a, b| a.0.cmp(&b.0));
        let mut out = Map::new();
        out.insert(
            "configs".into(),
            Value::Array(configs.into_iter().map(|(_, config)| config).collect()),
        );
        out.insert("path".into(), self.settings_path.into());
        self.reply(Value::Object(out))
    }

    async fn update_key(&self, params: &Value) -> RpcResult {
        let key = param_text(params, "key");
        if key.is_empty() {
            return Err(self.fail("settings.workspace_auto_sync.update_key requires key"));
        }
        let Some(enabled) = params.get("enabled").and_then(Value::as_bool) else {
            return Err(self.fail("settings.workspace_auto_sync.update_key requires enabled"));
        };
        if !self.owns_key(&key) {
            return Err(self.fail("workspace auto-sync config belongs to another connection"));
        }
        let changed = key.clone();
        let updated = self
            .update(move |current| {
                let mut all = entries(current);
                let Some(Value::Object(mut entry)) = all.get(&changed).cloned() else {
                    return Err(format!("unknown workspace auto-sync config: {changed}"));
                };
                entry.insert("enabled".into(), enabled.into());
                all.insert(changed, Value::Object(entry));
                Ok(current.with("workspace_auto_sync", Some(Value::Object(all))))
            })
            .await?;
        if !(self.is_current)() {
            return Err(self.fail(CONNECTION_CHANGED_DURING_REQUEST));
        }
        let entry = entries(&updated).get(&key).cloned();
        self.auto_sync.settings_changed(&key, enabled);
        let mut out = Map::new();
        out.insert("key".into(), key.into());
        if let Some(Value::Object(entry)) = entry {
            out.extend(entry);
        }
        self.reply(Value::Object(out))
    }

    async fn update_workspace(&self, params: &Value) -> RpcResult {
        let workspace_id = param_text(params, "workspace_id");
        if workspace_id.is_empty() {
            return Err(self.fail("settings.workspace_auto_sync.update requires workspace_id"));
        }
        let Some(enabled) = params.get("enabled").and_then(Value::as_bool) else {
            return Err(self.fail("settings.workspace_auto_sync.update requires enabled"));
        };
        let (workspace, root) = self.resolve(&workspace_id).await?;
        let Some(key) = workspace_auto_sync_settings_key(&root, self.host(), Some(&self.conn.id))
        else {
            return Err(self.fail("workspace has no checkout path"));
        };
        let (changed, host, checkout) = (key.clone(), self.host().map(str::to_owned), root.clone());
        let updated = self
            .update(move |current| {
                let mut all = entries(current);
                let existing = all.get(&changed).cloned().unwrap_or(Value::Null);
                let mut entry = Map::new();
                entry.insert("enabled".into(), enabled.into());
                entry.insert(
                    "interval_minutes".into(),
                    existing
                        .get("interval_minutes")
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or_else(|| DEFAULT_WORKSPACE_AUTO_SYNC_INTERVAL_MINUTES.into()),
                );
                entry.insert("checkout_path".into(), checkout.into());
                if let Some(host) = host {
                    entry.insert("host".into(), host.into());
                }
                for field in ["last_run_at", "last_status", "last_message", "last_branch"] {
                    if let Some(value) = existing.get(field) {
                        entry.insert(field.into(), value.clone());
                    }
                }
                all.insert(changed, Value::Object(entry));
                Ok(current.with("workspace_auto_sync", Some(Value::Object(all))))
            })
            .await?;
        if !(self.is_current)() {
            return Err(self.fail(CONNECTION_CHANGED_DURING_REQUEST));
        }
        let entry = entries(&updated).get(&key).cloned();
        self.auto_sync.settings_changed(&key, enabled);
        let mut out = Map::new();
        out.insert("workspace_id".into(), workspace_id.into());
        if let Some(label) = Self::workspace_label(&workspace) {
            out.insert("workspace_label".into(), label);
        }
        out.insert("key".into(), key.clone().into());
        if let Some(Value::Object(entry)) = entry {
            out.extend(entry);
        }
        out.insert("running".into(), self.auto_sync.is_running(&key).into());
        self.reply(Value::Object(out))
    }
}

/// `String(params[name] ?? "")`.
fn param_text(params: &Value, name: &str) -> String {
    match params.get(name) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// An auto-sync settings RPC; None for another method.
pub async fn settings_rpc(
    rpc: &SettingsRpc<'_>,
    method: &str,
    params: &Value,
) -> Option<RpcResult> {
    if !METHODS.contains(&method) {
        return None;
    }
    if !(rpc.is_current)() {
        return Some(Err(rpc.fail(CONNECTION_CHANGED_DURING_REQUEST)));
    }
    Some(match method {
        "settings.workspace_auto_sync.get" => rpc.get(params).await,
        "settings.workspace_auto_sync.list" => rpc.list().await,
        "settings.workspace_auto_sync.update_key" => rpc.update_key(params).await,
        _ => rpc.update_workspace(params).await,
    })
}

#[cfg(test)]
mod tests;
