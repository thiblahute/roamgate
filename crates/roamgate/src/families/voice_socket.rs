//! The voice family's browser sockets in the core (Phase 10, S22):
//! `/api/voice/ws` and `/api/voice/call/signalling`, which the Rust front
//! gives the core on its link while the core owns the family
//! (contract/wire/core-channel.md, The Rust core's link to the Rust
//! front), served by roamgate-voice-server's socket as Bun's index.ts
//! serves them: the same socket the voice routes read the running call
//! from and the call handoff redeems against.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use base64::Engine as _;
use roamgate_base::clock::SharedClock;
use roamgate_channel::peer::{Peer as Link, WsOpen};
use roamgate_channel::protocol::Message;
use roamgate_voice_server::companion::errands::VoiceErrands;
use roamgate_voice_server::socket::signalling::same_site_socket;
use roamgate_voice_server::socket::{
    Peer, SignallingPeer, SignallingSocket, VoicePeer, VoiceSocket,
};
use serde_json::{Value, json};

/// The voice socket's path.
pub const VOICE_PATH: &str = "/api/voice/ws";
/// A call's signalling path.
pub const SIGNALLING_PATH: &str = "/api/voice/call/signalling";
/// A call keeps the sessions' processes up this long after its socket was
/// last used (index.ts, VOICE_KEEPS_AWAKE_MS).
const KEEPS_AWAKE_MS: i64 = 10 * 60_000;

/// A browser socket on the front's link.
struct LinkSocket {
    link: Link,
    socket_id: u64,
}

impl LinkSocket {
    fn send_text(&self, text: String) {
        self.link.send(&Message::WsSend {
            socket_id: self.socket_id,
            data: text,
            binary: false,
            context: None,
            key: None,
        });
    }

    fn end(&self, code: u16, reason: &str) {
        self.link.send(&Message::WsEnd {
            socket_id: self.socket_id,
            code: Some(code),
            reason: Some(reason.to_owned()),
        });
    }
}

impl VoicePeer for LinkSocket {
    fn send(&self, text: String) {
        self.send_text(text);
    }
}

impl SignallingPeer for LinkSocket {
    fn send(&self, text: String) {
        self.send_text(text);
    }

    fn close(&self, code: u16, reason: &str) {
        self.end(code, reason);
    }
}

enum Open {
    Voice(Arc<LinkSocket>, Peer),
    Signalling(Arc<LinkSocket>, SignallingSocket),
}

/// The family's sockets, by the front's number.
pub struct VoiceSockets {
    socket: VoiceSocket,
    errands: VoiceErrands,
    clock: SharedClock,
    open: Mutex<HashMap<u64, Open>>,
    /// Voice sockets open, and when one was last used.
    voice_open: AtomicUsize,
    last_voice_at: AtomicI64,
}

/// The sockets of the running voice family, for the conversation family's
/// idle stop.
static CURRENT: OnceLock<Mutex<Weak<VoiceSockets>>> = OnceLock::new();

/// Why a conversation's process must stay up for the voice served here
/// (index.ts, conversationKeepAwake): a voice call open or used in the last
/// 10 minutes, or a companion job on the pane (`<connection>/<pane>`).
pub fn keep_awake(pane: &str) -> Option<String> {
    let sockets = CURRENT.get()?.lock().unwrap().upgrade()?;
    sockets.keeps_awake(pane)
}

/// JavaScript's `Number(text)` of a query parameter, as a JSON value
/// (NaN as the string `NaN`, which never names a call).
fn js_number(text: Option<&str>) -> Value {
    let text = text.unwrap_or("").trim();
    if text.is_empty() {
        return json!(0);
    }
    let parsed = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok().map(|n| n as f64)
    } else if text
        .chars()
        .all(|c| c.is_ascii_digit() || "+-.eE".contains(c))
    {
        text.parse::<f64>().ok()
    } else {
        // Infinity never names a call either.
        None
    };
    match parsed {
        Some(n) if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 => json!(n as i64),
        Some(n) => serde_json::Number::from_f64(n).map_or(json!("NaN"), Value::Number),
        None => json!("NaN"),
    }
}

/// `new URL(url).searchParams.get(name)`, as the voice routes read it.
fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1.split('#').next()?;
    roamgate_voice_server::http::Request {
        method: "GET".into(),
        path: String::new(),
        query: query.to_owned(),
        headers: Vec::new(),
        body: roamgate_voice_server::http::Body::Missing,
    }
    .query_param(name)
}

fn header<'a>(open: &'a WsOpen, name: &str) -> Option<&'a str> {
    open.headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

impl VoiceSockets {
    pub fn new(socket: VoiceSocket, errands: VoiceErrands, clock: SharedClock) -> Arc<Self> {
        let sockets = Arc::new(Self {
            socket,
            errands,
            clock,
            open: Mutex::default(),
            voice_open: AtomicUsize::new(0),
            last_voice_at: AtomicI64::new(i64::MIN / 2),
        });
        *CURRENT
            .get_or_init(|| Mutex::new(Weak::new()))
            .lock()
            .unwrap() = Arc::downgrade(&sockets);
        sockets
    }

