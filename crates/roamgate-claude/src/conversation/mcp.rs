//! Claude Code's MCP servers over its control protocol
//! (`drivers/claude-mcp.ts`): `mcp_status` lists them, `mcp_reconnect` and
//! `mcp_toggle` act on one, `mcp_authenticate` starts a sign-in and
//! answers the page to open. A disabled server stays so for the project,
//! in Claude Code's own settings and terminal too.
//!
//! `mcp_authenticate` answers `callbackExpected` for an OAuth server: the
//! page redirects to a port on the machine Claude runs on, and Claude
//! connects the server by itself when the browser gets there. From
//! elsewhere (a phone) the address the browser lands on is given back with
//! `mcp_oauth_callback_url`, after which the server stays as it was until
//! `mcp_reconnect`. A claude.ai connector is connected on claude.ai
//! (`callbackExpected` false): `mcp_reconnect` once that is done.

use std::sync::LazyLock;

use roamgate_agents::js::{self, Obj};
use roamgate_agents::obj;
use roamgate_conversation::driver::{BoxFuture, ControlAnswer, McpDriver, ModelContext, Object};
use serde_json::{Value, json};

use super::js_re::regex;
use super::models::error_of;

const STATUSES: [&str; 5] = ["connected", "failed", "needs-auth", "pending", "disabled"];

/// The transports `mcp_authenticate` signs in to.
const SIGN_IN_TRANSPORTS: [&str; 3] = ["http", "sse", "claudeai-proxy"];

/// Past this, what a server or Claude says is cut.
const MAX_TEXT: usize = 400;

fn text(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    let trimmed = js::trim(value);
    if trimmed.is_empty() {
        return None;
    }
    Some(if js::len16(trimmed) > MAX_TEXT {
        format!(
            "{}...",
            js::slice16(trimmed, 0, Some((MAX_TEXT - 3) as i64))
        )
    } else {
        trimmed.to_owned()
    })
}

fn claude_mcp_tool(value: &Value) -> Option<Value> {
    let tool = value.as_object()?;
    let name = text(tool.get("name"))?;
    let empty = Obj::new();
    let annotations = js::rec(tool.get("annotations")).unwrap_or(&empty);
    Some(Value::Object(obj! {
        "name" => name,
        "description" => text(tool.get("description")),
        "readOnly" => js::is_true(annotations.get("readOnly")).then_some(true),
        "destructive" => js::is_true(annotations.get("destructive")).then_some(true),
    }))
}

/// The host of a URL: what it says of a server without its secrets
/// (`new URL(value).host`, its port when not the scheme's own).
fn url_host(value: Option<&Value>) -> Option<String> {
    let url = url::Url::parse(value?.as_str()?).ok()?;
    let host = url.host_str()?;
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    (!host.is_empty()).then_some(host)
}

static PATH_SEPARATOR: LazyLock<regex::Regex> = LazyLock::new(|| regex(r"[\\/]", ""));

/// What a row shows of where a server lives: never args, env or headers.
fn claude_mcp_target(row: &Obj) -> Option<String> {
    // A claude.ai connector is reached through Anthropic's proxy: no target.
    if js::sv(row.get("transport")) == "claudeai-proxy" {
        return None;
    }
    let empty = Obj::new();
    let config = js::rec(row.get("config")).unwrap_or(&empty);
    if let Some(host) = text(row.get("urlHost")).or_else(|| url_host(config.get("url"))) {
        return Some(host);
    }
    let command = config.get("command")?.as_str()?;
    let last = PATH_SEPARATOR.split(command).last().unwrap_or("");
    text(Some(&Value::String(last.to_owned())))
}

fn claude_mcp_actions(status: &str, transport: Option<&str>, session_proxied: bool) -> Vec<Value> {
    if status == "pending" {
        return Vec::new();
    }
    if status == "disabled" {
        return vec![json!("enable")];
    }
    let sign_in = (status == "needs-auth" || status == "failed")
        && !session_proxied
        && transport.is_some_and(|transport| SIGN_IN_TRANSPORTS.contains(&transport));
    let mut actions = Vec::new();
    if sign_in {
        actions.push(json!("authenticate"));
    }
    actions.push(json!("reconnect"));
    actions.push(json!("disable"));
    actions
}

