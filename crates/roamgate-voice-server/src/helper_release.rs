//! The voice helper a release carries, for `roamgate setup voice` to
//! install when this machine has none: per platform, a manifest
//! (`roamgate-voice-<platform>.json`) naming the helper's archive and, where
//! there is one, its CUDA pack, each with its size and SHA-256. The helper's
//! archive holds `roamgate-voice` (`.exe` on Windows) and what it reads at
//! run time (espeak-ng's data in `share/`); the CUDA pack holds `lib/`, the
//! CUDA libraries and Whisper's CUDA module the helper loads when they are
//! there. Both are unpacked into the helper's directory, the checksum
//! checked first. A release without a manifest for this platform has no
//! helper for it.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::download::{
    DownloadError, DownloadOptions, DownloadTarget, Fetch, download_file, http_fetch,
};

/// The most a manifest may weigh.
pub const HELPER_MANIFEST_MAX_BYTES: usize = 4096;

/// The platforms a release may carry a helper for, as its archives name
/// them (targets.toml's `platform`).
pub const HELPER_PLATFORMS: [&str; 4] = ["darwin-arm64", "linux-arm64", "linux-x64", "windows-x64"];

/// This machine's helper platform from Node's platform and architecture
/// names, when releases may carry one for it.
pub fn helper_platform(platform: &str, arch: &str) -> Option<String> {
    let os = if platform == "win32" {
        "windows"
    } else {
        platform
    };
    let candidate = format!("{os}-{arch}");
    HELPER_PLATFORMS
        .contains(&candidate.as_str())
        .then_some(candidate)
}

/// A release asset's name for a platform: `roamgate-voice-linux-x64.json`,
/// `roamgate-voice-linux-x64.tar.xz`, `roamgate-voice-cuda-linux-x64.tar.xz`.
pub fn manifest_name(platform: &str) -> String {
    format!("roamgate-voice-{platform}.json")
}

pub fn archive_name(platform: &str) -> String {
    format!("roamgate-voice-{platform}.tar.xz")
}

pub fn cuda_archive_name(platform: &str) -> String {
    format!("roamgate-voice-cuda-{platform}.tar.xz")
}

/// One archive a manifest names.
#[derive(Debug, Clone, PartialEq)]
pub struct HelperAsset {
    pub archive: String,
    pub size: f64,
    pub sha256: String,
}

/// A release's helper for one platform.
#[derive(Debug, Clone, PartialEq)]
pub struct HelperManifest {
    pub version: String,
    pub platform: String,
    pub helper: HelperAsset,
    pub cuda: Option<HelperAsset>,
}

fn asset(value: &Value, expected: &str) -> Option<HelperAsset> {
    let archive = value.get("archive")?.as_str()?;
    let size = value.get("size")?.as_f64().filter(|size| *size > 0.0)?;
    let sha256 = value.get("sha256")?.as_str()?;
    let hex = sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit());
    (archive == expected && hex).then(|| HelperAsset {
        archive: archive.to_owned(),
        size,
        sha256: sha256.to_ascii_lowercase(),
    })
}

