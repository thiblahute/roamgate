//! One side of the channel (contract/wire/core-channel.md, Messages): the
//! handshake, then a reader task dispatching what comes, a writer task
//! draining the outbound queue, and, on the front, liveness pings.
//!
//! The same code serves both roles: the Rust core in stage 1, the Rust
//! front in stage 2 (and both ends of this crate's tests).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use serde_json::Value;
use tokio::io::{AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::task::AbortHandle;

use crate::frames::read_frame;
use crate::protocol::{
    BODY_WINDOW, Ctx, FLAG_END, FLAG_RESPONSE, Headers, KIND_BODY, KIND_MESSAGE, MAX_CHANNEL_FRAME,
    MAX_CHUNK, Message, OutboundQueue, PROTOCOL, Push, RpcError, ShadowSettings, Side, decode_body,
    encode_body, encode_message,
};
use crate::transport::BoxStream;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A call the other side made.
#[derive(Debug, Clone)]
pub struct IncomingCall {
    pub id: u64,
    pub method: String,
    pub params: Value,
    pub ctx: Ctx,
    pub shadow: bool,
}

/// An HTTP request's head.
#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Headers,
    pub ctx: Ctx,
}

/// A response to send: its body, when it has one, comes from `body`.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: Option<mpsc::Receiver<Vec<u8>>>,
}

impl HttpResponse {
    pub fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: None,
        }
    }
}

/// A response received.
pub struct HttpReply {
    pub status: u16,
    pub headers: Headers,
    pub body: Option<BodyReceiver>,
}

/// What a side answers. Every method has a default: a core that has no
/// family answers every call with `unknown_method`.
pub trait Handler: Send + Sync + 'static {
    fn call(&self, _peer: &Peer, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            Err(RpcError::with_code(
                format!("unknown method {}", call.method),
                "unknown_method",
            ))
        })
    }

    fn reverse_call(
        &self,
        _peer: &Peer,
        target: String,
        _args: Value,
        _ctx: Ctx,
    ) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async move {
            Err(RpcError::with_code(
                format!("unknown target {target}"),
                "unknown_target",
            ))
        })
    }

    fn http(
        &self,
        _peer: &Peer,
        _request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        Box::pin(async { Ok(HttpResponse::status(404)) })
    }

    fn push(&self, _push: Push) {}

    fn owner(&self, _owners: BTreeMap<String, Side>, _shadow: ShadowSettings) {}
}

/// How a peer runs.
#[derive(Clone)]
pub struct PeerOptions {
    pub clock: SharedClock,
    /// Ping after this long without sending (the front: 10 s).
    pub ping_after: Option<Duration>,
    /// Close after this long without receiving (the front: 30 s).
    pub dead_after: Option<Duration>,
}

impl PeerOptions {
    /// The core's: it only answers pings.
    pub fn core(clock: SharedClock) -> Self {
        Self {
            clock,
            ping_after: None,
            dead_after: None,
        }
    }

    /// The front's: pings after 10 s, a core silent 30 s is dead.
    pub fn front(clock: SharedClock) -> Self {
        Self {
            clock,
            ping_after: Some(Duration::from_secs(10)),
            dead_after: Some(Duration::from_secs(30)),
        }
    }
}

enum Outgoing {
    Frame(Vec<u8>),
    Close,
}

/// A body's flow on the sending side.
struct Window {
    unacked: Mutex<u64>,
    closed: AtomicBool,
    notify: Notify,
}

