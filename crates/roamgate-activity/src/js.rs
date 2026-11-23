//! JSON as `JSON.parse` reads it and `JSON.stringify` writes it again:
//! what the Bun server hands on from a provider's output is a JavaScript
//! value, so numbers are doubles (`1.0` is `1`), and object keys are in
//! JavaScript's order (integer-like keys first).

use roamgate_base::json_store::js_key_order;
use serde_json::{Number, Value};

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

/// A parsed value as JavaScript holds it.
pub fn js_value(value: Value) -> Value {
    fn numbers(value: Value) -> Value {
        match value {
            Value::Number(number) => Value::Number(js_number(&number)),
            Value::Array(items) => Value::Array(items.into_iter().map(numbers).collect()),
            Value::Object(map) => {
                Value::Object(map.into_iter().map(|(k, v)| (k, numbers(v))).collect())
            }
            other => other,
        }
    }
    js_key_order(numbers(value))
}

/// A number as a double: integral ones written as integers, as JavaScript
/// prints them below 1e21.
fn js_number(number: &Number) -> Number {
    let Some(double) = number.as_f64() else {
        return number.clone();
    };
    if double.fract() == 0.0 && double.abs() < 1e21 {
        if double.abs() <= i64::MAX as f64 && double >= i64::MIN as f64 {
            return Number::from(double as i64);
        }
        if double >= 0.0 && double <= u64::MAX as f64 {
            return Number::from(double as u64);
        }
    }
    Number::from_f64(double).unwrap_or_else(|| number.clone())
}

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
