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
//!
//! What the page plays comes back a round trip later: the jitter buffers
//! of both legs, the phone's output and input. AEC3 finds the echo from
//! about 40 ms to about 500 ms past the far end's timestamps (see the
//! tests), not further: a round trip of 600 ms with a 60 ms lead is never
//! cancelled. So the delay is measured here (`Delay`): the energy of the
//! far end and of the microphone, in 10 ms frames, correlated over the last
//! seconds; and the lead moves when the echo is out of AEC3's reach, to put
//! it AIM_MS past the far end. The call starts with DEFAULT_LEAD_MS, below
//! any round trip, so that the far end never comes too late.
//!
//! The reports count the microphone while the far end's echo comes, at the
//! delay measured, leaving out where the user talks over it (the microphone
//! well above the echo expected): what is left is the echo, before and
//! after the canceller (and its gain control).
//!
//! A microphone may come with its echo already taken out: the Roamgate
//! app's (Android's voice-communication input, with the phone's own echo
//! canceller and noise suppression) is digital silence while the replies
//! play on the loudspeaker, and only the user is ever heard in it. There is
//! then no echo, so no delay to measure, and AEC3, its noise suppression
//! and gain control would only work on the user's voice. So that is told
//! apart (`Delay::silence`): the microphone silent (below NEAR_SILENT, no
//! microphone's own noise is that low) in most of the frames the far end's
//! echo would come in. It then goes through untouched (`passthrough`),
//! until an echo is heard in it again (a delay measured, or the microphone
//! no longer silent while the far end plays).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use gst::prelude::*;

/// The rate the microphone comes at, and the canceller runs at.
pub const RATE: i32 = 16_000;
/// The lead a call starts with, until the echo's delay is measured.
pub const DEFAULT_LEAD_MS: u64 = 60;
/// Far-end frames louder than this (mean square, -50 dBFS) are a reply or
/// music playing, whose echo may come.
const FAR_AUDIBLE: f64 = 1e-5;
/// A stretch of echo shorter than this is not reported.
const REPORT_MIN_SECONDS: f64 = 1.0;

/// The frames the echo's delay is measured in: 10 ms.
const FRAME_NS: u64 = 10_000_000;
/// The longest echo delay looked for, in frames: 1.5 s.
const MAX_DELAY: usize = 150;
/// The microphone's last 8 s are measured...
const WINDOW: usize = 800;
/// ...once there are 3 s of it, with the far end audible for 1.5 s...
const MIN_WINDOW: usize = 300;
const MIN_AUDIBLE: usize = 150;
/// ...every second.
const MEASURE_EVERY: u64 = 100;
/// A delay is taken when the correlation there is at least this, and this
/// much above any other further than SHARP frames from it...
const MIN_CORRELATION: f64 = 0.3;
const MIN_MARGIN: f64 = 0.05;
const SHARP: usize = 5;
/// ...and two measures in a row agree, this close (frames).
const AGREE: u64 = 3;
/// The echo is kept from REACH_MIN_MS to REACH_MAX_MS past the far end's
/// timestamps, where AEC3 finds it, and put AIM_MS past when the lead moves.
const REACH_MIN_MS: u64 = 60;
const REACH_MAX_MS: u64 = 420;
const AIM_MS: u64 = 200;
/// The far end is looked at this many frames around the delay, each side.
const ECHO_SPREAD: u64 = 3;
/// The microphone louder than DOUBLE_TALK_FLOOR and DOUBLE_TALK_RATIO
/// (3 dB) above the echo expected: the user talks over the reply. Echo
/// taken for the user only goes uncounted; the user taken for echo would
/// count as echo left.
const DOUBLE_TALK_RATIO: f64 = 2.0;
const DOUBLE_TALK_FLOOR: f64 = 1e-6;
/// A report ends when no echo came for REPORT_GAP frames (1.2 s), or once
/// it covers REPORT_MAX (30 s: the music plays on).
const REPORT_GAP: u64 = 120;
const REPORT_MAX: u64 = 3000;
/// A microphone frame quieter than this (mean square, -80 dBFS) is the
/// silence a phone's own echo canceller and noise suppression leave: no
/// microphone's own noise is that low.
const NEAR_SILENT: f64 = 1e-8;
/// The microphone silent in at least this share of the frames the far
/// end's echo would come in: its echo was taken out before it came here...
const SILENT_SHARE: f64 = 0.6;
/// ...and heard again when silent in less than this share of them.
const HEARD_SHARE: f64 = 0.2;

/// The canceller's settings.
#[derive(Clone, Debug)]
pub struct Settings {
    /// What the far end is put ahead by, at first.
    pub lead: gst::ClockTime,
    /// Whether the lead follows the echo's delay measured.
    pub align: bool,
    pub noise_suppression: bool,
    pub gain_control: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            lead: gst::ClockTime::from_mseconds(DEFAULT_LEAD_MS),
            align: true,
            noise_suppression: true,
            gain_control: true,
        }
    }
}

/// The microphone with the echo taken out: 16 kHz mono S16LE.
pub type OnClean = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
/// What the canceller found and did, to trace.
pub type OnReport = Arc<dyn Fn(Event) + Send + Sync>;

/// What the canceller traces.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    /// The microphone's levels over a stretch of echo.
    Report(Report),
    /// The echo's delay measured (a new one): how long after the far end
    /// goes out its echo comes in.
    Delay {
        delay_ms: u64,
        correlation: f64,
        lead_ms: u64,
        /// The lead moved for it.
        moved: bool,
    },
    /// The microphone came with the echo already taken out (`taken_out`),
    /// silent in `silent_share` of the frames the echo would come in, at
    /// `level_db` there; or the echo is heard in it again.
    Upstream {
        taken_out: bool,
        silent_share: f64,
        level_db: f64,
    },
}

