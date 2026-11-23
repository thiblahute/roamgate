//! Roamgate's wire and storage types (the Rust migration plan, sections 6.2
//! to 6.4): serde types exported to TypeScript with ts-rs and checked
//! against `contract/schemas`, and the voice helper's frame codec. No async
//! runtime and no OS calls, so the voice helper and the blocking Android
//! core use it as the server does.
//!
//! - [`frames`]: the voice helper's frames (u32 LE length, kind byte,
//!   payload), `contract/vectors/voice-frames.json`.
//! - [`forward`]: SSH port forwards as the browser sees them.
//! - [`voice`]: the voice helper's events.
//! - [`notify`]: task events of the notification feed.
//! - `vectors` (feature `vectors`, for tests): the reader of
//!   `contract/vectors/*.json`, the T0 cases `bun test` reads too.

pub mod forward;
pub mod frames;
pub mod notify;
/// A field that must be there but may be null (`x: T | null` in TS):
/// serde's `Option` alone would take a missing one as `None`.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer)
}

#[cfg(any(test, feature = "vectors"))]
pub mod vectors;
pub mod voice;
