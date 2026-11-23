//! Files on a POSIX host over SSH (workspace/remote-files.ts): each
//! operation one script of `contract/assets/sh`, its answer parsed here.
//! The parsers' cases are `contract/vectors/remote-files.json`.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use roamgate_base::assets::{
    DELETE_FILE_SH, DOWNLOAD_FILE_SH, LIST_FILES_SH, MUTATE_FILE_SH, READ_FILE_SH,
    RESOLVE_FILES_SH, STAT_FILE_SH, TemplateValue, UPLOAD_FILE_SH, fill_template,
};
use roamgate_git::preview::{
    AUDIO_INLINE_PREVIEW_MAX_BYTES, Decoded, PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES,
    decode_preview_buffer, preview_limit_for_path,
};
use roamgate_git::{GitContext, Invocation, Ran, shell_quote};
use tokio::sync::mpsc;

use crate::atomic_move::REMOTE_EXCLUSIVE_RENAME;
use crate::connection::WorkspaceError;
use crate::file_download::{FileDownloadError, FileDownloadOptions, file_download_range};
use crate::file_paths::{entry_sort, missing_file_message, relative_explorer_path};
use crate::file_types::{
    FileBody, FileDeleteResult, FileDownloadResult, FileExplorerEntry, FileListResult,
    FilePreviewResult, FileStatResult, FileUploadResult,
};
use crate::local_files::{DOWNLOAD_TIMEOUT, DownloadFailure, LIST_LIMIT};
use crate::process::{StreamProcess, StreamedProcess};

/// file-constants.ts `LIST_TIMEOUT_MS`.
pub const LIST_TIMEOUT: Duration = Duration::from_millis(10_000);
/// file-constants.ts `PREVIEW_TIMEOUT_MS`.
pub const PREVIEW_TIMEOUT: Duration = Duration::from_millis(10_000);
/// file-constants.ts `UPLOAD_TIMEOUT_MS`.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_millis(120_000);
/// file-constants.ts `DELETE_TIMEOUT_MS`.
pub const DELETE_TIMEOUT: Duration = Duration::from_millis(120_000);
/// file.read's exit when the file asked for is not there.
const MISSING_FILE_EXIT: i32 = 15;

const IMAGE_EXTENSIONS: [&str; 12] = [
    "svg", "apng", "png", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "bmp", "ico", "avif",
];
const AUDIO_EXTENSIONS: [&str; 9] = [
    "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba",
];

/// Node's `Buffer.from(text, "base64")`: whitespace and stray characters
/// skipped, URL-safe letters taken, padding optional, a partial last
/// group decoded as far as it goes.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut sextets = Vec::with_capacity(text.len());
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        sextets.push(value);
    }
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    for group in sextets.chunks(4) {
        let n = group
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, v)| n | (u32::from(*v) << (18 - 6 * i)));
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        let keep = match group.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => 0,
        };
        out.extend_from_slice(&bytes[..keep]);
    }
    out
}

fn decoded_text(text: &str) -> String {
    String::from_utf8_lossy(&node_base64(text)).into_owned()
}

/// `Number(text) || 0` of the scripts' counts.
fn number(text: Option<&str>) -> f64 {
    text.and_then(roamgate_git::compare::js_number)
        .filter(|n| *n != 0.0 && n.is_finite())
        .unwrap_or(0.0)
}

