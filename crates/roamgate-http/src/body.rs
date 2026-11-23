//! A JSON request body read under a byte limit (http/json-body.ts): the
//! stream is read chunk by chunk and dropped (cancelled) as soon as it
//! passes the limit, whatever its Content-Length says.

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::Value;

/// Why a body was refused: `TooLarge` is the TS `RangeError` (413), the
/// rest a bad request (400).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyError {
    Missing,
    TooLarge,
    Invalid,
}

/// The body of a request: `None` when it has none.
pub async fn read_json_body<S, E>(body: Option<S>, max_bytes: usize) -> Result<Value, BodyError>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let Some(mut body) = body else {
        return Err(BodyError::Missing);
    };
    let mut data = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| BodyError::Invalid)?;
        if data.len() + chunk.len() > max_bytes {
            drop(body);
            return Err(BodyError::TooLarge);
        }
        data.extend_from_slice(&chunk);
    }
    // `Buffer.toString("utf8")` replaces bad sequences before JSON.parse.
    let text = String::from_utf8_lossy(&data);
    serde_json::from_str(&text).map_err(|_| BodyError::Invalid)
}
