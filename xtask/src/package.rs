//! The release archive layout, as scripts/package-release.sh makes it for
//! the Bun build and `roamgate update` and the installers read it:
//!
//!   roamgate-v<version>-<platform>.tar.xz  roamgate-<platform>/{roamgate[.exe], roamgate-pi[.exe], VERSION, THIRD_PARTY_LICENSES.md}
//!   roamgate-<platform>.tar.xz             the same bytes
//!
//! (`.zip` instead of `.tar.xz` on Windows: Windows 10's tar.exe reads no
//! xz.)
//!   <archive>.sha256                       "<hex>  <archive>\n"
//!   roamgate-<platform>.update.json        schema 1, one line
//!
//! `roamgate-pi` is the Pi sidecar (contract/wire/pi-sidecar.md), which
//! the Bun build has no need of; the installers and the updater extract
//! `roamgate` and VERSION by name, so the extra file leaves them as they are.
//! THIRD_PARTY_LICENSES.md holds the licences of everything the binaries
//! contain (notices.rs).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use crate::notices;
use crate::targets::Target;

/// What a package holds besides VERSION.
pub struct Files<'a> {
    pub binary: &'a [u8],
    pub pi: &'a [u8],
    /// THIRD_PARTY_LICENSES.md.
    pub notices: &'a str,
}

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

/// The archive bytes of a package: tar.xz, or zip on Windows.
pub fn archive(target: &Target, files: &Files, version: &str) -> Result<Vec<u8>> {
    let dir = target.package_dir();
    let version = version_file(version, &target.platform);
    let entries: [(String, u32, &[u8]); 4] = [
        (format!("{dir}/{}", target.binary), 0o755, files.binary),
        (format!("{dir}/{}", target.pi_binary()), 0o755, files.pi),
        (format!("{dir}/VERSION"), 0o644, version.as_bytes()),
        (
            format!("{dir}/{}", notices::FILE),
            0o644,
            files.notices.as_bytes(),
        ),
    ];
    let mtime = mtime();
    if target.os == "win32" {
        return zip_archive(&dir, &entries, mtime);
    }
    let encoder = xz2::write::XzEncoder::new(Vec::new(), 6);
    let mut builder = tar::Builder::new(encoder);
    builder.mode(tar::HeaderMode::Deterministic);
    let mut entry = header(tar::EntryType::Directory, 0o755, 0, mtime);
    builder.append_data(&mut entry, format!("{dir}/"), std::io::empty())?;
    for (path, mode, data) in entries {
        let mut entry = header(tar::EntryType::Regular, mode, data.len() as u64, mtime);
        builder.append_data(&mut entry, path, data)?;
    }
    let encoder = builder.into_inner()?;
    Ok(encoder.finish()?)
}

/// A zip of the package directory, with Unix modes and `mtime`.
fn zip_archive(dir: &str, entries: &[(String, u32, &[u8])], mtime: u64) -> Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    // zip's DOS time starts in 1980.
    let seconds = i64::try_from(mtime).unwrap_or(0).max(315_532_800);
    let date = zip_time(seconds)?;
    let options = |mode: u32| {
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .compression_level(Some(9))
            .last_modified_time(date)
            .unix_permissions(mode)
            // Unix-made whatever host builds it: zip reads a DOS-made
            // entry's mode as 0664, so a Windows build lost its modes.
            .system(zip::System::Unix)
    };
    writer.add_directory(format!("{dir}/"), options(0o755))?;
    for (path, mode, data) in entries {
        writer.start_file(path.as_str(), options(*mode))?;
        writer.write_all(data)?;
    }
    Ok(writer.finish()?.into_inner())
}

/// A Unix time as zip's DOS date and time (UTC).
fn zip_time(seconds: i64) -> Result<zip::DateTime> {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let narrow = |value: i64| u8::try_from(value).context("zip time");
    zip::DateTime::from_date_and_time(
        u16::try_from(year).context("zip time")?,
        narrow(month)?,
        narrow(day)?,
        narrow(rest / 3600)?,
        narrow(rest % 3600 / 60)?,
        narrow(rest % 60)?,
    )
    .map_err(|error| anyhow::anyhow!("zip time: {error}"))
}

