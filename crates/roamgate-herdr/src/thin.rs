//! Herdr's client socket (bridge/thin-client.ts and bridge/bincode.ts): the
//! Hello/Welcome handshake, terminal attach, input, resize and scroll, and
//! the server messages a terminal view reads.
//!
//! The codec is bincode 2 `config::standard()` by hand, as the TS client
//! writes it, since it also speaks the legacy protocols 14 to 20 whose
//! layouts differ from today's. The variant indices and field order of
//! protocol 22 are held to Herdr's own `wire.rs`, vendored at
//! [`crate::release::VERIFIED_HERDR_VERSION`] (`vendor/`), by a test.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use roamgate_base::clock::{SharedClock, SystemClock};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::control::io_error_text;
use crate::protocol::assert_supported_herdr_protocol;

/// How long the handshake may take.
pub const HANDSHAKE_TIMEOUT_MS: u64 = 8_000;
/// The largest frame accepted (32 MiB).
pub const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

/// ClientMessage variant indices (Herdr's wire.rs enum order).
pub mod client_message {
    pub const HELLO: u64 = 0;
    pub const INPUT: u64 = 1;
    pub const RESIZE: u64 = 3;
    pub const ATTACH_TERMINAL: u64 = 5;
    pub const ATTACH_SCROLL: u64 = 6;
}

/// ServerMessage variant indices of a protocol; `None` never matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerMessageIndices {
    pub welcome: u64,
    pub frame: Option<u64>,
    pub terminal: u64,
    pub server_shutdown: u64,
    pub clipboard: u64,
    pub mouse_capture: u64,
    pub direct_terminal_keyboard_protocol: Option<u64>,
}

pub const SM_LEGACY: ServerMessageIndices = ServerMessageIndices {
    welcome: 0,
    frame: Some(1),
    terminal: 2,
    server_shutdown: 4,
    clipboard: 6,
    mouse_capture: 9,
    direct_terminal_keyboard_protocol: None,
};

/// Tagged 0.9.0 (protocol 22) removed Frame, KittyKeyboardReportAll and
/// PrefixInputSource, shifting what follows.
pub const SM_V22: ServerMessageIndices = ServerMessageIndices {
    welcome: 0,
    frame: None,
    terminal: 1,
    server_shutdown: 3,
    clipboard: 5,
    mouse_capture: 8,
    direct_terminal_keyboard_protocol: Some(16),
};

/// Private terminal protocol 22 is distinct from endpoint generation 1.
pub fn is_terminal_hello_protocol(protocol: i64) -> bool {
    protocol == 22
}

/// Herdr 0.8.2 (protocol 20) inserted AppDirectGraphics before
/// TerminalAttach in ClientLaunchMode.
pub const APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL: i64 = 20;

pub fn terminal_attach_launch_mode_wire_value(protocol: i64) -> u64 {
    if protocol >= APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL {
        2
    } else {
        1
    }
}

pub fn server_message_indices(protocol: i64) -> ServerMessageIndices {
    if is_terminal_hello_protocol(protocol) {
        SM_V22
    } else {
        SM_LEGACY
    }
}

/// bincode 2 standard writer.
#[derive(Debug, Default, Clone)]
pub struct BinWriter {
    buffer: Vec<u8>,
}

impl BinWriter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn u8(&mut self, value: u8) {
        self.buffer.push(value);
    }
    pub fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }
    pub fn varint(&mut self, value: u64) {
        if value < 251 {
            self.u8(value as u8);
        } else if value <= 0xffff {
            self.u8(251);
            self.buffer.extend_from_slice(&(value as u16).to_le_bytes());
        } else if value <= 0xffff_ffff {
            self.u8(252);
            self.buffer.extend_from_slice(&(value as u32).to_le_bytes());
        } else {
            self.u8(253);
            self.buffer.extend_from_slice(&value.to_le_bytes());
        }
    }
    pub fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }
    pub fn bytes(&mut self, data: &[u8]) {
        self.varint(data.len() as u64);
        self.buffer.extend_from_slice(data);
    }
    pub fn option<T>(&mut self, value: Option<T>, write: impl FnOnce(&mut Self, T)) {
        match value {
            None => self.u8(0),
            Some(value) => {
                self.u8(1);
                write(self, value);
            }
        }
    }
    pub fn variant(&mut self, index: u64) {
        self.varint(index);
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.buffer
    }
}