    fn keeps_awake(&self, pane: &str) -> Option<String> {
        let recent = self.clock.now() - self.last_voice_at.load(Ordering::SeqCst) < KEEPS_AWAKE_MS;
        if self.voice_open.load(Ordering::SeqCst) > 0 || recent {
            return Some("a voice call is open".into());
        }
        if self.errands.working(pane) {
            return Some("a companion job runs on it".into());
        }
        None
    }

    fn used(&self) {
        self.last_voice_at.store(self.clock.now(), Ordering::SeqCst);
    }

    /// `ws_open` of one of the family's sockets: accepted as a raw socket,
    /// or a signalling refused with 403 as index.ts refuses it.
    pub fn open(&self, link: &Link, open: &WsOpen) -> Value {
        let path = open.url.split(['?', '#']).next().unwrap_or("");
        let ws = Arc::new(LinkSocket {
            link: link.clone(),
            socket_id: open.socket_id,
        });
        if path == VOICE_PATH {
            self.voice_open.fetch_add(1, Ordering::SeqCst);
            self.used();
            let peer: Peer = ws.clone();
            self.open
                .lock()
                .unwrap()
                .insert(open.socket_id, Open::Voice(ws, peer));
            return json!({"accepted": true, "transport": "raw"});
        }
        if path == SIGNALLING_PATH {
            // A call's WebRTC signalling, for the page that owns the call
            // (its `call_token`), from this site only.
            let call = js_number(query_param(&open.url, "call").as_deref());
            let token = query_param(&open.url, "call_token").unwrap_or_default();
            let same_site = same_site_socket(header(open, "sec-fetch-site"));
            if self
                .socket
                .signalling_refused(same_site, &call, &json!(token))
                .is_some()
            {
                return json!({
                    "accepted": false,
                    "status": 403,
                    "headers": [["content-type", "text/plain;charset=utf-8"]],
                    "body": "forbidden",
                });
            }
            let id = call.as_u64().unwrap_or(0);
            let peer: SignallingSocket = ws.clone();
            self.open
                .lock()
                .unwrap()
                .insert(open.socket_id, Open::Signalling(ws, peer.clone()));
            self.socket.open_signalling(&peer, id, &token);
            return json!({"accepted": true, "transport": "raw"});
        }
        roamgate_channel::family::not_served()
    }

    /// A `ws_message` or `ws_close` of an accepted socket.
    pub fn message(&self, message: Message) {
        match message {
            Message::WsMessage {
                socket_id,
                data,
                binary,
            } => {
                let open = self.open.lock().unwrap();
                match open.get(&socket_id) {
                    Some(Open::Voice(_, peer)) => {
                        let peer = peer.clone();
                        drop(open);
                        self.used();
                        if binary {
                            match base64::engine::general_purpose::STANDARD.decode(&data) {
                                Ok(samples) => self.socket.audio(&peer, &samples),
                                Err(_) => tracing::warn!(
                                    scope = "voice",
                                    "a binary voice message that is not base64, dropped"
                                ),
                            }
                        } else {
                            self.socket.message(&peer, &data);
                        }
                    }
                    Some(Open::Signalling(_, peer)) => {
                        let peer = peer.clone();
                        drop(open);
                        let text = if binary {
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(&data)
                                .unwrap_or_default();
                            String::from_utf8_lossy(&bytes).into_owned()
                        } else {
                            data
                        };
                        self.socket.signalling_message(&peer, &text);
                    }
                    None => {}
                }
            }
            Message::WsClose { socket_id, .. } => {
                let removed = self.open.lock().unwrap().remove(&socket_id);
                self.closed(removed);
            }
            _ => {}
        }
    }

    fn closed(&self, removed: Option<Open>) {
        match removed {
            Some(Open::Voice(_, peer)) => {
                let _ = self
                    .voice_open
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                        Some(n.saturating_sub(1))
                    });
                self.used();
                self.socket.close(&peer);
            }
            Some(Open::Signalling(_, peer)) => self.socket.close_signalling(&peer),
            None => {}
        }
    }

    /// The core no longer owns the family: its sockets close, the browsers
    /// reconnect to the Bun core.
    pub fn close_all(&self) {
        let all: Vec<Open> = self.open.lock().unwrap().drain().map(|(_, o)| o).collect();
        for open in all {
            match &open {
                Open::Voice(ws, _) | Open::Signalling(ws, _) => ws.end(1012, "Service Restart"),
            }
            self.closed(Some(open));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_call_as_javascript_numbers_it() {
        assert_eq!(js_number(Some("7")), json!(7));
        assert_eq!(js_number(None), json!(0));
        assert_eq!(js_number(Some("")), json!(0));
        assert_eq!(js_number(Some("abc")), json!("NaN"));
        assert_eq!(js_number(Some("1e1")), json!(10));
        assert_eq!(
            query_param(
                "/api/voice/call/signalling?call=3&call_token=a%2Bb",
                "call_token"
            )
            .as_deref(),
            Some("a+b")
        );
    }
}