impl std::fmt::Display for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Event::Report(report) => report.fmt(f),
            Event::Delay {
                delay_ms,
                correlation,
                lead_ms,
                moved: true,
            } => write!(
                f,
                "the echo comes {delay_ms} ms after the replies go out (correlation {correlation:.2}): the far end now leads by {lead_ms} ms, for AEC3 to find it"
            ),
            Event::Delay {
                delay_ms,
                correlation,
                lead_ms,
                moved: false,
            } => write!(
                f,
                "the echo comes {delay_ms} ms after the replies go out (correlation {correlation:.2}), within AEC3's reach from the {lead_ms} ms lead"
            ),
            Event::Upstream {
                taken_out: true,
                silent_share,
                level_db,
            } => write!(
                f,
                "the microphone hears none of the replies while they play (silent in {:.0}% of the frames their echo would come in, at {level_db:.1} dBFS there): their echo is taken out before it comes here (the phone's own echo canceller), so there is no delay to measure; the microphone goes through untouched, without AEC3, its noise suppression or gain control",
                silent_share * 100.0
            ),
            Event::Upstream {
                taken_out: false,
                silent_share,
                level_db,
            } => write!(
                f,
                "the replies are heard in the microphone again (silent in {:.0}% of the frames their echo would come in, at {level_db:.1} dBFS there): back through AEC3",
                silent_share * 100.0
            ),
        }
    }
}

/// The microphone's levels while the far end's echo came: before the
/// canceller, and after.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Report {
    pub seconds: f64,
    /// Mean square, in dBFS.
    pub before_db: f64,
    pub after_db: f64,
    /// What the canceller took out of a 10 ms frame, in dB: the median, which
    /// the user talking over the echo (not told apart) moves little.
    pub removed_db: f64,
    /// Left out: the user talking over the echo.
    pub double_talk_seconds: f64,
    /// The echo's delay, when measured.
    pub delay_ms: Option<u64>,
    /// The echo was taken out before it came: the microphone went through
    /// untouched, the user being whatever is not silent in it.
    pub passthrough: bool,
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.passthrough {
            write!(
                f,
                "over {:.1} s of the replies, the microphone heard none of their echo, at {:.1} dBFS (taken out before it came here), and went through untouched",
                self.seconds, self.before_db
            )?;
            if self.double_talk_seconds > 0.0 {
                write!(
                    f,
                    "; {:.1} s of the user talking over them",
                    self.double_talk_seconds
                )?;
            }
            return Ok(());
        }
        write!(f, "over {:.1} s of the replies' echo", self.seconds)?;
        match self.delay_ms {
            Some(delay) => write!(f, " ({delay} ms late)")?,
            None => write!(f, " (its delay not measured)")?,
        }
        write!(
            f,
            ", the microphone at {:.1} dBFS, {:.1} dBFS once cancelled ({:.1} dB taken out of a 10 ms frame, the median)",
            self.before_db, self.after_db, self.removed_db
        )?;
        if self.double_talk_seconds > 0.0 {
            write!(
                f,
                "; {:.1} s of the user talking over it left out",
                self.double_talk_seconds
            )?;
        }
        Ok(())
    }
}

fn db(mean_square: f64) -> f64 {
    10.0 * mean_square.max(1e-12).log10()
}

/// A stream's energy, a mean square per frame, the last ones.
#[derive(Default)]
struct Envelope {
    first: u64,
    power: VecDeque<f64>,
}

impl Envelope {
    const KEEP: usize = WINDOW + MAX_DELAY + 2 * ECHO_SPREAD as usize + 100;

    fn end(&self) -> u64 {
        self.first + self.power.len() as u64
    }

    fn add(&mut self, frame: u64, power: f64) {
        if self.power.is_empty() {
            self.first = frame;
        }
        if frame < self.first {
            return;
        }
        if frame < self.end() {
            self.power[(frame - self.first) as usize] = power;
            return;
        }
        let gap = frame - self.end();
        if gap > Self::KEEP as u64 {
            self.power.clear();
            self.first = frame;
        } else {
            self.power.extend(std::iter::repeat_n(0.0, gap as usize));
        }
        self.power.push_back(power);
        while self.power.len() > Self::KEEP {
            self.power.pop_front();
            self.first += 1;
        }
    }

    fn get(&self, frame: u64) -> Option<f64> {
        frame
            .checked_sub(self.first)
            .and_then(|i| self.power.get(i as usize).copied())
    }

    /// The loudest frame from `from` to `to`, both included.
    fn loudest(&self, from: u64, to: u64) -> f64 {
        (from..=to)
            .filter_map(|frame| self.get(frame))
            .fold(0.0, f64::max)
    }
}

/// Cuts samples timestamped at `rate` into frames, by their time.
#[derive(Default)]
struct Framer {
    start: u64,
    next: u64,
    sum: f64,
    count: u32,
}

impl Framer {
    /// Adds `squares` (a sample's square each) from `at` (ns); gives each
    /// frame completed, its index and mean square, to `out`.
    fn add(
        &mut self,
        at: u64,
        rate: u64,
        squares: impl Iterator<Item = f64>,
        mut out: impl FnMut(u64, f64),
    ) {
        let per_frame = (rate * FRAME_NS / 1_000_000_000) as u32;
        // Not where the last one ended: a frame afresh.
        if self.count > 0 && at.abs_diff(self.next) > FRAME_NS {
            self.count = 0;
            self.sum = 0.0;
        }
        let mut n = 0u64;
        for square in squares {
            if self.count == 0 {
                self.start = at + n * 1_000_000_000 / rate;
            }
            self.sum += square;
            self.count += 1;
            n += 1;
            if self.count == per_frame {
                out(
                    (self.start + FRAME_NS / 2) / FRAME_NS,
                    self.sum / per_frame as f64,
                );
                self.sum = 0.0;
                self.count = 0;
            }
        }
        self.next = at + n * 1_000_000_000 / rate;
    }
}

