//! Roamgate's connections (Rust migration plan, section 6.2): the leaf
//! Phase 2 moved (S12, limit-resume and the usage-limit module) and the
//! host layer of S16. The runtime composition, the profile service and the
//! `host` family's adapter come with S16's next steps; routing, agent
//! sessions, tab titles and agent profiles with S18 and S21.
//!
//! | Module | What |
//! |---|---|
//! | [`usage_limit`] | the `limit_resume` settings, a usage-limit stop read from a transcript, the pauses browsers are told (shared/limitResume.ts) |
//! | [`limit_resume`] | the store, a connection as the resumer sees it, the scheduler (server/src/limit-resume) |
//! | [`manager`] | connections, generations, runtime leases (connections/manager.ts) |
//! | [`profiles`] | `connections.json`: validation and the private store (connections/profiles.ts) |
//! | [`ssh_profile_runtime`] | an SSH profile's private runtime directory (connections/ssh-profile-runtime.ts) |
//! | [`ssh_guard`] | the test server's refusal of SSH hosts (connections/ssh-guard.ts) |
//! | [`network_watch`] | external address changes (connections/network-watch.ts) |
//! | [`subscription_loop`] | the Herdr event subscription loop (connections/subscription-loop.ts) |
//! | [`agent_status`] | per-pane agent status subscriptions (connections/agent-status-subscription.ts) |

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
