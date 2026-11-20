//! A YouTube video's sound as a call's music (`call_youtube`): Roamgate
//! finds the video and its audio stream with yt-dlp, and the helper plays
//! that stream into the call's mix, beside the background:
//!
//! ```text
//! video:  reqwesthttpsrc (yt-dlp's URL and headers) ! matroskademux !
//!         opusdec ! queue (5 s) ! audioconvert ! audioresample ! volume !
//!         F32 48k stereo ! appsink sync=true      (its own pipeline, on the
//!                                                  call's clock)
//! call:   appsrc (timestamped here, as the voice) ! (ducked in a probe) ! mix
//! ```
//!
//! The video plays in a pipeline of its own, paced by its appsink on the
//! call's clock, so pausing, seeking, its position and its end are its
//! own, and the live mix never waits for the network: each block it gives
//! is put into the call's appsrc a little ahead of now, back to back, as
//! the voice's are. Only WebM with Opus is read (yt-dlp is asked for it):
//! the helper has no AAC decoder.
//!
//! In the mix it is the call's music: at the music's level (call_music's
//! volume, off, waiting for a voice) and ducked as the background is, with
//! an envelope of its own, so it fades in.
//!
//! Spotify and YouTube never play together, and only what really plays
//! here counts: the background, which records the sink the desktop's
//! Spotify app plays into, carrying sound. Starting or resuming a video
//! pauses the MPRIS players named `pause_mpris` (the Spotify app) only
//! then: the app also says Playing while the account plays on another
//! device, and pausing it then would pause that device. Once the
//! background was heard silent while the video plays, its sound coming
//! back (the app started playing here) stops the video, told as
//! `{"event": "call_youtube", "state": "stopped", "why": "spotify"}`.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use gst::prelude::*;
use serde_json::{Value, json};

use super::{
    CHANNELS, MIN_AHEAD, MUSIC_AUDIBLE, MUSIC_HEARD_FOR, Mix, RATE, VOICE_LEAD, bytemuck_f32,
    loudness, raw_caps, stop_away,
};

/// What a `call_youtube` request asks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct YoutubeRequest {
    /// play, pause, resume, stop, volume, seek or status.
    pub action: String,
    /// play: the audio stream's URL, and the HTTP headers it is read with
    /// (User-Agent, Cookie, others as they are).
    pub url: String,
    pub headers: BTreeMap<String, String>,
    /// play and volume: the video's own volume, 0 to 1.
    pub volume: Option<f64>,
    /// seek: where to, in seconds.
    pub position: Option<f64>,
    /// play and resume: the MPRIS bus name (or prefix of names) of the
    /// players to pause when they play here.
    pub pause_mpris: Option<String>,
}

/// Pauses the MPRIS players playing whose bus names are the one given or
/// start with it and a dot; answers the names paused (mpris.rs).
pub type Pause = Arc<dyn Fn(&str) -> Vec<String> + Send + Sync>;
/// Where a video's events go: the helper's output.
pub type OnEvent = Arc<dyn Fn(Value) + Send + Sync>;

/// How long a video may take to give its first sound.
const START: Duration = Duration::from_secs(30);
/// How long the background has played before its silence means something.
const SETTLE: Duration = Duration::from_millis(600);
/// How long a start waits for the background to settle.
const SETTLE_MAX: Duration = Duration::from_millis(1500);
/// How long a player paused (or a video started) may still sound in the
/// background before its sound counts as starting again.
const SPOTIFY_GRACE: Duration = Duration::from_secs(2);
/// How often the video's bus and the background are looked at.
const WATCH: Duration = Duration::from_millis(100);

const PIPELINE: &str = "reqwesthttpsrc name=src ! matroskademux ! opusdec ! \
     queue max-size-buffers=0 max-size-bytes=0 max-size-time=5000000000 ! \
     audioconvert ! audioresample quality=10 ! volume name=volume ! \
     capsfilter name=caps ! appsink name=out sync=true";

/// How far a video went, as the play request waits for it.
#[derive(Default)]
struct Progress {
    /// Its first sound went to the mix.
    started: bool,
    /// It failed before that, and why.
    failed: Option<String>,
}

type Shared = Arc<(Mutex<Progress>, Condvar)>;

