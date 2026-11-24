//! A terminal stream over the stable endpoint protocol, Herdr >= 0.9.0
//! (bridge/endpoint-terminal-session.ts).
//!
//! The endpoint shell renders the focused tab, so this session focuses the
//! pane (which focuses its tab for this shell connection only) and crops
//! the tab surface down to the pane's content rect before re-encoding it
//! as ANSI.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use roamgate_base::clock::SharedClock;
use roamgate_base::log::{LogLevel, Logger};
use roamgate_herdr::endpoint::input::{MouseEvent, PaneInputEvent, VtInputClassifier, mouse_kind};
use roamgate_herdr::endpoint::surface::{PaneMeta, Rect, SurfaceBaseline};
use roamgate_herdr::endpoint::{EndpointClient, EndpointEvent, EndpointRole, EndpointWelcome};
use roamgate_herdr::thin::FrameData as WireFrame;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{BoxFuture, History, Lane, StreamEvent, StreamListener, TerminalFrame, log_fields};
use crate::frame_to_ansi::{CellData, CursorData, FrameData, frame_to_ansi, string_width};

/// Echo timing samples one typed character only: control keys, escape
/// sequences and pastes often redraw without a plain echo.
pub fn is_typed_character(data: &[u8]) -> bool {
    if data.is_empty() || data.len() > 4 {
        return false;
    }
    let text = String::from_utf8_lossy(data);
    let mut chars = text.chars();
    let (Some(only), None) = (chars.next(), chars.next()) else {
        return false;
    };
    let code = only as u32;
    !(code <= 0x1f || (0x7f..=0x9f).contains(&code) || only == '\u{fffd}')
}

const ESC_FLUSH_MS: u64 = 25;
/// A typed character the next surface has not followed within this long is
/// dropped from echo timing.
pub const ECHO_SAMPLE_MAX_MS: f64 = 5000.0;
const FIRST_SURFACE_WAIT_MS: u64 = 10_000;
/// Waits between pane lookups that miss: 1.2 s in all, past the second a
/// pane list answer is reused for.
const PANE_LOOKUP_RETRY_MS: [u64; 3] = [100, 300, 800];
/// Boot correction plus rounding follow-ups; nested splits can need three.
const SURFACE_FIT_MAX_ATTEMPTS: u32 = 3;
/// How long a misfitting frame waits for the settled replacement.
const FIT_DEFER_MS: u64 = 500;
/// How long one endpoint command may take before the session closes.
const COMMAND_TIMEOUT_MS: u64 = 10_000;

/// The pane a terminal shows (control-socket `pane.list`).
pub type LookupPaneId = Arc<dyn Fn(String) -> BoxFuture<Option<String>> + Send + Sync>;
/// Whether a focus still holds (an error: the attachment changed).
pub type FocusCurrent = Arc<dyn Fn() -> Result<bool, String> + Send + Sync>;
pub type Wake = Arc<dyn Fn() + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Size {
    cols: u64,
    rows: u64,
}

#[derive(Debug, Clone, Copy)]
struct ScrollDispatch {
    id: u64,
    offset: u64,
    start_offset: u64,
    observed: bool,
}

/// The frame a viewer's link lookups read.
struct LinkFrame {
    token: String,
    pane: PaneMeta,
    frame: Arc<FrameData>,
}

struct Deferred {
    id: u64,
    emit: Box<dyn FnOnce() + Send>,
    size: Size,
}

#[derive(Default)]
struct State {
    classifier: VtInputClassifier,
    pressed_mouse_buttons: HashSet<u64>,
    esc_flush: Option<tokio::task::JoinHandle<()>>,
    pane_id: Option<String>,
    /// (offset from bottom, max offset from bottom)
    last_scroll: Option<(u64, u64)>,
    /// Wheel intent, kept apart from viewport feedback: a delayed surface
    /// must not replace movement newer wheel events queued.
    scroll_target: Option<u64>,
    scroll_in_flight: bool,
    /// One dispatch waits for both its RPC and viewport feedback; further
    /// wheel events coalesce into the target.
    scroll_dispatched: Option<ScrollDispatch>,
    next_dispatch: u64,
    closed: bool,
    seq: u64,
    /// When the oldest unanswered typed character was sent (debug echo
    /// timing).
    pending_echo_at: Option<Instant>,
    link_lookup_epoch: u64,
    link_frame: Option<LinkFrame>,
    deferred: Option<Deferred>,
    next_deferred: u64,
    pane_size: Size,
    fit_attempts: u32,
    fit_resize_in_flight: bool,
    last_request: Size,
    connecting: bool,
}

struct Inner {
    client: EndpointClient,
    terminal_id: String,
    lookup_pane_id: LookupPaneId,
    logger: Logger,
    clock: SharedClock,
    wake_herdr: Option<Wake>,
    link_session_id: String,
    state: Mutex<State>,
    commands: Lane,
    listener: Mutex<Option<StreamListener>>,
}

/// One terminal's endpoint shell. Clones are the same session.
#[derive(Clone)]
pub struct EndpointTerminalSession {
    inner: Arc<Inner>,
}

