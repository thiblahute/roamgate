//! Contract record mode (contract-record/recorder.ts and redact.ts):
//! `ROAMGATE_CONTRACT_RECORD` makes the server write its external traffic
//! as redacted JSONL, the corpus the contract is checked against and the
//! soak diffs compare (plan sections 4.2 and 5.6).
//!
//! `1`, `on`, `true` or `yes` records under `<data>/contract-record`; any
//! other value is the directory. Unset, empty, `0`, `off`, `false` or `no`:
//! no recorder. Each process writes `rec-<UTC start>-<pid>-<n>.jsonl` (0600
//! in a 0700 directory), rotated at `ROAMGATE_CONTRACT_RECORD_SEGMENT_MB`
//! (32) and pruned oldest first beyond `ROAMGATE_CONTRACT_RECORD_KEEP_MB`
//! (1024) for the whole directory. `record` only queues; parsing, redaction
//! and the write happen in a batch 250 ms after the first queued event
//! ([`ContractRecorder::run_flusher`]) and at close. Past 20000 queued
//! events new ones are dropped and counted.
//!
//! Its files are private ([`crate::private`]): a 0700 directory, segments
//! created 0600 with `O_EXCL` and `O_NOFOLLOW`. The variables are read
//! through [`crate::env`], `ROAMGATE_` over `HERDR_GUI_`.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::clock::Clock;
use crate::env::{Env, roamgate_env};
use crate::log::{NowFn, iso_millis, slice_utf16, utf16_len};
use crate::private;

// ------------------------------------------------------------- redaction

pub const DEFAULT_MAX_STRING: usize = 4096;

const SENSITIVE_EXACT: &[&str] = &[
    "pin",
    "auth",
    "otp",
    "cookie",
    "set-cookie",
    "authorization",
    "proxy-authorization",
    "p256dh",
    "credentials",
    "credential",
    "private_key",
    "privatekey",
    "api_key",
    "apikey",
    "secret_key",
    "x-api-key",
    "passphrase",
];

const SENSITIVE_SUFFIXES: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "cookie",
    "authorization",
];

/// True for a key whose value is a credential.
pub fn sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SENSITIVE_EXACT.contains(&lower.as_str())
        || SENSITIVE_SUFFIXES
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

/// Keys whose string values are terminal bytes or keystrokes.
const TERMINAL_KEYS: &[&str] = &["bytes"];

const BASE64_MIN: usize = 64;
static BASE64: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]+={0,2}$").unwrap());

/// What a pattern's match becomes, given the tagger and the match.
type Replace = fn(&dyn Fn(&str) -> String, &Captures<'_>) -> String;

static PATTERNS: LazyLock<Vec<(Regex, Replace)>> = LazyLock::new(|| {
    let whole: Replace = |tag, found| tag(&found[0]);
    vec![
        (
            Regex::new(
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            )
            .unwrap(),
            whole,
        ),
        (
            Regex::new(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap(),
            |tag, found| format!("{} {}", &found[1], tag(&found[0])),
        ),
        (
            Regex::new(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}").unwrap(),
            whole,
        ),
        (
            // GitLab (glpat-, gldt-, glrt-, ...), GitHub, Anthropic/OpenAI
            // style, Slack and AWS access keys.
            Regex::new(
                r"\b(?:(?:glpat|gldt|glrt|glcbt|glptt|glft|glimt|glagent|gloas|glsoat|glffct)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})",
            )
            .unwrap(),
            whole,
        ),
        (
            // A URL's password: scheme://user:password@host
            Regex::new(r#"(?i)\b([a-z][a-z0-9+.\-]*://[^\s/:@"']+):([^\s/@"']+)@"#).unwrap(),
            |tag, found| format!("{}:{}@", &found[1], tag(&found[2])),
        ),
        (
            // A credential in a query string or form text.
            Regex::new(
                r#"(?i)([?&;](?:[a-z0-9_-]*token|auth|key|password|secret|sig|signature|code|pin)=)([^&\s"'#]+)"#,
            )
            .unwrap(),
            |tag, found| format!("{}{}", &found[1], tag(&found[2])),
        ),
        (
            // A Web Push subscription endpoint is a capability URL.
            Regex::new(
                r#"(?i)(https://(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/)[^\s"']+"#,
            )
            .unwrap(),
            |tag, found| format!("{}{}", &found[1], tag(&found[0])),
        ),
        (
            // A rendered page's token is its credential.
            Regex::new(r"(/rendered/)([A-Za-z0-9_-]{16,})").unwrap(),
            |tag, found| format!("{}{}", &found[1], tag(&found[2])),
        ),
    ]
});

/// Any of the patterns could match: one scan before the eight.
static MAYBE_CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)BEGIN|bearer|eyJ|gl[a-z]{2,6}-|gh[pousr]_|github_pat_|sk-|xox|AKIA|://|=|/rendered/",
    )
    .unwrap()
});

