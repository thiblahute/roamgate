//! `UserError`: a failure whose message is safe and useful to show the
//! user and the model (the TS `AssistantUserError`, which mr-reviews and the
//! voice tools also use as a generic user error, plan section 7 item 7).
//! Everything else is masked behind a generic message, since it may carry
//! transport details such as socket paths or credentials.
//!
//! On the browser RPC an error reply is `{"message": ...}`, with a `code`
//! for the errors the page acts on (`review_gone`, `image_gone`...).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct UserError {
    pub message: String,
    /// A code the page acts on; absent from the reply when None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl UserError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
        }
    }

    /// The `error` object of an RPC reply.
    pub fn reply(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// A user error as it is, any other error replaced by `masked`
/// (surfaceAssistantUserError): masked errors carry neither the original
/// message nor its source.
pub fn surface(error: &(dyn std::error::Error + 'static), masked: &str) -> UserError {
    match error.downcast_ref::<UserError>() {
        Some(user) => user.clone(),
        None => UserError::new(masked),
    }
}

/// [`surface`] for an `anyhow`-like boxed error.
pub fn surface_boxed(
    error: &(dyn std::error::Error + Send + Sync + 'static),
    masked: &str,
) -> UserError {
    match error.downcast_ref::<UserError>() {
        Some(user) => user.clone(),
        None => UserError::new(masked),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_errors_surface_and_others_are_masked() {
        let user = UserError::new("There is no session archive yet.");
        assert_eq!(surface(&user, "Archive search failed."), user);
        let io = std::io::Error::other("/run/user/1000/secret.sock refused");
        assert_eq!(
            surface(&io, "Archive search failed.").message,
            "Archive search failed."
        );
        let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(user.clone());
        assert_eq!(surface_boxed(boxed.as_ref(), "x"), user);
    }

    #[test]
    fn the_reply_carries_a_code_only_when_there_is_one() {
        assert_eq!(
            UserError::new("gone").reply(),
            serde_json::json!({"message": "gone"})
        );
        assert_eq!(
            UserError::with_code("gone", "review_gone").reply(),
            serde_json::json!({"message": "gone", "code": "review_gone"})
        );
    }
}
