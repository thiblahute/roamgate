//! A tool's parameters checked against its input schema as the TS server
//! checks them (typebox 1.x `Value.Check`, then the first of
//! `Value.Errors`): the same keywords in the same order, the same messages
//! (typebox's en_US locale) and instance paths, so a refusal reads the same
//! whichever side answers. Only the keywords the catalog's schemas use are
//! known (`parity`'s tool-params vectors pin each against typebox); any
//! other keyword is ignored, as an annotation is.

use serde_json::{Map, Value};

/// A failed check: where (a JSON pointer, `""` for the value itself) and
/// what, in typebox's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaError {
    pub instance_path: String,
    pub message: String,
}

impl SchemaError {
    /// As the tools say it: `/path message`, `/` for the value itself.
    pub fn describe(&self) -> String {
        let path = if self.instance_path.is_empty() {
            "/"
        } else {
            &self.instance_path
        };
        format!("{path} {}", self.message)
    }
}

/// Every error typebox finds, in its order (the first is what the tools say).
pub fn errors(schema: &Value, value: &Value) -> Vec<SchemaError> {
    let mut out = Vec::new();
    check(schema, value, "", &mut out);
    out
}

/// The first error, or none when `value` passes.
pub fn first_error(schema: &Value, value: &Value) -> Option<SchemaError> {
    errors(schema, value).into_iter().next()
}

/// A JSON pointer fragment (`~` and `/` escaped).
fn fragment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// A JS number as JS writes it: no `.0` on a whole one.
fn js_number(value: &Value) -> String {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                int.to_string()
            } else if let Some(int) = number.as_u64() {
                int.to_string()
            } else {
                let float = number.as_f64().unwrap_or(0.0);
                if float.fract() == 0.0 && float.abs() < 1e21 {
                    format!("{float:.0}")
                } else {
                    float.to_string()
                }
            }
        }
        other => other.to_string(),
    }
}

/// `Number.isInteger`.
fn is_integer(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            number.is_i64()
                || number.is_u64()
                || number
                    .as_f64()
                    .is_some_and(|float| float.is_finite() && float.fract() == 0.0)
        }
        _ => false,
    }
}

fn type_is(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "boolean" => value.is_boolean(),
        "integer" => is_integer(value),
        "number" => value.is_number(),
        "null" => value.is_null(),
        "string" => value.is_string(),
        _ => true,
    }
}

/// Deep equality as typebox's `IsDeepEqual` (numbers by value).
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, a)| y.get(key).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}

/// A string's length in code points, as typebox counts it.
fn code_points(text: &str) -> usize {
    text.chars().count()
}

fn limit(schema: &Map<String, Value>, keyword: &str) -> Option<f64> {
    schema.get(keyword).and_then(Value::as_f64)
}

fn push(out: &mut Vec<SchemaError>, path: &str, message: String) -> bool {
    out.push(SchemaError {
        instance_path: path.to_owned(),
        message,
    });
    false
}

