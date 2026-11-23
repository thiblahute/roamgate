//! Reading an utterance again when Parakeet wrote it in English while it
//! was said in the conversation's language.
//!
//! Parakeet TDT v3 has no language setting: it writes in the language it
//! hears. On some French speech (a voice it knows less, music under it, an
//! English word in it) it drifts to English, and writes English words that
//! sound alike or say about the same thing, never what was said: "Mets un
//! peu de musique et baisse le volume" came out "Well put the music and
//! best of the volume". It drifts that way only, to English.
//!
//! So when a final reads as English at least as much as in the
//! conversation's language (Lingua's confidence), and that language is
//! another one (the last reply read, or the last thing said), Whisper's
//! language identification hears the utterance: when it hears the
//! conversation's language more than English, Whisper reads the utterance
//! again in that language, and its text is kept. Speech really in English
//! scores far higher as English, and stays as Parakeet wrote it; French
//! with English words in it ("Relance le build sur la branche") reads as
//! French and is not heard again, and neither is a drift that kept a French
//! word ("Will put the musique in this volume").

use std::sync::{Arc, Mutex};

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Whisper's CPU threads, beside the GPU.
const THREADS: usize = 4;

/// The language a conversation is in: the last reply read, or the last
/// thing said, as two letters.
pub type Conversation = Arc<Mutex<Option<String>>>;

/// Whether to ask Whisper, and in which language: a text that reads as
/// English at least as much as in the conversation's language, when that
/// is another one.
pub fn suspect(text: &str, conversation: Option<&str>) -> Option<String> {
    let conversation = conversation.filter(|language| *language != "en")?;
    crate::language::reads_english(text, conversation).then(|| conversation.to_string())
}

/// Whether Whisper heard `language` more than English.
pub fn said_in(language: f32, english: f32) -> bool {
    language > english
}

/// Whether Whisper stays loaded once loaded: on macOS, where the GPU's
/// memory is the system's and loading it compiles Metal shaders. On an
/// NVIDIA card, kept, it held about 1 GB with its buffers beside Qwen3-TTS
/// for the whole call: on 8 GB, Qwen3-TTS then ran out of memory on every
/// sentence, and Whisper's own buffers running out of it aborted the
/// helper. There it is loaded for an utterance to read again, when the GPU
/// has room for it, and freed after it: such utterances are rare (Parakeet
/// drifting to English), and loading it takes about a second. On the CPU,
/// hearing one took about 30 s.
const KEEP_LOADED: bool = cfg!(target_os = "macos");

/// The GPU memory Whisper large-v3-turbo needs to read an utterance: its
/// weights (573 MB), its buffers (about 380 MB) and CUDA's own, with room.
const WHISPER_GPU_MIB: u64 = 1300;

/// The GPU's free memory in MiB, as nvidia-smi says; None when it cannot
/// tell.
fn gpu_free_mib() -> Option<u64> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.free",
            "--format=csv,noheader,nounits",
            "-i",
            "0",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// Whisper: on macOS, loaded on a thread of its own once the first
/// utterance is heard (loaded with the helper, its Metal shaders compiling
/// held up the call the helper starts first, past the page's wait), an
/// utterance that comes before it is ready kept as written; elsewhere,
/// loaded for each utterance it reads again (KEEP_LOADED).
pub struct Reread {
    model: String,
    loading: std::sync::Once,
    whisper: Arc<Mutex<Option<WhisperContext>>>,
    pub conversation: Conversation,
}

impl Reread {
    pub fn new(model: &str, conversation: Conversation) -> Self {
        Self {
            model: model.to_string(),
            loading: std::sync::Once::new(),
            whisper: Arc::default(),
            conversation,
        }
    }

    /// Whisper from `model`; its failure said.
    fn open(model: &str) -> Option<WhisperContext> {
        // Whisper's and GGML's own lines (loading, Metal, CUDA) are left
        // out; its failures come back as errors.
        whisper_rs::install_logging_hooks();
        match WhisperContext::new_with_params(model, WhisperContextParameters::default()) {
            Ok(context) => Some(context),
            Err(err) => {
                eprintln!("[voice] Whisper does not load ({model}): {err}");
                None
            }
        }
    }

    /// Starts loading Whisper to keep, the first time.
    fn load(&self) {
        self.loading.call_once(|| {
            let loaded = self.whisper.clone();
            let model = self.model.clone();
            std::thread::spawn(move || {
                if let Some(context) = Self::open(&model) {
                    *loaded.lock().unwrap() = Some(context);
                }
            });
        });
    }