/// A delay measured: in frames, the correlation there, and the echo's
/// power over the far end's (median).
#[derive(Clone, Copy, Debug)]
struct Measure {
    frames: u64,
    correlation: f64,
    coupling: f64,
}

/// The log of a frame's energy, -90 dBFS at the least.
fn feature(power: f64) -> f64 {
    (power + 1e-9).log10()
}

/// The echo's delay: the far end's energy (frames by the time it goes out)
/// and the microphone's (by the time it comes in), correlated.
#[derive(Default)]
struct Delay {
    far: Envelope,
    near: Envelope,
}

/// The microphone over the frames the far end's echo would come in (the
/// far end audible at most MAX_DELAY before), in the last WINDOW.
#[derive(Clone, Copy, Debug)]
struct Silence {
    /// Its share of them below NEAR_SILENT...
    share: f64,
    /// ...and its mean square there.
    level: f64,
}

impl Delay {
    /// The microphone where the far end's echo would come in, once the far
    /// end was audible for MIN_AUDIBLE of the frames looked at.
    fn silence(&self) -> Option<Silence> {
        let end = self.near.end();
        let from = end.saturating_sub(WINDOW as u64).max(self.near.first);
        if end - from < MIN_WINDOW as u64 {
            return None;
        }
        // The last frame the far end was audible in, from MAX_DELAY before.
        let mut audible_at = None;
        for frame in from.saturating_sub(MAX_DELAY as u64)..from {
            if self.far.get(frame).is_some_and(|p| p > FAR_AUDIBLE) {
                audible_at = Some(frame);
            }
        }
        let (mut frames, mut silent, mut sum) = (0usize, 0usize, 0.0);
        for frame in from..end {
            if self.far.get(frame).is_some_and(|p| p > FAR_AUDIBLE) {
                audible_at = Some(frame);
            }
            if !audible_at.is_some_and(|at| frame - at <= MAX_DELAY as u64) {
                continue;
            }
            let near = self.near.get(frame).unwrap_or(0.0);
            frames += 1;
            sum += near;
            if near < NEAR_SILENT {
                silent += 1;
            }
        }
        (frames >= MIN_AUDIBLE).then(|| Silence {
            share: silent as f64 / frames as f64,
            level: sum / frames as f64,
        })
    }

    fn measure(&self) -> Option<Measure> {
        let end = self.near.end();
        let from = end.saturating_sub(WINDOW as u64).max(self.near.first);
        if end - from < MIN_WINDOW as u64 {
            return None;
        }
        let far_from = from.saturating_sub(MAX_DELAY as u64);
        let audible = (far_from..end)
            .filter(|&frame| self.far.get(frame).is_some_and(|p| p > FAR_AUDIBLE))
            .count();
        if audible < MIN_AUDIBLE {
            return None;
        }
        // The log energy's changes, frame to frame: the syllables' onsets
        // and ends, much sharper in time than the energy itself.
        let near: Vec<f64> = (from..end)
            .map(|frame| {
                let at = |frame| feature(self.near.get(frame).unwrap_or(0.0));
                at(frame) - at(frame.saturating_sub(1))
            })
            .collect();
        let far: Vec<Option<f64>> = (far_from..end)
            .map(|frame| {
                let before = self.far.get(frame.checked_sub(1)?)?;
                Some(feature(self.far.get(frame)?) - feature(before))
            })
            .collect();
        let correlations: Vec<f64> = (0..=MAX_DELAY as u64)
            .map(|lag| {
                let (mut n, mut sx, mut sy, mut sxx, mut syy, mut sxy) =
                    (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
                for (i, &x) in near.iter().enumerate() {
                    let Some(at) = (from + i as u64).checked_sub(lag + far_from) else {
                        continue;
                    };
                    let Some(y) = far[at as usize] else {
                        continue;
                    };
                    n += 1.0;
                    sx += x;
                    sy += y;
                    sxx += x * x;
                    syy += y * y;
                    sxy += x * y;
                }
                if n < MIN_WINDOW as f64 {
                    return 0.0;
                }
                let vx = sxx - sx * sx / n;
                let vy = syy - sy * sy / n;
                if vx <= 1e-12 || vy <= 1e-12 {
                    return 0.0;
                }
                (sxy - sx * sy / n) / (vx * vy).sqrt()
            })
            .collect();
        let (best, &correlation) = correlations
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))?;
        let other = correlations
            .iter()
            .enumerate()
            .filter(|(lag, _)| lag.abs_diff(best) > SHARP)
            .map(|(_, &r)| r)
            .fold(f64::MIN, f64::max);
        if correlation < MIN_CORRELATION || correlation - other < MIN_MARGIN {
            return None;
        }
        let mut ratios: Vec<f64> = (from..end)
            .filter_map(|frame| {
                let far = self.far.get(frame.checked_sub(best as u64)?)?;
                (far > FAR_AUDIBLE).then(|| self.near.get(frame).unwrap_or(0.0) / far)
            })
            .collect();
        if ratios.is_empty() {
            return None;
        }
        ratios.sort_by(f64::total_cmp);
        Some(Measure {
            frames: best as u64,
            correlation,
            coupling: ratios[ratios.len() / 2],
        })
    }
}

/// The microphone's energy while the far end's echo comes.
#[derive(Default)]
struct Stats {
    /// Each frame's energy, before and after the canceller.
    frames: Vec<(f64, f64)>,
    double_talk: u64,
    /// The last frame the echo came in.
    last_echo: Option<u64>,
}

