//! The notification feed's sockets (notifications/notification-feed.ts,
//! its sockets while the core owns the family): `/api/notifications/ws`,
//! the Android app's foreground service. The notifications family keeps
//! the numbered events and their file and sends Web Push; this keeps the
//! sockets with a copy of the events it hands over after each change
//! (`notifications.feed`), and sends each socket what it asked for:
//! nothing before its hello, then what came after its `since` and what
//! comes next, filtered by its preferences (clears always), `pong` to a
//! `ping`, and the answer to an action on a permission prompt.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use roamgate_base::log::Logger;
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::peer::Peer;
use roamgate_sidecar::protocol::{Ctx, Message};
use serde_json::{Map, Value, json};

use super::{fields, logger};

const MAX_EVENTS: usize = 200;
const MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES: usize = 4096;
/// A ping each interval; a client silent for the timeout is gone.
const FEED_PING_INTERVAL_MS: u64 = 25_000;
const FEED_SILENCE_TIMEOUT_MS: i64 = 70_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

struct Client {
    /// A number per socket, to follow one in the log.
    number: u64,
    origin: String,
    remote: Option<String>,
    connected_at: i64,
    /// None until its hello: nothing is sent before.
    client: Option<String>,
    completed: bool,
    blocked: bool,
    last_seen: i64,
}

impl Client {
    fn wants(&self, event: &Map<String, Value>) -> bool {
        if event.get("event").and_then(Value::as_str) != Some("notification") {
            return true;
        }
        match event.get("pref").and_then(Value::as_str) {
            Some("completed") => self.completed,
            Some("blocked") => self.blocked,
            _ => false,
        }
    }
}

#[derive(Default)]
struct State {
    /// The core's events, once read.
    loaded: bool,
    last: i64,
    events: Vec<Map<String, Value>>,
    /// The feed's sockets, by the front's socket number.
    clients: BTreeMap<u64, Client>,
    numbers: u64,
    heartbeat: Option<tokio::task::JoinHandle<()>>,
}

/// The feed's sockets.
pub(crate) struct Feed {
    peer: Peer,
    clock: SharedClock,
    log: Logger,
    cx: FamilyContext,
    state: Mutex<State>,
}

static FEED: OnceLock<Arc<Feed>> = OnceLock::new();

/// The feed of this core, once its front family registered.
pub(crate) fn current() -> Option<Arc<Feed>> {
    FEED.get().cloned()
}

/// Makes the feed (once) on the front family's link.
pub(crate) fn register(cx: &FamilyContext) -> Arc<Feed> {
    FEED.get_or_init(|| {
        Arc::new(Feed {
            peer: cx.peer.clone(),
            clock: cx.clock.clone(),
            log: logger(&cx.clock, "bridge.notifications"),
            cx: cx.clone(),
            state: Mutex::default(),
        })
    })
    .clone()
}

fn safe_integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number as i64)
}

/// What a socket is sent of an event: its URL on the socket's origin.
fn wire(event: &Map<String, Value>, origin: &str) -> String {
    let get = |key: &str| event.get(key).cloned().unwrap_or(Value::Null);
    if event.get("event").and_then(Value::as_str) == Some("notification_clear") {
        return json!({
            "event": get("event"),
            "id": get("id"),
            "at": get("at"),
            "tag": get("tag"),
        })
        .to_string();
    }
    let mut out = Map::new();
    for key in ["event", "id", "at", "kind", "title", "body", "tag", "group"] {
        out.insert(key.into(), get(key));
    }
    let path = event.get("path").and_then(Value::as_str).unwrap_or("");
    out.insert("url".into(), json!(format!("{origin}{path}")));
    if let Some(actions) = event.get("actions").filter(|actions| {
        actions
            .as_array()
            .is_some_and(|actions| !actions.is_empty())
    }) {
        out.insert("actions".into(), actions.clone());
    }
    Value::Object(out).to_string()
}

/// The core's events as the feed reads them (`parseSaved`): only those
/// that are valid.
fn parse_events(events: &Value) -> Vec<Map<String, Value>> {
    let string =
        |event: &Map<String, Value>, key: &str| event.get(key).is_some_and(Value::is_string);
    events
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|event| {
            let kind = event.get("event").and_then(Value::as_str);
            matches!(kind, Some("notification" | "notification_clear"))
                && safe_integer(event.get("id")).is_some()
                && event
                    .get("at")
                    .and_then(Value::as_f64)
                    .is_some_and(f64::is_finite)
                && string(event, "tag")
                && (kind == Some("notification_clear")
                    || (string(event, "title")
                        && string(event, "body")
                        && string(event, "path")
                        && string(event, "group")
                        && matches!(
                            event.get("pref").and_then(Value::as_str),
                            Some("completed" | "blocked")
                        )))
        })
        .cloned()
        .collect()
}