/// Redaction of recorded messages: a recording keeps the shape of every
/// message (keys, types, array lengths) and drops credentials, tokens,
/// keystrokes and terminal bytes. A credential becomes `[redacted:<tag>]`,
/// a salted hash that reads the same for the same secret within one
/// process only.
pub struct Redactor {
    salt: [u8; 16],
    secrets: Mutex<(BTreeSet<String>, Option<Regex>)>,
    max_string: usize,
}

impl Redactor {
    pub fn new(max_string: usize) -> Self {
        Self {
            salt: rand::random(),
            secrets: Mutex::new((BTreeSet::new(), None)),
            max_string,
        }
    }

    /// An exact value to redact wherever it appears (4 characters at least).
    pub fn add_secret(&self, value: &str) {
        if utf16_len(value) < 4 {
            return;
        }
        let mut secrets = self.secrets.lock().unwrap();
        if !secrets.0.insert(value.to_owned()) {
            return;
        }
        let mut sorted: Vec<&String> = secrets.0.iter().collect();
        sorted.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        let pattern = sorted
            .iter()
            .map(|secret| regex::escape(secret))
            .collect::<Vec<_>>()
            .join("|");
        secrets.1 = Regex::new(&pattern).ok();
    }

    /// `[redacted:<8 hex>]`: equal secrets read equal within this redactor.
    pub fn tag(&self, value: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(self.salt);
        hash.update(value.as_bytes());
        let digest = hex::encode(hash.finalize());
        format!("[redacted:{}]", &digest[..8])
    }

    /// Credentials inside free text replaced, then the text cut.
    pub fn string(&self, value: &str) -> String {
        let mut out = value.to_owned();
        let secrets = self.secrets.lock().unwrap().1.clone();
        if let Some(secrets) = secrets {
            out = secrets
                .replace_all(&out, |found: &Captures<'_>| self.tag(&found[0]))
                .into_owned();
        }
        if MAYBE_CREDENTIAL.is_match(&out) {
            let tag = |text: &str| self.tag(text);
            for (pattern, replace) in PATTERNS.iter() {
                if pattern.is_match(&out) {
                    out = pattern
                        .replace_all(&out, |found: &Captures<'_>| replace(&tag, found))
                        .into_owned();
                }
            }
        }
        let length = utf16_len(&out);
        if length >= BASE64_MIN && BASE64.is_match(&out) {
            return format!("[base64:{length}]");
        }
        if length > self.max_string {
            return format!(
                "{}...[+{}]",
                slice_utf16(&out, self.max_string),
                length - self.max_string
            );
        }
        out
    }

    /// Every leaf of a credential's value redacted, keeping its type.
    fn secret(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.tag(text)),
            Value::Number(_) => Value::from(0),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.secret(item)).collect())
            }
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, item)| (key.clone(), self.secret(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// A deep copy of a JSON value with its credentials redacted.
    pub fn value(&self, value: &Value) -> Value {
        self.value_at(value, 0)
    }

    fn value_at(&self, value: &Value, depth: usize) -> Value {
        match value {
            Value::String(text) => Value::String(self.string(text)),
            Value::Array(_) | Value::Object(_) if depth > 64 => Value::String("[depth]".into()),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.value_at(item, depth + 1))
                    .collect(),
            ),
            Value::Object(object) => {
                let mut out = Map::new();
                for (key, item) in object {
                    let redacted = if sensitive_key(key) {
                        self.secret(item)
                    } else if let (true, Value::String(text)) =
                        (TERMINAL_KEYS.contains(&key.as_str()), item)
                    {
                        Value::String(format!("[terminal:{}]", utf16_len(text)))
                    } else {
                        self.value_at(item, depth + 1)
                    };
                    out.insert(key.clone(), redacted);
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    /// A browser RPC request: keystrokes (`terminal.input`) keep only their
    /// length, the rest goes through [`Redactor::value`].
    pub fn message(&self, message: &Value) -> Value {
        if let Some(object) = message.as_object()
            && object.get("method").and_then(Value::as_str) == Some("terminal.input")
        {
            let mut copy = object.clone();
            let mut params = copy
                .get("params")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(Value::String(data)) = params.get("data") {
                let length = utf16_len(data);
                params.insert("data".into(), Value::String(format!("[terminal:{length}]")));
            }
            copy.insert("params".into(), Value::Object(params));
            return self.value(&Value::Object(copy));
        }
        self.value(message)
    }

    /// Headers as an object (names in lower case, as `Headers` gives them),
    /// credentials redacted.
    pub fn headers<'a>(
        &self,
        headers: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Map<String, Value> {
        let mut out = Map::new();
        for (name, value) in headers {
            let name = name.to_ascii_lowercase();
            let redacted = if sensitive_key(&name) {
                self.tag(value)
            } else {
                self.string(value)
            };
            out.insert(name, Value::String(redacted));
        }
        out
    }

    /// A request URL's path, and its query when it has one, with credential
    /// parameters redacted. None when `url` is not an absolute URL.
    pub fn url(&self, url: &str) -> Option<(String, Option<Map<String, Value>>)> {
        let (_, rest) = url.split_once("://")?;
        let rest = rest.split('#').next().unwrap_or("");
        let start = rest.find(['/', '?']).unwrap_or(rest.len());
        let tail = &rest[start..];
        let (path, search) = match tail.split_once('?') {
            Some((path, search)) => (path, search),
            None => (tail, ""),
        };
        let path = self.string(if path.is_empty() { "/" } else { path });
        if search.is_empty() {
            return Some((path, None));
        }
        let mut query = Map::new();
        for (key, value) in form_pairs(search) {
            let redacted = if sensitive_key(&key) || key == "key" || key == "code" {
                self.tag(&value)
            } else {
                self.string(&value)
            };
            query.insert(key, Value::String(redacted));
        }
        Some((path, Some(query)))
    }

    /// A form body (the agent socket's) as an object, values decoded; a
    /// value that is JSON keeps its shape, a repeated key is an array.
    pub fn form(&self, body: &str) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, raw) in form_pairs(body) {
            if sensitive_key(&key) {
                out.insert(key, Value::String(self.tag(&raw)));
                continue;
            }
            let trimmed = raw.trim_start();
            let parsed = if trimmed.starts_with('[') || trimmed.starts_with('{') {
                serde_json::from_str(&raw).unwrap_or(Value::String(raw.clone()))
            } else {
                Value::String(raw.clone())
            };
            let redacted = self.value(&parsed);
            match out.get_mut(&key) {
                Some(Value::Array(previous)) => previous.push(redacted),
                Some(previous) => {
                    let first = previous.take();
                    *previous = Value::Array(vec![first, redacted]);
                }
                None => {
                    out.insert(key, redacted);
                }
            }
        }
        out
    }
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_STRING)
    }
}

