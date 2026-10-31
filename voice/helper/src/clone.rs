//! Voice cloning for Qwen3-TTS Base: a recording of someone speaking, and
//! what they say, become a voice any-tts reads with (its `VoiceEmbedding`
//! JSON), all in Rust:
//!
//! - the speaker embedding (the x-vector) comes from the Base model's
//!   ECAPA-TDNN speaker encoder (`speaker_encoder.*` in its
//!   `model.safetensors`), on a 128-band log mel spectrogram;
//! - the reference's codec codes, which Qwen3-TTS continues from (in-context
//!   cloning), come from the speech tokenizer's encoder
//!   (`speech_tokenizer/model.safetensors`, `encoder.*`), which is Kyutai's
//!   Mimi: candle-transformers' Mimi modules read its weights as they are.
//!
//! Both run on the CPU: a reference takes a couple of seconds, and the GPU
//! stays free for the voice speaking.

use std::path::Path;

use candle_core::{D, DType, Device, Module, StreamingModule, Tensor};
use candle_nn::{Conv1d, Conv1dConfig, VarBuilder};
use candle_transformers::models::mimi::{self, conv, quantization, seanet, transformer};

/// The rate Qwen3-TTS and its tokenizer work at.
pub const RATE: u32 = 24_000;
/// The codebooks Qwen3-TTS's talker reads of the 32 the encoder has.
const CODEBOOKS: usize = 16;

type Result<T> = std::result::Result<T, String>;

fn err(error: candle_core::Error) -> String {
    error.to_string()
}

/// What a voice is made of, before it is written down.
pub struct Voice {
    /// The x-vector, `enc_dim` values.
    pub embedding: Vec<f32>,
    /// The reference's codec codes, one row of 16 per 12.5 Hz frame.
    pub codes: Vec<Vec<u32>>,
}

pub struct Cloner {
    speaker: SpeakerEncoder,
    codec: CodecEncoder,
}

impl Cloner {
    /// Loads the encoders of the Qwen3-TTS Base model in `model_dir`.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let device = Device::Cpu;
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(model_dir.join("config.json"))
                .map_err(|e| format!("{}: {e}", model_dir.join("config.json").display()))?,
        )
        .map_err(|e| format!("config.json: {e}"))?;
        let Some(speaker_config) = config.get("speaker_encoder_config") else {
            return Err(format!(
                "{} has no speaker encoder: cloning needs a Qwen3-TTS Base model",
                model_dir.display()
            ));
        };
        let dim = speaker_config
            .get("enc_dim")
            .and_then(|v| v.as_u64())
            .unwrap_or(1024) as usize;
        // SAFETY: the weights are only read, and not changed while loaded.
        let weights = unsafe {
            VarBuilder::from_mmaped_safetensors(
                &[model_dir.join("model.safetensors")],
                DType::F32,
                &device,
            )
        }
        .map_err(err)?;
        let speaker = SpeakerEncoder::new(dim, weights.pp("speaker_encoder"))
            .map_err(|e| format!("speaker encoder: {e}"))?;
        let tokenizer = model_dir.join("speech_tokenizer").join("model.safetensors");
        let codec = codec_weights(&tokenizer, &device)
            .and_then(|weights| CodecEncoder::new(weights.pp("encoder")))
            .map_err(|e| format!("speech tokenizer encoder: {e}"))?;
        Ok(Self { speaker, codec })
    }

    /// The voice of `samples`, mono at 24 kHz.
    pub fn clone_voice(&mut self, samples: &[f32]) -> Result<Voice> {
        let device = Device::Cpu;
        let mels = mel_spectrogram(samples);
        let frames = mels.len() / MELS;
        if frames < 2 {
            return Err("The recording is too short".into());
        }
        let mels = Tensor::from_vec(mels, (1, frames, MELS), &device)
            .and_then(|t| t.transpose(1, 2))
            .map_err(err)?;
        let embedding = self
            .speaker
            .forward(&mels)
            .and_then(|t| t.flatten_all())
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(err)?;
        let audio = Tensor::from_slice(samples, (1, 1, samples.len()), &device).map_err(err)?;
        let codes = self
            .codec
            .encode(&audio)
            .and_then(|t| t.squeeze(0))
            .and_then(|t| t.t())
            .and_then(|t| t.to_vec2::<u32>())
            .map_err(err)?;
        Ok(Voice { embedding, codes })
    }
}

