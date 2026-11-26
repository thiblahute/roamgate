//! Small file helpers of the account directories: JSON objects read and
//! written private (0600) through a rename, Roamgate's own state beside an
//! account's (`<dir>/.roamgate/`), a lock, and token fingerprints.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// A JSON object file, or None (missing, being written, not an object).
pub(crate) fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text).ok()? {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

/// Writes 0600 through a temporary file renamed into place. A link at
/// `path` is written through (its target replaced), never replaced by a
/// file.
pub(crate) fn write_private(path: &Path, value: &Map<String, Value>) -> io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    write_private_bytes(path, text.as_bytes())
}

pub(crate) fn write_private_bytes(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".roamgate-tmp");
    let temporary = path.with_file_name(name);
    std::fs::write(&temporary, bytes)?;
    roamgate_base::private::set_mode(&temporary, 0o600)?;
    std::fs::rename(&temporary, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

/// Roamgate's own files of an account: `<dir>/.roamgate/`.
pub(crate) fn state_dir(dir: &Path) -> PathBuf {
    dir.join(".roamgate")
}

pub(crate) fn state_file(dir: &Path, name: &str) -> io::Result<PathBuf> {
    let state = state_dir(dir);
    roamgate_base::private::create_private_dir(&state)?;
    Ok(state.join(name))
}

/// The first 8 bytes of a token's SHA-256, in hex: what Roamgate's own
/// records keep instead of a token.
pub fn fingerprint(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes())[..8])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A lock file held while Roamgate rotates an account's tokens: one
/// writer at a time, across Roamgate's processes. One older than
/// [`LOCK_STALE`] was left by a process that died and is taken over.
pub(crate) struct DirLock(PathBuf);

const LOCK_STALE: Duration = Duration::from_secs(120);

impl DirLock {
    /// The lock, or None when another writer holds it.
    pub(crate) fn try_take(dir: &Path, name: &str) -> io::Result<Option<Self>> {
        let path = state_file(dir, name)?;
        for _ in 0..2 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Some(Self(path))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|meta| meta.modified())
                        .ok()
                        .and_then(|at| at.elapsed().ok())
                        .is_some_and(|age| age > LOCK_STALE);
                    if !stale {
                        return Ok(None);
                    }
                    let _ = std::fs::remove_file(&path);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }
}

impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A refresh chain that died: the fingerprint of the refresh token the
/// endpoint refused, and why. Refreshing stops until a new sign-in.
pub(crate) fn quarantine(dir: &Path, token: &str, why: &str, now_ms: i64) -> io::Result<()> {
    let mut record = Map::new();
    record.insert("fingerprint".into(), fingerprint(token).into());
    record.insert("why".into(), why.into());
    record.insert("at".into(), roamgate_base::log::iso_millis(now_ms).into());
    write_private(&state_file(dir, "quarantine.json")?, &record)
}

/// Whether the refresh token is the one a quarantine names.
pub(crate) fn quarantined(dir: &Path, token: &str) -> bool {
    read_object(&state_dir(dir).join("quarantine.json"))
        .and_then(|record| record.get("fingerprint")?.as_str().map(str::to_owned))
        .is_some_and(|recorded| recorded == fingerprint(token))
}

pub(crate) fn clear_quarantine(dir: &Path) {
    let _ = std::fs::remove_file(state_dir(dir).join("quarantine.json"));
}

/// Keeps the last sign-in that worked before it is replaced.
pub(crate) fn record_last_known_good(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    write_private_bytes(&state_file(dir, name)?, bytes)
}
