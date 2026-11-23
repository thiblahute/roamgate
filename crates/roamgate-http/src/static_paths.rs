//! The web app's paths (http/static-paths.ts): the decoded path of a
//! request, kept inside the public directory, and when the SPA entry
//! answers.

use std::path::{Component, Path, PathBuf};

use crate::response::decode_uri_component;

/// The decoded path, `/index.html` for `/`; `None` when malformed or
/// holding a NUL.
pub fn decode_static_pathname(raw: &str) -> Option<String> {
    let pathname = decode_uri_component(raw)?;
    if pathname.contains('\0') {
        return None;
    }
    Some(if pathname == "/" {
        "/index.html".into()
    } else {
        pathname
    })
}

/// `path.resolve`'s lexical normalisation: `.` and `..` folded, no file
/// system access.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        normalize(&std::env::current_dir().unwrap_or_default().join(path))
    }
}

/// The file `pathname` names under `public_dir`, or `None` when it would
/// leave it.
pub fn resolve_public_file_path(public_dir: &Path, pathname: &str) -> Option<PathBuf> {
    let root = absolute(public_dir);
    let candidate = normalize(&root.join(format!(".{pathname}")));
    candidate.strip_prefix(&root).ok()?;
    Some(candidate)
}

pub fn is_static_request_method(method: &str) -> bool {
    method == "GET" || method == "HEAD"
}

/// A browser page navigation: the SPA entry answers any path.
pub fn should_serve_spa_entry(method: &str, accept: Option<&str>) -> bool {
    is_static_request_method(method) && accept.is_some_and(|accept| accept.contains("text/html"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_entry_document_and_decodes_asset_paths() {
        assert_eq!(decode_static_pathname("/").as_deref(), Some("/index.html"));
        assert_eq!(
            decode_static_pathname("/assets/app%20icon.svg").as_deref(),
            Some("/assets/app icon.svg")
        );
    }

    #[test]
    fn rejects_malformed_encoding_and_nul_bytes() {
        assert_eq!(decode_static_pathname("/%E0%A4%A"), None);
        assert_eq!(decode_static_pathname("/asset%00.js"), None);
    }

    #[test]
    fn keeps_resolved_files_inside_the_public_directory() {
        assert_eq!(
            resolve_public_file_path(Path::new("/srv/public"), "/assets/app.js"),
            Some(PathBuf::from("/srv/public/assets/app.js"))
        );
        assert_eq!(
            resolve_public_file_path(Path::new("/srv/public"), "/../secret"),
            None
        );
        assert_eq!(
            resolve_public_file_path(Path::new("/srv/public"), "/../public2/x"),
            None
        );
        assert_eq!(
            resolve_public_file_path(Path::new("/srv/public/"), "/a/../b"),
            Some(PathBuf::from("/srv/public/b"))
        );
    }

    #[test]
    fn uses_the_spa_entry_only_for_browser_page_navigations() {
        assert!(should_serve_spa_entry(
            "GET",
            Some("text/html,application/xhtml+xml")
        ));
        assert!(should_serve_spa_entry("HEAD", Some("text/html")));
        assert!(!should_serve_spa_entry("GET", Some("*/*")));
        assert!(!should_serve_spa_entry("POST", Some("text/html")));
        assert!(!should_serve_spa_entry("GET", None));
    }

    #[test]
    fn only_serves_static_content_for_read_only_http_methods() {
        assert!(is_static_request_method("GET"));
        assert!(is_static_request_method("HEAD"));
        assert!(!is_static_request_method("POST"));
    }
}