fn lines(stdout: &str) -> impl Iterator<Item = &str> {
    stdout
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// What the TS throws for an answer it cannot read: the output, trimmed.
fn invalid(stdout: &str, fallback: &str) -> WorkspaceError {
    let text = if stdout.is_empty() { fallback } else { stdout };
    WorkspaceError::new(roamgate_git::trim_slice(text, 1000))
}

/// The TS's error for a script that failed: stderr, else stdout, else its
/// exit.
fn failed(ran: &Ran, what: &str) -> WorkspaceError {
    let text = if !ran.stderr.is_empty() {
        ran.stderr.clone()
    } else if !ran.stdout.is_empty() {
        ran.stdout.clone()
    } else {
        format!("{what} exited {}", ran.code)
    };
    WorkspaceError::new(roamgate_git::trim_slice(&text, 1000))
}

/// `parseRemoteFileList`.
pub fn parse_remote_file_list(stdout: &str, relative_path: &str) -> FileListResult {
    let mut root = String::new();
    let mut entries = Vec::new();
    let mut truncated = false;
    for line in lines(stdout) {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let kind = parts.next().unwrap_or("");
        let rest: Vec<&str> = parts.collect();
        match kind {
            "ROOT" => {
                root = decoded_text(rest.first().copied().unwrap_or(""));
                continue;
            }
            "TRUNCATED" => {
                truncated = true;
                continue;
            }
            "ENTRY" => {}
            _ => continue,
        }
        let name = decoded_text(rest.get(3).copied().unwrap_or(""));
        if name.is_empty() {
            continue;
        }
        let kind = rest
            .first()
            .copied()
            .filter(|kind| matches!(*kind, "directory" | "symlink"))
            .unwrap_or("file");
        entries.push(FileExplorerEntry {
            path: relative_explorer_path(relative_path, &name),
            hidden: name.starts_with('.'),
            name,
            kind: kind.into(),
            size: number(rest.get(1).copied()) as u64,
            mtime_ms: number(rest.get(2).copied()) * 1000.0,
            ignored: None,
        });
    }
    entries.sort_by(|a, b| entry_sort(&a.kind, &a.name, &b.kind, &b.name));
    FileListResult {
        root,
        path: relative_path.to_owned(),
        entries,
        truncated,
    }
}

/// `parseRemoteFileResolutions`.
pub fn parse_remote_file_resolutions(stdout: &str) -> Vec<String> {
    lines(stdout)
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let (kind, raw) = (parts.next()?, parts.next()?);
            (kind == "FILE" && !raw.is_empty()).then(|| decoded_text(raw))
        })
        .filter(|path| !path.is_empty())
        .collect()
}

/// `parseRemoteFilePreview`.
pub fn parse_remote_file_preview(
    stdout: &str,
    requested_path: &str,
) -> Result<FilePreviewResult, WorkspaceError> {
    let mut all = lines(stdout);
    let meta = all.next().unwrap_or("");
    let fields: Vec<&str> = meta.split('\t').collect();
    if fields.first().copied() != Some("META") {
        return Err(invalid(stdout, "invalid file preview response"));
    }
    let field = |at: usize| fields.get(at).copied();
    let root = decoded_text(field(1).unwrap_or(""));
    let path = match field(4).filter(|raw| !raw.is_empty()) {
        Some(raw) => decoded_text(raw),
        None => requested_path.trim_start_matches('/').to_owned(),
    };
    let mtime = number(field(3)) * 1000.0;
    if field(5) == Some("directory") {
        return Ok(FilePreviewResult {
            root,
            path,
            kind: Some("directory".into()),
            size: 0,
            mtime_ms: mtime,
            truncated: false,
            decoded: Decoded::default(),
        });
    }
    let body: String = all.collect();
    let raw = node_base64(&body);
    let size = match number(field(2)) as u64 {
        0 => raw.len() as u64,
        size => size,
    };
    let limit = preview_limit_for_path(&path, size);
    let truncated = size > limit as u64 || raw.len() > limit || (raw.len() as u64) < size;
    let bytes = if truncated {
        &raw[..raw.len().min(limit)]
    } else {
        &raw[..]
    };
    Ok(FilePreviewResult {
        root,
        decoded: decode_preview_buffer(bytes, truncated, &path),
        path,
        kind: None,
        size,
        mtime_ms: mtime,
        truncated,
    })
}

/// `parseRemoteFileStat`: `STAT\t<size>\t<mtime s>\t<type>`.
pub fn parse_remote_file_stat(stdout: &str) -> Result<FileStatResult, WorkspaceError> {
    let Some(line) = lines(stdout).find(|line| line.starts_with("STAT\t")) else {
        return Err(invalid(stdout, "invalid file stat response"));
    };
    let fields: Vec<&str> = line.split('\t').collect();
    let directory = fields.get(3).copied() == Some("directory");
    Ok(FileStatResult {
        kind: if directory { "directory" } else { "file" }.into(),
        size: if directory {
            0
        } else {
            number(fields.get(1).copied()) as u64
        },
        // Seconds, as the read's: the two compare.
        mtime_ms: number(fields.get(2).copied()) * 1000.0,
    })
}

