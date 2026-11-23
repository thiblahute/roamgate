//! `pocketsynthesizer`: reads each text buffer with Pocket TTS, pushing the
//! speech out as it is decoded (24 kHz mono F32), so the first audio leaves
//! about 0.2 s after the text came in.
//!
//! Its `models` are the voices it reads with, one structure each, named
//! `pocket-tts`:
//! - `path`: the language's model directory (`model.safetensors`,
//!   `tokenizer.json`, `embeddings/`);
//! - `languages`: the languages it reads (ISO 639-1, comma separated), the
//!   first naming the model's config;
//! - `voice`: a voice of `embeddings/` by name, or a voice state's path
//!   (`.safetensors`); the language's default voice otherwise.
//!
//! The language follows the `language-code` tag of the stream (the helper
//! tags each sentence), or `language` without one. A language none of the
//! models reads is an error: a voice of another language would read it with
//! its accent.

use gst::glib;
use gst::prelude::*;
use gst::subclass::prelude::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use super::config::Config;
use super::model::{LoadOptions, TtsModel, VoiceState};

/// The f32 CPU backend, as Kyutai's binary runs by default (what was
/// measured: RTF 0.27 on four threads while a game ran).
type Backend = xn::Unquantized<f32, xn::CpuDevice>;

const SAMPLE_RATE: i32 = 24000;
const DEFAULT_LANGUAGE: &str = "en";

static CAT: LazyLock<gst::DebugCategory> = LazyLock::new(|| {
    gst::DebugCategory::new(
        "pocketsynthesizer",
        gst::DebugColorFlags::empty(),
        Some("Pocket TTS text to speech"),
    )
});

/// One entry of `models`.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub path: PathBuf,
    pub languages: Vec<String>,
    pub voice: Option<String>,
}

impl Entry {
    fn from_structure(structure: &gst::StructureRef) -> Result<Self, String> {
        let path = structure
            .get::<String>("path")
            .map_err(|_| format!("{}: a path is required", structure.name()))?;
        let languages: Vec<String> = structure
            .get::<String>("languages")
            .map_err(|_| format!("{path}: its languages are required"))?
            .split(',')
            .map(str::trim)
            .filter(|code| !code.is_empty())
            .map(super::primary)
            .collect();
        if languages.is_empty() {
            return Err(format!("{path}: its languages are required"));
        }
        if super::language(&languages[0]).is_none() {
            return Err(format!("{path}: Pocket TTS has no {} model", languages[0]));
        }
        Ok(Self {
            path: PathBuf::from(path),
            languages,
            voice: structure
                .get::<String>("voice")
                .ok()
                .filter(|voice| !voice.is_empty()),
        })
    }

    /// The name of its model's config.
    fn config(&self) -> &'static str {
        super::language(&self.languages[0]).unwrap().1
    }

    /// Its voice state: a path, or a name in `embeddings/`, or the
    /// language's default voice.
    pub fn voice_path(&self) -> PathBuf {
        let name = self
            .voice
            .clone()
            .unwrap_or_else(|| super::language(&self.languages[0]).unwrap().2.to_string());
        if name.ends_with(".safetensors") {
            PathBuf::from(name)
        } else {
            self.path
                .join("embeddings")
                .join(format!("{name}.safetensors"))
        }
    }

    fn speaks(&self, code: &str) -> bool {
        let code = super::primary(code);
        self.languages.iter().any(|language| *language == code)
    }
}

struct Loaded {
    entry: Entry,
    model: Arc<TtsModel<Backend>>,
    voice: VoiceState<Backend>,
}

#[derive(Default)]
struct Settings {
    models: Vec<Entry>,
    language: Option<String>,
}

struct State {
    /// The models loaded, by path: kept while their entries change voice.
    models: HashMap<PathBuf, Arc<TtsModel<Backend>>>,
    loaded: Vec<Arc<Loaded>>,
    segment: gst::FormattedSegment<gst::ClockTime>,
    tag_language: Option<String>,
    next_pts: Option<gst::ClockTime>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            models: HashMap::new(),
            loaded: Vec::new(),
            segment: gst::FormattedSegment::new(),
            tag_language: None,
            next_pts: None,
        }
    }
}

