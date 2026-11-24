//! A connection generation's terminal bridge (bridge/terminal-bridge.ts):
//! `terminal.*` RPCs, one stream per terminal shared by its viewers (an
//! endpoint session, or the legacy direct-terminal client), warm streams
//! kept for a quick return, frames cropped to each viewer, the popup
//! observer, and the clipboard relay of Herdr before protocol 22.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_base::clock::SharedClock;
use roamgate_base::log::{Logger, NO_TERMINAL_ATTACHED_MESSAGE};
use roamgate_connections::routing::serialize_connection_envelope;
use roamgate_herdr::endpoint::creation::{
    CreationDeadline, CreationSource, EmptyWorkspaceCreator, parse_creation_source,
};
use roamgate_herdr::endpoint::surface::PopupSize;
use roamgate_herdr::endpoint::{
    EndpointClient, EndpointEvent, EndpointRole, is_standard_base64, is_terminal_clipboard_payload,
};
use roamgate_herdr::protocol::is_supported_herdr_protocol;
use roamgate_herdr::thin::{
    ConnectOptions, LaunchMode, ScrollDirection, ScrollSource, ThinClient, ThinEvent,
    is_terminal_hello_protocol,
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::session::{EndpointTerminalSession, LookupPaneId};
use super::{
    BoxFuture, Lane, StreamEvent, StreamListener, TerminalFrame, format_bytes, log_fields,
};
use crate::frame_to_ansi::{Viewport, frame_to_ansi};
use crate::rpc_reply::CONNECTION_CHANGED_DURING_REQUEST;

const CLIPBOARD_INPUT_WINDOW_MS: i64 = 30_000;
const CLIPBOARD_RELAY_READY_WAIT_MS: u64 = 500;
const TERMINAL_FIRST_FRAME_WAIT_MS: u64 = 20_000;
/// Switching back to a recently viewed pane reuses its endpoint stream
/// instead of waiting for Herdr's first snapshot again. The least recently
/// viewed beyond this count close, and so does any nobody came back to
/// within the TTL: a warm stream keeps receiving every surface, over SSH
/// too.
const IDLE_TERMINAL_MAX: usize = 20;
const IDLE_TERMINAL_TTL_MS: u64 = 10 * 60_000;
const OWNED_TERMINAL_WAIT_MS: u64 = 20_000;
const POPUP_RETRY_MS: u64 = 2_000;

/// Where the bridge's messages go: the connection's browser sockets.
pub trait TerminalSink: Send + Sync + 'static {
    fn send(&self, socket: u64, payload: String, context: &str, key: Option<&str>);
    /// To every browser on the connection, attached to a terminal or not.
    fn broadcast(&self, payload: &str, context: &str);
    /// Discards a frame held under backpressure once it is the wrong size.
    fn drop_coalesced(&self, socket: u64, key: &str);
    fn client_label(&self, socket: u64) -> String;
}

pub type IsCurrent = Arc<dyn Fn() -> bool + Send + Sync>;
pub type HerdrProtocol = Arc<dyn Fn() -> BoxFuture<Result<i64, String>> + Send + Sync>;
pub type InputRefusal = Arc<dyn Fn(String) -> BoxFuture<Option<String>> + Send + Sync>;
pub type OnInput = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;
pub type FocusedWorkspace = Arc<dyn Fn() -> BoxFuture<Option<String>> + Send + Sync>;
pub type CodecsEnabled = Arc<dyn Fn() -> BoxFuture<bool> + Send + Sync>;
pub type Wake = Arc<dyn Fn() + Send + Sync>;
pub type ValidateSource =
    Arc<dyn Fn(CreationSource) -> BoxFuture<Result<(), String>> + Send + Sync>;
pub type ConfirmRelayResize =
    Arc<dyn Fn(u64, u64, Option<String>) -> BoxFuture<bool> + Send + Sync>;
pub type FormatError = Arc<dyn Fn(&str) -> String + Send + Sync>;
/// Fails once the attachment a request relies on changed.
pub type Validate = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
/// Checks a creation's directory again right before Herdr is asked.
pub type ValidatePath = Arc<dyn Fn() -> BoxFuture<Result<(), String>> + Send + Sync>;

/// What a generation gives its bridge (createTerminalBridge's args).
pub struct BridgeOptions {
    pub connection_id: String,
    pub generation: u64,
    pub logger: Logger,
    pub clock: SharedClock,
    pub client_socket_path: String,
    /// The connection's Herdr protocol (its control socket's ping), checked
    /// supported.
    pub herdr_protocol: HerdrProtocol,
    pub lookup_pane_id: Option<LookupPaneId>,
    /// Why nothing may be typed into this terminal now, if so.
    pub input_refusal: Option<InputRefusal>,
    /// A browser typed this input into this terminal.
    pub on_input: Option<OnInput>,
    /// Popup surfaces follow this connection's focused Space.
    pub focused_workspace_id: Option<FocusedWorkspace>,
    pub surface_codecs_enabled: Option<CodecsEnabled>,
    /// Makes Herdr accept a new endpoint connection now.
    pub wake_herdr: Option<Wake>,
    pub validate_creation_source: Option<ValidateSource>,
    pub create_empty_workspace: Option<EmptyWorkspaceCreator>,
    pub sink: Arc<dyn TerminalSink>,
    pub confirm_relay_resize: Option<ConfirmRelayResize>,
    /// `ROAMGATE_DISABLE_ENDPOINT=1`.
    pub disable_endpoint: bool,
    pub format_error: FormatError,
}

#[derive(Clone)]
enum Stream {
    Endpoint(EndpointTerminalSession),
    Legacy(ThinClient),
}

