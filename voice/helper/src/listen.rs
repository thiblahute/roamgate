//! Listening: the browser's microphone streams in while the person speaks,
//! and one pipeline, kept playing, turns what they say into text:
//!
//! ```text
//! appsrc (16 kHz S16LE) ! audioconvert ! audioresample ! 48 kHz F32 !
//!   audiornnoise ! speechgate ! queue ! audioconvert ! audioresample !
//!   parakeettranscriber ! fakesink (probe: its text, and SEGMENT_DONE)
//! ```
//!
//! audiornnoise denoises and tells voice from noise; speechgate lets only
//! speech through, with the moment before it, and ends each utterance with
//! a SEGMENT_DONE when the speaker is done, judged by its turn models; the
//! transcriber then transcribes what it holds, without ending the stream,
//! and the text it gives for that utterance is the final one. Listening
//! goes in sessions, started, finished and stopped through speechgate's
//! action signals; what it decides comes back as its element messages.
//!
//! parakeettranscriber also posts what it heard so far as the speaker goes
//! on, and gives speechgate the words during a pause; whispertranscriber
//! can take its place, without either.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use gst::prelude::*;
use serde_json::{Value, json};

pub const RATE: i32 = 16_000;

const DEFAULT_END_SILENCE_MS: u64 = 2500;
/// Whisper guesses the language of short phrases poorly: below this much
/// speech, the session's language is used.
const SHORT_SPEECH_MS: u64 = 3000;
/// While someone speaks, parakeettranscriber reads the utterance again
/// after this much more speech, unless still busy with the last reading.
const PARTIAL_INTERVAL_MS: u32 = 800;