pub struct PocketSynthesizer {
    srcpad: gst::Pad,
    sinkpad: gst::Pad,
    settings: Mutex<Settings>,
    state: Mutex<State>,
    /// Set by a flush: the sentence being read stops.
    stop: Arc<AtomicBool>,
}

impl PocketSynthesizer {
    fn src_caps() -> gst::Caps {
        gst_audio::AudioCapsBuilder::new_interleaved()
            .format(gst_audio::AUDIO_FORMAT_F32)
            .rate(SAMPLE_RATE)
            .channels(1)
            .build()
    }

    /// Loads what `models` asks for and is not loaded yet; drops the rest.
    fn load(&self) -> Result<(), gst::ErrorMessage> {
        let entries = self.settings.lock().unwrap().models.clone();
        if entries.is_empty() {
            return Err(gst::error_msg!(
                gst::ResourceError::Settings,
                ["pocketsynthesizer has no models"]
            ));
        }
        let mut state = self.state.lock().unwrap();
        let mut models = HashMap::new();
        let mut loaded = Vec::new();
        for entry in entries {
            if let Some(same) = state.loaded.iter().find(|loaded| loaded.entry == entry) {
                models.insert(entry.path.clone(), same.model.clone());
                loaded.push(same.clone());
                continue;
            }
            let model = match models
                .get(&entry.path)
                .or_else(|| state.models.get(&entry.path))
            {
                Some(model) => Arc::clone(model),
                None => {
                    let started = std::time::Instant::now();
                    let model = load_model(&entry).map_err(|err| {
                        gst::error_msg!(
                            gst::ResourceError::OpenRead,
                            ["{}: {err:#}", entry.path.display()]
                        )
                    })?;
                    eprintln!(
                        "[voice] Pocket TTS {} loaded in {:.1} s",
                        entry.config(),
                        started.elapsed().as_secs_f32()
                    );
                    Arc::new(model)
                }
            };
            let voice_path = entry.voice_path();
            let voice = model.voice(&voice_path).map_err(|err| {
                gst::error_msg!(
                    gst::ResourceError::OpenRead,
                    ["{}: {err:#}", voice_path.display()]
                )
            })?;
            models.insert(entry.path.clone(), model.clone());
            loaded.push(Arc::new(Loaded {
                entry,
                model,
                voice,
            }));
        }
        state.models = models;
        state.loaded = loaded;
        Ok(())
    }

