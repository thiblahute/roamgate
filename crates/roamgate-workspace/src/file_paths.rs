//! The paths Files takes and the headers its downloads carry
//! (workspace/file-paths.ts, workspace/utils.ts), and the system errors
//! said as Node says them.

use std::cmp::Ordering;
use std::path::Path;

use roamgate_git::compare::locale_compare_base;
use serde_json::Value;

use crate::connection::WorkspaceError;

fn as_text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn invalid_explorer_path() -> WorkspaceError {
    WorkspaceError::new("invalid file explorer path")
}

/// `sanitizeExplorerPath`: slashes forward, no leading slash, no `..`.
pub fn sanitize_explorer_path(value: Option<&Value>) -> Result<String, WorkspaceError> {
    roamgate_git::sanitize_explorer_path(value).map_err(WorkspaceError::from)
}

/// Node's `path.isAbsolute` on this machine.
pub fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        path.starts_with('/')
            || path.starts_with('\\')
            || (bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'/' || bytes[2] == b'\\'))
    } else {
        path.starts_with('/')
    }
}

fn starts_with_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// `sanitizeMutationPath`: a workspace-relative path; backslashes are a
/// POSIX name's own characters, separators only on Windows.
pub fn sanitize_mutation_path(value: Option<&Value>) -> Result<String, WorkspaceError> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(WorkspaceError::new(
            "file operations require a workspace-relative path",
        ));
    };
    if is_absolute(text) || (cfg!(windows) && starts_with_drive(text)) {
        return Err(WorkspaceError::new(
            "file operations require a workspace-relative path",
        ));
    }
    if cfg!(windows) {
        return sanitize_explorer_path(value);
    }
    let parts: Vec<&str> = text.split('/').filter(|part| !part.is_empty()).collect();
    if parts
        .iter()
        .any(|part| *part == ".." || part.contains('\0'))
    {
        return Err(invalid_explorer_path());
    }
    Ok(parts.join("/"))
}

/// `sanitizeFilesystemPath`: an explicit absolute directory on the host.
pub fn sanitize_filesystem_path(value: Option<&Value>) -> Result<String, WorkspaceError> {
    let path = as_text(value).trim().replace('\\', "/");
    let drive = {
        let bytes = path.as_bytes();
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
    };
    if (!path.starts_with('/') && !drive) || path.contains('\0') {
        return Err(WorkspaceError::new(
            "filesystem browsing requires an absolute path",
        ));
    }
    Ok(path)
}

/// `sanitizePreviewPath`: inside the checkout or absolute, never `..`.
pub fn sanitize_preview_path(value: Option<&Value>) -> Result<String, WorkspaceError> {
    let normalized = as_text(value).trim().replace('\\', "/");
    let absolute = normalized.starts_with('/');
    let parts: Vec<&str> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if parts
        .iter()
        .any(|part| *part == ".." || part.contains('\0'))
    {
        return Err(WorkspaceError::new("invalid file preview path"));
    }
    Ok(if absolute {
        format!("/{}", parts.join("/"))
    } else {
        parts.join("/")
    })
}

/// `sanitizeUploadFilename`: one name, nothing else.
pub fn sanitize_upload_filename(value: Option<&Value>) -> Result<String, WorkspaceError> {
    let raw = as_text(value).trim();
    if raw.is_empty()
        || raw == "."
        || raw == ".."
        || raw.contains('/')
        || raw.contains('\\')
        || raw.contains('\0')
    {
        return Err(WorkspaceError::new("invalid upload filename"));
    }
    Ok(raw.to_owned())
}

/// `entrySort`: directories first, then by name without case.
pub fn entry_sort(a_type: &str, a_name: &str, b_type: &str, b_name: &str) -> Ordering {
    match (a_type == "directory", b_type == "directory") {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => locale_compare_base(a_name, b_name),
    }
}

/// `relativeExplorerPath`.
pub fn relative_explorer_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

