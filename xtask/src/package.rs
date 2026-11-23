//! The release archive layout, as scripts/package-release.sh makes it for
//! the Bun build and `roamgate update` and the installers read it:
//!
//!   roamgate-v<version>-<platform>.tar.xz  roamgate-<platform>/{roamgate[.exe], VERSION}
//!   roamgate-<platform>.tar.xz             the same bytes
//!   <archive>.sha256                       "<hex>  <archive>\n"
//!   roamgate-<platform>.update.json        schema 1, one line

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use crate::targets::Target;

/// The VERSION file: `roamgate <version> <platform>`.
pub fn version_file(version: &str, platform: &str) -> String {
    format!("roamgate {version} {platform}\n")
}

/// The update manifest, byte for byte as package-release.sh writes it.
pub fn update_manifest(version: &str, target: &Target, sha256: &str) -> String {
    let field = |value: &str| serde_json::to_string(value).expect("a JSON string");
    format!(
        "{{\"schema\":1,\"name\":\"roamgate\",\"version\":{},\"platform\":{},\"archive\":{},\"sha256\":{}}}\n",
        field(version),
        field(&target.platform),
        field(&target.latest_archive()),
        field(sha256)
    )
}

pub fn checksum_line(sha256: &str, archive: &str) -> String {
    format!("{sha256}  {archive}\n")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The archive's modification time: SOURCE_DATE_EPOCH, else now.
fn mtime() -> u64 {
    std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default()
        })
}

fn header(kind: tar::EntryType, mode: u32, size: u64, mtime: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(size);
    header.set_mtime(mtime);
    header.set_uid(0);
    header.set_gid(0);
    header
}

/// The tar.xz bytes of a package.
pub fn archive(target: &Target, binary: &[u8], version: &str) -> Result<Vec<u8>> {
    let dir = target.package_dir();
    let mtime = mtime();
    let encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
    let mut builder = tar::Builder::new(encoder);
    builder.mode(tar::HeaderMode::Deterministic);
    let mut entry = header(tar::EntryType::Directory, 0o755, 0, mtime);
    builder.append_data(&mut entry, format!("{dir}/"), std::io::empty())?;
    let mut entry = header(tar::EntryType::Regular, 0o755, binary.len() as u64, mtime);
    builder.append_data(&mut entry, format!("{dir}/{}", target.binary), binary)?;
    let version = version_file(version, &target.platform);
    let mut entry = header(tar::EntryType::Regular, 0o644, version.len() as u64, mtime);
    builder.append_data(&mut entry, format!("{dir}/VERSION"), version.as_bytes())?;
    let encoder = builder.into_inner()?;
    Ok(encoder.finish()?)
}

/// One file of an archive.
pub struct Entry {
    pub path: String,
    pub mode: u32,
    pub kind: tar::EntryType,
    pub data: Vec<u8>,
}

pub fn read_archive(bytes: &[u8]) -> Result<Vec<Entry>> {
    let mut archive = tar::Archive::new(xz2::read::XzDecoder::new(bytes));
    let mut entries = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().into_owned();
        let mode = entry.header().mode()?;
        let kind = entry.header().entry_type();
        let mut data = Vec::new();
        entry.read_to_end(&mut data)?;
        entries.push(Entry {
            path,
            mode,
            kind,
            data,
        });
    }
    Ok(entries)
}

fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = std::fs::File::create(path).with_context(|| path.display().to_string())?;
    file.write_all(bytes)?;
    Ok(())
}

/// Writes a target's package into `out`; returns the archive's digest.
pub fn write_package(out: &Path, target: &Target, binary: &Path, version: &str) -> Result<String> {
    let bytes = std::fs::read(binary).with_context(|| binary.display().to_string())?;
    if bytes.is_empty() {
        bail!("{} is empty", binary.display());
    }
    std::fs::create_dir_all(out)?;
    // The package directory too, as package-release.sh leaves it.
    let dir = out.join(target.package_dir());
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    let installed = dir.join(&target.binary);
    write(&installed, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755))?;
    }
    write(
        &dir.join("VERSION"),
        version_file(version, &target.platform).as_bytes(),
    )?;

    let archive = archive(target, &bytes, version)?;
    let digest = sha256_hex(&archive);
    let versioned = target.versioned_archive(version);
    let latest = target.latest_archive();
    write(&out.join(&versioned), &archive)?;
    write(&out.join(&latest), &archive)?;
    write(
        &out.join(format!("{versioned}.sha256")),
        checksum_line(&digest, &versioned).as_bytes(),
    )?;
    write(
        &out.join(format!("{latest}.sha256")),
        checksum_line(&digest, &latest).as_bytes(),
    )?;
    write(
        &out.join(target.manifest_name()),
        update_manifest(version, target, &digest).as_bytes(),
    )?;
    Ok(digest)
}