    fn sink_chain(
        &self,
        _pad: &gst::Pad,
        buffer: gst::Buffer,
    ) -> Result<gst::FlowSuccess, gst::FlowError> {
        let text = {
            let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
            String::from_utf8_lossy(&map).trim().to_string()
        };
        if text.is_empty() || !text.chars().any(char::is_alphanumeric) {
            return Ok(gst::FlowSuccess::Ok);
        }
        let default = self
            .settings
            .lock()
            .unwrap()
            .language
            .clone()
            .unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
        let (loaded, mut pts, code) = {
            let state = self.state.lock().unwrap();
            let code = state.tag_language.clone().unwrap_or(default);
            let Some(loaded) = state
                .loaded
                .iter()
                .find(|loaded| loaded.entry.speaks(&code))
                .cloned()
            else {
                gst::element_imp_error!(
                    self,
                    gst::StreamError::Format,
                    ["No Pocket TTS voice reads language {code}"]
                );
                return Err(gst::FlowError::Error);
            };
            // Speech starts at the text's time, or right after the
            // previous one.
            let start = state.segment.start().unwrap_or(gst::ClockTime::ZERO);
            let pts = match (buffer.pts(), state.next_pts) {
                (Some(pts), Some(next)) => pts.max(next),
                (Some(pts), None) => pts,
                (None, next) => next.unwrap_or(start),
            };
            (loaded, pts, code)
        };
        // Its numbers in words, in its language: the model reads digits
        // badly.
        let text = super::spoken::spell_out(&text, &code);
        gst::debug!(
            CAT,
            imp = self,
            "{} ({}): {text:?}",
            loaded.entry.config(),
            loaded.entry.voice_path().display()
        );

        let srcpad = self.srcpad.clone();
        let mut flow = Ok(gst::FlowSuccess::Ok);
        let mut on_chunk = |pcm: &[f32]| -> anyhow::Result<()> {
            if pcm.is_empty() {
                return Ok(());
            }
            let duration = gst::ClockTime::from_nseconds(
                pcm.len() as u64 * gst::ClockTime::SECOND.nseconds() / SAMPLE_RATE as u64,
            );
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_ne_bytes()).collect();
            let mut out = gst::Buffer::from_mut_slice(bytes);
            {
                let out = out.get_mut().unwrap();
                out.set_pts(pts);
                out.set_duration(duration);
            }
            pts += duration;
            flow = srcpad.push(out);
            match flow {
                Ok(_) => Ok(()),
                Err(err) => anyhow::bail!("pushing the speech: {err:?}"),
            }
        };
        let result = loaded.model.generate_audio_stream(
            &loaded.voice,
            &text,
            super::MAX_TOKEN_PER_CHUNK,
            None,
            &self.stop,
            &mut on_chunk,
        );
        self.state.lock().unwrap().next_pts = Some(pts);
        if self.stop.load(Ordering::SeqCst) {
            return Err(gst::FlowError::Flushing);
        }
        flow?;
        if let Err(err) = result {
            gst::element_imp_error!(self, gst::LibraryError::Failed, ["{err:#}"]);
            return Err(gst::FlowError::Error);
        }
        Ok(gst::FlowSuccess::Ok)
    }

    fn sink_event(&self, pad: &gst::Pad, event: gst::Event) -> bool {
        gst::log!(CAT, obj = pad, "Handling event {event:?}");

        use gst::EventView::*;
        match event.view() {
            Caps(c) => {
                let event = gst::event::Caps::builder(&Self::src_caps())
                    .seqnum(c.seqnum())
                    .build();
                self.srcpad.push_event(event)
            }
            Segment(e) => {
                // Text read from a file or a pipe comes in a bytes segment:
                // the speech then gets its own time line.
                let (segment, event) = match e.segment().clone().downcast::<gst::ClockTime>() {
                    Ok(segment) => (segment, event),
                    Err(_) => {
                        let segment = gst::FormattedSegment::<gst::ClockTime>::new();
                        let event = gst::event::Segment::builder(&segment)
                            .seqnum(event.seqnum())
                            .build();
                        (segment, event)
                    }
                };
                let mut state = self.state.lock().unwrap();
                state.segment = segment;
                state.next_pts = None;
                drop(state);
                self.srcpad.push_event(event)
            }
            Tag(t) => {
                if let Some(code) = t.tag().get::<gst::tags::LanguageCode>() {
                    self.state.lock().unwrap().tag_language = Some(code.get().to_string());
                }
                gst::Pad::event_default(pad, Some(&*self.obj()), event)
            }
            FlushStart(_) => {
                self.stop.store(true, Ordering::SeqCst);
                gst::Pad::event_default(pad, Some(&*self.obj()), event)
            }
            FlushStop(_) => {
                self.stop.store(false, Ordering::SeqCst);
                self.state.lock().unwrap().next_pts = None;
                gst::Pad::event_default(pad, Some(&*self.obj()), event)
            }
            StreamStart(_) => {
                self.state.lock().unwrap().tag_language = None;
                gst::Pad::event_default(pad, Some(&*self.obj()), event)
            }
            _ => gst::Pad::event_default(pad, Some(&*self.obj()), event),
        }
    }
}

