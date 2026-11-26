//! A Claude account's sign-in and its token refresh, in the account's own
//! `.credentials.json` (Claude Code's format: `claudeAiOauth`).
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy): src/oauth_login.rs (the authorize URL with
//! Claude Code's client, scopes and manual redirect, the pasted
//! `code#state` check, the minted credentials) and src/oauth.rs (the token
//! exchange and refresh bodies, the canonical scope order, and which
//! refusals mean the refresh token is dead).
//!
//! Only the paste door is used: the link opens in the user's own browser,
//! wherever it is, and the page it lands on shows the code to paste back.
//!
//! Refresh rules: Roamgate refreshes an account's tokens when they expire
//! within [`REFRESH_LEAD_MS`], well before Claude Code would itself, under
//! the account's lock and after reading the file again (another writer may
//! have refreshed meanwhile), so Claude Code always finds fresh tokens in
//! the file. A refusal that says the refresh token is dead quarantines it:
//! the account needs a new sign-in, and is never refreshed with it again.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::AuthState;
use crate::files::{
    DirLock, clear_quarantine, quarantine, quarantined, read_object, write_private,
};
use crate::oauth::{Endpoints, Http, new_pkce, percent_encode, random_b64url};

/// Claude Code's OAuth client.
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// The page the authorize step lands on, showing the code to paste.
pub const MANUAL_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";

/// The scopes Claude Code asks for at sign-in.
const SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// The scopes sent with a refresh when the credentials name none.
const REFRESH_SCOPES_FALLBACK: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Claude Code sends the refresh scopes in this order.
const CANONICAL_SCOPE_ORDER: [&str; 6] = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

/// Refresh when the access token expires within this (ms).
pub const REFRESH_LEAD_MS: i64 = 20 * 60 * 1000;

/// The longest pasted code accepted.
const MANUAL_CODE_MAX: usize = 4096;

const CREDENTIALS: &str = ".credentials.json";
const OAUTH_KEY: &str = "claudeAiOauth";

fn canonical_scopes(scopes: &str) -> String {
    let present: Vec<&str> = scopes.split_whitespace().collect();
    let mut out: Vec<&str> = CANONICAL_SCOPE_ORDER
        .iter()
        .copied()
        .filter(|scope| present.contains(scope))
        .collect();
    out.extend(
        present
            .iter()
            .filter(|scope| !CANONICAL_SCOPE_ORDER.contains(scope)),
    );
    out.join(" ")
}

/// A sign-in started: what its pasted code is checked against and
/// exchanged with. Never shown.
#[derive(Clone)]
pub struct PendingClaude {
    verifier: String,
    state: String,
}

impl std::fmt::Debug for PendingClaude {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingClaude(..)")
    }
}

/// Starts a sign-in: the link to open, and what completes it.
pub fn start(endpoints: &Endpoints) -> (String, PendingClaude) {
    let (verifier, challenge) = new_pkce();
    let state = random_b64url(32);
    let url = format!(
        "{}?code=true&client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        endpoints.claude_authorize,
        percent_encode(CLIENT_ID),
        percent_encode(MANUAL_REDIRECT_URI),
        percent_encode(SCOPES).replace("%20", "+"),
        percent_encode(&challenge),
        percent_encode(&state),
    );
    (url, PendingClaude { verifier, state })
}

/// The code of a pasted `code#state`, when it belongs to this sign-in.
pub fn parse_pasted(pasted: &str, pending: &PendingClaude) -> Result<String, String> {
    let pasted = pasted.trim();
    if pasted.is_empty() {
        return Err("No code was entered".into());
    }
    if pasted.len() > MANUAL_CODE_MAX {
        return Err(
            "That is far longer than a sign-in code; paste only the code the page shows".into(),
        );
    }
    let Some((code, state)) = pasted.split_once('#') else {
        return Err("Paste the whole code the page shows, with its #".into());
    };
    if code.is_empty() || state.is_empty() {
        return Err("Paste the whole code the page shows, with its #".into());
    }
    if state != pending.state {
        return Err("That code is from another sign-in; start again".into());
    }
    Ok(code.to_owned())
}

