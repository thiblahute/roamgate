//! Unix sockets at any path length, as Bun's: a socket's address holds at
//! most 108 bytes (`SUN_LEN`; 104 on macOS), and a deep HOME (a test
//! world, a long user name, a sandbox under a temporary directory) makes
//! Roamgate's sockets longer than that. A path too long is reached through
//! a shorter one naming the same directory:
//!
//! - on Linux its directory's descriptor, `/proc/self/fd/N/name`;
//! - elsewhere (macOS, Windows) a link to its directory in a private
//!   directory of the temporary one (a symbolic link, a junction on
//!   Windows), removed once the socket is bound or connected.
//!
//! Binding and connecting both go through it ([`short_path`]); clients may
//! also reach a socket through a shorter link (the holder's `review.sock`).

use std::io;
use std::path::{Path, PathBuf};

/// The longest path the system takes whole in a socket address, its NUL
/// left out.
#[cfg(not(target_os = "macos"))]
const SUN_PATH_MAX: usize = 107;
#[cfg(target_os = "macos")]
const SUN_PATH_MAX: usize = 103;

/// A path naming the same socket as the one asked for, short enough for a
/// socket address while it lives.
pub struct ShortPath {
    path: PathBuf,
    _hold: Hold,
}

enum Hold {
    None,
    #[cfg(target_os = "linux")]
    Directory(#[allow(dead_code)] std::fs::File),
    #[cfg(not(target_os = "linux"))]
    Alias(#[allow(dead_code)] alias::Alias),
}

impl ShortPath {
    /// The path to bind or connect to.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Whether `path` fits a socket address as it is.
pub fn fits(path: &Path) -> bool {
    path.as_os_str().len() <= SUN_PATH_MAX
}

/// `path`, or while it is too long for a socket address a shorter path to
/// the same file (see the module's documentation). Hold it until the bind
/// or the connect returned.
pub fn short_path(path: &Path) -> io::Result<ShortPath> {
    let as_is = || ShortPath {
        path: path.to_owned(),
        _hold: Hold::None,
    };
    if fits(path) {
        return Ok(as_is());
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(as_is());
    };
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let directory = std::fs::File::open(parent)?;
        let short = Path::new("/proc/self/fd")
            .join(directory.as_raw_fd().to_string())
            .join(name);
        Ok(ShortPath {
            path: short,
            _hold: Hold::Directory(directory),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let alias = alias::Alias::new(parent, name.len())?;
        Ok(ShortPath {
            path: alias.directory().join(name),
            _hold: Hold::Alias(alias),
        })
    }
}

#[cfg(any(not(target_os = "linux"), test))]
mod alias {
    use std::io;
    use std::path::{Path, PathBuf};

    /// The temporary directories tried for the alias, in order.
    fn bases() -> Vec<PathBuf> {
        let temporary = std::env::temp_dir();
        #[cfg(unix)]
        return vec![temporary, PathBuf::from("/tmp")];
        #[cfg(not(unix))]
        vec![temporary]
    }

    /// What the alias adds before the socket's name: `/rgXXXXXX/d/`.
    const ALIAS_LENGTH: usize = 1 + 8 + 1 + 1 + 1;

    /// A link to a directory, `d` in a private directory of its own
    /// (0700 on Unix, the user's temporary directory's access on Windows):
    /// nobody else can make it name another directory.
    pub struct Alias {
        holder: Option<tempfile::TempDir>,
        link: PathBuf,
    }

    impl Alias {
        pub fn new(target: &Path, name_length: usize) -> io::Result<Self> {
            let target = std::path::absolute(target)?;
            let base = bases()
                .into_iter()
                .find(|base| {
                    base.as_os_str().len() + ALIAS_LENGTH + name_length <= super::SUN_PATH_MAX
                })
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "no temporary directory short enough for a socket's alias",
                    )
                })?;
            let mut builder = tempfile::Builder::new();
            builder.prefix("rg").rand_bytes(6);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                builder.permissions(std::fs::Permissions::from_mode(0o700));
            }
            let holder = builder.tempdir_in(&base)?;
            let link = holder.path().join("d");
            link_directory(&target, &link)?;
            Ok(Self {
                holder: Some(holder),
                link,
            })
        }

        /// The alias of the directory.
        pub fn directory(&self) -> &Path {
            &self.link
        }
    }

