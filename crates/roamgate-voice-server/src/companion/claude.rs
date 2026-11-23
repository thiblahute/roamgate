//! The background Claude Code sessions the voice companion runs
//! (`spawnClaude`, `Worker` and their helpers of `voice/voice-cleaner.ts`):
//! `claude -p` reading stream-json messages from stdin, kept running, so
//! each request costs only the model's answer.
//!
//! A session is a [`ClaudeProcess`]: lines in, lines out, a kill. The
//! production one is [`spawn_claude`] (a local process); tests give fakes.
//! When `roamgate-claude` lands (S15/S23), its process type plugs in here
//! through [`ClaudeProcess::from_parts`] and the argv and environment
//! helpers move there.

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::js;

/// An image given with a request: what the model sees beside its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptImage {
    pub media_type: String,
    /// Base64.
    pub data: String,
}

/// A request's message content: its words, after its images when it has
/// some (image content blocks, as Claude Code's stream-json takes them).
pub fn prompt_content(prompt: &str, images: &[PromptImage]) -> Value {
    if images.is_empty() {
        return Value::String(prompt.to_owned());
    }
    let mut content: Vec<Value> = images
        .iter()
        .map(|image| {
            json!({
                "type": "image",
                "source": {"type": "base64", "media_type": image.media_type, "data": image.data},
            })
        })
        .collect();
    content.push(json!({"type": "text", "text": prompt}));
    Value::Array(content)
}

/// The stream-json line that sends `prompt` (and `images`) as a user
/// message.
pub fn user_message_line(prompt: &str, images: &[PromptImage]) -> String {
    format!(
        "{}\n",
        js::stringify(&json!({
            "type": "user",
            "message": {"role": "user", "content": prompt_content(prompt, images)},
        }))
    )
}

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

/// The Claude Code command a helper runs (`AgentCommand` of
/// profiles/profiles.ts, as `helperCommand` resolves it): a program, with
/// the variables its profile sets and unsets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCommand {
    pub program: String,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    /// A profile's command rather than a bare program (`commandKey`
    /// hashes those).
    pub profile: bool,
}

impl ClaudeCommand {
    /// A bare program (voice.json `claude_command`, or plain `claude`).
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

    /// `commandEnv`: `base` without what it unsets, with what it sets.
    pub fn env_over(&self, base: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut env: Vec<(String, String)> = base
            .into_iter()
            .filter(|(name, _)| !self.unset.contains(name))
            .collect();
        for (name, value) in &self.env {
            env.retain(|(n, _)| n != name);
            env.push((name.clone(), value.clone()));
        }
        env
    }
}

impl Default for ClaudeCommand {
    fn default() -> Self {
        Self::program("claude")
    }
}

/// How a headless background session is started around the companion's
/// memory directory (`BackgroundMemoryLaunch` of conversation/drivers).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MemoryLaunch {
    /// What to add to its launch.
    pub args: Vec<String>,
    /// Its tools: "" for none.
    pub tools: String,
    /// Instead of the system's temporary directory.
    pub cwd: Option<PathBuf>,
}

/// How Claude Code reaches the companion's memory directory
/// (`claudeMemoryDriver` of conversation/drivers/claude-memory.ts): it
/// reads the directory by itself once told where it is.
fn memory_settings(dir: &str, extra: Option<Value>) -> String {
    let mut settings = serde_json::Map::new();
    settings.insert("autoMemoryDirectory".into(), Value::String(dir.to_owned()));
    settings.insert("disableAllHooks".into(), Value::Bool(true));
    if let Some(Value::Object(extra)) = extra {
        settings.extend(extra);
    }
    js::stringify(&Value::Object(settings))
}

/// The front's launch: it loads the directory's index by itself.
pub fn claude_memory_reader(dir: &str) -> MemoryLaunch {
    MemoryLaunch {
        args: vec![
            "--setting-sources".into(),
            String::new(),
            "--settings".into(),
            memory_settings(dir, None),
        ],
        tools: String::new(),
        cwd: None,
    }
}

/// A session with the file tools limited to `dir`, and nothing else.
pub fn claude_memory_writer(dir: &str) -> MemoryLaunch {
    MemoryLaunch {
        args: vec![
            "--setting-sources".into(),
            String::new(),
            "--permission-mode".into(),
            "dontAsk".into(),
            "--settings".into(),
            memory_settings(
                dir,
                Some(json!({"permissions": {"allow": [
                    format!("Read({dir}/**)"),
                    format!("Write({dir}/**)"),
                    format!("Edit({dir}/**)"),
                    "Glob",
                ]}})),
            ),
        ],
        tools: "Read,Write,Edit,Glob".into(),
        cwd: Some(PathBuf::from(dir)),
    }
}

