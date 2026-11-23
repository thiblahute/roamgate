//! Files on this machine (workspace/local-files.ts): list, resolve, read,
//! stat, download, upload, delete, mkdir and move, each kept inside the
//! checkout unless asked by absolute path. Synchronous: the handlers run
//! them on a blocking thread.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use roamgate_git::preview::{decode_preview_buffer, preview_limit_for_path};

use crate::atomic_move::rename_file_exclusive;
use crate::connection::WorkspaceError;
use crate::file_download::{FileDownloadError, FileDownloadOptions, file_download_range};
use crate::file_paths::{
    assert_inside_root, entry_sort, is_absolute, is_missing, missing_file_message, node_fs_error,
    relative_explorer_path, relative_preview_path,
};
use crate::file_types::{
    FileBody, FileDeleteResult, FileDownloadResult, FileExplorerEntry, FileListResult,
    FilePreviewResult, FileStatResult, FileUploadResult, mtime_ms, path_text, realpath, resolve,
};

/// file-constants.ts `LIST_LIMIT`.
pub const LIST_LIMIT: usize = 1000;
/// file-constants.ts `DOWNLOAD_TIMEOUT_MS`.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_millis(120_000);

fn real(path: &Path) -> Result<PathBuf, WorkspaceError> {
    realpath(path).map_err(|error| node_fs_error(&error, "realpath", path))
}

fn stat(path: &Path) -> Result<std::fs::Metadata, WorkspaceError> {
    std::fs::metadata(path).map_err(|error| node_fs_error(&error, "stat", path))
}

fn lstat(path: &Path) -> Result<std::fs::Metadata, WorkspaceError> {
    std::fs::symlink_metadata(path).map_err(|error| node_fs_error(&error, "lstat", path))
}

/// `listLocalFiles`: a directory of the checkout, hidden names left out
/// unless asked, directories first; with `follow_directory_links` a link
/// to a directory lists as one (the filesystem scope).
pub fn list_local_files(
    root_path: &str,
    relative_path: &str,
    show_hidden: bool,
    follow_directory_links: bool,
) -> Result<FileListResult, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let target_real = real(&resolve(&root_real, relative_path))?;
    assert_inside_root(&root_real, &target_real)?;
    let dirents = std::fs::read_dir(&target_real)
        .map_err(|error| node_fs_error(&error, "scandir", &target_real))?;
    let mut entries = Vec::new();
    for dirent in dirents.flatten() {
        let name = dirent.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let entry_path = target_real.join(&name);
        let info = std::fs::metadata(&entry_path).ok();
        let file_type = dirent.file_type().ok();
        let is_dir = file_type.is_some_and(|t| t.is_dir());
        let is_link = file_type.is_some_and(|t| t.is_symlink());
        let kind =
            if is_dir || (follow_directory_links && info.as_ref().is_some_and(|i| i.is_dir())) {
                "directory"
            } else if is_link {
                "symlink"
            } else {
                "file"
            };
        entries.push(FileExplorerEntry {
            path: relative_explorer_path(relative_path, &name),
            hidden: name.starts_with('.'),
            name,
            kind: kind.into(),
            size: info.as_ref().map_or(0, std::fs::Metadata::len),
            mtime_ms: info.as_ref().map_or(0.0, mtime_ms),
            ignored: None,
        });
    }
    entries.sort_by(|a, b| entry_sort(&a.kind, &a.name, &b.kind, &b.name));
    let truncated = entries.len() > LIST_LIMIT;
    entries.truncate(LIST_LIMIT);
    Ok(FileListResult {
        root: path_text(&root_real),
        path: relative_path.to_owned(),
        entries,
        truncated,
    })
}

/// `resolveLocalFilePaths`: the paths that are a file or a directory
/// (inside the checkout unless absolute), in the order asked.
pub fn resolve_local_file_paths(
    root_path: &str,
    requested: &[String],
) -> Result<Vec<String>, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    Ok(requested
        .iter()
        .filter(|requested_path| {
            let absolute = is_absolute(requested_path);
            let Ok(target_real) = realpath(&if absolute {
                PathBuf::from(requested_path)
            } else {
                resolve(&root_real, requested_path)
            }) else {
                return false;
            };
            if !absolute && assert_inside_root(&root_real, &target_real).is_err() {
                return false;
            }
            std::fs::metadata(&target_real).is_ok_and(|info| info.is_file() || info.is_dir())
        })
        .cloned()
        .collect())
}

/// The real path of what a read asks for: missing said plainly.
fn read_target(root_real: &Path, requested_path: &str) -> Result<PathBuf, WorkspaceError> {
    let absolute = is_absolute(requested_path);
    let wanted = if absolute {
        PathBuf::from(requested_path)
    } else {
        resolve(root_real, requested_path)
    };
    let target_real = realpath(&wanted).map_err(|error| {
        if is_missing(&error) {
            WorkspaceError::new(missing_file_message(requested_path, &path_text(root_real)))
        } else {
            node_fs_error(&error, "realpath", &wanted)
        }
    })?;
    if !absolute {
        assert_inside_root(root_real, &target_real)?;
    }
    Ok(target_real)
}

