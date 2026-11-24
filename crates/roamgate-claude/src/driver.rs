//! Agent turns on Claude Code (`assistant/claude-driver.ts`): each turn is
//! one `claude -p` run with stream-json in and out, resumed from the
//! session the last turn left. Claude Code's own tools, hooks, skills and
//! MCP servers are off; the turn's tools come over MCP for the turn alone
//! ([`crate::mcp`]), with the caller's instructions as the system prompt.
//! It signs in as `claude` does on this machine.
//!
//! Generic over the agent: Ranger, the reviews agent and later the
//! curation runs give their tools ([`McpTool`]s, built per turn) and their
//! system prompt; the turn reports through [`TurnEvent`]s. The command is
//! the caller's ([`CommandSource`]): the agent profiles (`profiles.ts`'s
//! `defaultCommand`) have no Rust port yet, so [`CommandSource::default`]
//! is the plain `claude`, until the profiles' crate resolves the default
//! profile.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::future::BoxFuture;
use regex::Regex;
use roamgate_agents::js;
use roamgate_base::paths::{DataContext, random_uuid};
use roamgate_base::private::{OpenMode, create_dir_all_mode, open_nofollow};
use roamgate_exec::process::{Command, Pipes, ProcessRunner, Spawned};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::mcp::{ClaudeError, ClaudeMcp, McpTool, McpTurn, SourcesSink};

/// `CLAUDE_CODE_PROVIDER` (shared/assistant.ts).
pub const CLAUDE_CODE_PROVIDER: &str = "claude-code";
/// `ASSISTANT_MAX_TOOL_ARGUMENTS` (shared/assistant.ts), in UTF-16 units.
pub const ASSISTANT_MAX_TOOL_ARGUMENTS: usize = 8_000;
/// `ASSISTANT_MAX_TOOL_OUTPUT` (shared/assistant.ts), in UTF-16 units.
pub const ASSISTANT_MAX_TOOL_OUTPUT: usize = 16_000;
/// Claude Code's model aliases: each names its family's latest model.
pub const CLAUDE_CODE_MODELS: [(&str, &str); 3] = [
    ("opus", "Claude Opus"),
    ("sonnet", "Claude Sonnet"),
    ("haiku", "Claude Haiku"),
];
/// The thinking levels Claude Code takes as `--effort`.
pub const CLAUDE_CODE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const TRUNCATED: &str = "\n[truncated]";
/// The pointer's type in the saved context.
pub const CLAUDE_CODE_POINTER: &str = "ranger-claude";
/// The error a recovered turn fails with: it is never replayed.
pub const NOT_RETRIED: &str = "The Claude Code turn was interrupted. It was not retried because an operation may already have run. Review the action receipts and send a new question.";

static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});

/// Whether `entries` is the one pointer a Claude Code turn leaves
/// (`{type: "ranger-claude", session}`).
pub fn is_claude_code_pointer(entries: &[Value]) -> bool {
    let [pointer] = entries else {
        return false;
    };
    pointer.get("type").and_then(Value::as_str) == Some(CLAUDE_CODE_POINTER)
        && pointer
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|session| SESSION_ID.is_match(session))
}

/// The pointer to `session`.
pub fn claude_code_pointer(session: &str) -> Value {
    json!({ "type": CLAUDE_CODE_POINTER, "session": session })
}

// ------------------------------------------------------------ the command

/// The program and environment of a Claude Code command (`AgentCommand`
/// of `profiles.ts`, what the driver and the background sessions use of
/// it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCommand {
    pub program: String,
    /// Set over the base environment, after `unset`.
    pub env: Vec<(String, String)>,
    /// Removed from the base environment.
    pub unset: Vec<String>,
    /// A profile's command rather than a bare program (`commandKey`
    /// hashes those).
    pub profile: bool,
}

impl ClaudeCommand {
    /// `PLAIN_CLAUDE`: `claude` with the environment as it is.
    pub fn plain() -> Self {
        Self::program("claude")
    }

    /// `{...PLAIN_CLAUDE, program}`.
    pub fn program(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            env: Vec::new(),
            unset: Vec::new(),
            profile: false,
        }
    }

    /// Tells two commands apart (`commandKey`): a warm session restarts
    /// when it changes.
    pub fn key(&self) -> String {
        use sha2::{Digest, Sha256};
        if !self.profile {
            return self.program.clone();
        }
        let env: serde_json::Map<String, Value> = self
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let text = js::stringify(&json!([self.program, env, self.unset]));
        hex::encode(Sha256::digest(text.as_bytes()))[..16].to_owned()
    }
}

