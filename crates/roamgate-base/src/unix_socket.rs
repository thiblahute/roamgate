//! Unix socket listeners at any path length, as Bun's: a socket's address
//! holds at most 108 bytes on Linux (`SUN_LEN`), and a deep HOME (a test
//! world, a long user name) makes Roamgate's sockets longer than that. On
//! Linux a path too long is bound through its directory's descriptor
//! (`/proc/self/fd/N/name`); clients reach it through a shorter link (the
//! holder's `review.sock`) or the same way.

use std::os::unix::net::UnixListener;
use std::path::Path;

/// The longest path the kernel takes whole in a socket address, its NUL
/// left out (Linux 108 bytes, macOS 104).
#[cfg(target_os = "linux")]
const SUN_PATH_MAX: usize = 107;

/// Binds a listener at `path`, however long. Blocking, as
/// [`UnixListener::bind`]'s.
pub fn bind_listener(path: &Path) -> std::io::Result<UnixListener> {
    #[cfg(target_os = "linux")]
    if path.as_os_str().len() > SUN_PATH_MAX {
        return bind_through_directory(path);
    }
    UnixListener::bind(path)
}

/// Binds a tokio listener at `path`, however long. Needs a tokio runtime.
pub fn bind_tokio_listener(path: &Path) -> std::io::Result<tokio::net::UnixListener> {
    let listener = bind_listener(path)?;
    listener.set_nonblocking(true)?;
    tokio::net::UnixListener::from_std(listener)
}

#[cfg(target_os = "linux")]
fn bind_through_directory(path: &Path) -> std::io::Result<UnixListener> {
    use std::os::fd::AsRawFd;
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return UnixListener::bind(path);
    };
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let directory = std::fs::File::open(parent)?;
    let short = Path::new("/proc/self/fd")
        .join(directory.as_raw_fd().to_string())
        .join(name);
    UnixListener::bind(short)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Linux only: macOS keeps its 104-byte socket addresses (as Bun did).
    #[test]
    #[cfg(target_os = "linux")]
    fn binds_a_path_longer_than_the_socket_address() {
        use std::io::{Read, Write};
        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("d".repeat(60)).join("e".repeat(60));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("0123456789abcdef.sock.next");
        assert!(path.as_os_str().len() > 108);
        let listener = bind_listener(&path).unwrap();
        assert!(path.exists());
        // A client reaches it through a shorter link, as the holder does.
        let link = base.path().join("link.sock");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let mut client = std::os::unix::net::UnixStream::connect(&link).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        accepted.write_all(b"hi").unwrap();
        drop(accepted);
        let mut text = String::new();
        client.read_to_string(&mut text).unwrap();
        assert_eq!(text, "hi");
    }

    #[test]
    fn binds_a_short_path_as_is() {
        let base = tempfile::tempdir().unwrap();
        let path = base.path().join("s.sock");
        let _listener = bind_listener(&path).unwrap();
        assert!(path.exists());
    }
}
