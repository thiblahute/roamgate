//! Where the channel runs: a Unix socket, or a named pipe on Windows. The
//! spawner listens and its child connects (contract/wire/core-channel.md,
//! Process), so the socket exists before the child starts.

use std::io;

use tokio::io::{AsyncRead, AsyncWrite};

/// A connected channel stream.
pub trait ChannelStream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> ChannelStream for T {}

pub type BoxStream = Box<dyn ChannelStream>;

/// Whether a channel address is a Windows named pipe.
pub fn is_named_pipe(address: &str) -> bool {
    address.starts_with(r"\\.\pipe\")
}

/// Connects to the front's channel.
pub async fn connect(address: &str) -> io::Result<BoxStream> {
    #[cfg(windows)]
    if is_named_pipe(address) {
        return windows::connect(address).await;
    }
    #[cfg(unix)]
    {
        let stream = tokio::net::UnixStream::connect(address).await?;
        Ok(Box::new(stream))
    }
    #[cfg(not(unix))]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!("not a named pipe: {address}"),
    ))
}

/// A listening channel endpoint (the spawner's side).
pub struct Listener {
    #[cfg(unix)]
    unix: Option<(tokio::net::UnixListener, std::path::PathBuf)>,
    #[cfg(windows)]
    pipe: Option<windows::PipeListener>,
}

impl Listener {
    /// Listens on `address`; a stale socket file there is replaced.
    pub fn bind(address: &str) -> io::Result<Self> {
        #[cfg(windows)]
        if is_named_pipe(address) {
            return Ok(Self {
                pipe: Some(windows::PipeListener::bind(address)?),
            });
        }
        #[cfg(unix)]
        {
            let path = std::path::PathBuf::from(address);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let listener = tokio::net::UnixListener::bind(&path)?;
            Ok(Self {
                unix: Some((listener, path)),
            })
        }
        #[cfg(not(unix))]
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("not a named pipe: {address}"),
        ))
    }

    /// The next connection.
    pub async fn accept(&mut self) -> io::Result<BoxStream> {
        #[cfg(unix)]
        if let Some((listener, _)) = &self.unix {
            let (stream, _) = listener.accept().await?;
            return Ok(Box::new(stream));
        }
        #[cfg(windows)]
        if let Some(pipe) = &mut self.pipe {
            return pipe.accept().await;
        }
        Err(io::Error::other("listener closed"))
    }
}

#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        if let Some((_, path)) = self.unix.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::time::Duration;

    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    use super::BoxStream;

    /// ERROR_PIPE_BUSY: every instance is taken, try again shortly.
    const ERROR_PIPE_BUSY: i32 = 231;

    #[allow(clippy::disallowed_methods)]
    pub async fn connect(name: &str) -> io::Result<BoxStream> {
        for _ in 0..50 {
            match ClientOptions::new().open(name) {
                Ok(client) => return Ok(Box::new(client)),
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

    pub struct PipeListener {
        name: String,
        next: NamedPipeServer,
    }

    impl PipeListener {
        pub fn bind(name: &str) -> io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(name)?;
            Ok(Self {
                name: name.to_owned(),
                next,
            })
        }

        pub async fn accept(&mut self) -> io::Result<BoxStream> {
            self.next.connect().await?;
            let fresh = ServerOptions::new().create(&self.name)?;
            let connected = std::mem::replace(&mut self.next, fresh);
            Ok(Box::new(connected))
        }
    }
}
