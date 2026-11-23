//! A session's answer to a job the voice companion gave it, kept until
//! the user hears it (`voice/voice-waiting.ts`): every answer is kept,
//! keyed by its job, with the session's name and the question, for a day;
//! the page marks it heard once the companion told it or read it, and
//! mentions the ones still waiting once at the next chat's start. Kept in
//! a JSON file of the voice uploads' folder, so a restart loses nothing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_base::clock::{Clock, SystemClock};
use serde_json::{Value, json};

use crate::companion::images::upload_root;
use crate::js::{self, len16, slice16};

#[derive(Debug, Clone, PartialEq)]
pub struct WaitingAnswer {
    /// The job's id (errands).
    pub job: String,
    /// `<connection>/<pane>`: the session that answered.
    pub pane: String,
    /// The session's name, as said aloud.
    pub label: String,
    /// What the user asked it, as said or typed.
    pub question: String,
    pub answer: String,
    /// When the answer settled.
    pub at: f64,
    /// Mentioned to the user once already, at a chat's start.
    pub mentioned: bool,
}

impl WaitingAnswer {
    pub fn to_json(&self) -> Value {
        json!({
            "job": self.job,
            "pane": self.pane,
            "label": self.label,
            "question": self.question,
            "answer": self.answer,
            "at": js::number(self.at),
            "mentioned": self.mentioned,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        Some(Self {
            job: text("job")?,
            pane: text("pane")?,
            label: text("label")?,
            question: text("question")?,
            answer: text("answer")?,
            at: value.get("at")?.as_f64()?,
            mentioned: value.get("mentioned")?.as_bool()?,
        })
    }
}

/// What [`WaitingAnswers::keep`] is given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewAnswer {
    pub job: String,
    pub pane: String,
    pub label: String,
    pub question: String,
    pub answer: String,
    /// When it settled; now without one.
    pub at: Option<f64>,
}

/// An answer is kept this long.
pub const WAITING_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// Answers kept, at most: the oldest go first.
const KEPT: usize = 20;
/// Of each answer, what the front's state gives.
const CONTEXT_CHARS: usize = 300;

/// Where the answers are kept: the voice uploads' folder.
pub fn waiting_answers_file(root: &Path) -> PathBuf {
    root.join("voice-waiting-answers.json")
}

/// The default file, under [`upload_root`].
pub fn default_waiting_answers_file() -> PathBuf {
    waiting_answers_file(&upload_root())
}

pub struct WaitingAnswers {
    answers: Mutex<Vec<WaitingAnswer>>,
    file: Option<PathBuf>,
    clock: Arc<dyn Clock>,
}

impl WaitingAnswers {
    /// `file` None: kept in memory only (tests).
    pub fn new(file: Option<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        let answers = file.as_deref().map(load).unwrap_or_default();
        Self {
            answers: Mutex::new(answers),
            file,
            clock,
        }
    }

    /// On the system clock.
    pub fn open(file: Option<PathBuf>) -> Self {
        Self::new(file, Arc::new(SystemClock))
    }

    fn now(&self) -> f64 {
        self.clock.now() as f64
    }

    /// Keeps a job's answer, until it is heard.
    pub fn keep(&self, answer: NewAnswer) -> WaitingAnswer {
        let kept = WaitingAnswer {
            at: answer.at.unwrap_or_else(|| self.now()),
            job: answer.job,
            pane: answer.pane,
            label: answer.label,
            question: answer.question,
            answer: answer.answer,
            mentioned: false,
        };
        let mut answers = self.answers.lock().unwrap();
        answers.retain(|each| each.job != kept.job);
        answers.push(kept.clone());
        if answers.len() > KEPT {
            let extra = answers.len() - KEPT;
            answers.drain(..extra);
        }
        self.save(&answers);
        kept
    }

    /// The answers still waiting, oldest first.
    pub fn list(&self) -> Vec<WaitingAnswer> {
        let mut answers = self.answers.lock().unwrap();
        self.prune(&mut answers);
        answers.clone()
    }

    pub fn get(&self, job: &str) -> Option<WaitingAnswer> {
        let mut answers = self.answers.lock().unwrap();
        self.prune(&mut answers);
        answers.iter().find(|answer| answer.job == job).cloned()
    }

