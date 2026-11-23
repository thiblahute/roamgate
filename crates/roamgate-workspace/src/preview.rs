//! Files' preview decoding (workspace/preview.ts): roamgate-git's, which
//! Changes and the commit previews share.

pub use roamgate_git::preview::{
    AUDIO_INLINE_PREVIEW_MAX_BYTES, Decoded, PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES,
    audio_mime_for_path, decode_preview_buffer, image_mime_for_path, inline_preview_mime_for_path,
    is_html_path, preview_limit_for_path, video_mime_for_path,
};
pub use roamgate_git::trim_incomplete_utf8_tail;

#[cfg(test)]
mod tests {
    use base64::Engine as _;

    use super::*;

    #[test]
    fn detects_supported_image_mime_types() {
        assert_eq!(image_mime_for_path("image.PNG"), Some("image/png"));
        assert_eq!(image_mime_for_path("photo.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("archive.tar"), None);
    }

    #[test]
    fn detects_mime_types_allowed_for_inline_previews() {
        for (path, mime) in [
            ("docs/guide.PDF", Some("application/pdf")),
            ("images/demo.webp", Some("image/webp")),
            ("page.html", None),
            ("vector.svg", Some("image/svg+xml")),
            ("voice/take.WAV", Some("audio/wav")),
            ("song.mp3", Some("audio/mpeg")),
            ("clip.m4a", Some("audio/mp4")),
            ("video.mp4", Some("video/mp4")),
            ("clip.WebM", Some("video/webm")),
            ("movie.mkv", None),
        ] {
            assert_eq!(inline_preview_mime_for_path(path), mime, "{path}");
        }
    }

    #[test]
    fn chooses_larger_limits_only_for_previewable_images() {
        let image = PREVIEW_IMAGE_MAX_BYTES as u64;
        assert_eq!(
            preview_limit_for_path("photo.png", image),
            PREVIEW_IMAGE_MAX_BYTES
        );
        assert_eq!(
            preview_limit_for_path("photo.png", image + 1),
            PREVIEW_MAX_BYTES
        );
        assert_eq!(preview_limit_for_path("notes.txt", 10), PREVIEW_MAX_BYTES);
    }

    #[test]
    fn decodes_text_previews_and_flags_binary_data() {
        assert_eq!(
            decode_preview_buffer(b"hello", false, "README.md"),
            Decoded {
                text: Some("hello".into()),
                binary: false,
                ..Decoded::default()
            }
        );
        assert_eq!(
            decode_preview_buffer(&[0, 1, 2], false, "data.bin"),
            Decoded {
                text: None,
                binary: true,
                ..Decoded::default()
            }
        );
    }

    #[test]
    fn returns_data_urls_for_complete_image_previews() {
        let preview = decode_preview_buffer(b"png-data", false, "a.png");
        assert!(preview.binary);
        assert_eq!(preview.mime_type.as_deref(), Some("image/png"));
        assert_eq!(
            preview.image_data_url.as_deref(),
            Some("data:image/png;base64,cG5nLWRhdGE=")
        );
    }

    #[test]
    fn previews_svg_and_additional_browser_image_formats_as_image_data() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h10\"/></svg>";
        let preview = decode_preview_buffer(svg.as_bytes(), false, "vector.SVG");
        assert!(preview.binary);
        assert_eq!(preview.text, None);
        assert_eq!(preview.mime_type.as_deref(), Some("image/svg+xml"));
        assert_eq!(
            preview.image_data_url,
            Some(format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg)
            ))
        );
        assert_eq!(image_mime_for_path("animation.apng"), Some("image/apng"));
        assert_eq!(image_mime_for_path("photo.jfif"), Some("image/jpeg"));
        assert_eq!(image_mime_for_path("photo.jpe"), Some("image/jpeg"));
        assert_eq!(
            preview_limit_for_path("vector.svg", 1024),
            PREVIEW_IMAGE_MAX_BYTES
        );
        assert_eq!(
            decode_preview_buffer(svg.as_bytes(), true, "vector.svg").image_data_url,
            None
        );
    }

    #[test]
    fn trims_incomplete_utf_8_tails_for_truncated_text() {
        let buffer = "hello 😀".as_bytes();
        let cut = &buffer[..buffer.len() - 1];
        assert_eq!(trim_incomplete_utf8_tail(cut), b"hello ");
        assert_eq!(
            decode_preview_buffer(cut, true, "README.md"),
            Decoded {
                text: Some("hello ".into()),
                binary: false,
                ..Decoded::default()
            }
        );
    }
}
