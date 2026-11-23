//! Web Push (notifications/web-push.ts): the registry of enrolled devices
//! with the server's VAPID key pair (`<data>/web-push.json`, private), the
//! enrollment route `/api/notifications/push`, and delivery to the push
//! services (four at a time, at most 256 waiting, no redirects, 10 s).
//!
//! The registry is the Bun server's file as it is: an existing one is only
//! read (a corrupt one disables push instead of new keys), devices are
//! validated as Bun validates them, and a write keeps every other field.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_base::clock::SharedClock;
use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::json::js_value;
use roamgate_base::log::utf16_len;
use roamgate_base::paths::{DataContext, random_uuid};
use serde_json::{Map, Value, json};

use crate::crypto;
use crate::payload::notification_preference;

pub const MAX_DEVICES: usize = 128;
pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
pub const MAX_QUEUE: usize = 256;
pub const CONCURRENCY: usize = 4;
pub const PUSH_TTL_SECONDS: u32 = 300;
pub const SEND_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_SUBJECT: &str = "https://github.com/powerfooI/roamgate/issues";
pub const UNAVAILABLE_WARNING: &str = "Web Push unavailable: check the VAPID subject and private registry file; existing data was preserved.";

/// The VAPID subject: `ROAMGATE_WEB_PUSH_SUBJECT`, else the project's
/// contact; empty disables push.
pub fn web_push_subject(env: &dyn Env) -> String {
    roamgate_env(env, "WEB_PUSH_SUBJECT").unwrap_or_else(|| DEFAULT_SUBJECT.into())
}

