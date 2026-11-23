//! What a download sends of a file (workspace/file-download.ts): the
//! range asked, the inline audio limit, and the content type by name.

use roamgate_git::preview::{AUDIO_INLINE_PREVIEW_MAX_BYTES, audio_mime_for_path};

/// `FileDownloadOptions`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileDownloadOptions {
    pub inline: bool,
    pub range: Option<String>,
    pub if_range: Option<String>,
    /// A file over this is refused (413) before it is read; not directories.
    pub max_bytes: Option<u64>,
}

/// `FileDownloadError`: a refusal with its HTTP status (413 or 416), and
/// the file's size when known.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct FileDownloadError {
    pub message: String,
    pub status: u16,
    pub size: Option<u64>,
}

impl FileDownloadError {
    pub fn new(message: impl Into<String>, status: u16, size: Option<u64>) -> Self {
        Self {
            message: message.into(),
            status,
            size,
        }
    }
}

/// The bytes asked, both ends included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

/// `downloadContentTypeForPath`: an APK as one (Android installs it only
/// then), anything else as bytes.
pub fn download_content_type_for_path(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && !ext.contains(['/', '\\']))
        .map(str::to_lowercase)
        .unwrap_or_default();
    if extension == "apk" {
        "application/vnd.android.package-archive"
    } else {
        "application/octet-stream"
    }
}

/// Digits as a number, saturated (BigInt in the TS: any value past the
/// size acts the same).
fn digits(text: &str) -> u128 {
    text.bytes().fold(0u128, |n, d| {
        n.saturating_mul(10).saturating_add(u128::from(d - b'0'))
    })
}

/// `fileDownloadRange`: the range of a `Range: bytes=a-b` header, None for
/// the whole file (no header, another unit, several ranges, `If-Range`).
pub fn file_download_range(
    path: &str,
    size: u64,
    options: &FileDownloadOptions,
) -> Result<Option<ByteRange>, FileDownloadError> {
    if options.inline
        && audio_mime_for_path(path).is_some()
        && size > AUDIO_INLINE_PREVIEW_MAX_BYTES as u64
    {
        return Err(FileDownloadError::new(
            "Audio is too large to preview. Use Download.",
            413,
            None,
        ));
    }
    // This endpoint has no validators with which to satisfy If-Range.
    if options.if_range.is_some() {
        return Ok(None);
    }
    let header = options.range.as_deref().unwrap_or("").trim();
    let Some(spec) = header
        .get(..6)
        .filter(|unit| unit.eq_ignore_ascii_case("bytes="))
        .map(|_| &header[6..])
    else {
        return Ok(None);
    };
    let Some((first, last)) = spec.split_once('-') else {
        return Ok(None);
    };
    let numeric = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if !numeric(first) || !numeric(last) || (first.is_empty() && last.is_empty()) {
        return Ok(None);
    }
    let total = u128::from(size);
    let start = if !first.is_empty() {
        digits(first)
    } else if total > digits(last) {
        total - digits(last)
    } else {
        0
    };
    let end = if !first.is_empty() && !last.is_empty() {
        digits(last)
    } else {
        total.wrapping_sub(1)
    };
    let end_before_start = if !first.is_empty() && !last.is_empty() {
        end < start
    } else {
        total == 0 || total - 1 < start
    };
    if start >= total || end_before_start || (first.is_empty() && digits(last) == 0) {
        return Err(FileDownloadError::new(
            "Requested range is not satisfiable",
            416,
            Some(size),
        ));
    }
    let end = if end < total { end } else { total - 1 };
    Ok(Some(ByteRange {
        start: start as u64,
        end: end as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranged(range: &str) -> FileDownloadOptions {
        FileDownloadOptions {
            range: Some(range.into()),
            ..Default::default()
        }
    }

    #[test]
    fn audio_range_parsing_handles_boundaries_and_ignores_unsupported_ranges() {
        for (range, expected) in [
            ("bytes=0-1", Some((0, 1))),
            ("bytes=8-", Some((8, 9))),
            ("bytes=-2", Some((8, 9))),
            ("bytes=-99999999999999999999999", Some((0, 9))),
            ("bytes=1-99999999999999999999999", Some((1, 9))),
            ("bytes=0-1,4-5", None),
            ("bytes=x-y", None),
            ("items=0-1", None),
        ] {
            assert_eq!(
                file_download_range("clip.wav", 10, &ranged(range)).unwrap(),
                expected.map(|(start, end)| ByteRange { start, end }),
                "{range}"
            );
        }
        for range in [
            "bytes=10-",
            "bytes=99999999999999999999999-",
            "bytes=2-1",
            "bytes=-0",
        ] {
            let error = file_download_range("clip.wav", 10, &ranged(range)).unwrap_err();
            assert!(error.message.contains("not satisfiable"), "{range}");
        }
        assert!(
            file_download_range("empty.wav", 0, &ranged("bytes=0-0"))
                .unwrap_err()
                .message
                .contains("not satisfiable")
        );
        let inline = |range: Option<&str>| FileDownloadOptions {
            inline: true,
            range: range.map(str::to_owned),
            ..Default::default()
        };
        assert_eq!(
            file_download_range(
                "clip.wav",
                AUDIO_INLINE_PREVIEW_MAX_BYTES as u64,
                &inline(Some("bytes=0-1"))
            )
            .unwrap(),
            Some(ByteRange { start: 0, end: 1 })
        );
        assert!(
            file_download_range(
                "clip.WAV",
                AUDIO_INLINE_PREVIEW_MAX_BYTES as u64 + 1,
                &inline(None)
            )
            .unwrap_err()
            .message
            .contains("too large")
        );
    }

    #[test]
    fn names_an_apk_as_an_android_package() {
        assert_eq!(
            download_content_type_for_path("app-debug.APK"),
            "application/vnd.android.package-archive"
        );
        assert_eq!(
            download_content_type_for_path("notes.txt"),
            "application/octet-stream"
        );
        assert_eq!(
            download_content_type_for_path("apk"),
            "application/octet-stream"
        );
    }
}
