//! What the clients' Python versions (contract/assets/python, still run on
//! SSH hosts) print and send, written the same way here: `json.dumps`,
//! `repr` of a string, `os.path.realpath` and the text of an `OSError`.

use std::fmt::Write as _;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// How `json.dumps` was called.
#[derive(Clone, Copy, Debug)]
pub struct Dumps {
    /// `indent=N`: one item per line.
    pub indent: Option<usize>,
    /// `separators=(",", ":")`: no spaces (ignored with an indent).
    pub compact: bool,
    /// `ensure_ascii` (Python's default): `\uXXXX` for all but printable ASCII.
    pub ensure_ascii: bool,
}

impl Dumps {
    /// `json.dumps(value)`.
    pub const DEFAULT: Dumps = Dumps {
        indent: None,
        compact: false,
        ensure_ascii: true,
    };
    /// `json.dumps(value, separators=(",", ":"))`.
    pub const COMPACT: Dumps = Dumps {
        indent: None,
        compact: true,
        ensure_ascii: true,
    };
}

/// `json.dumps(value)` as Python writes it.
pub fn dumps(value: &Value) -> String {
    dumps_with(value, Dumps::DEFAULT)
}

/// `json.dumps(value, ...)` with these arguments.
pub fn dumps_with(value: &Value, style: Dumps) -> String {
    let mut out = String::new();
    write_value(&mut out, value, style, 0);
    out
}

fn write_value(out: &mut String, value: &Value, style: Dumps, level: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                let _ = write!(out, "{int}");
            } else if let Some(int) = number.as_u64() {
                let _ = write!(out, "{int}");
            } else {
                out.push_str(&float_repr(number.as_f64().unwrap_or(f64::NAN)));
            }
        }
        Value::String(text) => write_string(out, text, style.ensure_ascii),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                separate(out, index, style, level + 1);
                write_value(out, item, style, level + 1);
            }
            close(out, style, level);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                separate(out, index, style, level + 1);
                write_string(out, key, style.ensure_ascii);
                out.push_str(if style.compact && style.indent.is_none() {
                    ":"
                } else {
                    ": "
                });
                write_value(out, item, style, level + 1);
            }
            close(out, style, level);
            out.push('}');
        }
    }
}

fn separate(out: &mut String, index: usize, style: Dumps, level: usize) {
    match style.indent {
        Some(indent) => {
            if index > 0 {
                out.push(',');
            }
            out.push('\n');
            out.push_str(&" ".repeat(indent * level));
        }
        None if index > 0 => out.push_str(if style.compact { "," } else { ", " }),
        None => {}
    }
}

fn close(out: &mut String, style: Dumps, level: usize) {
    if let Some(indent) = style.indent {
        out.push('\n');
        out.push_str(&" ".repeat(indent * level));
    }
}

fn write_string(out: &mut String, text: &str, ensure_ascii: bool) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(ch),
            _ if (ch as u32) < 0x20 || ensure_ascii => {
                let mut units = [0u16; 2];
                for unit in ch.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
            _ => out.push(ch),
        }
    }
    out.push('"');
}

