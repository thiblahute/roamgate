//! The headless claude's environment (`drivers/claude-env.ts`), built
//! explicitly: nothing of an outer Claude Code session, the pane's API key
//! only when the user said to use it, and a marker that tells Roamgate's
//! own hooks to step aside. Nor the pane's HERDR_ENV, HERDR_PANE_ID and
//! HERDR_SOCKET_PATH: with them, Herdr's SessionStart hook claims the pane
//! for `herdr:claude`, and Herdr then drops every state Roamgate reports
//! for it (`roamgate:headless`) until the pane is back at its shell. The
//! pane and its Herdr server are still told under Roamgate's own names
//! (`PANE_NAMES`): the review client reports them, so comments in a review
//! the agent opened reach its pane. Checkpoints of the files it edits are
//! turned on, as the terminal claude has them: a rewind restores the code
//! from them.
//!
//! The pane's Anthropic API key: Claude Code's TUI asks once whether to
//! use it and files the answer in its global config (`customApiKeyResponses`
//! in ~/.claude.json, or in $CLAUDE_CONFIG_DIR, by the key's last 20
//! characters), while `claude -p` uses it without asking. So the holder, on
//! the pane's host, reads that answer and keeps the key only when it was
//! yes; with no answer yet the chat asks the TUI's question and the holder
//! files the answer there before it starts the headless claude. The key
//! itself never leaves the host. ANTHROPIC_AUTH_TOKEN is kept: Claude Code
//! uses it in the TUI as in print mode, without asking.

use roamgate_agents::js::Obj;
use roamgate_agents::obj;
use roamgate_conversation::driver::ApiKeyAnswer;
use serde_json::Value;

pub const API_KEY: &str = "ANTHROPIC_API_KEY";

/// What the holder is told to do with the pane's API key.
pub const API_KEY_POLICY: &str = "claude_config";

const DROPPED: [&str; 8] = [
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_PLUGIN_DATA",
    // Kept by a holder that knows the user approved it (API_KEY_POLICY);
    // an older holder drops it, as it always did.
    API_KEY,
    // Herdr's hook would claim the pane (see above).
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_SOCKET_PATH",
];
const DROPPED_PREFIXES: [&str; 1] = ["CLAUDE_CODE_"];

pub const HEADLESS_MARKER: &str = "ROAMGATE_HEADLESS";

/// The pane's Herdr names, and what the headless claude has them as.
pub const PANE_NAMES: [(&str, &str); 2] = [
    ("HERDR_PANE_ID", "ROAMGATE_PANE_ID"),
    ("HERDR_SOCKET_PATH", "ROAMGATE_HERDR_SOCKET_PATH"),
];

/// Off by default in print mode: on, as in the terminal.
const CHECKPOINTS: &str = "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING";

fn strings(items: &[&str]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect(),
    )
}

/// What the pane holder changes in the pane's environment before it
/// starts the headless claude (`holderEnvChanges`): `drop`,
/// `drop_prefixes`, `copy` (the pane's Herdr names to Roamgate's, before
/// the drop), `set` (the marker, checkpoints, and the pane id for a holder
/// from before `copy`) and `api_key` (the policy, and the user's answer
/// the holder files first).
pub fn holder_env_changes(answer: Option<ApiKeyAnswer>, pane_id: Option<&str>) -> Obj {
    let copy: Obj = PANE_NAMES
        .iter()
        .map(|(from, to)| ((*from).to_owned(), Value::String((*to).to_owned())))
        .collect();
    let mut set = obj! {
        HEADLESS_MARKER => "1",
        CHECKPOINTS => "1",
    };
    if let Some(pane) = pane_id.filter(|pane| !pane.is_empty()) {
        set.insert(PANE_NAMES[0].1.to_owned(), Value::String(pane.to_owned()));
    }
    obj! {
        "drop" => strings(&DROPPED),
        "drop_prefixes" => strings(&DROPPED_PREFIXES),
        "copy" => copy,
        "set" => set,
        "api_key" => obj! {
            "policy" => API_KEY_POLICY,
            "answer" => answer.map(ApiKeyAnswer::as_str),
        },
    }
}
