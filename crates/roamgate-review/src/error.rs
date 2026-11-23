//! `ReviewError` (review/service.ts): a message for the user or agent and
//! the HTTP status the agent socket answers with (400 unless said).

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ReviewError {
    pub message: String,
    pub status: u16,
}

impl ReviewError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: 400,
        }
    }

    pub fn status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::status(message, 404)
    }
}

pub type ReviewResult<T> = Result<T, ReviewError>;
