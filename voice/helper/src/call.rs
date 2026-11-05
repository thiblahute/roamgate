//! A voice call's audio: one live pipeline per call, mixing the replies
//! with a background source (music), sent on as Opus packets.
//!
//! ```text
//! voice:  appsrc (F32 48 kHz stereo, timestamps set here) ------------> mix
//! music:  <background> ! audioconvert ! audioresample ! F32 48k stereo
//!         (ducked in a probe) --------------------------------------> mix
//! floor:  audiotestsrc wave=silence is-live=true --------------------> mix
//! audiomixer latency=60ms ! opusenc 128 kb/s stereo ! appsink -> packets
//! ```
//!
//! The replies' tempo is made in the speaker's pipeline, before they come
//! here: nothing after the mixer changes speed or rate, so the music always
//! plays at its own speed and pitch. The silent floor keeps the mixer live
//! and paced by the clock, with or without music.
//!
//! Each sentence is cut in 10 ms blocks timestamped back to back from
//! `voice_next` (or a little ahead of now, after a pause), so sentences
//! never overlap nor arrive late. A hush (the user talks over a reply)
//! drops every block queued: blocks carry their generation in their
//! offset, and a probe lets only the current one through.
//!
//! The music is ducked while the companion has speech queued or playing,
//! or while the user talks (between speech_start and final): down in
//! DUCK_DOWN, back up over DUCK_UP once `release` passed with nobody
//! talking, sample by sample (`Duck`), so there are no clicks.
//!
//! The music waits, silent, while the listener learns a new speaker's
//! voice from what it hears (`wait_for_voice`): the speaker check would
//! take a singer's. It fades in once their voice is taken, and goes silent
//! again when another new speaker is to be learnt.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;

pub const RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// A voice block: 10 ms.
const BLOCK_FRAMES: usize = 480;
/// The mixer's latency: what a live source may be late by.
const MIXER_LATENCY: gst::ClockTime = gst::ClockTime::from_mseconds(60);
/// How far ahead of now a sentence starting after a pause is put.
const VOICE_LEAD: gst::ClockTime = gst::ClockTime::from_mseconds(40);
/// A block closer to now than this would come late to the mixer.
const MIN_AHEAD: gst::ClockTime = gst::ClockTime::from_mseconds(10);
pub const DUCK_DOWN_MS: f64 = 250.0;
pub const DUCK_UP_MS: f64 = 1500.0;
/// How fast the music level follows a volume change: full scale in 500 ms.
const LEVEL_PER_SECOND: f64 = 2.0;
/// The longest the user's talking ducks the music: past it, an utterance
/// whose end never came (a lost final) no longer keeps it down.
const USER_TALKING_MAX: gst::ClockTime = gst::ClockTime::from_seconds(60);
/// How long the music fades out before its source is stopped.
const MUTE_FADE: std::time::Duration = std::time::Duration::from_millis(600);
/// Music louder than this (mean square, -50 dBFS) goes to the page: the
/// microphone there may hear it.
const MUSIC_AUDIBLE: f32 = 1e-5;
/// The music counts as heard this long after its last audible block.
const MUSIC_HEARD_FOR: std::time::Duration = std::time::Duration::from_millis(500);

#[derive(Clone, Debug)]
pub struct Settings {
    /// A gst-launch description of the background source; empty for none.
    pub background: String,
    /// The music's level when nobody talks.
    pub volume: f64,
    /// The factor applied while ducked.
    pub ducked: f64,
    /// Quiet time before the music comes back up, in ms.
    pub release_ms: u64,
    /// Starts with the music off: its source is only made once it is put
    /// on (set_music).
    pub muted: bool,
    /// Starts with the music waiting for a voice (wait_for_voice).
    pub wait_for_voice: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            background: String::new(),
            volume: 0.6,
            ducked: 0.15,
            release_ms: 3000,
            muted: false,
            wait_for_voice: false,
        }
    }
}

/// The ducking envelope, sample by sample: a gain from `ducked` to 1.
#[derive(Clone, Debug)]
pub struct Duck {
    /// The envelope now, `ducked` to 1.
    pub gain: f64,
    /// The music's level now, following `target`.
    pub level: f64,
    pub target: f64,
    ducked: f64,
    release_ns: u64,
    /// When nobody has talked since, in running time (ns).
    quiet_since: Option<u64>,
}

impl Duck {
    pub fn new(volume: f64, ducked: f64, release_ms: u64) -> Self {
        Self {
            gain: 1.0,
            level: volume,
            target: volume,
            ducked: ducked.clamp(0.0, 1.0),
            release_ns: release_ms * 1_000_000,
            quiet_since: None,
        }
    }

    /// Applies the envelope to `samples` (interleaved, `channels`), which
    /// start at `at_ns`; `active` says someone talks then.
    pub fn apply(&mut self, samples: &mut [f32], channels: usize, at_ns: u64, active: bool) {
        let rate = RATE as f64;
        let span = 1.0 - self.ducked;
        let down = span / (DUCK_DOWN_MS / 1000.0 * rate);
        let up = span / (DUCK_UP_MS / 1000.0 * rate);
        let level_step = LEVEL_PER_SECOND / rate;
        let frames = samples.len() / channels.max(1);
        let frame_ns = 1_000_000_000 / RATE as u64;
        if active {
            self.quiet_since = None;
        } else if self.quiet_since.is_none() && self.gain < 1.0 {
            self.quiet_since = Some(at_ns);
        }
        for frame in 0..frames {
            let now = at_ns + frame as u64 * frame_ns;
            let goal = match (active, self.quiet_since) {
                (true, _) => self.ducked,
                (false, Some(since)) if now.saturating_sub(since) < self.release_ns => {
                    // Held down until the release passes.
                    self.gain.min(1.0)
                }
                _ => 1.0,
            };
            if self.gain > goal {
                self.gain = (self.gain - down).max(goal);
            } else if self.gain < goal {
                self.gain = (self.gain + up).min(goal);
            }
            if self.gain >= 1.0 {
                self.quiet_since = None;
            }
            if self.level > self.target {
                self.level = (self.level - level_step).max(self.target);
            } else if self.level < self.target {
                self.level = (self.level + level_step).min(self.target);
            }
            let gain = (self.gain * self.level) as f32;
            for sample in &mut samples[frame * channels..(frame + 1) * channels] {
                *sample *= gain;
            }
        }
    }
}

