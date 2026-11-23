//! Downloading, verifying and installing release files: the one module
//! `roamgate update`, `/api/update/install` and the managed Herdr install
//! share (Rust migration plan, section 6.2).
//!
//! Every download goes through curl restricted to the URL's own scheme for
//! the request and every redirect (`--proto`, `--proto-redir`), the transport
//! the TS updater always used; checksums are SHA-256; files are staged in a
//! directory of the target's own filesystem and published by rename, so a
//! failure never leaves a partial install. Roamgate's own release archive is
//! installed by the contract's shell installer (contract/assets
//! sh/update-install.sh, rendered by roamgate-cli), which runs the same steps
//! with curl, `shasum`, `tar` and `install` over the running executable and
//! keeps the replaced one as `<target>.previous`: [`run_installer`] runs it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::process::{Command, ExecError, Output, ProcessRunner};

/// curl's protocol restriction for a base URL: its own scheme only.
pub fn curl_transport_args(url: &str) -> Vec<String> {
    let protocol = if url.trim_start().to_ascii_lowercase().starts_with("https:") {
        "=https"
    } else {
        "=http"
    };
    vec![
        "--proto".into(),
        protocol.into(),
        "--proto-redir".into(),
        protocol.into(),
    ]
}

/// What a download step answers when it fails: curl's own words, else its
/// exit, trimmed and bounded as the TS messages are.
pub fn failure_text(output: &Output, fallback: &str, limit: usize) -> String {
    let stderr = output.stderr_text();
    let stdout = output.stdout_text();
    let text = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback.to_owned()
    };
    text.trim().chars().take(limit).collect()
}

/// Fetches a small text file (a release manifest) over curl: `-fsSL` with
/// the transport restriction and a size bound. The run's exit code and
/// output, for the caller's own messages.
pub async fn fetch_text(
    runner: &ProcessRunner,
    url: &str,
    transport: &[String],
    max_bytes: usize,
    timeout: Duration,
) -> Result<Output, ExecError> {
    let mut argv: Vec<String> = vec!["curl".into()];
    argv.extend(transport.iter().cloned());
    argv.extend([
        "-fsSL".into(),
        "--max-filesize".into(),
        max_bytes.to_string(),
        url.into(),
    ]);
    runner.run(&Command::new(argv).timeout(timeout)).await
}

/// Downloads `url` to `destination` over curl, following redirects within
/// the URL's scheme, giving up after `timeout`. Errors name the HTTP status
/// or curl's reason.
pub async fn download(
    runner: &ProcessRunner,
    url: &str,
    destination: &Path,
    timeout: Duration,
    what: &str,
) -> Result<(), String> {
    let mut argv: Vec<String> = vec!["curl".into()];
    argv.extend(curl_transport_args(url));
    argv.extend([
        "-sSL".into(),
        "-o".into(),
        destination.display().to_string(),
        "-w".into(),
        "%{http_code}".into(),
        url.into(),
    ]);
    let output = match runner.run(&Command::new(argv).timeout(timeout)).await {
        Ok(output) => output,
        Err(ExecError::TimedOut { .. }) => {
            let _ = std::fs::remove_file(destination);
            return Err(format!("{what} download timed out"));
        }
        Err(error) => return Err(format!("{what} download failed: {error}")),
    };
    let status: u16 = output.stdout_text().trim().parse().unwrap_or(0);
    if output.code != 0 {
        let _ = std::fs::remove_file(destination);
        return Err(if output.code == 28 {
            format!("{what} download timed out")
        } else {
            format!(
                "{what} download failed: {}",
                failure_text(&output, &format!("curl exited {}", output.code), 500)
            )
        });
    }
    if !(200..300).contains(&status) {
        let _ = std::fs::remove_file(destination);
        return Err(format!("{what} download failed: HTTP {status}"));
    }
    Ok(())
}

/// The lowercase hex SHA-256 of a file.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Whether a file's SHA-256 is `expected` (any case).
pub fn verify_sha256(path: &Path, expected: &str) -> std::io::Result<bool> {
    Ok(sha256_file(path)? == expected.to_ascii_lowercase())
}

/// A staging directory inside the install root (so the final renames stay
/// on one filesystem), removed with everything in it when dropped.
pub struct Staging {
    path: PathBuf,
}

impl Staging {
    /// `<root>/.staging-<pid>`, made fresh (the root too).
    pub fn new(root: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(root)?;
        let path = root.join(format!(".staging-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Publishes a staged executable at `target`: mode 0755, then a rename.
pub fn publish_executable(staged: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(staged, target)
}

/// Runs a rendered installer script (`sh -c`), to its end or `timeout`.
pub async fn run_installer(
    runner: &ProcessRunner,
    script: &str,
    timeout: Duration,
) -> Result<Output, ExecError> {
    runner
        .run(&Command::new(["sh", "-c", script]).timeout(timeout))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_curl_to_the_url_s_own_scheme() {
        assert_eq!(
            curl_transport_args("https://example.com/x"),
            ["--proto", "=https", "--proto-redir", "=https"]
        );
        assert_eq!(
            curl_transport_args("http://127.0.0.1:9/x"),
            ["--proto", "=http", "--proto-redir", "=http"]
        );
    }

    #[test]
    fn hashes_stages_and_publishes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("bin");
        let target = root.join("herdr");
        {
            let staging = Staging::new(&root).unwrap();
            let staged = staging.path().join("asset");
            std::fs::write(&staged, b"abc").unwrap();
            assert_eq!(
                sha256_file(&staged).unwrap(),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            );
            assert!(
                verify_sha256(
                    &staged,
                    "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
                )
                .unwrap()
            );
            publish_executable(&staged, &target).unwrap();
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"abc");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        // The staging directory is gone with its guard.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    /// A local server answering each connection with `answer` (None:
    /// accept and never answer).
    async fn serve(answer: Option<&'static [u8]>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/asset",
            listener.local_addr().unwrap().port()
        );
        let task = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((mut stream, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request).await;
                match answer {
                    Some(bytes) => {
                        let _ = stream.write_all(bytes).await;
                    }
                    None => held.push(stream),
                }
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn downloads_names_http_failures_and_gives_up_at_its_deadline() {
        if std::process::Command::new("curl")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let runner = ProcessRunner::system();
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("asset");
        let (url, server) = serve(Some(
            b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello",
        ))
        .await;
        download(
            &runner,
            &url,
            &destination,
            Duration::from_secs(10),
            "Herdr",
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"hello");
        server.abort();
        let (url, server) = serve(Some(
            b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        ))
        .await;
        assert_eq!(
            download(
                &runner,
                &url,
                &destination,
                Duration::from_secs(10),
                "Herdr"
            )
            .await,
            Err("Herdr download failed: HTTP 404".into())
        );
        assert!(!destination.exists());
        server.abort();
        // Stalled headers: the deadline ends it and nothing stays.
        let (url, server) = serve(None).await;
        assert_eq!(
            download(
                &runner,
                &url,
                &destination,
                Duration::from_millis(500),
                "Herdr"
            )
            .await,
            Err("Herdr download timed out".into())
        );
        assert!(!destination.exists());
        server.abort();
    }
}
