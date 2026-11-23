//! The session archive (Rust migration plan, section 6.2; server/src/archive
//! as it is after the archive's step 5): agent sessions copied from this
//! machine and pulled from ssh hosts (or pushed to an archive home),
//! compressed as zstd frames under `raw/` (the record, never deleted),
//! their bookkeeping in `archive.sqlite`, their conversation text rendered
//! into the `text.git` repo that search greps.
//!
//! | Module | What | TS it replaces |
//! |---|---|---|
//! | [`settings`] | `archive` in settings.json | archive/settings |
//! | [`dir`] | where the archive lives | archive/dir |
//! | [`hosts`] | hosts, rsync and ssh | archive/hosts |
//! | [`lock`] | one sync per host | archive/lock |
//! | [`zstd_frames`] | appended, verified frames | archive/zstd |
//! | [`lines`] | complete lines | archive/lines |
//! | [`store`] | archive.sqlite, the old index migrated | archive/store |
//! | [`sync`] and [`engine`] | sync, ingest, push, rebuild-db | archive/sync, archive/engine |
//! | [`session`] | lookup, cat, resume | archive/session |
//! | [`open`] | a hit's records | archive/open |
//! | [`file_access`] | deleted transcripts read back | archive/file-access |
//! | [`health`] | health | archive/health |
//! | [`text_render`], [`text_repo`] | the text repo and its passes | archive/text-render, archive/text-repo |
//! | [`text_search`], [`search`] | git grep search, raw/ search | archive/text-search, archive/search |
//! | [`rpc`] | the search view's parameters | archive/rpc |

pub mod dir;
pub mod engine;
pub mod file_access;
pub mod health;
pub mod hosts;
pub mod lines;
pub mod lock;
pub mod open;
pub mod rpc;
pub mod search;
pub mod session;
pub mod settings;
pub mod store;
pub mod sync;
pub mod text_render;
pub mod text_repo;
pub mod text_search;
pub mod zstd_frames;

use std::path::Path;

/// An archive error: its message (as the Bun server words it where it
/// can), and a code for the errors callers tell apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub message: String,
    pub code: Option<&'static str>,
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub fn with_code(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

/// An io error's message without Rust's ` (os error N)` suffix.
pub fn io_message(error: &std::io::Error) -> String {
    let text = error.to_string();
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::msg(io_message(&error))
    }
}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::msg(error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::msg(error.to_string())
    }
}

/// Why a pull failed: an unreachable host is recorded and skipped.
#[derive(Debug, Clone)]
pub enum PullError {
    Unreachable(hosts::UnreachableHost),
    Other(String),
}

impl std::fmt::Display for PullError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PullError::Unreachable(hosts::UnreachableHost(message)) | PullError::Other(message) => {
                f.write_str(message)
            }
        }
    }
}

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// `new Date(ms).toISOString()`.
pub fn iso_ms(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(|timestamp| timestamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    iso_ms(now_ms())
}

/// `Date.parse(text)` for the ISO timestamps the archive writes (with or
/// without fraction and zone): milliseconds, or None.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    if let Ok(timestamp) = text.parse::<jiff::Timestamp>() {
        return Some(timestamp.as_millisecond());
    }
    // A date and time without a zone is local time in JavaScript.
    let civil = text.parse::<jiff::civil::DateTime>().ok()?;
    let zoned = civil.to_zoned(jiff::tz::TimeZone::system()).ok()?;
    Some(zoned.timestamp().as_millisecond())
}

/// Writes a whole file with mode 0600.
pub fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_javascript_s() {
        assert_eq!(iso_ms(1_767_225_600_123), "2026-01-01T00:00:00.123Z");
        assert_eq!(
            parse_iso_ms("2026-01-01T00:00:00.123Z"),
            Some(1_767_225_600_123)
        );
        assert_eq!(
            parse_iso_ms("2026-01-01T00:00:00+00:00"),
            Some(1_767_225_600_000)
        );
        assert_eq!(parse_iso_ms("nope"), None);
    }
}
