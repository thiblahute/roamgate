//! An area of the history repo (history/area.ts): one store's authored
//! data, written as files under its own directory (the allowlist: a store
//! without an area is never written). Its render is the whole truth for
//! the paths it owns: a file there that the render does not give is
//! removed.

use std::collections::BTreeMap;
use std::path::PathBuf;

use roamgate_base::env::{Env, roamgate_env};
use roamgate_base::paths::{DataContext, DataFile, Platform};
use serde_json::Value;

/// What an area renders.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AreaRender {
    /// Repo-relative path to its content.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Paths this render speaks for: a file, or a directory ending in `/`
    /// (a `*` segment: any one directory). Files under them that are not
    /// in `files` are removed.
    pub owns: Vec<String>,
}

impl AreaRender {
    pub fn set(&mut self, path: impl Into<String>, content: impl Into<Vec<u8>>) {
        self.files.insert(path.into(), content.into());
    }

    pub fn text(&self, path: &str) -> Option<&str> {
        self.files
            .get(path)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
    }
}

/// An area: its name, what it watches, its render and its words.
pub trait HistoryArea: Send + Sync {
    fn name(&self) -> &str;
    /// Source files (or directories, whose entries count) whose changes
    /// mark the area changed, by their size and modification time: hand
    /// edits count too. None: not watched (its store tells each change).
    fn watch(&self) -> Option<Vec<PathBuf>> {
        None
    }
    /// The area's files, every one (`ids` None), or those of the ids
    /// changed (an area that takes ids; others render whole either way).
    fn render(&self, ids: Option<&[String]>) -> Result<AreaRender, String>;
    /// A short summary of changed paths for the commit message; None or
    /// empty: "N files".
    fn describe(&self, _paths: &[String]) -> Option<String> {
        None
    }
}

/// Where the stores are: the server's paths, or a CLI's for a service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPaths {
    pub data: PathBuf,
    pub settings: PathBuf,
    pub connections: PathBuf,
    pub reviews: PathBuf,
    pub work: PathBuf,
    /// The voice's shared data directory (`low-gpu.json`).
    pub voice_data: PathBuf,
}

/// The voice's data directory (voiceDataDir).
pub fn voice_data_dir(context: &DataContext) -> PathBuf {
    if context.platform == Platform::Windows {
        context.data_root().join("voice")
    } else {
        context
            .home
            .join(".local")
            .join("share")
            .join("roamgate")
            .join("voice")
    }
}

/// The stores' paths as the environment and the data root name them
/// (historyPaths).
pub fn history_paths(env: &dyn Env, context: &DataContext) -> HistoryPaths {
    let data = context.data_root();
    let file = |name: &str, kind: DataFile| -> PathBuf {
        roamgate_env(env, name)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                context
                    .default_data_file(kind)
                    .unwrap_or_else(|_| data.join(kind.name()))
            })
    };
    HistoryPaths {
        settings: file("SETTINGS_PATH", DataFile::Settings),
        connections: file("CONNECTIONS_PATH", DataFile::Connections),
        reviews: roamgate_env(env, "REVIEW_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("reviews")),
        work: roamgate_env(env, "WORK_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("work")),
        voice_data: voice_data_dir(context),
        data,
    }
}

/// The review store as the history reads it: each record as stored.
pub trait ReviewSource: Send + Sync {
    fn load_sessions(&self) -> Result<Vec<Value>, String>;
    fn load_threads(&self, session_id: &str) -> Result<Vec<Value>, String>;
}

/// "3 files", "1 file".
pub fn count(n: usize, one: &str) -> String {
    count_as(n, one, &format!("{one}s"))
}

pub fn count_as(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}
