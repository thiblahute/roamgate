//! Workspaces and worktrees (Rust migration plan, section 6.2): what
//! server/src/workspace (but its Git, in `roamgate-git`) and
//! server/src/worktree hold, ported decision for decision. Every effect on
//! a workspace's host goes through `roamgate-git`'s [`GitContext`]: this
//! machine, or the workspace's SSH host.
//!
//! [`GitContext`]: roamgate_git::GitContext

pub mod html_preview;
pub mod html_preview_files;
pub mod worktree;
