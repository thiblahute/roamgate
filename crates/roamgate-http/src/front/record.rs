//! Record mode on the front (contract-record/hooks.ts `recordFetch` and
//! `recordWebSocket`): every request and response as one `exchange` line
//! of the `http` channel, and each browser socket's `open`, `in`, `out`
//! and `close` lines on its own channel, into the recorder
//! `ROAMGATE_CONTRACT_RECORD` names (roamgate-base's `record`, the file
//! format Bun's recorder wrote).

use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;

use axum::body::Body;
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame, SizeHint};
use regex::Regex;
use roamgate_base::record::{ContractRecorder, RawKind, RecordInput};
use serde_json::{Map, Value};
use tokio::sync::oneshot;

/// Bodies up to this size are recorded; larger ones only by size.
pub const RECORD_BODY_LIMIT: u64 = 256 * 1024;

static CAPTURED_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:application/(?:[a-z.+-]*\+)?json|application/x-www-form-urlencoded|text/plain)\b",
    )
    .expect("regex")
});

fn body_kind(content_type: Option<&str>) -> Option<RawKind> {
    let content_type = content_type?;
    if !CAPTURED_TYPE.is_match(content_type) {
        return None;
    }
    let lower = content_type.to_ascii_lowercase();
    Some(if lower.contains("x-www-form-urlencoded") {
        RawKind::Form
    } else if lower.contains("json") {
        RawKind::Json
    } else {
        RawKind::Text
    })
}

/// What was kept of a body: its text when it was small enough, its size,
/// whether it was cut.
#[derive(Debug, Default, Clone, PartialEq)]
struct Captured {
    body: Option<(String, RawKind)>,
    size: Option<u64>,
    cut: bool,
}

fn header_text<'a>(headers: &'a http::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// A message's headers as `Object.fromEntries(headers)`: lower-case names,
/// a repeated header's values joined.
fn headers_object(headers: &http::HeaderMap) -> Value {
    let mut out = Map::new();
    for (name, value) in headers {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match out.get_mut(name.as_str()) {
            Some(Value::String(seen)) => {
                seen.push_str(", ");
                seen.push_str(&value);
            }
            _ => {
                out.insert(name.as_str().to_owned(), Value::String(value));
            }
        }
    }
    Value::Object(out)
}

/// The body's tap: what it saw, told once the body ended or was dropped.
struct Tap {
    kind: RawKind,
    kept: Vec<u8>,
    size: u64,
    cut: bool,
    done: Option<oneshot::Sender<Captured>>,
}

impl Tap {
    fn see(&mut self, chunk: &[u8]) {
        self.size += chunk.len() as u64;
        if self.cut {
            return;
        }
        if self.size > RECORD_BODY_LIMIT {
            self.cut = true;
            self.kept = Vec::new();
            return;
        }
        self.kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, ended: bool) {
        let Some(done) = self.done.take() else {
            return;
        };
        let captured = if !ended {
            // A body that never ended (a dropped connection): not read.
            Captured::default()
        } else if self.cut {
            Captured {
                body: None,
                size: Some(self.size),
                cut: true,
            }
        } else {
            Captured {
                body: Some((
                    String::from_utf8_lossy(&std::mem::take(&mut self.kept)).into_owned(),
                    self.kind,
                )),
                size: Some(self.size),
                cut: false,
            }
        };
        let _ = done.send(captured);
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        self.finish(false);
    }
}

/// A body passed on as it is (its size hint kept, so a sized response
/// stays sized), its bytes seen by a tap.
struct TapBody {
    inner: Body,
    tap: Tap,
}

impl HttpBody for TapBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let this = &mut *self;
        let polled = Pin::new(&mut this.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    this.tap.see(data);
                }
            }
            Poll::Ready(None) => this.tap.finish(true),
            _ => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// `captureBody`: the body to record (a tapped copy of it) or its size
