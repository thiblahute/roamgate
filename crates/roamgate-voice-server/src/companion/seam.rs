//! The companion layer behind the voice socket's seam
//! ([`crate::socket::companion`]): the voice chat's cleaner, the dictation
//! cleaner and whether a front hears what is said, each read from
//! voice.json when the socket asks.

use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::{Map, Value};

use crate::companion::claude::ResolveCommand;
use crate::companion::cleaner::{CleanSession, ConfiguredCleaner, VoiceCleaner};
use crate::companion::dictation::{
    ConfiguredDictation, dictated, dictation_session, dictation_target,
};
use crate::companion::memory_files::CompanionMemoryFiles;
use crate::companion::research::ReadConfig;
use crate::helper::BoxFuture;
use crate::socket::companion::{self as seam, Cleaned, Dictated};

impl seam::CleanSession for CleanSession {
    fn partial(&self, text: &str, pause: bool) {
        CleanSession::partial(self, text, pause);
    }

    fn final_text(&self, text: &str) -> BoxFuture<Result<Cleaned, String>> {
        let session = self.clone();
        let text = text.to_owned();
        async move { Ok(session.final_text(&text).await) }.boxed()
    }

    fn close(&self) {
        CleanSession::close(self);
    }
}

impl seam::Cleaner for VoiceCleaner {
    fn warm(&self) {
        VoiceCleaner::warm(self);
    }

    fn session(&self, context: &str) -> Arc<dyn seam::CleanSession> {
        Arc::new(VoiceCleaner::session(self, context))
    }
}

/// One dictation's cleaning: its clean session, made from the listen
/// request's field and text.
struct DictationSession(CleanSession);

impl seam::DictationSession for DictationSession {
    fn partial(&self, whole: &str, pause: bool) {
        self.0.partial(whole, pause);
    }

    fn clean(&self, heard: &str) -> BoxFuture<Dictated> {
        let session = self.0.clone();
        let heard = heard.to_owned();
        async move { dictated(Some(&session), &heard).await }.boxed()
    }

    fn close(&self) {
        self.0.close();
    }
}

/// The dictation cleaner: the voice cleaner's sessions with dictation's
/// prompt (see [`ConfiguredDictation`]).
struct DictationCleaner(VoiceCleaner);

impl seam::DictationCleaner for DictationCleaner {
    fn warm(&self) {
        self.0.warm();
    }

    fn session(&self, listen: &Map<String, Value>) -> Arc<dyn seam::DictationSession> {
        Arc::new(DictationSession(dictation_session(
            &self.0,
            &dictation_target(listen),
        )))
    }
}

/// The companion layer as the voice socket sees it.
pub struct VoiceCompanion {
    config: ReadConfig,
    cleaner: ConfiguredCleaner,
    dictation: ConfiguredDictation,
}

impl VoiceCompanion {
    pub fn new(
        config: ReadConfig,
        cleaner: ConfiguredCleaner,
        dictation: ConfiguredDictation,
    ) -> Self {
        Self {
            config,
            cleaner,
            dictation,
        }
    }

    /// With real background sessions: `command` resolves voice.json's
    /// `claude_command`, `files` are the long-term memories dictation reads.
    pub fn spawning(
        config: ReadConfig,
        command: ResolveCommand,
        files: Option<CompanionMemoryFiles>,
    ) -> Self {
        Self::new(
            config,
            ConfiguredCleaner::spawning(command.clone()),
            ConfiguredDictation::spawning(files, command),
        )
    }
}

impl seam::Companion for VoiceCompanion {
    fn chat_cleaner(&self) -> Option<Arc<dyn seam::Cleaner>> {
        let config = (self.config)();
        let cleaner = self.cleaner.get(config.as_ref().map_err(String::as_str))?;
        Some(Arc::new(cleaner))
    }

    fn dictation_cleaner(&self) -> Option<Arc<dyn seam::DictationCleaner>> {
        let config = (self.config)();
        let cleaner = self
            .dictation
            .get(config.as_ref().map_err(String::as_str))?;
        Some(Arc::new(DictationCleaner(cleaner)))
    }

    fn fronted(&self) -> bool {
        (self.config)()
            .ok()
            .and_then(|config| config.str("front_model").map(|model| !model.is_empty()))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use crate::companion::claude::{ClaudeCommand, fake};
    use crate::config::VoiceConfig;
    use crate::socket::companion::Companion;

    use super::*;

    fn companion(value: Value, claude: &fake::Claude) -> VoiceCompanion {
        let spawn = claude.spawn();
        let dictation_spawn = claude.spawn();
        VoiceCompanion::new(
            Arc::new(move || {
                Ok(VoiceConfig {
                    raw: value.as_object().unwrap().clone(),
                })
            }),
            ConfiguredCleaner::new(
                Arc::new(move |_, _| spawn()),
                Arc::new(|_| ClaudeCommand::default()),
            ),
            ConfiguredDictation::new(
                None,
                Arc::new(move |_, _, _, _| dictation_spawn()),
                Arc::new(|_| ClaudeCommand::default()),
                crate::companion::dictation::claude_reader(),
            ),
        )
    }

    #[tokio::test]
    async fn the_socket_gets_the_cleaners_voice_json_sets_up() {
        let claude = fake::Claude::new(|_| r#"{"for_agent": true, "text": "Do it."}"#.into());
        let bare = companion(json!({"helper": "h", "dictation_model": "off"}), &claude);
        assert!(bare.chat_cleaner().is_none());
        assert!(bare.dictation_cleaner().is_none());
        assert!(!bare.fronted());
        let full = companion(
            json!({"helper": "h", "clean_model": "haiku", "front_model": "opus"}),
            &claude,
        );
        assert!(full.fronted());
        let session = full.chat_cleaner().unwrap().session("");
        assert_eq!(
            session.final_text("Um do it.").await.unwrap(),
            Cleaned {
                text: "Do it.".into(),
                for_agent: true
            }
        );
        let dictation = full
            .dictation_cleaner()
            .unwrap()
            .session(json!({"field": {"kind": "chat"}}).as_object().unwrap());
        assert_eq!(
            dictation.clean("um do it").await,
            Dictated {
                text: "Do it.".into(),
                cleaned: true
            }
        );
    }
}
