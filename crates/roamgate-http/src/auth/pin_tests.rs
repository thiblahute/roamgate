//! http/auth-pin.test.ts, case for case.

use std::sync::Arc;

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use super::*;
use crate::test_support::*;

const PASSWORD: &str = "strong-test-password";
const PIN: &str = "123456";

fn session_secret() -> String {
    "a".repeat(64)
}

fn url_token() -> String {
    "b".repeat(64)
}

fn base_config() -> AuthConfig {
    let mut config = AuthConfig::new(PASSWORD, &session_secret());
    config.pin = Some(PIN.into());
    config.url_login_token = Some(url_token());
    config
}

fn make(config: AuthConfig, clock: &Arc<ManualClock>) -> Auth {
    Auth::new(config, shared(clock)).unwrap()
}

fn base() -> (Auth, Arc<ManualClock>) {
    let clock = ManualClock::at(NOW);
    (make(base_config(), &clock), clock)
}

fn json_body(value: serde_json::Value) -> Option<Body> {
    body(value.to_string())
}

async fn pin_login_as(auth: &Auth, ip: &str, pin: &str) -> Response {
    let head = parts(
        "POST",
        "https://example.test/api/login/pin",
        &[("content-type", "application/json")],
    );
    auth.handle_pin_login(&head, json_body(serde_json::json!({"pin": pin})), ip)
        .await
}

async fn pin_login(auth: &Auth, ip: &str) -> Response {
    pin_login_as(auth, ip, PIN).await
}

async fn password_login(auth: &Auth, ip: &str) -> Response {
    let head = parts(
        "POST",
        "https://example.test/api/login",
        &[("content-type", "application/json")],
    );
    auth.handle_login(
        &head,
        json_body(serde_json::json!({"password": PASSWORD})),
        ip,
    )
    .await
}

fn token_login(auth: &Auth, ip: &str) -> Response {
    auth.handle_token_login(
        &parts(
            "GET",
            &format!("https://example.test/?token={}", url_token()),
            &[],
        ),
        ip,
    )
    .unwrap()
}

fn authenticated(cookie: &str) -> HeaderMap {
    parts("GET", "https://example.test/", &[("cookie", cookie)]).headers
}

async fn fail_pins(auth: &Auth, count: usize, prefix: &str) {
    for index in 0..count {
        let response = pin_login_as(auth, &format!("{prefix}-{index}"), "000000").await;
        assert_eq!(response.status(), 401);
        assert!(get(&response, "set-cookie").is_none());
    }
}

