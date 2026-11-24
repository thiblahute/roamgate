//! The skeleton server: version, arguments and the embedded web app.

use std::future::Future;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rust_embed::RustEmbed;

pub mod cli;
pub mod families;
pub mod front;
pub mod front_tls;
pub mod owners_cmd;
pub mod reviews_cmd;

pub use families::core_families;

/// The version: `ROAMGATE_BUILD_VERSION` at build time (`cargo xtask
/// package --version`), else the workspace's.
pub const VERSION: &str = match option_env!("ROAMGATE_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// `roamgate --version`: the line `roamgate update` and the release checks
/// compare with the package's VERSION.
pub fn version_line() -> String {
    format!("roamgate {VERSION}")
}

pub const USAGE: &str = "Usage:
  roamgate [--host <addr>] [--port <n>]   serve the web app
  roamgate --version                      print the version
  roamgate --help                         print this help

Options:
  --host <addr>  listen address (env HOST, default 127.0.0.1)
  --port <n>     listen port    (env PORT, default 8787)
";

#[derive(Debug, PartialEq, Eq)]
pub enum Options {
    Version,
    Help,
    Serve {
        host: String,
        port: u16,
    },
    /// `roamgate core`: the portless core the Bun server spawns
    /// (contract/wire/core-channel.md). Not in the usage: only the server
    /// runs it.
    Core,
    /// `roamgate front [server flags]`: the Rust front with the Bun server
    /// as its core (contract/wire/core-channel.md, Stage 2). Hidden until
    /// the switch.
    Front(Vec<String>),
    /// `roamgate owners ...`: the owners table (hidden, temporary).
    Owners(Vec<String>),
    /// A CLI command a family answers (`update`, `rollback`, `herdr`):
    /// its name and the arguments after it. The Bun CLI passes these
    /// through while Rust owns the family (contract/wire/core-channel.md,
    /// CLI pass-through).
    Command(String, Vec<String>),
}

/// The CLI commands this binary answers itself, by family.
pub const FAMILY_COMMANDS: &[&str] = &[
    "update",
    "rollback",
    "herdr",
    "push",
    "activity",
    "archive",
    "history",
    "service",
    "doctor",
    "url",
    "config",
    "auth",
    "connections",
    "plugin",
    "completion",
    "reviews",
    "voice",
];

/// The commands this binary answers for one first word only, by family
/// (families.json's `setup voice`): `setup`'s other words are not ours.
pub const FAMILY_SUBCOMMANDS: &[(&str, &str)] = &[("setup", "voice")];

/// Reads the command line; `env` gives the environment's HOST and PORT.
pub fn parse_args(
    args: &[String],
    env: impl Fn(&str) -> Option<String>,
) -> Result<Options, String> {
    let mut host = env("HOST").unwrap_or_else(|| "127.0.0.1".into());
    let mut port = env("PORT").unwrap_or_else(|| "8787".into());
    match args.first().map(String::as_str) {
        Some("core") => {
            return match args.get(1) {
                None => Ok(Options::Core),
                Some(extra) => Err(format!("unknown argument {extra}")),
            };
        }
        Some("owners") => return Ok(Options::Owners(args[1..].to_vec())),
        Some("front") => return Ok(Options::Front(args[1..].to_vec())),
        Some(command) if FAMILY_COMMANDS.contains(&command) => {
            return Ok(Options::Command(command.to_owned(), args[1..].to_vec()));
        }
        Some(command)
            if FAMILY_SUBCOMMANDS.iter().any(|(name, word)| {
                *name == command && args.get(1).map(String::as_str) == Some(word)
            }) =>
        {
            return Ok(Options::Command(command.to_owned(), args[1..].to_vec()));
        }
        _ => {}
    }
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--version" | "-v" | "-V" | "version" => return Ok(Options::Version),
            "--help" | "-h" | "help" => return Ok(Options::Help),
            "--host" => host = rest.next().ok_or("--host needs a value")?.clone(),
            "--port" => port = rest.next().ok_or("--port needs a value")?.clone(),
            other => {
                if let Some(value) = other.strip_prefix("--host=") {
                    host = value.into();
                } else if let Some(value) = other.strip_prefix("--port=") {
                    port = value.into();
                } else {
                    return Err(format!("unknown argument {other}"));
                }
            }
        }
    }
    let port = port.parse().map_err(|_| format!("invalid port {port}"))?;
    Ok(Options::Serve { host, port })
}

