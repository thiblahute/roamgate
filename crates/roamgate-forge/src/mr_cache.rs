//! The MR cache (mr-cache/cache.ts, push.ts): one cache of what the UI shows
//! of merge and pull requests, shared by every surface and client, kept in
//! `<data>/mr-cache/state.json` so that a restart does not start cold, and
//! telling the clients when an answer changes (`{"forge_cache": push}`).
//!
//! The stale-while-revalidate core is `roamgate_base::swr::SwrCache`; this
//! module adds what the cache file and the clients see: the file's format
//! (Bun's, byte for byte in shape: `{"version":1,"entries":[[key,
//! {value,fetchedAt,ttlMs,head?}]]}`), its write two seconds behind the
//! change, the TTLs by state of a chip and a card, and the pushes.
//!
//! The reads that fill it (glab and gh on the checkout's host) are not
//! here: each [`Loaded`] carries the TTL, failure and pause its reader
//! decided, so a reader may live in another process.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::SharedClock;
use roamgate_base::paths::DataContext;
pub use roamgate_base::settings::{MrCacheSettings, normalize_mr_cache_settings};
use roamgate_base::swr::{Stored, SwrAnswer, SwrCache, SwrOptions, SwrSettings};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

pub use roamgate_base::settings::DEFAULT_MR_CACHE_SETTINGS;

/// How long the write to disk waits after a change (cache.ts's 2 s).
pub const SAVE_DELAY: Duration = Duration::from_secs(2);

/// An answer as its reader gave it: the value kept, and what the reader
/// decided about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub value: Value,
    /// How long it stands; 0: never kept.
    pub ttl_ms: i64,
    /// A failure answer: not kept, and the next read waits.
    pub failed: bool,
    /// Epoch ms until which the forge asked to be left alone, when the
    /// reader said.
    pub paused_until: Option<i64>,
}

impl Loaded {
    /// An answer read back from the cache file.
    pub fn kept(value: Value, ttl_ms: i64) -> Self {
        Self {
            value,
            ttl_ms,
            failed: false,
            paused_until: None,
        }
    }
}

/// A read that failed: kept answers stay, the next read waits.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadError {
    pub message: String,
    pub paused_until: Option<i64>,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Answer = SwrAnswer<Loaded>;

/// `<data>/mr-cache/state.json`.
pub fn mr_cache_path(data_root: &Path) -> PathBuf {
    data_root.join("mr-cache").join("state.json")
}

fn finite(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    number.is_finite().then_some(number as i64)
}

/// The answers of a cache file, as cache.ts reads them: entries whose key
/// is a string and whose `fetchedAt` and `ttlMs` are finite numbers; a
/// broken file gives none.
pub fn parse_state(text: &str) -> Vec<(String, Stored<Loaded>)> {
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in raw
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some([key, stored]) = entry.as_array().map(Vec::as_slice) else {
            continue;
        };
        let (Some(key), Some(stored)) = (key.as_str(), stored.as_object()) else {
            continue;
        };
        let (Some(fetched_at), Some(ttl_ms)) =
            (finite(stored.get("fetchedAt")), finite(stored.get("ttlMs")))
        else {
            continue;
        };
        let value = stored.get("value").cloned().unwrap_or(Value::Null);
        out.push((
            key.to_owned(),
            Stored {
                value: Loaded::kept(value, ttl_ms),
                fetched_at,
                ttl_ms,
                head: stored
                    .get("head")
                    .and_then(Value::as_str)
                    .filter(|head| !head.is_empty())
                    .map(str::to_owned),
            },
        ));
    }
    out
}

/// The cache file's text for these answers (oldest read first).
pub fn state_json(entries: &[(String, Stored<Loaded>)]) -> String {
    let mut sorted: Vec<&(String, Stored<Loaded>)> = entries.iter().collect();
    sorted.sort_by(|a, b| {
        a.1.fetched_at
            .cmp(&b.1.fetched_at)
            .then_with(|| a.0.cmp(&b.0))
    });
    let entries: Vec<Value> = sorted
        .into_iter()
        .map(|(key, stored)| {
            let mut entry = Map::new();
            entry.insert("value".into(), stored.value.value.clone());
            entry.insert("fetchedAt".into(), stored.fetched_at.into());
            entry.insert("ttlMs".into(), stored.ttl_ms.into());
            if let Some(head) = &stored.head {
                entry.insert("head".into(), head.clone().into());
            }
            json!([key, entry])
        })
        .collect();
    format!("{}\n", json!({ "version": 1, "entries": entries }))
}

