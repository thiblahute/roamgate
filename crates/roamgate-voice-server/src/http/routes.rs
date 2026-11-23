//! `/api/voice` and the routes of http/voice.ts that are not the
//! companion's (createVoiceRoutes):
//!
//! - GET /api/voice: whether voice chat is set up, how fast replies are
//!   read (`speech_rate`), the longest pause (`max_pause_ms`), `surprise`
//!   with a voice library, `low_gpu` when the call has the light voice,
//!   `debug` with ROAMGATE_VOICE_DEBUG set, and what the companion layer
//!   adds ([`CompanionStatus`]).
//! - POST /api/voice/settings: `{speech_rate}`, `{max_pause_ms}` and
//!   `{front_mode}`, kept in voice.json.
//! - POST /api/voice/speak: `{text, language?, reading?, rate?, call?}`
//!   in, Ogg Opus speech out (or queued into the call's mix).
//! - POST /api/voice/timing and /api/voice/trace: logged.
//! - /api/voice/voices...: the voice library.
//!
//! The companion's routes (route, event, forward, errand, research, tools,
//! answers, companion memories and reset, image) are not here:
//! [`VoiceRoutes::handle`] answers None for them, as for any path not its
//! own, and the companion layer answers them.

use std::sync::{Arc, Mutex};

use roamgate_base::clock::BoxFuture;
use roamgate_base::log::{LogFields, Logger};
use serde_json::{Map, Value, json};

use super::{
    Answer, AnswerBody, Body, FormPart, Request, decode_uri_component, needs_header, parse_form,
};
use crate::config::{FrontMode, LONGEST_PAUSE_MS, MIN_PAUSE_MS, TtsModel, max_pause_ms};
use crate::helper::{ErrorSink, MusicChange, QueuedSpeech, Speech, VoiceHelper};
use crate::js;
use crate::library::{CreateInput, KOKORO, VoiceError, VoiceLibrary};
use crate::reading::{SAMPLE_SENTENCES, is_voice_language};
use crate::socket::CallLine;
use crate::speech_rate::is_speech_rate;
use crate::surprise::SurprisePicker;

const MAX_SPOKEN_CHARS: i64 = 4000;

/// The largest recording taken: 25 s of 48 kHz 16-bit WAV is 2.4 MB.
pub const MAX_RECORDING_BYTES: usize = 12 * 1024 * 1024;

/// What the routes ask of the voice helper ([`VoiceHelper`]; tests give a
/// fake).
pub trait VoiceSpeaker: Send + Sync + 'static {
    /// `{available: true}` or `{available: false, detail}`.
    fn status(&self) -> Value;
    fn speech_rate(&self) -> f64;
    fn set_speech_rate(&self, rate: f64) -> Result<(), String>;
    fn max_pause_ms(&self) -> f64;
    fn set_max_pause_ms(&self, ms: f64) -> Result<(), String>;
    /// "low-gpu" or "full", None when none runs.
    fn running_profile(&self) -> Option<&'static str>;
    fn low_gpu_reason(&self) -> Option<String>;
    fn speak(
        &self,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> BoxFuture<Result<Speech, String>>;
    fn speak_in_call(
        &self,
        call: u64,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> BoxFuture<Result<QueuedSpeech, String>>;
}

impl VoiceSpeaker for VoiceHelper {
    fn status(&self) -> Value {
        VoiceHelper::status(self)
    }

    fn speech_rate(&self) -> f64 {
        VoiceHelper::speech_rate(self)
    }

    fn set_speech_rate(&self, rate: f64) -> Result<(), String> {
        VoiceHelper::set_speech_rate(self, rate)
    }

    fn max_pause_ms(&self) -> f64 {
        VoiceHelper::max_pause_ms(self)
    }

    fn set_max_pause_ms(&self, ms: f64) -> Result<(), String> {
        VoiceHelper::set_max_pause_ms(self, ms)
    }

    fn running_profile(&self) -> Option<&'static str> {
        VoiceHelper::running_profile(self)
    }

    fn low_gpu_reason(&self) -> Option<String> {
        VoiceHelper::low_gpu_reason(self)
    }

    fn speak(
        &self,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> BoxFuture<Result<Speech, String>> {
        let helper = self.clone();
        Box::pin(async move {
            VoiceHelper::speak(&helper, &text, language.as_deref(), models, rate).await
        })
    }

    fn speak_in_call(
        &self,
        call: u64,
        text: String,
        language: Option<String>,
        models: Option<Vec<TtsModel>>,
        rate: Option<f64>,
    ) -> BoxFuture<Result<QueuedSpeech, String>> {
        let helper = self.clone();
        Box::pin(async move {
            VoiceHelper::speak_in_call(&helper, call, &text, language.as_deref(), models, rate)
                .await
        })
    }
}

/// What the routes ask of the voice library ([`VoiceLibrary`]; tests give
/// a fake).
pub trait Voices: Send + Sync + 'static {
    fn state(&self) -> Result<Value, VoiceError>;
    /// The voice made, as the wire has it (`{voice, heard, transcript,
    /// kind}`).
    fn create(&self, input: CreateInput) -> BoxFuture<Result<Value, VoiceError>>;
    fn assign(
        &self,
        voice: Option<String>,
        language: Value,
    ) -> BoxFuture<Result<Value, VoiceError>>;
    fn rename(&self, id: &str, name: &Value) -> Result<Value, VoiceError>;
    fn delete(&self, id: &str) -> Result<(), VoiceError>;
    fn sample_models(&self, id: &str) -> Result<Vec<TtsModel>, VoiceError>;
    fn set_surprise(&self, on: bool) -> Result<Value, VoiceError>;
    /// The voices Surprise picks from (each with `id` and `name`), None
    /// with Surprise off.
    fn surprise_voices(&self) -> Result<Option<Vec<Value>>, VoiceError>;
}