impl Default for ClaudeCommand {
    fn default() -> Self {
        Self::plain()
    }
}

/// `commandEnv`: `command`'s environment over `base`.
pub fn command_env(command: &ClaudeCommand, base: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = base
        .into_iter()
        .filter(|(name, _)| !command.unset.contains(name))
        .collect();
    for (name, value) in &command.env {
        match env.iter_mut().find(|(known, _)| known == name) {
            Some(entry) => entry.1 = value.clone(),
            None => env.push((name.clone(), value.clone())),
        }
    }
    env
}

/// Where the command comes from: an explicit program (tests,
/// `ROAMGATE_*_COMMAND`), or a resolver read at each run (the default
/// profile may have changed).
#[derive(Clone)]
pub enum CommandSource {
    Program(String),
    Resolve(Arc<dyn Fn() -> Result<ClaudeCommand, ClaudeError> + Send + Sync>),
}

impl Default for CommandSource {
    /// The plain `claude`: `defaultCommand()` moves here with the profiles'
    /// crate.
    fn default() -> Self {
        Self::Resolve(Arc::new(|| Ok(ClaudeCommand::plain())))
    }
}

impl CommandSource {
    pub fn resolve(&self) -> Result<ClaudeCommand, ClaudeError> {
        match self {
            Self::Program(program) => Ok(ClaudeCommand::program(program.clone())),
            Self::Resolve(resolve) => resolve(),
        }
    }
}

/// `Bun.which`: the program's path when it is one, else its first match
/// on PATH (with PATHEXT on Windows).
pub fn which(program: &str) -> Option<PathBuf> {
    fn runnable(path: &Path) -> bool {
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            metadata.is_file()
        }
    }
    let extensions: Vec<String> = if cfg!(windows) {
        std::iter::once(String::new())
            .chain(
                std::env::var("PATHEXT")
                    .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(str::to_owned),
            )
            .collect()
    } else {
        vec![String::new()]
    };
    let candidates = |base: PathBuf| {
        extensions
            .iter()
            .map(move |extension| PathBuf::from(format!("{}{extension}", base.display())))
    };
    if program.contains('/') || (cfg!(windows) && program.contains('\\')) {
        return candidates(PathBuf::from(program)).find(|path| runnable(path));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .flat_map(|directory| candidates(directory.join(program)))
        .find(|path| runnable(path))
}

// ------------------------------------------------------------ the process

/// A stream-json Claude Code process (`ClaudeCodeProcess`).
pub trait ClaudeProcess: Send {
    /// Its next stdout line; `None` once stdout ended.
    fn next_line(&mut self) -> BoxFuture<'_, Option<String>>;
    /// Writes to its stdin; fails once stdin was closed (`end`): nothing
    /// written is ever dropped.
    fn write<'a>(&'a mut self, line: &'a str) -> BoxFuture<'a, io::Result<()>>;
    /// No more input: the process exits once it has answered.
    fn end(&mut self);
    /// SIGTERM to it (and its process group).
    fn kill(&mut self);
    /// Its exit code.
    fn wait(&mut self) -> BoxFuture<'_, io::Result<i32>>;
    /// The spawned process (for SSH, the local ssh client).
    fn pid(&self) -> Option<u32> {
        None
    }
}

/// Spawns `claude` with these arguments in this folder (`SpawnClaudeCode`).
pub type SpawnClaude =
    Arc<dyn Fn(Vec<String>, PathBuf) -> Result<Box<dyn ClaudeProcess>, ClaudeError> + Send + Sync>;

/// What [`spawn_claude_process`] runs.
#[derive(Default)]
pub struct SpawnOptions {
    /// A local claude, or ssh running one on a host.
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// The whole environment; `None`: this process's.
    pub env: Option<Vec<(String, String)>>,
    /// Runs once it has exited (or its handle is dropped), to release what
    /// it held (an SSH session slot).
    pub on_exit: Option<Box<dyn FnOnce() + Send>>,
}

/// A process [`spawn_claude_process`] started.
pub struct LocalClaudeProcess {
    child: Spawned,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<BufReader<tokio::process::ChildStdout>>,
    ended: bool,
    on_exit: Option<Box<dyn FnOnce() + Send>>,
}