/// `repr(float)`: the shortest digits, positional from 1e-4 to 1e16.
pub fn float_repr(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    // Rust's shortest round-trip digits, as d.ddde<exp>.
    let exp_form = format!("{value:e}");
    let (mantissa, exponent) = exp_form.split_once('e').unwrap_or((&exp_form, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let sign = if negative { "-" } else { "" };
    if (-4..16).contains(&exponent) {
        let point = exponent + 1;
        let text = if point <= 0 {
            format!("0.{}{digits}", "0".repeat((-point) as usize))
        } else if point as usize >= digits.len() {
            format!("{digits}{}.0", "0".repeat(point as usize - digits.len()))
        } else {
            format!(
                "{}.{}",
                &digits[..point as usize],
                &digits[point as usize..]
            )
        };
        return format!("{sign}{text}");
    }
    let mut mantissa = digits[..1].to_owned();
    if digits.len() > 1 {
        mantissa.push('.');
        mantissa.push_str(&digits[1..]);
    }
    let exp_sign = if exponent < 0 { '-' } else { '+' };
    format!("{sign}{mantissa}e{exp_sign}{:02}", exponent.abs())
}

/// `repr(text)` of a Python string.
pub fn repr_str(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::new();
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c if (0x80..0xa0).contains(&(c as u32)) => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// The user's home: `os.path.expanduser("~")`.
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `os.path.expanduser`: a leading `~` (only the current user's).
pub fn expanduser(value: &str) -> String {
    if value == "~" {
        return home().to_string_lossy().into_owned();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        let home = home().to_string_lossy().trim_end_matches('/').to_owned();
        return format!("{home}/{rest}");
    }
    value.to_owned()
}

/// `os.path.realpath`: absolute, with every link that exists resolved and
/// what does not exist kept as written.
pub fn realpath(value: &str) -> String {
    let path = Path::new(value);
    let start = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    let mut resolved = start;
    let mut existing = true;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => resolved = PathBuf::from(prefix.as_os_str()),
            Component::RootDir => resolved.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => {
                resolved.push(name);
                if existing {
                    match std::fs::canonicalize(&resolved) {
                        Ok(real) => resolved = without_verbatim(real),
                        Err(_) => existing = false,
                    }
                }
            }
        }
    }
    if resolved.as_os_str().is_empty() {
        resolved.push("/");
    }
    resolved.to_string_lossy().into_owned()
}

/// Windows' canonical paths are verbatim (`\\?\C:\...`); Python's are not.
fn without_verbatim(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && rest.as_bytes().get(1) == Some(&b':')
        {
            return PathBuf::from(rest);
        }
    }
    path
}

/// `os.path.realpath(os.getcwd())`.
pub fn real_cwd() -> String {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    realpath(&cwd.to_string_lossy())
}

/// `str(error)` of the `OSError` Python raises for this one:
/// `[Errno 111] Connection refused`, or `timed out` for a socket timeout.
pub fn os_error_text(error: &io::Error) -> String {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        return "timed out".into();
    }
    match error.raw_os_error() {
        Some(code) => {
            let text = error.to_string();
            let suffix = format!(" (os error {code})");
            let message = text.strip_suffix(&suffix).unwrap_or(&text);
            // Python names a Windows error WinError, its text without the
            // final dot.
            if cfg!(windows) {
                format!("[WinError {code}] {}", message.trim_end_matches(['.', ' ']))
            } else {
                format!("[Errno {code}] {message}")
            }
        }
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_as_python() {
        assert_eq!(
            dumps(&json!({"error": "caf\u{e9} \u{1f600}", "n": [1, 2.5], "e": {}})),
            "{\"error\": \"caf\\u00e9 \\ud83d\\ude00\", \"n\": [1, 2.5], \"e\": {}}"
        );
        assert_eq!(
            dumps_with(&json!({"a": [1, {"b": null}], "c": []}), Dumps::COMPACT),
            r#"{"a":[1,{"b":null}],"c":[]}"#
        );
        assert_eq!(
            dumps_with(
                &json!({"a": [1, {"b": "\u{e9}"}], "c": {}}),
                Dumps {
                    indent: Some(2),
                    compact: false,
                    ensure_ascii: false
                }
            ),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"\u{e9}\"\n    }\n  ],\n  \"c\": {}\n}"
        );
    }

    #[test]
    fn floats_as_python_repr() {
        assert_eq!(float_repr(2.5), "2.5");
        assert_eq!(float_repr(123.0), "123.0");
        assert_eq!(float_repr(0.0001), "0.0001");
        assert_eq!(float_repr(0.00001), "1e-05");
        assert_eq!(float_repr(1e16), "1e+16");
        assert_eq!(float_repr(1.5e300), "1.5e+300");
        assert_eq!(float_repr(-0.5), "-0.5");
    }

    #[test]
    fn repr_as_python() {
        assert_eq!(repr_str("bogus"), "'bogus'");
        assert_eq!(repr_str("it's"), "\"it's\"");
        assert_eq!(repr_str("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(repr_str("x\ny"), "'x\\ny'");
    }

    #[test]
    fn realpath_keeps_what_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let real = without_verbatim(std::fs::canonicalize(dir.path()).unwrap());
        let text = format!("{}/missing/../x/./y", dir.path().display());
        assert_eq!(
            realpath(&text),
            real.join("x").join("y").display().to_string()
        );
    }

    #[test]
    fn errors_read_as_python_s() {
        assert_eq!(
            os_error_text(&io::Error::from_raw_os_error(2)),
            if cfg!(windows) {
                "[WinError 2] The system cannot find the file specified"
            } else {
                "[Errno 2] No such file or directory"
            }
        );
        assert_eq!(
            os_error_text(&io::Error::from(io::ErrorKind::TimedOut)),
            "timed out"
        );
    }
}