impl Stream {
    fn is_closed(&self) -> bool {
        match self {
            Stream::Endpoint(session) => session.is_closed(),
            Stream::Legacy(thin) => thin.is_closed(),
        }
    }
    fn close(&self) {
        match self {
            Stream::Endpoint(session) => session.close(),
            Stream::Legacy(thin) => thin.close(),
        }
    }
    fn resize(&self, cols: u64, rows: u64) -> Result<(), String> {
        match self {
            Stream::Endpoint(session) => session.resize(cols, rows),
            Stream::Legacy(thin) => {
                thin.resize(cols, rows);
                Ok(())
            }
        }
    }
    fn endpoint(&self) -> Option<&EndpointTerminalSession> {
        match self {
            Stream::Endpoint(session) => Some(session),
            Stream::Legacy(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ViewerViewport {
    cols: u64,
    rows: u64,
    /// Order of the request that set it: terminal viewports use the
    /// bridge-wide counter, relay viewports the relay revision.
    revision: u64,
}

type ConnectingFuture = Shared<BoxFuture<Result<(), String>>>;

struct SharedTerminal {
    stream: Stream,
    connecting: Option<ConnectingFuture>,
    first_frame: watch::Sender<Option<bool>>,
    terminal_id: String,
    cols: u64,
    rows: u64,
    viewers: Vec<u64>,
    frames: u64,
    bytes: u64,
    first_frame_logged: bool,
    last_frame_log_at: i64,
    /// The last error Herdr told on the stream (a takeover notice).
    last_error: Option<String>,
    /// The latest full endpoint frame, replayed to a viewer coming back.
    last_frame: Option<Arc<TerminalFrame>>,
    /// No viewers: kept warm for a quick return.
    idle: bool,
    idle_timer: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Debug, Clone, PartialEq)]
struct PopupIdentity {
    terminal_id: String,
    title: String,
    width: Option<PopupSize>,
    height: Option<PopupSize>,
}

impl PopupIdentity {
    fn to_value(&self) -> Value {
        json!({
            "terminal_id": self.terminal_id,
            "title": self.title,
            "width": PopupSize::to_value(self.width.as_ref()),
            "height": PopupSize::to_value(self.height.as_ref()),
        })
    }
}

#[derive(Clone)]
struct ClipboardTarget {
    socket: u64,
    terminal_id: String,
    input_at: i64,
    stream: u64,
}

/// The terminal a socket attached last (its default target).
struct CurrentTerminal {
    terminal_id: Option<String>,
}

#[derive(Default)]
struct State {
    terminals: HashMap<u64, CurrentTerminal>,
    /// Each socket's terminals in the order it viewed them.
    viewers: HashMap<u64, Vec<(String, ViewerViewport)>>,
    viewport_revision: u64,
    /// The stream of each terminal.
    by_terminal: HashMap<String, u64>,
    /// Every stream not yet closed, by its number.
    streams: HashMap<u64, SharedTerminal>,
    next_stream: u64,
    /// Warm streams, least recently viewed first.
    idle: Vec<(String, u64)>,
    popup: Option<PopupIdentity>,
    popup_observer: Option<(u64, EndpointClient)>,
    popup_observer_starting: bool,
    popup_retry: bool,
    popup_observer_workspace: Option<String>,
    attachment_tokens: HashMap<u64, HashMap<String, u64>>,
    next_token: u64,
    focus_intents: HashMap<u64, u64>,
    focus_chains: HashMap<u64, Lane>,
    relay: Option<(u64, ThinClient)>,
    relay_connecting: Option<Shared<BoxFuture<()>>>,
    clipboard_target: Option<ClipboardTarget>,
    relay_size: Option<(u64, u64)>,
    relay_revision: u64,
    relay_viewports: Vec<(u64, ViewerViewport)>,
    /// The browser whose layout was last applied to the relay.
    relay_owner: Option<u64>,
    /// Protocol 22: the relay is known undeliverable.
    relay_skipped: bool,
    lifecycle_revision: u64,
    surface_settings_revision: u64,
    disposed: bool,
    protocol: Option<i64>,
}

impl State {
    fn viewport(&self, socket: u64, terminal_id: &str) -> Option<ViewerViewport> {
        self.viewers
            .get(&socket)?
            .iter()
            .find(|(id, _)| id == terminal_id)
            .map(|(_, viewport)| *viewport)
    }
    fn views(&self, socket: u64, terminal_id: &str) -> bool {
        self.viewport(socket, terminal_id).is_some()
    }
    fn set_viewport(&mut self, socket: u64, terminal_id: &str, viewport: ViewerViewport) {
        let viewed = self.viewers.entry(socket).or_default();
        match viewed.iter_mut().find(|(id, _)| id == terminal_id) {
            Some((_, slot)) => *slot = viewport,
            None => viewed.push((terminal_id.to_owned(), viewport)),
        }
    }
    fn current_stream(&self, terminal_id: &str) -> Option<&SharedTerminal> {
        self.streams.get(self.by_terminal.get(terminal_id)?)
    }
    fn is_current(&self, revision: u64) -> bool {
        !self.disposed && self.lifecycle_revision == revision
    }
}

struct Inner {
    options: BridgeOptions,
    state: Mutex<State>,
    popup_focus: Lane,
}

/// One generation's terminal bridge. Clones are the same bridge.
#[derive(Clone)]
pub struct TerminalBridge {
    inner: Arc<Inner>,
}

/// `Number(value)` of a JSON value.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => f64::from(u8::from(*value)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// A count a terminal size takes: NaN and negatives are 0.
fn size_of(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value as u64
    } else {
        0
    }
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

/// `String(value ?? "")`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

impl TerminalBridge {
    pub fn new(options: BridgeOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::default(),
                popup_focus: Lane::new(),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().expect("terminal bridge")
    }

    fn options(&self) -> &BridgeOptions {
        &self.inner.options
    }

    fn connection(&self) -> &str {
        &self.inner.options.connection_id
    }

    fn format_error(&self, error: &str) -> String {
        (self.inner.options.format_error)(error)
    }

    /// The protocol, resolved once per bridge: fixed for the server
    /// process, and a restart makes a new bridge.
    async fn bridge_protocol(&self) -> Result<i64, String> {
        if let Some(protocol) = self.state().protocol {
            return Ok(protocol);
        }
        let protocol = (self.options().herdr_protocol)().await?;
        self.state().protocol = Some(protocol);
        Ok(protocol)
    }

    /// `browser-local` on an endpoint Herdr, the same verified decision for
    /// navigation and rendering; else `shared`.
    pub async fn navigation_mode(&self) -> Result<&'static str, String> {
        let protocol = self.bridge_protocol().await?;
        Ok(
            if is_terminal_hello_protocol(protocol)
                && self.options().lookup_pane_id.is_some()
                && !self.options().disable_endpoint
            {
                "browser-local"
            } else {
                "shared"
            },
        )
    }

    /// Herdr 0.7.2 added tab.move in protocol 16, legacy connections too.
    pub async fn tab_move_supported(&self) -> Result<bool, String> {
        let protocol = self.bridge_protocol().await?;
        Ok(is_supported_herdr_protocol(&json!(protocol)) && protocol >= 16)
    }

    fn coalesce_key(&self, terminal_id: &str) -> String {
        format!(
            "terminal:{}",
            json!([self.connection(), self.options().generation, terminal_id])
        )
    }

    fn serialize(&self, message: Value) -> String {
        let Value::Object(message) = message else {
            return message.to_string();
        };
        serialize_connection_envelope(self.connection(), &message, Some(self.options().generation))
            .unwrap_or_else(|_| Value::Object(message).to_string())
    }

    fn debug(&self, message: &str, fields: Value) {
        self.options()
            .logger
            .debug(message, Some(&log_fields(fields)));
    }

    fn warn(&self, message: &str, fields: Value) {
        self.options()
            .logger
            .warn(message, Some(&log_fields(fields)));
    }

    fn label(&self, socket: u64) -> String {
        self.options().sink.client_label(socket)
    }

    fn forward_clipboard(&self, data: &str, terminal_id: Option<&str>) {
        let target = {
            let state = self.state();
            if state.disposed {
                return;
            }
            if !is_terminal_clipboard_payload(data) {
                drop(state);
                self.warn(
                    "dropped invalid terminal clipboard payload",
                    json!({"connection": self.connection()}),
                );
                return;
            }
            let now = self.options().clock.now();
            state.clipboard_target.clone().filter(|target| {
                now - target.input_at <= CLIPBOARD_INPUT_WINDOW_MS
                    && state
                        .streams
                        .get(&target.stream)
                        .is_some_and(|stream| !stream.stream.is_closed())
                    && state.by_terminal.get(&target.terminal_id) == Some(&target.stream)
                    && state.views(target.socket, &target.terminal_id)
                    && terminal_id.is_none_or(|id| id == target.terminal_id)
            })
        };
        let Some(target) = target else {
            let mut fields = json!({"connection": self.connection()});
            if let Some(terminal) = terminal_id {
                fields["terminal"] = json!(terminal);
            }
            self.warn("dropped terminal clipboard without recent input", fields);
            return;
        };
        let payload = self.serialize(json!({
            "terminal_clipboard": {"terminal_id": target.terminal_id, "data": data},
        }));
        self.debug(
            "terminal clipboard",
            json!({
                "connection": self.connection(),
                "terminal": target.terminal_id,
                "payload": format_bytes(data.len() as u64),
                "target": self.label(target.socket),
            }),
        );
        self.options()
            .sink
            .send(target.socket, payload, "terminal-clipboard", None);
    }

    fn popup_changed(&self, popup: Option<PopupIdentity>) {
        {
            let mut state = self.state();
            if state.disposed || state.popup == popup {
                return;
            }
            state.popup = popup.clone();
        }
        self.debug(
            "popup state",
            json!({
                "connection": self.connection(),
                "popup": popup.as_ref().map_or("none", |popup| popup.terminal_id.as_str()),
                "title": popup.as_ref().map_or("", |popup| popup.title.as_str()),
            }),
        );
        let payload = self.serialize(json!({
            "popup": popup.as_ref().map_or(Value::Null, PopupIdentity::to_value),
        }));
        // Every browser of the connection, not only terminal viewers: one
        // that just loaded or switched connections has no attachment yet,
        // and would miss state nothing sends again.
        self.options().sink.broadcast(&payload, "popup-state");
    }

    fn retry_popup_observer(&self) {
        {
            let mut state = self.state();
            if state.disposed || state.popup_retry {
                return;
            }
            state.popup_retry = true;
        }
        let this = self.clone();
        let wait = self
            .options()
            .clock
            .sleep(Duration::from_millis(POPUP_RETRY_MS));
        tokio::spawn(async move {
            wait.await;
            this.state().popup_retry = false;
            this.start_popup_observer().await;
        });
    }

    /// Popup surfaces follow the connection's focused Space (a Herdr
    /// `workspace.focused` event).
    pub fn refresh_popup_observer_focus(&self) {
        let Some(observer) = self.state().popup_observer.clone() else {
            return;
        };
        let Some(focused) = self.options().focused_workspace_id.clone() else {
            return;
        };
        let this = self.clone();
        let task = self.inner.popup_focus.run(move || {
            Box::pin(async move {
                let outcome: Result<(), String> = async {
                    let Some(workspace) = focused().await else {
                        return Ok(());
                    };
                    {
                        let state = this.state();
                        let same = state
                            .popup_observer
                            .as_ref()
                            .is_some_and(|(id, _)| *id == observer.0);
                        if !same
                            || observer.1.is_closed()
                            || state.popup_observer_workspace.as_deref() == Some(&workspace)
                        {
                            return Ok(());
                        }
                    }
                    observer
                        .1
                        .call_endpoint(
                            "workspace.focus",
                            json!({"workspace_id": workspace}),
                            Some(5_000),
                        )
                        .await?;
                    this.state().popup_observer_workspace = Some(workspace);
                    Ok(())
                }
                .await;
                if let Err(error) = outcome {
                    this.warn(
                        "popup observer focus failed",
                        json!({"error": this.format_error(&error)}),
                    );
                }
            })
        });
        tokio::spawn(task);
    }

    /// The popup identity is the connection's, not a pane viewer's: an
    /// endpoint surface stays open even while every browser shows another
    /// view.
    fn start_popup_observer(&self) -> BoxFuture<()> {
        let this = self.clone();
        Box::pin(async move {
            {
                let mut state = this.state();
                if state.disposed || state.popup_observer.is_some() || state.popup_observer_starting
                {
                    return;
                }
                state.popup_observer_starting = true;
            }
            let outcome = this.open_popup_observer().await;
            if let Err(error) = outcome {
                this.warn(
                    "popup observer connect failed",
                    json!({"error": this.format_error(&error)}),
                );
                let observer = this.state().popup_observer.clone();
                if let Some((_, observer)) = observer {
                    observer.close();
                }
                this.retry_popup_observer();
            }
            this.state().popup_observer_starting = false;
        })
    }

    async fn open_popup_observer(&self) -> Result<(), String> {
        if self.navigation_mode().await? != "browser-local" {
            return Ok(());
        }
        let codecs = match &self.options().surface_codecs_enabled {
            Some(enabled) => enabled().await,
            None => true,
        };
        let observer = EndpointClient::new(
            self.options().client_socket_path.clone(),
            codecs,
            EndpointRole::Terminal,
            Some(self.options().clock.clone()),
        );
        let id = {
            let mut state = self.state();
            if state.disposed || state.popup_observer.is_some() {
                return Ok(());
            }
            state.next_stream += 1;
            let id = state.next_stream;
            state.popup_observer = Some((id, observer.clone()));
            id
        };
        let this = self.clone();
        observer.on(Arc::new(move |event| match event {
            EndpointEvent::Surface(surface) => {
                let current = this
                    .state()
                    .popup_observer
                    .as_ref()
                    .is_some_and(|(each, _)| *each == id);
                if !current {
                    return;
                }
                this.popup_changed(surface.popup.as_ref().map(|popup| PopupIdentity {
                    terminal_id: popup.terminal_id.clone(),
                    title: popup.title.clone(),
                    width: popup.width,
                    height: popup.height,
                }));
            }
            EndpointEvent::Error(error) => this.warn(
                "popup observer error",
                json!({"error": this.format_error(error)}),
            ),
            EndpointEvent::Close => {
                {
                    let mut state = this.state();
                    if state
                        .popup_observer
                        .as_ref()
                        .is_none_or(|(each, _)| *each != id)
                    {
                        return;
                    }
                    state.popup_observer = None;
                    state.popup_observer_workspace = None;
                }
                this.popup_changed(None);
                this.retry_popup_observer();
            }
            _ => {}
        }));
        observer.connect(80, 24, None).await?;
        self.refresh_popup_observer_focus();
        Ok(())
    }

    fn close_clipboard_relay(state: &mut State) {
        state.clipboard_target = None;
        if let Some((_, relay)) = state.relay.take() {
            relay.close();
        }
        state.relay_connecting = None;
        state.relay_size = None;
        state.relay_revision += 1;
    }

    /// The relay doubles as the server's foreground app client, whose size
    /// drives the pane-runtime resize cascade of every background tab: it
    /// stays on the active tab's full-layout viewport.
    fn sync_relay_size(state: &mut State, cols: u64, rows: u64) -> bool {
        let Some((_, relay)) = state.relay.as_ref().filter(|(_, relay)| !relay.is_closed()) else {
            return false;
        };
        if state.relay_size == Some((cols, rows)) {
            return false;
        }
        let relay = relay.clone();
        state.relay_size = Some((cols, rows));
        relay.resize(cols, rows);
        true
    }

    fn record_relay_viewport(state: &mut State, socket: u64, cols: u64, rows: u64, revision: u64) {
        let viewport = ViewerViewport {
            cols,
            rows,
            revision,
        };
        match state
            .relay_viewports
            .iter_mut()
            .find(|(each, _)| *each == socket)
        {
            Some((_, slot)) => *slot = viewport,
            None => state.relay_viewports.push((socket, viewport)),
        }
        state.relay_owner = Some(socket);
    }

    /// New clients mark inactive split panes so the one app relay is sized
    /// by the browser's active pane only; missing flags keep older
    /// frontends working.
    fn relay_size_from_params(params: &Value, fallback: (u64, u64)) -> Option<(u64, u64)> {
        if params.get("relay_active") == Some(&Value::Bool(false)) {
            return None;
        }
        let cols = js_number(params.get("relay_cols"));
        let rows = js_number(params.get("relay_rows"));
        if is_integer(cols)
            && is_integer(rows)
            && cols > 0.0
            && rows > 0.0
            && cols <= 65_535.0
            && rows <= 65_535.0
        {
            return Some((cols as u64, rows as u64));
        }
        Some(fallback)
    }

    /// The number of browsers on the server changed: with none the relay
    /// has no consumer and goes (warm streams stay).
    pub fn browser_client_count_changed(&self, count: usize) {
        let mut state = self.state();
        if state.disposed {
            return;
        }
        if count == 0 {
            Self::close_clipboard_relay(&mut state);
        }
    }

    fn ensure_clipboard_relay(&self, cols: u64, rows: u64) -> BoxFuture<()> {
        {
            let state = self.state();
            if state.disposed || state.relay_skipped {
                return Box::pin(async {});
            }
            if state
                .relay
                .as_ref()
                .is_some_and(|(_, relay)| !relay.is_closed())
            {
                return match &state.relay_connecting {
                    Some(connecting) => Box::pin(connecting.clone()),
                    None => Box::pin(async {}),
                };
            }
        }
        let this = self.clone();
        let connecting: Shared<BoxFuture<()>> = (Box::pin(async move {
            this.connect_clipboard_relay(cols, rows).await;
        }) as BoxFuture<()>)
            .shared();
        self.state().relay_connecting = Some(connecting.clone());
        // Settled, it is no longer the relay's attempt, awaited or not.
        let this = self.clone();
        let watched = connecting.clone();
        tokio::spawn(async move {
            watched.clone().await;
            let mut state = this.state();
            if state
                .relay_connecting
                .as_ref()
                .is_some_and(|current| current.ptr_eq(&watched))
            {
                state.relay_connecting = None;
            }
        });
        Box::pin(connecting)
    }

    async fn connect_clipboard_relay(&self, cols: u64, rows: u64) {
        // Tagged Herdr 0.9.0 (protocol 22) routes client-local side
        // effects such as OSC 52 only to the foreground shell (endpoint)
        // client; a direct connection like this relay is never foreground
        // there. The endpoint session's clipboard is used instead.
        let protocol = match self.bridge_protocol().await {
            Ok(protocol) => protocol,
            Err(_) => return,
        };
        if self.state().disposed {
            return;
        }
        if is_terminal_hello_protocol(protocol) {
            self.state().relay_skipped = true;
            if self.options().lookup_pane_id.is_none() || self.options().disable_endpoint {
                self.warn(
                    "terminal-program OSC 52 unavailable on the legacy fallback: Herdr protocol 22 routes clipboard only to endpoint shell clients; browser copy/paste is unaffected",
                    json!({"connection": self.connection()}),
                );
            }
            return;
        }
        let relay = ThinClient::new(
            self.options().client_socket_path.clone(),
            Some(self.options().clock.clone()),
        );
        let id = {
            let mut state = self.state();
            state.next_stream += 1;
            let id = state.next_stream;
            state.relay = Some((id, relay.clone()));
            state.relay_size = Some((cols, rows));
            id
        };
        let mut events = relay.events();
        let this = self.clone();
        let watched = relay.clone();
        tokio::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                };
                let current = |this: &Self| {
                    this.state()
                        .relay
                        .as_ref()
                        .is_some_and(|(each, _)| *each == id)
                };
                match event {
                    ThinEvent::Clipboard(data) => {
                        if current(&this) && !watched.is_closed() {
                            this.forward_clipboard(&data, None);
                        }
                    }
                    ThinEvent::Error(error) => this.warn(
                        "clipboard relay error",
                        json!({"connection": this.connection(), "error": this.format_error(&error)}),
                    ),
                    ThinEvent::Close => {
                        let mut state = this.state();
                        if state.relay.as_ref().is_some_and(|(each, _)| *each == id) {
                            state.relay = None;
                            state.relay_connecting = None;
                            state.relay_size = None;
                        }
                        return;
                    }
                    _ => {}
                }
            }
        });
        // Herdr before protocol 22 routes OSC 52 only to its foreground app
        // client: one lightweight app connection is kept while terminals
        // are viewed, its clipboard routed back to the input owner.
        let connected = relay
            .connect(
                async move { json!(protocol) },
                cols,
                rows,
                ConnectOptions {
                    launch_mode: LaunchMode::App,
                    encoding: 1,
                },
            )
            .await;
        match connected {
            Ok(()) => {
                if self.state().disposed {
                    relay.close();
                    return;
                }
                self.debug(
                    "clipboard relay connected",
                    json!({"connection": self.connection()}),
                );
            }
            Err(error) => {
                let report = {
                    let mut state = self.state();
                    if state.relay.as_ref().is_some_and(|(each, _)| *each == id) {
                        state.relay = None;
                        state.relay_size = None;
                    }
                    !state.disposed && !state.by_terminal.is_empty()
                };
                if report {
                    self.warn(
                        "clipboard relay connection failed",
                        json!({"connection": self.connection(), "error": self.format_error(&error)}),
                    );
                }
            }
        }
    }

    async fn wait_for_clipboard_relay(&self, cols: u64, rows: u64, revision: Option<u64>) -> bool {
        let connecting = self.ensure_clipboard_relay(cols, rows);
        let timed_out = tokio::select! {
            () = connecting => false,
            () = self.options().clock.sleep(Duration::from_millis(CLIPBOARD_RELAY_READY_WAIT_MS)) => true,
        };
        let mut state = self.state();
        if state.disposed {
            return false;
        }
        if timed_out {
            drop(state);
            self.debug(
                "clipboard relay still connecting",
                json!({"connection": self.connection()}),
            );
            return false;
        }
        if !state
            .relay
            .as_ref()
            .is_some_and(|(_, relay)| !relay.is_closed())
        {
            return false;
        }
        if revision.is_some_and(|revision| revision != state.relay_revision) {
            return false;
        }
        // A newer viewport may have come while the relay connected.
        Self::sync_relay_size(&mut state, cols, rows);
        true
    }

    async fn wait_for_first_frame(&self, stream: u64) -> bool {
        let Some((mut first, terminal_id)) = ({
            let state = self.state();
            state
                .streams
                .get(&stream)
                .map(|shared| (shared.first_frame.subscribe(), shared.terminal_id.clone()))
        }) else {
            return false;
        };
        let seen = tokio::select! {
            seen = first.wait_for(Option::is_some) => seen.map(|seen| seen.unwrap_or(false)).unwrap_or(false),
            () = self.options().clock.sleep(Duration::from_millis(TERMINAL_FIRST_FRAME_WAIT_MS)) => {
                self.warn("terminal first frame still pending", json!({
                    "connection": self.connection(),
                    "terminal": terminal_id,
                    "clipboard_relay": "deferred",
                }));
                false
            }
        };
        seen
    }

    async fn sync_relay_after_attach(
        &self,
        socket: u64,
        stream: u64,
        size: (u64, u64),
        revision: u64,
        attach_current: &IsCurrent,
    ) {
        // The first direct frame proves Herdr processed AttachTerminal and
        // holds its resize lock: only then may the relay become foreground
        // or resize the shared layout.
        if !self.wait_for_first_frame(stream).await || self.state().disposed {
            return;
        }
        {
            // A superseded or abandoned attach never owns the relay.
            let current = attach_current();
            let mut state = self.state();
            // A newer tab switch or resize owns the relay now.
            if revision != state.relay_revision || !current {
                return;
            }
            Self::record_relay_viewport(&mut state, socket, size.0, size.1, revision);
            if state
                .relay
                .as_ref()
                .is_some_and(|(_, relay)| !relay.is_closed())
            {
                Self::sync_relay_size(&mut state, size.0, size.1);
                return;
            }
        }
        self.wait_for_clipboard_relay(size.0, size.1, Some(revision))
            .await;
    }

    /// A shared stream has one size, the last viewer's; when one leaves the
    /// others get back the size of the viewer that sized it most recently.
    fn restore_shared_size(&self, state: &mut State, stream: u64, departed: u64) {
        let Some(shared) = state.streams.get(&stream) else {
            return;
        };
        if state.disposed || shared.connecting.is_some() || shared.stream.is_closed() {
            return;
        }
        let mut latest: Option<ViewerViewport> = None;
        for viewer in &shared.viewers {
            if let Some(viewport) = state.viewport(*viewer, &shared.terminal_id)
                && latest.is_none_or(|latest| viewport.revision > latest.revision)
            {
                latest = Some(viewport);
            }
        }
        let Some(latest) = latest else {
            return;
        };
        if latest.cols == shared.cols && latest.rows == shared.rows {
            return;
        }
        let _ = shared.stream.resize(latest.cols, latest.rows);
        let terminal_id = shared.terminal_id.clone();
        let viewers = shared.viewers.clone();
        let shared = state.streams.get_mut(&stream).expect("checked");
        shared.cols = latest.cols;
        shared.rows = latest.rows;
        // Frames held under backpressure were drawn for the departed size.
        let key = self.coalesce_key(&terminal_id);
        for viewer in viewers {
            self.options().sink.drop_coalesced(viewer, &key);
        }
        self.debug(
            "terminal size restored",
            json!({
                "connection": self.connection(),
                "departed": self.label(departed),
                "terminal": terminal_id,
                "size": format!("{}x{}", latest.cols, latest.rows),
            }),
        );
    }

    /// The relay follows the newest applied relay request; when the
    /// browser owning it leaves, the newest of those still connected wins.
    fn restore_relay_size(&self, departed: u64) {
        let (revision, cols, rows, connecting) = {
            let mut state = self.state();
            state.relay_viewports.retain(|(each, _)| *each != departed);
            if state.disposed || state.relay_owner != Some(departed) {
                return;
            }
            state.relay_owner = None;
            let mut latest: Option<(u64, ViewerViewport)> = None;
            for (socket, viewport) in &state.relay_viewports {
                if latest.is_none_or(|(_, latest)| viewport.revision > latest.revision) {
                    latest = Some((*socket, *viewport));
                }
            }
            let Some((owner, latest)) = latest else {
                return;
            };
            state.relay_owner = Some(owner);
            (
                state.relay_revision,
                latest.cols,
                latest.rows,
                state.relay_connecting.clone(),
            )
        };
        let this = self.clone();
        let apply = move || {
            let mut state = this.state();
            if state.disposed || revision != state.relay_revision {
                return;
            }
            if !Self::sync_relay_size(&mut state, cols, rows) {
                return;
            }
            drop(state);
            this.debug(
                "clipboard relay size restored",
                json!({
                    "connection": this.connection(),
                    "departed": this.label(departed),
                    "size": format!("{cols}x{rows}"),
                }),
            );
        };
        // A relay still connecting was sized by the request that made it.
        match connecting {
            Some(connecting) => {
                tokio::spawn(async move {
                    connecting.await;
                    apply();
                });
            }
            None => apply(),
        }
    }

    /// `expected`: None for any stream, `Some(None)` for none.
    fn detach_viewer(
        &self,
        state: &mut State,
        socket: u64,
        terminal_id: Option<&str>,
        expected: Option<Option<u64>>,
    ) {
        let ids: Vec<String> = match terminal_id {
            Some(id) => vec![id.to_owned()],
            None => match state.viewers.get(&socket) {
                Some(viewed) => viewed.iter().map(|(id, _)| id.clone()).collect(),
                None => state
                    .terminals
                    .get(&socket)
                    .and_then(|current| current.terminal_id.clone())
                    .into_iter()
                    .collect(),
            },
        };
        for id in &ids {
            self.options()
                .sink
                .drop_coalesced(socket, &self.coalesce_key(id));
            if let Some(tokens) = state.attachment_tokens.get_mut(&socket) {
                tokens.remove(id);
            }
            if state
                .clipboard_target
                .as_ref()
                .is_some_and(|target| target.socket == socket && &target.terminal_id == id)
            {
                state.clipboard_target = None;
            }
            if let Some(&stream) = state.by_terminal.get(id)
                && expected.is_none_or(|expected| expected == Some(stream))
            {
                let Some(shared) = state.streams.get_mut(&stream) else {
                    continue;
                };
                shared.viewers.retain(|viewer| *viewer != socket);
                if shared.viewers.is_empty() {
                    self.idle_shared(state, stream);
                } else {
                    self.restore_shared_size(state, stream, socket);
                }
            }
            if let Some(viewed) = state.viewers.get_mut(&socket) {
                viewed.retain(|(each, _)| each != id);
            }
        }
        let remaining = state.viewers.get(&socket).map_or(0, Vec::len);
        if remaining == 0 {
            state.viewers.remove(&socket);
            state.attachment_tokens.remove(&socket);
            state.terminals.remove(&socket);
            if state
                .clipboard_target
                .as_ref()
                .is_some_and(|target| target.socket == socket)
            {
                state.clipboard_target = None;
            }
            return;
        }
        let last = state
            .viewers
            .get(&socket)
            .and_then(|viewed| viewed.last())
            .map(|(id, _)| id.clone());
        if let Some(current) = state.terminals.get_mut(&socket)
            && let Some(terminal) = &current.terminal_id
            && !state
                .viewers
                .get(&socket)
                .is_some_and(|viewed| viewed.iter().any(|(id, _)| id == terminal))
        {
            current.terminal_id = last;
        }
    }

    /// One frame to one viewer, cropped to its viewport; false when it no
    /// longer views the terminal.
    fn send_frame(
        &self,
        state: &State,
        stream: u64,
        viewer: u64,
        frame: &TerminalFrame,
        payloads: &mut HashMap<(u64, u64), String>,
    ) -> bool {
        let Some(shared) = state.streams.get(&stream) else {
            return false;
        };
        let terminal_id = &shared.terminal_id;
        let Some(viewport) = state.viewport(viewer, terminal_id) else {
            return false;
        };
        let (width, height) = match &frame.frame {
            Some(_) => (
                frame.width.min(viewport.cols),
                frame.height.min(viewport.rows),
            ),
            None => (frame.width, frame.height),
        };
        let payload = payloads
            .entry((width, height))
            .or_insert_with(|| {
                let cropped;
                let bytes: &[u8] = match &frame.frame {
                    Some(cells) if width != frame.width || height != frame.height => {
                        cropped = frame_to_ansi(
                            cells,
                            Some(Viewport {
                                cols: viewport.cols as usize,
                                rows: viewport.rows as usize,
                            }),
                        );
                        cropped.as_bytes()
                    }
                    _ => &frame.bytes,
                };
                let mut terminal = Map::new();
                terminal.insert("terminal_id".into(), json!(terminal_id));
                terminal.insert("width".into(), json!(width));
                terminal.insert("height".into(), json!(height));
                terminal.insert("full".into(), json!(frame.full));
                if let Some(link) = &frame.link_frame {
                    terminal.insert("link_frame".into(), json!(link));
                }
                if let Some(mouse) = frame.mouse_reporting {
                    terminal.insert("mouse_reporting".into(), json!(mouse));
                }
                if let Some(history) = frame
                    .history
                    .filter(|history| width == history.cols && height == history.rows)
                {
                    terminal.insert(
                        "history".into(),
                        json!({
                            "revision": history.revision,
                            "top": history.top,
                            "total": history.total,
                            "cols": history.cols,
                            "rows": history.rows,
                        }),
                    );
                }
                terminal.insert(
                    "bytes".into(),
                    json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
                );
                self.serialize(json!({"terminal": terminal}))
            })
            .clone();
        // Only endpoint streams always repaint the whole surface: holding
        // even a full legacy frame lets later incremental frames overtake
        // their base.
        let key = (matches!(shared.stream, Stream::Endpoint(_)) && frame.full)
            .then(|| self.coalesce_key(terminal_id));
        self.options()
            .sink
            .send(viewer, payload, "terminal-frame", key.as_deref());
        true
    }

    fn close_shared(&self, state: &mut State, stream: u64) {
        Self::wake_shared(state, stream);
        let Some(shared) = state.streams.get(&stream) else {
            return;
        };
        shared.stream.close();
        let terminal_id = shared.terminal_id.clone();
        if state.by_terminal.get(&terminal_id) == Some(&stream) {
            state.by_terminal.remove(&terminal_id);
        }
    }

    /// A viewerless endpoint stream stays open so switching back is
    /// immediate. Legacy direct attaches hold Herdr's resize lock, so they
    /// close with their last viewer.
    fn idle_shared(&self, state: &mut State, stream: u64) {
        let Some(shared) = state.streams.get(&stream) else {
            return;
        };
        if state.disposed
            || shared.stream.endpoint().is_none()
            || shared.stream.is_closed()
            || shared.connecting.is_some()
            || shared.last_frame.is_none()
        {
            self.close_shared(state, stream);
            return;
        }
        Self::wake_shared(state, stream);
        let terminal_id = state.streams[&stream].terminal_id.clone();
        let this = self.clone();
        let wait = self
            .options()
            .clock
            .sleep(Duration::from_millis(IDLE_TERMINAL_TTL_MS));
        let timer = tokio::spawn(async move {
            wait.await;
            let mut state = this.state();
            if state.streams.get(&stream).is_some_and(|shared| shared.idle) {
                this.close_shared(&mut state, stream);
            }
        });
        let shared = state.streams.get_mut(&stream).expect("checked");
        shared.idle = true;
        shared.idle_timer = Some(timer);
        state.idle.retain(|(id, _)| id != &terminal_id);
        state.idle.push((terminal_id, stream));
        while state.idle.len() > IDLE_TERMINAL_MAX {
            let (_, oldest) = state.idle[0].clone();
            self.close_shared(state, oldest);
            if state
                .idle
                .first()
                .is_some_and(|(_, first)| *first == oldest)
            {
                state.idle.remove(0);
            }
        }
    }

    fn wake_shared(state: &mut State, stream: u64) {
        let Some(shared) = state.streams.get_mut(&stream) else {
            return;
        };
        shared.idle = false;
        if let Some(timer) = shared.idle_timer.take() {
            timer.abort();
        }
        let terminal_id = shared.terminal_id.clone();
        if let Some(index) = state
            .idle
            .iter()
            .position(|(id, each)| id == &terminal_id && *each == stream)
        {
            state.idle.remove(index);
        }
    }

    fn get_shared(
        &self,
        terminal_id: &str,
        cols: u64,
        rows: u64,
        attach_current: &IsCurrent,
        surface: Option<(u64, u64)>,
    ) -> BoxFuture<Result<u64, String>> {
        let this = self.clone();
        let terminal_id = terminal_id.to_owned();
        let attach_current = attach_current.clone();
        Box::pin(async move {
            loop {
                let (creation_revision, settings_revision) = {
                    let state = this.state();
                    if state.disposed {
                        return Err("terminal bridge disposed".to_owned());
                    }
                    (state.lifecycle_revision, state.surface_settings_revision)
                };
                let mode = this.navigation_mode().await?;
                let codecs = if mode == "browser-local" {
                    match &this.options().surface_codecs_enabled {
                        Some(enabled) => enabled().await,
                        None => true,
                    }
                } else {
                    false
                };
                if !this.state().is_current(creation_revision) {
                    return Err("terminal bridge disposed".to_owned());
                }
                if !attach_current() {
                    return Err("terminal attachment changed".to_owned());
                }
                if settings_revision != this.state().surface_settings_revision {
                    continue;
                }
                return this.make_shared(
                    &terminal_id,
                    cols,
                    rows,
                    mode,
                    codecs,
                    creation_revision,
                    surface,
                );
            }
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn make_shared(
        &self,
        terminal_id: &str,
        cols: u64,
        rows: u64,
        mode: &str,
        codecs: bool,
        creation_revision: u64,
        surface: Option<(u64, u64)>,
    ) -> Result<u64, String> {
        let mut state = self.state();
        if let Some(&existing) = state.by_terminal.get(terminal_id) {
            let closed = state.streams[&existing].stream.is_closed();
            if !closed {
                Self::wake_shared(&mut state, existing);
                return Ok(existing);
            }
            Self::wake_shared(&mut state, existing);
            let key = self.coalesce_key(terminal_id);
            let shared = &state.streams[&existing];
            for viewer in &shared.viewers {
                self.options().sink.drop_coalesced(*viewer, &key);
            }
            shared.stream.close();
            state.by_terminal.remove(terminal_id);
        }
        // A popup's terminal is outside workspace layouts on Herdr's side:
        // no pane resolves it, and the endpoint session refuses it. It
        // streams over the legacy direct attach, by terminal id.
        let popup_terminal = state
            .popup
            .as_ref()
            .is_some_and(|popup| popup.terminal_id == terminal_id);
        let stream = match (&self.options().lookup_pane_id, mode, popup_terminal) {
            (Some(lookup), "browser-local", false) => {
                Stream::Endpoint(EndpointTerminalSession::new(
                    &self.options().client_socket_path,
                    terminal_id,
                    lookup.clone(),
                    self.options().logger.clone(),
                    codecs,
                    self.options().wake_herdr.clone(),
                    self.options().clock.clone(),
                ))
            }
            _ => Stream::Legacy(ThinClient::new(
                self.options().client_socket_path.clone(),
                Some(self.options().clock.clone()),
            )),
        };
        state.next_stream += 1;
        let id = state.next_stream;
        state.streams.insert(
            id,
            SharedTerminal {
                stream: stream.clone(),
                connecting: None,
                first_frame: watch::channel(None).0,
                terminal_id: terminal_id.to_owned(),
                cols,
                rows,
                viewers: Vec::new(),
                frames: 0,
                bytes: 0,
                first_frame_logged: false,
                last_frame_log_at: 0,
                last_error: None,
                last_frame: None,
                idle: false,
                idle_timer: None,
            },
        );
        state.by_terminal.insert(terminal_id.to_owned(), id);
        drop(state);
        self.debug(
            "terminal stream connecting",
            json!({
                "connection": self.connection(),
                "terminal": terminal_id,
                "size": format!("{cols}x{rows}"),
                "socket": self.options().client_socket_path,
            }),
        );
        let this = self.clone();
        let listener: StreamListener =
            Arc::new(move |event| this.on_stream_event(id, creation_revision, event));
        let ready: BoxFuture<Result<(), String>> = match &stream {
            Stream::Endpoint(session) => {
                session.set_listener(listener);
                session.connect(cols, rows, surface)
            }
            Stream::Legacy(thin) => {
                let mut events = thin.events();
                tokio::spawn(async move {
                    loop {
                        match events.recv().await {
                            Ok(event) => {
                                let close = matches!(event, ThinEvent::Close);
                                if let Some(event) = legacy_event(event) {
                                    listener(event);
                                }
                                if close {
                                    return;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => return,
                        }
                    }
                });
                let thin = thin.clone();
                let this = self.clone();
                let terminal = terminal_id.to_owned();
                Box::pin(async move {
                    let protocol = this.bridge_protocol().await?;
                    thin.connect(
                        async move { json!(protocol) },
                        cols,
                        rows,
                        ConnectOptions {
                            launch_mode: LaunchMode::TerminalAttach,
                            encoding: 1,
                        },
                    )
                    .await?;
                    if !this.state().is_current(creation_revision) {
                        thin.close();
                        return Err("terminal bridge disposed".to_owned());
                    }
                    thin.attach(&terminal, true)
                })
            }
        };
        let this = self.clone();
        let terminal = terminal_id.to_owned();
        let closing = stream.clone();
        let connecting: ConnectingFuture = (Box::pin(async move {
            let outcome = match ready.await {
                Ok(()) if !this.state().is_current(creation_revision) => {
                    closing.close();
                    Err("terminal bridge disposed".to_owned())
                }
                outcome => outcome,
            };
            let mut state = this.state();
            if state.by_terminal.get(&terminal) == Some(&id) {
                if outcome.is_err() {
                    state.by_terminal.remove(&terminal);
                } else if let Some(shared) = state.streams.get_mut(&id) {
                    shared.connecting = None;
                }
            }
            if outcome.is_err()
                && let Some(shared) = state.streams.get_mut(&id)
            {
                shared.connecting = None;
            }
            outcome
        }) as BoxFuture<Result<(), String>>)
            .shared();
        if let Some(shared) = self.state().streams.get_mut(&id) {
            shared.connecting = Some(connecting.clone());
        }
        // The attempt runs whether or not someone awaits it.
        tokio::spawn(connecting);
        Ok(id)
    }

    fn on_stream_event(&self, id: u64, creation_revision: u64, event: StreamEvent) {
        match event {
            StreamEvent::Terminal(frame) => self.on_terminal_frame(id, creation_revision, frame),
            StreamEvent::Clipboard(data) => {
                let terminal = {
                    let state = self.state();
                    let Some(shared) = state.streams.get(&id) else {
                        return;
                    };
                    (state.is_current(creation_revision)
                        && !shared.stream.is_closed()
                        && state.by_terminal.get(&shared.terminal_id) == Some(&id))
                    .then(|| shared.terminal_id.clone())
                };
                // Bound to the receiving session, not the producing PTY:
                // Herdr 0.9.0 sends clipboard to its foreground shell with
                // no source; the recent input owner must still match.
                if let Some(terminal) = terminal {
                    self.forward_clipboard(&data, Some(&terminal));
                }
            }
            StreamEvent::Welcome {
                version,
                encoding,
                error,
            } => {
                let terminal = self
                    .state()
                    .streams
                    .get(&id)
                    .map(|shared| shared.terminal_id.clone())
                    .unwrap_or_default();
                let mut fields = json!({
                    "connection": self.connection(),
                    "terminal": terminal,
                    "version": version,
                    "encoding": encoding,
                });
                if let Some(error) = error {
                    fields["error"] = json!(self.format_error(&error));
                }
                self.debug("terminal stream welcome", fields);
            }
            StreamEvent::Error(error) => {
                let terminal = {
                    let mut state = self.state();
                    let Some(shared) = state.streams.get_mut(&id) else {
                        return;
                    };
                    shared.last_error = Some(self.format_error(&error));
                    shared.terminal_id.clone()
                };
                self.warn(
                    "terminal stream error",
                    json!({
                        "connection": self.connection(),
                        "terminal": self.format_error(&terminal),
                        "error": self.format_error(&error),
                    }),
                );
            }
            StreamEvent::Close => self.on_stream_close(id, creation_revision),
        }
    }

    fn on_terminal_frame(&self, id: u64, creation_revision: u64, frame: Arc<TerminalFrame>) {
        let mut state = self.state();
        let Some(shared) = state.streams.get_mut(&id) else {
            return;
        };
        let _ = shared.first_frame.send_if_modified(|seen| {
            if seen.is_none() {
                *seen = Some(true);
                true
            } else {
                false
            }
        });
        if !state.is_current(creation_revision) {
            return;
        }
        let now = self.options().clock.now();
        let shared = state.streams.get_mut(&id).expect("checked");
        shared.frames += 1;
        shared.bytes += frame.bytes.len() as u64;
        if !shared.first_frame_logged || now - shared.last_frame_log_at >= 30_000 {
            shared.first_frame_logged = true;
            shared.last_frame_log_at = now;
            let fields = json!({
                "connection": self.connection(),
                "terminal": shared.terminal_id,
                "size": format!("{}x{}", frame.width, frame.height),
                "full": frame.full,
                "frames": shared.frames,
                "bytes": format_bytes(shared.bytes),
                "viewers": shared.viewers.len(),
            });
            self.debug("terminal frame", fields);
        }
        let shared = state.streams.get_mut(&id).expect("checked");
        if shared.stream.endpoint().is_some() && frame.full {
            shared.last_frame = Some(frame.clone());
        }
        let viewers = shared.viewers.clone();
        let mut payloads = HashMap::new();
        let mut gone = Vec::new();
        for viewer in viewers {
            if !self.send_frame(&state, id, viewer, &frame, &mut payloads) {
                gone.push(viewer);
            }
        }
        if !gone.is_empty()
            && let Some(shared) = state.streams.get_mut(&id)
        {
            shared.viewers.retain(|viewer| !gone.contains(viewer));
        }
    }

    fn on_stream_close(&self, id: u64, creation_revision: u64) {
        let mut state = self.state();
        Self::wake_shared(&mut state, id);
        let Some(shared) = state.streams.remove(&id) else {
            return;
        };
        if state
            .clipboard_target
            .as_ref()
            .is_some_and(|target| target.stream == id)
        {
            state.clipboard_target = None;
        }
        let _ = shared.first_frame.send_if_modified(|seen| {
            if seen.is_none() {
                *seen = Some(false);
                true
            } else {
                false
            }
        });
        let terminal_id = shared.terminal_id.clone();
        self.debug(
            "terminal stream closed",
            json!({
                "connection": self.connection(),
                "terminal": terminal_id,
                "frames": shared.frames,
                "bytes": format_bytes(shared.bytes),
            }),
        );
        // A delayed close leaves replacement viewers alone, but still tells
        // viewers waiting on this old stream, so they attach again too.
        let current = state.by_terminal.get(&terminal_id).copied();
        let replacement_viewers: Vec<u64> = current
            .and_then(|current| state.streams.get(&current))
            .map(|replacement| replacement.viewers.clone())
            .unwrap_or_default();
        let viewers: Vec<u64> = shared
            .viewers
            .iter()
            .copied()
            .filter(|viewer| current == Some(id) || !replacement_viewers.contains(viewer))
            .collect();
        let key = self.coalesce_key(&terminal_id);
        for viewer in &viewers {
            self.options().sink.drop_coalesced(*viewer, &key);
        }
        if current == Some(id) {
            state.by_terminal.remove(&terminal_id);
        }
        // Herdr closes a direct attach another client takes over, and the
        // stream can die with the server: viewers are told to attach
        // again instead of keeping a blank terminal.
        if state.is_current(creation_revision) && !viewers.is_empty() {
            drop(state);
            self.warn(
                "terminal stream closed with live viewers",
                json!({
                    "connection": self.connection(),
                    "terminal": terminal_id,
                    "viewers": viewers.len(),
                }),
            );
            let payload = self.serialize(json!({
                "terminal_closed": {
                    "terminal_id": terminal_id,
                    "reason": shared.last_error.clone().unwrap_or_else(|| "stream_closed".into()),
                },
            }));
            for viewer in viewers {
                self.options()
                    .sink
                    .send(viewer, payload.clone(), "terminal-closed", None);
            }
        }
    }

    /// Waits for a terminal this socket owns to finish connecting; the
    /// check it gives fails once the attachment changed.
    async fn wait_for_owned(
        &self,
        socket: u64,
        terminal_id: &str,
        stream: u64,
        request_current: IsCurrent,
    ) -> Result<Validate, String> {
        let (token, revision) = {
            let state = self.state();
            (
                state
                    .attachment_tokens
                    .get(&socket)
                    .and_then(|tokens| tokens.get(terminal_id))
                    .copied(),
                state.lifecycle_revision,
            )
        };
        let this = self.clone();
        let terminal = terminal_id.to_owned();
        let validate: Validate = Arc::new(move || {
            let requested = request_current();
            let state = this.state();
            let owned = requested
                && state.is_current(revision)
                && token.is_some()
                && state
                    .attachment_tokens
                    .get(&socket)
                    .and_then(|tokens| tokens.get(&terminal))
                    .copied()
                    == token
                && state.views(socket, &terminal)
                && state.by_terminal.get(&terminal) == Some(&stream)
                && state
                    .streams
                    .get(&stream)
                    .is_some_and(|shared| !shared.stream.is_closed());
            if owned {
                Ok(())
            } else {
                Err("Source terminal attachment changed; retry after it reconnects.".into())
            }
        });
        validate()?;
        let connecting = self
            .state()
            .streams
            .get(&stream)
            .and_then(|shared| shared.connecting.clone());
        if let Some(connecting) = connecting {
            tokio::select! {
                outcome = connecting => outcome?,
                () = self.options().clock.sleep(Duration::from_millis(OWNED_TERMINAL_WAIT_MS)) => {
                    return Err("Source terminal is still connecting; retry when ready.".into());
                }
            }
        }
        validate()?;
        Ok(validate)
    }

    /// A tab or workspace made from the browser's own terminal (or the
    /// first workspace of an empty session).
    pub async fn create_from_terminal(
        &self,
        socket: u64,
        method: &str,
        params: Map<String, Value>,
        request_current: IsCurrent,
        validate_path: ValidatePath,
    ) -> Result<Value, String> {
        let deadline = CreationDeadline::new(self.options().clock.clone());
        let this = self.clone();
        let method = method.to_owned();
        let inner_deadline = deadline.clone();
        let work = async move {
            if this.navigation_mode().await? != "browser-local" {
                return Err("Client-scoped creation requires Herdr endpoints.".to_owned());
            }
            inner_deadline.assert_before_dispatch()?;
            if method == "workspace.create"
                && params.get("browser_source").is_some_and(Value::is_null)
            {
                let Some(creator) = this.options().create_empty_workspace.clone() else {
                    return Err("Empty-session creation is unavailable.".to_owned());
                };
                let disposed_check = this.clone();
                let current = request_current.clone();
                return creator
                    .create(
                        params,
                        Arc::new(move || !disposed_check.state().disposed && current()),
                        inner_deadline,
                        validate_path(),
                    )
                    .await;
            }
            let source =
                parse_creation_source(params.get("browser_source").unwrap_or(&Value::Null))?;
            if method == "tab.create"
                && params.get("workspace_id").and_then(Value::as_str)
                    != Some(source.workspace_id.as_str())
            {
                return Err("Creation source does not belong to the requested workspace.".into());
            }
            let found = {
                let state = this.state();
                state.by_terminal.get(&source.terminal_id).and_then(|id| {
                    let shared = state.streams.get(id)?;
                    Some((*id, shared.stream.endpoint()?.clone()))
                })
            };
            let Some((stream, session)) = found else {
                return Err(
                    "Open the source terminal tab and wait for it to connect before creating."
                        .into(),
                );
            };
            let validate_attachment = this
                .wait_for_owned(socket, &source.terminal_id, stream, request_current.clone())
                .await?;
            let mut creation = params;
            creation.remove("browser_source");
            if method == "workspace.create" {
                creation.insert(
                    "source_workspace_id".into(),
                    json!(source.workspace_id.clone()),
                );
            }
            creation.insert("focus".into(), Value::Bool(false));
            let validate_source = this.options().validate_creation_source.clone();
            let checked_source = source.clone();
            let validate: BoxFuture<Result<(), String>> = Box::pin(async move {
                validate_attachment()?;
                let Some(validate_source) = validate_source else {
                    return Err("Creation source validation is unavailable.".to_owned());
                };
                validate_source(checked_source).await?;
                validate_path().await?;
                validate_attachment()
            });
            session
                .create(&method, creation, source.pane_id, validate, inner_deadline)
                .await
        };
        deadline.wait(work, None).await
    }

    /// The `terminal.*` RPCs of one socket.
    pub async fn handle_rpc(
        &self,
        socket: u64,
        method: &str,
        params: &Value,
        request_current: IsCurrent,
    ) -> Result<Value, String> {
        let outcome = self.rpc(socket, method, params, &request_current).await;
        outcome.map_err(|message| {
            if request_current() {
                message
            } else {
                CONNECTION_CHANGED_DURING_REQUEST.to_owned()
            }
        })
    }

    async fn rpc(
        &self,
        socket: u64,
        method: &str,
        params: &Value,
        request_current: &IsCurrent,
    ) -> Result<Value, String> {
        if !request_current() {
            return Err(CONNECTION_CHANGED_DURING_REQUEST.to_owned());
        }
        let operation_revision = {
            let state = self.state();
            if state.disposed {
                return Err("terminal bridge disposed".to_owned());
            }
            state.lifecycle_revision
        };
        match method {
            "terminal.watch_popup" => {
                // The observer sends its first surface even with no pane
                // attached.
                tokio::spawn(self.start_popup_observer());
                let popup = self.state().popup.clone();
                Ok(json!({"popup": popup.as_ref().map_or(Value::Null, PopupIdentity::to_value)}))
            }
            "terminal.attach" => {
                self.attach(socket, params, request_current, operation_revision)
                    .await
            }
            "terminal.relay_resize" => {
                let cols = js_number(params.get("cols"));
                let rows = js_number(params.get("rows"));
                if !is_integer(cols)
                    || !is_integer(rows)
                    || cols <= 0.0
                    || rows <= 0.0
                    || cols > 65_535.0
                    || rows > 65_535.0
                {
                    return Err("valid relay cols and rows required".to_owned());
                }
                let (cols, rows) = (cols as u64, rows as u64);
                let pane = params
                    .get("pane_id")
                    .and_then(Value::as_str)
                    .filter(|pane| !pane.is_empty())
                    .map(str::to_owned);
                let open = {
                    let mut state = self.state();
                    state.relay_revision += 1;
                    let revision = state.relay_revision;
                    Self::record_relay_viewport(&mut state, socket, cols, rows, revision);
                    let open = state
                        .relay
                        .as_ref()
                        .is_some_and(|(_, relay)| !relay.is_closed());
                    if open {
                        Self::sync_relay_size(&mut state, cols, rows);
                    }
                    open
                };
                let confirmed = match (&self.options().confirm_relay_resize, open) {
                    (Some(confirm), true) => confirm(cols, rows, pane).await,
                    _ => false,
                };
                if !self.state().is_current(operation_revision) {
                    return Err("terminal bridge disposed".to_owned());
                }
                Ok(json!({"ok": true, "confirmed": confirmed}))
            }
            _ => {
                self.attached_rpc(socket, method, params, request_current)
                    .await
            }
        }
    }

    async fn attach(
        &self,
        socket: u64,
        params: &Value,
        request_current: &IsCurrent,
        operation_revision: u64,
    ) -> Result<Value, String> {
        let terminal_id = js_string(params.get("terminal_id"));
        let cols = size_of(
            params
                .get("cols")
                .map_or(100.0, |cols| js_number(Some(cols))),
        );
        let rows = size_of(
            params
                .get("rows")
                .map_or(30.0, |rows| js_number(Some(rows))),
        );
        if terminal_id.is_empty() {
            return Err("terminal_id required".to_owned());
        }
        let mut surface = None;
        if params.get("surface_cols").is_some() || params.get("surface_rows").is_some() {
            let valid = |value: Option<&Value>| {
                value
                    .and_then(Value::as_f64)
                    .filter(|value| is_integer(*value) && *value >= 1.0 && *value <= 65_535.0)
            };
            match (
                valid(params.get("surface_cols")),
                valid(params.get("surface_rows")),
            ) {
                (Some(cols), Some(rows)) => surface = Some((cols as u64, rows as u64)),
                _ => {
                    return Err(
                        "surface_cols and surface_rows must be integers between 1 and 65535"
                            .to_owned(),
                    );
                }
            }
        }
        let relay_size = Self::relay_size_from_params(params, (cols, rows));
        let (relay_revision, token, waking_idle, refresh_reused, reused) = {
            let mut state = self.state();
            let relay_revision = relay_size.map(|_| {
                state.relay_revision += 1;
                state.relay_revision
            });
            let existing = state
                .current_stream(&terminal_id)
                .filter(|shared| !shared.stream.is_closed());
            let reused = existing.is_some();
            // Captured before the stream is woken.
            let waking_idle = existing.is_some_and(|shared| shared.idle);
            let refresh_reused = existing.is_some_and(|shared| {
                !state.views(socket, &terminal_id)
                    && shared.connecting.is_none()
                    && shared.cols == cols
                    && shared.rows == rows
            });
            state.terminals.insert(
                socket,
                CurrentTerminal {
                    terminal_id: Some(terminal_id.clone()),
                },
            );
            // Ordered once the size is applied below: concurrent attaches
            // can resolve out of order.
            state.set_viewport(
                socket,
                &terminal_id,
                ViewerViewport {
                    cols,
                    rows,
                    revision: 0,
                },
            );
            state.next_token += 1;
            let token = state.next_token;
            state
                .attachment_tokens
                .entry(socket)
                .or_default()
                .insert(terminal_id.clone(), token);
            (relay_revision, token, waking_idle, refresh_reused, reused)
        };
        let owns_attempt = {
            let this = self.clone();
            let terminal = terminal_id.clone();
            move || {
                this.state()
                    .attachment_tokens
                    .get(&socket)
                    .and_then(|tokens| tokens.get(&terminal))
                    .copied()
                    == Some(token)
            }
        };
        let attempt_current: IsCurrent = {
            let this = self.clone();
            let owns = owns_attempt.clone();
            let request_current = request_current.clone();
            Arc::new(move || {
                owns() && request_current() && this.state().is_current(operation_revision)
            })
        };
        let mut stream_id: Option<u64> = None;
        let outcome: Result<Value, String> = async {
            let id = self
                .get_shared(&terminal_id, cols, rows, &attempt_current, surface)
                .await?;
            stream_id = Some(id);
            let connecting = {
                let current = attempt_current();
                let mut state = self.state();
                let shared = state
                    .streams
                    .get_mut(&id)
                    .ok_or("terminal attachment changed")?;
                if current && !shared.viewers.contains(&socket) {
                    shared.viewers.push(socket);
                }
                shared.connecting.clone()
            };
            if let Some(connecting) = connecting {
                connecting.await?;
            }
            let validate = |this: &Self| -> Result<(), String> {
                let current = attempt_current();
                let state = this.state();
                if !state.is_current(operation_revision) {
                    return Err("terminal bridge disposed".to_owned());
                }
                if !current
                    || state.by_terminal.get(&terminal_id) != Some(&id)
                    || state
                        .streams
                        .get(&id)
                        .is_none_or(|shared| shared.stream.is_closed())
                {
                    return Err("terminal attachment changed".to_owned());
                }
                Ok(())
            };
            validate(self)?;
            let (endpoint, resized) = {
                let mut state = self.state();
                state.viewport_revision += 1;
                let revision = state.viewport_revision;
                if let Some(viewed) = state.viewers.get_mut(&socket)
                    && let Some((_, viewport)) =
                        viewed.iter_mut().find(|(each, _)| *each == terminal_id)
                {
                    viewport.revision = revision;
                }
                // A warm stream kept receiving surfaces: its last frame is
                // the pane's screen now, painted instead of asking Herdr.
                let last = state.streams[&id].last_frame.clone();
                let replayed = waking_idle
                    && last.as_ref().is_some_and(|last| {
                        state.streams[&id].viewers.contains(&socket)
                            && self.send_frame(&state, id, socket, last, &mut HashMap::new())
                    });
                let shared = state.streams.get_mut(&id).expect("validated");
                let mut resized = false;
                if shared.cols != cols || shared.rows != rows || (refresh_reused && !replayed) {
                    // A reused idle stream still needs a whole frame for a
                    // new viewer.
                    shared.stream.resize(cols, rows)?;
                    shared.cols = cols;
                    shared.rows = rows;
                    resized = true;
                    // The resize changes the surface for every viewer.
                    let key = self.coalesce_key(&terminal_id);
                    for viewer in &shared.viewers {
                        self.options().sink.drop_coalesced(*viewer, &key);
                    }
                }
                (shared.stream.endpoint().cloned(), resized)
            };
            if resized {
                self.debug(
                    if refresh_reused {
                        "terminal refreshed"
                    } else {
                        "terminal resized"
                    },
                    json!({
                        "connection": self.connection(),
                        "client": self.label(socket),
                        "terminal": terminal_id,
                        "size": format!("{cols}x{rows}"),
                    }),
                );
            }
            if let (Some(size), Some(revision)) = (relay_size, relay_revision) {
                self.sync_relay_after_attach(socket, id, size, revision, &attempt_current)
                    .await;
            }
            validate(self)?;
            let viewers = self.state().streams.get(&id).map_or(0, |s| s.viewers.len());
            self.debug(
                "terminal attached",
                json!({
                    "connection": self.connection(),
                    "client": self.label(socket),
                    "terminal": terminal_id,
                    "viewers": viewers,
                    "size": format!("{cols}x{rows}"),
                    "shared": if reused { "reused" } else { "new" },
                }),
            );
            let mut reply = json!({"ok": true});
            if let Some(session) = endpoint {
                reply["endpoint"] = session
                    .negotiation()
                    .map_or(Value::Null, |welcome| welcome.to_value());
            }
            Ok(reply)
        }
        .await;
        if outcome.is_err() && owns_attempt() {
            // A superseded attach must not detach its replacement's viewer.
            let mut state = self.state();
            self.detach_viewer(&mut state, socket, Some(&terminal_id), Some(stream_id));
        }
        outcome
    }

    async fn attached_rpc(
        &self,
        socket: u64,
        method: &str,
        params: &Value,
        request_current: &IsCurrent,
    ) -> Result<Value, String> {
        let (requested, stream) = {
            let state = self.state();
            let requested = params
                .get("terminal_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    state
                        .terminals
                        .get(&socket)
                        .and_then(|current| current.terminal_id.clone())
                });
            let stream = requested
                .as_ref()
                .filter(|id| state.views(socket, id))
                .and_then(|id| state.by_terminal.get(id).copied())
                .and_then(|id| {
                    state
                        .streams
                        .get(&id)
                        .map(|shared| (id, shared.stream.clone()))
                });
            (requested, stream)
        };
        let no_terminal = || NO_TERMINAL_ATTACHED_MESSAGE.to_owned();
        match method {
            "terminal.detach" => {
                let viewers = {
                    let mut state = self.state();
                    self.detach_viewer(&mut state, socket, requested.as_deref(), None);
                    requested
                        .as_ref()
                        .and_then(|id| state.current_stream(id))
                        .map_or(0, |shared| shared.viewers.len())
                };
                self.debug(
                    "terminal detached",
                    json!({
                        "connection": self.connection(),
                        "client": self.label(socket),
                        "terminal": requested.as_deref().unwrap_or("none"),
                        "viewers": viewers,
                    }),
                );
                Ok(json!({"ok": true}))
            }
            "terminal.focus" => {
                let (Some((id, stream)), Some(terminal)) = (stream, requested) else {
                    return Err(no_terminal());
                };
                if stream.is_closed() {
                    return Err(no_terminal());
                }
                // Legacy streams have their own cursor per terminal.
                let Stream::Endpoint(session) = stream else {
                    return Ok(json!({"ok": true}));
                };
                let (intent, token, lane) = {
                    let mut state = self.state();
                    state.next_token += 1;
                    let intent = state.next_token;
                    let token = state
                        .attachment_tokens
                        .get(&socket)
                        .and_then(|tokens| tokens.get(&terminal))
                        .copied();
                    state.focus_intents.insert(socket, intent);
                    let lane = state.focus_chains.entry(socket).or_default().clone();
                    (intent, token, lane)
                };
                let this = self.clone();
                let request_current = request_current.clone();
                let run = lane.run(move || {
                    Box::pin(async move {
                        if this.state().focus_intents.get(&socket) != Some(&intent) {
                            return Ok(());
                        }
                        let checker = this.clone();
                        let owned_terminal = terminal.clone();
                        let current: IsCurrent = Arc::new(move || {
                            request_current()
                                && checker
                                    .state()
                                    .attachment_tokens
                                    .get(&socket)
                                    .and_then(|tokens| tokens.get(&owned_terminal))
                                    .copied()
                                    == token
                        });
                        let validate = this.wait_for_owned(socket, &terminal, id, current).await?;
                        let intents = this.clone();
                        session
                            .focus(Arc::new(move || {
                                validate()?;
                                Ok(intents.state().focus_intents.get(&socket) == Some(&intent))
                            }))
                            .await
                    })
                });
                let outcome = run
                    .await
                    .unwrap_or_else(|| Err("terminal bridge disposed".to_owned()));
                {
                    let mut state = self.state();
                    if state.focus_intents.get(&socket) == Some(&intent) {
                        state.focus_intents.remove(&socket);
                    }
                }
                outcome?;
                Ok(json!({"ok": true}))
            }
            "terminal.link.resolve" => {
                let (Some((id, Stream::Endpoint(session))), Some(terminal)) = (stream, requested)
                else {
                    return Err(no_terminal());
                };
                let viewport = self.state().viewport(socket, &terminal);
                let frame = params.get("frame").and_then(Value::as_str);
                let cell = |name: &str| {
                    params
                        .get(name)
                        .and_then(Value::as_f64)
                        .filter(|value| is_integer(*value) && *value >= 0.0)
                };
                let (Some(frame), Some(row), Some(col), Some(viewport)) =
                    (frame, cell("row"), cell("col"), viewport)
                else {
                    return Err("Valid terminal link frame and cell required".to_owned());
                };
                let (row, col) = (row as u64, col as u64);
                if row >= viewport.rows || col >= viewport.cols {
                    return Err("Valid terminal link frame and cell required".to_owned());
                }
                let validate = self
                    .wait_for_owned(socket, &terminal, id, request_current.clone())
                    .await?;
                let mut result = session.resolve_link(frame, row, col).await?;
                validate()?;
                let regions: Vec<Value> = result["regions"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|region| {
                        region["row"].as_u64().is_some_and(|r| r < viewport.rows)
                            && region["start_col"]
                                .as_u64()
                                .is_some_and(|c| c < viewport.cols)
                    })
                    .map(|mut region| {
                        let end = region["end_col"].as_u64().unwrap_or(0);
                        region["end_col"] = json!(end.min(viewport.cols - 1));
                        region
                    })
                    .collect();
                result["regions"] = Value::Array(regions);
                Ok(result)
            }
            "terminal.input" => {
                let (Some((id, stream)), Some(terminal)) = (stream, requested) else {
                    return Err(no_terminal());
                };
                if stream.is_closed() {
                    return Err(no_terminal());
                }
                let encoded = js_string(params.get("data"));
                if encoded.is_empty() || !is_standard_base64(&encoded) {
                    return Err("invalid terminal input".to_owned());
                }
                let input = base64::engine::general_purpose::STANDARD
                    .decode(&encoded)
                    .map_err(|_| "invalid terminal input".to_owned())?;
                if input.is_empty() {
                    return Err("terminal input required".to_owned());
                }
                if let Some(refusal) = &self.options().input_refusal
                    && let Some(refused) = refusal(terminal.clone()).await
                {
                    return Err(refused);
                }
                let validate = self
                    .wait_for_owned(socket, &terminal, id, request_current.clone())
                    .await?;
                // Even a ready terminal yielded above: checked again at the
                // side effect.
                validate()?;
                let now = self.options().clock.now();
                self.state().clipboard_target = Some(ClipboardTarget {
                    socket,
                    terminal_id: terminal.clone(),
                    input_at: now,
                    stream: id,
                });
                match &stream {
                    Stream::Endpoint(session) => session.input(&input),
                    Stream::Legacy(thin) => thin.input(&input),
                }
                if let Some(on_input) = &self.options().on_input {
                    on_input(&terminal, &input);
                }
                Ok(json!({"ok": true}))
            }
            "terminal.resize" => {
                let (Some((_, stream)), Some(terminal)) = (stream, requested) else {
                    return Err(no_terminal());
                };
                let cols = size_of(params.get("cols").map_or(100.0, |v| js_number(Some(v))));
                let rows = size_of(params.get("rows").map_or(30.0, |v| js_number(Some(v))));
                let relay_size = Self::relay_size_from_params(params, (cols, rows));
                stream.resize(cols, rows)?;
                {
                    let mut state = self.state();
                    state.viewport_revision += 1;
                    let revision = state.viewport_revision;
                    state.set_viewport(
                        socket,
                        &terminal,
                        ViewerViewport {
                            cols,
                            rows,
                            revision,
                        },
                    );
                    if let Some(&id) = state.by_terminal.get(&terminal)
                        && let Some(shared) = state.streams.get_mut(&id)
                    {
                        shared.cols = cols;
                        shared.rows = rows;
                    }
                    // Anything held was drawn for the previous size.
                    self.options()
                        .sink
                        .drop_coalesced(socket, &self.coalesce_key(&terminal));
                    if let Some((relay_cols, relay_rows)) = relay_size {
                        state.relay_revision += 1;
                        let revision = state.relay_revision;
                        Self::record_relay_viewport(
                            &mut state, socket, relay_cols, relay_rows, revision,
                        );
                        Self::sync_relay_size(&mut state, relay_cols, relay_rows);
                    }
                }
                self.debug(
                    "terminal resized",
                    json!({
                        "connection": self.connection(),
                        "client": self.label(socket),
                        "terminal": terminal,
                        "size": format!("{cols}x{rows}"),
                    }),
                );
                Ok(json!({"ok": true}))
            }
            "terminal.scroll" => {
                let Some((id, stream)) = stream else {
                    return Err(no_terminal());
                };
                let up = params.get("direction").and_then(Value::as_str) == Some("up");
                let lines = params.get("lines").map_or(3.0, |v| js_number(Some(v)));
                let column = params.get("column").and_then(Value::as_f64);
                let row = params.get("row").and_then(Value::as_f64);
                let source = params.get("source").and_then(Value::as_str);
                if source == Some("page-key")
                    && let Stream::Endpoint(session) = &stream
                {
                    // Herdr >= 0.9.0 routes PageUp and PageDown by the PTY's
                    // modes: application input or shell scrollback.
                    let Some(terminal) = requested else {
                        return Err(no_terminal());
                    };
                    let validate = self
                        .wait_for_owned(socket, &terminal, id, request_current.clone())
                        .await?;
                    validate()?;
                    session.input(if up { b"\x1b[5~" } else { b"\x1b[6~" });
                    return Ok(json!({"ok": true}));
                }
                // Explicit half-page shortcuts use pane.scroll on endpoints;
                // legacy AttachScroll keeps its Wheel source and line count.
                let page_key = source == Some("page-key")
                    || (source == Some("history") && stream.endpoint().is_some());
                match &stream {
                    Stream::Endpoint(session) => {
                        session.scroll(up, lines, column, row, page_key)?
                    }
                    Stream::Legacy(thin) => thin.scroll(
                        if up {
                            ScrollDirection::Up
                        } else {
                            ScrollDirection::Down
                        },
                        lines,
                        column.filter(|c| *c >= 0.0).map(|c| c as u64),
                        row.filter(|r| *r >= 0.0).map(|r| r as u64),
                        if page_key {
                            ScrollSource::PageKey
                        } else {
                            ScrollSource::Wheel
                        },
                    ),
                }
                Ok(json!({"ok": true}))
            }
            _ => Err(format!("unknown terminal method: {method}")),
        }
    }

    /// A browser socket closed.
    pub fn cleanup_socket(&self, socket: u64) {
        {
            let mut state = self.state();
            state.focus_intents.remove(&socket);
            state.focus_chains.remove(&socket);
            self.detach_viewer(&mut state, socket, None, None);
        }
        self.restore_relay_size(socket);
    }

    /// A browser typed into one of its terminals another way than
    /// `terminal.input` (the composer through Herdr's pane API): a
    /// clipboard write the command makes goes back to that browser.
    pub fn note_terminal_input(&self, socket: u64, terminal_id: &str) {
        let now = self.options().clock.now();
        let mut state = self.state();
        let Some(&stream) = state.by_terminal.get(terminal_id) else {
            return;
        };
        if !state.views(socket, terminal_id) {
            return;
        }
        state.clipboard_target = Some(ClipboardTarget {
            socket,
            terminal_id: terminal_id.to_owned(),
            input_at: now,
            stream,
        });
    }

    pub fn viewed_terminals(&self, socket: u64) -> Vec<String> {
        self.state()
            .viewers
            .get(&socket)
            .map(|viewed| viewed.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default()
    }

    /// Each attached terminal's endpoint advertisement (null on a legacy
    /// stream); warm streams with no viewers are not attachments.
    pub fn endpoint_availability(&self) -> Value {
        let state = self.state();
        let mut availability = Map::new();
        let mut ids: Vec<(&String, &u64)> = state.by_terminal.iter().collect();
        ids.sort_by_key(|(_, id)| **id);
        for (terminal, id) in ids {
            let Some(shared) = state.streams.get(id).filter(|shared| !shared.idle) else {
                continue;
            };
            availability.insert(
                terminal.clone(),
                shared
                    .stream
                    .endpoint()
                    .and_then(EndpointTerminalSession::negotiation)
                    .map_or(Value::Null, |welcome| welcome.to_value()),
            );
        }
        Value::Object(availability)
    }

    /// `bridge.status`'s terminals.
    pub fn status_terminals(&self) -> Vec<Value> {
        let state = self.state();
        let mut ids: Vec<(&String, &u64)> = state.by_terminal.iter().collect();
        ids.sort_by_key(|(_, id)| **id);
        ids.into_iter()
            .filter_map(|(terminal, id)| {
                let shared = state.streams.get(id)?;
                Some(json!({"terminal_id": terminal, "viewers": shared.viewers.len()}))
            })
            .collect()
    }

    /// The surface codec setting changed: endpoint streams reconnect.
    pub fn refresh_surface_codecs(&self) {
        let (observer, streams) = {
            let mut state = self.state();
            if state.disposed {
                return;
            }
            state.surface_settings_revision += 1;
            let observer = state.popup_observer.as_ref().map(|(_, o)| o.clone());
            let ids: Vec<u64> = state.by_terminal.values().copied().collect();
            let mut streams = Vec::new();
            for id in ids {
                if let Some(shared) = state.streams.get_mut(&id)
                    && shared.stream.endpoint().is_some()
                {
                    shared.last_error = Some("terminal_configuration_changed".into());
                    streams.push(shared.stream.clone());
                }
            }
            (observer, streams)
        };
        if let Some(observer) = observer {
            observer.close();
        }
        for stream in streams {
            stream.close();
        }
    }

    pub fn dispose(&self) {
        let (observer, streams) = {
            let mut state = self.state();
            if state.disposed {
                return;
            }
            state.disposed = true;
            state.lifecycle_revision += 1;
            let observer = state.popup_observer.as_ref().map(|(_, o)| o.clone());
            Self::close_clipboard_relay(&mut state);
            let sockets: Vec<u64> = state.viewers.keys().copied().collect();
            for socket in sockets {
                self.detach_viewer(&mut state, socket, None, None);
            }
            let ids: Vec<u64> = state.streams.keys().copied().collect();
            let mut streams = Vec::new();
            for id in ids {
                Self::wake_shared(&mut state, id);
                streams.push(state.streams[&id].stream.clone());
            }
            state.by_terminal.clear();
            state.viewers.clear();
            state.relay_viewports.clear();
            state.relay_owner = None;
            state.attachment_tokens.clear();
            state.focus_intents.clear();
            state.focus_chains.clear();
            state.terminals.clear();
            (observer, streams)
        };
        if let Some(observer) = observer {
            observer.close();
        }
        for stream in streams {
            stream.close();
        }
    }
}

/// A legacy client's event as a stream event (none for what the bridge
/// does not read).
fn legacy_event(event: ThinEvent) -> Option<StreamEvent> {
    Some(match event {
        ThinEvent::Terminal {
            seq,
            width,
            height,
            full,
            bytes,
        } => StreamEvent::Terminal(Arc::new(TerminalFrame {
            link_frame: None,
            seq,
            width,
            height,
            full,
            mouse_reporting: None,
            history: None,
            bytes: Arc::new(bytes),
            frame: None,
        })),
        ThinEvent::Clipboard(data) => StreamEvent::Clipboard(data),
        ThinEvent::Welcome {
            version,
            encoding,
            error,
        } => StreamEvent::Welcome {
            version: json!(version),
            encoding,
            error,
        },
        ThinEvent::Error(error) => StreamEvent::Error(error),
        ThinEvent::Close => StreamEvent::Close,
        _ => return None,
    })
}
