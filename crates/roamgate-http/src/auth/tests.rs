//! http/auth.test.ts, case for case (the login page's own script is held
//! byte for byte in login_page::tests).

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::*;
use crate::test_support::*;

const SECRET: &str = "test-login-secret";

fn auth_with(config: AuthConfig, clock: &Arc<ManualClock>) -> Auth {
    Auth::new(config, shared(clock)).unwrap()
}

fn auth(password: &str) -> Auth {
    auth_with(
        AuthConfig::new(password, &"a".repeat(64)),
        &ManualClock::at(NOW),
    )
}

fn with_token(password: &str, token: &str) -> AuthConfig {
    let mut config = AuthConfig::new(password, &"a".repeat(64));
    config.url_login_token = Some(token.into());
    config
}

fn cookie_request(cookie: &str) -> Parts {
    parts("GET", "http://example.test/", &[("cookie", cookie)])
}

async fn password_login(auth: &Auth, password: &str, ip: &str, cookie: &str) -> Response {
    let head = parts(
        "POST",
        "http://example.test/api/login",
        &[("cookie", cookie)],
    );
    auth.handle_login(
        &head,
        body(serde_json::json!({"password": password}).to_string()),
        ip,
    )
    .await
}

fn token_login(auth: &Auth, token: &str, ip: &str, cookie: &str) -> Response {
    let head = parts(
        "GET",
        &format!("http://example.test/?token={token}"),
        &[("cookie", cookie)],
    );
    auth.handle_token_login(&head, ip).unwrap()
}

