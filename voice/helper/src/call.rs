//! A voice call's audio, as a WebRTC call with the page: webrtcsink sends
//! the replies mixed with a background source (music), and webrtcsrc
//! receives the page's microphone for the listener (listen.rs). Both talk
//! GStreamer's WebRTC signalling protocol to the signalling server
//! webrtcsink runs for the call, on 127.0.0.1 only: Roamgate fronts it
//! (/api/voice/call/signalling), and the page uses gstwebrtc-api.
//!
//! ```text
//! voice:  appsrc (F32 48 kHz stereo, timestamps set here) ------------> mix
//! music:  <background> ! audioconvert ! audioresample ! F32 48k stereo
//!         (ducked in a probe) --------------------------------------> mix
//! video:  a YouTube video's own pipeline ! appsrc (youtube.rs, ducked
//!         as the music) ----------------------------------------------> mix
//! floor:  audiotestsrc wave=silence is-live=true --------------------> mix
//! audiomixer latency=60ms ! F32 48k stereo ! webrtcsink (Opus 128 kb/s)
//!
//! microphone: webrtcsrc (the page's producer) ! audioconvert !
//!   audioresample ! S16LE 16 kHz mono ! appsink -> the listener
//! ```
//!
//! A page playing the replies on a phone's loudspeaker without its own
//! echo canceller (its loudspeaker mode) asks for it here: the microphone
//! then goes through echo.rs's canceller, the mix as it goes to
//! webrtcsink (a copy, from a probe) being the far end.
//!
//! Pairing: webrtcsink's producer carries `{"call": <id>, "role":
//! "replies"}` as its meta, and the page consumes the producer of its
//! call; the page's microphone producer carries `{"call": <id>, "role":
//! "microphone"}`, and the page tells its peer id (call_microphone), which
//! webrtcsrc is pointed at, never at whichever producer comes first. A new
//! peer id (the page's signalling socket came back) makes webrtcsrc again.
//!
//! ICE: the WebRTC agents gather on the machine's IPv4 addresses and on
//! 127.0.0.1, UDP only, in ICE_PORTS. Tailscale's userspace networking
//! forwards UDP to this machine's Tailscale address to 127.0.0.1 on the
//! same port, so Roamgate gives the page the loopback candidates with that
//! address (`call_ice_address`).
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
//! talking, sample by sample (`Duck`), so there are no clicks. Every way
//! a sentence ends (said, failed, silent, hushed, its request gone) lets
//! go of its hold, and none holds longer than its audio queued, or
//! MAKING_HOLD_MAX while it gives none; the user's talking at most
//! USER_TALKING_MAX.
//!
//! The music waits, silent, while the listener learns a new speaker's
//! voice from what it hears (`wait_for_voice`): the speaker check would
//! take a singer's. It fades in once their voice is taken, and goes silent
//! again when another new speaker is to be learnt.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;

mod youtube;
pub use youtube::{OnEvent as OnYoutubeEvent, Pause, YoutubeRequest};

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
/// The longest a sentence being made ducks the music without any of it
/// coming: past it, one whose synthesis is stuck (or that never ends) no
/// longer keeps the music down. Its audio, once it comes, ducks it again.
const MAKING_HOLD_MAX: gst::ClockTime = gst::ClockTime::from_seconds(10);
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
    /// The loudness each voice's replies are brought to, in LUFS; None
    /// leaves them as the models make them (see loudness.rs).
    pub reply_loudness: Option<f64>,
    /// The highest the replies' peaks go, in dBTP.
    pub reply_peak: f64,
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
            reply_loudness: Some(DEFAULT_REPLY_LOUDNESS),
            reply_peak: DEFAULT_REPLY_PEAK,
        }
    }
}

/// Broadcast speech's loudness: a phone's own loudspeaker plays calls on
/// the quieter voice call stream, and the models make -20 to -24 LUFS.
pub const DEFAULT_REPLY_LOUDNESS: f64 = -16.0;
pub const DEFAULT_REPLY_PEAK: f64 = -1.0;

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
    /// Sentences being made: the music ducks from the request on. Only
    /// those of `pending_generation` count: a hush lets go of the others.
    pending: u32,
    pending_generation: u64,
    /// When a sentence being made last started or gave audio (running
    /// time): one that gives nothing for MAKING_HOLD_MAX stops ducking.
    made_at: Option<gst::ClockTime>,
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
    /// Since when the background's source is in the pipeline, if it is.
    background_since: Option<std::time::Instant>,
    /// When the background last carried sound above MUSIC_AUDIBLE, as it
    /// comes, whatever its level in the mix: a player really playing into
    /// the sink it records (youtube.rs's Spotify check).
    background_heard: Option<std::time::Instant>,
    /// A YouTube video's envelope (youtube.rs): ducked as the background,
    /// at the same level.
    youtube_duck: Duck,
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
        (self.pending > 0 && self.made_at.is_some_and(|made| at < made + MAKING_HOLD_MAX))
            || self
                .user_talking
                .is_some_and(|since| at < since + USER_TALKING_MAX)
            || self.voice_next.is_some_and(|next| next > at)
    }
}

/// The background, or the microphone, failed: the call goes on without.
pub type OnError = Arc<dyn Fn(String) + Send + Sync>;
/// The page's microphone, as it comes: 16 kHz mono S16LE.
pub type OnSamples = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// The UDP ports the call's WebRTC agents take theirs from: a range a
/// firewall can let through.
pub const ICE_PORTS: (u32, u32) = (40_000, 40_999);
/// The microphone as the listener takes it (listen.rs).
const MICROPHONE_RATE: i32 = 16_000;

/// Whether the helper traces (ROAMGATE_VOICE_DEBUG).
fn tracing() -> bool {
    std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some()
}

pub struct Call {
    pub id: u32,
    /// The port of the call's signalling server, on 127.0.0.1.
    pub signalling_port: u16,
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
    /// The page's microphone, once it said which producer it is.
    microphone: Mutex<Option<Microphone>>,
    /// The microphone's echo canceller, when the page asked for it here:
    /// the mix goes to it as it goes out.
    echo: Arc<Mutex<Option<Arc<crate::echo::EchoCanceller>>>>,
    on_error: OnError,
    /// What each voice makes, to bring its replies to the loudness asked
    /// for; None to leave them as made.
    voices: Option<Mutex<crate::loudness::Voices>>,
    /// A YouTube video playing into the mix (youtube.rs).
    youtube: Arc<youtube::Tube>,
}

