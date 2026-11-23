//! What the pages of each listed site keep in `localStorage`, per site
//! (rendered-storage.ts): the pages' sandbox has no storage of its own, so
//! the server keeps it and writes it into each page it serves, where the
//! helper's shim reads it. A small JSON file under Roamgate's data
//! directory (`rendered-storage.json`), written whole and atomically after
//! each change, bounded per site and in the number of sites.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_base::paths::DataContext;
use serde_json::Value;
use tokio::sync::Notify;

use super::js;

/// shared/renderedPage.ts RENDERED_STORAGE_MAX_CHARS.
pub const RENDERED_STORAGE_MAX_CHARS: usize = 256 * 1024;
/// shared/renderedPage.ts RENDERED_STORAGE_MAX_KEYS.
pub const RENDERED_STORAGE_MAX_KEYS: usize = 200;
pub const RENDERED_STORAGE_MAX_SITES: usize = 100;

/// A write of a page to its site's storage (RenderedStorageWrite).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageWrite {
    Set { key: String, value: String },
    Remove { key: String },
    Clear,
}

/// A write over the bounds; its name is the DOM's `QuotaExceededError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the site's storage is full")]
pub struct StorageQuotaError;

impl StorageQuotaError {
    pub const NAME: &'static str = "QuotaExceededError";
}

type Items = Vec<(String, String)>;

#[derive(Default)]
struct Inner {
    /// Sites and their items, in insertion order (the TS Maps').
    sites: Vec<(String, Items)>,
    dirty: bool,
    writing: bool,
}

impl Inner {
    fn site(&self, site: &str) -> Option<usize> {
        self.sites.iter().position(|(name, _)| name == site)
    }
}

/// Where the storage is kept on disk.
struct Disk {
    context: DataContext,
    file: PathBuf,
}

/// The sites' storage; in memory only when made by [`SiteStorage::in_memory`].
pub struct SiteStorage {
    inner: Mutex<Inner>,
    disk: Option<Disk>,
    written: Notify,
}

/// `<data root>/rendered-storage.json`.
pub fn rendered_storage_path(data_root: &Path) -> PathBuf {
    data_root.join("rendered-storage.json")
}

fn chars(items: &Items) -> usize {
    items
        .iter()
        .map(|(key, value)| js::length(key) + js::length(value))
        .sum()
}

fn load(file: &Path) -> Vec<(String, Items)> {
    let mut sites: Vec<(String, Items)> = Vec::new();
    let parsed: Value = match std::fs::read(file)
        .map_err(|error| {
            (
                error.kind() == std::io::ErrorKind::NotFound,
                error.to_string(),
            )
        })
        .and_then(|bytes| {
            serde_json::from_slice(&bytes).map_err(|error| (false, error.to_string()))
        }) {
        Ok(parsed) => parsed,
        Err((missing, error)) => {
            if !missing {
                tracing::warn!(target: "rendered", error, "rendered storage unreadable, starting empty");
            }
            return sites;
        }
    };
    let Value::Object(parsed) = parsed else {
        return sites;
    };
    let entries: Vec<(String, Value)> = js::object_order(parsed.into_iter().collect());
    for (site, raw) in entries {
        if sites.len() >= RENDERED_STORAGE_MAX_SITES {
            break;
        }
        let Value::Object(raw) = raw else {
            continue;
        };
        let mut items: Items = Vec::new();
        let mut total = 0;
        for (key, value) in js::object_order(raw.into_iter().collect()) {
            let Value::String(value) = value else {
                continue;
            };
            if items.len() >= RENDERED_STORAGE_MAX_KEYS {
                continue;
            }
            total += js::length(&key) + js::length(&value);
            if total > RENDERED_STORAGE_MAX_CHARS {
                break;
            }
            items.push((key, value));
        }
        if !items.is_empty() {
            sites.push((site, items));
        }
    }
    sites
}