/// typebox's ErrorSchema: every keyword checked (no short cut), each group
/// only for values of its kind, errors in this order.
fn check(schema: &Value, value: &Value, path: &str, out: &mut Vec<SchemaError>) -> bool {
    let schema = match schema {
        Value::Bool(true) => return true,
        Value::Bool(false) => return push(out, path, "schema is false".into()),
        Value::Object(schema) => schema,
        // Not a schema: nothing to check.
        _ => return true,
    };
    let mut ok = true;
    if let Some(kind) = schema.get("type") {
        let passes = match kind {
            Value::String(name) => type_is(name, value),
            Value::Array(names) => names
                .iter()
                .any(|name| name.as_str().is_none_or(|name| type_is(name, value))),
            _ => true,
        };
        if !passes {
            let message = match kind {
                Value::String(name) => format!("must be {name}"),
                Value::Array(names) => format!(
                    "must be either {}",
                    names
                        .iter()
                        .map(|name| name.as_str().unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join(" or ")
                ),
                _ => String::new(),
            };
            ok &= push(out, path, message);
        }
    }
    if let Value::Object(object) = value {
        ok &= check_object(schema, object, path, out);
    }
    if let Value::Array(items) = value {
        ok &= check_array(schema, items, path, out);
    }
    if let Value::String(text) = value {
        ok &= check_string(schema, text, path, out);
    }
    if value.is_number() {
        let number = value.as_f64().unwrap_or(0.0);
        if let Some(min) = limit(schema, "exclusiveMinimum")
            && number <= min
        {
            ok &= push(
                out,
                path,
                format!("must be > {}", js_number(&schema["exclusiveMinimum"])),
            );
        }
        if let Some(max) = limit(schema, "exclusiveMaximum")
            && number >= max
        {
            ok &= push(
                out,
                path,
                format!("must be < {}", js_number(&schema["exclusiveMaximum"])),
            );
        }
        if let Some(min) = limit(schema, "minimum")
            && number < min
        {
            ok &= push(
                out,
                path,
                format!("must be >= {}", js_number(&schema["minimum"])),
            );
        }
        if let Some(max) = limit(schema, "maximum")
            && number > max
        {
            ok &= push(
                out,
                path,
                format!("must be <= {}", js_number(&schema["maximum"])),
            );
        }
        if let Some(step) = limit(schema, "multipleOf")
            && step != 0.0
            && (number / step).fract() != 0.0
        {
            ok &= push(
                out,
                path,
                format!("must be multiple of {}", js_number(&schema["multipleOf"])),
            );
        }
    }
    if let Some(constant) = schema.get("const")
        && !json_equal(constant, value)
    {
        ok &= push(out, path, "must be equal to constant".into());
    }
    if let Some(Value::Array(options)) = schema.get("enum")
        && !options.iter().any(|option| json_equal(option, value))
    {
        ok &= push(
            out,
            path,
            "must be equal to one of the allowed values".into(),
        );
    }
    if let Some(Value::Array(all)) = schema.get("allOf") {
        for each in all {
            ok &= check(each, value, path, out);
        }
    }
    if let Some(Value::Array(any)) = schema.get("anyOf") {
        let mut failed = Vec::new();
        let mut passed = false;
        for each in any {
            let mut branch = Vec::new();
            if check(each, value, path, &mut branch) {
                passed = true;
            } else {
                failed.push(branch);
            }
        }
        if !passed {
            for branch in failed {
                out.extend(branch);
            }
            ok &= push(out, path, "must match a schema in anyOf".into());
        }
    }
    ok
}

fn check_object(
    schema: &Map<String, Value>,
    object: &Map<String, Value>,
    path: &str,
    out: &mut Vec<SchemaError>,
) -> bool {
    let mut ok = true;
    if let Some(Value::Array(required)) = schema.get("required") {
        let missing: Vec<&str> = required
            .iter()
            .filter_map(Value::as_str)
            .filter(|key| !object.contains_key(*key))
            .collect();
        if !missing.is_empty() {
            ok &= push(
                out,
                path,
                format!("must have required properties {}", missing.join(", ")),
            );
        }
    }
    let properties = schema.get("properties").and_then(Value::as_object);
    if let Some(additional) = schema.get("additionalProperties") {
        let mut extra = false;
        for (key, each) in object {
            if properties.is_some_and(|known| known.contains_key(key)) {
                continue;
            }
            let child = format!("{path}/{}", fragment(key));
            if !check(additional, each, &child, out) {
                extra = true;
            }
        }
        if extra {
            ok &= push(out, path, "must not have additional properties".into());
        }
    }
    if let Some(properties) = properties {
        for (key, property) in properties {
            if let Some(each) = object.get(key) {
                let child = format!("{path}/{}", fragment(key));
                ok &= check(property, each, &child, out);
            }
        }
    }
    if let Some(min) = limit(schema, "minProperties")
        && (object.len() as f64) < min
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have fewer than {} properties",
                js_number(&schema["minProperties"])
            ),
        );
    }
    if let Some(max) = limit(schema, "maxProperties")
        && (object.len() as f64) > max
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have more than {} properties",
                js_number(&schema["maxProperties"])
            ),
        );
    }
    ok
}

