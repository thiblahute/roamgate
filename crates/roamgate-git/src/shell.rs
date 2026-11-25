//! The shell a workspace script runs in (workspace/git-shell.ts): `sh` on
//! POSIX, Git for Windows' Bash on a Windows machine, the login shell of
//! the host over SSH.

use crate::exec::Invocation;

pub use roamgate_base::posix_shell::NO_GIT_BASH;
use roamgate_base::posix_shell::{Lookup, windows_git_bash};

type Which<'a> = &'a dyn Fn(&str) -> Option<String>;
type IsFile<'a> = &'a dyn Fn(&str) -> bool;

/// How the shell is found; tests set the platform, environment and
/// lookups, a server leaves them to this machine.
#[derive(Default)]
pub struct ShellOptions<'a> {
    /// A Node `process.platform` name; this machine's when None.
    pub platform: Option<&'a str>,
    /// The environment; this process's when None.
    pub env: Option<&'a [(String, String)]>,
    pub which: Option<Which<'a>>,
    pub is_file: Option<IsFile<'a>>,
    /// False for a script of Git and POSIX tools only: a plain shell where
    /// Git needs no login setup (all but Windows). A login shell reads the
    /// profile on every run, 50 to 100 ms more each.
    pub login: Option<bool>,
}

/// Plain shell, for scripts of Git and POSIX tools only (`GIT_ONLY`).
pub fn git_only<'a>() -> ShellOptions<'a> {
    ShellOptions {
        login: Some(false),
        ..ShellOptions::default()
    }
}

/// This machine's platform as Node names it.
pub fn this_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// The command running `command` (a POSIX script): `sh -lc` here (`-c`
/// for a Git-only script off Windows), Git Bash on Windows, the host's
/// login shell over SSH (`git.shell` in the ssh log).
pub fn git_shell_command(
    command: &str,
    host: Option<&str>,
    options: &ShellOptions<'_>,
) -> Result<Invocation, String> {
    // SSH scripts run on the remote host: no local shell is looked up.
    if let Some(host) = host.filter(|host| !host.is_empty()) {
        return Ok(Invocation::ssh(host, command, Some("git.shell")));
    }
    let windows = options.platform.unwrap_or(this_platform()) == "win32";
    let shell = if windows {
        windows_git_bash(&Lookup {
            env: options.env,
            which: options.which,
            is_file: options.is_file,
        })?
    } else {
        "sh".to_owned()
    };
    // Login startup sets Git for Windows' PATH; the executable and the
    // script stay separate words, paths with spaces included.
    let flag = if windows || options.login != Some(false) {
        "-lc"
    } else {
        "-c"
    };
    Ok(Invocation::local([
        shell,
        flag.to_owned(),
        command.to_owned(),
    ]))
}

/// [`git_shell_command`] with this machine's shell.
pub fn shell_command(command: &str, host: Option<&str>) -> Result<Invocation, String> {
    git_shell_command(command, host, &ShellOptions::default())
}

