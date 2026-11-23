//! Connection profiles and their store, `connections.json`
//! (server/src/connections/profiles.ts): strict validation of local and
//! SSH profiles (exact fields, safe socket paths, OpenSSH destinations,
//! Windows bridge options), the recovery fingerprint, and a private store
//! written by rename (0600 in a 0700 directory, never through a symlink).
//!
//! The file is `JSON.stringify(registry, null, 2)` plus a newline, keys in
//! the order the TS validation builds them, so both servers write the same
//! bytes.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use roamgate_base::json_store::{JsonFormat, to_js_json};
use roamgate_base::private::{OpenMode, mode_of, open_nofollow};
use roamgate_exec::ssh::command::validate_ssh_destination;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::manager::LEGACY_DEFAULT_CONNECTION_ID;

pub const CONNECTION_PROFILE_FILE_VERSION: u64 = 2;
pub const MAX_CONNECTION_PROFILES: usize = 64;
const MAX_PROFILE_FILE_BYTES: usize = 1024 * 1024;
const MAX_LABEL_LENGTH: usize = 80;
const MAX_SOCKET_PATH_LENGTH: usize = 4096;
const CONNECTION_ID_MAX_LENGTH: usize = 128;

fn is_control(character: char) -> bool {
    let code = character as u32;
    code <= 0x1f || (0x7f..=0x9f).contains(&code)
}

/// A connection id (connections/protocol.ts `validateConnectionId`).
pub fn validate_connection_id(value: &Value) -> Result<String, String> {
    let Some(text) = value.as_str() else {
        return Err("invalid connection_id".into());
    };
    let mut characters = text.chars();
    let valid = !text.is_empty()
        && text.encode_utf16().count() <= CONNECTION_ID_MAX_LENGTH
        && characters.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid {
        return Err("invalid connection_id".into());
    }
    Ok(text.to_owned())
}

/// A local Herdr server's profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalConnectionProfile {
    pub id: String,
    pub label: String,
    pub control_socket_path: String,
    pub client_socket_path: String,
    pub auto_connect: bool,
}

/// A Herdr server reached over SSH.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConnectionProfile {
    pub id: String,
    pub label: String,
    pub ssh_destination: String,
    pub remote_control_socket_path: String,
    pub remote_client_socket_path: String,
    pub auto_connect: bool,
    /// `windows`, or None for a POSIX host.
    pub remote_platform_windows: bool,
    pub remote_herdr_path: Option<String>,
    pub remote_session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionProfile {
    Local(LocalConnectionProfile),
    Ssh(SshConnectionProfile),
}

impl ConnectionProfile {
    pub fn id(&self) -> &str {
        match self {
            Self::Local(profile) => &profile.id,
            Self::Ssh(profile) => &profile.id,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Local(profile) => &profile.label,
            Self::Ssh(profile) => &profile.label,
        }
    }

    pub fn auto_connect(&self) -> bool {
        match self {
            Self::Local(profile) => profile.auto_connect,
            Self::Ssh(profile) => profile.auto_connect,
        }
    }

    pub fn is_ssh(&self) -> bool {
        matches!(self, Self::Ssh(_))
    }

    /// The profile as stored, keys in the TS order.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Local(profile) => json!({
                "id": profile.id,
                "label": profile.label,
                "type": "local",
                "control_socket_path": profile.control_socket_path,
                "client_socket_path": profile.client_socket_path,
                "auto_connect": profile.auto_connect,
            }),
            Self::Ssh(profile) => {
                let mut value = json!({
                    "id": profile.id,
                    "label": profile.label,
                    "type": "ssh",
                    "ssh_destination": profile.ssh_destination,
                    "remote_control_socket_path": profile.remote_control_socket_path,
                    "remote_client_socket_path": profile.remote_client_socket_path,
                    "auto_connect": profile.auto_connect,
                });
                let map = value.as_object_mut().expect("an object");
                if profile.remote_platform_windows {
                    map.insert("remote_platform".into(), json!("windows"));
                }
                if let Some(path) = &profile.remote_herdr_path {
                    map.insert("remote_herdr_path".into(), json!(path));
                }
                if let Some(session) = &profile.remote_session {
                    map.insert("remote_session".into(), json!(session));
                }
                value
            }
        }
    }
}

