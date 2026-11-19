//! Who speaks on a call: each utterance the transcriber hears is cut into
//! stretches of voice (1.5 s at most), a speaker-embedding model
//! (WeSpeaker ResNet34, ONNX: `--speaker-model`) turns each into a voice
//! print, and the prints are grouped, as the call goes, into the voices
//! heard: A, B, C... A stretch close enough to a voice joins it and, when
//! sure, moves its print; one close to none starts a new voice; two voices
//! whose prints come close are one, the older name kept.
//!
//! Nothing here knows which voice is the user's: the server learns it from
//! the conversation (which voice answers the companion, gives it work, or
//! says its name) and says it back with each `listen_start`
//! (`user_voice`). Each final carries what this module made of its
//! utterance (`voice`): the voice most heard in it and its share, whether
//! two voices were heard in it (`mixed`: in turn, or over each other), and
//! how close the utterance is to each voice known. The voices are
//! forgotten with each new speaker (a new call): nothing is kept across
//! calls.
//!
//! The embedding is speechgate's (its speaker check), done again here on
//! what the gate lets through, so the gate need not keep one voice.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use ort::session::Session;
use ort::value::Tensor;
use serde_json::{Map, Value, json};

pub const RATE: usize = 16_000;

const FRAME: usize = 400;
const SHIFT: usize = 160;
const PADDED: usize = 512;
const BANDS: usize = 80;
const LOW_HZ: f32 = 20.0;
const PREEMPHASIS: f32 = 0.97;

fn mel(hz: f32) -> f32 {
    1127.0 * (1.0 + hz / 700.0).ln()
}

/// Kaldi's filterbank (kaldi-native-fbank's defaults, without dither), as
/// WeSpeaker's models take it: 80 mel bands of 25 ms frames every 10 ms.
struct Fbank {
    window: Vec<f32>,
    /// Each band's weight on each FFT bin it covers: (first bin, weights).
    bands: Vec<(usize, Vec<f32>)>,
    fft: Arc<dyn realfft::RealToComplex<f32>>,
}

impl Default for Fbank {
    fn default() -> Self {
        // Povey's window: a Hann window raised to 0.85.
        let window = (0..FRAME)
            .map(|i| {
                let hann =
                    0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FRAME - 1) as f32).cos();
                hann.powf(0.85)
            })
            .collect();
        let (low, high) = (mel(LOW_HZ), mel(RATE as f32 / 2.0));
        let step = (high - low) / (BANDS + 1) as f32;
        let bin_hz = RATE as f32 / PADDED as f32;
        let bands = (0..BANDS)
            .map(|band| {
                let left = low + band as f32 * step;
                let center = left + step;
                let right = center + step;
                let mut first = None;
                let mut weights = Vec::new();
                for bin in 0..PADDED / 2 {
                    let m = mel(bin as f32 * bin_hz);
                    if m > left && m < right {
                        first.get_or_insert(bin);
                        weights.push(if m <= center {
                            (m - left) / (center - left)
                        } else {
                            (right - m) / (right - center)
                        });
                    } else if first.is_some() {
                        break;
                    }
                }
                (first.unwrap_or(0), weights)
            })
            .collect();
        Self {
            window,
            bands,
            fft: realfft::RealFftPlanner::<f32>::new().plan_fft_forward(PADDED),
        }
    }
}

impl Fbank {
    /// One row of 80 log energies per frame, for 16-bit scale samples.
    fn features(&self, samples: &[f32]) -> Vec<[f32; BANDS]> {
        if samples.len() < FRAME {
            return Vec::new();
        }
        let frames = 1 + (samples.len() - FRAME) / SHIFT;
        let mut rows = Vec::with_capacity(frames);
        let mut input = self.fft.make_input_vec();
        let mut spectrum = self.fft.make_output_vec();
        for frame in 0..frames {
            let mut x: Vec<f32> = samples[frame * SHIFT..frame * SHIFT + FRAME].to_vec();
            let mean = x.iter().sum::<f32>() / FRAME as f32;
            x.iter_mut().for_each(|s| *s -= mean);
            for i in (1..FRAME).rev() {
                x[i] -= PREEMPHASIS * x[i - 1];
            }
            x[0] -= PREEMPHASIS * x[0];
            for (slot, (sample, weight)) in input.iter_mut().zip(x.iter().zip(&self.window)) {
                *slot = sample * weight;
            }
            input[FRAME..].fill(0.0);
            if self.fft.process(&mut input, &mut spectrum).is_err() {
                continue;
            }
            let power: Vec<f32> = spectrum[..PADDED / 2]
                .iter()
                .map(|c| c.norm_sqr())
                .collect();
            let mut row = [0f32; BANDS];
            for (value, (first, weights)) in row.iter_mut().zip(&self.bands) {
                let energy: f32 = weights
                    .iter()
                    .zip(&power[*first..])
                    .map(|(w, p)| w * p)
                    .sum();
                *value = energy.max(f32::EPSILON).ln();
            }
            rows.push(row);
        }
        rows
    }
}

