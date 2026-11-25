//! The archive directory (archive/dir.ts): an explicit one as given, else
//! `<data root>/archive`, the legacy `claude-archive` renamed once.

use std::path::{Path, PathBuf};

/// The archive directory's name under the data root.
pub const ARCHIVE_DIR_NAME: &str = "archive";
/// What the default directory was called before it was renamed.
pub const LEGACY_ARCHIVE_DIR_NAME: &str = "claude-archive";

/// The archive directory: an explicit one (flag, env, setting) as given,
/// else `<data root>/archive`. A default directory that does not exist yet
/// while the legacy one does is renamed in place once (same parent, so
/// atomic).
pub fn resolve_archive_dir(
    explicit: Option<&str>,
    data_root: &Path,
    log: &mut dyn FnMut(&str),
) -> PathBuf {
    if let Some(given) = explicit.map(str::trim).filter(|given| !given.is_empty()) {
        return PathBuf::from(given);
    }
    let dir = data_root.join(ARCHIVE_DIR_NAME);
    let legacy = data_root.join(LEGACY_ARCHIVE_DIR_NAME);
    if !dir.exists() && legacy.exists() {
        match std::fs::rename(&legacy, &dir) {
            Ok(()) => log(&format!(
                "archive: renamed {} to {}",
                legacy.display(),
                dir.display()
            )),
            Err(error) => {
                log(&format!(
                    "archive: could not rename {} to {}: {}; using the old directory",
                    legacy.display(),
                    dir.display(),
                    crate::io_message(&error)
                ));
                return legacy;
            }
        }
    }
    dir
}

/// A warning when both the default directory and the legacy one exist.
pub fn legacy_archive_warning(archive_dir: &Path) -> Option<String> {
    let text = archive_dir.to_string_lossy();
    if archive_dir.file_name() != Some(std::ffi::OsStr::new(ARCHIVE_DIR_NAME)) {
        return None;
    }
    let legacy = archive_dir.parent()?.join(LEGACY_ARCHIVE_DIR_NAME);
    legacy.exists().then(|| {
        format!(
            "{} still exists next to {text}; {text} is used, merge or remove the old one",
            legacy.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_directory_wins_and_nothing_is_moved() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(LEGACY_ARCHIVE_DIR_NAME)).unwrap();
        let dir = resolve_archive_dir(Some(" /elsewhere "), root.path(), &mut |_| {});
        assert_eq!(dir, Path::new("/elsewhere"));
        assert!(root.path().join(LEGACY_ARCHIVE_DIR_NAME).exists());
    }

    #[test]
    fn the_default_is_archive_under_the_data_root() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_archive_dir(None, root.path(), &mut |_| {}),
            root.path().join("archive")
        );
    }

    #[test]
    fn the_legacy_directory_is_renamed_once_keeping_its_files() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(LEGACY_ARCHIVE_DIR_NAME);
        std::fs::create_dir_all(legacy.join("raw")).unwrap();
        std::fs::write(legacy.join("raw/x"), "x").unwrap();
        let mut logs = Vec::new();
        let dir = resolve_archive_dir(None, root.path(), &mut |line| logs.push(line.to_owned()));
        assert_eq!(dir, root.path().join("archive"));
        assert_eq!(std::fs::read_to_string(dir.join("raw/x")).unwrap(), "x");
        assert!(!legacy.exists());
        assert_eq!(logs.len(), 1);
        resolve_archive_dir(None, root.path(), &mut |line| logs.push(line.to_owned()));
        assert_eq!(logs.len(), 1);
    }

    #[test]
    fn with_both_present_the_new_one_is_used_and_health_warns() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join(LEGACY_ARCHIVE_DIR_NAME)).unwrap();
        std::fs::create_dir(root.path().join(ARCHIVE_DIR_NAME)).unwrap();
        let dir = resolve_archive_dir(None, root.path(), &mut |_| {});
        assert_eq!(dir, root.path().join("archive"));
        assert!(
            legacy_archive_warning(&dir)
                .unwrap()
                .contains("claude-archive still exists")
        );
    }
}
