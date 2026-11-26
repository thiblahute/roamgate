//! Browser authentication (http/auth.ts): a signed session cookie given by
//! a password, a PIN or a URL token, the attempt limits that keep those
//! from being guessed, logout, and the login page.
//!
//! Limits, as the TS keeps them: per IP 20 attempts a minute and a five
//! minute cooldown after 5 failures, at most 4096 IPs remembered (failing
//! closed rather than forgetting a cooldown); the PIN has its own per-IP
//! records and a global cooldown of an hour after 10 consecutive failures,
//! so that guessing the PIN never spends the password's or token's budget.
//! An attempt is reserved before its body is read, and checked again after
//! it: a slow body cannot use a record that expired or was replaced
//! meanwhile.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::Stream;
use hmac::{Hmac, Mac};
use http::HeaderMap;
use http::request::Parts;
use roamgate_base::clock::SharedClock;
use roamgate_base::credentials::{assert_valid_auth_password, assert_valid_auth_pin};
use roamgate_base::revoked_sessions::RevokedSessions;
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::body::{BodyError, read_json_body};
use crate::login_page::render_login_page;

use crate::response::{self, Response, decode_uri_component, header};

pub const AUTH_COOKIE: &str = "herdr_auth";
pub const AUTH_TOKEN_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS: i64 = 60_000;
const LOGIN_MAX_ATTEMPTS: u32 = 20;
const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_COOLDOWN_MS: i64 = 5 * 60_000;
const LOGIN_MAX_IPS: usize = 4096;
pub const LOGIN_MAX_BODY_BYTES: usize = 16 * 1024;
const PIN_MAX_FAILURES: u32 = 10;
const PIN_COOLDOWN_MS: i64 = 60 * 60_000;

/// What `createAuthHandlers` is given.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// False only for a development loopback listener.
    pub auth_required: bool,
    pub password: String,
    /// 64 hex digits: the session signing key, never the password.
    pub session_secret: String,
    pub pin: Option<String>,
    pub url_login_token: Option<String>,
    /// Host command that prints the generated token, shown on the login page.
    pub token_command: Option<String>,
    pub secure_cookies: bool,
}

impl AuthConfig {
    pub fn new(password: &str, session_secret: &str) -> Self {
        Self {
            auth_required: true,
            password: password.into(),
            session_secret: session_secret.into(),
            pin: None,
            url_login_token: None,
            token_command: None,
            secure_cookies: false,
        }
    }
}

#[derive(Debug, Clone)]
struct Attempts {
    /// Which record this is: a slow body checks it still holds this one.
    id: u64,
    count: u32,
    failures: u32,
    window_ends_at: i64,
    blocked_until: i64,
    expires_at: i64,
}

#[derive(Debug, Default)]
struct State {
    login: HashMap<String, Attempts>,
    // PIN throttling must never consume the password/token recovery budget.
    pin: HashMap<String, Attempts>,
    pin_failures: u32,
    pin_blocked_until: i64,
    next_id: u64,
}

impl State {
    fn records(&mut self, pin: bool) -> &mut HashMap<String, Attempts> {
        if pin { &mut self.pin } else { &mut self.login }
    }
}

/// The handlers of one server's authentication.
pub struct Auth {
    config: AuthConfig,
    key: Vec<u8>,
    clock: SharedClock,
    state: Mutex<State>,
    /// Cookies ended by a logout (memory only unless given a file).
    revoked: Mutex<RevokedSessions>,
}

fn too_many_attempts(wait_ms: i64) -> Response {
    let seconds = ((wait_ms as f64) / 1000.0).ceil().max(1.0) as i64;
    response::json(
        429,
        &[
            ("retry-after", &seconds.to_string()),
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
        ],
        &json!({"error": "too many login attempts"}),
    )
}

fn check_cooldown(attempts: &mut Attempts, now: i64) -> Option<Response> {
    if attempts.blocked_until > now {
        return Some(too_many_attempts(attempts.blocked_until - now));
    }
    if attempts.blocked_until != 0 {
        attempts.failures = 0;
        attempts.blocked_until = 0;
    }
    None
}

fn fail_login(attempts: &mut Attempts, now: i64) {
    attempts.failures += 1;
    if attempts.failures >= LOGIN_MAX_FAILURES {
        attempts.blocked_until = now + LOGIN_COOLDOWN_MS;
        attempts.expires_at = attempts.blocked_until;
    }
}