#[derive(RustEmbed)]
#[folder = "$ROAMGATE_WEB_DIST"]
struct Web;

/// Whether the binary was built with a web app (its index.html).
pub fn has_web() -> bool {
    Web::get("index.html").is_some()
}

async fn healthz() -> Response {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        )],
        "Ok",
    )
        .into_response()
}

fn asset(path: &str) -> Option<Response> {
    let file = Web::get(path)?;
    let mime = file.metadata.mimetype().to_owned();
    let mut response = Response::new(Body::from(file.data.into_owned()));
    if let Ok(value) = HeaderValue::from_str(&mime) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Some(response)
}

/// A file of the web app, else its index.html for an app route (a path
/// whose last part has no extension).
async fn web(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(response) = asset(path) {
        return response;
    }
    let last = path.rsplit('/').next().unwrap_or_default();
    if !last.contains('.')
        && let Some(response) = asset("index.html")
    {
        return response;
    }
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

pub fn app() -> Router {
    Router::new()
        .route("/health", get(healthz))
        .route("/healthz", get(healthz))
        .fallback(get(web))
}

/// Serves until `shutdown` completes.
pub async fn serve(
    listener: tokio::net::TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, app())
        .with_graceful_shutdown(shutdown)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn version_line_is_what_update_checks() {
        assert_eq!(version_line(), format!("roamgate {VERSION}"));
        assert!(!VERSION.is_empty());
    }

    #[test]
    fn flags_override_the_environment() {
        let env = |name: &str| match name {
            "HOST" => Some("0.0.0.0".to_owned()),
            "PORT" => Some("9000".to_owned()),
            _ => None,
        };
        assert_eq!(
            parse_args(&args(&[]), env),
            Ok(Options::Serve {
                host: "0.0.0.0".into(),
                port: 9000
            })
        );
        assert_eq!(
            parse_args(&args(&["--port", "1234", "--host=::1"]), env),
            Ok(Options::Serve {
                host: "::1".into(),
                port: 1234
            })
        );
        assert_eq!(
            parse_args(&args(&[]), |_| None),
            Ok(Options::Serve {
                host: "127.0.0.1".into(),
                port: 8787
            })
        );
    }

    #[test]
    fn version_and_help_win() {
        assert_eq!(
            parse_args(&args(&["--version"]), |_| None),
            Ok(Options::Version),
        );
        assert_eq!(parse_args(&args(&["core"]), |_| None), Ok(Options::Core));
        assert_eq!(
            parse_args(&args(&["core", "x"]), |_| None),
            Err("unknown argument x".into())
        );
        assert_eq!(
            parse_args(&args(&["--port", "1", "-h"]), |_| None),
            Ok(Options::Help)
        );
        assert!(parse_args(&args(&["--port", "x"]), |_| None).is_err());
        assert!(parse_args(&args(&["--nope"]), |_| None).is_err());
        assert!(parse_args(&args(&["--port"]), |_| None).is_err());
    }

    /// A family's command goes to its family with the words after it;
    /// nothing else does (runHerdrCommand's null for other commands).
    #[test]
    fn family_commands_go_to_their_family_and_nothing_else_does() {
        assert_eq!(
            parse_args(&args(&["herdr", "status", "--socket-path", "/x"]), |_| None),
            Ok(Options::Command(
                "herdr".into(),
                args(&["status", "--socket-path", "/x"])
            ))
        );
        assert_eq!(
            parse_args(&args(&["rollback"]), |_| None),
            Ok(Options::Command("rollback".into(), vec![]))
        );
        assert_eq!(
            parse_args(&args(&["service", "install"]), |_| None),
            Ok(Options::Command("service".into(), args(&["install"])))
        );
        assert_eq!(
            parse_args(&args(&["setup", "voice", "list"]), |_| None),
            Ok(Options::Command("setup".into(), args(&["voice", "list"])))
        );
        assert!(parse_args(&args(&["setup"]), |_| None).is_err());
        assert!(parse_args(&args(&["setup", "--help"]), |_| None).is_err());
        for command in roamgate_cli::index::RUST_COMMANDS {
            assert!(FAMILY_COMMANDS.contains(command), "{command}");
        }
        assert!(matches!(
            parse_args(&args(&[]), |_| None),
            Ok(Options::Serve { .. })
        ));
    }
}
