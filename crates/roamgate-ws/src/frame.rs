//! WebSocket framing on tungstenite's frame header codec, with the RSV1 bit
//! of permessage-deflate handled here: tungstenite's own protocol layer
//! refuses reserved bits, so messages are assembled by this module.

use bytes::{Buf, BufMut, BytesMut};
use std::io::Cursor;
use tungstenite::protocol::frame::FrameHeader;
use tungstenite::protocol::frame::coding::{Control, Data, OpCode};

use crate::deflate::{InflateError, Inflater};

/// A close the reader asks for: the peer broke the protocol.
#[derive(Debug, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: u16,
    pub reason: &'static str,
}

const fn fail(code: u16, reason: &'static str) -> ProtocolError {
    ProtocolError { code, reason }
}

/// One message or control frame from the peer.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Text {
        text: String,
        compressed: bool,
    },
    Binary {
        data: Vec<u8>,
        compressed: bool,
    },
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    /// The peer's close: its status code and reason, if it gave one.
    Close(Option<(u16, String)>),
}

struct Fragmented {
    text: bool,
    compressed: bool,
    data: Vec<u8>,
}

/// Turns the bytes a server reads into messages.
pub struct Reader {
    buffer: BytesMut,
    fragmented: Option<Fragmented>,
    max_message: usize,
    inflater: Option<Inflater>,
}

impl Reader {
    /// `compressed`: permessage-deflate was negotiated, so RSV1 is allowed.
    pub fn new(max_message: usize, compressed: bool) -> Self {
        Reader {
            buffer: BytesMut::with_capacity(16 * 1024),
            fragmented: None,
            max_message,
            inflater: compressed.then(Inflater::default),
        }
    }

    pub fn buffer_mut(&mut self) -> &mut BytesMut {
        &mut self.buffer
    }

    /// The next whole message or control frame in the buffer, if any.
    pub fn next_message(&mut self) -> Result<Option<Incoming>, ProtocolError> {
        loop {
            let mut cursor = Cursor::new(&self.buffer[..]);
            let Some((header, length)) =
                FrameHeader::parse(&mut cursor).map_err(|_| fail(1002, "invalid frame header"))?
            else {
                return Ok(None);
            };
            let header_len = cursor.position() as usize;
            let length = usize::try_from(length).map_err(|_| fail(1009, "message too big"))?;
            let is_control = matches!(header.opcode, OpCode::Control(_));
            if is_control && (length > 125 || !header.is_final) {
                return Err(fail(1002, "invalid control frame"));
            }
            let pending = self.fragmented.as_ref().map_or(0, |f| f.data.len());
            if !is_control && pending + length > self.max_message {
                return Err(fail(1009, "message too big"));
            }
            if self.buffer.len() < header_len + length {
                self.buffer.reserve(header_len + length - self.buffer.len());
                return Ok(None);
            }
            if header.rsv2 || header.rsv3 {
                return Err(fail(1002, "reserved bits set"));
            }
            let Some(mask) = header.mask else {
                return Err(fail(1002, "unmasked client frame"));
            };
            self.buffer.advance(header_len);
            let mut payload = self.buffer.split_to(length).to_vec();
            unmask(&mut payload, mask);
            if let Some(incoming) = self.frame(&header, payload)? {
                return Ok(Some(incoming));
            }
        }
    }

    fn frame(
        &mut self,
        header: &FrameHeader,
        payload: Vec<u8>,
    ) -> Result<Option<Incoming>, ProtocolError> {
        let starts_message = matches!(header.opcode, OpCode::Data(Data::Text | Data::Binary));
        if header.rsv1 && !(starts_message && self.inflater.is_some()) {
            return Err(fail(1002, "reserved bits set"));
        }
        match header.opcode {
            OpCode::Control(Control::Ping) => Ok(Some(Incoming::Ping(payload))),
            OpCode::Control(Control::Pong) => Ok(Some(Incoming::Pong(payload))),
            OpCode::Control(Control::Close) => close_frame(&payload).map(Some),
            OpCode::Control(Control::Reserved(_)) | OpCode::Data(Data::Reserved(_)) => {
                Err(fail(1002, "reserved opcode"))
            }
            OpCode::Data(Data::Text | Data::Binary) => {
                if self.fragmented.is_some() {
                    return Err(fail(1002, "message started inside another"));
                }
                let message = Fragmented {
                    text: header.opcode == OpCode::Data(Data::Text),
                    compressed: header.rsv1,
                    data: payload,
                };
                if header.is_final {
                    return self.finish(message).map(Some);
                }
                self.fragmented = Some(message);
                Ok(None)
            }
            OpCode::Data(Data::Continue) => {
                let Some(mut message) = self.fragmented.take() else {
                    return Err(fail(1002, "continuation without a message"));
                };
                message.data.extend_from_slice(&payload);
                if header.is_final {
                    return self.finish(message).map(Some);
                }
                self.fragmented = Some(message);
                Ok(None)
            }
        }
    }