    /// Marks `jobs` mentioned to the user; how many were.
    pub fn mention(&self, jobs: &[&str]) -> usize {
        let mut answers = self.answers.lock().unwrap();
        let mut marked = 0;
        for answer in answers.iter_mut() {
            if jobs.contains(&answer.job.as_str()) && !answer.mentioned {
                answer.mentioned = true;
                marked += 1;
            }
        }
        if marked > 0 {
            self.save(&answers);
        }
        marked
    }

    /// The user heard it (told, read, or dismissed): forgotten.
    pub fn heard(&self, job: &str) -> bool {
        let mut answers = self.answers.lock().unwrap();
        let before = answers.len();
        answers.retain(|answer| answer.job != job);
        if answers.len() == before {
            return false;
        }
        self.save(&answers);
        true
    }

    /// The answers waiting, for the front's state ([`waiting_context`]).
    pub fn context(&self) -> String {
        waiting_context(&self.list(), self.now())
    }

    /// Dismissed without `job`: every answer waiting goes. The jobs gone.
    pub fn dismiss(&self, job: Option<&str>) -> Vec<String> {
        if let Some(job) = job.filter(|job| !job.is_empty()) {
            return if self.heard(job) {
                vec![job.to_owned()]
            } else {
                vec![]
            };
        }
        let mut answers = self.answers.lock().unwrap();
        let gone: Vec<String> = answers.iter().map(|answer| answer.job.clone()).collect();
        if !gone.is_empty() {
            answers.clear();
            self.save(&answers);
        }
        gone
    }

    fn prune(&self, answers: &mut Vec<WaitingAnswer>) {
        let now = self.now();
        let before = answers.len();
        answers.retain(|answer| now - answer.at <= WAITING_MS);
        if answers.len() != before {
            self.save(answers);
        }
    }

    fn save(&self, answers: &[WaitingAnswer]) {
        let Some(file) = &self.file else {
            return;
        };
        // Kept here, at least, when it fails.
        let _ = (|| -> std::io::Result<()> {
            if let Some(parent) = file.parent() {
                roamgate_base::private::create_dir_all_mode(parent)?;
            }
            let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
            let list = Value::Array(answers.iter().map(WaitingAnswer::to_json).collect());
            std::fs::write(&tmp, js::stringify(&list))?;
            roamgate_base::private::set_mode(&tmp, 0o600)?;
            std::fs::rename(&tmp, file)
        })();
    }
}

fn load(file: &Path) -> Vec<WaitingAnswer> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(items)) => items.iter().filter_map(WaitingAnswer::from_json).collect(),
        _ => Vec::new(),
    }
}

fn ago(at: f64, now: f64) -> String {
    let minutes = js::round((now - at) / 60_000.0).max(0.0);
    if minutes < 1.0 {
        return "just now".into();
    }
    if minutes < 60.0 {
        return format!("{} min ago", js::number_text(minutes));
    }
    let hours = js::round(minutes / 60.0);
    if hours < 2.0 {
        "1 h ago".into()
    } else {
        format!("{} h ago", js::number_text(hours))
    }
}

/// `text.replace(/\s+/g, " ").trim()`.
pub(crate) fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() || js::is_js_space(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// The answers waiting, for the front's state: each with its job (what
/// "read" and "dismiss" name), who answered, when, the question, whether
/// it was mentioned, and how it starts. "" with none.
pub fn waiting_context(answers: &[WaitingAnswer], now: f64) -> String {
    if answers.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "Answers waiting (they came while the user was away: the page had reloaded or the call had ended; the page mentions each once at a chat's start, never read or summed up unasked; {\"to\": \"read\", \"job\": \"<id>\"} reads one whole, {\"to\": \"dismiss\", \"job\": \"<id>\"} drops it):".to_owned(),
    ];
    for answer in answers {
        let text = collapse(&answer.answer);
        let length = len16(&text);
        let start = if length > CONTEXT_CHARS {
            format!("{}...", slice16(&text, 0, Some(CONTEXT_CHARS as i64)))
        } else {
            text.clone()
        };
        lines.push(format!(
            "- job {}: {}, {}, asked {}{}. Starts: {} ({length} characters)",
            answer.job,
            answer.label,
            ago(answer.at, now),
            js::quote(&answer.question),
            if answer.mentioned {
                ", mentioned"
            } else {
                ", not mentioned yet"
            },
            js::quote(&start),
        ));
    }
    lines.join("\n")
}

/// The waiting answers as the page's JSON list.
pub fn waiting_json(answers: &[WaitingAnswer]) -> Value {
    Value::Array(answers.iter().map(WaitingAnswer::to_json).collect())
}

#[cfg(test)]
mod tests;
