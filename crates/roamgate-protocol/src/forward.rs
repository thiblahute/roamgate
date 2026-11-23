//! SSH port forwards on the wire (`ForwardWire` of
//! server/src/bridge/ssh-forward.ts, `contract/schemas/server.schema.json`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which way the tunnel runs.
///
/// `local` (ssh -L) puts a remote service on a local port: the browser
/// reaches something running on the far host. `remote` (ssh -R) is the
/// mirror, a service on this machine appears on the far host, so processes
/// there, agents included, can reach it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SshForwardDirection {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SshForwardState {
    Starting,
    Open,
    Failed,
    Closed,
}

/// A forward as the browser sees it. The bridge protocol is snake_case on
/// the wire; internals are not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ForwardWire {
    pub id: String,
    pub connection_id: String,
    pub direction: SshForwardDirection,
    pub remote_port: u16,
    pub local_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    pub state: SshForwardState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}
