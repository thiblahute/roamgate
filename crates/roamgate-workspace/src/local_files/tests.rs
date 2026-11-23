//! local-files.test.ts.

use std::fs;
use std::path::Path;

use super::*;

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("herdr-gui-test-")
        .tempdir()
        .unwrap()
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[test]
fn lists_files_with_hidden_filtering_and_directory_first_sorting() {
    let dir = temp();
    let root = dir.path();
    fs::create_dir(root.join("src")).unwrap();
    fs::write(root.join("README.md"), "hello").unwrap();
    fs::write(root.join(".env"), "secret").unwrap();
    let hidden_off = list_local_files(text(root), "", false, false).unwrap();
    let names: Vec<_> = hidden_off.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["src", "README.md"]);
    let hidden_on = list_local_files(text(root), "", true, false).unwrap();
    assert!(hidden_on.entries.iter().any(|e| e.name == ".env"));
}

#[test]
fn reads_relative_and_absolute_file_previews() {
    let dir = temp();
    let root = dir.path();
    let outside_name = format!("outside-{}.txt", std::process::id());
    let outside = root.join("..").join(&outside_name);
    fs::write(root.join("README.md"), "hello").unwrap();
    fs::write(&outside, "outside").unwrap();
    let relative = read_local_file(text(root), "README.md").unwrap();
    assert_eq!(relative.path, "README.md");
    assert_eq!(relative.decoded.text.as_deref(), Some("hello"));
    assert!(!relative.decoded.binary);
    let absolute = read_local_file(text(root), text(&outside)).unwrap();
    assert_eq!(absolute.decoded.text.as_deref(), Some("outside"));
    assert!(!absolute.decoded.binary);
    assert!(absolute.path.ends_with(&format!("/{outside_name}")));
    fs::remove_file(&outside).unwrap();
}

#[test]
fn a_file_that_is_not_there_is_said_plainly_not_as_the_system_s_enoent() {
    let dir = temp();
    let root = dir.path();
    // Another repository's file, its checkout gone: by its absolute path.
    let elsewhere = root
        .join("..")
        .join(format!("gone-{}", std::process::id()))
        .join("rfcs")
        .join("a.md");
    let absolute = read_local_file(text(root), text(&elsewhere))
        .unwrap_err()
        .message;
    assert_eq!(
        absolute,
        format!(
            "{} was not found: no such file on this host (or its repository is not checked out at this path).",
            elsewhere.display()
        )
    );
    assert!(!absolute.contains("ENOENT"));
    let relative = read_local_file(text(root), "rfcs/a.md")
        .unwrap_err()
        .message;
    assert!(
        relative.starts_with("rfcs/a.md is not in this checkout ("),
        "{relative}"
    );
}

#[test]
fn reads_directory_previews_instead_of_rejecting_them() {
    let dir = temp();
    let root = dir.path();
    fs::create_dir_all(root.join("src").join("app")).unwrap();
    let relative = read_local_file(text(root), "src/app").unwrap();
    assert_eq!(relative.kind.as_deref(), Some("directory"));
    assert_eq!(relative.path, "src/app");
    assert_eq!(relative.decoded.text, None);
    assert!(!relative.decoded.binary);
    assert_eq!(relative.size, 0);
    assert!(!relative.truncated);
    let absolute = read_local_file(text(root), text(&root.join("src"))).unwrap();
    assert_eq!(absolute.kind.as_deref(), Some("directory"));
    assert!(absolute.path.ends_with("/src"));
}

#[test]
fn resolves_files_and_directories_without_allowing_relative_or_symlink_escapes() {
    let dir = temp();
    let root = dir.path();
    fs::create_dir_all(root.join("a").join("b")).unwrap();
    fs::write(root.join("a").join("b").join("c.png"), "image").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join(".."), root.join("outside")).unwrap();
    let ab = text(&root.join("a").join("b")).to_owned();
    let up = text(&crate::file_types::resolve(root, "..")).to_owned();
    let asked: Vec<String> = [
        "a/b/c.png",
        "a/b",
        "missing/file.png",
        "../outside.txt",
        "..",
        "outside",
        &ab,
        &up,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    assert_eq!(
        resolve_local_file_paths(text(root), &asked).unwrap(),
        ["a/b/c.png", "a/b", ab.as_str(), up.as_str()]
    );
}

#[tokio::test]
async fn uploads_overwrites_downloads_and_deletes_files() {
    let dir = temp();
    let root = text(dir.path()).to_owned();
    let first = upload_local_file(&root, "", "notes.txt", b"one").unwrap();
    assert_eq!(
        first,
        FileUploadResult {
            path: "notes.txt".into(),
            size: 3,
            overwritten: false
        }
    );
    let second = upload_local_file(&root, "", "notes.txt", b"two").unwrap();
    assert!(second.overwritten);
    let download = download_local_file(&root, "notes.txt", &FileDownloadOptions::default())
        .await
        .unwrap();
    assert_eq!(download.filename, "notes.txt");
    assert_eq!(download.path, "notes.txt");
    assert_eq!(download.size, 3);
    assert_eq!(download.content_type, "application/octet-stream");
    assert_eq!(download.body.collect().await.unwrap(), b"two");
    assert_eq!(
        delete_local_file(&root, "notes.txt").unwrap(),
        FileDeleteResult {
            path: "notes.txt".into(),
            kind: "file".into()
        }
    );
}

#[test]
fn rejects_traversal_for_local_relative_operations() {
    let dir = temp();
    let root = text(dir.path());
    assert_eq!(
        list_local_files(root, "..", false, false)
            .unwrap_err()
            .message,
        "file explorer path escaped the workspace checkout"
    );
    assert_eq!(
        upload_local_file(root, "..", "x", b"").unwrap_err().message,
        "file explorer path escaped the workspace checkout"
    );
}

#[test]
fn a_file_s_stat_gives_what_its_read_gave_and_stays_in_the_checkout() {
    let dir = temp();
    let root = text(dir.path());
    fs::write(dir.path().join("notes.md"), "# Notes\n").unwrap();
    let read = read_local_file(root, "notes.md").unwrap();
    assert_eq!(
        stat_local_file(root, "notes.md").unwrap(),
        FileStatResult {
            kind: "file".into(),
            size: read.size,
            mtime_ms: read.mtime_ms
        }
    );
    fs::write(dir.path().join("notes.md"), "# Notes, longer now\n").unwrap();
    assert_ne!(stat_local_file(root, "notes.md").unwrap().size, read.size);
    assert!(stat_local_file(root, "../outside.md").is_err());
}
