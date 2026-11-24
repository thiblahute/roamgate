//! Git for the history repo (history/git.ts): never the user's identity,
//! hooks, signing or system config; at a low priority when asked (a pass
//! yields the CPU to whatever the user runs). Blocking: the repo runs its
//! passes on a blocking thread, never on the event loop.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

/// What a git command gave.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// What a command runs with besides its arguments.
#[derive(Debug, Clone, Default)]
pub struct GitRun {
    pub env: Vec<(String, String)>,
    pub input: Option<String>,
}

/// Runs git in the repo (tests swap it).
pub type GitRunner = Arc<dyn Fn(&[String], &GitRun) -> GitResult + Send + Sync>;

/// The options every history command runs with, whatever the user's config
/// says.
const FIXED: &[&str] = &[
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "init.defaultBranch=main",
    "-c",
    "advice.detachedHead=false",
];

/// The environment without anything that points git elsewhere.
fn clean_environment() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(key, _)| !key.starts_with("GIT_"))
        .collect();
    out.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
    out.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    out.push(("LC_ALL".into(), "C".into()));
    out
}

/// The runner of the repo at `repo`: `git` (or `git` given), each child at
/// nice 19 when `low_priority`.
pub fn git_runner(repo: &Path, git: Option<&str>, low_priority: bool) -> GitRunner {
    let repo: PathBuf = repo.to_path_buf();
    let git = git.unwrap_or("git").to_owned();
    Arc::new(move |args, run| {
        // A directory that never exists: none of the user's hooks run.
        let hooks = format!(
            "core.hooksPath={}",
            repo.join(".git").join("roamgate-no-hooks").display()
        );
        let mut command = Command::new(&git);
        command
            .arg("-C")
            .arg(&repo)
            .args(FIXED)
            .arg("-c")
            .arg(hooks)
            .args(args)
            .env_clear()
            .envs(clean_environment())
            .envs(run.env.iter().map(|(key, value)| (key, value)))
            .stdin(if run.input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return GitResult {
                    code: -1,
                    stdout: String::new(),
                    stderr: format!("cannot run {git}: {error}"),
                };
            }
        };
        if low_priority {
            // Not allowed here, or the child is gone: it runs as it is.
            #[cfg(unix)]
            if let Some(pid) = rustix::process::Pid::from_raw(child.id() as i32) {
                let _ = rustix::process::setpriority_process(Some(pid), 19);
            }
        }
        if let (Some(input), Some(mut stdin)) = (run.input.as_ref(), child.stdin.take()) {
            let _ = stdin.write_all(input.as_bytes());
        }
        match child.wait_with_output() {
            Ok(output) => GitResult {
                code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => GitResult {
                code: -1,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    })
}

/// A git command that failed, worded as Bun words it.
pub fn git_error(args: &[String], result: &GitResult) -> String {
    let text = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    format!(
        "git {} failed ({}): {}",
        args.first().map(String::as_str).unwrap_or(""),
        result.code,
        roamgate_agents::js::head16(roamgate_agents::js::trim(text), 300)
    )
}

/// Runs and fails on a non-zero exit; the output.
pub fn git_ok(git: &GitRunner, args: &[&str], run: &GitRun) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let result = git(&args, run);
    if result.code != 0 {
        return Err(git_error(&args, &result));
    }
    Ok(result.stdout)
}

/// Runs, whatever the exit.
pub fn git_any(git: &GitRunner, args: &[&str]) -> GitResult {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    git(&args, &GitRun::default())
}
