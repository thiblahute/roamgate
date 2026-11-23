//! What the TS readers lean on from JavaScript itself, done the same way:
//! `JSON.stringify`, `Date.parse` and `toISOString`, `Number(text)`,
//! UTF-16 lengths and slices, `trim`, `localeCompare`. The transcripts are
//! JSON read as JavaScript reads it ([`parse`]), and what the readers give
//! is compared with what Bun gives, ids hashed from JSON text included.

use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};

/// A JavaScript object, its keys in insertion order.
pub type Obj = Map<String, Value>;

/// `value && typeof value === "object" && !Array.isArray(value)`.
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// The object `value` is, if it is one.
pub fn rec(value: Option<&Value>) -> Option<&Obj> {
    value.and_then(Value::as_object)
}

/// `typeof value === "string" ? value : ""`.
pub fn sv(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// `typeof value === "string" ? value : undefined`.
pub fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// A finite number, as `numberValue` takes it.
pub fn num(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// `value === true`.
pub fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// A string that is not empty once trimmed (`nonEmptyString`).
pub fn non_empty(value: Option<&Value>) -> Option<&str> {
    str_of(value).filter(|text| !trim(text).is_empty())
}

/// A number as JavaScript holds it: integral ones as integers.
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        return Value::Number(Number::from(value as i64));
    }
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// An integer count as a JSON number.
pub fn int(value: i64) -> Value {
    Value::Number(Number::from(value))
}

/// JSON text parsed as `JSON.parse` gives it (numbers are doubles, object
/// keys in JavaScript's order).
pub fn parse(text: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(text).ok()?;
    Some(js_value(value))
}

/// A parsed value as JavaScript holds it.
pub fn js_value(value: Value) -> Value {
    fn numbers(value: Value) -> Value {
        match value {
            Value::Number(n) => match n.as_f64() {
                Some(double) if !(n.is_i64() || n.is_u64()) || double.abs() >= 9.007e15 => {
                    number(double)
                }
                _ => Value::Number(n),
            },
            Value::Array(items) => Value::Array(items.into_iter().map(numbers).collect()),
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, numbers(v))).collect())
            }
            other => other,
        }
    }
    roamgate_base::json_store::js_key_order(numbers(value))
}

// ---------------------------------------------------------------- strings

/// JavaScript's `trim()`.
pub fn trim(text: &str) -> &str {
    roamgate_base::settings::js_trim(text)
}

/// JavaScript's `trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// JavaScript's `trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// JavaScript's white space and line terminators (`\s`, what `trim` takes).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
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

/// `text.length`: UTF-16 code units.
pub fn len16(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte offset of UTF-16 offset `at` (clamped; inside a pair, the pair
/// is not split: the offset after it).
fn byte_at16(text: &str, at: usize) -> usize {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        if units >= at {
            return index;
        }
        units += c.len_utf16();
    }
    text.len()
}

/// `text.slice(start, end)` on UTF-16 offsets (negative from the end).
pub fn slice16(text: &str, start: i64, end: Option<i64>) -> String {
    let len = len16(text) as i64;
    let clamp = |at: i64| if at < 0 { (len + at).max(0) } else { at.min(len) } as usize;
    let from = clamp(start);
    let to = end.map_or(len as usize, clamp);
    if from >= to {
        return String::new();
    }
    text[byte_at16(text, from)..byte_at16(text, to)].to_owned()
}

/// `text.slice(0, n)`.
pub fn head16(text: &str, n: usize) -> String {
    slice16(text, 0, Some(n as i64))
}

/// `text.slice(n)`.
pub fn tail_from16(text: &str, n: usize) -> String {
    slice16(text, n as i64, None)
}

/// `text.indexOf(needle)` as a UTF-16 offset.
pub fn index_of16(text: &str, needle: &str) -> Option<usize> {
    text.find(needle).map(|at| len16(&text[..at]))
}

/// The UTF-16 offset of byte offset `at`.
pub fn units_before(text: &str, at: usize) -> usize {
    len16(&text[..at])
}

// ---------------------------------------------------------------- JSON text

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value, Some(2), 0);
    out
}