/// One file of an archive.
pub struct Entry {
    pub path: String,
    pub mode: u32,
    pub kind: tar::EntryType,
    pub data: Vec<u8>,
}

/// The entries of a package archive, tar.xz or zip.
pub fn read_archive(bytes: &[u8]) -> Result<Vec<Entry>> {
    if bytes.starts_with(b"PK\x03\x04") {
        return read_zip(bytes);
    }
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

fn read_zip(bytes: &[u8]) -> Result<Vec<Entry>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let path = file.name()?.into_owned();
        let directory = file.is_dir();
        let mode = file.unix_mode().unwrap_or(0) & 0o7777;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        entries.push(Entry {
            path,
            mode,
            kind: if directory {
                tar::EntryType::Directory
            } else {
                tar::EntryType::Regular
            },
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

/// Writes a target's package into `out`, with its Pi sidecar `pi` and
/// its THIRD_PARTY_LICENSES.md `notices`; returns the archive's digest.
pub fn write_package(
    out: &Path,
    target: &Target,
    binary: &Path,
    pi: &Path,
    notices: &str,
    version: &str,
) -> Result<String> {
    let bytes = std::fs::read(binary).with_context(|| binary.display().to_string())?;
    if bytes.is_empty() {
        bail!("{} is empty", binary.display());
    }
    let pi_bytes = std::fs::read(pi).with_context(|| pi.display().to_string())?;
    if pi_bytes.is_empty() {
        bail!("{} is empty", pi.display());
    }
    std::fs::create_dir_all(out)?;
    // The package directory too, as package-release.sh leaves it.
    let dir = out.join(target.package_dir());
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    for (name, data) in [(&target.binary, &bytes), (&target.pi_binary(), &pi_bytes)] {
        let installed = dir.join(name);
        write(&installed, data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    write(
        &dir.join("VERSION"),
        version_file(version, &target.platform).as_bytes(),
    )?;
    write(&dir.join(notices::FILE), notices.as_bytes())?;

    let files = Files {
        binary: &bytes,
        pi: &pi_bytes,
        notices,
    };
    let archive = archive(target, &files, version)?;
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
        let pi = dir.path().join("pi");
        std::fs::write(&pi, b"\x7fELF pi").unwrap();
        let out = dir.path().join("dist");
        for platform in ["linux-x64", "windows-arm64"] {
            let target = target(platform);
            let digest =
                write_package(&out, &target, &binary, &pi, "# notices\n", "9.8.7").unwrap();
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
                    format!("{dir_name}/{}", target.pi_binary()),
                    format!("{dir_name}/VERSION"),
                    format!("{dir_name}/THIRD_PARTY_LICENSES.md"),
                ]
            );
            assert_eq!(entries[4].mode, 0o644);
            assert_eq!(entries[4].data, b"# notices\n");
            assert_eq!(entries[1].mode, 0o755);
            assert_eq!(entries[1].data, b"\x7fELF fake");
            assert_eq!(entries[2].mode, 0o755);
            assert_eq!(entries[2].data, b"\x7fELF pi");
            assert_eq!(
                entries[3].data,
                format!("roamgate 9.8.7 {platform}\n").as_bytes()
            );
        }
    }

    #[test]
    fn zip_times_are_utc_civil_dates() {
        let time = zip_time(1_795_590_489).unwrap();
        assert_eq!((time.year(), time.month(), time.day()), (2026, 11, 25));
        assert_eq!((time.hour(), time.minute(), time.second()), (7, 8, 8));
        let leap = zip_time(951_782_400).unwrap();
        assert_eq!((leap.year(), leap.month(), leap.day()), (2000, 2, 29));
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
        let pi = dir.path().join("pi");
        std::fs::write(&pi, b"pi").unwrap();
        let target = target("linux-x64");
        write_package(
            &dir.path().join("dist"),
            &target,
            &binary,
            &pi,
            "n",
            "1.0.0",
        )
        .unwrap();
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
