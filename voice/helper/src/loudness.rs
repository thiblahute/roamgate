//! The replies' level in a call: each sentence is brought to a target
//! loudness, and a limiter keeps its peaks under a ceiling.
//!
//! On a phone's own loudspeaker the call is played on the voice call stream,
//! quieter than media, so the replies have to come loud enough: the TTS
//! models make speech at -20 to -24 LUFS (Kokoro, Qwen3-TTS), and broadcast
//! speech sits at -16.
//!
//! A sentence goes to the call as it is made, so its own loudness is only
//! known at its end. Each sentence is measured (ITU-R BS.1770: K-weighted,
//! gated 400 ms blocks), and the next one read by the same voice in the same
//! language gets the gain that brings that voice to the target (`Voices`);
//! a voice not heard yet starts from `ASSUMED_LUFS`. The gain is constant
//! within a sentence, so nothing pumps.
//!
//! The limiter looks 2 ms ahead: the gain each sample needs under the
//! ceiling, its minimum over the samples ahead, recovering over `RELEASE_S`,
//! then averaged over the look-ahead, so the gain glides down before a peak
//! and never lets one through. Its ceiling is the true peak asked for less
//! `INTERSAMPLE_DB`, the room left for peaks between samples and for the
//! Opus encoder's overshoot.

use std::collections::HashMap;

pub const RATE: f64 = 48_000.0;
/// What a voice not measured yet is taken to make: Qwen3-TTS's level.
pub const ASSUMED_LUFS: f64 = -24.0;
/// The most a sentence is raised or lowered.
pub const MAX_GAIN_DB: f64 = 18.0;
pub const MIN_GAIN_DB: f64 = -12.0;
/// How much a new measure moves a voice's level (the rest is what was known).
const LEARN: f64 = 0.5;
/// A sentence with less speech than this (gated blocks of 100 ms) is not
/// learnt from: a word or two says little of the voice.
const MIN_BLOCKS: usize = 8;
const LOOKAHEAD: usize = 96;
const RELEASE_S: f64 = 0.08;
pub const INTERSAMPLE_DB: f64 = 0.5;

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// A biquad, direct form I.
#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    const fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self {
            b,
            a,
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// BS.1770's K-weighting at 48 kHz: the head's shelf, then a high-pass.
fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(
            [1.53512485958697, -2.69169618940638, 1.19839281085285],
            [-1.69065929318241, 0.73248077421585],
        ),
        Biquad::new([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621]),
    ]
}

/// Integrated loudness (LUFS) of interleaved audio, as it comes.
pub struct Meter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    /// The K-weighted energy of each whole 100 ms step, channels summed.
    steps: Vec<f64>,
    step: f64,
    in_step: usize,
}

const STEP_FRAMES: usize = (RATE as usize) / 10;

impl Meter {
    pub fn new(channels: usize) -> Self {
        Self {
            channels,
            filters: vec![k_weighting(); channels],
            steps: Vec::new(),
            step: 0.0,
            in_step: 0,
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for frame in samples.chunks_exact(self.channels) {
            for (sample, filters) in frame.iter().zip(self.filters.iter_mut()) {
                let shelved = filters[0].run(*sample as f64);
                let y = filters[1].run(shelved);
                self.step += y * y;
            }
            self.in_step += 1;
            if self.in_step == STEP_FRAMES {
                self.steps.push(self.step);
                self.step = 0.0;
                self.in_step = 0;
            }
        }
    }

    /// The loudness and the number of blocks counted, once gated; None for
    /// silence or less than a block.
    pub fn integrated(&self) -> Option<(f64, usize)> {
        let block_frames = 4.0 * STEP_FRAMES as f64;
        let blocks: Vec<f64> = self
            .steps
            .windows(4)
            .map(|w| w.iter().sum::<f64>() / block_frames)
            .collect();
        let lufs = |power: f64| -0.691 + 10.0 * power.log10();
        let mean = |blocks: &[f64]| blocks.iter().sum::<f64>() / blocks.len() as f64;
        let loud: Vec<f64> = blocks.into_iter().filter(|&p| lufs(p) > -70.0).collect();
        if loud.is_empty() {
            return None;
        }
        let gate = lufs(mean(&loud)) - 10.0;
        let kept: Vec<f64> = loud.into_iter().filter(|&p| lufs(p) > gate).collect();
        Some((lufs(mean(&kept)), kept.len()))
    }
}

/// A look-ahead peak limiter on interleaved audio, channels linked; the
/// output comes LOOKAHEAD frames late, and `flush` gives the rest: as
/// many frames out as went in.
pub struct Limiter {
    channels: usize,
    ceiling: f64,
    release: f64,
    /// The frames not given out yet, and the gain each needs.
    frames: std::collections::VecDeque<(Vec<f32>, f64)>,
    held: f64,
    /// The last LOOKAHEAD held gains, and their sum.
    smooth: std::collections::VecDeque<f64>,
    sum: f64,
}

impl Limiter {
    /// `ceiling_db`: the highest a sample may be, in dBFS.
    pub fn new(channels: usize, ceiling_db: f64) -> Self {
        Self {
            channels,
            ceiling: db_to_gain(ceiling_db),
            release: 1.0 - (-1.0 / (RELEASE_S * RATE)).exp(),
            frames: Default::default(),
            held: 1.0,
            smooth: std::iter::repeat_n(1.0, LOOKAHEAD).collect(),
            sum: LOOKAHEAD as f64,
        }
    }

