//! Listening: the browser's microphone streams in while the person speaks
//! (on Roamgate's socket, or in a call by WebRTC: call.rs), and one
//! pipeline, kept playing, turns what they say into text:
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
//! With a speaker model, every utterance is told with who said it
//! (voices.rs): the voices heard on the call are told apart as it goes
//! (A, B, C...), and each final carries its `voice`: the voice most heard
//! in it, its share, whether two voices were in it (`mixed`), and how close
//! it is to each voice known. Nothing is silenced for its voice: the server
//! learns which voice is the user's from the conversation and says it with
//! each start (`user_voice`); while a reply or the call's music plays, an
//! utterance then says nothing as it goes (no `speech_start`, no partial
//! words: it must not cut the reply) until a stretch of it sounds like the
//! user, its final coming as any other.
//!
//! With `drop_other_voices` (voice.json, for noisy places) speechgate keeps
//! one voice too, as it did alone before: the first 2 s of
//! voice it hears after a session with `new_speaker` (or the first session,
//! the gate knowing none) become the speaker's, whatever they are (music, a
//! reply, someone else). The gate says when it took that voice
//! (`speechgate-speaker-taken`); until then the listener is learning it
//! (`learning_voice`), and a call's music waits. A voice the gate doubts
//! is the speaker's (close to theirs, not surely theirs) is never dropped
//! unheard: it is transcribed silently, and its final comes marked not for
//! the agent (`for_agent` false, `speaker` false), unless their voice comes
//! in it (`speechgate-speaker-confirmed`). With the speaker's own
//! recordings (`--speaker-reference`), it hears those first instead, a
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
/// A call's microphone that came before its session started: kept this
/// long (16 kHz mono S16LE), and heard first. The page opens its microphone
/// and asks to listen at once, and the audio may overtake the request.
const PREROLL_BYTES: usize = 32 * 500;
/// A call's microphone heard by a session is told every this much
/// (`audio`): the server times pauses by the audio that came.
const PROGRESS_BYTES: usize = 32 * 200;
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

pub enum Command {
    /// A new session replaces the one before.
    Start {
        id: u32,
        hold: bool,
        end_silence_ms: Option<u64>,
        language: Option<String>,
        /// Forget the locked speaker: the next one to speak is kept.
        new_speaker: bool,
        /// The call whose microphone it hears (call.rs), not the socket's.
        call: Option<u32>,
        /// The user's voice, as the server knows it.
        user_voice: Option<crate::voices::User>,
    },
    Audio {
        id: u32,
        samples: Vec<u8>,
    },
    /// Call `call`'s microphone: heard by the session listening to it.
    CallAudio {
        call: u32,
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
    /// Started by a voice the gate doubts is the speaker's, and theirs has
    /// not come in it (speechgate's `speaker`): nothing of it is told as
    /// it goes, and its text comes as not for the agent (`for_agent`
    /// false), to be kept among what was skipped, never dropped.
    doubtful: bool,
    /// Started while a reply or music plays, by a voice not (yet) heard to
    /// be the user's: nothing of it is told as it goes, so it does not cut
    /// the reply, until a stretch of it sounds like theirs. Its final comes
    /// as any other, with its voice.
    unconfirmed: bool,
    /// Who said it (voices.rs), once the transcriber is done with it.
    voice: Option<Value>,
}

impl Pending {
    /// Nothing of it is told before its final.
    fn quiet(&self) -> bool {
        self.doubtful || self.unconfirmed
    }
}

/// The final event of an utterance with its `text`: a doubtful one's is
/// marked not for the agent (`for_agent` false) and not the speaker's, to be
/// kept among what was skipped rather than sent or dropped.
fn final_event(pending: &Pending, text: String) -> Value {
    let mut event = json!({
        "event": "final",
        "session": pending.id,
        "text": text,
        "speech_ms": pending.speech_ms,
    });
    if let Some(voice) = &pending.voice {
        event["voice"] = voice.clone();
    }
    if pending.doubtful {
        eprintln!(
            "[voice] session {}: not surely the speaker's voice, kept as not for the agent: {}",
            pending.id,
            event["text"].as_str().unwrap_or_default()
        );
        event["for_agent"] = json!(false);
        event["speaker"] = json!(false);
    }
    event
}

struct State {
    emit: Emit,
    pending: VecDeque<Pending>,
    /// The session after a new speaker: its first words are where the
    /// speaker's voice was taken from, said in the log.
    enrolling: Option<u32>,
    /// A new speaker's voice is learnt from what is heard: until the gate
    /// says it took one (`speechgate-speaker-taken`).
    learning: bool,
    /// The session listening, and whether its utterance is over.
    session: Option<u32>,
    done: bool,
    language: Option<String>,
    /// whispertranscriber, which takes the language as a property.
    whisper: Option<gst::Element>,
    /// The user's voice as the server knows it: its name among this
    /// call's voices, the prints kept of it.
    user_voice: Option<crate::voices::User>,
    /// A reply or the call's music plays (the gate holds).
    held: bool,
    /// Voices are told apart here, and none dropped by the gate: an
    /// utterance during a hold waits for the user's voice to say anything.
    waits_for_user: bool,
}

impl State {
    /// What the utterance in progress says so far, if still wanted; at a
    /// pause, what the gate made of it (`speechgate-words`).
    fn partial(&self, id: u32, text: &str, pause: Option<&gst::StructureRef>) {
        if self
            .pending
            .back()
            .is_some_and(|pending| pending.id == id && !pending.cancelled && !pending.quiet())
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
            if !pending.cancelled && !pending.quiet() {
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
            let text = pending
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if self.enrolling == Some(pending.id) {
                self.enrolling = None;
                if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some() {
                    eprintln!(
                        "[voice] session {}: the speaker's voice is learnt from their first 2 s of voice, starting with: {}",
                        pending.id, text
                    );
                }
            }
            (self.emit)(final_event(&pending, text));
        }
    }