/// The hash a recovery record keeps of what the profile connects to.
pub fn connection_recovery_fingerprint(profile: &ConnectionProfile) -> String {
    let target: Vec<Value> = match profile {
        ConnectionProfile::Local(profile) => vec![
            json!("local"),
            json!(profile.control_socket_path),
            json!(profile.client_socket_path),
        ],
        ConnectionProfile::Ssh(profile) => {
            let mut target = vec![
                json!("ssh"),
                json!(profile.ssh_destination),
                json!(profile.remote_control_socket_path),
                json!(profile.remote_client_socket_path),
            ];
            if profile.remote_platform_windows {
                // JSON.stringify writes an undefined array element as null.
                target.push(json!("windows"));
                target.push(json!(profile.remote_herdr_path));
                target.push(json!(profile.remote_session));
            }
            target
        }
    };
    let text = serde_json::to_string(&target).expect("a JSON array");
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// The saved registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedConnectionRegistry {
    pub version: u64,
    pub default_connection_id: String,
    pub profiles: Vec<ConnectionProfile>,
}

impl PersistedConnectionRegistry {
    pub fn to_value(&self) -> Value {
        json!({
            "version": self.version,
            "default_connection_id": self.default_connection_id,
            "profiles": self.profiles.iter().map(ConnectionProfile::to_value).collect::<Vec<_>>(),
        })
    }
}

/// A profile as browsers see it: with `read_only`.
pub fn public_connection_profile(profile: &ConnectionProfile, read_only: bool) -> Value {
    let mut value = profile.to_value();
    let map = value.as_object_mut().expect("an object");
    match profile {
        ConnectionProfile::Local(_) => {
            map.insert("read_only".into(), json!(read_only));
        }
        ConnectionProfile::Ssh(ssh) => {
            // read_only comes before the optional Windows fields.
            let mut ordered = Map::new();
            for (key, field) in std::mem::take(map) {
                let optional = matches!(
                    key.as_str(),
                    "remote_platform" | "remote_herdr_path" | "remote_session"
                );
                if !optional {
                    ordered.insert(key, field);
                }
            }
            ordered.insert("read_only".into(), json!(read_only));
            if ssh.remote_platform_windows {
                ordered.insert("remote_platform".into(), json!("windows"));
            }
            if let Some(path) = ssh.remote_herdr_path.as_ref().filter(|p| !p.is_empty()) {
                ordered.insert("remote_herdr_path".into(), json!(path));
            }
            if let Some(session) = ssh.remote_session.as_ref().filter(|s| !s.is_empty()) {
                ordered.insert("remote_session".into(), json!(session));
            }
            *map = ordered;
        }
    }
    value
}

fn as_object<'a>(value: &'a Value, description: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{description} must be an object"))
}

fn assert_exact_keys(
    value: &Map<String, Value>,
    keys: &[&str],
    description: &str,
    optional: &[&str],
) -> Result<(), String> {
    for key in value.keys() {
        if !keys.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(format!("{description} has unknown field: {key}"));
        }
    }
    for key in keys {
        if !value.contains_key(*key) {
            return Err(format!("{description} is missing field: {key}"));
        }
    }
    Ok(())
}

fn validate_label(value: &Value) -> Result<String, String> {
    let invalid = || "connection label is invalid".to_owned();
    let text = value.as_str().ok_or_else(invalid)?;
    let length = text.encode_utf16().count();
    if length == 0
        || length > MAX_LABEL_LENGTH
        || text.trim() != text
        || text.chars().any(is_control)
    {
        return Err(invalid());
    }
    Ok(text.to_owned())
}

fn is_windows_drive_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn is_pipe_path(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.starts_with("\\\\.\\pipe\\") || lower.starts_with("\\\\?\\pipe\\")
}