/// webrtcsrc consuming the page's microphone producer, in a pipeline of its
/// own: its session ending or failing leaves the replies alone.
struct Microphone {
    pipeline: gst::Pipeline,
    peer: String,
    /// Being stopped (replaced, or its call ended): what its teardown posts
    /// on the bus is no failure to tell.
    dropping: Arc<AtomicBool>,
}

impl Drop for Microphone {
    fn drop(&mut self) {
        self.dropping.store(true, Ordering::SeqCst);
        stop_away(self.pipeline.clone());
    }
}

/// The pipelines being stopped away from their caller (stop_away).
static STOPPING: Mutex<Vec<std::thread::JoinHandle<()>>> = Mutex::new(Vec::new());

/// Stops `pipeline` on a thread of its own: a WebRTC element's teardown
/// waits for its session to be finalised, which once never came, and the
/// helper's call thread (the next call, call_microphone) must go on.
fn stop_away(pipeline: gst::Pipeline) {
    let name = pipeline.name();
    let spawned = std::thread::Builder::new()
        .name(format!("stop {name}"))
        .spawn(move || {
            let started = std::time::Instant::now();
            let _ = pipeline.set_state(gst::State::Null);
            if started.elapsed() > std::time::Duration::from_secs(2) {
                eprintln!(
                    "{name} took {:.1} s to stop",
                    started.elapsed().as_secs_f32()
                );
            }
        });
    match spawned {
        Ok(handle) => {
            let mut stopping = STOPPING.lock().unwrap();
            stopping.retain(|handle| !handle.is_finished());
            stopping.push(handle);
        }
        Err(err) => eprintln!("{err}"),
    }
}

/// Waits up to `timeout` for the pipelines being stopped: false when one
/// is still stopping (GStreamer must then not be deinitialised).
pub fn finish_stopping(timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let mut stopping = STOPPING.lock().unwrap();
        stopping.retain(|handle| !handle.is_finished());
        if stopping.is_empty() {
            return true;
        }
        drop(stopping);
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

impl Microphone {
    fn start(
        call: u32,
        port: u16,
        peer: &str,
        on_samples: OnSamples,
        on_error: OnError,
    ) -> Result<Self, String> {
        let pipeline = gst::Pipeline::with_name(&format!("roamgate-call-{call}-microphone"));
        let source = gst::ElementFactory::make("webrtcsrc")
            .name("microphone")
            .build()
            .map_err(|_| "no webrtcsrc element".to_string())?;
        let signaller = source.property::<gst::glib::Object>("signaller");
        signaller.set_property("uri", format!("ws://127.0.0.1:{port}"));
        // Its producer, by id: never whichever comes first.
        signaller.set_property("producer-peer-id", peer);
        source.set_property("stun-server", None::<String>);
        source.set_property("meta", meta(call, "listener"));
        source.set_property("audio-codecs", gst::Array::new(["OPUS"]));
        signaller.connect("webrtcbin-ready", false, move |values| {
            if let Ok(webrtcbin) = values[2].get::<gst::Element>() {
                configure_ice(&webrtcbin, &format!("call {call} microphone"));
            }
            None
        });
        let convert = make("audioconvert")?;
        let resample = make("audioresample")?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("audio/x-raw")
                    .field("format", "S16LE")
                    .field("layout", "interleaved")
                    .field("rate", MICROPHONE_RATE)
                    .field("channels", 1i32)
                    .build(),
            )
            .build()
            .map_err(|e| e.to_string())?;
        let sink = gst_app::AppSink::builder()
            .name("heard")
            .sync(false)
            .build();
        pipeline
            .add_many([&source, &convert, &resample, &caps, sink.upcast_ref()])
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&convert, &resample, &caps, sink.upcast_ref()])
            .map_err(|e| e.to_string())?;
        // Its pad comes with the session (decoded), and goes with it.
        let into = convert.static_pad("sink").unwrap();
        source.connect_pad_added(move |_, pad| {
            if !pad.name().starts_with("audio") {
                return;
            }
            if let Some(old) = into.peer() {
                let _ = old.unlink(&into);
            }
            if let Err(err) = pad.link(&into) {
                eprintln!("call {call}: the microphone did not link: {err:?}");
            } else if tracing() {
                eprintln!("[voice] call {call}: the microphone streams");
            }
        });
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    if let Some(buffer) = sample.buffer()
                        && let Ok(map) = buffer.map_readable()
                    {
                        on_samples(map.to_vec());
                    }
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let told = on_error.clone();
        let dropping = Arc::new(AtomicBool::new(false));
        let stopped = dropping.clone();
        pipeline.bus().unwrap().set_sync_handler(move |_, message| {
            if let gst::MessageView::Error(err) = message.view()
                && !stopped.load(Ordering::SeqCst)
            {
                told(format!("the microphone failed: {}", err.error()));
            }
            gst::BusSyncReply::Drop
        });
        if let Err(err) = pipeline.set_state(gst::State::Playing) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!("the microphone failed to start: {err}"));
        }
        if tracing() {
            eprintln!("[voice] call {call}: listening to the page's microphone ({peer})");
        }
        Ok(Self {
            pipeline,
            peer: peer.to_string(),
            dropping,
        })
    }
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

/// Mean square of `samples`.
fn loudness(samples: &[f32]) -> f32 {
    samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|_| format!("no {factory} element"))
}

/// A TCP port free on 127.0.0.1 now, for the call's signalling server.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("no port for the call's signalling: {e}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|e| e.to_string())
}

/// The meta a call's producer and consumers carry in the signalling.
fn meta(call: u32, role: &str) -> gst::Structure {
    gst::Structure::builder("meta")
        .field("call", call as i32)
        .field("role", role)
        .build()
}

/// webrtcsink sending the mix as Opus, and running the call's signalling
/// server on 127.0.0.1:`port`.
fn replies_sink(call: u32, port: u16) -> Result<gst::Element, String> {
    let sink = gst::ElementFactory::make("webrtcsink")
        .name("replies")
        .build()
        .map_err(|_| "no webrtcsink element".to_string())?;
    sink.set_property("run-signalling-server", true);
    sink.set_property("signalling-server-host", "127.0.0.1");
    sink.set_property("signalling-server-port", port as u32);
    sink.set_property("meta", meta(call, "replies"));
    // Only the agents' own addresses (configure_ice): nothing to ask a
    // STUN server on the internet.
    sink.set_property("stun-server", None::<String>);
    sink.set_property_from_str("congestion-control", "disabled");
    // The mix as it was on the voice socket: music needs more than speech.
    sink.connect("encoder-setup", false, |values| {
        let encoder = values[3].get::<gst::Element>().ok()?;
        if encoder.factory().is_some_and(|f| f.name() == "opusenc") {
            encoder.set_property("bitrate", 128_000i32);
            encoder.set_property_from_str("bitrate-type", "vbr");
            encoder.set_property_from_str("audio-type", "generic");
            encoder.set_property_from_str("frame-size", "20");
            encoder.set_property("dtx", false);
        }
        // webrtcsink's own settings apply too.
        Some(false.to_value())
    });
    sink.connect("consumer-added", false, move |values| {
        let peer = values[1].get::<String>().unwrap_or_default();
        if let Ok(webrtcbin) = values[2].get::<gst::Element>() {
            configure_ice(&webrtcbin, &format!("call {call} replies to {peer}"));
        }
        None
    });
    Ok(sink)
}

