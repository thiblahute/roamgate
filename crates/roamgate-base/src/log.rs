//! Log lines (utils/logger.ts and utils/rpc-logging.ts): the format users
//! and `roamgate service logs` rely on, byte for byte.
//!
//! `2026-01-02T03:04:05.678Z INFO bridge.terminal message key=value ...`:
//! the time, the level, the scope, the message, then at most 24 fields.
//! Text is stripped of escape sequences and control characters, credentials
//! are redacted (a sensitive key's value becomes `***`, and so do tokens in
//! URLs, Authorization headers and `password=` pairs), and lengths are
//! bounded. Errors and warnings go to stderr, the rest to stdout.
//!
//! [`Logger`] is the plain API (scopes, children, levels); [`LogLayer`] is
//! the same lines for `tracing` events. [`RecoveryReporter`] logs a run of
//! equal failures once and a summary when it ends. [`rpc_log_level`] is the
//! level of an RPC outcome line.

use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde_json::{Map, Value};

use crate::clock::Clock;

/// The levels, most severe first.
pub const LOG_LEVELS: [LogLevel; 4] = [
    LogLevel::Error,
    LogLevel::Warn,
    LogLevel::Info,
    LogLevel::Debug,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LogLevel {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Error => "error",
            LogLevel::Warn => "warn",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }

    fn from_rank(rank: u8) -> Self {
        match rank {
            0 => LogLevel::Error,
            1 => LogLevel::Warn,
            2 => LogLevel::Info,
            _ => LogLevel::Debug,
        }
    }
}

impl fmt::Display for LogLevel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// An invalid log level, with the message the TS server gives.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct InvalidLogLevel(pub String);

/// A level from its name, any case, spaces around ignored.
pub fn parse_log_level(value: &str) -> Result<LogLevel, InvalidLogLevel> {
    parse_log_level_value(&Value::String(value.to_owned()))
}

/// A level from any JSON value, as `parseLogLevel(value)` reads one: a
/// string by its name, anything else by its text (`10`, `null`).
pub fn parse_log_level_value(value: &Value) -> Result<LogLevel, InvalidLogLevel> {
    let text = match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => js_string(other),
    };
    let normalized = text.trim().to_lowercase();
    if let Some(level) = LOG_LEVELS.iter().find(|level| level.as_str() == normalized) {
        return Ok(*level);
    }
    let rendered = match value {
        Value::String(text) => serde_json::to_string(text).unwrap_or_default(),
        other => render_value(other),
    };
    let accepted: Vec<&str> = LOG_LEVELS.iter().map(|level| level.as_str()).collect();
    Err(InvalidLogLevel(format!(
        "invalid log level {rendered}; expected {}",
        accepted.join(", ")
    )))
}

const MAX_MESSAGE_LENGTH: usize = 500;
const MAX_FIELD_LENGTH: usize = 300;
const MAX_FIELDS: usize = 24;

static SENSITIVE_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:password|passphrase|(?:roamgate_|herdr_gui_)?pin|sessionSecret|token|secret|cookie|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)$",
    )
    .unwrap()
});
static URL_USER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z\d+.\-]*://)([^@\s/]+)@").unwrap());
static QUERY_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|pin|token|secret)=)[^&#\s]+",
    )
    .unwrap()
});
static AUTH_HEADER: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r"(?i)\b((?:proxy-)?authorization)\s*:\s*(bearer|basic)\s+[^\s,;]+").unwrap()
});
// The TS pattern's `(["']?)...\1`: an optional quote around the key, the
// same on both sides.
static SECRET_PAIR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        r#"(?i)(["']?)(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passphrase|pin|sessionSecret|token|secret)\1(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)"#,
    )
    .unwrap()
});
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f-\u{9f}]").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static KEY_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.\-]").unwrap());
static NEEDS_QUOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\s="\\]"#).unwrap());

