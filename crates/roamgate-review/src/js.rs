//! What the TS service gets from JavaScript itself: string lengths,
//! slices and `trim` (roamgate-agents' helpers, the one copy), and here
//! `Date`'s ISO form, `Date.parse` and the local hours and minutes of a
//! time.

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::TimeZone;

pub use roamgate_agents::js::{head16, is_js_space as js_space, len16, slice16, trim};

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    match Timestamp::from_millisecond(ms) {
        Ok(at) => at.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        Err(_) => String::new(),
    }
}

/// `Date.parse(value)` for the forms the service meets: ISO dates (UTC),
/// ISO date-times with an offset or `Z`, and without one (local time).
/// `None` where JavaScript gives `NaN`.
pub fn date_parse(value: &str) -> Option<i64> {
    let text = trim(value);
    if text.is_empty() {
        return None;
    }
    if let Ok(at) = text.parse::<Timestamp>() {
        return Some(at.as_millisecond());
    }
    if text.len() == 10
        && let Ok(date) = text.parse::<jiff::civil::Date>()
    {
        return date
            .to_zoned(TimeZone::UTC)
            .ok()
            .map(|zoned| zoned.timestamp().as_millisecond());
    }
    if let Ok(civil) = text.parse::<DateTime>() {
        return civil
            .to_zoned(TimeZone::system())
            .ok()
            .map(|zoned| zoned.timestamp().as_millisecond());
    }
    None
}

/// "HH:MM" of a time in the server's time zone, as `Date#getHours` and
/// `getMinutes` give them.
pub fn local_hh_mm(ms: i64) -> Option<String> {
    let at = Timestamp::from_millisecond(ms).ok()?;
    let zoned = at.to_zoned(TimeZone::system());
    Some(format!("{:02}:{:02}", zoned.hour(), zoned.minute()))
}

/// `Number.isInteger(value)` of a JSON value.
pub fn integer(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            let float = number.as_f64()?;
            (float.fract() == 0.0 && float.abs() < 9.007_199_254_740_992e15).then_some(float as i64)
        }
        _ => None,
    }
}

/// `String(error)` of a message: what the service puts in its errors.
pub fn upper_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `String(number)` for the numbers texts show.
pub fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times_have_milliseconds() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_767_182_400_123), "2025-12-31T12:00:00.123Z");
    }

    #[test]
    fn dates_parse_as_javascript_does() {
        assert_eq!(date_parse("2025-12-31T12:00:00Z"), Some(1_767_182_400_000));
        assert_eq!(
            date_parse("2025-12-31T12:00:00.000+01:00"),
            Some(1_767_178_800_000)
        );
        assert_eq!(date_parse("2025-12-31"), Some(1_767_139_200_000));
        assert_eq!(date_parse("yesterday"), None);
        assert_eq!(date_parse(""), None);
    }
}