impl Voices for VoiceLibrary {
    fn state(&self) -> Result<Value, VoiceError> {
        VoiceLibrary::state(self)
    }

    fn create(&self, input: CreateInput) -> BoxFuture<Result<Value, VoiceError>> {
        let library = self.clone();
        Box::pin(async move {
            let created = VoiceLibrary::create(&library, input).await?;
            Ok(json!({
                "voice": created.voice,
                "heard": created.heard,
                "transcript": created.transcript,
                "kind": created.kind,
            }))
        })
    }

    fn assign(
        &self,
        voice: Option<String>,
        language: Value,
    ) -> BoxFuture<Result<Value, VoiceError>> {
        let library = self.clone();
        Box::pin(async move { VoiceLibrary::assign(&library, voice.as_deref(), &language).await })
    }

    fn rename(&self, id: &str, name: &Value) -> Result<Value, VoiceError> {
        VoiceLibrary::rename(self, id, name)
    }

    fn delete(&self, id: &str) -> Result<(), VoiceError> {
        VoiceLibrary::delete(self, id)
    }

    fn sample_models(&self, id: &str) -> Result<Vec<TtsModel>, VoiceError> {
        VoiceLibrary::sample_models(self, id)
    }

    fn set_surprise(&self, on: bool) -> Result<Value, VoiceError> {
        VoiceLibrary::set_surprise(self, on)
    }

    fn surprise_voices(&self) -> Result<Option<Vec<Value>>, VoiceError> {
        VoiceLibrary::surprise_voices(self)
    }
}

/// What the companion layer adds to GET /api/voice (it warms its front or
/// router up when asked).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompanionStatus {
    /// A router or a front decides who words are for (`route`).
    pub route: bool,
    /// A front (`front`, with `front_mode`).
    pub front: bool,
    /// The companion's memory epoch, with a front and a memory.
    pub epoch: Option<f64>,
}

pub type CompanionStatusSource = Arc<dyn Fn() -> CompanionStatus + Send + Sync>;
pub type CurrentCall = Arc<dyn Fn() -> Option<Arc<dyn CallLine>> + Send + Sync>;