/// A cookie's value as the TS parser reads the `Cookie` header.
pub fn parse_cookie(header: Option<&str>, name: &str) -> Option<String> {
    let header = header?;
    if header.is_empty() {
        return None;
    }
    for part in header.split(';') {
        let mut pieces = part.trim().split('=');
        let key = pieces.next().unwrap_or("");
        if key != name {
            continue;
        }
        let rest: Vec<&str> = pieces.collect();
        return decode_uri_component(&rest.join("="));
    }
    None
}

/// `Buffer.from(text, "hex")`: pairs of hex digits up to the first that is not.
fn lenient_hex(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for pair in text.as_bytes().as_chunks::<2>().0 {
        if !pair.iter().all(u8::is_ascii_hexdigit) {
            break;
        }
        let digit = |byte: u8| (byte as char).to_digit(16).unwrap_or(0) as u8;
        out.push(digit(pair[0]) << 4 | digit(pair[1]));
    }
    out
}

const LENIENT_BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// Whether `req` opens a page: no upgrade (a WebSocket), no API path, and,
/// from a browser that says so, a navigation (`Sec-Fetch-Mode`). Clients
/// that send no fetch metadata, such as older browsers, count as one.
fn is_navigation(headers: &HeaderMap, pathname: &str) -> bool {
    if headers.contains_key("upgrade") {
        return false;
    }
    if pathname == "/api" || pathname.starts_with("/api/") {
        return false;
    }
    match header(headers, "sec-fetch-mode") {
        None => true,
        Some(mode) => mode == "navigate",
    }
}

/// The request's URL as `new URL(req.url)` reads it.
pub fn request_url(parts: &Parts) -> Option<url::Url> {
    let text = parts.uri.to_string();
    if text.starts_with('/') {
        let host = header(&parts.headers, "host").unwrap_or_else(|| "localhost".into());
        url::Url::parse(&format!("http://{host}{text}"))
            .or_else(|_| url::Url::parse(&format!("http://localhost{text}")))
            .ok()
    } else {
        url::Url::parse(&text).ok()
    }
}

/// Use a relative Location so reverse proxies preserve the public origin
/// instead of leaking the internal upstream host. Intentionally ignores
/// request URLs and forwarded headers.
pub fn unauthenticated_login_redirect() -> Response {
    response::empty(302, &[("location", "/login")])
}

pub use roamgate_base::credentials::with_login_token;

