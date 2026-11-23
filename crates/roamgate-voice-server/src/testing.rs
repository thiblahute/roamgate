//! For the voice setup's tests (server/src/voice/voice-setup-testing.ts):
//! the catalog's packages with a few bytes in place of each model file,
//! served by a local server that answers Range requests, so nothing real
//! is ever downloaded.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::download::{Fetch, FetchResponse, http_fetch};
use crate::hardware::{Cpu, GIB, GpuInfo, VoiceHardware};
use crate::models::{ModelFile, ModelPackage, packages};

pub fn nvidia_desktop() -> VoiceHardware {
    VoiceHardware {
        platform: "linux".into(),
        arch: "x64".into(),
        os_name: Some("Fedora Linux 43".into()),
        cpu: Cpu {
            model: "AMD Ryzen 9 3950X 16-Core Processor".into(),
            cores: 32.0,
        },
        ram_bytes: 64.0 * GIB,
        gpus: vec![GpuInfo {
            vendor: "nvidia".into(),
            name: "NVIDIA GeForce RTX 3060 Ti".into(),
            vram_bytes: Some(8.0 * GIB),
            unified_memory: None,
            driver: None,
            compute_capability: None,
        }],
        acceleration: "cuda".into(),
        gpu_bytes: 8.0 * GIB,
        note: None,
    }
}

pub fn cpu_laptop() -> VoiceHardware {
    VoiceHardware {
        platform: "linux".into(),
        arch: "x64".into(),
        os_name: None,
        cpu: Cpu {
            model: "Intel Core i5".into(),
            cores: 8.0,
        },
        ram_bytes: 16.0 * GIB,
        gpus: Vec::new(),
        acceleration: "cpu".into(),
        gpu_bytes: 0.0,
        note: None,
    }
}

#[derive(Default)]
pub struct ServerState {
    /// Each request's path and Range header.
    pub requests: Vec<(String, Option<String>)>,
    pub bodies: BTreeMap<String, Vec<u8>>,
    pub cut_once: BTreeSet<String>,
    pub ignore_range: bool,
}

pub struct ModelServer {
    pub url: String,
    pub packages: Vec<ModelPackage>,
    pub state: Arc<Mutex<ServerState>>,
}

fn lock(state: &Mutex<ServerState>) -> std::sync::MutexGuard<'_, ServerState> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl ModelServer {
    pub fn requests(&self) -> Vec<(String, Option<String>)> {
        lock(&self.state).requests.clone()
    }

    pub fn clear(&self) {
        let mut state = lock(&self.state);
        state.requests.clear();
        state.ignore_range = false;
    }

    pub fn set_ignore_range(&self, ignore: bool) {
        lock(&self.state).ignore_range = ignore;
    }

    pub fn cut_once(&self, path: &str) {
        lock(&self.state).cut_once.insert(path.to_owned());
    }

    pub fn body(&self, path: &str) -> Vec<u8> {
        lock(&self.state).bodies[path].clone()
    }

    /// A fetch whose answer for the `cut_once` paths stops halfway once.
    pub fn fetch(&self) -> Fetch {
        let real = http_fetch();
        let state = self.state.clone();
        Arc::new(move |url: String, range: Option<String>| {
            let real = real.clone();
            let state = state.clone();
            Box::pin(async move {
                let mut response = real(url.clone(), range).await?;
                let path = url.split_once("://").map_or("", |(_, rest)| rest);
                let path = path.find('/').map_or("/", |at| &path[at..]).to_owned();
                if !lock(&state).cut_once.remove(&path) {
                    return Ok(response);
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.body.recv().await {
                    bytes.extend(chunk?);
                }
                let half = bytes[..(bytes.len() / 2).max(1)].to_vec();
                let (sender, body) = tokio::sync::mpsc::channel(2);
                sender.send(Ok(half)).await.ok();
                sender.send(Err("connection lost".into())).await.ok();
                Ok(FetchResponse {
                    status: response.status,
                    body,
                })
            })
        })
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The catalog's packages, served locally.
pub async fn serve_models() -> ModelServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state: Arc<Mutex<ServerState>> = Arc::default();
    let served = packages()
        .iter()
        .map(|entry| ModelPackage {
            files: entry
                .files
                .iter()
                .map(|file| {
                    let bytes = format!("{}/{}:", entry.id, file.path)
                        .repeat(40)
                        .into_bytes();
                    let path = format!("/{}/{}", entry.id, file.path);
                    let served = ModelFile {
                        path: file.path.clone(),
                        url: format!("{url}{path}"),
                        size: bytes.len() as f64,
                        sha256: sha256(&bytes),
                    };
                    lock(&state).bodies.insert(path, bytes);
                    served
                })
                .collect(),
            ..entry.clone()
        })
        .collect();
    let shared = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let state = shared.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).into_owned();
                let mut lines = head.split("\r\n");
                let path = lines
                    .next()
                    .and_then(|line| line.split(' ').nth(1))
                    .unwrap_or("/")
                    .to_owned();
                let range = lines
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("range"))
                    .map(|(_, value)| value.trim().to_owned());
                let (status, headers, body) = {
                    let mut state = lock(&state);
                    state.requests.push((path.clone(), range.clone()));
                    match state.bodies.get(&path) {
                        None => ("404 Not Found", String::new(), b"not found".to_vec()),
                        Some(body) => {
                            let mut start = 0usize;
                            if let Some(range) = range.as_deref().filter(|_| !state.ignore_range) {
                                start = range
                                    .strip_prefix("bytes=")
                                    .and_then(|rest| rest.strip_suffix('-'))
                                    .and_then(|number| number.parse().ok())
                                    .unwrap_or(0);
                            }
                            if start >= body.len() && start > 0 {
                                ("416 Range Not Satisfiable", String::new(), Vec::new())
                            } else if start > 0 {
                                (
                                    "206 Partial Content",
                                    format!(
                                        "content-range: bytes {start}-{}/{}\r\n",
                                        body.len() - 1,
                                        body.len()
                                    ),
                                    body[start..].to_vec(),
                                )
                            } else {
                                ("200 OK", String::new(), body.clone())
                            }
                        }
                    }
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\n{headers}connection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(&body).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    ModelServer {
        url,
        packages: served,
        state,
    }
}
