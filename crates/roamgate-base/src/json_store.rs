//! `AtomicJsonStore<T>` (the plan's section 6.6): one JSON file of the data
//! root, loaded with its version checked and its value normalised, written
//! through a synced temporary file renamed over it, 0600, and optionally
//! behind: a burst of changes is written once, `delay` after the first.
//!
//! [`js_key_order`] orders an object's keys as JavaScript does (array
//! indexes first, ascending, then the others in insertion order), so a value
//! read by `JSON.parse` and written back by the Bun server and by this
//! store are the same bytes.

use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::clock::SharedClock;
use crate::paths::DataContext;

/// A stored type: its current version and how it is normalised on load.
pub trait Versioned: Serialize + DeserializeOwned + Send + Sync + 'static {
    /// The version this code writes (the file's `version` field).
    const VERSION: u64;

    /// Brings an older file's value up to [`Self::VERSION`]; refuses by
    /// default.
    fn upgrade(value: Value, from: u64) -> Result<Value, String> {
        let _ = value;
        Err(format!("unsupported version {from}"))
    }

    /// Fills defaults in and drops invalid values after loading.
    fn normalize(self) -> Self {
        self
    }
}

/// How the file is written; both end with a newline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonFormat {
    /// `JSON.stringify(value)`.
    Compact,
    /// `JSON.stringify(value, null, 2)`.
    Pretty,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid JSON in {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("{path} has version {found}; this Roamgate reads up to {supported}")]
    Newer {
        path: PathBuf,
        found: u64,
        supported: u64,
    },
    #[error("{path}: {message}")]
    Invalid { path: PathBuf, message: String },
}

/// The value with every object's keys in JavaScript's order.
pub fn js_key_order(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(js_key_order).collect()),
        Value::Object(map) => {
            let is_index = |key: &str| {
                key == "0"
                    || (!key.is_empty()
                        && !key.starts_with('0')
                        && key.len() <= 10
                        && key.bytes().all(|byte| byte.is_ascii_digit())
                        && key
                            .parse::<u64>()
                            .is_ok_and(|index| index < u32::MAX as u64))
            };
            let mut indexes: Vec<(u64, String, Value)> = Vec::new();
            let mut others = serde_json::Map::new();
            for (key, value) in map {
                if is_index(&key) {
                    indexes.push((key.parse().unwrap_or(0), key, js_key_order(value)));
                } else {
                    others.insert(key, js_key_order(value));
                }
            }
            indexes.sort_by_key(|(index, _, _)| *index);
            let mut out = serde_json::Map::new();
            for (_, key, value) in indexes {
                out.insert(key, value);
            }
            out.extend(others);
            Value::Object(out)
        }
        other => other,
    }
}

/// The text the Bun server writes for `value`: JavaScript's key order, the
/// format's layout, then a newline.
pub fn to_js_json(value: &impl Serialize, format: JsonFormat) -> serde_json::Result<String> {
    let value = js_key_order(serde_json::to_value(value)?);
    let mut text = match format {
        JsonFormat::Compact => serde_json::to_string(&value)?,
        JsonFormat::Pretty => serde_json::to_string_pretty(&value)?,
    };
    text.push('\n');
    Ok(text)
}

/// One JSON file.
#[derive(Debug, Clone)]
pub struct AtomicJsonStore<T> {
    context: DataContext,
    path: PathBuf,
    format: JsonFormat,
    _value: PhantomData<fn() -> T>,
}

