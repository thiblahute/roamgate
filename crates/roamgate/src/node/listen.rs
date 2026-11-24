//! `roamgate node --listen <host:port> --home <origin>`: this machine's
//! node serves the browser its own connection beside the home (Mac node
//! phase 3). It is the server (`roamgate front`, its standalone core),
//! started again with the node's environment: its own data root, the
//! home's origin, one `local` connection to this machine's Herdr. Every
//! shared family and job is the home's ([`super::families`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use roamgate_base::env::Env;
use roamgate_base::node::{DATA_ROOT_ENV, NODE_CONNECTION_ID, NODE_HOME_ENV};
use serde_json::json;

/// The title suffix a node's page gets (`Roamgate · Mac`), so its PWA is
/// told apart from the home's.
pub const TITLE_SUFFIX_ENV: &str = "ROAMGATE_NODE_TITLE_SUFFIX";

const USAGE: &str = "usage: roamgate node --listen <host:port> --home <https://origin>
       [--config-dir <dir>] [--data-dir <dir>] [--label <name>]
       [--title-suffix <text>] [--socket-path <herdr.sock>]
       [--client-socket-path <herdr-client.sock>] [--log-level <level>]
       [--public-dir <dir>]
       roamgate node --stdio

Serves this machine's own connection (id `local`) to the browser beside
the home, which keeps the shared state. Its files are its own: the config
directory (default ~/.config/roamgate-node, or ROAMGATE_NODE_CONFIG_DIR)
holds its auth token (auth-token), session secret (session-secret.json)
and connection (connections.json); the data directory
(default ~/.local/share/roamgate-node, or ROAMGATE_NODE_DATA_DIR) its
temporary files. Herdr's sockets default to HERDR_SOCKET_PATH and
HERDR_CLIENT_SOCKET_PATH, else ~/.config/herdr/herdr.sock and
herdr-client.sock.
";

/// What `--listen` was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenOptions {
    pub host: String,
    pub port: u16,
    /// The home's origin: scheme, host and port, no path.
    pub home: String,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub label: String,
    pub title_suffix: String,
    pub socket_path: PathBuf,
    pub client_socket_path: PathBuf,
    pub log_level: Option<String>,
    /// The web build to serve before the one the binary carries.
    pub public_dir: Option<String>,
}

/// The origin of `url`: `http(s)://host[:port]`, no path, query or
/// trailing slash.
pub fn home_origin(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("--home {url}: {error}"))?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return Err(format!("--home {url}: an http(s) origin is needed"));
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!("--home {url}: an origin has no path"));
    }
    Ok(parsed.origin().ascii_serialization())
}

/// `host:port`, `[v6]:port`, or a port alone (loopback).
fn listen_address(value: &str) -> Result<(String, u16), String> {
    let bad = || format!("--listen {value}: expected host:port");
    let (host, port) = match value.rsplit_once(':') {
        Some((host, port)) => (host.trim_start_matches('[').trim_end_matches(']'), port),
        None => ("127.0.0.1", value),
    };
    let port = port.parse::<u16>().map_err(|_| bad())?;
    if host.is_empty() {
        return Err(bad());
    }
    Ok((host.to_owned(), port))
}

