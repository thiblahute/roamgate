//! Record mode of a CLI run (contract-record/hooks.ts recordCli): one
//! `cli`/`run` line with the arguments (credentials hidden), the exit code,
//! how long it took and the first 64 KiB of what it printed.

use roamgate_base::log::slice_utf16;
use roamgate_base::record::{ContractRecorder, RecordInput};
use roamgate_exec::process::recorded_argv;
use serde_json::{Map, Value};

use crate::output::Printed;

/// What a run keeps of each stream, in UTF-16 units as the TS slices.
const LIMIT: usize = 64 * 1024;

/// The line of a run of `argv` that printed `printed` in `ms`.
pub fn cli_run_input(argv: &[String], printed: &Printed, ms: f64) -> RecordInput {
    let mut fields = Map::new();
    fields.insert("argv".into(), recorded_argv(argv).into());
    fields.insert("exit".into(), printed.code.into());
    fields.insert("ms".into(), Value::from(ms.round() as i64));
    fields.insert(
        "stdout".into(),
        slice_utf16(&printed.stdout, LIMIT).to_owned().into(),
    );
    fields.insert(
        "stderr".into(),
        slice_utf16(&printed.stderr, LIMIT).to_owned().into(),
    );
    RecordInput {
        fields: Some(fields),
        ..RecordInput::new("cli", "run")
    }
}

/// Records the run on `recorder` (made with the role "cli") and flushes it,
/// as the CLI exits right after.
pub fn record_cli_run(recorder: &ContractRecorder, argv: &[String], printed: &Printed, ms: f64) {
    recorder.record(cli_run_input(argv, printed, ms));
    recorder.flush();
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use roamgate_base::record::RecorderOptions;

    use super::*;
    use crate::context::Console;

    #[test]
    fn records_a_cli_run_with_what_it_printed() {
        let scratch = tempfile::tempdir().unwrap();
        let directory = scratch.path().join("rec");
        let recorder = ContractRecorder::new(RecorderOptions::new(
            &directory,
            "cli",
            Arc::new(|| 1_767_323_045_678),
        ))
        .unwrap();
        let console = Console::recorded();
        console.log("done");
        console.error("careful");
        let argv: Vec<String> = ["auth", "--password", "pw", "rotate"]
            .iter()
            .map(|arg| (*arg).to_owned())
            .collect();
        record_cli_run(&recorder, &argv, &console.printed(0), 3.4);
        let printed = console.printed(0);
        assert_eq!(
            (printed.stdout.as_str(), printed.stderr.as_str()),
            ("done\n", "careful\n")
        );
        let lines: Vec<Value> = std::fs::read_dir(&directory)
            .unwrap()
            .flat_map(|entry| {
                std::fs::read_to_string(entry.unwrap().path())
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect();
        assert_eq!(lines[0]["role"], "cli");
        let run = &lines[1];
        assert_eq!(run["ch"], "cli");
        assert_eq!(run["ev"], "run");
        assert_eq!(
            run["argv"],
            serde_json::json!(["auth", "--password", "[redacted]", "rotate"])
        );
        assert_eq!(run["exit"], 0);
        assert_eq!(run["ms"], 3);
        assert_eq!(run["stdout"], "done\n");
        assert_eq!(run["stderr"], "careful\n");
    }

    #[test]
    fn keeps_the_first_64_kib_of_each_stream() {
        let printed = Printed {
            code: 1,
            stdout: "x".repeat(LIMIT + 10),
            stderr: String::new(),
        };
        let input = cli_run_input(&[], &printed, 0.0);
        let fields = input.fields.unwrap();
        assert_eq!(fields["stdout"].as_str().unwrap().len(), LIMIT);
        assert_eq!(fields["exit"], 1);
    }
}