/// The speaker-embedding model.
pub struct Embedder {
    session: Session,
    fbank: Fbank,
}

impl Embedder {
    pub fn load(model: &str) -> Result<Self, String> {
        let session = Session::builder()
            .and_then(|mut builder| builder.commit_from_file(model))
            .map_err(|e| format!("{model}: {e}"))?;
        Ok(Self {
            session,
            fbank: Fbank::default(),
        })
    }

    /// The voice print of 16 kHz samples in [-1, 1], of unit length; None
    /// when too short to tell.
    pub fn embed(&mut self, samples: &[f32]) -> Result<Option<Vec<f32>>, String> {
        let scaled: Vec<f32> = samples.iter().map(|s| s * 32768.0).collect();
        let mut rows = self.fbank.features(&scaled);
        if rows.len() < 20 {
            return Ok(None);
        }
        let count = rows.len() as f32;
        for band in 0..BANDS {
            let mean = rows.iter().map(|r| r[band]).sum::<f32>() / count;
            rows.iter_mut().for_each(|r| r[band] -= mean);
        }
        let frames = rows.len();
        let feats: Vec<f32> = rows.into_iter().flatten().collect();
        let input =
            Tensor::from_array(([1usize, frames, BANDS], feats)).map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs!["feats" => input])
            .map_err(|e| e.to_string())?;
        let (_, embedding) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        Ok(Some(unit(embedding.to_vec())))
    }
}

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v
        .iter()
        .map(|x| x * x)
        .sum::<f32>()
        .sqrt()
        .max(f32::EPSILON);
    v.iter_mut().for_each(|x| *x /= norm);
    v
}

pub fn similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// A stretch this close to no voice known is a new voice. Measured on
/// recordings of three people (real_voices_are_told_apart): a person's
/// stretches of 1.5 s scored 0.45 to 0.78 against their voice's print, a
/// stretch against another stretch of theirs as low as 0.18 at 1 s; other
/// people's -0.15 to 0.18 (one 0.33 for half a second).
const NEW_VOICE: f32 = 0.22;
/// Only stretches this close to their voice, and SURE_SECONDS long, move
/// its print: a stretch with two voices over each other scores lower
/// against both, and would drag one towards the other.
const MOVES_VOICE: f32 = 0.35;
/// Shorter stretches tell little (a lone word can score around 0 against
/// its own voice): they never make or move a voice, only count for the one
/// they are closest to.
const SURE_SECONDS: f32 = 0.6;
/// Two voices whose prints are this close are one person's: the second
/// was made from stretches that scored low against the first (another
/// room, the loudspeaker).
const SAME_VOICE: f32 = 0.50;
/// A sure stretch close to two voices at once, neither surely, holds both
/// over each other.
const OVERLAP_SECOND: f32 = 0.22;
const OVERLAP_BEST: f32 = 0.50;
/// A voice's print is the mean of at most this many seconds of its
/// stretches, the newest counting more: it follows the voice as it moves.
const KEPT_SECONDS: f32 = 20.0;
/// Voices kept at most; past that, the least heard goes.
const MAX_VOICES: usize = 8;
/// An utterance is mixed when a second voice has this share of its voice,
/// or this share of its stretches held two voices over each other.
const MIXED_SHARE: f32 = 0.25;
/// Under this, an utterance's voice is too unsure to name.
const KNOWN: f32 = 0.10;

/// The name of the `n`th voice: A to Z, then AA, AB...
fn name(n: usize) -> String {
    let letter = |i: usize| char::from(b'A' + (i % 26) as u8);
    if n < 26 {
        letter(n).to_string()
    } else {
        format!("{}{}", letter(n / 26 - 1), letter(n))
    }
}

struct Voice {
    name: String,
    print: Vec<f32>,
    /// Seconds of sure stretches in its print, at most KEPT_SECONDS.
    weight: f32,
    /// Seconds heard in all.
    heard: f32,
}

/// A stretch of voice, as placed among the voices.
#[derive(Clone, Debug)]
pub struct Stretch {
    pub seconds: f32,
    /// The voice it went to, if any (none known yet, for a short one).
    pub voice: Option<String>,
    /// How close it is to each voice known, as it was placed.
    pub scores: Vec<(String, f32)>,
    /// Two voices over each other.
    pub overlapped: bool,
    embedding: Vec<f32>,
}

#[cfg(test)]
impl Stretch {
    /// A stretch placed in `voice`, with its scores.
    pub fn heard(voice: &str, scores: &[(&str, f32)], seconds: f32) -> Self {
        Self {
            seconds,
            voice: Some(voice.to_string()),
            scores: scores.iter().map(|(n, s)| (n.to_string(), *s)).collect(),
            overlapped: false,
            embedding: Vec::new(),
        }
    }
}

