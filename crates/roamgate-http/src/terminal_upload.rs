//! Files dropped or pasted into a terminal (http/terminal-upload.ts and
//! http/image-upload.ts): streamed into a private staging folder, then,
//! on an SSH connection, copied to the host's own private staging folder
//! by the contract's upload script; the answer is the path as typed into
//! that host's terminal.
//!
//! The local root is `<tmp>/roamgate-uploads-<uid>`, 0700 and owned by the
//! user, never a link; each upload gets its own `upload-XXXXXX` folder,
//! swept after the retention (24 hours by default). A failed or abandoned
//! upload leaves nothing: the folder is removed when the handler ends or
//! is dropped (the browser went away, the SSH copy timed out).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use roamgate_base::assets::{TemplateValue, UPLOAD_CLEANUP_SH, UPLOAD_WRITE_SH, fill_template};
use roamgate_base::clock::{BoxFuture, SharedClock};
use roamgate_exec::quote::{PathStyle, shell_quote, terminal_path_text};
use serde_json::json;

use crate::response::{self, Response};

pub const DEFAULT_MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const DEFAULT_RETENTION_HOURS: u64 = 24;
pub const TERMINAL_UPLOAD_TIMEOUT_MS: u64 = 300_000;
pub const CLEANUP_TIMEOUT_MS: u64 = 30_000;
pub const IMAGE_MAX_BYTES: u64 = 25 * 1024 * 1024;

fn positive_integer(value: Option<&str>, fallback: u64) -> u64 {
    // `Number(value)`: a safe integer above zero, else the default.
    let Some(text) = value.map(str::trim) else {
        return fallback;
    };
    match text.parse::<f64>() {
        Ok(number)
            if number.fract() == 0.0 && number > 0.0 && number <= 9_007_199_254_740_991.0 =>
        {
            number as u64
        }
        _ => fallback,
    }
}

/// `ROAMGATE_UPLOAD_MAX_BYTES`, else 100 MiB.
pub fn terminal_upload_max_bytes(env: &dyn roamgate_base::env::Env) -> u64 {
    positive_integer(
        roamgate_base::env::roamgate_env(env, "UPLOAD_MAX_BYTES").as_deref(),
        DEFAULT_MAX_BYTES,
    )
}

/// The listener's body limit: the upload cap, at least 128 MiB.
pub fn terminal_upload_request_body_limit(env: &dyn roamgate_base::env::Env) -> u64 {
    (128 * 1024 * 1024).max(terminal_upload_max_bytes(env))
}

/// `ROAMGATE_UPLOAD_RETENTION_HOURS`, else 24.
pub fn terminal_upload_retention_hours(env: &dyn roamgate_base::env::Env) -> u64 {
    positive_integer(
        roamgate_base::env::roamgate_env(env, "UPLOAD_RETENTION_HOURS").as_deref(),
        DEFAULT_RETENTION_HOURS,
    )
}

/// A name safe on the host: its last path part, `[A-Za-z0-9._+-]` only, an
/// extension of 24 characters at most and 120 in all, and on Windows no
/// trailing dots nor reserved device names.
pub fn sanitize_terminal_upload_name(input: &str, windows: bool) -> String {
    let basename = input.rsplit(['\\', '/']).next().unwrap_or("");
    // The TS replaces each UTF-16 unit; a character outside the BMP is two.
    let safe: String = basename
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-');
            let count = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, count)
        })
        .collect();
    let dot = safe.rfind('.').filter(|dot| *dot > 0);
    let extension: String = dot
        .map(|dot| safe[dot..].chars().take(24).collect())
        .unwrap_or_default();
    let stem_all = match dot {
        Some(dot) => &safe[..dot],
        None => safe.as_str(),
    };
    let stem: String = stem_all
        .chars()
        .take(120usize.saturating_sub(extension.len()))
        .collect();
    let name = if !stem.is_empty() && stem != "." && stem != ".." {
        format!("{stem}{extension}")
    } else {
        format!("file{extension}")
    };
    if !windows {
        return name;
    }
    let trimmed = name.trim_end_matches('.');
    let windows_name = if trimmed.is_empty() {
        "file".to_owned()
    } else {
        trimmed.to_owned()
    };
    let head = windows_name
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    let reserved = matches!(head.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((head.starts_with("COM") || head.starts_with("LPT"))
            && head.len() == 4
            && head.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("_{windows_name}")
    } else {
        windows_name
    }
}

/// The host's sweep of its expired uploads (contract/assets/sh/upload-cleanup.sh).
pub fn remote_terminal_cleanup_script(retention_minutes: u64) -> String {
    fill_template(
        UPLOAD_CLEANUP_SH,
        &[(
            "retention_minutes",
            TemplateValue::Number(retention_minutes as f64),
        )],
    )
    .expect("the cleanup script's tags are filled")
}

/// The host's side of an upload: the sweep, then the file from stdin into
/// a private folder; prints its path.
pub fn remote_terminal_upload_script(name: &str, retention_minutes: u64) -> String {
    fill_template(
        UPLOAD_WRITE_SH,
        &[
            (
                "cleanup",
                TemplateValue::Text(remote_terminal_cleanup_script(retention_minutes)),
            ),
            ("name", TemplateValue::Text(shell_quote(name))),
        ],
    )
    .expect("the upload script's tags are filled")
}

