//! JSON parameter helpers over `serde_json::Value`: the `isRecord` and
//! coercion helpers re-declared across work, notifications, limit-resume,
//! claude-mod and agent (plan section 7 item 6).

use serde_json::{Map, Value};

use crate::error::UserError;

/// The object, when `value` is a plain object (not an array, not null).
pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// Whether `value` is a plain object (`isRecord`).
pub fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// Whether a parameter was given: not absent, null or the empty string.
pub fn given(value: Option<&Value>) -> bool {
    !matches!(value, None | Some(Value::Null)) && value.and_then(Value::as_str) != Some("")
}

/// Reads the parameters of a call by name, with user errors naming what is
/// wrong.
#[derive(Debug, Clone, Copy)]
pub struct Params<'a> {
    object: Option<&'a Map<String, Value>>,
}

impl<'a> Params<'a> {
    /// The parameters of `value`; anything but an object has none.
    pub fn of(value: &'a Value) -> Self {
        Self {
            object: value.as_object(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&'a Value> {
        self.object?.get(name)
    }

    /// A string, absent when missing, null or not a string.
    pub fn opt_str(&self, name: &str) -> Option<&'a str> {
        self.get(name)?.as_str()
    }

    /// A non-empty string after trimming, absent otherwise.
    pub fn opt_text(&self, name: &str) -> Option<&'a str> {
        self.opt_str(name)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    /// A required non-empty string.
    pub fn text(&self, name: &str) -> Result<&'a str, UserError> {
        self.opt_text(name)
            .ok_or_else(|| UserError::new(format!("{name} is required")))
    }

    /// A finite number, absent when missing or not a number.
    pub fn opt_f64(&self, name: &str) -> Option<f64> {
        self.get(name)?.as_f64().filter(|number| number.is_finite())
    }

    /// A whole number, absent when missing, fractional or not a number.
    pub fn opt_i64(&self, name: &str) -> Option<i64> {
        let value = self.get(name)?;
        value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|number| number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15)
                .map(|number| number as i64)
        })
    }

    /// A boolean, absent when missing or not a boolean.
    pub fn opt_bool(&self, name: &str) -> Option<bool> {
        self.get(name)?.as_bool()
    }

    /// An object, absent when missing or not an object.
    pub fn opt_record(&self, name: &str) -> Option<&'a Map<String, Value>> {
        self.get(name)?.as_object()
    }

    /// The strings of an array, absent when not an array; items that are
    /// not strings are skipped.
    pub fn opt_strings(&self, name: &str) -> Option<Vec<&'a str>> {
        Some(
            self.get(name)?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_are_plain_objects() {
        assert!(is_record(&json!({})));
        assert!(!is_record(&json!([])));
        assert!(!is_record(&json!(null)));
        assert!(as_record(&json!("x")).is_none());
        assert!(given(Some(&json!(0))));
        assert!(!given(Some(&json!(""))));
        assert!(!given(Some(&json!(null))));
        assert!(!given(None));
    }

    #[test]
    fn parameters_are_read_by_type() {
        let value = json!({
            "id": " w1 ", "empty": " ", "n": 3, "f": 2.5, "whole": 4.0,
            "flag": true, "tags": ["a", 1, "b"], "o": {"k": 1}
        });
        let params = Params::of(&value);
        assert_eq!(params.opt_text("id"), Some("w1"));
        assert_eq!(params.opt_text("empty"), None);
        assert_eq!(
            params.text("missing").unwrap_err().message,
            "missing is required"
        );
        assert_eq!(params.opt_i64("n"), Some(3));
        assert_eq!(params.opt_i64("f"), None);
        assert_eq!(params.opt_i64("whole"), Some(4));
        assert_eq!(params.opt_f64("f"), Some(2.5));
        assert_eq!(params.opt_bool("flag"), Some(true));
        assert_eq!(params.opt_bool("n"), None);
        assert_eq!(params.opt_strings("tags"), Some(vec!["a", "b"]));
        assert!(params.opt_record("o").is_some());
        assert!(Params::of(&json!([1])).get("id").is_none());
    }
}