impl Feed {
    fn send(&self, socket_id: u64, text: String) {
        self.peer.send(&Message::WsSend {
            socket_id,
            data: text,
            binary: false,
            context: None,
            key: None,
        });
    }

    fn close(&self, socket_id: u64, code: u16, reason: &str) {
        self.peer.send(&Message::WsEnd {
            socket_id,
            code: Some(code),
            reason: Some(reason.to_owned()),
        });
    }

    /// Whether a socket is the feed's.
    pub(crate) fn owns(&self, socket_id: u64) -> bool {
        self.state.lock().unwrap().clients.contains_key(&socket_id)
    }

    /// An Android app holds the socket and answered within the timeout.
    pub(crate) fn android_connected(&self) -> bool {
        let state = self.state.lock().unwrap();
        self.android_in(&state)
    }

    fn android_in(&self, state: &State) -> bool {
        let fresh = self.clock.now() - FEED_SILENCE_TIMEOUT_MS;
        state
            .clients
            .values()
            .any(|client| client.client.as_deref() == Some("android") && client.last_seen >= fresh)
    }

    /// The sockets open now (`notifications.clients`).
    pub(crate) fn clients(&self) -> Value {
        let state = self.state.lock().unwrap();
        let now = self.clock.now();
        let clients: Vec<Value> = state
            .clients
            .values()
            .map(|client| {
                json!({
                    "socket": client.number,
                    "client": client.client,
                    "remote": client.remote,
                    "connected_at": client.connected_at,
                    "last_seen": client.last_seen,
                    "silent_ms": now - client.last_seen,
                    "preferences": {"completed": client.completed, "blocked": client.blocked},
                })
            })
            .collect();
        json!({"android_connected": self.android_in(&state), "clients": clients})
    }

    /// A socket opened, on the origin the client reached Roamgate on.
    pub(crate) fn open(self: &Arc<Self>, socket_id: u64, origin: String, remote: Option<String>) {
        let now = self.clock.now();
        let (number, count) = {
            let mut state = self.state.lock().unwrap();
            state.numbers += 1;
            let number = state.numbers;
            state.clients.insert(
                socket_id,
                Client {
                    number,
                    origin,
                    remote: remote.clone().filter(|remote| !remote.is_empty()),
                    connected_at: now,
                    client: None,
                    completed: false,
                    blocked: true,
                    last_seen: now,
                },
            );
            if state.heartbeat.is_none() {
                let feed = self.clone();
                state.heartbeat = Some(tokio::spawn(async move {
                    loop {
                        feed.clock
                            .sleep(Duration::from_millis(FEED_PING_INTERVAL_MS))
                            .await;
                        if !feed.heartbeat_tick() {
                            break;
                        }
                    }
                }));
            }
            (number, state.clients.len())
        };
        self.log.info(
            "notification client connected",
            Some(&fields(json!({
                "socket": number,
                "remote": remote.filter(|remote| !remote.is_empty()).unwrap_or_else(|| "unknown".into()),
                "clients": count,
            }))),
        );
    }

    /// The silent clients dropped, the others pinged: false once none is
    /// left (the heartbeat stops). The front's link answers a ping at
    /// once, as it did for Bun's feed behind it.
    fn heartbeat_tick(&self) -> bool {
        let silent = self.clock.now() - FEED_SILENCE_TIMEOUT_MS;
        let gone: Vec<u64> = {
            let state = self.state.lock().unwrap();
            state
                .clients
                .iter()
                .filter(|(_, client)| client.last_seen < silent)
                .map(|(socket, _)| *socket)
                .collect()
        };
        for socket in gone {
            self.drop_client(socket, Some(4000), "No heartbeat");
            self.close(socket, 4000, "No heartbeat");
        }
        let now = self.clock.now();
        let mut state = self.state.lock().unwrap();
        for client in state.clients.values_mut() {
            client.last_seen = now;
        }
        if state.clients.is_empty() {
            state.heartbeat = None;
            return false;
        }
        true
    }

