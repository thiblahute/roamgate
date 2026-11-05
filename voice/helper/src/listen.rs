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
//! With a speaker model, speechgate keeps one voice: the first 2 s of
//! voice it hears after a session with `new_speaker` (or the first session,
//! the gate knowing none) become the speaker's, whatever they are (music, a
//! reply, someone else). The listener counts the voice the gate's check
//! takes in, as it does, to know when that voice is taken
//! (`learning_voice`): a call's music waits until then. With the speaker's
//! own recordings (`--speaker-reference`), it hears those first instead, a
//! second from each in turn (one per language they speak: a voice scores
//! lower against itself in another language), in a session of its own that
//! is stopped at once, so none of it is transcribed.
//!
//! parakeettranscriber also posts what it heard so far as the speaker goes
//! on, and gives speechgate the words during a pause; whispertranscriber
//! can take its place, without either. It keeps the words two of those
//! readings agree on and reads only what follows: read whole each time, a
//! long utterance was written, erased and written again, as the model
//! followed a voice in the background (music with singing) in some
//! readings, and the final text could be a short phrase of its words.

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

/// The speaker's reference recordings are heard by the gate in pieces this
/// long, taken from each recording in turn (the voice in each language it
/// is given in), with REFERENCE_GAP between them: a piece is a stretch of
/// voice to speechgate.
const REFERENCE_PIECE: usize = RATE as usize;
const REFERENCE_GAP: usize = RATE as usize * 2 / 5;
/// At most this much of them is heard.
const REFERENCE_MAX: usize = RATE as usize * 8;
/// The session the reference is heard in, before any real one.
const ENROLLING: u32 = u32::MAX;
/// What speechgate takes a new speaker's voice from without their
/// recordings: the first 2 s of voice it checks (its ENROLL_VOICE), here at
/// the gate's 48 kHz.
const ENROLL_VOICE: u64 = 2 * 48_000;
/// speechgate's speaker check decides a stretch of voice after this much
/// quiet, or once it holds this much voice (its STRETCH_GAP, STRETCH_MAX).
const STRETCH_GAP: u64 = 48_000 * 3 / 10;
const STRETCH_MAX: u64 = 48_000;

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

/// The audio of the file at `path` (anything GStreamer decodes), 16 kHz
/// mono.
fn decode(path: &str) -> Result<Vec<f32>, String> {
    let pipeline = gst::parse::launch(&format!(
        "filesrc location=\"{}\" ! decodebin ! audioconvert ! audioresample ! \
         audio/x-raw,format=F32LE,layout=interleaved,channels=1,rate={RATE} ! \
         appsink name=sink sync=false",
        path.replace('"', "\\\"")
    ))
    .map_err(|e| format!("{path}: {e}"))?
    .downcast::<gst::Pipeline>()
    .unwrap();
    let sink = pipeline
        .by_name("sink")
        .unwrap()
        .downcast::<gst_app::AppSink>()
        .unwrap();
    let failed = |pipeline: &gst::Pipeline| {
        pipeline
            .bus()
            .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]))
            .and_then(|message| match message.view() {
                gst::MessageView::Error(e) => Some(format!("{path}: {}", e.error())),
                _ => None,
            })
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        let error = failed(&pipeline).unwrap_or_else(|| format!("{path}: could not be read"));
        let _ = pipeline.set_state(gst::State::Null);
        return Err(error);
    }
    let mut samples = Vec::new();
    let result = loop {
        if let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(100)) {
            if let Some(map) = sample.buffer().and_then(|b| b.map_readable().ok()) {
                samples.extend(
                    map.chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                );
            }
            continue;
        }
        if sink.is_eos() {
            break Ok(samples);
        }
        if let Some(error) = failed(&pipeline) {
            break Err(error);
        }
    };
    let _ = pipeline.set_state(gst::State::Null);
    result
}

