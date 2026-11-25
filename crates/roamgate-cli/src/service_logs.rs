//! `roamgate service logs` (cli/service-logs.ts): the managed service's
//! output on every platform.

use roamgate_exec::service::{ServicePlatform, argv, resolve_service_platform};

use crate::args::{EXIT_FAILURE, Failure, Opt, parse_command_args};
use crate::context::CliContext;
use crate::service::resolve_service_paths;

const OPTIONS: &[Opt] = &[
    Opt::flag("follow").short('f'),
    Opt::string("lines").short('n'),
];

/// `roamgate service logs [-f|--follow] [-n|--lines <count>]`: its exit code.
pub fn run(args: &[String], context: &CliContext) -> Result<i32, Failure> {
    let parsed = parse_command_args(args, OPTIONS, 0)?;
    let lines = parsed.string("lines").unwrap_or("100");
    if lines.is_empty() || lines.len() > 6 || !lines.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Failure::usage("--lines must be a number from 0 to 999999"));
    }
    let follow = parsed.flag("follow");
    let runtime = &context.runtime;
    let platform = resolve_service_platform(&runtime.platform).map_err(Failure::Failed)?;
    match platform {
        ServicePlatform::Systemd => {
            let mut command = argv(&[
                "journalctl",
                "--user",
                "--unit",
                "roamgate.service",
                "--no-pager",
                "--lines",
                lines,
            ]);
            if follow {
                command.push("--follow".into());
            }
            Ok(context.run_command(&command))
        }
        ServicePlatform::WindowsTask => {
            context.error(
                "roamgate service logs: the Windows scheduled task does not capture output.",
            );
            context.error("Stop the task and run `roamgate` in a terminal to see its log lines.");
            Ok(EXIT_FAILURE)
        }
        ServicePlatform::Launchd => {
            let paths = resolve_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
            let files: Vec<String> = [&paths.stderr_log, &paths.stdout_log]
                .into_iter()
                .flatten()
                .filter(|path| path.exists())
                .map(|path| path.display().to_string())
                .collect();
            if files.is_empty() {
                context.error(&format!(
                    "roamgate service logs: no log files yet ({}); is the service installed?",
                    paths
                        .stderr_log
                        .as_ref()
                        .map(|path| path.display().to_string())
                        .unwrap_or_else(|| "undefined".into())
                ));
                return Ok(EXIT_FAILURE);
            }
            let mut command = argv(&["tail", "-n", lines]);
            if follow {
                command.push("-F".into());
            }
            command.extend(files);
            Ok(context.run_command(&command))
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::context::testing::TestCli;

    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        argv(list)
    }

    #[test]
    fn follows_the_systemd_journal_on_linux() {
        let cli = TestCli::with(|_| Some(0), |_| None);
        assert_eq!(run(&args(&["-f", "--lines", "20"]), &cli.context), Ok(0));
        assert_eq!(
            cli.commands(),
            vec![args(&[
                "journalctl",
                "--user",
                "--unit",
                "roamgate.service",
                "--no-pager",
                "--lines",
                "20",
                "--follow",
            ])]
        );
    }

    #[test]
    fn tails_the_launch_agent_log_files_on_macos() {
        let cli = TestCli::with_runtime(
            |runtime| runtime.platform = "darwin".into(),
            |_| Some(0),
            |_| None,
        );
        assert_eq!(run(&[], &cli.context), Ok(EXIT_FAILURE));
        let logs = cli.in_home("Library/Logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("roamgate.stderr.log"), "").unwrap();
        std::fs::write(logs.join("roamgate.stdout.log"), "").unwrap();
        assert_eq!(run(&args(&["-n", "5", "--follow"]), &cli.context), Ok(0));
        assert_eq!(
            cli.commands(),
            vec![vec![
                "tail".to_owned(),
                "-n".into(),
                "5".into(),
                "-F".into(),
                logs.join("roamgate.stderr.log").display().to_string(),
                logs.join("roamgate.stdout.log").display().to_string(),
            ]]
        );
    }

    #[test]
    fn explains_that_windows_tasks_do_not_capture_output() {
        let cli = TestCli::with_runtime(
            |runtime| runtime.platform = "win32".into(),
            |_| None,
            |_| None,
        );
        assert_eq!(run(&[], &cli.context), Ok(EXIT_FAILURE));
        assert!(cli.errors()[0].contains("does not capture output"));
    }

    #[test]
    fn rejects_invalid_line_counts() {
        let cli = TestCli::new();
        let failure = run(&args(&["-n", "lots"]), &cli.context).unwrap_err();
        assert!(failure.message().contains("--lines"), "{failure:?}");
        assert!(matches!(failure, Failure::Usage(_)));
    }
}
