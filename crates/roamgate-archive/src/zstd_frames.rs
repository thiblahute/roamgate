//! zstd frames (archive/zstd.ts): a source range compressed as one frame
//! appended to an archived file (frames concatenate into one valid
//! stream), with a content checksum, verified by decompressing it again.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

const LEVEL: i32 = 10;

/// What one frame holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameResult {
    pub bytes: u64,
    pub sha256: String,
    pub zst_bytes: u64,
}

fn open_dest(dest: &Path, append: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).create(true);
    if append {
        options.append(true);
    } else {
        options.write(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(dest)
}

fn open_append(dest: &Path) -> io::Result<File> {
    open_dest(dest, true)
}

/// Cuts `dest` to `len` bytes. Through a writing handle: Windows refuses
/// to resize, or flush, a file opened only to append or to read.
fn cut(dest: &Path, len: u64) -> io::Result<()> {
    open_dest(dest, false)?.set_len(len)
}

/// Source bytes [start, end) as one frame appended to `dest`, which is
/// first cut to `keep` bytes (crash recovery). On any failure `dest` is cut
/// back to `keep`.
pub fn append_frame_at(
    source: &Path,
    start: u64,
    end: u64,
    dest: &Path,
    keep: u64,
) -> io::Result<FrameResult> {
    if let Some(parent) = dest.parent() {
        roamgate_base::private::create_dir_all_mode(parent)?;
    }
    cut(dest, keep)?;
    let result = (|| {
        let mut input = Sha256::new();
        let mut bytes = 0u64;
        if end > start {
            let out = open_append(dest)?;
            let mut encoder = zstd::stream::write::Encoder::new(out, LEVEL)?;
            encoder.include_checksum(true)?;
            let mut file = File::open(source)?;
            file.seek(SeekFrom::Start(start))?;
            let mut reader = file.take(end - start);
            let mut chunk = vec![0u8; 1 << 20];
            loop {
                let read = reader.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                input.update(&chunk[..read]);
                bytes += read as u64;
                encoder.write_all(&chunk[..read])?;
            }
            encoder.finish()?.flush()?;
        }
        let after = std::fs::metadata(dest)?.len();
        open_dest(dest, false)?.sync_all()?;
        let digest = hex::encode(input.finalize());
        if end > start {
            let mut file = File::open(dest)?;
            file.seek(SeekFrom::Start(keep))?;
            let mut decoder = zstd::stream::read::Decoder::new(file.take(after - keep))?;
            let mut output = Sha256::new();
            let mut verified = 0u64;
            let mut chunk = vec![0u8; 1 << 20];
            loop {
                let read = decoder.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                output.update(&chunk[..read]);
                verified += read as u64;
            }
            if verified != bytes || hex::encode(output.finalize()) != digest {
                return Err(io::Error::other(format!(
                    "verification mismatch for {}",
                    dest.display()
                )));
            }
        }
        Ok(FrameResult {
            bytes,
            sha256: digest,
            zst_bytes: after - keep,
        })
    })();
    if result.is_err() {
        let _ = cut(dest, keep);
    }
    result
}

/// As [`append_frame_at`], keeping what `dest` holds.
pub fn append_frame(source: &Path, start: u64, end: u64, dest: &Path) -> io::Result<FrameResult> {
    let keep = match std::fs::metadata(dest) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    append_frame_at(source, start, end, dest, keep)
}

/// The decompressed bytes of an archived file, streamed (every frame).
pub fn read_archived(path: &Path) -> io::Result<impl Read + use<>> {
    zstd::stream::read::Decoder::new(File::open(path)?)
}

/// The decompressed bytes of `path` from `seek_zst` (a frame boundary) up
/// to `zst_end`.
pub fn read_archived_range(
    path: &Path,
    seek_zst: u64,
    zst_end: Option<u64>,
) -> io::Result<Box<dyn Read>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(seek_zst))?;
    match zst_end {
        Some(end) => Ok(Box::new(zstd::stream::read::Decoder::new(
            file.take(end.saturating_sub(seek_zst)),
        )?)),
        None => Ok(Box::new(zstd::stream::read::Decoder::new(file)?)),
    }
}

/// Decompresses the whole archived file: its size and SHA-256.
pub fn archived_digest(path: &Path) -> io::Result<(u64, String)> {
    let mut reader = read_archived(path)?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut chunk = vec![0u8; 1 << 20];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
        bytes += read as u64;
    }
    Ok((bytes, hex::encode(hash.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appended_frames_are_one_valid_zstd_stream_with_a_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("s.jsonl");
        let dest = dir.path().join("raw/s.jsonl.zst");
        std::fs::write(&source, "one\ntwo\n").unwrap();
        let first = append_frame(&source, 0, 4, &dest).unwrap();
        assert_eq!(first.bytes, 4);
        let second = append_frame(&source, 4, 8, &dest).unwrap();
        assert_eq!(second.bytes, 4);
        let mut text = String::new();
        read_archived(&dest)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "one\ntwo\n");
        // The frame header's descriptor has the checksum flag (bit 2).
        let raw = std::fs::read(&dest).unwrap();
        assert_eq!(&raw[..4], &[0x28, 0xb5, 0x2f, 0xfd]);
        assert_ne!(raw[4] & 0b100, 0);
        assert_eq!(archived_digest(&dest).unwrap().0, 8);
        // From the second frame only.
        let mut tail = String::new();
        read_archived_range(&dest, first.zst_bytes, None)
            .unwrap()
            .read_to_string(&mut tail)
            .unwrap();
        assert_eq!(tail, "two\n");
    }

    #[test]
    fn a_failed_append_is_cut_back() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("x.zst");
        std::fs::write(&dest, b"keep").unwrap();
        assert!(append_frame_at(&dir.path().join("missing"), 0, 4, &dest, 4).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"keep");
    }
}
