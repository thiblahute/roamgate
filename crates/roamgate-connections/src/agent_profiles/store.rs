//! server/src/profiles/profiles.ts: a profile as a command (its program,
//! the environment it sets with secret files read, what it removes), the
//! profile each session runs with (`session-profiles.json`), the launches
//! typed into panes, and the command Roamgate's own helpers run.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use rand::RngCore;
use roamgate_base::json_store::{JsonFormat, to_js_json};
use roamgate_base::log::iso_millis;
use roamgate_base::paths::DataContext;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::shared::{
    BUILTIN_PROFILE_NAME, all_profiles, is_plain_profile, normalize_profiles_settings,
    profile_agent, profile_name, profile_named, profile_program, profile_unset,
};

/// A profile ready to start an agent with: its program, the environment
/// it sets (secret files read, in the profile's order) and what it
/// removes. `plain` is the built-in Claude unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentCommand {
    pub profile: String,
    pub agent: String,
    pub program: String,
    pub env: IndexMap<String, String>,
    pub unset: Vec<String>,
    pub plain: bool,
    /// The model to start the session with this once.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl AgentCommand {
    /// `PLAIN_CLAUDE`: the built-in Claude, started as before profiles.
    pub fn plain_claude() -> Self {
        Self {
            profile: BUILTIN_PROFILE_NAME.into(),
            agent: "claude".into(),
            program: "claude".into(),
            env: IndexMap::new(),
            unset: Vec::new(),
            plain: true,
            model: None,
        }
    }

    /// The command as Bun's object (`AgentCommand`).
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// From Bun's object (a reverse call's answer, a stored spec).
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            profile: text("profile")?,
            agent: text("agent").unwrap_or_else(|| "claude".into()),
            program: text("program")?,
            env: object
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
            unset: strings(object.get("unset")),
            plain: object
                .get("plain")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            model: text("model"),
        })
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|each| each.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The `profiles` section of settings.json (normalised), or the default.
pub fn profiles_of(settings: Option<&Value>) -> Value {
    match settings.and_then(|settings| settings.get("profiles")) {
        Some(profiles) if !profiles.is_null() => profiles.clone(),
        _ => normalize_profiles_settings(None),
    }
}