/// What the routes work with; unset parts are Bun's defaults.
pub struct RoutesOptions {
    pub library: Option<Arc<dyn Voices>>,
    pub companion: CompanionStatusSource,
    /// What the front does with answers (voice.json `front_mode`).
    pub mode: Arc<dyn Fn() -> Option<FrontMode> + Send + Sync>,
    pub save_mode: Arc<dyn Fn(FrontMode) -> Result<(), String> + Send + Sync>,
    /// The call the helper runs now (voice-socket.ts).
    pub current_call: CurrentCall,
    /// Who the low-GPU profile is on for, None off.
    pub low_gpu: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// ROAMGATE_VOICE_DEBUG is set (not empty).
    pub debug: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The voice's timing lines (`voice`'s logger).
    pub log: Logger,
    /// console.error.
    pub errors: ErrorSink,
    /// Where a recording waits while it is cloned (`os.tmpdir()`).
    pub temp_dir: std::path::PathBuf,
    pub surprise: SurprisePicker,
}

impl Default for RoutesOptions {
    fn default() -> Self {
        Self {
            library: None,
            companion: Arc::new(CompanionStatus::default),
            mode: Arc::new(|| None),
            save_mode: Arc::new(|_| Ok(())),
            current_call: Arc::new(|| None),
            low_gpu: Arc::new(|| None),
            debug: Arc::new(|| {
                std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some_and(|value| !value.is_empty())
            }),
            log: Logger::silent(),
            errors: Arc::new(|line| eprintln!("{line}")),
            temp_dir: std::env::temp_dir(),
            surprise: SurprisePicker::default(),
        }
    }
}

/// The routes (createVoiceRoutes, but for the companion's).
pub struct VoiceRoutes {
    helper: Arc<dyn VoiceSpeaker>,
    options: RoutesOptions,
    surprise: Mutex<SurprisePicker>,
}

/// A reply read by a Surprise voice: who, and the models reading as them.
struct Reader {
    name: String,
    models: Vec<TtsModel>,
}

impl VoiceRoutes {
    pub fn new(helper: Arc<dyn VoiceSpeaker>, mut options: RoutesOptions) -> Self {
        let surprise = std::mem::take(&mut options.surprise);
        Self {
            helper,
            options,
            surprise: Mutex::new(surprise),
        }
    }

    /// The light voice the call has: the running helper's low-GPU set,
    /// else the one the next helper starts with.
    fn light_voice(&self) -> Option<String> {
        if self.helper.running_profile() == Some("full") {
            return None;
        }
        self.helper
            .low_gpu_reason()
            .or_else(|| (self.options.low_gpu)())
    }

    /// The answer for `request`, None when the path is not one of these
    /// routes.
    pub async fn handle(&self, request: &Request) -> Option<Answer> {
        let path = request.path.as_str();
        let method = request.method.as_str();
        if path.starts_with("/api/voice/voices") {
            return Some(self.voices(request).await);
        }
        match (method, path) {
            ("GET", "/api/voice") => Some(self.status()),
            ("POST", "/api/voice/settings") => Some(self.settings(request)),
            ("POST", "/api/voice/timing") => Some(self.timing(request)),
            ("POST", "/api/voice/trace") => Some(self.trace(request)),
            (_, "/api/voice/speak") => Some(self.speak(request).await),
            _ => None,
        }
    }

    fn status(&self) -> Answer {
        let mut status = match self.helper.status() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let companion = (self.options.companion)();
        if companion.route || companion.front {
            status.insert("route".into(), json!(true));
        }
        if companion.front {
            status.insert("front".into(), json!(true));
            let mode = (self.options.mode)().unwrap_or(FrontMode::Companion);
            status.insert("front_mode".into(), json!(mode.as_str()));
            if let Some(epoch) = companion.epoch {
                status.insert("companion_epoch".into(), js::number(epoch));
            }
        }
        status.insert("speech_rate".into(), js::number(self.helper.speech_rate()));
        status.insert(
            "max_pause_ms".into(),
            js::number(self.helper.max_pause_ms()),
        );
        // `{surprise: library.state().surprise}`: nothing when unreadable.
        if let Some(library) = &self.options.library
            && let Ok(state) = library.state()
            && let Some(surprise) = state.get("surprise")
        {
            status.insert("surprise".into(), surprise.clone());
        }
        if let Some(light) = self.light_voice().filter(|light| !light.is_empty()) {
            status.insert("low_gpu".into(), json!(light));
        }
        if (self.options.debug)() {
            status.insert("debug".into(), json!(true));
        }
        Answer::json(200, Value::Object(status))
    }

