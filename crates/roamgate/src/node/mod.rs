//! `roamgate node`: a machine's node beside the home (the desktop).
//!
//! - `roamgate node --stdio`: the home's link over ssh ([`stdio`]).
//! - `roamgate node --listen <host:port> --home <origin>`: the same front
//!   and standalone core as the server, serving the browser this
//!   machine's own connection only (`listen`).

pub mod stdio;

/// Runs the node with its flags; returns the exit code.
pub async fn run(args: &[String]) -> u8 {
    if args.iter().any(|arg| arg == "--stdio") {
        return stdio::run_stdio(args).await;
    }
    eprintln!("roamgate node: --listen is not available in this build");
    2
}