    pub fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        for frame in samples.chunks_exact(self.channels) {
            self.frame(frame.to_vec(), out);
        }
    }

    fn frame(&mut self, frame: Vec<f32>, out: &mut Vec<f32>) {
        let peak = frame.iter().fold(0f64, |m, s| m.max(s.abs() as f64));
        let needed = if peak > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };
        self.frames.push_back((frame, needed));
        if self.frames.len() <= LOOKAHEAD {
            return;
        }
        // The oldest frame goes out: the least gain any frame up to
        // LOOKAHEAD ahead of it needs, or the release's.
        let least = self.frames.iter().fold(1f64, |m, (_, g)| m.min(*g));
        self.held = least.min(self.held + (1.0 - self.held) * self.release);
        self.sum += self.held - self.smooth.pop_front().unwrap_or(1.0);
        self.smooth.push_back(self.held);
        let gain = (self.sum / LOOKAHEAD as f64) as f32;
        let (frame, _) = self.frames.pop_front().unwrap();
        out.extend(frame.iter().map(|s| s * gain));
    }

    /// The frames still held, given out after silence.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        let silence = vec![0f32; self.channels];
        for _ in 0..LOOKAHEAD {
            self.frame(silence.clone(), out);
        }
    }
}

/// One sentence's level: its gain, its limiter, and what it measures.
pub struct Level {
    gain: f32,
    pub gain_db: f64,
    meter: Meter,
    limiter: Limiter,
}

impl Level {
    pub fn new(channels: usize, gain_db: f64, peak_dbtp: f64) -> Self {
        Self {
            gain: db_to_gain(gain_db) as f32,
            gain_db,
            meter: Meter::new(channels),
            limiter: Limiter::new(channels, peak_dbtp - INTERSAMPLE_DB),
        }
    }

    /// The sentence as made in, as heard out.
    pub fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        self.meter.push(samples);
        let raised: Vec<f32> = samples.iter().map(|s| s * self.gain).collect();
        let mut out = Vec::with_capacity(raised.len());
        self.limiter.push(&raised, &mut out);
        out
    }

    /// The end of the sentence's audio, and its loudness as made.
    pub fn finish(&mut self) -> (Vec<f32>, Option<(f64, usize)>) {
        let mut out = Vec::new();
        self.limiter.flush(&mut out);
        (out, self.meter.integrated())
    }
}

/// What each voice makes, learnt sentence after sentence, to bring them all
/// to `target` LUFS.
pub struct Voices {
    pub target: f64,
    pub peak: f64,
    made: HashMap<String, f64>,
}

impl Voices {
    pub fn new(target: f64, peak: f64) -> Self {
        Self {
            target,
            peak,
            made: HashMap::new(),
        }
    }

    /// The gain for `voice`'s next sentence, in dB.
    pub fn gain_db(&self, voice: &str) -> f64 {
        let made = self.made.get(voice).copied().unwrap_or(ASSUMED_LUFS);
        (self.target - made).clamp(MIN_GAIN_DB, MAX_GAIN_DB)
    }

