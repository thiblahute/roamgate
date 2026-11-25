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

/// Roamgate's releases, whose `download/v<version>` holds a version's assets.
pub const RELEASES_URL: &str = "https://github.com/powerfooI/roamgate/releases";
pub const DEFAULT_UPDATE_BASE_URL: &str =
    "https://github.com/powerfooI/roamgate/releases/latest/download";
pub const UPDATE_METADATA_MAX_BYTES: usize = 4096;
pub const UPDATE_CHECK_CACHE_MS: i64 = 5 * 60 * 1000;
pub const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_millis(15_000);
pub const UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_millis(120_000);
/// The HTTP idle budget of an update request (the front's).
pub const UPDATE_HTTP_IDLE_TIMEOUT_SECONDS: u64 = (15_000 + 120_000) / 1000 + 15;

/// The published update packages: targets.toml's platforms.
const UPDATE_PLATFORMS: [&str; 7] = [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "linux-x64-musl",
    "windows-arm64",
    "windows-x64",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateTarget {
    pub platform: String,
    pub package_dir: String,
    pub archive_name: String,
    pub manifest_name: String,
    /// The executable in the package: roamgate, or roamgate.exe.
    pub binary: String,
    /// The Pi sidecar beside it: roamgate-pi, or roamgate-pi.exe.
    pub pi_binary: String,
}

impl UpdateTarget {
    /// Windows packages are zip archives that [`install_by_rename`]
    /// installs; the others are tar.xz archives the contract's shell
    /// installer installs.
    pub fn is_windows(&self) -> bool {
        self.platform.starts_with("windows-")
    }
}

/// Whether this build links musl (its update package is linux-x64-musl).
pub const MUSL: bool = cfg!(target_env = "musl");

/// The update package of this build on `platform` (Node's name) and `arch`.
pub fn resolve_update_target(platform: &str, arch: &str) -> Option<UpdateTarget> {
    resolve_update_target_for(platform, arch, MUSL)
}

/// The update package of a build on `platform` and `arch`, musl or not.
pub fn resolve_update_target_for(platform: &str, arch: &str, musl: bool) -> Option<UpdateTarget> {
    let os = if platform == "win32" {
        "windows"
    } else {
        platform
    };
    let libc = if musl && os == "linux" { "-musl" } else { "" };
    let candidate = format!("{os}-{arch}{libc}");
    let windows = os == "windows";
    let exe = if windows { ".exe" } else { "" };
    UPDATE_PLATFORMS
        .contains(&candidate.as_str())
        .then(|| UpdateTarget {
            package_dir: format!("roamgate-{candidate}"),
            archive_name: format!(
                "roamgate-{candidate}.{}",
                if windows { "zip" } else { "tar.xz" }
            ),
            manifest_name: format!("roamgate-{candidate}.update.json"),
            binary: format!("roamgate{exe}"),
            pi_binary: format!("roamgate-pi{exe}"),
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
    let platform_re = regex::Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)+$").unwrap();
    let archive_re = regex::Regex::new(r"^roamgate-[a-z0-9-]+\.(?:tar\.xz|zip)$").unwrap();
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

/// Installs `manifest`'s release over the executable at `target_path`,
/// from the mirror at `base_url`: the one step `roamgate update` and
/// `/api/update/install` share. Linux and macOS run the contract's shell
/// installer; Windows, which has no `sh`, [`install_by_rename`]. A failed
/// install is a nonzero [`Ran`] whose output says why; `Err` is a command
/// that could not run.
pub async fn install_update(
    target_path: &str,
    target: &UpdateTarget,
    manifest: &UpdateManifest,
    base_url: &str,
    run: &RunProcess,
) -> Result<Ran, String> {
    let archive_url = format!("{base_url}/{}", target.archive_name);
    if target.is_windows() {
        let install = Install {
            target_path: std::path::Path::new(target_path),
            target,
            manifest,
            archive_url: &archive_url,
            run,
            tar: windows_tar(),
        };
        return Ok(match install_by_rename(&install).await {
            Ok(()) => Ran::default(),
            Err(message) => Ran {
                code: 1,
                stderr: message,
                ..Ran::default()
            },
        });
    }
    let script = render_update_install_script(
        target_path,
        target,
        manifest,
        &archive_url,
        &curl_transport_command(base_url),
    );
    run(
        vec!["sh".into(), "-c".into(), script],
        UPDATE_INSTALL_TIMEOUT,
    )
    .await
}

/// Windows' own bsdtar, which reads zip archives (Git Bash's GNU tar,
/// often first on PATH, does not).
fn windows_tar() -> String {
    match std::env::var_os("SystemRoot") {
        Some(root) if cfg!(windows) => std::path::Path::new(&root)
            .join("System32")
            .join("tar.exe")
            .display()
            .to_string(),
        _ => "tar".into(),
    }
}

/// What [`install_by_rename`] installs, and with what.
pub struct Install<'a> {
    pub target_path: &'a std::path::Path,
    pub target: &'a UpdateTarget,
    pub manifest: &'a UpdateManifest,
    pub archive_url: &'a str,
    pub run: &'a RunProcess,
    /// The tar that extracts the archive (bsdtar reads zip and tar.xz).
    pub tar: String,
}

/// `path.previous`.
pub fn previous_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".previous");
    name.into()
}