/// Runs a stream-json Claude Code process (`spawnClaudeProcess`): stdin and
/// stdout piped, stderr ignored, its stdout split into lines on `\n`.
pub fn spawn_claude_process(options: SpawnOptions) -> Result<LocalClaudeProcess, ClaudeError> {
    let mut command = Command::new(options.argv);
    if let Some(cwd) = options.cwd {
        command = command.cwd(cwd);
    }
    if let Some(env) = options.env {
        command = command.env_clear();
        for (name, value) in env {
            command = command.env(name, value);
        }
    }
    let mut child = ProcessRunner::system()
        .spawn_with(
            &command,
            Pipes {
                stdin: true,
                stdout: true,
                stderr: false,
            },
        )
        .map_err(|error| ClaudeError::internal(error.to_string()))?;
    Ok(LocalClaudeProcess {
        stdin: child.stdin(),
        stdout: child.stdout().map(BufReader::new),
        child,
        ended: false,
        on_exit: options.on_exit,
    })
}

impl LocalClaudeProcess {
    pub(crate) fn take_stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.stdin.take()
    }

    pub(crate) fn take_stdout(&mut self) -> Option<BufReader<tokio::process::ChildStdout>> {
        self.stdout.take()
    }

    fn exited(&mut self) {
        if let Some(on_exit) = self.on_exit.take() {
            on_exit();
        }
    }
}

impl Drop for LocalClaudeProcess {
    fn drop(&mut self) {
        self.exited();
    }
}

impl ClaudeProcess for LocalClaudeProcess {
    fn next_line(&mut self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let stdout = self.stdout.as_mut()?;
            let mut line = Vec::new();
            match stdout.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => {
                    self.stdout = None;
                    None
                }
                Ok(_) => {
                    if line.last() == Some(&b'\n') {
                        line.pop();
                    }
                    Some(String::from_utf8_lossy(&line).into_owned())
                }
            }
        })
    }

    fn write<'a>(&'a mut self, line: &'a str) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            let stdin = match (&mut self.stdin, self.ended) {
                (Some(stdin), false) => stdin,
                _ => return Err(io::Error::other("The Claude Code process is closing")),
            };
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        })
    }

    fn end(&mut self) {
        self.ended = true;
        self.stdin = None;
    }

    fn kill(&mut self) {
        self.child.kill(false);
    }

    fn wait(&mut self) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async move {
            let code = self.child.wait().await;
            self.exited();
            code
        })
    }

    fn pid(&self) -> Option<u32> {
        self.child.pid()
    }
}

/// The default spawn: the command resolved at each run, with this
/// process's environment less the `HERDR_*` variables (a bridge started
/// from a Herdr pane passes that pane's on; Claude Code would report its
/// state as that pane's), then the command's.
pub fn spawn_claude_code(command: CommandSource) -> SpawnClaude {
    Arc::new(move |args, cwd| {
        let resolved = command.resolve()?;
        let base = std::env::vars()
            .filter(|(name, _)| !name.starts_with("HERDR_"))
            .collect();
        let mut argv = vec![resolved.program.clone()];
        argv.extend(args);
        let process = spawn_claude_process(SpawnOptions {
            argv,
            cwd: Some(cwd),
            env: Some(command_env(&resolved, base)),
            on_exit: None,
        })?;
        Ok(Box::new(process) as Box<dyn ClaudeProcess>)
    })
}

// ------------------------------------------------------------ the driver

/// `value`, cut to `max` UTF-16 units with `\n[truncated]` at its end. A
/// surrogate pair the cut would split is left out (JS keeps its lone
/// first half; a Rust string cannot).
pub fn bounded(value: &str, max: usize) -> String {
    if js::len16(value) <= max {
        return value.to_owned();
    }
    let limit = max.saturating_sub(js::len16(TRUNCATED));
    let mut units = 0;
    let mut end = 0;
    for (index, c) in value.char_indices() {
        if units + c.len_utf16() > limit {
            break;
        }
        units += c.len_utf16();
        end = index + c.len_utf8();
    }
    format!("{}{TRUNCATED}", &value[..end])
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| js::is_record(part) && part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A tool's status, as Ranger's tool activity has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Completed,
    Failed,
}