impl Window {
    fn new() -> Self {
        Self {
            unacked: Mutex::new(0),
            closed: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    async fn acquire(&self, bytes: u64) -> Result<(), RpcError> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.closed.load(Ordering::Acquire) {
                return Err(RpcError::closed());
            }
            {
                let mut unacked = self.unacked.lock().unwrap();
                if *unacked == 0 || *unacked + bytes <= BODY_WINDOW {
                    *unacked += bytes;
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    fn ack(&self, bytes: u64) {
        let mut unacked = self.unacked.lock().unwrap();
        *unacked = unacked.saturating_sub(bytes);
        drop(unacked);
        self.notify.notify_waiters();
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn unacked(&self) -> u64 {
        *self.unacked.lock().unwrap()
    }
}

/// Where a body coming in goes.
struct BodyFeed {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    buffered: Arc<AtomicU64>,
}

/// A body coming in: each chunk taken is acknowledged.
pub struct BodyReceiver {
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    buffered: Arc<AtomicU64>,
    peer: Peer,
    id: u64,
    response: bool,
}

impl BodyReceiver {
    /// The next chunk; None at the end of the body.
    pub async fn chunk(&mut self) -> Option<Vec<u8>> {
        let chunk = self.rx.recv().await?;
        let bytes = chunk.len() as u64;
        self.buffered.fetch_sub(bytes, Ordering::AcqRel);
        if bytes > 0 {
            self.peer.send(&Message::Ack {
                id: self.id,
                response: self.response,
                bytes,
            });
        }
        Some(chunk)
    }

    /// The whole body.
    pub async fn read_all(mut self) -> Vec<u8> {
        let mut all = Vec::new();
        while let Some(chunk) = self.chunk().await {
            all.extend(chunk);
        }
        all
    }

    /// Bytes received and not taken yet.
    pub fn buffered(&self) -> u64 {
        self.buffered.load(Ordering::Acquire)
    }
}

type Pending = oneshot::Sender<Result<Value, RpcError>>;
type PendingHttp = oneshot::Sender<Result<HttpReply, RpcError>>;

struct Inner {
    queue: Mutex<OutboundQueue<Outgoing>>,
    wake_writer: Notify,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    pending_http: Mutex<HashMap<u64, PendingHttp>>,
    /// Response bodies of our requests, by our id.
    response_bodies: Mutex<HashMap<u64, BodyFeed>>,
    /// Request bodies of the other side's requests, by its id.
    request_bodies: Mutex<HashMap<u64, BodyFeed>>,
    /// Bodies we send: (id, whether a response's).
    windows: Mutex<HashMap<(u64, bool), Arc<Window>>>,
    /// The other side's requests being answered.
    tasks: Mutex<HashMap<u64, AbortHandle>>,
    unknown_logged: Mutex<HashSet<String>>,
    closed: watch::Sender<bool>,
    last_rx: AtomicU64,
    last_tx: AtomicU64,
    ping_n: AtomicU64,
    handler: Arc<dyn Handler>,
    options: PeerOptions,
}

/// A running side of the channel; clones share it.
#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
}

/// The handshake failed.
#[derive(Debug, thiserror::Error)]
pub enum HandshakeError {
    #[error("refused: {0}")]
    Refused(String),
    #[error("the channel closed during the handshake")]
    Closed,
    #[error("protocol: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

async fn next_message(stream: &mut BoxStream) -> Result<Message, HandshakeError> {
    match read_frame(stream, MAX_CHANNEL_FRAME).await? {
        None => Err(HandshakeError::Closed),
        Some((KIND_MESSAGE, payload)) => serde_json::from_slice(&payload)
            .map_err(|error| HandshakeError::Protocol(error.to_string())),
        Some((kind, _)) => Err(HandshakeError::Protocol(format!(
            "a frame of kind {kind} first"
        ))),
    }
}

async fn write_message(stream: &mut BoxStream, message: &Message) -> io::Result<()> {
    stream.write_all(&encode_message(message)).await?;
    stream.flush().await
}

/// The connecting side: says `hello`, gives the `welcome`.
pub async fn say_hello(stream: &mut BoxStream, hello: &Message) -> Result<Message, HandshakeError> {
    write_message(stream, hello).await?;
    match next_message(stream).await? {
        welcome @ Message::Welcome { .. } => {
            if let Message::Welcome { protocol, .. } = &welcome
                && *protocol != PROTOCOL
            {
                return Err(HandshakeError::Protocol(format!(
                    "the front speaks protocol {protocol}"
                )));
            }
            Ok(welcome)
        }
        Message::Refused { reason } => Err(HandshakeError::Refused(reason)),
        other => Err(HandshakeError::Protocol(format!(
            "{other:?} instead of welcome"
        ))),
    }
}

/// Equal strings, in time that does not depend on where they differ.
pub fn same_token(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    let mut difference = (given.len() != expected.len()) as u8;
    for (index, byte) in expected.iter().enumerate() {
        difference |= byte ^ given.get(index).copied().unwrap_or(0);
    }
    difference == 0
}

/// The listening side: reads `hello`, checks the token and protocol, and
/// answers `welcome` (built from the hello by `welcome`) or `refused`.
pub async fn accept_hello(
    stream: &mut BoxStream,
    token: &str,
    welcome: impl FnOnce(&Message) -> Message,
) -> Result<Message, HandshakeError> {
    let hello = next_message(stream).await?;
    let Message::Hello {
        protocol,
        token: given,
        ..
    } = &hello
    else {
        return Err(HandshakeError::Protocol(format!(
            "{hello:?} instead of hello"
        )));
    };
    let refusal = if !same_token(given, token) {
        Some("wrong token".to_owned())
    } else if *protocol != PROTOCOL {
        Some(format!("protocol {protocol}, this side speaks {PROTOCOL}"))
    } else {
        None
    };
    if let Some(reason) = refusal {
        write_message(
            stream,
            &Message::Refused {
                reason: reason.clone(),
            },
        )
        .await?;
        let _ = stream.shutdown().await;
        return Err(HandshakeError::Refused(reason));
    }
    write_message(stream, &welcome(&hello)).await?;
    Ok(hello)
}

/// Removes a pending request when its future is dropped before the answer,
/// and tells the other side.
struct CancelGuard<'a> {
    peer: &'a Peer,
    id: u64,
    http: bool,
    done: bool,
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let inner = &self.peer.inner;
        let removed = if self.http {
            inner
                .pending_http
                .lock()
                .unwrap()
                .remove(&self.id)
                .is_some()
        } else {
            inner.pending.lock().unwrap().remove(&self.id).is_some()
        };
        if removed {
            self.peer.send(&Message::Cancel { id: self.id });
        }
    }
}

impl Peer {
    /// Runs a side over a stream whose handshake is done.
    pub fn start(stream: BoxStream, handler: Arc<dyn Handler>, options: PeerOptions) -> Self {
        let (closed, _) = watch::channel(false);
        let now = options.clock.monotonic() as u64;
        let peer = Self {
            inner: Arc::new(Inner {
                queue: Mutex::new(OutboundQueue::new()),
                wake_writer: Notify::new(),
                next_id: AtomicU64::new(1),
                pending: Mutex::default(),
                pending_http: Mutex::default(),
                response_bodies: Mutex::default(),
                request_bodies: Mutex::default(),
                windows: Mutex::default(),
                tasks: Mutex::default(),
                unknown_logged: Mutex::default(),
                closed,
                last_rx: AtomicU64::new(now),
                last_tx: AtomicU64::new(now),
                ping_n: AtomicU64::new(0),
                handler,
                options,
            }),
        };
        let (reader, writer) = tokio::io::split(stream);
        tokio::spawn(peer.clone().write_loop(writer));
        tokio::spawn(peer.clone().read_loop(reader));
        if peer.inner.options.ping_after.is_some() || peer.inner.options.dead_after.is_some() {
            tokio::spawn(peer.clone().liveness());
        }
        peer
    }

    /// Whether the channel closed.
    pub fn is_closed(&self) -> bool {
        *self.inner.closed.borrow()
    }

    /// Resolves once the channel closed.
    pub async fn closed(&self) {
        let mut closed = self.inner.closed.subscribe();
        let _ = closed.wait_for(|closed| *closed).await;
    }

    fn now(&self) -> u64 {
        self.inner.options.clock.monotonic() as u64
    }

    fn enqueue(&self, frame: Vec<u8>, key: Option<String>) {
        if self.is_closed() {
            return;
        }
        self.inner
            .queue
            .lock()
            .unwrap()
            .enqueue(Outgoing::Frame(frame), key);
        self.inner.wake_writer.notify_one();
    }

    /// Queues a message.
    pub fn send(&self, message: &Message) {
        self.enqueue(encode_message(message), None);
    }

    /// Queues a push; a queued push with the same key is replaced.
    pub fn push(&self, push: Push) {
        let key = push.key.clone();
        self.enqueue(encode_message(&Message::Push(push)), key);
    }

    /// Tells the other side the owners table.
    pub fn owner(&self, owners: BTreeMap<String, Side>, shadow: ShadowSettings) {
        self.send(&Message::Owner { owners, shadow });
    }

    fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn request(&self, id: u64, message: Message) -> Result<Value, RpcError> {
        if self.is_closed() {
            return Err(RpcError::closed());
        }
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id, tx);
        let mut guard = CancelGuard {
            peer: self,
            id,
            http: false,
            done: false,
        };
        self.send(&message);
        let answer = rx.await.unwrap_or_else(|_| Err(RpcError::closed()));
        guard.done = true;
        answer
    }

    /// A browser RPC to the other side.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        ctx: Ctx,
        shadow: bool,
    ) -> Result<Value, RpcError> {
        let id = self.next_id();
        let message = Message::Call {
            id,
            method: method.into(),
            params,
            ctx,
            shadow,
        };
        self.request(id, message).await
    }

    /// A call into what the other side owns.
    pub async fn reverse_call(
        &self,
        target: &str,
        args: Value,
        ctx: Ctx,
    ) -> Result<Value, RpcError> {
        let id = self.next_id();
        let message = Message::ReverseCall {
            id,
            target: target.into(),
            args,
            ctx,
        };
        self.request(id, message).await
    }

    /// An HTTP request to the other side; its body, when it has one, from
    /// `body`.
    pub async fn http(
        &self,
        request: HttpRequest,
        body: Option<mpsc::Receiver<Vec<u8>>>,
    ) -> Result<HttpReply, RpcError> {
        if self.is_closed() {
            return Err(RpcError::closed());
        }
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.inner.pending_http.lock().unwrap().insert(id, tx);
        let mut guard = CancelGuard {
            peer: self,
            id,
            http: true,
            done: false,
        };
        self.send(&Message::Http {
            id,
            method: request.method,
            url: request.url,
            headers: request.headers,
            ctx: request.ctx,
            body: body.is_some(),
        });
        if let Some(body) = body {
            let peer = self.clone();
            tokio::spawn(async move {
                let _ = peer.send_body(id, false, body).await;
            });
        }
        let answer = rx.await.unwrap_or_else(|_| Err(RpcError::closed()));
        guard.done = true;
        answer
    }

    /// Bytes of a body this side sends that the other has not acknowledged.
    pub fn unacked(&self, id: u64, response: bool) -> Option<u64> {
        self.inner
            .windows
            .lock()
            .unwrap()
            .get(&(id, response))
            .map(|window| window.unacked())
    }

    async fn send_body(
        &self,
        id: u64,
        response: bool,
        mut source: mpsc::Receiver<Vec<u8>>,
    ) -> Result<(), RpcError> {
        let window = Arc::new(Window::new());
        self.inner
            .windows
            .lock()
            .unwrap()
            .insert((id, response), window.clone());
        let flags = if response { FLAG_RESPONSE } else { 0 };
        let stream = id as u32;
        let result = async {
            while let Some(piece) = source.recv().await {
                for chunk in piece.chunks(MAX_CHUNK) {
                    window.acquire(chunk.len() as u64).await?;
                    self.enqueue(encode_body(stream, flags, chunk), None);
                }
            }
            if self.is_closed() {
                return Err(RpcError::closed());
            }
            self.enqueue(encode_body(stream, flags | FLAG_END, &[]), None);
            Ok(())
        }
        .await;
        self.inner.windows.lock().unwrap().remove(&(id, response));
        result
    }

    /// Says `bye` and closes the channel once it is written.
    pub fn bye(&self) {
        if self.is_closed() {
            return;
        }
        {
            let mut queue = self.inner.queue.lock().unwrap();
            queue.enqueue(Outgoing::Frame(encode_message(&Message::Bye)), None);
            queue.enqueue(Outgoing::Close, None);
        }
        self.inner.wake_writer.notify_one();
    }

    fn close(&self, reason: &str) {
        let inner = &self.inner;
        if inner.closed.send_replace(true) {
            return;
        }
        tracing::debug!(scope = "core", reason, "core channel closed");
        for (_, pending) in inner.pending.lock().unwrap().drain() {
            let _ = pending.send(Err(RpcError::closed()));
        }
        for (_, pending) in inner.pending_http.lock().unwrap().drain() {
            let _ = pending.send(Err(RpcError::closed()));
        }
        inner.response_bodies.lock().unwrap().clear();
        inner.request_bodies.lock().unwrap().clear();
        for window in inner.windows.lock().unwrap().values() {
            window.close();
        }
        for (_, task) in inner.tasks.lock().unwrap().drain() {
            task.abort();
        }
        inner.queue.lock().unwrap().enqueue(Outgoing::Close, None);
        inner.wake_writer.notify_one();
    }

    async fn write_loop(self, mut writer: WriteHalf<BoxStream>) {
        loop {
            let notified = self.inner.wake_writer.notified();
            let next = self.inner.queue.lock().unwrap().take();
            match next {
                Some(Outgoing::Frame(bytes)) => {
                    if let Err(error) = writer.write_all(&bytes).await {
                        self.close(&format!("write failed: {error}"));
                        break;
                    }
                    self.inner.last_tx.store(self.now(), Ordering::Release);
                }
                Some(Outgoing::Close) => {
                    let _ = writer.flush().await;
                    let _ = writer.shutdown().await;
                    self.close("closed");
                    break;
                }
                None => {
                    let _ = writer.flush().await;
                    notified.await;
                }
            }
        }
    }

    async fn read_loop(self, mut reader: ReadHalf<BoxStream>) {
        loop {
            let frame = match read_frame(&mut reader, MAX_CHANNEL_FRAME).await {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    self.close("the other side closed the channel");
                    return;
                }
                Err(error) => {
                    self.close(&format!("read failed: {error}"));
                    return;
                }
            };
            self.inner.last_rx.store(self.now(), Ordering::Release);
            let keep_going = match frame {
                (KIND_MESSAGE, payload) => self.on_message(&payload),
                (KIND_BODY, payload) => self.on_body(&payload),
                (kind, _) => {
                    self.close(&format!("a frame of unknown kind {kind}"));
                    false
                }
            };
            if !keep_going {
                return;
            }
        }
    }

