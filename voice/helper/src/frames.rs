//! Messages on stdin and stdout: the little-endian u32 length of what
//! follows, a kind byte, then the payload. Audio goes raw, without base64 or
//! JSON around it. The codec is roamgate-protocol's, the server's own.
//!
//! Frames own stdout: `take_stdout` keeps the process's stdout for them
//! alone and points stdout itself at stderr, so whatever else writes there
//! (webrtcsink's signalling server installs a tracing subscriber writing to
//! stdout, a C library may print) goes to the log instead of breaking the
//! frames.

use std::fs::File;
use std::io::{self, Write};

pub use roamgate_protocol::frames::{AUDIO, JSON, read, write};

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
