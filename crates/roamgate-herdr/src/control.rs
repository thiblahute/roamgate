//! The Herdr control client (bridge/herdr-client.ts): one-shot NDJSON
//! requests with shared and briefly reused topology reads, and long-lived
//! event subscriptions.
//!
//! Herdr's wire model: a request is one connection (one request line, one
//! answer line, then Herdr closes); `events.subscribe` keeps its connection
//! open after the acknowledgement and pushes `{ "event": ..., "data": ... }`
//! lines.
//!
//! - Reads in [`SHARED_READS`] join an identical read in flight, and those
//!   in [`REUSED_READS`] reuse an answer for [`READ_REUSE_MS`] after its
//!   request started, unless a Herdr event or a change made through this
//!   client came in since (the read generation). Each caller gets its own
//!   copy, and its own `before_send` check and timeout.
//! - A request line over [`HERDR_MAX_REQUEST_BYTES`] is refused at once:
//!   Herdr drops it without an answer.
//! - Debug lines time each call (`herdr call`), as the TS client does.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use roamgate_base::clock::{SharedClock, SystemClock, timeout};
use roamgate_base::log::{LogFields, LogLevel, Logger};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, watch};

use crate::client::{read_answer, request_id};

/// The longest answer or event line read (1 MiB).
pub const MAX_NDJSON_LINE_BYTES: usize = 1024 * 1024;
/// How long a subscription waits for its acknowledgement.
pub const SUBSCRIPTION_ACK_TIMEOUT_MS: u64 = 8000;
/// The longest request line Herdr reads, not counting its newline (1 MiB:
/// a 1 MiB line is answered by Herdr 0.9.0, one byte more is dropped).
pub const HERDR_MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// How long a topology list's answer is reused.
pub const READ_REUSE_MS: f64 = 1000.0;
/// A call's default timeout.
pub const DEFAULT_CALL_TIMEOUT_MS: u64 = 8000;

/// Reads whose answer does not depend on who asks.
pub const SHARED_READS: &[&str] = &[
    "workspace.list",
    "workspace.get",
    "tab.list",
    "tab.get",
    "pane.list",
    "pane.get",
    "pane.layout",
    "agent.list",
    "agent.get",
];

/// The topology lists every page asks for, reused briefly.
pub const REUSED_READS: &[&str] = &["workspace.list", "tab.list", "pane.list", "agent.list"];

/// Methods that change nothing in Herdr.
const NON_CHANGING: &[&str] = &["ping"];

/// A check run as late as possible before a request's first byte; an error
/// refuses the call and nothing is sent.
pub type BeforeSend = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// What a client tells its listeners (the TS client's EventEmitter).
#[derive(Debug, Clone, PartialEq)]
pub enum ClientEvent {
    /// A Herdr event line, `{ "event": ..., ... }`.
    Event(Value),
    /// A subscription socket's error.
    Error(String),
    /// A subscription socket closed.
    SubscriptionClosed,
}

/// A subscription selector: a bare event type or a parameterized one.
#[derive(Debug, Clone, PartialEq)]
pub enum Subscription {
    Type(String),
    With(Map<String, Value>),
}

impl Subscription {
    fn to_value(&self) -> Value {
        match self {
            Self::Type(name) => json!({ "type": name }),
            Self::With(map) => Value::Object(map.clone()),
        }
    }
}

impl From<&str> for Subscription {
    fn from(value: &str) -> Self {
        Self::Type(value.into())
    }
}

type SharedResult = Shared<BoxFuture<'static, Result<Value, String>>>;

#[derive(Clone)]
struct SharedRead {
    generation: u64,
    started_at: f64,
    result: SharedResult,
}

#[derive(Default)]
struct ReadState {
    generation: u64,
    shared: HashMap<String, SharedRead>,
    reused: HashMap<String, SharedRead>,
}

struct Inner {
    socket_path: String,
    logger: Logger,
    connection_id: Option<String>,
    clock: SharedClock,
    read_reuse_ms: f64,
    reads: Mutex<ReadState>,
    events: broadcast::Sender<ClientEvent>,
}

/// How a [`HerdrClient`] is made; unset parts are the defaults.
#[derive(Default)]
pub struct HerdrClientOptions {
    pub logger: Option<Logger>,
    pub connection_id: Option<String>,
    pub clock: Option<SharedClock>,
    pub read_reuse_ms: Option<f64>,
}