    /// The text to keep for utterance `session`, which Parakeet wrote as
    /// `text`, from its 16 kHz mono audio: Whisper's, read in the
    /// conversation's language, when it was said in it; None to keep
    /// `text`.
    pub fn check(&self, session: u32, text: &str, audio: &[f32]) -> Option<String> {
        if KEEP_LOADED {
            self.load();
        }
        let conversation = self.conversation.lock().unwrap().clone();
        let language = suspect(text, conversation.as_deref())?;
        let started = std::time::Instant::now();
        let result = if KEEP_LOADED {
            let whisper = self.whisper.lock().unwrap();
            let Some(whisper) = whisper.as_ref() else {
                debug(&format!(
                    "session {session}: not written in {language}, Whisper is not loaded yet: kept"
                ));
                return None;
            };
            read(whisper, &language, audio)
        } else {
            if let Some(free) = gpu_free_mib().filter(|free| *free < WHISPER_GPU_MIB) {
                eprintln!(
                    "[voice] session {session}: not written in {language}, but the GPU has \
                     {free} MiB free, too little for Whisper: kept"
                );
                return None;
            }
            // Dropped once read: its GPU memory goes back.
            let whisper = Self::open(&self.model)?;
            read(&whisper, &language, audio)
        };
        debug(&format!(
            "session {session}: Whisper heard it in {} ms",
            started.elapsed().as_millis()
        ));
        match result {
            Ok((heard, english, Some(again))) if crate::language::has_words(&again) => {
                eprintln!(
                    "[voice] session {session}: said in {language}, not English \
                     ({heard:.2} against {english:.2}): {text} -> {again}"
                );
                Some(again)
            }
            Ok((heard, english, _)) => {
                debug(&format!(
                    "session {session}: not written in {language}, and said in English \
                     ({english:.2} against {heard:.2}): kept"
                ));
                None
            }
            Err(err) => {
                eprintln!("[voice] session {session}: Whisper failed: {err}");
                None
            }
        }
    }
}

fn debug(line: &str) {
    if std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some() {
        eprintln!("[voice] {line}");
    }
}

/// How much Whisper hears `language` and English in `audio`, and its
/// reading in `language` when that is more.
fn read(
    whisper: &WhisperContext,
    language: &str,
    audio: &[f32],
) -> Result<(f32, f32, Option<String>), String> {
    let id = |code: &str| {
        whisper_rs::get_lang_id(code)
            .map(|id| id as usize)
            .ok_or_else(|| format!("Whisper has no language {code}"))
    };
    let (wanted, english) = (id(language)?, id("en")?);
    let mut state = whisper.create_state().map_err(|e| e.to_string())?;
    state
        .pcm_to_mel(audio, THREADS)
        .map_err(|e| e.to_string())?;
    let (_, heard) = state.lang_detect(0, THREADS).map_err(|e| e.to_string())?;
    let (heard, english) = (heard[wanted], heard[english]);
    if !said_in(heard, english) {
        return Ok((heard, english, None));
    }
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_n_threads(THREADS as i32);
    params.set_no_context(true);
    params.set_single_segment(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for segment in 0..state.full_n_segments() {
        if let Some(segment) = state.get_segment(segment) {
            text.push_str(&segment.to_str_lossy().map_err(|e| e.to_string())?);
        }
    }
    Ok((heard, english, Some(text.trim().to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only a text that reads as English in a conversation in another
    /// language is heard again; Parakeet drifts to English, never from it.
    #[test]
    fn only_english_in_another_conversation_is_suspect() {
        let drifted = "Well put the music and best of the volume.";
        let french = "Relance le build sur la branche et dis-moi quand c'est fini.";
        assert_eq!(suspect(drifted, Some("fr")).as_deref(), Some("fr"));
        assert_eq!(suspect(french, Some("fr")), None);
        assert_eq!(suspect(drifted, Some("en")), None);
        assert_eq!(suspect(french, Some("en")), None);
        // Nothing known of the conversation.
        assert_eq!(suspect(drifted, None), None);
        // Whisper's verdict: the conversation's language heard more.
        assert!(said_in(0.95, 0.03));
        assert!(said_in(0.36, 0.30));
        assert!(!said_in(0.01, 0.98));
    }

    /// With WHISPER_MODEL, and SPEECH_WAV (16 kHz mono S16LE) said in
    /// SPEECH_LANGUAGE: Whisper hears it in that language and reads it.
    #[test]
    #[ignore]
    fn whisper_reads_again_what_was_said_in_french() {
        let var = |name| std::env::var(name).unwrap();
        let whisper =
            WhisperContext::new_with_params(&var("WHISPER_MODEL"), Default::default()).unwrap();
        let bytes = std::fs::read(var("SPEECH_WAV")).unwrap();
        let audio: Vec<f32> = bytes[44..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        let (heard, english, text) = read(&whisper, &var("SPEECH_LANGUAGE"), &audio).unwrap();
        println!("{heard:.3} against {english:.3}: {text:?}");
        assert!(said_in(heard, english));
        assert!(text.is_some_and(|text| crate::language::has_words(&text)));
    }
}