/// A string as `JSON.stringify` quotes it.
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    write_string(&mut out, text);
    out
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A number as JavaScript prints it (`String(n)`).
pub fn number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_owned()
}

fn write_number(out: &mut String, number: &Number) {
    if let Some(n) = number.as_i64() {
        out.push_str(&n.to_string());
    } else if let Some(n) = number.as_u64() {
        out.push_str(&number_text(n as f64));
    } else if let Some(n) = number.as_f64() {
        if n.is_finite() {
            out.push_str(&number_text(n));
        } else {
            out.push_str("null");
        }
    }
}

fn write_json(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    let newline = |out: &mut String, depth: usize| {
        if let Some(step) = indent {
            out.push('\n');
            out.push_str(&" ".repeat(step * depth));
        }
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_json(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_json(out, item, indent, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

// ---------------------------------------------------------------- numbers

/// `Number(text)` for a string.
pub fn number_from_text(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0f64;
        for c in digits.chars() {
            match c.to_digit(base) {
                Some(d) => value = value * base as f64 + d as f64,
                None => return f64::NAN,
            }
        }
        value
    };
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("0x") {
        return radix(rest, 16);
    }
    if let Some(rest) = lower.strip_prefix("0o") {
        return radix(rest, 8);
    }
    if let Some(rest) = lower.strip_prefix("0b") {
        return radix(rest, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap()
    });
    if !DECIMAL.is_match(t) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for a JSON value.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_from_text(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => to_number(Some(one)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(value)` for a JSON value.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let mut out = String::new();
            write_number(&mut out, n);
            out
        }
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    to_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number.isSafeInteger(value)`.
pub fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

// ---------------------------------------------------------------- dates

/// `Date.parse(text)`: ISO 8601 as JavaScript reads it (date only in UTC,
/// a date and time without an offset in local time), and the forms
/// JavaScriptCore also takes (a space for the `T`). NaN when it is not one.
pub fn date_parse(text: &str) -> f64 {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]+))?)?)?\s*([Zz]|[+-][0-9]{2}(?::?[0-9]{2})?)?$",
        )
        .unwrap()
    });
    let t = trim(text);
    let Some(caps) = ISO.captures(t) else {
        return fallback_date_parse(t);
    };
    let year: i64 = caps[1].parse().unwrap_or(0);
    if &caps[1] == "-000000" {
        return f64::NAN;
    }
    let field = |index: usize, default: i64| {
        caps.get(index)
            .map_or(Some(default), |m| m.as_str().parse::<i64>().ok())
    };
    let (Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        field(2, 1),
        field(3, 1),
        field(4, 0),
        field(5, 0),
        field(6, 0),
    ) else {
        return f64::NAN;
    };
    let millis = caps.get(7).map_or(0, |m| {
        let digits: String = m.as_str().chars().chain("000".chars()).take(3).collect();
        digits.parse::<i64>().unwrap_or(0)
    });
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute > 0 || second > 0 || millis > 0))
    {
        return f64::NAN;
    }
    let has_time = caps.get(4).is_some();
    let local_ms = (days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000
        + millis) as f64;
    let offset_ms = match caps.get(8).map(|m| m.as_str()) {
        Some("Z" | "z") => 0.0,
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1.0 } else { 1.0 };
            let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
            let hours: f64 = digits[..2].parse().unwrap_or(0.0);
            let minutes: f64 = digits.get(2..4).and_then(|m| m.parse().ok()).unwrap_or(0.0);
            sign * (hours * 3_600_000.0 + minutes * 60_000.0)
        }
        // Date only: UTC. A date and time: local time.
        None if !has_time => 0.0,
        None => local_offset_ms(local_ms),
    };
    let ms = local_ms - offset_ms;
    if ms.abs() > 8.64e15 { f64::NAN } else { ms }
}