/// One Herdr server's control client. Clones are the same client.
#[derive(Clone)]
pub struct HerdrClient {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for HerdrClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HerdrClient")
            .field("socket_path", &self.inner.socket_path)
            .finish_non_exhaustive()
    }
}

/// An io error as Node words it: `<CODE>: <message>`.
pub fn io_error_text(error: &std::io::Error) -> String {
    use std::io::ErrorKind;
    let code = match error.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::ConnectionRefused => "ECONNREFUSED",
        ErrorKind::PermissionDenied => "EACCES",
        ErrorKind::ConnectionReset => "ECONNRESET",
        ErrorKind::BrokenPipe => "EPIPE",
        ErrorKind::TimedOut => "ETIMEDOUT",
        ErrorKind::InvalidInput => "EINVAL",
        _ => "error",
    };
    format!("{code}: {error}")
}

/// Bytes of the first answer line, or why there is none.
enum Line {
    Found(Vec<u8>),
    TooLarge,
}

fn take_line(buffer: &[u8]) -> Option<Line> {
    if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
        return Some(Line::Found(buffer[..end].to_vec()));
    }
    (buffer.len() > MAX_NDJSON_LINE_BYTES).then_some(Line::TooLarge)
}

#[cfg(unix)]
type Stream = tokio::net::UnixStream;
#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

async fn connect(path: &str) -> std::io::Result<Stream> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await
    }
    #[cfg(windows)]
    {
        tokio::net::windows::named_pipe::ClientOptions::new().open(path)
    }
}

/// What a request measured, for the debug line.
#[derive(Default)]
struct Timing {
    written_at: Option<f64>,
    first_byte_at: Option<f64>,
    response_bytes: usize,
}

