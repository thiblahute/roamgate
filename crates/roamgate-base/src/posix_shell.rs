//! The POSIX shell of this machine: `sh` off Windows, and on Windows Git
//! for Windows' bash, found as workspace/git-shell.ts finds it (Git on
//! PATH, the Program Files and per-user installs, then an `sh` on PATH).
//! Git scripts, conversation `!` lines and the parity suite's `sh:` steps
//! all run through it.

use std::collections::BTreeSet;
use std::path::Path;

/// The message when a Windows machine has no shell for Git.
pub const NO_GIT_BASH: &str = "Local Git operations require Git Bash. Install Git for Windows, or add its cmd or bin directory to PATH, then restart Roamgate.";

type Which<'a> = &'a dyn Fn(&str) -> Option<String>;
type IsFile<'a> = &'a dyn Fn(&str) -> bool;

/// How the shell is looked up: tests set the environment and lookups, a
/// server leaves them to this machine.
#[derive(Default)]
pub struct Lookup<'a> {
    /// The environment; this process's when None.
    pub env: Option<&'a [(String, String)]>,
    pub which: Option<Which<'a>>,
    pub is_file: Option<IsFile<'a>>,
}

/// This machine's POSIX shell: `sh` off Windows, Git for Windows' bash on
/// Windows ([`windows_git_bash`]).
pub fn posix_shell() -> Result<String, String> {
    if cfg!(windows) {
        windows_git_bash(&Lookup::default())
    } else {
        Ok("sh".to_owned())
    }
}

/// `command` on PATH (with PATHEXT's extensions on Windows).
pub fn which_on_path(command: &str) -> Option<String> {
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

/// Git for Windows' bash (its console `bash.exe`, never the GUI
/// launcher), else an `sh` on PATH; [`NO_GIT_BASH`] when there is none.
pub fn windows_git_bash(options: &Lookup<'_>) -> Result<String, String> {
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
