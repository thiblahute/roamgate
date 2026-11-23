//! Voice chat's cleaner (`voice/voice-cleaner.ts`): what the user said goes
//! through a language model before it is sent, which drops fillers, false
//! starts and misheard words, and tells whether it was said to the agent
//! at all. It runs on background Claude Code sessions
//! ([`crate::companion::claude::Worker`]).
//!
//! To keep that off the end of a turn, settled sentences are cleaned while
//! the user still talks, and the end is cleaned as soon as they pause.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use roamgate_base::clock::{Clock, SystemClock, timeout};
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::companion::claude::{
    ClaudeCommand, ClaudeProcess, ResolveCommand, SpawnProcess, Worker,
};
use crate::companion::keyed::Keyed;
use crate::config::VoiceConfig;
use crate::js;

pub const CLEANER_SYSTEM_PROMPT: &str = r#"You clean up voice transcripts before they reach a coding agent (Claude Code). Speech recognition mishears names and technical words (Claude may come out as "cloud" or "clot"), and people talking nearby can be picked up too. Each request gives the end of the conversation with the agent, for context, then part of what the user just said aloud.

Reply with one JSON object and nothing else.

A request marked PIECE holds the first sentences of what the user is saying; more follows. Reply {"for_agent": true|false, "text": "..."}.

A request marked END holds the rest of it, after "Cleaned so far" (what the earlier pieces became, possibly empty). Reply {"for_agent": true|false, "text": "...", "fixes": [{"from": "...", "to": "..."}]}: text is the rest, cleaned; fixes (usually none) change words of "Cleaned so far" that the rest shows to be wrong, as when the user corrects themselves ("X, not Y, I meant").

- for_agent: false only when the words are clearly not addressed to the agent: talk with someone else in the room, background voices, TV. When unsure, true.
- text: the words made clean: remove fillers (um, uh, euh, you know...), false starts ("with a, uh, the file" is "with the file"), stutters and repeated words; fix misheard words from the conversation; when the user corrects themselves keep only what they meant. Keep the user's language, meaning, tone and first person. Never answer the words, add to them, summarize them or translate them. With nothing left, ""."#;

/// A fix of the END reply: `to` kept as JSON (only a string applies).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CleanerFix {
    pub from: Option<String>,
    pub to: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CleanerReply {
    /// Only a boolean is kept: anything but `false` is for the agent.
    pub for_agent: Option<bool>,
    pub text: Option<String>,
    pub fixes: Vec<CleanerFix>,
}

/// Asks the model; resolves to its parsed reply.
pub type CleanerAsk = Arc<
    dyn Fn(String, CancellationToken) -> BoxFuture<'static, Result<CleanerReply, String>>
        + Send
        + Sync,
>;

pub use crate::socket::companion::Cleaned;

static SENTENCE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"[^.?!…]+(?:[.?!…]+|$)").unwrap());

/// Sentences, each with its end punctuation.
pub fn sentences(text: &str) -> Vec<String> {
    SENTENCE
        .find_iter(text)
        .map(|m| js::trim(m.as_str()).to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

/// The JSON object of a reply (from its first `{` to its last `}`).
pub fn reply_object(text: &str) -> Result<Value, String> {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(start), Some(end)) if end >= start => {
            serde_json::from_str(&text[start..=end]).map_err(|error| error.to_string())
        }
        _ => Err(format!("Not JSON: {text}")),
    }
}

