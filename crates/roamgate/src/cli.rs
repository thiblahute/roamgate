//! The management commands roamgate-cli answers itself (`roamgate auth`,
//! `config`, `connections`, `doctor`, `service`, `url`, `plugin`,
//! `completion`): run when the Bun CLI passes one through (the owners table
//! gives its family to Rust; contract/wire/core-channel.md, CLI
//! pass-through), with the CLI's executable and lines written as they come.

use std::collections::BTreeMap;
use std::sync::Arc;

use roamgate_base::env::{Env, ProcessEnv};
use roamgate_cli::context::{CliContext, Console};
use roamgate_cli::index::{Outcome, cli_commands, run_cli, rust_runner};
use roamgate_exec::service::SystemCommands;

/// The family whose `cli` names `command` (contract/owners/families.json).
fn family_of(command: &str) -> &'static str {
    if command == "connections" {
        "host"
    } else {
        "front"
    }
}

/// What a command leaves to the binary.
pub enum Done {
    Exit(u8),
    /// `service run <file>`: serve with these variables over the process
    /// environment.
    Serve(BTreeMap<String, String>),
}

/// `roamgate <command> <args>` for a command of
/// [`roamgate_cli::index::RUST_COMMANDS`].
pub async fn run(command: &str, args: &[String]) -> Done {
    roamgate_sidecar::core::note_served(&ProcessEnv, family_of(command), &format!("cli {command}"));
    let context = CliContext {
        runtime: crate::families::update::cli_runtime(Arc::new(ProcessEnv)),
        run: Arc::new(SystemCommands),
        console: Console::live(),
    };
    let argv: Vec<String> = std::iter::once(command.to_owned())
        .chain(args.iter().cloned())
        .collect();
    match run_cli(&argv, &context, &cli_commands(rust_runner)).await {
        Some(Outcome::Code(code)) => Done::Exit(u8::try_from(code).unwrap_or(1)),
        Some(Outcome::ContinueToServer) => {
            let path = args.get(1).cloned().unwrap_or_default();
            match roamgate_cli::service_manager::service_run_environment(&path, &ProcessEnv) {
                Ok(environment) => {
                    let mut entries = environment.entries;
                    if environment.supervisor {
                        entries.insert("ROAMGATE_RESTART_SUPERVISOR".into(), "1".into());
                    }
                    Done::Serve(entries)
                }
                Err(message) => {
                    context.error(&format!("roamgate service: {message}"));
                    context.error("Run `roamgate service --help` for usage.");
                    Done::Exit(1)
                }
            }
        }
        None => Done::Exit(2),
    }
}

/// The environment `service run` serves with: its file's entries over the
/// process's.
pub fn serve_env(entries: &BTreeMap<String, String>, name: &str) -> Option<String> {
    entries.get(name).cloned().or_else(|| ProcessEnv.var(name))
}
