//! The settings family's handlers (bridge/settings-rpc.ts and
//! http/instance-settings.ts) on the one settings.json writer.
//!
//! [`SettingsService`] owns the [`SettingsStore`] and numbers its writes:
//! every write, whoever asks, takes one slot and moves the revision on,
//! and a write made against an older revision is refused as stale (the
//! front's own writes, while Rust owns the file, are compare-and-set on
//! the revision it last saw). It answers the methods whose answer is
//! settings.json alone ([`RPC_METHODS`]); the settings methods that also
//! need Herdr, git, worktree hooks, secret files or a provider stay with
//! their families and write through the same writer.

use std::sync::Arc;

use roamgate_base::settings::sections::{
    limit_resume_settings_error, normalize_site_list, normalize_site_roots,
};
use roamgate_base::settings::{
    LEGACY_DEFAULT_CONNECTION_ID, MAX_IDLE_STOP_MINUTES, Settings, SettingsError, SettingsStore,
    is_fallback_agent, is_idle_stop_minutes, js_trim, normalize_title_suffix,
    ui_setting_key_is_valid, ui_setting_value_error,
};
use roamgate_connections::usage_limit::limit_resume_settings_of;
use serde_json::{Map, Value, json};

/// The browser RPCs the settings family answers.
pub const RPC_METHODS: [&str; 13] = [
    "settings.get",
    "settings.agent_auto_rename.get",
    "settings.agent_auto_rename.update",
    "settings.claude_start.get",
    "settings.claude_start.update",
    "settings.conversation.get",
    "settings.conversation.update",
    "settings.limit_resume.get",
    "settings.limit_resume.update",
    "settings.terminal_transport.get",
    "settings.terminal_transport.update",
    "bridge.ui_settings.get",
    "bridge.ui_settings.update",
];

/// The instance settings' path.
pub const INSTANCE_SETTINGS_PATH: &str = "/api/instance-settings";

/// The largest instance settings body.
pub const INSTANCE_SETTINGS_MAX_BYTES: usize = 4096;

/// The settings as written, with their revision.
#[derive(Debug, Clone)]
pub struct Revision {
    pub revision: u64,
    pub settings: Arc<Settings>,
}

impl Revision {
    pub fn to_json(&self) -> Value {
        json!({ "revision": self.revision, "settings": self.settings.as_map() })
    }
}

#[derive(Debug)]
pub enum WriteError {
    /// Written against an older revision.
    Stale {
        revision: u64,
    },
    Failed(SettingsError),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale { revision } => {
                write!(
                    formatter,
                    "settings changed since revision (now {revision})"
                )
            }
            Self::Failed(error) => error.fmt(formatter),
        }
    }
}

/// An RPC's answer, and the write it made, if any.
#[derive(Debug)]
pub struct RpcAnswer {
    pub result: Value,
    pub written: Option<Revision>,
}

/// The one writer of settings.json.
pub struct SettingsService {
    store: SettingsStore,
    /// The write slot and the revision of what the store holds.
    revision: tokio::sync::Mutex<u64>,
}

impl SettingsService {
    /// `first_revision` numbers the file as first read: the time the
    /// service started, so that a restarted core never reuses a number.
    pub fn new(store: SettingsStore, first_revision: u64) -> Self {
        Self {
            store,
            revision: tokio::sync::Mutex::new(first_revision),
        }
    }

    pub fn store(&self) -> &SettingsStore {
        &self.store
    }

    /// The settings and their revision.
    pub async fn get(&self) -> Revision {
        let revision = self.revision.lock().await;
        Revision {
            revision: *revision,
            settings: self.store.read().await,
        }
    }

    /// The front's write: `settings` replaces what revision `base` was.
    pub async fn replace(&self, base: u64, settings: Value) -> Result<Revision, WriteError> {
        let mut revision = self.revision.lock().await;
        if base != *revision {
            return Err(WriteError::Stale {
                revision: *revision,
            });
        }
        let written = self
            .store
            .update(|_| settings)
            .await
            .map_err(WriteError::Failed)?;
        *revision += 1;
        Ok(Revision {
            revision: *revision,
            settings: written,
        })
    }

