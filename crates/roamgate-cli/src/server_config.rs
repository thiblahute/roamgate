//! The server's configuration from its flags and environment
//! (config/server-config `loadServerConfig`): what a management command
//! that reads it (`roamgate herdr`) validates, with the same messages and
//! exit codes, and the generated login token it creates when no password
//! is set. The listener itself is the front's (phase 7).

use std::path::{Path, PathBuf};

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::log::LogLevel;
use roamgate_base::paths::{DataContext, DataFile, Platform};
use roamgate_herdr::client::native_socket_path;
use sha2::{Digest, Sha256};

use crate::auth_token::load_or_create_auth_token;
use crate::output::Printed;

/// `roamgate --help`'s server part as printed (contract/cli/help/server.txt).
const SERVER_OPTIONS_PRINTED: &str = include_str!("../../../contract/cli/help/server.txt");

/// serverOptionsHelp: the server's options, as the top-level help ends.
pub fn server_options_help() -> &'static str {
    SERVER_OPTIONS_PRINTED
        .strip_suffix('\n')
        .unwrap_or(SERVER_OPTIONS_PRINTED)
}

/// `roamgate --help` of the server alone (serverHelp), as printed.
pub fn server_help_printed() -> String {
    format!(
        "Roamgate \u{2014} Web and PWA client for Herdr\n\nUsage: roamgate [options]\n\n{SERVER_OPTIONS_PRINTED}"
    )
}

/// The server flags `parseArgs` knows: name, whether it takes a value, its
/// short letter.
const SERVER_FLAGS: &[(&str, bool, Option<char>)] = &[
    ("host", true, None),
    ("port", true, None),
    ("password", true, None),
    ("tls-cert", true, None),
    ("tls-key", true, None),
    ("socket-path", true, None),
    ("client-socket-path", true, None),
    ("ssh-host", true, None),
    ("session", true, None),
    ("public-dir", true, None),
    ("log-level", true, None),
    ("notification-source", true, None),
    ("profile", false, None),
    ("profile-duration", true, None),
    ("profile-dir", true, None),
    ("open", false, None),
    ("help", false, Some('h')),
    ("version", false, Some('V')),
];

pub type Flags = Vec<(String, Option<String>)>;

/// The server flags given, strictly as `parseArgs` reads them (no
/// positionals): values by name, or Bun's message.
pub fn parse_server_flags(args: &[String]) -> Result<Flags, String> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            if let Some(next) = args.get(index) {
                return Err(format!(
                    "Unexpected argument '{next}'. This command does not take positional arguments"
                ));
            }
            break;
        }
        let (name, inline) = if let Some(long) = arg.strip_prefix("--") {
            match long.split_once('=') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (long.to_owned(), None),
            }
        } else if let Some(short) = arg.strip_prefix('-').filter(|short| !short.is_empty()) {
            let letter = short.chars().next().unwrap();
            match SERVER_FLAGS
                .iter()
                .find(|(_, _, flag)| *flag == Some(letter))
            {
                Some((name, _, _)) if short.len() == 1 => ((*name).to_owned(), None),
                _ => return Err(format!("Unknown option '-{letter}'")),
            }
        } else {
            return Err(format!(
                "Unexpected argument '{arg}'. This command does not take positional arguments"
            ));
        };
        let Some((_, takes_value, _)) = SERVER_FLAGS.iter().find(|(flag, _, _)| *flag == name)
        else {
            return Err(format!("Unknown option '--{name}'"));
        };
        if *takes_value {
            let value = match inline {
                Some(value) => value,
                None => match args.get(index) {
                    None => return Err(format!("Option '--{name} <value>' argument missing")),
                    Some(next) if next.starts_with('-') => {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    Some(next) => {
                        index += 1;
                        next.clone()
                    }
                },
            };
            values.push((name, Some(value)));
        } else {
            if inline.is_some() {
                return Err(format!("Option '--{name}' does not take an argument"));
            }
            values.push((name, None));
        }
    }
    Ok(values)
}

fn flag(flags: &Flags, name: &str) -> Option<String> {
    flags
        .iter()
        .rev()
        .find(|(flag, _)| flag == name)
        .and_then(|(_, value)| value.clone())
}