/// Reads the flags; `env` gives HOME and the directories' variables.
pub fn parse(args: &[String], env: &dyn Env) -> Result<ListenOptions, String> {
    let mut values: BTreeMap<&str, String> = BTreeMap::new();
    let mut words = args.iter();
    while let Some(word) = words.next() {
        let (name, inline) = match word.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (word.as_str(), None),
        };
        let key = match name {
            "--listen"
            | "--home"
            | "--config-dir"
            | "--data-dir"
            | "--label"
            | "--title-suffix"
            | "--socket-path"
            | "--client-socket-path"
            | "--log-level"
            | "--public-dir" => &name[2..],
            _ => return Err(format!("unknown argument {word}")),
        };
        let value = match inline {
            Some(value) => value,
            None => words
                .next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))?,
        };
        values.insert(key, value);
    }
    let home_dir = env
        .var("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .ok_or("HOME is not set")?;
    let (host, port) = listen_address(
        values
            .get("listen")
            .ok_or("--listen <host:port> is needed")?,
    )?;
    let home = home_origin(values.get("home").ok_or("--home <origin> is needed")?)?;
    let dir = |flag: &str, variable: &str, default: PathBuf| -> PathBuf {
        values
            .get(flag)
            .cloned()
            .or_else(|| env.var(variable).filter(|value| !value.is_empty()))
            .map_or(default, PathBuf::from)
    };
    let config_dir = dir(
        "config-dir",
        "ROAMGATE_NODE_CONFIG_DIR",
        home_dir.join(".config").join("roamgate-node"),
    );
    let data_dir = dir(
        "data-dir",
        "ROAMGATE_NODE_DATA_DIR",
        home_dir.join(".local").join("share").join("roamgate-node"),
    );
    for (name, path) in [("config", &config_dir), ("data", &data_dir)] {
        if !path.is_absolute() {
            return Err(format!("the {name} directory must be absolute"));
        }
    }
    let herdr = home_dir.join(".config").join("herdr");
    Ok(ListenOptions {
        host,
        port,
        home,
        config_dir,
        data_dir,
        label: values.get("label").cloned().unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "mac".into()
            } else {
                "local".into()
            }
        }),
        title_suffix: values.get("title-suffix").cloned().unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "Mac".into()
            } else {
                "node".into()
            }
        }),
        socket_path: values
            .get("socket-path")
            .cloned()
            .or_else(|| env.var("HERDR_SOCKET_PATH").filter(|path| !path.is_empty()))
            .map_or_else(|| herdr.join("herdr.sock"), PathBuf::from),
        client_socket_path: values
            .get("client-socket-path")
            .cloned()
            .or_else(|| {
                env.var("HERDR_CLIENT_SOCKET_PATH")
                    .filter(|path| !path.is_empty())
            })
            .map_or_else(|| herdr.join("herdr-client.sock"), PathBuf::from),
        log_level: values.get("log-level").cloned(),
        public_dir: values.get("public-dir").cloned(),
    })
}

/// The node's one connection: this machine's Herdr, id `local`.
pub fn connections_registry(options: &ListenOptions) -> serde_json::Value {
    json!({
        "version": 2,
        "default_connection_id": NODE_CONNECTION_ID,
        "profiles": [{
            "id": NODE_CONNECTION_ID,
            "label": options.label,
            "type": "local",
            "control_socket_path": options.socket_path.to_string_lossy(),
            "client_socket_path": options.client_socket_path.to_string_lossy(),
            "auto_connect": true,
        }],
    })
}

/// The node's environment over the process's: its data root, the home,
/// its title, no update check, its runtime files in the data directory.
pub fn environment(options: &ListenOptions) -> Vec<(String, String)> {
    let path = |path: &Path| path.to_string_lossy().into_owned();
    let mut env = vec![
        (NODE_HOME_ENV.into(), options.home.clone()),
        (DATA_ROOT_ENV.into(), path(&options.config_dir)),
        (TITLE_SUFFIX_ENV.into(), options.title_suffix.clone()),
        (
            "ROAMGATE_CONNECTIONS_PATH".into(),
            path(&options.config_dir.join("connections.json")),
        ),
        ("ROAMGATE_DISABLE_UPDATE_CHECK".into(), "1".into()),
        ("TMPDIR".into(), path(&options.data_dir.join("tmp"))),
    ];
    // The home-style variables of a shell the node was started from
    // never point it at the home's files.
    for name in [
        // The home's names of the signing secret and settings: the node
        // has `session-secret.json` and no settings of its own.
        "ROAMGATE_SETTINGS_PATH",
        "HERDR_GUI_SETTINGS_PATH",
        "ROAMGATE_WORK_DIR",
        "ROAMGATE_REVIEW_DIR",
        "ROAMGATE_HISTORY_DIR",
        "ROAMGATE_ASSISTANT_DIR",
        "ROAMGATE_NOTIFICATIONS_PATH",
        "ROAMGATE_WEB_PUSH_PATH",
        "ROAMGATE_AGENT_SEEN_PATH",
        "HERDR_SOCKET_PATH",
        "HERDR_CLIENT_SOCKET_PATH",
        "HERDR_SSH_HOST",
        "HERDR_SESSION",
    ] {
        env.push((name.into(), String::new()));
    }
    env
}

/// The server's flags for the node.
pub fn server_args(options: &ListenOptions) -> Vec<String> {
    let mut args = vec![
        "front".to_owned(),
        "--host".to_owned(),
        options.host.clone(),
        "--port".to_owned(),
        options.port.to_string(),
    ];
    if let Some(level) = &options.log_level {
        args.extend(["--log-level".to_owned(), level.clone()]);
    }
    if let Some(dir) = &options.public_dir {
        args.extend(["--public-dir".to_owned(), dir.clone()]);
    }
    args
}

