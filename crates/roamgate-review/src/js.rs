//! What the TS service gets from JavaScript itself and the port has to
//! say: string lengths and slices in UTF-16 units (the limits of
//! `REVIEW_LIMITS` count them), `String.prototype.trim`, `Date`'s ISO form,
//! `Date.parse` and the local hours and minutes of a time.

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::TimeZone;

/// `value.length`: UTF-16 code units.
pub fn len16(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `value.slice(start, end)` in UTF-16 units; a cut inside a surrogate pair
/// keeps the whole character out (JS would keep half of it).
pub fn slice16(value: &str, start: usize, end: usize) -> &str {
    let mut units = 0;
    let mut from = value.len();
    let mut to = value.len();
    let mut started = false;
    for (index, ch) in value.char_indices() {
        if !started && units >= start {
            from = index;
            started = true;
        }
        if units >= end {
            to = index;
            break;
        }
        units += ch.len_utf16();
    }
    if !started {
        return "";
    }
    if to < from {
        return "";
    }
    &value[from..to]
}

/// The first `max` UTF-16 units of `value`.
pub fn head16(value: &str, max: usize) -> &str {
    slice16(value, 0, max)
}

/// Whether `ch` is what JavaScript's `trim` and `\s` take as white space.
pub fn js_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{feff}'
}

/// `value.trim()`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_and_slices_count_utf16_units() {
        assert_eq!(len16("a\u{1F600}b"), 4);
        assert_eq!(slice16("a\u{1F600}b", 0, 1), "a");
        assert_eq!(slice16("a\u{1F600}b", 1, 3), "\u{1F600}");
        assert_eq!(slice16("abc", 1, 10), "bc");
        assert_eq!(slice16("abc", 5, 10), "");
        assert_eq!(head16("abcdef", 3), "abc");
    }

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

    #[test]
    fn trims_javascript_space() {
        assert_eq!(trim("\u{feff} a b \n"), "a b");
    }
}
