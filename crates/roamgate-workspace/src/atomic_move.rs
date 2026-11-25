//! A move that never replaces what is at its destination
//! (workspace/atomic-file-move.ts): the host's atomic primitive, here
//! `renameat2(RENAME_NOREPLACE)` on Linux and `renamex_np(RENAME_EXCL)` on
//! macOS through rustix; over SSH Python's, by `exclusive-rename.py`.

use std::path::Path;

use crate::connection::WorkspaceError;
use crate::file_paths::errno_name;

/// The script an SSH host moves with (`REMOTE_EXCLUSIVE_RENAME`).
pub const REMOTE_EXCLUSIVE_RENAME: &str = roamgate_base::assets::EXCLUSIVE_RENAME_PY;

fn move_error(error: &std::io::Error, source: &Path, target: &Path) -> WorkspaceError {
    let (code, _) = errno_name(error);
    WorkspaceError::new(format!(
        "{code}: cannot move {} to {}",
        source.display(),
        target.display()
    ))
}

/// `renameFileExclusive`: moves `source` to `target` unless something is
/// there, in one step, never across file systems.
pub fn rename_file_exclusive(source: &Path, target: &Path) -> Result<(), WorkspaceError> {
    if source == target {
        return Err(WorkspaceError::new("Source and destination are identical"));
    }
    #[cfg(test)]
    tests::before_rename(source);
    rename_noreplace(source, target).map_err(|error| move_error(&error, source, target))?;
    #[cfg(test)]
    tests::after_rename(source);
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_noreplace(source: &Path, target: &Path) -> std::io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    // rustix names macOS's `RENAME_EXCL` `NOREPLACE` too.
    renameat_with(CWD, source, CWD, target, RenameFlags::NOREPLACE).map_err(std::io::Error::from)
}

/// Windows: a second name, then the first one gone; the link fails when
/// the destination exists or is on another volume, as `MoveFileExW`
/// without flags does.
#[cfg(windows)]
fn rename_noreplace(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::hard_link(source, target)?;
    std::fs::remove_file(source)
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple",
    windows
)))]
fn rename_noreplace(_: &Path, _: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "Atomic file moves are unsupported on this host",
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::Path;
    use std::sync::Mutex;

    type Hook = Box<dyn Fn(&Path) + Send>;

    /// What a test runs just before and after the move (a save racing it).
    pub(crate) static HOOKS: Mutex<Option<(Hook, Hook)>> = Mutex::new(None);

    pub(crate) fn before_rename(source: &Path) {
        if let Some((before, _)) = HOOKS.lock().unwrap().as_ref() {
            before(source);
        }
    }

    pub(crate) fn after_rename(source: &Path) {
        if let Some((_, after)) = HOOKS.lock().unwrap().as_ref() {
            after(source);
        }
    }

    #[test]
    fn never_replaces_a_destination() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let error = super::rename_file_exclusive(&a, &b).unwrap_err();
        assert!(error.message.starts_with("EEXIST: cannot move"), "{error}");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b");
        std::fs::remove_file(&b).unwrap();
        super::rename_file_exclusive(&a, &b).unwrap();
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "a");
        assert!(!a.exists());
    }
}
