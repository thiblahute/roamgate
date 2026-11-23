//! WebSocket clients: the browser's `/ws` (RPC calls and replies, pushes
//! captured in order and by name, chunked messages reassembled), and the
//! plain JSON sockets (`/api/notifications/ws`, `/api/voice/ws`, call
//! signalling).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

/// A push's name, as the contract recorder names it: its `event`, `type`,
/// `method`, or its one top-level key (server/src/contract-record/corpus.ts).
pub fn push_name(message: &Value) -> String {
    let Some(map) = message.as_object() else {
        return "non-object".into();
    };
    if map.get("hello") == Some(&Value::Bool(true)) {
        return "hello".into();
    }
    if let Some(event) = map.get("event").and_then(Value::as_str) {
        return format!("event:{event}");
    }
    if let Some(kind) = map.get("type").and_then(Value::as_str) {
        return kind.into();
    }
    if let Some(method) = map.get("method").and_then(Value::as_str) {
        return format!("method:{method}");
    }
    let mut keys: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "connection_id" && *key != "connection_generation")
        .collect();
    if keys.len() == 1 {
        return keys[0].into();
    }
    keys.sort();
    if keys.is_empty() {
        "{}".into()
    } else {
        keys.join("+")
    }
}

#[derive(Debug, Clone)]
pub enum Incoming {
    Text(Value),
    Binary(Vec<u8>),
    Closed { code: u16, reason: String },
}

#[derive(Default)]
struct Inbox {
    /// Messages not yet taken, in order, with their arrival number.
    queue: VecDeque<(u64, Incoming)>,
    arrived: u64,
    /// Replies by id (browser socket).
    replies: BTreeMap<String, Value>,
    chunks: BTreeMap<String, String>,
    closed: Option<(u16, String)>,
}

/// A connected WebSocket with its reader task.
pub struct Socket {
    outgoing: mpsc::UnboundedSender<Message>,
    inbox: Arc<Mutex<Inbox>>,
    notify: Arc<Notify>,
    /// Parse `{id, result|error}` as replies and reassemble chunks.
    rpc: bool,
}

pub struct Connect<'a> {
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub rpc: bool,
}