struct Player {
    session: u64,
    pipeline: gst::Pipeline,
    volume: gst::Element,
    /// Its appsrc in the call's pipeline, and the mixer pad it feeds.
    src: gst_app::AppSrc,
    pad: Option<gst::Pad>,
    progress: Shared,
    paused: bool,
    /// Until when the background's sound is a player still stopping.
    grace_until: Instant,
    /// The background was heard silent since: its sound starts again.
    silent_seen: bool,
    /// The playing event was told.
    told: bool,
}

/// What the background tells of the music sink now.
#[derive(Debug, PartialEq)]
enum Background {
    /// Not in the pipeline (no background, or the music off).
    Off,
    /// Made only now: not measured long enough yet.
    Settling,
    Heard(bool),
}

/// A call's YouTube video, if any.
pub struct Tube {
    call: u32,
    /// The call's pipeline, mixer and mix.
    pipeline: gst::Pipeline,
    mixer: gst::Element,
    mix: Arc<Mutex<Mix>>,
    player: Mutex<Option<Player>>,
    session: AtomicU64,
    /// The video's own volume, 0 to 1, kept for the next one.
    level: Mutex<f64>,
    /// Frames of video that went to the mixer, for tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub frames: Arc<AtomicU64>,
}

impl Tube {
    pub fn new(
        call: u32,
        pipeline: gst::Pipeline,
        mixer: gst::Element,
        mix: Arc<Mutex<Mix>>,
    ) -> Self {
        Self {
            call,
            pipeline,
            mixer,
            mix,
            player: Mutex::new(None),
            session: AtomicU64::new(0),
            level: Mutex::new(1.0),
            frames: Arc::default(),
        }
    }

    /// Carries out `request`: answers the video's state, or why it cannot.
    pub fn request(
        self: &Arc<Self>,
        request: &YoutubeRequest,
        pause: &Pause,
        on_event: &OnEvent,
    ) -> Result<Value, String> {
        if let Some(volume) = request.volume.filter(|v| v.is_finite()) {
            let volume = volume.clamp(0.0, 1.0);
            *self.level.lock().unwrap() = volume;
            if let Some(player) = self.player.lock().unwrap().as_ref() {
                player.volume.set_property("volume", volume);
            }
        }
        match request.action.as_str() {
            "play" => self.play(request, pause, on_event),
            "pause" => {
                self.with_player(|player| {
                    player
                        .pipeline
                        .set_state(gst::State::Paused)
                        .map_err(|e| e.to_string())?;
                    player.paused = true;
                    Ok(())
                })?;
                Ok(self.status(None))
            }
            "resume" => {
                self.with_player(|_| Ok(()))?;
                let paused = self.pause_spotify(request.pause_mpris.as_deref(), pause);
                self.with_player(|player| {
                    player
                        .pipeline
                        .set_state(gst::State::Playing)
                        .map_err(|e| e.to_string())?;
                    player.paused = false;
                    player.grace_until = Instant::now() + SPOTIFY_GRACE;
                    Ok(())
                })?;
                Ok(self.status(Some(paused)))
            }
            "stop" => {
                self.stop();
                Ok(self.status(None))
            }
            "volume" | "status" => Ok(self.status(None)),
            "seek" => {
                let at = request.position.filter(|p| p.is_finite()).unwrap_or(0.0);
                self.seek(at)?;
                Ok(self.status(None))
            }
            other => Err(format!("unknown call_youtube action {other:?}")),
        }
    }

    /// Ends the video, if any, telling nothing.
    pub fn stop(&self) {
        self.session.fetch_add(1, Ordering::SeqCst);
        let player = self.player.lock().unwrap().take();
        if let Some(player) = player {
            self.end(player);
        }
    }

    fn with_player(
        &self,
        act: impl FnOnce(&mut Player) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut player = self.player.lock().unwrap();
        match player.as_mut() {
            Some(player) => act(player),
            None => Err("nothing is playing on YouTube".into()),
        }
    }

