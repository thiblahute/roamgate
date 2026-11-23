//! Who owns each conversation-mode session (`lease.ts`), kept on disk in
//! `conversation-leases.json` so a Roamgate restart finds the sessions its
//! headless processes owned (their holders stay in the panes). One file
//! for every connection; each store changes only its own connection's
//! entries. No entry means the terminal owns the pane's session.
//!
//! The file as this process knows it is read once, then every connection's
//! store changes it here and it is written behind them: holders save their
//! read offsets every second or so, many panes at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use indexmap::IndexMap;
use roamgate_agents::js;
use roamgate_base::env::ProcessEnv;
use roamgate_base::paths::DataContext;
use serde_json::Value;

use crate::behind::BehindWriter;
use crate::shared::{Lease, Obj, lease_str};
use crate::time::SharedClock;

/// The leases' file name in the data root.
pub const LEASE_FILE_NAME: &str = "conversation-leases.json";

/// `<data>/conversation-leases.json`.
pub fn default_lease_file(data: &DataContext) -> PathBuf {
    data.data_root().join(LEASE_FILE_NAME)
}

const PHASES: [&str; 4] = ["terminal", "to_conversation", "conversation", "to_terminal"];

fn valid_lease(value: &Value) -> bool {
    let Some(lease) = value.as_object() else {
        return false;
    };
    let text = |key: &str| lease.get(key).is_some_and(Value::is_string);
    text("connection_id")
        && text("pane_id")
        && text("session_id")
        && text("cwd")
        && matches!(lease_str(lease, "owner"), Some("terminal" | "conversation"))
        && lease_str(lease, "phase").is_some_and(|phase| PHASES.contains(&phase))
}

fn read_lease_file(path: &Path) -> Vec<Lease> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Some(Value::Object(parsed)) = js::parse(&text) else {
        return Vec::new();
    };
    match parsed.get("leases") {
        Some(Value::Array(leases)) => leases
            .iter()
            .filter(|lease| valid_lease(lease))
            .filter_map(|lease| lease.as_object().cloned())
            .collect(),
        _ => Vec::new(),
    }
}

type Leases = IndexMap<String, Lease>;

struct LeaseFile {
    by_connection: Mutex<IndexMap<String, Leases>>,
    writer: Arc<BehindWriter>,
}

impl LeaseFile {
    fn contents(&self) -> String {
        let by_connection = self.by_connection.lock().unwrap();
        let leases: Vec<Value> = by_connection
            .values()
            .flat_map(|each| each.values().cloned().map(Value::Object))
            .collect();
        let mut file = Obj::new();
        file.insert("version".into(), Value::from(1));
        file.insert("leases".into(), Value::Array(leases));
        format!("{}\n", js::stringify(&Value::Object(file)))
    }
}

static LEASE_FILES: LazyLock<Mutex<HashMap<PathBuf, Arc<LeaseFile>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lease_file(path: &Path, data: &DataContext) -> Arc<LeaseFile> {
    let mut files = LEASE_FILES.lock().unwrap();
    if let Some(known) = files.get(path) {
        return known.clone();
    }
    let mut by_connection: IndexMap<String, Leases> = IndexMap::new();
    for lease in read_lease_file(path) {
        let connection = lease_str(&lease, "connection_id").unwrap_or("").to_owned();
        let pane = lease_str(&lease, "pane_id").unwrap_or("").to_owned();
        by_connection
            .entry(connection)
            .or_default()
            .insert(pane, lease);
    }
    let known = Arc::new(LeaseFile {
        by_connection: Mutex::new(by_connection),
        writer: BehindWriter::new(path.to_path_buf(), data.clone()),
    });
    files.insert(path.to_path_buf(), known.clone());
    known
}

/// Every lease file written as it is now (tests, shutdown).
pub async fn flush_lease_files() {
    let files: Vec<Arc<LeaseFile>> = LEASE_FILES.lock().unwrap().values().cloned().collect();
    for file in files {
        file.writer.flush().await;
    }
}

/// Forget what this process knows of lease files: the next store reads
/// them.
pub fn forget_lease_files() {
    LEASE_FILES.lock().unwrap().clear();
}

pub struct LeaseOptions {
    pub connection_id: String,
    /// None keeps leases in memory only.
    pub file: Option<PathBuf>,
    pub clock: SharedClock,
    /// How files are written (default: the process's).
    pub data: Option<DataContext>,
}

/// One connection's leases (`createLeaseStore`). Cheap to clone.
#[derive(Clone)]
pub struct LeaseStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    connection_id: String,
    clock: SharedClock,
    file: Option<Arc<LeaseFile>>,
    memory: Mutex<Leases>,
}