/// The model of `entry`'s language, from its directory.
fn load_model(entry: &Entry) -> anyhow::Result<TtsModel<Backend>> {
    let config = Config::for_language(entry.config())?;
    TtsModel::load(
        config,
        &entry.path.join("model.safetensors"),
        &entry.path.join("tokenizer.json"),
        &LoadOptions::default(),
    )
}

/// `models`' entries, checked.
pub fn entries(models: &[glib::SendValue]) -> Result<Vec<Entry>, String> {
    models
        .iter()
        .map(|value| {
            value
                .get::<gst::Structure>()
                .map_err(|_| "pocketsynthesizer's models are structures".to_string())
                .and_then(|structure| Entry::from_structure(&structure))
        })
        .collect()
}

#[glib::object_subclass]
impl ObjectSubclass for PocketSynthesizer {
    const NAME: &'static str = "RoamgatePocketSynthesizer";
    type Type = Synthesizer;
    type ParentType = gst::Element;

    fn with_class(klass: &Self::Class) -> Self {
        let templ = klass.pad_template("sink").unwrap();
        let sinkpad = gst::Pad::builder_from_template(&templ)
            .chain_function(|pad, parent, buffer| {
                PocketSynthesizer::catch_panic_pad_function(
                    parent,
                    || Err(gst::FlowError::Error),
                    |imp| imp.sink_chain(pad, buffer),
                )
            })
            .event_function(|pad, parent, event| {
                PocketSynthesizer::catch_panic_pad_function(
                    parent,
                    || false,
                    |imp| imp.sink_event(pad, event),
                )
            })
            .build();
        let templ = klass.pad_template("src").unwrap();
        let srcpad = gst::Pad::builder_from_template(&templ).build();
        Self {
            srcpad,
            sinkpad,
            settings: Default::default(),
            state: Default::default(),
            stop: Default::default(),
        }
    }
}

impl ObjectImpl for PocketSynthesizer {
    fn constructed(&self) {
        self.parent_constructed();
        let obj = self.obj();
        obj.add_pad(&self.sinkpad).unwrap();
        obj.add_pad(&self.srcpad).unwrap();
    }

    fn properties() -> &'static [glib::ParamSpec] {
        static PROPERTIES: LazyLock<Vec<glib::ParamSpec>> = LazyLock::new(|| {
            vec![
                gst::ParamSpecArray::builder("models")
                    .nick("Models")
                    .blurb(
                        "The voices, as pocket-tts structures: path, languages, voice; \
                         each language reads with the first that lists it",
                    )
                    .mutable_ready()
                    .build(),
                glib::ParamSpecString::builder("language")
                    .nick("Language")
                    .blurb("The language (ISO 639-1) when the stream has no language-code tag")
                    .default_value(Some(DEFAULT_LANGUAGE))
                    .mutable_playing()
                    .build(),
            ]
        });
        PROPERTIES.as_ref()
    }

    fn set_property(&self, _id: usize, value: &glib::Value, pspec: &glib::ParamSpec) {
        let mut settings = self.settings.lock().unwrap();
        match pspec.name() {
            "models" => {
                let models = value.get::<gst::Array>().expect("type checked upstream");
                match entries(&models) {
                    Ok(models) => settings.models = models,
                    Err(err) => {
                        gst::error!(CAT, imp = self, "{err}");
                        settings.models.clear();
                    }
                }
            }
            "language" => settings.language = value.get().expect("type checked upstream"),
            _ => unimplemented!(),
        }
    }

    fn property(&self, _id: usize, pspec: &glib::ParamSpec) -> glib::Value {
        let settings = self.settings.lock().unwrap();
        match pspec.name() {
            "models" => gst::Array::new(settings.models.iter().map(|entry| {
                let mut structure = gst::Structure::builder("pocket-tts")
                    .field("path", entry.path.to_string_lossy().to_string())
                    .field("languages", entry.languages.join(","))
                    .build();
                if let Some(voice) = &entry.voice {
                    structure.set("voice", voice);
                }
                structure.to_send_value()
            }))
            .to_value(),
            "language" => settings.language.to_value(),
            _ => unimplemented!(),
        }
    }
}