/// `parseRemoteFileDownload`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteDownload {
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub body: Vec<u8>,
    pub content_type: String,
}

/// `parseRemoteFileDownload`.
pub fn parse_remote_file_download(
    stdout: &str,
    requested_path: &str,
) -> Result<RemoteDownload, WorkspaceError> {
    let mut all = lines(stdout);
    let meta = all.next().unwrap_or("");
    let fields: Vec<&str> = meta.split('\t').collect();
    if fields.first().copied() != Some("META") {
        return Err(invalid(stdout, "invalid file download response"));
    }
    let field = |at: usize| fields.get(at).copied().filter(|raw| !raw.is_empty());
    let path = match field(2) {
        Some(raw) => decoded_text(raw),
        None => requested_path.trim_start_matches('/').to_owned(),
    };
    let filename = match field(3) {
        Some(raw) => decoded_text(raw),
        None => path
            .split('/')
            .rfind(|part| !part.is_empty())
            .unwrap_or("download")
            .to_owned(),
    };
    let content_type = field(4)
        .map(decoded_text)
        .unwrap_or_else(|| "application/octet-stream".into());
    let body = node_base64(&all.collect::<String>());
    let size = match number(fields.get(1).copied()) as u64 {
        0 => body.len() as u64,
        size => size,
    };
    Ok(RemoteDownload {
        filename,
        path,
        size,
        body,
        content_type,
    })
}

/// `parseRemoteFileUpload`.
pub fn parse_remote_file_upload(stdout: &str) -> Result<FileUploadResult, WorkspaceError> {
    let fields: Vec<&str> = stdout.trim().split('\t').collect();
    if fields.first().copied() != Some("META") {
        return Err(invalid(stdout.trim(), "invalid file upload response"));
    }
    Ok(FileUploadResult {
        path: fields
            .get(1)
            .filter(|raw| !raw.is_empty())
            .map(|raw| decoded_text(raw))
            .unwrap_or_default(),
        size: number(fields.get(2).copied()) as u64,
        overwritten: fields.get(3).copied() == Some("1"),
    })
}

/// `parseRemoteFileDelete`.
pub fn parse_remote_file_delete(stdout: &str) -> Result<FileDeleteResult, WorkspaceError> {
    let fields: Vec<&str> = stdout.trim().split('\t').collect();
    if fields.first().copied() != Some("META") {
        return Err(invalid(stdout.trim(), "invalid file delete response"));
    }
    Ok(FileDeleteResult {
        path: fields
            .get(1)
            .filter(|raw| !raw.is_empty())
            .map(|raw| decoded_text(raw))
            .unwrap_or_default(),
        kind: fields
            .get(2)
            .copied()
            .filter(|kind| matches!(*kind, "directory" | "symlink"))
            .unwrap_or("file")
            .into(),
    })
}

fn script(template: &str, values: &[(&str, TemplateValue)]) -> String {
    fill_template(template, values).expect("a files script")
}

fn bash(command: &str) -> String {
    format!("bash -lc {}", shell_quote(command))
}

async fn run(
    cx: &GitContext,
    invocation: Invocation,
    timeout: Duration,
) -> Result<Ran, WorkspaceError> {
    cx.run(invocation, timeout)
        .await
        .map_err(|error| WorkspaceError::new(error.0))
}