/// The pairs of `application/x-www-form-urlencoded` text, decoded as
/// `URLSearchParams` does (`+` is a space, bad escapes stay as written).
pub fn form_pairs(text: &str) -> Vec<(String, String)> {
    fn decode(part: &str) -> String {
        let bytes = part.as_bytes();
        let hex = |byte: u8| (byte as char).to_digit(16);
        let mut out = Vec::with_capacity(bytes.len());
        let mut at = 0;
        while at < bytes.len() {
            match bytes[at] {
                b'+' => out.push(b' '),
                b'%' => {
                    match (
                        bytes.get(at + 1).and_then(|b| hex(*b)),
                        bytes.get(at + 2).and_then(|b| hex(*b)),
                    ) {
                        (Some(high), Some(low)) => {
                            out.push((high * 16 + low) as u8);
                            at += 3;
                            continue;
                        }
                        _ => out.push(b'%'),
                    }
                }
                byte => out.push(byte),
            }
            at += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    text.trim_start_matches('?')
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) => (decode(key), decode(value)),
            None => (decode(pair), String::new()),
        })
        .collect()
}

// ------------------------------------------------------------- recorder

pub const RECORD_FORMAT_VERSION: u64 = 1;
const FLUSH_MS: u64 = 250;
const MAX_QUEUE: usize = 20_000;
const MB: u64 = 1024 * 1024;

const ENABLED: &[&str] = &["1", "on", "true", "yes"];
const DISABLED: &[&str] = &["", "0", "off", "false", "no"];

/// The directory to record to, or None when record mode is off. `env`
/// is the environment; `root` is the data root.
pub fn contract_record_directory(env: &dyn Env, root: impl FnOnce() -> PathBuf) -> Option<PathBuf> {
    // Roamgate's own name wins, even empty.
    let value = roamgate_env(env, "CONTRACT_RECORD")?;
    let value = value.trim();
    let lower = value.to_lowercase();
    if DISABLED.contains(&lower.as_str()) {
        return None;
    }
    if ENABLED.contains(&lower.as_str()) {
        return Some(root().join("contract-record"));
    }
    std::path::absolute(value).ok()
}

fn megabytes(env: &dyn Env, name: &str, fallback: u64) -> u64 {
    let value = roamgate_env(env, name)
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0);
    match value {
        Some(value) => (value * MB as f64) as u64,
        None => fallback * MB,
    }
}

/// How the raw text of an event becomes its line's `msg`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RawKind {
    /// A browser message: parsed, with keystrokes redacted.
    #[default]
    Message,
    Json,
    /// The agent socket's form (or JSON, whatever its header says).
    Form,
    Text,
}

/// One event to record.
#[derive(Debug, Clone, Default)]
pub struct RecordInput {
    /// The channel: ws, voice, notifications, signalling, http, agent, mcp,
    /// cli, spawn, recorder.
    pub ch: String,
    pub ev: String,
    pub sock: Option<String>,
    /// Plain and small; redacted with the rest at flush.
    pub fields: Option<Map<String, Value>>,
    pub raw: Option<String>,
    pub raw_kind: RawKind,
    /// Raw bodies decoded like `raw` into the named fields.
    pub bodies: Vec<(String, String, RawKind)>,
    /// A request URL, written as `path` and `query`.
    pub url: Option<String>,
}

