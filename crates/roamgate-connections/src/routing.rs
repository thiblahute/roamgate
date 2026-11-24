//! Which connection a browser request is for (connections/protocol.ts,
//! rpc-routing.ts and http-routing.ts): connection ids and generations
//! validated, a request resolved to a ready runtime's lease (never another
//! connection's), the connection envelope of replies and Herdr events, the
//! connection-scoped HTTP routes and their legacy aliases, and the warnings
//! about unscoped clients.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

use crate::manager::{ConnectionManager, ConnectionRuntime, sanitize_connection_error};

const CONNECTION_ID_MAX_LENGTH: usize = 128;

/// The error of a request whose connection was replaced or disposed while
/// it ran.
pub const CONNECTION_CHANGED_DURING_REQUEST: &str = "connection changed during request";

/// A request that names no usable connection (ConnectionRoutingError):
/// its message, its HTTP status, and the connection it named when that
/// was valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingError {
    pub message: String,
    pub status: u16,
    pub connection_id: Option<String>,
    pub connection_generation: Option<u64>,
}

impl RoutingError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
            connection_id: None,
            connection_generation: None,
        }
    }

    fn on(mut self, connection_id: &str, generation: Option<u64>) -> Self {
        self.connection_id = Some(connection_id.to_owned());
        self.connection_generation = generation;
        self
    }
}

