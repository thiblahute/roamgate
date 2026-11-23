//! Workspaces and worktrees (Rust migration plan, section 6.2): what
//! server/src/workspace (but its Git, in `roamgate-git`) and
//! server/src/worktree hold, ported decision for decision. Every effect on
//! a workspace's host goes through `roamgate-git`'s [`GitContext`]: this
//! machine, or the workspace's SSH host.
//!
//! [`GitContext`]: roamgate_git::GitContext

pub mod atomic_move;
pub mod auto_sync;
pub mod auto_sync_settings;
pub mod connection;
pub mod file_download;
pub mod file_manager;
pub mod file_paths;
pub mod file_types;
pub mod files;
pub mod html_preview;
pub mod html_preview_files;
pub mod last_step_turns;
pub mod local_files;
pub mod path;
pub mod preview;
pub mod process;
pub mod pull_request;
pub mod remote_files;
pub mod search;
pub mod status;
#[cfg(test)]
mod status_test_support;
#[cfg(test)]
mod test_support;
pub mod tree;
pub mod worktree;
