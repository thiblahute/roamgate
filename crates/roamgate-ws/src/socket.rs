//! The socket actor: one task per browser socket owns the connection, its
//! outbound buffer and its [`Flow`]. The buffered amount is the exact number
//! of encoded bytes the task accepted and the kernel has not taken yet.

use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::{Buf, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::deflate::{Deflater, Negotiated};
use crate::flow::{COMPRESSED_CONTEXT, Flow, FlowStats, SendStatus, Target};
use crate::frame::{self, Incoming, Reader};

/// Bun's default `maxPayloadLength`.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_WARNINGS: usize = 32;

#[derive(Clone, Debug)]
pub struct Config {
    /// Largest message read from the browser, after inflating.
    pub max_message: usize,
    /// zlib level of the socket's compressor.
    pub compression_level: u32,
    /// How long a close handshake may take before the connection is dropped.
    pub close_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            max_message: MAX_MESSAGE_BYTES,
            // zlib's default, as Bun's dedicated compressor: the same wire
            // bytes within 0.1% on the spike's run.
            compression_level: 6,
            close_timeout: Duration::from_secs(5),
        }
    }
}

pub(crate) enum Command {
    Send {
        payload: String,
        context: String,
        coalesce_key: Option<String>,
    },
    DropCoalesced(String),
    /// A binary message, sent as it is: outside the flow, uncompressed.
    SendBinary(Vec<u8>),
    Close(Option<(u16, String)>),
    Stats(oneshot::Sender<SocketStats>),
}

/// What the socket did on the wire, for logs and the spike's comparison.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WireStats {
    pub bytes_written: u64,
    pub frames: u64,
    pub compressed_frames: u64,
    /// UTF-8 bytes of the compressed messages before and after deflate.
    pub deflate_in: u64,
    pub deflate_out: u64,
    pub messages_in: u64,
    pub compressed_messages_in: u64,
    pub buffered: usize,
    pub max_buffered: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SocketStats {
    pub flow: FlowStats,
    pub wire: WireStats,
    /// The negotiated `Sec-WebSocket-Extensions` value.
    pub extensions: Option<String>,
}

/// What the socket tells its owner.
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    /// A text message that is not a flow-control acknowledgement.
    Text { text: String, compressed: bool },
    /// A binary message (a voice page's audio): Bun hands it to the same
    /// handler as text.
    Binary { data: Vec<u8> },
    /// The connection is gone; the close code the peer or this side gave.
    Closed { code: Option<u16>, reason: String },
}

/// Sends to the socket's task. Cloning is cheap; the socket closes once the
/// last handle is dropped.
#[derive(Clone)]
pub struct SocketHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl SocketHandle {
    pub(crate) fn new(tx: mpsc::UnboundedSender<Command>) -> Self {
        SocketHandle { tx }
    }

    /// Sends a message with Bun's rules: `context` names it for compression
    /// (only `terminal-frame`), per-context ordering and logs;
    /// `coalesce_key` lets a newer payload replace one still held back.
    pub fn send(&self, payload: impl Into<String>, context: &str, coalesce_key: Option<&str>) {
        let _ = self.tx.send(Command::Send {
            payload: payload.into(),
            context: context.to_owned(),
            coalesce_key: coalesce_key.map(str::to_owned),
        });
    }

    /// Sends a binary message as it is (a raw socket's audio).
    pub fn send_binary(&self, data: Vec<u8>) {
        let _ = self.tx.send(Command::SendBinary(data));
    }

    pub fn drop_coalesced(&self, key: &str) {
        let _ = self.tx.send(Command::DropCoalesced(key.to_owned()));
    }

    pub fn close(&self, close: Option<(u16, &str)>) {
        let _ = self.tx.send(Command::Close(
            close.map(|(code, reason)| (code, reason.to_owned())),
        ));
    }

    pub async fn stats(&self) -> Option<SocketStats> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Command::Stats(tx)).ok()?;
        rx.await.ok()
    }
}

struct Wire {
    out: BytesMut,
    deflater: Option<Deflater>,
    scratch: Vec<u8>,
    epoch: Instant,
    close_timeout: Duration,
    /// Set once a close frame is queued: no data frame follows it.
    close_sent: Option<(Option<u16>, String)>,
    close_deadline: Option<Instant>,
    stats: WireStats,
}