/// One row of `mcp_status` (`AgentChatMcpServer`); None when unusable.
pub fn claude_mcp_row(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    let name = text(row.get("name"))?;
    let said = js::sv(row.get("status"));
    let known = STATUSES.contains(&said);
    let status = if known { said } else { "failed" };
    let empty = Obj::new();
    let config = js::rec(row.get("config")).unwrap_or(&empty);
    let transport = text(row.get("transport")).or_else(|| text(config.get("type")));
    let scope = text(row.get("source")).or_else(|| text(row.get("scope")));
    let target = claude_mcp_target(row);
    let info = js::rec(row.get("serverInfo")).unwrap_or(&empty);
    let version = [text(info.get("name")), text(info.get("version"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let error =
        text(row.get("error")).or_else(|| (!known).then(|| format!("Unknown status: {said}")));
    let tools = row
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| tools.iter().filter_map(claude_mcp_tool).collect::<Vec<_>>());
    let actions = claude_mcp_actions(
        status,
        transport.as_deref(),
        js::is_true(row.get("sessionProxied")),
    );
    Some(Value::Object(obj! {
        "name" => name,
        "status" => status,
        "scope" => scope,
        "transport" => transport.map(|t| if t == "claudeai-proxy" { "claude.ai".to_owned() } else { t }),
        "target" => target,
        "version" => (!version.is_empty()).then_some(version),
        "error" => error,
        "tools" => tools,
        "toolCount" => row.get("toolCount").filter(|count| count.is_number()).cloned(),
        "actions" => actions,
    }))
}

/// Why Claude did not do it; None when it did.
fn refusal(answer: &Option<ControlAnswer>) -> Option<String> {
    match answer {
        None => Some("Claude did not answer in time".to_owned()),
        Some(answer) => error_of(answer.error.as_ref()).map(str::to_owned),
    }
}

fn refused(reason: String) -> Value {
    json!({"ok": false, "reason": reason})
}

/// `{serverName}`, left out when the request named none (`undefined`).
fn server_params(server: &Option<Value>) -> Object {
    let mut params = Object::new();
    if let Some(server) = server {
        params.insert("serverName".into(), server.clone());
    }
    params
}

fn response_of(answer: &Option<ControlAnswer>) -> Option<&Obj> {
    answer.as_ref()?.response.as_ref()
}

pub struct ClaudeMcp;

impl McpDriver for ClaudeMcp {
    fn status<'a>(
        &'a self,
        context: &'a dyn ModelContext,
    ) -> BoxFuture<'a, Result<Vec<Value>, String>> {
        Box::pin(async move {
            let answer = context.control("mcp_status", Object::new()).await;
            if let Some(reason) = refusal(&answer) {
                return Err(reason);
            }
            let Some(rows) = response_of(&answer)
                .and_then(|response| response.get("mcpServers"))
                .and_then(Value::as_array)
            else {
                return Err("Claude sent no list of servers".to_owned());
            };
            Ok(rows.iter().filter_map(claude_mcp_row).collect())
        })
    }

    fn act<'a>(&'a self, context: &'a dyn ModelContext, request: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            let server = request.get("server").cloned();
            match js::sv(request.get("action")) {
                "reconnect" => {
                    let answer = context
                        .control("mcp_reconnect", server_params(&server))
                        .await;
                    refusal(&answer).map_or_else(|| json!({"ok": true}), refused)
                }
                action @ ("enable" | "disable") => {
                    let mut params = server_params(&server);
                    params.insert("enabled".into(), Value::Bool(action == "enable"));
                    let answer = context.control("mcp_toggle", params).await;
                    refusal(&answer).map_or_else(|| json!({"ok": true}), refused)
                }
                "authenticate" => {
                    let answer = context
                        .control("mcp_authenticate", server_params(&server))
                        .await;
                    if let Some(reason) = refusal(&answer) {
                        return refused(reason);
                    }
                    let response = response_of(&answer);
                    let url = response.and_then(|response| response.get("authUrl"));
                    match url {
                        None | Some(Value::Null) => {
                            json!({"ok": true, "signIn": {"url": null, "redirects": false}})
                        }
                        Some(Value::String(url)) if is_web_page(url) => json!({
                            "ok": true,
                            "signIn": {
                                "url": url,
                                "redirects": js::is_true(response.and_then(|r| r.get("callbackExpected"))),
                            },
                        }),
                        Some(_) => refused("Claude sent no sign-in page to open".to_owned()),
                    }
                }
                "finish-sign-in" => {
                    let mut params = server_params(&server);
                    if let Some(url) = request.get("url") {
                        params.insert("callbackUrl".into(), url.clone());
                    }
                    let answer = context.control("mcp_oauth_callback_url", params).await;
                    if let Some(reason) = refusal(&answer) {
                        return refused(reason);
                    }
                    // Signed in, but Claude leaves the server as it was until asked.
                    let answer = context
                        .control("mcp_reconnect", server_params(&server))
                        .await;
                    match refusal(&answer) {
                        Some(reason) => {
                            refused(format!("Signed in, but it did not reconnect: {reason}"))
                        }
                        None => json!({"ok": true}),
                    }
                }
                // The TS switch falls through to undefined.
                _ => Value::Null,
            }
        })
    }
}

/// `/^https?:\/\//i`.
fn is_web_page(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests;