impl HerdrClient {
    pub fn new(socket_path: impl Into<String>, options: HerdrClientOptions) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(Inner {
                socket_path: socket_path.into(),
                logger: options.logger.unwrap_or_else(Logger::silent),
                connection_id: options.connection_id,
                clock: options.clock.unwrap_or_else(|| Arc::new(SystemClock)),
                read_reuse_ms: options.read_reuse_ms.unwrap_or(READ_REUSE_MS),
                reads: Mutex::default(),
                events,
            }),
        }
    }

    pub fn socket_path(&self) -> &str {
        &self.inner.socket_path
    }

    /// Listeners of events, subscription errors and closes.
    pub fn events(&self) -> broadcast::Receiver<ClientEvent> {
        self.inner.events.subscribe()
    }

    fn emit(&self, event: ClientEvent) {
        let _ = self.inner.events.send(event);
    }

    fn reads(&self) -> std::sync::MutexGuard<'_, ReadState> {
        self.inner.reads.lock().expect("herdr reads")
    }

    /// Forgets shared and reused reads: Herdr's state may have changed.
    pub fn invalidate_reads(&self) {
        let mut reads = self.reads();
        reads.generation += 1;
        reads.shared.clear();
        reads.reused.clear();
    }

    /// A call with the defaults: 8 s, no check, not fresh.
    pub async fn call_simple(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call(method, params, DEFAULT_CALL_TIMEOUT_MS, None, false)
            .await
    }

    /// Herdr RPC (see the module's description); `fresh` asks Herdr anew.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
        fresh: bool,
    ) -> Result<Value, String> {
        let params = match params {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => Map::new(),
        };
        if SHARED_READS.contains(&method) {
            return self
                .shared_read(method, params, timeout_ms, before_send, fresh)
                .await;
        }
        if NON_CHANGING.contains(&method) {
            return self.request(method, params, timeout_ms, before_send).await;
        }
        self.invalidate_reads();
        let result = self.request(method, params, timeout_ms, before_send).await;
        self.invalidate_reads();
        result
    }

    async fn shared_read(
        &self,
        method: &str,
        params: Map<String, Value>,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
        fresh: bool,
    ) -> Result<Value, String> {
        let key = format!(
            "{method}\n{}",
            serde_json::to_string(&params).unwrap_or_default()
        );
        let now = self.inner.clock.monotonic();
        let (read, reuse) = {
            let mut reads = self.reads();
            let generation = reads.generation;
            let reusable = reads.reused.get(&key).cloned();
            let in_flight = reads.shared.get(&key).cloned();
            match (reusable, in_flight) {
                (Some(kept), _)
                    if !fresh
                        && kept.generation == generation
                        && now - kept.started_at < self.inner.read_reuse_ms =>
                {
                    (kept, Some("cache"))
                }
                (_, Some(flying)) if !fresh && flying.generation == generation => {
                    (flying, Some("in_flight"))
                }
                _ => {
                    let started = self.start_shared(&mut reads, &key, method, params, timeout_ms);
                    (started, None)
                }
            }
        };
        if let Some(reuse) = reuse
            && self.inner.logger.enabled(LogLevel::Debug)
        {
            let this = self.clone();
            let method = method.to_owned();
            let result = read.result.clone();
            let started_at = read.started_at;
            tokio::spawn(async move {
                if result.await.is_ok() {
                    let end = this.inner.clock.monotonic();
                    let mut fields = LogFields::new();
                    if let Some(id) = &this.inner.connection_id {
                        fields.insert("connection".into(), json!(id));
                    }
                    fields.insert("method".into(), json!(method));
                    fields.insert("reuse".into(), json!(reuse));
                    fields.insert("total_ms".into(), json!((end - now).round() as i64));
                    fields.insert("age_ms".into(), json!((end - started_at).round() as i64));
                    this.inner.logger.debug("herdr call reused", Some(&fields));
                }
            });
        }
        if let Some(check) = before_send {
            check()?;
        }
        if reuse == Some("in_flight") {
            let clock = self.inner.clock.clone();
            return timeout(
                clock.as_ref(),
                Duration::from_millis(timeout_ms),
                read.result,
            )
            .await
            .unwrap_or_else(|_| Err(format!("timeout: {method}")));
        }
        read.result.await
    }

    /// Starts a shared read's request; it runs on its own, whoever waits.
    fn start_shared(
        &self,
        reads: &mut ReadState,
        key: &str,
        method: &str,
        params: Map<String, Value>,
        timeout_ms: u64,
    ) -> SharedRead {
        let generation = reads.generation;
        let started_at = self.inner.clock.monotonic();
        let this = self.clone();
        let task_method = method.to_owned();
        let handle =
            tokio::spawn(async move { this.request(&task_method, params, timeout_ms, None).await });
        let result: SharedResult = async move {
            handle
                .await
                .unwrap_or_else(|error| Err(format!("Herdr request failed: {error}")))
        }
        .boxed()
        .shared();
        let started = SharedRead {
            generation,
            started_at,
            result: result.clone(),
        };
        reads.shared.insert(key.to_owned(), started.clone());
        let kept = started.clone();
        let this = self.clone();
        let key = key.to_owned();
        let reused = REUSED_READS.contains(&method);
        tokio::spawn(async move {
            let ok = result.await.is_ok();
            let mut reads = this.reads();
            if reads.shared.get(&key).is_some_and(|entry| {
                entry.started_at == started_at && entry.generation == generation
            }) {
                reads.shared.remove(&key);
            }
            // Never replace an answer with one Herdr was asked for earlier.
            if ok
                && reused
                && reads.generation == generation
                && reads
                    .reused
                    .get(&key)
                    .is_none_or(|kept| kept.started_at <= started_at)
            {
                reads.reused.insert(key, kept);
            }
        });
        started
    }

    /// One-shot request: connect, send one line, read one line, close.
    async fn request(
        &self,
        method: &str,
        params: Map<String, Value>,
        timeout_ms: u64,
        before_send: Option<BeforeSend>,
    ) -> Result<Value, String> {
        let id = request_id(self.inner.clock.as_ref());
        let request = format!(
            "{}\n",
            json!({ "id": id, "method": method, "params": params })
        );
        let line_bytes = request.len() - 1;
        if line_bytes > HERDR_MAX_REQUEST_BYTES {
            return Err(format!(
                "{method}: too large for Herdr ({} KiB, at most 1024)",
                line_bytes.div_ceil(1024)
            ));
        }
        let clock = self.inner.clock.clone();
        let started_at = clock.monotonic();
        let timing = Arc::new(Mutex::new(Timing::default()));
        let work = self.exchange(request.as_bytes(), &id, method, before_send, timing.clone());
        let outcome = timeout(clock.as_ref(), Duration::from_millis(timeout_ms), work)
            .await
            .unwrap_or_else(|_| Err(format!("timeout: {method}")));
        if self.inner.logger.enabled(LogLevel::Debug) {
            let finished_at = clock.monotonic();
            let timing = timing.lock().expect("timing");
            let mut fields = LogFields::new();
            if let Some(id) = &self.inner.connection_id {
                fields.insert("connection".into(), json!(id));
            }
            fields.insert("method".into(), json!(method));
            fields.insert(
                "status".into(),
                json!(if outcome.is_ok() { "ok" } else { "error" }),
            );
            fields.insert("req_bytes".into(), json!(request.len()));
            fields.insert("resp_bytes".into(), json!(timing.response_bytes));
            fields.insert(
                "total_ms".into(),
                json!((finished_at - started_at).round() as i64),
            );
            if let Some(written) = timing.written_at {
                fields.insert(
                    "connect_ms".into(),
                    json!((written - started_at).round() as i64),
                );
                if let Some(first) = timing.first_byte_at {
                    fields.insert(
                        "first_byte_ms".into(),
                        json!((first - written).round() as i64),
                    );
                }
            }
            if let Err(error) = &outcome {
                fields.insert("error".into(), json!(error));
            }
            self.inner.logger.debug("herdr call", Some(&fields));
        }
        outcome
    }

    async fn exchange(
        &self,
        request: &[u8],
        id: &str,
        method: &str,
        before_send: Option<BeforeSend>,
        timing: Arc<Mutex<Timing>>,
    ) -> Result<Value, String> {
        let mut stream = connect(&self.inner.socket_path)
            .await
            .map_err(|error| io_error_text(&error))?;
        if let Some(check) = before_send {
            // Dropping the stream closes it with nothing sent.
            check()?;
        }
        stream
            .write_all(request)
            .await
            .map_err(|error| io_error_text(&error))?;
        let clock = self.inner.clock.clone();
        timing.lock().expect("timing").written_at = Some(clock.monotonic());
        let mut buffer = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|error| io_error_text(&error))?;
            if read == 0 {
                return Err(format!("connection closed before response: {method}"));
            }
            {
                let mut timing = timing.lock().expect("timing");
                timing
                    .first_byte_at
                    .get_or_insert_with(|| clock.monotonic());
                timing.response_bytes += read;
            }
            buffer.extend_from_slice(&chunk[..read]);
            match take_line(&buffer) {
                None => continue,
                Some(Line::TooLarge) => return Err("Herdr response line is too large".into()),
                Some(Line::Found(line)) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if trimmed.len() > MAX_NDJSON_LINE_BYTES {
                        return Err("Herdr response line is too large".into());
                    }
                    return read_answer(trimmed, id);
                }
            }
        }
    }

    /// `ping`: the server's identity (`version`, `protocol`, ...).
    pub async fn ping(&self) -> Result<Value, String> {
        self.request("ping", Map::new(), DEFAULT_CALL_TIMEOUT_MS, None)
            .await
    }

    /// A long-lived event subscription (needs a tokio runtime).
    pub fn subscribe(&self, types: &[Subscription], ack_timeout_ms: u64) -> EventSubscription {
        let (ready_tx, ready_rx) = watch::channel::<Option<Result<(), String>>>(None);
        let (closed_tx, closed_rx) = watch::channel(false);
        let (close_tx, close_rx) = watch::channel(false);
        let request = format!(
            "{}\n",
            json!({
                "id": "sub",
                "method": "events.subscribe",
                "params": { "subscriptions": types.iter().map(Subscription::to_value).collect::<Vec<_>>() },
            })
        );
        let this = self.clone();
        tokio::spawn(async move {
            this.run_subscription(request, ack_timeout_ms.max(1), ready_tx, close_rx)
                .await;
            let _ = closed_tx.send(true);
            this.emit(ClientEvent::SubscriptionClosed);
        });
        EventSubscription {
            ready: wait_ready(ready_rx),
            closed: wait_closed(closed_rx),
            close: Arc::new(close_tx),
        }
    }

    async fn run_subscription(
        &self,
        request: String,
        ack_timeout_ms: u64,
        ready: watch::Sender<Option<Result<(), String>>>,
        mut close: watch::Receiver<bool>,
    ) {
        let settle = |outcome: Result<(), String>| {
            ready.send_if_modified(|state| {
                if state.is_some() {
                    return false;
                }
                *state = Some(outcome);
                true
            });
        };
        let clock = self.inner.clock.clone();
        let ack_deadline = clock.sleep(Duration::from_millis(ack_timeout_ms));
        tokio::pin!(ack_deadline);
        let acked = AtomicBool::new(false);
        let closed_before = "subscription closed before acknowledgement";
        let connect = connect(&self.inner.socket_path);
        let mut stream = tokio::select! {
            stream = connect => match stream {
                Ok(stream) => stream,
                Err(error) => {
                    let text = io_error_text(&error);
                    self.emit(ClientEvent::Error(text.clone()));
                    settle(Err(text));
                    return;
                }
            },
            _ = close.wait_for(|closed| *closed) => {
                settle(Err(closed_before.into()));
                return;
            }
            () = &mut ack_deadline => {
                settle(Err("subscription acknowledgement timed out".into()));
                return;
            }
        };
        if let Err(error) = stream.write_all(request.as_bytes()).await {
            let text = io_error_text(&error);
            self.emit(ClientEvent::Error(text.clone()));
            settle(Err(text));
            return;
        }
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let read = tokio::select! {
                read = stream.read(&mut chunk) => read,
                _ = close.wait_for(|closed| *closed) => {
                    if !acked.load(Ordering::Relaxed) {
                        settle(Err(closed_before.into()));
                    }
                    return;
                }
                () = &mut ack_deadline, if !acked.load(Ordering::Relaxed) => {
                    settle(Err("subscription acknowledgement timed out".into()));
                    return;
                }
            };
            let read = match read {
                Ok(0) => {
                    if !acked.load(Ordering::Relaxed) {
                        settle(Err(closed_before.into()));
                    }
                    return;
                }
                Ok(read) => read,
                Err(error) => {
                    let text = io_error_text(&error);
                    self.emit(ClientEvent::Error(text.clone()));
                    if !acked.load(Ordering::Relaxed) {
                        settle(Err(text));
                    }
                    return;
                }
            };
            buffer.extend_from_slice(&chunk[..read]);
            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = buffer.drain(..=end).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                let line = text.trim();
                if line.is_empty() {
                    continue;
                }
                if line.len() > MAX_NDJSON_LINE_BYTES {
                    settle(Err("Herdr subscription line is too large".into()));
                    return;
                }
                let message: Value = match serde_json::from_str(line) {
                    Ok(message) => message,
                    Err(_) => {
                        if !acked.load(Ordering::Relaxed) {
                            settle(Err("bad subscription JSON from Herdr".into()));
                            return;
                        }
                        continue;
                    }
                };
                if !acked.load(Ordering::Relaxed) {
                    let Value::Object(envelope) = &message else {
                        settle(Err("invalid subscription acknowledgement".into()));
                        return;
                    };
                    let has_result = envelope.contains_key("result");
                    let has_error = envelope.contains_key("error");
                    if envelope.get("id").and_then(Value::as_str) != Some("sub")
                        || has_result == has_error
                    {
                        settle(Err("invalid subscription acknowledgement".into()));
                        return;
                    }
                    acked.store(true, Ordering::Relaxed);
                    if has_error {
                        let message = envelope
                            .get("error")
                            .and_then(Value::as_object)
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("subscribe failed");
                        settle(Err(message.into()));
                        return;
                    }
                    // Events may have been missed while not subscribed.
                    self.invalidate_reads();
                    settle(Ok(()));
                    continue;
                }
                if message.get("event").is_some_and(Value::is_string) {
                    self.invalidate_reads();
                    self.emit(ClientEvent::Event(message));
                }
            }
            if buffer.len() > MAX_NDJSON_LINE_BYTES {
                settle(Err("Herdr subscription line is too large".into()));
                return;
            }
        }
    }
}

