//! Which language the light voice (Kokoro, Pocket TTS) reads a sentence in,
//! and when it cannot (server/src/voice/voice-kokoro-language.ts): a
//! sentence in a language none of its voices has is caught first, and a
//! short notice is read in its place.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

/// Kokoro's voice for each language it speaks.
pub const KOKORO_VOICES: [(&str, &str); 8] = [
    ("en", "af_heart"),
    ("es", "ef_dora"),
    ("fr", "ff_siwis"),
    ("hi", "hf_alpha"),
    ("it", "if_sara"),
    ("ja", "jf_alpha"),
    ("pt", "pf_dora"),
    ("zh", "zf_xiaobei"),
];

pub fn kokoro_voice(language: &str) -> Option<&'static str> {
    KOKORO_VOICES
        .iter()
        .find(|(code, _)| *code == language)
        .map(|(_, voice)| *voice)
}

const LANGUAGE_NAMES: [(&str, &str); 9] = [
    ("ar", "Arabic"),
    ("de", "German"),
    ("el", "Greek"),
    ("he", "Hebrew"),
    ("ko", "Korean"),
    ("nl", "Dutch"),
    ("ru", "Russian"),
    ("th", "Thai"),
    ("uk", "Ukrainian"),
];

static SCRIPTS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\p{Script=Cyrillic}", "ru"),
        (r"\p{Script=Hangul}", "ko"),
        (r"\p{Script=Arabic}", "ar"),
        (r"\p{Script=Hebrew}", "he"),
        (r"\p{Script=Greek}", "el"),
        (r"\p{Script=Thai}", "th"),
    ]
    .into_iter()
    .map(|(pattern, language)| (Regex::new(pattern).expect("regex"), language))
    .collect()
});

static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}").expect("regex"));
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}+").expect("regex"));
static SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-_]").expect("regex"));

const GERMAN: &[&str] = &[
    "und", "ist", "nicht", "ich", "eine", "einen", "für", "auch", "sind", "wird", "werden",
    "haben", "oder", "aber", "wenn", "dass", "nach", "noch", "schon", "heute", "jetzt", "mit",
    "auf", "wir", "bitte", "danke",
];
const DUTCH: &[&str] = &[
    "het",
    "een",
    "niet",
    "maar",
    "zijn",
    "wordt",
    "ook",
    "naar",
    "wij",
    "jij",
    "bedankt",
    "alsjeblieft",
    "goed",
    "nog",
];

/// JavaScript's `match(...)?.length`: how many times `pattern` matches,
/// counting UTF-16 code units the way `/u` regexes step through them.
fn count(pattern: &Regex, text: &str) -> usize {
    pattern.find_iter(text).count()
}

/// The language of `text` when it is clearly one no Kokoro voice reads.
pub fn unvoiced_language(text: &str) -> Option<&'static str> {
    let letters = count(&LETTER, text);
    if letters == 0 {
        return None;
    }
    for (script, language) in SCRIPTS.iter() {
        if count(script, text) * 2 > letters {
            return Some(language);
        }
    }
    let lower = text.to_lowercase();
    let words: Vec<&str> = WORD.find_iter(&lower).map(|found| found.as_str()).collect();
    if words.len() < 2 {
        return None;
    }
    for (known, language) in [(GERMAN, "de"), (DUTCH, "nl")] {
        let hits: Vec<&&str> = words.iter().filter(|word| known.contains(word)).collect();
        let distinct: BTreeSet<&&&str> = hits.iter().collect();
        if distinct.len() >= 2 && hits.len() * 5 >= words.len() {
            return Some(language);
        }
    }
    None
}

