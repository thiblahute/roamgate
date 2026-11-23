//! Running glab and gh on the checkout's host (review/forge-cli.ts), and
//! turning their API answers into what the review reads: patches, commits
//! and files.
//!
//! Where a process runs is the host layer's: a [`ForgeRunner`] runs what
//! this module builds, a CLI or a script on this machine, or a command line
//! over the connection's SSH (Bun's until the host layer moves, answered by
//! a reverse call). The command lines themselves, and which of them may be
//! rerun cold, are decided here as review/forge-cli.ts decides them.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use roamgate_agents::js;
use roamgate_base::clock::{BoxFuture, SharedClock};
use roamgate_exec::process::{Command, ExecError, ProcessRunner};
use roamgate_exec::quote::shell_quote;

use super::memo::Memo;
use crate::gate::{ForgeGate, ProcessOutput};

/// How long a forge CLI or script may take.
pub const TIMEOUT_MS: u64 = 30_000;

/// A process the forge code asks to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeProcess {
    /// A forge CLI on this machine, in `cwd`, with `env` set and `unset`
    /// removed from the server's environment.
    Cli {
        argv: Vec<String>,
        cwd: String,
        env: Vec<(String, String)>,
        unset: Vec<String>,
    },
    /// A read-only shell script on this machine (git's shell), in `cwd`
    /// when given.
    Script { script: String, cwd: Option<String> },
    /// A command line on the checkout's host over its SSH. `read`: it has
    /// no side effect, so a cold rerun after its master died is safe
    /// (sshReadCommandArgv); a write never is (sshCommandArgv).
    Ssh {
        host: String,
        command: String,
        read: bool,
        tag: String,
    },
}

/// Why a process did not run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// The program, or the directory it runs in, does not exist (ENOENT).
    Missing(String),
    Failed(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

/// Runs the forge code's processes (a runtime's `runProcessWithCodeTimeout`).
pub trait ForgeRunner: Send + Sync + 'static {
    fn run(
        &self,
        process: ForgeProcess,
        timeout_ms: u64,
    ) -> BoxFuture<Result<ProcessOutput, RunError>>;
}

/// The runner of this machine's processes; SSH runs are refused (they are
/// the host layer's).
pub struct LocalForgeRunner {
    runner: ProcessRunner,
}

impl LocalForgeRunner {
    pub fn new(runner: ProcessRunner) -> Self {
        Self { runner }
    }
}

impl ForgeRunner for LocalForgeRunner {
    fn run(
        &self,
        process: ForgeProcess,
        timeout_ms: u64,
    ) -> BoxFuture<Result<ProcessOutput, RunError>> {
        let command = match process {
            ForgeProcess::Cli {
                argv,
                cwd,
                env,
                unset,
            } => {
                let mut command = Command::new(argv).cwd(cwd);
                for name in unset {
                    command = command.env_remove(name);
                }
                for (key, value) in env {
                    command = command.env(key, value);
                }
                command
            }
            ForgeProcess::Script { script, cwd } => {
                let mut command = Command::new(["sh", "-c"]).arg(script);
                if let Some(cwd) = cwd {
                    command = command.cwd(cwd);
                }
                command
            }
            ForgeProcess::Ssh { host, .. } => {
                return Box::pin(async move {
                    Err(RunError::Failed(format!(
                        "no SSH runner for {host} in this process"
                    )))
                });
            }
        }
        .timeout(Duration::from_millis(timeout_ms))
        .missing_is_error();
        let runner = self.runner.clone();
        Box::pin(async move {
            match runner.run(&command).await {
                Ok(output) => Ok(ProcessOutput {
                    code: output.code,
                    stdout: output.stdout_text(),
                    stderr: output.stderr_text(),
                }),
                Err(ExecError::Spawn { source, .. })
                    if source.kind() == std::io::ErrorKind::NotFound =>
                {
                    Err(RunError::Missing(source.to_string()))
                }
                Err(error) => Err(RunError::Failed(error.to_string())),
            }
        })
    }
}