impl RecordInput {
    pub fn new(ch: &str, ev: &str) -> Self {
        Self {
            ch: ch.into(),
            ev: ev.into(),
            ..Self::default()
        }
    }
}

/// How a [`ContractRecorder`] is made.
pub struct RecorderOptions {
    pub directory: PathBuf,
    /// "server", "cli": written in each file's first line.
    pub role: String,
    pub segment_bytes: u64,
    pub keep_bytes: u64,
    pub max_string: usize,
    pub now: NowFn,
}

impl RecorderOptions {
    pub fn new(directory: impl Into<PathBuf>, role: &str, now: NowFn) -> Self {
        Self {
            directory: directory.into(),
            role: role.into(),
            segment_bytes: 32 * MB,
            keep_bytes: 1024 * MB,
            max_string: DEFAULT_MAX_STRING,
            now,
        }
    }

    /// The options the environment asks for, None when record mode is off.
    pub fn from_env(
        env: &dyn Env,
        root: impl FnOnce() -> PathBuf,
        role: &str,
        now: NowFn,
    ) -> Option<Self> {
        let directory = contract_record_directory(env, root)?;
        Some(Self {
            segment_bytes: megabytes(env, "CONTRACT_RECORD_SEGMENT_MB", 32),
            keep_bytes: megabytes(env, "CONTRACT_RECORD_KEEP_MB", 1024),
            ..Self::new(directory, role, now)
        })
    }
}

/// What a recorder did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecorderStats {
    pub events: u64,
    pub dropped: u64,
    pub bytes: u64,
    pub flushes: u64,
    pub file: PathBuf,
}

struct Queued {
    input: RecordInput,
    t: i64,
}

struct RecorderState {
    queue: Vec<Queued>,
    file: Option<File>,
    path: PathBuf,
    file_bytes: u64,
    segment: u64,
    seq: u64,
    dropped_since_flush: u64,
    closed: bool,
    stats: RecorderStats,
}