pub enum Command {
    /// A new session replaces the one before.
    Start {
        id: u32,
        hold: bool,
        end_silence_ms: Option<u64>,
        language: Option<String>,
        /// Forget the locked speaker: the next one to speak is kept.
        new_speaker: bool,
    },
    Audio {
        id: u32,
        samples: Vec<u8>,
    },
    /// A reply stopped playing: any voice counts again.
    Release {
        id: u32,
    },
    /// End the utterance now, as if the pause had come.
    Finish {
        id: u32,
    },
    Stop {
        id: u32,
    },
}

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// What turns an utterance into text.
pub enum Model<'a> {
    /// whisper.cpp's model, for whispertranscriber.
    Whisper(&'a str),
    /// The Parakeet TDT directory.
    Parakeet(&'a str),
}

/// An utterance sent to the transcriber, waiting for its SEGMENT_DONE.
struct Pending {
    id: u32,
    cancelled: bool,
    text: String,
    speech_ms: u64,
}

struct State {
    emit: Emit,
    pending: VecDeque<Pending>,
    /// The session listening, and whether its utterance is over.
    session: Option<u32>,
    done: bool,
    language: Option<String>,
    /// whispertranscriber, which takes the language as a property.
    whisper: Option<gst::Element>,
}

impl State {
    /// What the utterance in progress says so far, if still wanted.
    fn partial(&self, id: u32, text: &str, pause: bool) {
        if self
            .pending
            .back()
            .is_some_and(|pending| pending.id == id && !pending.cancelled)
        {
            (self.emit)(if pause {
                json!({"event": "partial", "session": id, "text": text.trim(), "pause": true})
            } else {
                json!({"event": "partial", "session": id, "text": text.trim()})
            });
        }
    }

    /// The transcriber's text, for the oldest utterance still being
    /// transcribed.
    fn text(&mut self, text: String) {
        if let Some(pending) = self.pending.front_mut() {
            pending.text.push_str(&text);
            if !pending.cancelled {
                (self.emit)(json!({
                    "event": "text",
                    "session": pending.id,
                    "text": text.trim(),
                }));
            }
        }
    }

    fn utterance_done(&mut self) {
        let Some(pending) = self.pending.pop_front() else {
            return;
        };
        if !pending.cancelled {
            (self.emit)(json!({
                "event": "final",
                "session": pending.id,
                "text": pending.text.split_whitespace().collect::<Vec<_>>().join(" "),
                "speech_ms": pending.speech_ms,
            }));
        }
    }

    /// One of speechgate's messages, or parakeettranscriber's partial
    /// reading; false for any other message.
    fn message(&mut self, structure: &gst::StructureRef) -> bool {
        let session = structure.get::<u32>("session").ok();
        match structure.name().as_str() {
            "speechgate-speech-start" => {
                let Some(id) = session else { return true };
                self.pending.push_back(Pending {
                    id,
                    cancelled: false,
                    text: String::new(),
                    speech_ms: 0,
                });
                // The guess applies to long speech; a hint, if any, is set
                // at the end for short speech.
                if let Some(whisper) = &self.whisper {
                    whisper.set_property("language", None::<&str>);
                }
                (self.emit)(json!({"event": "speech_start", "session": id}));
            }
            "speechgate-words" => {
                if let (Some(id), Ok(text)) = (session, structure.get::<String>("text")) {
                    self.partial(id, &text, true);
                }
            }
            "speechgate-speech-end" => {
                let speech_ms = structure.get::<u64>("speech-ms").unwrap_or(0);
                let cancelled = structure.get::<bool>("cancelled").unwrap_or(false);
                if self.session.is_some() && self.session == session {
                    self.done = true;
                }
                if let Some(whisper) = &self.whisper {
                    let language = self
                        .language
                        .as_deref()
                        .filter(|_| speech_ms < SHORT_SPEECH_MS);
                    whisper.set_property("language", language);
                }
                if let Some(pending) = self.pending.back_mut() {
                    pending.cancelled |= cancelled;
                    pending.speech_ms = speech_ms;
                    if !pending.cancelled {
                        (self.emit)(json!({"event": "speech_end", "session": pending.id}));
                    }
                }
            }
            "speechgate-nothing-said" => {
                let Some(id) = session else { return true };
                if self.session == Some(id) {
                    self.done = true;
                }
                (self.emit)(json!({"event": "final", "session": id, "text": "", "speech_ms": 0}));
            }
            "parakeet-partial" => {
                if let (Ok(text), Some(id)) = (
                    structure.get::<String>("text"),
                    self.pending.back().map(|pending| pending.id),
                ) {
                    self.partial(id, &text, false);
                }
            }
            _ => return false,
        }
        true
    }
}

pub struct Listener {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    gate: gst::Element,
    state: Arc<Mutex<State>>,
    /// The microphone's time line, continued across sessions.
    position: gst::ClockTime,
}

impl Listener {
    /// With `speaker_model`, only the voice of whoever speaks first counts.
    pub fn new(
        model: Model,
        speaker_model: Option<&str>,
        turn_model: Option<&str>,
        text_turn_model: Option<&str>,
        emit: Emit,
    ) -> Result<Self, String> {
        if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some() {
            // The gate's decisions, as the helper's other debug lines.
            gst::log::remove_default_log_function();
            gst::log::add_log_function(|category, level, _, _, _, _, message| {
                if category.name() == "speechgate"
                    && matches!(
                        level,
                        gst::DebugLevel::Error | gst::DebugLevel::Warning | gst::DebugLevel::Debug
                    )
                    && let Some(message) = message.get()
                {
                    eprintln!("[voice] {message}");
                }
            });
            gst::log::set_active(true);
            gst::log::set_threshold_for_name("speechgate", gst::DebugLevel::Debug);
        }
        let mut gate = String::from("speechgate name=gate");
        for (property, path) in [
            ("speaker-model", speaker_model),
            ("turn-model", turn_model),
            // Reading the words needs them before the end: Parakeet only.
            (
                "text-turn-model",
                text_turn_model.filter(|_| matches!(model, Model::Parakeet(_))),
            ),
        ] {
            if let Some(path) = path {
                gate.push_str(&format!(" {property}=\"{path}\""));
            }
        }
        let transcriber = match model {
            Model::Whisper(whisper_model) => format!(
                "whispertranscriber name=transcriber model-path=\"{whisper_model}\" \
                   model-preset=large-v3-turbo"
            ),
            Model::Parakeet(dir) => format!(
                "parakeettranscriber name=transcriber model-path=\"{dir}\" \
                   partial-interval={PARTIAL_INTERVAL_MS}"
            ),
        };
        // The queue lets the transcriber work on an utterance while the
        // gate goes on listening.
        let pipeline = gst::parse::launch(&format!(
            "appsrc name=src format=time \
               caps=audio/x-raw,format=S16LE,layout=interleaved,channels=1,rate={RATE} ! \
             audioconvert ! audioresample ! \
             audio/x-raw,format=F32LE,layout=interleaved,channels=1,rate=48000 ! \
             audiornnoise ! {gate} ! \
             queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! \
             audioconvert ! audioresample ! {transcriber} ! \
             fakesink name=sink sync=false async=false"
        ))
        .map_err(|e| e.to_string())?
        .downcast::<gst::Pipeline>()
        .unwrap();
        let src = pipeline
            .by_name("src")
            .unwrap()
            .downcast::<gst_app::AppSrc>()
            .unwrap();
        let gate = pipeline.by_name("gate").unwrap();
        let state = Arc::new(Mutex::new(State {
            emit,
            pending: VecDeque::new(),
            session: None,
            done: false,
            language: None,
            whisper: matches!(model, Model::Whisper(_))
                .then(|| pipeline.by_name("transcriber").unwrap()),
        }));

        let said = state.clone();
        pipeline
            .by_name("sink")
            .unwrap()
            .static_pad("sink")
            .unwrap()
            .add_probe(
                gst::PadProbeType::BUFFER | gst::PadProbeType::EVENT_DOWNSTREAM,
                move |_, info| {
                    match &info.data {
                        Some(gst::PadProbeData::Buffer(buffer)) => {
                            if let Ok(map) = buffer.map_readable() {
                                let text = String::from_utf8_lossy(&map).into_owned();
                                said.lock().unwrap().text(text);
                            }
                        }
                        Some(gst::PadProbeData::Event(event))
                            if event.type_() == gst::EventType::SegmentDone =>
                        {
                            said.lock().unwrap().utterance_done();
                        }
                        _ => {}
                    }
                    gst::PadProbeReturn::Ok
                },
            );
        // The gate's decisions, and the transcriber's partial readings, as
        // they are posted: from the streaming thread, or the transcriber's
        // own. The helper never calls into the pipeline holding the state.
        let decided = Arc::downgrade(&state);
        pipeline.bus().unwrap().set_sync_handler(move |_, message| {
            if let gst::MessageView::Element(element) = message.view()
                && let Some(structure) = element.structure()
                && let Some(state) = decided.upgrade()
                && state.lock().unwrap().message(structure)
            {
                return gst::BusSyncReply::Drop;
            }
            gst::BusSyncReply::Pass
        });
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| format!("listening failed to start: {e}"))?;
        crate::dump_dot(&pipeline, "roamgate-voice-listen");
        Ok(Self {
            pipeline,
            src,
            gate,
            state,
            position: gst::ClockTime::ZERO,
        })
    }

    /// An error the pipeline posted, if any.
    pub fn error(&self) -> Option<String> {
        if let Some(message) = self
            .pipeline
            .bus()
            .unwrap()
            .pop_filtered(&[gst::MessageType::Error])
            && let gst::MessageView::Error(err) = message.view()
        {
            return Some(format!("{}: {:?}", err.error(), err.debug()));
        }
        None
    }

    pub fn handle(&mut self, command: Command) {
        match command {
            Command::Start {
                id,
                hold,
                end_silence_ms,
                language,
                new_speaker,
            } => {
                // Audio has gone through by the next session: the caps are
                // known.
                crate::dump_dot(&self.pipeline, "roamgate-voice-listen");
                {
                    let mut state = self.state.lock().unwrap();
                    state.session = Some(id);
                    state.done = false;
                    state.language = language.filter(|l| l.len() == 2);
                }
                self.gate.set_property("hold", hold);
                self.gate.set_property(
                    "end-silence",
                    end_silence_ms.unwrap_or(DEFAULT_END_SILENCE_MS),
                );
                // What the previous session was saying is not wanted any
                // more: the gate ends it cancelled.
                self.gate.emit_by_name::<()>("start", &[&id, &new_speaker]);
            }
            Command::Audio { id, samples } => {
                {
                    let state = self.state.lock().unwrap();
                    if state.session != Some(id) || state.done || samples.len() < 2 {
                        return;
                    }
                }
                let duration = gst::ClockTime::from_nseconds(
                    (samples.len() as u64 / 2) * gst::ClockTime::SECOND.nseconds() / RATE as u64,
                );
                let mut buffer = gst::Buffer::from_mut_slice(samples);
                {
                    let buffer = buffer.get_mut().unwrap();
                    buffer.set_pts(self.position);
                    buffer.set_duration(duration);
                }
                self.position += duration;
                let _ = self.src.push_buffer(buffer);
            }
            Command::Release { id } => {
                if self.state.lock().unwrap().session == Some(id) {
                    self.gate.set_property("hold", false);
                }
            }
            Command::Finish { id } => {
                let active = {
                    let state = self.state.lock().unwrap();
                    state.session == Some(id) && !state.done
                };
                if active {
                    self.gate.emit_by_name::<()>("finish", &[]);
                }
            }
            Command::Stop { id } => {
                let current = self.state.lock().unwrap().session == Some(id);
                if current {
                    self.gate.emit_by_name::<()>("stop", &[]);
                    self.state.lock().unwrap().session = None;
                }
            }
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use gst::prelude::*;

    /// speechgate as in a gst-launch line, without the application: what
    /// SPEECH_WAV says, with the models of PARAKEET_DIR and TURN_MODEL.
    #[test]
    #[ignore]
    fn continuous_pipeline() {
        gst::init().unwrap();
        gstparakeet::plugin_register_static().unwrap();
        gstspeechgate::plugin_register_static().unwrap();
        gstrsaudiofx::plugin_register_static().unwrap();
        let var = |name| std::env::var(name).unwrap();
        let pipeline = gst::parse::launch(&format!(
            "filesrc location=\"{}\" ! wavparse ! audioconvert ! audioresample ! \
             audio/x-raw,format=F32LE,channels=1,rate=48000 ! audiornnoise ! \
             speechgate continuous=true turn-model=\"{}\" ! audioconvert ! audioresample ! \
             parakeettranscriber model-path=\"{}\" ! appsink name=sink sync=false",
            var("SPEECH_WAV"),
            var("TURN_MODEL"),
            var("PARAKEET_DIR")
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let sink = pipeline
            .by_name("sink")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        let mut texts = Vec::new();
        while let Ok(sample) = sink.pull_sample() {
            let map = sample.buffer().unwrap().map_readable().unwrap();
            texts.push(String::from_utf8_lossy(&map).into_owned());
        }
        pipeline.set_state(gst::State::Null).unwrap();
        println!("{texts:?}");
        assert!(!texts.is_empty());
    }
}
