//! `drivers/claude-mcp.test.ts`.

use roamgate_conversation::driver::McpDriver;
use serde_json::{Value, json};

use super::{ClaudeMcp, claude_mcp_row};
use crate::conversation::fake::Context;

/// Rows as Claude Code 2.1.319 sent them to a real `claude -p`.
fn connected() -> Value {
    json!({
        "name": "echo",
        "status": "connected",
        "serverInfo": {"name": "echo-probe", "version": "1.2.3"},
        "config": {
            "type": "stdio",
            "command": "/opt/homebrew/bin/bun",
            "args": ["/tmp/server.mjs", "--token=secret"],
            "env": {"API_KEY": "secret"},
        },
        "transport": "stdio",
        "scope": "dynamic",
        "source": "dynamic",
        "tools": [
            {"name": "echo", "annotations": {"readOnly": true}},
            {"name": "wipe", "annotations": {"destructive": true}},
            {"name": "second", "annotations": {}},
        ],
    })
}

/// A context whose requests without an answer of their own get
/// `{response: {}}`.
fn context(answers: Value) -> Context {
    Context::new(answers, json!({"response": {}}))
}

/// `toMatchObject`: every key of `want` is in `got`, equal.
fn assert_matches(got: &Value, want: Value) {
    for (key, value) in want.as_object().expect("an object") {
        assert_eq!(&got[key], value, "{key} of {got}");
    }
}

#[test]
fn a_connected_stdio_server_its_tools_and_nothing_secret() {
    let row = claude_mcp_row(&connected()).expect("a row");
    assert_eq!(
        row,
        json!({
            "name": "echo",
            "status": "connected",
            "scope": "dynamic",
            "transport": "stdio",
            "target": "bun",
            "version": "echo-probe 1.2.3",
            "tools": [
                {"name": "echo", "readOnly": true},
                {"name": "wipe", "destructive": true},
                {"name": "second"},
            ],
            "actions": ["reconnect", "disable"],
        })
    );
    assert!(!row.to_string().contains("secret"));
}

#[test]
fn a_failed_stdio_server_says_why_and_has_no_sign_in() {
    let row = claude_mcp_row(&json!({
        "name": "broken",
        "status": "failed",
        "transport": "stdio",
        "error": "ENOENT: no such file or directory, posix_spawn 'stdio'",
        "config": {"type": "stdio", "command": "/nonexistent/mcp-binary"},
    }))
    .expect("a row");
    assert_matches(
        &row,
        json!({
            "status": "failed",
            "target": "mcp-binary",
            "error": "ENOENT: no such file or directory, posix_spawn 'stdio'",
            "actions": ["reconnect", "disable"],
        }),
    );
}

#[test]
fn an_oauth_server_that_needs_signing_in_shows_only_its_host() {
    let row = claude_mcp_row(&json!({
        "name": "docs",
        "status": "needs-auth",
        "transport": "http",
        "source": "project",
        "config": {
            "type": "http",
            "url": "https://mcp.example.com/v1?token=secret",
            "headers": {"Authorization": "Bearer secret"},
        },
    }))
    .expect("a row");
    assert_eq!(
        row,
        json!({
            "name": "docs",
            "status": "needs-auth",
            "scope": "project",
            "transport": "http",
            "target": "mcp.example.com",
            "actions": ["authenticate", "reconnect", "disable"],
        })
    );
    assert!(!row.to_string().contains("secret"));
}

#[test]
fn the_urlhost_claude_sends_wins_over_the_configured_url() {
    let row = claude_mcp_row(&json!({
        "name": "docs",
        "status": "needs-auth",
        "transport": "sse",
        "urlHost": "mcp.example.com:8443",
    }))
    .expect("a row");
    assert_matches(&row, json!({"target": "mcp.example.com:8443"}));
}

