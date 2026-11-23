//! The herdr family in the core (see [`super`]).

use std::sync::Arc;

use roamgate_sidecar::family::CoreFamily;

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    None
}

/// `roamgate herdr ...`; returns the exit code.
pub async fn cli(_args: &[String]) -> u8 {
    eprintln!("roamgate herdr: not in this build");
    2
}