/// Makes the node's directories and writes its connection.
fn prepare(options: &ListenOptions) -> Result<(), String> {
    for dir in [
        &options.config_dir,
        &options.data_dir,
        &options.data_dir.join("tmp"),
    ] {
        roamgate_base::private::create_private_dir(dir)
            .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    }
    let file = options.config_dir.join("connections.json");
    let text = serde_json::to_string_pretty(&connections_registry(options))
        .map_err(|error| error.to_string())?
        + "\n";
    let data = roamgate_base::paths::DataContext {
        root: Some(options.config_dir.clone()),
        ..roamgate_base::paths::DataContext::from_env(&roamgate_base::env::ProcessEnv)
    };
    data.replace_data_file(&file, text.as_bytes(), 0o600)
        .map_err(|error| format!("cannot write {}: {error}", file.display()))
}

/// Runs the node's server; returns the exit code.
pub async fn run(args: &[String]) -> u8 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{USAGE}");
        return 0;
    }
    let options = match parse(args, &roamgate_base::env::ProcessEnv) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("roamgate node: {message}\n\n{USAGE}");
            return 2;
        }
    };
    if let Err(message) = prepare(&options) {
        eprintln!("roamgate node: {message}");
        return 1;
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("roamgate node: cannot find this executable: {error}");
            return 1;
        }
    };
    // The server again, in a process whose environment is the node's
    // from its start: its front and core, and every reader of the
    // process environment, see the node's root and home.
    let mut command = std::process::Command::new(exe);
    command.args(server_args(&options));
    for (name, value) in environment(&options) {
        if value.is_empty() {
            command.env_remove(&name);
        } else {
            command.env(name, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("roamgate node: cannot start the server: {error}");
        1
    }
    #[cfg(not(unix))]
    match command.status() {
        Ok(status) => status.code().unwrap_or(1).clamp(0, 255) as u8,
        Err(error) => {
            eprintln!("roamgate node: cannot start the server: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_home_is_an_origin() {
        assert_eq!(
            home_origin("https://roamgate.example.ts.net/").as_deref(),
            Ok("https://roamgate.example.ts.net")
        );
        assert_eq!(
            home_origin("http://127.0.0.1:9000").as_deref(),
            Ok("http://127.0.0.1:9000")
        );
        assert!(home_origin("https://h/x").is_err());
        assert!(home_origin("ftp://h").is_err());
        assert!(home_origin("h").is_err());
    }

    #[test]
    fn a_node_s_files_are_its_own() {
        let env = [("HOME", "/Users/u")];
        let options = parse(
            &words(&[
                "--listen",
                "127.0.0.1:8787",
                "--home",
                "https://home.example/",
            ]),
            &env,
        )
        .unwrap();
        assert_eq!((options.host.as_str(), options.port), ("127.0.0.1", 8787));
        assert_eq!(options.home, "https://home.example");
        assert_eq!(
            options.config_dir,
            PathBuf::from("/Users/u/.config/roamgate-node")
        );
        assert_eq!(
            options.data_dir,
            PathBuf::from("/Users/u/.local/share/roamgate-node")
        );
        assert_eq!(
            options.socket_path,
            PathBuf::from("/Users/u/.config/herdr/herdr.sock")
        );
        let env = environment(&options);
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get(DATA_ROOT_ENV), Some("/Users/u/.config/roamgate-node"));
        assert_eq!(get(NODE_HOME_ENV), Some("https://home.example"));
        assert_eq!(get("ROAMGATE_WORK_DIR"), Some(""));
        let registry = connections_registry(&options);
        assert_eq!(registry["default_connection_id"], "local");
        assert_eq!(registry["profiles"].as_array().unwrap().len(), 1);
        assert_eq!(registry["profiles"][0]["type"], "local");
        let custom = parse(
            &words(&[
                "--listen=8790",
                "--home=https://h",
                "--config-dir",
                "/n/c",
                "--data-dir=/n/d",
            ]),
            &env_of(&[("HOME", "/h")]),
        )
        .unwrap();
        assert_eq!(custom.port, 8790);
        assert_eq!(custom.config_dir, PathBuf::from("/n/c"));
        assert_eq!(custom.data_dir, PathBuf::from("/n/d"));
        assert!(parse(&words(&["--home", "https://h"]), &env_of(&[("HOME", "/h")])).is_err());
        assert!(
            parse(
                &words(&["--listen", "1", "--home", "https://h", "--nope", "x"]),
                &env_of(&[("HOME", "/h")])
            )
            .is_err()
        );
    }

    fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }
}