/// What an utterance was, voice wise.
#[derive(Clone, Debug, PartialEq)]
pub struct Summary {
    /// The set of voices its names belong to (a new one each call).
    pub voices: u64,
    /// The voice most heard in it, if one is known well enough.
    pub voice: Option<String>,
    /// That voice's share of its voice (seconds).
    pub share: f32,
    pub mixed: bool,
    /// Each voice heard in it and its share, the most heard first.
    pub mix: Vec<(String, f32)>,
    /// How close the whole utterance is to each voice known.
    pub similarity: Vec<(String, f32)>,
    /// Voices found to be one since the last summary: (gone, kept).
    pub merged: Vec<(String, String)>,
    pub seconds: f32,
}

impl Summary {
    pub fn to_json(&self) -> Value {
        let round = |v: f32| (f64::from(v) * 100.0).round() / 100.0;
        let mut similarity = Map::new();
        for (name, score) in &self.similarity {
            similarity.insert(name.clone(), json!(round(*score)));
        }
        let mut merged = Map::new();
        for (gone, kept) in &self.merged {
            merged.insert(gone.clone(), json!(kept));
        }
        let mut value = json!({
            "voices": self.voices,
            "id": self.voice,
            "share": round(self.share),
            "mixed": self.mixed,
            "mix": self.mix.iter().map(|(name, share)| json!({"id": name, "share": round(*share)})).collect::<Vec<_>>(),
            "similarity": similarity,
            "seconds": round(self.seconds),
        });
        if !merged.is_empty() {
            value["merged"] = Value::Object(merged);
        }
        value
    }

    /// One log line: the voice, its share, the scores.
    pub fn describe(&self) -> String {
        let scores = self
            .similarity
            .iter()
            .map(|(name, score)| format!("{name} {score:.2}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mix = self
            .mix
            .iter()
            .map(|(name, share)| format!("{name} {:.0}%", share * 100.0))
            .collect::<Vec<_>>()
            .join(" + ");
        format!(
            "voice {} ({:.0}%{}) in {:.1} s of voice [{mix}], similarity: {scores}",
            self.voice.as_deref().unwrap_or("unknown"),
            self.share * 100.0,
            if self.mixed { ", mixed" } else { "" },
            self.seconds,
        )
    }
}

/// The voices heard on a call, and the utterance being heard.
pub struct Voices {
    set: u64,
    voices: Vec<Voice>,
    made: usize,
    stretches: Vec<Stretch>,
    merged: Vec<(String, String)>,
}

impl Voices {
    pub fn new(set: u64) -> Self {
        Self {
            set,
            voices: Vec::new(),
            made: 0,
            stretches: Vec::new(),
            merged: Vec::new(),
        }
    }

    pub fn set(&self) -> u64 {
        self.set
    }

    fn scores(&self, embedding: &[f32]) -> Vec<(String, f32)> {
        self.voices
            .iter()
            .map(|voice| (voice.name.clone(), similarity(&voice.print, embedding)))
            .collect()
    }

    /// Places a stretch of `seconds` of voice with its print: in the voice
    /// it is close to, or a new one.
    pub fn place(&mut self, embedding: Vec<f32>, seconds: f32) -> Stretch {
        let scores = self.scores(&embedding);
        let mut ranked: Vec<(usize, f32)> = scores
            .iter()
            .enumerate()
            .map(|(i, (_, score))| (i, *score))
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let best = ranked.first().copied();
        let second = ranked.get(1).map_or(f32::MIN, |r| r.1);
        let sure = seconds >= SURE_SECONDS;
        let overlapped =
            sure && best.is_some_and(|(_, score)| score < OVERLAP_BEST) && second >= OVERLAP_SECOND;
        let voice = match best {
            Some((i, score)) if score >= NEW_VOICE || !sure => {
                if sure && score >= MOVES_VOICE && !overlapped {
                    self.move_print(i, &embedding, seconds);
                }
                self.voices[i].heard += seconds;
                Some(self.voices[i].name.clone())
            }
            _ if sure => Some(self.add(&embedding, seconds)),
            _ => None,
        };
        let stretch = Stretch {
            seconds,
            voice,
            scores,
            overlapped,
            embedding,
        };
        self.stretches.push(stretch.clone());
        self.merge();
        stretch
    }

    fn move_print(&mut self, i: usize, embedding: &[f32], seconds: f32) {
        let voice = &mut self.voices[i];
        let kept = voice.weight.min(KEPT_SECONDS - seconds).max(0.0);
        let print: Vec<f32> = voice
            .print
            .iter()
            .zip(embedding)
            .map(|(p, e)| p * kept + e * seconds)
            .collect();
        voice.print = unit(print);
        voice.weight = (kept + seconds).min(KEPT_SECONDS);
    }

    fn add(&mut self, embedding: &[f32], seconds: f32) -> String {
        if self.voices.len() >= MAX_VOICES
            && let Some((least, _)) = self
                .voices
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.heard.total_cmp(&b.1.heard))
        {
            self.voices.remove(least);
        }
        let name = name(self.made);
        self.made += 1;
        self.voices.push(Voice {
            name: name.clone(),
            print: embedding.to_vec(),
            weight: seconds,
            heard: seconds,
        });
        name
    }

    /// Voices that came close are one, under the older name.
    fn merge(&mut self) {
        loop {
            let mut pair = None;
            'search: for i in 0..self.voices.len() {
                for j in i + 1..self.voices.len() {
                    if similarity(&self.voices[i].print, &self.voices[j].print) >= SAME_VOICE {
                        pair = Some((i, j));
                        break 'search;
                    }
                }
            }
            let Some((kept, gone)) = pair else { return };
            let gone = self.voices.remove(gone);
            let voice = &mut self.voices[kept];
            let total = (voice.weight + gone.weight).max(f32::EPSILON);
            voice.print = unit(
                voice
                    .print
                    .iter()
                    .zip(&gone.print)
                    .map(|(a, b)| a * voice.weight / total + b * gone.weight / total)
                    .collect(),
            );
            voice.weight = total.min(KEPT_SECONDS);
            voice.heard += gone.heard;
            let kept_name = voice.name.clone();
            for stretch in &mut self.stretches {
                if stretch.voice.as_deref() == Some(gone.name.as_str()) {
                    stretch.voice = Some(kept_name.clone());
                }
            }
            for (_, into) in &mut self.merged {
                if *into == gone.name {
                    *into = kept_name.clone();
                }
            }
            self.merged.push((gone.name, kept_name));
        }
    }

