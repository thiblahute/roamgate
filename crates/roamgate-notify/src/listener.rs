//! Herdr's semantic notifications (notifications/herdr-notification-
//! listener.ts): one passive endpoint shell kept connected to Herdr, every
//! SemanticNotification it receives handed on, reconnected with capped
//! backoff. Herdr applies its own policy first (external-agent
//! suppression, `herdr notification show`), so Roamgate's alerts follow the
//! same rules as Herdr's toasts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use roamgate_herdr::BoxFuture;
use roamgate_herdr::endpoint::notification::SemanticNotification;
use roamgate_herdr::endpoint::{EndpointClient, EndpointEvent, EndpointRole};

const INITIAL_RETRY_MS: u64 = 1_000;
const MAX_RETRY_MS: u64 = 30_000;
// A passive shell's size does not matter, but must not be zero.
const PASSIVE_COLS: u64 = 80;
const PASSIVE_ROWS: u64 = 24;

pub type Notified = Arc<dyn Fn(&SemanticNotification) + Send + Sync>;
pub type Hook = Arc<dyn Fn() + Send + Sync>;
pub type ErrorHook = Arc<dyn Fn(&str) + Send + Sync>;
/// Whether Herdr speaks endpoint generation 1 now.
pub type Availability = Arc<dyn Fn() -> BoxFuture<Result<bool, String>> + Send + Sync>;

pub struct ListenerOptions {
    pub client_socket_path: String,
    pub on_notification: Notified,
    /// Whether the server speaks endpoint generation 1. Legacy servers never
    /// get an endpoint hello; they are checked again at the longest retry
    /// delay, in case Herdr is upgraded in place.
    pub is_available: Option<Availability>,
    pub on_unavailable: Option<Hook>,
    pub on_connected: Option<Hook>,
    pub on_error: Option<ErrorHook>,
    pub clock: SharedClock,
    pub initial_retry_ms: u64,
    pub max_retry_ms: u64,
}

impl ListenerOptions {
    pub fn new(client_socket_path: String, on_notification: Notified, clock: SharedClock) -> Self {
        Self {
            client_socket_path,
            on_notification,
            is_available: None,
            on_unavailable: None,
            on_connected: None,
            on_error: None,
            clock,
            initial_retry_ms: INITIAL_RETRY_MS,
            max_retry_ms: MAX_RETRY_MS,
        }
    }
}

#[derive(Default)]
struct State {
    running: bool,
    /// The shell connected or connecting, with its attempt's number.
    client: Option<(u64, EndpointClient)>,
    attempts: u64,
    retry: Option<tokio::task::JoinHandle<()>>,
    retry_ms: u64,
    /// Invalidates availability checks that settle after a stop or a
    /// restart.
    epoch: u64,
}

struct Inner {
    options: ListenerOptions,
    state: Mutex<State>,
}

/// One connection's listener. Clones are the same listener.
#[derive(Clone)]
pub struct HerdrNotificationListener {
    inner: Arc<Inner>,
}

impl HerdrNotificationListener {
    pub fn new(options: ListenerOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                options,
                state: Mutex::default(),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().expect("notification listener")
    }

    pub fn start(&self) {
        {
            let mut state = self.state();
            if state.running {
                return;
            }
            state.running = true;
            state.retry_ms = self.inner.options.initial_retry_ms;
        }
        self.connect();
    }

    pub fn stop(&self) {
        let client = {
            let mut state = self.state();
            state.running = false;
            state.epoch += 1;
            if let Some(retry) = state.retry.take() {
                retry.abort();
            }
            state.client.take()
        };
        if let Some((_, client)) = client {
            client.close();
        }
    }

    pub fn is_running(&self) -> bool {
        self.state().running
    }

    fn report(&self, error: &str) {
        // Observers must not stop the reconnects.
        if let Some(on_error) = &self.inner.options.on_error {
            on_error(error);
        }
    }

    fn schedule_retry(&self, delay: Option<u64>) {
        let mut state = self.state();
        let delay = delay.unwrap_or(state.retry_ms);
        state.retry_ms = (state.retry_ms * 2).min(self.inner.options.max_retry_ms);
        let this = self.clone();
        let wait = self.inner.options.clock.sleep(Duration::from_millis(delay));
        state.retry = Some(tokio::spawn(async move {
            wait.await;
            this.connect();
        }));
    }

    fn connect(&self) {
        let started = {
            let mut state = self.state();
            state.retry = None;
            if !state.running {
                return;
            }
            state.epoch
        };
        let Some(is_available) = self.inner.options.is_available.clone() else {
            self.open();
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            let available = is_available().await;
            {
                let state = this.state();
                if !state.running || started != state.epoch {
                    return;
                }
            }
            match available {
                Ok(true) => this.open(),
                Ok(false) => {
                    if let Some(unavailable) = &this.inner.options.on_unavailable {
                        unavailable();
                    }
                    this.schedule_retry(Some(this.inner.options.max_retry_ms));
                }
                Err(error) => {
                    this.report(&error);
                    this.schedule_retry(None);
                }
            }
        });
    }

    fn current(&self, attempt: u64) -> bool {
        self.state()
            .client
            .as_ref()
            .is_some_and(|(each, _)| *each == attempt)
    }

    fn open(&self) {
        let client = EndpointClient::new(
            self.inner.options.client_socket_path.clone(),
            false,
            EndpointRole::Notifications,
            Some(self.inner.options.clock.clone()),
        );
        let attempt = {
            let mut state = self.state();
            state.attempts += 1;
            let attempt = state.attempts;
            state.client = Some((attempt, client.clone()));
            attempt
        };
        let finished = Arc::new(Mutex::new(false));
        let retry = {
            let this = self.clone();
            let finished = finished.clone();
            let client = client.clone();
            Arc::new(move |error: String| {
                {
                    let mut done = finished.lock().unwrap();
                    if *done {
                        return;
                    }
                    *done = true;
                }
                {
                    let mut state = this.state();
                    if state
                        .client
                        .as_ref()
                        .is_some_and(|(each, _)| *each == attempt)
                    {
                        state.client = None;
                    }
                }
                client.close();
                if !this.state().running {
                    return;
                }
                this.report(&error);
                this.schedule_retry(None);
            })
        };
        let this = self.clone();
        let on_event = retry.clone();
        client.on(Arc::new(move |event| match event {
            EndpointEvent::SemanticNotification(notification) => {
                if this.state().running && this.current(attempt) {
                    (this.inner.options.on_notification)(notification);
                }
            }
            EndpointEvent::NotificationError(error) => this.report(error),
            EndpointEvent::Error(error) => on_event(error.clone()),
            EndpointEvent::Close => on_event("Herdr notification shell disconnected".into()),
            _ => {}
        }));
        let this = self.clone();
        let connecting = client.connect(PASSIVE_COLS, PASSIVE_ROWS, None);
        tokio::spawn(async move {
            match connecting.await {
                Ok(()) => {
                    let done = *finished.lock().unwrap();
                    if done || !this.state().running || !this.current(attempt) {
                        return;
                    }
                    this.state().retry_ms = this.inner.options.initial_retry_ms;
                    if let Some(connected) = &this.inner.options.on_connected {
                        connected();
                    }
                }
                Err(error) => retry(error),
            }
        });
    }
}

/// Herdr's semantic kinds as the feed's completed and blocked
/// preferences (`taskEventFromSemanticNotification`).
pub fn task_event(notification: &SemanticNotification) -> Option<serde_json::Value> {
    crate::task_events::task_event_from_semantic_notification(&notification.to_value())
}