    fn settings(&self, request: &Request) -> Answer {
        if !request.has_voice_header() {
            return needs_header();
        }
        let body = request.json_body();
        let field = |key: &str| {
            body.as_ref()
                .and_then(Value::as_object)
                .and_then(|body| body.get(key))
        };
        if let Some(pause) = field("max_pause_ms") {
            let valid = pause
                .as_f64()
                .is_some_and(|ms| max_pause_ms(Some(pause)) == ms);
            if !valid {
                return Answer::error(
                    400,
                    format!(
                        "max_pause_ms must be {} to {} ms.",
                        js::number_text(MIN_PAUSE_MS),
                        js::number_text(LONGEST_PAUSE_MS)
                    ),
                );
            }
            if let Err(message) = self
                .helper
                .set_max_pause_ms(pause.as_f64().unwrap_or_default())
            {
                return Answer::error(500, message);
            }
            if field("speech_rate").is_none() && field("front_mode").is_none() {
                return Answer::json(
                    200,
                    json!({ "max_pause_ms": js::number(self.helper.max_pause_ms()) }),
                );
            }
        }
        if let Some(wanted) = field("front_mode") {
            let Some(mode) = FrontMode::parse(wanted) else {
                return Answer::error(400, "front_mode must be \"companion\" or \"relay\".");
            };
            if let Err(message) = (self.options.save_mode)(mode) {
                return Answer::error(500, message);
            }
            if field("speech_rate").is_none() {
                let mode = (self.options.mode)().unwrap_or(mode);
                return Answer::json(200, json!({ "front_mode": mode.as_str() }));
            }
        }
        let rate = field("speech_rate").cloned().unwrap_or(Value::Null);
        if !is_speech_rate(&rate) {
            return Answer::error(400, "speech_rate must be a number from 0.5 to 2.");
        }
        if let Err(message) = self
            .helper
            .set_speech_rate(rate.as_f64().unwrap_or_default())
        {
            return Answer::error(500, message);
        }
        Answer::json(
            200,
            json!({ "speech_rate": js::number(self.helper.speech_rate()) }),
        )
    }

    fn timing(&self, request: &Request) -> Answer {
        if !request.has_voice_header() {
            return Answer::empty(403);
        }
        // Numbers and a few words only: nothing said goes in the log.
        let mut fields = LogFields::new();
        if let Some(Value::Object(body)) = request.json_body() {
            for (key, value) in body.iter().take(12) {
                let key_ok = (1..=24).contains(&key.len())
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
                if !key_ok {
                    continue;
                }
                match value {
                    Value::Number(number) => {
                        if let Some(number) = number.as_f64().filter(|number| number.is_finite()) {
                            fields.insert(key.clone(), js::number(js::round(number)));
                        }
                    }
                    Value::String(word)
                        if (1..=16).contains(&word.len())
                            && word.bytes().all(|byte| byte.is_ascii_lowercase()) =>
                    {
                        fields.insert(key.clone(), json!(word));
                    }
                    _ => {}
                }
            }
        }
        self.options
            .log
            .debug("voice turn first words", Some(&fields));
        Answer::empty(204)
    }

    fn trace(&self, request: &Request) -> Answer {
        if !request.has_voice_header() || !(self.options.debug)() {
            return Answer::empty(204);
        }
        if let Some(line) = request
            .json_body()
            .as_ref()
            .and_then(|body| body.get("line"))
            .and_then(Value::as_str)
        {
            (self.options.errors)(&format!("[voice-web] {}", js::slice16(line, 0, Some(500))));
        }
        Answer::empty(204)
    }

