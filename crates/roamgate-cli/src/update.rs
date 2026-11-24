//! Roamgate's releases (http/update): the published update packages, the
//! manifest a release mirror serves per platform, versions, mirrors, the
//! supervisor check, and the contract's shell installer that verifies an
//! archive and replaces the executable in place (keeping
//! `<target>.previous`), shared by `roamgate update` and
//! `/api/update/install` through roamgate-exec's install module.

use std::cmp::Ordering;
use std::sync::Arc;
use std::time::Duration;

use roamgate_base::assets::{TemplateValue, UPDATE_INSTALL_SH, fill_template};
use roamgate_base::env::{Env, roamgate_env};
use roamgate_exec::install::curl_transport_args;
use roamgate_exec::quote::shell_quote;
use serde_json::Value;

use crate::BoxFuture;

pub const DEFAULT_UPDATE_BASE_URL: &str =
    "https://github.com/powerfooI/roamgate/releases/latest/download";
pub const UPDATE_METADATA_MAX_BYTES: usize = 4096;
pub const UPDATE_CHECK_CACHE_MS: i64 = 5 * 60 * 1000;
pub const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_millis(15_000);
pub const UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_millis(120_000);
/// The HTTP idle budget of an update request (the front's).
pub const UPDATE_HTTP_IDLE_TIMEOUT_SECONDS: u64 = (15_000 + 120_000) / 1000 + 15;

const UPDATE_PLATFORMS: [&str; 4] = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateTarget {
    pub platform: String,
    pub package_dir: String,
    pub archive_name: String,
    pub manifest_name: String,
}

