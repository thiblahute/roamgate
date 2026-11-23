//! A browser RPC's answer as a connection's handlers put it on `/ws`
//! (connections/protocol.ts `serializeConnectionEnvelope`, and the `reply`
//! and `fail` of the bridge's RPC handlers): `{id, result}` or
//! `{id, error: {message}}`, inside the connection's envelope when the
//! handler serves a named connection.
//!
//! A handler returns an [`RpcReply`]; the host sends its payload (the TS
//! `safeSend`, with the method as context) and, for an error, counts it
//! first (`markRpcError`).

use serde_json::{Map, Value, json};

/// The error of a request whose connection was replaced or disposed while
/// it ran.
pub const CONNECTION_CHANGED_DURING_REQUEST: &str = "connection changed during request";

/// What a handler answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcReply {
    /// The text frame to send.
    pub payload: String,
    /// Set for an error: the detail the host marks the request failed with.
    pub error: Option<String>,
}

/// The envelope of one connection's replies.
#[derive(Debug, Clone, Default)]
pub struct ReplyEnvelope {
    /// Unset (or empty) for the default connection: no envelope.
    pub connection_id: Option<String>,
    pub connection_generation: Option<u64>,
}

impl ReplyEnvelope {
    pub fn new(connection_id: Option<&str>, connection_generation: Option<u64>) -> Self {
        Self {
            connection_id: connection_id.map(str::to_owned),
            connection_generation,
        }
    }

    /// `message` as sent: `{connection_id, connection_generation?, ...message}`
    /// for a named connection, else as it is.
    pub fn serialize(&self, message: Map<String, Value>) -> String {
        let Some(connection_id) = self.connection_id.as_deref().filter(|id| !id.is_empty()) else {
            return Value::Object(message).to_string();
        };
        let mut out = Map::new();
        out.insert("connection_id".into(), connection_id.into());
        if let Some(generation) = self.connection_generation {
            out.insert("connection_generation".into(), generation.into());
        }
        out.extend(message);
        Value::Object(out).to_string()
    }

    fn message(id: Option<&Value>, key: &str, value: Value) -> Map<String, Value> {
        let mut message = Map::new();
        // `JSON.stringify` drops an undefined id.
        if let Some(id) = id {
            message.insert("id".into(), id.clone());
        }
        message.insert(key.into(), value);
        message
    }

    /// `{id, result}`.
    pub fn result(&self, id: Option<&Value>, result: Value) -> RpcReply {
        RpcReply {
            payload: self.serialize(Self::message(id, "result", result)),
            error: None,
        }
    }

    /// `{id, error: {message: detail}}`.
    pub fn error(&self, id: Option<&Value>, detail: &str) -> RpcReply {
        RpcReply {
            payload: self.serialize(Self::message(id, "error", json!({ "message": detail }))),
            error: Some(detail.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_connection_wraps_its_replies_and_the_default_one_does_not() {
        let id = Value::from("7");
        let named = ReplyEnvelope::new(Some("remote-dev"), Some(6));
        assert_eq!(
            named.error(Some(&id), "nope").payload,
            r#"{"connection_id":"remote-dev","connection_generation":6,"id":"7","error":{"message":"nope"}}"#
        );
        let ungenerated = ReplyEnvelope::new(Some("remote-dev"), None);
        assert_eq!(
            ungenerated.result(Some(&id), json!({"ok": true})).payload,
            r#"{"connection_id":"remote-dev","id":"7","result":{"ok":true}}"#
        );
        for default in [
            ReplyEnvelope::default(),
            ReplyEnvelope::new(Some(""), Some(1)),
        ] {
            assert_eq!(
                default.result(None, json!(1)),
                RpcReply {
                    payload: r#"{"result":1}"#.into(),
                    error: None
                }
            );
        }
        assert_eq!(
            ReplyEnvelope::default()
                .error(Some(&Value::Null), "x")
                .error
                .as_deref(),
            Some("x")
        );
    }
}
