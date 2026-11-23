//! The families the core serves (Rust migration plan, section 8.2; S12 on):
//! each module wraps a family crate's code in a
//! [`roamgate_sidecar::family::CoreFamily`], mapping its effects onto the
//! channel (reverse calls into what Bun still owns, pushes to browsers).
//! Temporary like the channel: at the cut-over the families are served
//! directly and these adapters go.

use roamgate_sidecar::family::Families;

pub mod activity;
pub mod agent_profiles;
pub mod agent_sessions;
pub mod archive;
pub mod assistant;
pub mod claude_mod;
pub mod conversation;
pub mod herdr;
pub mod host;
pub mod limit_resume;
pub mod mr_cache;
pub mod mr_reviews;
pub mod notifications;
pub mod review;
pub mod review_socket;
pub mod settings;
pub mod time_report;
pub mod update;
pub mod voice;
pub mod work;
pub mod workspace;

/// Every family this build implements.
pub fn core_families() -> Families {
    [
        limit_resume::family(),
        time_report::family(),
        herdr::family(),
        update::family(),
        settings::family(),
        mr_cache::family(),
        notifications::family(),
        activity::family(),
        archive::family(),
        assistant::family(),
        work::family(),
        host::family(),
        mr_reviews::family(),
        voice::family(),
        agent_sessions::family(),
        agent_profiles::family(),
        conversation::family(),
        workspace::family(),
        review::family(),
    ]
    .into_iter()
    .flatten()
    .collect()
}