impl LeaseStore {
    pub fn new(options: LeaseOptions) -> Self {
        let data = options
            .data
            .unwrap_or_else(|| DataContext::from_env(&ProcessEnv));
        let file = options.file.map(|path| lease_file(&path, &data));
        Self {
            inner: Arc::new(StoreInner {
                connection_id: options.connection_id,
                clock: options.clock,
                file,
                memory: Mutex::new(IndexMap::new()),
            }),
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.inner.connection_id
    }

    fn with<R>(&self, run: impl FnOnce(&mut Leases) -> R) -> R {
        match &self.inner.file {
            None => run(&mut self.inner.memory.lock().unwrap()),
            Some(file) => {
                let mut by_connection = file.by_connection.lock().unwrap();
                run(by_connection
                    .entry(self.inner.connection_id.clone())
                    .or_default())
            }
        }
    }

    fn save(&self) {
        let Some(file) = &self.inner.file else {
            return;
        };
        let shared = file.clone();
        file.writer.write(Box::new(move || shared.contents()));
    }

    pub fn get(&self, pane_id: &str) -> Option<Lease> {
        self.with(|leases| leases.get(pane_id).cloned())
    }

    pub fn all(&self) -> Vec<Lease> {
        self.with(|leases| leases.values().cloned().collect())
    }

    /// The lease of the pane holding this session, if any.
    pub fn by_session(&self, session_id: &str) -> Option<Lease> {
        self.with(|leases| {
            leases
                .values()
                .find(|lease| lease_str(lease, "session_id") == Some(session_id))
                .cloned()
        })
    }

    /// Sets the pane's lease: `lease` with this connection, its owner (from
    /// its phase) and the time, as `{...lease, connection_id, owner,
    /// updated_at}` makes it.
    pub fn set(&self, lease: Lease) -> Lease {
        let mut next = lease;
        let owner = match lease_str(&next, "phase") {
            Some("conversation" | "to_terminal") => "conversation",
            _ => "terminal",
        };
        next.insert(
            "connection_id".into(),
            Value::String(self.inner.connection_id.clone()),
        );
        next.insert("owner".into(), Value::String(owner.into()));
        next.insert(
            "updated_at".into(),
            Value::String(js::iso(self.inner.clock.now() as f64)),
        );
        let pane = lease_str(&next, "pane_id").unwrap_or("").to_owned();
        self.with(|leases| leases.insert(pane, next.clone()));
        self.save();
        next
    }

    /// The terminal owns the pane's session again.
    pub fn delete(&self, pane_id: &str) {
        if self.with(|leases| leases.shift_remove(pane_id)).is_none() {
            return;
        }
        self.save();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::VirtualClock;
    use roamgate_agents::obj;

    fn store(connection: &str, file: Option<PathBuf>, data: &DataContext) -> LeaseStore {
        let clock = VirtualClock::new();
        clock.set(1_700_000_000_000);
        LeaseStore::new(LeaseOptions {
            connection_id: connection.into(),
            file,
            clock: clock.shared(),
            data: Some(data.clone()),
        })
    }

    #[tokio::test]
    async fn leases_of_each_connection_share_one_file_in_bun_text() {
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), roamgate_base::paths::Platform::current(), None);
        let path = home.path().join("leases.json");
        let one = store("local", Some(path.clone()), &data);
        let two = store("ssh:b", Some(path.clone()), &data);
        one.set(obj! {"pane_id" => "w1:p1", "session_id" => "s1", "cwd" => "/w", "phase" => "conversation"});
        two.set(obj! {"pane_id" => "w1:p1", "session_id" => "s2", "cwd" => "/w", "phase" => "to_conversation"});
        flush_lease_files().await;
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "{\"version\":1,\"leases\":[{\"pane_id\":\"w1:p1\",\"session_id\":\"s1\",\"cwd\":\"/w\",\"phase\":\"conversation\",\"connection_id\":\"local\",\"owner\":\"conversation\",\"updated_at\":\"2023-11-14T22:13:20.000Z\"},{\"pane_id\":\"w1:p1\",\"session_id\":\"s2\",\"cwd\":\"/w\",\"phase\":\"to_conversation\",\"connection_id\":\"ssh:b\",\"owner\":\"terminal\",\"updated_at\":\"2023-11-14T22:13:20.000Z\"}]}\n"
        );
        assert_eq!(one.by_session("s1").unwrap()["pane_id"], "w1:p1");
        assert!(one.by_session("s2").is_none());
        // Read again by a process that knew nothing of it.
        forget_lease_files();
        let again = store("ssh:b", Some(path.clone()), &data);
        assert_eq!(again.get("w1:p1").unwrap()["session_id"], "s2");
        again.delete("w1:p1");
        flush_lease_files().await;
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"s2\""));
        assert!(text.contains("\"s1\""));
        forget_lease_files();
    }

    #[test]
    fn a_lease_changed_keeps_its_keys_in_place() {
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), roamgate_base::paths::Platform::current(), None);
        let leases = store("local", None, &data);
        let first = leases.set(obj! {"pane_id" => "p", "session_id" => "s", "cwd" => "/", "phase" => "to_conversation"});
        let mut next = first.clone();
        next.insert("phase".into(), Value::from("conversation"));
        let second = leases.set(next);
        let keys: Vec<&String> = second.keys().collect();
        assert_eq!(
            keys,
            [
                "pane_id",
                "session_id",
                "cwd",
                "phase",
                "connection_id",
                "owner",
                "updated_at"
            ]
        );
        assert_eq!(second["owner"], "conversation");
        // Files that are not leases' are not read as some.
        assert!(!valid_lease(&Value::from(1)));
    }
}