/// `listRemoteFiles`.
pub async fn list_remote_files(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    relative_path: &str,
    show_hidden: bool,
) -> Result<FileListResult, WorkspaceError> {
    let command = script(
        LIST_FILES_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("rel", shell_quote(relative_path).into()),
            ("show_hidden", if show_hidden { "1" } else { "0" }.into()),
            ("limit", (LIST_LIMIT as i64).into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh_read(host, &bash(&command), Some("files.list")),
        LIST_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(failed(&ran, "file list"));
    }
    Ok(parse_remote_file_list(&ran.stdout, relative_path))
}

/// `resolveRemoteFilePaths`.
pub async fn resolve_remote_file_paths(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    requested: &[String],
) -> Result<Vec<String>, WorkspaceError> {
    let requests = requested
        .iter()
        .map(|path| shell_quote(path))
        .collect::<Vec<_>>()
        .join(" ");
    let command = script(
        RESOLVE_FILES_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("requests", requests.into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh_read(host, &bash(&command), Some("files.resolve")),
        PREVIEW_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(failed(&ran, "file resolve"));
    }
    Ok(parse_remote_file_resolutions(&ran.stdout))
}

fn patterns(extensions: &[&str]) -> String {
    extensions
        .iter()
        .map(|extension| format!("*.{extension}"))
        .collect::<Vec<_>>()
        .join("|")
}

/// `readRemoteFile`.
pub async fn read_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    requested_path: &str,
) -> Result<FilePreviewResult, WorkspaceError> {
    let command = script(
        READ_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("request", shell_quote(requested_path).into()),
            ("text_limit", (PREVIEW_MAX_BYTES as i64).into()),
            ("image_limit", (PREVIEW_IMAGE_MAX_BYTES as i64).into()),
            ("missing_exit", i64::from(MISSING_FILE_EXIT).into()),
            ("image_patterns", patterns(&IMAGE_EXTENSIONS).into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh_read(host, &bash(&command), Some("files.read")),
        PREVIEW_TIMEOUT,
    )
    .await?;
    if ran.code == MISSING_FILE_EXIT {
        return Err(WorkspaceError::new(missing_file_message(
            requested_path,
            root_path,
        )));
    }
    if ran.code != 0 {
        return Err(failed(&ran, "file read"));
    }
    parse_remote_file_preview(&ran.stdout, requested_path)
}

/// `statRemoteFile`: one stat, checked against the checkout as the read.
pub async fn stat_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    requested_path: &str,
) -> Result<FileStatResult, WorkspaceError> {
    let command = script(
        STAT_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("request", shell_quote(requested_path).into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh_read(
            host,
            &format!("sh -c {}", shell_quote(&command)),
            Some("files.stat"),
        ),
        PREVIEW_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(failed(&ran, "file stat"));
    }
    parse_remote_file_stat(&ran.stdout)
}

/// A slice of a file read by blocks.
#[derive(Debug, Clone, Copy)]
struct Slice {
    start: u64,
    end: u64,
    size: u64,
}

const BLOCK_SIZE: u64 = 64 * 1024;

fn download_command(
    root_path: &str,
    requested_path: &str,
    options: &FileDownloadOptions,
    metadata_only: bool,
    slice: Option<Slice>,
    stream: Option<u64>,
) -> String {
    let n = |value: u64| TemplateValue::from(value as i64);
    script(
        DOWNLOAD_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("request", shell_quote(requested_path).into()),
            ("checked", (slice.is_some() || stream.is_some()).into()),
            ("metadata_only", metadata_only.into()),
            ("inline", options.inline.into()),
            ("audio_patterns", patterns(&AUDIO_EXTENSIONS).into()),
            ("audio_max_bytes", n(AUDIO_INLINE_PREVIEW_MAX_BYTES as u64)),
            ("capped", options.max_bytes.is_some().into()),
            ("max_bytes", n(options.max_bytes.unwrap_or(0))),
            ("slice", slice.is_some().into()),
            ("slice_size", n(slice.map_or(0, |s| s.size))),
            ("stream", stream.is_some().into()),
            ("stream_size", n(stream.unwrap_or(0))),
            ("block_size", n(BLOCK_SIZE)),
            ("skip_blocks", n(slice.map_or(0, |s| s.start / BLOCK_SIZE))),
            (
                "count_blocks",
                n(slice.map_or(0, |s| s.end.div_ceil(BLOCK_SIZE) - s.start / BLOCK_SIZE)),
            ),
        ],
    )
}

async fn read_download(
    cx: &GitContext,
    host: &str,
    command: &str,
    requested_path: &str,
) -> Result<RemoteDownload, DownloadFailure> {
    let ran = run(
        cx,
        Invocation::ssh_read(host, &bash(command), Some("files.download")),
        DOWNLOAD_TIMEOUT,
    )
    .await?;
    if ran.code == 15 {
        return Err(FileDownloadError::new(
            "Audio is too large to preview. Use Download.",
            413,
            None,
        )
        .into());
    }
    if ran.code == 17 {
        let size = ran.stderr.trim().parse::<u64>().ok();
        return Err(FileDownloadError::new(
            "File is too large to read here. Use Download.",
            413,
            size,
        )
        .into());
    }
    if ran.code != 0 {
        return Err(failed(&ran, "file download").into());
    }
    Ok(parse_remote_file_download(&ran.stdout, requested_path)?)
}

fn changed() -> WorkspaceError {
    WorkspaceError::new("File changed during download")
}

/// The bytes of a file a process prints, exactly `size` of them: it fails
/// before the response starts when the process does before its first
/// byte, and ends the body with an error (the browser then drops the
/// download) when the file changed while it was sent.
async fn streamed_file(
    mut proc: StreamedProcess,
    size: u64,
) -> Result<mpsc::Receiver<Result<Vec<u8>, String>>, WorkspaceError> {
    async fn failure(proc: &StreamedProcess) -> String {
        let code = proc.exited.clone().await;
        let stderr = proc.stderr.clone().await.trim().to_owned();
        if code == 16 || code == 0 {
            "File changed during download".into()
        } else if stderr.is_empty() {
            format!("file download exited {code}")
        } else {
            roamgate_git::trim_slice(&stderr, 1000)
        }
    }
    let first = match proc.stdout.recv().await {
        Some(Ok(chunk)) => Some(chunk),
        Some(Err(error)) => {
            proc.kill();
            return Err(WorkspaceError::new(error));
        }
        None => None,
    };
    if first.is_none() && (size > 0 || proc.exited.clone().await != 0) {
        return Err(WorkspaceError::new(failure(&proc).await));
    }
    let (sender, receiver) = mpsc::channel(4);
    tokio::spawn(async move {
        let mut sent = 0u64;
        let mut next = first;
        let mut read_failed = false;
        loop {
            let Some(chunk) = next else {
                let code = proc.exited.clone().await;
                if read_failed || !(code == 0 && sent == size) {
                    let _ = sender.send(Err(failure(&proc).await)).await;
                }
                return;
            };
            sent += chunk.len() as u64;
            if sent > size {
                proc.kill();
                let _ = sender.send(Err(changed().message)).await;
                return;
            }
            if sender.send(Ok(chunk)).await.is_err() {
                // The browser went: the process goes with it (on drop).
                return;
            }
            next = match proc.stdout.recv().await {
                Some(Ok(chunk)) => Some(chunk),
                Some(Err(_)) => {
                    read_failed = true;
                    None
                }
                None => None,
            };
        }
    });
    Ok(receiver)
}

/// `downloadRemoteFile`: read whole in base64 (a range of blocks, when
/// asked, or capped), or, with `stream`, a whole file as the host sends it
/// once its size is known.
pub async fn download_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    requested_path: &str,
    options: &FileDownloadOptions,
    stream: Option<&Arc<dyn StreamProcess>>,
) -> Result<FileDownloadResult, DownloadFailure> {
    let whole = |download: RemoteDownload| FileDownloadResult {
        accept_ranges: false,
        content_range: None,
        filename: download.filename,
        path: download.path,
        size: download.size,
        body: FileBody::Bytes(download.body),
        content_type: download.content_type,
    };
    let full = || download_command(root_path, requested_path, options, false, None, None);
    if !options.inline && options.range.is_none() && stream.is_none() {
        return Ok(whole(
            read_download(cx, host, &full(), requested_path).await?,
        ));
    }
    let metadata = read_download(
        cx,
        host,
        &download_command(root_path, requested_path, options, true, None, None),
        requested_path,
    )
    .await?;
    if metadata.content_type == "application/gzip" {
        return Ok(whole(
            read_download(cx, host, &full(), requested_path).await?,
        ));
    }
    if !options.inline
        && options.range.is_none()
        && let Some(stream) = stream
    {
        // A whole file goes out as the host sends it: no size limit, no
        // deadline, and no copy of it held here.
        let command = download_command(
            root_path,
            requested_path,
            options,
            false,
            None,
            Some(metadata.size),
        );
        let proc = stream
            .spawn(Invocation::ssh_read(
                host,
                &bash(&command),
                Some("files.download"),
            ))
            .await
            .map_err(WorkspaceError::new)?;
        let body = streamed_file(proc, metadata.size).await?;
        return Ok(FileDownloadResult {
            accept_ranges: false,
            content_range: None,
            filename: metadata.filename,
            path: metadata.path,
            size: metadata.size,
            body: FileBody::Stream(body),
            content_type: metadata.content_type,
        });
    }
    let range = file_download_range(&metadata.path, metadata.size, options)?;
    let start = range.map_or(0, |range| range.start);
    let end = range.map_or(metadata.size, |range| range.end + 1);
    let download = read_download(
        cx,
        host,
        &download_command(
            root_path,
            requested_path,
            options,
            false,
            Some(Slice {
                start,
                end,
                size: metadata.size,
            }),
            None,
        ),
        requested_path,
    )
    .await?;
    // Read only intersecting blocks; trim their edges.
    let from = (start % BLOCK_SIZE) as usize;
    let to = from + (end - start) as usize;
    let body = download
        .body
        .get(from..to.min(download.body.len()))
        .unwrap_or(&[]);
    if body.len() as u64 != end - start || download.path != metadata.path {
        return Err(changed().into());
    }
    Ok(FileDownloadResult {
        accept_ranges: true,
        content_range: range.map(|_| format!("bytes {start}-{}/{}", end - 1, metadata.size)),
        filename: download.filename,
        path: download.path,
        size: body.len() as u64,
        body: FileBody::Bytes(body.to_vec()),
        content_type: download.content_type,
    })
}

