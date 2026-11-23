//! Complete lines of a byte stream (archive/lines.ts): a final line with no
//! newline is left out, as the writer may still be appending to it.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Reads complete lines (without their newline) and their length in bytes,
/// newline included.
pub struct CompleteLines<R> {
    reader: BufReader<R>,
    buffer: Vec<u8>,
    failed: Option<io::Error>,
}

impl<R: Read> CompleteLines<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(1 << 20, reader),
            buffer: Vec::new(),
            failed: None,
        }
    }

    /// The next complete line and its length, or None at the end (a
    /// partial last line is dropped). A read error ends the lines; it is
    /// kept for [`Self::error`].
    pub fn next_line(&mut self) -> Option<(&[u8], usize)> {
        self.buffer.clear();
        match self.reader.read_until(b'\n', &mut self.buffer) {
            Ok(0) => None,
            Ok(length) if self.buffer.last() == Some(&b'\n') => {
                Some((&self.buffer[..length - 1], length))
            }
            Ok(_) => None,
            Err(error) => {
                self.failed = Some(error);
                None
            }
        }
    }

    /// The read error that ended the lines, if one did.
    pub fn take_error(&mut self) -> Option<io::Error> {
        self.failed.take()
    }
}

/// Bytes [start, end) of a file.
pub fn file_range(path: &Path, start: u64, end: u64) -> io::Result<io::Take<File>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    Ok(file.take(end.saturating_sub(start)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_last_line_is_left_out() {
        let mut lines = CompleteLines::new(&b"a\n\nbc\nd"[..]);
        let mut out = Vec::new();
        while let Some((line, length)) = lines.next_line() {
            out.push((line.to_vec(), length));
        }
        assert_eq!(
            out,
            vec![(b"a".to_vec(), 2), (Vec::new(), 1), (b"bc".to_vec(), 3)]
        );
    }
}
