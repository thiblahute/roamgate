//! The socket task over real TCP, with a hand-written client: the upgrade,
//! compression chosen per message, inbound inflate, control frames, the
//! close handshake, flow control and the slow-socket rules.

use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::Response;
use axum::routing::get;
use bytes::{Buf, BytesMut};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress};
use roamgate_ws::flow::{BACKPRESSURE_HARD_LIMIT_BYTES, CHUNK_MARKER, FLOW_CHUNK_CHARS};
use roamgate_ws::frame::{self, CLOSE, PING, TEXT};
use roamgate_ws::{Config, Event, SocketHandle, upgrade};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tungstenite::protocol::frame::FrameHeader;
use tungstenite::protocol::frame::coding::OpCode;

type Accepted = (SocketHandle, mpsc::UnboundedReceiver<Event>);

async fn ws(
    State(sockets): State<mpsc::UnboundedSender<Accepted>>,
    mut request: Request,
) -> Response {
    match upgrade::accept(&mut request, true) {
        Err(response) => *response,
        Ok(accepted) => {
            tokio::spawn(async move {
                let io = upgrade::upgraded(accepted.on_upgrade).await.unwrap();
                let _ = sockets.send(roamgate_ws::socket::spawn(
                    io,
                    accepted.deflate,
                    Config::default(),
                ));
            });
            accepted.response
        }
    }
}

async fn server() -> (String, mpsc::UnboundedReceiver<Accepted>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let app = Router::new().route("/ws", get(ws)).with_state(tx);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, rx)
}

/// A browser-like client: masks its frames, inflates with context takeover.
struct Client {
    stream: TcpStream,
    buffer: BytesMut,
    response: String,
    inflate: Decompress,
    deflate: Compress,
}

#[derive(Debug, PartialEq)]
struct Received {
    opcode: OpCode,
    compressed: bool,
    payload: Vec<u8>,
}

impl Client {
    async fn connect(address: &str, extensions: Option<&str>) -> Client {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let extensions = extensions
            .map(|value| format!("Sec-WebSocket-Extensions: {value}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "GET /ws HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{extensions}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buffer = BytesMut::new();
        let response = loop {
            stream.read_buf(&mut buffer).await.unwrap();
            if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let response = String::from_utf8(buffer.split_to(end + 4).to_vec()).unwrap();
                break response;
            }
        };
        Client {
            stream,
            buffer,
            response,
            inflate: Decompress::new(false),
            deflate: Compress::new(Compression::default(), false),
        }
    }

    fn header(&self, name: &str) -> Option<String> {
        self.response.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }

    async fn send(&mut self, opcode: OpCode, payload: &[u8], compress: bool) {
        let mut wire = BytesMut::new();
        let payload = if compress {
            // Each message on its own (client_no_context_takeover).
            self.deflate.reset();
            let mut out = Vec::with_capacity(payload.len() + 64);
            self.deflate
                .compress_vec(payload, &mut out, FlushCompress::Sync)
                .unwrap();
            out.truncate(out.len() - 4);
            out
        } else {
            payload.to_vec()
        };
        frame::encode_client(
            &mut wire,
            opcode,
            &payload,
            compress,
            true,
            [0x37, 0xfa, 0x21, 0x3d],
        );
        self.stream.write_all(&wire).await.unwrap();
    }

    async fn next(&mut self) -> Option<Received> {
        loop {
            let mut cursor = std::io::Cursor::new(&self.buffer[..]);
            if let Some((header, length)) = FrameHeader::parse(&mut cursor).unwrap() {
                let start = cursor.position() as usize;
                let end = start + length as usize;
                if self.buffer.len() >= end {
                    assert!(header.mask.is_none() && header.is_final);
                    self.buffer.advance(start);
                    let mut payload = self.buffer.split_to(length as usize).to_vec();
                    if header.rsv1 {
                        payload.extend_from_slice(&[0, 0, 0xff, 0xff]);
                        let mut out = Vec::with_capacity(payload.len() * 50 + 64 * 1024);
                        let start_in = self.inflate.total_in();
                        self.inflate
                            .decompress_vec(&payload, &mut out, FlushDecompress::Sync)
                            .unwrap();
                        assert_eq!((self.inflate.total_in() - start_in) as usize, payload.len());
                        assert!(out.len() < out.capacity(), "test buffer too small");
                        payload = out;
                    }
                    return Some(Received {
                        opcode: header.opcode,
                        compressed: header.rsv1,
                        payload,
                    });
                }
            }
            if self.stream.read_buf(&mut self.buffer).await.unwrap() == 0 {
                return None;
            }
        }
    }

    async fn text(&mut self) -> (String, bool) {
        let received = self.next().await.unwrap();
        assert_eq!(received.opcode, TEXT);
        (
            String::from_utf8(received.payload).unwrap(),
            received.compressed,
        )
    }
}

fn terminal_frame(n: usize) -> String {
    let lines: String = (0..60)
        .map(|row| format!("\u{1b}[{row};1Hline {row} of frame {n}: build output é 😀\r\n"))
        .collect();
    format!(
        r#"{{"terminal":{{"id":"t1","frame":{}}}}}"#,
        serde_json::to_string(&lines).unwrap()
    )
}

#[tokio::test]
async fn negotiates_like_bun_and_compresses_only_terminal_frames() {
    let (address, mut sockets) = server().await;
    let mut client =
        Client::connect(&address, Some("permessage-deflate; client_max_window_bits")).await;
    assert!(client.response.starts_with("HTTP/1.1 101"));
    assert_eq!(
        client.header("sec-websocket-accept").as_deref(),
        Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    );
    assert_eq!(
        client.header("sec-websocket-extensions").as_deref(),
        Some("permessage-deflate; client_no_context_takeover")
    );
    let (socket, _events) = sockets.recv().await.unwrap();
    let rpc = format!(r#"{{"id":"1","result":"{}"}}"#, "r".repeat(4000));
    let messages = [
        ("terminal-frame", "small terminal frame".to_owned()),
        ("terminal-frame", terminal_frame(1)),
        ("message", rpc.clone()),
        ("terminal-frame", terminal_frame(2)),
        ("terminal-frame", terminal_frame(3)),
    ];
    for (context, payload) in &messages {
        socket.send(payload.clone(), context, None);
    }
    let mut sizes = Vec::new();
    for (index, (_, expected)) in messages.iter().enumerate() {
        let (text, compressed) = client.text().await;
        assert_eq!(&text, expected, "message {index}");
        assert_eq!(
            compressed,
            [false, true, false, true, true][index],
            "message {index}"
        );
        sizes.push(text.len());
    }
    let stats = socket.stats().await.unwrap();
    assert_eq!(stats.wire.compressed_frames, 3);
    // History across messages: the later repaints cost far less.
    assert!(
        stats.wire.deflate_out * 4 < stats.wire.deflate_in,
        "{stats:?}"
    );
    assert_eq!(stats.wire.buffered, 0);
    let plain: usize = sizes.iter().sum();
    assert!((stats.wire.bytes_written as usize) < plain * 3 / 4);
}

#[tokio::test]
async fn declines_compression_when_not_offered() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, None).await;
    assert_eq!(client.header("sec-websocket-extensions"), None);
    let (socket, _events) = sockets.recv().await.unwrap();
    socket.send(terminal_frame(1), "terminal-frame", None);
    assert_eq!(client.text().await, (terminal_frame(1), false));
}