    fn finish(&mut self, message: Fragmented) -> Result<Incoming, ProtocolError> {
        let data = match (&mut self.inflater, message.compressed) {
            (Some(inflater), true) => inflater
                .decompress(&message.data, self.max_message)
                .map_err(|error| match error {
                    InflateError::TooBig => fail(1009, "message too big"),
                    InflateError::Corrupt(_) => fail(1007, "invalid compressed data"),
                })?,
            _ => message.data,
        };
        if message.text {
            let text = String::from_utf8(data).map_err(|_| fail(1007, "invalid UTF-8"))?;
            Ok(Incoming::Text {
                text,
                compressed: message.compressed,
            })
        } else {
            Ok(Incoming::Binary {
                data,
                compressed: message.compressed,
            })
        }
    }
}

fn close_frame(payload: &[u8]) -> Result<Incoming, ProtocolError> {
    match payload.len() {
        0 => Ok(Incoming::Close(None)),
        1 => Err(fail(1002, "invalid close frame")),
        _ => {
            let code = u16::from_be_bytes([payload[0], payload[1]]);
            let valid = matches!(code, 1000..=1003 | 1007..=1014 | 3000..=4999);
            if !valid {
                return Err(fail(1002, "invalid close code"));
            }
            let reason = std::str::from_utf8(&payload[2..])
                .map_err(|_| fail(1007, "invalid UTF-8"))?
                .to_owned();
            Ok(Incoming::Close(Some((code, reason))))
        }
    }
}

pub fn unmask(payload: &mut [u8], mask: [u8; 4]) {
    let word = u32::from_ne_bytes(mask);
    let (words, rest) = payload.as_chunks_mut::<4>();
    for chunk in words {
        *chunk = (u32::from_ne_bytes(*chunk) ^ word).to_ne_bytes();
    }
    for (byte, key) in rest.iter_mut().zip(mask) {
        *byte ^= key;
    }
}

/// Appends one unmasked, final frame (a server frame) to `out`.
pub fn encode(out: &mut BytesMut, opcode: OpCode, payload: &[u8], rsv1: bool) {
    let header = FrameHeader {
        is_final: true,
        rsv1,
        rsv2: false,
        rsv3: false,
        opcode,
        mask: None,
    };
    let mut writer = out.writer();
    // Writing into memory cannot fail.
    let _ = header.format(payload.len() as u64, &mut writer);
    writer.into_inner().extend_from_slice(payload);
}

/// The payload of a close frame.
pub fn close_payload(close: Option<(u16, &str)>) -> Vec<u8> {
    match close {
        None => Vec::new(),
        Some((code, reason)) => {
            let mut payload = code.to_be_bytes().to_vec();
            // A control frame carries at most 125 bytes.
            let mut end = reason.len().min(123);
            while !reason.is_char_boundary(end) {
                end -= 1;
            }
            payload.extend_from_slice(&reason.as_bytes()[..end]);
            payload
        }
    }
}

pub const TEXT: OpCode = OpCode::Data(Data::Text);
pub const CONTINUE: OpCode = OpCode::Data(Data::Continue);
pub const BINARY: OpCode = OpCode::Data(Data::Binary);
pub const CLOSE: OpCode = OpCode::Control(Control::Close);
pub const PING: OpCode = OpCode::Control(Control::Ping);
pub const PONG: OpCode = OpCode::Control(Control::Pong);

