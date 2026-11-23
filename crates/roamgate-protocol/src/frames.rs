//! The voice helper's frames, on its stdin and stdout and on the server's
//! side of them: the little-endian u32 length of what follows, a kind byte,
//! then the payload. Audio goes raw, without base64 or JSON around it
//! (`contract/vectors/voice-frames.json`).
//!
//! Only the codec lives here, over `std::io::Read` and `Write`; which
//! descriptor the frames go to is the helper's business (its `take_stdout`).

use std::io::{self, Read, Write};

/// A JSON object, UTF-8.
pub const JSON: u8 = 0;
/// A listening session's audio: its u32 (little-endian) id, then 16 kHz
/// mono S16LE samples.
pub const AUDIO: u8 = 1;

/// The largest frame accepted (its length field, kind byte included): a
/// few seconds of audio, or a long request.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// The next frame, or None at the end of the input. A zero length or one
/// past [`MAX_FRAME`] is `InvalidData`; a frame cut short is
/// `UnexpectedEof`.
pub fn read(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad frame length {length}"),
        ));
    }
    let mut frame = vec![0u8; length];
    input.read_exact(&mut frame)?;
    let kind = frame.remove(0);
    Ok(Some((kind, frame)))
}

/// A frame's bytes.
pub fn encode(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    frame
}

/// Writes a frame in one piece, then flushes.
pub fn write(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    output.write_all(&encode(kind, payload))?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vectors;

    #[test]
    fn frames_round_trip() {
        let mut stream = Vec::new();
        write(&mut stream, JSON, br#"{"op":"ping"}"#).unwrap();
        write(&mut stream, AUDIO, &[7, 0, 0, 0, 1, 2]).unwrap();
        let mut input = &stream[..];
        assert_eq!(
            read(&mut input).unwrap(),
            Some((JSON, br#"{"op":"ping"}"#.to_vec()))
        );
        assert_eq!(
            read(&mut input).unwrap(),
            Some((AUDIO, vec![7, 0, 0, 0, 1, 2]))
        );
        assert_eq!(read(&mut input).unwrap(), None);
    }

    #[test]
    fn refuses_bad_lengths_and_cut_frames() {
        let zero = [0u8, 0, 0, 0];
        let error = read(&mut &zero[..]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let past = ((MAX_FRAME + 1) as u32).to_le_bytes();
        let error = read(&mut &past[..]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let cut = [5u8, 0, 0, 0, 0, b'{'];
        let error = read(&mut &cut[..]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        // A length field cut short is the end of the input.
        assert_eq!(read(&mut &[1u8, 0][..]).unwrap(), None);
        // The largest frame is accepted.
        let big = encode(AUDIO, &vec![0u8; MAX_FRAME - 1]);
        assert_eq!(
            read(&mut big.as_slice()).unwrap().unwrap().1.len(),
            MAX_FRAME - 1
        );
    }

    #[test]
    fn voice_frames_vectors() {
        let doc = vectors::load_raw("voice-frames");
        assert_eq!(doc["max_frame"].as_u64().unwrap() as usize, MAX_FRAME);
        let frames = doc["frames"].as_array().unwrap();
        assert!(!frames.is_empty());
        for case in frames {
            let name = case["name"].as_str().unwrap();
            let kind = case["kind"].as_u64().unwrap() as u8;
            let payload = match case.get("payload_text") {
                Some(text) => text.as_str().unwrap().as_bytes().to_vec(),
                None => vectors::hex(case["payload_hex"].as_str().unwrap()),
            };
            let frame = vectors::hex(case["frame_hex"].as_str().unwrap());
            assert_eq!(encode(kind, &payload), frame, "{name}: encode");
            let mut written = Vec::new();
            write(&mut written, kind, &payload).unwrap();
            assert_eq!(written, frame, "{name}: write");
            let decoded = read(&mut frame.as_slice()).unwrap().unwrap();
            assert_eq!(decoded, (kind, payload), "{name}: decode");
        }
        let invalid = doc["invalid"].as_array().unwrap();
        assert!(!invalid.is_empty());
        for case in invalid {
            let bytes = vectors::hex(case["bytes_hex"].as_str().unwrap());
            assert!(read(&mut bytes.as_slice()).is_err(), "{}", case["name"]);
        }
    }
}