/// The profiles list of a `profiles` section.
pub fn profiles_list(profiles: &Value) -> Vec<Value> {
    profiles
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        return home.to_path_buf();
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// A secret file's value, its final newline dropped. Refused when others
/// may read it (0600 only).
pub fn read_secret_file(path: &str, home: &Path) -> Result<String, String> {
    let full = expand_home(path, home);
    if !full.is_absolute() {
        return Err(format!("The secret file {path} must be an absolute path"));
    }
    let metadata =
        std::fs::metadata(&full).map_err(|_| format!("The secret file {path} cannot be read"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "The secret file {path} is readable by others; chmod 600 it"
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    let text = std::fs::read_to_string(&full)
        .map_err(|_| format!("The secret file {path} cannot be read"))?;
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(&text);
    Ok(text.to_owned())
}

/// The command a profile starts; an error when a secret cannot be read.
pub fn profile_command(profile: &Value, home: &Path) -> Result<AgentCommand, String> {
    if is_plain_profile(profile) {
        return Ok(AgentCommand {
            profile: profile_name(profile).into(),
            agent: profile_agent(profile).into(),
            ..AgentCommand::plain_claude()
        });
    }
    let mut env = IndexMap::new();
    if let Some(entries) = profile.get("env").and_then(Value::as_object) {
        for (name, value) in entries {
            let value = match value {
                Value::String(text) => text.clone(),
                other => read_secret_file(
                    other.get("file").and_then(Value::as_str).unwrap_or(""),
                    home,
                )?,
            };
            env.insert(name.clone(), value);
        }
    }
    Ok(AgentCommand {
        profile: profile_name(profile).into(),
        agent: profile_agent(profile).into(),
        program: profile_program(profile),
        env,
        unset: profile_unset(profile),
        plain: false,
        model: None,
    })
}

/// A command's environment applied to a base environment.
pub fn command_env(
    command: &AgentCommand,
    base: &IndexMap<String, String>,
) -> IndexMap<String, String> {
    let mut env = base.clone();
    for name in &command.unset {
        env.shift_remove(name);
    }
    for (name, value) in &command.env {
        env.insert(name.clone(), value.clone());
    }
    env
}

/// What a log may say of a command: names, never values.
pub fn describe_command(command: &AgentCommand) -> Value {
    let mut names: Vec<&String> = command.env.keys().collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    json!({
        "profile": command.profile,
        "program": command.program,
        "env": names,
        "unset": command.unset,
    })
}

/// Epoch milliseconds now.
pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;

fn system_now() -> NowMs {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or(0)
    })
}

const MAX_SESSIONS: usize = 2000;

/// What the store tells after each write: the sessions as written.
pub type SessionsObserver = Arc<dyn Fn(&Map<String, Value>) + Send + Sync>;

/// Where a session choice store keeps its file.
pub struct SessionProfilesOptions {
    /// None: in memory only (tests).
    pub file: Option<PathBuf>,
    pub data: DataContext,
    pub now: Option<NowMs>,
    /// Told the sessions after each write (the core tells the front).
    pub observer: Option<SessionsObserver>,
    /// Asked before each write of the file (the family's one writer).
    pub can_write: Option<CanWrite>,
}

/// Whether the file may be written now; Err: why not.
pub type CanWrite = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// Which profile each session runs with, when the user chose one (by
/// session id, every connection); no entry: the default profile. A choice
/// is Bun's object: `profile` (null: the default, kept for `model`), `at`,
/// `return_at?`, `return_to?`, `model?`, `model_at?`, `model_resolved?`.
pub struct SessionProfiles {
    file: Option<PathBuf>,
    data: DataContext,
    now: NowMs,
    observer: Option<SessionsObserver>,
    can_write: Option<CanWrite>,
    sessions: Mutex<Option<IndexMap<String, Map<String, Value>>>>,
}

/// A session due back on its default profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueReturn {
    pub session_id: String,
    pub to: String,
}

impl SessionProfiles {
    pub fn new(options: SessionProfilesOptions) -> Self {
        Self {
            file: options.file,
            data: options.data,
            now: options.now.unwrap_or_else(system_now),
            observer: options.observer,
            can_write: options.can_write,
            sessions: Mutex::new(None),
        }
    }

    /// The server's store: `<data>/session-profiles.json`.
    pub fn at_data_root(
        data: DataContext,
        observer: Option<SessionsObserver>,
        can_write: Option<CanWrite>,
    ) -> Self {
        Self::new(SessionProfilesOptions {
            file: Some(data.data_root().join("session-profiles.json")),
            data,
            now: None,
            observer,
            can_write,
        })
    }

    /// An in-memory store (tests, a front's cache).
    pub fn in_memory(now: Option<NowMs>) -> Self {
        Self::new(SessionProfilesOptions {
            file: None,
            data: DataContext::from_env(&roamgate_base::env::ProcessEnv),
            now,
            observer: None,
            can_write: None,
        })
    }

    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    fn parse(text: &str) -> IndexMap<String, Map<String, Value>> {
        let mut sessions = IndexMap::new();
        let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(text) else {
            return sessions;
        };
        let Some(Value::Object(stored)) = parsed.get("sessions") else {
            return sessions;
        };
        for (id, choice) in stored {
            let Value::Object(choice) = choice else {
                continue;
            };
            let kept = match choice.get("profile") {
                Some(Value::String(_)) => true,
                Some(Value::Null) => choice.get("model").is_some_and(Value::is_string),
                _ => false,
            };
            if kept {
                sessions.insert(id.clone(), choice.clone());
            }
        }
        sessions
    }