/// The machine's IPv4 addresses, and 127.0.0.1: the loopback one is what
/// Tailscale's userspace networking forwards UDP to. ROAMGATE_VOICE_ICE_ADDRESSES
/// (comma-separated) gives them instead, such as only 127.0.0.1 to keep
/// calls on Tailscale.
pub fn local_addresses() -> Vec<String> {
    addresses_from(
        std::env::var("ROAMGATE_VOICE_ICE_ADDRESSES").ok(),
        interface_addresses,
    )
}

/// The addresses `given` lists, else the interfaces'. An empty `given` is
/// none given: `systemd-run -E NAME` (voice.json's helper_wrapper) passes
/// a NAME unset where it runs as set and empty, and an empty list would
/// leave the agent to gather by itself, without 127.0.0.1, so a phone off
/// the LAN would find no address of ours to reach.
fn addresses_from(given: Option<String>, interfaces: impl FnOnce() -> Vec<String>) -> Vec<String> {
    let listed: Vec<String> = given
        .unwrap_or_default()
        .split(',')
        .map(|address| address.trim().to_string())
        .filter(|address| !address.is_empty())
        .collect();
    if listed.is_empty() {
        interfaces()
    } else {
        listed
    }
}

#[cfg(unix)]
fn interface_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    // SAFETY: getifaddrs' list is read before freeifaddrs frees it.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) == 0 {
            let mut at = list;
            while !at.is_null() {
                let entry = &*at;
                at = entry.ifa_next;
                let up = entry.ifa_flags & libc::IFF_UP as u32 != 0;
                // Up with no carrier (a container bridge nobody uses, such
                // as docker0): an address no check ever gets an answer
                // from, which only keeps a call's checks waiting.
                let running = entry.ifa_flags & libc::IFF_RUNNING as u32 != 0;
                let loopback = entry.ifa_flags & libc::IFF_LOOPBACK as u32 != 0;
                if !up || !running || loopback || entry.ifa_addr.is_null() {
                    continue;
                }
                if (*entry.ifa_addr).sa_family as i32 != libc::AF_INET {
                    continue;
                }
                let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                let ip = std::net::Ipv4Addr::from(u32::from_be(address.sin_addr.s_addr));
                // Link-local addresses reach nobody a phone is.
                if !ip.is_link_local() {
                    addresses.push(ip.to_string());
                }
            }
            libc::freeifaddrs(list);
        }
    }
    addresses.sort();
    addresses.dedup();
    addresses.push("127.0.0.1".to_string());
    addresses
}

/// Elsewhere, the agent's own choice.
#[cfg(not(unix))]
fn interface_addresses() -> Vec<String> {
    Vec::new()
}

/// STUN retransmissions of a connectivity check before its pair fails:
/// libnice's 3 (checks sent at 0, 0.5, 1.5 and 3.5 s) keep the replies'
/// leg, whose agent nominates, from choosing the pair that works while
/// pairs that never answer (a phone's mobile addresses towards the LAN's)
/// are still being tried. Two still give a path seconds to answer.
const ICE_CHECK_RETRANSMISSIONS: u32 = 2;

/// Sets a call's WebRTC agent up: its addresses (local_addresses), UDP in
/// ICE_PORTS, no TCP, checks given up sooner (ICE_CHECK_RETRANSMISSIONS);
/// and traces its ICE states.
pub fn configure_ice(webrtcbin: &gst::Element, what: &str) {
    if let Some(ice) = webrtcbin.property::<Option<gst::glib::Object>>("ice-agent") {
        if ice.find_property("agent").is_some()
            && let Some(agent) = ice.property::<Option<gst::glib::Object>>("agent")
            && agent.find_property("stun-max-retransmissions").is_some()
        {
            agent.set_property("stun-max-retransmissions", ICE_CHECK_RETRANSMISSIONS);
        }
        if gst::glib::subclass::SignalId::lookup("add-local-ip-address", ice.type_()).is_some() {
            for address in local_addresses() {
                ice.emit_by_name::<bool>("add-local-ip-address", &[&address]);
            }
        }
        if ice.find_property("min-rtp-port").is_some() {
            ice.set_property("max-rtp-port", ICE_PORTS.1);
            ice.set_property("min-rtp-port", ICE_PORTS.0);
        }
        if ice.find_property("ice-tcp").is_some() {
            ice.set_property("ice-tcp", false);
        }
    }
    if tracing() {
        let what = what.to_string();
        webrtcbin.connect_notify(Some("ice-connection-state"), move |webrtcbin, _| {
            let state = webrtcbin
                .property_value("ice-connection-state")
                .serialize()
                .map(|state| state.to_string())
                .unwrap_or_default();
            eprintln!("[voice] {what}: ICE {state}");
        });
    }
}

