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
pub use roamgate_base::local_socket::is_named_pipe;

/// Where a front of pid `pid` listens for its core (the contract's
/// "Process"): `core-<pid>.sock` in `runtime_dir`, on Windows the named pipe
/// `\\.\pipe\roamgate-core-<pid>-<16 random hex digits>`.
pub fn channel_address(runtime_dir: &std::path::Path, pid: u32) -> String {
    #[cfg(windows)]
    {
        let _ = runtime_dir;
        let random: [u8; 8] = rand::random();
        let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        format!(r"\\.\pipe\roamgate-core-{pid}-{hex}")
    }
    #[cfg(not(windows))]
    {
        runtime_dir
            .join(format!("core-{pid}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Connects to the front's channel.
pub async fn connect(address: &str) -> io::Result<BoxStream> {
    #[cfg(windows)]
    if is_named_pipe(address) {
        return windows::connect(address).await;
    }
    #[cfg(unix)]
    {
        let stream = roamgate_base::unix_socket::connect(std::path::Path::new(address)).await?;
        widen(&stream);
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
            let listener = roamgate_base::unix_socket::bind_tokio_listener(&path)?;
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
            widen(&stream);
            return Ok(Box::new(stream));
        }
        #[cfg(windows)]
        if let Some(pipe) = &mut self.pipe {
            return pipe.accept().await;
        }
        Err(io::Error::other("listener closed"))
    }
}

/// What a side may have written and the other not read yet. A reply of a
/// few hundred kilobytes (a review) then goes in one write: with the
/// default (208 KiB on Linux, 8 KiB on macOS) the writer waited for the
/// reader between parts. The system caps it (`net.core.wmem_max`).
#[cfg(unix)]
const SEND_BUFFER: usize = 4 * 1024 * 1024;

#[cfg(unix)]
fn widen(stream: &tokio::net::UnixStream) {
    let socket = socket2::SockRef::from(stream);
    if let Err(error) = socket.set_send_buffer_size(SEND_BUFFER) {
        tracing::debug!(%error, "the channel's send buffer stays as it is");
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

    use roamgate_base::local_socket::{PipeListener as Pipe, connect_pipe};

    use super::BoxStream;

    pub async fn connect(name: &str) -> io::Result<BoxStream> {
        Ok(Box::new(connect_pipe(name).await?))
    }

    pub struct PipeListener(Pipe);

    impl PipeListener {
        pub fn bind(name: &str) -> io::Result<Self> {
            Pipe::bind(name).map(Self)
        }

        pub async fn accept(&mut self) -> io::Result<BoxStream> {
            Ok(Box::new(self.0.accept().await?))
        }
    }
}
