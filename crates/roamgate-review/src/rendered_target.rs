//! A file to show rendered (review/rendered-target.ts): its checkout's
//! root (or, outside any, its directory) and its path relative to that.

use std::future::Future;

use crate::error::ReviewError;
use crate::model::ReviewTarget;

pub use roamgate_base::paths::posix_normalize;

/// `posix.dirname`.
pub fn posix_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.starts_with('/') {
            "/".into()
        } else {
            ".".into()
        };
    }
    match trimmed.rfind('/') {
        Some(0) => "/".into(),
        Some(at) => trimmed[..at]
            .trim_end_matches('/')
            .to_owned()
            .max_if_empty(),
        None => ".".into(),
    }
}

trait OrSlash {
    fn max_if_empty(self) -> String;
}

impl OrSlash for String {
    fn max_if_empty(self) -> String {
        if self.is_empty() { "/".into() } else { self }
    }
}

/// `posix.basename`.
pub fn posix_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or("").to_owned()
}

/// `posix.relative(from, to)` of two absolute paths.
pub fn posix_relative(from: &str, to: &str) -> String {
    let split = |path: &str| -> Vec<String> {
        posix_normalize(path)
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let from = split(from);
    let to = split(to);
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(to[common..].iter().cloned());
    parts.join("/")
}

/// A Windows drive path's separators unified (`C:\a` as `C:/a`): a
/// POSIX path's `\` is a real backslash, so only a drive's is replaced.
fn drive_slashes(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.first().is_some_and(|b| b.is_ascii_alphabetic()) && bytes.get(1) == Some(&b':') {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    }
}

/// An absolute POSIX path, or a Windows drive's.
fn is_absolute_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.starts_with('/')
        || (bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

/// The root and target of a file shown rendered (renderedFileTarget).
pub async fn rendered_file_target<F, Fut>(
    read_root: F,
    file: &str,
    cwd: &str,
) -> Result<(String, ReviewTarget), ReviewError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let file = drive_slashes(file);
    let cwd = drive_slashes(cwd);
    let joined = if is_absolute_path(&file) || !is_absolute_path(&cwd) {
        file
    } else {
        format!("{cwd}/{file}")
    };
    let path = posix_normalize(&joined);
    if !is_absolute_path(&path) || path.contains('\0') {
        return Err(ReviewError::new("the file must be absolute"));
    }
    let mut root = match read_root(posix_dirname(&path)).await {
        Ok(root) => drive_slashes(&root),
        Err(_) => posix_dirname(&path),
    };
    let mut relative = posix_relative(&root, &path);
    if relative.is_empty() || relative == ".." || relative.starts_with("../") {
        root = posix_dirname(&path);
        relative = posix_basename(&path);
    }
    if relative.is_empty() || relative == "." || path.ends_with('/') {
        return Err(ReviewError::new("give a file, not a directory"));
    }
    Ok((
        root,
        ReviewTarget::Rendered {
            path: Some(relative),
            url: None,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_paths_as_node_reads_them() {
        assert_eq!(posix_normalize("/a/./b/../c/"), "/a/c/");
        assert_eq!(posix_normalize("/../x"), "/x");
        assert_eq!(posix_dirname("/a/b/c.md"), "/a/b");
        assert_eq!(posix_dirname("/c.md"), "/");
        assert_eq!(posix_basename("/a/b/c.md"), "c.md");
        assert_eq!(posix_relative("/a/b", "/a/b/c/d.md"), "c/d.md");
        assert_eq!(posix_relative("/a/b", "/a/x.md"), "../x.md");
    }

    #[tokio::test]
    async fn a_rendered_file_is_its_checkouts_or_its_directorys() {
        let (root, target) =
            rendered_file_target(|_| async { Ok("/repo".to_owned()) }, "docs/a.md", "/repo")
                .await
                .unwrap();
        assert_eq!(root, "/repo");
        assert_eq!(target.to_value()["path"], "docs/a.md");
        let (root, _) =
            rendered_file_target(|_| async { Err("no git".to_owned()) }, "/tmp/x/a.md", "")
                .await
                .unwrap();
        assert_eq!(root, "/tmp/x");
        // A root that does not prefix the path (links resolved).
        let (root, target) =
            rendered_file_target(|_| async { Ok("/real/repo".to_owned()) }, "/link/a.md", "")
                .await
                .unwrap();
        assert_eq!(
            (root.as_str(), target.to_value()["path"].as_str()),
            ("/link", Some("a.md"))
        );
        assert!(
            rendered_file_target(|_| async { Ok("/".to_owned()) }, "rel.md", "")
                .await
                .is_err()
        );
        assert!(
            rendered_file_target(|_| async { Ok("/repo".to_owned()) }, "/repo/", "")
                .await
                .is_err()
        );
    }
}
