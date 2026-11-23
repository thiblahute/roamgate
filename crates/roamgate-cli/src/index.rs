//! The management commands' router (cli/index.ts runCli): dispatch,
//! `help`, the top-level help and the error conventions. The commands'
//! names, summaries, completion words and help texts are the recorded
//! contract's (contract/cli/commands.json and help/).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde_json::Value;

use crate::args::{EXIT_OK, EXIT_USAGE, Failure, failure_code, report_failure};
use crate::context::CliContext;

/// What a command returns: an exit code, or the server's turn
/// (`CONTINUE_TO_SERVER`: `service run`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Code(i32),
    ContinueToServer,
}

pub type RunFuture<'a> = Pin<Box<dyn Future<Output = Result<Outcome, Failure>> + 'a>>;

/// A command's `run`.
pub type Run = Arc<dyn for<'a> Fn(&'a [String], &'a CliContext) -> RunFuture<'a> + Send + Sync>;

/// A management command (CliCommand).
#[derive(Clone)]
pub struct CliCommand {
    pub name: String,
    /// One line for `roamgate --help`.
    pub summary: String,
    /// Subcommand words offered by shell completion.
    pub actions: Vec<String>,
    /// Flags offered by shell completion.
    pub flags: Vec<String>,
    /// Its help, as `help()` returns it.
    pub help: String,
    pub run: Run,
}

impl CliCommand {
    /// A command whose `run` is `run`.
    pub fn new(
        name: &str,
        summary: &str,
        help: &str,
        run: impl for<'a> Fn(&'a [String], &'a CliContext) -> RunFuture<'a> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            summary: summary.into(),
            actions: Vec::new(),
            flags: Vec::new(),
            help: help.into(),
            run: Arc::new(run),
        }
    }
}

/// The help texts as printed (console.log adds the last newline).
fn printed_help(name: &str) -> &'static str {
    match name {
        "service" => include_str!("../../../contract/cli/help/service.txt"),
        "herdr" => include_str!("../../../contract/cli/help/herdr.txt"),
        "setup" => include_str!("../../../contract/cli/help/setup.txt"),
        "voice" => include_str!("../../../contract/cli/help/voice.txt"),
        "doctor" => include_str!("../../../contract/cli/help/doctor.txt"),
        "url" => include_str!("../../../contract/cli/help/url.txt"),
        "config" => include_str!("../../../contract/cli/help/config.txt"),
        "auth" => include_str!("../../../contract/cli/help/auth.txt"),
        "connections" => include_str!("../../../contract/cli/help/connections.txt"),
        "push" => include_str!("../../../contract/cli/help/push.txt"),
        "activity" => include_str!("../../../contract/cli/help/activity.txt"),
        "reviews" => include_str!("../../../contract/cli/help/reviews.txt"),
        "history" => include_str!("../../../contract/cli/help/history.txt"),
        "archive" => include_str!("../../../contract/cli/help/archive.txt"),
        "update" => include_str!("../../../contract/cli/help/update.txt"),
        "rollback" => include_str!("../../../contract/cli/help/rollback.txt"),
        "plugin" => include_str!("../../../contract/cli/help/plugin.stderr.txt"),
        "completion" => include_str!("../../../contract/cli/help/completion.txt"),
        _ => "",
    }
}

/// A command's help text (its `help()`): the recorded output without the
/// newline console.log added.
pub fn command_help(name: &str) -> &'static str {
    let printed = printed_help(name);
    printed.strip_suffix('\n').unwrap_or(printed)
}

const COMMANDS_JSON: &str = include_str!("../../../contract/cli/commands.json");

fn commands_json() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(COMMANDS_JSON).expect("contract/cli/commands.json"))
}

