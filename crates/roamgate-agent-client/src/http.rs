//! `POST /v1/<command>` on the agent socket, as the Python clients send it
//! with `http.client` (the same request line and headers), over
//! [`roamgate_base::local_socket`]'s transport: a Unix socket at a file
//! path, `AF_UNIX` on Windows too.

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Duration;

use roamgate_base::local_socket::connect_blocking;

/// What the agent socket answered.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    /// The body as Python decodes it (`decode("utf-8", "replace")`).
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Why no answer came, worded as Python's `str(error)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreachable(pub String);

impl std::fmt::Display for Unreachable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<io::Error> for Unreachable {
    fn from(error: io::Error) -> Self {
        Unreachable(crate::py::os_error_text(&error))
    }
}

/// The request's bytes: `http.client`'s request line and headers.
pub fn request_bytes(command: &str, body: &str) -> Vec<u8> {
    let mut out = format!(
        "POST /v1/{command} HTTP/1.1\r\nHost: roamgate\r\nAccept-Encoding: identity\r\n\
         Content-Length: {}\r\ncontent-type: application/json\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Sends `body` (JSON text) to `command` and reads the whole answer, each
/// read and write within `timeout`.
pub fn post(
    socket: &Path,
    command: &str,
    body: &str,
    timeout: Duration,
) -> Result<Response, Unreachable> {
    let mut stream = loop {
        match connect_blocking(socket, timeout) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            other => break other?,
        }
    };
    // write_all and read_to_end retry what a signal interrupts too.
    stream.write_all(&request_bytes(command, body))?;
    stream.flush()?;
    read_response(&mut stream)
}

/// A read retried when a signal interrupts it, as Python's socket reads
/// are (PEP 475): a socket with a receive timeout fails with EINTR when
/// its process was stopped (a shell job's Ctrl+Z, SIGSTOP) and continued.
fn read_some(stream: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        match stream.read(buf) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// Reads one response: its status line, headers, and the body its
/// `Content-Length` says (chunked, or up to the end without either).
pub fn read_response(stream: &mut impl Read) -> Result<Response, Unreachable> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 65536];
    let (status, head_len, length, chunked) = loop {
        let read = read_some(stream, &mut chunk)?;
        if read == 0 {
            return Err(Unreachable(if buffer.is_empty() {
                "Remote end closed connection without response".into()
            } else {
                "incomplete response".into()
            }));
        }
        buffer.extend_from_slice(&chunk[..read]);
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut response = httparse::Response::new(&mut headers);
        match response.parse(&buffer) {
            Ok(httparse::Status::Complete(head_len)) => {
                let mut length = None;
                let mut chunked = false;
                for header in response.headers.iter() {
                    let value = String::from_utf8_lossy(header.value);
                    if header.name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse::<usize>().ok();
                    } else if header.name.eq_ignore_ascii_case("transfer-encoding")
                        && value.to_ascii_lowercase().contains("chunked")
                    {
                        chunked = true;
                    }
                }
                break (response.code.unwrap_or(0), head_len, length, chunked);
            }
            Ok(httparse::Status::Partial) => continue,
            Err(error) => return Err(Unreachable(format!("bad response: {error}"))),
        }
    };
    let mut body = buffer.split_off(head_len);
    if chunked {
        return Ok(Response {
            status,
            body: read_chunked(stream, body)?,
        });
    }
    match length {
        Some(length) => {
            while body.len() < length {
                let read = read_some(stream, &mut chunk)?;
                if read == 0 {
                    return Err(Unreachable("incomplete response".into()));
                }
                body.extend_from_slice(&chunk[..read]);
            }
            body.truncate(length);
        }
        None => {
            stream.read_to_end(&mut body)?;
        }
    }
    Ok(Response { status, body })
}

fn read_chunked(stream: &mut impl Read, mut pending: Vec<u8>) -> Result<Vec<u8>, Unreachable> {
    let mut body = Vec::new();
    let mut chunk = [0u8; 65536];
    let mut fill = |pending: &mut Vec<u8>| -> Result<(), Unreachable> {
        let read = read_some(stream, &mut chunk)?;
        if read == 0 {
            return Err(Unreachable("incomplete response".into()));
        }
        pending.extend_from_slice(&chunk[..read]);
        Ok(())
    };
    loop {
        let line_end = loop {
            if let Some(at) = pending.windows(2).position(|pair| pair == b"\r\n") {
                break at;
            }
            fill(&mut pending)?;
        };
        let size_text = String::from_utf8_lossy(&pending[..line_end]).into_owned();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| Unreachable("bad chunk size".into()))?;
        pending.drain(..line_end + 2);
        if size == 0 {
            return Ok(body);
        }
        while pending.len() < size + 2 {
            fill(&mut pending)?;
        }
        body.extend_from_slice(&pending[..size]);
        pending.drain(..size + 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_sized_and_a_chunked_answer() {
        let mut sized: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\n{}\r\nextra";
        let response = read_response(&mut sized).unwrap();
        assert_eq!(
            (response.status, response.text()),
            (200, "{}\r\n".to_owned())
        );
        let mut chunked: &[u8] =
            b"HTTP/1.1 404 Not Found\r\ntransfer-encoding: chunked\r\n\r\n3\r\nab\n\r\n2\r\nc}\r\n0\r\n\r\n";
        let response = read_response(&mut chunked).unwrap();
        assert_eq!(
            (response.status, response.text()),
            (404, "ab\nc}".to_owned())
        );
        let mut closed: &[u8] = b"";
        assert_eq!(
            read_response(&mut closed).unwrap_err().0,
            "Remote end closed connection without response"
        );
    }

    /// A read a signal interrupts (a stopped and continued process) is
    /// made again, not taken for an unreachable Roamgate.
    #[test]
    fn reads_again_when_a_signal_interrupts() {
        struct Interrupted<'a>(bool, &'a [u8]);
        impl Read for Interrupted<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    return Err(io::Error::from(io::ErrorKind::Interrupted));
                }
                self.1.read(buf)
            }
        }
        let mut stream = Interrupted(false, b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
        assert_eq!(read_response(&mut stream).unwrap().text(), "{}");
    }

    #[test]
    fn sends_http_client_s_request() {
        assert_eq!(
            String::from_utf8(request_bytes("list", "{}")).unwrap(),
            "POST /v1/list HTTP/1.1\r\nHost: roamgate\r\nAccept-Encoding: identity\r\n\
             Content-Length: 2\r\ncontent-type: application/json\r\n\r\n{}"
        );
    }
}
