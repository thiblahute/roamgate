//! `session-types.ts`: a session's transcript file as the readers know it.

use serde_json::Value;

use crate::js::{self, Obj};

/// A transcript file and what is known of its session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionFile {
    pub path: String,
    pub mtime_ms: f64,
    pub size: Option<f64>,
    pub identity: Option<String>,
    pub change_token: Option<String>,
    pub session_id: Option<String>,
    pub created_at_ms: Option<f64>,
    pub model_name: Option<String>,
    pub agent_version: Option<String>,
}

impl SessionFile {
    /// From the JavaScript object (`{path, mtimeMs, ...}`).
    pub fn from_value(value: &Value) -> Self {
        let empty = Obj::new();
        let map = value.as_object().unwrap_or(&empty);
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
        let number = |key: &str| map.get(key).and_then(Value::as_f64);
        Self {
            path: text("path").unwrap_or_default(),
            mtime_ms: number("mtimeMs").unwrap_or(f64::NAN),
            size: number("size"),
            identity: text("identity"),
            change_token: text("changeToken"),
            session_id: text("sessionId"),
            created_at_ms: number("createdAtMs"),
            model_name: text("modelName"),
            agent_version: text("agentVersion"),
        }
    }

    /// As the JavaScript object.
    pub fn to_value(&self) -> Value {
        Value::Object(crate::obj! {
            "path" => self.path.clone(),
            "mtimeMs" => self.mtime_ms,
            "size" => self.size,
            "identity" => self.identity.clone(),
            "changeToken" => self.change_token.clone(),
            "sessionId" => self.session_id.clone(),
            "createdAtMs" => self.created_at_ms,
            "modelName" => self.model_name.clone(),
            "agentVersion" => self.agent_version.clone(),
        })
    }

    /// `file.sessionId` when truthy.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref().filter(|s| !s.is_empty())
    }
}

/// `{ ...file, key: value }` on the few keys readers set.
pub fn js_mtime_iso(file: &SessionFile, offset: f64) -> String {
    js::iso(file.mtime_ms + offset)
}