/// What one runner's forge calls share: the gate's scope (its `owner`),
/// and what glab and gh said of each host, remembered a while
/// (review/gitlab.ts and review/forge.ts key these by the runner).
#[derive(Clone)]
pub struct ForgeTools {
    pub runner: Arc<dyn ForgeRunner>,
    pub gate: ForgeGate,
    pub clock: SharedClock,
    /// The gate's scope: one budget per owner, checkout host and forge host.
    pub owner: String,
    /// Whether glab has a login of its own for a host (glabHostAccess).
    pub(crate) host_checks: Memo<bool>,
    /// gh's exit code for `auth status` on a host (ghHostLogin).
    pub(crate) gh_logins: Memo<i32>,
}

impl ForgeTools {
    pub fn new(
        runner: Arc<dyn ForgeRunner>,
        gate: ForgeGate,
        clock: SharedClock,
        owner: impl Into<String>,
    ) -> Self {
        Self {
            runner,
            gate,
            clock,
            owner: owner.into(),
            host_checks: Memo::default(),
            gh_logins: Memo::default(),
        }
    }

    /// A checkout's context: `host` is its connection's SSH destination,
    /// none on this machine.
    pub fn context(&self, root: impl Into<String>, host: Option<String>) -> ForgeContext {
        ForgeContext {
            root: root.into(),
            host: host.filter(|host| !host.is_empty()),
            tools: self.clone(),
        }
    }
}

/// A checkout, and where its forge CLIs run (review/gitlab.ts GlabContext).
#[derive(Clone)]
pub struct ForgeContext {
    pub root: String,
    /// The checkout's SSH host; none: this machine.
    pub host: Option<String>,
    pub tools: ForgeTools,
}

impl ForgeContext {
    /// The same host and tools, another checkout.
    pub fn at(&self, root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            ..self.clone()
        }
    }

    /// The gate's checkout key (`context.host ?? ""`).
    pub(crate) fn checkout_key(&self) -> String {
        self.host.clone().unwrap_or_default()
    }
}

fn home() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| "/".to_owned())
}

/// A removed checkout runs its command from home.
fn cwd_of(context: &ForgeContext) -> String {
    if Path::new(&context.root).exists() {
        context.root.clone()
    } else {
        home()
    }
}

/// How a forge CLI runs (runForgeCli's options).
pub struct CliOptions<'a> {
    pub env: &'a [(&'a str, &'a str)],
    /// Only a read may be: a cold SSH retry of a write could make it twice,
    /// such as a second pending comment.
    pub retry_safe: bool,
    pub tag: &'a str,
    pub unset: &'a [&'a str],
}

