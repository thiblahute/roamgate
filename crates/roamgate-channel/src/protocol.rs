//! The channel's messages and pure logic (contract/wire/core-channel.md),
//! held to `contract/vectors/core-channel.json`: frames, the family of a
//! method or path and the outbound queue's coalescing.

use std::collections::VecDeque;

use roamgate_protocol::frames;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The channel protocol's version, in `hello` and `welcome`.
pub const PROTOCOL: u32 = 1;
/// The largest frame the channel accepts (length field's value: kind byte
/// included).
pub const MAX_CHANNEL_FRAME: usize = 64 * 1024 * 1024;
/// A message: compact JSON.
pub const KIND_MESSAGE: u8 = frames::JSON;
/// A body chunk: stream id, flags, bytes.
pub const KIND_BODY: u8 = 2;
/// A message with its `data` apart: the JSON's length (u32, little-endian),
/// the message's compact JSON without `data`, then `data`'s UTF-8 bytes.
/// Sent only to a side whose `welcome` has `raw_data`.
pub const KIND_RAW_DATA: u8 = 3;
/// The shortest `data` sent apart: below it, escaping it costs little.
pub const RAW_DATA_MIN: usize = 4096;
/// The last chunk of a body.
pub const FLAG_END: u8 = 1;
/// A response's body, not a request's.
pub const FLAG_RESPONSE: u8 = 2;
/// The most bytes one body chunk carries.
pub const MAX_CHUNK: usize = 256 * 1024;
/// The most bytes of a body its sender keeps unacknowledged.
pub const BODY_WINDOW: u64 = 4 * 1024 * 1024;

/// What the front knows of a request (`ctx`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Ctx {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_ip: Option<String>,
    /// Fields a newer front adds.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Ctx {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// An error answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct RpcError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            data: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: &str) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            data: None,
        }
    }

    /// The channel closed before the answer came.
    pub fn closed() -> Self {
        Self::with_code("core channel closed", "channel_closed")
    }
}

/// `[[name, value]]`, names lowercase.
pub type Headers = Vec<(String, String)>;

/// A message (`t`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Message {
    Hello {
        protocol: u32,
        token: String,
        version: String,
        pid: u32,
        families: Vec<String>,
        #[serde(default)]
        test: bool,
    },
    Welcome {
        protocol: u32,
        /// The front's test clock (epoch ms) when it runs on one: a debug
        /// core's families follow it (`internal.clock.advance`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clock: Option<i64>,
        /// The front reads kind 3 frames (`KIND_RAW_DATA`): the core may
        /// send a large `ws_send`'s `data` apart, unescaped.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        raw_data: bool,
        /// A node's welcome on the node link: what it runs
        /// (contract/wire/node-link.md, Handshake).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node: Option<NodeIdentity>,
    },
    Refused {
        reason: String,
    },
    Call {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
        #[serde(default, skip_serializing_if = "Ctx::is_empty")]
        ctx: Ctx,
    },
    Reply {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Cancel {
        id: u64,
    },
    Push(Push),
    Http {
        id: u64,
        method: String,
        url: String,
        #[serde(default)]
        headers: Headers,
        #[serde(default, skip_serializing_if = "Ctx::is_empty")]
        ctx: Ctx,
        #[serde(default)]
        body: bool,
    },
    HttpResp {
        id: u64,
        status: u16,
        #[serde(default)]
        headers: Headers,
        #[serde(default)]
        body: bool,
    },
    Ack {
        id: u64,
        #[serde(default)]
        response: bool,
        bytes: u64,
    },
    ReverseCall {
        id: u64,
        target: String,
        #[serde(default)]
        args: Value,
        #[serde(default, skip_serializing_if = "Ctx::is_empty")]
        ctx: Ctx,
    },
    Ping {
        n: u64,
    },
    Pong {
        n: u64,
    },
    Bye,
    /// A browser asks to upgrade a socket the core serves.
    WsOpen {
        id: u64,
        socket_id: u64,
        method: String,
        url: String,
        #[serde(default)]
        headers: Headers,
        #[serde(default, skip_serializing_if = "Ctx::is_empty")]
        ctx: Ctx,
    },
    // A virtual socket's life (contract/wire/core-channel.md).
    /// Front to core: a browser message.
    WsMessage {
        socket_id: u64,
        data: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        binary: bool,
    },
    /// Front to core: the browser socket closed.
    WsClose {
        socket_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
        #[serde(default)]
        reason: String,
    },
    /// Core to front: a message to the browser.
    WsSend {
        socket_id: u64,
        data: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        binary: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// Core to front: forget a held message of that key.
    WsDrop {
        socket_id: u64,
        key: String,
    },
    /// Core to front: close the browser socket.
    WsEnd {
        socket_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// A type this side does not know: ignored.
    #[serde(other)]
    Unknown,
}

/// What a node runs, in its `welcome` (contract/wire/node-link.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeIdentity {
    /// The node's `roamgate` version.
    pub version: String,
    /// The node link's contract version ([`NODE_CONTRACT`]).
    pub contract: u32,
}

/// The node link's contract version: a home links only to a node that
/// speaks the same one (contract/wire/node-link.md).
pub const NODE_CONTRACT: u32 = 2;

/// A push to browsers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Push {
    pub message: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// A message's frame.
pub fn encode_message<T: Serialize + ?Sized>(message: &T) -> Vec<u8> {
    let payload = serde_json::to_vec(message).expect("a channel message serialises");
    frames::encode(KIND_MESSAGE, &payload)
}

/// A message's frame with its `data` apart (`KIND_RAW_DATA`): `header` is
/// the message without `data`.
pub fn encode_raw_data<T: Serialize + ?Sized>(header: &T, data: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(header).expect("a channel message serialises");
    let mut payload = Vec::with_capacity(4 + json.len() + data.len());
    payload.extend_from_slice(&(json.len() as u32).to_le_bytes());
    payload.extend_from_slice(&json);
    payload.extend_from_slice(data);
    frames::encode(KIND_RAW_DATA, &payload)
}

/// A `KIND_RAW_DATA` payload as the message it carries (`data` put back);
/// None when it is not one.
pub fn decode_raw_data(payload: &[u8]) -> Option<Value> {
    let length = u32::from_le_bytes(payload.get(..4)?.try_into().ok()?) as usize;
    let json = payload.get(4..4 + length)?;
    let data = std::str::from_utf8(&payload[4 + length..]).ok()?;
    let mut message: Value = serde_json::from_slice(json).ok()?;
    message
        .as_object_mut()?
        .insert("data".into(), Value::String(data.to_owned()));
    Some(message)
}

/// A body chunk's frame.
pub fn encode_body(stream: u32, flags: u8, bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(5 + bytes.len());
    payload.extend_from_slice(&stream.to_le_bytes());
    payload.push(flags);
    payload.extend_from_slice(bytes);
    frames::encode(KIND_BODY, &payload)
}

/// A body chunk read from a frame's payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyChunk {
    pub stream: u32,
    pub flags: u8,
    pub bytes: Vec<u8>,
}

