//! The voice server's HTTP surface as handlers: a request as the handler
//! needs it in, a status, headers and body out; the HTTP plumbing (the
//! server, its authentication gate, reading bodies up to their limit) is
//! the caller's.
//!
//! | Module | Routes | TS it replaces |
//! |---|---|---|
//! | [`routes`] | `/api/voice`, its settings, speech, timing, trace and voices | http/voice (all but the companion's routes) |
//! | [`setup`] | `/api/voice/setup` | http/voice-setup |
//! | [`low_gpu`] | `/api/voice/low-gpu` | http/voice-low-gpu |
//! | [`handoff`] | `/api/voice/call/handoff` | http/call-handoff |

use serde_json::Value;

pub mod handoff;
pub mod low_gpu;
pub mod routes;
pub mod setup;

/// Sent with voice requests: a page from elsewhere cannot add it.
pub const VOICE_REQUEST_HEADER: &str = "x-roamgate-voice";

/// A request's body, as the plumbing read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Body {
    /// No body (a GET).
    #[default]
    Missing,
    /// Longer than the route takes: not read.
    TooLarge,
    Bytes(Vec<u8>),
}

/// A request, as the handlers need it.
#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    /// The URL's path, still percent-encoded.
    pub path: String,
    /// The URL's query, without its `?`.
    pub query: String,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Request {
    pub fn new(method: &str, path: &str) -> Self {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        Self {
            method: method.into(),
            path: path.into(),
            query: query.into(),
            headers: Vec::new(),
            body: Body::Missing,
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers
            .push((name.to_ascii_lowercase(), value.to_owned()));
        self
    }

    pub fn json(mut self, value: &Value) -> Self {
        self.body = Body::Bytes(value.to_string().into_bytes());
        self.header("content-type", "application/json")
    }

    pub fn bytes(mut self, bytes: Vec<u8>) -> Self {
        self.body = Body::Bytes(bytes);
        self
    }

    /// A header's value (`Headers.get`: repeats joined by ", ").
    pub fn get(&self, name: &str) -> Option<String> {
        let values: Vec<&str> = self
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect();
        (!values.is_empty()).then(|| values.join(", "))
    }

    /// Whether the voice header is there (`"1"`).
    pub fn has_voice_header(&self) -> bool {
        self.get(VOICE_REQUEST_HEADER).as_deref() == Some("1")
    }

    /// `await req.json().catch(() => null)`.
    pub fn json_body(&self) -> Option<Value> {
        match &self.body {
            Body::Bytes(bytes) => crate::js::parse(std::str::from_utf8(bytes).ok()?),
            _ => None,
        }
    }

    /// `new URL(req.url).searchParams.get(name)`.
    pub fn query_param(&self, name: &str) -> Option<String> {
        self.query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(key) == name).then(|| form_decode(value))
        })
    }
}

/// An answer's body.
#[derive(Debug, Clone, PartialEq)]
pub enum AnswerBody {
    /// `Response.json`: sent `content-type: application/json;charset=utf-8`.
    Json(Value),
    /// Bytes, with the content type the headers give.
    Bytes(Vec<u8>),
    /// Text: sent `content-type: text/plain;charset=utf-8`.
    Text(&'static str),
    Empty,
}

/// A handler's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    /// Names in lower case; the content type of a JSON or text body is the
    /// plumbing's.
    pub headers: Vec<(String, String)>,
    pub body: AnswerBody,
}

impl Answer {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: AnswerBody::Json(body),
        }
    }

    /// `{"error": message}`.
    pub fn error(status: u16, message: impl Into<String>) -> Self {
        Self::json(status, serde_json::json!({ "error": message.into() }))
    }

    pub fn text(status: u16, text: &'static str) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: AnswerBody::Text(text),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: AnswerBody::Empty,
        }
    }

    pub fn with(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }

    /// `cache-control: no-store`.
    pub fn no_store(self) -> Self {
        self.with("cache-control", "no-store")
    }

    /// A header's value.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The JSON body (Null for another).
    pub fn body_json(&self) -> Value {
        match &self.body {
            AnswerBody::Json(value) => value.clone(),
            _ => Value::Null,
        }
    }
}

/// "Voice requests need their header." (403).
pub(crate) fn needs_header() -> Answer {
    Answer::error(403, "Voice requests need their header.")
}

/// `decodeURIComponent`; Err as its URIError.
pub fn decode_uri_component(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let byte = bytes
            .get(index + 1..index + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .ok_or_else(|| "URI malformed".to_owned())?;
        out.push(byte);
        index += 3;
    }
    String::from_utf8(out).map_err(|_| "URI malformed".into())
}

/// A query part as URLSearchParams decodes it: `+` is a space, a bad
/// escape stays as written, bad UTF-8 is replaced.
fn form_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' => match bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                Some(byte) => {
                    out.push(byte);
                    index += 3;
                }
                None => {
                    out.push(b'%');
                    index += 1;
                }
            },
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A part of a multipart/form-data body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormPart {
    pub name: String,
    /// Set for a file (a Blob in the form).
    pub filename: Option<String>,
    pub data: Vec<u8>,
}

impl FormPart {
    /// `form.get(name)` as a string: None for a file.
    pub fn text(&self) -> Option<String> {
        self.filename
            .is_none()
            .then(|| String::from_utf8_lossy(&self.data).into_owned())
    }
}

/// `req.formData()` for multipart/form-data; None when it is not one.
pub fn parse_form(content_type: Option<&str>, body: &[u8]) -> Option<Vec<FormPart>> {
    let content_type = content_type?;
    let (kind, params) = content_type.split_once(';').unwrap_or((content_type, ""));
    if !kind.trim().eq_ignore_ascii_case("multipart/form-data") {
        return None;
    }
    let boundary = params.split(';').find_map(|param| {
        let (key, value) = param.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("boundary")
            .then(|| value.trim().trim_matches('"').to_owned())
    })?;
    if boundary.is_empty() {
        return None;
    }
    let delimiter = format!("--{boundary}").into_bytes();
    let mut parts = Vec::new();
    let mut at = find(body, &delimiter, 0)? + delimiter.len();
    loop {
        if body[at..].starts_with(b"--") {
            return Some(parts);
        }
        at += line_end(&body[at..])?;
        let head_end = find(body, b"\r\n\r\n", at)?;
        let head = String::from_utf8_lossy(&body[at..head_end]).into_owned();
        let data_start = head_end + 4;
        let next = find(body, &[b"\r\n".as_slice(), &delimiter].concat(), data_start)?;
        let mut name = None;
        let mut filename = None;
        for line in head.split("\r\n") {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            if !key.trim().eq_ignore_ascii_case("content-disposition") {
                continue;
            }
            for param in value.split(';').skip(1) {
                let Some((key, value)) = param.split_once('=') else {
                    continue;
                };
                let value = value.trim().trim_matches('"').to_owned();
                match key.trim().to_ascii_lowercase().as_str() {
                    "name" => name = Some(value),
                    "filename" => filename = Some(value),
                    _ => {}
                }
            }
        }
        if let Some(name) = name {
            parts.push(FormPart {
                name,
                filename,
                data: body[data_start..next].to_vec(),
            });
        }
        at = next + 2 + delimiter.len();
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > haystack.len() || needle.is_empty() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// The length up to and with the line's end.
fn line_end(bytes: &[u8]) -> Option<usize> {
    find(bytes, b"\r\n", 0).map(|at| at + 2)
}

#[cfg(test)]
mod tests;