/// `path.win32.normalize` for the paths validation lets through.
fn win32_normalize(text: &str) -> String {
    if is_pipe_path(text) {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut previous_separator = false;
    for character in text.chars() {
        let separator = character == '/' || character == '\\';
        if separator {
            if !previous_separator {
                out.push('\\');
            }
        } else {
            out.push(character);
        }
        previous_separator = separator;
    }
    out.split('\\')
        .filter(|segment| *segment != ".")
        .collect::<Vec<_>>()
        .join("\\")
}

fn validate_socket_path(value: &Value, field: &str, platform: &str) -> Result<String, String> {
    let invalid = || format!("{field} must be an absolute socket path");
    let text = value.as_str().ok_or_else(invalid)?;
    let windows_path = is_windows_drive_path(text) || is_pipe_path(text);
    if text.is_empty()
        || text.encode_utf16().count() > MAX_SOCKET_PATH_LENGTH
        || text.chars().any(is_control)
        || (if platform == "win32" {
            !windows_path
        } else {
            !text.starts_with('/')
        })
    {
        return Err(invalid());
    }
    if text.split(['\\', '/']).any(|segment| segment == "..") {
        return Err(format!("{field} must not contain parent traversal"));
    }
    let normalized = if platform == "win32" {
        win32_normalize(text)
    } else {
        text.to_owned()
    };
    let native = roamgate_herdr::client::native_socket_path(&normalized, platform);
    if native.encode_utf16().count() > MAX_SOCKET_PATH_LENGTH {
        return Err(invalid());
    }
    Ok(native)
}

fn validate_common_id(map: &Map<String, Value>) -> Result<String, String> {
    let id = validate_connection_id(map.get("id").unwrap_or(&Value::Null))?;
    if id == LEGACY_DEFAULT_CONNECTION_ID {
        return Err(format!("{LEGACY_DEFAULT_CONNECTION_ID} is reserved"));
    }
    Ok(id)
}

pub fn validate_local_connection_profile(
    value: &Value,
    platform: &str,
) -> Result<LocalConnectionProfile, String> {
    let map = as_object(value, "connection profile")?;
    assert_exact_keys(
        map,
        &[
            "id",
            "label",
            "type",
            "control_socket_path",
            "client_socket_path",
            "auto_connect",
        ],
        "connection profile",
        &[],
    )?;
    let id = validate_common_id(map)?;
    if map.get("type").and_then(Value::as_str) != Some("local") {
        return Err("only local connection profiles are supported".into());
    }
    let Some(auto_connect) = map.get("auto_connect").and_then(Value::as_bool) else {
        return Err("auto_connect must be a boolean".into());
    };
    Ok(LocalConnectionProfile {
        id,
        label: validate_label(&map["label"])?,
        control_socket_path: validate_socket_path(
            &map["control_socket_path"],
            "control_socket_path",
            platform,
        )?,
        client_socket_path: validate_socket_path(
            &map["client_socket_path"],
            "client_socket_path",
            platform,
        )?,
        auto_connect,
    })
}

fn validate_remote_socket_path(value: &Value, field: &str) -> Result<String, String> {
    let invalid = || format!("{field} must be a short absolute POSIX socket path");
    let text = value.as_str().ok_or_else(invalid)?;
    // An empty path asks for the default Herdr sockets under the remote home.
    if text.is_empty() {
        return Ok(String::new());
    }
    if text.encode_utf16().count() < 2
        || text.len() > 100
        || !text.starts_with('/')
        || !text.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || text.contains([':', '\\'])
    {
        return Err(invalid());
    }
    let segments: Vec<&str> = text.split('/').skip(1).collect();
    let bad_segment = |segment: &&str| {
        segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || !segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'@' | b'%' | b'=' | b'-')
            })
    };
    if segments.is_empty() || segments.iter().any(bad_segment) {
        return Err(invalid());
    }
    Ok(text.to_owned())
}

fn valid_remote_herdr_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.encode_utf16().count() <= 1024
        && bytes.len() >= 4
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
        && text.to_ascii_lowercase().ends_with(".exe")
        && text[3..text.len() - 4].chars().count() >= 1
        && !text[3..].chars().any(is_control)
        && !text.split(['\\', '/']).any(|segment| segment == "..")
}

