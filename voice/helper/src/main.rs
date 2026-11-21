//! Roamgate's voice helper. Roamgate starts it and keeps it running, so the
//! speech models stay loaded, and talks to it in frames (see `frames`):
//! JSON objects, and raw audio.
//!
//! Listening (see `listen`), for one session at a time:
//! - `{"op": "listen_start", "session": 3, "hold": true, "language": "es",
//!   "end_silence_ms": 2500, "new_speaker": true, "user_voice": {"voices":
//!   1763550000000, "id": "A"}}`, then AUDIO frames for session 3 (or, with
//!   `"call": 7`, call 7's microphone); with `--speaker-model`, the voices
//!   heard since a `new_speaker` start are told apart (`voices`), each
//!   final saying whose it is (`"voice": {"voices": ..., "id": "A",
//!   "share": 0.9, "mixed": false, "mix": [...], "similarity": {"A": 0.6}}`),
//!   and `user_voice` (the server's guess: `voices` and `id` once known on
//!   the call, `prints` kept of the user from earlier calls) keeps other
//!   voices from cutting a reply; finals carry the prints the server keeps
//!   (`print`, the utterance's, and `prints`, each voice's in it); with `--drop-other-voices` too, only the voice of whoever
//!   spoke first since a `new_speaker` start counts, others silenced;
//! - `{"op": "listen_release", "session": 3}` once a reply stops playing;
//! - `{"op": "listen_finish", "session": 3}` ends the utterance now,
//!   `{"op": "listen_stop", "session": 3}` drops it.
//!
//! It answers with events: `{"event": "speech_start", "session": 3}`,
//! `{"event": "text", ...}` as Whisper goes, or
//! `{"event": "partial", ...}` with all heard so far as Parakeet (with
//! `--parakeet-model`) reads it again, and `{"event": "final",
//! "session": 3, "text": "...", "speech_ms": 1800}`. With both
//! `--parakeet-model` and `--whisper-model`, a final Parakeet wrote in
//! English while the conversation is in another language is heard by
//! Whisper, and read again in that language when it was said in it (see
//! `reread`). The first session loads the listening models: it is told
//! `{"event": "listen_loading", "session": 3}`, then `listen_ready` once
//! they are (seconds later); its audio and its finish wait meanwhile, and
//! are heard after.
//!
//! Speaking: `{"id": 2, "op": "speak", "text": "...", "language": "fr"}`, one
//! sentence to Ogg Opus speech, in the language given or the one its words
//! look like: `{"id": 2, "audio": "<base64>", "language": "fr"}`. Kokoro
//! reads it, or with `--tts-models` the first of those any-tts models that
//! speaks its language.
//!
//! A speak request may carry a `rate` (0.5 to 2, 1 by default): the speech
//! is made that much faster, keeping its pitch (soundtouch's `pitch`), and
//! the answer says the `rate` it was made at (1 when it could not be
//! changed), for the page to play it as it is.
//!
//! A speak request may carry its own `tts_models` (the `--tts-models` JSON)
//! to read that sentence with, such as a voice to hear before choosing it;
//! `{"op": "set_tts_models", "tts_models": "[...]"}` changes the models every
//! sentence is read with from then on. Either loads only what changed
//! (a voice: a second), between sentences.
//!
//! Cloning a voice (see `clone`): `{"id": 4, "op": "clone_voice", "audio":
//! "rec.wav", "model": "<Qwen3-TTS Base dir>", "reference": "voice.wav",
//! "language": "fr"}` reads the recording, cuts its silences, keeps it at
//! `reference` (24 kHz WAV), and answers `{"id": 4, "embedding": [...],
//! "codes": [[...], ...], "heard": "...", "seconds": 12.4}`: the voice's
//! x-vector and codec codes, and what the speech to text model heard.
//!
//! A call (see `call`): `{"id": 5, "op": "call_start", "call": 7,
//! "background": "<gst-launch source>", "volume": 0.6, "ducked": 0.15,
//! "release_ms": 3000, "muted": true, "reply_loudness": -16, "reply_peak":
//! -1}` (the music off until call_music puts it on, its source made only
//! then; no background, no music; the replies brought to -16 LUFS under
//! -1 dBTP, null leaving them as made: see `loudness`) answers
//! `{"id": 5, "ok": true, "rate": 48000, "channels": 2, "music": true,
//! "waiting": true, "signalling_port": 41234}`: the call's mix goes to the
//! page by WebRTC (webrtcsink), whose signalling server listens on
//! 127.0.0.1 on that port, until `{"op": "call_stop", "call": 7}`.
//! `{"op": "call_microphone", "call": 7, "peer": "<id>"}` listens to the
//! page's microphone producer of that id (webrtcsrc), with `"echo":
//! "here"` taking the replies' echo out of it first (echo.rs: the page
//! plays them on a phone's loudspeaker without its own canceller); a listening session
//! started with `"call": 7` hears it, and says how much came: `{"event":
//! "audio", "session": 3, "bytes": 6400}` (16 kHz mono S16LE). A background or a microphone that fails is
//! told as `{"event": "call_error", "call": 7, "error": "..."}`, the call
//! going on without it. A speak request with `"call": 7` goes into the mix
//! and answers `{"id": 2, "queued": true, "start_ms": ..., "duration_ms":
//! ..., "now_ms": ..., "rate": 1.5, "language": "fr"}`, in the mix's
//! time. `{"op": "call_hush", "call": 7}` drops the voice
//! queued (the user talks over it); `{"op": "call_music", "call": 7,
//! "volume": 0.3, "muted": false}` changes the music's level. The music
//! ducks while the voice plays or the user talks (listen events). It waits,
//! silent, while the speaker check learns a new speaker's voice from what
//! it hears (no `--speaker-reference`): call_start's `waiting`, then
//! `{"event": "call_music", "call": 7, "waiting": true}` at first and on each
//! change, `"waiting": false` once the voice is taken and the music may
//! play.
//!
//! A YouTube video plays into a call's mix as its music (`call::youtube`):
//! `{"id": 6, "op": "call_youtube", "call": 7, "action": "play", "url":
//! "<audio stream>", "headers": {"User-Agent": "..."}, "volume": 1,
//! "pause_mpris": "org.mpris.MediaPlayer2.spotify"}` (WebM with Opus, read
//! with reqwesthttpsrc; those players are paused when the call's background
//! carries their sound) answers once its sound comes: `{"id": 6, "state":
//! "playing", "position": 0.1, "duration": 212.0, "volume": 1,
//! "music_muted": false, "spotify_paused": true}`. The other actions,
//! "pause", "resume", "stop", "volume" (`volume`, 0 to 1), "seek"
//! (`position`, in seconds) and "status", answer the same state ("playing",
//! "paused" or "stopped"). Events: `{"event": "call_youtube", "call": 7,
//! "state": "playing", "position": 0.0, "duration": 212.0}` once it sounds,
//! `{"event": "call_youtube", "call": 7, "state": "stopped", "why":
//! "ended" | "error" | "spotify", "reason": "..."}` when it stops by
//! itself. A helper older than this answers `unknown op call_youtube`.
//!
//! A failed request answers `{"id": ..., "error": "..."}`. Listening,
//! speaking and cloning run on threads of their own, so none waits for
//! another.
//!
//! `roamgate-voice --clone <audio> --model <Qwen3-TTS Base dir> --text
//! "<what it says>" --output voice.json` writes a voice from the command
//! line.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use gst::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

