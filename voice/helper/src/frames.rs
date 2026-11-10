//! Messages on stdin and stdout: the little-endian u32 length of what
//! follows, a kind byte, then the payload. Audio goes raw, without base64 or
//! JSON around it.
//!
//! Frames own stdout: `take_stdout` keeps the process's stdout for them
//! alone and points stdout itself at stderr, so whatever else writes there
//! (webrtcsink's signalling server installs a tracing subscriber writing to
//! stdout, a C library may print) goes to the log instead of breaking the
//! frames.

use std::fs::File;
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

/// Writes a frame in one piece.
pub fn write(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    output.write_all(&frame)?;
    output.flush()
}

/// The process's stdout, for frames alone: stdout itself (fd 1, and the
/// standard output handle on Windows) goes to stderr from then on.
#[cfg(unix)]
pub fn take_stdout() -> io::Result<File> {
    use std::os::fd::FromRawFd;
    io::stdout().flush()?;
    // SAFETY: descriptor calls on fds 1 and 2, which are open; the copy is
    // close-on-exec and owned by the File alone.
    unsafe {
        let frames = libc::fcntl(libc::STDOUT_FILENO, libc::F_DUPFD_CLOEXEC, 3);
        if frames < 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) < 0 {
            let err = io::Error::last_os_error();
            libc::close(frames);
            return Err(err);
        }
        Ok(File::from_raw_fd(frames))
    }
}

/// The process's stdout, for frames alone: stdout itself (fd 1, and the
/// standard output handle on Windows) goes to stderr from then on.
#[cfg(windows)]
pub fn take_stdout() -> io::Result<File> {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const DUPLICATE_SAME_ACCESS: u32 = 2;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(which: u32) -> RawHandle;
        fn SetStdHandle(which: u32, handle: RawHandle) -> i32;
        fn GetCurrentProcess() -> RawHandle;
        fn DuplicateHandle(
            source_process: RawHandle,
            source: RawHandle,
            target_process: RawHandle,
            target: *mut RawHandle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
    }
    unsafe extern "C" {
        fn _dup2(from: i32, to: i32) -> i32;
    }
    io::stdout().flush()?;
    // SAFETY: the process's own standard handles; the duplicate is owned by
    // the File alone and not inherited.
    unsafe {
        let mut frames: RawHandle = std::ptr::null_mut();
        let process = GetCurrentProcess();
        if DuplicateHandle(
            process,
            GetStdHandle(STD_OUTPUT_HANDLE),
            process,
            &mut frames,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        // C's stdout, then the handle Rust's stdout writes to.
        _dup2(2, 1);
        if SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE)) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from_raw_handle(frames))
    }
}

/// Elsewhere stdout stays shared: frames go to it as they are.
#[cfg(not(any(unix, windows)))]
pub fn take_stdout() -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "stdout cannot be kept for frames here",
    ))
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
