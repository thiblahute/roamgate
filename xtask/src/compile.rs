//! Builds the `roamgate` binary of a target, and the Pi sidecar beside it.

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

/// The Bun command line compiling the Pi sidecar `roamgate-pi` for
/// `target` (server/package.json's `compile:pi`, on the target's `bun`).
pub fn pi_command(root: &Path, target: &Target, outfile: &Path) -> Command {
    let mut command = Command::new("bun");
    command
        .args([
            "build",
            "--compile",
            "--minify",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
        ])
        .arg(format!("--target={}", target.bun))
        .arg("src/assistant/pi-sidecar-main.ts")
        .arg("--outfile")
        .arg(outfile)
        .current_dir(root.join("server"));
    command
}

/// Builds `target`'s Pi sidecar; returns it.
pub fn build_pi(root: &Path, target: &Target) -> Result<PathBuf> {
    let dir = target_dir(root).join(&target.triple).join("release");
    std::fs::create_dir_all(&dir)?;
    let outfile = dir.join(target.pi_binary());
    let mut command = pi_command(root, target, &outfile);
    eprintln!(
        "xtask: building the Pi sidecar of {} ({:?})",
        target.platform, command
    );
    let status = command.status().context("running bun")?;
    // Bun leaves its build directories in the working directory.
    if let Ok(entries) = std::fs::read_dir(root.join("server")) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".bun-build") {
                let _ = std::fs::remove_dir_all(entry.path())
                    .or_else(|_| std::fs::remove_file(entry.path()));
            }
        }
    }
    if !status.success() {
        bail!(
            "building the Pi sidecar of {} failed: {status}",
            target.platform
        );
    }
    if !outfile.is_file() {
        bail!("{} was not built", outfile.display());
    }
    Ok(outfile)
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
    fn pi_sidecar_command() {
        let root = crate::repo_root();
        let targets = targets::load(&root).unwrap();
        for (platform, outfile) in [
            ("linux-x64-musl", "roamgate-pi"),
            ("windows-arm64", "roamgate-pi.exe"),
        ] {
            let target = targets::select(&targets, &[platform.into()])
                .unwrap()
                .remove(0);
            assert_eq!(target.pi_binary(), outfile);
            let command = pi_command(&root, &target, Path::new(outfile));
            let args: Vec<String> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(command.get_program(), "bun");
            assert_eq!(
                command.get_current_dir(),
                Some(root.join("server").as_path())
            );
            assert!(args.contains(&format!("--target={}", target.bun)));
            assert!(args.contains(&"src/assistant/pi-sidecar-main.ts".to_owned()));
            assert_eq!(args.last().map(String::as_str), Some(outfile));
        }
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