/// `assertInsideRoot`.
pub fn assert_inside_root(root_real: &Path, target_real: &Path) -> Result<(), WorkspaceError> {
    crate::html_preview_files::assert_inside_root(root_real, target_real)
        .map_err(WorkspaceError::new)
}

/// `missingFileMessage`: a file that is not there, said plainly.
pub fn missing_file_message(requested_path: &str, root_real: &str) -> String {
    if is_absolute(requested_path) {
        format!(
            "{requested_path} was not found: no such file on this host (or its repository is not checked out at this path)."
        )
    } else {
        format!("{requested_path} is not in this checkout ({root_real}).")
    }
}

/// `relativePreviewPath`: `/`-separated.
pub fn relative_preview_path(root_real: &Path, target_real: &Path) -> String {
    crate::html_preview_files::relative_preview_path(root_real, target_real)
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn content_disposition(filename: &str, disposition: &str) -> String {
    // /[^\x20-\x7e]|["\r\n]/g on UTF-16 code units.
    let mut fallback = String::new();
    for c in filename.chars() {
        if (' '..='~').contains(&c) && c != '"' {
            fallback.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                fallback.push('_');
            }
        }
    }
    if fallback.is_empty() {
        fallback.push_str("download");
    }
    format!(
        "{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{}",
        encode_uri_component(filename)
    )
}

/// `downloadContentDisposition`.
pub fn download_content_disposition(filename: &str) -> String {
    content_disposition(filename, "attachment")
}

/// `inlineContentDisposition`.
pub fn inline_content_disposition(filename: &str) -> String {
    content_disposition(filename, "inline")
}

/// utils.ts `checkoutPath`: Herdr's worktree checkout, else the cwd.
pub fn checkout_path(workspace: &Value) -> String {
    fn text(value: Option<&Value>) -> Option<&str> {
        value.and_then(Value::as_str).filter(|t| !t.is_empty())
    }
    text(workspace.pointer("/worktree/checkout_path"))
        .or_else(|| text(workspace.get("cwd")))
        .unwrap_or("")
        .to_owned()
}

/// utils.ts `sourceCheckoutPath`: the source checkout, else the checkout.
pub fn source_checkout_path(workspace: &Value) -> String {
    workspace
        .pointer("/worktree/repo_root")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| checkout_path(workspace))
}

/// utils.ts `uniqueStrings`: the non-empty ones, first seen first.
pub fn unique_strings<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values.into_iter().flatten() {
        if !value.is_empty() && !out.iter().any(|seen| seen == value) {
            out.push(value.to_owned());
        }
    }
    out
}

/// A system error as Node words it: `ENOENT: no such file or directory,
/// realpath '/x'`.
pub fn node_fs_error(error: &std::io::Error, syscall: &str, path: &Path) -> WorkspaceError {
    let (code, text) = errno_name(error);
    // Node's error code stays out of the answer: the browser gets the
    // message alone, as Bun's sendError gives it.
    WorkspaceError::new(format!("{code}: {text}, {syscall} '{}'", path.display()))
}

/// A system error's Node code (`ENOENT`) and libuv's description.
pub fn errno_name(error: &std::io::Error) -> (&'static str, String) {
    #[cfg(unix)]
    if let Some(raw) = error.raw_os_error() {
        let named = match raw {
            libc::ENOENT => Some(("ENOENT", "no such file or directory")),
            libc::ENOTDIR => Some(("ENOTDIR", "not a directory")),
            libc::EACCES => Some(("EACCES", "permission denied")),
            libc::EPERM => Some(("EPERM", "operation not permitted")),
            libc::EEXIST => Some(("EEXIST", "file already exists")),
            libc::EISDIR => Some(("EISDIR", "illegal operation on a directory")),
            libc::ENOTEMPTY => Some(("ENOTEMPTY", "directory not empty")),
            libc::EXDEV => Some(("EXDEV", "cross-device link not permitted")),
            libc::EINVAL => Some(("EINVAL", "invalid argument")),
            libc::ELOOP => Some(("ELOOP", "too many symbolic links encountered")),
            libc::ENAMETOOLONG => Some(("ENAMETOOLONG", "name too long")),
            libc::EROFS => Some(("EROFS", "read-only file system")),
            libc::EBUSY => Some(("EBUSY", "resource busy or locked")),
            _ => None,
        };
        if let Some((code, text)) = named {
            return (code, text.to_owned());
        }
    }
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory".into()),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied".into()),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists".into()),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory".into()),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory".into()),
        ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty".into()),
        ErrorKind::CrossesDevices => ("EXDEV", "cross-device link not permitted".into()),
        ErrorKind::InvalidInput => ("EINVAL", "invalid argument".into()),
        _ => ("EIO", error.to_string()),
    }
}

