//! `session-index-store.ts`: large transcripts' slim indexes kept on disk
//! (`~/.cache/roamgate/session-index`), so a restart reads only what was
//! appended since. A cache: anything not matching is built again.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::files::SessionFiles;
use crate::js::{self, Obj};

const VERSION: f64 = 1.0;
const CHECK_BYTES: u64 = 4096;

pub fn default_session_index_dir(home: &Path) -> PathBuf {
    home.join(".cache").join("roamgate").join("session-index")
}

/// An index as saved.
#[derive(Debug, Clone)]
pub struct SavedIndex {
    pub end: u64,
    pub parsed: usize,
    pub records: Vec<Obj>,
    pub aggregates: Option<(u64, Value)>,
}

async fn check_of(files: &dyn SessionFiles, path: &str, end: u64) -> std::io::Result<String> {
    let bytes = files
        .read_range(path, end.saturating_sub(CHECK_BYTES), end)
        .await?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

/// Indexes of one connection (`scope`); None `dir` keeps nothing.
pub struct SessionIndexStore {
    dir: Option<PathBuf>,
    scope: String,
    written: Mutex<HashMap<String, (usize, u64)>>,
}

impl SessionIndexStore {
    pub fn new(dir: Option<PathBuf>, scope: &str) -> Self {
        Self {
            dir,
            scope: scope.to_owned(),
            written: Mutex::new(HashMap::new()),
        }
    }

    fn key_of(&self, path: &str) -> String {
        hex::encode(Sha256::digest(format!("{}\0{path}", self.scope).as_bytes()))[..32].to_owned()
    }

    fn read_meta(&self, key: &str) -> Option<Obj> {
        let dir = self.dir.as_ref()?;
        let text = std::fs::read_to_string(dir.join(format!("{key}.json"))).ok()?;
        let Value::Object(meta) = js::parse(&text)? else {
            return None;
        };
        (meta.get("version").and_then(Value::as_f64) == Some(VERSION)).then_some(meta)
    }

    fn write_meta(&self, key: &str, meta: &Obj) -> std::io::Result<()> {
        let dir = self.dir.as_ref().unwrap();
        let file = dir.join(format!("{key}.json"));
        let temp = dir.join(format!("{key}.json.{}.tmp", std::process::id()));
        write_private(
            &temp,
            js::stringify(&Value::Object(meta.clone())).as_bytes(),
        )?;
        std::fs::rename(temp, file)
    }

    fn matches(meta: &Obj, path: &str, identity: &str) -> bool {
        js::sv(meta.get("path")) == path && js::sv(meta.get("identity")) == identity
    }

    /// The aggregates saved with the index, without reading the index.
    pub fn peek(&self, path: &str, identity: Option<&str>, size: u64) -> Option<(u64, Value)> {
        let identity = identity.filter(|i| !i.is_empty())?;
        self.dir.as_ref()?;
        let meta = self.read_meta(&self.key_of(path))?;
        let aggregates = meta.get("aggregates")?.as_object()?;
        let end = meta.get("end").and_then(Value::as_f64)? as u64;
        if !Self::matches(&meta, path, identity) || end > size {
            return None;
        }
        Some((
            aggregates.get("end").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            aggregates.get("value").cloned()?,
        ))
    }

    fn drop_key(&self, key: &str) -> Option<SavedIndex> {
        let dir = self.dir.as_ref()?;
        self.written.lock().unwrap().remove(key);
        let _ = std::fs::remove_file(dir.join(format!("{key}.json")));
        let _ = std::fs::remove_file(dir.join(format!("{key}.jsonl")));
        None
    }

    /// The index saved for the transcript, if it still matches it.
    pub async fn load(
        &self,
        files: &dyn SessionFiles,
        path: &str,
        identity: Option<&str>,
        size: u64,
    ) -> Option<SavedIndex> {
        let identity = identity.filter(|i| !i.is_empty())?;
        let dir = self.dir.clone()?;
        let key = self.key_of(path);
        let meta = self.read_meta(&key)?;
        let end = meta
            .get("end")
            .and_then(Value::as_f64)
            .unwrap_or(f64::INFINITY);
        let check = check_of(files, path, if end.is_finite() { end as u64 } else { 0 })
            .await
            .unwrap_or_default();
        if !Self::matches(&meta, path, identity)
            || end > size as f64
            || check != js::sv(meta.get("check"))
        {
            return self.drop_key(&key);
        }
        let Ok(text) = std::fs::read(dir.join(format!("{key}.jsonl"))) else {
            return self.drop_key(&key);
        };
        let bytes = meta.get("bytes").and_then(Value::as_f64).unwrap_or(0.0) as usize;
        let count = meta.get("count").and_then(Value::as_f64).unwrap_or(0.0) as usize;
        if text.len() < bytes {
            return self.drop_key(&key);
        }
        let mut records = Vec::new();
        for line in String::from_utf8_lossy(&text[..bytes]).split('\n') {
            if line.is_empty() {
                continue;
            }
            match js::parse(line) {
                Some(Value::Object(record)) => records.push(record),
                _ => return self.drop_key(&key),
            }
        }
        if records.len() != count {
            return self.drop_key(&key);
        }
        self.written
            .lock()
            .unwrap()
            .insert(key, (count, bytes as u64));
        Some(SavedIndex {
            end: end as u64,
            parsed: meta.get("parsed").and_then(Value::as_f64).unwrap_or(0.0) as usize,
            records,
            aggregates: meta.get("aggregates").and_then(Value::as_object).map(|a| {
                (
                    a.get("end").and_then(Value::as_f64).unwrap_or(0.0) as u64,
                    a.get("value").cloned().unwrap_or(Value::Null),
                )
            }),
        })
    }

    /// Saves an index: the records not on disk yet are appended.
    #[allow(clippy::too_many_arguments)]
    pub async fn save(
        &self,
        files: &dyn SessionFiles,
        path: &str,
        identity: Option<&str>,
        end: u64,
        parsed: usize,
        records: &[Obj],
        aggregates: Option<(u64, Value)>,
    ) -> std::io::Result<()> {
        let Some(identity) = identity.filter(|i| !i.is_empty()) else {
            return Ok(());
        };
        let Some(dir) = self.dir.clone() else {
            return Ok(());
        };
        let key = self.key_of(path);
        roamgate_base::private::create_dir_all_mode(&dir)?;
        let check = check_of(files, path, end).await?;
        let file = dir.join(format!("{key}.jsonl"));
        let mut on = self.written.lock().unwrap().get(&key).copied();
        if on.is_none()
            && let Some(meta) = self.read_meta(&key)
            && Self::matches(&meta, path, identity)
        {
            on = Some((
                meta.get("count").and_then(Value::as_f64).unwrap_or(0.0) as usize,
                meta.get("bytes").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            ));
        }
        let line = |record: &Obj| format!("{}\n", js::stringify(&Value::Object(record.clone())));
        let mut bytes: Option<u64> = None;
        if let Some((count, on_bytes)) = on
            && count <= records.len()
        {
            let added: String = records[count..].iter().map(line).collect();
            let length = std::fs::metadata(&file)
                .map(|m| m.len() as i64)
                .unwrap_or(-1);
            if length >= on_bytes as i64 {
                let handle = std::fs::OpenOptions::new().write(true).open(&file)?;
                if length > on_bytes as i64 {
                    handle.set_len(on_bytes)?;
                }
                drop(handle);
                if !added.is_empty() {
                    let mut handle = std::fs::OpenOptions::new().append(true).open(&file)?;
                    handle.write_all(added.as_bytes())?;
                }
                bytes = Some(on_bytes + added.len() as u64);
            }
        }
        let bytes = match bytes {
            Some(bytes) => bytes,
            None => {
                let all: String = records.iter().map(line).collect();
                let temp = dir.join(format!("{key}.jsonl.{}.tmp", std::process::id()));
                write_private(&temp, all.as_bytes())?;
                std::fs::rename(temp, &file)?;
                all.len() as u64
            }
        };
        let mut meta = Obj::new();
        meta.insert("version".into(), js::int(1));
        meta.insert("path".into(), Value::String(path.into()));
        meta.insert("identity".into(), Value::String(identity.into()));
        meta.insert("end".into(), js::int(end as i64));
        meta.insert("parsed".into(), js::int(parsed as i64));
        meta.insert("count".into(), js::int(records.len() as i64));
        meta.insert("bytes".into(), js::int(bytes as i64));
        meta.insert("check".into(), Value::String(check));
        if let Some((end, value)) = aggregates {
            meta.insert(
                "aggregates".into(),
                serde_json::json!({ "end": end, "value": value }),
            );
        }
        self.write_meta(&key, &meta)?;
        self.written
            .lock()
            .unwrap()
            .insert(key, (records.len(), bytes));
        Ok(())
    }
}

fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)
}
