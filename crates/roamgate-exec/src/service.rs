//! User services, as Roamgate's own service and the managed Herdr service
//! both install them (config/service-definitions and the shared parts of
//! config/service-manager): the platform's service manager, the escaping its
//! definitions need, the blocking command seam, and Windows Scheduled Task
//! queries. The service definitions themselves live with their owners
//! (roamgate-cli for Roamgate's, roamgate-herdr for Herdr's).

use std::process::Stdio;

use roamgate_base::assets::{TASK_STATUS_PS1, TASK_WAIT_STOPPED_PS1, TemplateValue, fill_template};

/// The service manager of a platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServicePlatform {
    Systemd,
    Launchd,
    WindowsTask,
}

impl ServicePlatform {
    /// Its name in the TS code and in messages (`windows-task`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Systemd => "systemd",
            Self::Launchd => "launchd",
            Self::WindowsTask => "windows-task",
        }
    }
}

/// The service manager of a Node platform name (`linux`, `darwin`, `win32`).
pub fn resolve_service_platform(platform: &str) -> Result<ServicePlatform, String> {
    match platform {
        "linux" => Ok(ServicePlatform::Systemd),
        "darwin" => Ok(ServicePlatform::Launchd),
        "win32" => Ok(ServicePlatform::WindowsTask),
        other => Err(format!("service management is not supported on {other}")),
    }
}

/// This build's platform as Node names it.
pub fn node_platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        std::env::consts::OS
    }
}

/// This build's architecture as Node names it.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// A path for systemd's `ExecStart=` and `EnvironmentFile=`: safe bytes as
/// they are, `%` doubled, everything else as `\xNN` per UTF-8 byte.
pub fn escape_systemd_exec_path(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || "/_.:@+-".contains(character) {
            escaped.push(character);
        } else if character == '%' {
            escaped.push_str("%%");
        } else {
            let mut bytes = [0u8; 4];
            for byte in character.encode_utf8(&mut bytes).bytes() {
                escaped.push_str(&format!("\\x{byte:02x}"));
            }
        }
    }
    escaped
}

/// Text for an XML element or attribute (a launchd plist).
pub fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A PowerShell single-quoted string.
pub fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The directory part of a Windows path (`path.win32.dirname`).
pub fn win32_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rfind(['\\', '/']) {
        Some(0) => trimmed[..1].to_owned(),
        Some(index) if index == 2 && trimmed.as_bytes()[1] == b':' => trimmed[..3].to_owned(),
        Some(index) => trimmed[..index].to_owned(),
        None if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' => trimmed[..2].to_owned(),
        None => ".".to_owned(),
    }
}

/// Runs service commands to their end (`RunCommand` and `CaptureCommand`):
/// blocking, as the TS `spawnSync` they replace.
pub trait RunCommand: Send + Sync {
    /// The exit code; `quiet` drops the output, else it goes to this
    /// process's own stdout and stderr.
    fn run(&self, argv: &[String], quiet: bool) -> i32;

    /// The exit code and standard output (stderr dropped).
    fn capture(&self, argv: &[String]) -> (i32, String) {
        (self.run(argv, true), String::new())
    }
}

/// The real commands.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemCommands;

impl RunCommand for SystemCommands {
    fn run(&self, argv: &[String], quiet: bool) -> i32 {
        let Some((program, args)) = argv.split_first() else {
            return 1;
        };
        let mut command = std::process::Command::new(program);
        command.args(args).stdin(Stdio::inherit());
        if quiet {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        match command.status() {
            Ok(status) => crate::process::exit_code(status),
            Err(_) => 1,
        }
    }

    fn capture(&self, argv: &[String]) -> (i32, String) {
        let Some((program, args)) = argv.split_first() else {
            return (1, String::new());
        };
        match std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            Ok(output) => (
                crate::process::exit_code(output.status),
                String::from_utf8_lossy(&output.stdout).into_owned(),
            ),
            Err(_) => (1, String::new()),
        }
    }
}

/// The argv of `argv` given as string slices.
pub fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

pub const WINDOWS_TASK_NOT_FOUND_EXIT_CODE: i32 = 3;
pub const WINDOWS_TASK_INACTIVE_EXIT_CODE: i32 = 4;

/// What Task Scheduler says of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsTaskQuery {
    Exists { active: bool },
    Missing,
    Error { code: i32 },
}

fn powershell_command(script: String) -> Vec<String> {
    vec![
        "powershell.exe".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        script,
    ]
}

/// Whether a task exists and runs.
pub fn query_windows_task(task_name: &str, run: &dyn RunCommand) -> WindowsTaskQuery {
    let script = fill_template(
        TASK_STATUS_PS1,
        &[
            ("task", TemplateValue::Text(powershell_literal(task_name))),
            (
                "inactive_exit",
                TemplateValue::Number(WINDOWS_TASK_INACTIVE_EXIT_CODE.into()),
            ),
            (
                "not_found_exit",
                TemplateValue::Number(WINDOWS_TASK_NOT_FOUND_EXIT_CODE.into()),
            ),
        ],
    )
    .expect("task-status.ps1 fills");
    match run.run(&powershell_command(script), false) {
        0 => WindowsTaskQuery::Exists { active: true },
        WINDOWS_TASK_INACTIVE_EXIT_CODE => WindowsTaskQuery::Exists { active: false },
        WINDOWS_TASK_NOT_FOUND_EXIT_CODE => WindowsTaskQuery::Missing,
        code => WindowsTaskQuery::Error { code },
    }
}