/// Where a `.previous` that cannot be removed (it runs) moves aside:
/// `.<name>.stale-<pid>-<n>` beside it.
fn stale_path(previous: &std::path::Path, n: usize) -> std::path::PathBuf {
    let name = previous
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    previous.with_file_name(format!(".{name}.stale-{}-{n}", std::process::id()))
}

/// Removes what earlier updates moved aside and nothing runs any more;
/// what still runs stays for the next one.
fn remove_stale(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".roamgate") && name.contains(".previous.stale-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A regular file, not a symlink.
fn regular(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

/// Nothing there, not even a dangling symlink.
fn absent(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).is_err()
}

/// The contract installer's steps without `sh`, for Windows: downloads the
/// archive, checks its SHA-256, its VERSION and the new binary's
/// `--version`, then installs the executable and its Pi sidecar by rename,
/// which Windows allows on a running executable: each installed file
/// becomes `<name>.previous` (as on Unix, for `roamgate rollback`) and the
/// new one takes its name. A failure puts back what moved. The executable
/// already at this version (an update that left the sidecar out) stays;
/// only the sidecar is added.
pub async fn install_by_rename(install: &Install<'_>) -> Result<(), String> {
    use roamgate_exec::install::{Staging, verify_sha256};
    let io = |error: std::io::Error| error.to_string();
    let target_path = install.target_path;
    let target = install.target;
    let manifest = install.manifest;
    if !regular(target_path) {
        return Err("running executable is not a regular file".into());
    }
    let dir = target_path.parent().unwrap_or(std::path::Path::new("."));
    let pi_target = dir.join(&target.pi_binary);
    if !absent(&pi_target) && !regular(&pi_target) {
        return Err(format!(
            "{} beside the executable is not a regular file",
            target.pi_binary
        ));
    }
    remove_stale(dir);
    // Staged in the executable's directory, so the renames stay on one
    // volume; removed whatever happens.
    let staging = Staging::new(dir).map_err(io)?;
    let archive = staging.path().join(&target.archive_name);
    let mut argv = vec!["curl".to_owned()];
    argv.extend(curl_transport_args(install.archive_url));
    argv.extend([
        "-fsSL".into(),
        "-o".into(),
        archive.display().to_string(),
        install.archive_url.into(),
    ]);
    let ran = (install.run)(argv, UPDATE_INSTALL_TIMEOUT).await?;
    if ran.code != 0 {
        return Err(run_failure(&ran, "update download", 500));
    }
    if !verify_sha256(&archive, &manifest.sha256).map_err(io)? {
        return Err("downloaded archive checksum does not match update manifest".into());
    }
    let extracted = staging.path().join("x");
    std::fs::create_dir(&extracted).map_err(io)?;
    let ran = (install.run)(
        vec![
            install.tar.clone(),
            "-xf".into(),
            archive.display().to_string(),
            "-C".into(),
            extracted.display().to_string(),
        ],
        UPDATE_INSTALL_TIMEOUT,
    )
    .await?;
    if ran.code != 0 {
        return Err(format!(
            "could not extract the update: {}",
            run_failure(&ran, "tar", 500)
        ));
    }
    let package = extracted.join(&target.package_dir);
    let binary = package.join(&target.binary);
    let pi = package.join(&target.pi_binary);
    let version_file = package.join("VERSION");
    let has_pi = !absent(&pi);
    if !regular(&binary) || !regular(&version_file) || (has_pi && !regular(&pi)) {
        return Err("downloaded archive does not contain regular package files".into());
    }
    let version_line = std::fs::read_to_string(&version_file).map_err(io)?;
    let fields: Vec<&str> = version_line.split_whitespace().collect();
    if fields
        != [
            "roamgate",
            manifest.version.as_str(),
            target.platform.as_str(),
        ]
    {
        return Err("downloaded VERSION metadata does not match update manifest".into());
    }
    let expected = format!("roamgate {}", manifest.version);
    let version_of = |path: &std::path::Path| {
        (install.run)(
            vec![path.display().to_string(), "--version".into()],
            UPDATE_CHECK_TIMEOUT,
        )
    };
    let ran = version_of(&binary).await?;
    if ran.code != 0 || ran.stdout.trim() != expected {
        return Err("downloaded binary version does not match update manifest".into());
    }
    let keep_binary = version_of(target_path)
        .await
        .is_ok_and(|ran| ran.code == 0 && ran.stdout.trim() == expected);

    // The renames, each recorded to be undone on a failure.
    let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    let mut placed: Vec<std::path::PathBuf> = Vec::new();
    let result = (|| -> std::io::Result<()> {
        let mut stale = 0;
        let mut retire = |path: &std::path::Path| -> std::io::Result<bool> {
            let previous = previous_path(path);
            if !absent(&previous) && std::fs::remove_file(&previous).is_err() {
                // Still running: the server not yet restarted, or a pane's
                // roamgate-hold.exe or roamgate-review.exe, hard links of it
                // that last as long as their pane. Windows lets it be
                // renamed though not removed: it moves aside, and a later
                // update removes it once nothing runs it.
                stale += 1;
                let aside = stale_path(&previous, stale);
                std::fs::rename(&previous, &aside).map_err(|error| {
                    std::io::Error::new(
                        error.kind(),
                        format!(
                            "{} is in use ({error}): stop the roamgate running from it and retry",
                            previous.display()
                        ),
                    )
                })?;
            }
            if absent(path) {
                return Ok(false);
            }
            std::fs::rename(path, &previous)?;
            moved.push((previous, path.to_path_buf()));
            Ok(true)
        };
        if !keep_binary {
            retire(target_path)?;
            // roamgate-pi.previous goes with roamgate.previous: none when
            // the replaced release had no sidecar.
            retire(&pi_target)?;
        } else if has_pi {
            retire(&pi_target)?;
        }
        if has_pi {
            std::fs::rename(&pi, &pi_target)?;
            placed.push(pi_target.clone());
        }
        if !keep_binary {
            std::fs::rename(&binary, target_path)?;
            placed.push(target_path.to_path_buf());
        }
        Ok(())
    })();
    if let Err(error) = result {
        for path in placed {
            let _ = std::fs::remove_file(path);
        }
        for (previous, path) in moved.into_iter().rev() {
            let _ = std::fs::rename(previous, path);
        }
        return Err(error.to_string());
    }
    drop(staging);
    Ok(())
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
            resolve_update_target_for("linux", "x64", false),
            Some(UpdateTarget {
                platform: "linux-x64".into(),
                package_dir: "roamgate-linux-x64".into(),
                archive_name: "roamgate-linux-x64.tar.xz".into(),
                manifest_name: "roamgate-linux-x64.update.json".into(),
                binary: "roamgate".into(),
                pi_binary: "roamgate-pi".into(),
            })
        );
        for (platform, arch) in [
            ("darwin", "arm64"),
            ("darwin", "x64"),
            ("linux", "arm64"),
            ("win32", "x64"),
            ("win32", "arm64"),
        ] {
            assert!(resolve_update_target(platform, arch).is_some());
        }
        for (platform, arch) in [("linux", "riscv64"), ("freebsd", "x64"), ("win32", "ia32")] {
            assert_eq!(resolve_update_target(platform, arch), None);
        }
    }

    #[test]
    fn resolves_musl_and_windows_packages() {
        let musl = resolve_update_target_for("linux", "x64", true).unwrap();
        assert_eq!(musl.platform, "linux-x64-musl");
        assert_eq!(musl.archive_name, "roamgate-linux-x64-musl.tar.xz");
        assert_eq!(musl.manifest_name, "roamgate-linux-x64-musl.update.json");
        assert_eq!(musl.binary, "roamgate");
        // Only x64 has a musl package; macOS ignores the flag.
        assert_eq!(resolve_update_target_for("linux", "arm64", true), None);
        assert_eq!(
            resolve_update_target_for("darwin", "arm64", true)
                .unwrap()
                .platform,
            "darwin-arm64"
        );
        let windows = resolve_update_target_for("win32", "arm64", false).unwrap();
        assert_eq!(windows.platform, "windows-arm64");
        assert_eq!(windows.archive_name, "roamgate-windows-arm64.zip");
        assert_eq!(
            (windows.binary.as_str(), windows.pi_binary.as_str()),
            ("roamgate.exe", "roamgate-pi.exe")
        );
        assert!(windows.is_windows() && !musl.is_windows());
        assert_eq!(
            resolve_update_target("linux", "x64").unwrap().platform,
            if MUSL { "linux-x64-musl" } else { "linux-x64" }
        );
        // Their manifests parse.
        for (platform, archive) in [
            ("linux-x64-musl", "roamgate-linux-x64-musl.tar.xz"),
            ("windows-x64", "roamgate-windows-x64.zip"),
        ] {
            let text = serde_json::json!({
                "schema": 1, "name": "roamgate", "version": "1.0.0", "platform": platform,
                "archive": archive, "sha256": "a".repeat(64),
            })
            .to_string();
            assert_eq!(parse_update_manifest(&text).unwrap().archive, archive);
        }
    }

    /// A package for [`install_by_rename`] of this machine's archive kind:
    /// files are text ("roamgate <version>") whose `--version` the fake
    /// run reads; curl copies a file URL, tar is the system's.
    struct RenameFixture {
        dir: tempfile::TempDir,
        target: UpdateTarget,
    }

    impl RenameFixture {
        fn new() -> Self {
            let windows = cfg!(windows);
            let exe = if windows { ".exe" } else { "" };
            let platform = "test-x64".to_owned();
            Self {
                dir: tempfile::tempdir().unwrap(),
                target: UpdateTarget {
                    package_dir: format!("roamgate-{platform}"),
                    // Windows' tar.exe reads zip; GNU tar does not.
                    archive_name: format!(
                        "roamgate-{platform}.{}",
                        if windows { "zip" } else { "tar.xz" }
                    ),
                    manifest_name: format!("roamgate-{platform}.update.json"),
                    binary: format!("roamgate{exe}"),
                    pi_binary: format!("roamgate-pi{exe}"),
                    platform,
                },
            }
        }

        fn bin(&self) -> std::path::PathBuf {
            self.dir.path().join("bin")
        }

        fn exe(&self) -> std::path::PathBuf {
            self.bin().join(&self.target.binary)
        }

        fn pi(&self) -> std::path::PathBuf {
            self.bin().join(&self.target.pi_binary)
        }

        fn put(path: &std::path::Path, text: &str) {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.bin())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }

        fn read(path: &std::path::Path) -> String {
            std::fs::read_to_string(path).unwrap()
        }

        /// Packages `version` (`version_file` overriding its VERSION).
        fn package(
            &self,
            version: &str,
            with_pi: bool,
            version_file: Option<&str>,
        ) -> UpdateManifest {
            let dist = self.dir.path().join("dist");
            let _ = std::fs::remove_dir_all(&dist);
            let package = dist.join(&self.target.package_dir);
            Self::put(
                &package.join(&self.target.binary),
                &format!("roamgate {version}"),
            );
            if with_pi {
                Self::put(
                    &package.join(&self.target.pi_binary),
                    &format!("pi {version}"),
                );
            }
            Self::put(
                &package.join("VERSION"),
                version_file.unwrap_or(&format!("roamgate {version} {}\n", self.target.platform)),
            );
            self.repack(UpdateManifest {
                version: version.into(),
                platform: self.target.platform.clone(),
                archive: self.target.archive_name.clone(),
                sha256: String::new(),
            })
        }

        /// Archives the staged package again; `manifest` with its digest.
        fn repack(&self, manifest: UpdateManifest) -> UpdateManifest {
            let dist = self.dir.path().join("dist");
            let archive = dist.join(&self.target.archive_name);
            let _ = std::fs::remove_file(&archive);
            let mut tar = std::process::Command::new(windows_tar());
            if cfg!(windows) {
                tar.arg("-a").arg("-cf");
            } else {
                tar.arg("-cJf");
            }
            let packed = tar
                .arg(&archive)
                .arg("-C")
                .arg(&dist)
                .arg(&self.target.package_dir)
                .status()
                .unwrap();
            assert!(packed.success());
            UpdateManifest {
                sha256: roamgate_exec::install::sha256_file(&archive).unwrap(),
                ..manifest
            }
        }

        fn run() -> RunProcess {
            Arc::new(|argv: Vec<String>, _| {
                Box::pin(async move {
                    let ok = |stdout: String| Ran {
                        code: 0,
                        stdout,
                        ..Ran::default()
                    };
                    if argv[0] == "curl" {
                        let out = &argv[argv.iter().position(|a| a == "-o").unwrap() + 1];
                        let url = argv.last().unwrap();
                        let source = url.strip_prefix("file://").unwrap();
                        return Ok(match std::fs::copy(source, out) {
                            Ok(_) => ok(String::new()),
                            Err(error) => Ran {
                                code: 22,
                                stderr: format!("curl: {error}"),
                                ..Ran::default()
                            },
                        });
                    }
                    if argv.get(1).map(String::as_str) == Some("--version") {
                        return Ok(match std::fs::read_to_string(&argv[0]) {
                            Ok(text) if text.starts_with("roamgate ") => ok(format!("{text}\n")),
                            _ => Ran {
                                code: 1,
                                ..Ran::default()
                            },
                        });
                    }
                    let output = std::process::Command::new(&argv[0])
                        .args(&argv[1..])
                        .output()
                        .map_err(|error| error.to_string())?;
                    Ok(Ran {
                        code: output.status.code().unwrap_or(1),
                        stdout: String::from_utf8_lossy(&output.stdout).into(),
                        stderr: String::from_utf8_lossy(&output.stderr).into(),
                    })
                })
            })
        }

        async fn install(&self, manifest: &UpdateManifest) -> Result<(), String> {
            let archive = self.dir.path().join("dist").join(&self.target.archive_name);
            let url = format!("file://{}", archive.display());
            let run = Self::run();
            install_by_rename(&Install {
                target_path: &self.exe(),
                target: &self.target,
                manifest,
                archive_url: &url,
                run: &run,
                tar: windows_tar(),
            })
            .await
        }
    }

    fn sorted<const N: usize>(names: [String; N]) -> Vec<String> {
        let mut names = names.to_vec();
        names.sort();
        names
    }

    #[tokio::test]
    async fn installs_by_rename_keeping_the_previous_files() {
        let fixture = RenameFixture::new();
        let exe = fixture.exe();
        let pi = fixture.pi();
        let (exe_name, pi_name) = (
            fixture.target.binary.clone(),
            fixture.target.pi_binary.clone(),
        );
        RenameFixture::put(&exe, "roamgate 1.0.0");
        // A stale previous sidecar goes with an executable that had none.
        RenameFixture::put(&previous_path(&pi), "pi stale");
        let manifest = fixture.package("1.1.0", true, None);
        fixture.install(&manifest).await.unwrap();
        assert_eq!(
            fixture.names(),
            sorted([
                pi_name.clone(),
                exe_name.clone(),
                format!("{exe_name}.previous")
            ])
        );
        assert_eq!(RenameFixture::read(&exe), "roamgate 1.1.0");
        assert_eq!(RenameFixture::read(&pi), "pi 1.1.0");

        let manifest = fixture.package("1.2.0", true, None);
        fixture.install(&manifest).await.unwrap();
        assert_eq!(
            fixture.names(),
            sorted([
                pi_name.clone(),
                format!("{pi_name}.previous"),
                exe_name.clone(),
                format!("{exe_name}.previous")
            ])
        );
        assert_eq!(RenameFixture::read(&previous_path(&exe)), "roamgate 1.1.0");
        assert_eq!(RenameFixture::read(&previous_path(&pi)), "pi 1.1.0");

        // To a release without the sidecar: it becomes the previous one.
        let manifest = fixture.package("1.3.0", false, None);
        fixture.install(&manifest).await.unwrap();
        assert_eq!(
            fixture.names(),
            sorted([
                format!("{pi_name}.previous"),
                exe_name.clone(),
                format!("{exe_name}.previous")
            ])
        );
        assert_eq!(RenameFixture::read(&previous_path(&pi)), "pi 1.2.0");

        // The executable at the version already: only the sidecar is added.
        let manifest = fixture.package("1.3.0", true, None);
        fixture.install(&manifest).await.unwrap();
        assert_eq!(RenameFixture::read(&exe), "roamgate 1.3.0");
        assert_eq!(RenameFixture::read(&previous_path(&exe)), "roamgate 1.2.0");
        assert_eq!(RenameFixture::read(&pi), "pi 1.3.0");
        // Nothing staged is left.
        assert!(fixture.names().iter().all(|name| !name.starts_with('.')));
    }

    #[tokio::test]
    async fn refuses_a_bad_package_and_leaves_the_install_as_it_was() {
        let fixture = RenameFixture::new();
        let exe = fixture.exe();
        RenameFixture::put(&exe, "roamgate 1.0.0");
        let names = fixture.names();
        let platform = fixture.target.platform.clone();
        for (version_file, message) in [
            (
                format!("roamgate 1.1.1 {platform}\n"),
                "VERSION metadata does not match",
            ),
            (
                "roamgate 1.1.0 other-x64\n".to_owned(),
                "VERSION metadata does not match",
            ),
            // A binary whose --version is not the release's.
            (
                format!("roamgate 1.1.0 {platform}\n"),
                "binary version does not match",
            ),
        ] {
            let manifest = fixture.package("1.1.0", true, Some(&version_file));
            if message.starts_with("binary") {
                std::fs::write(
                    fixture
                        .dir
                        .path()
                        .join("dist")
                        .join(&fixture.target.package_dir)
                        .join(&fixture.target.binary),
                    "not roamgate",
                )
                .unwrap();
                let manifest = fixture.repack(manifest);
                let error = fixture.install(&manifest).await.unwrap_err();
                assert!(error.contains(message), "{error}");
            } else {
                let error = fixture.install(&manifest).await.unwrap_err();
                assert!(error.contains(message), "{error}");
            }
            assert_eq!(fixture.names(), names);
            assert_eq!(RenameFixture::read(&exe), "roamgate 1.0.0");
        }
        // The checksum case, its archive packaged last.
        let mut manifest = fixture.package("1.1.0", true, None);
        manifest.sha256 = "0".repeat(64);
        let error = fixture.install(&manifest).await.unwrap_err();
        assert!(error.contains("checksum does not match"), "{error}");
        // A binary that is not this version.
        let mut manifest = fixture.package("1.1.0", true, None);
        manifest.version = "1.2.0".into();
        let error = fixture.install(&manifest).await.unwrap_err();
        assert!(error.contains("VERSION metadata"), "{error}");
        assert_eq!(fixture.names(), names);
        // A previous executable still running (it cannot be removed: a
        // directory stands in for it) moves aside and the update goes on.
        std::fs::create_dir(previous_path(&exe)).unwrap();
        let manifest = fixture.package("1.1.0", true, None);
        fixture.install(&manifest).await.unwrap();
        assert_eq!(RenameFixture::read(&exe), "roamgate 1.1.0");
        assert_eq!(RenameFixture::read(&previous_path(&exe)), "roamgate 1.0.0");
        let aside: Vec<String> = fixture
            .names()
            .into_iter()
            .filter(|name| name.contains(".previous.stale-"))
            .collect();
        assert_eq!(aside.len(), 1, "{:?}", fixture.names());
        assert!(fixture.bin().join(&aside[0]).is_dir());
        // A later update removes what was moved aside once nothing runs
        // it (a file here; the directory stays, as a running one would).
        let leftover = fixture
            .bin()
            .join(format!(".{}.previous.stale-1-1", fixture.target.binary));
        std::fs::write(&leftover, "old").unwrap();
        let manifest = fixture.package("1.2.0", true, None);
        fixture.install(&manifest).await.unwrap();
        assert!(!leftover.exists());
        assert_eq!(RenameFixture::read(&exe), "roamgate 1.2.0");
    }

    /// Windows lets a running executable be renamed: the update installs
    /// over a roamgate.exe that is running.
    #[cfg(windows)]
    #[tokio::test]
    async fn installs_over_a_running_executable_on_windows() {
        let fixture = RenameFixture::new();
        let exe = fixture.exe();
        std::fs::create_dir_all(fixture.bin()).unwrap();
        let ping = std::path::Path::new(&std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("PING.EXE");
        std::fs::copy(&ping, &exe).unwrap();
        let mut running = std::process::Command::new(&exe)
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let manifest = fixture.package("2.0.0", true, None);
        let result = fixture.install(&manifest).await;
        let _ = running.kill();
        let _ = running.wait();
        result.unwrap();
        assert_eq!(RenameFixture::read(&exe), "roamgate 2.0.0");
        assert_eq!(
            std::fs::read(previous_path(&exe)).unwrap(),
            std::fs::read(&ping).unwrap()
        );
    }

    /// The pane clients ~/.cache/roamgate/bin/roamgate-hold.exe and
    /// roamgate-review.exe are hard links of the server's executable, and a
    /// holder runs as long as its pane. Two updates while one runs: the
    /// clients stay in place and working all along, and the second update,
    /// whose roamgate.exe.previous the holder still runs, moves that aside
    /// instead of failing.
    #[cfg(windows)]
    #[tokio::test]
    async fn updates_while_a_pane_holder_runs_a_hard_link_of_the_executable() {
        let fixture = RenameFixture::new();
        let exe = fixture.exe();
        std::fs::create_dir_all(fixture.bin()).unwrap();
        let ping = std::path::Path::new(&std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("PING.EXE");
        std::fs::copy(&ping, &exe).unwrap();
        let clients = fixture.dir.path().join("cache-bin");
        std::fs::create_dir_all(&clients).unwrap();
        let hold = clients.join("roamgate-hold.exe");
        let review = clients.join("roamgate-review.exe");
        std::fs::hard_link(&exe, &hold).unwrap();
        std::fs::hard_link(&exe, &review).unwrap();
        let mut holder = std::process::Command::new(&hold)
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let first = fixture.package("2.0.0", true, None);
        let first = fixture.install(&first).await;
        let second = fixture.package("3.0.0", true, None);
        let second = fixture.install(&second).await;
        let still_running = holder.try_wait().unwrap().is_none();
        let _ = holder.kill();
        let _ = holder.wait();
        first.unwrap();
        second.unwrap();
        assert!(still_running);
        assert_eq!(RenameFixture::read(&exe), "roamgate 3.0.0");
        assert_eq!(RenameFixture::read(&previous_path(&exe)), "roamgate 2.0.0");
        for client in [&hold, &review] {
            assert_eq!(
                std::fs::read(client).unwrap(),
                std::fs::read(&ping).unwrap()
            );
        }
        // The first roamgate.exe, which the holder still ran, was removed
        // as the second update's previous one (Windows removes a name of
        // a running image when another name of it is the one running), or
        // else moved aside; the next update, the holder gone, leaves none
        // aside.
        let third = fixture.package("4.0.0", true, None);
        fixture.install(&third).await.unwrap();
        assert!(
            !fixture
                .names()
                .iter()
                .any(|name| name.contains(".previous.stale-")),
            "{:?}",
            fixture.names()
        );
        assert_eq!(RenameFixture::read(&exe), "roamgate 4.0.0");
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