impl EndpointTerminalSession {
    pub fn new(
        socket_path: &str,
        terminal_id: &str,
        lookup_pane_id: LookupPaneId,
        logger: Logger,
        surface_codecs: bool,
        wake_herdr: Option<Wake>,
        clock: SharedClock,
    ) -> Self {
        let client = EndpointClient::new(
            socket_path,
            surface_codecs,
            EndpointRole::Terminal,
            Some(clock.clone()),
        );
        let session = Self {
            inner: Arc::new(Inner {
                client: client.clone(),
                terminal_id: terminal_id.to_owned(),
                lookup_pane_id,
                logger,
                clock,
                wake_herdr,
                link_session_id: uuid::Uuid::new_v4().to_string(),
                state: Mutex::default(),
                commands: Lane::new(),
                listener: Mutex::default(),
            }),
        };
        let weak = Arc::downgrade(&session.inner);
        client.on(Arc::new(move |event| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let session = EndpointTerminalSession { inner };
            match event {
                EndpointEvent::Surface(surface) => session.on_surface(surface),
                EndpointEvent::Clipboard(data) => {
                    let ready = {
                        let state = session.state();
                        !state.closed && state.pane_id.is_some()
                    };
                    if ready {
                        session.emit(StreamEvent::Clipboard(data.clone()));
                    }
                }
                EndpointEvent::Error(error) => session.emit(StreamEvent::Error(error.clone())),
                EndpointEvent::Close => {
                    session.close();
                    session.emit(StreamEvent::Close);
                }
                EndpointEvent::Welcome(welcome) => session.emit(StreamEvent::Welcome {
                    version: welcome.server_version.clone().unwrap_or(Value::Null),
                    encoding: 1,
                    error: None,
                }),
                _ => {}
            }
        }));
        session
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().expect("endpoint terminal session")
    }

    /// Where its events go (the bridge, set before `connect`).
    pub fn set_listener(&self, listener: StreamListener) {
        *self.inner.listener.lock().unwrap() = Some(listener);
    }

    fn emit(&self, event: StreamEvent) {
        let listener = self.inner.listener.lock().unwrap().clone();
        if let Some(listener) = listener {
            listener(event);
        }
    }

    pub fn is_closed(&self) -> bool {
        self.state().closed
    }

    pub fn negotiation(&self) -> Option<EndpointWelcome> {
        self.inner.client.negotiation()
    }

    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Connects, focuses the terminal's pane and waits for its first
    /// surface. `surface` is the browser layout's full-tab viewport hint.
    pub fn connect(
        &self,
        cols: u64,
        rows: u64,
        surface: Option<(u64, u64)>,
    ) -> BoxFuture<Result<(), String>> {
        let surface = surface.map_or(Size { cols, rows }, |(cols, rows)| Size { cols, rows });
        {
            let mut state = self.state();
            state.pane_size = Size { cols, rows };
            // The browser layout gives the first full-tab viewport; surface
            // feedback still corrects stale hints.
            state.fit_attempts = SURFACE_FIT_MAX_ATTEMPTS;
            state.last_request = surface;
            state.connecting = true;
        }
        let this = self.clone();
        let task = tokio::spawn(async move {
            let outcome = this.ready(surface).await;
            if let Err(error) = &outcome {
                this.inner.logger.warn(
                    "endpoint connect failed",
                    Some(&log_fields(
                        json!({"terminal": this.inner.terminal_id, "error": error}),
                    )),
                );
                this.close();
            }
            this.state().connecting = false;
            outcome
        });
        Box::pin(async move {
            task.await
                .unwrap_or_else(|error| Err(format!("endpoint connect failed: {error}")))
        })
    }

    /// Whether `connect` is still running.
    pub fn connecting(&self) -> bool {
        self.state().connecting
    }

    async fn ready(&self, surface: Size) -> Result<(), String> {
        let started = Instant::now();
        let mut phases = serde_json::Map::new();
        let mark = |phases: &mut serde_json::Map<String, Value>, phase: &str| {
            phases.insert(phase.into(), json!(started.elapsed().as_millis() as u64));
        };
        // The lookup only needs Herdr's control socket: it runs during the
        // endpoint handshake.
        let lookup = tokio::spawn(self.clone().find_pane_id());
        self.inner
            .client
            .connect(surface.cols, surface.rows, self.inner.wake_herdr.clone())
            .await?;
        mark(&mut phases, "hello_ms");
        self.inner.client.assert_method("pane.focus")?;
        let pane_id = lookup.await.ok().flatten();
        mark(&mut phases, "lookup_ms");
        let Some(pane_id) = pane_id else {
            return Err(format!(
                "no pane found for terminal {} (endpoint path)",
                self.inner.terminal_id
            ));
        };
        self.state().pane_id = Some(pane_id.clone());
        // Focus scopes this shell's surface to the pane's tab; per-client
        // tab navigation leaves other clients on their own tabs.
        let client = self.inner.client.clone();
        let focus = pane_id.clone();
        self.enqueue(move || client.call_endpoint("pane.focus", json!({"pane_id": focus}), None))
            .await?;
        mark(&mut phases, "focus_ms");
        // A surface may have come before the lookup resolved.
        if let Some(current) = self.inner.client.current_surface()
            && has_pane(Some(&current), &pane_id)
        {
            self.on_surface(&current);
        }
        self.wait_for_surface(&pane_id).await?;
        mark(&mut phases, "surface_ms");
        let mut fields = log_fields(json!({"terminal": self.inner.terminal_id}));
        fields.extend(phases);
        self.inner.logger.debug("endpoint connected", Some(&fields));
        Ok(())
    }

    /// The pane showing this terminal. A terminal made a moment ago can be
    /// missing from a pane list Herdr's client reuses until Herdr's event
    /// for it comes, so a miss is retried a little longer than that reuse.
    async fn find_pane_id(self) -> Option<String> {
        let delays = PANE_LOOKUP_RETRY_MS.iter().map(Some).chain([None]);
        for delay in delays {
            let pane = (self.inner.lookup_pane_id)(self.inner.terminal_id.clone()).await;
            if pane.is_some() || delay.is_none() || self.is_closed() {
                return pane;
            }
            self.inner
                .clock
                .sleep(Duration::from_millis(*delay.expect("checked")))
                .await;
        }
        None
    }

    /// One endpoint command after the previous one settled, 10 s at most
    /// (the session closes then).
    fn enqueue<T, F>(&self, run: F) -> BoxFuture<Result<T, String>>
    where
        T: Send + 'static,
        F: FnOnce() -> BoxFuture<Result<T, String>> + Send + 'static,
    {
        let this = self.clone();
        let queued = self.inner.commands.run(move || {
            Box::pin(async move {
                if this.is_closed() {
                    return Err("Endpoint terminal is closed".to_owned());
                }
                let timeout = this
                    .inner
                    .clock
                    .sleep(Duration::from_millis(COMMAND_TIMEOUT_MS));
                tokio::select! {
                    outcome = run() => outcome,
                    () = timeout => {
                        this.close();
                        Err("Endpoint command timed out; check Herdr before retrying. Creation may have succeeded.".to_owned())
                    }
                }
            })
        });
        Box::pin(async move {
            queued
                .await
                .unwrap_or_else(|| Err("Endpoint terminal is closed".to_owned()))
        })
    }

    /// Selects the cursor owner on this shell's scoped endpoint lane.
    pub fn focus(&self, is_current: FocusCurrent) -> BoxFuture<Result<(), String>> {
        let this = self.clone();
        self.enqueue(move || {
            Box::pin(async move {
                if !is_current()? {
                    return Ok(());
                }
                let pane = this
                    .state()
                    .pane_id
                    .clone()
                    .ok_or("Endpoint terminal is not ready")?;
                this.inner
                    .client
                    .call_endpoint("pane.focus", json!({"pane_id": pane}), None)
                    .await?;
                if !is_current()? {
                    return Ok(());
                }
                // The viewport is claimed again only when this viewer
                // focuses the tab again: passive surfaces from other
                // viewers must not restart fitting.
                this.state().fit_attempts = SURFACE_FIT_MAX_ATTEMPTS;
                if let Some(surface) = this.inner.client.current_surface()
                    && let Some(pane) = surface.panes.iter().find(|p| p.pane_id == pane)
                {
                    let pane = pane.clone();
                    let mut state = this.state();
                    this.fit_surface(&mut state, &surface, &pane);
                }
                Ok(())
            })
        })
    }

    /// Creates a tab or workspace on the attached shell's lane; never
    /// refocuses it for creation.
    pub fn create(
        &self,
        method: &str,
        params: serde_json::Map<String, Value>,
        source_pane_id: String,
        validate_source: BoxFuture<Result<(), String>>,
        deadline: roamgate_herdr::endpoint::creation::CreationDeadline,
    ) -> BoxFuture<Result<Value, String>> {
        let this = self.clone();
        let method = method.to_owned();
        let lane_deadline = deadline.clone();
        let queued = self.enqueue(move || {
            Box::pin(async move {
                lane_deadline.assert_before_dispatch()?;
                let ready = |this: &Self| {
                    let surface = this.inner.client.current_surface();
                    let state = this.state();
                    !state.closed
                        && !state.connecting
                        && state.pane_id.as_deref() == Some(source_pane_id.as_str())
                        && has_pane(surface.as_deref(), &source_pane_id)
                };
                if !ready(&this) {
                    return Err(
                        "Source terminal is not ready. Open its tab and retry creation.".into(),
                    );
                }
                for required in ["pane.focus", method.as_str()] {
                    this.inner.client.assert_method(required)?;
                }
                validate_source.await?;
                if !ready(&this) {
                    return Err(
                        "Source terminal changed before creation. Open its tab and retry.".into(),
                    );
                }
                let mut params = params;
                params.insert("focus".into(), Value::Bool(false));
                lane_deadline
                    .dispatch(
                        this.inner
                            .client
                            .call_endpoint(&method, Value::Object(params), None),
                    )
                    .await
            })
        });
        let this = self.clone();
        Box::pin(async move {
            deadline
                .wait(queued, Some(Box::new(move || this.close())))
                .await
        })
    }

    async fn wait_for_surface(&self, pane_id: &str) -> Result<(), String> {
        if has_pane(self.inner.client.current_surface().as_deref(), pane_id) {
            return Ok(());
        }
        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let tx = Mutex::new(Some(tx));
        let wanted = pane_id.to_owned();
        let listener = self.inner.client.on(Arc::new(move |event| {
            let outcome = match event {
                EndpointEvent::Surface(surface) if has_pane(Some(surface), &wanted) => Ok(()),
                EndpointEvent::Close => {
                    Err("endpoint connection closed before first surface".to_owned())
                }
                _ => return,
            };
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(outcome);
            }
        }));
        let closed_already = self.inner.client.is_closed();
        let timeout = self
            .inner
            .clock
            .sleep(Duration::from_millis(FIRST_SURFACE_WAIT_MS));
        let outcome = if closed_already
            && !has_pane(self.inner.client.current_surface().as_deref(), pane_id)
        {
            Err("endpoint connection closed before first surface".to_owned())
        } else {
            tokio::select! {
                outcome = rx => outcome.unwrap_or_else(|_| Err("endpoint connection closed before first surface".to_owned())),
                () = timeout => Err(format!("timed out waiting for endpoint surface of {pane_id}")),
            }
        };
        self.inner.client.off(listener);
        outcome
    }

    fn on_surface(&self, surface: &Arc<SurfaceBaseline>) {
        let mut state = self.state();
        if state.closed {
            return;
        }
        // connect() replays after the lookup.
        let Some(pane_id) = state.pane_id.clone() else {
            return;
        };
        let pane = surface.panes.iter().find(|p| p.pane_id == pane_id).cloned();
        if !pane.as_ref().is_some_and(|pane| pane.mouse_reporting) {
            state.pressed_mouse_buttons.clear();
        }
        let Some(pane) = pane else {
            state.link_frame = None;
            state.last_scroll = None;
            state.scroll_target = None;
            state.scroll_dispatched = None;
            return;
        };
        let surface_at = Instant::now();
        let echo_sent_at = state.pending_echo_at.filter(|at| {
            surface_at.duration_since(*at).as_secs_f64() * 1000.0 <= ECHO_SAMPLE_MAX_MS
        });
        state.pending_echo_at = None;
        self.fit_surface(&mut state, surface, &pane);
        let previous_max = state.last_scroll.map(|(_, max)| max);
        state.last_scroll = pane
            .scroll
            .map(|scroll| (scroll.offset_from_bottom, scroll.max_offset_from_bottom));
        match state.last_scroll {
            None => {
                state.scroll_target = None;
                state.scroll_dispatched = None;
            }
            Some((offset, max)) if state.scroll_target.is_some() => {
                let sent = state.scroll_dispatched;
                let mut target = state.scroll_target.expect("checked") as i64;
                // Only outstanding movement is rebased, not a finished
                // dispatch awaiting its frame.
                if sent.is_none_or(|sent| {
                    (state.scroll_in_flight && !sent.observed)
                        || Some(sent.offset) != state.scroll_target
                }) {
                    let growth = previous_max.map_or(0, |previous| max as i64 - previous as i64);
                    if target > 0 {
                        target += growth;
                    }
                }
                state.scroll_target = Some(target.clamp(0, max as i64) as u64);
                if let Some(sent) = state.scroll_dispatched.as_mut() {
                    sent.offset = sent.offset.min(max);
                    if offset == sent.offset || offset != sent.start_offset {
                        sent.observed = true;
                    }
                }
                self.settle_scroll(&mut state);
            }
            Some(_) => {}
        }

        let cropped = Arc::new(crop_frame(&surface.frame, &pane.inner_rect));
        // Herdr sends full surfaces even for focus and read-only link RPCs:
        // a surface's sequence is not the link content's identity, and the
        // cursor is not content.
        if !state
            .link_frame
            .as_ref()
            .is_some_and(|link| same_link_content(link, &pane, &cropped))
        {
            state.link_frame = None;
        }
        let bytes = Arc::new(frame_to_ansi(&cropped, None).into_bytes());
        let mouse_reporting = pane.mouse_reporting;
        let surface_size = Size {
            cols: surface.frame.width,
            rows: surface.frame.height,
        };
        let this = self.clone();
        let emit_pane = pane.clone();
        let emit = move || {
            let frame = {
                let mut state = this.state();
                if state.closed {
                    return;
                }
                state.seq += 1;
                let seq = state.seq;
                let token = state
                    .link_frame
                    .as_ref()
                    .map(|link| link.token.clone())
                    .unwrap_or_else(|| format!("{}:{seq}", this.inner.link_session_id));
                if state.link_frame.is_none() {
                    state.link_frame = Some(LinkFrame {
                        token: token.clone(),
                        pane: emit_pane.clone(),
                        frame: cropped.clone(),
                    });
                }
                TerminalFrame {
                    link_frame: Some(token),
                    seq,
                    width: cropped.width as u64,
                    height: cropped.height as u64,
                    full: true,
                    mouse_reporting: Some(mouse_reporting),
                    history: emit_pane.scroll.map(|scroll| History {
                        revision: emit_pane.content_revision,
                        top: scroll.max_offset_from_bottom - scroll.offset_from_bottom,
                        total: scroll.max_offset_from_bottom + scroll.viewport_rows,
                        cols: emit_pane.inner_rect.width,
                        rows: emit_pane.inner_rect.height,
                    }),
                    bytes,
                    frame: Some(cropped),
                }
            };
            this.emit(StreamEvent::Terminal(Arc::new(frame)));
            if let Some(sent_at) = echo_sent_at {
                this.inner.logger.debug(
                    "terminal echo",
                    Some(&log_fields(json!({
                        "terminal": this.inner.terminal_id,
                        // The next surface, not necessarily the echo itself.
                        "input_to_surface_max_ms": surface_at.duration_since(sent_at).as_millis() as u64,
                        "surface_to_send_ms": surface_at.elapsed().as_millis() as u64,
                    }))),
                );
            }
        };
        // The requested geometry is waited for whatever the split ratio;
        // new frames replace the pending one, never extend its deadline.
        if state.fit_resize_in_flight {
            if let Some(deferred) = state.deferred.as_mut() {
                deferred.emit = Box::new(emit);
                deferred.size = surface_size;
            } else {
                state.next_deferred += 1;
                let id = state.next_deferred;
                state.deferred = Some(Deferred {
                    id,
                    emit: Box::new(emit),
                    size: surface_size,
                });
                let this = self.clone();
                let wait = self.inner.clock.sleep(Duration::from_millis(FIT_DEFER_MS));
                tokio::spawn(async move {
                    wait.await;
                    this.deferred_due(id);
                });
            }
            return;
        }
        state.deferred = None;
        drop(state);
        emit();
    }

    /// A misfitting frame's wait ended with no settled replacement.
    fn deferred_due(&self, id: u64) {
        let pending = {
            let mut state = self.state();
            if state
                .deferred
                .as_ref()
                .is_none_or(|deferred| deferred.id != id)
            {
                return;
            }
            let pending = state.deferred.take().expect("checked");
            state.fit_resize_in_flight = false;
            // The request did not settle: the fallback is observed
            // geometry, the rest of the fit budget kept for a retry.
            state.last_request = pending.size;
            pending
        };
        (pending.emit)();
        // An idle pane may send no other surface after a foreign resize.
        let surface = self.inner.client.current_surface();
        let mut state = self.state();
        let pane = state.pane_id.as_ref().and_then(|pane| {
            surface
                .as_ref()?
                .panes
                .iter()
                .find(|p| &p.pane_id == pane)
                .cloned()
        });
        if !state.closed
            && let (Some(surface), Some(pane)) = (surface, pane)
        {
            self.fit_surface(&mut state, &surface, &pane);
        }
    }

    pub fn resize(&self, cols: u64, rows: u64) -> Result<(), String> {
        let surface = self.inner.client.current_surface();
        let next = {
            let mut state = self.state();
            state.link_frame = None;
            state.deferred = None;
            state.pane_size = Size { cols, rows };
            state.fit_attempts = SURFACE_FIT_MAX_ATTEMPTS;
            let next = request_for(&state, surface.as_deref());
            // Explicit viewer requests include same-size repaints for new
            // viewers.
            state.fit_resize_in_flight = true;
            state.last_request = next;
            next
        };
        self.inner.client.resize(next.cols, next.rows)
    }

    /// Convergence is content-shaped, not frame-shaped: once the cropped
    /// pane content matches the xterm size no further resize may fire.
    fn fit_surface(&self, state: &mut State, surface: &SurfaceBaseline, pane: &PaneMeta) {
        // Stale replies are ignored while our resize is in flight; once
        // settled, another surface size is another client's on this tab.
        if surface.frame.width != state.last_request.cols
            || surface.frame.height != state.last_request.rows
        {
            if state.fit_resize_in_flight {
                return;
            }
            state.last_request = Size {
                cols: surface.frame.width,
                rows: surface.frame.height,
            };
        }
        state.fit_resize_in_flight = false;
        if state.fit_attempts == 0 {
            return;
        }
        if pane.inner_rect.width == state.pane_size.cols
            && pane.inner_rect.height == state.pane_size.rows
        {
            state.fit_attempts = 0;
            return;
        }
        // Small undershoots leave harmless space; overshoots hide content
        // and must converge even by one cell.
        let off = |wanted: u64, actual: u64| {
            actual > wanted
                || (wanted - actual >= 2 && (wanted - actual) as f64 / wanted as f64 >= 0.02)
        };
        if !off(state.pane_size.cols, pane.inner_rect.width)
            && !off(state.pane_size.rows, pane.inner_rect.height)
        {
            state.fit_attempts = 0;
            return;
        }
        let next = size_for_pane(state, surface, pane);
        // At most one request in flight: stale surfaces never ask again,
        // nor does the same size.
        if next == state.last_request {
            return;
        }
        if surface.frame.width != state.last_request.cols
            || surface.frame.height != state.last_request.rows
        {
            return;
        }
        if state.fit_attempts > 0 {
            state.fit_attempts -= 1;
        }
        state.fit_resize_in_flight = true;
        state.last_request = next;
        let _ = self.inner.client.resize(next.cols, next.rows);
    }

    pub fn input(&self, data: &[u8]) {
        let surface = self.inner.client.current_surface();
        let (pane_id, events) = {
            let mut state = self.state();
            state.link_frame = None;
            let Some(pane_id) = state.pane_id.clone().filter(|_| !state.closed) else {
                return;
            };
            if self.inner.logger.enabled(LogLevel::Debug) && is_typed_character(data) {
                let now = Instant::now();
                if state.pending_echo_at.is_none_or(|at| {
                    now.duration_since(at).as_secs_f64() * 1000.0 > ECHO_SAMPLE_MAX_MS
                }) {
                    state.pending_echo_at = Some(now);
                }
            }
            // Typing or application input supersedes a queued history
            // gesture.
            if !data.is_empty() {
                state.scroll_target = None;
                state.scroll_dispatched = None;
            }
            let pane = surface
                .as_ref()
                .and_then(|surface| surface.panes.iter().find(|p| p.pane_id == pane_id));
            let events = state.classifier.feed(data);
            let mut kept = Vec::with_capacity(events.len());
            for event in events {
                let PaneInputEvent::Mouse(mut mouse) = event else {
                    kept.push(event);
                    continue;
                };
                let Some(pane) = pane.filter(|pane| {
                    pane.mouse_reporting
                        && pane.inner_rect.width >= 1
                        && pane.inner_rect.height >= 1
                }) else {
                    state.pressed_mouse_buttons.clear();
                    continue;
                };
                let inside =
                    mouse.column < pane.inner_rect.width && mouse.row < pane.inner_rect.height;
                let button = mouse.button.unwrap_or(0);
                if mouse.kind == mouse_kind::DOWN {
                    state.pressed_mouse_buttons.remove(&button);
                    if inside {
                        state.pressed_mouse_buttons.insert(button);
                        kept.push(PaneInputEvent::Mouse(mouse));
                    }
                    continue;
                }
                if mouse.kind == mouse_kind::DRAG || mouse.kind == mouse_kind::UP {
                    if !state.pressed_mouse_buttons.contains(&button) {
                        continue;
                    }
                    // The browser canvas can exceed the crop: a gesture
                    // that began inside owns its release past it.
                    mouse.column = mouse.column.min(pane.inner_rect.width - 1);
                    mouse.row = mouse.row.min(pane.inner_rect.height - 1);
                    if mouse.kind == mouse_kind::UP {
                        state.pressed_mouse_buttons.remove(&button);
                    }
                    kept.push(PaneInputEvent::Mouse(mouse));
                    continue;
                }
                if inside {
                    kept.push(PaneInputEvent::Mouse(mouse));
                }
            }
            if let Some(timer) = state.esc_flush.take() {
                timer.abort();
            }
            let this = self.clone();
            let wait = self.inner.clock.sleep(Duration::from_millis(ESC_FLUSH_MS));
            state.esc_flush = Some(tokio::spawn(async move {
                wait.await;
                let flushed = {
                    let mut state = this.state();
                    state.esc_flush = None;
                    let Some(pane) = state.pane_id.clone().filter(|_| !state.closed) else {
                        return;
                    };
                    (pane, state.classifier.flush())
                };
                let _ = this.inner.client.send_pane_input(&flushed.0, &flushed.1);
            }));
            (pane_id, kept)
        };
        let _ = self.inner.client.send_pane_input(&pane_id, &events);
    }

    /// Wheel, touch and page scrolling: a wheel over a program that reads
    /// the mouse is its input; history moves through `pane.scroll`.
    pub fn scroll(
        &self,
        up: bool,
        lines: f64,
        column: Option<f64>,
        row: Option<f64>,
        page_key: bool,
    ) -> Result<(), String> {
        let Some(pane_id) = self.state().pane_id.clone() else {
            return Ok(());
        };
        if !lines.is_finite() || lines <= 0.0 {
            return Ok(());
        }
        let lines = lines.floor().clamp(1.0, 65535.0) as u64;
        let surface = self.inner.client.current_surface();
        let pane = surface
            .as_ref()
            .and_then(|surface| surface.panes.iter().find(|p| p.pane_id == pane_id));
        // Touch scrolling uses the wheels' RPC; a page key stays an
        // explicit history action.
        if !page_key && pane.is_some_and(|pane| pane.mouse_reporting) {
            let pane = pane.expect("checked");
            let cell = |value: Option<f64>, limit: u64| {
                value.filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v < limit as f64)
            };
            let (Some(column), Some(row)) = (
                cell(column, pane.inner_rect.width),
                cell(row, pane.inner_rect.height),
            ) else {
                return Ok(());
            };
            self.state().link_frame = None;
            return self.inner.client.send_pane_input(
                &pane_id,
                &[PaneInputEvent::Mouse(MouseEvent {
                    kind: if up {
                        mouse_kind::SCROLL_UP
                    } else {
                        mouse_kind::SCROLL_DOWN
                    },
                    button: None,
                    column: column as u64,
                    row: row as u64,
                    modifiers: 0,
                    lines,
                })],
            );
        }
        self.inner.client.assert_method("pane.scroll")?;
        let mut state = self.state();
        let Some((offset, max)) = state.last_scroll else {
            return Ok(());
        };
        let from = state.scroll_target.unwrap_or(offset) as i64;
        let delta = if up { lines as i64 } else { -(lines as i64) };
        let next = (from + delta).clamp(0, max as i64) as u64;
        if next as i64 == from {
            return Ok(());
        }
        // Pending motion blocks lookups, but cancelled or clamped motion
        // may never repaint: the displayed token stays while requests from
        // before the gesture retire.
        state.link_lookup_epoch += 1;
        state.scroll_target = Some(next);
        self.flush_scroll(&mut state);
        Ok(())
    }

    fn settle_scroll(&self, state: &mut State) {
        let Some(sent) = state.scroll_dispatched else {
            return;
        };
        if state.scroll_in_flight || !sent.observed {
            return;
        }
        state.scroll_dispatched = None;
        if state.scroll_target == Some(sent.offset) {
            state.scroll_target = None;
        }
        self.flush_scroll(state);
    }

    fn flush_scroll(&self, state: &mut State) {
        if state.closed
            || state.scroll_in_flight
            || state.scroll_dispatched.is_some()
            || state.scroll_target.is_none()
        {
            return;
        }
        state.scroll_in_flight = true;
        let this = self.clone();
        let session = self.clone();
        let sent_id: Arc<Mutex<Option<u64>>> = Arc::default();
        let sent_in_job = sent_id.clone();
        let job = self.enqueue(move || {
            Box::pin(async move {
                let (pane_id, offset, start, id, before) = {
                    let mut state = this.state();
                    let (Some(offset), Some(pane_id), Some((start, _))) = (
                        state.scroll_target,
                        state.pane_id.clone(),
                        state.last_scroll,
                    ) else {
                        return Ok(());
                    };
                    if offset == start {
                        // Coalescing cancelled the unsent movement: no RPC
                        // or repaint is needed.
                        state.scroll_target = None;
                        return Ok(());
                    }
                    state.next_dispatch += 1;
                    let id = state.next_dispatch;
                    state.scroll_dispatched = Some(ScrollDispatch {
                        id,
                        offset,
                        start_offset: start,
                        observed: false,
                    });
                    *sent_in_job.lock().unwrap() = Some(id);
                    let before = this.inner.client.current_surface();
                    (pane_id, offset, start, id, before)
                };
                let result = this
                    .inner
                    .client
                    .call_endpoint(
                        "pane.scroll",
                        json!({"pane_id": pane_id, "offset_from_bottom": offset}),
                        None,
                    )
                    .await?;
                let mut state = this.state();
                if state.scroll_dispatched.is_none_or(|sent| sent.id != id) {
                    return Ok(());
                }
                // Herdr 0.9.0 answers PaneInfo with the applied (maybe
                // clamped) offset; older or opaque answers reconcile
                // through surfaces.
                let observed = state.scroll_dispatched.expect("checked").observed;
                if let Some((applied, max)) = scroll_result(&result, &pane_id)
                    && !observed
                {
                    if state.scroll_target == Some(offset) {
                        state.scroll_target = Some(applied);
                    } else if let Some(target) = state.scroll_target {
                        let same = match (&before, this.inner.client.current_surface()) {
                            (Some(before), Some(now)) => Arc::ptr_eq(before, &now),
                            (None, None) => true,
                            _ => false,
                        };
                        if same {
                            state.scroll_target = Some(target.min(max));
                        }
                    }
                    let sent = state.scroll_dispatched.as_mut().expect("checked");
                    sent.offset = applied;
                    if applied == start {
                        sent.observed = true;
                    }
                }
                Ok(())
            })
        });
        tokio::spawn(async move {
            let outcome = job.await;
            let mut state = session.state();
            state.scroll_in_flight = false;
            match outcome {
                Ok(()) => {
                    session.settle_scroll(&mut state);
                    session.flush_scroll(&mut state);
                }
                Err(error) => {
                    let sent = *sent_id.lock().unwrap();
                    if sent.is_some() && state.scroll_dispatched.map(|each| each.id) == sent {
                        state.scroll_target = None;
                        state.scroll_dispatched = None;
                    }
                    session.inner.logger.debug(
                        "endpoint pane.scroll failed",
                        Some(&log_fields(json!({"error": error}))),
                    );
                    session.flush_scroll(&mut state);
                }
            }
        });
    }

    /// Read-only hit testing on the very shell that drew the cropped pane.
    pub async fn resolve_link(&self, token: &str, row: u64, col: u64) -> Result<Value, String> {
        let changed = || "Terminal link frame changed".to_owned();
        let (pane_id, pane, frame, epoch, displayed) = {
            let state = self.state();
            let Some(link) = state.link_frame.as_ref() else {
                return Err(changed());
            };
            if link.token != token
                || !current_link(&state, &link.token, state.link_lookup_epoch)
                || row >= link.frame.height as u64
                || col >= link.frame.width as u64
            {
                return Err(changed());
            }
            let Some(pane_id) = state.pane_id.clone() else {
                return Err(changed());
            };
            if link.pane.pane_id != pane_id {
                return Err(changed());
            }
            (
                pane_id,
                link.pane.clone(),
                link.frame.clone(),
                state.link_lookup_epoch,
                link.token.clone(),
            )
        };
        // The public xterm buffer omits OSC 8 ids: the owned cropped frame
        // is read, without plugins or the optional plain-link resolver.
        if let Some(uri) = frame_hyperlink_at(&frame, row as usize, col as usize) {
            return Ok(json!({"regions": [], "url": null, "uri": uri}));
        }
        if !self
            .negotiation()
            .is_some_and(|welcome| welcome.methods.iter().any(|m| m == "pane.link.resolve"))
        {
            return Ok(json!({"regions": [], "url": null}));
        }
        self.inner.client.assert_method("pane.link.resolve")?;
        let mut params = json!({
            "pane_id": pane_id,
            "viewport_row": row,
            "col": col,
            "content_revision": pane.content_revision,
        });
        if let Some(scroll) = pane.scroll {
            params["offset_from_bottom"] = json!(scroll.offset_from_bottom);
        }
        // Optional hover reads must not block focus or scroll, nor close a
        // healthy terminal.
        let result = self
            .inner
            .client
            .call_endpoint("pane.link.resolve", params, Some(1500))
            .await?;
        {
            let state = self.state();
            if !current_link(&state, &displayed, epoch) {
                return Err(changed());
            }
        }
        Ok(resolved_frame_link(&result, &frame, row as i64, col as i64))
    }

    pub fn close(&self) {
        {
            let mut state = self.state();
            state.link_frame = None;
            if state.closed {
                return;
            }
            state.closed = true;
            state.scroll_target = None;
            state.scroll_dispatched = None;
            state.pressed_mouse_buttons.clear();
            if let Some(timer) = state.esc_flush.take() {
                timer.abort();
            }
            state.deferred = None;
        }
        self.inner.client.close();
    }
}