fn redact_sensitive_text(value: &str) -> String {
    let out = URL_USER.replace_all(value, "${1}***@");
    let out = QUERY_SECRET.replace_all(&out, "${1}***");
    let out = AUTH_HEADER.replace_all(&out, "$1: $2 ***");
    SECRET_PAIR.replace_all(&out, "$1$2$1$3***").into_owned()
}

/// The first `limit` UTF-16 units of `text`, as JS's `slice(0, limit)`
/// (a character is never cut in two).
pub fn slice_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
}

/// The length of `text` in UTF-16 units, as JS's `length`.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn sanitize_text(value: &str, limit: usize) -> String {
    let out = redact_sensitive_text(value);
    let out = ANSI.replace_all(&out, "");
    let out = CONTROL.replace_all(&out, " ");
    let out = SPACES.replace_all(&out, " ");
    slice_utf16(out.trim(), limit).to_owned()
}

/// A number as JS's `String(number)` writes it (in the usual range).
pub fn js_number(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

/// A value as JS's `String(value)` gives it (objects as `[object Object]`).
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn render_value(value: &Value) -> String {
    match value {
        Value::String(text) => sanitize_text(text, MAX_FIELD_LENGTH),
        Value::Null | Value::Bool(_) | Value::Number(_) => js_string(value),
        other => sanitize_text(
            &serde_json::to_string(other).unwrap_or_default(),
            MAX_FIELD_LENGTH,
        ),
    }
}

fn field_text(key: &str, value: &Value) -> String {
    if SENSITIVE_FIELD.is_match(key) {
        return "***".into();
    }
    render_value(value)
}

fn quote_field(value: &str) -> String {
    if !value.is_empty() && !NEEDS_QUOTE.is_match(value) {
        value.to_owned()
    } else {
        serde_json::to_string(value).unwrap_or_default()
    }
}

/// Epoch milliseconds as `Date.prototype.toISOString` writes them.
pub fn iso_millis(ms: i64) -> String {
    let Ok(timestamp) = jiff::Timestamp::from_millisecond(ms) else {
        return "Invalid Date".into();
    };
    let time = timestamp.to_zoned(jiff::tz::TimeZone::UTC).datetime();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        time.month(),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.subsec_nanosecond() / 1_000_000
    )
}

/// Epoch milliseconds of an ISO 8601 time with an offset or `Z`.
pub fn parse_iso_millis(text: &str) -> Option<i64> {
    text.parse::<jiff::Timestamp>()
        .ok()
        .map(|timestamp| timestamp.as_millisecond())
}

/// Log fields: names and JSON values in order. A field that should be left
/// out (JS's `undefined`) is simply not added.
pub type LogFields = Map<String, Value>;

/// One log line (formatLogLine).
pub fn format_log_line(
    timestamp_ms: i64,
    level: LogLevel,
    scope: &str,
    message: &str,
    fields: Option<&LogFields>,
) -> String {
    let scope = sanitize_text(scope, MAX_FIELD_LENGTH);
    let message = sanitize_text(message, MAX_MESSAGE_LENGTH);
    let mut parts = vec![
        iso_millis(timestamp_ms),
        level.as_str().to_uppercase(),
        if scope.is_empty() {
            "bridge".into()
        } else {
            scope
        },
        if message.is_empty() {
            "log".into()
        } else {
            message
        },
    ];
    if let Some(fields) = fields {
        let mut emitted = 0;
        for (raw_key, value) in fields {
            if emitted >= MAX_FIELDS {
                break;
            }
            let key = KEY_CHARS.replace_all(raw_key, "_");
            let key = slice_utf16(&key, 64);
            if key.is_empty() {
                continue;
            }
            parts.push(format!("{key}={}", quote_field(&field_text(key, value))));
            emitted += 1;
        }
    }
    parts.join(" ")
}

/// Where lines go.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

/// A source of epoch milliseconds.
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

struct LoggerState {
    level: AtomicU8,
    stdout: LogSink,
    stderr: LogSink,
    now: NowFn,
}

