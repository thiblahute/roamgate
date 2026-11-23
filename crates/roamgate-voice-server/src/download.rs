//! Downloads a model file into place (server/src/voice/voice-download.ts):
//! into `<path>.part` first, resumed with a Range request where an earlier
//! download stopped, its SHA-256 checked before it is renamed to `path`. A
//! file already at `path` with the right size is kept.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, watch};

use crate::helper::BoxFuture;

#[derive(Debug, Clone, PartialEq)]
pub struct DownloadTarget {
    pub url: String,
    pub path: PathBuf,
    pub size: f64,
    pub sha256: String,
}

/// An answer: its status and its body, chunk by chunk.
pub struct FetchResponse {
    pub status: u16,
    pub body: mpsc::Receiver<Result<Vec<u8>, String>>,
}

/// `fetch(url, {headers: {Range}})`, redirects followed.
pub type Fetch =
    Arc<dyn Fn(String, Option<String>) -> BoxFuture<Result<FetchResponse, String>> + Send + Sync>;

/// The real one, over reqwest (rustls).
pub fn http_fetch() -> Fetch {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(20))
        .build()
        .expect("http client");
    Arc::new(move |url, range| {
        let client = client.clone();
        Box::pin(async move {
            let mut request = client.get(&url);
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            let mut response = request.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let (sender, body) = mpsc::channel(8);
            tokio::spawn(async move {
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            if sender.send(Ok(chunk.to_vec())).await.is_err() {
                                return;
                            }
                        }
                        Ok(None) => return,
                        Err(error) => {
                            let _ = sender.send(Err(error.to_string())).await;
                            return;
                        }
                    }
                }
            });
            Ok(FetchResponse { status, body })
        })
    })
}

/// Stops a download (the .part kept): true once aborted.
pub type Abort = watch::Receiver<bool>;

/// Told the bytes done so far.
pub type Progress = Arc<dyn Fn(f64) + Send + Sync>;

#[derive(Clone, Default)]
pub struct DownloadOptions {
    pub fetch: Option<Fetch>,
    pub signal: Option<Abort>,
    pub on_progress: Option<Progress>,
    pub verify: bool,
    pub attempts: Option<u32>,
    pub retry_delay_ms: Option<u64>,
}

/// What failed.
#[derive(Debug, Clone, PartialEq)]
pub enum DownloadError {
    /// The file is not what the catalog says (no retry).
    Checksum(String),
    /// Stopped on purpose.
    Aborted,
    Other(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Checksum(message) | Self::Other(message) => formatter.write_str(message),
            Self::Aborted => formatter.write_str("cancelled"),
        }
    }
}

pub fn part_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.part", path.display()))
}

fn size_of(path: &Path) -> Option<f64> {
    std::fs::metadata(path)
        .ok()
        .map(|metadata| metadata.len() as f64)
}

fn aborted(signal: &Option<Abort>) -> bool {
    signal.as_ref().is_some_and(|signal| *signal.borrow())
}

async fn hash_file(
    path: &Path,
    hash: &mut Sha256,
    signal: &Option<Abort>,
) -> Result<(), DownloadError> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| DownloadError::Other(error.to_string()))?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if aborted(signal) {
            return Err(DownloadError::Aborted);
        }
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| DownloadError::Other(error.to_string()))?;
        if read == 0 {
            return Ok(());
        }
        hash.update(&buffer[..read]);
    }
}

/// Whether `path` holds the file, by size, or by checksum with `verify`.
pub async fn in_place(
    target: &DownloadTarget,
    verify: bool,
    signal: &Option<Abort>,
) -> Result<bool, DownloadError> {
    if size_of(&target.path) != Some(target.size) {
        return Ok(false);
    }
    if !verify {
        return Ok(true);
    }
    let mut hash = Sha256::new();
    hash_file(&target.path, &mut hash, signal).await?;
    Ok(hex::encode(hash.finalize()) == target.sha256)
}

enum Attempt {
    /// The server refused the range: the .part was dropped, try again at once.
    RetryNow(String),
    Failed(DownloadError),
}

impl From<DownloadError> for Attempt {
    fn from(error: DownloadError) -> Self {
        Self::Failed(error)
    }
}

fn number_text(value: f64) -> String {
    crate::js::number_text(value)
}

