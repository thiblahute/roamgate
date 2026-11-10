//! The helper's stdout carries frames only. Once a call starts, the call's
//! webrtcsink signalling server logs through a tracing subscriber that
//! writes to stdout: its lines must reach stderr, never the frames Roamgate
//! reads, where a log line reads as a frame's length and nothing after it is
//! understood.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const JSON: u8 = 0;
const AUDIO: u8 = 1;
/// The largest frame the helper and Roamgate accept.
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// What a pipe gave so far, read on a thread of its own.
fn collect(mut pipe: impl Read + Send + 'static) -> Arc<Mutex<Vec<u8>>> {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let into = bytes.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(read) = pipe.read(&mut chunk) {
            if read == 0 {
                break;
            }
            into.lock().unwrap().extend_from_slice(&chunk[..read]);
        }
    });
    bytes
}

/// The frames in `bytes`, and how many bytes are left of an unfinished one;
/// an error says where something that is not a frame starts.
fn frames(bytes: &[u8]) -> Result<(Vec<Value>, usize), String> {
    let mut found = Vec::new();
    let mut at = 0;
    while bytes.len() - at >= 4 {
        let length = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let shown = || String::from_utf8_lossy(&bytes[at..bytes.len().min(at + 200)]).into_owned();
        if length == 0 || length > MAX_FRAME {
            return Err(format!(
                "not a frame at byte {at} (length {length}): {:?}",
                shown()
            ));
        }
        if bytes.len() - at - 4 < length {
            break;
        }
        let kind = bytes[at + 4];
        let payload = &bytes[at + 5..at + 4 + length];
        match kind {
            JSON => found.push(
                serde_json::from_slice(payload)
                    .map_err(|e| format!("frame at byte {at} is not JSON ({e}): {:?}", shown()))?,
            ),
            AUDIO => {}
            _ => return Err(format!("frame at byte {at} has kind {kind}: {:?}", shown())),
        }
        at += 4 + length;
    }
    Ok((found, bytes.len() - at))
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl Helper {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_roamgate-voice"))
            // No models: calls and pings need none.
            .env_remove("GST_DEBUG_DUMP_DOT_DIR")
            .env_remove("WEBRTCSINK_SIGNALLING_SERVER_LOG")
            .env("ROAMGATE_VOICE_ICE_ADDRESSES", "127.0.0.1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the helper starts");
        let stdin = child.stdin.take();
        let stdout = collect(child.stdout.take().unwrap());
        let stderr = collect(child.stderr.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
            stderr,
        }
    }

    fn send(&mut self, message: Value) {
        let payload = message.to_string().into_bytes();
        let mut frame = (payload.len() as u32 + 1).to_le_bytes().to_vec();
        frame.push(JSON);
        frame.extend_from_slice(&payload);
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&frame).unwrap();
        stdin.flush().unwrap();
    }

    /// The answer to request `id`, every byte before it being frames.
    fn answer(&self, id: u64, within: Duration) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let (found, _) = frames(&self.stdout.lock().unwrap())
                .unwrap_or_else(|err| panic!("stdout: {err}\nstderr: {}", self.log()));
            if let Some(answer) = found.into_iter().find(|frame| frame["id"] == json!(id)) {
                return answer;
            }
            assert!(
                Instant::now() < deadline,
                "no answer to request {id}\nstderr: {}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn log(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn stdout_carries_only_frames_after_a_call_starts() {
    let mut helper = Helper::spawn();
    helper.send(json!({"id": 1, "op": "ping"}));
    assert_eq!(helper.answer(1, Duration::from_secs(30))["ok"], json!(true));

    helper.send(json!({"id": 2, "op": "call_start", "call": 1, "background": "", "muted": true}));
    let started = helper.answer(2, Duration::from_secs(30));
    let port = started["signalling_port"]
        .as_u64()
        .unwrap_or_else(|| panic!("no signalling port: {started}\nstderr: {}", helper.log()));

    // Not a WebSocket: the signalling server logs a warning, which went to
    // stdout before the frames had it to themselves.
    let mut socket = TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut reply = Vec::new();
    let _ = socket.read_to_end(&mut reply);
    drop(socket);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !helper.log().contains("handshake") {
        if let Err(err) = frames(&helper.stdout.lock().unwrap()) {
            panic!("the warning went into the frames: {err}");
        }
        assert!(
            Instant::now() < deadline,
            "the signalling server said nothing of the bad request\nstderr: {}",
            helper.log()
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    // The frames still read: answers come after the warning.
    helper.send(json!({"id": 3, "op": "ping"}));
    assert_eq!(helper.answer(3, Duration::from_secs(10))["ok"], json!(true));
    helper.send(json!({"id": 4, "op": "call_stop", "call": 1}));
    assert_eq!(helper.answer(4, Duration::from_secs(10))["ok"], json!(true));
    helper.send(json!({"id": 5, "op": "ping"}));
    assert_eq!(helper.answer(5, Duration::from_secs(10))["ok"], json!(true));

    // Roamgate goes: the helper ends, and all it wrote was frames.
    drop(helper.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(20);
    while helper.child.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "the helper did not end\nstderr: {}",
            helper.log()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(100));
    let (_, left) = frames(&helper.stdout.lock().unwrap())
        .unwrap_or_else(|err| panic!("stdout: {err}\nstderr: {}", helper.log()));
    assert_eq!(left, 0, "stdout ends inside a frame");
}
