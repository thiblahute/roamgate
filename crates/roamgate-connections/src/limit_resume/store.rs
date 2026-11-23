//! What is kept of the sessions a usage limit paused, across restarts
//! (server/src/limit-resume/store.ts): `<data>/limit-resume.json`,
//! `{"version": 1, "sessions": {<session id>: record}}`, written whole as
//! the TS side writes it (two-space JSON and a newline, 0600, by rename).
//!
//! A record keeps its keys in the order they were set, and the sessions
//! the order they last changed in (the oldest are dropped first past
//! [`MAX_SESSIONS`]), so the file is the TS side's byte for byte.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use roamgate_base::log::iso_millis;
use roamgate_base::paths::DataContext;
use serde_json::{Map, Value, json};

pub const MAX_SESSIONS: usize = 2000;

/// May this process write the file now (the family's owner)? An error
/// says why not.
pub type CanWrite = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// Where the store's changes go.
#[derive(Clone)]
pub enum StoreFile {
    /// The file, written when `can_write` allows it.
    File {
        path: PathBuf,
        context: DataContext,
        can_write: CanWrite,
    },
    /// Read from `path` (if any) but never written: changes stay in memory
    /// (a shadow read of a family this side does not own, and tests).
    ReadOnly(Option<PathBuf>),
}

impl StoreFile {
    fn path(&self) -> Option<&PathBuf> {
        match self {
            Self::File { path, .. } => Some(path),
            Self::ReadOnly(path) => path.as_ref(),
        }
    }
}

type Record = Map<String, Value>;

/// The sessions a usage limit paused (createLimitResumeStore). Clones
/// share it.
#[derive(Clone)]
pub struct LimitResumeStore {
    file: StoreFile,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    sessions: Arc<Mutex<Option<IndexMap<String, Record>>>>,
}

impl LimitResumeStore {
    pub fn new(file: StoreFile, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            file,
            now,
            sessions: Arc::default(),
        }
    }

    fn with<T>(&self, run: impl FnOnce(&mut IndexMap<String, Record>) -> T) -> T {
        let mut sessions = self.sessions.lock().unwrap();
        let all = sessions.get_or_insert_with(|| {
            let mut all = IndexMap::new();
            let Some(path) = self.file.path() else {
                return all;
            };
            let Ok(text) = std::fs::read_to_string(path) else {
                return all;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                return all;
            };
            if let Some(Value::Object(stored)) = parsed.get("sessions") {
                for (id, record) in stored {
                    if let Value::Object(record) = record {
                        all.insert(id.clone(), record.clone());
                    }
                }
            }
            all
        });
        run(all)
    }

    fn save(&self, all: &mut IndexMap<String, Record>) -> Result<(), String> {
        let StoreFile::File {
            path,
            context,
            can_write,
        } = &self.file
        else {
            return Ok(());
        };
        can_write()?;
        while all.len() > MAX_SESSIONS {
            all.shift_remove_index(0);
        }
        let sessions: Map<String, Value> = all
            .iter()
            .map(|(id, record)| (id.clone(), Value::Object(record.clone())))
            .collect();
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({"version": 1, "sessions": sessions})).unwrap()
        );
        context
            .replace_data_file(path, text.as_bytes(), 0o600)
            .map_err(|error| format!("cannot write {}: {error}", path.display()))
    }

    fn change(&self, session_id: &str, update: impl FnOnce(&mut Record)) -> Result<(), String> {
        let at = iso_millis((self.now)());
        self.with(|all| {
            let mut next = all
                .get(session_id)
                .cloned()
                .unwrap_or_else(|| Map::from_iter([("at".to_owned(), json!(""))]));
            update(&mut next);
            next.insert("at".into(), json!(at));
            // Most recent last, so the oldest go first past MAX_SESSIONS.
            all.shift_remove(session_id);
            let empty = !next.contains_key("seen")
                && !next.contains_key("resumed")
                && !next.get("skip").is_some_and(truthy);
            if !empty {
                all.insert(session_id.into(), next);
            }
            self.save(all)
        })
    }

    /// Forgets what was read: the next use reads the file again (a side
    /// that does not own the family follows the owner's writes).
    pub fn reload(&self) {
        *self.sessions.lock().unwrap() = None;
    }

    /// The session's record, if any.
    pub fn get(&self, session_id: &str) -> Option<Record> {
        self.with(|all| all.get(session_id).cloned())
    }

    /// A pause by the limit resetting at `resets_at`, seen in time.
    pub fn seen(&self, session_id: &str, resets_at: i64) -> Result<(), String> {
        if self
            .get(session_id)
            .and_then(|record| record.get("seen").and_then(Value::as_f64))
            == Some(resets_at as f64)
        {
            return Ok(());
        }
        self.change(session_id, |record| {
            record.insert("seen".into(), json!(resets_at));
        })
    }

    /// A resume was sent for the limit resetting at `resets_at`.
    pub fn resumed(&self, session_id: &str, resets_at: i64) -> Result<(), String> {
        let at = iso_millis((self.now)());
        self.change(session_id, |record| {
            record.insert("resumed".into(), json!(resets_at));
            record.insert("resumed_at".into(), json!(at));
        })
    }

    /// "Don't resume" for a session (true), or resumed again (false).
    pub fn set_skip(&self, session_id: &str, skip: bool) -> Result<(), String> {
        let current = self
            .get(session_id)
            .and_then(|record| record.get("skip").cloned())
            .is_some_and(|value| truthy(&value));
        if current == skip {
            return Ok(());
        }
        self.change(session_id, |record| {
            if skip {
                record.insert("skip".into(), json!(true));
            } else {
                record.shift_remove("skip");
            }
        })
    }
}