/// Registers the task a definition script describes.
pub fn register_windows_task(definition_path: &str, run: &dyn RunCommand) -> i32 {
    run.run(
        &argv(&[
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            definition_path,
        ]),
        false,
    )
}

fn wait_for_windows_task_stop(task_name: &str, run: &dyn RunCommand) -> i32 {
    let script = fill_template(
        TASK_WAIT_STOPPED_PS1,
        &[("task", TemplateValue::Text(powershell_literal(task_name)))],
    )
    .expect("task-wait-stopped.ps1 fills");
    run.run(&powershell_command(script), false)
}

/// Ends the task, waits for it to stop, then runs it again.
pub fn restart_windows_task(task_name: &str, run: &dyn RunCommand) -> i32 {
    run.run(&argv(&["schtasks.exe", "/End", "/TN", task_name]), true);
    let wait = wait_for_windows_task_stop(task_name, run);
    if wait != 0 {
        return wait;
    }
    run.run(&argv(&["schtasks.exe", "/Run", "/TN", task_name]), false)
}

/// Whether a `launchctl print` job's own state is `running` (its first
/// one-tab `state =` line; nested sections are indented further).
pub fn launchd_job_running(printed: &str) -> bool {
    printed
        .lines()
        .find_map(|line| line.strip_prefix("\tstate = "))
        .is_some_and(|state| state == "running")
}

/// Writes a service definition whole: a temporary file beside it, then a
/// rename (0644, as a unit file is).
pub fn write_definition(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_file_name(format!(
        "{}.tmp-{}",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));
    let written = (|| {
        std::fs::write(&temporary, content)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644))?;
        }
        std::fs::rename(&temporary, path)
    })();
    let _ = std::fs::remove_file(&temporary);
    written
}

pub mod fake {
    //! A recording [`RunCommand`] for tests (of this crate and the crates
    //! that install services).
    use std::sync::Mutex;

    use super::RunCommand;

    /// The exit code a fake command answers.
    pub type Answer = Box<dyn Fn(&[String]) -> i32 + Send + Sync>;

    pub struct Recorder {
        pub calls: Mutex<Vec<(Vec<String>, bool)>>,
        pub answer: Answer,
    }

    impl Recorder {
        pub fn new(answer: impl Fn(&[String]) -> i32 + Send + Sync + 'static) -> Self {
            Self {
                calls: Mutex::default(),
                answer: Box::new(answer),
            }
        }

        pub fn argvs(&self) -> Vec<Vec<String>> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(argv, _)| argv.clone())
                .collect()
        }
    }

    impl RunCommand for Recorder {
        fn run(&self, argv: &[String], quiet: bool) -> i32 {
            self.calls.lock().unwrap().push((argv.to_vec(), quiet));
            (self.answer)(argv)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_systemd_paths_byte_by_byte() {
        assert_eq!(
            escape_systemd_exec_path("/opt/herdr bin/herdr"),
            "/opt/herdr\\x20bin/herdr"
        );
        assert_eq!(escape_systemd_exec_path("/a%b/é"), "/a%%b/\\xc3\\xa9");
        assert_eq!(xml_escape("a&<>\"'"), "a&amp;&lt;&gt;&quot;&apos;");
        assert_eq!(powershell_literal("it's"), "'it''s'");
    }

    #[test]
    fn resolves_platforms_and_windows_dirnames() {
        assert_eq!(
            resolve_service_platform("linux"),
            Ok(ServicePlatform::Systemd)
        );
        assert_eq!(
            resolve_service_platform("darwin"),
            Ok(ServicePlatform::Launchd)
        );
        assert_eq!(
            resolve_service_platform("win32"),
            Ok(ServicePlatform::WindowsTask)
        );
        assert_eq!(
            resolve_service_platform("freebsd"),
            Err("service management is not supported on freebsd".into())
        );
        assert_eq!(win32_dirname("C:\\herdr\\herdr.exe"), "C:\\herdr");
        assert_eq!(win32_dirname("C:\\herdr.exe"), "C:\\");
        assert_eq!(win32_dirname("herdr.exe"), ".");
    }

    #[test]
    fn windows_tasks_are_active_only_while_running() {
        for (code, want) in [
            (0, WindowsTaskQuery::Exists { active: true }),
            (4, WindowsTaskQuery::Exists { active: false }),
            (3, WindowsTaskQuery::Missing),
            (5, WindowsTaskQuery::Error { code: 5 }),
        ] {
            let run = fake::Recorder::new(move |_| code);
            assert_eq!(query_windows_task("dev.roamgate-x", &run), want);
            let argv = &run.argvs()[0];
            assert_eq!(argv[0], "powershell.exe");
            assert!(argv[4].contains("'dev.roamgate-x'"), "{}", argv[4]);
        }
    }

    #[test]
    fn restarts_a_task_by_ending_it_waiting_and_running_it() {
        let run = fake::Recorder::new(|_| 0);
        assert_eq!(restart_windows_task("t", &run), 0);
        let argvs = run.argvs();
        assert_eq!(argvs[0], argv(&["schtasks.exe", "/End", "/TN", "t"]));
        assert_eq!(argvs[1][0], "powershell.exe");
        assert_eq!(argvs[2], argv(&["schtasks.exe", "/Run", "/TN", "t"]));
        assert!(launchd_job_running(
            "x\n\tstate = running\n\t\tstate = waiting\n"
        ));
        assert!(!launchd_job_running("\tstate = waiting\n"));
    }
}