/// only; `forced` the kind of a body whatever its type says.
fn capture(
    headers: &http::HeaderMap,
    body: Body,
    forced: Option<RawKind>,
) -> (Body, oneshot::Receiver<Captured>) {
    let (done, captured) = oneshot::channel();
    let kind = forced.or_else(|| body_kind(header_text(headers, "content-type")));
    let length = header_text(headers, "content-length").and_then(|text| text.parse::<u64>().ok());
    let Some(kind) = kind.filter(|_| !body.is_end_stream()) else {
        // `length || undefined`: an empty length is no size.
        let _ = done.send(Captured {
            size: length.filter(|length| *length > 0),
            ..Captured::default()
        });
        return (body, captured);
    };
    if let Some(length) = length.filter(|length| *length > RECORD_BODY_LIMIT) {
        let _ = done.send(Captured {
            body: None,
            size: Some(length),
            cut: true,
        });
        return (body, captured);
    }
    let tap = Tap {
        kind,
        kept: Vec::new(),
        size: 0,
        cut: false,
        done: Some(done),
    };
    (Body::new(TapBody { inner: body, tap }), captured)
}

fn no_body() -> oneshot::Receiver<Captured> {
    let (done, captured) = oneshot::channel();
    let _ = done.send(Captured::default());
    captured
}

/// Records `request` and what `handle` answers as one `exchange` line
/// once both bodies were read: method, path, query, headers, status, the
/// JSON, form or text bodies up to 256 KiB, the time to the response's
/// headers; a WebSocket upgrade records `upgrade: true`.
pub async fn exchange<F, Fut>(
    recorder: &Arc<ContractRecorder>,
    request: http::Request<Body>,
    handle: F,
) -> http::Response<Body>
where
    F: FnOnce(http::Request<Body>) -> Fut,
    Fut: std::future::Future<Output = http::Response<Body>>,
{
    let started = Instant::now();
    let (parts, body) = request.into_parts();
    let method = parts.method.as_str().to_owned();
    let host = header_text(&parts.headers, "host").unwrap_or("localhost");
    let url = format!(
        "http://{host}{}",
        parts
            .uri
            .path_and_query()
            .map_or_else(|| parts.uri.path(), |value| value.as_str())
    );
    let headers = headers_object(&parts.headers);
    let (body, request_body) = if method == "GET" || method == "HEAD" {
        (body, no_body())
    } else {
        capture(&parts.headers, body, None)
    };
    let response = handle(http::Request::from_parts(parts, body)).await;
    let ms = started.elapsed().as_millis() as u64;
    let upgrade = response.status() == http::StatusCode::SWITCHING_PROTOCOLS;
    let status = response.status().as_u16();
    let response_headers = headers_object(response.headers());
    let (response, response_body) = if upgrade || method == "HEAD" {
        (response, no_body())
    } else {
        let (parts, body) = response.into_parts();
        let (body, captured) = capture(&parts.headers, body, None);
        (http::Response::from_parts(parts, body), captured)
    };
    let recorder = recorder.clone();
    tokio::spawn(async move {
        let request = request_body.await.unwrap_or_default();
        let response = response_body.await.unwrap_or_default();
        let mut fields = Map::new();
        fields.insert("method".into(), Value::String(method));
        fields.insert("headers".into(), headers);
        if let Some(size) = request.size {
            fields.insert("size".into(), size.into());
        }
        if request.cut {
            fields.insert("cut".into(), true.into());
        }
        fields.insert("ms".into(), ms.into());
        if upgrade {
            fields.insert("upgrade".into(), true.into());
        } else {
            fields.insert("status".into(), status.into());
            fields.insert("response_headers".into(), response_headers);
            if let Some(size) = response.size {
                fields.insert("response_size".into(), size.into());
            }
            if response.cut {
                fields.insert("response_cut".into(), true.into());
            }
        }
        let mut input = RecordInput::new("http", "exchange");
        input.url = Some(url);
        input.fields = Some(fields);
        for (key, captured) in [("body", request), ("response", response)] {
            if let Some((raw, kind)) = captured.body {
                input.bodies.push((key.into(), raw, kind));
            }
        }
        recorder.record(input);
    });
    response
}

