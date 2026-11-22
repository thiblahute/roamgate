//! Kyutai's Pocket TTS (<https://github.com/kyutai-labs/pocket-tts>): a ~100M
//! model per language that reads on the CPU, streaming its first audio in
//! about 0.2 s. It is the light voice: what reads while a game holds the GPU,
//! and what the full set falls back on when Qwen3-TTS fails.
//!
//! The model code is Kyutai's own Rust port (the pocket-tts binary, MIT), on
//! the streaming primitives of xn-ptts; `synthesizer` makes it the
//! `pocketsynthesizer` element the helper's speaker pipeline reads with.
//! The weights are those without voice cloning
//! (`kyutai/pocket-tts-without-voice-cloning`), each language in a directory
//! of its own: `model.safetensors`, `tokenizer.json`, and the voices as
//! `embeddings/<name>.safetensors`.

mod config;
mod model;
mod rng;
pub mod synthesizer;
mod text;
mod tokenizer;
mod weights;

/// Port of `pocket_tts/default_parameters.py`.
const DEFAULT_SAMPLER_DECODE_STEPS: usize = 1;
const DEFAULT_EOS_THRESHOLD: f32 = -4.0;
const MAX_TOKEN_PER_CHUNK: usize = 50;

/// The languages Pocket TTS has a model for: the ISO 639-1 code, the name of
/// its config, and the voice of Kyutai's catalog it reads with by default
/// (`DEFAULT_VOICE_FOR_LANGUAGE` in the Python package, English's `alba`).
/// French reads with estelle: marius, an English speaker's voice, cuts
/// French sentences short.
pub const LANGUAGES: &[(&str, &str, &str)] = &[
    ("en", "english", "alba"),
    ("fr", "french", "estelle"),
    ("de", "german", "juergen"),
    ("it", "italian", "giovanni"),
    ("es", "spanish", "lola"),
    ("pt", "portuguese", "rafael"),
    ("nl", "dutch", "daan"),
];

/// The ISO 639-1 code of `code` (fr-FR, fr_CA, FR...).
pub fn primary(code: &str) -> String {
    code.split(['-', '_'])
        .next()
        .unwrap_or(code)
        .to_ascii_lowercase()
}

/// The entry of LANGUAGES for `code`, if Pocket TTS speaks it.
pub fn language(code: &str) -> Option<&'static (&'static str, &'static str, &'static str)> {
    let code = primary(code);
    LANGUAGES.iter().find(|(iso, ..)| *iso == code)
}

/// The threads Pocket TTS computes with: xn's own pool, sized once, at its
/// first use. Four were the fastest on Kyutai's machines (more cost more
/// to dispatch than they save); `limit` (`--cpu-threads`, a game running)
/// lowers it, and the workers then park at once between steps rather than
/// spin, leaving the cores to the game. Before any other thread starts:
/// xn sets RAYON_NUM_THREADS, put back here as it was so the other models'
/// pools are not changed.
pub fn set_threads(limit: Option<usize>) {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get());
    let threads = limit.unwrap_or(4).min(cpus).max(1);
    let rayon = std::env::var_os("RAYON_NUM_THREADS");
    xn::set_num_threads(threads);
    // SAFETY: called from main before any other thread is started.
    unsafe {
        match rayon {
            Some(value) => std::env::set_var("RAYON_NUM_THREADS", value),
            None => std::env::remove_var("RAYON_NUM_THREADS"),
        }
        if limit.is_some() && std::env::var_os("XN_SPIN_BUDGET").is_none() {
            std::env::set_var("XN_SPIN_BUDGET", "0");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_by_their_codes() {
        assert_eq!(language("fr").map(|l| l.1), Some("french"));
        assert_eq!(language("fr-CA").map(|l| l.2), Some("estelle"));
        assert_eq!(language("EN_us").map(|l| l.1), Some("english"));
        assert!(language("ja").is_none());
        assert!(language("").is_none());
        for (_, name, _) in LANGUAGES {
            assert!(
                config::CONFIGS.iter().any(|(config, _)| config == name),
                "{name} has no config"
            );
        }
    }
}