    fn with<T>(&self, apply: impl FnOnce(&mut IndexMap<String, Map<String, Value>>) -> T) -> T {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let sessions = guard.get_or_insert_with(|| match &self.file {
            Some(file) => std::fs::read_to_string(file)
                .map(|text| Self::parse(&text))
                .unwrap_or_default(),
            None => IndexMap::new(),
        });
        apply(sessions)
    }

    fn save(&self, sessions: &mut IndexMap<String, Map<String, Value>>) {
        while sessions.len() > MAX_SESSIONS {
            sessions.shift_remove_index(0);
        }
        let object: Map<String, Value> = sessions
            .iter()
            .map(|(id, choice)| (id.clone(), Value::Object(choice.clone())))
            .collect();
        let writable = self.can_write.as_ref().is_none_or(|check| check().is_ok());
        if let Some(file) = self.file.as_ref().filter(|_| writable) {
            let doc = json!({"version": 1, "sessions": Value::Object(object.clone())});
            if let Ok(text) = to_js_json(&doc, JsonFormat::Pretty) {
                let _ = self.data.replace_data_file(file, text.as_bytes(), 0o600);
            }
        }
        if let Some(observer) = &self.observer {
            observer(&object);
        }
    }

    fn iso_now(&self) -> String {
        iso_millis((self.now)())
    }

    /// Every choice, in its order (Bun's `sessions` object).
    pub fn snapshot(&self) -> Map<String, Value> {
        self.with(|sessions| {
            sessions
                .iter()
                .map(|(id, choice)| (id.clone(), Value::Object(choice.clone())))
                .collect()
        })
    }