/// A forge CLI on the checkout's host, with `env` set and `unset` removed;
/// code 127 when it is not installed.
pub async fn run_forge_cli(
    context: &ForgeContext,
    argv: Vec<String>,
    options: CliOptions<'_>,
) -> Result<ProcessOutput, String> {
    let runner = &context.tools.runner;
    if let Some(host) = &context.host {
        let without = if options.unset.is_empty() {
            String::new()
        } else {
            format!(
                "env {} ",
                options
                    .unset
                    .iter()
                    .map(|name| format!("-u {name}"))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        let env = options
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(" ");
        let words = argv
            .iter()
            .map(|word| shell_quote(word))
            .collect::<Vec<_>>()
            .join(" ");
        // `glab api` names its project: a removed checkout runs it from home.
        let command = format!(
            "{{ cd {} 2>/dev/null || cd; }} && {without}{env} {words}",
            shell_quote(&context.root)
        );
        return runner
            .run(
                ForgeProcess::Ssh {
                    host: host.clone(),
                    command,
                    read: options.retry_safe,
                    tag: options.tag.to_owned(),
                },
                TIMEOUT_MS,
            )
            .await
            .map_err(|error| error.to_string());
    }
    // A missing cwd fails the spawn as a missing CLI would.
    match runner
        .run(
            ForgeProcess::Cli {
                argv,
                cwd: cwd_of(context),
                env: options
                    .env
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                    .collect(),
                unset: options
                    .unset
                    .iter()
                    .map(|name| (*name).to_owned())
                    .collect(),
            },
            TIMEOUT_MS,
        )
        .await
    {
        Ok(output) => Ok(output),
        Err(RunError::Missing(_)) => Ok(ProcessOutput {
            code: 127,
            ..ProcessOutput::default()
        }),
        Err(RunError::Failed(message)) => Err(message),
    }
}

/// gh on the checkout's host (see [`CliOptions::retry_safe`]).
pub async fn spawn_gh(
    context: &ForgeContext,
    argv: Vec<String>,
    retry_safe: bool,
) -> Result<ProcessOutput, String> {
    run_forge_cli(
        context,
        argv,
        CliOptions {
            env: &[
                ("GH_PROMPT_DISABLED", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("NO_COLOR", "1"),
            ],
            retry_safe,
            tag: "forge.github",
            unset: &[],
        },
    )
    .await
}

/// A read-only shell script on the checkout's host; `cwd`: run it in the
/// checkout (from home when it is gone) on this machine.
pub async fn run_forge_script(
    context: &ForgeContext,
    script: String,
    tag: &str,
    cwd: bool,
) -> Result<ProcessOutput, RunError> {
    let process = match &context.host {
        Some(host) => ForgeProcess::Ssh {
            host: host.clone(),
            command: script,
            read: true,
            tag: tag.to_owned(),
        },
        None => ForgeProcess::Script {
            script,
            cwd: cwd.then(|| cwd_of(context)),
        },
    };
    context.tools.runner.run(process, TIMEOUT_MS).await
}

/// The last lines of a failed CLI's output, for its error.
pub fn cli_error(forge: &str, text: &str) -> String {
    let fallback = format!("{forge} request failed");
    let text = if text.is_empty() { &fallback } else { text };
    let lines: Vec<&str> = js::trim(text).split('\n').collect();
    let last = lines[lines.len().saturating_sub(3)..].join(" ");
    format!("{forge}: {}", js::head16(&last, 300))
}

/// A changed file as a forge's API lists it; no patch when it is binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiFile {
    pub old_path: String,
    pub new_path: String,
    pub added: bool,
    pub deleted: bool,
    pub patch: Option<String>,
}

/// The files' changes as one unified patch.
pub fn api_files_patch(files: &[ApiFile]) -> String {
    files
        .iter()
        .map(|file| {
            let header = format!("diff --git a/{} b/{}", file.old_path, file.new_path);
            let Some(patch) = &file.patch else {
                return format!("{header}\nBinary files differ");
            };
            let old = if file.added {
                "/dev/null".to_owned()
            } else {
                format!("a/{}", file.old_path)
            };
            let new = if file.deleted {
                "/dev/null".to_owned()
            } else {
                format!("b/{}", file.new_path)
            };
            let body = patch.strip_suffix('\n').unwrap_or(patch);
            format!("{header}\n--- {old}\n+++ {new}\n{body}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A commit message's subject and body.
pub fn commit_from_message(message: &str) -> (String, String) {
    let mut lines = message.split('\n');
    let subject = lines.next().unwrap_or("").to_owned();
    let body = lines.collect::<Vec<_>>().join("\n");
    (subject, js::trim(&body).to_owned())
}

/// A file's text from a forge's base64 `content`.
pub fn base64_file(forge: &str, content: Option<&serde_json::Value>) -> Result<String, String> {
    let Some(content) = content.and_then(serde_json::Value::as_str) else {
        return Err(format!("{forge} returned no file"));
    };
    // Node's base64 decoding skips what is not of the alphabet (GitLab and
    // GitHub wrap their lines).
    let clean: String = content
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'))
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean.trim_end_matches('='))
        .unwrap_or_default();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// JavaScript's truthiness of a JSON value (missing is undefined).
pub fn truthy(value: Option<&serde_json::Value>) -> bool {
    use serde_json::Value;
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}