    /// Reads, changes and writes under the slot.
    pub async fn update(
        &self,
        change: impl FnOnce(&Settings) -> Value,
    ) -> Result<Revision, SettingsError> {
        let mut revision = self.revision.lock().await;
        let written = self.store.update(change).await?;
        *revision += 1;
        Ok(Revision {
            revision: *revision,
            settings: written,
        })
    }

    /// [`Self::update`], left undone (`Cancelled`, the revision kept)
    /// when `should_commit` turns false before the file is replaced.
    pub async fn update_if(
        &self,
        change: impl FnOnce(&Settings) -> Value,
        should_commit: impl Fn() -> bool,
    ) -> Result<Revision, SettingsError> {
        let mut revision = self.revision.lock().await;
        let written = self.store.update_if(change, should_commit).await?;
        *revision += 1;
        Ok(Revision {
            revision: *revision,
            settings: written,
        })
    }

    async fn write(&self, change: impl FnOnce(&Settings) -> Value) -> Result<Revision, String> {
        self.update(change).await.map_err(|error| error.to_string())
    }

    /// A browser RPC of [`RPC_METHODS`] (`connection_id`: the connection
    /// it came on); Err is the error message the browser gets.
    pub async fn rpc(
        &self,
        method: &str,
        params: &Value,
        connection_id: Option<&str>,
        path: &str,
    ) -> Result<RpcAnswer, String> {
        let empty = Map::new();
        let params_map = params.as_object().unwrap_or(&empty);
        let only = |key: &str| params_map.keys().all(|each| each == key);
        let read = |result: Value| RpcAnswer {
            result,
            written: None,
        };
        match method {
            "settings.get" => {
                let settings = self.store.read().await;
                Ok(read(json!({ "settings": settings.as_map(), "path": path })))
            }
            "settings.agent_auto_rename.get" => {
                let settings = self.store.read().await;
                Ok(read(json!({ "enabled": auto_rename(&settings) })))
            }
            "settings.agent_auto_rename.update" => {
                let Some(enabled) = params_map
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .filter(|_| only("enabled"))
                else {
                    return Err(
                        "settings.agent_auto_rename.update requires only a boolean enabled".into(),
                    );
                };
                let written = self
                    .write(|current| current.with("auto_rename_agent_tabs", Some(enabled.into())))
                    .await?;
                Ok(RpcAnswer {
                    result: json!({ "enabled": auto_rename(&written.settings) }),
                    written: Some(written),
                })
            }
            "settings.claude_start.get" => {
                let settings = self.store.read().await;
                Ok(read(json!({ "mode": settings.claude_start_mode() })))
            }
            "settings.claude_start.update" => {
                let Some(mode) = params_map
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|mode| matches!(*mode, "terminal" | "conversation") && only("mode"))
                else {
                    return Err(
                        "settings.claude_start.update takes only mode: terminal or conversation"
                            .into(),
                    );
                };
                let written = self
                    .write(|current| current.with("claude_start_mode", Some(mode.into())))
                    .await?;
                Ok(RpcAnswer {
                    result: json!({ "mode": written.settings.claude_start_mode() }),
                    written: Some(written),
                })
            }
            "settings.conversation.get" => {
                let settings = self.store.read().await;
                let mut result = json!({
                    "idle_stop_minutes": settings.conversation_idle_stop_minutes()
                });
                if let Some(fallback) = settings.conversation_fallback_agent() {
                    result["fallback_agent"] = json!(fallback);
                }
                Ok(read(result))
            }
            "settings.conversation.update" => {
                let known = |key: &str| matches!(key, "idle_stop_minutes" | "fallback_agent");
                let valid = !params_map.is_empty()
                    && params_map.keys().all(|key| known(key))
                    && params_map
                        .get("idle_stop_minutes")
                        .is_none_or(|minutes| is_idle_stop_minutes(Some(minutes)))
                    && params_map
                        .get("fallback_agent")
                        .is_none_or(|agent| is_fallback_agent(Some(agent)));
                if !valid {
                    return Err(format!(
                        "settings.conversation.update takes idle_stop_minutes (a whole number of minutes from 0, never, to {MAX_IDLE_STOP_MINUTES}) and fallback_agent (claude, agy or null)"
                    ));
                }
                let minutes = params_map.get("idle_stop_minutes").cloned();
                let fallback = params_map.get("fallback_agent").cloned();
                let written = self
                    .write(|current| {
                        let mut conversation = current
                            .get("conversation")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        if let Some(minutes) = minutes {
                            conversation.insert("idle_stop_minutes".into(), minutes);
                        }
                        if let Some(fallback) = fallback {
                            if fallback.is_null() {
                                conversation.remove("fallback_agent");
                            } else {
                                conversation.insert("fallback_agent".into(), fallback);
                            }
                        }
                        current.with("conversation", Some(Value::Object(conversation)))
                    })
                    .await?;
                let mut result = json!({
                    "idle_stop_minutes": written.settings.conversation_idle_stop_minutes()
                });
                if let Some(fallback) = written.settings.conversation_fallback_agent() {
                    result["fallback_agent"] = json!(fallback);
                }
                Ok(RpcAnswer {
                    result,
                    written: Some(written),
                })
            }
            "settings.limit_resume.get" => {
                let settings = self.store.read().await;
                Ok(read(limit_resume_of(&settings)))
            }
            "settings.limit_resume.update" => {
                if let Some(error) = limit_resume_settings_error(params_map) {
                    return Err(format!("settings.limit_resume.update: {error}"));
                }
                let mut patch = params_map.clone();
                if let Some(Value::String(message)) = patch.get("message") {
                    let message = js_trim(message).to_owned();
                    patch.insert("message".into(), message.into());
                }
                let written = self
                    .write(|current| {
                        let mut stored = current
                            .get("limit_resume")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        stored.extend(patch);
                        current.with("limit_resume", Some(Value::Object(stored)))
                    })
                    .await?;
                Ok(RpcAnswer {
                    result: limit_resume_of(&written.settings),
                    written: Some(written),
                })
            }
            "settings.terminal_transport.get" => {
                let settings = self.store.read().await;
                Ok(read(json!({
                    "surface_codecs": settings.terminal_surface_codecs_enabled(connection_id)
                })))
            }
            "settings.terminal_transport.update" => {
                let Some(enabled) = params_map
                    .get("surface_codecs")
                    .and_then(Value::as_bool)
                    .filter(|_| only("surface_codecs"))
                else {
                    return Err(
                        "settings.terminal_transport.update requires only a boolean surface_codecs"
                            .into(),
                    );
                };
                let connection = connection_id
                    .unwrap_or(LEGACY_DEFAULT_CONNECTION_ID)
                    .to_owned();
                let written = self
                    .write(|current| {
                        let mut transport = current
                            .get("terminal_transport")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        transport.insert(connection.clone(), json!({ "surface_codecs": enabled }));
                        current.with("terminal_transport", Some(Value::Object(transport)))
                    })
                    .await?;
                Ok(RpcAnswer {
                    result: json!({
                        "surface_codecs": written.settings.terminal_surface_codecs_enabled(Some(&connection))
                    }),
                    written: Some(written),
                })
            }
            "bridge.ui_settings.get" => {
                let settings = self.store.read().await;
                Ok(read(json!({ "ui": settings.ui() })))
            }
            "bridge.ui_settings.update" => {
                let key = params_map
                    .get("key")
                    .and_then(Value::as_str)
                    .filter(|key| ui_setting_key_is_valid(key));
                let Some(key) = key else {
                    return Err(
                        "UI settings require key matching [A-Za-z][A-Za-z0-9_.-]{0,63}".into(),
                    );
                };
                let value = params_map.get("value").cloned();
                if let Some(error) = ui_setting_value_error(value.as_ref()) {
                    return Err(error);
                }
                let written = self
                    .write(|current| {
                        let mut ui = current.ui();
                        match value {
                            Some(value) => {
                                ui.insert(key.to_owned(), value);
                            }
                            None => {
                                ui.remove(key);
                            }
                        }
                        current.with("ui", Some(Value::Object(ui)))
                    })
                    .await?;
                let value = written
                    .settings
                    .ui()
                    .get(key)
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(RpcAnswer {
                    result: json!({ "key": key, "value": value }),
                    written: Some(written),
                })
            }
            other => Err(format!("unknown settings method: {other}")),
        }
    }

    /// `/api/instance-settings` (called after the front's authentication
    /// gate).
    pub async fn instance_settings(&self, request: InstanceRequest) -> InstanceResponse {
        match request.method.as_str() {
            "GET" => {
                let settings = self.store.read().await;
                return InstanceResponse::json(200, instance_settings_of(&settings), None);
            }
            "PUT" => {}
            _ => return InstanceResponse::method_not_allowed(),
        }
        // As with push settings, the custom header + JSON prevent a
        // cross-origin browser write without a CORS grant.
        let content_type = request
            .content_type
            .as_deref()
            .and_then(|value| value.split(';').next())
            .map(|value| js_trim(value).to_lowercase());
        if request.settings_header.as_deref() != Some("1")
            || request.fetch_site.as_deref() == Some("cross-site")
            || content_type.as_deref() != Some("application/json")
        {
            return InstanceResponse::json(403, json!({ "error": "Forbidden" }), None);
        }
        let input = match request.body {
            InstanceBody::TooLarge => {
                return InstanceResponse::json(
                    413,
                    json!({ "error": "Request body too large" }),
                    None,
                );
            }
            InstanceBody::Missing => None,
            InstanceBody::Bytes(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
        };
        let Some(input) = input else {
            return InstanceResponse::json(
                400,
                json!({ "error": "Invalid settings request" }),
                None,
            );
        };
        let change = match instance_change(&input) {
            Ok(change) => change,
            Err(error) => return InstanceResponse::json(400, json!({ "error": error }), None),
        };
        match self.update(|current| change.apply(current)).await {
            Ok(written) => {
                let body = instance_settings_of(&written.settings);
                InstanceResponse::json(200, body, Some(written))
            }
            Err(error) => {
                tracing::warn!(scope = "settings", error = %error, "unable to save instance settings");
                InstanceResponse::json(
                    500,
                    json!({ "error": "Unable to save instance settings" }),
                    None,
                )
            }
        }
    }
}