impl Socket {
    pub async fn connect(options: Connect<'_>) -> Result<Socket> {
        let mut request = options
            .url
            .into_client_request()
            .with_context(|| options.url.to_owned())?;
        for (name, value) in options.headers {
            request.headers_mut().insert(
                tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(value)?,
            );
        }
        let (stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .with_context(|| format!("WebSocket {}", options.url))?;
        let (mut write, mut read) = stream.split();
        let (outgoing, mut queue) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(message) = queue.recv().await {
                if write.send(message).await.is_err() {
                    break;
                }
            }
        });
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let notify = Arc::new(Notify::new());
        let rpc = options.rpc;
        {
            let inbox = inbox.clone();
            let notify = notify.clone();
            tokio::spawn(async move {
                while let Some(message) = read.next().await {
                    let mut guard = inbox.lock().await;
                    match message {
                        Ok(Message::Text(text)) => {
                            let text = text.to_string();
                            if rpc && let Some(rest) = text.strip_prefix('\u{1}') {
                                // `\u0001<id>:<done>:<data>`
                                let mut parts = rest.splitn(3, ':');
                                let id = parts.next().unwrap_or("").to_owned();
                                let done = parts.next() == Some("1");
                                let data = parts.next().unwrap_or("");
                                guard.chunks.entry(id.clone()).or_default().push_str(data);
                                if done {
                                    let whole = guard.chunks.remove(&id).unwrap_or_default();
                                    if let Ok(value) = serde_json::from_str::<Value>(&whole) {
                                        Self::file(&mut guard, value, rpc);
                                    }
                                }
                            } else if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                Self::file(&mut guard, value, rpc);
                            } else {
                                Self::queue(&mut guard, Incoming::Text(Value::String(text)));
                            }
                        }
                        Ok(Message::Binary(bytes)) => {
                            Self::queue(&mut guard, Incoming::Binary(bytes.to_vec()));
                        }
                        Ok(Message::Close(frame)) => {
                            let (code, reason) = frame
                                .map(|frame| (u16::from(frame.code), frame.reason.to_string()))
                                .unwrap_or((1005, String::new()));
                            guard.closed = Some((code, reason.clone()));
                            Self::queue(&mut guard, Incoming::Closed { code, reason });
                        }
                        Ok(_) => {}
                        Err(_) => {
                            if guard.closed.is_none() {
                                guard.closed = Some((1006, String::new()));
                                Self::queue(
                                    &mut guard,
                                    Incoming::Closed {
                                        code: 1006,
                                        reason: String::new(),
                                    },
                                );
                            }
                        }
                    }
                    drop(guard);
                    notify.notify_waiters();
                }
                let mut guard = inbox.lock().await;
                if guard.closed.is_none() {
                    guard.closed = Some((1006, String::new()));
                    Self::queue(
                        &mut guard,
                        Incoming::Closed {
                            code: 1006,
                            reason: String::new(),
                        },
                    );
                }
                drop(guard);
                notify.notify_waiters();
            });
        }
        Ok(Socket {
            outgoing,
            inbox,
            notify,
            rpc,
        })
    }

    fn queue(inbox: &mut Inbox, message: Incoming) {
        inbox.arrived += 1;
        let number = inbox.arrived;
        inbox.queue.push_back((number, message));
    }

    fn file(inbox: &mut Inbox, value: Value, rpc: bool) {
        if rpc
            && let Some(id) = value.get("id")
            && (value.get("result").is_some() || value.get("error").is_some())
        {
            let id = match id {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            inbox.replies.insert(id, value);
            return;
        }
        Self::queue(inbox, Incoming::Text(value));
    }

    pub fn send_json(&self, value: &Value) -> Result<()> {
        self.outgoing
            .send(Message::Text(value.to_string().into()))
            .map_err(|_| anyhow!("socket closed"))
    }

    pub fn send_text(&self, text: &str) -> Result<()> {
        self.outgoing
            .send(Message::Text(text.to_owned().into()))
            .map_err(|_| anyhow!("socket closed"))
    }

    pub fn send_binary(&self, bytes: Vec<u8>) -> Result<()> {
        self.outgoing
            .send(Message::Binary(bytes.into()))
            .map_err(|_| anyhow!("socket closed"))
    }

    pub fn close(&self) {
        let _ = self.outgoing.send(Message::Close(None));
    }

    /// Waits until `pick` takes something from the inbox, or the timeout.
    async fn wait<T>(
        &self,
        timeout: Duration,
        mut pick: impl FnMut(&mut Inbox) -> Option<T>,
    ) -> Option<T> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut guard = self.inbox.lock().await;
                if let Some(found) = pick(&mut guard) {
                    return Some(found);
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let mut guard = self.inbox.lock().await;
                return pick(&mut guard);
            }
        }
    }

    /// The reply to a request id.
    pub async fn reply(&self, id: &str, timeout: Duration) -> Result<Value> {
        let id = id.to_owned();
        self.wait(timeout, |inbox| {
            inbox.replies.remove(&id).or_else(|| {
                inbox
                    .closed
                    .as_ref()
                    .map(|(code, _)| json!({"$closed": code}))
            })
        })
        .await
        .ok_or_else(|| anyhow!("no reply to request {id} within {timeout:?}"))
        .and_then(|value| {
            if let Some(code) = value.get("$closed") {
                bail!("socket closed ({code}) before the reply to {id}")
            }
            Ok(value)
        })
    }

    /// Whether the reply to a request id is in (not taken).
    pub async fn has_reply(&self, id: &str) -> bool {
        self.inbox.lock().await.replies.contains_key(id)
    }

    /// The next message in order (pushes on `/ws`), or None at the timeout.
    pub async fn next(&self, timeout: Duration) -> Option<(u64, Incoming)> {
        self.wait(timeout, |inbox| inbox.queue.pop_front()).await
    }

    /// The first queued message `accept` takes, leaving the others queued in
    /// order; None at the timeout.
    pub async fn take(
        &self,
        timeout: Duration,
        mut accept: impl FnMut(&Incoming) -> bool,
    ) -> Option<(u64, Incoming)> {
        self.wait(timeout, |inbox| {
            let index = inbox
                .queue
                .iter()
                .position(|(_, message)| accept(message))?;
            inbox.queue.remove(index)
        })
        .await
    }

    /// Everything queued now, left queued.
    pub async fn peek(&self) -> Vec<(u64, Incoming)> {
        self.inbox.lock().await.queue.iter().cloned().collect()
    }

    /// Everything queued now, taken.
    pub async fn drain(&self) -> Vec<(u64, Incoming)> {
        self.inbox.lock().await.queue.drain(..).collect()
    }

    pub async fn closed(&self) -> Option<(u16, String)> {
        self.inbox.lock().await.closed.clone()
    }

    pub fn is_rpc(&self) -> bool {
        self.rpc
    }
}
