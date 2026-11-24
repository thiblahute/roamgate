//! The `roamgate` binary's library: its version, command line and the web
//! build it carries; the server is [`front`], the core its families.

use rust_embed::RustEmbed;

pub mod cli;
pub mod families;
pub mod front;
pub mod front_tls;
pub mod owners_cmd;
pub mod reviews_cmd;

pub use families::{core_families, standalone_families};

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

#[derive(Debug, PartialEq, Eq)]
pub enum Options {
    /// `roamgate [server flags]`: the server (no arguments, or a first
    /// word that is a flag); `roamgate front [server flags]` is its hidden
    /// alias. Its flags are the front's to read ([`front::run`]): `--help`
    /// and `--version` too, as the Bun server's `loadServerConfig`.
    Server(Vec<String>),
    /// `roamgate core`: the portless core the front (or the Bun server)
    /// spawns (contract/wire/core-channel.md). Not in the usage: only the
    /// server runs it.
    Core,
    /// `roamgate owners ...`: the owners table (hidden, temporary).
    Owners(Vec<String>),
    /// A management command (`roamgate <command> [arguments]`, `help`
    /// included): its name and the words after it.
    Command(String, Vec<String>),
}

/// The commands a family's code answers in this binary, outside
/// roamgate-cli's router (main.rs dispatches them; the Bun CLI passes these
/// through while Rust owns the family: contract/wire/core-channel.md, CLI
/// pass-through).
pub const FAMILY_COMMANDS: &[&str] = &[
    "update", "rollback", "herdr", "push", "activity", "archive", "history", "reviews", "voice",
    "setup",
];

/// Reads the command line as index.ts does: a first word that is not a
/// flag is a command, anything else the server's.
pub fn parse_args(args: &[String]) -> Result<Options, String> {
    match args.first().map(String::as_str) {
        Some("core") => match args.get(1) {
            None => Ok(Options::Core),
            Some(extra) => Err(format!("unknown argument {extra}")),
        },
        Some("owners") => Ok(Options::Owners(args[1..].to_vec())),
        Some("front") => Ok(Options::Server(args[1..].to_vec())),
        Some(command) if !command.starts_with('-') => {
            Ok(Options::Command(command.to_owned(), args[1..].to_vec()))
        }
        _ => Ok(Options::Server(args.to_vec())),
    }
}

/// The CPU profile's variables (`--profile`, `--profile-duration`,
/// `--profile-dir`), which the front sets on its standalone core.
pub const PROFILE_ENV: &str = "ROAMGATE_PROFILE";
pub const PROFILE_DURATION_ENV: &str = "ROAMGATE_PROFILE_DURATION";
pub const PROFILE_DIR_ENV: &str = "ROAMGATE_PROFILE_DIR";

/// The CPU profile a standalone core takes when its front asks for one
/// (`ROAMGATE_PROFILE=1` with the duration in seconds and the directory the
/// front resolved), and its duration. A directory it cannot use is logged, and the core runs
/// unprofiled (Bun's server exited on it: the front checked it already).
pub fn start_core_profile(
    env: &dyn roamgate_base::env::Env,
) -> Option<(roamgate_cli::cpu_profile::CpuProfile, std::time::Duration)> {
    if !roamgate_sidecar::core::standalone_on(env) || env.var(PROFILE_ENV).as_deref() != Some("1") {
        return None;
    }
    let seconds: u64 = env.var(PROFILE_DURATION_ENV)?.parse().ok()?;
    let directory = std::path::PathBuf::from(env.var(PROFILE_DIR_ENV)?);
    let level = roamgate_base::env::roamgate_env(env, "LOG_LEVEL")
        .and_then(|value| roamgate_base::log::parse_log_level(&value).ok())
        .unwrap_or(roamgate_base::log::LogLevel::Info);
    let logger = roamgate_base::log::Logger::with(roamgate_base::log::LoggerOptions {
        level: Some(level),
        scope: Some("core".into()),
        ..Default::default()
    });
    match roamgate_cli::cpu_profile::start_cpu_profile(
        &directory,
        std::time::Duration::from_secs(seconds),
        VERSION,
        &logger,
    ) {
        Ok(profile) => Some((profile, std::time::Duration::from_secs(seconds))),
        Err(error) => {
            let mut fields = roamgate_base::log::LogFields::new();
            fields.insert(
                "directory".into(),
                directory.to_string_lossy().into_owned().into(),
            );
            fields.insert("error".into(), error.to_string().into());
            logger.error("CPU profile failed", Some(&fields));
            None
        }
    }
}