/// Why a token request failed; never carries the server's words.
#[derive(Debug, PartialEq, Eq)]
enum TokenError {
    /// The refresh token is dead (a new sign-in is needed).
    Dead,
    Other(String),
}

/// The token endpoint's answer: access, refresh, lifetime (s), scopes.
struct Minted {
    access: String,
    refresh: String,
    expires_in: i64,
    scope: Option<String>,
}

fn minted(status: u16, text: &str) -> Result<Minted, TokenError> {
    if (matches!(status, 400 | 403) && text.contains("invalid_grant")) || status == 401 {
        return Err(TokenError::Dead);
    }
    if status >= 400 {
        return Err(TokenError::Other(format!(
            "The sign-in server refused (HTTP {status})"
        )));
    }
    let value: Value = serde_json::from_str(text)
        .map_err(|_| TokenError::Other("The sign-in server's answer did not parse".into()))?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(Minted {
        access: text("access_token")
            .ok_or_else(|| TokenError::Other("The sign-in server gave no token".into()))?,
        refresh: text("refresh_token")
            .ok_or_else(|| TokenError::Other("The sign-in server gave no token".into()))?,
        expires_in: value
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(3600),
        scope: text("scope"),
    })
}

fn credentials_path(dir: &Path) -> std::path::PathBuf {
    dir.join(CREDENTIALS)
}

/// Writes the minted tokens into the account's `.credentials.json`,
/// keeping what else it holds (MCP logins, Claude Code's own keys).
fn store(dir: &Path, minted: Minted, now_ms: i64) -> std::io::Result<()> {
    let path = credentials_path(dir);
    let mut credentials = read_object(&path).unwrap_or_default();
    let mut oauth = credentials
        .get(OAUTH_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    oauth.insert("accessToken".into(), json!(minted.access));
    oauth.insert("refreshToken".into(), json!(minted.refresh));
    oauth.insert("expiresAt".into(), json!(now_ms + minted.expires_in * 1000));
    if let Some(scope) = minted.scope {
        oauth.insert(
            "scopes".into(),
            json!(scope.split_whitespace().collect::<Vec<_>>()),
        );
    }
    oauth.entry("subscriptionType").or_insert(Value::Null);
    credentials.insert(OAUTH_KEY.into(), Value::Object(oauth));
    write_private(&path, &credentials)
}

fn oauth_of(dir: &Path) -> Option<Map<String, Value>> {
    read_object(&credentials_path(dir))?
        .get(OAUTH_KEY)?
        .as_object()
        .cloned()
}

/// Completes a sign-in with the pasted `code#state`: exchanges the code
/// and stores the account's tokens.
pub async fn complete(
    http: &Http,
    endpoints: &Endpoints,
    pending: &PendingClaude,
    pasted: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<(), String> {
    let code = parse_pasted(pasted, pending)?;
    let body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": MANUAL_REDIRECT_URI,
        "code_verifier": pending.verifier,
        "client_id": CLIENT_ID,
        "state": pending.state,
    });
    let (status, text) = http
        .post(
            &endpoints.claude_token,
            "application/json",
            body.to_string(),
        )
        .await?;
    let minted = minted(status, &text).map_err(|error| match error {
        TokenError::Dead => "The sign-in server refused the code; start again".to_owned(),
        TokenError::Other(message) => message,
    })?;
    store(dir, minted, now_ms)
        .map_err(|error| format!("The sign-in could not be saved: {error}"))?;
    clear_quarantine(dir);
    // The previous account's identity goes: Claude Code reads the new one.
    let claude_json = dir.join(".claude.json");
    if let Some(mut config) = read_object(&claude_json)
        && config.shift_remove("oauthAccount").is_some()
    {
        let _ = write_private(&claude_json, &config);
    }
    Ok(())
}

/// What a refresh pass did.
#[derive(Debug, PartialEq, Eq)]
pub enum Refresh {
    /// No sign-in, quarantined, or not due.
    Idle,
    /// Another writer holds the lock, or refreshed meanwhile.
    Busy,
    Refreshed,
    /// The refresh token is dead: a new sign-in is needed.
    Quarantined,
    Failed(String),
}

