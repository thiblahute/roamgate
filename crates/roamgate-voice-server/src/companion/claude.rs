//! The background Claude Code sessions the voice companion runs
//! (`spawnClaude`, `Worker` and their helpers of `voice/voice-cleaner.ts`):
//! `claude -p` reading stream-json messages from stdin, kept running, so
//! each request costs only the model's answer.
//!
//! A session is a [`ClaudeProcess`]: lines in, lines out, a kill. The
//! production one is [`spawn_claude`], roamgate-claude's background session
//! on its Claude Code process (one Claude runner in the workspace, with
//! the companion's own arguments and environment); tests give fakes
//! through [`ClaudeProcess::from_parts`].

use std::future::Future;
use std::sync::{Arc, Mutex};

pub use roamgate_claude::background::{
    BackgroundOptions as SpawnOptions, LineSession as ClaudeProcess, background_claude_env,
    spawn_background as spawn_claude, spawn_lines as spawn_process,
};
pub use roamgate_claude::driver::ClaudeCommand;
pub use roamgate_conversation::driver::BackgroundMemoryLaunch as MemoryLaunch;
use roamgate_conversation::driver::CompanionMemoryDriver;
use serde_json::{Value, json};
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

/// The front's launch: it loads the directory's index by itself
/// (`claudeMemoryDriver.reader`).
pub fn claude_memory_reader(dir: &str) -> MemoryLaunch {
    roamgate_claude::conversation::memory::ClaudeMemoryDriver
        .reader(dir)
        .unwrap_or_default()
}

/// A session with the file tools limited to `dir`, and nothing else
/// (`claudeMemoryDriver.writer`).
pub fn claude_memory_writer(dir: &str) -> MemoryLaunch {
    roamgate_claude::conversation::memory::ClaudeMemoryDriver.writer(dir)
}

/// Resolves voice.json's `claude_command` to the command a helper runs
/// (`helperCommand` of profiles/profiles.ts: the explicit program, else
/// the default profile).
pub type ResolveCommand = Arc<dyn Fn(Option<&str>) -> ClaudeCommand + Send + Sync>;

/// Starts a session.
pub type SpawnProcess = Arc<dyn Fn() -> ClaudeProcess + Send + Sync>;

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
    ) -> impl Future<Output = Result<String, String>> + Send + use<> {
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

/// For tests: fake sessions answering each message's content with
/// `answer`, keeping what was written.
#[cfg(test)]
pub(crate) mod fake {
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[derive(Clone, Default)]
    pub struct Written(pub Arc<Mutex<Vec<String>>>);

    impl Written {
        pub fn all(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }

        /// The messages' contents (their text when it is one).
        pub fn contents(&self) -> Vec<String> {
            self.all()
                .iter()
                .map(|line| {
                    let message: Value = serde_json::from_str(line).unwrap();
                    match &message["message"]["content"] {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    }
                })
                .collect()
        }
    }

    pub type Answer = Arc<dyn Fn(&Value) -> Vec<String> + Send + Sync>;

    /// Each line written gets the lines `answer` gives for its message;
    /// the token ends it (as its exit).
    pub fn process(written: Written, answer: Answer) -> (ClaudeProcess, CancellationToken) {
        let (input, mut to_read) = mpsc::unbounded_channel::<String>();
        let (lines_tx, lines) = mpsc::unbounded_channel::<String>();
        let exit = CancellationToken::new();
        let ended = exit.clone();
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
                    () = ended.cancelled() => break,
                }
            }
        });
        let kill = exit.clone();
        (
            ClaudeProcess::from_parts(input, lines, move || kill.cancel()),
            exit,
        )
    }

    /// A result line answering `text`.
    pub fn result(text: &str) -> String {
        js::stringify(&json!({"type": "result", "result": text}))
    }

    /// Sessions answering each message (its text) with `answer`, each
    /// started kept with what it was written and its exit.
    #[derive(Clone)]
    pub struct Claude {
        pub started: Arc<Mutex<Vec<(Written, CancellationToken)>>>,
        answer: Answer,
    }

    impl Claude {
        pub fn new(answer: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
            Self::lines(move |content| vec![result(&answer(content.as_str().unwrap_or_default()))])
        }

        /// Answering with whole stdout lines.
        pub fn lines(answer: impl Fn(&Value) -> Vec<String> + Send + Sync + 'static) -> Self {
            Self {
                started: Arc::default(),
                answer: Arc::new(answer),
            }
        }

        pub fn spawn(&self) -> SpawnProcess {
            let this = self.clone();
            Arc::new(move || {
                let written = Written::default();
                let (process, exit) = process(written.clone(), this.answer.clone());
                this.started.lock().unwrap().push((written, exit));
                process
            })
        }

        /// What session `n` was written: the messages' contents.
        pub fn written(&self, n: usize) -> Vec<String> {
            self.started.lock().unwrap()[n].0.contents()
        }

        /// Session `n` ends.
        pub fn exit(&self, n: usize) {
            self.started.lock().unwrap()[n].1.cancel();
        }
    }

    /// A session that never answers.
    pub fn silent() -> SpawnProcess {
        Arc::new(|| {
            let (input, _keep) = mpsc::unbounded_channel::<String>();
            let (lines_tx, lines) = mpsc::unbounded_channel::<String>();
            std::mem::forget(lines_tx);
            std::mem::forget(_keep);
            ClaudeProcess::from_parts(input, lines, || {})
        })
    }
}