/// JS truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_store(dir: &std::path::Path, allowed: bool) -> (LimitResumeStore, PathBuf) {
        let path = dir.join("limit-resume.json");
        let store = LimitResumeStore::new(
            StoreFile::File {
                path: path.clone(),
                context: DataContext::new(dir, roamgate_base::paths::Platform::current(), None),
                can_write: Arc::new(move || {
                    if allowed {
                        Ok(())
                    } else {
                        Err("rust does not own the limit_resume family".into())
                    }
                }),
            },
            Arc::new(|| 1_794_026_400_000),
        );
        (store, path)
    }

    #[test]
    fn writes_the_file_as_the_ts_store_does() {
        let dir = tempfile::tempdir().unwrap();
        let (store, path) = file_store(dir.path(), true);
        store.seen("a", 10).unwrap();
        store.resumed("a", 10).unwrap();
        store.set_skip("b", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"version\": 1,\n  \"sessions\": {\n    \"a\": {\n      \"at\": \"2026-11-07T04:40:00.000Z\",\n      \"seen\": 10,\n      \"resumed\": 10,\n      \"resumed_at\": \"2026-11-07T04:40:00.000Z\"\n    },\n    \"b\": {\n      \"at\": \"2026-11-07T04:40:00.000Z\",\n      \"skip\": true\n    }\n  }\n}\n"
        );
        // Undone: an empty record goes; a reload reads what was written.
        store.set_skip("b", false).unwrap();
        let (again, _) = file_store(dir.path(), true);
        assert!(again.get("b").is_none());
        assert_eq!(again.get("a").unwrap()["seen"], 10);
    }

    #[test]
    fn a_side_that_does_not_own_the_family_never_writes() {
        let dir = tempfile::tempdir().unwrap();
        let (store, path) = file_store(dir.path(), false);
        assert!(store.seen("a", 10).is_err());
        assert!(!path.exists());
        let read_only = LimitResumeStore::new(StoreFile::ReadOnly(None), Arc::new(|| 0));
        read_only.set_skip("a", true).unwrap();
        assert_eq!(read_only.get("a").unwrap()["skip"], true);

        // A reader follows the owner's writes once it reloads.
        let (owner, path) = file_store(dir.path(), true);
        owner.seen("b", 10).unwrap();
        let reader = LimitResumeStore::new(StoreFile::ReadOnly(Some(path)), Arc::new(|| 0));
        assert!(reader.get("c").is_none());
        owner.seen("c", 11).unwrap();
        assert!(reader.get("c").is_none());
        reader.reload();
        assert_eq!(reader.get("c").unwrap()["seen"], 11);
        reader.set_skip("c", true).unwrap();
        let again = LimitResumeStore::new(
            StoreFile::ReadOnly(Some(dir.path().join("limit-resume.json"))),
            Arc::new(|| 0),
        );
        assert!(again.get("c").unwrap().get("skip").is_none());
    }
}