    /// A stretch of the utterance being heard was placed among the voices
    /// (voices.rs): one waiting for the user's voice is told from now on
    /// when it sounds like theirs.
    fn voice_heard(&mut self, set: u64, stretch: &crate::voices::Stretch) {
        let Some(user) = &self.user_voice else { return };
        if let Some(pending) = self.pending.back_mut()
            && pending.unconfirmed
            && !pending.cancelled
            && crate::voices::sounds_like(stretch, set, user)
        {
            pending.unconfirmed = false;
            eprintln!(
                "[voice] session {}: the user's voice ({}) came: the utterance is told",
                pending.id,
                user.id_in(set).unwrap_or("their kept prints")
            );
            (self.emit)(json!({"event": "speech_start", "session": pending.id}));
        }
    }

    /// One of speechgate's messages, or parakeettranscriber's partial
    /// reading; false for any other message.
    fn message(&mut self, structure: &gst::StructureRef) -> bool {
        let session = structure.get::<u32>("session").ok();
        match structure.name().as_str() {
            "speechgate-speech-start" => {
                let Some(id) = session else { return true };
                // A doubtful voice (not surely the speaker's) is heard
                // whole, but says nothing until theirs comes: it must not
                // cut a reply short.
                let doubtful = structure.get::<bool>("speaker") == Ok(false);
                // Another voice than the user's must not cut a reply
                // either: while one plays, the utterance waits for theirs.
                let unconfirmed =
                    !doubtful && self.waits_for_user && self.held && self.user_voice.is_some();
                self.pending.push_back(Pending {
                    id,
                    cancelled: false,
                    text: String::new(),
                    speech_ms: 0,
                    doubtful,
                    unconfirmed,
                    voice: None,
                });
                // The guess applies to long speech; a hint, if any, is set
                // at the end for short speech.
                if let Some(whisper) = &self.whisper {
                    whisper.set_property("language", None::<&str>);
                }
                if doubtful {
                    eprintln!(
                        "[voice] session {id}: a voice the speaker check doubts is theirs: transcribed, kept as not for the agent unless theirs comes"
                    );
                } else if unconfirmed {
                    eprintln!(
                        "[voice] session {id}: a voice while something plays: transcribed, told as it goes once it sounds like the user's ({})",
                        self.user_voice
                            .as_ref()
                            .and_then(|user| user.id.as_deref())
                            .unwrap_or("known by their kept prints")
                    );
                } else {
                    (self.emit)(json!({"event": "speech_start", "session": id}));
                }
            }
            "speechgate-speaker-confirmed" => {
                if let Some(pending) = self
                    .pending
                    .back_mut()
                    .filter(|pending| Some(pending.id) == session && pending.doubtful)
                {
                    pending.doubtful = false;
                    eprintln!(
                        "[voice] session {}: the speaker's voice came: the utterance is theirs",
                        pending.id
                    );
                    (self.emit)(json!({"event": "speech_start", "session": pending.id}));
                }
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
                    if structure.get::<bool>("speaker") == Ok(false) {
                        pending.doubtful = true;
                    }
                    if pending.quiet() && !pending.cancelled {
                        // Its final comes, as not for the agent when
                        // doubtful.
                    } else if !pending.cancelled {
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
            // Taken from the reference recordings too, when not learning.
            "speechgate-speaker-taken" => {
                if self.learning {
                    self.learning = false;
                    let seconds = structure.get::<u64>("voice-ms").unwrap_or(0) as f64 / 1000.0;
                    eprintln!(
                        "[voice] the speaker's voice is taken: their first {seconds} s of voice were heard"
                    );
                }
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

pub struct Listener {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    gate: gst::Element,
    state: Arc<Mutex<State>>,
    /// The microphone's time line, continued across sessions.
    position: gst::ClockTime,
    /// Where a call's microphone goes.
    calls: CallRouting,
    holds: Holds,
    /// The speaker's voice, from their recordings (16 kHz mono S16LE, in
    /// pieces): heard first whenever a new speaker is to be taken, so the
    /// voice kept is theirs, never the first sound heard.
    reference: Option<Vec<u8>>,
    /// Samples the gate got so far (48 kHz), to know when it heard the
    /// reference.
    gate_heard: Arc<std::sync::atomic::AtomicU64>,
    /// Whether the gate keeps one voice (a speaker model).
    speaker_check: bool,
    /// No session started yet: the gate knows no voice.
    fresh: bool,
    /// Tells the voices heard apart (a speaker model).
    voices: Option<Arc<crate::voices::Tracker>>,
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

/// Where a call's microphone goes: to the session listening to that call,
/// or kept a moment (PREROLL_BYTES) for the session about to start.
#[derive(Default)]
struct CallRouting {
    /// The call whose microphone the session hears, if any.
    call: Option<u32>,
    /// That call's audio no session heard yet, and its call.
    preroll: VecDeque<Vec<u8>>,
    preroll_call: Option<u32>,
    /// Audio heard and not told yet (`audio` events).
    unreported: usize,
}

impl CallRouting {
    /// A session starts, hearing `call`'s microphone or not: what that
    /// microphone said just before, to hear first.
    fn start(&mut self, call: Option<u32>) -> Vec<Vec<u8>> {
        self.call = call;
        self.unreported = 0;
        let kept = std::mem::take(&mut self.preroll);
        if call.is_some() && call == self.preroll_call {
            kept.into()
        } else {
            Vec::new()
        }
    }

    /// Audio of `call`'s microphone: Some when the session hears it now
    /// (`listening`: a session is on and its utterance not over).
    fn route(&mut self, call: u32, samples: Vec<u8>, listening: bool) -> Option<Vec<u8>> {
        if listening && self.call == Some(call) {
            return Some(samples);
        }
        if self.preroll_call != Some(call) {
            self.preroll.clear();
            self.preroll_call = Some(call);
        }
        self.preroll.push_back(samples);
        let mut kept: usize = self.preroll.iter().map(Vec::len).sum();
        while kept > PREROLL_BYTES && self.preroll.len() > 1 {
            kept -= self.preroll.pop_front().map_or(0, |s| s.len());
        }
        None
    }

    /// `bytes` heard: how much to tell, once PROGRESS_BYTES came.
    fn heard(&mut self, bytes: usize) -> Option<usize> {
        self.unreported += bytes;
        (self.unreported >= PROGRESS_BYTES).then(|| std::mem::take(&mut self.unreported))
    }
}

impl Listener {
    /// With `speaker_model`, the voices heard are told apart (voices.rs);
    /// with `drop_other_voices` too, only the voice of whoever speaks first
    /// counts, the gate silencing others. With a turn model, a pause of
    /// `give_up_ms` ends the utterance whatever the models say
    /// (speechgate's own 5 s without it).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        model: Model,
        speaker_model: Option<&str>,
        drop_other_voices: bool,
        turn_model: Option<&str>,
        text_turn_model: Option<&str>,
        give_up_ms: Option<u64>,
        reference: Option<Vec<u8>>,
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
            ("speaker-model", speaker_model.filter(|_| drop_other_voices)),
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
        {
            let heard = gate_heard.clone();
            gate.static_pad("sink").unwrap().add_probe(
                gst::PadProbeType::BUFFER,
                move |_, info| {
                    if let Some(buffer) = info.buffer() {
                        let samples = buffer.size() as u64 / 4;
                        heard.fetch_add(samples, std::sync::atomic::Ordering::SeqCst);
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
            learning: false,
            session: None,
            done: false,
            language: None,
            whisper: matches!(model, Model::Whisper(_))
                .then(|| pipeline.by_name("transcriber").unwrap()),
            user_voice: None,
            held: false,
            waits_for_user: speaker_model.is_some() && !drop_other_voices,
        }));

        // Who speaks: what the transcriber is fed, placed among the voices
        // heard as it comes, each utterance's voice ready when it ends.
        let voices = speaker_model.and_then(|model| {
            let heard = Arc::downgrade(&state);
            crate::voices::Tracker::start(
                model,
                Box::new(move |set, stretch| {
                    if let Some(state) = heard.upgrade() {
                        state.lock().unwrap().voice_heard(set, stretch);
                    }
                }),
            )
            .inspect_err(|error| eprintln!("[voice] voices are not told apart: {error}"))
            .ok()
            .map(Arc::new)
        });
        if let Some(tracker) = voices.clone() {
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
                                    tracker.audio(
                                        map.chunks_exact(4)
                                            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                                            .collect(),
                                    );
                                }
                            }
                            Some(gst::PadProbeData::Event(event))
                                if event.type_() == gst::EventType::SegmentDone =>
                            {
                                tracker.end();
                            }
                            _ => {}
                        }
                        gst::PadProbeReturn::Ok
                    },
                );
        }

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
        let told = voices.clone();
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
                            // Taken for every utterance, in order.
                            let voice = told.as_ref().and_then(|tracker| tracker.take());
                            let Some(mut pending) = ended else {
                                return gst::PadProbeReturn::Ok;
                            };
                            if let Some(voice) = voice {
                                eprintln!("[voice] session {}: {}", pending.id, voice.describe());
                                pending.voice = Some(voice.to_json());
                            }
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
            calls: CallRouting::default(),
            holds: Holds::default(),
            reference: reference.filter(|_| speaker_model.is_some() && drop_other_voices),
            gate_heard,
            speaker_check: speaker_model.is_some() && drop_other_voices,
            fresh: true,
            voices,
        })
    }

