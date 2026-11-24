//! Builds the parity suite needs before a run, once per test process:
//! this checkout's debug `roamgate` (the server unless
//! `ROAMGATE_SERVER_CMD` names another), and for a scenario that runs the
//! release binary (`server.command: standalone`) its release build, the
//! web assets already built.
//!
//! `PARITY_STANDALONE=<path>` names a prebuilt release binary instead.
//! Builds run under `nice` and `ionice` (the desktop is also a gaming
//! machine); cargo makes them no-ops when they are up to date.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{Result, anyhow, bail};

use crate::paths::repo_root;

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "roamgate.exe"
    } else {
        "roamgate"
    }
}

fn target_dir() -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join("target"))
}

/// `cargo build -p roamgate --bin roamgate` with `extra`, niced.
fn cargo_build(extra: &[&str]) -> Result<()> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut command = if cfg!(unix) && Path::new("/usr/bin/nice").exists() {
        let mut command = Command::new("nice");
        command.args(["-n", "19"]);
        if Path::new("/usr/bin/ionice").exists() {
            command.args(["ionice", "-c3"]);
        }
        command.arg(&cargo);
        command
    } else {
        Command::new(&cargo)
    };
    let output = command
        .args(["build", "--quiet", "-p", "roamgate", "--bin", "roamgate"])
        .args(extra)
        .current_dir(repo_root())
        .output()?;
    if !output.status.success() {
        bail!(
            "cargo build -p roamgate {} failed:\n{}{}",
            extra.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

/// Where this checkout's debug `roamgate` is.
pub fn server_path() -> PathBuf {
    target_dir().join("debug").join(binary_name())
}

/// This checkout's debug `roamgate`, built once per test process.
pub fn server() -> Result<PathBuf> {
    static BUILT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            cargo_build(&[])
                .map(|()| server_path())
                .map_err(|error| format!("{error:#}"))
        })
        .clone()
        .map_err(|error| anyhow!(error))
}

/// The release binary (`PARITY_STANDALONE`, else this checkout's release
/// build, which embeds server/public), built once per test process.
pub fn standalone() -> Result<PathBuf> {
    static BUILT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("PARITY_STANDALONE") {
                return Ok(PathBuf::from(path));
            }
            if !repo_root().join("server/public/index.html").exists() {
                return Err(
                    "server/public has no web build: run `bun run build:web` first".to_owned(),
                );
            }
            cargo_build(&["--release"])
                .map(|()| target_dir().join("release").join(binary_name()))
                .map_err(|error| format!("{error:#}"))
        })
        .clone()
        .map_err(|error| anyhow!(error))
}
