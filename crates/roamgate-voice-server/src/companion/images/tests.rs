#[cfg(unix)]
use base64::Engine;

use super::*;

const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

#[cfg(unix)]
#[test]
fn only_the_upload_folders_images_read_for_the_model() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("roamgate-uploads-1");
    std::fs::create_dir_all(root.join("upload-a")).unwrap();
    let shot = root.join("upload-a").join("img-1.png");
    std::fs::write(&shot, PNG).unwrap();
    // Named .png, but not one.
    let fake = root.join("upload-a").join("img-2.png");
    std::fs::write(&fake, "hello").unwrap();
    let outside = home.path().join("secret.png");
    std::fs::write(&outside, PNG).unwrap();
    // A link out of the folder.
    let link = root.join("upload-a").join("img-3.png");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let said = format!(
        "look {} and {}, {} and {}",
        shot.display(),
        fake.display(),
        link.display(),
        outside.display()
    );
    assert_eq!(
        uploaded_images(&said, &root),
        vec![PromptImage {
            media_type: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(PNG),
        }]
    );
    assert_eq!(uploaded_images("no image here", &root), vec![]);
}

#[test]
fn the_conversations_images_are_served_by_their_path_only_images() {
    let home = tempfile::tempdir().unwrap();
    let shot = home.path().join("shot.png");
    std::fs::write(&shot, PNG).unwrap();
    let note = home.path().join("note.png");
    std::fs::write(&note, "text").unwrap();
    let (file, content_type) = voice_image(&shot.to_string_lossy()).unwrap();
    assert_eq!(content_type, "image/png");
    assert_eq!(std::fs::read(file).unwrap(), PNG);
    assert_eq!(voice_image(&note.to_string_lossy()), None);
    assert_eq!(voice_image("relative.png"), None);
}