    /// With Surprise on, who reads this sentence of `reading` and the
    /// models that read in that voice; None to read as voice.json says
    /// (Surprise off, or the voices unreadable: a reply is read anyway).
    fn surprise_reader(&self, reading: Option<&str>) -> Option<Reader> {
        let library = self.options.library.as_ref()?;
        let voices = library.surprise_voices().ok()??;
        let ids: Vec<String> = voices
            .iter()
            .filter_map(|voice| voice.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let id = self
            .surprise
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .pick(&ids, reading)?;
        let voice = voices
            .iter()
            .find(|voice| voice.get("id").and_then(Value::as_str) == Some(id.as_str()))?;
        let name = match voice.get("name") {
            Some(Value::String(name)) => name.clone(),
            Some(other) => js::stringify(other),
            None => "undefined".into(),
        };
        let models = library.sample_models(&id).ok()?;
        Some(Reader { name, models })
    }

    async fn speak(&self, request: &Request) -> Answer {
        if request.method != "POST" {
            return Answer::text(405, "method not allowed");
        }
        if !request.has_voice_header() {
            return needs_header();
        }
        let body = request.json_body();
        let field = |key: &str| body.as_ref().and_then(|body| body.get(key));
        let text = field("text")
            .and_then(Value::as_str)
            .map(|text| js::trim(text).to_owned())
            .unwrap_or_default();
        if text.is_empty() {
            return Answer::error(400, "No text.");
        }
        let language = field("language")
            .and_then(Value::as_str)
            .filter(|code| code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_lowercase()))
            .map(str::to_owned);
        let spoken = js::slice16(&text, 0, Some(MAX_SPOKEN_CHARS));
        let reading = field("reading")
            .and_then(Value::as_str)
            .filter(|reading| js::len16(reading) <= 100);
        let reader = self.surprise_reader(reading);
        let rate = match field("rate") {
            Some(rate) if is_speech_rate(rate) => rate.as_f64().unwrap_or_default(),
            _ => self.helper.speech_rate(),
        };
        let models = reader.as_ref().map(|reader| reader.models.clone());
        // In a call: into its mix, which the page hears by WebRTC.
        if let Some(call) = (self.options.current_call)()
            && field("call").and_then(Value::as_f64) == Some(call.id() as f64)
        {
            match self
                .helper
                .speak_in_call(
                    call.id(),
                    spoken.clone(),
                    language.clone(),
                    models.clone(),
                    Some(rate),
                )
                .await
            {
                Ok(queued) => {
                    let mut answer = Answer::json(
                        200,
                        json!({
                            "queued": true,
                            "call": call.id(),
                            "start_ms": js::number(queued.start_ms),
                            "duration_ms": js::number(queued.duration_ms),
                            "now_ms": js::number(queued.now_ms),
                            "language": queued.language,
                            "native_rate": js::number(queued.native_rate),
                        }),
                    )
                    .no_store();
                    if let Some(reader) = &reader {
                        answer = answer.with(
                            "x-voice-name",
                            roamgate_agents::paths::encode_uri_component(&reader.name),
                        );
                    }
                    return answer;
                }
                // The call ended meanwhile: a file, as without one.
                Err(message) if message.starts_with("no call") => {}
                Err(message) => return Answer::error(502, message),
            }
        }
        match self
            .helper
            .speak(spoken, language, models, Some(rate))
            .await
        {
            Ok(speech) => speech_answer(speech, reader.map(|reader| reader.name).as_deref()),
            Err(message) => Answer::error(502, message),
        }
    }

    async fn voices(&self, request: &Request) -> Answer {
        let Some(library) = self.options.library.clone() else {
            return Answer::error(404, "No voice library.");
        };
        if request.method != "GET" && !request.has_voice_header() {
            return needs_header();
        }
        match self.voices_inner(request, library.as_ref()).await {
            Ok(answer) => answer,
            Err(error) => Answer::error(error.status.unwrap_or(502), error.message),
        }
    }

