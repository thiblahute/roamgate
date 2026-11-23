//! What a file's bytes show as (preview.ts `decodePreviewBuffer`,
//! shared/filePreview.ts): text, an image as a data URL, or binary; the
//! media types of Files, Changes and SSH reads. The workspace crate's
//! previews read through these too.

use base64::Engine as _;
use serde::Serialize;

/// The largest preview of a text or HTML file.
pub const PREVIEW_MAX_BYTES: usize = 512 * 1024;
/// The largest image shown inline.
pub const PREVIEW_IMAGE_MAX_BYTES: usize = 5 * 1024 * 1024;
/// Served inline for `<audio>` up to this size.
pub const AUDIO_INLINE_PREVIEW_MAX_BYTES: usize = 25 * 1024 * 1024;

const IMAGE_MIME_TYPES: [(&str, &str); 12] = [
    ("svg", "image/svg+xml"),
    ("apng", "image/apng"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("jpe", "image/jpeg"),
    ("jfif", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
];

const AUDIO_MIME_TYPES: [(&str, &str); 9] = [
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("flac", "audio/flac"),
    ("weba", "audio/webm"),
];

const VIDEO_MIME_TYPES: [(&str, &str); 5] = [
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("webm", "video/webm"),
    ("ogv", "video/ogg"),
    ("mov", "video/quicktime"),
];

fn by_extension(table: &[(&str, &'static str)], path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    let extension = lower.rsplit('.').next().unwrap_or("");
    table
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

pub fn image_mime_for_path(path: &str) -> Option<&'static str> {
    by_extension(&IMAGE_MIME_TYPES, path)
}

pub fn audio_mime_for_path(path: &str) -> Option<&'static str> {
    by_extension(&AUDIO_MIME_TYPES, path)
}

pub fn video_mime_for_path(path: &str) -> Option<&'static str> {
    by_extension(&VIDEO_MIME_TYPES, path)
}

/// `/\.html?$/i`.
pub fn is_html_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// A PDF, image, audio or video type served inline, by extension.
pub fn inline_preview_mime_for_path(path: &str) -> Option<&'static str> {
    if path.to_lowercase().ends_with(".pdf") {
        return Some("application/pdf");
    }
    image_mime_for_path(path)
        .or_else(|| audio_mime_for_path(path))
        .or_else(|| video_mime_for_path(path))
}

/// The most of a file a preview reads.
pub fn preview_limit_for_path(path: &str, size: u64) -> usize {
    if image_mime_for_path(path).is_some() && size <= PREVIEW_IMAGE_MAX_BYTES as u64 {
        PREVIEW_IMAGE_MAX_BYTES
    } else {
        PREVIEW_MAX_BYTES
    }
}

/// A decoded preview (`FilePreviewDecoded`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Decoded {
    pub text: Option<String>,
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data_url: Option<String>,
}

/// TextDecoder drops a leading byte order mark.
fn without_bom(text: &str) -> String {
    text.strip_prefix('\u{feff}').unwrap_or(text).to_owned()
}

/// Text when the bytes are UTF-8 (a cut sequence at a truncated end is
/// dropped), an image's data URL, else binary.
pub fn decode_preview_buffer(buffer: &[u8], truncated: bool, path: &str) -> Decoded {
    let image = image_mime_for_path(path);
    if let Some(mime) = image
        && !truncated
    {
        return Decoded {
            text: None,
            binary: true,
            mime_type: Some(mime.into()),
            image_data_url: Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(buffer)
            )),
        };
    }
    let binary = || Decoded {
        text: None,
        binary: true,
        mime_type: image.map(str::to_owned),
        image_data_url: None,
    };
    if buffer.contains(&0) {
        return binary();
    }
    if let Ok(text) = std::str::from_utf8(buffer) {
        return Decoded {
            text: Some(without_bom(text)),
            binary: false,
            ..Decoded::default()
        };
    }
    if truncated {
        let trimmed = crate::trim_incomplete_utf8_tail(buffer);
        if trimmed.len() != buffer.len()
            && let Ok(text) = std::str::from_utf8(trimmed)
        {
            return Decoded {
                text: Some(without_bom(text)),
                binary: false,
                ..Decoded::default()
            };
        }
    }
    binary()
}