    fn play(
        self: &Arc<Self>,
        request: &YoutubeRequest,
        pause: &Pause,
        on_event: &OnEvent,
    ) -> Result<Value, String> {
        let url = request.url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("no stream URL to play".into());
        }
        self.stop();
        let session = self.session.fetch_add(1, Ordering::SeqCst) + 1;
        let pipeline = gst::parse::launch(PIPELINE)
            .map_err(|e| format!("the video's pipeline: {e}"))?
            .downcast::<gst::Pipeline>()
            .map_err(|_| "the video's pipeline is no pipeline".to_string())?;
        pipeline.set_property("name", format!("roamgate-call-{}-youtube", self.call));
        let source = pipeline.by_name("src").unwrap();
        source.set_property("location", url);
        let mut extra = gst::Structure::builder("extra-headers");
        for (name, value) in &request.headers {
            if name.eq_ignore_ascii_case("user-agent") {
                source.set_property("user-agent", value);
            } else if name.eq_ignore_ascii_case("cookie") {
                let cookies: Vec<String> = value
                    .split(';')
                    .map(|cookie| cookie.trim().to_string())
                    .filter(|cookie| !cookie.is_empty())
                    .collect();
                source.set_property("cookies", cookies);
            } else {
                extra = extra.field(name.as_str(), value.as_str());
            }
        }
        source.set_property("extra-headers", extra.build());
        pipeline
            .by_name("caps")
            .unwrap()
            .set_property("caps", raw_caps());
        let volume = pipeline.by_name("volume").unwrap();
        volume.set_property("volume", *self.level.lock().unwrap());
        if let Some(clock) = self.pipeline.clock() {
            pipeline.use_clock(Some(&clock));
        }