async fn attempt(target: &DownloadTarget, options: &DownloadOptions) -> Result<(), Attempt> {
    let part = part_path(&target.path);
    let mut have = size_of(&part).unwrap_or(0.0);
    if have > target.size {
        let _ = tokio::fs::remove_file(&part).await;
        have = 0.0;
    }
    let mut hash = Sha256::new();
    if have > 0.0 {
        hash_file(&part, &mut hash, &options.signal).await?;
    }
    let progress = |done: f64| {
        if let Some(on_progress) = &options.on_progress {
            on_progress(done);
        }
    };
    progress(have);
    if have < target.size {
        let fetch = options.fetch.clone().unwrap_or_else(http_fetch);
        let range = (have > 0.0).then(|| format!("bytes={}-", number_text(have)));
        let request = fetch(target.url.clone(), range);
        let mut response = match &options.signal {
            Some(signal) => {
                let mut signal = signal.clone();
                tokio::select! {
                    response = request => response,
                    _ = signal.wait_for(|done| *done) => return Err(DownloadError::Aborted.into()),
                }
            }
            None => request.await,
        }
        .map_err(|error| Attempt::Failed(DownloadError::Other(error)))?;
        if response.status == 416 {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Attempt::RetryNow("the download's range was refused".into()));
        }
        if !(200..300).contains(&response.status) {
            return Err(
                DownloadError::Other(format!("{}: HTTP {}", target.url, response.status)).into(),
            );
        }
        if have > 0.0 && response.status != 206 {
            have = 0.0;
            hash = Sha256::new();
            progress(0.0);
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(have > 0.0)
            .truncate(have == 0.0)
            .open(&part)
            .await
            .map_err(|error| DownloadError::Other(error.to_string()))?;
        loop {
            let chunk = match &options.signal {
                Some(signal) => {
                    let mut signal = signal.clone();
                    let stopped = async move {
                        // The guard wait_for gives is not Send: dropped here.
                        // A stop dropped unused never stops it.
                        if signal.wait_for(|done| *done).await.is_err() {
                            std::future::pending::<()>().await;
                        }
                    };
                    tokio::select! {
                        chunk = response.body.recv() => chunk,
                        _ = stopped => {
                            let _ = file.flush().await;
                            return Err(DownloadError::Aborted.into());
                        }
                    }
                }
                None => response.body.recv().await,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(DownloadError::Other)?;
            if have + chunk.len() as f64 > target.size {
                let _ = file.flush().await;
                return Err(DownloadError::Checksum(format!(
                    "{} is larger than the {} bytes expected",
                    target.url,
                    number_text(target.size)
                ))
                .into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| DownloadError::Other(error.to_string()))?;
            hash.update(&chunk);
            have += chunk.len() as f64;
            progress(have);
        }
        file.flush()
            .await
            .map_err(|error| DownloadError::Other(error.to_string()))?;
    }
    if have != target.size {
        return Err(DownloadError::Other(format!(
            "{} stopped at {} of {} bytes",
            target.url,
            number_text(have),
            number_text(target.size)
        ))
        .into());
    }
    let digest = hex::encode(hash.finalize());
    if digest != target.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DownloadError::Checksum(format!(
            "{}: checksum {digest} is not the expected {}",
            target.url, target.sha256
        ))
        .into());
    }
    tokio::fs::rename(&part, &target.path)
        .await
        .map_err(|error| DownloadError::Other(error.to_string()).into())
}

/// "downloaded" or "present".
pub async fn download_file(
    target: &DownloadTarget,
    options: &DownloadOptions,
) -> Result<&'static str, DownloadError> {
    if in_place(target, options.verify, &options.signal).await? {
        if let Some(on_progress) = &options.on_progress {
            on_progress(target.size);
        }
        return Ok("present");
    }
    if let Some(dir) = target.path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| DownloadError::Other(error.to_string()))?;
    }
    if target.path.exists() {
        let _ = tokio::fs::remove_file(&target.path).await;
    }
    let attempts = options.attempts.unwrap_or(4);
    let mut last_error = DownloadError::Other("no attempt".into());
    for tried in 0..attempts {
        if aborted(&options.signal) {
            return Err(DownloadError::Aborted);
        }
        match attempt(target, options).await {
            Ok(()) => return Ok("downloaded"),
            Err(Attempt::Failed(DownloadError::Checksum(message))) => {
                let _ = tokio::fs::remove_file(part_path(&target.path)).await;
                return Err(DownloadError::Checksum(message));
            }
            Err(failure) => {
                if aborted(&options.signal) {
                    return Err(DownloadError::Aborted);
                }
                let retry_now = matches!(failure, Attempt::RetryNow(_));
                last_error = match failure {
                    Attempt::RetryNow(message) => DownloadError::Other(message),
                    Attempt::Failed(error) => error,
                };
                if !retry_now && tried + 1 < attempts {
                    let wait = Duration::from_millis(
                        options.retry_delay_ms.unwrap_or(2000) * u64::from(tried + 1),
                    );
                    match &options.signal {
                        Some(signal) => {
                            let mut signal = signal.clone();
                            tokio::select! {
                                () = tokio::time::sleep(wait) => {}
                                _ = signal.wait_for(|done| *done) => return Err(DownloadError::Aborted),
                            }
                        }
                        None => tokio::time::sleep(wait).await,
                    }
                }
            }
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests;