    /// Whether a new speaker's voice is being learnt from what is heard
    /// (no recordings of theirs): until the gate says it took one, the next
    /// voice heard (a singer's, a reply's) may become theirs.
    pub fn learning_voice(&self) -> bool {
        self.state.lock().unwrap().learning
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
        self.push(reference);
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
        self.apply_hold();
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

    /// The gate holds while a reply or the call's music plays.
    fn apply_hold(&self) {
        let held = self.holds.held();
        self.gate.set_property("hold", held);
        self.state.lock().unwrap().held = held;
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
                call,
                user_voice,
            } => {
                // Audio has gone through by the next session: the caps are
                // known.
                crate::dump_dot(&self.pipeline, "roamgate-voice-listen");
                // A new call: the voices heard are forgotten.
                if (new_speaker || self.fresh)
                    && let Some(voices) = &self.voices
                {
                    voices.reset();
                }
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
                    self.state.lock().unwrap().learning = false;
                    self.enroll(reference);
                }
                {
                    let mut state = self.state.lock().unwrap();
                    state.session = Some(id);
                    state.done = false;
                    state.language = language.filter(|l| l.len() == 2);
                    state.enrolling = new_speaker.then_some(id);
                    state.user_voice = user_voice;
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
                self.apply_hold();
                self.gate.set_property(
                    "end-silence",
                    end_silence_ms.unwrap_or(DEFAULT_END_SILENCE_MS),
                );
                // What the previous session was saying is not wanted any
                // more: the gate ends it cancelled. Learning starts within
                // the gate's stream lock: the voice it takes from then on
                // is the new speaker's, and none is taken meanwhile.
                {
                    let sink = self.gate.static_pad("sink").unwrap();
                    let _stream = sink.stream_lock();
                    self.gate.emit_by_name::<()>("start", &[&id, &new_speaker]);
                    if new_speaker {
                        self.state.lock().unwrap().learning = true;
                    }
                }
                // What the call's microphone said before this start came.
                for samples in self.calls.start(call) {
                    self.hear(id, samples);
                }
            }
            Command::Audio { id, samples } => {
                {
                    let state = self.state.lock().unwrap();
                    if state.session != Some(id) || state.done || samples.len() < 2 {
                        return;
                    }
                }
                self.push(samples);
            }
            Command::CallAudio { call, samples } => {
                let session = {
                    let state = self.state.lock().unwrap();
                    state.session.filter(|_| !state.done)
                };
                if let Some(samples) = self.calls.route(call, samples, session.is_some())
                    && let Some(id) = session
                {
                    self.hear(id, samples);
                }
            }
            Command::Release { id } => {
                if self.state.lock().unwrap().session == Some(id) {
                    self.holds.reply = false;
                    self.apply_hold();
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

    /// A call's microphone heard by session `id`, told as it comes.
    fn hear(&mut self, id: u32, samples: Vec<u8>) {
        if samples.len() < 2 {
            return;
        }
        let told = self.calls.heard(samples.len());
        self.push(samples);
        if let Some(bytes) = told {
            let emit = self.state.lock().unwrap().emit.clone();
            emit(json!({"event": "audio", "session": id, "bytes": bytes}));
        }
    }

    /// 16 kHz mono S16LE into the pipeline, on the microphone's time line.
    fn push(&mut self, samples: Vec<u8>) {
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
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use gst::prelude::*;

    /// A call's microphone goes to the session hearing that call only;
    /// what came just before a session started is heard first, at most
    /// PREROLL_BYTES of it, and never another call's.
    #[test]
    fn a_calls_microphone_goes_to_its_session() {
        let mut routing = super::CallRouting::default();
        let chunk = |byte: u8| vec![byte; 640];
        // Nobody listens: kept, the oldest going past PREROLL_BYTES.
        for byte in 0..40 {
            assert_eq!(routing.route(7, chunk(byte), false), None);
        }
        let kept = routing.start(Some(7));
        assert_eq!(kept.len(), super::PREROLL_BYTES / 640);
        assert_eq!(kept.last().unwrap()[0], 39);
        // Heard now, but not another call's, nor once the utterance is over.
        assert_eq!(routing.route(7, chunk(1), true), Some(chunk(1)));
        assert_eq!(routing.route(8, chunk(2), true), None);
        assert_eq!(routing.route(7, chunk(3), false), None);
        // A session of the socket's audio takes no call's pre-roll.
        assert!(routing.start(None).is_empty());
        assert_eq!(routing.route(7, chunk(4), true), None);
        // Told every PROGRESS_BYTES.
        let mut told = Vec::new();
        for _ in 0..25 {
            told.extend(routing.heard(640));
        }
        assert_eq!(told, vec![6400, 6400]);
    }

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

    /// A new speaker's voice is learnt until speechgate says it took one;
    /// a voice taken while not learning (from the reference recordings)
    /// changes nothing.
    #[test]
    fn the_voice_is_taken_when_the_gate_says_so() {
        use std::sync::Arc;
        gst::init().unwrap();
        let mut state = super::State {
            emit: Arc::new(|_| {}),
            pending: Default::default(),
            enrolling: None,
            learning: false,
            session: Some(1),
            done: false,
            language: None,
            whisper: None,
            user_voice: None,
            held: false,
            waits_for_user: false,
        };
        let taken = gst::Structure::builder("speechgate-speaker-taken")
            .field("session", 1u32)
            .field("voice-ms", 2000u64)
            .field("timestamp", gst::ClockTime::from_seconds(3))
            .build();
        assert!(state.message(&taken));
        assert!(!state.learning);
        state.learning = true;
        assert!(
            state.message(
                &gst::Structure::builder("speechgate-speech-start")
                    .field("session", 1u32)
                    .build()
            )
        );
        assert!(state.learning);
        assert!(state.message(&taken));
        assert!(!state.learning);
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
                learning: false,
                session: Some(1),
                done: false,
                language: None,
                whisper: None,
                user_voice: None,
                held: false,
                waits_for_user: false,
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

    /// A state recording every event it emits.
    fn recording() -> (
        super::State,
        std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    ) {
        use std::sync::{Arc, Mutex};
        let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let kept = events.clone();
        let state = super::State {
            emit: Arc::new(move |event: serde_json::Value| kept.lock().unwrap().push(event)),
            pending: Default::default(),
            enrolling: None,
            learning: false,
            session: Some(1),
            done: false,
            language: None,
            whisper: None,
            user_voice: None,
            held: false,
            waits_for_user: false,
        };
        (state, events)
    }

    /// While a reply plays, an utterance says nothing as it goes until a
    /// stretch of it sounds like the user's voice: another voice (a radio)
    /// does not cut the reply. Its final comes with its voice either way,
    /// for the agent: the companion judges it by its label.
    #[test]
    fn another_voice_waits_for_the_users_during_a_reply() {
        use crate::voices::Stretch;
        gst::init().unwrap();
        let (mut state, events) = recording();
        state.waits_for_user = true;
        state.held = true;
        state.user_voice = Some(crate::voices::User::named(5, "A"));
        let start = |id: u32| {
            gst::Structure::builder("speechgate-speech-start")
                .field("session", id)
                .build()
        };
        let end = |id: u32| {
            gst::Structure::builder("speechgate-speech-end")
                .field("session", id)
                .field("speech-ms", 2100u64)
                .field("cancelled", false)
                .build()
        };
        // The radio: voice B, far from the user's.
        state.message(&start(1));
        state.partial(1, "Les informations", None);
        state.voice_heard(5, &Stretch::heard("B", &[("A", 0.05), ("B", 0.7)], 1.0));
        state.message(&end(1));
        let mut ended = state.utterance_ended().unwrap();
        ended.voice = Some(serde_json::json!({"voices": 5, "id": "B"}));
        state.deliver(ended);
        let told = std::mem::take(&mut *events.lock().unwrap());
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!(told[0]["event"], "final");
        assert_eq!(told[0]["voice"]["id"], "B");
        assert!(told[0].get("for_agent").is_none());

        // The user over it: told from their first stretch on.
        state.message(&start(2));
        state.voice_heard(5, &Stretch::heard("A", &[("A", 0.6), ("B", 0.1)], 1.0));
        state.partial(2, "Attends", None);
        let told: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["event"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(told, ["speech_start", "partial"]);

        // No reply playing: told at once.
        events.lock().unwrap().clear();
        state.held = false;
        state.message(&start(3));
        assert_eq!(events.lock().unwrap()[0]["event"], "speech_start");
    }

    /// A voice the speaker check doubts is the speaker's is transcribed,
    /// not dropped: nothing of it shows as it goes (it must not cut a
    /// reply), and its text comes as not for the agent, to be kept among
    /// the skipped sentences. The speaker's voice coming in it makes it
    /// theirs.
    #[test]
    fn a_doubtful_voice_comes_as_not_for_the_agent() {
        gst::init().unwrap();
        let (mut state, events) = recording();
        let start = |id: u32| {
            gst::Structure::builder("speechgate-speech-start")
                .field("session", id)
                .field("speaker", false)
                .build()
        };
        let end = |id: u32, speaker: bool| {
            gst::Structure::builder("speechgate-speech-end")
                .field("session", id)
                .field("speech-ms", 680u64)
                .field("cancelled", false)
                .field("speaker", speaker)
                .build()
        };
        state.message(&start(1));
        state.partial(1, "Et puis", None);
        state.text("Et puis je disais ça.".into());
        state.message(&end(1, false));
        let ended = state.utterance_ended().unwrap();
        state.deliver(ended);
        let told = std::mem::take(&mut *events.lock().unwrap());
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!(told[0]["event"], "final");
        assert_eq!(told[0]["text"], "Et puis je disais ça.");
        assert_eq!(told[0]["for_agent"], false);
        assert_eq!(told[0]["speaker"], false);

        state.session = Some(2);
        state.message(&start(2));
        state.message(
            &gst::Structure::builder("speechgate-speaker-confirmed")
                .field("session", 2u32)
                .build(),
        );
        state.text("Pourquoi tu m'entends pas ?".into());
        state.message(&end(2, true));
        let ended = state.utterance_ended().unwrap();
        state.deliver(ended);
        let told = std::mem::take(&mut *events.lock().unwrap());
        let names: Vec<_> = told.iter().map(|e| e["event"].as_str().unwrap()).collect();
        assert_eq!(names, ["speech_start", "text", "speech_end", "final"]);
        assert!(told[3].get("for_agent").is_none());
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
