//! The voice helper as the socket uses it: listening sessions, calls and
//! the speakers' labels. [`VoiceHelper`] implements it; the socket's tests
//! give a fake, as voice-socket.test.ts does.

use std::sync::Arc;

use serde_json::Value;

use crate::config::CallBackground;
use crate::helper::{
    BoxFuture, CallHandle, EventSink, ListenOptions, MusicChange, VoiceHelper, VoiceSession,
};
use crate::speakers::parse_voice_tag;

/// A listening session (VoiceSession).
pub trait Listen: Send + Sync {
    fn id(&self) -> u64;
    /// 16 kHz mono S16LE samples.
    fn audio(&self, samples: &[u8]);
    /// The reply stopped playing: any voice counts again.
    fn release(&self);
    /// End the utterance now.
    fn finish(&self);
    fn stop(&self);
}

/// A call the helper runs (CallHandle).
pub trait CallLine: Send + Sync {
    fn id(&self) -> u64;
    /// Whether the call has a background, on or off.
    fn music(&self) -> bool;
    fn music_on(&self) -> bool;
    fn music_waiting(&self) -> bool;
    /// Where its signalling server listens on 127.0.0.1 now; 0 for none.
    fn signalling_port(&self) -> u64;
    /// Listens to a microphone producer; `echo_here` when the helper
    /// cancels the replies' echo.
    fn microphone(&self, peer: &str, echo_here: bool) -> BoxFuture<Result<(), String>>;
    fn hush(&self);
    /// The music's level and whether it is off (the music route).
    fn music_level(&self, change: MusicChange) -> BoxFuture<Result<(f64, bool), String>>;
    fn stop(&self);
}

/// What the socket asks of the voice helper.
pub trait SocketHelper: Send + Sync {
    fn listen(
        &self,
        on_event: EventSink,
        options: ListenOptions,
    ) -> Result<Arc<dyn Listen>, String>;
    fn start_call(
        &self,
        background: CallBackground,
        on_event: EventSink,
    ) -> BoxFuture<Result<Arc<dyn CallLine>, String>>;
    /// A final's voice as the page shows it (voice-speakers.ts label).
    fn voice_label(&self, voice: &Value) -> String;
    /// Whether a final's voice is clearly not the user's.
    fn is_other_voice(&self, voice: &Value) -> bool;
}

impl Listen for VoiceSession {
    fn id(&self) -> u64 {
        self.id
    }

    fn audio(&self, samples: &[u8]) {
        VoiceSession::audio(self, samples);
    }

    fn release(&self) {
        VoiceSession::release(self);
    }

    fn finish(&self) {
        VoiceSession::finish(self);
    }

    fn stop(&self) {
        VoiceSession::stop(self);
    }
}

impl CallLine for CallHandle {
    fn id(&self) -> u64 {
        self.id
    }

    fn music(&self) -> bool {
        self.music
    }

    fn music_on(&self) -> bool {
        CallHandle::music_on(self)
    }

    fn music_waiting(&self) -> bool {
        CallHandle::music_waiting(self)
    }

    fn signalling_port(&self) -> u64 {
        CallHandle::signalling_port(self)
    }

    fn microphone(&self, peer: &str, echo_here: bool) -> BoxFuture<Result<(), String>> {
        let handle = self.clone();
        let peer = peer.to_owned();
        Box::pin(async move { handle.microphone(&peer, echo_here).await })
    }

    fn hush(&self) {
        CallHandle::hush(self);
    }

    fn music_level(&self, change: MusicChange) -> BoxFuture<Result<(f64, bool), String>> {
        let handle = self.clone();
        Box::pin(async move { handle.music_level(change).await })
    }

    fn stop(&self) {
        CallHandle::stop(self);
    }
}

impl SocketHelper for VoiceHelper {
    fn listen(
        &self,
        on_event: EventSink,
        options: ListenOptions,
    ) -> Result<Arc<dyn Listen>, String> {
        VoiceHelper::listen(self, on_event, options).map(|session| Arc::new(session) as _)
    }

    fn start_call(
        &self,
        background: CallBackground,
        on_event: EventSink,
    ) -> BoxFuture<Result<Arc<dyn CallLine>, String>> {
        let helper = self.clone();
        Box::pin(async move {
            helper
                .start_call(background, on_event)
                .await
                .map(|handle| Arc::new(handle) as _)
        })
    }

    fn voice_label(&self, voice: &Value) -> String {
        self.speakers().label(parse_voice_tag(voice).as_ref())
    }

    fn is_other_voice(&self, voice: &Value) -> bool {
        self.speakers().is_other(parse_voice_tag(voice).as_ref())
    }
}