        // Its way into the mix.
        let src = gst_app::AppSrc::builder()
            .name(format!("youtube-{session}"))
            .caps(&raw_caps())
            .format(gst::Format::Time)
            .is_live(true)
            .max_bytes(4 * 1024 * 1024)
            .block(false)
            .build();
        src.set_property("min-latency", 0i64);
        self.duck(&src);
        self.pipeline.add(&src).map_err(|e| e.to_string())?;
        let pad = self.mixer.request_pad_simple("sink_%u");
        let linked = pad
            .as_ref()
            .ok_or("no mixer pad".to_string())
            .and_then(|pad| {
                src.static_pad("src")
                    .unwrap()
                    .link(pad)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            });
        let progress: Shared = Arc::default();
        let player = Player {
            session,
            pipeline: pipeline.clone(),
            volume,
            src: src.clone(),
            pad,
            progress: progress.clone(),
            paused: false,
            grace_until: Instant::now() + SPOTIFY_GRACE,
            silent_seen: false,
            told: false,
        };
        if let Err(err) =
            linked.and_then(|()| src.sync_state_with_parent().map_err(|e| e.to_string()))
        {
            self.end(player);
            return Err(format!("the video could not join the call: {err}"));
        }
        self.feed(&pipeline, &src, &progress);
        {
            // It fades in, ducked as the background is now.
            let mut mix = self.mix.lock().unwrap();
            let level = mix.level();
            let duck = mix.duck.clone();
            mix.youtube_duck = super::Duck {
                level: 0.0,
                target: level,
                ..duck
            };
        }
        *self.player.lock().unwrap() = Some(player);
        if pipeline.set_state(gst::State::Playing).is_err() {
            let detail = pipeline
                .bus()
                .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]))
                .and_then(|message| match message.view() {
                    gst::MessageView::Error(err) => Some(reason(&err, url)),
                    _ => None,
                })
                .unwrap_or_else(|| "it did not start".into());
            self.stop();
            return Err(detail);
        }
        {
            let tube = self.clone();
            let on_event = on_event.clone();
            let url = url.to_string();
            let bus = pipeline.bus().unwrap();
            std::thread::Builder::new()
                .name("youtube".into())
                .spawn(move || tube.watch(session, url, bus, on_event))
                .map_err(|e| e.to_string())?;
        }
        let paused = self.pause_spotify(request.pause_mpris.as_deref(), pause);
        // Answered once its sound comes, or why it did not.
        let (lock, ready) = &*progress;
        let deadline = Instant::now() + START;
        let mut state = lock.lock().unwrap();
        while !state.started && state.failed.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = ready.wait_timeout(state, left).unwrap().0;
        }
        let failed = state.failed.clone();
        let started = state.started;
        drop(state);
        if let Some(failed) = failed {
            return Err(failed);
        }
        if !started {
            if self.session.load(Ordering::SeqCst) == session {
                self.stop();
            }
            return Err(format!("no sound came within {} s", START.as_secs()));
        }
        Ok(self.status(Some(paused)))
    }

    /// The video's blocks into the call's appsrc: back to back from a
    /// little ahead of now, as the voice's (call.rs).
    fn feed(&self, pipeline: &gst::Pipeline, src: &gst_app::AppSrc, progress: &Shared) {
        let sink = pipeline
            .by_name("out")
            .unwrap()
            .downcast::<gst_app::AppSink>()
            .unwrap();
        let call = self.pipeline.downgrade();
        let src = src.clone();
        let progress = progress.clone();
        let next = Mutex::new(None::<gst::ClockTime>);
        sink.set_callbacks(
            gst_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let Some(mut buffer) = sample.buffer_owned() else {
                        return Ok(gst::FlowSuccess::Ok);
                    };
                    let Some(call) = call.upgrade() else {
                        return Err(gst::FlowError::Flushing);
                    };
                    let now = match (call.clock(), call.base_time()) {
                        (Some(clock), Some(base)) => clock.time().saturating_sub(base),
                        _ => gst::ClockTime::ZERO,
                    };
                    let frames = buffer.size() as u64 / (4 * CHANNELS as u64);
                    let duration = gst::ClockTime::from_nseconds(
                        frames * gst::ClockTime::SECOND.nseconds() / RATE as u64,
                    );
                    let at = {
                        let mut next = next.lock().unwrap();
                        let at = match *next {
                            Some(at) if at >= now + MIN_AHEAD => at,
                            _ => now + VOICE_LEAD,
                        };
                        *next = Some(at + duration);
                        at
                    };
                    {
                        let buffer = buffer.make_mut();
                        buffer.set_pts(at);
                        buffer.set_dts(gst::ClockTime::NONE);
                        buffer.set_duration(duration);
                    }
                    let pushed = src.push_buffer(buffer);
                    let (lock, ready) = &*progress;
                    let mut state = lock.lock().unwrap();
                    if !state.started {
                        state.started = true;
                        ready.notify_all();
                    }
                    pushed.map_err(|_| gst::FlowError::Flushing)
                })
                .build(),
        );
    }

    /// Ducks the video as the background, at the music's level, and counts
    /// it as music heard at the page.
    fn duck(&self, src: &gst_app::AppSrc) {
        let mix = self.mix.clone();
        let frames = self.frames.clone();
        src.static_pad("src")
            .unwrap()
            .add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                let Some(buffer) = info.buffer_mut() else {
                    return gst::PadProbeReturn::Ok;
                };
                let at = buffer.pts().unwrap_or(gst::ClockTime::ZERO);
                let buffer = buffer.make_mut();
                let mut mix = mix.lock().unwrap();
                let active = mix.active(at);
                let level = mix.level();
                mix.youtube_duck.target = level;
                if let Ok(mut map) = buffer.map_writable() {
                    let samples: &mut [f32] = bytemuck_f32(map.as_mut_slice());
                    frames.fetch_add(
                        (samples.len() / CHANNELS as usize) as u64,
                        Ordering::Relaxed,
                    );
                    mix.youtube_duck
                        .apply(samples, CHANNELS as usize, at.nseconds(), active);
                    if loudness(samples) > MUSIC_AUDIBLE {
                        mix.music_heard = Some(Instant::now());
                    }
                }
                gst::PadProbeReturn::Ok
            });
    }

    fn background(&self) -> Background {
        let mix = self.mix.lock().unwrap();
        match mix.background_since {
            None => Background::Off,
            Some(since) if since.elapsed() < SETTLE => Background::Settling,
            Some(_) => Background::Heard(
                mix.background_heard
                    .is_some_and(|heard| heard.elapsed() < MUSIC_HEARD_FOR),
            ),
        }
    }

    /// Pauses the players named `prefix` when the background carries sound
    /// (they play here); whether one was paused.
    fn pause_spotify(&self, prefix: Option<&str>, pause: &Pause) -> bool {
        let Some(prefix) = prefix.map(str::trim).filter(|p| !p.is_empty()) else {
            return false;
        };
        let deadline = Instant::now() + SETTLE_MAX;
        let heard = loop {
            match self.background() {
                Background::Heard(heard) => break heard,
                Background::Settling if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => break false,
            }
        };
        if !heard {
            return false;
        }
        let paused = pause(prefix);
        if paused.is_empty() {
            return false;
        }
        eprintln!(
            "call {}: YouTube plays: paused {}",
            self.call,
            paused.join(", ")
        );
        if let Some(player) = self.player.lock().unwrap().as_mut() {
            player.grace_until = Instant::now() + SPOTIFY_GRACE;
        }
        true
    }

    fn seek(&self, at: f64) -> Result<(), String> {
        let pipeline = {
            let player = self.player.lock().unwrap();
            let Some(player) = player.as_ref() else {
                return Err("nothing is playing on YouTube".into());
            };
            player.pipeline.clone()
        };
        let mut at = at.max(0.0);
        if let Some(duration) = pipeline.query_duration::<gst::ClockTime>() {
            at = at.min((duration.seconds_f64() - 1.0).max(0.0));
        }
        pipeline
            .seek_simple(
                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                gst::ClockTime::from_nseconds((at * 1e9) as u64),
            )
            .map_err(|_| "this video cannot seek".to_string())?;
        let _ = pipeline.state(gst::ClockTime::from_seconds(5));
        Ok(())
    }

    /// The video's state, as answered: `spotify_paused` for a start or a
    /// resume.
    fn status(&self, spotify_paused: Option<bool>) -> Value {
        let volume = *self.level.lock().unwrap();
        let muted = self.mix.lock().unwrap().muted;
        let player = self.player.lock().unwrap();
        let mut status = match player.as_ref() {
            None => json!({"state": "stopped"}),
            Some(player) => {
                let seconds = |time: Option<gst::ClockTime>| {
                    time.map(|time| (time.seconds_f64() * 10.0).round() / 10.0)
                };
                json!({
                    "state": if player.paused { "paused" } else { "playing" },
                    "position": seconds(player.pipeline.query_position::<gst::ClockTime>()),
                    "duration": seconds(player.pipeline.query_duration::<gst::ClockTime>()),
                })
            }
        };
        status["volume"] = json!(volume);
        status["music_muted"] = json!(muted);
        if let Some(paused) = spotify_paused {
            status["spotify_paused"] = json!(paused);
        }
        status
    }

    /// Follows video `session` until it ends: its bus (its end, its
    /// failure), and the background (Spotify starting here).
    fn watch(self: Arc<Self>, session: u64, url: String, bus: gst::Bus, on_event: OnEvent) {
        let tell = |state: &str, extra: Value| {
            let mut event = json!({"event": "call_youtube", "call": self.call, "state": state});
            if let (Some(event), Value::Object(extra)) = (event.as_object_mut(), extra) {
                event.extend(extra);
            }
            on_event(event);
        };
        loop {
            if self.session.load(Ordering::SeqCst) != session {
                return;
            }
            let ended = match bus.timed_pop(gst::ClockTime::from_nseconds(WATCH.as_nanos() as u64))
            {
                Some(message) => match message.view() {
                    gst::MessageView::Eos(_) => Some(("ended", "the video ended".to_string())),
                    gst::MessageView::Error(err) => Some(("error", reason(&err, &url))),
                    _ => None,
                },
                None => None,
            };
            if let Some((why, reason)) = ended {
                let Some(player) = self.take(session) else {
                    return;
                };
                let started = {
                    let (lock, ready) = &*player.progress;
                    let mut state = lock.lock().unwrap();
                    if !state.started {
                        state.failed = Some(reason.clone());
                        ready.notify_all();
                    }
                    state.started
                };
                self.end(player);
                let reason = if why == "error" {
                    format!("it failed: {reason}")
                } else {
                    reason
                };
                if started {
                    eprintln!("call {}: YouTube stopped: {reason}", self.call);
                    tell("stopped", json!({"why": why, "reason": reason}));
                }
                return;
            }
            let background = self.background();
            let (stop, playing) = {
                let mut slot = self.player.lock().unwrap();
                let Some(player) = slot.as_mut().filter(|p| p.session == session) else {
                    return;
                };
                let started = player.progress.0.lock().unwrap().started;
                let playing = (started && !player.told).then(|| {
                    player.told = true;
                    (
                        player.pipeline.query_position::<gst::ClockTime>(),
                        player.pipeline.query_duration::<gst::ClockTime>(),
                    )
                });
                let mut stop = false;
                if started && !player.paused && Instant::now() >= player.grace_until {
                    match background {
                        Background::Heard(false) => player.silent_seen = true,
                        Background::Heard(true) => stop = player.silent_seen,
                        _ => {}
                    }
                }
                (stop, playing)
            };
            if let Some((position, duration)) = playing {
                tell(
                    "playing",
                    json!({
                        "position": position.map(|p| p.seconds_f64()),
                        "duration": duration.map(|d| d.seconds_f64()),
                    }),
                );
            }
            if stop && let Some(player) = self.take(session) {
                self.end(player);
                eprintln!(
                    "call {}: Spotify started playing here: YouTube stopped",
                    self.call
                );
                tell(
                    "stopped",
                    json!({"why": "spotify", "reason": "Spotify started playing"}),
                );
                return;
            }
        }
    }

    /// Takes video `session` out, if it is still the one playing.
    fn take(&self, session: u64) -> Option<Player> {
        let mut slot = self.player.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.session == session) {
            slot.take()
        } else {
            None
        }
    }

    /// Stops `player`'s pipeline and takes its appsrc out of the mix.
    fn end(&self, player: Player) {
        stop_away(player.pipeline.clone());
        if let Some(pad) = &player.pad {
            if let Some(src) = player.src.static_pad("src") {
                let _ = src.unlink(pad);
            }
            self.mixer.release_request_pad(pad);
        }
        let _ = player.src.set_state(gst::State::Null);
        let _ = self.pipeline.remove(&player.src);
    }
}

