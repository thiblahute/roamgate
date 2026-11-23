//! JS string semantics the board's texts depend on: lengths and slices in
//! UTF-16 units, JS's white space (`trim`, `\s`), `String(value)`, and the
//! order `localeCompare` gives the names and tags the board sorts.

use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

pub use roamgate_base::log::{slice_utf16, utf16_len};

/// JS's `\s` as a regex class body (no brackets).
pub const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Whether `character` is JS white space (what `trim` and `\s` take).
pub fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `text.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.trimEnd()`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// A regex with `\s` meaning JS's white space: write `{S}` for the class.
pub fn js_regex(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{S}", &format!("[{JS_SPACE}]")))
        .unwrap_or_else(|error| panic!("{pattern}: {error}"))
}

/// `\r\n?` as `\n`.
pub fn unix_lines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => roamgate_base::log::js_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value)` of an argument that may be absent (`undefined`).
pub fn js_string_of(value: Option<&Value>) -> String {
    value.map(js_string).unwrap_or_else(|| "undefined".into())
}

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x08\x0B-\x1F\x7F]").expect("control"));
static NEWLINE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"{S}*\n{S}*"));

/// One line: no control characters, at most `max` (UTF-16 units), `...`
/// included.
pub fn one_line(value: &str, max: usize) -> String {
    let line = CONTROL.replace_all(value, "");
    let line = NEWLINE.replace_all(&line, " ");
    let line = js_trim(&line);
    if utf16_len(line) > max {
        format!("{}...", slice_utf16(line, max.saturating_sub(3)))
    } else {
        line.to_owned()
    }
}

/// ICU's root order for the characters a name or tag holds, near enough:
/// punctuation and symbols first (in ICU's order), then digits, then
/// letters by their base letter, case and accents breaking ties.
fn primary(character: char) -> (u8, u32) {
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if is_js_space(character) {
        return (0, character as u32);
    }
    if let Some(at) = PUNCTUATION.find(character) {
        return (1, at as u32);
    }
    if character.is_ascii_digit() {
        return (3, character as u32);
    }
    let base = character
        .to_lowercase()
        .collect::<String>()
        .nfkd()
        .find(|each| !('\u{300}'..='\u{36F}').contains(each))
        .unwrap_or(character);
    if base.is_alphabetic() {
        return (4, base as u32);
    }
    (2, character as u32)
}

/// `a.localeCompare(b)` for names and tags (ICU root collation, the
/// differences that matter to them).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let left: Vec<(u8, u32)> = a.chars().map(primary).collect();
    let right: Vec<(u8, u32)> = b.chars().map(primary).collect();
    left.cmp(&right)
        .then_with(|| {
            let strip = |text: &str| text.nfd().collect::<String>();
            // Accents, then lower case before upper case.
            let accents = |text: &str| {
                strip(text)
                    .chars()
                    .filter(|each| ('\u{300}'..='\u{36F}').contains(each))
                    .collect::<String>()
            };
            accents(a).cmp(&accents(b))
        })
        .then_with(|| {
            let case = |text: &str| {
                text.chars()
                    .map(|each| each.is_uppercase())
                    .collect::<Vec<_>>()
            };
            case(a).cmp(&case(b))
        })
        .then_with(|| a.cmp(b))
}

/// ISO 8601 of epoch milliseconds, as `toISOString`.
pub fn iso(ms: i64) -> String {
    roamgate_base::log::iso_millis(ms)
}

/// `new Date(value).getTime()` for what the board is given: a number, or
/// an ISO 8601 date or date-time (a date alone is UTC, a date-time without
/// an offset local time, as JS reads them); None when it is not a date.
pub fn parse_js_date(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            let ms = number.as_f64()?;
            (ms.is_finite() && ms.abs() <= 8.64e15).then_some(ms.trunc() as i64)
        }
        Value::String(text) => parse_date_text(js_trim(text)),
        _ => None,
    }
}

fn parse_date_text(text: &str) -> Option<i64> {
    use jiff::civil::{Date, DateTime};
    use jiff::tz::TimeZone;
    if let Ok(timestamp) = text.parse::<jiff::Timestamp>() {
        return Some(timestamp.as_millisecond());
    }
    static YEAR_MONTH: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(\d{4})(?:-(\d{2}))?$").expect("year"));
    if let Some(found) = YEAR_MONTH.captures(text) {
        let year: i16 = found[1].parse().ok()?;
        let month: i8 = found.get(2).map_or(Some(1), |m| m.as_str().parse().ok())?;
        let date = Date::new(year, month, 1).ok()?;
        return Some(
            date.to_zoned(TimeZone::UTC)
                .ok()?
                .timestamp()
                .as_millisecond(),
        );
    }
    if let Ok(date) = text.parse::<Date>()
        && text.len() == 10
    {
        return Some(
            date.to_zoned(TimeZone::UTC)
                .ok()?
                .timestamp()
                .as_millisecond(),
        );
    }
    let local = text.replacen(' ', "T", 1);
    if let Ok(time) = local.parse::<DateTime>() {
        return Some(
            time.to_zoned(TimeZone::system())
                .ok()?
                .timestamp()
                .as_millisecond(),
        );
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_line_drops_controls_and_joins_lines() {
        assert_eq!(one_line("  a\u{1}b \n  c  ", 80), "ab c");
        assert_eq!(one_line("abcdef", 4), "a...");
        assert_eq!(one_line("\u{A0}x\u{FEFF}", 9), "x");
    }

    #[test]
    fn dates_read_as_js_reads_them() {
        assert_eq!(
            parse_js_date(&json!("2026-11-01T10:00:00.000Z")).map(iso),
            Some("2026-11-01T10:00:00.000Z".into())
        );
        assert_eq!(
            parse_js_date(&json!("2026-11-01")).map(iso),
            Some("2026-11-01T00:00:00.000Z".into())
        );
        assert_eq!(
            parse_js_date(&json!("2026-11-01T10:00:00+02:00")).map(iso),
            Some("2026-11-01T08:00:00.000Z".into())
        );
        assert_eq!(
            parse_js_date(&json!(0)).map(iso),
            Some("1970-01-01T00:00:00.000Z".into())
        );
        assert_eq!(parse_js_date(&json!("soon")), None);
    }

    #[test]
    fn names_sort_as_icu_sorts_them() {
        // As Bun's localeCompare gives them.
        let mut names = vec![
            "roamgate", "gst2", "gst_x", "Alpha", "élan", "gst-a", "zeta", "a.b", "a-b", "a_b",
            "a1", "ab", "aB", "Ab",
        ];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            names,
            [
                "a_b", "a-b", "a.b", "a1", "ab", "aB", "Ab", "Alpha", "élan", "gst_x", "gst-a",
                "gst2", "roamgate", "zeta"
            ]
        );
    }
}
