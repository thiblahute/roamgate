//! The `forward.*` RPCs (bridge/forward-rpc.ts): on-demand port forwards of
//! one connection's SSH transport, over the server's one
//! [`SshForwards`] registry.
//!
//! Forwarding is only offered where the browser and the Roamgate server
//! share a machine: a forward binds on whichever host runs `ssh`, so
//! anywhere else the port is either unreachable from the browser or
//! exposed beyond it. Connections without an SSH transport are refused
//! outright rather than silently doing nothing; listing and closing work on
//! the global registry whatever the connection.
//!
//! The port scan behind `forward.candidates` runs through a [`PortScan`]:
//! the host runs it over the connection's SSH sessions (a local forward
//! asks the far host what it listens on) or here (a remote forward asks
//! this machine).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use futures_util::future::Shared;
use roamgate_base::clock::BoxFuture;
use roamgate_base::settings::js_trim;
use roamgate_exec::quote::shell_quote;
use roamgate_exec::ssh::forward::{
    ForwardRequest, LISTENING_PORTS_COMMAND, SshForwards, forward_to_wire, owned_listening_ports,
    parse_listening_ports, validate_forward_port,
};
use roamgate_protocol::forward::{SshForwardDirection, SshForwardState};
use serde_json::{Map, Value, json};

use crate::rpc_reply::{CONNECTION_CHANGED_DURING_REQUEST, ReplyEnvelope, RpcReply};

/// A scan slower than this lists nothing rather than holding the menu.
pub const FORWARD_SCAN_TIMEOUT_MS: u64 = 10_000;
/// A host listening on hundreds of ports gets its lowest ones offered.
pub const MAX_FORWARD_CANDIDATES: usize = 64;
/// The longest label kept, in UTF-16 units.
const MAX_LABEL_UNITS: usize = 64;

/// Where the listening-ports scan runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanCommand {
    /// On the far host: `command` is the remote command line of an ssh
    /// host command to `destination` (the TS `sshCommandArgv`).
    Ssh {
        destination: String,
        command: String,
    },
    /// Here.
    Local { argv: Vec<String> },
}

/// Runs a scan within `timeout_ms` and gives its stdout; an error (no
/// scanner, ssh refused, too slow) lists nothing.
pub trait PortScan: Send + Sync + 'static {
    fn run(&self, command: ScanCommand, timeout_ms: u64) -> BoxFuture<Result<String, String>>;
}

type Scan = Shared<BoxFuture<String>>;

struct Inner {
    envelope: ReplyEnvelope,
    ssh_host: Box<dyn Fn() -> Option<String> + Send + Sync>,
    scanner: Arc<dyn PortScan>,
    forwards: SshForwards,
    /// One scan per direction at a time: opening the list repeatedly joins
    /// the scan in flight instead of starting another ssh each time.
    scans: Mutex<HashMap<&'static str, Scan>>,
}

/// One connection's `forward.*` handler. Clones are the same handler.
#[derive(Clone)]
pub struct ForwardRpc {
    inner: Arc<Inner>,
}

/// The browser RPCs this handler answers.
pub const RPC_METHODS: [&str; 4] = [
    "forward.list",
    "forward.close",
    "forward.open",
    "forward.candidates",
];

fn direction_of(params: &Map<String, Value>) -> SshForwardDirection {
    if params.get("direction").and_then(Value::as_str) == Some("remote") {
        SshForwardDirection::Remote
    } else {
        SshForwardDirection::Local
    }
}

fn direction_key(direction: SshForwardDirection) -> &'static str {
    match direction {
        SshForwardDirection::Local => "local",
        SshForwardDirection::Remote => "remote",
    }
}

/// `String(value ?? "")`.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// `validateForwardPort(params.remote_port ?? params.port)`.
fn port_of(params: &Map<String, Value>) -> Result<u16, String> {
    let value = params
        .get("remote_port")
        .filter(|value| !value.is_null())
        .or_else(|| params.get("port"));
    match value {
        Some(value) => validate_forward_port(value),
        None => Err("Invalid port: undefined".into()),
    }
}

/// A non-blank label, trimmed, at most 64 UTF-16 units.
fn label_of(params: &Map<String, Value>) -> Option<String> {
    let trimmed = js_trim(params.get("label")?.as_str()?);
    if trimmed.is_empty() {
        return None;
    }
    let mut units = 0;
    Some(
        trimmed
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= MAX_LABEL_UNITS
            })
            .collect(),
    )
}

