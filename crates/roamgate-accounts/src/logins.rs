//! Sign-ins in progress, and the background upkeep of every account
//! (token refresh, shared MCP logins, `.claude.json` in step).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::oauth::{Endpoints, Http, random_b64url};
use crate::{AccountAgent, AuthState, UserDirs, agy_auth, claude_auth, codex_auth};

/// How long a started sign-in waits for its code.
const LOGIN_TTL: Duration = Duration::from_secs(15 * 60);

/// What a started sign-in asks of the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Started {
    /// Open `url`, then paste back what the page gives (`login` names this
    /// sign-in when it completes).
    Link {
        login: String,
        url: String,
        /// What to paste: the code (Claude) or the page's address (Codex).
        paste: &'static str,
    },
    /// Sign in inside the agent itself, on this account; then check.
    Terminal,
}

enum Pending {
    Claude(claude_auth::PendingClaude),
    Codex(codex_auth::PendingCodex),
}

/// The sign-ins in progress.
pub struct Logins {
    endpoints: Endpoints,
    http: Http,
    agy_program: String,
    pending: Mutex<HashMap<String, (PathBuf, Pending, Instant)>>,
}

impl Default for Logins {
    fn default() -> Self {
        Self::new(Endpoints::default(), "agy")
    }
}

impl Logins {
    pub fn new(endpoints: Endpoints, agy_program: &str) -> Self {
        Self {
            endpoints,
            http: Http::default(),
            agy_program: agy_program.to_owned(),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn endpoints(&self) -> &Endpoints {
        &self.endpoints
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    /// Starts signing the account in `dir` in.
    pub fn start(&self, agent: AccountAgent, dir: &Path) -> Started {
        let (url, pending, paste) = match agent {
            AccountAgent::Claude => {
                let (url, pending) = claude_auth::start(&self.endpoints);
                (url, Pending::Claude(pending), "code")
            }
            AccountAgent::Codex => {
                let (url, pending) = codex_auth::start(&self.endpoints);
                (url, Pending::Codex(pending), "address")
            }
            AccountAgent::Agy => return Started::Terminal,
        };
        let login = random_b64url(16);
        let mut logins = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        logins.retain(|_, (_, _, at)| at.elapsed() < LOGIN_TTL);
        logins.insert(login.clone(), (dir.to_path_buf(), pending, Instant::now()));
        Started::Link { login, url, paste }
    }

    /// Completes a sign-in with what the user pasted; for `agy`, asks it
    /// whether it is signed in now.
    pub async fn complete(
        &self,
        agent: AccountAgent,
        dir: &Path,
        login: Option<&str>,
        pasted: &str,
        now_ms: i64,
    ) -> Result<AuthState, String> {
        if agent == AccountAgent::Agy {
            return Ok(agy_auth::check(&self.agy_program, dir, now_ms).await);
        }
        let pending = {
            let mut logins = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            logins.retain(|_, (_, _, at)| at.elapsed() < LOGIN_TTL);
            let found = login
                .and_then(|login| logins.get(login))
                .filter(|(owner, _, _)| owner == dir)
                .map(|(_, pending, _)| match pending {
                    Pending::Claude(pending) => Pending::Claude(pending.clone()),
                    Pending::Codex(pending) => Pending::Codex(pending.clone()),
                });
            found.ok_or_else(|| "This sign-in is over; start again".to_owned())?
        };
        let done = match (&pending, agent) {
            (Pending::Claude(pending), AccountAgent::Claude) => {
                claude_auth::complete(&self.http, &self.endpoints, pending, pasted, dir, now_ms)
                    .await
            }
            (Pending::Codex(pending), AccountAgent::Codex) => {
                codex_auth::complete(&self.http, &self.endpoints, pending, pasted, dir, now_ms)
                    .await
            }
            _ => Err("This sign-in is for another agent".into()),
        };
        done?;
        if let Some(login) = login {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(login);
        }
        Ok(crate::auth_state(agent, dir))
    }

    /// Signs the account out (Claude, Codex); `agy` is signed out inside
    /// `agy`.
    pub fn logout(&self, agent: AccountAgent, dir: &Path) -> Result<AuthState, String> {
        let done = match agent {
            AccountAgent::Claude => claude_auth::logout(dir),
            AccountAgent::Codex => codex_auth::logout(dir),
            AccountAgent::Agy => {
                return Err("Sign out inside agy, in a session on this account".into());
            }
        };
        done.map_err(|error| format!("The sign-out failed: {error}"))?;
        Ok(crate::auth_state(agent, dir))
    }
}

/// One upkeep pass over the accounts: tokens refreshed when due, MCP
/// logins shared, `.claude.json` kept in step. What it did, for the log.
pub async fn maintain(
    logins: &Logins,
    accounts: &[(AccountAgent, PathBuf)],
    user: &UserDirs,
    data_root: &Path,
    now_ms: i64,
) -> Vec<String> {
    let mut said = Vec::new();
    let mut claude_dirs = Vec::new();
    for (agent, dir) in accounts {
        if !dir.is_dir() {
            continue;
        }
        // Claude Code reads its credentials file again before it uses
        // or refreshes them (clauth relies on the same), so a rotation
        // reaches a running Claude, but for the macOS Keychain. Codex keeps
        // its chain in memory: an account a Codex runs on is left to it.
        let refreshed = match agent {
            AccountAgent::Claude => {
                claude_dirs.push(dir.clone());
                if cfg!(target_os = "macos") && crate::live::in_use(*agent, dir, now_ms) {
                    continue;
                }
                claude_auth::refresh_if_due(logins.http(), logins.endpoints(), dir, now_ms).await
            }
            AccountAgent::Codex => {
                if crate::live::in_use(*agent, dir, now_ms) {
                    continue;
                }
                codex_auth::refresh_if_due(logins.http(), logins.endpoints(), dir, now_ms).await
            }
            AccountAgent::Agy => continue,
        };
        let name = dir.display();
        match refreshed {
            claude_auth::Refresh::Refreshed => said.push(format!("{name}: sign-in refreshed")),
            claude_auth::Refresh::Quarantined => {
                said.push(format!("{name}: sign-in refused, a new sign-in is needed"));
            }
            claude_auth::Refresh::Failed(why) => {
                said.push(format!("{name}: refresh failed: {why}"))
            }
            claude_auth::Refresh::Idle | claude_auth::Refresh::Busy => {}
        }
    }
    if !claude_dirs.is_empty() {
        let stores: Vec<PathBuf> = claude_dirs
            .iter()
            .map(|dir| dir.join(".credentials.json"))
            .collect();
        let record = crate::accounts_root(data_root)
            .join("claude")
            .join(".mcp-sync.json");
        if let Err(error) = crate::mcp_sync::sync_mcp_logins(
            &user.claude_dir.join(".credentials.json"),
            &stores,
            &record,
        ) {
            said.push(format!("MCP logins could not be shared: {error}"));
        }
        let members: Vec<PathBuf> = std::iter::once(user.claude_json.clone())
            .chain(claude_dirs.iter().map(|dir| dir.join(".claude.json")))
            .collect();
        if let Err(error) = crate::json_sync::sync_claude_json(&members) {
            said.push(format!(".claude.json could not be kept in step: {error}"));
        }
    }
    said
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::FakeServer;
    use serde_json::{Value, json};

    #[tokio::test]
    async fn a_sign_in_completes_once_for_its_own_account() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a","refresh_token":"r","expires_in":60}"#.into(),
        )])
        .await;
        let logins = Logins::new(
            Endpoints {
                claude_token: server.url("/token"),
                ..Endpoints::default()
            },
            "agy",
        );
        let temp = tempfile::tempdir().unwrap();
        let (work, perso) = (temp.path().join("work"), temp.path().join("perso"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&perso).unwrap();
        let Started::Link { login, url, paste } = logins.start(AccountAgent::Claude, &work) else {
            panic!("a link");
        };
        assert_eq!(paste, "code");
        let state = url.split("state=").nth(1).unwrap().to_owned();
        let pasted = format!("c#{}", crate::oauth::percent_decode(&state));
        assert!(
            logins
                .complete(AccountAgent::Claude, &perso, Some(&login), &pasted, 0)
                .await
                .is_err()
        );
        assert_eq!(
            logins
                .complete(AccountAgent::Claude, &work, Some(&login), &pasted, 0)
                .await,
            Ok(AuthState::SignedIn)
        );
        assert!(
            logins
                .complete(AccountAgent::Claude, &work, Some(&login), &pasted, 0)
                .await
                .is_err()
        );
        assert_eq!(logins.start(AccountAgent::Agy, &work), Started::Terminal);
        assert!(logins.logout(AccountAgent::Agy, &work).is_err());
        assert_eq!(
            logins.logout(AccountAgent::Claude, &work),
            Ok(AuthState::SignedOut)
        );
    }