/// `new Date(ms).toISOString()`.
pub fn iso_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// The push for a change (push.ts), None for what no client shows. The
/// checkout's host stays on the server: a client compares what the answer
/// itself says.
pub fn mr_cache_push(key: &str, value: &Value, fetched_at: i64) -> Option<Value> {
    let kind = key.split('\0').next().unwrap_or("");
    if !value.is_object() {
        return None;
    }
    match kind {
        "chip" => Some(json!({ "kind": "status", "status": value })),
        "card" => Some(json!({
            "kind": "card",
            "status": value,
            "fetchedAt": iso_time(fetched_at),
        })),
        "session" => Some(json!({ "kind": "session", "session": value })),
        _ => None,
    }
}

fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut at = value;
    for part in path {
        at = at.get(part)?;
    }
    at.as_str()
}

/// How long a chip's answer stands (review/forge.ts `forgeCacheTtl`).
pub fn forge_cache_ttl(status: &Value, settings: &MrCacheSettings) -> i64 {
    match text(status, &["state"]).unwrap_or("") {
        "error" => 0,
        "not_signed_in" | "unavailable" => settings.unavailable_ms,
        "security" => settings.settled_ms,
        "not_found" => settings.none_ms,
        _ => {
            let Some(request) = status.get("request").filter(|r| r.is_object()) else {
                return settings.none_ms;
            };
            let state = text(request, &["state"]).unwrap_or("");
            if state != "open" && state != "locked" {
                return settings.settled_ms;
            }
            match text(request, &["pipeline", "status"]) {
                Some("running" | "pending") => settings.running_ms,
                _ => settings.open_ms,
            }
        }
    }
}

/// How long a card's answer stands (workspace/pull-request.ts
/// `cardAnswerTtl`).
pub fn card_answer_ttl(status: &Value, settings: &MrCacheSettings) -> i64 {
    let state = text(status, &["state"]).unwrap_or("");
    if state == "error" || status.get("retryable") == Some(&Value::Bool(true)) {
        return 0;
    }
    match state {
        "ready" => {
            let Some(request) = status.get("request").filter(|r| !r.is_null()) else {
                return settings.none_ms;
            };
            if !matches!(
                text(request, &["state"]).unwrap_or(""),
                "open" | "opened" | "locked"
            ) {
                return settings.settled_ms;
            }
            let ci = text(status, &["ci"]).unwrap_or("").to_ascii_lowercase();
            if [
                "running", "pending", "progress", "queued", "waiting", "created",
            ]
            .iter()
            .any(|word| ci.contains(word))
            {
                settings.running_ms
            } else {
                settings.open_ms
            }
        }
        "no_match" | "detached" => settings.none_ms,
        "select_match" | "select_remote" => settings.open_ms,
        _ => settings.unavailable_ms,
    }
}

/// Where and whether the cache writes its file.
pub struct Persist {
    pub context: DataContext,
    pub path: PathBuf,
    /// Asked before each write: false once the cache's family is not owned.
    pub may_write: Arc<dyn Fn() -> bool + Send + Sync>,
    pub delay: Duration,
}

type Publish = Arc<dyn Fn(Value) + Send + Sync>;

struct Writer {
    persist: Persist,
    notify: Notify,
    dirty: AtomicBool,
    closed: AtomicBool,
    /// One write at a time, flush or behind.
    writing: tokio::sync::Mutex<()>,
}

/// The MR cache.
#[derive(Clone)]
pub struct MrCache {
    swr: SwrCache<Loaded, LoadError>,
    settings: Arc<Mutex<MrCacheSettings>>,
    writer: Option<Arc<Writer>>,
}

impl MrCache {
    /// A cache reading its answers from `persist`'s file (none: in memory
    /// only), telling `publish` each `{"forge_cache": push}`. With a file,
    /// it must be made inside a tokio runtime (its writer is a task).
    pub fn open(clock: SharedClock, persist: Option<Persist>, publish: Option<Publish>) -> Self {
        let settings = Arc::new(Mutex::new(DEFAULT_MR_CACHE_SETTINGS));
        let writer = persist.map(|persist| {
            Arc::new(Writer {
                persist,
                notify: Notify::new(),
                dirty: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                writing: tokio::sync::Mutex::new(()),
            })
        });
        let swr_settings = {
            let settings = settings.clone();
            move || {
                let settings = *settings.lock().unwrap();
                SwrSettings {
                    budget_per_minute: settings.budget_per_minute.max(0) as usize,
                    max_entries: settings.max_entries.max(0) as usize,
                }
            }
        };
        let on_change: Option<Arc<dyn Fn() + Send + Sync>> = writer.clone().map(|writer| {
            Arc::new(move || {
                writer.dirty.store(true, Ordering::SeqCst);
                writer.notify.notify_one();
            }) as Arc<dyn Fn() + Send + Sync>
        });
        let publish_hook = publish.map(|publish| {
            Arc::new(move |key: &str, loaded: &Loaded, fetched_at: i64| {
                if let Some(push) = mr_cache_push(key, &loaded.value, fetched_at) {
                    publish(json!({ "forge_cache": push }));
                }
            }) as roamgate_base::swr::Publish<Loaded>
        });
        let swr = SwrCache::with_hooks(clock.clone(), swr_settings, publish_hook, on_change);
        if let Some(writer) = &writer {
            if let Ok(text) = std::fs::read_to_string(&writer.persist.path) {
                swr.restore(parse_state(&text));
            }
            let task_writer = writer.clone();
            let task_swr = swr.clone();
            tokio::spawn(async move {
                loop {
                    task_writer.notify.notified().await;
                    if task_writer.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    clock.sleep(task_writer.persist.delay).await;
                    if task_writer.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    write(&task_writer, &task_swr).await;
                }
            });
        }
        Self {
            swr,
            settings,
            writer,
        }
    }