    /// The utterance is over: what it was; the next one starts.
    pub fn end(&mut self) -> Summary {
        let stretches = std::mem::take(&mut self.stretches);
        let merged = std::mem::take(&mut self.merged);
        let seconds: f32 = stretches.iter().map(|s| s.seconds).sum();
        let mut mix: Vec<(String, f32)> = Vec::new();
        for stretch in &stretches {
            if let Some(voice) = &stretch.voice {
                match mix.iter_mut().find(|(name, _)| name == voice) {
                    Some((_, heard)) => *heard += stretch.seconds,
                    None => mix.push((voice.clone(), stretch.seconds)),
                }
            }
        }
        if seconds > 0.0 {
            mix.iter_mut().for_each(|(_, heard)| *heard /= seconds);
        }
        mix.sort_by(|a, b| b.1.total_cmp(&a.1));
        // The whole utterance's print: its stretches' mean, by length.
        let mut whole = vec![0f32; stretches.first().map_or(0, |s| s.embedding.len())];
        for stretch in &stretches {
            for (w, e) in whole.iter_mut().zip(&stretch.embedding) {
                *w += e * stretch.seconds;
            }
        }
        let similarity = if stretches.is_empty() {
            Vec::new()
        } else {
            self.scores(&unit(whole))
        };
        let overlapped: f32 = stretches
            .iter()
            .filter(|s| s.overlapped)
            .map(|s| s.seconds)
            .sum();
        let mixed = mix.get(1).is_some_and(|(_, share)| *share >= MIXED_SHARE)
            || (seconds > 0.0 && overlapped / seconds >= MIXED_SHARE);
        let (voice, share) = match mix.first() {
            Some((name, share))
                if similarity
                    .iter()
                    .any(|(other, score)| other == name && *score >= KNOWN) =>
            {
                (Some(name.clone()), *share)
            }
            _ => (None, 0.0),
        };
        Summary {
            voices: self.set,
            voice,
            share,
            mixed,
            mix,
            similarity,
            merged,
            seconds,
        }
    }
}

/// Audio quieter than this (RMS of 20 ms, after the denoiser) is no voice.
const QUIET: f32 = 0.003;
const FRAME_SAMPLES: usize = RATE / 50;
/// A stretch ends after this much quiet, or this much voice.
const STRETCH_GAP_FRAMES: usize = 15;
/// (1.5 s: at 1 s, one person's stretches split into two voices more.)
const STRETCH_SAMPLES: usize = RATE * 3 / 2;
/// Shorter stretches are not placed at all (the model needs 0.2 s).
const MIN_STRETCH_SAMPLES: usize = RATE / 4;

/// Cuts what the transcriber hears into stretches of voice.
#[derive(Default)]
struct Cutter {
    /// Samples not yet a whole frame.
    partial: Vec<f32>,
    voice: Vec<f32>,
    quiet_frames: usize,
}

