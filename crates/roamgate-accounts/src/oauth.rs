//! What the Claude and Codex sign-ins share: the endpoints, PKCE, the
//! query encoding, and the HTTP client.
//!
//! Adapted from clauth (https://github.com/uwuclxdy/clauth, MIT licence,
//! Copyright (c) 2026 cloudy), src/oauth_login.rs: `percent_encode`,
//! `percent_decode`, `query_param` and the PKCE pair (`new_pkce`,
//! `challenge_from_verifier`).

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore as _;
use sha2::{Digest, Sha256};

/// Where the sign-ins go. Tests point them at a local fake server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    pub claude_authorize: String,
    pub claude_token: String,
    pub claude_usage: String,
    pub claude_profile: String,
    pub codex_authorize: String,
    pub codex_token: String,
    pub codex_usage: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            claude_authorize: "https://claude.com/cai/oauth/authorize".into(),
            claude_token: "https://platform.claude.com/v1/oauth/token".into(),
            claude_usage: "https://api.anthropic.com/api/oauth/usage".into(),
            claude_profile: "https://api.anthropic.com/api/oauth/profile".into(),
            codex_authorize: "https://auth.openai.com/oauth/authorize".into(),
            codex_token: "https://auth.openai.com/oauth/token".into(),
            codex_usage: "https://chatgpt.com/backend-api/wham/usage".into(),
        }
    }
}

/// A test server's stand-in for the sign-in and usage servers: every
/// endpoint `https://host/path` goes to `<base>/host/path`. Honoured only
/// by a build that honours the test clock, never by a release binary.
pub const TEST_ACCOUNTS_URL_ENV: &str = "ROAMGATE_TEST_ACCOUNTS_URL";

impl Endpoints {
    /// The real endpoints, or a test server's ([`TEST_ACCOUNTS_URL_ENV`]).
    pub fn from_env(var: &dyn Fn(&str) -> Option<String>) -> Self {
        let real = Self::default();
        let Some(base) = var(TEST_ACCOUNTS_URL_ENV)
            .filter(|base| !base.is_empty() && roamgate_base::clock::TEST_CLOCK_HONOURED)
        else {
            return real;
        };
        let base = base.trim_end_matches('/').to_owned();
        let moved = |url: String| {
            let rest = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
            format!("{base}/{rest}")
        };
        Self {
            claude_authorize: moved(real.claude_authorize),
            claude_token: moved(real.claude_token),
            claude_usage: moved(real.claude_usage),
            claude_profile: moved(real.claude_profile),
            codex_authorize: moved(real.codex_authorize),
            codex_token: moved(real.codex_token),
            codex_usage: moved(real.codex_usage),
        }
    }
}

/// `n` random bytes, base64url without padding.
pub(crate) fn random_b64url(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A fresh `(code_verifier, code_challenge)` PKCE pair (S256).
pub(crate) fn new_pkce() -> (String, String) {
    let verifier = random_b64url(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Percent-encodes everything but RFC 3986's unreserved characters.
pub(crate) fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A query value decoded: `+` is a space, a `%` without two hex digits
/// stays as it is.
pub(crate) fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let pair = bytes
                    .get(index + 1..index + 3)
                    .filter(|pair| pair.iter().all(u8::is_ascii_hexdigit))
                    .and_then(|pair| std::str::from_utf8(pair).ok())
                    .and_then(|pair| u8::from_str_radix(pair, 16).ok());
                match pair {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The decoded value of `key` in an `a=1&b=2` query.
pub(crate) fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| percent_decode(value))
    })
}

/// The HTTP client of the sign-ins and refreshes.
#[derive(Clone)]
pub struct Http(reqwest::Client);

impl Default for Http {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        )
    }
}

impl Http {
    /// POSTs `body`: its status and text, or why it could not.
    pub(crate) async fn post(
        &self,
        url: &str,
        content_type: &str,
        body: String,
    ) -> Result<(u16, String), String> {
        let response = self
            .0
            .post(url)
            .header("Content-Type", content_type)
            .header("Accept", "application/json, text/plain, */*")
            .body(body)
            .send()
            .await
            .map_err(|_| "The sign-in server could not be reached".to_owned())?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|_| "The sign-in server's answer could not be read".to_owned())?;
        Ok((status, text))
    }
}

/// A GET's answer: status, `Retry-After` (seconds), text.
pub(crate) struct Got {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub text: String,
}

impl Http {
    /// GETs `url` with `headers`.
    pub(crate) async fn get(&self, url: &str, headers: &[(&str, String)]) -> Result<Got, String> {
        let mut request = self.0.get(url);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "The usage server could not be reached".to_owned())?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let text = response
            .text()
            .await
            .map_err(|_| "The usage server's answer could not be read".to_owned())?;
        Ok(Got {
            status,
            retry_after,
            text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_round_trips() {
        let encoded = percent_encode("a b:c/d");
        assert_eq!(encoded, "a%20b%3Ac%2Fd");
        assert_eq!(percent_decode(&encoded), "a b:c/d");
        assert_eq!(percent_decode("x+y%zz"), "x y%zz");
        assert_eq!(
            query_param("code=a%2Fb&state=s", "code").as_deref(),
            Some("a/b")
        );
        assert_eq!(query_param("code=a", "state"), None);
    }

    #[test]
    fn a_test_server_stands_in_for_every_endpoint() {
        let none = |_: &str| None;
        assert_eq!(Endpoints::from_env(&none), Endpoints::default());
        let test = |name: &str| (name == TEST_ACCOUNTS_URL_ENV).then(|| "http://t/".to_owned());
        let endpoints = Endpoints::from_env(&test);
        if roamgate_base::clock::TEST_CLOCK_HONOURED {
            assert_eq!(
                endpoints.claude_usage,
                "http://t/api.anthropic.com/api/oauth/usage"
            );
        } else {
            assert_eq!(endpoints, Endpoints::default());
        }
    }

    #[test]
    fn pkce_pairs_are_fresh_and_s256() {
        let (verifier, challenge) = new_pkce();
        assert_eq!(verifier.len(), 43);
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        assert_ne!(new_pkce().0, verifier);
    }
}