impl Auth {
    /// `createAuthHandlers`: refuses a bad password, PIN or signing secret.
    pub fn new(config: AuthConfig, clock: SharedClock) -> Result<Self, String> {
        if config.auth_required {
            assert_valid_auth_password(&config.password)?;
            let secret = &config.session_secret;
            if secret.len() != 64
                || !secret
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err("Authentication requires a 256-bit session signing secret.".into());
            }
        }
        if let Some(pin) = &config.pin {
            assert_valid_auth_pin(pin)?;
        }
        let key = lenient_hex(&config.session_secret);
        Ok(Self {
            config,
            key,
            clock,
            state: Mutex::new(State::default()),
            revoked: Mutex::new(RevokedSessions::open(None, None)),
        })
    }

    /// Keeps the cookies ended by a logout in this list (its file, across
    /// restarts) instead of memory only.
    pub fn with_revoked(mut self, revoked: RevokedSessions) -> Self {
        self.revoked = Mutex::new(revoked);
        self
    }

    pub fn config(&self) -> &AuthConfig {
        &self.config
    }

    fn now(&self) -> i64 {
        self.clock.now()
    }

    fn check_pin_cooldown(state: &mut State, now: i64) -> Option<Response> {
        if state.pin_blocked_until > now {
            return Some(too_many_attempts(state.pin_blocked_until - now));
        }
        if state.pin_blocked_until != 0 {
            state.pin_failures = 0;
            state.pin_blocked_until = 0;
        }
        None
    }

    fn fail_pin_login(state: &mut State, now: i64) {
        state.pin_failures += 1;
        if state.pin_failures >= PIN_MAX_FAILURES {
            state.pin_blocked_until = now + PIN_COOLDOWN_MS;
        }
    }

    /// Reserves an attempt for `ip`: the record's id, or how long to wait
    /// (the 429 to answer).
    fn begin_login(state: &mut State, pin: bool, ip: &str, now: i64) -> Result<u64, i64> {
        let next_id = state.next_id + 1;
        let records = state.records(pin);
        records.retain(|_, attempts| attempts.expires_at > now);
        if !records.contains_key(ip) {
            // Fail closed rather than evicting an IP's active cooldown.
            if records.len() >= LOGIN_MAX_IPS {
                return Err(LOGIN_WINDOW_MS);
            }
            records.insert(
                ip.to_owned(),
                Attempts {
                    id: next_id,
                    count: 0,
                    failures: 0,
                    window_ends_at: now + LOGIN_WINDOW_MS,
                    blocked_until: 0,
                    expires_at: now + LOGIN_COOLDOWN_MS,
                },
            );
            state.next_id = next_id;
        }
        let attempts = state.records(pin).get_mut(ip).expect("just inserted");
        attempts.expires_at = now + LOGIN_COOLDOWN_MS;
        if attempts.blocked_until > now {
            return Err(attempts.blocked_until - now);
        }
        if attempts.blocked_until != 0 {
            attempts.failures = 0;
            attempts.blocked_until = 0;
        }
        if attempts.window_ends_at <= now {
            attempts.count = 0;
            attempts.window_ends_at = now + LOGIN_WINDOW_MS;
        }
        if attempts.count >= LOGIN_MAX_ATTEMPTS {
            return Err(attempts.window_ends_at - now);
        }
        attempts.count += 1;
        Ok(attempts.id)
    }

    fn sign(&self, payload: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("HMAC takes any key");
        mac.update(payload.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn signed_token(&self) -> String {
        let now = self.now().div_euclid(1000);
        let nonce: [u8; 16] = rand::random();
        let claims = json!({
            "iat": now,
            "exp": now + AUTH_TOKEN_TTL_SECONDS,
            "nonce": hex::encode(nonce),
        });
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signature = self.sign(&payload);
        format!("{payload}.{signature}")
    }

    fn cookie_of(&self, token: &str, max_age: i64) -> String {
        format!(
            "{AUTH_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={max_age}{}",
            if self.config.secure_cookies {
                "; Secure"
            } else {
                ""
            }
        )
    }

    /// The cookie of a new login, unless the request already has a valid
    /// one: live tabs keep their token and its expiry.
    fn auth_cookie(&self, headers: &HeaderMap) -> Option<String> {
        if self.is_authed(headers) {
            return None;
        }
        Some(self.cookie_of(&self.signed_token(), AUTH_TOKEN_TTL_SECONDS))
    }

    fn secrets_equal(actual: &str, expected: &str) -> bool {
        actual.len() == expected.len() && bool::from(actual.as_bytes().ct_eq(expected.as_bytes()))
    }

    /// The expiry (seconds) of a cookie this server signed, still valid.
    fn signed_token_expiry(&self, token: &str) -> Option<f64> {
        let parts: Vec<&str> = token.split('.').collect();
        let [payload, signature] = parts[..] else {
            return None;
        };
        if payload.is_empty() || signature.is_empty() {
            return None;
        }
        let expected = lenient_hex(&self.sign(payload));
        let actual = lenient_hex(signature);
        if actual.len() != expected.len() || !bool::from(actual.ct_eq(&expected)) {
            return None;
        }
        let cleaned: String = payload
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        let Ok(bytes) = LENIENT_BASE64URL.decode(cleaned) else {
            return None;
        };
        let Ok(decoded) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
            return None;
        };
        let now = self.now().div_euclid(1000) as f64;
        decoded
            .get("exp")
            .and_then(Value::as_f64)
            .filter(|exp| *exp > now)
    }

    fn is_valid_signed_token(&self, token: &str) -> bool {
        self.signed_token_expiry(token).is_some()
            && !self
                .revoked
                .lock()
                .unwrap()
                .has(token, self.now().div_euclid(1000))
    }

    /// The session cookie's token, if any.
    pub fn session_token(&self, headers: &HeaderMap) -> Option<String> {
        parse_cookie(header(headers, "cookie").as_deref(), AUTH_COOKIE)
    }

    pub fn is_authed(&self, headers: &HeaderMap) -> bool {
        if !self.config.auth_required {
            return true;
        }
        self.session_token(headers)
            .is_some_and(|token| self.is_valid_signed_token(&token))
    }

    /// `POST /api/logout` with `X-Roamgate-Logout: 1`, never cross-site.
    pub fn handle_logout(&self, parts: &Parts) -> Response {
        if parts.method != http::Method::POST {
            return response::text(405, &[("allow", "POST")], "method not allowed");
        }
        // Custom headers require a CORS preflight; the bridge grants no CORS
        // access. Unlike an Origin comparison, this also works behind
        // reverse proxies.
        if header(&parts.headers, "x-roamgate-logout").as_deref() != Some("1")
            || header(&parts.headers, "sec-fetch-site").as_deref() == Some("cross-site")
        {
            return response::text(403, &[], "forbidden");
        }
        // The cookie is ended here too: a copy of it no longer logs in.
        if self.config.auth_required
            && let Some(token) = self.session_token(&parts.headers)
            && let Some(expires_at) = self.signed_token_expiry(&token)
        {
            let now = self.now().div_euclid(1000);
            self.revoked
                .lock()
                .unwrap()
                .add(&token, expires_at as i64, now);
        }
        let cookie = format!(
            "{AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
            if self.config.secure_cookies {
                "; Secure"
            } else {
                ""
            }
        );
        response::empty(
            204,
            &[("set-cookie", &cookie), ("cache-control", "no-store")],
        )
    }

    /// A page opened with `?token=`: a 303 to the same page without it,
    /// logged in when the token is right; `None` for anything else.
    pub fn handle_token_login(&self, parts: &Parts, ip: &str) -> Option<Response> {
        let expected = self
            .config
            .url_login_token
            .as_deref()
            .filter(|token| !token.is_empty())?;
        if !self.config.auth_required || parts.method != http::Method::GET {
            return None;
        }
        let mut url = request_url(parts)?;
        // Only a page opened with the token logs in: an API request or a
        // socket carrying a `token` of its own is left to its route, and
        // never counts as a failed login.
        if !is_navigation(&parts.headers, url.path()) {
            return None;
        }
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        let supplied = pairs.iter().find(|(name, _)| name == "token")?.1.clone();
        let now = self.now();
        let mut state = self.state.lock().unwrap();
        let id = match Self::begin_login(&mut state, false, ip, now) {
            Ok(id) => id,
            Err(wait) => return Some(too_many_attempts(wait)),
        };
        let kept: Vec<&(String, String)> =
            pairs.iter().filter(|(name, _)| name != "token").collect();
        if kept.is_empty() {
            url.set_query(None);
        } else {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for (name, value) in kept {
                serializer.append_pair(name, value);
            }
            url.set_query(Some(&serializer.finish()));
        }
        let valid = Self::secrets_equal(&supplied, expected);
        let attempts = state.login.get_mut(ip).filter(|attempts| attempts.id == id);
        if let Some(attempts) = attempts {
            if valid {
                attempts.failures = 0;
            } else {
                fail_login(attempts, now);
            }
        }
        drop(state);
        let location = if valid {
            match url.query() {
                Some(query) => format!("{}?{query}", url.path()),
                None => url.path().to_owned(),
            }
        } else {
            "/login".to_owned()
        };
        let cookie = if valid {
            self.auth_cookie(&parts.headers)
        } else {
            None
        };
        let mut headers: Vec<(&str, &str)> = vec![("location", &location)];
        if let Some(cookie) = &cookie {
            headers.push(("set-cookie", cookie));
        }
        headers.push(("cache-control", "no-store"));
        headers.push(("referrer-policy", "no-referrer"));
        Some(response::empty(303, &headers))
    }

    /// `POST /api/login` (`{"password"}`).
    pub async fn handle_login<S, E>(&self, parts: &Parts, body: Option<S>, ip: &str) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        self.handle_credential_login(parts, body, ip, false).await
    }

    /// `POST /api/login/pin` (`{"pin"}`): 404 unless a PIN is configured.
    pub async fn handle_pin_login<S, E>(&self, parts: &Parts, body: Option<S>, ip: &str) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        self.handle_credential_login(parts, body, ip, true).await
    }

    async fn handle_credential_login<S, E>(
        &self,
        parts: &Parts,
        body: Option<S>,
        ip: &str,
        use_pin: bool,
    ) -> Response
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin,
    {
        if use_pin && self.config.pin.is_none() {
            return response::text(404, &[], "not found");
        }
        if !self.config.auth_required {
            return response::json(200, &[], &json!({"ok": true}));
        }
        let id = {
            let now = self.now();
            let mut state = self.state.lock().unwrap();
            let cooldown = if use_pin {
                Self::check_pin_cooldown(&mut state, now)
            } else {
                None
            };
            match cooldown {
                Some(cooldown) => Err(cooldown),
                None => Self::begin_login(&mut state, use_pin, ip, now).map_err(too_many_attempts),
            }
        };
        let body = read_json_body(body, LOGIN_MAX_BODY_BYTES).await;
        // Answered once the body is read: a socket closed on unread data
        // is reset on Windows, and the client loses the answer.
        let id = match id {
            Ok(id) => id,
            Err(refused) => return refused,
        };
        let now = self.now();
        let mut state = self.state.lock().unwrap();
        // A slow body must not authorize using an expired or replaced IP record.
        let live = state
            .records(use_pin)
            .get(ip)
            .is_some_and(|attempts| attempts.id == id && attempts.expires_at > now);
        if !live {
            return too_many_attempts(LOGIN_WINDOW_MS);
        }
        if let Some(cooldown) = check_cooldown(state.records(use_pin).get_mut(ip).unwrap(), now) {
            return cooldown;
        }
        if use_pin && let Some(cooldown) = Self::check_pin_cooldown(&mut state, now) {
            return cooldown;
        }
        let body = match body {
            Ok(body) => body,
            Err(error) => {
                fail_login(state.records(use_pin).get_mut(ip).unwrap(), now);
                if use_pin {
                    Self::fail_pin_login(&mut state, now);
                }
                let (status, message) = if error == BodyError::TooLarge {
                    (413, "request body too large")
                } else {
                    (400, "bad request")
                };
                return response::json(status, &[], &json!({"error": message}));
            }
        };
        let field = if use_pin { "pin" } else { "password" };
        let expected = if use_pin {
            self.config.pin.as_deref().unwrap_or_default()
        } else {
            &self.config.password
        };
        let supplied = body.get(field).and_then(Value::as_str);
        if !supplied.is_some_and(|supplied| Self::secrets_equal(supplied, expected)) {
            fail_login(state.records(use_pin).get_mut(ip).unwrap(), now);
            if use_pin {
                Self::fail_pin_login(&mut state, now);
            }
            let message = if use_pin {
                "wrong PIN"
            } else {
                "wrong password"
            };
            return response::json(401, &[], &json!({"error": message}));
        }
        state.records(use_pin).get_mut(ip).unwrap().failures = 0;
        if use_pin {
            state.pin_failures = 0;
        }
        drop(state);
        let cookie = self.auth_cookie(&parts.headers);
        let mut headers = vec![
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ];
        if let Some(cookie) = &cookie {
            headers.push(("set-cookie", cookie));
        }
        response::with(200, &headers, r#"{"ok":true}"#)
    }

    /// `/login`: the page, or a redirect home when no login is required.
    /// Drafts are cleared unless the request carries a valid session.
    pub fn login_page(&self, headers: Option<&HeaderMap>) -> Response {
        if !self.config.auth_required {
            return response::empty(302, &[("location", "/"), ("cache-control", "no-store")]);
        }
        let clear_drafts = headers.is_none_or(|headers| !self.is_authed(headers));
        let html = render_login_page(
            self.config.pin.is_some(),
            self.config.token_command.as_deref(),
            clear_drafts,
        );
        response::with(
            200,
            &[
                ("content-type", "text/html; charset=utf-8"),
                ("cache-control", "no-store"),
                ("referrer-policy", "no-referrer"),
            ],
            html,
        )
    }

    /// A new login's cookie, for a client that proved itself otherwise (a
    /// call handed to the Android app): `None` when no login is required.
    pub fn new_session_cookie(&self) -> Option<String> {
        if !self.config.auth_required {
            return None;
        }
        Some(self.cookie_of(&self.signed_token(), AUTH_TOKEN_TTL_SECONDS))
    }
}

#[cfg(test)]
mod pin_tests;
#[cfg(test)]
mod tests;