impl std::fmt::Display for RoutingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]*$`, at most 128 characters.
pub fn is_valid_connection_id(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= CONNECTION_ID_MAX_LENGTH
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// A connection id as a request gives it.
pub fn validate_connection_id(value: &Value) -> Result<String, RoutingError> {
    match value.as_str() {
        Some(id) if is_valid_connection_id(id) => Ok(id.to_owned()),
        _ => Err(RoutingError::new("invalid connection_id", 400)),
    }
}

/// A connection generation as a request gives it: a safe non-negative
/// integer (`3.0` is one, as in JavaScript).
pub fn validate_connection_generation(value: &Value) -> Result<u64, RoutingError> {
    const MAX_SAFE: u64 = (1 << 53) - 1;
    let invalid = || RoutingError::new("invalid connection_generation", 400);
    if let Some(number) = value.as_u64() {
        return (number <= MAX_SAFE).then_some(number).ok_or_else(invalid);
    }
    match value.as_f64() {
        Some(number) if number >= 0.0 && number.fract() == 0.0 && number <= MAX_SAFE as f64 => {
            Ok(number as u64)
        }
        _ => Err(invalid()),
    }
}

/// `bridge.*` and `connections.*` are the server's, never a connection's.
pub fn is_bridge_global_method(method: &str) -> bool {
    method.starts_with("bridge.") || method.starts_with("connections.")
}

/// A ready runtime handed out for one request.
#[derive(Clone)]
pub struct Lease {
    pub connection_id: String,
    pub generation: u64,
    is_current: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl Lease {
    pub fn new(
        connection_id: &str,
        generation: u64,
        is_current: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self {
            connection_id: connection_id.to_owned(),
            generation,
            is_current,
        }
    }

    /// Whether the runtime is still the connection's current one.
    pub fn is_current(&self) -> bool {
        (self.is_current)()
    }
}

/// What routing asks of the connections (ReadyConnectionRegistry).
pub trait ReadyConnections: Send + Sync {
    fn default_id(&self) -> String;
    fn has(&self, connection_id: &str) -> bool;
    fn ready_lease(&self, connection_id: &str) -> Option<Lease>;
}

impl<R: ConnectionRuntime> ReadyConnections for ConnectionManager<R> {
    fn default_id(&self) -> String {
        ConnectionManager::default_id(self)
    }

    fn has(&self, connection_id: &str) -> bool {
        ConnectionManager::has(self, connection_id)
    }

    fn ready_lease(&self, connection_id: &str) -> Option<Lease> {
        let lease = self.ready_runtime_lease(connection_id).ok().flatten()?;
        let check = lease.clone();
        Some(Lease::new(
            connection_id,
            lease.generation,
            Arc::new(move || check.is_current()),
        ))
    }
}

/// A request resolved to its connection.
#[derive(Clone)]
pub struct Resolved {
    pub lease: Lease,
    /// The request named no connection: the default one serves it.
    pub used_legacy_default: bool,
}

/// resolveReadyConnection: the named connection (or, when the request
/// names none, the default one), ready, at the generation it expects.
pub fn resolve_ready_connection(
    registry: &dyn ReadyConnections,
    requested: Option<&Value>,
    requested_generation: Option<&Value>,
) -> Result<Resolved, RoutingError> {
    let used_legacy_default = requested.is_none();
    let connection_id = match requested {
        None => validate_connection_id(&Value::String(registry.default_id()))?,
        Some(value) => validate_connection_id(value)?,
    };
    let expected = match requested_generation {
        None => None,
        Some(value) => Some(
            validate_connection_generation(value)
                .map_err(|error| error.on(&connection_id, None))?,
        ),
    };
    if !registry.has(&connection_id) {
        return Err(
            RoutingError::new(format!("unknown connection: {connection_id}"), 404)
                .on(&connection_id, expected),
        );
    }
    let Some(lease) = registry.ready_lease(&connection_id) else {
        return Err(
            RoutingError::new(format!("connection is not ready: {connection_id}"), 503)
                .on(&connection_id, expected),
        );
    };
    if expected.is_some_and(|generation| generation != lease.generation) {
        return Err(RoutingError::new(
            format!("connection generation changed: {connection_id}"),
            409,
        )
        .on(&connection_id, expected));
    }
    Ok(Resolved {
        lease,
        used_legacy_default,
    })
}

/// serializeConnectionEnvelope: `{connection_id, connection_generation?,
/// ...message}`; a message may not carry those two fields itself.
pub fn serialize_connection_envelope(
    connection_id: &str,
    message: &Map<String, Value>,
    connection_generation: Option<u64>,
) -> Result<String, String> {
    if !is_valid_connection_id(connection_id) {
        return Err("invalid connection_id".into());
    }
    for reserved in ["connection_id", "connection_generation"] {
        if message.contains_key(reserved) {
            return Err(format!(
                "connection envelope payload contains reserved {reserved}"
            ));
        }
    }
    let mut out = Map::new();
    out.insert("connection_id".into(), connection_id.into());
    if let Some(generation) = connection_generation {
        out.insert("connection_generation".into(), generation.into());
    }
    for (key, value) in message {
        out.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(out).to_string())
}

const HERDR_EVENT_RESERVED_FIELDS: [&str; 10] = [
    "connection_id",
    "connection_generation",
    "hello",
    "id",
    "result",
    "error",
    "control",
    "terminal",
    "terminal_clipboard",
    "assistant",
];

/// serializeHerdrEventEnvelope: a Herdr event (`{event: string, ...}`) in
/// its connection's envelope; one that could pass for a reply or a
/// control message is refused.
pub fn serialize_herdr_event_envelope(
    connection_id: &str,
    event: &Value,
    connection_generation: Option<u64>,
) -> Result<String, String> {
    let Some(object) = event
        .as_object()
        .filter(|object| object.get("event").is_some_and(Value::is_string))
    else {
        return Err("invalid Herdr event envelope".into());
    };
    if let Some(field) = HERDR_EVENT_RESERVED_FIELDS
        .iter()
        .find(|field| object.contains_key(**field))
    {
        return Err(format!("Herdr event contains reserved {field}"));
    }
    serialize_connection_envelope(connection_id, object, connection_generation)
}

const SILENT_LEGACY_RPC_METHODS: [&str; 4] = [
    "terminal.input",
    "terminal.resize",
    "terminal.relay_resize",
    "terminal.scroll",
];

fn safe_method(method: &str) -> String {
    let cleaned: String = sanitize_connection_error(method)
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) {
                '?'
            } else {
                c
            }
        })
        .collect();
    roamgate_base::log::slice_utf16(&cleaned, 120).to_owned()
}

