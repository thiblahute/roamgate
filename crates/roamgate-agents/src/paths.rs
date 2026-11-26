//! Paths as Node's `path` and `encodeURIComponent` give them.

use std::path::{Component, Path, PathBuf};

/// `path.resolve(p)`: absolute, `.` and `..` resolved, no symlinks read.
pub fn resolve(p: &str) -> PathBuf {
    // A POSIX path on Windows is a Unix host's (a pane's folder there),
    // never this machine's current drive.
    if cfg!(windows) && p.starts_with('/') {
        let normal = roamgate_base::paths::posix_normalize(p);
        let trimmed = normal.trim_end_matches('/');
        return PathBuf::from(if trimmed.is_empty() { "/" } else { trimmed });
    }
    let path = Path::new(p);
    let base = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    normalize(&base.join(path))
}

/// `.` and `..` resolved lexically.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push("/");
    }
    out
}

/// A file's modification time in ms, as `stat().mtimeMs`.
pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    // As Node's and Bun's `mtimeMs`: seconds times 1000 plus nanoseconds
    // over a million, so the same file gives the same number on both sides.
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| {
            d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6
        })
}

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_encodes() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(encode_uri_component("/home/u/x y"), "%2Fhome%2Fu%2Fx%20y");
    }
}
