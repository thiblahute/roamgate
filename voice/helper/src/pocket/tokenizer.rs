//! The text tokenizer of a Pocket TTS model: its Hugging Face `tokenizer.json`.
//!
//! From Kyutai's pocket-tts Rust binary (rust/src/tokenizer.rs, MIT), without its SentencePiece
//! models, which no base model uses.

use anyhow::{Context, Result, bail};
use std::path::Path;
use std::sync::Arc;

pub struct Tokenizer(tokenizers::Tokenizer);

impl Tokenizer {
    pub fn load(n_bins: usize, path: &Path) -> Result<Self> {
        let tokenizer = tokenizers::Tokenizer::from_file(path)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .with_context(|| format!("cannot load {}", path.display()))?;
        let vocab_size = tokenizer.get_vocab_size(true);
        if vocab_size != n_bins {
            bail!("tokenizer has vocab size={vocab_size} but nbins={n_bins} was specified")
        }
        Ok(Self(tokenizer))
    }

    pub fn encode(&self, text: &str) -> Result<Vec<u32>> {
        // `add_special_tokens` as in Python's `Tokenizer.encode` default.
        Ok(self
            .0
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .get_ids()
            .to_vec())
    }

    pub fn decode(&self, ids: &[u32]) -> Result<String> {
        self.0.decode(ids, true).map_err(|e| anyhow::anyhow!("{e}"))
    }
}

/// The tokenizer as xn-ptts's flow LM holds it, shared with the text chunking.
pub struct SharedTokenizer(pub Arc<Tokenizer>);

impl ptts::Tokenizer for SharedTokenizer {
    fn encode(&self, text: &str) -> xn::Result<Vec<u32>> {
        self.0
            .encode(text)
            .map_err(|e| xn::Error::msg(format!("{e:#}")))
    }

    fn decode(&self, tokens: &[u32]) -> xn::Result<String> {
        self.0
            .decode(tokens)
            .map_err(|e| xn::Error::msg(format!("{e:#}")))
    }
}
