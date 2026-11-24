//! The endpoint generation 1 handshake on the client socket
//! (bridge/endpoint-client.ts `connect`), as far as a passive client needs
//! it: the hello of a `notifications` client (`surface_active: false`),
//! then the welcome and the first `shell.snapshot.v1`, whose boot id names
//! the Herdr server process (the runtime's `recoveryIdentity`). The rest of
//! the client (surfaces, input, endpoint requests) comes with the terminal
//! bridge.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::thin::{BinReader, BinWriter, connect_stream, encode_frame};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(8_000);
const ENDPOINT_GENERATION: u64 = 1;
const HELLO_KIND: &str = "endpoint.hello.v1";
const WELCOME_KIND: &str = "endpoint.welcome.v1";
const SNAPSHOT_KIND: &str = "shell.snapshot.v1";
const HEALTH_PING_KIND: &str = "endpoint.health.ping.v1";
const HEALTH_PONG_KIND: &str = "endpoint.health.pong.v1";
/// ClientMessage::EndpointControl (frozen for generation 1).
const CM_ENDPOINT_CONTROL: u64 = 20;
/// ServerMessage tags (frozen for generation 1).
const SM_WELCOME: u64 = 0;
const SM_ENDPOINT_CONTROL: u64 = 20;
const MAX_FRAME: usize = 32 * 1024 * 1024;

/// The hello of a passive (`notifications`) client of `cols` x `rows`.
fn hello(cols: u64, rows: u64) -> Value {
    json!({
        "generation": ENDPOINT_GENERATION,
        "cell_width_px": 0,
        "cell_height_px": 0,
        "surface_size": {"cols": cols, "rows": rows},
        "pixel_mouse": false,
        "direct_graphics": false,
        "endpoint_keybindings": false,
        "mouse_capture": false,
        "surface_active": false,
        "surface_delta": false,
        "surface_reuse": false,
        "snapshot_codecs": ["shell.snapshot.v1"],
        "surface_codecs": ["shell.surface.v1"],
        "input_codecs": ["shell.input.semantic.v1"],
        "blob_codecs": ["shell.blob.v1"],
    })
}

fn control(kind: &str, data: &str) -> Vec<u8> {
    let mut writer = BinWriter::new();
    writer.variant(CM_ENDPOINT_CONTROL);
    writer.string(kind);
    writer.string(data);
    encode_frame(&writer.into_bytes())
}

/// The welcome's checks (`handleControl`): an error names what failed.
fn check_welcome(data: &str) -> Result<Vec<String>, String> {
    let parsed: Value =
        serde_json::from_str(data).map_err(|_| "malformed endpoint welcome".to_owned())?;
    if let Some(error) = parsed.get("error").filter(|error| !error.is_null()) {
        let text = |key: &str| match error.get(key) {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        return Err(format!(
            "Herdr rejected endpoint hello ({}): {}",
            text("code"),
            text("message")
        ));
    }
    if parsed.get("generation").and_then(Value::as_u64) != Some(ENDPOINT_GENERATION)
        || parsed["snapshot_codec"] != "shell.snapshot.v1"
        || parsed["surface_codec"] != "shell.surface.v1"
        || parsed["input_codec"] != "shell.input.semantic.v1"
        || parsed["blob_codec"] != "shell.blob.v1"
    {
        return Err("Unsupported Herdr endpoint generation or codecs".into());
    }
    let mut capabilities = Vec::new();
    for field in ["methods", "capabilities"] {
        match parsed.get(field) {
            None => {}
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
                if field == "capabilities" {
                    capabilities = items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect();
                }
            }
            Some(_) => return Err(format!("Malformed Herdr endpoint {field}")),
        }
    }
    Ok(capabilities)
}

/// The boot id of the Herdr server behind `client_socket_path`: a passive
/// handshake, closed once the welcome and a snapshot with a boot id came
/// (8 s at most). None when the snapshot names none.
pub async fn read_boot_id(client_socket_path: &str) -> Result<Option<String>, String> {
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake(client_socket_path)).await {
        Ok(result) => result,
        Err(_) => Err("timed out waiting for Herdr endpoint welcome and snapshot".into()),
    }
}

async fn handshake(path: &str) -> Result<Option<String>, String> {
    let mut stream = connect_stream(path)
        .await
        .map_err(|error| crate::control::io_error_text(&error))?;
    let hello = control(HELLO_KIND, &hello(80, 24).to_string());
    stream
        .write_all(&hello)
        .await
        .map_err(|error| crate::control::io_error_text(&error))?;
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut welcomed: Option<Vec<String>> = None;
    let mut boot_id = String::new();
    loop {
        while buffer.len() >= 4 {
            let length = u32::from_le_bytes(buffer[..4].try_into().expect("4 bytes")) as usize;
            if length > MAX_FRAME {
                return Err(format!("oversized frame: {length}"));
            }
            if buffer.len() < 4 + length {
                break;
            }
            let payload: Vec<u8> = buffer[4..4 + length].to_vec();
            buffer.drain(..4 + length);
            let mut reader = BinReader::new(&payload);
            match reader.variant()? {
                SM_ENDPOINT_CONTROL => {
                    let kind = reader.string()?;
                    let data = reader.string()?;
                    match kind.as_str() {
                        WELCOME_KIND => welcomed = Some(check_welcome(&data)?),
                        SNAPSHOT_KIND => {
                            // A malformed snapshot is an error event only.
                            if let Ok(raw) = serde_json::from_str::<Value>(&data) {
                                let id = raw["boot_id"].as_str().unwrap_or("").to_owned();
                                if !boot_id.is_empty() && !id.is_empty() && boot_id != id {
                                    return Err(
                                        "Herdr endpoint boot changed; reconnect required".into()
                                    );
                                }
                                boot_id = id;
                            }
                        }
                        HEALTH_PING_KIND
                            if welcomed.as_ref().is_some_and(|caps| {
                                caps.iter().any(|cap| cap == "health_check")
                            }) =>
                        {
                            let pong = control(HEALTH_PONG_KIND, &data);
                            let _ = stream.write_all(&pong).await;
                        }
                        _ => {}
                    }
                }
                SM_WELCOME => {
                    return Err(
                        "Herdr server does not speak endpoint generation 1 (needs >= 0.9.0)".into(),
                    );
                }
                // Other server messages are ignored here.
                _ => {}
            }
            if welcomed.is_some() && !boot_id.is_empty() {
                return Ok(Some(boot_id));
            }
        }
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| crate::control::io_error_text(&error))?;
        if read == 0 {
            return Err("endpoint client closed during handshake".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_welcome_with_other_codecs_or_an_error_is_refused() {
        let good = json!({
            "generation": 1,
            "snapshot_codec": "shell.snapshot.v1",
            "surface_codec": "shell.surface.v1",
            "input_codec": "shell.input.semantic.v1",
            "blob_codec": "shell.blob.v1",
            "capabilities": ["health_check"],
        });
        assert_eq!(
            check_welcome(&good.to_string()),
            Ok(vec!["health_check".to_owned()])
        );
        let mut other = good.clone();
        other["generation"] = json!(2);
        assert!(check_welcome(&other.to_string()).is_err());
        assert_eq!(
            check_welcome(r#"{"error":{"code":"x","message":"no"}}"#),
            Err("Herdr rejected endpoint hello (x): no".to_owned())
        );
    }
}
