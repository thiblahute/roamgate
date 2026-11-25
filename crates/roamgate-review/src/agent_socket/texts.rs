//! What the agent socket installs on each host (review/agent-client.ts,
//! review/agent-skill.ts and conversation/holder-script.ts's installed
//! script): the review client, conversation mode's pane holder and the
//! skill, from contract/assets. This machine runs the clients as the
//! roamgate binary itself (crates/roamgate-agent-client); SSH hosts get
//! these Python versions.

use std::sync::LazyLock;

use roamgate_base::assets::{REVIEW_SKILL_MD, ROAMGATE_HOLD_PY, ROAMGATE_REVIEW_PY};
use sha2::{Digest, Sha256};

/// The agent-side client, installed as `~/.cache/roamgate/bin/roamgate-review`
/// on each SSH host. Python 3 standard library only; it speaks JSON over
/// the unix socket the bridge listens on, as the binary's own
/// `roamgate-review` does on this machine.
pub const REVIEW_CLIENT_SCRIPT: &str = ROAMGATE_REVIEW_PY;

/// Instructions for coding agents, printed by `roamgate-review skill` and
/// installed next to the client as SKILL.md.
pub const REVIEW_SKILL: &str = REVIEW_SKILL_MD;

/// conversation/holder-script.ts's `roamgate-hold`.
pub const HOLD_CLIENT_SCRIPT: &str = ROAMGATE_HOLD_PY;

fn checksum(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))[..16].to_owned()
}

pub static REVIEW_CLIENT_CHECKSUM: LazyLock<String> =
    LazyLock::new(|| checksum(REVIEW_CLIENT_SCRIPT));

pub static HOLD_CLIENT_CHECKSUM: LazyLock<String> = LazyLock::new(|| checksum(HOLD_CLIENT_SCRIPT));

/// The client as installed: its version on its last line.
pub static REVIEW_CLIENT_INSTALLED_SCRIPT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{REVIEW_CLIENT_SCRIPT}# roamgate-review {}\n",
        REVIEW_CLIENT_CHECKSUM.as_str()
    )
});

/// The holder as installed: its version on its last line.
pub static HOLD_CLIENT_INSTALLED_SCRIPT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{HOLD_CLIENT_SCRIPT}# roamgate-hold {}\n",
        HOLD_CLIENT_CHECKSUM.as_str()
    )
});
