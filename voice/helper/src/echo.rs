//! Acoustic echo cancellation of a call's microphone, here: the page plays
//! the replies on a phone's loudspeaker as media, without its own echo
//! canceller (that would put Android in communication mode, on the
//! earpiece), and the helper takes them out of what the microphone hears.
//! It knows exactly what the page plays: the call's mix (the replies and
//! the music), the far end.
//!
//! ```text
//! far:  the mix (F32 48 kHz stereo) ! audioconvert ! audioresample !
//!       S16LE 16 kHz mono ! webrtcechoprobe ! fakesink
//! near: the microphone (S16LE 16 kHz mono) ! webrtcdsp ! appsink -> listener
//! ```
//!
//! webrtcdsp (WebRTC's AEC3, with its noise suppression and gain control)
//! reads the far end from webrtcechoprobe by timestamp: each block of the
//! microphone is matched with the far end timestamped alike. Both are
//! pushed here, synchronously, on pads of our own: the mix stamped with the
//! time it goes out plus `lead`, the microphone with the time it comes in.
//! What the page plays comes back over the network a round trip and the
//! phone's buffers later; AEC3 finds that delay itself (up to about half a
//! second past `lead`, see the tests), so `lead` stays below the shortest
//! round trip and the canceller never gets the far end too late.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;

/// The rate the microphone comes at, and the canceller runs at.
pub const RATE: i32 = 16_000;
/// The default `lead`: what the far end is put ahead by (see the module).
pub const DEFAULT_LEAD_MS: u64 = 60;
/// Far-end blocks louder than this (mean square, -50 dBFS) are a reply or
/// music playing, whose echo may come.
const FAR_AUDIBLE: f64 = 1e-5;
/// The echo of what played may come this long after it went out.
const ECHO_TAIL: std::time::Duration = std::time::Duration::from_millis(1200);
/// A stretch of far end shorter than this is not reported.
const REPORT_MIN_SECONDS: f64 = 1.0;

/// The canceller's settings.
#[derive(Clone, Debug)]
pub struct Settings {
    /// What the far end is put ahead by.
    pub lead: gst::ClockTime,
    pub noise_suppression: bool,
    pub gain_control: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lead: gst::ClockTime::from_mseconds(DEFAULT_LEAD_MS),
            noise_suppression: true,
            gain_control: true,
        }
    }
}

/// The microphone with the echo taken out: 16 kHz mono S16LE.
pub type OnClean = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
/// What the canceller did over a stretch of far end (a reply), to trace.
pub type OnReport = Arc<dyn Fn(Report) + Send + Sync>;

/// The microphone's levels while the far end played, and its echo could
/// come back: before the canceller, and after.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Report {
    pub seconds: f64,
    /// Mean square, in dBFS.
    pub before_db: f64,
    pub after_db: f64,
}

impl Report {
    /// What the canceller took out, in dB.
    pub fn removed_db(&self) -> f64 {
        self.before_db - self.after_db
    }
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "over {:.1} s of the replies playing, the microphone at {:.1} dBFS, {:.1} dBFS once cancelled ({:.1} dB taken out)",
            self.seconds,
            self.before_db,
            self.after_db,
            self.removed_db()
        )
    }
}

fn db(mean_square: f64) -> f64 {
    10.0 * mean_square.max(1e-12).log10()
}

/// The microphone's energy while the far end may echo in it.
#[derive(Default)]
struct Stats {
    /// Until when the far end's echo may come.
    echo_until: Option<std::time::Instant>,
    samples: u64,
    before: f64,
    after: f64,
}

static COUNT: AtomicU32 = AtomicU32::new(0);

pub struct EchoCanceller {
    pipeline: gst::Pipeline,
    far: gst::Pad,
    near: gst::Pad,
    lead: gst::ClockTime,
    /// The time pushes are stamped with: our own clock, from `base`.
    clock: gst::Clock,
    base: gst::ClockTime,
    /// The far end's and the microphone's next timestamps: never before
    /// the last ones.
    far_next: Mutex<gst::ClockTime>,
    near_next: Mutex<gst::ClockTime>,
    stats: Arc<Mutex<Stats>>,
    on_report: OnReport,
    /// Buffers of far end pushed, for tests.
    far_buffers: AtomicU64,
}

