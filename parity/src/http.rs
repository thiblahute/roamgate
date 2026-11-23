//! A raw HTTP/1.1 client: every header as written (no client adding or
//! hiding any), cookies kept by the caller, Range and the rest as plain
//! headers, over TCP or a Unix socket (the agent socket).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone)]
pub enum Target {
    Tcp(String),
    Unix(PathBuf),
}

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    /// Lower-case names, in order, repeated names kept.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn headers_all(&self, name: &str) -> Vec<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
            .collect()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Result<Value> {
        serde_json::from_slice(&self.body).with_context(|| format!("not JSON: {}", self.text()))
    }

    /// Headers as a map (the last value of a repeated name).
    pub fn header_map(&self) -> BTreeMap<String, String> {
        self.headers.iter().cloned().collect()
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn dechunk(mut body: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let end = find(body, b"\r\n").context("chunk size line")?;
        let size_text = std::str::from_utf8(&body[..end])?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)?;
        body = &body[end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size + 2 {
            bail!("truncated chunk");
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    host: &str,
    request: &Request,
) -> Result<Response> {
    let mut head = format!("{} {} HTTP/1.1\r\n", request.method, request.path);
    let has = |name: &str| {
        request
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case(name))
    };
    if !has("host") {
        head.push_str(&format!("host: {host}\r\n"));
    }
    for (name, value) in &request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has("content-length") && (!request.body.is_empty() || request.method != "GET") {
        head.push_str(&format!("content-length: {}\r\n", request.body.len()));
    }
    if !has("connection") {
        head.push_str("connection: close\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&request.body).await?;
    stream.flush().await?;
    // Read the head first: a 101 keeps the connection (a WebSocket
    // upgrade), so its body is never read.
    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    let split = loop {
        if let Some(split) = find(&raw, b"\r\n\r\n") {
            break split;
        }
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            bail!("connection closed before the response head");
        }
        raw.extend_from_slice(&buffer[..read]);
    };
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().context("no status line")?;
    let status: u16 = status_line
        .split(' ')
        .nth(1)
        .context("no status")?
        .parse()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let mut body = raw[split + 4..].to_vec();
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok());
    let chunked = headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.contains("chunked"));
    if status == 101 || request.method == "HEAD" || status == 204 || status == 304 {
        body.clear();
    } else if let Some(length) = length.filter(|_| !chunked) {
        while body.len() < length {
            let read = stream.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&buffer[..read]);
        }
        body.truncate(length);
    } else {
        stream.read_to_end(&mut body).await?;
        if chunked {
            body = dechunk(&body)?;
        }
    }
    Ok(Response {
        status,
        headers,
        body,
    })
}

pub async fn send(target: &Target, request: &Request, timeout: Duration) -> Result<Response> {
    let work = async {
        match target {
            Target::Tcp(address) => {
                let stream = tokio::net::TcpStream::connect(address)
                    .await
                    .with_context(|| format!("connect {address}"))?;
                exchange(stream, address, request).await
            }
            #[cfg(unix)]
            Target::Unix(path) => {
                let stream = tokio::net::UnixStream::connect(path)
                    .await
                    .with_context(|| format!("connect {}", path.display()))?;
                exchange(stream, "localhost", request).await
            }
            #[cfg(not(unix))]
            Target::Unix(_) => bail!("Unix sockets are not available here"),
        }
    };
    tokio::time::timeout(timeout, work)
        .await
        .with_context(|| format!("{} {} timed out", request.method, request.path))?
}

/// The `name=value` of each Set-Cookie, as a browser would send them back.
pub fn cookies_from(response: &Response) -> Vec<(String, String)> {
    response
        .headers_all("set-cookie")
        .into_iter()
        .filter_map(|cookie| cookie.split(';').next())
        .filter_map(|pair| pair.split_once('='))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect()
}
