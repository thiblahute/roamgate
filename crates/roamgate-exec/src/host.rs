//! The machine a workspace lives on, behind one trait (the plan's section
//! 6.2 and duplication cleanup 24): what the TS code did with an `if
//! (host)` fork everywhere (local-files against remote-files, path.ts's
//! branches, readTextFileMaybe, the process helpers' ssh routing).
//!
//! | Method | TS it replaces |
//! |---|---|
//! | `run` | runProcessWithCodeTimeout, runProcessWithInputTimeout, runBinaryProcessWithTimeout |
//! | `run_read` | the same through sshReadCommandArgv: no side effect, so an SSH host reruns it once cold when its master dies mid-command |
//! | `stream` | spawnStreamingProcess: output as it comes, no deadline, a long-lived session |
//! | `hold` | the Windows stdio bridges and other conversations on a child's stdin and stdout |
//! | `read_file`, `write_file`, `list` | local-files and the remote file helper's read, upload and list |
//!
//! [`Local`] runs on this machine. The SSH hosts (`Ssh`, `WindowsSsh`)
//! implement the same trait on the ssh module's command lines and slots:
//! a command's words are quoted for the remote shell ([`Host::shell`]) and
//! sent as one ssh command.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::process::{Command, ExecError, Output, ProcessRunner, Spawned};
use crate::quote::Shell;

pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a host is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKind {
    Local,
    /// A POSIX host over SSH, by its destination.
    Ssh(String),
    /// A Windows host over SSH (PowerShell), by its destination.
    WindowsSsh(String),
}

/// A directory entry, as `list` gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    /// Bytes, for a file.
    pub size: u64,
    /// Modification time, epoch milliseconds.
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error(transparent)]
    Exec(#[from] ExecError),
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: io::Error,
    },
    #[error("{path} is larger than {limit} bytes")]
    TooLarge { path: String, limit: u64 },
}

impl HostError {
    fn io(path: &Path, source: io::Error) -> Self {
        Self::Io {
            path: path.display().to_string(),
            source,
        }
    }
}

pub trait Host: Send + Sync {
    fn kind(&self) -> HostKind;

    /// The shell a command line for this host is quoted for.
    fn shell(&self) -> Shell;

    /// Runs a command to its end or its deadline. It may change things, so
    /// it is never rerun.
    fn run<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Output, ExecError>>;

    /// Runs a command with no side effect: an SSH host may rerun it once
    /// on a connection of its own when its master dies mid-command.
    fn run_read<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Output, ExecError>>;

    /// Starts a command whose output is read as it comes, with no deadline
    /// (a file sent whole); an SSH host gives it a long-lived session.
    fn stream<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Spawned, ExecError>>;

    /// Starts a command to talk with on its stdin and stdout (a bridge),
    /// with no deadline.
    fn hold<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Spawned, ExecError>>;

    /// A file's bytes, failing past `limit` bytes.
    fn read_file<'a>(
        &'a self,
        path: &'a Path,
        limit: u64,
    ) -> HostFuture<'a, Result<Vec<u8>, HostError>>;

    /// Writes a file whole: a temporary file beside it renamed over it,
    /// so a reader never sees half of it.
    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        bytes: &'a [u8],
    ) -> HostFuture<'a, Result<(), HostError>>;

    /// A directory's entries, sorted by name; symlinks are not followed.
    fn list<'a>(&'a self, path: &'a Path) -> HostFuture<'a, Result<Vec<Entry>, HostError>>;
}

/// This machine.
#[derive(Debug, Clone)]
pub struct Local {
    runner: ProcessRunner,
}

impl Local {
    pub fn new(runner: ProcessRunner) -> Self {
        Self { runner }
    }

    pub fn runner(&self) -> &ProcessRunner {
        &self.runner
    }
}

static TEMPORARY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn temporary_beside(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let unique = format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMPORARY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    path.with_file_name(unique)
}

impl Host for Local {
    fn kind(&self) -> HostKind {
        HostKind::Local
    }

    fn shell(&self) -> Shell {
        if cfg!(windows) {
            Shell::PowerShell
        } else {
            Shell::Posix
        }
    }

    fn run<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Output, ExecError>> {
        Box::pin(self.runner.run(command))
    }

    fn run_read<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Output, ExecError>> {
        // No master to lose locally: nothing to rerun.
        Box::pin(self.runner.run(command))
    }

    fn stream<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Spawned, ExecError>> {
        Box::pin(async move { self.runner.spawn(command, false) })
    }

    fn hold<'a>(&'a self, command: &'a Command) -> HostFuture<'a, Result<Spawned, ExecError>> {
        Box::pin(async move { self.runner.spawn(command, true) })
    }

