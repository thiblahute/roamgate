//! The real sidecar (server/src/assistant/pi-sidecar-main.ts, the real Pi
//! SDK) driven from Rust against a local Anthropic-style endpoint: a turn
//! with a workspace tool, its checkpoint, a resumed turn on the durable
//! store, tool details, and an API key login written to auth.json.
//! Skipped, saying why, when bun is not on PATH.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use roamgate_pi::{
    BoxFuture, LoginInteraction, PiDriver, PiError, PiSidecar, RunEvent, RunHandler, RunInput,
    SidecarConfig,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, the sidecar cannot run");
    }
    found
}

fn sse(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| {
            format!(
                "event: {}\ndata: {value}\n\n",
                value["type"].as_str().unwrap()
            )
        })
        .collect()
}

fn reply(index: usize, blocks: Vec<Value>, stop: &str) -> String {
    let mut values = vec![json!({
        "type": "message_start",
        "message": {
            "id": format!("message-{index}"), "type": "message", "role": "assistant",
            "model": "test-model", "content": [], "stop_reason": null, "stop_sequence": null,
            "usage": { "input_tokens": 10, "output_tokens": 0 },
        },
    })];
    values.extend(blocks);
    values.push(json!({
        "type": "message_delta",
        "delta": { "stop_reason": stop, "stop_sequence": null },
        "usage": { "output_tokens": 10 },
    }));
    values.push(json!({ "type": "message_stop" }));
    sse(&values)
}

fn text(value: &str, index: usize) -> Vec<Value> {
    vec![
        json!({ "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": value } }),
        json!({ "type": "content_block_stop", "index": index }),
    ]
}

fn tool_use(name: &str, id: &str, index: usize) -> Vec<Value> {
    vec![
        json!({ "type": "content_block_start", "index": index, "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} } }),
        json!({ "type": "content_block_delta", "index": index, "delta": { "type": "input_json_delta", "partial_json": "{}" } }),
        json!({ "type": "content_block_stop", "index": index }),
    ]
}

/// An endpoint answering each request with the next reply; records bodies.
async fn endpoint(replies: Vec<String>) -> (String, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded = bodies.clone();
    let replies = Arc::new(Mutex::new(replies.into_iter()));
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let bodies = recorded.clone();
            let replies = replies.clone();
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head, length) = loop {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    data.extend_from_slice(&chunk[..read]);
                    if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..at]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (at + 4, length);
                    }
                };
                while data.len() < head + length {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    data.extend_from_slice(&chunk[..read]);
                }
                if let Ok(body) = serde_json::from_slice::<Value>(&data[head..]) {
                    bodies.lock().unwrap().push(body);
                }
                let body = replies.lock().unwrap().next().unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (url, bodies)
}

#[derive(Default)]
struct Turn {
    log: Arc<Mutex<Vec<String>>>,
    reads: Mutex<usize>,
}

impl RunHandler for Turn {
    fn callbacks(&self) -> Vec<&'static str> {
        vec!["checkpoint"]
    }

    fn event(&self, event: RunEvent) {
        let line = match event {
            RunEvent::Delta(text) => format!("delta {text}"),
            RunEvent::Tool { name, status, .. } => format!("tool {name} {status}"),
            RunEvent::Message(text) => format!("message {text}"),
            RunEvent::Error => "error".into(),
            other => format!("{other:?}"),
        };
        self.log.lock().unwrap().push(line);
    }

    fn checkpoint(&self, entries: Vec<Value>) -> BoxFuture<Result<(), PiError>> {
        let log = self.log.clone();
        Box::pin(async move {
            log.lock()
                .unwrap()
                .push(format!("checkpoint {}", entries[0]["type"]));
            Ok(())
        })
    }

    fn tool(
        &self,
        handler: &str,
        args: Vec<Value>,
        _cancel: CancellationToken,
    ) -> BoxFuture<Result<Value, PiError>> {
        assert_eq!(handler, "read");
        assert_eq!(args, [json!("status"), json!({})]);
        *self.reads.lock().unwrap() += 1;
        Box::pin(async { Ok(json!({ "text": "Workspace is running." })) })
    }
}

struct Key;

impl LoginInteraction for Key {
    fn prompt(
        &self,
        _prompt: Value,
        _cancel: CancellationToken,
    ) -> BoxFuture<Result<String, PiError>> {
        Box::pin(async { Ok("synthetic-rust-key".to_owned()) })
    }

    fn event(&self, _event: Value) {}
}