/// What the probes and the speaker share.
struct Mix {
    /// Where the next voice block goes, in running time.
    voice_next: Option<gst::ClockTime>,
    /// Sentences being made: the music ducks from the request on.
    pending: u32,
    /// Since when the user talks (running time), if they do.
    user_talking: Option<gst::ClockTime>,
    volume: f64,
    muted: bool,
    /// Silent until the listener took a new speaker's voice.
    waiting: bool,
    /// Whether `waiting` was told since the call started.
    told: bool,
    duck: Duck,
    /// When music last went to the mixer above MUSIC_AUDIBLE.
    music_heard: Option<std::time::Instant>,
}

impl Mix {
    /// The music's level when nobody talks, as it is now.
    fn level(&self) -> f64 {
        if self.muted || self.waiting {
            0.0
        } else {
            self.volume
        }
    }

    fn active(&self, at: gst::ClockTime) -> bool {
        self.pending > 0
            || self
                .user_talking
                .is_some_and(|since| at < since + USER_TALKING_MAX)
            || self.voice_next.is_some_and(|next| next > at)
    }
}

/// An Opus packet of the mix: its number, its time in µs, its bytes.
pub type OnPacket = Box<dyn Fn(u32, u64, &[u8]) + Send + Sync>;
/// The background failed: the call goes on with the voice only.
pub type OnError = Box<dyn Fn(String) + Send + Sync>;

pub struct Call {
    pub id: u32,
    pipeline: gst::Pipeline,
    voice: gst_app::AppSrc,
    mix: Arc<Mutex<Mix>>,
    generation: Arc<AtomicU64>,
    /// Frames of music, and of voice, that went to the mixer, for tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub music_frames: Arc<AtomicU64>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub voice_frames: Arc<AtomicU64>,
    /// Whether a background plays.
    pub music: bool,
    mixer: gst::Element,
    /// The background's description, to make it again once turned back on.
    background: String,
    /// The background's elements while it plays: none while it is off, so
    /// a source such as a process tap exists only while it is heard.
    branch: Mutex<Option<Branch>>,
}

/// The background's elements in the pipeline, and its mixer pad.
struct Branch {
    elements: Vec<gst::Element>,
    pad: gst::Pad,
}

fn raw_caps() -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "F32LE")
        .field("layout", "interleaved")
        .field("rate", RATE as i32)
        .field("channels", CHANNELS as i32)
        .field("channel-mask", gst::Bitmask::new(0x3))
        .build()
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|_| format!("no {factory} element"))
}

