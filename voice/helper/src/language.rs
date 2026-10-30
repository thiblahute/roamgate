//! Which language a sentence is in, among those the voices speak, with
//! Lingua (statistical models of the languages, accurate on short text).
//! Short and code-heavy agent replies are the case to handle: anything
//! unclear is English.

use std::sync::LazyLock;

use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};

/// The languages Kokoro has a voice for.
const VOICED: [Language; 8] = [
    Language::English,
    Language::French,
    Language::Spanish,
    Language::Italian,
    Language::Portuguese,
    Language::Hindi,
    Language::Japanese,
    Language::Chinese,
];

static DETECTOR: LazyLock<LanguageDetector> = LazyLock::new(|| {
    LanguageDetectorBuilder::from_languages(&VOICED)
        // A sentence that could be either is read as English.
        .with_minimum_relative_distance(0.1)
        .build()
});

/// Whether there is anything to say, not only punctuation or symbols.
pub fn has_words(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// The ISO 639-1 code of `text`'s language, "en" when unclear.
pub fn detect(text: &str) -> String {
    DETECTOR
        .detect_language_of(text)
        .map(|language| language.iso_code_639_1().to_string())
        .unwrap_or_else(|| "en".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_voiced_languages() {
        assert_eq!(detect("The build passed, I pushed the fix."), "en");
        assert_eq!(
            detect("Le build est passé, j'ai poussé la correction."),
            "fr"
        );
        assert_eq!(
            detect("La compilación pasó, subí la corrección a la rama."),
            "es"
        );
        assert_eq!(
            detect("La build è passata, ho caricato la correzione."),
            "it"
        );
        assert_eq!(detect("cargo build --release"), "en");
        assert!(!has_words("```"));
    }
}