fn has_flag(flags: &Flags, name: &str) -> bool {
    flags.iter().any(|(flag, _)| flag == name)
}

/// Herdr's configuration directory.
pub fn herdr_config_dir(platform: &str, app_data: Option<&Path>, home: &Path) -> PathBuf {
    if platform == "win32" {
        return app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("herdr");
    }
    home.join(".config").join("herdr")
}

/// The local end of an SSH connection's tunnelled socket: a short
/// deterministic name in the temporary directory.
pub fn remote_tunnel_local_path(
    tmp: &Path,
    host: Option<&str>,
    session: Option<&str>,
    kind: &str,
) -> String {
    let key = hex::encode(Sha256::digest(
        format!(
            "{}\0{}\0{kind}",
            host.unwrap_or("remote"),
            session.unwrap_or("default")
        )
        .as_bytes(),
    ));
    tmp.join(format!("roamgate-{}-{kind}.sock", &key[..12]))
        .display()
        .to_string()
}

/// Settings of [`resolve_herdr_socket_paths`].
#[derive(Debug, Clone, Default)]
pub struct HerdrSocketSettings {
    pub socket_path: Option<String>,
    pub client_socket_path: Option<String>,
    pub ssh_host: Option<String>,
    pub session: Option<String>,
    pub herdr_dir: PathBuf,
    pub tmp: PathBuf,
    pub platform: String,
}

/// The control and render sockets from merged settings: explicit paths,
/// else the SSH tunnel's, else the session layout.
pub fn resolve_herdr_socket_paths(settings: &HerdrSocketSettings) -> (String, String) {
    let one = |explicit: &Option<String>, kind: &str| {
        if let Some(explicit) = explicit.as_deref().filter(|path| !path.is_empty()) {
            return native_socket_path(explicit, &settings.platform);
        }
        if settings.ssh_host.is_some() {
            return remote_tunnel_local_path(
                &settings.tmp,
                settings.ssh_host.as_deref(),
                settings.session.as_deref(),
                kind,
            );
        }
        let name = if kind == "control" {
            "herdr.sock"
        } else {
            "herdr-client.sock"
        };
        let path = match &settings.session {
            Some(session) => settings.herdr_dir.join("sessions").join(session).join(name),
            None => settings.herdr_dir.join(name),
        };
        native_socket_path(
            &roamgate_base::paths::resolve(&path).display().to_string(),
            &settings.platform,
        )
    };
    (
        one(&settings.socket_path, "control"),
        one(&settings.client_socket_path, "client"),
    )
}

/// `getLanIPs`: the IPv4 addresses of the interfaces that are up, not the
/// loopback, by interface as `os.networkInterfaces` lists them.
pub fn get_lan_ips() -> Vec<String> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut names: Vec<&str> = Vec::new();
    for interface in &interfaces {
        if !names.contains(&interface.name.as_str()) {
            names.push(&interface.name);
        }
    }
    names
        .iter()
        .flat_map(|name| interfaces.iter().filter(move |i| i.name == *name))
        .filter(|interface| interface.is_oper_up() && !interface.is_loopback())
        .filter_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(ip) => Some(ip.to_string()),
            std::net::IpAddr::V6(_) => None,
        })
        .collect()
}

pub fn is_any_host(host: &str) -> bool {
    host == "0.0.0.0" || host == "::"
}

/// The URL a browser on this machine opens.
pub fn browser_url_for(host: &str, port: u16, tls: bool) -> String {
    let host = if is_any_host(host) || host == "127.0.0.1" || host == "::1" {
        "localhost".to_owned()
    } else if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    format!("{}://{host}:{port}", if tls { "https" } else { "http" })
}

/// `--log-level`, else ROAMGATE_LOG_LEVEL, else info.
pub fn resolve_server_log_level(cli: Option<&str>, env: Option<&str>) -> Result<LogLevel, String> {
    roamgate_base::log::parse_log_level(cli.or(env).unwrap_or("info"))
        .map_err(|error| error.to_string())
}

/// A CPU profile's capture.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileConfig {
    pub directory: PathBuf,
    pub duration_ms: u64,
}

