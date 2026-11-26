//! A Codex account's sign-in and its token refresh, in the account's own
//! `auth.json` (its `CODEX_HOME`).
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy): src/codex_login.rs (Codex's authorize URL,
//! client, scopes and registered redirect, the form-encoded code exchange,
//! the best-effort API key exchange, the `auth.json` it writes) and
//! src/codex_auth.rs (the JSON refresh, which refusals mean the chain is
//! dead, the last-known-good copy and the quarantine).
//!
//! Codex only accepts its registered loopback redirect
//! (`http://localhost:1455/auth/callback`), which cannot reach Roamgate
//! when the browser is on another machine. So the sign-in does not listen:
//! the browser lands on a page that does not load, and the user pastes
//! that page's address (it carries the code and the state) back.
//!
//! Refresh rules: Codex refreshes its own tokens once they are
//! [`CODEX_REFRESH_AFTER_MS`] plus a day old; Roamgate refreshes an
//! account a day earlier, under the account's lock, after reading the file
//! again, so an idle account's chain never lapses. A refusal that says the
//! chain is dead (reused, expired, invalidated) quarantines it, unless the
//! file changed meanwhile (Codex refreshed it itself).

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};

use crate::AuthState;
use crate::files::{
    DirLock, clear_quarantine, quarantine, quarantined, read_object, record_last_known_good,
    write_private,
};
use crate::oauth::{Endpoints, Http, new_pkce, percent_encode, query_param, random_b64url};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
/// Codex's registered redirect.
pub const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const SCOPE: &str = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR: &str = "codex_cli_rs";

/// Roamgate refreshes a chain this old (ms): seven days, a day before
/// Codex itself would.
pub const CODEX_REFRESH_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const AUTH: &str = "auth.json";

/// A sign-in started. Never shown.
#[derive(Clone)]
pub struct PendingCodex {
    verifier: String,
    state: String,
}

impl std::fmt::Debug for PendingCodex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingCodex(..)")
    }
}

/// Starts a sign-in: the link to open, and what completes it.
pub fn start(endpoints: &Endpoints) -> (String, PendingCodex) {
    let (verifier, challenge) = new_pkce();
    let state = random_b64url(32);
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
        ("scope", SCOPE),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", state.as_str()),
        ("originator", ORIGINATOR),
    ];
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    (
        format!("{}?{query}", endpoints.codex_authorize),
        PendingCodex { verifier, state },
    )
}

/// The code of the pasted address (or its query), when it belongs to this
/// sign-in.
pub fn parse_pasted(pasted: &str, pending: &PendingCodex) -> Result<String, String> {
    let pasted = pasted.trim();
    if pasted.is_empty() {
        return Err("No address was entered".into());
    }
    if pasted.len() > 8192 {
        return Err("That is far longer than the page's address".into());
    }
    let query = pasted
        .split_once('?')
        .map_or(pasted, |(_, query)| query)
        .split('#')
        .next()
        .unwrap_or("");
    if let Some(error) = query_param(query, "error") {
        return Err(format!("The sign-in was refused: {error}"));
    }
    let code = query_param(query, "code").filter(|code| !code.is_empty());
    let state = query_param(query, "state");
    match (code, state) {
        (Some(code), Some(state)) if state == pending.state => Ok(code),
        (Some(_), Some(_)) => Err("That address is from another sign-in; start again".into()),
        _ => Err("Paste the whole address of the page the sign-in ended on".into()),
    }
}

/// A JWT's claims, unverified (only read for the account id).
fn jwt_claims(jwt: &str) -> Option<Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn account_id(id_token: &str) -> Option<String> {
    jwt_claims(id_token)?
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_owned)
}

fn auth_path(dir: &Path) -> std::path::PathBuf {
    dir.join(AUTH)
}

fn token<'a>(auth: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    auth.get("tokens")?
        .get(key)?
        .as_str()
        .filter(|token| !token.is_empty())
}