fn display_path(root_real: &Path, requested_path: &str, target_real: &Path) -> String {
    if is_absolute(requested_path) {
        path_text(target_real)
    } else {
        relative_preview_path(root_real, target_real)
    }
}

/// `readLocalFile`: a file's preview (text, an image's data, or binary),
/// a directory's empty one.
pub fn read_local_file(
    root_path: &str,
    requested_path: &str,
) -> Result<FilePreviewResult, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let target_real = read_target(&root_real, requested_path)?;
    let info = stat(&target_real)?;
    let path = display_path(&root_real, requested_path, &target_real);
    if info.is_dir() {
        return Ok(FilePreviewResult {
            root: path_text(&root_real),
            path,
            kind: Some("directory".into()),
            size: 0,
            mtime_ms: mtime_ms(&info),
            truncated: false,
            decoded: roamgate_git::preview::Decoded {
                text: None,
                binary: false,
                ..Default::default()
            },
        });
    }
    if !info.is_file() {
        return Err(WorkspaceError::new("only regular files can be previewed"));
    }
    let limit = preview_limit_for_path(&path, info.len());
    let mut raw = Vec::new();
    std::fs::File::open(&target_real)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut raw))
        .map_err(|error| node_fs_error(&error, "open", &target_real))?;
    let truncated = info.len() > limit as u64 || raw.len() > limit;
    let bytes = if truncated {
        &raw[..raw.len().min(limit)]
    } else {
        &raw[..]
    };
    Ok(FilePreviewResult {
        root: path_text(&root_real),
        decoded: decode_preview_buffer(bytes, truncated, &path),
        path,
        kind: None,
        size: info.len(),
        mtime_ms: mtime_ms(&info),
        truncated,
    })
}

/// `statLocalFile`: the size and time the preview compares, nothing read.
pub fn stat_local_file(
    root_path: &str,
    requested_path: &str,
) -> Result<FileStatResult, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let absolute = is_absolute(requested_path);
    let target_real = real(&if absolute {
        PathBuf::from(requested_path)
    } else {
        resolve(&root_real, requested_path)
    })?;
    if !absolute {
        assert_inside_root(&root_real, &target_real)?;
    }
    let info = stat(&target_real)?;
    Ok(if info.is_dir() {
        FileStatResult {
            kind: "directory".into(),
            size: 0,
            mtime_ms: mtime_ms(&info),
        }
    } else {
        FileStatResult {
            kind: "file".into(),
            size: info.len(),
            mtime_ms: mtime_ms(&info),
        }
    })
}

/// A local download's failure: a refusal with its status, or an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadFailure {
    Refused(FileDownloadError),
    Failed(WorkspaceError),
}

impl From<WorkspaceError> for DownloadFailure {
    fn from(error: WorkspaceError) -> Self {
        Self::Failed(error)
    }
}

impl From<FileDownloadError> for DownloadFailure {
    fn from(error: FileDownloadError) -> Self {
        Self::Refused(error)
    }
}

impl std::fmt::Display for DownloadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(error) => write!(f, "{error}"),
            Self::Failed(error) => write!(f, "{error}"),
        }
    }
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `downloadLocalFile`: a file (a range of it when asked), or a directory
/// as a `.tar.gz`.
pub async fn download_local_file(
    root_path: &str,
    requested_path: &str,
    options: &FileDownloadOptions,
) -> Result<FileDownloadResult, DownloadFailure> {
    let (root_real, target_real, info) = {
        let root = root_path.to_owned();
        let requested = requested_path.to_owned();
        tokio::task::spawn_blocking(move || -> Result<_, WorkspaceError> {
            let root_real = real(Path::new(&root))?;
            let target_real = read_target(&root_real, &requested)?;
            let info = stat(&target_real)?;
            Ok((root_real, target_real, info))
        })
        .await
        .map_err(|error| WorkspaceError::new(error.to_string()))??
    };
    let path = display_path(&root_real, requested_path, &target_real);
    if info.is_dir() {
        let name = basename(&target_real);
        let archive_name = format!(
            "{}.tar.gz",
            if name.is_empty() { "download" } else { &name }
        );
        let parent = target_real
            .parent()
            .map(path_text)
            .unwrap_or_else(|| "/".into());
        let mut command = tokio::process::Command::new("tar");
        command
            .args(["-czf", "-", "-C", &parent, "--", &name])
            .env("COPYFILE_DISABLE", "1")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(DOWNLOAD_TIMEOUT, command.output())
            .await
            .map_err(|_| {
                WorkspaceError::new(format!(
                    "tar timed out after {}ms",
                    DOWNLOAD_TIMEOUT.as_millis()
                ))
            })?
            .map_err(|error| WorkspaceError::new(error.to_string()))?;
        let code = output.status.code().unwrap_or(1);
        if code != 0 {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let text = if stderr.is_empty() {
                format!("tar exited {code}")
            } else {
                stderr
            };
            return Err(WorkspaceError::new(roamgate_git::trim_slice(&text, 1000)).into());
        }
        return Ok(FileDownloadResult {
            accept_ranges: false,
            content_range: None,
            filename: archive_name,
            path,
            size: output.stdout.len() as u64,
            body: FileBody::Bytes(output.stdout),
            content_type: "application/gzip".into(),
        });
    }
    if !info.is_file() {
        return Err(
            WorkspaceError::new("only regular files and directories can be downloaded").into(),
        );
    }
    let size = info.len();
    let range = file_download_range(&path, size, options)?;
    let start = range.map_or(0, |range| range.start);
    let end = range.map_or(size, |range| range.end + 1);
    let name = basename(&target_real);
    Ok(FileDownloadResult {
        accept_ranges: true,
        content_range: range.map(|_| format!("bytes {start}-{}/{size}", end - 1)),
        filename: if name.is_empty() {
            "download".into()
        } else {
            name
        },
        path,
        size: end - start,
        body: FileBody::File {
            path: target_real,
            start,
            end,
        },
        content_type: "application/octet-stream".into(),
    })
}