/// The forms JavaScriptCore reads beside ISO that a transcript may hold:
/// `Tue, 02 Jan 2024 03:04:05 GMT` and `Jan 2 2024 03:04:05 GMT+0000`.
fn fallback_date_parse(text: &str) -> f64 {
    static LOOSE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:[a-z]{3},?\s+)?(?:([0-9]{1,2})\s+([a-z]{3})|([a-z]{3})\s+([0-9]{1,2}),?)\s+([0-9]{4})(?:\s+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?\s*(?:(GMT|UTC|Z)?([+-][0-9]{4})?)?(?:\s*\(.*\))?$",
        )
        .unwrap()
    });
    let Some(caps) = LOOSE.captures(text) else {
        return f64::NAN;
    };
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let (day, month) = match (caps.get(1), caps.get(2), caps.get(3), caps.get(4)) {
        (Some(d), Some(m), _, _) | (_, _, Some(m), Some(d)) => (d.as_str(), m.as_str()),
        _ => return f64::NAN,
    };
    let Some(month) = MONTHS
        .iter()
        .position(|name| name.eq_ignore_ascii_case(month))
        .map(|at| at as i64 + 1)
    else {
        return f64::NAN;
    };
    let day: i64 = day.parse().unwrap_or(0);
    let year: i64 = caps[5].parse().unwrap_or(0);
    let get = |index: usize| {
        caps.get(index)
            .map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0))
    };
    let (hour, minute, second) = (get(6), get(7), get(8));
    if day < 1 || day > days_in_month(year, month) || hour > 23 || minute > 59 || second > 59 {
        return f64::NAN;
    }
    let local = (days_from_civil(year, month, day) * 86_400_000
        + hour * 3_600_000
        + minute * 60_000
        + second * 1000) as f64;
    let offset = match (caps.get(9), caps.get(10)) {
        (_, Some(offset)) => {
            let o = offset.as_str();
            let sign = if o.starts_with('-') { -1.0 } else { 1.0 };
            let hours: f64 = o[1..3].parse().unwrap_or(0.0);
            let minutes: f64 = o[3..5].parse().unwrap_or(0.0);
            sign * (hours * 3_600_000.0 + minutes * 60_000.0)
        }
        (Some(_), None) => 0.0,
        (None, None) => local_offset_ms(local),
    };
    local - offset
}

/// The local time zone's offset (ms) at a local wall time given as ms.
fn local_offset_ms(local_ms: f64) -> f64 {
    let Ok(tz) = jiff::tz::TimeZone::try_system() else {
        return 0.0;
    };
    let Ok(guess) = jiff::Timestamp::from_millisecond(local_ms as i64) else {
        return 0.0;
    };
    // The offset at the wall time read as UTC, then once more at the
    // instant it gives, as engines resolve it.
    let first = tz.to_offset(guess).seconds() as f64 * 1000.0;
    let Ok(instant) = jiff::Timestamp::from_millisecond((local_ms - first) as i64) else {
        return first;
    };
    tz.to_offset(instant).seconds() as f64 * 1000.0
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `new Date(ms).toISOString()`; None where JavaScript throws (an invalid
/// date).
pub fn try_iso(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    ))
}

/// `new Date(ms).toISOString()`, "Invalid Date" where it throws.
pub fn iso(ms: f64) -> String {
    try_iso(ms).unwrap_or_else(|| "Invalid Date".into())
}

/// Where [`now_ms`] reads the time: the system's unless set.
type NowSource = std::sync::Arc<dyn Fn() -> f64 + Send + Sync>;
static NOW_SOURCE: std::sync::RwLock<Option<NowSource>> = std::sync::RwLock::new(None);

