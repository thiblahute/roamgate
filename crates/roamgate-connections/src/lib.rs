//! Roamgate's connections (Rust migration plan, section 6.2): the leaf
//! Phase 2 moved (S12, limit-resume and the usage-limit module) and the
//! host layer of S16: the profile service, the runtime of a generation the
//! core owns and the front's SSH commands (the `host` family's channel
//! adapter is in the `roamgate` binary), then S21's: every connection's
//! agents, tab titles and agent profiles, and S25's routing of browser requests.
//!
//! | Module | What |
//! |---|---|
//! | [`usage_limit`] | the `limit_resume` settings, a usage-limit stop read from a transcript, the pauses browsers are told (shared/limitResume.ts) |
//! | [`limit_resume`] | the store, a connection as the resumer sees it, the scheduler (server/src/limit-resume) |
//! | [`manager`] | connections, generations, runtime leases (connections/manager.ts) |
//! | [`profiles`] | `connections.json`: validation and the private store (connections/profiles.ts) |
//! | [`profile_service`] | the profiles the manager runs, their mutations, probes and SSH retry supervision (connections/profile-service.ts) |
//! | [`ssh_profile_runtime`] | an SSH profile's private runtime directory (connections/ssh-profile-runtime.ts) |
//! | [`ssh_guard`] | the test server's refusal of SSH hosts (connections/ssh-guard.ts) |
//! | [`network_watch`] | external address changes (connections/network-watch.ts) |
//! | [`subscription_loop`] | the Herdr event subscription loop (connections/subscription-loop.ts) |
//! | [`agent_status`] | per-pane agent status subscriptions (connections/agent-status-subscription.ts) |
//! | [`host_runtime`] | a generation's transport, probe and Herdr subscriptions while the core owns the `host` family, the rest built by the front (connections/runtime.ts) |
//! | [`agent_models`] | /model's names, the picker's list, a model's short name (shared/agentModels.ts) |
//! | [`agent_profiles`] | agent profiles: commands, session choices, launches, model discovery, `agent_profile.*` (profiles/, shared/agentProfiles.ts) |
//! | [`agent_summaries`] | every ready connection's agents and their side tasks at once (connections/agent-sessions.ts, agent-tasks.ts) |
//! | [`agent_tab_title`] | the title of a pane's agent session for its tab (connections/agent-tab-title.ts) |
//! | [`tab_auto_rename`] | tabs named after their agent's session (connections/tab-auto-rename.ts) |
//! | [`routing`] | which connection a browser RPC or HTTP route is for, the connection envelope (connections/protocol.ts, rpc-routing.ts, http-routing.ts) |
//! | [`node_host`] | an SSH profile's node link: its start and handshake, socket streams and commands on the node (contract/wire/node-link.md) |
//! | [`host_ops`] | the front's SSH commands run or held in the core's session slots (bridge/ssh-sessions.ts) |

pub use roamgate_agents::shared::agent_models;
pub mod agent_profiles;
pub mod agent_status;
pub mod agent_summaries;
pub mod agent_tab_title;
pub mod host_ops;
pub mod host_runtime;
pub mod limit_resume;
pub mod manager;
pub mod network_watch;
pub mod node_host;
pub mod profile_service;
pub mod profiles;
pub mod routing;
pub mod ssh_guard;
pub mod ssh_profile_runtime;
pub mod subscription_loop;
pub mod tab_auto_rename;
pub mod usage_limit;

/// A boxed future, as the effects traits return.
pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'static>>;