impl Call {
    /// Starts call `id`'s pipeline. A background that cannot be made is
    /// told to `on_error` and left out: the call goes on with the voice.
    pub fn start(
        id: u32,
        settings: &Settings,
        on_packet: OnPacket,
        on_error: OnError,
    ) -> Result<Self, String> {
        let pipeline = gst::Pipeline::with_name(&format!("roamgate-call-{id}"));
        let mixer = gst::ElementFactory::make("audiomixer")
            .name("mix")
            .property("latency", MIXER_LATENCY)
            .build()
            .map_err(|_| "no audiomixer element".to_string())?;
        let mixed = gst::ElementFactory::make("capsfilter")
            .property("caps", raw_caps())
            .build()
            .map_err(|e| e.to_string())?;
        // opusenc takes S16: the mix is F32 up to here.
        let to_s16 = make("audioconvert")?;
        let encoder = make("opusenc")?;
        encoder.set_property("bitrate", 128_000i32);
        encoder.set_property_from_str("bitrate-type", "vbr");
        encoder.set_property_from_str("audio-type", "generic");
        encoder.set_property_from_str("frame-size", "20");
        encoder.set_property("complexity", 10i32);
        encoder.set_property("dtx", false);
        let sink = gst_app::AppSink::builder()
            .name("packets")
            .sync(false)
            .build();
        pipeline
            .add_many([&mixer, &mixed, &to_s16, &encoder, sink.upcast_ref()])
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&mixer, &mixed, &to_s16, &encoder, sink.upcast_ref()])
            .map_err(|e| e.to_string())?;

        // The voice: blocks pushed by the speaker, timestamped here.
        let voice = gst_app::AppSrc::builder()
            .name("voice")
            .caps(&raw_caps())
            .format(gst::Format::Time)
            .is_live(true)
            .max_bytes(64 * 1024 * 1024)
            .block(false)
            .build();
        voice.set_property("min-latency", 0i64);
        pipeline.add(&voice).map_err(|e| e.to_string())?;
        voice.link(&mixer).map_err(|e| e.to_string())?;
        let generation = Arc::new(AtomicU64::new(0));
        let voice_frames = Arc::new(AtomicU64::new(0));
        {
            let generation = generation.clone();
            let voice_frames = voice_frames.clone();
            voice.static_pad("src").unwrap().add_probe(
                gst::PadProbeType::BUFFER,
                move |_, info| match info.buffer() {
                    Some(buffer) if buffer.offset() != generation.load(Ordering::SeqCst) => {
                        gst::PadProbeReturn::Drop
                    }
                    Some(buffer) => {
                        voice_frames.fetch_add(
                            buffer.size() as u64 / (4 * CHANNELS as u64),
                            Ordering::Relaxed,
                        );
                        gst::PadProbeReturn::Ok
                    }
                    None => gst::PadProbeReturn::Ok,
                },
            );
        }

        // The floor: silence, live, so the mixer runs with or without music.
        let floor = gst::ElementFactory::make("audiotestsrc")
            .property_from_str("wave", "silence")
            .property("is-live", true)
            .property("samplesperbuffer", BLOCK_FRAMES as i32)
            .build()
            .map_err(|_| "no audiotestsrc element".to_string())?;
        let floor_caps = gst::ElementFactory::make("capsfilter")
            .property("caps", raw_caps())
            .build()
            .map_err(|e| e.to_string())?;
        pipeline
            .add_many([&floor, &floor_caps])
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&floor, &floor_caps, &mixer]).map_err(|e| e.to_string())?;

        let mix = Arc::new(Mutex::new(Mix {
            voice_next: None,
            pending: 0,
            user_talking: None,
            volume: settings.volume.clamp(0.0, 1.0),
            muted: false,
            waiting: settings.wait_for_voice,
            told: false,
            duck: Duck::new(
                settings.volume.clamp(0.0, 1.0),
                settings.ducked,
                settings.release_ms,
            ),
            music_heard: None,
        }));
        let music_frames = Arc::new(AtomicU64::new(0));
        let seq = AtomicU32::new(0);
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(buffer) = sample.buffer()
                        && let Ok(map) = buffer.map_readable()
                    {
                        let pts = buffer.pts().map_or(0, |pts| pts.useconds());
                        on_packet(seq.fetch_add(1, Ordering::Relaxed), pts, &map);
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );

        if let Err(err) = pipeline.set_state(gst::State::Playing) {
            let detail = crate::bus_error(&pipeline).unwrap_or_else(|| err.to_string());
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!("the call's audio failed to start: {detail}"));
        }
        let mut call = Self {
            id,
            pipeline,
            voice,
            mix,
            generation,
            music_frames,
            voice_frames,
            music: false,
            mixer,
            background: settings.background.trim().to_string(),
            branch: Mutex::new(None),
        };
        if !call.background.is_empty() && settings.muted {
            // Off until asked for: nothing is tapped meanwhile.
            call.music = true;
            let mut mix = call.mix.lock().unwrap();
            mix.muted = true;
            mix.duck.level = 0.0;
            mix.duck.target = 0.0;
        } else if !call.background.is_empty() {
            if settings.wait_for_voice {
                eprintln!("call {id}: the call's music waits for a voice");
                let mut mix = call.mix.lock().unwrap();
                mix.duck.level = 0.0;
                mix.duck.target = 0.0;
            }
            match call.attach_background() {
                Ok(()) => call.music = true,
                Err(err) => on_error(err),
            }
        }
        crate::dump_dot(&call.pipeline, "roamgate-voice-call");
        Ok(call)
    }

    /// Makes the background and links it into the running mixer, ducked in
    /// a probe after its conversion to the mix's format.
    fn attach_background(&self) -> Result<(), String> {
        let mut branch = self.branch.lock().unwrap();
        if branch.is_some() {
            return Ok(());
        }
        let (elements, tail, pad) =
            Self::add_background(&self.pipeline, &self.mixer, &self.background)?;
        let mix = self.mix.clone();
        let frames = self.music_frames.clone();
        tail.static_pad("src")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                let Some(buffer) = info.buffer_mut() else {
                    return gst::PadProbeReturn::Ok;
                };
                let at = buffer.pts().unwrap_or(gst::ClockTime::ZERO);
                let buffer = buffer.make_mut();
                let mut mix = mix.lock().unwrap();
                let active = mix.active(at);
                if let Ok(mut map) = buffer.map_writable() {
                    let samples: &mut [f32] = bytemuck_f32(map.as_mut_slice());
                    frames.fetch_add(
                        (samples.len() / CHANNELS as usize) as u64,
                        Ordering::Relaxed,
                    );
                    mix.duck
                        .apply(samples, CHANNELS as usize, at.nseconds(), active);
                    let loud =
                        samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32;
                    if loud > MUSIC_AUDIBLE {
                        mix.music_heard = Some(std::time::Instant::now());
                    }
                }
                gst::PadProbeReturn::Ok
            });
        for element in &elements {
            if let Err(err) = element.sync_state_with_parent() {
                drop(branch);
                self.detach(Branch { elements, pad });
                return Err(format!("call_background failed to start: {err}"));
            }
        }
        *branch = Some(Branch { elements, pad });
        Ok(())
    }

    /// Takes the background out of the pipeline and stops it.
    fn detach(&self, branch: Branch) {
        if let Some(last) = branch.elements.last()
            && let Some(src) = last.static_pad("src")
        {
            let _ = src.unlink(&branch.pad);
        }
        self.mixer.release_request_pad(&branch.pad);
        for element in branch.elements.iter().rev() {
            let _ = element.set_state(gst::State::Null);
            let _ = self.pipeline.remove(element);
        }
    }

    /// `description` ! audioconvert ! audioresample ! F32 48k stereo, into
    /// the mixer; answers the last element, whose output gets ducked.
    fn add_background(
        pipeline: &gst::Pipeline,
        mixer: &gst::Element,
        description: &str,
    ) -> Result<(Vec<gst::Element>, gst::Element, gst::Pad), String> {
        let bin = gst::parse::bin_from_description(description, true)
            .map_err(|e| format!("call_background: {e}"))?;
        if bin.static_pad("src").is_none() {
            return Err(format!(
                "call_background has no audio output: {description} (end it with ! audioconvert)"
            ));
        }
        let convert = make("audioconvert")?;
        let resample = make("audioresample")?;
        resample.set_property("quality", 10i32);
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", raw_caps())
            .build()
            .map_err(|e| e.to_string())?;
        let queue = make("queue")?;
        pipeline
            .add_many([bin.upcast_ref(), &convert, &resample, &caps, &queue])
            .map_err(|e| e.to_string())?;
        let elements: Vec<gst::Element> =
            vec![bin.upcast(), convert, resample, caps.clone(), queue.clone()];
        let pad = mixer.request_pad_simple("sink_%u");
        let linked = gst::Element::link_many(&elements)
            .map_err(|e| e.to_string())
            .and_then(|()| {
                let pad = pad.as_ref().ok_or("no mixer pad")?;
                queue
                    .static_pad("src")
                    .unwrap()
                    .link(pad)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            });
        match (linked, pad) {
            (Ok(()), Some(pad)) => Ok((elements, caps, pad)),
            (linked, pad) => {
                if let Some(pad) = pad {
                    mixer.release_request_pad(&pad);
                }
                for element in &elements {
                    let _ = pipeline.remove(element);
                }
                Err(format!(
                    "call_background: {}",
                    linked.err().unwrap_or_default()
                ))
            }
        }
    }

    /// The pipeline's running time now.
    pub fn now(&self) -> gst::ClockTime {
        let clock = self.pipeline.clock();
        match (clock, self.pipeline.base_time()) {
            (Some(clock), Some(base)) => clock.time().saturating_sub(base),
            _ => gst::ClockTime::ZERO,
        }
    }

    /// A sentence starts being made: the music ducks from now on.
    pub fn sentence(&self) -> Sentence<'_> {
        self.mix.lock().unwrap().pending += 1;
        Sentence {
            call: self,
            generation: self.generation.load(Ordering::SeqCst),
            leftover: Vec::new(),
            start: None,
            frames: 0,
            done: false,
        }
    }

    /// The user talks over the voice: everything queued goes.
    pub fn hush(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.mix.lock().unwrap().voice_next = None;
    }

    /// The user talks (speech_start) or stopped (final, or cancelled).
    pub fn set_user_talking(&self, talking: bool) {
        let now = self.now();
        let mut mix = self.mix.lock().unwrap();
        mix.user_talking = match (talking, mix.user_talking) {
            (true, Some(since)) => Some(since),
            (true, None) => Some(now),
            (false, _) => None,
        };
    }

    /// The music's level, and whether it is off; None keeps either. Off,
    /// it fades out, then its source is stopped and taken out (a process
    /// tap goes with it); back on, it is made again and fades in.
    pub fn set_music(&self, volume: Option<f64>, muted: Option<bool>) -> (f64, bool) {
        let (volume, muted, was_muted) = {
            let mut mix = self.mix.lock().unwrap();
            let was_muted = mix.muted;
            if let Some(volume) = volume.filter(|v| v.is_finite()) {
                mix.volume = volume.clamp(0.0, 1.0);
            }
            if let Some(muted) = muted {
                mix.muted = muted;
            }
            mix.duck.target = mix.level();
            if !mix.muted && was_muted {
                // Made again: it starts silent and fades in.
                mix.duck.level = 0.0;
                if self.music && mix.waiting {
                    eprintln!("call {}: the call's music waits for a voice", self.id);
                }
            }
            (mix.volume, mix.muted, was_muted)
        };
        if self.music && muted && !was_muted {
            std::thread::sleep(MUTE_FADE);
            if self.mix.lock().unwrap().muted
                && let Some(branch) = self.branch.lock().unwrap().take()
            {
                self.detach(branch);
            }
        } else if self.music
            && !muted
            && was_muted
            && let Err(err) = self.attach_background()
        {
            eprintln!("call {}: {err}", self.id);
        }
        (volume, muted)
    }

    /// Whether the music waits for the listener to take a new speaker's
    /// voice (true), or may play (false). Silent while it waits, its source
    /// still made when on: it fades in once the voice is taken. Answers
    /// what to tell of a call with music: a change, or the state at first.
    pub fn wait_for_voice(&self, waiting: bool) -> Option<bool> {
        let on = {
            let mut mix = self.mix.lock().unwrap();
            let told = std::mem::replace(&mut mix.told, true);
            if mix.waiting == waiting {
                return (self.music && !told).then_some(waiting);
            }
            mix.waiting = waiting;
            mix.duck.target = mix.level();
            !mix.muted
        };
        if self.music && on {
            if waiting {
                eprintln!("call {}: the call's music waits for a voice", self.id);
            } else {
                eprintln!("call {}: a voice was taken: the call's music plays", self.id);
            }
        }
        self.music.then_some(waiting)
    }

    /// Whether the music waits for a voice (wait_for_voice).
    #[cfg(test)]
    pub fn music_waiting(&self) -> bool {
        self.mix.lock().unwrap().waiting
    }

    /// Whether the music goes to the page now, loud enough for its
    /// microphone to hear: on, and not silent (a paused player's tap is).
    pub fn music_audible(&self) -> bool {
        let mix = self.mix.lock().unwrap();
        !mix.muted
            && mix
                .music_heard
                .is_some_and(|heard| heard.elapsed() < MUSIC_HEARD_FOR)
    }

    /// Whether the background's source is in the pipeline now.
    #[cfg(test)]
    pub fn background_running(&self) -> bool {
        self.branch.lock().unwrap().is_some()
    }

    /// The ducking envelope now, for tests.
    #[cfg(test)]
    pub fn duck_gain(&self) -> f64 {
        self.mix.lock().unwrap().duck.gain
    }

    /// Where the voice queued so far ends, in running time.
    #[cfg(test)]
    pub fn voice_end(&self) -> Option<gst::ClockTime> {
        self.mix.lock().unwrap().voice_next
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        // Its sources stop with it: a process tap is destroyed here.
        let _ = self.pipeline.set_state(gst::State::Null);
        self.branch.lock().unwrap().take();
    }
}

