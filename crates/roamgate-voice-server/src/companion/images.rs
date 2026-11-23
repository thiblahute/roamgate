//! The images given with words typed to the companion
//! (`voice/voice-images.ts`): only files of the chat composers' upload
//! folder, read as the model takes them; and the images the companion's
//! conversation shows, served by their path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use regex::RegexBuilder;
use roamgate_review::images::local_image_file;

use crate::companion::claude::PromptImage;

/// The most images one typed turn gives the front.
pub const MAX_TURN_IMAGES: usize = 8;

/// The largest image the model takes (the page makes them smaller first).
pub const MAX_TURN_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Where the chat composers' images are uploaded on this host (the
/// connection's /upload-image): `<tmp>/roamgate-uploads-<uid>`.
pub fn upload_root() -> PathBuf {
    #[cfg(unix)]
    let user = rustix::process::getuid().as_raw().to_string();
    #[cfg(not(unix))]
    let user = "user".to_owned();
    std::env::temp_dir().join(format!("roamgate-uploads-{user}"))
}

/// The images uploaded with words typed to the companion, by their paths
/// in them: only files of the upload folder, read as the model takes them.
/// The others (a path the user wrote, a file too big) stay words.
pub fn uploaded_images(said: &str, root: &Path) -> Vec<PromptImage> {
    let root_text = root.to_string_lossy();
    let Ok(pattern) = RegexBuilder::new(&format!(
        r"{}/upload-[^/\s]+/[^/\s]+\.(?:png|jpe?g|gif|webp)",
        regex::escape(&root_text)
    ))
    .case_insensitive(true)
    .build() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let paths: Vec<&str> = pattern
        .find_iter(said)
        .map(|found| found.as_str())
        .filter(|path| seen.insert(*path))
        .take(MAX_TURN_IMAGES)
        .collect();
    let Ok(real) = std::fs::canonicalize(root) else {
        return Vec::new();
    };
    let mut images = Vec::new();
    for path in paths {
        // A link out of the folder is not one of its images.
        let Ok(resolved) = std::fs::canonicalize(path) else {
            continue;
        };
        if !resolved.starts_with(&real) || resolved == real {
            continue;
        }
        let Some(media_type) = local_image_file(path) else {
            continue;
        };
        // Gone since it was uploaded (a day later): the words stay.
        let Ok(data) = std::fs::read(path) else {
            continue;
        };
        if data.len() > MAX_TURN_IMAGE_BYTES {
            continue;
        }
        images.push(PromptImage {
            media_type: media_type.to_owned(),
            data: base64::engine::general_purpose::STANDARD.encode(data),
        });
    }
    images
}

/// The headers an image served to the companion's conversation goes with.
pub const VOICE_IMAGE_HEADERS: [(&str, &str); 3] = [
    ("cache-control", "private, no-cache"),
    ("x-content-type-options", "nosniff"),
    ("content-security-policy", "default-src 'none'"),
];

/// GET /api/voice/image?path=: an image the companion was given or names,
/// by its absolute path on this host: its file and content type, or None
/// (404) for anything else.
pub fn voice_image(path: &str) -> Option<(PathBuf, &'static str)> {
    local_image_file(path).map(|content_type| (PathBuf::from(path), content_type))
}

#[cfg(test)]
mod tests;
