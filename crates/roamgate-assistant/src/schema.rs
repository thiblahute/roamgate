//! `Value.Check` of TypeBox for the JSON Schemas of Ranger's tools, as
//! the tool catalog (`contract/tools/catalog.json`) holds them: the
//! keywords those schemas use, with TypeBox's reading of each (an object is
//! never an array, an integer is `Number.isInteger`, lengths are UTF-16
//! code units, a pattern is a JavaScript regular expression).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js;
use serde_json::Value;

/// The keywords [`check`] reads; a schema with any other is refused by
/// [`supported`].
pub const KEYWORDS: [&str; 17] = [
    "additionalProperties",
    "anyOf",
    "const",
    "default",
    "description",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "pattern",
    "properties",
    "required",
    "type",
];

/// Whether `schema` uses only [`KEYWORDS`], recursively.
pub fn supported(schema: &Value) -> bool {
    let Some(map) = schema.as_object() else {
        return false;
    };
    map.iter().all(|(key, value)| {
        KEYWORDS.contains(&key.as_str())
            && match key.as_str() {
                "properties" => value
                    .as_object()
                    .is_some_and(|props| props.values().all(supported)),
                "anyOf" => value
                    .as_array()
                    .is_some_and(|items| items.iter().all(supported)),
                "items" => supported(value),
                _ => true,
            }
    })
}

fn pattern(source: &str) -> Option<Regex> {
    static CACHE: LazyLock<Mutex<HashMap<String, Option<Regex>>>> = LazyLock::new(Mutex::default);
    CACHE
        .lock()
        .unwrap()
        .entry(source.to_owned())
        .or_insert_with(|| Regex::new(source).ok())
        .clone()
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// Whether `value` matches `schema`.
pub fn check(schema: &Value, value: &Value) -> bool {
    let Some(map) = schema.as_object() else {
        return false;
    };
    if let Some(any) = map.get("anyOf").and_then(Value::as_array)
        && !any.iter().any(|option| check(option, value))
    {
        return false;
    }
    if let Some(constant) = map.get("const")
        && constant != value
    {
        return false;
    }
    match map.get("type").and_then(Value::as_str) {
        None => true,
        Some("string") => {
            let Some(text) = value.as_str() else {
                return false;
            };
            let length = js::len16(text) as f64;
            map.get("minLength")
                .and_then(Value::as_f64)
                .is_none_or(|min| length >= min)
                && map
                    .get("maxLength")
                    .and_then(Value::as_f64)
                    .is_none_or(|max| length <= max)
                && map
                    .get("pattern")
                    .and_then(Value::as_str)
                    .is_none_or(|source| pattern(source).is_some_and(|re| re.is_match(text)))
        }
        Some(kind @ ("integer" | "number")) => {
            let Some(n) = number(value) else {
                return false;
            };
            (kind == "number" || n.fract() == 0.0)
                && map
                    .get("minimum")
                    .and_then(Value::as_f64)
                    .is_none_or(|min| n >= min)
                && map
                    .get("maximum")
                    .and_then(Value::as_f64)
                    .is_none_or(|max| n <= max)
        }
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        Some("array") => {
            let Some(items) = value.as_array() else {
                return false;
            };
            let length = items.len() as f64;
            map.get("minItems")
                .and_then(Value::as_f64)
                .is_none_or(|min| length >= min)
                && map
                    .get("maxItems")
                    .and_then(Value::as_f64)
                    .is_none_or(|max| length <= max)
                && map
                    .get("items")
                    .is_none_or(|item| items.iter().all(|entry| check(item, entry)))
        }
        Some("object") => {
            let Some(object) = value.as_object() else {
                return false;
            };
            let properties = map.get("properties").and_then(Value::as_object);
            let count = object.len() as f64;
            map.get("minProperties")
                .and_then(Value::as_f64)
                .is_none_or(|min| count >= min)
                && map
                    .get("required")
                    .and_then(Value::as_array)
                    .is_none_or(|required| {
                        required
                            .iter()
                            .all(|key| key.as_str().is_some_and(|key| object.contains_key(key)))
                    })
                && object.iter().all(|(key, entry)| {
                    match properties.and_then(|props| props.get(key)) {
                        Some(property) => check(property, entry),
                        None => map.get("additionalProperties") != Some(&Value::Bool(false)),
                    }
                })
        }
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn checks_what_typebox_checks() {
        let schema = json!({
            "type": "object", "required": ["a"], "minProperties": 1,
            "properties": {
                "a": {"type": "string", "minLength": 1, "maxLength": 3, "pattern": "^x"},
                "n": {"type": "integer", "minimum": 1, "maximum": 10, "default": 2},
                "k": {"anyOf": [{"type": "string", "const": "p"}, {"type": "string", "const": "q"}]},
                "t": {"type": "boolean", "const": true},
                "l": {"type": "array", "minItems": 1, "maxItems": 2, "items": {"type": "string"}}
            },
            "additionalProperties": false
        });
        assert!(supported(&schema));
        assert!(check(&schema, &json!({"a": "x"})));
        assert!(check(
            &schema,
            &json!({"a": "x\u{1F600}", "n": 10, "k": "q", "t": true, "l": ["a"]})
        ));
        for bad in [
            json!([]),
            json!(null),
            json!({}),
            json!({"a": ""}),
            json!({"a": "xyzw"}),
            json!({"a": "y"}),
            json!({"a": "x", "n": 1.5}),
            json!({"a": "x", "n": 0}),
            json!({"a": "x", "n": "1"}),
            json!({"a": "x", "k": "r"}),
            json!({"a": "x", "t": false}),
            json!({"a": "x", "l": []}),
            json!({"a": "x", "l": [1]}),
            json!({"a": "x", "extra": 1}),
        ] {
            assert!(!check(&schema, &bad), "{bad}");
        }
        assert!(!supported(&json!({"type": "object", "oneOf": []})));
    }
}