/// The JSONL recorder of one process.
pub struct ContractRecorder {
    pub redactor: Redactor,
    directory: PathBuf,
    role: String,
    segment_bytes: u64,
    keep_bytes: u64,
    now: NowFn,
    started: i64,
    state: Mutex<RecorderState>,
    queued: tokio::sync::Notify,
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `mkdir -p` with 0700 for what it creates (recorder.ts's
/// `mkdirSync(dir, { recursive: true, mode: 0o700 })`).
fn private_dir(directory: &Path) -> std::io::Result<()> {
    private::create_dir_all_mode(directory)
}

/// A new segment: created 0600, never through a symlink.
fn create_private(path: &Path) -> std::io::Result<File> {
    private::open_nofollow(path, private::OpenMode::CreateNew)
}

impl ContractRecorder {
    pub fn new(options: RecorderOptions) -> std::io::Result<Self> {
        private_dir(&options.directory)?;
        let started = (options.now)();
        Ok(Self {
            redactor: Redactor::new(options.max_string),
            directory: options.directory,
            role: options.role,
            segment_bytes: options.segment_bytes,
            keep_bytes: options.keep_bytes,
            now: options.now,
            started,
            state: Mutex::new(RecorderState {
                queue: Vec::new(),
                file: None,
                path: PathBuf::new(),
                file_bytes: 0,
                segment: 0,
                seq: 0,
                dropped_since_flush: 0,
                closed: false,
                stats: RecorderStats::default(),
            }),
            queued: tokio::sync::Notify::new(),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Queues one event; cheap, never fails.
    pub fn record(&self, input: RecordInput) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        if state.queue.len() >= MAX_QUEUE {
            state.dropped_since_flush += 1;
            state.stats.dropped += 1;
        } else {
            let t = (self.now)();
            state.queue.push(Queued { input, t });
            state.stats.events += 1;
        }
        drop(state);
        self.queued.notify_one();
    }

    /// Flushes 250 ms after events were queued, until the task is aborted
    /// (the server's exit closes the recorder, which flushes the rest).
    pub fn run_flusher(self: &Arc<Self>, clock: Arc<dyn Clock>) -> tokio::task::JoinHandle<()> {
        let recorder = self.clone();
        tokio::spawn(async move {
            loop {
                recorder.queued.notified().await;
                clock.sleep(Duration::from_millis(FLUSH_MS)).await;
                recorder.flush();
            }
        })
    }

    /// Writes every queued event now.
    pub fn flush(&self) {
        let mut state = self.state.lock().unwrap();
        if state.queue.is_empty() && state.dropped_since_flush == 0 {
            return;
        }
        let mut batch = std::mem::take(&mut state.queue);
        if state.dropped_since_flush > 0 {
            let mut fields = Map::new();
            fields.insert("count".into(), state.dropped_since_flush.into());
            batch.push(Queued {
                input: RecordInput {
                    fields: Some(fields),
                    ..RecordInput::new("recorder", "dropped")
                },
                t: (self.now)(),
            });
            state.dropped_since_flush = 0;
        }
        // The file's first line comes before the events it holds.
        if state.file.is_none() {
            let _ = self.rotate(&mut state);
        }
        let mut text = String::new();
        for item in &batch {
            let line = self.line(&mut state, item);
            text.push_str(&serde_json::to_string(&line).unwrap_or_default());
            text.push('\n');
        }
        // A full disk or a removed directory: recording is best effort.
        let _ = self.write(&mut state, text.as_bytes());
        state.stats.flushes += 1;
    }

    /// Flushes and closes the file; later events are ignored.
    pub fn close(&self) {
        self.flush();
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.file = None;
    }

    pub fn stats(&self) -> RecorderStats {
        let state = self.state.lock().unwrap();
        RecorderStats {
            file: state.path.clone(),
            ..state.stats.clone()
        }
    }

    fn head(&self, state: &mut RecorderState, t: i64, ch: &str, ev: &str) -> Map<String, Value> {
        state.seq += 1;
        let mut line = Map::new();
        line.insert("v".into(), RECORD_FORMAT_VERSION.into());
        line.insert("seq".into(), state.seq.into());
        line.insert("t".into(), Value::String(iso_millis(t)));
        line.insert("pid".into(), std::process::id().into());
        line.insert("ch".into(), Value::String(ch.into()));
        line.insert("ev".into(), Value::String(ev.into()));
        line
    }

    fn line(&self, state: &mut RecorderState, item: &Queued) -> Map<String, Value> {
        let input = &item.input;
        let mut line = self.head(state, item.t, &input.ch, &input.ev);
        if let Some(sock) = &input.sock {
            line.insert("sock".into(), Value::String(sock.clone()));
        }
        if let Some(fields) = &input.fields
            && let Value::Object(fields) = self.redactor.value(&Value::Object(fields.clone()))
        {
            for (key, value) in fields {
                if !line.contains_key(&key) {
                    line.insert(key, value);
                }
            }
        }
        if let Some(url) = &input.url {
            match self.redactor.url(url) {
                Some((path, query)) => {
                    line.insert("path".into(), Value::String(path));
                    if let Some(query) = query {
                        line.insert("query".into(), Value::Object(query));
                    }
                }
                None => {
                    line.insert("path".into(), Value::String(self.redactor.string(url)));
                }
            }
        }
        for (key, raw, kind) in &input.bodies {
            line.insert(key.clone(), self.decode(raw, *kind));
        }
        if let Some(raw) = &input.raw {
            line.insert("msg".into(), self.decode(raw, input.raw_kind));
        }
        line
    }

    fn decode(&self, raw: &str, kind: RawKind) -> Value {
        let first = raw.trim_start().chars().next();
        // The agent socket takes JSON or a form, whatever its header says.
        if kind == RawKind::Form && first != Some('{') {
            return Value::Object(self.redactor.form(raw));
        }
        if kind == RawKind::Text {
            return Value::String(self.redactor.string(raw));
        }
        if matches!(first, Some('{' | '['))
            && let Ok(parsed) = serde_json::from_str::<Value>(raw)
        {
            return if kind == RawKind::Message {
                self.redactor.message(&parsed)
            } else {
                self.redactor.value(&parsed)
            };
        }
        let mut text = Map::new();
        text.insert("text".into(), Value::String(self.redactor.string(raw)));
        Value::Object(text)
    }

    fn write(&self, state: &mut RecorderState, bytes: &[u8]) -> std::io::Result<()> {
        if state.file.is_none() || state.file_bytes + bytes.len() as u64 > self.segment_bytes {
            self.rotate(state)?;
        }
        let Some(file) = state.file.as_mut() else {
            return Ok(());
        };
        file.write_all(bytes)?;
        state.file_bytes += bytes.len() as u64;
        state.stats.bytes += bytes.len() as u64;
        Ok(())
    }

    fn rotate(&self, state: &mut RecorderState) -> std::io::Result<()> {
        state.file = None;
        state.segment += 1;
        let stamp: String = iso_millis(self.started)
            .chars()
            .filter(|c| *c != '-' && *c != ':')
            .collect();
        let stamp = stamp.split('.').next().unwrap_or("").to_owned();
        let name = format!(
            "rec-{stamp}-{}-{:04}.jsonl",
            std::process::id(),
            state.segment
        );
        state.path = self.directory.join(name);
        private_dir(&self.directory)?;
        let mut file = create_private(&state.path)?;
        let mut header = self.head(state, (self.now)(), "recorder", "start");
        header.insert("role".into(), Value::String(self.role.clone()));
        header.insert("segment".into(), state.segment.into());
        header.insert("platform".into(), Value::String(platform().into()));
        let header = format!("{}\n", serde_json::to_string(&header).unwrap_or_default());
        file.write_all(header.as_bytes())?;
        state.file = Some(file);
        state.file_bytes = header.len() as u64;
        state.stats.bytes += header.len() as u64;
        self.prune(&state.path);
        Ok(())
    }

    /// Removes the oldest recordings while the directory is over its budget.
    fn prune(&self, current: &Path) {
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return;
        };
        let mut files: Vec<(String, u64)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                (name.starts_with("rec-") && name.ends_with(".jsonl")).then(|| {
                    let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                    (name, size)
                })
            })
            .collect();
        files.sort();
        let mut total: u64 = files.iter().map(|(_, size)| size).sum();
        for (name, size) in files {
            if total <= self.keep_bytes {
                break;
            }
            let path = self.directory.join(&name);
            if path == current {
                continue;
            }
            let _ = std::fs::remove_file(&path);
            total -= size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn is_tag(value: &Value) -> bool {
        static TAG: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^\[redacted:[0-9a-f]{8}\]$").unwrap());
        value.as_str().is_some_and(|text| TAG.is_match(text))
    }

    #[test]
    fn knows_credential_keys_without_catching_counts_and_ids() {
        for key in [
            "password",
            "pin",
            "token",
            "call_token",
            "sessionToken",
            "session_secret",
            "cookie",
            "Set-Cookie",
            "authorization",
            "p256dh",
            "auth",
            "api_key",
        ] {
            assert!(sensitive_key(key), "{key}");
        }
        for key in [
            "input_tokens",
            "max_tokens",
            "pinned",
            "id",
            "terminal_id",
            "coalesce_key",
            "code",
        ] {
            assert!(!sensitive_key(key), "{key}");
        }
    }

    #[test]
    fn redacts_values_under_credential_keys_keeping_their_types() {
        let redactor = Redactor::default();
        let out = redactor.value(&json!({
            "method": "auth.login",
            "params": { "password": "hunter2hunter2", "pin": 123456, "keep": true },
            "nested": { "credentials": { "user": "me", "secret": "s3cr3t" } },
        }));
        assert_eq!(out["method"], "auth.login");
        assert!(is_tag(&out["params"]["password"]));
        assert_eq!(out["params"]["pin"], 0);
        assert_eq!(out["params"]["keep"], true);
        assert!(is_tag(&out["nested"]["credentials"]["user"]));
    }

    #[test]
    fn gives_equal_secrets_equal_tags_within_a_redactor_only() {
        let (one, two) = (Redactor::default(), Redactor::default());
        assert_eq!(one.tag("abc"), one.tag("abc"));
        assert_ne!(one.tag("abc"), one.tag("abd"));
        assert_ne!(one.tag("abc"), two.tag("abc"));
    }

    #[test]
    fn finds_credentials_inside_free_text() {
        let redactor = Redactor::default();
        let text = [
            "Authorization: Bearer abcdefghijklmnop",
            "glpat-ABCDEFGHIJKLMNOPQRST",
            "ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
            "sk-ant-api03-ABCDEFGHIJKLMNOP",
            "https://me:pa55word@example.com/repo.git",
            "https://host/x?token=abcdef&page=2",
            "/rendered/AbCdEfGhIjKlMnOpQrSt/index.html",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2hlcmU",
            "https://fcm.googleapis.com/fcm/send/abc:def",
        ]
        .join("\n");
        let out = redactor.string(&text);
        for secret in [
            "abcdefghijklmnop",
            "glpat-ABCDEF",
            "ghp_ABCDEF",
            "sk-ant-api03",
            "pa55word",
            "token=abcdef",
            "AbCdEfGhIjKlMnOpQrSt",
            "eyJhbGciOiJIUzI1NiJ9",
            "fcm/send/abc",
        ] {
            assert!(!out.contains(secret), "{secret} in {out}");
        }
        assert!(out.contains("page=2"));
        assert!(out.contains("https://me:[redacted:"));
    }

    #[test]
    fn leaves_ordinary_prose_alone() {
        let prose = "Basic understanding of global-settings-and-other-things and the risk-assessment-framework";
        assert_eq!(Redactor::default().string(prose), prose);
    }

    #[test]
    fn redacts_the_exact_secrets_it_is_given() {
        let redactor = Redactor::default();
        redactor.add_secret("my-server-password");
        redactor.add_secret("abc"); // too short to look for
        let out = redactor.string("login with my-server-password now");
        assert!(
            Regex::new(r"^login with \[redacted:[0-9a-f]{8}\] now$")
                .unwrap()
                .is_match(&out),
            "{out}"
        );
        assert_eq!(redactor.string("abc"), "abc");
    }

    #[test]
    fn keeps_only_the_length_of_terminal_bytes_and_keystrokes() {
        let redactor = Redactor::default();
        let frame =
            redactor.value(&json!({"terminal": {"terminal_id": "t1", "bytes": "aGVsbG8="}}));
        assert_eq!(
            frame["terminal"],
            json!({"terminal_id": "t1", "bytes": "[terminal:8]"})
        );
        let input = redactor.message(&json!({
            "id": 3, "method": "terminal.input",
            "params": {"terminal_id": "t1", "data": "cGFzc3dvcmQK"}
        }));
        assert_eq!(
            input["params"],
            json!({"terminal_id": "t1", "data": "[terminal:12]"})
        );
    }

    #[test]
    fn cuts_long_strings_and_long_base64() {
        let redactor = Redactor::new(10);
        assert_eq!(redactor.string(&"x".repeat(25)), "xxxxxxxxxx...[+15]");
        assert_eq!(redactor.string(&"QUJD".repeat(20)), "[base64:80]");
    }

    #[test]
    fn redacts_headers_query_parameters_and_forms() {
        let redactor = Redactor::default();
        let headers =
            redactor.headers([("cookie", "roamgate_session=abc"), ("Accept", "text/html")]);
        assert!(is_tag(&headers["cookie"]));
        assert_eq!(headers["accept"], "text/html");
        let (path, query) = redactor
            .url("http://h/api/voice/call/signalling?call=3&call_token=xyz")
            .unwrap();
        assert_eq!(path, "/api/voice/call/signalling");
        let query = query.unwrap();
        assert_eq!(query["call"], "3");
        assert!(is_tag(&query["call_token"]));
        let form =
            redactor.form("pane=p1&input=%7B%22command%22%3A%22ls%22%7D&token=zzz&tag=a&tag=b");
        assert_eq!(form["pane"], "p1");
        assert_eq!(form["input"], json!({"command": "ls"}));
        assert!(is_tag(&form["token"]));
        assert_eq!(form["tag"], json!(["a", "b"]));
        assert_eq!(
            form_pairs("a=1+2&b=%E2%9C%93&c=%zz&d"),
            vec![
                ("a".into(), "1 2".into()),
                ("b".into(), "\u{2713}".into()),
                ("c".into(), "%zz".into()),
                ("d".into(), String::new())
            ]
        );
    }

    #[test]
    fn is_off_unless_roamgate_contract_record_asks() {
        let root = || PathBuf::from("/data/roamgate");
        assert_eq!(
            contract_record_directory(&([] as [(&str, &str); 0]), root),
            None
        );
        for off in ["", "0", "off", "false", "no"] {
            assert_eq!(
                contract_record_directory(&[("ROAMGATE_CONTRACT_RECORD", off)], root),
                None
            );
        }
        for on in ["1", "on", "true", "YES"] {
            assert_eq!(
                contract_record_directory(&[("ROAMGATE_CONTRACT_RECORD", on)], root),
                Some(PathBuf::from("/data/roamgate/contract-record"))
            );
        }
        assert_eq!(
            contract_record_directory(&[("ROAMGATE_CONTRACT_RECORD", "/tmp/rec")], root),
            // Resolved: on the working directory's drive on Windows.
            Some(crate::paths::resolve(Path::new("/tmp/rec")))
        );
        // Roamgate's own name wins, even empty.
        assert_eq!(
            contract_record_directory(
                &[
                    ("ROAMGATE_CONTRACT_RECORD", ""),
                    ("HERDR_GUI_CONTRACT_RECORD", "1")
                ],
                root
            ),
            None
        );
        assert_eq!(
            contract_record_directory(&[("HERDR_GUI_CONTRACT_RECORD", "1")], root),
            Some(PathBuf::from("/data/roamgate/contract-record"))
        );
        let options = RecorderOptions::from_env(
            &[
                ("ROAMGATE_CONTRACT_RECORD", "/tmp/rec"),
                ("ROAMGATE_CONTRACT_RECORD_SEGMENT_MB", "2"),
                ("HERDR_GUI_CONTRACT_RECORD_KEEP_MB", "nope"),
            ],
            root,
            "server",
            Arc::new(|| 0),
        )
        .unwrap();
        assert_eq!(options.segment_bytes, 2 * MB);
        assert_eq!(options.keep_bytes, 1024 * MB);
    }

    fn lines(directory: &Path) -> Vec<Value> {
        let mut names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("rec-"))
            .collect();
        names.sort();
        names
            .iter()
            .flat_map(|name| {
                std::fs::read_to_string(directory.join(name))
                    .unwrap()
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect::<Vec<Value>>()
            })
            .collect()
    }

    fn recorder(directory: &Path) -> ContractRecorder {
        ContractRecorder::new(RecorderOptions::new(
            directory,
            "server",
            Arc::new(|| 1_767_323_045_678),
        ))
        .unwrap()
    }

    #[test]
    fn writes_redacted_jsonl_in_private_files_in_batches() {
        let scratch = tempfile::tempdir().unwrap();
        let directory = scratch.path().join("rec");
        let recorder = recorder(&directory);
        recorder.record(RecordInput {
            sock: Some("ws-1".into()),
            raw: Some(r#"{"id":1,"method":"auth.check","params":{"token":"abc123"}}"#.into()),
            ..RecordInput::new("ws", "in")
        });
        recorder.record(RecordInput {
            url: Some("http://h/x?token=t0k3n&a=1".into()),
            fields: Some(json!({"status": 200}).as_object().unwrap().clone()),
            ..RecordInput::new("http", "exchange")
        });
        recorder.record(RecordInput {
            sock: Some("ws-1".into()),
            raw: Some("not json".into()),
            ..RecordInput::new("ws", "out")
        });
        // Nothing written before the batch.
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        recorder.flush();
        let lines = lines(&directory);
        let (start, request, exchange, text) = (&lines[0], &lines[1], &lines[2], &lines[3]);
        assert_eq!(start["ch"], "recorder");
        assert_eq!(start["ev"], "start");
        assert_eq!(start["role"], "server");
        assert_eq!(start["v"], 1);
        assert_eq!(start["t"], "2026-01-02T03:04:05.678Z");
        assert_eq!(request["ch"], "ws");
        assert_eq!(request["sock"], "ws-1");
        assert_eq!(request["msg"]["id"], 1);
        assert_eq!(request["msg"]["method"], "auth.check");
        assert!(!request.to_string().contains("abc123"));
        assert_eq!(exchange["path"], "/x");
        assert_eq!(exchange["query"]["a"], "1");
        assert_eq!(exchange["status"], 200);
        assert!(!exchange.to_string().contains("t0k3n"));
        assert_eq!(text["msg"], json!({"text": "not json"}));
        assert!(request["seq"].as_u64() > start["seq"].as_u64());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&directory), 0o700);
            assert_eq!(mode(&recorder.stats().file), 0o600);
        }
        recorder.close();
    }