/// createLegacyRoutingLogger: one warning per client (or per endpoint)
/// that leaves out its connection or its generation.
pub struct LegacyRoutingLogger {
    log: Box<dyn Fn(&str) + Send + Sync>,
    seen: Mutex<LegacySeen>,
}

#[derive(Default)]
struct LegacySeen {
    rpc_clients: HashSet<u64>,
    rpc_generation_clients: HashSet<u64>,
    http_endpoints: HashSet<String>,
    http_generation_endpoints: HashSet<String>,
}

impl LegacyRoutingLogger {
    pub fn new(log: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self {
            log: Box::new(log),
            seen: Mutex::default(),
        }
    }

    pub fn rpc(&self, client: u64, method: &str, connection_id: &str) {
        if SILENT_LEGACY_RPC_METHODS.contains(&method)
            || !self.seen.lock().unwrap().rpc_clients.insert(client)
        {
            return;
        }
        (self.log)(&format!(
            "[bridge] deprecated unscoped RPC client routed to default connection={connection_id} method={}",
            safe_method(method)
        ));
    }

    pub fn rpc_generation(&self, client: u64, method: &str, connection_id: &str) {
        if SILENT_LEGACY_RPC_METHODS.contains(&method)
            || !self
                .seen
                .lock()
                .unwrap()
                .rpc_generation_clients
                .insert(client)
        {
            return;
        }
        (self.log)(&format!(
            "[bridge] deprecated generation-unscoped RPC routed to current connection={connection_id} method={}",
            safe_method(method)
        ));
    }

    pub fn http(&self, endpoint: &str, connection_id: &str) {
        if !self
            .seen
            .lock()
            .unwrap()
            .http_endpoints
            .insert(endpoint.to_owned())
        {
            return;
        }
        (self.log)(&format!(
            "[bridge] deprecated unscoped HTTP route routed to default connection={connection_id} endpoint={endpoint}"
        ));
    }

    pub fn http_generation(&self, endpoint: &str, connection_id: &str) {
        if !self
            .seen
            .lock()
            .unwrap()
            .http_generation_endpoints
            .insert(endpoint.to_owned())
        {
            return;
        }
        (self.log)(&format!(
            "[bridge] deprecated generation-unscoped HTTP routed to current connection={connection_id} endpoint={endpoint}"
        ));
    }
}

/// Where a browser RPC goes (resolveRpcRoute).
#[derive(Clone)]
pub enum RpcRoute {
    /// A `bridge.*` or `connections.*` method: the server's.
    Bridge,
    Connection(Resolved),
}

/// Why an RPC has no route: a routing error, or a bridge-global method
/// that names a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    Routing(RoutingError),
    Other(String),
}

impl RouteError {
    pub fn message(&self) -> &str {
        match self {
            Self::Routing(error) => &error.message,
            Self::Other(message) => message,
        }
    }
}

/// resolveRpcRoute: `request` is the browser's envelope; `client` names
/// its socket for the legacy warnings.
pub fn resolve_rpc_route(
    request: &Map<String, Value>,
    method: &str,
    registry: &dyn ReadyConnections,
    client: u64,
    legacy: Option<&LegacyRoutingLogger>,
) -> Result<RpcRoute, RouteError> {
    if is_bridge_global_method(method) {
        if request.contains_key("connection_id") || request.contains_key("connection_generation") {
            return Err(RouteError::Other(
                "bridge-global method must not include connection identity".into(),
            ));
        }
        return Ok(RpcRoute::Bridge);
    }
    let resolved = resolve_ready_connection(
        registry,
        request.get("connection_id"),
        request.get("connection_generation"),
    )
    .map_err(RouteError::Routing)?;
    if let Some(legacy) = legacy {
        if !request.contains_key("connection_id") {
            legacy.rpc(client, method, &resolved.lease.connection_id);
        }
        if !request.contains_key("connection_generation") {
            legacy.rpc_generation(client, method, &resolved.lease.connection_id);
        }
    }
    Ok(RpcRoute::Connection(resolved))
}

/// A connection-scoped HTTP route (ConnectionHttpEndpoint).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpEndpoint {
    HerdrInfo,
    UploadImage,
    TerminalUpload,
    AgentSessionDownload,
    AgentSessionAtif,
    FileDownload,
    FileUpload,
    FileDelete,
}

