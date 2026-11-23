//! A management command's context (cli/command.ts CliContext): who runs it,
//! the commands it may run, and where its lines go.

use std::path::Path;
use std::sync::{Arc, Mutex};

use roamgate_exec::service::RunCommand;
use serde_json::Value;

use crate::args::{display_path, pretty_json};
use crate::commands::CliRuntime;
use crate::output::Printed;
use crate::service::ServiceRuntime;

/// Where a command's lines go: kept (tests, the contract recorder) and,
/// when live, written at once as console.log and console.error do, so they
/// interleave with the output of the commands it runs.
#[derive(Debug, Default)]
pub struct Console {
    live: bool,
    printed: Mutex<Printed>,
}

impl Console {
    /// Lines kept only.
    pub fn recorded() -> Self {
        Self::default()
    }

    /// Lines written to stdout and stderr as they come, and kept.
    pub fn live() -> Self {
        Self {
            live: true,
            printed: Mutex::default(),
        }
    }

    pub fn log(&self, line: &str) {
        if self.live {
            use std::io::Write;
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
        self.printed.lock().unwrap().log(line);
    }

    pub fn error(&self, line: &str) {
        if self.live {
            use std::io::Write;
            let _ = writeln!(std::io::stderr().lock(), "{line}");
        }
        self.printed.lock().unwrap().error(line);
    }

    /// What was printed so far, with `code`.
    pub fn printed(&self, code: i32) -> Printed {
        self.printed.lock().unwrap().clone().exit(code)
    }

    pub fn is_live(&self) -> bool {
        self.live
    }
}

/// A command's context.
pub struct CliContext {
    pub runtime: CliRuntime,
    /// RunCommand and CaptureCommand.
    pub run: Arc<dyn RunCommand>,
    pub console: Console,
}

impl CliContext {
    pub fn log(&self, line: &str) {
        self.console.log(line);
    }

    pub fn error(&self, line: &str) {
        self.console.error(line);
    }

    /// `printJson`.
    pub fn print_json(&self, value: &Value) {
        self.log(&pretty_json(value));
    }

    /// `displayPath`.
    pub fn display_path(&self, path: &Path) -> String {
        display_path(
            &path.display().to_string(),
            &self.runtime.platform,
            &self.runtime.home.display().to_string(),
        )
    }

    pub fn service(&self) -> ServiceRuntime {
        self.runtime.service()
    }

    pub fn run_command(&self, argv: &[String]) -> i32 {
        self.run.run(argv, false)
    }
}

#[cfg(test)]
pub mod testing {
    //! createTestCli (cli/test-context.ts): a context whose files, commands
    //! and output never leave a temporary home.
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    use roamgate_exec::service::fake::Recorder;

    use super::*;

    pub struct TestCli {
        pub home: tempfile::TempDir,
        pub context: CliContext,
        pub recorder: Arc<Recorder>,
        /// The service environment file under the home (Linux layout).
        pub config_path: PathBuf,
    }

    /// The runtime createTestCli gives: Linux, uid 1000, an empty
    /// environment, `<home>/bin/roamgate`.
    pub fn test_runtime(home: &Path) -> CliRuntime {
        CliRuntime {
            platform: "linux".into(),
            arch: "x64".into(),
            home: home.to_path_buf(),
            app_data: None,
            exec_path: home.join("bin").join("roamgate"),
            version: "1.2.3".into(),
            standalone: true,
            uid: Some(1000),
            env: Arc::new(BTreeMap::<String, String>::new()),
        }
    }

    impl TestCli {
        /// Unknown commands fail like a missing service (4); captures
        /// answer 113 and no output, as launchctl for a missing job.
        pub fn new() -> Self {
            Self::with(|_| None, |_| None)
        }

        /// `run` and `capture` answer what they know, the defaults else.
        pub fn with(
            run: impl Fn(&[String]) -> Option<i32> + Send + Sync + 'static,
            capture: impl Fn(&[String]) -> Option<(i32, String)> + Send + Sync + 'static,
        ) -> Self {
            Self::with_runtime(|_| {}, run, capture)
        }

        pub fn with_runtime(
            change: impl FnOnce(&mut CliRuntime),
            run: impl Fn(&[String]) -> Option<i32> + Send + Sync + 'static,
            capture: impl Fn(&[String]) -> Option<(i32, String)> + Send + Sync + 'static,
        ) -> Self {
            let home = tempfile::tempdir().unwrap();
            let mut runtime = test_runtime(home.path());
            change(&mut runtime);
            let recorder = Arc::new(
                Recorder::new(move |argv| run(argv).unwrap_or(4))
                    .with_capture(move |argv| capture(argv).unwrap_or((113, String::new()))),
            );
            let config_path = home.path().join(".config/roamgate/roamgate.env");
            Self {
                context: CliContext {
                    runtime,
                    run: recorder.clone(),
                    console: Console::recorded(),
                },
                home,
                recorder,
                config_path,
            }
        }

        pub fn home(&self) -> &Path {
            self.home.path()
        }

        /// Writes the service environment file (0600 in a 0700 directory).
        pub fn write_config(&self, contents: &str) {
            let directory = self.config_path.parent().unwrap();
            std::fs::create_dir_all(directory).unwrap();
            std::fs::write(&self.config_path, contents).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
                std::fs::set_permissions(&self.config_path, std::fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
        }

        /// The lines logged (console.log), one per entry.
        pub fn output(&self) -> Vec<String> {
            lines(&self.context.console.printed(0).stdout)
        }

        /// The lines of console.error.
        pub fn errors(&self) -> Vec<String> {
            lines(&self.context.console.printed(0).stderr)
        }

        /// `runCli(argv, context)` with this crate's commands: the exit
        /// code (-1 for the server's turn or the listener's argv).
        pub async fn run_cli(&self, argv: &[&str]) -> i32 {
            let argv: Vec<String> = argv.iter().map(|arg| (*arg).to_owned()).collect();
            let commands = crate::index::cli_commands(crate::index::rust_runner);
            match crate::index::run_cli(&argv, &self.context, &commands).await {
                Some(crate::index::Outcome::Code(code)) => code,
                _ => -1,
            }
        }

        /// The commands run or captured.
        pub fn commands(&self) -> Vec<Vec<String>> {
            self.recorder.argvs()
        }
    }

    impl Default for TestCli {
        fn default() -> Self {
            Self::new()
        }
    }

    /// The entries a console wrote: each log call ends with one newline.
    pub fn lines(text: &str) -> Vec<String> {
        let Some(text) = text.strip_suffix('\n') else {
            return Vec::new();
        };
        text.split('\n').map(str::to_owned).collect()
    }
}
