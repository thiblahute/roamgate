//! bridge/thin-client.test.ts and thin-client.tagged-contract.test.ts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;
use crate::protocol::is_supported_herdr_protocol;

struct Server {
    _dir: tempfile::TempDir,
    path: String,
}

type OnPayload = Arc<dyn Fn(Vec<u8>, &mut Vec<Vec<u8>>) + Send + Sync>;

/// A server calling `on_payload` with each frame; frames it pushes are
/// written back at once, coalesced.
fn start_frame_server(on_connection: Arc<dyn Fn() + Send + Sync>, on_payload: OnPayload) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thin.sock");
    let listener = UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            on_connection();
            let on_payload = on_payload.clone();
            tokio::spawn(serve(stream, on_payload));
        }
    });
    Server {
        path: path.to_str().unwrap().to_owned(),
        _dir: dir,
    }
}

async fn serve(mut stream: UnixStream, on_payload: OnPayload) {
    let mut input = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = stream.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return;
        }
        input.extend_from_slice(&chunk[..read]);
        while input.len() >= 4 {
            let length = u32::from_le_bytes(input[..4].try_into().unwrap()) as usize;
            if input.len() < length + 4 {
                break;
            }
            let payload: Vec<u8> = input.drain(..length + 4).skip(4).collect();
            let mut out = Vec::new();
            on_payload(payload, &mut out);
            for bytes in out {
                if stream.write_all(&bytes).await.is_err() {
                    return;
                }
            }
        }
    }
}