mod call;
mod clone;
mod echo;
mod frames;
mod language;
mod listen;
mod loudness;
mod mpris;
#[cfg(target_os = "macos")]
mod processtap;
mod reference;
mod reread;
mod voices;

/// With GStreamer's `GST_DEBUG_DUMP_DOT_DIR` set, writes `pipeline`'s graph
/// there as `<name>.dot`, replacing the previous one.
pub fn dump_dot(pipeline: &gst::Pipeline, name: &str) {
    pipeline.debug_to_dot_file(gst::DebugGraphDetails::all(), name);
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    op: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    session: Option<u32>,
    #[serde(default)]
    hold: bool,
    #[serde(default)]
    end_silence_ms: Option<u64>,
    #[serde(default)]
    new_speaker: bool,
    /// listen_start: the user's voice, among the voices told apart.
    #[serde(default)]
    user_voice: Option<UserVoice>,
    /// The models to read with (`--tts-models`' JSON).
    #[serde(default)]
    tts_models: Option<String>,
    /// speak: how much faster than the voice's own pace.
    #[serde(default)]
    rate: Option<f64>,
    /// clone_voice: the recording, the Base model, where to keep the
    /// reference.
    #[serde(default)]
    audio: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reference: Option<String>,
    /// The call a speak request, or a call op, is for.
    #[serde(default)]
    call: Option<u32>,
    /// call_start: the background source, its level, ducking and release.
    #[serde(default)]
    background: Option<String>,
    #[serde(default)]
    volume: Option<f64>,
    #[serde(default)]
    ducked: Option<f64>,
    #[serde(default)]
    release_ms: Option<u64>,
    /// call_music: the music off (true) or back (false).
    #[serde(default)]
    muted: Option<bool>,
    /// call_microphone: the page's microphone producer, by its peer id.
    #[serde(default)]
    peer: Option<String>,
    /// call_microphone: "here" when the page plays the replies without its
    /// own echo canceller (its loudspeaker mode): it is cancelled here.
    #[serde(default)]
    echo: Option<String>,
    /// call_start: the replies' loudness in LUFS (null: as the models make
    /// them), and their highest peak in dBTP.
    #[serde(default)]
    reply_loudness: Option<Value>,
    #[serde(default)]
    reply_peak: Option<f64>,
    /// call_youtube: what to do (play, pause, resume, stop, volume, seek,
    /// status), the stream and its HTTP headers, where to seek to, and the
    /// MPRIS players to pause.
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    position: Option<f64>,
    #[serde(default)]
    pause_mpris: Option<String>,
}

/// A call_youtube request's part for the call.
fn youtube_request(request: &Request) -> call::YoutubeRequest {
    call::YoutubeRequest {
        action: request.action.clone().unwrap_or_default(),
        url: request.url.clone().unwrap_or_default(),
        headers: request.headers.clone(),
        volume: request.volume,
        position: request.position,
        pause_mpris: request.pause_mpris.clone(),
    }
}

/// A call_youtube request, on the YouTube thread: a start waits for the
/// video's sound, and must not hold the call's other ops.
fn youtube_op(output: &Output, calls: &Calls, request: &Request) -> Value {
    let id = request.call.unwrap_or_default();
    let current = calls.lock().unwrap().clone().filter(|call| call.id == id);
    let Some(current) = current else {
        return json!({"id": request.id, "error": format!("no call {id}")});
    };
    let events = output.clone();
    let on_event: call::OnYoutubeEvent = Arc::new(move |event| reply(&events, event));
    let pause: call::Pause = Arc::new(mpris::pause_playing);
    match current.youtube(&youtube_request(request), &pause, &on_event) {
        Ok(mut answer) => {
            answer["id"] = request.id.clone();
            answer
        }
        Err(error) => json!({"id": request.id, "error": error}),
    }
}

/// The user's voice: its name in a set of voices told apart (voices.rs).
#[derive(Deserialize)]
struct UserVoice {
    #[serde(default)]
    voices: Option<u64>,
    #[serde(default)]
    id: Option<String>,
    /// The prints kept of the user from earlier calls (voice-profiles.ts).
    #[serde(default)]
    prints: Vec<Vec<f32>>,
}

/// The call playing now, if any.
type Calls = Arc<Mutex<Option<Arc<call::Call>>>>;

/// The call ops: call_start, call_stop, call_hush, call_music,
/// call_microphone; the microphone's audio goes to `listen`.
fn call_op(
    output: &Output,
    calls: &Calls,
    listen: &mpsc::Sender<listen::Command>,
    learning: &AtomicBool,
    request: &Request,
) -> Value {
    let id = request.call.unwrap_or_default();
    match request.op.as_str() {
        "call_start" => {
            // One call at a time: a new one ends the one before.
            calls.lock().unwrap().take();
            let defaults = call::Settings::default();
            let settings = call::Settings {
                background: request.background.clone().unwrap_or_default(),
                volume: request.volume.unwrap_or(defaults.volume),
                ducked: request.ducked.unwrap_or(defaults.ducked),
                release_ms: request.release_ms.unwrap_or(defaults.release_ms),
                muted: request.muted.unwrap_or(defaults.muted),
                // Told by the listener (learning_voice) from then on.
                wait_for_voice: learning.load(Ordering::SeqCst),
                reply_loudness: match &request.reply_loudness {
                    None => defaults.reply_loudness,
                    Some(value) => value.as_f64().map(|lufs| lufs.clamp(-40.0, -6.0)),
                },
                reply_peak: request
                    .reply_peak
                    .map_or(defaults.reply_peak, |peak| peak.clamp(-12.0, 0.0)),
            };
            let errors = output.clone();
            match call::Call::start(
                id,
                &settings,
                Arc::new(move |error| {
                    eprintln!("call {id}: {error}");
                    reply(
                        &errors,
                        json!({"event": "call_error", "call": id, "error": error}),
                    );
                }),
            ) {
                Ok(started) => {
                    let music = started.music;
                    let port = started.signalling_port;
                    *calls.lock().unwrap() = Some(Arc::new(started));
                    json!({"id": request.id, "ok": true, "rate": call::RATE,
                        "channels": call::CHANNELS, "music": music,
                        "waiting": music && settings.wait_for_voice,
                        "signalling_port": port})
                }
                Err(error) => json!({"id": request.id, "error": error}),
            }
        }
        _ => {
            let current = calls.lock().unwrap().clone().filter(|call| call.id == id);
            let Some(current) = current else {
                return json!({"id": request.id, "error": format!("no call {id}")});
            };
            match request.op.as_str() {
                "call_stop" => {
                    calls.lock().unwrap().take();
                    json!({"id": request.id, "ok": true})
                }
                "call_hush" => {
                    current.hush();
                    json!({"id": request.id, "ok": true})
                }
                "call_microphone" => {
                    let listen = Mutex::new(listen.clone());
                    let heard: call::OnSamples = Arc::new(move |samples| {
                        let _ = listen
                            .lock()
                            .unwrap()
                            .send(listen::Command::CallAudio { call: id, samples });
                    });
                    match current.set_microphone(
                        request.peer.as_deref().unwrap_or(""),
                        heard,
                        request.echo.as_deref() == Some("here"),
                    ) {
                        Ok(()) => json!({"id": request.id, "ok": true}),
                        Err(error) => json!({"id": request.id, "error": error}),
                    }
                }
                _ => {
                    let (volume, muted) = current.set_music(request.volume, request.muted);
                    json!({"id": request.id, "ok": true, "volume": volume, "muted": muted})
                }
            }
        }
    }
}