/// A scoped logger (createLogger). Clones and children share the level and
/// the sinks.
#[derive(Clone)]
pub struct Logger {
    state: Option<Arc<LoggerState>>,
    scope: String,
}

impl fmt::Debug for Logger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Logger")
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// How a [`Logger`] is made; unset parts are the defaults (info, `bridge`,
/// the process's stdout and stderr, the system clock's time).
#[derive(Default)]
pub struct LoggerOptions {
    pub level: Option<LogLevel>,
    pub scope: Option<String>,
    pub stdout: Option<LogSink>,
    pub stderr: Option<LogSink>,
    pub now: Option<NowFn>,
}

impl Logger {
    /// A logger writing to the process's stdout and stderr, time from `clock`.
    pub fn new(level: LogLevel, clock: Arc<dyn Clock>) -> Self {
        Self::with(LoggerOptions {
            level: Some(level),
            now: Some(Arc::new(move || clock.now())),
            ..LoggerOptions::default()
        })
    }

    pub fn with(options: LoggerOptions) -> Self {
        let state = LoggerState {
            level: AtomicU8::new(options.level.unwrap_or(LogLevel::Info) as u8),
            stdout: options
                .stdout
                .unwrap_or_else(|| Arc::new(|line: &str| println!("{line}"))),
            stderr: options
                .stderr
                .unwrap_or_else(|| Arc::new(|line: &str| eprintln!("{line}"))),
            now: options
                .now
                .unwrap_or_else(|| Arc::new(|| crate::clock::SystemClock.now())),
        };
        Self {
            state: Some(Arc::new(state)),
            scope: options.scope.unwrap_or_else(|| "bridge".into()),
        }
    }