impl ToolStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// What a turn reports, in the order it happens (`run`'s callbacks).
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEvent {
    /// Text streamed into the current message.
    Delta(String),
    /// A message finished.
    Message(String),
    /// A tool's activity: its name without the server's prefix, its
    /// arguments (pretty JSON, bounded) and, once done, its output.
    Tool {
        id: String,
        name: String,
        status: ToolStatus,
        arguments: Option<String>,
        output: Option<String>,
    },
    /// The turn's visible reasoning so far: one entry per thinking block.
    Thinking(Vec<String>),
    /// Sources a tool cited.
    Sources(Vec<Value>),
    /// The run failed (a failed result, no result, or a nonzero exit).
    Error,
}

/// Saves the entries to keep before the process can run a tool
/// (`checkpoint`); a failure ends the turn.
pub type Checkpoint =
    Arc<dyn Fn(Vec<Value>) -> BoxFuture<'static, Result<(), ClaudeError>> + Send + Sync>;

/// One turn (`AssistantDriver.run`'s argument, what this driver uses).
pub struct ClaudeTurn {
    /// The chat's `AssistantConfig`: `model`, `thinking_level` and
    /// `approval_mode` are read.
    pub config: Value,
    /// The saved context: none, or the pointer the last turn left.
    pub entries: Vec<Value>,
    pub text: String,
    /// The turn was interrupted: it fails, never replayed.
    pub recover: bool,
    /// The turn's tools, given whether it is automatic
    /// (`approval_mode: "auto"`).
    pub tools: Box<dyn FnOnce(bool) -> Vec<McpTool> + Send>,
    pub checkpoint: Option<Checkpoint>,
    pub events: Arc<dyn Fn(TurnEvent) + Send + Sync>,
}

/// The system prompt, given whether the turn is automatic.
pub type SystemPrompt = Arc<dyn Fn(bool) -> String + Send + Sync>;

/// [`ClaudeCodeDriver::new`]'s options (`createClaudeCodeDriver`'s).
pub struct ClaudeCodeOptions {
    /// The agent's directory: turns run in its private `claude` folder.
    pub directory: PathBuf,
    /// Checks that folder as the TS `assertSafeDataPath` does.
    pub data: DataContext,
    pub mcp: ClaudeMcp,
    pub command: CommandSource,
    /// Replaces [`spawn_claude_code`] (tests, a host over SSH).
    pub spawn: Option<SpawnClaude>,
    /// Whether the command can be found; checked for each catalog.
    pub available: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub system_prompt: SystemPrompt,
}

struct Active {
    stopped: Arc<AtomicBool>,
    kill: CancellationToken,
    done: CancellationToken,
}

struct Inner {
    directory: PathBuf,
    data: DataContext,
    mcp: ClaudeMcp,
    spawn: SpawnClaude,
    available: Arc<dyn Fn() -> bool + Send + Sync>,
    system_prompt: SystemPrompt,
    active: Mutex<Option<Active>>,
}

/// The Claude Code driver; cheap to clone.
#[derive(Clone)]
pub struct ClaudeCodeDriver(Arc<Inner>);

/// What a run releases however it ends (the TS `finally`), also when its
/// future is dropped.
struct RunGuard<'a> {
    inner: &'a Inner,
    done: CancellationToken,
    turn: CancellationToken,
    config_path: Option<PathBuf>,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.turn.cancel();
        if let Some(path) = self.config_path.take() {
            let _ = std::fs::remove_file(path);
        }
        let mut active = self.inner.active.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|active| active.done == self.done)
        {
            *active = None;
        }
        self.done.cancel();
    }
}

/// What a run holds while it runs.
struct RunState {
    retained: Vec<Value>,
    child: Option<Box<dyn ClaudeProcess>>,
    exited: bool,
}

impl ClaudeCodeDriver {
    pub fn new(options: ClaudeCodeOptions) -> Self {
        let available = options.available.unwrap_or_else(|| {
            let command = options.command.clone();
            Arc::new(move || {
                command
                    .resolve()
                    .is_ok_and(|command| which(&command.program).is_some())
            })
        });
        let spawn = options
            .spawn
            .unwrap_or_else(|| spawn_claude_code(options.command));
        Self(Arc::new(Inner {
            directory: options.directory,
            data: options.data,
            mcp: options.mcp,
            spawn,
            available,
            system_prompt: options.system_prompt,
            active: Mutex::new(None),
        }))
    }