/// The speech tokenizer encoder's weights, in `file`, made ready for
/// candle's Mimi transformer. That rotates query and key dimensions in
/// adjacent pairs (Kyutai's rotary embedding), where these weights expect
/// the halves of each head rotated together (Hugging Face's): reordering
/// each head's query and key rows from halves to pairs gives the same
/// attention.
fn codec_weights(file: &Path, device: &Device) -> candle_core::Result<VarBuilder<'static>> {
    // SAFETY: the weights are only read, and not changed while loaded.
    let tensors = unsafe { candle_core::safetensors::MmapedSafetensors::new(file)? };
    let config = mimi::Config::v0_1(Some(CODEBOOKS)).transformer;
    let head_dim = config.d_model / config.num_heads;
    let mut weights = std::collections::HashMap::new();
    for (name, _) in tensors.tensors() {
        if !name.starts_with("encoder.") {
            continue;
        }
        let mut tensor = tensors.load(&name, device)?.to_dtype(DType::F32)?;
        if name.ends_with("self_attn.q_proj.weight") || name.ends_with("self_attn.k_proj.weight") {
            let (rows, columns) = tensor.dims2()?;
            tensor = tensor
                .reshape((rows / head_dim, 2, head_dim / 2, columns))?
                .transpose(1, 2)?
                .reshape((rows, columns))?
                .contiguous()?;
        }
        weights.insert(name, tensor);
    }
    Ok(VarBuilder::from_tensors(weights, DType::F32, device))
}

/// The speech tokenizer's encoder: SEANet, a transformer, a downsampling
/// convolution, then the split residual quantizer, as Mimi.
struct CodecEncoder {
    encoder: seanet::SeaNetEncoder,
    transformer: transformer::ProjectedTransformer,
    downsample: conv::ConvDownsample1d,
    quantizer: quantization::SplitResidualVectorQuantizer,
}

impl CodecEncoder {
    fn new(vb: VarBuilder) -> candle_core::Result<Self> {
        // Qwen3-TTS-Tokenizer-12Hz's encoder_config is Mimi's.
        let config = mimi::Config::v0_1(Some(CODEBOOKS));
        let dim = config.seanet.dimension;
        let encoder = seanet::SeaNetEncoder::new(&config.seanet, vb.pp("encoder"))?;
        let transformer = transformer::ProjectedTransformer::new(
            dim,
            &[dim],
            &config.transformer,
            vb.pp("encoder_transformer"),
        )?;
        let frame_rate = config.sample_rate / config.seanet.ratios.iter().product::<usize>() as f64;
        let downsample = conv::ConvDownsample1d::new(
            (frame_rate / config.frame_rate) as usize,
            dim,
            true,
            true,
            vb.pp("downsample"),
        )?;
        let quantizer = quantization::SplitResidualVectorQuantizer::new(
            config.quantizer_dim,
            Some(dim),
            Some(dim),
            config.quantizer_n_q,
            config.quantizer_bins,
            vb.pp("quantizer"),
        )?;
        Ok(Self {
            encoder,
            transformer,
            downsample,
            quantizer,
        })
    }

    /// Codes `[1, 16, frames]` of `[1, 1, samples]`.
    fn encode(&mut self, audio: &Tensor) -> candle_core::Result<Tensor> {
        self.encoder.reset_state();
        self.transformer.reset_state();
        self.downsample.reset_state();
        let xs = self.encoder.forward(audio)?;
        let xs = self.transformer.forward(&xs)?.remove(0);
        let xs = xs.apply(&self.downsample)?;
        self.quantizer.encode(&xs)
    }
}

// The speaker encoder's input: a log mel spectrogram as Qwen3-TTS computes
// it (n_fft 1024, hop 256, 128 Slaney bands up to 12 kHz).
const N_FFT: usize = 1024;
const HOP: usize = 256;
const MELS: usize = 128;
const F_MAX: f64 = 12_000.0;