    /// `voice` made a sentence at `lufs` over `blocks` gated blocks.
    pub fn learn(&mut self, voice: &str, lufs: f64, blocks: usize) {
        if blocks < MIN_BLOCKS || !lufs.is_finite() {
            return;
        }
        self.made
            .entry(voice.to_string())
            .and_modify(|made| *made += LEARN * (lufs - *made))
            .or_insert(lufs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `seconds` of a `freq` Hz sine at `db` dBFS, the same on both channels.
    fn sine(freq: f64, db: f64, seconds: f64) -> Vec<f32> {
        let amplitude = db_to_gain(db);
        (0..(seconds * RATE) as usize)
            .flat_map(|n| {
                let s = (amplitude * (2.0 * std::f64::consts::PI * freq * n as f64 / RATE).sin())
                    as f32;
                [s, s]
            })
            .collect()
    }

    #[test]
    fn a_sine_at_1_khz_measures_as_bs1770_says() {
        // A 0 dBFS 1 kHz sine on one channel is -3.01 LUFS; on two, 0.
        let mut meter = Meter::new(2);
        meter.push(&sine(1000.0, -20.0, 3.0));
        let (lufs, _) = meter.integrated().unwrap();
        assert!((lufs - -20.0).abs() < 0.1, "{lufs}");
    }

    #[test]
    fn silence_has_no_loudness_and_pauses_are_gated_out() {
        let mut meter = Meter::new(2);
        meter.push(&vec![0.0; 2 * 48_000]);
        assert!(meter.integrated().is_none());
        meter.push(&sine(1000.0, -23.0, 10.0));
        meter.push(&vec![0.0; 4 * 48_000]);
        let (lufs, _) = meter.integrated().unwrap();
        assert!((lufs - -23.0).abs() < 0.3, "{lufs}");
    }

    #[test]
    fn the_limiter_keeps_every_sample_under_its_ceiling() {
        let mut limiter = Limiter::new(2, -1.5);
        let mut input = sine(220.0, -12.0, 0.5);
        // Clicks well over the ceiling, alone and in a burst.
        input[2 * 4000] = 1.6;
        for s in &mut input[2 * 9000..2 * 9200] {
            *s *= 6.0;
        }
        let mut out = Vec::new();
        for chunk in input.chunks(2 * 333) {
            limiter.push(chunk, &mut out);
        }
        limiter.flush(&mut out);
        assert_eq!(out.len(), input.len());
        let ceiling = db_to_gain(-1.5) as f32 + 1e-6;
        assert!(out.iter().all(|s| s.abs() <= ceiling));
        // Untouched before the first peak.
        assert!((out[2 * 2000] - input[2 * 2000]).abs() < 1e-6);
    }

    #[test]
    fn a_sentence_comes_at_its_gain_and_tells_its_level_as_made() {
        let mut level = Level::new(2, 6.0, -1.0);
        let input = sine(1000.0, -30.0, 2.0);
        let mut out = level.push(&input);
        let (tail, made) = level.finish();
        out.extend(tail);
        let (made, blocks) = made.unwrap();
        assert!((made - -30.0).abs() < 0.1, "{made}");
        assert!(blocks >= 16);
        let mut heard = Meter::new(2);
        heard.push(&out);
        let (lufs, _) = heard.integrated().unwrap();
        assert!((lufs - -24.0).abs() < 0.1, "{lufs}");
    }

    #[test]
    fn voices_learn_their_level_and_get_the_gain_to_the_target() {
        let mut voices = Voices::new(-16.0, -1.0);
        assert_eq!(voices.gain_db("qwen|fr"), 8.0);
        voices.learn("kokoro|hi", -20.0, 30);
        assert_eq!(voices.gain_db("kokoro|hi"), 4.0);
        voices.learn("kokoro|hi", -22.0, 30);
        assert_eq!(voices.gain_db("kokoro|hi"), 5.0);
        // A word is not learnt from; the gain stays within its bounds.
        voices.learn("qwen|fr", -40.0, 3);
        assert_eq!(voices.gain_db("qwen|fr"), 8.0);
        voices.learn("whisper|en", -60.0, 30);
        assert_eq!(voices.gain_db("whisper|en"), MAX_GAIN_DB);
    }
}