/// A subscription's handles: `ready` once acknowledged, `closed` once its
/// socket closed, `close()` ends it (twice is harmless).
#[derive(Clone)]
pub struct EventSubscription {
    pub ready: Shared<BoxFuture<'static, Result<(), String>>>,
    pub closed: Shared<BoxFuture<'static, ()>>,
    close: Arc<watch::Sender<bool>>,
}

impl EventSubscription {
    pub fn close(&self) {
        let _ = self.close.send(true);
    }
}

fn wait_ready(
    mut ready: watch::Receiver<Option<Result<(), String>>>,
) -> Shared<BoxFuture<'static, Result<(), String>>> {
    async move {
        let waited = ready
            .wait_for(Option::is_some)
            .await
            .map(|state| state.clone());
        match waited {
            Ok(state) => state.unwrap_or(Ok(())),
            Err(_) => {
                let state = ready.borrow().clone();
                state.unwrap_or_else(|| Err("subscription closed before acknowledgement".into()))
            }
        }
    }
    .boxed()
    .shared()
}

fn wait_closed(mut closed: watch::Receiver<bool>) -> Shared<BoxFuture<'static, ()>> {
    async move {
        let _ = closed.wait_for(|closed| *closed).await;
    }
    .boxed()
    .shared()
}

#[cfg(test)]
mod tests;