pub fn resolve_server_profile(
    enabled: bool,
    duration: Option<&str>,
    directory: Option<&str>,
    data_root: &Path,
) -> Result<Option<ProfileConfig>, String> {
    if !enabled {
        return Ok(None);
    }
    let seconds = roamgate_base::settings::sections::js_string_to_number(duration.unwrap_or("30"));
    if seconds.fract() != 0.0 || !(1.0..=300.0).contains(&seconds) {
        return Err("--profile-duration must be an integer from 1 to 300 seconds.".into());
    }
    if let Some(directory) = directory
        && directory.trim().is_empty()
    {
        return Err("--profile-dir must not be empty.".into());
    }
    let directory = directory
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("profiles"));
    Ok(Some(ProfileConfig {
        directory: roamgate_base::paths::resolve(&directory),
        duration_ms: seconds as u64 * 1000,
    }))
}

/// A read error as Bun's `readFileSync` words it.
fn read_error(error: &std::io::Error, path: &str) -> String {
    let (code, text) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(1) => ("EPERM", "operation not permitted"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(40) => ("ELOOP", "too many symbolic links encountered"),
        Some(21) => return "EISDIR: illegal operation on a directory, read".into(),
        _ => return error.to_string(),
    };
    format!("{code}: {text}, open '{path}'")
}

fn read_file(path: &str) -> Result<Vec<u8>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        // A directory opens, then fails to read, as in Bun.
        Err(error) => Err(read_error(&error, path)),
    }
}

const NO_START_LINE: &str = "error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE";
const BAD_BASE64: &str = "error:09000064:PEM routines:OPENSSL_internal:BAD_BASE64_DECODE";
const KEY_VALUES_MISMATCH: &str =
    "error:0b000074:X.509 certificate routines:OPENSSL_internal:KEY_VALUES_MISMATCH";

/// The PEM files of native TLS, checked as `createSecureContext` checks
/// them (BoringSSL's reasons for the usual failures).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsConfig {
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
}

fn check_tls(cert: &[u8], key: &[u8]) -> Result<(), String> {
    use rustls::pki_types::pem::{Error as PemError, PemObject};
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let pem_error = |error: PemError| match error {
        PemError::NoItemsFound => NO_START_LINE.to_owned(),
        _ => BAD_BASE64.to_owned(),
    };
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert)
        .collect::<Result<_, _>>()
        .map_err(pem_error)?;
    if chain.is_empty() {
        return Err(NO_START_LINE.into());
    }
    let key = PrivateKeyDer::from_pem_slice(key).map_err(pem_error)?;
    // A key ring cannot use is still a key BoringSSL loads: only a key it
    // can check is held to the certificate.
    if let Ok(signing) = rustls::crypto::ring::sign::any_supported_type(&key) {
        let certified = rustls::sign::CertifiedKey::new(chain, signing);
        if let Err(rustls::Error::InconsistentKeys(_)) = certified.keys_match() {
            return Err(KEY_VALUES_MISMATCH.into());
        }
    }
    Ok(())
}

/// `--tls-cert`/`--tls-key` (or their variables): both or neither, readable
/// PEM files whose key matches the certificate.
pub fn load_server_tls(cert: Option<&str>, key: Option<&str>) -> Result<Option<TlsConfig>, String> {
    let cert = cert.filter(|path| !path.is_empty());
    let key = key.filter(|path| !path.is_empty());
    let (cert, key) = match (cert, key) {
        (None, None) => return Ok(None),
        (Some(cert), Some(key)) => (cert, key),
        _ => {
            return Err("TLS requires both --tls-cert and --tls-key (or ROAMGATE_TLS_CERT and ROAMGATE_TLS_KEY).".into());
        }
    };
    let loaded = (|| {
        let tls = TlsConfig {
            cert: read_file(cert)?,
            key: read_file(key)?,
        };
        check_tls(&tls.cert, &tls.key)?;
        Ok::<_, String>(tls)
    })();
    loaded
        .map(Some)
        .map_err(|message| format!("Invalid TLS configuration: {message}"))
}

/// `Invalid notification source` unless herdr or status.
pub fn parse_task_notification_source(value: Option<&str>) -> Result<String, String> {
    let normalized = value.unwrap_or("herdr").trim().to_lowercase();
    if normalized == "herdr" || normalized == "status" {
        return Ok(normalized);
    }
    Err(format!(
        "Invalid notification source \"{}\" (expected herdr or status)",
        value.unwrap_or("undefined")
    ))
}