    /// Forgets a socket's client, logging how long it lived.
    fn drop_client(&self, socket_id: u64, code: Option<u16>, reason: &str) {
        let (client, count) = {
            let mut state = self.state.lock().unwrap();
            let Some(client) = state.clients.remove(&socket_id) else {
                return;
            };
            if state.clients.is_empty()
                && let Some(heartbeat) = state.heartbeat.take()
            {
                heartbeat.abort();
            }
            (client, state.clients.len())
        };
        let mut log = Map::new();
        log.insert("socket".into(), json!(client.number));
        log.insert(
            "client".into(),
            json!(client.client.as_deref().unwrap_or("none")),
        );
        if let Some(code) = code {
            log.insert("code".into(), json!(code));
        }
        if !reason.is_empty() {
            log.insert("reason".into(), json!(reason));
        }
        log.insert(
            "lived_ms".into(),
            json!(self.clock.now() - client.connected_at),
        );
        log.insert("clients".into(), json!(count));
        self.log
            .info("notification client disconnected", Some(&log));
    }

    /// A socket closed.
    pub(crate) fn closed(&self, socket_id: u64, code: Option<u16>, reason: &str) {
        self.drop_client(socket_id, code, reason);
    }

    /// The core's events, read once.
    async fn load(&self) {
        if self.state.lock().unwrap().loaded {
            return;
        }
        let state = super::call(&self.cx, "internal.notifications.state", json!({})).await;
        if let Ok(saved) = state
            && let Some(last) = safe_integer(saved.get("last"))
        {
            let events = parse_events(&saved["events"]);
            let mut state = self.state.lock().unwrap();
            if !state.loaded {
                state.loaded = true;
                state.last = last;
                state.events = events;
            }
        }
    }

    /// The core's events after a change, and those of them to send to the
    /// sockets now, in order (`applyCore`).
    pub(crate) fn apply_core(&self, args: &Value) {
        let Some(last) = safe_integer(args.get("last")) else {
            return;
        };
        let events = parse_events(&args["events"]);
        let deliver: Vec<i64> = args["deliver"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_i64)
            .collect();
        let sends: Vec<Map<String, Value>> = {
            let mut state = self.state.lock().unwrap();
            state.loaded = true;
            state.last = last;
            state.events = events;
            deliver
                .iter()
                .filter_map(|id| {
                    state
                        .events
                        .iter()
                        .find(|event| event.get("id").and_then(Value::as_i64) == Some(*id))
                        .cloned()
                })
                .collect()
        };
        for event in sends {
            self.deliver(&event);
        }
    }

    fn deliver(&self, event: &Map<String, Value>) {
        let sends: Vec<(u64, String)> = {
            let state = self.state.lock().unwrap();
            state
                .clients
                .iter()
                .filter(|(_, client)| client.client.is_some() && client.wants(event))
                .map(|(socket, client)| (*socket, wire(event, &client.origin)))
                .collect()
        };
        let to = sends.len();
        for (socket, text) in sends {
            self.send(socket, text);
        }
        let mut log = Map::new();
        log.insert(
            "event".into(),
            event.get("event").cloned().unwrap_or(Value::Null),
        );
        log.insert("id".into(), event.get("id").cloned().unwrap_or(Value::Null));
        if event.get("event").and_then(Value::as_str) == Some("notification") {
            log.insert(
                "kind".into(),
                event.get("kind").cloned().unwrap_or(Value::Null),
            );
        }
        log.insert(
            "tag".into(),
            event.get("tag").cloned().unwrap_or(Value::Null),
        );
        log.insert("clients".into(), json!(to));
        self.log.debug("notification feed sent", Some(&log));
    }

    /// A message of a socket: its hello, a ping or an action.
    pub(crate) async fn message(&self, socket_id: u64, text: &str) {
        let known = {
            let mut state = self.state.lock().unwrap();
            let now = self.clock.now();
            match state.clients.get_mut(&socket_id) {
                Some(client) => {
                    client.last_seen = now;
                    Some(client.client.is_some())
                }
                None => None,
            }
        };
        let Some(said_hello) = known else {
            return;
        };
        if text.encode_utf16().count() > MAX_MESSAGE_BYTES {
            return;
        }
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        match message.get("op").and_then(Value::as_str) {
            Some("hello") => self.hello(socket_id, &message).await,
            Some("ping") => self.send(socket_id, json!({"event": "pong"}).to_string()),
            Some("action") if said_hello => self.action(socket_id, &message),
            _ => {}
        }
    }

