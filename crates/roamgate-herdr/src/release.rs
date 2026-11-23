//! The Herdr release Roamgate installs (herdr/release): one verified version
//! with its SHA-256 per asset, where the managed binary goes, and its
//! install through the shared download-verify-install module.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use roamgate_exec::install::{Staging, publish_executable, sha256_file};
use roamgate_exec::service::{RunCommand, powershell_literal};

use crate::BoxFuture;

/// Roamgate only installs this exact Herdr build. The SHA-256 values were
/// recorded from https://herdr.dev/latest.json when this version was
/// verified, so a replaced or tampered release asset fails verification
/// instead of installing. Bump the version and checksums together after
/// verifying a new Herdr release against the supported protocol range
/// ([`crate::protocol`]).
pub const VERIFIED_HERDR_VERSION: &str = "0.9.4";
pub const VERIFIED_HERDR_PROTOCOL: u32 = 22;

/// The published assets, with their pinned checksums.
pub const VERIFIED_HERDR_SHA256: [(&str, &str); 5] = [
    (
        "linux-x86_64",
        "493304fbefb0ed0ea0455f373b47f48d24e8774bc7974f4c916ad2e937675b23",
    ),
    (
        "linux-aarch64",
        "9511cb70982c1ef115f232058e7ed7cf9640aa5a2c0ca78934cefda3aeb093fd",
    ),
    (
        "macos-x86_64",
        "2015ca1de3e93b84cdcccbfd94fbbd65dd56338cea4d3e57a8660e977a3bd700",
    ),
    (
        "macos-aarch64",
        "ea20bfff9cb8c83a996081c926e6ff9370de8e543baa859bca48d19175d895ff",
    ),
    (
        "windows-x86_64",
        "0e4ccb5cd7b6ca464a69637cda66d3c93334ebc057c50c5878b8e89e1a20afee",
    ),
];

/// The release target of a Node platform and architecture, when one is
/// published.
pub fn resolve_herdr_release_target(platform: &str, arch: &str) -> Option<&'static str> {
    let os = match platform {
        "linux" => "linux",
        "darwin" => "macos",
        "win32" => "windows",
        _ => return None,
    };
    let cpu = match arch {
        "x64" => "x86_64",
        "arm64" => "aarch64",
        _ => return None,
    };
    let candidate = format!("{os}-{cpu}");
    VERIFIED_HERDR_SHA256
        .iter()
        .find(|(target, _)| *target == candidate)
        .map(|(target, _)| *target)
}

/// The pinned checksum of a target.
pub fn verified_sha256(target: &str) -> Option<&'static str> {
    VERIFIED_HERDR_SHA256
        .iter()
        .find(|(name, _)| *name == target)
        .map(|(_, sha)| *sha)
}

/// Windows ships a zip (herdr.exe and conpty/); Unix a raw binary.
pub fn herdr_release_asset_name(target: &str) -> String {
    let base = format!("herdr-{target}");
    if target.starts_with("windows") {
        format!("{base}.zip")
    } else {
        base
    }
}

pub fn herdr_release_url(target: &str, version: &str) -> String {
    format!(
        "https://github.com/herdrdev/herdr/releases/download/v{version}/{}",
        herdr_release_asset_name(target)
    )
}

/// Where the managed Herdr goes: the official Unix installer's location
/// (~/.local/bin, a binary `herdr update` can replace in place), or
/// Roamgate's own directory on Windows (Herdr's junctioned release store
/// is not reimplemented).
pub fn herdr_install_root(home: &Path, app_data: Option<&Path>, platform: &str) -> PathBuf {
    if platform == "win32" {
        return app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("roamgate")
            .join("herdr");
    }
    home.join(".local").join("bin")
}

pub fn herdr_managed_binary_path(
    home: &Path,
    app_data: Option<&Path>,
    platform: &str,
    version: &str,
) -> PathBuf {
    let base = herdr_install_root(home, app_data, platform);
    if platform != "win32" {
        return base.join("herdr");
    }
    base.join(version).join("herdr.exe")
}

/// Downloads `url` to the path given.
pub type Download = Arc<dyn Fn(String, PathBuf) -> BoxFuture<Result<(), String>> + Send + Sync>;

/// The download the install uses by default: the shared module's, 120 s.
pub fn default_download(runner: roamgate_exec::process::ProcessRunner) -> Download {
    Arc::new(move |url, destination| {
        let runner = runner.clone();
        Box::pin(async move {
            roamgate_exec::install::download(
                &runner,
                &url,
                &destination,
                Duration::from_secs(120),
                "Herdr",
            )
            .await
        })
    })
}