#[test]
fn a_claude_ai_connector_is_signed_in_to_on_claude_ai() {
    assert_eq!(
        claude_mcp_row(&json!({
            "name": "claude.ai Linear",
            "status": "needs-auth",
            "transport": "claudeai-proxy",
            "scope": "claudeai",
            "config": {"type": "claudeai-proxy", "url": "https://mcp-proxy.example/v1", "id": "x"},
        })),
        Some(json!({
            "name": "claude.ai Linear",
            "status": "needs-auth",
            "scope": "claudeai",
            "transport": "claude.ai",
            "actions": ["authenticate", "reconnect", "disable"],
        }))
    );
}

#[test]
fn a_server_the_session_proxies_offers_no_sign_in() {
    let row = claude_mcp_row(&json!({
        "name": "hosted",
        "status": "needs-auth",
        "transport": "http",
        "sessionProxied": true,
    }))
    .expect("a row");
    assert_eq!(row["actions"], json!(["reconnect", "disable"]));
}

#[test]
fn a_disabled_server_can_only_be_enabled_a_pending_one_nothing() {
    let disabled =
        claude_mcp_row(&json!({"name": "a", "status": "disabled", "transport": "stdio"}));
    assert_eq!(disabled.expect("a row")["actions"], json!(["enable"]));
    let pending = claude_mcp_row(&json!({"name": "b", "status": "pending", "transport": "stdio"}));
    assert_eq!(pending.expect("a row")["actions"], json!([]));
}

#[test]
fn a_status_it_does_not_know_is_shown_as_failed_with_the_word() {
    let row = claude_mcp_row(&json!({"name": "c", "status": "quarantined", "transport": "stdio"}));
    assert_matches(
        &row.expect("a row"),
        json!({"status": "failed", "error": "Unknown status: quarantined"}),
    );
}

#[test]
fn a_tool_count_is_kept_when_no_list_came() {
    let row = claude_mcp_row(&json!({
        "name": "d",
        "status": "connected",
        "transport": "http",
        "toolCount": 17,
    }));
    assert_matches(&row.expect("a row"), json!({"toolCount": 17}));
}

#[test]
fn a_row_without_a_name_is_dropped() {
    assert_eq!(claude_mcp_row(&json!({"status": "connected"})), None);
    assert_eq!(claude_mcp_row(&json!("nope")), None);
}

