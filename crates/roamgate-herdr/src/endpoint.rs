//! A client-owned shell connection to a Herdr >= 0.9.0 server over
//! herdr-client.sock, speaking the stable endpoint generation 1 contract
//! (bridge/endpoint-client.ts): bincode-envelope `EndpointControl` with
//! JSON payloads, the frozen PaneSurface and PaneSurfacePatch codecs and
//! the negotiated delta and reuse controls ([`surface`]), semantic input
//! ([`input`]), Herdr's semantic notifications ([`notification`]) and the
//! creation from a browser terminal ([`creation`]).
//!
//! `connect` waits for the welcome and the first valid `shell.snapshot.v1`,
//! so endpoint methods can use its boot id. Full surfaces replace the
//! composed frame; patches are applied to it. Listeners only ever see a
//! complete surface per [`EndpointEvent::Surface`], told in order on the
//! connection's reader as Bun's EventEmitter told them.

pub mod creation;
pub mod input;
pub mod notification;
pub mod surface;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use crate::BoxFuture;
use crate::control::io_error_text;
use crate::thin::{BinReader, BinWriter, connect_stream, encode_frame};
use input::{PaneInputEvent, encode_pane_input};
use notification::{SemanticNotification, read_semantic_notification};
use surface::{
    SURFACE_DELTA_KIND, SURFACE_REUSE_KIND, SurfaceBaseline, apply_surface_patch,
    read_full_surface, read_surface_delta, read_surface_reuse,
};

const HANDSHAKE_TIMEOUT_MS: u64 = 8_000;
/// Further wakes while the welcome has not come, after the first one.
const ENDPOINT_WAKE_RETRY_MS: [u64; 2] = [30, 70];
const ENDPOINT_GENERATION: u64 = 1;
const HELLO_KIND: &str = "endpoint.hello.v1";
const WELCOME_KIND: &str = "endpoint.welcome.v1";
const SNAPSHOT_KIND: &str = "shell.snapshot.v1";
const HEALTH_PING_KIND: &str = "endpoint.health.ping.v1";
const HEALTH_PONG_KIND: &str = "endpoint.health.pong.v1";
const MAX_FRAME: usize = 32 * 1024 * 1024;

/// ClientMessage tags of the stable endpoint contract (frozen for
/// generation 1: compatible behaviour comes through EndpointControl).
mod cm {
    pub const CLIENT_SHELL_RESIZE: u64 = 12;
    pub const CLIENT_SHELL_ENDPOINT_REQUEST: u64 = 15;
    pub const ENDPOINT_CONTROL: u64 = 20;
}

/// ServerMessage tags (frozen for generation 1).
mod sm {
    pub const WELCOME: u64 = 0;
    pub const CLIPBOARD: u64 = 5;
    pub const CLIENT_SHELL_SNAPSHOT: u64 = 12;
    pub const PANE_SURFACE: u64 = 13;
    pub const SEMANTIC_NOTIFICATION: u64 = 14;
    pub const CLIENT_SHELL_ERROR: u64 = 15;
    pub const CLIENT_SHELL_ENDPOINT_RESPONSE_CHUNK: u64 = 18;
    pub const PANE_SURFACE_PATCH: u64 = 19;
    pub const ENDPOINT_CONTROL: u64 = 20;
}

/// `terminal` clients render one pane. A `notifications` client is a
/// passive shell (`surface_active: false`): Herdr never makes it the
/// foreground client or a tab geometry controller, but still delivers
/// SemanticNotification to it. Only that role tells semantic
/// notifications, so Herdr's one-per-shell delivery is not multiplied by
/// the number of open terminal views.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointRole {
    Terminal,
    Notifications,
}

/// What the welcome advertised, on this socket only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointWelcome {
    pub generation: u64,
    /// None when the welcome named no version (`undefined` in Bun).
    pub server_version: Option<Value>,
    pub methods: Vec<String>,
    pub capabilities: Vec<String>,
}

impl EndpointWelcome {
    /// `{generation, serverVersion, methods, capabilities}`, as the attach
    /// reply and the workspace list's availability carry it.
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("generation".into(), json!(self.generation));
        if let Some(version) = &self.server_version {
            object.insert("serverVersion".into(), version.clone());
        }
        object.insert("methods".into(), json!(self.methods));
        object.insert("capabilities".into(), json!(self.capabilities));
        Value::Object(object)
    }
}

