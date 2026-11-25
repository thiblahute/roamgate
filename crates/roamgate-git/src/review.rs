//! The review's types this layer reads and writes (shared/review.ts): the
//! targets a patch is read for, a diff, a commit, and what makes a review
//! gone.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::patch::DiffFile;

/// What a review shows, the targets read from Git.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Target {
    Range {
        base: String,
        head: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        compare: bool,
    },
    Worktree,
    Step {
        step: String,
        before: String,
        after: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skipped: Option<Vec<String>>,
    },
    Mr {
        url: String,
    },
}

impl Target {
    pub fn range(base: &str, head: &str) -> Self {
        Self::Range {
            base: base.into(),
            head: head.into(),
            compare: false,
        }
    }
}

/// `checkout-gone`, `base-gone`, `head-gone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GoneCode {
    CheckoutGone,
    BaseGone,
    HeadGone,
}

impl GoneCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckoutGone => "checkout-gone",
            Self::BaseGone => "base-gone",
            Self::HeadGone => "head-gone",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDiff {
    pub files: Vec<DiffFile>,
    #[serde(rename = "baseSha", default, skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(rename = "headSha", default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewCommit {
    pub sha: String,
    pub parent: Option<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub history: bool,
}

static METADATA_PARTS: LazyLock<BTreeSet<&'static str>> = LazyLock::new(|| {
    ["entire", "checkpoint", "checkpoints"]
        .into_iter()
        .collect()
});

/// A ref holding a tool's metadata rather than code: anything outside
/// `refs/heads/` and `refs/remotes/` (notes, stashes), and branches such
/// as Entire's `entire/checkpoints/v1`.
pub fn is_metadata_ref(name: &str) -> bool {
    let short = name
        .strip_prefix("refs/heads/")
        .or_else(|| name.strip_prefix("refs/remotes/"));
    if name.starts_with("refs/") && short.is_none() {
        return true;
    }
    short
        .unwrap_or(name)
        .split('/')
        .any(|part| METADATA_PARTS.contains(part.to_lowercase().as_str()))
}

pub use roamgate_base::paths::is_host_path;