fn auto_rename(settings: &Settings) -> bool {
    settings.get("auto_rename_agent_tabs") != Some(&Value::Bool(false))
}

/// limitResumeSettings: the stored settings over the defaults.
fn limit_resume_of(settings: &Settings) -> Value {
    let stored = settings.get("limit_resume").and_then(Value::as_object);
    let effective = limit_resume_settings_of(stored);
    json!({
        "enabled": effective.enabled,
        "message": effective.message,
        "margin_seconds": effective.margin_seconds,
    })
}

/// An instance settings request, as the handler needs it.
pub struct InstanceRequest {
    pub method: String,
    pub settings_header: Option<String>,
    pub fetch_site: Option<String>,
    pub content_type: Option<String>,
    pub body: InstanceBody,
}

pub enum InstanceBody {
    Missing,
    TooLarge,
    Bytes(Vec<u8>),
}

/// The handler's answer: `body` is JSON unless `text` is set.
pub struct InstanceResponse {
    pub status: u16,
    pub body: Value,
    pub text: Option<&'static str>,
    pub allow: Option<&'static str>,
    pub written: Option<Revision>,
}

impl InstanceResponse {
    fn json(status: u16, body: Value, written: Option<Revision>) -> Self {
        Self {
            status,
            body,
            text: None,
            allow: None,
            written,
        }
    }

