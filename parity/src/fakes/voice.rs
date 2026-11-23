//! fake-voice-helper: `roamgate-voice` on its frame protocol
//! (roamgate_protocol::frames, the helper's own codec: a u32 little-endian
//! length, a kind byte, the payload; kind 0 is JSON, kind 1 audio).
//!
//! Each JSON request with an `id` is answered `{"id", "ok": true}` merged
//! with the script's `replies.<op>` (an object), or, when that is a list,
//! with each of its values in turn (events without `id` are sent as they
//! are). `call_start` also starts a signalling WebSocket server on
//! 127.0.0.1 that says welcome, as webrtcsink's does first, and gives its
//! port. The script's `stall` lists ops never answered, and `crash_on`
//! ops that make the helper exit with code 3.
//!
//! Also: `events.<op>` lists events sent after any request of that op,
//! with or without an `id` (`listen_start` has none); in them a whole
//! string `"$session"`, `"$call"` or `"$id"` becomes the request's field.
//! `on_audio` lists events sent at the first audio frame of each session
//! (`"$session"` likewise). `hello` lists events sent at start. Every JSON
//! request is appended to `roamgate-voice.frames.jsonl` in the fakes
//! directory, and audio frames as `{"audio": <session>, "bytes": n}`.

use std::io::{self, Write};
use std::net::TcpListener;

use serde_json::{Map, Value, json};

use super::script::Script;

pub use roamgate_protocol::frames::{AUDIO, JSON, MAX_FRAME, encode, read};

fn send(out: &mut impl Write, value: &Value) {
    let _ = out.write_all(&encode(JSON, value.to_string().as_bytes()));
    let _ = out.flush();
}

/// A signalling server that greets each peer.
///
/// `producers` (the script's `signalling_producers`, `"$call"` filled)
/// answer a peer's `{"type": "list"}`; `after` (`signalling_events`) are
/// sent to every peer after the welcome, `delay_ms` (`signalling_delay_ms`)
/// later.
fn signalling(call: u64, producers: Vec<Value>, after: Vec<Value>, delay_ms: u64) -> u16 {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        return 0;
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
    let request = json!({"call": call});
    let producers: Vec<Value> = producers.iter().map(|each| fill(each, &request)).collect();
    let after: Vec<Value> = after.iter().map(|each| fill(each, &request)).collect();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let producers = producers.clone();
            let after = after.clone();
            std::thread::spawn(move || {
                let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else {
                    return;
                };
                let welcome = json!({"type": "welcome", "peerId": format!("fake-peer-{call}")});
                let _ = socket.send(welcome.to_string().into());
                if !after.is_empty() && delay_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
                for message in &after {
                    let _ = socket.send(message.to_string().into());
                }
                while let Ok(message) = socket.read() {
                    let asked = message
                        .to_text()
                        .ok()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                        .is_some_and(|value| value.get("type") == Some(&json!("list")));
                    if asked {
                        let list = json!({"type": "list", "producers": producers});
                        let _ = socket.send(list.to_string().into());
                    }
                }
            });
        }
    });
    port
}

/// `"$session"`, `"$call"` and `"$id"` replaced by the request's fields.
fn fill(value: &Value, request: &Value) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => request
            .get(&text[1..])
            .cloned()
            .unwrap_or_else(|| value.clone()),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill(item, request)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), fill(item, request)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn log_frame(value: &Value) {
    use std::io::Write as _;
    let Some(dir) = super::script::fakes_dir() else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("roamgate-voice.frames.jsonl"))
    {
        let _ = file.write_all(format!("{value}\n").as_bytes());
    }
}

fn list(script: &Script, key: &str) -> Vec<String> {
    script
        .extra
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn run(script: &Script) -> i32 {
    let replies = script
        .extra
        .get("replies")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let stall = list(script, "stall");
    let crash = list(script, "crash_on");
    let events = script
        .extra
        .get("events")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let on_audio = script
        .extra
        .get("on_audio")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut heard: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    let mut input = io::stdin().lock();
    let mut out = io::stdout().lock();
    for event in script
        .extra
        .get("hello")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        send(&mut out, event);
    }
    loop {
        let (kind, payload) = match read(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(error) => {
                eprintln!("fake voice helper: {error}");
                return 2;
            }
        };
        if kind == AUDIO && payload.len() >= 4 {
            let session = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
            log_frame(&json!({"audio": session, "bytes": payload.len() - 4}));
            if heard.insert(session) {
                let request = json!({"session": session});
                for event in &on_audio {
                    send(&mut out, &fill(event, &request));
                }
            }
            continue;
        }
        if kind != JSON {
            continue;
        }
        let Ok(request) = serde_json::from_slice::<Value>(&payload) else {
            continue;
        };
        log_frame(&request);
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if crash.contains(&op) {
            return 3;
        }
        if stall.contains(&op) {
            continue;
        }
        let scripted: Vec<Value> = events
            .get(&op)
            .and_then(Value::as_array)
            .map(|items| items.iter().map(|item| fill(item, &request)).collect())
            .unwrap_or_default();
        let Some(id) = request.get("id").cloned() else {
            for event in &scripted {
                send(&mut out, event);
            }
            continue;
        };
        let mut reply = Map::new();
        reply.insert("id".into(), id.clone());
        reply.insert("ok".into(), Value::Bool(true));
        if op == "call_start" {
            let call = request.get("call").and_then(Value::as_u64).unwrap_or(0);
            let producers = script
                .extra
                .get("signalling_producers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let after = script
                .extra
                .get("signalling_events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            reply.insert(
                "signalling_port".into(),
                json!(signalling(
                    call,
                    producers,
                    after,
                    script
                        .extra
                        .get("signalling_delay_ms")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                )),
            );
        }
        match replies.get(&op) {
            Some(Value::Object(extra)) => {
                reply.extend(extra.clone());
                send(&mut out, &Value::Object(reply));
            }
            Some(Value::Array(items)) => {
                for item in items {
                    if item.get("id").is_some() || item.get("event").is_none() {
                        let mut merged = reply.clone();
                        if let Value::Object(extra) = item {
                            merged.extend(extra.clone());
                        }
                        send(&mut out, &Value::Object(merged));
                    } else {
                        send(&mut out, item);
                    }
                }
            }
            _ => send(&mut out, &Value::Object(reply)),
        }
        for event in &scripted {
            send(&mut out, event);
        }
    }
}
