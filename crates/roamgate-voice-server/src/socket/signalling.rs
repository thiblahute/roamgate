//! A call's signalling, fronted (voice-socket.ts): the page's signalling
//! sockets are relayed to the helper's signalling server on 127.0.0.1, the
//! helper's loopback candidates given at voice.json's `call_ice_address`.
//! The socket to the helper's server is an [`UpstreamSocket`]; the real
//! one is a WebSocket client ([`connect_upstream`]), tests give a fake.

use std::sync::{Arc, LazyLock};

use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::js;

/// What the helper's signalling server's socket says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpstreamEvent {
    Open,
    /// A text message (binary ones are not signalling).
    Message(String),
    /// Closed, or never opened.
    Closed,
}

pub type UpstreamEvents = Arc<dyn Fn(UpstreamEvent) + Send + Sync>;

/// The socket to the helper's signalling server.
pub trait UpstreamSocket: Send + Sync {
    /// Sends `text`; what is sent before it opened goes once it does.
    fn send(&self, text: String);
    /// Closes it; nothing more is told after.
    fn close(&self);
}

/// Opens a socket to `url`, telling `events` what it says.
pub type ConnectUpstream =
    Arc<dyn Fn(&str, UpstreamEvents) -> Result<Arc<dyn UpstreamSocket>, String> + Send + Sync>;

/// What a page's signalling socket messages keep, waiting for upstream.
pub const SIGNALLING_QUEUE: usize = 256;

static LOOPBACK_HOST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^((?:a=)?candidate:\S+ \d+ udp \d+ )127\.0\.0\.1( \d+ typ host)").unwrap()
});

/// Whether a socket's opening comes from this site, as the bridge checks
/// its other state-changing requests: browsers say `Sec-Fetch-Site`, and a
/// page elsewhere is refused even with the user's cookie. (No Origin
/// comparison: it breaks behind reverse proxies.)
pub fn same_site_socket(sec_fetch_site: Option<&str>) -> bool {
    sec_fetch_site != Some("cross-site")
}

/// The helper's ICE candidates on 127.0.0.1, given to the page with
/// `address`: Tailscale's userspace networking forwards UDP sent to this
/// machine's Tailscale address to 127.0.0.1 on the same port, where the
/// helper's agents listen. Candidates in SDP (`a=candidate:`) and trickled
/// ones (`ice.candidate`) alike; other messages go unchanged.
pub fn rewrite_candidates(text: &str, address: Option<&str>) -> String {
    let Some(address) = address.filter(|address| !address.is_empty()) else {
        return text.to_owned();
    };
    let swap = |candidate: &str| {
        LOOPBACK_HOST
            .replace(candidate, |found: &regex::Captures<'_>| {
                format!("{}{address}{}", &found[1], &found[2])
            })
            .into_owned()
    };
    let Ok(Value::Object(mut message)) = serde_json::from_str::<Value>(text) else {
        return text.to_owned();
    };
    if message.get("type").and_then(Value::as_str) != Some("peer") {
        return text.to_owned();
    }
    if let Some(Value::Object(ice)) = message.get_mut("ice")
        && let Some(Value::String(candidate)) = ice.get("candidate")
    {
        let swapped = swap(candidate);
        if &swapped == candidate {
            return text.to_owned();
        }
        ice.insert("candidate".into(), Value::String(swapped));
        return js::stringify(&Value::Object(message));
    }
    if let Some(Value::Object(sdp)) = message.get_mut("sdp")
        && let Some(Value::String(body)) = sdp.get("sdp")
    {
        let changed = body
            .split("\r\n")
            .map(swap)
            .collect::<Vec<_>>()
            .join("\r\n");
        if &changed == body {
            return text.to_owned();
        }
        sdp.insert("sdp".into(), Value::String(changed));
        return js::stringify(&Value::Object(message));
    }
    text.to_owned()
}

enum Command {
    Send(String),
    Close,
}

struct Client {
    commands: mpsc::UnboundedSender<Command>,
}

impl UpstreamSocket for Client {
    fn send(&self, text: String) {
        let _ = self.commands.send(Command::Send(text));
    }

    fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }
}

/// A WebSocket client to the helper's signalling server.
pub fn connect_upstream() -> ConnectUpstream {
    Arc::new(|url: &str, events: UpstreamEvents| {
        let (commands, mut received) = mpsc::unbounded_channel();
        let url = url.to_owned();
        tokio::spawn(async move {
            let Ok((stream, _)) = tokio_tungstenite::connect_async(url.as_str()).await else {
                events(UpstreamEvent::Closed);
                return;
            };
            events(UpstreamEvent::Open);
            let (mut write, mut read) = stream.split();
            loop {
                tokio::select! {
                    command = received.recv() => match command {
                        Some(Command::Send(text)) => {
                            if write.send(Message::text(text)).await.is_err() {
                                break;
                            }
                        }
                        // Closed on purpose: nothing more is told.
                        Some(Command::Close) | None => {
                            let _ = write.send(Message::Close(None)).await;
                            return;
                        }
                    },
                    message = read.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            events(UpstreamEvent::Message(text.as_str().to_owned()));
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    },
                }
            }
            events(UpstreamEvent::Closed);
        });
        Ok(Arc::new(Client { commands }) as Arc<dyn UpstreamSocket>)
    })
}