    /// A logger that writes nothing (silentLogger).
    pub fn silent() -> Self {
        Self {
            state: None,
            scope: String::new(),
        }
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    /// Changes the level of this logger and of every logger sharing its
    /// state (configureServerLogger).
    pub fn set_level(&self, level: LogLevel) {
        if let Some(state) = &self.state {
            state.level.store(level as u8, Ordering::Relaxed);
        }
    }

    /// The level, None for the silent logger.
    pub fn level(&self) -> Option<LogLevel> {
        self.state
            .as_ref()
            .map(|state| LogLevel::from_rank(state.level.load(Ordering::Relaxed)))
    }

    pub fn enabled(&self, level: LogLevel) -> bool {
        self.level().is_some_and(|current| level <= current)
    }

    pub fn log(&self, level: LogLevel, message: &str, fields: Option<&LogFields>) {
        let Some(state) = &self.state else {
            return;
        };
        if !self.enabled(level) {
            return;
        }
        let line = format_log_line((state.now)(), level, &self.scope, message, fields);
        if matches!(level, LogLevel::Error | LogLevel::Warn) {
            (state.stderr)(&line)
        } else {
            (state.stdout)(&line)
        }
    }

    pub fn error(&self, message: &str, fields: Option<&LogFields>) {
        self.log(LogLevel::Error, message, fields)
    }

    pub fn warn(&self, message: &str, fields: Option<&LogFields>) {
        self.log(LogLevel::Warn, message, fields)
    }

    pub fn info(&self, message: &str, fields: Option<&LogFields>) {
        self.log(LogLevel::Info, message, fields)
    }

    pub fn debug(&self, message: &str, fields: Option<&LogFields>) {
        self.log(LogLevel::Debug, message, fields)
    }

    /// A logger for `<scope>.<child>`.
    pub fn child(&self, child: &str) -> Self {
        if self.state.is_none() {
            return self.clone();
        }
        let child = sanitize_text(child, 100);
        let scope = [self.scope.as_str(), child.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(".");
        Self {
            state: self.state.clone(),
            scope,
        }
    }
}

struct ActiveFailure {
    signature: String,
    failures: u64,
    started_at: i64,
}

/// Logs the first of a run of equal failures as a warning, the repeats at
/// debug, and a summary once it recovers (createRecoveryReporter).
pub struct RecoveryReporter {
    logger: Logger,
    failure_message: String,
    recovery_message: String,
    now: NowFn,
    current: Mutex<Option<ActiveFailure>>,
}

impl RecoveryReporter {
    pub fn new(logger: Logger, failure_message: &str, recovery_message: &str, now: NowFn) -> Self {
        Self {
            logger,
            failure_message: failure_message.into(),
            recovery_message: recovery_message.into(),
            now,
            current: Mutex::new(None),
        }
    }

    /// A failure; `error` is its message.
    pub fn failure(&self, error: &str, fields: Option<&LogFields>) {
        let detail = field_text("error", &Value::String(error.into()));
        let mut current = self.current.lock().unwrap();
        let mut out = fields.cloned().unwrap_or_default();
        if let Some(active) = current.as_mut()
            && active.signature == detail
        {
            active.failures += 1;
            out.insert("error".into(), Value::String(detail));
            out.insert("repeat".into(), active.failures.into());
            self.logger.debug(&self.failure_message, Some(&out));
            return;
        }
        *current = Some(ActiveFailure {
            signature: detail.clone(),
            failures: 1,
            started_at: (self.now)(),
        });
        out.insert("error".into(), Value::String(detail));
        self.logger.warn(&self.failure_message, Some(&out));
    }

    /// The end of a run of failures: logs its summary; true if there was one.
    pub fn recovered(&self, fields: Option<&LogFields>) -> bool {
        let mut current = self.current.lock().unwrap();
        let Some(active) = current.take() else {
            return false;
        };
        let duration = ((self.now)() - active.started_at).max(0);
        let mut out = fields.cloned().unwrap_or_default();
        out.insert("failures".into(), active.failures.into());
        out.insert(
            "suppressed".into(),
            active.failures.saturating_sub(1).into(),
        );
        out.insert("duration_ms".into(), duration.into());
        self.logger.info(&self.recovery_message, Some(&out));
        true
    }

    pub fn active(&self) -> bool {
        self.current.lock().unwrap().is_some()
    }
}

// ---------------------------------------------------------------- tracing

/// A `tracing` layer writing every event as a log line through a
/// [`Logger`]: the level maps (TRACE counts as debug), the scope is the
/// event's `scope` field when it has one, else the logger's, the message is
/// the `message` field and the other fields follow in order.
pub struct LogLayer {
    logger: Logger,
}

impl LogLayer {
    pub fn new(logger: Logger) -> Self {
        Self { logger }
    }
}

#[derive(Default)]
struct EventFields {
    message: String,
    scope: Option<String>,
    fields: LogFields,
}

impl tracing::field::Visit for EventFields {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        match field.name() {
            "message" => self.message = value.to_owned(),
            "scope" => self.scope = Some(value.to_owned()),
            name => {
                self.fields.insert(name.into(), Value::String(value.into()));
            }
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields.insert(field.name().into(), value.into());
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields.insert(field.name().into(), value.into());
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.fields.insert(field.name().into(), value.into());
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields.insert(field.name().into(), value.into());
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        let text = format!("{value:?}");
        self.record_str(field, &text);
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for LogLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _context: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let level = match *event.metadata().level() {
            tracing::Level::ERROR => LogLevel::Error,
            tracing::Level::WARN => LogLevel::Warn,
            tracing::Level::INFO => LogLevel::Info,
            _ => LogLevel::Debug,
        };
        if !self.logger.enabled(level) {
            return;
        }
        let mut visitor = EventFields::default();
        event.record(&mut visitor);
        let logger = match visitor.scope {
            Some(scope) => Logger {
                state: self.logger.state.clone(),
                scope,
            },
            None => self.logger.clone(),
        };
        let fields = (!visitor.fields.is_empty()).then_some(&visitor.fields);
        logger.log(level, &visitor.message, fields);
    }
}

// ---------------------------------------------------------------- RPC lines

/// What the terminal bridge answers a call made before a terminal is
/// attached: an expected detach race.
pub const NO_TERMINAL_ATTACHED_MESSAGE: &str = "no terminal attached";

static NOT_A_REPO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"not (?:inside )?a git repository").unwrap());

