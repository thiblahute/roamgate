//! The page and resource reads of the HTML preview
//! (workspace/html-preview-files.ts): bounded, inside the checkout, links
//! resolved first; over SSH through `html-preview-files.sh`.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use roamgate_base::assets::{HTML_PREVIEW_FILES_SH, fill_template};
use roamgate_git::{GitContext, Invocation, shell_quote};

/// file-constants.ts `PREVIEW_TIMEOUT_MS`.
pub const PREVIEW_TIMEOUT: Duration = Duration::from_millis(10_000);

/// A preview's failure with its HTTP status (400 unless said).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HtmlPreviewError {
    pub message: String,
    pub status: u16,
}

impl HtmlPreviewError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::with_status(message, 400)
    }

    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }
}

/// A file read for the preview: its path in the checkout and its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewResource {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// file-paths.ts `assertInsideRoot`.
pub fn assert_inside_root(root_real: &Path, target_real: &Path) -> Result<(), String> {
    match target_real.strip_prefix(root_real) {
        Ok(_) => Ok(()),
        Err(_) => Err("file explorer path escaped the workspace checkout".into()),
    }
}

/// file-paths.ts `relativePreviewPath`: `/`-separated.
pub fn relative_preview_path(root_real: &Path, target_real: &Path) -> String {
    target_real
        .strip_prefix(root_real)
        .unwrap_or(target_real)
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
type AfterStat = std::cell::RefCell<Option<Box<dyn Fn(&Path)>>>;

#[cfg(test)]
thread_local! {
    /// Runs after the local read's stat, before its read (a test grows
    /// the file there).
    pub(crate) static AFTER_STAT: AfterStat =
        const { std::cell::RefCell::new(None) };
}

fn too_large() -> HtmlPreviewError {
    HtmlPreviewError::with_status("Preview file is too large", 413)
}

/// Reads `path` of the checkout at `root_path` up to `limit` bytes: one
/// byte more is read to see growth after the stat without reading all.
pub async fn read_html_preview_file(
    cx: &GitContext,
    root_path: &str,
    path: &str,
    limit: usize,
) -> Result<PreviewResource, HtmlPreviewError> {
    match cx.host() {
        Some(host) => read_remote(cx, host, root_path, path, limit).await,
        None => read_local(root_path, path, limit),
    }
}

async fn read_remote(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    path: &str,
    limit: usize,
) -> Result<PreviewResource, HtmlPreviewError> {
    let command = fill_template(
        HTML_PREVIEW_FILES_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("path", shell_quote(path).into()),
            ("limit", (limit as i64).into()),
            ("limit_after", (limit as i64 + 1).into()),
        ],
    )
    .expect("html-preview-files.sh");
    let unable = || HtmlPreviewError::new("Unable to read HTML preview file");
    let ran = cx
        .run(
            Invocation::ssh_read(host, &format!("bash -lc {}", shell_quote(&command)), None),
            PREVIEW_TIMEOUT,
        )
        .await
        .map_err(|_| unable())?;
    if ran.code == 15 {
        return Err(too_large());
    }
    if ran.code != 0 {
        return Err(unable());
    }
    let invalid = || HtmlPreviewError::new("Invalid HTML preview response");
    let (name, body) = ran.stdout.split_once('\n').ok_or_else(invalid)?;
    let bytes = decode_base64(body).ok_or_else(invalid)?;
    if bytes.len() > limit {
        return Err(too_large());
    }
    Ok(PreviewResource {
        path: String::from_utf8_lossy(&decode_base64(name).ok_or_else(invalid)?).into_owned(),
        bytes,
    })
}

/// Node's lenient `Buffer.from(text, "base64")` for what the script
/// prints: whitespace dropped, padding optional.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let clean: String = text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean.trim_end_matches('='))
        .ok()
}

fn read_local(
    root_path: &str,
    path: &str,
    limit: usize,
) -> Result<PreviewResource, HtmlPreviewError> {
    use std::io::Read as _;
    let io = |error: std::io::Error| HtmlPreviewError::new(error.to_string());
    let root_real = std::fs::canonicalize(root_path).map_err(io)?;
    let requested = Path::new(path);
    let target: PathBuf = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root_real.join(requested)
    };
    let target_real = std::fs::canonicalize(&target).map_err(io)?;
    assert_inside_root(&root_real, &target_real).map_err(HtmlPreviewError::new)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(&target_real).map_err(io)?;
    let info = file.metadata().map_err(io)?;
    if !info.is_file() {
        return Err(HtmlPreviewError::new(
            "HTML preview requires a regular file",
        ));
    }
    if info.len() > limit as u64 {
        return Err(too_large());
    }
    #[cfg(test)]
    AFTER_STAT.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook(&target_real);
        }
    });
    let mut bytes = Vec::with_capacity(info.len() as usize + 1);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(too_large());
    }
    Ok(PreviewResource {
        path: relative_preview_path(&root_real, &target_real),
        bytes,
    })
}

/// [`crate::html_preview::render_html_preview`] of a checkout's page, its
/// resources read with [`read_html_preview_file`], on a blocking thread.
pub async fn render_html_preview_file(
    cx: &GitContext,
    root_path: &str,
    path: &str,
) -> Result<String, HtmlPreviewError> {
    let document = read_html_preview_file(
        cx,
        root_path,
        path,
        roamgate_git::preview::PREVIEW_MAX_BYTES,
    )
    .await?;
    let cx = cx.clone();
    let root = root_path.to_owned();
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut read = |path: &str, limit: usize| {
            handle.block_on(read_html_preview_file(&cx, &root, path, limit))
        };
        crate::html_preview::render_html_preview(&document, &mut read)
    })
    .await
    .map_err(|error| HtmlPreviewError::with_status(error.to_string(), 500))?
}