/// Record mode in a standalone core: the processes it runs (`spawn`
/// lines, hooks.ts `recordSpawns`), in the directory its front resolved
/// (`ROAMGATE_CONTRACT_RECORD`, absolute; `0` when off), flushed until
/// the core stops.
pub fn start_core_recorder(
    env: &dyn roamgate_base::env::Env,
) -> Option<std::sync::Arc<roamgate_base::record::ContractRecorder>> {
    if !roamgate_sidecar::core::standalone_on(env) {
        return None;
    }
    let now: roamgate_base::log::NowFn = std::sync::Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64)
    });
    // The front names an absolute directory: no data root is needed.
    let options =
        roamgate_base::record::RecorderOptions::from_env(env, std::env::temp_dir, "server", now)?;
    let recorder = match roamgate_base::record::ContractRecorder::new(options) {
        Ok(recorder) => std::sync::Arc::new(recorder),
        Err(error) => {
            eprintln!("[core] contract record mode off: {error}");
            return None;
        }
    };
    roamgate_exec::process::ProcessRunner::observe_every_run(std::sync::Arc::new(
        roamgate_exec::process::RecordObserver::new(recorder.clone()),
    ));
    recorder.run_flusher(std::sync::Arc::new(roamgate_base::clock::SystemClock));
    Some(recorder)
}

#[derive(RustEmbed)]
#[folder = "$ROAMGATE_WEB_DIST"]
struct Web;

/// The web build this binary carries (build.rs: `ROAMGATE_WEB_DIST`, else
/// server/public), served by the front after the public directory. A
/// release build holds it in memory; a debug build reads that directory
/// (rust-embed's development mode), so a new `bun run build:web` is served
/// without building the binary again.
pub fn embedded_web() -> roamgate_http::static_files::EmbeddedFiles {
    roamgate_http::static_files::EmbeddedFiles(std::sync::Arc::new(|name: &str| {
        Web::get(name).map(|file| match file.data {
            std::borrow::Cow::Borrowed(bytes) => bytes::Bytes::from_static(bytes),
            std::borrow::Cow::Owned(bytes) => bytes::Bytes::from(bytes),
        })
    }))
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

    /// runCli's split: no arguments or a flag first is the server's; any
    /// other first word a command, `help` and unknown words included.
    #[test]
    fn a_flag_first_is_the_server_s_and_a_word_a_command() {
        assert_eq!(parse_args(&args(&[])), Ok(Options::Server(vec![])));
        assert_eq!(
            parse_args(&args(&["--port", "1234", "--host=::1"])),
            Ok(Options::Server(args(&["--port", "1234", "--host=::1"])))
        );
        assert_eq!(
            parse_args(&args(&["-h"])),
            Ok(Options::Server(args(&["-h"])))
        );
        assert_eq!(
            parse_args(&args(&["front", "--port", "9"])),
            Ok(Options::Server(args(&["--port", "9"])))
        );
        assert_eq!(parse_args(&args(&["core"])), Ok(Options::Core));
        assert_eq!(
            parse_args(&args(&["core", "x"])),
            Err("unknown argument x".into())
        );
        assert_eq!(
            parse_args(&args(&["herdr", "status", "--socket-path", "/x"])),
            Ok(Options::Command(
                "herdr".into(),
                args(&["status", "--socket-path", "/x"])
            ))
        );
        assert_eq!(
            parse_args(&args(&["setup"])),
            Ok(Options::Command("setup".into(), vec![]))
        );
        assert_eq!(
            parse_args(&args(&["help", "herdr"])),
            Ok(Options::Command("help".into(), args(&["herdr"])))
        );
        assert_eq!(
            parse_args(&args(&["nope"])),
            Ok(Options::Command("nope".into(), vec![]))
        );
    }

    /// Every command of the contract is answered: by roamgate-cli's
    /// router, or by a family's code here.
    #[test]
    fn every_contract_command_has_its_code() {
        let commands = roamgate_cli::index::cli_commands(roamgate_cli::index::rust_runner);
        assert!(!commands.is_empty());
        for command in commands {
            assert!(
                roamgate_cli::index::RUST_COMMANDS.contains(&command.name.as_str())
                    || FAMILY_COMMANDS.contains(&command.name.as_str()),
                "{}",
                command.name
            );
        }
    }
}