fn hmac_hex(key: &[u8], payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[tokio::test]
async fn pin_is_disabled_by_default_and_does_not_consume_the_recovery_budget() {
    let auth = make(
        AuthConfig::new(PASSWORD, &session_secret()),
        &ManualClock::at(NOW),
    );
    for _ in 0..25 {
        let response = pin_login(&auth, "192.0.2.1").await;
        assert_eq!(response.status(), 404);
        assert!(get(&response, "set-cookie").is_none());
    }
    assert_eq!(password_login(&auth, "192.0.2.1").await.status(), 200);
}

#[tokio::test]
async fn accepts_an_explicitly_configured_pin_with_valid_digits() {
    for pin in ["123456", "000001", "123456789012"] {
        let mut config = base_config();
        config.pin = Some(pin.into());
        let auth = make(config, &ManualClock::at(NOW));
        let response = pin_login_as(&auth, "192.0.2.1", pin).await;
        assert_eq!(response.status(), 200);
        assert_eq!(json_of(&response), serde_json::json!({"ok": true}));
        assert!(auth.is_authed(&authenticated(&cookie_header(&response))));
    }
}

#[test]
fn rejects_invalid_configured_pins() {
    for pin in [
        "",
        "12345",
        "1234567890123",
        "abcdef",
        " 123456",
        "123456 ",
        "123456\n",
        "123.45",
        "\u{661}\u{662}\u{663}\u{664}\u{665}\u{666}",
    ] {
        let mut config = base_config();
        config.pin = Some(pin.into());
        let error = Auth::new(config, shared(&ManualClock::at(NOW)))
            .err()
            .unwrap();
        assert!(error.contains("6 to 12 ASCII digits"), "{pin:?}");
    }
}

#[tokio::test]
async fn requires_an_exact_string_pin() {
    for pin in [
        serde_json::json!(123456),
        serde_json::json!(null),
        serde_json::json!(true),
        serde_json::json!([PIN]),
        serde_json::json!({"value": PIN}),
        serde_json::json!("123456 "),
        serde_json::json!("12345"),
    ] {
        let (auth, _) = base();
        let head = parts("POST", "https://example.test/api/login/pin", &[]);
        let response = auth
            .handle_pin_login(&head, json_body(serde_json::json!({"pin": pin})), "client")
            .await;
        assert_eq!(response.status(), 401);
        assert_eq!(
            json_of(&response),
            serde_json::json!({"error": "wrong PIN"})
        );
        assert!(get(&response, "set-cookie").is_none());
    }
}

#[tokio::test]
async fn password_url_token_and_pin_cannot_substitute_for_each_other() {
    let (auth, _) = base();
    for value in [
        serde_json::json!({"password": PIN}),
        serde_json::json!({"pin": PIN}),
    ] {
        let head = parts("POST", "https://example.test/api/login", &[]);
        let response = auth.handle_login(&head, json_body(value), "password").await;
        assert_eq!(response.status(), 401);
        assert!(get(&response, "set-cookie").is_none());
    }
    for value in [
        serde_json::json!({"pin": PASSWORD}),
        serde_json::json!({"password": PASSWORD}),
        serde_json::json!({"pin": url_token()}),
    ] {
        let head = parts("POST", "https://example.test/api/login/pin", &[]);
        let response = auth.handle_pin_login(&head, json_body(value), "pin").await;
        assert_eq!(response.status(), 401);
        assert!(get(&response, "set-cookie").is_none());
    }
    let token = auth
        .handle_token_login(
            &parts("GET", &format!("https://example.test/?token={PIN}"), &[]),
            "token",
        )
        .unwrap();
    assert_eq!(token.status(), 303);
    assert_eq!(get(&token, "location").as_deref(), Some("/login"));
    assert!(get(&token, "set-cookie").is_none());
    assert_eq!(password_login(&auth, "192.0.2.1").await.status(), 200);
    assert_eq!(pin_login(&auth, "192.0.2.1").await.status(), 200);
    assert!(get(&token_login(&auth, "192.0.2.1"), "set-cookie").is_some());
}

#[tokio::test]
async fn pin_issues_a_verified_session_with_correct_cookie_attributes() {
    for secure in [false, true] {
        let mut config = base_config();
        config.secure_cookies = secure;
        let auth = make(config, &ManualClock::at(NOW));
        let response = pin_login(&auth, "192.0.2.1").await;
        let cookie = cookie_header(&response);
        assert_eq!(get(&response, "cache-control").as_deref(), Some("no-store"));
        let set = get(&response, "set-cookie").unwrap();
        assert!(set.contains("; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"));
        assert_eq!(set.contains("; Secure"), secure);
        assert!(auth.is_authed(&authenticated(&cookie)));
        let (payload, signature) = cookie["herdr_auth=".len()..].split_once('.').unwrap();
        assert_eq!(
            signature,
            hmac_hex(&hex::decode(session_secret()).unwrap(), payload)
        );
        let decoded: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            decoded["exp"].as_i64().unwrap() - decoded["iat"].as_i64().unwrap(),
            30 * 24 * 60 * 60
        );
        let nonce = decoded["nonce"].as_str().unwrap();
        assert!(
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        let keys: Vec<&String> = decoded.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["iat", "exp", "nonce"]);
    }
}

#[tokio::test]
async fn changing_either_credential_preserves_sessions_changing_signing_secret_invalidates_them() {
    let (auth, clock) = base();
    let cookie = cookie_header(&pin_login(&auth, "192.0.2.1").await);
    let mut configs = Vec::new();
    let mut config = base_config();
    config.pin = Some("654321".into());
    configs.push(config);
    let mut config = base_config();
    config.pin = None;
    configs.push(config);
    let mut config = base_config();
    config.password = "a-different-strong-password".into();
    configs.push(config);
    let mut config = base_config();
    config.url_login_token = Some("c".repeat(64));
    configs.push(config);
    for config in configs {
        assert!(make(config, &clock).is_authed(&authenticated(&cookie)));
    }
    let mut config = base_config();
    config.session_secret = "d".repeat(64);
    assert!(!make(config, &clock).is_authed(&authenticated(&cookie)));
    let payload = cookie["herdr_auth=".len()..].split('.').next().unwrap();
    for key in [PIN.to_owned(), PASSWORD.to_owned(), url_token()] {
        let forged = hmac_hex(key.as_bytes(), payload);
        assert!(!auth.is_authed(&authenticated(&format!("herdr_auth={payload}.{forged}"))));
    }
}