fn hmac_hex(key: &[u8], payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[test]
fn requires_authentication_by_default() {
    let auth = auth(SECRET);
    assert!(!auth.is_authed(&parts("GET", "http://localhost/", &[]).headers));
}

#[tokio::test]
async fn disabled_development_authentication_needs_no_password_or_cookie() {
    let mut config = with_token("", "ignored-token");
    config.auth_required = false;
    let auth = auth_with(config, &ManualClock::at(NOW));
    assert!(auth.is_authed(&parts("GET", "http://localhost/", &[]).headers));
    let page = auth.login_page(None);
    assert_eq!(page.status(), 302);
    assert_eq!(get(&page, "location").as_deref(), Some("/"));
    assert_eq!(get(&page, "cache-control").as_deref(), Some("no-store"));
    let response = auth
        .handle_login(
            &parts("POST", "http://localhost/api/login", &[]),
            None::<Body>,
            "127.0.0.1",
        )
        .await;
    assert_eq!(response.status(), 200);
    assert_eq!(json_of(&response)["ok"], true);
    assert!(get(&response, "set-cookie").is_none());
    assert!(
        auth.handle_token_login(
            &parts("GET", "http://localhost/?token=ignored-token", &[]),
            "127.0.0.1"
        )
        .is_none()
    );
}

#[test]
fn brands_the_login_page_as_roamgate() {
    let auth = auth("fixed-test-password");
    let page = auth.login_page(None);
    let html = std::str::from_utf8(page.body()).unwrap();
    assert!(html.contains("<title>Roamgate login</title>"));
    assert!(html.contains(r#"src="/roamgate-icon-192.png""#));
    assert!(html.contains(r#"<label for="pw">Password or token</label>"#));
    assert!(html.contains(r#"autocomplete="current-password""#));
    assert!(html.contains(r#"role="alert""#));
    assert_eq!(get(&page, "cache-control").as_deref(), Some("no-store"));
    assert!(!html.contains("herdr-gui"));
}

#[tokio::test]
async fn login_page_clears_drafts_only_for_missing_or_expired_authentication() {
    for pin in [false, true] {
        let clock = ManualClock::at(NOW);
        let mut config = AuthConfig::new(SECRET, &"a".repeat(64));
        if pin {
            config.pin = Some("123456".into());
        }
        let auth = auth_with(config, &clock);
        let clears = |response: &Response| {
            std::str::from_utf8(response.body())
                .unwrap()
                .contains("roamgate:terminalComposerLogout")
        };
        assert!(clears(&auth.login_page(None)));
        assert!(clears(
            &auth.login_page(Some(&parts("GET", "/login", &[]).headers))
        ));
        let cookie = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
        assert!(!clears(
            &auth.login_page(Some(&cookie_request(&cookie).headers))
        ));
        clock.advance(AUTH_TOKEN_TTL_SECONDS * 1000);
        assert!(clears(
            &auth.login_page(Some(&cookie_request(&cookie).headers))
        ));
    }
}

#[tokio::test]
async fn does_not_derive_authorization_from_reverse_proxy_authorities() {
    let auth = auth("fixed-test-password");
    let login = password_login(&auth, "fixed-test-password", "127.0.0.1", "").await;
    let proxied = parts(
        "GET",
        "http://upstream.example/ws",
        &[
            ("cookie", &cookie_header(&login)),
            ("origin", "https://dashboard.example.com"),
        ],
    );
    assert!(auth.is_authed(&proxied.headers));
}

#[tokio::test]
async fn sets_secure_for_both_login_paths_only_with_native_tls() {
    for secure in [false, true] {
        let mut config = with_token(SECRET, SECRET);
        config.secure_cookies = secure;
        let auth = auth_with(config, &ManualClock::at(NOW));
        let login = password_login(&auth, SECRET, "127.0.0.1", "").await;
        let token = token_login(&auth, SECRET, "127.0.0.1", "");
        for response in [login, token] {
            let cookie = get(&response, "set-cookie").unwrap();
            assert_eq!(cookie.contains("; Secure"), secure);
            assert!(cookie.contains("HttpOnly; SameSite=Lax"));
            assert!(auth.is_authed(&cookie_request(&cookie_header(&response)).headers));
        }
    }
}

#[test]
fn redirects_unauthenticated_html_requests_with_a_relative_location() {
    let response = unauthenticated_login_redirect();
    assert_eq!(response.status(), 302);
    assert_eq!(get(&response, "location").as_deref(), Some("/login"));
}

#[tokio::test]
async fn password_and_url_token_share_ip_rate_limits_clear_failures_and_expire_cooldowns() {
    for password_mode in [true, false] {
        let clock = ManualClock::at(NOW);
        let auth = auth_with(with_token(SECRET, SECRET), &clock);
        let login = |credential: &'static str, ip: &'static str| {
            let auth = &auth;
            async move {
                if password_mode {
                    password_login(auth, credential, ip, "").await
                } else {
                    token_login(auth, credential, ip, "")
                }
            }
        };
        let invalid = if password_mode { 401 } else { 303 };
        let ok = if password_mode { 200 } else { 303 };
        for _ in 0..4 {
            assert_eq!(login("wrong", "192.0.2.1").await.status(), invalid);
        }
        let authenticated = cookie_header(&login(SECRET, "192.0.2.1").await);
        for _ in 0..5 {
            assert_eq!(login("wrong", "192.0.2.1").await.status(), invalid);
        }
        let blocked = login(SECRET, "192.0.2.1").await;
        assert_eq!(blocked.status(), 429);
        assert_eq!(get(&blocked, "retry-after").as_deref(), Some("300"));
        assert_eq!(get(&blocked, "cache-control").as_deref(), Some("no-store"));
        assert!(get(&blocked, "set-cookie").is_none());
        assert!(auth.is_authed(&cookie_request(&authenticated).headers));
        assert_eq!(login(SECRET, "192.0.2.2").await.status(), ok);
        // Password and URL-token entry points cannot bypass each other's cooldown.
        let other = if password_mode {
            token_login(&auth, SECRET, "192.0.2.1", "")
        } else {
            password_login(&auth, SECRET, "192.0.2.1", "").await
        };
        assert_eq!(other.status(), 429);
        clock.advance(299_999);
        assert_eq!(
            get(&login(SECRET, "192.0.2.1").await, "retry-after").as_deref(),
            Some("1")
        );
        clock.advance(1);
        assert_eq!(login(SECRET, "192.0.2.1").await.status(), ok);

        for _ in 0..20 {
            assert_eq!(login(SECRET, "192.0.2.3").await.status(), ok);
        }
        assert_eq!(
            get(&login(SECRET, "192.0.2.3").await, "retry-after").as_deref(),
            Some("60")
        );
        clock.advance(59_999);
        assert_eq!(login(SECRET, "192.0.2.3").await.status(), 429);
        clock.advance(1);
        assert_eq!(login(SECRET, "192.0.2.3").await.status(), ok);
    }
}

#[tokio::test]
async fn reserves_concurrent_attempts_before_reading_json_and_counts_malformed_failures() {
    let auth = Arc::new(auth(SECRET));
    // 25 requests reserve their attempt, then their bodies arrive.
    let mut senders = Vec::new();
    let mut tasks = Vec::new();
    for _ in 0..25 {
        let (body, sender) = slow_body();
        senders.push(sender);
        let auth = auth.clone();
        tasks.push(tokio::spawn(async move {
            let head = parts("POST", "http://example.test/api/login", &[]);
            auth.handle_login(&head, body, "192.0.2.1").await.status()
        }));
    }
    tokio::task::yield_now().await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    for sender in senders {
        let _ = sender.send(Bytes::from(
            serde_json::json!({"password": SECRET}).to_string(),
        ));
        drop(sender);
    }
    let mut statuses = Vec::new();
    for task in tasks {
        statuses.push(task.await.unwrap());
    }
    assert_eq!(statuses.iter().filter(|status| **status == 200).count(), 20);
    assert_eq!(statuses.iter().filter(|status| **status == 429).count(), 5);
    let head = parts("POST", "http://example.test/api/login", &[]);
    for _ in 0..5 {
        assert_eq!(
            auth.handle_login(&head, body("invalid json"), "192.0.2.2")
                .await
                .status(),
            400
        );
    }
    assert_eq!(
        password_login(&auth, SECRET, "192.0.2.2", "")
            .await
            .status(),
        429
    );
}

#[test]
fn bounds_ip_state_without_evicting_cooldowns_and_reclaims_expired_entries() {
    let clock = ManualClock::at(NOW);
    let auth = auth_with(with_token(SECRET, SECRET), &clock);
    let login = |ip: &str| {
        auth.handle_token_login(&parts("GET", "http://example.test/?token=wrong", &[]), ip)
            .unwrap()
            .status()
    };
    for _ in 0..5 {
        assert_eq!(login("blocked"), 303);
    }
    for index in 1..4096 {
        assert_eq!(login(&format!("ip-{index}")), 303);
    }
    assert_eq!(login("new-ip"), 429);
    assert_eq!(login("blocked"), 429);
    clock.advance(300_000);
    assert_eq!(login("new-ip"), 303);
}

#[tokio::test]
async fn rejects_oversized_streamed_json_and_cancels_reading_without_content_length() {
    let auth = auth(SECRET);
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let head = br#"{"password":""#.to_vec();
    // A stream that would go on forever: only dropping it ends it.
    let flag = cancelled.clone();
    struct Guard(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    flag.store(false, std::sync::atomic::Ordering::SeqCst);
    let guard = Guard(flag);
    let endless = futures_util::stream::iter(
        std::iter::once(head).chain(std::iter::repeat(vec![0u8; 16 * 1024])),
    )
    .map(move |chunk| {
        let _ = &guard;
        Ok::<_, std::convert::Infallible>(Bytes::from(chunk))
    });
    let response = auth
        .handle_login(
            &parts("POST", "http://example.test/api/login", &[]),
            Some(Box::pin(endless)),
            "192.0.2.1",
        )
        .await;
    assert_eq!(response.status(), 413);
    assert!(cancelled.load(std::sync::atomic::Ordering::SeqCst));
    assert!(get(&response, "set-cookie").is_none());
}

#[tokio::test]
async fn slow_login_bodies_cannot_bypass_a_replaced_ip_record_s_cooldown() {
    let clock = ManualClock::at(NOW);
    let auth = Arc::new(auth_with(AuthConfig::new(SECRET, &"a".repeat(64)), &clock));
    let (slow, sender) = slow_body();
    let pending = {
        let auth = auth.clone();
        tokio::spawn(async move {
            auth.handle_login(
                &parts("POST", "http://example.test/api/login", &[]),
                slow,
                "192.0.2.1",
            )
            .await
        })
    };
    tokio::task::yield_now().await;
    clock.advance(300_000);
    for _ in 0..5 {
        assert_eq!(
            password_login(&auth, "wrong", "192.0.2.1", "")
                .await
                .status(),
            401
        );
    }
    sender
        .send(Bytes::from(
            serde_json::json!({"password": SECRET}).to_string(),
        ))
        .unwrap();
    drop(sender);
    let response = pending.await.unwrap();
    assert_eq!(response.status(), 429);
    assert!(get(&response, "set-cookie").is_none());
}

#[tokio::test]
async fn a_slow_failure_finishing_after_cooldown_starts_a_fresh_failure_count() {
    for wrong_password in [true, false] {
        let clock = ManualClock::at(NOW);
        let auth = Arc::new(auth_with(AuthConfig::new(SECRET, &"a".repeat(64)), &clock));
        let (slow, sender) = slow_body();
        let pending = {
            let auth = auth.clone();
            tokio::spawn(async move {
                auth.handle_login(
                    &parts("POST", "http://example.test/api/login", &[]),
                    slow,
                    "192.0.2.1",
                )
                .await
            })
        };
        tokio::task::yield_now().await;
        for _ in 0..5 {
            assert_eq!(
                password_login(&auth, "wrong", "192.0.2.1", "")
                    .await
                    .status(),
                401
            );
        }
        // Keep the same IP record alive without moving its cooldown deadline.
        clock.advance(299_999);
        assert_eq!(
            password_login(&auth, SECRET, "192.0.2.1", "")
                .await
                .status(),
            429
        );
        clock.advance(1);
        let text = if wrong_password {
            serde_json::json!({"password": "wrong"}).to_string()
        } else {
            "invalid json".to_owned()
        };
        sender.send(Bytes::from(text)).unwrap();
        drop(sender);
        let response = pending.await.unwrap();
        assert_eq!(response.status(), if wrong_password { 401 } else { 400 });
        assert!(get(&response, "set-cookie").is_none());
        assert_eq!(
            password_login(&auth, SECRET, "192.0.2.1", "")
                .await
                .status(),
            200
        );
    }
}

#[tokio::test]
async fn reauthentication_preserves_the_current_cookie_and_its_expiry() {
    for password_mode in [true, false] {
        let auth = auth_with(with_token(SECRET, SECRET), &ManualClock::at(NOW));
        let login = |cookie: String, credential: &'static str| {
            let auth = &auth;
            async move {
                if password_mode {
                    password_login(auth, credential, "127.0.0.1", &cookie).await
                } else {
                    token_login(auth, credential, "127.0.0.1", &cookie)
                }
            }
        };
        let first = cookie_header(&login(String::new(), SECRET).await);
        let other_browser = cookie_header(&login(String::new(), SECRET).await);
        assert_ne!(other_browser, first);
        // No Set-Cookie means the browser retains both the token and original TTL.
        assert!(get(&login(first.clone(), SECRET).await, "set-cookie").is_none());
        assert!(get(&login(first.clone(), SECRET).await, "set-cookie").is_none());
        assert!(auth.is_authed(&cookie_request(&first).headers));
        let invalid = login(first.clone(), "wrong").await;
        assert!(get(&invalid, "set-cookie").is_none());
        if password_mode {
            assert_eq!(invalid.status(), 401);
        } else {
            assert_eq!(get(&invalid, "location").as_deref(), Some("/login"));
        }
        let expired_payload = URL_SAFE_NO_PAD.encode(r#"{"exp":0}"#);
        let expired_signature = hmac_hex(&hex::decode("a".repeat(64)).unwrap(), &expired_payload);
        for cookie in [
            "herdr_auth=invalid".to_owned(),
            format!("herdr_auth={expired_payload}.{expired_signature}"),
        ] {
            let replaced = cookie_header(&login(cookie.clone(), SECRET).await);
            assert_ne!(replaced, cookie);
            assert!(auth.is_authed(&cookie_request(&replaced).headers));
        }
    }
}

#[tokio::test]
async fn expires_the_cookie_with_matching_attributes() {
    for secure in [false, true] {
        let mut config = AuthConfig::new(SECRET, &"a".repeat(64));
        config.secure_cookies = secure;
        let auth = auth_with(config, &ManualClock::at(NOW));
        let first = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
        let second = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
        let logout = auth.handle_logout(&parts(
            "POST",
            "http://example.test/api/logout",
            &[("cookie", &first), ("x-roamgate-logout", "1")],
        ));
        assert_eq!(logout.status(), 204);
        assert_eq!(get(&logout, "cache-control").as_deref(), Some("no-store"));
        assert_eq!(
            get(&logout, "set-cookie").unwrap(),
            format!(
                "herdr_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
                if secure { "; Secure" } else { "" }
            )
        );
        assert!(!auth.is_authed(&cookie_request(&cookie_header(&logout)).headers));
        assert!(auth.is_authed(&cookie_request(&second).headers));
        assert_eq!(
            password_login(&auth, SECRET, "127.0.0.1", "")
                .await
                .status(),
            200
        );
    }
}

#[tokio::test]
async fn ends_the_cookie_on_the_server_too_across_a_restart() {
    use roamgate_base::paths::{DataContext, Platform};
    use roamgate_base::revoked_sessions::RevokedSessions;
    let home = tempfile::tempdir().unwrap();
    let context = DataContext::new(home.path(), Platform::Unix, None);
    let directory = home.path().join(".config/roamgate");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("session-secret.revoked.json");
    let clock = ManualClock::at(NOW);
    let start = || {
        auth_with(AuthConfig::new(SECRET, &"a".repeat(64)), &clock)
            .with_revoked(RevokedSessions::open(Some(context.clone()), Some(&path)))
    };
    let auth = start();
    let first = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
    let second = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
    assert!(auth.is_authed(&cookie_request(&first).headers));
    let logout = auth.handle_logout(&parts(
        "POST",
        "http://example.test/api/logout",
        &[("cookie", &first), ("x-roamgate-logout", "1")],
    ));
    assert_eq!(logout.status(), 204);
    // A copy of the ended cookie no longer logs in; the other browser's does.
    assert!(!auth.is_authed(&cookie_request(&first).headers));
    assert!(auth.is_authed(&cookie_request(&second).headers));
    let restarted = start();
    assert!(!restarted.is_authed(&cookie_request(&first).headers));
    assert!(restarted.is_authed(&cookie_request(&second).headers));
    // The cookie itself is never written down.
    let kept = std::fs::read_to_string(&path).unwrap();
    assert!(!kept.contains(first.split_once('=').unwrap().1));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn rejects_get_and_cross_site_logout_but_allows_retry_without_a_cookie() {
    let auth = auth(SECRET);
    for method in ["GET", "HEAD", "OPTIONS"] {
        let response = auth.handle_logout(&parts(method, "http://example.test/api/logout", &[]));
        assert_eq!(response.status(), 405);
        assert_eq!(get(&response, "allow").as_deref(), Some("POST"));
        assert!(get(&response, "set-cookie").is_none());
    }
    for headers in [
        vec![],
        vec![("x-roamgate-logout", "1"), ("sec-fetch-site", "cross-site")],
    ] {
        let response =
            auth.handle_logout(&parts("POST", "http://example.test/api/logout", &headers));
        assert_eq!(response.status(), 403);
        assert!(get(&response, "set-cookie").is_none());
    }
    let request = parts(
        "POST",
        "http://upstream.example/api/logout",
        &[
            ("x-roamgate-logout", "1"),
            ("origin", "https://proxy.example"),
        ],
    );
    assert_eq!(auth.handle_logout(&request).status(), 204);
    assert_eq!(auth.handle_logout(&request).status(), 204);
}

#[test]
fn exchanges_a_url_token_for_a_signed_cookie_and_strips_it() {
    let auth = auth_with(
        with_token("generated-secret", "generated-secret"),
        &ManualClock::at(NOW),
    );
    let response = auth
        .handle_token_login(
            &parts(
                "GET",
                "http://example.test/workspace?view=terminal&token=generated-secret",
                &[],
            ),
            "127.0.0.1",
        )
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(
        get(&response, "location").as_deref(),
        Some("/workspace?view=terminal")
    );
    assert_eq!(get(&response, "cache-control").as_deref(), Some("no-store"));
    assert_eq!(
        get(&response, "referrer-policy").as_deref(),
        Some("no-referrer")
    );
    assert!(auth.is_authed(&cookie_request(&cookie_header(&response)).headers));
    // URLSearchParams' serialisation of what stays, as Bun's URL writes it.
    let response = auth
        .handle_token_login(
            &parts(
                "GET",
                "http://example.test/a/../b%7e?view=te%20rminal&token=generated-secret&x=%41",
                &[],
            ),
            "127.0.0.1",
        )
        .unwrap();
    assert_eq!(
        get(&response, "location").as_deref(),
        Some("/b%7e?view=te+rminal&x=A")
    );
    let response = auth
        .handle_token_login(
            &parts(
                "GET",
                "/?token=generated-secret",
                &[("host", "example.test")],
            ),
            "127.0.0.1",
        )
        .unwrap();
    assert_eq!(get(&response, "location").as_deref(), Some("/"));
}

#[test]
fn removes_an_invalid_token_without_creating_a_session() {
    let auth = auth_with(
        with_token("generated-secret", "generated-secret"),
        &ManualClock::at(NOW),
    );
    let response = auth
        .handle_token_login(
            &parts("GET", "http://example.test/?token=wrong", &[]),
            "127.0.0.1",
        )
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(get(&response, "location").as_deref(), Some("/login"));
    assert!(get(&response, "set-cookie").is_none());
}

#[tokio::test]
async fn token_login_ignores_websocket_upgrades_and_api_requests() {
    let auth = auth_with(
        with_token("generated-secret", "generated-secret"),
        &ManualClock::at(NOW),
    );
    let upgrade: &[(&str, &str)] = &[
        ("connection", "Upgrade"),
        ("upgrade", "websocket"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
        ("sec-fetch-mode", "websocket"),
    ];
    // A call's signalling carries a token of its own: its route judges it.
    let not_logins = [
        parts("GET", "http://example.test/?token=wrong", upgrade),
        parts(
            "GET",
            "http://example.test/api/voice/call/signalling?call=1&token=x",
            upgrade,
        ),
        parts(
            "GET",
            "http://example.test/api/voice/call/signalling?token=x",
            &[],
        ),
        parts("GET", "http://example.test/api?token=x", &[]),
        parts(
            "GET",
            "http://example.test/?token=wrong",
            &[("sec-fetch-mode", "cors")],
        ),
    ];
    for _ in 0..2 {
        for request in &not_logins {
            assert!(auth.handle_token_login(request, "127.0.0.1").is_none());
        }
    }
    // None counted: the right password still logs in from the same address.
    assert_eq!(
        password_login(&auth, "generated-secret", "127.0.0.1", "")
            .await
            .status(),
        200
    );
    // A page opened with the token still logs in.
    let navigation = auth
        .handle_token_login(
            &parts(
                "GET",
                "http://example.test/workspace?token=generated-secret",
                &[("sec-fetch-mode", "navigate"), ("accept", "text/html")],
            ),
            "127.0.0.1",
        )
        .unwrap();
    assert_eq!(navigation.status(), 303);
    assert_eq!(get(&navigation, "location").as_deref(), Some("/workspace"));
    assert!(get(&navigation, "set-cookie").is_some());
}

#[test]
fn ignores_token_parameters_when_url_login_is_not_enabled() {
    let auth = auth("fixed-test-password");
    assert!(
        auth.handle_token_login(
            &parts("GET", "http://example.test/?token=fixed-test-password", &[]),
            "127.0.0.1"
        )
        .is_none()
    );
}

#[tokio::test]
async fn preserves_fixed_test_password_login_behavior() {
    let auth = auth("fixed-test-password");
    let response = password_login(&auth, "fixed-test-password", "127.0.0.1", "").await;
    assert_eq!(response.status(), 200);
    assert_eq!(
        std::str::from_utf8(response.body()).unwrap(),
        r#"{"ok":true}"#
    );
    assert_eq!(
        get(&response, "content-type").as_deref(),
        Some("application/json")
    );
    assert!(auth.is_authed(&cookie_request(&cookie_header(&response)).headers));
}

#[test]
fn builds_an_encoded_token_url_for_browser_launch() {
    assert_eq!(
        with_login_token("http://localhost:8787", Some("secret token")),
        "http://localhost:8787/?token=secret+token"
    );
    assert_eq!(
        with_login_token("http://localhost:8787/?a=1&token=x&token=y", Some("z")),
        "http://localhost:8787/?a=1&token=z"
    );
    assert_eq!(with_login_token("not a url", Some("z")), "not a url");
    assert_eq!(
        with_login_token("http://localhost:8787", None),
        "http://localhost:8787"
    );
}

#[test]
fn rejects_an_empty_authentication_secret() {
    let error = Auth::new(
        AuthConfig::new("", &"a".repeat(64)),
        shared(&ManualClock::at(NOW)),
    )
    .err()
    .unwrap();
    assert!(error.contains("at least 8 characters"));
}

#[tokio::test]
async fn password_and_url_token_cannot_forge_a_session_cookie() {
    let session_secret = "a".repeat(64);
    let clock = ManualClock::at(NOW);
    let auth = auth_with(with_token(SECRET, SECRET), &clock);
    let cookie = cookie_header(&password_login(&auth, SECRET, "127.0.0.1", "").await);
    let payload = cookie["herdr_auth=".len()..]
        .split('.')
        .next()
        .unwrap()
        .to_owned();
    let forged = hmac_hex(SECRET.as_bytes(), &payload);
    assert!(!auth.is_authed(&cookie_request(&format!("herdr_auth={payload}.{forged}")).headers));
    assert!(
        auth_with(AuthConfig::new(SECRET, &session_secret), &clock)
            .is_authed(&cookie_request(&cookie).headers)
    );
    assert!(
        !auth_with(AuthConfig::new(SECRET, &"b".repeat(64)), &clock)
            .is_authed(&cookie_request(&cookie).headers)
    );
    assert_eq!(
        password_login(&auth, &session_secret, "127.0.0.2", "")
            .await
            .status(),
        401
    );
}

#[test]
fn rejects_missing_or_malformed_signing_secrets_instead_of_falling_back_to_password() {
    for secret in [
        "",
        "password-as-signing-key",
        &"a".repeat(63),
        &"A".repeat(64),
    ] {
        let error = Auth::new(
            AuthConfig::new(SECRET, secret),
            shared(&ManualClock::at(NOW)),
        )
        .err()
        .unwrap();
        assert!(error.contains("256-bit session signing secret"), "{error}");
    }
}

#[test]
fn cookies_parse_as_the_ts_parser_reads_them() {
    assert_eq!(
        parse_cookie(Some("a=1; herdr_auth=x%2Ey=z"), AUTH_COOKIE).as_deref(),
        Some("x.y=z")
    );
    assert_eq!(parse_cookie(Some("herdr_auth=%zz"), AUTH_COOKIE), None);
    assert_eq!(parse_cookie(Some("herdr_auth=%C3"), AUTH_COOKIE), None);
    assert_eq!(parse_cookie(Some("other=1"), AUTH_COOKIE), None);
    assert_eq!(parse_cookie(None, AUTH_COOKIE), None);
}
