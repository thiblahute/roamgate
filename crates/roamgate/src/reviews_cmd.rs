//! `roamgate reviews ...` (the mr_reviews family's command): exports or
//! imports what the Reviews authored, run here while Rust owns the family.

use std::sync::Arc;

use roamgate_base::clock::{Clock, SystemClock};
use roamgate_base::env::ProcessEnv;

const FAMILY: &str = "mr_reviews";

/// `roamgate reviews ...`; returns the exit code.
pub fn cli(args: &[String]) -> u8 {
    roamgate_sidecar::core::note_served(&ProcessEnv, FAMILY, "cli reviews");
    let runtime = crate::families::update::cli_runtime(Arc::new(ProcessEnv));
    let now = || SystemClock.now() as f64;
    crate::families::update::emit(
        roamgate_cli::reviews::ReviewsCli {
            runtime: &runtime,
            now: &now,
        }
        .run(args),
    )
}