#[tokio::test]
async fn pin_reauthentication_preserves_an_existing_session_and_original_expiry() {
    let (auth, clock) = base();
    let cookie = cookie_header(&pin_login(&auth, "192.0.2.1").await);
    clock.advance(60_000);
    let head = parts(
        "POST",
        "https://example.test/api/login/pin",
        &[("cookie", &cookie)],
    );
    let response = auth
        .handle_pin_login(&head, json_body(serde_json::json!({"pin": PIN})), "client")
        .await;
    assert_eq!(response.status(), 200);
    assert!(get(&response, "set-cookie").is_none());
    assert_ne!(cookie_header(&pin_login(&auth, "192.0.2.1").await), cookie);
    clock.advance(30 * 24 * 60 * 60_000 - 60_000);
    assert!(!auth.is_authed(&authenticated(&cookie)));
}

#[tokio::test]
async fn five_failures_block_only_that_pin_client_and_cannot_consume_password_or_token_recovery() {
    let (auth, clock) = base();
    for _ in 0..5 {
        assert_eq!(pin_login_as(&auth, "blocked", "000000").await.status(), 401);
    }
    let blocked = pin_login(&auth, "blocked").await;
    assert_eq!(blocked.status(), 429);
    assert_eq!(get(&blocked, "retry-after").as_deref(), Some("300"));
    assert!(get(&blocked, "set-cookie").is_none());
    assert_eq!(password_login(&auth, "blocked").await.status(), 200);
    assert!(get(&token_login(&auth, "blocked"), "set-cookie").is_some());
    assert_eq!(pin_login(&auth, "other").await.status(), 200);
    // Success on another client must not clear the blocked client's cooldown.
    assert_eq!(pin_login(&auth, "blocked").await.status(), 429);
    clock.advance(299_999);
    assert_eq!(
        get(&pin_login(&auth, "blocked").await, "retry-after").as_deref(),
        Some("1")
    );
    clock.advance(1);
    assert_eq!(pin_login(&auth, "blocked").await.status(), 200);
}

#[tokio::test]
async fn password_cooldowns_do_not_block_pin_and_pin_success_cannot_clear_strong_recovery_cooldowns()
 {
    let (auth, _) = base();
    for _ in 0..5 {
        let head = parts("POST", "https://example.test/api/login", &[]);
        let response = auth
            .handle_login(
                &head,
                json_body(serde_json::json!({"password": "wrong"})),
                "client",
            )
            .await;
        assert_eq!(response.status(), 401);
    }
    assert_eq!(password_login(&auth, "client").await.status(), 429);
    assert_eq!(pin_login(&auth, "client").await.status(), 200);
    assert_eq!(password_login(&auth, "client").await.status(), 429);
    assert_eq!(token_login(&auth, "client").status(), 429);
}

#[tokio::test]
async fn recovery_works_during_pin_lockout_without_clearing_pin_failures_or_cooldown() {
    for password_mode in [true, false] {
        let (auth, _) = base();
        let recover = || {
            let auth = &auth;
            async move {
                if password_mode {
                    password_login(auth, "bad-0").await
                } else {
                    token_login(auth, "bad-0")
                }
            }
        };
        let ok = if password_mode { 200 } else { 303 };
        fail_pins(&auth, 9, "bad").await;
        let before = recover().await;
        assert_eq!(before.status(), ok);
        assert!(auth.is_authed(&authenticated(&cookie_header(&before))));
        assert_eq!(pin_login_as(&auth, "tenth", "000000").await.status(), 401);
        let blocked = pin_login(&auth, "new-client").await;
        assert_eq!(blocked.status(), 429);
        assert_eq!(get(&blocked, "retry-after").as_deref(), Some("3600"));
        assert_eq!(get(&blocked, "cache-control").as_deref(), Some("no-store"));
        assert_eq!(
            get(&blocked, "referrer-policy").as_deref(),
            Some("no-referrer")
        );
        assert!(get(&blocked, "set-cookie").is_none());
        let during = recover().await;
        assert_eq!(during.status(), ok);
        assert!(auth.is_authed(&authenticated(&cookie_header(&during))));
        assert_eq!(pin_login(&auth, "bad-0").await.status(), 429);
        assert!(auth.is_authed(&authenticated(&cookie_header(&before))));
    }
}

