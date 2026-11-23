//! The `agent_chat.*` requests of one socket (`rpc.ts`). The history
//! push's `agent_history.(un)subscribe` are the agent_sessions family's.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js;
use serde_json::{Map, Value, json};

use crate::service::{ConversationService, SocketId};

pub const AGENT_CHAT_METHODS: &[&str] = &[
    "agent_chat.state",
    "agent_chat.subscribe",
    "agent_chat.unsubscribe",
    "agent_chat.send",
    "agent_chat.voice",
    "agent_chat.interrupt",
    "agent_chat.shell",
    "agent_chat.shell.stop",
    "agent_chat.rewind",
    "agent_chat.rewind.check",
    "agent_chat.queue.edit",
    "agent_chat.queue.remove",
    "agent_chat.interrupted.dismiss",
    "agent_chat.models",
    "agent_chat.model",
    "agent_chat.model_notice.dismiss",
    "agent_chat.mcp",
    "agent_chat.mcp.action",
    "agent_chat.background",
    "agent_chat.task.stop",
    "agent_chat.recover",
    "agent_chat.api_key.answer",
    "agent_chat.handover",
    "agent_chat.handover.cancel",
    "agent_chat.fg",
];

pub fn is_agent_chat_method(method: &str) -> bool {
    AGENT_CHAT_METHODS.contains(&method)
}

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]{1,100}$").unwrap());
static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\u{0000}-\u{001f}\u{007f}-\u{009f}]+").unwrap());

fn pane_of(params: &Map<String, Value>) -> Result<String, String> {
    match params.get("pane_id") {
        Some(Value::String(pane)) if !pane.is_empty() && js::len16(pane) <= 200 => Ok(pane.clone()),
        _ => Err("pane_id is required".into()),
    }
}

fn text_of(params: &Map<String, Value>, field: &str) -> Result<String, String> {
    match params.get(field) {
        None => Ok(String::new()),
        Some(Value::String(text)) if js::len16(text) <= 200_000 => Ok(text.clone()),
        _ => Err(format!("invalid {field}")),
    }
}

fn id_of(params: &Map<String, Value>, field: &str) -> Result<Option<String>, String> {
    match params.get(field) {
        None => Ok(None),
        Some(Value::String(value)) if ID.is_match(value) && value.is_ascii() => {
            Ok(Some(value.clone()))
        }
        _ => Err(format!("invalid {field}")),
    }
}

fn images_of(params: &Map<String, Value>) -> Result<Vec<String>, String> {
    match params.get("images") {
        None => Ok(Vec::new()),
        Some(Value::Array(images))
            if images.len() <= 20
                && images
                    .iter()
                    .all(|path| path.as_str().is_some_and(|path| js::len16(path) <= 4096)) =>
        {
            Ok(images
                .iter()
                .map(|path| path.as_str().unwrap().to_owned())
                .collect())
        }
        _ => Err("invalid images".into()),
    }
}

/// A stopped conversation's title as its job's line says it.
fn suspend_title(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let line = CONTROL.replace_all(text, " ");
    let line = js::trim(&line);
    (!line.is_empty()).then(|| js::slice16(line, 0, Some(120)))
}

fn parse_mcp_request(params: &Map<String, Value>) -> Result<Value, String> {
    let server = match params.get("server") {
        Some(Value::String(server)) if !js::trim(server).is_empty() && js::len16(server) <= 256 => {
            server.clone()
        }
        _ => return Err("server is required".into()),
    };
    match params.get("action").and_then(Value::as_str) {
        Some("finish-sign-in") => match params.get("url") {
            Some(Value::String(url)) if !js::trim(url).is_empty() && js::len16(url) <= 8192 => {
                Ok(json!({"action": "finish-sign-in", "server": server, "url": js::trim(url)}))
            }
            _ => Err("url is required".into()),
        },
        Some(action @ ("reconnect" | "enable" | "disable" | "authenticate")) => {
            Ok(json!({"action": action, "server": server}))
        }
        _ => Err("action is required".into()),
    }
}