pub fn resolve_update_target(platform: &str, arch: &str) -> Option<UpdateTarget> {
    let candidate = format!("{platform}-{arch}");
    UPDATE_PLATFORMS
        .contains(&candidate.as_str())
        .then(|| UpdateTarget {
            package_dir: format!("roamgate-{candidate}"),
            archive_name: format!("roamgate-{candidate}.tar.xz"),
            manifest_name: format!("roamgate-{candidate}.update.json"),
            platform: candidate,
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateManifest {
    pub version: String,
    pub platform: String,
    pub archive: String,
    pub sha256: String,
}

struct ParsedVersion {
    core: Vec<String>,
    prerelease: Option<Vec<String>>,
}

fn parsed_version(value: &str) -> Option<ParsedVersion> {
    let re = regex::Regex::new(
        r"^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
    )
    .unwrap();
    let captures = re.captures(value)?;
    Some(ParsedVersion {
        core: captures[1].split('.').map(str::to_owned).collect(),
        prerelease: captures
            .get(2)
            .map(|pre| pre.as_str().split('.').map(str::to_owned).collect()),
    })
}

/// Compares two decimal strings of any length as numbers.
fn compare_digits(a: &str, b: &str) -> Ordering {
    let a = a.trim_start_matches('0');
    let b = b.trim_start_matches('0');
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

pub fn compare_version(a: &str, b: &str) -> Result<Ordering, String> {
    let (Some(pa), Some(pb)) = (parsed_version(a), parsed_version(b)) else {
        return Err("invalid update version".into());
    };
    for index in 0..pa.core.len().max(pb.core.len()) {
        let va = pa.core.get(index).map(String::as_str).unwrap_or("0");
        let vb = pb.core.get(index).map(String::as_str).unwrap_or("0");
        let order = compare_digits(va, vb);
        if order != Ordering::Equal {
            return Ok(order);
        }
    }
    let (Some(ra), Some(rb)) = (&pa.prerelease, &pb.prerelease) else {
        return Ok(match (&pa.prerelease, &pb.prerelease) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            _ => Ordering::Less,
        });
    };
    for index in 0..ra.len().max(rb.len()) {
        let (Some(va), Some(vb)) = (ra.get(index), rb.get(index)) else {
            return Ok(if ra.get(index).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            });
        };
        if va == vb {
            continue;
        }
        let numeric = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit());
        return Ok(match (numeric(va), numeric(vb)) {
            (true, true) => compare_digits(va, vb),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => va.as_str().cmp(vb.as_str()),
        });
    }
    Ok(Ordering::Equal)
}

pub fn parse_update_manifest(text: &str) -> Result<UpdateManifest, String> {
    let invalid = || "invalid update manifest".to_owned();
    if text.len() > UPDATE_METADATA_MAX_BYTES {
        return Err(invalid());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let Value::Object(manifest) = value else {
        return Err(invalid());
    };
    let string = |name: &str| manifest.get(name).and_then(Value::as_str);
    let platform_re = regex::Regex::new(r"^[a-z0-9]+-[a-z0-9]+$").unwrap();
    let archive_re = regex::Regex::new(r"^roamgate-[a-z0-9-]+\.tar\.xz$").unwrap();
    let sha_re = regex::Regex::new(r"^[0-9a-fA-F]{64}$").unwrap();
    let schema_one = manifest.get("schema").and_then(Value::as_f64) == Some(1.0);
    match (
        string("version"),
        string("platform"),
        string("archive"),
        string("sha256"),
    ) {
        (Some(version), Some(platform), Some(archive), Some(sha256))
            if schema_one
                && string("name") == Some("roamgate")
                && parsed_version(version).is_some()
                && platform_re.is_match(platform)
                && archive_re.is_match(archive)
                && sha_re.is_match(sha256) =>
        {
            Ok(UpdateManifest {
                version: version.into(),
                platform: platform.into(),
                archive: archive.into(),
                sha256: sha256.to_ascii_lowercase(),
            })
        }
        _ => Err(invalid()),
    }
}

/// A mirror's base URL: HTTPS (or HTTP on loopback), no credentials, no
/// query or fragment, no trailing slash.
pub fn normalize_update_base_url(value: Option<&str>) -> Result<String, String> {
    let candidate = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPDATE_BASE_URL);
    let not_http = || "ROAMGATE_UPDATE_BASE_URL must be an HTTP(S) URL".to_owned();
    let mut url = url::Url::parse(candidate).map_err(|_| not_http())?;
    let scheme = url.scheme().to_owned();
    if scheme != "https" && scheme != "http" {
        return Err(not_http());
    }
    let host = url.host_str().unwrap_or("").to_owned();
    let loopback_v4 = regex::Regex::new(r"^127(?:\.\d{1,3}){3}$").unwrap();
    let loopback_http =
        scheme == "http" && (host == "localhost" || host == "[::1]" || loopback_v4.is_match(&host));
    if scheme != "https" && !loopback_http {
        return Err("ROAMGATE_UPDATE_BASE_URL must use HTTPS unless the mirror is loopback".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ROAMGATE_UPDATE_BASE_URL must not contain credentials".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("ROAMGATE_UPDATE_BASE_URL must not contain a query or fragment".into());
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

/// Whether an external supervisor restarts the process: the explicit
/// override (`ROAMGATE_RESTART_SUPERVISOR` 1 or 0), else systemd's
/// INVOCATION_ID, else launchd's XPC_SERVICE_NAME (not "0").
pub fn is_supervisor_managed(env: &dyn Env) -> bool {
    match roamgate_env(env, "RESTART_SUPERVISOR").as_deref() {
        Some("1") => return true,
        Some("0") => return false,
        _ => {}
    }
    if env
        .var("INVOCATION_ID")
        .is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    env.var("XPC_SERVICE_NAME")
        .is_some_and(|name| !name.is_empty() && name != "0")
}

/// The contract's installer for this release, over `target_path`.
pub fn render_update_install_script(
    target_path: &str,
    target: &UpdateTarget,
    manifest: &UpdateManifest,
    archive_url: &str,
    curl_transport: &str,
) -> String {
    let text = |value: String| TemplateValue::Text(value);
    fill_template(
        UPDATE_INSTALL_SH,
        &[
            ("target", text(shell_quote(target_path))),
            ("archive_name", text(target.archive_name.clone())),
            ("sha256", text(shell_quote(&manifest.sha256))),
            ("curl_transport", text(curl_transport.to_owned())),
            ("archive_url", text(shell_quote(archive_url))),
            (
                "version_file",
                text(shell_quote(&format!("{}/VERSION", target.package_dir))),
            ),
            (
                "binary_file",
                text(shell_quote(&format!("{}/roamgate", target.package_dir))),
            ),
            ("package_dir", text(target.package_dir.clone())),
            ("version", text(shell_quote(&manifest.version))),
            ("platform", text(shell_quote(&target.platform))),
        ],
    )
    .expect("update-install.sh fills")
}

/// curl's transport flags for a mirror, quoted for the installer.
pub fn curl_transport_command(base_url: &str) -> String {
    curl_transport_args(base_url)
        .iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A process run to its end: code and output (runProcessWithCodeTimeout).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ran {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a command with a deadline; an error is the TS rejection's message
/// (`<program> timed out after <ms>ms`).
pub type RunProcess =
    Arc<dyn Fn(Vec<String>, Duration) -> BoxFuture<Result<Ran, String>> + Send + Sync>;

/// The real runs, on `runner`'s clock.
pub fn system_run_process(runner: roamgate_exec::process::ProcessRunner) -> RunProcess {
    Arc::new(move |argv, timeout| {
        let runner = runner.clone();
        Box::pin(async move {
            let output = runner
                .run(&roamgate_exec::process::Command::new(argv).timeout(timeout))
                .await
                .map_err(|error| error.to_string())?;
            Ok(Ran {
                code: output.code,
                stdout: output.stdout_text(),
                stderr: output.stderr_text(),
            })
        })
    })
}

fn bounded(text: &str, limit: usize) -> String {
    text.trim().chars().take(limit).collect()
}

/// What a failed run says (stderr, else stdout, else its exit).
pub fn run_failure(ran: &Ran, what: &str, limit: usize) -> String {
    let text = if !ran.stderr.is_empty() {
        ran.stderr.clone()
    } else if !ran.stdout.is_empty() {
        ran.stdout.clone()
    } else {
        format!("{what} exited {}", ran.code)
    };
    bounded(&text, limit)
}

/// Downloads, parses and checks the latest manifest of a target.
pub async fn fetch_latest_update_manifest(
    base_url: &str,
    target: &UpdateTarget,
    run: &RunProcess,
) -> Result<UpdateManifest, String> {
    let mut argv = vec!["curl".to_owned()];
    argv.extend(curl_transport_args(base_url));
    argv.extend([
        "-fsSL".into(),
        "--max-filesize".into(),
        UPDATE_METADATA_MAX_BYTES.to_string(),
        format!("{base_url}/{}", target.manifest_name),
    ]);
    let ran = run(argv, UPDATE_CHECK_TIMEOUT).await?;
    // Every release has a manifest: never probe legacy archives.
    if ran.code != 0 {
        return Err(run_failure(&ran, "update manifest download", 500));
    }
    let manifest = parse_update_manifest(&ran.stdout)?;
    if manifest.platform != target.platform {
        return Err(format!(
            "latest update platform is {}, expected {}",
            manifest.platform, target.platform
        ));
    }
    if manifest.archive != target.archive_name {
        return Err(format!(
            "latest update archive is {}, expected {}",
            manifest.archive, target.archive_name
        ));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn manifest(version: &str, platform: &str) -> String {
        serde_json::json!({
            "schema": 1, "name": "roamgate", "version": version, "platform": platform,
            "archive": format!("roamgate-{platform}.tar.xz"), "sha256": "a".repeat(64),
        })
        .to_string()
    }

    #[test]
    fn keeps_http_requests_alive_for_the_full_update_budget() {
        const { assert!(UPDATE_HTTP_IDLE_TIMEOUT_SECONDS * 1000 > 135_000) };
        const { assert!(UPDATE_HTTP_IDLE_TIMEOUT_SECONDS <= 255) };
        assert_eq!(UPDATE_HTTP_IDLE_TIMEOUT_SECONDS, 150);
    }

    #[test]
    fn parses_bounded_roamgate_manifests_and_rejects_legacy_identities() {
        assert_eq!(
            parse_update_manifest(&manifest("0.2.17", "linux-x64")),
            Ok(UpdateManifest {
                version: "0.2.17".into(),
                platform: "linux-x64".into(),
                archive: "roamgate-linux-x64.tar.xz".into(),
                sha256: "a".repeat(64),
            })
        );
        for bad in [
            "{}".to_owned(),
            manifest("invalid", "linux-x64"),
            "x".repeat(4097),
        ] {
            assert_eq!(
                parse_update_manifest(&bad),
                Err("invalid update manifest".into())
            );
        }
        for legacy in ["herdr-gui", "herdr-studio"] {
            let text = manifest("9.8.7", "linux-x64").replace("roamgate", legacy);
            assert_eq!(
                parse_update_manifest(&text),
                Err("invalid update manifest".into())
            );
        }
    }

    #[test]
    fn normalizes_safe_update_base_urls_without_exposing_credentials() {
        assert_eq!(
            normalize_update_base_url(None).unwrap(),
            DEFAULT_UPDATE_BASE_URL
        );
        assert_eq!(
            normalize_update_base_url(Some(" https://downloads.example.com/herdr/// ")).unwrap(),
            "https://downloads.example.com/herdr"
        );
        assert_eq!(
            normalize_update_base_url(Some("http://127.0.0.1:8080/releases/")).unwrap(),
            "http://127.0.0.1:8080/releases"
        );
        assert_eq!(
            normalize_update_base_url(Some("https://example.com")).unwrap(),
            "https://example.com"
        );
        assert!(
            normalize_update_base_url(Some("http://downloads.example.com/herdr"))
                .unwrap_err()
                .contains("must use HTTPS unless the mirror is loopback")
        );
        assert!(
            normalize_update_base_url(Some("https://u:p@downloads.example.com/herdr"))
                .unwrap_err()
                .contains("must not contain credentials")
        );
        assert!(
            normalize_update_base_url(Some("https://downloads.example.com/herdr?token=secret"))
                .unwrap_err()
                .contains("must not contain a query or fragment")
        );
        assert_eq!(
            normalize_update_base_url(Some("ftp://x/y")),
            Err("ROAMGATE_UPDATE_BASE_URL must be an HTTP(S) URL".into())
        );
    }

    #[test]
    fn compares_release_and_prerelease_versions_numerically() {
        assert_eq!(compare_version("0.2.10", "0.2.9"), Ok(Ordering::Greater));
        assert_eq!(compare_version("0.2.0", "0.2"), Ok(Ordering::Equal));
        assert_eq!(compare_version("0.1.9", "0.2.0"), Ok(Ordering::Less));
        assert_eq!(
            compare_version("1.0.0", "1.0.0-rc.1"),
            Ok(Ordering::Greater)
        );
        assert_eq!(
            compare_version("1.0.0-rc.10", "1.0.0-rc.2"),
            Ok(Ordering::Greater)
        );
        assert_eq!(
            compare_version("not-a-version", "1.0.0"),
            Err("invalid update version".into())
        );
    }

    #[test]
    fn maps_only_published_runtime_architectures_to_update_packages() {
        assert_eq!(
            resolve_update_target("linux", "x64"),
            Some(UpdateTarget {
                platform: "linux-x64".into(),
                package_dir: "roamgate-linux-x64".into(),
                archive_name: "roamgate-linux-x64.tar.xz".into(),
                manifest_name: "roamgate-linux-x64.update.json".into(),
            })
        );
        for (platform, arch) in [("darwin", "arm64"), ("darwin", "x64"), ("linux", "arm64")] {
            assert!(resolve_update_target(platform, arch).is_some());
        }
        assert_eq!(resolve_update_target("win32", "x64"), None);
    }

    #[test]
    fn detects_systemd_and_launchd_while_allowing_explicit_overrides() {
        let env = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect()
        };
        assert!(is_supervisor_managed(&env(&[("INVOCATION_ID", "id")])));
        assert!(is_supervisor_managed(&env(&[(
            "XPC_SERVICE_NAME",
            "dev.herdr.herdr-gui"
        )])));
        assert!(!is_supervisor_managed(&env(&[("XPC_SERVICE_NAME", "0")])));
        assert!(!is_supervisor_managed(&env(&[
            ("INVOCATION_ID", "id"),
            ("HERDR_GUI_RESTART_SUPERVISOR", "0")
        ])));
        assert!(is_supervisor_managed(&env(&[(
            "HERDR_GUI_RESTART_SUPERVISOR",
            "1"
        )])));
    }

    /// The installer run for real (sh, tar, curl over file://) against a
    /// package of `files` (name, version it prints) for linux-x64.
    #[cfg(unix)]
    struct Installed {
        dir: tempfile::TempDir,
    }

    #[cfg(unix)]
    impl Installed {
        fn bin(&self) -> std::path::PathBuf {
            self.dir.path().join("bin")
        }

        fn read(&self, name: &str) -> Option<String> {
            std::fs::read_to_string(self.bin().join(name)).ok()
        }

        fn script(text: &str) -> String {
            format!("#!/bin/sh\necho '{text}'\n")
        }

        fn put(path: &std::path::Path, text: &str) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, Self::script(text)).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        /// Installs `version` from a package with or without roamgate-pi.
        fn run(&self, version: &str, with_pi: bool) -> std::process::Output {
            let target = resolve_update_target("linux", "x64").unwrap();
            let dist = self.dir.path().join(format!("dist-{version}-{with_pi}"));
            let package = dist.join(&target.package_dir);
            Self::put(&package.join("roamgate"), &format!("roamgate {version}"));
            if with_pi {
                Self::put(&package.join("roamgate-pi"), &format!("pi {version}"));
            }
            std::fs::write(
                package.join("VERSION"),
                format!("roamgate {version} linux-x64\n"),
            )
            .unwrap();
            let archive = dist.join(&target.archive_name);
            let packed = std::process::Command::new("tar")
                .arg("-C")
                .arg(&dist)
                .arg("-cJf")
                .arg(&archive)
                .arg(&target.package_dir)
                .status()
                .unwrap();
            assert!(packed.success());
            let digest = std::process::Command::new("sha256sum")
                .arg(&archive)
                .output()
                .unwrap();
            let sha256 = String::from_utf8_lossy(&digest.stdout)
                .split_whitespace()
                .next()
                .unwrap()
                .to_owned();
            let manifest = UpdateManifest {
                version: version.into(),
                platform: "linux-x64".into(),
                archive: target.archive_name.clone(),
                sha256,
            };
            let script = render_update_install_script(
                &self.bin().join("roamgate").display().to_string(),
                &target,
                &manifest,
                &format!("file://{}", archive.display()),
                "",
            );
            std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .env("TMPDIR", self.dir.path())
                .output()
                .unwrap()
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.bin())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    #[cfg(unix)]
    fn script_tools() -> bool {
        ["tar", "xz", "curl", "sha256sum"].iter().all(|tool| {
            std::process::Command::new("sh")
                .args(["-c", &format!("command -v {tool}")])
                .output()
                .is_ok_and(|output| output.status.success())
        })
    }

    #[cfg(unix)]
    #[test]
    fn the_installer_installs_and_backs_up_roamgate_pi_with_the_executable() {
        if !script_tools() {
            return;
        }
        let installed = Installed::new();
        Installed::put(&installed.bin().join("roamgate"), "roamgate 1.0.0");
        // From a release without roamgate-pi: none to keep, and a stale
        // roamgate-pi.previous goes.
        Installed::put(&installed.bin().join("roamgate-pi.previous"), "pi stale");
        let ran = installed.run("1.1.0", true);
        assert!(ran.status.success(), "{ran:?}");
        assert_eq!(
            installed.names(),
            ["roamgate", "roamgate-pi", "roamgate.previous"]
        );
        assert_eq!(
            installed.read("roamgate-pi"),
            Some(Installed::script("pi 1.1.0"))
        );
        // Between two releases with it: both previous copies kept.
        let ran = installed.run("1.2.0", true);
        assert!(ran.status.success(), "{ran:?}");
        assert_eq!(
            installed.names(),
            [
                "roamgate",
                "roamgate-pi",
                "roamgate-pi.previous",
                "roamgate.previous"
            ]
        );
        assert_eq!(
            installed.read("roamgate-pi.previous"),
            Some(Installed::script("pi 1.1.0"))
        );
        assert_eq!(
            installed.read("roamgate.previous"),
            Some(Installed::script("roamgate 1.1.0"))
        );
        // To a release without it: roamgate-pi becomes the previous one.
        let ran = installed.run("1.3.0", false);
        assert!(ran.status.success(), "{ran:?}");
        assert_eq!(
            installed.names(),
            ["roamgate", "roamgate-pi.previous", "roamgate.previous"]
        );
        assert_eq!(
            installed.read("roamgate-pi.previous"),
            Some(Installed::script("pi 1.2.0"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_installer_adds_a_missing_roamgate_pi_without_replacing_the_executable() {
        if !script_tools() {
            return;
        }
        let installed = Installed::new();
        Installed::put(&installed.bin().join("roamgate"), "roamgate 1.1.0");
        Installed::put(&installed.bin().join("roamgate.previous"), "roamgate 1.0.0");
        let ran = installed.run("1.1.0", true);
        assert!(ran.status.success(), "{ran:?}");
        assert_eq!(
            installed.names(),
            ["roamgate", "roamgate-pi", "roamgate.previous"]
        );
        assert_eq!(
            installed.read("roamgate.previous"),
            Some(Installed::script("roamgate 1.0.0"))
        );
        assert_eq!(
            installed.read("roamgate-pi"),
            Some(Installed::script("pi 1.1.0"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_installer_refuses_a_roamgate_pi_that_is_not_a_regular_file() {
        if !script_tools() {
            return;
        }
        let installed = Installed::new();
        Installed::put(&installed.bin().join("roamgate"), "roamgate 1.0.0");
        let outside = installed.dir.path().join("outside");
        Installed::put(&outside, "outside");
        std::os::unix::fs::symlink(&outside, installed.bin().join("roamgate-pi")).unwrap();
        let ran = installed.run("1.1.0", true);
        assert!(!ran.status.success());
        assert!(
            String::from_utf8_lossy(&ran.stderr)
                .contains("roamgate-pi beside the executable is not a regular file")
        );
        assert_eq!(
            installed.read("roamgate"),
            Some(Installed::script("roamgate 1.0.0"))
        );
        assert_eq!(installed.names(), ["roamgate", "roamgate-pi"]);
    }
}
