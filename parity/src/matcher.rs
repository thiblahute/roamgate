//! Comparing what a server gave with what a scenario expects.
//!
//! An expected value matches when:
//! - an object: each of its keys matches the actual one (other actual keys
//!   are allowed), unless it has `"$exact": true`; a key whose expected
//!   value is `{{absent}}` must be missing;
//! - an array: same length, element by element; `{"$contains": [...]}`
//!   wants each listed value somewhere in it, in order; `{"$len": n}`
//!   wants that length; `{"$unordered": [...]}` the same elements in any
//!   order;
//! - a string placeholder: `{{any}}`, `{{present}}`, `{{string}}`,
//!   `{{number}}`, `{{integer}}`, `{{bool}}`, `{{object}}`, `{{array}}`,
//!   `{{null}}`, `{{time}}` (an ISO 8601 time), `{{uuid}}`,
//!   `{{re:<regex>}}` (a string matching it), `{{contains:<text>}}`,
//!   `{{len:<n>}}` (a string of n characters);
//! - anything else: equal.

use regex::Regex;
use serde_json::Value;

fn iso_time() -> Regex {
    Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$")
        .expect("regex")
}

fn uuid() -> Regex {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").expect("regex")
}

fn placeholder(pattern: &str, actual: Option<&Value>) -> Option<Result<(), String>> {
    let inner = pattern.strip_prefix("{{")?.strip_suffix("}}")?;
    let fail = |what: &str| Err(format!("expected {what}, got {}", show(actual)));
    let ok = |condition: bool, what: &str| if condition { Ok(()) } else { fail(what) };
    Some(match (inner, actual) {
        ("absent", None) => Ok(()),
        ("absent", Some(_)) => fail("no value"),
        (_, None) => fail(pattern),
        ("any" | "present", Some(_)) => Ok(()),
        ("string", Some(value)) => ok(value.is_string(), "a string"),
        ("number", Some(value)) => ok(value.is_number(), "a number"),
        ("integer", Some(value)) => ok(value.is_i64() || value.is_u64(), "an integer"),
        ("bool", Some(value)) => ok(value.is_boolean(), "a boolean"),
        ("object", Some(value)) => ok(value.is_object(), "an object"),
        ("array", Some(value)) => ok(value.is_array(), "an array"),
        ("null", Some(value)) => ok(value.is_null(), "null"),
        ("time", Some(value)) => ok(
            value
                .as_str()
                .is_some_and(|text| text == "{{time}}" || iso_time().is_match(text)),
            "an ISO time",
        ),
        ("uuid", Some(value)) => ok(
            value
                .as_str()
                .is_some_and(|text| text == "{{uuid}}" || uuid().is_match(text)),
            "a UUID",
        ),
        (other, Some(value)) => {
            if let Some(regex) = other.strip_prefix("re:") {
                match Regex::new(regex) {
                    Ok(regex) => ok(
                        value.as_str().is_some_and(|text| regex.is_match(text)),
                        &format!("a string matching /{}/", regex.as_str()),
                    ),
                    Err(error) => Err(format!("bad regex {regex}: {error}")),
                }
            } else if let Some(length) = other
                .strip_prefix("len:")
                .and_then(|length| length.parse::<usize>().ok())
            {
                ok(
                    value
                        .as_str()
                        .is_some_and(|actual| actual.chars().count() == length),
                    &format!("a string of {length} characters"),
                )
            } else {
                let text = other.strip_prefix("contains:")?;
                ok(
                    value.as_str().is_some_and(|actual| actual.contains(text)),
                    &format!("a string containing {text:?}"),
                )
            }
        }
    })
}

fn show(value: Option<&Value>) -> String {
    match value {
        None => "nothing".into(),
        Some(value) => {
            let text = value.to_string();
            if text.len() > 400 {
                format!(
                    "{}...",
                    &text[..text
                        .char_indices()
                        .nth(400)
                        .map_or(text.len(), |(index, _)| index)]
                )
            } else {
                text
            }
        }
    }
}

/// Ok, or the first difference with its JSON path.
pub fn check(expected: &Value, actual: Option<&Value>) -> Result<(), String> {
    check_at(expected, actual, "")
}

