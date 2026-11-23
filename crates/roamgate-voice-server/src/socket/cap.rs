//! When a pause ends a turn (voice-socket.ts, SilenceCap): the helper's
//! readings of the words at each pause, the voice's score and whether the
//! speaker sounds to be thinking set how long the pause may go.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::config::{LONGEST_PAUSE_MS, MAX_PAUSE_MS};

/// How finished the voice must sound (speechgate's `turn`, Smart Turn) for
/// the cap to apply. Finished sentences scored 0.67 and 0.86 at 2.5 and
/// 3.5 s of pause; pauses mid-thought, looking for a word, 0.01 to 0.16.
pub const TURN_SOUNDS_FINISHED: f64 = 0.5;
/// A voice this finished ends its turn at SURE_PAUSE_MS, whatever its words
/// read like or a short noise taken for thinking.
pub const TURN_SURELY_FINISHED: f64 = 0.9;
pub const SURE_PAUSE_MS: f64 = 3000.0;
/// The longest pause after a question asked whole in a finished voice.
pub const QUESTION_PAUSE_MS: f64 = 2500.0;
/// The first `partial` with `pause` comes this far into a pause when the
/// helper does not say (`pause_ms`): speechgate's EARLY_READ.
const FIRST_PAUSE_READ_MS: f64 = 500.0;
/// 16 kHz mono S16LE.
pub const BYTES_PER_MS: f64 = 32.0;

/// Words said while looking for the next ones. Parakeet writes a trailing
/// "euh" as "eux": taken for one here, it only keeps a vetoed turn open
/// longer.
const FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "euh", "eux", "heu", "hum",
    "eh", "ben", "bah", "alors", "em",
];

static NOT_A_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}']+").unwrap());

/// The words end with a question mark.
pub fn ends_with_question(text: &str) -> bool {
    text.trim_end().ends_with(['?', '？'])
}

/// The words end with a filler ("... and then euh").
pub fn ends_with_filler(text: &str) -> bool {
    let lower = text.to_lowercase();
    let last = NOT_A_WORD
        .split(&lower)
        .filter(|word| !word.is_empty())
        .last()
        .unwrap_or("");
    FILLERS.contains(&last)
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// The cap on a pause. From the helper's first reading of a pause, the
/// audio that comes after is counted: at `cap_ms` the utterance is finished
/// if the voice sounded finished, at the longest pause whatever it sounded
/// like, at QUESTION_PAUSE_MS for a question asked whole in a finished
/// voice, at SURE_PAUSE_MS when the voice sounded surely finished. A
/// trailing filler holds the turn to the longest pause. Any voice starts
/// the count again. Only audio that came counts: a stall is not silence.
#[derive(Debug, Clone)]
pub struct SilenceCap {
    cap_ms: f64,
    longest_ms: f64,
    paused_ms: Option<f64>,
    /// `pause_ms` of the pause's last reading.
    read_ms: f64,
    words: usize,
    /// The voice's best score this pause; None before speechgate's checks.
    turn: Option<f64>,
    holding: bool,
    fired: bool,
    question: bool,
    filler: bool,
}

impl Default for SilenceCap {
    fn default() -> Self {
        Self::new(MAX_PAUSE_MS)
    }
}

impl SilenceCap {
    pub fn new(cap_ms: f64) -> Self {
        Self {
            cap_ms,
            longest_ms: LONGEST_PAUSE_MS.max(cap_ms),
            paused_ms: None,
            read_ms: 0.0,
            words: 0,
            turn: None,
            holding: false,
            fired: false,
            question: false,
            filler: false,
        }
    }

    /// What the helper said of the utterance.
    pub fn event(&mut self, event: &Map<String, Value>) {
        match event.get("event").and_then(Value::as_str) {
            Some("speech_start") => {
                self.paused_ms = None;
                self.words = 0;
                self.fired = false;
            }
            Some("partial") => {
                let text = event.get("text").and_then(Value::as_str).unwrap_or("");
                let words = count_words(text);
                if event.get("pause") != Some(&Value::Bool(true)) {
                    self.paused_ms = None;
                    self.words = words;
                    return;
                }
                let told = event.get("pause_ms").and_then(Value::as_f64);
                let at = told.unwrap_or(FIRST_PAUSE_READ_MS);
                let voice_came = self.paused_ms.is_none()
                    || words > self.words
                    || (told.is_some() && at < self.read_ms);
                if voice_came {
                    self.paused_ms = Some(at);
                    self.turn = None;
                    self.holding = false;
                } else {
                    self.paused_ms = Some(self.paused_ms.unwrap_or(at).max(at));
                }
                self.read_ms = at;
                self.words = words;
                if let Some(turn) = event.get("turn").and_then(Value::as_f64) {
                    self.turn = Some(self.turn.unwrap_or(0.0).max(turn));
                }
                let filler = ends_with_filler(text);
                self.holding =
                    self.holding || event.get("thinking") == Some(&Value::Bool(true)) || filler;
                self.question = ends_with_question(text);
                self.filler = filler;
            }
            Some("speech_end" | "final") => {
                self.paused_ms = None;
                self.fired = true;
            }
            _ => {}
        }
    }

    /// How long the pause may go now.
    pub fn limit_ms(&self) -> f64 {
        let turn = self.turn.unwrap_or(0.0);
        let finished = self.turn.is_some() && turn >= TURN_SOUNDS_FINISHED;
        if !self.filler {
            // A question asked whole, or a voice surely done: answered
            // soon, noise taken for thinking or not.
            if finished && self.question {
                return self.cap_ms.min(QUESTION_PAUSE_MS);
            }
            if turn >= TURN_SURELY_FINISHED {
                return self.cap_ms.min(SURE_PAUSE_MS);
            }
        }
        if !self.holding && finished {
            self.cap_ms
        } else {
            self.longest_ms
        }
    }

    /// Audio that came: true once, when it takes the pause to its limit.
    pub fn audio(&mut self, bytes: f64) -> bool {
        let Some(paused) = self.paused_ms.filter(|_| !self.fired) else {
            return false;
        };
        let paused = paused + bytes / BYTES_PER_MS;
        self.paused_ms = Some(paused);
        if paused < self.limit_ms() {
            return false;
        }
        self.fired = true;
        true
    }
}