fn check_array(
    schema: &Map<String, Value>,
    items: &[Value],
    path: &str,
    out: &mut Vec<SchemaError>,
) -> bool {
    let mut ok = true;
    match schema.get("items") {
        Some(Value::Array(sized)) => {
            for (index, each) in sized.iter().enumerate() {
                if let Some(item) = items.get(index) {
                    ok &= check(each, item, &format!("{path}/{index}"), out);
                }
            }
        }
        Some(each) => {
            for (index, item) in items.iter().enumerate() {
                ok &= check(each, item, &format!("{path}/{index}"), out);
            }
        }
        None => {}
    }
    if let Some(min) = limit(schema, "minItems")
        && (items.len() as f64) < min
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have fewer than {} items",
                js_number(&schema["minItems"])
            ),
        );
    }
    if let Some(max) = limit(schema, "maxItems")
        && (items.len() as f64) > max
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have more than {} items",
                js_number(&schema["maxItems"])
            ),
        );
    }
    if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
        let repeated = items
            .iter()
            .enumerate()
            .any(|(at, a)| items[..at].iter().any(|b| json_equal(a, b)));
        if repeated {
            ok &= push(out, path, "must not have duplicate items".into());
        }
    }
    ok
}

fn check_string(
    schema: &Map<String, Value>,
    text: &str,
    path: &str,
    out: &mut Vec<SchemaError>,
) -> bool {
    let mut ok = true;
    let length = code_points(text) as f64;
    if let Some(min) = limit(schema, "minLength")
        && length < min
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have fewer than {} characters",
                js_number(&schema["minLength"])
            ),
        );
    }
    if let Some(max) = limit(schema, "maxLength")
        && length > max
    {
        ok &= push(
            out,
            path,
            format!(
                "must not have more than {} characters",
                js_number(&schema["maxLength"])
            ),
        );
    }
    if let Some(Value::String(pattern)) = schema.get("pattern") {
        let matches = regex::Regex::new(pattern)
            .map(|regex| regex.is_match(text))
            .unwrap_or(true);
        if !matches {
            ok &= push(out, path, format!("must match pattern \"{pattern}\""));
        }
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_keywords_in_typebox_order() {
        let schema = json!({
            "type": "object",
            "required": ["a"],
            "properties": {"a": {"type": "string", "maxLength": 2}},
            "additionalProperties": false
        });
        let found = errors(&schema, &json!({"b": 1}));
        assert_eq!(
            found.iter().map(SchemaError::describe).collect::<Vec<_>>(),
            vec![
                "/ must have required properties a",
                "/b schema is false",
                "/ must not have additional properties"
            ]
        );
        assert_eq!(
            first_error(&schema, &json!({"a": "abc"}))
                .unwrap()
                .describe(),
            "/a must not have more than 2 characters"
        );
        assert_eq!(
            first_error(&schema, &json!([1])).unwrap().describe(),
            "/ must be object"
        );
        assert!(first_error(&schema, &json!({"a": "ab"})).is_none());
    }

    #[test]
    fn unions_say_their_first_branch_first() {
        let schema = json!({"anyOf": [{"type": "string", "maxLength": 1}, {"type": "null"}]});
        let found = errors(&schema, &json!(3));
        assert_eq!(found[0].describe(), "/ must be string");
        assert_eq!(
            found.last().unwrap().describe(),
            "/ must match a schema in anyOf"
        );
        assert!(first_error(&schema, &json!(null)).is_none());
    }

    #[test]
    fn lengths_count_code_points_and_numbers_print_as_js_does() {
        let schema = json!({"type": "string", "maxLength": 1});
        assert!(first_error(&schema, &json!("\u{1F600}")).is_none());
        let schema = json!({"type": "integer", "minimum": 1});
        assert_eq!(
            first_error(&schema, &json!(0)).unwrap().message,
            "must be >= 1"
        );
        assert!(first_error(&schema, &json!(2.0)).is_none());
        assert_eq!(
            first_error(&schema, &json!(1.5)).unwrap().message,
            "must be integer"
        );
    }
}
