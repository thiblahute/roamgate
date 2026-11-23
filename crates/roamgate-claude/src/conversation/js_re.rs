//! JavaScript regular expressions as the TS drivers wrote them, read the
//! way JavaScript reads them: `\s` is JavaScript's whitespace (not
//! Unicode's White_Space), `\d` and `\w` are ASCII, `.` stops at every
//! line terminator. The pattern text stays the TS one.

/// JavaScript's `\s`, as the inside of a character class.
const SPACE: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

/// A JavaScript pattern in the regex crates' syntax.
pub fn translate(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() * 2);
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(next) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (next, in_class) {
                    ('s', false) => out.push_str(&format!("[{SPACE}]")),
                    ('s', true) => out.push_str(SPACE),
                    ('S', false) => out.push_str(&format!("[^{SPACE}]")),
                    ('d', false) => out.push_str("[0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('w', false) => out.push_str("[A-Za-z0-9_]"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('/', _) => out.push('/'),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                if chars.peek() == Some(&'^') {
                    out.push(chars.next().unwrap_or('^'));
                }
                // A `]` first is a literal in JavaScript too.
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '.' if !in_class => out.push_str(r"[^\n\r\u{2028}\u{2029}]"),
            _ => out.push(c),
        }
    }
    out
}

/// The pattern with the regex crate, flags as JavaScript's (`i`, `m`, `s`).
pub fn regex(pattern: &str, flags: &str) -> regex::Regex {
    regex::Regex::new(&with_flags(pattern, flags))
        .unwrap_or_else(|error| panic!("{pattern}: {error}"))
}

/// The pattern with fancy-regex (lookarounds), flags as JavaScript's.
pub fn fancy(pattern: &str, flags: &str) -> fancy_regex::Regex {
    fancy_regex::Regex::new(&with_flags(pattern, flags))
        .unwrap_or_else(|error| panic!("{pattern}: {error}"))
}

fn with_flags(pattern: &str, flags: &str) -> String {
    let mut prefix = String::new();
    for flag in flags.chars() {
        match flag {
            'i' => prefix.push('i'),
            // JavaScript's `^` and `$` see \r as a line end too.
            'm' => prefix.push_str("mR"),
            's' => prefix.push('s'),
            _ => {}
        }
    }
    let body = translate(pattern);
    if prefix.is_empty() {
        body
    } else {
        format!("(?{prefix}){body}")
    }
}

/// JavaScript's `text.split(re)` for a pattern without capture groups.
pub fn split<'a>(re: &regex::Regex, text: &'a str) -> Vec<&'a str> {
    re.split(text).collect()
}

/// Escapes text for a pattern (`escapeRegExp`).
pub fn escape(text: &str) -> String {
    regex::escape(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_classes_as_javascript_does() {
        let re = regex(r"^\s*(\d+)\s+(.*)$", "");
        assert!(re.is_match(" 12 a"));
        assert!(!re.is_match(" 12 a\r"));
        assert!(!regex(r"\d", "").is_match("\u{0663}"));
        assert!(regex(r"[\s|]+$", "").is_match("x\u{feff}"));
        assert!(!regex(r"^\s$", "").is_match("\u{85}"));
    }
}