impl Call {
    /// Starts call `id`'s pipeline. A background that cannot be made is
    /// told to `on_error` and left out: the call goes on with the voice.
    pub fn start(id: u32, settings: &Settings, on_error: OnError) -> Result<Self, String> {
        let signalling_port = free_port()?;
        let pipeline = gst::Pipeline::with_name(&format!("roamgate-call-{id}"));
        let mixer = gst::ElementFactory::make("audiomixer")
            .name("mix")
            .property("latency", MIXER_LATENCY)
            .build()
            .map_err(|_| "no audiomixer element".to_string())?;
        let mixed = gst::ElementFactory::make("capsfilter")
            .name("mixed")
            .property("caps", raw_caps())
            .build()
            .map_err(|e| e.to_string())?;
        let sink = replies_sink(id, signalling_port)?;
        pipeline
            .add_many([&mixer, &mixed, &sink])
            .map_err(|e| e.to_string())?;
        mixer.link(&mixed).map_err(|e| e.to_string())?;
        let audio = sink
            .request_pad_simple("audio_%u")
            .ok_or("webrtcsink gave no audio pad")?;
        mixed
            .static_pad("src")
            .unwrap()
            .link(&audio)
            .map_err(|e| e.to_string())?;
        // What the page plays, for the microphone's echo canceller.
        let echo: Arc<Mutex<Option<Arc<crate::echo::EchoCanceller>>>> = Arc::default();
        {
            let echo = echo.clone();
            mixed.static_pad("src").unwrap().add_probe(
                gst::PadProbeType::BUFFER,
                move |_, info| {
                    let canceller = echo.lock().unwrap().clone();
                    if let (Some(canceller), Some(buffer)) = (canceller, info.buffer()) {
                        canceller.far(buffer);
                    }
                    gst::PadProbeReturn::Ok
                },
            );
        }

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
            pending_generation: 0,
            made_at: None,
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
            background_since: None,
            background_heard: None,
            youtube_duck: Duck::new(
                settings.volume.clamp(0.0, 1.0),
                settings.ducked,
                settings.release_ms,
            ),
        }));
        let music_frames = Arc::new(AtomicU64::new(0));
        if let Err(err) = pipeline.set_state(gst::State::Playing) {
            let detail = crate::bus_error(&pipeline).unwrap_or_else(|| err.to_string());
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!("the call's audio failed to start: {detail}"));
        }
        let youtube = Arc::new(youtube::Tube::new(
            id,
            pipeline.clone(),
            mixer.clone(),
            mix.clone(),
        ));
        let mut call = Self {
            id,
            signalling_port,
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
            microphone: Mutex::new(None),
            echo,
            on_error: on_error.clone(),
            youtube,
            voices: settings.reply_loudness.map(|target| {
                Mutex::new(crate::loudness::Voices::new(
                    target,
                    settings.reply_peak.min(0.0),
                ))
            }),
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
                    if loudness(samples) > MUSIC_AUDIBLE {
                        mix.background_heard = Some(std::time::Instant::now());
                    }
                    mix.duck
                        .apply(samples, CHANNELS as usize, at.nseconds(), active);
                    if loudness(samples) > MUSIC_AUDIBLE {
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
        let mut mix = self.mix.lock().unwrap();
        mix.background_since = Some(std::time::Instant::now());
        mix.background_heard = None;
        Ok(())
    }

    /// Takes the background out of the pipeline and stops it.
    fn detach(&self, branch: Branch) {
        self.mix.lock().unwrap().background_since = None;
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

    /// Listens to the page's microphone: webrtcsrc consuming producer
    /// `peer` (the page's own id in the signalling), its audio to
    /// `on_samples`, the replies' echo taken out first when `cancel_echo`
    /// (the page cancels none). A new peer replaces the one before; the
    /// same one makes its session again (the page published it anew).
    pub fn set_microphone(
        &self,
        peer: &str,
        on_samples: OnSamples,
        cancel_echo: bool,
    ) -> Result<(), String> {
        if peer.is_empty() || peer.len() > 128 {
            return Err("no microphone peer".into());
        }
        // The one before goes first: its session ends with it.
        self.microphone.lock().unwrap().take();
        self.echo.lock().unwrap().take();
        let id = self.id;
        let (heard, canceller) = if cancel_echo {
            let report: crate::echo::OnReport =
                Arc::new(move |report| eprintln!("call {id}: echo canceller: {report}"));
            match crate::echo::EchoCanceller::start(
                &crate::echo::Settings::default(),
                &raw_caps(),
                on_samples.clone(),
                report,
            ) {
                Ok(canceller) => {
                    let canceller = Arc::new(canceller);
                    let near = canceller.clone();
                    let heard: OnSamples = Arc::new(move |samples| near.near(samples));
                    eprintln!(
                        "call {id}: the page plays the replies without its echo canceller: the echo is cancelled here (AEC3, {} ms lead until the echo's delay is measured)",
                        crate::echo::DEFAULT_LEAD_MS
                    );
                    (heard, Some(canceller))
                }
                Err(err) => {
                    eprintln!("call {id}: {err}: the microphone goes as it comes, echo and all");
                    (on_samples, None)
                }
            }
        } else {
            eprintln!("call {id}: the page cancels the replies' echo itself");
            (on_samples, None)
        };
        let microphone = Microphone::start(
            self.id,
            self.signalling_port,
            peer,
            heard,
            self.on_error.clone(),
        )?;
        *self.microphone.lock().unwrap() = Some(microphone);
        *self.echo.lock().unwrap() = canceller;
        Ok(())
    }

    /// Whether the microphone's echo is cancelled here now.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cancels_echo(&self) -> bool {
        self.echo.lock().unwrap().is_some()
    }

    /// The page's microphone producer listened to now, if any.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn microphone_peer(&self) -> Option<String> {
        self.microphone
            .lock()
            .unwrap()
            .as_ref()
            .map(|microphone| microphone.peer.clone())
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
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn sentence(&self) -> Sentence<'_> {
        self.sentence_of("")
    }

    /// A sentence read by `voice` (its models and language): brought to
    /// the replies' loudness from what that voice made before.
    pub fn sentence_of(&self, voice: &str) -> Sentence<'_> {
        let now = self.now();
        let generation = {
            let mut mix = self.mix.lock().unwrap();
            let generation = self.generation.load(Ordering::SeqCst);
            if mix.pending_generation != generation {
                mix.pending_generation = generation;
                mix.pending = 0;
            }
            mix.pending += 1;
            mix.made_at = Some(now);
            generation
        };
        let level = self.voices.as_ref().map(|voices| {
            let voices = voices.lock().unwrap();
            crate::loudness::Level::new(CHANNELS as usize, voices.gain_db(voice), voices.peak)
        });
        Sentence {
            call: self,
            generation,
            leftover: Vec::new(),
            start: None,
            frames: 0,
            done: false,
            voice: voice.to_string(),
            level,
        }
    }

    /// The user talks over the voice: everything queued goes.
    pub fn hush(&self) {
        let mut mix = self.mix.lock().unwrap();
        // The sentences still being made are dropped as they come: they
        // no longer hold the music down.
        mix.pending_generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        mix.pending = 0;
        mix.voice_next = None;
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
                eprintln!(
                    "call {}: a voice was taken: the call's music plays",
                    self.id
                );
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

    /// A `call_youtube` request: a YouTube video's sound played into the
    /// mix as the call's music (youtube.rs). Answers its state.
    pub fn youtube(
        &self,
        request: &YoutubeRequest,
        pause: &Pause,
        on_event: &OnYoutubeEvent,
    ) -> Result<serde_json::Value, String> {
        self.youtube.request(request, pause, on_event)
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
        // The microphone's session ends before the signalling server goes.
        self.microphone.lock().unwrap().take();
        // Its sources stop with it: a process tap is destroyed then.
        self.branch.lock().unwrap().take();
        self.youtube.stop();
        stop_away(self.pipeline.clone());
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
    voice: String,
    /// Its gain and limiter, and what it measures of the voice.
    level: Option<crate::loudness::Level>,
}

impl Sentence<'_> {
    /// Interleaved stereo F32 at 48 kHz, as it is made.
    pub fn push(&mut self, samples: &[f32]) {
        match &mut self.level {
            Some(level) => {
                let leveled = level.push(samples);
                self.queue(&leveled);
            }
            None => self.queue(samples),
        }
    }

    fn queue(&mut self, samples: &[f32]) {
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
            mix.made_at = Some(self.call.now());
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
        if let Some(mut level) = self.level.take() {
            let (tail, made) = level.finish();
            self.queue(&tail);
            if let (Some((lufs, blocks)), Some(voices)) = (made, &self.call.voices) {
                let mut voices = voices.lock().unwrap();
                voices.learn(&self.voice, lufs, blocks);
                if tracing() {
                    eprintln!(
                        "[voice] call {}: a reply made at {lufs:.1} LUFS, raised {:+.1} dB; \
                         the next by this voice {:+.1} dB to {:.0} LUFS",
                        self.call.id,
                        level.gain_db,
                        voices.gain_db(&self.voice),
                        voices.target,
                    );
                }
            }
        }
        if !self.leftover.is_empty() {
            let block = BLOCK_FRAMES * CHANNELS as usize;
            let mut last = std::mem::take(&mut self.leftover);
            last.resize(block, 0.0);
            self.push_block(&last);
        }
        self.done = true;
        self.release();
        let start = self
            .start
            .map_or(self.call.now().mseconds(), |s| s.mseconds());
        (start, self.frames * 1000 / RATE as u64)
    }
}

