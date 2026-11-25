//! One lock per host in the archive directory (archive/lock.ts), so a pull
//! and a push of the same host never run together: `locks/<host>.lock`
//! holding the pid, taken over when its process is gone or after 12 hours.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A lock older than this is taken over even if its process looks alive.
const STALE: Duration = Duration::from_secs(12 * 60 * 60);

/// A held lock; released when dropped.
#[derive(Debug)]
pub struct HostLock {
    path: PathBuf,
}

impl Drop for HostLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn lock_name(host: &str) -> String {
    host.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Takes the lock of `host`, or None when another sync holds it.
pub fn acquire_host_lock(archive_dir: &Path, host: &str) -> std::io::Result<Option<HostLock>> {
    let dir = archive_dir.join("locks");
    roamgate_base::private::create_dir_all_mode(&dir)?;
    let path = dir.join(format!("{}.lock", lock_name(host)));
    for _ in 0..2 {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(&path) {
            Ok(mut file) => {
                file.write_all(std::process::id().to_string().as_bytes())?;
                return Ok(Some(HostLock { path }));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(metadata) = std::fs::metadata(&path) else {
                    continue;
                };
                let age = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .unwrap_or_default();
                // Number(""): 0, no holder.
                let holder: i32 = text.trim().parse().unwrap_or(0);
                if holder != 0 && roamgate_base::process::pid_alive(holder) && age < STALE {
                    return Ok(None);
                }
                let _ = std::fs::remove_file(&path);
            }
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_locks_are_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire_host_lock(dir.path(), "mac").unwrap();
        assert!(first.is_some());
        assert!(acquire_host_lock(dir.path(), "mac").unwrap().is_none());
        assert!(acquire_host_lock(dir.path(), "other").unwrap().is_some());
        drop(first);
        assert!(acquire_host_lock(dir.path(), "mac").unwrap().is_some());
    }

    #[test]
    fn a_dead_holder_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("locks")).unwrap();
        std::fs::write(dir.path().join("locks/mac.lock"), "999999999").unwrap();
        assert!(acquire_host_lock(dir.path(), "mac").unwrap().is_some());
    }
}