    /// Forgets what it read: the next use reads the file again.
    pub fn reload(&self) {
        *self.sessions.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Replaces every choice (a front's cache told the owner's).
    pub fn replace_all(&self, sessions: &Map<String, Value>) {
        let parsed = Self::parse(&json!({"sessions": sessions}).to_string());
        *self.sessions.lock().unwrap_or_else(|e| e.into_inner()) = Some(parsed);
    }

    /// A session's choice, or None.
    pub fn get(&self, session_id: Option<&str>) -> Option<Map<String, Value>> {
        let session_id = session_id.filter(|id| !id.is_empty())?;
        self.with(|sessions| sessions.get(session_id).cloned())
    }

    /// Remembers a choice; None (the default profile) with no model clears
    /// it. `back`: when (epoch ms) and to what it returns.
    pub fn set(
        &self,
        session_id: &str,
        profile: Option<&str>,
        back: Option<(i64, &str)>,
        model: Option<&str>,
    ) {
        let at = self.iso_now();
        self.with(|sessions| {
            sessions.shift_remove(session_id);
            let profile = profile.filter(|profile| !profile.is_empty());
            let model = model.filter(|model| !model.is_empty());
            if profile.is_some() || model.is_some() {
                let mut choice = Map::new();
                choice.insert("profile".into(), json!(profile));
                choice.insert("at".into(), json!(at));
                if let Some((return_at, to)) = back {
                    choice.insert("return_at".into(), json!(return_at));
                    choice.insert("return_to".into(), json!(to));
                }
                if let Some(model) = model {
                    choice.insert("model".into(), json!(model));
                }
                sessions.insert(session_id.to_owned(), choice);
            }
            self.save(sessions);
        });
    }

    /// The user's /model: the session starts with `model` until it
    /// answered with it. Its profile and return stay; None drops the
    /// choice.
    pub fn choose_model(&self, session_id: &str, model: Option<&str>, resolved: Option<&str>) {
        let at = self.iso_now();
        self.with(|sessions| {
            let mut rest = match sessions.get(session_id) {
                Some(choice) => choice.clone(),
                None => {
                    let mut fresh = Map::new();
                    fresh.insert("profile".into(), Value::Null);
                    fresh.insert("at".into(), json!(at));
                    fresh
                }
            };
            for key in ["model", "model_at", "model_resolved"] {
                rest.shift_remove(key);
            }
            let model = model.filter(|model| !model.is_empty());
            if let Some(model) = model {
                rest.insert("model".into(), json!(model));
                rest.insert("model_at".into(), json!(at));
                if let Some(resolved) = resolved.filter(|resolved| !resolved.is_empty()) {
                    rest.insert("model_resolved".into(), json!(resolved));
                }
            }
            sessions.shift_remove(session_id);
            if !rest.get("profile").is_some_and(Value::is_null) || model.is_some() {
                sessions.insert(session_id.to_owned(), rest);
            }
            self.save(sessions);
        });
    }

    /// The session answered on its profile: its own model choice holds now.
    pub fn settle_model(&self, session_id: &str) {
        self.with(|sessions| {
            let Some(choice) = sessions.get(session_id) else {
                return;
            };
            if !choice
                .get("model")
                .is_some_and(|model| model.as_str().is_some_and(|model| !model.is_empty()))
            {
                return;
            }
            if choice.get("profile").is_some_and(Value::is_null) {
                sessions.shift_remove(session_id);
            } else {
                let mut rest = choice.clone();
                for key in ["model", "model_at", "model_resolved"] {
                    rest.shift_remove(key);
                }
                sessions.insert(session_id.to_owned(), rest);
            }
            self.save(sessions);
        });
    }

    /// Sessions due back on their default profile.
    pub fn due(&self) -> Vec<DueReturn> {
        let at = (self.now)();
        self.with(|sessions| {
            sessions
                .iter()
                .filter_map(|(session_id, choice)| {
                    let return_at = choice.get("return_at")?.as_f64()?;
                    let to = choice
                        .get("return_to")?
                        .as_str()
                        .filter(|to| !to.is_empty())?;
                    (return_at <= at as f64).then(|| DueReturn {
                        session_id: session_id.clone(),
                        to: to.to_owned(),
                    })
                })
                .collect()
        })
    }
}

/// The profile a session runs with: its choice, else the default.
pub fn profile_for_session(
    settings: Option<&Value>,
    session_id: Option<&str>,
    store: Option<&SessionProfiles>,
) -> Value {
    let profiles = profiles_of(settings);
    let list = profiles_list(&profiles);
    let chosen = store
        .and_then(|store| store.get(session_id))
        .and_then(|choice| {
            choice
                .get("profile")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    profile_named(&list, chosen.as_deref())
        .or_else(|| profile_named(&list, profiles.get("default").and_then(Value::as_str)))
        .unwrap_or_else(|| all_profiles(&list).remove(0))
}

/// The command a session's agent starts with (its profile, else the
/// default). A profile whose secret cannot be read is an error.
pub fn command_for_session(
    session_id: Option<&str>,
    settings: Option<&Value>,
    store: Option<&SessionProfiles>,
    home: &Path,
) -> Result<AgentCommand, String> {
    let mut command = profile_command(&profile_for_session(settings, session_id, store), home)?;
    if let Some(model) = store
        .and_then(|store| store.get(session_id))
        .and_then(|choice| {
            choice
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|model| !model.is_empty())
    {
        command.model = Some(model);
    }
    Ok(command)
}

/// Agent arguments without any `--model`.
pub fn without_model(args: &[String]) -> Vec<String> {
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--model" {
            index += 2;
            continue;
        }
        if !arg.starts_with("--model=") {
            kept.push(arg.clone());
        }
        index += 1;
    }
    kept
}

/// Agent arguments with `--model` set to `model` (any earlier one
/// dropped); the same arguments when there is none.
pub fn with_model(args: &[String], model: Option<&str>) -> Vec<String> {
    match model.filter(|model| !model.is_empty()) {
        None => args.to_vec(),
        Some(model) => {
            let mut kept = without_model(args);
            kept.push("--model".into());
            kept.push(model.into());
            kept
        }
    }
}

/// The default profile's command, for Roamgate's own helpers.
pub fn default_command(settings: Option<&Value>, home: &Path) -> Result<AgentCommand, String> {
    command_for_session(None, settings, None, home)
}

/// What a pane's roamgate-hold trades a launch token for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LaunchSpec {
    pub argv: Vec<String>,
    pub env: IndexMap<String, String>,
    pub unset: Vec<String>,
    pub agent: String,
    /// Set ROAMGATE_CLAUDE_START=terminal (the agent stays in the terminal).
    pub terminal: bool,
}

struct Launch {
    connection_id: String,
    pane_id: String,
    spec: LaunchSpec,
    until: i64,
}

/// Agent starts typed into a pane carry only a token, one use each, for a
/// short while, for that pane only.
pub struct LaunchRegistry {
    now: NowMs,
    ttl_ms: i64,
    launches: Mutex<IndexMap<String, Launch>>,
}

impl LaunchRegistry {
    pub fn new(now: Option<NowMs>, ttl_ms: Option<i64>) -> Self {
        Self {
            now: now.unwrap_or_else(system_now),
            ttl_ms: ttl_ms.unwrap_or(120_000),
            launches: Mutex::new(IndexMap::new()),
        }
    }