impl GstObjectImpl for PocketSynthesizer {}

impl ElementImpl for PocketSynthesizer {
    fn metadata() -> Option<&'static gst::subclass::ElementMetadata> {
        static ELEMENT_METADATA: LazyLock<gst::subclass::ElementMetadata> = LazyLock::new(|| {
            gst::subclass::ElementMetadata::new(
                "Pocket TTS Synthesizer",
                "Audio/Text/Filter",
                "Text to speech with Kyutai's Pocket TTS, on the CPU",
                "Thibault Saunier <tsaunier@igalia.com>",
            )
        });
        Some(&*ELEMENT_METADATA)
    }

    fn pad_templates() -> &'static [gst::PadTemplate] {
        static PAD_TEMPLATES: LazyLock<Vec<gst::PadTemplate>> = LazyLock::new(|| {
            let sink_caps = gst::Caps::builder("text/x-raw")
                .field("format", "utf8")
                .build();
            vec![
                gst::PadTemplate::new(
                    "src",
                    gst::PadDirection::Src,
                    gst::PadPresence::Always,
                    &PocketSynthesizer::src_caps(),
                )
                .unwrap(),
                gst::PadTemplate::new(
                    "sink",
                    gst::PadDirection::Sink,
                    gst::PadPresence::Always,
                    &sink_caps,
                )
                .unwrap(),
            ]
        });
        PAD_TEMPLATES.as_ref()
    }

    fn change_state(
        &self,
        transition: gst::StateChange,
    ) -> Result<gst::StateChangeSuccess, gst::StateChangeError> {
        // Back in READY the models stay; going on loads what changed.
        if transition == gst::StateChange::ReadyToPaused
            && let Err(err) = self.load()
        {
            self.post_error_message(err);
            return Err(gst::StateChangeError);
        }
        if transition == gst::StateChange::PausedToReady {
            self.stop.store(true, Ordering::SeqCst);
        }
        let ret = self.parent_change_state(transition)?;
        match transition {
            gst::StateChange::PausedToReady => {
                self.stop.store(false, Ordering::SeqCst);
                let mut state = self.state.lock().unwrap();
                state.segment = gst::FormattedSegment::new();
                state.tag_language = None;
                state.next_pts = None;
            }
            gst::StateChange::ReadyToNull => *self.state.lock().unwrap() = State::default(),
            _ => (),
        }
        Ok(ret)
    }
}

glib::wrapper! {
    pub struct Synthesizer(ObjectSubclass<PocketSynthesizer>) @extends gst::Element, gst::Object;
}