/// Whether a link lookup on `token` still reads what is displayed.
fn current_link(state: &State, token: &str, epoch: u64) -> bool {
    !state.closed
        && !state.connecting
        && state
            .link_frame
            .as_ref()
            .is_some_and(|link| link.token == token)
        && state.link_lookup_epoch == epoch
        && !state.fit_resize_in_flight
        && state.scroll_target.is_none()
}

fn has_pane(surface: Option<&SurfaceBaseline>, pane_id: &str) -> bool {
    surface.is_some_and(|surface| surface.panes.iter().any(|p| p.pane_id == pane_id))
}

/// Whether a link frame shows the same content (pane, revision, rect,
/// scroll and cells; the cursor is not content).
fn same_link_content(link: &LinkFrame, pane: &PaneMeta, frame: &FrameData) -> bool {
    link.pane.pane_id == pane.pane_id
        && link.pane.content_revision == pane.content_revision
        && link.pane.inner_rect == pane.inner_rect
        && link.pane.scroll == pane.scroll
        && link.frame.width == frame.width
        && link.frame.height == frame.height
        && link.frame.cells == frame.cells
        && link.frame.hyperlinks == frame.hyperlinks
}

/// The request for the latest observed geometry: the pane ratio inverts
/// the split so the cropped content lands on the xterm size; with no pane
/// seen, the pane size itself.
fn request_for(state: &State, surface: Option<&SurfaceBaseline>) -> Size {
    let pane = state
        .pane_id
        .as_ref()
        .and_then(|pane| surface?.panes.iter().find(|p| &p.pane_id == pane));
    match (surface, pane) {
        (Some(surface), Some(pane)) => size_for_pane(state, surface, pane),
        _ => state.pane_size,
    }
}