    fn sweep(&self, launches: &mut IndexMap<String, Launch>) {
        let at = (self.now)();
        launches.retain(|_, launch| launch.until > at);
    }

    pub fn register(&self, connection_id: &str, pane_id: &str, spec: LaunchSpec) -> String {
        let mut launches = self.launches.lock().unwrap_or_else(|e| e.into_inner());
        self.sweep(&mut launches);
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        launches.insert(
            token.clone(),
            Launch {
                connection_id: connection_id.into(),
                pane_id: pane_id.into(),
                spec,
                until: (self.now)() + self.ttl_ms,
            },
        );
        token
    }

    pub fn take(&self, connection_id: &str, pane_id: &str, token: &str) -> Option<LaunchSpec> {
        let mut launches = self.launches.lock().unwrap_or_else(|e| e.into_inner());
        self.sweep(&mut launches);
        let launch = launches.get(token)?;
        if launch.connection_id != connection_id || launch.pane_id != pane_id {
            return None;
        }
        launches.shift_remove(token).map(|launch| launch.spec)
    }
}

/// A command given as a bare program (voice.json claude_command) or a
/// profile's (`string | AgentCommand`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandOrProgram {
    Program(String),
    Command(AgentCommand),
}

/// `asCommand`: the command of a bare program, plain when it is `claude`.
pub fn as_command(command: Option<&CommandOrProgram>) -> AgentCommand {
    match command {
        None => AgentCommand::plain_claude(),
        Some(CommandOrProgram::Program(program)) => AgentCommand {
            program: program.clone(),
            plain: program == "claude",
            ..AgentCommand::plain_claude()
        },
        Some(CommandOrProgram::Command(command)) => command.clone(),
    }
}

/// Tells two commands apart (a warm helper restarts when it changes).
pub fn command_key(command: Option<&CommandOrProgram>) -> String {
    match command {
        None => String::new(),
        Some(CommandOrProgram::Program(program)) => program.clone(),
        Some(CommandOrProgram::Command(command)) => {
            let text = json!([command.program, command.env, command.unset]).to_string();
            hex::encode(Sha256::digest(text.as_bytes()))[..16].to_owned()
        }
    }
}

/// The command Roamgate's own helpers run (voice, curation): an explicit
/// program wins, else the default profile; one that cannot be used falls
/// back to plain claude, said once through `warn`.
pub fn helper_command(
    explicit: Option<&str>,
    settings: Option<&Value>,
    home: &Path,
    warned: &std::sync::atomic::AtomicBool,
    warn: impl FnOnce(&str),
) -> CommandOrProgram {
    if let Some(explicit) = explicit.filter(|explicit| !explicit.is_empty()) {
        return CommandOrProgram::Program(explicit.into());
    }
    match default_command(settings, home) {
        Ok(command) if command.plain => CommandOrProgram::Program(command.program),
        Ok(command) => CommandOrProgram::Command(command),
        Err(error) => {
            if !warned.swap(true, std::sync::atomic::Ordering::SeqCst) {
                warn(&error);
            }
            CommandOrProgram::Program("claude".into())
        }
    }
}

#[cfg(all(test, unix))]
pub(crate) mod tests;
