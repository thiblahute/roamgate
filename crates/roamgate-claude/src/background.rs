//! Background Claude Code sessions (`spawnClaude` of
//! `voice/voice-cleaner.ts`, and the research and tool jobs that run the
//! same way): `claude -p` reading stream-json messages from stdin, kept
//! running so each request costs only the model's answer. They run on
//! [`spawn_claude_process`], the one Claude Code process of the workspace,
//! with their own arguments and environment: no Herdr pane variables and
//! no `CLAUDECODE` marker (Ranger's turns keep the latter; see
//! [`crate::driver::spawn_claude_code`]).
//!
//! A session is a [`LineSession`]: lines in, lines out, a kill.

use std::path::PathBuf;

use roamgate_conversation::driver::BackgroundMemoryLaunch;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::driver::{
    ClaudeCommand, LocalClaudeProcess, SpawnOptions, command_env, spawn_claude_process,
};

/// The environment of a background Claude Code session: without the Herdr
/// pane variables of a bridge started from a pane, whose hooks would
/// otherwise re-point that pane's agent session at this one, nor Claude
/// Code's own marker of running inside it.
pub fn background_claude_env(
    env: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(name, _)| !name.starts_with("HERDR_") && name != "CLAUDECODE")
        .collect()
}

/// How a background session is started (`spawnClaude`'s options).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackgroundOptions {
    /// The answer's text as it is written, too (`--include-partial-messages`):
    /// the voice front's words are said before its JSON object is over.
    pub partial: bool,
    /// With the companion's memory (`CompanionMemoryDriver`), instead of a
    /// bare model.
    pub launch: Option<BackgroundMemoryLaunch>,
}

/// `spawnClaude`'s arguments after the program.
pub fn background_args(
    model: &str,
    system_prompt: &str,
    options: &BackgroundOptions,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .map(String::from)
    .to_vec();
    if options.partial {
        args.push("--include-partial-messages".into());
    }
    args.extend(["--model".into(), model.to_owned()]);
    // The user waits for each answer, a short JSON object: at its default
    // effort, Opus thinks for seconds before it.
    args.extend(["--effort".into(), "low".into()]);
    args.extend([
        "--tools".into(),
        options
            .launch
            .as_ref()
            .map(|l| l.tools.clone())
            .unwrap_or_default(),
    ]);
    // No hooks, plugins, MCP servers or CLAUDE.md: a bare model.
    match &options.launch {
        Some(launch) => args.extend(launch.args.iter().cloned()),
        None => args.push("--safe-mode".into()),
    }
    args.extend([
        "--strict-mcp-config".into(),
        "--no-session-persistence".into(),
        "--system-prompt".into(),
        system_prompt.to_owned(),
    ]);
    args
}

/// One background session: lines to write, the lines it writes (the
/// channel closes once it exited), and a kill.
pub struct LineSession {
    pub input: mpsc::UnboundedSender<String>,
    pub lines: mpsc::UnboundedReceiver<String>,
    pub kill: Box<dyn FnOnce() + Send>,
}

impl LineSession {
    pub fn from_parts(
        input: mpsc::UnboundedSender<String>,
        lines: mpsc::UnboundedReceiver<String>,
        kill: impl FnOnce() + Send + 'static,
    ) -> Self {
        Self {
            input,
            lines,
            kill: Box::new(kill),
        }
    }

    /// A session that never started: its output ends at once.
    fn ended() -> Self {
        let (input, _) = mpsc::unbounded_channel();
        let (_, lines) = mpsc::unbounded_channel();
        Self::from_parts(input, lines, || {})
    }
}