/// How a background session is started (`spawnClaude`'s options).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpawnOptions {
    /// The answer's text as it is written, too (`--include-partial-messages`):
    /// the front's words are said before its JSON object is over.
    pub partial: bool,
    /// With the companion's memory, instead of a bare model.
    pub launch: Option<MemoryLaunch>,
}

/// `spawnClaude`'s arguments after the program.
pub fn claude_args(model: &str, system_prompt: &str, options: &SpawnOptions) -> Vec<String> {
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
pub struct ClaudeProcess {
    pub input: mpsc::UnboundedSender<String>,
    pub lines: mpsc::UnboundedReceiver<String>,
    pub kill: Box<dyn FnOnce() + Send>,
}

impl ClaudeProcess {
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
}

/// Resolves voice.json's `claude_command` to the command a helper runs
/// (`helperCommand` of profiles/profiles.ts: the explicit program, else
/// the default profile).
pub type ResolveCommand = Arc<dyn Fn(Option<&str>) -> ClaudeCommand + Send + Sync>;

/// Starts a session.
pub type SpawnProcess = Arc<dyn Fn() -> ClaudeProcess + Send + Sync>;

/// `spawnClaude`: `claude -p` in stream-json, reading what it is sent. A
/// process that cannot start is one whose output ends at once.
pub fn spawn_claude(
    model: &str,
    command: &ClaudeCommand,
    system_prompt: &str,
    options: &SpawnOptions,
) -> ClaudeProcess {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (input, mut to_write) = mpsc::unbounded_channel::<String>();
    let (lines_tx, lines) = mpsc::unbounded_channel::<String>();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let cwd = options
        .launch
        .as_ref()
        .and_then(|l| l.cwd.clone())
        .unwrap_or_else(std::env::temp_dir);
    let mut child = tokio::process::Command::new(&command.program);
    child
        .args(claude_args(model, system_prompt, options))
        .current_dir(cwd)
        .env_clear()
        .envs(command.env_over(background_claude_env(std::env::vars())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Ok(mut child) = child.spawn() {
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
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
                if let Some(stdout) = stdout {
                    let mut stdout = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = stdout.next_line().await {
                        if lines_tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            };
            tokio::select! {
                () = reader => {}
                _ = kill_rx => {}
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
        });
    }
    ClaudeProcess::from_parts(input, lines, move || {
        let _ = kill_tx.send(());
    })
}

/// Hears the answer as it is written, whole so far.
pub type OnText = Arc<dyn Fn(&str) + Send + Sync>;

/// Requests on one session make its context grow: past this, a new one.
pub const REQUESTS_PER_PROCESS: usize = 40;

struct Running {
    id: u64,
    input: mpsc::UnboundedSender<String>,
    kill: Option<Box<dyn FnOnce() + Send>>,
}

impl Running {
    fn kill(mut self) {
        if let Some(kill) = self.kill.take() {
            kill();
        }
    }
}

#[derive(Default)]
struct WorkerState {
    running: Option<Running>,
    next_id: u64,
    answer: Option<oneshot::Sender<Result<String, String>>>,
    written: String,
    on_text: Option<OnText>,
    served: usize,
    busy: bool,
    generation: u64,
}

/// One background Claude Code session, answering one request at a time.
#[derive(Clone)]
pub struct Worker {
    state: Arc<Mutex<WorkerState>>,
    spawn: SpawnProcess,
    /// What its failures say ("The cleaner failed", "The cleaner stopped").
    name: &'static str,
}

impl Worker {
    pub fn new(spawn: SpawnProcess) -> Self {
        Self {
            state: Arc::default(),
            spawn,
            name: "cleaner",
        }
    }

    /// Whether a session runs now: the next request goes to the same one.
    pub fn running(&self) -> bool {
        self.state.lock().unwrap().running.is_some()
    }

    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().busy
    }

    /// Counts the sessions started: a new one knows nothing said before.
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    /// Starts the session ahead of its first request.
    pub fn warm(&self) {
        let mut state = self.state.lock().unwrap();
        self.start(&mut state);
    }

    fn start(&self, state: &mut WorkerState) -> mpsc::UnboundedSender<String> {
        if let Some(running) = &state.running {
            return running.input.clone();
        }
        let process = (self.spawn)();
        state.next_id += 1;
        let id = state.next_id;
        state.running = Some(Running {
            id,
            input: process.input.clone(),
            kill: Some(process.kill),
        });
        state.served = 0;
        state.generation += 1;
        let shared = self.state.clone();
        let name = self.name;
        let mut lines = process.lines;
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match event.get("type").and_then(Value::as_str) {
                    Some("stream_event") => {
                        let streamed = event.get("event");
                        let delta = streamed.and_then(|e| e.get("delta"));
                        if streamed.and_then(|e| e.get("type")).and_then(Value::as_str)
                            == Some("content_block_delta")
                            && delta.and_then(|d| d.get("type")).and_then(Value::as_str)
                                == Some("text_delta")
                            && let Some(text) =
                                delta.and_then(|d| d.get("text")).and_then(Value::as_str)
                        {
                            let (listener, written) = {
                                let mut state = shared.lock().unwrap();
                                state.written.push_str(text);
                                (state.on_text.clone(), state.written.clone())
                            };
                            if let Some(listener) = listener {
                                // Its listener's trouble: the answer still comes.
                                let _ =
                                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                        listener(&written)
                                    }));
                            }
                        }
                    }
                    Some("result") => {
                        let answer = {
                            let mut state = shared.lock().unwrap();
                            state.on_text = None;
                            state.answer.take()
                        };
                        let result = event.get("result");
                        let text = match result {
                            None | Some(Value::Null) => None,
                            Some(value) => Some(js::to_text(value)),
                        };
                        if let Some(answer) = answer {
                            let _ = answer.send(if event.get("is_error").is_some_and(truthy) {
                                Err(text.unwrap_or_else(|| format!("The {name} failed")))
                            } else {
                                Ok(text.unwrap_or_default())
                            });
                        }
                    }
                    _ => {}
                }
            }
            let answer = {
                let mut state = shared.lock().unwrap();
                if state.running.as_ref().is_some_and(|r| r.id == id) {
                    state.running = None;
                }
                state.answer.take()
            };
            if let Some(answer) = answer {
                let _ = answer.send(Err(format!("The {name} stopped")));
            }
        });
        state.running.as_ref().map(|r| r.input.clone()).unwrap()
    }

    /// The answer to `prompt`, and the `images` given with it; `on_text`
    /// hears it as it is written, whole so far, when the session streams
    /// partial messages. The request is written at once (the worker is
    /// busy from this call), the answer awaited by the future.
    pub fn ask(
        &self,
        prompt: &str,
        on_text: Option<OnText>,
        images: &[PromptImage],
    ) -> impl Future<Output = Result<String, String>> + Send + 'static {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            state.busy = true;
            let input = self.start(&mut state);
            state.answer = Some(tx);
            state.written.clear();
            state.on_text = on_text;
            let _ = input.send(user_message_line(prompt, images));
        }
        let guard = AskGuard(self.state.clone());
        let name = self.name;
        async move {
            let _guard = guard;
            match rx.await {
                Ok(result) => result,
                Err(_) => Err(format!("The {name} stopped")),
            }
        }
    }

    pub fn stop(&self) {
        let running = self.state.lock().unwrap().running.take();
        if let Some(running) = running {
            running.kill();
        }
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The end of a request, answered or not (`ask`'s `finally`).
struct AskGuard(Arc<Mutex<WorkerState>>);

impl Drop for AskGuard {
    fn drop(&mut self) {
        let old = {
            let mut state = self.0.lock().unwrap();
            state.on_text = None;
            state.busy = false;
            state.served += 1;
            if state.served >= REQUESTS_PER_PROCESS {
                state.running.take()
            } else {
                None
            }
        };
        if let Some(old) = old {
            old.kill();
        }
    }
}

/// For tests: a fake session answering each message's content with
/// `answer`, keeping what was written.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;

    #[derive(Clone, Default)]
    pub struct Written(pub Arc<Mutex<Vec<String>>>);

    impl Written {
        pub fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    pub type Answer = Arc<dyn Fn(&Value) -> Vec<String> + Send + Sync>;

    /// Each line written gets the lines `answer` gives for its message.
    pub fn process(written: Written, answer: Answer) -> ClaudeProcess {
        let (input, mut to_read) = mpsc::unbounded_channel::<String>();
        let (lines_tx, lines) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    line = to_read.recv() => {
                        let Some(line) = line else { break };
                        written.0.lock().unwrap().push(line.clone());
                        let message: Value = serde_json::from_str(&line).unwrap();
                        for out in answer(&message["message"]["content"]) {
                            let _ = lines_tx.send(out);
                        }
                    }
                    _ = &mut kill_rx => break,
                }
            }
        });
        ClaudeProcess::from_parts(input, lines, move || {
            let _ = kill_tx.send(());
        })
    }

    /// A result line answering `text`.
    pub fn result(text: &str) -> String {
        js::stringify(&json!({"type": "result", "result": text}))
    }
}

#[cfg(test)]
mod tests;
