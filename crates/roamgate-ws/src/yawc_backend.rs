//! The same socket task on yawc, the alternative the S10 spike compared.
//!
//! yawc negotiates permessage-deflate and compresses every message at or
//! above its threshold: it has no per-message choice, so plain replies of
//! 1 KiB and more are compressed too. It owns its write buffer, so the
//! buffered amount here only counts frames not yet handed to it.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use yawc::frame::{Frame, OpCode};
use yawc::{IncomingUpgrade, Options};

use crate::flow::{COMPRESSED_CONTEXT, COMPRESSION_MIN_BYTES, Flow, SendStatus, Target};
use crate::socket::{Command, Event, MAX_MESSAGE_BYTES, SocketHandle, SocketStats, WireStats};

pub fn options(compression_level: u32) -> Options {
    Options::default()
        .with_compression_level(yawc::CompressionLevel::new(compression_level))
        .with_compression_threshold(COMPRESSION_MIN_BYTES)
        .client_no_context_takeover()
        .with_max_payload_read(MAX_MESSAGE_BYTES)
        .with_utf8()
}

pub type Accepted = (SocketHandle, mpsc::UnboundedReceiver<Event>);

/// Answers the upgrade; the future gives the socket once it is open.
pub fn accept(
    incoming: IncomingUpgrade,
    compression_level: u32,
) -> Result<(Response<Body>, impl Future<Output = Option<Accepted>>), String> {
    let (response, upgrade) = incoming
        .upgrade(options(compression_level))
        .map_err(|error| error.to_string())?;
    let extensions = response
        .headers()
        .get("sec-websocket-extensions")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let socket = async move {
        let ws = upgrade.await.ok()?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        tokio::spawn(run(ws, extensions, rx, events_tx));
        Some((SocketHandle::new(tx), events_rx))
    };
    Ok((response.map(|_| Body::empty()), socket))
}

struct Wire {
    frames: mpsc::UnboundedSender<(Frame, usize)>,
    pending: Arc<AtomicUsize>,
    epoch: Instant,
    closed: bool,
    stats: WireStats,
}

impl Target for Wire {
    fn buffered_amount(&self) -> usize {
        self.pending.load(Ordering::Acquire)
    }

    fn send(&mut self, payload: &str, compress: bool) -> Result<SendStatus, String> {
        if self.closed {
            return Ok(SendStatus::Dropped);
        }
        let size = payload.len();
        let before = self.pending.fetch_add(size, Ordering::AcqRel);
        self.frames
            .send((Frame::text(payload.to_owned()), size))
            .map_err(|_| "socket closed".to_owned())?;
        self.stats.frames += 1;
        // yawc decides alone: by size, whatever the message.
        let _ = compress;
        self.stats.compressed_frames += u64::from(size >= COMPRESSION_MIN_BYTES);
        Ok(if before == 0 {
            SendStatus::Sent
        } else {
            SendStatus::Backpressure
        })
    }

    fn close(&mut self, close: Option<(u16, &str)>) -> Result<(), String> {
        if !self.closed {
            self.closed = true;
            let (code, reason) = close.unwrap_or((1000, ""));
            let _ = self.frames.send((Frame::close(code.into(), reason), 0));
        }
        Ok(())
    }

    fn closing(&self) -> bool {
        self.closed
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn cleanup(&mut self) {}

    fn warn(&mut self, message: String) {
        if self.stats.warnings.len() < 32 {
            self.stats.warnings.push(message);
        }
    }
}

async fn run(
    ws: yawc::HttpWebSocket,
    extensions: Option<String>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<Event>,
) {
    let (mut sink, mut stream) = ws.split();
    let pending = Arc::new(AtomicUsize::new(0));
    let drained = Arc::new(Notify::new());
    let (frames_tx, mut frames_rx) = mpsc::unbounded_channel::<(Frame, usize)>();
    let writer = {
        let pending = pending.clone();
        let drained = drained.clone();
        tokio::spawn(async move {
            while let Some((frame, size)) = frames_rx.recv().await {
                let close = frame.opcode() == OpCode::Close;
                if sink.send(frame).await.is_err() {
                    break;
                }
                if pending.fetch_sub(size, Ordering::AcqRel) == size && size > 0 {
                    drained.notify_one();
                }
                if close {
                    break;
                }
            }
        })
    };
    let mut wire = Wire {
        frames: frames_tx,
        pending,
        epoch: Instant::now(),
        closed: false,
        stats: WireStats::default(),
    };
    let mut flow = Flow::new(0);
    let mut close: (Option<u16>, String) = (Some(1006), String::new());
    loop {
        tokio::select! {
            command = commands.recv(), if !wire.closed => match command {
                None => { let _ = wire.close(None); }
                Some(Command::Send { payload, context, coalesce_key }) => {
                    flow.send(&mut wire, payload, &context, coalesce_key.as_deref());
                }
                Some(Command::DropCoalesced(key)) => flow.drop_coalesced(&key),
                Some(Command::Close(reason)) => {
                    let _ = wire.close(reason.as_ref().map(|(code, reason)| (*code, reason.as_str())));
                }
                Some(Command::Stats(reply)) => {
                    let mut stats = wire.stats.clone();
                    stats.buffered = wire.buffered_amount();
                    let _ = reply.send(SocketStats {
                        flow: flow.stats(wire.now_ms()),
                        wire: stats,
                        extensions: extensions.clone(),
                    });
                }
            },
            frame = stream.next() => match frame {
                None => break,
                Some(frame) => match frame.opcode() {
                    OpCode::Text => {
                        wire.stats.messages_in += 1;
                        let text = frame.as_str().to_owned();
                        if !wire.closed && !flow.receive_ack(&mut wire, &text) {
                            let _ = events.send(Event::Text { text, compressed: false });
                        }
                    }
                    OpCode::Close => {
                        close = (frame.close_code().map(u16::from), frame.close_reason().ok().flatten().unwrap_or("").to_owned());
                        break;
                    }
                    _ => {}
                },
            },
            () = drained.notified() => flow.flush_coalesced(&mut wire, COMPRESSED_CONTEXT),
        }
    }
    drop(wire);
    let _ = writer.await;
    let _ = events.send(Event::Closed {
        code: close.0,
        reason: close.1,
    });
}
