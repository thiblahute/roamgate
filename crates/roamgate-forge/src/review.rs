//! Review's forge code (review/forge.ts, gitlab.ts, github.ts,
//! forge-cli.ts, memo.ts): GitLab merge requests and GitHub pull requests
//! read and drafted on the checkout's host through glab and gh, and the
//! requests the agent chats show.
//!
//! | Module | Role | Replaces |
//! |---|---|---|
//! | [`cli`] | Where glab, gh and scripts run ([`ForgeRunner`]), their command lines, and API answers made patches | review/forge-cli |
//! | [`gitlab`] | Merge requests, their threads and drafts, checkouts and their branch's request | review/gitlab |
//! | [`github`] | Pull requests the same way, the pending review as drafts | review/github |
//! | [`memo`] | Answers shared while asked and remembered a while | review/memo |
//! | [`service`] | The review service's [`roamgate_review::service::ReviewForge`] | service.ts's `gitlab` argument |
//! | [`status`] | The chips' request statuses, batched and cached in the MR cache, a session's repositories | review/forge |
//!
//! Nothing here writes to a forge but the user's drafts: GitLab draft
//! notes (and their images) and the pending GitHub review's comments and
//! body (`tests/review_writes.rs` reads these sources to keep it so).

pub mod cli;
pub mod github;
pub mod gitlab;
pub mod memo;
pub mod service;
pub mod status;
#[cfg(test)]
pub(crate) mod testkit;

pub use cli::{ForgeContext, ForgeProcess, ForgeRunner, ForgeTools, LocalForgeRunner, RunError};
pub use service::{ContextOf, MergeRequestForge};
pub use status::{ForgeCache, ForgeRef, ForgeWorkspace, ScannedRepo};