/// What the far end's and the microphone's threads share.
struct State {
    lead: gst::ClockTime,
    /// The far end's and the microphone's next timestamps: never before
    /// the last ones.
    far_next: gst::ClockTime,
    near_next: gst::ClockTime,
    far_frames: Framer,
    near_frames: Framer,
    delay: Delay,
    /// Microphone frames measured since the last measure.
    unmeasured: u64,
    /// The last measure, and the one taken (agreed with the one before).
    last: Option<Measure>,
    taken: Option<Measure>,
    /// The microphone's frames on their way through the canceller: their
    /// index and power, and the canceller's output so far.
    pending: VecDeque<(u64, f64)>,
    clean_sum: f64,
    clean_count: u32,
    stats: Stats,
    /// The microphone came with the echo taken out: it goes through
    /// untouched.
    passthrough: bool,
}

impl State {
    /// Whether the frame `frame` of the microphone, at `before` and
    /// `after` the canceller, had echo in it; a report when one ends.
    fn count(&mut self, frame: u64, before: f64, after: f64) -> Option<Report> {
        let far = match self.taken {
            Some(m) => {
                let at = frame.saturating_sub(m.frames);
                self.delay
                    .far
                    .loudest(at.saturating_sub(ECHO_SPREAD), at + ECHO_SPREAD)
            }
            None => self
                .delay
                .far
                .loudest(frame.saturating_sub(MAX_DELAY as u64), frame),
        };
        if far > FAR_AUDIBLE {
            self.stats.last_echo = Some(frame);
            match self.taken {
                // Nothing of the echo comes: what is heard is the user.
                _ if self.passthrough && before >= NEAR_SILENT => self.stats.double_talk += 1,
                Some(m)
                    if before > DOUBLE_TALK_FLOOR
                        && before > DOUBLE_TALK_RATIO * m.coupling * far =>
                {
                    self.stats.double_talk += 1
                }
                _ => {
                    self.stats.frames.push((before, after));
                }
            }
        }
        let counted = self.stats.frames.len() as u64 + self.stats.double_talk;
        let ended = self
            .stats
            .last_echo
            .is_some_and(|last| frame > last + REPORT_GAP)
            || counted >= REPORT_MAX;
        if !ended {
            return None;
        }
        self.finish()
    }

    /// The report of the echo counted so far, if long enough.
    fn finish(&mut self) -> Option<Report> {
        let stats = std::mem::take(&mut self.stats);
        let seconds = stats.frames.len() as f64 * FRAME_NS as f64 / 1e9;
        if seconds < REPORT_MIN_SECONDS {
            return None;
        }
        let median = |mut values: Vec<f64>| {
            values.sort_by(f64::total_cmp);
            values[values.len() / 2]
        };
        Some(Report {
            seconds,
            before_db: db(stats.frames.iter().map(|f| f.0).sum::<f64>() / stats.frames.len() as f64),
            after_db: db(stats.frames.iter().map(|f| f.1).sum::<f64>() / stats.frames.len() as f64),
            removed_db: db(median(
                stats
                    .frames
                    .iter()
                    .map(|(before, after)| before.max(1e-12) / after.max(1e-12))
                    .collect(),
            )),
            double_talk_seconds: stats.double_talk as f64 * FRAME_NS as f64 / 1e9,
            delay_ms: self.taken.map(|m| m.frames * FRAME_NS / 1_000_000),
            passthrough: self.passthrough,
        })
    }

    /// Measures the delay again, and whether the microphone came with the
    /// echo taken out (see `upstream`).
    fn measure(&mut self, align: bool) -> Vec<Event> {
        let mut events = Vec::new();
        if let Some(measure) = self.delay.measure() {
            self.follow(measure, align, &mut events);
        }
        self.upstream(&mut events);
        events
    }

    /// Lets the microphone through untouched while it is silent where the
    /// far end's echo would come, with no delay measured: its echo was taken
    /// out before it came (a phone's own echo canceller); back through the
    /// canceller once a delay is measured, or the microphone is no longer
    /// silent there. The echo counted so far is reported first.
    fn upstream(&mut self, events: &mut Vec<Event>) {
        let Some(silence) = self.delay.silence() else {
            return;
        };
        let change = if self.passthrough {
            self.taken.is_some() || silence.share < HEARD_SHARE
        } else {
            self.taken.is_none() && silence.share >= SILENT_SHARE
        };
        if !change {
            return;
        }
        if let Some(report) = self.finish() {
            events.push(Event::Report(report));
        }
        self.passthrough = !self.passthrough;
        // Frames on their way through the canceller come out of it no more.
        self.pending.clear();
        self.clean_sum = 0.0;
        self.clean_count = 0;
        events.push(Event::Upstream {
            taken_out: self.passthrough,
            silent_share: silence.share,
            level_db: db(silence.level),
        });
    }