/// Frames of `MELS` log mel energies, one after the other.
fn mel_spectrogram(samples: &[f32]) -> Vec<f32> {
    let pad = (N_FFT - HOP) / 2;
    if samples.len() <= pad + 1 {
        return Vec::new();
    }
    // Reflected at both ends, without repeating the edge.
    let mut padded = Vec::with_capacity(samples.len() + 2 * pad);
    padded.extend(samples[1..=pad].iter().rev());
    padded.extend_from_slice(samples);
    padded.extend(
        samples[samples.len() - 1 - pad..samples.len() - 1]
            .iter()
            .rev(),
    );
    if padded.len() < N_FFT {
        return Vec::new();
    }
    let frames = 1 + (padded.len() - N_FFT) / HOP;
    let window: Vec<f32> = (0..N_FFT)
        .map(|n| {
            (0.5 * (1.0 - (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos())) as f32
        })
        .collect();
    let filters = mel_filters();
    let bins = N_FFT / 2 + 1;
    let mut planner = realfft::RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut magnitude = vec![0f32; bins];
    let mut out = Vec::with_capacity(frames * MELS);
    for frame in 0..frames {
        let start = frame * HOP;
        for (i, value) in input.iter_mut().enumerate() {
            *value = padded[start + i] * window[i];
        }
        fft.process(&mut input, &mut spectrum)
            .expect("buffers made by the plan");
        for (m, c) in magnitude.iter_mut().zip(&spectrum) {
            *m = (c.re * c.re + c.im * c.im + 1e-9).sqrt();
        }
        for band in filters.chunks(bins) {
            let energy: f32 = band.iter().zip(&magnitude).map(|(w, m)| w * m).sum();
            out.push(energy.max(1e-5).ln());
        }
    }
    out
}

fn hz_to_mel(hz: f64) -> f64 {
    // Slaney: linear below 1 kHz, logarithmic above.
    let f_sp = 200.0 / 3.0;
    if hz >= 1000.0 {
        1000.0 / f_sp + (hz / 1000.0).ln() / (6.4f64.ln() / 27.0)
    } else {
        hz / f_sp
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_mel = 1000.0 / f_sp;
    if mel >= min_log_mel {
        1000.0 * ((6.4f64.ln() / 27.0) * (mel - min_log_mel)).exp()
    } else {
        mel * f_sp
    }
}

/// `MELS` rows of `N_FFT / 2 + 1` weights, Slaney-normalized triangles.
fn mel_filters() -> Vec<f32> {
    let bins = N_FFT / 2 + 1;
    let (low, high) = (hz_to_mel(0.0), hz_to_mel(F_MAX));
    let points: Vec<f64> = (0..MELS + 2)
        .map(|i| mel_to_hz(low + (high - low) * i as f64 / (MELS + 1) as f64))
        .collect();
    let mut filters = vec![0f32; MELS * bins];
    for band in 0..MELS {
        let (left, center, right) = (points[band], points[band + 1], points[band + 2]);
        let norm = 2.0 / (right - left);
        for bin in 0..bins {
            let hz = bin as f64 * (RATE as f64 / 2.0) / (bins - 1) as f64;
            let rising = (hz - left) / (center - left);
            let falling = (right - hz) / (right - center);
            let weight = rising.min(falling).max(0.0);
            filters[band * bins + bin] = (weight * norm) as f32;
        }
    }
    filters
}

/// Pads the time axis (the last) by reflection, as the speaker encoder's
/// convolutions expect.
fn reflect_pad(xs: &Tensor, pad: usize) -> candle_core::Result<Tensor> {
    if pad == 0 {
        return Ok(xs.clone());
    }
    let len = xs.dim(D::Minus1)?;
    if len <= pad {
        candle_core::bail!("too short to pad by {pad}: {len}");
    }
    let index: Vec<u32> = (1..=pad)
        .rev()
        .chain(0..len)
        .chain((len - 1 - pad..len - 1).rev())
        .map(|i| i as u32)
        .collect();
    let index = Tensor::from_vec(index, pad * 2 + len, xs.device())?;
    xs.contiguous()?.index_select(&index, D::Minus1)
}

fn conv1d(
    in_channels: usize,
    out_channels: usize,
    kernel: usize,
    dilation: usize,
    vb: VarBuilder,
) -> candle_core::Result<Conv1d> {
    candle_nn::conv1d(
        in_channels,
        out_channels,
        kernel,
        Conv1dConfig {
            dilation,
            ..Default::default()
        },
        vb,
    )
}

/// A convolution over time, "same" padded by reflection, then ReLU.
struct Tdnn {
    conv: Conv1d,
    pad: usize,
}

impl Tdnn {
    fn new(
        in_channels: usize,
        out_channels: usize,
        kernel: usize,
        dilation: usize,
        vb: VarBuilder,
    ) -> candle_core::Result<Self> {
        Ok(Self {
            conv: conv1d(in_channels, out_channels, kernel, dilation, vb.pp("conv"))?,
            pad: (kernel - 1) * dilation / 2,
        })
    }

    fn forward(&self, xs: &Tensor) -> candle_core::Result<Tensor> {
        reflect_pad(xs, self.pad)?.apply(&self.conv)?.relu()
    }
}

/// SE-Res2Net: a 1x1 TDNN, Res2Net's multi-scale convolutions, another
/// 1x1 TDNN, squeeze and excitation, around a residual.
struct SeRes2NetBlock {
    tdnn1: Tdnn,
    res2net: Vec<Tdnn>,
    tdnn2: Tdnn,
    se1: Conv1d,
    se2: Conv1d,
}

const RES2NET_SCALE: usize = 8;

impl SeRes2NetBlock {
    fn new(
        channels: usize,
        kernel: usize,
        dilation: usize,
        vb: VarBuilder,
    ) -> candle_core::Result<Self> {
        let width = channels / RES2NET_SCALE;
        let res2net = (0..RES2NET_SCALE - 1)
            .map(|i| {
                Tdnn::new(
                    width,
                    width,
                    kernel,
                    dilation,
                    vb.pp("res2net_block.blocks").pp(i),
                )
            })
            .collect::<candle_core::Result<_>>()?;
        Ok(Self {
            tdnn1: Tdnn::new(channels, channels, 1, 1, vb.pp("tdnn1"))?,
            res2net,
            tdnn2: Tdnn::new(channels, channels, 1, 1, vb.pp("tdnn2"))?,
            se1: conv1d(channels, 128, 1, 1, vb.pp("se_block.conv1"))?,
            se2: conv1d(128, channels, 1, 1, vb.pp("se_block.conv2"))?,
        })
    }

    fn forward(&self, xs: &Tensor) -> candle_core::Result<Tensor> {
        let hidden = self.tdnn1.forward(xs)?;
        let chunks = hidden.chunk(RES2NET_SCALE, 1)?;
        let mut outputs = Vec::with_capacity(RES2NET_SCALE);
        let mut previous: Option<Tensor> = None;
        for (i, chunk) in chunks.iter().enumerate() {
            let output = match (i, &previous) {
                (0, _) => chunk.clone(),
                (1, _) | (_, None) => self.res2net[i - 1].forward(chunk)?,
                (_, Some(previous)) => self.res2net[i - 1].forward(&(chunk + previous)?)?,
            };
            previous = Some(output.clone());
            outputs.push(output);
        }
        let hidden = self.tdnn2.forward(&Tensor::cat(&outputs, 1)?)?;
        let squeezed = hidden.mean_keepdim(D::Minus1)?;
        let excitation =
            candle_nn::ops::sigmoid(&squeezed.apply(&self.se1)?.relu()?.apply(&self.se2)?)?;
        (hidden.broadcast_mul(&excitation)? + xs)?.contiguous()
    }
}

/// ECAPA-TDNN, as Qwen3-TTS's speaker encoder: mel frames `[1, 128, T]` in,
/// the x-vector `[1, dim, 1]` out.
struct SpeakerEncoder {
    first: Tdnn,
    blocks: Vec<SeRes2NetBlock>,
    mfa: Tdnn,
    asp_tdnn: Tdnn,
    asp_conv: Conv1d,
    fc: Conv1d,
}

impl SpeakerEncoder {
    fn new(dim: usize, vb: VarBuilder) -> candle_core::Result<Self> {
        let blocks = [(2, 1), (3, 2), (4, 3)]
            .into_iter()
            .map(|(dilation, i)| SeRes2NetBlock::new(512, 3, dilation, vb.pp("blocks").pp(i)))
            .collect::<candle_core::Result<_>>()?;
        Ok(Self {
            first: Tdnn::new(MELS, 512, 5, 1, vb.pp("blocks.0"))?,
            blocks,
            mfa: Tdnn::new(1536, 1536, 1, 1, vb.pp("mfa"))?,
            asp_tdnn: Tdnn::new(1536 * 3, 128, 1, 1, vb.pp("asp.tdnn"))?,
            asp_conv: conv1d(128, 1536, 1, 1, vb.pp("asp.conv"))?,
            fc: conv1d(1536 * 2, dim, 1, 1, vb.pp("fc"))?,
        })
    }

    fn forward(&self, mels: &Tensor) -> candle_core::Result<Tensor> {
        const EPS: f64 = 1e-12;
        let mut xs = self.first.forward(mels)?;
        let mut hidden = Vec::new();
        for block in &self.blocks {
            xs = block.forward(&xs)?;
            hidden.push(xs.clone());
        }
        let xs = self.mfa.forward(&Tensor::cat(&hidden, 1)?)?;
        // Attentive statistics pooling.
        let frames = xs.dim(D::Minus1)?;
        let mean = xs.mean_keepdim(D::Minus1)?;
        let var = xs.broadcast_sub(&mean)?.sqr()?.mean_keepdim(D::Minus1)?;
        let std = (var + EPS)?.sqrt()?;
        let context = Tensor::cat(
            &[
                xs.clone(),
                mean.repeat((1, 1, frames))?,
                std.repeat((1, 1, frames))?,
            ],
            1,
        )?;
        let attention = self
            .asp_tdnn
            .forward(&context)?
            .tanh()?
            .apply(&self.asp_conv)?;
        let attention = candle_nn::ops::softmax(&attention, D::Minus1)?;
        let mean = (&attention * &xs)?.sum_keepdim(D::Minus1)?;
        let var = (&attention * xs.broadcast_sub(&mean)?.sqr()?)?.sum_keepdim(D::Minus1)?;
        let std = var.clamp(EPS, f64::MAX)?.sqrt()?;
        Tensor::cat(&[mean, std], 1)?.apply(&self.fc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mel_filters_cover_the_bands() {
        let filters = mel_filters();
        let bins = N_FFT / 2 + 1;
        assert_eq!(filters.len(), MELS * bins);
        // Each band has some weight, and nothing above 12 kHz.
        for band in filters.chunks(bins) {
            assert!(band.iter().any(|&w| w > 0.0));
            assert_eq!(*band.last().unwrap(), 0.0);
        }
    }

    #[test]
    fn mel_spectrogram_frames() {
        let samples: Vec<f32> = (0..RATE as usize)
            .map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / RATE as f32).sin())
            .collect();
        let mels = mel_spectrogram(&samples);
        // One frame per hop, the padding making up the window.
        assert_eq!(
            mels.len() / MELS,
            1 + (RATE as usize + N_FFT - HOP - N_FFT) / HOP
        );
        // A 440 Hz tone: the loudest band is a low one.
        let first = &mels[..MELS];
        let loudest = first
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert!((5..20).contains(&loudest), "{loudest}");
    }

    #[test]
    fn reflect_pad_mirrors() {
        let xs = Tensor::new(&[[[1f32, 2., 3., 4.]]], &Device::Cpu).unwrap();
        let padded = reflect_pad(&xs, 2).unwrap().flatten_all().unwrap();
        assert_eq!(
            padded.to_vec1::<f32>().unwrap(),
            vec![3., 2., 1., 2., 3., 4., 3., 2.]
        );
    }

    /// The voice of CLONE_WAV (24 kHz mono 16-bit) with the Base model in
    /// QWEN3_BASE, as is, written to CLONE_OUT: to compare with another
    /// implementation's.
    #[test]
    #[ignore]
    fn clone_reference() {
        let var = |name| std::env::var(name).unwrap();
        let mut cloner = Cloner::load(Path::new(&var("QWEN3_BASE"))).unwrap();
        let bytes = std::fs::read(var("CLONE_WAV")).unwrap();
        let samples: Vec<f32> = bytes[44..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        let voice = cloner.clone_voice(&samples).unwrap();
        let json = serde_json::json!({"data": voice.embedding, "codes": voice.codes});
        std::fs::write(var("CLONE_OUT"), json.to_string()).unwrap();
    }
}