/// Whether an RPC failure is an expected request state, logged at debug.
pub fn is_expected_rpc_error(method: Option<&str>, detail: Option<&str>) -> bool {
    let message = detail.unwrap_or("").to_lowercase();
    if message.is_empty() {
        return false;
    }
    if message.contains("connection changed during request")
        // Background work shed while the host is busy: tried again later.
        || message.contains("background commands already waiting")
        || message.contains("connection runtime generation")
        || message.contains("connection is not ready")
    {
        return true;
    }
    if method == Some("git.diff_summary") && NOT_A_REPO.is_match(&message) {
        return true;
    }
    method.is_some_and(|method| method.starts_with("terminal."))
        && message == NO_TERMINAL_ATTACHED_MESSAGE
}

/// The level of an RPC outcome line: debug for successes and expected
/// failures, warn for the rest.
pub fn rpc_log_level(method: Option<&str>, ok: bool, detail: Option<&str>) -> LogLevel {
    if ok || is_expected_rpc_error(method, detail) {
        LogLevel::Debug
    } else {
        LogLevel::Warn
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors::{self, Call};
    use std::collections::{HashMap, VecDeque};

    #[test]
    fn rejects_values_that_are_not_level_names_with_their_text() {
        // A big integer, and an object (a circular one has no JSON form in
        // Rust; any other object reads by its JSON).
        assert_eq!(
            parse_log_level_value(&serde_json::json!(10)).unwrap_err().0,
            "invalid log level 10; expected error, warn, info, debug"
        );
        assert_eq!(
            parse_log_level_value(&serde_json::json!({"self": {}}))
                .unwrap_err()
                .0,
            "invalid log level {\"self\":{}}; expected error, warn, info, debug"
        );
        assert_eq!(parse_log_level(" Info ").unwrap(), LogLevel::Info);
    }

    #[test]
    fn rpc_successes_stay_at_debug() {
        assert_eq!(
            rpc_log_level(Some("workspace.list"), true, None),
            LogLevel::Debug
        );
    }

    #[test]
    fn expected_request_states_are_debug() {
        assert!(is_expected_rpc_error(
            Some("git.diff_summary"),
            Some("workspace is not inside a git repository")
        ));
        assert!(is_expected_rpc_error(
            Some("terminal.resize"),
            Some("no terminal attached")
        ));
        assert!(is_expected_rpc_error(
            Some("workspace.list"),
            Some("connection changed during request")
        ));
        assert!(is_expected_rpc_error(
            Some("workspace.list"),
            Some("connection runtime generation is unavailable")
        ));
        assert!(!is_expected_rpc_error(Some("workspace.list"), None));
    }

    #[test]
    fn unexpected_failures_are_warnings() {
        assert_eq!(
            rpc_log_level(
                Some("git.diff_summary"),
                false,
                Some("git process timed out")
            ),
            LogLevel::Warn
        );
    }

    fn capture() -> (LogSink, Arc<Mutex<Vec<String>>>) {
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let into = lines.clone();
        (
            Arc::new(move |line: &str| into.lock().unwrap().push(line.into())),
            lines,
        )
    }

    #[test]
    fn the_tracing_layer_writes_the_same_lines() {
        use tracing_subscriber::layer::SubscriberExt;
        let (stdout, out) = capture();
        let (stderr, err) = capture();
        let logger = Logger::with(LoggerOptions {
            level: Some(LogLevel::Info),
            stdout: Some(stdout),
            stderr: Some(stderr),
            now: Some(Arc::new(|| 1_767_323_045_678)),
            ..LoggerOptions::default()
        });
        let subscriber = tracing_subscriber::registry().with(LogLayer::new(logger));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(port = 8787, "listening");
            tracing::debug!("hidden");
            tracing::warn!(scope = "bridge.events", token = "x", "degraded");
        });
        assert_eq!(
            *out.lock().unwrap(),
            vec!["2026-01-02T03:04:05.678Z INFO bridge listening port=8787"]
        );
        assert_eq!(
            *err.lock().unwrap(),
            vec!["2026-01-02T03:04:05.678Z WARN bridge.events degraded token=***"]
        );
    }

    #[test]
    fn the_level_is_shared_with_children_and_silent_writes_nothing() {
        let (stdout, out) = capture();
        let logger = Logger::with(LoggerOptions {
            stdout: Some(stdout),
            now: Some(Arc::new(|| 0)),
            ..LoggerOptions::default()
        });
        let child = logger.child("terminal");
        child.debug("hidden", None);
        logger.set_level(LogLevel::Debug);
        child.debug("shown", None);
        Logger::silent().error("nothing", None);
        assert!(!Logger::silent().enabled(LogLevel::Error));
        assert_eq!(
            *out.lock().unwrap(),
            vec!["1970-01-01T00:00:00.000Z DEBUG bridge.terminal shown"]
        );
    }

    // ------------------------------------------- contract/vectors/logger.json

    type Calls = VecDeque<(Vec<Value>, Value)>;

    /// A `$fn` of a vector: its recorded calls, answered and checked in order.
    #[derive(Clone)]
    struct Recorded(Arc<Mutex<Calls>>);

    impl Recorded {
        fn from(value: &Value) -> Self {
            let (tag, body) = vectors::tag(value).expect("a $fn");
            assert_eq!(tag, "$fn");
            let calls = body["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| {
                    (
                        call["args"].as_array().cloned().unwrap_or_default(),
                        call.get("result").cloned().unwrap_or(Value::Null),
                    )
                })
                .collect();
            Self(Arc::new(Mutex::new(calls)))
        }

        fn take(&self, args: &[Value]) -> Value {
            let (want, result) = self
                .0
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| panic!("an unexpected call with {args:?}"));
            assert_eq!(args, want.as_slice());
            result
        }

        fn done(&self) {
            assert!(self.0.lock().unwrap().is_empty(), "calls not made");
        }
    }

    fn millis(value: &Value) -> i64 {
        match vectors::tag(value) {
            Some(("$date", date)) => parse_iso_millis(date.as_str().unwrap()).unwrap(),
            _ => value.as_i64().expect("ms"),
        }
    }

    fn handle_id(value: Option<&Value>) -> u64 {
        vectors::tag(value.expect("a handle"))
            .expect("a handle")
            .1
            .as_u64()
            .unwrap()
    }

    enum Handle {
        Logger(Logger),
        Reporter(RecoveryReporter),
    }

    fn fields_arg(call: &Call, at: usize) -> Option<LogFields> {
        call.args.get(at).and_then(Value::as_object).cloned()
    }

    fn level_of(name: &str) -> LogLevel {
        parse_log_level(name).unwrap()
    }

    #[test]
    fn logger_vectors() {
        let file = vectors::load("logger");
        for case in &file.cases {
            let mut handles: HashMap<u64, Handle> = HashMap::new();
            let mut callbacks: Vec<Recorded> = Vec::new();
            let title = case.title();
            for call in &case.calls {
                let target = call.target();
                match target.as_str() {
                    "logger.formatLogLine" => {
                        let args = &call.args[0];
                        let line = format_log_line(
                            millis(&args["timestamp"]),
                            level_of(args["level"].as_str().unwrap()),
                            args["scope"].as_str().unwrap(),
                            args["message"].as_str().unwrap(),
                            args.get("fields").and_then(Value::as_object),
                        );
                        assert_eq!(Some(&Value::String(line)), call.result.as_ref(), "{title}");
                    }
                    "logger.parseLogLevel" => {
                        match (parse_log_level_value(&call.args[0]), &call.throws) {
                            (Ok(level), None) => assert_eq!(
                                Some(&Value::String(level.as_str().into())),
                                call.result.as_ref(),
                                "{title}"
                            ),
                            (Err(error), Some(message)) => {
                                assert_eq!(&error.0, message, "{title}")
                            }
                            (got, want) => panic!("{title}: {got:?} against {want:?}"),
                        }
                    }
                    "logger.createLogger" => {
                        let args = &call.args[0];
                        let mut sink = |name: &str| -> Option<LogSink> {
                            let recorded = Recorded::from(args.get(name)?);
                            callbacks.push(recorded.clone());
                            Some(Arc::new(move |line: &str| {
                                recorded.take(&[Value::String(line.into())]);
                            }))
                        };
                        let stdout = sink("stdout");
                        let stderr = sink("stderr");
                        let now = args.get("now").map(|value| {
                            let recorded = Recorded::from(value);
                            callbacks.push(recorded.clone());
                            Arc::new(move || millis(&recorded.take(&[]))) as NowFn
                        });
                        let logger = Logger::with(LoggerOptions {
                            level: args["level"].as_str().map(level_of),
                            scope: args["scope"].as_str().map(str::to_owned),
                            stdout,
                            stderr,
                            now,
                        });
                        handles.insert(handle_id(call.result.as_ref()), Handle::Logger(logger));
                    }
                    "logger.createRecoveryReporter" => {
                        let args = &call.args[0];
                        let logger_id = handle_id(Some(&args["logger"]));
                        let Some(Handle::Logger(logger)) = handles.get(&logger_id) else {
                            panic!("{title}: no logger {logger_id}");
                        };
                        let recorded = Recorded::from(&args["now"]);
                        callbacks.push(recorded.clone());
                        let reporter = RecoveryReporter::new(
                            logger.clone(),
                            args["failureMessage"].as_str().unwrap(),
                            args["recoveryMessage"].as_str().unwrap(),
                            Arc::new(move || millis(&recorded.take(&[]))),
                        );
                        handles.insert(handle_id(call.result.as_ref()), Handle::Reporter(reporter));
                    }
                    method => {
                        let on = call
                            .on
                            .unwrap_or_else(|| panic!("{title}: unknown {method}"));
                        match (handles.get(&on), method) {
                            (Some(Handle::Logger(logger)), "on.child") => {
                                let child = logger.child(call.args[0].as_str().unwrap());
                                handles
                                    .insert(handle_id(call.result.as_ref()), Handle::Logger(child));
                            }
                            (
                                Some(Handle::Logger(logger)),
                                "on.error" | "on.warn" | "on.info" | "on.debug",
                            ) => {
                                logger.log(
                                    level_of(&method[3..]),
                                    call.args[0].as_str().unwrap(),
                                    fields_arg(call, 1).as_ref(),
                                );
                                assert!(call.returns_undefined(), "{title}");
                            }
                            (Some(Handle::Reporter(reporter)), "on.failure") => {
                                let error = match vectors::tag(&call.args[0]) {
                                    Some(("$error", body)) => {
                                        body["message"].as_str().unwrap().to_owned()
                                    }
                                    _ => call.args[0].as_str().unwrap().to_owned(),
                                };
                                reporter.failure(&error, fields_arg(call, 1).as_ref());
                            }
                            (Some(Handle::Reporter(reporter)), "on.recovered") => {
                                let got = reporter.recovered(fields_arg(call, 0).as_ref());
                                assert_eq!(
                                    Some(&Value::Bool(got)),
                                    call.result.as_ref(),
                                    "{title}"
                                );
                            }
                            _ => panic!("{title}: unknown call {method} on {on}"),
                        }
                    }
                }
            }
            for callback in &callbacks {
                callback.done();
            }
        }
    }
}
