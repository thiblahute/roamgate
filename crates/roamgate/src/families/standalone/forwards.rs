//! Port forwards (bridge/ssh-forward.ts and bridge/forward-rpc.ts): the
//! server's one registry of on-demand SSH forwards (roamgate-exec
//! `ssh::forward`), its list pushed to every browser on each change and
//! given in each socket's hello, and each connection generation's
//! `forward.*` handler (roamgate-http `forward_rpc`), its port scans over
//! the core's SSH session slots or here.

use std::sync::{Arc, OnceLock};

use roamgate_base::clock::BoxFuture;
use roamgate_exec::ssh::forward::{ForwardDeps, SshForwards, forward_to_wire, roamgate_own_ports};
use roamgate_http::forward_rpc::{ForwardRpc, PortScan, ScanCommand};
use roamgate_http::rpc_reply::ReplyEnvelope;
use serde_json::{Map, Value, json};

use super::Layer;
use super::connections::{SshRun, run_local, run_ssh};

static REGISTRY: OnceLock<SshForwards> = OnceLock::new();

/// The forwards as browsers see them.
fn wire(forwards: &SshForwards) -> Vec<Value> {
    forwards
        .list()
        .iter()
        .map(|record| serde_json::to_value(forward_to_wire(record)).unwrap_or_default())
        .collect()
}

/// The server's forwards (made once): Roamgate's own listening port (and
/// Vite's in development) never exposed by a remote forward.
pub(crate) fn registry(layer: &Arc<Layer>) -> SshForwards {
    REGISTRY
        .get_or_init(|| {
            let mut deps = ForwardDeps::real(layer.host.ops().runner.clone());
            let config = layer.clone();
            deps.reserved_ports = Arc::new(move || {
                let port = config.config.lock().unwrap().port;
                let development =
                    std::env::var("NODE_ENV").is_ok_and(|value| value == "development");
                roamgate_own_ports(port, development)
            });
            let forwards = SshForwards::new(layer.clock.clone(), deps);
            // Forwards belong to the machine, not to a browser tab: every
            // open tab shows the same list, with no connection envelope.
            let clients = layer.clients.clone();
            forwards.on_change(move |records| {
                let list: Vec<Value> = records
                    .iter()
                    .map(|record| serde_json::to_value(forward_to_wire(record)).unwrap_or_default())
                    .collect();
                clients.broadcast(&json!({ "forwards": list }).to_string(), "forwards", None);
            });
            forwards
        })
        .clone()
}

/// The list a socket's hello carries.
pub(crate) fn hello(layer: &Arc<Layer>) -> Value {
    json!({ "forwards": wire(&registry(layer)) })
}

/// The scans of a connection: over its SSH sessions, or here.
struct LayerScan {
    layer: Arc<Layer>,
    connection: String,
}

impl PortScan for LayerScan {
    fn run(&self, command: ScanCommand, timeout_ms: u64) -> BoxFuture<Result<String, String>> {
        let layer = self.layer.clone();
        let connection = self.connection.clone();
        Box::pin(async move {
            match command {
                ScanCommand::Ssh {
                    destination,
                    command,
                } => {
                    let ran = run_ssh(
                        &layer,
                        &destination,
                        &command,
                        SshRun {
                            read: false,
                            tag: "forward.candidates",
                            connection: Some(&connection),
                            stdin: None,
                            timeout_ms,
                            lane: roamgate_exec::lanes::current_lane(),
                        },
                    )
                    .await?;
                    Ok(String::from_utf8_lossy(&ran.stdout).into_owned())
                }
                ScanCommand::Local { argv } => run_local(&layer, argv, timeout_ms, None)
                    .await
                    .map(|(_, stdout, _)| stdout),
            }
        })
    }
}

/// A generation's `forward.*` handler.
pub(crate) fn rpc(
    layer: &Arc<Layer>,
    connection_id: &str,
    generation: u64,
    ssh_host: Option<String>,
) -> ForwardRpc {
    ForwardRpc::new(
        ReplyEnvelope::new(Some(connection_id), Some(generation)),
        move || ssh_host.clone(),
        Arc::new(LayerScan {
            layer: layer.clone(),
            connection: connection_id.to_owned(),
        }),
        registry(layer),
    )
}

/// A generation went: its forwards are marked lost, so a reconnect does
/// not make them vanish unexplained.
pub(crate) fn lose_connection(layer: &Arc<Layer>, connection_id: &str) {
    if REGISTRY.get().is_some() {
        registry(layer).lose_connection(connection_id);
    }
}

/// A `forward.*` call: its answer as the handler's reply gives it.
pub(crate) async fn call(
    rpc: &ForwardRpc,
    method: &str,
    params: &Value,
    is_current: &super::browser::IsCurrent,
) -> super::browser::Reply {
    let empty = Map::new();
    let params = params.as_object().unwrap_or(&empty);
    let reply = rpc
        .handle(Some(&json!("forward")), method, params, || is_current())
        .await;
    let parsed: Value = serde_json::from_str(&reply.payload).unwrap_or(Value::Null);
    match (reply.error, parsed.get("result")) {
        (None, Some(result)) => super::browser::Reply {
            result: Ok(result.clone()),
            context: method.to_owned(),
        },
        (error, _) => super::browser::Reply {
            result: Err(roamgate_sidecar::protocol::RpcError::new(
                parsed["error"]["message"]
                    .as_str()
                    .map(str::to_owned)
                    .or(error)
                    .unwrap_or_default(),
            )),
            context: format!("{method}-error"),
        },
    }
}
