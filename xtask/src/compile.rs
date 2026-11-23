//! Builds the `roamgate` binary of a target.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::targets::{Builder, Target};

pub struct Build<'a> {
    pub root: &'a Path,
    pub version: &'a str,
    /// The web app the binary embeds (its index.html checked).
    pub web: &'a Path,
    pub builder: Option<Builder>,
}

pub fn target_dir(root: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target"))
}

pub fn check_web(web: &Path) -> Result<PathBuf> {
    if !web.join("index.html").is_file() {
        bail!(
            "{} has no index.html: build the web app first (cargo xtask web, or bun run build:web)",
            web.display()
        );
    }
    Ok(web.canonicalize()?)
}

/// The cargo command line building `target`.
pub fn command(build: &Build, target: &Target, web: &Path) -> Command {
    let builder = build.builder.unwrap_or_else(|| target.builder_here());
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    let triple = match (builder, &target.glibc) {
        (Builder::Zigbuild, Some(glibc)) => format!("{}.{glibc}", target.triple),
        _ => target.triple.clone(),
    };
    match builder {
        Builder::Cargo => command.arg("build"),
        Builder::Zigbuild => command.arg("zigbuild"),
        Builder::Xwin => command.args(["xwin", "build"]),
    };
    command
        .args([
            "--release",
            "--locked",
            "--package",
            "roamgate",
            "--target",
            &triple,
        ])
        .current_dir(build.root)
        .env("ROAMGATE_WEB_DIST", web)
        .env("ROAMGATE_BUILD_VERSION", build.version);
    command
}

/// Builds `target`; returns the binary.
pub fn build(build: &Build, target: &Target) -> Result<PathBuf> {
    let web = check_web(build.web)?;
    let mut command = command(build, target, &web);
    eprintln!("xtask: building {} ({:?})", target.platform, command);
    let status = command.status().context("running cargo")?;
    if !status.success() {
        bail!("building {} failed: {status}", target.platform);
    }
    let binary = target_dir(build.root)
        .join(&target.triple)
        .join("release")
        .join(&target.binary);
    if !binary.is_file() {
        bail!("{} was not built", binary.display());
    }
    Ok(binary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets;

    fn args(platform: &str, builder: Option<Builder>) -> Vec<String> {
        let root = crate::repo_root();
        let targets = targets::load(&root).unwrap();
        let target = targets::select(&targets, &[platform.into()])
            .unwrap()
            .remove(0);
        let build = Build {
            root: &root,
            version: "1.0.0",
            web: &root,
            builder,
        };
        command(&build, &target, &root)
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn zigbuild_pins_glibc() {
        let args = args("linux-arm64", None);
        assert_eq!(args[0], "zigbuild");
        assert!(
            args.contains(&"aarch64-unknown-linux-gnu.2.28".to_owned()),
            "{args:?}"
        );
        assert!(args.contains(&"--locked".to_owned()));
    }

    #[test]
    fn builders() {
        assert_eq!(args("windows-x64", None)[..2], ["xwin", "build"]);
        assert_eq!(args("linux-x64-musl", None)[0], "zigbuild");
        assert!(args("linux-x64-musl", None).contains(&"x86_64-unknown-linux-musl".to_owned()));
        let darwin = args("darwin-arm64", Some(Builder::Cargo));
        assert_eq!(darwin[0], "build");
        assert!(darwin.contains(&"aarch64-apple-darwin".to_owned()));
    }
}