/// Refreshes the account's tokens when they expire within
/// [`REFRESH_LEAD_MS`].
pub async fn refresh_if_due(
    http: &Http,
    endpoints: &Endpoints,
    dir: &Path,
    now_ms: i64,
) -> Refresh {
    let due = |oauth: &Map<String, Value>| {
        let refresh = oauth.get("refreshToken").and_then(Value::as_str)?;
        let expires = oauth.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
        (expires - now_ms <= REFRESH_LEAD_MS && !quarantined(dir, refresh))
            .then(|| refresh.to_owned())
    };
    if oauth_of(dir).as_ref().and_then(due).is_none() {
        return Refresh::Idle;
    }
    let Ok(Some(_lock)) = DirLock::try_take(dir, "claude-refresh.lock") else {
        return Refresh::Busy;
    };
    // Read again under the lock: another writer may have refreshed.
    let Some(oauth) = oauth_of(dir) else {
        return Refresh::Idle;
    };
    let Some(refresh) = due(&oauth) else {
        return Refresh::Busy;
    };
    let scopes = oauth
        .get("scopes")
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|scopes| !scopes.is_empty());
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": CLIENT_ID,
        "scope": canonical_scopes(scopes.as_deref().unwrap_or(REFRESH_SCOPES_FALLBACK)),
    });
    let answer = match http
        .post(
            &endpoints.claude_token,
            "application/json",
            body.to_string(),
        )
        .await
    {
        Ok((status, text)) => minted(status, &text),
        Err(message) => Err(TokenError::Other(message)),
    };
    match answer {
        Ok(minted) => match store(dir, minted, now_ms) {
            Ok(()) => Refresh::Refreshed,
            Err(error) => {
                Refresh::Failed(format!("The refreshed sign-in could not be saved: {error}"))
            }
        },
        Err(TokenError::Dead) => {
            // Claude Code may have refreshed it itself meanwhile.
            let now = oauth_of(dir)
                .and_then(|oauth| oauth.get("refreshToken")?.as_str().map(str::to_owned));
            if now.as_deref() != Some(refresh.as_str()) {
                return Refresh::Busy;
            }
            let _ = quarantine(dir, &refresh, "refused", now_ms);
            Refresh::Quarantined
        }
        Err(TokenError::Other(message)) => Refresh::Failed(message),
    }
}

/// Signs the account out: its tokens go, its MCP logins stay.
pub fn logout(dir: &Path) -> std::io::Result<()> {
    let path = credentials_path(dir);
    if let Some(mut credentials) = read_object(&path)
        && credentials.shift_remove(OAUTH_KEY).is_some()
    {
        write_private(&path, &credentials)?;
    }
    clear_quarantine(dir);
    let claude_json = dir.join(".claude.json");
    if let Some(mut config) = read_object(&claude_json)
        && config.shift_remove("oauthAccount").is_some()
    {
        write_private(&claude_json, &config)?;
    }
    Ok(())
}