    /// The settings the TTLs, budget and cap follow (`mr_cache` in
    /// settings.json, normalised).
    pub fn set_settings(&self, settings: MrCacheSettings) {
        *self.settings.lock().unwrap() = settings;
    }

    pub fn settings(&self) -> MrCacheSettings {
        *self.settings.lock().unwrap()
    }

    /// See [`SwrCache::get`].
    pub async fn get(
        &self,
        key: &str,
        options: &SwrOptions<Loaded, LoadError>,
    ) -> Result<Answer, LoadError> {
        self.swr.get(key, options).await
    }

    pub fn peek(&self, key: &str) -> Option<Answer> {
        self.swr.peek(key)
    }

    pub fn invalidate(&self, matches: impl Fn(&str) -> bool) {
        self.swr.invalidate(matches)
    }

    pub fn len(&self) -> usize {
        self.swr.len()
    }

    pub fn is_empty(&self) -> bool {
        self.swr.is_empty()
    }

    pub fn entries(&self) -> Vec<(String, Stored<Loaded>)> {
        self.swr.entries()
    }

    /// Writes now when something changed since the last write.
    pub async fn flush(&self) {
        if let Some(writer) = &self.writer {
            write(writer, &self.swr).await;
        }
    }

    /// Writes what changed, then never again (the family was given away).
    pub async fn close(&self) {
        if let Some(writer) = &self.writer {
            write(writer, &self.swr).await;
            writer.closed.store(true, Ordering::SeqCst);
            writer.notify.notify_one();
        }
    }
}

/// Options for a key whose reader decided TTL, failure and pause:
/// `known_paused` is the pause the reader gives for the known answer.
pub fn reader_options(
    load: impl Fn() -> roamgate_base::clock::BoxFuture<Result<Loaded, LoadError>>
    + Send
    + Sync
    + 'static,
    fresh: bool,
    head: Option<Option<String>>,
    known_paused: i64,
) -> SwrOptions<Loaded, LoadError> {
    let error_paused = Arc::new(Mutex::new(None::<i64>));
    let load = {
        let error_paused = error_paused.clone();
        let load = Arc::new(load);
        Arc::new(move || {
            let load = load.clone();
            let error_paused = error_paused.clone();
            Box::pin(async move {
                let result = load().await;
                if let Err(error) = &result {
                    *error_paused.lock().unwrap() = error.paused_until;
                }
                result
            }) as roamgate_base::clock::BoxFuture<Result<Loaded, LoadError>>
        })
    };
    SwrOptions {
        ttl: Arc::new(|loaded: &Loaded| loaded.ttl_ms),
        load,
        fresh,
        failed: Some(Arc::new(|loaded: &Loaded| loaded.failed)),
        paused_until: Some(Arc::new(move |loaded: Option<&Loaded>| match loaded {
            Some(loaded) => loaded.paused_until.unwrap_or(known_paused),
            None => error_paused.lock().unwrap().unwrap_or(known_paused),
        })),
        head: head.map(|head| {
            Arc::new(move || {
                let head = head.clone();
                Box::pin(async move { head }) as roamgate_base::clock::BoxFuture<Option<String>>
            }) as roamgate_base::swr::HeadFn
        }),
    }
}

async fn write(writer: &Writer, swr: &SwrCache<Loaded, LoadError>) {
    let _one = writer.writing.lock().await;
    if !writer.dirty.swap(false, Ordering::SeqCst) || writer.closed.load(Ordering::SeqCst) {
        return;
    }
    if !(writer.persist.may_write)() {
        return;
    }
    let text = state_json(&swr.entries());
    let path = &writer.persist.path;
    if let Some(parent) = path.parent() {
        let _ = roamgate_base::private::create_dir_all_mode(parent);
    }
    // The cache is only a speed up: a failed write is forgotten.
    if let Err(error) = writer
        .persist
        .context
        .replace_data_file_async(path, text.into_bytes(), 0o600)
        .await
    {
        tracing::debug!(scope = "mr-cache", %error, "cache not written");
    }
}

#[cfg(test)]
mod tests;
