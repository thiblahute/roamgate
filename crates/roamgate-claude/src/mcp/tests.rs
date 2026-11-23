use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use super::*;

fn tool(
    name: &str,
    call: impl Fn(Value) -> BoxFuture<'static, Result<McpToolResult, ClaudeError>>
    + Send
    + Sync
    + 'static,
) -> McpTool {
    McpTool {
        name: name.to_owned(),
        description: format!("The {name} tool"),
        parameters: json!({
            "type": "object",
            "properties": { "workspace_id": { "type": "string" } },
            "required": ["workspace_id"],
        }),
        call: Arc::new(move |params, _cancel| call(params)),
    }
}

pub(crate) fn no_listener() -> Listen {
    Box::new(|_| {
        Ok(McpListener {
            url: "http://127.0.0.1:1/mcp".to_owned(),
            stop: Box::new(|| {}),
        })
    })
}

struct Setup {
    mcp: ClaudeMcp,
    lease: McpLease,
    server: Value,
    sources: Arc<Mutex<Vec<Value>>>,
    cancel: CancellationToken,
}

struct Answer {
    status: u16,
    body: Option<Value>,
}

impl Setup {
    fn authorization(&self) -> String {
        self.server["headers"]["Authorization"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn rpc(&self, body: Value) -> Answer {
        let authorization = self.authorization();
        self.rpc_as(body, &authorization).await
    }

    async fn rpc_as(&self, body: Value, authorization: &str) -> Answer {
        rpc(&self.mcp, body, authorization).await
    }
}

async fn rpc(mcp: &ClaudeMcp, body: Value, authorization: &str) -> Answer {
    let response = mcp
        .handle(McpRequest::post(Some(authorization), &body))
        .await;
    Answer {
        status: response.status,
        body: if response.status == 200 {
            response.body_json()
        } else {
            None
        },
    }
}

fn setup(tools: Vec<McpTool>) -> Setup {
    let mcp = ClaudeMcp::with_listen(RANGER_MCP_SERVER, no_listener());
    let sources = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let sink = sources.clone();
    let lease = mcp
        .open(McpTurn {
            tools,
            cancel: cancel.clone(),
            sources: Some(Arc::new(move |found| sink.lock().unwrap().extend(found))),
        })
        .unwrap();
    let config: Value = serde_json::from_str(&lease.config).unwrap();
    let server = config["mcpServers"]["ranger"].clone();
    Setup {
        mcp,
        lease,
        server,
        sources,
        cancel,
    }
}

fn text(text: &str) -> BoxFuture<'static, Result<McpToolResult, ClaudeError>> {
    let text = text.to_owned();
    Box::pin(async move { Ok(McpToolResult::text(text)) })
}

#[tokio::test]
async fn lists_the_turns_tools_and_runs_them_passing_their_sources() {
    let setup = setup(vec![tool("workspace_status", |params| {
        Box::pin(async move {
            Ok(McpToolResult {
                text: format!("status of {}", params["workspace_id"].as_str().unwrap()),
                sources: Some(vec![json!({ "id": "s1" })]),
            })
        })
    })]);
    assert_eq!(setup.server["type"], "http");
    let authorization = setup.authorization();
    let token = authorization.strip_prefix("Bearer ").unwrap();
    assert_eq!(token.len(), 36);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    let init = setup
        .rpc(json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-11-25" },
        }))
        .await;
    assert_eq!(
        init.body.unwrap()["result"]["protocolVersion"],
        "2025-11-25"
    );
    assert_eq!(
        setup
            .rpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await
            .status,
        202
    );
    let list = setup
        .rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
        .await
        .body
        .unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "workspace_status");
    assert_eq!(tools[0]["description"], "The workspace_status tool");
    assert_eq!(tools[0]["inputSchema"]["type"], "object");
    assert_eq!(
        tools[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["name", "description", "inputSchema"]
    );
    let response = setup
        .mcp
        .handle(McpRequest::post(
            Some(&authorization),
            &json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": { "name": "workspace_status", "arguments": { "workspace_id": "w7" } },
            }),
        ))
        .await;
    assert_eq!(
        response.headers,
        [("content-type", "application/json;charset=utf-8".to_owned())]
    );
    // Byte for byte what Bun's Response.json answers.
    assert_eq!(
        String::from_utf8(response.body.unwrap()).unwrap(),
        r#"{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"status of w7\n\nSources: [{\"id\":\"s1\"}]"}]}}"#
    );
    assert_eq!(*setup.sources.lock().unwrap(), [json!({ "id": "s1" })]);
}

#[tokio::test]
async fn refuses_other_tokens_and_the_turns_own_once_it_ended() {
    let mut setup = setup(vec![tool("workspace_status", |_| text("x"))]);
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    assert_eq!(setup.rpc_as(list.clone(), "Bearer nope").await.status, 401);
    assert_eq!(setup.rpc_as(list.clone(), "").await.status, 401);
    assert_eq!(setup.rpc(list.clone()).await.status, 200);
    setup.lease.close();
    assert_eq!(setup.rpc(list).await.status, 401);
}

