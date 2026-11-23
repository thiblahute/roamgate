//! The `shared/` modules the readers use, ported for the server (plan 6.4:
//! dual-use logic stays in TS for the web and is pinned by vectors).

pub mod agent_message;
pub mod agent_models;
pub mod bash_mode;
pub mod file_edits;
pub mod history_window;
pub mod injected;
pub mod slash_command;
pub mod tool_summary;

/// What the agent is told of a question the user dismissed.
pub const DISMISSED_QUESTION_MESSAGE: &str = "The user dismissed this question without answering.";
/// What the agent is told of a permission the user dismissed.
pub const DISMISSED_PERMISSION_MESSAGE: &str = "The user dismissed this request without answering.";

/// Whether a tool's result is the denial a dismissed prompt sends.
pub fn is_dismissed_result(text: Option<&str>) -> bool {
    text.is_some_and(|text| {
        !text.is_empty()
            && (text.contains(DISMISSED_QUESTION_MESSAGE)
                || text.contains(DISMISSED_PERMISSION_MESSAGE))
    })
}