/// The speaker's reference recordings, as the gate hears them first: 1 s
/// pieces of their voice (their silences left out), from each recording
/// in turn, with a short pause between, REFERENCE_MAX of it at most; 16 kHz
/// mono S16LE.
pub fn reference_voice(paths: &[String]) -> Result<Vec<u8>, String> {
    // 20 ms windows quieter than this (RMS) are silence.
    const QUIET: f32 = 0.01;
    let window = RATE as usize / 50;
    let mut voices = Vec::new();
    for path in paths {
        let samples = decode(path)?;
        let voiced: Vec<f32> = samples
            .chunks(window)
            .filter(|chunk| {
                (chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32).sqrt() >= QUIET
            })
            .flatten()
            .copied()
            .collect();
        if voiced.len() < REFERENCE_PIECE {
            return Err(format!("{path}: less than a second of voice"));
        }
        voices.push(voiced);
    }
    let mut out: Vec<i16> = Vec::new();
    let mut taken = 0;
    let mut at = 0;
    while taken < REFERENCE_MAX {
        let pieces: Vec<&[f32]> = voices
            .iter()
            .filter_map(|voice| voice.get(at..(at + REFERENCE_PIECE).min(voice.len())))
            .filter(|piece| piece.len() >= REFERENCE_PIECE / 2)
            .collect();
        if pieces.is_empty() {
            break;
        }
        for piece in pieces {
            out.extend(piece.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
            out.extend(std::iter::repeat_n(0, REFERENCE_GAP));
            taken += piece.len();
        }
        at += REFERENCE_PIECE;
    }
    // The last piece ends as a stretch of voice does: with quiet after it.
    out.extend(std::iter::repeat_n(0, REFERENCE_GAP));
    Ok(out.iter().flat_map(|s| s.to_le_bytes()).collect())
}

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
    /// The session after a new speaker: its first words are where the
    /// speaker's voice was taken from, said in the log.
    enrolling: Option<u32>,
    /// The session listening, and whether its utterance is over.
    session: Option<u32>,
    done: bool,
    language: Option<String>,
    /// whispertranscriber, which takes the language as a property.
    whisper: Option<gst::Element>,
}

impl State {
    /// What the utterance in progress says so far, if still wanted; at a
    /// pause, what the gate made of it (`speechgate-words`).
    fn partial(&self, id: u32, text: &str, pause: Option<&gst::StructureRef>) {
        if self
            .pending
            .back()
            .is_some_and(|pending| pending.id == id && !pending.cancelled)
        {
            let mut event = json!({"event": "partial", "session": id, "text": text.trim()});
            if let Some(words) = pause {
                event["pause"] = json!(true);
                if let Ok(ms) = words.get::<u64>("pause-ms") {
                    event["pause_ms"] = json!(ms);
                }
                if let Ok(thinking) = words.get::<bool>("thinking") {
                    event["thinking"] = json!(thinking);
                }
                for (field, key) in [("turn", "turn"), ("words", "words")] {
                    if let Ok(score) = words.get::<f64>(field) {
                        event[key] = json!((score * 1000.0).round() / 1000.0);
                    }
                }
            }
            (self.emit)(event);
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

    /// The oldest utterance being transcribed: the transcriber is done
    /// with it.
    fn utterance_ended(&mut self) -> Option<Pending> {
        self.pending.pop_front()
    }

    /// An utterance's final text, unless it was cancelled.
    fn deliver(&mut self, pending: Pending) {
        if !pending.cancelled {
            if self.enrolling == Some(pending.id) {
                self.enrolling = None;
                if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some() {
                    eprintln!(
                        "[voice] session {}: the speaker's voice was taken from: {}",
                        pending.id,
                        pending.text.trim()
                    );
                }
            }
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
                    self.partial(id, &text, Some(structure));
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
                    } else {
                        // No final comes for it: the call's music must
                        // not stay ducked (main.rs keeps this one in).
                        (self.emit)(json!({"event": "speech_cancelled", "session": pending.id}));
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
                    self.partial(id, &text, None);
                }
            }
            _ => return false,
        }
        true
    }
}

/// What the transcriber heard (16 kHz mono), utterance by utterance, for
/// Whisper to hear it again (reread.rs): the utterance it is fed, and those
/// it ended (SEGMENT_DONE) whose text has not come out yet.
#[derive(Default)]
struct Heard {
    feeding: Vec<f32>,
    ended: VecDeque<Vec<f32>>,
}

