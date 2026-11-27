//! Agent profiles (server/src/profiles, shared/agentProfiles.ts): how
//! Roamgate starts an agent (its program and environment), which profile
//! each session runs with (`session-profiles.json`), the one-use launches
//! typed into panes, the models a profile's server offers and the
//! `agent_profile.*` RPCs. The `agent_profiles` family's channel adapter
//! is in the `roamgate` binary.
//!
//! | Module | What |
//! |---|---|
//! | [`shared`] | the profiles offered, a profile's program and unset variables, the usage limits and models of a transcript (shared/agentProfiles.ts) |
//! | [`store`] | commands of profiles, secret files, the session choices, the launch registry (profiles/profiles.ts) |
//! | [`discovery`] | the models a profile's server lists (profiles/models.ts) |
//! | [`account_usage`] | which sessions ran on each account, and the tokens they spent there |
//! | [`chain`] | the account chain over the settings: its members, and the account a session of another agent starts on |
//! | [`rpc`] | `agent_profile.*` and the return after a limit's reset (profiles/rpc.ts) |

pub mod account_usage;
pub mod chain;
pub mod discovery;
pub mod rpc;
pub mod shared;
pub mod store;
mod time;