/// [`git_shell_command`] for a Git-only script: no login shell off Windows.
pub fn git_only_command(command: &str, host: Option<&str>) -> Result<Invocation, String> {
    git_shell_command(command, host, &git_only())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const COMMAND: &str = "git -C 'C:\\Users\\Jane Doe\\project' status --porcelain=v1";

    struct Windows {
        git: Option<String>,
        sh: Option<String>,
        files: Vec<String>,
        env: Vec<(String, String)>,
    }

    impl Windows {
        fn new() -> Self {
            Self {
                git: None,
                sh: None,
                files: Vec::new(),
                env: Vec::new(),
            }
        }
        fn git(mut self, git: &str) -> Self {
            self.git = Some(git.into());
            self
        }
        fn sh(mut self, sh: &str) -> Self {
            self.sh = Some(sh.into());
            self
        }
        fn file(mut self, file: &str) -> Self {
            self.files.push(file.into());
            self
        }
        fn env(mut self, key: &str, value: &str) -> Self {
            self.env.push((key.into(), value.into()));
            self
        }
        fn run(&self, command: &str, login: Option<bool>) -> Result<Vec<String>, String> {
            let which = |name: &str| match name {
                "git" => self.git.clone(),
                "sh" => self.sh.clone(),
                _ => None,
            };
            let is_file = |path: &str| self.files.iter().any(|file| file == path);
            let options = ShellOptions {
                platform: Some("win32"),
                env: Some(&self.env),
                which: Some(&which),
                is_file: Some(&is_file),
                login,
            };
            match git_shell_command(command, None, &options)? {
                Invocation::Local(argv) => Ok(argv),
                other => panic!("{other:?}"),
            }
        }
    }

    fn argv(shell: &str, flag: &str, command: &str) -> Vec<String> {
        vec![shell.into(), flag.into(), command.into()]
    }

    #[test]
    fn finds_git_bash_when_only_git_s_cmd_directory_is_on_path() {
        let shell = "C:\\Program Files\\Git\\bin\\bash.exe";
        let found = Windows::new()
            .git("C:\\Program Files\\Git\\cmd\\git.exe")
            .file(shell)
            .run(COMMAND, None);
        assert_eq!(found.unwrap(), argv(shell, "-lc", COMMAND));
    }

    #[test]
    fn finds_portable_git_from_s_without_relying_on_standard_locations() {
        for directory in [
            "bin",
            "mingw64\\bin",
            "mingw32\\bin",
            "ucrt64\\bin",
            "clangarm64\\bin",
        ] {
            let shell = "D:\\Portable Git\\bin\\bash.exe";
            let found = Windows::new()
                .git(&format!("D:\\Portable Git\\{directory}\\git.exe"))
                .file(shell)
                .run(COMMAND, None);
            assert_eq!(found.unwrap()[0], shell, "{directory}");
        }
    }

    #[test]
    fn prefers_the_git_installation_on_path_over_a_different_default_install() {
        let shell = "D:\\My Git\\bin\\bash.exe";
        let found = Windows::new()
            .git("D:\\My Git\\CMD\\git.exe")
            .file(shell)
            .file("C:\\Program Files\\Git\\bin\\bash.exe")
            .run(COMMAND, None);
        assert_eq!(found.unwrap()[0], shell);
    }

    #[test]
    fn falls_back_to_git_s_usr_bin_bash_when_the_wrapper_is_absent() {
        let shell = "D:\\Portable Git\\usr\\bin\\bash.exe";
        let found = Windows::new()
            .git("D:\\Portable Git\\cmd\\git.exe")
            .file(shell)
            .run(COMMAND, None);
        assert_eq!(found.unwrap()[0], shell);
    }

    #[test]
    fn finds_installations_through_s_without_git_or_sh_on_path() {
        for (key, value, shell) in [
            (
                "ProgramFiles",
                "D:\\Program Files",
                "D:\\Program Files\\Git\\bin\\bash.exe",
            ),
            (
                "ProgramW6432",
                "D:\\Program Files",
                "D:\\Program Files\\Git\\bin\\bash.exe",
            ),
            (
                "ProgramFiles(x86)",
                "D:\\Program Files (x86)",
                "D:\\Program Files (x86)\\Git\\bin\\bash.exe",
            ),
            (
                "localappdata",
                "D:\\Users\\Jane Doe\\AppData\\Local",
                "D:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
            ),
        ] {
            let found = Windows::new()
                .env(key, value)
                .file(shell)
                .run(COMMAND, None);
            assert_eq!(found.unwrap(), argv(shell, "-lc", COMMAND), "{key}");
        }
    }

    #[test]
    fn finds_the_default_installation_with_an_empty_environment() {
        let shell = "C:\\Program Files\\Git\\bin\\bash.exe";
        let found = Windows::new().file(shell).run(COMMAND, None);
        assert_eq!(found.unwrap(), argv(shell, "-lc", COMMAND));
    }

    #[test]
    fn uses_systemdrive_for_default_locations() {
        let shell = "E:\\Program Files\\Git\\bin\\bash.exe";
        let found = Windows::new()
            .env("SystemDrive", "E:")
            .file(shell)
            .run(COMMAND, None);
        assert_eq!(found.unwrap()[0], shell);
    }

    #[test]
    fn keeps_a_posix_sh_on_path_as_a_fallback() {
        let shell = "C:\\Custom Shell\\sh.exe";
        let found = Windows::new().sh(shell).run(COMMAND, None);
        assert_eq!(found.unwrap(), argv(shell, "-lc", COMMAND));
    }

    #[test]
    fn preserves_script_quoting_and_passes_an_install_path_as_one_argv_entry() {
        let shell = "D:\\Jane's tools & utilities\\Git\\bin\\bash.exe";
        let script = "git -C 'C:/Jane'\\''s project' show 'HEAD:file $(echo unsafe).txt' | base64";
        let found = Windows::new()
            .git("D:\\Jane's tools & utilities\\Git\\cmd\\git.exe")
            .file(shell)
            .run(script, None);
        assert_eq!(found.unwrap(), argv(shell, "-lc", script));
    }

    #[test]
    fn explains_how_to_recover_when_git_bash_and_sh_are_missing() {
        let looked_up = RefCell::new(Vec::<String>::new());
        let which = |name: &str| {
            looked_up.borrow_mut().push(name.to_owned());
            (name == "bash").then(|| "C:\\Windows\\System32\\bash.exe".to_owned())
        };
        let is_file = |_: &str| false;
        let env: Vec<(String, String)> = Vec::new();
        let options = ShellOptions {
            platform: Some("win32"),
            env: Some(&env),
            which: Some(&which),
            is_file: Some(&is_file),
            login: None,
        };
        let error = git_shell_command(COMMAND, None, &options).unwrap_err();
        assert!(error.contains(
            "Install Git for Windows, or add its cmd or bin directory to PATH, then restart Roamgate"
        ));
        // Windows' WSL bash launcher is not a native Git Bash.
        assert_eq!(*looked_up.borrow(), ["git", "sh"]);
    }

    #[test]
    fn does_not_probe_relative_environment_paths_from_a_workspace() {
        let checked = RefCell::new(Vec::<String>::new());
        let which = |_: &str| None;
        let is_file = |path: &str| {
            checked.borrow_mut().push(path.to_owned());
            false
        };
        let env = vec![("ProgramFiles".to_owned(), "relative".to_owned())];
        let options = ShellOptions {
            platform: Some("win32"),
            env: Some(&env),
            which: Some(&which),
            is_file: Some(&is_file),
            login: None,
        };
        let error = git_shell_command(COMMAND, None, &options).unwrap_err();
        assert!(error.contains("Local Git operations require Git Bash"));
        assert!(
            !checked
                .borrow()
                .iter()
                .any(|path| path.starts_with("relative"))
        );
    }

    #[test]
    fn keeps_s_shell_execution_unchanged() {
        for platform in ["linux", "darwin"] {
            let which = |_: &str| -> Option<String> { panic!("unexpected local discovery") };
            let options = ShellOptions {
                platform: Some(platform),
                which: Some(&which),
                ..ShellOptions::default()
            };
            assert_eq!(
                git_shell_command(COMMAND, None, &options).unwrap(),
                Invocation::local(["sh", "-lc", COMMAND])
            );
        }
    }

    #[test]
    fn keeps_remote_execution_unchanged_even_on_a_windows_host_with_no_shell() {
        let which = |_: &str| -> Option<String> { panic!("unexpected local discovery") };
        let options = ShellOptions {
            platform: Some("win32"),
            which: Some(&which),
            ..ShellOptions::default()
        };
        assert_eq!(
            git_shell_command(COMMAND, Some("user@dev.example"), &options).unwrap(),
            Invocation::ssh("user@dev.example", COMMAND, Some("git.shell"))
        );
    }

    #[test]
    fn runs_a_git_only_script_in_a_plain_shell_off_windows_a_login_one_there() {
        for platform in ["linux", "darwin"] {
            let options = ShellOptions {
                platform: Some(platform),
                login: Some(false),
                ..ShellOptions::default()
            };
            assert_eq!(
                git_shell_command(COMMAND, None, &options).unwrap(),
                Invocation::local(["sh", "-c", COMMAND])
            );
        }
        let shell = "C:\\Program Files\\Git\\bin\\bash.exe";
        let found = Windows::new()
            .git("C:\\Program Files\\Git\\cmd\\git.exe")
            .file(shell)
            .run(COMMAND, Some(false));
        assert_eq!(found.unwrap(), argv(shell, "-lc", COMMAND));
    }
}