/// What an endpoint client tells its listeners.
#[derive(Debug, Clone)]
pub enum EndpointEvent {
    Welcome(EndpointWelcome),
    Snapshot {
        boot_id: String,
        raw: Value,
    },
    Surface(Arc<SurfaceBaseline>),
    /// Tagged 0.9.0: one base64 string, with no producing pane identity.
    Clipboard(String),
    SemanticNotification(SemanticNotification),
    NotificationError(String),
    ShellError(String),
    Error(String),
    Close,
}

pub type Listener = Arc<dyn Fn(&EndpointEvent) + Send + Sync>;

struct Pending {
    reply: oneshot::Sender<Result<Value, String>>,
    chunks: Vec<String>,
}

#[derive(Default)]
struct State {
    started: bool,
    closed: bool,
    welcomed: bool,
    welcome: Option<EndpointWelcome>,
    pending_welcome: Option<oneshot::Sender<Result<(), String>>>,
    surface: Option<Arc<SurfaceBaseline>>,
    boot_id: String,
    request_seq: u64,
    pending: HashMap<String, Pending>,
    writer: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

struct Inner {
    socket_path: String,
    surface_codecs: bool,
    role: EndpointRole,
    clock: SharedClock,
    state: Mutex<State>,
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_listener: AtomicU64,
    stop: watch::Sender<bool>,
}

/// One shell connection. Clones are the same connection.
#[derive(Clone)]
pub struct EndpointClient {
    inner: Arc<Inner>,
}

/// The welcome's checks: an error names what failed.
fn parse_welcome(data: &str) -> Result<EndpointWelcome, String> {
    let parsed: Value =
        serde_json::from_str(data).map_err(|_| "malformed endpoint welcome".to_owned())?;
    if let Some(error) = parsed.get("error").filter(|error| truthy(error)) {
        let text = |key: &str| match error.get(key) {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        return Err(format!(
            "Herdr rejected endpoint hello ({}): {}",
            text("code"),
            text("message")
        ));
    }
    if parsed.get("generation").and_then(Value::as_u64) != Some(ENDPOINT_GENERATION)
        || parsed["snapshot_codec"] != "shell.snapshot.v1"
        || parsed["surface_codec"] != "shell.surface.v1"
        || parsed["input_codec"] != "shell.input.semantic.v1"
        || parsed["blob_codec"] != "shell.blob.v1"
    {
        return Err("Unsupported Herdr endpoint generation or codecs".into());
    }
    let mut lists = [Vec::new(), Vec::new()];
    for (index, field) in ["methods", "capabilities"].into_iter().enumerate() {
        match parsed.get(field) {
            None => {}
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
                lists[index] = items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect();
            }
            Some(_) => return Err(format!("Malformed Herdr endpoint {field}")),
        }
    }
    let [methods, capabilities] = lists;
    Ok(EndpointWelcome {
        generation: ENDPOINT_GENERATION,
        server_version: parsed.get("server_version").cloned(),
        methods,
        capabilities,
    })
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

fn control(kind: &str, data: &str) -> Vec<u8> {
    let mut writer = BinWriter::new();
    writer.variant(cm::ENDPOINT_CONTROL);
    writer.string(kind);
    writer.string(data);
    writer.into_bytes()
}

impl EndpointClient {
    pub fn new(
        socket_path: impl Into<String>,
        surface_codecs: bool,
        role: EndpointRole,
        clock: Option<SharedClock>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                socket_path: socket_path.into(),
                surface_codecs,
                role,
                clock: clock.unwrap_or_else(|| Arc::new(SystemClock)),
                state: Mutex::default(),
                listeners: Mutex::default(),
                next_listener: AtomicU64::new(1),
                stop: watch::channel(false).0,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().expect("endpoint client")
    }

    /// Adds a listener; its id removes it.
    pub fn on(&self, listener: Listener) -> u64 {
        let id = self.inner.next_listener.fetch_add(1, Ordering::SeqCst);
        self.inner
            .listeners
            .lock()
            .expect("endpoint listeners")
            .push((id, listener));
        id
    }

    pub fn off(&self, id: u64) {
        self.inner
            .listeners
            .lock()
            .expect("endpoint listeners")
            .retain(|(each, _)| *each != id);
    }

    fn emit(&self, event: EndpointEvent) {
        let listeners: Vec<Listener> = self
            .inner
            .listeners
            .lock()
            .expect("endpoint listeners")
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener(&event);
        }
    }

    pub fn is_closed(&self) -> bool {
        self.state().closed
    }

    /// The latest composed surface, for those that join mid-stream.
    pub fn current_surface(&self) -> Option<Arc<SurfaceBaseline>> {
        self.state().surface.clone()
    }

    /// What this socket's welcome advertised (never a server-wide cache);
    /// None once closed or before the welcome.
    pub fn negotiation(&self) -> Option<EndpointWelcome> {
        let state = self.state();
        if state.closed {
            return None;
        }
        state.welcome.clone()
    }

    pub fn assert_method(&self, method: &str) -> Result<(), String> {
        let state = self.state();
        if state.closed {
            return Err("endpoint client closed".into());
        }
        let Some(welcome) = &state.welcome else {
            return Err("Herdr endpoint availability is still loading".into());
        };
        if !welcome.methods.iter().any(|each| each == method) {
            return Err(format!("Herdr endpoint does not advertise {method}"));
        }
        Ok(())
    }

    /// Connects and says hello; settles once the welcome and the first
    /// snapshot with a boot id came (8 s at most). `wake_herdr`, when
    /// given, makes Herdr's main loop run now: an idle Herdr accepts a new
    /// client only when that loop wakes, which it otherwise does every
    /// 250 ms. It runs once the connection is queued, then again while no
    /// welcome has come.
    pub fn connect(
        &self,
        cols: u64,
        rows: u64,
        wake_herdr: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> BoxFuture<Result<(), String>> {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state();
            if state.started {
                return Box::pin(async { Err("endpoint client is already connected".into()) });
            }
            if state.closed {
                return Box::pin(async { Err("endpoint client is closed".into()) });
            }
            state.started = true;
            state.pending_welcome = Some(tx);
        }
        let this = self.clone();
        let mut stop = self.inner.stop.subscribe();
        tokio::spawn(async move {
            let connected = tokio::select! {
                stream = connect_stream(&this.inner.socket_path) => stream,
                _ = stop.wait_for(|stop| *stop) => return,
            };
            let stream = match connected {
                Ok(stream) => stream,
                Err(error) => {
                    let text = io_error_text(&error);
                    this.reject_welcome(text.clone());
                    this.emit(EndpointEvent::Error(text));
                    this.close();
                    this.emit(EndpointEvent::Close);
                    return;
                }
            };
            this.run(stream, cols, rows, wake_herdr, stop).await;
        });
        let this = self.clone();
        Box::pin(async move {
            let timeout = this
                .inner
                .clock
                .sleep(Duration::from_millis(HANDSHAKE_TIMEOUT_MS));
            tokio::select! {
                outcome = rx => outcome.unwrap_or_else(|_| Err("endpoint client closed during handshake".into())),
                () = timeout => {
                    this.reject_welcome(String::new());
                    this.close();
                    Err("timed out waiting for Herdr endpoint welcome and snapshot".into())
                }
            }
        })
    }

    fn hello(&self, cols: u64, rows: u64) -> Vec<u8> {
        let passive = self.inner.role == EndpointRole::Notifications;
        let codecs = self.inner.surface_codecs && !passive;
        let hello = json!({
            "generation": ENDPOINT_GENERATION,
            "cell_width_px": 0,
            "cell_height_px": 0,
            "surface_size": {"cols": cols, "rows": rows},
            "pixel_mouse": false,
            "direct_graphics": false,
            "endpoint_keybindings": false,
            "mouse_capture": false,
            "surface_active": !passive,
            "surface_delta": codecs,
            "surface_reuse": codecs,
            "snapshot_codecs": ["shell.snapshot.v1"],
            "surface_codecs": ["shell.surface.v1"],
            "input_codecs": ["shell.input.semantic.v1"],
            "blob_codecs": ["shell.blob.v1"],
        });
        control(HELLO_KIND, &hello.to_string())
    }

    fn wake_until_welcome(&self, wake: Arc<dyn Fn() + Send + Sync>) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut attempt = 0;
            loop {
                {
                    let state = this.state();
                    if state.closed || state.welcomed {
                        return;
                    }
                }
                // Only a hint: the accept poll still comes.
                wake();
                let Some(delay) = ENDPOINT_WAKE_RETRY_MS.get(attempt) else {
                    return;
                };
                attempt += 1;
                this.inner.clock.sleep(Duration::from_millis(*delay)).await;
            }
        });
    }

    async fn run(
        &self,
        stream: crate::thin::Stream,
        cols: u64,
        rows: u64,
        wake_herdr: Option<Arc<dyn Fn() + Send + Sync>>,
        mut stop: watch::Receiver<bool>,
    ) {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut state = self.state();
            if state.closed {
                drop(state);
                self.emit(EndpointEvent::Close);
                return;
            }
            state.writer = Some(tx.clone());
        }
        let _ = tx.send(encode_frame(&self.hello(cols, rows)));
        drop(tx);
        if let Some(wake) = wake_herdr {
            self.wake_until_welcome(wake);
        }
        let writing = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if writer.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        'read: loop {
            let read = tokio::select! {
                read = reader.read(&mut chunk) => read,
                _ = stop.wait_for(|stop| *stop) => break 'read,
            };
            match read {
                Ok(0) => break,
                Err(error) => {
                    let text = io_error_text(&error);
                    self.reject_welcome(text.clone());
                    self.emit(EndpointEvent::Error(text));
                    break;
                }
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            }
            let mut start = 0;
            while buffer.len() - start >= 4 {
                let length =
                    u32::from_le_bytes(buffer[start..start + 4].try_into().expect("4")) as usize;
                if length > MAX_FRAME {
                    self.fail(format!("oversized frame: {length}"));
                    break 'read;
                }
                if buffer.len() - start < 4 + length {
                    break;
                }
                self.handle_payload(&buffer[start + 4..start + 4 + length]);
                start += 4 + length;
                if self.is_closed() {
                    break 'read;
                }
            }
            buffer.drain(..start);
        }
        writing.abort();
        self.close();
        self.emit(EndpointEvent::Close);
    }

    fn write(&self, message: &[u8]) {
        let state = self.state();
        if state.closed {
            return;
        }
        if let Some(writer) = &state.writer {
            let _ = writer.send(encode_frame(message));
        }
    }

    fn assert_negotiated(&self) -> Result<(), String> {
        let state = self.state();
        if state.closed {
            return Err("endpoint client closed".into());
        }
        if state.welcome.is_none() {
            return Err("Herdr endpoint codecs have not been negotiated".into());
        }
        Ok(())
    }

    pub fn resize(&self, cols: u64, rows: u64) -> Result<(), String> {
        self.assert_negotiated()?;
        let mut writer = BinWriter::new();
        writer.variant(cm::CLIENT_SHELL_RESIZE);
        writer.varint(0); // cell_width_px
        writer.varint(0); // cell_height_px
        writer.varint(cols);
        writer.varint(rows);
        writer.bool(false); // pixel_mouse
        self.write(&writer.into_bytes());
        Ok(())
    }

    fn health_check(&self) -> bool {
        self.state().welcome.as_ref().is_some_and(|welcome| {
            welcome
                .capabilities
                .iter()
                .any(|capability| capability == "health_check")
        })
    }

    /// Probes the server; any inbound message (pong or other) is liveness.
    pub fn ping(&self) {
        if self.health_check() {
            self.write(&control(HEALTH_PING_KIND, "{}"));
        }
    }

    /// Classified semantic input to one pane.
    pub fn send_pane_input(&self, pane_id: &str, events: &[PaneInputEvent]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        self.assert_negotiated()?;
        self.write(&encode_pane_input(pane_id, events));
        Ok(())
    }

    /// Invokes an advertised endpoint method (pane.focus, pane.scroll, ...):
    /// the request is written now, its answer awaited.
    pub fn call_endpoint(
        &self,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> BoxFuture<Result<Value, String>> {
        {
            let state = self.state();
            if state.closed {
                return Box::pin(async { Err("endpoint client closed".into()) });
            }
            if state.boot_id.is_empty() {
                return Box::pin(async { Err("endpoint snapshot has not arrived yet".into()) });
            }
        }
        if let Err(error) = self.assert_method(method) {
            return Box::pin(async move { Err(error) });
        }
        let (tx, rx) = oneshot::channel();
        let request_id = {
            let mut state = self.state();
            state.request_seq += 1;
            let request_id = format!("gui_{}", state.request_seq);
            let mut writer = BinWriter::new();
            writer.variant(cm::CLIENT_SHELL_ENDPOINT_REQUEST);
            writer.string(&state.boot_id);
            writer
                .string(&json!({"id": request_id, "method": method, "params": params}).to_string());
            state.pending.insert(
                request_id.clone(),
                Pending {
                    reply: tx,
                    chunks: Vec::new(),
                },
            );
            drop(state);
            self.write(&writer.into_bytes());
            request_id
        };
        let this = self.clone();
        let method = method.to_owned();
        Box::pin(async move {
            let answer = async {
                rx.await
                    .unwrap_or_else(|_| Err("endpoint client closed".into()))
            };
            match timeout_ms {
                None => answer.await,
                Some(ms) => {
                    let timeout = this.inner.clock.sleep(Duration::from_millis(ms));
                    tokio::select! {
                        outcome = answer => outcome,
                        () = timeout => {
                            this.state().pending.remove(&request_id);
                            Err(format!("Endpoint {method} timed out"))
                        }
                    }
                }
            }
        })
    }

    pub fn close(&self) {
        let pending = {
            let mut state = self.state();
            state.closed = true;
            state.surface = None;
            state.writer = None;
            if let Some(welcome) = state.pending_welcome.take() {
                let _ = welcome.send(Err("endpoint client closed during handshake".into()));
            }
            std::mem::take(&mut state.pending)
        };
        for (_, request) in pending {
            let _ = request.reply.send(Err("endpoint client closed".into()));
        }
        let _ = self.inner.stop.send(true);
    }

    fn resolve_welcome(&self) {
        let mut state = self.state();
        if !state.welcomed || state.boot_id.is_empty() {
            return;
        }
        if let Some(pending) = state.pending_welcome.take() {
            let _ = pending.send(Ok(()));
        }
    }

    fn reject_welcome(&self, error: String) {
        if let Some(pending) = self.state().pending_welcome.take() {
            let _ = pending.send(Err(error));
        }
    }

    fn fail(&self, error: String) {
        self.reject_welcome(error.clone());
        self.close();
        self.emit(EndpointEvent::Error(error));
    }

    fn handle_payload(&self, payload: &[u8]) {
        if self.is_closed() {
            return;
        }
        if let Err(error) = self.decode(payload) {
            self.fail(error);
        }
    }

    fn decode(&self, payload: &[u8]) -> Result<(), String> {
        let mut reader = BinReader::new(payload);
        let variant = reader.variant()?;
        match variant {
            sm::ENDPOINT_CONTROL => {
                let kind = reader.string()?;
                let data = reader.string()?;
                self.handle_control(&kind, &data)?;
            }
            sm::CLIPBOARD => {
                let data = reader.string()?;
                if reader.remaining() == 0 && is_terminal_clipboard_payload(&data) {
                    self.emit(EndpointEvent::Clipboard(data));
                }
            }
            sm::PANE_SURFACE => {
                self.assert_negotiated()?;
                let surface = read_full_surface(payload)?;
                self.accept_surface(surface)?;
            }
            sm::PANE_SURFACE_PATCH => {
                self.assert_negotiated()?;
                let surface = {
                    let mut state = self.state();
                    let boot_id = state.boot_id.clone();
                    let current = state.surface.as_mut().map(Arc::make_mut);
                    apply_surface_patch(payload, current)?;
                    let surface = state.surface.clone().expect("patched");
                    if surface.boot_id != boot_id {
                        return Err(
                            "Invalid endpoint surface identity or revision; reconnect required"
                                .into(),
                        );
                    }
                    surface
                };
                self.emit(EndpointEvent::Surface(surface));
            }
            // Snapshots come as EndpointControl JSON; this variant exists
            // in the frozen enum but is not sent.
            sm::CLIENT_SHELL_SNAPSHOT => {}
            sm::SEMANTIC_NOTIFICATION => {
                if self.inner.role == EndpointRole::Notifications {
                    // A malformed optional notification must not tear down
                    // the shell.
                    match read_semantic_notification(&mut reader) {
                        Ok(notification) => {
                            self.emit(EndpointEvent::SemanticNotification(notification))
                        }
                        Err(error) => self.emit(EndpointEvent::NotificationError(error)),
                    }
                }
            }
            sm::CLIENT_SHELL_ERROR => {
                let error = reader.string()?;
                self.emit(EndpointEvent::ShellError(error));
            }
            sm::CLIENT_SHELL_ENDPOINT_RESPONSE_CHUNK => {
                reader.string()?; // boot_id
                let request_id = reader.string()?;
                let last = reader.bool()?;
                let data = String::from_utf8_lossy(&reader.bytes()?).into_owned();
                let done = {
                    let mut state = self.state();
                    match state.pending.get_mut(&request_id) {
                        Some(pending) => {
                            pending.chunks.push(data);
                            if last {
                                state.pending.remove(&request_id)
                            } else {
                                None
                            }
                        }
                        None => None,
                    }
                };
                if let Some(pending) = done {
                    let _ = pending
                        .reply
                        .send(endpoint_answer(&pending.chunks.concat()));
                }
            }
            sm::WELCOME => {
                // The legacy same-install welcome: the server predates
                // endpoint generation 1 and could not read our hello.
                self.fail(
                    "Herdr server does not speak endpoint generation 1 (needs >= 0.9.0)".into(),
                );
            }
            // Other optional server messages are ignored.
            _ => {}
        }
        Ok(())
    }

    fn handle_control(&self, kind: &str, data: &str) -> Result<(), String> {
        match kind {
            WELCOME_KIND => {
                // A malformed, refused or other welcome closes the shell.
                let welcome = parse_welcome(data)?;
                {
                    let mut state = self.state();
                    state.welcome = Some(welcome.clone());
                    state.welcomed = true;
                }
                self.emit(EndpointEvent::Welcome(welcome));
                self.resolve_welcome();
            }
            SNAPSHOT_KIND => {
                let raw: Value = match serde_json::from_str(data) {
                    Ok(raw) => raw,
                    Err(error) => {
                        self.emit(EndpointEvent::Error(error.to_string()));
                        return Ok(());
                    }
                };
                let boot_id = raw
                    .get("boot_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let changed = {
                    let mut state = self.state();
                    let changed = !state.boot_id.is_empty()
                        && !boot_id.is_empty()
                        && state.boot_id != boot_id;
                    if !changed {
                        state.boot_id = boot_id.clone();
                    }
                    changed
                };
                if changed {
                    self.close();
                    self.emit(EndpointEvent::Error(
                        "Herdr endpoint boot changed; reconnect required".into(),
                    ));
                    return Ok(());
                }
                self.emit(EndpointEvent::Snapshot { boot_id, raw });
                self.resolve_welcome();
            }
            HEALTH_PING_KIND => {
                if self.health_check() {
                    self.write(&control(HEALTH_PONG_KIND, data));
                }
            }
            SURFACE_DELTA_KIND | SURFACE_REUSE_KIND => {
                let capability = if kind == SURFACE_DELTA_KIND {
                    "surface_delta"
                } else {
                    "surface_reuse"
                };
                let negotiated = self.inner.surface_codecs
                    && self.inner.role != EndpointRole::Notifications
                    && self.state().welcome.as_ref().is_some_and(|welcome| {
                        welcome.capabilities.iter().any(|each| each == capability)
                    });
                if !negotiated {
                    return Err(format!("Herdr sent unnegotiated {capability}"));
                }
                let surface = {
                    let mut state = self.state();
                    let current = state.surface.as_mut().map(Arc::make_mut);
                    if kind == SURFACE_DELTA_KIND {
                        read_surface_delta(data, current)?
                    } else {
                        read_surface_reuse(data, current)?
                    }
                };
                self.accept_surface(surface)?;
            }
            // Unknown named controls are optional and ignored.
            _ => {}
        }
        Ok(())
    }

    fn accept_surface(&self, surface: SurfaceBaseline) -> Result<(), String> {
        let surface = {
            let mut state = self.state();
            let stale = state.surface.as_ref().is_some_and(|current| {
                surface.surface_revision <= current.surface_revision
                    || surface.projection_revision < current.projection_revision
            });
            if surface.boot_id != state.boot_id || stale {
                return Err(
                    "Invalid endpoint surface identity or revision; reconnect required".into(),
                );
            }
            let surface = Arc::new(surface);
            state.surface = Some(surface.clone());
            surface
        };
        self.emit(EndpointEvent::Surface(surface));
        Ok(())
    }
}