/// One `agent_chat.*` request of `socket`.
pub async fn handle_agent_chat_rpc(
    service: &ConversationService,
    socket: SocketId,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let empty = Map::new();
    let params = params.as_object().unwrap_or(&empty);
    let pane = pane_of(params)?;
    let pane = pane.as_str();
    Ok(match method {
        "agent_chat.state" => Value::Object(service.state(pane)),
        "agent_chat.subscribe" => Value::Object(service.subscribe(socket, pane)),
        "agent_chat.unsubscribe" => {
            service.unsubscribe(socket, pane);
            json!({"ok": true})
        }
        "agent_chat.send" => {
            let uuid = id_of(params, "uuid")?;
            let text = text_of(params, "text")?;
            let images = images_of(params)?;
            service.send(pane, &text, images, uuid).await?
        }
        "agent_chat.voice" => {
            let uuid = id_of(params, "uuid")?;
            let text = text_of(params, "text")?;
            let stop = params.get("stop") == Some(&Value::Bool(true));
            service.voice(pane, &text, stop, uuid).await?
        }
        "agent_chat.shell" => {
            let command = text_of(params, "command")?;
            if js::trim(&command).is_empty() || js::len16(&command) > 20_000 {
                return Err("invalid command".into());
            }
            let id = id_of(params, "id")?;
            service.shell(pane, &command, id)?
        }
        "agent_chat.shell.stop" => {
            let id = id_of(params, "id")?.ok_or("id is required")?;
            json!({"stopped": service.stop_shell(pane, &id)})
        }
        "agent_chat.interrupt" => json!({"interrupted": service.interrupt(pane).await?}),
        "agent_chat.rewind" => {
            let uuid = id_of(params, "uuid")?.ok_or("uuid is required")?;
            let mode = match params.get("mode").and_then(Value::as_str) {
                Some(mode @ ("both" | "conversation" | "code")) => mode.to_owned(),
                _ => return Err("mode is both, conversation or code".into()),
            };
            let last_seen = id_of(params, "last_seen")?;
            let interrupt = params.get("interrupt") == Some(&Value::Bool(true));
            service
                .rewind(pane, &uuid, last_seen, &mode, interrupt)
                .await?
        }
        "agent_chat.rewind.check" => {
            let uuid = id_of(params, "uuid")?.ok_or("uuid is required")?;
            service.rewind_check(pane, &uuid).await
        }
        "agent_chat.queue.edit" => {
            let id = id_of(params, "id")?.ok_or("id is required")?;
            let text = text_of(params, "text")?;
            json!({"edited": service.edit_queued(pane, &id, &text)})
        }
        "agent_chat.queue.remove" => {
            let id = id_of(params, "id")?.ok_or("id is required")?;
            json!({"removed": service.remove_queued(pane, &id)})
        }
        "agent_chat.interrupted.dismiss" => {
            service.dismiss_interrupted(pane);
            json!({"ok": true})
        }
        "agent_chat.models" => service.models(pane).await?,
        "agent_chat.model" => {
            let model = match params.get("model") {
                Some(Value::String(model))
                    if !js::trim(model).is_empty() && js::len16(model) <= 256 =>
                {
                    model.clone()
                }
                _ => return Err("model is required".into()),
            };
            service.set_model(pane, &model).await
        }
        "agent_chat.model_notice.dismiss" => {
            service.dismiss_model_notice(pane);
            json!({"ok": true})
        }
        "agent_chat.mcp" => service.mcp(pane).await?,
        "agent_chat.mcp.action" => {
            let request = parse_mcp_request(params)?;
            service.mcp_action(pane, request).await
        }
        "agent_chat.background" => {
            let id = id_of(params, "tool_use_id")?;
            service.background(pane, id.as_deref()).await
        }
        "agent_chat.task.stop" => {
            let task = id_of(params, "task_id")?.ok_or("task_id is required")?;
            service.stop_task(pane, &task).await
        }
        "agent_chat.recover" => service.recover(pane).await,
        "agent_chat.api_key.answer" => match params.get("use").and_then(Value::as_str) {
            Some("api_key") => service.answer_api_key(pane, true),
            Some("login") => service.answer_api_key(pane, false),
            _ => return Err("use is api_key or login".into()),
        },
        "agent_chat.handover" => {
            let to = match params.get("to").and_then(Value::as_str) {
                Some(to @ ("conversation" | "terminal")) => to.to_owned(),
                _ => return Err("to is conversation or terminal".into()),
            };
            let session_id = id_of(params, "session_id")?;
            let quit_writer = match params.get("quit_writer") {
                None => None,
                Some(Value::String(writer)) if !writer.is_empty() && js::len16(writer) <= 200 => {
                    Some(writer.clone())
                }
                _ => return Err("invalid quit_writer".into()),
            };
            let suspend = (params.get("suspend") == Some(&Value::Bool(true)) && to == "terminal")
                .then(|| suspend_title(params.get("title")));
            Value::Object(
                service
                    .handover(
                        pane,
                        &to,
                        params.get("interrupt") == Some(&Value::Bool(true)),
                        params.get("auto") == Some(&Value::Bool(true)),
                        session_id.as_deref(),
                        quit_writer.as_deref(),
                        suspend,
                    )
                    .await,
            )
        }
        "agent_chat.handover.cancel" => service.cancel_handover(pane),
        "agent_chat.fg" => service.foreground(pane).await,
        other => return Err(format!("unknown method: {other}")),
    })
}