#[tokio::test]
async fn tool_errors_show_their_safe_message_any_other_is_masked() {
    let setup = setup(vec![
        tool("safe", |_| {
            Box::pin(async { Err(ClaudeError::user("That workspace is not allowed.")) })
        }),
        tool("leaky", |_| {
            Box::pin(async { Err(ClaudeError::internal("connect ENOENT /secret/socket")) })
        }),
    ]);
    let call = |name: &'static str| {
        setup.rpc(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": name, "arguments": { "workspace_id": "w1" } },
        }))
    };
    assert_eq!(
        call("safe").await.body.unwrap()["result"],
        json!({
            "content": [{ "type": "text", "text": "That workspace is not allowed." }],
            "isError": true,
        })
    );
    assert_eq!(
        call("leaky").await.body.unwrap()["result"],
        json!({
            "content": [{
                "type": "text",
                "text": "Workspace tool unavailable, stale, or outside the authorized scope.",
            }],
            "isError": true,
        })
    );
    assert_eq!(call("missing").await.body.unwrap()["error"]["code"], -32602);
}

#[tokio::test]
async fn a_stopped_turn_runs_no_more_tools() {
    let ran = Arc::new(AtomicUsize::new(0));
    let counted = ran.clone();
    let setup = setup(vec![tool("workspace_status", move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
        text("x")
    })]);
    setup.cancel.cancel();
    let called = setup
        .rpc(json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "workspace_status", "arguments": { "workspace_id": "w1" } },
        }))
        .await;
    assert_eq!(called.body.unwrap()["result"]["isError"], true);
    assert_eq!(ran.load(Ordering::SeqCst), 0);
}

/// `test.each(["finish", "abort", "close"])`.
#[tokio::test]
async fn queued_tools_respect_sequential_execution_and_lease_revocation() {
    for end in ["finish", "abort", "close"] {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = CancellationToken::new();
        let calls = Arc::new(Mutex::new(Vec::<&str>::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let first = {
            let (entered, release, calls, active, peak) = (
                entered.clone(),
                release.clone(),
                calls.clone(),
                active.clone(),
                peak.clone(),
            );
            tool("first", move |_| {
                let (entered, release, calls, active, peak) = (
                    entered.clone(),
                    release.clone(),
                    calls.clone(),
                    active.clone(),
                    peak.clone(),
                );
                Box::pin(async move {
                    calls.lock().unwrap().push("first");
                    peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    entered.notify_one();
                    release.cancelled().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(McpToolResult::text("done"))
                })
            })
        };
        let second = {
            let (calls, active, peak) = (calls.clone(), active.clone(), peak.clone());
            tool("second", move |_| {
                calls.lock().unwrap().push("second");
                peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                active.fetch_sub(1, Ordering::SeqCst);
                text("done")
            })
        };
        let Setup {
            mcp,
            mut lease,
            server,
            cancel,
            ..
        } = setup(vec![first, second]);
        let authorization = server["headers"]["Authorization"]
            .as_str()
            .unwrap()
            .to_owned();
        let call = |name: &'static str, id: u64| {
            let mcp = mcp.clone();
            let authorization = authorization.clone();
            tokio::spawn(async move {
                rpc(
                    &mcp,
                    json!({
                        "jsonrpc": "2.0", "id": id, "method": "tools/call",
                        "params": { "name": name, "arguments": {} },
                    }),
                    &authorization,
                )
                .await
                .status
            })
        };
        let one = call("first", 1);
        entered.notified().await;
        let two = call("second", 2);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(*calls.lock().unwrap(), ["first"], "{end}");
        if end == "abort" {
            cancel.cancel();
        }
        if end == "close" {
            lease.close();
        }
        release.cancel();
        assert_eq!(one.await.unwrap(), 200);
        assert_eq!(two.await.unwrap(), 200);
        let expected: &[&str] = if end == "finish" {
            &["first", "second"]
        } else {
            &["first"]
        };
        assert_eq!(*calls.lock().unwrap(), expected, "{end}");
        assert_eq!(peak.load(Ordering::SeqCst), 1, "{end}");
        mcp.stop();
    }
}

#[tokio::test]
async fn the_loopback_listener_answers_over_http() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mcp = ClaudeMcp::new("reviews");
    let lease = mcp
        .open(McpTurn {
            tools: vec![],
            cancel: CancellationToken::new(),
            sources: None,
        })
        .unwrap();
    let config: Value = serde_json::from_str(&lease.config).unwrap();
    let server = &config["mcpServers"]["reviews"];
    let url = server["url"].as_str().unwrap();
    let address = url
        .strip_prefix("http://")
        .unwrap()
        .strip_suffix("/mcp")
        .unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                server["headers"]["Authorization"].as_str().unwrap(),
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
    assert!(
        answer.ends_with(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
        "{answer}"
    );
    mcp.stop();
}
