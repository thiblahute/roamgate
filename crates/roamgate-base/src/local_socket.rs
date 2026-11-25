//! Local stream sockets on every platform the server runs on, as Bun had
//! them: a Unix socket at a file path (on Windows too: Bun's `unix:`
//! listeners and the Python clients use `AF_UNIX`, which Windows 10 has
//! since 1803), and Windows named pipes where Bun used node:net's (the core
//! channel, Herdr's sockets).
//!
//! On Unix a [`Listener`] is tokio's, bound at any path length
//! ([`crate::unix_socket`]). On Windows tokio has no `AF_UNIX`: the socket
//! is socket2's, its readiness async-io's.

use std::io;
use std::path::Path;

/// Whether `address` names a Windows named pipe (`\\.\pipe\...` or
/// `\\?\pipe\...`, any case), as Bun's `nativeSocketPath` tells them.
pub fn is_named_pipe(address: &str) -> bool {
    let lower = address.to_ascii_lowercase();
    lower.starts_with(r"\\.\pipe\") || lower.starts_with(r"\\?\pipe\")
}

/// A connected local socket.
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub type Stream = windows::UnixStream;

/// A Unix socket listener at a file path.
pub struct Listener {
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
    #[cfg(windows)]
    inner: windows::UnixListener,
}

impl Listener {
    /// Listens at `path` (whatever is there must be removed first). Needs a
    /// tokio runtime.
    pub fn bind(path: &Path) -> io::Result<Self> {
        #[cfg(unix)]
        let inner = crate::unix_socket::bind_tokio_listener(path)?;
        #[cfg(windows)]
        let inner = windows::UnixListener::bind(path)?;
        Ok(Self { inner })
    }

    /// The next connection.
    pub async fn accept(&self) -> io::Result<Stream> {
        #[cfg(unix)]
        let stream = self.inner.accept().await?.0;
        #[cfg(windows)]
        let stream = self.inner.accept().await?;
        Ok(stream)
    }
}

/// Connects to the Unix socket at `path`.
pub async fn connect(path: &Path) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await
    }
    #[cfg(windows)]
    {
        windows::UnixStream::connect(path).await
    }
}

/// A connected local socket that blocks, each read and write within the
/// timeout it was given (`roamgate-review` and `roamgate-hold`, which run
/// no async runtime).
pub struct BlockingStream {
    #[cfg(unix)]
    inner: std::os::unix::net::UnixStream,
    #[cfg(windows)]
    inner: socket2::Socket,
}

/// Connects to the Unix socket at `path` (`AF_UNIX` on Windows too, as
/// [`connect`]), each read and write then failing with `TimedOut` or
/// `WouldBlock` after `timeout`.
pub fn connect_blocking(path: &Path, timeout: std::time::Duration) -> io::Result<BlockingStream> {
    #[cfg(unix)]
    let inner = std::os::unix::net::UnixStream::connect(path)?;
    #[cfg(windows)]
    let inner = {
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
        socket.connect(&socket2::SockAddr::unix(path)?)?;
        socket
    };
    inner.set_read_timeout(Some(timeout))?;
    inner.set_write_timeout(Some(timeout))?;
    Ok(BlockingStream { inner })
}

impl io::Read for BlockingStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl io::Write for BlockingStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(windows)]
pub use windows::{PipeListener, connect_pipe};

#[cfg(windows)]
mod windows {
    use std::io;
    use std::net::Shutdown;
    use std::path::Path;
    use std::pin::Pin;
    use std::task::{Context, Poll, ready};
    use std::time::Duration;

