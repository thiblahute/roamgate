//! What a session's lines left it in (`session-resume.ts`), saved with
//! where they end in the holder's log: a runtime after this one (a
//! Roamgate restart) takes it up there and reads only the lines after,
//! instead of every line of the process again.
//!
//! The state is Bun's object (`ConversationResumeState`), its keys in
//! Bun's order: `version` (1), `turn`, `compacting`, `activity`,
//! `last_block`, `tools`, `tasks`, `prompts` (the permissions and questions
//! not answered yet, asked again), `next_prompt`, `streamed` (the reply
//! text of the turn that runs), `turn_uuid`, `respawned_for_queue`,
//! `taken`, `recent` (`[uuid, {text, images}]` pairs), `parser` (the
//! driver's codec state).

use roamgate_agents::js;
use serde_json::Value;

use crate::shared::Obj;

/// Past this (UTF-16 units of its JSON text), a saved state is not kept:
/// its lines are read again.
pub const MAX_RESUME_BYTES: usize = 1024 * 1024;

/// A saved state as it was written, or None when it is not one.
pub fn resume_state_of(value: &Value) -> Option<&Obj> {
    let state = value.as_object()?;
    let array = |key: &str| state.get(key).is_some_and(Value::is_array);
    let ok = state.get("version").and_then(Value::as_f64) == Some(1.0)
        && state.get("turn").is_some_and(Value::is_boolean)
        && array("tools")
        && array("tasks")
        && array("prompts")
        && array("streamed")
        && array("taken")
        && array("recent")
        && state
            .get("parser")
            .is_some_and(|parser| parser.is_object() || parser.is_array());
    ok.then_some(state)
}

/// The state to save, or None when it is too large to keep.
pub fn kept_resume_state(state: Obj) -> Option<Obj> {
    let value = Value::Object(state);
    if js::len16(&js::stringify(&value)) > MAX_RESUME_BYTES {
        return None;
    }
    match value {
        Value::Object(state) => Some(state),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn state() -> Value {
        json!({
            "version": 1, "turn": true, "compacting": false, "activity": null,
            "last_block": null, "tools": [], "tasks": [], "prompts": [],
            "next_prompt": null, "streamed": [], "turn_uuid": null,
            "respawned_for_queue": false, "taken": [], "recent": [], "parser": {},
        })
    }

    #[test]
    fn a_saved_state_is_read_back_and_a_huge_one_is_not_kept() {
        assert!(resume_state_of(&state()).is_some());
        let mut wrong = state();
        wrong["version"] = json!(2);
        assert!(resume_state_of(&wrong).is_none());
        let mut no_parser = state();
        no_parser["parser"] = Value::Null;
        assert!(resume_state_of(&no_parser).is_none());
        let kept = kept_resume_state(state().as_object().unwrap().clone());
        assert!(kept.is_some());
        let mut huge = state();
        huge["streamed"] = json!([{"text": "x".repeat(MAX_RESUME_BYTES)}]);
        assert!(kept_resume_state(huge.as_object().unwrap().clone()).is_none());
    }
}