/// `uploadLocalFile`: writes a file into a directory of the checkout,
/// never over a directory or a link.
pub fn upload_local_file(
    root_path: &str,
    directory: &str,
    filename: &str,
    body: &[u8],
) -> Result<FileUploadResult, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let directory_real = real(&resolve(&root_real, directory))?;
    assert_inside_root(&root_real, &directory_real)?;
    if !stat(&directory_real)?.is_dir() {
        return Err(WorkspaceError::new("upload target is not a directory"));
    }
    let target = resolve(&directory_real, filename);
    let existed = match std::fs::symlink_metadata(&target) {
        Ok(info) => {
            if info.is_dir() || info.file_type().is_symlink() {
                return Err(WorkspaceError::new(
                    "cannot overwrite a directory or symlink",
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(node_fs_error(&error, "lstat", &target)),
    };
    std::fs::write(&target, body).map_err(|error| node_fs_error(&error, "open", &target))?;
    Ok(FileUploadResult {
        path: relative_preview_path(&root_real, &target),
        size: body.len() as u64,
        overwritten: existed,
    })
}

/// `deleteLocalFile`: a file, link or directory (with what it holds) of
/// the checkout.
pub fn delete_local_file(
    root_path: &str,
    requested_path: &str,
) -> Result<FileDeleteResult, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let target = resolve(&root_real, requested_path);
    let parent = target.parent().unwrap_or(&target).to_path_buf();
    let parent_real = real(&parent)?;
    assert_inside_root(&root_real, &parent_real)?;
    let info = lstat(&target)?;
    let removed = if info.is_dir() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };
    removed.map_err(|error| node_fs_error(&error, "rm", &target))?;
    Ok(FileDeleteResult {
        path: relative_preview_path(&root_real, &target),
        kind: if info.is_dir() {
            "directory"
        } else if info.file_type().is_symlink() {
            "symlink"
        } else {
            "file"
        }
        .into(),
    })
}

/// `createLocalDirectory`: one new directory, never over anything.
pub fn create_local_directory(
    root_path: &str,
    directory: &str,
    name: &str,
) -> Result<String, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let parent_real = real(&resolve(&root_real, directory))?;
    assert_inside_root(&root_real, &parent_real)?;
    let target = parent_real.join(name);
    std::fs::create_dir(&target).map_err(|error| node_fs_error(&error, "mkdir", &target))?;
    Ok(relative_preview_path(&root_real, &target))
}

/// `moveLocalFile`: a file or link into a directory of the checkout, never
/// over what is there.
pub fn move_local_file(
    root_path: &str,
    path: &str,
    directory: &str,
) -> Result<String, WorkspaceError> {
    let root_real = real(Path::new(root_path))?;
    let source_path = resolve(&root_real, path);
    let source_parent = real(source_path.parent().unwrap_or(&source_path))?;
    let destination = real(&resolve(&root_real, directory))?;
    assert_inside_root(&root_real, &source_parent)?;
    assert_inside_root(&root_real, &destination)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    let source = source_parent.join(name);
    let info = lstat(&source)?;
    if !info.is_file() && !info.file_type().is_symlink() {
        return Err(WorkspaceError::new("Only files can be moved"));
    }
    if !stat(&destination)?.is_dir() {
        return Err(WorkspaceError::new("Move target is not a directory"));
    }
    let target = destination.join(name);
    rename_file_exclusive(&source, &target)?;
    Ok(relative_preview_path(&root_real, &target))
}

#[cfg(test)]
mod tests;