impl ForwardRpc {
    pub fn new(
        envelope: ReplyEnvelope,
        ssh_host: impl Fn() -> Option<String> + Send + Sync + 'static,
        scanner: Arc<dyn PortScan>,
        forwards: SshForwards,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                envelope,
                ssh_host: Box::new(ssh_host),
                scanner,
                forwards,
                scans: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn scan(&self, direction: SshForwardDirection, destination: &str) -> Scan {
        let key = direction_key(direction);
        let mut scans = self.inner.scans.lock().expect("forward scans");
        if let Some(pending) = scans.get(key) {
            return pending.clone();
        }
        let command = match direction {
            // The remote login shell may be fish or csh, which parse
            // redirections and || differently: run the chain under sh.
            SshForwardDirection::Local => ScanCommand::Ssh {
                destination: destination.to_owned(),
                command: format!("sh -c {}", shell_quote(LISTENING_PORTS_COMMAND)),
            },
            SshForwardDirection::Remote => ScanCommand::Local {
                argv: vec!["sh".into(), "-c".into(), LISTENING_PORTS_COMMAND.into()],
            },
        };
        let running = self.inner.scanner.run(command, FORWARD_SCAN_TIMEOUT_MS);
        let inner = Arc::downgrade(&self.inner);
        let pending: BoxFuture<String> = Box::pin(async move {
            // A scan that fails is an empty list, not an error: candidates
            // are a convenience, and the other direction's list must still
            // render.
            let stdout = running.await.unwrap_or_default();
            if let Some(inner) = inner.upgrade() {
                inner.scans.lock().expect("forward scans").remove(key);
            }
            stdout
        });
        let pending = pending.shared();
        scans.insert(key, pending.clone());
        pending
    }

    /// Answers one `forward.*` request. `request_is_current` turns false
    /// once the connection's runtime was replaced or disposed.
    pub async fn handle(
        &self,
        id: Option<&Value>,
        method: &str,
        params: &Map<String, Value>,
        request_is_current: impl Fn() -> bool,
    ) -> RpcReply {
        let envelope = &self.inner.envelope;
        let fail = |detail: &str| envelope.error(id, detail);
        let reply = |result: Value| {
            if request_is_current() {
                envelope.result(id, result)
            } else {
                fail(CONNECTION_CHANGED_DURING_REQUEST)
            }
        };
        let forwards = &self.inner.forwards;
        match method {
            "forward.list" => {
                let list: Vec<Value> = forwards
                    .list()
                    .iter()
                    .map(|record| serde_json::to_value(forward_to_wire(record)).unwrap_or_default())
                    .collect();
                return reply(json!({ "forwards": list }));
            }
            "forward.close" => {
                let forward_id = js_string(params.get("id"));
                if forward_id.is_empty() {
                    return fail("forward.close requires id");
                }
                return reply(json!({ "closed": forwards.close(&forward_id) }));
            }
            _ => {}
        }
        let Some(destination) = (self.inner.ssh_host)().filter(|host| !host.is_empty()) else {
            return fail("This connection is local; port forwarding applies to SSH connections");
        };
        match method {
            "forward.open" => {
                let port = match port_of(params) {
                    Ok(port) => port,
                    Err(error) => return fail(&error),
                };
                let direction = direction_of(params);
                let label = label_of(params);
                // The runtime may already be disposed, its forwards closed: a
                // forward opened now would outlive it with nobody to close it.
                if !request_is_current() {
                    return fail(CONNECTION_CHANGED_DURING_REQUEST);
                }
                let record = match forwards.open(ForwardRequest {
                    connection_id: envelope.connection_id.clone().unwrap_or_default(),
                    destination,
                    port,
                    direction,
                    label,
                }) {
                    Ok(record) => record,
                    Err(error) => return fail(&error),
                };
                // Reported open only once it carries traffic: a local port
                // that accepts connections, or the far host's confirmation of
                // a remote one.
                let settled = forwards.wait_until_open(&record.id).await;
                // Disposed while ssh was starting: dispose has already swept
                // this connection's forwards, so this one is ours to close.
                if !request_is_current() {
                    forwards.close_attempt(&record);
                    return fail(CONNECTION_CHANGED_DURING_REQUEST);
                }
                let Some(settled) = settled else {
                    return fail("The forward was closed before it opened");
                };
                if settled.state == SshForwardState::Failed {
                    return fail(
                        settled
                            .error
                            .as_deref()
                            .unwrap_or("The forward could not be opened"),
                    );
                }
                reply(json!({
                    "forward": serde_json::to_value(forward_to_wire(&settled)).unwrap_or_default()
                }))
            }
            "forward.candidates" => {
                // Asked for, never polled: one round trip when someone opens
                // the ports list. A local forward needs what the far host
                // listens on; a remote forward what this one does.
                let direction = direction_of(params);
                let stdout = self.scan(direction, &destination).await;
                let forwarded: Vec<u16> = forwards
                    .list()
                    .iter()
                    .filter(|entry| {
                        entry.state != SshForwardState::Failed && entry.direction == direction
                    })
                    .map(|entry| match direction {
                        SshForwardDirection::Local => entry.remote_port,
                        SshForwardDirection::Remote => entry.local_port,
                    })
                    .collect();
                let candidates: Vec<Value> = owned_listening_ports(&parse_listening_ports(&stdout))
                    .into_iter()
                    .filter(|entry| {
                        !forwarded.contains(&entry.port)
                            // Never offered, and refused by open() if asked
                            // anyway.
                            && !(direction == SshForwardDirection::Remote
                                && forwards.is_reserved(entry.port))
                    })
                    .take(MAX_FORWARD_CANDIDATES)
                    .map(|entry| {
                        let mut candidate = Map::new();
                        candidate.insert("port".into(), entry.port.into());
                        if let Some(process) = entry.process {
                            candidate.insert("process".into(), process.into());
                        }
                        Value::Object(candidate)
                    })
                    .collect();
                reply(json!({ "candidates": candidates }))
            }
            other => fail(&format!("unknown forward method: {other}")),
        }
    }
}

#[cfg(test)]
mod tests;