impl<T: Versioned> AtomicJsonStore<T> {
    pub fn new(context: DataContext, path: impl Into<PathBuf>, format: JsonFormat) -> Self {
        Self {
            context,
            path: path.into(),
            format,
            _value: PhantomData,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored value; None when there is no file.
    pub fn load(&self) -> Result<Option<T>, StoreError> {
        self.context.assert_safe_data_path(&self.path)?;
        let text = match std::fs::read(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let parse = |source| StoreError::Parse {
            path: self.path.clone(),
            source,
        };
        let mut value: Value = serde_json::from_slice(&text).map_err(parse)?;
        let found = value
            .get("version")
            .and_then(Value::as_u64)
            .ok_or_else(|| StoreError::Invalid {
                path: self.path.clone(),
                message: "no version".into(),
            })?;
        if found > T::VERSION {
            return Err(StoreError::Newer {
                path: self.path.clone(),
                found,
                supported: T::VERSION,
            });
        }
        if found < T::VERSION {
            value = T::upgrade(value, found).map_err(|message| StoreError::Invalid {
                path: self.path.clone(),
                message,
            })?;
        }
        let loaded: T = serde_json::from_value(value).map_err(parse)?;
        Ok(Some(loaded.normalize()))
    }

    /// Writes `value` atomically, 0600.
    pub fn save(&self, value: &T) -> Result<(), StoreError> {
        let text = to_js_json(value, self.format).map_err(|source| StoreError::Parse {
            path: self.path.clone(),
            source,
        })?;
        self.context
            .replace_data_file(&self.path, text.as_bytes(), 0o600)?;
        Ok(())
    }

    /// [`Self::save`] off the async runtime's threads.
    pub async fn save_async(&self, value: &T) -> Result<(), StoreError> {
        let text = to_js_json(value, self.format).map_err(|source| StoreError::Parse {
            path: self.path.clone(),
            source,
        })?;
        self.context
            .replace_data_file_async(&self.path, text.into_bytes(), 0o600)
            .await?;
        Ok(())
    }
}

#[derive(Default)]
struct Pending {
    contents: Option<Vec<u8>>,
    scheduled: bool,
}

#[derive(Default)]
struct Behind {
    pending: Mutex<Pending>,
    /// Held across a write: one at a time, each taking the newest
    /// contents, so an older write never lands after a newer one.
    writing: Mutex<()>,
}

/// One private file written behind and off the async runtime's threads:
/// [`Self::schedule`] keeps the newest contents and writes them through
/// [`DataContext::replace_data_file`] on a blocking thread, `delay` after
/// the first unwritten change (at once with a zero delay); changes made
/// while a write runs are written once, after it. [`Self::flush`] writes
/// what is kept now, and so does dropping it (at shutdown). The owner
/// keeps its value in memory: what it reads back is its own, not the
/// file.
pub struct WriteBehindFile {
    context: DataContext,
    path: PathBuf,
    mode: u32,
    clock: SharedClock,
    delay: Duration,
    behind: Arc<Behind>,
    /// Told a write behind that failed; None: a `tracing` warning.
    failed: Option<WriteFailed>,
}

/// What a [`WriteBehindFile`] says of a write behind that failed.
pub type WriteFailed = Arc<dyn Fn(&std::io::Error) + Send + Sync>;

impl WriteBehindFile {
    pub fn new(
        context: DataContext,
        path: impl Into<PathBuf>,
        mode: u32,
        clock: SharedClock,
        delay: Duration,
    ) -> Self {
        Self {
            context,
            path: path.into(),
            mode,
            clock,
            delay,
            behind: Arc::default(),
            failed: None,
        }
    }

    /// Says a failed write behind with `failed` (the owner's own warning).
    pub fn on_failure(mut self, failed: WriteFailed) -> Self {
        self.failed = Some(failed);
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Keeps `contents` to be written. Outside a tokio runtime they are
    /// written now.
    pub fn schedule(&self, contents: Vec<u8>) {
        let mut pending = self.behind.pending.lock().expect("pending");
        pending.contents = Some(contents);
        if pending.scheduled {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            drop(pending);
            self.write_now();
            return;
        };
        pending.scheduled = true;
        let sleep = (!self.delay.is_zero()).then(|| self.clock.sleep(self.delay));
        let write = self.writer();
        runtime.spawn(async move {
            if let Some(sleep) = sleep {
                sleep.await;
            }
            let _ = tokio::task::spawn_blocking(write).await;
        });
    }

    /// Writes the contents kept, if any, now.
    pub fn flush(&self) -> std::io::Result<()> {
        write_newest(&self.context, &self.path, self.mode, &self.behind)
    }

    /// [`Self::flush`] off the async runtime's threads.
    pub async fn flush_async(&self) -> std::io::Result<()> {
        let (context, path, mode, behind) = (
            self.context.clone(),
            self.path.clone(),
            self.mode,
            self.behind.clone(),
        );
        tokio::task::spawn_blocking(move || write_newest(&context, &path, mode, &behind))
            .await
            .map_err(std::io::Error::other)?
    }

    fn writer(&self) -> impl FnOnce() + Send + 'static {
        let (context, path, mode, behind) = (
            self.context.clone(),
            self.path.clone(),
            self.mode,
            self.behind.clone(),
        );
        let failed = self.failed.clone();
        move || {
            if let Err(error) = write_newest(&context, &path, mode, &behind) {
                match failed {
                    Some(failed) => failed(&error),
                    None => {
                        tracing::warn!(path = %path.display(), %error, "write-behind save failed")
                    }
                }
            }
        }
    }

    fn write_now(&self) {
        (self.writer())();
    }
}

impl Drop for WriteBehindFile {
    fn drop(&mut self) {
        let pending = self
            .behind
            .pending
            .lock()
            .expect("pending")
            .contents
            .is_some();
        if pending {
            self.write_now();
        }
    }
}

fn write_newest(
    context: &DataContext,
    path: &Path,
    mode: u32,
    behind: &Behind,
) -> std::io::Result<()> {
    let _writing = behind.writing.lock().expect("writing");
    let contents = {
        let mut pending = behind.pending.lock().expect("pending");
        pending.scheduled = false;
        pending.contents.take()
    };
    match contents {
        Some(contents) => context.replace_data_file(path, &contents, mode),
        None => Ok(()),
    }
}

/// An [`AtomicJsonStore`] written behind, through a [`WriteBehindFile`]:
/// [`Self::schedule`] keeps the newest value and writes it `delay` after
/// the first unwritten change; [`Self::flush`] writes it now (at shutdown).
pub struct WriteBehind<T: Versioned + Clone> {
    store: AtomicJsonStore<T>,
    file: WriteBehindFile,
}

impl<T: Versioned + Clone> WriteBehind<T> {
    pub fn new(store: AtomicJsonStore<T>, clock: SharedClock, delay: Duration) -> Self {
        let file = WriteBehindFile::new(
            store.context.clone(),
            store.path.clone(),
            0o600,
            clock,
            delay,
        );
        Self { store, file }
    }

    pub fn store(&self) -> &AtomicJsonStore<T> {
        &self.store
    }

    /// Keeps `value` to be written; outside a tokio runtime it is written
    /// now.
    pub fn schedule(&self, value: T) {
        match to_js_json(&value, self.store.format) {
            Ok(text) => self.file.schedule(text.into_bytes()),
            Err(error) => {
                tracing::warn!(path = %self.store.path().display(), %error, "write-behind value not serialisable");
            }
        }
    }

    /// Writes the value kept, if any, now.
    pub fn flush(&self) -> Result<(), StoreError> {
        Ok(self.file.flush()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TokioClock;
    use crate::paths::Platform;
    use serde::Deserialize;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct Leases {
        version: u64,
        #[serde(default)]
        names: Vec<String>,
    }

    impl Versioned for Leases {
        const VERSION: u64 = 2;

        fn upgrade(mut value: Value, from: u64) -> Result<Value, String> {
            if from != 1 {
                return Err(format!("unsupported version {from}"));
            }
            value["version"] = 2.into();
            Ok(value)
        }

        fn normalize(mut self) -> Self {
            self.names.retain(|name| !name.is_empty());
            self
        }
    }

    fn store(dir: &Path) -> AtomicJsonStore<Leases> {
        let context = DataContext::new(dir, Platform::Unix, None);
        AtomicJsonStore::new(
            context,
            dir.join("roamgate/leases.json"),
            JsonFormat::Pretty,
        )
    }

    #[test]
    fn loads_upgrades_normalises_and_refuses_newer_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        assert_eq!(store.load().unwrap(), None);
        store
            .save(&Leases {
                version: 2,
                names: vec!["a".into()],
            })
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(store.path()).unwrap(),
            "{\n  \"version\": 2,\n  \"names\": [\n    \"a\"\n  ]\n}\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::write(store.path(), r#"{"version":1,"names":["b",""]}"#).unwrap();
        assert_eq!(
            store.load().unwrap(),
            Some(Leases {
                version: 2,
                names: vec!["b".into()]
            })
        );
        std::fs::write(store.path(), r#"{"version":3}"#).unwrap();
        assert!(matches!(
            store.load(),
            Err(StoreError::Newer { found: 3, .. })
        ));
        std::fs::write(store.path(), r#"{"version":0}"#).unwrap();
        assert!(matches!(store.load(), Err(StoreError::Invalid { .. })));
        std::fs::write(store.path(), "{broken").unwrap();
        assert!(matches!(store.load(), Err(StoreError::Parse { .. })));
    }

    #[test]
    fn keys_are_written_in_javascripts_order() {
        let value: Value =
            serde_json::from_str(r#"{"b":1,"10":2,"a":{"2":0,"01":1,"1":2},"0":3}"#).unwrap();
        assert_eq!(
            to_js_json(&value, JsonFormat::Compact).unwrap(),
            "{\"0\":3,\"10\":2,\"b\":1,\"a\":{\"1\":2,\"2\":0,\"01\":1}}\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn write_behind_writes_the_newest_value_once() {
        let dir = tempfile::tempdir().unwrap();
        let clock: SharedClock = Arc::new(TokioClock::starting_at(0));
        let behind = WriteBehind::new(
            store(dir.path()),
            clock.clone(),
            Duration::from_millis(2_000),
        );
        for name in ["a", "b", "c"] {
            behind.schedule(Leases {
                version: 2,
                names: vec![name.into()],
            });
        }
        clock.sleep(Duration::from_millis(1_000)).await;
        assert!(!behind.store().path().exists());
        clock.sleep(Duration::from_millis(1_500)).await;
        for _ in 0..50 {
            if behind.store().path().exists() {
                break;
            }
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        assert_eq!(behind.store().load().unwrap().unwrap().names, vec!["c"]);
        behind.schedule(Leases {
            version: 2,
            names: vec!["d".into()],
        });
        behind.flush().unwrap();
        assert_eq!(behind.store().load().unwrap().unwrap().names, vec!["d"]);
    }

    fn behind_file(dir: &Path, clock: SharedClock) -> WriteBehindFile {
        let context = DataContext::new(dir, Platform::Unix, None);
        WriteBehindFile::new(
            context,
            dir.join("roamgate/raw.json"),
            0o600,
            clock,
            Duration::ZERO,
        )
    }

    #[tokio::test(start_paused = true)]
    async fn a_file_behind_ends_with_the_newest_bytes_written_last() {
        let dir = tempfile::tempdir().unwrap();
        let file = behind_file(dir.path(), Arc::new(TokioClock::starting_at(0)));
        for at in 0..50 {
            file.schedule(format!("[{at}]").into_bytes());
            if at % 7 == 0 {
                tokio::task::yield_now().await;
            }
        }
        file.flush_async().await.unwrap();
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "[49]");
        // The writes still queued find nothing newer to write.
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "[49]");
    }

    #[tokio::test(start_paused = true)]
    async fn a_file_behind_is_written_when_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let file = behind_file(dir.path(), Arc::new(TokioClock::starting_at(0)));
        let path = file.path().to_owned();
        file.schedule(b"last".to_vec());
        drop(file);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "last");
    }

    #[test]
    fn a_file_behind_is_written_at_once_outside_a_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let file = behind_file(dir.path(), Arc::new(crate::clock::SystemClock));
        file.schedule(b"now".to_vec());
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "now");
    }
}
