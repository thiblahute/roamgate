//! The voice helper's events, sent in JSON frames ([`crate::frames`]):
//! `VoiceEvent` and `CallEvent` of server/src/voice/voice-helper.ts and
//! `VoiceTag` of server/src/voice/voice-speakers.ts.

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a [`VoiceEvent`] is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEventKind {
    SpeechStart,
    SpeechEnd,
    Text,
    Partial,
    Final,
    Error,
    /// A call's microphone came for the session: `bytes` of it.
    Audio,
    /// The session waits for the listening models to load (a helper just
    /// started), its audio heard once they are: `listen_ready`.
    ListenLoading,
    ListenReady,
}

/// What the helper says about a listening session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VoiceEvent {
    pub event: VoiceEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<u32>,
    /// On `audio`: how much came, as 16 kHz mono S16LE.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speech_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// On a partial: the words at a pause, which may end the utterance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pause: Option<bool>,
    /// On a partial at a pause: how far into it the words were read,
    /// whether the speaker sounds to be thinking ("euh"), and at
    /// speechgate's checks, how finished the voice (`turn`) and the words
    /// (`words`) sound, 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pause_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thinking: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub turn: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub words: Option<f64>,
    /// On a cleaned final: the words as heard, and whether to the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub for_agent: Option<bool>,
    /// On a final, with a speaker model: whose voice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice: Option<VoiceTag>,
    /// On a final relayed to a page: the voice's label for the companion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice_label: Option<String>,
    /// On a session's `error`: the helper stopped under it, and runs again
    /// from the next request. The session is over, nothing else is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recoverable: Option<bool>,
}

/// One voice heard in an utterance, and its share.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VoiceShare {
    pub id: String,
    pub share: f64,
}

/// What the helper says of an utterance's voices (a final's `voice`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VoiceTag {
    /// The set of voices its names belong to: a new one each call.
    pub voices: u32,
    /// The voice most heard, null when too little was heard to tell.
    /// Always there: null is written, and a missing one is refused.
    #[serde(deserialize_with = "crate::nullable")]
    #[schemars(with = "Option<String>")]
    pub id: Option<String>,
    /// That voice's share of the utterance's voice, 0 to 1.
    pub share: f64,
    pub mixed: bool,
    /// Each voice heard and its share, the most heard first.
    pub mix: Vec<VoiceShare>,
    /// How close the utterance is to each voice known, -1 to 1.
    pub similarity: IndexMap<String, f64>,
    /// Voices found to be one: gone name to kept name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub merged: Option<IndexMap<String, String>>,
    /// The utterance's print (the helper's; not sent on to the page).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub print: Option<Vec<f64>>,
    /// The print of each voice in it (likewise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prints: Option<IndexMap<String, Vec<f64>>>,
    /// Which utterance it is, for its print kept on the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub utterance: Option<u32>,
    /// Seconds of voice in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seconds: Option<f64>,
}

/// What the helper says of a call: its background or microphone failed,
/// it restarted, it ended, or its music waits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
#[ts(tag = "event", rename_all = "snake_case")]
pub enum CallEvent {
    CallError {
        call: u32,
        error: String,
    },
    /// The helper restarted: the call was made again, from time 0, with a
    /// new signalling server; the page's WebRTC sessions start again on it.
    CallRestarted {
        call: u32,
    },
    /// The call is over in the helper: it could not be made again after a
    /// restart, or the helper was stopped on purpose.
    CallEnded {
        call: u32,
        error: String,
    },
    /// The call's music waits, silent, while the helper learns a new
    /// speaker's voice (true), or may play again (false).
    CallMusic {
        call: u32,
        waiting: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_read_and_write_as_the_helper_sends_them() {
        let text = r#"{"event":"final","session":3,"text":"hi","voice":{"voices":1,"id":null,"share":0.5,"mixed":false,"mix":[{"id":"a","share":0.5}],"similarity":{"b":0.1,"a":0.9}}}"#;
        let event: VoiceEvent = serde_json::from_str(text).unwrap();
        assert_eq!(event.event, VoiceEventKind::Final);
        let voice = event.voice.as_ref().unwrap();
        assert_eq!(voice.id, None);
        // Key order kept, as the page sees it.
        assert_eq!(serde_json::to_string(&event).unwrap(), text);
        let call: CallEvent =
            serde_json::from_value(json!({"event": "call_music", "call": 2, "waiting": true}))
                .unwrap();
        assert_eq!(
            call,
            CallEvent::CallMusic {
                call: 2,
                waiting: true
            }
        );
        assert_eq!(
            serde_json::to_value(CallEvent::CallRestarted { call: 4 }).unwrap(),
            json!({"event": "call_restarted", "call": 4})
        );
        // A tag without its `id` is refused; a null one is fine.
        let tag = json!({"voices": 1, "share": 0.0, "mixed": false, "mix": [], "similarity": {}});
        assert!(serde_json::from_value::<VoiceTag>(tag).is_err());
        assert!(
            serde_json::from_value::<CallEvent>(
                json!({"event": "call_restarted", "call": 4, "x": 1})
            )
            .is_err()
        );
    }
}
