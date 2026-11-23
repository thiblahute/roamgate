//! What made each session start its turns (`voice/turn-causes.ts`), for
//! the voice companion's EVENTs: a session that finishes a turn the user
//! just asked for themselves is no news, one the companion, another agent
//! or Ranger set going is. Every way Roamgate gives a session words notes
//! who sent them; the user's own input (typing in the terminal, a chat
//! message, a review comment) also counts as their last interaction with
//! it.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use roamgate_base::clock::{Clock, SystemClock};

use crate::js;

/// How the user gave a session words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserVia {
    Terminal,
    Chat,
    Review,
}

/// Who started a turn, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnCause {
    User(UserVia),
    Companion,
    Agent(String),
    Ranger,
}

/// A cause and when it was noted (epoch milliseconds).
#[derive(Debug, Clone, PartialEq)]
pub struct NotedCause {
    pub cause: TurnCause,
    pub at: f64,
}

/// What [`TurnCauses::turn`] knows of a session's turn.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub cause: Option<NotedCause>,
    pub user_at: Option<f64>,
}

/// Causes kept per session, newest last.
const KEPT: usize = 8;
/// A cause noted this long before a turn started did not start it.
const CAUSE_WINDOW_MS: f64 = 30.0 * 60_000.0;
/// Words sent this long after a turn started may still have started it.
const START_SLACK_MS: f64 = 10_000.0;
/// Sessions remembered at most, the least recent dropped first.
const MAX_SESSIONS: usize = 500;

fn key(connection_id: &str, pane_id: &str) -> String {
    format!("{connection_id}/{pane_id}")
}

#[derive(Default)]
struct Records {
    causes: IndexMap<String, Vec<NotedCause>>,
    user_at: IndexMap<String, f64>,
}

fn trim<V>(map: &mut IndexMap<String, V>) {
    while map.len() > MAX_SESSIONS {
        map.shift_remove_index(0);
    }
}

/// The record the server's ways of sending words share (one per server).
pub struct TurnCauses {
    records: Mutex<Records>,
    clock: Arc<dyn Clock>,
}

impl Default for TurnCauses {
    fn default() -> Self {
        Self::new(Arc::new(SystemClock))
    }
}

impl TurnCauses {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            records: Mutex::new(Records::default()),
            clock,
        }
    }

    fn now(&self) -> f64 {
        self.clock.now() as f64
    }

    /// `cause` just gave the session words.
    pub fn note(&self, connection_id: &str, pane_id: &str, cause: TurnCause) {
        let id = key(connection_id, pane_id);
        let at = self.now();
        let user = matches!(cause, TurnCause::User(_));
        {
            let mut records = self.records.lock().unwrap();
            let mut list = records.causes.shift_remove(&id).unwrap_or_default();
            list.push(NotedCause { cause, at });
            if list.len() > KEPT {
                list.drain(..list.len() - KEPT);
            }
            records.causes.insert(id, list);
            trim(&mut records.causes);
        }
        if user {
            self.note_user(connection_id, pane_id);
        }
    }

    /// The user did something in the session (a key typed, for one).
    pub fn note_user(&self, connection_id: &str, pane_id: &str) {
        let id = key(connection_id, pane_id);
        let now = self.now();
        let mut records = self.records.lock().unwrap();
        records.user_at.shift_remove(&id);
        records.user_at.insert(id, now);
        trim(&mut records.user_at);
    }

    /// What started the turn of the session that began `turn_ms` ago (or
    /// the newest cause, when that is not known), and when the user last
    /// did something in it.
    pub fn turn(&self, connection_id: &str, pane_id: &str, turn_ms: Option<f64>) -> Turn {
        let id = key(connection_id, pane_id);
        let now = self.now();
        let started = turn_ms.map_or(now, |ms| now - ms);
        let records = self.records.lock().unwrap();
        let cause = records.causes.get(&id).and_then(|list| {
            list.iter()
                .rev()
                .find(|each| {
                    each.at <= started + START_SLACK_MS && each.at >= started - CAUSE_WINDOW_MS
                })
                .cloned()
        });
        Turn {
            cause,
            user_at: records.user_at.get(&id).copied(),
        }
    }
}

fn ago(ms: f64) -> String {
    let seconds = js::round(ms / 1000.0).max(0.0);
    if seconds < 90.0 {
        return format!("{} s", js::number_text(seconds));
    }
    let minutes = js::round(seconds / 60.0);
    if minutes < 90.0 {
        return format!("{} min", js::number_text(minutes));
    }
    format!("{} h", js::number_text(js::round(minutes / 60.0)))
}

fn cause_words(cause: &TurnCause) -> String {
    match cause {
        TurnCause::User(UserVia::Review) => "the user's review comment".into(),
        TurnCause::User(UserVia::Chat) => "the user's chat message".into(),
        TurnCause::User(UserVia::Terminal) => "the user typing in its terminal".into(),
        TurnCause::Companion => "your own errand".into(),
        TurnCause::Agent(name) => format!("a message from agent session {name}"),
        TurnCause::Ranger => "Ranger".into(),
    }
}

/// What [`turn_context`] tells of a turn.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnFacts {
    pub cause: Option<NotedCause>,
    pub user_at: Option<f64>,
    pub turn_ms: Option<f64>,
    pub looking: bool,
}

/// The words an EVENT about a session's turn ends with, in parentheses:
/// what started it, how long it ran, when the user last did something in
/// it and whether they are looking at it, e.g. "(started by the user's
/// review comment; ran 40 s; the user is looking at it)".
pub fn turn_context(turn: &TurnFacts, now: f64) -> String {
    let mut parts = vec![match &turn.cause {
        Some(noted) => format!("started by {}", cause_words(&noted.cause)),
        None => "started by nothing Roamgate saw: cause unknown".into(),
    }];
    if let Some(ms) = turn.turn_ms {
        parts.push(format!("ran {}", ago(ms)));
    }
    match turn.user_at {
        Some(at) => parts.push(format!("the user's last input there {} ago", ago(now - at))),
        None => parts.push("no input from the user there lately".into()),
    }
    if turn.looking {
        parts.push("the user is looking at it".into());
    }
    format!("({})", parts.join("; "))
}

/// An EVENT about a session (`body.pane` is `<connection>/<pane>`) with
/// its turn's context added (`withTurnContext` of http/voice.ts); others
/// as they are.
pub fn with_turn_context(
    event: &str,
    body: Option<&Map<String, Value>>,
    causes: &TurnCauses,
    now: f64,
) -> String {
    let pane = body
        .and_then(|b| b.get("pane"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(slash) = pane.find('/') else {
        return event.to_owned();
    };
    if slash == 0 || slash == pane.len() - 1 {
        return event.to_owned();
    }
    let turn_ms = body
        .and_then(|b| b.get("turn_ms"))
        .and_then(Value::as_f64)
        .filter(|ms| ms.is_finite() && *ms >= 0.0);
    let turn = causes.turn(&pane[..slash], &pane[slash + 1..], turn_ms);
    let looking = body.and_then(|b| b.get("looking")) == Some(&Value::Bool(true));
    let facts = TurnFacts {
        cause: turn.cause,
        user_at: turn.user_at,
        turn_ms,
        looking,
    };
    format!("{event} {}", turn_context(&facts, now))
}

#[cfg(test)]
mod tests;
