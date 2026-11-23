//! The channel's messages and pure logic (contract/wire/core-channel.md),
//! held to `contract/vectors/core-channel.json` like the Bun side's
//! `server/src/core-channel/protocol.ts`: frames, the family of a method or
//! path, routing by the owners table, the side a read is shadowed on, the
//! shadow comparison and the outbound queue's coalescing.

use std::collections::{BTreeMap, VecDeque};
use std::sync::LazyLock;

use regex::Regex;
use roamgate_protocol::frames;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The channel protocol's version, in `hello` and `welcome`.
pub const PROTOCOL: u32 = 1;
/// The largest frame the channel accepts (length field's value: kind byte
/// included).
pub const MAX_CHANNEL_FRAME: usize = 64 * 1024 * 1024;
/// A message: compact JSON.
pub const KIND_MESSAGE: u8 = frames::JSON;
/// A body chunk: stream id, flags, bytes.
pub const KIND_BODY: u8 = 2;
/// The last chunk of a body.
pub const FLAG_END: u8 = 1;
/// A response's body, not a request's.
pub const FLAG_RESPONSE: u8 = 2;
/// The most bytes one body chunk carries.
pub const MAX_CHUNK: usize = 256 * 1024;
/// The most bytes of a body its sender keeps unacknowledged.
pub const BODY_WINDOW: u64 = 4 * 1024 * 1024;

/// A side of the channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Bun,
    Rust,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Rust => "rust",
        }
    }

    pub fn other(self) -> Self {
        match self {
            Self::Bun => Self::Rust,
            Self::Rust => Self::Bun,
        }
    }
}

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

/// The shadow settings of the owners table.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShadowSettings {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "default_rate")]
    pub rate: f64,
}

fn yes() -> bool {
    true
}

fn default_rate() -> f64 {
    0.1
}

impl Default for ShadowSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            rate: default_rate(),
        }
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
        side: Side,
        version: String,
        pid: u32,
        families: Vec<String>,
        #[serde(default)]
        test: bool,
    },
    Welcome {
        protocol: u32,
        side: Side,
        #[serde(default)]
        owners: BTreeMap<String, Side>,
        #[serde(default)]
        shadow: ShadowSettings,
        /// The front's test clock (epoch ms) when it runs on one: a debug
        /// core's families follow it (`internal.clock.advance`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clock: Option<i64>,
    },
    Refused {
        reason: String,
    },
    Owner {
        #[serde(default)]
        owners: BTreeMap<String, Side>,
        #[serde(default)]
        shadow: ShadowSettings,
    },
    Call {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
        #[serde(default, skip_serializing_if = "Ctx::is_empty")]
        ctx: Ctx,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        shadow: bool,
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
    /// Stage 2: a browser asks to upgrade a socket the core serves.
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
    // Stage 2: a virtual socket's life (contract/wire/core-channel.md).
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

/// A family of contract/owners/families.json.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Family {
    #[serde(default)]
    pub test: bool,
    #[serde(default)]
    pub phase: Option<u32>,
    #[serde(default)]
    pub rpc: Vec<String>,
    #[serde(default)]
    pub http: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub shadow: Vec<String>,
    /// The CLI commands the family answers (`roamgate <command>`): the Bun
    /// CLI passes them through to the core binary while Rust owns it.
    #[serde(default)]
    pub cli: Vec<String>,
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

/// What the front knows of its core.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CoreState {
    pub connected: bool,
    #[serde(default)]
    pub families: Vec<String>,
}

/// Owners as the table gives them: anything but `rust` is Bun's.
pub type OwnerMap = Map<String, Value>;

fn routed(
    family: Option<String>,
    families: &Families,
    owners: &OwnerMap,
    core: &CoreState,
    test: bool,
) -> Side {
    let Some(name) = family else {
        return Side::Bun;
    };
    let Some(family) = families.get(&name) else {
        return Side::Bun;
    };
    if family.test && !test {
        return Side::Bun;
    }
    let rust = owners.get(&name).and_then(Value::as_str) == Some("rust");
    if rust && core.connected && core.families.contains(&name) {
        Side::Rust
    } else {
        Side::Bun
    }
}