#[tokio::test]
async fn inflates_client_messages_answers_pings_and_closes_cleanly() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, Some("permessage-deflate")).await;
    let (_socket, mut events) = sockets.recv().await.unwrap();
    let big = format!(
        r#"{{"id":"2","method":"files.write","params":{{"text":"{}"}}}}"#,
        "é".repeat(100_000)
    );
    client.send(TEXT, big.as_bytes(), true).await;
    client.send(TEXT, b"{\"id\":\"3\"}", false).await;
    client.send(TEXT, big.as_bytes(), true).await;
    for (expected, compressed) in [
        (&big, true),
        (&"{\"id\":\"3\"}".to_owned(), false),
        (&big, true),
    ] {
        assert_eq!(
            events.recv().await.unwrap(),
            Event::Text {
                text: expected.clone(),
                compressed
            }
        );
    }
    client.send(PING, b"hb", false).await;
    let pong = client.next().await.unwrap();
    assert_eq!((pong.opcode, pong.payload), (frame::PONG, b"hb".to_vec()));
    client
        .send(CLOSE, &frame::close_payload(Some((1000, "bye"))), false)
        .await;
    let close = client.next().await.unwrap();
    assert_eq!(
        (close.opcode, close.payload),
        (CLOSE, 1000u16.to_be_bytes().to_vec())
    );
    assert_eq!(
        events.recv().await.unwrap(),
        Event::Closed {
            code: Some(1000),
            reason: "bye".into()
        }
    );
    assert_eq!(client.next().await, None);
}

#[tokio::test]
async fn closes_on_protocol_errors_with_their_codes() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, None).await;
    let (_socket, mut events) = sockets.recv().await.unwrap();
    // RSV1 without the extension.
    client.send(TEXT, b"x", true).await;
    let close = client.next().await.unwrap();
    assert_eq!(close.opcode, CLOSE);
    assert_eq!(&close.payload[..2], &1002u16.to_be_bytes());
    client
        .send(CLOSE, &frame::close_payload(Some((1002, ""))), false)
        .await;
    assert!(matches!(
        events.recv().await.unwrap(),
        Event::Closed {
            code: Some(1002),
            ..
        }
    ));
}