fn s16_caps(rate: i32) -> gst::Caps {
    gst::Caps::builder("audio/x-raw")
        .field("format", "S16LE")
        .field("layout", "interleaved")
        .field("rate", rate)
        .field("channels", 1i32)
        .build()
}

fn make(factory: &str) -> Result<gst::Element, String> {
    gst::ElementFactory::make(factory)
        .build()
        .map_err(|_| format!("no {factory} element"))
}

/// A pad of our own pushing `caps` into `into`, synchronously.
fn feeding(name: &str, caps: &gst::Caps, into: &gst::Pad) -> Result<gst::Pad, String> {
    let pad = gst::Pad::builder(gst::PadDirection::Src).name(name).build();
    pad.set_active(true).map_err(|e| e.to_string())?;
    pad.link(into).map_err(|e| format!("{name}: {e:?}"))?;
    pad.push_event(gst::event::StreamStart::new(name));
    pad.push_event(gst::event::Caps::new(caps));
    pad.push_event(gst::event::Segment::new(&gst::FormattedSegment::<
        gst::ClockTime,
    >::new()));
    Ok(pad)
}

impl EchoCanceller {
    /// The far end comes as `far_caps` (the call's mix); the microphone
    /// goes to `on_clean`, the echo taken out.
    pub fn start(
        settings: &Settings,
        far_caps: &gst::Caps,
        on_clean: OnClean,
        on_report: OnReport,
    ) -> Result<Self, String> {
        let n = COUNT.fetch_add(1, Ordering::Relaxed);
        let pipeline = gst::Pipeline::with_name(&format!("roamgate-echo-{n}"));
        let convert = make("audioconvert")?;
        let resample = make("audioresample")?;
        let caps = gst::ElementFactory::make("capsfilter")
            .property("caps", s16_caps(RATE))
            .build()
            .map_err(|e| e.to_string())?;
        let probe_name = format!("roamgate-echo-probe-{n}");
        let probe = gst::ElementFactory::make("webrtcechoprobe")
            .name(&probe_name)
            .build()
            .map_err(|_| "no webrtcechoprobe element (GStreamer's webrtcdsp plugin)".to_string())?;
        let drain = gst::ElementFactory::make("fakesink")
            .property("sync", false)
            .property("async", false)
            .build()
            .map_err(|_| "no fakesink element".to_string())?;
        let dsp = gst::ElementFactory::make("webrtcdsp")
            .property("probe", &probe_name)
            .property("echo-cancel", true)
            .property("high-pass-filter", true)
            .property("noise-suppression", settings.noise_suppression)
            .property("gain-control", settings.gain_control)
            .build()
            .map_err(|_| "no webrtcdsp element".to_string())?;
        let sink = gst_app::AppSink::builder()
            .caps(&s16_caps(RATE))
            .sync(false)
            .async_(false)
            .build();
        pipeline
            .add_many([
                &convert,
                &resample,
                &caps,
                &probe,
                &drain,
                &dsp,
                sink.upcast_ref(),
            ])
            .map_err(|e| e.to_string())?;
        gst::Element::link_many([&convert, &resample, &caps, &probe, &drain])
            .map_err(|e| e.to_string())?;
        dsp.link(&sink).map_err(|e| e.to_string())?;

        let stats: Arc<Mutex<Stats>> = Arc::default();
        {
            let stats = stats.clone();
            sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(buffer) = sample.buffer()
                            && let Ok(map) = buffer.map_readable()
                        {
                            let mut stats = stats.lock().unwrap();
                            if stats.echo_until.is_some() {
                                stats.after += energy(&map);
                            }
                            drop(stats);
                            on_clean(map.to_vec());
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }
        let clock = gst::SystemClock::obtain();
        pipeline.use_clock(Some(&clock));
        if let Err(err) = pipeline.set_state(gst::State::Playing) {
            let _ = pipeline.set_state(gst::State::Null);
            return Err(format!("the echo canceller failed to start: {err}"));
        }
        let far = feeding("far", far_caps, &convert.static_pad("sink").unwrap())?;
        let near = feeding("near", &s16_caps(RATE), &dsp.static_pad("sink").unwrap())?;
        // Nothing here answers the pipeline's latency query (the pads are
        // ours): the probe is told it has none, or it gives silence.
        probe.send_event(gst::event::Latency::new(gst::ClockTime::ZERO));
        let base = clock.time();
        Ok(Self {
            pipeline,
            far,
            near,
            lead: settings.lead,
            clock,
            base,
            far_next: Mutex::new(gst::ClockTime::ZERO),
            near_next: Mutex::new(gst::ClockTime::ZERO),
            stats,
            on_report,
            far_buffers: AtomicU64::new(0),
        })
    }

    /// The time since the canceller started.
    pub fn now(&self) -> gst::ClockTime {
        self.clock.time().saturating_sub(self.base)
    }

    /// The far end as it goes out now (a buffer of the call's mix).
    pub fn far(&self, buffer: &gst::BufferRef) {
        let at = self.now() + self.lead;
        let mut copy = buffer.copy();
        if let Ok(map) = buffer.map_readable() {
            let samples = map.len() / 4;
            let loud = map
                .chunks_exact(4)
                .map(|b| {
                    let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64;
                    s * s
                })
                .sum::<f64>()
                / samples.max(1) as f64;
            if loud > FAR_AUDIBLE {
                self.stats.lock().unwrap().echo_until = Some(std::time::Instant::now() + ECHO_TAIL);
            }
        }
        self.push_far(copy.make_mut(), at, buffer.duration());
        self.far_buffers.fetch_add(1, Ordering::Relaxed);
        let _ = self.far.push(copy);
    }

    /// The far end's buffers pushed so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn far_frames(&self) -> u64 {
        self.far_buffers.load(Ordering::Relaxed)
    }