/// What [`install_verified_herdr`] works with.
pub struct InstallHerdr {
    pub platform: String,
    pub arch: String,
    pub home: PathBuf,
    pub app_data: Option<PathBuf>,
    pub download: Download,
    pub run: Arc<dyn RunCommand>,
    /// Tests only; installs always use the verified table.
    pub expected_sha256: Option<String>,
}

/// What an install did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub binary_path: PathBuf,
    pub version: String,
    pub installed: bool,
}

/// Downloads the verified release into the managed directory and returns
/// the binary's path. Idempotent: an existing managed binary is kept.
pub async fn install_verified_herdr(deps: &InstallHerdr) -> Result<Installed, String> {
    let Some(target) = resolve_herdr_release_target(&deps.platform, &deps.arch) else {
        return Err(format!(
            "no verified Herdr {VERIFIED_HERDR_VERSION} release for {}-{}",
            deps.platform, deps.arch
        ));
    };
    let binary_path = herdr_managed_binary_path(
        &deps.home,
        deps.app_data.as_deref(),
        &deps.platform,
        VERIFIED_HERDR_VERSION,
    );
    if binary_path.exists() {
        return Ok(Installed {
            binary_path,
            version: VERIFIED_HERDR_VERSION.into(),
            installed: false,
        });
    }
    let windows = deps.platform == "win32";
    let install_root = herdr_install_root(&deps.home, deps.app_data.as_deref(), &deps.platform);
    let install_dir = if windows {
        install_root.join(VERIFIED_HERDR_VERSION)
    } else {
        install_root.clone()
    };
    // Staged inside the install root so the final renames stay on one
    // filesystem; removed whatever happens.
    let staging = Staging::new(&install_root).map_err(|error| error.to_string())?;
    let archive = staging.path().join(herdr_release_asset_name(target));
    (deps.download)(
        herdr_release_url(target, VERIFIED_HERDR_VERSION),
        archive.clone(),
    )
    .await?;
    let actual = sha256_file(&archive).map_err(|error| error.to_string())?;
    let expected = deps
        .expected_sha256
        .clone()
        .unwrap_or_else(|| verified_sha256(target).unwrap_or_default().to_owned());
    if actual != expected {
        return Err("downloaded Herdr checksum does not match the verified release".into());
    }
    if windows {
        let extract = staging.path().join("extracted");
        let command = format!(
            "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
            powershell_literal(&archive.display().to_string()),
            powershell_literal(&extract.display().to_string())
        );
        let run = deps.run.clone();
        let argv = vec![
            "powershell.exe".to_owned(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            command,
        ];
        let code = tokio::task::spawn_blocking(move || run.run(&argv, false))
            .await
            .unwrap_or(1);
        if code != 0 {
            return Err("could not extract the downloaded Herdr archive".into());
        }
        if !extract.join("herdr.exe").exists() {
            return Err("downloaded Herdr archive does not contain herdr.exe".into());
        }
        // The complete layout (herdr.exe, conpty/, notices) at once.
        std::fs::rename(&extract, &install_dir).map_err(|error| error.to_string())?;
    } else {
        publish_executable(&archive, &binary_path).map_err(|error| error.to_string())?;
    }
    drop(staging);
    Ok(Installed {
        binary_path,
        version: VERIFIED_HERDR_VERSION.into(),
        installed: true,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use roamgate_exec::service::fake::Recorder;
    use sha2::{Digest, Sha256};

    use super::*;

    fn sha(content: &str) -> String {
        hex::encode(Sha256::digest(content.as_bytes()))
    }

    fn writing(content: &'static str, urls: Arc<Mutex<Vec<String>>>) -> Download {
        Arc::new(move |url, path| {
            urls.lock().unwrap().push(url);
            Box::pin(async move {
                std::fs::write(path, content).unwrap();
                Ok(())
            })
        })
    }

    fn deps(platform: &str, arch: &str, home: &Path, download: Download) -> InstallHerdr {
        InstallHerdr {
            platform: platform.into(),
            arch: arch.into(),
            home: home.into(),
            app_data: None,
            download,
            run: Arc::new(Recorder::new(|_| 0)),
            expected_sha256: None,
        }
    }

    #[test]
    fn maps_supported_platforms_to_published_assets() {
        assert_eq!(
            resolve_herdr_release_target("linux", "x64"),
            Some("linux-x86_64")
        );
        assert_eq!(
            resolve_herdr_release_target("linux", "arm64"),
            Some("linux-aarch64")
        );
        assert_eq!(
            resolve_herdr_release_target("darwin", "x64"),
            Some("macos-x86_64")
        );
        assert_eq!(
            resolve_herdr_release_target("darwin", "arm64"),
            Some("macos-aarch64")
        );
        assert_eq!(
            resolve_herdr_release_target("win32", "x64"),
            Some("windows-x86_64")
        );
    }

    #[test]
    fn rejects_platforms_without_a_verified_asset() {
        assert_eq!(resolve_herdr_release_target("win32", "arm64"), None);
        assert_eq!(resolve_herdr_release_target("freebsd", "x64"), None);
        assert_eq!(resolve_herdr_release_target("linux", "ia32"), None);
    }

    #[test]
    fn pins_a_checksum_for_every_published_asset() {
        for (target, sha) in VERIFIED_HERDR_SHA256 {
            assert!(
                sha.len() == 64
                    && sha
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
                "{target}"
            );
        }
        assert_eq!(VERIFIED_HERDR_SHA256.len(), 5);
    }

    #[test]
    fn builds_github_release_urls_for_the_verified_version() {
        assert_eq!(
            herdr_release_asset_name("macos-aarch64"),
            "herdr-macos-aarch64"
        );
        assert_eq!(
            herdr_release_asset_name("windows-x86_64"),
            "herdr-windows-x86_64.zip"
        );
        assert_eq!(
            herdr_release_url("linux-x86_64", VERIFIED_HERDR_VERSION),
            format!(
                "https://github.com/herdrdev/herdr/releases/download/v{VERIFIED_HERDR_VERSION}/herdr-linux-x86_64"
            )
        );
    }

    #[tokio::test]
    async fn rejects_unsupported_platforms_before_downloading() {
        let home = tempfile::tempdir().unwrap();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let error = install_verified_herdr(&deps(
            "freebsd",
            "x64",
            home.path(),
            writing("x", urls.clone()),
        ))
        .await
        .unwrap_err();
        assert!(error.contains("no verified Herdr"), "{error}");
        assert!(urls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn keeps_an_existing_managed_binary_without_downloading() {
        let home = tempfile::tempdir().unwrap();
        let binary = herdr_managed_binary_path(home.path(), None, "linux", VERIFIED_HERDR_VERSION);
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, "already-here").unwrap();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let result = install_verified_herdr(&deps(
            "linux",
            "x64",
            home.path(),
            writing("x", urls.clone()),
        ))
        .await
        .unwrap();
        assert_eq!(
            result,
            Installed {
                binary_path: binary,
                version: VERIFIED_HERDR_VERSION.into(),
                installed: false
            }
        );
        assert!(urls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn downloads_the_verified_asset_and_installs_it_executable() {
        let home = tempfile::tempdir().unwrap();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let mut deps = deps(
            "linux",
            "x64",
            home.path(),
            writing("fake-herdr-binary", urls.clone()),
        );
        deps.expected_sha256 = Some(sha("fake-herdr-binary"));
        let result = install_verified_herdr(&deps).await.unwrap();
        assert_eq!(
            urls.lock().unwrap()[0],
            format!(
                "https://github.com/herdrdev/herdr/releases/download/v{VERIFIED_HERDR_VERSION}/herdr-linux-x86_64"
            )
        );
        assert!(result.installed);
        assert_eq!(
            std::fs::read_to_string(&result.binary_path).unwrap(),
            "fake-herdr-binary"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&result.binary_path)
                .unwrap()
                .permissions()
                .mode();
            assert_ne!(mode & 0o111, 0);
        }
    }

    #[tokio::test]
    async fn refuses_a_download_whose_checksum_does_not_match() {
        let home = tempfile::tempdir().unwrap();
        let urls = Arc::new(Mutex::new(Vec::new()));
        let error = install_verified_herdr(&deps(
            "darwin",
            "arm64",
            home.path(),
            writing("tampered", urls),
        ))
        .await
        .unwrap_err();
        assert!(error.contains("checksum does not match"), "{error}");
        assert!(
            !herdr_managed_binary_path(home.path(), None, "darwin", VERIFIED_HERDR_VERSION)
                .exists()
        );
        // No staging left behind.
        let root = herdr_install_root(home.path(), None, "darwin");
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }

    /// Emulates Expand-Archive: materialises the zip layout at the
    /// command's `-DestinationPath`.
    fn expand(argv: &[String], with_exe: bool) -> bool {
        let command = argv.last().unwrap();
        let Some(start) = command.find("-DestinationPath '") else {
            return false;
        };
        let rest = &command[start + "-DestinationPath '".len()..];
        let destination = PathBuf::from(&rest[..rest.find('\'').unwrap()]);
        std::fs::create_dir_all(destination.join("conpty")).unwrap();
        std::fs::write(destination.join("conpty").join("conpty.dll"), "dll").unwrap();
        if with_exe {
            std::fs::write(destination.join("herdr.exe"), "exe").unwrap();
        }
        std::fs::create_dir_all(destination.join("THIRD-PARTY-NOTICES")).unwrap();
        std::fs::write(
            destination.join("THIRD-PARTY-NOTICES").join("notice.txt"),
            "notice",
        )
        .unwrap();
        true
    }

    #[tokio::test]
    async fn extracts_the_windows_zip_layout_via_powershell() {
        let home = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let previous =
            herdr_managed_binary_path(home.path(), Some(app_data.path()), "win32", "0.9.0");
        std::fs::create_dir_all(previous.parent().unwrap()).unwrap();
        std::fs::write(&previous, "previous-herdr").unwrap();
        let binary = herdr_managed_binary_path(
            home.path(),
            Some(app_data.path()),
            "win32",
            VERIFIED_HERDR_VERSION,
        );
        let install_dir = binary.parent().unwrap().to_path_buf();
        let seen_dir = install_dir.clone();
        let recorder = Arc::new(Recorder::new(move |argv| {
            assert!(!seen_dir.exists());
            if expand(argv, true) { 0 } else { 1 }
        }));
        let urls = Arc::new(Mutex::new(Vec::new()));
        let mut deps = deps("win32", "x64", home.path(), writing("fake-zip", urls));
        deps.app_data = Some(app_data.path().into());
        deps.expected_sha256 = Some(sha("fake-zip"));
        deps.run = recorder.clone();
        let result = install_verified_herdr(&deps).await.unwrap();
        let commands = recorder.argvs();
        assert_eq!(commands.len(), 1);
        assert!(commands[0].join(" ").contains("Expand-Archive"));
        assert!(result.installed);
        assert_eq!(
            result.binary_path,
            app_data
                .path()
                .join("roamgate")
                .join("herdr")
                .join("0.9.4")
                .join("herdr.exe")
        );
        assert_eq!(
            std::fs::read_to_string(&previous).unwrap(),
            "previous-herdr"
        );
        assert!(install_dir.join("conpty").join("conpty.dll").exists());
        assert_eq!(std::fs::read_to_string(&result.binary_path).unwrap(), "exe");
        assert_eq!(
            std::fs::read_to_string(install_dir.join("THIRD-PARTY-NOTICES").join("notice.txt"))
                .unwrap(),
            "notice"
        );
    }

    /// `Windows ${failure} failure leaves no partial installation and can retry`.
    #[tokio::test]
    async fn windows_failure_leaves_no_partial_installation_and_can_retry() {
        for failure in ["extraction", "missing-executable", "publication"] {
            let home = tempfile::tempdir().unwrap();
            let app_data = tempfile::tempdir().unwrap();
            let binary = herdr_managed_binary_path(
                home.path(),
                Some(app_data.path()),
                "win32",
                VERIFIED_HERDR_VERSION,
            );
            let install_dir = binary.parent().unwrap().to_path_buf();
            if failure == "publication" {
                std::fs::create_dir_all(&install_dir).unwrap();
                std::fs::write(install_dir.join("keep.txt"), "existing contents").unwrap();
            }
            let fail = Arc::new(AtomicUsize::new(1));
            let failing = fail.clone();
            let recorder = Arc::new(Recorder::new(move |argv| {
                let failing = failing.load(Ordering::SeqCst) == 1;
                expand(argv, !failing || failure != "missing-executable");
                if failing && failure == "extraction" {
                    1
                } else {
                    0
                }
            }));
            let urls = Arc::new(Mutex::new(Vec::new()));
            let mut deps = deps("win32", "x64", home.path(), writing("fake-zip", urls));
            deps.app_data = Some(app_data.path().into());
            deps.expected_sha256 = Some(sha("fake-zip"));
            deps.run = recorder;
            assert!(install_verified_herdr(&deps).await.is_err(), "{failure}");
            assert!(!binary.exists(), "{failure}");
            let staging: Vec<_> = std::fs::read_dir(install_dir.parent().unwrap())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(".staging-"))
                .collect();
            assert!(staging.is_empty(), "{failure}");
            if failure == "publication" {
                let names: Vec<_> = std::fs::read_dir(&install_dir)
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                assert_eq!(names, ["keep.txt"]);
                std::fs::remove_dir_all(&install_dir).unwrap();
            } else {
                assert!(!install_dir.exists(), "{failure}");
            }
            fail.store(0, Ordering::SeqCst);
            assert!(install_verified_herdr(&deps).await.unwrap().installed);
            assert_eq!(std::fs::read_to_string(&binary).unwrap(), "exe");
            assert_eq!(
                std::fs::read_to_string(install_dir.join("conpty").join("conpty.dll")).unwrap(),
                "dll"
            );
        }
    }
}