    /// Takes a delay measured when it agrees with the one before; moves the
    /// lead when `align` and the echo is out of AEC3's reach, the echo
    /// counted so far reported first. A new delay taken is told.
    fn follow(&mut self, measure: Measure, align: bool, events: &mut Vec<Event>) {
        let agreed = self
            .last
            .is_some_and(|last| last.frames.abs_diff(measure.frames) <= AGREE);
        self.last = Some(measure);
        if !agreed {
            return;
        }
        let new = self
            .taken
            .is_none_or(|taken| taken.frames.abs_diff(measure.frames) > AGREE);
        if new {
            self.taken = Some(measure);
        } else if let Some(taken) = &mut self.taken {
            // The same delay: its coupling, as it is now.
            taken.coupling = measure.coupling;
        }
        let delay = gst::ClockTime::from_nseconds(measure.frames * FRAME_NS);
        let past = delay.nseconds() as i64 - self.lead.nseconds() as i64;
        let reach = REACH_MIN_MS as i64 * 1_000_000..=REACH_MAX_MS as i64 * 1_000_000;
        let moved = align && !reach.contains(&past) && {
            let lead = delay.saturating_sub(gst::ClockTime::from_mseconds(AIM_MS));
            let moved = lead != self.lead;
            self.lead = lead;
            // The far end's timestamps may go back.
            self.far_next = gst::ClockTime::ZERO;
            moved
        };
        if moved {
            self.taken = Some(measure);
            if let Some(report) = self.finish() {
                events.push(Event::Report(report));
            }
        }
        if new || moved {
            events.push(Event::Delay {
                delay_ms: delay.mseconds(),
                correlation: measure.correlation,
                lead_ms: self.lead.mseconds(),
                moved,
            });
        }
    }
}

/// The far end's format: F32 or S16, interleaved.
#[derive(Clone, Copy, Debug)]
struct Format {
    float: bool,
    channels: usize,
    rate: u64,
}

impl Format {
    fn from_caps(caps: &gst::Caps) -> Result<Self, String> {
        let s = caps.structure(0).ok_or("no far-end caps")?;
        let float = match s.get::<&str>("format") {
            Ok("F32LE") => true,
            Ok("S16LE") => false,
            other => return Err(format!("far end as {other:?}: F32LE or S16LE only")),
        };
        Ok(Self {
            float,
            channels: s.get::<i32>("channels").unwrap_or(1).max(1) as usize,
            rate: s.get::<i32>("rate").map_err(|e| e.to_string())?.max(1) as u64,
        })
    }

    /// Each sample's square (the channels' mean), full scale 1.
    fn squares(self, bytes: &[u8]) -> impl Iterator<Item = f64> + '_ {
        let width = if self.float { 4 } else { 2 };
        bytes.chunks_exact(width * self.channels).map(move |frame| {
            frame
                .chunks_exact(width)
                .map(|b| {
                    let s = if self.float {
                        f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64
                    } else {
                        i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0
                    };
                    s * s
                })
                .sum::<f64>()
                / self.channels as f64
        })
    }
}

/// Each S16LE sample's square, full scale 1.
fn s16_squares(bytes: &[u8]) -> impl Iterator<Item = f64> + '_ {
    bytes.chunks_exact(2).map(|b| {
        let s = i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0;
        s * s
    })
}

static COUNT: AtomicU32 = AtomicU32::new(0);