impl HttpEndpoint {
    /// Every endpoint: its name, suffix, method and legacy path.
    const ALL: [(Self, &'static str, &'static str, &'static str, &'static str); 8] = [
        (
            Self::HerdrInfo,
            "herdr-info",
            "/herdr-info",
            "GET",
            "/api/herdr-info",
        ),
        (
            Self::UploadImage,
            "upload-image",
            "/upload-image",
            "POST",
            "/api/upload-image",
        ),
        (
            Self::TerminalUpload,
            "terminal-upload",
            "/terminal-upload",
            "POST",
            "/api/terminal-upload",
        ),
        (
            Self::AgentSessionDownload,
            "agent-session-download",
            "/agent-session/download",
            "GET",
            "/api/agent-session/download",
        ),
        (
            Self::AgentSessionAtif,
            "agent-session-atif",
            "/agent-session/atif",
            "GET",
            "/api/agent-session/atif",
        ),
        (
            Self::FileDownload,
            "file-download",
            "/file/download",
            "GET",
            "/api/file/download",
        ),
        (
            Self::FileUpload,
            "file-upload",
            "/file/upload",
            "POST",
            "/api/file/upload",
        ),
        (
            Self::FileDelete,
            "file-delete",
            "/file/delete",
            "POST",
            "/api/file/delete",
        ),
    ];

    fn entry(self) -> (Self, &'static str, &'static str, &'static str, &'static str) {
        *Self::ALL
            .iter()
            .find(|entry| entry.0 == self)
            .expect("every endpoint is listed")
    }

    /// Its name (`herdr-info`, `file-download`...).
    pub fn name(self) -> &'static str {
        self.entry().1
    }

    /// Its legacy path (`/api/herdr-info`...).
    pub fn legacy_path(self) -> &'static str {
        self.entry().4
    }
}

/// A parsed connection-scoped HTTP route (ParsedConnectionHttpRoute's
/// `connection` kind).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionHttpRoute {
    pub endpoint: HttpEndpoint,
    /// None for a legacy path: the default connection.
    pub requested_connection_id: Option<String>,
    pub legacy: bool,
}