#[tokio::test]
async fn drives_chunks_with_acknowledgements() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, Some("permessage-deflate")).await;
    let (socket, mut events) = sockets.recv().await.unwrap();
    client.send(TEXT, b"{\"ack\":0}", false).await;
    while !socket.stats().await.unwrap().flow.enabled {
        tokio::task::yield_now().await;
    }
    let large = format!(r#"{{"id":"r","result":"{}"}}"#, "😀y".repeat(700_000));
    socket.send(large.clone(), "review", None);
    socket.send("{\"id\":\"ping\"}", "bridge-ping", None);
    let mut received_chars = 0usize;
    let mut parts = String::new();
    let mut messages = Vec::new();
    while messages.len() < 2 {
        let (text, _) = client.text().await;
        received_chars += roamgate_ws::flow::utf16_len(&text);
        match text.strip_prefix(CHUNK_MARKER) {
            Some(rest) => {
                let (_, rest) = rest.split_once(':').unwrap();
                let (last, body) = rest.split_once(':').unwrap();
                assert!(roamgate_ws::flow::utf16_len(body) <= FLOW_CHUNK_CHARS);
                parts.push_str(body);
                if last == "1" {
                    messages.push(std::mem::take(&mut parts));
                }
            }
            None => messages.push(text),
        }
        client
            .send(
                TEXT,
                format!("{{\"ack\":{received_chars}}}").as_bytes(),
                false,
            )
            .await;
    }
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0], "{\"id\":\"ping\"}");
    assert!(messages[1] == large, "the large reply came back different");
    let stats = socket.stats().await.unwrap();
    assert!(stats.flow.enabled);
    assert_eq!(stats.flow.sent as usize, received_chars);
    // Acknowledgements are the socket's business, never the owner's.
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn closes_a_reader_that_stops_past_the_hard_limit_with_an_exact_count() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, Some("permessage-deflate")).await;
    let (socket, mut events) = sockets.recv().await.unwrap();
    let chunk = "q".repeat(8 * 1024 * 1024);
    for _ in 0..10 {
        socket.send(chunk.clone(), "review", None);
    }
    let closed = tokio::time::timeout(Duration::from_secs(20), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        closed,
        Event::Closed {
            code: Some(1013),
            reason: "client too slow".into()
        }
    );
    // The close frame waits behind data the client never read; the server
    // gave up after its close timeout and ended the connection.
    let mut read = client.buffer.len();
    let mut buffer = vec![0; 1 << 20];
    while let Ok(count @ 1..) = client.stream.read(&mut buffer).await {
        read += count;
    }
    assert!(read > 0 && read < BACKPRESSURE_HARD_LIMIT_BYTES, "{read}");
}

#[tokio::test(start_paused = true)]
async fn closes_a_socket_whose_buffer_stops_draining_for_30_seconds() {
    let (address, mut sockets) = server().await;
    let _client = Client::connect(&address, None).await;
    let (socket, mut events) = sockets.recv().await.unwrap();
    // Over the 8 MiB limit, under the hard one, and never read.
    for _ in 0..6 {
        socket.send("s".repeat(4 * 1024 * 1024), "review", None);
    }
    let stats = socket.stats().await.unwrap();
    assert!(
        stats.wire.buffered > 8 * 1024 * 1024,
        "{:?}",
        stats.wire.buffered
    );
    tokio::time::advance(Duration::from_secs(29)).await;
    socket.send("x", "message", None);
    tokio::time::advance(Duration::from_secs(2)).await;
    socket.send("y", "message", None);
    let stats = socket.stats().await;
    let closed = events.recv().await.unwrap();
    assert!(
        matches!(
            closed,
            Event::Closed {
                code: Some(1013),
                ..
            }
        ),
        "{closed:?} {stats:?}"
    );
}

#[tokio::test]
async fn passes_binary_messages_both_ways_as_they_are() {
    let (address, mut sockets) = server().await;
    let mut client = Client::connect(&address, None).await;
    let (socket, mut events) = sockets.recv().await.unwrap();
    client
        .send(frame::BINARY, &[0, 0, 0xff, 0x7f, 0, 0x80], false)
        .await;
    assert_eq!(
        events.recv().await.unwrap(),
        Event::Binary {
            data: vec![0, 0, 0xff, 0x7f, 0, 0x80]
        }
    );
    socket.send_binary(vec![1, 2, 3]);
    let received = client.next().await.unwrap();
    assert_eq!(
        received,
        Received {
            opcode: frame::BINARY,
            compressed: false,
            payload: vec![1, 2, 3]
        }
    );
}
