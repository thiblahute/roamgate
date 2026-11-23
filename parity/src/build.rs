//! Builds the parity suite needs before a run: the release standalone
//! binary of this checkout (`bun run build:server`, the web assets already
//! built), once per test process and one process at a time.
//!
//! `PARITY_STANDALONE=<path>` names a prebuilt binary instead. The build is
//! skipped when `server/roamgate` is newer than every file of server/src,
//! server/public and shared. It runs under `nice` and `ionice` (the
//! desktop is also a gaming machine).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use anyhow::{Result, anyhow, bail};

use crate::paths::repo_root;

fn newest(dir: &Path) -> SystemTime {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn build() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PARITY_STANDALONE") {
        return Ok(PathBuf::from(path));
    }
    let root = repo_root();
    let binary = root.join("server").join(if cfg!(windows) {
        "roamgate.exe"
    } else {
        "roamgate"
    });
    if !root.join("server/public/index.html").exists() {
        bail!("server/public has no web build: run `bun run build:web` first");
    }
    // One build at a time across test processes: a directory as the lock.
    let lock = root.join("target").join("parity-standalone.lock");
    std::fs::create_dir_all(root.join("target"))?;
    let mut waited = Duration::ZERO;
    while std::fs::create_dir(&lock).is_err() {
        if waited > Duration::from_secs(900) {
            bail!("{} is held for 15 minutes", lock.display());
        }
        std::thread::sleep(Duration::from_millis(200));
        waited += Duration::from_millis(200);
    }
    let result = (|| {
        let built = binary.metadata().and_then(|meta| meta.modified()).ok();
        let sources = [
            newest(&root.join("server/src")),
            newest(&root.join("server/public")),
            newest(&root.join("shared")),
        ]
        .into_iter()
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH);
        if built.is_some_and(|built| built > sources) {
            return Ok(binary.clone());
        }
        let mut command = if cfg!(unix) && Path::new("/usr/bin/nice").exists() {
            let mut command = Command::new("nice");
            command.args(["-n", "19"]);
            if Path::new("/usr/bin/ionice").exists() {
                command.args(["ionice", "-c3"]);
            }
            command.arg("bun");
            command
        } else {
            Command::new("bun")
        };
        let output = command
            .args(["run", "build:server"])
            .current_dir(&root)
            .output()?;
        if !output.status.success() {
            bail!(
                "bun run build:server failed:\n{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(binary.clone())
    })();
    let _ = std::fs::remove_dir(&lock);
    result
}

/// The standalone binary, built if needed.
pub fn standalone() -> Result<PathBuf> {
    static BUILT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    BUILT
        .get_or_init(|| build().map_err(|error| format!("{error:#}")))
        .clone()
        .map_err(|error| anyhow!(error))
}
