//! The voice helper's frame codec (roamgate_protocol::frames) over tokio
//! streams, with the channel's 64 MiB cap.

use std::io;

use roamgate_protocol::frames;
use tokio::io::{AsyncRead, AsyncReadExt};

/// The next frame, or None at the end of the input (also when the length
/// field itself is cut short, as the sync reader does).
pub async fn read_frame(
    input: &mut (impl AsyncRead + Unpin),
    max: usize,
) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        let read = input.read(&mut header[filled..]).await?;
        if read == 0 {
            return Ok(None);
        }
        filled += read;
    }
    let length = frames::frame_length(header, max)?;
    let mut frame = vec![0u8; length];
    input.read_exact(&mut frame).await?;
    let kind = frame.remove(0);
    Ok(Some((kind, frame)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_what_the_codec_writes_and_takes_its_cap() {
        let mut stream = frames::encode(0, b"{}");
        stream.extend(frames::encode(2, b"abcde"));
        let mut input = &stream[..];
        assert_eq!(
            read_frame(&mut input, 64).await.unwrap(),
            Some((0, b"{}".to_vec()))
        );
        assert_eq!(
            read_frame(&mut input, 64).await.unwrap(),
            Some((2, b"abcde".to_vec()))
        );
        assert_eq!(read_frame(&mut input, 64).await.unwrap(), None);
        let big = frames::encode(0, &[0u8; 10]);
        assert!(read_frame(&mut &big[..], 10).await.is_err());
        let cut = [9u8, 0, 0, 0, 0, 1];
        assert!(read_frame(&mut &cut[..], 64).await.is_err());
    }
}