/// Registers `pocketsynthesizer`, linked into the helper.
pub fn register() -> Result<(), glib::BoolError> {
    gst::Element::register(
        None,
        "pocketsynthesizer",
        gst::Rank::NONE,
        Synthesizer::static_type(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn structure(fields: &[(&str, &str)]) -> gst::Structure {
        let mut structure = gst::Structure::new_empty("pocket-tts");
        for (field, value) in fields {
            structure.set(*field, *value);
        }
        structure
    }

    #[test]
    fn entries_name_their_language_and_voice() {
        gst::init().unwrap();
        let fr = Entry::from_structure(&structure(&[
            ("path", "/m/pocket-tts-fr/languages/french"),
            ("languages", "fr-FR"),
        ]))
        .unwrap();
        assert_eq!(fr.languages, ["fr"]);
        assert_eq!(fr.config(), "french");
        assert_eq!(
            fr.voice_path(),
            Path::new("/m/pocket-tts-fr/languages/french/embeddings/estelle.safetensors")
        );
        let en = Entry::from_structure(&structure(&[
            ("path", "/m/en"),
            ("languages", "en"),
            ("voice", "/v/tib2.safetensors"),
        ]))
        .unwrap();
        assert_eq!(en.voice_path(), Path::new("/v/tib2.safetensors"));
        let named = Entry::from_structure(&structure(&[
            ("path", "/m/fr"),
            ("languages", "fr"),
            ("voice", "lola"),
        ]))
        .unwrap();
        assert_eq!(
            named.voice_path(),
            Path::new("/m/fr/embeddings/lola.safetensors")
        );

        assert!(fr.speaks("fr-CA") && !fr.speaks("en"));
        assert!(en.speaks("en-GB") && en.config() == "english");
        // No voice of another language reads it, with its accent.
        assert!(!fr.speaks("es") && !en.speaks("es"));

        assert!(Entry::from_structure(&structure(&[("path", "/m")])).is_err());
        assert!(Entry::from_structure(&structure(&[("path", "/m"), ("languages", "ja")])).is_err());
        assert!(Entry::from_structure(&structure(&[("languages", "fr")])).is_err());
    }

    #[test]
    fn a_missing_model_fails_to_start() {
        gst::init().unwrap();
        register().unwrap();
        let element = gst::ElementFactory::make("pocketsynthesizer")
            .property(
                "models",
                gst::Array::new([structure(&[
                    ("path", "/nonexistent/pocket"),
                    ("languages", "fr"),
                ])
                .to_send_value()]),
            )
            .build()
            .unwrap();
        let models = element.property::<gst::Array>("models");
        assert_eq!(models.len(), 1);
        assert!(element.set_state(gst::State::Paused).is_err());
        let _ = element.set_state(gst::State::Null);
        assert_eq!(entries(&models).unwrap()[0].languages, ["fr"]);
    }

    /// With the catalog's models (POCKET_TTS_MODELS: the models directory
    /// holding pocket-tts-fr), a sentence streams: its first audio leaves
    /// long before the last, a buffer at a time.
    #[test]
    #[ignore = "needs Pocket TTS's French model: POCKET_TTS_MODELS=<models dir>"]
    fn a_sentence_streams_its_first_audio_early() {
        let Some(models) = std::env::var_os("POCKET_TTS_MODELS") else {
            return;
        };
        gst::init().unwrap();
        register().unwrap();
        let path = PathBuf::from(models).join("pocket-tts-fr/languages/french");
        let pipeline = gst::parse::launch(
            "appsrc name=src format=time caps=text/x-raw,format=utf8 ! \
             pocketsynthesizer name=pocket ! appsink name=sink sync=false",
        )
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        pipeline.by_name("pocket").unwrap().set_property(
            "models",
            gst::Array::new([
                structure(&[("path", path.to_str().unwrap()), ("languages", "fr")]).to_send_value(),
            ]),
        );
        pipeline.set_state(gst::State::Playing).unwrap();
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
        let mut tags = gst::TagList::new();
        tags.get_mut()
            .unwrap()
            .add::<gst::tags::LanguageCode>(&"fr", gst::TagMergeMode::Replace);
        src.send_event(gst::event::Tag::new(tags));
        let started = std::time::Instant::now();
        src.push_buffer(gst::Buffer::from_slice(
            "J'ai relancé le pipeline GitLab CI, le merge request est prêt.".as_bytes(),
        ))
        .unwrap();
        src.end_of_stream().unwrap();
        let mut first = None;
        let mut buffers = 0;
        let mut samples = 0;
        while let Ok(sample) = sink.pull_sample() {
            first.get_or_insert_with(|| started.elapsed());
            buffers += 1;
            samples += sample.buffer().unwrap().size() / 4;
        }
        let total = started.elapsed();
        pipeline.set_state(gst::State::Null).unwrap();
        let first = first.expect("no speech");
        let seconds = samples as f32 / SAMPLE_RATE as f32;
        eprintln!(
            "first audio {first:?}, {buffers} buffers, {seconds:.2} s of speech in {total:?}"
        );
        assert!(seconds > 1.5, "{seconds} s");
        assert!(buffers > 3, "{buffers} buffers");
        assert!(first * 3 < total, "first audio {first:?} of {total:?}");
    }
}