impl LocalClaudeProcess {
    /// The process as lines in and out: its stdin written line by line
    /// (closed once `input` is dropped), its stdout read line by line; it
    /// is stopped (its process group) and reaped once its output ends or
    /// it is killed.
    pub fn into_lines(mut self) -> LineSession {
        let (input, mut to_write) = mpsc::unbounded_channel::<String>();
        let (lines_tx, lines) = mpsc::unbounded_channel::<String>();
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let stdin = self.take_stdin();
        let stdout = self.take_stdout();
        tokio::spawn(async move {
            if let Some(mut stdin) = stdin {
                while let Some(line) = to_write.recv().await {
                    if stdin.write_all(line.as_bytes()).await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        break;
                    }
                }
            }
        });
        tokio::spawn(async move {
            let reader = async {
                if let Some(mut stdout) = stdout {
                    let mut line = Vec::new();
                    loop {
                        line.clear();
                        match stdout.read_until(b'\n', &mut line).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {
                                if line.last() == Some(&b'\n') {
                                    line.pop();
                                }
                                let text = String::from_utf8_lossy(&line).into_owned();
                                if lines_tx.send(text).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            };
            tokio::select! {
                () = reader => {}
                _ = kill_rx => {}
            }
            use crate::driver::ClaudeProcess as _;
            self.kill();
            let _ = self.wait().await;
        });
        LineSession::from_parts(input, lines, move || {
            let _ = kill_tx.send(());
        })
    }
}

/// A background Claude Code process: `command` with `args`, in `cwd`, in a
/// background session's environment. A process that cannot start is one
/// whose output ends at once.
pub fn spawn_lines(command: &ClaudeCommand, args: Vec<String>, cwd: PathBuf) -> LineSession {
    let mut argv = vec![command.program.clone()];
    argv.extend(if cfg!(windows) {
        system_prompt_in_file(args, &std::env::temp_dir())
    } else {
        args
    });
    let spawned = spawn_claude_process(SpawnOptions {
        argv,
        cwd: Some(cwd),
        env: Some(command_env(
            command,
            background_claude_env(std::env::vars()),
        )),
        on_exit: None,
    });
    match spawned {
        Ok(process) => process.into_lines(),
        Err(error) => {
            // An ended session answers nothing: say why once here.
            tracing::warn!(target: "claude", "cannot start {}: {error}", command.program);
            LineSession::ended()
        }
    }
}

/// `--system-prompt TEXT` as `--system-prompt-file PATH`: a Windows
/// command line holds 32767 characters, fewer than the voice front's
/// prompt. The file is named by its text, written once and kept (the
/// same few prompts every time). Left as it is if it cannot be written.
pub fn system_prompt_in_file(mut args: Vec<String>, dir: &std::path::Path) -> Vec<String> {
    use sha2::{Digest, Sha256};
    let Some(at) = args.iter().position(|arg| arg == "--system-prompt") else {
        return args;
    };
    let Some(prompt) = args.get(at + 1) else {
        return args;
    };
    let name = hex::encode(&Sha256::digest(prompt.as_bytes())[..8]);
    let path = dir.join(format!("roamgate-system-prompt-{name}.txt"));
    if !path.is_file() {
        // Whole or not at all: another session may read it at once.
        let partial = dir.join(format!(
            "roamgate-system-prompt-{name}.{}.tmp",
            std::process::id()
        ));
        if std::fs::write(&partial, prompt).is_err() || std::fs::rename(&partial, &path).is_err() {
            let _ = std::fs::remove_file(&partial);
            if !path.is_file() {
                return args;
            }
        }
    }
    args[at] = "--system-prompt-file".into();
    args[at + 1] = path.to_string_lossy().into_owned();
    args
}

/// `spawnClaude`: `claude -p` in stream-json, reading what it is sent, in
/// the launch's folder or the system's temporary one.
pub fn spawn_background(
    model: &str,
    command: &ClaudeCommand,
    system_prompt: &str,
    options: &BackgroundOptions,
) -> LineSession {
    let cwd = options
        .launch
        .as_ref()
        .and_then(|l| l.cwd.clone())
        .map_or_else(std::env::temp_dir, PathBuf::from);
    spawn_lines(command, background_args(model, system_prompt, options), cwd)
}

#[cfg(test)]
mod tests;
