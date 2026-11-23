//! What the page and the server both need of voices that read replies
//! (shared/voiceLibrary.ts, held to contract/vectors/voice-library.json):
//! the languages, what to read aloud when recording, what a voice says when
//! heard, voice names and file names, and how a recording's transcript is
//! chosen.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::{is_js_space, len16, slice16, trim};
use unicode_normalization::UnicodeNormalization;

/// The languages a voice can be recorded in and assigned to: code, label.
pub const VOICE_LANGUAGES: [(&str, &str); 7] = [
    ("en", "English"),
    ("fr", "Français"),
    ("es", "Español"),
    ("it", "Italiano"),
    ("pt", "Português"),
    ("ja", "日本語"),
    ("zh", "中文"),
];

pub fn is_voice_language(value: &str) -> bool {
    VOICE_LANGUAGES.iter().any(|(code, _)| *code == value)
}

pub fn voice_language_label(code: &str) -> &str {
    VOICE_LANGUAGES
        .iter()
        .find(|(known, _)| *known == code)
        .map_or(code, |(_, label)| label)
}

/// What to read aloud for a new voice: two short sentences of easy words, 8
/// to 12 seconds read by a child, so the reading ends well before the
/// recording has to.
pub const READING_TEXTS: [(&str, [&str; 2]); 7] = [
    (
        "en",
        [
            "A little dragon lives in a big green tree. Every morning, he eats a red apple and sings a song.",
            "Today the sun is shining. My best friend is coming to play, and we will build a big castle.",
        ],
    ),
    (
        "fr",
        [
            "Un petit dragon vit dans un grand arbre. Le matin, il mange une pomme et chante une chanson.",
            "Aujourd'hui, il fait beau. Mon ami vient jouer, et nous allons faire un grand château.",
        ],
    ),
    (
        "es",
        [
            "Un pequeño dragón vive en un árbol grande. Cada mañana come una manzana y canta una canción.",
            "Hoy hace sol. Mi amigo viene a jugar, y vamos a hacer un castillo enorme.",
        ],
    ),
    (
        "it",
        [
            "Un piccolo drago vive in un grande albero. Ogni mattina mangia una mela e canta una canzone.",
            "Oggi c'è il sole. Il mio amico viene a giocare, e facciamo un castello enorme.",
        ],
    ),
    (
        "pt",
        [
            "Um pequeno dragão mora numa árvore grande. Todas as manhãs ele come uma maçã e canta uma canção.",
            "Hoje está sol. O meu amigo vem brincar, e vamos fazer um castelo enorme.",
        ],
    ),
    (
        "ja",
        [
            "小さなドラゴンが大きな木に住んでいます。毎朝、りんごを食べて歌を歌います。",
            "今日はいい天気です。友だちと大きなお城を作ります。",
        ],
    ),
    (
        "zh",
        [
            "一条小龙住在大树上。每天早上，它吃一个苹果，唱一首歌。",
            "今天天气很好。我的朋友来玩，我们一起搭一个大城堡。",
        ],
    ),
];

/// What a voice says when heard before it is chosen.
pub const SAMPLE_SENTENCES: [(&str, &str); 7] = [
    (
        "en",
        "Hello! This is my voice. Shall we have an adventure together?",
    ),
    (
        "fr",
        "Bonjour ! Voici ma voix. On part à l'aventure ensemble ?",
    ),
    ("es", "¡Hola! Esta es mi voz. ¿Vamos juntos de aventura?"),
    (
        "it",
        "Ciao! Questa è la mia voce. Partiamo insieme per un'avventura?",
    ),
    (
        "pt",
        "Olá! Esta é a minha voz. Vamos viver uma aventura juntos?",
    ),
    ("ja", "こんにちは！これが私の声です。一緒に冒険しましょう！"),
    ("zh", "你好！这是我的声音。我们一起去冒险吧！"),
];

/// The shortest a recording may be, in seconds.
pub const MIN_RECORDING_SECONDS: f64 = 5.0;
/// The longest: the helper's limit, only a last resort.
pub const MAX_RECORDING_SECONDS: f64 = 30.0;
pub const MAX_VOICE_NAME_LENGTH: usize = 40;