pub use roamgate_base::credentials::{assert_valid_auth_password, assert_valid_auth_pin};

/// Where the process runs: what `homedir()`, `tmpdir()` and
/// `process.platform` give the TS code.
#[derive(Debug, Clone)]
pub struct ConfigRuntime {
    pub platform: String,
    pub home: PathBuf,
    pub app_data: Option<PathBuf>,
    pub tmp: PathBuf,
}

impl ConfigRuntime {
    pub fn data(&self) -> DataContext {
        DataContext::new(
            self.home.clone(),
            if self.platform == "win32" {
                Platform::Windows
            } else {
                Platform::Unix
            },
            self.app_data.clone(),
        )
    }
}

/// The server's configuration (ServerConfig), what management commands
/// read of it.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub host: String,
    pub port: String,
    pub password: String,
    pub auth_required: bool,
    pub pin: Option<String>,
    pub tls: Option<TlsConfig>,
    pub generated_auth_token: Option<String>,
    pub generated_auth_token_path: Option<PathBuf>,
    pub socket_path: String,
    pub client_socket_path: String,
    pub ssh_host: Option<String>,
    pub session: Option<String>,
    pub log_level: LogLevel,
    pub task_notification_source: String,
    pub profile: Option<ProfileConfig>,
    pub has_explicit_socket_path: bool,
    pub has_explicit_client_socket_path: bool,
}

/// `loadServerConfig` ended the process: what it printed and its code.
pub type ConfigExit = Printed;

fn bridge_exit(message: &str, code: i32) -> ConfigExit {
    let mut printed = Printed::default();
    printed.error(&format!("[bridge] {message}"));
    printed.exit(code)
}

