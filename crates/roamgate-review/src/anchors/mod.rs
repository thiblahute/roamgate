//! Where threads go when the code under them moves: Changes' per-entry
//! anchors onto the combined diff (changes), threads of a rewritten commit
//! onto what it became (commit), threads on a file's lines onto the lines
//! as the file reads now (file).

pub mod changes;
pub mod commit;
pub mod file;

use serde_json::{Map, Value};

use crate::model::ReviewAnchor;

/// The note a Changes or Files comment keeps on its anchor (`feedback`,
/// JSON), when it has one that is an object.
pub(crate) fn note_of(anchor: &ReviewAnchor) -> Option<Map<String, Value>> {
    let feedback = anchor.feedback.as_deref().filter(|text| !text.is_empty())?;
    match serde_json::from_str::<Value>(feedback).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// `JSON.stringify(note)`.
pub(crate) fn note_text(note: &Map<String, Value>) -> String {
    serde_json::to_string(note).unwrap_or_default()
}