impl Cutter {
    /// The stretches `samples` completed.
    fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.partial.extend_from_slice(samples);
        let mut done = Vec::new();
        let frames = self.partial.len() / FRAME_SAMPLES;
        for f in 0..frames {
            let frame = &self.partial[f * FRAME_SAMPLES..(f + 1) * FRAME_SAMPLES];
            let rms = (frame.iter().map(|s| s * s).sum::<f32>() / FRAME_SAMPLES as f32).sqrt();
            if rms >= QUIET {
                self.quiet_frames = 0;
                self.voice.extend_from_slice(frame);
                if self.voice.len() >= STRETCH_SAMPLES {
                    done.push(std::mem::take(&mut self.voice));
                }
            } else {
                self.quiet_frames += 1;
                if self.quiet_frames == STRETCH_GAP_FRAMES && !self.voice.is_empty() {
                    let voice = std::mem::take(&mut self.voice);
                    if voice.len() >= MIN_STRETCH_SAMPLES {
                        done.push(voice);
                    }
                }
            }
        }
        self.partial.drain(..frames * FRAME_SAMPLES);
        done
    }

    /// The utterance is over: its last stretch, if long enough.
    fn end(&mut self) -> Option<Vec<f32>> {
        self.partial.clear();
        self.quiet_frames = 0;
        let voice = std::mem::take(&mut self.voice);
        (voice.len() >= MIN_STRETCH_SAMPLES).then_some(voice)
    }
}

enum Feed {
    Audio(Vec<f32>),
    End(u64),
    Reset(u64),
}

/// Told as each stretch is placed: the voice set and the stretch.
pub type OnStretch = Box<dyn Fn(u64, &Stretch) + Send>;

/// The summaries made, in the order the utterances ended.
type Done = Arc<(Mutex<VecDeque<(u64, Summary)>>, Condvar)>;

/// Places stretches on a thread of its own as the transcriber is fed, so
/// each utterance's voice is known as soon as it ends.
pub struct Tracker {
    feed: mpsc::Sender<Feed>,
    done: Done,
    /// Utterances ended (fed) and summaries taken (delivered).
    ended: AtomicU64,
    taken: AtomicU64,
}

fn new_set() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