/// Builds a masked client frame, for tests and the spike's own client.
pub fn encode_client(
    out: &mut BytesMut,
    opcode: OpCode,
    payload: &[u8],
    rsv1: bool,
    is_final: bool,
    mask: [u8; 4],
) {
    let header = FrameHeader {
        is_final,
        rsv1,
        rsv2: false,
        rsv3: false,
        opcode,
        mask: Some(mask),
    };
    let mut writer = out.writer();
    let _ = header.format(payload.len() as u64, &mut writer);
    let out = writer.into_inner();
    let start = out.len();
    out.extend_from_slice(payload);
    unmask(&mut out[start..], mask);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(reader: &mut Reader, bytes: &[u8]) -> Result<Vec<Incoming>, ProtocolError> {
        reader.buffer_mut().extend_from_slice(bytes);
        let mut messages = Vec::new();
        while let Some(message) = reader.next_message()? {
            messages.push(message);
        }
        Ok(messages)
    }

    #[test]
    fn assembles_fragments_around_control_frames() {
        let mut wire = BytesMut::new();
        encode_client(
            &mut wire,
            TEXT,
            "héllo ".as_bytes(),
            false,
            false,
            [1, 2, 3, 4],
        );
        encode_client(&mut wire, PING, b"p", false, true, [5, 6, 7, 8]);
        encode_client(
            &mut wire,
            CONTINUE,
            "wörld".as_bytes(),
            false,
            true,
            [9, 9, 9, 9],
        );
        let mut reader = Reader::new(1 << 20, false);
        // Byte by byte: a frame is only read once whole.
        let mut messages = Vec::new();
        for byte in wire.iter() {
            messages.extend(read_all(&mut reader, &[*byte]).unwrap());
        }
        assert_eq!(
            messages,
            vec![
                Incoming::Ping(b"p".to_vec()),
                Incoming::Text {
                    text: "héllo wörld".into(),
                    compressed: false
                }
            ]
        );
    }

    #[test]
    fn refuses_what_rfc_6455_forbids() {
        type Build = Box<dyn Fn(&mut BytesMut)>;
        let cases: Vec<(Build, bool, u16)> = vec![
            (Box::new(|w| encode(w, TEXT, b"x", false)), false, 1002),
            (
                Box::new(|w| encode_client(w, TEXT, b"x", true, true, [1; 4])),
                false,
                1002,
            ),
            (
                Box::new(|w| encode_client(w, CONTINUE, b"x", false, true, [1; 4])),
                false,
                1002,
            ),
            (
                Box::new(|w| encode_client(w, TEXT, &[0xff, 0xfe], false, true, [1; 4])),
                false,
                1007,
            ),
            (
                Box::new(|w| encode_client(w, TEXT, &[b'a'; 2000], false, true, [1; 4])),
                false,
                1009,
            ),
            (
                Box::new(|w| encode_client(w, CLOSE, &[3], false, true, [1; 4])),
                false,
                1002,
            ),
            (
                Box::new(|w| encode_client(w, PING, &[0; 126], false, true, [1; 4])),
                false,
                1002,
            ),
            (
                Box::new(|w| encode_client(w, CONTINUE, b"x", true, true, [1; 4])),
                true,
                1002,
            ),
        ];
        for (index, (build, compressed, code)) in cases.into_iter().enumerate() {
            let mut wire = BytesMut::new();
            build(&mut wire);
            let mut reader = Reader::new(1024, compressed);
            assert_eq!(
                read_all(&mut reader, &wire).unwrap_err().code,
                code,
                "case {index}"
            );
        }
    }

    #[test]
    fn reads_close_codes_and_writes_bounded_reasons() {
        let mut wire = BytesMut::new();
        encode_client(
            &mut wire,
            CLOSE,
            &close_payload(Some((4001, "logged out"))),
            false,
            true,
            [7; 4],
        );
        let mut reader = Reader::new(1024, false);
        assert_eq!(
            read_all(&mut reader, &wire).unwrap(),
            vec![Incoming::Close(Some((4001, "logged out".into())))]
        );
        assert_eq!(close_payload(Some((1000, &"é".repeat(100)))).len(), 2 + 122);
    }
}