/// The voice the gate's speaker check took in so far, counted as it does:
/// RNNoise's voiced buffers, in stretches decided after STRETCH_GAP of quiet
/// or STRETCH_MAX of voice (48 kHz samples).
#[derive(Default)]
struct VoiceHeard {
    /// Voice of the stretches decided.
    checked: u64,
    stretch: u64,
    quiet: u64,
}

impl VoiceHeard {
    fn heard(&mut self, samples: u64, voiced: bool) {
        if voiced {
            self.stretch += samples;
            self.quiet = 0;
        } else if self.stretch > 0 {
            self.quiet += samples;
        }
        if self.stretch > 0 && (self.quiet >= STRETCH_GAP || self.stretch >= STRETCH_MAX) {
            self.checked += self.stretch;
            self.stretch = 0;
            self.quiet = 0;
        }
    }

    /// A session starts: the gate forgets the stretch waiting.
    fn restart(&mut self) {
        self.stretch = 0;
        self.quiet = 0;
    }
}

pub struct Listener {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    gate: gst::Element,
    state: Arc<Mutex<State>>,
    /// The microphone's time line, continued across sessions.
    position: gst::ClockTime,
    holds: Holds,
    /// The speaker's voice, from their recordings (16 kHz mono S16LE, in
    /// pieces): heard first whenever a new speaker is to be taken, so the
    /// voice kept is theirs, never the first sound heard.
    reference: Option<Vec<u8>>,
    /// Samples the gate got so far (48 kHz), to know when it heard the
    /// reference.
    gate_heard: Arc<std::sync::atomic::AtomicU64>,
    /// The voice the gate's speaker check took in, and how much of it it
    /// had when a new speaker came while their voice is learnt from what is
    /// heard: the first ENROLL_VOICE becomes theirs.
    voice_heard: Arc<Mutex<VoiceHeard>>,
    learning: Option<u64>,
    /// Whether the gate keeps one voice (a speaker model).
    speaker_check: bool,
    /// No session started yet: the gate knows no voice.
    fresh: bool,
}

/// Why the gate holds: a reply plays (the session's `hold`, until
/// released), or the call's music is heard at the page. The microphone
/// hears either, and only a louder voice, held longer, starts an utterance.
#[derive(Default)]
struct Holds {
    reply: bool,
    music: bool,
}

impl Holds {
    fn held(&self) -> bool {
        self.reply || self.music
    }
}