static SOCKET_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A recorded browser socket: its id (`<channel>-<pid>-<n>`) and channel.
#[derive(Clone)]
pub struct RecordedSocket {
    recorder: Arc<ContractRecorder>,
    id: String,
    channel: &'static str,
    /// A flow-controlled reply's chunks, by chunk id, until its last one.
    chunks: Arc<Mutex<std::collections::HashMap<String, Vec<String>>>>,
}

/// The `\u{1}<chunk id>:<done 0|1>:<text>` marker of a chunked message
/// (bridge/websocket-send.ts).
const CHUNK_MARKER: char = '\u{1}';

impl RecordedSocket {
    /// The socket of `path` (index.ts `socketChannel`).
    pub fn new(recorder: Arc<ContractRecorder>, path: &str) -> Self {
        let channel = match path {
            "/api/notifications/ws" => "notifications",
            "/api/voice/call/signalling" => "signalling",
            "/api/voice/ws" => "voice",
            _ => "ws",
        };
        let n = SOCKET_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        Self {
            recorder,
            id: format!("{channel}-{}-{n}", std::process::id()),
            channel,
            chunks: Arc::default(),
        }
    }

    fn input(&self, ev: &str) -> RecordInput {
        let mut input = RecordInput::new(self.channel, ev);
        input.sock = Some(self.id.clone());
        input
    }