/// Completes a sign-in with the pasted address: exchanges the code (and,
/// best effort, an API key) and writes the account's `auth.json`.
pub async fn complete(
    http: &Http,
    endpoints: &Endpoints,
    pending: &PendingCodex,
    pasted: &str,
    dir: &Path,
    now_ms: i64,
) -> Result<(), String> {
    let code = parse_pasted(pasted, pending)?;
    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        percent_encode(&code),
        percent_encode(REDIRECT_URI),
        percent_encode(CLIENT_ID),
        percent_encode(&pending.verifier),
    );
    let (status, text) = http
        .post(
            &endpoints.codex_token,
            "application/x-www-form-urlencoded",
            body,
        )
        .await?;
    if !(200..300).contains(&status) {
        return Err(format!(
            "The sign-in server refused the code (HTTP {status}); start again"
        ));
    }
    let answer: Value = serde_json::from_str(&text)
        .map_err(|_| "The sign-in server's answer did not parse".to_owned())?;
    let field = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(id_token), Some(access), Some(refresh)) = (
        field("id_token"),
        field("access_token"),
        field("refresh_token"),
    ) else {
        return Err("The sign-in server gave no token".into());
    };
    let api_key = api_key(http, endpoints, &id_token).await;
    let mut tokens = json!({
        "id_token": id_token,
        "access_token": access,
        "refresh_token": refresh,
    });
    if let Some(account) = account_id(&id_token) {
        tokens["account_id"] = json!(account);
    }
    let mut auth = Map::new();
    auth.insert("auth_mode".into(), json!("chatgpt"));
    auth.insert("OPENAI_API_KEY".into(), json!(api_key));
    auth.insert("tokens".into(), tokens);
    auth.insert(
        "last_refresh".into(),
        json!(roamgate_base::log::iso_millis(now_ms)),
    );
    write_private(&auth_path(dir), &auth)
        .map_err(|error| format!("The sign-in could not be saved: {error}"))?;
    clear_quarantine(dir);
    Ok(())
}

/// The API key exchanged for the id token, or None (best effort).
async fn api_key(http: &Http, endpoints: &Endpoints, id_token: &str) -> Option<String> {
    let body = format!(
        "grant_type={}&client_id={}&requested_token={}&subject_token={}&subject_token_type={}",
        percent_encode("urn:ietf:params:oauth:grant-type:token-exchange"),
        percent_encode(CLIENT_ID),
        percent_encode("openai-api-key"),
        percent_encode(id_token),
        percent_encode("urn:ietf:params:oauth:token-type:id_token"),
    );
    let (status, text) = http
        .post(
            &endpoints.codex_token,
            "application/x-www-form-urlencoded",
            body,
        )
        .await
        .ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    serde_json::from_str::<Value>(&text)
        .ok()?
        .get("access_token")?
        .as_str()
        .map(str::to_owned)
}

/// Whether a refusal says the chain is dead, and how.
fn dead(status: u16, body: &str) -> Option<&'static str> {
    if body.contains("refresh_token_reused") {
        return Some("reused");
    }
    if body.contains("refresh_token_expired") {
        return Some("expired");
    }
    if body.contains("refresh_token_invalidated") {
        return Some("invalidated");
    }
    ((400..500).contains(&status) && status != 429).then_some("rejected")
}

/// What a refresh pass did (as Claude's).
pub use crate::claude_auth::Refresh;