/// The account's sign-in state from its credentials.
pub fn auth_state(dir: &Path) -> AuthState {
    match oauth_of(dir).and_then(|oauth| oauth.get("refreshToken")?.as_str().map(str::to_owned)) {
        Some(refresh) if quarantined(dir, &refresh) => AuthState::NeedsRelogin,
        Some(_) => AuthState::SignedIn,
        None => AuthState::SignedOut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::FakeServer;

    fn endpoints(server: &FakeServer) -> Endpoints {
        Endpoints {
            claude_token: server.url("/v1/oauth/token"),
            ..Endpoints::default()
        }
    }

    #[test]
    fn the_link_is_claude_code_s_with_the_paste_page() {
        let (url, pending) = start(&Endpoints::default());
        assert!(
            url.starts_with("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a")
        );
        assert!(
            url.contains(
                "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
            )
        );
        assert!(url.contains("scope=org%3Acreate_api_key+user%3Aprofile"));
        assert!(url.contains(&format!("state={}", pending.state)));
        assert!(!url.contains(&pending.verifier));
        assert_eq!(
            parse_pasted(&format!(" abc#{} ", pending.state), &pending),
            Ok("abc".into())
        );
        assert!(parse_pasted("abc#other", &pending).is_err());
        assert!(parse_pasted("abc", &pending).is_err());
        assert!(parse_pasted("", &pending).is_err());
    }

    #[tokio::test]
    async fn a_sign_in_stores_the_tokens_and_keeps_mcp_logins() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a1","refresh_token":"r1","expires_in":3600,"scope":"user:profile user:inference"}"#.into(),
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"mcpOAuth":{"s":{"accessToken":"m"}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join(".claude.json"),
            r#"{"oauthAccount":{"e":"old"},"tips":1}"#,
        )
        .unwrap();
        assert_eq!(auth_state(dir), AuthState::SignedOut);
        let (_, pending) = start(&endpoints(&server));
        complete(
            &Http::default(),
            &endpoints(&server),
            &pending,
            &format!("the-code#{}", pending.state),
            dir,
            1_000,
        )
        .await
        .unwrap();
        let request = server.requests().await.remove(0);
        assert_eq!(request.path, "/v1/oauth/token");
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["code"], "the-code");
        assert_eq!(body["code_verifier"], pending.verifier);
        assert_eq!(body["redirect_uri"], MANUAL_REDIRECT_URI);
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".credentials.json")).unwrap())
                .unwrap();
        assert_eq!(stored["mcpOAuth"]["s"]["accessToken"], "m");
        assert_eq!(stored["claudeAiOauth"]["accessToken"], "a1");
        assert_eq!(stored["claudeAiOauth"]["refreshToken"], "r1");
        assert_eq!(stored["claudeAiOauth"]["expiresAt"], 3_601_000);
        assert_eq!(
            stored["claudeAiOauth"]["scopes"],
            json!(["user:profile", "user:inference"])
        );
        assert!(
            !std::fs::read_to_string(dir.join(".claude.json"))
                .unwrap()
                .contains("oauthAccount")
        );
        assert_eq!(auth_state(dir), AuthState::SignedIn);

        logout(dir).unwrap();
        assert_eq!(auth_state(dir), AuthState::SignedOut);
        assert!(
            std::fs::read_to_string(dir.join(".credentials.json"))
                .unwrap()
                .contains("mcpOAuth")
        );
    }

    fn signed_in(dir: &Path, expires_at: i64) {
        std::fs::write(
            dir.join(".credentials.json"),
            json!({"claudeAiOauth": {
                "accessToken": "a0", "refreshToken": "r0", "expiresAt": expires_at,
                "scopes": ["user:inference", "user:profile"], "rateLimitTier": "t",
            }})
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn tokens_are_refreshed_before_they_expire_and_only_then() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a2","refresh_token":"r2","expires_in":7200}"#.into(),
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let http = Http::default();
        let now = 10_000_000;
        signed_in(dir, now + REFRESH_LEAD_MS + 60_000);
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, now).await,
            Refresh::Idle
        );
        assert!(server.requests().await.is_empty());

        signed_in(dir, now + 60_000);
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, now).await,
            Refresh::Refreshed
        );
        let body: Value = serde_json::from_str(&server.requests().await[0].body).unwrap();
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["refresh_token"], "r0");
        // Claude Code's order, whatever the file's.
        assert_eq!(body["scope"], "user:profile user:inference");
        let oauth = oauth_of(dir).unwrap();
        assert_eq!(oauth["refreshToken"], "r2");
        assert_eq!(oauth["expiresAt"], now + 7_200_000);
        // Claude Code's own keys stay.
        assert_eq!(oauth["rateLimitTier"], "t");
    }

    #[tokio::test]
    async fn a_dead_refresh_token_is_quarantined_once() {
        let server = FakeServer::start(vec![(400, r#"{"error":"invalid_grant"}"#.into())]).await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let http = Http::default();
        signed_in(dir, 0);
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, 1).await,
            Refresh::Quarantined
        );
        assert_eq!(auth_state(dir), AuthState::NeedsRelogin);
        // Never sent again.
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, 2).await,
            Refresh::Idle
        );
        assert_eq!(server.requests().await.len(), 1);
    }

    #[tokio::test]
    async fn a_busy_lock_waits_for_the_other_writer() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        signed_in(dir, 0);
        let _held = DirLock::try_take(dir, "claude-refresh.lock")
            .unwrap()
            .unwrap();
        assert_eq!(
            refresh_if_due(&Http::default(), &Endpoints::default(), dir, 1).await,
            Refresh::Busy
        );
    }
}