    fn method_not_allowed() -> Self {
        Self {
            status: 405,
            body: Value::Null,
            text: Some("method not allowed"),
            allow: Some("GET, PUT"),
            written: None,
        }
    }
}

fn instance_settings_of(settings: &Settings) -> Value {
    json!({
        "title_suffix": settings.get("title_suffix").cloned().unwrap_or_else(|| json!("")),
        "rendered_sites": settings.get("rendered_sites").cloned().unwrap_or_else(|| json!([])),
        "rendered_site_roots": settings.get("rendered_site_roots").cloned().unwrap_or_else(|| json!({})),
    })
}

/// What a PUT changes.
struct InstanceChange {
    suffix: Option<String>,
    sites: Option<Vec<String>>,
    roots: Option<Value>,
}

fn instance_change(input: &Value) -> Result<InstanceChange, String> {
    let empty = Map::new();
    let fields = input.as_object().unwrap_or(&empty);
    let given = |key: &str| fields.get(key);
    let mut change = InstanceChange {
        suffix: None,
        sites: None,
        roots: None,
    };
    // Either field may come alone; without either, the title is cleared.
    if given("title_suffix").is_some()
        || (given("rendered_sites").is_none() && given("rendered_site_roots").is_none())
    {
        let suffix = given("title_suffix").cloned().unwrap_or(Value::Null);
        change.suffix = Some(normalize_title_suffix(&suffix)?);
    }
    if let Some(value) = given("rendered_site_roots") {
        let Some(roots) = value.as_object() else {
            return Err("rendered_site_roots must map sites to roots".into());
        };
        for (site, root) in roots {
            if !root.as_str().is_some_and(|root| !js_trim(root).is_empty()) {
                return Err(format!("no root given for {site}"));
            }
        }
        change.roots = Some(value.clone());
    }
    if let Some(value) = given("rendered_sites") {
        if !value.is_array() {
            return Err("rendered_sites must be a list".into());
        }
        change.sites = Some(normalize_site_list(Some(value)));
    }
    Ok(change)
}