/// The side that answers a browser RPC (stage 1: Bun is the front).
pub fn route_rpc(
    method: &str,
    families: &Families,
    owners: &OwnerMap,
    core: &CoreState,
    test: bool,
) -> Side {
    routed(family_of(method, families), families, owners, core, test)
}

/// The side that serves an HTTP path.
pub fn route_http(
    path: &str,
    families: &Families,
    owners: &OwnerMap,
    core: &CoreState,
    test: bool,
) -> Side {
    routed(http_family_of(path, families), families, owners, core, test)
}

/// The side a read is shadowed on: the one that did not answer it, when it
/// has the family; None when the method is not a shadow read.
pub fn shadow_side(
    method: &str,
    families: &Families,
    owners: &OwnerMap,
    core: &CoreState,
    test: bool,
) -> Option<Side> {
    let name = family_of(method, families)?;
    let family = families.get(&name)?;
    if family.test && !test {
        return None;
    }
    if !family.shadow.iter().any(|read| read == method) {
        return None;
    }
    match route_rpc(method, families, owners, core, test) {
        Side::Rust => Some(Side::Bun),
        Side::Bun => (core.connected && core.families.contains(&name)).then_some(Side::Rust),
    }
}

// ---------------------------------------------------------------- shadow diff

/// The first differences between the owner's answer and the other's.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShadowDiff {
    pub diffs: Vec<Value>,
    pub truncated: bool,
}

static IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn key_path(path: &str, key: &str) -> String {
    if IDENTIFIER.is_match(key) {
        format!("{path}.{key}")
    } else {
        format!("{path}[{}]", Value::String(key.to_owned()))
    }
}

struct Walk {
    diffs: Vec<Value>,
    /// One more than kept, to tell whether some were left out.
    cap: usize,
}

impl Walk {
    fn full(&self) -> bool {
        self.diffs.len() >= self.cap
    }

    fn add(&mut self, diff: Value) {
        if !self.full() {
            self.diffs.push(diff);
        }
    }

    fn compare(&mut self, path: &str, owner: &Value, other: &Value) {
        if self.full() {
            return;
        }
        let (owner_type, other_type) = (type_name(owner), type_name(other));
        if owner_type != other_type {
            self.add(
                json!({"path": path, "kind": "type", "owner": owner_type, "other": other_type}),
            );
            return;
        }
        match (owner, other) {
            (Value::Object(owner), Value::Object(other)) => {
                for (key, value) in owner {
                    let at = key_path(path, key);
                    match other.get(key) {
                        Some(theirs) => self.compare(&at, value, theirs),
                        None => self.add(json!({"path": at, "kind": "missing"})),
                    }
                }
                for key in other.keys() {
                    if !owner.contains_key(key) {
                        self.add(json!({"path": key_path(path, key), "kind": "extra"}));
                    }
                }
            }
            (Value::Array(owner), Value::Array(other)) => {
                if owner.len() != other.len() {
                    self.add(json!({"path": path, "kind": "length", "owner": owner.len(), "other": other.len()}));
                }
                for (index, (mine, theirs)) in owner.iter().zip(other).enumerate() {
                    self.compare(&format!("{path}[{index}]"), mine, theirs);
                }
            }
            (Value::Number(mine), Value::Number(theirs)) => {
                if mine.as_f64() != theirs.as_f64() {
                    self.add(json!({"path": path, "kind": "value"}));
                }
            }
            _ => {
                if owner != other {
                    self.add(json!({"path": path, "kind": "value"}));
                }
            }
        }
    }
}

/// Walks both answers: an object by the owner's keys in order then the
/// other's extra keys, an array by its length then element by element.
/// Keeps the first `limit` differences.
pub fn shadow_diff(owner: &Value, other: &Value, limit: usize) -> ShadowDiff {
    let mut walk = Walk {
        diffs: Vec::new(),
        cap: limit.saturating_add(1),
    };
    walk.compare("$", owner, other);
    let truncated = walk.diffs.len() > limit;
    walk.diffs.truncate(limit);
    ShadowDiff {
        diffs: walk.diffs,
        truncated,
    }
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
            shadow: false,
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
