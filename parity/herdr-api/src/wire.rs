//! The handshake of Herdr's client socket, from Herdr's `src/protocol/wire.rs`
//! at the same release.
//!
//! Frames are a u32 little-endian length, then the message as bincode 2
//! (`config::standard`). Only the handshake variants are copied; they are
//! the first variant of their enums (Herdr freezes the order for endpoint
//! generation 1), so a one-variant copy encodes them with the same index 0.

use serde::{Deserialize, Serialize};

/// `PROTOCOL_VERSION` of Herdr's wire.rs.
pub const PROTOCOL_VERSION: u32 = 22;

/// `MAX_FRAME_SIZE` of Herdr's wire.rs.
pub const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;

/// Render payload encoding negotiated during client handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RenderEncoding {
    /// Send full semantic FrameData values. This is the local/default mode.
    SemanticFrame,
    /// Send already-diffed terminal ANSI byte streams.
    TerminalAnsi,
}

/// Size of the pane surface requested by a client-owned shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientSurfaceSize {
    pub cols: u16,
    pub rows: u16,
}

/// `ClientMessage` and `ServerMessage` variant indices of endpoint
/// generation 1 (frozen; the enums are not copied whole).
pub mod variant {
    pub const CLIENT_SHELL_RESIZE: u32 = 12;
    pub const CLIENT_SHELL_PANE_INPUT: u32 = 13;
    pub const CLIENT_SHELL_ENDPOINT_REQUEST: u32 = 15;
    pub const ENDPOINT_CONTROL: u32 = 20;
    pub const SERVER_CLIPBOARD: u32 = 5;
    pub const SERVER_SEMANTIC_NOTIFICATION: u32 = 14;
    pub const SERVER_CLIENT_SHELL_ERROR: u32 = 15;
    pub const SERVER_ENDPOINT_RESPONSE_CHUNK: u32 = 18;
    pub const SERVER_ENDPOINT_CONTROL: u32 = 20;
}

/// One frame of an enum variant: bincode writes a variant as its index
/// (a varint u32) then its fields in order, which is what this tuple gives.
pub fn encode_variant<T: Serialize>(index: u32, fields: &T) -> Vec<u8> {
    encode(&(index, fields))
}

/// `ServerMessage::EndpointControl { kind, data }`.
pub fn endpoint_control(kind: &str, data: &str) -> Vec<u8> {
    encode_variant(variant::SERVER_ENDPOINT_CONTROL, &(kind, data))
}

/// `ServerMessage::ClientShellEndpointResponseChunk`, one final chunk.
pub fn endpoint_response(boot_id: &str, request_id: &str, data: &str) -> Vec<u8> {
    encode_variant(
        variant::SERVER_ENDPOINT_RESPONSE_CHUNK,
        &(boot_id, request_id, true, data.as_bytes().to_vec()),
    )
}

/// The start of a payload decoded as `M`, the rest ignored.
pub fn decode_prefix<M: for<'de> Deserialize<'de>>(payload: &[u8]) -> Result<M, String> {
    bincode::serde::decode_from_slice::<M, _>(payload, bincode::config::standard())
        .map(|(message, _)| message)
        .map_err(|error| error.to_string())
}

/// `ServerMessage::PaneSurface` (variant 13).
pub const SERVER_PANE_SURFACE: u32 = 13;

/// `ClientMessage::EndpointControl` or `ClientShellEndpointRequest`: the two
/// strings after the variant index.
pub fn decode_two_strings(payload: &[u8]) -> Result<(u32, String, String), String> {
    decode::<(u32, String, String)>(payload)
}

/// `ClientMessage`, its first variant only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientMessage {
    /// Direct terminal handshake: announces protocol version and terminal dimensions.
    TerminalHello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        pixel_mouse: bool,
    },
}

/// `ServerMessage`, its first variant only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerMessage {
    /// Handshake response: server acknowledges (or rejects) the client.
    Welcome {
        /// Protocol version the server speaks.
        version: u32,
        /// Render encoding selected by the server for this connection.
        encoding: RenderEncoding,
        /// If present, the handshake failed and this describes why.
        error: Option<String>,
    },
}

/// A message as one frame.
pub fn encode<M: Serialize>(message: &M) -> Vec<u8> {
    let payload = bincode::serde::encode_to_vec(message, bincode::config::standard())
        .expect("bincode encodes plain data");
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(&payload);
    frame
}

/// The variant index and the rest of a frame's payload (without its
/// length), for messages a one-variant copy cannot decode.
pub fn variant(payload: &[u8]) -> Option<u32> {
    bincode::decode_from_slice::<u32, _>(payload, bincode::config::standard())
        .ok()
        .map(|(index, _)| index)
}

/// A frame's payload decoded as `M`, all of it.
pub fn decode<M: for<'de> Deserialize<'de>>(payload: &[u8]) -> Result<M, String> {
    let (message, used) =
        bincode::serde::decode_from_slice::<M, _>(payload, bincode::config::standard())
            .map_err(|error| error.to_string())?;
    if used != payload.len() {
        return Err(format!("{} trailing bytes", payload.len() - used));
    }
    Ok(message)
}
