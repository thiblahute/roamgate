//! The session signing secret (config/session-secret.ts): independent
//! random material, rotated whenever the set of login credentials changes,
//! kept in a private file under the mkdir lock the Bun server takes too
//! ([`crate::lock`]), so both servers converge on one secret.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::lock::{LockError, LockGuard, LockOptions, lock_path, lock_waiting};
use crate::paths::{DataContext, dirname, resolve};
use crate::private::{create_dir_all_mode, read_private_file, set_mode};

const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(25);
/// As session-secret.ts gives lockSync: never steal the lock on elapsed
/// time alone (the critical section is synchronous and cannot heartbeat
/// through a stalled fsync), refresh it every second.
pub const SESSION_LOCK: LockOptions = LockOptions {
    stale: None,
    update: Duration::from_secs(1),
};
const MAX_STATE_BYTES: u64 = 4096;

#[derive(Debug, thiserror::Error)]
pub enum SessionSecretError {
    #[error("Invalid session signing state lock: {}", .0.display())]
    InvalidLock(PathBuf),
    #[error(
        "Session signing state is locked: {}; if a startup was interrupted, remove this lock only after stopping all processes sharing this state",
        .0.display()
    )]
    Locked(PathBuf),
    #[error("Invalid session signing state in {}", .0.display())]
    InvalidState(PathBuf),
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// HMAC-SHA256 under the secret of the set of credentials: deduplicated,
/// sorted as JavaScript sorts strings (by UTF-16 code units), as JSON, so
/// that concatenations cannot collide and order or duplicates do not count.
pub fn credential_fingerprint(secret: &str, credentials: &[&str]) -> String {
    hex::encode(fingerprint_mac(secret, credentials).finalize().into_bytes())
}

fn fingerprint_mac(secret: &str, credentials: &[&str]) -> Hmac<Sha256> {
    let mut set: Vec<&str> = Vec::new();
    for credential in credentials {
        if !set.contains(credential) {
            set.push(credential);
        }
    }
    set.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let key = hex::decode(secret).unwrap_or_default();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("HMAC takes any key");
    mac.update(b"roamgate:session-credentials:v1\0");
    mac.update(serde_json::to_string(&set).expect("strings").as_bytes());
    mac
}

struct State {
    secret: String,
    fingerprint: String,
}

fn read_state(context: &DataContext, path: &Path) -> Result<Option<State>, SessionSecretError> {
    context.assert_safe_data_path(path)?;
    let Some(bytes) =
        read_private_file(path, MAX_STATE_BYTES, "Invalid session signing state file")?
    else {
        return Ok(None);
    };
    let invalid = || SessionSecretError::InvalidState(path.to_path_buf());
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let object = value.as_object().ok_or_else(invalid)?;
    let version_ok = object.get("version").and_then(Value::as_f64) == Some(1.0);
    let secret = object
        .get("secret")
        .and_then(Value::as_str)
        .filter(|secret| is_hex64(secret));
    let fingerprint = object
        .get("credentialFingerprint")
        .and_then(Value::as_str)
        .filter(|fingerprint| is_hex64(fingerprint));
    match (object.len(), version_ok, secret, fingerprint) {
        (3, true, Some(secret), Some(fingerprint)) => Ok(Some(State {
            secret: secret.to_owned(),
            fingerprint: fingerprint.to_owned(),
        })),
        _ => Err(invalid()),
    }
}

fn acquire(context: &DataContext, path: &Path) -> Result<LockGuard, SessionSecretError> {
    let lock = lock_path(path);
    context.assert_safe_data_path(path)?;
    match std::fs::symlink_metadata(&lock) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(SessionSecretError::InvalidLock(lock));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    match lock_waiting(path, SESSION_LOCK, LOCK_WAIT, LOCK_POLL) {
        Ok(guard) => Ok(guard),
        Err(LockError::Locked(_)) => Err(SessionSecretError::Locked(lock)),
        Err(LockError::Io(error)) => Err(error.into()),
    }
}

/// `<root>/session-secret.json`, or `session-secret-<sha256 of the
/// resolved settings path>.json` when a settings path is given (an empty
/// one counts as none): the settings identify the instance.
pub fn session_secret_path(settings_path: Option<&str>, root: &Path) -> PathBuf {
    let name = match settings_path.filter(|path| !path.is_empty()) {
        Some(settings) => {
            let resolved = resolve(Path::new(settings));
            format!(
                "session-secret-{}.json",
                hex::encode(Sha256::digest(resolved.to_string_lossy().as_bytes()))
            )
        }
        None => "session-secret.json".to_owned(),
    };
    resolve(&root.join(name))
}

/// Where the cookies ended by a logout are kept (`revoked_sessions`), next
/// to the signing secret of the same instance: [`session_secret_path`]
/// with `.revoked.json` for `.json`.
pub fn revoked_sessions_path(settings_path: Option<&str>, root: &Path) -> PathBuf {
    let secret = session_secret_path(settings_path, root);
    let name = secret
        .file_name()
        .map(|name| name.to_string_lossy().replace(".json", ".revoked.json"))
        .unwrap_or_default();
    secret.with_file_name(name)
}

/// [`session_secret_path`] with the settings path the environment gives
/// (`ROAMGATE_SETTINGS_PATH` over `HERDR_GUI_SETTINGS_PATH`), as startup
/// keys it.
pub fn session_secret_path_from_env(env: &dyn crate::env::Env, root: &Path) -> PathBuf {
    session_secret_path(
        crate::env::roamgate_env(env, "SETTINGS_PATH").as_deref(),
        root,
    )
}

/// Discards the secret so the next start signs with fresh material and
/// every browser session ends. False when there was none.
pub fn revoke_session_secret(
    context: &DataContext,
    path: &Path,
) -> Result<bool, SessionSecretError> {
    let path = resolve(path);
    context.assert_safe_data_path(&path)?;
    match std::fs::symlink_metadata(dirname(&path)) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let _guard = acquire(context, &path)?;
    if read_state(context, &path)?.is_none() {
        return Ok(false);
    }
    std::fs::remove_file(&path)?;
    Ok(true)
}

/// The signing secret for these credentials: the stored one while they
/// are the same set, else a fresh random one (never derived from them, so
/// A, then B, then A again cannot revive old cookies).
pub fn load_or_create_session_secret(
    context: &DataContext,
    credentials: &[&str],
    path: &Path,
) -> Result<String, SessionSecretError> {
    let path = resolve(path);
    context.assert_safe_data_path(&path)?;
    create_dir_all_mode(&dirname(&path))?;
    let guard = acquire(context, &path)?;
    set_mode(guard.path(), 0o700)?;
    if let Some(state) = read_state(context, &path)? {
        let expected = hex::decode(&state.fingerprint).unwrap_or_default();
        if fingerprint_mac(&state.secret, credentials)
            .verify_slice(&expected)
            .is_ok()
        {
            return Ok(state.secret);
        }
    }
    let secret = hex::encode(rand::random::<[u8; 32]>());
    let fingerprint = credential_fingerprint(&secret, credentials);
    let text = format!(
        "{{\"version\":1,\"secret\":\"{secret}\",\"credentialFingerprint\":\"{fingerprint}\"}}\n"
    );
    context.replace_data_file(&path, text.as_bytes(), 0o600)?;
    drop(guard);
    Ok(secret)
}

#[cfg(test)]
mod tests;
