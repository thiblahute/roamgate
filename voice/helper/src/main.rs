//! Roamgate's voice helper. Roamgate starts it and keeps it running, so the
//! speech models stay loaded, and talks to it in frames (see `frames`):
//! JSON objects, and raw audio.
//!
//! Listening (see `listen`), for one session at a time:
//! - `{"op": "listen_start", "session": 3, "hold": true, "language": "es",
//!   "end_silence_ms": 2500, "new_speaker": true}`, then AUDIO frames for
//!   session 3; with `--speaker-model`, only the voice of whoever spoke
//!   first since a `new_speaker` start counts;
//! - `{"op": "listen_release", "session": 3}` once a reply stops playing;
//! - `{"op": "listen_finish", "session": 3}` ends the utterance now,
//!   `{"op": "listen_stop", "session": 3}` drops it.
//!
//! It answers with events: `{"event": "speech_start", "session": 3}`,
//! `{"event": "text", ...}` as Whisper goes, or
//! `{"event": "partial", ...}` with all heard so far as Parakeet (with
//! `--parakeet-model`) reads it again, and `{"event": "final",
//! "session": 3, "text": "...", "speech_ms": 1800}`.
//!
//! Speaking: `{"id": 2, "op": "speak", "text": "...", "language": "fr"}`, one
//! sentence to Ogg Opus speech, in the language given or the one its words
//! look like: `{"id": 2, "audio": "<base64>", "language": "fr"}`. Kokoro
//! reads it, or with `--tts-models` the first of those any-tts models that
//! speaks its language.
//!
//! A failed request answers `{"id": ..., "error": "..."}`. Listening and
//! speaking run on threads of their own, so neither waits for the other.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use gst::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

mod frames;
mod language;
mod listen;

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
}

struct Config {
    whisper_model: Option<String>,
    /// Parakeet TDT, in place of Whisper.
    parakeet_model: Option<String>,
    /// Speaker embeddings (WeSpeaker ResNet34 ONNX): keep the first voice.
    speaker_model: Option<String>,
    /// Smart Turn v3: whether a pause ends the speaker's turn.
    turn_model: Option<String>,
    /// A small language model reading whether the words are finished.
    text_turn_model: Option<String>,
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

type Output = Arc<Mutex<std::io::Stdout>>;

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

/// Text to speech: one pipeline kept playing, from a synthesizer to Ogg
/// Opus (small enough for a phone on the go), a sentence at a time. Each
/// sentence ends with EOS, so oggmux finishes a file the browser can play
/// on its own, then a flush readies the pipeline for the next one, which
/// starts a new file from zero.
struct Speaker {
    pipeline: gst::Pipeline,
    src: gst_app::AppSrc,
    sink: gst_app::AppSink,
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
        let pipeline = gst::parse::launch(
            "appsrc name=src format=time caps=text/x-raw,format=utf8 ! \
             audioconvert name=convert ! audioresample ! opusenc bitrate=32000 ! oggmux ! \
             appsink name=sink sync=false",
        )
        .map_err(|e| e.to_string())?
        .downcast::<gst::Pipeline>()
        .unwrap();
        // appsrc ! synthesizer ! audioconvert: the synthesizer goes between.
        let src_element = pipeline.by_name("src").unwrap();
        let convert = pipeline.by_name("convert").unwrap();
        src_element.unlink(&convert);
        pipeline.add(&synthesizer).unwrap();
        gst::Element::link_many([&src_element, &synthesizer, &convert])
            .map_err(|e| e.to_string())?;
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
            let detail = pipeline
                .bus()
                .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]))
                .and_then(|message| match message.view() {
                    gst::MessageView::Error(e) => {
                        Some(format!("{} ({})", e.error(), e.debug().unwrap_or_default()))
                    }
                    _ => None,
                });
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!(
                "{name} failed to load: {}",
                detail.unwrap_or_else(|| err.to_string())
            ));
        }
        dump_dot(&pipeline, "roamgate-voice-speak");
        Ok(Self {
            pipeline,
            src,
            sink,
        })
    }

    fn speak(&self, text: &str, language: &str) -> Result<Vec<u8>, String> {
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
        let result = loop {
            if let Some(sample) = self
                .sink
                .try_pull_sample(gst::ClockTime::from_mseconds(100))
            {
                if let Some(buffer) = sample.buffer() {
                    let map = buffer.map_readable().map_err(|e| e.to_string())?;
                    speech.extend_from_slice(&map);
                }
                continue;
            }
            if self.sink.is_eos() {
                break Ok(speech);
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
        self.src.send_event(gst::event::FlushStart::new());
        self.src.send_event(gst::event::FlushStop::new(true));
        result
    }
}

impl Drop for Speaker {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

fn main() {
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
    {
        eprintln!("The speech plugins failed to register: {err}");
        std::process::exit(1);
    }
    let config = Arc::new(Config {
        whisper_model: arg("--whisper-model"),
        parakeet_model: arg("--parakeet-model"),
        speaker_model: arg("--speaker-model"),
        turn_model: arg("--turn-model"),
        text_turn_model: arg("--text-turn-model"),
        kokoro_model: arg("--kokoro-model"),
        kokoro_voices: arg("--kokoro-voices"),
        tts_models: arg("--tts-models"),
    });
    let output: Output = Arc::new(Mutex::new(std::io::stdout()));

    let (listen_tx, listen_rx) = mpsc::channel::<listen::Command>();
    let (speak_tx, speak_rx) = mpsc::channel::<Request>();

    let listening = {
        let output = output.clone();
        let config = config.clone();
        std::thread::spawn(move || {
            let emit: listen::Emit = {
                let output = output.clone();
                Arc::new(move |event| reply(&output, event))
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
                let Some(command) = command else { continue };
                // Only a new session tries again; its audio is dropped meanwhile.
                let starting = matches!(command, listen::Command::Start { .. });
                if listener.is_none() && !starting {
                    continue;
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
                    match listen::Listener::new(
                        model,
                        config.speaker_model.as_deref(),
                        config.turn_model.as_deref(),
                        config.text_turn_model.as_deref(),
                        emit.clone(),
                    ) {
                        Ok(created) => listener = Some(created),
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
        std::thread::spawn(move || {
            let speaker = Speaker::new(&config);
            for request in speak_rx {
                let text = request.text.unwrap_or_default();
                let language = request.language.unwrap_or_else(|| language::detect(&text));
                let result = match &speaker {
                    Ok(speaker) if language::has_words(&text) => speaker.speak(&text, &language),
                    Ok(_) => Err("nothing to say".to_string()),
                    Err(err) => Err(err.clone()),
                };
                reply(
                    &output,
                    match result {
                        Ok(audio) => json!({
                            "id": request.id,
                            "audio": BASE64.encode(audio),
                            "language": language,
                        }),
                        Err(error) => json!({"id": request.id, "error": error}),
                    },
                );
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
            "speak" => speak_tx.send(request).map_err(|e| e.0),
            "listen_start" => {
                let _ = listen_tx.send(listen::Command::Start {
                    id: session,
                    hold: request.hold,
                    end_silence_ms: request.end_silence_ms,
                    language: request.language,
                    new_speaker: request.new_speaker,
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
                let _ = listen_tx.send(listen::Command::Stop { id: session });
                Ok(())
            }
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
    // are put away.
    drop((listen_tx, speak_tx));
    let _ = listening.join();
    let _ = speaking.join();
    // SAFETY: every GStreamer object is gone with the threads above.
    unsafe { gst::deinit() };
}