    fn fields(pairs: &[(&str, Value)]) -> Option<Map<String, Value>> {
        Some(
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.clone()))
                .collect(),
        )
    }

    pub fn open(&self) {
        self.recorder.record(self.input("open"));
    }

    pub fn text_in(&self, text: &str) {
        let mut input = self.input("in");
        input.raw = Some(text.to_owned());
        self.recorder.record(input);
    }

    pub fn binary_in(&self, length: usize) {
        let mut input = self.input("in");
        input.fields = Self::fields(&[("binary", length.into())]);
        self.recorder.record(input);
    }

    pub fn binary_out(&self, length: usize) {
        let mut input = self.input("out");
        input.fields = Self::fields(&[("binary", length.into())]);
        self.recorder.record(input);
    }

    /// A text message sent: a chunked one is recorded once, whole, at its
    /// last chunk.
    pub fn text_out(&self, text: &str) {
        let mut input = self.input("out");
        if let Some(rest) = text.strip_prefix(CHUNK_MARKER)
            && let Some((id, rest)) = rest.split_once(':')
            && let Some((done, part)) = rest.split_once(':')
            && !id.is_empty()
        {
            let mut chunks = self.chunks.lock().expect("chunks");
            let parts = chunks.entry(id.to_owned()).or_default();
            parts.push(part.to_owned());
            if done != "1" {
                return;
            }
            let parts = chunks.remove(id).unwrap_or_default();
            input.fields = Self::fields(&[("chunks", parts.len().into())]);
            input.raw = Some(parts.concat());
        } else {
            input.raw = Some(text.to_owned());
        }
        self.recorder.record(input);
    }

    pub fn close(&self, code: Option<u16>, reason: &str) {
        let mut input = self.input("close");
        let mut fields = Map::new();
        fields.insert("code".into(), code.map_or(Value::Null, Value::from));
        if !reason.is_empty() {
            fields.insert("reason".into(), reason.into());
        }
        input.fields = Some(fields);
        self.recorder.record(input);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorder(dir: &std::path::Path) -> Arc<ContractRecorder> {
        let now: roamgate_base::log::NowFn = Arc::new(|| 1_767_225_600_000);
        Arc::new(
            ContractRecorder::new(roamgate_base::record::RecorderOptions::new(
                dir, "server", now,
            ))
            .unwrap(),
        )
    }

    fn lines(dir: &std::path::Path) -> Vec<Value> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            out.extend(text.lines().map(|line| serde_json::from_str(line).unwrap()));
        }
        out
    }

    /// hooks.test.ts's exchange: the JSON bodies both ways, the headers
    /// with their credentials redacted, the size, the status; a large
    /// body by its size only; the response passed on unchanged.
    #[tokio::test]
    async fn records_an_exchange_with_its_bodies_and_passes_the_response_on() {
        let dir = tempfile::tempdir().unwrap();
        let recorder = recorder(dir.path());
        let request = http::Request::builder()
            .method("POST")
            .uri("/api/thing?x=1&token=secret")
            .header("host", "example.test")
            .header("content-type", "application/json")
            .header("cookie", "roamgate_session=abc")
            .body(Body::from(r#"{"a":1}"#))
            .unwrap();
        let response = exchange(&recorder, request, |request| async move {
            let body = axum::body::to_bytes(request.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(&body[..], br#"{"a":1}"#);
            http::Response::builder()
                .status(201)
                .header("content-type", "application/json; charset=utf-8")
                .body(Body::from(r#"{"ok":true}"#))
                .unwrap()
        })
        .await;
        assert_eq!(response.status(), 201);
        assert_eq!(
            response.size_hint().exact(),
            Some(r#"{"ok":true}"#.len() as u64)
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], br#"{"ok":true}"#);

        let large = "x".repeat(RECORD_BODY_LIMIT as usize + 1);
        let request = http::Request::builder()
            .method("GET")
            .uri("/big")
            .body(Body::empty())
            .unwrap();
        let response = exchange(&recorder, request, |_| async move {
            http::Response::builder()
                .header("content-type", "text/plain")
                .body(Body::from(large))
                .unwrap()
        })
        .await;
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        recorder.close();

        let lines = lines(dir.path());
        let exchanges: Vec<&Value> = lines
            .iter()
            .filter(|line| line["ev"] == "exchange")
            .collect();
        assert_eq!(exchanges.len(), 2, "{lines:?}");
        let first = exchanges
            .iter()
            .find(|line| line["path"] == "/api/thing")
            .unwrap();
        assert_eq!(first["ch"], "http");
        assert_eq!(first["method"], "POST");
        assert_eq!(first["status"], 201);
        assert_eq!(first["size"], 7);
        assert_eq!(first["body"], serde_json::json!({ "a": 1 }));
        assert_eq!(first["response"], serde_json::json!({ "ok": true }));
        assert_eq!(first["query"]["x"], "1");
        assert_ne!(first["query"]["token"], "secret");
        assert_ne!(first["headers"]["cookie"], "roamgate_session=abc");
        assert_eq!(first["headers"]["host"], "example.test");
        let second = exchanges
            .iter()
            .find(|line| line["path"] == "/big")
            .unwrap();
        assert_eq!(second["response_cut"], true);
        assert_eq!(second["response_size"], RECORD_BODY_LIMIT + 1);
        assert!(second.get("response").is_none());
    }

    /// A socket's lines: open, in, out (a chunked reply once, whole),
    /// binary frames by length, close.
    #[test]
    fn records_a_socket_s_messages() {
        let dir = tempfile::tempdir().unwrap();
        let recorder = recorder(dir.path());
        let socket = RecordedSocket::new(recorder.clone(), "/ws");
        socket.open();
        socket.text_in(r#"{"id":"1","method":"bridge.ping"}"#);
        socket.text_out("\u{1}c1:0:{\"id\":\"1\",");
        socket.text_out("\u{1}c1:1:\"result\":{}}");
        socket.binary_out(3);
        socket.close(Some(1000), "");
        recorder.close();
        let lines: Vec<Value> = lines(dir.path())
            .into_iter()
            .filter(|line| line["ch"] == "ws")
            .collect();
        let events: Vec<&str> = lines
            .iter()
            .map(|line| line["ev"].as_str().unwrap())
            .collect();
        assert_eq!(events, ["open", "in", "out", "out", "close"]);
        assert!(
            lines[0]["sock"]
                .as_str()
                .unwrap()
                .starts_with(&format!("ws-{}-", std::process::id()))
        );
        assert_eq!(lines[2]["chunks"], 2);
        assert_eq!(
            lines[2]["msg"],
            serde_json::json!({ "id": "1", "result": {} })
        );
        assert_eq!(lines[3]["binary"], 3);
        assert_eq!(lines[4]["code"], 1000);
    }
}