impl InstanceChange {
    fn apply(&self, current: &Settings) -> Value {
        let mut next = current.as_map().clone();
        if let Some(suffix) = &self.suffix {
            next.insert("title_suffix".into(), suffix.clone().into());
        }
        if let Some(sites) = &self.sites {
            if sites.is_empty() {
                next.remove("rendered_sites");
            } else {
                next.insert("rendered_sites".into(), sites.clone().into());
            }
        }
        // Kept only for listed sites, each containing its site.
        let listed: Vec<String> = next
            .get("rendered_sites")
            .and_then(Value::as_array)
            .map(|sites| {
                sites
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let roots = self.roots.as_ref().or(next.get("rendered_site_roots"));
        let kept = normalize_site_roots(roots, &listed);
        if kept.is_empty() {
            next.remove("rendered_site_roots");
        } else {
            next.insert("rendered_site_roots".into(), Value::Object(kept));
        }
        Value::Object(next)
    }
}

/// What a browser sees of the agent profiles (`profilesReply`): every
/// value but secret files' contents (it gets their paths), whether each
/// file can be used, and the model each runs.
pub fn profiles_reply(settings: &Settings, home: &std::path::Path) -> Value {
    use roamgate_connections::agent_profiles::shared::{
        all_profiles, profile_model_label, profile_name, profile_view,
    };
    let raw = Value::Object(settings.as_map().clone());
    let profiles = roamgate_connections::agent_profiles::store::profiles_of(Some(&raw));
    let list = roamgate_connections::agent_profiles::store::profiles_list(&profiles);
    let own: std::collections::HashSet<&str> = list.iter().map(profile_name).collect();
    let shown: Vec<Value> = all_profiles(&list)
        .iter()
        .map(|profile| {
            let mut view = profile_view(profile, !own.contains(profile_name(profile)));
            if let Some(env) = view.get_mut("env").and_then(Value::as_array_mut) {
                for entry in env.iter_mut() {
                    let Some(file) = entry.get("file").and_then(Value::as_str) else {
                        continue;
                    };
                    if let Err(problem) =
                        roamgate_connections::agent_profiles::store::read_secret_file(file, home)
                        && let Some(entry) = entry.as_object_mut()
                    {
                        entry.insert("problem".into(), json!(problem));
                    }
                }
            }
            if let Some(view) = view.as_object_mut() {
                view.insert("label".into(), json!(profile_model_label(profile)));
                // An account's directory and whether its sign-in is there.
                if let Some((agent, dir)) =
                    roamgate_connections::agent_profiles::store::account_dir_of(profile, home)
                    && let Some(account) = view.get_mut("account").and_then(Value::as_object_mut)
                {
                    account.insert("dir".into(), json!(dir.to_string_lossy()));
                    account.insert(
                        "auth".into(),
                        json!(roamgate_accounts::auth_state(agent, &dir).as_str()),
                    );
                    // A sign-in clauth still manages (an import), by its profile.
                    if let Some(profile) = roamgate_accounts::clauth::managed_by_clauth(&dir) {
                        account.insert("clauth".into(), json!(profile));
                    }
                }
            }
            view
        })
        .collect();
    let mut reply = json!({
        "profiles": shown,
        "default": profiles.get("default").cloned().unwrap_or(Value::Null),
        "return_after_reset": profiles.get("return_after_reset").cloned().unwrap_or(Value::Null),
    });
    if let Some(chain) = profiles.get("chain") {
        reply["chain"] = chain.clone();
    }
    reply
}

/// A profile as the browser edits it (`profileFromView`): its env entries
/// back to `{NAME: value | {file}}`.
pub fn profile_from_view(raw: &Value) -> Value {
    let Some(view) = raw.as_object() else {
        return raw.clone();
    };
    let Some(entries) = view.get("env").and_then(Value::as_array) else {
        return raw.clone();
    };
    let broken = || {
        let mut broken = view.clone();
        broken.insert("env".into(), Value::Null);
        Value::Object(broken)
    };
    let mut env = Map::new();
    for entry in entries {
        let Some(entry) = entry.as_object() else {
            return broken();
        };
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            return broken();
        };
        let value = match entry.get("file") {
            Some(Value::String(file)) => json!({ "file": file }),
            _ => entry.get("value").cloned().unwrap_or(Value::Null),
        };
        env.insert(name.to_owned(), value);
    }
    let mut profile = Map::new();
    for key in ["name", "agent"] {
        if let Some(value) = view.get(key) {
            profile.insert(key.into(), value.clone());
        }
    }
    profile.insert("env".into(), Value::Object(env));
    if let Some(command) = view
        .get("command")
        .and_then(Value::as_str)
        .filter(|command| !js_trim(command).is_empty())
    {
        profile.insert("command".into(), json!(command));
    }
    if let Some(unset) = view
        .get("unset")
        .filter(|unset| unset.as_array().is_some_and(|unset| !unset.is_empty()))
    {
        profile.insert("unset".into(), unset.clone());
    }
    // An account keeps its id; its directory and state are the server's.
    if let Some(account) = view.get("account") {
        let id = account.get("id").cloned();
        profile.insert(
            "account".into(),
            match id {
                Some(id) if account.is_object() => json!({ "id": id }),
                _ => account.clone(),
            },
        );
    }
    Value::Object(profile)
}

/// `settings.profiles.update`'s parameters as the `profiles` section to
/// write (normalised), or the error the browser gets.
pub fn profiles_update(params: &Value) -> Result<Value, String> {
    let empty = Map::new();
    let params = params.as_object().unwrap_or(&empty);
    let mut raw = Map::new();
    if let Some(list) = params.get("list") {
        raw.insert(
            "list".into(),
            match list {
                Value::Array(list) => Value::Array(list.iter().map(profile_from_view).collect()),
                other => other.clone(),
            },
        );
    }
    for key in ["default", "return_after_reset", "chain"] {
        if let Some(value) = params.get(key) {
            raw.insert(key.into(), value.clone());
        }
    }
    let raw = Value::Object(raw);
    if params.keys().any(|key| {
        !matches!(
            key.as_str(),
            "list" | "default" | "return_after_reset" | "chain"
        )
    }) {
        return Err(
            "settings.profiles.update takes list, default, return_after_reset and chain".into(),
        );
    }
    if let Some(error) = roamgate_connections::agent_profiles::shared::profiles_settings_error(&raw)
    {
        return Err(error);
    }
    Ok(roamgate_base::settings::sections::normalize_profiles_settings(Some(&raw)))
}

#[cfg(test)]
mod tests;