/// `<data>/web-push.json`, or `ROAMGATE_WEB_PUSH_PATH`.
pub fn web_push_path(env: &dyn Env, root: &Path) -> PathBuf {
    roamgate_env(env, "WEB_PUSH_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("web-push.json"))
}

/// Only an `https:` URL or a `mailto:` address is a VAPID subject.
pub fn valid_push_subject(subject: &str) -> bool {
    match url::Url::parse(subject) {
        Ok(contact) => {
            contact.scheme() == "https"
                || (contact.scheme() == "mailto" && contact.path().contains('@'))
        }
        Err(_) => false,
    }
}

/// Only browser push providers are valid outbound destinations, never
/// arbitrary URLs: the endpoint as the URL parser writes it.
pub fn validate_push_endpoint(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if utf16_len(value) > 4096 {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str().unwrap_or("");
    let allowed = host == "fcm.googleapis.com"
        || host == "updates.push.services.mozilla.com"
        || host.ends_with(".push.services.mozilla.com")
        || host == "web.push.apple.com"
        || host.ends_with(".push.apple.com")
        || host.ends_with(".notify.windows.com");
    (allowed
        && url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none_or(str::is_empty))
    .then(|| url.to_string())
}

/// One enrolled device as `validatePushDevice` keeps it, or None.
pub fn validate_push_device(value: &Value) -> Option<Value> {
    let subscription = value.get("subscription").filter(|s| truthy(s))?;
    let preferences = value.get("preferences")?;
    let completed = preferences.get("completed")?.as_bool()?;
    let blocked = preferences.get("blocked")?.as_bool()?;
    let endpoint = validate_push_endpoint(subscription.get("endpoint"))?;
    let keys = subscription.get("keys");
    let p256dh = keys
        .and_then(|keys| keys.get("p256dh"))
        .and_then(Value::as_str)?;
    crypto::user_public_key(p256dh)?;
    let auth = keys
        .and_then(|keys| keys.get("auth"))
        .and_then(Value::as_str)?;
    crypto::key_bytes(auth, 16)?;
    let mut kept = json!({ "completed": completed, "blocked": blocked });
    if preferences.get("quietWithAndroidApp") == Some(&Value::Bool(true)) {
        kept["quietWithAndroidApp"] = Value::Bool(true);
    }
    Some(json!({
        "subscription": { "endpoint": endpoint, "keys": { "p256dh": p256dh, "auth": auth } },
        "preferences": kept,
    }))
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && value.as_str() != Some("")
        && value.as_f64() != Some(0.0)
}

/// An enrolled device: as kept, with a number of this process (a device
/// enrolled again is a new one, as Bun's object identity has it).
#[derive(Debug, Clone)]
pub struct Device {
    pub id: u64,
    pub value: Value,
}

impl Device {
    pub fn endpoint(&self) -> &str {
        self.value["subscription"]["endpoint"]
            .as_str()
            .unwrap_or("")
    }

    pub fn wants(&self, preference: &str) -> bool {
        self.value["preferences"][preference] == Value::Bool(true)
    }

    pub fn quiet_with_android_app(&self) -> bool {
        self.value["preferences"]["quietWithAndroidApp"] == Value::Bool(true)
    }
}

/// The registry: the file's fields (kept), its key pair and devices.
#[derive(Debug, Clone)]
pub struct Registry {
    pub fields: Map<String, Value>,
    pub public_key: String,
    pub private_key: Vec<u8>,
    pub devices: Vec<Device>,
}

impl Registry {
    /// The file's JSON with these devices.
    pub fn to_value(&self, devices: &[Device]) -> Value {
        let mut fields = self.fields.clone();
        fields.insert(
            "devices".into(),
            Value::Array(devices.iter().map(|device| device.value.clone()).collect()),
        );
        Value::Object(fields)
    }
}

/// Error texts of a registry that cannot be used.
#[derive(Debug, Clone, PartialEq)]
pub struct RegistryError(pub String);

/// Loads and fully validates an existing registry without creating or
/// changing it (`readPushRegistry`).
pub fn read_push_registry(
    context: &DataContext,
    path: &Path,
    ids: &mut dyn FnMut() -> u64,
) -> Result<Registry, RegistryError> {
    let fail = |message: &str| RegistryError(message.into());
    context
        .assert_safe_data_path(path)
        .map_err(|error| RegistryError(error.to_string()))?;
    let metadata = std::fs::metadata(path).map_err(|error| RegistryError(error.to_string()))?;
    if metadata.len() > MAX_REGISTRY_BYTES {
        return Err(fail("Push registry too large"));
    }
    let text = std::fs::read_to_string(path).map_err(|error| RegistryError(error.to_string()))?;
    let stored: Value =
        serde_json::from_str(&text).map_err(|error| RegistryError(error.to_string()))?;
    let stored = js_value(stored);
    let fields = stored
        .as_object()
        .ok_or_else(|| fail("Invalid push registry"))?
        .clone();
    let devices = fields.get("devices").and_then(Value::as_array);
    if fields.get("version").and_then(Value::as_f64) != Some(1.0)
        || devices.is_none_or(|devices| devices.len() > MAX_DEVICES)
    {
        return Err(fail("Invalid push registry"));
    }
    let private_key = fields
        .get("privateKey")
        .and_then(Value::as_str)
        .and_then(|key| crypto::key_bytes(key, 32))
        .ok_or_else(|| fail("Invalid push key"))?;
    let public_key = fields
        .get("publicKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if crypto::public_key_of(&private_key).as_deref() != Some(public_key) {
        return Err(fail("Invalid VAPID key pair"));
    }
    let devices = devices
        .into_iter()
        .flatten()
        .map(|device| {
            validate_push_device(device)
                .map(|value| Device { id: ids(), value })
                .ok_or_else(|| fail("Invalid push subscription"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Registry {
        public_key: public_key.into(),
        fields,
        private_key,
        devices,
    })
}

/// One push to a push service.
#[derive(Debug, Clone)]
pub struct PushRequest {
    pub endpoint: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// A push service's answer, or why there is none.
#[derive(Debug, Clone, PartialEq)]
pub enum SendError {
    /// It answered with a status that is not a success.
    Status(u16),
    /// No answer (network, timeout, redirect, encryption).
    Failed(String),
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

/// Sends a push request (the HTTPS client, or a test's).
pub trait PushSender: Send + Sync + 'static {
    fn send(&self, request: PushRequest) -> BoxFuture<Result<u16, SendError>>;
}

/// The request for one encrypted message (`generateRequestDetails`, TTL
/// 300 s and urgency high).
pub fn push_request(
    device: &Value,
    payload: &str,
    subject: &str,
    public_key: &str,
    private_key: &[u8],
    now_ms: i64,
) -> Result<PushRequest, SendError> {
    let endpoint = device["endpoint"].as_str().unwrap_or("").to_owned();
    let url = url::Url::parse(&endpoint).map_err(|error| SendError::Failed(error.to_string()))?;
    let audience = match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or("")),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or("")),
    };
    let body = crypto::encrypt(
        payload.as_bytes(),
        device["keys"]["p256dh"].as_str().unwrap_or(""),
        device["keys"]["auth"].as_str().unwrap_or(""),
    )
    .ok_or_else(|| SendError::Failed("cannot encrypt for the subscription".into()))?;
    let authorization =
        crypto::vapid_authorization(&audience, subject, public_key, private_key, now_ms)
            .ok_or_else(|| SendError::Failed("invalid VAPID key".into()))?;
    Ok(PushRequest {
        endpoint,
        headers: vec![
            ("TTL".into(), PUSH_TTL_SECONDS.to_string()),
            ("Content-Length".into(), body.len().to_string()),
            ("Content-Type".into(), "application/octet-stream".into()),
            ("Content-Encoding".into(), "aes128gcm".into()),
            ("Authorization".into(), authorization),
            ("Urgency".into(), "high".into()),
        ],
        body,
    })
}

/// The HTTPS client: no redirects, a 10 s deadline, the body dropped.
pub struct HttpsSender {
    client: reqwest::Client,
}

impl HttpsSender {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(SEND_TIMEOUT_MS))
            .build()
            .unwrap_or_default();
        Self { client }
    }
}

impl Default for HttpsSender {
    fn default() -> Self {
        Self::new()
    }
}

impl PushSender for HttpsSender {
    fn send(&self, request: PushRequest) -> BoxFuture<Result<u16, SendError>> {
        let client = self.client.clone();
        Box::pin(async move {
            let mut builder = client.post(&request.endpoint).body(request.body);
            for (name, value) in &request.headers {
                if name != "Content-Length" {
                    builder = builder.header(name, value);
                }
            }
            let response = builder
                .send()
                .await
                .map_err(|error| SendError::Failed(error.to_string()))?;
            let status = response.status().as_u16();
            // A redirect is an error, as fetch's `redirect: "error"`.
            if response.status().is_redirection() {
                return Err(SendError::Failed("redirect".into()));
            }
            drop(response);
            if (200..300).contains(&status) {
                Ok(status)
            } else {
                Err(SendError::Status(status))
            }
        })
    }
}

/// Whether what a queued notification is about is still current (asked
/// before each send).
pub type IsCurrent = Arc<dyn Fn() -> BoxFuture<bool> + Send + Sync>;

struct Queued {
    device: u64,
    preference: &'static str,
    payload: String,
    is_current: Option<IsCurrent>,
}

struct State {
    registry: Option<Registry>,
    queue: VecDeque<Queued>,
    active: usize,
    stopped: bool,
    next_id: u64,
}

/// An HTTP answer of the enrollment route.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Json(u16, Value),
    Text(u16, &'static str),
}

/// Web Push: the registry and the delivery queue.
pub struct WebPush {
    context: DataContext,
    path: PathBuf,
    subject: String,
    clock: SharedClock,
    sender: Arc<dyn PushSender>,
    warn: Arc<dyn Fn(&str) + Send + Sync>,
    state: Mutex<State>,
}

impl WebPush {
    /// Reads the registry (making one with new keys only when there is
    /// none); push stays off with a warning when the subject or the file is
    /// not usable.
    pub fn open(
        context: DataContext,
        path: PathBuf,
        subject: String,
        clock: SharedClock,
        sender: Arc<dyn PushSender>,
        warn: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        let mut next_id = 0;
        let registry = if subject.is_empty() {
            None
        } else {
            let mut ids = || {
                next_id += 1;
                next_id
            };
            match Self::load(&context, &path, &subject, &mut ids) {
                Ok(registry) => Some(registry),
                Err(_) => {
                    warn(UNAVAILABLE_WARNING);
                    None
                }
            }
        };
        Arc::new(Self {
            context,
            path,
            subject,
            clock,
            sender,
            warn,
            state: Mutex::new(State {
                registry,
                queue: VecDeque::new(),
                active: 0,
                stopped: false,
                next_id,
            }),
        })
    }

    fn load(
        context: &DataContext,
        path: &Path,
        subject: &str,
        ids: &mut dyn FnMut() -> u64,
    ) -> Result<Registry, RegistryError> {
        if !valid_push_subject(subject) {
            return Err(RegistryError("Invalid VAPID subject".into()));
        }
        context
            .assert_safe_data_path(path)
            .map_err(|error| RegistryError(error.to_string()))?;
        if !path.exists() {
            let (public_key, private_key) = crypto::generate_vapid_keys();
            let text = serde_json::to_string(&json!({
                "version": 1,
                "publicKey": public_key,
                "privateKey": private_key,
                "devices": [],
            }))
            .unwrap_or_default();
            context
                .publish_data_file(path, text.as_bytes(), 0o600)
                .map_err(|error| RegistryError(error.to_string()))?;
        }
        let registry = read_push_registry(context, path, ids)?;
        roamgate_base::private::set_mode(path, 0o600)
            .map_err(|error| RegistryError(error.to_string()))?;
        Ok(registry)
    }

    pub fn available(&self) -> bool {
        self.state.lock().unwrap().registry.is_some()
    }

    /// The registry now (tests and the data checks).
    pub fn registry(&self) -> Option<Registry> {
        self.state.lock().unwrap().registry.clone()
    }

    fn save(&self, state: &mut State, devices: Vec<Device>) -> Result<(), String> {
        let Some(registry) = &state.registry else {
            return Err("no registry".into());
        };
        self.context
            .assert_safe_data_path(&self.path)
            .map_err(|error| error.to_string())?;
        let directory = self.path.parent().unwrap_or(Path::new("."));
        let temporary = directory.join(format!(".web-push-{}.tmp", random_uuid()));
        let mut text = serde_json::to_string(&registry.to_value(&devices)).unwrap_or_default();
        text.push('\n');
        let result = (|| -> Result<(), String> {
            self.context
                .publish_data_file(&temporary, text.as_bytes(), 0o600)
                .map_err(|error| error.to_string())?;
            self.context
                .assert_safe_data_path(&self.path)
                .map_err(|error| error.to_string())?;
            std::fs::rename(&temporary, &self.path).map_err(|error| error.to_string())
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
        if let Some(registry) = &mut state.registry {
            registry.devices = devices;
        }
        Ok(())
    }

    /// `GET`, `POST` and `DELETE /api/notifications/push`: `header` reads a
    /// request header (lowercase names), `body` the request body.
    pub fn handle(
        &self,
        method: &str,
        header: &dyn Fn(&str) -> Option<String>,
        body: Option<&[u8]>,
    ) -> Answer {
        let mut state = self.state.lock().unwrap();
        if method == "GET" {
            let key = state
                .registry
                .as_ref()
                .map(|registry| registry.public_key.clone());
            return Answer::Json(200, json!({ "available": key.is_some(), "publicKey": key }));
        }
        if method != "POST" && method != "DELETE" {
            return Answer::Text(405, "Method not allowed");
        }
        // A custom header and JSON require a same-origin request (no CORS
        // grant).
        let content_type = header("content-type");
        if header("x-roamgate-push").as_deref() != Some("1")
            || header("sec-fetch-site").as_deref() == Some("cross-site")
            || content_type
                .as_deref()
                .map(|value| value.split(';').next().unwrap_or(""))
                != Some("application/json")
        {
            return Answer::Text(403, "Forbidden");
        }
        let Some(registry) = state.registry.as_ref() else {
            return Answer::Json(
                503,
                json!({ "error": "Web Push is unavailable on this server" }),
            );
        };
        let input = match body {
            Some(bytes) if bytes.len() <= MAX_BODY_BYTES => {
                serde_json::from_slice::<Value>(bytes).ok()
            }
            _ => None,
        };
        let Some(input) = input else {
            return Answer::Json(400, json!({ "error": "Invalid push request" }));
        };
        let (device, endpoint) = if method == "POST" {
            match validate_push_device(&input) {
                Some(device) => {
                    let endpoint = device["subscription"]["endpoint"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                    (Some(device), endpoint)
                }
                None => return invalid_subscription(),
            }
        } else {
            match validate_push_endpoint(input.get("endpoint")) {
                Some(endpoint) => (None, endpoint),
                None => return invalid_subscription(),
            }
        };
        let mut devices: Vec<Device> = registry
            .devices
            .iter()
            .filter(|entry| entry.endpoint() != endpoint)
            .cloned()
            .collect();
        if let Some(value) = device {
            state.next_id += 1;
            devices.push(Device {
                id: state.next_id,
                value,
            });
        }
        if devices.len() > MAX_DEVICES {
            return Answer::Json(409, json!({ "error": "Push device limit reached" }));
        }
        if self.save(&mut state, devices).is_err() {
            return Answer::Json(500, json!({ "error": "Unable to save push subscription" }));
        }
        Answer::Json(200, json!({ "ok": true }))
    }

    /// Queues one notification for every device that wants it; `skip`
    /// leaves out the quiet devices while the Android app is connected.
    pub fn notify(
        self: &Arc<Self>,
        task: &Map<String, Value>,
        payload: &Map<String, Value>,
        android_connected: bool,
        is_current: Option<IsCurrent>,
    ) {
        let preference = notification_preference(task);
        let text = serde_json::to_string(payload).unwrap_or_default();
        {
            let mut state = self.state.lock().unwrap();
            if state.stopped {
                return;
            }
            let Some(registry) = &state.registry else {
                return;
            };
            let wanted: Vec<u64> = registry
                .devices
                .iter()
                .filter(|device| device.wants(preference))
                .filter(|device| !(device.quiet_with_android_app() && android_connected))
                .map(|device| device.id)
                .collect();
            for device in wanted {
                if state.queue.len() >= MAX_QUEUE {
                    (self.warn)("Web Push queue is full; notification dropped.");
                    break;
                }
                state.queue.push_back(Queued {
                    device,
                    preference,
                    payload: text.clone(),
                    is_current: is_current.clone(),
                });
            }
        }
        self.drain();
    }

    fn drain(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        while !state.stopped && state.active < CONCURRENCY {
            let Some(item) = state.queue.pop_front() else {
                break;
            };
            state.active += 1;
            let me = self.clone();
            tokio::spawn(async move {
                me.deliver(item).await;
                me.state.lock().unwrap().active -= 1;
                me.drain();
            });
        }
    }

    async fn deliver(&self, item: Queued) {
        let device = {
            let state = self.state.lock().unwrap();
            if state.stopped {
                return;
            }
            let Some(registry) = &state.registry else {
                return;
            };
            match registry
                .devices
                .iter()
                .find(|device| device.id == item.device)
            {
                Some(device) => (
                    device.clone(),
                    registry.public_key.clone(),
                    registry.private_key.clone(),
                ),
                None => return,
            }
        };
        if let Some(is_current) = &item.is_current
            && !is_current().await
        {
            return;
        }
        let (device, public_key, private_key) = device;
        if !device.wants(item.preference) {
            return;
        }
        let request = push_request(
            &device.value["subscription"],
            &item.payload,
            &self.subject,
            &public_key,
            &private_key,
            self.clock.now(),
        );
        let result = match request {
            Ok(request) => self.sender.send(request).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(_) => {}
            Err(SendError::Status(404 | 410)) => {
                let mut state = self.state.lock().unwrap();
                let Some(registry) = &state.registry else {
                    return;
                };
                if !registry.devices.iter().any(|each| each.id == device.id) {
                    return;
                }
                let devices = registry
                    .devices
                    .iter()
                    .filter(|each| each.id != device.id)
                    .cloned()
                    .collect();
                if self.save(&mut state, devices).is_err() {
                    (self.warn)("Unable to persist expired Web Push subscription removal.");
                }
            }
            Err(_) => (self.warn)(
                "Web Push delivery failed; check outbound connectivity and VAPID configuration.",
            ),
        }
    }

    /// Stops delivering: what is queued is dropped.
    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopped = true;
        state.queue.clear();
    }

    /// Deliveries waiting or under way (tests).
    pub fn pending(&self) -> usize {
        let state = self.state.lock().unwrap();
        state.queue.len() + state.active
    }
}

fn invalid_subscription() -> Answer {
    Answer::Json(
        400,
        json!({ "error": "Invalid push subscription or preferences" }),
    )
}

#[cfg(test)]
mod tests;