#[derive(Clone)]
struct Config {
    whisper_model: Option<String>,
    /// Parakeet TDT, in place of Whisper.
    parakeet_model: Option<String>,
    /// Speaker embeddings (WeSpeaker ResNet34 ONNX): the voices heard are
    /// told apart.
    speaker_model: Option<String>,
    /// Only the first voice counts, the gate silencing others (noisy
    /// places).
    drop_other_voices: bool,
    /// Smart Turn v3: whether a pause ends the speaker's turn.
    turn_model: Option<String>,
    /// A small language model reading whether the words are finished.
    text_turn_model: Option<String>,
    /// With a turn model, the longest pause before the utterance ends.
    turn_give_up_ms: Option<u64>,
    /// Recordings of the speaker's voice (a JSON array of paths), its new
    /// voice taken from them rather than from the first sound heard.
    speaker_reference: Option<String>,
    kokoro_model: Option<String>,
    kokoro_voices: Option<String>,
    /// any-tts models reading in place of Kokoro, in order of preference: a
    /// JSON array of objects with a "model" name and anyttssynthesizer's
    /// fields for it ({"model": "qwen3-tts", "path": "...", ...}).
    tts_models: Option<String>,
}

/// anyttssynthesizer's models from `--tts-models`.
fn tts_models(json: &str) -> Result<gst::Array, String> {
    let models: Vec<serde_json::Map<String, Value>> =
        serde_json::from_str(json).map_err(|e| format!("--tts-models: {e}"))?;
    let models = models
        .into_iter()
        .map(|fields| {
            let Some(Value::String(name)) = fields.get("model") else {
                return Err("--tts-models: each model needs a \"model\" name".to_string());
            };
            let mut structure = gst::Structure::new_empty(name.as_str());
            for (field, value) in &fields {
                // JSON's snake case, GStreamer's dashes.
                let field = field.replace('_', "-");
                match value {
                    _ if field == "model" => (),
                    Value::String(value) => structure.set(field.as_str(), value),
                    Value::Number(value) => {
                        structure.set(field.as_str(), value.as_f64().unwrap_or_default())
                    }
                    _ => return Err(format!("--tts-models: {field} of {name}: {value}")),
                }
            }
            Ok(structure.to_send_value())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(gst::Array::new(models))
}

/// Where frames go: the process's stdout, kept for them (frames::take_stdout).
type Output = Arc<Mutex<Box<dyn std::io::Write + Send>>>;

fn reply(output: &Output, message: Value) {
    let mut out = output.lock().unwrap();
    let _ = frames::write(&mut *out, frames::JSON, message.to_string().as_bytes());
}

fn arg(name: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
    }
    None
}

/// The fastest and slowest a sentence is made.
const MIN_RATE: f64 = 0.5;
const MAX_RATE: f64 = 2.0;

/// The longest the helper takes to end once its stdin closed, threads
/// stuck in a model included (Roamgate waits a little longer for it).
const EXIT_GRACE: Duration = Duration::from_secs(10);

/// Text to speech: one pipeline kept playing, from a synthesizer to Ogg
/// Opus (small enough for a phone on the go), a sentence at a time. A
/// sentence asked faster goes through soundtouch's `pitch` at that
/// tempo, which keeps the voice's pitch; the page then plays it as it is, in the
/// call's audio, with no media element. Each
/// sentence ends with EOS, so oggmux finishes a file the browser can play
/// on its own, then a flush readies the pipeline for the next one, which
/// starts a new file from zero.
/// The speaker's pipeline but its synthesizer (Speaker::new puts it
/// between `src` and `convert`).
const SPEAK_PIPELINE: &str = "appsrc name=src format=time caps=text/x-raw,format=utf8 \
             tee name=convert \
             convert. ! queue name=oggq max-size-buffers=0 max-size-bytes=0 max-size-time=10000000000 ! \
             audioconvert ! audioresample ! opusenc bitrate=64000 ! oggmux ! \
             appsink name=sink sync=false async=false \
             convert. ! queue name=rawq max-size-buffers=0 max-size-bytes=0 max-size-time=10000000000 ! \
             audioconvert ! audioresample quality=10 ! \
             audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=2 ! \
             appsink name=raw sync=false async=false";

struct Speaker {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sink: gst_app::AppSink,
    /// The same speech as raw F32 48 kHz stereo, for a call's mix.
    raw: gst_app::AppSink,
    /// Which branch gets the speech: the Ogg file, or the call's raw blocks.
    to_call: Arc<std::sync::atomic::AtomicBool>,
    /// anyttssynthesizer, whose models can change; None for Kokoro's.
    anytts: Option<gst::Element>,
    /// soundtouch's `pitch`, whose `tempo` is the next sentence's rate;
    /// None when this GStreamer has no soundtouch (speech is then made
    /// at 1).
    tempo: Option<gst::Element>,
}

/// Why `pipeline` failed to change state, from its bus.
fn bus_error(pipeline: &gst::Pipeline) -> Option<String> {
    pipeline
        .bus()
        .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]))
        .and_then(|message| match message.view() {
            gst::MessageView::Error(e) => {
                Some(format!("{} ({})", e.error(), e.debug().unwrap_or_default()))
            }
            _ => None,
        })
}

/// The errors waiting on `pipeline`'s bus, taken off it.
fn drain_bus_errors(pipeline: &gst::Pipeline) -> Vec<String> {
    let Some(bus) = pipeline.bus() else {
        return Vec::new();
    };
    std::iter::from_fn(|| bus.pop_filtered(&[gst::MessageType::Error]))
        .filter_map(|message| match message.view() {
            gst::MessageView::Error(e) => {
                Some(format!("{} ({})", e.error(), e.debug().unwrap_or_default()))
            }
            _ => None,
        })
        .collect()
}

impl Speaker {
    fn new(config: &Config) -> Result<Self, String> {
        let (synthesizer, name) = match (&config.tts_models, &config.kokoro_model) {
            (Some(models), _) => {
                let models = tts_models(models)?;
                let synthesizer = gst::ElementFactory::make("anyttssynthesizer")
                    .property("models", models)
                    .build()
                    .map_err(|e| e.to_string())?;
                (synthesizer, "any-tts")
            }
            (None, Some(model)) => {
                let synthesizer = gst::ElementFactory::make("kokorosynthesizer")
                    .property("model-path", model)
                    .property("voices-path", config.kokoro_voices.as_deref().unwrap_or(""))
                    .build()
                    .map_err(|e| e.to_string())?;
                (synthesizer, "kokoro")
            }
            (None, None) => return Err("--tts-models or --kokoro-model is required".into()),
        };
        Self::with_synthesizer(synthesizer, name)
    }

