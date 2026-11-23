//! http/login-page-pin.test.ts and the login page cases of auth.test.ts.
//! Their TS tests run the page's script in a DOM; the script is the
//! contract asset, so here the page is held byte for byte to what the Bun
//! server renders in every mode (tests/data/login-page.json, written by
//! Bun's `renderLoginPage`), and the markup each case reads is checked.

use serde_json::Value;

use super::*;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/login-page.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn renders_the_bun_server_s_bytes_in_every_mode() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 16);
    for case in cases {
        let pin = case["pin"].as_bool().unwrap();
        let token = case["token_command"].as_str();
        let clear = case["clear_drafts"].as_bool().unwrap();
        assert_eq!(
            render_login_page(pin, token, clear),
            case["html"].as_str().unwrap(),
            "pin {pin}, token {token:?}, clear drafts {clear}"
        );
    }
}

#[test]
fn disabled_pin_preserves_password_only_markup_validation_and_endpoint() {
    let html = render_login_page(false, None, true);
    assert!(html.contains(r#"<label for="pw">Password or token</label>"#));
    assert!(html.contains(r#"name="password" type="password" placeholder="Password or token""#));
    assert!(html.contains("/api/login"));
    assert!(!html.contains("/api/login/pin"));
    assert!(!html.contains(r#"id="method""#));
}

#[test]
fn enabled_pin_starts_masked_with_numeric_keyboard_and_accessible_constraints() {
    let html = render_login_page(true, None, true);
    assert!(html.contains(r#"<label id="credential-label" for="pw">PIN</label>"#));
    assert!(html.contains(
        r#"name="pin" type="password" placeholder="6-12 digit PIN" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12""#
    ));
    assert!(html.contains(r#"aria-label="Show PIN""#));
    assert!(html.contains("/api/login/pin"));
    assert!(html.contains("Use password or token instead"));
}

#[test]
fn only_token_logins_explain_where_to_find_the_token() {
    assert!(!render_login_page(false, None, true).contains(r#"id="help""#));
    assert!(!render_login_page(false, Some(""), true).contains(r#"id="help""#));
    let html = render_login_page(false, Some("roamgate auth token"), true);
    assert!(html.contains(r#"<details class="help" id="help">"#));
    assert!(html.contains(r#"<code id="token-cmd">roamgate auth token</code>"#));
    // With a PIN, the help waits for the password mode.
    assert!(
        render_login_page(true, Some("roamgate auth token"), true).contains(r#"id="help" hidden"#)
    );
}

#[test]
fn escapes_the_command() {
    let html = render_login_page(false, Some(r#"sh -c 'a<b>&"c'"#), false);
    assert!(html.contains("sh -c &#39;a&#60;b&#62;&#38;&#34;c&#39;"));
    assert_eq!(escape_html(r#"<&>"'x"#), "&#60;&#38;&#62;&#34;&#39;x");
}

#[test]
fn clears_drafts_only_when_asked() {
    assert!(render_login_page(false, None, true).contains("roamgate:terminalComposerLogout"));
    assert!(!render_login_page(false, None, false).contains("roamgate:terminalComposerLogout"));
}