pub struct EchoCanceller {
    pipeline: gst::Pipeline,
    far: gst::Pad,
    near: gst::Pad,
    far_format: Format,
    align: bool,
    /// The time pushes are stamped with: our own clock, from `base`.
    clock: gst::Clock,
    base: gst::ClockTime,
    state: Arc<Mutex<State>>,
    /// Where the microphone goes when it passes through untouched.
    on_clean: OnClean,
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
    /// The far end comes as `far_caps` (the call's mix, F32LE or S16LE);
    /// the microphone goes to `on_clean`, the echo taken out.
    pub fn start(
        settings: &Settings,
        far_caps: &gst::Caps,
        on_clean: OnClean,
        on_report: OnReport,
    ) -> Result<Self, String> {
        let far_format = Format::from_caps(far_caps)?;
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

        let state = Arc::new(Mutex::new(State {
            lead: settings.lead,
            far_next: gst::ClockTime::ZERO,
            near_next: gst::ClockTime::ZERO,
            far_frames: Framer::default(),
            near_frames: Framer::default(),
            delay: Delay::default(),
            unmeasured: 0,
            last: None,
            taken: None,
            pending: VecDeque::new(),
            clean_sum: 0.0,
            clean_count: 0,
            stats: Stats::default(),
            passthrough: false,
        }));
        {
            let state = state.clone();
            let on_report = on_report.clone();
            let on_clean = on_clean.clone();
            let per_frame = (RATE as u64 * FRAME_NS / 1_000_000_000) as u32;
            sink.set_callbacks(
                gst_app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(buffer) = sample.buffer()
                            && let Ok(map) = buffer.map_readable()
                        {
                            let mut reports = Vec::new();
                            {
                                let mut state = state.lock().unwrap();
                                for square in s16_squares(&map) {
                                    state.clean_sum += square;
                                    state.clean_count += 1;
                                    if state.clean_count < per_frame {
                                        continue;
                                    }
                                    let after = state.clean_sum / per_frame as f64;
                                    state.clean_sum = 0.0;
                                    state.clean_count = 0;
                                    if let Some((frame, before)) = state.pending.pop_front()
                                        && let Some(report) = state.count(frame, before, after)
                                    {
                                        reports.push(report);
                                    }
                                }
                            }
                            for report in reports {
                                on_report(Event::Report(report));
                            }
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
            far_format,
            align: settings.align,
            clock,
            base,
            state,
            on_clean,
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
        let mut copy = buffer.copy();
        self.push_far(copy.make_mut(), self.now(), buffer.duration());
        self.far_buffers.fetch_add(1, Ordering::Relaxed);
        let _ = self.far.push(copy);
    }

    /// The far end's buffers pushed so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn far_frames(&self) -> u64 {
        self.far_buffers.load(Ordering::Relaxed)
    }

    /// The far end going out at `at`, for tests: `samples` as the far caps
    /// say.
    #[cfg(test)]
    pub fn far_at(&self, samples: &[u8], at: gst::ClockTime, duration: gst::ClockTime) {
        let mut buffer = gst::Buffer::from_slice(samples.to_vec());
        self.push_far(buffer.make_mut(), at, Some(duration));
        let _ = self.far.push(buffer);
    }

    /// The lead now, for tests.
    #[cfg(test)]
    pub fn lead(&self) -> gst::ClockTime {
        self.state.lock().unwrap().lead
    }

    /// Stamps `buffer`, going out at `out`, with `out` plus the lead, and
    /// adds it to the far end's energy, by `out`.
    fn push_far(
        &self,
        buffer: &mut gst::BufferRef,
        out: gst::ClockTime,
        duration: Option<gst::ClockTime>,
    ) {
        let mut state = self.state.lock().unwrap();
        let lead = state.lead;
        let at = (out + lead).max(state.far_next);
        state.far_next = at + duration.unwrap_or(gst::ClockTime::ZERO);
        buffer.set_pts(at);
        buffer.set_dts(gst::ClockTime::NONE);
        if let Ok(map) = buffer.map_readable() {
            let State {
                far_frames, delay, ..
            } = &mut *state;
            far_frames.add(
                (at - lead).nseconds(),
                self.far_format.rate,
                self.far_format.squares(&map),
                |frame, power| delay.far.add(frame, power),
            );
        }
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
        let (at, passthrough, events) = {
            let mut state = self.state.lock().unwrap();
            let at = at.max(state.near_next);
            state.near_next = at + duration;
            let passthrough = state.passthrough;
            let mut frames = Vec::new();
            {
                let State {
                    near_frames, delay, ..
                } = &mut *state;
                near_frames.add(
                    at.nseconds(),
                    RATE as u64,
                    s16_squares(&samples),
                    |frame, power| {
                        delay.near.add(frame, power);
                        frames.push((frame, power));
                    },
                );
            }
            let mut events = Vec::new();
            state.unmeasured += frames.len() as u64;
            for (frame, power) in frames {
                if passthrough {
                    // Untouched: as it came.
                    if let Some(report) = state.count(frame, power, power) {
                        events.push(Event::Report(report));
                    }
                } else {
                    state.pending.push_back((frame, power));
                }
            }
            // The canceller gives as much as it takes: more pending means
            // its output was lost.
            while state.pending.len() > 100 {
                state.pending.pop_front();
            }
            if state.unmeasured >= MEASURE_EVERY {
                state.unmeasured = 0;
                events.extend(state.measure(self.align));
            }
            (at, passthrough, events)
        };
        for event in events {
            (self.on_report)(event);
        }
        if passthrough {
            (self.on_clean)(samples);
            return;
        }
        let mut buffer = gst::Buffer::from_slice(samples);
        {
            let buffer = buffer.make_mut();
            buffer.set_pts(at);
            buffer.set_duration(duration);
        }
        let _ = self.near.push(buffer);
    }
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
        /// The last delay measured, the lead at the end, and the reports.
        delay_ms: Option<u64>,
        lead_ms: u64,
        reports: Vec<Report>,
        /// Whether the microphone was ever taken as coming with the echo
        /// taken out.
        passthrough: bool,
    }

    /// Feeds the far end `far` and the microphone `near` (16 kHz), in 10 ms
    /// blocks, the far end first (it went out before its echo), as a call
    /// does with the far end `lead_ms` ahead; gives what came out, the
    /// events and the lead at the end.
    fn drive(far: &[f64], near: &[f64], lead_ms: u64, align: bool) -> (Vec<f64>, Vec<Event>, u64) {
        gst::init().unwrap();
        let clean: Arc<Mutex<Vec<u8>>> = Arc::default();
        let events: Arc<Mutex<Vec<Event>>> = Arc::default();
        let canceller = {
            let clean = clean.clone();
            EchoCanceller::start(
                &Settings {
                    lead: gst::ClockTime::from_mseconds(lead_ms),
                    align,
                    noise_suppression: false,
                    gain_control: false,
                },
                &s16_caps(RATE),
                Arc::new(move |samples| clean.lock().unwrap().extend(samples)),
                {
                    let events = events.clone();
                    Arc::new(move |event| {
                        eprintln!("  {event}");
                        events.lock().unwrap().push(event)
                    })
                },
            )
            .unwrap()
        };
        let block = RATE as usize / 100;
        for (i, (f, n)) in s16(far)
            .chunks(block * 2)
            .zip(s16(near).chunks(block * 2))
            .enumerate()
        {
            let at = gst::ClockTime::from_mseconds(i as u64 * 10);
            canceller.far_at(f, at, gst::ClockTime::from_mseconds(10));
            canceller.near_at(n.to_vec(), at);
        }
        let lead_ms = canceller.lead().mseconds();
        drop(canceller);
        let out = from_s16(&clean.lock().unwrap());
        let events = std::mem::take(&mut *events.lock().unwrap());
        (out, events, lead_ms)
    }

    /// Plays `seconds` of a reply whose echo comes back `delay_ms` later,
    /// `echo_db` below it, through a room; the user talks over it in the
    /// last quarter. The far end goes in `lead_ms` ahead of now, as a call
    /// does.
    fn run(delay_ms: u64, echo_db: f64, lead_ms: u64, seconds: f64, near_talks: bool) -> Run {
        let far = speech(seconds, 210.0, 1);
        let user = speech(seconds, 120.0, 2);
        run_with(
            &far, &user, delay_ms, echo_db, lead_ms, near_talks, false, false, 2.0,
        )
    }

    /// `run` with the reply `far` and the user `user` (16 kHz); `distort`
    /// overdrives the loudspeaker a little; `align` lets the lead follow the
    /// delay measured; the echo left is measured from `settle` s on.
    #[allow(clippy::too_many_arguments)]
    fn run_with(
        far: &[f64],
        user: &[f64],
        delay_ms: u64,
        echo_db: f64,
        lead_ms: u64,
        near_talks: bool,
        distort: bool,
        align: bool,
        settle: f64,
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
        // Then 3 s of silence and the room's noise: the last report.
        let tail = rate * 3;
        let (mut out, events, lead_ms) = drive(
            &far.iter()
                .copied()
                .chain(std::iter::repeat_n(0.0, tail))
                .collect::<Vec<_>>(),
            &near
                .iter()
                .copied()
                .chain((0..tail).map(|_| 0.0005 * noise.next()))
                .collect::<Vec<_>>(),
            lead_ms,
            align,
        );
        let block = rate / 100;
        out.truncate(near.len());
        assert!(
            out.len() + 2 * block >= near.len(),
            "{} of {} samples came out",
            out.len(),
            near.len()
        );
        // Converged: from `settle` s on, until the user talks.
        let from = (settle * rate as f64) as usize;
        let to = double_from.min(out.len());
        let user_part = &user[double_from..out.len().min(user.len())];
        Run {
            echo_db: db(mean_square(&echo[from..to])),
            residual_db: db(mean_square(&out[from..to])),
            near_db: db(mean_square(
                &user_part.iter().map(|s| s * 0.5).collect::<Vec<_>>(),
            )),
            near_after_db: db(mean_square(&out[double_from.min(out.len())..])),
            delay_ms: events.iter().rev().find_map(|e| match e {
                Event::Delay { delay_ms, .. } => Some(*delay_ms),
                _ => None,
            }),
            lead_ms,
            reports: events
                .iter()
                .filter_map(|e| match e {
                    Event::Report(r) => Some(*r),
                    _ => None,
                })
                .collect(),
            passthrough: events.iter().any(|e| {
                matches!(
                    e,
                    Event::Upstream {
                        taken_out: true,
                        ..
                    }
                )
            }),
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
            // An echo is there: the microphone goes through the canceller.
            assert!(!run.passthrough);
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
                let run = run_with(
                    &far,
                    &near,
                    delay,
                    -10.0,
                    DEFAULT_LEAD_MS,
                    true,
                    distort,
                    false,
                    2.0,
                );
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

    /// A round trip past AEC3's reach from the lead the call starts with
    /// (the phone's buffers, the jitter buffers of both legs): with a fixed
    /// lead the echo stays; measured, the lead moves and it is taken out.
    #[test]
    fn follows_a_long_round_trip() {
        let far = speech(20.0, 210.0, 1);
        let user = speech(20.0, 120.0, 2);
        for delay in [650, 900, 1200] {
            let fixed = run_with(
                &far,
                &user,
                delay,
                -10.0,
                DEFAULT_LEAD_MS,
                true,
                false,
                false,
                9.0,
            );
            let aligned = run_with(
                &far,
                &user,
                delay,
                -10.0,
                DEFAULT_LEAD_MS,
                true,
                false,
                true,
                9.0,
            );
            let removed = |run: &Run| run.echo_db - run.residual_db;
            eprintln!(
                "echo {delay} ms late at -10 dB: {:.1} dB taken out with a {DEFAULT_LEAD_MS} ms lead, {:.1} dB with the lead at {} ms (delay measured: {:?} ms); the user at {:.1} dBFS, {:.1} dBFS out while both talk",
                removed(&fixed),
                removed(&aligned),
                aligned.lead_ms,
                aligned.delay_ms,
                aligned.near_db,
                aligned.near_after_db,
            );
            assert!(
                removed(&fixed) < 12.0,
                "{:.1} dB taken out at {delay} ms with a fixed lead",
                removed(&fixed)
            );
            let measured = aligned.delay_ms.expect("no delay measured");
            assert!(
                measured.abs_diff(delay) <= 30,
                "{measured} ms measured for {delay} ms"
            );
            assert!(
                removed(&aligned) > 20.0,
                "only {:.1} dB taken out at {delay} ms, the lead at {} ms",
                removed(&aligned),
                aligned.lead_ms
            );
            assert!(
                aligned.near_after_db > aligned.near_db - 10.0,
                "the user went from {:.1} to {:.1} dBFS",
                aligned.near_db,
                aligned.near_after_db
            );
            // The report counts the echo, not the user talking over it.
            let report = aligned.reports.last().expect("no report");
            assert_eq!(report.delay_ms, Some(measured));
            assert!(report.double_talk_seconds > 0.0, "{report}");
            assert!(report.removed_db > 10.0, "{report}");
        }
    }

    /// The Roamgate app's microphone on the loudspeaker (2026-11-21): the
    /// phone's own echo canceller took the replies out, it is digital
    /// silence while they play (-88.9 dBFS) and only the user is heard in
    /// it, so no delay was ever measured and AEC3 worked on the user alone.
    /// It goes through untouched; once the echo comes in it again (the
    /// phone's canceller let go), back through AEC3, its delay measured.
    #[test]
    fn passes_a_microphone_whose_echo_the_phone_took_out() {
        let rate = RATE as usize;
        let seconds = 26.0;
        let far = speech(seconds, 210.0, 1);
        let user = speech(seconds, 120.0, 2);
        let mut noise = Noise(5);
        // The phone's silence: a sample or two of noise.
        let mut near: Vec<f64> = (0..far.len())
            .map(|_| 3.0 / 32768.0 * noise.next())
            .collect();
        // The user talks over the replies from 6 to 9 s.
        for i in 6 * rate..9 * rate {
            near[i] += user[i] * 0.5;
        }
        // From 12 s on, the echo comes in, 300 ms late at -10 dB.
        let echo_from = 12 * rate;
        let delay = 300 * rate / 1000;
        let roomed = convolve(&far, &room());
        for i in echo_from..near.len() {
            near[i] += roomed[i - delay] * 10f64.powf(-0.5) + 0.0005 * noise.next();
        }
        let (out, events, _) = drive(&far, &near, DEFAULT_LEAD_MS, true);
        let taken_out = events
            .iter()
            .position(|e| {
                matches!(
                    e,
                    Event::Upstream {
                        taken_out: true,
                        ..
                    }
                )
            })
            .expect("the echo taken out before was not told");
        let heard = events
            .iter()
            .position(|e| {
                matches!(
                    e,
                    Event::Upstream {
                        taken_out: false,
                        ..
                    }
                )
            })
            .expect("the echo coming in again was not told");
        assert!(taken_out < heard);
        // No delay while there is no echo; one once it comes in.
        let first_delay = events
            .iter()
            .position(|e| matches!(e, Event::Delay { .. }))
            .expect("no delay measured once the echo came");
        assert!(first_delay > taken_out);
        let measured = events
            .iter()
            .rev()
            .find_map(|e| match e {
                Event::Delay { delay_ms, .. } => Some(*delay_ms),
                _ => None,
            })
            .unwrap();
        assert!(measured.abs_diff(300) <= 30, "{measured} ms measured");
        // The user, from 5 to 11 s, came out exactly as they went in.
        let to_s16 = |samples: &[f64]| from_s16(&s16(samples));
        assert_eq!(
            out[5 * rate..11 * rate],
            to_s16(&near[5 * rate..11 * rate])[..]
        );
        // The reports said so: the echo was not heard, the user was.
        let passed = events
            .iter()
            .filter_map(|e| match e {
                Event::Report(r) if r.passthrough => Some(*r),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            !passed.is_empty(),
            "no report of the microphone passed through"
        );
        assert!(passed.iter().all(|r| r.before_db < -80.0), "{passed:?}");
        assert!(
            passed.iter().map(|r| r.double_talk_seconds).sum::<f64>() > 2.0,
            "{passed:?}"
        );
        // The echo, once back through AEC3, is taken out (the last 4 s).
        let from = out.len().min(near.len()) - 4 * rate;
        let to = out.len().min(near.len());
        let echo: Vec<f64> = (from..to)
            .map(|i| roomed[i - delay] * 10f64.powf(-0.5))
            .collect();
        let removed = db(mean_square(&echo)) - db(mean_square(&out[from..to]));
        assert!(removed > 15.0, "only {removed:.1} dB taken out");
    }

    /// An echo within AEC3's reach from the lead leaves the lead alone.
    #[test]
    fn keeps_a_lead_in_reach() {
        let run = run_with(
            &speech(12.0, 210.0, 1),
            &speech(12.0, 120.0, 2),
            300,
            -10.0,
            DEFAULT_LEAD_MS,
            false,
            false,
            true,
            2.0,
        );
        assert_eq!(run.lead_ms, DEFAULT_LEAD_MS);
        assert!(!run.passthrough);
        let measured = run.delay_ms.expect("no delay measured");
        assert!(measured.abs_diff(300) <= 30, "{measured} ms measured");
        assert!(run.echo_db - run.residual_db > 20.0);
    }

    /// A far end that comes too late (the lead past the round trip) moves
    /// back.
    #[test]
    fn moves_a_lead_back() {
        let run = run_with(
            &speech(16.0, 210.0, 1),
            &speech(16.0, 120.0, 2),
            150,
            -10.0,
            400,
            false,
            false,
            true,
            8.0,
        );
        assert_eq!(run.lead_ms, 0);
        assert!(
            run.echo_db - run.residual_db > 20.0,
            "{:.1} dB taken out",
            run.echo_db - run.residual_db
        );
    }

    #[test]
    fn reports_say_what_was_taken_out() {
        let report = Report {
            seconds: 3.24,
            before_db: -31.0,
            after_db: -52.3,
            removed_db: 21.3,
            double_talk_seconds: 0.0,
            delay_ms: None,
            passthrough: false,
        };
        assert_eq!(
            report.to_string(),
            "over 3.2 s of the replies' echo (its delay not measured), the microphone at -31.0 dBFS, -52.3 dBFS once cancelled (21.3 dB taken out of a 10 ms frame, the median)"
        );
        let report = Report {
            double_talk_seconds: 1.5,
            delay_ms: Some(640),
            ..report
        };
        assert_eq!(
            report.to_string(),
            "over 3.2 s of the replies' echo (640 ms late), the microphone at -31.0 dBFS, -52.3 dBFS once cancelled (21.3 dB taken out of a 10 ms frame, the median); 1.5 s of the user talking over it left out"
        );
        assert_eq!(
            Event::Delay {
                delay_ms: 640,
                correlation: 0.71,
                lead_ms: 440,
                moved: true
            }
            .to_string(),
            "the echo comes 640 ms after the replies go out (correlation 0.71): the far end now leads by 440 ms, for AEC3 to find it"
        );
        let report = Report {
            seconds: 15.4,
            before_db: -88.9,
            after_db: -88.9,
            removed_db: 0.0,
            double_talk_seconds: 2.0,
            delay_ms: None,
            passthrough: true,
        };
        assert_eq!(
            report.to_string(),
            "over 15.4 s of the replies, the microphone heard none of their echo, at -88.9 dBFS (taken out before it came here), and went through untouched; 2.0 s of the user talking over them"
        );
        assert_eq!(
            Event::Upstream {
                taken_out: true,
                silent_share: 0.97,
                level_db: -88.9
            }
            .to_string(),
            "the microphone hears none of the replies while they play (silent in 97% of the frames their echo would come in, at -88.9 dBFS there): their echo is taken out before it comes here (the phone's own echo canceller), so there is no delay to measure; the microphone goes through untouched, without AEC3, its noise suppression or gain control"
        );
    }
}
