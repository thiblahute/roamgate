//! Login cookies ended by a logout before they expire (TS
//! config/revoked-sessions.ts): the SHA-256 of each, never the cookie
//! itself, with its expiry in epoch seconds, kept next to the session
//! signing secret (`session_secret::revoked_sessions_path`) so a restart
//! does not bring them back. An entry goes once its cookie has expired
//! anyway; past [`MAX_REVOKED_SESSIONS`] the soonest to expire go.
//!
//! The file: `{"version":1,"revoked":{"<sha256 hex>":<expiry>}}`, 0600.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::paths::DataContext;

/// At most this many cookies are kept.
pub const MAX_REVOKED_SESSIONS: usize = 10_000;

/// The ended cookies, by the SHA-256 of each.
pub struct RevokedSessions {
    context: Option<DataContext>,
    path: Option<PathBuf>,
    revoked: BTreeMap<String, i64>,
}

fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl RevokedSessions {
    /// Those kept at `path`, none when it is missing or unreadable (said on
    /// stderr, as Bun's does). `None`: memory only.
    pub fn open(context: Option<DataContext>, path: Option<&Path>) -> Self {
        let mut revoked = BTreeMap::new();
        if let (Some(context), Some(path)) = (&context, path) {
            let text = context
                .assert_safe_data_path(path)
                .and_then(|()| std::fs::read_to_string(path));
            match text {
                Ok(text) => match serde_json::from_str::<Value>(&text) {
                    Ok(state) if state["version"] == 1 && state["revoked"].is_object() => {
                        for (hash, expiry) in state["revoked"].as_object().into_iter().flatten() {
                            if let Some(expiry) = expiry.as_i64().filter(|_| is_hex64(hash)) {
                                revoked.insert(hash.clone(), expiry);
                            }
                        }
                    }
                    _ => eprintln!(
                        "[auth] ignoring the unreadable ended logins in {}",
                        path.display()
                    ),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => eprintln!("[auth] could not read the ended logins: {error}"),
            }
        }
        RevokedSessions {
            context,
            path: path.map(Path::to_path_buf),
            revoked,
        }
    }

    /// Whether `token` was ended and would still be valid at `now` (seconds).
    pub fn has(&self, token: &str, now: i64) -> bool {
        self.revoked
            .get(&digest(token))
            .is_some_and(|expiry| *expiry > now)
    }

    /// Ends `token`, valid until `expires_at` (seconds), and keeps the list.
    pub fn add(&mut self, token: &str, expires_at: i64, now: i64) {
        self.revoked.insert(digest(token), expires_at);
        self.revoked.retain(|_, expiry| *expiry > now);
        if self.revoked.len() > MAX_REVOKED_SESSIONS {
            let mut soonest: Vec<(String, i64)> =
                self.revoked.iter().map(|(k, v)| (k.clone(), *v)).collect();
            soonest.sort_by_key(|(_, expiry)| *expiry);
            for (hash, _) in soonest
                .into_iter()
                .take(self.revoked.len() - MAX_REVOKED_SESSIONS)
            {
                self.revoked.remove(&hash);
            }
        }
        let (Some(context), Some(path)) = (&self.context, &self.path) else {
            return;
        };
        let revoked: Map<String, Value> = self
            .revoked
            .iter()
            .map(|(hash, expiry)| (hash.clone(), json!(expiry)))
            .collect();
        let text = format!("{}\n", json!({"version": 1, "revoked": revoked}));
        if let Err(error) = context.replace_data_file(path, text.as_bytes(), 0o600) {
            // The logout still holds until a restart.
            eprintln!("[auth] could not keep an ended login: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Platform;
    use crate::session_secret::{revoked_sessions_path, session_secret_path};

    fn context(home: &Path) -> DataContext {
        DataContext::new(
            home,
            Platform::current(),
            Some(home.join("AppData/Roaming")),
        )
    }

    #[test]
    fn sits_next_to_the_signing_secret() {
        let root = Path::new("/d");
        assert_eq!(
            revoked_sessions_path(None, root),
            Path::new("/d/session-secret.revoked.json")
        );
        let secret = session_secret_path(Some("/s.json"), root);
        assert_eq!(
            revoked_sessions_path(Some("/s.json"), root),
            PathBuf::from(secret.to_string_lossy().replace(".json", ".revoked.json"))
        );
    }

    #[test]
    fn an_ended_cookie_is_forgotten_once_it_would_have_expired_anyway() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("data/session-secret.revoked.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut revoked = RevokedSessions::open(Some(context(home.path())), Some(&path));
        revoked.add("a", 2_000, 1_000);
        assert!(revoked.has("a", 1_000));
        assert!(!revoked.has("b", 1_000));
        assert!(!revoked.has("a", 2_000));
        revoked.add("b", 3_000, 2_000);
        let state: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(state["version"], 1);
        let expiries: Vec<&Value> = state["revoked"].as_object().unwrap().values().collect();
        assert_eq!(expiries, vec![&json!(3_000)]);
        // Read back after a restart; the cookie itself is never written.
        let again = RevokedSessions::open(Some(context(home.path())), Some(&path));
        assert!(again.has("b", 2_000));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("\"b\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn keeps_the_latest_to_expire_past_its_bound() {
        let mut revoked = RevokedSessions::open(None, None);
        for index in 0..=MAX_REVOKED_SESSIONS {
            revoked.add(&format!("t{index}"), 10 + index as i64, 0);
        }
        assert!(!revoked.has("t0", 0));
        assert!(revoked.has("t1", 0));
        assert!(revoked.has(&format!("t{MAX_REVOKED_SESSIONS}"), 0));
    }

    #[test]
    fn an_unreadable_file_is_ignored() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("data/session-secret.revoked.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{nope").unwrap();
        assert!(!RevokedSessions::open(Some(context(home.path())), Some(&path)).has("a", 0));
    }
}
