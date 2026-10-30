//! Messages on stdin and stdout: the little-endian u32 length of what
//! follows, a kind byte, then the payload. Audio goes raw, without base64 or
//! JSON around it.

use std::io::{self, Read, Write};

/// A JSON object, UTF-8.
pub const JSON: u8 = 0;
/// A listening session's audio: its u32 (little-endian) id, then 16 kHz
/// mono S16LE samples.
pub const AUDIO: u8 = 1;

/// The largest frame accepted: a few seconds of audio, or a long request.
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// The next frame, or None at the end of the input.
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

pub fn write(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    output.write_all(&(payload.len() as u32 + 1).to_le_bytes())?;
    output.write_all(&[kind])?;
    output.write_all(payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