fn welcome_frame(version: u64, encoding: u64, error: Option<&str>) -> Vec<u8> {
    let mut writer = BinWriter::new();
    writer.variant(0);
    writer.varint(version);
    writer.varint(encoding);
    writer.option(error, |writer, error| writer.string(error));
    encode_frame(&writer.into_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Hello {
    protocol: u64,
    launch_mode: u64,
}

/// A server answering Hello with `welcome(protocol)`.
fn start_handshake_server(
    welcome: impl Fn(u64) -> (u64, u64, Option<String>) + Send + Sync + 'static,
    hellos: Arc<Mutex<Vec<Hello>>>,
    connections: Arc<Mutex<usize>>,
) -> Server {
    start_frame_server(
        Arc::new(move || *connections.lock().unwrap() += 1),
        Arc::new(move |payload, out| {
            let mut reader = BinReader::new(&payload);
            assert_eq!(reader.variant().unwrap(), 0);
            let protocol = reader.varint().unwrap();
            for _ in 0..4 {
                reader.varint().unwrap();
            }
            let mut launch_mode = 0;
            if protocol == 22 {
                assert!(!reader.bool().unwrap());
            } else {
                reader.varint().unwrap();
                reader.varint().unwrap();
                launch_mode = reader.varint().unwrap();
            }
            assert_eq!(reader.remaining(), 0);
            hellos.lock().unwrap().push(Hello {
                protocol,
                launch_mode,
            });
            let (version, encoding, error) = welcome(protocol);
            out.push(welcome_frame(version, encoding, error.as_deref()));
        }),
    )
}

/// A server welcoming any Hello, then calling `on_variant` for each message.
fn start_message_server(
    on_variant: impl Fn(u64, &mut BinReader<'_>, &mut Vec<Vec<u8>>) + Send + Sync + 'static,
) -> Server {
    start_frame_server(
        Arc::new(|| {}),
        Arc::new(move |payload, out| {
            let mut reader = BinReader::new(&payload);
            let variant = reader.variant().unwrap();
            on_variant(variant, &mut reader, out);
            if variant != 0 {
                return;
            }
            let protocol = reader.varint().unwrap();
            out.push(welcome_frame(protocol, 1, None));
        }),
    )
}

fn protocol(value: i64) -> std::future::Ready<Value> {
    std::future::ready(json!(value))
}

fn terminal_attach() -> ConnectOptions {
    ConnectOptions {
        launch_mode: LaunchMode::TerminalAttach,
        encoding: 1,
    }
}

async fn next_matching(
    events: &mut broadcast::Receiver<ThinEvent>,
    keep: impl Fn(&ThinEvent) -> bool,
) -> ThinEvent {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("an event in time")
            .unwrap();
        if keep(&event) {
            return event;
        }
    }
}

#[test]
fn supports_verified_legacy_codecs_and_exact_tagged_protocol_22_not_21() {
    let supported: Vec<bool> = (14..=22)
        .map(|p| is_supported_herdr_protocol(&json!(p)))
        .collect();
    assert_eq!(
        supported,
        [true, true, true, true, true, true, true, false, true]
    );
    assert!(!is_supported_herdr_protocol(&json!(13)));
    assert!(!is_supported_herdr_protocol(&json!(23)));
    assert!(!is_supported_herdr_protocol(&json!(999)));
    for bad in [
        json!(13),
        json!(21),
        json!(23),
        json!(999),
        json!(17.5),
        json!(0x1_0000_0000u64),
        json!("22"),
        Value::Null,
    ] {
        let error = assert_supported_herdr_protocol(&bad).unwrap_err();
        assert!(error.contains("supports protocols 14-20 and 22"), "{error}");
    }
}

#[tokio::test]
async fn waits_for_a_successful_protocol_welcome() {
    for version in [14, 15, 16, 17, 18] {
        let hellos = Arc::new(Mutex::new(Vec::new()));
        let server = start_handshake_server(
            |requested| (requested, 1, None),
            hellos.clone(),
            Arc::default(),
        );
        let client = ThinClient::new(&server.path, None);
        client
            .connect(protocol(version), 100, 30, terminal_attach())
            .await
            .unwrap();
        let seen: Vec<u64> = hellos.lock().unwrap().iter().map(|h| h.protocol).collect();
        assert_eq!(seen, [version as u64]);
        client.close();
    }
}

#[tokio::test]
async fn maps_the_terminal_attach_launch_mode_onto_the_negotiated_protocol() {
    for (version, expected) in [(19, 1), (20, 2)] {
        let hellos = Arc::new(Mutex::new(Vec::new()));
        let server = start_handshake_server(
            |requested| (requested, 1, None),
            hellos.clone(),
            Arc::default(),
        );
        let client = ThinClient::new(&server.path, None);
        client
            .connect(protocol(version), 100, 30, terminal_attach())
            .await
            .unwrap();
        assert_eq!(
            *hellos.lock().unwrap(),
            [Hello {
                protocol: version as u64,
                launch_mode: expected
            }]
        );
        client.close();
    }
}

#[tokio::test]
async fn keeps_the_app_launch_mode_at_wire_value_0_on_newer_protocols() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let server = start_handshake_server(
        |requested| (requested, 1, None),
        hellos.clone(),
        Arc::default(),
    );
    let client = ThinClient::new(&server.path, None);
    client
        .connect(
            protocol(20),
            100,
            30,
            ConnectOptions {
                launch_mode: LaunchMode::App,
                encoding: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        *hellos.lock().unwrap(),
        [Hello {
            protocol: 20,
            launch_mode: 0
        }]
    );
    client.close();
}

#[tokio::test]
async fn uses_the_terminal_hello_layout_on_protocol_22() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let server = start_handshake_server(
        |requested| (requested, 1, None),
        hellos.clone(),
        Arc::default(),
    );
    let client = ThinClient::new(&server.path, None);
    client
        .connect(protocol(22), 100, 30, terminal_attach())
        .await
        .unwrap();
    assert_eq!(
        *hellos.lock().unwrap(),
        [Hello {
            protocol: 22,
            launch_mode: 0
        }]
    );
    client.close();
}

#[tokio::test]
async fn decodes_terminal_frames_at_the_protocol_22_variant_index() {
    let server = start_message_server(|variant, _, out| {
        if variant != 5 {
            return;
        }
        let mut writer = BinWriter::new();
        writer.variant(1);
        writer.varint(7);
        writer.varint(100);
        writer.varint(30);
        writer.bool(true);
        writer.bytes(b"hello");
        out.push(encode_frame(&writer.into_bytes()));
    });
    let client = ThinClient::new(&server.path, None);
    let mut events = client.events();
    client
        .connect(protocol(22), 100, 30, terminal_attach())
        .await
        .unwrap();
    client.attach("term_1", true).unwrap();
    let terminal = next_matching(&mut events, |e| matches!(e, ThinEvent::Terminal { .. })).await;
    assert_eq!(
        terminal,
        ThinEvent::Terminal {
            seq: 7,
            width: 100,
            height: 30,
            full: true,
            bytes: b"hello".to_vec()
        }
    );
    client.close();
}

#[tokio::test]
async fn appends_pixel_mouse_to_resize_only_on_protocol_22() {
    let resizes = Arc::new(Mutex::new(Vec::new()));
    let seen = resizes.clone();
    let server = start_message_server(move |variant, reader, _| {
        if variant != 3 {
            return;
        }
        for _ in 0..4 {
            reader.varint().unwrap();
        }
        seen.lock().unwrap().push(reader.bool().unwrap());
    });
    let client = ThinClient::new(&server.path, None);
    client
        .connect(protocol(22), 100, 30, terminal_attach())
        .await
        .unwrap();
    client.resize(120, 40);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(*resizes.lock().unwrap(), [false]);
    client.close();
}

#[tokio::test]
async fn rejects_a_welcome_error_instead_of_treating_the_socket_as_attached() {
    let server = start_handshake_server(
        |requested| {
            (
                16,
                1,
                Some(format!(
                    "client version {requested} is older than server version 16"
                )),
            )
        },
        Arc::default(),
        Arc::default(),
    );
    let client = ThinClient::new(&server.path, None);
    let error = client
        .connect(protocol(14), 100, 30, ConnectOptions::default())
        .await
        .unwrap_err();
    assert!(
        error.contains("Herdr rejected thin-client protocol 14"),
        "{error}"
    );
}

#[tokio::test]
async fn rejects_protocol_before_opening_a_thin_socket() {
    for version in [13, 21, 23, 999] {
        let client = ThinClient::new("/missing.sock", None);
        let error = client
            .connect(protocol(version), 100, 30, ConnectOptions::default())
            .await
            .unwrap_err();
        assert!(
            error.contains(&format!("Herdr protocol {version} is not supported")),
            "{error}"
        );
    }
}

#[tokio::test]
async fn rejects_unsupported_welcome_protocol() {
    for version in [13, 21, 23, 999] {
        let server =
            start_handshake_server(move |_| (version, 1, None), Arc::default(), Arc::default());
        let client = ThinClient::new(&server.path, None);
        let error = client
            .connect(protocol(22), 100, 30, ConnectOptions::default())
            .await
            .unwrap_err();
        assert!(
            error.contains(&format!("Herdr protocol {version} is not supported")),
            "{error}"
        );
        assert!(client.is_closed());
    }
}

#[tokio::test]
async fn rejects_a_supported_but_mismatched_welcome_protocol() {
    let server = start_handshake_server(|_| (20, 1, None), Arc::default(), Arc::default());
    let client = ThinClient::new(&server.path, None);
    let error = client
        .connect(protocol(22), 100, 30, ConnectOptions::default())
        .await
        .unwrap_err();
    assert!(
        error.contains("welcomed protocol 20, expected 22"),
        "{error}"
    );
}

#[tokio::test]
async fn requires_terminal_ansi_encoding_in_protocol_22_welcome() {
    let server = start_handshake_server(|_| (22, 0, None), Arc::default(), Arc::default());
    let client = ThinClient::new(&server.path, None);
    let error = client
        .connect(protocol(22), 100, 30, ConnectOptions::default())
        .await
        .unwrap_err();
    assert!(error.contains("unsupported encoding 0"), "{error}");
}

#[tokio::test]
async fn rejects_an_oversized_frame_before_accepting_a_coalesced_welcome() {
    let server = start_message_server(|variant, _, out| {
        if variant == 0 {
            out.push(((MAX_FRAME_BYTES + 1) as u32).to_le_bytes().to_vec());
        }
    });
    let client = ThinClient::new(&server.path, None);
    let error = client
        .connect(protocol(22), 100, 30, ConnectOptions::default())
        .await
        .unwrap_err();
    assert!(error.contains("oversized frame"), "{error}");
    assert!(client.is_closed());
}

#[tokio::test]
async fn does_not_open_a_socket_when_closed_during_protocol_resolution() {
    let connections = Arc::new(Mutex::new(0usize));
    let server = start_handshake_server(
        |requested| (requested, 1, None),
        Arc::default(),
        connections.clone(),
    );
    let client = ThinClient::new(&server.path, None);
    let (tx, rx) = oneshot::channel::<i64>();
    let connecting = tokio::spawn({
        let client = client.clone();
        async move {
            client
                .connect(
                    async move { json!(rx.await.unwrap()) },
                    100,
                    30,
                    ConnectOptions::default(),
                )
                .await
        }
    });
    tokio::task::yield_now().await;
    client.close();
    tx.send(17).unwrap();
    assert_eq!(
        connecting.await.unwrap(),
        Err("thin client is closed".into())
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(*connections.lock().unwrap(), 0);
}

#[tokio::test]
async fn sends_the_one_time_terminal_attach_transition_only_once() {
    let variants = Arc::new(Mutex::new(Vec::new()));
    let seen = variants.clone();
    let server = start_message_server(move |variant, _, _| seen.lock().unwrap().push(variant));
    let client = ThinClient::new(&server.path, None);
    client
        .connect(protocol(17), 100, 30, terminal_attach())
        .await
        .unwrap();
    client.attach("term_1", true).unwrap();
    client.attach("term_1", true).unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(*variants.lock().unwrap(), [0, 5]);
    let error = client.attach("term_2", true).unwrap_err();
    assert!(error.contains("already attached to term_1"), "{error}");
    client.close();
}

#[tokio::test]
async fn encodes_both_physical_page_keys_with_the_page_key_source() {
    type Scroll = (u64, Vec<u8>, u64, u64);
    let scrolls = Arc::new(Mutex::new(Vec::<Scroll>::new()));
    let seen = scrolls.clone();
    let server = start_message_server(move |variant, reader, _| {
        if variant != 6 {
            return;
        }
        let source = reader.variant().unwrap();
        let bytes = if source == 1 {
            reader.bytes().unwrap()
        } else {
            Vec::new()
        };
        let direction = reader.variant().unwrap();
        let lines = reader.varint().unwrap();
        assert_eq!(reader.option(BinReader::varint).unwrap(), None);
        assert_eq!(reader.option(BinReader::varint).unwrap(), None);
        assert_eq!(reader.u8().unwrap(), 0);
        seen.lock().unwrap().push((source, bytes, direction, lines));
    });
    let client = ThinClient::new(&server.path, None);
    client
        .connect(protocol(17), 100, 30, terminal_attach())
        .await
        .unwrap();
    client.scroll(ScrollDirection::Up, 28.0, None, None, ScrollSource::PageKey);
    client.scroll(
        ScrollDirection::Down,
        17.0,
        None,
        None,
        ScrollSource::PageKey,
    );
    for _ in 0..100 {
        if scrolls.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        *scrolls.lock().unwrap(),
        [
            (1, vec![0x1b, 0x5b, 0x35, 0x7e], 0, 28),
            (1, vec![0x1b, 0x5b, 0x36, 0x7e], 1, 17),
        ]
    );
    client.close();
}

#[tokio::test]
async fn decodes_herdr_clipboard_messages_separately_from_terminal_frames() {
    let data = "cmVtb3RlIGNvcHk=";
    let server = start_message_server(move |variant, _, out| {
        if variant != 5 {
            return;
        }
        let mut writer = BinWriter::new();
        writer.variant(6);
        writer.string(data);
        out.push(encode_frame(&writer.into_bytes()));
    });
    let client = ThinClient::new(&server.path, None);
    let mut events = client.events();
    client
        .connect(protocol(17), 100, 30, terminal_attach())
        .await
        .unwrap();
    client.attach("term_1", true).unwrap();
    let clipboard = next_matching(&mut events, |e| matches!(e, ThinEvent::Clipboard(_))).await;
    assert_eq!(clipboard, ThinEvent::Clipboard(data.into()));
    client.close();
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Literal payloads of Herdr's wire.rs (thin-client.tagged-contract.test.ts),
/// independent of BinWriter.
#[tokio::test]
async fn protocol_tagged_hello_welcome_attach_render_resize_input_paste_shutdown() {
    for version in [20u64, 22] {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = seen.clone();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("contract.sock");
        let listener = UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut input = Vec::new();
            let mut chunk = vec![0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    return;
                }
                input.extend_from_slice(&chunk[..read]);
                while input.len() >= 4 {
                    let length = u32::from_le_bytes(input[..4].try_into().unwrap()) as usize;
                    if input.len() < length + 4 {
                        break;
                    }
                    let payload: Vec<u8> = input.drain(..length + 4).skip(4).collect();
                    record.lock().unwrap().push(to_hex(&payload));
                    match payload[0] {
                        0 => {
                            let welcome = encode_frame(&hex(if version == 22 {
                                "00160100"
                            } else {
                                "00140100"
                            }));
                            // A fragmented length header.
                            stream.write_all(&welcome[..2]).await.unwrap();
                            stream.flush().await.unwrap();
                            tokio::time::sleep(Duration::from_millis(5)).await;
                            stream.write_all(&welcome[2..]).await.unwrap();
                        }
                        5 => {
                            let frame = encode_frame(&hex(if version == 22 {
                                "0101641e010568656c6c6f"
                            } else {
                                "0201641e010568656c6c6f"
                            }));
                            stream.write_all(&frame).await.unwrap();
                        }
                        1 => {
                            let payloads: &[&str] = if version == 22 {
                                &[
                                    "080100",
                                    "080001",
                                    "10fb000102",
                                    "100000",
                                    "03010874616b656f766572",
                                ]
                            } else {
                                &["04010874616b656f766572"]
                            };
                            let joined: Vec<u8> = payloads
                                .iter()
                                .flat_map(|payload| encode_frame(&hex(payload)))
                                .collect();
                            stream.write_all(&joined).await.unwrap();
                        }
                        _ => {}
                    }
                }
            }
        });
        let client = ThinClient::new(path.to_str().unwrap(), None);
        let mut events = client.events();
        client
            .connect(protocol(version as i64), 100, 30, terminal_attach())
            .await
            .unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [if version == 22 {
                "0016641e000000"
            } else {
                "0014641e0000010002"
            }]
        );
        client.attach("term_1", true).unwrap();
        let mut errors = Vec::new();
        let mut mouse = Vec::new();
        let mut keyboard = Vec::new();
        let mut terminal = None;
        let mut sent_rest = false;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap();
            match event {
                ThinEvent::Terminal { .. } => {
                    terminal = Some(event);
                    if !sent_rest {
                        sent_rest = true;
                        client.resize(120, 40);
                        client.input(b"abc\x1b[200~paste\x1b[201~");
                    }
                }
                ThinEvent::Error(error) => errors.push(error),
                ThinEvent::MouseCapture {
                    enabled,
                    sgr_pixels,
                } => mouse.push((enabled, sgr_pixels)),
                ThinEvent::KeyboardProtocol {
                    flags,
                    modify_other_keys_level,
                } => keyboard.push((flags, modify_other_keys_level)),
                ThinEvent::Close => break,
                _ => {}
            }
        }
        assert_eq!(
            terminal,
            Some(ThinEvent::Terminal {
                seq: 1,
                width: 100,
                height: 30,
                full: true,
                bytes: b"hello".to_vec()
            })
        );
        assert_eq!(
            seen.lock().unwrap()[1..],
            [
                "05067465726d5f3101".to_owned(),
                if version == 22 {
                    "037828000000"
                } else {
                    "0378280000"
                }
                .to_owned(),
                "01146162631b5b3230307e70617374651b5b3230317e".to_owned(),
            ]
        );
        assert_eq!(errors, ["takeover"]);
        assert!(client.is_closed());
        if version == 22 {
            assert_eq!(mouse, [(true, false), (false, true)]);
            assert_eq!(keyboard, [(256, 2), (0, 0)]);
        } else {
            assert!(mouse.is_empty());
            assert!(keyboard.is_empty());
        }
        client.close();
    }
}