/// A body frame's payload; None when too short.
pub fn decode_body(payload: &[u8]) -> Option<BodyChunk> {
    if payload.len() < 5 {
        return None;
    }
    Some(BodyChunk {
        stream: u32::from_le_bytes(payload[..4].try_into().ok()?),
        flags: payload[4],
        bytes: payload[5..].to_vec(),
    })
}

// ---------------------------------------------------------------- families

/// A family of contract/wire/families.json.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Family {
    #[serde(default)]
    pub test: bool,
    #[serde(default)]
    pub rpc: Vec<String>,
    #[serde(default)]
    pub http: Vec<String>,
    /// The files only this family writes (One writer per file).
    #[serde(default)]
    pub files: Vec<String>,
}

/// Families by name, in the file's order.
pub type Families = indexmap::IndexMap<String, Family>;

/// The family whose entries name `name`: an exact entry first, then the
/// longest prefix entry (one ending in `separator`).
fn family_by(
    name: &str,
    families: &Families,
    entries: impl Fn(&Family) -> &Vec<String>,
    separator: char,
) -> Option<String> {
    for (family_name, family) in families.iter() {
        if entries(family)
            .iter()
            .any(|entry| !entry.ends_with(separator) && entry == name)
        {
            return Some(family_name.to_owned());
        }
    }
    let mut best: Option<(usize, &str)> = None;
    for (family_name, family) in families.iter() {
        for entry in entries(family) {
            if entry.ends_with(separator)
                && name.len() > entry.len()
                && name.starts_with(entry.as_str())
                && best.is_none_or(|(length, _)| entry.len() > length)
            {
                best = Some((entry.len(), family_name));
            }
        }
    }
    best.map(|(_, family)| family.to_owned())
}

/// The family of a browser RPC method.
pub fn family_of(method: &str, families: &Families) -> Option<String> {
    family_by(method, families, |family| &family.rpc, '.')
}

/// The family of an HTTP path.
pub fn http_family_of(path: &str, families: &Families) -> Option<String> {
    family_by(path, families, |family| &family.http, '/')
}

// ---------------------------------------------------------------- queue

/// Each side's outbound queue: a keyed item replaces a queued item with
/// the same key (the older is dropped, the newer goes last); an item
/// already taken is never replaced.
#[derive(Debug)]
pub struct OutboundQueue<T> {
    items: VecDeque<(T, Option<String>)>,
}

impl<T> Default for OutboundQueue<T> {
    fn default() -> Self {
        Self {
            items: VecDeque::new(),
        }
    }
}

impl<T> OutboundQueue<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues `item`, dropping a queued item with the same key; returns
    /// how many are queued now.
    pub fn enqueue(&mut self, item: T, key: Option<String>) -> usize {
        if let Some(key) = &key {
            self.items
                .retain(|(_, queued)| queued.as_deref() != Some(key.as_str()));
        }
        self.items.push_back((item, key));
        self.items.len()
    }

    pub fn take(&mut self) -> Option<T> {
        self.items.pop_front().map(|(item, _)| item)
    }

    pub fn size(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn messages_round_trip_and_unknown_types_are_kept_apart() {
        let call = Message::Call {
            id: 3,
            method: "x.y".into(),
            params: json!({"a": 1}),
            ctx: Ctx {
                socket_id: Some(4),
                ..Ctx::default()
            },
        };
        let text = serde_json::to_string(&call).unwrap();
        assert_eq!(
            text,
            r#"{"t":"call","id":3,"method":"x.y","params":{"a":1},"ctx":{"socket_id":4}}"#
        );
        assert_eq!(serde_json::from_str::<Message>(&text).unwrap(), call);
        assert_eq!(
            serde_json::from_str::<Message>(r#"{"t":"later","x":1}"#).unwrap(),
            Message::Unknown
        );
        assert_eq!(
            serde_json::to_string(&Message::Bye).unwrap(),
            r#"{"t":"bye"}"#
        );
    }
}
