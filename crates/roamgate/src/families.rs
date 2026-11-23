//! The families the core serves (Rust migration plan, section 8.2; S12 on):
//! each module wraps a family crate's code in a
//! [`roamgate_sidecar::family::CoreFamily`], mapping its effects onto the
//! channel (reverse calls into what Bun still owns, pushes to browsers).
//! Temporary like the channel: at the cut-over the families are served
//! directly and these adapters go.

use roamgate_sidecar::family::Families;

pub mod herdr;
pub mod limit_resume;
pub mod time_report;
pub mod update;

/// Every family this build implements.
pub fn core_families() -> Families {
    [
        limit_resume::family(),
        time_report::family(),
        herdr::family(),
        update::family(),
    ]
    .into_iter()
    .flatten()
    .collect()
}
