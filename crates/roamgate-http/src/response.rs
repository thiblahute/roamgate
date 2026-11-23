//! Responses built as the Bun server's `Response` and `Response.json` put
//! them on the wire: a JSON body is `application/json;charset=utf-8`, a
//! text body `text/plain;charset=utf-8` (Bun adds it when it sends a string
//! with no type), headers in the order the handler gave them.

use bytes::Bytes;
use http::{HeaderValue, StatusCode};
use serde_json::Value;

pub type Response = http::Response<Bytes>;

pub const JSON_TYPE: &str = "application/json;charset=utf-8";
pub const TEXT_TYPE: &str = "text/plain;charset=utf-8";

/// A response with `body` and `headers` (name, value), in order.
pub fn with(status: u16, headers: &[(&str, &str)], body: impl Into<Bytes>) -> Response {
    let mut response = http::Response::new(body.into());
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (name, value) in headers {
        if let Ok(value) = HeaderValue::from_str(value) {
            response.headers_mut().append(
                http::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value,
            );
        }
    }
    response
}

/// `new Response(text, {status, headers})`.
pub fn text(status: u16, headers: &[(&str, &str)], body: &str) -> Response {
    let mut all: Vec<(&str, &str)> = Vec::with_capacity(headers.len() + 1);
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        all.push(("content-type", TEXT_TYPE));
    }
    all.extend_from_slice(headers);
    with(status, &all, body.to_owned())
}

/// `new Response(null, {status, headers})`.
pub fn empty(status: u16, headers: &[(&str, &str)]) -> Response {
    with(status, headers, Bytes::new())
}

/// `Response.json(value, {status, headers})`.
pub fn json(status: u16, headers: &[(&str, &str)], value: &Value) -> Response {
    // A content type the handler gives wins, as with Bun's Response.json.
    let mut all: Vec<(&str, &str)> = Vec::with_capacity(headers.len() + 1);
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
    {
        all.push(("content-type", JSON_TYPE));
    }
    all.extend_from_slice(headers);
    with(status, &all, serde_json::to_vec(value).unwrap_or_default())
}

/// A header's value as `Headers.get` reads it (several joined by `, `).
pub fn header(headers: &http::HeaderMap, name: &str) -> Option<String> {
    let mut values = headers.get_all(name).iter().peekable();
    values.peek()?;
    Some(
        values
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// `decodeURIComponent`: `None` on a malformed escape or bad UTF-8.
pub fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}
