//! JSON as `JSON.parse` reads it and `JSON.stringify` writes it again:
//! what the Bun server hands on from a provider's output is a JavaScript
//! value, so numbers are doubles (`1.0` is `1`), and object keys are in
//! JavaScript's order (integer-like keys first).

use serde_json::Value;

/// `text` trimmed and parsed, or None when it is empty or not JSON (or
/// parses to `null`).
pub fn parse_json(text: &str) -> Option<Value> {
    let trimmed = roamgate_base::settings::js_trim(text);
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    (!value.is_null()).then(|| js_value(value))
}

pub use roamgate_base::json::js_value;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_as_javascript_does() {
        assert_eq!(parse_json("  \n"), None);
        assert_eq!(parse_json("not json"), None);
        assert_eq!(parse_json("null"), None);
        assert_eq!(
            parse_json(" {\"b\":1.0,\"2\":true,\"a\":[2.50,9007199254740993]}\n"),
            Some(json!({"2": true, "b": 1, "a": [2.5, 9007199254740992_i64]}))
        );
        assert_eq!(
            serde_json::to_string(&parse_json("{\"b\":1,\"2\":0}").unwrap()).unwrap(),
            "{\"2\":0,\"b\":1}"
        );
    }
}
