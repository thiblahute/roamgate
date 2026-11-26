//! The mkdir lock proper-lockfile takes (v4, as `lockSync(file, {realpath:
//! false, ...})`), so that a Rust process and the Bun server exclude each
//! other on the same files (the plan's section 8.2: the session secret and
//! pi-durable).
//!
//! - The lock is the directory `<file>.lock`, made with mkdir: whoever
//!   creates it holds the lock.
//! - The holder sets the directory's mtime when it takes the lock and then
//!   every `update`, so that others can tell a live lock from an abandoned
//!   one.
//! - Another process finding the directory treats it as held, unless
//!   `stale` is set and its mtime is older than that: it is then removed
//!   and taken.
//! - Releasing removes the directory.
//!
//! The lock's times are the real clock's, on purpose: other processes
//! compare the directory's mtime with their own real clock, and the wait
//! for a holder bounds real I/O (contract/wire/test-clock.md, "What stays
//! real").

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

/// proper-lockfile's options that matter here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockOptions {
    /// A lock whose mtime is older than this is abandoned and taken over;
    /// None never takes one over (proper-lockfile's `stale: Infinity`).
    pub stale: Option<Duration>,
    /// How often the holder refreshes the mtime.
    pub update: Duration,
}

impl Default for LockOptions {
    /// proper-lockfile's defaults: stale after 10 s, updated every 5 s.
    fn default() -> Self {
        Self {
            stale: Some(Duration::from_secs(10)),
            update: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LockError {
    /// Another process holds it (proper-lockfile's ELOCKED).
    #[error("Lock file is already being held: {}", .0.display())]
    Locked(PathBuf),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// `<file>.lock`.
pub fn lock_path(file: &Path) -> PathBuf {
    let mut path = file.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

#[allow(clippy::disallowed_methods)]
fn real_now() -> SystemTime {
    SystemTime::now()
}

fn open_dir(path: &Path) -> io::Result<std::fs::File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS: needed to open a directory.
        std::fs::File::options()
            .write(true)
            .custom_flags(0x0200_0000)
            .open(path)
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(path)
    }
}

fn touch(path: &Path, time: SystemTime) -> io::Result<()> {
    open_dir(path)?.set_times(
        std::fs::FileTimes::new()
            .set_modified(time)
            .set_accessed(time),
    )
}

/// A held lock; released when dropped.
#[derive(Debug)]
pub struct LockGuard {
    path: PathBuf,
    stop: Option<mpsc::Sender<()>>,
    updater: Option<JoinHandle<()>>,
    compromised: Arc<AtomicBool>,
}

impl LockGuard {
    /// The lock directory.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the lock directory vanished while held (proper-lockfile's
    /// ECOMPROMISED): someone removed it by hand, or took it over as stale.
    pub fn compromised(&self) -> bool {
        self.compromised.load(Ordering::SeqCst)
    }

    /// Releases the lock now (dropping does the same).
    pub fn release(mut self) -> io::Result<()> {
        self.stop_updates();
        let result = std::fs::remove_dir(&self.path);
        self.path = PathBuf::new();
        match result {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn stop_updates(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(updater) = self.updater.take() {
            let _ = updater.join();
        }
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.stop_updates();
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_dir(&self.path);
        }
    }
}

/// One attempt at the lock of `file`.
pub fn try_lock(file: &Path, options: LockOptions) -> Result<LockGuard, LockError> {
    let path = lock_path(file);
    let mut check_stale = options.stale.is_some();
    loop {
        match std::fs::create_dir(&path) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let (true, Some(stale)) = (check_stale, options.stale) else {
                    return Err(LockError::Locked(path));
                };
                let modified = match std::fs::metadata(&path) {
                    Ok(metadata) => metadata.modified()?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        check_stale = false;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                let fresh = real_now()
                    .checked_sub(stale)
                    .is_none_or(|limit| modified >= limit);
                if fresh {
                    return Err(LockError::Locked(path));
                }
                match std::fs::remove_dir(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                check_stale = false;
            }
            // Windows refuses a directory whose last holder's removal is
            // still pending (Access is denied): held, for a moment more.
            Err(error) if cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(LockError::Locked(path));
            }
            Err(error) => return Err(error.into()),
        }
    }
    if let Err(error) = touch(&path, real_now()) {
        let _ = std::fs::remove_dir(&path);
        return Err(error.into());
    }
    let compromised = Arc::new(AtomicBool::new(false));
    let (stop, stopped) = mpsc::channel::<()>();
    let updater = {
        let path = path.clone();
        let compromised = compromised.clone();
        let every = options.update.max(Duration::from_millis(1));
        std::thread::Builder::new()
            .name("roamgate-lock".into())
            .spawn(move || {
                while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(every) {
                    if let Err(error) = touch(&path, real_now())
                        && error.kind() == io::ErrorKind::NotFound
                    {
                        compromised.store(true, Ordering::SeqCst);
                        return;
                    }
                }
            })?
    };
    Ok(LockGuard {
        path,
        stop: Some(stop),
        updater: Some(updater),
        compromised,
    })
}

/// The lock of `file`, retrying every `poll` while another process holds
/// it, for at most `wait` (then [`LockError::Locked`]).
#[allow(clippy::disallowed_methods)]
pub fn lock_waiting(
    file: &Path,
    options: LockOptions,
    wait: Duration,
    poll: Duration,
) -> Result<LockGuard, LockError> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        match try_lock(file, options) {
            Err(LockError::Locked(path)) => {
                if std::time::Instant::now() >= deadline {
                    return Err(LockError::Locked(path));
                }
                std::thread::sleep(poll);
            }
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_is_a_directory_held_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let options = LockOptions {
            stale: None,
            update: Duration::from_millis(20),
        };
        let held = try_lock(&file, options).unwrap();
        assert_eq!(held.path(), dir.path().join("state.json.lock"));
        assert!(held.path().is_dir());
        assert!(matches!(
            try_lock(&file, options),
            Err(LockError::Locked(_))
        ));
        // Refreshed every 20 ms; a loaded machine may take longer to run it.
        let before = std::fs::metadata(held.path()).unwrap().modified().unwrap();
        let mut after = before;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(40));
            after = std::fs::metadata(held.path()).unwrap().modified().unwrap();
            if after > before {
                break;
            }
        }
        assert!(after > before, "the holder refreshes the mtime");
        drop(held);
        assert!(!dir.path().join("state.json.lock").exists());
        try_lock(&file, options).unwrap().release().unwrap();
        assert!(!dir.path().join("state.json.lock").exists());
    }

