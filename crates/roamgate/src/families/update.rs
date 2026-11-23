//! The update family in the core (see [`super`]).

use std::sync::Arc;

use roamgate_sidecar::family::CoreFamily;

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    None
}

/// `roamgate update ...` and `roamgate rollback ...` (`command` is which);
/// returns the exit code.
pub async fn cli(command: &str, _args: &[String]) -> u8 {
    eprintln!("roamgate {command}: not in this build");
    2
}