#[tokio::test]
async fn successful_pin_authentication_resets_consecutive_global_and_per_ip_failures() {
    let (auth, _) = base();
    fail_pins(&auth, 5, "bad").await;
    for _ in 0..4 {
        assert_eq!(pin_login_as(&auth, "client", "000000").await.status(), 401);
    }
    assert_eq!(pin_login(&auth, "client").await.status(), 200);
    for _ in 0..4 {
        assert_eq!(pin_login_as(&auth, "client", "000000").await.status(), 401);
    }
    fail_pins(&auth, 5, "after-success").await;
    assert_eq!(pin_login(&auth, "fresh-client").await.status(), 200);
}

#[tokio::test]
async fn global_cooldown_expires_after_an_hour_is_not_extended_and_resets_failures() {
    let (auth, clock) = base();
    let session = cookie_header(&pin_login(&auth, "192.0.2.1").await);
    fail_pins(&auth, 10, "bad").await;
    clock.advance(3_599_999);
    let blocked = pin_login(&auth, "new-client").await;
    assert_eq!(blocked.status(), 429);
    assert_eq!(get(&blocked, "retry-after").as_deref(), Some("1"));
    assert!(auth.is_authed(&authenticated(&session)));
    clock.advance(1);
    // Nine new failures must be allowed even before any successful recovery.
    fail_pins(&auth, 9, "recovered").await;
    assert_eq!(pin_login(&auth, "new-client").await.status(), 200);
}

#[tokio::test]
async fn successful_pin_attempts_have_a_separate_20_per_minute_ip_budget() {
    let (auth, clock) = base();
    let mut statuses = Vec::new();
    for _ in 0..25 {
        statuses.push(pin_login(&auth, "client").await.status());
    }
    assert_eq!(statuses.iter().filter(|status| **status == 200).count(), 20);
    assert_eq!(statuses.iter().filter(|status| **status == 429).count(), 5);
    assert_eq!(
        get(&pin_login(&auth, "client").await, "retry-after").as_deref(),
        Some("60")
    );
    assert_eq!(password_login(&auth, "client").await.status(), 200);
    assert!(get(&token_login(&auth, "client"), "set-cookie").is_some());
    clock.advance(59_999);
    assert_eq!(pin_login(&auth, "client").await.status(), 429);
    clock.advance(1);
    assert_eq!(pin_login(&auth, "client").await.status(), 200);
}

#[tokio::test]
async fn global_consecutive_failures_survive_per_ip_window_and_record_expiry() {
    let (auth, clock) = base();
    for index in 0..10 {
        assert_eq!(pin_login_as(&auth, "client", "000000").await.status(), 401);
        if index < 9 {
            clock.advance(300_000);
        }
    }
    let blocked = pin_login(&auth, "fresh-client").await;
    assert_eq!(blocked.status(), 429);
    assert_eq!(get(&blocked, "retry-after").as_deref(), Some("3600"));
}

#[tokio::test]
async fn parallel_failures_cannot_overrun_the_failure_threshold() {
    for one_client in [true, false] {
        let clock = ManualClock::at(NOW);
        let auth = Arc::new(make(base_config(), &clock));
        let mut senders = Vec::new();
        let mut tasks = Vec::new();
        for index in 0..30 {
            let (slow, sender) = slow_body();
            senders.push(sender);
            let auth = auth.clone();
            let ip = if one_client {
                "client".to_owned()
            } else {
                format!("client-{index}")
            };
            tasks.push(tokio::spawn(async move {
                let response = auth
                    .handle_pin_login(
                        &parts("POST", "https://example.test/api/login/pin", &[]),
                        slow,
                        &ip,
                    )
                    .await;
                (response.status(), get(&response, "set-cookie").is_some())
            }));
        }
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        for sender in senders {
            let _ = sender.send(Bytes::from(
                serde_json::json!({"pin": "000000"}).to_string(),
            ));
        }
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        let accepted = if one_client { 5 } else { 10 };
        assert_eq!(
            results.iter().filter(|(status, _)| *status == 401).count(),
            accepted
        );
        assert_eq!(
            results.iter().filter(|(status, _)| *status == 429).count(),
            30 - accepted
        );
        assert!(results.iter().all(|(_, cookie)| !cookie));
    }
}

