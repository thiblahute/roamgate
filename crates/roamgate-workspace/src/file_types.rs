//! What Files answers (workspace/file-types.ts), in the TS's key order.

use std::path::{Component, Path, PathBuf};

use roamgate_git::preview::Decoded;
use serde::Serialize;
use tokio::sync::mpsc;

/// A number as JS writes it (no `.0` on an integral one).
pub fn ser_js_f64<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    roamgate_git::js_num(*value).serialize(serializer)
}

/// `FileExplorerEntry`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileExplorerEntry {
    pub name: String,
    pub path: String,
    /// `directory`, `file` or `symlink`.
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    #[serde(serialize_with = "ser_js_f64")]
    pub mtime_ms: f64,
    pub hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
}

/// `FileListResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileListResult {
    pub root: String,
    pub path: String,
    pub entries: Vec<FileExplorerEntry>,
    pub truncated: bool,
}

/// `FilePreviewResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FilePreviewResult {
    pub root: String,
    pub path: String,
    /// Omitted for regular files; `directory` for a directory, which has
    /// no content.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub size: u64,
    #[serde(serialize_with = "ser_js_f64")]
    pub mtime_ms: f64,
    pub truncated: bool,
    #[serde(flatten)]
    pub decoded: Decoded,
}

/// `FileStatResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileStatResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    #[serde(serialize_with = "ser_js_f64")]
    pub mtime_ms: f64,
}

/// `FileUploadResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileUploadResult {
    pub path: String,
    pub size: u64,
    pub overwritten: bool,
}

/// `FileDeleteResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileDeleteResult {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// A download's bytes.
#[derive(Debug)]
pub enum FileBody {
    Bytes(Vec<u8>),
    /// `[start, end)` of a file on this machine, read as it is sent.
    File {
        path: PathBuf,
        start: u64,
        end: u64,
    },
    /// Chunks as they come; an error ends the body short (the browser then
    /// drops the download).
    Stream(mpsc::Receiver<Result<Vec<u8>, String>>),
}

impl FileBody {
    /// The whole body, for the tests and small reads.
    pub async fn collect(self) -> Result<Vec<u8>, String> {
        match self {
            Self::Bytes(bytes) => Ok(bytes),
            Self::File { path, start, end } => {
                use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
                let mut file = tokio::fs::File::open(&path)
                    .await
                    .map_err(|e| e.to_string())?;
                file.seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|e| e.to_string())?;
                let mut bytes = Vec::new();
                file.take(end - start)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(bytes)
            }
            Self::Stream(mut chunks) => {
                let mut bytes = Vec::new();
                while let Some(chunk) = chunks.recv().await {
                    bytes.extend(chunk?);
                }
                Ok(bytes)
            }
        }
    }
}

/// `FileDownloadResult`.
#[derive(Debug)]
pub struct FileDownloadResult {
    pub accept_ranges: bool,
    pub content_range: Option<String>,
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub body: FileBody,
    pub content_type: String,
}

/// `FileResolution`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileResolution {
    pub candidate: String,
    pub path: String,
}

/// Node's `path.resolve(base, path)`: joined, then `.` and `..` taken out
/// by the letter, never through the file system.
pub fn resolve(base: &Path, path: &str) -> PathBuf {
    let joined = base.join(path);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node's `realpath`: the canonical path (without Windows' `\\?\`).
pub fn realpath(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = real.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\")
            && !rest.starts_with("UNC\\")
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(real)
}

/// Node's `mtimeMs`: milliseconds with their fraction.
pub fn mtime_ms(metadata: &std::fs::Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0
    }
    #[cfg(not(unix))]
    {
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }
}

/// A path as text.
pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