/// What an SSH run of a script gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The connection's SSH side: its host, and a run of `sh -c <script>`
/// there, through the session slots, killed (SIGKILL) when the future is
/// dropped or the time is up.
pub trait UploadRemote: Send + Sync + 'static {
    /// The SSH destination when the active connection is remote.
    fn host(&self) -> Option<String>;
    /// `sh -c <script>` on `host`, with `stdin` (a local file) piped in.
    fn run(
        &self,
        host: String,
        script: String,
        stdin: Option<PathBuf>,
        timeout: Duration,
        purpose: &'static str,
    ) -> BoxFuture<Result<RemoteOutput, String>>;
}

/// No SSH: every connection is local.
pub struct LocalOnly;

impl UploadRemote for LocalOnly {
    fn host(&self) -> Option<String> {
        None
    }
    fn run(
        &self,
        _host: String,
        _script: String,
        _stdin: Option<PathBuf>,
        _timeout: Duration,
        _purpose: &'static str,
    ) -> BoxFuture<Result<RemoteOutput, String>> {
        Box::pin(async { Err("no SSH connection".to_owned()) })
    }
}

#[derive(Clone)]
pub struct UploadConfig {
    /// The temporary directory the root goes in (`os.tmpdir()`).
    pub temp_root: PathBuf,
    /// The local platform's path conventions.
    pub windows: bool,
    pub max_bytes: u64,
    pub retention_hours: u64,
    pub reject_empty: bool,
    pub upload_timeout: Duration,
}

impl UploadConfig {
    pub fn new(temp_root: PathBuf) -> Self {
        Self {
            temp_root,
            windows: cfg!(windows),
            max_bytes: DEFAULT_MAX_BYTES,
            retention_hours: DEFAULT_RETENTION_HOURS,
            reject_empty: false,
            upload_timeout: Duration::from_millis(TERMINAL_UPLOAD_TIMEOUT_MS),
        }
    }
}

/// Removes a staging folder unless it is kept: on every early return, an
/// error, and when the handler's future is dropped.
struct Staging(Option<PathBuf>);

