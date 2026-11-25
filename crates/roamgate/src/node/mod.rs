//! `roamgate node`: a machine's node beside the home (the desktop).
//!
//! - `roamgate node --stdio`: the home's link over ssh ([`stdio`]).
//! - `roamgate node --listen <host:port> --home <origin>`: the same front
//!   and standalone core as the server, serving the browser this
//!   machine's own connection only ([`listen`]); its core's families are
//!   [`families`]'.

pub mod families;
pub mod listen;
pub mod stdio;

pub use families::{home_method, node_families, served_by_home};

/// Runs the node with its flags; returns the exit code.
pub async fn run(args: &[String]) -> u8 {
    if args.iter().any(|arg| arg == "--stdio") {
        return stdio::run_stdio(args).await;
    }
    listen::run(args).await
}

/// What a node's page is told of it (its hello's `node`, `GET
/// /api/node`): the home's origin, its connection and its version; None
/// outside a node.
pub fn advertisement() -> Option<serde_json::Value> {
    let home = roamgate_base::node::process_home()?;
    Some(serde_json::json!({
        "home": home,
        "connection_id": roamgate_base::node::NODE_CONNECTION_ID,
        "version": crate::VERSION,
    }))
}