/// Endpoint sizes describe the whole tab: the observed pane ratio,
/// decorations included, is inverted so the first request targets the
/// wanted content size.
fn size_for_pane(state: &State, surface: &SurfaceBaseline, pane: &PaneMeta) -> Size {
    if pane.rect.width < 1
        || pane.rect.height < 1
        || pane.inner_rect.width < 1
        || pane.inner_rect.height < 1
    {
        return state.pane_size;
    }
    let scale = |wanted: u64, outer: u64, inner: u64, total: u64| -> u64 {
        let value = ((wanted as f64 + outer as f64 - inner as f64) * total as f64) / outer as f64;
        js_round(value).clamp(1.0, 65_535.0) as u64
    };
    Size {
        cols: scale(
            state.pane_size.cols,
            pane.rect.width,
            pane.inner_rect.width,
            surface.frame.width,
        ),
        rows: scale(
            state.pane_size.rows,
            pane.rect.height,
            pane.inner_rect.height,
            surface.frame.height,
        ),
    }
}

/// `Math.round`: halves up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// The applied offset and its maximum from a `pane.scroll` answer.
fn scroll_result(result: &Value, pane_id: &str) -> Option<(u64, u64)> {
    if result.get("type").and_then(Value::as_str) != Some("pane_info") {
        return None;
    }
    let pane = result.get("pane")?;
    if pane.get("pane_id").and_then(Value::as_str) != Some(pane_id) {
        return None;
    }
    let scroll = pane.get("scroll")?;
    let offset = scroll.get("offset_from_bottom")?.as_u64()?;
    let max = scroll.get("max_offset_from_bottom")?.as_u64()?;
    let safe = (1u64 << 53) - 1;
    (offset <= safe && max <= safe && max >= offset).then_some((offset, max))
}