fn valid_remote_session(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub fn validate_ssh_connection_profile(value: &Value) -> Result<SshConnectionProfile, String> {
    let map = as_object(value, "connection profile")?;
    assert_exact_keys(
        map,
        &[
            "id",
            "label",
            "type",
            "ssh_destination",
            "remote_control_socket_path",
            "remote_client_socket_path",
            "auto_connect",
        ],
        "connection profile",
        &["remote_platform", "remote_herdr_path", "remote_session"],
    )?;
    let id = validate_common_id(map)?;
    if map.get("type").and_then(Value::as_str) != Some("ssh") {
        return Err("invalid connection profile type".into());
    }
    let Some(auto_connect) = map.get("auto_connect").and_then(Value::as_bool) else {
        return Err("auto_connect must be a boolean".into());
    };
    let control = validate_remote_socket_path(
        &map["remote_control_socket_path"],
        "remote_control_socket_path",
    )?;
    let client = validate_remote_socket_path(
        &map["remote_client_socket_path"],
        "remote_client_socket_path",
    )?;
    let platform = map.get("remote_platform");
    let windows = platform.and_then(Value::as_str) == Some("windows");
    if platform.is_some() && !windows {
        return Err("invalid remote_platform".into());
    }
    let herdr_path = map.get("remote_herdr_path");
    let session = map.get("remote_session");
    if !windows && (herdr_path.is_some() || session.is_some()) {
        return Err("Windows SSH options require remote_platform windows".into());
    }
    if windows && (!control.is_empty() || !client.is_empty()) {
        return Err("Windows SSH uses Herdr bridges instead of remote socket paths".into());
    }
    if let Some(path) = herdr_path
        && !path.as_str().is_some_and(valid_remote_herdr_path)
    {
        return Err("remote_herdr_path must be an absolute Windows executable path".into());
    }
    if let Some(session) = session
        && !session.as_str().is_some_and(valid_remote_session)
    {
        return Err("remote_session must be a valid Herdr session name".into());
    }
    if !control.is_empty() && !client.is_empty() && control == client {
        return Err("remote control and render socket paths must differ".into());
    }
    let destination = map
        .get("ssh_destination")
        .and_then(Value::as_str)
        .ok_or_else(|| "ssh_destination must be an OpenSSH alias or user@host".to_owned())?;
    let destination = validate_ssh_destination(destination).map_err(|error| error.to_string())?;
    Ok(SshConnectionProfile {
        id,
        label: validate_label(&map["label"])?,
        ssh_destination: destination.to_owned(),
        remote_control_socket_path: control,
        remote_client_socket_path: client,
        auto_connect,
        remote_platform_windows: windows,
        remote_herdr_path: herdr_path.and_then(Value::as_str).map(str::to_owned),
        remote_session: session.and_then(Value::as_str).map(str::to_owned),
    })
}

pub fn validate_connection_profile(
    value: &Value,
    platform: &str,
) -> Result<ConnectionProfile, String> {
    let map = as_object(value, "connection profile")?;
    match map.get("type").and_then(Value::as_str) {
        Some("local") => {
            validate_local_connection_profile(value, platform).map(ConnectionProfile::Local)
        }
        Some("ssh") => validate_ssh_connection_profile(value).map(ConnectionProfile::Ssh),
        _ => Err("invalid connection profile type".into()),
    }
}

/// This machine's platform as Node names it.
pub fn current_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub fn validate_connection_registry(value: &Value) -> Result<PersistedConnectionRegistry, String> {
    let map = as_object(value, "connection registry")?;
    assert_exact_keys(
        map,
        &["version", "default_connection_id", "profiles"],
        "connection registry",
        &[],
    )?;
    let version = match map["version"].as_u64() {
        Some(version @ (1 | CONNECTION_PROFILE_FILE_VERSION))
            if map["version"].as_f64() == Some(version as f64) =>
        {
            version
        }
        _ => return Err("unsupported connection registry version".into()),
    };
    let profiles = match map["profiles"].as_array() {
        Some(profiles) if !profiles.is_empty() => profiles,
        _ => return Err("connection registry must contain at least one profile".into()),
    };
    if profiles.len() > MAX_CONNECTION_PROFILES {
        return Err("connection registry contains too many profiles".into());
    }
    let platform = current_platform();
    let profiles = profiles
        .iter()
        .map(|profile| {
            if version == 1 {
                validate_local_connection_profile(profile, platform).map(ConnectionProfile::Local)
            } else {
                validate_connection_profile(profile, platform)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = std::collections::HashSet::new();
    for profile in &profiles {
        if !ids.insert(profile.id().to_owned()) {
            return Err(format!("duplicate connection profile: {}", profile.id()));
        }
    }
    let default_connection_id = validate_connection_id(&map["default_connection_id"])?;
    if !ids.contains(&default_connection_id) {
        return Err("default connection profile does not exist".into());
    }
    Ok(PersistedConnectionRegistry {
        version,
        default_connection_id,
        profiles,
    })
}

fn is_symlink(path: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn assert_not_symlink(path: &Path) -> Result<(), String> {
    if is_symlink(path).map_err(|error| error.to_string())? {
        return Err("connection registry path contains a symlink".into());
    }
    Ok(())
}

fn parent_of(path: &Path) -> PathBuf {
    roamgate_base::paths::dirname(path)
}

/// Runs between writing the temporary file and renaming it (tests).
pub type BeforeRename = Box<dyn Fn(&Path, &Path) -> Result<(), String> + Send + Sync>;

/// `connections.json`'s store; writes go one at a time.
pub struct ConnectionProfileStore {
    path: PathBuf,
    /// The default path (not an override): permissions may be repaired.
    can_harden: bool,
    before_rename: Option<BeforeRename>,
    write: Mutex<()>,
    data: Option<roamgate_base::paths::DataContext>,
}

impl std::fmt::Debug for ConnectionProfileStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionProfileStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl ConnectionProfileStore {
    /// A store at `path`; `can_harden` is true for the default path only
    /// (no `ROAMGATE_CONNECTIONS_PATH`, no explicit path).
    pub fn new(
        path: PathBuf,
        can_harden: bool,
        data: Option<roamgate_base::paths::DataContext>,
    ) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("connection registry path must be absolute".into());
        }
        Ok(Self {
            path,
            can_harden,
            before_rename: None,
            write: Mutex::new(()),
            data,
        })
    }

    /// A store at an explicit path (no repair of permissions).
    pub fn at(path: PathBuf) -> Result<Self, String> {
        Self::new(path, false, None)
    }

    pub fn with_before_rename(mut self, hook: BeforeRename) -> Self {
        self.before_rename = Some(hook);
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<PersistedConnectionRegistry>, String> {
        let text = |error: io::Error| error.to_string();
        assert_not_symlink(&self.path)?;
        if std::fs::symlink_metadata(&self.path).is_err() {
            return Ok(None);
        }
        let parent = parent_of(&self.path);
        assert_not_symlink(&parent)?;
        let parent_meta = std::fs::symlink_metadata(&parent).map_err(text)?;
        if !parent_meta.is_dir() {
            return Err("connection registry parent is not a directory".into());
        }
        let mut file = open_nofollow(&self.path, OpenMode::Read).map_err(text)?;
        let meta = file.metadata().map_err(text)?;
        if !meta.is_file() {
            return Err("connection registry must be a regular file".into());
        }
        if !cfg!(windows) && ((mode_of(&parent_meta) & 0o077) != 0 || (mode_of(&meta) & 0o077) != 0)
        {
            if !self.can_harden {
                return Err("connection registry permissions must be 0700/0600".into());
            }
            roamgate_base::private::set_mode(&parent, 0o700).map_err(text)?;
            roamgate_base::private::set_file_mode(&file, 0o600).map_err(text)?;
        }
        if meta.len() as usize > MAX_PROFILE_FILE_BYTES {
            return Err("connection registry is too large".into());
        }
        let mut raw = Vec::new();
        (&mut file)
            .take(MAX_PROFILE_FILE_BYTES as u64 + 1)
            .read_to_end(&mut raw)
            .map_err(text)?;
        if raw.len() > MAX_PROFILE_FILE_BYTES {
            return Err("connection registry is too large".into());
        }
        let parsed: Value = serde_json::from_slice(&raw)
            .map_err(|_| "connection registry is not valid JSON".to_owned())?;
        validate_connection_registry(&parsed).map(Some)
    }

    pub fn save(&self, registry: &PersistedConnectionRegistry) -> Result<(), String> {
        let validated = validate_connection_registry(&registry.to_value())?;
        let _guard = self.write.lock().expect("connections store");
        self.write_atomic(&validated)
    }

    /// Removes the file; the default path also leaves the marker that keeps
    /// a cleared legacy copy from coming back.
    pub fn clear(&self) -> Result<(), String> {
        let text = |error: io::Error| error.to_string();
        let _guard = self.write.lock().expect("connections store");
        let parent = parent_of(&self.path);
        assert_not_symlink(&parent)?;
        let Ok(parent_meta) = std::fs::symlink_metadata(&parent) else {
            if std::fs::symlink_metadata(&self.path).is_err() {
                return Ok(());
            }
            return Err("connection registry parent does not exist".into());
        };
        if !parent_meta.is_dir() {
            return Err("connection registry parent is not a directory".into());
        }
        if !cfg!(windows) && (mode_of(&parent_meta) & 0o077) != 0 {
            if !self.can_harden {
                return Err("connection registry parent permissions must be 0700".into());
            }
            roamgate_base::private::set_mode(&parent, 0o700).map_err(text)?;
        }
        assert_not_symlink(&self.path)?;
        if std::fs::symlink_metadata(&self.path).is_err() {
            return Ok(());
        }
        if self.can_harden {
            let marker = PathBuf::from(format!("{}.legacy-cleared", self.path.display()));
            match &self.data {
                Some(data) => data
                    .publish_data_file(&marker, b"1\n", 0o600)
                    .map_err(text)?,
                None => std::fs::write(&marker, b"1\n").map_err(text)?,
            }
        }
        std::fs::remove_file(&self.path).map_err(text)?;
        sync_directory(&parent);
        Ok(())
    }

    fn write_atomic(&self, registry: &PersistedConnectionRegistry) -> Result<(), String> {
        let text = |error: io::Error| error.to_string();
        let payload =
            to_js_json(&registry.to_value(), JsonFormat::Pretty).map_err(|e| e.to_string())?;
        if payload.len() > MAX_PROFILE_FILE_BYTES {
            return Err("connection registry is too large".into());
        }
        let parent = parent_of(&self.path);
        assert_not_symlink(&parent)?;
        let existed = std::fs::symlink_metadata(&parent).is_ok();
        roamgate_base::private::create_dir_all_mode(&parent).map_err(text)?;
        assert_not_symlink(&parent)?;
        let parent_meta = std::fs::symlink_metadata(&parent).map_err(text)?;
        if !parent_meta.is_dir() {
            return Err("connection registry parent is not a directory".into());
        }
        if !cfg!(windows) {
            if existed && (mode_of(&parent_meta) & 0o077) != 0 && !self.can_harden {
                return Err("connection registry parent permissions must be 0700".into());
            }
            roamgate_base::private::set_mode(&parent, 0o700).map_err(text)?;
        }
        assert_not_symlink(&self.path)?;
        let temporary = parent.join(format!(
            ".connections.json.{}.{}.tmp",
            std::process::id(),
            roamgate_base::paths::random_uuid()
        ));
        let result = (|| -> Result<(), String> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&temporary).map_err(text)?;
            file.write_all(payload.as_bytes()).map_err(text)?;
            file.sync_all().map_err(text)?;
            drop(file);
            if let Some(hook) = &self.before_rename {
                hook(&temporary, &self.path)?;
            }
            assert_not_symlink(&self.path)?;
            std::fs::rename(&temporary, &self.path).map_err(text)?;
            let _ = roamgate_base::private::set_mode(&self.path, 0o600);
            sync_directory(&parent);
            Ok(())
        })();
        let _ = std::fs::remove_file(&temporary);
        result
    }
}

fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(directory) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = directory;
}

#[cfg(test)]
mod tests;