/// Reads a manifest, checking it is this platform's and this version's.
pub fn parse_helper_manifest(
    text: &str,
    platform: &str,
    version: &str,
) -> Result<HelperManifest, String> {
    let invalid = || "invalid voice helper manifest".to_owned();
    if text.len() > HELPER_MANIFEST_MAX_BYTES {
        return Err(invalid());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let string = |name: &str| value.get(name).and_then(Value::as_str);
    if value.get("schema").and_then(Value::as_f64) != Some(1.0)
        || string("name") != Some("roamgate-voice")
    {
        return Err(invalid());
    }
    if string("platform") != Some(platform) {
        return Err(format!(
            "the voice helper manifest is for {}, not {platform}",
            string("platform").unwrap_or("another platform")
        ));
    }
    if string("version") != Some(version) {
        return Err(format!(
            "the voice helper manifest is version {}, not {version}",
            string("version").unwrap_or("unknown")
        ));
    }
    let helper = value
        .get("helper")
        .and_then(|helper| asset(helper, &archive_name(platform)))
        .ok_or_else(invalid)?;
    let cuda = match value.get("cuda") {
        None | Some(Value::Null) => None,
        Some(cuda) => Some(asset(cuda, &cuda_archive_name(platform)).ok_or_else(invalid)?),
    };
    Ok(HelperManifest {
        version: version.to_owned(),
        platform: platform.to_owned(),
        helper,
        cuda,
    })
}

/// Reads a whole small answer; None on 404 (no such asset).
async fn fetch_small(fetch: &Fetch, url: &str) -> Result<Option<String>, String> {
    let mut response = fetch(url.to_owned(), None).await?;
    if response.status == 404 {
        return Ok(None);
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("{url}: HTTP {}", response.status));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.body.recv().await {
        body.extend(chunk?);
        if body.len() > HELPER_MANIFEST_MAX_BYTES {
            return Err(format!(
                "{url}: larger than {HELPER_MANIFEST_MAX_BYTES} bytes"
            ));
        }
    }
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| format!("{url}: not UTF-8"))
}

/// The release's helper for this platform; None when it carries none.
pub async fn fetch_helper_manifest(
    base_url: &str,
    platform: &str,
    version: &str,
    fetch: Option<&Fetch>,
) -> Result<Option<HelperManifest>, String> {
    let fetch = fetch.cloned().unwrap_or_else(http_fetch);
    let url = format!("{base_url}/{}", manifest_name(platform));
    match fetch_small(&fetch, &url).await? {
        None => Ok(None),
        Some(text) => parse_helper_manifest(&text, platform, version).map(Some),
    }
}

/// Unpacks a .tar.xz into a directory with the system's tar (GNU tar, or
/// the bsdtar of macOS and Windows 10 and later).
async fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let output = tokio::process::Command::new("tar")
        .arg("-xJf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .output()
        .await
        .map_err(|error| format!("tar: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "tar could not unpack {}: {}",
            archive.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// Downloads an asset into `<dir>/.download`, its checksum checked, and
/// unpacks it into `dir`.
async fn install_asset(
    base_url: &str,
    asset: &HelperAsset,
    dir: &Path,
    options: &DownloadOptions,
) -> Result<(), String> {
    let path = dir.join(".download").join(&asset.archive);
    let target = DownloadTarget {
        url: format!("{base_url}/{}", asset.archive),
        path: path.clone(),
        size: asset.size,
        sha256: asset.sha256.clone(),
    };
    let options = DownloadOptions {
        verify: true,
        ..options.clone()
    };
    download_file(&target, &options)
        .await
        .map_err(|error: DownloadError| error.to_string())?;
    unpack(&path, dir).await?;
    let _ = tokio::fs::remove_file(&path).await;
    Ok(())
}

/// What was installed.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledHelper {
    pub helper: PathBuf,
    pub cuda: bool,
}

/// Installs a release's helper into the directory of `helper_path`, and its
/// CUDA pack too when `with_cuda` and the release has one.
pub async fn install_helper_release(
    base_url: &str,
    manifest: &HelperManifest,
    helper_path: &Path,
    with_cuda: bool,
    options: &DownloadOptions,
) -> Result<InstalledHelper, String> {
    let dir = helper_path
        .parent()
        .ok_or_else(|| format!("{}: no directory", helper_path.display()))?;
    std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    install_asset(base_url, &manifest.helper, dir, options).await?;
    let cuda = match (&manifest.cuda, with_cuda) {
        (Some(cuda), true) => {
            install_asset(base_url, cuda, dir, options).await?;
            true
        }
        _ => false,
    };
    let _ = std::fs::remove_dir(dir.join(".download"));
    Ok(InstalledHelper {
        helper: helper_path.to_owned(),
        cuda,
    })
}

#[cfg(test)]
mod tests;