/// One pane's content rect cut out of the tab surface.
pub fn crop_frame(frame: &WireFrame, rect: &Rect) -> FrameData {
    let width = rect.width.min(frame.width.saturating_sub(rect.x)) as usize;
    let height = rect.height.min(frame.height.saturating_sub(rect.y)) as usize;
    let (fw, rx, ry) = (frame.width as usize, rect.x as usize, rect.y as usize);
    let mut cells = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let cell = frame.cells.get((ry + y) * fw + rx + x);
            cells.push(match cell {
                Some(cell) => CellData {
                    symbol: cell.symbol.clone(),
                    fg: cell.fg as u32,
                    bg: cell.bg as u32,
                    modifier: cell.modifier as u32,
                    skip: cell.skip,
                    hyperlink: cell.hyperlink.map(|link| link as usize),
                },
                // A hole in the grid draws as Bun's missing cell did.
                None => CellData {
                    symbol: " ".into(),
                    fg: 0,
                    bg: 0,
                    modifier: 0,
                    skip: false,
                    hyperlink: None,
                },
            });
        }
    }
    let cursor = frame.cursor.as_ref().and_then(|cursor| {
        let x = cursor.x as i64 - rect.x as i64;
        let y = cursor.y as i64 - rect.y as i64;
        (x >= 0 && (x as usize) < width && y >= 0 && (y as usize) < height).then(|| CursorData {
            x: x as usize,
            y: y as usize,
            visible: cursor.visible,
            shape: u32::from(cursor.shape),
        })
    });
    FrameData {
        cells,
        width,
        height,
        cursor,
        hyperlinks: frame.hyperlinks.clone(),
    }
}