    #[test]
    fn rotates_segments_and_prunes_the_oldest_files_past_its_budget() {
        let scratch = tempfile::tempdir().unwrap();
        let directory = scratch.path();
        std::fs::write(
            directory.join("rec-20000101T000000-1-0001.jsonl"),
            "x".repeat(3000),
        )
        .unwrap();
        std::fs::write(directory.join("unrelated.txt"), "kept").unwrap();
        let recorder = ContractRecorder::new(RecorderOptions {
            segment_bytes: 1000,
            keep_bytes: 2500,
            ..RecorderOptions::new(directory, "server", Arc::new(|| 0))
        })
        .unwrap();
        for index in 0..20 {
            recorder.record(RecordInput {
                raw: Some(json!({"index": index, "pad": "y".repeat(200)}).to_string()),
                ..RecordInput::new("ws", "in")
            });
            recorder.flush();
        }
        recorder.close();
        let names: Vec<String> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"unrelated.txt".to_string()));
        assert!(!names.contains(&"rec-20000101T000000-1-0001.jsonl".to_string()));
        let recordings: Vec<&String> = names
            .iter()
            .filter(|name| name.starts_with("rec-"))
            .collect();
        assert!(recordings.len() > 1);
        let total: u64 = recordings
            .iter()
            .map(|name| std::fs::metadata(directory.join(name)).unwrap().len())
            .sum();
        assert!(total <= 2500 + 1000, "{total}");
        assert!(
            lines(directory)
                .iter()
                .any(|line| line["msg"]["index"] == 19)
        );
    }

    #[test]
    fn drops_and_counts_events_past_its_queue() {
        let scratch = tempfile::tempdir().unwrap();
        let recorder = recorder(scratch.path());
        for _ in 0..20_005 {
            recorder.record(RecordInput {
                raw: Some("{}".into()),
                ..RecordInput::new("ws", "in")
            });
        }
        recorder.flush();
        recorder.close();
        assert_eq!(recorder.stats().dropped, 5);
        let dropped = lines(scratch.path())
            .into_iter()
            .find(|line| line["ev"] == "dropped")
            .unwrap();
        assert_eq!(dropped["ch"], "recorder");
        assert_eq!(dropped["count"], 5);
    }

    #[test]
    fn ignores_events_after_close() {
        let scratch = tempfile::tempdir().unwrap();
        let recorder = recorder(scratch.path());
        recorder.close();
        recorder.record(RecordInput {
            raw: Some("{}".into()),
            ..RecordInput::new("ws", "in")
        });
        recorder.flush();
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn the_flusher_writes_a_batch_250_ms_after_the_first_event() {
        let scratch = tempfile::tempdir().unwrap();
        let clock = crate::clock::TestClock::new(0);
        let recorder = Arc::new(recorder(scratch.path()));
        let flusher = recorder.run_flusher(Arc::new(clock.clone()));
        recorder.record(RecordInput {
            raw: Some("{}".into()),
            ..RecordInput::new("ws", "in")
        });
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        clock.advance(249).await;
        assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
        clock.advance(1).await;
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        assert_eq!(lines(scratch.path()).len(), 2);
        flusher.abort();
    }
}