    /// `{providers, models}`: Claude Code, with its models once its command
    /// is found.
    pub fn catalog(&self) -> Value {
        let configured = (self.0.available)();
        let models: Vec<Value> = if configured {
            CLAUDE_CODE_MODELS
                .iter()
                .map(|(id, label)| {
                    json!({
                        "provider": CLAUDE_CODE_PROVIDER,
                        "id": id,
                        "label": label,
                        "thinking_levels": CLAUDE_CODE_EFFORTS,
                        "default_thinking_level": "high",
                    })
                })
                .collect()
        } else {
            Vec::new()
        };
        json!({
            "providers": [{
                "id": CLAUDE_CODE_PROVIDER,
                "label": "Claude Code",
                "methods": [],
                "configured": configured,
            }],
            "models": models,
        })
    }

    /// Stops the running turn, if any, and waits for its end: it returns
    /// its entries without an error.
    pub async fn stop(&self) {
        let done = {
            let active = self.0.active.lock().unwrap();
            let Some(active) = active.as_ref() else {
                return;
            };
            active.stopped.store(true, Ordering::SeqCst);
            active.kill.cancel();
            active.done.clone()
        };
        done.cancelled().await;
    }

    /// Recovery refuses to replay a turn without a durable tool journal.
    pub async fn dispose(&self) {
        self.stop().await;
    }

    /// A turn: the entries to keep (the session pointer). `cancel` is the
    /// turn's signal: cancelled, the run stops as [`Self::stop`] does.
    pub async fn run(
        &self,
        turn: ClaudeTurn,
        cancel: CancellationToken,
    ) -> Result<Vec<Value>, ClaudeError> {
        let inner = &*self.0;
        let stopped = Arc::new(AtomicBool::new(false));
        // Killed by `stop` or by the turn's signal.
        let kill = cancel.child_token();
        let done = CancellationToken::new();
        {
            let mut active = inner.active.lock().unwrap();
            if active.is_some() {
                return Err(ClaudeError::internal("Ranger is already running"));
            }
            *active = Some(Active {
                stopped: stopped.clone(),
                kill: kill.clone(),
                done: done.clone(),
            });
        }
        let mut guard = RunGuard {
            inner,
            done,
            // The MCP turn's signal: ends with the run.
            turn: kill.child_token(),
            config_path: None,
        };
        let mut state = RunState {
            // What the agent keeps for the next turn: the session, once
            // there is one.
            retained: if is_claude_code_pointer(&turn.entries) {
                turn.entries.clone()
            } else {
                Vec::new()
            },
            child: None,
            exited: false,
        };
        let was_cancelled = cancel.is_cancelled();
        let result = if was_cancelled {
            Err(ClaudeError::internal("This operation was aborted"))
        } else {
            self.turn(turn, &kill, &stopped, &mut guard, &mut state)
                .await
        };
        let stopped = stopped.load(Ordering::SeqCst) || (!was_cancelled && cancel.is_cancelled());
        guard.turn.cancel();
        if let Some(child) = state.child.as_mut()
            && !state.exited
        {
            child.kill();
            let _ = child.wait().await;
        }
        drop(guard);
        match result {
            Err(_) if stopped => Ok(state.retained),
            Err(error) => Err(error),
            Ok(()) => Ok(state.retained),
        }
    }