/// One sentence going into the call, a block at a time.
pub struct Sentence<'a> {
    call: &'a Call,
    generation: u64,
    leftover: Vec<f32>,
    start: Option<gst::ClockTime>,
    frames: u64,
    done: bool,
}

impl Sentence<'_> {
    /// Interleaved stereo F32 at 48 kHz, as it is made.
    pub fn push(&mut self, samples: &[f32]) {
        self.leftover.extend_from_slice(samples);
        let block = BLOCK_FRAMES * CHANNELS as usize;
        let whole = self.leftover.len() / block * block;
        if whole == 0 {
            return;
        }
        let blocks: Vec<f32> = self.leftover.drain(..whole).collect();
        for chunk in blocks.chunks_exact(block) {
            self.push_block(chunk);
        }
    }

    fn push_block(&mut self, block: &[f32]) {
        if self.call.generation.load(Ordering::SeqCst) != self.generation {
            return;
        }
        let duration = gst::ClockTime::from_nseconds(
            (block.len() / CHANNELS as usize) as u64 * 1_000_000_000 / RATE as u64,
        );
        let pts = {
            let mut mix = self.call.mix.lock().unwrap();
            let earliest = self.call.now() + VOICE_LEAD;
            let pts = match (self.start, mix.voice_next) {
                // Within a sentence: right after the block before, unless
                // it is made slower than it plays (a gap then, not a drop).
                (Some(_), Some(next)) if next >= self.call.now() + MIN_AHEAD => next,
                (_, Some(next)) if next >= earliest => next,
                _ => earliest,
            };
            mix.voice_next = Some(pts + duration);
            pts
        };
        self.start.get_or_insert(pts);
        self.frames += (block.len() / CHANNELS as usize) as u64;
        let bytes: Vec<u8> = block.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut buffer = gst::Buffer::from_mut_slice(bytes);
        {
            let buffer = buffer.get_mut().unwrap();
            buffer.set_pts(pts);
            buffer.set_duration(duration);
            buffer.set_offset(self.generation);
        }
        let _ = self.call.voice.push_buffer(buffer);
    }

    /// The sentence is over: its start and length in the call's time (ms).
    pub fn finish(mut self) -> (u64, u64) {
        if !self.leftover.is_empty() {
            let block = BLOCK_FRAMES * CHANNELS as usize;
            let mut last = std::mem::take(&mut self.leftover);
            last.resize(block, 0.0);
            self.push_block(&last);
        }
        self.done = true;
        self.call.mix.lock().unwrap().pending -= 1;
        let start = self
            .start
            .map_or(self.call.now().mseconds(), |s| s.mseconds());
        (start, self.frames * 1000 / RATE as u64)
    }
}

