//! remote-files.test.ts: the remote scripts run here by `bash -c`, as on
//! an SSH host; the parsers' cases are contract/vectors/remote-files.json.

// Their helpers serve tests that need Unix (sockets, modes, symlinks, sh).
#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use std::fs;
use std::path::Path;

use roamgate_protocol::vectors;
use serde_json::{Value, json};

use super::*;
#[cfg(unix)]
use crate::file_types::resolve;
use crate::test_support::{Loopback, LoopbackStreams};

const HOST: &str = "example.invalid";

/// Under the temporary directory's real path: macOS's is under a link
/// (/var to /private/var), and the server answers real paths.
fn temp(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap()
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn loopback() -> (GitContext, Arc<Loopback>) {
    let runner = Loopback::new();
    (GitContext::new(Some(HOST.into()), runner.clone()), runner)
}

#[tokio::test]
async fn remote_image_reads_support_each_type_within_preview_byte_limits() {
    for (extension, mime) in [
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
    ] {
        let dir = temp("roamgate-image-preview-");
        let bytes = vec![65u8; 600 * 1024];
        let path = format!("image.{}", extension.to_uppercase());
        fs::write(dir.path().join(&path), &bytes).unwrap();
        let (cx, _) = loopback();
        let result = read_remote_file(&cx, HOST, text(dir.path()), &path)
            .await
            .unwrap();
        assert!(!result.truncated, "{extension}");
        assert_eq!(result.decoded.mime_type.as_deref(), Some(mime));
        let url = result.decoded.image_data_url.unwrap();
        assert_eq!(node_base64(url.split(',').nth(1).unwrap()), bytes);
    }
}

#[tokio::test]
async fn remote_downloads_refuse_a_file_over_max_bytes_before_sending_it() {
    let dir = temp("roamgate-download-max-");
    fs::write(dir.path().join("small.glb"), vec![1u8; 1000]).unwrap();
    fs::write(dir.path().join("big.glb"), vec![2u8; 1001]).unwrap();
    let options = FileDownloadOptions {
        max_bytes: Some(1000),
        ..Default::default()
    };
    let (cx, runner) = loopback();
    let small = download_remote_file(&cx, HOST, text(dir.path()), "small.glb", &options, None)
        .await
        .unwrap();
    assert_eq!(small.size, 1000);
    assert_eq!(small.body.collect().await.unwrap(), vec![1u8; 1000]);
    runner.outputs.lock().unwrap().clear();
    let refused = download_remote_file(&cx, HOST, text(dir.path()), "big.glb", &options, None)
        .await
        .unwrap_err();
    let DownloadFailure::Refused(refused) = refused else {
        panic!("{refused}");
    };
    assert_eq!(refused.status, 413);
    assert_eq!(refused.size, Some(1001));
    assert_eq!(*runner.outputs.lock().unwrap(), [0]);
}

#[tokio::test]
async fn a_remote_file_that_changes_size_while_it_is_sent_is_never_sent_short_or_long() {
    let dir = temp("roamgate-download-stream-");
    let apk = dir.path().join("app.apk");
    fs::write(&apk, vec![1u8; 1000]).unwrap();
    let (cx, _) = loopback();
    let read = |rewrite: Vec<u8>| {
        let apk = apk.clone();
        // Rebuilt between its metadata and its bytes.
        let streams: Arc<dyn StreamProcess> =
            LoopbackStreams::new(move || fs::write(&apk, &rewrite).unwrap());
        let cx = cx.clone();
        let root = text(dir.path()).to_owned();
        async move {
            let download = download_remote_file(
                &cx,
                HOST,
                &root,
                "app.apk",
                &FileDownloadOptions::default(),
                Some(&streams),
            )
            .await
            .map_err(|error| error.to_string())?;
            let size = download.size;
            download.body.collect().await.map(|body| (size, body))
        }
    };
    let (size, body) = read(vec![2u8; 1000]).await.unwrap();
    assert_eq!(size, 1000);
    assert_eq!(body, vec![2u8; 1000]);
    fs::write(&apk, vec![1u8; 1000]).unwrap();
    assert_eq!(
        read(vec![3u8; 2000]).await.unwrap_err(),
        "File changed during download"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn remote_resolution_includes_directories_but_rejects_relative_and_symlink_escapes() {
    let dir = temp("herdr-gui-resolve-");
    let root = dir.path();
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("docs").join("guide.md"), "guide").unwrap();
    std::os::unix::fs::symlink(root.join(".."), root.join("outside")).unwrap();
    let docs = text(&root.join("docs")).to_owned();
    let up = text(&resolve(root, "..")).to_owned();
    let asked: Vec<String> = [
        "docs/guide.md",
        "docs",
        &docs,
        "missing",
        "..",
        "outside",
        &up,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    let (cx, _) = loopback();
    assert_eq!(
        resolve_remote_file_paths(&cx, HOST, text(root), &asked)
            .await
            .unwrap(),
        ["docs/guide.md", "docs", docs.as_str(), up.as_str()]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_sibling_checkout_s_page_reads_and_downloads_by_its_path_with_macos_s_base64() {
    let top = temp("roamgate-sibling-");
    let here = top.path().join("instalador");
    let sibling = top.path().join("planos-3d");
    fs::create_dir_all(&here).unwrap();
    fs::create_dir_all(sibling.join("out")).unwrap();
    let page = "<!doctype html><title>casa</title>";
    fs::write(sibling.join("out").join("casa.html"), page).unwrap();
    // macOS's base64 takes no file operand (only -i or stdin).
    let shims = top.path().join("bin");
    fs::create_dir(&shims).unwrap();
    let real = which("base64");
    fs::write(
        shims.join("base64"),
        format!(
            "#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in -*) ;; *) echo \"base64: invalid argument $a\" >&2; exit 64 ;; esac; done\nexec {real} \"$@\"\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(shims.join("base64"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        shims.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let runner = Loopback::with_env(|c| c.to_owned(), vec![("PATH".into(), path)]);
    let cx = GitContext::new(Some(HOST.into()), runner);
    // file.read in another workspace: the absolute path, not one under it.
    let file = text(&sibling.join("out").join("casa.html")).to_owned();
    let preview = read_remote_file(&cx, HOST, text(&here), &file)
        .await
        .unwrap();
    assert_eq!(preview.path, file);
    assert_eq!(preview.decoded.text.as_deref(), Some(page));
    // The rendered page reads it from its own root.
    let download = download_remote_file(
        &cx,
        HOST,
        text(&sibling),
        "out/casa.html",
        &FileDownloadOptions {
            max_bytes: Some(1024),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(download.body.collect().await.unwrap(), page.as_bytes());
}

fn which(program: &str) -> String {
    let out = std::process::Command::new("sh")
        .args(["-c", &format!("command -v {program}")])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
async fn a_file_s_stat_on_the_host_compares_with_what_its_read_gave_and_stays_in_the_checkout() {
    let dir = temp("roamgate-remote-stat-");
    let root = text(dir.path());
    let (cx, _) = loopback();
    fs::write(dir.path().join("notes.md"), "# Notes\n").unwrap();
    let read = read_remote_file(&cx, HOST, root, "notes.md").await.unwrap();
    let stat = stat_remote_file(&cx, HOST, root, "notes.md").await.unwrap();
    assert_eq!(
        stat,
        FileStatResult {
            kind: "file".into(),
            size: read.size,
            mtime_ms: read.mtime_ms
        }
    );
    fs::write(dir.path().join("notes.md"), "# Notes, longer now\n").unwrap();
    let after = stat_remote_file(&cx, HOST, root, "notes.md").await.unwrap();
    assert_ne!(after.size, read.size);
    assert!(
        stat_remote_file(&cx, HOST, root, "../outside.md")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_file_not_on_the_host_is_said_plainly_not_as_realpath_s_error() {
    let dir = temp("roamgate-remote-missing-");
    let missing = format!(
        "{}/../gone-{}/rfcs/a.md",
        dir.path().display(),
        std::process::id()
    );
    let (cx, _) = loopback();
    let message = read_remote_file(&cx, HOST, text(dir.path()), &missing)
        .await
        .unwrap_err()
        .message;
    assert_eq!(
        message,
        format!(
            "{missing} was not found: no such file on this host (or its repository is not checked out at this path)."
        )
    );
}

fn as_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn download_json(download: &RemoteDownload) -> Value {
    json!({
        "filename": download.filename,
        "path": download.path,
        "size": download.size,
        "body": {"$buffer": download.body.iter().map(|b| format!("{b:02x}")).collect::<String>()},
        "contentType": download.content_type,
    })
}

/// The parsers' cases, shared with remote-files.test.ts.
#[test]
fn replays_the_remote_files_vectors() {
    let file = vectors::load("remote-files");
    for case in &file.cases {
        for call in &case.calls {
            let arg = |at: usize| vectors::text(&call.args[at]).unwrap();
            let got: Result<Value, WorkspaceError> = match call.target().as_str() {
                "remote-files.parseRemoteFileList" => {
                    Ok(as_json(&parse_remote_file_list(&arg(0), &arg(1))))
                }
                "remote-files.parseRemoteFilePreview" => {
                    parse_remote_file_preview(&arg(0), &arg(1)).map(|r| as_json(&r))
                }
                "remote-files.parseRemoteFileResolutions" => {
                    Ok(as_json(&parse_remote_file_resolutions(&arg(0))))
                }
                "remote-files.parseRemoteFileDownload" => {
                    parse_remote_file_download(&arg(0), &arg(1)).map(|d| download_json(&d))
                }
                "remote-files.parseRemoteFileUpload" => {
                    parse_remote_file_upload(&arg(0)).map(|r| as_json(&r))
                }
                "remote-files.parseRemoteFileDelete" => {
                    parse_remote_file_delete(&arg(0)).map(|r| as_json(&r))
                }
                "remote-files.parseRemoteFileStat" => {
                    parse_remote_file_stat(&arg(0)).map(|r| as_json(&r))
                }
                other => panic!("{}: unknown call {other}", case.title()),
            };
            match (&call.throws, got) {
                (Some(message), Err(error)) => {
                    assert_eq!(&error.message, message, "{}", case.title())
                }
                (None, Ok(value)) => {
                    assert_eq!(Some(&value), call.result.as_ref(), "{}", case.title())
                }
                (want, got) => panic!("{}: wanted {want:?}, got {got:?}", case.title()),
            }
        }
    }
}
