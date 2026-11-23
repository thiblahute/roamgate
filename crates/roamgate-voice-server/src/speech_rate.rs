//! How fast voice replies are read (shared/speechRate.ts), held to
//! contract/vectors/speech-rate.json.

use serde_json::Value;

use crate::js;

pub const DEFAULT_SPEECH_RATE: f64 = 1.2;
pub const MIN_SPEECH_RATE: f64 = 0.5;
pub const MAX_SPEECH_RATE: f64 = 2.0;

/// The rates the voice card's speed button goes through, in order.
pub const SPEECH_RATE_STEPS: [f64; 5] = [1.0, 1.1, 1.2, 1.3, 1.5];

/// `isSpeechRate`: a finite number from 0.5 to 2.
pub fn is_speech_rate(value: &Value) -> bool {
    value.as_f64().is_some_and(is_rate)
}

pub fn is_rate(value: f64) -> bool {
    value.is_finite() && (MIN_SPEECH_RATE..=MAX_SPEECH_RATE).contains(&value)
}

/// `speechRateOr`: `value` when it is a rate, the default otherwise.
pub fn speech_rate_or(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(rate) if is_rate(rate) => rate,
        _ => DEFAULT_SPEECH_RATE,
    }
}

/// The speed button's next rate.
pub fn next_speech_rate(rate: f64) -> f64 {
    SPEECH_RATE_STEPS
        .iter()
        .copied()
        .find(|step| *step > rate + 1e-6)
        .unwrap_or(SPEECH_RATE_STEPS[0])
}

/// The playback rate that makes audio made at `native_rate` sound at `rate`.
pub fn playback_rate_for(rate: f64, native_rate: f64) -> f64 {
    let native = if native_rate > 0.0 && native_rate.is_finite() {
        native_rate
    } else {
        1.0
    };
    let rate = if is_rate(rate) {
        rate
    } else {
        DEFAULT_SPEECH_RATE
    };
    js::round_to(rate / native, 1000.0)
}

/// "1.2x", "1x".
pub fn format_speech_rate(rate: f64) -> String {
    format!("{}x", js::number_text(js::round_to(rate, 100.0)))
}