/// A finished endpoint answer: its result, or its error's message.
fn endpoint_answer(text: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    match parsed.get("error").filter(|error| truthy(error)) {
        Some(error) => Err(error
            .get("message")
            .filter(|message| !message.is_null())
            .map(|message| match message {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "endpoint request failed".into())),
        None => Ok(parsed.get("result").cloned().unwrap_or(Value::Null)),
    }
}

/// Herdr refuses OSC 52 bodies above 256 KiB before sending Clipboard
/// (bridge/terminal-clipboard.ts); the browser checks UTF-8 and text
/// limits itself.
pub fn is_terminal_clipboard_payload(data: &str) -> bool {
    !data.is_empty() && data.len() <= 256 * 1024 && is_standard_base64(data)
}

/// `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`.
pub fn is_standard_base64(data: &str) -> bool {
    let bytes = data.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return false;
    }
    let alphabet = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/';
    let Some(last) = bytes.len().checked_sub(4) else {
        return true;
    };
    if !bytes[..last].iter().all(alphabet) {
        return false;
    }
    match &bytes[last..] {
        [a, b, b'=', b'='] => alphabet(a) && alphabet(b),
        [a, b, c, b'='] => alphabet(a) && alphabet(b) && alphabet(c),
        tail => tail.iter().all(alphabet),
    }
}