/// Makes [`now_ms`] read `source` (a process following a test clock, as
/// Bun's `Date.now` does under one); None: the system's time again.
pub fn set_now_source(source: Option<NowSource>) {
    *NOW_SOURCE.write().unwrap_or_else(|e| e.into_inner()) = source;
}

/// The time now, ms since the epoch (`Date.now()`).
pub fn now_ms() -> f64 {
    if let Some(source) = NOW_SOURCE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return source();
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

// ---------------------------------------------------------------- collation

/// `a.localeCompare(b)`: ICU's root collation, as Bun's.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{Collator, CollatorBorrowed};
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(Default::default(), CollatorOptions::default())
            .expect("ICU's root collation is compiled in")
    });
    COLLATOR.compare(a, b)
}

// ---------------------------------------------------------------- objects

/// Builds an object, leaving out the `None`s (`undefined` is no property).
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = $crate::js::Obj::new();
        $( $crate::js::put(&mut map, $key, $value); )*
        map
    }};
}

/// A value an object may hold, or not (`undefined`).
pub trait IntoProp {
    fn into_prop(self) -> Option<Value>;
}

impl IntoProp for Value {
    fn into_prop(self) -> Option<Value> {
        Some(self)
    }
}
impl IntoProp for Option<Value> {
    fn into_prop(self) -> Option<Value> {
        self
    }
}
impl IntoProp for Obj {
    fn into_prop(self) -> Option<Value> {
        Some(Value::Object(self))
    }
}
impl IntoProp for Option<Obj> {
    fn into_prop(self) -> Option<Value> {
        self.map(Value::Object)
    }
}
impl IntoProp for &str {
    fn into_prop(self) -> Option<Value> {
        Some(Value::String(self.to_owned()))
    }
}
impl IntoProp for String {
    fn into_prop(self) -> Option<Value> {
        Some(Value::String(self))
    }
}
impl IntoProp for Option<&str> {
    fn into_prop(self) -> Option<Value> {
        self.map(|s| Value::String(s.to_owned()))
    }
}
impl IntoProp for Option<String> {
    fn into_prop(self) -> Option<Value> {
        self.map(Value::String)
    }
}
impl IntoProp for bool {
    fn into_prop(self) -> Option<Value> {
        Some(Value::Bool(self))
    }
}
impl IntoProp for Option<bool> {
    fn into_prop(self) -> Option<Value> {
        self.map(Value::Bool)
    }
}
impl IntoProp for f64 {
    fn into_prop(self) -> Option<Value> {
        Some(number(self))
    }
}
impl IntoProp for Option<f64> {
    fn into_prop(self) -> Option<Value> {
        self.map(number)
    }
}
impl IntoProp for i64 {
    fn into_prop(self) -> Option<Value> {
        Some(int(self))
    }
}
impl IntoProp for Option<i64> {
    fn into_prop(self) -> Option<Value> {
        self.map(int)
    }
}
impl IntoProp for usize {
    fn into_prop(self) -> Option<Value> {
        Some(int(self as i64))
    }
}
impl IntoProp for Vec<Value> {
    fn into_prop(self) -> Option<Value> {
        Some(Value::Array(self))
    }
}
impl IntoProp for Option<Vec<Value>> {
    fn into_prop(self) -> Option<Value> {
        self.map(Value::Array)
    }
}

/// Sets `key` to `value`, or leaves it out for `undefined`.
pub fn put(map: &mut Obj, key: &str, value: impl IntoProp) {
    if let Some(value) = value.into_prop() {
        map.insert(key.to_owned(), value);
    }
}

/// `{ ...a, ...b }`.
pub fn spread(mut a: Obj, b: &Obj) -> Obj {
    for (key, value) in b {
        a.insert(key.clone(), value.clone());
    }
    a
}

/// `delete map[key]`, the others keeping their order.
pub fn delete(map: &mut Obj, key: &str) {
    map.shift_remove(key);
}