/// Refreshes the account's chain when it is [`CODEX_REFRESH_AFTER_MS`]
/// old.
pub async fn refresh_if_due(
    http: &Http,
    endpoints: &Endpoints,
    dir: &Path,
    now_ms: i64,
) -> Refresh {
    let due = |auth: &Map<String, Value>| {
        let refresh = token(auth, "refresh_token")?;
        let last = auth
            .get("last_refresh")
            .and_then(Value::as_str)
            .and_then(roamgate_base::log::parse_iso_millis)
            .unwrap_or(0);
        (now_ms - last >= CODEX_REFRESH_AFTER_MS && !quarantined(dir, refresh))
            .then(|| refresh.to_owned())
    };
    if read_object(&auth_path(dir))
        .as_ref()
        .and_then(due)
        .is_none()
    {
        return Refresh::Idle;
    }
    let Ok(Some(_lock)) = DirLock::try_take(dir, "codex-refresh.lock") else {
        return Refresh::Busy;
    };
    let Ok(bytes) = std::fs::read(auth_path(dir)) else {
        return Refresh::Idle;
    };
    // A file being written by Codex: the next pass.
    let Ok(Value::Object(mut auth)) = serde_json::from_slice::<Value>(&bytes) else {
        return Refresh::Busy;
    };
    let Some(refresh) = due(&auth) else {
        return Refresh::Busy;
    };
    let body = json!({
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh,
    });
    let (status, text) = match http
        .post(&endpoints.codex_token, "application/json", body.to_string())
        .await
    {
        Ok(answer) => answer,
        Err(message) => return Refresh::Failed(message),
    };
    if !(200..300).contains(&status) {
        let Some(why) = dead(status, &text) else {
            return Refresh::Failed(format!("The sign-in server refused (HTTP {status})"));
        };
        let now = read_object(&auth_path(dir))
            .and_then(|auth| token(&auth, "refresh_token").map(str::to_owned));
        if now.as_deref() != Some(refresh.as_str()) {
            return Refresh::Busy;
        }
        let _ = quarantine(dir, &refresh, why, now_ms);
        return Refresh::Quarantined;
    }
    let Ok(answer) = serde_json::from_str::<Value>(&text) else {
        return Refresh::Failed("The sign-in server's answer did not parse".into());
    };
    let field = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(access), Some(new_refresh)) = (field("access_token"), field("refresh_token")) else {
        return Refresh::Failed("The sign-in server gave no token".into());
    };
    let _ = record_last_known_good(dir, "auth.last-good.json", &bytes);
    if let Some(tokens) = auth.get_mut("tokens").and_then(Value::as_object_mut) {
        tokens.insert("access_token".into(), json!(access));
        tokens.insert("refresh_token".into(), json!(new_refresh));
        if let Some(id_token) = field("id_token") {
            tokens.insert("id_token".into(), json!(id_token));
        }
    }
    auth.insert(
        "last_refresh".into(),
        json!(roamgate_base::log::iso_millis(now_ms)),
    );
    match write_private(&auth_path(dir), &auth) {
        Ok(()) => Refresh::Refreshed,
        Err(error) => Refresh::Failed(format!("The refreshed sign-in could not be saved: {error}")),
    }
}

