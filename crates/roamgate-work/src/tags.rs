//! The tags a new item gets by itself when it is given none
//! (server/src/work/tags.ts): read from its words, deterministic and cheap.
//! A tag the project already uses is taken when the text names it; an area
//! of the app when the text names it, spelt as the project spells it.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::shared::{normalize_work_tag, normalize_work_tags};

/// At most this many tags are given by themselves.
pub const WORK_AUTO_TAGS: usize = 4;

/// Areas of the app and their words: the first word is the tag given when
/// the project spells it no other way.
pub const WORK_TAG_AREAS: &[&[&str]] = &[
    &[
        "phone",
        "mobile",
        "touch screen",
        "touchscreen",
        "smartphone",
    ],
    &["android", "apk"],
    &[
        "reviews",
        "review",
        "mr",
        "merge request",
        "pull request",
        "pr",
        "gitlab",
    ],
    &["voice", "tts", "stt", "speech", "microphone", "mic", "call"],
    &["chat", "conversation", "transcript"],
    &[
        "files",
        "files pane",
        "files view",
        "file tree",
        "file browser",
    ],
    &["changes", "changes view", "changes pane"],
    &[
        "work-board",
        "work board",
        "work view",
        "work item",
        "kanban",
    ],
    &["terminal", "xterm"],
    &[
        "notifications",
        "notification",
        "notify",
        "push notification",
    ],
    &["mac", "macos"],
];

/// Words of an area that name it only as part of a phrase or as the
/// project's own tag.
const WEAK_WORDS: &[&str] = &["changes", "files", "call", "pr", "mic", "push"];

static IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").expect("image"));
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://\S+").expect("url"));
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").expect("word"));

/// The words of a text: lower case, letters and digits, in order.
pub fn work_words(text: &str) -> Vec<String> {
    let text = IMAGE.replace_all(text, " ");
    let text = URL.replace_all(&text, " ");
    let text = text.to_lowercase();
    WORD.find_iter(&text)
        .map(|found| found.as_str().to_owned())
        .collect()
}

fn singular(word: &str) -> String {
    if word.chars().count() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        word[..word.len() - 1].to_owned()
    } else {
        word.to_owned()
    }
}

/// Where a phrase (words, dash or space separated) first stands, or None.
fn phrase_at(words: &[String], phrase: &str) -> Option<usize> {
    let parts: Vec<String> = work_words(&phrase.replace('-', " "))
        .iter()
        .map(|word| singular(word))
        .collect();
    if parts.is_empty() {
        return None;
    }
    (0..words.len().saturating_sub(parts.len() - 1)).find(|&at| {
        at + parts.len() <= words.len()
            && parts
                .iter()
                .enumerate()
                .all(|(index, part)| &singular(&words[at + index]) == part)
    })
}

/// The tags a text calls for, in the order the text names them, at most
/// WORK_AUTO_TAGS: `vocabulary` is the project's tags (its list and its
/// items', most used first).
pub fn auto_work_tags<S: AsRef<str>>(text: &str, vocabulary: &[S]) -> Vec<String> {
    let words = work_words(text);
    if words.is_empty() {
        return Vec::new();
    }
    let limited: Vec<&str> = vocabulary.iter().take(500).map(AsRef::as_ref).collect();
    let known = normalize_work_tags(&limited);
    let mut found: Vec<(String, usize)> = Vec::new();
    let mut take = |tag: &str, at: Option<usize>| {
        let Some(at) = at else { return };
        match found.iter_mut().find(|(each, _)| each == tag) {
            Some(entry) if at < entry.1 => entry.1 = at,
            Some(_) => {}
            None => found.push((tag.to_owned(), at)),
        }
    };
    let mut grouped: HashMap<String, ()> = HashMap::new();
    for group in WORK_TAG_AREAS {
        let terms: Vec<String> = group.iter().map(|term| normalize_work_tag(term)).collect();
        let tag = known
            .iter()
            .find(|each| terms.contains(each))
            .cloned()
            .unwrap_or_else(|| terms[0].clone());
        for term in &terms {
            grouped.insert(term.clone(), ());
        }
        let mut at: Option<usize> = None;
        for term in group.iter() {
            let strong = !WEAK_WORDS.contains(term) || known.contains(&normalize_work_tag(term));
            if !strong {
                continue;
            }
            if let Some(here) = phrase_at(&words, term)
                && at.is_none_or(|at| here < at)
            {
                at = Some(here);
            }
        }
        take(&tag, at);
    }
    // The project's other tags, named by their words.
    for tag in &known {
        if grouped.contains_key(tag) || tag.chars().count() < 2 {
            continue;
        }
        take(tag, phrase_at(&words, tag));
    }
    // A stable sort by position keeps insertion order on ties, as JS's.
    found.sort_by_key(|(_, at)| *at);
    found
        .into_iter()
        .map(|(tag, _)| tag)
        .take(WORK_AUTO_TAGS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: &[&str] = &[];

    #[test]
    fn the_project_s_own_tags_named_by_their_words_in_the_order_the_text_names_them() {
        let vocabulary = ["rfc-0052", "caps", "work-board", "p6", "docs"];
        assert_eq!(
            auto_work_tags(
                "RFC-0052 says the caps negotiation should move to p6; see the docs",
                &vocabulary
            ),
            ["rfc-0052", "caps", "p6", "docs"]
        );
        // A plural names the tag too; a word inside another word does not.
        assert_eq!(
            auto_work_tags("Fix the doc of the capsule", &vocabulary),
            ["docs"]
        );
        assert!(auto_work_tags("Nothing to see here", &vocabulary).is_empty());
    }

    #[test]
    fn areas_of_the_app_by_their_words_and_synonyms_spelt_as_the_project_spells_them() {
        // No such tag in the project yet: the area's own word.
        assert_eq!(
            auto_work_tags("The header scrolls away on mobile", NONE),
            ["phone"]
        );
        // The project says mobile: mobile, whichever word the text uses.
        assert_eq!(
            auto_work_tags("On my phone the header scrolls away", &["mobile"]),
            ["mobile"]
        );
        assert_eq!(
            auto_work_tags("The MR's discussions stay pinned", NONE),
            ["reviews"]
        );
        assert_eq!(
            auto_work_tags("A merge request thread", &["review", "voice"]),
            ["review"]
        );
        assert_eq!(auto_work_tags("TTS starts late in a call", NONE), ["voice"]);
        assert_eq!(auto_work_tags("Hide the files pane", NONE), ["files"]);
        assert_eq!(
            auto_work_tags("A free-text item on the work board", NONE),
            ["work-board"]
        );
    }

    #[test]
    fn common_words_name_an_area_only_as_a_phrase_or_as_the_project_s_own_tag() {
        assert!(auto_work_tags("Keep my changes and the files I made", NONE).is_empty());
        assert_eq!(
            auto_work_tags("The changes view folds a chunk", NONE),
            ["changes"]
        );
        assert_eq!(auto_work_tags("Keep my changes", &["changes"]), ["changes"]);
        assert!(auto_work_tags("Call me back", NONE).is_empty());
    }

    #[test]
    fn at_most_a_few_tags_images_and_links_are_not_words() {
        assert_eq!(
            auto_work_tags("phone android review voice chat terminal", NONE).len(),
            WORK_AUTO_TAGS
        );
        assert_eq!(
            work_words("See ![voice](</images/voice.png>) at https://x.org/phone ok"),
            ["see", "at", "ok"]
        );
        assert!(
            auto_work_tags(
                "See ![voice](</images/voice.png>) https://x.org/phone",
                NONE
            )
            .is_empty()
        );
    }
}