pub fn package_paths(out: &Path, target: &Target, version: &str) -> Vec<PathBuf> {
    let versioned = target.versioned_archive(version);
    let latest = target.latest_archive();
    vec![
        out.join(&versioned),
        out.join(format!("{versioned}.sha256")),
        out.join(&latest),
        out.join(format!("{latest}.sha256")),
        out.join(target.manifest_name()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets;

    fn target(platform: &str) -> Target {
        targets::select(
            &targets::load(&crate::repo_root()).unwrap(),
            &[platform.into()],
        )
        .unwrap()
        .remove(0)
    }

    #[test]
    fn manifest_is_package_release_sh_s() {
        let target = target("linux-x64");
        let digest = "a".repeat(64);
        assert_eq!(
            update_manifest("1.2.3", &target, &digest),
            format!(
                "{{\"schema\":1,\"name\":\"roamgate\",\"version\":\"1.2.3\",\"platform\":\"linux-x64\",\"archive\":\"roamgate-linux-x64.tar.xz\",\"sha256\":\"{digest}\"}}\n"
            )
        );
        assert_eq!(
            version_file("1.2.3", "linux-x64"),
            "roamgate 1.2.3 linux-x64\n"
        );
        assert_eq!(
            checksum_line(&digest, "x.tar.xz"),
            format!("{digest}  x.tar.xz\n")
        );
    }

    #[test]
    fn package_layout() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("bin");
        std::fs::write(&binary, b"\x7fELF fake").unwrap();
        let out = dir.path().join("dist");
        for platform in ["linux-x64", "windows-arm64"] {
            let target = target(platform);
            let digest = write_package(&out, &target, &binary, "9.8.7").unwrap();
            for path in package_paths(&out, &target, "9.8.7") {
                assert!(path.is_file(), "{}", path.display());
            }
            let versioned = std::fs::read(out.join(target.versioned_archive("9.8.7"))).unwrap();
            assert_eq!(
                versioned,
                std::fs::read(out.join(target.latest_archive())).unwrap()
            );
            assert_eq!(sha256_hex(&versioned), digest);
            let entries = read_archive(&versioned).unwrap();
            let names: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
            let dir_name = format!("roamgate-{platform}");
            assert_eq!(
                names,
                [
                    format!("{dir_name}/"),
                    format!("{dir_name}/{}", target.binary),
                    format!("{dir_name}/VERSION")
                ]
            );
            assert_eq!(entries[1].mode, 0o755);
            assert_eq!(entries[1].data, b"\x7fELF fake");
            assert_eq!(
                entries[2].data,
                format!("roamgate 9.8.7 {platform}\n").as_bytes()
            );
        }
    }

    #[test]
    fn system_tar_reads_it() {
        // The updater's `tar -xJf archive -C dir <dir>/VERSION <dir>/roamgate`.
        if std::process::Command::new("tar")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("bin");
        std::fs::write(&binary, b"binary").unwrap();
        let target = target("linux-x64");
        write_package(&dir.path().join("dist"), &target, &binary, "1.0.0").unwrap();
        let extract = dir.path().join("x");
        std::fs::create_dir(&extract).unwrap();
        let status = std::process::Command::new("tar")
            .arg("-xJf")
            .arg(dir.path().join("dist").join(target.latest_archive()))
            .arg("-C")
            .arg(&extract)
            .arg("roamgate-linux-x64/VERSION")
            .arg("roamgate-linux-x64/roamgate")
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read(extract.join("roamgate-linux-x64/roamgate")).unwrap(),
            b"binary"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(extract.join("roamgate-linux-x64/roamgate"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }
}