impl Sentence<'_> {
    /// Its hold on the music: let go once, said or not (failed, silent,
    /// hushed, its request gone).
    fn release(&self) {
        let mut mix = self.call.mix.lock().unwrap();
        if mix.pending_generation == self.generation {
            mix.pending = mix.pending.saturating_sub(1);
        }
    }
}

impl Drop for Sentence<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.release();
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

    #[test]
    fn ice_addresses_given_empty_are_the_interfaces() {
        let interfaces = || vec!["192.168.1.86".to_string(), "127.0.0.1".to_string()];
        // systemd-run -E passes an unset name as set and empty.
        assert_eq!(
            addresses_from(Some(String::new()), interfaces),
            interfaces()
        );
        assert_eq!(
            addresses_from(Some(" , ".to_string()), interfaces),
            interfaces()
        );
        assert_eq!(addresses_from(None, interfaces), interfaces());
        assert_eq!(
            addresses_from(Some("127.0.0.1, 10.0.0.2".to_string()), interfaces),
            vec!["127.0.0.1".to_string(), "10.0.0.2".to_string()]
        );
    }

    /// What went into webrtcsink: (pts in µs, F32 48 kHz stereo samples).
    type Mixed = Arc<Mutex<Vec<(u64, Vec<f32>)>>>;

    fn start(background: &str) -> (Call, Mixed, Arc<Mutex<Vec<String>>>) {
        start_with(background, false)
    }

    fn start_with(background: &str, muted: bool) -> (Call, Mixed, Arc<Mutex<Vec<String>>>) {
        start_waiting(background, muted, false)
    }

    fn init() {
        gst::init().unwrap();
        let _ = gstrswebrtc::plugin_register_static();
    }

    fn start_waiting(
        background: &str,
        muted: bool,
        wait_for_voice: bool,
    ) -> (Call, Mixed, Arc<Mutex<Vec<String>>>) {
        init();
        let errors: Arc<Mutex<Vec<String>>> = Arc::default();
        let call = {
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
                    // The tests' levels as pushed.
                    reply_loudness: None,
                    reply_peak: DEFAULT_REPLY_PEAK,
                },
                Arc::new(move |error| errors.lock().unwrap().push(error)),
            )
            .unwrap()
        };
        let mixed: Mixed = Arc::default();
        {
            let mixed = mixed.clone();
            call.pipeline
                .by_name("mixed")
                .unwrap()
                .static_pad("src")
                .unwrap()
                .add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                    if let Some(buffer) = info.buffer()
                        && let Ok(map) = buffer.map_readable()
                    {
                        mixed.lock().unwrap().push((
                            buffer.pts().map_or(0, |pts| pts.useconds()),
                            map.chunks_exact(4)
                                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                                .collect(),
                        ));
                    }
                    gst::PadProbeReturn::Ok
                });
        }
        (call, mixed, errors)
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

    /// The mix as one stream, from its first buffer's time.
    fn joined(mixed: &Mixed) -> (u64, Vec<f32>) {
        let mixed = mixed.lock().unwrap();
        let first = mixed.first().map_or(0, |(pts, _)| *pts);
        (first, mixed.iter().flat_map(|(_, s)| s.clone()).collect())
    }

    /// The strongest frequency of the left channel of `stereo` (48 kHz),
    /// in Hz.
    fn peak(stereo: &[f32]) -> f64 {
        let left: Vec<f64> = stereo.iter().step_by(2).map(|s| *s as f64).collect();
        peak_of(&left, RATE as f64)
    }

    /// The strongest frequency of `samples` at `rate`, by a plain DFT over
    /// 0 to 2 kHz in the window's bins.
    fn peak_of(samples: &[f64], rate: f64) -> f64 {
        let n = samples.len() as f64;
        let bin = rate / n;
        (1..(2000.0 / bin) as usize)
            .map(|k| {
                let w = 2.0 * std::f64::consts::PI * k as f64 / n;
                let (re, im) = samples
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
        let (call, mixed, errors) = start(
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
        let (first, decoded) = joined(&mixed);
        let at = |ms: u64| ((ms * 1000).saturating_sub(first) * 48 / 1000) as usize * 2;
        // After the voice, while the music still plays (ducked).
        let voice_end = start_ms + duration_ms + 60;
        let window = &decoded[at(voice_end)..at(voice_end + 400)];
        let found = peak(window);
        assert!((found - 440.0).abs() <= 2.5, "music peak at {found} Hz");
    }

    #[test]
    fn music_frames_cover_their_duration() {
        let (call, _mixed, _errors) = start(
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
        let (call, _mixed, _errors) = start("");
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
    fn replies_come_at_the_loudness_asked_their_length_kept() {
        init();
        let call = Call::start(2, &Settings::default(), Arc::new(|_| {})).unwrap();
        // A quiet voice: -30 LUFS, a 1 kHz sine at -30 dBFS on both sides.
        let quiet: Vec<f32> = (0..48_000 * 2)
            .flat_map(|n| {
                let s = 0.0316 * (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / 48_000.0).sin();
                [s, s]
            })
            .collect();
        let gain =
            |call: &Call, voice: &str| call.voices.as_ref().unwrap().lock().unwrap().gain_db(voice);
        assert_eq!(gain(&call, "quiet|fr"), 8.0);
        let mut sentence = call.sentence_of("quiet|fr");
        for chunk in quiet.chunks(2 * 777) {
            sentence.push(chunk);
        }
        let (_, duration) = sentence.finish();
        assert_eq!(duration, 2000);
        // Learnt: its next sentence is raised to -16.
        assert!((gain(&call, "quiet|fr") - 14.0).abs() < 0.2);
        assert_eq!(gain(&call, "other|fr"), 8.0);
    }

    #[test]
    fn a_bad_background_leaves_the_voice() {
        let (call, mixed, errors) = start("nosuchelementanywhere ! audioconvert");
        assert!(!call.music);
        assert_eq!(errors.lock().unwrap().len(), 1);
        let mut sentence = call.sentence();
        sentence.push(&vec![0.1f32; 48_000 * 2 / 5]);
        sentence.finish();
        std::thread::sleep(Duration::from_millis(500));
        assert!(call.voice_frames.load(Ordering::Relaxed) >= 9600);
        assert!(!mixed.lock().unwrap().is_empty());
    }

    #[test]
    fn music_off_stops_its_source_and_on_makes_it_again() {
        let (call, _mixed, _errors) = start("audiotestsrc is-live=true wave=sine freq=440");
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
        let (call, _mixed, _errors) =
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

    /// A Linux background can record a sound server's device (pulsesrc,
    /// such as a music sink's monitor) or raw audio from a FIFO.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_linux_background_can_record_a_sound_server() {
        init();
        for name in ["pulsesrc", "rawaudioparse"] {
            assert!(
                gst::ElementFactory::find(name).is_some(),
                "no {name} element"
            );
        }
    }

    /// The loudest sample mixed after `since_us`.
    fn loudest_since(mixed: &Mixed, since_us: u64) -> f32 {
        mixed
            .lock()
            .unwrap()
            .iter()
            .filter(|(pts, _)| *pts >= since_us)
            .flat_map(|(_, samples)| samples.iter().map(|s| s.abs()))
            .fold(0.0, f32::max)
    }

    fn mixed_until_now(mixed: &Mixed) -> u64 {
        mixed.lock().unwrap().last().map_or(0, |(pts, _)| *pts)
    }

    /// Music asked for while a new speaker's voice is learnt stays silent
    /// at the mix, its source made, until the voice is taken; then it fades
    /// in. Another new speaker silences it again; music put on meanwhile
    /// waits as well.
    #[test]
    fn the_music_waits_for_a_voice() {
        let (call, mixed, errors) =
            start_waiting("audiotestsrc is-live=true wave=sine freq=440", false, true);
        assert!(call.music, "{:?}", errors.lock().unwrap());
        assert!(call.background_running());
        assert!(call.music_waiting());
        std::thread::sleep(Duration::from_millis(600));
        assert!(call.music_frames.load(Ordering::Relaxed) > 0);
        assert_eq!(loudest_since(&mixed, 0), 0.0);
        assert!(!call.music_audible());

        // Told once at first, then each change.
        assert_eq!(call.wait_for_voice(true), Some(true));
        assert_eq!(call.wait_for_voice(true), None);
        assert_eq!(call.wait_for_voice(false), Some(false));
        assert_eq!(call.wait_for_voice(false), None);
        let taken = mixed_until_now(&mixed);
        std::thread::sleep(Duration::from_millis(800));
        assert!(loudest_since(&mixed, taken) > 0.5);
        assert!(call.music_audible());

        // Another new speaker: silent within the level's fall (500 ms).
        assert_eq!(call.wait_for_voice(true), Some(true));
        std::thread::sleep(Duration::from_millis(700));
        let silent = mixed_until_now(&mixed);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(loudest_since(&mixed, silent), 0.0);

        // Off, then on again while it waits: made, still silent.
        call.set_music(None, Some(true));
        assert!(!call.background_running());
        call.set_music(None, Some(false));
        assert!(call.background_running());
        let on = mixed_until_now(&mixed);
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(loudest_since(&mixed, on), 0.0);
        assert!(!call.music_audible());
        call.wait_for_voice(false);
        std::thread::sleep(Duration::from_millis(800));
        assert!(call.music_audible());

        // A call without music says nothing of it.
        let (none, _mixed, _errors) = start_waiting("", false, true);
        assert_eq!(none.wait_for_voice(false), None);
    }

    #[test]
    fn a_sentence_ducks_the_music_within_300_ms() {
        let (call, _mixed, _errors) = start("audiotestsrc is-live=true wave=sine freq=440");
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

    /// A sentence whose synthesis is stuck (nothing comes, it never ends)
    /// ducks the music only for MAKING_HOLD_MAX; its audio, once it comes,
    /// ducks it again.
    #[test]
    fn a_stuck_sentence_lets_the_music_back_up() {
        let (call, _, _) = start("");
        let now = call.now();
        let mut sentence = call.sentence();
        {
            let mix = call.mix.lock().unwrap();
            assert!(mix.active(now + gst::ClockTime::from_seconds(5)));
            assert!(!mix.active(now + gst::ClockTime::from_seconds(11)));
        }
        std::thread::sleep(Duration::from_millis(50));
        sentence.push(&vec![0.1f32; 4_800 * 2]);
        let pushed = call.now();
        {
            let mix = call.mix.lock().unwrap();
            assert!(mix.active(pushed + gst::ClockTime::from_seconds(9)));
            assert!(!mix.active(pushed + gst::ClockTime::from_seconds(11)));
        }
        drop(sentence);
    }

    /// Every way a sentence ends lets go of the music: said, failed
    /// (dropped unfinished), hushed while being made, and one made after a
    /// hush; a hushed one ending after newer ones does not let go of theirs.
    #[test]
    fn every_end_of_a_sentence_releases_the_duck() {
        let (call, _, _) = start("");
        let pending = |call: &Call| call.mix.lock().unwrap().pending;
        let later = |call: &Call| {
            let at = call.now() + gst::ClockTime::from_seconds(1);
            call.mix.lock().unwrap().active(at)
        };
        // Said.
        let mut said = call.sentence();
        said.push(&vec![0.1f32; 480 * 2]);
        said.finish();
        assert_eq!(pending(&call), 0);
        // Failed: the speaker gave up on it.
        let failed = call.sentence();
        assert!(later(&call));
        drop(failed);
        assert_eq!(pending(&call), 0);
        assert!(!later(&call));
        // Hushed while being made, ending after a newer one started.
        let hushed = call.sentence();
        call.hush();
        assert_eq!(pending(&call), 0);
        assert!(!later(&call));
        let newer = call.sentence();
        assert_eq!(pending(&call), 1);
        drop(hushed);
        assert_eq!(pending(&call), 1, "the hushed one let go of the newer one");
        assert!(later(&call));
        drop(newer);
        assert_eq!(pending(&call), 0);
        assert!(!later(&call));
        // Never below nothing: no wrap that would hold it for good.
        call.mix.lock().unwrap().pending = 0;
        let extra = call.sentence();
        call.mix.lock().unwrap().pending = 0;
        drop(extra);
        assert_eq!(pending(&call), 0);
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
        let (call, mixed, errors) = start(&background);
        assert!(call.music, "{:?}", errors.lock().unwrap());
        let (consumer, received) = consume_replies(&call);
        std::thread::sleep(Duration::from_secs(seconds));
        drop(call);
        consumer.set_state(gst::State::Null).unwrap();
        tap.set_state(gst::State::Null).unwrap();
        let raw = raw.lock().unwrap().clone();
        let (_, mixed) = joined(&mixed);
        let received = f32s(&received.lock().unwrap());
        let rms = |s: &[f32]| {
            (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt()
        };
        let peak = |s: &[f32]| s.iter().fold(0f32, |m, x| m.max(x.abs()));
        eprintln!(
            "tap: {:.2} s, rms {:.4}, peak {:.3}; mix: {:.2} s, rms {:.4}; over WebRTC: {:.2} s, rms {:.4}, peak {:.3}",
            raw.len() as f64 / 96_000.0,
            rms(&raw),
            peak(&raw),
            mixed.len() as f64 / 96_000.0,
            rms(&mixed),
            received.len() as f64 / 96_000.0,
            rms(&received),
            peak(&received),
        );
        write_wav(&dir.join("a-tap.wav"), &raw);
        write_wav(&dir.join("b-call-mix.wav"), &mixed);
        write_wav(&dir.join("c-call-webrtc.wav"), &received);
    }

    /// Waits up to `seconds` for `what` to give something.
    fn wait_for<T>(seconds: u64, mut what: impl FnMut() -> Option<T>) -> T {
        let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
        loop {
            if let Some(found) = what() {
                return found;
            }
            assert!(std::time::Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The peer id of a webrtcsink or webrtcsrc in the signalling.
    fn peer_of(element: &gst::Element) -> Option<String> {
        element
            .property::<gst::glib::Object>("signaller")
            .property::<Option<String>>("client-id")
    }

    /// Received audio as `caps` describe, from webrtcsrc's decoded pad.
    fn received_by(
        pipeline: &gst::Pipeline,
        source: &gst::Element,
        caps: &str,
    ) -> Arc<Mutex<Vec<u8>>> {
        let tail = gst::parse::bin_from_description(
            &format!("audioconvert ! audioresample ! {caps} ! appsink name=got sync=false"),
            true,
        )
        .unwrap();
        pipeline.add_many([source, tail.upcast_ref()]).unwrap();
        let got: Arc<Mutex<Vec<u8>>> = Arc::default();
        {
            let got = got.clone();
            tail.by_name("got")
                .unwrap()
                .downcast::<gst_app::AppSink>()
                .unwrap()
                .set_callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample(move |sink| {
                            let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                            let map = sample.buffer().unwrap().map_readable().unwrap();
                            got.lock().unwrap().extend_from_slice(&map);
                            Ok(gst::FlowSuccess::Ok)
                        })
                        .build(),
                );
        }
        let into = tail.static_pad("sink").unwrap();
        source.connect_pad_added(move |_, pad| {
            let _ = pad.link(&into);
        });
        got
    }

    /// The call's replies as the page gets them: webrtcsrc consuming the
    /// call's producer, F32 48 kHz stereo.
    fn consume_replies(call: &Call) -> (gst::Pipeline, Arc<Mutex<Vec<u8>>>) {
        let replies = call.pipeline.by_name("replies").unwrap();
        let producer = wait_for(10, || peer_of(&replies));
        let pipeline = gst::Pipeline::new();
        let source = gst::ElementFactory::make("webrtcsrc").build().unwrap();
        let signaller = source.property::<gst::glib::Object>("signaller");
        signaller.set_property("uri", format!("ws://127.0.0.1:{}", call.signalling_port));
        signaller.set_property("producer-peer-id", &producer);
        source.set_property("stun-server", None::<String>);
        signaller.connect("webrtcbin-ready", false, |values| {
            configure_ice(&values[2].get::<gst::Element>().unwrap(), "test consumer");
            None
        });
        let bytes = received_by(
            &pipeline,
            &source,
            "audio/x-raw,format=F32LE,layout=interleaved,rate=48000,channels=2",
        );
        pipeline.set_state(gst::State::Playing).unwrap();
        (pipeline, bytes)
    }

    fn f32s(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    }

    fn s16s(bytes: &[u8]) -> Vec<f64> {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0)
            .collect()
    }

    /// A page's microphone: a producer of a `freq` Hz tone on the call's
    /// signalling server, with the meta the page's has.
    fn page_microphone(call: &Call, freq: u32) -> (gst::Pipeline, String) {
        let pipeline = gst::parse::launch(&format!(
            "audiotestsrc is-live=true wave=sine freq={freq} volume=0.5 ! \
             audio/x-raw,rate=48000,channels=1 ! webrtcsink name=page"
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        let page = pipeline.by_name("page").unwrap();
        page.property::<gst::glib::Object>("signaller")
            .set_property("uri", format!("ws://127.0.0.1:{}", call.signalling_port));
        page.set_property("stun-server", None::<String>);
        page.set_property_from_str("congestion-control", "disabled");
        page.set_property("meta", meta(call.id, "microphone"));
        page.connect("consumer-added", false, |values| {
            configure_ice(&values[2].get::<gst::Element>().unwrap(), "test page");
            None
        });
        pipeline.set_state(gst::State::Playing).unwrap();
        let peer = wait_for(10, || peer_of(&page));
        (pipeline, peer)
    }

    #[test]
    fn the_replies_reach_a_webrtc_consumer() {
        let (call, _mixed, _errors) = start("");
        let (consumer, received) = consume_replies(&call);
        // The floor's silence streams once the session is up.
        wait_for(15, || {
            (received.lock().unwrap().len() >= 9600 * 4).then_some(())
        });
        let before = received.lock().unwrap().len();
        let mut sentence = call.sentence();
        sentence.push(&voice(1.0, 300.0, 1.0));
        sentence.finish();
        std::thread::sleep(Duration::from_millis(1800));
        let heard = f32s(&received.lock().unwrap()[before..]);
        consumer.set_state(gst::State::Null).unwrap();
        let loudest = heard
            .chunks(9600)
            .max_by(|a, b| {
                let energy = |s: &[f32]| s.iter().map(|x| x * x).sum::<f32>();
                energy(a).total_cmp(&energy(b))
            })
            .unwrap()
            .to_vec();
        let found = peak(&loudest);
        assert!((found - 300.0).abs() <= 10.0, "reply peak at {found} Hz");
    }

    #[test]
    fn the_microphone_is_the_pages_producer_never_the_first() {
        let (call, _mixed, errors) = start("");
        // Another producer came first: never taken for the microphone.
        let (decoy, _) = page_microphone(&call, 880);
        let (page, peer) = page_microphone(&call, 440);
        let heard: Arc<Mutex<Vec<u8>>> = Arc::default();
        {
            let heard = heard.clone();
            call.set_microphone(
                &peer,
                Arc::new(move |samples| heard.lock().unwrap().extend(samples)),
                false,
            )
            .unwrap();
        }
        assert_eq!(call.microphone_peer().as_deref(), Some(peer.as_str()));
        // A second of the page's 16 kHz mono microphone.
        wait_for(15, || {
            (heard.lock().unwrap().len() >= 32_000 * 2).then_some(())
        });
        let found = peak_of(&s16s(&heard.lock().unwrap()[16_000..48_000]), 16_000.0);
        assert!((found - 440.0).abs() <= 10.0, "microphone at {found} Hz");
        drop(call);
        page.set_state(gst::State::Null).unwrap();
        decoy.set_state(gst::State::Null).unwrap();
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
    }

    #[test]
    fn a_new_microphone_peer_replaces_the_one_before() {
        let (call, _mixed, errors) = start("");
        let (first, first_peer) = page_microphone(&call, 440);
        let (second, second_peer) = page_microphone(&call, 660);
        let heard: Arc<Mutex<Vec<u8>>> = Arc::default();
        let on_samples: OnSamples = {
            let heard = heard.clone();
            Arc::new(move |samples| heard.lock().unwrap().extend(samples))
        };
        call.set_microphone(&first_peer, on_samples.clone(), false)
            .unwrap();
        wait_for(15, || (!heard.lock().unwrap().is_empty()).then_some(()));
        call.set_microphone(&second_peer, on_samples.clone(), false)
            .unwrap();
        assert_eq!(
            call.microphone_peer().as_deref(),
            Some(second_peer.as_str())
        );
        heard.lock().unwrap().clear();
        wait_for(15, || {
            (heard.lock().unwrap().len() >= 32_000 * 2).then_some(())
        });
        let found = peak_of(&s16s(&heard.lock().unwrap()[16_000..48_000]), 16_000.0);
        assert!((found - 660.0).abs() <= 10.0, "microphone at {found} Hz");
        // The one replaced ended quietly: no failure told.
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
        // The same peer again (the page published it anew): heard again.
        call.set_microphone(&second_peer, on_samples, false)
            .unwrap();
        heard.lock().unwrap().clear();
        wait_for(15, || {
            (heard.lock().unwrap().len() >= 32_000 * 2).then_some(())
        });
        let found = peak_of(&s16s(&heard.lock().unwrap()[16_000..48_000]), 16_000.0);
        assert!((found - 660.0).abs() <= 10.0, "microphone at {found} Hz");
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
        drop(call);
        first.set_state(gst::State::Null).unwrap();
        second.set_state(gst::State::Null).unwrap();
    }

    #[test]
    fn the_microphone_goes_through_the_echo_canceller_when_asked() {
        let (call, _mixed, errors) = start("");
        let (page, peer) = page_microphone(&call, 440);
        let heard: Arc<Mutex<Vec<u8>>> = Arc::default();
        let on_samples: OnSamples = {
            let heard = heard.clone();
            Arc::new(move |samples| heard.lock().unwrap().extend(samples))
        };
        call.set_microphone(&peer, on_samples.clone(), true)
            .unwrap();
        assert!(call.cancels_echo());
        wait_for(15, || {
            (heard.lock().unwrap().len() >= 32_000 * 2).then_some(())
        });
        let found = peak_of(&s16s(&heard.lock().unwrap()[16_000..48_000]), 16_000.0);
        assert!((found - 440.0).abs() <= 10.0, "microphone at {found} Hz");
        // The mix goes to the canceller as it goes out.
        let far = call.echo.lock().unwrap().as_ref().unwrap().far_frames();
        assert!(far > 0, "no far end");
        // The page cancels it again: the microphone goes as it comes.
        call.set_microphone(&peer, on_samples, false).unwrap();
        assert!(!call.cancels_echo());
        heard.lock().unwrap().clear();
        wait_for(15, || {
            (heard.lock().unwrap().len() >= 32_000 * 2).then_some(())
        });
        drop(call);
        page.set_state(gst::State::Null).unwrap();
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
    }

    #[test]
    fn stopping_a_call_with_a_microphone_reports_no_error() {
        let (call, _mixed, errors) = start("");
        let (page, peer) = page_microphone(&call, 440);
        let heard: Arc<Mutex<Vec<u8>>> = Arc::default();
        {
            let heard = heard.clone();
            call.set_microphone(
                &peer,
                Arc::new(move |samples| heard.lock().unwrap().extend(samples)),
                false,
            )
            .unwrap();
        }
        wait_for(15, || (heard.lock().unwrap().len() >= 32_000).then_some(()));
        drop(call);
        // Its teardown ends the page's session: nothing of it is a failure.
        assert!(finish_stopping(Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(500));
        page.set_state(gst::State::Null).unwrap();
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
    }
}