/// Reads the server's flags (`args`, the words after the command) and
/// environment as `loadServerConfig` does, creating the generated login
/// token when it needs one; or what it prints and the code it exits with.
pub fn load_server_config(
    args: &[String],
    env: &dyn Env,
    runtime: &ConfigRuntime,
    version: &str,
) -> Result<ServerConfig, ConfigExit> {
    let flags = parse_server_flags(args).map_err(|message| {
        let mut printed = Printed::default();
        printed.error(&format!("[bridge] {message}"));
        printed.error("Run `roamgate --help` for usage.");
        printed.exit(2)
    })?;
    if has_flag(&flags, "help") {
        let mut printed = Printed::default();
        printed.stdout.push_str(&server_help_printed());
        return Err(printed.exit(0));
    }
    if has_flag(&flags, "version") {
        let mut printed = Printed::default();
        printed.log(&format!("roamgate {version}"));
        return Err(printed.exit(0));
    }
    let log_level = resolve_server_log_level(
        flag(&flags, "log-level").as_deref(),
        roamgate_env(env, "LOG_LEVEL").as_deref(),
    )
    .map_err(|message| bridge_exit(&message, 2))?;
    let task_notification_source = parse_task_notification_source(
        flag(&flags, "notification-source")
            .or_else(|| roamgate_env(env, "NOTIFICATION_SOURCE"))
            .as_deref(),
    )
    .map_err(|message| bridge_exit(&message, 2))?;
    let data = runtime.data();
    let profile = resolve_server_profile(
        has_flag(&flags, "profile") || roamgate_env(env, "PROFILE").as_deref() == Some("1"),
        flag(&flags, "profile-duration")
            .or_else(|| roamgate_env(env, "PROFILE_DURATION"))
            .as_deref(),
        flag(&flags, "profile-dir")
            .or_else(|| roamgate_env(env, "PROFILE_DIR"))
            .as_deref(),
        &data.data_root(),
    )
    .map_err(|message| bridge_exit(&message, 2))?;
    let host = flag(&flags, "host")
        .or_else(|| env.var("HOST"))
        .unwrap_or_else(|| "127.0.0.1".into());
    let port = flag(&flags, "port")
        .or_else(|| env.var("PORT"))
        .unwrap_or_else(|| "8787".into());
    // The running process's NODE_ENV, never the build's.
    let auth_required = env.var("NODE_ENV").as_deref() != Some("development")
        || !["127.0.0.1", "localhost", "::1"].contains(&host.as_str());
    let tls = load_server_tls(
        flag(&flags, "tls-cert")
            .or_else(|| roamgate_env(env, "TLS_CERT"))
            .as_deref(),
        flag(&flags, "tls-key")
            .or_else(|| roamgate_env(env, "TLS_KEY"))
            .as_deref(),
    )
    .map_err(|message| bridge_exit(&message, 2))?;
    let pin = roamgate_env(env, "PIN").filter(|pin| !pin.is_empty());
    if let Some(pin) = &pin {
        assert_valid_auth_pin(pin).map_err(|message| bridge_exit(&message, 2))?;
    }
    let configured_password = flag(&flags, "password")
        .or_else(|| roamgate_env(env, "PASSWORD"))
        .unwrap_or_default();
    if auth_required && !configured_password.is_empty() {
        assert_valid_auth_password(&configured_password)
            .map_err(|message| bridge_exit(&message, 2))?;
    }
    let (generated_auth_token, generated_auth_token_path) = if auth_required
        && configured_password.is_empty()
    {
        let loaded = data
            .default_data_file(DataFile::AuthToken)
            .map_err(|error| error.to_string())
            .and_then(|path| load_or_create_auth_token(&data, &path).map(|token| (token, path)));
        match loaded {
            Ok((token, path)) => (Some(token), Some(path)),
            Err(message) => {
                return Err(bridge_exit(
                    &format!("FATAL: could not load the generated auth token: {message}"),
                    1,
                ));
            }
        }
    } else {
        (None, None)
    };
    let password = if auth_required {
        if configured_password.is_empty() {
            generated_auth_token.clone().unwrap_or_default()
        } else {
            configured_password
        }
    } else {
        String::new()
    };
    let nonempty = |value: Option<String>| value.filter(|value| !value.is_empty());
    let ssh_host =
        nonempty(flag(&flags, "ssh-host")).or_else(|| nonempty(env.var("HERDR_SSH_HOST")));
    if let Some(host) = &ssh_host {
        roamgate_exec::ssh::command::validate_ssh_destination(host)
            .map_err(|error| bridge_exit(&error.to_string(), 2))?;
        if runtime.platform == "win32" {
            return Err(bridge_exit(
                "SSH connections from Windows are not supported because Roamgate's stream-local forwarding cannot create a local Windows named pipe",
                2,
            ));
        }
    }
    let session = nonempty(flag(&flags, "session")).or_else(|| nonempty(env.var("HERDR_SESSION")));
    let socket_flag = flag(&flags, "socket-path");
    let client_flag = flag(&flags, "client-socket-path");
    let has_explicit_socket_path =
        socket_flag.is_some() || nonempty(env.var("HERDR_SOCKET_PATH")).is_some();
    let has_explicit_client_socket_path =
        client_flag.is_some() || nonempty(env.var("HERDR_CLIENT_SOCKET_PATH")).is_some();
    let (socket_path, client_socket_path) = resolve_herdr_socket_paths(&HerdrSocketSettings {
        socket_path: nonempty(socket_flag.clone()).or_else(|| env.var("HERDR_SOCKET_PATH")),
        client_socket_path: nonempty(client_flag.clone())
            .or_else(|| env.var("HERDR_CLIENT_SOCKET_PATH")),
        ssh_host: ssh_host.clone(),
        session: session.clone(),
        herdr_dir: herdr_config_dir(
            &runtime.platform,
            runtime.app_data.as_deref(),
            &runtime.home,
        ),
        tmp: runtime.tmp.clone(),
        platform: runtime.platform.clone(),
    });
    // An explicit empty flag is still explicit.
    let socket_path = if socket_flag.as_deref() == Some("") {
        native_socket_path("", &runtime.platform)
    } else {
        socket_path
    };
    let client_socket_path = if client_flag.as_deref() == Some("") {
        native_socket_path("", &runtime.platform)
    } else {
        client_socket_path
    };
    Ok(ServerConfig {
        host,
        port,
        password,
        auth_required,
        pin,
        tls,
        generated_auth_token,
        generated_auth_token_path,
        socket_path,
        client_socket_path,
        ssh_host,
        session,
        log_level,
        task_notification_source,
        profile,
        has_explicit_socket_path,
        has_explicit_client_socket_path,
    })
}

#[cfg(test)]
mod tests;