/// Runs of JavaScript's `\s` as one space.
fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A voice's name as given, or None when it cannot be one.
pub fn clean_voice_name(value: Option<&str>) -> Option<String> {
    let collapsed = collapse_spaces(value?);
    let name = trim(&collapsed);
    (!name.is_empty() && len16(name) <= MAX_VOICE_NAME_LENGTH).then(|| name.to_owned())
}

static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Mn}").expect("marks"));
static NOT_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").expect("not word"));
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}\p{M}]+").expect("word"));
// Chinese and Japanese go without spaces: each character is a word.
static CJK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Han}\p{Hiragana}\p{Katakana}]").expect("cjk"));

/// NFD without its combining marks, lower-cased.
fn plain(text: &str) -> String {
    let decomposed: String = text.nfd().collect();
    MARKS.replace_all(&decomposed, "").to_lowercase()
}

/// A file name for a voice named `name`: "Léa" is "lea", "Pirate !" "pirate".
pub fn voice_slug(name: &str) -> String {
    let lowered = plain(name);
    let dashed = NOT_WORD.replace_all(&lowered, "-");
    let cut = slice16(dashed.trim_matches('-'), 0, Some(40));
    let slug = cut.trim_end_matches('-');
    if slug.is_empty() {
        "voice".into()
    } else {
        slug.to_owned()
    }
}

/// `slug`, or with a number after it when `taken` has it.
pub fn unique_voice_id(slug: &str, mut taken: impl FnMut(&str) -> bool) -> String {
    if !taken(slug) {
        return slug.to_owned();
    }
    (2u64..)
        .map(|n| format!("{slug}-{n}"))
        .find(|id| !taken(id))
        .unwrap_or_default()
}

/// A word of a text, as compared, and the byte where it ends in the text.
struct WordSpan {
    word: String,
    end: usize,
}

fn word_spans(text: &str) -> Vec<WordSpan> {
    let mut spans = Vec::new();
    for found in WORD.find_iter(text) {
        let word = plain(found.as_str());
        if word.is_empty() {
            continue;
        }
        if CJK.is_match(&word) {
            let mut at = found.start();
            for c in found.as_str().chars() {
                at += c.len_utf8();
                spans.push(WordSpan {
                    word: c.to_string(),
                    end: at,
                });
            }
        } else {
            spans.push(WordSpan {
                word,
                end: found.end(),
            });
        }
    }
    spans
}

/// The words of `text`, to compare: no case, accents or punctuation.
pub fn transcript_words(text: &str) -> Vec<String> {
    word_spans(text).into_iter().map(|span| span.word).collect()
}

fn edit_distance(expected: &[String], got: &[String]) -> usize {
    let mut previous: Vec<usize> = (0..=got.len()).collect();
    for i in 1..=expected.len() {
        let mut row = vec![i];
        for j in 1..=got.len() {
            let cost = usize::from(expected[i - 1] != got[j - 1]);
            row.push(
                (previous[j] + 1)
                    .min(row[j - 1] + 1)
                    .min(previous[j - 1] + cost),
            );
        }
        previous = row;
    }
    previous[got.len()]
}

/// The share of `reference`'s words that `heard` gets wrong (WER).
pub fn word_error_rate(reference: &str, heard: &str) -> f64 {
    let expected = transcript_words(reference);
    let got = transcript_words(heard);
    if expected.is_empty() {
        return if got.is_empty() { 0.0 } else { 1.0 };
    }
    edit_distance(&expected, &got) as f64 / expected.len() as f64
}

/// Up to this share of words may differ between the text shown and what
/// was heard for the text to count as read.
pub const TRANSCRIPT_TOLERANCE: f64 = 0.15;
/// Heard this differently from the text, the user is offered to record again.
pub const RERECORD_RATE: f64 = 0.4;

/// Where a recording's transcript comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    /// The text shown, read whole.
    Shown,
    /// The start of the text shown, as far as it was read.
    Partial,
    /// What the recognizer heard, when it was not the text.
    Heard,
}

impl TranscriptKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shown => "shown",
            Self::Partial => "partial",
            Self::Heard => "heard",
        }
    }
}