/// rawRequestPathname: a URL's path as sent, before any dot-segment
/// normalization.
pub fn raw_request_pathname(url: &str) -> &str {
    let path_start = match url.find("://") {
        Some(separator) => match url[separator + 3..].find('/') {
            Some(index) => separator + 3 + index,
            None => return "/",
        },
        None if url.starts_with('/') => 0,
        None => return "/",
    };
    let rest = &url[path_start..];
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// decodeURIComponent, or None for a malformed escape or invalid UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// parseConnectionHttpRoute: None for a path that is no connection route.
pub fn parse_connection_http_route(
    pathname: &str,
    method: &str,
) -> Option<Result<ConnectionHttpRoute, RoutingError>> {
    if let Some(entry) = HttpEndpoint::ALL.iter().find(|entry| entry.4 == pathname) {
        if method != entry.3 {
            return Some(Err(RoutingError::new(
                format!("method not allowed for {pathname}"),
                405,
            )));
        }
        return Some(Ok(ConnectionHttpRoute {
            endpoint: entry.0,
            requested_connection_id: None,
            legacy: true,
        }));
    }
    let remainder = pathname.strip_prefix("/api/connections/")?;
    let separator = match remainder.find('/') {
        Some(index) if index > 0 => index,
        _ => {
            return Some(Err(RoutingError::new("invalid connection route", 400)));
        }
    };
    let (encoded, suffix) = remainder.split_at(separator);
    let connection_id = match decode_uri_component(encoded) {
        None => {
            return Some(Err(RoutingError::new(
                "invalid connection_id encoding",
                400,
            )));
        }
        Some(decoded) => match validate_connection_id(&Value::String(decoded)) {
            Ok(id) => id,
            Err(error) => return Some(Err(error)),
        },
    };
    let Some(entry) = HttpEndpoint::ALL.iter().find(|entry| entry.2 == suffix) else {
        return Some(Err(
            RoutingError::new("unknown connection endpoint", 404).on(&connection_id, None)
        ));
    };
    if method != entry.3 {
        return Some(Err(RoutingError::new(
            "method not allowed for connection endpoint",
            405,
        )
        .on(&connection_id, None)));
    }
    Some(Ok(ConnectionHttpRoute {
        endpoint: entry.0,
        requested_connection_id: Some(connection_id),
        legacy: false,
    }))
}

/// The `connection_generation` query parameter as a route gives it: a
/// decimal integer, or the text itself (refused as invalid by the
/// resolution).
pub fn requested_http_generation(text: Option<&str>) -> Option<Value> {
    let text = text?;
    let decimal = text == "0"
        || (text.starts_with(|c: char| ('1'..='9').contains(&c))
            && text.chars().all(|c| c.is_ascii_digit()));
    Some(match text.parse::<u64>() {
        Ok(number) if decimal => Value::from(number),
        _ => Value::String(text.to_owned()),
    })
}

/// resolveConnectionHttpRoute.
pub fn resolve_connection_http_route(
    route: &ConnectionHttpRoute,
    requested_generation: Option<&Value>,
    registry: &dyn ReadyConnections,
    legacy: Option<&LegacyRoutingLogger>,
) -> Result<Resolved, RoutingError> {
    if let Some(legacy) = legacy {
        if route.legacy {
            legacy.http(route.endpoint.name(), &registry.default_id());
        }
        if requested_generation.is_none() {
            let connection_id = route
                .requested_connection_id
                .clone()
                .unwrap_or_else(|| registry.default_id());
            legacy.http_generation(route.endpoint.name(), &connection_id);
        }
    }
    let requested = route.requested_connection_id.clone().map(Value::String);
    resolve_ready_connection(registry, requested.as_ref(), requested_generation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    struct Registry {
        default: String,
        entries: BTreeMap<String, Option<u64>>,
    }

    impl ReadyConnections for Registry {
        fn default_id(&self) -> String {
            self.default.clone()
        }
        fn has(&self, connection_id: &str) -> bool {
            self.entries.contains_key(connection_id)
        }
        fn ready_lease(&self, connection_id: &str) -> Option<Lease> {
            let generation = (*self.entries.get(connection_id)?)?;
            Some(Lease::new(connection_id, generation, Arc::new(|| true)))
        }
    }

    fn registry() -> Registry {
        Registry {
            default: "a".into(),
            entries: BTreeMap::from([("a".into(), Some(1)), ("down".into(), None)]),
        }
    }

    fn request(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn ids_and_generations_are_validated_as_bun_does() {
        assert!(is_valid_connection_id("remote-dev:2.x_y"));
        for bad in ["", "-a", "a/b", "a b", &"x".repeat(129)] {
            assert!(!is_valid_connection_id(bad), "{bad}");
        }
        assert_eq!(validate_connection_generation(&json!(3)), Ok(3));
        assert_eq!(validate_connection_generation(&json!(3.0)), Ok(3));
        for bad in [
            json!(-1),
            json!(1.5),
            json!("1"),
            json!(9007199254740992u64),
        ] {
            assert!(validate_connection_generation(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rpcs_route_to_the_named_ready_connection_or_the_default_one() {
        let registry = registry();
        let warnings: Arc<Mutex<Vec<String>>> = Arc::default();
        let into = warnings.clone();
        let legacy = LegacyRoutingLogger::new(move |line| into.lock().unwrap().push(line.into()));
        let route = |value, client| {
            let request = request(value);
            let method = request["method"].as_str().unwrap().to_owned();
            resolve_rpc_route(&request, &method, &registry, client, Some(&legacy))
        };
        assert!(matches!(
            route(json!({"method": "bridge.ping"}), 1),
            Ok(RpcRoute::Bridge)
        ));
        assert_eq!(
            route(json!({"method": "bridge.ping", "connection_id": "a"}), 1)
                .err()
                .unwrap()
                .message(),
            "bridge-global method must not include connection identity"
        );
        let Ok(RpcRoute::Connection(resolved)) = route(json!({"method": "pane.list"}), 1) else {
            panic!("routed");
        };
        assert!(resolved.used_legacy_default);
        assert_eq!(resolved.lease.connection_id, "a");
        let _ = route(json!({"method": "pane.list"}), 1);
        let _ = route(json!({"method": "terminal.input"}), 2);
        assert_eq!(warnings.lock().unwrap().len(), 2, "one per client");
        let error = |value| match route(value, 3) {
            Err(RouteError::Routing(error)) => error,
            _ => panic!("refused"),
        };
        let unknown = error(json!({"method": "pane.list", "connection_id": "b"}));
        assert_eq!(
            (unknown.message.as_str(), unknown.status),
            ("unknown connection: b", 404)
        );
        assert_eq!(
            error(json!({"method": "pane.list", "connection_id": "down"})).status,
            503
        );
        let stale = error(json!({"method": "x", "connection_id": "a", "connection_generation": 2}));
        assert_eq!((stale.status, stale.connection_generation), (409, Some(2)));
        let invalid =
            error(json!({"method": "x", "connection_id": "a", "connection_generation": "2"}));
        assert_eq!(
            (invalid.message.as_str(), invalid.connection_id.as_deref()),
            ("invalid connection_generation", Some("a"))
        );
    }

    #[test]
    fn envelopes_protect_their_fields() {
        let message = request(json!({"id": "1", "result": true}));
        assert_eq!(
            serialize_connection_envelope("a", &message, Some(4)).unwrap(),
            r#"{"connection_id":"a","connection_generation":4,"id":"1","result":true}"#
        );
        assert!(
            serialize_connection_envelope("a", &request(json!({"connection_id": "b"})), None)
                .is_err()
        );
        assert_eq!(
            serialize_herdr_event_envelope("a", &json!({"event": "pane.closed", "data": {}}), None)
                .unwrap(),
            r#"{"connection_id":"a","event":"pane.closed","data":{}}"#
        );
        assert!(serialize_herdr_event_envelope("a", &json!({"event": 1}), None).is_err());
        assert!(
            serialize_herdr_event_envelope("a", &json!({"event": "x", "result": 1}), None).is_err()
        );
    }

    #[test]
    fn http_routes_parse_their_connection_and_endpoint() {
        assert_eq!(
            parse_connection_http_route("/api/herdr-info", "GET"),
            Some(Ok(ConnectionHttpRoute {
                endpoint: HttpEndpoint::HerdrInfo,
                requested_connection_id: None,
                legacy: true
            }))
        );
        assert_eq!(
            parse_connection_http_route("/api/connections/re%6Dote/file/download", "GET"),
            Some(Ok(ConnectionHttpRoute {
                endpoint: HttpEndpoint::FileDownload,
                requested_connection_id: Some("remote".into()),
                legacy: false
            }))
        );
        assert_eq!(parse_connection_http_route("/api/health", "GET"), None);
        let error = |path, method| {
            parse_connection_http_route(path, method)
                .unwrap()
                .unwrap_err()
        };
        assert_eq!(error("/api/herdr-info", "POST").status, 405);
        assert_eq!(error("/api/connections/a", "GET").status, 400);
        assert_eq!(
            error("/api/connections/%E0%A4%A/herdr-info", "GET").message,
            "invalid connection_id encoding"
        );
        assert_eq!(
            error("/api/connections/..%2F/herdr-info", "GET").message,
            "invalid connection_id"
        );
        let unknown = error("/api/connections/a/nope", "GET");
        assert_eq!(
            (unknown.status, unknown.connection_id.as_deref()),
            (404, Some("a"))
        );
        assert_eq!(
            raw_request_pathname("http://h:1/api/connections/a/../x?y#z"),
            "/api/connections/a/../x"
        );
        assert_eq!(raw_request_pathname("http://h"), "/");
        assert_eq!(requested_http_generation(Some("12")), Some(json!(12)));
        assert_eq!(requested_http_generation(Some("012")), Some(json!("012")));
    }
}
