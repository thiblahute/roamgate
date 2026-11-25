use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::download::FetchResponse;

fn manifest(platform: &str, version: &str, cuda: bool) -> Value {
    let mut value = json!({
        "schema": 1, "name": "roamgate-voice", "version": version, "platform": platform,
        "helper": {"archive": archive_name(platform), "size": 10, "sha256": "A".repeat(64)},
    });
    if cuda {
        value["cuda"] =
            json!({"archive": cuda_archive_name(platform), "size": 20, "sha256": "b".repeat(64)});
    }
    value
}

#[test]
fn names_the_platforms_releases_carry_a_helper_for() {
    assert_eq!(
        helper_platform("linux", "x64").as_deref(),
        Some("linux-x64")
    );
    assert_eq!(
        helper_platform("linux", "arm64").as_deref(),
        Some("linux-arm64")
    );
    assert_eq!(
        helper_platform("darwin", "arm64").as_deref(),
        Some("darwin-arm64")
    );
    assert_eq!(
        helper_platform("win32", "x64").as_deref(),
        Some("windows-x64")
    );
    assert_eq!(helper_platform("darwin", "x64"), None);
    assert_eq!(helper_platform("win32", "arm64"), None);
    assert_eq!(manifest_name("linux-x64"), "roamgate-voice-linux-x64.json");
    assert_eq!(archive_name("linux-x64"), "roamgate-voice-linux-x64.tar.xz");
    assert_eq!(
        cuda_archive_name("linux-x64"),
        "roamgate-voice-cuda-linux-x64.tar.xz"
    );
}

#[test]
fn parses_a_manifest_of_this_platform_and_version() {
    let parsed = parse_helper_manifest(
        &manifest("linux-x64", "0.9.0", true).to_string(),
        "linux-x64",
        "0.9.0",
    );
    assert_eq!(
        parsed,
        Ok(HelperManifest {
            version: "0.9.0".into(),
            platform: "linux-x64".into(),
            helper: HelperAsset {
                archive: "roamgate-voice-linux-x64.tar.xz".into(),
                size: 10.0,
                sha256: "a".repeat(64),
            },
            cuda: Some(HelperAsset {
                archive: "roamgate-voice-cuda-linux-x64.tar.xz".into(),
                size: 20.0,
                sha256: "b".repeat(64),
            }),
        })
    );
    let no_cuda = parse_helper_manifest(
        &manifest("darwin-arm64", "0.9.0", false).to_string(),
        "darwin-arm64",
        "0.9.0",
    );
    assert_eq!(no_cuda.unwrap().cuda, None);
}

#[test]
fn refuses_another_platform_version_or_a_bad_asset() {
    let text = manifest("linux-x64", "0.9.0", false).to_string();
    assert_eq!(
        parse_helper_manifest(&text, "linux-arm64", "0.9.0"),
        Err("the voice helper manifest is for linux-x64, not linux-arm64".into())
    );
    assert_eq!(
        parse_helper_manifest(&text, "linux-x64", "0.9.1"),
        Err("the voice helper manifest is version 0.9.0, not 0.9.1".into())
    );
    let mut renamed = manifest("linux-x64", "0.9.0", false);
    renamed["helper"]["archive"] = json!("../roamgate-voice-linux-x64.tar.xz");
    let mut short_sum = manifest("linux-x64", "0.9.0", false);
    short_sum["helper"]["sha256"] = json!("abc");
    let mut bad_cuda = manifest("linux-x64", "0.9.0", true);
    bad_cuda["cuda"]["size"] = json!(0);
    let mut other_name = manifest("linux-x64", "0.9.0", false);
    other_name["name"] = json!("roamgate");
    for bad in [
        renamed.to_string(),
        short_sum.to_string(),
        bad_cuda.to_string(),
        other_name.to_string(),
        "{}".into(),
        "x".repeat(HELPER_MANIFEST_MAX_BYTES + 1),
    ] {
        assert_eq!(
            parse_helper_manifest(&bad, "linux-x64", "0.9.0"),
            Err("invalid voice helper manifest".into())
        );
    }
}