impl Tracker {
    pub fn start(model: &str, on_stretch: OnStretch) -> Result<Self, String> {
        let mut embedder = Embedder::load(model)?;
        let (feed, fed) = mpsc::channel::<Feed>();
        let done: Done = Arc::default();
        let made = done.clone();
        let debug = std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some();
        std::thread::Builder::new()
            .name("voices".into())
            .spawn(move || {
                let mut voices = Voices::new(new_set());
                let mut cutter = Cutter::default();
                let mut place = |voices: &mut Voices, samples: Vec<f32>| {
                    let seconds = samples.len() as f32 / RATE as f32;
                    match embedder.embed(&samples) {
                        Ok(Some(embedding)) => {
                            let stretch = voices.place(embedding, seconds);
                            if debug {
                                let scores = stretch
                                    .scores
                                    .iter()
                                    .map(|(name, score)| format!("{name} {score:.2}"))
                                    .collect::<Vec<_>>()
                                    .join(", ");
                                eprintln!(
                                    "[voice] stretch of {seconds:.2} s: voice {}{} (scores: {})",
                                    stretch.voice.as_deref().unwrap_or("unknown"),
                                    if stretch.overlapped {
                                        ", two voices over each other"
                                    } else {
                                        ""
                                    },
                                    if scores.is_empty() {
                                        "none known"
                                    } else {
                                        &scores
                                    }
                                );
                            }
                            on_stretch(voices.set(), &stretch);
                        }
                        Ok(None) => {}
                        Err(error) => eprintln!("[voice] the voice print failed: {error}"),
                    }
                };
                for feed in fed {
                    match feed {
                        Feed::Audio(samples) => {
                            for stretch in cutter.push(&samples) {
                                place(&mut voices, stretch);
                            }
                        }
                        Feed::End(seq) => {
                            if let Some(stretch) = cutter.end() {
                                place(&mut voices, stretch);
                            }
                            let summary = voices.end();
                            let (queue, ready) = &*made;
                            queue.lock().unwrap().push_back((seq, summary));
                            ready.notify_all();
                        }
                        Feed::Reset(set) => {
                            cutter = Cutter::default();
                            voices = Voices::new(set);
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            feed,
            done,
            ended: AtomicU64::new(0),
            taken: AtomicU64::new(0),
        })
    }

    /// What the transcriber is fed (16 kHz mono).
    pub fn audio(&self, samples: Vec<f32>) {
        let _ = self.feed.send(Feed::Audio(samples));
    }

    /// The utterance fed is over (its SEGMENT_DONE reached the transcriber).
    pub fn end(&self) {
        let seq = self.ended.fetch_add(1, Ordering::SeqCst);
        let _ = self.feed.send(Feed::End(seq));
    }

    /// A new call: the voices known are forgotten.
    pub fn reset(&self) {
        let _ = self.feed.send(Feed::Reset(new_set()));
    }

    /// The next utterance's summary, once its text is out (its
    /// SEGMENT_DONE reached the end): None if it does not come in time.
    pub fn take(&self) -> Option<Summary> {
        let seq = self.taken.fetch_add(1, Ordering::SeqCst);
        // Its end reaches the transcriber before its text is out: none fed
        // means the two counts went apart (an utterance lost on the way).
        // They meet again; this one has no voice.
        let ended = self.ended.load(Ordering::SeqCst);
        if seq >= ended {
            self.taken.store(ended, Ordering::SeqCst);
            return None;
        }
        let (queue, ready) = &*self.done;
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let mut queue = queue.lock().unwrap();
        loop {
            while queue.front().is_some_and(|(at, _)| *at < seq) {
                queue.pop_front();
            }
            if queue.front().is_some_and(|(at, _)| *at == seq) {
                return queue.pop_front().map(|(_, summary)| summary);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                eprintln!("[voice] an utterance's voice did not come in time");
                return None;
            }
            queue = ready.wait_timeout(queue, deadline - now).unwrap().0;
        }
    }
}

/// Whether a stretch sounds like `user` (the voice named so in set `set`):
/// it went to that voice, or is close to it.
pub fn sounds_like(stretch: &Stretch, set: u64, user: &(u64, String)) -> bool {
    const CLOSE: f32 = 0.30;
    set == user.0
        && stretch.seconds >= 0.4
        && (stretch.voice.as_deref() == Some(user.1.as_str())
            || stretch
                .scores
                .iter()
                .any(|(name, score)| *name == user.1 && *score >= CLOSE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit vector near `base`, `noise` away, made from a seed.
    fn near(base: &[f32], noise: f32, seed: u32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 2.0 - 1.0
        };
        unit(base.iter().map(|b| b + noise * next()).collect())
    }

    /// One of a few voices that score about 0 against each other.
    fn voice(n: usize) -> Vec<f32> {
        let mut v = vec![0f32; 256];
        for (i, x) in v.iter_mut().enumerate() {
            *x = if i % 4 == n { 1.0 } else { 0.05 };
        }
        unit(v)
    }

    fn summary_of(voices: &mut Voices, stretches: &[(usize, u32, f32)]) -> Summary {
        for &(who, seed, seconds) in stretches {
            voices.place(near(&voice(who), 0.08, seed), seconds);
        }
        voices.end()
    }

    /// Two voices stay apart; each keeps its name across utterances.
    #[test]
    fn two_voices_stay_separate() {
        let mut voices = Voices::new(1);
        let first = summary_of(&mut voices, &[(0, 1, 1.0), (0, 2, 1.0), (0, 3, 0.8)]);
        assert_eq!(first.voice.as_deref(), Some("A"));
        assert!(!first.mixed);
        assert!((first.share - 1.0).abs() < 1e-6);
        let second = summary_of(&mut voices, &[(1, 4, 1.0), (1, 5, 1.0)]);
        assert_eq!(second.voice.as_deref(), Some("B"));
        let a = second.similarity.iter().find(|(n, _)| n == "A").unwrap().1;
        let b = second.similarity.iter().find(|(n, _)| n == "B").unwrap().1;
        assert!(b > 0.8 && a < 0.3, "A {a}, B {b}");
        // The first voice again, after the other: its own name.
        let third = summary_of(&mut voices, &[(0, 6, 1.0), (0, 7, 1.0)]);
        assert_eq!(third.voice.as_deref(), Some("A"));
        assert_eq!(voices.voices.len(), 2);
    }

    /// A voice coming back after others joins its own voice, not a new one.
    #[test]
    fn a_voice_coming_back_joins_its_voice() {
        let mut voices = Voices::new(1);
        summary_of(&mut voices, &[(0, 1, 1.0), (0, 2, 1.0)]);
        summary_of(&mut voices, &[(1, 3, 1.0)]);
        summary_of(&mut voices, &[(2, 4, 1.0)]);
        let back = summary_of(&mut voices, &[(1, 5, 1.0), (1, 6, 0.7)]);
        assert_eq!(back.voice.as_deref(), Some("B"));
        assert_eq!(voices.voices.len(), 3);
    }

    /// Two voices in turn in one utterance make it mixed, the most heard
    /// first; a short word of another does not.
    #[test]
    fn two_voices_in_one_utterance_are_mixed() {
        let mut voices = Voices::new(1);
        summary_of(&mut voices, &[(0, 1, 1.0)]);
        summary_of(&mut voices, &[(1, 2, 1.0)]);
        let both = summary_of(&mut voices, &[(0, 3, 1.0), (0, 4, 1.0), (1, 5, 1.0)]);
        assert!(both.mixed);
        assert_eq!(both.voice.as_deref(), Some("A"));
        let names: Vec<&str> = both.mix.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["A", "B"]);
        let one = summary_of(
            &mut voices,
            &[(0, 6, 1.0), (0, 7, 1.0), (0, 8, 1.0), (1, 9, 0.3)],
        );
        assert!(!one.mixed);
    }

    /// Two voices over each other: each stretch close to both, neither
    /// surely; the utterance is mixed, and neither print moves.
    #[test]
    fn voices_over_each_other_are_mixed() {
        let mut voices = Voices::new(1);
        summary_of(&mut voices, &[(0, 1, 1.0), (0, 2, 1.0)]);
        summary_of(&mut voices, &[(1, 3, 1.0), (1, 4, 1.0)]);
        let a_before = voices.voices[0].print.clone();
        // Both, over something else (the room, music): about as close to
        // each, neither surely.
        let blend: Vec<f32> = (0..256)
            .map(|i| voice(0)[i] + voice(1)[i] + 2.0 * voice(2)[i])
            .collect();
        for seed in 5..8 {
            let stretch = voices.place(near(&unit(blend.clone()), 0.02, seed), 1.0);
            assert!(stretch.overlapped, "{:?}", stretch.scores);
        }
        let summary = voices.end();
        assert!(summary.mixed);
        assert!(similarity(&a_before, &voices.voices[0].print) > 0.999);
    }

    /// Two voices made from the same person (their stretches scoring low at
    /// first) become one when their prints come close: the older name.
    #[test]
    fn close_voices_merge() {
        let mut voices = Voices::new(1);
        let a = voice(0);
        // A second print of the same person, too far to join the first.
        let b: Vec<f32> = unit(a.iter().zip(voice(1)).map(|(x, y)| 0.08 * x + y).collect());
        assert!(similarity(&a, &b) < NEW_VOICE);
        voices.place(a.clone(), 1.0);
        voices.place(b.clone(), 1.0);
        assert_eq!(voices.voices.len(), 2);
        // Their next stretches, closer to the second, move it to the first.
        let between: Vec<f32> = unit(a.iter().zip(&b).map(|(x, y)| 0.45 * x + 0.55 * y).collect());
        for seed in 2..12 {
            voices.place(near(&between, 0.02, seed), 1.0);
        }
        let summary = voices.end();
        assert_eq!(voices.voices.len(), 1);
        assert_eq!(summary.merged, vec![("B".to_string(), "A".to_string())]);
        assert_eq!(summary.voice.as_deref(), Some("A"));
    }

    /// Short stretches make no voice: an utterance of a lone word, first
    /// heard, has no voice named.
    #[test]
    fn short_stretches_make_no_voice() {
        let mut voices = Voices::new(1);
        let summary = summary_of(&mut voices, &[(0, 1, 0.4)]);
        assert_eq!(summary.voice, None);
        assert!(voices.voices.is_empty());
        summary_of(&mut voices, &[(0, 2, 1.0)]);
        let word = summary_of(&mut voices, &[(0, 3, 0.4)]);
        assert_eq!(word.voice.as_deref(), Some("A"));
    }

    /// The filterbank matches kaldi-native-fbank on the same chirp, as
    /// speechgate's does.
    #[test]
    fn features_match_kaldi() {
        let samples: Vec<f32> = (0..16_000)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                (0.3 * (2.0 * std::f32::consts::PI * (200.0 + 800.0 * t) * t).sin()
                    + 0.05 * (2.0 * std::f32::consts::PI * 3000.0 * t).sin())
                    * 32768.0
                    * 0.5
            })
            .collect();
        let rows = Fbank::default().features(&samples);
        assert_eq!(rows.len(), 98);
        let first = [
            13.237, 11.156, 12.597, 14.383, 16.145, 18.993, 20.51, 21.418, 20.698, 17.834,
        ];
        for (got, want) in rows[0].iter().zip(first) {
            assert!((got - want).abs() < 0.05, "{got} vs {want}");
        }
    }

    /// Real voices: SPEAKER_MODEL (WeSpeaker ResNet34) and VOICES_F32, the
    /// paths of recordings of different people (16 kHz mono f32, a few
    /// seconds each), comma separated. Each person's first half makes a
    /// voice; their second half, after the others, comes back to it; two
    /// of them over each other are mixed.
    #[test]
    #[ignore]
    fn real_voices_are_told_apart() {
        let mut embedder = Embedder::load(&std::env::var("SPEAKER_MODEL").unwrap()).unwrap();
        let people: Vec<Vec<f32>> = std::env::var("VOICES_F32")
            .unwrap()
            .split(',')
            .map(|path| {
                std::fs::read(path)
                    .unwrap()
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect()
            })
            .collect();
        let mut voices = Voices::new(1);
        let mut hear = |voices: &mut Voices, samples: &[f32]| {
            let mut cutter = Cutter::default();
            let mut stretches = cutter.push(samples);
            stretches.extend(cutter.end());
            for stretch in stretches {
                if let Some(embedding) = embedder.embed(&stretch).unwrap() {
                    let placed = voices.place(embedding, stretch.len() as f32 / RATE as f32);
                    println!(
                        "  {:.2} s: {:?} {:?}",
                        placed.seconds, placed.voice, placed.scores
                    );
                }
            }
            let summary = voices.end();
            println!("{}", summary.describe());
            summary
        };
        // The recordings' last fifth is left out: some end with the same
        // sound, which is a voice of its own here.
        let half = |person: &Vec<f32>, second: bool| {
            let (middle, end) = (person.len() * 2 / 5, person.len() * 4 / 5);
            if second {
                person[middle..end].to_vec()
            } else {
                person[..middle].to_vec()
            }
        };
        let names: Vec<String> = people
            .iter()
            .map(|person| hear(&mut voices, &half(person, false)).voice.unwrap())
            .collect();
        let distinct: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(distinct.len(), people.len(), "{names:?}");
        for (person, name) in people.iter().zip(&names) {
            let back = hear(&mut voices, &half(person, true));
            assert_eq!(back.voice.as_ref(), Some(name));
            assert!(!back.mixed);
        }
        let (a, b) = (half(&people[0], true), half(&people[1], true));
        let both: Vec<f32> = a.iter().zip(&b).map(|(x, y)| x + y).collect();
        let mixed = hear(&mut voices, &both);
        assert!(mixed.mixed, "{}", mixed.describe());
    }

    /// Voices past the 26th are named AA, AB...
    #[test]
    fn voices_are_named_in_order() {
        assert_eq!(name(0), "A");
        assert_eq!(name(25), "Z");
        assert_eq!(name(26), "AA");
        assert_eq!(name(27), "AB");
    }

    /// The cutter makes stretches of 1.5 s of voice at most, ends one at
    /// a pause, and drops what is too short.
    #[test]
    fn the_cutter_makes_stretches_of_voice() {
        let tone = |seconds: f32| -> Vec<f32> {
            (0..(seconds * RATE as f32) as usize)
                .map(|i| 0.2 * (i as f32 * 0.05).sin())
                .collect()
        };
        let quiet = |seconds: f32| vec![0f32; (seconds * RATE as f32) as usize];
        let mut cutter = Cutter::default();
        let mut stretches = cutter.push(&tone(2.0));
        stretches.extend(cutter.push(&quiet(0.4)));
        stretches.extend(cutter.push(&tone(0.1)));
        stretches.extend(cutter.push(&quiet(0.4)));
        stretches.extend(cutter.push(&tone(0.7)));
        let lengths: Vec<usize> = stretches.iter().map(Vec::len).collect();
        assert_eq!(lengths, [RATE * 3 / 2, RATE / 2]);
        assert_eq!(cutter.end().map(|s| s.len()), Some(RATE * 7 / 10));
    }

    /// Each utterance's summary is taken in order; one taken with no
    /// utterance fed has none, and the counts meet again.
    #[test]
    fn summaries_are_taken_in_order() {
        let done: Done = Arc::default();
        let (feed, _fed) = mpsc::channel();
        let tracker = Tracker {
            feed,
            done: done.clone(),
            ended: AtomicU64::new(0),
            taken: AtomicU64::new(0),
        };
        let summary = |seconds: f32| Summary {
            voices: 1,
            voice: None,
            share: 0.0,
            mixed: false,
            mix: Vec::new(),
            similarity: Vec::new(),
            merged: Vec::new(),
            seconds,
        };
        assert_eq!(tracker.take(), None);
        tracker.end();
        tracker.end();
        done.0
            .lock()
            .unwrap()
            .extend([(0, summary(1.0)), (1, summary(2.0))]);
        assert_eq!(tracker.take().map(|s| s.seconds), Some(1.0));
        assert_eq!(tracker.take().map(|s| s.seconds), Some(2.0));
    }

    /// The JSON a final carries.
    #[test]
    fn a_summary_as_json() {
        let summary = Summary {
            voices: 7,
            voice: Some("A".into()),
            share: 0.756,
            mixed: true,
            mix: vec![("A".into(), 0.756), ("B".into(), 0.244)],
            similarity: vec![("A".into(), 0.584), ("B".into(), 0.071)],
            merged: vec![("C".into(), "A".into())],
            seconds: 4.1,
        };
        assert_eq!(
            summary.to_json(),
            json!({
                "voices": 7, "id": "A", "share": 0.76, "mixed": true,
                "mix": [{"id": "A", "share": 0.76}, {"id": "B", "share": 0.24}],
                "similarity": {"A": 0.58, "B": 0.07},
                "merged": {"C": "A"}, "seconds": 4.1
            })
        );
    }

    /// A stretch sounds like the user when it went to their voice or is
    /// close to it, in the same set of voices only.
    #[test]
    fn a_stretch_sounds_like_the_user() {
        let user = (3, "A".to_string());
        let stretch = |voice: &str, a: f32| Stretch {
            seconds: 1.0,
            voice: Some(voice.into()),
            scores: vec![("A".into(), a), ("B".into(), 0.1)],
            overlapped: false,
            embedding: Vec::new(),
        };
        assert!(sounds_like(&stretch("A", 0.5), 3, &user));
        assert!(sounds_like(&stretch("B", 0.35), 3, &user));
        assert!(!sounds_like(&stretch("B", 0.1), 3, &user));
        assert!(!sounds_like(&stretch("A", 0.5), 4, &user));
    }
}
