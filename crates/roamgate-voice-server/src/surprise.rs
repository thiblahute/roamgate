//! Surprise (voice-surprise.ts): each reply is read by one of the user's
//! voices, picked at random (never the one that read the reply before when
//! there is another), whatever language the reply is in: a voice recorded
//! in French reads English too, with its own timbre. One voice per reply,
//! not per sentence, so a reply sounds like one person; the helper switches
//! voices once, at the reply's first sentence.

use std::sync::Arc;

use indexmap::IndexMap;

/// A number in [0, 1) (`Math.random`).
pub type Random = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `Math.random`.
pub fn math_random() -> Random {
    Arc::new(rand::random::<f64>)
}

/// A voice for a reply: any, but not `last` when another one may read
/// (`voices` are the voices' ids).
pub fn pick_surprise_voice(
    voices: &[String],
    last: Option<&str>,
    random: &dyn Fn() -> f64,
) -> Option<String> {
    let fresh: Vec<&String> = voices
        .iter()
        .filter(|voice| Some(voice.as_str()) != last)
        .collect();
    let choices: Vec<&String> = if fresh.is_empty() {
        voices.iter().collect()
    } else {
        fresh
    };
    if choices.is_empty() {
        return None;
    }
    let index = ((random() * choices.len() as f64).floor() as usize).min(choices.len() - 1);
    Some(choices[index].clone())
}

/// Readings remembered, so each sentence of a reply keeps its voice.
const REMEMBERED: usize = 64;

/// Who reads each reply: picked at its first sentence, kept for the rest
/// (`reading` names the reply; without one, each sentence is a reply).
pub struct SurprisePicker {
    random: Random,
    readings: IndexMap<String, String>,
    last: Option<String>,
}

impl SurprisePicker {
    pub fn new(random: Random) -> Self {
        Self {
            random,
            readings: IndexMap::new(),
            last: None,
        }
    }

    pub fn pick(&mut self, voices: &[String], reading: Option<&str>) -> Option<String> {
        let known = reading
            .filter(|reading| !reading.is_empty())
            .and_then(|reading| self.readings.get(reading));
        if let Some(known) = known
            && voices.contains(known)
        {
            return Some(known.clone());
        }
        let id = pick_surprise_voice(voices, self.last.as_deref(), self.random.as_ref())?;
        self.last = Some(id.clone());
        if let Some(reading) = reading.filter(|reading| !reading.is_empty()) {
            // Map.set keeps an existing key where it is.
            match self.readings.get_mut(reading) {
                Some(entry) => *entry = id.clone(),
                None => {
                    self.readings.insert(reading.to_owned(), id.clone());
                }
            }
            if self.readings.len() > REMEMBERED {
                self.readings.shift_remove_index(0);
            }
        }
        Some(id)
    }
}

impl Default for SurprisePicker {
    fn default() -> Self {
        Self::new(math_random())
    }
}

#[cfg(test)]
mod tests;