pub fn parse_cleaner_reply(text: &str) -> Result<CleanerReply, String> {
    let value = reply_object(text)?;
    let Some(reply_text) = value.get("text").and_then(Value::as_str) else {
        return Err(format!("No text: {text}"));
    };
    Ok(CleanerReply {
        for_agent: value.get("for_agent").and_then(Value::as_bool),
        text: Some(reply_text.to_owned()),
        fixes: value
            .get("fixes")
            .and_then(Value::as_array)
            .map(|fixes| {
                fixes
                    .iter()
                    .map(|fix| CleanerFix {
                        from: fix.get("from").and_then(Value::as_str).map(str::to_owned),
                        to: fix.get("to").cloned(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// The longest run of `prefix` items that starts `list`.
fn shared(list: &[String], prefix: &[String]) -> usize {
    list.iter().zip(prefix).take_while(|(a, b)| a == b).count()
}

type SharedReply = Shared<BoxFuture<'static, Option<CleanerReply>>>;
type SharedCleaned = Shared<BoxFuture<'static, Cleaned>>;

#[derive(Clone)]
struct Piece {
    sentences: Vec<String>,
    reply: SharedReply,
}

#[derive(Default)]
struct SessionState {
    pieces: Vec<Piece>,
    settled: Vec<String>,
    ends: HashMap<String, SharedCleaned>,
    fell_back: bool,
}

struct SessionInner {
    ask: CleanerAsk,
    context: String,
    timeout_ms: u64,
    context_label: String,
    aborted: CancellationToken,
    clock: Arc<dyn Clock>,
    state: Mutex<SessionState>,
}

/// One utterance's cleaning: `partial` hears the transcript so far (again
/// and again), `final_text` gives the clean text. A failing or slow model
/// gives the words as they were heard.
#[derive(Clone)]
pub struct CleanSession(Arc<SessionInner>);

/// Drops pieces whose sentences the transcript no longer starts with.
fn keep_pieces(state: &mut SessionState, said: &[String]) {
    let mut at = 0;
    let mut kept = Vec::new();
    for piece in &state.pieces {
        let end = (at + piece.sentences.len()).min(said.len());
        let own = &said[at.min(said.len())..end];
        if shared(own, &piece.sentences) != piece.sentences.len() {
            break;
        }
        kept.push(piece.clone());
        at += piece.sentences.len();
    }
    state.pieces = kept;
}

fn words(value: &str) -> usize {
    value
        .split(|c: char| c.is_whitespace() || js::is_js_space(c))
        .filter(|w| !w.is_empty())
        .count()
}

impl CleanSession {
    /// `timeout_ms` 6000 and the label "Conversation so far" by default.
    pub fn new(ask: CleanerAsk, context: &str) -> Self {
        Self::with(
            ask,
            context,
            6000,
            "Conversation so far",
            Arc::new(SystemClock),
        )
    }

    pub fn with(
        ask: CleanerAsk,
        context: &str,
        timeout_ms: u64,
        context_label: &str,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self(Arc::new(SessionInner {
            ask,
            context: context.to_owned(),
            timeout_ms,
            context_label: context_label.to_owned(),
            aborted: CancellationToken::new(),
            clock,
            state: Mutex::default(),
        }))
    }

    /// The last `final_text` gave the words as heard: the model failed, was
    /// too slow, or its reply was refused.
    pub fn fell_back(&self) -> bool {
        self.0.state.lock().unwrap().fell_back
    }

    fn header(&self) -> String {
        if self.0.context.is_empty() {
            String::new()
        } else {
            format!("{}:\n{}\n\n", self.0.context_label, self.0.context)
        }
    }

    /// Sentences that read the same twice are settled and cleaned; at a
    /// pause, the whole is cleaned ahead of `final_text`.
    pub fn partial(&self, text: &str, pause: bool) {
        let all = sentences(text);
        let complete: Vec<String> = all[..all.len().saturating_sub(1)].to_vec();
        let mut state = self.0.state.lock().unwrap();
        let stable: Vec<String> = complete[..shared(&complete, &state.settled)].to_vec();
        state.settled = complete;
        keep_pieces(&mut state, &stable);
        let covered: usize = state.pieces.iter().map(|p| p.sentences.len()).sum();
        if stable.len() > covered {
            let fresh = stable[covered..].to_vec();
            let asked = (self.0.ask)(
                format!("{}PIECE\n{}", self.header(), fresh.join(" ")),
                self.0.aborted.clone(),
            );
            let reply: SharedReply = asked.map(Result::ok).boxed().shared();
            state.pieces.push(Piece {
                sentences: fresh,
                reply,
            });
        }
        drop(state);
        if pause {
            let ending = self.end(text);
            tokio::spawn(ending);
        }
    }

    pub async fn final_text(&self, text: &str) -> Cleaned {
        self.0.state.lock().unwrap().fell_back = false;
        let cleaned = self.final_cleaned(text).await;
        // Cleaning drops fillers and false starts, never most of the words:
        // a model that lost them gives the words as heard.
        if cleaned.for_agent && (words(&cleaned.text) as f64) < words(text) as f64 * 0.5 {
            self.0.state.lock().unwrap().fell_back = true;
            return Cleaned {
                text: js::trim(text).to_owned(),
                for_agent: true,
            };
        }
        cleaned
    }

    async fn final_cleaned(&self, text: &str) -> Cleaned {
        let raw = js::trim(text).to_owned();
        if raw.is_empty() {
            return Cleaned {
                text: String::new(),
                for_agent: true,
            };
        }
        let ending = self.end(&raw);
        let result = timeout(
            &*self.0.clock,
            Duration::from_millis(self.0.timeout_ms),
            ending,
        )
        .await;
        self.0.aborted.cancel();
        match result {
            Ok(cleaned) => cleaned,
            Err(_) => {
                self.0.state.lock().unwrap().fell_back = true;
                Cleaned {
                    text: raw,
                    for_agent: true,
                }
            }
        }
    }

    pub fn close(&self) {
        self.0.aborted.cancel();
    }

    fn end(&self, text: &str) -> SharedCleaned {
        let raw = js::trim(text).to_owned();
        let mut state = self.0.state.lock().unwrap();
        if let Some(ending) = state.ends.get(&raw) {
            return ending.clone();
        }
        let session = self.clone();
        let key = raw.clone();
        let ending: SharedCleaned = async move {
            match session.clean(&raw).await {
                Ok(cleaned) => cleaned,
                Err(_) => {
                    session.0.state.lock().unwrap().fell_back = true;
                    Cleaned {
                        text: raw,
                        for_agent: true,
                    }
                }
            }
        }
        .boxed()
        .shared();
        state.ends.insert(key, ending.clone());
        ending
    }

    async fn clean(&self, raw: &str) -> Result<Cleaned, String> {
        let all = sentences(raw);
        let pieces = {
            let mut state = self.0.state.lock().unwrap();
            keep_pieces(&mut state, &all);
            state.pieces.clone()
        };
        let replies = futures_util::future::join_all(pieces.iter().map(|p| p.reply.clone())).await;
        // A piece that failed is cleaned again with the rest.
        let usable = replies
            .iter()
            .position(Option::is_none)
            .unwrap_or(replies.len());
        let covered: usize = pieces[..usable].iter().map(|p| p.sentences.len()).sum();
        // A piece that came back empty keeps its words as heard: what was
        // said to the agent is never dropped.
        let mut before = replies[..usable]
            .iter()
            .zip(&pieces)
            .map(|(reply, piece)| {
                let text = reply
                    .as_ref()
                    .and_then(|r| r.text.as_deref())
                    .map(js::trim)
                    .unwrap_or("");
                if text.is_empty() {
                    piece.sentences.join(" ")
                } else {
                    text.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let rest = all[covered.min(all.len())..].join(" ");
        if rest.is_empty() {
            return Ok(Cleaned {
                text: before,
                for_agent: replies[..usable]
                    .iter()
                    .any(|r| r.as_ref().and_then(|r| r.for_agent) != Some(false)),
            });
        }
        let reply = (self.0.ask)(
            format!(
                "{}END\nCleaned so far: {before}\nRest: {rest}",
                self.header()
            ),
            self.0.aborted.clone(),
        )
        .await?;
        for fix in &reply.fixes {
            if let (Some(from), Some(Value::String(to))) = (&fix.from, &fix.to)
                && !from.is_empty()
                && before.contains(from.as_str())
            {
                before = before.replacen(from.as_str(), to, 1);
            }
        }
        let tail = reply.text.as_deref().map(js::trim).unwrap_or("").to_owned();
        Ok(Cleaned {
            text: [before, tail]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
            for_agent: reply.for_agent != Some(false),
        })
    }
}

struct Job {
    prompt: String,
    cancel: Option<CancellationToken>,
    reply: oneshot::Sender<Result<CleanerReply, String>>,
}

struct CleanerInner {
    workers: Vec<Worker>,
    queue: Mutex<VecDeque<Job>>,
}

/// Background sessions shared by every voice chat: requests wait for a
/// free one, and those whose utterance is over are dropped unasked.
#[derive(Clone)]
pub struct VoiceCleaner(Arc<CleanerInner>);

impl VoiceCleaner {
    pub fn new(spawn: SpawnProcess, size: usize) -> Self {
        Self(Arc::new(CleanerInner {
            workers: (0..size).map(|_| Worker::new(spawn.clone())).collect(),
            queue: Mutex::default(),
        }))
    }

    /// Whether both are the same cleaner (one kept by a factory).
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Starts the sessions, so the first utterance does not wait for them.
    pub fn warm(&self) {
        for worker in &self.0.workers {
            worker.warm();
        }
    }

    pub fn session(&self, context: &str) -> CleanSession {
        self.session_with(context, 6000, "Conversation so far", Arc::new(SystemClock))
    }

    pub fn session_with(
        &self,
        context: &str,
        timeout_ms: u64,
        context_label: &str,
        clock: Arc<dyn Clock>,
    ) -> CleanSession {
        let cleaner = self.clone();
        CleanSession::with(
            Arc::new(move |prompt, cancel| cleaner.ask(prompt, Some(cancel)).boxed()),
            context,
            timeout_ms,
            context_label,
            clock,
        )
    }

    /// Queues `prompt`; dropped unasked once `cancel` fired.
    pub fn ask(
        &self,
        prompt: String,
        cancel: Option<CancellationToken>,
    ) -> impl std::future::Future<Output = Result<CleanerReply, String>> + Send + use<> {
        let (tx, rx) = oneshot::channel();
        self.0.queue.lock().unwrap().push_back(Job {
            prompt,
            cancel,
            reply: tx,
        });
        self.next();
        async move {
            rx.await
                .unwrap_or_else(|_| Err("The cleaner stopped".into()))
        }
    }

    fn next(&self) {
        loop {
            let Some(worker) = self.0.workers.iter().find(|w| !w.busy()) else {
                return;
            };
            let job = {
                let mut queue = self.0.queue.lock().unwrap();
                let mut job = queue.pop_front();
                while let Some(cancelled) =
                    job.take_if(|j| j.cancel.as_ref().is_some_and(|c| c.is_cancelled()))
                {
                    let _ = cancelled.reply.send(Err("No longer needed".into()));
                    job = queue.pop_front();
                }
                job
            };
            let Some(job) = job else {
                return;
            };
            let asked = worker.ask(&job.prompt, None, &[]);
            let cleaner = self.clone();
            tokio::spawn(async move {
                let result = asked.await.and_then(|text| parse_cleaner_reply(&text));
                let _ = job.reply.send(result);
                cleaner.next();
            });
        }
    }

    pub fn stop(&self) {
        for worker in &self.0.workers {
            worker.stop();
        }
    }
}

/// Starts a session for a model and command.
pub type SpawnFor = Arc<dyn Fn(&str, &ClaudeCommand) -> ClaudeProcess + Send + Sync>;

/// The cleaner `voice.json` asks for (`clean_model`), kept while it stays
/// the same; None without one. `command` resolves voice.json's
/// `claude_command` (`helperCommand` of profiles).
pub struct ConfiguredCleaner {
    current: Keyed<VoiceCleaner>,
    spawn: SpawnFor,
    command: ResolveCommand,
}

impl ConfiguredCleaner {
    pub fn new(spawn: SpawnFor, command: ResolveCommand) -> Self {
        Self {
            current: Keyed::default(),
            spawn,
            command,
        }
    }

    /// The real sessions: [`spawn_claude`](crate::companion::claude::spawn_claude)
    /// with the cleaner's prompt.
    pub fn spawning(command: ResolveCommand) -> Self {
        Self::new(
            Arc::new(|model: &str, command: &ClaudeCommand| {
                crate::companion::claude::spawn_claude(
                    model,
                    command,
                    CLEANER_SYSTEM_PROMPT,
                    &Default::default(),
                )
            }),
            command,
        )
    }

    pub fn get(&self, config: Result<&VoiceConfig, &str>) -> Option<VoiceCleaner> {
        let model = config
            .ok()
            .and_then(|c| c.str("clean_model"))
            .filter(|m| !m.is_empty());
        let command =
            model.map(|_| (self.command)(config.ok().and_then(|c| c.str("claude_command"))));
        let key = match (&model, &command) {
            (Some(model), Some(command)) => format!("{model} {}", command.key()),
            _ => String::new(),
        };
        let spawn = self.spawn.clone();
        let model = model.map(str::to_owned);
        self.current.get(
            &key,
            move || {
                let (model, command) = (model?, command?);
                Some(VoiceCleaner::new(
                    Arc::new(move || spawn(&model, &command)),
                    2,
                ))
            },
            VoiceCleaner::stop,
        )
    }
}

#[cfg(test)]
mod tests;