/// bincode 2 standard reader.
#[derive(Debug, Clone)]
pub struct BinReader<'a> {
    buffer: &'a [u8],
    offset: usize,
}

impl<'a> BinReader<'a> {
    pub fn new(buffer: &'a [u8]) -> Self {
        Self { buffer, offset: 0 }
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        if self.offset + count > self.buffer.len() {
            return Err(format!(
                "bincode: short read at {} need {count}",
                self.offset
            ));
        }
        let slice = &self.buffer[self.offset..self.offset + count];
        self.offset += count;
        Ok(slice)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn bool(&mut self) -> Result<bool, String> {
        Ok(self.u8()? != 0)
    }
    pub fn varint(&mut self) -> Result<u64, String> {
        let first = self.u8()?;
        match first {
            0..=250 => Ok(u64::from(first)),
            251 => Ok(u64::from(u16::from_le_bytes(
                self.take(2)?.try_into().expect("2 bytes"),
            ))),
            252 => Ok(u64::from(u32::from_le_bytes(
                self.take(4)?.try_into().expect("4 bytes"),
            ))),
            253 => Ok(u64::from_le_bytes(
                self.take(8)?.try_into().expect("8 bytes"),
            )),
            _ => Err(format!("bincode: invalid varint marker {first}")),
        }
    }
    pub fn string(&mut self) -> Result<String, String> {
        let count = self.varint()? as usize;
        Ok(String::from_utf8_lossy(self.take(count)?).into_owned())
    }
    pub fn bytes(&mut self) -> Result<Vec<u8>, String> {
        let count = self.varint()? as usize;
        Ok(self.take(count)?.to_vec())
    }
    pub fn option<T>(
        &mut self,
        read: impl FnOnce(&mut Self) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        if self.u8()? == 1 {
            read(self).map(Some)
        } else {
            Ok(None)
        }
    }
    pub fn variant(&mut self) -> Result<u64, String> {
        self.varint()
    }
    pub fn remaining(&self) -> usize {
        self.buffer.len() - self.offset
    }
}

/// A length-prefixed frame: u32 LE payload length, then the payload.
pub fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellData {
    pub symbol: String,
    pub fg: u64,
    pub bg: u64,
    pub modifier: u64,
    pub skip: bool,
    pub hyperlink: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorState {
    pub x: u64,
    pub y: u64,
    pub visible: bool,
    pub shape: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameData {
    pub cells: Vec<CellData>,
    pub width: u64,
    pub height: u64,
    pub cursor: Option<CursorState>,
    pub hyperlinks: Vec<String>,
}

pub fn read_cell_data(reader: &mut BinReader<'_>) -> Result<CellData, String> {
    Ok(CellData {
        symbol: reader.string()?,
        fg: reader.varint()?,
        bg: reader.varint()?,
        modifier: reader.varint()?,
        skip: reader.bool()?,
        hyperlink: reader.option(BinReader::varint)?,
    })
}

pub fn read_frame_data(reader: &mut BinReader<'_>) -> Result<FrameData, String> {
    let count = reader.varint()?;
    let mut cells = Vec::with_capacity(count.min(1 << 16) as usize);
    for _ in 0..count {
        cells.push(read_cell_data(reader)?);
    }
    let width = reader.varint()?;
    let height = reader.varint()?;
    let cursor = reader.option(|reader| {
        Ok(CursorState {
            x: reader.varint()?,
            y: reader.varint()?,
            visible: reader.bool()?,
            shape: reader.u8()?,
        })
    })?;
    let links = reader.varint()?;
    let mut hyperlinks = Vec::with_capacity(links.min(1 << 12) as usize);
    for _ in 0..links {
        hyperlinks.push(reader.string()?);
    }
    reader.bytes()?; // graphics (ignored)
    Ok(FrameData {
        cells,
        width,
        height,
        cursor,
        hyperlinks,
    })
}

/// The launch mode asked in Hello.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LaunchMode {
    #[default]
    App,
    TerminalAttach,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ConnectOptions {
    pub launch_mode: LaunchMode,
    /// 0 SemanticFrame, 1 TerminalAnsi.
    pub encoding: u64,
}

/// What a thin client tells its listeners.
#[derive(Debug, Clone, PartialEq)]
pub enum ThinEvent {
    Welcome {
        version: u64,
        encoding: u64,
        error: Option<String>,
    },
    Frame(FrameData),
    Terminal {
        seq: u64,
        width: u64,
        height: u64,
        full: bool,
        bytes: Vec<u8>,
    },
    Error(String),
    Close,
    Clipboard(String),
    MouseCapture {
        enabled: bool,
        sgr_pixels: bool,
    },
    KeyboardProtocol {
        flags: u64,
        modify_other_keys_level: u8,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollSource {
    Wheel,
    PageKey,
}

#[derive(Default)]
struct ThinState {
    protocol: Option<i64>,
    attached: Option<String>,
    connected: bool,
    writer: Option<mpsc::UnboundedSender<Vec<u8>>>,
    welcome: Option<oneshot::Sender<Result<(), String>>>,
}

struct ThinInner {
    socket_path: String,
    clock: SharedClock,
    closed: AtomicBool,
    state: Mutex<ThinState>,
    events: broadcast::Sender<ThinEvent>,
    stop: watch::Sender<bool>,
}

/// One connection to herdr-client.sock. Clones are the same connection.
#[derive(Clone)]
pub struct ThinClient {
    inner: Arc<ThinInner>,
}

impl ThinClient {
    pub fn new(socket_path: impl Into<String>, clock: Option<SharedClock>) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(ThinInner {
                socket_path: socket_path.into(),
                clock: clock.unwrap_or_else(|| Arc::new(SystemClock)),
                closed: AtomicBool::new(false),
                state: Mutex::default(),
                events,
                stop: watch::channel(false).0,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ThinState> {
        self.inner.state.lock().expect("thin client")
    }

    pub fn events(&self) -> broadcast::Receiver<ThinEvent> {
        self.inner.events.subscribe()
    }

    fn emit(&self, event: ThinEvent) {
        let _ = self.inner.events.send(event);
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// Connects and completes the handshake with the protocol `protocol`
    /// resolves to (the control socket's ping).
    pub async fn connect<F>(
        &self,
        protocol: F,
        cols: u64,
        rows: u64,
        options: ConnectOptions,
    ) -> Result<(), String>
    where
        F: std::future::Future<Output = Value>,
    {
        if self.state().connected {
            return Err("thin client is already connected".into());
        }
        if self.is_closed() {
            return Err("thin client is closed".into());
        }
        let protocol = protocol.await;
        if self.is_closed() {
            return Err("thin client is closed".into());
        }
        assert_supported_herdr_protocol(&protocol)?;
        let protocol = protocol.as_i64().expect("a supported protocol");
        let (welcome_tx, welcome_rx) = oneshot::channel();
        {
            let mut state = self.state();
            state.connected = true;
            state.protocol = Some(protocol);
            state.welcome = Some(welcome_tx);
        }
        let this = self.clone();
        let indices = server_message_indices(protocol);
        let hello = hello_payload(cols, rows, options, protocol);
        let mut stop = self.inner.stop.subscribe();
        tokio::spawn(async move {
            let connected = tokio::select! {
                stream = connect_stream(&this.inner.socket_path) => stream,
                _ = stop.wait_for(|stop| *stop) => return,
            };
            let stream = match connected {
                Ok(stream) => stream,
                Err(error) => {
                    let text = io_error_text(&error);
                    this.reject_welcome(text.clone());
                    this.emit(ThinEvent::Error(text));
                    this.mark_closed();
                    return;
                }
            };
            this.run(stream, hello, indices, protocol, stop).await;
        });
        let clock = self.inner.clock.clone();
        let deadline = clock.sleep(Duration::from_millis(HANDSHAKE_TIMEOUT_MS));
        tokio::select! {
            outcome = welcome_rx => outcome.unwrap_or_else(|_| Err("thin client connection closed during handshake".into())),
            () = deadline => {
                self.reject_welcome(String::new());
                self.close();
                Err(format!("timed out waiting for Herdr protocol {protocol} handshake"))
            }
        }
    }

    fn reject_welcome(&self, error: String) {
        if let Some(pending) = self.state().welcome.take() {
            let _ = pending.send(Err(error));
        }
    }

    fn resolve_welcome(&self) {
        if let Some(pending) = self.state().welcome.take() {
            let _ = pending.send(Ok(()));
        }
    }

    fn mark_closed(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.reject_welcome("thin client connection closed during handshake".into());
        self.state().writer = None;
    }

    async fn run(
        &self,
        stream: Stream,
        hello: Vec<u8>,
        indices: ServerMessageIndices,
        protocol: i64,
        mut stop: watch::Receiver<bool>,
    ) {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        if tx.send(encode_frame(&hello)).is_err() {
            return;
        }
        if self.is_closed() {
            return;
        }
        self.state().writer = Some(tx);
        let writing = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if writer.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        'read: loop {
            let read = tokio::select! {
                read = reader.read(&mut chunk) => read,
                _ = stop.wait_for(|stop| *stop) => break 'read,
            };
            match read {
                Ok(0) => break,
                Err(error) => {
                    let text = io_error_text(&error);
                    self.reject_welcome(text.clone());
                    self.emit(ThinEvent::Error(text));
                    break;
                }
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            }
            while buffer.len() >= 4 {
                let length = u32::from_le_bytes(buffer[..4].try_into().expect("4")) as usize;
                if length > MAX_FRAME_BYTES {
                    let error = format!("oversized frame: {length}");
                    buffer.clear();
                    self.reject_welcome(error.clone());
                    self.inner.closed.store(true, Ordering::SeqCst);
                    self.emit(ThinEvent::Error(error));
                    break 'read;
                }
                if buffer.len() < 4 + length {
                    break;
                }
                let payload: Vec<u8> = buffer.drain(..4 + length).skip(4).collect();
                self.handle_payload(&payload, indices, protocol);
                if self.is_closed() {
                    break 'read;
                }
            }
        }
        writing.abort();
        self.mark_closed();
        self.emit(ThinEvent::Close);
    }

    fn handle_payload(&self, payload: &[u8], indices: ServerMessageIndices, protocol: i64) {
        if let Err(error) = self.decode(payload, indices, protocol) {
            self.reject_welcome(error.clone());
            self.inner.closed.store(true, Ordering::SeqCst);
            self.emit(ThinEvent::Error(error));
        }
    }

    fn decode(
        &self,
        payload: &[u8],
        indices: ServerMessageIndices,
        protocol: i64,
    ) -> Result<(), String> {
        let mut reader = BinReader::new(payload);
        let variant = reader.variant()?;
        if variant == indices.welcome {
            let version = reader.varint()?;
            let encoding = reader.varint()?;
            let error = reader.option(BinReader::string)?;
            assert_supported_herdr_protocol(&Value::from(version))?;
            self.emit(ThinEvent::Welcome {
                version,
                encoding,
                error: error.clone(),
            });
            if let Some(error) = error.filter(|error| !error.is_empty()) {
                self.reject_welcome(format!(
                    "Herdr rejected thin-client protocol {protocol}: {error}"
                ));
                self.close();
            } else if version as i64 != protocol {
                self.reject_welcome(format!(
                    "Herdr welcomed protocol {version}, expected {protocol}"
                ));
                self.close();
            } else if (is_terminal_hello_protocol(version as i64) && encoding != 1)
                || (encoding != 0 && encoding != 1)
            {
                self.reject_welcome(format!("Herdr welcomed unsupported encoding {encoding}"));
                self.close();
            } else {
                self.resolve_welcome();
            }
        } else if Some(variant) == indices.frame {
            self.emit(ThinEvent::Frame(read_frame_data(&mut reader)?));
        } else if variant == indices.terminal {
            let seq = reader.varint()?;
            let width = reader.varint()?;
            let height = reader.varint()?;
            let full = reader.bool()?;
            let bytes = reader.bytes()?;
            self.emit(ThinEvent::Terminal {
                seq,
                width,
                height,
                full,
                bytes,
            });
        } else if variant == indices.server_shutdown {
            let reason = reader.option(BinReader::string)?;
            self.emit(ThinEvent::Error(
                reason
                    .filter(|reason| !reason.is_empty())
                    .unwrap_or_else(|| "Herdr closed the thin-client connection".into()),
            ));
            self.close();
        } else if variant == indices.clipboard {
            self.emit(ThinEvent::Clipboard(reader.string()?));
        } else if variant == indices.mouse_capture {
            let enabled = reader.bool()?;
            let sgr_pixels = if is_terminal_hello_protocol(protocol) {
                reader.bool()?
            } else {
                false
            };
            self.emit(ThinEvent::MouseCapture {
                enabled,
                sgr_pixels,
            });
        } else if Some(variant) == indices.direct_terminal_keyboard_protocol {
            self.emit(ThinEvent::KeyboardProtocol {
                flags: reader.varint()?,
                modify_other_keys_level: reader.u8()?,
            });
        }
        Ok(())
    }

    fn write(&self, message: Vec<u8>) {
        if self.is_closed() {
            return;
        }
        if let Some(writer) = &self.state().writer {
            let _ = writer.send(encode_frame(&message));
        }
    }

    /// Attaches to one terminal: once per connection (Herdr treats it as a
    /// one-time transition); the same terminal again is a no-op.
    pub fn attach(&self, terminal_id: &str, takeover: bool) -> Result<(), String> {
        {
            let mut state = self.state();
            match &state.attached {
                Some(attached) if attached == terminal_id => return Ok(()),
                Some(attached) => {
                    return Err(format!("thin client is already attached to {attached}"));
                }
                None => state.attached = Some(terminal_id.to_owned()),
            }
        }
        let mut writer = BinWriter::new();
        writer.variant(client_message::ATTACH_TERMINAL);
        writer.string(terminal_id);
        writer.bool(takeover);
        self.write(writer.into_bytes());
        Ok(())
    }

    pub fn resize(&self, cols: u64, rows: u64) {
        let mut writer = BinWriter::new();
        writer.variant(client_message::RESIZE);
        writer.varint(cols);
        writer.varint(rows);
        writer.varint(0);
        writer.varint(0);
        if self
            .state()
            .protocol
            .is_some_and(is_terminal_hello_protocol)
        {
            writer.bool(false); // pixel_mouse
        }
        self.write(writer.into_bytes());
    }

    pub fn scroll(
        &self,
        direction: ScrollDirection,
        lines: f64,
        column: Option<u64>,
        row: Option<u64>,
        source: ScrollSource,
    ) {
        let mut writer = BinWriter::new();
        writer.variant(client_message::ATTACH_SCROLL);
        if source == ScrollSource::PageKey {
            writer.variant(1);
            writer.bytes(match direction {
                ScrollDirection::Up => &[0x1b, 0x5b, 0x35, 0x7e],
                ScrollDirection::Down => &[0x1b, 0x5b, 0x36, 0x7e],
            });
        } else {
            writer.variant(0);
        }
        writer.variant(match direction {
            ScrollDirection::Up => 0,
            ScrollDirection::Down => 1,
        });
        writer.varint(lines.floor().clamp(1.0, 65535.0) as u64);
        writer.option(column, BinWriter::varint);
        writer.option(row, BinWriter::varint);
        writer.u8(0); // crossterm KeyModifiers bits
        self.write(writer.into_bytes());
    }

    pub fn input(&self, data: &[u8]) {
        let mut writer = BinWriter::new();
        writer.variant(client_message::INPUT);
        writer.bytes(data);
        self.write(writer.into_bytes());
    }

    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.reject_welcome("thin client closed during handshake".into());
        self.state().writer = None;
        let _ = self.inner.stop.send(true);
    }
}

fn hello_payload(cols: u64, rows: u64, options: ConnectOptions, protocol: i64) -> Vec<u8> {
    let mut writer = BinWriter::new();
    writer.variant(client_message::HELLO);
    writer.varint(protocol as u64);
    writer.varint(cols);
    writer.varint(rows);
    writer.varint(0); // cell_width_px
    writer.varint(0); // cell_height_px
    if is_terminal_hello_protocol(protocol) {
        // TerminalHello: only pixel_mouse is left.
        writer.bool(false);
        return writer.into_bytes();
    }
    writer.varint(options.encoding);
    writer.varint(0); // keybindings = Server
    writer.varint(match options.launch_mode {
        LaunchMode::TerminalAttach => terminal_attach_launch_mode_wire_value(protocol),
        LaunchMode::App => 0,
    });
    writer.into_bytes()
}

#[cfg(unix)]
pub(crate) type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub(crate) type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

pub(crate) async fn connect_stream(path: &str) -> std::io::Result<Stream> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await
    }
    #[cfg(windows)]
    {
        roamgate_base::local_socket::connect_pipe(path).await
    }
}

// Its fakes serve Herdr on Unix sockets (Herdr on Windows is a named pipe).
#[cfg(all(test, unix))]
mod tests;
