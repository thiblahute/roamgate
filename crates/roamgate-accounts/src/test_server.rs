//! A fake OAuth server for the tests: answers each request with the next
//! of its canned `(status, body)` answers and records what it was sent.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub path: String,
    pub content_type: String,
    pub body: String,
}

pub(crate) struct FakeServer {
    base: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

fn header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

impl FakeServer {
    pub(crate) async fn start(answers: Vec<(u16, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        tokio::spawn(async move {
            let mut answers = answers.into_iter();
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 4096];
                let end = loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break None;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                    if let Some(end) = header_end(&bytes) {
                        break Some(end);
                    }
                };
                let Some(end) = end else { continue };
                let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
                let header = |name: &str| {
                    head.lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name)
                                .then(|| value.trim().to_owned())
                        })
                        .unwrap_or_default()
                };
                let length: usize = header("content-length").parse().unwrap_or(0);
                while bytes.len() < end + 4 + length {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
                let path = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_owned();
                recorded.lock().await.push(Request {
                    path,
                    content_type: header("content-type"),
                    body: String::from_utf8_lossy(&bytes[end + 4..]).into_owned(),
                });
                let (status, body) = answers.next().unwrap_or((500, "{}".into()));
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        Self { base, requests }
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub(crate) async fn requests(&self) -> Vec<Request> {
        self.requests.lock().await.clone()
    }
}