impl Drop for Sentence<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.call.mix.lock().unwrap().pending -= 1;
        }
    }
}

/// A mapped F32 buffer as samples.
pub fn bytemuck_f32(bytes: &mut [u8]) -> &mut [f32] {
    let (head, samples, _) = unsafe { bytes.align_to_mut::<f32>() };
    if head.is_empty() { samples } else { &mut [] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    type Packets = Arc<Mutex<Vec<(u64, Vec<u8>)>>>;

    fn start(background: &str) -> (Call, Packets, Arc<Mutex<Vec<String>>>) {
        start_with(background, false)
    }

    fn start_with(background: &str, muted: bool) -> (Call, Packets, Arc<Mutex<Vec<String>>>) {
        start_waiting(background, muted, false)
    }

    fn start_waiting(
        background: &str,
        muted: bool,
        wait_for_voice: bool,
    ) -> (Call, Packets, Arc<Mutex<Vec<String>>>) {
        gst::init().unwrap();
        let packets: Packets = Arc::default();
        let errors: Arc<Mutex<Vec<String>>> = Arc::default();
        let call = {
            let packets = packets.clone();
            let errors = errors.clone();
            Call::start(
                1,
                &Settings {
                    background: background.into(),
                    volume: 1.0,
                    ducked: 0.15,
                    release_ms: 3000,
                    muted,
                    wait_for_voice,
                },
                Box::new(move |_, pts, packet| {
                    packets.lock().unwrap().push((pts, packet.to_vec()))
                }),
                Box::new(move |error| errors.lock().unwrap().push(error)),
            )
            .unwrap()
        };
        (call, packets, errors)
    }

    /// `seconds` of a `freq` sine made `tempo` times faster by soundtouch's
    /// `pitch`, as the speaker makes a sentence: F32 48 kHz stereo.
    fn voice(seconds: f64, freq: f64, tempo: f64) -> Vec<f32> {
        let pipeline = gst::parse::launch(&format!(
            "audiotestsrc wave=sine freq={freq} num-buffers={} samplesperbuffer=480 ! \
             audio/x-raw,format=F32LE,rate=48000,channels=1 ! pitch tempo={tempo} ! \
             audioconvert ! audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=2 ! \
             appsink name=out sync=false",
            (seconds * 100.0) as u32
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let sink = pipeline
            .by_name("out")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        let mut samples = Vec::new();
        while let Ok(sample) = sink.pull_sample() {
            let map = sample.buffer().unwrap().map_readable().unwrap();
            samples.extend(
                map.chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            );
        }
        pipeline.set_state(gst::State::Null).unwrap();
        samples
    }

    /// The packets decoded: F32 48 kHz stereo, from the first packet's time.
    fn decode(packets: &[(u64, Vec<u8>)]) -> Vec<f32> {
        let pipeline = gst::parse::launch(
            "appsrc name=in format=time caps=audio/x-opus,channel-mapping-family=0,channels=2,rate=48000 ! \
             opusdec plc=false ! audioconvert ! audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=2 ! \
             appsink name=out sync=false",
        )
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let src = pipeline
            .by_name("in")
            .unwrap()
            .downcast::<gst_app::AppSrc>()
            .unwrap();
        let sink = pipeline
            .by_name("out")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        pipeline.set_state(gst::State::Playing).unwrap();
        for (pts, packet) in packets {
            let mut buffer = gst::Buffer::from_slice(packet.clone());
            buffer
                .get_mut()
                .unwrap()
                .set_pts(gst::ClockTime::from_useconds(*pts));
            src.push_buffer(buffer).unwrap();
        }
        src.end_of_stream().unwrap();
        let mut samples = Vec::new();
        while let Ok(sample) = sink.pull_sample() {
            let map = sample.buffer().unwrap().map_readable().unwrap();
            samples.extend(
                map.chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            );
        }
        pipeline.set_state(gst::State::Null).unwrap();
        samples
    }

    /// The strongest frequency of the left channel of `stereo`, in Hz, by a
    /// plain DFT over 0 to 2 kHz in 1 Hz steps' bins of the window.
    fn peak(stereo: &[f32]) -> f64 {
        let left: Vec<f64> = stereo.iter().step_by(2).map(|s| *s as f64).collect();
        let n = left.len() as f64;
        let bin = RATE as f64 / n;
        (1..(2000.0 / bin) as usize)
            .map(|k| {
                let w = 2.0 * std::f64::consts::PI * k as f64 / n;
                let (re, im) = left
                    .iter()
                    .enumerate()
                    .fold((0.0, 0.0), |(re, im), (i, s)| {
                        (re + s * (w * i as f64).cos(), im - s * (w * i as f64).sin())
                    });
                (k as f64 * bin, re * re + im * im)
            })
            .fold(
                (0.0, 0.0),
                |best, (f, p)| if p > best.1 { (f, p) } else { best },
            )
            .0
    }

    #[test]
    fn music_keeps_its_speed_while_the_voice_is_made_faster() {
        // Exactly 1.5 s of a 440 Hz sine, live.
        let (call, packets, errors) = start(
            "audiotestsrc is-live=true wave=sine freq=440 num-buffers=150 samplesperbuffer=480 \
             ! capsfilter caps=audio/x-raw,rate=48000",
        );
        assert!(call.music, "{:?}", errors.lock().unwrap());
        std::thread::sleep(Duration::from_millis(100));
        // A 1 s "sentence" at speech_rate 1.5.
        let spoken = voice(1.0, 300.0, 1.5);
        let mut sentence = call.sentence();
        sentence.push(&spoken);
        let (start_ms, duration_ms) = sentence.finish();
        // The voice lasts 1/1.5 of itself, +/- 5%.
        assert!(
            (duration_ms as f64 - 666.7).abs() < 666.7 * 0.05,
            "voice {duration_ms} ms"
        );
        std::thread::sleep(Duration::from_millis(2000));
        drop(call);
        // The music branch fed the mixer 1.5 s, at its own rate.
        let errors = errors.lock().unwrap();
        assert!(errors.is_empty(), "{errors:?}");
        let packets = packets.lock().unwrap();
        let decoded = decode(&packets);
        let first = packets[0].0;
        let at = |ms: u64| ((ms * 1000).saturating_sub(first) * 48 / 1000) as usize * 2;
        // After the voice, while the music still plays (ducked).
        let voice_end = start_ms + duration_ms + 60;
        let window = &decoded[at(voice_end)..at(voice_end + 400)];
        let found = peak(window);
        assert!((found - 440.0).abs() <= 2.5, "music peak at {found} Hz");
    }

    #[test]
    fn music_frames_cover_their_duration() {
        let (call, _packets, _errors) = start(
            "audiotestsrc is-live=true wave=sine freq=440 num-buffers=150 samplesperbuffer=480 \
             ! capsfilter caps=audio/x-raw,rate=48000",
        );
        let mut sentence = call.sentence();
        sentence.push(&voice(1.0, 300.0, 1.5));
        sentence.finish();
        std::thread::sleep(Duration::from_millis(2000));
        assert_eq!(call.music_frames.load(Ordering::Relaxed), 72_000);
    }

    #[test]
    fn sentences_queue_back_to_back_and_a_hush_drops_them() {
        let (call, _packets, _errors) = start("");
        let mut first = call.sentence();
        first.push(&vec![0.1f32; 48_000 * 2 * 3 / 10]);
        let (start1, duration1) = first.finish();
        let mut second = call.sentence();
        second.push(&vec![0.1f32; 48_000 * 2 * 3 / 10]);
        let (start2, duration2) = second.finish();
        assert_eq!((duration1, duration2), (300, 300));
        assert_eq!(start2, start1 + duration1, "no gap, no overlap");
        // A long one, cut short.
        std::thread::sleep(Duration::from_millis(700));
        let before = call.voice_frames.load(Ordering::Relaxed);
        let mut long = call.sentence();
        long.push(&vec![0.1f32; 48_000 * 2 * 3]);
        long.finish();
        std::thread::sleep(Duration::from_millis(300));
        call.hush();
        assert_eq!(call.voice_end(), None);
        std::thread::sleep(Duration::from_millis(600));
        let heard = call.voice_frames.load(Ordering::Relaxed) - before;
        assert!(
            heard < 48_000 / 2,
            "{heard} frames of a 3 s sentence went through"
        );
        // The next sentence plays.
        let mut after = call.sentence();
        after.push(&vec![0.1f32; 48_000 * 2 / 10]);
        after.finish();
        std::thread::sleep(Duration::from_millis(400));
        assert!(call.voice_frames.load(Ordering::Relaxed) - before - heard >= 4800);
    }

    #[test]
    fn a_bad_background_leaves_the_voice() {
        let (call, packets, errors) = start("nosuchelementanywhere ! audioconvert");
        assert!(!call.music);
        assert_eq!(errors.lock().unwrap().len(), 1);
        let mut sentence = call.sentence();
        sentence.push(&vec![0.1f32; 48_000 * 2 / 5]);
        sentence.finish();
        std::thread::sleep(Duration::from_millis(500));
        assert!(call.voice_frames.load(Ordering::Relaxed) >= 9600);
        assert!(!packets.lock().unwrap().is_empty());
    }

    #[test]
    fn music_off_stops_its_source_and_on_makes_it_again() {
        let (call, _packets, _errors) = start("audiotestsrc is-live=true wave=sine freq=440");
        assert!(call.background_running());
        call.set_music(None, Some(true));
        assert!(!call.background_running());
        let frames = call.music_frames.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(call.music_frames.load(Ordering::Relaxed), frames);
        call.set_music(None, Some(false));
        assert!(call.background_running());
        std::thread::sleep(Duration::from_millis(300));
        assert!(call.music_frames.load(Ordering::Relaxed) > frames);
    }

    #[test]
    fn a_call_can_start_with_its_music_off_and_untapped() {
        let (call, _packets, _errors) =
            start_with("audiotestsrc is-live=true wave=sine freq=440", true);
        assert!(call.music);
        assert!(!call.background_running());
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(call.music_frames.load(Ordering::Relaxed), 0);
        call.set_music(None, Some(false));
        assert!(call.background_running());
        std::thread::sleep(Duration::from_millis(300));
        assert!(call.music_frames.load(Ordering::Relaxed) > 0);
    }

    /// The listener holds its gate while the music is heard at the page
    /// (main.rs): on and playing, not off, nor a silent source (a paused
    /// player's tap).
    #[test]
    fn the_music_is_audible_only_while_it_plays_something() {
        let (call, _mixed, _errors) = start("audiotestsrc is-live=true wave=sine freq=440");
        std::thread::sleep(Duration::from_millis(300));
        assert!(call.music_audible());
        call.set_music(None, Some(true));
        assert!(!call.music_audible());
        call.set_music(None, Some(false));
        std::thread::sleep(Duration::from_millis(800));
        assert!(call.music_audible());

        let (silent, _mixed, _errors) = start("audiotestsrc is-live=true wave=silence");
        std::thread::sleep(Duration::from_millis(300));
        assert!(silent.music);
        assert!(!silent.music_audible());

        let (off, _mixed, _errors) =
            start_with("audiotestsrc is-live=true wave=sine freq=440", true);
        std::thread::sleep(Duration::from_millis(300));
        assert!(!off.music_audible());
    }

    /// Music asked for while a new speaker's voice is learnt stays silent,
    /// its source made, until the voice is taken; then it fades in. Another
    /// new speaker silences it again; music put on meanwhile waits as well.
    #[test]
    fn the_music_waits_for_a_voice() {
        let (call, _packets, errors) =
            start_waiting("audiotestsrc is-live=true wave=sine freq=440", false, true);
        assert!(call.music, "{:?}", errors.lock().unwrap());
        assert!(call.background_running());
        assert!(call.music_waiting());
        std::thread::sleep(Duration::from_millis(600));
        assert!(call.music_frames.load(Ordering::Relaxed) > 0);
        assert!(!call.music_audible());

        // Told once at first, then each change.
        assert_eq!(call.wait_for_voice(true), Some(true));
        assert_eq!(call.wait_for_voice(true), None);
        assert_eq!(call.wait_for_voice(false), Some(false));
        assert_eq!(call.wait_for_voice(false), None);
        std::thread::sleep(Duration::from_millis(800));
        assert!(call.music_audible());

        // Another new speaker: silent within the level's fall (500 ms),
        // then no longer heard.
        assert_eq!(call.wait_for_voice(true), Some(true));
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!call.music_audible());

        // Off, then on again while it waits: made, still silent.
        call.set_music(None, Some(true));
        assert!(!call.background_running());
        call.set_music(None, Some(false));
        assert!(call.background_running());
        std::thread::sleep(Duration::from_millis(500));
        assert!(!call.music_audible());
        call.wait_for_voice(false);
        std::thread::sleep(Duration::from_millis(800));
        assert!(call.music_audible());

        // A call without music says nothing of it.
        let (none, _packets, _errors) = start_waiting("", false, true);
        assert_eq!(none.wait_for_voice(false), None);
    }

    #[test]
    fn a_sentence_ducks_the_music_within_300_ms() {
        let (call, _packets, _errors) = start("audiotestsrc is-live=true wave=sine freq=440");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(call.duck_gain(), 1.0);
        let mut sentence = call.sentence();
        sentence.push(&vec![0.1f32; 48_000 * 2]);
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            (call.duck_gain() - 0.15).abs() < 0.01,
            "{}",
            call.duck_gain()
        );
        sentence.finish();
    }

    #[test]
    fn duck_goes_down_within_300_ms_and_back_after_release() {
        let mut duck = Duck::new(1.0, 0.15, 3000);
        let block = |duck: &mut Duck, at_ms: u64, active: bool| {
            let mut samples = vec![1.0f32; 480 * 2];
            duck.apply(&mut samples, 2, at_ms * 1_000_000, active);
            samples[samples.len() - 1]
        };
        // Talking from 0: ducked by 300 ms.
        let mut t = 0;
        while t < 300 {
            block(&mut duck, t, true);
            t += 10;
        }
        assert!((duck.gain - 0.15).abs() < 1e-6, "gain {}", duck.gain);
        // Talking until 1 s, then quiet: held down for the release.
        while t < 1000 {
            block(&mut duck, t, true);
            t += 10;
        }
        while t < 3990 {
            let out = block(&mut duck, t, false);
            assert!((out - 0.15).abs() < 1e-3, "at {t} ms: {out}");
            t += 10;
        }
        // Up over 1.5 s once the release passed.
        while t < 4000 + 1500 + 20 {
            block(&mut duck, t, false);
            t += 10;
        }
        assert!((duck.gain - 1.0).abs() < 1e-6, "gain {}", duck.gain);
        // Half way up after 750 ms of ramp.
        let mut duck2 = Duck::new(1.0, 0.15, 3000);
        let mut t = 0;
        while t < 500 {
            block(&mut duck2, t, true);
            t += 10;
        }
        while t < 500 + 3000 + 750 {
            block(&mut duck2, t, false);
            t += 10;
        }
        assert!((duck2.gain - 0.575).abs() < 0.02, "gain {}", duck2.gain);
    }

    #[test]
    fn duck_ramps_without_steps() {
        let mut duck = Duck::new(1.0, 0.15, 0);
        let mut samples = vec![1.0f32; 48_000];
        duck.apply(&mut samples, 1, 0, true);
        let max_step = samples
            .windows(2)
            .map(|w| (w[0] - w[1]).abs())
            .fold(0.0f32, f32::max);
        // 0.85 over 250 ms at 48 kHz: about 7e-5 a sample.
        assert!(max_step < 1e-4, "step {max_step}");
    }

    #[test]
    fn level_follows_volume_smoothly() {
        let mut duck = Duck::new(0.6, 0.15, 3000);
        duck.target = 0.0;
        let mut samples = vec![1.0f32; 48_000 / 4];
        duck.apply(&mut samples, 1, 0, false);
        assert!(duck.level > 0.0 && duck.level < 0.6);
        let mut samples = vec![1.0f32; 48_000];
        duck.apply(&mut samples, 1, 250_000_000, false);
        assert_eq!(duck.level, 0.0);
    }

    #[test]
    fn the_users_talking_ducks_until_it_ends_and_at_most_a_minute() {
        let (call, _, _) = start("");
        let now = call.now();
        call.set_user_talking(true);
        {
            let mix = call.mix.lock().unwrap();
            assert!(mix.active(now + gst::ClockTime::from_seconds(5)));
            assert!(!mix.active(now + gst::ClockTime::from_seconds(61)));
        }
        call.set_user_talking(false);
        assert!(
            !call
                .mix
                .lock()
                .unwrap()
                .active(now + gst::ClockTime::from_seconds(5))
        );
    }

    fn write_wav(path: &std::path::Path, stereo: &[f32]) {
        let mut out = Vec::with_capacity(44 + stereo.len() * 4);
        let data = (stereo.len() * 4) as u32;
        out.extend(b"RIFF");
        out.extend((36 + data).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(3u16.to_le_bytes()); // IEEE float
        out.extend(2u16.to_le_bytes());
        out.extend(RATE.to_le_bytes());
        out.extend((RATE * 8).to_le_bytes());
        out.extend(8u16.to_le_bytes());
        out.extend(32u16.to_le_bytes());
        out.extend(b"data");
        out.extend(data.to_le_bytes());
        for s in stereo {
            out.extend(s.to_le_bytes());
        }
        std::fs::write(path, out).unwrap();
    }

    /// Records the call's chain from what an app plays, for listening:
    /// `a-tap.wav` as tapped, `b-call-opus.wav` through the call's mix and
    /// Opus, both at the same time. ROAMGATE_CALL_RECORD=<dir>, and
    /// ROAMGATE_CALL_BACKGROUND (default: Spotify's tap); macOS, with the
    /// System Audio Recording permission.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn record_the_chain() {
        let dir = std::path::PathBuf::from(
            std::env::var("ROAMGATE_CALL_RECORD").expect("ROAMGATE_CALL_RECORD=<dir>"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let seconds: u64 = std::env::var("ROAMGATE_CALL_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(12);
        let background = std::env::var("ROAMGATE_CALL_BACKGROUND")
            .unwrap_or_else(|_| "osxprocesstapsrc bundle-id=com.spotify.client".into());
        gst::init().unwrap();
        crate::processtap::register().unwrap();
        let tap = gst::parse::launch(&format!(
            "{background} ! audioconvert ! audioresample ! \
             audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=2 ! \
             appsink name=out sync=false"
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let raw: Arc<Mutex<Vec<f32>>> = Arc::default();
        {
            let raw = raw.clone();
            tap.by_name("out")
                .unwrap()
                .downcast::<gst_app::AppSink>()
                .unwrap()
                .set_callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample(move |sink| {
                            let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                            let map = sample.buffer().unwrap().map_readable().unwrap();
                            raw.lock().unwrap().extend(
                                map.chunks_exact(4)
                                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                            );
                            Ok(gst::FlowSuccess::Ok)
                        })
                        .build(),
                );
        }
        tap.set_state(gst::State::Playing).unwrap();
        let (call, packets, errors) = start(&background);
        assert!(call.music, "{:?}", errors.lock().unwrap());
        std::thread::sleep(Duration::from_secs(seconds));
        drop(call);
        tap.set_state(gst::State::Null).unwrap();
        let raw = raw.lock().unwrap().clone();
        let packets = packets.lock().unwrap().clone();
        let mixed = decode(&packets);
        let rms = |s: &[f32]| {
            (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt()
        };
        let peak = |s: &[f32]| s.iter().fold(0f32, |m, x| m.max(x.abs()));
        let bytes: usize = packets.iter().map(|(_, p)| p.len()).sum();
        eprintln!(
            "tap: {:.2} s, rms {:.4}, peak {:.3}; call: {} packets, {:.0} kb/s, {:.2} s, rms {:.4}, peak {:.3}",
            raw.len() as f64 / 96_000.0,
            rms(&raw),
            peak(&raw),
            packets.len(),
            bytes as f64 * 8.0 / seconds as f64 / 1000.0,
            mixed.len() as f64 / 96_000.0,
            rms(&mixed),
            peak(&mixed),
        );
        write_wav(&dir.join("a-tap.wav"), &raw);
        write_wav(&dir.join("b-call-opus.wav"), &mixed);
    }
}