impl SiteStorage {
    /// Kept in memory only (tests).
    pub fn in_memory() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner::default()),
            disk: None,
            written: Notify::new(),
        })
    }

    /// Kept in `file`, read from it now.
    pub fn open(context: DataContext, file: PathBuf) -> Arc<Self> {
        let sites = load(&file);
        Arc::new(Self {
            inner: Mutex::new(Inner {
                sites,
                ..Inner::default()
            }),
            disk: Some(Disk { context, file }),
            written: Notify::new(),
        })
    }

    /// The site's items, in the order the page lists them.
    pub fn get(&self, site: &str) -> Vec<(String, String)> {
        let inner = self.inner.lock().unwrap();
        inner
            .site(site)
            .map(|at| js::object_order(inner.sites[at].1.clone()))
            .unwrap_or_default()
    }

    /// Applies one write; refused over the bounds.
    pub fn write(
        self: &Arc<Self>,
        site: &str,
        write: &StorageWrite,
    ) -> Result<(), StorageQuotaError> {
        let mut inner = self.inner.lock().unwrap();
        let at = inner.site(site);
        match write {
            StorageWrite::Clear => {
                if let Some(at) = at {
                    inner.sites.remove(at);
                    self.changed(inner);
                }
                Ok(())
            }
            StorageWrite::Remove { key } => {
                let Some(at) = at else { return Ok(()) };
                let items = &mut inner.sites[at].1;
                let Some(index) = items.iter().position(|(name, _)| name == key) else {
                    return Ok(());
                };
                items.remove(index);
                if items.is_empty() {
                    inner.sites.remove(at);
                }
                self.changed(inner);
                Ok(())
            }
            StorageWrite::Set { key, value } => {
                let items = at.map(|at| &inner.sites[at].1);
                if items
                    .and_then(|items| items.iter().find(|(name, _)| name == key))
                    .is_some_and(|(_, old)| old == value)
                {
                    return Ok(());
                }
                if js::length(key) + js::length(value) > RENDERED_STORAGE_MAX_CHARS {
                    return Err(StorageQuotaError);
                }
                let mut next = items.cloned().unwrap_or_default();
                match next.iter_mut().find(|(name, _)| name == key) {
                    Some(entry) => entry.1 = value.clone(),
                    None => next.push((key.clone(), value.clone())),
                }
                if next.len() > RENDERED_STORAGE_MAX_KEYS
                    || chars(&next) > RENDERED_STORAGE_MAX_CHARS
                    || (at.is_none() && inner.sites.len() >= RENDERED_STORAGE_MAX_SITES)
                {
                    return Err(StorageQuotaError);
                }
                match at {
                    Some(at) => inner.sites[at].1 = next,
                    None => inner.sites.push((site.to_owned(), next)),
                }
                self.changed(inner);
                Ok(())
            }
        }
    }

    /// Forgets everything the site stored.
    pub fn clear(self: &Arc<Self>, site: &str) {
        let _ = self.write(site, &StorageWrite::Clear);
    }

    /// Resolves once what is changed is on disk.
    pub async fn flush(&self) {
        loop {
            let notified = self.written.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.inner.lock().unwrap().writing {
                return;
            }
            notified.await;
        }
    }

    fn changed(self: &Arc<Self>, mut inner: std::sync::MutexGuard<'_, Inner>) {
        if self.disk.is_none() {
            return;
        }
        inner.dirty = true;
        if inner.writing {
            return;
        }
        inner.writing = true;
        drop(inner);
        let storage = self.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move { storage.save().await });
            }
            Err(_) => {
                // No runtime (a synchronous caller): written here and now.
                while let Some(body) = storage.next_body() {
                    let disk = storage.disk.as_ref().unwrap();
                    if let Err(error) = disk.context.replace_data_file(&disk.file, &body, 0o600) {
                        tracing::warn!(target: "rendered", error = %error, "rendered storage not saved");
                    }
                }
            }
        }
    }

    /// The file's next text, or `None` once nothing is left to write
    /// (the writer is done).
    fn next_body(&self) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.dirty {
            inner.writing = false;
            drop(inner);
            self.written.notify_waiters();
            return None;
        }
        inner.dirty = false;
        let sites: Vec<(String, String)> = js::object_order(
            inner
                .sites
                .iter()
                .map(|(site, items)| (site.clone(), js::json_object(items)))
                .collect(),
        );
        let body: Vec<String> = sites
            .iter()
            .map(|(site, items)| format!("{}:{items}", js::json_string(site)))
            .collect();
        Some(format!("{{{}}}\n", body.join(",")).into_bytes())
    }

    /// One write at a time; a change made during it is written after it.
    async fn save(self: Arc<Self>) {
        while let Some(body) = self.next_body() {
            let disk = self.disk.as_ref().unwrap();
            if let Err(error) = disk
                .context
                .replace_data_file_async(&disk.file, body, 0o600)
                .await
            {
                tracing::warn!(target: "rendered", error = %error, "rendered storage not saved");
            }
        }
    }
}