#[tokio::test]
async fn the_real_sidecar_runs_a_pi_turn_with_a_workspace_tool_checkpoints_first_and_resumes_from_its_durable_pointer()
 {
    let Some(bun) = bun() else {
        return;
    };
    let (url, bodies) = endpoint(vec![
        reply(
            1,
            [
                text("Inspecting.", 0),
                tool_use("workspace_status", "s1", 1),
            ]
            .concat(),
            "tool_use",
        ),
        reply(2, text("It runs.", 0), "end_turn"),
        reply(3, text("Still running.", 0), "end_turn"),
    ])
    .await;
    let home = tempfile::tempdir().unwrap();
    let ranger = home.path().join("ranger");
    std::fs::create_dir(&ranger).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ranger, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(
        ranger.join("auth.json"),
        json!({ "anthropic": { "type": "api_key", "key": "synthetic-key" } }).to_string(),
    )
    .unwrap();
    std::fs::write(
        ranger.join("models.json"),
        json!({ "providers": { "anthropic": { "baseUrl": url } } }).to_string(),
    )
    .unwrap();
    let mut config = SidecarConfig::new(vec![
        bun.to_string_lossy().into_owned(),
        repo()
            .join("server/src/assistant/pi-sidecar-main.ts")
            .to_string_lossy()
            .into_owned(),
    ]);
    config.envs = vec![
        ("HOME".into(), home.path().to_string_lossy().into_owned()),
        (
            "PI_CODING_AGENT_DIR".into(),
            home.path().join("pi").to_string_lossy().into_owned(),
        ),
    ];
    let sidecar = PiSidecar::new(config);
    let directory = ranger.to_string_lossy().into_owned();
    let driver = PiDriver::new(sidecar.clone(), &directory, None);
    let run_config = json!({
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "credential_source": "assistant",
        "allowed_workspaces": [],
    });

    let turn = Arc::new(Turn::default());
    let entries = driver
        .run(
            RunInput {
                config: run_config.clone(),
                text: "Read the workspace status.".into(),
                ..RunInput::default()
            },
            turn.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["type"], "ranger-durable");
    let id = entries[0]["id"].as_str().unwrap();
    assert!(
        ranger
            .join("durable")
            .join(id)
            .join("execution.sqlite")
            .is_file()
    );
    assert_eq!(*turn.reads.lock().unwrap(), 1);
    let log = turn.log.lock().unwrap().clone();
    assert_eq!(log[0], "checkpoint \"ranger-durable\"");
    assert!(log.contains(&"tool workspace_status running".to_owned()));
    assert!(log.contains(&"tool workspace_status completed".to_owned()));
    let deltas: String = log
        .iter()
        .filter_map(|line| line.strip_prefix("delta "))
        .collect();
    assert_eq!(deltas, "Inspecting.It runs.");

    let again = Arc::new(Turn::default());
    let resumed = driver
        .run(
            RunInput {
                config: run_config,
                entries: entries.clone(),
                text: "And now?".into(),
                ..RunInput::default()
            },
            again,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(resumed, entries);
    let last = bodies.lock().unwrap().last().cloned().unwrap();
    assert!(last["messages"].to_string().contains("It runs."));
    assert!(!last.to_string().contains("synthetic-key"));

    let details = driver
        .read_tool_details(
            entries,
            json!([{
                "id": "m1", "role": "assistant", "text": "It runs.",
                "sent_at": "2026-11-23T00:00:00Z", "sources": [],
                "tools": [{ "id": "s1", "name": "workspace_status", "status": "completed" }],
            }]),
            None,
        )
        .await
        .unwrap();
    assert!(
        details[0]["tools"][0]["output"]
            .as_str()
            .unwrap()
            .contains("Workspace is running.")
    );

    driver
        .login(
            "openai",
            "api_key",
            "assistant",
            Arc::new(Key),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let auth: Value =
        serde_json::from_str(&std::fs::read_to_string(ranger.join("auth.json")).unwrap()).unwrap();
    assert_eq!(auth["openai"]["key"], "synthetic-rust-key");
    assert_eq!(auth["anthropic"]["key"], "synthetic-key");
    let catalog = driver.catalog("assistant").await.unwrap();
    let configured = |provider: &str| {
        catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == provider)
            .map(|entry| entry["configured"].clone())
    };
    assert_eq!(configured("openai"), Some(json!(true)));
    driver.dispose().await.unwrap();
    sidecar.close().await;
}
