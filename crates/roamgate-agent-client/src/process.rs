//! Small process helpers the clients share.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A command's standard output, or None when it did not start or did not
/// end within `timeout` (it is killed then), as
/// `subprocess.run(..., capture_output=True, timeout=...)`.
pub fn output_within(command: &mut Command, timeout: Duration) -> Option<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }
    reader.join().ok()
}

/// Writes what a client printed.
pub fn print(stdout: &str, stderr: &str) {
    if !stdout.is_empty() {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(stdout.as_bytes());
        let _ = out.flush();
    }
    if !stderr.is_empty() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(stderr.as_bytes());
        let _ = err.flush();
    }
}