/// A truthy string, or None (`text || undefined`).
pub fn truthy(text: &str) -> Option<&str> {
    (!text.is_empty()).then_some(text)
}

/// `Object.keys(value).length`.
pub fn key_count(value: &Obj) -> usize {
    value.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stringifies_as_javascript() {
        let value = parse(r#"{"b":1.0,"a":[1.5,"x\u0001\n"],"2":null,"e":1e21}"#).unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"2":null,"b":1,"a":[1.5,"x\u0001\n"],"e":1e+21}"#
        );
        assert_eq!(
            stringify_pretty(&json!({"a": [], "b": {}, "c": [1]})),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1\n  ]\n}"
        );
    }

    #[test]
    fn dates_as_javascript() {
        assert_eq!(date_parse("2026-01-02T03:04:05.678Z"), 1_767_323_045_678.0);
        assert_eq!(
            date_parse("2026-01-02T03:04:05.6789+01:00"),
            1_767_319_445_678.0
        );
        assert_eq!(date_parse("2026-01-02"), 1_767_312_000_000.0);
        assert!(date_parse("nope").is_nan());
        assert!(date_parse("").is_nan());
        assert_eq!(iso(1_767_323_045_678.0), "2026-01-02T03:04:05.678Z");
        assert_eq!(iso(-1.0), "1969-12-31T23:59:59.999Z");
        assert_eq!(try_iso(f64::NAN), None);
    }

    #[test]
    fn numbers_and_slices_as_javascript() {
        assert_eq!(number_from_text(" 12 "), 12.0);
        assert_eq!(number_from_text("0x10"), 16.0);
        assert!(number_from_text("inf").is_nan());
        assert_eq!(number_text(1e21), "1e+21");
        assert_eq!(number_text(0.1), "0.1");
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("a😀b", 0, Some(3)), "a😀");
        assert_eq!(slice16("abc", -2, None), "bc");
        assert_eq!(locale_compare("a", "B"), Ordering::Less);
        assert_eq!(locale_compare("b", "A"), Ordering::Greater);
    }
}

// ------------------------------------------------- the archive's readings

/// `text.length` (the archive's name for [`len16`]).
pub fn utf16_len(text: &str) -> usize {
    len16(text)
}

/// `text.slice(0, units)` borrowed: a cut inside a surrogate pair keeps
/// the pair out.
pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut taken = 0;
    for (index, c) in text.char_indices() {
        taken += c.len_utf16();
        if taken > units {
            return &text[..index];
        }
    }
    text
}

/// `text.trim()` (the archive's name for [`trim`]).
pub fn js_trim(text: &str) -> &str {
    trim(text)
}

/// `toLowerCase()`.
pub fn js_lower(text: &str) -> String {
    text.to_lowercase()
}

/// `JSON.stringify` of a string (the archive's name for [`quote`]).
pub fn json_string(text: &str) -> String {
    quote(text)
}

/// Runs of 200 or more non-space UTF-16 units (`/\S{200,}/g`, no `u`
/// flag) replaced by one space each.
pub fn strip_long(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run: Option<(usize, usize)> = None;
    let flush = |out: &mut String, start: usize, end: usize, units: usize| {
        if units >= 200 {
            out.push(' ');
        } else {
            out.push_str(&text[start..end]);
        }
    };
    for (index, c) in text.char_indices() {
        if is_js_space(c) {
            if let Some((start, units)) = run.take() {
                flush(&mut out, start, index, units);
            }
            out.push(c);
        } else {
            let (start, units) = run.unwrap_or((index, 0));
            run = Some((start, units + c.len_utf16()));
        }
    }
    if let Some((start, units)) = run {
        flush(&mut out, start, text.len(), units);
    }
    out
}

/// The first `count` characters (code points) of `text`.
pub fn take_chars(text: &str, count: usize) -> &str {
    match text.char_indices().nth(count) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// `/\s+/g` replaced by `with`.
pub fn collapse_space(text: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push_str(with);
            }
            in_space = true;
        } else {
            in_space = false;
            out.push(c);
        }
    }
    out
}

