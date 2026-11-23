//! The limit_resume family in the core (see [`super`]).

use std::sync::Arc;

use roamgate_sidecar::family::CoreFamily;

/// The family, once this build implements it.
pub fn family() -> Option<Arc<dyn CoreFamily>> {
    None
}
