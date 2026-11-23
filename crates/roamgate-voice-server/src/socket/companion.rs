//! What the voice socket asks of the companion layer (voice-cleaner.ts,
//! voice-dictation.ts, voice-front.ts): the voice chat's cleaner, the
//! dictation cleaner and whether a companion hears what is said. The
//! socket is given a [`Companion`]; the companion layer implements it, and
//! [`NoCompanion`] is the socket without one (words as heard).

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::helper::BoxFuture;

/// A final cleaned by the voice chat's cleaner (voice-cleaner.ts Cleaned).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cleaned {
    pub text: String,
    /// False: words the cleaner holds back from the agent.
    pub for_agent: bool,
}

/// A dictation's text (voice-dictation.ts Dictated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dictated {
    pub text: String,
    /// False: the words as heard (no model, failed, too slow, refused).
    pub cleaned: bool,
}

/// One listening's cleaning (voice-cleaner.ts CleanSession), for one
/// context: a new one is asked for after each final.
pub trait CleanSession: Send + Sync {
    /// What is heard so far; `pause` when the helper reads it at a pause.
    fn partial(&self, text: &str, pause: bool);
    /// The final text cleaned. An error drops the final, as Bun's chain
    /// does.
    fn final_text(&self, text: &str) -> BoxFuture<Result<Cleaned, String>>;
    /// The listening ended: anything still asked is abandoned.
    fn close(&self);
}

/// The voice chat's cleaner (voice-cleaner.ts VoiceCleaner).
pub trait Cleaner: Send + Sync {
    /// Starts its sessions, so the first utterance does not wait.
    fn warm(&self);
    /// A cleaning for `context`, the conversation's end (at most 4000
    /// UTF-16 units).
    fn session(&self, context: &str) -> Arc<dyn CleanSession>;
}

/// One dictation's cleaning (voice-dictation.ts dictationSession and
/// dictated): its context made from the listen request.
pub trait DictationSession: Send + Sync {
    /// The whole dictation heard so far; `pause` at a pause.
    fn partial(&self, whole: &str, pause: bool);
    /// The dictation's end: `heard` is the words as heard, whitespace
    /// collapsed and never empty. Gives the cleaned text, or `heard` with
    /// `cleaned: false` when the model fails, is too slow
    /// (DICTATION_CLEAN_MS) or its text does not read as a cleaning.
    fn clean(&self, heard: &str) -> BoxFuture<Dictated>;
    fn close(&self);
}

/// The dictation cleaner (voice.json's `dictation_model`).
pub trait DictationCleaner: Send + Sync {
    fn warm(&self);
    /// A cleaning for the dictation `listen` starts: the request as the
    /// client sent it (`field`, `before`, `after`, `language`, `context`),
    /// for dictationTarget to bound and check.
    fn session(&self, listen: &Map<String, Value>) -> Arc<dyn DictationSession>;
}

/// The companion layer, as the voice socket sees it. Each is read when the
/// socket needs it, so voice.json's changes apply at the next listen.
pub trait Companion: Send + Sync {
    /// The voice chat's cleaner (createVoiceSocket's `cleaner`), if set up.
    fn chat_cleaner(&self) -> Option<Arc<dyn Cleaner>>;
    /// The dictation cleaner (createVoiceSocket's `dictation`), None to
    /// type the words as heard.
    fn dictation_cleaner(&self) -> Option<Arc<dyn DictationCleaner>>;
    /// Whether a companion (voice-front.ts) hears what is said: it judges
    /// other voices by their label; without one, a voice that is clearly
    /// not the user's is not for the agent.
    fn fronted(&self) -> bool;
}

/// No companion: the words as heard, other voices not for the agent.
pub struct NoCompanion;

impl Companion for NoCompanion {
    fn chat_cleaner(&self) -> Option<Arc<dyn Cleaner>> {
        None
    }

    fn dictation_cleaner(&self) -> Option<Arc<dyn DictationCleaner>> {
        None
    }

    fn fronted(&self) -> bool {
        false
    }
}
