//! The Voice settings' setup assistant (http/voice-setup.ts):
//!
//!   GET  /api/voice/setup         the hardware, the choices, the download
//!   POST /api/voice/setup         {choices}: download them, write voice.json
//!   POST /api/voice/setup/cancel  stop the download (resumed next time)
//!   POST /api/voice/setup/remove  {ids}: delete unused models
//!
//! The POSTs need the voice header, as the other voice changes do. Every
//! answer is sent `cache-control: no-store`.

use serde_json::{Map, Value, json};

use super::{Answer, Request, needs_header};
use crate::js;
use crate::models::{VOICE_COMPONENTS, VoiceChoices};
use crate::setup::VoiceSetupRunner;

/// `{choices}` as the request gives them: a model id for known parts.
fn choices_from(value: Option<&Value>) -> Option<VoiceChoices> {
    let Some(Value::Object(entries)) = value else {
        return None;
    };
    let mut choices = VoiceChoices::new();
    for (key, choice) in entries {
        if !VOICE_COMPONENTS.contains(&key.as_str()) {
            return None;
        }
        let choice = choice.as_str().filter(|choice| !choice.is_empty())?;
        choices.insert(key.clone(), choice.to_owned());
    }
    Some(choices)
}

/// The assistant's routes (createVoiceSetupRoute).
pub struct SetupRoute {
    runner: VoiceSetupRunner,
}

impl SetupRoute {
    pub fn new(runner: VoiceSetupRunner) -> Self {
        Self { runner }
    }

    /// The answer for `request`, None when it is not one of these routes.
    pub fn handle(&self, request: &Request) -> Option<Answer> {
        let path = request.path.as_str();
        if path == "/api/voice/setup" && request.method == "GET" {
            return Some(
                match self.runner.state() {
                    Ok(state) => Answer::json(200, state),
                    Err(message) => Answer::error(500, message),
                }
                .no_store(),
            );
        }
        if !path.starts_with("/api/voice/setup") || request.method != "POST" {
            return None;
        }
        if !request.has_voice_header() {
            return Some(needs_header().no_store());
        }
        let body = request.json_body();
        let field = |key: &str| {
            body.as_ref()
                .and_then(Value::as_object)
                .and_then(|body| body.get(key))
        };
        let answer = match path {
            "/api/voice/setup" => {
                let Some(choices) = choices_from(field("choices")) else {
                    return Some(
                        Answer::error(400, "choices must name a model for each part").no_store(),
                    );
                };
                self.runner
                    .start(&choices)
                    .and_then(|_| self.runner.state())
                    .map(|state| Answer::json(202, state))
            }
            "/api/voice/setup/cancel" => {
                self.runner.cancel();
                self.runner.state().map(|state| Answer::json(200, state))
            }
            "/api/voice/setup/remove" => {
                let ids = match field("ids") {
                    Some(Value::String(all)) if all == "all" => None,
                    Some(Value::Array(ids)) if ids.iter().all(Value::is_string) => Some(
                        ids.iter()
                            .filter_map(|id| id.as_str().map(str::to_owned))
                            .collect::<Vec<_>>(),
                    ),
                    _ => {
                        return Some(
                            Answer::error(400, "ids must be a list of model ids, or \"all\"")
                                .no_store(),
                        );
                    }
                };
                self.runner
                    .remove_unused(ids.as_deref())
                    .and_then(|(_, freed)| {
                        let mut state = match self.runner.state()? {
                            Value::Object(state) => state,
                            _ => Map::new(),
                        };
                        state.insert("freedBytes".into(), js::number(freed));
                        Ok(Answer::json(200, Value::Object(state)))
                    })
            }
            _ => return None,
        };
        Some(
            answer
                .unwrap_or_else(|message| {
                    let status = if self.runner.running() { 409 } else { 400 };
                    Answer::json(status, json!({ "error": message }))
                })
                .no_store(),
        )
    }
}

#[cfg(test)]
mod tests;
