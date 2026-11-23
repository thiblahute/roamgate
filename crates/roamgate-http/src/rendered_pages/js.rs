//! What the TS gets from the JavaScript runtime, as the pages need it: its
//! regular expressions' `\s`, `encodeURIComponent`, `trim`, string lengths
//! in UTF-16 units, an object's key order and `JSON.stringify` of a string.

/// JavaScript's `\s`: its white space and line terminators.
const SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Whether `c` is in JavaScript's `\s`.
pub fn is_space(c: char) -> bool {
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

/// A pattern written with JavaScript's `\s` and `\S`, for the `regex`
/// crates (whose `\s` is Unicode's White_Space, without U+FEFF).
pub fn pattern(source: &str) -> String {
    let mut out = String::with_capacity(source.len() * 2);
    let mut chars = source.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let next = chars.next().unwrap_or('\\');
                match (next, in_class) {
                    ('s', false) => {
                        out.push('[');
                        out.push_str(SPACE);
                        out.push(']');
                    }
                    ('S', false) => {
                        out.push_str("[^");
                        out.push_str(SPACE);
                        out.push(']');
                    }
                    ('s', true) => out.push_str(SPACE),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// A `regex` of a JavaScript pattern.
pub fn regex(source: &str) -> regex::Regex {
    regex::Regex::new(&pattern(source)).expect("a valid pattern")
}

/// A `fancy_regex` (lookaround) of a JavaScript pattern.
pub fn fancy(source: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(&pattern(source)).expect("a valid pattern")
}

/// `String.prototype.trim`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_space)
}

/// `value.length`: UTF-16 code units.
pub fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, max)` in UTF-16 units (never splitting a character).
pub fn head(value: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, c) in value.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &value[..index];
        }
    }
    value
}

/// `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `JSON.stringify` of a string.
pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Whether a property key is an array index, which objects list first.
fn is_index(key: &str) -> bool {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    if key.len() > 1 && key.starts_with('0') {
        return false;
    }
    key.parse::<u64>().is_ok_and(|index| index < 4_294_967_295)
}

/// Entries in the order an object built from them lists its keys
/// (`Object.fromEntries`, `Object.entries`): array indices first, in
/// numeric order, then the others as inserted.
pub fn object_order<V>(entries: Vec<(String, V)>) -> Vec<(String, V)> {
    let (mut indices, others): (Vec<_>, Vec<_>) =
        entries.into_iter().partition(|(key, _)| is_index(key));
    indices.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indices.extend(others);
    indices
}

/// `JSON.stringify` of an object of strings, its keys in object order.
pub fn json_object(entries: &[(String, String)]) -> String {
    let ordered = object_order(entries.to_vec());
    let parts: Vec<String> = ordered
        .iter()
        .map(|(key, value)| format!("{}:{}", json_string(key), json_string(value)))
        .collect();
    format!("{{{}}}", parts.join(","))
}