/// The boot id of the Herdr server behind `client_socket_path` (the
/// runtime's `recoveryIdentity`): a passive handshake, closed once the
/// welcome and a snapshot came (8 s at most). None when the snapshot names
/// none.
pub async fn read_boot_id(client_socket_path: &str) -> Result<Option<String>, String> {
    let client = EndpointClient::new(client_socket_path, false, EndpointRole::Notifications, None);
    let boot: Arc<Mutex<Option<String>>> = Arc::default();
    let seen = boot.clone();
    client.on(Arc::new(move |event| {
        if let EndpointEvent::Snapshot { boot_id, .. } = event {
            *seen.lock().unwrap() = (!boot_id.is_empty()).then(|| boot_id.clone());
        }
    }));
    let outcome = client.connect(80, 24, None).await;
    client.close();
    outcome?;
    let boot = boot.lock().unwrap().clone();
    Ok(boot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_welcome_with_other_codecs_or_an_error_is_refused() {
        let good = json!({
            "generation": 1,
            "server_version": "0.9.4",
            "snapshot_codec": "shell.snapshot.v1",
            "surface_codec": "shell.surface.v1",
            "input_codec": "shell.input.semantic.v1",
            "blob_codec": "shell.blob.v1",
            "capabilities": ["health_check"],
        });
        let welcome = parse_welcome(&good.to_string()).unwrap();
        assert_eq!(welcome.capabilities, vec!["health_check".to_owned()]);
        assert_eq!(
            welcome.to_value(),
            json!({"generation": 1, "serverVersion": "0.9.4", "methods": [], "capabilities": ["health_check"]})
        );
        let mut other = good.clone();
        other["generation"] = json!(2);
        assert!(parse_welcome(&other.to_string()).is_err());
        assert_eq!(
            parse_welcome(r#"{"error":{"code":"x","message":"no"}}"#),
            Err("Herdr rejected endpoint hello (x): no".to_owned())
        );
    }

    #[test]
    fn clipboard_payloads_are_standard_base64() {
        assert!(is_terminal_clipboard_payload("aGVsbG8="));
        assert!(is_terminal_clipboard_payload("aGk="));
        assert!(!is_terminal_clipboard_payload(""));
        assert!(!is_terminal_clipboard_payload("aGVsbG8"));
        assert!(!is_terminal_clipboard_payload("a=Vs"));
    }
}