/// `uploadRemoteFile`: the bytes go in base64 on stdin.
pub async fn upload_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    directory: &str,
    filename: &str,
    body: &[u8],
) -> Result<FileUploadResult, WorkspaceError> {
    let command = script(
        UPLOAD_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("rel", shell_quote(directory).into()),
            ("name", shell_quote(filename).into()),
        ],
    );
    let ran = cx
        .run_input(
            Invocation::ssh(host, &bash(&command), Some("files.upload")),
            base64::engine::general_purpose::STANDARD.encode(body),
            UPLOAD_TIMEOUT,
        )
        .await
        .map_err(|error| WorkspaceError::new(error.0))?;
    if ran.code != 0 {
        return Err(failed(&ran, "file upload"));
    }
    parse_remote_file_upload(&ran.stdout)
}

/// `deleteRemoteFile`.
pub async fn delete_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    requested_path: &str,
) -> Result<FileDeleteResult, WorkspaceError> {
    let command = script(
        DELETE_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            ("rel", shell_quote(requested_path).into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh(host, &bash(&command), Some("files.delete")),
        DELETE_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(failed(&ran, "file delete"));
    }
    parse_remote_file_delete(&ran.stdout)
}

/// `mutateRemoteFile`: a new directory, or (`path`) a file moved into
/// `directory` by Python's exclusive rename.
pub async fn mutate_remote_file(
    cx: &GitContext,
    host: &str,
    root_path: &str,
    directory: &str,
    name: &str,
    path: Option<&str>,
) -> Result<String, WorkspaceError> {
    let source_directory = path
        .and_then(|path| path.rfind('/').map(|at| &path[..at]))
        .unwrap_or(".");
    let command = script(
        MUTATE_FILE_SH,
        &[
            ("root", shell_quote(root_path).into()),
            (
                "directory",
                shell_quote(if directory.is_empty() { "." } else { directory }).into(),
            ),
            ("name", shell_quote(name).into()),
            ("move", path.is_some().into()),
            ("source_directory", shell_quote(source_directory).into()),
            ("rename", shell_quote(REMOTE_EXCLUSIVE_RENAME).into()),
        ],
    );
    let ran = run(
        cx,
        Invocation::ssh(host, &bash(&command), None),
        DELETE_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(failed(&ran, "file operation"));
    }
    Ok(relative_explorer_path(directory, name))
}

#[cfg(test)]
mod tests;