    #[test]
    fn a_stale_lock_is_taken_over_only_when_stale_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state");
        std::fs::create_dir(lock_path(&file)).unwrap();
        touch(&lock_path(&file), SystemTime::UNIX_EPOCH).unwrap();
        let never = LockOptions {
            stale: None,
            update: Duration::from_secs(1),
        };
        assert!(matches!(try_lock(&file, never), Err(LockError::Locked(_))));
        let held = try_lock(&file, LockOptions::default()).unwrap();
        // Freshly touched: no longer stale for anyone.
        assert!(matches!(
            try_lock(&file, LockOptions::default()),
            Err(LockError::Locked(_))
        ));
        drop(held);
    }

    #[test]
    fn waiting_gives_up_at_its_deadline_and_sees_a_release() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state");
        let options = LockOptions {
            stale: None,
            update: Duration::from_secs(1),
        };
        let held = try_lock(&file, options).unwrap();
        assert!(matches!(
            lock_waiting(
                &file,
                options,
                Duration::from_millis(60),
                Duration::from_millis(10)
            ),
            Err(LockError::Locked(_))
        ));
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        lock_waiting(
            &file,
            options,
            Duration::from_secs(5),
            Duration::from_millis(10),
        )
        .unwrap();
        releaser.join().unwrap();
    }

    #[test]
    fn a_removed_lock_is_compromised() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state");
        let held = try_lock(
            &file,
            LockOptions {
                stale: None,
                update: Duration::from_millis(10),
            },
        )
        .unwrap();
        std::fs::remove_dir(held.path()).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        assert!(held.compromised());
    }
}