/// Which words go with the recording, which Qwen3-TTS must have exactly to
/// clone it well. A recording cut while speech went on (`cut`) never gets
/// the whole text. Without a recognizer, the text shown.
pub fn choose_transcript(shown: &str, heard: &str, cut: bool) -> (String, TranscriptKind) {
    let said_spaced = collapse_spaces(heard);
    let said = trim(&said_spaced);
    let text_spaced = collapse_spaces(shown);
    let text = trim(&text_spaced);
    if said.is_empty() {
        return (text.to_owned(), TranscriptKind::Shown);
    }
    let spans = word_spans(text);
    let got = transcript_words(said);
    if spans.is_empty() || got.is_empty() {
        return (said.to_owned(), TranscriptKind::Heard);
    }
    let expected: Vec<String> = spans.iter().map(|span| span.word.clone()).collect();
    // How far into the text the reading went: the prefix it matches best,
    // the longest of those that match as well.
    let mut best = (0usize, usize::MAX);
    for length in 1..=expected.len() {
        let distance = edit_distance(&expected[..length], &got);
        if distance <= best.1 {
            best = (length, distance);
        }
    }
    let read = &expected[..best.0];
    let close = best.1 as f64 <= (read.len() as f64 * TRANSCRIPT_TOLERANCE).floor();
    // The reading's last word is the text's: it stopped there, not elsewhere.
    let ends_alike = got.last() == read.last();
    if close && ends_alike && best.0 == expected.len() && !cut {
        return (text.to_owned(), TranscriptKind::Shown);
    }
    if close && ends_alike {
        let partial = text[..spans[best.0 - 1].end]
            .trim_end_matches(|c: char| is_js_space(c) || matches!(c, ',' | ';' | ':'));
        return (partial.to_owned(), TranscriptKind::Partial);
    }
    (said.to_owned(), TranscriptKind::Heard)
}

/// Below this RMS, a moment of the microphone is silence.
pub const SPEECH_RMS: f64 = 0.015;
/// This long a silence after the reading ends it.
pub const END_PAUSE_SECONDS: f64 = 1.6;
/// Speech in the last this many seconds of a recording means it was cut.
pub const CUT_SECONDS: f64 = 0.5;
/// A child reads about this many words a second, or characters in CJK.
const WORDS_PER_SECOND: f64 = 1.8;
const CJK_CHARS_PER_SECOND: f64 = 3.0;

/// About how long reading `text` aloud takes a child, in seconds.
pub fn reading_seconds(text: &str) -> f64 {
    let words = transcript_words(text);
    let cjk = words.iter().any(|word| CJK.is_match(word));
    words.len() as f64
        / if cjk {
            CJK_CHARS_PER_SECOND
        } else {
            WORDS_PER_SECOND
        }
}

/// Follows a recording as it goes, in moments of its level, to say when it
/// is over: at a pause once most of the text has likely been read, or at
/// MAX_RECORDING_SECONDS as a last resort; and whether it ended mid-speech.
#[derive(Debug, Clone)]
pub struct ReadingEnd {
    seconds: f64,
    speech: f64,
    last_speech: f64,
    /// Speech this long means most of the text was read.
    enough: f64,
}

impl ReadingEnd {
    pub fn new(text: &str) -> Self {
        Self {
            seconds: 0.0,
            speech: 0.0,
            last_speech: f64::NEG_INFINITY,
            enough: (reading_seconds(text) * 0.6).max(2.0),
        }
    }

    /// `seconds` more of the recording at `rms`: "go on", "pause" or
    /// "limit".
    pub fn push(&mut self, rms: f64, seconds: f64) -> &'static str {
        self.seconds += seconds;
        if rms >= SPEECH_RMS {
            self.speech += seconds;
            self.last_speech = self.seconds;
        }
        if self.seconds >= MAX_RECORDING_SECONDS {
            return "limit";
        }
        if self.speech >= self.enough && self.seconds - self.last_speech >= END_PAUSE_SECONDS {
            return "pause";
        }
        "go on"
    }

    /// Whether the recording ends while speech goes on.
    pub fn cut(&self) -> bool {
        self.seconds - self.last_speech < CUT_SECONDS
    }
}

#[cfg(test)]
mod tests;