    use async_io::Async;
    use socket2::{Domain, SockAddr, Socket, Type};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };

    /// `ERROR_PIPE_BUSY`: every instance of the pipe is taken; another
    /// comes shortly.
    const ERROR_PIPE_BUSY: i32 = 231;

    /// Opens the named pipe `name`, waiting while every instance is busy
    /// (real time: no test clock moves a pipe's other end).
    #[allow(clippy::disallowed_methods)]
    pub async fn connect_pipe(name: &str) -> io::Result<NamedPipeClient> {
        for _ in 0..50 {
            match ClientOptions::new().open(name) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("{name} stayed busy"),
        ))
    }

    /// A named pipe server: one instance waits for the next client.
    pub struct PipeListener {
        name: String,
        next: NamedPipeServer,
    }

    impl PipeListener {
        /// Creates the pipe; fails when another process has it.
        pub fn bind(name: &str) -> io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(name)?;
            Ok(Self {
                name: name.to_owned(),
                next,
            })
        }

        /// The next client's connection.
        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            self.next.connect().await?;
            let fresh = ServerOptions::new().create(&self.name)?;
            Ok(std::mem::replace(&mut self.next, fresh))
        }
    }

    fn unix_socket() -> io::Result<Socket> {
        Socket::new(Domain::UNIX, Type::STREAM, None)
    }

    /// An `AF_UNIX` listener.
    pub struct UnixListener(Async<Socket>);

    impl UnixListener {
        pub fn bind(path: &Path) -> io::Result<Self> {
            let socket = unix_socket()?;
            socket.bind(&SockAddr::unix(path)?)?;
            socket.listen(1024)?;
            Ok(Self(Async::new(socket)?))
        }

        pub async fn accept(&self) -> io::Result<UnixStream> {
            let (socket, _) = self.0.read_with(|socket| socket.accept()).await?;
            Ok(UnixStream(Async::new(socket)?))
        }
    }

    /// An `AF_UNIX` stream, as tokio's I/O traits.
    pub struct UnixStream(Async<Socket>);

    impl UnixStream {
        pub async fn connect(path: &Path) -> io::Result<Self> {
            let socket = unix_socket()?;
            let address = SockAddr::unix(path)?;
            socket.set_nonblocking(true)?;
            match socket.connect(&address) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error),
            }
            let socket = Async::new(socket)?;
            socket.writable().await?;
            if let Some(error) = socket.get_ref().take_error()? {
                return Err(error);
            }
            Ok(Self(socket))
        }
    }

    impl AsyncRead for UnixStream {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let unfilled = buf.initialize_unfilled();
            let read = ready!(futures_io::AsyncRead::poll_read(
                Pin::new(&mut &self.0),
                cx,
                unfilled
            ))?;
            buf.advance(read);
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for UnixStream {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            futures_io::AsyncWrite::poll_write(Pin::new(&mut &self.0), cx, buf)
        }

        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            futures_io::AsyncWrite::poll_flush(Pin::new(&mut &self.0), cx)
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(self.0.get_ref().shutdown(Shutdown::Write))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn tells_named_pipes() {
        assert!(is_named_pipe(r"\\.\pipe\roamgate-core-1-ab"));
        assert!(is_named_pipe(r"\\?\PIPE\herdr"));
        assert!(!is_named_pipe("/run/user/1000/core-1.sock"));
        assert!(!is_named_pipe(r"C:\Users\me\review.sock"));
    }

    /// Runs on Unix and, built for Windows, on Windows (AF_UNIX).
    #[tokio::test]
    async fn a_client_reaches_a_listener_at_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock");
        let listener = Listener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            let mut line = [0u8; 4];
            stream.read_exact(&mut line).await.unwrap();
            stream.write_all(b"pong").await.unwrap();
            stream.shutdown().await.unwrap();
            line
        });
        let mut client = connect(&path).await.unwrap();
        client.write_all(b"ping").await.unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).await.unwrap();
        assert_eq!(reply, "pong");
        assert_eq!(&server.await.unwrap(), b"ping");
    }

    /// The blocking client of `roamgate-review` reaches the same listener.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_blocking_client_reaches_a_listener_at_a_path() {
        use std::io::{Read, Write};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock");
        let listener = Listener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            let mut line = [0u8; 4];
            stream.read_exact(&mut line).await.unwrap();
            stream.write_all(b"pong").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let reply = tokio::task::spawn_blocking(move || {
            let mut client = connect_blocking(&path, std::time::Duration::from_secs(10)).unwrap();
            client.write_all(b"ping").unwrap();
            let mut reply = String::new();
            client.read_to_string(&mut reply).unwrap();
            reply
        })
        .await
        .unwrap();
        assert_eq!(reply, "pong");
        server.await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_client_reaches_a_named_pipe() {
        let name = format!(r"\\.\pipe\roamgate-test-{}", std::process::id());
        let mut listener = PipeListener::bind(&name).unwrap();
        let server = tokio::spawn(async move {
            let mut pipe = listener.accept().await.unwrap();
            pipe.write_all(b"hi").await.unwrap();
        });
        let mut client = connect_pipe(&name).await.unwrap();
        let mut text = [0u8; 2];
        client.read_exact(&mut text).await.unwrap();
        assert_eq!(&text, b"hi");
        server.await.unwrap();
    }
}
