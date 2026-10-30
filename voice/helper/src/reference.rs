//! A voice's reference recording: read from any audio file GStreamer
//! decodes, its silences cut, kept as a WAV, and what it says transcribed.

use gst::prelude::*;

use crate::clone::RATE;
use crate::listen::Model;

/// The quietest a recording may be and still have speech in it (RMS).
const SPEECH_LEVEL: f32 = 0.01;
/// Kept around the speech when its silences are cut, in seconds.
const MARGIN: f32 = 0.15;

/// Runs `pipeline` to its end, gathering what its `sink` appsink gets.
fn drain(pipeline: &gst::Pipeline) -> Result<Vec<u8>, String> {
    let sink = pipeline
        .by_name("sink")
        .unwrap()
        .downcast::<gst_app::AppSink>()
        .unwrap();
    let error = |pipeline: &gst::Pipeline| {
        pipeline
            .bus()
            .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]))
            .and_then(|message| match message.view() {
                gst::MessageView::Error(e) => Some(e.error().to_string()),
                _ => None,
            })
    };
    if pipeline.set_state(gst::State::Playing).is_err() {
        let detail = error(pipeline).unwrap_or_else(|| "could not start".into());
        let _ = pipeline.set_state(gst::State::Null);
        return Err(detail);
    }
    let mut data = Vec::new();
    let result = loop {
        if let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(100)) {
            if let Some(buffer) = sample.buffer()
                && let Ok(map) = buffer.map_readable()
            {
                data.extend_from_slice(&map);
            }
            continue;
        }
        if sink.is_eos() {
            break Ok(data);
        }
        if let Some(detail) = error(pipeline) {
            break Err(detail);
        }
    };
    let _ = pipeline.set_state(gst::State::Null);
    result
}

/// The audio of the file at `path`, mono at 24 kHz.
pub fn decode(path: &str) -> Result<Vec<f32>, String> {
    let pipeline = gst::Pipeline::new();
    let src = gst::ElementFactory::make("filesrc")
        .property("location", path)
        .build()
        .map_err(|e| e.to_string())?;
    let decode = gst::ElementFactory::make("decodebin")
        .build()
        .map_err(|e| e.to_string())?;
    let rest = gst::parse::bin_from_description(
        &format!(
            "audioconvert ! audioresample ! \
             audio/x-raw,format=F32LE,layout=interleaved,channels=1,rate={RATE} ! \
             appsink name=sink sync=false"
        ),
        true,
    )
    .map_err(|e| e.to_string())?;
    pipeline
        .add_many([&src, &decode, rest.upcast_ref()])
        .map_err(|e| e.to_string())?;
    src.link(&decode).map_err(|e| e.to_string())?;
    let rest_weak = rest.downgrade();
    decode.connect_pad_added(move |_, pad| {
        let Some(rest) = rest_weak.upgrade() else {
            return;
        };
        let is_audio = pad
            .current_caps()
            .and_then(|caps| caps.structure(0).map(|s| s.name().starts_with("audio/")))
            .unwrap_or(false);
        if let Some(sink) = rest.static_pad("sink")
            && is_audio
            && !sink.is_linked()
        {
            let _ = pad.link(&sink);
        }
    });
    let bytes = drain(&pipeline).map_err(|e| format!("{path}: {e}"))?;
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

/// `samples` without the silence before and after the speech, keeping a
/// little of it; empty when nothing in it is loud enough to be speech.
pub fn trim(samples: &[f32]) -> &[f32] {
    let window = RATE as usize / 50;
    let loud = |chunk: &[f32]| {
        let energy: f32 = chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32;
        energy.sqrt() >= SPEECH_LEVEL
    };
    let chunks: Vec<&[f32]> = samples.chunks(window).collect();
    let Some(first) = chunks.iter().position(|c| loud(c)) else {
        return &[];
    };
    let last = chunks.iter().rposition(|c| loud(c)).unwrap_or(first);
    let margin = (MARGIN * RATE as f32) as usize;
    let start = (first * window).saturating_sub(margin);
    let end = ((last + 1) * window + margin).min(samples.len());
    &samples[start..end]
}

/// `samples` as a 16-bit mono WAV file at `path`.
pub fn write_wav(path: &str, samples: &[f32]) -> Result<(), String> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&RATE.to_le_bytes());
    wav.extend_from_slice(&(RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        wav.extend_from_slice(&value.to_le_bytes());
    }
    std::fs::write(path, wav).map_err(|e| format!("{path}: {e}"))
}

/// What `samples` (mono, 24 kHz) say, read whole by Parakeet or Whisper
/// (`language` guiding Whisper).
pub fn transcribe(samples: &[f32], model: Model, language: Option<&str>) -> Result<String, String> {
    let transcriber = match model {
        Model::Whisper(path) => format!(
            "whispertranscriber model-path=\"{path}\" model-preset=large-v3-turbo{}",
            language
                .map(|language| format!(" language={language}"))
                .unwrap_or_default()
        ),
        Model::Parakeet(dir) => format!("parakeettranscriber model-path=\"{dir}\""),
    };
    let pipeline = gst::parse::launch(&format!(
        "appsrc name=src format=time \
           caps=audio/x-raw,format=F32LE,layout=interleaved,channels=1,rate={RATE} ! \
         audioconvert ! audioresample ! {transcriber} ! appsink name=sink sync=false"
    ))
    .map_err(|e| e.to_string())?
    .downcast::<gst::Pipeline>()
    .unwrap();
    let src = pipeline
        .by_name("src")
        .unwrap()
        .downcast::<gst_app::AppSrc>()
        .unwrap();
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut buffer = gst::Buffer::from_slice(bytes);
    {
        let buffer = buffer.get_mut().unwrap();
        buffer.set_pts(gst::ClockTime::ZERO);
        buffer.set_duration(gst::ClockTime::from_nseconds(
            samples.len() as u64 * 1_000_000_000 / RATE as u64,
        ));
    }
    src.push_buffer(buffer).map_err(|e| e.to_string())?;
    let _ = src.end_of_stream();
    let text = drain(&pipeline)?;
    Ok(String::from_utf8_lossy(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_keeps_the_speech_and_a_margin() {
        let rate = RATE as usize;
        let mut samples = vec![0.0f32; rate];
        samples.extend((0..rate).map(|i| (i as f32 / 10.0).sin() * 0.3));
        samples.extend(vec![0.0f32; rate]);
        let trimmed = trim(&samples);
        let margin = (MARGIN * RATE as f32) as usize;
        assert!(trimmed.len() >= rate && trimmed.len() <= rate + 2 * margin + rate / 25);
        assert!(trim(&vec![0.0f32; rate]).is_empty());
    }

    #[test]
    fn wav_round_trip() {
        let path = std::env::temp_dir().join("roamgate-voice-wav-test.wav");
        let path = path.to_str().unwrap();
        write_wav(path, &[0.0, 0.5, -0.5]).unwrap();
        let bytes = std::fs::read(path).unwrap();
        let _ = std::fs::remove_file(path);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes.len(), 44 + 6);
        assert_eq!(i16::from_le_bytes([bytes[46], bytes[47]]), 16384);
    }
}
