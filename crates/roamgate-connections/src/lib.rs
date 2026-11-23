//! Roamgate's connections (Rust migration plan, section 6.2). For now the
//! leaf the plan's Phase 2 moves (S12): the usage-limit module and the
//! limit-resume family; the connection manager, profiles, network watch and
//! subscription loops come with S16.
//!
//! | Module | What |
//! |---|---|
//! | [`usage_limit`] | the `limit_resume` settings, a usage-limit stop read from a transcript, the pauses browsers are told (shared/limitResume.ts) |
//! | [`limit_resume`] | the store, a connection as the resumer sees it, the scheduler (server/src/limit-resume) |

pub mod agent_status;
pub mod limit_resume;
pub mod manager;
pub mod network_watch;
pub mod profiles;
pub mod ssh_guard;
pub mod ssh_profile_runtime;
pub mod subscription_loop;
pub mod usage_limit;

/// A boxed future, as the effects traits return.
pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'static>>;