#[tokio::test]
async fn bounded_pin_ip_state_fails_closed_preserves_cooldowns_and_recovers_expired_capacity() {
    let (auth, clock) = base();
    for _ in 0..5 {
        assert_eq!(pin_login_as(&auth, "blocked", "000000").await.status(), 401);
    }
    // Valid PINs avoid the global failure threshold while filling the IP map.
    for index in 1..4096 {
        assert_eq!(
            pin_login(&auth, &format!("client-{index}")).await.status(),
            200
        );
    }
    let overflow = pin_login(&auth, "new-client").await;
    assert_eq!(overflow.status(), 429);
    assert!(get(&overflow, "set-cookie").is_none());
    assert_eq!(pin_login(&auth, "blocked").await.status(), 429);
    assert_eq!(password_login(&auth, "new-client").await.status(), 200);
    assert!(get(&token_login(&auth, "new-client"), "set-cookie").is_some());
    clock.advance(300_000);
    assert_eq!(pin_login(&auth, "new-client").await.status(), 200);
    assert_eq!(pin_login(&auth, "blocked").await.status(), 200);
}

#[tokio::test]
async fn accepts_json_exactly_at_the_byte_limit_and_rejects_the_next_byte() {
    let (auth, _) = base();
    let empty = serde_json::json!({"pin": PIN, "extra": ""}).to_string();
    let text =
        serde_json::json!({"pin": PIN, "extra": "x".repeat(16 * 1024 - empty.len())}).to_string();
    assert_eq!(text.len(), 16 * 1024);
    let head = parts("POST", "https://example.test/api/login/pin", &[]);
    assert_eq!(
        auth.handle_pin_login(&head, body(text.clone()), "client")
            .await
            .status(),
        200
    );
    let oversized = auth
        .handle_pin_login(&head, body(format!("{text} ")), "client")
        .await;
    assert_eq!(oversized.status(), 413);
    assert!(get(&oversized, "set-cookie").is_none());
}

#[tokio::test]
async fn invalid_bodies_consume_global_and_per_ip_pin_failure_budgets() {
    let oversized = serde_json::json!({"pin": PIN, "extra": "x".repeat(16 * 1024)}).to_string();
    let array = serde_json::json!([PIN]).to_string();
    let cases: [(&str, Option<&str>, u16); 6] = [
        ("missing body", None, 400),
        ("malformed JSON", Some("{"), 400),
        ("oversized JSON", Some(&oversized), 413),
        ("null JSON", Some("null"), 401),
        ("array JSON", Some(&array), 401),
        ("missing PIN", Some("{}"), 401),
    ];
    for (name, text, status) in cases {
        let (auth, _) = base();
        let invalid = |ip: String| {
            let auth = &auth;
            async move {
                let head = parts("POST", "https://example.test/api/login/pin", &[]);
                auth.handle_pin_login(&head, text.and_then(body), &ip).await
            }
        };
        for _ in 0..5 {
            let response = invalid("client".into()).await;
            assert_eq!(response.status(), status, "{name}");
            assert!(get(&response, "set-cookie").is_none());
        }
        assert_eq!(pin_login(&auth, "client").await.status(), 429, "{name}");
        for index in 0..5 {
            assert_eq!(
                invalid(format!("other-{index}")).await.status(),
                status,
                "{name}"
            );
        }
        assert_eq!(pin_login(&auth, "new-client").await.status(), 429, "{name}");
        assert_eq!(
            password_login(&auth, "client").await.status(),
            200,
            "{name}"
        );
    }
}

