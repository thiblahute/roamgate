//! The sidecar's wire (contract/wire/pi-sidecar.md): JSON-RPC 2.0, one
//! compact JSON object per line. Held to contract/vectors/pi-sidecar.json
//! with server/src/assistant/pi-sidecar-protocol.ts.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};

/// The wire's version, checked by `initialize`.
pub const PROTOCOL: u64 = 1;
/// Names the sidecar's executable.
pub const SIDECAR_ENV: &str = "ROAMGATE_PI_SIDECAR";
/// A longer line is dropped: the internal channel's own frame limit.
pub const MAX_LINE: usize = 64 * 1024 * 1024;
/// The sidecar is closed after this long with nothing in flight.
pub const IDLE: Duration = Duration::from_secs(5 * 60);
/// From closing the sidecar's stdin to killing it.
pub const KILL_AFTER: Duration = Duration::from_secs(3);

/// An error thrown by the other side.
pub const ERROR_CODE: i64 = -32000;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;

/// The run callbacks the server may leave out, each changing what Pi does.
pub const RUN_CALLBACKS: [&str; 5] = ["checkpoint", "replace", "thinking", "sources", "steered"];
/// The tool handlers of a run; `read` is always there.
pub const RUN_HANDLERS: [&str; 8] = [
    "read", "propose", "task", "notify", "show", "arrange", "threads", "archive",
];

/// A request id: each side numbers its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Id {
    Num(i64),
    Str(String),
}

impl Id {
    fn of(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Self::Str(text.clone())),
            Value::Number(number) => number.as_i64().map(Self::Num).or_else(|| {
                // JSON.parse reads 1.0 as the integer 1.
                number
                    .as_f64()
                    .filter(|float| float.fract() == 0.0 && float.abs() < 9.007_199_254_740_992e15)
                    .map(|float| Self::Num(float as i64))
            }),
            _ => None,
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Self::Num(number) => json!(number),
            Self::Str(text) => json!(text),
        }
    }
}

impl std::fmt::Display for Id {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Num(number) => write!(f, "{number}"),
            Self::Str(text) => f.write_str(text),
        }
    }
}

/// An error as the wire carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    pub code: i64,
    pub message: String,
    /// `data.user`: the assistant shows the message as it is.
    pub user: Option<bool>,
}

impl WireError {
    pub fn to_value(&self) -> Value {
        let mut error = Map::new();
        error.insert("code".into(), json!(self.code));
        error.insert("message".into(), json!(self.message));
        if let Some(user) = self.user {
            error.insert("data".into(), json!({ "user": user }));
        }
        Value::Object(error)
    }

    /// `user` or `error`: the class the receiving side throws.
    pub fn kind(&self) -> &'static str {
        if self.user == Some(true) {
            "user"
        } else {
            "error"
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        id: Id,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Result {
        id: Id,
        result: Value,
    },
    Error {
        id: Option<Id>,
        error: WireError,
    },
}

/// The message of one line, or None for a line that is not one.
pub fn parse_line(line: &str) -> Option<Message> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    if object.get("jsonrpc") != Some(&json!("2.0")) {
        return None;
    }
    let id = object.get("id");
    let valid = id.and_then(Id::of);
    if let Some(Value::String(method)) = object.get("method") {
        let params = match object.get("params") {
            None | Some(Value::Null) => Value::Null,
            Some(params) => params.clone(),
        };
        return match id {
            None => Some(Message::Notification {
                method: method.clone(),
                params,
            }),
            Some(_) => Some(Message::Request {
                id: valid?,
                method: method.clone(),
                params,
            }),
        };
    }
    if let (Some(result), Some(id)) = (object.get("result"), valid.clone()) {
        return Some(Message::Result {
            id,
            result: result.clone(),
        });
    }
    let error = object.get("error")?.as_object()?;
    if valid.is_none() && id != Some(&Value::Null) {
        return None;
    }
    let code = error.get("code")?.as_f64()?;
    let message = error.get("message")?.as_str()?;
    let user = error
        .get("data")
        .and_then(Value::as_object)
        .and_then(|data| data.get("user"))
        .and_then(Value::as_bool);
    Some(Message::Error {
        id: valid,
        error: WireError {
            code: code as i64,
            message: message.to_owned(),
            user,
        },
    })
}

/// One message as its line, without the newline.
pub fn encode_message(message: &Message) -> String {
    let mut object = Map::new();
    object.insert("jsonrpc".into(), json!("2.0"));
    match message {
        Message::Request { id, method, params } => {
            object.insert("id".into(), id.to_value());
            object.insert("method".into(), json!(method));
            object.insert("params".into(), params.clone());
        }
        Message::Notification { method, params } => {
            object.insert("method".into(), json!(method));
            object.insert("params".into(), params.clone());
        }
        Message::Result { id, result } => {
            object.insert("id".into(), id.to_value());
            object.insert("result".into(), result.clone());
        }
        Message::Error { id, error } => {
            object.insert("id".into(), id.as_ref().map_or(Value::Null, Id::to_value));
            object.insert("error".into(), error.to_value());
        }
    }
    Value::Object(object).to_string()
}

static SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]s$").expect("regex"));

/// How to start the sidecar a value of `ROAMGATE_PI_SIDECAR` names: a
/// `.ts` or `.js` file runs with `bun`, anything else is the executable.
/// Empty: none.
pub fn sidecar_command(value: Option<&str>, bun: &str) -> Option<Vec<String>> {
    let path = value?.trim();
    if path.is_empty() {
        return None;
    }
    Some(if SCRIPT.is_match(path) {
        vec![bun.to_owned(), path.to_owned()]
    } else {
        vec![path.to_owned()]
    })
}