    async fn voices_inner(
        &self,
        request: &Request,
        library: &dyn Voices,
    ) -> Result<Answer, VoiceError> {
        let path = request.path.as_str();
        let method = request.method.as_str();
        // `(await req.json().catch(() => null)) ?? {}`.
        let body = || match request.json_body() {
            None | Some(Value::Null) => json!({}),
            Some(body) => body,
        };
        let field = |body: &Value, key: &str| body.get(key).cloned().unwrap_or(Value::Null);
        match (method, path) {
            ("GET", "/api/voice/voices") => return Ok(Answer::json(200, library.state()?)),
            ("POST", "/api/voice/voices") => {
                return Ok(Answer::json(
                    201,
                    self.create_voice(request, library).await?,
                ));
            }
            ("POST", "/api/voice/voices/assign") => {
                let body = body();
                let voice = match body.get("voice") {
                    Some(Value::Null) => None,
                    Some(Value::String(voice)) => Some(voice.clone()),
                    _ => return Ok(Answer::error(400, "Choose a voice.")),
                };
                let language = field(&body, "language");
                return Ok(Answer::json(200, library.assign(voice, language).await?));
            }
            ("POST", "/api/voice/voices/surprise") => {
                let Some(on) = body().get("on").and_then(Value::as_bool) else {
                    return Ok(Answer::error(400, "on must be true or false."));
                };
                return Ok(Answer::json(200, library.set_surprise(on)?));
            }
            ("POST", "/api/voice/voices/sample") => {
                let body = body();
                let Some(voice) = body.get("voice").and_then(Value::as_str) else {
                    return Ok(Answer::error(400, "Choose a voice."));
                };
                let models = library.sample_models(voice)?;
                let asked = body
                    .get("language")
                    .and_then(Value::as_str)
                    .filter(|code| is_voice_language(code));
                let spoken = match asked {
                    Some(code) => Some(code.to_owned()),
                    None if voice == KOKORO => Some("en".to_owned()),
                    None => {
                        let state = library.state()?;
                        known_language(&state, voice)
                    }
                };
                let code = spoken
                    .filter(|code| is_voice_language(code))
                    .unwrap_or_else(|| "en".into());
                let sentence = SAMPLE_SENTENCES
                    .iter()
                    .find(|(language, _)| *language == code)
                    .map_or("", |(_, sentence)| sentence);
                let speech = self
                    .helper
                    .speak(sentence.to_owned(), Some(code), Some(models), None)
                    .await
                    .map_err(|message| VoiceError {
                        status: None,
                        message,
                    })?;
                return Ok(speech_answer(speech, None));
            }
            _ => {}
        }
        let id = decode_uri_component(path.strip_prefix("/api/voice/voices/").unwrap_or(""))
            .map_err(|message| VoiceError {
                status: None,
                message,
            })?;
        if !id.is_empty() && !id.contains('/') {
            if method == "PATCH" {
                let name = field(&body(), "name");
                return Ok(Answer::json(200, library.rename(&id, &name)?));
            }
            if method == "DELETE" {
                library.delete(&id)?;
                return Ok(Answer::empty(204));
            }
        }
        Ok(Answer::error(404, "Not found."))
    }

    /// POST /api/voice/voices: the recording, kept while the helper clones
    /// it.
    async fn create_voice(
        &self,
        request: &Request,
        library: &dyn Voices,
    ) -> Result<Value, VoiceError> {
        let too_long = || VoiceError::new(413, "The recording is too long.");
        let length = request.get("content-length").map_or(Some(0.0), |value| {
            let value = js::trim(&value);
            if value.is_empty() {
                Some(0.0)
            } else {
                value.parse::<f64>().ok()
            }
        });
        if length.is_some_and(|length| length > MAX_RECORDING_BYTES as f64) {
            return Err(too_long());
        }
        let bytes = match &request.body {
            Body::TooLarge => return Err(too_long()),
            Body::Missing => &[][..],
            Body::Bytes(bytes) => bytes.as_slice(),
        };
        let form = parse_form(request.get("content-type").as_deref(), bytes);
        let part = |name: &str| {
            form.as_ref()
                .and_then(|form| form.iter().find(|part| part.name == name))
        };
        let audio =
            part("audio").filter(|audio| audio.filename.is_some() && !audio.data.is_empty());
        let Some(audio) = audio else {
            return Err(VoiceError::new(400, "No recording."));
        };
        if audio.data.len() > MAX_RECORDING_BYTES {
            return Err(too_long());
        }
        let text = |name: &str| {
            part(name).map_or(Value::Null, |part| {
                part.text().map_or_else(|| json!({}), Value::String)
            })
        };
        let path = self.options.temp_dir.join(format!(
            "roamgate-voice-{}.wav",
            roamgate_base::paths::random_uuid()
        ));
        std::fs::write(&path, &audio.data).map_err(|error| VoiceError {
            status: None,
            message: error.to_string(),
        })?;
        let input = CreateInput {
            name: text("name"),
            language: text("language"),
            text: text("text"),
            audio: path.display().to_string(),
            cut: part("cut").and_then(FormPart::text).as_deref() == Some("1"),
        };
        let created = library.create(input).await;
        let _ = std::fs::remove_file(&path);
        created
    }
}