    /// The speaker's pipeline around `synthesizer` (`name` says which).
    fn with_synthesizer(synthesizer: gst::Element, name: &str) -> Result<Self, String> {
        // 64 kb/s: at 32 the voice came out audibly coarser (half the
        // waveform SNR), for a few more kilobytes a sentence.
        // In a call, the speech goes to the call's mix as raw audio
        // instead (call.rs): each branch drops its buffers when the speech
        // is not for it, so both still end with EOS.
        // Neither sink waits to preroll (async=false): the flush after each
        // sentence made async sinks preroll again, and the raw sink,
        // prerolled on its first buffer, then held the tee while oggmux
        // waited for more data for its first page: the synthesizer blocked
        // on the full queue and the reply never came (Qwen3-TTS streams
        // many small buffers). The queues hold up to 10 s, whatever the
        // number of buffers.
        let pipeline = gst::parse::launch(SPEAK_PIPELINE)
            .map_err(|e| e.to_string())?
            .downcast::<gst::Pipeline>()
            .unwrap();
        let to_call = Arc::new(std::sync::atomic::AtomicBool::new(false));
        for (queue, wanted) in [("oggq", false), ("rawq", true)] {
            let to_call = to_call.clone();
            pipeline
                .by_name(queue)
                .unwrap()
                .static_pad("src")
                .unwrap()
                .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                    if to_call.load(std::sync::atomic::Ordering::SeqCst) == wanted {
                        gst::PadProbeReturn::Ok
                    } else {
                        gst::PadProbeReturn::Drop
                    }
                });
        }
        // appsrc ! synthesizer ! ... ! tee: the synthesizer goes between.
        let src_element = pipeline.by_name("src").unwrap();
        let convert = pipeline.by_name("convert").unwrap();
        pipeline.add(&synthesizer).unwrap();
        // synthesizer ! audioconvert ! pitch ! audioconvert. soundtouch's
        // pitch makes a sentence `tempo` times faster keeping its pitch;
        // speak() sets it before each sentence. At EOS it drains what
        // soundtouch still holds, so a sentence's end is not cut; the
        // flush after it empties it for the next one.
        let pitch = gst::ElementFactory::make("pitch").build().ok();
        let tempo = match pitch {
            Some(pitch) => {
                let before = gst::ElementFactory::make("audioconvert")
                    .build()
                    .map_err(|e| e.to_string())?;
                pipeline.add_many([&before, &pitch]).unwrap();
                gst::Element::link_many([&src_element, &synthesizer, &before, &pitch, &convert])
                    .map_err(|e| e.to_string())?;
                Some(pitch)
            }
            None => {
                eprintln!("no soundtouch: speech is made at the voice's own pace");
                gst::Element::link_many([&src_element, &synthesizer, &convert])
                    .map_err(|e| e.to_string())?;
                None
            }
        };
        let src = pipeline
            .by_name("src")
            .unwrap()
            .downcast::<gst_app::AppSrc>()
            .unwrap();
        let sink = pipeline
            .by_name("sink")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        if let Err(err) = pipeline.set_state(gst::State::Playing) {
            // The synthesizer says why on the bus.
            let detail = bus_error(&pipeline);
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!(
                "{name} failed to load: {}",
                detail.unwrap_or_else(|| err.to_string())
            ));
        }
        let raw = pipeline
            .by_name("raw")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        dump_dot(&pipeline, "roamgate-voice-speak");
        Ok(Self {
            pipeline,
            src,
            sink,
            raw,
            to_call,
            anytts: (name == "any-tts").then_some(synthesizer),
            tempo,
        })
    }

    /// Reads with `models` (`--tts-models`' JSON) from now on. Back in READY,
    /// anyttssynthesizer keeps its models loaded, and going on to PLAYING
    /// loads only what changed: a voice is read and warmed up, its model
    /// stays.
    fn set_models(&self, models: &str) -> Result<(), String> {
        let Some(synthesizer) = &self.anytts else {
            return Err("Voices need tts_models: Kokoro alone has one voice".into());
        };
        let models = tts_models(models)?;
        self.pipeline
            .set_state(gst::State::Ready)
            .map_err(|e| e.to_string())?;
        synthesizer.set_property("models", models);
        if let Err(err) = self.pipeline.set_state(gst::State::Playing) {
            let detail = bus_error(&self.pipeline).unwrap_or_else(|| err.to_string());
            return Err(format!("the voices failed to load: {detail}"));
        }
        Ok(())
    }

    /// Speaks `text` in `language`, `rate` times faster than the voice's
    /// own pace; answers the speech and the rate it was made at.
    fn speak(
        &self,
        text: &str,
        language: &str,
        rate: f64,
        mut call: Option<&mut call::Sentence>,
        on_audio: &dyn Fn(),
    ) -> Result<(Vec<u8>, f64), String> {
        // An error left from a sentence before (a failure posts several:
        // the synthesizer's, then appsrc's) is not this one's: popped
        // first, it failed every sentence after it with an old error.
        for stale in drain_bus_errors(&self.pipeline) {
            eprintln!("[voice] an earlier sentence's error dropped: {stale}");
        }
        self.to_call
            .store(call.is_some(), std::sync::atomic::Ordering::SeqCst);
        let rate = match &self.tempo {
            Some(tempo) => {
                let rate = if rate.is_finite() {
                    rate.clamp(MIN_RATE, MAX_RATE)
                } else {
                    1.0
                };
                // Between sentences: the last one ended and was flushed.
                tempo.set_property("tempo", rate as f32);
                rate
            }
            None => 1.0,
        };
        let mut tags = gst::TagList::new();
        tags.get_mut()
            .unwrap()
            .add::<gst::tags::LanguageCode>(&language, gst::TagMergeMode::Replace);
        self.src.send_event(gst::event::Tag::new(tags));
        self.src
            .push_buffer(gst::Buffer::from_slice(text.as_bytes().to_vec()))
            .map_err(|e| e.to_string())?;
        let _ = self.src.end_of_stream();
        let mut speech = Vec::new();
        let mut heard = false;
        let result = loop {
            // The raw branch, as it comes: a call hears it while the rest
            // is still being made.
            let mut got = false;
            while let Some(sample) = self.raw.try_pull_sample(gst::ClockTime::ZERO) {
                got = true;
                if !heard {
                    heard = true;
                    on_audio();
                }
                if let (Some(sentence), Some(buffer)) = (call.as_deref_mut(), sample.buffer()) {
                    let map = buffer.map_readable().map_err(|e| e.to_string())?;
                    let samples: Vec<f32> = map
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect();
                    sentence.push(&samples);
                }
            }
            if let Some(sample) = self
                .sink
                .try_pull_sample(gst::ClockTime::from_mseconds(if got { 0 } else { 5 }))
            {
                if let Some(buffer) = sample.buffer() {
                    let map = buffer.map_readable().map_err(|e| e.to_string())?;
                    speech.extend_from_slice(&map);
                }
                continue;
            }
            if self.sink.is_eos() && self.raw.is_eos() {
                // A failure ends the sentence too: appsrc posts its error,
                // then sends EOS down. Qwen3-TTS out of GPU memory came
                // out as a sentence said, silent, and its error was taken
                // for the next one's.
                let errors = drain_bus_errors(&self.pipeline);
                break match errors.into_iter().next() {
                    Some(error) => Err(error),
                    None => Ok(speech),
                };
            }
            if let Some(message) = self
                .pipeline
                .bus()
                .unwrap()
                .pop_filtered(&[gst::MessageType::Error])
                && let gst::MessageView::Error(err) = message.view()
            {
                break Err(format!("{}: {:?}", err.error(), err.debug()));
            }
        };
        // Negotiated by now: the graph shows the caps.
        dump_dot(&self.pipeline, "roamgate-voice-speak");
        if result.is_err() {
            // Failed: a flush does not restart what stopped on the error
            // (appsrc's task, the synthesizer's stream). Back to READY and
            // on, which keeps anyttssynthesizer's models loaded, the next
            // sentence starts afresh.
            let _ = self.pipeline.set_state(gst::State::Ready);
            drain_bus_errors(&self.pipeline);
            if let Err(err) = self.pipeline.set_state(gst::State::Playing) {
                let detail = bus_error(&self.pipeline).unwrap_or_else(|| err.to_string());
                eprintln!("[voice] the speaker did not start again: {detail}");
            }
        } else {
            self.src.send_event(gst::event::FlushStart::new());
            self.src.send_event(gst::event::FlushStop::new(true));
        }
        result.map(|speech| (speech, rate))
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

/// The shortest and longest a voice's reference may be, in seconds: too
/// short and the voice is a guess, too long and every sentence is slower
/// (Qwen3-TTS reads the whole reference before each one).
const MIN_REFERENCE_SECONDS: f32 = 3.0;
const MAX_REFERENCE_SECONDS: f32 = 30.0;

/// The recording at `path`, without its silences, checked.
fn reference_samples(path: &str) -> Result<Vec<f32>, String> {
    let samples = reference::decode(path)?;
    let trimmed = reference::trim(&samples).to_vec();
    let seconds = trimmed.len() as f32 / clone::RATE as f32;
    if seconds < MIN_REFERENCE_SECONDS {
        return Err(if trimmed.is_empty() {
            "No speech in the recording: is the microphone on?".to_string()
        } else {
            format!("Only {seconds:.1} s of speech: speak a little longer")
        });
    }
    if seconds > MAX_REFERENCE_SECONDS {
        return Err(format!(
            "{seconds:.0} s of speech: keep it under {MAX_REFERENCE_SECONDS:.0} s"
        ));
    }
    Ok(trimmed)
}

/// The clone_voice op: the voice in `request.audio`, and what was heard.
fn clone_voice(config: &Config, request: Request) -> Result<Value, String> {
    let audio = request.audio.ok_or("audio is required")?;
    let model = request.model.ok_or("model is required")?;
    let samples = reference_samples(&audio)?;
    if let Some(path) = &request.reference {
        reference::write_wav(path, &samples)?;
    }
    let transcriber = match (&config.parakeet_model, &config.whisper_model) {
        (Some(dir), _) => Some(listen::Model::Parakeet(dir)),
        (None, Some(path)) => Some(listen::Model::Whisper(path)),
        (None, None) => None,
    };
    // Without it, the text shown to read is taken as said.
    let heard = match transcriber {
        Some(model) => reference::transcribe(&samples, model, request.language.as_deref())
            .map_err(|e| format!("Transcribing the recording failed: {e}"))?,
        None => String::new(),
    };
    let voice = clone::Cloner::load(std::path::Path::new(&model))?.clone_voice(&samples)?;
    Ok(json!({
        "embedding": voice.embedding,
        "codes": voice.codes,
        "heard": heard,
        "seconds": samples.len() as f32 / clone::RATE as f32,
    }))
}

/// `--clone`: the voice of `audio`, written to `--output`.
fn clone_to_file(audio: &str) -> Result<String, String> {
    let model = arg("--model").ok_or("--model <Qwen3-TTS Base dir> is required")?;
    let output = arg("--output").ok_or("--output <voice.json> is required")?;
    let samples = reference_samples(audio)?;
    let started = std::time::Instant::now();
    let voice = clone::Cloner::load(std::path::Path::new(&model))?.clone_voice(&samples)?;
    let mut json = json!({
        "data": voice.embedding,
        "shape": [voice.embedding.len()],
        "model_type": "qwen3-tts",
    });
    // Without the words, only the timbre is cloned.
    if let Some(text) = arg("--text").filter(|text| !text.trim().is_empty()) {
        json["prompt"] = json!({"codes": voice.codes, "text": text.trim()});
    }
    std::fs::write(&output, json.to_string()).map_err(|e| format!("{output}: {e}"))?;
    Ok(format!(
        "{output}: {:.2} s of speech, {} frames, in {:.1} s",
        samples.len() as f32 / clone::RATE as f32,
        voice.codes.len(),
        started.elapsed().as_secs_f32()
    ))
}

fn main() {
    // webrtcsink's signalling server (call.rs) logs every message, offers
    // and candidates included, at its default level: only its warnings,
    // unless asked for.
    if std::env::var_os("WEBRTCSINK_SIGNALLING_SERVER_LOG").is_none() {
        // SAFETY: no other thread runs yet.
        unsafe { std::env::set_var("WEBRTCSINK_SIGNALLING_SERVER_LOG", "warn") };
    }
    if let Err(err) = gst::init() {
        eprintln!("GStreamer failed to initialize: {err}");
        std::process::exit(1);
    }
    // Our plugins are linked in, not looked up on disk.
    if let Err(err) = gstwhisper::plugin_register_static()
        .and_then(|_| gstkokoro::plugin_register_static())
        .and_then(|_| gstanytts::plugin_register_static())
        .and_then(|_| gstparakeet::plugin_register_static())
        .and_then(|_| gstspeechgate::plugin_register_static())
        .and_then(|_| gstrsaudiofx::plugin_register_static())
        .and_then(|_| gstrswebrtc::plugin_register_static())
        .and_then(|_| gstreqwest::plugin_register_static())
    {
        eprintln!("The speech plugins failed to register: {err}");
        std::process::exit(1);
    }
    #[cfg(target_os = "macos")]
    {
        let swept = processtap::sweep();
        if swept > 0 {
            eprintln!("removed {swept} process tap device(s) left over");
        }
    }
    #[cfg(target_os = "macos")]
    if let Err(err) = processtap::register() {
        eprintln!("The speech plugins failed to register: {err}");
        std::process::exit(1);
    }
    if let Some(audio) = arg("--clone") {
        std::process::exit(match clone_to_file(&audio) {
            Ok(summary) => {
                println!("{summary}");
                0
            }
            Err(err) => {
                eprintln!("{err}");
                1
            }
        });
    }
    let config = Arc::new(Config {
        whisper_model: arg("--whisper-model"),
        parakeet_model: arg("--parakeet-model"),
        speaker_model: arg("--speaker-model"),
        drop_other_voices: std::env::args().any(|arg| arg == "--drop-other-voices"),
        turn_model: arg("--turn-model"),
        text_turn_model: arg("--text-turn-model"),
        turn_give_up_ms: arg("--turn-give-up-ms").and_then(|ms| ms.parse().ok()),
        speaker_reference: arg("--speaker-reference"),
        kokoro_model: arg("--kokoro-model"),
        kokoro_voices: arg("--kokoro-voices"),
        tts_models: arg("--tts-models"),
    });
    // From here on, only frames reach Roamgate's end of stdout: a call's
    // webrtcsink logs to stdout, and a log line there would be read as a
    // frame's length, so nothing after it would be understood.
    let frames: Box<dyn std::io::Write + Send> = match frames::take_stdout() {
        Ok(file) => Box::new(file),
        Err(err) => {
            eprintln!("stdout is shared with the frames: {err}");
            Box::new(std::io::stdout())
        }
    };
    let output: Output = Arc::new(Mutex::new(frames));

    let calls: Calls = Arc::new(Mutex::new(None));
    // Whether a new speaker's voice is learnt from what is heard: no music
    // meanwhile. Before any listening, a speaker check without the
    // speaker's recordings has no voice yet.
    let learns = config.speaker_model.is_some()
        && config.drop_other_voices
        && config.speaker_reference.is_none();
    let learning = Arc::new(AtomicBool::new(learns));
    // The language of the last reply read or thing said, for Whisper to
    // read again what Parakeet wrote in English (reread.rs).
    let conversation: reread::Conversation = Arc::default();
    let (listen_tx, listen_rx) = mpsc::channel::<listen::Command>();
    let (speak_tx, speak_rx) = mpsc::channel::<Request>();
    let (call_tx, call_rx) = mpsc::channel::<Request>();
    let calling = {
        let output = output.clone();
        let calls = calls.clone();
        let listen = listen_tx.clone();
        let learning = learning.clone();
        std::thread::spawn(move || {
            for request in call_rx {
                let answer = call_op(&output, &calls, &listen, &learning, &request);
                reply(&output, answer);
            }
        })
    };

    let (youtube_tx, youtube_rx) = mpsc::channel::<Request>();
    let youtubing = {
        let output = output.clone();
        let calls = calls.clone();
        std::thread::spawn(move || {
            for request in youtube_rx {
                let answer = youtube_op(&output, &calls, &request);
                reply(&output, answer);
            }
        })
    };

    let listening = {
        let output = output.clone();
        let config = config.clone();
        let calls = calls.clone();
        let conversation = conversation.clone();
        let learning = learning.clone();
        std::thread::spawn(move || {
            // With Parakeet, Whisper's model is for reading again.
            let reread = config
                .parakeet_model
                .as_ref()
                .and(config.whisper_model.as_deref())
                .map(|model| Arc::new(reread::Reread::new(model, conversation)));
            let emit: listen::Emit = {
                let output = output.clone();
                let calls = calls.clone();
                Arc::new(move |event| {
                    // The user talks from speech_start to final (or to
                    // the utterance's cancellation, which has no final):
                    // the call's music ducks meanwhile.
                    let kind = event.get("event").and_then(Value::as_str);
                    let talking = match kind {
                        Some("speech_start") => Some(true),
                        Some("final" | "speech_cancelled") => Some(false),
                        _ => None,
                    };
                    if let (Some(talking), Some(call)) = (talking, calls.lock().unwrap().as_ref()) {
                        call.set_user_talking(talking);
                    }
                    if kind == Some("speech_cancelled") {
                        return;
                    }
                    reply(&output, event)
                })
            };
            // Made again after it failed.
            let mut listener: Option<listen::Listener> = None;
            loop {
                let command = match listen_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if let Some(error) = listener.as_ref().and_then(|l| l.error()) {
                    listener = None;
                    reply(&output, json!({"event": "error", "error": error}));
                }
                // The call's music heard at the page holds the gate.
                if let Some(listener) = listener.as_mut() {
                    let audible = calls
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|call| call.music_audible());
                    listener.music(audible);
                }
                // No music while a new speaker's voice is learnt from what
                // is heard: the speaker check would take a singer's.
                let learning_now = listener
                    .as_mut()
                    .map_or(learns, |listener| listener.learning_voice());
                learning.store(learning_now, Ordering::SeqCst);
                let call = calls.lock().unwrap().clone();
                // The music's source going silent, or the music held down
                // with nobody talking: told with what the media players say
                // (asked aside, a player may take seconds to answer).
                if let Some(call) = call.as_ref()
                    && let Some(change) = call.music_watch()
                {
                    let id = call.id;
                    std::thread::spawn(move || {
                        eprintln!("call {id}: {change}; media players: {}", mpris::describe());
                    });
                }
                if let Some(call) = call
                    && let Some(waiting) = call.wait_for_voice(learning_now)
                {
                    reply(
                        &output,
                        json!({"event": "call_music", "call": call.id, "waiting": waiting}),
                    );
                }
                let Some(command) = command else { continue };
                // Only a new session tries again; its audio is dropped meanwhile.
                let starting = matches!(command, listen::Command::Start { .. });
                if listener.is_none() && !starting {
                    continue;
                }
                // The session waits while the models load (seconds, from a
                // helper just started): its audio waits too, heard after.
                let session = match &command {
                    listen::Command::Start { id, .. } if listener.is_none() => Some(*id),
                    _ => None,
                };
                if let Some(session) = session {
                    reply(
                        &output,
                        json!({"event": "listen_loading", "session": session}),
                    );
                }
                if listener.is_none() {
                    let model = match (&config.parakeet_model, &config.whisper_model) {
                        (Some(dir), _) => listen::Model::Parakeet(dir),
                        (None, Some(model)) => listen::Model::Whisper(model),
                        (None, None) => {
                            let error = "--parakeet-model or --whisper-model is required";
                            reply(&output, json!({"event": "error", "error": error}));
                            continue;
                        }
                    };
                    let reference = config.speaker_reference.as_deref().and_then(|json| {
                        serde_json::from_str::<Vec<String>>(json)
                            .map_err(|e| format!("--speaker-reference: {e}"))
                            .and_then(|paths| listen::reference_voice(&paths))
                            .inspect_err(|error| {
                                eprintln!("the speaker's reference is not used: {error}")
                            })
                            .ok()
                    });
                    match listen::Listener::new(
                        model,
                        config.speaker_model.as_deref(),
                        config.drop_other_voices,
                        config.turn_model.as_deref(),
                        config.text_turn_model.as_deref(),
                        config.turn_give_up_ms,
                        reference,
                        reread.clone(),
                        emit.clone(),
                    ) {
                        Ok(created) => {
                            listener = Some(created);
                            if let Some(session) = session {
                                reply(
                                    &output,
                                    json!({"event": "listen_ready", "session": session}),
                                );
                            }
                        }
                        Err(error) => {
                            reply(&output, json!({"event": "error", "error": error}));
                            continue;
                        }
                    }
                }
                listener.as_mut().unwrap().handle(command);
            }
        })
    };
    let speaking = {
        let output = output.clone();
        let config = config.clone();
        let calls = calls.clone();
        let conversation = conversation.clone();
        std::thread::spawn(move || {
            let mut speaker = Speaker::new(&config);
            // Progress, for the server's watch on a stuck speaker: ready
            // (its models loaded), each request started, a voice loading,
            // its first audio.
            reply(
                &output,
                json!({"event": "speak_progress", "stage": "ready"}),
            );
            // What every sentence is read with, and what the speaker has now.
            let mut models = config.tts_models.clone();
            let mut current = models.clone();
            for request in speak_rx {
                if request.op == "set_tts_models" {
                    let result = match &request.tts_models {
                        None => Err("tts_models is required".to_string()),
                        Some(wanted) => {
                            let result = match &speaker {
                                Ok(speaker) => speaker.set_models(wanted),
                                // Made again with them, since it failed.
                                Err(_) => Speaker::new(&Config {
                                    tts_models: Some(wanted.clone()),
                                    ..config.as_ref().clone()
                                })
                                .map(|made| speaker = Ok(made)),
                            };
                            if result.is_ok() {
                                models = Some(wanted.clone());
                                current = models.clone();
                            }
                            result
                        }
                    };
                    reply(
                        &output,
                        match result {
                            Ok(()) => json!({"id": request.id, "ok": true}),
                            Err(error) => json!({"id": request.id, "error": error}),
                        },
                    );
                    continue;
                }
                let text = request.text.unwrap_or_default();
                let language = request.language.unwrap_or_else(|| language::detect(&text));
                if language::has_words(&text) {
                    *conversation.lock().unwrap() = Some(language.clone());
                }
                let progress = |stage: &str| {
                    reply(
                        &output,
                        json!({"event": "speak_progress", "id": request.id, "stage": stage}),
                    )
                };
                progress("started");
                // This sentence's own models, or back to everyone's.
                let wanted = request.tts_models.or_else(|| models.clone());
                let switched = match &speaker {
                    Ok(speaker) if wanted != current => match &wanted {
                        Some(wanted) => {
                            progress("loading");
                            speaker.set_models(wanted).map(|()| true)
                        }
                        None => Ok(false),
                    },
                    _ => Ok(false),
                };
                if let Ok(true) = switched {
                    current = wanted;
                }
                // For a call: into its mix, not to a file.
                let call = request
                    .call
                    .and_then(|id| calls.lock().unwrap().clone().filter(|call| call.id == id));
                if request.call.is_some() && call.is_none() {
                    let error = format!("no call {}", request.call.unwrap_or_default());
                    reply(&output, json!({"id": request.id, "error": error}));
                    continue;
                }
                // Each voice has its own level, and any-tts reads each
                // language with the first of its models that speaks it.
                let voice = format!("{}|{language}", current.as_deref().unwrap_or(""));
                let mut sentence = call.as_ref().map(|call| call.sentence_of(&voice));
                let result = match (&speaker, switched) {
                    (_, Err(err)) => Err(err),
                    (Ok(speaker), _) if language::has_words(&text) => speaker.speak(
                        &text,
                        &language,
                        request.rate.unwrap_or(1.0),
                        sentence.as_mut(),
                        &|| progress("audio"),
                    ),
                    (Ok(_), _) => Err("nothing to say".to_string()),
                    (Err(err), _) => Err(err.clone()),
                };
                let answer = match (result, sentence) {
                    (Ok((_, rate)), Some(sentence)) => {
                        let (start_ms, duration_ms) = sentence.finish();
                        // Where the mix is now: the page times the
                        // sentence's end from it.
                        let now_ms = call.as_ref().map_or(0, |call| call.now().mseconds());
                        json!({
                            "id": request.id,
                            "queued": true,
                            "start_ms": start_ms,
                            "duration_ms": duration_ms,
                            "now_ms": now_ms,
                            "language": language,
                            "rate": rate,
                        })
                    }
                    (Ok((audio, rate)), None) => json!({
                        "id": request.id,
                        "audio": BASE64.encode(audio),
                        "language": language,
                        "rate": rate,
                    }),
                    (Err(error), _) => json!({"id": request.id, "error": error}),
                };
                reply(&output, answer);
            }
        })
    };

    let mut stdin = std::io::stdin().lock();
    loop {
        let (kind, payload) = match frames::read(&mut stdin) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(err) => {
                eprintln!("bad input: {err}");
                break;
            }
        };
        if kind == frames::AUDIO {
            if payload.len() >= 4 {
                let id = u32::from_le_bytes(payload[..4].try_into().unwrap());
                let _ = listen_tx.send(listen::Command::Audio {
                    id,
                    samples: payload[4..].to_vec(),
                });
            }
            continue;
        }
        let request: Request = match serde_json::from_slice(&payload) {
            Ok(request) => request,
            Err(err) => {
                reply(&output, json!({"id": null, "error": err.to_string()}));
                continue;
            }
        };
        let session = request.session.unwrap_or_default();
        let sent = match request.op.as_str() {
            "speak" | "set_tts_models" => speak_tx.send(request).map_err(|e| e.0),
            "clone_voice" => {
                let output = output.clone();
                let config = config.clone();
                std::thread::spawn(move || {
                    let id = request.id.clone();
                    reply(
                        &output,
                        match clone_voice(&config, request) {
                            Ok(mut answer) => {
                                answer["id"] = id;
                                answer
                            }
                            Err(error) => json!({"id": id, "error": error}),
                        },
                    );
                });
                Ok(())
            }
            "listen_start" => {
                let _ = listen_tx.send(listen::Command::Start {
                    id: session,
                    hold: request.hold,
                    end_silence_ms: request.end_silence_ms,
                    language: request.language,
                    new_speaker: request.new_speaker,
                    call: request.call,
                    user_voice: request.user_voice.map(|user| voices::User {
                        voices: user.voices,
                        id: user.id,
                        prints: user.prints,
                    }),
                });
                Ok(())
            }
            "listen_release" => {
                let _ = listen_tx.send(listen::Command::Release { id: session });
                Ok(())
            }
            "listen_finish" => {
                let _ = listen_tx.send(listen::Command::Finish { id: session });
                Ok(())
            }
            "listen_stop" => {
                if let Some(call) = calls.lock().unwrap().as_ref() {
                    call.set_user_talking(false);
                }
                let _ = listen_tx.send(listen::Command::Stop { id: session });
                Ok(())
            }
            "call_start" | "call_stop" | "call_hush" | "call_music" | "call_microphone" => {
                // call_start parses a description and starts a pipeline: not
                // on the input thread, which carries the microphone. One
                // thread, so they keep their order.
                call_tx.send(request).map_err(|e| e.0)
            }
            "call_youtube" => youtube_tx.send(request).map_err(|e| e.0),
            "ping" => {
                reply(&output, json!({"id": request.id, "ok": true}));
                Ok(())
            }
            _ => Err(request),
        };
        if let Err(request) = sent {
            reply(
                &output,
                json!({"id": request.id, "error": format!("unknown op {}", request.op)}),
            );
        }
    }
    // Roamgate closed stdin: it is gone, so is the helper, once the models
    // are put away. It is also how Roamgate stops a helper run through a
    // wrapper, which may not pass signals on: a thread stuck in a model
    // would hold the joins below forever, so the process ends regardless
    // EXIT_GRACE on.
    std::thread::spawn(|| {
        std::thread::sleep(EXIT_GRACE);
        eprintln!(
            "still stopping {} s after stdin closed: exiting",
            EXIT_GRACE.as_secs()
        );
        std::process::exit(0);
    });
    drop((listen_tx, speak_tx, call_tx, youtube_tx));
    let _ = youtubing.join();
    let _ = calling.join();
    calls.lock().unwrap().take();
    let _ = listening.join();
    let _ = speaking.join();
    // A call's pipelines stop on threads of their own: a teardown that
    // never ends leaves GStreamer as it is, for the process to end.
    if !call::finish_stopping(Duration::from_secs(5)) {
        eprintln!("a call's pipeline is still stopping: exiting without it");
        std::process::exit(0);
    }
    // SAFETY: every GStreamer object is gone with the threads above.
    unsafe { gst::deinit() };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// call_youtube's request, as Roamgate sends it (voice-youtube.ts).
    #[test]
    fn a_call_youtube_request_reads_as_the_call_takes_it() {
        let request: Request = serde_json::from_str(
            r#"{"id": 6, "op": "call_youtube", "call": 7, "action": "play",
                "url": "https://rr1.googlevideo.com/videoplayback?x=1",
                "headers": {"User-Agent": "Mozilla/5.0", "Cookie": "a=1"},
                "volume": 0.5, "pause_mpris": "org.mpris.MediaPlayer2.spotify"}"#,
        )
        .unwrap();
        assert_eq!(request.call, Some(7));
        assert_eq!(
            youtube_request(&request),
            call::YoutubeRequest {
                action: "play".into(),
                url: "https://rr1.googlevideo.com/videoplayback?x=1".into(),
                headers: [
                    ("Cookie".to_string(), "a=1".to_string()),
                    ("User-Agent".to_string(), "Mozilla/5.0".to_string()),
                ]
                .into(),
                volume: Some(0.5),
                position: None,
                pause_mpris: Some("org.mpris.MediaPlayer2.spotify".into()),
            }
        );
        let seek: Request = serde_json::from_str(
            r#"{"id": 8, "op": "call_youtube", "call": 7, "action": "seek", "position": 42.5}"#,
        )
        .unwrap();
        let seek = youtube_request(&seek);
        assert_eq!((seek.action.as_str(), seek.position), ("seek", Some(42.5)));
        assert!(seek.headers.is_empty());
    }

    /// Without a call, a YouTube request says so.
    #[test]
    fn call_youtube_without_its_call_is_an_error() {
        gst::init().unwrap();
        let output: Output = Arc::new(Mutex::new(Box::new(std::io::sink())));
        let calls: Calls = Arc::new(Mutex::new(None));
        let request: Request = serde_json::from_str(
            r#"{"id": 9, "op": "call_youtube", "call": 3, "action": "status"}"#,
        )
        .unwrap();
        assert_eq!(
            youtube_op(&output, &calls, &request),
            json!({"id": 9, "error": "no call 3"})
        );
    }

    /// Sentences of many small buffers (as Qwen3-TTS streams them) through
    /// the speaker's branches, flushed between them as speak() does: every
    /// one reaches both sinks' EOS. With async sinks, the second one
    /// deadlocked in the raw sink's preroll.
    #[test]
    fn many_small_buffers_never_block_the_speaker() {
        gst::init().unwrap();
        let pipeline = gst::parse::launch(SPEAK_PIPELINE)
            .unwrap()
            .downcast::<gst::Pipeline>()
            .unwrap();
        let audio = gst_app::AppSrc::builder()
            .caps(
                &gst::Caps::builder("audio/x-raw")
                    .field("format", "F32LE")
                    .field("layout", "interleaved")
                    .field("rate", 24_000i32)
                    .field("channels", 1i32)
                    .build(),
            )
            .format(gst::Format::Time)
            .build();
        pipeline.add(&audio).unwrap();
        audio.link(&pipeline.by_name("convert").unwrap()).unwrap();
        let sink = pipeline
            .by_name("sink")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        let raw = pipeline
            .by_name("raw")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        // As in speak(): in a call only the raw branch gets the speech,
        // otherwise only the ogg branch; the other drops it.
        let to_call = Arc::new(std::sync::atomic::AtomicBool::new(true));
        for (queue, wanted) in [("oggq", false), ("rawq", true)] {
            let to_call = to_call.clone();
            pipeline
                .by_name(queue)
                .unwrap()
                .static_pad("src")
                .unwrap()
                .add_probe(gst::PadProbeType::BUFFER, move |_, _| {
                    if to_call.load(std::sync::atomic::Ordering::SeqCst) == wanted {
                        gst::PadProbeReturn::Ok
                    } else {
                        gst::PadProbeReturn::Drop
                    }
                });
        }
        pipeline.set_state(gst::State::Playing).unwrap();
        for round in 0..4 {
            to_call.store(round % 2 == 0, std::sync::atomic::Ordering::SeqCst);
            for i in 0..600u64 {
                let mut buffer = gst::Buffer::from_slice(vec![0u8; 64 * 4]);
                let pts = gst::ClockTime::from_nseconds(i * 64 * 1_000_000_000 / 24_000);
                buffer.get_mut().unwrap().set_pts(pts);
                audio.push_buffer(buffer).unwrap();
            }
            let _ = audio.end_of_stream();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                while raw.try_pull_sample(gst::ClockTime::ZERO).is_some() {}
                while sink
                    .try_pull_sample(gst::ClockTime::from_mseconds(5))
                    .is_some()
                {}
                if sink.is_eos() && raw.is_eos() {
                    break;
                }
                assert!(Instant::now() < deadline, "sentence {round} never ended");
            }
            audio.send_event(gst::event::FlushStart::new());
            audio.send_event(gst::event::FlushStop::new(true));
        }
        pipeline.set_state(gst::State::Null).unwrap();
    }

    /// A synthesizer failing (Qwen3-TTS out of GPU memory) fails its
    /// sentence, though appsrc sends EOS after its error: it came out as a
    /// sentence said, silent, and the server did not have Kokoro say it.
    /// The next sentence fails with its own error, not left stuck.
    #[test]
    fn a_failed_sentence_is_an_error() {
        gst::init().unwrap();
        // identity fails on the text it gets (it makes no audio): appsrc
        // posts an error and sends EOS, as when the synthesizer fails.
        let failing = gst::ElementFactory::make("identity").build().unwrap();
        let speaker = Speaker::with_synthesizer(failing, "failing").unwrap();
        for _ in 0..2 {
            let result = speaker.speak("Bonjour.", "fr", 1.0, None, &|| {});
            let error = result.expect_err("a failed sentence said");
            assert!(error.contains("streaming stopped"), "{error}");
        }
    }
}
