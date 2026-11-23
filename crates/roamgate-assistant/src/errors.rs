//! What Ranger may tell the model and the user (`assistant/errors.ts`).
//!
//! An [`AssistantError::User`] message is safe and useful to show: tool
//! wrappers surface it verbatim. A platform refusal (a Unix-only feature on
//! a Windows host) surfaces the same way. Any other failure is masked behind
//! a fixed message, which carries neither the original text nor a cause:
//! those can hold socket paths, provider replies or credentials.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssistantError {
    /// `AssistantUserError`: shown as it is.
    User(String),
    /// `UnsupportedPlatformError`: shown as it is.
    Platform(String),
    /// Any other failure; its message is never shown unmasked.
    Internal(String),
    /// `AssistantRecoveryNotReadyError`: a connection a task needs is down
    /// for now; the run waits for it.
    RecoveryNotReady(String),
    /// `AssistantServerRestartedError` (a user error): a connection's Herdr
    /// restarted since a task's workspaces were checked.
    ServerRestarted { connection: String, message: String },
}

impl AssistantError {
    pub fn user(message: impl Into<String>) -> Self {
        Self::User(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::User(message)
            | Self::Platform(message)
            | Self::Internal(message)
            | Self::RecoveryNotReady(message)
            | Self::ServerRestarted { message, .. } => message,
        }
    }

    /// Whether the message may be shown as it is.
    pub fn surfaced(&self) -> bool {
        matches!(
            self,
            Self::User(_) | Self::Platform(_) | Self::ServerRestarted { .. }
        )
    }

    /// `new AssistantServerRestartedError(connection)`.
    pub fn server_restarted(connection: &str) -> Self {
        Self::ServerRestarted {
            connection: connection.to_owned(),
            message: format!(
                "Herdr on {connection} restarted since the task's workspaces were checked (its server identity changed)."
            ),
        }
    }

    /// `surfaceAssistantUserError`: user-facing errors as they are, any
    /// other behind `masked`.
    pub fn surface(self, masked: &str) -> Self {
        if self.surfaced() {
            self
        } else {
            Self::Internal(masked.to_owned())
        }
    }
}

impl fmt::Display for AssistantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for AssistantError {}

pub type AssistantResult<T> = Result<T, AssistantError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_facing_and_platform_errors_surface_while_others_stay_masked() {
        let masked = "The tool failed.";
        assert_eq!(
            AssistantError::user("Pick a workspace").surface(masked),
            AssistantError::User("Pick a workspace".into())
        );
        let platform =
            AssistantError::Platform("Agent history is not available on Windows hosts yet.".into());
        assert_eq!(platform.clone().surface(masked), platform);
        let leaked = AssistantError::internal("connect ENOENT /run/user/1000/herdr.sock");
        let surfaced = leaked.surface(masked);
        assert_eq!(surfaced.to_string(), masked);
        assert!(!surfaced.surfaced());
    }
}
