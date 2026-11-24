//! The server's logger, as Bun's voice modules each take a child of
//! `serverLogger` (`voice`, `voice-youtube`): set once by the server that
//! runs the voice family; silent until then (tests, the CLI).

use std::sync::RwLock;

use roamgate_base::log::{LogFields, Logger};
use serde_json::json;

static SERVER_LOG: RwLock<Option<Logger>> = RwLock::new(None);

/// The server's logger (scope `bridge`), for the voice modules' lines.
pub fn set_server_logger(log: Logger) {
    *SERVER_LOG.write().unwrap_or_else(|e| e.into_inner()) = Some(log);
}

/// `serverLogger.child(child)`.
pub(crate) fn server_log(child: &str) -> Logger {
    SERVER_LOG
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or_else(Logger::silent, |log| log.child(child))
}

/// `{error: String(error)}`.
pub(crate) fn error_fields(error: impl std::fmt::Display) -> LogFields {
    let mut fields = LogFields::new();
    fields.insert("error".into(), json!(error.to_string()));
    fields
}