    async fn hello(&self, socket_id: u64, message: &Map<String, Value>) {
        self.load().await;
        let since = safe_integer(message.get("since")).filter(|since| *since >= 0);
        let name = message
            .get("client")
            .and_then(Value::as_str)
            .filter(|client| !client.is_empty())
            .map(|client| roamgate_base::log::slice_utf16(client, 40).to_owned())
            .unwrap_or_else(|| "unknown".to_owned());
        let preferences = message
            .get("preferences")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        // Finished work only when the client asks for it: by default, only
        // what needs the user notifies.
        let completed = preferences.get("completed") == Some(&Value::Bool(true));
        let blocked = preferences.get("blocked") != Some(&Value::Bool(false));
        let now = self.clock.now();
        let (sends, number, last) = {
            let mut state = self.state.lock().unwrap();
            let oldest = now - MAX_AGE_MS;
            state.events.retain(|event| {
                event.get("at").and_then(Value::as_f64).unwrap_or(0.0) >= oldest as f64
            });
            if state.events.len() > MAX_EVENTS {
                let extra = state.events.len() - MAX_EVENTS;
                state.events.drain(..extra);
            }
            let last = state.last;
            let Some(client) = state.clients.get_mut(&socket_id) else {
                return;
            };
            client.client = Some(name.clone());
            client.completed = completed;
            client.blocked = blocked;
            let number = client.number;
            let origin = client.origin.clone();
            // No id (a new install): no history, only what comes next. An
            // id beyond the last means the server lost its feed: replay
            // all of it.
            let from = match since {
                None => Some(last),
                Some(since) if since <= last => Some(since),
                Some(_) => None,
            };
            let client = &state.clients[&socket_id];
            let sends: Vec<String> = state
                .events
                .iter()
                .filter(|event| match from {
                    Some(from) => event.get("id").and_then(Value::as_i64).unwrap_or(0) > from,
                    None => event.get("event").and_then(Value::as_str) == Some("notification"),
                })
                .filter(|event| client.wants(event))
                .map(|event| wire(event, &origin))
                .collect();
            (sends, number, last)
        };
        let replayed = sends.len();
        for text in sends {
            self.send(socket_id, text);
        }
        self.send(
            socket_id,
            json!({"event": "ready", "last": last}).to_string(),
        );
        self.log.info(
            "notification client hello",
            Some(&fields(json!({
                "socket": number,
                "client": name,
                "since": since.map_or(json!("none"), |since| json!(since)),
                "completed": completed,
                "blocked": blocked,
                "replayed": replayed,
                "last": last,
            }))),
        );
    }

    /// An action on a notification: the agent's permission prompt answered
    /// in the core's review service, without waiting.
    fn action(&self, socket_id: u64, message: &Map<String, Value>) {
        let id = message.get("id");
        let reply = |result: Value| {
            let mut out = json!({
                "event": "action",
                "id": safe_integer(id).map_or(Value::Null, |id| json!(id)),
            });
            if let (Some(out), Some(result)) = (out.as_object_mut(), result.as_object()) {
                out.extend(result.clone());
            }
            self.send(socket_id, out.to_string());
        };
        let event = {
            let state = self.state.lock().unwrap();
            state
                .events
                .iter()
                .find(|event| {
                    event.get("event").and_then(Value::as_str) == Some("notification")
                        && id.is_some_and(|id| {
                            event.get("id").and_then(Value::as_f64) == id.as_f64()
                        })
                })
                .cloned()
        };
        let chosen = event.as_ref().and_then(|event| {
            event
                .get("actions")?
                .as_array()?
                .iter()
                .filter_map(|each| each.get("id"))
                .find(|chosen| Some(*chosen) == message.get("action"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let (Some(event), Some(chosen)) = (event, chosen) else {
            return reply(json!({"error": "unknown"}));
        };
        let Some(prompt) = event.get("prompt").and_then(Value::as_object) else {
            return reply(json!({"error": "unknown"}));
        };
        super::tell(
            &self.cx,
            "internal.review.call",
            json!({
                "method": "prompts.answer",
                "params": {
                    "connectionId": prompt.get("connectionId"),
                    "id": prompt.get("promptId"),
                    "answer": chosen,
                },
            }),
        );
        reply(json!({"ok": true}));
        if let Some(tag) = event.get("tag").and_then(Value::as_str)
            && let Some(standalone) = &self.cx.standalone
        {
            let call = standalone.call(
                "internal.notifications.clear_tag",
                json!({"tag": tag}),
                Ctx::default(),
            );
            let log = self.log.clone();
            tokio::spawn(async move {
                if let Err(error) = call.await {
                    log.warn(
                        &format!(
                            "The Rust core did not take the notification feed's clear_tag: {}",
                            error.message
                        ),
                        None,
                    );
                }
            });
        }
    }
}