/// Why a video failed: its element's own words (the last line of the
/// error's details, an HTTP status included), else the error's. A
/// stream's URL is long, and signed: not told.
fn reason(err: &gst::message::Error, url: &str) -> String {
    let said = err
        .debug()
        .and_then(|debug| debug.lines().last().map(str::trim).map(str::to_string))
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| err.error().to_string());
    said.replace(url, "the stream")
}

#[cfg(test)]
mod tests {
    use super::super::{Call, Settings};
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    fn init() {
        gst::init().unwrap();
        let _ = gstrswebrtc::plugin_register_static();
        let _ = gstreqwest::plugin_register_static();
    }

    /// `seconds` of a `freq` sine as WebM with Opus, as YouTube serves it.
    fn webm(seconds: u32, freq: u32) -> Vec<u8> {
        init();
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "roamgate-youtube-{}-{}.webm",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::SeqCst)
        ));
        let pipeline = gst::parse::launch(&format!(
            "audiotestsrc wave=sine freq={freq} volume=0.5 num-buffers={} samplesperbuffer=960 ! \
             audio/x-raw,rate=48000,channels=2 ! opusenc ! webmmux ! filesink name=out",
            seconds * 50
        ))
        .unwrap()
        .downcast::<gst::Pipeline>()
        .unwrap();
        pipeline
            .by_name("out")
            .unwrap()
            .set_property("location", path.to_str().unwrap());
        pipeline.set_state(gst::State::Playing).unwrap();
        let bus = pipeline.bus().unwrap();
        let message = bus
            .timed_pop_filtered(
                gst::ClockTime::from_seconds(30),
                &[gst::MessageType::Eos, gst::MessageType::Error],
            )
            .expect("the test video was not made");
        assert!(
            matches!(message.view(), gst::MessageView::Eos(_)),
            "{message:?}"
        );
        pipeline.set_state(gst::State::Null).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        bytes
    }

    /// An HTTP server for `/video.webm` (ranges included), answering 404
    /// for anything else; what each request's headers were.
    fn serve(body: Vec<u8>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let kept = seen.clone();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let body = body.clone();
                let seen = kept.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut head = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    seen.lock().unwrap().push(head.clone());
                    if !head.starts_with("GET /video.webm ") {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        return;
                    }
                    let from = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("range: bytes=")
                                .and_then(|range| range.split('-').next().map(str::to_string))
                        })
                        .and_then(|from| from.parse::<usize>().ok());
                    let start = from.unwrap_or(0).min(body.len());
                    let status = if from.is_some() {
                        format!(
                            "206 Partial Content\r\nContent-Range: bytes {start}-{}/{}",
                            body.len() - 1,
                            body.len()
                        )
                    } else {
                        "200 OK".to_string()
                    };
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Type: video/webm\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len() - start
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(&body[start..]);
                });
            }
        });
        (url, seen)
    }

    type Events = Arc<Mutex<Vec<Value>>>;

    fn start(background: &str) -> (Call, Events) {
        init();
        let call = Call::start(
            1,
            &Settings {
                background: background.into(),
                volume: 1.0,
                reply_loudness: None,
                ..Settings::default()
            },
            Arc::new(|_| {}),
        )
        .unwrap();
        (call, Events::default())
    }

    fn request(action: &str) -> YoutubeRequest {
        YoutubeRequest {
            action: action.into(),
            ..YoutubeRequest::default()
        }
    }

    fn no_pause() -> Pause {
        Arc::new(|_| panic!("nothing plays here: nothing to pause"))
    }

    fn ask(
        call: &Call,
        events: &Events,
        asked: YoutubeRequest,
        pause: &Pause,
    ) -> Result<Value, String> {
        let events = events.clone();
        let on_event: OnEvent = Arc::new(move |event| events.lock().unwrap().push(event));
        call.youtube(&asked, pause, &on_event)
    }

    fn wait_for(what: impl Fn() -> bool, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if what() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        what()
    }

    #[test]
    fn a_video_over_http_plays_into_the_mix_ducked_and_ends() {
        let (url, seen) = serve(webm(3, 440));
        let (call, events) = start("");
        let mut play = request("play");
        play.url = format!("{url}/video.webm");
        play.headers = BTreeMap::from([
            ("User-Agent".to_string(), "roamgate-test/1".to_string()),
            ("Cookie".to_string(), "a=1; b=2".to_string()),
            ("X-Youtube-Client".to_string(), "web".to_string()),
        ]);
        play.pause_mpris = Some("org.mpris.MediaPlayer2.roamgatetest".into());
        let answer = ask(&call, &events, play.clone(), &no_pause()).unwrap();
        assert_eq!(answer["state"], "playing", "{answer}");
        assert_eq!(answer["spotify_paused"], false);
        let head = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(head.contains("user-agent: roamgate-test/1"), "{head}");
        assert!(head.contains("cookie: a=1; b=2"), "{head}");
        assert!(head.contains("x-youtube-client: web"), "{head}");

        // Into the mix, fading in to the music's level.
        std::thread::sleep(Duration::from_millis(700));
        assert!(call.youtube.frames.load(Ordering::Relaxed) > 48_000 / 2);
        assert!(call.music_audible());
        assert!((call.mix.lock().unwrap().youtube_duck.gain - 1.0).abs() < 1e-6);
        // Ducked by a sentence within 300 ms.
        let mut sentence = call.sentence();
        sentence.push(&vec![0.1f32; 48_000 * 2]);
        std::thread::sleep(Duration::from_millis(300));
        let gain = call.mix.lock().unwrap().youtube_duck.gain;
        assert!((gain - 0.15).abs() < 0.01, "gain {gain}");
        drop(sentence);

        // Paused: nothing more goes in; resumed, it goes on.
        let paused = ask(&call, &events, request("pause"), &no_pause()).unwrap();
        assert_eq!(paused["state"], "paused");
        std::thread::sleep(Duration::from_millis(150));
        let frames = call.youtube.frames.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(call.youtube.frames.load(Ordering::Relaxed), frames);
        let resumed = ask(&call, &events, request("resume"), &no_pause()).unwrap();
        assert_eq!(resumed["state"], "playing");
        std::thread::sleep(Duration::from_millis(300));
        assert!(call.youtube.frames.load(Ordering::Relaxed) > frames);
        let status = ask(&call, &events, request("status"), &no_pause()).unwrap();
        assert!(status["position"].as_f64().unwrap() > 0.5, "{status}");
        assert!(
            (status["duration"].as_f64().unwrap() - 3.0).abs() < 0.2,
            "{status}"
        );

        // Its own volume.
        let mut volume = request("volume");
        volume.volume = Some(0.25);
        assert_eq!(
            ask(&call, &events, volume, &no_pause()).unwrap()["volume"],
            0.25
        );

        // Stopped: out of the mix.
        let stopped = ask(&call, &events, request("stop"), &no_pause()).unwrap();
        assert_eq!(stopped["state"], "stopped");
        std::thread::sleep(Duration::from_millis(100));
        let frames = call.youtube.frames.load(Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(call.youtube.frames.load(Ordering::Relaxed), frames);
        assert!(
            ask(&call, &events, request("pause"), &no_pause()).is_err(),
            "nothing to pause"
        );

        // Played to its end: told.
        ask(&call, &events, play, &no_pause()).unwrap();
        assert!(
            wait_for(
                || events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| e["state"] == "stopped" && e["why"] == "ended"),
                Duration::from_secs(6)
            ),
            "{:?}",
            events.lock().unwrap()
        );
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["state"] == "playing" && e["call"] == 1)
        );
        assert_eq!(
            ask(&call, &events, request("status"), &no_pause()).unwrap()["state"],
            "stopped"
        );
    }

    #[test]
    fn a_video_that_cannot_be_read_fails_with_its_reason() {
        let (url, _seen) = serve(Vec::new());
        let (call, events) = start("");
        let mut play = request("play");
        play.url = format!("{url}/gone.webm");
        let error = ask(&call, &events, play, &no_pause()).unwrap_err();
        assert_eq!(error, "Resource 'the stream' not found");
        assert!(!error.contains("gone.webm"), "the URL is not told: {error}");
        assert!(events.lock().unwrap().is_empty());
        let mut none = request("play");
        none.url = "file:///etc/passwd".into();
        assert!(ask(&call, &events, none, &no_pause()).is_err());
    }

    /// The background records the sink the Spotify app plays into: its
    /// sound means Spotify plays here.
    #[test]
    fn spotify_heard_here_is_paused_and_its_start_here_stops_the_video() {
        let (url, _seen) = serve(webm(20, 440));
        let (call, events) =
            start("audiotestsrc name=spotify is-live=true wave=sine freq=300 volume=0.5");
        std::thread::sleep(Duration::from_millis(800));
        let spotify = call.pipeline.by_name("spotify").unwrap();
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let pause: Pause = {
            let asked = asked.clone();
            let spotify = spotify.clone();
            Arc::new(move |prefix| {
                asked.lock().unwrap().push(prefix.to_string());
                spotify.set_property("volume", 0.0f64);
                vec![format!("{prefix}.instance1")]
            })
        };
        let mut play = request("play");
        play.url = format!("{url}/video.webm");
        play.pause_mpris = Some("org.mpris.MediaPlayer2.roamgatetest".into());
        let answer = ask(&call, &events, play, &pause).unwrap();
        assert_eq!(answer["spotify_paused"], true, "{answer}");
        assert_eq!(
            *asked.lock().unwrap(),
            ["org.mpris.MediaPlayer2.roamgatetest"]
        );
        // Past the grace, silent: it plays on.
        std::thread::sleep(SPOTIFY_GRACE + Duration::from_millis(800));
        assert_eq!(
            ask(&call, &events, request("status"), &no_pause()).unwrap()["state"],
            "playing"
        );
        // Spotify starts playing here: the video stops.
        spotify.set_property("volume", 0.5f64);
        assert!(
            wait_for(
                || events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| e["state"] == "stopped" && e["why"] == "spotify"),
                Duration::from_secs(2)
            ),
            "{:?}",
            events.lock().unwrap()
        );
        assert_eq!(
            ask(&call, &events, request("status"), &no_pause()).unwrap()["state"],
            "stopped"
        );
    }

    /// Spotify playing on another device: nothing in the background, so
    /// nothing is paused, and the video goes on.
    #[test]
    fn spotify_elsewhere_is_left_alone() {
        let (url, _seen) = serve(webm(10, 440));
        let (call, events) =
            start("audiotestsrc name=spotify is-live=true wave=sine freq=300 volume=0");
        let mut play = request("play");
        play.url = format!("{url}/video.webm");
        play.pause_mpris = Some("org.mpris.MediaPlayer2.roamgatetest".into());
        let answer = ask(&call, &events, play, &no_pause()).unwrap();
        assert_eq!(answer["spotify_paused"], false);
        std::thread::sleep(SPOTIFY_GRACE + Duration::from_millis(600));
        assert_eq!(
            ask(&call, &events, request("status"), &no_pause()).unwrap()["state"],
            "playing"
        );
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|e| e["state"] != "stopped")
        );
    }
}