    impl Drop for Alias {
        fn drop(&mut self) {
            // The link alone, never what it names; then its directory.
            #[cfg(unix)]
            let _ = std::fs::remove_file(&self.link);
            #[cfg(windows)]
            let _ = std::fs::remove_dir(&self.link);
            if let Some(holder) = self.holder.take() {
                let _ = std::fs::remove_dir(holder.path());
                let _ = holder.close();
            }
        }
    }

    #[cfg(unix)]
    fn link_directory(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    /// A junction: unlike a symbolic link, any user may make one.
    #[cfg(windows)]
    fn link_directory(target: &Path, link: &Path) -> io::Result<()> {
        crate::junction::create(target, link)
    }
}

/// Binds a listener at `path`, however long. Blocking, as
/// [`std::os::unix::net::UnixListener::bind`]'s.
#[cfg(unix)]
pub fn bind_listener(path: &Path) -> io::Result<std::os::unix::net::UnixListener> {
    let short = short_path(path)?;
    std::os::unix::net::UnixListener::bind(short.path())
}

/// Binds a tokio listener at `path`, however long. Needs a tokio runtime.
#[cfg(unix)]
pub fn bind_tokio_listener(path: &Path) -> io::Result<tokio::net::UnixListener> {
    let listener = bind_listener(path)?;
    listener.set_nonblocking(true)?;
    tokio::net::UnixListener::from_std(listener)
}

/// Connects to the socket at `path`, however long.
#[cfg(unix)]
pub async fn connect(path: &Path) -> io::Result<tokio::net::UnixStream> {
    let short = short_path(path)?;
    tokio::net::UnixStream::connect(short.path()).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn deep_dir(base: &Path) -> PathBuf {
        let dir = base.join("d".repeat(60)).join("e".repeat(60));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn binds_a_path_longer_than_the_socket_address() {
        let base = tempfile::tempdir().unwrap();
        let path = deep_dir(base.path()).join("0123456789abcdef.sock.next");
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

    #[tokio::test]
    async fn connects_to_a_path_longer_than_the_socket_address() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let base = tempfile::tempdir().unwrap();
        let path = deep_dir(base.path()).join("core-1234.sock");
        let listener = bind_tokio_listener(&path).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"hi").await.unwrap();
        });
        let mut client = connect(&path).await.unwrap();
        let mut text = String::new();
        client.read_to_string(&mut text).await.unwrap();
        assert_eq!(text, "hi");
        server.await.unwrap();
    }

    /// macOS's and Windows' way, proven here too: a private alias of the
    /// directory, gone once the socket is bound.
    #[test]
    fn binds_and_connects_through_an_alias_of_the_directory() {
        let base = tempfile::tempdir().unwrap();
        let dir = deep_dir(base.path());
        let name = "0123456789abcdef.sock";
        let alias = alias::Alias::new(&dir, name.len()).unwrap();
        let short = alias.directory().join(name);
        assert!(fits(&short), "{}", short.display());
        let holder = alias.directory().parent().unwrap().to_owned();
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&holder).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        let listener = std::os::unix::net::UnixListener::bind(&short).unwrap();
        drop(alias);
        assert!(!holder.exists());
        assert!(dir.join(name).exists());
        let alias = alias::Alias::new(&dir, name.len()).unwrap();
        let mut client =
            std::os::unix::net::UnixStream::connect(alias.directory().join(name)).unwrap();
        drop(alias);
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
        let short = short_path(&path).unwrap();
        assert_eq!(short.path(), path);
        let _listener = bind_listener(&path).unwrap();
        assert!(path.exists());
    }
}