fn code_of(language: &str) -> String {
    SEPARATOR
        .split(language)
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// The language Kokoro cannot read `text` in, if any.
pub fn kokoro_cannot_read(text: &str, language: Option<&str>) -> Option<String> {
    if let Some(language) = language.filter(|language| !language.is_empty()) {
        let code = code_of(language);
        return if kokoro_voice(&code).is_some() {
            None
        } else {
            Some(code)
        };
    }
    unvoiced_language(text).map(str::to_owned)
}

/// The languages the light voice reads.
pub fn light_languages(models: Option<&[Map<String, Value>]>) -> BTreeSet<String> {
    let Some(models) = models else {
        return KOKORO_VOICES
            .iter()
            .map(|(code, _)| (*code).to_owned())
            .collect();
    };
    let mut languages = BTreeSet::new();
    for entry in models {
        if let Some(list) = entry.get("languages").and_then(Value::as_str) {
            for code in list.split(',') {
                languages.insert(code_of(code.trim()));
            }
        } else if entry.get("model").and_then(Value::as_str) == Some("kokoro") {
            languages.extend(KOKORO_VOICES.iter().map(|(code, _)| (*code).to_owned()));
        }
    }
    languages
}

/// The language the light voice cannot read `text` in, if any.
pub fn light_cannot_read(
    text: &str,
    language: Option<&str>,
    models: Option<&[Map<String, Value>]>,
) -> Option<String> {
    let readable = light_languages(models);
    let code = match language.filter(|language| !language.is_empty()) {
        Some(language) => Some(code_of(language)),
        None => unvoiced_language(text).map(str::to_owned),
    }?;
    (!code.is_empty() && !readable.contains(&code)).then_some(code)
}

/// What is read in place of a sentence Kokoro cannot read, in English.
pub fn cannot_read_notice(language: &str) -> String {
    match LANGUAGE_NAMES.iter().find(|(code, _)| *code == language) {
        Some((_, name)) => format!("This reply is in {name}, which this voice cannot read."),
        None => "This reply is in a language this voice cannot read.".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entries(value: Value) -> Vec<Map<String, Value>> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|each| each.as_object().unwrap().clone())
            .collect()
    }

    #[test]
    fn french_and_english_each_have_their_own_voice() {
        assert_eq!(kokoro_voice("fr"), Some("ff_siwis"));
        assert_eq!(kokoro_voice("en"), Some("af_heart"));
        assert!(kokoro_voice("fr").unwrap().starts_with('f'));
        assert!(kokoro_voice("en").unwrap().starts_with('a'));
    }

    #[test]
    fn french_english_and_french_with_english_terms_are_read() {
        for text in [
            "Bonjour, je lance la partie et je reviens vers toi dans cinq minutes.",
            "The build passed and I pushed the fix to the branch.",
            "J'ai relancé le pipeline GitLab CI, le merge request est prêt.",
            "OK, cargo build --release est passé.",
            "Ich",
            "",
        ] {
            assert_eq!(unvoiced_language(text), None, "{text}");
            assert_eq!(kokoro_cannot_read(text, None), None);
        }
    }

    #[test]
    fn a_language_kokoro_has_no_voice_for_is_caught() {
        assert_eq!(
            unvoiced_language("Ich habe den Build gestartet und das ist jetzt fertig."),
            Some("de")
        );
        assert_eq!(
            unvoiced_language("Het is goed, maar de build is nog niet klaar."),
            Some("nl")
        );
        assert_eq!(
            unvoiced_language("Сборка прошла, я отправил исправление."),
            Some("ru")
        );
        assert_eq!(unvoiced_language("빌드가 통과했습니다."), Some("ko"));
        assert_eq!(unvoiced_language("J'ai parlé à Дмитрий de la build."), None);
    }

    #[test]
    fn a_language_given_wins_over_the_text() {
        assert_eq!(kokoro_cannot_read("Bonjour", Some("fr")), None);
        assert_eq!(kokoro_cannot_read("Bonjour", Some("fr-FR")), None);
        assert_eq!(kokoro_cannot_read("Hello", Some("en_GB")), None);
        assert_eq!(
            kokoro_cannot_read("Guten Tag", Some("de")).as_deref(),
            Some("de")
        );
        assert_eq!(
            kokoro_cannot_read("Anything", Some("xx")).as_deref(),
            Some("xx")
        );
    }

    #[test]
    fn the_notice_says_which_language_in_english() {
        assert_eq!(
            cannot_read_notice("de"),
            "This reply is in German, which this voice cannot read."
        );
        assert_eq!(
            cannot_read_notice("xx"),
            "This reply is in a language this voice cannot read."
        );
    }

    #[test]
    fn pocket_tts_reads_its_own_kokoro_its_voices_kokoro_alone_its_voices() {
        let pocket = entries(
            json!([{"model": "pocket-tts", "languages": "fr"}, {"model": "pocket-tts", "languages": "en"}]),
        );
        assert_eq!(
            light_languages(Some(&pocket))
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["en", "fr"]
        );
        let mut with_kokoro = pocket.clone();
        with_kokoro.extend(entries(json!([{"model": "kokoro"}])));
        assert!(light_languages(Some(&with_kokoro)).contains("es"));
        let mut all: Vec<&str> = KOKORO_VOICES.iter().map(|(code, _)| *code).collect();
        all.sort();
        assert_eq!(light_languages(None).into_iter().collect::<Vec<_>>(), all);
    }

    #[test]
    fn a_language_none_of_its_voices_reads_is_caught_never_another_s_accent() {
        let pocket = entries(
            json!([{"model": "pocket-tts", "languages": "fr"}, {"model": "pocket-tts", "languages": "en"}]),
        );
        assert_eq!(
            light_cannot_read("Bonjour.", Some("fr-FR"), Some(&pocket)),
            None
        );
        assert_eq!(
            light_cannot_read("Hola.", Some("es"), Some(&pocket)).as_deref(),
            Some("es")
        );
        let mut with_kokoro = pocket.clone();
        with_kokoro.extend(entries(json!([{"model": "kokoro"}])));
        assert_eq!(
            light_cannot_read("Hola.", Some("es"), Some(&with_kokoro)),
            None
        );
        assert_eq!(
            light_cannot_read(
                "Ich habe den Build gestartet und er ist jetzt fertig.",
                None,
                Some(&pocket)
            )
            .as_deref(),
            Some("de")
        );
        assert_eq!(
            light_cannot_read("J'ai relancé le pipeline GitLab CI.", None, Some(&pocket)),
            None
        );
    }
}