impl Staging {
    fn keep(&mut self) {
        self.0 = None;
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

fn user_suffix() -> String {
    #[cfg(unix)]
    {
        rustix::process::getuid().as_raw().to_string()
    }
    #[cfg(not(unix))]
    {
        "user".to_owned()
    }
}

/// The upload handler of one server (`createTerminalUploadHandler`).
pub struct TerminalUploads {
    config: UploadConfig,
    remote: Arc<dyn UploadRemote>,
    clock: SharedClock,
    root: PathBuf,
    sweeping: tokio::sync::Mutex<()>,
}

fn error_json(status: u16, message: &str) -> Response {
    response::json(status, &[], &json!({"error": message}))
}

impl TerminalUploads {
    pub fn new(config: UploadConfig, remote: Arc<dyn UploadRemote>, clock: SharedClock) -> Self {
        let root = config
            .temp_root
            .join(format!("roamgate-uploads-{}", user_suffix()));
        Self {
            config,
            remote,
            clock,
            root,
            sweeping: tokio::sync::Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn retention_ms(&self) -> i64 {
        (self.config.retention_hours * 60 * 60 * 1000) as i64
    }

    /// The private root, made if missing and checked; expired upload
    /// folders in it are removed.
    fn private_root(&self) -> std::io::Result<PathBuf> {
        let unsafe_root = || std::io::Error::other("unsafe terminal upload directory");
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&self.root)?;
        let info = std::fs::symlink_metadata(&self.root)?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err(unsafe_root());
        }
        #[cfg(unix)]
        if !self.config.windows {
            use std::os::unix::fs::MetadataExt;
            if info.uid() != rustix::process::getuid().as_raw() || info.mode() & 0o077 != 0 {
                return Err(unsafe_root());
            }
        }
        let now = self.clock.now();
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("upload-") || !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            let info = match std::fs::symlink_metadata(&path) {
                Ok(info) => info,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let modified = info
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_millis() as i64);
            if now - modified > self.retention_ms() {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
        Ok(self.root.clone())
    }

    /// The sweep, here and on the SSH host: one at a time.
    pub async fn sweep_expired(&self) -> Result<(), String> {
        let _one = self.sweeping.lock().await;
        self.private_root().map_err(|error| error.to_string())?;
        let Some(host) = self.remote.host() else {
            return Ok(());
        };
        let script = remote_terminal_cleanup_script(self.config.retention_hours * 60);
        let output = self
            .remote
            .run(
                host,
                script,
                None,
                Duration::from_millis(CLEANUP_TIMEOUT_MS),
                "upload.cleanup",
            )
            .await?;
        if output.code != 0 {
            let detail = output.stderr.trim();
            return Err(format!(
                "ssh upload cleanup failed: {}",
                if detail.is_empty() {
                    format!("exit {}", output.code)
                } else {
                    detail.to_owned()
                }
            ));
        }
        Ok(())
    }

    /// The sweep now and then every hour (or the retention when shorter),
    /// until the task is aborted.
    pub fn start_cleanup(
        self: &Arc<Self>,
        on_error: impl Fn(String) + Send + Sync + 'static,
    ) -> tokio::task::JoinHandle<()> {
        let uploads = self.clone();
        tokio::spawn(async move {
            if let Err(error) = uploads.sweep_expired().await {
                on_error(error);
            }
            let period = Duration::from_millis(uploads.retention_ms().min(60 * 60 * 1000) as u64);
            let mut interval = uploads.clock.interval(period);
            loop {
                interval.tick().await;
                if let Err(error) = uploads.sweep_expired().await {
                    on_error(error);
                }
            }
        })
    }

    /// `POST /api/terminal-upload?filename=`: `body` is `None` without one.
    pub async fn handle<S, E>(&self, body: Option<S>, filename: Option<&str>) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: std::fmt::Display,
    {
        let Some(filename) = filename.filter(|name| !name.is_empty()) else {
            return error_json(400, "filename is required");
        };
        let Some(body) = body else {
            return error_json(400, "empty body");
        };
        let name = sanitize_terminal_upload_name(filename, self.config.windows);
        self.stage(body, &name).await
    }

    async fn stage<S, E>(&self, mut body: S, name: &str) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: std::fmt::Display,
    {
        let mut staging = Staging(None);
        let root = match self.private_root() {
            Ok(root) => root,
            Err(error) => return error_json(500, &error.to_string()),
        };
        // As `mkdtemp`: 0700 whatever the umask.
        let mut builder = tempfile::Builder::new();
        builder.prefix("upload-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = match builder.tempdir_in(&root) {
            Ok(directory) => directory.keep(),
            Err(error) => return error_json(500, &error.to_string()),
        };
        staging.0 = Some(directory.clone());
        let local_path = directory.join(name);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = match options.open(&local_path) {
            Ok(file) => file,
            Err(error) => return error_json(500, &error.to_string()),
        };
        let mut size: u64 = 0;
        while let Some(chunk) = body.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => return error_json(500, &error.to_string()),
            };
            size += chunk.len() as u64;
            if size > self.config.max_bytes {
                return error_json(
                    413,
                    &format!("file too large (>{} bytes)", self.config.max_bytes),
                );
            }
            if let Err(error) = file.write_all(&chunk) {
                return error_json(500, &error.to_string());
            }
        }
        drop(file);
        if size == 0 && self.config.reject_empty {
            return error_json(400, "empty body");
        }
        if let Some(host) = self.remote.host() {
            let script = remote_terminal_upload_script(name, self.config.retention_hours * 60);
            let output = self
                .remote
                .run(
                    host,
                    script,
                    Some(local_path),
                    self.config.upload_timeout,
                    "upload",
                )
                .await;
            let output = match output {
                Ok(output) => output,
                Err(error) => {
                    return error_json(502, &format!("ssh upload failed: {error}"));
                }
            };
            if output.code != 0 || !output.stdout.starts_with('/') {
                let detail = output.stderr.trim();
                return error_json(
                    502,
                    &format!(
                        "ssh upload failed: {}",
                        if detail.is_empty() {
                            format!("exit {}", output.code)
                        } else {
                            detail.to_owned()
                        }
                    ),
                );
            }
            let path = output.stdout;
            let text = terminal_path_text(&path, PathStyle::Posix);
            return response::json(
                200,
                &[],
                &json!({"path": path, "text": text, "remote": true}),
            );
        }
        // The local staging directory remains until retention cleanup.
        staging.keep();
        let path = local_path.to_string_lossy().into_owned();
        let style = if self.config.windows {
            PathStyle::Windows
        } else {
            PathStyle::Posix
        };
        let text = terminal_path_text(&path, style);
        response::json(
            200,
            &[],
            &json!({"path": path, "text": text, "remote": false}),
        )
    }

    /// `POST /api/upload-image` (`X-Image-Ext`): a pasted image, at most
    /// 25 MiB and never empty, named `img-<ms>-<random>.<ext>`. Built on
    /// an upload handler whose config says so ([`image_upload_config`]).
    pub async fn handle_image<S, E>(&self, body: Option<S>, image_ext: Option<&str>) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
        E: std::fmt::Display,
    {
        let ext: String = image_ext
            .filter(|ext| !ext.is_empty())
            .unwrap_or("png")
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .collect();
        let ext = if ext.is_empty() {
            "png".to_owned()
        } else {
            ext
        };
        let random: String = {
            const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
            (0..6)
                .map(|_| DIGITS[rand::random_range(0..36)] as char)
                .collect()
        };
        let name = format!("img-{}-{random}.{ext}", self.clock.now());
        self.handle(body, Some(&name)).await
    }
}

/// The image handler's configuration: 25 MiB, empty bodies refused.
pub fn image_upload_config(temp_root: PathBuf) -> UploadConfig {
    UploadConfig {
        max_bytes: IMAGE_MAX_BYTES,
        reject_empty: true,
        ..UploadConfig::new(temp_root)
    }
}

#[cfg(test)]
mod tests;