impl Wire {
    fn queue_control(
        &mut self,
        opcode: tungstenite::protocol::frame::coding::OpCode,
        payload: &[u8],
    ) {
        frame::encode(&mut self.out, opcode, payload, false);
        self.note_buffered();
    }

    fn note_buffered(&mut self) {
        self.stats.max_buffered = self.stats.max_buffered.max(self.out.len());
    }
}

impl Target for Wire {
    fn buffered_amount(&self) -> usize {
        self.out.len()
    }

    fn send(&mut self, payload: &str, compress: bool) -> Result<SendStatus, String> {
        if self.close_sent.is_some() {
            return Ok(SendStatus::Dropped);
        }
        let before = self.out.len();
        match (&mut self.deflater, compress) {
            (Some(deflater), true) => {
                self.scratch.clear();
                deflater.compress(payload.as_bytes(), &mut self.scratch)?;
                frame::encode(&mut self.out, frame::TEXT, &self.scratch, true);
                self.stats.compressed_frames += 1;
                self.stats.deflate_in += payload.len() as u64;
                self.stats.deflate_out += self.scratch.len() as u64;
            }
            _ => frame::encode(&mut self.out, frame::TEXT, payload.as_bytes(), false),
        }
        self.stats.frames += 1;
        self.note_buffered();
        Ok(if before == 0 {
            SendStatus::Sent
        } else {
            SendStatus::Backpressure
        })
    }

    fn close(&mut self, close: Option<(u16, &str)>) -> Result<(), String> {
        if self.close_sent.is_none() {
            self.queue_control(frame::CLOSE, &frame::close_payload(close));
            self.close_sent = Some((
                close.map(|(code, _)| code),
                close
                    .map(|(_, reason)| reason.to_owned())
                    .unwrap_or_default(),
            ));
            self.close_deadline = Some(Instant::now() + self.close_timeout);
        }
        Ok(())
    }

    fn closing(&self) -> bool {
        self.close_sent.is_some()
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn cleanup(&mut self) {}

    fn warn(&mut self, message: String) {
        if self.stats.warnings.len() < MAX_WARNINGS {
            self.stats.warnings.push(message);
        }
    }
}

/// Starts the task of an upgraded connection.
pub fn spawn<IO>(
    io: IO,
    deflate: Option<Negotiated>,
    config: Config,
) -> (SocketHandle, mpsc::UnboundedReceiver<Event>)
where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel();
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    tokio::spawn(run(io, deflate, config, rx, events_tx));
    (SocketHandle::new(tx), events_rx)
}

/// Writes what the kernel takes right now, without waiting, as Bun does on
/// `send`: an idle socket then never shows a buffered amount.
fn write_now<W: AsyncWrite + Unpin>(writer: &mut W, wire: &mut Wire) -> std::io::Result<()> {
    let mut cx = Context::from_waker(Waker::noop());
    while !wire.out.is_empty() {
        match Pin::new(&mut *writer).poll_write(&mut cx, &wire.out) {
            Poll::Ready(Ok(0)) => return Err(std::io::ErrorKind::WriteZero.into()),
            Poll::Ready(Ok(written)) => {
                wire.out.advance(written);
                wire.stats.bytes_written += written as u64;
            }
            Poll::Ready(Err(error)) => return Err(error),
            Poll::Pending => break,
        }
    }
    Ok(())
}

