//! An image of a message (`images.ts`): only images Roamgate staged
//! itself (POST /upload-image), read here or on the connection's host, as
//! base64.

use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;

use crate::driver::BoxFuture;

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// An image read for a message (`ConversationImage`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationImage {
    pub media_type: String,
    pub data: String,
}

/// A file named img-*.<ext> in an upload folder of the private uploads
/// directory.
static UPLOAD_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^/(?:[^/\x00]+/)*roamgate-uploads-[A-Za-z0-9_-]+/upload-[A-Za-z0-9_-]+/img-[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$")
        .unwrap()
});

/// The media type of an image Roamgate staged; None for any other path.
pub fn uploaded_image_type(path: &str) -> Option<&'static str> {
    if path.contains("/../") || path.contains("/./") {
        return None;
    }
    let extension = UPLOAD_PATH.captures(path)?[1].to_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

const ONLY_UPLOADED: &str = "Only images uploaded to Roamgate can be sent";

/// The command a host's shell runs to print an uploaded image as base64
/// (the core runs it over SSH, annotated `agent_chat.image`).
pub fn remote_image_command(path: &str, sh_quote: &dyn Fn(&str) -> String) -> String {
    format!(
        "f={}; [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ \"$(wc -c < \"$f\")\" -le {MAX_IMAGE_BYTES} ] && base64 < \"$f\"",
        sh_quote(path)
    )
}

/// Runs a command on the connection's host: its exit code and output.
pub type RemoteRun = std::sync::Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<(i32, Vec<u8>), String>> + Send + Sync,
>;

/// Reads uploaded images, here (no `remote`) or on the connection's host.
#[derive(Clone)]
pub struct ImageReader {
    pub remote: Option<RemoteRun>,
    pub sh_quote: std::sync::Arc<dyn Fn(&str) -> String + Send + Sync>,
}

impl ImageReader {
    pub async fn read(&self, path: &str) -> Result<ConversationImage, String> {
        let media_type = uploaded_image_type(path).ok_or(ONLY_UPLOADED)?;
        let Some(remote) = &self.remote else {
            let real = tokio::fs::canonicalize(path)
                .await
                .map_err(|error| error.to_string())?;
            if uploaded_image_type(&real.to_string_lossy()) != Some(media_type) {
                return Err(ONLY_UPLOADED.into());
            }
            let info = tokio::fs::metadata(&real)
                .await
                .map_err(|error| error.to_string())?;
            if !info.is_file() || info.len() > MAX_IMAGE_BYTES {
                return Err("The image is too large or missing".into());
            }
            let bytes = tokio::fs::read(&real)
                .await
                .map_err(|error| error.to_string())?;
            return Ok(ConversationImage {
                media_type: media_type.into(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        };
        let (code, stdout) = remote(remote_image_command(path, &*self.sh_quote)).await?;
        let text = String::from_utf8_lossy(&stdout);
        if code != 0 || text.trim().is_empty() {
            return Err("The image could not be read on the host".into());
        }
        Ok(ConversationImage {
            media_type: media_type.into(),
            data: text.chars().filter(|c| !c.is_whitespace()).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_images_roamgate_staged_are_read() {
        assert_eq!(
            uploaded_image_type("/tmp/roamgate-uploads-1000/upload-abc/img-1.PNG"),
            Some("image/png")
        );
        assert_eq!(
            uploaded_image_type("/tmp/roamgate-uploads-1/upload-a/img-b.jpeg"),
            Some("image/jpeg")
        );
        assert_eq!(
            uploaded_image_type("/tmp/roamgate-uploads-1/upload-a/../img-b.png"),
            None
        );
        assert_eq!(uploaded_image_type("/etc/passwd"), None);
    }
}