/// Signs the account out: its `auth.json` goes.
pub fn logout(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(auth_path(dir)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    clear_quarantine(dir);
    Ok(())
}

/// The account's sign-in state from its `auth.json`.
pub fn auth_state(dir: &Path) -> AuthState {
    let Some(auth) = read_object(&auth_path(dir)) else {
        return if auth_path(dir).exists() {
            AuthState::Unknown
        } else {
            AuthState::SignedOut
        };
    };
    match token(&auth, "refresh_token") {
        Some(refresh) if quarantined(dir, refresh) => AuthState::NeedsRelogin,
        Some(_) => AuthState::SignedIn,
        // An API key sign-in, or Codex's own format: signed in as far as
        // Roamgate can tell.
        None if auth.get("OPENAI_API_KEY").is_some_and(Value::is_string) => AuthState::SignedIn,
        None => AuthState::SignedOut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::FakeServer;

    fn endpoints(server: &FakeServer) -> Endpoints {
        Endpoints {
            codex_token: server.url("/oauth/token"),
            ..Endpoints::default()
        }
    }

    fn id_token(account: &str) -> String {
        let claims = json!({"https://api.openai.com/auth": {"chatgpt_account_id": account}});
        format!(
            "h.{}.s",
            URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes())
        )
    }

    #[test]
    fn the_pasted_address_gives_the_code() {
        let (url, pending) = start(&Endpoints::default());
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"));
        let address = format!(
            "http://localhost:1455/auth/callback?code=c%2F1&scope=x&state={}",
            pending.state
        );
        assert_eq!(parse_pasted(&address, &pending), Ok("c/1".into()));
        assert_eq!(
            parse_pasted(&format!("code=c&state={}", pending.state), &pending),
            Ok("c".into())
        );
        assert!(
            parse_pasted(
                "http://localhost:1455/auth/callback?code=c&state=x",
                &pending
            )
            .is_err()
        );
        assert!(
            parse_pasted(
                "http://localhost:1455/auth/callback?error=access_denied",
                &pending
            )
            .is_err()
        );
        assert!(parse_pasted("nothing", &pending).is_err());
    }

    #[tokio::test]
    async fn a_sign_in_writes_codex_s_auth_json() {
        let server = FakeServer::start(vec![
            (
                200,
                json!({"id_token": id_token("acct-1"), "access_token": "a1", "refresh_token": "r1"})
                    .to_string(),
            ),
            (200, r#"{"access_token":"sk-key"}"#.into()),
        ])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let (_, pending) = start(&endpoints(&server));
        complete(
            &Http::default(),
            &endpoints(&server),
            &pending,
            &format!("{REDIRECT_URI}?code=the-code&state={}", pending.state),
            dir,
            0,
        )
        .await
        .unwrap();
        let requests = server.requests().await;
        assert_eq!(
            requests[0].content_type,
            "application/x-www-form-urlencoded"
        );
        assert!(requests[0].body.contains("code=the-code"));
        assert!(
            requests[0]
                .body
                .contains(&format!("code_verifier={}", pending.verifier))
        );
        assert!(requests[1].body.contains("requested_token=openai-api-key"));
        let auth = read_object(&dir.join("auth.json")).unwrap();
        assert_eq!(auth["auth_mode"], "chatgpt");
        assert_eq!(auth["OPENAI_API_KEY"], "sk-key");
        assert_eq!(auth["tokens"]["account_id"], "acct-1");
        assert_eq!(auth["tokens"]["refresh_token"], "r1");
        assert_eq!(auth["last_refresh"], "1970-01-01T00:00:00.000Z");
        assert_eq!(auth_state(dir), AuthState::SignedIn);
        logout(dir).unwrap();
        assert_eq!(auth_state(dir), AuthState::SignedOut);
    }

    fn signed_in(dir: &Path) {
        std::fs::write(
            dir.join("auth.json"),
            json!({"auth_mode": "chatgpt", "OPENAI_API_KEY": null,
                   "tokens": {"id_token": "i0", "access_token": "a0", "refresh_token": "r0"},
                   "last_refresh": "1970-01-01T00:00:00.000Z"})
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn an_old_chain_is_refreshed_and_the_last_good_kept() {
        let server = FakeServer::start(vec![(
            200,
            r#"{"access_token":"a2","refresh_token":"r2"}"#.into(),
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        signed_in(dir);
        let http = Http::default();
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, CODEX_REFRESH_AFTER_MS - 1).await,
            Refresh::Idle
        );
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, CODEX_REFRESH_AFTER_MS).await,
            Refresh::Refreshed
        );
        let request = &server.requests().await[0];
        assert_eq!(request.content_type, "application/json");
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(
            body,
            json!({"client_id": CLIENT_ID, "grant_type": "refresh_token", "refresh_token": "r0"})
        );
        let auth = read_object(&dir.join("auth.json")).unwrap();
        assert_eq!(auth["tokens"]["refresh_token"], "r2");
        assert_eq!(auth["tokens"]["id_token"], "i0");
        let kept = read_object(&dir.join(".roamgate/auth.last-good.json")).unwrap();
        assert_eq!(kept["tokens"]["refresh_token"], "r0");
    }

    #[tokio::test]
    async fn a_reused_chain_is_quarantined() {
        let server = FakeServer::start(vec![(
            401,
            r#"{"error":{"code":"refresh_token_reused"}}"#.into(),
        )])
        .await;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        signed_in(dir);
        let http = Http::default();
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, CODEX_REFRESH_AFTER_MS).await,
            Refresh::Quarantined
        );
        assert_eq!(auth_state(dir), AuthState::NeedsRelogin);
        assert_eq!(
            refresh_if_due(&http, &endpoints(&server), dir, CODEX_REFRESH_AFTER_MS).await,
            Refresh::Idle
        );
    }
}
