//! The reader of `contract/vectors/*.json` (contract/vectors/README.md):
//! the T0 cases the TS functions are held to by `bun test`, read the same
//! way by every crate's tests. A crate's test walks the cases, dispatches
//! each call on its `fn` (`<module>.<export>`) or `on`/`method`, and fails
//! on a name it does not know, so a case added to a file is never skipped.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

/// `contract/vectors`, from this crate's directory.
pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contract/vectors")
        .components()
        .collect()
}

/// A vector file in the call format.
#[derive(Debug, Clone, Deserialize)]
pub struct VectorFile {
    pub description: String,
    #[serde(default)]
    pub modules: serde_json::Map<String, Value>,
    #[serde(default)]
    pub normalize: Option<Value>,
    #[serde(default)]
    pub cases: Vec<Case>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Case {
    pub name: String,
    #[serde(default)]
    pub group: Vec<String>,
    #[serde(default)]
    pub ledger: Option<String>,
    pub calls: Vec<Call>,
}

impl Case {
    /// `group > name`, for messages.
    pub fn title(&self) -> String {
        let mut parts = self.group.clone();
        parts.push(self.name.clone());
        parts.join(" > ")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Call {
    #[serde(default)]
    pub fn_: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub new: bool,
    #[serde(default)]
    pub on: Option<u64>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub get: Option<String>,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub throws: Option<String>,
    #[serde(default)]
    pub r#async: bool,
    #[serde(default)]
    pub args_after: Option<Vec<Value>>,
    #[serde(default)]
    pub same_as_arg: Option<usize>,
    #[serde(default)]
    pub now: Option<i64>,
}

impl Call {
    /// What the call names: `fn`, `value`, or `on.<method|get>`.
    pub fn target(&self) -> String {
        if let Some(name) = &self.fn_ {
            return name.clone();
        }
        if let Some(name) = &self.value {
            return name.clone();
        }
        let member = self.method.as_deref().or(self.get.as_deref()).unwrap_or("");
        format!("on.{member}")
    }

    /// Whether the recorded result is `undefined`.
    pub fn returns_undefined(&self) -> bool {
        self.result.as_ref().is_none_or(is_undefined)
    }
}

/// Reads `contract/vectors/<name>.json` (`fn` is a Rust keyword: the field
/// is `fn_` here).
pub fn load(name: &str) -> VectorFile {
    let path = dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut doc: Value =
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    rename_fn(&mut doc);
    serde_json::from_value(doc).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Reads a vector file that has its own format (`voice-frames.json`).
pub fn load_raw(name: &str) -> Value {
    let path = dir().join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn rename_fn(doc: &mut Value) {
    if let Some(cases) = doc.get_mut("cases").and_then(Value::as_array_mut) {
        for case in cases {
            if let Some(calls) = case.get_mut("calls").and_then(Value::as_array_mut) {
                for call in calls {
                    if let Some(object) = call.as_object_mut()
                        && let Some(name) = object.remove("fn")
                    {
                        object.insert("fn_".into(), name);
                    }
                }
            }
        }
    }
}

/// `{"$undefined": true}`.
pub fn is_undefined(value: &Value) -> bool {
    value.get("$undefined") == Some(&Value::Bool(true))
}

/// The tag of a tagged value (`$fn`, `$date`, `$handle`...) and its body.
pub fn tag(value: &Value) -> Option<(&str, &Value)> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    let (key, body) = object.iter().next()?;
    key.starts_with('$').then_some((key.as_str(), body))
}

/// A `{"$text": [...]}` long string, or a plain string.
pub fn text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let (name, parts) = tag(value)?;
    if name != "$text" {
        return None;
    }
    let mut out = String::new();
    for part in parts.as_array()? {
        match part {
            Value::String(piece) => out.push_str(piece),
            Value::Array(run) => {
                let unit = run.first()?.as_str()?;
                let count = run.get(1)?.as_u64()? as usize;
                out.push_str(&unit.repeat(count));
            }
            _ => return None,
        }
    }
    Some(out)
}

/// Bytes from hex, as the vectors write them.
pub fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_vector_file_in_the_call_format() {
        let mut read = 0;
        for entry in std::fs::read_dir(dir()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let raw = load_raw(&name);
            if raw.get("cases").is_some() {
                let file = load(&name);
                assert!(!file.cases.is_empty(), "{name}");
                read += 1;
            }
        }
        assert!(read > 10);
    }

    #[test]
    fn decodes_long_strings() {
        let value: Value = serde_json::json!({"$text": ["a", ["b", 3], "c"]});
        assert_eq!(text(&value).as_deref(), Some("abbbc"));
        assert_eq!(
            tag(&serde_json::json!({"$handle": 1})).unwrap().0,
            "$handle"
        );
    }
}