    async fn liveness(self) {
        let options = self.inner.options.clone();
        let mut ticker = options.clock.interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            if self.is_closed() {
                return;
            }
            let now = self.now();
            if let Some(dead) = options.dead_after
                && now.saturating_sub(self.inner.last_rx.load(Ordering::Acquire))
                    >= dead.as_millis() as u64
            {
                self.close("the other side went silent");
                return;
            }
            if let Some(ping) = options.ping_after
                && now.saturating_sub(self.inner.last_tx.load(Ordering::Acquire))
                    >= ping.as_millis() as u64
            {
                let n = self.inner.ping_n.fetch_add(1, Ordering::Relaxed) + 1;
                self.send(&Message::Ping { n });
            }
        }
    }

    fn log_unknown(&self, what: &str) {
        if self
            .inner
            .unknown_logged
            .lock()
            .unwrap()
            .insert(what.to_owned())
        {
            tracing::debug!(scope = "core", what, "ignored an unknown channel message");
        }
    }

    /// Spawns the answer to the other side's request `id`, cancellable.
    fn spawn_answer(&self, id: u64, work: impl Future<Output = ()> + Send + 'static) {
        let peer = self.clone();
        let mut tasks = self.inner.tasks.lock().unwrap();
        let handle = tokio::spawn(async move {
            work.await;
            peer.inner.tasks.lock().unwrap().remove(&id);
        });
        tasks.insert(id, handle.abort_handle());
    }

    fn reply(&self, id: u64, answer: Result<Value, RpcError>) {
        let message = match answer {
            Ok(result) => Message::Reply {
                id,
                result: Some(result),
                error: None,
            },
            Err(error) => Message::Reply {
                id,
                result: None,
                error: Some(error),
            },
        };
        self.send(&message);
    }

    fn body_feed(&self, id: u64, response: bool) -> BodyReceiver {
        let (tx, rx) = mpsc::unbounded_channel();
        let buffered = Arc::new(AtomicU64::new(0));
        let feed = BodyFeed {
            tx,
            buffered: buffered.clone(),
        };
        let feeds = if response {
            &self.inner.response_bodies
        } else {
            &self.inner.request_bodies
        };
        feeds.lock().unwrap().insert(id, feed);
        BodyReceiver {
            rx,
            buffered,
            peer: self.clone(),
            id,
            response,
        }
    }

    /// Returns false once the channel is to close.
    fn on_message(&self, payload: &[u8]) -> bool {
        let value: Value = match serde_json::from_slice(payload) {
            Ok(value) => value,
            Err(error) => {
                self.close(&format!("a message that is not JSON: {error}"));
                return false;
            }
        };
        let kind = value
            .get("t")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let message: Message = match serde_json::from_value(value) {
            Ok(message) => message,
            Err(error) => {
                self.log_unknown(&format!("{kind}: {error}"));
                return true;
            }
        };
        let handler = self.inner.handler.clone();
        match message {
            Message::Call {
                id,
                method,
                params,
                ctx,
                shadow,
            } => {
                let peer = self.clone();
                self.spawn_answer(id, async move {
                    let call = IncomingCall {
                        id,
                        method,
                        params,
                        ctx,
                        shadow,
                    };
                    let answer = handler.call(&peer, call).await;
                    peer.reply(id, answer);
                });
            }
            Message::ReverseCall {
                id,
                target,
                args,
                ctx,
            } => {
                let peer = self.clone();
                self.spawn_answer(id, async move {
                    let answer = handler.reverse_call(&peer, target, args, ctx).await;
                    peer.reply(id, answer);
                });
            }
            Message::Reply { id, result, error } => {
                let answer = match error {
                    Some(error) => Err(error),
                    None => Ok(result.unwrap_or(Value::Null)),
                };
                if let Some(pending) = self.inner.pending.lock().unwrap().remove(&id) {
                    let _ = pending.send(answer);
                } else if let Some(pending) = self.inner.pending_http.lock().unwrap().remove(&id) {
                    let _ =
                        pending.send(answer.and_then(|_| {
                            Err(RpcError::new("a reply instead of an HTTP response"))
                        }));
                }
            }
            Message::Cancel { id } => {
                if let Some(task) = self.inner.tasks.lock().unwrap().remove(&id) {
                    task.abort();
                }
                self.inner.request_bodies.lock().unwrap().remove(&id);
                if let Some(window) = self.inner.windows.lock().unwrap().remove(&(id, true)) {
                    window.close();
                }
            }
            Message::Push(push) => handler.push(push),
            Message::Owner { owners, shadow } => handler.owner(owners, shadow),
            Message::Http {
                id,
                method,
                url,
                headers,
                ctx,
                body,
            } => {
                let body = body.then(|| self.body_feed(id, false));
                let peer = self.clone();
                self.spawn_answer(id, async move {
                    let request = HttpRequest {
                        method,
                        url,
                        headers,
                        ctx,
                    };
                    match handler.http(&peer, request, body).await {
                        Ok(response) => {
                            peer.send(&Message::HttpResp {
                                id,
                                status: response.status,
                                headers: response.headers,
                                body: response.body.is_some(),
                            });
                            if let Some(body) = response.body {
                                let _ = peer.send_body(id, true, body).await;
                            }
                        }
                        Err(error) => peer.reply(id, Err(error)),
                    }
                });
            }
            Message::HttpResp {
                id,
                status,
                headers,
                body,
            } => {
                if let Some(pending) = self.inner.pending_http.lock().unwrap().remove(&id) {
                    let body = body.then(|| self.body_feed(id, true));
                    let _ = pending.send(Ok(HttpReply {
                        status,
                        headers,
                        body,
                    }));
                }
            }
            Message::Ack {
                id,
                response,
                bytes,
            } => {
                if let Some(window) = self.inner.windows.lock().unwrap().get(&(id, response)) {
                    window.ack(bytes);
                }
            }
            Message::Ping { n } => self.send(&Message::Pong { n }),
            Message::Pong { .. } => {}
            Message::Bye => {
                self.close("the other side said bye");
                return false;
            }
            Message::Hello { .. } | Message::Welcome { .. } | Message::Refused { .. } => {
                self.log_unknown(&format!("{kind} after the handshake"));
            }
            Message::Unknown => self.log_unknown(&kind),
        }
        true
    }

    fn on_body(&self, payload: &[u8]) -> bool {
        let Some(chunk) = decode_body(payload) else {
            self.close("a body frame too short");
            return false;
        };
        let id = u64::from(chunk.stream);
        let response = chunk.flags & FLAG_RESPONSE != 0;
        let feeds = if response {
            &self.inner.response_bodies
        } else {
            &self.inner.request_bodies
        };
        let mut feeds = feeds.lock().unwrap();
        if let Some(feed) = feeds.get(&id) {
            if !chunk.bytes.is_empty() {
                feed.buffered
                    .fetch_add(chunk.bytes.len() as u64, Ordering::AcqRel);
                let _ = feed.tx.send(chunk.bytes);
            }
            if chunk.flags & FLAG_END != 0 {
                feeds.remove(&id);
            }
        }
        true
    }
}