    /// The far end at `at`, for tests: `samples` as the far caps say.
    #[cfg(test)]
    pub fn far_at(&self, samples: &[u8], at: gst::ClockTime, duration: gst::ClockTime) {
        let mut buffer = gst::Buffer::from_slice(samples.to_vec());
        self.push_far(buffer.make_mut(), at, Some(duration));
        let _ = self.far.push(buffer);
    }

    fn push_far(
        &self,
        buffer: &mut gst::BufferRef,
        at: gst::ClockTime,
        duration: Option<gst::ClockTime>,
    ) {
        let mut next = self.far_next.lock().unwrap();
        let at = at.max(*next);
        *next = at + duration.unwrap_or(gst::ClockTime::ZERO);
        buffer.set_pts(at);
        buffer.set_dts(gst::ClockTime::NONE);
    }

    /// The microphone as it comes in now: 16 kHz mono S16LE.
    pub fn near(&self, samples: Vec<u8>) {
        let at = self.now();
        self.near_at(samples, at);
    }

    /// The microphone at `at` (16 kHz mono S16LE).
    pub fn near_at(&self, samples: Vec<u8>, at: gst::ClockTime) {
        let duration =
            gst::ClockTime::from_nseconds(samples.len() as u64 / 2 * 1_000_000_000 / RATE as u64);
        let report = {
            let mut stats = self.stats.lock().unwrap();
            match stats.echo_until {
                Some(until) if std::time::Instant::now() < until => {
                    stats.samples += samples.len() as u64 / 2;
                    stats.before += energy(&samples);
                    None
                }
                Some(_) => {
                    let report = (stats.samples > 0).then(|| Report {
                        seconds: stats.samples as f64 / RATE as f64,
                        before_db: db(stats.before / stats.samples as f64),
                        after_db: db(stats.after / stats.samples as f64),
                    });
                    *stats = Stats::default();
                    report
                }
                None => None,
            }
        };
        if let Some(report) = report
            && report.seconds >= REPORT_MIN_SECONDS
        {
            (self.on_report)(report);
        }
        let mut buffer = gst::Buffer::from_slice(samples);
        {
            let buffer = buffer.make_mut();
            let mut next = self.near_next.lock().unwrap();
            let at = at.max(*next);
            *next = at + duration;
            buffer.set_pts(at);
            buffer.set_duration(duration);
        }
        let _ = self.near.push(buffer);
    }
}

/// The sum of squares of S16LE `bytes`, scaled to full scale 1.
fn energy(bytes: &[u8]) -> f64 {
    bytes
        .chunks_exact(2)
        .map(|b| {
            let s = i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0;
            s * s
        })
        .sum()
}

