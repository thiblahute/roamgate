//! The release checks of a packaged target (release.yml's "Verify release
//! package"), and what the updater requires of its manifest.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};

use crate::binary;
use crate::package::{self, checksum_line, sha256_hex, update_manifest, version_file};
use crate::targets::Target;

/// The updater's manifest rules (server/src/http/update.ts parseUpdateManifest).
pub fn updater_accepts(manifest: &str) -> Result<()> {
    ensure!(manifest.len() <= 4096, "manifest over 4096 bytes");
    let value: serde_json::Value = serde_json::from_str(manifest)?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    ensure!(
        value.get("schema") == Some(&serde_json::json!(1)),
        "schema is not 1"
    );
    ensure!(field("name") == "roamgate", "name is not roamgate");
    let platform = field("platform");
    let parts: Vec<_> = platform.split('-').collect();
    ensure!(
        parts.len() == 2
            && parts.iter().all(|part| !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())),
        "the updater rejects platform {platform}"
    );
    let archive = field("archive");
    let stem = archive
        .strip_prefix("roamgate-")
        .and_then(|rest| rest.strip_suffix(".tar.xz"))
        .unwrap_or_default();
    ensure!(
        !stem.is_empty()
            && stem
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "the updater rejects archive {archive}"
    );
    let sha = field("sha256");
    ensure!(
        sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()),
        "bad sha256"
    );
    ensure!(!field("version").is_empty(), "no version");
    Ok(())
}

fn read_text(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("missing {}", path.display()))
}

/// Checks `out`'s package of `target` at `version`.
pub fn verify(out: &Path, target: &Target, version: &str) -> Result<()> {
    let versioned = target.versioned_archive(version);
    let latest = target.latest_archive();
    let bytes =
        std::fs::read(out.join(&versioned)).with_context(|| format!("missing {versioned}"))?;
    let digest = sha256_hex(&bytes);
    for name in [&versioned, &latest] {
        let archive = std::fs::read(out.join(name)).with_context(|| format!("missing {name}"))?;
        ensure!(
            sha256_hex(&archive) == digest,
            "{name} differs from {versioned}"
        );
        let sums = read_text(&out.join(format!("{name}.sha256")))?;
        ensure!(
            sums == checksum_line(&digest, name),
            "{name}.sha256 does not match"
        );
    }
    let manifest = read_text(&out.join(target.manifest_name()))?;
    ensure!(
        manifest == update_manifest(version, target, &digest),
        "{} does not match the archive",
        target.manifest_name()
    );
    if target.update {
        updater_accepts(&manifest)?;
    }

    let entries = package::read_archive(&bytes)?;
    let dir = target.package_dir();
    let names: Vec<_> = entries
        .iter()
        .map(|entry| entry.path.trim_end_matches('/'))
        .collect();
    let binary_path = format!("{dir}/{}", target.binary);
    let version_path = format!("{dir}/VERSION");
    let mut expected = vec![dir.as_str(), binary_path.as_str(), version_path.as_str()];
    let mut sorted = names.clone();
    sorted.sort_unstable();
    expected.sort_unstable();
    ensure!(sorted == expected, "archive holds {names:?}");
    let entry = |path: &str| {
        entries
            .iter()
            .find(|entry| entry.path == path)
            .expect("listed")
    };
    let version_entry = entry(&version_path);
    ensure!(
        version_entry.kind == tar::EntryType::Regular,
        "VERSION is not a regular file"
    );
    ensure!(
        version_entry.data == version_file(version, &target.platform).as_bytes(),
        "VERSION is {:?}",
        String::from_utf8_lossy(&version_entry.data)
    );
    let binary_entry = entry(&binary_path);
    ensure!(
        binary_entry.kind == tar::EntryType::Regular,
        "{binary_path} is not a regular file"
    );
    ensure!(
        binary_entry.mode & 0o111 == 0o111,
        "{binary_path} is not executable"
    );
    let kind = binary::kind(&binary_entry.data)?;
    ensure!(
        kind.os == target.os && kind.arch == target.arch,
        "{binary_path} is a {}-{} binary",
        kind.os,
        kind.arch
    );
    if target.triple.ends_with("-musl") {
        ensure!(kind.static_elf, "{binary_path} is not statically linked");
    }
    if target.is_host() {
        let dir = out.join(format!(".verify-{}", target.platform));
        std::fs::create_dir_all(&dir)?;
        let run = dir.join(&target.binary);
        std::fs::write(&run, &binary_entry.data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755))?;
        }
        let output = Command::new(&run).arg("--version").output();
        std::fs::remove_dir_all(&dir)?;
        let output = output?;
        let line = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if line != format!("roamgate {version}") {
            bail!("{binary_path} --version printed {line:?}");
        }
        eprintln!("xtask: {} ran: {line}", target.platform);
    }
    eprintln!(
        "xtask: {} verified ({}-{}{}, sha256 {digest})",
        target.platform,
        kind.os,
        kind.arch,
        if kind.static_elf { ", static" } else { "" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_rules() {
        let digest = "0".repeat(64);
        let manifest = |platform: &str| {
            format!(
                "{{\"schema\":1,\"name\":\"roamgate\",\"version\":\"1.0.0\",\"platform\":\"{platform}\",\"archive\":\"roamgate-{platform}.tar.xz\",\"sha256\":\"{digest}\"}}"
            )
        };
        assert!(updater_accepts(&manifest("linux-x64")).is_ok());
        assert!(updater_accepts(&manifest("linux-x64-musl")).is_err());
        assert!(updater_accepts(&manifest("Linux-x64")).is_err());
    }
}
