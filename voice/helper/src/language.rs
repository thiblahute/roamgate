//! Which language a sentence is in, among those the voices speak, with
//! Lingua (statistical models of the languages, accurate on short text):
//! a reply's, to read it in its language, and what was heard, for the
//! conversation's language (reread.rs). Short and code-heavy agent replies
//! are the case to handle: anything unclear is English to read.

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
    detect_clearly(text).unwrap_or_else(|| "en".to_string())
}

/// The ISO 639-1 code of `text`'s language, None when unclear.
pub fn detect_clearly(text: &str) -> Option<String> {
    DETECTOR
        .detect_language_of(text)
        .map(|language| language.iso_code_639_1().to_string())
}

/// Whether `text` reads as English at least as much as in `language` (an
/// ISO 639-1 code): English words, or too few to tell; false for a language
/// the voices do not speak.
pub fn reads_english(text: &str, language: &str) -> bool {
    let Some(other) = VOICED
        .iter()
        .find(|voiced| voiced.iso_code_639_1().to_string() == language)
    else {
        return false;
    };
    DETECTOR.compute_language_confidence(text, Language::English)
        >= DETECTOR.compute_language_confidence(text, *other)
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
        // What Parakeet writes when French speech drifts to English.
        assert_eq!(
            detect_clearly("Well put the music and best of the volume.").as_deref(),
            Some("en")
        );
        assert_eq!(
            detect_clearly("Mets un peu de musique et baisse le volume.").as_deref(),
            Some("fr")
        );
        for drifted in [
            "Well put the music and best of the volume.",
            "Melbourne Zessel Volume.",
            "Alongside the breams of all she did work in.",
            "Working with the word she, right?",
            "Uh sample volume simply.",
        ] {
            assert!(reads_english(drifted, "fr"), "{drifted}");
        }
        // French with English words in it, as said at work.
        for french in [
            "Relance le build sur la branche et dis-moi quand c'est fini.",
            "Tu peux pousser la branche et ouvrir la merge request ?",
            "Est-ce que l'appel WebRTC marche maintenant ?",
            "Baisse le volume.",
        ] {
            assert!(!reads_english(french, "fr"), "{french}");
        }
        assert!(!reads_english("anything", "de"));
    }
}