impl Drop for EchoCanceller {
    fn drop(&mut self) {
        let _ = self.far.set_active(false);
        let _ = self.near.set_active(false);
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-random sequence (xorshift), in -1..1.
    struct Noise(u64);
    impl Noise {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 52) as f64 - 1.0
        }
    }

    /// Speech-like sound at 16 kHz: a glottal pulse train around `pitch`
    /// through two vowel formants that change every 120 ms, in syllables of
    /// about 200 ms with pauses, RMS about -20 dBFS while voiced.
    fn speech(seconds: f64, pitch: f64, seed: u64) -> Vec<f64> {
        const VOWELS: [(f64, f64); 5] = [
            (730.0, 1090.0),
            (270.0, 2290.0),
            (530.0, 1840.0),
            (300.0, 870.0),
            (640.0, 1190.0),
        ];
        let rate = RATE as f64;
        let n = (seconds * rate) as usize;
        let mut noise = Noise(seed);
        let mut out = Vec::with_capacity(n);
        let mut phase = 0.0;
        // Two resonators' states.
        let mut y = [[0.0f64; 2]; 2];
        let mut vowel = 0;
        for i in 0..n {
            let t = i as f64 / rate;
            if i % (rate as usize * 12 / 100) == 0 {
                vowel = ((noise.next() + 1.0) * 2.5) as usize % VOWELS.len();
            }
            let f0 = pitch * (1.0 + 0.15 * (2.0 * std::f64::consts::PI * 0.7 * t).sin());
            phase += f0 / rate;
            let pulse = if phase >= 1.0 {
                phase -= 1.0;
                1.0
            } else {
                0.0
            };
            let excitation = pulse + 0.05 * noise.next();
            let (f1, f2) = VOWELS[vowel];
            let mut sample = 0.0;
            for (k, f) in [f1, f2].into_iter().enumerate() {
                let r = 0.97f64;
                let w = 2.0 * std::f64::consts::PI * f / rate;
                let v = excitation + 2.0 * r * w.cos() * y[k][0] - r * r * y[k][1];
                y[k][1] = y[k][0];
                y[k][0] = v;
                sample += v * (1.0 - r);
            }
            // Syllables: 4 a second, every fifth one a pause.
            let syllable = (t * 4.0) as u64;
            let envelope = if syllable % 5 == 4 {
                0.0
            } else {
                (std::f64::consts::PI * (t * 4.0).fract()).sin()
            };
            out.push(sample * envelope);
        }
        // To -20 dBFS RMS over what is voiced.
        let voiced: Vec<f64> = out.iter().copied().filter(|s| s.abs() > 1e-6).collect();
        let rms = (voiced.iter().map(|s| s * s).sum::<f64>() / voiced.len() as f64).sqrt();
        let gain = 0.1 / rms;
        out.iter().map(|s| s * gain).collect()
    }

    /// A small room and a phone's loudspeaker: the direct sound, two
    /// reflections and a decaying tail, at 16 kHz.
    fn room() -> Vec<f64> {
        let mut ir = vec![0.0; 1600];
        ir[0] = 1.0;
        ir[37] = 0.45;
        ir[91] = -0.3;
        let mut noise = Noise(7);
        for (i, tap) in ir.iter_mut().enumerate().skip(120) {
            *tap += 0.08 * noise.next() * (-(i as f64) / 300.0).exp();
        }
        ir
    }

    fn convolve(signal: &[f64], ir: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; signal.len()];
        for (i, &s) in signal.iter().enumerate() {
            if s == 0.0 {
                continue;
            }
            for (k, &h) in ir.iter().enumerate() {
                if i + k < out.len() {
                    out[i + k] += s * h;
                }
            }
        }
        out
    }

    fn s16(samples: &[f64]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect()
    }

    fn from_s16(bytes: &[u8]) -> Vec<f64> {
        bytes
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0)
            .collect()
    }

    fn mean_square(samples: &[f64]) -> f64 {
        samples.iter().map(|s| s * s).sum::<f64>() / samples.len().max(1) as f64
    }

    struct Run {
        /// The echo alone, in dBFS, and what is left of it, over the
        /// stretch measured.
        echo_db: f64,
        residual_db: f64,
        /// The near speaker's level in the stretch with both talking:
        /// before, and after the canceller (with the echo's residue).
        near_db: f64,
        near_after_db: f64,
    }

    /// Plays `seconds` of a reply whose echo comes back `delay_ms` later,
    /// `echo_db` below it, through a room; the user talks over it in the
    /// last quarter. The far end goes in `lead_ms` ahead of now, as a call
    /// does.
    fn run(delay_ms: u64, echo_db: f64, lead_ms: u64, seconds: f64, near_talks: bool) -> Run {
        let far = speech(seconds, 210.0, 1);
        let user = speech(seconds, 120.0, 2);
        run_with(&far, &user, delay_ms, echo_db, lead_ms, near_talks, false)
    }

    /// `run` with the reply `far` and the user `user` (16 kHz); `distort`
    /// overdrives the loudspeaker a little.
    fn run_with(
        far: &[f64],
        user: &[f64],
        delay_ms: u64,
        echo_db: f64,
        lead_ms: u64,
        near_talks: bool,
        distort: bool,
    ) -> Run {
        gst::init().unwrap();
        let rate = RATE as usize;
        let far = far.to_vec();
        let gain = 10f64.powf(echo_db / 20.0);
        let delay = delay_ms as usize * rate / 1000;
        let mut echo = vec![0.0; far.len()];
        let played: Vec<f64> = if distort {
            far.iter().map(|s| (3.0 * s).tanh() / 3.0).collect()
        } else {
            far.clone()
        };
        let roomed = convolve(&played, &room());
        for i in delay..far.len() {
            echo[i] = roomed[i - delay] * gain;
        }
        let double_from = far.len() * 3 / 4;
        let user: Vec<f64> = user
            .iter()
            .copied()
            .chain(std::iter::repeat(0.0))
            .take(far.len())
            .collect();
        let mut noise = Noise(3);
        let mut near: Vec<f64> = echo.iter().map(|e| e + 0.0005 * noise.next()).collect();
        if near_talks {
            for i in double_from..near.len() {
                near[i] += user[i] * 0.5;
            }
        }
        let clean: Arc<Mutex<Vec<u8>>> = Arc::default();
        let canceller = {
            let clean = clean.clone();
            EchoCanceller::start(
                &Settings {
                    lead: gst::ClockTime::from_mseconds(lead_ms),
                    noise_suppression: false,
                    gain_control: false,
                },
                &s16_caps(RATE),
                Arc::new(move |samples| clean.lock().unwrap().extend(samples)),
                Arc::new(|_| {}),
            )
            .unwrap()
        };
        // 10 ms blocks, the far end first: it went out before its echo.
        let block = rate / 100;
        let far_bytes = s16(&far);
        let near_bytes = s16(&near);
        for (i, (f, n)) in far_bytes
            .chunks(block * 2)
            .zip(near_bytes.chunks(block * 2))
            .enumerate()
        {
            let at = gst::ClockTime::from_mseconds(i as u64 * 10);
            canceller.far_at(
                f,
                at + gst::ClockTime::from_mseconds(lead_ms),
                gst::ClockTime::from_mseconds(10),
            );
            canceller.near_at(n.to_vec(), at);
        }
        drop(canceller);
        let out = from_s16(&clean.lock().unwrap());
        assert!(
            out.len() + 2 * block >= near.len(),
            "{} of {} samples came out",
            out.len(),
            near.len()
        );
        // Converged: from 2 s on, until the user talks.
        let from = 2 * rate;
        let to = double_from.min(out.len());
        let user_part = &user[double_from..out.len().min(user.len())];
        Run {
            echo_db: db(mean_square(&echo[from..to])),
            residual_db: db(mean_square(&out[from..to])),
            near_db: db(mean_square(
                &user_part.iter().map(|s| s * 0.5).collect::<Vec<_>>(),
            )),
            near_after_db: db(mean_square(&out[double_from.min(out.len())..])),
        }
    }

    /// The echo of a reply at -10 dB and a few hundred ms is taken out.
    #[test]
    fn cancels_a_delayed_echo() {
        for delay in [150, 300, 450] {
            let run = run(delay, -10.0, DEFAULT_LEAD_MS, 10.0, true);
            let removed = run.echo_db - run.residual_db;
            eprintln!(
                "echo {delay} ms late at -10 dB: {:.1} dBFS, {:.1} dBFS left ({removed:.1} dB taken out); the user at {:.1} dBFS, {:.1} dBFS out while both talk",
                run.echo_db, run.residual_db, run.near_db, run.near_after_db
            );
            assert!(
                removed > 20.0,
                "only {removed:.1} dB taken out at {delay} ms"
            );
            // The user is still heard while the reply plays.
            assert!(
                run.near_after_db > run.near_db - 10.0,
                "the user went from {:.1} to {:.1} dBFS",
                run.near_db,
                run.near_after_db
            );
        }
    }

    /// The delays AEC3 finds past the lead, measured (cargo test --
    /// --ignored echo_delays --nocapture).
    #[test]
    #[ignore]
    fn echo_delays() {
        for delay in [60, 100, 200, 300, 400, 500, 600, 700, 800, 1000] {
            let run = run(delay, -10.0, DEFAULT_LEAD_MS, 12.0, false);
            eprintln!(
                "echo {delay} ms late (lead {DEFAULT_LEAD_MS} ms): {:.1} dBFS, {:.1} dBFS left: {:.1} dB taken out",
                run.echo_db,
                run.residual_db,
                run.echo_db - run.residual_db
            );
        }
    }

    /// A far end that comes too late (lead past the echo's delay) is not
    /// cancelled: the lead must stay below the round trip.
    #[test]
    #[ignore]
    fn too_late_a_far_end() {
        let run = run(100, -10.0, 300, 10.0, false);
        eprintln!(
            "echo 100 ms late, far end 300 ms ahead: {:.1} dB taken out",
            run.echo_db - run.residual_db
        );
    }

    /// A file as 16 kHz mono, to -20 dBFS RMS where it is not silent.
    fn read_voice(path: &str) -> Vec<f64> {
        gst::init().unwrap();
        let pipeline = gst::parse::launch(&format!(
            "filesrc location={path} ! decodebin ! audioconvert ! audioresample ! \
             audio/x-raw,format=S16LE,rate=16000,channels=1 ! appsink name=out sync=false"
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
        let mut bytes = Vec::new();
        while let Ok(sample) = sink.pull_sample() {
            bytes.extend_from_slice(&sample.buffer().unwrap().map_readable().unwrap());
        }
        pipeline.set_state(gst::State::Null).unwrap();
        let samples = from_s16(&bytes);
        let voiced: Vec<f64> = samples.iter().copied().filter(|s| s.abs() > 1e-3).collect();
        let rms = (mean_square(&voiced)).sqrt();
        samples.iter().map(|s| s * 0.1 / rms).collect()
    }

    /// Real voices (ROAMGATE_ECHO_FAR, ROAMGATE_ECHO_NEAR: audio files),
    /// measured: cargo test -- --ignored real_voices --nocapture.
    #[test]
    #[ignore]
    fn real_voices() {
        let (Ok(far), Ok(near)) = (
            std::env::var("ROAMGATE_ECHO_FAR"),
            std::env::var("ROAMGATE_ECHO_NEAR"),
        ) else {
            return;
        };
        let far = read_voice(&far);
        let near = read_voice(&near);
        for distort in [false, true] {
            for delay in [150, 300, 450] {
                let run = run_with(&far, &near, delay, -10.0, DEFAULT_LEAD_MS, true, distort);
                eprintln!(
                    "real voices, echo {delay} ms late at -10 dB{}: {:.1} dBFS, {:.1} dBFS left ({:.1} dB taken out); the user at {:.1} dBFS, {:.1} dBFS out while both talk",
                    if distort {
                        ", loudspeaker overdriven"
                    } else {
                        ""
                    },
                    run.echo_db,
                    run.residual_db,
                    run.echo_db - run.residual_db,
                    run.near_db,
                    run.near_after_db
                );
            }
        }
    }

    #[test]
    fn reports_say_what_was_taken_out() {
        let report = Report {
            seconds: 3.24,
            before_db: -31.0,
            after_db: -52.3,
        };
        assert!((report.removed_db() - 21.3).abs() < 1e-9);
        assert_eq!(
            report.to_string(),
            "over 3.2 s of the replies playing, the microphone at -31.0 dBFS, -52.3 dBFS once cancelled (21.3 dB taken out)"
        );
    }
}
