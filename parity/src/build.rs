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

/// This checkout's debug `roamgate`, built once per test process, as a
/// copy of its own that no later build replaces ([`stable_copy`]).
pub fn server() -> Result<PathBuf> {
    static BUILT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            cargo_build(&[])
                .and_then(|()| stable_copy(&server_path()))
                .map_err(|error| format!("{error:#}"))
        })
        .clone()
        .map_err(|error| anyhow!(error))
}

/// A copy of `binary` named for its size and time, made once: every test
/// process builds the server (cargo, a no-op once fresh, may still put it
/// in place again), and a running server's own executable must stay: the
/// agent clients it installs (`roamgate-review`, `roamgate-hold`) are
/// links to it, run by the scenarios' panes while other processes build.
fn stable_copy(binary: &Path) -> Result<PathBuf> {
    let meta = std::fs::metadata(binary)?;
    let stamp = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|age| age.as_nanos())
        .unwrap_or(0);
    let dir = binary
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("parity-server");
    std::fs::create_dir_all(&dir)?;
    let name = format!(
        "roamgate-{}-{stamp}{}",
        meta.len(),
        std::env::consts::EXE_SUFFIX
    );
    let copy = dir.join(&name);
    if !copy.exists() {
        let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));
        std::fs::copy(binary, &temp)?;
        if std::fs::rename(&temp, &copy).is_err() {
            // Another process made it meanwhile.
            let _ = std::fs::remove_file(&temp);
        }
    }
    // Copies of builds a day old go (best effort: one may still run).
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(24 * 3600));
        if old && entry.path() != copy {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(copy)
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