/// A voice's own language: a recorded voice's first, a stock voice's
/// native one.
fn known_language(state: &Value, voice: &str) -> Option<String> {
    let find = |list: &str| {
        state
            .get(list)
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| entry.get("id").and_then(Value::as_str) == Some(voice))
            })
            .cloned()
    };
    if let Some(recorded) = find("voices") {
        return recorded
            .get("languages")
            .and_then(Value::as_array)
            .and_then(|languages| languages.first())
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    find("stock").and_then(|stock| {
        stock
            .get("native")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

/// Speech as Ogg Opus, its language and native rate in headers.
fn speech_answer(speech: Speech, name: Option<&str>) -> Answer {
    let mut answer = Answer {
        status: 200,
        headers: Vec::new(),
        body: AnswerBody::Bytes(speech.audio),
    }
    .with("content-type", "audio/ogg")
    .with("x-voice-language", speech.language)
    .with("x-voice-native-rate", js::number_text(speech.native_rate));
    if let Some(name) = name {
        answer = answer.with(
            "x-voice-name",
            roamgate_agents::paths::encode_uri_component(name),
        );
    }
    answer.no_store()
}

/// The call's music for the front's state: on, off, waiting (on, silent
/// until the user's voice is learnt), or none at all (callMusic).
pub fn call_music(call: Option<&dyn CallLine>) -> Option<&'static str> {
    let call = call.filter(|call| call.music())?;
    if !call.music_on() {
        return Some("off");
    }
    Some(if call.music_waiting() {
        "waiting"
    } else {
        "on"
    })
}

/// How much quieter or louder "down" and "up" make the music.
const MUSIC_STEP: f64 = 1.6;
const MUSIC_FLOOR: f64 = 0.05;

/// A front's "music" route (`{to: "music", music, reply?}`), applied to
/// the call's background: what the front said of it goes to the page as
/// its own answer. With no music playing, it is said instead (musicRoute).
pub async fn music_route(route: &Value, call: Option<&dyn CallLine>, errors: &ErrorSink) -> Value {
    let Some(call) = call.filter(|call| call.music()) else {
        return json!({ "to": "self", "reply": "No music is playing on this call." });
    };
    let music = route.get("music").and_then(Value::as_str).unwrap_or("");
    let changed = async {
        let now = call.music_level(MusicChange::default()).await?;
        let change = match music {
            "off" => MusicChange {
                volume: None,
                muted: Some(true),
            },
            "on" => MusicChange {
                volume: None,
                muted: Some(false),
            },
            _ => MusicChange {
                muted: Some(false),
                volume: Some(if music == "down" {
                    MUSIC_FLOOR.max(now.0 / MUSIC_STEP)
                } else {
                    (MUSIC_FLOOR.max(now.0) * MUSIC_STEP).min(1.0)
                }),
            },
        };
        let after = call.music_level(change).await?;
        Ok::<_, String>((now, after))
    };
    match changed.await {
        Ok((now, after)) => {
            // As the log tells it: "volume 0.60" or "off".
            let state = |(volume, muted): (f64, bool)| {
                if muted {
                    "off".to_owned()
                } else {
                    format!("volume {}", js::to_fixed(volume, 2))
                }
            };
            errors(&format!(
                "[voice] the call's music {music}: {} -> {}",
                state(now),
                state(after)
            ));
        }
        Err(message) => {
            errors(&format!(
                "[voice] the call's music {music} failed: {message}"
            ));
            return json!({ "to": "self", "reply": format!("The music: {message}") });
        }
    }
    match route
        .get("reply")
        .and_then(Value::as_str)
        .filter(|reply| !reply.is_empty())
    {
        Some(reply) => json!({ "to": "self", "reply": reply }),
        None => json!({ "to": "nobody" }),
    }
}

#[cfg(test)]
mod tests;
