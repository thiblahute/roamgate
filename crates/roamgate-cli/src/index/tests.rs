//! cli/index.test.ts.

use std::sync::{Arc, Mutex};

use super::*;
use crate::context::testing::TestCli;

fn argv(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

fn fake(
    run: impl for<'a> Fn(&'a [String], &'a CliContext) -> RunFuture<'a> + Send + Sync + 'static,
) -> CliCommand {
    CliCommand::new("fake", "a fake command", "fake help", run)
}

async fn run(cli: &TestCli, list: &[&str], commands: &[CliCommand]) -> Option<Outcome> {
    run_cli(&argv(list), &cli.context, commands).await
}

fn all() -> Vec<CliCommand> {
    cli_commands(rust_runner)
}

#[tokio::test]
async fn leaves_server_invocations_to_the_listener() {
    let cli = TestCli::new();
    assert_eq!(run(&cli, &[], &all()).await, None);
    assert_eq!(run(&cli, &["--port", "9000"], &all()).await, None);
    assert_eq!(run(&cli, &["--help"], &all()).await, None);
}

#[tokio::test]
async fn rejects_unknown_commands_with_a_usage_exit_code() {
    let cli = TestCli::new();
    assert_eq!(cli.run_cli(&["sevrice"]).await, EXIT_USAGE);
    assert_eq!(
        cli.errors(),
        [
            "roamgate: unknown command: sevrice",
            "Run `roamgate --help` for the list of commands."
        ]
    );
}

#[tokio::test]
async fn top_level_help_lists_every_command_including_herdr() {
    let cli = TestCli::new();
    assert_eq!(cli.run_cli(&["help"]).await, EXIT_OK);
    let help = cli.output().join("\n");
    for command in all() {
        assert!(
            help.contains(&format!("  {} ", command.name)),
            "{}",
            command.name
        );
    }
    assert!(help.contains("  herdr "));
    assert!(help.contains("--socket-path <path>"));
    assert_eq!(top_level_help(&all()), help);
    // As the Bun CLI prints it.
    assert_eq!(
        cli.context.console.printed(0).stdout,
        include_str!("../../../../contract/cli/help/roamgate.txt")
    );
}

#[tokio::test]
async fn help_command_prints_that_commands_help() {
    let cli = TestCli::new();
    assert_eq!(cli.run_cli(&["help", "doctor"]).await, EXIT_OK);
    assert!(
        cli.output()
            .join("\n")
            .contains("roamgate doctor [--offline]")
    );
    assert_eq!(cli.run_cli(&["help", "nope"]).await, EXIT_USAGE);
    assert_eq!(cli.errors(), ["roamgate: unknown command: nope"]);
    // Every command's help is the recorded one, the delegated ones too.
    for command in [
        "service",
        "auth",
        "url",
        "config",
        "connections",
        "doctor",
        "completion",
    ] {
        let cli = TestCli::new();
        assert_eq!(cli.run_cli(&["help", command]).await, EXIT_OK, "{command}");
        assert_eq!(
            cli.context.console.printed(0).stdout,
            printed_help(command),
            "{command}"
        );
    }
    let cli = TestCli::new();
    cli.run_cli(&["help", "plugin"]).await;
    assert_eq!(
        cli.context.console.printed(0).stderr,
        printed_help("plugin")
    );
}

#[tokio::test]
async fn maps_usage_errors_and_failures_to_distinct_exit_codes() {
    let cli = TestCli::new();
    let usage = fake(|_, _| Box::pin(async { Err(Failure::Usage("bad flag".into())) }));
    assert_eq!(
        run(&cli, &["fake"], &[usage]).await,
        Some(Outcome::Code(EXIT_USAGE))
    );
    assert_eq!(
        cli.errors(),
        [
            "roamgate fake: bad flag",
            "Run `roamgate fake --help` for usage."
        ]
    );
    let failing = fake(|_, _| Box::pin(async { Err(Failure::Failed("disk full".into())) }));
    assert_eq!(
        run(&cli, &["fake"], &[failing]).await,
        Some(Outcome::Code(crate::args::EXIT_FAILURE))
    );
    assert_eq!(cli.errors().last().unwrap(), "roamgate fake: disk full");
}

#[tokio::test]
async fn passes_the_remaining_arguments_and_continuation_through() {
    let cli = TestCli::new();
    let received: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = received.clone();
    let command = fake(move |args, _| {
        *seen.lock().unwrap() = args.to_vec();
        Box::pin(async { Ok(Outcome::ContinueToServer) })
    });
    assert_eq!(
        run(&cli, &["fake", "a", "--b"], &[command]).await,
        Some(Outcome::ContinueToServer)
    );
    assert_eq!(*received.lock().unwrap(), argv(&["a", "--b"]));
}

#[tokio::test]
async fn service_logs_is_routed_to_the_log_viewer() {
    let cli = TestCli::with(|_| Some(0), |_| None);
    assert_eq!(cli.run_cli(&["service", "logs", "-n", "5"]).await, 0);
    assert_eq!(
        cli.commands(),
        [argv(&[
            "journalctl",
            "--user",
            "--unit",
            "roamgate.service",
            "--no-pager",
            "--lines",
            "5",
        ])]
    );
}

#[tokio::test]
async fn unknown_flags_of_new_commands_are_usage_errors() {
    let cli = TestCli::new();
    assert_eq!(cli.run_cli(&["url", "--nope"]).await, EXIT_USAGE);
    assert!(cli.errors()[0].contains("roamgate url:"));
}