/// Whether the error is Node's `ENOENT` or `ENOTDIR`.
pub fn is_missing(error: &std::io::Error) -> bool {
    matches!(errno_name(error).0, "ENOENT" | "ENOTDIR")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn text(value: &str) -> Value {
        json!(value)
    }

    #[test]
    fn sanitizes_explorer_paths_relative_to_the_checkout() {
        assert_eq!(
            sanitize_explorer_path(Some(&text("/src/components"))).unwrap(),
            "src/components"
        );
        assert_eq!(
            sanitize_explorer_path(Some(&text("src\\components\\App.tsx"))).unwrap(),
            "src/components/App.tsx"
        );
        assert_eq!(sanitize_explorer_path(Some(&text(""))).unwrap(), "");
    }

    #[test]
    fn rejects_traversal_and_nul_bytes_in_explorer_paths() {
        for path in ["../secret", "src/\0secret"] {
            assert_eq!(
                sanitize_explorer_path(Some(&text(path)))
                    .unwrap_err()
                    .message,
                "invalid file explorer path"
            );
        }
    }

    #[test]
    fn allows_preview_paths_inside_and_outside_the_checkout() {
        assert_eq!(
            sanitize_preview_path(Some(&text("src/App.tsx"))).unwrap(),
            "src/App.tsx"
        );
        assert_eq!(
            sanitize_preview_path(Some(&text("/tmp/screenshot.png"))).unwrap(),
            "/tmp/screenshot.png"
        );
    }

    #[test]
    fn rejects_unsafe_preview_and_upload_paths() {
        assert_eq!(
            sanitize_preview_path(Some(&text("/tmp/../secret")))
                .unwrap_err()
                .message,
            "invalid file preview path"
        );
        for name in ["nested/file.txt", ""] {
            assert_eq!(
                sanitize_upload_filename(Some(&text(name)))
                    .unwrap_err()
                    .message,
                "invalid upload filename"
            );
        }
    }

    #[test]
    fn builds_relative_explorer_paths_and_safe_download_headers() {
        assert_eq!(relative_explorer_path("", "README.md"), "README.md");
        assert_eq!(
            relative_explorer_path("docs", "README.md"),
            "docs/README.md"
        );
        let header = download_content_disposition("测试 file.txt");
        assert!(header.contains("filename=\"__ file.txt\""), "{header}");
        assert!(header.contains("filename*=UTF-8''%E6%B5%8B%E8%AF%95%20file.txt"));
        assert_eq!(
            inline_content_disposition("guide.pdf"),
            "inline; filename=\"guide.pdf\"; filename*=UTF-8''guide.pdf"
        );
    }

    #[test]
    fn filesystem_paths_must_be_explicit_absolute_and_nul_free() {
        assert_eq!(
            sanitize_filesystem_path(Some(&text("/tmp/../refs"))).unwrap(),
            "/tmp/../refs"
        );
        assert_eq!(
            sanitize_filesystem_path(Some(&text("C:\\refs"))).unwrap(),
            "C:/refs"
        );
        for path in [
            None,
            Some(text("")),
            Some(text("refs")),
            Some(text("../refs")),
            Some(text("/refs\0")),
        ] {
            assert!(
                sanitize_filesystem_path(path.as_ref())
                    .unwrap_err()
                    .message
                    .contains("absolute path")
            );
        }
    }
}