async fn run<IO>(
    io: IO,
    deflate: Option<Negotiated>,
    config: Config,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<Event>,
) where
    IO: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut reader_io, mut writer) = tokio::io::split(io);
    let mut reader = Reader::new(config.max_message, deflate.is_some());
    let mut wire = Wire {
        out: BytesMut::with_capacity(64 * 1024),
        deflater: deflate
            .as_ref()
            .map(|negotiated| Deflater::new(negotiated, config.compression_level)),
        scratch: Vec::new(),
        epoch: Instant::now(),
        close_timeout: config.close_timeout,
        close_sent: None,
        close_deadline: None,
        stats: WireStats::default(),
    };
    let mut flow = Flow::new(0);
    let mut commands_open = true;
    let mut reading = true;
    let mut peer_close: Option<Option<(u16, String)>> = None;
    // The socket fell behind at some point: tell the flow when it drains.
    let mut backlogged = false;
    let mut broken = false;

    loop {
        if !broken && write_now(&mut writer, &mut wire).is_err() {
            broken = true;
        }
        if wire.out.is_empty() {
            let _ = writer.flush().await;
            if backlogged && !broken {
                backlogged = false;
                // The viewer caught up: send the newest repaints held back.
                flow.flush_coalesced(&mut wire, COMPRESSED_CONTEXT);
                continue;
            }
        } else {
            backlogged = true;
        }
        let closed_cleanly =
            wire.close_sent.is_some() && peer_close.is_some() && wire.out.is_empty();
        let gone = broken || (!reading && wire.out.is_empty());
        let timed_out = wire
            .close_deadline
            .is_some_and(|deadline| Instant::now() >= deadline);
        if closed_cleanly || gone || timed_out {
            break;
        }
        let deadline = wire.close_deadline;
        tokio::select! {
            command = commands.recv(), if commands_open && wire.close_sent.is_none() => match command {
                None => {
                    commands_open = false;
                    let _ = wire.close(None);
                }
                Some(Command::Send { payload, context, coalesce_key }) => {
                    flow.send(&mut wire, payload, &context, coalesce_key.as_deref());
                }
                Some(Command::DropCoalesced(key)) => flow.drop_coalesced(&key),
                Some(Command::SendBinary(data)) => {
                    frame::encode(&mut wire.out, frame::BINARY, &data, false);
                    wire.stats.frames += 1;
                    wire.note_buffered();
                }
                Some(Command::Close(close)) => {
                    let _ = wire.close(close.as_ref().map(|(code, reason)| (*code, reason.as_str())));
                }
                Some(Command::Stats(reply)) => {
                    let mut stats = wire.stats.clone();
                    stats.buffered = wire.out.len();
                    let _ = reply.send(SocketStats {
                        flow: flow.stats(wire.now_ms()),
                        wire: stats,
                        extensions: deflate.as_ref().map(|negotiated| negotiated.response.clone()),
                    });
                }
            },
            read = reader_io.read_buf(reader.buffer_mut()), if reading => match read {
                Ok(0) | Err(_) => reading = false,
                Ok(_) => loop {
                    match reader.next_message() {
                        Ok(None) => break,
                        Ok(Some(Incoming::Text { text, compressed })) => {
                            wire.stats.messages_in += 1;
                            wire.stats.compressed_messages_in += u64::from(compressed);
                            if wire.close_sent.is_none() && !flow.receive_ack(&mut wire, &text) {
                                let _ = events.send(Event::Text { text, compressed });
                            }
                        }
                        // Bun hands binary to the same handler as text.
                        Ok(Some(Incoming::Binary { data, compressed })) => {
                            wire.stats.messages_in += 1;
                            wire.stats.compressed_messages_in += u64::from(compressed);
                            if wire.close_sent.is_none() {
                                let _ = events.send(Event::Binary { data });
                            }
                        }
                        Ok(Some(Incoming::Ping(payload))) => {
                            if wire.close_sent.is_none() {
                                wire.queue_control(frame::PONG, &payload);
                            }
                        }
                        Ok(Some(Incoming::Pong(_))) => {}
                        Ok(Some(Incoming::Close(close))) => {
                            let echo = close.as_ref().map(|(code, _)| (*code, ""));
                            let _ = wire.close(echo);
                            peer_close = Some(close);
                            reading = false;
                            break;
                        }
                        Err(error) => {
                            let _ = wire.close(Some((error.code, error.reason)));
                            reading = false;
                            break;
                        }
                    }
                },
            },
            written = writer.write(&wire.out), if !wire.out.is_empty() && !broken => match written {
                Ok(0) | Err(_) => broken = true,
                Ok(written) => {
                    wire.out.advance(written);
                    wire.stats.bytes_written += written as u64;
                }
            },
            () = sleep_until(deadline), if deadline.is_some() => {}
        }
    }
    let _ = writer.shutdown().await;
    let (code, reason) = match (peer_close, wire.close_sent) {
        (Some(Some((code, reason))), _) => (Some(code), reason),
        (_, Some((code, reason))) => (code, reason),
        _ => (Some(1006), String::new()),
    };
    let _ = events.send(Event::Closed { code, reason });
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
