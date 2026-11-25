//! targets.toml: the release targets.

use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub platform: String,
    pub triple: String,
    pub os: String,
    pub arch: String,
    pub binary: String,
    pub builder: Builder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cross: Option<Builder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glibc: Option<String>,
    pub runner: String,
    pub check: String,
    pub update: bool,
    pub bun: String,
    /// Whether the last published release's `roamgate update` installs the
    /// target (false: its update proof starts from a build of this
    /// checkout instead).
    #[serde(default = "yes")]
    pub release_updates: bool,
    /// A container image the check also smokes the package in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Builder {
    Cargo,
    Zigbuild,
    Xwin,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    target: Vec<Target>,
}

impl Target {
    /// Whether this machine runs the target's binaries natively.
    pub fn is_host(&self) -> bool {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        os == self.os && arch == self.arch
    }

    /// The builder for this machine: `builder` on the target's OS, else
    /// `cross` when the target names one.
    pub fn builder_here(&self) -> Builder {
        let same_os = match std::env::consts::OS {
            "macos" => self.os == "darwin",
            "windows" => self.os == "win32",
            other => self.os == other,
        };
        if self.builder == Builder::Cargo && !same_os {
            self.cross.unwrap_or(Builder::Zigbuild)
        } else {
            self.builder
        }
    }

    /// The Pi sidecar's executable in the package, beside `binary`
    /// (contract/wire/pi-sidecar.md; the Rust server runs it from there).
    pub fn pi_binary(&self) -> String {
        if self.os == "win32" {
            "roamgate-pi.exe".into()
        } else {
            "roamgate-pi".into()
        }
    }

    pub fn package_dir(&self) -> String {
        format!("roamgate-{}", self.platform)
    }

    pub fn latest_archive(&self) -> String {
        format!("roamgate-{}.tar.xz", self.platform)
    }

    pub fn versioned_archive(&self, version: &str) -> String {
        format!("roamgate-v{version}-{}.tar.xz", self.platform)
    }

    pub fn manifest_name(&self) -> String {
        format!("roamgate-{}.update.json", self.platform)
    }
}

pub fn parse(text: &str) -> Result<Vec<Target>> {
    let file: File = toml::from_str(text)?;
    let mut seen = std::collections::BTreeSet::new();
    for target in &file.target {
        if !seen.insert(target.platform.clone()) {
            bail!("targets.toml: {} is listed twice", target.platform);
        }
        let windows = target.os == "win32";
        if target.binary != if windows { "roamgate.exe" } else { "roamgate" } {
            bail!(
                "targets.toml: {} has binary {}",
                target.platform,
                target.binary
            );
        }
        if target.glibc.is_some() && !target.triple.ends_with("-linux-gnu") {
            bail!(
                "targets.toml: {} is not glibc but names one",
                target.platform
            );
        }
        if !target
            .platform
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            bail!("targets.toml: bad platform name {}", target.platform);
        }
    }
    Ok(file.target)
}

pub fn load(root: &Path) -> Result<Vec<Target>> {
    let path = root.join("targets.toml");
    let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
    parse(&text).with_context(|| path.display().to_string())
}

/// The targets named (platforms, or `all`).
pub fn select(targets: &[Target], names: &[String]) -> Result<Vec<Target>> {
    if names.is_empty() {
        bail!(
            "name a platform or all: {}",
            targets
                .iter()
                .map(|t| t.platform.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if names.iter().any(|name| name == "all") {
        return Ok(targets.to_vec());
    }
    names
        .iter()
        .map(|name| {
            targets
                .iter()
                .find(|target| &target.platform == name)
                .cloned()
                .with_context(|| format!("unknown platform {name}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_targets() -> Vec<Target> {
        load(&crate::repo_root()).unwrap()
    }

    #[test]
    fn the_seven_targets() {
        let targets = repo_targets();
        let names: Vec<_> = targets.iter().map(|t| t.platform.as_str()).collect();
        assert_eq!(
            names,
            [
                "linux-x64",
                "linux-x64-musl",
                "linux-arm64",
                "darwin-x64",
                "darwin-arm64",
                "windows-x64",
                "windows-arm64"
            ]
        );
        for target in &targets {
            assert_eq!(target.bun, format!("bun-{}", target.platform));
            let os = if target.os == "win32" {
                "windows"
            } else {
                &target.os
            };
            assert_eq!(
                format!("{os}-{}", target.arch),
                target.platform.trim_end_matches("-musl")
            );
        }
    }

    #[test]
    fn updatable_platforms_fit_the_updater() {
        // server/src/http/update.ts parseUpdateManifest: /^[a-z0-9]+-[a-z0-9]+$/
        for target in repo_targets().iter().filter(|t| t.update) {
            assert_eq!(target.platform.split('-').count(), 2, "{}", target.platform);
            assert_ne!(target.os, "win32");
        }
    }

    #[test]
    fn rejects_mistakes() {
        let one = r#"[[target]]
platform = "linux-x64"
triple = "x86_64-unknown-linux-gnu"
os = "linux"
arch = "x64"
binary = "roamgate"
builder = "zigbuild"
runner = "ubuntu-latest"
check = "ubuntu-latest"
update = true
bun = "bun-linux-x64"
"#;
        assert!(parse(one).is_ok());
        assert!(parse(&format!("{one}\n{one}")).is_err());
        assert!(parse(&one.replace("\"roamgate\"", "\"roamgate.exe\"")).is_err());
        assert!(parse(&one.replace("zigbuild", "make")).is_err());
        assert!(parse(&format!("{one}extra = 1\n")).is_err());
    }

    #[test]
    fn selects() {
        let targets = repo_targets();
        assert_eq!(
            select(&targets, &["all".into()]).unwrap().len(),
            targets.len()
        );
        let picked = select(&targets, &["darwin-arm64".into()]).unwrap();
        assert_eq!(picked[0].triple, "aarch64-apple-darwin");
        assert!(select(&targets, &["solaris".into()]).is_err());
        assert!(select(&targets, &[]).is_err());
    }
}