/// The OSC 8 link under a cell: None when there is none, `Some(Null)`
/// for an invalid id (labels are suppressed then).
pub fn frame_hyperlink_at(frame: &FrameData, row: usize, col: usize) -> Option<Value> {
    let mut x = 0;
    while x <= col {
        let Some(cell) = frame.cells.get(row * frame.width + x) else {
            x += 1;
            continue;
        };
        if cell.skip {
            x += 1;
            continue;
        }
        let width = string_width(&cell.symbol).max(1);
        if col < x + width {
            return cell.hyperlink.map(|link| {
                frame
                    .hyperlinks
                    .get(link)
                    .map_or(Value::Null, |uri| Value::String(uri.clone()))
            });
        }
        x += width;
    }
    None
}

/// `pane.link.resolve`'s regions, and the URL they spell when it can be
/// proven whole (the resolver returns regions, not a target; activating
/// is unsafe: it runs plugins).
pub fn resolved_frame_link(result: &Value, frame: &FrameData, row: i64, col: i64) -> Value {
    let empty = json!({"regions": [], "url": null});
    let (width, height) = (frame.width as i64, frame.height as i64);
    let Some(list) = result
        .as_object()
        .filter(|result| result.get("type").and_then(Value::as_str) == Some("pane_link_resolved"))
        .and_then(|result| result.get("regions"))
        .and_then(Value::as_array)
        .filter(|list| list.len() as i64 <= height)
    else {
        return empty;
    };
    let mut regions: Vec<(i64, i64, i64)> = Vec::new();
    for region in list {
        let field = |name: &str| region.get(name).and_then(Value::as_i64);
        let (Some(r), Some(start), Some(end)) =
            (field("row"), field("start_col"), field("end_col"))
        else {
            return empty;
        };
        if r < 0
            || r >= height
            || start < 0
            || end < start
            || end >= width
            || regions.last().is_some_and(|last| r <= last.0)
        {
            return empty;
        }
        regions.push((r, start, end));
    }
    if !regions
        .iter()
        .any(|(r, start, end)| *r == row && *start <= col && col <= *end)
    {
        return empty;
    }
    let listed = json!(
        regions
            .iter()
            .map(|(r, start, end)| json!({"row": r, "start_col": start, "end_col": end}))
            .collect::<Vec<_>>()
    );
    let unproven = json!({"regions": listed, "url": null});
    let first = regions[0];
    let last = regions[regions.len() - 1];
    // No read-only target API exists upstream: at either viewport edge the
    // URL cannot be proven whole.
    if (first.0 == 0 && first.1 == 0) || (last.0 == height - 1 && last.2 >= width - 2) {
        return unproven;
    }
    let cell_at = |index: i64| {
        if index < 0 {
            None
        } else {
            frame.cells.get(index as usize)
        }
    };
    let mut url = String::new();
    for (index, &(r, start, end)) in regions.iter().enumerate() {
        let previous = index.checked_sub(1).map(|at| regions[at]);
        if let Some(previous) = previous {
            let spacer = cell_at(r * width - 1);
            let first_cell = cell_at(r * width);
            let wide_wrap = previous.2 == width - 2
                && spacer.is_some_and(|spacer| {
                    spacer.symbol == " " && !spacer.skip && spacer.hyperlink.is_none()
                })
                && first_cell.is_some_and(|cell| !cell.skip && string_width(&cell.symbol) == 2);
            if r != previous.0 + 1 || start != 0 || (previous.2 != width - 1 && !wide_wrap) {
                return unproven;
            }
        }
        let mut x = start;
        while x <= end {
            let Some(cell) = cell_at(r * width + x) else {
                return unproven;
            };
            if cell.hyperlink.is_some() {
                return unproven;
            }
            if !cell.skip {
                url.push_str(&cell.symbol);
                x += string_width(&cell.symbol).saturating_sub(1) as i64;
            }
            x += 1;
        }
    }
    let lower = url.to_ascii_lowercase();
    let valid = (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url
            .chars()
            .any(|c| c.is_whitespace() || (c as u32) < 0x20 || c == '\u{7f}')
        && url::Url::parse(&url)
            .is_ok_and(|parsed| parsed.host_str().is_some_and(|h| !h.is_empty()));
    if !valid {
        return unproven;
    }
    json!({"regions": listed, "url": url})
}