fn words(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The server's flags, offered at the top level by completion.
pub fn server_flags() -> Vec<String> {
    words(&commands_json()["server_flags"])
}

/// What the Rust CLI answers itself for a command (its `run`); None for
/// the commands it does not have yet.
pub type Runner = fn(&str) -> Option<Run>;

/// Every command in `roamgate --help` order (cliCommands), with the runs
/// `runner` gives; a command without one says it runs in the Bun CLI.
pub fn cli_commands(runner: Runner) -> Vec<CliCommand> {
    let Some(commands) = commands_json()["commands"].as_object() else {
        return Vec::new();
    };
    commands
        .iter()
        .map(|(name, entry)| CliCommand {
            name: name.clone(),
            summary: entry["summary"].as_str().unwrap_or_default().to_owned(),
            actions: words(&entry["actions"]),
            flags: words(&entry["flags"]),
            help: command_help(name).to_owned(),
            run: runner(name).unwrap_or_else(|| {
                let name = name.clone();
                Arc::new(move |_, _| {
                    let name = name.clone();
                    Box::pin(async move {
                        Err(Failure::Failed(format!(
                            "{name} is not in this build's command line; run it with the Bun CLI"
                        )))
                    })
                })
            }),
        })
        .collect()
}

/// `roamgate --help` (topLevelHelp).
pub fn top_level_help(commands: &[CliCommand]) -> String {
    let width = commands
        .iter()
        .map(|command| command.name.len())
        .max()
        .unwrap_or(0);
    let lines: Vec<String> = commands
        .iter()
        .map(|command| format!("  {:width$}  {}", command.name, command.summary))
        .collect();
    format!(
        "Roamgate \u{2014} Web and PWA client for Herdr

Usage: roamgate [options]              run the server
       roamgate <command> [arguments]  manage an installation

Commands:
{}

Run `roamgate <command> --help` or `roamgate help <command>` for details.

{}",
        lines.join("\n"),
        crate::server_config::server_options_help()
    )
}

/// Commands whose own run prints their help.
const DELEGATED_HELP: &[&str] = &["service", "herdr", "plugin"];

async fn run_command(command: &CliCommand, args: &[String], context: &CliContext) -> Outcome {
    match (command.run)(args, context).await {
        Ok(outcome) => outcome,
        Err(failure) => {
            report_failure(&command.name, &failure, &mut |line| context.error(line));
            Outcome::Code(failure_code(&failure))
        }
    }
}

/// Dispatches a management command; None when `argv` is the server's (no
/// arguments or only flags), so the caller starts the listener.
pub async fn run_cli(
    argv: &[String],
    context: &CliContext,
    commands: &[CliCommand],
) -> Option<Outcome> {
    let first = argv.first()?;
    if first.starts_with('-') {
        return None;
    }
    if first == "help" {
        let Some(topic) = argv.get(1) else {
            context.log(&top_level_help(commands));
            return Some(Outcome::Code(EXIT_OK));
        };
        let Some(command) = commands.iter().find(|command| &command.name == topic) else {
            context.error(&format!("roamgate: unknown command: {topic}"));
            return Some(Outcome::Code(EXIT_USAGE));
        };
        if DELEGATED_HELP.contains(&command.name.as_str()) {
            return Some(run_command(command, &["--help".to_owned()], context).await);
        }
        context.log(&command.help);
        return Some(Outcome::Code(EXIT_OK));
    }
    let Some(command) = commands.iter().find(|command| &command.name == first) else {
        context.error(&format!("roamgate: unknown command: {first}"));
        context.error("Run `roamgate --help` for the list of commands.");
        return Some(Outcome::Code(EXIT_USAGE));
    };
    Some(run_command(command, &argv[1..], context).await)
}

macro_rules! runs {
    ($($name:literal => $path:path),* $(,)?) => {
        /// The commands this crate runs itself (the others are the
        /// families' crates' or still the Bun CLI's).
        pub fn rust_runner(name: &str) -> Option<Run> {
            match name {
                $($name => {
                    fn run<'a>(args: &'a [String], context: &'a CliContext) -> RunFuture<'a> {
                        Box::pin($path(args, context))
                    }
                    Some(Arc::new(run))
                })*
                _ => None,
            }
        }

        /// The names [`rust_runner`] answers.
        pub const RUST_COMMANDS: &[&str] = &[$($name),*];
    };
}

runs! {
    "service" => crate::service_manager::run,
    "doctor" => crate::doctor::run,
    "url" => crate::url::run,
    "config" => crate::config::run,
    "auth" => crate::auth::run,
    "connections" => crate::connections::run,
    "plugin" => crate::plugin::run,
    "completion" => crate::completion::run,
}