#[tokio::test]
async fn mcp_status_the_rows_it_can_read_or_why_not() {
    let listing = context(json!({
        "mcp_status": {"response": {"mcpServers": [connected(), {"status": "pending"}]}},
    }));
    let listed = ClaudeMcp.status(&listing).await.expect("servers");
    assert_eq!(
        listed
            .iter()
            .map(|row| row["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("echo")]
    );
    assert_eq!(
        ClaudeMcp
            .status(&context(json!({"mcp_status": null})))
            .await,
        Err("Claude did not answer in time".to_owned())
    );
    assert_eq!(
        ClaudeMcp
            .status(&context(json!({"mcp_status": {"error": "nope"}})))
            .await,
        Err("nope".to_owned())
    );
    assert_eq!(
        ClaudeMcp
            .status(&context(json!({"mcp_status": {"response": {}}})))
            .await,
        Err("Claude sent no list of servers".to_owned())
    );
}

#[tokio::test]
async fn reconnect_enable_and_disable_name_the_server() {
    let ctx = context(json!({}));
    ClaudeMcp
        .act(&ctx, json!({"action": "reconnect", "server": "a"}))
        .await;
    ClaudeMcp
        .act(&ctx, json!({"action": "enable", "server": "a"}))
        .await;
    ClaudeMcp
        .act(&ctx, json!({"action": "disable", "server": "a"}))
        .await;
    assert_eq!(
        ctx.asked(),
        json!([
            ["mcp_reconnect", {"serverName": "a"}],
            ["mcp_toggle", {"serverName": "a", "enabled": true}],
            ["mcp_toggle", {"serverName": "a", "enabled": false}],
        ])
    );
}

#[tokio::test]
async fn a_refusal_comes_back_as_claude_wrote_it() {
    let refusal = "MCP server echo is disabled - enable it (mcp_toggle) before reconnecting";
    let ctx = context(json!({"mcp_reconnect": {"error": refusal}}));
    assert_eq!(
        ClaudeMcp
            .act(&ctx, json!({"action": "reconnect", "server": "echo"}))
            .await,
        json!({"ok": false, "reason": refusal})
    );
}

#[tokio::test]
async fn an_oauth_sign_in_the_page_and_a_redirect_that_can_be_pasted() {
    let ctx = context(json!({
        "mcp_authenticate": {"response": {
            "authUrl": "https://auth.example.com/a",
            "requiresUserAction": true,
            "callbackExpected": true,
            "redirectScheme": "localhost",
            "callbackPort": 57117,
        }},
    }));
    assert_eq!(
        ClaudeMcp
            .act(&ctx, json!({"action": "authenticate", "server": "docs"}))
            .await,
        json!({"ok": true, "signIn": {"url": "https://auth.example.com/a", "redirects": true}})
    );
    assert_eq!(
        ctx.asked(),
        json!([["mcp_authenticate", {"serverName": "docs"}]])
    );
}

#[tokio::test]
async fn a_claude_ai_connectors_page_does_not_come_back() {
    let ctx = context(json!({
        "mcp_authenticate": {"response": {
            "authUrl": "https://claude.ai/settings/connectors",
            "requiresUserAction": true,
            "callbackExpected": false,
        }},
    }));
    assert_eq!(
        ClaudeMcp
            .act(&ctx, json!({"action": "authenticate", "server": "linear"}))
            .await,
        json!({"ok": true, "signIn": {"url": "https://claude.ai/settings/connectors", "redirects": false}})
    );
}

#[tokio::test]
async fn a_sign_in_nothing_was_needed_for_and_an_unusable_page() {
    let ctx = context(json!({
        "mcp_authenticate": {"response": {"requiresUserAction": false, "callbackExpected": false}},
    }));
    assert_eq!(
        ClaudeMcp
            .act(&ctx, json!({"action": "authenticate", "server": "docs"}))
            .await,
        json!({"ok": true, "signIn": {"url": null, "redirects": false}})
    );
    let ctx = context(json!({
        "mcp_authenticate": {"response": {"authUrl": "javascript:alert(1)", "callbackExpected": true}},
    }));
    assert_eq!(
        ClaudeMcp
            .act(&ctx, json!({"action": "authenticate", "server": "docs"}))
            .await,
        json!({"ok": false, "reason": "Claude sent no sign-in page to open"})
    );
}

#[tokio::test]
async fn finishing_a_sign_in_gives_the_address_back_then_reconnects() {
    let ctx = context(json!({}));
    let url = "http://localhost:1/callback?code=a&state=b";
    assert_eq!(
        ClaudeMcp
            .act(
                &ctx,
                json!({"action": "finish-sign-in", "server": "docs", "url": url})
            )
            .await,
        json!({"ok": true})
    );
    assert_eq!(
        ctx.asked(),
        json!([
            ["mcp_oauth_callback_url", {"serverName": "docs", "callbackUrl": url}],
            ["mcp_reconnect", {"serverName": "docs"}],
        ])
    );
}

#[tokio::test]
async fn an_address_it_refuses_does_not_reconnect() {
    let ctx = context(json!({
        "mcp_oauth_callback_url": {"error": "No active OAuth flow for server: docs"},
    }));
    assert_eq!(
        ClaudeMcp
            .act(
                &ctx,
                json!({"action": "finish-sign-in", "server": "docs", "url": "http://localhost:1/callback?code=a"}),
            )
            .await,
        json!({"ok": false, "reason": "No active OAuth flow for server: docs"})
    );
    assert_eq!(ctx.asked().as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn signed_in_but_the_server_does_not_come_up() {
    let ctx = context(json!({"mcp_reconnect": {"error": "Server status: failed"}}));
    assert_eq!(
        ClaudeMcp
            .act(
                &ctx,
                json!({"action": "finish-sign-in", "server": "docs", "url": "http://localhost:1/callback?code=a"}),
            )
            .await,
        json!({"ok": false, "reason": "Signed in, but it did not reconnect: Server status: failed"})
    );
}