fn check_at(expected: &Value, actual: Option<&Value>, path: &str) -> Result<(), String> {
    let here = |message: String| format!("{}: {message}", if path.is_empty() { "/" } else { path });
    match expected {
        Value::String(text) => {
            if let Some(result) = placeholder(text, actual) {
                return result.map_err(here);
            }
            if actual == Some(expected) {
                Ok(())
            } else {
                Err(here(format!(
                    "expected {}, got {}",
                    show(Some(expected)),
                    show(actual)
                )))
            }
        }
        Value::Object(map) => {
            if let Some(items) = map.get("$contains") {
                let Some(Value::Array(actual)) = actual else {
                    return Err(here(format!("expected an array, got {}", show(actual))));
                };
                let mut from = 0;
                for (index, item) in items.as_array().into_iter().flatten().enumerate() {
                    let found = actual[from..]
                        .iter()
                        .position(|candidate| check_at(item, Some(candidate), path).is_ok());
                    match found {
                        Some(at) => from += at + 1,
                        None => {
                            return Err(here(format!(
                                "$contains[{index}] {} not found (in order) in {}",
                                show(Some(item)),
                                show(Some(&Value::Array(actual.clone())))
                            )));
                        }
                    }
                }
                return Ok(());
            }
            if let Some(items) = map.get("$unordered") {
                let Some(Value::Array(actual)) = actual else {
                    return Err(here(format!("expected an array, got {}", show(actual))));
                };
                let items = items.as_array().cloned().unwrap_or_default();
                if items.len() != actual.len() {
                    return Err(here(format!(
                        "expected {} elements, got {}",
                        items.len(),
                        actual.len()
                    )));
                }
                let mut left: Vec<&Value> = actual.iter().collect();
                for item in &items {
                    let Some(at) = left
                        .iter()
                        .position(|candidate| check_at(item, Some(candidate), path).is_ok())
                    else {
                        return Err(here(format!("no element matches {}", show(Some(item)))));
                    };
                    left.remove(at);
                }
                return Ok(());
            }
            // `$lacks`: no element matches any of these.
            if let Some(items) = map.get("$lacks") {
                let Some(Value::Array(actual)) = actual else {
                    return Err(here(format!("expected an array, got {}", show(actual))));
                };
                for item in items.as_array().into_iter().flatten() {
                    if let Some(found) = actual
                        .iter()
                        .find(|candidate| check_at(item, Some(candidate), path).is_ok())
                    {
                        return Err(here(format!("unexpected element {}", show(Some(found)))));
                    }
                }
                return Ok(());
            }
            if let Some(length) = map.get("$len").and_then(Value::as_u64) {
                let Some(Value::Array(actual)) = actual else {
                    return Err(here(format!("expected an array, got {}", show(actual))));
                };
                return if actual.len() as u64 == length {
                    Ok(())
                } else {
                    Err(here(format!(
                        "expected {length} elements, got {}",
                        actual.len()
                    )))
                };
            }
            let Some(Value::Object(actual)) = actual else {
                return Err(here(format!("expected an object, got {}", show(actual))));
            };
            let exact = map.get("$exact") == Some(&Value::Bool(true));
            for (key, value) in map {
                if key == "$exact" {
                    continue;
                }
                check_at(value, actual.get(key), &format!("{path}/{key}"))?;
            }
            if exact && let Some(extra) = actual.keys().find(|key| !map.contains_key(*key)) {
                return Err(here(format!("unexpected key {extra}")));
            }
            Ok(())
        }
        Value::Array(items) => {
            let Some(Value::Array(actual)) = actual else {
                return Err(here(format!("expected an array, got {}", show(actual))));
            };
            if items.len() != actual.len() {
                return Err(here(format!(
                    "expected {} elements, got {}: {}",
                    items.len(),
                    actual.len(),
                    show(Some(&Value::Array(actual.clone())))
                )));
            }
            for (index, (item, value)) in items.iter().zip(actual).enumerate() {
                check_at(item, Some(value), &format!("{path}/{index}"))?;
            }
            Ok(())
        }
        _ => {
            if actual == Some(expected) {
                Ok(())
            } else {
                Err(here(format!(
                    "expected {}, got {}",
                    show(Some(expected)),
                    show(actual)
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subsets_and_placeholders() {
        assert!(check(&json!({"a": 1}), Some(&json!({"a": 1, "b": 2}))).is_ok());
        assert!(
            check(
                &json!({"a": 1, "$exact": true}),
                Some(&json!({"a": 1, "b": 2}))
            )
            .is_err()
        );
        assert!(check(&json!({"b": "{{absent}}"}), Some(&json!({"a": 1}))).is_ok());
        assert!(
            check(
                &json!({"t": "{{time}}"}),
                Some(&json!({"t": "2026-01-01T00:00:00.000Z"}))
            )
            .is_ok()
        );
        assert!(check(&json!("{{re:^ab}}"), Some(&json!("abc"))).is_ok());
        assert!(check(&json!({"$contains": [2, 4]}), Some(&json!([1, 2, 3, 4]))).is_ok());
        assert!(check(&json!({"$contains": [4, 2]}), Some(&json!([1, 2, 3, 4]))).is_err());
        assert!(check(&json!({"$unordered": [2, 1]}), Some(&json!([1, 2]))).is_ok());
        let error = check(
            &json!({"a": {"b": [1, 3]}}),
            Some(&json!({"a": {"b": [1, 2]}})),
        )
        .unwrap_err();
        assert!(error.starts_with("/a/b/1:"), "{error}");
    }
}