    fn read_file<'a>(
        &'a self,
        path: &'a Path,
        limit: u64,
    ) -> HostFuture<'a, Result<Vec<u8>, HostError>> {
        Box::pin(async move {
            use tokio::io::AsyncReadExt;
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|error| HostError::io(path, error))?;
            let mut bytes = Vec::new();
            file.take(limit.saturating_add(1))
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| HostError::io(path, error))?;
            if bytes.len() as u64 > limit {
                return Err(HostError::TooLarge {
                    path: path.display().to_string(),
                    limit,
                });
            }
            Ok(bytes)
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a Path,
        bytes: &'a [u8],
    ) -> HostFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            let temporary = temporary_beside(path);
            let written = async {
                tokio::fs::write(&temporary, bytes).await?;
                tokio::fs::rename(&temporary, path).await
            }
            .await;
            if let Err(error) = written {
                let _ = tokio::fs::remove_file(&temporary).await;
                return Err(HostError::io(path, error));
            }
            Ok(())
        })
    }

    fn list<'a>(&'a self, path: &'a Path) -> HostFuture<'a, Result<Vec<Entry>, HostError>> {
        Box::pin(async move {
            let mut reader = tokio::fs::read_dir(path)
                .await
                .map_err(|error| HostError::io(path, error))?;
            let mut entries = Vec::new();
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|error| HostError::io(path, error))?
            {
                let Ok(meta) = tokio::fs::symlink_metadata(entry.path()).await else {
                    continue;
                };
                let kind = if meta.file_type().is_symlink() {
                    EntryKind::Symlink
                } else if meta.is_dir() {
                    EntryKind::Directory
                } else if meta.is_file() {
                    EntryKind::File
                } else {
                    EntryKind::Other
                };
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|since| since.as_millis() as i64);
                entries.push(Entry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind,
                    size: if kind == EntryKind::File {
                        meta.len()
                    } else {
                        0
                    },
                    modified_ms,
                });
            }
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(entries)
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn local() -> Arc<dyn Host> {
        Arc::new(Local::new(ProcessRunner::new(Arc::new(
            roamgate_base::clock::TokioClock::starting_at(0),
        ))))
    }

    #[tokio::test]
    async fn the_local_host_runs_commands_as_they_are() {
        let host = local();
        assert_eq!(host.kind(), HostKind::Local);
        assert_eq!(host.shell(), Shell::Posix);
        let output = host
            .run(&Command::new([
                "sh",
                "-c",
                "printf %s \"$1\"",
                "sh",
                "a 'b'",
            ]))
            .await
            .unwrap();
        assert_eq!(output.stdout_text(), "a 'b'");
        let read = host.run_read(&Command::new(["true"])).await.unwrap();
        assert_eq!(read.code, 0);
    }

    #[tokio::test]
    async fn the_local_host_streams_and_holds_children() {
        let host = local();
        let mut streamed = host
            .stream(&Command::new(["sh", "-c", "printf streamed"]))
            .await
            .unwrap();
        let mut text = String::new();
        streamed
            .stdout()
            .unwrap()
            .read_to_string(&mut text)
            .await
            .unwrap();
        assert_eq!(text, "streamed");
        assert_eq!(streamed.wait().await.unwrap(), 0);

        let mut held = host.hold(&Command::new(["cat"])).await.unwrap();
        let mut stdin = held.stdin().unwrap();
        let mut stdout = held.stdout().unwrap();
        stdin.write_all(&[0, 255, 13, 10]).await.unwrap();
        let mut echoed = [0u8; 4];
        stdout.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed, [0, 255, 13, 10]);
        drop(stdin);
        assert_eq!(held.wait().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn the_local_host_reads_writes_and_lists_files() {
        let host = local();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        host.write_file(&file, b"hello").await.unwrap();
        host.write_file(&file, b"hello again").await.unwrap();
        assert_eq!(host.read_file(&file, 100).await.unwrap(), b"hello again");
        assert!(matches!(
            host.read_file(&file, 3).await,
            Err(HostError::TooLarge { limit: 3, .. })
        ));
        assert!(matches!(
            host.read_file(&dir.path().join("none"), 3).await,
            Err(HostError::Io { .. })
        ));
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::os::unix::fs::symlink(&file, dir.path().join("link")).unwrap();
        let entries = host.list(dir.path()).await.unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind, entry.size))
            .collect();
        assert_eq!(
            summary,
            [
                ("a.txt", EntryKind::File, 11),
                ("link", EntryKind::Symlink, 0),
                ("sub", EntryKind::Directory, 0)
            ]
        );
        assert!(entries[0].modified_ms.is_some());
    }
}