/// A number as a JavaScript double: integral ones below 1e21 as integers.
pub fn js_number(value: &Number) -> Number {
    match number(value.as_f64().unwrap_or(0.0)) {
        Value::Number(number) => number,
        _ => value.clone(),
    }
}

/// Lone `\uD800`-`\uDFFF` escapes replaced by `\uFFFD`: `JSON.parse` keeps
/// a lone surrogate (written out as UTF-8 it is U+FFFD), serde refuses the
/// whole document.
fn replace_lone_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u16> { u16::from_str_radix(text.get(at..at + 4)?, 16).ok() };
    let mut out = String::with_capacity(text.len());
    let (mut index, mut last) = (0, 0);
    while index + 1 < bytes.len() {
        if bytes[index] != b'\\' {
            index += 1;
            continue;
        }
        let Some(unit) = (bytes[index + 1] == b'u').then(|| hex(index + 2)).flatten() else {
            index += 2;
            continue;
        };
        let paired = (0xd800..0xdc00).contains(&unit)
            && bytes.get(index + 6) == Some(&b'\\')
            && bytes.get(index + 7) == Some(&b'u')
            && hex(index + 8).is_some_and(|low| (0xdc00..0xe000).contains(&low));
        if paired {
            index += 12;
        } else if (0xd800..0xe000).contains(&unit) {
            out.push_str(&text[last..index]);
            out.push_str("\\ufffd");
            index += 6;
            last = index;
        } else {
            index += 6;
        }
    }
    out.push_str(&text[last..]);
    out
}

/// `JSON.parse(line.toString("utf8"))` of a JSONL line: invalid UTF-8 read
/// as U+FFFD, a lone surrogate escape as U+FFFD; None when it is not JSON.
pub fn parse_line(raw: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(raw);
    parse(&text).or_else(|| {
        text.contains("\\u")
            .then(|| parse(&replace_lone_surrogates(&text)))
            .flatten()
    })
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    #[test]
    fn long_runs_are_measured_in_utf16_units() {
        let ascii = "a".repeat(200);
        assert_eq!(strip_long(&format!("x {ascii} y")), "x   y");
        assert_eq!(strip_long(&"a".repeat(199)), "a".repeat(199));
        // 100 emoji are 200 UTF-16 units.
        let emoji = "\u{1f600}".repeat(100);
        assert_eq!(strip_long(&emoji), " ");
        assert_eq!(strip_long("a\u{a0}b"), "a\u{a0}b");
    }

    #[test]
    fn prefixes_and_lengths_follow_javascript() {
        assert_eq!(utf16_len("a\u{1f600}"), 3);
        assert_eq!(utf16_prefix("a\u{1f600}b", 2), "a");
        assert_eq!(utf16_prefix("a\u{1f600}b", 3), "a\u{1f600}");
        assert_eq!(take_chars("a\u{1f600}b", 2), "a\u{1f600}");
        assert_eq!(collapse_space("a \n\t b", " "), "a b");
    }

    #[test]
    fn lines_parse_as_json_parse_does() {
        assert_eq!(
            parse_line(b"{\"a\":1.0}"),
            Some(serde_json::json!({"a": 1}))
        );
        assert_eq!(
            parse_line(b"{\"t\":\"x\\ud83d\"}"),
            Some(serde_json::json!({"t": "x\u{fffd}"}))
        );
        assert_eq!(
            parse_line(b"{\"t\":\"\\ud83d\\ude00\"}"),
            Some(serde_json::json!({"t": "\u{1f600}"}))
        );
        assert_eq!(parse_line(b"not json"), None);
        assert_eq!(
            stringify(&serde_json::json!({"b": 2.0, "a": [0.5]})),
            "{\"b\":2,\"a\":[0.5]}"
        );
    }
}
