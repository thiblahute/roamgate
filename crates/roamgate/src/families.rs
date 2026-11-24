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
pub mod front;
pub mod herdr;
pub mod history;
pub mod host;
pub mod limit_resume;
pub mod mr_cache;
pub mod mr_reviews;
pub mod notifications;
pub mod review;
pub mod review_socket;
pub mod settings;
pub mod standalone;
pub mod time_report;
pub mod update;
pub mod voice;
pub mod voice_socket;
pub mod work;
pub mod workspace;

/// Every family this build implements.
pub fn core_families() -> Families {
    families(host::family())
}

/// The families of a standalone core (a Rust front's own, no Bun): every
/// family, and first the `front` family, which terminates `/ws` and
/// answers in the process what the families asked the Bun side for.
pub fn standalone_families() -> Families {
    let (host, handle) = host::family_with_handle();
    let mut all = vec![front::family(handle)];
    all.extend(families(Some(host)));
    all
}

fn families(host: Option<std::sync::Arc<dyn roamgate_sidecar::family::CoreFamily>>) -> Families {
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
        host,
        mr_reviews::family(),
        voice::family(),
        agent_sessions::family(),
        agent_profiles::family(),
        conversation::family(),
        workspace::family(),
        review::family(),
        history::family(),
    ]
    .into_iter()
    .flatten()
    .collect()
}