#[tokio::test]
async fn oversized_streams_are_cancelled_without_trusting_content_length() {
    let (auth, _) = base();
    let head = format!(r#"{{"pin":"{PIN}","extra":""#).into_bytes();
    let response = auth
        .handle_pin_login(
            &parts(
                "POST",
                "https://example.test/api/login/pin",
                &[("content-length", "10")],
            ),
            chunks(vec![head, vec![0; 16 * 1024]]),
            "client",
        )
        .await;
    assert_eq!(response.status(), 413);
    assert!(get(&response, "set-cookie").is_none());
    fail_pins(&auth, 9, "bad").await;
    assert_eq!(pin_login(&auth, "new-client").await.status(), 429);
}

#[tokio::test]
async fn a_slow_request_cannot_bypass_or_extend_global_cooldown_after_its_body_resolves() {
    for mode in ["correct PIN", "wrong PIN", "malformed JSON"] {
        let clock = ManualClock::at(NOW);
        let auth = Arc::new(make(base_config(), &clock));
        let (slow, sender) = slow_body();
        let pending = {
            let auth = auth.clone();
            tokio::spawn(async move {
                auth.handle_pin_login(
                    &parts("POST", "https://example.test/api/login/pin", &[]),
                    slow,
                    "slow-client",
                )
                .await
            })
        };
        tokio::task::yield_now().await;
        fail_pins(&auth, 10, "bad").await;
        clock.advance(1_000);
        let text = match mode {
            "malformed JSON" => "{".to_owned(),
            "correct PIN" => serde_json::json!({"pin": PIN}).to_string(),
            _ => serde_json::json!({"pin": "000000"}).to_string(),
        };
        sender.send(Bytes::from(text)).unwrap();
        drop(sender);
        let response = pending.await.unwrap();
        assert_eq!(response.status(), 429, "{mode}");
        assert_eq!(get(&response, "retry-after").as_deref(), Some("3599"));
        assert!(get(&response, "set-cookie").is_none());
        assert_eq!(password_login(&auth, "slow-client").await.status(), 200);
        assert_eq!(
            get(&pin_login(&auth, "fresh-client").await, "retry-after").as_deref(),
            Some("3599")
        );
    }
}

#[tokio::test]
async fn an_in_flight_correct_pin_cannot_bypass_a_new_per_ip_cooldown() {
    let clock = ManualClock::at(NOW);
    let auth = Arc::new(make(base_config(), &clock));
    let (slow, sender) = slow_body();
    let pending = {
        let auth = auth.clone();
        tokio::spawn(async move {
            auth.handle_pin_login(
                &parts("POST", "https://example.test/api/login/pin", &[]),
                slow,
                "client",
            )
            .await
        })
    };
    tokio::task::yield_now().await;
    for _ in 0..5 {
        assert_eq!(pin_login_as(&auth, "client", "000000").await.status(), 401);
    }
    sender
        .send(Bytes::from(serde_json::json!({"pin": PIN}).to_string()))
        .unwrap();
    drop(sender);
    let response = pending.await.unwrap();
    assert_eq!(response.status(), 429);
    assert!(get(&response, "set-cookie").is_none());
    assert_eq!(pin_login(&auth, "other-client").await.status(), 200);
}

#[tokio::test]
async fn a_slow_pin_cannot_authenticate_with_an_expired_ip_record() {
    for replace in [false, true] {
        let clock = ManualClock::at(NOW);
        let auth = Arc::new(make(base_config(), &clock));
        let (slow, sender) = slow_body();
        let pending = {
            let auth = auth.clone();
            tokio::spawn(async move {
                auth.handle_pin_login(
                    &parts("POST", "https://example.test/api/login/pin", &[]),
                    slow,
                    "client",
                )
                .await
            })
        };
        tokio::task::yield_now().await;
        clock.advance(300_000);
        if replace {
            for _ in 0..5 {
                assert_eq!(pin_login_as(&auth, "client", "000000").await.status(), 401);
            }
        }
        sender
            .send(Bytes::from(serde_json::json!({"pin": PIN}).to_string()))
            .unwrap();
        drop(sender);
        let response = pending.await.unwrap();
        assert_eq!(response.status(), 429);
        assert!(get(&response, "set-cookie").is_none());
        assert_eq!(password_login(&auth, "client").await.status(), 200);
    }
}
