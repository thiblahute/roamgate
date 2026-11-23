//! The shell a workspace script runs in (workspace/git-shell.ts): `sh` on
//! POSIX, Git for Windows' Bash on a Windows machine, the login shell of
//! the host over SSH.

use std::collections::BTreeSet;
use std::path::Path;

use crate::exec::Invocation;

/// The message when a Windows machine has no shell for Git.
pub const NO_GIT_BASH: &str = "Local Git operations require Git Bash. Install Git for Windows, or add its cmd or bin directory to PATH, then restart Roamgate.";

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

fn which_on_path(command: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = directory.join(format!("{command}{extension}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn is_file_here(path: &str) -> bool {
    Path::new(path).is_file()
}

// Windows path helpers on strings (Node's path.win32), so they work the
// same on any build machine.

fn win_is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.first().is_some_and(|b| *b == b'\\' || *b == b'/') {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn win_normalize(path: &str) -> String {
    let unified = path.replace('/', "\\");
    let (prefix, rest) = if unified.len() >= 2 && unified.as_bytes()[1] == b':' {
        unified.split_at(2)
    } else {
        ("", unified.as_str())
    };
    let absolute = rest.starts_with('\\');
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("\\");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("{prefix}\\{joined}"),
        (false, true) => format!("{prefix}."),
        (false, false) => format!("{prefix}{joined}"),
    }
}

fn win_join(parts: &[&str]) -> String {
    win_normalize(&parts.join("\\"))
}

fn win_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rfind(['\\', '/']) {
        Some(0) => trimmed[..1].to_owned(),
        Some(index) if index == 2 && trimmed.as_bytes()[1] == b':' => trimmed[..3].to_owned(),
        Some(index) => trimmed[..index].to_owned(),
        None => ".".to_owned(),
    }
}

fn win_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn windows_git_shell(options: &ShellOptions<'_>) -> Result<String, String> {
    let process_env: Vec<(String, String)>;
    let env: &[(String, String)] = match options.env {
        Some(env) => env,
        None => {
            process_env = std::env::vars().collect();
            &process_env
        }
    };
    let which = |name: &str| match options.which {
        Some(which) => which(name),
        None => which_on_path(name),
    };
    let exists = |path: &str| match options.is_file {
        Some(is_file) => is_file(path),
        None => is_file_here(path),
    };
    let env_value = |name: &str| {
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    // Insertion order, without repeats (a JS Set).
    let mut roots: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut add_root = |root: Option<String>| {
        if let Some(root) = root
            && win_is_absolute(&root)
        {
            let normal = win_normalize(&root);
            if seen.insert(normal.clone()) {
                roots.push(normal);
            }
        }
    };

    // The default Git for Windows installer puts only cmd/git.exe on PATH.
    // Also handle portable installs and direct mingw*/ucrt*/clang*/bin paths.
    if let Some(git) = which("git")
        && win_is_absolute(&git)
    {
        let directory = win_dirname(&git);
        let name = win_basename(&directory).to_lowercase();
        if name == "cmd" || name == "bin" {
            add_root(Some(win_dirname(&directory)));
            if name == "bin" {
                add_root(Some(win_dirname(&win_dirname(&directory))));
            }
        }
    }

    // A GUI or service launch may have no Git (or even no PATH).
    let drive = env_value("SystemDrive");
    let system_drive = match drive {
        Some(drive)
            if drive.len() == 2
                && drive.as_bytes()[0].is_ascii_alphabetic()
                && drive.as_bytes()[1] == b':' =>
        {
            drive
        }
        _ => "C:".to_owned(),
    };
    for directory in [
        env_value("ProgramW6432"),
        env_value("ProgramFiles"),
        env_value("ProgramFiles(x86)"),
        Some(format!("{system_drive}\\Program Files")),
        Some(format!("{system_drive}\\Program Files (x86)")),
    ]
    .into_iter()
    .flatten()
    {
        add_root(Some(win_join(&[&directory, "Git"])));
    }
    if let Some(local) = env_value("LOCALAPPDATA") {
        add_root(Some(win_join(&[&local, "Programs", "Git"])));
    }

    for root in &roots {
        // Prefer the console wrapper, not git-bash.exe (a GUI launcher).
        for relative in ["bin\\bash.exe", "usr\\bin\\bash.exe"] {
            let shell = win_join(&[root, relative]);
            if exists(&shell) {
                return Ok(shell);
            }
        }
    }

    // Keep a POSIX shell on PATH, but never a generic bash.exe: Windows'
    // WSL launcher cannot work on native paths as they are.
    if let Some(sh) = which("sh") {
        return Ok(sh);
    }
    Err(NO_GIT_BASH.to_owned())
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
        windows_git_shell(options)?
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
