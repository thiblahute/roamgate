//! Images pasted into comments, kept with the reviews and read by agents
//! (review/images.ts): `<reviews>/images/<review>/<hash>.<ext>`, named by
//! the first 16 hex digits of their SHA-256, 0600.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::ReviewError;

/// The largest image kept or read.
pub const REVIEW_IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;

const TYPES: [(&str, &str, &[u8]); 4] = [
    ("image/png", "png", &[0x89, 0x50, 0x4e, 0x47]),
    ("image/jpeg", "jpg", &[0xff, 0xd8, 0xff]),
    ("image/gif", "gif", &[0x47, 0x49, 0x46, 0x38]),
    ("image/webp", "webp", &[0x52, 0x49, 0x46, 0x46]),
];

fn session_id(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Stores an image of a review and returns its absolute path.
pub fn save_review_image(
    directory: &Path,
    session: &str,
    content_type: &str,
    data: &[u8],
) -> Result<PathBuf, ReviewError> {
    let Some((_, extension, magic)) = TYPES.iter().find(|(name, _, _)| *name == content_type)
    else {
        return Err(ReviewError::new("only PNG, JPEG, GIF or WebP images"));
    };
    if data.is_empty() || data.len() > REVIEW_IMAGE_MAX_BYTES {
        return Err(ReviewError::new("an image is at most 10 MiB"));
    }
    if !data.starts_with(magic) {
        return Err(ReviewError::new(format!(
            "that is not a {}",
            extension.to_uppercase()
        )));
    }
    if !session_id(session) {
        return Err(ReviewError::not_found("no such review"));
    }
    let folder = directory.join("images").join(session);
    create_dir_0700(&folder).map_err(|error| ReviewError::new(error.to_string()))?;
    let hash = hex(&Sha256::digest(data));
    let path = folder.join(format!("{}.{extension}", &hash[..16]));
    if !path.exists() {
        write_0600(&path, data).map_err(|error| ReviewError::new(error.to_string()))?;
    }
    Ok(path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn create_dir_0700(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn write_0600(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Removes the images of reviews that no longer exist (folders named as
/// review ids only); the names removed.
pub fn prune_review_images(
    directory: &Path,
    live: &std::collections::HashSet<String>,
) -> Vec<String> {
    let folder = directory.join("images");
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let removed: Vec<String> = names
        .into_iter()
        .filter(|name| session_id(name) && !live.contains(name))
        .collect();
    for name in &removed {
        let _ = std::fs::remove_dir_all(folder.join(name));
    }
    removed
}

/// A stored image by its session and name (its path and content type).
pub fn review_image_file(
    directory: &Path,
    session: &str,
    name: &str,
) -> Option<(PathBuf, &'static str)> {
    if !session_id(session) {
        return None;
    }
    let (stem, extension) = name.split_once('.')?;
    if !session_id(stem) {
        return None;
    }
    let (content_type, _, _) = TYPES.iter().find(|(_, ext, _)| *ext == extension)?;
    Some((
        directory.join("images").join(session).join(name),
        content_type,
    ))
}

/// The image `/api/review/image?<query>` serves (serveReviewImage): an
/// agent's by `path` (`named`: it may change, so not kept), else a pasted
/// one by `session` and `name`. Its path and content type.
pub fn image_of_query(directory: &Path, query: &str) -> Option<(PathBuf, &'static str, bool)> {
    let mut path = None;
    let mut session = None;
    let mut name = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match key.as_ref() {
            "path" => &mut path,
            "session" => &mut session,
            "name" => &mut name,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(value.into_owned());
        }
    }
    if let Some(path) = path {
        let content_type = local_image_file(&path)?;
        return Some((PathBuf::from(path), content_type, true));
    }
    let (file, content_type) = review_image_file(
        directory,
        session.as_deref().unwrap_or(""),
        name.as_deref().unwrap_or(""),
    )?;
    Some((file, content_type, false))
}

/// An image file of this host named by its absolute path in a comment (an
/// agent's screenshot): its content type, read from its first bytes.
pub fn local_image_file(path: &str) -> Option<&'static str> {
    if path.is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
        return None;
    }
    let lower = path.to_lowercase();
    if ![".png", ".jpg", ".jpeg", ".gif", ".webp"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let info = file.metadata().ok()?;
    if !info.is_file() || info.len() == 0 || info.len() > REVIEW_IMAGE_MAX_BYTES as u64 {
        return None;
    }
    let mut head = [0u8; 12];
    let mut read = 0;
    while read < head.len() {
        match file.read(&mut head[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(_) => return None,
        }
    }
    for (content_type, _, magic) in TYPES {
        if head.starts_with(magic) && (content_type != "image/webp" || &head[8..12] == b"WEBP") {
            return Some(content_type);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const PNG: [u8; 9] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1];

    #[test]
    fn a_pasted_image_is_kept_with_its_review_named_by_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_review_image(dir.path(), "0123456789abcdef", "image/png", &PNG).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            path.parent().unwrap(),
            dir.path().join("images/0123456789abcdef")
        );
        assert!(name.ends_with(".png") && name.len() == 20);
        assert_eq!(std::fs::read(&path).unwrap(), PNG);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            save_review_image(dir.path(), "0123456789abcdef", "image/png", &PNG).unwrap(),
            path
        );
        assert_eq!(
            review_image_file(dir.path(), "0123456789abcdef", &name),
            Some((path, "image/png"))
        );
    }

    #[test]
    fn the_image_route_serves_a_pasted_one_or_an_agent_s_by_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_review_image(dir.path(), "0123456789abcdef", "image/png", &PNG).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            image_of_query(dir.path(), &format!("session=0123456789abcdef&name={name}")),
            Some((path.clone(), "image/png", false))
        );
        let named = format!("path={}", path.to_string_lossy().replace('/', "%2F"));
        assert_eq!(
            image_of_query(dir.path(), &named),
            Some((path, "image/png", true))
        );
        assert_eq!(
            image_of_query(
                dir.path(),
                "session=0123456789abcdef&name=../../reviews.sqlite"
            ),
            None
        );
        assert_eq!(image_of_query(dir.path(), "path=/etc/passwd"), None);
    }

    #[test]
    fn only_real_images_and_no_way_out_of_the_reviews_folder() {
        let dir = tempfile::tempdir().unwrap();
        let error = |result: Result<PathBuf, ReviewError>| result.unwrap_err().message;
        assert!(
            error(save_review_image(
                dir.path(),
                "0123456789abcdef",
                "image/svg+xml",
                &PNG
            ))
            .contains("only PNG")
        );
        assert!(
            error(save_review_image(
                dir.path(),
                "0123456789abcdef",
                "image/jpeg",
                &[1, 2, 3, 4]
            ))
            .contains("not a JPG")
        );
        assert!(
            error(save_review_image(
                dir.path(),
                "../../etc",
                "image/png",
                &PNG
            ))
            .contains("no such review")
        );
        assert_eq!(
            review_image_file(dir.path(), "0123456789abcdef", "../x.png"),
            None
        );
        assert_eq!(
            review_image_file(dir.path(), "..", "0123456789abcdef.png"),
            None
        );
    }

    #[test]
    fn pruning_removes_the_images_of_gone_reviews_only() {
        let dir = tempfile::tempdir().unwrap();
        let live = "0123456789abcdef";
        let gone = "fedcba9876543210";
        let kept = save_review_image(dir.path(), live, "image/png", &PNG).unwrap();
        let removed = save_review_image(dir.path(), gone, "image/png", &PNG).unwrap();
        let notes = dir.path().join("images/notes");
        std::fs::create_dir(&notes).unwrap();
        std::fs::write(notes.join("keep.txt"), "mine\n").unwrap();
        let alive: HashSet<String> = [live.to_owned()].into();
        assert_eq!(
            prune_review_images(dir.path(), &alive),
            vec![gone.to_owned()]
        );
        assert!(kept.exists());
        assert!(!removed.exists());
        assert_eq!(
            std::fs::read_to_string(notes.join("keep.txt")).unwrap(),
            "mine\n"
        );
        assert!(prune_review_images(dir.path(), &alive).is_empty());
        assert!(prune_review_images(&dir.path().join("none"), &HashSet::new()).is_empty());
    }

    #[test]
    fn an_agents_image_by_its_path_only_image_files_by_their_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let at = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
        std::fs::write(at("shot.png"), [0x89, 0x50, 0x4e, 0x47, 0, 0]).unwrap();
        std::fs::write(at("secret.png"), "not an image").unwrap();
        std::fs::write(at("a.webp"), b"RIFF\0\0\0\0WEBPVP8 ").unwrap();
        std::fs::write(at("b.webp"), b"RIFF\0\0\0\0WAVEfmt ").unwrap();
        assert_eq!(local_image_file(&at("shot.png")), Some("image/png"));
        assert_eq!(local_image_file(&at("a.webp")), Some("image/webp"));
        assert_eq!(local_image_file(&at("secret.png")), None);
        assert_eq!(local_image_file(&at("b.webp")), None);
        assert_eq!(local_image_file(&at("gone.png")), None);
        assert_eq!(local_image_file("shot.png"), None);
        assert_eq!(local_image_file(&dir.path().to_string_lossy()), None);
    }
}