    #[tokio::test]
    async fn upkeep_refreshes_and_shares_mcp_logins() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#.into(),
        )])
        .await;
        let logins = Logins::new(
            Endpoints {
                claude_token: server.url("/token"),
                ..Endpoints::default()
            },
            "agy",
        );
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(
            home.join(".claude/.credentials.json"),
            json!({"mcpOAuth": {"gh": {"refreshToken": "g", "expiresAt": 9}}}).to_string(),
        )
        .unwrap();
        let data = temp.path().join("data");
        let dir = crate::account_dir(&data, AccountAgent::Claude, "work");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            json!({"claudeAiOauth": {"refreshToken": "r0", "expiresAt": 0}}).to_string(),
        )
        .unwrap();
        let user = UserDirs::of(&home, &|_| None);
        let said = maintain(
            &logins,
            &[(AccountAgent::Claude, dir.clone())],
            &user,
            &data,
            1,
        )
        .await;
        assert_eq!(said.len(), 1, "{said:?}");
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".credentials.json")).unwrap())
                .unwrap();
        assert_eq!(stored["claudeAiOauth"]["refreshToken"], "r2");
        assert_eq!(stored["mcpOAuth"]["gh"]["refreshToken"], "g");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_codex_account_in_use_is_left_to_codex() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a2","refresh_token":"r2"}"#.into(),
        )])
        .await;
        let logins = Logins::new(
            Endpoints {
                codex_token: server.url("/token"),
                ..Endpoints::default()
            },
            "agy",
        );
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let dir = crate::account_dir(&data, AccountAgent::Codex, "perso");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("auth.json"),
            json!({"tokens": {"refresh_token": "r0"}, "last_refresh": "1970-01-01T00:00:00.000Z"})
                .to_string(),
        )
        .unwrap();
        let user = UserDirs::of(&temp.path().join("home"), &|_| None);
        let accounts = [(AccountAgent::Codex, dir.clone())];
        let mut codex = std::process::Command::new("sleep")
            .arg("30")
            .env("CODEX_HOME", &dir)
            .spawn()
            .unwrap();
        let now = codex_auth::CODEX_REFRESH_AFTER_MS + 1;
        assert!(
            maintain(&logins, &accounts, &user, &data, now)
                .await
                .is_empty()
        );
        assert!(server.requests().await.is_empty());
        codex.kill().unwrap();
        codex.wait().unwrap();
        assert_eq!(
            maintain(&logins, &accounts, &user, &data, now).await.len(),
            1
        );
        assert_eq!(server.requests().await.len(), 1);
    }
}
