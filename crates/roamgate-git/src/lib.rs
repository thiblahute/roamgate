//! Git over a workspace's host (Rust migration plan, section 6.2): the
//! shell scripts and parsers of server/src/workspace/git-*, diff-base,
//! default-branch, review-patch and review-files, and review/patch's
//! unified diff reader, ported decision for decision.
//!
//! Every helper builds the script TS built and runs it through a
//! [`exec::GitContext`]: this machine, or the workspace's SSH host (whose
//! masters and session slots Bun keeps until the host layer moves).

pub mod actions;
pub mod combined;
pub mod compare;
pub mod default_branch;
pub mod diff;
pub mod diff_base;
pub mod exec;
pub mod history;
pub mod patch;
pub mod review;
pub mod review_files;
pub mod review_patch;
pub mod shell;
pub mod snapshot;

use std::time::Duration;

pub use exec::{GitContext, Invocation, Ran, Request, RunError, Runner};
pub use roamgate_exec::quote::shell_quote;

/// file-constants.ts, the Git part.
pub const GIT_DIFF_TIMEOUT: Duration = Duration::from_millis(10_000);
pub const GIT_DIFF_MAX_BYTES: usize = 512 * 1024;
pub const GIT_PULL_TIMEOUT: Duration = Duration::from_millis(120_000);
pub const GIT_UNTRACKED_NUMSTAT_CONCURRENCY: usize = 4;
pub const GIT_UNTRACKED_NUMSTAT_BATCH_SIZE: usize = 100;
pub const GIT_UNTRACKED_NUMSTAT_MAX_FILES: usize = 500;
/// shared/gitDiffLimits.ts: a patch this large waits to be asked for.
pub const LARGE_DIFF_PATCH_BYTES: usize = 128 * 1024;

/// A Git helper's failure: a message as the TS `Error` said it, or a
/// review whose checkout or commits are gone.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GitError {
    #[error("{0}")]
    Message(String),
    #[error("{message}")]
    Gone {
        code: review::GoneCode,
        message: String,
    },
}

impl GitError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }

    /// The HTTP-like status the review service answers a gone review with.
    pub fn status(&self) -> Option<u16> {
        matches!(self, Self::Gone { .. }).then_some(410)
    }
}

impl From<RunError> for GitError {
    fn from(error: RunError) -> Self {
        Self::Message(error.0)
    }
}

pub type Result<T, E = GitError> = std::result::Result<T, E>;

/// `text.trim().slice(0, max)`, in UTF-16 units as JS counts them.
pub fn trim_slice(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    let mut units = 0;
    let mut end = trimmed.len();
    for (index, char) in trimmed.char_indices() {
        let width = char.len_utf16();
        if units + width > max {
            end = index;
            break;
        }
        units += width;
    }
    trimmed[..end].to_owned()
}

/// `(a || b || fallback).trim().slice(0, max)`.
pub fn first_text(parts: &[&str], fallback: &str, max: usize) -> String {
    let text = parts
        .iter()
        .find(|part| !part.is_empty())
        .copied()
        .unwrap_or(fallback);
    trim_slice(text, max)
}

/// A buffer without a UTF-8 sequence cut at its end (preview.ts
/// `trimIncompleteUtf8Tail`).
pub fn trim_incomplete_utf8_tail(buffer: &[u8]) -> &[u8] {
    if buffer.is_empty() {
        return buffer;
    }
    let mut lead = buffer.len() as isize - 1;
    while lead >= 0 && (buffer[lead as usize] & 0xc0) == 0x80 {
        lead -= 1;
    }
    if lead < 0 {
        return &[];
    }
    let lead_index = lead as usize;
    let byte = buffer[lead_index];
    let expected = match byte {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    };
    if buffer.len() - lead_index < expected {
        &buffer[..lead_index]
    } else {
        buffer
    }
}

/// A fresh `ROAMGATE-...-<uuid>` marker.
pub fn marker(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}