impl Listener {
    /// With `speaker_model`, only the voice of whoever speaks first counts.
    /// With a turn model, a pause of `give_up_ms` ends the utterance
    /// whatever the models say (speechgate's own 5 s without it).
    pub fn new(
        model: Model,
        speaker_model: Option<&str>,
        turn_model: Option<&str>,
        text_turn_model: Option<&str>,
        reference: Option<Vec<u8>>,
        give_up_ms: Option<u64>,
        reread: Option<Arc<crate::reread::Reread>>,
        emit: Emit,
    ) -> Result<Self, String> {
        // Whisper reads again what Parakeet wrote in English.
        let reread = reread.filter(|_| matches!(model, Model::Parakeet(_)));
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
        let gate_heard = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let voice_heard: Arc<Mutex<VoiceHeard>> = Arc::default();
        {
            let heard = gate_heard.clone();
            let voice = voice_heard.clone();
            gate.static_pad("sink").unwrap().add_probe(
                gst::PadProbeType::BUFFER,
                move |_, info| {
                    if let Some(buffer) = info.buffer() {
                        let samples = buffer.size() as u64 / 4;
                        heard.fetch_add(samples, std::sync::atomic::Ordering::SeqCst);
                        // RNNoise's verdict, as the gate reads it.
                        let voiced = buffer
                            .meta::<gst_audio::AudioLevelMeta>()
                            .is_some_and(|meta| meta.voice_activity());
                        voice.lock().unwrap().heard(samples, voiced);
                    }
                    gst::PadProbeReturn::Ok
                },
            );
        }
        // A speechgate without it keeps its own 5 s.
        if let Some(ms) = give_up_ms
            && gate.find_property("give-up").is_some()
        {
            gate.set_property("give-up", ms);
        }
        // A parakeettranscriber without it reads the utterance whole.
        if let Some(transcriber) = pipeline.by_name("transcriber")
            && transcriber.find_property("keep-agreed").is_some()
        {
            transcriber.set_property("keep-agreed", true);
        }
        let state = Arc::new(Mutex::new(State {
            emit,
            pending: VecDeque::new(),
            enrolling: None,
            session: None,
            done: false,
            language: None,
            whisper: matches!(model, Model::Whisper(_))
                .then(|| pipeline.by_name("transcriber").unwrap()),
        }));

        let heard: Option<Arc<Mutex<Heard>>> = reread.as_ref().map(|_| Arc::default());
        if let Some(heard) = heard.clone() {
            pipeline
                .by_name("transcriber")
                .unwrap()
                .static_pad("sink")
                .unwrap()
                .add_probe(
                    gst::PadProbeType::BUFFER | gst::PadProbeType::EVENT_DOWNSTREAM,
                    move |_, info| {
                        match &info.data {
                            // 16 kHz mono F32, as the transcriber takes it.
                            Some(gst::PadProbeData::Buffer(buffer)) => {
                                if let Ok(map) = buffer.map_readable() {
                                    heard.lock().unwrap().feeding.extend(
                                        map.chunks_exact(4)
                                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                                    );
                                }
                            }
                            Some(gst::PadProbeData::Event(event))
                                if event.type_() == gst::EventType::SegmentDone =>
                            {
                                let mut heard = heard.lock().unwrap();
                                let utterance = std::mem::take(&mut heard.feeding);
                                heard.ended.push_back(utterance);
                            }
                            _ => {}
                        }
                        gst::PadProbeReturn::Ok
                    },
                );
        }
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
                            let audio = heard
                                .as_ref()
                                .and_then(|heard| heard.lock().unwrap().ended.pop_front());
                            let ended = said.lock().unwrap().utterance_ended();
                            let Some(mut pending) = ended else {
                                return gst::PadProbeReturn::Ok;
                            };
                            // Without the state: Whisper takes a second.
                            if let (false, Some(reread), Some(audio)) =
                                (pending.cancelled, &reread, audio)
                            {
                                if let Some(text) = reread.check(pending.id, &pending.text, &audio)
                                {
                                    pending.text = text;
                                }
                                if let Some(language) =
                                    crate::language::detect_clearly(&pending.text)
                                {
                                    *reread.conversation.lock().unwrap() = Some(language);
                                }
                            }
                            said.lock().unwrap().deliver(pending);
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
            holds: Holds::default(),
            reference: reference.filter(|_| speaker_model.is_some()),
            gate_heard,
            voice_heard,
            learning: None,
            speaker_check: speaker_model.is_some(),
            fresh: true,
        })
    }

    /// Whether a new speaker's voice is being learnt from what is heard
    /// (no recordings of theirs): until the gate's speaker check took in
    /// ENROLL_VOICE of voice, the next voice heard (a singer's, a reply's)
    /// may become theirs.
    pub fn learning_voice(&mut self) -> bool {
        if let Some(since) = self.learning
            && self.voice_heard.lock().unwrap().checked >= since + ENROLL_VOICE
        {
            self.learning = None;
            eprintln!("[voice] the speaker's voice is taken: their first 2 s of voice were heard");
        }
        self.learning.is_some()
    }

    /// The gate takes the speaker's voice from their reference recordings:
    /// heard in a session of its own (ENROLLING), stopped at once, so none
    /// of it is transcribed; waits until the gate heard it all.
    fn enroll(&mut self, reference: Vec<u8>) {
        use std::sync::atomic::Ordering;
        let seconds = reference.len() as f32 / 2.0 / RATE as f32;
        self.gate.emit_by_name::<()>("start", &[&ENROLLING, &true]);
        self.gate.emit_by_name::<()>("stop", &[]);
        // At 48 kHz once through the gate, short of the resampler's and the
        // denoiser's latency.
        let wanted = self.gate_heard.load(Ordering::SeqCst) + (reference.len() as u64 / 2) * 3
            - (REFERENCE_GAP as u64) * 3 / 2;
        let duration = gst::ClockTime::from_nseconds(
            (reference.len() as u64 / 2) * gst::ClockTime::SECOND.nseconds() / RATE as u64,
        );
        let mut buffer = gst::Buffer::from_mut_slice(reference);
        {
            let buffer = buffer.get_mut().unwrap();
            buffer.set_pts(self.position);
            buffer.set_duration(duration);
        }
        self.position += duration;
        let _ = self.src.push_buffer(buffer);
        let started = std::time::Instant::now();
        while self.gate_heard.load(Ordering::SeqCst) < wanted
            && started.elapsed() < std::time::Duration::from_secs(5)
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        eprintln!(
            "[voice] the speaker's voice is taken from their reference recordings ({seconds:.1} s{})",
            if self.gate_heard.load(Ordering::SeqCst) < wanted {
                ", not all heard in time"
            } else {
                ""
            }
        );
    }

    /// The call's music is heard at the page now, or not: the gate holds
    /// meanwhile, as during a reply.
    pub fn music(&mut self, audible: bool) {
        if audible == self.holds.music {
            return;
        }
        self.holds.music = audible;
        self.gate.set_property("hold", self.holds.held());
        if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some() {
            eprintln!(
                "[voice] {}",
                if audible {
                    "the call's music is heard: only a louder voice starts an utterance"
                } else {
                    "the call's music stopped: any voice starts an utterance"
                }
            );
        }
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
                // A gate that knows no voice yet (a helper made again)
                // takes one as for a new speaker.
                let new_speaker = self.speaker_check && (new_speaker || self.fresh);
                self.fresh = false;
                // A new speaker's voice comes from their recordings when
                // there are some: the first sound heard may be music, a
                // reply, someone else.
                let reference = self.reference.clone().filter(|_| new_speaker);
                let new_speaker = new_speaker && reference.is_none();
                if let Some(reference) = reference {
                    self.enroll(reference);
                    self.learning = None;
                }
                self.voice_heard.lock().unwrap().restart();
                if new_speaker {
                    self.learning = Some(self.voice_heard.lock().unwrap().checked);
                }
                {
                    let mut state = self.state.lock().unwrap();
                    state.session = Some(id);
                    state.done = false;
                    state.language = language.filter(|l| l.len() == 2);
                    state.enrolling = new_speaker.then_some(id);
                }
                if new_speaker {
                    // speechgate takes the first 2 s of voice it hears as
                    // the speaker's, whatever it is: the call's music waits
                    // meanwhile (main.rs).
                    eprintln!(
                        "[voice] session {id}: a new speaker: the first voice heard is taken as theirs"
                    );
                }
                self.holds.reply = hold;
                self.gate.set_property("hold", self.holds.held());
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
                self.learning_voice();
            }
            Command::Release { id } => {
                if self.state.lock().unwrap().session == Some(id) {
                    self.holds.reply = false;
                    self.gate.set_property("hold", self.holds.held());
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

    /// The speaker's recordings are heard 1 s at a time from each in turn,
    /// their silences left out, a short pause after each piece.
    #[test]
    fn the_reference_takes_each_recording_in_turn() {
        gst::init().unwrap();
        let dir = std::env::temp_dir().join(format!("roamgate-reference-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A tone of `seconds` between half a second of silence, at 16 kHz.
        let write = |name: &str, seconds: f32, hz: f32| {
            let quiet = vec![0i16; 8000];
            let tone = (0..(seconds * 16_000.0) as usize).map(|i| {
                ((2.0 * std::f32::consts::PI * hz * i as f32 / 16_000.0).sin() * 0.3 * 32767.0)
                    as i16
            });
            let samples: Vec<i16> = quiet
                .iter()
                .copied()
                .chain(tone)
                .chain(quiet.clone())
                .collect();
            let mut wav = Vec::new();
            let data = (samples.len() * 2) as u32;
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            for field in [16u32, 1 | (1 << 16), 16_000, 32_000, 2 | (16 << 16)] {
                wav.extend_from_slice(&field.to_le_bytes());
            }
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data.to_le_bytes());
            for sample in samples {
                wav.extend_from_slice(&sample.to_le_bytes());
            }
            let path = dir.join(name);
            std::fs::write(&path, wav).unwrap();
            path.to_string_lossy().into_owned()
        };
        let french = write("fr.wav", 2.5, 220.0);
        let english = write("en.wav", 1.2, 330.0);
        let bytes = super::reference_voice(&[french.clone(), english]).unwrap();
        let samples: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        // fr 0-1 s, en 0-1 s, fr 1-2 s, fr 2-2.5 s (en's last 0.2 s is too
        // short a piece), each with its pause, and one more at the end.
        assert_eq!(samples.len(), 56_000 + 5 * super::REFERENCE_GAP);
        let crossings = |piece: &[i16]| {
            piece
                .windows(2)
                .filter(|pair| (pair[0] < 0) != (pair[1] < 0))
                .count()
        };
        let piece = |n: usize| {
            let start = n * (16_000 + super::REFERENCE_GAP);
            &samples[start..start + 16_000]
        };
        assert!(
            (430..=450).contains(&crossings(piece(0))),
            "{}",
            crossings(piece(0))
        );
        assert!(
            (650..=670).contains(&crossings(piece(1))),
            "{}",
            crossings(piece(1))
        );
        assert!(
            (430..=450).contains(&crossings(piece(2))),
            "{}",
            crossings(piece(2))
        );
        // A recording with no voice in it is not one.
        let silent = write("silent.wav", 0.0, 0.0);
        assert!(super::reference_voice(&[french, silent]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A new speaker's voice is taken once the gate's check took in 2 s of
    /// voice: stretches count once decided, after 300 ms of quiet or 1 s of
    /// voice; quiet alone counts for nothing, and a session's start drops
    /// the stretch waiting, as the gate does.
    #[test]
    fn the_voice_is_taken_after_2_s_of_voice_checked() {
        let ms = |ms: u64| ms * 48;
        let mut heard = super::VoiceHeard::default();
        heard.heard(ms(5000), false);
        assert_eq!(heard.checked, 0);
        // 600 ms of voice, decided after 300 ms of quiet.
        heard.heard(ms(600), true);
        heard.heard(ms(200), false);
        assert_eq!(heard.checked, 0);
        heard.heard(ms(100), false);
        assert_eq!(heard.checked, ms(600));
        // A long sentence: decided every second of voice.
        for _ in 0..25 {
            heard.heard(ms(100), true);
        }
        assert_eq!(heard.checked, ms(2600));
        // Dropped by a new session before it was decided.
        heard.restart();
        heard.heard(ms(300), false);
        assert_eq!(heard.checked, ms(2600));
        assert!(heard.checked >= ms(600) + super::ENROLL_VOICE);
        assert!(heard.checked < ms(1000) + super::ENROLL_VOICE);
    }

    /// The gate holds while a reply plays or the call's music is heard:
    /// a reply released still leaves the music's hold, and the music
    /// stopping leaves the reply's.
    #[test]
    fn the_gate_holds_for_a_reply_or_the_music() {
        let mut holds = super::Holds::default();
        assert!(!holds.held());
        holds.music = true;
        assert!(holds.held());
        holds.reply = true;
        holds.reply = false;
        assert!(holds.held());
        holds.reply = true;
        holds.music = false;
        assert!(holds.held());
        holds.reply = false;
        assert!(!holds.held());
    }

    /// A cancelled utterance gets no final: speech_cancelled says it ends,
    /// for the call's music to come back up.
    #[test]
    fn a_cancelled_utterance_says_so() {
        use std::sync::{Arc, Mutex};
        gst::init().unwrap();
        let events: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut state = {
            let events = events.clone();
            super::State {
                emit: Arc::new(move |event: serde_json::Value| {
                    events
                        .lock()
                        .unwrap()
                        .push(event["event"].as_str().unwrap_or_default().to_string())
                }),
                pending: Default::default(),
                enrolling: None,
                session: Some(1),
                done: false,
                language: None,
                whisper: None,
            }
        };
        state.message(
            &gst::Structure::builder("speechgate-speech-start")
                .field("session", 1u32)
                .build(),
        );
        state.message(
            &gst::Structure::builder("speechgate-speech-end")
                .field("session", 1u32)
                .field("cancelled", true)
                .build(),
        );
        let ended = state.utterance_ended().unwrap();
        state.deliver(ended);
        assert_eq!(
            *events.lock().unwrap(),
            ["speech_start", "speech_cancelled"]
        );
    }

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