    async fn turn(
        &self,
        turn: ClaudeTurn,
        kill: &CancellationToken,
        stopped: &AtomicBool,
        guard: &mut RunGuard<'_>,
        state: &mut RunState,
    ) -> Result<(), ClaudeError> {
        let inner = &*self.0;
        let events = turn.events.clone();
        if turn.recover {
            // A CLI session pointer has no durable MCP result journal.
            // Resending the interrupted prompt could repeat an already
            // executed operation.
            state.retained = Vec::new();
            if let Some(checkpoint) = &turn.checkpoint {
                checkpoint(Vec::new()).await?;
            }
            return Err(ClaudeError::user(NOT_RETRIED));
        }
        let model = turn.config.get("model").and_then(Value::as_str);
        let Some(model) =
            model.filter(|model| CLAUDE_CODE_MODELS.iter().any(|(id, _)| id == model))
        else {
            return Err(ClaudeError::internal("Model unavailable"));
        };
        let effort = turn
            .config
            .get("thinking_level")
            .and_then(Value::as_str)
            .filter(|level| CLAUDE_CODE_EFFORTS.contains(level));
        let resumed = is_claude_code_pointer(&turn.entries)
            .then(|| turn.entries[0]["session"].as_str().unwrap().to_owned());
        if !turn.entries.is_empty() && resumed.is_none() {
            return Err(ClaudeError::internal("Invalid Claude Code context"));
        }
        let session = resumed.clone().unwrap_or_else(random_uuid);
        state.retained = vec![claude_code_pointer(&session)];
        // A private, empty folder: no project instructions or settings.
        let cwd = inner.directory.join("claude");
        // Checks the folder and its parents: no links, nothing but folders.
        inner.data.assert_safe_data_path(&cwd.join("session"))?;
        create_dir_all_mode(&cwd)?;
        let automatic = turn.config.get("approval_mode").and_then(Value::as_str) == Some("auto");
        let sources: SourcesSink = {
            let events = events.clone();
            Arc::new(move |sources| events(TurnEvent::Sources(sources)))
        };
        let lease = inner.mcp.open(McpTurn {
            tools: (turn.tools)(automatic),
            cancel: guard.turn.clone(),
            sources: Some(sources),
        })?;
        let config_path = cwd.join(format!("mcp-{}.json", random_uuid()));
        {
            let mut file = open_nofollow(&config_path, OpenMode::CreateNew)?;
            guard.config_path = Some(config_path.clone());
            std::io::Write::write_all(&mut file, lease.config.as_bytes())?;
        }
        let server = inner.mcp.name();
        let tool_prefix = format!("mcp__{server}__");
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            model,
        ]
        .map(str::to_owned)
        .into();
        if let Some(effort) = effort {
            args.extend(["--effort".to_owned(), effort.to_owned()]);
        }
        match &resumed {
            Some(_) => args.extend(["--resume".to_owned(), session.clone()]),
            None => args.extend(["--session-id".to_owned(), session.clone()]),
        }
        // Only the turn's tools: no built-in tools, other MCP servers,
        // skills or hooks.
        args.extend([
            "--tools".to_owned(),
            String::new(),
            "--strict-mcp-config".to_owned(),
            "--mcp-config".to_owned(),
            config_path.to_string_lossy().into_owned(),
            "--allowedTools".to_owned(),
            format!("mcp__{server}"),
            "--disable-slash-commands".to_owned(),
            "--settings".to_owned(),
            js::stringify(&json!({ "disableAllHooks": true })),
            "--system-prompt".to_owned(),
            format!(
                "{}\nYour tools are named {tool_prefix}<name>; these instructions name them without that prefix.",
                (inner.system_prompt)(automatic)
            ),
        ]);
        // Save the session before it can run a tool, as Pi saves its root.
        if let Some(checkpoint) = &turn.checkpoint {
            checkpoint(state.retained.clone()).await?;
        }
        let child = state.child.insert((inner.spawn)(args, cwd)?);
        if stopped.load(Ordering::SeqCst) || kill.is_cancelled() {
            child.kill();
        }
        let line = format!(
            "{}\n",
            js::stringify(&json!({
                "type": "user",
                "message": { "role": "user", "content": turn.text },
            }))
        );
        tokio::select! {
            written = child.write(&line) => written?,
            _ = kill.cancelled() => {
                child.kill();
                return Err(ClaudeError::internal("Ranger stopped"));
            }
        }
        child.end();
        let mut reader = StreamReader {
            tool_prefix,
            events,
            tools: Vec::new(),
            thinking: Vec::new(),
            thinking_now: None,
            answered: false,
            failed: false,
        };
        loop {
            let line = tokio::select! {
                line = child.next_line() => line,
                _ = kill.cancelled() => {
                    child.kill();
                    break;
                }
            };
            let Some(line) = line else { break };
            reader.line(&line);
        }
        let code = child.wait().await?;
        state.exited = true;
        drop(lease);
        if stopped.load(Ordering::SeqCst) || kill.is_cancelled() {
            return Ok(());
        }
        if reader.failed || !reader.answered || code != 0 {
            (reader.events)(TurnEvent::Error);
        }
        Ok(())
    }
}

/// Reads Claude Code's stream-json events into [`TurnEvent`]s.
struct StreamReader {
    tool_prefix: String,
    events: Arc<dyn Fn(TurnEvent) + Send + Sync>,
    /// `(id, name, arguments)` of the tools called.
    tools: Vec<(String, String, Option<String>)>,
    thinking: Vec<String>,
    thinking_now: Option<String>,
    answered: bool,
    failed: bool,
}