/// Serves `files` by URL, 404 for the rest, and keeps the URLs asked.
fn serve(files: HashMap<String, Vec<u8>>) -> (Fetch, Arc<Mutex<Vec<String>>>) {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = asked.clone();
    let fetch: Fetch = Arc::new(move |url: String, _range| {
        kept.lock().unwrap().push(url.clone());
        let body = files.get(&url).cloned();
        Box::pin(async move {
            let (sender, receiver) = tokio::sync::mpsc::channel(1);
            let status = match body {
                Some(body) => {
                    sender.send(Ok(body)).await.unwrap();
                    200
                }
                None => 404,
            };
            Ok(FetchResponse {
                status,
                body: receiver,
            })
        })
    });
    (fetch, asked)
}

#[tokio::test]
async fn a_release_without_this_platforms_manifest_has_no_helper() {
    let (fetch, asked) = serve(HashMap::new());
    let found =
        fetch_helper_manifest("https://mirror/v0.9.0", "linux-x64", "0.9.0", Some(&fetch)).await;
    assert_eq!(found, Ok(None));
    assert_eq!(
        *asked.lock().unwrap(),
        ["https://mirror/v0.9.0/roamgate-voice-linux-x64.json"]
    );
}

/// A .tar.xz of `files` (path, content), made with tar.
#[cfg(unix)]
fn tar_xz(files: &[(&str, &str)]) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let tree = dir.path().join("tree");
    for (path, content) in files {
        let path = tree.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    let archive = dir.path().join("a.tar.xz");
    let status = std::process::Command::new("tar")
        .arg("-cJf")
        .arg(&archive)
        .arg("-C")
        .arg(&tree)
        .arg(".")
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::read(archive).unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn installs_the_helper_and_its_cuda_pack_beside_it_checksums_checked() {
    let helper = tar_xz(&[
        ("roamgate-voice", "helper"),
        ("share/espeak-ng-data/phontab", "p"),
    ]);
    let cuda = tar_xz(&[("lib/libggml-cuda.so", "module")]);
    let sum = |bytes: &[u8]| hex::encode(Sha256::digest(bytes));
    let base = "https://mirror/v0.9.0";
    let text = json!({
        "schema": 1, "name": "roamgate-voice", "version": "0.9.0", "platform": "linux-x64",
        "helper": {"archive": archive_name("linux-x64"), "size": helper.len(), "sha256": sum(&helper)},
        "cuda": {"archive": cuda_archive_name("linux-x64"), "size": cuda.len(), "sha256": sum(&cuda)},
    })
    .to_string();
    let (fetch, _) = serve(HashMap::from([
        (
            format!("{base}/roamgate-voice-linux-x64.json"),
            text.into_bytes(),
        ),
        (format!("{base}/roamgate-voice-linux-x64.tar.xz"), helper),
        (format!("{base}/roamgate-voice-cuda-linux-x64.tar.xz"), cuda),
    ]));
    let found = fetch_helper_manifest(base, "linux-x64", "0.9.0", Some(&fetch))
        .await
        .unwrap()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("voice").join("roamgate-voice");
    let options = DownloadOptions {
        fetch: Some(fetch),
        ..Default::default()
    };
    let installed = install_helper_release(base, &found, &path, true, &options).await;
    assert_eq!(
        installed,
        Ok(InstalledHelper {
            helper: path.clone(),
            cuda: true
        })
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "helper");
    let voice = dir.path().join("voice");
    assert!(voice.join("share/espeak-ng-data/phontab").exists());
    assert!(voice.join("lib/libggml-cuda.so").exists());
    assert!(!voice.join(".download").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_wrong_checksum_installs_nothing() {
    let helper = tar_xz(&[("roamgate-voice", "helper")]);
    let base = "https://mirror/v0.9.0";
    let found = HelperManifest {
        version: "0.9.0".into(),
        platform: "linux-x64".into(),
        helper: HelperAsset {
            archive: archive_name("linux-x64"),
            size: helper.len() as f64,
            sha256: "0".repeat(64),
        },
        cuda: None,
    };
    let (fetch, _) = serve(HashMap::from([(
        format!("{base}/roamgate-voice-linux-x64.tar.xz"),
        helper,
    )]));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("roamgate-voice");
    let options = DownloadOptions {
        fetch: Some(fetch),
        attempts: Some(1),
        ..Default::default()
    };
    let installed = install_helper_release(base, &found, &path, false, &options).await;
    assert!(installed.unwrap_err().contains("checksum"));
    assert!(!path.exists());
}