/// The top-level variant names of `enum <name>` in a vendored Herdr file.
fn vendored_variants(source: &str, name: &str) -> Vec<String> {
    let start = source
        .find(&format!("pub enum {name} {{"))
        .unwrap_or_else(|| panic!("enum {name}"));
    let body_start = start + source[start..].find('{').unwrap() + 1;
    let mut depth = 0i32;
    let mut variants = Vec::new();
    let mut end = body_start;
    for (offset, character) in source[body_start..].char_indices() {
        match character {
            '{' | '(' => depth += 1,
            '}' | ')' if depth == 0 => {
                end = body_start + offset;
                break;
            }
            '}' | ')' => depth -= 1,
            _ => {}
        }
    }
    let mut depth = 0i32;
    for line in source[body_start..end].lines() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if depth == 0 && indent == 4 && trimmed.starts_with(|c: char| c.is_ascii_uppercase()) {
            let name: String = trimmed
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            variants.push(name);
        }
        for character in line.chars() {
            match character {
                '{' | '(' => depth += 1,
                '}' | ')' => depth -= 1,
                _ => {}
            }
        }
    }
    variants
}

/// The codec's protocol-22 indices are Herdr 0.9.4's enum order.
#[test]
fn the_protocol_22_codec_matches_the_vendored_herdr_wire_types() {
    let wire = include_str!("../../vendor/herdr-0.9.4/wire.rs");
    assert_eq!(crate::release::VERIFIED_HERDR_VERSION, "0.9.4");
    let client = vendored_variants(wire, "ClientMessage");
    let at = |name: &str| client.iter().position(|v| v == name).unwrap() as u64;
    assert_eq!(at("TerminalHello"), client_message::HELLO);
    assert_eq!(at("Input"), client_message::INPUT);
    assert_eq!(at("Resize"), client_message::RESIZE);
    assert_eq!(at("AttachTerminal"), client_message::ATTACH_TERMINAL);
    assert_eq!(at("AttachScroll"), client_message::ATTACH_SCROLL);
    let server = vendored_variants(wire, "ServerMessage");
    let at = |name: &str| server.iter().position(|v| v == name).unwrap() as u64;
    assert_eq!(at("Welcome"), SM_V22.welcome);
    assert_eq!(at("Terminal"), SM_V22.terminal);
    assert_eq!(at("ServerShutdown"), SM_V22.server_shutdown);
    assert_eq!(at("Clipboard"), SM_V22.clipboard);
    assert_eq!(at("MouseCapture"), SM_V22.mouse_capture);
    assert_eq!(
        Some(at("DirectTerminalKeyboardProtocol")),
        SM_V22.direct_terminal_keyboard_protocol
    );
    assert!(!server.iter().any(|v| v == "Frame"));
    // TerminalHello's fields, in order, as hello_payload writes them.
    let hello = &wire[wire.find("    TerminalHello {").unwrap()..];
    let hello = &hello[..hello.find('}').unwrap()];
    let fields: Vec<&str> = hello
        .lines()
        .skip(1)
        .filter_map(|line| line.trim().split_once(':').map(|(name, _)| name))
        .collect();
    assert_eq!(
        fields,
        [
            "version",
            "cols",
            "rows",
            "cell_width_px",
            "cell_height_px",
            "pixel_mouse"
        ]
    );
}