impl StreamReader {
    fn line(&mut self, line: &str) {
        let Some(Value::Object(event)) = js::parse(line) else {
            return;
        };
        let kind = event.get("type").and_then(Value::as_str);
        let message = event
            .get("message")
            .filter(|message| js::is_record(message));
        if kind == Some("stream_event")
            && let Some(stream) = event.get("event").filter(|stream| js::is_record(stream))
        {
            let block = stream
                .get("content_block")
                .filter(|block| js::is_record(block));
            let delta = stream.get("delta").filter(|delta| js::is_record(delta));
            let delta_type = delta
                .and_then(|delta| delta.get("type"))
                .and_then(Value::as_str);
            let stream_type = stream.get("type").and_then(Value::as_str);
            if stream_type == Some("content_block_start")
                && block
                    .and_then(|block| block.get("type"))
                    .and_then(Value::as_str)
                    == Some("thinking")
            {
                self.thinking_now = Some(String::new());
            } else if let (Some("text_delta"), Some(text)) = (
                delta_type,
                delta
                    .and_then(|delta| delta.get("text"))
                    .and_then(Value::as_str),
            ) {
                (self.events)(TurnEvent::Delta(text.to_owned()));
            } else if let (Some("thinking_delta"), Some(thinking), Some(now)) = (
                delta_type,
                delta
                    .and_then(|delta| delta.get("thinking"))
                    .and_then(Value::as_str),
                self.thinking_now.as_mut(),
            ) {
                now.push_str(thinking);
                let trimmed = js::trim(now);
                if !trimmed.is_empty() {
                    let mut steps = self.thinking.clone();
                    steps.push(trimmed.to_owned());
                    (self.events)(TurnEvent::Thinking(steps));
                }
            } else if stream_type == Some("content_block_stop")
                && let Some(now) = self.thinking_now.take()
            {
                let trimmed = js::trim(&now);
                if !trimmed.is_empty() {
                    self.thinking.push(trimmed.to_owned());
                }
            }
        } else if matches!(kind, Some("assistant" | "user"))
            && let Some(Value::Array(content)) = message.and_then(|message| message.get("content"))
        {
            for part in content.iter().filter(|part| js::is_record(part)) {
                let part_type = part.get("type").and_then(Value::as_str);
                if part_type == Some("text")
                    && let Some(text) = part.get("text").and_then(Value::as_str)
                {
                    if kind == Some("assistant") && !text.is_empty() {
                        (self.events)(TurnEvent::Message(text.to_owned()));
                    }
                } else if part_type == Some("tool_use")
                    && let (Some(id), Some(name)) = (
                        part.get("id").and_then(Value::as_str),
                        part.get("name").and_then(Value::as_str),
                    )
                {
                    let name = name.strip_prefix(&self.tool_prefix).unwrap_or(name);
                    let arguments =
                        part.get("input")
                            .filter(|input| js::is_record(input))
                            .map(|input| {
                                bounded(&js::stringify_pretty(input), ASSISTANT_MAX_TOOL_ARGUMENTS)
                            });
                    match self.tools.iter_mut().find(|(known, _, _)| known == id) {
                        Some(tool) => *tool = (id.to_owned(), name.to_owned(), arguments.clone()),
                        None => {
                            self.tools
                                .push((id.to_owned(), name.to_owned(), arguments.clone()))
                        }
                    }
                    (self.events)(TurnEvent::Tool {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        status: ToolStatus::Running,
                        arguments,
                        output: None,
                    });
                } else if part_type == Some("tool_result")
                    && let Some(id) = part.get("tool_use_id").and_then(Value::as_str)
                {
                    let Some((_, name, arguments)) =
                        self.tools.iter().find(|(known, _, _)| known == id)
                    else {
                        continue;
                    };
                    (self.events)(TurnEvent::Tool {
                        id: id.to_owned(),
                        name: name.clone(),
                        status: if part.get("is_error") == Some(&Value::Bool(true)) {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        },
                        arguments: arguments.clone(),
                        output: Some(bounded(
                            &result_text(part.get("content")),
                            ASSISTANT_MAX_TOOL_OUTPUT,
                        )),
                    });
                }
            }
        } else if kind == Some("result") {
            self.answered = true;
            self.failed = event.get("subtype").and_then(Value::as_str) != Some("success")
                || event.get("is_error") == Some(&Value::Bool(true));
        }
    }
}

#[cfg(test)]
mod tests;
